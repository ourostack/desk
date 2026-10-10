// The hosted Desk: what changes when Desk's MCP server runs as a service (DESK_HOSTED=1) behind a gateway, not on the operator's own machine.
//
// Four things live here: the flag, the short list of tools and doctor repairs a hosted Desk refuses (each with the reason a person can act on), the MCP annotations every tool carries so a host such as claude.ai can tell reading from writing, and the MCP instructions that stand in for session start in a hosted chat.
//
// The front door imports this before the runtime pack is restored, so it imports only `node:` modules, the tool names and the dependency-free AGENTS.md reader.

import { readFileSync } from "node:fs"
import * as path from "node:path"
import { TOOL_NAMES } from "../tool-names.js"
import { readAgentsMd } from "./agents-md.js"

/** True when `env.DESK_HOSTED` is set and is neither empty nor `0`, compared exactly as given (no trimming). */
export function isHosted(env) {
  const value = String(env?.DESK_HOSTED ?? "")
  return value !== "" && value !== "0"
}

const NO_EMBEDDINGS = "Hosted Desk has no embedding endpoint; use desk_search."
const HOST_MACHINE = "This repair acts on the machine Desk runs on, which is the hosted service, not yours."

// Tools a hosted Desk refuses outright.
export const HOSTED_UNAVAILABLE = Object.freeze({
  improvement_next: "A claimed improvement card needs a coding harness to work it; a hosted chat claim would only hold the card.",
  desk_recall: NO_EMBEDDINGS,
  desk_similar: NO_EMBEDDINGS,
})

// desk_doctor repairs that act on the machine Desk runs on. switch_state_branch is not here: it only switches the desk checkout back to its state branch, and that checkout is the operator's desk, which the hosted service holds on their behalf.
export const HOSTED_UNAVAILABLE_REPAIRS = Object.freeze({
  prune_readiness_state: HOST_MACHINE,
  reclaim_controller: HOST_MACHINE,
})

// Skills whose body needs a shell, git, gh or the plugin's own scripts: a hosted chat has none of them.
const NEEDS_SHELL = "This skill runs shell commands, git or plugin scripts, which a hosted chat does not have."
export const HOSTED_SHELL_SKILLS = Object.freeze({
  "session-start": "Session start runs the plugin's boot script, which a hosted chat cannot run; use desk_status for the same picture.",
  "git-hygiene": "Git hygiene works on local clones of code repositories, which a hosted chat does not have.",
  "repo-handling": "Repo handling finds and clones code repositories on the machine, which a hosted chat does not have.",
  "first-run-bootstrap": NEEDS_SHELL,
  "codex-onboarding": NEEDS_SHELL,
  "add-workspace-mcp": NEEDS_SHELL,
  "cdp-headed-browser": NEEDS_SHELL,
  "factory-evaluator": NEEDS_SHELL,
  "using-superpowers-with-desk": NEEDS_SHELL,
  "session-start-migrations": NEEDS_SHELL,
  "pr-feedback-on-own-pr": NEEDS_SHELL,
  "archive-workflow": "Archiving by hand commits with git; use task_archive.",
})

/** The refusal payload for `name` in a hosted Desk, or null when the call may go ahead. Carries no input text. */
export function hostedRefusal(name, input, env) {
  if (!isHosted(env)) return null
  const reason = HOSTED_UNAVAILABLE[name]
    ?? (name === "desk_doctor" && typeof input?.repair === "string" && Object.hasOwn(HOSTED_UNAVAILABLE_REPAIRS, input.repair)
      ? HOSTED_UNAVAILABLE_REPAIRS[input.repair]
      : undefined)
  return reason === undefined ? null : { status: "refused", code: "hosted_unavailable", tool: name, reason }
}

const READ_ONLY = new Set(["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread", "desk_status", "desk_skill"])
// Tools that can remove or overwrite what was there: archive and move relocate a task, rename a track rewrites its path, and desk_save replaces files.
const DESTRUCTIVE = new Set(["task_archive", "task_move", "track_rename", "desk_save"])

// desk_doctor is not read-only even though a read-only session may call it: its repairs change state.
export const TOOL_ANNOTATIONS = Object.freeze(Object.fromEntries(TOOL_NAMES.map((name) => [
  name,
  Object.freeze({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name) }),
])))

// A hosted client's own memory (claude.ai's, ChatGPT's) would split durable context between the client and the desk.
const CLIENT_MEMORY = "Don't use this client's built-in memory. Durable context, preferences and task state live in the desk, written through Desk's tools, and the desk wins over anything the client's memory recalls. Never save to that memory. If the client lets you turn its memory off, do so. If it doesn't and its memory is on, tell the user once that Desk keeps their memory in the desk and that they can turn the client's memory off in its settings."
const DESK_STATUS_FIRST = "Start by calling desk_status: it is this session's startup status block."
// The opening of the instructions. OpenAI's MCP server guide (https://developers.openai.com/plugins/build/mcp-server) advises putting key details in the first 512 characters, so this holds the rules that matter most; the password rule is copied from the using-desk foundation. A test keeps it inside 512 characters.
const LEAD = "Desk keeps this user's work, memory and task state in their desk. Call desk_status first: it is this session's startup status block. Don't use this client's built-in memory; write what lasts through Desk's tools. Never type a password or paste a secret into a tool call, a reply or a desk file. Skip the session-start procedure (it needs a shell) and the shell-only skills named under \"Hosted Desk\" below."
const SKILLS = "Desk's skills are its working procedures. When these instructions or a tool answer name a skill, read it with desk_skill (no name lists them all) and follow it; this client cannot load them any other way."

/**
 * The MCP instructions a hosted Desk sends with its initialize answer, in place of the session-start hook a hosted chat does not have: a short lead with the rules that matter most, the using-desk foundation (frontmatter stripped), the desk's AGENTS.md, then what this hosted Desk refuses and why, ending with the desk_status line.
 * Synchronous and built from file reads only, so the handshake never waits. A file that is missing or unreadable is left out.
 */
export function hostedInstructions({ root, pluginRoot }) {
  const sections = [LEAD]
  const foundation = typeof pluginRoot === "string" ? readText(path.join(pluginRoot, "skills", "using-desk", "SKILL.md")) : null
  if (foundation !== null) sections.push(foundation.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim())
  const agents = typeof root === "string" ? readOptional(() => readAgentsMd(root)) : null
  if (agents !== null) {
    const note = agents.truncated ? `\n\n(AGENTS.md is longer than 16 KiB; the rest stays in ${agents.path}.)` : ""
    sections.push(`# This desk's AGENTS.md\n\n${agents.text.trim()}${note}`)
  }
  const list = (entries) => Object.entries(entries).map(([name, reason]) => `- \`${name}\`: ${reason}`).join("\n")
  sections.push([
    "# Hosted Desk",
    "This Desk runs as a hosted service: there is no shell, git or plugin script here, so the session-start hook has not run. These instructions carry the startup the foundation above asks for. Skip session-start (session boot) and the skills listed below, call desk_status first, and work through the Desk tools.",
    CLIENT_MEMORY,
    SKILLS,
    `Tools Desk refuses here:\n${list(HOSTED_UNAVAILABLE)}`,
    `desk_doctor repairs Desk refuses here:\n${list(HOSTED_UNAVAILABLE_REPAIRS)}`,
    `Skills to skip, because they need a shell:\n${list(HOSTED_SHELL_SKILLS)}`,
    DESK_STATUS_FIRST,
  ].join("\n\n"))
  return `${sections.join("\n\n")}\n`
}

function readText(file) {
  return readOptional(() => readFileSync(file, "utf8"))
}

// A file that cannot be read (missing, a directory, no permission) is left out of the instructions, never fatal.
function readOptional(read) {
  try {
    return read()
  } catch {
    return null
  }
}

// How long a hosted desk_status waits, in total, for Desk to finish admitting the desk and loading its status detail, and how often it asks again.
const STARTUP_DETAIL_WAIT_MS = 10_000
const STARTUP_DETAIL_POLL_MS = 1_000

// Still starting: Desk is admitting the desk (a cold start takes a few seconds), or it is ready but its status detail has not loaded yet.
function startupPending(result) {
  if (result?.isError) return false
  try {
    const status = JSON.parse(result?.content?.[0]?.text ?? "null")
    return status?.state === "admitting" || status?.detail_pending === true
  } catch {
    return false
  }
}

/** The desk_status input that says this conversation already has Desk's instructions; the schema parity test holds tool-schemas.js to it. */
export const HAS_INSTRUCTIONS = "has_instructions"

/**
 * Wraps a hosted Desk's `callTool` so every successful desk_status answer carries `instructions` as a second text item, unless the call passes `has_instructions: true`. A client such as claude.ai never shows the model a server's MCP instructions, but every client shows a tool's answer, and Desk's instructions tell the agent to call desk_status first.
 * The boundary is the conversation, which only the agent knows: claude.ai reuses one MCP session across chats, so "once per session" would leave every later chat without them.
 * Each answer also waits, up to ten seconds in all, while Desk is still admitting the desk or loading its status detail, so a hosted chat does not start from an answer with an empty root and sync.
 */
export function withHostedStartup({ callTool, instructions, waitMs = STARTUP_DETAIL_WAIT_MS, pollMs = STARTUP_DETAIL_POLL_MS, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  return async (call) => {
    let result = await callTool(call)
    if (call?.name !== "desk_status" || result?.isError) return result
    for (let waited = 0; startupPending(result) && waited < waitMs && !call?.signal?.aborted; waited += pollMs) {
      await sleep(pollMs)
      result = await callTool(call)
    }
    if (result?.isError || call?.signal?.aborted || call?.input?.[HAS_INSTRUCTIONS] === true) return result
    const text = `# Desk instructions for this conversation\n\nThis client does not show Desk's server instructions, so they come with desk_status. Follow them for the rest of this conversation, and on later desk_status calls in it pass ${HAS_INSTRUCTIONS}: true, but only while these instructions are still in your context.\n\n${instructions}`
    return { ...result, content: [...(result?.content ?? []), { type: "text", text }] }
  }
}
