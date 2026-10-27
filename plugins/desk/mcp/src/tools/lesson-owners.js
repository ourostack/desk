// lesson_add's owners: the plugins a desk lesson can be filed against.
//
// A machine can run several hosts, each with its own plugins: MS Desk may be installed for Copilot only, while the lesson
// is recorded from Claude Code. So the owners are every plugin installed for any host on this machine, read from where
// each host keeps them, never from a fixed list:
//
// - the running Desk and what this session's host has installed beside it (`scan`, the factory's own reading);
// - Claude Code's registry, `<CLAUDE_CONFIG_DIR or ~/.claude>/plugins/installed_plugins.json`;
// - Copilot CLI's own installs, `<COPILOT_HOME or ~/.copilot>/installed-plugins/<marketplace>/<plugin>/`;
// - Agency's cache, which Copilot sessions under Agency copy their plugins from, `~/.local/agency/plugins/cache`;
// - Codex's plugin folder, `<CODEX_HOME or ~/.codex>/plugins/`, read a few levels deep.
//
// A host's folders keep old versions beside the active one; only the running Desk and the newest version of each other
// plugin count, so a skill an upgrade removed is no owner. Every read is bounded and anything unreadable is skipped.

import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { deskPluginRoot } from "../package-metadata.js"
import { compareVersions } from "../runtime/stale-desk.js"

const MANIFESTS = ["plugin.json", path.join(".claude-plugin", "plugin.json"), path.join(".codex-plugin", "plugin.json"), "agency.json"]
// How many folders one host's reading may look at, so a large or looping folder never slows a lesson down.
const MAX_FOLDERS = 512
const MAX_INDEX_ENTRIES = 256

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value : null)

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

function pluginManifest(dir) {
  for (const manifest of MANIFESTS) {
    const read = readJson(path.join(dir, manifest))
    if (typeof read?.name === "string") return { name: read.name, version: typeof read.version === "string" ? read.version : null }
  }
  return null
}

function subfolders(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

// The plugin folders under `root`, at most `depth` levels down; a plugin's own folder is not searched further.
function pluginFolders(root, depth) {
  const found = []
  let seen = 0
  const walk = (dir, left) => {
    for (const sub of subfolders(dir)) {
      if (++seen > MAX_FOLDERS) return
      if (pluginManifest(sub) !== null) found.push(sub)
      else if (left > 1) walk(sub, left - 1)
    }
  }
  walk(root, depth)
  return found
}

function claudeInstalls(env, home) {
  const registry = readJson(path.join(text(env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude"), "plugins", "installed_plugins.json"))
  const records = Object.values(registry?.plugins ?? {}).filter(Array.isArray).flat().slice(0, MAX_INDEX_ENTRIES)
  return records.map((record) => record?.installPath).filter((dir) => typeof dir === "string" && path.isAbsolute(dir))
}

function agencyInstalls(home) {
  const cache = path.join(home, ".local", "agency", "plugins", "cache")
  const index = readJson(path.join(cache, "cache_index.json"))
  const entries = Object.values(index?.entries ?? {}).slice(0, MAX_INDEX_ENTRIES)
  return entries.map((entry) => entry?.dir_name).filter((name) => typeof name === "string" && /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/u.test(name)).map((name) => path.join(cache, "entries", name))
}

/** Every plugin folder installed for any host on this machine, besides this session's own; none without a home folder. */
function machinePluginDirs(env) {
  const home = text(env.HOME) ?? text(env.USERPROFILE)
  if (home === null) return []
  return [
    ...claudeInstalls(env, home),
    ...pluginFolders(path.join(text(env.COPILOT_HOME) ?? path.join(home, ".copilot"), "installed-plugins"), 2),
    ...agencyInstalls(home),
    ...pluginFolders(path.join(text(env.CODEX_HOME) ?? path.join(home, ".codex"), "plugins"), 4),
  ]
}

// Whether `next` is a newer install of the same plugin than `kept`: a version beats none, and the higher version wins.
function newer(next, kept) {
  if (next.version === null) return false
  if (kept.version === null) return true
  return compareVersions(next.version, kept.version) === 1
}

/**
 * `installedPlugins(env, scan, hosts?) -> Map<name, { dir, version }>`: the plugins a desk lesson can name, each at its
 * active folder: the running Desk, this host's plugins (`scan(env).dirs`) and every other host's (`hosts(env)`).
 */
export function installedPlugins(env, scan, hosts = machinePluginDirs) {
  const plugins = new Map()
  const deskRoot = deskPluginRoot(env)
  for (const dir of [deskRoot, ...scan(env).dirs, ...hosts(env)]) {
    const manifest = pluginManifest(dir)
    if (manifest === null) continue
    const kept = plugins.get(manifest.name)
    if (kept === undefined || (kept.dir !== deskRoot && newer(manifest, kept))) plugins.set(manifest.name, { dir, version: manifest.version })
  }
  return plugins
}
