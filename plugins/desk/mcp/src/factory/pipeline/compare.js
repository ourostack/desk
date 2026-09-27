// Comparing a measure between two groups of finished jobs: the kaizen check
// (jobs before a countermeasure's version against jobs on it or later) and
// andon (a plugin's version against the one before it) both use it.
//
// Rules (plan rulings, 2026-09-25, and the M5-4/M5-5 review; no tuned
// thresholds):
//   - Jobs that share a session are not independent: the per-job measures
//     count that session's events in each of them. `clusterJobs` joins jobs
//     that share any session, directly or through other jobs, into one
//     independent group, and the comparison resamples groups, not jobs.
//   - Each side's median is the rollups' nearest-rank median (`quantile`) of
//     every job's value, and the change is the after median minus the before
//     median.
//   - The uncertainty is a percentile cluster bootstrap of that change:
//     10,000 resamples, each drawing every side's groups with replacement at
//     that side's group count, from a seeded generator (mulberry32), so the
//     same data and seed give byte-identical results. The interval is the
//     nearest-rank lower and upper `(1 - CONFIDENCE) / 2` percentiles of the
//     resampled changes. 95% is the conventional statistical default.
//   - A side enters the comparison only when a distribution-free confidence
//     interval for its median can exist at `CONFIDENCE`: with n independent
//     values, the chance that all of them fall on one side of the true median
//     is 2 * 0.5^n, and that must be at most 1 - CONFIDENCE. The least such n
//     is `minGroupsFor(CONFIDENCE)` (6 at 95%). Below it on either side there
//     is no interval and no direction, whatever the values: the data cannot
//     support a claim at that level.
//   - A direction (`down` or `up`) is named only when the whole interval lies
//     on one side of zero; an interval that touches or spans zero names none.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { quantile } from "./rollups.js"

export const BOOTSTRAP_RESAMPLES = 10000
export const CONFIDENCE = 0.95

/**
 * `minGroupsFor(confidence) -> number`: the least number of independent
 * values for which a distribution-free interval for a median can exist at
 * `confidence`, the least n with 2 * 0.5^n <= 1 - confidence.
 */
export function minGroupsFor(confidence) {
  if (!(typeof confidence === "number" && confidence > 0 && confidence < 1)) throw new RangeError("minGroupsFor: confidence must lie strictly between 0 and 1")
  let groups = 1
  while (2 * 0.5 ** groups > 1 - confidence) groups += 1
  return groups
}

export const MIN_GROUPS_PER_SIDE = minGroupsFor(CONFIDENCE)

/** `seedFromText(text) -> number`: the 32-bit FNV-1a hash of `text`'s UTF-16 code units, a stable seed. */
export function seedFromText(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
}

/**
 * `clusterJobs(items) -> number[][]`: `items` (`{ job, sessions, value }`,
 * `sessions` the job's session ids) joined into groups of jobs that share a
 * session, directly or through other jobs, as lists of values. Groups are
 * ordered by their first job id and values by job id, so the result does not
 * depend on the order of `items`.
 */
export function clusterJobs(items) {
  const sorted = [...items].sort((left, right) => (left.job < right.job ? -1 : left.job > right.job ? 1 : 0))
  const parent = sorted.map((_, index) => index)
  const root = (index) => {
    let at = index
    while (parent[at] !== at) at = parent[at]
    return at
  }
  const owner = new Map()
  sorted.forEach((item, index) => {
    for (const session of item.sessions) {
      if (!owner.has(session)) {
        owner.set(session, index)
        continue
      }
      const [left, right] = [root(owner.get(session)), root(index)]
      if (left !== right) parent[Math.max(left, right)] = Math.min(left, right)
    }
  })
  const groups = new Map()
  sorted.forEach((item, index) => {
    const key = root(index)
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(item.value)
  })
  return [...groups.values()]
}

// mulberry32: a small, well-known 32-bit generator; deterministic across platforms.
function generator(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function resampledMedian(groups, next) {
  const draw = []
  for (let index = 0; index < groups.length; index += 1) draw.push(...groups[Math.floor(next() * groups.length)])
  return quantile(draw, 0.5)
}

function requireGroups(groups) {
  if (!Array.isArray(groups) || !groups.every((group) => Array.isArray(group) && group.length > 0 && group.every((value) => Number.isFinite(value)))) {
    throw new TypeError("compareMedians: each side must be a list of non-empty groups of finite numbers")
  }
}

function side(groups) {
  const values = groups.flat()
  return { jobs: values.length, groups: groups.length, median: quantile(values, 0.5) }
}

/**
 * `compareMedians(before, after, { seed }) -> { before, after, change,
 * interval, direction }`: each side is a list of independent groups of job
 * values (`clusterJobs`). The result gives each side's job count, group
 * count and median, the change in median (after minus before), the
 * `CONFIDENCE` cluster-bootstrap interval `[low, high]` (or `null` when a
 * side has fewer than `MIN_GROUPS_PER_SIDE` groups) and the direction the
 * whole interval lies in (`down`, `up` or `null`). See the header.
 */
export function compareMedians(before, after, { seed } = {}) {
  if (!Number.isSafeInteger(seed)) throw new TypeError("compareMedians: seed must be an integer")
  requireGroups(before)
  requireGroups(after)
  const result = { before: side(before), after: side(after), change: null, interval: null, direction: null }
  if (result.before.median !== null && result.after.median !== null) result.change = result.after.median - result.before.median
  if (before.length < MIN_GROUPS_PER_SIDE || after.length < MIN_GROUPS_PER_SIDE) return result
  const next = generator(seed)
  const changes = new Array(BOOTSTRAP_RESAMPLES)
  for (let index = 0; index < BOOTSTRAP_RESAMPLES; index += 1) changes[index] = resampledMedian(after, next) - resampledMedian(before, next)
  const tail = (1 - CONFIDENCE) / 2
  const interval = [quantile(changes, tail), quantile(changes, 1 - tail)]
  return { ...result, interval, direction: interval[1] < 0 ? "down" : interval[0] > 0 ? "up" : null }
}
