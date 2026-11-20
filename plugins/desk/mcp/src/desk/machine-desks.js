// The desks registered on this machine: name, local path, owner and remote, read from the operator's desk registry
// (a `_meta/desks.md` table, found through `$DESK_REGISTRY`, the machine's `~/.config/desk/registry-path` pointer, or the bound desk) so every session can find another desk without
// guessing a path or cloning one that is already here. Read-only and Node-only: it never writes the registry.

import { existsSync, readFileSync, realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { markdownTables } from "./crew-roster.js"

// A tool that keeps a registry (MS Desk's register-desk) records where it is in this one-line file; Desk only reads it.
const REGISTRY_POINTER_FILE = path.join(".config", "desk", "registry-path")
const POINTER = /Canonical registry\s*(?:→|->)\s*`([^`]+)`/u

const clean = (cell) => String(cell ?? "").replace(/\*\*|`/gu, "").trim()

function expandHome(value, homeDir) {
  if (value === "~") return homeDir
  return value.startsWith("~/") ? path.join(homeDir, value.slice(2)) : value
}

function realOrSelf(p) {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
}

/** The desks in one registry file's text, `[{ name, path, owner, remote, kind, launch }]`; no table, no desks. */
export function parseDeskRegistry(raw, { homeDir = os.homedir() } = {}) {
  const found = []
  for (const table of markdownTables(raw)) {
    const at = (column) => table.header.indexOf(column)
    const pathAt = at("local path")
    const repoAt = at("repo")
    if (pathAt === -1 || repoAt === -1) continue
    const kind = table.header[0] === "crew" ? "crew" : "solo"
    const launchAt = at("launch")
    for (const cells of table.rows) {
      const name = clean(cells[0])
      const local = clean(cells[pathAt])
      if (name === "" || local === "") continue
      const remote = clean(cells[repoAt])
      found.push({ name, path: expandHome(local, homeDir), owner: remote.includes("/") ? remote.split("/")[0] : remote, remote, kind, ...(launchAt === -1 ? {} : { launch: clean(cells[launchAt]) }) })
    }
  }
  return found
}

function readText(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return null
  }
}

// Registry files to read: an explicit one, the one a registering tool recorded in `~/.config/desk/registry-path`, and the bound desk's own (a registry, or a pointer to the hub's).
function registryFiles({ homeDir, root, env }) {
  const files = []
  if (typeof env.DESK_REGISTRY === "string" && env.DESK_REGISTRY !== "") files.push(env.DESK_REGISTRY)
  const recorded = (readText(path.join(homeDir, REGISTRY_POINTER_FILE)) ?? "").trim()
  if (recorded !== "") files.push(expandHome(recorded, homeDir))
  if (typeof root === "string" && root !== "") {
    const own = path.join(root, "_meta", "desks.md")
    files.push(own)
    const pointed = POINTER.exec(readText(own) ?? "")
    if (pointed) files.push(expandHome(pointed[1], homeDir))
  }
  return files
}

/**
 * Every desk registered on this machine, de-duplicated by folder: `{ name, path, owner, remote, kind, present, current }`.
 * `present` says the folder exists here; `current` marks the desk this session is bound to. A machine with no registry
 * has no list, which is not an error.
 */
export function readMachineDesks({ homeDir = os.homedir(), root = null, env = process.env } = {}) {
  const bound = typeof root === "string" && root !== "" ? realOrSelf(root) : null
  const seen = new Set()
  const desks = []
  for (const file of registryFiles({ homeDir, root, env })) {
    for (const desk of parseDeskRegistry(readText(file) ?? "", { homeDir })) {
      const key = realOrSelf(desk.path).toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      desks.push({ ...desk, present: existsSync(desk.path), current: bound !== null && key === bound.toLowerCase() })
    }
  }
  return desks
}

/**
 * The registered desk a request names: by name ("personal"), repo ("arimendelow/desk"), or owner when only one desk has
 * it. Returns `{ desk }`, or `{ problem }` in words that say what to do, never "clone it".
 */
export function resolveMachineDesk(query, desks) {
  const wanted = String(query ?? "").trim().toLowerCase().replace(/ desk$/u, "")
  const named = (list) => list.filter((desk) => desk.name.toLowerCase() === wanted || desk.remote.toLowerCase() === wanted || path.basename(desk.path).toLowerCase() === wanted)
  let hits = named(desks)
  if (hits.length === 0) hits = desks.filter((desk) => desk.owner.toLowerCase() === wanted)
  if (hits.length === 1) {
    const desk = hits[0]
    return desk.present
      ? { desk }
      : { problem: `The ${desk.name} desk is registered at ${desk.path} but is not on this machine. Say so to the operator and register or restore it (register-desk); do not clone it silently.` }
  }
  if (hits.length > 1) return { problem: `"${query}" names ${hits.length} registered desks (${hits.map((desk) => `${desk.name} at ${desk.path}`).join("; ")}); name one by its desk name.` }
  const list = desks.length === 0 ? "no desks are registered on this machine" : `registered: ${desks.map((desk) => desk.name).join(", ")}`
  return { problem: `No desk named "${query}" is registered on this machine (${list}). Ask the operator, then add it with register-desk; do not clone it.` }
}

/** One line for session start naming the other desks and where they are, or null when there are none. */
export function machineDesksLine(desks, { homeDir = os.homedir() } = {}) {
  const others = desks.filter((desk) => desk.present && !desk.current)
  if (others.length === 0) return null
  const short = (p) => (p.startsWith(homeDir + path.sep) ? `~${p.slice(homeDir.length).split(path.sep).join("/")}` : p)
  return `Other desks on this machine (read them there, never clone): ${others.map((desk) => `${desk.name} ${short(desk.path)}`).join("; ")}. desk_status with desk set resolves one.`
}
