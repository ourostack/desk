// Maps a host's own tool name to the coarse `ENUMS.toolKind` bucket a facts
// file is allowed to carry. The tool name itself never leaves this function:
// only the bucket it resolves to is recorded in a fact.
//
// The returned bucket names are exactly the members of `ENUMS.toolKind` in
// `./schema.js`; `tool_kinds.test.js` checks that against the live enum so
// the two cannot drift silently.

const CLAUDE_SHELL = new Set(["Bash", "BashOutput", "KillShell"])
const CLAUDE_READ = new Set(["Read", "NotebookRead"])
const CLAUDE_EDIT = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])
const CLAUDE_SEARCH = new Set(["Grep", "Glob", "ToolSearch"])
const CLAUDE_WEB = new Set(["WebFetch", "WebSearch"])
const CLAUDE_AGENT = new Set(["Agent", "Task", "SendMessage"])
const CLAUDE_PLAN = new Set(["TodoWrite", "ExitPlanMode"])
const CLAUDE_DESK_MCP = /^mcp__.*desk.*__(task|track|friction|lesson|desk)_/u

function claudeToolKind(name) {
  if (CLAUDE_SHELL.has(name)) return "shell"
  if (CLAUDE_READ.has(name)) return "read"
  if (CLAUDE_EDIT.has(name)) return "edit"
  if (CLAUDE_SEARCH.has(name)) return "search"
  if (CLAUDE_WEB.has(name) || name.startsWith("mcp__Claude_Browser__") || name.startsWith("mcp__claude-in-chrome__")) return "web"
  if (CLAUDE_AGENT.has(name)) return "agent"
  if (CLAUDE_DESK_MCP.test(name)) return "desk"
  if (name === "Skill") return "skill"
  if (CLAUDE_PLAN.has(name)) return "plan"
  if (name.startsWith("mcp__")) return "mcp"
  return "other"
}

const COPILOT_SHELL = new Set(["bash", "powershell", "read_bash", "write_bash", "stop_bash"])
const COPILOT_EDIT = new Set(["apply_patch", "create", "edit"])
const COPILOT_SEARCH = new Set(["grep", "glob"])
const COPILOT_DESK_SUFFIXES = [
  "task_create", "task_update", "task_archive", "track_create", "track_update",
  "friction_add", "lesson_add", "desk_status", "desk_search", "desk_recall",
]

function copilotToolKind(name) {
  if (COPILOT_SHELL.has(name)) return "shell"
  if (name === "view") return "read"
  if (COPILOT_EDIT.has(name)) return "edit"
  if (COPILOT_SEARCH.has(name)) return "search"
  if (name === "web_fetch") return "web"
  if (name === "task") return "agent"
  if (COPILOT_DESK_SUFFIXES.some((suffix) => name.endsWith(suffix))) return "desk"
  if (name === "skill") return "skill"
  if (name.includes("-")) return "mcp"
  return "other"
}

const BY_HOST = {
  "claude-code": claudeToolKind,
  "copilot-cli": copilotToolKind,
}

/** `toolKind({ host, name }) -> ENUMS.toolKind value`. */
export function toolKind({ host, name }) {
  return BY_HOST[host](name)
}
