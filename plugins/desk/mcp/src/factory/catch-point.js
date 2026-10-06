// Where a defect was caught, placed by Desk and never by the evaluator.
//
// A `defects` stretch is `in_task` when it starts before the job's first review, `at_review` when it starts at or after the first review and before the first delivery, and `after_delivery` when it starts at or after the first delivery. A stretch is placed by its start, however long it runs. The two times come from the job's local outcome entry (`first_validating_at`, `first_delivered_at`) and are put on the session clock by subtracting the session's start.
//
// Desk places a stretch only when it can tie the stretch to exactly one job's record that was kept from the job's creation:
//   - the session is bound to exactly one job, and the facts hold exactly one outcome entry for it (`outcomeForStamping`);
//   - the entry's `since` is `created` (an adopted record has no history before adoption);
//   - the entry carries both milestone keys. A key that is absent means the record does not say; `null` means the milestone has not happened;
//   - a milestone time that is present is a real timestamp, and the session's start is too;
//   - a delivery was made (`deliveries` above 0) only if `first_delivered_at` says when.
// A `null` `first_validating_at` with a time for `first_delivered_at` places by delivery only (before it is `in_task`, from it `after_delivery`). A time for `first_validating_at` with a `null` `first_delivered_at` places by review only. Two `null` times mean the job has not yet reached review or delivery, so every defect is `in_task`.
// When any of this fails, no stretch is stamped, and the time reads "not placed" in the report. Every other waste is never stamped, and a `caught` the evaluator wrote is always removed first.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { isPlainObject } from "./schema.js"

const timeOf = (value) => (typeof value === "string" ? Date.parse(value) : Number.NaN)

// The two milestone offsets on the session clock (`null` for a milestone not reached), or `undefined` when the record cannot place anything.
function milestones(outcome, startedMs) {
  if (!isPlainObject(outcome) || outcome.since !== "created" || Number.isNaN(startedMs)) return undefined
  if (!Object.hasOwn(outcome, "first_validating_at") || !Object.hasOwn(outcome, "first_delivered_at")) return undefined
  const offsets = []
  for (const key of ["first_validating_at", "first_delivered_at"]) {
    if (outcome[key] === null) offsets.push(null)
    else if (Number.isNaN(timeOf(outcome[key]))) return undefined
    else offsets.push(timeOf(outcome[key]) - startedMs)
  }
  if (offsets[1] === null && outcome.deliveries > 0) return undefined
  return offsets
}

function caughtAt(start, [review, delivered]) {
  if (delivered !== null && start >= delivered) return "after_delivery"
  if (review !== null && start >= review) return "at_review"
  return "in_task"
}

/**
 * `stampCatchPoints(labels, { outcome, startedAt }) -> labels`: a copy of valid labels with `caught` on each `defects` stretch Desk can place from the job's local outcome entry `outcome` and the session's start `startedAt` (an ISO time), as the header says. Any `caught` already on a stretch is removed first; the input is never changed.
 */
export function stampCatchPoints(labels, { outcome, startedAt }) {
  const stamped = structuredClone(labels)
  const offsets = milestones(outcome, timeOf(startedAt))
  for (const stretch of stamped.stretches) {
    delete stretch.caught
    if (offsets !== undefined && stretch.waste === "defects") stretch.caught = caughtAt(stretch.start_ms, offsets)
  }
  return stamped
}

/**
 * `outcomeForStamping(localFacts, job) -> entry | null`: the job's outcome entry in the session's local facts, only when the session is bound to exactly that one job and the facts hold exactly one entry for it.
 */
export function outcomeForStamping(localFacts, job) {
  if (localFacts.jobs.length !== 1 || localFacts.jobs[0].job !== job) return null
  const entries = (localFacts.outcomes ?? []).filter((entry) => entry.job === job)
  return entries.length === 1 ? entries[0] : null
}
