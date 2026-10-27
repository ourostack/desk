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
// So "installed" means present on this machine for some host: Agency's cache keeps every plugin it has fetched, and Claude
// Code's registry lists disabled plugins too. A made-up plugin is in none of them. A host's folders keep old versions beside
// the active one; only the running Desk and the newest version of each other plugin count, so a skill an upgrade removed is
// no owner. A linked plugin folder (a local install often is one) is followed, each real folder once. Every read is bounded
// (folder and entry counts, manifest and registry sizes) and anything unreadable is skipped.

import { readdirSync, realpathSync, statSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readSmallText } from "../factory/marker.js"
import { deskPluginRoot } from "../package-metadata.js"
import { agencyCacheEntries } from "../runtime/pending-migrations.js"
import { compareVersions } from "../runtime/stale-desk.js"

const MANIFESTS = ["plugin.json", path.join(".claude-plugin", "plugin.json"), path.join(".codex-plugin", "plugin.json"), "agency.json"]
// How many folders one host's reading may look at, so a large or looping folder never slows a lesson down.
const MAX_FOLDERS = 512
const MAX_INDEX_ENTRIES = 256
const MAX_MANIFEST_BYTES = 64 * 1024
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024

const text = (value) => (typeof value === "string" && value.trim() !== "" ? value : null)

function readJson(file, limit) {
  try {
    return JSON.parse(readSmallText(file, limit))
  } catch {
    return null
  }
}

function pluginManifest(dir) {
  for (const manifest of MANIFESTS) {
    const read = readJson(path.join(dir, manifest), MAX_MANIFEST_BYTES)
    if (typeof read?.name === "string") return { name: read.name, version: typeof read.version === "string" ? read.version : null }
  }
  return null
}

function isFolder(dir) {
  try {
    return statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function realFolder(dir) {
  try {
    return realpathSync(dir)
  } catch {
    return dir
  }
}

// The folders in `dir`, a link to a folder included; a dangling link is not a folder.
function subfolders(dir) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isDirectory() || (entry.isSymbolicLink() && isFolder(path.join(dir, entry.name)))).map((entry) => path.join(dir, entry.name))
  } catch {
    return []
  }
}

// The plugin folders under `root`, at most `depth` levels down; a plugin's own folder is not searched further. Each real
// folder is visited once, so a link back up the tree or a second link to the same checkout adds nothing.
function pluginFolders(root, depth) {
  const found = []
  const visited = new Set([realFolder(root)])
  let seen = 0
  const walk = (dir, left) => {
    for (const sub of subfolders(dir)) {
      if (++seen > MAX_FOLDERS) return
      const real = realFolder(sub)
      if (visited.has(real)) continue
      visited.add(real)
      if (pluginManifest(sub) !== null) found.push(sub)
      else if (left > 1) walk(sub, left - 1)
    }
  }
  walk(root, depth)
  return found
}

function claudeInstalls(env, home) {
  const registry = readJson(path.join(text(env.CLAUDE_CONFIG_DIR) ?? path.join(home, ".claude"), "plugins", "installed_plugins.json"), MAX_REGISTRY_BYTES)
  const records = Object.values(registry?.plugins ?? {}).filter(Array.isArray).flat().slice(0, MAX_INDEX_ENTRIES)
  return records.map((record) => record?.installPath).filter((dir) => typeof dir === "string" && path.isAbsolute(dir))
}

/** Every plugin folder installed for any host on this machine, besides this session's own; none when the home folder is not absolute. */
function machinePluginDirs(env) {
  const home = text(env.HOME) ?? text(env.USERPROFILE) ?? os.homedir()
  if (!path.isAbsolute(home)) return []
  return [
    ...claudeInstalls(env, home),
    ...pluginFolders(path.join(text(env.COPILOT_HOME) ?? path.join(home, ".copilot"), "installed-plugins"), 2),
    ...agencyCacheEntries(home).slice(0, MAX_INDEX_ENTRIES).map((entry) => entry.dir),
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
