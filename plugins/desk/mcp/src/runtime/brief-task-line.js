// The `Desk-Task: <track>/<slug>` line in a subagent brief, made structural.
//
// The factory credits a subagent's work to a task through that line (`factory/desk-task-line.js`), or through the task the parent held
// when it spawned the subagent. A go-and-see of the public store found 87 of 250 public pull requests credited to no task: one lead
// session wrote 181 of its 199 briefs with no line while it held no task focus. A reminder in a skill did not stop it, so two hooks do:
//
//   - `recordBriefFocus` (PostToolUse on `task_focus` and `task_create`) keeps the task the session's main agent last declared, in a
//     session-scoped file under Desk's state folder (`brief-focus/`, pruned after a week). A subagent's call never counts: its focus is
//     not the session's.
//   - `briefDecision` (PreToolUse on the subagent tool) judges a brief. A brief that carries one valid `Desk-Task:` line, or
//     `Desk-Task: none` (the work serves no task), passes. Otherwise, when the main agent holds a task, Claude Code adds the line for it
//     (`updatedInput` with no permission decision, so the host's normal permission check still runs on the changed input). Every other
//     case is denied once with the line to add: a subagent spawning one of its own, no task held, a focus record that is missing or cannot
//     be read (the reason says which), or a held task whose names would not read back as a `Desk-Task:` line.
//
// Host by host: Claude Code gets both the added line and the denial. Copilot gets the denial only, because its `preToolUse` contract
// has no field to change a tool's input; a brief there passes when a focus is held, and the spawn-time rule credits the subagent to
// that task. Codex hooks are not trusted by default, so on Codex the brief template in `work-orchestration` is the only mechanism.
//
// What passes unchanged: a call that is not a spawn, a payload with no prompt, and a session with no desk root (nothing to credit). The
// command-line wrapper also lets the call through when the hook itself throws. A missing or unreadable focus record is not a pass: the
// subagent's credit would be lost silently, so the call is denied with a reason that says the record could not be read.

import { createHash } from "node:crypto"
import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { parseDeskTaskLine } from "../factory/desk-task-line.js"
import { isTaskSegment } from "../factory/binding.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

export const BRIEF_FOCUS_DIR = "brief-focus"
const STALE_MS = 7 * 24 * 60 * 60 * 1000

// A Desk task tool as each host names it: `mcp__<server>__task_focus` (Claude Code, Codex) or `<server>-task_focus` (Copilot), from a server whose name says desk.
const FOCUS_TOOL = /^(?:mcp__\w*desk[\w-]*?__|[\w-]*desk[\w-]*?-)(task_focus|task_create)$/u
// The tool that starts a subagent: Claude Code's `Agent` (formerly `Task`), Copilot's `task`.
const SPAWN_TOOLS = { claude: new Set(["Agent", "Task"]), copilot: new Set(["task"]) }
const NONE_LINE = /^\s*(?:[-*>]\s+)?Desk-Task:[ \t]+none\s*$/imu
const ANY_LINE = /^\s*(?:[-*>]\s+)?Desk-Task:/mu

export const NO_TASK_REASON = "Add a `Desk-Task: <track>/<slug>` line to this brief, or `Desk-Task: none`, then make the call again. This session's task focus was cleared, so without the line the subagent's work is credited to no task; calling task_focus first also works."
export const NO_RECORD_REASON = "Add a `Desk-Task: <track>/<slug>` line to this brief, or `Desk-Task: none`, then make the call again. Desk has no record of a task this session holds, so it cannot add the line for you; calling task_focus first also works."
export const UNREAD_FOCUS_REASON = "Add a `Desk-Task: <track>/<slug>` line to this brief, or `Desk-Task: none`, then make the call again. Desk could not read the task this session holds, so it cannot add the line for you."
export const UNUSABLE_FOCUS_REASON = "Add a `Desk-Task: <track>/<slug>` line to this brief, or `Desk-Task: none`, then make the call again. The task this session holds has a name that would not read back as a `Desk-Task:` line, so Desk did not add one."
export const SUBAGENT_REASON = "Add the `Desk-Task:` line from your own brief to this one, or `Desk-Task: none`, then make the call again. Desk credits a subagent's work to a task only through that line."
export const UNREADABLE_REASON = "Keep exactly one `Desk-Task: <track>/<slug>` line (or `Desk-Task: none`) in this brief, then make the call again. The line here does not name one task as track and slug."

const hasText = (value) => typeof value === "string" && value !== ""
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/** The state file for a session: a digest of its id, so no id can name another path. */
export function focusFile(stateDir, sessionId) {
  return path.join(stateDir, BRIEF_FOCUS_DIR, `${createHash("sha256").update(String(sessionId)).digest("hex").slice(0, 32)}.json`)
}

// The text of a tool response, whatever its shape: a string, a content-block array, `{ content }` or `{ text }`.
function responseText(response) {
  if (typeof response === "string") return response
  if (Array.isArray(response)) return response.map(responseText).join("\n")
  if (!isObject(response)) return ""
  if (typeof response.text === "string") return response.text
  return response.content === undefined ? "" : responseText(response.content)
}

function parseObject(text) {
  try {
    const parsed = JSON.parse(text)
    return isObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

// Each host's payload as `{ sessionId, toolName, input, response, subagent }`. Copilot may hand `toolArgs` as JSON text.
function shapeOf(host, payload) {
  if (host === "copilot") {
    const args = typeof payload?.toolArgs === "string" ? parseObject(payload.toolArgs) : payload?.toolArgs
    return { sessionId: payload?.sessionId, toolName: payload?.toolName, input: isObject(args) ? args : null, response: payload?.toolResult?.resultType === "success" ? payload.toolResult.textResultForLlm : null, subagent: false }
  }
  return { sessionId: payload?.session_id, toolName: payload?.tool_name, input: isObject(payload?.tool_input) ? payload.tool_input : null, response: payload?.tool_response, subagent: hasText(payload?.agent_id) }
}

/** What a successful `task_focus` or `task_create` call declares: `{ track, slug }`, `{ clear: true }`, or null (another tool, a failed call, a `task_create` without `focus: true`). */
export function declaredFocus(toolName, input, response) {
  const verb = FOCUS_TOOL.exec(typeof toolName === "string" ? toolName : "")?.[1]
  if (verb === undefined || input === null) return null
  const result = parseObject(responseText(response))
  if (result === null || result.error !== undefined || result.status === "failed") return null
  if (verb === "task_focus" && result.status === "cleared") return { clear: true }
  if (verb === "task_focus" && result.status !== "focused") return null
  if (verb === "task_create" && input.focus !== true) return null
  return isTaskSegment(input.track) && isTaskSegment(input.slug) ? { track: input.track, slug: input.slug } : null
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

/** PostToolUse: keep the task the session's main agent declared. Returns `{}` always; a failure is swallowed. */
export function recordBriefFocus(host, payload, { stateDir, now = Date.now } = {}) {
  try {
    const shape = shapeOf(host, payload)
    if (shape.subagent || !hasText(shape.sessionId)) return {}
    const focus = declaredFocus(shape.toolName, shape.input, shape.response)
    if (focus === null) return {}
    assertNotRealStateUnderTest(stateDir)
    const file = focusFile(stateDir, shape.sessionId)
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify(focus.clear === true ? { task: null } : { task: focus })}\n`, { mode: 0o600 })
    renameSync(temp, file)
    pruneStale(path.dirname(file), now())
  } catch {
    // Fail open: nothing recorded means no task is held.
  }
  return {}
}

// What Desk knows of the task the session's main agent holds: `{ held: { track, slug } }`, or `{ reason }` saying why no line can be added.
function heldTask(stateDir, sessionId) {
  if (!hasText(sessionId)) return { reason: UNREAD_FOCUS_REASON }
  let text
  try {
    text = readFileSync(focusFile(stateDir, sessionId), "utf8")
  } catch (error) {
    return { reason: error?.code === "ENOENT" ? NO_RECORD_REASON : UNREAD_FOCUS_REASON }
  }
  const record = parseObject(text)
  if (record === null || !Object.hasOwn(record, "task")) return { reason: UNREAD_FOCUS_REASON }
  if (record.task === null) return { reason: NO_TASK_REASON }
  const task = record.task
  if (!isObject(task) || !hasText(task.track) || !hasText(task.slug)) return { reason: UNREAD_FOCUS_REASON }
  // The line must read back through the same parser the binder uses, or the added text would credit nothing (or span lines).
  const parsed = parseDeskTaskLine(`Desk-Task: ${task.track}/${task.slug}`)
  return parsed !== null && parsed.track === task.track && parsed.slug === task.slug ? { held: parsed } : { reason: UNUSABLE_FOCUS_REASON }
}

/**
 * PreToolUse on the subagent tool: `{ action: "pass" }`, `{ action: "add", input, task }` (the tool input with the line appended to its
 * prompt) or `{ action: "deny", reason }`. `deskRoot` is the desk this session binds, or null: with no desk there is no task to credit.
 */
export function briefDecision(host, payload, { stateDir, deskRoot }) {
  const shape = shapeOf(host, payload)
  const prompt = shape.input?.prompt
  if (!SPAWN_TOOLS[host]?.has(shape.toolName) || typeof prompt !== "string" || !hasText(deskRoot)) return { action: "pass" }
  if (parseDeskTaskLine(prompt) !== null || NONE_LINE.test(prompt)) return { action: "pass" }
  if (ANY_LINE.test(prompt)) return { action: "deny", reason: UNREADABLE_REASON }
  if (shape.subagent) return { action: "deny", reason: SUBAGENT_REASON }
  const known = heldTask(stateDir, shape.sessionId)
  if (known.held === undefined) return { action: "deny", reason: known.reason }
  const task = known.held
  // Copilot cannot change a tool's input; the subagent is credited to the held task by the spawn-time rule.
  if (host !== "claude") return { action: "pass" }
  return { action: "add", task, input: { ...shape.input, prompt: `${prompt.replace(/\s+$/u, "")}\n\nDesk-Task: ${task.track}/${task.slug}\n` } }
}

/**
 * The hook's stdout for `decision` in `host`'s own `PreToolUse` shape: Claude Code's `hookSpecificOutput`, Copilot's flat deny, `{}` to pass.
 * An added line carries no `permissionDecision`: the hook tags the brief, it does not approve the spawn. Claude Code applies an
 * `updatedInput` sent without a decision and then runs its normal permission check on the changed input (traced in 2.1.290).
 */
export function briefHookOutput(host, decision) {
  if (decision.action === "deny") {
    const deny = { permissionDecision: "deny", permissionDecisionReason: decision.reason }
    return host === "claude" ? { hookSpecificOutput: { hookEventName: "PreToolUse", ...deny } } : deny
  }
  if (decision.action === "add") {
    return { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: decision.input, additionalContext: `Desk added the line \`Desk-Task: ${decision.task.track}/${decision.task.slug}\` to this subagent's brief, the task this session holds.` } }
  }
  return {}
}
