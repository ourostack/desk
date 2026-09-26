// Preloaded with --import into a spawned Desk: inside the admission worker only, the first read of the runtime pack's archive blocks that thread for DESK_TEST_SLOW_RESTORE_MS, the way a cold restore on a slow disk or a busy machine does. The thread that answers the host is never touched.
import fs from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import { isMainThread, workerData } from "node:worker_threads"

const delayMs = Number(process.env.DESK_TEST_SLOW_RESTORE_MS ?? 0)
if (!isMainThread && workerData?.deskAdmissionWorker === true && delayMs > 0) {
  const readFileSync = fs.readFileSync
  let stalled = false
  fs.readFileSync = function patched(file, ...rest) {
    if (!stalled && String(file).endsWith("runtime-deps.tgz")) {
      stalled = true
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs)
    }
    return readFileSync.call(this, file, ...rest)
  }
  syncBuiltinESMExports()
}
