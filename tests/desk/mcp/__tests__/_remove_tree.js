// The one way a test removes a fixture tree (util/remove_sites.test.js fails a test file that removes a tree any other way) that a process may still hold for a moment.
//
// It is async on purpose. `fs.promises.rm` runs Node's JavaScript rimraf, which retries EPERM, EBUSY and ENOTEMPTY with a growing
// wait. The synchronous removal does not in Node 24.18: its native code retries EPERM only as `operation_not_permitted`, while a
// Windows access-denied is `permission_denied`, and its Windows wait rounds a delay under a second to nothing. util/remove_sites.test.js
// keeps that form out of the code.
import { promises as fs } from "node:fs"
import { removeWithRetry } from "../../../../plugins/desk/mcp/src/util/remove-retry.js"

/** Remove `target` and everything under it, waiting up to about 11 s in all (200 ms, 400 ms, ... 2 s) while it is refused. */
export function removeTree(target) {
  return fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}

/**
 * The same removal for a synchronous `finally` or `after` that cannot await: up to ten attempts over about a second. It only waits out the OS's delayed release;
 * a process the test started that may still hold the folder must be ended, and awaited, before this is called.
 */
export function removeTreeSync(target) {
  removeWithRetry(target, { recursive: true, force: true })
}
