// The done-claim gate: a Stop hook that stops a reply saying "Done." over a task card that is not done.
//
// Five acceptance rounds (B to F) ended with a final reply that opened "Done." or "Work complete" while the task the agent had just updated stood at `processing` or `validating`. `task_update` already answers with `report_as` and a warning, and agents ignore both. This gate sits where the agent cannot: after the reply is written, before the turn ends.
//
// Two hooks share this module:
//   - `recordTouchedTask` (PostToolUse on task_update, task_create, task_move and task_archive) notes which task this session touched and the status the call left it at, in a session-scoped file under Desk's state folder.
//   - `doneClaimStopHook` (Stop) reads the final reply (`last_assistant_message`, else the last assistant message of the transcript) and blocks once, with a reason, when all of these hold: this session touched a task whose status is not done; the reply says the task or the work is done; and the reply never states the task's real status.
//
// It fails open everywhere: a missing transcript, an unreadable or malformed state file, a parse error or a write error lets the turn end. A child agent's stop (SubagentStop, or a payload carrying an agent id) is never gated, and `stop_hook_active` (the hook already blocked this stop) ends the loop.
//
// Claude Code only today. Copilot has `agentStop` and Codex has a stop event, but Desk has not verified that either can block a reply or hands over the transcript, so there the rule stays the agent's to keep (see the hooks section of the plugin README and the task-lifecycle skill).

import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const DONE_GATE_DIR = "done-gate"
const TERMINAL = new Set(["done", "cancelled"])
const STALE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const TASK_TOOL = /(?:^|__)task_(update|create|move|archive)$/u

// ---------------------------------------------------------------------------
// Session-scoped state
// ---------------------------------------------------------------------------

/** The state file for a session: a digest of its id, so no id can name another path. */
export function sessionFile(stateDir, sessionId) {
  return path.join(stateDir, DONE_GATE_DIR, `${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32)}.json`)
}

function readState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed !== null && typeof parsed === "object" && parsed.tasks !== null && typeof parsed.tasks === "object" && !Array.isArray(parsed.tasks) ? parsed : { tasks: {} }
  } catch {
    return { tasks: {} }
  }
}

function pruneStale(dir, now) {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name)
    if (now - statSync(file).mtimeMs > STALE_MS) unlinkSync(file)
  }
}

// ---------------------------------------------------------------------------
// What a task tool call left behind
// ---------------------------------------------------------------------------

/** The text of a tool response, whatever its shape: a string, a content-block array, `{ content }` or `{ structuredContent }`. */
function responseText(response) {
  if (typeof response === "string") return response
  if (Array.isArray(response)) return response.map((part) => (typeof part === "string" ? part : responseText(part))).join("\n")
  if (response === null || typeof response !== "object") return ""
  if (typeof response.text === "string") return response.text
  if (response.content !== undefined) return responseText(response.content)
  return response.structuredContent === undefined ? "" : JSON.stringify(response.structuredContent)
}

function parseJson(text) {
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * What one task tool call says about the task it touched: `{ key, slug, status, reportAs }`, or null when the call failed or names no task.
 * The status is the one the call left the card at: the `report_as` sentence of an unfinished `task_update` ("Task x is at validating (not done): ..."), the status a `task_create` was given, `done` for an accepted move to done or an archive, and null when the call does not say (a `task_move`, or a plain update with no status change).
 */
export function touchedTask(toolName, input, response) {
  const kind = TASK_TOOL.exec(String(toolName ?? ""))?.[1]
  if (kind === undefined) return null
  const text = responseText(response)
  const result = parseJson(text)
  if (result === null || result.status === "failed" || result.error !== undefined) return null
  const [track, slugFromPath] = typeof result.path === "string" ? result.path.split("/") : []
  const slug = typeof input?.slug === "string" && input.slug !== "" ? input.slug : slugFromPath
  if (typeof slug !== "string" || slug === "") return null
  const key = `${typeof input?.track === "string" && input.track !== "" ? input.track : (track ?? "")}/${slug}`
  const said = typeof result.report_as === "string" ? /\bis at ([a-z]+)\b/u.exec(result.report_as)?.[1] : undefined
  const asked = input?.status ?? input?.frontmatter?.status
  let status = null
  if (said !== undefined) status = said
  else if (kind === "archive") status = input?.outcome === "cancelled" ? "cancelled" : "done"
  else if (kind === "create") status = typeof asked === "string" && asked !== "" ? asked : "drafting"
  else if (kind === "update" && typeof asked === "string") status = asked
  return { key, slug, status, reportAs: typeof result.report_as === "string" ? result.report_as : null }
}

/**
 * PostToolUse: note the task this call touched in the session's state file. Returns `{}` always; a failure is swallowed (the gate fails open).
 * `options.stateDir` and `options.now` are for tests.
 */
export function recordTouchedTask(payload, { env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now } = {}) {
  try {
    const touched = touchedTask(payload?.tool_name, payload?.tool_input, payload?.tool_response)
    if (touched === null || typeof payload?.session_id !== "string" || payload.session_id === "") return {}
    assertNotRealStateUnderTest(stateDir)
    const file = sessionFile(stateDir, payload.session_id)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const state = readState(file)
    const before = state.tasks[touched.key]
    // A call that does not say the status (a move) keeps what the session last knew.
    state.tasks[touched.key] = { slug: touched.slug, status: touched.status ?? before?.status ?? null, report_as: touched.reportAs ?? (touched.status === null ? before?.report_as : null) ?? null }
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
    renameSync(temp, file)
    pruneStale(path.dirname(file), now())
  } catch {
    // Fail open: nothing recorded means nothing gated.
  }
  return {}
}

// ---------------------------------------------------------------------------
// What the reply says
// ---------------------------------------------------------------------------

// A claim is negated or conditional only by a word in a short window just before its verb, as in the acceptance harness.
const NEGATION = /\b(?:not|never|nothing|none|neither|fail(?:ed|s|ure)?|unable|unreachable|couldn'?t|can'?t|cannot|didn'?t|doesn'?t|don'?t|wasn'?t|isn'?t|aren'?t|hasn'?t|haven'?t|won'?t|without|still needs?|yet to)\b|n['’]t\b/iu
const CONDITIONAL = /\b(?:until|once|when|if|will|would|should|ready to)\b/iu
const WINDOW_CHARS = 30

// The ways a reply says the task, or the work, is done. "Done reading the card", "I'm done for now" and "done with step 2" are none of them.
const DONE_CLAIMS = [
  /\b(?:the|this|my|our)\s+(?:task|job|ticket)\s+(?:(?:is|was|has been|have been|now|is now|is all)\s+)?(?:done|complete[d]?|finished)\b/iu,
  /(?:^|[\n"'`(:]|\.\s)\s*(?:task|job|ticket)\s+(?:done|complete[d]?|finished)\b/iu,
  /\b(?:completed|finished|done with)\b[^.\n]{0,25}\b(?:the |this )?(?:task|job|ticket)\b/iu,
  /\b(?:finished|completed)\s+(?:all\s+(?:of\s+)?)?(?:the|this|my|our)\s+work\b/iu,
  /\b(?:the|this|my|our|all(?:\s+the)?)\s+work\s+(?:is|was|has been)\s+(?:now\s+|all\s+)?(?:done|complete[d]?|finished)\b/iu,
  /(?:^|[\n"'`(:]|\.\s)\s*work\s+(?:is\s+|was\s+)?(?:now\s+)?(?:done|complete[d]?|finished)\b/iu,
  /\bimplementation\s+(?:is|was|are|has been)\s+(?:now\s+|all\s+)?(?:done|complete[d]?|finished)\b/iu,
  /\bsuccessfully completed\b/iu,
  /\b(?:all|everything)\b[^.\n]{0,20}\b(?:done|complete[d]?)\b/iu,
  /\bCompleted work\b/u,
  // A reply that opens with the word: "Done.", "**Done.**", "Completed. Tests pass", "✓ Done: wired the check".
  /^[\s*_#>"'`\-✓✔✅☑•]*(?:all\s+done|done|completed?|finished)\b[\s*_"'`]*(?:[.!—–-]|:(?![\s*_"'`]*$)|$)/iu,
]

// A clause that reports where the task really is, cut out before the sentence is judged: "moved it to validating", "status: validating", "is at validating (not done)".
const STATUS = "(?:validating|processing|drafting|collaborating|paused|blocked)"
const STATUS_CLAUSES = [
  new RegExp(`\\b(?:transitioned|moved)\\s+(?:(?:the\\s+)?task\\s+|it\\s+)?to\\s+[\`*"']*${STATUS}\\b[\`*"']*`, "giu"),
  new RegExp(`\\bstatus\\s*(?:is|:)\\s*[\`*"']*${STATUS}\\b[\`*"']*`, "giu"),
  new RegExp(`\\bis\\s+at\\s+[\`*"']*${STATUS}\\b[\`*"']*\\s*\\(not done\\)`, "giu"),
]

const sentencesOf = (text) => String(text).split(/(?<=[.?!])\s+|\n+/u).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "")

function standing(sentence) {
  return DONE_CLAIMS.some((pattern) => {
    const match = pattern.exec(sentence)
    if (match === null) return false
    const before = sentence.slice(Math.max(0, match.index - WINDOW_CHARS), match.index + match[0].length)
    // A condition may also follow: "complete once the PR merges".
    const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + WINDOW_CHARS)
    return !NEGATION.test(before) && !CONDITIONAL.test(before) && !CONDITIONAL.test(after)
  })
}

/** The sentences of `text` that say the task or the work is done or complete (negated, conditional and explicit status clauses left out). */
export function doneClaims(text) {
  return sentencesOf(text).filter((sentence) => standing(STATUS_CLAUSES.reduce((rest, clause) => rest.replace(clause, " "), sentence)))
}

/** Whether `text` names `status` as a word (the task's real status stated anywhere in the reply). */
export function statesStatus(text, status) {
  return new RegExp(`(?<![\\w-])${status.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`, "iu").test(text)
}

// ---------------------------------------------------------------------------
// The Stop hook
// ---------------------------------------------------------------------------

/** The text of the last assistant message of a transcript (JSONL): every text block after the last user entry. Null when there is none. */
export function lastAssistantText(transcript) {
  const lines = transcript.split("\n")
  const parts = []
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseJson(lines[index])
    if (entry === null) continue
    if (entry.type === "user") break
    if (entry.type !== "assistant" || !Array.isArray(entry.message?.content)) continue
    const texts = entry.message.content.filter((block) => block?.type === "text" && typeof block.text === "string").map((block) => block.text)
    if (texts.length > 0) parts.unshift(texts.join("\n"))
  }
  return parts.length === 0 ? null : parts.join("\n")
}

/**
 * The reply being stopped on. Claude Code puts it in the payload as `last_assistant_message`, and that is the source to trust: a live run (round 13) showed the transcript file does not yet hold the final message when the Stop hook runs, so reading it alone saw no reply and let "Done." through. The transcript is the fallback, for a host that sends no such field.
 */
function finalReply(payload) {
  if (typeof payload.last_assistant_message === "string" && payload.last_assistant_message.trim() !== "") return payload.last_assistant_message
  if (typeof payload.transcript_path !== "string" || statSync(payload.transcript_path).size > MAX_TRANSCRIPT_BYTES) return null
  return lastAssistantText(readFileSync(payload.transcript_path, "utf8"))
}

/**
 * Stop: `{ decision: "block", reason }` when the reply says done over a task this session touched that is not done and the reply never states that task's status; `{}` otherwise, and on any error.
 * `options.stateDir` is for tests.
 */
export function doneClaimStopHook(payload, { env = process.env, stateDir = resolveDeskStateDir({ env }) } = {}) {
  try {
    if (payload?.stop_hook_active === true || payload?.hook_event_name === "SubagentStop" || typeof payload?.agent_id === "string") return {}
    if (typeof payload?.session_id !== "string" || payload.session_id === "") return {}
    const open = Object.values(readState(sessionFile(stateDir, payload.session_id)).tasks).filter((task) => typeof task?.status === "string" && task.status !== "" && !TERMINAL.has(task.status) && typeof task.slug === "string")
    if (open.length === 0) return {}
    const reply = finalReply(payload)
    if (reply === null || doneClaims(reply).length === 0) return {}
    const unstated = open.filter((task) => !statesStatus(reply, task.status))
    if (unstated.length === 0) return {}
    const [task] = unstated
    const reportAs = typeof task.report_as === "string" && task.report_as !== "" ? ` (task_update returned report_as: ${JSON.stringify(task.report_as)})` : ""
    return { decision: "block", reason: `Your reply says the work is done, but task ${task.slug} is at ${task.status}. Restate the reply with the task's real status${reportAs}.` }
  } catch {
    return {}
  }
}
