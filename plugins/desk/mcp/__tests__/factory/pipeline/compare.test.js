import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BOOTSTRAP_RESAMPLES,
  CONFIDENCE,
  MIN_JOBS_PER_SIDE,
  compareMedians,
  seedFromText,
} from "../../../src/factory/pipeline/compare.js"
import { compareVersions, isVersion } from "../../../src/factory/pipeline/versions.js"

test("versions order by semantic-version precedence, as Desk's release checks do", () => {
  const ordered = ["1.0.0-alpha.1", "1.0.0-alpha.2", "1.0.0-alpha.10", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0", "1.0.1", "1.2.0", "2.0.0"]
  for (let index = 1; index < ordered.length; index += 1) {
    assert.ok(compareVersions(ordered[index - 1], ordered[index]) < 0, `${ordered[index - 1]} < ${ordered[index]}`)
    assert.ok(compareVersions(ordered[index], ordered[index - 1]) > 0, `${ordered[index]} > ${ordered[index - 1]}`)
  }
  assert.equal(compareVersions("3.1.0-alpha.7", "3.1.0-alpha.7"), 0)
  // A shorter prerelease sorts first when every shared identifier is equal.
  assert.ok(compareVersions("1.0.0-alpha", "1.0.0-alpha.1") < 0)
  assert.ok(compareVersions("1.0.0-alpha.1", "1.0.0-alpha") > 0)
  assert.ok(compareVersions("1.0.0-b", "1.0.0-a") > 0)
})

test("isVersion accepts the published semver shape only", () => {
  assert.equal(isVersion("3.1.0-alpha.7"), true)
  assert.equal(isVersion("3.2.0"), true)
  for (const value of ["3.2", "v3.2.0", "3.2.0-", "3.2.0+build", 3, null, "3.1.0-alpha.7 "]) assert.equal(isVersion(value), false, String(value))
  assert.throws(() => compareVersions("3.2", "3.2.0"), /not a version/u)
})

test("the comparison constants are the plan's: 10,000 resamples, a 95% interval and two jobs a side", () => {
  assert.equal(BOOTSTRAP_RESAMPLES, 10000)
  assert.equal(CONFIDENCE, 0.95)
  assert.equal(MIN_JOBS_PER_SIDE, 2)
})

test("seedFromText is a stable 32-bit FNV-1a hash", () => {
  assert.equal(seedFromText(""), 0x811c9dc5)
  assert.equal(seedFromText("a"), 0xe40c292c)
  assert.equal(seedFromText("desk 3.2.0 tool_retries"), seedFromText("desk 3.2.0 tool_retries"))
  assert.notEqual(seedFromText("desk 3.2.0 tool_retries"), seedFromText("desk 3.2.0 tool_failures"))
})

test("compareMedians reports both medians and the change, with no interval below two jobs a side", () => {
  const one = compareMedians([5], [3, 4], { seed: 1 })
  assert.deepEqual(one, { before: { jobs: 1, median: 5 }, after: { jobs: 2, median: 3 }, change: -2, interval: null, direction: null })
  const empty = compareMedians([], [], { seed: 1 })
  assert.deepEqual(empty, { before: { jobs: 0, median: null }, after: { jobs: 0, median: null }, change: null, interval: null, direction: null })
})

test("compareMedians gives a seeded, repeatable 95% bootstrap interval and names the side it lies on", () => {
  const before = [10, 12, 11, 13, 12, 14, 10]
  const after = [3, 4, 2, 5, 3, 4]
  const first = compareMedians(before, after, { seed: 42 })
  const again = compareMedians(before, after, { seed: 42 })
  assert.deepEqual(first, again)
  assert.equal(first.before.median, 12)
  assert.equal(first.after.median, 3)
  assert.equal(first.change, -9)
  assert.ok(first.interval[0] <= first.interval[1])
  assert.ok(first.interval[1] < 0)
  assert.equal(first.direction, "down")
  const up = compareMedians(after, before, { seed: 42 })
  assert.ok(up.interval[0] > 0)
  assert.equal(up.direction, "up")
})

test("compareMedians names no direction when the interval touches or spans zero", () => {
  const same = compareMedians([0, 0, 0], [0, 0], { seed: 7 })
  assert.deepEqual(same.interval, [0, 0])
  assert.equal(same.direction, null)
  const overlapping = compareMedians([1, 5, 9, 2, 8], [2, 6, 8, 1, 9], { seed: 7 })
  assert.ok(overlapping.interval[0] < 0 && overlapping.interval[1] > 0)
  assert.equal(overlapping.direction, null)
})

test("compareMedians depends on the seed only through the resamples and never reorders the caller's lists", () => {
  const before = [1, 9, 4, 7, 2, 8]
  const after = [3, 6, 5, 2, 9, 1]
  const a = compareMedians(before, after, { seed: 1 })
  const b = compareMedians(before, after, { seed: 2 })
  assert.equal(a.change, b.change)
  assert.deepEqual(before, [1, 9, 4, 7, 2, 8])
  assert.deepEqual(after, [3, 6, 5, 2, 9, 1])
  assert.throws(() => compareMedians([1, 2], [1, 2], {}), /seed/u)
  assert.throws(() => compareMedians([1, 2], [1, 2]), /seed/u)
  assert.throws(() => compareMedians([1, Number.NaN], [1, 2], { seed: 1 }), /finite/u)
})
