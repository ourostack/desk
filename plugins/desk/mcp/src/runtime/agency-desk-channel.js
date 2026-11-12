// Moves an explicit Agency entry for Desk on `main` to Desk's release channel, without ever leaving a session two Desk roots.
//
// Desk ships to Agency on `github:ourostack/desk:plugins/desk@release`; an install from before that lists `...desk@main` in
// agency.toml. Agency loads two Desk roots when one plugin list selects Desk under two specs (it merges identical specs only),
// so the entry cannot simply be renamed while another plugin in the same list still declares Desk as a dependency. For each
// explicit `@main` entry, the engines (`claude`, `copilot`) on which another plugin in its list already brings Desk, directly
// or through its own dependencies (CIT declares MS Desk, which declares Desk), read from the cached `agency.json` files in
// Agency's own cache, are covered:
//
// - every engine covered: the entry is removed, because the plugin that declares Desk selects it there, on the spec it declares;
// - no engine covered: the entry moves to `@release`;
// - some covered: the entry moves to `@release` for the other engines only.
//
// A plugin in the same list whose dependency graph Agency has not fully cached holds the entry: it might bring Desk, and
// guessing could load a second root. The `03-desk-release-channel` migration runs this from the installed plugin, so it
// imports nothing outside Node's built-ins and Desk's own dependency-free modules, and keeps to what Node 16 has. agency.toml
// (the file a symlink points at, so the link stays a link) is replaced whole, under Desk's directory lock and only if nobody
// changed it meanwhile, after a one-time copy to `agency.toml.pre-desk-release` beside it.

import { promises as fs, readFileSync, realpathSync } from "node:fs"
import { randomBytes } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { renameWithRetryAsync } from "../util/rename-retry.js"

export const MAIN_SPEC = "github:ourostack/desk:plugins/desk@main"
export const RELEASE_SPEC = "github:ourostack/desk:plugins/desk@release"
const ENGINES = ["claude", "copilot"]
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
 * Whether selecting `spec` brings Desk, following dependencies through Agency's cache as far as they go (CIT declares MS Desk,
 * which declares Desk): `{ desk, missing }`, where `missing` lists every reachable spec whose manifest is not cached. Each spec
 * is visited once, so a dependency cycle ends.
 */
export function reachesDesk(spec, dependenciesOf) {
  const seen = new Set()
  const queue = [spec]
  const missing = []
  let desk = false
  while (queue.length > 0) {
    const next = queue.shift()
    if (seen.has(next)) continue
    seen.add(next)
    if (DESK_DEPENDENCY.test(next)) {
      desk = true
      continue
    }
    const dependencies = dependenciesOf(next)
    if (dependencies === null) missing.push(next)
    else queue.push(...dependencies)
  }
  return { desk, missing }
}

/**
 * plan({ text, cacheDir, readFile }) -> { actions: [{ block, action: "remove" | "release", engines }], held: [reason] }
 *
 * What would change in this agency.toml text; changes nothing.
 */
export function plan({ text, cacheDir, readFile }) {
  const lines = text.split("\n")
  const blocks = readBlocks(lines)
  const manifests = new Map()
  const dependenciesOf = (spec) => {
    if (!manifests.has(spec)) manifests.set(spec, cachedDependencies(cacheDir, spec, readFile))
    return manifests.get(spec)
  }
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
      const reach = reachesDesk(other.plugin, dependenciesOf)
      // A plugin that brings Desk on engines this cannot read might cover any of them, and one whose graph is not all cached
      // might bring Desk: either holds the entry, because guessing could select Desk twice.
      if (reach.desk && !other.badEngines) for (const engine of engines) covered.add(engine)
      else if (reach.desk || reach.missing.length > 0) unknown.push(reach.missing.some((spec) => spec !== other.plugin) ? `${other.plugin} (not cached: ${reach.missing.join(", ")})` : other.plugin)
    }
    if (unknown.length > 0) {
      held.push(`in ${target.table}, Desk cannot yet tell on which engines ${unknown.join(", ")} brings Desk (Agency has not cached every manifest it depends on, or its engines value is not one this reads), so ${MAIN_SPEC} stays until it can`)
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

export const LOCK_SUFFIX = ".desk-migration.lock"

/**
 * Writes `next` over the agency.toml at `target` (the resolved file, so a symlink to it stays a symlink) only if it still
 * holds `seen`: under Desk's directory lock beside it, through a temporary file in the same folder renamed into place, so
 * no reader ever sees half a file. Returns "written", "changed" (someone else changed it; nothing written) or "busy".
 */
export async function replaceIfUnchanged({ target, seen, next, backup, lockWaitMs = 500, fsp = fs, holdLock }) {
  const outcome = await holdLock(`${target}${LOCK_SUFFIX}`, { lockWaitMs }, async () => {
    if ((await fsp.readFile(target, "utf8")) !== seen) return "changed"
    const mode = (await fsp.stat(target)).mode & 0o777
    const temp = `${target}.desk-${process.pid}-${randomBytes(4).toString("hex")}.tmp`
    try {
      await fsp.writeFile(temp, next, { flag: "wx", mode })
      // The backup is the file as it was before the first move, and is never overwritten.
      await fsp.writeFile(backup, seen, { flag: "wx", mode }).catch((error) => {
        if (error.code !== "EEXIST") throw error
      })
      // Read again right before the swap: a write that landed while the new file was being prepared is never lost.
      if ((await fsp.readFile(target, "utf8")) !== seen) return "changed"
      await renameWithRetryAsync(temp, target)
      return "written"
    } finally {
      await fsp.rm(temp, { force: true })
    }
  })
  return outcome?.result === "lock_busy" ? "busy" : outcome
}

/** `--detect`: exit 0 when there is something to move, else 1 (printing `held: <reason>` when an entry waits). `--migrate`: move it. */
export async function runAgencyDeskChannelCli({ argv, env, io, readFile = (file) => readFileSync(file, "utf8"), homeDir = os.homedir(), replace = replaceIfUnchanged, loadLock = async () => (await import("../desk/improvement-cards.js")).holdLock }) {
  const mode = argv[0]
  if (mode !== "--detect" && mode !== "--migrate") {
    io.stderr.write("usage: agency-desk-channel.js --detect | --migrate\n")
    return 2
  }
  const toml = typeof env.AGENCY_TOML === "string" && env.AGENCY_TOML !== "" ? env.AGENCY_TOML : path.join(homeDir, ".local", "agency", "agency.toml")
  let target
  let text
  try {
    target = realpathSync(toml)
    text = readFile(target)
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
    const backup = `${target}${BACKUP_SUFFIX}`
    const outcome = await replace({ target, seen: text, next: apply(result.lines, result.actions), backup, holdLock: await loadLock() })
    if (outcome !== "written") {
      io.stdout.write(outcome === "busy"
        ? `Agency: ${toml} was not changed: another Desk session is moving it now; the next session start checks again.\n`
        : `Agency: ${toml} was not changed: it changed while this ran; the next session start checks again.\n`)
      return 1
    }
    io.stdout.write(`Agency: ${toml}: ${result.actions.map(describe).join("; ")}. The original file is kept as ${backup}.\n`)
  }
  for (const reason of result.held) io.stdout.write(`Agency: left as it is: ${reason}.\n`)
  return 0
}
