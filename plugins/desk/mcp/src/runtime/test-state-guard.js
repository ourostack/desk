// Refuses the real Desk state folder from a node:test run, independent of whether that run happened to load the test
// suite's own isolation harness (`_isolated_env.mjs`) — a defense against exactly the shape of an incident this guards
// against (ourostack/desk, 2026-09-29): 34 evaluate-requests files recorded under a developer's real
// ~/.local/state/ouroboros-skills/desk/factory/, from an agent running `node --test <file>` bare, without the
// `--import` that preloads isolation. `last-start.js`'s `writeLastStart` and `appendRepairLog` — the two places that
// module actually writes — call this right before creating anything.
//
// Duplicated from `../factory/test-state-guard.js` rather than shared: `src/factory/**` may only import `node:`
// built-ins and other `src/factory/**` files (see `../factory/outbox.js`'s header), so the two trees each keep their
// own copy of this small guard, the same way they already each keep their own copy of state-home resolution.
//
// Detection is two independent signals, either one enough:
//
// - `NODE_TEST_CONTEXT` — set by Node itself on every child test-file process under the default (per-file) isolation
//   mode. Verified empirically on Node v22.23.3: present for a single file, multiple files and directory-discovery
//   invocations of `node --test`. It is NOT set under `node --test --experimental-test-isolation=none` (also verified
//   empirically), so it alone is not reliable enough to be the only signal.
// - The entry script's own name — `process.argv[1]` ends in `.test.js`, `.test.cjs` or `.test.mjs`. Verified present
//   in every invocation shape above, including `--experimental-test-isolation=none`, and even a bare `node
//   some.test.js` with no `--test` flag at all (node:test's `test()` still runs immediately). This is the signal that
//   closes the `--experimental-test-isolation=none` gap; a controller ruling's suggested alternative — checking
//   `--test` in `process.argv`/`process.execArgv` — was tried first and never appears in either array in any invocation
//   shape tested, so it was dropped in favor of this one.
//
// A resolved state directory that is itself under the OS temp directory is always allowed (this is exactly where the
// isolation harness points HOME/XDG_STATE_HOME), and so is a caller that explicitly opts in.

import { realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export const DESK_TEST_REAL_STATE = "DESK_TEST_REAL_STATE"
export const DESK_ALLOW_REAL_STATE_IN_TEST = "DESK_ALLOW_REAL_STATE_IN_TEST"

const TEST_ENTRY_FILE = /\.test\.(?:js|cjs|mjs)$/u

// `platform` is injectable (defaults to `process.platform`, the same shape `../factory/outbox.js`'s own
// `factoryStateRoot` already uses for its Windows-only branches) so a test can exercise the win32 case-folding on any
// OS — the coverage gate's own run never is Windows.
function fold(value, platform) {
  return platform === "win32" ? value.toLowerCase() : value
}

function hasText(value) {
  return typeof value === "string" && value.trim() !== ""
}

function inside(child, parent, platform) {
  const relative = path.relative(fold(parent, platform), fold(child, platform))
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

function spellings(target) {
  const out = new Set([target])
  try {
    out.add(realpathSync(target))
  } catch {
    // istanbul ignore next -- os.tmpdir() always exists on a real machine; nothing further to add if it somehow did not.
  }
  return out
}

/** True when this process looks like a node:test test-file run, by either signal above. */
export function looksLikeNodeTestRunner(env = process.env) {
  if (hasText(env.NODE_TEST_CONTEXT)) return true
  const entry = process.argv[1]
  return typeof entry === "string" && TEST_ENTRY_FILE.test(entry)
}

/** True when `dir` (an already-resolved absolute path) sits under the OS temp directory, in either spelling. */
export function isUnderOsTmpdir(dir, { platform = process.platform } = {}) {
  for (const root of spellings(os.tmpdir())) {
    if (inside(dir, root, platform)) return true
  }
  return false
}

/**
 * Refuses `dir` as the state directory when this process looks like a node:test run and `dir` is not under the OS
 * temp directory — unless the caller set `DESK_ALLOW_REAL_STATE_IN_TEST`. Throws an `Error` with `.code =
 * DESK_TEST_REAL_STATE`; never throws otherwise.
 */
export function assertNotRealStateUnderTest(dir, { env = process.env, platform = process.platform } = {}) {
  if (!looksLikeNodeTestRunner(env)) return
  if (hasText(env[DESK_ALLOW_REAL_STATE_IN_TEST])) return
  if (isUnderOsTmpdir(path.resolve(dir), { platform })) return
  const error = new Error(
    `test isolation: refused the real Desk state folder (${dir}) from what looks like a node:test run; ` +
      `tests must resolve state under the OS temp directory (set ${DESK_ALLOW_REAL_STATE_IN_TEST}=1 to override)`,
  )
  error.code = DESK_TEST_REAL_STATE
  throw error
}
