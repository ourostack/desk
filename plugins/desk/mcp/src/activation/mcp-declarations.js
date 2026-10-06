// Rules for how Desk declares MCP servers to each host, and a reader for every declaration it ships.
//
// Two failures on 2026-10-01 motivated this file. Desk named its browser server `web`, and Copilot with an
// OpenAI model rejected every request: "400 Invalid Value: 'tools'. Function 'web.web-browser_click' is not
// allowed in reserved namespace 'web'". The first fix renamed the server only in `.mcp.copilot.json`, which
// `plugin.json` names, while Copilot CLI 1.0.89 and 1.0.91 build plugin servers from `.mcp.json`, so a clean
// install still exposed `web-browser_click`. The rules below catch both: a name the model APIs reserve, and
// declaration files that stop agreeing with each other.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

/**
 * Server names that model APIs reserve for their own tool namespaces. A server with one of these names
 * makes the host's function names (`<server>-<tool>`) collide with the reserved namespace and the whole
 * request is rejected (2026-10-01: `web`). Add to this list; never remove from it.
 */
export const RESERVED_MCP_SERVER_NAMES = Object.freeze([
  "web",
  "functions",
  "multi_tool_use",
  "browser",
  "python",
  "container",
  "file_search",
  "computer",
  "image_gen",
  "tool",
  "tools",
  "default",
  "api",
  "mcp",
])

/** Server names stay lowercase letters, digits and hyphens so every host builds a valid function name from them. */
export const SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u

/** The common function-name limit across model APIs. */
export const MAX_FUNCTION_NAME_LENGTH = 64

const COPILOT_ROOT_VARIABLE = "${COPILOT_PLUGIN_ROOT}"
const MANIFESTS = ["plugin.json", ".claude-plugin/plugin.json", ".codex-plugin/plugin.json"]
const MCP_FILE = /^\.mcp(\..+)?\.json$/u

function readJson(file) {
  return JSON.parse(readFileSync(file, "utf8"))
}

function toRepoPath(repoRoot, file) {
  return path.relative(repoRoot, file).split(path.sep).join("/")
}

/**
 * The problems with one server name, given the tool names the server exposes. Measures `<server>-<tool>`
 * (Copilot) and, when `claudePlugin` is given, `mcp__plugin_<plugin>_<server>__<tool>` (Claude Code).
 */
export function checkServerName(name, toolNames, { claudePlugin } = {}) {
  const errors = []
  if (RESERVED_MCP_SERVER_NAMES.includes(name)) {
    errors.push(`server "${name}" is a reserved name (model APIs reserve ${RESERVED_MCP_SERVER_NAMES.join(", ")}); pick another, as desk-web replaced web on 2026-10-01`)
  }
  if (!SERVER_NAME_PATTERN.test(name)) {
    errors.push(`server "${name}" must match ${SERVER_NAME_PATTERN.source}`)
  }
  const longest = toolNames.reduce((best, tool) => (tool.length > best.length ? tool : best), "")
  const forms = [`${name}-${longest}`]
  if (claudePlugin !== undefined) forms.push(`mcp__plugin_${claudePlugin}_${name}__${longest}`)
  for (const form of forms) {
    if (form.length > MAX_FUNCTION_NAME_LENGTH) {
      errors.push(`server "${name}" with its longest tool is ${form.length} characters as "${form}", over the ${MAX_FUNCTION_NAME_LENGTH}-character function-name limit`)
    }
  }
  return errors
}

/**
 * Every MCP declaration Desk ships, under `plugins/*`: `.mcp*.json` files, the `mcpServers` of each plugin
 * manifest (an inline object, or a path to one of those files), the manifests' per-host activation blocks,
 * and the `mcp_servers` of each activation manifest. Entries come back sorted by source path.
 */
export function collectMcpDeclarations({ repoRoot }) {
  const pluginsDir = path.join(repoRoot, "plugins")
  const entries = []
  for (const plugin of readdirSync(pluginsDir, { withFileTypes: true }).filter((item) => item.isDirectory())) {
    const pluginDir = path.join(pluginsDir, plugin.name)
    const add = (file, fields) => entries.push({ source: toRepoPath(repoRoot, file), plugin: plugin.name, ...fields })
    for (const item of readdirSync(pluginDir)) {
      if (!MCP_FILE.test(item)) continue
      const servers = readJson(path.join(pluginDir, item)).mcpServers ?? {}
      add(path.join(pluginDir, item), { host: item === ".mcp.copilot.json" ? "copilot" : "shared", names: Object.keys(servers), servers })
    }
    for (const manifest of MANIFESTS) {
      const file = path.join(pluginDir, manifest)
      if (!existsSync(file)) continue
      const body = readJson(file)
      const names = []
      const fields = { host: "manifest" }
      if (typeof body.mcpServers === "string") {
        const target = path.resolve(pluginDir, body.mcpServers)
        fields.reference = toRepoPath(repoRoot, target)
        if (existsSync(target)) names.push(...Object.keys(readJson(target).mcpServers ?? {}))
        else fields.missing = fields.reference
      } else if (body.mcpServers !== undefined) {
        names.push(...Object.keys(body.mcpServers))
      }
      for (const block of Object.values(body.activation ?? {})) {
        names.push(...Object.keys(block?.mcpServers ?? {}))
      }
      if (names.length > 0 || fields.missing !== undefined) add(file, { ...fields, names: [...new Set(names)] })
    }
    const activationDir = path.join(pluginDir, "activation")
    if (existsSync(activationDir)) {
      for (const item of readdirSync(activationDir).filter((entry) => entry.endsWith(".activation.json"))) {
        const ids = (readJson(path.join(activationDir, item)).mcp_servers ?? []).map((server) => server.id)
        if (ids.length > 0) add(path.join(activationDir, item), { host: "activation", names: ids })
      }
    }
  }
  return entries.sort((a, b) => a.source.localeCompare(b.source, "en"))
}

/**
 * The server names a source file spells out in code instead of reading from a declaration: TOML tables such as `[mcp_servers.desk]` and
 * `.mcp_servers.desk]`, and path arrays such as `["mcp_servers", "desk"]`. The Codex adapter writes its config tables this way, so a rename
 * in `.mcp.json` would leave it configuring a server that no longer exists.
 */
export function hardCodedServerNames(source) {
  const names = new Set()
  for (const match of String(source).matchAll(/\bmcp_servers\.([A-Za-z0-9_-]+)|["']mcp_servers["']\s*,\s*["']([A-Za-z0-9_-]+)["']/gu)) names.add(match[1] ?? match[2])
  return [...names].sort()
}

/** The problems with hard-coded server names: each must be a server some declaration under `plugins/*` declares. */
export function checkHardCodedServerNames({ source, names, declared }) {
  return names.filter((name) => !declared.includes(name)).map((name) => `${source} hard-codes the MCP server "${name}", which no declaration under plugins/* declares (declared: ${declared.join(", ")})`)
}

/**
 * Every problem in the collected declarations. `toolNames` maps each server to the tool names it exposes, by `<plugin>/<server>` when two plugins
 * declare the same server name with different tools, and by the bare server name otherwise.
 */
export function validateMcpDeclarations({ declarations, toolNames }) {
  const errors = []
  for (const entry of declarations) {
    if (entry.missing !== undefined) errors.push(`${entry.source}: mcpServers points at ${entry.missing}, which does not exist`)
    for (const name of entry.names) {
      const tools = toolNames[`${entry.plugin}/${name}`] ?? toolNames[name]
      for (const problem of checkServerName(name, tools ?? [], { claudePlugin: entry.plugin })) {
        errors.push(`${entry.source}: ${problem}`)
      }
      if (tools === undefined) {
        errors.push(`${entry.source}: server "${name}" has no registered tool names, so its function-name length cannot be checked; register them with the integrity test`)
      }
    }
  }
  return errors
}

/** The `mcp/<file>` entry files a launch declaration starts: a direct path argument, or the names an inline launcher joins. */
export function launcherEntryFiles(server) {
  const found = new Set()
  for (const arg of server.args ?? []) {
    for (const match of String(arg).matchAll(/'mcp'\s*,\s*'([^']+)'/gu)) found.add(match[1])
    const direct = /(?:^|[\\/])mcp[\\/]([^\\/]+)$/u.exec(String(arg))
    if (direct !== null) found.add(direct[1])
  }
  return [...found].sort()
}

/**
 * Problems where the Claude-style `.mcp.json` and the Copilot `.mcp.copilot.json` have drifted: different
 * server names, type or command, a Copilot launch that does not start `${COPILOT_PLUGIN_ROOT}/mcp/<file>`,
 * or a different entry file than the Claude launcher starts.
 */
export function checkHostDeclarationParity({ claude, copilot }) {
  const errors = []
  const claudeNames = Object.keys(claude).sort()
  const copilotNames = Object.keys(copilot).sort()
  if (JSON.stringify(claudeNames) !== JSON.stringify(copilotNames)) {
    errors.push(`server names differ: .mcp.json declares [${claudeNames.join(", ")}] but .mcp.copilot.json declares [${copilotNames.join(", ")}]`)
  }
  for (const name of claudeNames.filter((item) => copilotNames.includes(item))) {
    for (const field of ["type", "command"]) {
      if (claude[name][field] !== copilot[name][field]) {
        errors.push(`"${name}": ${field} differs (${claude[name][field]} vs ${copilot[name][field]})`)
      }
    }
    const claudeEntries = launcherEntryFiles(claude[name])
    const copilotArgs = copilot[name].args ?? []
    const copilotEntry = copilotArgs.length === 1
      ? new RegExp(`^${COPILOT_ROOT_VARIABLE.replace(/[$.{}]/gu, "\\$&")}/mcp/([^/]+)$`, "u").exec(copilotArgs[0])
      : null
    if (claudeEntries.length !== 1) errors.push(`"${name}": the .mcp.json launcher names no mcp/<file> entry (or several)`)
    if (copilotEntry === null) errors.push(`"${name}": the Copilot launch must be one argument, ${COPILOT_ROOT_VARIABLE}/mcp/<file>`)
    if (claudeEntries.length === 1 && copilotEntry !== null && copilotEntry[1] !== claudeEntries[0]) {
      errors.push(`"${name}": copilot launches ${copilotEntry[1]} but claude launches ${claudeEntries[0]}`)
    }
  }
  return errors
}
