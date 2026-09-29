// protected-checkout.cjs's own 9 s wall-clock deadline is a last-resort
// backstop: the hosts stop a hook at 10 s, so it answers "deny" at 9 s
// whatever guardShellCommand's own async inspection is doing, with the same
// plain reason every time -- correct, since answering "deny" late is still
// the right call to keep a protected checkout safe. A *repeated* timeout of
// the exact same command is a different signal, though: not "this one Git
// call was slow," but "the guard itself may be stuck on this shape of
// input" -- spec.md §1's table (row 5) migrates exactly that signal onto the
// failure contract, while leaving a single timeout's plain denial untouched.
//
// This module tracks that repetition in Desk's own state directory --
// never inside a desk, which this hook may not even have resolved, and
// never touched on the hot, overwhelmingly common path where the guard
// answers in time: only a genuine 9 s timeout ever reads or writes this
// state. "Repeated" is a rolling window rather than a strict unbroken
// streak -- a write on every non-timeout resolution too would add real I/O
// to the guard's fast, common path, which this hook cannot afford -- so a
// timeout more than an hour after the last one for the same exact command
// starts the count over.

import { createHash } from "node:crypto"
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { formatDeskProblem } from "./index-drift.js"
import { shouldLaunchFiler } from "./filer-throttle.js"
import { resolveDeskStateDir } from "./last-start.js"

const TIMEOUT_STATE_DIR = "protected-checkout-timeouts"
const REPEAT_WINDOW_MS = 60 * 60 * 1000
export const REPEAT_TIMEOUT_THRESHOLD = 3

/** A stable, filename-safe key for `command`'s exact text -- a dedup key, not a security fingerprint. */
export function commandSignature(command) {
  return createHash("sha256").update(String(command).trim()).digest("hex").slice(0, 32)
}

function statePath({ env, signature }) {
  return path.join(resolveDeskStateDir({ env }), TIMEOUT_STATE_DIR, `${signature}.json`)
}

/**
 * Records one more 9 s timeout of `command` and returns the rolling count so
 * far, including this one. A read/write failure (an unwritable state
 * directory, a corrupt file) fails toward `1`, the safe "not repeated yet"
 * answer, rather than throwing -- this must never be what makes the guard's
 * own deadline handler slow or wrong. `now` is a test seam.
 */
export function recordTimeout({ env = process.env, command, now = () => Date.now() } = {}) {
  const signature = commandSignature(command)
  const file = statePath({ env, signature })
  let count = 0
  try {
    const previous = JSON.parse(readFileSync(file, "utf8"))
    if (typeof previous.count === "number" && typeof previous.at === "number" && now() - previous.at < REPEAT_WINDOW_MS) count = previous.count
  } catch {
    // No previous record, or an unreadable one: starts fresh.
  }
  count += 1
  try {
    const directory = path.dirname(file)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ count, at: now() })}\n`, { mode: 0o600 })
    renameSync(temporary, file)
  } catch {
    // Not persisted: the next timeout simply starts over, which only delays -- never prevents -- the eventual block.
  }
  return count
}

/**
 * `{ command, env, now, deadlineMs }` -> `{ count, block, shouldFile }`.
 * `block` is the full `Desk problem:` block once `command`'s own signature
 * has timed out `REPEAT_TIMEOUT_THRESHOLD` times in the current rolling
 * window, else `block: null` -- the guard's own plain per-call denial is
 * unchanged either way. An empty or missing `command` records nothing and
 * never blocks.
 *
 * The block itself renders on every qualifying timeout, but the caller's
 * actual filer spawn is throttled to once per hour per command signature
 * (`shouldLaunchFiler`, fix round, spec.md §1 Part 5) -- a command stuck
 * timing out on every single call would otherwise spawn a fresh filer every
 * time. `shouldFile` tells the caller whether to actually spawn; the block's
 * own `file:` field already reads accordingly ("filing in background" the
 * first time, "filing already queued (within the last hour)" after).
 */
export function repeatedTimeoutDeskProblem({ command, env = process.env, now, deadlineMs }) {
  if (typeof command !== "string" || command.trim() === "") return { count: 0, block: null, shouldFile: false }
  const count = recordTimeout({ env, command, now })
  if (count < REPEAT_TIMEOUT_THRESHOLD) return { count, block: null, shouldFile: false }
  const shouldFile = shouldLaunchFiler({ env, mechanism: "protected-checkout", signature: commandSignature(command), now })
  const reason = `the same command has now timed out ${count} times in a row at protected-checkout's own ${deadlineMs ?? 9000} ms deadline`
  const block = formatDeskProblem({
    mechanism: "protected-checkout",
    symptom: "the same command keeps timing out",
    broke: reason,
    means: "protected-checkout may be stuck inspecting this exact command, not just answering slowly this once",
    fix: "not fixable automatically -- the guard's own inspection of this command needs investigation",
    file: shouldFile ? "filing in background" : "filing already queued (within the last hour)",
    tell: `Desk's protected-checkout guard has now timed out ${count} times in a row on the same command. Filing this now so it gets fixed; the command stays denied so nothing unsafe happens meanwhile.`,
  })
  return { count, block, shouldFile }
}
