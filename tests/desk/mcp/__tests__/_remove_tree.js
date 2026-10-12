// The one way a test removes a fixture tree that a process may still hold for a moment.
//
// It is async on purpose. `fs.promises.rm` runs Node's JavaScript rimraf, which retries EPERM, EBUSY and ENOTEMPTY with a growing
// wait. The synchronous removal does not in Node 24.18: its native code retries EPERM only as `operation_not_permitted`, while a
// Windows access-denied is `permission_denied`, and its Windows wait rounds a delay under a second to nothing. util/remove_sites.test.js
// keeps that form out of the code.
import { promises as fs } from "node:fs"

/** Remove `target` and everything under it, waiting up to about 11 s in all (200 ms, 400 ms, ... 2 s) while it is refused. */
export function removeTree(target) {
  return fs.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
}
