import { firstPassFormula, reworkFormula, signoffFormula } from "./outcomes.js"
import { attentionFormula } from "./attention.js"
import { ACTIVE_KINDS, bindingsOverlap, duration, overlappingBindings, union } from "./timeline.js"
import { fieldsFeeding, reasonsOf, withState } from "./number-states.js"

const WAIT_KINDS = Object.freeze(["human_wait", "permission_wait", "api_retry", "compaction"])
const PARTLY = "host_records_partly"
const TERMINAL_STATUSES = new Set(["done", "cancelled"])
const CONTRIBUTOR_ORDER = Object.freeze([
  "active_in_lead_ms",
  "queue_before_start_ms",
  "human_wait_ms",
  "permission_wait_ms",
  "api_retry_ms",
  "compaction_ms",
])

const measured = (value, extra = {}) => ({ class: "measured", value, ...extra })
const inferred = (value, extra = {}) => ({ class: "inferred", value, ...extra })
const declared = (value, extra = {}) => ({ class: "declared", value, ...extra })
const unavailable = (reason, extra = {}) => ({ class: "unavailable", value: null, reason, ...extra })

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
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
function fieldCoverage(sessions, fields, partialFields, split = new Set(), shared = new Set()) {
  const reasons = new Set()
  const flagReasons = new Set()
  let uncovered = 0
  let lacking = 0
  let splitCount = 0
  let sharedCount = 0
  for (const session of sessions) {
    // A host that records a number only in part leaves it incomplete, never missing.
    const missing = session.unavailable.filter((entry) => fields.includes(entry.field) && entry.reason !== PARTLY)
    const incomplete = session.unavailable.filter((entry) => partialFields.includes(entry.field) || (fields.includes(entry.field) && entry.reason === PARTLY))
    const divided = split.has(session)
    if (divided) splitCount += 1
    const overlapping = shared.has(session)
    if (overlapping) sharedCount += 1
    if (missing.length > 0 || incomplete.length > 0 || divided || overlapping) uncovered += 1
    for (const entry of [...missing, ...incomplete]) flagReasons.add(entry.reason)
    if (missing.length === 0) continue
    lacking += 1
    for (const entry of missing) reasons.add(entry.reason)
  }
  return {
    uncovered,
    none: lacking === sessions.length,
    reasons: [...reasons].sort(compareText),
    partialReasons: [...flagReasons].sort(compareText),
    split: splitCount,
    shared: sharedCount,
  }
}

// The coverage of one formula, with the fields that feed it read from the table.
const coverageOf = (formulaId, sessions, split, shared) => fieldCoverage(sessions, fieldsFeeding(formulaId, "unavailable"), fieldsFeeding(formulaId, "partial"), split, shared)

// Retries have no worker, so a split session cannot say which of them were the
// job's. A job whose sessions are all split therefore has none to report: that
// is unavailable, never a measured zero. With some whole sessions the sum
// covers those only, and the measure stays partial (`worker_split`).
export function retryCoverage(sessions, fields, split, shared, partialFields = []) {
  const coverage = fieldCoverage(sessions, fields, partialFields, split, shared)
  if (sessions.length === 0 || split.size < sessions.length) return coverage
  return { ...coverage, none: true, reasons: [...new Set([...coverage.reasons, "worker_split"])].sort(compareText) }
}

function missingValue(coverage) {
  return coverage.reasons.length === 1 ? unavailable(coverage.reasons[0]) : unavailable("mixed", { reasons: coverage.reasons })
}

function withCoverage(value, coverage) {
  if (value.class === "unavailable" || coverage.uncovered === 0) return value
  const marked = { ...value, partial: true, uncovered_sessions: coverage.uncovered }
  const reasons = [...new Set([...(coverage.split > 0 ? ["worker_split"] : []), ...(coverage.shared > 0 ? ["worker_shared"] : []), ...coverage.partialReasons])]
  return { ...marked, partial_reasons: reasons }
}

// Missing data is never a measured zero: a value no covering session could
// supply is unavailable, and one only some sessions supply is partial.
export function covered(coverage, compute) {
  return coverage.none ? missingValue(coverage) : withCoverage(compute(), coverage)
}

const TOKEN_TYPES = Object.freeze(["input", "output", "cache_read", "cache_write", "reasoning"])

// The job's token totals. Tokens are counted per model for the whole session, so a
// session in which the job owns only some workers is not counted and no share of it
// is guessed (`worker_split`). A counter that is null, or a session with no model at
// all, is unknown rather than 0: that session is left out of the type and the type
// is partial (`field_absent`), or unavailable when no session could supply it.
function tokenTotalFor(type, sessions, split) {
  const formulaId = `tokens_total.${type}`
  const fields = fieldsFeeding(formulaId, "unavailable")
  const partialFields = fieldsFeeding(formulaId, "partial")
  const checked = new Map(sessions.map((session) => {
    const flagged = session.unavailable.some((entry) => fields.includes(entry.field) && entry.reason !== PARTLY)
    const absent = session.models.length === 0 || session.models.some((model) => model.tokens[type] === null || model.tokens[type] === undefined)
    return [session, { unavailable: flagged || !absent ? session.unavailable : [...session.unavailable, { field: "tokens", reason: "field_absent" }], counts: session.models.reduce((total, model) => total + model.tokens[type], 0) }]
  }))
  const entries = [...checked.values()]
  const splitEntries = new Set(sessions.filter((session) => split.has(session)).map((session) => checked.get(session)))
  if (entries.length === 0) return { result: unavailable("job_offsets_unavailable"), uncovered: new Set() }
  const whole = entries.filter((entry) => !splitEntries.has(entry))
  const own = fieldCoverage(whole, fields, partialFields)
  const reasons = [...new Set([...own.reasons, ...(splitEntries.size > 0 ? ["worker_split"] : [])])].sort(compareText)
  const coverage = { ...fieldCoverage(entries, fields, partialFields, splitEntries), none: own.none, reasons }
  const lacking = (entry) => fieldCoverage([entry], fields, partialFields).none
  // Which sessions this type leaves uncovered, so the total can count each once (`tokenSum`).
  const uncovered = new Set(sessions.filter((session) => fieldCoverage([checked.get(session)], fields, partialFields, splitEntries).uncovered > 0))
  return { result: covered(coverage, () => measured(whole.filter((entry) => !lacking(entry)).reduce((total, entry) => total + entry.counts, 0))), uncovered }
}

// Input plus output. A session either part leaves uncovered is uncovered in the total, counted once: the union of the two parts' sessions,
// never the larger of their counts, which would understate it when the parts lack different sessions.
function tokenSum(input, output) {
  const parts = [input.result, output.result]
  const gone = parts.filter((part) => part.class === "unavailable")
  if (gone.length > 0) return missingValue({ reasons: [...new Set(gone.flatMap(reasonsOf))].sort(compareText) })
  const partial = parts.filter((part) => part.partial === true)
  const result = measured(input.result.value + output.result.value)
  if (partial.length === 0) return result
  return { ...result, partial: true, uncovered_sessions: new Set([...input.uncovered, ...output.uncovered]).size, partial_reasons: [...new Set(partial.flatMap((part) => part.partial_reasons))].sort(compareText) }
}

function tokenTotals(sessions, split) {
  const types = Object.fromEntries(TOKEN_TYPES.map((type) => [type, tokenTotalFor(type, sessions, split)]))
  return { total: tokenSum(types.input, types.output), ...Object.fromEntries(Object.entries(types).map(([type, { result }]) => [type, result])) }
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

// The job's own recorded work on the job clock, as [start, end] pairs: the spans of
// each session that belong to the job (its binding's segments) and its recorded intervals. A
// session whose share or offset is unknown adds nothing, so unknown data never moves a figure.
function recordedSpans(timeline) {
  const spans = timeline.intervals.map((interval) => [interval.start_ms, interval.end_ms])
  timeline.source_sessions.forEach((source, index) => {
    const offset = timeline.sessions[index].offset_ms
    const binding = bindingOf(source, timeline.job)
    if (offset === null) return
    if (Array.isArray(binding.segments)) for (const segment of binding.segments) spans.push([offset + segment.start_ms, offset + segment.end_ms])
  })
  return spans
}

// A lead time never reads shorter than the work the job's own sessions recorded. The
// card's dates can be: an adopted card is created and closed at nearly the same moment,
// and a job can keep working after its first `done`. The floor is the wall-clock span of
// the job's recorded spans (not summed agent time, which parallel workers push above wall
// time). A longer span raises the figure to the span and marks it partial: at least that.
// A span that cannot be read (or none) keeps the figure as it is.
function floorLead(lead, timeline) {
  if (lead.class === "unavailable") return lead
  const spans = recordedSpans(timeline).flat()
  if (spans.length === 0 || !spans.every(Number.isFinite)) return lead
  const span = Math.max(...spans.filter((_, index) => index % 2 === 1)) - Math.min(...spans.filter((_, index) => index % 2 === 0))
  if (!(span > lead.value)) return lead
  return { ...lead, class: "inferred", value: span, partial: true, partial_reasons: ["card_dates_shorter_than_work"], basis: "recorded_segment_span" }
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
  const sources = []
  // A kind that is not measured is left out, never listed as zero, and the list says why it is incomplete.
  const missing = []
  if (activeInLead.class === "unavailable") missing.push(...reasonsOf(activeInLead))
  else {
    entries.push(contributor("active_in_lead_ms", activeInLead.value, lead.value, activeInLead))
    sources.push(activeInLead)
  }
  if (queue.class === "unavailable") missing.push(...reasonsOf(queue))
  else {
    entries.push(contributor("queue_before_start_ms", Math.min(queue.value, lead.value), lead.value, queue))
    sources.push(queue)
  }
  for (const kind of WAIT_KINDS) {
    const wait = waits[`${kind}_ms`]
    if (wait.class === "unavailable") {
      missing.push(...reasonsOf(wait))
      continue
    }
    entries.push(contributor(`${kind}_ms`, duration(clip(waitUnions[kind], 0, lead.value)), lead.value, wait))
    sources.push(wait)
  }
  // With no entry left there is no breakdown to show: that is unavailable, never an empty partial list.
  if (entries.length === 0) {
    const gone = [...new Set(missing)].sort(compareText)
    return gone.length === 1 ? unavailable(gone[0]) : unavailable("mixed", { reasons: gone })
  }
  entries.sort((left, right) => right.value_ms - left.value_ms || CONTRIBUTOR_ORDER.indexOf(left.key) - CONTRIBUTOR_ORDER.indexOf(right.key))
  const reasons = [...new Set([...missing, ...sources.flatMap((source) => source.partial_reasons ?? [])])].sort(compareText)
  const result = inferred(entries, { censored: lead.censored, method: "clipped_to_lead_window" })
  return reasons.length === 0 ? result : { ...result, partial: true, partial_reasons: reasons }
}

function bindingOf(session, job) {
  return session.jobs.find((binding) => binding.job === job)
}

// A binding without `agents` is the legacy session-level binding: every
// worker counts. One listing every worker of the session is the same thing.
function ownsWholeSession(session, binding) {
  return !Object.hasOwn(binding, "agents") || session.agents.every((agent) => binding.agents.includes(agent.n))
}

// Whether the job's binding splits the controller's (worker 0's) time by segments.
// Segments on a binding that does not list worker 0 (which the validators refuse) are ignored.
function segmented(binding) {
  return Object.hasOwn(binding, "segments") && Object.hasOwn(binding, "agents") && binding.agents.includes(0)
}

// The source sessions in which the job owns only some of the workers, or only
// some of the controller's time, so the session-wide counts are not the job's own.
export function splitSessions(timeline) {
  return new Set(timeline.source_sessions.filter((session) => {
    const binding = bindingOf(session, timeline.job)
    return segmented(binding) || !ownsWholeSession(session, binding)
  }))
}

// The segmented source sessions in which the job holds a shared span of the controller's time.
function sharedSegmentSessions(timeline) {
  return new Set(timeline.source_sessions.filter((session) => {
    const binding = bindingOf(session, timeline.job)
    return segmented(binding) && binding.segments.some((segment) => segment.shared === true)
  }))
}

// The source sessions in which one of the job's workers also belongs to
// another job. That worker's time is counted for each job that owns it, so
// the job's time is partial. A legacy binding lists no workers and never
// counts as sharing. A job with `segments` holds only its own spans of the
// controller's (worker 0's) time, so the controller makes it shared only
// through a span marked `shared`; its other workers count as before.
export function sharedSessions(timeline) {
  return new Set(timeline.source_sessions.filter((session) => {
    const own = bindingOf(session, timeline.job)
    if (!Object.hasOwn(own, "agents")) return false
    const split = segmented(own)
    if (split && own.segments.some((segment) => segment.shared === true)) return true
    const workers = split ? own.agents.filter((agent) => agent !== 0) : own.agents
    if (split && session.jobs.some((other) => other !== own && Object.hasOwn(other, "agents") && other.agents.includes(0) && bindingsOverlap(own, other))) return true
    return session.jobs.some((other) => other !== own && Object.hasOwn(other, "agents") && other.agents.some((agent) => workers.includes(agent)))
  }))
}

// The counts of a split session that belong to the job: tool calls and
// failures from the job's own tool intervals (a subagent interval is an
// `agent` call, and carries no outcome). A segmented job counts a controller
// (worker 0) interval only when one of its segments holds the interval's
// start, so the controller's calls are split with its time; one starting in a
// shared span counts for each job sharing it. Retries and compactions have no
// worker, so they are left out and the measure is marked partial.
function ownCounts(session, binding) {
  const calls = {}
  const failures = {}
  const durationMs = session.session.duration_ms
  for (const interval of session.intervals) {
    if (!binding.agents.includes(interval.agent)) continue
    if (interval.agent === 0 && segmented(binding) && !binding.segments.some((segment) => holds(segment, interval.start_ms, durationMs))) continue
    if (interval.kind === "subagent") calls.agent = (calls.agent ?? 0) + 1
    if (interval.kind !== "tool") continue
    calls[interval.tool] = (calls[interval.tool] ?? 0) + 1
    if (interval.outcome !== "ok") failures[interval.tool] = (failures[interval.tool] ?? 0) + 1
  }
  return { tool_calls: calls, tool_failures: failures, tool_retries: 0, api_retries: 0, compactions: 0 }
}

function jobCounted(timeline, split) {
  return timeline.source_sessions.map((session) => split.has(session)
    ? { counts: ownCounts(session, bindingOf(session, timeline.job)) }
    : session)
}

// Whether a segment holds the instant `at` (milliseconds from session start).
// Segments are half-open, so a boundary belongs to the later segment; the
// session's own last instant belongs to the segment that ends there.
function holds(segment, at, durationMs) {
  return (segment.start_ms <= at && at < segment.end_ms) || (at === durationMs && segment.end_ms === durationMs)
}

// The job binding a controller (worker 0) PR's time decides: the one job
// whose unshared segment holds the PR's `at_ms`. `undefined` when the time
// decides nothing: the PR is another worker's or has no time, or the instant
// falls in a shared span or in no job's segment.
function segmentOwner(session, pr) {
  if (pr.agent !== 0 || !Object.hasOwn(pr, "at_ms")) return undefined
  const holders = session.jobs.filter((binding) => segmented(binding)
    && binding.segments.some((segment) => holds(segment, pr.at_ms, session.session.duration_ms)))
  if (holders.length !== 1) return undefined
  const shared = holders[0].segments.some((segment) => segment.shared === true && holds(segment, pr.at_ms, session.session.duration_ms))
  return shared ? undefined : holders[0]
}

// A binding without `agents` is the legacy session-level binding and keeps
// every reference of the session. A controller PR whose time falls in one
// job's own segment goes to that job (`segmentOwner`). Otherwise a pull
// request is credited to the worker that opened it, and only when no other
// job of the session lists that worker. A pull request with no worker, or
// one whose worker several jobs share, goes to the job only when the session
// binds no other job.
function ownsPullRequest(session, binding, pr) {
  if (!Object.hasOwn(binding, "agents")) return true
  if (!Object.hasOwn(pr, "agent")) return session.jobs.length === 1
  return binding.agents.includes(pr.agent)
    && !session.jobs.some((other) => other !== binding && Object.hasOwn(other, "agents") && other.agents.includes(pr.agent))
}

// Public commits carry no worker, so a per-worker session credits them only
// to the one job it binds.
function ownsCommits(session, binding) {
  return !Object.hasOwn(binding, "agents") || session.jobs.length === 1
}

function uniqueReferences(timeline) {
  const prs = new Map()
  const commits = new Map()
  const withheld = new Set()
  for (const session of timeline.source_sessions) {
    const binding = bindingOf(session, timeline.job)
    let held = false
    for (const pr of session.refs.prs) {
      // A PR its time gives to another job is that job's, not one held back from this one.
      const owner = Object.hasOwn(binding, "agents") ? segmentOwner(session, pr) : undefined
      if (owner === undefined ? ownsPullRequest(session, binding, pr) : owner === binding) prs.set(`${pr.repo}#${pr.number}`, { repo: pr.repo, number: pr.number })
      else if (owner === undefined) held = true
    }
    if (ownsCommits(session, binding)) {
      for (const commit of session.refs.commits) commits.set(`${commit.repo}@${commit.sha}`, commit)
    } else if (session.refs.commits.length > 0) held = true
    // Withholding only means the job's list is incomplete when another job of the session may hold the rest.
    if (held && session.jobs.length > 1) withheld.add(session)
  }
  const pullRequests = [...prs.values()].sort((left, right) => compareText(left.repo, right.repo) || left.number - right.number)
  return { pullRequests, commits: commits.size, withheld }
}

// Every result, at the top or inside `waits` and `rework_signals`, gains its
// state and reasons from the one place that derives them (`withState`).
function decorate(results) {
  return Object.fromEntries(Object.entries(results).map(([name, result]) => [name, Object.hasOwn(result, "class") ? withState(result) : decorate(result)]))
}

// The composite keeps its value object as readers know it, except that a count
// whose part is unavailable is null, never 0. It is unavailable only when every
// part is; otherwise any part that is not measured makes it partial. Either way
// its reasons are the union of the parts' reasons.
function referencesResult(references, parts, privateCounts) {
  const count = (name, number) => parts[name].result.class === "unavailable" ? null : number
  const value = measured({
    public_pull_requests: references.pullRequests,
    public_prs: count("public_prs", references.pullRequests.length),
    public_commits: count("public_commits", references.commits),
    private_prs: count("private_prs", privateCounts.privatePrs),
    private_commits: count("private_commits", privateCounts.privateCommits),
  })
  const entries = Object.values(parts)
  const reasons = [...new Set(entries.flatMap((entry) => entry.result.reasons))].sort(compareText)
  const uncovered = Math.max(...entries.map((entry) => entry.coverage.uncovered))
  const allMissing = entries.every((entry) => entry.result.class === "unavailable")
  // Public pull requests have no field that can make them unavailable, so every part is unavailable only for a job with no sessions, and then all four share the one reason the job clock gives.
  const result = allMissing ? { ...value, class: "unavailable", reason: reasons[0] } : reasons.length === 0 ? value : { ...value, partial: true, uncovered_sessions: uncovered, partial_reasons: reasons }
  return { ...result, parts: Object.fromEntries(Object.entries(parts).map(([name, entry]) => [name, entry.result])) }
}

export function calculateFormulas(timeline) {
  const sourceSessions = timeline.source_sessions
  const timedSessions = timeline.sessions.filter((session) => session.offset_ms !== null)
  // A session that says its job offsets were lost puts none of its time on the job clock, but its time exists, so it still counts in the coverage of every clock-fed number.
  const clockSources = sourceSessions.filter((session, index) => timeline.sessions[index].offset_ms !== null || session.unavailable.some((entry) => entry.field === "job_offsets"))
  // Only jobs whose time really overlaps this job's in a session count as sharing with it.
  const otherJobs = new Set(sourceSessions.flatMap((session) => overlappingBindings(session, bindingOf(session, timeline.job)).map((binding) => binding.job)).filter((job) => job !== timeline.job))
  const sessions = measured({
    bound: sourceSessions.length,
    timeline: timedSessions.length,
    shared: timeline.sessions.filter((session) => session.shared_with > 0).length,
    shared_with_jobs: otherJobs.size,
  }, { basis: "captured_sessions" })
  const status = currentStatus(timeline)
  const timingUnavailable = timedSessions.length === 0
  const timed = (compute) => timingUnavailable ? unavailable("job_offsets_unavailable") : compute()
  // The card's own figure feeds the window-based numbers (active in lead, contributors, flow); only the published lead time is floored.
  const cardLead = leadTime(timeline, status)
  const lead = floorLead(cardLead, timeline)
  // A raised lead time has no window the card's clock can measure over, so what reads that window says so instead of answering over the wrong one.
  const windowLead = lead === cardLead ? cardLead : unavailable("card_dates_shorter_than_work")

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

  const sharedTime = sharedSessions(timeline)
  const activeCoverage = (formulaId) => coverageOf(formulaId, clockSources, new Set(), sharedTime)
  const activeValue = (formulaId, compute) => timed(() => covered(activeCoverage(formulaId), compute))
  const whenActive = (formulaId, compute) => activeValue(formulaId, () => activeMs === 0 ? unavailable("no_active_intervals") : compute())
  const active = activeValue("active_time_ms", () => measured(activeMs))
  const busy = activeValue("busy_time_ms", () => measured(busyMs))
  const activeBeforeCard = activeValue("active_before_card_ms", () => measured(duration(clip(activeUnion, -Infinity, 0))))
  const activeInLead = cardLead.class === "unavailable"
    ? unavailable(cardLead.reason)
    : activeValue("active_in_lead_ms", () => measured(duration(clip(activeUnion, 0, cardLead.value))))
  const parallelism = whenActive("parallelism", () => inferred(busyMs / activeMs, { method: "busy_time_ms/active_time_ms" }))
  const concurrentSessions = whenActive("concurrent_sessions", () => inferred(concurrency(activeUnion, bySession), { method: "active_session_interval_concurrency" }))
  const concurrentAgents = whenActive("concurrent_agents", () => inferred(concurrency(activeUnion, byAgent), { method: "active_agent_interval_concurrency" }))

  const waits = {}
  const waitUnions = {}
  for (const kind of WAIT_KINDS) {
    waitUnions[kind] = union(timeline.intervals.filter((interval) => interval.kind === kind))
    waits[`${kind}_ms`] = timed(() => covered(coverageOf(`waits.${kind}_ms`, clockSources), () => measured(duration(waitUnions[kind]))))
  }
  const visibleWaitKinds = WAIT_KINDS.filter((kind) => waits[`${kind}_ms`].class !== "unavailable")
  const longest = timed(() => visibleWaitKinds.length === 0
    ? unavailable("wait_fields_unavailable")
    : withCoverage(longestWait(timeline.intervals.filter((interval) => visibleWaitKinds.includes(interval.kind))), coverageOf("longest_wait", clockSources)))
  const queue = timed(() => covered(coverageOf("queue_before_start_ms", clockSources, new Set(), new Set()), () => measured(Math.max(0, Math.min(...timedSessions.map((session) => session.offset_ms))), { basis: "first_captured_session" })))

  let flowEfficiency
  if (windowLead.class === "unavailable") flowEfficiency = unavailable(windowLead.reason)
  else if (cardLead.value === 0) flowEfficiency = unavailable("zero_lead_time")
  else if (activeInLead.class === "unavailable") flowEfficiency = activeInLead
  else flowEfficiency = withCoverage(inferred(activeInLead.value / cardLead.value, { censored: cardLead.censored, method: "active_in_lead_ms/lead_time_ms" }), activeCoverage("flow_efficiency"))

  const hosts = {}
  for (const session of sourceSessions) hosts[session.session.host] = (hosts[session.session.host] ?? 0) + 1
  const references = uniqueReferences(timeline)
  const split = splitSessions(timeline)
  const counted = jobCounted(timeline, split)
  const sharedSegments = sharedSegmentSessions(timeline)
  const countCoverage = (formulaId) => fieldCoverage(sourceSessions, fieldsFeeding(formulaId, "unavailable"), fieldsFeeding(formulaId, "partial"), split, sharedSegments)
  const privatePrs = sourceSessions.reduce((total, session) => total + session.refs.private.prs, 0)
  const privateCommits = sourceSessions.reduce((total, session) => total + session.refs.private.commits, 0)
  // Public counts keep the withheld sessions (a worker shared with another job) as uncovered; private counts are summed over every session.
  // A job with no source sessions has nothing to count: every part is unavailable for the same cause the job clock gives.
  const part = (formulaId, shared, count) => {
    if (sourceSessions.length === 0) return { coverage: coverageOf(formulaId, sourceSessions, new Set(), shared), result: withState(unavailable("job_offsets_unavailable")) }
    const coverage = coverageOf(formulaId, sourceSessions, new Set(), shared)
    return { coverage, result: withState(covered(coverage, () => measured(count))) }
  }
  const parts = {
    public_prs: part("references.public_prs", references.withheld, references.pullRequests.length),
    public_commits: part("references.public_commits", references.withheld, references.commits),
    private_prs: part("references.private_prs", new Set(), privatePrs),
    private_commits: part("references.private_commits", new Set(), privateCommits),
  }

  return decorate({
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
    lead_contributors: leadContributors({ lead: windowLead, timingUnavailable, activeInLead, queue, waits, waitUnions }),
    flow_efficiency: flowEfficiency,
    tool_calls_by_kind: withCoverage(measured(sumMap(counted, "tool_calls")), countCoverage("tool_calls_by_kind")),
    references: referencesResult(references, parts, { privatePrs, privateCommits }),
    rework_signals: {
      tool_failures: withCoverage(inferred(Object.values(sumMap(counted, "tool_failures")).reduce((total, value) => total + value, 0)), countCoverage("rework_signals.tool_failures")),
      tool_retries: covered(retryCoverage(sourceSessions, fieldsFeeding("rework_signals.tool_retries", "unavailable"), split, sharedSegments, fieldsFeeding("rework_signals.tool_retries", "partial")), () => inferred(sumField(counted, "tool_retries"))),
      api_retries: covered(retryCoverage(sourceSessions, fieldsFeeding("rework_signals.api_retries", "unavailable"), split, sharedSegments), () => inferred(sumField(counted, "api_retries"))),
      session_retouches: inferred(Math.max(0, sourceSessions.length - 1), { basis: "captured_sessions" }),
    },
    tokens_total: tokenTotals(sourceSessions, split),
    unavailable: measured(unavailableGroups(sourceSessions)),
    first_pass_yield: firstPassFormula(timeline.outcome),
    signoff: signoffFormula(timeline.outcome),
    rework: reworkFormula(timeline.outcome),
    attention: attentionFormula(timeline.source_sessions, timeline.job),
  })
}
