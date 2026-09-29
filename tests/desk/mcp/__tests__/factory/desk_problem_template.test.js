import { test } from "node:test"
import assert from "node:assert/strict"

import { deskProblemFingerprint, normalizeErrorSignature } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-fingerprint.js"
import { FINGERPRINT_PREFIX, deskProblemCard, redactDeskRelativePaths } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-template.js"

test("a real-shaped task path never appears verbatim in a rendered issue body", () => {
  const { body } = deskProblemCard({ mechanism: "desk-sync", rawText: "conflict in clippy/show-one-final-reads/planning.md" })
  assert.doesNotMatch(body, /clippy\/show-one-final-reads/u)
  assert.match(body, /1 paths? \(1 task-scoped\)/u)
})

test("redactDeskRelativePaths leaves a bare reserved-directory file verbatim, but redacts a deeper path beneath one", () => {
  assert.equal(redactDeskRelativePaths("see _meta/friction.md for detail"), "see _meta/friction.md for detail")
  const deeper = redactDeskRelativePaths("see _meta/some-private-context/notes.md for detail")
  assert.doesNotMatch(deeper, /some-private-context/u)
  assert.match(deeper, /1 paths? \(1 under _meta\/\)/u)
})

test("redactDeskRelativePaths combines multiple paths into one summary, categorized", () => {
  const text = redactDeskRelativePaths("moved _meta/notes/private.md and clippy/show-one-final-reads/planning.md")
  assert.doesNotMatch(text, /notes\/private|show-one-final-reads/u)
  assert.match(text, /2 paths \(1 under _meta\/, 1 task-scoped\)/u)
})

test("redactDeskRelativePaths returns non-path text and non-string-shaped input unchanged", () => {
  assert.equal(redactDeskRelativePaths("nothing path-shaped here"), "nothing path-shaped here")
  assert.equal(redactDeskRelativePaths(""), "")
  assert.equal(redactDeskRelativePaths(undefined), undefined)
})

test("deskProblemCard embeds the fingerprint marker, and reuses a caller-supplied fingerprint verbatim instead of recomputing it", () => {
  const { body: computed } = deskProblemCard({ mechanism: "desk-sync", rawText: "push rejected" })
  const expected = deskProblemFingerprint("desk-sync", normalizeErrorSignature("push rejected"))
  assert.ok(computed.includes(`${FINGERPRINT_PREFIX}${expected} -->`))

  const { body: reused } = deskProblemCard({ mechanism: "desk-sync", rawText: "push rejected", fingerprint: "deadbeef".repeat(4) })
  assert.ok(reused.includes(`${FINGERPRINT_PREFIX}${"deadbeef".repeat(4)} -->`))
})

test("deskProblemCard's title is generic and normalized, never carrying raw case or punctuation", () => {
  const { title } = deskProblemCard({ mechanism: "desk-sync", rawText: "Push REJECTED!! (exit 1)" })
  assert.equal(title, title.toLowerCase())
  assert.doesNotMatch(title, /[!()]/u)
  assert.match(title, /^desk sync/u)
})

test("deskProblemCard falls back to a generic placeholder for credential- or path-shaped raw text, and defaults every optional field", () => {
  const { body } = deskProblemCard({ mechanism: "session-sync", rawText: "failed for someone@example.com" })
  assert.doesNotMatch(body, /someone@example\.com/u)
  assert.match(body, /error text withheld/u)
  assert.match(body, /Desk version: `unknown`/u)
  assert.match(body, /Host: `unknown`/u)
  assert.match(body, /Fix attempted: not recorded/u)
})

test("deskProblemCard renders the mechanism, Desk version, host and fix attempt fields when given", () => {
  const { body } = deskProblemCard({
    mechanism: "desk-sync", deskVersion: "3.2.0-alpha.123", host: "claude", rawText: "push rejected", fixAttempt: "retried once with --rebase --autostash",
  })
  assert.match(body, /Mechanism: `desk-sync`/u)
  assert.match(body, /Desk version: `3\.2\.0-alpha\.123`/u)
  assert.match(body, /Host: `claude`/u)
  assert.match(body, /Fix attempted: retried once with --rebase --autostash/u)
})

test("deskProblemCard handles empty raw text without throwing, and titles it generically", () => {
  const { title, body } = deskProblemCard({ mechanism: "ask-gate" })
  assert.match(title, /^ask gate/u)
  assert.match(body, /Error: /u)
})

test("deskProblemCard never throws when called with no arguments at all", () => {
  const { title, body } = deskProblemCard()
  assert.equal(typeof title, "string")
  assert.match(body, /Desk version: `unknown`/u)
})
