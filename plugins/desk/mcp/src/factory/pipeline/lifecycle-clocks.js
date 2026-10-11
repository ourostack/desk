// A job's lifecycle clocks (Factory v1.2): the recorded request to delivery, the queue before production, and production split into
// its episodes, with the recorded working time inside them and the production time not recorded as active. Each is a Clock envelope,
// `{ class, state, value?, reasons, basis, bound?, bound_reason?, so_far }`, beside (never instead of) the legacy lead time, which keeps
// its meaning. Every time is an offset on the job's own clock: no new epoch timestamp is published.
//
// Rules:
//   - No published facts (`/1` to `/4`) carry proof of the original request: a card can be created for work already under way, or adopted
//     long after it was asked for. `request_to_delivery_ms` and `queue_ms` are therefore always unavailable, `original_request_not_recorded`,
//     even when the first recorded work comes after the card; recorded work before the card adds `work_before_card`. Neither the card's
//     creation, the first capture nor any prose stands in for the request, so a queue is never negative.
//   - Production runs in episodes. The first starts at the first corrected recorded active moment (`workingSpans`); a later one at the
//     first such moment after a timed reopen (a transition out of `done`). A timed `done` transition ends its episode; a repeated `done`
//     opens nothing. The time between a delivery and a reopen is not production. An episode still open runs only to the latest supported
//     observation (a timed card observation, the end of a placed session or of the recorded work), `so_far`, and is a lower bound
//     (`censored`); never to the reader's current time. A delivery seen only as the card's timed `done` observation (the card's last update,
//     on or after the delivery) is an upper bound (`finish_from_card_update`); a `done` with no time at all runs to the end of the recorded
//     work and is a lower bound (`finish_time_not_known`).
//   - Work after a delivery with no later recorded reopen before it leaves the production clocks unavailable
//     (`late_work_without_reopen`): which episode it belongs to is not known. It is read from the corrected working union and from the
//     raw active intervals' starts. Only the delivering turn's tail, work already under way at the `done` that ends within the walk's
//     15-minute short-gap threshold of it, is clipped at the delivery; a longer stretch, or any work starting after that tail, is late.
//   - A delivered episode with no recorded work leaves production a lower bound (`no_active_intervals`): its time is not known. A job
//     whose final `done` has no time, with nothing timed and not terminal after its last reopen, is done, its last episode running to the end
//     of its recorded work (`finish_time_not_known`). A timed move away from a `done` with no later `done` is a reopen only when recorded
//     work follows it and the card's latest timed observation is not still that `done`; otherwise the history contradicts itself and the
//     clocks are unavailable, not open (`episode_boundary_not_recorded`). A transition with no time (`episode_boundary_not_recorded`), a reopen seen only in
//     a later open observation (the same), lost or capped lifecycle history (`episode_history_incomplete`), a cancelled job, an unread
//     status, unplaced sessions, unread activity or no recorded work at all each leave them unavailable with that reason: never a zero.
//   - `active_in_production_ms` is the corrected working union (every worker of the task once, ask-tool and labeled waits out except where
//     another worker works) inside the episodes; an episode ending at the card's last update makes it at most this too
//     (`finish_from_card_update`). `production_remainder_ms` is production less that: not by itself idle time or waste.
//     Where production is known, active plus remainder is production.
//   - Coverage is joined per measure from four separate inputs (`lifecycleCoverage`): interval capture (`activity`), the labels' coverage
//     (`classification`), session placement (`placement`) and lifecycle history (`history`). Labels never stand in for captured intervals.
//     Production takes its end's reasons and placement; the active time takes capture, placement and the labels that refine it; the
//     remainder takes both, and a direction they pull both ways is `bound: null` with `bound_reasons_conflict`.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { LIMITS } from "../schema.js"
import { ACTIVE_KINDS } from "./timeline.js"
import { BOUND_DIRECTIONS, BURST_IDLE_GAP_MS, REASON_CHANGE, workingSpans } from "./walk.js"

/** The duration clocks of `deriveLifecycleClocks`, in the store's order (ourostack/factory `site/src/format.js` `CLOCK_KEYS`). */
export const CLOCK_KEYS = Object.freeze(["request_to_delivery_ms", "queue_ms", "production_ms", "active_in_production_ms", "production_remainder_ms"])

/** The closed basis vocabulary of a Clock, in the order a basis list states it. */
export const CLOCK_BASES = Object.freeze(["recorded_activity", "done_transition", "terminal_observation", "recorded_work_end", "latest_observation", "lifecycle_history", "original_request_not_recorded"])

const TERMINAL = new Set(["done", "cancelled"])
const REQUEST = "original_request_not_recorded"
const CENSORED = "censored"
const UNDECIDED = "undecided"

const compareText = (left, right) => Number(left > right) - Number(left < right)
const sortedUnique = (values) => [...new Set(values)].sort(compareText)
const orderedBasis = (values) => CLOCK_BASES.filter((basis) => values.includes(basis))

// The kind of change each reason stands for: the walk's (`REASON_CHANGE`), and an episode with no recorded work, whose production time
// is not known.
const LIFECYCLE_CHANGE = Object.freeze({ ...REASON_CHANGE, no_active_intervals: "empty_episode" })
// What each kind of change does to a production span: an open job, a delivery read from the end of the work and an episode with no
// recorded work make it longer, a session that could not be placed may hide earlier work, and a delivery read from the card's last update
// makes it shorter.
const PRODUCTION_PULLS = Object.freeze({ open: "lower", floor: "lower", unplaced: "lower", card_update: "upper", empty_episode: "lower" })
// The active time inside the episodes moves as recorded working time does, and is clipped to the same card-update end, so that end makes
// it at most this too.
const ACTIVE_PULLS = Object.freeze({ ...BOUND_DIRECTIONS.working, card_update: "upper" })
// How long the turn that recorded a delivery may run on past it and still be clipped there: the walk's short-gap threshold.
const DELIVERY_TAIL_MS = BURST_IDLE_GAP_MS
const FLIP = Object.freeze({ lower: "upper", upper: "lower", both: "both", none: "none", [UNDECIDED]: UNDECIDED })
const BOUND_REASON = Object.freeze({ both: "bound_reasons_conflict", none: "bound_not_moved", [UNDECIDED]: "bound_direction_undecided" })

function directionOf(pulls, reasons) {
  const changes = reasons.map((reason) => LIFECYCLE_CHANGE[reason] ?? UNDECIDED)
  if (changes.includes(UNDECIDED)) return UNDECIDED
  const found = new Set(changes.map((change) => pulls[change]).filter((pull) => pull !== undefined))
  if (found.size === 0) return "none"
  return found.size > 1 ? "both" : [...found][0]
}

function joined(left, right) {
  if (left === UNDECIDED || right === UNDECIDED) return UNDECIDED
  if (left === "none") return right
  if (right === "none" || left === right) return left
  return "both"
}

// A Clock with a value: measured with no reasons, otherwise partial with its direction, or `bound: null` and why there is none.
function known(numberClass, value, reasons, basis, direction, soFar) {
  const named = sortedUnique(reasons)
  const clock = { class: numberClass, state: named.length === 0 ? "measured" : "partial", value, reasons: named, basis: orderedBasis(basis) }
  if (clock.state === "partial") {
    if (direction === "lower" || direction === "upper") clock.bound = direction
    else {
      clock.bound = null
      clock.bound_reason = BOUND_REASON[direction]
    }
  }
  clock.so_far = soFar
  return clock
}

const missing = (reasons, basis, soFar) => ({ class: "unavailable", state: "unavailable", reasons: sortedUnique(reasons), basis: orderedBasis(basis), so_far: soFar })

// Merged [start, end] spans clipped to [start, end].
function clip(spans, start, end) {
  return spans.flatMap(([from, to]) => {
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    return a < b ? [[a, b]] : []
  })
}

const total = (spans) => spans.reduce((sum, [start, end]) => sum + end - start, 0)

function merged(spans) {
  const out = []
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
    const last = out.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else out.push([start, end])
  }
  return out
}

// A coverage output: whole, partial with the direction its reasons give recorded working time, or unavailable.
function dimension(state, reasons) {
  if (state === "measured") return { state, reasons: [], bound: null }
  const named = sortedUnique(reasons)
  if (state === "unavailable") return { state, reasons: named, bound: null }
  const direction = directionOf(BOUND_DIRECTIONS.working, named)
  return { state, reasons: named, bound: direction === "lower" || direction === "upper" ? direction : null }
}

/**
 * `lifecycleCoverage({ activity, placement, labels, history }) -> { activity, classification, placement, history }`: the four separate
 * coverages the lifecycle clocks join, each `{ state, reasons, bound }` (`bound` the direction its reasons give recorded working time, or
 * `null`). `activity` is the formulas' `active_time_ms` (interval capture); `placement` the timeline's sessions (an unplaced session's work
 * is not on the job clock); `labels` the walk's label coverage (`{ unavailable }` or `{ reasons }`); `history` the timeline (its
 * transitions, sessions and source sessions): untimed transitions are `episode_boundary_not_recorded`, and a session whose job offsets
 * were lost, that could not be placed, or whose transitions reached the facts' cap is `episode_history_incomplete`.
 */
export function lifecycleCoverage({ activity, placement, labels, history }) {
  const placed = placement.filter((session) => session.offset_ms !== null).length
  const historyReasons = []
  if (history.transitions.some((transition) => transition.offset_ms === null)) historyReasons.push("episode_boundary_not_recorded")
  const sources = history.source_sessions
  const lost = history.sessions.some((session) => session.offset_ms === null)
    || sources.some((source) => source.unavailable.some((entry) => entry.field === "job_offsets"))
    || sources.some((source) => source.jobs.some((binding) => binding.job === history.job && binding.transitions.length >= LIMITS.jobTransitions))
  if (lost) historyReasons.push("episode_history_incomplete")
  return {
    activity: dimension(activity.state, activity.reasons),
    classification: Object.hasOwn(labels, "unavailable") ? dimension("unavailable", labels.unavailable) : dimension(labels.reasons.length === 0 ? "measured" : "partial", labels.reasons),
    placement: placed === placement.length ? dimension("measured", []) : dimension(placed === 0 ? "unavailable" : "partial", ["job_offsets_unavailable"]),
    history: dimension(historyReasons.length === 0 ? "measured" : "partial", historyReasons),
  }
}

// The job's lifecycle read from its timed transitions and timed observations, in job-clock order: its closed episodes' bounds
// (`{ open, close, basis }`, `open` null for the first), whether it is open now, where an open stretch began, and whatever stops a split.
function lifecycle(timeline, working) {
  const events = [
    ...timeline.transitions.filter((entry) => entry.offset_ms !== null).map((entry) => ({ at: entry.offset_ms, status: entry.to, transition: true })),
    ...timeline.observations.filter((entry) => entry.offset_ms !== null).map((entry) => ({ at: entry.offset_ms, status: entry.status, transition: false })),
  ].sort((left, right) => left.at - right.at || Number(right.transition) - Number(left.transition))
  const stops = []
  const closed = []
  let open = true
  let since = null
  let reopenTimed = false
  let known = events.length > 0
  for (const event of events) {
    if (event.status === "cancelled") {
      stops.push("cancelled")
      open = false
      continue
    }
    if (open && event.status === "done") {
      closed.push({ open: since, close: event.at, basis: event.transition ? "done_transition" : "terminal_observation" })
      open = false
    } else if (!open && !TERMINAL.has(event.status)) {
      // A reopen: a transition dates it; an observation only shows it happened some time before.
      if (!event.transition) stops.push("episode_boundary_not_recorded")
      open = true
      since = event.at
      reopenTimed = event.transition
    }
  }
  let untimedDone = false
  if (events.length === 0) {
    // No timed lifecycle at all: the latest observation (or transition) says the status, without a time.
    const status = timeline.observations.at(-1)?.status ?? timeline.transitions.at(-1)?.to ?? null
    known = status !== null
    if (status === "cancelled") stops.push("cancelled")
    if (status === "done") {
      untimedDone = true
      open = false
    }
  } else if (open && timeline.observations.some((entry) => entry.status === "done" && entry.offset_ms === null)
    && !events.some((event) => since !== null && event.at > since && !TERMINAL.has(event.status))) {
    // Open by its timed lifecycle, but seen done with no time, and nothing timed and not terminal after its last reopen: done, its final
    // delivery not dated.
    untimedDone = true
    open = false
  }
  if (open && reopenTimed) {
    // A timed move away from a done, with no later done, is a reopen only when recorded work follows it and the card's latest timed state
    // is not still that done (a real reopen updates the card). Otherwise the history contradicts itself: no reopen is invented and the job
    // is not called open.
    const lastObserved = events.filter((event) => !event.transition).at(-1)
    const cardStillDone = lastObserved?.status === "done" && lastObserved.at <= since
    if (cardStillDone || !working.some(([, end]) => end > since)) {
      stops.push("episode_boundary_not_recorded")
      open = false
    }
  }
  if (!known) stops.push("status_unavailable")
  return { closed, open, since, untimedDone, stops, lastWorkEnd: working.length === 0 ? null : Math.max(...working.map(([, end]) => end)) }
}

/**
 * `deriveLifecycleClocks({ timeline, working, coverage }) -> { request_to_delivery_ms, queue_ms, production_ms, active_in_production_ms,
 * production_remainder_ms, production_periods }`: the job's lifecycle clocks (see the header) from its timeline's `transitions`
 * (`{ to, offset_ms }`), `observations` (`{ status, offset_ms }`) and placed `sessions` (`{ offset_ms, end_ms }`, optional), its corrected
 * working union `working` (`[start, end][]` on the job clock, `workingSpans`) and `coverage` (`lifecycleCoverage`). `production_periods` is
 * `{ state, reasons, items: [{ start_ms, end_ms, start_basis, end_basis, so_far }] }`.
 */
export function deriveLifecycleClocks({ timeline, working: inputWorking, coverage }) {
  const working = merged(inputWorking.map(([start, end]) => [start, end]))
  const life = lifecycle(timeline, working)
  // Open now: every clock is so far. A job whose status was never read is not said to be open.
  const soFar = life.open && !life.stops.includes("status_unavailable")
  const requestReasons = [REQUEST, ...(working.some(([start]) => start < 0) ? ["work_before_card"] : [])]
  const request = missing(requestReasons, [REQUEST], soFar)
  const unavailable = (reasons) => {
    const none = missing(reasons, ["recorded_activity", "lifecycle_history"], soFar)
    return { request_to_delivery_ms: request, queue_ms: { ...request }, production_ms: none, active_in_production_ms: { ...none }, production_remainder_ms: { ...none }, production_periods: { state: "unavailable", reasons: none.reasons, items: [] } }
  }

  // What stops a supported episode split, in order: the lifecycle history and placement, then late work, then the capture itself.
  const blocking = [...life.stops]
  if (coverage.history.state !== "measured") blocking.push(...coverage.history.reasons)
  if (timeline.transitions.some((entry) => entry.offset_ms === null)) blocking.push("episode_boundary_not_recorded")
  if (coverage.placement.state === "unavailable") blocking.push(...coverage.placement.reasons)
  if (blocking.length > 0) return unavailable(blocking)

  // The lifecycle's production windows: each from its opening (none for the first) to its delivery, then the open one, if any.
  const windows = life.closed.map((entry) => ({ open: entry.open, close: entry.close, basis: entry.basis }))
  if (life.open) windows.push({ open: life.since, close: null, basis: null })
  else if (life.untimedDone) windows.push({ open: life.since, close: null, basis: "recorded_work_end" })
  // Work after a delivery and before the next opening (or with none after it) is late: its episode is not known. Only the delivering
  // turn's tail, a stretch of work already under way at the delivery that ends within `DELIVERY_TAIL_MS` of it, is clipped there. Any
  // other corrected work, or any raw active interval of the job, that starts after the delivery and that tail is late, so a long turn
  // that runs on for hours past a delivery cannot hide its work.
  const rawStarts = (timeline.intervals ?? []).filter((interval) => ACTIVE_KINDS.has(interval.kind)).map((interval) => interval.start_ms)
  const late = life.closed.some((entry, index) => {
    const next = windows[index + 1]?.open ?? Infinity
    const tailEnd = working.find(([start, end]) => start < entry.close && end > entry.close)?.[1] ?? entry.close
    if (tailEnd - entry.close > DELIVERY_TAIL_MS) return true
    return working.some(([start]) => start >= entry.close && start < next) || rawStarts.some((start) => start > tailEnd && start < next)
  })
  if (late) return unavailable(["late_work_without_reopen"])
  if (coverage.activity.state === "unavailable") return unavailable(coverage.activity.reasons)

  const latest = Math.max(
    -Infinity,
    ...timeline.observations.filter((entry) => entry.offset_ms !== null).map((entry) => entry.offset_ms),
    ...(timeline.sessions ?? []).filter((session) => session.offset_ms !== null && session.end_ms !== null).map((session) => session.end_ms),
  )
  const items = []
  const endReasons = []
  let emptyEpisode = false
  for (const window of windows) {
    // The window's recorded work: work under way at a reopen starts the episode at the reopen, and the delivering turn's tail after a
    // recorded delivery is not production.
    const inside = clip(working, window.open ?? -Infinity, window.close ?? Infinity)
    if (inside.length === 0) {
      // A delivered episode with no recorded work: its production time is not known, so production is at least what remains.
      if (window.basis !== null) emptyEpisode = true
      continue
    }
    const start = inside[0][0]
    let end = window.close
    let basis = window.basis
    if (basis === "terminal_observation") endReasons.push("finish_from_card_update")
    if (basis === "recorded_work_end") {
      end = life.lastWorkEnd
      endReasons.push("finish_time_not_known")
    }
    if (basis === null) {
      // Still open: to the latest supported observation, or the end of the recorded work when that is later.
      const workEnd = Math.max(...inside.map(([, to]) => to))
      end = latest >= workEnd ? latest : workEnd
      basis = latest >= workEnd ? "latest_observation" : "recorded_work_end"
    }
    items.push({ start_ms: start, end_ms: end, start_basis: "recorded_activity", end_basis: basis, so_far: window.close === null && window.basis === null })
  }
  if (items.length === 0) return unavailable(coverage.activity.state === "partial" ? coverage.activity.reasons : ["no_active_intervals"])
  if (life.open) endReasons.push(CENSORED)
  if (emptyEpisode) endReasons.push("no_active_intervals")

  const placementReasons = coverage.placement.state === "partial" ? coverage.placement.reasons : []
  const productionReasons = [...endReasons, ...placementReasons]
  const activeReasons = [
    // An episode ending at the card's last update clips the active time to that end too.
    ...(items.some((item) => item.end_basis === "terminal_observation") ? ["finish_from_card_update"] : []),
    ...(coverage.activity.state === "partial" ? coverage.activity.reasons : []),
    ...placementReasons,
    // Labels refine working time only where some exist: none at all leaves every recorded moment counted as work, as the walk does.
    ...(coverage.classification.state === "partial" ? coverage.classification.reasons : []),
  ]
  const productionDirection = directionOf(PRODUCTION_PULLS, sortedUnique(productionReasons))
  const activeDirection = directionOf(ACTIVE_PULLS, sortedUnique(activeReasons))
  const productionValue = items.reduce((sum, item) => sum + item.end_ms - item.start_ms, 0)
  const activeValue = items.reduce((sum, item) => sum + total(clip(working, item.start_ms, item.end_ms)), 0)
  const endBases = items.map((item) => item.end_basis)
  const productionClass = endBases.includes("recorded_work_end") ? "inferred" : endBases.includes("terminal_observation") ? "declared" : "measured"
  const productionBasis = ["recorded_activity", ...endBases, "lifecycle_history"]
  const productionClock = known(productionClass, productionValue, productionReasons, productionBasis, productionDirection, soFar)
  return {
    request_to_delivery_ms: request,
    queue_ms: { ...request },
    production_ms: productionClock,
    active_in_production_ms: known("measured", activeValue, activeReasons, ["recorded_activity", "lifecycle_history"], activeDirection, soFar),
    production_remainder_ms: known("inferred", productionValue - activeValue, [...productionReasons, ...activeReasons], productionBasis, joined(productionDirection, FLIP[activeDirection]), soFar),
    production_periods: { state: productionClock.state, reasons: productionClock.reasons, items },
  }
}

/**
 * `jobLifecycleClocks({ timeline, formulas, walk }) -> clocks`: `deriveLifecycleClocks` for one built job, from its timeline, its formulas'
 * interval coverage and the walk's corrected stretches and label coverage.
 */
export function jobLifecycleClocks({ timeline, formulas, walk }) {
  const coverage = lifecycleCoverage({ activity: formulas.active_time_ms, placement: timeline.sessions, labels: walk.coverage, history: timeline })
  return deriveLifecycleClocks({ timeline, working: workingSpans(timeline, walk.stretches), coverage })
}
