// Moves an explicit Agency entry for Desk on `main` to Desk's release channel, without ever leaving a session two Desk roots.
//
// Desk ships to Agency on `github:ourostack/desk:plugins/desk@release`; an install from before that lists `...desk@main` in
// agency.toml. Agency loads two Desk roots when one plugin list selects Desk under two specs (it merges identical specs only),
// so the entry cannot simply be renamed while another plugin in the same list still declares Desk as a dependency. For each
// explicit `@main` entry, the engines (`claude`, `copilot`) on which another plugin in its list already brings Desk, read from
// that plugin's cached `agency.json` in Agency's own cache, are covered:
//
// - every engine covered: the entry is removed, because the plugin that declares Desk selects it there, on the spec it declares;
// - no engine covered: the entry moves to `@release`;
// - some covered: the entry moves to `@release` for the other engines only.
//
// A plugin in the same list whose manifest Agency has not cached holds the entry: it might declare Desk, and guessing could load
// a second root. The `03-desk-release-channel` migration runs this from the installed plugin, so it imports nothing outside
// Node's built-ins and keeps to what Node 16 has. agency.toml is written in place, so a symlinked file stays a symlink, after a
// one-time copy to `agency.toml.pre-desk-release`.

import { existsSync, readFileSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const MAIN_SPEC = "github:ourostack/desk:plugins/desk@main"
export const RELEASE_SPEC = "github:ourostack/desk:plugins/desk@release"
export const ENGINES = ["claude", "copilot"]
export const BACKUP_SUFFIX = ".pre-desk-release"
const DESK_DEPENDENCY = /^github:ourostack\/desk:plugins\/desk@/u
// A cache entry's folder name: one path segment, never `.` or `..`.
const CACHE_DIR_NAME = /^(?!\.\.?$)[A-Za-z0-9._-]+$/u

const ARRAY_HEADER = /^\s*\[\[\s*([^\]]+?)\s*\]\]\s*(?:#.*)?$/u
const ANY_HEADER = /^\s*\[/u
const PLUGIN_LINE = /^(\s*plugin\s*=\s*)(?:"([^"\\]*)"|'([^']*)')(\s*(?:#.*)?)$/u
const ENGINES_LINE = /^\s*engines\s*=/u
const ENGINES_VALUE = /^\s*engines\s*=\s*\[([^\]]*)\]\s*(?:#.*)?$/u

/** The array-table blocks of an agency.toml: `{ table, start, end, plugin, pluginLine, engines, enginesLine, badEngines }`. */
export function readBlocks(lines) {
  const blocks = []
  let current = null
  lines.forEach((line, index) => {
    if (ANY_HEADER.test(line)) {
      if (current !== null) current.end = index
      const header = ARRAY_HEADER.exec(line)
      current = header === null ? null : { table: header[1], start: index, end: lines.length, plugin: null, pluginLine: -1, engines: null, enginesLine: -1, badEngines: false }
      if (current !== null) blocks.push(current)
      return
    }
    if (current === null) return
    const plugin = PLUGIN_LINE.exec(line)
    if (plugin !== null) {
      current.plugin = plugin[2] ?? plugin[3]
      current.pluginLine = index
      return
    }
    if (ENGINES_LINE.test(line)) {
      current.enginesLine = index
      const value = ENGINES_VALUE.exec(line)
      const names = value === null ? null : [...value[1].matchAll(/"([^"]*)"|'([^']*)'/gu)].map((match) => match[1] ?? match[2])
      if (names === null || names.some((name) => !ENGINES.includes(name))) current.badEngines = true
      else current.engines = names
    }
  })
  return blocks
}

/**
 * The dependencies a cached plugin declares, from Agency's cache: `string[]` (empty when its copy has no agency.json), or null
 * when Agency has no readable cached copy of `spec` for any engine.
 */
export function cachedDependencies(cacheDir, spec, readFile = (file) => readFileSync(file, "utf8")) {
  let entries
  try {
    entries = JSON.parse(readFile(path.join(cacheDir, "cache_index.json"))).entries ?? {}
  } catch {
    return null
  }
  for (const engine of ENGINES) {
    const dir = entries[`${engine}:${spec}`]?.dir_name
    if (!(typeof dir === "string" && CACHE_DIR_NAME.test(dir))) continue
    const root = path.join(cacheDir, "entries", dir)
    let manifest
    try {
      manifest = readFile(path.join(root, "agency.json"))
    } catch {
      // A cached copy without agency.json declares nothing, but only if the copy itself is there.
      try {
        readFile(path.join(root, "plugin.json"))
        return []
      } catch {
        continue
      }
    }
    try {
      const dependencies = JSON.parse(manifest).dependencies
      return Array.isArray(dependencies) ? dependencies.filter((item) => typeof item === "string") : []
    } catch {
      continue
    }
  }
  return null
}

const enginesOf = (block) => (block.engines === null ? [...ENGINES] : block.engines)

/**
 * plan({ text, cacheDir, readFile }) -> { actions: [{ block, action: "remove" | "release", engines }], held: [reason] }
 *
 * What would change in this agency.toml text; changes nothing.
 */
export function plan({ text, cacheDir, readFile }) {
  const lines = text.split("\n")
  const blocks = readBlocks(lines)
  const actions = []
  const held = []
  for (const target of blocks.filter((block) => block.plugin === MAIN_SPEC)) {
    if (target.badEngines) {
      held.push(`the ${target.table} entry for ${MAIN_SPEC} has an engines value this migration cannot read`)
      continue
    }
    const wanted = enginesOf(target)
    const covered = new Set()
    const unknown = []
    for (const other of blocks) {
      if (other === target || other.table !== target.table || other.plugin === null || other.plugin === MAIN_SPEC) continue
      const engines = other.badEngines ? [...ENGINES] : enginesOf(other)
      if (!engines.some((engine) => wanted.includes(engine))) continue
      const dependencies = other.plugin === RELEASE_SPEC ? [RELEASE_SPEC] : cachedDependencies(cacheDir, other.plugin, readFile)
      if (dependencies === null) {
        unknown.push(other.plugin)
        continue
      }
      if (!dependencies.some((spec) => DESK_DEPENDENCY.test(spec))) continue
      // A plugin that brings Desk on engines this cannot read might cover any of them: it holds the entry.
      if (other.badEngines) unknown.push(other.plugin)
      else for (const engine of engines) covered.add(engine)
    }
    if (unknown.length > 0) {
      held.push(`in ${target.table}, Desk cannot yet tell on which engines ${unknown.join(", ")} brings Desk (Agency has not cached it, or its engines value is not one this reads), so ${MAIN_SPEC} stays until it can`)
      continue
    }
    const rest = wanted.filter((engine) => !covered.has(engine))
    actions.push({ block: target, action: rest.length === 0 ? "remove" : "release", engines: rest.length === wanted.length ? null : rest })
  }
  return { actions, held, lines }
}

/** Applies `actions` to `lines` and returns the new text. Later blocks are changed first, so earlier line numbers hold. */
export function apply(lines, actions) {
  const out = [...lines]
  for (const { block, action, engines } of [...actions].sort((a, b) => b.block.start - a.block.start)) {
    if (action === "remove") {
      out.splice(block.start, block.end - block.start)
      continue
    }
    if (engines !== null) {
      const line = `engines = [${engines.map((engine) => `"${engine}"`).join(", ")}]`
      if (block.enginesLine >= 0) out[block.enginesLine] = line
      else out.splice(block.pluginLine + 1, 0, line)
    }
    out[block.pluginLine] = out[block.pluginLine].replace(PLUGIN_LINE, (_all, lead, _double, _single, tail) => `${lead}"${RELEASE_SPEC}"${tail}`)
  }
  return out.join("\n")
}

function describe({ block, action, engines }) {
  if (action === "remove") return `removed the ${block.table} entry for ${MAIN_SPEC}: another plugin there brings Desk on every engine the entry named`
  if (engines === null) return `${block.table} now selects ${RELEASE_SPEC}`
  return `${block.table} now selects ${RELEASE_SPEC} for ${engines.join(", ")}; another plugin there brings Desk on the other engines`
}

/** `--detect`: exit 0 when there is something to move, else 1 (printing `held: <reason>` when an entry waits). `--migrate`: move it. */
export function runAgencyDeskChannelCli({ argv, env, io, readFile = (file) => readFileSync(file, "utf8"), writeFile = writeFileSync, exists = existsSync, homeDir = os.homedir() }) {
  const mode = argv[0]
  if (mode !== "--detect" && mode !== "--migrate") {
    io.stderr.write("usage: agency-desk-channel.js --detect | --migrate\n")
    return 2
  }
  const toml = typeof env.AGENCY_TOML === "string" && env.AGENCY_TOML !== "" ? env.AGENCY_TOML : path.join(homeDir, ".local", "agency", "agency.toml")
  let text
  try {
    text = readFile(toml)
  } catch {
    return mode === "--detect" ? 1 : 0
  }
  const result = plan({ text, cacheDir: path.join(path.dirname(toml), "plugins", "cache"), readFile })
  if (mode === "--detect") {
    if (result.actions.length > 0) return 0
    if (result.held.length > 0) io.stdout.write(`held: ${result.held[0]}\n`)
    return 1
  }
  if (result.actions.length > 0) {
    const backup = `${toml}${BACKUP_SUFFIX}`
    if (!exists(backup)) writeFile(backup, text)
    writeFile(toml, apply(result.lines, result.actions))
    io.stdout.write(`Agency: ${toml}: ${result.actions.map(describe).join("; ")}. The original file is kept as ${backup}.\n`)
  }
  for (const reason of result.held) io.stdout.write(`Agency: left as it is: ${reason}.\n`)
  return 0
}
