import { test } from "node:test"
import { strict as assert } from "node:assert"

import { normalizeTimestamp } from "../../../../../plugins/desk/mcp/src/factory/time.js"

test("normalizeTimestamp accepts an instant carrying its own Z offset", () => {
  assert.equal(normalizeTimestamp("2026-09-08T18:00:00.000Z"), "2026-09-08T18:00:00.000Z")
})

test("normalizeTimestamp accepts an instant carrying a +/-HH:MM offset", () => {
  assert.equal(normalizeTimestamp("2026-09-08T18:00:00+02:00"), "2026-09-08T16:00:00.000Z")
})

test("normalizeTimestamp accepts SQLite's space-separated UTC form", () => {
  assert.equal(normalizeTimestamp("2026-09-08 18:00:00"), "2026-09-08T18:00:00.000Z")
  assert.equal(normalizeTimestamp("2026-09-08 18:00:00.250"), "2026-09-08T18:00:00.250Z")
})

test("normalizeTimestamp refuses a non-string value", () => {
  assert.equal(normalizeTimestamp(1757354400000), null)
  assert.equal(normalizeTimestamp(null), null)
})

test("normalizeTimestamp refuses a shape with no offset and no SQLite space", () => {
  assert.equal(normalizeTimestamp("2026-09-08T18:00:00"), null)
})

test("normalizeTimestamp refuses a bare date or year", () => {
  assert.equal(normalizeTimestamp("2026-09-08"), null)
  assert.equal(normalizeTimestamp("2026"), null)
})

test("normalizeTimestamp refuses a shape that parses to an invalid instant", () => {
  assert.equal(normalizeTimestamp("2026-13-40T18:00:00.000Z"), null)
})
