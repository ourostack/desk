// What one Copilot session's own history (`<session-state>/<id>/events.jsonl`) says about it: whether its last turn ended, what
// still runs after it, and which Desk task it declared with `task_focus`. Histories reach hundreds of MB, so every read runs
// backwards in bounded chunks and parses only the few lines that matter. Nothing here writes.
import { readFileSync } from "node:fs"
import { open } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { declaredFocus } from "../factory/derive-common.js"

const CHUNK_BYTES = 1024 * 1024
/** How far back the open-work scan reads before it gives up and reports what it saw. */
const OPEN_WORK_SCAN_BYTES = 48 * 1024 * 1024
/** How far back a focus search reads, in total across polls (a cached answer stops it at the bytes already read). */
const FOCUS_SCAN_BYTES = 1024 * 1024 * 1024

const TYPE = /^\{"type":"([^"]+)"/u
const TIMESTAMP = /"timestamp":"([^"]+)"/u
const OWNER_AGENT = /"agentId":"([^"]*)","id":"[^"]*","timestamp"/u
const TOOL_CALL = /"toolCallId":"([^"]+)"/u
const SHELL_STARTED = /shellId: (\d+)(?:>| is still running)/u
const FOCUS_START = /"toolName":"(?:[^"]*[-_.])?(task_focus|task_create)"/u
const BLOCKING_TOOL = /"toolName":"(?:[^"]*[-_.])?(ask_user|exit_plan_mode)"/u
const STOPPED_SHELL = /"shellId":"?(\d+)"?/u

// The events that show what the main agent is doing. Hooks, usage records and model snapshots are not.
const MEANINGFUL = new Set([
  "user.message", "assistant.turn_start", "assistant.turn_end", "assistant.message", "abort", "tool.execution_start", "tool.execution_complete",
  "permission.requested", "permission.completed", "system.notification", "subagent.started", "subagent.completed", "subagent.failed",
  "external_tool.requested", "external_tool.completed", "session.task_complete", "session.start", "session.resume", "session.shutdown",
])
const BOUNDARY = new Set(["session.start", "session.resume", "session.shutdown"])
// A turn that ended cleanly: the agent stopped on its own.
const ENDED = new Set(["assistant.turn_end", "session.task_complete"])

/** The Copilot app's data folder: `COPILOT_HOME`, else `~/.copilot`. */
export function copilotHome(env) {
  return env.COPILOT_HOME || path.join(os.homedir(), ".copilot")
}

export const sessionStateDir = (env) => path.join(copilotHome(env), "session-state")

/** The lines of a file from the last to the first, as strings, reading `CHUNK_BYTES` at a time without holding the event loop. `stopAt` is a byte offset at a line start; reading ends there or after `maxBytes`. */
async function* reverseLines(file, { stopAt, maxBytes }) {
  const handle = await open(file, "r")
  try {
    let position = (await handle.stat()).size
    let carry = Buffer.alloc(0)
    let consumed = 0
    while (position > stopAt && consumed < maxBytes) {
      const length = Math.min(CHUNK_BYTES, position - stopAt)
      position -= length
      const chunk = Buffer.allocUnsafe(length)
      await handle.read(chunk, 0, length, position)
      consumed += length
      const data = Buffer.concat([chunk, carry])
      let end = data.length
      while (end > 0) {
        const newline = data.lastIndexOf(10, end - 1)
        if (newline === -1) break
        if (end - newline > 1) yield data.toString("utf8", newline + 1, end)
        end = newline
      }
      carry = Buffer.from(data.subarray(0, end))
    }
    // The oldest fragment: the first line when the read reached it, else a partial line no reader parses.
    yield carry.toString("utf8")
  } finally {
    await handle.close()
  }
}

const isSubagentOwned = (line) => OWNER_AGENT.test(line.slice(-400))

/** The main agent's last meaningful event, as `{ type, at, ms, ended, stoppedByPerson, closed }`, or null for a history with none. A subagent's own events are skipped. */
export async function lastActivity(file) {
  for await (const line of reverseLines(file, { stopAt: 0, maxBytes: 8 * 1024 * 1024 })) {
    const type = TYPE.exec(line)?.[1]
    if (!MEANINGFUL.has(type) || (!type.startsWith("subagent.") && isSubagentOwned(line))) continue
    const at = TIMESTAMP.exec(line.slice(-400))?.[1]
    // A last line still being written has no timestamp yet.
    if (at === undefined) continue
    return { type, at, ms: Date.parse(at), ended: ENDED.has(type), stoppedByPerson: type === "abort" && line.includes('"reason":"user_initiated"'), closed: type === "session.shutdown" }
  }
  return null
}

/** Whether the main agent's last message with text is a final report (Asked / Delivered / Accept or send back?), which is how a session that is truly done ends. */
export async function endsWithFinalReport(file) {
  for await (const line of reverseLines(file, { stopAt: 0, maxBytes: 8 * 1024 * 1024 })) {
    if (TYPE.exec(line)?.[1] !== "assistant.message" || isSubagentOwned(line)) continue
    let text
    try {
      text = String(JSON.parse(line).data.content ?? "")
    } catch {
      continue
    }
    if (text.trim() !== "") return /^\W*Asked\b.*:/mu.test(text) && /^\W*Delivered\b.*:/mu.test(text)
  }
  return false
}

/**
 * What still runs after the main agent's last turn: subagents that started and never finished, background shells that never
 * reported completion, and a question or plan waiting on a person. The scan stops at the last session start, resume or shutdown,
 * because nothing survives one, or at `maxBytes` back.
 */
export async function openWork(file) {
  const finishedSubagents = new Set()
  const cancelledAgents = new Set()
  const finishedShells = new Set()
  const finishedTools = new Set()
  const subagents = []
  const shells = new Set()
  const waiting = []
  for await (const line of reverseLines(file, { stopAt: 0, maxBytes: OPEN_WORK_SCAN_BYTES })) {
    const type = TYPE.exec(line)?.[1]
    if (BOUNDARY.has(type)) break
    const id = TOOL_CALL.exec(line)?.[1]
    const owner = OWNER_AGENT.exec(line.slice(-400))?.[1]
    if (type === "subagent.completed" || type === "subagent.failed") finishedSubagents.add(id)
    else if (type === "abort" && line.includes('"subagent_cancelled"')) cancelledAgents.add(owner)
    else if (type === "subagent.started" && !finishedSubagents.has(id) && !cancelledAgents.has(owner)) subagents.push(id)
    else if (type === "system.notification" && line.includes('"shell_completed"')) finishedShells.add(STOPPED_SHELL.exec(line)?.[1])
    else if (type === "permission.completed") finishedTools.add(id)
    else if (type === "permission.requested" && !finishedTools.has(id)) waiting.push("a permission prompt")
    else if (type === "tool.execution_complete") {
      finishedTools.add(id)
      const shell = owner === undefined ? SHELL_STARTED.exec(line)?.[1] : undefined
      if (shell !== undefined && !finishedShells.has(shell)) shells.add(shell)
    } else if (type === "tool.execution_start" && owner === undefined) {
      if (line.includes('"toolName":"stop_bash"')) finishedShells.add(STOPPED_SHELL.exec(line.slice(line.indexOf('"arguments"')))?.[1])
      const blocking = BLOCKING_TOOL.exec(line)?.[1]
      if (blocking !== undefined && !finishedTools.has(id)) waiting.push(blocking === "ask_user" ? "a question for a person" : "a plan waiting for approval")
    }
  }
  return { subagents: subagents.length, shells: shells.size, waiting }
}

/**
 * The task the main agent last declared: `{ focus: { track, slug } | null, size, fresh }`. `focus` is null when the last declaration cleared it
 * or none was found; `fresh` says a declaration was read now. A `cached` answer (`{ size, focus }` from an earlier read) makes the scan stop
 * at the bytes it already covered, so only new history is read.
 */
export async function findFocus(file, { cached = null } = {}) {
  const size = await fileSize(file)
  if (cached !== null && cached.size === size) return { focus: cached.focus, size, fresh: false }
  const failed = new Set()
  for await (const line of reverseLines(file, { stopAt: cached === null ? 0 : cached.size, maxBytes: FOCUS_SCAN_BYTES })) {
    const type = TYPE.exec(line)?.[1]
    if (type === "tool.execution_complete") {
      if (line.includes('"success":false')) failed.add(TOOL_CALL.exec(line)?.[1])
      continue
    }
    const verb = type === "tool.execution_start" ? FOCUS_START.exec(line.slice(0, 600))?.[1] : undefined
    if (verb === undefined || isSubagentOwned(line)) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // A last line still being written.
      continue
    }
    if (failed.has(event.data.toolCallId)) continue
    const declared = declaredFocus(verb, event.data.arguments)
    if (declared === null) continue
    return { focus: declared.clear === true ? null : { track: declared.track, slug: declared.slug }, size, fresh: true }
  }
  return { focus: cached === null ? null : cached.focus, size, fresh: false }
}

async function fileSize(file) {
  const handle = await open(file, "r")
  try {
    return (await handle.stat()).size
  } finally {
    await handle.close()
  }
}

/** `{ cwd, gitRoot, name }` from a session's `workspace.yaml`, each null when missing (a name written as a block or a quoted scalar counts as missing). */
export function readWorkspaceFile(file) {
  let raw = ""
  try {
    raw = readFileSync(file, "utf8")
  } catch {
    // No file reads as no fields.
  }
  const field = (key, first = ".") => new RegExp(`^${key}: (${first}.*)$`, "mu").exec(raw)?.[1].trim() ?? null
  return { cwd: field("cwd"), gitRoot: field("git_root"), name: field("name", "[^|>'\"]") }
}
