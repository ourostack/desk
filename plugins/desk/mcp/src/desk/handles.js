// Handles: a stable, opaque name for a task or track folder, so an agent can
// act on a folder whose real name it must never see or repeat.
//
// A folder name can carry a secret's value (a task folder named after a prompt
// that held a password, M4-7-F4). The listing desk_status serves, the doctor's
// organization findings and the tidy report show such a name as
// `<redacted segment>`, and give every task and track a handle next to it.
// task_move takes `handle` in place of `track` + `slug`, and track_rename takes
// `handle` in place of `track`, so the folder gets an outcome name without the
// caller ever handling the old one.
//
// A handle is `task-` or `track-` and ten hex characters of an HMAC-SHA-256 of
// the folder's path relative to the desk root. The key is random and lives in
// Desk's own state folder on this machine (`$XDG_STATE_HOME`, else
// `~/.local/state`, then `ouroboros-skills/desk/handle-key`), never in the desk,
// so reading a desk writes nothing into it. Every process on the machine uses
// the same key, so the MCP server and the tidy script agree on a folder's
// handle, and a handle cannot be checked against guessed names the way a plain
// hash of the path could. When the key cannot be stored, a per-process key
// keeps handles stable for the session. A handle changes when the folder
// moves, which is what renaming it means.

import { createHmac, randomBytes } from "node:crypto"
import { readdirSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const HANDLE = /^(task|track)-[0-9a-f]{10}$/u
const keys = new Map()
let processKey = null

/** The key file for this environment. */
export function handleKeyPath(env = process.env, homeDir = os.homedir()) {
  const configured = typeof env.XDG_STATE_HOME === "string" ? env.XDG_STATE_HOME.trim() : ""
  const stateHome = path.isAbsolute(configured) ? configured : path.join(homeDir, ".local", "state")
  return path.join(stateHome, "ouroboros-skills", "desk", "handle-key")
}

function machineKey() {
  const file = handleKeyPath()
  if (keys.has(file)) return keys.get(file)
  const key = readKey(file) ?? createKey(file) ?? (processKey ??= randomBytes(32).toString("hex"))
  keys.set(file, key)
  return key
}

function readKey(file) {
  try {
    const key = readFileSync(file, "utf8").trim()
    return /^[0-9a-f]{64}$/u.test(key) ? key : null
  } catch {
    return null
  }
}

// `wx` so two processes that start together never write different keys: the
// loser's create fails and it reads the winner's.
function createKey(file) {
  const key = randomBytes(32).toString("hex")
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    writeFileSync(file, `${key}\n`, { flag: "wx", mode: 0o600 })
    return key
  } catch {
    return readKey(file)
  }
}

/** `folderHandle(kind, deskRoot, absPath)`: the handle of a task or track folder under `deskRoot`. */
export function folderHandle(kind, deskRoot, absPath) {
  const rel = path.relative(deskRoot, absPath).split(path.sep).join("/")
  return `${kind}-${createHmac("sha256", machineKey()).update(rel).digest("hex").slice(0, 10)}`
}

/** True when `value` has the shape of a handle of this kind. */
export function isHandle(kind, value) {
  const match = typeof value === "string" ? HANDLE.exec(value) : null
  return match !== null && match[1] === kind
}

function dirNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
}

// Track folders directly under `scanRoot`: never `_`, `.` or (at the workspace root) the crew container.
function trackNames(deskRoot, scanRoot) {
  return dirNames(scanRoot).filter((name) => !name.startsWith("_") && !name.startsWith(".") && !(scanRoot === deskRoot && name === "desks"))
}

/** The track folder name under `scanRoot` whose handle is `handle`, or null. */
export function resolveTrackHandle(deskRoot, scanRoot, handle) {
  if (!isHandle("track", handle)) return null
  return trackNames(deskRoot, scanRoot).find((track) => folderHandle("track", deskRoot, path.join(scanRoot, track)) === handle) ?? null
}

/** `{ track, slug }` of the live or archived task under `scanRoot` whose handle is `handle`, or null. */
export function resolveTaskHandle(deskRoot, scanRoot, handle) {
  if (!isHandle("task", handle)) return null
  for (const track of trackNames(deskRoot, scanRoot)) {
    for (const parent of [path.join(scanRoot, track), path.join(scanRoot, track, "_archive")]) {
      for (const slug of dirNames(parent)) {
        if (slug.startsWith("_") || slug.startsWith(".")) continue
        if (folderHandle("task", deskRoot, path.join(parent, slug)) === handle) return { track, slug }
      }
    }
  }
  return null
}

export const __handleInternalsForTests = {
  reset() {
    keys.clear()
    processKey = null
  },
}
