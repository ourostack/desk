// Copilot CLI's hook payloads, read as the Claude-shaped calls Desk's guards already judge, so each guard keeps one body of logic for every host.
//
// Live-checked on Copilot CLI 1.0.89 (the contract is also in the CLI's own SDK types, `copilot-sdk/types.d.ts`):
//   preToolUse   { sessionId, timestamp, cwd, toolName, toolArgs }. `toolArgs` is an object for `bash`/`powershell` ({ command }), `create` ({ path, file_text }) and `edit` ({ path, old_str, new_str }), and the raw patch text for `apply_patch`. An MCP tool is named `<server>-<tool>`.
//                A deny is `{ permissionDecision: "deny", permissionDecisionReason }` on stdout, flat with no wrapper; Copilot shows "Denied by preToolUse hook: <reason>" to the model.
//   postToolUse  the same plus `toolResult: { resultType, textResultForLlm }`.
//   userPromptSubmitted  { sessionId, timestamp, cwd, prompt }.
//   agentStop    { sessionId, timestamp, cwd, transcriptPath, stopReason, stop_hook_active }, for the main agent only. It does not carry the reply, and the session transcript does not hold it yet when the hook starts (it lands within about 200 ms), so `copilotFinalReply` waits briefly for it. `{ decision: "block", reason }` makes Copilot continue with the reason as a follow-up message, and the next stop carries `stop_hook_active: true`.
// There is no matcher in a Copilot hook entry, so a hook runs for every tool and answers `{}` for the ones it does not judge.

import { readFileSync, statSync } from "node:fs"

const SHELL_TOOLS = { bash: "Bash", powershell: "PowerShell" }
const EDITOR_TOOLS = new Set(["edit", "str_replace_editor", "str_replace_based_edit_tool"])
const TASK_TOOL = /^(.+)-(task_(?:update|create|move|archive|signoff))$/u
const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

/** `toolArgs` as the object it is, or the raw text when it is not JSON (an `apply_patch` patch). */
function toolArgsOf(input) {
  const raw = input?.toolArgs
  if (typeof raw !== "string") return raw ?? null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

const targetOf = (args) => (typeof args.path === "string" ? args.path : args.file_path)
const writeCall = (args) => ({ toolName: "Write", args: { file_path: targetOf(args), content: args.file_text ?? args.content ?? "" } })
const editCall = (args) => ({ toolName: "Edit", args: { file_path: targetOf(args), old_string: args.old_str ?? args.old_string ?? "", new_string: args.new_str ?? args.new_string ?? args.file_text ?? args.content ?? "" } })

// Tools that only read, search or list. Anything else that aims a `path` or `file_path` at a file is treated as an edit of it, so a tool name Desk has never seen (a new Copilot release, a custom tool) is denied by default rather than allowed by default.
const READ_ONLY_TOOL = /^(?:view|grep|glob|ls|cat|head|tail|find|stat|read(?:_\w+)?|list(?:_\w+)?|search(?:_\w+)?|get(?:_\w+)?|show(?:_\w+)?|fetch(?:_\w+)?|web_\w+)$/iu

/**
 * The patch text of an `apply_patch` call: the bare string, or an object holding it under `input`, `patch` or `text`. Null when there is none.
 */
function patchText(args) {
  if (typeof args === "string") return args
  for (const key of ["input", "patch", "text"]) if (typeof args?.[key] === "string") return args[key]
  return null
}

/**
 * The `Write`/`Edit` calls an `apply_patch` text stands for, one per file section and, for an update, one per hunk (the old text is the hunk's context and removed lines, the new text its context and added lines, so a card's status line is judged as the host would apply it).
 * A rename (`*** Move to:`) is an edit of the source and a write of the destination.
 */
export function patchCalls(text) {
  if (typeof text !== "string") return []
  const files = []
  let file = null
  for (const line of text.split(/\r?\n/u)) {
    const header = /^\*\*\* (Add|Update|Delete) File: (.+?)\s*$/u.exec(line)
    if (header !== null) {
      file = { kind: header[1], path: header[2], hunks: [], moveTo: null }
      files.push(file)
      continue
    }
    if (/^\*\*\* (?:Begin|End) Patch\s*$/u.test(line)) {
      file = null
      continue
    }
    if (file === null) continue
    const move = /^\*\*\* Move to: (.+?)\s*$/u.exec(line)
    if (move !== null) {
      file.moveTo = move[1]
      continue
    }
    if (line.startsWith("@@")) {
      file.hunks.push({ old: [], new: [] })
      continue
    }
    const prefix = line.slice(0, 1)
    if (prefix !== "+" && prefix !== "-" && prefix !== " " && line !== "") continue
    // Lines before any `@@` (an added file's, or a first hunk with no marker) belong to a hunk of their own.
    if (file.hunks.length === 0) file.hunks.push({ old: [], new: [] })
    const hunk = file.hunks.at(-1)
    const body = line.slice(1)
    if (prefix !== "+") hunk.old.push(body)
    if (prefix !== "-") hunk.new.push(body)
  }
  const calls = []
  for (const entry of files) {
    const added = entry.hunks.flatMap((hunk) => hunk.new).join("\n")
    if (entry.kind === "Add") {
      calls.push({ toolName: "Write", args: { file_path: entry.path, content: added } })
      continue
    }
    const hunks = entry.kind === "Update" ? entry.hunks : []
    if (hunks.length === 0) calls.push({ toolName: "Edit", args: { file_path: entry.path, old_string: "", new_string: "" } })
    for (const hunk of hunks) calls.push({ toolName: "Edit", args: { file_path: entry.path, old_string: hunk.old.join("\n"), new_string: hunk.new.join("\n") } })
    if (entry.moveTo !== null) calls.push({ toolName: "Write", args: { file_path: entry.moveTo, content: added } })
  }
  return calls
}

/**
 * The calls a Copilot `preToolUse` payload stands for, in the names and argument fields Claude's tools use (`Bash`/`PowerShell` with `command`, `Write` with `file_path` and `content`, `Edit` with `file_path`, `old_string` and `new_string`): none for a tool that writes nothing or that Desk does not judge, one for most, several for an `apply_patch`.
 */
export function copilotToolCalls(input) {
  const name = input?.toolName
  const args = toolArgsOf(input)
  if (Object.hasOwn(SHELL_TOOLS, name)) return isObject(args) ? [{ toolName: SHELL_TOOLS[name], args }] : []
  if (name === "create") return isObject(args) ? [writeCall(args)] : []
  if (EDITOR_TOOLS.has(name)) {
    if (!isObject(args) || args.command === "view") return []
    return [args.command === "create" ? writeCall(args) : editCall(args)]
  }
  if (name === "apply_patch") return patchCalls(patchText(args))
  // Deny by default: a tool not known to be read-only that names a file is an edit of it (the guard then judges whether the file is a live card).
  if (typeof name === "string" && !READ_ONLY_TOOL.test(name) && isObject(args) && args.command !== "view" && typeof targetOf(args) === "string") return [editCall(args)]
  return []
}

/** Whether `toolName` is one of Desk's task tools (`<server>-task_update`, `-task_create`, `-task_move`, `-task_archive`, `-task_signoff`), all five of which the done-claim gate tracks. */
export const isTaskToolName = (toolName) => TASK_TOOL.test(typeof toolName === "string" ? toolName : "")

/** A Desk task tool's Copilot name (`<server>-task_update`) as Claude and Codex name an MCP tool (`mcp__<server>__task_update`); any other name is returned as it is. */
export function mcpToolName(toolName) {
  const name = typeof toolName === "string" ? toolName : ""
  const match = TASK_TOOL.exec(name)
  return match === null ? name : `mcp__${match[1]}__${match[2]}`
}

/** A Copilot `postToolUse`, `userPromptSubmitted` or `agentStop` payload with the field names the done-claim gate reads from Claude Code's. */
export function claudeShapedPayload(input) {
  return {
    session_id: input?.sessionId,
    cwd: input?.cwd,
    tool_name: mcpToolName(input?.toolName),
    tool_input: toolArgsOf(input),
    tool_response: input?.toolResult?.textResultForLlm,
    transcript_path: input?.transcriptPath,
    stop_hook_active: input?.stop_hook_active ?? input?.stopHookActive,
  }
}

/**
 * A shared guard answers in Claude Code's shape (`{ hookSpecificOutput: { permissionDecision, permissionDecisionReason } }`); Copilot reads the same two fields flat. An allow is `{}`.
 */
export function copilotDeny(output) {
  const decision = output?.hookSpecificOutput ?? output
  return decision?.permissionDecision === "deny"
    ? { permissionDecision: "deny", permissionDecisionReason: decision.permissionDecisionReason }
    : {}
}

// ---------------------------------------------------------------------------
// The final reply, in the session transcript (events.jsonl)
// ---------------------------------------------------------------------------

/**
 * `{ settled, reply }` for a transcript's text: the turn's final reply is the last assistant message that asks for no tool, after the last user message (a hook-injected follow-up is a user message too). Not settled while the turn has no such message yet; settled with a null reply when the message is empty.
 */
function inspectEvents(text) {
  let reply = null
  let settled = false
  for (const line of text.split("\n")) {
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObject(event)) continue
    if (event.type === "user.message") {
      reply = null
      settled = false
    } else if (event.type === "assistant.message" && !(Array.isArray(event.data?.toolRequests) && event.data.toolRequests.length > 0)) {
      const content = typeof event.data?.content === "string" ? event.data.content : ""
      reply = content.trim() === "" ? null : content
      settled = true
    }
  }
  return { settled, reply }
}

/** The final reply in a transcript's text, or null. */
export function finalReplyFromEvents(text) {
  return inspectEvents(text).reply
}

const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

/**
 * The final reply in the transcript file at `transcriptPath`, waiting up to `waitMs` (polling every `stepMs`) for it to be written: Copilot starts the stop hook before the reply reaches the file. Null when there is no readable transcript, no reply or an empty one; never throws.
 * `sleep`, `waitMs`, `stepMs` and `maxBytes` are for tests.
 */
export async function copilotFinalReply(transcriptPath, { waitMs = 1500, stepMs = 100, maxBytes = MAX_TRANSCRIPT_BYTES, sleep = sleepFor } = {}) {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return null
  for (let waited = 0; ; waited += stepMs) {
    let text
    try {
      if (statSync(transcriptPath).size > maxBytes) return null
      text = readFileSync(transcriptPath, "utf8")
    } catch {
      return null
    }
    const { settled, reply } = inspectEvents(text)
    if (settled) return reply
    if (waited >= waitMs) return null
    await sleep(stepMs)
  }
}
