import { test } from "node:test"
import assert from "node:assert/strict"

import {
  BOOTSTRAP_RESAMPLES,
  CONFIDENCE,
  MIN_GROUPS_PER_SIDE,
  clusterJobs,
  compareMedians,
  minGroupsFor,
  seedFromText,
} from "../../../../../../plugins/desk/mcp/src/factory/pipeline/compare.js"
import { compareVersions, isVersion } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/versions.js"

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

// Every value its own independent group.
const solo = (values) => values.map((value) => [value])

test("the comparison constants are the plan's 10,000 resamples and 95% interval, and the minimum groups follow from the confidence", () => {
  assert.equal(BOOTSTRAP_RESAMPLES, 10000)
  assert.equal(CONFIDENCE, 0.95)
  assert.equal(MIN_GROUPS_PER_SIDE, minGroupsFor(CONFIDENCE))
  // 2 * 0.5^6 = 0.031 <= 0.05, while 2 * 0.5^5 = 0.0625 is not.
  assert.equal(MIN_GROUPS_PER_SIDE, 6)
  assert.equal(minGroupsFor(0.5), 2)
  assert.equal(minGroupsFor(0.9), 5)
  assert.equal(minGroupsFor(0.99), 8)
  for (const bad of [0, 1, -0.5, 1.5, "0.95", Number.NaN]) assert.throws(() => minGroupsFor(bad), /strictly between 0 and 1/u, String(bad))
})

test("seedFromText is a stable 32-bit FNV-1a hash", () => {
  assert.equal(seedFromText(""), 0x811c9dc5)
  assert.equal(seedFromText("a"), 0xe40c292c)
  assert.equal(seedFromText("desk 3.2.0 tool_retries"), seedFromText("desk 3.2.0 tool_retries"))
  assert.notEqual(seedFromText("desk 3.2.0 tool_retries"), seedFromText("desk 3.2.0 tool_failures"))
})

test("clusterJobs joins jobs that share a session, directly or through another job, whatever their order", () => {
  const items = [
    { job: "e", sessions: ["s5"], value: 5 },
    { job: "a", sessions: ["s1", "s2"], value: 1 },
    { job: "c", sessions: ["s3"], value: 3 },
    { job: "b", sessions: ["s2"], value: 2 },
    { job: "d", sessions: ["s3", "s1"], value: 4 },
    { job: "f", sessions: [], value: 6 },
  ]
  assert.deepEqual(clusterJobs(items), [[1, 2, 3, 4], [5], [6]])
  assert.deepEqual(clusterJobs([...items].reverse()), [[1, 2, 3, 4], [5], [6]])
  assert.deepEqual(clusterJobs([{ job: "b", sessions: ["s"], value: 2 }, { job: "a", sessions: ["t"], value: 1 }, { job: "c", sessions: ["t", "s"], value: 3 }]), [[1, 2, 3]], "a later job joins two earlier groups")
  assert.deepEqual(clusterJobs([{ job: "a", sessions: ["s", "s"], value: 1 }]), [[1]])
  assert.deepEqual(clusterJobs([{ job: "a", sessions: ["s"], value: 1 }, { job: "a", sessions: ["t"], value: 2 }]), [[1], [2]], "equal job ids keep their given order")
  assert.deepEqual(clusterJobs([]), [])
})

test("compareMedians reports each side's jobs, groups and median, with no interval below the minimum groups a side", () => {
  const thin = compareMedians(solo([5, 6, 7, 8, 9]), solo([1, 2, 3, 4, 5, 6]), { seed: 1 })
  assert.deepEqual(thin, { before: { jobs: 5, groups: 5, median: 7 }, after: { jobs: 6, groups: 6, median: 3 }, change: -4, interval: null, direction: null })
  const empty = compareMedians([], [], { seed: 1 })
  assert.deepEqual(empty, { before: { jobs: 0, groups: 0, median: null }, after: { jobs: 0, groups: 0, median: null }, change: null, interval: null, direction: null })
  assert.equal(compareMedians([], solo([1]), { seed: 1 }).change, null)
})

test("compareMedians makes no claim from fully separated data too thin for a distribution-free interval", () => {
  // The review's example: two jobs a side, every after value above every before value.
  assert.equal(compareMedians(solo([1, 3]), solo([18, 169]), { seed: 1 }).interval, null)
  // Five a side is still too few at 95%; six a side is enough.
  assert.equal(compareMedians(solo([1, 2, 3, 4, 5]), solo([11, 12, 13, 14, 15]), { seed: 1 }).direction, null)
  assert.equal(compareMedians(solo([1, 2, 3, 4, 5, 6]), solo([11, 12, 13, 14, 15, 16]), { seed: 1 }).direction, "up")
})

test("compareMedians counts groups, not jobs, toward the minimum and resamples whole groups", () => {
  // Twelve jobs a side, but only three independent groups each: no interval.
  const grouped = [[1, 1, 1, 1], [2, 2, 2, 2], [3, 3, 3, 3]]
  const worse = [[20, 20, 20, 20], [21, 21, 21, 21], [22, 22, 22, 22]]
  const result = compareMedians(grouped, worse, { seed: 3 })
  assert.deepEqual(result.before, { jobs: 12, groups: 3, median: 2 })
  assert.equal(result.interval, null)
  // Resampling whole groups: with every group constant, each resampled median is one of the group values.
  const six = compareMedians([[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]], [[1, 1], [2, 2], [3, 3], [4, 4], [5, 5], [6, 6]], { seed: 3 })
  assert.ok(Number.isInteger(six.interval[0]) && Number.isInteger(six.interval[1]))
  assert.equal(six.direction, null)
})

test("compareMedians gives a seeded, repeatable 95% bootstrap interval and names the side it lies on", () => {
  const before = solo([10, 12, 11, 13, 12, 14, 10])
  const after = solo([3, 4, 2, 5, 3, 4])
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
  const same = compareMedians(solo([0, 0, 0, 0, 0, 0]), solo([0, 0, 0, 0, 0, 0]), { seed: 7 })
  assert.deepEqual(same.interval, [0, 0])
  assert.equal(same.direction, null)
  const overlapping = compareMedians(solo([1, 5, 9, 2, 8, 4]), solo([2, 6, 8, 1, 9, 5]), { seed: 7 })
  assert.ok(overlapping.interval[0] < 0 && overlapping.interval[1] > 0)
  assert.equal(overlapping.direction, null)
})

test("compareMedians depends on the seed only through the resamples and never reorders the caller's lists", () => {
  const before = solo([1, 9, 4, 7, 2, 8])
  const after = solo([3, 6, 5, 2, 9, 1])
  const a = compareMedians(before, after, { seed: 1 })
  const b = compareMedians(before, after, { seed: 2 })
  assert.equal(a.change, b.change)
  assert.deepEqual(before, solo([1, 9, 4, 7, 2, 8]))
  assert.deepEqual(after, solo([3, 6, 5, 2, 9, 1]))
  assert.throws(() => compareMedians(solo([1, 2]), solo([1, 2]), {}), /seed/u)
  assert.throws(() => compareMedians(solo([1, 2]), solo([1, 2])), /seed/u)
  assert.throws(() => compareMedians(solo([1, Number.NaN]), solo([1, 2]), { seed: 1 }), /finite/u)
  assert.throws(() => compareMedians([[1], []], solo([1, 2]), { seed: 1 }), /non-empty groups/u)
  assert.throws(() => compareMedians(solo([1]), [1, 2], { seed: 1 }), /non-empty groups/u)
  assert.throws(() => compareMedians(solo([1]), "12", { seed: 1 }), /non-empty groups/u)
})
