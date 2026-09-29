// The one shared narrowing every failure-contract caller runs a failure's
// raw text through before it becomes an argument on the detached filer's own
// command line (spec.md §1, Part 5 fix round). A spawned process's argv is
// visible to every account on the machine via `ps`, a materially wider
// audience than the operator's own session -- so this is stricter than
// `util/redact.js`'s own `redactCredentialLikeText` alone: it also collapses
// any desk-relative path to a count (`redactDeskRelativePaths`), replaces an
// absolute machine or home-directory path with a fixed marker, flattens the
// result onto one line, and caps its length. The block Desk shows the
// operator (the `broke`/`means`/`tell` fields) is never passed through this
// -- only the text that becomes argv.
//
// This lives here, not in `util/redact.js` itself: `redact.js` is loaded on
// the session-start path from a minimal, hand-copied subset of this plugin
// (some hosts copy only `util/paths.js`, `util/startup-direction.js`,
// `util/redact.js` and `factory/credential.js` for one session -- see
// `tests/desk/mcp/__tests__/runtime/startup_direction.test.js`'s Agency-
// session test) that does not include the rest of `factory/`. Giving
// `redact.js` itself a new static import on `factory/desk-problem-template.js`
// broke that path even though nothing on it ever calls `argvSafeReason`,
// because an ES module's own static imports run at load time regardless of
// which export is actually used. `argvSafeReason` is only ever reached from
// `hooks/ask-gate.cjs` and `hooks/boot-checks.cjs`, which load this whole
// module tree from the real, complete checkout, never from that minimal copy.

import { redactDeskRelativePaths } from "../factory/desk-problem-template.js"
import { redactCredentialLikeText } from "../util/redact.js"

// An absolute path's own leading shape: a home-directory reference (`~` or
// `~/...`), a Unix path rooted at a well-known machine or user directory
// (`/Users/...`, `/home/...`, `/var/...`, `/tmp/...`, `/private/...`,
// `/mnt/...`, `/opt/...`, `/etc/...`), or a Windows drive path (`C:\...`).
// `redactCredentialLikeText` only catches a path segment that is itself
// secret-shaped, and `redactDeskRelativePaths` only catches a desk-relative
// path; neither touches a real machine path such as a repository checkout
// or a home directory, which names no secret but still names this machine
// and this operator's account.
const ABSOLUTE_PATH = /(?:~(?:[\\/][^\s"'`)\]]*)?|\/(?:Users|home|var|tmp|private|mnt|opt|etc)\/[^\s"'`)\]]*|[A-Za-z]:\\[^\s"'`)\]]*)/gu
const ARGV_REASON_MAX = 300

/**
 * `argvSafeReason(text) -> string`: never throws -- a non-string input
 * renders as its own `String(...)` form first.
 */
export function argvSafeReason(text) {
  const raw = typeof text === "string" ? text : String(text ?? "")
  const deskPathsCollapsed = redactDeskRelativePaths(raw)
  const credentialsRedacted = redactCredentialLikeText(deskPathsCollapsed)
  const pathsStripped = credentialsRedacted.replace(ABSOLUTE_PATH, "<redacted path>")
  const oneLine = pathsStripped.replace(/\s+/gu, " ").trim()
  return oneLine.length > ARGV_REASON_MAX ? `${oneLine.slice(0, ARGV_REASON_MAX)}…` : oneLine
}
