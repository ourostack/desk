import { test } from "node:test"
import { strict as assert } from "node:assert"

import { normalizeTimestamp, unionIntervals, intervalUnion } from "../../src/factory/time.js"

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

test("unionIntervals merges overlapping intervals", () => {
  const result = unionIntervals([
    { start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:10:00.000Z" },
    { start: "2026-09-25T08:05:00.000Z", end: "2026-09-25T08:20:00.000Z" },
  ])
  assert.deepEqual(result, {
    intervals: [{ start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:20:00.000Z" }],
    invalid: 0,
  })
})

test("unionIntervals merges touching intervals (end === next start)", () => {
  const result = unionIntervals([
    { start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:10:00.000Z" },
    { start: "2026-09-25T08:10:00.000Z", end: "2026-09-25T08:15:00.000Z" },
  ])
  assert.deepEqual(result, {
    intervals: [{ start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:15:00.000Z" }],
    invalid: 0,
  })
})

test("unionIntervals keeps disjoint intervals separate and sorts them", () => {
  const result = unionIntervals([
    { start: "2026-09-25T09:00:00.000Z", end: "2026-09-25T09:05:00.000Z" },
    { start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:05:00.000Z" },
  ])
  assert.deepEqual(result, {
    intervals: [
      { start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:05:00.000Z" },
      { start: "2026-09-25T09:00:00.000Z", end: "2026-09-25T09:05:00.000Z" },
    ],
    invalid: 0,
  })
})

test("unionIntervals drops and counts an entry whose end is before its start", () => {
  const result = unionIntervals([
    { start: "2026-09-25T08:10:00.000Z", end: "2026-09-25T08:00:00.000Z" },
    { start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:05:00.000Z" },
  ])
  assert.deepEqual(result, {
    intervals: [{ start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:05:00.000Z" }],
    invalid: 1,
  })
})

test("unionIntervals drops and counts an entry with unparsable times", () => {
  const result = unionIntervals([{ start: "not-a-time", end: "2026-09-25T08:00:00.000Z" }])
  assert.deepEqual(result, { intervals: [], invalid: 1 })
})

test("unionIntervals on an empty input returns an empty union with no invalid entries", () => {
  assert.deepEqual(unionIntervals([]), { intervals: [], invalid: 0 })
})

test("intervalUnion returns the total milliseconds covered by the merged union", () => {
  const ms = intervalUnion([
    { start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:10:00.000Z" },
    { start: "2026-09-25T08:05:00.000Z", end: "2026-09-25T08:20:00.000Z" },
    { start: "2026-09-25T09:00:00.000Z", end: "2026-09-25T09:01:00.000Z" },
  ])
  assert.equal(ms, 20 * 60 * 1000 + 60 * 1000)
})

test("intervalUnion ignores invalid entries rather than counting them", () => {
  const ms = intervalUnion([
    { start: "2026-09-25T08:10:00.000Z", end: "2026-09-25T08:00:00.000Z" },
    { start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T08:05:00.000Z" },
  ])
  assert.equal(ms, 5 * 60 * 1000)
})

test("intervalUnion of an empty input is zero", () => {
  assert.equal(intervalUnion([]), 0)
})
