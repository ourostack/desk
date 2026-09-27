// Comparing a measure between two groups of finished jobs: the kaizen check
// (jobs before a countermeasure's version against jobs on it or later) and
// andon (a plugin's latest version against the one before it) both use it.
//
// Rules (plan rulings, 2026-09-25; no made-up thresholds):
//   - Each side's median uses the rollups' nearest-rank method (`quantile`),
//     and the change is the after median minus the before median.
//   - The uncertainty is a percentile bootstrap of that change: 10,000
//     resamples, each drawing every side with replacement at its own size,
//     from a seeded generator (mulberry32), so the same data and seed give
//     byte-identical results. The 95% interval is the nearest-rank 2.5th and
//     97.5th percentiles of the resampled changes. 95% is the conventional
//     statistical default, not a tuned number.
//   - A direction (`down` or `up`) is named only when the whole interval lies
//     on one side of zero; an interval that touches or spans zero names none.
//   - Below two jobs on either side there is no interval: resampling one
//     value can only return that value, so the interval would claim a
//     certainty the data cannot give (the plan's "no causal claims from one
//     job"). Two is the least a bootstrap can vary with, not a tuned number.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { quantile } from "./rollups.js"

export const BOOTSTRAP_RESAMPLES = 10000
export const CONFIDENCE = 0.95
export const MIN_JOBS_PER_SIDE = 2

/** `seedFromText(text) -> number`: the 32-bit FNV-1a hash of `text`'s UTF-16 code units, a stable seed. */
export function seedFromText(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash
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

function resampledMedian(values, next) {
  const draw = new Array(values.length)
  for (let index = 0; index < values.length; index += 1) draw[index] = values[Math.floor(next() * values.length)]
  return quantile(draw, 0.5)
}

function requireFinite(values) {
  if (!values.every((value) => Number.isFinite(value))) throw new TypeError("compareMedians: values must be finite numbers")
}

/**
 * `compareMedians(before, after, { seed }) -> { before, after, change,
 * interval, direction }`: each side's job count and median, the change in
 * median (after minus before), the 95% bootstrap interval `[low, high]` (or
 * `null` below two jobs a side) and the direction the whole interval lies in
 * (`down`, `up` or `null`). See the header for the method.
 */
export function compareMedians(before, after, { seed } = {}) {
  if (!Number.isSafeInteger(seed)) throw new TypeError("compareMedians: seed must be an integer")
  requireFinite(before)
  requireFinite(after)
  const beforeMedian = quantile(before, 0.5)
  const afterMedian = quantile(after, 0.5)
  const result = {
    before: { jobs: before.length, median: beforeMedian },
    after: { jobs: after.length, median: afterMedian },
    change: beforeMedian === null || afterMedian === null ? null : afterMedian - beforeMedian,
    interval: null,
    direction: null,
  }
  if (before.length < MIN_JOBS_PER_SIDE || after.length < MIN_JOBS_PER_SIDE) return result
  const next = generator(seed)
  const changes = new Array(BOOTSTRAP_RESAMPLES)
  for (let index = 0; index < BOOTSTRAP_RESAMPLES; index += 1) changes[index] = resampledMedian(after, next) - resampledMedian(before, next)
  const tail = (1 - CONFIDENCE) / 2
  const interval = [quantile(changes, tail), quantile(changes, 1 - tail)]
  return { ...result, interval, direction: interval[1] < 0 ? "down" : interval[0] > 0 ? "up" : null }
}
