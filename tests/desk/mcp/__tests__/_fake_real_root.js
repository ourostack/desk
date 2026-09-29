// Shared fixture root for tests that simulate a "real" (non-temp) state home -- used by guard tests asserting that
// production code (test-state-guard.js's assertNotRealStateUnderTest, both the runtime and factory copies) refuses
// to write there.
//
// A location computed as a sibling of os.tmpdir() (path.dirname(realpath(os.tmpdir()))) works on macOS, where
// os.tmpdir() is a deep per-user path (e.g. /var/folders/xx/xxxxxxxx/T), but on Linux CI os.tmpdir() is exactly
// /tmp, so that same computation lands on /, the filesystem root -- unwritable by the unprivileged CI runner user.
// Every mkdtemp/mkdir there then fails with EACCES (ourostack/desk PR #101, run 36553219617: 8 of 12 shards, 12
// tests, every one this same topology bug).
//
// A directory under this repository checkout has neither problem: the checkout is owned by whoever runs the tests,
// so it is always writable, and it is never itself under the OS temp directory, so the guard under test correctly
// treats it as "real" (non-temp) state -- on every platform. It also sits inside `_isolated_env.mjs`'s own
// `allowedRoots` (which includes the repo checkout), so creating fixtures here never trips that separate, outer
// guard.

import "./_isolated_env.mjs"
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { after } from "node:test"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..")
const base = path.join(repoRoot, ".test-fake-real")

function assertOutsideOsTmpdir(dir) {
  const resolvedDir = realpathSync(dir)
  const resolvedTmp = realpathSync(os.tmpdir())
  const relative = path.relative(resolvedTmp, resolvedDir)
  const isInside = relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  if (isInside) {
    throw new Error(
      `test fixture: the fake "real" root ${dir} (resolved ${resolvedDir}) is under the OS temp directory ` +
        `(resolved ${resolvedTmp}); it must stay outside so the guard under test treats it as real, non-temp state`,
    )
  }
}

mkdirSync(base, { recursive: true })
assertOutsideOsTmpdir(base)

const ownedRoots = new Set()
after(() => {
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
})

/**
 * Create and return a fixture directory that stands in for a "real" (non-temp) state home: writable on every CI
 * platform, and verified outside os.tmpdir(). Owned (removed) once the test file ends.
 */
export function mkFakeRealRoot(prefix) {
  const root = mkdtempSync(path.join(base, prefix))
  ownedRoots.add(root)
  return root
}

/**
 * Return a unique path that stands in for a "real" (non-temp) state home, without creating it -- for guard tests
 * that assert nothing exists at the path until the code under test either refuses (nothing is ever created) or, on
 * an explicit opt-out, creates it itself. Verified outside os.tmpdir(). Owned (removed, if anything landed there)
 * once the test file ends.
 */
export function fakeRealPath(prefix) {
  const root = path.join(base, `${prefix}${randomBytes(6).toString("hex")}`)
  ownedRoots.add(root)
  return root
}
