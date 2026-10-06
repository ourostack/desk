// The sign-off witness: how Desk knows a human turn stood behind a `task_signoff` call.
//
// A sign-off is a human's answer, and only the server may decide that it counts as one. The agent cannot write these records: hooks do, and the server reads them. Anything the witness cannot see is `unverified` with a reason code (`WITNESS_REASONS`); it never reads as accepted.
//
// Three pieces:
//   1. A session file, `<state>/signoff-witness/<digest of the session id>.json`, `{ prompt_at, stop_at, prompts }`, times in milliseconds. The prompt hook sets `prompt_at` and counts `prompts`; the stop hook sets `stop_at`, for the main agent only. A session with more than one prompt and no stop record lost its stop (the stop hook failed or was off), which is not the same as a first turn that has not stopped yet: it reads `no_stop_record`. A host's prompt hook also fires for a scheduled task, a background subagent reporting back and a message from another session, so `prompt_at` alone proves no human.
//   2. On Claude Code, a ticket. A `PreToolUse` hook on `task_signoff` denies a subagent's call, then reads the tail of the transcript for the last prompt-like root line and checks it carries `origin.kind: "human"`, and writes `<state>/signoff-ticket/<digest of track, slug, outcome>.json`. The server reads and deletes it; one older than two minutes is ignored.
//   3. On Copilot, no ticket: the server reads the session file by `COPILOT_AGENT_SESSION_ID` and checks the last `user.message` in the session's event log for a `source`.
//
// The verdict is `witnessVerdict`, one pure function.
//
// Copilot, v0: a subagent's `preToolUse` call cannot be told apart from the main agent's (the documented payload has no subagent marker), so `witnessFor` answers `mainAgent: null` there and every Copilot sign-off is unverified as `subagent_not_ruled_out`. The prompt and stop records and the `source` check are built and tested anyway. When a live probe finds a marker, change the one line in `witnessFor` that sets `mainAgent` for Copilot.
//
// The hooks fail quietly and always answer `{}` (except the one denial): a record that cannot be written means no witness, and no witness means unverified.

import { createHash } from "node:crypto"
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isHumanPromptLine } from "../factory/derive-claude.js"
import { detectAgentHost } from "./boot.js"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const WITNESS_DIR = "signoff-witness"
export const TICKET_DIR = "signoff-ticket"
export const TICKET_TTL_MS = 120000
/** The hook's own prompt record may be this much later than the human line it is checked against; more means a later turn that no human line accounts for has started. */
export const PROMPT_SKEW_MS = 30000
/** How long the ticket hook looks for the call's own `tool_use` line in the root transcript before it gives up, and how often it looks. */
export const MAIN_AGENT_WAIT_MS = 1500
const MAIN_AGENT_STEP_MS = 100
/** Every reason a verdict can give, `witnessed` first. */
export const WITNESS_REASONS = ["witnessed", "no_witness", "subagent", "subagent_not_ruled_out", "not_human_origin", "human_origin_unknown", "no_stop_record", "no_prompt_since_stop", "no_delivery_time", "same_turn_as_delivery"]

const STALE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const DENY_REASON = "Report what you found to the main agent; only the main agent may call task_signoff, which records the operator's answer."

const hasText = (value) => typeof value === "string" && value !== ""
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const digest = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32)
const asTime = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null)

/** The session file for a session: a digest of its id, so no id can name another path. */
export function witnessFile(stateDir, sessionId) {
  return path.join(stateDir, WITNESS_DIR, `${digest(String(sessionId))}.json`)
}

/** The ticket file for one outcome of one task: a digest of the three, so no task text is in a name. */
export function ticketFile(stateDir, { track, slug, outcome }) {
  return path.join(stateDir, TICKET_DIR, `${digest(JSON.stringify([String(track), String(slug), String(outcome)]))}.json`)
}

// A file may vanish between the listing and the check (another session's hook pruning it): each one is judged on its own.
function pruneStale(dir, now) {
  for (const name of readdirSync(dir)) {
    try {
      const file = path.join(dir, name)
      if (now - statSync(file).mtimeMs > STALE_MS) unlinkSync(file)
    } catch {
      // Gone already, or not ours to remove.
    }
  }
}

function writeRecord(file, record, now) {
  assertNotRealStateUnderTest(path.dirname(path.dirname(file)))
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  renameSync(temp, file)
  pruneStale(path.dirname(file), now)
}

function readJson(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

function readSession(stateDir, sessionId) {
  const record = readJson(witnessFile(stateDir, sessionId))
  return { prompt_at: asTime(record?.prompt_at), stop_at: asTime(record?.stop_at), prompts: Number.isSafeInteger(record?.prompts) && record.prompts > 0 ? record.prompts : 0 }
}

// More than one prompt and no stop record: a stop the hook should have recorded is missing.
const stopMissing = (session) => session.prompts > 1 && session.stop_at === null

function setField(field, payload, { env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now } = {}) {
  try {
    if (!hasText(payload?.session_id)) return {}
    const at = now()
    const session = readSession(stateDir, payload.session_id)
    writeRecord(witnessFile(stateDir, payload.session_id), { ...session, [field]: at, ...(field === "prompt_at" ? { prompts: session.prompts + 1 } : {}) }, at)
  } catch {
    // No record means no witness, which is unverified: fail closed for the sign-off, quiet for the turn.
  }
  return {}
}

/** UserPromptSubmit / userPromptSubmitted: a prompt reached the session. Sets `prompt_at`. Returns `{}` always; `payload` is read for its session id only. */
export function recordPrompt(payload, options) {
  return setField("prompt_at", payload, options)
}

/** Stop / agentStop: the main agent stopped. Sets `stop_at`; does nothing for a subagent's stop. Returns `{}` always. */
export function recordStop(payload, options) {
  if (payload?.hook_event_name === "SubagentStop" || hasText(payload?.agent_id)) return {}
  return setField("stop_at", payload, options)
}

// ---------------------------------------------------------------------------
// Reading the host's own log
// ---------------------------------------------------------------------------

/** The last `maxBytes` of a file as lines, the first one dropped when the read began inside a line. Null when the file cannot be read. */
function tailLines(file, maxBytes) {
  if (!hasText(file)) return null
  let fd
  try {
    fd = openSync(file, "r")
  } catch {
    return null
  }
  let lines = null
  try {
    const size = fstatSync(fd).size
    const length = Math.min(size, maxBytes)
    const buffer = Buffer.alloc(length)
    readSync(fd, buffer, 0, length, size - length)
    const all = buffer.toString("utf8").split("\n")
    lines = size > length ? all.slice(1) : all
  } catch {
    // A folder, or a file that vanished: nothing to read.
  }
  closeSync(fd)
  return lines
}

function parseLine(raw) {
  try {
    const parsed = JSON.parse(raw)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

const has = (line, key) => Object.hasOwn(line, key)
// A key that says who started the turn.
const hasTurnMark = (line) => has(line, "turnOrigin") || has(line, "origin") || has(line, "scheduledTaskId") || has(line, "scheduledFireId")

// A root user line that starts a turn: not a subagent's, not a compaction summary, not made only of tool results, and not plain hook output. A meta line that carries a turn mark (a scheduled wake-up, a message from another session) does start one.
function startsTurn(line) {
  if (line.type !== "user" || line.isSidechain === true || line.isCompactSummary === true) return false
  if (line.isMeta === true && !hasTurnMark(line)) return false
  const content = line.message?.content
  return !(Array.isArray(content) && content.length > 0 && content.every((block) => block?.type === "tool_result"))
}

// Whether the turn-starting line is a human's: true, false when any mark says otherwise, null when it carries no mark at all.
function humanMark(line) {
  if (line.isMeta === true || has(line, "scheduledTaskId") || has(line, "scheduledFireId")) return false
  const kind = line.origin?.kind
  if (typeof kind === "string" && kind !== "human") return false
  if (has(line, "turnOrigin") && line.turnOrigin !== "human") return false
  if (line.promptSource === "system") return false
  return kind === "human" ? isHumanPromptLine(line) : null
}

/**
 * `{ human, at }` for the last turn-starting root `user` line in the tail of a Claude Code transcript (see `startsTurn`).
 * `human` is true only when the line is not meta, `origin.kind` is exactly `"human"`, `turnOrigin` is `"human"` or absent, `promptSource` is not `"system"`, it has no scheduled id and it passes `isHumanPromptLine`. It is false when the line carries any mark that says otherwise (a meta line with a turn mark, another origin or turn origin, a scheduled id, `promptSource: "system"`), and null when it carries no mark at all (the interrupt marker, an old-format line), when the file is unreadable, when no such line is in the tail or when its time does not parse. `at` is the line's own time in milliseconds, or null.
 * It parses each line and keeps only what it returns.
 */
export function lastHumanPrompt(transcriptPath, { maxBytes = MAX_TRANSCRIPT_BYTES } = {}) {
  const lines = tailLines(transcriptPath, maxBytes)
  let result = { human: null, at: null }
  for (const raw of lines ?? []) {
    const line = parseLine(raw)
    if (line === null || !startsTurn(line)) continue
    const parsed = typeof line.timestamp === "string" ? Date.parse(line.timestamp) : Number.NaN
    const at = Number.isFinite(parsed) ? parsed : null
    result = { human: at === null ? null : humanMark(line), at }
  }
  return result
}

/**
 * Whether the last `user.message` in a Copilot session's event log is a human's: true when it has no `source` and is not an autopilot continuation, false when it has one, null when the log cannot be read or holds no such message.
 * The log is `<COPILOT_HOME or ~/.copilot>/session-state/<session id>/events.jsonl`. `homeDir`, `eventsPath` and `maxBytes` are for tests.
 */
export function copilotLastPromptIsHuman(sessionId, { env, homeDir = os.homedir(), eventsPath, maxBytes = MAX_TRANSCRIPT_BYTES }) {
  if (!hasText(sessionId) || !/^[\w.-]+$/u.test(sessionId) || sessionId === "." || sessionId === "..") return null
  const file = eventsPath ?? path.join(hasText(env?.COPILOT_HOME) ? env.COPILOT_HOME : path.join(homeDir, ".copilot"), "session-state", sessionId, "events.jsonl")
  let human = null
  for (const raw of tailLines(file, maxBytes) ?? []) {
    const event = parseLine(raw)
    if (event?.type !== "user.message") continue
    const data = isObject(event.data) ? event.data : {}
    human = data.source === undefined && data.isAutopilotContinuation !== true
  }
  return human
}

// ---------------------------------------------------------------------------
// The ticket
// ---------------------------------------------------------------------------

function removeTicket(stateDir, input) {
  try {
    if (isObject(input) && hasText(input.track) && hasText(input.slug) && hasText(input.outcome)) unlinkSync(ticketFile(stateDir, input))
  } catch {
    // None to remove.
  }
}

// True when a root (not sidechain) assistant line in the transcript tail holds a `tool_use` block with this id. It compares ids only and keeps nothing.
function rootHoldsToolUse(transcriptPath, toolUseId, maxBytes) {
  for (const raw of tailLines(transcriptPath, maxBytes) ?? []) {
    const line = parseLine(raw)
    if (line?.type !== "assistant" || line.isSidechain === true || !Array.isArray(line.message?.content)) continue
    if (line.message.content.some((block) => block?.type === "tool_use" && block.id === toolUseId)) return true
  }
  return false
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

// The proof that the main agent made the call: its own transcript holds the call. A subagent's call is written to the subagent's own file, so it cannot produce this. The host may write the line just after the hook starts, so the tail is read again for up to `MAIN_AGENT_WAIT_MS`. True, or null (not proven) — never false.
function mainAgentProof(payload, { clock, sleep, maxBytes }) {
  if (!hasText(payload?.tool_use_id)) return null
  const start = clock()
  for (;;) {
    if (rootHoldsToolUse(payload.transcript_path, payload.tool_use_id, maxBytes)) return true
    if (clock() - start >= MAIN_AGENT_WAIT_MS) return null
    sleep(MAIN_AGENT_STEP_MS)
  }
}

/**
 * PreToolUse on `task_signoff` (Claude Code). A subagent's call (a payload with a non-empty `agent_id`, or a Subagent hook event) is denied; no ticket is written and none is removed. Any other call replaces the ticket for its task and outcome and gets the answer `{}`.
 * The ticket's `main_agent` is true only on proof: no `agent_id`, and the root transcript holds this call's `tool_use` id (`tool_use_id` in the payload). Otherwise it is null, which the verdict reads as `subagent_not_ruled_out`.
 * The ticket's `prompt_at` is the human line's own time; it is null when the prompt hook left no record (hooks off). If the hook's record is more than `PROMPT_SKEW_MS` later than that line, a later turn that no human line accounts for has started, so `human_origin` is false.
 * `stateDir`, `now`, `clock`, `sleep` and `maxBytes` are for tests.
 */
export function issueTicket(payload, { env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now, clock = Date.now, sleep = sleepSync, maxBytes = MAX_TRANSCRIPT_BYTES } = {}) {
  // A subagent's call is denied here, so it never reaches the server and cannot use a ticket: it leaves the main agent's waiting ticket for the same task and outcome alone.
  if (hasText(payload?.agent_id) || /^Subagent/u.test(String(payload?.hook_event_name ?? ""))) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: DENY_REASON } }
  }
  // Whatever else happens to this call, an older ticket for the same task and outcome must not outlive it: it would verify a later call that has no hook of its own.
  removeTicket(stateDir, payload?.tool_input)
  try {
    const input = payload?.tool_input
    if (!hasText(payload?.session_id) || !isObject(input) || !hasText(input.track) || !hasText(input.slug) || !hasText(input.outcome)) return {}
    const session = readSession(stateDir, payload.session_id)
    const prompt = lastHumanPrompt(payload.transcript_path)
    let humanOrigin = prompt.human
    if (session.prompt_at !== null && prompt.at !== null && session.prompt_at - prompt.at > PROMPT_SKEW_MS) humanOrigin = false
    const at = now()
    const ticket = {
      issued_at: at,
      prompt_at: session.prompt_at === null ? null : prompt.at,
      stop_at: session.stop_at,
      ...(stopMissing(session) ? { stop_missing: true } : {}),
      main_agent: mainAgentProof(payload, { clock, sleep, maxBytes }),
      human_origin: humanOrigin,
    }
    writeRecord(ticketFile(stateDir, input), ticket, at)
  } catch {
    // No ticket means no witness.
  }
  return {}
}

// Reads the ticket and deletes it, so a ticket serves one call. Null when there is none, when it is older than the time to live or when it is not a ticket.
function takeTicket(stateDir, task, now) {
  // Rename first: only one reader can move the file, so a ticket serves one call even when two servers look at once.
  const file = `${ticketFile(stateDir, task)}.${process.pid}.taken`
  let ticket = null
  try {
    renameSync(ticketFile(stateDir, task), file)
    ticket = readJson(file)
    unlinkSync(file)
  } catch {
    // None to take, or already taken.
  }
  const issuedAt = asTime(ticket?.issued_at)
  if (issuedAt === null || now - issuedAt > TICKET_TTL_MS) return null
  return {
    promptAt: asTime(ticket.prompt_at),
    stopAt: asTime(ticket.stop_at),
    // Present only when true; a ticket from before this field reads as not missing: it was written by a hook that could not tell.
    ...(ticket.stop_missing === true ? { stopMissing: true } : {}),
    mainAgent: typeof ticket.main_agent === "boolean" ? ticket.main_agent : null,
    humanOrigin: typeof ticket.human_origin === "boolean" ? ticket.human_origin : null,
  }
}

/**
 * What the server knows about the turn behind a `task_signoff` call: `{ promptAt, stopAt, stopMissing?, mainAgent, humanOrigin }` (`stopMissing` only when true), or null when nothing witnessed it (Codex, hooks off, no ticket, an expired ticket).
 * Claude Code: reads and deletes the ticket for this task and outcome. Copilot (`COPILOT_AGENT_SESSION_ID` set): reads the session file and the event log instead, with `mainAgent: null`.
 * `copilotOptions` reaches `copilotLastPromptIsHuman` in tests.
 */
export function witnessFor({ env, stateDir = resolveDeskStateDir({ env }), track, slug, outcome, now, copilotOptions = {} }) {
  const sessionId = env?.COPILOT_AGENT_SESSION_ID
  if (hasText(sessionId)) {
    if (readJson(witnessFile(stateDir, sessionId)) === null) return null
    const session = readSession(stateDir, sessionId)
    // The one line to change when a Copilot subagent marker is proven: set `mainAgent` from it.
    return { promptAt: session.prompt_at, stopAt: session.stop_at, ...(stopMissing(session) ? { stopMissing: true } : {}), mainAgent: null, humanOrigin: copilotLastPromptIsHuman(sessionId, { env, ...copilotOptions }) }
  }
  // A ticket is read only when this server runs under Claude Code, the one host whose hook writes it. On any other host it is left alone, so a ticket left behind by a call that never reached the server cannot verify a call from a host with no hooks. Known limit: a server on another host that was started from inside a Claude Code shell inherits the Claude mark.
  if (detectAgentHost(env) !== "claude") return null
  if (!hasText(track) || !hasText(slug) || !hasText(outcome)) return null
  return takeTicket(stateDir, { track, slug, outcome }, now())
}

/**
 * Whether a human turn stood behind the sign-off: `{ verified, why }`. The caller passes the times in milliseconds: `deliveredAt` from the card's ISO time as `Date.parse` gives it, not rounded down to the second (a delivery a moment after the human line could then read as before it). A time that is not a number reads as not before the prompt, so a wiring mistake fails closed as `same_turn_as_delivery`. A `deliveredAt` that is absent (a card with no readable delivery time) is `no_delivery_time`, and `stopMissing` (the session lost a stop record) is `no_stop_record`: neither check is skipped (fail closed, ruling 2026-10-06). Verified only when `promptAt` is a finite number, `stopMissing` is not true, `stopAt` is absent or below it, `deliveredAt` is below it, `mainAgent` is exactly true and `humanOrigin` is exactly true. `why` is the first reason that applies, in the order of `WITNESS_REASONS` after `witnessed`.
 */
export function witnessVerdict(witness) {
  const { promptAt, stopAt, stopMissing: lost, deliveredAt, mainAgent, humanOrigin } = witness ?? {}
  const absent = (value) => value === undefined || value === null
  const below = (value) => typeof value === "number" && value < promptAt
  let why = "witnessed"
  if (typeof promptAt !== "number" || !Number.isFinite(promptAt)) why = "no_witness"
  else if (mainAgent === false) why = "subagent"
  else if (mainAgent !== true) why = "subagent_not_ruled_out"
  else if (humanOrigin === false) why = "not_human_origin"
  else if (humanOrigin !== true) why = "human_origin_unknown"
  else if (lost === true) why = "no_stop_record"
  else if (!absent(stopAt) && !below(stopAt)) why = "no_prompt_since_stop"
  else if (absent(deliveredAt)) why = "no_delivery_time"
  else if (!below(deliveredAt)) why = "same_turn_as_delivery"
  return { verified: why === "witnessed", why }
}
