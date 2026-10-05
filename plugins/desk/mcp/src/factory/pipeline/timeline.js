import { ENUMS } from "../schema.js"
import { normalizePublished } from "./normalize.js"

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

function compareNullableNumber(left, right) {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return left - right
}

function compareValues(...values) {
  return values.find((value) => value !== 0) ?? 0
}

function intervalOnJobClock(session, interval, offset) {
  const placed = {
    host: session.session.host,
    session_id: session.session.id,
    kind: interval.kind,
    agent: interval.agent,
    start_ms: offset + interval.start_ms,
    end_ms: offset + interval.end_ms,
  }
  if (interval.kind === "tool") {
    placed.tool = interval.tool
    placed.outcome = interval.outcome
  }
  return placed
}

// A job with `segments` holds only those spans of the controller's (worker
// 0's) time: each of its intervals is cut to them. Every other worker's
// intervals, and every interval of a job without segments, are kept whole.
// Segments on a binding that lists no workers (which the validators refuse)
// are ignored.
function jobParts(interval, binding) {
  if (interval.agent !== 0 || !Object.hasOwn(binding, "segments") || !Object.hasOwn(binding, "agents")) return [interval]
  return binding.segments.flatMap((segment) => {
    const start = Math.max(interval.start_ms, segment.start_ms)
    const end = Math.min(interval.end_ms, segment.end_ms)
    return start < end ? [{ ...interval, start_ms: start, end_ms: end }] : []
  })
}

/** The kinds of interval that are active time (a turn, a tool call, a subagent), as the formulas count them. */
export const ACTIVE_KINDS = new Set(["turn", "tool", "subagent"])

// The intervals of `session` that `binding` holds, on the session's own clock: none when the binding has no session offset (the job's card
// had no readable creation time, so the pipeline places nothing), only the binding's workers when it lists them, and worker 0's cut to its
// segments. The timeline and `jobActiveMs` both take their intervals from here.
function jobIntervals(session, binding) {
  if (binding.session_offset_ms === null) return []
  return session.intervals
    .filter((interval) => !Object.hasOwn(binding, "agents") || binding.agents.includes(interval.agent))
    .flatMap((interval) => jobParts(interval, binding))
}

/**
 * `jobActiveMs({ duration_ms, intervals }, binding)`: the active time (union of turn, tool and subagent intervals, so overlapping workers
 * count once) that a published session gives one of its jobs, or `null` where the pipeline publishes nothing for the job (no session
 * offset). An interval that starts before the session or ends after it is dropped, never clamped, as publishing drops it (`publish.js`);
 * a published session holds none, so this only matters to a caller holding a session that is not yet published, such as `factory reconcile`.
 */
export function jobActiveMs(session, binding) {
  if (binding.session_offset_ms === null) return null
  const inside = session.intervals.filter((interval) => interval.start_ms >= 0 && interval.end_ms <= session.duration_ms)
  const parts = jobIntervals({ intervals: inside }, binding).filter((interval) => ACTIVE_KINDS.has(interval.kind)).sort((a, b) => a.start_ms - b.start_ms)
  let total = 0
  let reach = -Infinity
  for (const part of parts) {
    total += Math.max(0, part.end_ms - Math.max(part.start_ms, reach))
    reach = Math.max(reach, part.end_ms)
  }
  return total
}

// Whether two bindings of one session hold overlapping time. A binding with
// no `segments` holds the whole session, so it overlaps every other binding;
// two segmented bindings overlap only where a segment of one and a segment of
// the other share time (segments are half-open).
export function bindingsOverlap(left, right) {
  if (!Object.hasOwn(left, "segments") || !Object.hasOwn(right, "segments")) return true
  return left.segments.some((a) => right.segments.some((b) => a.start_ms < b.end_ms && b.start_ms < a.end_ms))
}

// The other bindings of the session whose time overlaps `binding`'s.
export function overlappingBindings(session, binding) {
  return session.jobs.filter((other) => other !== binding && bindingsOverlap(binding, other))
}

export function buildJobTimeline(job, inputSessions) {
  const sessions = inputSessions
    .map(normalizePublished)
    .flatMap((session) => session.jobs.filter((binding) => binding.job === job).map((binding) => ({ session, binding })))
    .sort((left, right) => compareValues(
      compareNullableNumber(left.binding.session_offset_ms, right.binding.session_offset_ms),
      compareText(left.session.session.host, right.session.session.host),
      compareText(left.session.session.id, right.session.session.id),
    ))

  const timelineSessions = sessions.map(({ session, binding }) => ({
    host: session.session.host,
    id: session.session.id,
    duration_ms: session.session.duration_ms,
    ended: session.session.ended,
    offset_ms: binding.session_offset_ms,
    end_ms: binding.session_offset_ms === null ? null : binding.session_offset_ms + session.session.duration_ms,
    shared_with: overlappingBindings(session, binding).length,
    basis: [...binding.basis],
  }))

  const intervals = sessions.flatMap(({ session, binding }) => jobIntervals(session, binding)
    .map((interval) => intervalOnJobClock(session, interval, binding.session_offset_ms)))
  intervals.sort((left, right) => compareValues(
    left.start_ms - right.start_ms,
    left.end_ms - right.end_ms,
    compareText(left.host, right.host),
    compareText(left.session_id, right.session_id),
    ENUMS.intervalKind.indexOf(left.kind) - ENUMS.intervalKind.indexOf(right.kind),
    left.agent - right.agent,
  ))

  const transitions = []
  const seenTransitions = new Set()
  for (const { binding } of sessions) {
    for (const transition of binding.transitions) {
      const key = `${transition.offset_ms}:${transition.to}`
      if (seenTransitions.has(key)) continue
      seenTransitions.add(key)
      transitions.push({ to: transition.to, offset_ms: transition.offset_ms })
    }
  }
  transitions.sort((left, right) => compareValues(compareNullableNumber(left.offset_ms, right.offset_ms), ENUMS.jobStatus.indexOf(left.to) - ENUMS.jobStatus.indexOf(right.to)))

  const observations = []
  const seenObservations = new Set()
  for (const { binding } of sessions) {
    if (binding.observed === null) continue
    const key = `${binding.observed.offset_ms}:${binding.observed.status}`
    if (seenObservations.has(key)) continue
    seenObservations.add(key)
    observations.push({ ...binding.observed })
  }
  observations.sort((left, right) => compareValues(compareNullableNumber(left.offset_ms, right.offset_ms), ENUMS.jobStatus.indexOf(left.status) - ENUMS.jobStatus.indexOf(right.status)))

  return {
    job,
    sessions: timelineSessions,
    intervals,
    transitions,
    observations,
    source_sessions: sessions.map(({ session }) => session),
  }
}

export function buildTimelines(sessions) {
  const jobs = new Set()
  for (const session of sessions) {
    for (const binding of session.jobs) jobs.add(binding.job)
  }
  return [...jobs].sort(compareText).map((job) => buildJobTimeline(job, sessions))
}
