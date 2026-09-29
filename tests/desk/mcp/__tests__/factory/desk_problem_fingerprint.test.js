import { test } from "node:test"
import assert from "node:assert/strict"

import { deskProblemFingerprint, normalizeErrorSignature } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-fingerprint.js"

test("the same mechanism and normalized signature always hash the same, with no machine secret involved", () => {
  assert.equal(deskProblemFingerprint("desk-sync", "push_rejected"), deskProblemFingerprint("desk-sync", "push_rejected"))
  // Deterministic across "machines": nothing here reads an env var, a file or a clock.
  const first = deskProblemFingerprint("index-drift", "unexpected file staged")
  const second = deskProblemFingerprint("index-drift", "unexpected file staged")
  assert.equal(first, second)
  assert.match(first, /^[0-9a-f]{32}$/u)
})

test("a different mechanism, or a different signature, hashes differently", () => {
  assert.notEqual(deskProblemFingerprint("desk-sync", "push_rejected"), deskProblemFingerprint("session-sync", "push_rejected"))
  assert.notEqual(deskProblemFingerprint("desk-sync", "push_rejected"), deskProblemFingerprint("desk-sync", "pull_rejected"))
})

test("normalizeErrorSignature strips file paths, commit hashes, timestamps and counts so two differently-worded instances of the same failure normalize identically", () => {
  const first = normalizeErrorSignature("git pull --rebase failed at 2026-09-28T10:15:00Z: 2 files staged in clippy/show-one-final-reads/planning.md (commit 89ac44a1bcd)")
  const second = normalizeErrorSignature("git pull --rebase failed at 2026-09-29T03:02:11Z: 5 files staged in another/task/notes.md (commit 630c24f3aaa)")
  assert.equal(first, second)
  assert.ok(first.length > 0)
})

test("normalizeErrorSignature lower-cases and collapses punctuation the same way normalizeTitle does", () => {
  assert.equal(normalizeErrorSignature("Push REJECTED!! (exit 1)"), normalizeErrorSignature("push rejected, exit 1"))
})

test("normalizeErrorSignature is empty for empty or non-string input, never throws", () => {
  assert.equal(normalizeErrorSignature(""), "")
  assert.equal(normalizeErrorSignature(undefined), "")
  assert.equal(normalizeErrorSignature(null), "")
  assert.equal(normalizeErrorSignature(42), "")
})

test("two genuinely different failures (an actual merge conflict on different files vs. a stray-file dirty index) still normalize differently", () => {
  const conflict = normalizeErrorSignature("cannot pull with rebase: merge conflict in track/task/notes.md")
  const strayFile = normalizeErrorSignature("cannot pull with rebase: Your index contains uncommitted changes.")
  assert.notEqual(conflict, strayFile)
})
