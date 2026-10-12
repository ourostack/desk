import { renameSync } from "node:fs"
import { rename as renameAsync } from "node:fs/promises"
import { setTimeout as delay } from "node:timers/promises"

// What Windows answers when Defender, the search indexer or a backup agent briefly holds a fresh file open. The same lock
// clears within milliseconds, so a short retry succeeds where a single attempt fails (graceful-fs and write-file-atomic do the same).
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY"])
const ATTEMPTS = 10
const STEP_MS = 25
const CAP_MS = 200

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * renameWithRetry(source, destination, { rename, sleep, platform }) -> void
 *
 * `renameSync`, plus up to ten attempts spread over about a second (1.1 s of waiting in all) when Windows refuses the rename with EPERM, EACCES
 * or EBUSY. Only the rename is retried, only on Windows, and only on those codes; every other error, and the last transient one,
 * is thrown unchanged. The destination is never touched between attempts.
 */
export function renameWithRetry(source, destination, { rename = renameSync, sleep = sleepSync, platform = process.platform } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(source, destination)
      return
    } catch (error) {
      sleep(retryWait(error, attempt, platform))
    }
  }
}

/** The same retries as renameWithRetry, waiting without blocking the event loop. */
export async function renameWithRetryAsync(source, destination, { rename = renameAsync, sleep = delay, platform = process.platform } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(source, destination)
      return
    } catch (error) {
      await sleep(retryWait(error, attempt, platform))
    }
  }
}

// How long to wait before the next attempt; throws `error` when it is not one to retry.
function retryWait(error, attempt, platform) {
  if (platform !== "win32" || !TRANSIENT.has(error.code) || attempt >= ATTEMPTS) throw error
  return Math.min(STEP_MS * attempt, CAP_MS)
}
