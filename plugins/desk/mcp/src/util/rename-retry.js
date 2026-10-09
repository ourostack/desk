import { renameSync } from "node:fs"

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
      if (platform !== "win32" || !TRANSIENT.has(error.code) || attempt >= ATTEMPTS) throw error
      sleep(Math.min(STEP_MS * attempt, CAP_MS))
    }
  }
}
