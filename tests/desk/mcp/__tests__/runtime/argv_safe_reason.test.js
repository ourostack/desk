// argvSafeReason (fix round, spec.md §1 Part 5): the one shared narrowing
// every failure-contract caller runs its raw text through before it becomes
// an argument on the detached filer's own command line, which `ps` shows to
// every account on the machine. This lives in its own module, not
// util/redact.js, because redact.js is loaded on the session-start path from
// a minimal, hand-copied subset of this plugin that does not include the
// rest of factory/ (see startup_direction.test.js's Agency-session test);
// argvSafeReason's own factory/desk-problem-template.js dependency would
// have broken that path even though nothing on it ever calls argvSafeReason.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { argvSafeReason } from "../../../../../plugins/desk/mcp/src/runtime/argv-safe-reason.js"

test("argvSafeReason strips a real-shaped desk task path", () => {
  const safe = argvSafeReason("engineering/fix-thing/2026-09-28-cover-reset/planning.md unexpectedly staged")
  assert.doesNotMatch(safe, /fix-thing/u)
  assert.doesNotMatch(safe, /cover-reset/u)
})

test("argvSafeReason strips an absolute machine path", () => {
  for (const text of [
    "boom: failed to read /Users/ari/personal-desk/track/task/notes.md",
    "boom: failed to read /home/ari/project/notes.md",
    "~/secret-project/notes.txt was staged unexpectedly",
    "C:\\Users\\ari\\project\\file.txt could not be read",
  ]) {
    const safe = argvSafeReason(text)
    assert.doesNotMatch(safe, /\/Users\//u, text)
    assert.doesNotMatch(safe, /\/home\//u, text)
    assert.doesNotMatch(safe, /~[\\/]/u, text)
    assert.doesNotMatch(safe, /[A-Za-z]:\\/u, text)
  }
})

test("argvSafeReason strips a token-like string", () => {
  const safe = argvSafeReason("token leak ghp_1234567890abcdef1234567890abcdef1234 in the output")
  assert.doesNotMatch(safe, /ghp_1234567890abcdef1234567890abcdef1234/u)
})

test("argvSafeReason collapses to one line and caps the length", () => {
  assert.doesNotMatch(argvSafeReason("first line\nsecond line\nthird line"), /\n/u)
  const long = argvSafeReason("x".repeat(500))
  assert.ok(long.length <= 301, long.length)
})

test("argvSafeReason never throws on a non-string, nullish or empty input", () => {
  assert.equal(argvSafeReason(undefined), "")
  assert.equal(argvSafeReason(null), "")
  assert.equal(argvSafeReason(42), "42")
  assert.equal(argvSafeReason(""), "")
})
