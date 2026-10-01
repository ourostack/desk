// Desk's MCP tools can arrive deferred (a host lists their names but loads no schema until asked), and a call to one
// that is not loaded fails. Boot ordered a `desk_status` check to prove the tools were there; agents skipped it in 11
// of 12 runs and then lost time hunting for the tool when they first needed it (boot acceptance round B). This is the
// one hint boot and the task-card guard both give instead: load the exact tools when first needed.

export const DEFERRED_TOOLS_LOAD_HINT =
  "If your host defers tools, Desk's may be listed by name without being loaded: load the exact ones you need before first use " +
  "(Claude Code: ToolSearch `select:mcp__plugin_desk_desk__task_update,mcp__plugin_desk_desk__desk_status`; every Desk tool is `mcp__plugin_desk_desk__<name>`: " +
  "task_update, task_create, task_move, task_archive, desk_status, desk_search and the rest)."

export const DEFERRED_TOOLS_HINT =
  `${DEFERRED_TOOLS_LOAD_HINT} If a Desk tool is still absent after that, repair first (see the session-start skill) and never continue silently in local-only mode.`
