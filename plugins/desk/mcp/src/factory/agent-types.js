// The agent types a harness defines itself, and the rule that keeps every other
// agent type on the machine. A local fact keeps whatever type the harness
// recorded; a published fact keeps only a built-in type of that host, or a
// `<plugin>:<name>` type whose plugin the publish path already names publicly.
// Everything else publishes as `custom`, so a private agent's name never leaves
// the machine.
//
// Imports nothing: `src/factory/**` takes only `node:` built-ins and its own files.

/** The fallback a published fact carries for any agent type it may not name. */
export const CUSTOM_AGENT_TYPE = "custom"

/**
 * The built-in agent types per host. Claude Code: the types its own Agent tool
 * ships. Copilot CLI: empty until Task 3 adds the names the Copilot source
 * defines (this repo's Copilot fixtures carry only sentinel agent names).
 * Codex CLI: empty until Task 4 fills it from the Codex source.
 */
export const BUILTIN_AGENT_TYPES = Object.freeze({
  "claude-code": Object.freeze([
    "general-purpose", "Explore", "Plan", "statusline-setup", "claude-code-guide", "output-style-setup",
  ]),
  "copilot-cli": Object.freeze([]),
  "codex-cli": Object.freeze([]),
})

/**
 * `publishedAgentType(host, agentType, publicPlugins) -> string`. `publicPlugins`
 * is a collection (array or Set) of the plugin names that publish names in
 * the store this file goes to.
 */
export function publishedAgentType(host, agentType, publicPlugins) {
  const builtins = Object.hasOwn(BUILTIN_AGENT_TYPES, host) ? BUILTIN_AGENT_TYPES[host] : []
  if (builtins.includes(agentType)) return agentType
  const colon = agentType.indexOf(":")
  if (colon > 0 && new Set(publicPlugins).has(agentType.slice(0, colon))) return agentType
  return CUSTOM_AGENT_TYPE
}
