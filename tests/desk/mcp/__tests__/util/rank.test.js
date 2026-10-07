// rank.test.js — the ranking math is pure, so this tests it directly instead of through desk_search.
import { test } from "node:test"
import assert from "node:assert/strict"
import { clipCosine, combineScore, cosine, normalizeBm25, recencyDecay, stateBias } from "../../../../../plugins/desk/mcp/src/util/rank.js"

test("stateBias is case-insensitive and neutral for anything it does not know", () => {
  assert.equal(stateBias("Blocked "), 0.7)
  assert.equal(stateBias("done"), 0.6)
  assert.equal(stateBias("unheard-of"), 0.5)
  assert.equal(stateBias(null), 0.5)
  assert.equal(stateBias(undefined), 0.5)
})

test("recencyDecay is 0 for a missing or unparseable date, 1 for a future one, and halves every 60 days", () => {
  const now = Date.parse("2026-10-01T00:00:00Z")
  assert.equal(recencyDecay("", now), 0)
  assert.equal(recencyDecay(undefined, now), 0)
  assert.equal(recencyDecay("not a date", now), 0)
  assert.equal(recencyDecay("2026-10-02T00:00:00Z", now), 1)
  assert.equal(recencyDecay("2026-10-01T00:00:00Z", now), 1)
  assert.ok(Math.abs(recencyDecay("2026-08-02T00:00:00Z", now) - Math.exp(-1)) < 1e-9)
  // Without a clock argument it reads the wall clock: a date far in the past is close to 0.
  assert.ok(recencyDecay("2000-01-01") < 0.001)
})

test("clipCosine clamps to [0, 1] and maps non-numbers and NaN to 0", () => {
  assert.equal(clipCosine("0.5"), 0)
  assert.equal(clipCosine(Number.NaN), 0)
  assert.equal(clipCosine(-0.2), 0)
  assert.equal(clipCosine(1.4), 1)
  assert.equal(clipCosine(0.25), 0.25)
})

test("normalizeBm25 flips the sign and rescales to [0, 1], and gives no signal when every value is equal", () => {
  assert.deepEqual(normalizeBm25([]), [])
  assert.deepEqual(normalizeBm25([-2, -2]), [0, 0])
  assert.deepEqual(normalizeBm25([-4, -2, -1]), [1, 1 / 3, 0])
})

test("combineScore weights the four components and adds the pin on top", () => {
  const full = combineScore({ semantic: 1, bm25: 1, recency: 1, state: 1 })
  assert.ok(Math.abs(full.score - 1) < 1e-9)
  assert.deepEqual(full.breakdown, { semantic: 1, bm25: 1, recency: 1, state: 1, pin: 0 })
  const pinned = combineScore({ semantic: 0, bm25: 0, recency: 0, state: 0, pin: true })
  assert.equal(pinned.score, 0.3)
  assert.equal(pinned.breakdown.pin, 0.3)
  // Missing parts count as 0, except the state, which defaults to the neutral bias.
  const empty = combineScore({})
  assert.ok(Math.abs(empty.score - 0.08 * 0.5) < 1e-9)
  assert.equal(empty.breakdown.state, 0.5)
})

test("combineScore without semantic scoring drops that term and renormalizes the rest to the same total", () => {
  const result = combineScore({ semantic: 1, bm25: 1, recency: 1, state: 1, semanticAvailable: false })
  assert.equal(result.breakdown.semantic, 0)
  assert.ok(Math.abs(result.score - 1) < 1e-9)
})

test("cosine is 0 for non-arrays, mismatched or empty vectors and zero magnitudes, and exact otherwise", () => {
  assert.equal(cosine(null, [1]), 0)
  assert.equal(cosine([1], "x"), 0)
  assert.equal(cosine([1, 2], [1]), 0)
  assert.equal(cosine([], []), 0)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.equal(cosine([1, 1], [0, 0]), 0)
  assert.ok(Math.abs(cosine([1, 0], [1, 0]) - 1) < 1e-12)
  assert.ok(Math.abs(cosine(new Float32Array([1, 0]), new Float32Array([0, 1]))) < 1e-12)
})
