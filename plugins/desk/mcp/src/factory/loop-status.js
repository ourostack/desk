// Step bookkeeping for the factory loop. Each automatic step records when it last ran, when it last
// succeeded and a stable result code in `status.json` under `loop.steps.<name>`. A step that never ran has
// no record, and a step that ran and failed keeps `last_ok_at` as it was (null if it never succeeded), so a
// step that did not run never looks like one that ran and found nothing. No free text enters the record.

import { updateStatus } from "./outbox.js"

export const STEPS = Object.freeze(["evaluate", "route", "mirror", "reconcile", "verify", "measure", "deliver"])

/** The shortest time between two runs of a step, in hours; 0 means the step runs every time it is asked. */
export const MIN_GAP_HOURS = Object.freeze({ evaluate: 1, route: 6, mirror: 6, reconcile: 24, verify: 24, measure: 0, deliver: 0 })

const STALE_AFTER_HOURS = 72
const STALE_FAILURES_IN_A_ROW = 3
const HOUR_MS = 3600 * 1000
const RESULT_CODE = /^[a-z0-9][a-z0-9_:-]{0,63}$/

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)

function requireStep(name) {
  if (!STEPS.includes(name)) throw new TypeError(`step: unknown step`)
}

function toTime(value) {
  if (value === null) throw new TypeError("now: must be a valid time")
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) throw new TypeError("now: must be a valid time")
  return time
}

function timeOrNull(value) {
  const time = typeof value === "string" ? Date.parse(value) : Number.NaN
  return Number.isNaN(time) ? null : time
}

/** A stored counter that is not a non-negative safe integer is damaged and counts as 0. */
const counter = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

function stepsOf(status) {
  return isObject(status?.loop) && isObject(status.loop.steps) ? status.loop.steps : {}
}

/** `recordStep(env, name, { ok, result, now }) -> step record`: counts one run of `name` in `status.loop.steps.<name>`. `result` is a lowercase code of at most 64 characters. */
export async function recordStep(env, name, { ok, result, now = new Date() } = {}) {
  requireStep(name)
  if (typeof ok !== "boolean") throw new TypeError("ok: must be a boolean")
  if (typeof result !== "string" || !RESULT_CODE.test(result)) throw new TypeError("result: must be a lowercase code of at most 64 characters")
  const at = new Date(toTime(now)).toISOString()
  let record
  await updateStatus(env, (current) => {
    const loop = isObject(current.loop) ? current.loop : {}
    const steps = isObject(loop.steps) ? loop.steps : {}
    const before = isObject(steps[name]) ? steps[name] : {}
    record = {
      last_ran_at: at,
      last_ok_at: ok ? at : (before.last_ok_at ?? null),
      last_result: result,
      runs: counter(before.runs) + 1,
      failures: counter(before.failures) + (ok ? 0 : 1),
      failures_in_a_row: ok ? 0 : counter(before.failures_in_a_row) + 1,
    }
    return { ...current, loop: { ...loop, steps: { ...steps, [name]: record } } }
  })
  return record
}

/**
 * `dueStep(status, name, now, { newWorkAt }) -> boolean`: true for a step that never ran, or whose last run is at least `MIN_GAP_HOURS[name]`
 * old, or that last ran before `newWorkAt` (milliseconds, or null): work that arrived after the step last ran makes it due at once, whatever
 * the gap. The evaluator step passes its newest evaluation request, so a finished job never waits out the gap.
 */
export function dueStep(status, name, now, { newWorkAt = null } = {}) {
  requireStep(name)
  const nowMs = toTime(now)
  const ranAt = timeOrNull(stepsOf(status)[name]?.last_ran_at)
  if (ranAt === null) return true
  if (Number.isFinite(newWorkAt) && newWorkAt > ranAt) return true
  const elapsed = nowMs - ranAt
  return elapsed < 0 || elapsed >= MIN_GAP_HOURS[name] * HOUR_MS
}

/** `staleSteps(status, now, attemptedNames) -> string[]`: the steps attempted in this run whose last success is over 72 hours old (or over 72 hours ahead of the clock), or that failed 3 times in a row. An unreadable non-null `last_ok_at` counts as stale; a null one has no age. A step not attempted is never reported. */
export function staleSteps(status, now, attemptedNames) {
  const steps = stepsOf(status)
  const nowMs = toTime(now)
  return attemptedNames.filter((name) => {
    const record = steps[name]
    if (!STEPS.includes(name) || !isObject(record)) return false
    if (counter(record.failures_in_a_row) >= STALE_FAILURES_IN_A_ROW) return true
    if (record.last_ok_at === null || record.last_ok_at === undefined) return false
    const okAt = timeOrNull(record.last_ok_at)
    // A success dated more than the stale window ahead of the clock (a clock that moved back) has no knowable age, so it reads stale rather than fresh for days.
    return okAt === null || Math.abs(nowMs - okAt) > STALE_AFTER_HOURS * HOUR_MS
  })
}
