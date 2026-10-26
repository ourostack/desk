// Folders older Desk versions' readiness controllers left: one per desk a controller served, under the readiness state home (`~/.cache/ouroboros-skills/desk/readiness`). Desk no longer creates them; older versions still running may. Each session removes them once, in the background (src/runtime/desk-session.js).
//
// A folder is removed only when it is a real folder owned by this user, named like a controller's (64 hex digits), untouched for an hour, and no live process owns it: owner.json is missing (its controller closed cleanly) or names a whole-number PID that no longer exists. Anything uncertain keeps the folder: a live owner, an owner record that cannot be read or holds no whole-number PID, or a file changed in the last hour (an older controller that is starting writes owner.json only after it creates the folder). The state home itself goes once it is empty, so later starts find nothing to do.
//
// Liveness is the PID alone, so a controller in another PID namespace sharing this HOME (a dev container) looks dead once it is an hour idle.

import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises"
import * as path from "node:path"

const CONTROLLER_ID = /^[0-9a-f]{64}$/u
const RECENT_MS = 60 * 60 * 1000

/** Resolves with `{ removed, kept }`; never rejects for one folder's failure. */
export async function removeReadinessLeftovers({ stateHome, isAlive = processIsAlive, uid = process.getuid?.(), now = Date.now }) {
  let entries
  try {
    entries = await readdir(stateHome)
  } catch {
    return { removed: 0, kept: 0 }
  }
  let removed = 0
  for (const entry of entries) {
    const dir = path.join(stateHome, entry)
    try {
      if (!CONTROLLER_ID.test(entry) || !await ownerless(dir, { isAlive, uid, since: now() - RECENT_MS })) continue
      await rm(dir, { recursive: true, force: true })
      removed += 1
    } catch {
      // Kept for the next session to try.
    }
  }
  // Fails, and keeps the folder, while anything is left in it.
  await rmdir(stateHome).catch(() => {})
  return { removed, kept: entries.length - removed }
}

async function ownerless(dir, { isAlive, uid, since }) {
  const stat = await lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) return false
  if (await changedSince(dir, since)) return false
  let text
  try {
    text = await readFile(path.join(dir, "owner.json"), "utf8")
  } catch (error) {
    return error?.code === "ENOENT"
  }
  let pid
  try {
    pid = JSON.parse(text)?.owner?.pid
  } catch {
    return false
  }
  if (!Number.isInteger(pid) || pid <= 0) return false
  return !isAlive(pid)
}

// Whether the folder, or anything in it or one level further down (journal/), changed after `since`.
async function changedSince(dir, since, depth = 2) {
  const stat = await lstat(dir)
  if (stat.mtimeMs > since) return true
  if (depth === 0 || !stat.isDirectory()) return false
  for (const entry of await readdir(dir)) {
    if (await changedSince(path.join(dir, entry), since, depth - 1)) return true
  }
  return false
}

export function processIsAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}
