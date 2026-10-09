// The hosted Desk: what changes when Desk's MCP server runs as a service (DESK_HOSTED=1) behind a gateway, not on the operator's own machine.
//
// Four things live here: the flag, the short list of tools and doctor repairs a hosted Desk refuses (each with the reason a person can act on), the MCP annotations every tool carries so a host such as claude.ai can tell reading from writing, and the MCP instructions that stand in for session start in a hosted chat.
//
// The front door imports this before the runtime pack is restored, so it imports only `node:` modules and the tool names.

import { closeSync, openSync, readFileSync, readSync } from "node:fs"
import * as path from "node:path"
import { TOOL_NAMES } from "../tool-names.js"

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

const READ_ONLY = new Set(["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread", "desk_status"])
// Tools that can remove or overwrite what was there: archive and move relocate a task, rename a track rewrites its path, and desk_save replaces files.
const DESTRUCTIVE = new Set(["task_archive", "task_move", "track_rename", "desk_save"])

// desk_doctor is not read-only even though a read-only session may call it: its repairs change state.
export const TOOL_ANNOTATIONS = Object.freeze(Object.fromEntries(TOOL_NAMES.map((name) => [
  name,
  Object.freeze({ readOnlyHint: READ_ONLY.has(name), destructiveHint: DESTRUCTIVE.has(name) }),
])))

// The same cap boot uses for AGENTS.md (runtime/boot-text.js). That module imports the factory and the frontmatter parser, too much for the front door, so the file is read here with node:fs alone.
const AGENTS_MD_CAP_BYTES = 16 * 1024
const DESK_STATUS_FIRST = "Start by calling desk_status: it is this session's startup status block."

/**
 * The MCP instructions a hosted Desk sends with its initialize answer, in place of the session-start hook a hosted chat does not have: the using-desk foundation (frontmatter stripped), the desk's AGENTS.md, then what this hosted Desk refuses and why, ending with the desk_status line.
 * Synchronous and built from file reads only, so the handshake never waits. A file that is missing or unreadable is left out.
 */
export function hostedInstructions({ root, pluginRoot }) {
  const sections = []
  const foundation = typeof pluginRoot === "string" ? readText(path.join(pluginRoot, "skills", "using-desk", "SKILL.md")) : null
  if (foundation !== null) sections.push(foundation.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, "").trim())
  const agents = typeof root === "string" ? readCapped(path.join(root, "AGENTS.md"), AGENTS_MD_CAP_BYTES) : null
  if (agents !== null) {
    const note = agents.truncated ? `\n\n(AGENTS.md is longer than 16 KiB; the rest stays in ${agents.file}.)` : ""
    sections.push(`# This desk's AGENTS.md\n\n${agents.text.trim()}${note}`)
  }
  const list = (entries) => Object.entries(entries).map(([name, reason]) => `- \`${name}\`: ${reason}`).join("\n")
  sections.push([
    "# Hosted Desk",
    "This Desk runs as a hosted service: there is no shell, git or plugin script here, so the session-start hook has not run and these are unavailable.",
    `Tools Desk refuses here:\n${list(HOSTED_UNAVAILABLE)}`,
    `desk_doctor repairs Desk refuses here:\n${list(HOSTED_UNAVAILABLE_REPAIRS)}`,
    `Skills to skip, because they need a shell:\n${list(HOSTED_SHELL_SKILLS)}`,
    DESK_STATUS_FIRST,
  ].join("\n\n"))
  return `${sections.join("\n\n")}\n`
}

function readText(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

// At most `cap` bytes of `file`, cut at the last line break inside the cap so a rule is never shown half-written (or, with none, at a character boundary), as boot does.
function readCapped(file, cap) {
  let fd
  try {
    fd = openSync(file, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(cap + 1)
    const bytesRead = readSync(fd, buffer, 0, cap + 1, 0)
    if (bytesRead <= cap) return { file, text: buffer.toString("utf8", 0, bytesRead), truncated: false }
    let end = buffer.subarray(0, cap).lastIndexOf(0x0a)
    if (end === -1) {
      end = cap
      while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1
    }
    return { file, text: buffer.toString("utf8", 0, end), truncated: true }
  } catch {
    return null
  } finally {
    closeSync(fd)
  }
}
