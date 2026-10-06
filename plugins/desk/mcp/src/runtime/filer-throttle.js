// A local, per-machine throttle on spawning the detached failure-contract
// filer (spec.md §1, Part 5 fix round). Before this, a mechanism that keeps
// failing the same way -- a boot check on every session start
// that hits it -- spawned a fresh `file-desk-problem.js` process every single
// time, each one doing an account lookup and `gh` calls. The outbox's own
// fingerprint and named lock already stop a duplicate *issue*; this throttle
// stops the local *spawning* storm before it ever reaches that point.
//
// `shouldLaunchFiler` fails toward launching: any problem reading or writing
// its own stamp file just means the next qualifying event spawns again --
// never that a genuine failure goes unfiled. The stamp lives under Desk's own
// state directory (`resolveDeskStateDir`), keyed by a hash of the mechanism
// and the caller's own signature, never inside a desk.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

const THROTTLE_STATE_DIR = "filer-throttle"
export const DEFAULT_FILER_COOLDOWN_MS = 60 * 60 * 1000

function stampKey(mechanism, signature) {
  // `signature` always arrives as a string: `shouldLaunchFiler`'s own default
  // (`signature = ""` below) is this function's only caller's only source.
  return createHash("sha256").update(`${mechanism}\u0000${signature}`).digest("hex").slice(0, 32)
}

function stampPath({ env, mechanism, signature }) {
  return path.join(resolveDeskStateDir({ env }), THROTTLE_STATE_DIR, `${stampKey(mechanism, signature)}.json`)
}

/**
 * `shouldLaunchFiler({ env, mechanism, signature, cooldownMs, now }) ->
 * boolean`: true the first time a given `mechanism`+`signature` pair is seen,
 * or once `cooldownMs` (default one hour) has passed since the last time this
 * returned true for that pair; false otherwise. The caller still builds and
 * shows its `Desk problem:` block every time -- only the actual filer spawn
 * is gated -- and reports the block's own `file:` field as "filing in
 * background" on `true` or "filing already queued (within the last hour)" on
 * `false`.
 */
export function shouldLaunchFiler({
  env = process.env, mechanism, signature = "", cooldownMs = DEFAULT_FILER_COOLDOWN_MS, now = () => Date.now(),
} = {}) {
  const file = stampPath({ env, mechanism, signature })
  try {
    const previous = JSON.parse(readFileSync(file, "utf8"))
    if (typeof previous.at === "number" && now() - previous.at < cooldownMs) return false
  } catch {
    // No previous stamp, or an unreadable one: this counts as the first launch.
  }
  try {
    const directory = path.dirname(file)
    assertNotRealStateUnderTest(directory, { env })
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ at: now() })}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  } catch {
    // Not persisted: the next qualifying event just launches again.
  }
  return true
}
