const ACTIVE_KINDS = new Set(["turn", "tool", "subagent"])
const WAIT_KINDS = Object.freeze(["human_wait", "permission_wait", "api_retry", "compaction"])
const TERMINAL_STATUSES = new Set(["done", "cancelled"])
const CONTRIBUTOR_ORDER = Object.freeze([
  "active_in_lead_ms",
  "queue_before_start_ms",
  "human_wait_ms",
  "permission_wait_ms",
  "api_retry_ms",
  "compaction_ms",
])

// The published `unavailable` fields whose absence leaves a value incomplete.
// Interval kinds map to fields as in `publish.js`: turns and compactions are
// `turns`, tools and subagents are `tool_durations`. Active time needs turns;
// a `tool_durations` gap (an unfinished or dropped tool call) only means some
// tool intervals are missing, so it makes active time partial, never
// unavailable.
const ACTIVE_FIELDS = Object.freeze(["turns"])
const ACTIVE_PARTIAL_FIELDS = Object.freeze(["tool_durations"])
const WAIT_FIELDS = Object.freeze({
  human_wait: Object.freeze(["human_waits"]),
  permission_wait: Object.freeze(["permission_waits"]),
  api_retry: Object.freeze(["api_retries"]),
  compaction: Object.freeze(["turns"]),
})
const ANY_WAIT_FIELDS = Object.freeze(["human_waits", "permission_waits", "api_retries", "turns"])

const measured = (value, extra = {}) => ({ class: "measured", value, ...extra })
const inferred = (value, extra = {}) => ({ class: "inferred", value, ...extra })
const declared = (value, extra = {}) => ({ class: "declared", value, ...extra })
const unavailable = (reason, extra = {}) => ({ class: "unavailable", value: null, reason, ...extra })

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

// The parts of merged intervals that fall inside [start, end).
function clip(intervals, start, end) {
  return intervals.flatMap(([left, right]) => {
    const clippedStart = Math.max(left, start)
    const clippedEnd = Math.min(right, end)
    return clippedStart < clippedEnd ? [[clippedStart, clippedEnd]] : []
  })
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

// How many of `sessions` declare any of `fields` (or `partialFields`)
// unavailable, and why. Only `fields` can make a value wholly unavailable;
// `partialFields` gaps leave it partial.
//
// `split` holds the sessions whose counts belong to several jobs. Each is
// uncovered once, and the coverage says how many were cut for that reason.
// `shared` holds the sessions whose workers also belong to another job, so
// their time is counted for each of those jobs; it is reported the same way.
export function fieldCoverage(sessions, fields, partialFields = [], split = new Set(), shared = new Set()) {
  const reasons = new Set()
  let uncovered = 0
  let lacking = 0
  let splitCount = 0
  let sharedCount = 0
  for (const session of sessions) {
    const missing = session.unavailable.filter((entry) => fields.includes(entry.field))
    const incomplete = session.unavailable.some((entry) => partialFields.includes(entry.field))
    const divided = split.has(session)
    if (divided) splitCount += 1
    const overlapping = shared.has(session)
    if (overlapping) sharedCount += 1
    if (missing.length > 0 || incomplete || divided || overlapping) uncovered += 1
    if (missing.length === 0) continue
    lacking += 1
    for (const entry of missing) reasons.add(entry.reason)
  }
  return { uncovered, none: lacking === sessions.length, reasons: [...reasons].sort(compareText), split: splitCount, shared: sharedCount }
}

function missingValue(coverage) {
  return coverage.reasons.length === 1 ? unavailable(coverage.reasons[0]) : unavailable("mixed", { reasons: coverage.reasons })
}

function withCoverage(value, coverage) {
  if (value.class === "unavailable" || coverage.uncovered === 0) return value
  const marked = { ...value, partial: true, uncovered_sessions: coverage.uncovered }
  const reasons = [...(coverage.split > 0 ? ["worker_split"] : []), ...(coverage.shared > 0 ? ["worker_shared"] : [])]
  return reasons.length > 0 ? { ...marked, partial_reasons: reasons } : marked
}

// Missing data is never a measured zero: a value no covering session could
// supply is unavailable, and one only some sessions supply is partial.
export function covered(coverage, compute) {
  return coverage.none ? missingValue(coverage) : withCoverage(compute(), coverage)
}

function currentStatus(timeline) {
  // The latest transition on the job clock decides once any terminal one
  // exists, so a reopened and later finished job reports its current state.
  const timed = timeline.transitions.filter((entry) => entry.offset_ms !== null)
  if (timed.some((entry) => TERMINAL_STATUSES.has(entry.to))) return measured(timed.at(-1).to)
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
  if (status.value === "done") {
    // Lead time ends at the `done` that begins the job's final terminal
    // stretch: the first `done` after the last reopen. A job closed once is
    // unaffected; a job reopened and closed again ends at its reclosing.
    const timed = timeline.transitions.filter((entry) => entry.offset_ms !== null)
    let finalStretch = timed.length
    while (finalStretch > 0 && TERMINAL_STATUSES.has(timed[finalStretch - 1].to)) finalStretch -= 1
    const done = timed.slice(finalStretch).find((entry) => entry.to === "done")
    if (done) return measured(Math.max(0, done.offset_ms), { censored: false, basis: "first_done_transition" })
    const observedDone = timeline.observations.find((entry) => entry.status === "done" && entry.offset_ms !== null)
    if (observedDone) return declared(Math.max(0, observedDone.offset_ms), { censored: false, basis: "terminal_observation" })
    return unavailable("job_offsets_unavailable")
  }
  // Every other status is open, including a job reopened after an earlier
  // `done` (which stays in the transition history): its lead time is censored.
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

function contributor(key, valueMs, lead, source) {
  const entry = { key, value_ms: valueMs, share: valueMs / lead }
  return source.partial ? { ...entry, partial: true, uncovered_sessions: source.uncovered_sessions } : entry
}

// Lead-time contributors, each clipped to the job clock's [0, lead] window so
// no share can exceed the lead time it explains.
function leadContributors({ lead, timingUnavailable, activeInLead, queue, waits, waitUnions }) {
  if (lead.class === "unavailable") return unavailable(lead.reason)
  if (timingUnavailable) return unavailable("job_offsets_unavailable")
  if (lead.value === 0) return unavailable("zero_lead_time")
  const entries = []
  if (activeInLead.class !== "unavailable") entries.push(contributor("active_in_lead_ms", activeInLead.value, lead.value, activeInLead))
  entries.push(contributor("queue_before_start_ms", Math.min(queue.value, lead.value), lead.value, queue))
  for (const kind of WAIT_KINDS) {
    const wait = waits[`${kind}_ms`]
    if (wait.class === "unavailable") continue
    entries.push(contributor(`${kind}_ms`, duration(clip(waitUnions[kind], 0, lead.value)), lead.value, wait))
  }
  entries.sort((left, right) => right.value_ms - left.value_ms || CONTRIBUTOR_ORDER.indexOf(left.key) - CONTRIBUTOR_ORDER.indexOf(right.key))
  return inferred(entries, { censored: lead.censored, method: "clipped_to_lead_window" })
}

function bindingOf(session, job) {
  return session.jobs.find((binding) => binding.job === job)
}

// A binding without `agents` is the legacy session-level binding: every
// worker counts. One listing every worker of the session is the same thing.
function ownsWholeSession(session, binding) {
  return !Object.hasOwn(binding, "agents") || session.agents.every((agent) => binding.agents.includes(agent.n))
}

// The source sessions in which the job owns only some of the workers, so the
// session-wide counts are not the job's own.
export function splitSessions(timeline) {
  return new Set(timeline.source_sessions.filter((session) => !ownsWholeSession(session, bindingOf(session, timeline.job))))
}

// The source sessions in which one of the job's workers also belongs to
// another job. That worker's time is counted for each job that owns it, so
// the job's time is partial; splitting it is left to a later milestone. A
// legacy binding lists no workers and never counts as sharing.
export function sharedSessions(timeline) {
  return new Set(timeline.source_sessions.filter((session) => {
    const own = bindingOf(session, timeline.job)
    if (!Object.hasOwn(own, "agents")) return false
    return session.jobs.some((other) => other !== own && Object.hasOwn(other, "agents") && other.agents.some((agent) => own.agents.includes(agent)))
  }))
}

// The counts of a split session that belong to the job: tool calls and
// failures from the job's own tool intervals (a subagent interval is an
// `agent` call, and carries no outcome). Retries and compactions have no
// worker, so they are left out and the measure is marked partial.
function ownCounts(session, agents) {
  const calls = {}
  const failures = {}
  for (const interval of session.intervals) {
    if (!agents.includes(interval.agent)) continue
    if (interval.kind === "subagent") calls.agent = (calls.agent ?? 0) + 1
    if (interval.kind !== "tool") continue
    calls[interval.tool] = (calls[interval.tool] ?? 0) + 1
    if (interval.outcome !== "ok") failures[interval.tool] = (failures[interval.tool] ?? 0) + 1
  }
  return { tool_calls: calls, tool_failures: failures, tool_retries: 0, api_retries: 0, compactions: 0 }
}

function jobCounted(timeline, split) {
  return timeline.source_sessions.map((session) => split.has(session)
    ? { counts: ownCounts(session, bindingOf(session, timeline.job).agents) }
    : session)
}

function ownsPullRequest(session, binding, pr) {
  if (ownsWholeSession(session, binding)) return true
  return Object.hasOwn(pr, "agent") ? binding.agents.includes(pr.agent) : session.jobs.length === 1
}

function uniqueReferences(timeline) {
  const prs = new Map()
  const commits = new Map()
  for (const session of timeline.source_sessions) {
    const binding = bindingOf(session, timeline.job)
    for (const pr of session.refs.prs) {
      if (ownsPullRequest(session, binding, pr)) prs.set(`${pr.repo}#${pr.number}`, { repo: pr.repo, number: pr.number })
    }
    for (const commit of session.refs.commits) commits.set(`${commit.repo}@${commit.sha}`, commit)
  }
  const pullRequests = [...prs.values()].sort((left, right) => compareText(left.repo, right.repo) || left.number - right.number)
  return { pullRequests, commits: commits.size }
}

export function calculateFormulas(timeline) {
  const sourceSessions = timeline.source_sessions
  const timedSessions = timeline.sessions.filter((session) => session.offset_ms !== null)
  const timedSources = sourceSessions.filter((_, index) => timeline.sessions[index].offset_ms !== null)
  const otherJobs = new Set(sourceSessions.flatMap((session) => session.jobs.map((binding) => binding.job)).filter((job) => job !== timeline.job))
  const sessions = measured({
    bound: sourceSessions.length,
    timeline: timedSessions.length,
    shared: timeline.sessions.filter((session) => session.shared_with > 0).length,
    shared_with_jobs: otherJobs.size,
  })
  const status = currentStatus(timeline)
  const timingUnavailable = timedSessions.length === 0
  const timed = (compute) => timingUnavailable ? unavailable("job_offsets_unavailable") : compute()
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

  const activeCoverage = fieldCoverage(timedSources, ACTIVE_FIELDS, ACTIVE_PARTIAL_FIELDS, new Set(), sharedSessions(timeline))
  const activeValue = (compute) => timed(() => covered(activeCoverage, compute))
  const whenActive = (compute) => activeValue(() => activeMs === 0 ? unavailable("no_active_intervals") : compute())
  const active = activeValue(() => measured(activeMs))
  const busy = activeValue(() => measured(busyMs))
  const activeBeforeCard = activeValue(() => measured(duration(clip(activeUnion, -Infinity, 0))))
  const activeInLead = lead.class === "unavailable"
    ? unavailable(lead.reason)
    : activeValue(() => measured(duration(clip(activeUnion, 0, lead.value))))
  const parallelism = whenActive(() => inferred(busyMs / activeMs, { method: "busy_time_ms/active_time_ms" }))
  const concurrentSessions = whenActive(() => inferred(concurrency(activeUnion, bySession), { method: "active_session_interval_concurrency" }))
  const concurrentAgents = whenActive(() => inferred(concurrency(activeUnion, byAgent), { method: "active_agent_interval_concurrency" }))

  const waits = {}
  const waitUnions = {}
  for (const kind of WAIT_KINDS) {
    waitUnions[kind] = union(timeline.intervals.filter((interval) => interval.kind === kind))
    waits[`${kind}_ms`] = timed(() => covered(fieldCoverage(timedSources, WAIT_FIELDS[kind]), () => measured(duration(waitUnions[kind]))))
  }
  const visibleWaitKinds = WAIT_KINDS.filter((kind) => waits[`${kind}_ms`].class !== "unavailable")
  const longest = timed(() => visibleWaitKinds.length === 0
    ? unavailable("wait_fields_unavailable")
    : withCoverage(longestWait(timeline.intervals.filter((interval) => visibleWaitKinds.includes(interval.kind))), fieldCoverage(timedSources, ANY_WAIT_FIELDS)))
  const queue = timed(() => measured(Math.max(0, Math.min(...timedSessions.map((session) => session.offset_ms)))))

  let flowEfficiency
  if (lead.class === "unavailable") flowEfficiency = unavailable(lead.reason)
  else if (lead.value === 0) flowEfficiency = unavailable("zero_lead_time")
  else if (activeInLead.class === "unavailable") flowEfficiency = activeInLead
  else flowEfficiency = withCoverage(inferred(activeInLead.value / lead.value, { censored: lead.censored, method: "active_in_lead_ms/lead_time_ms" }), activeCoverage)

  const hosts = {}
  for (const session of sourceSessions) hosts[session.session.host] = (hosts[session.session.host] ?? 0) + 1
  const references = uniqueReferences(timeline)
  const split = splitSessions(timeline)
  const counted = jobCounted(timeline, split)
  const splitCoverage = fieldCoverage(sourceSessions, [], [], split)
  const privatePrs = sourceSessions.reduce((total, session) => total + session.refs.private.prs, 0)
  const privateCommits = sourceSessions.reduce((total, session) => total + session.refs.private.commits, 0)

  return {
    status,
    sessions,
    sessions_by_host: measured(Object.fromEntries(Object.entries(hosts).sort(([left], [right]) => compareText(left, right)))),
    lead_time_ms: lead,
    queue_before_start_ms: queue,
    active_time_ms: active,
    active_in_lead_ms: activeInLead,
    active_before_card_ms: activeBeforeCard,
    busy_time_ms: busy,
    parallelism,
    concurrent_sessions: concurrentSessions,
    concurrent_agents: concurrentAgents,
    waits,
    longest_wait: longest,
    lead_contributors: leadContributors({ lead, timingUnavailable, activeInLead, queue, waits, waitUnions }),
    flow_efficiency: flowEfficiency,
    tool_calls_by_kind: withCoverage(measured(sumMap(counted, "tool_calls")), splitCoverage),
    references: measured({
      public_pull_requests: references.pullRequests,
      public_prs: references.pullRequests.length,
      public_commits: references.commits,
      private_prs: privatePrs,
      private_commits: privateCommits,
    }),
    rework_signals: {
      tool_failures: withCoverage(inferred(Object.values(sumMap(counted, "tool_failures")).reduce((total, value) => total + value, 0)), splitCoverage),
      tool_retries: withCoverage(inferred(sumField(counted, "tool_retries")), splitCoverage),
      api_retries: covered(fieldCoverage(sourceSessions, ["api_retries"], [], split), () => inferred(sumField(counted, "api_retries"))),
      session_retouches: inferred(Math.max(0, sourceSessions.length - 1)),
    },
    unavailable: measured(unavailableGroups(sourceSessions)),
    first_pass_yield: unavailable("not_collected_in_slice_1"),
  }
}
