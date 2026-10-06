// The loop's conditions record. For each improvement-card key `<source>:<id>` it keeps, in `status.json` under
// `loop.conditions`, whether the condition held at the last successful observation and how many counted
// observations in a row found it clear. The route collectors write it; the measure and verify steps read it,
// so "the condition was false at 2 consecutive measures" is stated once. A missing or damaged entry reads as
// unavailable, never as clear, and an observation that could not be made is never recorded. Keys are the card
// library's own, so nothing but a well-formed key enters, and no free text is stored.

import { SOURCES, cardKey } from "../desk/improvement-cards.js"
import { PATTERNS } from "./schema.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { updateStatus } from "./outbox.js"

/** The shortest time between two observations of a source that both count as a clear run, in hours. Two looks closer together are one look. */
export const MIN_OBSERVATION_GAP_HOURS = 6

/** The most keys kept. Over it, keys that are not present go first (damaged, then the longest since observed, then the fewest clear runs); a present key is never dropped. */
export const MAX_CONDITIONS = 500

const HOUR_MS = 3600 * 1000

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const timeOf = (value) => (typeof value === "string" && PATTERNS.timestamp.test(value) ? Date.parse(value) : Number.NaN)

const isValidEntry = (entry) =>
  isObject(entry) &&
  typeof entry.present === "boolean" &&
  Number.isSafeInteger(entry.clear_runs) && entry.clear_runs >= 0 &&
  !(entry.present && entry.clear_runs !== 0) &&
  !Number.isNaN(timeOf(entry.observed_at))

/** `conditionOf(status, key) -> { state: "measured", present, clear_runs, observed_at } | { state: "unavailable", reason: "not_observed" | "damaged" }`. */
export function conditionOf(status, key) {
  const conditions = isObject(status?.loop) ? status.loop.conditions : undefined
  if (conditions === undefined) return { state: "unavailable", reason: "not_observed" }
  if (!isObject(conditions)) return { state: "unavailable", reason: "damaged" }
  if (!Object.hasOwn(conditions, key)) return { state: "unavailable", reason: "not_observed" }
  const entry = conditions[key]
  if (!isValidEntry(entry)) return { state: "unavailable", reason: "damaged" }
  return { state: "measured", present: entry.present, clear_runs: entry.clear_runs, observed_at: entry.observed_at }
}

function wellFormedKeys(source, present) {
  const keys = new Set()
  for (const id of present) {
    try {
      if (typeof id !== "string") return null
      keys.add(cardKey(source, id))
    } catch {
      return null
    }
  }
  return keys
}

/** Drops keys over the bound, worst first; present keys are kept even when they alone exceed it. */
function bounded(conditions) {
  const keys = Object.keys(conditions)
  let over = keys.length - MAX_CONDITIONS
  if (over <= 0) return conditions
  const rank = (key) => {
    const entry = conditions[key]
    if (!isValidEntry(entry)) return [0, 0, 0]
    return entry.present ? null : [1, timeOf(entry.observed_at), entry.clear_runs]
  }
  const droppable = keys.map((key) => ({ key, rank: rank(key) })).filter((item) => item.rank !== null)
  droppable.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1] || a.rank[2] - b.rank[2])
  const kept = { ...conditions }
  for (const { key } of droppable) {
    if (over-- <= 0) break
    delete kept[key]
  }
  return kept
}

/**
 * `observeConditions(env, { source, present, now, updateStatusImpl }) -> { ok, result }`: records one successful observation of `source`.
 * `present` is every id of that source whose condition holds right now. A key in `present` is recorded as present with 0 clear runs; every other
 * key of the source already recorded is recorded as not present with one more clear run, unless the last counted look at it was less than
 * `MIN_OBSERVATION_GAP_HOURS` ago (then it is not counted again). A damaged entry of an absent key is left as it is, so it never reads as clear.
 * A collector that could not look must not call this. Results: `observed`, `observed_within_gap` (ok); `headless_session`, `invalid_source`,
 * `invalid_present`, `invalid_key`, `invalid_time`, `status_unwritable` (not ok, nothing written).
 */
export async function observeConditions(env, { source, present, now = new Date(), updateStatusImpl = updateStatus }) {
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session" }
  if (!SOURCES.includes(source)) return { ok: false, result: "invalid_source" }
  if (!Array.isArray(present)) return { ok: false, result: "invalid_present" }
  const keys = wellFormedKeys(source, present)
  if (keys === null) return { ok: false, result: "invalid_key" }
  const nowMs = now === null ? Number.NaN : new Date(now).getTime()
  if (Number.isNaN(nowMs)) return { ok: false, result: "invalid_time" }
  const stamp = new Date(nowMs).toISOString()
  let counted = false
  let skipped = false
  try {
    await updateStatusImpl(env, (current) => {
      const loop = isObject(current.loop) ? current.loop : {}
      const before = isObject(loop.conditions) ? loop.conditions : {}
      const next = { ...before }
      counted = false
      skipped = false
      for (const key of keys) next[key] = { present: true, clear_runs: 0, observed_at: stamp, counted_at: stamp }
      for (const [key, entry] of Object.entries(before)) {
        if (keys.has(key) || !key.startsWith(`${source}:`) || !isValidEntry(entry)) continue
        const lastCounted = Number.isNaN(timeOf(entry.counted_at)) ? timeOf(entry.observed_at) : timeOf(entry.counted_at)
        const elapsed = nowMs - lastCounted
        const countsNow = elapsed >= MIN_OBSERVATION_GAP_HOURS * HOUR_MS
        if (countsNow) counted = true
        else skipped = true
        // A clock that moved back, or an entry dated ahead, never counts; the stamp is pulled back to now so it blocks for at most one gap.
        const stampKept = new Date(Math.min(lastCounted, nowMs)).toISOString()
        next[key] = countsNow
          ? { present: false, clear_runs: entry.clear_runs + 1, observed_at: stamp, counted_at: stamp }
          : { present: false, clear_runs: entry.clear_runs, observed_at: stamp, counted_at: stampKept }
      }
      return { ...current, loop: { ...loop, conditions: bounded(next) } }
    })
  } catch {
    return { ok: false, result: "status_unwritable" }
  }
  return { ok: true, result: skipped && !counted ? "observed_within_gap" : "observed" }
}
