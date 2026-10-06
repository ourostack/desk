import { ENUMS } from "../schema.js"
import { normalizePublished } from "./normalize.js"
import { collectOutcomes } from "./outcomes.js"

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

/** Merges intervals (`{ start_ms, end_ms }`) into ascending, non-overlapping `[start, end]` pairs. */
export function union(intervals) {
  const sorted = intervals
    .map((interval) => [interval.start_ms, interval.end_ms])
    .sort((left, right) => left[0] - right[0] || left[1] - right[1])
  const merged = []
  for (const [start, end] of sorted) {
    const last = merged.at(-1)
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

/** The total length of merged `[start, end]` pairs. */
export function duration(intervals) {
  return intervals.reduce((total, [start, end]) => total + end - start, 0)
}

/** Whether an interval lies inside a session of `durationMs`: publishing drops, never clamps, one that starts before it or ends after it. */
export function intervalInSession(startMs, endMs, durationMs) {
  return startMs >= 0 && endMs <= durationMs
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
  const inside = session.intervals.filter((interval) => intervalInSession(interval.start_ms, interval.end_ms, session.duration_ms))
  return duration(union(jobIntervals({ intervals: inside }, binding).filter((interval) => ACTIVE_KINDS.has(interval.kind))))
}

// Whether two bindings of one session hold overlapping time. A binding with
// no `segments` holds the whole session, so it overlaps every other binding;
// two segmented bindings overlap only where a segment of one and a segment of
// the other share time (segments are half-open). A binding whose workers are
// all subagents (`agents` without worker 0) holds no controller time, so it
// overlaps another binding that names its workers only where they share an agent.
const subagentsOnly = (binding) => Array.isArray(binding.agents) && !binding.agents.includes(0)
export function bindingsOverlap(left, right) {
  if ((subagentsOnly(left) && Array.isArray(right.agents)) || (subagentsOnly(right) && Array.isArray(left.agents))) {
    if (!left.agents.some((agent) => right.agents.includes(agent))) return false
  }
  if (!Object.hasOwn(left, "segments") || !Object.hasOwn(right, "segments")) return true
  return left.segments.some((a) => right.segments.some((b) => a.start_ms < b.end_ms && b.start_ms < a.end_ms))
}

// The other bindings of the session whose time overlaps `binding`'s.
export function overlappingBindings(session, binding) {
  return session.jobs.filter((other) => other !== binding && bindingsOverlap(binding, other))
}

export function buildJobTimeline(job, inputSessions, outcomes = collectOutcomes(inputSessions)) {
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
    outcome: outcomes.get(job) ?? null,
    source_sessions: sessions.map(({ session }) => session),
  }
}

export function buildTimelines(sessions) {
  const jobs = new Set()
  for (const session of sessions) {
    for (const binding of session.jobs) jobs.add(binding.job)
  }
  const outcomes = collectOutcomes(sessions)
  return [...jobs].sort(compareText).map((job) => buildJobTimeline(job, sessions, outcomes))
}
