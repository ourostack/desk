// A failed Desk call must leave the desk as it found it, empty folders included. `withCreatedDirs` makes the folder a
// write needs, runs the write, and when the write throws removes the folders it made (each only if still empty, deepest
// first) before rethrowing. A folder that already existed, or that holds anything, is never touched.
//
// Calls in one process can overlap: one call creates a folder, a second joins it, and the first then fails. Removing the
// folder would break the second. A per-process count of in-flight folders prevents that: a folder is removed only when no
// other in-flight call still uses it or anything under it.
// A caller may decline error cleanup for an unsettled native operation. That retention follows overlapping current users
// through their last release; all usage bookkeeping still disappears when those calls finish.

import { promises as fs } from "node:fs"
import * as path from "node:path"

const inFlight = new Map()

function release(directory) {
  const entry = inFlight.get(directory)
  if (--entry.count === 0) inFlight.delete(directory)
  return entry.retain
}

const inUse = (folder) => [...inFlight.keys()].some((used) => used === folder || used.startsWith(`${folder}${path.sep}`))

// The folders `directory` needs that do not exist yet, deepest first. Found by looking, not from what `fs.mkdir` returns:
// on Windows the string `mkdir` returns for the first folder it made is not always spelled the way `directory` is, so it
// cannot be compared with the paths this function walks.
async function missingFolders(directory) {
  const missing = []
  let dir = directory
  while (!(await fs.stat(dir).then(() => true, () => false))) {
    missing.push(dir)
    const parent = path.dirname(dir)
    /* istanbul ignore next -- a path whose root does not exist (an unmounted drive); mkdir reports that error next. */
    if (parent === dir) break
    dir = parent
  }
  return missing
}

export async function withCreatedDirs(directory, work, { shouldCleanup = () => true } = {}) {
  const entry = inFlight.get(directory) ?? { count: 0, retain: false }
  entry.count++
  inFlight.set(directory, entry)
  let made = []
  try {
    made = await missingFolders(directory)
    await fs.mkdir(directory, { recursive: true })
    const result = await work()
    release(directory)
    return result
  } catch (error) {
    if (!shouldCleanup(error)) {
      // Retention follows only current in-process users, not a permanent lease.
      for (const [used, active] of inFlight) {
        if (used === directory || used.startsWith(`${directory}${path.sep}`) || directory.startsWith(`${used}${path.sep}`))
          active.retain = true
      }
    }
    const retain = release(directory)
    if (retain) throw error
    for (const dir of made) {
      if (inUse(dir)) break
      try {
        await fs.rmdir(dir)
      } catch {
        break
      }
    }
    throw error
  }
}
