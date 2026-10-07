// What the loop worker leaves behind about itself, and the mark a reset status file leaves.
//
// The worker's own outcome of every run is `status.json.loop.worker = { at, result, since }` (`since` is when the current result
// started, so a lock held for hours shows its age). When the status file cannot be written, the same three fields go to
// `locks/loop-worker.state.json`. Both hold a code and two times, nothing else. The session-start line and the health record read them here.
//
// A damaged `status.json` is moved aside by the reader as `status.json.corrupt-json-<n>` and read as empty, which would reset the
// evaluator's daily cap. The moved-aside file is the durable mark: a UTC day on which one was set aside is a spent day for the evaluator.
// `ctime` is the time of the rename, which is when the status was reset; the later of it and `mtime` is used.

import { readdirSync, statSync, readFileSync } from "node:fs"
import { promises as fsp } from "node:fs"
import { randomBytes } from "node:crypto"
import * as path from "node:path"

export const WORKER_STATE_FILE = "loop-worker.state.json"
const ASIDE_NAME = /^status\.json\.corrupt-json-[0-9]+$/u
const RESULT_CODE = /^[a-z0-9][a-z0-9_:-]{0,63}$/u
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const isTime = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value))

/** The names of the status files that were moved aside, or `[]` when the folder cannot be listed. */
export function listStatusAside(root) {
  try {
    return readdirSync(root).filter((name) => ASIDE_NAME.test(name))
  } catch {
    return []
  }
}

/** The latest UTC day (`YYYY-MM-DD`) on which a status file was set aside, or `null`. */
export function statusResetDay(root) {
  let latest = null
  for (const name of listStatusAside(root)) {
    try {
      const info = statSync(path.join(root, name))
      const ms = Math.max(info.mtimeMs, info.ctimeMs)
      latest = Math.max(latest ?? ms, ms)
    } catch {
      // Gone since the listing.
    }
  }
  return latest === null ? null : new Date(latest).toISOString().slice(0, 10)
}

/** A stored `{ at, result, since }` that is well formed, or `null`. */
export function validWorker(value) {
  return isObject(value) && isTime(value.at) && isTime(value.since) && typeof value.result === "string" && RESULT_CODE.test(value.result)
    ? { at: value.at, result: value.result, since: value.since }
    : null
}

/** The record for a run that ended with `result` at `at` (ISO): `since` stays while the result stays the same. */
function nextWorker(previous, result, at) {
  const before = validWorker(previous)
  return { at, result, since: before !== null && before.result === result && Date.parse(before.since) <= Date.parse(at) ? before.since : at }
}

function readFallback(root) {
  try {
    return validWorker(JSON.parse(readFileSync(path.join(root, "locks", WORKER_STATE_FILE), "utf8")))
  } catch {
    return null
  }
}

/** The newer of the status file's record and the fallback file's (`status` may be `null`), or `null` when neither is well formed. */
export function readWorker(status, root) {
  const stored = validWorker(isObject(status?.loop) ? status.loop.worker : undefined)
  const fallback = readFallback(root)
  if (stored === null) return fallback
  return fallback !== null && Date.parse(fallback.at) > Date.parse(stored.at) ? fallback : stored
}

/** Writes the worker's outcome: into the status through `updateStatusImpl`, else into the small file beside the lock. Never throws. */
export async function recordWorker(env, root, result, at, updateStatusImpl) {
  try {
    await updateStatusImpl(env, (current) => {
      const loop = isObject(current.loop) ? current.loop : {}
      return { ...current, loop: { ...loop, worker: nextWorker(loop.worker, result, at) } }
    })
    return
  } catch {
    // Fall through to the file beside the lock.
  }
  try {
    const dir = path.join(root, "locks")
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, WORKER_STATE_FILE)
    const temporary = `${file}.${randomBytes(4).toString("hex")}.tmp`
    await fsp.writeFile(temporary, JSON.stringify(nextWorker(readFallback(root), result, at)), { mode: 0o600 })
    await fsp.rename(temporary, file)
  } catch {
    // Nowhere to write: the printed line is all there is.
  }
}
