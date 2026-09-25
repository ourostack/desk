// Leftover readiness-controller folders: one per root a controller ever served, kept after the controller exits because its journal stays.
//
// A folder is a leftover, and safe to remove, only when both hold: no live process owns it (owner.json is missing, or names a PID that no longer exists), and the root it served no longer exists (temporary test roots, removed worktrees). A folder whose root cannot be read from owner.json or journal/journal.json is kept. desk_doctor's prune_readiness_state repair runs this.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import * as path from "node:path"

const CONTROLLER_ID = /^[0-9a-f]{64}$/u

export function pruneReadinessLeftovers({
  stateHome,
  isAlive = processIsAlive,
  exists = existsSync,
  uid = process.getuid?.(),
} = {}) {
  const pruned = []
  let kept = 0
  let entries
  try {
    entries = readdirSync(stateHome)
  } catch {
    return { state_home: stateHome, pruned, kept }
  }
  for (const entry of entries) {
    const dir = path.join(stateHome, entry)
    const leftover = CONTROLLER_ID.test(entry) ? leftoverRecord({ dir, isAlive, exists, uid }) : null
    if (leftover === null) {
      kept += 1
      continue
    }
    removeStaleSocket(leftover, uid)
    rmSync(dir, { recursive: true, force: true })
    pruned.push({ id: entry, root: leftover.root, pid: leftover.pid })
  }
  return { state_home: stateHome, pruned, kept }
}

function leftoverRecord({ dir, isAlive, exists, uid }) {
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) return null
  const owner = readJson(path.join(dir, "owner.json"))
  const pid = Number.isInteger(owner?.owner?.pid) ? owner.owner.pid : null
  if (pid !== null && isAlive(pid)) return null
  const root = typeof owner?.identity?.root === "string"
    ? owner.identity.root
    : readJson(path.join(dir, "journal", "journal.json"))?.root
  if (typeof root !== "string" || exists(root)) return null
  return { root, pid, endpoint: owner?.endpoint ?? null, socket: owner?.socket ?? null }
}

// The socket a dead owner left behind, only when it is still the exact file that owner published.
function removeStaleSocket({ endpoint, socket }, uid) {
  if (typeof endpoint !== "string" || socket === null || typeof socket !== "object") return
  try {
    const stat = lstatSync(endpoint)
    if (stat.isSocket() && stat.dev === socket.dev && stat.ino === socket.ino && (uid === undefined || stat.uid === uid)) {
      unlinkSync(endpoint)
    }
  } catch {
    // Already gone.
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

export function processIsAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}
