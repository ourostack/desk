import { ENUMS } from "../schema.js"
import { normalizePublished } from "./normalize.js"

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
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
    shared_with: Math.max(0, session.jobs.length - 1),
    basis: [...binding.basis],
  }))

  const intervals = sessions.flatMap(({ session, binding }) => binding.session_offset_ms === null
    ? []
    : session.intervals.map((interval) => intervalOnJobClock(session, interval, binding.session_offset_ms)))
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
  transitions.sort((left, right) => compareValues(left.offset_ms - right.offset_ms, ENUMS.jobStatus.indexOf(left.to) - ENUMS.jobStatus.indexOf(right.to)))

  const observations = sessions
    .flatMap(({ binding }) => binding.observed === null ? [] : [{ ...binding.observed }])
    .sort((left, right) => compareValues(compareNullableNumber(left.offset_ms, right.offset_ms), ENUMS.jobStatus.indexOf(left.status) - ENUMS.jobStatus.indexOf(right.status)))

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
