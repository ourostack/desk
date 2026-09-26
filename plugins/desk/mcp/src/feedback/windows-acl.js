// Moved to `src/factory/windows-acl.js`, the one place every caller —
// `src/protected/store.js`, `src/readiness/journal.js` and the factory
// outbox (`src/factory/outbox.js`, which may only import `node:` built-ins
// and other `src/factory/` files) — can import from. Re-exported here so
// this path, and everything already importing it, keeps working unchanged.
//
// A named re-assignment rather than a bare `export * from ...`: the latter
// has no executable statement of its own for a coverage tool to instrument,
// so this file's own coverage would otherwise read 0/0 (met by nothing to
// cover) rather than the 100% every changed file here needs to actually
// demonstrate.
import * as windowsAcl from "../factory/windows-acl.js"

export const assertWindowsAclAvailable = windowsAcl.assertWindowsAclAvailable
export const protectWindowsPaths = windowsAcl.protectWindowsPaths
