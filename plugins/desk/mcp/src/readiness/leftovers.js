// Folders older Desk versions' readiness controllers left: one per desk a controller served, under the readiness state home (`~/.cache/ouroboros-skills/desk/readiness`). Desk no longer runs a controller, so nothing creates them, and each session removes them once, in the background (src/runtime/desk-session.js).
//
// A folder is removed only when it is a real folder owned by this user, named like a controller's (64 hex digits), and no live process owns it: owner.json is missing (its controller closed cleanly) or names a PID that no longer exists. A controller an older Desk still runs keeps its folder, and an unreadable owner record keeps it too. The state home itself goes once it is empty, so later starts find nothing to do.

import { lstat, readdir, readFile, rm, rmdir } from "node:fs/promises"
import * as path from "node:path"

const CONTROLLER_ID = /^[0-9a-f]{64}$/u

/** Resolves with `{ removed, kept }`; never rejects for one folder's failure. */
export async function removeReadinessLeftovers({ stateHome, isAlive = processIsAlive, uid = process.getuid?.() } = {}) {
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
      if (!CONTROLLER_ID.test(entry) || !await ownerless(dir, { isAlive, uid })) continue
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

async function ownerless(dir, { isAlive, uid }) {
  const stat = await lstat(dir)
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) return false
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
  return !(Number.isInteger(pid) && isAlive(pid))
}

export function processIsAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === "EPERM"
  }
}
