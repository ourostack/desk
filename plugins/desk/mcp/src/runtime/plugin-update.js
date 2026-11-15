// A plugin-update notice for boot and desk_status. The Copilot app keeps a skill's text in memory for the life of its
// process, so the skills of every plugin it loaded (Desk's own, MS Desk, cit, Crew, ...) stay as they were at the app's
// start. Desk's tools update in place (`./newest-release.js`); skills do not. Agency's cache already holds the newer
// release, and this process's sibling roots (`<agency data>/plugins/sessions/agency-plugin-<id>.p<pid>/root-N/<plugin>`)
// show what it loaded, so the comparison is a few local reads: no network, no budget, no failure that can reach boot.
//
// When a loaded plugin is older than the newest release Agency has fetched, the finding carries one plain line the agent
// can say once per session. On a Mac where Housesitter's auto-restart job is installed (its launchd agent file exists),
// the line says the app will restart by itself instead.

import { existsSync, readdirSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { agencyCache } from "./desk-channel.js"
import { compareVersions } from "./stale-desk.js"
import { looksLikeNodeTestRunner } from "./test-state-guard.js"

/** The launchd agent Housesitter's `restart-copilot --install-plugin-updates` writes. */
export const HOUSESITTER_AGENT_LABEL = "bot.ouro.housesitter.plugin-update-restart"

// <...>/agency-plugin-<id>[.p<pid>]/root-N/<plugin>: the layout of a session's plugin roots.
const SESSION_ROOT = /^(.*[\\/]agency-plugin-[^\\/]+)[\\/]root-\d+[\\/][^\\/]+$/u
const PINNED = /@[0-9a-f]{40}$/u

function manifest(dir) {
  for (const file of [path.join(dir, "plugin.json"), path.join(dir, ".claude-plugin", "plugin.json")]) {
    try {
      const { name, version } = JSON.parse(readFileSync(file, "utf8"))
      if (typeof name === "string" && typeof version === "string" && compareVersions(version, version) !== null) return { name, version }
    } catch {
      // not this one
    }
  }
  return null
}

/** The plugins this process loaded: every plugin folder in the session folder's root-N siblings of Desk's own, as [{ name, version }]. */
export function loadedPlugins(sessionDir) {
  const out = []
  let roots = []
  try {
    roots = readdirSync(sessionDir).filter((entry) => /^root-\d+$/u.test(entry))
  } catch {
    return out
  }
  for (const root of roots) {
    try {
      for (const plugin of readdirSync(path.join(sessionDir, root))) {
        const found = manifest(path.join(sessionDir, root, plugin))
        if (found !== null) out.push(found)
      }
    } catch {
      // a root that vanished while Agency tidied up
    }
  }
  return out
}

/** The newest release Agency has fetched for each plugin: this engine's unpinned entries (a branch or tag), the most recently fetched per name. Map name -> version. */
export function newestFetched(cacheDir, engine) {
  const newest = new Map()
  let entries = {}
  try {
    entries = JSON.parse(readFileSync(path.join(cacheDir, "cache_index.json"), "utf8")).entries ?? {}
  } catch {
    return new Map()
  }
  for (const entry of Object.values(entries)) {
    if (typeof entry?.spec !== "string" || !entry.spec.startsWith(`${engine}:`) || PINNED.test(entry.spec) || typeof entry.dir_name !== "string") continue
    const found = manifest(path.join(cacheDir, "entries", entry.dir_name))
    const fetched = Number(entry.fetched_at)
    if (found !== null && (!newest.has(found.name) || fetched > newest.get(found.name).fetched)) newest.set(found.name, { version: found.version, fetched })
  }
  return new Map([...newest].map(([name, { version }]) => [name, version]))
}

/** Is Housesitter's auto-restart job installed on this Mac? */
export function housesitterRestartsApp({ homeDir = os.homedir(), platform = process.platform } = {}) {
  return platform === "darwin" && existsSync(path.join(homeDir, "Library", "LaunchAgents", `${HOUSESITTER_AGENT_LABEL}.plist`))
}

const list = (plugins) => plugins.map((p) => `${p.name} (${p.from} → ${p.to})`).join(", ")

/** The one line for the agent, in the words of the two cases. */
export function pluginUpdateLine(plugins, autoRestart) {
  return autoRestart
    ? `There's an update to ${list(plugins)}; Housesitter on this Mac will restart the app to pick it up when nobody is using it, and each session is asked to reach a safe point first and is resumed after.`
    : `There's an update to ${list(plugins)}; restart the Copilot app when it suits you to pick it up.`
}

/**
 * `{ plugins: [{ name, from, to }], auto_restart, relay, line }` when a plugin this process loaded is older than the newest release Agency has
 * fetched, else null. Never throws. `skip` names plugins another line already covers (Desk itself, when the stale-Desk line is printed).
 */
export function pluginUpdateFinding({ env = process.env, pluginRoot, agentHost, homeDir = os.homedir(), platform = process.platform, skip = [] } = {}) {
  try {
    // The launcher's own root is the Agency session copy; boot may run from a newer release copy that is not in a session folder.
    const candidates = [env.DESK_PLUGIN_ROOT, env.CLAUDE_PLUGIN_ROOT, pluginRoot].filter((value) => typeof value === "string" && value !== "")
    const root = candidates.map((candidate) => path.resolve(candidate)).find((candidate) => SESSION_ROOT.test(candidate))
    if (root === undefined) return null
    const cache = agencyCache({ env, agentHost, pluginRoot: root, homeDir })
    if (cache === null) return null
    const newest = newestFetched(cache.cacheDir, cache.engine)
    const behind = new Map()
    for (const loaded of loadedPlugins(SESSION_ROOT.exec(root)[1])) {
      const to = newest.get(loaded.name)
      if (to === undefined || skip.includes(loaded.name) || !(compareVersions(loaded.version, to) < 0)) continue
      const had = behind.get(loaded.name)
      if (had === undefined || compareVersions(loaded.version, had.from) < 0) behind.set(loaded.name, { name: loaded.name, from: loaded.version, to })
    }
    if (behind.size === 0) return null
    const plugins = [...behind.values()].sort((a, b) => a.name.localeCompare(b.name))
    const autoRestart = housesitterRestartsApp({ homeDir, platform })
    return {
      plugins,
      auto_restart: autoRestart,
      relay: "Tell the person once per session; skip it if you already have.",
      line: pluginUpdateLine(plugins, autoRestart),
    }
  } catch {
    return null
  }
}

/** `pluginUpdateFinding` that stays off in a node:test run, so a developer's own Agency session never leaks into a test; tests hand their own function. */
export function checkPluginUpdate(options) {
  return looksLikeNodeTestRunner(options?.env ?? process.env) ? null : pluginUpdateFinding(options)
}
