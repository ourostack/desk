// The Lean walk's data: each job's work bursts and the gaps between them,
// its stack-up of lead time, its compact answer, and the causes of waste
// ranked by time. Every figure is a number-state envelope, `{ state, value,
// reasons }`, with `value` absent when the state is `unavailable`; a zero is
// always a measured zero, never missing data. No who, no when: every time is
// on a job's own clock (milliseconds since its card was created), and
// nothing here orders jobs against each other.
//
// Rules:
//   - The lead window is the span the job's lead time measures: from the
//     card's creation (0) to the lead time's end. When the lead time is
//     floored to the span of the job's recorded work
//     (`card_dates_shorter_than_work`), the window is that span instead.
//     Without a lead time there is no window, and every figure that needs
//     one is unavailable with the lead time's reasons. A lead time that is
//     partial (censored, or floored) makes every figure measured over its
//     window partial with the same reasons.
//   - Working and idle time split the lead window and add up to it.
//     Working time is the union of the job's `turn`, `tool` and `subagent`
//     intervals, less, in each session, the time that session's evaluator
//     labeled `waiting` (after the honest correction: the work was stopped,
//     and no other worker of the job was working), so one session's wait
//     never hides another's work. Idle time is the rest of the window, and
//     "waiting" means idle time and nothing else. A job with no labels yet
//     counts all of its recorded work as working.
//   - Each idle moment has one `waited_on`, the first of `IDLE_WAITED_ON`
//     that claims it: `next_prompt` (a labeled wait on it, or the facts'
//     `human_wait`: the agent had stopped and the next prompt had not come,
//     nights included), `api_retry` (a labeled wait or the facts' retry),
//     `tool_failure` and `long_tool_call` (labeled waits only),
//     `queue_before_start` (no session of the job had started yet),
//     `no_session` (no session of the job was running) and `unknown` (no
//     label or evidence says). Labeled classes and wastes describe working
//     time only: a label over an idle moment does not change its cause.
//   - A work burst is a maximal run of working time inside the lead window,
//     broken by an idle gap of at least `BURST_IDLE_GAP_MS` (15 minutes) or
//     by an operator turn: a turn that arrives while work runs splits the
//     burst there, and one that arrives in a shorter gap starts the next
//     burst. The gaps are the rest of the window: the time before the first
//     burst, between bursts and after the last one. Bursts and gaps add up
//     to the lead time exactly, and each burst's `idle_ms` is the idle time
//     inside it: the gaps plus every burst's idle time are the idle time. A
//     gap's `waited_on` is the cause holding most of it, ties to the first
//     in `IDLE_WAITED_ON`; the totals count short waits inside bursts too,
//     each with its own cause.
//   - The stack-up row splits the lead window into `working` (by class and
//     waste, where labeled stretches of concurrent sessions overlap the
//     moment goes to the first of value, support, the seven working wastes
//     in their schema order, unknown and agents working; plus
//     `agents_working_unlabeled_ms` and `not_labeled_ms`) and `idle` (by
//     `waited_on`), and the two add up to the lead time exactly. The document
//     says so in `basis: "wall_clock_in_lead_window"`: its totals are
//     wall-clock time inside the lead window, so they do not match the muda
//     rollup, which sums each session's labeled time. A session with no job
//     offset cannot be placed: its time reads as no session, and the
//     segments that depend on placement are partial
//     (`job_offsets_unavailable`).
//   - Labeled figures are measured only when every session of the job is
//     labeled; partial (`partial`: only some sessions supplied it) when
//     some are; unavailable (`not_labeled`, or `open_job` for a job that is
//     not finished) when none is. Labels that may count another job's time (`resolveLabels`'
//     `sharedLabels`) make them partial (`labels_from_shared_session`).
//     Working and idle time, and the idle causes the facts alone can name,
//     take only the reasons of labels the job has: labels move time, but
//     none is needed to read it.
//   - Every figure read from the job's intervals takes its state and
//     reasons from the formulas' `active_time_ms`, which reads the same
//     intervals with each session's completeness flags (`source_unreadable`,
//     `log_truncated`, `session_open`, ...): the walk never states those
//     intervals more whole than the formulas do. The job file says so for
//     its bursts and gaps in `bursts_state`. A task's `flow_efficiency` is
//     working time over lead time, stated as both are, so it agrees with
//     the working and idle figures. When the card's dates are shorter than
//     the work and the job is closed, the floored lead time makes it an
//     upper bound (`bound: "upper"`) and the idle time a lower bound
//     (`bound: "lower"`); an open job's has no bound. The formulas' own ratio (recorded
//     active time in the card's lead window over the lead time, none when
//     the lead time is floored to the work) is kept beside it as
//     `active_share_recorded`.
//   - A burst's counts publish as envelopes, never a zero for no data: its
//     labeled time is unavailable (`not_labeled`) when none of its sessions
//     has labels, its operator turns take the formulas' `attention` state
//     (unavailable when turns were not recorded or cannot be placed; a turn
//     whose attention cannot be estimated still counts), and its
//     pull requests are unavailable when the job's pull requests carry no
//     time and partial when only some do (`not_in_published_facts`, or
//     `job_offsets_unavailable` for a session the job clock cannot place).
//     A human turn outside the lead window is in no burst, and a tool call
//     counts in the burst where it starts.
//   - A cause is `waiting:<waited_on>` for idle time, and for a labeled
//     waste of working time `<waste>:<detail>`: for defects, the failed tool
//     kind its evidence rests on most; otherwise `all`. `rollups/causes.json`
//     sums each finished, fully labeled job's causes in its lead window, so
//     a moment two jobs share counts for each (job-hours).
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { LABEL_WASTES, UNKNOWN_LABEL } from "../label-schema.js"
import { recordedSpans } from "./formulas.js"
import { ROLLUPS_SCHEMA, pluginVersion } from "./rollups.js"
import { CAUSE_REFERENCES, UNLABELED_CLASS, causeKey, compareFields, jobStretches, mostTime } from "./stretches.js"
import { ACTIVE_KINDS, duration, union } from "./timeline.js"

/** An idle gap at least this long ends a work burst: 15 minutes. */
export const BURST_IDLE_GAP_MS = 15 * 60 * 1000

/** What idle time waited on, in the order a moment two causes could claim is given to one, and a gap's tie broken (see the header). */
export const IDLE_WAITED_ON = Object.freeze(["next_prompt", "api_retry", "tool_failure", "long_tool_call", "queue_before_start", "no_session", "unknown"])

/** The stack-up's labeled segments, in the order wall-clock time is given to them where stretches overlap. */
const STACKUP_CLASSES = Object.freeze(["value", "support"])
// Labeled waiting is idle time, so the wastes of working time are the other seven and unknown.
const WORKING_WASTES = Object.freeze([...LABEL_WASTES.filter((waste) => waste !== "waiting"), UNKNOWN_LABEL])

// What a stack-up segment measures (see the header).
const STACKUP_BASIS = "wall_clock_in_lead_window"
// What a cause's time in `rollups/causes.json` measures (see `causesRollup`).
const CAUSES_BASIS = "job_hours"
const MS_PER_HOUR = 3_600_000
const TOP_CAUSES = 3
const SHARED = "labels_from_shared_session"

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

const sortedUnique = (values) => [...new Set(values)].sort(compareText)

/**
 * A number-state envelope in the formulas' own shape: `class` (how the number was got: `inferred` for one this file derives,
 * `unavailable` for none), `state`, `reasons` and `value`, which is absent when the state is `unavailable`; a reason whenever the state
 * is not `measured`.
 */
export function figure(state, value, reasons, numberClass = "inferred") {
  const named = sortedUnique(reasons)
  if (state !== "measured" && named.length === 0) throw new Error(`a ${state} figure has no reason`)
  return state === "unavailable" ? { class: "unavailable", state, reasons: named } : { class: numberClass, state, value, reasons: state === "measured" ? [] : named }
}

// A formula result (a lead time, a status) as an envelope.
const fromResult = (result) => (result.state === "unavailable" ? figure("unavailable", null, result.reasons) : figure(result.state, result.value, result.reasons, result.class))

// A value whose inputs carry `reasons`: measured without any, partial with them.
const known = (value, reasons) => figure(reasons.length === 0 ? "measured" : "partial", value, reasons)

// A coverage is `{ unavailable: reasons }` or `{ reasons }` (none when whole).
const coverageOfResult = (result) => (result.state === "unavailable" ? { unavailable: result.reasons } : { reasons: result.state === "measured" ? [] : result.reasons })

// A value read from inputs with these coverages: unavailable with the reasons of every unavailable one, else measured or partial with
// `base` and every coverage's reasons.
function covered(value, base, ...coverages) {
  const missing = coverages.filter((coverage) => Object.hasOwn(coverage, "unavailable"))
  if (missing.length > 0) return figure("unavailable", null, missing.flatMap((coverage) => coverage.unavailable))
  return known(value, [...base, ...coverages.flatMap((coverage) => coverage.reasons)])
}

// Merged spans clipped to [start, end].
function clip(spans, start, end) {
  return spans.flatMap(([from, to]) => {
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    return a < b ? [[a, b]] : []
  })
}

// Merged spans minus merged spans.
function subtract(spans, minus) {
  const out = []
  for (const [start, end] of spans) {
    let from = start
    for (const [a, b] of minus) {
      if (b <= from || a >= end) continue
      if (a > from) out.push([from, a])
      from = Math.max(from, b)
    }
    if (from < end) out.push([from, end])
  }
  return out
}

// Merged spans of [start_ms, end_ms] objects or [start, end] pairs.
const spansOf = (items) => union(items.map((item) => (Array.isArray(item) ? { start_ms: item[0], end_ms: item[1] } : item)))

// How much of the merged spans lies in [start, end].
const within = (spans, start, end) => duration(clip(spans, start, end))

/**
 * `leadWindow(timeline, formulas) -> { start_ms, end_ms, lead, reasons } | { lead, reasons }`: the span the lead time measures (see the
 * header), with the lead time's envelope and its reasons; no `start_ms` when there is no lead time.
 */
function leadWindow(timeline, formulas) {
  const result = formulas.lead_time_ms
  const lead = fromResult(result)
  if (result.state === "unavailable") return { lead, reasons: lead.reasons }
  const floored = result.reasons.includes("card_dates_shorter_than_work")
  const start = floored ? Math.min(...recordedSpans(timeline).map(([from]) => from)) : 0
  return { start_ms: start, end_ms: start + result.value, lead, reasons: lead.reasons }
}

// The job's sessions on the job clock, as [start, end] pairs, whether any could not be placed, and where the first starts (never, as
// `Infinity`, when none is placed).
function sessionSpans(timeline) {
  const placed = timeline.sessions.filter((session) => session.offset_ms !== null)
  return { spans: spansOf(placed.map((session) => [session.offset_ms, session.end_ms])), unplaced: placed.length < timeline.sessions.length, first: Math.min(...placed.map((session) => session.offset_ms)) }
}

// The labels' coverage of the job, as the reasons its labeled figures carry, or `null` (with the cause) when none can be given.
function labelState(timeline, labels, finished) {
  const keys = timeline.sessions.map((session) => `${timeline.job}/${session.id}`)
  const used = keys.filter((key) => labels.byJobSession.has(key))
  if (used.length === 0) return { unavailable: [finished ? "not_labeled" : "open_job"] }
  const reasons = []
  if (used.length < keys.length) reasons.push("partial")
  if (used.some((key) => labels.sharedLabels?.has(key))) reasons.push(SHARED)
  return { reasons }
}

// The bursts of active spans in the window, broken by idle gaps and operator turns (see the header).
function burstSpans(active, turns) {
  const cuts = turns.map((turn) => turn.at_ms).sort((left, right) => left - right)
  const pieces = active.flatMap(([start, end]) => {
    const inside = cuts.filter((at) => at > start && at < end)
    const points = [start, ...inside, end]
    return points.slice(1).map((to, index) => [points[index], to])
  })
  const bursts = []
  for (const [start, end] of pieces) {
    const last = bursts.at(-1)
    // An operator turn from the moment the last work stopped up to this work's start opens a new burst.
    const turnBetween = last !== undefined && cuts.some((at) => at >= last.end_ms && at <= start)
    if (last === undefined || start - last.end_ms >= BURST_IDLE_GAP_MS || turnBetween) bursts.push({ start_ms: start, end_ms: end, spans: [[start, end]] })
    else {
      last.end_ms = end
      last.spans.push([start, end])
    }
  }
  return bursts
}

// The first burst whose span holds `at`, ends included, or -1.
function burstAt(bursts, at) {
  return bursts.findIndex((burst) => burst.start_ms <= at && at <= burst.end_ms)
}

// The burst a turn belongs to: the one it falls in or the next one it comes before (a turn at a split starts the later burst); -1 after
// the last.
function burstOfTurn(bursts, at) {
  return bursts.findIndex((burst) => at < burst.end_ms)
}

// Spans of the job's corrected stretches that pass `test`, merged across sessions and clipped to the window.
function stretchSpans(stretches, test, window) {
  return clip(spansOf(stretches.filter(test)), window.start_ms, window.end_ms)
}

const isClass = (name) => (stretch) => stretch.class === name
const isWaste = (waste) => (stretch) => (waste === UNKNOWN_LABEL ? stretch.class === UNKNOWN_LABEL : stretch.class === "muda" && stretch.waste === waste)
const isWaiting = isWaste("waiting")
// The only unlabeled stretches are the parts the correction split off (`reason: "agents_working"`).
const isAgentsWorking = (stretch) => stretch.class === UNLABELED_CLASS

/**
 * The job's working time on the job clock: each session's active intervals less that session's labeled waiting (the time its evaluator
 * found the work stopped, after the honest correction), merged across sessions, so one session's wait never hides another's work.
 */
function workingSpans(timeline, stretches) {
  const bySession = new Map()
  for (const interval of timeline.intervals) {
    if (!ACTIVE_KINDS.has(interval.kind)) continue
    const key = `${interval.host}/${interval.session_id}`
    bySession.set(key, [...(bySession.get(key) ?? []), interval])
  }
  return spansOf([...bySession.entries()].flatMap(([key, intervals]) => subtract(spansOf(intervals), spansOf(stretches.filter((stretch) => isWaiting(stretch) && `${stretch.host}/${stretch.session}` === key)))))
}

/**
 * What each idle moment in [start, end] waited on, as disjoint merged spans per `IDLE_WAITED_ON` cause (see the header): before any session
 * of the job, no session running, then a labeled wait's `waited_on` or the facts' own `human_wait` (`next_prompt`) and `api_retry`
 * intervals, each moment to the first cause in that order, and the rest `unknown`.
 */
function idleCauses(start, end, working, sessions, stretches, intervals) {
  const idle = subtract([[start, end]], working)
  const outside = subtract(idle, sessions.spans)
  const queue = clip(outside, start, sessions.first)
  const sources = new Map([
    ["queue_before_start", queue],
    ["no_session", subtract(outside, queue)],
  ])
  const evidence = { next_prompt: "human_wait", api_retry: "api_retry" }
  for (const cause of ["next_prompt", "api_retry", "tool_failure", "long_tool_call"]) {
    const labeled = stretches.filter((stretch) => isWaiting(stretch) && stretch.waited_on === cause)
    const facts = intervals.filter((interval) => interval.kind === evidence[cause])
    sources.set(cause, spansOf([...labeled, ...facts]))
  }
  sources.set("unknown", [[start, end]])
  let taken = []
  const out = {}
  for (const cause of IDLE_WAITED_ON) {
    const spans = subtract(clip(spansOf(sources.get(cause)), start, end).flatMap(([from, to]) => clip(idle, from, to)), taken)
    out[cause] = spans
    taken = spansOf([...taken, ...spans])
  }
  return out
}

/**
 * `jobWalk({ timeline, formulas, additions }, labels, finished) -> walk`: everything the walk derives for one job: the lead window, its
 * working and idle time, its bursts and gaps (for `jobs/<job>.json`), its stack-up row and its compact answer. `additions` is
 * `timelineAdditions`' result, `labels` is `resolveLabels`' result and `finished` the job record's own reading.
 */
export function jobWalk({ timeline, formulas, additions }, labels, finished) {
  const window = leadWindow(timeline, formulas)
  const hasWindow = Object.hasOwn(window, "start_ms")
  const stretches = jobStretches(timeline, labels)
  const sessions = sessionSpans(timeline)
  const coverage = labelState(timeline, labels, finished)
  const intervals = coverageOfResult(formulas.active_time_ms)
  // A turn outside the lead window belongs to no burst.
  const turns = hasWindow ? additions.human_turns.filter((turn) => turn.at_ms >= window.start_ms && turn.at_ms <= window.end_ms) : additions.human_turns
  const placement = sessions.unplaced ? ["job_offsets_unavailable"] : []
  const allWorking = workingSpans(timeline, stretches)
  const working = hasWindow ? clip(allWorking, window.start_ms, window.end_ms) : allWorking
  const raw = burstSpans(working, turns)
  // Without a lead window idle time is read only between the first and last burst.
  const [start, end] = hasWindow ? [window.start_ms, window.end_ms] : [raw.at(0)?.start_ms ?? 0, raw.at(-1)?.end_ms ?? 0]
  const idle = idleCauses(start, end, working, sessions, stretches, timeline.intervals)
  const walk = { job: timeline.job, window, stretches, coverage, intervals, working, idle }
  const counts = burstCounts(raw, timeline, turns, additions)
  const context = { timeline, stretches, coverage, labels, formulas, additions }
  walk.bursts = raw.map((burst, index) => burstEntry(burst, counts[index], context))
  walk.bursts_state = { state: Object.hasOwn(intervals, "unavailable") ? "unavailable" : intervals.reasons.length === 0 ? "measured" : "partial", reasons: sortedUnique(intervals.unavailable ?? intervals.reasons) }
  const edges = [start, ...raw.flatMap((burst) => [burst.start_ms, burst.end_ms]), end]
  walk.gaps = []
  for (let index = 0; index + 1 < edges.length; index += 2) {
    const [from, to] = [edges[index], edges[index + 1]]
    if (to > from) walk.gaps.push({ start_ms: from, end_ms: to, waited_on: mostTime(IDLE_WAITED_ON, new Map(IDLE_WAITED_ON.map((cause) => [cause, within(idle[cause], from, to)]))) })
  }
  walk.stackup = stackupRow({ timeline, formulas, window, stretches, coverage, placement, intervals, working, idle, labels })
  walk.task = taskRow({ timeline, formulas, window, stretches, coverage, placement, intervals, working, idle, labels, walk })
  return walk
}

// What each burst holds, counted once each: its sessions and workers (every interval it overlaps), its tool calls (each in the burst
// where it starts, or the first burst when it starts before them), its operator turns and its timed pull requests.
function burstCounts(raw, timeline, turns, additions) {
  const counts = raw.map(() => ({ sessions: new Set(), agents: new Set(), tools: 0, failures: 0, turns: 0, prs: 0 }))
  for (const interval of timeline.intervals) {
    if (!ACTIVE_KINDS.has(interval.kind)) continue
    raw.forEach((burst, index) => {
      if (interval.start_ms >= burst.end_ms || interval.end_ms <= burst.start_ms) return
      counts[index].sessions.add(interval.session_id)
      counts[index].agents.add(`${interval.host}/${interval.session_id}/${interval.agent}`)
      // A tool call counts in the burst where it starts; one that starts before every burst counts in the first.
      const at = Math.max(interval.start_ms, raw[0].start_ms)
      if (interval.kind !== "tool" || at < burst.start_ms) return
      counts[index].tools += 1
      if (interval.outcome !== "ok") counts[index].failures += 1
    })
  }
  for (const turn of turns) {
    const index = burstOfTurn(raw, turn.at_ms)
    if (index >= 0) counts[index].turns += 1
  }
  for (const pr of additions.prs) {
    if (!Object.hasOwn(pr, "at_ms")) continue
    const index = burstAt(raw, pr.at_ms)
    if (index >= 0) counts[index].prs += 1
  }
  return counts
}

// The labels' coverage of one burst's sessions: none labeled is unavailable (`not_labeled`), some is partial.
function burstLabels(sessions, { timeline, coverage, labels }) {
  if (Object.hasOwn(coverage, "unavailable")) return coverage
  const keys = sessions.map((session) => `${timeline.job}/${session}`)
  const used = keys.filter((key) => labels.byJobSession.has(key))
  if (used.length === 0) return { unavailable: ["not_labeled"] }
  const reasons = []
  if (used.length < keys.length) reasons.push("partial")
  if (used.some((key) => labels.sharedLabels?.has(key))) reasons.push(SHARED)
  return { reasons }
}

// The coverage of a burst's operator turn count: the formulas' `attention` state and reasons, less `turn_not_estimable`, which says a
// turn's attention could not be estimated, not that the turn is missing.
function turnCoverage(attention) {
  const reasons = attention.reasons.filter((reason) => reason !== "turn_not_estimable")
  if (attention.state === "unavailable" && reasons.length > 0) return { unavailable: reasons }
  return { reasons }
}

// The coverage of a burst's timed pull request count beyond the job's pull request list's own: none or only part when some carry no time.
function prTimes({ timeline, additions }) {
  const unplaced = new Set(timeline.sessions.filter((session) => session.offset_ms === null).map((session) => session.id))
  const untimed = additions.prs.filter((pr) => !Object.hasOwn(pr, "at_ms"))
  const why = untimed.map((pr) => (unplaced.has(pr.session) ? "job_offsets_unavailable" : "not_in_published_facts"))
  if (untimed.length > 0 && untimed.length === additions.prs.length) return { unavailable: why }
  return { reasons: why }
}

function burstEntry(burst, count, context) {
  const { stretches } = context
  const value = stretchSpans(stretches, isClass("value"), burst).flatMap(([from, to]) => clip(burst.spans, from, to))
  const defects = stretches.filter((stretch) => isWaste("defects")(stretch) && stretch.start_ms < burst.end_ms && stretch.end_ms > burst.start_ms)
  const sessions = [...count.sessions].sort(compareText)
  const labeled = burstLabels(sessions, context)
  const working = duration(burst.spans)
  return {
    start_ms: burst.start_ms,
    end_ms: burst.end_ms,
    working_ms: working,
    idle_ms: burst.end_ms - burst.start_ms - working,
    sessions,
    agents: count.agents.size,
    tool_calls: count.tools,
    tool_failures: count.failures,
    operator_turns: covered(count.turns, [], turnCoverage(context.formulas.attention)),
    prs: covered(count.prs, [], coverageOfResult(context.formulas.references), prTimes(context)),
    value_ms: covered(duration(value), [], labeled),
    defect_ms: covered(within(spansOf(defects), burst.start_ms, burst.end_ms), [], labeled),
    defect_stretches: covered(new Set(defects.map((stretch) => stretch.source)).size, [], labeled),
  }
}

// The working time each labeled segment holds, overlaps given by precedence (see the header), and the working time no label covers.
function workingSegments(stretches, window, working) {
  const order = [
    ...STACKUP_CLASSES.map((name) => [name, isClass(name)]),
    ...WORKING_WASTES.map((waste) => [waste, isWaste(waste)]),
    ["agents_working", isAgentsWorking],
  ]
  let taken = []
  const times = {}
  const spans = {}
  for (const [name, test] of order) {
    const placed = subtract(stretchSpans(stretches, test, window), taken).flatMap(([start, end]) => clip(working, start, end))
    times[name] = duration(placed)
    spans[name] = placed
    taken = spansOf([...taken, ...placed])
  }
  return { times, spans, not_labeled: duration(working) - duration(taken) }
}

// A labels coverage that, when the job has no labels, only notes it: figures the labels refine but do not need.
const refinedBy = (coverage) => (Object.hasOwn(coverage, "unavailable") ? { reasons: [] } : coverage)

// Each idle cause as a figure: before and outside sessions need placement, and labeled causes need the labels.
function idleFigures(idle, { base, coverage, intervals, placement }) {
  return Object.fromEntries(IDLE_WAITED_ON.map((cause) => {
    const value = duration(idle[cause])
    if (cause === "queue_before_start" || cause === "no_session") return [cause, covered(value, [...base, ...placement], intervals)]
    if (cause === "tool_failure" || cause === "long_tool_call") return [cause, covered(value, base, intervals, coverage)]
    return [cause, covered(value, base, intervals, refinedBy(coverage))]
  }))
}

function stackupRow({ timeline, formulas, window, stretches, coverage, placement, intervals, working, idle }) {
  const row = { job: timeline.job, desk_version: pluginVersion(timeline.source_sessions), status: statusFigure(formulas), lead_time_ms: window.lead }
  if (!Object.hasOwn(window, "start_ms")) {
    const none = figure("unavailable", null, window.reasons)
    row.working_ms = none
    row.idle_ms = none
    row.working = {
      class_ms: Object.fromEntries(STACKUP_CLASSES.map((name) => [name, none])),
      waste_ms: Object.fromEntries(WORKING_WASTES.map((waste) => [waste, none])),
      agents_working_unlabeled_ms: none,
      not_labeled_ms: none,
    }
    row.idle = Object.fromEntries(IDLE_WAITED_ON.map((cause) => [cause, none]))
    return row
  }
  const base = window.reasons
  const workingTime = duration(working)
  const segments = workingSegments(stretches, window, working)
  const labeledFigure = (value) => covered(value, base, coverage, intervals)
  row.working_ms = covered(workingTime, base, intervals, refinedBy(coverage))
  row.idle_ms = covered(window.end_ms - window.start_ms - workingTime, base, intervals, refinedBy(coverage))
  row.working = {
    class_ms: Object.fromEntries(STACKUP_CLASSES.map((name) => [name, labeledFigure(segments.times[name])])),
    waste_ms: Object.fromEntries(WORKING_WASTES.map((waste) => [waste, labeledFigure(segments.times[waste])])),
    agents_working_unlabeled_ms: labeledFigure(segments.times.agents_working),
    not_labeled_ms: covered(segments.not_labeled, base, intervals),
  }
  row.idle = idleFigures(idle, { base, coverage, intervals, placement })
  return row
}

function statusFigure(formulas) {
  return fromResult(formulas.status)
}

/**
 * Each cause's time in a job's lead window, largest first, ties by key, with its spans on the job clock: every idle cause as
 * `waiting:<waited_on>`, and each labeled waste of working time as `<waste>:<detail>` (`causeKey`).
 */
function jobCauses(walk) {
  const { window, stretches, working, idle } = walk
  const byCause = new Map(IDLE_WAITED_ON.map((cause) => [`waiting:${cause}`, { waste: "waiting", spans: idle[cause] }]))
  for (const stretch of stretches) {
    if (stretch.class !== "muda" || isWaiting(stretch)) continue
    const key = causeKey(stretch, stretch.intervals)
    const entry = byCause.get(key) ?? { waste: stretch.waste, spans: [] }
    entry.spans = spansOf([...entry.spans, ...clip([[stretch.start_ms, stretch.end_ms]], window.start_ms, window.end_ms).flatMap(([from, to]) => clip(working, from, to))])
    byCause.set(key, entry)
  }
  return [...byCause.entries()]
    .map(([cause, entry]) => ({ cause, waste: entry.waste, spans: entry.spans, total_ms: duration(entry.spans) }))
    .filter((entry) => entry.total_ms > 0)
    .map((entry) => ({ ...entry, rank: -entry.total_ms }))
    .sort((left, right) => compareFields(left, right, ["rank", "cause"]))
    .map(({ rank, ...entry }) => entry)
}

function taskRow({ timeline, formulas, window, coverage, placement, intervals, working, idle, labels, walk }) {
  const row = {
    job: timeline.job,
    status: statusFigure(formulas),
    lead_time_ms: window.lead,
    labels_from_shared_session: timeline.sessions.some((session) => labels.sharedLabels?.has(`${timeline.job}/${session.id}`)),
    active_share_recorded: fromResult(formulas.flow_efficiency),
  }
  const keys = ["working_ms", "idle_ms", "value_in_working_ms", "flow_efficiency", "agents_working_unlabeled_ms", "top_causes", "longest_gap", "bursts"]
  if (!Object.hasOwn(window, "start_ms")) {
    const none = figure("unavailable", null, window.reasons)
    for (const key of keys) row[key] = none
    row.waiting_by_waited_on_ms = Object.fromEntries(IDLE_WAITED_ON.map((cause) => [cause, none]))
    return row
  }
  const base = window.reasons
  const workingTime = duration(working)
  const segments = workingSegments(walk.stretches, window, working)
  // Labeled figures that the intervals also shape (the split, waited_on and cause keys read them).
  const labeledFigure = (value) => covered(value, base, coverage, intervals)
  row.working_ms = covered(workingTime, base, intervals, refinedBy(coverage))
  row.idle_ms = covered(window.end_ms - window.start_ms - workingTime, base, intervals, refinedBy(coverage))
  row.value_in_working_ms = labeledFigure(segments.times.value)
  // Working time over lead time; `working_ms` already carries the lead time's reasons.
  const lead = window.end_ms - window.start_ms
  if (lead === 0) row.flow_efficiency = figure("unavailable", null, ["zero_lead_time"])
  else row.flow_efficiency = row.working_ms.state === "unavailable" ? row.working_ms : known(row.working_ms.value / lead, row.working_ms.reasons)
  // A lead time floored to the work is a lower bound, so on a closed job the ratio is at most this and the idle time at least this. An
  // open job's lead time is censored too, so neither direction holds and no bound is given.
  if (window.lead.reasons.includes("card_dates_shorter_than_work") && !window.lead.reasons.includes("censored")) {
    for (const [key, bound] of [["flow_efficiency", "upper"], ["idle_ms", "lower"]]) if (row[key].state !== "unavailable") row[key] = { ...row[key], bound }
  }
  row.waiting_by_waited_on_ms = idleFigures(idle, { base, coverage, intervals, placement })
  row.agents_working_unlabeled_ms = labeledFigure(segments.times.agents_working)
  row.top_causes = labeledFigure(jobCauses(walk).slice(0, TOP_CAUSES).map(({ cause, total_ms: total }) => ({ cause, total_ms: total, hours: total / MS_PER_HOUR })))
  const longest = [...walk.gaps].sort((left, right) => (right.end_ms - right.start_ms) - (left.end_ms - left.start_ms) || left.start_ms - right.start_ms)[0]
  row.longest_gap = longest === undefined ? figure("unavailable", null, ["no_wait_intervals"]) : covered({ ...longest, duration_ms: longest.end_ms - longest.start_ms }, base, intervals)
  row.bursts = covered(walk.bursts.length, base, intervals)
  return row
}

/** `stackupRollup(walks) -> document`: `rollups/stackup.json`, one row per job, by job ID: working time by label and idle time by cause. */
export function stackupRollup(walks) {
  return {
    schema: ROLLUPS_SCHEMA,
    basis: STACKUP_BASIS,
    burst_idle_gap_ms: BURST_IDLE_GAP_MS,
    idle_waited_on: IDLE_WAITED_ON,
    classes: STACKUP_CLASSES,
    working_wastes: WORKING_WASTES,
    jobs: [...walks].sort((left, right) => compareText(left.job, right.job)).map((walk) => walk.stackup),
  }
}

/** `tasksRollup(walks) -> document`: `rollups/tasks.json`, each job's compact answer, by job ID. */
export function tasksRollup(walks) {
  return { schema: ROLLUPS_SCHEMA, waited_on: IDLE_WAITED_ON, jobs: [...walks].sort((left, right) => compareText(left.job, right.job)).map((walk) => walk.task) }
}

/**
 * `causesRollup({ records, walks, labels }) -> document`: `rollups/causes.json`. Sums, over every finished, fully labeled job (`records`'
 * `muda_time` counted) whose intervals are readable, each job's causes in its lead window (`jobCauses`): idle time by `waited_on` and
 * the labeled wastes of working time. A moment two jobs share counts for each (job-hours). Largest first, with the jobs that add time
 * and up to `CAUSE_REFERENCES` of the largest spans, `{ job, start_ms, end_ms }` on that job's clock.
 */
export function causesRollup({ records, walks, labels }) {
  const walkOf = new Map(walks.map((walk) => [walk.job, walk]))
  const labeled = records.filter((record) => record.measures.muda_time.state === "measured")
  const counted = labeled.filter((record) => !Object.hasOwn(walkOf.get(record.job).intervals, "unavailable") && Object.hasOwn(walkOf.get(record.job).window, "start_ms")).sort((left, right) => compareText(left.job, right.job))
  const excluded = [
    ...records.filter((record) => record.measures.muda_time.state !== "measured").map((record) => record.measures.muda_time.excluded),
    ...labeled.filter((record) => !counted.includes(record)).flatMap((record) => walkOf.get(record.job).intervals.unavailable ?? walkOf.get(record.job).window.reasons),
  ]
  const partly = counted.flatMap((record) => walkOf.get(record.job).intervals.reasons)
  const causes = new Map()
  for (const record of counted) {
    for (const entry of jobCauses(walkOf.get(record.job))) {
      const row = causes.get(entry.cause) ?? { cause: entry.cause, waste: entry.waste, total_ms: 0, jobs: new Set(), parts: [] }
      row.total_ms += entry.total_ms
      row.jobs.add(record.job)
      row.parts.push(...entry.spans.map(([start, end]) => ({ job: record.job, start_ms: start, end_ms: end })))
      causes.set(entry.cause, row)
    }
  }
  const rows = [...causes.values()].map((entry) => ({ ...entry, rank: -entry.total_ms })).sort((left, right) => compareFields(left, right, ["rank", "cause"]))
  const total = rows.reduce((sum, row) => sum + row.total_ms, 0)
  let running = 0
  // A counted job whose labels may count another job's time makes the ranking partial.
  const shared = counted.some((record) => walkOf.get(record.job).task.labels_from_shared_session)
  const whole = counted.length === records.length && !shared && partly.length === 0
  const state = counted.length === 0 ? "unavailable" : whole ? "measured" : "partial"
  const reasons = state === "measured" ? [] : counted.length === 0 && excluded.length === 0 ? ["no_finished_jobs"] : sortedUnique([...excluded, ...partly, ...(shared ? [SHARED] : [])])
  return {
    schema: ROLLUPS_SCHEMA,
    // Each job's causes are summed as that job's own time, so a moment two jobs share counts once for each.
    basis: CAUSES_BASIS,
    state,
    reasons,
    n: counted.length,
    N: records.length,
    references_per_cause: CAUSE_REFERENCES,
    ...(state === "unavailable" ? {} : { total_ms: total }),
    causes: rows.map((row) => {
      running += row.total_ms
      return {
        cause: row.cause,
        waste: row.waste,
        total_ms: row.total_ms,
        hours: row.total_ms / MS_PER_HOUR,
        share: row.total_ms / total,
        cumulative_share: running / total,
        jobs: [...row.jobs].sort(compareText),
        spans: row.parts.map((part) => ({ part, rank: part.start_ms - part.end_ms, job: part.job, start_ms: part.start_ms })).sort((left, right) => compareFields(left, right, ["rank", "job", "start_ms"])).slice(0, CAUSE_REFERENCES).map((entry) => entry.part),
      }
    }),
  }
}
