// How an agent calls one of Desk's own tools on its host: Claude Code names an MCP tool `mcp__plugin_desk_desk__<tool>`,
// Copilot CLI `desk-<tool>`, and any other host (Codex, unknown) gets the bare name. The same host ids as
// `../util/deferred-tools.js`'s `deferredToolsLoadHint`, which says how to load the tool when a host defers it.
export function deskToolName(host, tool) {
  if (host === "claude") return `mcp__plugin_desk_desk__${tool}`
  if (host === "copilot") return `desk-${tool}`
  return tool
}
