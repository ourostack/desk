// The Desk-problem filer's launch stamps, read from the factory side. A launcher decides whether to spawn the detached filer with
// `runtime/filer-throttle.js` `shouldLaunchFiler`, which writes a stamp synchronously before the spawn: `{ at, pending: true }` under
// Desk's state folder, keyed by the mechanism and the reason it passes. The filer clears `pending` once it has recorded an outcome
// (`endLaunch`, from `desk-problem-file.js` `runFileDeskProblemCli`). A filer that never starts (a failed spawn or import) or dies before
// then leaves the stamp pending, and the verify step reads a pending launch in its window as a drop (`pendingLaunchTimes`, passed to
// `desk-problem-known.js` `knownHitsSince`), never a measured "no hit".

import { createHash } from "node:crypto"
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { resolveDeskStateDir } from "../runtime/last-start.js"
import { renameWithRetry } from "../util/rename-retry.js"

/** The folder under Desk's state folder that holds the stamps. */
export const LAUNCH_STAMP_DIR = "filer-throttle"
/** The most stamps one read looks at; any more read as a pending launch now. */
export const MAX_LAUNCH_STAMPS = 256
const MAX_STAMP_BYTES = 1024

/** The stamp name for a launch of `mechanism` with `signature` (the reason as the launcher passed it). */
export function launchStampKey(mechanism, signature) {
  return createHash("sha256").update(`${mechanism}\u0000${signature}`).digest("hex").slice(0, 32)
}

// Desk's state folder as the launcher resolves it (`runtime/filer-throttle.js`), so both name the same stamps.
const stampDir = (env) => path.join(resolveDeskStateDir({ env }), LAUNCH_STAMP_DIR)

/**
 * `endLaunch(env, { mechanism, signature })`: the filer recorded an outcome for this launch, so its stamp is no longer pending (its time is
 * kept, so the launch throttle is unchanged). A launcher that had no reason passes `unknown` to the filer and an empty signature to the
 * throttle, so both are cleared. Never throws: a stamp left pending reads as a drop, which fails closed.
 */
export function endLaunch(env, { mechanism, signature }) {
  for (const reason of signature === "unknown" ? [signature, ""] : [signature]) {
    const file = path.join(stampDir(env), `${launchStampKey(mechanism, reason)}.json`)
    try {
      const stamp = JSON.parse(readFileSync(file, "utf8"))
      if (stamp.pending !== true) continue
      const temporary = `${file}.${process.pid}.tmp`
      writeFileSync(temporary, `${JSON.stringify({ at: stamp.at, pending: false })}\n`, { mode: 0o600 })
      renameWithRetry(temporary, file)
    } catch {
      // No stamp, or one that cannot be rewritten: left as it is.
    }
  }
}

/**
 * `pendingLaunchTimes(env, { now }) -> number[]`: the times (epoch milliseconds) of the launches whose filer has not recorded an outcome. A
 * stamp that cannot be read is pending as of its modification time; a folder that cannot be listed, or holds more than
 * `MAX_LAUNCH_STAMPS` stamps, reads as one launch pending now. No folder is no launch.
 */
export function pendingLaunchTimes(env, { now = Date.now } = {}) {
  const dir = stampDir(env)
  // No folder is no launch.
  if (!existsSync(dir)) return []
  try {
    const names = readdirSync(dir).filter((name) => name.endsWith(".json"))
    if (names.length > MAX_LAUNCH_STAMPS) return [now()]
    const times = []
    for (const name of names) {
      const file = path.join(dir, name)
      const info = lstatSync(file)
      let stamp = null
      try {
        stamp = info.isFile() && info.size <= MAX_STAMP_BYTES ? JSON.parse(readFileSync(file, "utf8")) : null
      } catch {
        // Unparseable: pending as of its modification time, below.
      }
      if (stamp === null) times.push(info.mtimeMs)
      else if (stamp.pending === true) times.push(Number.isFinite(stamp.at) ? stamp.at : info.mtimeMs)
    }
    return times
  } catch {
    // A folder that cannot be listed, or a stamp that vanished mid-read, is a launch now.
    return [now()]
  }
}
