import { rmSync } from "node:fs"

// What Windows answers while Defender, the search indexer or a just-exited process still holds something in a folder, and what a
// folder being emptied concurrently answers. Node's own `rmSync` retry cannot be relied on for these: in Node 24.18 its native
// implementation retries EPERM only as `operation_not_permitted`, while a Windows access-denied is `permission_denied`, and its
// Windows wait is `Sleep(i * retryDelay / 1000)`, which rounds a delay under a second to nothing.
const TRANSIENT = new Set(["EPERM", "EACCES", "EBUSY", "ENOTEMPTY"])
const ATTEMPTS = 10
const STEP_MS = 25
const CAP_MS = 200

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * removeWithRetry(target, { recursive, force, remove, sleep }) -> void
 *
 * `rmSync(target, { recursive, force })`, plus up to ten attempts spread over about a second (1.1 s of waiting in all) when the
 * removal is refused with EPERM, EACCES, EBUSY or ENOTEMPTY. Every other error, and the last transient one, is thrown unchanged.
 */
export function removeWithRetry(target, { recursive = false, force = false, remove = rmSync, sleep = sleepSync } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      remove(target, { recursive, force })
      return
    } catch (error) {
      if (!TRANSIENT.has(error.code) || attempt >= ATTEMPTS) throw error
      sleep(Math.min(STEP_MS * attempt, CAP_MS))
    }
  }
}
