// A plugin-update notice for boot and desk_status. The Copilot app keeps a skill's text in memory for the life of its
// process, so the skills of every plugin it loaded (Desk's own, MS Desk, cit, Crew, ...) stay as they were at the app's
// start. Desk's tools update in place (`./newest-release.js`); skills do not. Agency's cache already holds the newer
// release, and this process's sibling roots (`<agency data>/plugins/sessions/agency-plugin-<id>.p<pid>/root-N/<plugin>`)
// show what it loaded, so the comparison is a few local reads: no network, no budget, no failure that can reach boot.
//
// When a loaded plugin is older than the newest release Agency has fetched, and the newer release differs in something a
// process fixes at its start, the finding carries one plain line the agent can say once per session. A release that
// changes only Desk's runtime (`mcp/src`, which updates in place) is no reason to restart, so it is not announced. On a
// Mac where Housesitter's auto-restart job is installed (its launchd agent file exists), the line says the app will
// restart by itself instead.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { agencyCache } from "./desk-channel.js"
import { compareVersions } from "./stale-desk.js"
import { looksLikeNodeTestRunner } from "./test-state-guard.js"

/** The launchd agent Housesitter's `restart-copilot --install-plugin-updates` writes. */
export const HOUSESITTER_AGENT_LABEL = "bot.ouro.housesitter.plugin-update-restart"

// <...>/agency-plugin-<id>[.p<pid>]/root-N/<plugin>: the layout of a session's plugin roots.
const SESSION_ROOT = /^(.*[\\/]agency-plugin-[^\\/]+)[\\/]root-\d+[\\/][^\\/]+$/u
const PINNED = /@[0-9a-f]{40}$/u

const list = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

function manifest(dir) {
  for (const file of [path.join(dir, "plugin.json"), path.join(dir, ".claude-plugin", "plugin.json")]) {
    try {
      const { name, version } = JSON.parse(readFileSync(file, "utf8"))
      // A version that is not semver (or not text) fails the comparison with itself.
      if (typeof name === "string" && compareVersions(version, version) !== null) return { name, version }
    } catch {
      // not this one
    }
  }
  return null
}

/** The plugins this process loaded: every plugin folder in the session folder's root-N siblings of Desk's own, as [{ name, version, dir }]. */
export function loadedPlugins(sessionDir) {
  const out = []
  for (const root of list(sessionDir).filter((entry) => /^root-\d+$/u.test(entry))) {
    for (const plugin of list(path.join(sessionDir, root))) {
      const dir = path.join(sessionDir, root, plugin)
      const found = manifest(dir)
      if (found !== null) out.push({ ...found, dir })
    }
  }
  return out
}

/** The newest release Agency has fetched for each plugin: this engine's unpinned entries (a branch or tag), the most recently fetched per name. Map name -> { version, dir }. */
function newestReleases(cacheDir, engine) {
  let entries
  try {
    entries = Object.values(JSON.parse(readFileSync(path.join(cacheDir, "cache_index.json"), "utf8")).entries)
  } catch {
    return new Map()
  }
  const newest = new Map()
  for (const entry of entries) {
    if (typeof entry?.spec !== "string" || !entry.spec.startsWith(`${engine}:`) || PINNED.test(entry.spec) || typeof entry.dir_name !== "string") continue
    const dir = path.join(cacheDir, "entries", entry.dir_name)
    const found = manifest(dir)
    const fetched = Number(entry.fetched_at)
    if (found !== null && (!newest.has(found.name) || fetched > newest.get(found.name).fetched)) newest.set(found.name, { version: found.version, dir, fetched })
  }
  return newest
}

/** Map name -> version of `newestReleases`. */
export const newestFetched = (cacheDir, engine) => new Map([...newestReleases(cacheDir, engine)].map(([name, { version }]) => [name, version]))

// What a process fixes at its start: its skills (text and descriptions), hooks, agents, manifests and MCP config, and for Desk
// its MCP session layer (the tool names, descriptions and schemas the host registered). Housesitter's plugin-update job applies
// the same rule when it decides to restart; keep the two lists in step.
const FIXED_PER_PROCESS = ["skills/", "agents/", "hooks/", "plugin.json", ".claude-plugin/plugin.json", ".mcp.json", ".mcp.copilot.json", ".mcp.claude-codex.json", "agency.json", "settings.json"]
const DESK_SESSION_LAYER = ["mcp/src/tool-names.js", "mcp/src/tool-schemas.js", "mcp/src/tool-schema-parts.js", "mcp/web-catalog.json"]

function collect(root, paths) {
  const files = new Map()
  const add = (rel) => {
    const full = path.join(root, ...rel.split("/"))
    let info
    try {
      info = statSync(full)
    } catch {
      return
    }
    if (info.isFile()) files.set(rel, full)
    else for (const entry of list(full)) add(`${rel}/${entry}`)
  }
  for (const rel of paths) add(rel.replace(/\/$/u, ""))
  return files
}

function contentOf(file, rel) {
  try {
    const buffer = readFileSync(file)
    if (!rel.endsWith("plugin.json")) return buffer
    const manifestJson = JSON.parse(buffer.toString("utf8"))
    delete manifestJson.version
    return Buffer.from(JSON.stringify(manifestJson))
  } catch {
    return null
  }
}

/** Does the newer release differ, in a file a process fixes at its start, from the copy a session loaded? (A manifest is compared without its version.) */
export function changesPerProcess(loadedDir, newDir, name) {
  const paths = name === "desk" ? [...FIXED_PER_PROCESS, ...DESK_SESSION_LAYER] : FIXED_PER_PROCESS
  const before = collect(loadedDir, paths)
  const after = collect(newDir, paths)
  for (const rel of new Set([...before.keys(), ...after.keys()])) {
    const a = before.has(rel) ? contentOf(before.get(rel), rel) : null
    const b = after.has(rel) ? contentOf(after.get(rel), rel) : null
    if (a === null || b === null || !a.equals(b)) return true
  }
  return false
}

/** Is Housesitter's auto-restart job installed on this Mac? (Its launchd agent file exists; no other OS has the folder.) */
export function housesitterRestartsApp(homeDir) {
  return existsSync(path.join(homeDir, "Library", "LaunchAgents", `${HOUSESITTER_AGENT_LABEL}.plist`))
}

const named = (plugins) => plugins.map((p) => `${p.name} (${p.from} → ${p.to})`).join(", ")

/** The one line for the agent, in the words of the two cases. */
export function pluginUpdateLine(plugins, autoRestart) {
  return autoRestart
    ? `There's an update to ${named(plugins)}; Housesitter on this Mac will restart the app to pick it up when nobody is using it, and each session is asked to reach a safe point first and is resumed after.`
    : `There's an update to ${named(plugins)}; restart the Copilot app when it suits you to pick it up.`
}

/**
 * `{ plugins: [{ name, from, to }], auto_restart, relay, line }` when a plugin this process loaded is older than the newest release Agency has
 * fetched, else null. Never throws. `skip` names plugins another line already covers (Desk itself, when the stale-Desk line is printed).
 */
export function pluginUpdateFinding({ env, pluginRoot, agentHost, homeDir, skip }) {
  try {
    // The launcher's own root is the Agency session copy; boot may run from a newer release copy that is not in a session folder.
    const root = [env.DESK_PLUGIN_ROOT, env.CLAUDE_PLUGIN_ROOT, pluginRoot]
      .filter((value) => typeof value === "string" && value !== "")
      .map((value) => path.resolve(value))
      .find((value) => SESSION_ROOT.test(value))
    if (root === undefined) return null
    const cache = agencyCache({ env, agentHost, pluginRoot: root, homeDir })
    if (cache === null) return null
    const newest = newestReleases(cache.cacheDir, cache.engine)
    const behind = new Map()
    for (const loaded of loadedPlugins(SESSION_ROOT.exec(root)[1])) {
      const release = newest.get(loaded.name)
      if (release === undefined || skip.includes(loaded.name) || compareVersions(loaded.version, release.version) >= 0) continue
      if (!changesPerProcess(loaded.dir, release.dir, loaded.name)) continue
      const seen = behind.get(loaded.name)
      if (seen === undefined || compareVersions(loaded.version, seen.from) < 0) behind.set(loaded.name, { name: loaded.name, from: loaded.version, to: release.version })
    }
    if (behind.size === 0) return null
    const plugins = [...behind.values()].sort((a, b) => a.name.localeCompare(b.name))
    const autoRestart = housesitterRestartsApp(homeDir)
    return { plugins, auto_restart: autoRestart, relay: "Tell the person once per session; skip it if you already have.", line: pluginUpdateLine(plugins, autoRestart) }
  } catch {
    return null
  }
}

/** `pluginUpdateFinding` that stays off in a node:test run, so a developer's own Agency session never leaks into a test; tests hand their own function. */
export function checkPluginUpdate(options) {
  // istanbul ignore else -- a node:test run always takes this branch; outside one the real check runs.
  if (looksLikeNodeTestRunner(options.env)) return null
  // istanbul ignore next
  return pluginUpdateFinding(options)
}
