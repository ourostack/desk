// Estimated human attention, method version 1. One constants table and pure functions of content-free turn events: a change to the table re-reads all history because the store recomputes from the events.
//
// The second half of this file places a session's turns on the jobs it worked on (`placeTurns`) and builds the per-job `attention` result from them (`attentionFormula`).

import { stated } from "./number-states.js"

export const ATTENTION_METHOD = 1
export const FLOOR_MS = 1000
export const PERMISSION_MS = 5000

// Reading the reply: about 50 ms per character of a representative reply for the size class.
export const READ_MS = Object.freeze({ none: 0, xs: 1000, s: 5000, m: 30_000, l: 150_000, xl: 400_000 })

// Writing the prompt: about 300 ms per character up to `m`; `l` and `xl` are mostly pasted and held at 180 seconds.
export const TYPE_MS = Object.freeze({ none: 2000, xs: 3000, s: 25_000, m: 150_000, l: 180_000, xl: 180_000 })

/** The one error the estimator throws for a turn or a wait it cannot read. Callers that turn a broken turn into a stated gap catch this class only, so a programming error still stops the build. */
export class EstimatorError extends Error {
  constructor(message) {
    super(message)
    this.name = "EstimatorError"
  }
}

function lookup(table, cls, field) {
  if (typeof cls !== "string" || !Object.hasOwn(table, cls)) throw new EstimatorError(`unknown ${field}`)
  return table[cls]
}

function checkMs(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new EstimatorError(`${field} must be a non-negative finite number`)
}

const BASES = Object.freeze(["first", "after_stop", "mid_turn"])

// A null window means no bound and belongs to basis `first` alone; every other basis needs a window. A wrong pairing is a broken input and throws.
export function estimateTurn(turn) {
  if (!turn || typeof turn !== "object") throw new EstimatorError("turn must be an object")
  const read = lookup(READ_MS, turn.output_class, "output_class")
  const type = lookup(TYPE_MS, turn.prompt_class, "prompt_class")
  if (!BASES.includes(turn.basis)) throw new EstimatorError("unknown basis")
  if ((turn.basis === "first") !== (turn.window_ms === null)) throw new EstimatorError("window_ms must be null exactly when basis is first")
  let bound = Infinity
  if (turn.window_ms !== null) {
    checkMs(turn.window_ms, "window_ms")
    bound = turn.window_ms
  }
  return Math.max(FLOOR_MS, Math.min(bound, read + type))
}

export function estimatePermission(waitMs) {
  checkMs(waitMs, "permission wait")
  return Math.max(FLOOR_MS, Math.min(waitMs, PERMISSION_MS))
}

export function methodRecord() {
  return { version: ATTENTION_METHOD, read_ms: { ...READ_MS }, type_ms: { ...TYPE_MS }, floor_ms: FLOOR_MS, permission_ms: PERMISSION_MS }
}

// Every reason the per-job attention result can carry on its own account (`mixed` is only ever its `reason`, never one of its `reasons`). The reasons a host's own flag on `human_turns` adds (`host_records_partly`, `source_unreadable`, `log_truncated`) are passed through as the flag names them.
export const ATTENTION_REASONS = Object.freeze(["not_recorded", "desk_public", "no_segments", "turns_not_recorded", "turns_capped", "turn_not_estimable"])

const emptyBucket = () => ({ turns: 0, est_ms: 0, unestimated: 0 })
const compareText = (left, right) => Number(left > right) - Number(left < right)
const flagReasons = (session) => session.unavailable.filter((entry) => entry.field === "human_turns").map((entry) => entry.reason)
const isPublicDesk = (session) => session.unavailable.some((entry) => entry.field === "job_offsets" && entry.reason === "desk_public")

// The job whose segment holds `atMs` (segments are half-open); when several do, the one whose segment started last, and for equal starts the job that sorts first, so the answer never depends on the order of the bindings.
export function ownerOf(bindings, atMs) {
  let best = null
  for (const binding of bindings) {
    for (const segment of binding.segments) {
      if (segment.start_ms > atMs || atMs >= segment.end_ms) continue
      if (best === null || segment.start_ms > best.start || (segment.start_ms === best.start && compareText(binding.job, best.job) < 0)) best = { start: segment.start_ms, job: binding.job }
    }
  }
  return best === null ? null : best.job
}

/**
 * `placeTurns(session) -> { byJob, unattributed, unplaced, recorded, capped, unestimated }` for a published session. Each human turn goes to the job whose segment holds its time, to nobody ("unattributed") when no segment does, and to "unplaced" when the session has jobs but none publishes segments. A session with no job leaves its turns unattributed. Nothing is dropped: every turn is in exactly one bucket, and a turn the estimator rejects is counted in its bucket's `turns` and `unestimated` with no time added, never skipped and never thrown. `byJob` holds an entry for every job that publishes segments. A session with no list (`recorded: false`) places nothing.
 */
export function placeTurns(session) {
  const recorded = Array.isArray(session.human_turns)
  const result = { byJob: new Map(), unattributed: emptyBucket(), unplaced: emptyBucket(), recorded, capped: flagReasons(session).includes("capped"), unestimated: 0 }
  if (!recorded) return result
  const bindings = session.jobs
  const segmented = bindings.filter((binding) => Array.isArray(binding.segments) && binding.segments.length > 0)
  for (const binding of segmented) result.byJob.set(binding.job, emptyBucket())
  for (const turn of session.human_turns) {
    let bucket
    if (segmented.length === 0) bucket = bindings.length > 0 ? result.unplaced : result.unattributed
    else bucket = result.byJob.get(ownerOf(segmented, turn.at_ms)) ?? result.unattributed
    bucket.turns += 1
    try {
      bucket.est_ms += estimateTurn(turn)
    } catch (error) {
      // A broken turn is a stated gap, not a stopped build: it stays counted and the figure says it is a lower bound. Only the estimator's own error is a gap; anything else is a defect in the code and propagates.
      if (!(error instanceof EstimatorError)) throw error
      bucket.unestimated += 1
      result.unestimated += 1
    }
  }
  return result
}

// What one session gives one job: why it gives nothing (`cause`), or the job's turns and the reasons the figure is only a lower bound.
function sessionAttention(session, job) {
  const placed = placeTurns(session)
  const mine = placed.byJob.get(job)
  let cause = null
  if (isPublicDesk(session)) cause = "desk_public"
  else if (!placed.recorded) cause = "not_recorded"
  else if (mine === undefined) cause = "no_segments"
  const own = cause === null ? mine : emptyBucket()
  return { cause, recorded: placed.recorded, capped: placed.capped, flags: cause === null ? flagReasons(session) : [], ...own }
}

const UNAVAILABLE_CODE = Object.freeze({ desk_public: "desk_public", not_recorded: "not_recorded", no_segments: "no_segments" })
const PARTIAL_CODE = Object.freeze({ desk_public: "desk_public", not_recorded: "turns_not_recorded", no_segments: "no_segments" })
const sortedUnique = (list) => [...new Set(list)].sort(compareText)

/**
 * `attentionFormula(sessions, job) -> result`: the job's estimated human attention in milliseconds, from the sessions bound to it. Per-job results follow the numbers package's convention and pass through `stated`, so a result whose state disagrees with `withState` stops the build. Unavailable (no value) when no session can give the job a figure, with the reason when there is one cause and `mixed` with the list when there are several; partial (a lower bound) when some sessions cannot, when a list was cut or only partly recorded, or when a turn could not be estimated.
 */
export function attentionFormula(sessions, job) {
  const parts = sessions.map((session) => sessionAttention(session, job))
  const giving = parts.filter((part) => part.cause === null)
  const turns = parts.reduce((total, part) => total + part.turns, 0)
  const unestimated = parts.reduce((total, part) => total + part.unestimated, 0)
  const lacking = parts.filter((part) => part.cause !== null).map((part) => part.cause)
  if (giving.length === 0 || (turns > 0 && unestimated === turns)) {
    const codes = lacking.map((cause) => UNAVAILABLE_CODE[cause])
    const reasons = sortedUnique(giving.length === 0 ? (codes.length === 0 ? ["not_recorded"] : codes) : [...codes, "turn_not_estimable"])
    return stated({ class: "unavailable", state: "unavailable", value: null, reasons, reason: reasons.length === 1 ? reasons[0] : "mixed" })
  }
  const partial = sortedUnique([
    ...lacking.map((cause) => PARTIAL_CODE[cause]),
    ...giving.flatMap((part) => part.flags.map((flag) => (flag === "capped" ? "turns_capped" : flag))),
    ...(unestimated > 0 ? ["turn_not_estimable"] : []),
  ])
  const base = { class: "inferred", value: giving.reduce((total, part) => total + part.est_ms, 0), turns, method: ATTENTION_METHOD }
  return partial.length === 0
    ? stated({ ...base, state: "measured", reasons: [] })
    : stated({ ...base, state: "partial", reasons: partial, partial: true, partial_reasons: partial })
}
