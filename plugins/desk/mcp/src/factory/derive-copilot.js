// Copilot CLI deriver: turns one session's native `events.jsonl` (under
// `<copilotHome>/session-state/<sessionId>/`) plus that session's rows in the
// host's `session-store.db` into a facts object (`jobs: []`, filled in later
// by M3-4) and in-memory binding events for M3-4 to match against Desk tool
// calls, file writes and commits.
//
// What is read. Of each event only `type`, `timestamp` and these `data`
// fields: `session.start.copilotVersion`; `session.shutdown.modelMetrics`
// (never `codeChanges`); `assistant.turn_start/turn_end.turnId`;
// `tool.execution_start.{toolCallId, toolName, parentToolCallId}` and, for
// binding only, the Desk task fields (`track`, `slug`, `person`, `status`)
// and file-write paths of its `arguments`; `tool.execution_complete.
// {toolCallId, success, error.code, shellExecution.exitCode}`;
// `permission.requested/completed.{requestId, decisionSource}`;
// `subagent.started/completed/failed.{toolCallId, model}`;
// `session.error.statusCode`; `skill.invoked.{pluginName, pluginVersion}`.
// Content fields (message and prompt text, other tool arguments, results,
// `initialPrompt`, summaries, `codeChanges.filesModified`) are never read
// into facts. From the database: `assistant_usage_events` (through
// `readSessionRows`/`normalizeRow`) and `session_refs`, filtered by this
// session's id. Never `turns` (message text) or `session_files`.
//
// Every fact is a count, a duration, an enum bucket or a pattern-shaped id,
// and every copied value is checked against its schema pattern first. A value
// that fails is dropped with a matching `unavailable` entry, so the output
// always passes `validateFacts`. Track, slug and file paths reach only
// `events`, which the caller keeps in memory and never writes.
//
// True single pass, small state. The log is read once through `readline`
// and each parsed event is folded into small maps keyed by call, turn,
// request and subagent id, which are emptied as their pairs complete, then
// dropped. Memory tracks the number of calls in flight and of intervals
// (capped at the schema limit), never the size of the log.
//
// Rules, matching the Claude deriver's where they overlap (M3-2 rulings):
//   - `session.start` with a valid timestamp and `copilotVersion` is the
//     envelope. Without one: `{ facts: null, events: null, reason:
//     "source_unreadable" }`; a missing log is `reason: "log_missing"`.
//     `started_at`/`derived_through` are the earliest/latest valid
//     timestamps; `ended_at` is `derived_through` when `endReason` is set,
//     else `null` plus `{ended_at, session_open}`. Resumes stay one session.
//   - `entrypoint` is the caller's (`cli` or `launcher`, default `cli`) and
//     is never inferred: across real sessions `producer` is always
//     `copilot-agent` and `context.hostType` names the repository host
//     (`github`/`ado`), so nothing in the log identifies a launcher. The end
//     hook (M3-7) knows, because an Agency session copies plugins under
//     `~/.local/agency/plugins/sessions/`.
//   - Turns pair `assistant.turn_start`/`turn_end` by `turnId`, all on agent
//     0 (the log does not attribute turns to subagents). A turn left open
//     adds `{turns, session_open}` (open session) or `{turns, log_truncated}`.
//   - `human_wait` (agent 0 only) runs from a turn end to the next
//     `user.message` when no turn is open in between. `permission_wait` runs
//     from `permission.requested` to its `permission.completed` only when
//     `decisionSource` is `human_response`.
//   - Tools pair start/complete by `toolCallId`. Outcome: `denied` when
//     `error.code` is `denied`, `error` when `success` is false or a shell
//     exit code is non-zero (a failing command is an error, as in Claude),
//     else `ok`. `tool_failures` counts every non-ok outcome. A retry is a
//     later call of the same kind by the same agent that starts after a
//     failed call ended, each failure retried at most once. A start with no
//     completion produces no interval and adds `{tool_durations,
//     session_open}` (open) or `{tool_durations, log_truncated}`.
//   - A `task` call (or any call a subagent started from) counts in
//     `tool_calls.agent` but gets no `tool` interval: the subagent's own span,
//     `subagent.started` to `subagent.completed`/`failed`, is the `subagent`
//     interval, on the agent that spawned it. Each `subagent.started` gets
//     the next agent number, its parent is the agent whose call spawned it
//     (0 at top level), its model is `data.model` (`unknown` when absent or
//     invalid). Tools with a `parentToolCallId` belong to that subagent.
//   - Usage: the last `session.shutdown`'s `modelMetrics` when one exists
//     (its totals are session-wide and cumulative across resumes), otherwise
//     this session's database rows; the two are never added. Neither gives
//     `{tokens, session_open}`. The root agent's model is the model with the
//     most requests.
//   - API retries: each `model.turn_retry`/`assistant.turn_retry` counts one;
//     its `api_retry` interval starts at the first unclosed failure before it
//     (`model.model_call_failure`/`model.call_failure`, or `session.error`
//     with status 429 or 5xx) in the same turn.
//   - Compactions count each `session.compaction_complete`, with an interval
//     from its `compaction_start`.
//   - Plugins: the caller's marker list merged with valid `skill.invoked`
//     name/version pairs, deduplicated.
//   - Refs: `session_refs` `pr` rows (`owner/repo#n` or a github.com PR URL)
//     and `commit` rows (40 hex) for this session. The commit SHAs also go to
//     `events.commitShas` for M3-4. No database: `{commits, log_missing}`.
//   - Binding events: tool names ending `task_create|task_update|
//     task_archive` whose arguments carry string `track` and `slug`; file
//     writes are `create`/`edit` `arguments.path` and the `*** Add/Update/
//     Delete File:` headers of an `apply_patch` argument (parsed in memory),
//     kept only when the paired completion has `success: true`; `at` is the
//     start time.
//   - Capped arrays are trimmed to their schema limits with a
//     `log_truncated` entry; an interval whose end precedes its start, or
//     whose timestamp is invalid, is dropped with `source_unreadable`.
//   - `contributor` is the caller's own value; an invalid one is a caller bug
//     and throws a TypeError.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createReadStream, existsSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createInterface } from "node:readline"

import { localRecordsPath, normalizeRow, readSessionRefs, readSessionRows } from "./copilot-usage.js"
import { ENUMS, LIMITS, PATTERNS } from "./schema.js"
import { normalizeTimestamp } from "./time.js"
import { toolKind } from "./tool-kinds.js"

const HOST = "copilot-cli"
const DESK_TOOL = /(?:task_create|task_update|task_archive)$/u
const PATCH_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+?)\s*$/gmu
const PR_SHORT = /^([^/#\s]+\/[^/#\s]+)#(\d+)$/u
const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)(?:[/?#].*)?$/u
const COMMIT = /^[0-9a-fA-F]{40}$/u
const TURN_RETRY = new Set(["model.turn_retry", "assistant.turn_retry"])
const CALL_FAILURE = new Set(["model.model_call_failure", "model.call_failure"])

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const stringOrNull = (value) => (typeof value === "string" ? value : null)
const countOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)
const isValidModel = (value) => typeof value === "string" && PATTERNS.modelId.test(value)

function addNullable(total, value) {
  if (total === null || value === null) return null
  const sum = total + value
  return Number.isSafeInteger(sum) ? sum : null
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function outcomeOf(data) {
  if (isObject(data.error) && data.error.code === "denied") return "denied"
  if (data.success === false) return "error"
  const exitCode = isObject(data.shellExecution) ? data.shellExecution.exitCode : undefined
  if (Number.isInteger(exitCode) && exitCode !== 0) return "error"
  return "ok"
}

function deskCallOf(name, args, at) {
  if (name === null || at === null || !DESK_TOOL.test(name) || !isObject(args)) return null
  const track = stringOrNull(args.track)
  const slug = stringOrNull(args.slug)
  if (track === null || slug === null) return null
  return { at, name, track, slug, person: stringOrNull(args.person), status: stringOrNull(args.status) }
}

function fileWritesOf(name, args, at) {
  if (at === null) return null
  if (name === "create" || name === "edit") {
    const filePath = isObject(args) ? stringOrNull(args.path) : null
    return filePath === null ? null : [{ at, path: filePath }]
  }
  if (name !== "apply_patch") return null
  let texts = []
  if (typeof args === "string") texts = [args]
  else if (isObject(args)) texts = Object.values(args).filter((value) => typeof value === "string")
  const writes = []
  for (const text of texts) {
    for (const match of text.matchAll(PATCH_HEADER)) writes.push({ at, path: match[1] })
  }
  return writes.length > 0 ? writes : null
}

function prRefOf(value) {
  if (typeof value !== "string") return null
  const match = PR_SHORT.exec(value) ?? PR_URL.exec(value)
  if (match === null) return null
  const number = Number(match[2])
  if (!PATTERNS.prRepo.test(match[1]) || !Number.isSafeInteger(number) || number < 1) return null
  return { repo: match[1], number }
}

function compareByStart(a, b) {
  if (a.start < b.start) return -1
  if (a.start > b.start) return 1
  return 0
}

function compareModels(a, b) {
  return a.id < b.id ? -1 : 1
}

function comparePrs(a, b) {
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1
  return a.number - b.number
}

// Exposed only so a unit test can drive each comparator through every
// direction; which pairs a sort compares depends on the input's incidental
// order, which a fixture cannot reliably force.
export const __internals__ = { compareByStart, compareModels, comparePrs }

// ---------------------------------------------------------------------------
// The single streaming pass.
// ---------------------------------------------------------------------------

function createSessionFold() {
  const flags = new Map()
  const flag = (field, reason) => flags.set(`${field}|${reason}`, { field, reason })

  let hostVersion = null
  let earliest = null
  let latest = null

  const intervals = []
  const pushInterval = (interval, field) => {
    if (intervals.length >= LIMITS.intervals) flag(field, "log_truncated")
    else intervals.push(interval)
  }
  const addTimed = (fields, start, end, field) => {
    if (start === null || end === null || end < start) flag(field, "source_unreadable")
    else pushInterval({ ...fields, start, end }, field)
  }

  const pendingTurns = new Map()
  let lastTurnEnd = null
  const pendingTools = new Map()
  const lastFinished = new Map()
  const pendingPermissions = new Map()
  const pendingSubagents = new Map()
  const subagentByCall = new Map()
  const agents = [{ n: 0, parent: null, model: "unknown" }]
  let retryStart = null
  let compactionStart
  let shutdown = null
  const skillPlugins = []

  const toolCalls = new Map()
  const toolFailures = new Map()
  let toolRetries = 0
  let apiRetries = 0
  let compactions = 0

  const deskToolCalls = []
  const fileWrites = []

  const agentOf = (parentCall) => (parentCall === null ? 0 : subagentByCall.get(parentCall) ?? 0)

  const handlers = {
    "session.start"(data, at) {
      if (hostVersion === null && at !== null && typeof data.copilotVersion === "string" && PATTERNS.semver.test(data.copilotVersion)) {
        hostVersion = data.copilotVersion
      }
    },
    "session.shutdown"(data) {
      shutdown = isObject(data.modelMetrics) ? parseModelMetrics(data.modelMetrics, flag) : { models: [] }
      if (!isObject(data.modelMetrics)) flag("tokens", "source_unreadable")
    },
    "assistant.turn_start"(data, at) {
      lastTurnEnd = null
      const turnId = stringOrNull(data.turnId)
      if (turnId !== null) pendingTurns.set(turnId, at)
    },
    "assistant.turn_end"(data, at) {
      retryStart = null
      const turnId = stringOrNull(data.turnId)
      if (turnId === null || !pendingTurns.has(turnId)) return
      const start = pendingTurns.get(turnId)
      pendingTurns.delete(turnId)
      addTimed({ kind: "turn", agent: 0 }, start, at, "turns")
      lastTurnEnd = at
    },
    "user.message"(data, at) {
      if (lastTurnEnd !== null && pendingTurns.size === 0) addTimed({ kind: "human_wait", agent: 0 }, lastTurnEnd, at, "human_waits")
      lastTurnEnd = null
    },
    "tool.execution_start"(data, at) {
      const toolCallId = stringOrNull(data.toolCallId)
      if (toolCallId === null) return
      const name = stringOrNull(data.toolName)
      const kind = toolKind({ host: HOST, name })
      const parentCall = stringOrNull(data.parentToolCallId)
      const agent = agentOf(parentCall)
      const previous = lastFinished.get(`${agent}:${kind}`)
      if (previous && previous.outcome !== "ok" && !previous.retried && at !== null && previous.end !== null && at > previous.end) {
        toolRetries += 1
        previous.retried = true
      }
      pendingTools.set(toolCallId, {
        kind,
        start: at,
        agent,
        parentCall,
        spawns: name === "task",
        desk: deskCallOf(name, data.arguments, at),
        writes: fileWritesOf(name, data.arguments, at),
      })
    },
    "tool.execution_complete"(data, at) {
      const toolCallId = stringOrNull(data.toolCallId)
      const pending = toolCallId === null ? undefined : pendingTools.get(toolCallId)
      if (pending === undefined) return
      pendingTools.delete(toolCallId)
      const outcome = outcomeOf(data)
      increment(toolCalls, pending.kind)
      if (outcome !== "ok") increment(toolFailures, pending.kind)
      lastFinished.set(`${pending.agent}:${pending.kind}`, { end: at, outcome, retried: false })
      if (!pending.spawns && !subagentByCall.has(toolCallId)) {
        addTimed({ kind: "tool", agent: pending.agent, tool: pending.kind, outcome }, pending.start, at, "tool_durations")
      }
      if (pending.desk !== null) deskToolCalls.push({ ...pending.desk, ok: outcome === "ok" })
      if (pending.writes !== null && data.success === true) fileWrites.push(...pending.writes)
    },
    "permission.requested"(data, at) {
      const requestId = stringOrNull(data.requestId)
      if (requestId !== null) pendingPermissions.set(requestId, at)
    },
    "permission.completed"(data, at) {
      const requestId = stringOrNull(data.requestId)
      if (requestId === null || !pendingPermissions.has(requestId)) return
      const start = pendingPermissions.get(requestId)
      pendingPermissions.delete(requestId)
      if (data.decisionSource === "human_response") addTimed({ kind: "permission_wait", agent: 0 }, start, at, "permission_waits")
    },
    "subagent.started"(data, at) {
      const toolCallId = stringOrNull(data.toolCallId)
      if (toolCallId === null || subagentByCall.has(toolCallId)) return
      if (agents.length >= LIMITS.agents) {
        flag("turns", "log_truncated")
        return
      }
      let model = "unknown"
      if (isValidModel(data.model)) model = data.model
      else if (data.model !== undefined) flag("models", "source_unreadable")
      const parent = agentOf(pendingTools.get(toolCallId)?.parentCall ?? null)
      const n = agents.length
      agents.push({ n, parent, model })
      subagentByCall.set(toolCallId, n)
      pendingSubagents.set(toolCallId, { start: at, agent: parent })
    },
    "subagent.completed"(data, at) {
      endSubagent(data, at)
    },
    "subagent.failed"(data, at) {
      endSubagent(data, at)
    },
    "session.error"(data, at) {
      const status = data.statusCode
      if (Number.isInteger(status) && (status === 429 || status >= 500)) openRetry(at)
    },
    "session.compaction_start"(data, at) {
      compactionStart = at
    },
    "session.compaction_complete"(data, at) {
      compactions += 1
      if (compactionStart !== undefined) addTimed({ kind: "compaction", agent: 0 }, compactionStart, at, "turns")
      compactionStart = undefined
    },
    "skill.invoked"(data) {
      if (data.pluginName === undefined && data.pluginVersion === undefined) return
      const { pluginName: name, pluginVersion: version } = data
      if (typeof name === "string" && PATTERNS.pluginName.test(name) && typeof version === "string" && PATTERNS.semver.test(version)) {
        if (!skillPlugins.some((plugin) => plugin.name === name && plugin.version === version)) skillPlugins.push({ name, version })
      } else {
        flag("plugins", "source_unreadable")
      }
    },
  }

  function endSubagent(data, at) {
    const toolCallId = stringOrNull(data.toolCallId)
    const pending = toolCallId === null ? undefined : pendingSubagents.get(toolCallId)
    if (pending === undefined) return
    pendingSubagents.delete(toolCallId)
    addTimed({ kind: "subagent", agent: pending.agent }, pending.start, at, "turns")
  }

  function openRetry(at) {
    if (retryStart === null) retryStart = at
  }

  for (const type of CALL_FAILURE) handlers[type] = (data, at) => openRetry(at)
  for (const type of TURN_RETRY) {
    handlers[type] = (data, at) => {
      apiRetries += 1
      if (retryStart !== null) addTimed({ kind: "api_retry", agent: 0 }, retryStart, at, "api_retries")
      retryStart = null
    }
  }

  return {
    push(event) {
      const at = normalizeTimestamp(event.timestamp)
      if (at !== null) {
        // Normalized timestamps share one fixed-width UTC shape, so string
        // order is time order.
        if (earliest === null || at < earliest) earliest = at
        if (latest === null || at > latest) latest = at
      }
      const handler = Object.hasOwn(handlers, event.type) ? handlers[event.type] : undefined
      if (handler !== undefined) handler(isObject(event.data) ? event.data : {}, at)
    },
    finish() {
      return {
        flags,
        hostVersion,
        earliest,
        latest,
        intervals,
        agents,
        shutdown,
        skillPlugins,
        toolCalls,
        toolFailures,
        toolRetries,
        apiRetries,
        compactions,
        deskToolCalls,
        fileWrites,
        unfinishedCalls: pendingTools.size + pendingSubagents.size > 0,
        openTurns: pendingTurns.size > 0,
      }
    },
  }
}

function parseModelMetrics(metrics, flag) {
  const models = []
  for (const [id, metric] of Object.entries(metrics)) {
    if (!isValidModel(id)) {
      flag("models", "source_unreadable")
      continue
    }
    const requests = isObject(metric) && isObject(metric.requests) ? metric.requests.count : undefined
    const usage = isObject(metric) && isObject(metric.usage) ? metric.usage : {}
    models.push({
      id,
      requests: countOrNull(requests),
      tokens: {
        input: countOrNull(usage.inputTokens),
        output: countOrNull(usage.outputTokens),
        cache_read: countOrNull(usage.cacheReadTokens),
        cache_write: countOrNull(usage.cacheWriteTokens),
        reasoning: countOrNull(usage.reasoningTokens),
      },
    })
  }
  return { models }
}

async function streamEvents(file, onEvent) {
  let lastLineFailed = false
  let earlierFailure = false
  const lines = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })
  for await (const raw of lines) {
    if (raw.trim().length === 0) continue
    if (lastLineFailed) earlierFailure = true
    lastLineFailed = false
    let event
    try {
      event = JSON.parse(raw)
    } catch {
      lastLineFailed = true
      continue
    }
    if (isObject(event)) onEvent(event)
  }
  return { truncated: lastLineFailed, earlierFailure }
}

// ---------------------------------------------------------------------------
// The session database.
// ---------------------------------------------------------------------------

function usageFromDatabase(sessionId, env, flag) {
  if (!existsSync(localRecordsPath(env))) return []
  let rows
  try {
    rows = readSessionRows({ sessionId, env }).rows
  } catch {
    flag("tokens", "source_unreadable")
    return []
  }
  const byModel = new Map()
  for (const row of rows) {
    const normalized = normalizeRow(row)
    if (normalized.malformed !== undefined) {
      flag("tokens", "source_unreadable")
      continue
    }
    const fact = normalized.fact
    if (!isValidModel(fact.model)) {
      flag("models", "source_unreadable")
      continue
    }
    if (!byModel.has(fact.model)) {
      byModel.set(fact.model, { id: fact.model, requests: 0, tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 } })
    }
    const entry = byModel.get(fact.model)
    entry.requests += 1
    entry.tokens.input = addNullable(entry.tokens.input, fact.input_tokens)
    entry.tokens.output = addNullable(entry.tokens.output, fact.output_tokens)
    entry.tokens.cache_read = addNullable(entry.tokens.cache_read, fact.cache_read_tokens)
    entry.tokens.cache_write = addNullable(entry.tokens.cache_write, fact.cache_write_tokens)
    entry.tokens.reasoning = addNullable(entry.tokens.reasoning, fact.reasoning_tokens)
  }
  return [...byModel.values()]
}

function refsFromDatabase(sessionId, env, flag) {
  let result
  try {
    result = readSessionRefs({ sessionId, env })
  } catch {
    flag("commits", "source_unreadable")
    return { prs: [], commits: [] }
  }
  if (!result.present) {
    flag("commits", "log_missing")
    return { prs: [], commits: [] }
  }
  const prs = new Map()
  const commits = new Set()
  for (const { ref_type: type, ref_value: value } of result.rows) {
    if (type === "pr") {
      const ref = prRefOf(value)
      if (ref !== null) prs.set(`${ref.repo}#${ref.number}`, ref)
    } else if (type === "commit" && typeof value === "string" && COMMIT.test(value)) {
      commits.add(value.toLowerCase())
    }
  }
  const sortedCommits = [...commits].sort()
  if (sortedCommits.length > LIMITS.commits) flag("commits", "log_truncated")
  return {
    prs: [...prs.values()].sort(comparePrs).slice(0, LIMITS.prs),
    commits: sortedCommits.slice(0, LIMITS.commits),
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

function mergePlugins(input, skillPlugins, flag) {
  const merged = []
  const seen = new Set()
  const add = (plugin) => {
    const key = `${plugin.name}@${plugin.version}`
    if (seen.has(key)) return
    seen.add(key)
    merged.push({ name: plugin.name, version: plugin.version })
  }
  for (const plugin of Array.isArray(input) ? input : []) {
    if (isObject(plugin) && typeof plugin.name === "string" && PATTERNS.pluginName.test(plugin.name) && typeof plugin.version === "string" && PATTERNS.semver.test(plugin.version)) {
      add(plugin)
    } else {
      flag("plugins", "source_unreadable")
    }
  }
  for (const plugin of skillPlugins) add(plugin)
  if (merged.length > LIMITS.plugins) flag("plugins", "log_truncated")
  return merged.slice(0, LIMITS.plugins)
}

function rootModel(models) {
  let best = null
  for (const model of models) {
    if (best === null || (model.requests ?? 0) > (best.requests ?? 0)) best = model
  }
  return best === null ? "unknown" : best.id
}

export async function deriveCopilotSession({ sessionId, copilotHome, contributor, plugins, endReason, entrypoint = "cli" }) {
  if (typeof contributor !== "string" || !PATTERNS.contributor.test(contributor)) {
    throw new TypeError("deriveCopilotSession: contributor must be 16 lowercase hex characters")
  }
  if (typeof sessionId !== "string" || !PATTERNS.sessionId.test(sessionId)) {
    return { facts: null, events: null, reason: "source_unreadable" }
  }
  const home = copilotHome ?? process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot")
  const env = { COPILOT_HOME: home }
  const eventsPath = path.join(home, "session-state", sessionId, "events.jsonl")
  if (!existsSync(eventsPath)) return { facts: null, events: null, reason: "log_missing" }

  const fold = createSessionFold()
  let read
  try {
    read = await streamEvents(eventsPath, (event) => fold.push(event))
  } catch {
    return { facts: null, events: null, reason: "source_unreadable" }
  }
  const state = fold.finish()
  if (state.hostVersion === null) return { facts: null, events: null, reason: "source_unreadable" }

  const flags = state.flags
  const flag = (field, reason) => flags.set(`${field}|${reason}`, { field, reason })
  const safeEndReason = ENUMS.endReason.includes(endReason) ? endReason : null
  const openOrTruncated = safeEndReason === null ? "session_open" : "log_truncated"

  let models
  if (state.shutdown !== null) {
    models = state.shutdown.models
  } else {
    models = usageFromDatabase(sessionId, env, flag)
    if (models.length === 0 && !flags.has("tokens|source_unreadable")) flag("tokens", "session_open")
  }
  models.sort(compareModels)
  if (models.length > LIMITS.models) flag("models", "log_truncated")
  models = models.slice(0, LIMITS.models)
  state.agents[0].model = rootModel(models)

  if (safeEndReason === null) flag("ended_at", "session_open")
  if (read.truncated) flag("turns", "log_truncated")
  if (read.earlierFailure) flag("turns", "source_unreadable")
  if (state.unfinishedCalls) flag("tool_durations", openOrTruncated)
  if (state.openTurns) flag("turns", openOrTruncated)

  const refs = refsFromDatabase(sessionId, env, flag)
  const mergedPlugins = mergePlugins(plugins, state.skillPlugins, flag)
  flag("ci_runs", "not_collected_in_slice_1")

  const facts = {
    schema: "desk.factory.facts/1",
    contributor,
    session: {
      host: HOST,
      id: sessionId,
      host_version: state.hostVersion,
      entrypoint: entrypoint === "launcher" ? "launcher" : "cli",
      started_at: state.earliest,
      ended_at: safeEndReason === null ? null : state.latest,
      end_reason: safeEndReason,
      derived_through: state.latest,
    },
    plugins: mergedPlugins,
    models,
    agents: state.agents,
    intervals: state.intervals.sort(compareByStart),
    counts: {
      tool_calls: Object.fromEntries(state.toolCalls),
      tool_failures: Object.fromEntries(state.toolFailures),
      tool_retries: state.toolRetries,
      api_retries: state.apiRetries,
      compactions: state.compactions,
    },
    refs: { prs: refs.prs, commits: refs.commits.map((sha) => ({ sha })) },
    jobs: [],
    unavailable: [...flags.values()].slice(0, LIMITS.unavailable),
  }

  const events = {
    deskToolCalls: state.deskToolCalls,
    fileWrites: state.fileWrites,
    commitShas: refs.commits,
  }

  return { facts, events }
}
