// Leftover readiness-controller folders: one per root a controller ever served, kept after the controller exits because its journal stays.
//
// A folder is a leftover, and safe to remove, only when all of these hold:
// - no live process owns it: owner.json is missing (the controller closed cleanly), or it names a PID that no longer exists, and the socket it recorded does not accept a connection;
// - the root it served no longer exists, and is not on a volume that is merely unmounted (/Volumes, /media, /mnt or /run/media);
// - it is a real folder owned by this user.
// A folder whose owner record is unreadable, or whose root cannot be read from owner.json or journal/journal.json, is kept. An error on one folder keeps that folder and never stops the rest. desk_doctor's prune_readiness_state repair runs this.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

const CONTROLLER_ID = /^[0-9a-f]{64}$/u
const VOLUME_ROOTS = [["Volumes"], ["media", null], ["mnt"], ["run", "media", null]]

export async function pruneReadinessLeftovers({
  stateHome,
  isAlive = processIsAlive,
  exists = existsSync,
  accepts = socketAccepts,
  uid = process.getuid?.(),
} = {}) {
  const pruned = []
  const skipped = []
  let kept = 0
  let entries
  try {
    entries = readdirSync(stateHome)
  } catch {
    return { state_home: stateHome, pruned, kept, skipped }
  }
  for (const entry of entries) {
    const dir = path.join(stateHome, entry)
    try {
      const leftover = CONTROLLER_ID.test(entry) ? leftoverRecord({ dir, isAlive, exists, uid }) : null
      if (leftover === null || (leftover.endpoint !== null && await accepts(leftover.endpoint))) {
        kept += 1
        continue
      }
      removeStaleSocket(leftover, uid)
      rmSync(dir, { recursive: true, force: true })
      pruned.push({ id: entry, root: leftover.root, pid: leftover.pid })
    } catch (error) {
      kept += 1
      skipped.push({ id: entry, message: error instanceof Error ? error.message : String(error) })
    }
  }
  return { state_home: stateHome, pruned, kept, skipped }
}

function leftoverRecord({ dir, isAlive, exists, uid }) {
  const stat = lstatSync(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) return null
  const ownerFile = path.join(dir, "owner.json")
  const owner = readJson(ownerFile)
  // An owner record that exists but cannot be read may belong to a live controller: keep the folder.
  if (owner === null && exists(ownerFile)) return null
  const pid = Number.isInteger(owner?.owner?.pid) ? owner.owner.pid : null
  if (pid !== null && isAlive(pid)) return null
  const root = typeof owner?.identity?.root === "string"
    ? owner.identity.root
    : readJson(path.join(dir, "journal", "journal.json"))?.root
  if (typeof root !== "string" || exists(root) || onUnmountedVolume(root, exists)) return null
  return { root, pid, endpoint: typeof owner?.endpoint === "string" ? owner.endpoint : null, socket: owner?.socket ?? null }
}

// /Volumes/<name>/…, /media/<user>/<name>/…, /mnt/<name>/… and /run/media/<user>/<name>/…: when the volume folder itself is missing, the root is probably on a disk that is not mounted now, not gone.
export function onUnmountedVolume(root, exists = existsSync) {
  const parts = root.split("/").filter(Boolean)
  for (const prefix of VOLUME_ROOTS) {
    if (parts.length <= prefix.length) continue
    if (!prefix.every((segment, index) => segment === null || parts[index] === segment)) continue
    return !exists(`/${parts.slice(0, prefix.length + 1).join("/")}`)
  }
  return false
}

// The socket a dead owner left behind, only when it is still the exact file that owner published.
function removeStaleSocket({ endpoint, socket }, uid) {
  if (endpoint === null || socket === null || typeof socket !== "object") return
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

/** Whether something listens on `endpoint` (a connection is accepted within `timeoutMs`). */
export function socketAccepts(endpoint, { timeoutMs = 250, connect = net.createConnection } = {}) {
  return new Promise((resolve) => {
    const socket = connect(endpoint)
    const finish = (accepting) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(accepting)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
  })
}
