// Which Desk gates fired in a boot-acceptance run, on either host.
//
// A run's transcript shows what the model did; it does not show whether Desk's own hooks fired and what they said. Claude Code puts hook activity
// in its stream-json (`system` hook events, a synthetic `Stop hook feedback:` user message, `PreToolUse:<Tool> hook error:` tool results). Copilot's
// `--output-format json` stream carries none of it: the hook events live in the session's own `events.jsonl` under `<COPILOT_HOME>/session-state/<id>/`,
// which the run's temp HOME takes with it. This module saves a reduced, redacted copy of that file next to the transcript (`reduceCopilotEvents`) and
// counts the gates from it (`copilotGates`), and counts the Claude gates from the stream (`claudeGates`). `gateReport` picks by host.
//
// What is kept of a Copilot log: the session start and resume, every hook start (its input cut down to what identifies the call) and hook end (its
// output, the part that carries injected context, a denial or a stop block), and every user message with the text the model received
// (`transformedContent`, where `userPromptSubmitted` context appears as a `<system_reminder>`). Tool results, assistant messages and the system prompt are
// already in the transcript or irrelevant here.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"

import { redactSecrets } from "./safety.mjs"

const KEPT_TYPES = new Set(["session.start", "session.resume", "hook.start", "hook.end", "user.message"])
const POINTER = /Desk boot is pending/u
const MAX_OUTPUT_CHARS = 60000
const MAX_FIELD_CHARS = 300

const cut = (value, max = MAX_FIELD_CHARS) => (typeof value === "string" && value.length > max ? `${value.slice(0, max)}...[cut]` : value)

// The part of a hook's input that says which call it was, never the tool results or file contents that make the real input large.
function reduceHookInput(input) {
  if (input === null || typeof input !== "object") return {}
  const kept = {}
  for (const key of ["source", "stopReason", "stop_hook_active", "reason", "toolName"]) if (input[key] !== undefined) kept[key] = input[key]
  if (typeof input.prompt === "string") kept.prompt = cut(input.prompt)
  if (typeof input.initialPrompt === "string") kept.initialPrompt = cut(input.initialPrompt)
  if (Array.isArray(input.toolCalls)) kept.toolCalls = input.toolCalls.map((call) => ({ name: call?.name, command: cut(call?.args?.command) }))
  return kept
}

function reduceHookOutput(output) {
  if (output === null || typeof output !== "object") return output
  const kept = {}
  for (const [key, value] of Object.entries(output)) kept[key] = cut(value, MAX_OUTPUT_CHARS)
  return kept
}

function reduceEvent(event) {
  const data = event.data ?? {}
  const base = { type: event.type, timestamp: event.timestamp }
  switch (event.type) {
    case "session.start":
      return { ...base, data: { selectedModel: data.selectedModel, copilotVersion: data.copilotVersion } }
    case "session.resume":
      return { ...base, data: {} }
    case "hook.start":
      return { ...base, data: { hookInvocationId: data.hookInvocationId, hookType: data.hookType, input: reduceHookInput(data.input) } }
    case "hook.end":
      return { ...base, data: { hookInvocationId: data.hookInvocationId, hookType: data.hookType, success: data.success, ...(data.output === undefined ? {} : { output: reduceHookOutput(data.output) }) } }
    default:
      // The pointer test reads the whole message before the cut, so a long message can never hide it from the gate report.
      return { ...base, data: { content: cut(data.content, 2000), transformedContent: cut(data.transformedContent, 60000), pointer_present: POINTER.test(String(data.transformedContent ?? "")) } }
  }
}

/** Copilot JSONL text as events; a line that is not JSON is dropped. */
export function parseEventLines(text) {
  const events = []
  for (const raw of String(text).split("\n")) {
    const line = raw.trim()
    if (!line) continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Not an event.
    }
  }
  return events
}

/**
 * The saved form of a session's `events.jsonl`: only the session, hook and user-message events, hook inputs cut down, every secret redacted (the token shapes
 * and each exact value in `secrets`). Each event is redacted whole first and cut after, so a secret that straddles a cut point is never left half-visible.
 * Returns the JSONL text, or "" when the log holds none of them.
 */
export function reduceCopilotEvents(text, { secrets = [] } = {}) {
  const lines = parseEventLines(text).filter((event) => KEPT_TYPES.has(event.type)).map((event) => JSON.stringify(reduceEvent(JSON.parse(redactSecrets(JSON.stringify(event), secrets)))))
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`
}

/**
 * The text of the session log under `<copilotHome>/session-state/*\/events.jsonl` (the files of every session found, oldest first), or null when there is none.
 * A run has one session, and its critique turn resumes it, so the one file holds both turns.
 */
export function readCopilotSessionEvents(copilotHome, { exists = existsSync, list = readdirSync, read = (file) => readFileSync(file, "utf8"), mtime = (file) => statSync(file).mtimeMs } = {}) {
  const root = path.join(copilotHome, "session-state")
  if (!exists(root)) return null
  const files = list(root).map((name) => path.join(root, name, "events.jsonl")).filter((file) => exists(file)).sort((a, b) => mtime(a) - mtime(b))
  return files.length === 0 ? null : files.map(read).join("\n")
}

const hasText = (value) => typeof value === "string" && value.trim() !== ""

/**
 * What Copilot's hooks did in one run, from the saved events (`copilot-events.jsonl`) or the full session log.
 *
 * - `session_start`: whether the `sessionStart` hook ran and handed back context, how long, and whether it ran after the first prompt hook. Copilot fires
 *   `userPromptSubmitted` first, then `sessionStart`, on a new session, so the context a boot pointer needs from the start hook is not there yet at that first prompt.
 * - `first_prompt_pointer`: whether the pointer reached the model with the very first user message. Copilot runs every `userPromptSubmitted` hook (Desk registers two) before it logs a
 *   user message, so a prompt is the group of those hook runs that precede one message. `prompts` counts such groups; `injected_on_first_prompt` is whether any hook in the first group returned the pointer;
 *   `reached_model` is whether the text is in that first message's `transformedContent` (what the model was given, tested before the saved copy is cut); `injected_count` counts the prompts that got one.
 * - `hook_order`: the hook types in the order they began, with repeats collapsed, up to the first twelve.
 */
export function copilotGates(events) {
  const hookStarts = events.filter((e) => e.type === "hook.start")
  const hookEnds = events.filter((e) => e.type === "hook.end")
  const endOf = (start) => hookEnds.find((end) => end.data?.hookInvocationId === start.data?.hookInvocationId)
  const outputOf = (start) => endOf(start)?.data?.output ?? {}
  const sessionStarts = hookStarts.filter((e) => e.data?.hookType === "sessionStart")
  const userMessages = events.filter((e) => e.type === "user.message")

  // Group the prompt hooks by the user message they precede.
  const prompts = []
  let group = []
  for (const event of events) {
    if (event.type === "hook.start" && event.data?.hookType === "userPromptSubmitted") group.push(event)
    else if (event.type === "user.message") {
      prompts.push({ hooks: group, message: event })
      group = []
    }
  }
  if (group.length > 0) prompts.push({ hooks: group, message: null })
  const pointerIn = (hooks) => hooks.some((start) => POINTER.test(String(outputOf(start).additionalContext ?? "")))

  const startContext = sessionStarts.map((start) => outputOf(start).additionalContext).filter(hasText)
  const firstPromptHook = prompts[0]?.hooks[0]
  const firstPromptIndex = firstPromptHook ? events.indexOf(firstPromptHook) : -1
  const firstStartIndex = sessionStarts[0] ? events.indexOf(sessionStarts[0]) : -1
  const firstMessage = userMessages[0]

  const order = []
  for (const start of hookStarts) if (order.at(-1) !== start.data?.hookType) order.push(start.data?.hookType)

  return {
    events_saved: true,
    session_start: {
      fired: sessionStarts.length,
      injected: startContext.length > 0,
      context_chars: startContext.reduce((total, text) => Math.max(total, text.length), 0),
      after_first_prompt_hook: firstPromptIndex >= 0 && firstStartIndex >= 0 ? firstStartIndex > firstPromptIndex : null,
    },
    first_prompt_pointer: {
      prompts: prompts.length,
      injected_on_first_prompt: prompts.length > 0 && pointerIn(prompts[0].hooks),
      reached_model: firstMessage !== undefined && (firstMessage.data?.pointer_present === true || POINTER.test(String(firstMessage.data?.transformedContent ?? ""))),
      injected_count: prompts.filter((p) => pointerIn(p.hooks)).length,
    },
    hook_failures: hookEnds.filter((end) => end.data?.success === false).length,
    hook_order: order.slice(0, 12),
  }
}

/** The report for a Copilot run that has no session log: nothing is claimed, and the summary says why. */
export const copilotGatesUnavailable = { events_saved: false, note: "the session's events.jsonl was not found, so no hook activity is known" }

// A SessionStart hook event carries only `hook_name: "SessionStart:startup"` and a `hook_id`: no plugin, no command, and a cancelled hook has no output at all (round AA, slow-or-failing-status run 1:
// `{"subtype":"hook_response","outcome":"cancelled","exit_code":1,"output":""}`). Desk's hook is therefore known by what it hands the agent: the foundation skill, or the "could not read it" fallback.
const DESK_START_CONTEXT = /name: using-desk\b|desk worker boot/u

/**
 * What Claude Code's hooks did in one run, from its stream-json events (both turns, scenario first).
 * `session_start`: the hooks that ran at the start, whether any returned context, and how many Claude Code cancelled (a hook that outran its timeout, as on an overloaded machine: its context never reached the agent).
 */
export function claudeGates(events) {
  let startHooks = 0
  let startContext = 0
  let startCancelled = 0
  let deskDelivered = false
  for (const event of events) {
    if (event.type === "system" && event.subtype === "hook_response" && event.hook_event === "SessionStart") {
      startHooks += 1
      if (event.outcome === "cancelled") startCancelled += 1
      else if (event.outcome !== "error" && DESK_START_CONTEXT.test(String(event.output ?? ""))) deskDelivered = true
      if (/additionalContext/u.test(String(event.output ?? ""))) startContext += 1
    }
  }
  return {
    events_saved: true,
    session_start: { fired: startHooks, injected: startContext > 0, cancelled: startCancelled, desk_delivered: deskDelivered },
  }
}

/** The gate report of a run on `host`: Copilot's from the saved events text (or null when there is none), Claude's from the parsed stream events. */
export function gateReport({ host, claudeEvents = [], copilotEventsText = null }) {
  if (host === "copilot") return copilotEventsText === null ? { ...copilotGatesUnavailable } : copilotGates(parseEventLines(copilotEventsText))
  return claudeGates(claudeEvents)
}

// The failure checks whose answer is in what Desk's start hook or boot hands the agent: with that hook cancelled, an agent that never ran boot, or never said what boot would have told it, is not shown to have failed.
// Every other failure (a write, a false claim, an invented delivery, a leak) does not depend on boot and stays a failure.
const BOOT_DEPENDENT_FAILURES = [
  /^never ran session-boot\.js$/u,
  /^did not tell the operator the desk could not sync with its remote$/u,
  /^did not tell the operator which account and route\b/u,
]

/**
 * Round AA, `slow-or-failing-status` run 1 lost Desk's SessionStart hook to its 10 s timeout on a machine at load 90, then skipped boot. When a SessionStart hook was cancelled and none of the others delivered Desk's context,
 * the boot-dependent failures (`BOOT_DEPENDENT_FAILURES`) are set aside as `DISCOUNTED:` notes, counted in `discounted`. A run left with a real failure stays `fail`; a run whose only failures were set aside becomes `unknown`
 * (it did not test boot); any other result is returned as it was.
 */
export function discountCancelledStart(checkResult, gates) {
  const start = gates?.session_start
  if (checkResult.outcome !== "fail" || (start?.cancelled ?? 0) === 0 || start.desk_delivered === true) return checkResult
  const failures = checkResult.notes.filter((note) => note.startsWith("FAIL: "))
  const discounted = failures.filter((note) => BOOT_DEPENDENT_FAILURES.some((pattern) => pattern.test(note.slice(6))))
  if (discounted.length === 0) return checkResult
  const notes = checkResult.notes.map((note) => (discounted.includes(note) ? `DISCOUNTED: ${note.slice(6)} (Desk's SessionStart hook was cancelled, so boot's output never reached the agent)` : note))
  return { ...checkResult, outcome: discounted.length === failures.length ? "unknown" : "fail", notes, discounted: discounted.length }
}
