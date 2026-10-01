// Codex CLI deriver: turns one session's rollout files into a local facts
// object (`desk.factory.local/1`; `jobs: []`, filled in by `binding.js`) plus
// in-memory binding events, in the same shape the Claude and Copilot derivers
// produce. A session is the root thread; every spawned child thread has its
// own rollout file, and the tree is rebuilt from each child's `session_meta`.
//
// UNPROVEN. No Codex session exists on any of our machines. Every shape read
// here comes from the openai/codex source as recorded in
// `tests/desk/mcp/__tests__/factory/fixtures/codex/FORMAT.md` (commit
// 60947e23), never from a real rollout. Unconfirmed parts are read
// defensively: an unknown shape is skipped, never thrown on.
//
// What is read. Of each line only `type`, `timestamp`, `ordinal` and these
// `payload` fields: `session_meta.{id, cli_version, source, parent_thread_id,
// agent_role, agent_type, subagent_history_start_ordinal, cwd}` (`cwd` only to
// resolve relative paths and commit directories in memory);
// `turn_context.{model, cwd}`; `event_msg.{type}` for `task_started`,
// `task_complete`, `turn_aborted` and `token_count.info.total_token_usage`;
// `response_item` calls (`function_call`, `custom_tool_call`,
// `local_shell_call`: tool name, namespace, call id and, for binding only,
// the arguments named below) and their outputs (only to decide success and to
// find a PR URL, in memory). Prompt text, assistant text, reasoning, tool
// output and file contents never enter `facts`: every fact is a count, a
// duration, an enum bucket or a pattern-shaped id. The richer detail (Desk
// task track and slug, file paths, commit directories) reaches only `events`,
// which the caller keeps in memory.
//
// Rules.
//   - Finding children (R5). The root rollout's first record must be
//     `session_meta`. Then the day folders from the root's start date minus
//     one day through its last record's date plus one day are scanned (rollout
//     folders use local time, so a day of slack each way covers any offset).
//     The scan ends no later than today plus one day, or a year after the
//     start, so a far-future timestamp cannot stretch it.
//     Only each candidate's first record is read, and only an exact parent
//     thread id match joins, repeated until no thread joins. A thread from
//     another session that shares a folder or a minute never joins.
//   - Numbering. The root is worker 0; joined threads are numbered 1.. in
//     order of start time, then id. `parent` is the joining thread's number.
//   - `model` is the most-used `turn_context.model` of the thread (`unknown`
//     when none). `requested_model` is, for a child, the `model` argument of
//     the `spawn_agent` call that named it when that is a valid model id, else
//     the thread's first `turn_context.model`; left out when it equals `model`.
//     A mid-thread model switch shows only as the resolved (most-used) `model`. `agent_type` is the child's `agent_role` (or
//     `agent_type`) from its `session_meta`, else the `agent_type` argument of
//     the `spawn_agent` call that named it; the root has none.
//   - A turn is `task_started` to `task_complete`/`turn_aborted` (and their
//     `turn_started`/`turn_complete` aliases), on the thread's own worker.
//     `human_wait` is worker 0 only, from a turn's end to the next turn's
//     start. A child's span is a `subagent` interval on its parent, from the
//     child's first to its last record.
//   - Tools are a call record paired with the output record of the same
//     `call_id`. The tool kind comes from `./tool-kinds.js`. `spawn_agent`
//     counts as an `agent` call but has no `tool` interval. Outcome is `error`
//     only when the output says the command exited non-zero (a
//     `Process exited with code N` line in the header, or a JSON
//     `metadata.exit_code`); the real `exec_command` output layout is
//     unconfirmed, so an unrecognized layout reads as `ok`. An output reading
//     `Process running with session ID N` is not a result: no commit, file,
//     PR or Desk-call credit. A PR needs a recognised exit code of 0.
//   - Tokens. The thread total in `token_count.info.total_token_usage` is
//     cumulative; each increase is credited to the model of the latest
//     `turn_context` and counts as one request. Assumption, unconfirmed:
//     `cached_input_tokens` is part of `input_tokens` and
//     `reasoning_output_tokens` is part of `output_tokens`, so `input` and
//     `output` exclude them.
//   - Binding events, as the Claude deriver's: `deskToolCalls` (an MCP call
//     named `mcp__*desk*__task_create|task_update|task_archive`, whether the
//     rollout stores the name joined or as namespace plus name),
//     `fileWrites` (`*** Add File`, `*** Update File` and `*** Move to` paths
//     of a successful `apply_patch`), `shellGitCommits` (successful
//     `git … commit` commands, through `./shell-git.js`), `spawnTasks` (the
//     `Desk-Task:` line of the spawn prompt, else of the child's first three user
//     messages, through `./desk-task-line.js`) and PR refs (only from a
//     successful `gh pr create` whose output holds the PR URL, with
//     `created: true` for the worker that ran it, which outranks any other).
//   - A child rollout's records below its `subagent_history_start_ordinal`
//     are inherited context and skipped, so a parent's calls are not counted
//     twice.
//   - A record with no readable timestamp is skipped and flagged under
//     `turns` and `tool_durations`. A file that ends mid-line keeps what
//     parsed and flags `{turns, log_truncated}`. A rollout with no
//     `session_meta` first record, or no `cli_version` semver, is
//     `{ facts: null, events: null, reason: "source_unreadable" }`; a missing
//     file is `log_missing`. This function never throws.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createReadStream, existsSync } from "node:fs"
import { readdir } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createInterface } from "node:readline"

import { __internals__ as claude } from "./derive-claude.js"
import { parseDeskTaskLine } from "./desk-task-line.js"
import { ENUMS, LIMITS, LOCAL_SCHEMA, PATTERNS, isPlainObject } from "./schema.js"
import { gitCommitCwds } from "./shell-git.js"
import { normalizeTimestamp } from "./time.js"
import { toolKind } from "./tool-kinds.js"

const { applyLimits, dedupePrRefs, sanitizePlugins, addUnavailable } = claude

const HOST = "codex-cli"
const DESK_CALL_PATTERN = /^mcp__.*desk.*__(task_create|task_update|task_archive)$/u
const PR_URL_PATTERN = /github\.com\/([^/\s]+\/[^/\s]+?)(?:\.git)?\/pull\/(\d+)/u
const PR_CREATE_PATTERN = /\bgh\s+pr\s+create\b/u
const PATCH_PATH_PATTERN = /^\*\*\* (?:Add File|Update File|Move to): (.+)$/gmu
const ROLLOUT_NAME = /^rollout-.*\.jsonl$/u
const EXIT_HEADER = /^Process exited with code (\d+)$/mu
const TURN_START = new Set(["task_started", "turn_started"])
const TURN_END = new Set(["task_complete", "turn_complete", "turn_aborted"])
const ENTRYPOINTS = Object.freeze({ cli: "cli", exec: "cli" })
const MAX_FIRST_RECORD_BYTES = 4 * 1024 * 1024
const DAY_MS = 24 * 60 * 60 * 1000
const MAX_SCAN_DAYS = 366
const RUNNING_HEADER = /^Process running with session ID /mu

// ---------------------------------------------------------------------------
// Small, defensive helpers. None of these ever throw on an unexpected shape.
// ---------------------------------------------------------------------------

const nonNeg = (value) => (Number.isFinite(value) && value >= 0 ? value : 0)
const matching = (pattern, ...candidates) => candidates.find((value) => typeof value === "string" && pattern.test(value)) ?? null
const validModel = (value) => typeof value === "string" && PATTERNS.modelId.test(value)

function parseObject(text) {
  try {
    const value = JSON.parse(text)
    return isPlainObject(value) ? value : {}
  } catch {
    return {}
  }
}

// An MCP tool is `namespace` + `name` in the Codex source; the rollout may store it joined or split.
function toolName(namespace, name) {
  if (typeof name !== "string") return ""
  if (typeof namespace !== "string" || !namespace.startsWith("mcp") || name.startsWith("mcp__")) return name
  return namespace.endsWith("__") ? namespace + name : `${namespace}__${name}`
}

// A tool output is a string or an array of content items; anything else reads as empty.
function outputText(output) {
  if (typeof output === "string") return output
  if (!Array.isArray(output)) return ""
  return output.map((item) => item?.text).filter((text) => typeof text === "string").join("\n")
}

// The exit code an output reports, or null when its layout is not recognized. Matched in memory, never kept.
function exitCode(text) {
  const header = EXIT_HEADER.exec(text.slice(0, 1000))
  if (header !== null) return Number(header[1])
  const code = text.startsWith("{") ? parseObject(text).metadata?.exit_code : undefined
  return Number.isInteger(code) ? code : null
}

// A `local_shell_call` command is an argv array; `bash -lc "<script>"` runs its script.
function argvCommand(argv) {
  if (!Array.isArray(argv) || !argv.every((word) => typeof word === "string")) return undefined
  return argv.length === 3 && /^(?:ba|z)?sh$/u.test(path.basename(argv[0])) && /^-l?c$/u.test(argv[1]) ? argv[2] : argv.join(" ")
}

function messageText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part) => part?.text).filter((text) => typeof text === "string").join("\n")
}

function patchPaths(text, cwd) {
  const found = []
  for (const match of text.matchAll(PATCH_PATH_PATTERN)) {
    const file = match[1].trim()
    if (path.isAbsolute(file)) found.push(file)
    else if (typeof cwd === "string" && path.isAbsolute(cwd)) found.push(path.resolve(cwd, file))
  }
  return found
}

function prRef(text, agent) {
  const match = PR_URL_PATTERN.exec(text)
  if (match === null || !PATTERNS.prRepo.test(match[1])) return null
  const number = Number(match[2])
  return Number.isSafeInteger(number) && number > 0 ? { repo: match[1], number, agent, created: true } : null
}

// ---------------------------------------------------------------------------
// Reading. `firstLine` reads one record's worth of bytes; `streamJsonl` reads a
// whole rollout once, line by line.
// ---------------------------------------------------------------------------

async function firstLine(file) {
  const stream = createReadStream(file, { encoding: "utf8", highWaterMark: 64 * 1024, end: MAX_FIRST_RECORD_BYTES })
  let text = ""
  for await (const chunk of stream) {
    text += chunk
    const newline = text.indexOf("\n")
    if (newline !== -1) {
      text = text.slice(0, newline)
      break
    }
  }
  stream.destroy()
  return text
}

// A rollout's identity, from its first record alone; null when that record is not a usable `session_meta`.
function metaOfFirstLine(text) {
  let record
  try {
    record = JSON.parse(text)
  } catch {
    return null
  }
  const payload = record?.payload
  const startedAt = normalizeTimestamp(record?.timestamp)
  if (record?.type !== "session_meta" || !isPlainObject(payload) || startedAt === null) return null
  const id = matching(PATTERNS.sessionId, payload.id)
  if (id === null) return null
  const spawn = payload.source?.subagent?.thread_spawn
  const startOrdinal = payload.subagent_history_start_ordinal
  return {
    id,
    startedAt,
    version: matching(PATTERNS.semver, payload.cli_version),
    parent: matching(PATTERNS.sessionId, payload.parent_thread_id, spawn?.parent_thread_id),
    agentType: matching(PATTERNS.agentType, payload.agent_role, payload.agent_type, spawn?.agent_role),
    startOrdinal: Number.isInteger(startOrdinal) ? startOrdinal : null,
    cwd: typeof payload.cwd === "string" ? payload.cwd : null,
    source: typeof payload.source === "string" ? payload.source : null,
  }
}

async function streamJsonl(file, onLine) {
  let lastLineFailed = false
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity })
  for await (const raw of rl) {
    if (raw.trim().length === 0) continue
    let parsed
    try {
      parsed = JSON.parse(raw)
      lastLineFailed = false
    } catch {
      lastLineFailed = true
      continue
    }
    if (isPlainObject(parsed)) onLine(parsed)
  }
  return { truncated: lastLineFailed }
}

// ---------------------------------------------------------------------------
// Finding the child threads (R5).
// ---------------------------------------------------------------------------

/** The `sessions/YYYY/MM/DD` folders from `startedAt` minus a day through `lastAt` plus a day. */
function dayFolders(sessionsDir, startedAt, lastAt) {
  const dayOf = (instant) => Math.floor(instant / DAY_MS) * DAY_MS
  const start = dayOf(Date.parse(startedAt))
  // A far-future timestamp must not stretch the scan: it ends at the earliest of the last record's day, today, and a year after the start, each plus a day.
  // A root that starts after today (clock skew) still scans its own day and the next.
  const last = Math.max(Math.min(Math.max(dayOf(Date.parse(lastAt)), start), dayOf(Date.now()), start + MAX_SCAN_DAYS * DAY_MS), start) + DAY_MS
  const first = start - DAY_MS
  const folders = []
  for (let day = first; day <= last; day += DAY_MS) {
    const [year, month, date] = new Date(day).toISOString().slice(0, 10).split("-")
    folders.push(path.join(sessionsDir, year, month, date))
  }
  return folders
}

/**
 * The threads that join the tree rooted at `root`: `{ file, meta }` in join order, plus whether `limit` stopped the search.
 * A candidate is a rollout in the scanned folders whose first record is a `session_meta` naming a parent thread.
 */
async function findChildren(root, sessionsDir, lastAt, limit = LIMITS.agents) {
  const candidates = []
  for (const folder of dayFolders(sessionsDir, root.startedAt, lastAt)) {
    let names
    try {
      names = (await readdir(folder)).filter((name) => ROLLOUT_NAME.test(name)).sort()
    } catch {
      continue
    }
    for (const name of names) {
      const file = path.join(folder, name)
      let meta = null
      try {
        meta = metaOfFirstLine(await firstLine(file))
      } catch {
        // An unreadable candidate is not a child.
      }
      if (meta !== null && meta.parent !== null) candidates.push({ file, meta })
    }
  }
  const members = new Set([root.id])
  const joined = []
  let capped = false
  for (let changed = true; changed;) {
    changed = false
    for (const candidate of candidates) {
      if (members.has(candidate.meta.id) || !members.has(candidate.meta.parent)) continue
      if (members.size >= limit) {
        capped = true
        continue
      }
      members.add(candidate.meta.id)
      joined.push(candidate)
      changed = true
    }
  }
  return { joined, capped }
}

// ---------------------------------------------------------------------------
// Per-thread processor: folds one rollout's records, one at a time, into small
// aggregate state. Used identically for the root (worker 0) and every child.
// ---------------------------------------------------------------------------

function createThreadProcessor({ agentIndex, meta }) {
  const pendingCalls = new Map() // call id -> { name, kind, start, isSpawn, isPrCreate, cwds, paths, desk }
  const spawnByCall = new Map() // spawn call id -> { task, agentType }
  const spawnedChildren = new Map() // child thread id -> { task, agentType }
  const lastFinishedByKind = new Map() // kind -> { end, outcome, retried }
  const modelCounts = new Map()
  const modelOrder = []
  const usage = new Map() // model -> { requests, input, cached, write, output, reasoning }
  const intervals = []
  const toolCallCounts = new Map()
  const toolFailureCounts = new Map()
  const prRefs = []
  const fileWrites = []
  const deskToolCalls = []
  const shellGitCommits = []
  let previousTotal = { input: 0, cached: 0, write: 0, output: 0, reasoning: 0 }
  let currentModel = null
  let currentCwd = meta.cwd
  let openTurnStart = null
  let lastTurnEnd = null
  let userMessages = 0
  let firstPromptTask = null
  let toolRetries = 0
  let compactions = 0
  // The thread's own creation time bounds its span even when every later record is skipped.
  let earliest = meta.startedAt
  let latest = meta.startedAt
  let hadUnresolvedCall = false
  let hadUnresolvedTurn = false
  let hadUnreadableTime = false
  let invalidModelSeen = false

  function startCall({ callId, name, args, input, ts }) {
    if (typeof callId !== "string") {
      hadUnresolvedCall = true
      return
    }
    const kind = toolKind({ host: HOST, name })
    const command = [args.cmd, args.command].find((value) => typeof value === "string")
    const cwd = typeof args.workdir === "string" ? args.workdir : currentCwd
    const patchText = [input, args.input, command].find((value) => typeof value === "string") ?? ""
    const isPatch = name === "apply_patch" || /^\s*apply_patch\b/u.test(command ?? "")
    const isSpawn = name === "spawn_agent"
    if (isSpawn) spawnByCall.set(callId, { task: parseDeskTaskLine(args.message), agentType: matching(PATTERNS.agentType, args.agent_type), model: matching(PATTERNS.modelId, args.model) })
    const cwds = kind === "shell" && command !== undefined ? gitCommitCwds({ command, cwd, home: os.homedir() }) : []
    const previous = lastFinishedByKind.get(kind)
    if (previous && previous.outcome !== "ok" && !previous.retried && ts > previous.end) {
      toolRetries += 1
      previous.retried = true
    }
    pendingCalls.set(callId, {
      name,
      kind,
      start: ts,
      isSpawn,
      isPrCreate: command !== undefined && PR_CREATE_PATTERN.test(command),
      cwds,
      paths: isPatch ? patchPaths(patchText, cwd) : [],
      desk: DESK_CALL_PATTERN.test(name)
        ? { at: ts, name, track: args.track, slug: args.slug, person: args.person ?? null, status: args.status ?? null }
        : null,
    })
  }

  function finishCall(callId, text, ts) {
    const pending = pendingCalls.get(callId)
    if (pending === undefined) return
    pendingCalls.delete(callId)
    if (pending.isSpawn) {
      // Version 1 names the child's thread id in the spawn output; version 2 does not, and is linked by the child's own meta.
      const childId = matching(PATTERNS.sessionId, parseObject(text).agent_id)
      if (childId !== null) spawnedChildren.set(childId, spawnByCall.get(callId))
    }
    const code = exitCode(text)
    const outcome = code !== null && code !== 0 ? "error" : "ok"
    // Output saying the command is still running (`Process running with session ID N`) is not a result: nothing is credited for it.
    const credited = outcome === "ok" && !RUNNING_HEADER.test(text.slice(0, 1000))
    if (!pending.isSpawn) intervals.push({ kind: "tool", agent: agentIndex, tool: pending.kind, outcome, start: pending.start, end: ts })
    toolCallCounts.set(pending.kind, (toolCallCounts.get(pending.kind) ?? 0) + 1)
    if (outcome !== "ok") toolFailureCounts.set(pending.kind, (toolFailureCounts.get(pending.kind) ?? 0) + 1)
    lastFinishedByKind.set(pending.kind, { end: ts, outcome, retried: false })
    if (pending.desk !== null) deskToolCalls.push({ ...pending.desk, agent: agentIndex, ok: credited })
    if (!credited) return
    // A creation needs a recognised exit code of 0: a failed `gh pr create` can still print an existing PR URL.
    if (pending.isPrCreate && code === 0) {
      const ref = prRef(text, agentIndex)
      if (ref !== null) prRefs.push(ref)
    }
    for (const cwd of pending.cwds) shellGitCommits.push({ start: pending.start, end: ts, cwd, agent: agentIndex })
    for (const file of pending.paths) fileWrites.push({ at: pending.start, path: file, agent: agentIndex })
  }

  function handleResponseItem(payload, ts) {
    const { type } = payload
    if (type === "function_call") {
      startCall({ callId: payload.call_id, name: toolName(payload.namespace, payload.name), args: parseObject(payload.arguments), ts })
    } else if (type === "custom_tool_call") {
      startCall({ callId: payload.call_id, name: typeof payload.name === "string" ? payload.name : "", args: {}, input: payload.input, ts })
    } else if (type === "local_shell_call") {
      const action = payload.action
      startCall({ callId: payload.call_id, name: "local_shell_call", args: { cmd: argvCommand(action?.command), workdir: action?.working_directory }, ts })
    } else if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (typeof payload.call_id === "string") finishCall(payload.call_id, outputText(payload.output), ts)
    } else if (type === "message" && payload.role === "user" && userMessages < 3) {
      // Codex may inject context as the first user messages, so the first three are checked.
      userMessages += 1
      firstPromptTask ??= parseDeskTaskLine(messageText(payload.content))
    }
  }

  function handleTokenCount(info) {
    const total = info?.total_token_usage
    if (!isPlainObject(total)) return
    const current = {
      input: nonNeg(total.input_tokens),
      cached: nonNeg(total.cached_input_tokens),
      write: nonNeg(total.cache_write_input_tokens),
      output: nonNeg(total.output_tokens),
      reasoning: nonNeg(total.reasoning_output_tokens),
    }
    // A total that went down is a new baseline, not negative usage.
    const base = current.input + current.output < previousTotal.input + previousTotal.output ? { input: 0, cached: 0, write: 0, output: 0, reasoning: 0 } : previousTotal
    const delta = Object.fromEntries(Object.keys(current).map((key) => [key, Math.max(0, current[key] - base[key])]))
    previousTotal = current
    if (delta.input + delta.output === 0) return
    if (currentModel === null) {
      invalidModelSeen = true
      return
    }
    const entry = usage.get(currentModel) ?? { requests: 0, input: 0, cached: 0, write: 0, output: 0, reasoning: 0 }
    entry.requests += 1
    for (const key of Object.keys(delta)) entry[key] += delta[key]
    usage.set(currentModel, entry)
  }

  function handleEvent(payload, ts) {
    const type = payload.type
    if (TURN_START.has(type)) {
      if (openTurnStart !== null) hadUnresolvedTurn = true
      if (agentIndex === 0 && lastTurnEnd !== null) intervals.push({ kind: "human_wait", agent: agentIndex, start: lastTurnEnd, end: ts })
      openTurnStart = ts
    } else if (TURN_END.has(type)) {
      if (openTurnStart !== null) intervals.push({ kind: "turn", agent: agentIndex, start: openTurnStart, end: ts })
      openTurnStart = null
      lastTurnEnd = ts
    } else if (type === "token_count") {
      handleTokenCount(payload.info)
    }
  }

  function handleTurnContext(payload) {
    if (typeof payload.cwd === "string") currentCwd = payload.cwd
    if (!validModel(payload.model)) {
      invalidModelSeen = true
      return
    }
    currentModel = payload.model
    if (!modelCounts.has(currentModel)) modelOrder.push(currentModel)
    modelCounts.set(currentModel, (modelCounts.get(currentModel) ?? 0) + 1)
  }

  return {
    pushLine(line) {
      const payload = isPlainObject(line.payload) ? line.payload : {}
      // Records copied from the parent into a child's rollout are inherited context, not this thread's work.
      if (meta.startOrdinal !== null && Number.isInteger(line.ordinal) && line.ordinal < meta.startOrdinal) return
      const ts = normalizeTimestamp(line.timestamp)
      if (ts === null) {
        hadUnreadableTime = true
        return
      }
      if (ts < earliest) earliest = ts
      if (ts > latest) latest = ts
      if (line.type === "turn_context") handleTurnContext(payload)
      else if (line.type === "event_msg") handleEvent(payload, ts)
      else if (line.type === "response_item") handleResponseItem(payload, ts)
      else if (line.type === "compacted") compactions += 1
      // session_meta (read once, up front) and every other record type are skipped.
    },
    finish() {
      if (pendingCalls.size > 0) hadUnresolvedCall = true
      if (openTurnStart !== null) hadUnresolvedTurn = true
      const model = modelOrder.length === 0
        ? "unknown"
        : modelOrder.reduce((best, candidate) => (modelCounts.get(candidate) > modelCounts.get(best) ? candidate : best), modelOrder[0])
      return {
        meta, model, firstModel: modelOrder[0] ?? null, usage, intervals, toolCallCounts, toolFailureCounts, toolRetries, compactions,
        prRefs, fileWrites, deskToolCalls, shellGitCommits, spawnedChildren, firstPromptTask, earliest, latest,
        hadUnresolvedCall, hadUnresolvedTurn, hadUnreadableTime, invalidModelSeen,
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Session-wide aggregation.
// ---------------------------------------------------------------------------

function aggregateModels(results) {
  const byModel = new Map()
  for (const result of results) {
    for (const [id, entry] of result.usage) {
      const total = byModel.get(id) ?? { requests: 0, input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: 0 }
      total.requests += entry.requests
      // Unconfirmed: cached input is part of `input_tokens`, reasoning part of `output_tokens`.
      total.input += Math.max(0, entry.input - entry.cached)
      total.output += Math.max(0, entry.output - entry.reasoning)
      total.cache_read += entry.cached
      total.cache_write += entry.write
      total.reasoning += entry.reasoning
      byModel.set(id, total)
    }
  }
  return [...byModel.keys()].sort().map((id) => {
    const { requests, ...tokens } = byModel.get(id)
    return { id, requests, tokens }
  })
}

function mergeCounts(target, source) {
  for (const [key, value] of source) target.set(key, (target.get(key) ?? 0) + value)
}

function resolveSessionsDir(codexHome) {
  const home = matching(/./u, codexHome, process.env.CODEX_HOME) ?? path.join(os.homedir(), ".codex")
  return path.join(home, "sessions")
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

/**
 * `deriveCodexSession({ rolloutPath, codexHome, plugins, endReason }) -> { facts, events }`, or `{ facts: null, events: null, reason }`.
 * `codexHome` defaults to `$CODEX_HOME`, then `~/.codex`. `maxThreads` (a test seam) lowers the cap on joined threads. Never throws.
 */
export async function deriveCodexSession(input) {
  try {
    const { rolloutPath, codexHome, plugins, endReason, maxThreads } = input
    if (typeof rolloutPath !== "string" || !existsSync(rolloutPath)) return { facts: null, events: null, reason: "log_missing" }
    return await derive({ rolloutPath, codexHome, plugins, endReason, maxThreads })
  } catch {
    return { facts: null, events: null, reason: "source_unreadable" }
  }
}

async function derive({ rolloutPath, codexHome, plugins, endReason, maxThreads }) {
  const rootMeta = metaOfFirstLine(await firstLine(rolloutPath))
  if (rootMeta === null || rootMeta.version === null) return { facts: null, events: null, reason: "source_unreadable" }
  const safeEndReason = endReason === null || ENUMS.endReason.includes(endReason) ? endReason : null

  const rootProcessor = createThreadProcessor({ agentIndex: 0, meta: { ...rootMeta, startOrdinal: null } })
  let truncatedAny = (await streamJsonl(rolloutPath, (line) => rootProcessor.pushLine(line))).truncated
  const rootResult = rootProcessor.finish()

  // Children are numbered in start order, so a run's numbering does not depend on folder listing order.
  const { joined, capped } = await findChildren(rootMeta, resolveSessionsDir(codexHome), rootResult.latest, maxThreads)
  joined.sort((a, b) => (a.meta.startedAt + a.meta.id < b.meta.startedAt + b.meta.id ? -1 : 1))
  const results = [rootResult]
  const numberOf = new Map([[rootMeta.id, 0]])
  for (const { file, meta } of joined) {
    const processor = createThreadProcessor({ agentIndex: results.length, meta })
    truncatedAny = (await streamJsonl(file, (line) => processor.pushLine(line))).truncated || truncatedAny
    numberOf.set(meta.id, results.length)
    results.push(processor.finish())
  }

  const agents = []
  const spawnTasks = []
  const intervals = []
  for (const [n, result] of results.entries()) {
    const agent = { n, parent: null, model: result.model }
    let spawnModel = null
    if (n > 0) {
      const parent = numberOf.get(result.meta.parent)
      const spawn = results[parent].spawnedChildren.get(result.meta.id)
      agent.parent = parent
      spawnModel = spawn?.model ?? null
      const agentType = result.meta.agentType ?? spawn?.agentType ?? null
      if (agentType !== null) agent.agent_type = agentType
      const task = spawn?.task ?? result.firstPromptTask
      if (task !== null) spawnTasks.push({ agent: n, track: task.track, slug: task.slug })
      intervals.push({ kind: "subagent", agent: parent, start: result.earliest, end: result.latest })
    }
    const requested = spawnModel ?? result.firstModel
    if (requested !== null && requested !== result.model) agent.requested_model = requested
    agents.push(agent)
    intervals.push(...result.intervals)
  }

  const toolCallCounts = new Map()
  const toolFailureCounts = new Map()
  let toolRetries = 0
  let compactions = 0
  for (const result of results) {
    mergeCounts(toolCallCounts, result.toolCallCounts)
    mergeCounts(toolFailureCounts, result.toolFailureCounts)
    toolRetries += result.toolRetries
    compactions += result.compactions
  }

  const unavailable = []
  if (safeEndReason === null) addUnavailable(unavailable, "ended_at", "session_open")
  const models = aggregateModels(results)
  if (models.length === 0 || results.some((result) => result.invalidModelSeen)) addUnavailable(unavailable, "models", "source_unreadable")
  if (results.some((result) => result.firstModel !== null && result.usage.size === 0)) addUnavailable(unavailable, "tokens", "source_unreadable")
  addUnavailable(unavailable, "permission_waits", "host_does_not_record")
  addUnavailable(unavailable, "api_retries", "host_does_not_record")
  addUnavailable(unavailable, "ci_runs", "not_collected_in_slice_1")
  addUnavailable(unavailable, "commits", "host_does_not_record")
  if (capped) addUnavailable(unavailable, "turns", "capped")
  if (truncatedAny) addUnavailable(unavailable, "turns", "log_truncated")
  if (results.some((result) => result.hadUnresolvedTurn)) addUnavailable(unavailable, "turns", safeEndReason === null ? "session_open" : "log_truncated")
  if (results.some((result) => result.hadUnresolvedCall)) addUnavailable(unavailable, "tool_durations", safeEndReason === null ? "session_open" : "log_truncated")
  if (results.some((result) => result.hadUnreadableTime)) {
    addUnavailable(unavailable, "turns", "source_unreadable")
    addUnavailable(unavailable, "tool_durations", "source_unreadable")
  }

  const limited = applyLimits({
    agents,
    intervals,
    models,
    prs: dedupePrRefs(results.flatMap((result) => result.prRefs)),
  }, unavailable)

  const facts = {
    schema: LOCAL_SCHEMA,
    session: {
      host: HOST,
      id: rootMeta.id,
      host_version: rootMeta.version,
      entrypoint: Object.hasOwn(ENTRYPOINTS, rootMeta.source) ? ENTRYPOINTS[rootMeta.source] : "unknown",
      started_at: rootResult.earliest,
      ended_at: safeEndReason !== null ? rootResult.latest : null,
      end_reason: safeEndReason,
      derived_through: rootResult.latest,
    },
    plugins: sanitizePlugins(plugins, LIMITS, unavailable),
    models: limited.models,
    agents: limited.agents,
    intervals: limited.intervals,
    counts: {
      tool_calls: Object.fromEntries(toolCallCounts),
      tool_failures: Object.fromEntries(toolFailureCounts),
      tool_retries: toolRetries,
      api_retries: 0,
      compactions,
    },
    refs: { prs: limited.prs, commits: [], unresolved: { prs: 0, commits: 0 } },
    jobs: [],
    unavailable,
  }

  const events = {
    deskToolCalls: results.flatMap((result) => result.deskToolCalls),
    fileWrites: results.flatMap((result) => result.fileWrites),
    commitShas: [],
    shellGitCommits: results.flatMap((result) => result.shellGitCommits),
    nativeCommitShas: [],
    spawnTasks,
  }

  return { facts, events }
}
