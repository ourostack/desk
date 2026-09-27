const ACTIVE_KINDS = new Set(["turn", "tool", "subagent"])
const WAIT_KINDS = Object.freeze(["human_wait", "permission_wait", "api_retry", "compaction"])
const measured = (value, extra = {}) => ({ class: "measured", value, ...extra })
const inferred = (value, extra = {}) => ({ class: "inferred", value, ...extra })
const declared = (value, extra = {}) => ({ class: "declared", value, ...extra })
const unavailable = (reason) => ({ class: "unavailable", value: null, reason })

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

function union(intervals) {
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

function duration(intervals) {
  return intervals.reduce((total, [start, end]) => total + end - start, 0)
}

function concurrency(activeUnion, groupedIntervals) {
  const groups = [...groupedIntervals.values()].map(union)
  const boundaries = new Set(activeUnion.flat())
  for (const intervals of groups) {
    for (const interval of intervals) {
      boundaries.add(interval[0])
      boundaries.add(interval[1])
    }
  }
  const points = [...boundaries].sort((left, right) => left - right)
  let weighted = 0
  let maximum = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    const midpoint = start + (end - start) / 2
    if (!activeUnion.some(([left, right]) => midpoint >= left && midpoint < right)) continue
    const count = groups.filter((intervals) => intervals.some(([left, right]) => midpoint >= left && midpoint < right)).length
    maximum = Math.max(maximum, count)
    weighted += count * (end - start)
  }
  const active = duration(activeUnion)
  return { maximum, average: weighted / active }
}

function sumMap(sessions, field) {
  const totals = {}
  for (const session of sessions) {
    for (const [key, value] of Object.entries(session.counts[field])) totals[key] = (totals[key] ?? 0) + value
  }
  return Object.fromEntries(Object.entries(totals).sort(([left], [right]) => compareText(left, right)))
}

function sumField(sessions, field) {
  return sessions.reduce((total, session) => total + session.counts[field], 0)
}

function unavailableGroups(sessions) {
  const counts = new Map()
  for (const session of sessions) {
    for (const entry of session.unavailable) {
      const key = `${entry.field}\n${entry.reason}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [field, reason] = key.split("\n")
      return { field, reason, count }
    })
    .sort((left, right) => compareText(left.field, right.field) || compareText(left.reason, right.reason))
}

function currentStatus(timeline) {
  const cancelledTransition = timeline.transitions.find((entry) => entry.to === "cancelled")
  const cancelledObservation = timeline.observations.find((entry) => entry.status === "cancelled")
  if (cancelledTransition) return measured("cancelled")
  if (cancelledObservation) return declared("cancelled")
  const doneTransition = timeline.transitions.find((entry) => entry.to === "done")
  if (doneTransition) return measured("done")
  const observed = timeline.observations.at(-1)
  if (observed) return declared(observed.status)
  const transition = timeline.transitions.at(-1)
  return transition ? measured(transition.to) : unavailable("status_unavailable")
}

function leadTime(timeline, status) {
  if (status.value === "cancelled") return unavailable("cancelled")
  const done = timeline.transitions.find((entry) => entry.to === "done")
  if (done) return measured(Math.max(0, done.offset_ms), { censored: false, basis: "first_done_transition" })
  const observedDone = timeline.observations.find((entry) => entry.status === "done" && entry.offset_ms !== null)
  if (observedDone) return declared(Math.max(0, observedDone.offset_ms), { censored: false, basis: "terminal_observation" })
  if (status.value === "done") return unavailable("job_offsets_unavailable")
  const ends = timeline.sessions.flatMap((session) => session.end_ms === null ? [] : [session.end_ms])
  if (ends.length === 0) return unavailable("job_offsets_unavailable")
  return measured(Math.max(0, Math.max(...ends)), { censored: true, basis: "latest_session_end" })
}

function longestWait(intervals) {
  const waits = intervals.filter((interval) => WAIT_KINDS.includes(interval.kind))
  if (waits.length === 0) return unavailable("no_wait_intervals")
  waits.sort((left, right) => {
    const durationDifference = (right.end_ms - right.start_ms) - (left.end_ms - left.start_ms)
    if (durationDifference !== 0) return durationDifference
    const kindDifference = WAIT_KINDS.indexOf(left.kind) - WAIT_KINDS.indexOf(right.kind)
    if (kindDifference !== 0) return kindDifference
    return left.start_ms - right.start_ms
  })
  const first = waits[0]
  return measured({ kind: first.kind, duration_ms: first.end_ms - first.start_ms, start_ms: first.start_ms, end_ms: first.end_ms })
}

export function calculateFormulas(timeline) {
  const sourceSessions = timeline.source_sessions
  const timedSessions = timeline.sessions.filter((session) => session.offset_ms !== null)
  const sessions = measured({
    bound: sourceSessions.length,
    timeline: timedSessions.length,
    shared: timeline.sessions.filter((session) => session.shared_with > 0).length,
  })
  const status = currentStatus(timeline)
  const timingUnavailable = timedSessions.length === 0
  const lead = leadTime(timeline, status)

  const activeIntervals = timeline.intervals.filter((interval) => ACTIVE_KINDS.has(interval.kind))
  const activeUnion = union(activeIntervals)
  const activeMs = duration(activeUnion)
  const busyMs = activeIntervals.reduce((total, interval) => total + interval.end_ms - interval.start_ms, 0)
  const bySession = new Map()
  const byAgent = new Map()
  for (const interval of activeIntervals) {
    const sessionKey = `${interval.host}/${interval.session_id}`
    const agentKey = `${sessionKey}/${interval.agent}`
    if (!bySession.has(sessionKey)) bySession.set(sessionKey, [])
    if (!byAgent.has(agentKey)) byAgent.set(agentKey, [])
    bySession.get(sessionKey).push(interval)
    byAgent.get(agentKey).push(interval)
  }

  const active = timingUnavailable ? unavailable("job_offsets_unavailable") : measured(activeMs)
  const busy = timingUnavailable ? unavailable("job_offsets_unavailable") : measured(busyMs)
  const parallelism = timingUnavailable
    ? unavailable("job_offsets_unavailable")
    : activeMs === 0
      ? unavailable("no_active_intervals")
      : inferred(busyMs / activeMs, { method: "busy_time_ms/active_time_ms" })
  const concurrentSessions = timingUnavailable
    ? unavailable("job_offsets_unavailable")
    : activeMs === 0
      ? unavailable("no_active_intervals")
      : inferred(concurrency(activeUnion, bySession), { method: "active_session_interval_concurrency" })
  const concurrentAgents = timingUnavailable
    ? unavailable("job_offsets_unavailable")
    : activeMs === 0
      ? unavailable("no_active_intervals")
      : inferred(concurrency(activeUnion, byAgent), { method: "active_agent_interval_concurrency" })

  const waits = {}
  for (const kind of WAIT_KINDS) {
    waits[`${kind}_ms`] = timingUnavailable
      ? unavailable("job_offsets_unavailable")
      : measured(duration(union(timeline.intervals.filter((interval) => interval.kind === kind))))
  }

  let flowEfficiency
  if (status.value === "cancelled") flowEfficiency = unavailable("cancelled")
  else if (lead.class === "unavailable") flowEfficiency = unavailable(lead.reason)
  else if (lead.value === 0) flowEfficiency = unavailable("zero_lead_time")
  else flowEfficiency = inferred(active.value / lead.value, { censored: lead.censored, method: "active_time_ms/lead_time_ms" })

  const hosts = {}
  for (const session of sourceSessions) hosts[session.session.host] = (hosts[session.session.host] ?? 0) + 1
  const publicPrs = sourceSessions.reduce((total, session) => total + session.refs.prs.length, 0)
  const publicCommits = sourceSessions.reduce((total, session) => total + session.refs.commits.length, 0)
  const privatePrs = sourceSessions.reduce((total, session) => total + session.refs.private.prs, 0)
  const privateCommits = sourceSessions.reduce((total, session) => total + session.refs.private.commits, 0)

  return {
    status,
    sessions,
    sessions_by_host: measured(Object.fromEntries(Object.entries(hosts).sort(([left], [right]) => compareText(left, right)))),
    lead_time_ms: lead,
    queue_before_start_ms: timingUnavailable ? unavailable("job_offsets_unavailable") : measured(Math.max(0, Math.min(...timedSessions.map((session) => session.offset_ms)))),
    active_time_ms: active,
    busy_time_ms: busy,
    parallelism,
    concurrent_sessions: concurrentSessions,
    concurrent_agents: concurrentAgents,
    waits,
    longest_wait: timingUnavailable ? unavailable("job_offsets_unavailable") : longestWait(timeline.intervals),
    flow_efficiency: flowEfficiency,
    tool_calls_by_kind: measured(sumMap(sourceSessions, "tool_calls")),
    references: measured({ public_prs: publicPrs, public_commits: publicCommits, private_prs: privatePrs, private_commits: privateCommits }),
    rework_signals: {
      tool_failures: inferred(Object.values(sumMap(sourceSessions, "tool_failures")).reduce((total, value) => total + value, 0)),
      tool_retries: inferred(sumField(sourceSessions, "tool_retries")),
      api_retries: inferred(sumField(sourceSessions, "api_retries")),
      session_retouches: inferred(Math.max(0, sourceSessions.length - 1)),
    },
    unavailable: measured(unavailableGroups(sourceSessions)),
    first_pass_yield: unavailable("not_collected_in_slice_1"),
  }
}
