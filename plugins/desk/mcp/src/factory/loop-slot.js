// The loop health record flattened to the capture record's loop slot (`loop_slot_v1` of the store; the rule is `validateLoopSlot` in `capture-schema.js`).
//
// The slot is counts only. Each key is read from one field of the stored `desk.factory.loop/1` record (`loop-health.js`), and only a measured Count
// becomes a number: an unavailable, partial (a lower bound, not the number), damaged or missing field is `null`, the contract's "not measured",
// never 0. `headless` is the evaluator's state code, `null` when it is not recorded for today. Nothing else is read, so no name, path, title,
// card text or date can reach the slot, and nothing in it is per person.
//
// A record older than `SLOT_MAX_AGE_HOURS` (or dated in the future) says nothing about now, so it gives no slot. The age of the oldest open card is
// aged by the record's own age in whole days, because the slot has no date and the store counts from the capture commit. A key whose value fails
// the store's rule is sent as `null` and the rest of the slot goes; `slotValid` is false for it, so the measure step raises
// `loop_alarm:capture_loop_slot`.

import { LOOP_SLOT_VERSION, validateLoopSlot } from "./capture-schema.js"

export const SLOT_MAX_AGE_HOURS = 72
const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS
const FUTURE_ALLOWANCE_MS = 5 * 60 * 1000

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

/** A stored Count's value when it is measured and a non-negative whole number, else null. A value over the store's ceiling is kept, so the slot fails its rule and says so. */
function measuredValue(count) {
  return isObject(count) && count.state === "measured" && Number.isSafeInteger(count.value) && count.value >= 0 ? count.value : null
}

function staleStepCount(steps) {
  const records = isObject(steps) ? Object.values(steps).filter(isObject) : []
  // No step ever ran: nothing is known to be stale, and nothing is known to be fresh either.
  if (!records.some((record) => typeof record.last_ran_at === "string")) return null
  return records.filter((record) => record.stale === true).length
}

/** `slotFields(record) -> object`: the slot's keys and values from the stored loop record, `v` first. Not yet validated. */
export function slotFields(record) {
  const improvement = isObject(record.improvement) ? record.improvement : {}
  const alarms = isObject(record.alarms) ? record.alarms : {}
  const headless = isObject(record.evaluator) && isObject(record.evaluator.headless) ? record.evaluator.headless.state : null
  return {
    v: LOOP_SLOT_VERSION,
    improvement_open: measuredValue(improvement.open),
    improvement_claimed: measuredValue(improvement.claimed),
    improvement_shipped: measuredValue(improvement.shipped),
    improvement_verifying: measuredValue(improvement.verifying),
    oldest_open_age_days: measuredValue(improvement.oldest_open_age_days),
    closed_confirmed_month: measuredValue(improvement.closed_confirmed_30d),
    closed_unverified_month: measuredValue(improvement.closed_unverified_30d),
    loop_alarms_open: measuredValue(alarms.loop_alarms_open),
    steps_stale: staleStepCount(record.steps),
    headless: typeof headless === "string" && headless !== "unavailable" ? headless : null,
  }
}

/** `slotValid(record) -> boolean`: whether the slot built from `record` passes the store's rule. False for a value that is not a loop record. */
export function slotValid(record) {
  return isObject(record) && validateLoopSlot(slotFields(record), "", [])
}

/** `sound(key, value) -> boolean`: whether `value` alone passes the store's rule for `key`. */
const sound = (key, value) => validateLoopSlot({ v: LOOP_SLOT_VERSION, [key]: value }, "", [])

/**
 * `loopSlotFrom(record, nowMs) -> slot | null`: the slot for the capture record, or null when there is no current record. The record must be
 * a `desk.factory.loop/1` record written at most `SLOT_MAX_AGE_HOURS` ago. A key that fails the store's rule is `null`; the other keys are kept.
 */
export function loopSlotFrom(record, nowMs) {
  if (!isObject(record) || record.schema !== "desk.factory.loop/1") return null
  const at = typeof record.written_at === "string" ? Date.parse(record.written_at) : Number.NaN
  if (!Number.isFinite(at) || nowMs - at > SLOT_MAX_AGE_HOURS * HOUR_MS || at - nowMs > FUTURE_ALLOWANCE_MS) return null
  const fields = slotFields(record)
  if (fields.oldest_open_age_days !== null) fields.oldest_open_age_days += Math.max(0, Math.floor((nowMs - at) / DAY_MS))
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, key === "v" || sound(key, value) ? value : null]))
}
