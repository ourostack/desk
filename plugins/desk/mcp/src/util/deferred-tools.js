// Desk's MCP tools can arrive deferred (a host lists their names but loads no schema until asked), and a call to one
// that is not loaded fails. Boot ordered a `desk_status` check to prove the tools were there; agents skipped it in 11
// of 12 runs and then lost time hunting for the tool when they first needed it (boot acceptance round B). This is the
// one hint boot and the task-card guard both give instead: load the exact tools when first needed.

// The tool's name depends on the host (round I, Copilot CLI: a Haiku agent knew only the Claude Code name, called `desk-task_update` through the shell,
// found nothing and left the card unupdated). Claude Code: `mcp__plugin_desk_desk__<name>`, loaded with ToolSearch. Copilot CLI: `desk-<name>` (server
// `desk`, a hyphen, the tool), called as a tool; its event log shows `"name":"desk-task_update"`. Codex and an unknown host get both names, since
// the hint cannot tell which applies. `host` is `detectAgentHost`'s answer ("claude", "copilot", "codex" or "unknown").

const CLAUDE_HINT =
  "If your host defers tools, Desk's may be listed by name without being loaded: load the exact ones you need before first use " +
  "(Claude Code: ToolSearch `select:mcp__plugin_desk_desk__task_update,mcp__plugin_desk_desk__desk_status`; every Desk tool is `mcp__plugin_desk_desk__<name>`: " +
  "task_update, task_create, task_move, task_archive, task_focus, desk_status, desk_search and the rest)."

const COPILOT_HINT =
  "Desk's tools are named `desk-<name>` here, such as `desk-task_update`, `desk-task_create`, `desk-task_move`, `desk-task_archive`, `desk-task_focus` and `desk-desk_status`: " +
  "call them as tools (never through the shell), and if one is not in your tool list, look it up by that name before concluding it is missing."

const GENERIC_HINT =
  "If your host defers tools, Desk's may be listed by name without being loaded: load the exact ones you need before first use. " +
  "Claude Code: ToolSearch `select:mcp__plugin_desk_desk__task_update,mcp__plugin_desk_desk__desk_status` (every Desk tool is `mcp__plugin_desk_desk__<name>`). " +
  "Copilot CLI: `desk-<name>`, such as `desk-task_update`, called as a tool and never through the shell."

const REPAIR = " If a Desk tool is still absent after that, repair first (see the session-start skill) and never continue silently in local-only mode."

/** The one line that tells an agent on `host` how to find and call Desk's tools. */
export function deferredToolsLoadHint(host) {
  if (host === "claude") return CLAUDE_HINT
  if (host === "copilot") return COPILOT_HINT
  return GENERIC_HINT
}

// Boot acceptance round S: a Haiku agent found and loaded the tool, then tried Bash scripts, a Node require and file edits instead of calling it, and overclaimed.
const CALL_IT = " Once a lookup returns a Desk tool it is loaded: call it directly as a tool, never through Bash, Node or file edits. If the card cannot be updated, say so in your reply and give the task's real status."

/** `deferredToolsLoadHint` plus the repair rule and the call-it rule boot gives. */
export function deferredToolsHint(host) {
  return `${deferredToolsLoadHint(host)}${REPAIR}${CALL_IT}`
}

// Hostless callers (the git pre-commit hook text) give both names.
export const DEFERRED_TOOLS_LOAD_HINT = deferredToolsLoadHint("unknown")

export const DEFERRED_TOOLS_HINT = deferredToolsHint("unknown")
