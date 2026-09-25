// Claude Code deriver: turns one session's native JSONL transcript into a
// facts object (`jobs: []`, filled in later by M3-4) plus in-memory binding
// events for M3-4 to match against Desk tool calls, file writes and commits.
//
// Nothing here ever copies transcript text, prompt text, tool input or tool
// output into the returned `facts`: every fact is a count, a duration, an
// enum bucket (`toolKind`) or a pattern-shaped id. The richer per-call detail
// (Desk tool track/slug, file paths, commit SHAs) only ever reaches `events`,
// which is kept in memory by the caller and never written to disk.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createReadStream, existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import * as path from "node:path"

import { toolKind } from "./tool-kinds.js"

const HOST = "claude-code"
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
const DESK_CALL_PATTERN = /^mcp__.*desk.*__(task_create|task_update|task_archive)$/u
const COMMIT_SHA_PATTERN = /\b[0-9a-f]{40}\b/gu
const PR_URL_PATTERN = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/pull\/\d+/u

// ---------------------------------------------------------------------------
// Line reading. Streamed line by line so the file is never held whole; a
// line that fails `JSON.parse` is skipped (and counted), and only a failure
// on the very last line read is treated as truncation — a mid-stream
// malformed line is simply noise, but a broken final line means the writer
// was cut off before finishing it.
// ---------------------------------------------------------------------------

async function readJsonlFile(filePath) {
  const lines = []
  let parseFailures = 0
  let lastLineFailed = false
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity })
  for await (const raw of rl) {
    lastLineFailed = false
    try {
      lines.push(JSON.parse(raw))
    } catch {
      parseFailures += 1
      lastLineFailed = true
    }
  }
  return { lines, parseFailures, truncated: lastLineFailed }
}

async function listSubagentFiles(transcriptPath) {
  const sessionDir = path.join(path.dirname(transcriptPath), path.basename(transcriptPath, ".jsonl"), "subagents")
  let entries
  try {
    entries = await readdir(sessionDir)
  } catch {
    return []
  }
  return entries
    .filter((name) => /^agent-.+\.jsonl$/u.test(name))
    .sort()
    .map((name) => ({
      jsonlPath: path.join(sessionDir, name),
      metaPath: path.join(sessionDir, name.replace(/\.jsonl$/u, ".meta.json")),
    }))
}

// ---------------------------------------------------------------------------
// Line classification.
// ---------------------------------------------------------------------------

function isToolResultLine(line) {
  return line.type === "user" && line.message.content.some((block) => block.type === "tool_result")
}

function isHumanPromptLine(line) {
  if (line.type !== "user") return false
  if (isToolResultLine(line)) return false
  return line.promptSource === undefined || line.promptSource === "user"
}

function computeOutcome(resultBlock, toolUseResult) {
  if (toolUseResult?.interrupted) return "interrupted"
  if (toolUseResult?.timedOutAfterMs !== undefined) return "timeout"
  if (resultBlock.is_error) return "error"
  return "ok"
}

function repoFromPrUrl(url) {
  const match = PR_URL_PATTERN.exec(url)
  return match[1]
}

// ---------------------------------------------------------------------------
// Per-agent line processing. Called once for the root transcript (agent 0)
// and once per subagent transcript (agent 1, 2, ...) — the same algorithm
// both ways, per the brief ("its tools and turns are derived the same way").
// ---------------------------------------------------------------------------

function deriveAgentLines(lines, { agentIndex, subagentToolUseIds }) {
  const assistantUsageById = new Map()
  const pendingCalls = new Map()
  const callOrder = []
  const finishedCalls = new Map()
  const pendingDeskCalls = new Map()

  const toolIntervals = []
  const apiRetryIntervals = []
  const prRefs = []
  const fileWrites = []
  const commitShas = []
  const deskToolCalls = []
  let apiRetries = 0
  let compactions = 0

  lines.forEach((line, index) => {
    if (line.type === "assistant") {
      if (!assistantUsageById.has(line.message.id)) {
        assistantUsageById.set(line.message.id, { model: line.message.model, usage: line.message.usage })
      }
      if (line.isApiErrorMessage && (line.apiErrorStatus === 429 || line.apiErrorStatus >= 500)) {
        const next = lines.slice(index + 1).find((candidate) => candidate.type === "assistant")
        if (next) {
          apiRetryIntervals.push({ kind: "api_retry", agent: agentIndex, start: line.timestamp, end: next.timestamp })
          apiRetries += 1
        }
      }
      for (const block of line.message.content) {
        if (block.type !== "tool_use") continue
        const kind = toolKind({ host: HOST, name: block.name })
        const isSubagentCall = subagentToolUseIds.has(block.id)
        pendingCalls.set(block.id, { name: block.name, kind, start: line.timestamp, isSubagentCall })
        callOrder.push(block.id)
        if (FILE_WRITE_TOOLS.has(block.name)) {
          fileWrites.push({ at: line.timestamp, path: block.input.file_path })
        }
        if (DESK_CALL_PATTERN.test(block.name)) {
          pendingDeskCalls.set(block.id, {
            at: line.timestamp,
            name: block.name,
            track: block.input.track,
            slug: block.input.slug,
            person: block.input.person ?? null,
            status: block.input.status ?? null,
          })
        }
      }
    } else if (line.type === "system" && line.subtype === "compact_boundary") {
      compactions += 1
    } else if (line.type === "pr-link") {
      prRefs.push({ repo: line.prRepository, number: line.prNumber })
    } else if (line.type === "file-history-delta") {
      fileWrites.push({ at: line.timestamp, path: line.trackingPath })
    } else if (isToolResultLine(line)) {
      const block = line.message.content.find((candidate) => candidate.type === "tool_result")
      const pending = pendingCalls.get(block.tool_use_id)
      if (!pending) return
      const outcome = computeOutcome(block, line.toolUseResult)
      finishedCalls.set(block.tool_use_id, { ...pending, outcome, end: line.timestamp })
      const gitPr = line.toolUseResult?.gitOperation?.pr
      if (gitPr) prRefs.push({ repo: repoFromPrUrl(gitPr.url), number: gitPr.number })
      if (pending.name === "Bash") {
        const text = `${line.toolUseResult?.stdout ?? ""}\n${line.toolUseResult?.stderr ?? ""}`
        for (const match of text.matchAll(COMMIT_SHA_PATTERN)) commitShas.push(match[0])
      }
      if (pendingDeskCalls.has(block.tool_use_id)) {
        deskToolCalls.push({ ...pendingDeskCalls.get(block.tool_use_id), ok: outcome === "ok" })
      }
    }
  })

  const toolCallCounts = new Map()
  const toolFailureCounts = new Map()
  let toolRetries = 0
  callOrder.forEach((id, index) => {
    const call = finishedCalls.get(id)
    if (!call) return
    if (call.isSubagentCall) {
      toolIntervals.push({ kind: "subagent", agent: agentIndex, start: call.start, end: call.end })
    } else {
      toolIntervals.push({ kind: "tool", agent: agentIndex, tool: call.kind, outcome: call.outcome, start: call.start, end: call.end })
      toolCallCounts.set(call.kind, (toolCallCounts.get(call.kind) ?? 0) + 1)
      if (call.outcome === "error") toolFailureCounts.set(call.kind, (toolFailureCounts.get(call.kind) ?? 0) + 1)
    }
    if (index > 0) {
      const previous = finishedCalls.get(callOrder[index - 1])
      if (previous && previous.kind === call.kind && previous.outcome === "error") toolRetries += 1
    }
  })

  const humanPrompts = []
  const activity = []
  lines.forEach((line, index) => {
    if (isHumanPromptLine(line)) humanPrompts.push({ ts: line.timestamp, index })
    else if (line.type === "assistant" || isToolResultLine(line)) activity.push({ ts: line.timestamp, index })
  })
  const turnIntervals = []
  const humanWaitIntervals = []
  humanPrompts.forEach((prompt, index) => {
    const nextPromptIndex = index + 1 < humanPrompts.length ? humanPrompts[index + 1].index : Infinity
    const inRange = activity.filter((entry) => entry.index > prompt.index && entry.index < nextPromptIndex)
    const end = inRange.length > 0 ? inRange[inRange.length - 1].ts : prompt.ts
    turnIntervals.push({ kind: "turn", agent: agentIndex, start: prompt.ts, end })
    if (index + 1 < humanPrompts.length) {
      humanWaitIntervals.push({ kind: "human_wait", agent: agentIndex, start: end, end: humanPrompts[index + 1].ts })
    }
  })

  return {
    assistantUsageById,
    toolCallCounts,
    toolFailureCounts,
    toolRetries,
    apiRetries,
    compactions,
    intervals: [...turnIntervals, ...humanWaitIntervals, ...toolIntervals, ...apiRetryIntervals],
    prRefs,
    fileWrites,
    commitShas,
    deskToolCalls,
  }
}

// ---------------------------------------------------------------------------
// Session-wide aggregation.
// ---------------------------------------------------------------------------

function pickRootModel(assistantUsageById, rootLines) {
  // Every assistant line in rootLines was already folded into
  // assistantUsageById by deriveAgentLines, so a lookup here always hits.
  const counts = new Map()
  const order = []
  for (const line of rootLines) {
    if (line.type !== "assistant") continue
    const model = assistantUsageById.get(line.message.id).model
    if (!counts.has(model)) order.push(model)
    counts.set(model, (counts.get(model) ?? 0) + 1)
  }
  if (order.length === 0) return "unknown"
  return order.reduce((best, candidate) => (counts.get(candidate) > counts.get(best) ? candidate : best), order[0])
}

function aggregateModels(usageById) {
  const byModel = new Map()
  for (const { model, usage } of usageById.values()) {
    if (!byModel.has(model)) byModel.set(model, { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 })
    const entry = byModel.get(model)
    entry.requests += 1
    entry.input += usage.input_tokens ?? 0
    entry.output += usage.output_tokens ?? 0
    entry.cache_read += usage.cache_read_input_tokens ?? 0
    entry.cache_write += usage.cache_creation_input_tokens ?? 0
  }
  return [...byModel.keys()].sort().map((id) => {
    const entry = byModel.get(id)
    return {
      id,
      requests: entry.requests,
      tokens: { input: entry.input, output: entry.output, cache_read: entry.cache_read, cache_write: entry.cache_write, reasoning: null },
    }
  })
}

function comparePrRefs(a, b) {
  if (a.repo === b.repo) return a.number - b.number
  return a.repo < b.repo ? -1 : 1
}

function dedupePrRefs(refs) {
  const seen = new Map()
  for (const ref of refs) seen.set(`${ref.repo}#${ref.number}`, ref)
  return [...seen.values()].sort(comparePrRefs)
}

function mapEntrypoint(raw) {
  if (raw === "claude-desktop") return "desktop"
  if (raw === "cli") return "cli"
  if (typeof raw === "string" && raw.startsWith("sdk")) return "sdk"
  return "unknown"
}

function mergeCounts(target, source) {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}

function countsToObject(map) {
  return Object.fromEntries(map)
}

function compareByStart(a, b) {
  if (a.start < b.start) return -1
  if (a.start > b.start) return 1
  return 0
}

// Exposed only for direct unit tests of the two sort comparators above: a
// real session's interval and PR-ref orderings can't reliably force a
// same-repo/cross-repo or an every-direction comparison through the array
// they naturally produce, so the tests drive these directly instead of
// relying on incidental fixture ordering.
export const __internals__ = { compareByStart, comparePrRefs }

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export async function deriveClaudeSession({ transcriptPath, contributor, plugins, endReason, now }) {
  if (!existsSync(transcriptPath)) {
    return { facts: null, events: null, reason: "log_missing" }
  }

  const sessionId = path.basename(transcriptPath, ".jsonl")
  const { lines: rootLines, parseFailures: rootParseFailures, truncated } = await readJsonlFile(transcriptPath)

  const subagentFiles = await listSubagentFiles(transcriptPath)
  const subagents = []
  for (const file of subagentFiles) {
    const meta = JSON.parse(await readFile(file.metaPath, "utf8"))
    const read = await readJsonlFile(file.jsonlPath)
    subagents.push({ meta, ...read })
  }

  const subagentToolUseIds = new Set(subagents.map((subagent) => subagent.meta.toolUseId))
  const rootResult = deriveAgentLines(rootLines, { agentIndex: 0, subagentToolUseIds })
  const subagentResults = subagents.map((subagent, index) =>
    deriveAgentLines(subagent.lines, { agentIndex: index + 1, subagentToolUseIds: new Set() }))
  const allResults = [rootResult, ...subagentResults]

  const mergedUsage = new Map()
  for (const result of allResults) {
    for (const [id, entry] of result.assistantUsageById) mergedUsage.set(id, entry)
  }
  const models = aggregateModels(mergedUsage)

  const agents = [
    { n: 0, parent: null, model: pickRootModel(rootResult.assistantUsageById, rootLines) },
    ...subagents.map((subagent, index) => ({ n: index + 1, parent: 0, model: subagent.meta.model })),
  ]

  const intervals = allResults.flatMap((result) => result.intervals).sort(compareByStart)

  const toolCallCounts = new Map()
  const toolFailureCounts = new Map()
  let toolRetries = 0
  let apiRetries = 0
  let compactions = 0
  for (const result of allResults) {
    mergeCounts(toolCallCounts, result.toolCallCounts)
    mergeCounts(toolFailureCounts, result.toolFailureCounts)
    toolRetries += result.toolRetries
    apiRetries += result.apiRetries
    compactions += result.compactions
  }

  const envelopeWithVersion = rootLines.find((line) => line.version !== undefined)
  const envelopeWithEntrypoint = rootLines.find((line) => line.entrypoint !== undefined)
  const hostVersion = envelopeWithVersion ? envelopeWithVersion.version : "0.0.0"
  const entrypoint = mapEntrypoint(envelopeWithEntrypoint ? envelopeWithEntrypoint.entrypoint : undefined)

  const timestamps = rootLines.map((line) => line.timestamp).filter((ts) => ts !== undefined)
  const startedAt = timestamps.length > 0 ? timestamps[0] : now
  const derivedThrough = timestamps.length > 0 ? timestamps[timestamps.length - 1] : now
  const endedAt = endReason !== null ? derivedThrough : null

  const unavailable = []
  if (endReason === null) unavailable.push({ field: "ended_at", reason: "session_open" })
  const totalParseFailures = rootParseFailures + subagents.reduce((sum, subagent) => sum + subagent.parseFailures, 0)
  if (models.length === 0 && totalParseFailures > 0) unavailable.push({ field: "models", reason: "source_unreadable" })
  unavailable.push({ field: "permission_waits", reason: "host_does_not_record" })
  unavailable.push({ field: "ci_runs", reason: "not_collected_in_slice_1" })
  unavailable.push({ field: "commits", reason: "host_does_not_record" })
  if (truncated) unavailable.push({ field: "turns", reason: "log_truncated" })

  const facts = {
    schema: "desk.factory.facts/1",
    contributor,
    session: {
      host: HOST,
      id: sessionId,
      host_version: hostVersion,
      entrypoint,
      started_at: startedAt,
      ended_at: endedAt,
      end_reason: endReason,
      derived_through: derivedThrough,
    },
    plugins,
    models,
    agents,
    intervals,
    counts: {
      tool_calls: countsToObject(toolCallCounts),
      tool_failures: countsToObject(toolFailureCounts),
      tool_retries: toolRetries,
      api_retries: apiRetries,
      compactions,
    },
    refs: { prs: dedupePrRefs(allResults.flatMap((result) => result.prRefs)), commits: [] },
    jobs: [],
    unavailable,
  }

  const events = {
    deskToolCalls: allResults.flatMap((result) => result.deskToolCalls),
    fileWrites: allResults.flatMap((result) => result.fileWrites),
    commitShas: [...new Set(allResults.flatMap((result) => result.commitShas))],
  }

  return { facts, events }
}
