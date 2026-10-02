// The done-claim gate: a Stop hook that stops a reply saying "Done." over a task card that is not done.
//
// Five acceptance rounds (B to F) ended with a final reply that opened "Done." or "Work complete" while the task the agent had just updated stood at `processing` or `validating`. `task_update` already answers with `report_as` and a warning, and agents ignore both. This gate sits where the agent cannot: after the reply is written, before the turn ends.
//
// Three hooks share this module:
//   - `recordTouchedTask` (PostToolUse on task_update, task_create, task_move and task_archive) notes which task this call touched, in a session-scoped file under Desk's state folder. A `task_move` replaces the entry under the old key.
//   - `clearTouchedTasks` (UserPromptSubmit) starts a new turn: the file is removed, so a task touched in an earlier turn never gates a later reply.
//   - `doneClaimStopHook` (Stop) blocks once, with a reason, when all of these hold: this turn touched a task whose card, read again now, is not done or cancelled; the reply says the task or the work is done; and the reply never states that task's real status in a status clause. A Stop that does not block also clears the turn's tasks.
//
// Scope is the turn: from the last prompt (or the last Stop that let the reply through) to this Stop. The state is last-writer-wins when two task calls run at once (the update is under a lock file and retries briefly, then goes ahead without it); the only failure that can come of it is a missed gate, never a wrong block.
//
// It fails open everywhere: a missing transcript, an unreadable or malformed state file, an unreadable card, a parse error or a write error lets the turn end. A child agent's stop (SubagentStop, or a payload carrying an agent id) is never gated, and `stop_hook_active` (the hook already blocked this stop) ends the loop.
//
// Claude Code and Copilot CLI. Copilot's `postToolUse`, `userPromptSubmitted` and `agentStop` hooks carry the same session id, and `agentStop` takes the same `{ decision: "block", reason }` (it makes Copilot continue with the reason as a follow-up message, and the next stop carries `stop_hook_active`); `runtime/copilot-hook-payload.js` maps the payloads, and `copilotStopHook` below reads the reply from the session transcript, which Copilot writes just after the hook starts. Codex has a stop event, but Desk has not verified that it can block a reply or hands over the transcript, and its hooks are not trusted by default, so there the rule stays the agent's to keep (see the hooks section of the plugin README and the task-lifecycle skill).

import { createHash } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveHookDeskRoot } from "../../scripts/resolve-desk-root.js"
import { claudeShapedPayload, copilotFinalReply } from "./copilot-hook-payload.js"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const DONE_GATE_DIR = "done-gate"
const TERMINAL = new Set(["done", "cancelled"])
const STALE_MS = 7 * 24 * 60 * 60 * 1000
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024
const TASK_TOOL = /(?:^|__)task_(update|create|move|archive)$/u
const LOCK_STALE_MS = 5000

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

function removeFile(file) {
  try {
    unlinkSync(file)
  } catch {
    // Already gone, or not ours to remove: either way nothing is left to gate on.
  }
}

// A file may vanish between the listing and the check (another session's hook pruning it): each one is judged on its own.
function pruneStale(dir, now) {
  for (const name of readdirSync(dir)) {
    try {
      const file = path.join(dir, name)
      if (now - statSync(file).mtimeMs > STALE_MS) unlinkSync(file)
    } catch {
      // ENOENT or a file we cannot remove: skip it.
    }
  }
}

/** Runs `work` holding `<file>.lock` (an O_EXCL file). A lock older than five seconds is broken; after `waitMs` the work goes ahead without the lock. */
function withLock(file, work, { waitMs = 1000, sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) } = {}) {
  const lock = `${file}.lock`
  let held = false
  for (let waited = 0; !held && waited <= waitMs; waited += 20) {
    try {
      closeSync(openSync(lock, "wx"))
      held = true
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) unlinkSync(lock)
        else sleep(20)
      } catch {
        // The lock vanished between the two calls: try again at once.
      }
    }
  }
  try {
    return work()
  } finally {
    if (held) removeFile(lock)
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
 * What one task tool call says about the task it touched: `{ key, slug, status, reportAs, path, oldKey }`, or null when the call failed or names no task.
 * `key` is the card's folder under the desk (`track/slug`, from the result path), so a moved or archived card is a different key; `oldKey` is the key a `task_move` or `task_archive` left behind (from the call's own track and slug), or null.
 * The status is the one the call left the card at: the `report_as` sentence of an unfinished `task_update` ("Task x is at validating (not done): ..."), the status a `task_create` was given, `done` or `cancelled` for an archive, and null when the call does not say (a `task_move`, or a plain update with no status change).
 */
export function touchedTask(toolName, input, response) {
  const kind = TASK_TOOL.exec(String(toolName ?? ""))?.[1]
  if (kind === undefined) return null
  const result = parseJson(responseText(response))
  if (result === null || result.status === "failed" || result.error !== undefined) return null
  const cardPath = typeof result.path === "string" && result.path !== "" ? result.path : null
  const parts = cardPath === null ? [] : cardPath.split("/").slice(0, -1).filter((part) => part !== "_archive")
  const slug = typeof input?.slug === "string" && input.slug !== "" ? input.slug : parts.at(-1)
  if (typeof slug !== "string" || slug === "") return null
  const inputKey = `${typeof input?.track === "string" ? input.track : ""}/${slug}`
  const key = cardPath === null ? inputKey : path.posix.dirname(cardPath)
  const said = typeof result.report_as === "string" ? /\bis at ([a-z]+)\b/u.exec(result.report_as)?.[1] : undefined
  const asked = input?.status ?? input?.frontmatter?.status
  let status = null
  if (said !== undefined) status = said
  else if (kind === "archive") status = input?.outcome === "cancelled" ? "cancelled" : "done"
  else if (kind === "create") status = typeof asked === "string" && asked !== "" ? asked : "drafting"
  else if (kind === "update" && typeof asked === "string") status = asked
  const oldKey = (kind === "move" || kind === "archive") && inputKey !== key && typeof input?.track === "string" ? inputKey : null
  return { key, slug, status, reportAs: typeof result.report_as === "string" ? result.report_as : null, path: cardPath, oldKey }
}

/**
 * PostToolUse: note the task this call touched in the session's state file. Returns `{}` always; a failure is swallowed (the gate fails open).
 * `options` (`stateDir`, `now`, `root`, `lock`) are for tests.
 */
export function recordTouchedTask(payload, { env = process.env, stateDir = resolveDeskStateDir({ env }), now = Date.now, root, lock } = {}) {
  try {
    const touched = touchedTask(payload?.tool_name, payload?.tool_input, payload?.tool_response)
    if (touched === null || typeof payload?.session_id !== "string" || payload.session_id === "") return {}
    assertNotRealStateUnderTest(stateDir)
    const file = sessionFile(stateDir, payload.session_id)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const deskRoot = root === undefined ? resolveHookDeskRoot({ env, cwd: typeof payload.cwd === "string" ? payload.cwd : process.cwd() }).root : root
    withLock(file, () => {
      const state = readState(file)
      const before = state.tasks[touched.oldKey ?? touched.key] ?? state.tasks[touched.key]
      if (touched.oldKey !== null) delete state.tasks[touched.oldKey]
      // A call that does not say the status (a move) keeps what the session last knew.
      state.tasks[touched.key] = { slug: touched.slug, status: touched.status ?? before?.status ?? null, report_as: touched.reportAs ?? (touched.status === null ? before?.report_as : null) ?? null, root: deskRoot ?? null, path: touched.path }
      const temp = `${file}.${process.pid}.tmp`
      writeFileSync(temp, `${JSON.stringify(state)}\n`, { mode: 0o600 })
      renameSync(temp, file)
    }, lock)
    pruneStale(path.dirname(file), now())
  } catch {
    // Fail open: nothing recorded means nothing gated.
  }
  return {}
}

/** UserPromptSubmit: a new turn begins, so the tasks of the last one no longer count. Returns `{}` always. */
export function clearTouchedTasks(payload, { env = process.env, stateDir = resolveDeskStateDir({ env }) } = {}) {
  if (typeof payload?.session_id === "string" && payload.session_id !== "") removeFile(sessionFile(stateDir, payload.session_id))
  return {}
}

// ---------------------------------------------------------------------------
// What the reply says
// ---------------------------------------------------------------------------

// A claim is negated or conditional only by a word in a short window just before its verb, as in the acceptance harness.
const NEGATION = /\b(?:not|never|nothing|none|neither|fail(?:ed|s|ure)?|unable|unreachable|couldn'?t|can'?t|cannot|didn'?t|doesn'?t|don'?t|wasn'?t|isn'?t|aren'?t|hasn'?t|haven'?t|won'?t|without|still needs?|yet to)\b|n['’]t\b/iu
const CONDITIONAL = /\b(?:until|once|when|if|will|would|should|ready to)\b/iu
const WINDOW_CHARS = 30
const DONE_WORD = "(?:done|complete[d]?|finished)"

/**
 * The ways a reply says the task, or the work, is done. The acceptance harness uses these same patterns (and adds a few of its own), so the two agree.
 * Deliberately not claims: "Done reading the card", "I'm done for now", "done with step 2", "I'm done with the task review", "All tests are done running", "The fix is done", "Shipped."
 */
const TASK_CLAIM_PATTERNS = [
  // "the task is complete", "this job has been finished"; a bare "the task done" or "the task was done" is not one.
  new RegExp(`\\b(?:the|this|my|our)\\s+(?:task|job|ticket)\\s+(?:is|has been|is now|is all)\\s+${DONE_WORD}\\b`, "iu"),
  // "Task watering-schedule-api is done": the task named by its slug (a word with a hyphen or an underscore in it).
  new RegExp(`\\b(?:task|job|ticket)\\s+[\`*"']*[\\w.]*[-_][\\w.-]*[\`*"']*\\s+(?:is|has been|is now|is all)\\s+${DONE_WORD}\\b`, "iu"),
  // "Task done." and "Task is done." at the start of a sentence or line.
  new RegExp(`(?:^|[\\n"'\`(:]|\\.\\s)\\s*(?:task|job|ticket)\\s+(?:is\\s+)?(?:now\\s+)?${DONE_WORD}\\b`, "iu"),
  // "completed the task", "done with the task and pushed"; "done with the task review" names a part of the task.
  new RegExp(`\\b(?:completed|finished|done with)\\s+(?:all\\s+of\\s+)?(?:(?:the|this|my|our)\\s+)?(?:task|job|ticket)\\b(?!\\s+(?!and\\b|then\\b|but\\b)\\w)`, "iu"),
]

export const DONE_CLAIM_PATTERNS = [
  ...TASK_CLAIM_PATTERNS,
  /\b(?:finished|completed)\s+(?:all\s+(?:of\s+)?)?(?:the|this|my|our)\s+work\b/iu,
  new RegExp(`\\b(?:the|this|my|our|all(?:\\s+the)?)\\s+work\\s+(?:is|was|has been)\\s+(?:now\\s+|all\\s+)?${DONE_WORD}\\b`, "iu"),
  new RegExp(`(?:^|[\\n"'\`(:]|\\.\\s)\\s*work\\s+(?:is\\s+|was\\s+)?(?:now\\s+)?${DONE_WORD}\\b`, "iu"),
  new RegExp(`\\bimplementation\\s+(?:is|was|are|has been)\\s+(?:now\\s+|all\\s+)?${DONE_WORD}\\b`, "iu"),
  /\bsuccessfully completed\b/iu,
  // "Everything is done", "all complete": "All tests are done running" has words between.
  new RegExp(`\\b(?:all|everything)\\s+(?:is\\s+)?(?:now\\s+)?${DONE_WORD}\\b`, "iu"),
  // A reply that opens with the word: "Done.", "**Done.**", "Completed. Tests pass", "✓ Done: wired the check".
  /^[\s*_#>"'`\-✓✔✅☑•]*(?:all\s+done|done|completed?|finished)\b[\s*_"'`]*(?:[.!—–-]|:(?![\s*_"'`]*$)|$)/iu,
]

/** A "Completed work" heading: a done claim unless the reply states the real status (the harness applies that exemption itself). */
export const COMPLETED_WORK_HEADING = /\bCompleted work\b/u

// The status words a Desk task card can hold short of done.
export const STATUS_WORDS = ["validating", "processing", "drafting", "collaborating", "paused", "blocked"]
export const STATUS = `(?:${STATUS_WORDS.join("|")})`

/** Clauses that report where the task really is, cut out before a sentence is judged: "moved it to validating", "status: validating", "is at validating (not done)". */
export const STATUS_CLAUSES = [
  new RegExp(`\\b(?:transitioned|moved)\\s+(?:(?:the\\s+)?task\\s+|it\\s+)?to\\s+[\`*"']*${STATUS}\\b[\`*"']*`, "giu"),
  new RegExp(`\\bstatus\\s*(?:is|:)\\s*[\`*"']*${STATUS}\\b[\`*"']*`, "giu"),
  new RegExp(`\\bis\\s+at\\s+[\`*"']*${STATUS}\\b[\`*"']*\\s*\\(not done\\)`, "giu"),
]

const sentencesOf = (text) => String(text).split(/(?<=[.?!])\s+|\n+/u).map((sentence) => sentence.trim()).filter((sentence) => sentence !== "")

/**
 * `text` without what is not the reply's own claim: fenced code, inline code, and quoted text ("the task is complete", as a quotation). A quotation that opens the text (or a line) is kept: it is the reply speaking.
 */
export function withoutQuotedText(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?(?:```|$)/gu, " ")
    .replace(/`[^`\n]*`/gu, " ")
    .replace(/(?<=\S\s)["“][^"”\n]*["”]/gu, " ")
}

function standing(sentence, patterns) {
  return patterns.some((pattern) => {
    const match = pattern.exec(sentence)
    if (match === null) return false
    const before = sentence.slice(Math.max(0, match.index - WINDOW_CHARS), match.index + match[0].length)
    // A condition may also follow: "complete once the PR merges".
    const after = sentence.slice(match.index + match[0].length, match.index + match[0].length + WINDOW_CHARS)
    return !NEGATION.test(before) && !CONDITIONAL.test(before) && !CONDITIONAL.test(after)
  })
}

/** The sentences of `text` that say the task or the work is done or complete (code, quotations, negated, conditional and explicit status clauses left out). */
export function doneClaims(text) {
  return sentencesOf(withoutQuotedText(text)).filter((sentence) => standing(STATUS_CLAUSES.reduce((rest, clause) => rest.replace(clause, " "), sentence), [...DONE_CLAIM_PATTERNS, COMPLETED_WORK_HEADING]))
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

// A status clause that is taken back in its own sentence is no statement: "Done! (status: validating - just kidding, it's done)", "validating -> done".
const RETRACTION = /\b(?:just\s+kidding|jk|psych|scratch\s+that|never\s*mind|on\s+second\s+thought|ignore\s+that)\b|(?:\u2192|->|=>|\u21d2)\s*[`*"']*(?:done|complete[d]?|finished)\b|\bbut\s+(?:it|the\s+task|task\s+\S+)\s*(?:is|['\u2019]s)\s+(?:actually\s+|really\s+)?(?:done|complete[d]?|finished)\b/iu
// A task slug: a word with a hyphen inside. Only an explicit task reference makes one the subject of a status clause: "task other-task is ...", or "other-task: ..." / "| other-task | ..." / "- other-task is ..." at the start of a statement. A hyphenated word elsewhere ("pre-existing", "code-review") is just a word.
const SLUG = "[a-z0-9]+(?:-[a-z0-9]+)+"
const TASK_REFERENCE = new RegExp(`\\btask\\s+[\`*"']*(${SLUG})[\`*"']*\\s*(?::|\\b(?:is|was|remains|stays|at|has)\\b)`, "iu")
const LEADING_REFERENCE = new RegExp(`^[\\s|>*\u2022\\-]*[\`*"']*(${SLUG})[\`*"']*\\s*(?::|\\||\\b(?:is|was|remains|stays)\\b)`, "iu")

/** The slug another task is referred to by in `part`, in an explicit task-reference form, or null. */
function otherTaskSlug(part, slug) {
  const found = TASK_REFERENCE.exec(part)?.[1] ?? LEADING_REFERENCE.exec(part)?.[1] ?? null
  return found !== null && found.toLowerCase() !== String(slug).toLowerCase() ? found : null
}

/** `text` without the parts that are not the reply speaking: fenced code and `>` quoted lines. */
function withoutBlockQuotes(text) {
  return String(text).replace(/```[\s\S]*?(?:```|$)/gu, " ").replace(/^[ \t]*>.*$/gmu, " ")
}

/**
 * Whether `text` states `status` as the task's real status: in a status clause ("status: validating", "is at validating", "at validating (not done)", "moved to validating", "the task is validating", "the task is now in validating state"), or in a sentence that names the task's slug.
 * The bare word does not count: "not validating", "still processing the logs" and "preprocessing" state nothing. With the task's `slug`, a clause in a sentence that names another task is about that task and does not count, and neither does one the sentence takes back ("just kidding, it's done", "validating -> done").
 */
export function statesStatus(text, status, slug) {
  const word = escapeRegExp(status)
  const quote = "[\\s*_`\"']*"
  const clauses = [
    `\\bstatus\\b[\\s*_:\`"'-]{0,8}(?:is\\s+|at\\s+)?${quote}${word}(?![\\w-])`,
    `\\b(?:is|remains|stays|left|sits|stands)\\s+(?:now\\s+|still\\s+)?(?:at|in)\\s+(?:the\\s+)?${quote}${word}(?![\\w-])`,
    `\\bat\\s+${quote}${word}${quote}\\s*\\(not done\\)`,
    `\\b(?:moved|transitioned|set|updated|changed)\\s+(?:(?:the\\s+)?task\\s+|it\\s+)?to\\s+${quote}${word}(?![\\w-])`,
    `\\btask\\s+(?:\\S+\\s+)?(?:is|remains|stays)\\s+(?:now\\s+|still\\s+)?${quote}${word}(?![\\w-])`,
  ].map((clause) => new RegExp(clause, "iu"))
  const named = typeof slug === "string" && slug !== "" ? new RegExp(`(?<![\\w-])${escapeRegExp(slug)}(?![\\w-])`, "iu") : null
  const bare = new RegExp(`(?<!\\bnot\\s)(?<![\\w-])${word}(?![\\w-])`, "iu")
  // A semicolon ends a statement as a full stop does: "status: processing; soil-sensor is at validating" is two. A status on the line after "Status:" counts as beside it.
  const own = withoutBlockQuotes(text).replace(/(\bstatus\b[\s*_]*:[ \t*_]*)\n+[ \t]*/giu, "$1")
  return sentencesOf(own).some((sentence) => !RETRACTION.test(sentence) && sentence.split(";").some((part) => {
    if (named !== null && !named.test(part) && otherTaskSlug(part, slug) !== null) return false
    return clauses.some((clause) => clause.test(part)) || (named !== null && named.test(part) && bare.test(part))
  }))
}

// The words of a task-level claim beyond "the task is done" itself. A sentence about the work ("the code is effectively done") is a work-level claim and stays with the status rule.
const WORK_SUBJECT = /\b(?:code|work|implementation|fix|fixes|change|changes|tests?|build|patch|feature|PR|pull request|branch|step|steps)\b/iu
const TASK_LEVEL_PATTERNS = [
  // Status: done / complete
  new RegExp(`\\bstatus\\s*(?:is|:)\\s*[\`*"']*${DONE_WORD}\\b`, "iu"),
  // "validating (complete)"
  new RegExp(`\\([\`*"']*${DONE_WORD}[\`*"']*\\)`, "iu"),
  // "validating -> done", "validating, no, done"
  new RegExp(`(?:\u2192|->|=>|\u21d2)\\s*[\`*"']*${DONE_WORD}\\b`, "iu"),
  new RegExp(`\\bno[,.:\u2014\u2013-]*\\s+(?:it['\u2019]s\\s+|it\\s+is\\s+)?${DONE_WORD}\\b`, "iu"),
  // "which means it is finished", "it's done"
  new RegExp(`\\bit(?:\\s+is|['\u2019]s)\\s+(?:now\\s+|all\\s+)?${DONE_WORD}\\b`, "iu"),
  // "in validating state and complete", "validating, meaning finished"
  new RegExp(`\\b(?:and|aka|meaning)\\s+(?:also\\s+)?${DONE_WORD}\\b`, "iu"),
  // "effectively done", "now done", "actually complete"
  new RegExp(`\\b(?:effectively|essentially|basically|actually|really|now|already)\\s+${DONE_WORD}\\b`, "iu"),
]
const TASK_LEVEL_WORK_EXEMPT = TASK_LEVEL_PATTERNS.slice(4)

/**
 * The sentences of `text` that claim the task itself is done: "Task x is done", "the task is complete", "Status: done", "validating (complete)", "validating -> done", "no, done", "it is finished", "effectively done".
 * These are not cleared by a status statement elsewhere in the reply, unlike "the work is done". With the task's `slug`, a sentence that refers to another task by an explicit task-reference form is that task's claim and does not count here.
 * Quoted text, code and `>` quotes, negated and conditional claims are left out.
 */
export function taskLevelClaims(text, slug) {
  const body = withoutQuotedText(withoutBlockQuotes(text))
  return sentencesOf(body).flatMap((sentence) => sentence.split(";")).filter((part) => {
    if (otherTaskSlug(part, slug) !== null && !(typeof slug === "string" && new RegExp(`(?<![\\w-])${escapeRegExp(slug)}(?![\\w-])`, "iu").test(part))) return false
    const rest = STATUS_CLAUSES.reduce((remaining, clause) => remaining.replace(clause, " "), part)
    const patterns = [...TASK_CLAIM_PATTERNS, ...TASK_LEVEL_PATTERNS.filter((pattern) => !TASK_LEVEL_WORK_EXEMPT.includes(pattern) || !WORK_SUBJECT.test(rest))]
    return standing(rest, patterns)
  })
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
 * The status the task's card holds now, or null when there is nothing to judge: the card is gone or unreadable, or it records no status. A task whose desk root was not known when it was recorded keeps its recorded status.
 */
function liveStatus(task) {
  if (typeof task?.root !== "string" || typeof task?.path !== "string") return typeof task?.status === "string" && task.status !== "" ? task.status : null
  try {
    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(readFileSync(path.join(task.root, task.path), "utf8"))?.[1] ?? ""
    return /^status:[ \t]*["']?([A-Za-z_-]+)["']?[ \t]*$/mu.exec(frontmatter)?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Stop: `{ decision: "block", reason }` when the reply says done over a task this turn touched whose card is not done and the reply never states that task's status; `{}` otherwise, and on any error.
 * The turn's tasks are cleared by any Stop that does not block. `options.stateDir` is for tests.
 */
export function doneClaimStopHook(payload, { env = process.env, stateDir = resolveDeskStateDir({ env }) } = {}) {
  try {
    if (payload?.hook_event_name === "SubagentStop" || typeof payload?.agent_id === "string") return {}
    if (typeof payload?.session_id !== "string" || payload.session_id === "") return {}
    const file = sessionFile(stateDir, payload.session_id)
    if (payload.stop_hook_active === true) {
      removeFile(file)
      return {}
    }
    const open = []
    for (const task of Object.values(readState(file).tasks)) {
      const status = typeof task?.slug === "string" ? liveStatus(task) : null
      if (status !== null && !TERMINAL.has(status)) open.push({ ...task, status })
    }
    const reply = open.length === 0 ? null : finalReply(payload)
    // A claim that the task itself is done stands whatever status the reply states; a claim about the work is cleared by an honest status statement.
    const unstated = reply === null ? [] : open.filter((task) => taskLevelClaims(reply, task.slug).length > 0 || (doneClaims(reply).length > 0 && !statesStatus(reply, task.status, task.slug)))
    if (unstated.length === 0) {
      removeFile(file)
      return {}
    }
    const [task] = unstated
    const reportAs = typeof task.report_as === "string" && task.report_as !== "" ? ` task_update returned report_as: ${JSON.stringify(task.report_as)}; say that.` : ""
    // Fix first: the slug can be long, so the first sentence names it only when it fits.
    const first = `Restate your reply with task ${task.slug}'s real status: ${task.status}.`
    const opening = first.length <= 120 ? first : `Restate your reply with the task's real status: ${task.status}.`
    // A claim about the task itself needs a different correction from a claim about the work: the work may be done, the task is not.
    const claim = taskLevelClaims(reply, task.slug).length > 0 ? `Your reply says task ${task.slug} itself is done, but it is at ${task.status}; you may say the work is done, not the task.` : `Your reply says the work is done, but task ${task.slug} is at ${task.status}.`
    return { decision: "block", reason: `${opening} ${claim}${reportAs}` }
  } catch {
    return {}
  }
}

/**
 * Copilot's `agentStop`: the same decision as `doneClaimStopHook`, with the reply read from the session transcript (the payload does not carry it, and the file only holds it a moment after the hook starts).
 * A session that touched no task is answered at once, without reading or waiting for anything. Returns `{}` on any error. `options` (`stateDir`, `waitMs`, `stepMs`, `sleep`) are for tests.
 */
export async function copilotStopHook(input, { env = process.env, stateDir = resolveDeskStateDir({ env }), ...reading } = {}) {
  try {
    const payload = claudeShapedPayload(input)
    if (typeof payload.session_id !== "string" || payload.session_id === "") return {}
    if (payload.stop_hook_active !== true && !existsSync(sessionFile(stateDir, payload.session_id))) return {}
    const reply = payload.stop_hook_active === true ? null : await copilotFinalReply(payload.transcript_path, reading)
    // The reply goes in `last_assistant_message`; the Claude transcript reader must not be pointed at Copilot's events.
    return doneClaimStopHook({ ...payload, transcript_path: undefined, last_assistant_message: reply }, { env, stateDir })
  } catch {
    return {}
  }
}
