// Claude Code deriver: turns one session's native JSONL transcript into a
// facts object (`jobs: []`, filled in later by M3-4) plus in-memory binding
// events for M3-4 to match against Desk tool calls, file writes and commits.
//
// Nothing here ever copies transcript text, prompt text, tool input or tool
// output into the returned `facts`: every fact is a count, a duration, an
// enum bucket (`toolKind`) or a pattern-shaped id, and every such value is
// checked against its schema pattern (or the shared enums) before it is
// used — a value that fails is dropped, with a matching `unavailable` entry
// where one exists, rather than ever producing facts that fail
// `validateFacts`. The richer per-call detail (Desk tool track/slug, file
// paths, commit SHAs) only ever reaches `events`, which is kept in memory by
// the caller and never written to disk.
//
// True single pass, small state: each transcript (root or subagent) is read
// once via `readline` and each parsed line is handed to a per-agent
// processor that folds it into a handful of small Maps/scalars, then lets it
// go — nothing keeps the full parsed-line array, a raw tool-output string or
// a prompt around after the line that carried it has been processed. A
// session's total memory footprint tracks the number of turns/tool
// calls/messages, never the size of its transcript.
//
// Every line shape is treated as untrusted: an unexpected `content` type, a
// missing `message`, a non-GitHub PR URL, a subagent with no readable
// `.meta.json` are all skipped or defaulted rather than thrown — one odd
// line must never cost the whole session's facts. Unrecognized line types
// (`attachment`, `last-prompt`, `queue-operation`, `custom-title`,
// `agent-setting`, `cost-state`, and anything else this file doesn't name)
// are silently skipped.
//
// Semantic choices recorded here for M3-3 (the Copilot deriver) to match:
//   - `tool_failures` counts every outcome other than `ok` (not just `error`).
//   - An `Agent`/`Task` call counts in `counts.tool_calls.agent` (and
//     `tool_failures.agent` if it didn't end `ok`) the same as any other
//     tool call; its *interval* is always `kind: "subagent"`, never
//     `kind: "tool"`. (`SendMessage` is also in the `agent` bucket, but it
//     resumes an existing subagent rather than spawning one, so it stays a
//     `tool` interval.)
//   - A retry is a later call of the same kind that starts after a failed
//     (non-`ok`) same-kind call ended — not necessarily the very next call
//     issued. It is decided when the later call starts, against the most
//     recent same-kind call finished by then, and each failure is retried
//     at most once (two parallel calls after one failure count one retry).
//   - A tool_use with no paired tool_result, or whose use or result line
//     has no readable timestamp, produces no interval and no count. If any
//     such call exists anywhere in the session, `unavailable` gains
//     `{tool_durations, session_open}` when `endReason` is `null`, else
//     `{tool_durations, log_truncated}`.
//   - `human_wait` is emitted for agent 0 only: a subagent's next prompt
//     (a `SendMessage` resume) waits on the parent, not on a human.
//   - `started_at`/`derived_through` are the earliest/latest valid root
//     timestamps (the first/last line in a well-ordered transcript). An
//     interval whose end is before its start (clock skew between lines) is
//     dropped with `{<field>, source_unreadable}`. Every capped array is
//     trimmed to its schema limit rather than failing validation: over-cap
//     intervals, models or agents add `{<field>, log_truncated}`; over-cap
//     PR refs (no `unavailable` field exists for them) and invalid plugin
//     entries (`{plugins, source_unreadable}`) are dropped.
//   - A transcript whose file name is not a session UUID, or with no root
//     line carrying both a valid timestamp and a valid `version`, yields
//     `{ facts: null, events: null, reason: "source_unreadable" }`.
//   - `session.id` is the transcript's file name, which is what hooks and
//     the session marker identify; lines copied into a resumed session can
//     carry an older `sessionId`.
//   - `events.fileWrites` holds `Write`/`Edit`/`MultiEdit` `file_path` and
//     `NotebookEdit` `notebook_path` only when the paired result was `ok`,
//     plus every `file-history-delta.trackingPath`.
//   - `events.shellGitCommits` holds `{ start, end, cwd }` for each
//     successful `Bash` call whose command runs `git … commit`
//     (`./shell-git.js`), from the `tool_use` time to its paired
//     `tool_result` time. Successful means the result is `ok` (not
//     `is_error`, interrupted or timed out) and does not start with a
//     non-zero `Exit code`; a failed or no-op commit ("nothing to commit"
//     exits 1) gives no event. `cwd` is the line's `cwd`, moved by a `-C` or
//     an earlier `cd` in the same command, or `null` when unknown. The
//     command and the result text are matched in memory and never kept: only
//     the directory is. A call with no readable time or no paired result
//     gives no event. M3-4 matches the desk's own commit reflog entries to
//     these by time, because `git commit -q` prints no hash.
//   - `events.nativeCommitShas` is always `[]`: Claude Code records no
//     commit refs of its own. `events.commitShas` (40-hex tokens in Bash
//     output) is kept for reference only; binding never uses it, since a
//     `git log` would put other sessions' commits there.
//   - `contributor` is the caller's own value, not transcript content; an
//     invalid one is a caller bug and throws a TypeError.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createReadStream, existsSync } from "node:fs"
import { readdir, readFile } from "node:fs/promises"
import * as os from "node:os"
import { createInterface } from "node:readline"
import * as path from "node:path"

import { toolKind } from "./tool-kinds.js"
import { ENUMS, LIMITS, PATTERNS } from "./schema.js"
import { gitCommitCwds } from "./shell-git.js"
import { normalizeTimestamp } from "./time.js"

const HOST = "claude-code"
const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
const SUBAGENT_SPAWN_TOOLS = new Set(["Agent", "Task"])
const DESK_CALL_PATTERN = /^mcp__.*desk.*__(task_create|task_update|task_archive)$/u
const COMMIT_SHA_PATTERN = /\b[0-9a-f]{40}\b/gu
const PR_URL_PATTERN = /github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/pull\/\d+/u
const SYNTHETIC_MODEL = "<synthetic>"

// ---------------------------------------------------------------------------
// Small, defensive helpers. None of these ever throw on an unexpected shape.
// ---------------------------------------------------------------------------

function safeNonNegNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0
}

function repoFromPrUrl(url) {
  // `RegExp.exec` coerces a non-string argument via `ToString` rather than
  // throwing, so a missing or malformed `url` safely yields no match.
  const match = PR_URL_PATTERN.exec(url)
  return match ? match[1] : null
}

function isValidPrRef(repo, number) {
  return typeof repo === "string" && PATTERNS.prRepo.test(repo) && Number.isInteger(number) && number > 0
}

function isValidModelId(model) {
  return typeof model === "string" && model !== SYNTHETIC_MODEL && PATTERNS.modelId.test(model)
}

function computeOutcome(resultBlock, toolUseResult) {
  if (toolUseResult?.interrupted) return "interrupted"
  if (toolUseResult?.timedOutAfterMs != null) return "timeout"
  if (resultBlock.is_error) return "error"
  return "ok"
}

// A Bash result whose text starts `Exit code <n>` with n > 0. The text is
// read here and dropped.
function exitedNonZero(resultBlock) {
  const content = resultBlock.content
  let text = typeof content === "string" ? content : ""
  if (Array.isArray(content)) text = content.find((block) => block?.type === "text")?.text ?? ""
  const match = /^Exit code (\d+)/u.exec(typeof text === "string" ? text : "")
  return match !== null && Number(match[1]) !== 0
}

function mapEntrypoint(raw) {
  if (raw === "claude-desktop") return "desktop"
  if (raw === "cli") return "cli"
  if (typeof raw === "string" && raw.startsWith("sdk")) return "sdk"
  return "unknown"
}

// A user line's `content` may be a string, an array of blocks, or (on a
// malformed line) anything else. Real Claude Code content arrays are mostly
// `tool_result` blocks, with a minority of `text` or `image`+`text` blocks.
function classifyUserContent(content) {
  if (typeof content === "string") return { hasTextOrImage: true, isAllToolResult: false }
  if (!Array.isArray(content) || content.length === 0) return { hasTextOrImage: false, isAllToolResult: false }
  let hasTextOrImage = false
  let isAllToolResult = true
  for (const block of content) {
    const type = block?.type
    if (type === "text" || type === "image") hasTextOrImage = true
    if (type !== "tool_result") isAllToolResult = false
  }
  return { hasTextOrImage, isAllToolResult }
}

function toolResultBlocksOf(line) {
  const content = line.message?.content
  return Array.isArray(content) ? content.filter((block) => block?.type === "tool_result") : []
}

function isToolResultLine(line) {
  return line.type === "user" && toolResultBlocksOf(line).length > 0
}

// A user line is a human prompt when: it isn't a hook/system/meta/compact
// injection; its `origin.kind`, if present, is "human"; it carries real
// content (text, image, or string); and it isn't made up only of tool
// results. Only ever called on a line already known to be `type: "user"`
// (from `handleUserLine`).
function isHumanPromptLine(line) {
  if (line.isMeta || line.isCompactSummary) return false
  if (line.promptSource === "system") return false
  const originKind = line.origin?.kind
  if (originKind !== undefined && originKind !== "human") return false
  const { hasTextOrImage, isAllToolResult } = classifyUserContent(line.message?.content)
  return hasTextOrImage && !isAllToolResult
}

// ---------------------------------------------------------------------------
// Streaming. Blank/whitespace-only lines are skipped before parsing (never
// counted as a parse failure or as truncation); a line that fails
// `JSON.parse` is otherwise skipped and counted, and only a failure on the
// last non-blank line read is treated as truncation.
// ---------------------------------------------------------------------------

async function streamJsonlFile(filePath, onLine) {
  let parseFailures = 0
  let lastLineFailed = false
  const rl = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity })
  for await (const raw of rl) {
    if (raw.trim().length === 0) continue
    lastLineFailed = false
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      parseFailures += 1
      lastLineFailed = true
      continue
    }
    if (parsed !== null && typeof parsed === "object") onLine(parsed)
    // `parsed` (and `raw`) fall out of scope here; nothing retains them.
  }
  return { parseFailures, truncated: lastLineFailed }
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

async function readSubagentMeta(metaPath) {
  try {
    const meta = JSON.parse(await readFile(metaPath, "utf8"))
    return meta !== null && typeof meta === "object" ? meta : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Per-agent processor: folds one transcript's lines, one at a time, into
// small aggregate state. Used identically for the root transcript (agent 0)
// and every subagent transcript (agent 1, 2, ...).
// ---------------------------------------------------------------------------

function createAgentProcessor({ agentIndex }) {
  const usageById = new Map() // id -> { model, input, output, cache_read, cache_write }
  const modelCounts = new Map()
  const modelOrder = []
  const pendingCalls = new Map() // tool_use id -> { name, kind, start, isSubagentCall }
  const pendingDeskCalls = new Map()
  const pendingFileWrites = new Map()
  const pendingGitCommits = new Map() // tool_use id -> { start, cwds }
  const lastFinishedByKind = new Map() // kind -> { end, outcome, retried }
  const issuedIds = new Set()

  const intervals = []
  const toolCallCounts = new Map()
  const toolFailureCounts = new Map()
  const prRefs = []
  const fileWrites = []
  const commitShas = new Set()
  const deskToolCalls = []
  const shellGitCommits = []
  let toolRetries = 0
  let apiRetries = 0
  let compactions = 0
  let pendingApiRetryStarts = []
  let hadUnresolvedCall = false
  let invalidModelSeen = false

  let currentPromptStart = null
  let lastActivityTs = null

  let earliestTimestamp = null
  let latestTimestamp = null
  let hadUsableEnvelope = false
  let firstUsableVersion = null
  let firstEntrypointRaw

  function closePendingApiRetries(endTs) {
    if (pendingApiRetryStarts.length === 0) return
    if (endTs !== null) {
      for (const start of pendingApiRetryStarts) {
        intervals.push({ kind: "api_retry", agent: agentIndex, start, end: endTs })
      }
    }
    pendingApiRetryStarts = []
  }

  function finalizeToolResult(block, toolUseResult, ts) {
    const id = block.tool_use_id
    const pending = pendingCalls.get(id)
    if (!pending) return
    pendingCalls.delete(id)
    const deskCall = pendingDeskCalls.get(id)
    const fileWrite = pendingFileWrites.get(id)
    const gitCommit = pendingGitCommits.get(id)
    pendingDeskCalls.delete(id)
    pendingFileWrites.delete(id)
    pendingGitCommits.delete(id)
    if (ts === null) {
      // A result with no readable time: the call can't be measured, so it is
      // dropped like an unresolved one rather than given an invented end.
      hadUnresolvedCall = true
      return
    }
    const outcome = computeOutcome(block, toolUseResult)

    if (pending.isSubagentCall) {
      intervals.push({ kind: "subagent", agent: agentIndex, start: pending.start, end: ts })
    } else {
      intervals.push({ kind: "tool", agent: agentIndex, tool: pending.kind, outcome, start: pending.start, end: ts })
    }
    toolCallCounts.set(pending.kind, (toolCallCounts.get(pending.kind) ?? 0) + 1)
    if (outcome !== "ok") toolFailureCounts.set(pending.kind, (toolFailureCounts.get(pending.kind) ?? 0) + 1)
    lastFinishedByKind.set(pending.kind, { end: ts, outcome, retried: false })

    const gitPr = toolUseResult?.gitOperation?.pr
    if (gitPr) {
      const repo = repoFromPrUrl(gitPr.url)
      if (repo !== null && isValidPrRef(repo, gitPr.number)) prRefs.push({ repo, number: gitPr.number })
    }

    if (pending.name === "Bash") {
      const text = `${toolUseResult?.stdout ?? ""}\n${toolUseResult?.stderr ?? ""}`
      for (const match of text.matchAll(COMMIT_SHA_PATTERN)) commitShas.add(match[0])
    }

    if (deskCall) deskToolCalls.push({ ...deskCall, ok: outcome === "ok" })
    if (fileWrite && outcome === "ok") fileWrites.push(fileWrite)
    if (gitCommit && outcome === "ok" && !exitedNonZero(block)) {
      for (const cwd of gitCommit.cwds) shellGitCommits.push({ start: gitCommit.start, end: ts, cwd })
    }
  }

  function handleAssistantLine(line, ts) {
    // An assistant line is activity in its own right — a turn's end is "the
    // last assistant OR tool-result line before the next human prompt", not
    // only the tool-result side (a plain text reply with no tool call must
    // still extend the turn).
    if (ts !== null) lastActivityTs = ts

    const message = line.message
    if (!message) return

    if (line.isApiErrorMessage) {
      closePendingApiRetries(ts)
      const status = line.apiErrorStatus
      if (status === 429 || (typeof status === "number" && status >= 500)) {
        apiRetries += 1
        if (ts !== null) pendingApiRetryStarts.push(ts)
      }
    } else {
      closePendingApiRetries(ts)
    }

    const id = message.id
    const model = message.model
    if (id !== undefined && !line.isApiErrorMessage && model !== SYNTHETIC_MODEL) {
      const usage = message.usage ?? {}
      const fields = {
        input: safeNonNegNumber(usage.input_tokens),
        output: safeNonNegNumber(usage.output_tokens),
        cache_read: safeNonNegNumber(usage.cache_read_input_tokens),
        cache_write: safeNonNegNumber(usage.cache_creation_input_tokens),
      }
      if (!usageById.has(id)) {
        if (isValidModelId(model)) {
          usageById.set(id, { model, ...fields })
          if (!modelCounts.has(model)) modelOrder.push(model)
          modelCounts.set(model, (modelCounts.get(model) ?? 0) + 1)
        } else {
          invalidModelSeen = true
        }
      } else {
        const existing = usageById.get(id)
        existing.input = Math.max(existing.input, fields.input)
        existing.output = Math.max(existing.output, fields.output)
        existing.cache_read = Math.max(existing.cache_read, fields.cache_read)
        existing.cache_write = Math.max(existing.cache_write, fields.cache_write)
      }
    }

    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (!block || block.type !== "tool_use" || typeof block.id !== "string") continue
      const name = block.name
      // Recorded even without a readable time, so a subagent spawned here
      // still finds its parent.
      issuedIds.add(block.id)
      if (ts === null) {
        // A call with no readable start can't be measured: dropped like an
        // unresolved one rather than given an invented start.
        hadUnresolvedCall = true
        continue
      }
      const kind = toolKind({ host: HOST, name })
      const isSubagentCall = SUBAGENT_SPAWN_TOOLS.has(name)
      pendingCalls.set(block.id, { name, kind, start: ts, isSubagentCall })
      const previous = lastFinishedByKind.get(kind)
      if (previous && previous.outcome !== "ok" && !previous.retried && ts > previous.end) {
        toolRetries += 1
        previous.retried = true
      }
      const input = block.input ?? {}
      if (FILE_WRITE_TOOLS.has(name)) {
        const filePath = name === "NotebookEdit" ? input.notebook_path : input.file_path
        if (typeof filePath === "string") pendingFileWrites.set(block.id, { at: ts, path: filePath })
      }
      if (name === "Bash" && typeof input.command === "string") {
        // The command is matched here and dropped; only directories are kept.
        const cwds = gitCommitCwds({ command: input.command, cwd: line.cwd, home: os.homedir() })
        if (cwds.length > 0) pendingGitCommits.set(block.id, { start: ts, cwds })
      }
      if (typeof name === "string" && DESK_CALL_PATTERN.test(name)) {
        pendingDeskCalls.set(block.id, {
          at: ts,
          name,
          track: input.track,
          slug: input.slug,
          person: input.person ?? null,
          status: input.status ?? null,
        })
      }
    }
  }

  function handleUserLine(line, ts) {
    for (const block of toolResultBlocksOf(line)) {
      if (typeof block.tool_use_id === "string") finalizeToolResult(block, line.toolUseResult, ts)
    }

    if (ts === null) return
    if (isHumanPromptLine(line)) {
      if (currentPromptStart !== null) {
        const end = lastActivityTs ?? currentPromptStart
        intervals.push({ kind: "turn", agent: agentIndex, start: currentPromptStart, end })
        if (agentIndex === 0) intervals.push({ kind: "human_wait", agent: agentIndex, start: end, end: ts })
      }
      currentPromptStart = ts
      lastActivityTs = null
    } else if (isToolResultLine(line)) {
      lastActivityTs = ts
    }
  }

  return {
    pushLine(line) {
      const ts = normalizeTimestamp(line.timestamp)
      if (ts !== null) {
        // Normalized timestamps share one fixed-width UTC shape, so string
        // order is time order.
        if (earliestTimestamp === null || ts < earliestTimestamp) earliestTimestamp = ts
        if (latestTimestamp === null || ts > latestTimestamp) latestTimestamp = ts
        if (!hadUsableEnvelope && typeof line.version === "string" && PATTERNS.semver.test(line.version)) {
          hadUsableEnvelope = true
          firstUsableVersion = line.version
        }
      }
      if (firstEntrypointRaw === undefined && line.entrypoint !== undefined) firstEntrypointRaw = line.entrypoint

      if (line.type === "assistant") {
        handleAssistantLine(line, ts)
      } else if (line.type === "system" && line.subtype === "compact_boundary") {
        compactions += 1
      } else if (line.type === "pr-link") {
        if (isValidPrRef(line.prRepository, line.prNumber)) prRefs.push({ repo: line.prRepository, number: line.prNumber })
      } else if (line.type === "file-history-delta") {
        if (ts !== null && typeof line.trackingPath === "string") fileWrites.push({ at: ts, path: line.trackingPath })
      } else if (line.type === "user") {
        handleUserLine(line, ts)
      }
      // Any other type (attachment, last-prompt, queue-operation,
      // custom-title, agent-setting, cost-state, ...) is silently skipped.
    },
    finish() {
      if (pendingCalls.size > 0) hadUnresolvedCall = true
      if (currentPromptStart !== null) {
        const end = lastActivityTs ?? currentPromptStart
        intervals.push({ kind: "turn", agent: agentIndex, start: currentPromptStart, end })
      }
      const rootModel = modelOrder.length === 0
        ? "unknown"
        : modelOrder.reduce((best, candidate) => (modelCounts.get(candidate) > modelCounts.get(best) ? candidate : best), modelOrder[0])
      return {
        usageById,
        rootModel,
        intervals,
        toolCallCounts,
        toolFailureCounts,
        toolRetries,
        apiRetries,
        compactions,
        prRefs,
        fileWrites,
        commitShas,
        deskToolCalls,
        shellGitCommits,
        issuedIds,
        hadUnresolvedCall,
        invalidModelSeen,
        earliestTimestamp,
        latestTimestamp,
        hadUsableEnvelope,
        firstUsableVersion,
        entrypoint: mapEntrypoint(firstEntrypointRaw),
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Session-wide aggregation.
// ---------------------------------------------------------------------------

function aggregateModels(usageById) {
  const byModel = new Map()
  for (const { model, input, output, cache_read: cacheRead, cache_write: cacheWrite } of usageById.values()) {
    if (!byModel.has(model)) byModel.set(model, { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0 })
    const entry = byModel.get(model)
    entry.requests += 1
    entry.input += input
    entry.output += output
    entry.cache_read += cacheRead
    entry.cache_write += cacheWrite
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

function compareByStart(a, b) {
  if (a.start < b.start) return -1
  if (a.start > b.start) return 1
  return 0
}

function mergeCounts(target, source) {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}

function countsToObject(map) {
  return Object.fromEntries(map)
}

// The `unavailable` field an interval kind's data belongs to.
const INTERVAL_FIELD = Object.freeze({
  turn: "turns",
  human_wait: "human_waits",
  tool: "tool_durations",
  subagent: "tool_durations",
  api_retry: "api_retries",
})

function addUnavailable(unavailable, field, reason) {
  if (!unavailable.some((entry) => entry.field === field && entry.reason === reason)) {
    unavailable.push({ field, reason })
  }
}

// Keeps only caller-supplied plugin entries that already match the schema.
function sanitizePlugins(plugins, limits, unavailable) {
  const list = Array.isArray(plugins) ? plugins : []
  const valid = list.filter((entry) => typeof entry?.name === "string" && PATTERNS.pluginName.test(entry.name)
    && typeof entry.version === "string" && PATTERNS.semver.test(entry.version))
  const kept = valid.slice(0, limits.plugins).map(({ name, version }) => ({ name, version }))
  if (!Array.isArray(plugins) || kept.length !== list.length) addUnavailable(unavailable, "plugins", "source_unreadable")
  return kept
}

// Trims every derived array to what `validateFacts` accepts: drops
// intervals whose end precedes their start, agents past the `n` range (with
// their intervals), and anything past a schema cap, recording each loss in
// `unavailable`. Pure, so tests can drive it with small limits.
function applyLimits({ agents, intervals, models, prs }, unavailable, limits = LIMITS) {
  let keptAgents = agents
  let keptIntervals = intervals
  if (agents.length > limits.agents) {
    keptAgents = agents.slice(0, limits.agents)
    const keptNs = new Set(keptAgents.map((agent) => agent.n))
    keptIntervals = keptIntervals.filter((interval) => keptNs.has(interval.agent))
    addUnavailable(unavailable, "turns", "log_truncated")
    addUnavailable(unavailable, "tool_durations", "log_truncated")
  }

  const ordered = []
  for (const interval of keptIntervals) {
    if (interval.end < interval.start) addUnavailable(unavailable, INTERVAL_FIELD[interval.kind], "source_unreadable")
    else ordered.push(interval)
  }
  keptIntervals = ordered.sort(compareByStart)
  if (keptIntervals.length > limits.intervals) {
    for (const interval of keptIntervals.slice(limits.intervals)) {
      addUnavailable(unavailable, INTERVAL_FIELD[interval.kind], "log_truncated")
    }
    keptIntervals = keptIntervals.slice(0, limits.intervals)
  }

  let keptModels = models
  if (models.length > limits.models) {
    // Keep the most-used models; `models` arrives sorted by id, so ties keep id order.
    const top = new Set([...models].sort((a, b) => b.requests - a.requests).slice(0, limits.models))
    keptModels = models.filter((model) => top.has(model))
    addUnavailable(unavailable, "models", "log_truncated")
  }

  return { agents: keptAgents, intervals: keptIntervals, models: keptModels, prs: prs.slice(0, limits.prs) }
}

// Exposed only for direct unit tests: the two sort comparators (a real
// session's own ordering can't reliably force a sort comparator through
// every comparison direction) and `applyLimits`, whose caps are far too
// large to reach from a fixture.
export const __internals__ = { compareByStart, comparePrRefs, applyLimits }

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

export async function deriveClaudeSession({ transcriptPath, contributor, plugins, endReason }) {
  if (typeof contributor !== "string" || !PATTERNS.contributor.test(contributor)) {
    throw new TypeError("deriveClaudeSession: contributor must be 16 lowercase hex characters")
  }
  if (!existsSync(transcriptPath)) {
    return { facts: null, events: null, reason: "log_missing" }
  }

  const sessionId = path.basename(transcriptPath, ".jsonl")
  if (!PATTERNS.sessionId.test(sessionId)) {
    return { facts: null, events: null, reason: "source_unreadable" }
  }

  const safeEndReason = endReason === null || ENUMS.endReason.includes(endReason) ? endReason : null

  const rootProcessor = createAgentProcessor({ agentIndex: 0 })
  const rootRead = await streamJsonlFile(transcriptPath, (line) => rootProcessor.pushLine(line))
  const rootResult = rootProcessor.finish()

  if (!rootResult.hadUsableEnvelope) {
    return { facts: null, events: null, reason: "source_unreadable" }
  }

  const agentResults = [rootResult]
  const agents = [{ n: 0, parent: null, model: rootResult.rootModel }]
  const spawnIds = [null]

  let truncatedAny = rootRead.truncated
  let totalParseFailures = rootRead.parseFailures
  let hadUnresolvedAny = rootResult.hadUnresolvedCall
  let invalidModelSeen = rootResult.invalidModelSeen

  const subagentFiles = await listSubagentFiles(transcriptPath)
  for (let index = 0; index < subagentFiles.length; index += 1) {
    const agentIndex = index + 1
    const { jsonlPath, metaPath } = subagentFiles[index]
    const meta = await readSubagentMeta(metaPath)
    const processor = createAgentProcessor({ agentIndex })
    const read = await streamJsonlFile(jsonlPath, (line) => processor.pushLine(line))
    const result = processor.finish()

    truncatedAny = truncatedAny || read.truncated
    totalParseFailures += read.parseFailures
    hadUnresolvedAny = hadUnresolvedAny || result.hadUnresolvedCall
    invalidModelSeen = invalidModelSeen || result.invalidModelSeen

    let model = "unknown"
    if (meta !== null && isValidModelId(meta.model)) model = meta.model
    else invalidModelSeen = true

    agents.push({ n: agentIndex, parent: 0, model })
    agentResults.push(result)
    spawnIds.push(typeof meta?.toolUseId === "string" ? meta.toolUseId : null)
  }

  // Parents are resolved once every transcript has been read, so a nested
  // subagent's file may sort before or after its parent's.
  for (let index = 1; index < agents.length; index += 1) {
    const owner = spawnIds[index] === null ? -1 : agentResults.findIndex((result) => result.issuedIds.has(spawnIds[index]))
    if (owner !== -1) agents[index].parent = owner
  }

  const mergedUsage = new Map()
  for (const result of agentResults) {
    for (const [id, entry] of result.usageById) mergedUsage.set(id, entry)
  }

  const toolCallCounts = new Map()
  const toolFailureCounts = new Map()
  let toolRetries = 0
  let apiRetries = 0
  let compactions = 0
  for (const result of agentResults) {
    mergeCounts(toolCallCounts, result.toolCallCounts)
    mergeCounts(toolFailureCounts, result.toolFailureCounts)
    toolRetries += result.toolRetries
    apiRetries += result.apiRetries
    compactions += result.compactions
  }

  const startedAt = rootResult.earliestTimestamp
  const derivedThrough = rootResult.latestTimestamp
  const endedAt = safeEndReason !== null ? derivedThrough : null

  const unavailable = []
  if (safeEndReason === null) addUnavailable(unavailable, "ended_at", "session_open")
  const models = aggregateModels(mergedUsage)
  if ((models.length === 0 && totalParseFailures > 0) || invalidModelSeen) {
    addUnavailable(unavailable, "models", "source_unreadable")
  }
  addUnavailable(unavailable, "permission_waits", "host_does_not_record")
  addUnavailable(unavailable, "ci_runs", "not_collected_in_slice_1")
  addUnavailable(unavailable, "commits", "host_does_not_record")
  if (truncatedAny) addUnavailable(unavailable, "turns", "log_truncated")
  if (hadUnresolvedAny) addUnavailable(unavailable, "tool_durations", safeEndReason === null ? "session_open" : "log_truncated")

  const safePlugins = sanitizePlugins(plugins, LIMITS, unavailable)
  const limited = applyLimits({
    agents,
    intervals: agentResults.flatMap((result) => result.intervals),
    models,
    prs: dedupePrRefs(agentResults.flatMap((result) => result.prRefs)),
  }, unavailable)

  const facts = {
    schema: "desk.factory.facts/1",
    contributor,
    session: {
      host: HOST,
      id: sessionId,
      host_version: rootResult.firstUsableVersion,
      entrypoint: rootResult.entrypoint,
      started_at: startedAt,
      ended_at: endedAt,
      end_reason: safeEndReason,
      derived_through: derivedThrough,
    },
    plugins: safePlugins,
    models: limited.models,
    agents: limited.agents,
    intervals: limited.intervals,
    counts: {
      tool_calls: countsToObject(toolCallCounts),
      tool_failures: countsToObject(toolFailureCounts),
      tool_retries: toolRetries,
      api_retries: apiRetries,
      compactions,
    },
    refs: { prs: limited.prs, commits: [] },
    jobs: [],
    unavailable,
  }

  const events = {
    deskToolCalls: agentResults.flatMap((result) => result.deskToolCalls),
    fileWrites: agentResults.flatMap((result) => result.fileWrites),
    commitShas: [...new Set(agentResults.flatMap((result) => [...result.commitShas]))],
    shellGitCommits: agentResults.flatMap((result) => result.shellGitCommits),
    nativeCommitShas: [],
  }

  return { facts, events }
}
