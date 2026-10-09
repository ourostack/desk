// The hosted Desk: what changes when Desk's MCP server runs as a service (DESK_HOSTED=1) behind a gateway, not on the operator's own machine.
//
// Three things live here: the flag, the short list of tools and doctor repairs a hosted Desk refuses (each with the reason a person can act on), and the MCP annotations every tool carries so a host such as claude.ai can tell reading from writing.
//
// The front door imports this before the runtime pack is restored, so it imports only `node:` modules and the tool names.

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
