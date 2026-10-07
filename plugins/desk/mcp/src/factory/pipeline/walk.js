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
//   - A work burst is a maximal run of the union of the job's `turn`,
//     `tool` and `subagent` intervals inside the lead window, broken by an
//     idle gap of at least `BURST_IDLE_GAP_MS` (15 minutes) or by an
//     operator turn: a turn that arrives while work runs splits the burst
//     there, and one that arrives in a shorter gap starts the next burst.
//     The gaps are the rest of the window: the time before the first burst,
//     between bursts and after the last one. Bursts and gaps add up to the
//     lead time exactly.
//   - A gap's `waited_on` is the cause that covers most of it: `next_prompt`
//     (a `human_wait`: the agent had stopped and the next prompt had not
//     come, nights included), `api_retry`, `queue_before_start` (no session
//     of the job had started yet) or `no_session` (no session of the job was
//     running); ties go to that order, and a gap none of them covers is
//     `unknown`.
//   - The stack-up splits the lead window into segments that add up to the
//     lead time exactly: the queue before the first session, each labeled
//     class and waste (after the honest correction), the waiting time the
//     correction gave back to the job's working agents
//     (`agents_working_unlabeled_ms`), session time no stretch covers
//     (`not_labeled_ms`) and time no session of the job was running
//     (`no_session_ms`). Wall-clock time counts once: where stretches of
//     concurrent sessions overlap, the moment goes to the first of value,
//     support, the eight wastes in their schema order, unknown and agents
//     working. Stretches outside the window (before the card, after done)
//     are not in it. A session with no job offset cannot be placed: its time
//     reads as no session, and the segments that depend on placement are
//     partial (`job_offsets_unavailable`). The document says so in
//     `basis: "wall_clock_in_lead_window"`: its waste totals are wall-clock
//     time inside the lead window, so they do not match the muda rollup,
//     which sums each session's labeled time.
//   - Labeled figures are measured only when every session of the job is
//     labeled; partial (`partial`: only some sessions supplied it) when
//     some are; unavailable (`not_labeled`, or `open_job` for a job that is
//     not finished) when none is. Labels that may count another job's time (`resolveLabels`'
//     `sharedLabels`) make them partial (`labels_from_shared_session`).
//   - A cause is `<waste>:<detail>`: for waiting, its `waited_on`; for
//     defects, the failed tool kind its evidence rests on most; otherwise
//     `all`. `rollups/causes.json` sums the corrected muda of finished, fully
//     labeled jobs as the muda Pareto does (each session's time once: the
//     first job by ID that labeled a moment keeps it), so its waste totals
//     equal the Pareto's corrected ones.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { LABEL_WASTES, UNKNOWN_LABEL } from "../label-schema.js"
import { recordedSpans } from "./formulas.js"
import { ROLLUPS_SCHEMA } from "./rollups.js"
import { CAUSE_REFERENCES, UNLABELED_CLASS, WAITED_ON, causeKey, compareFields, evidenceIntervals, jobStretches, mostTime } from "./stretches.js"
import { ACTIVE_KINDS, duration, union } from "./timeline.js"

/** An idle gap at least this long ends a work burst: 15 minutes. */
export const BURST_IDLE_GAP_MS = 15 * 60 * 1000

/** What a gap between bursts waited on, in tie-break order. */
export const GAP_WAITED_ON = Object.freeze(["next_prompt", "api_retry", "queue_before_start", "no_session", "unknown"])

/** The stack-up's labeled segments, in the order wall-clock time is given to them where stretches overlap. */
const STACKUP_CLASSES = Object.freeze(["value", "support"])
const STACKUP_WASTES = Object.freeze([...LABEL_WASTES, UNKNOWN_LABEL])

// What a stack-up segment measures (see the header).
const STACKUP_BASIS = "wall_clock_in_lead_window"
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

// A gap's cause (see the header).
function gapCause(start, end, intervals, sessions) {
  const time = new Map([
    ["next_prompt", within(spansOf(intervals.filter((interval) => interval.kind === "human_wait")), start, end)],
    ["api_retry", within(spansOf(intervals.filter((interval) => interval.kind === "api_retry")), start, end)],
  ])
  const idle = subtract([[start, end]], sessions.spans)
  const before = within(idle, start, sessions.first)
  time.set("queue_before_start", before)
  time.set("no_session", duration(idle) - before)
  return mostTime(GAP_WAITED_ON, time)
}

// Spans of the job's corrected stretches that pass `test`, merged across sessions and clipped to the window.
function stretchSpans(stretches, test, window) {
  return clip(spansOf(stretches.filter(test)), window.start_ms, window.end_ms)
}

const isClass = (name) => (stretch) => stretch.class === name
const isWaste = (waste) => (stretch) => (waste === UNKNOWN_LABEL ? stretch.class === UNKNOWN_LABEL : stretch.class === "muda" && stretch.waste === waste)
// The only unlabeled stretches are the parts the correction split off (`reason: "agents_working"`).
const isAgentsWorking = (stretch) => stretch.class === UNLABELED_CLASS

/**
 * `jobWalk({ timeline, formulas, additions }, labels, finished) -> walk`: everything the walk derives for one job: the lead window, its bursts and
 * gaps (for `jobs/<job>.json`), its stack-up row and its compact answer. `additions` is `timelineAdditions`' result, `labels` is
 * `resolveLabels`' result and `finished` the job record's own reading.
 */
export function jobWalk({ timeline, formulas, additions }, labels, finished) {
  const window = leadWindow(timeline, formulas)
  const stretches = jobStretches(timeline, labels)
  const sessions = sessionSpans(timeline)
  const coverage = labelState(timeline, labels, finished)
  const turns = additions.human_turns
  const placement = sessions.unplaced ? ["job_offsets_unavailable"] : []
  const walk = { job: timeline.job, window, stretches, coverage }
  const allActive = spansOf(timeline.intervals.filter((interval) => ACTIVE_KINDS.has(interval.kind)))
  const active = Object.hasOwn(window, "start_ms") ? clip(allActive, window.start_ms, window.end_ms) : allActive
  const raw = burstSpans(active, turns)
  walk.bursts = raw.map((burst) => burstEntry(burst, timeline, stretches, turns))
  for (const turn of turns) {
    const index = burstOfTurn(raw, turn.at_ms)
    if (index >= 0) walk.bursts[index].operator_turns += 1
  }
  for (const pr of additions.prs) {
    if (!Object.hasOwn(pr, "at_ms")) continue
    const index = burstAt(raw, pr.at_ms)
    if (index >= 0) walk.bursts[index].prs += 1
  }
  const edges = Object.hasOwn(window, "start_ms") ? [window.start_ms, ...raw.flatMap((burst) => [burst.start_ms, burst.end_ms]), window.end_ms] : raw.flatMap((burst) => [burst.start_ms, burst.end_ms]).slice(1, -1)
  walk.gaps = []
  for (let index = 0; index + 1 < edges.length; index += 2) {
    const [start, end] = [edges[index], edges[index + 1]]
    if (end > start) walk.gaps.push({ start_ms: start, end_ms: end, waited_on: gapCause(start, end, timeline.intervals, sessions) })
  }
  walk.stackup = stackupRow(timeline, formulas, window, stretches, sessions, coverage, placement)
  walk.task = taskRow(timeline, formulas, window, stretches, coverage, active, walk, labels)
  return walk
}

function burstEntry(burst, timeline, stretches) {
  const overlapping = timeline.intervals.filter((interval) => ACTIVE_KINDS.has(interval.kind) && interval.start_ms < burst.end_ms && interval.end_ms > burst.start_ms)
  const tools = overlapping.filter((interval) => interval.kind === "tool" && Math.max(interval.start_ms, burst.start_ms) < burst.end_ms)
  const value = stretchSpans(stretches, isClass("value"), burst)
  const defects = stretches.filter((stretch) => isWaste("defects")(stretch) && stretch.start_ms < burst.end_ms && stretch.end_ms > burst.start_ms)
  return {
    start_ms: burst.start_ms,
    end_ms: burst.end_ms,
    working_ms: duration(burst.spans),
    sessions: sortedUnique(overlapping.map((interval) => interval.session_id)),
    agents: new Set(overlapping.map((interval) => `${interval.host}/${interval.session_id}/${interval.agent}`)).size,
    tool_calls: tools.length,
    tool_failures: tools.filter((interval) => interval.outcome !== "ok").length,
    operator_turns: 0,
    prs: 0,
    value_ms: duration(value),
    defect_ms: within(spansOf(defects), burst.start_ms, burst.end_ms),
    defect_stretches: new Set(defects.map((stretch) => stretch.source)).size,
  }
}

// The wall-clock time each labeled segment holds in the window, overlaps given by precedence (see the header).
function segmentTimes(stretches, window, inSessions) {
  const order = [
    ...STACKUP_CLASSES.map((name) => [name, isClass(name)]),
    ...STACKUP_WASTES.map((waste) => [waste, isWaste(waste)]),
    ["agents_working", isAgentsWorking],
  ]
  let taken = []
  const times = {}
  for (const [name, test] of order) {
    const spans = subtract(stretchSpans(stretches, test, window), taken)
    const placed = spans.flatMap(([start, end]) => clip(inSessions, start, end))
    times[name] = duration(placed)
    taken = spansOf([...taken, ...placed])
  }
  return { times, labeled: duration(taken) }
}

function stackupRow(timeline, formulas, window, stretches, sessions, coverage, placement) {
  const row = { job: timeline.job, status: statusFigure(formulas), lead_time_ms: window.lead }
  const keys = ["queue_before_start_ms", "not_labeled_ms", "no_session_ms", "agents_working_unlabeled_ms"]
  if (!Object.hasOwn(window, "start_ms")) {
    const none = figure("unavailable", null, window.reasons)
    for (const key of keys) row[key] = none
    row.class_ms = Object.fromEntries(STACKUP_CLASSES.map((name) => [name, none]))
    row.waste_ms = Object.fromEntries(STACKUP_WASTES.map((waste) => [waste, none]))
    return row
  }
  const { start_ms: start, end_ms: end } = window
  const queueEnd = Math.min(Math.max(sessions.first, start), end)
  const queue = queueEnd - start
  const inSessions = clip(sessions.spans, start, end)
  const sessionTime = duration(inSessions)
  const { times, labeled } = segmentTimes(stretches, window, inSessions)
  const base = window.reasons
  const labeledFigure = (value) => (Object.hasOwn(coverage, "unavailable") ? figure("unavailable", null, coverage.unavailable) : known(value, [...base, ...coverage.reasons]))
  row.queue_before_start_ms = known(queue, [...base, ...placement])
  row.class_ms = Object.fromEntries(STACKUP_CLASSES.map((name) => [name, labeledFigure(times[name])]))
  row.waste_ms = Object.fromEntries(STACKUP_WASTES.map((waste) => [waste, labeledFigure(times[waste])]))
  row.agents_working_unlabeled_ms = labeledFigure(times.agents_working)
  row.not_labeled_ms = known(sessionTime - labeled, [...base, ...placement])
  row.no_session_ms = known(end - start - queue - sessionTime, [...base, ...placement])
  return row
}

function statusFigure(formulas) {
  return fromResult(formulas.status)
}

// Each cause's merged time among the stretches, largest first, ties by key.
function causeTimes(stretches, window) {
  const byCause = new Map()
  for (const stretch of stretches) {
    if (stretch.class !== "muda") continue
    const key = causeKey(stretch, stretch.intervals)
    byCause.set(key, [...(byCause.get(key) ?? []), stretch])
  }
  return [...byCause.entries()]
    .map(([cause, members]) => ({ cause, total_ms: duration(clip(spansOf(members), window.start_ms, window.end_ms)) }))
    .filter((entry) => entry.total_ms > 0)
    .map((entry) => ({ ...entry, rank: -entry.total_ms }))
    .sort((left, right) => compareFields(left, right, ["rank", "cause"]))
    .map(({ rank, ...entry }) => entry)
}

function taskRow(timeline, formulas, window, stretches, coverage, active, walk, labels) {
  const row = { job: timeline.job, status: statusFigure(formulas), lead_time_ms: window.lead, labels_from_shared_session: timeline.sessions.some((session) => labels.sharedLabels?.has(`${timeline.job}/${session.id}`)) }
  const keys = ["working_ms", "value_in_working_ms", "flow_efficiency", "agents_working_unlabeled_ms", "top_causes", "longest_gap", "bursts"]
  if (!Object.hasOwn(window, "start_ms")) {
    const none = figure("unavailable", null, window.reasons)
    for (const key of keys) row[key] = none
    row.waiting_by_waited_on_ms = Object.fromEntries(WAITED_ON.map((cause) => [cause, none]))
    return row
  }
  const base = window.reasons
  const labeledFigure = (value) => (Object.hasOwn(coverage, "unavailable") ? figure("unavailable", null, coverage.unavailable) : known(value, [...base, ...coverage.reasons]))
  const working = duration(active)
  const lead = window.end_ms - window.start_ms
  row.working_ms = known(working, base)
  row.value_in_working_ms = labeledFigure(duration(subtract(active, subtract(active, stretchSpans(stretches, isClass("value"), window)))))
  row.flow_efficiency = lead === 0 ? figure("unavailable", null, ["zero_lead_time"]) : known(working / lead, base)
  row.waiting_by_waited_on_ms = Object.fromEntries(WAITED_ON.map((cause) => [cause, labeledFigure(duration(stretchSpans(stretches, (stretch) => isWaste("waiting")(stretch) && stretch.waited_on === cause, window)))]))
  row.agents_working_unlabeled_ms = labeledFigure(duration(stretchSpans(stretches, isAgentsWorking, window)))
  row.top_causes = Object.hasOwn(coverage, "unavailable")
    ? figure("unavailable", null, coverage.unavailable)
    : known(causeTimes(stretches, window).slice(0, TOP_CAUSES).map((entry) => ({ ...entry, hours: entry.total_ms / MS_PER_HOUR })), [...base, ...coverage.reasons])
  const longest = [...walk.gaps].sort((left, right) => (right.end_ms - right.start_ms) - (left.end_ms - left.start_ms) || left.start_ms - right.start_ms)[0]
  row.longest_gap = longest === undefined ? figure("unavailable", null, ["no_wait_intervals"]) : known({ ...longest, duration_ms: longest.end_ms - longest.start_ms }, base)
  row.bursts = known(walk.bursts.length, base)
  return row
}

/** `stackupRollup(walks) -> document`: `rollups/stackup.json`, one segment row per job, by job ID. */
export function stackupRollup(walks) {
  return {
    schema: ROLLUPS_SCHEMA,
    basis: STACKUP_BASIS,
    burst_idle_gap_ms: BURST_IDLE_GAP_MS,
    classes: STACKUP_CLASSES,
    wastes: STACKUP_WASTES,
    jobs: [...walks].sort((left, right) => compareText(left.job, right.job)).map((walk) => walk.stackup),
  }
}

/** `tasksRollup(walks) -> document`: `rollups/tasks.json`, each job's compact answer, by job ID. */
export function tasksRollup(walks) {
  return { schema: ROLLUPS_SCHEMA, waited_on: WAITED_ON, jobs: [...walks].sort((left, right) => compareText(left.job, right.job)).map((walk) => walk.task) }
}

// The parts of a stretch outside the merged spans.
function uncoveredParts(stretch, spans) {
  return subtract([[stretch.start_ms, stretch.end_ms]], spans).map(([start, end]) => ({ start, end }))
}

/**
 * `causesRollup({ records, timelines, labels, sessions }) -> document`: `rollups/causes.json`. Sums the corrected muda of every finished,
 * fully labeled job (`records`' `muda_time` counted) by cause, each session's time once (the first job by ID keeps a moment), largest
 * first, with the jobs that add time and up to `CAUSE_REFERENCES` of the largest stretch parts, `{ job, host, session, start_ms, end_ms }`
 * on that job's clock (a part whose session has no job offset adds its time but no reference).
 */
export function causesRollup({ records, timelines, labels }) {
  const counted = records.filter((record) => record.measures.muda_time.state === "measured").sort((left, right) => compareText(left.job, right.job))
  const excluded = records.filter((record) => record.measures.muda_time.state !== "measured").map((record) => record.measures.muda_time.excluded)
  const timelineOf = new Map(timelines.map((timeline) => [timeline.job, timeline]))
  const taken = new Map()
  const causes = new Map()
  for (const record of counted) {
    const timeline = timelineOf.get(record.job)
    timeline.source_sessions.forEach((session, index) => {
      // A counted job has usable labels for every session.
      const entry = labels.byJobSession.get(`${record.job}/${session.session.id}`)
      const key = `${session.session.host}/${session.session.id}`
      const before = taken.get(key) ?? []
      const offset = timeline.sessions[index].offset_ms
      for (const stretch of entry.corrected) {
        if (stretch.class !== "muda") continue
        const cause = causeKey(stretch, evidenceIntervals(session, stretch.evidence))
        const entryOf = causes.get(cause) ?? { cause, waste: stretch.waste, total_ms: 0, jobs: new Set(), parts: [] }
        for (const part of uncoveredParts(stretch, before)) {
          entryOf.total_ms += part.end - part.start
          entryOf.jobs.add(record.job)
          if (offset !== null) entryOf.parts.push({ job: record.job, host: session.session.host, session: session.session.id, start_ms: offset + part.start, end_ms: offset + part.end })
        }
        causes.set(cause, entryOf)
      }
      taken.set(key, spansOf([...before, ...entry.stretches.map((stretch) => [stretch.start_ms, stretch.end_ms])]))
    })
  }
  const rows = [...causes.values()].filter((entry) => entry.total_ms > 0).map((entry) => ({ ...entry, rank: -entry.total_ms })).sort((left, right) => compareFields(left, right, ["rank", "cause"]))
  const total = rows.reduce((sum, row) => sum + row.total_ms, 0)
  let running = 0
  const state = counted.length === 0 ? "unavailable" : counted.length === records.length ? "measured" : "partial"
  const reasons = state === "measured" ? [] : excluded.length === 0 ? ["no_finished_jobs"] : sortedUnique(excluded)
  return {
    schema: ROLLUPS_SCHEMA,
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
        stretches: row.parts.map((part) => ({ part, rank: part.start_ms - part.end_ms, job: part.job, start_ms: part.start_ms })).sort((left, right) => compareFields(left, right, ["rank", "job", "start_ms"])).slice(0, CAUSE_REFERENCES).map((entry) => entry.part),
      }
    }),
  }
}
