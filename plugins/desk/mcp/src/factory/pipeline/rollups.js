// Factory rollups: which waste costs the most across jobs, and how the
// measure catalog moves between plugin versions. No who, no when: jobs are
// grouped only by plugin version, host, job class and waste type (tool kinds
// are summed per session), never by contributor, and nothing here reads or
// writes a date or a time of day.
//
// Rules:
//   - Only finished jobs count. A job is finished when its status is
//     terminal (`done` or `cancelled`, measured or declared) and its lead time
//     is not censored. Every measure of any other job is excluded as
//     `open_job`, because an open job's totals so far are right-censored and
//     the newest plugin version always has the most open jobs.
//   - Only complete values count. A job's measure is excluded, with its
//     reason, when the formulas mark it unavailable, `partial` (some sessions
//     could not supply it) or `censored` (an open job's lead time or flow
//     efficiency). Every group reports `n` of `N`: how many jobs each measure
//     counted (`n`, which is `jobs_counted`) of how many jobs the group holds
//     (`N`, open jobs included), the stat's `state` (measured when `n === N`,
//     partial when `0 < n < N`, unavailable when `n === 0`) and why the rest
//     were excluded; a measure no job supplies has no median, not a zero.
//   - One partial value stays in the job record: a formula that is partial
//     only because the host records its numbers partly
//     (`host_records_partly`) keeps its `value`, a lower bound, with
//     `state: "partial"` and its `reasons`, so andon and the kaizen check can
//     still compare it and say so. It is never counted in a median or in `n`;
//     it counts in `N` and is listed under its reason. Every other partial
//     value is `{ excluded: "partial" }`, and every value that is counted says
//     `state: "measured"`.
//   - Medians and 75th percentiles use the nearest-rank method: sort the
//     counted values ascending and take the value at 1-based rank
//     `ceil(p * n)` (rank 1 when that is 0). The result is always one of the
//     measured values, never an interpolation.
//   - `muda_time` and `muda_time.<waste>` come from validated labels
//     (`label-schema.js`). A job has them only when every one of its bound
//     sessions has usable labels for it: labels that still match that
//     session's facts and do not declare `facts_missing`. Then a waste the
//     evaluator did not find is a measured zero. With some sessions labeled
//     the job is excluded as `partial`; with none, as `not_labeled`.
//   - The waste Pareto lists the eight wastes and, once any of its sessions
//     has `desk.factory.labels/2` labels, an `unknown` row: time the
//     evaluator looked at and could not tell. `unknown` counts in the labeled
//     time every row's `share` is taken of, but not in `muda_time_ms` or in
//     any `muda_time` measure, because it is not known to be waste. A store
//     whose labels are all `/1` has no `unknown` row: those evaluators could
//     not say "unknown", so a zero there would stand for no data.
//   - Each Pareto row carries `evaluator_versions`, the distinct evaluator
//     versions (in release order) of the labels that speak to the row: the
//     labels with time in it, or, for a row with no time, every label of the
//     sessions summed (they all judged that waste absent). A `/2` label
//     carries its own version; a `/1` label speaks with its file's. The row
//     carries `confidence_ms: { high, medium, low }`, the time in it by the
//     evaluator's confidence, only when every label that speaks to it
//     recorded one (`/2`); the three always add up to `total_ms`. A row any
//     `/1` label speaks to has no `confidence_ms`: its confidence was not
//     recorded, and is never counted as high.
//   - Labels count only inside the job's own share of each session
//     (`resolveLabels`): its binding's segments. An evaluator may label the
//     whole of a session several jobs share; cut to each job's share, each
//     job's `muda_time` counts only its own part. A segment Desk marks
//     `shared` is held by several jobs, and each holder's `muda_time` counts
//     it. The Pareto counts each session's time once: where jobs' shares
//     overlap, the first job by job ID that labeled a stretch of that time
//     keeps it, whatever the stretch's class (value included), and a row's
//     `jobs` are the jobs that add time to it. Labels whose job's
//     share the facts do not record (`share_unknown`), or that have no
//     stretch inside it (`outside_share`), are unused, so the job reads
//     partial or not labeled, never the whole session and never a zero.
//     Each Pareto reports how many labeled sessions it summed and how many
//     of them several jobs share.
//   - Every existing total keeps its meaning: the `muda_time` measures and
//     the Pareto rows sum the labels as the evaluator wrote them. Each
//     Pareto adds the corrected figures (`stretches.js` `correctStretches`:
//     the part of a `waiting` stretch during which a worker of the job was
//     working is not waiting waste) under their own keys,
//     `waiting_corrected_ms` and `agents_working_unlabeled_ms`, summed as
//     the rows are (each session's time once). The two add up to the
//     `waiting` row.
//   - `search_waste` (milestone 4's organization signal) and the task card's
//     `kind` are not in published facts (`desk.factory.published/1`), so
//     `search_waste` is unavailable for every job (`not_in_published_facts`)
//     and every job's class is `other`.
//   - A job's plugin version is the Desk version all its sessions report:
//     `unknown` when none reports one, `mixed` when they disagree or one
//     reports two. A job with any session that reports no Desk version is
//     `unknown`. Its host is the one host of all its sessions, else `mixed`.
//   - Output is byte-stable: JSON keys are sorted (`stableStringify`), and
//     every list has an explicit order. Pareto rows run largest total first,
//     ties broken by waste name; exclusion reasons and JSON group keys sort by
//     name; tool kinds run most failures first, then most calls, then name.
//     The Markdown page lists plugin versions in version order (a release
//     after its prereleases, `mixed` and `unknown` last).
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { LABEL_CONFIDENCE, LABELS_SCHEMAS, LABEL_WASTES, UNKNOWN_LABEL, checkLabelsAgainstFacts, compareVersions as compareEvaluatorVersions } from "../label-schema.js"
import { covered, retryCoverage, splitSessions } from "./formulas.js"
import { outcomeSections } from "./report.js"
import { AGENTS_WORKING, UNLABELED_CLASS, correctStretches } from "./stretches.js"
import { bindingsOverlap } from "./timeline.js"
import { NUMBER_STATES, fieldsFeeding, withState } from "./number-states.js"
import { reasonText } from "./report.js"
import { compareVersions } from "./versions.js"

export const ROLLUPS_SCHEMA = "desk.factory.rollups/1"

export const JOB_CLASSES = Object.freeze(["engineering", "review", "investigation", "operations", "other"])

const DEFAULT_JOB_CLASS = "other"
// The job classes a store can fill today: published facts do not carry a
// task's kind, so every job is `other`. The kaizen check offers only these.
export const PUBLISHED_JOB_CLASSES = Object.freeze([DEFAULT_JOB_CLASS])
const TERMINAL_STATUSES = new Set(["done", "cancelled"])
const OPEN_JOB = "open_job"
const DESK_PLUGIN = "desk"
const NOT_PUBLISHED = "not_in_published_facts"
const MUDA_MEASURES = Object.freeze(LABEL_WASTES.map((waste) => `muda_time.${waste}`))
// The Pareto's rows: the eight wastes and the evaluator's "could not tell".
const PARETO_WASTES = Object.freeze([...LABEL_WASTES, UNKNOWN_LABEL])

export const MEASURE_IDS = Object.freeze([
  "lead_time",
  "queue_before_start",
  "active_time",
  "flow_efficiency",
  "human_wait",
  "permission_wait",
  "api_retry_wait",
  "tool_failures",
  "tool_retries",
  "api_retries",
  "compactions",
  "retouches",
  "muda_time",
  ...MUDA_MEASURES,
  "search_waste",
])

/** The quality measures andon watches before any flow measure. */
export const QUALITY_MEASURES = Object.freeze(["tool_failures", "tool_retries", "api_retries", "retouches", "muda_time.defects"])

const DURATION_MEASURES = new Set(["lead_time", "queue_before_start", "active_time", "human_wait", "permission_wait", "api_retry_wait", "muda_time", ...MUDA_MEASURES])
const RATIO_MEASURES = new Set(["flow_efficiency"])

// The catalog groupings, and the subset the waste Pareto uses.
const MEASURE_GROUPINGS = Object.freeze(["overall", "plugin_version", "host", "job_class"])
const MUDA_GROUPINGS = Object.freeze(["overall", "job_class", "plugin_version"])
const GROUPING_TITLES = Object.freeze({
  overall: "All jobs",
  plugin_version: "By plugin version",
  host: "By host",
  job_class: "By job class",
})

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

function sortedEntries(map) {
  return [...map.entries()].sort(([left], [right]) => compareText(left, right))
}

/**
 * `quantile(values, p) -> number | null`: the nearest-rank `p` quantile of
 * `values` (see the header), or `null` for an empty list.
 */
export function quantile(values, p) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1]
}

function countReasons(reasons, noun) {
  const counts = new Map()
  for (const reason of reasons) counts.set(reason, (counts.get(reason) ?? 0) + 1)
  return sortedEntries(counts).map(([reason, count]) => ({ reason, [noun]: count }))
}

// The job's own share of a published session, as sorted, merged
// `[start_ms, end_ms]` spans on the session clock: its binding's `segments`
// (Desk writes them for every binding that holds the session's main
// worker; a public desk publishes none). A binding with neither `segments`
// nor `agents` (facts from before either was published) that is the session's only job
// owns the whole session, as the timeline reads it. Anything else (a
// subagent-only binding, or one of several bindings without segments) has
// no known share: `null`, never the whole session.
export function ownShare(session, job) {
  const binding = session.jobs.find((candidate) => candidate.job === job)
  if (!Object.hasOwn(binding, "segments")) {
    return !Object.hasOwn(binding, "agents") && session.jobs.length === 1 ? [[0, session.session.duration_ms]] : null
  }
  return mergeSpans(binding.segments.map((segment) => [segment.start_ms, segment.end_ms]))
}

// Spans sorted and merged where they overlap or touch.
function mergeSpans(spans) {
  const merged = []
  for (const [start, end] of [...spans].sort((left, right) => left[0] - right[0])) {
    const last = merged.at(-1)
    if (last !== undefined && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return merged
}

// The parts of a stretch outside the (merged) spans: the stretch itself when none overlaps it.
function uncovered(stretch, spans) {
  const pieces = []
  let from = stretch.start_ms
  for (const [start, end] of spans) {
    if (end <= from || start >= stretch.end_ms) continue
    if (start > from) pieces.push([from, start])
    from = Math.max(from, end)
  }
  if (from === stretch.start_ms) return [stretch]
  if (from < stretch.end_ms) pieces.push([from, stretch.end_ms])
  return pieces.map(([start, end]) => ({ ...stretch, start_ms: start, end_ms: end }))
}

// The stretches cut to the spans: each keeps its labels on the part inside
// the job's share, split at a gap, and a stretch wholly outside is dropped.
function clipStretches(stretches, spans) {
  return stretches.flatMap((stretch) => spans.flatMap(([start, end]) => {
    const from = Math.max(stretch.start_ms, start)
    const to = Math.min(stretch.end_ms, end)
    return from < to ? [{ ...stretch, start_ms: from, end_ms: to }] : []
  }))
}

/**
 * `resolveLabels(labels, sessions) -> { files, byJobSession, unused }`:
 * matches already-valid labels (`validateLabelsBytes`) with the store's
 * normalized sessions. Labels are used when exactly one facts file holds
 * their session and `checkLabelsAgainstFacts` passes; `byJobSession` maps
 * `<job>/<session id>` to them, cut to the job's own share of the session
 * (an evaluator may label the whole of a session several jobs share, and
 * each job's figures count only its own part). Every other file is counted
 * under one reason: `facts_missing` (the labels declare it), `no_facts`,
 * `facts_ambiguous`, the first cross-check code (a facts file re-derived
 * after the labels merged can leave them `evidence_unmatched`, for example),
 * `share_unknown` when the facts do not say which part of the session
 * was the job's, or `outside_share` when the labels have stretches but none
 * inside the job's share. A stop label that alone fails the cross-check
 * (its wait is no longer a human wait of the facts, or a rule now decides
 * it) is dropped from the used entry's `stops`, and the file is still used:
 * that wait reads not labeled until the evaluator labels it again. Each used entry also carries, not enumerable, its `corrected` stretches (`correctStretches`).
 * `sharedLabels` holds the `<job>/<session id>` keys whose labels come from a shared session (see `sharedLabels`).
 */
export function resolveLabels(labels, sessions) {
  const sessionsById = new Map()
  for (const session of sessions) {
    if (!sessionsById.has(session.session.id)) sessionsById.set(session.session.id, [])
    sessionsById.get(session.session.id).push(session)
  }
  const byJobSession = new Map()
  const reasons = []
  const usedBySession = new Map()
  for (const entry of labels) {
    const matches = sessionsById.get(entry.session) ?? []
    if (entry.unavailable.includes("facts_missing")) reasons.push("facts_missing")
    else if (matches.length === 0) reasons.push("no_facts")
    else if (matches.length > 1) reasons.push("facts_ambiguous")
    else {
      const check = checkLabelsAgainstFacts(entry, matches[0])
      // A stop that no longer matches its facts (labels made before the facts were derived again: its wait moved, or a rule now
      // decides it) is left out on its own; the file's stretches still count when they match.
      const fileErrors = check.errors.filter((error) => !error.path.startsWith("stops."))
      const staleStops = new Set(check.errors.filter((error) => error.path.startsWith("stops.")).map((error) => Number(error.path.split(".")[1])))
      const share = fileErrors.length === 0 ? ownShare(matches[0], entry.job) : null
      const clipped = share === null ? [] : clipStretches(entry.stretches, share)
      if (fileErrors.length > 0) reasons.push(fileErrors[0].code)
      else if (share === null) reasons.push("share_unknown")
      // Stretches, none inside the job's share: the evaluator labeled other jobs' time, which is no reading of this job, never a zero.
      else if (entry.stretches.length > 0 && clipped.length === 0) reasons.push("outside_share")
      else {
        const binding = matches[0].jobs.find((candidate) => candidate.job === entry.job)
        const used = { ...entry, stretches: clipped, ...(Object.hasOwn(entry, "stops") ? { stops: entry.stops.filter((stop, index) => !staleStops.has(index)) } : {}) }
        // The corrected stretches ride along, not enumerable, so every existing total keeps reading the labels as written.
        Object.defineProperty(used, "corrected", { value: correctStretches(clipped, matches[0], binding), enumerable: false })
        byJobSession.set(`${entry.job}/${entry.session}`, used)
        usedBySession.set(entry.session, [...(usedBySession.get(entry.session) ?? []), { entry, used, session: matches[0], binding, whole: clipped.length !== entry.stretches.length || clipped.some((stretch, index) => stretch.start_ms !== entry.stretches[index].start_ms || stretch.end_ms !== entry.stretches[index].end_ms) }])
      }
    }
  }
  return { files: labels.length, byJobSession, unused: countReasons(reasons, "files"), sharedLabels: sharedLabels(usedBySession) }
}

// The `<job>/<session id>` keys whose labels may describe another job's work: the session holds other jobs too, and either this job's
// labels went beyond its own share (the evaluator labeled the whole session, so only the cut keeps other jobs' time out, and what is
// left inside the share was judged without knowing whose it was) or another job's labels for the session are the same stretches. The
// new rollups mark such a job's labeled figures partial (`labels_from_shared_session`); every existing total is unchanged. The test is
// deliberately strict: any cut counts, even a stretch that runs a few milliseconds past the share, so a job that owns its labels can
// read partial, but a shared one never reads whole.
function sharedLabels(usedBySession) {
  const keys = new Set()
  for (const uses of usedBySession.values()) {
    for (const use of uses) {
      if (use.session.jobs.length < 2) continue
      const same = uses.some((other) => other !== use && JSON.stringify(other.entry.stretches) === JSON.stringify(use.entry.stretches))
      if (use.whole || same) keys.add(`${use.entry.job}/${use.entry.session}`)
    }
  }
  return keys
}

const PARTLY = "host_records_partly"

// A formula result as a rollup input: a complete value (`state: "measured"`),
// a lower bound the host records only partly (kept with its state), or the
// reason it is left out.
// A formula result always says its state; a missing or unknown one is a defect upstream, never read as measured.
export function fromFormula(value) {
  if (!NUMBER_STATES.includes(value.state)) throw new Error(`a formula result has no known state: ${String(value.state)}`)
  if (value.state === "unavailable") return { excluded: value.reason }
  if (value.censored) return { excluded: "censored" }
  if (value.state === "partial") return value.reasons.length === 1 && value.reasons[0] === PARTLY ? { value: value.value, state: "partial", reasons: [PARTLY] } : { excluded: "partial" }
  return { value: value.value, state: "measured" }
}

// A job's measure counts only when it is measured; a partial value is kept for the alarm but never counted.
function counted(measure) {
  return measure.state === "measured"
}

// The reason a measure is left out of the count, or `null` when it is counted.
function leftOut(measure) {
  if (counted(measure)) return null
  return "excluded" in measure ? measure.excluded : measure.reasons[0]
}

// How many of `N` jobs supplied a measured value, and what that makes of the whole.
function countState(n, N) {
  if (n === 0) return "unavailable"
  return n === N ? "measured" : "partial"
}

function oneOrMixed(values) {
  const distinct = new Set(values)
  return distinct.size === 1 ? [...distinct][0] : "mixed"
}

/** `pluginVersion(sources) -> version`: the one Desk version every session reports, else `mixed`, or `unknown` when any reports none. */
export function pluginVersion(sources) {
  const perSession = sources.map((session) => {
    const versions = new Set(session.plugins.filter((plugin) => plugin.name === DESK_PLUGIN).map((plugin) => plugin.version))
    if (versions.size === 0) return "unknown"
    return versions.size === 1 ? [...versions][0] : "mixed"
  })
  return perSession.includes("unknown") ? "unknown" : oneOrMixed(perSession)
}

// Each plugin any session reports, with the lowest and highest version
// across every session of the job, or `null` when some session does not
// report it. The kaizen check and andon compare versions with these.
function pluginRanges(sources) {
  const names = [...new Set(sources.flatMap((session) => session.plugins.map((plugin) => plugin.name)))].sort(compareText)
  return Object.fromEntries(names.map((name) => {
    const perSession = sources.map((session) => session.plugins.filter((plugin) => plugin.name === name).map((plugin) => plugin.version))
    if (perSession.some((versions) => versions.length === 0)) return [name, null]
    const versions = perSession.flat().sort(compareVersions)
    return [name, { min: versions[0], max: versions.at(-1) }]
  }))
}

// Compactions are counted with turns, so a session without turns cannot say.
// A session split across jobs cannot say which job's worker compacted, so a job whose sessions are all split
// has none to report (`worker_split`), as for retries.
function compactions(sources, split) {
  const coverage = retryCoverage(sources, ["turns"], split)
  return fromFormula(withState(covered(coverage, () => ({ class: "measured", value: sources.reduce((total, session) => total + (split.has(session) ? 0 : session.counts.compactions), 0) }))))
}

// One labeled session's time per Pareto row, and what each row's labels say about themselves: `confidence[waste]` is the time by
// confidence, or `null` when the file records none; `versions[waste]` the labels' versions. `all_versions` and `recorded` answer for a
// row with no time, which the whole file speaks to. A file records a confidence only when it is `/2` (every `/2` stretch carries one)
// and has a stretch: a file with no stretches recorded nothing, so its rows read as not recorded, never as a sound zero. Its own
// evaluator version still speaks for it.
function sessionWaste(entry) {
  const recorded = entry.schema !== LABELS_SCHEMAS[0] && entry.stretches.length > 0
  const totals = Object.fromEntries(PARETO_WASTES.map((waste) => [waste, 0]))
  const confidence = Object.fromEntries(PARETO_WASTES.map((waste) => [waste, recorded ? Object.fromEntries(LABEL_CONFIDENCE.map((level) => [level, 0])) : null]))
  const versions = Object.fromEntries(PARETO_WASTES.map((waste) => [waste, []]))
  const allVersions = new Set()
  for (const stretch of entry.stretches) {
    const version = stretch.evaluator_version ?? entry.evaluator.plugin_version
    allVersions.add(version)
    if (stretch.class !== "muda" && stretch.class !== UNKNOWN_LABEL) continue
    const duration = stretch.end_ms - stretch.start_ms
    totals[stretch.waste] += duration
    if (!versions[stretch.waste].includes(version)) versions[stretch.waste].push(version)
    if (recorded) confidence[stretch.waste][stretch.confidence] += duration
  }
  if (allVersions.size === 0) allVersions.add(entry.evaluator.plugin_version)
  return { totals, confidence, versions, all_versions: [...allVersions], recorded, can_say_unknown: entry.schema !== LABELS_SCHEMAS[0], ...correctedWaiting(entry.corrected) }
}

// The corrected waiting time of one session's labels and the part the correction moved out of waste.
function correctedWaiting(corrected) {
  const sum = (test) => corrected.filter(test).reduce((total, stretch) => total + stretch.end_ms - stretch.start_ms, 0)
  return {
    waiting_corrected_ms: sum((stretch) => stretch.class === "muda" && stretch.waste === "waiting"),
    agents_working_ms: sum((stretch) => stretch.class === UNLABELED_CLASS && stretch.reason === AGENTS_WORKING),
  }
}

// The job's muda measures, and each labeled session's waste totals for the
// Pareto's per-session sums (`null` unless every session is labeled).
function mudaMeasures(timeline, labelsByJobSession) {
  const labeled = timeline.sessions.flatMap((session, index) => {
    const entry = labelsByJobSession.get(`${timeline.job}/${session.id}`)
    if (entry === undefined) return []
    // The binding's own segments (absent for a legacy or subagent-only binding) say whether another job's time overlaps it.
    const binding = timeline.source_sessions[index].jobs.find((candidate) => candidate.job === timeline.job)
    const summary = { key: `${session.host}/${session.id}`, ...sessionWaste(entry), ...(Object.hasOwn(binding, "segments") ? { segments: binding.segments } : {}) }
    // The labels themselves, for the Pareto's once-per-session sum; kept out of the record's own fields.
    Object.defineProperty(summary, "labels", { value: entry, enumerable: false })
    return [summary]
  })
  if (labeled.length < timeline.sessions.length) {
    const excluded = { excluded: labeled.length === 0 ? "not_labeled" : "partial" }
    return { measures: Object.fromEntries(["muda_time", ...MUDA_MEASURES].map((id) => [id, excluded])), sessions: null }
  }
  const totals = Object.fromEntries(LABEL_WASTES.map((waste) => [waste, labeled.reduce((sum, session) => sum + session.totals[waste], 0)]))
  return {
    measures: {
      muda_time: { value: Object.values(totals).reduce((total, value) => total + value, 0), state: "measured" },
      ...Object.fromEntries(LABEL_WASTES.map((waste) => [`muda_time.${waste}`, { value: totals[waste], state: "measured" }])),
    },
    sessions: labeled,
  }
}

// Finished: a terminal status and a lead time that is not censored.
function finished(formulas) {
  return formulas.status.class !== "unavailable" && TERMINAL_STATUSES.has(formulas.status.value) && formulas.lead_time_ms.censored !== true
}

/**
 * `jobRecord({ timeline, formulas }, labelsByJobSession) -> record`: one
 * job's grouping keys, each plugin's version range (`plugins`), its session
 * ids (`sessions`, which the comparisons group by), whether it is finished, its catalog values (each
 * `{ value, state: "measured" }`, `{ value, state: "partial", reasons }` for a lower bound the host records partly, or `{ excluded: reason }`), and, when it is finished and fully
 * labeled, each session's waste totals (`muda_sessions`) for the Pareto.
 */
export function jobRecord({ timeline, formulas }, labelsByJobSession) {
  const sources = timeline.source_sessions
  const signals = formulas.rework_signals
  const muda = mudaMeasures(timeline, labelsByJobSession)
  const measured = {
    lead_time: fromFormula(formulas.lead_time_ms),
    queue_before_start: fromFormula(formulas.queue_before_start_ms),
    active_time: fromFormula(formulas.active_time_ms),
    flow_efficiency: fromFormula(formulas.flow_efficiency),
    human_wait: fromFormula(formulas.waits.human_wait_ms),
    permission_wait: fromFormula(formulas.waits.permission_wait_ms),
    api_retry_wait: fromFormula(formulas.waits.api_retry_ms),
    tool_failures: fromFormula(signals.tool_failures),
    tool_retries: fromFormula(signals.tool_retries),
    api_retries: fromFormula(signals.api_retries),
    compactions: compactions(sources, splitSessions(timeline)),
    retouches: fromFormula(signals.session_retouches),
    ...muda.measures,
    search_waste: { excluded: NOT_PUBLISHED },
  }
  const done = finished(formulas)
  const measures = done ? measured : Object.fromEntries(MEASURE_IDS.map((id) => [id, { excluded: OPEN_JOB }]))
  return {
    job: timeline.job,
    job_class: DEFAULT_JOB_CLASS,
    plugin_version: pluginVersion(sources),
    plugins: pluginRanges(sources),
    sessions: [...new Set(sources.map((session) => session.session.id))].sort(compareText),
    host: oneOrMixed(sources.map((session) => session.session.host)),
    finished: done,
    measures,
    muda_sessions: done ? muda.sessions : null,
  }
}

// The overall group always exists, so an empty store still says "no job".
function groupRecords(records, grouping) {
  if (grouping === "overall") return [["all", records]]
  const groups = new Map()
  for (const record of records) {
    const key = record[grouping]
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(record)
  }
  return sortedEntries(groups)
}

function measureStats(records, id) {
  const values = records.flatMap((record) => counted(record.measures[id]) ? [record.measures[id].value] : [])
  return {
    jobs_counted: values.length,
    n: values.length,
    N: records.length,
    state: countState(values.length, records.length),
    median: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    jobs_excluded: countReasons(records.flatMap((record) => leftOut(record.measures[id]) ?? []), "jobs"),
  }
}

function measureGroup(records) {
  return { jobs: records.length, jobs_open: records.filter((record) => !record.finished).length, measures: Object.fromEntries(MEASURE_IDS.map((id) => [id, measureStats(records, id)])) }
}

function pareto(records) {
  const labeled = records.filter((record) => counted(record.measures.muda_time))
  const excluded = countReasons(records.flatMap((record) => leftOut(record.measures.muda_time) ?? []), "jobs")
  // Each job's own share of each session: the labels are already cut to it. Where several jobs hold the same time (a `shared`
  // segment), the first job by job ID keeps it, so each session's time counts once.
  const summed = []
  const bindingsPerSession = new Map()
  const covered = new Map()
  const addedBy = new Map() // each summed summary -> the job that added it
  for (const record of [...labeled].sort((left, right) => compareText(left.job, right.job))) {
    for (const session of record.muda_sessions) {
      bindingsPerSession.set(session.key, [...(bindingsPerSession.get(session.key) ?? []), session])
      // A summary that carries no labels (built by hand, not by `jobRecord`) counts as it is.
      if (session.labels === undefined) {
        summed.push(session)
        addedBy.set(session, record.job)
        continue
      }
      const taken = covered.get(session.key) ?? []
      const remaining = session.labels.stretches.flatMap((stretch) => uncovered(stretch, taken))
      covered.set(session.key, mergeSpans([...taken, ...session.labels.stretches.map((stretch) => [stretch.start_ms, stretch.end_ms])]))
      const corrected = session.labels.corrected?.flatMap((stretch) => uncovered(stretch, taken))
      const added = remaining.length === session.labels.stretches.length && remaining.every((piece, index) => piece === session.labels.stretches[index])
        ? session
        : remaining.length > 0 ? sessionWaste({ ...session.labels, stretches: remaining, corrected }) : null
      if (added !== null) {
        summed.push(added)
        addedBy.set(added, record.job)
      }
    }
  }
  const base = {
    jobs: records.length,
    jobs_labeled: labeled.length,
    n: labeled.length,
    N: records.length,
    state: countState(labeled.length, records.length),
    jobs_excluded: excluded,
    sessions_labeled: bindingsPerSession.size,
    sessions_shared: [...bindingsPerSession.values()].filter((bindings) => bindings.some((left, index) => bindings.slice(index + 1).some((right) => bindingsOverlap(left, right)))).length,
  }
  if (labeled.length === 0) return { ...base, muda_time_ms: null, ...correctedFigures(base, []), wastes: [] }
  // Without a `/2` session nothing here could have said "unknown", so that row is left out rather than shown as a zero.
  const rowWastes = summed.some((session) => session.can_say_unknown) ? PARETO_WASTES : LABEL_WASTES
  const sums = Object.fromEntries(rowWastes.map((waste) => [waste, summed.reduce((sum, session) => sum + session.totals[waste], 0)]))
  const mudaTotal = LABEL_WASTES.reduce((sum, waste) => sum + sums[waste], 0)
  // Every row's share is of all labeled waste time, `unknown` included.
  const total = rowWastes.reduce((sum, waste) => sum + sums[waste], 0)
  const rows = rowWastes.map((waste) => {
    // The jobs that add time to the row once each session's time is counted once.
    const jobs = new Set(summed.filter((session) => session.totals[waste] > 0).map((session) => addedBy.get(session))).size
    return { waste, total_ms: sums[waste], jobs, ...rowEvidence(summed, waste, sums[waste]) }
  }).sort((left, right) => right.total_ms - left.total_ms || compareText(left.waste, right.waste))
  let running = 0
  const wastes = rows.map((row) => {
    running += row.total_ms
    return { ...row, share: total === 0 ? null : row.total_ms / total, cumulative_share: total === 0 ? null : running / total }
  })
  return { ...base, muda_time_ms: mudaTotal, ...correctedFigures(base, summed), wastes }
}

// The corrected waiting figures of a Pareto (see the header), with the Pareto's own count and state. No labeled job, or a session summed
// without corrected stretches (built by hand), is no figure (`not_recorded`), never a zero.
function correctedFigures(base, summed) {
  const known = base.n > 0 && summed.every((session) => Object.hasOwn(session, "waiting_corrected_ms"))
  const state = known ? base.state : "unavailable"
  const excluded = base.jobs_excluded.map((entry) => entry.reason)
  const missing = !known && (base.n > 0 || excluded.length === 0) ? ["not_recorded"] : []
  const reasons = state === "measured" ? [] : [...new Set([...excluded, ...missing])].sort(compareText)
  const figure = (key) => assertNamed({ state, ...(known ? { value: summed.reduce((sum, session) => sum + session[key], 0) } : {}), n: base.n, N: base.N, reasons })
  return { waiting_corrected_ms: figure("waiting_corrected_ms"), agents_working_unlabeled_ms: figure("agents_working_ms") }
}

// A Pareto row's `evaluator_versions` and, when every label that speaks to it recorded one, its `confidence_ms` (see the header).
function rowEvidence(summed, waste, totalMs) {
  const speaking = totalMs === 0 ? summed : summed.filter((session) => session.totals[waste] > 0)
  const versions = new Set(speaking.flatMap((session) => (totalMs === 0 ? session.all_versions : session.versions[waste])))
  const recorded = speaking.every((session) => session.recorded)
  const evaluatorVersions = [...versions].sort(compareEvaluatorVersions)
  if (!recorded) return { evaluator_versions: evaluatorVersions }
  // With no time in the row every level is zero; otherwise each speaking session's own split, which adds up to its time in the row.
  const confidence = Object.fromEntries(LABEL_CONFIDENCE.map((level) => [level, totalMs === 0 ? 0 : speaking.reduce((sum, session) => sum + session.confidence[waste][level], 0)]))
  return { evaluator_versions: evaluatorVersions, confidence_ms: confidence }
}

function byGrouping(records, groupings, summarize) {
  return Object.fromEntries(groupings.map((grouping) => [
    grouping,
    Object.fromEntries(groupRecords(records, grouping).map(([key, members]) => [key, summarize(members)])),
  ]))
}

// What one session adds to a fact-level total, read from the table in number-states.js. `fields` are the published fields that feed the number and `count(session)` is the session's own count, or `null` when the session recorded none.
//   - A session with a flag on any feeding field other than `host_records_partly` supplied nothing usable: it is left out of `n` and of the value, and its reasons are listed.
//   - A session with a null count and no such flag is left out the same way, as `field_absent`.
//   - A session flagged only `host_records_partly` supplied a lower bound: it is left out of `n`, so the number is partial, but its count stays in the value.
// `value` is the key absent, never 0 and never null, when no session supplied a count. The state is measured when `n === N`, partial when a value exists and `n < N`, and unavailable when no session supplied a count.
// A rollup number that is not measured always names why; the one place that refuses one that does not.
export function assertNamed(number) {
  if (number.state !== "measured" && number.reasons.length === 0) throw new Error(`a ${number.state} rollup number has no reason`)
  return number
}

// Report-only reason for a total over no sessions; it is not a facts enum value.
const NO_SESSIONS = "no_sessions"

function totalOf(sessions, fields, count) {
  let n = 0
  let supplied = 0
  let value = 0
  const reasons = new Set()
  for (const session of sessions) {
    const flags = session.unavailable.filter((entry) => fields.includes(entry.field))
    const counted = count(session)
    for (const flag of flags) reasons.add(flag.reason)
    if (flags.some((flag) => flag.reason !== PARTLY)) continue
    if (counted === null) {
      reasons.add("field_absent")
      continue
    }
    supplied += 1
    value += counted
    if (flags.length === 0) n += 1
  }
  const state = sessions.length > 0 && n === sessions.length ? "measured" : supplied > 0 ? "partial" : "unavailable"
  if (sessions.length === 0) reasons.add(NO_SESSIONS)
  return assertNamed({ state, ...(supplied > 0 ? { value } : {}), n, N: sessions.length, reasons: state === "measured" ? [] : [...reasons].sort(compareText) })
}

const sumOrNull = (values) => values.some((entry) => entry === null || entry === undefined) ? null : values.reduce((total, entry) => total + entry, 0)
const sumCounts = (counts) => Object.values(counts).reduce((total, entry) => total + entry, 0)
const feeding = (formulaId) => [...fieldsFeeding(formulaId, "unavailable"), ...fieldsFeeding(formulaId, "partial")]
const TOKEN_TYPES = Object.freeze(["input", "output", "cache_read", "cache_write", "reasoning"])

// A session with no model at all, or with a null counter on any model, has no count of that kind.
const modelSum = (session, read) => session.models.length === 0 ? null : sumOrNull(session.models.map(read))

function totalsOf(sessions) {
  const tokens = Object.fromEntries(TOKEN_TYPES.map((type) => [
    type,
    totalOf(sessions, [...feeding("totals.tokens"), ...(type === "reasoning" ? feeding("totals.tokens.reasoning") : [])], (session) => modelSum(session, (model) => model.tokens[type])),
  ]))
  return {
    sessions: { state: "measured", value: sessions.length, n: sessions.length, N: sessions.length, reasons: [] },
    tool_calls: totalOf(sessions, feeding("totals.tool_calls"), (session) => sumCounts(session.counts.tool_calls)),
    tool_failures: totalOf(sessions, feeding("totals.tool_failures"), (session) => sumCounts(session.counts.tool_failures)),
    model_requests: totalOf(sessions, feeding("totals.model_requests"), (session) => modelSum(session, (model) => model.requests)),
    tokens,
    subagent_dispatches: totalOf(sessions, feeding("totals.subagent_dispatches"), (session) => session.agents.filter((agent) => agent.parent !== null).length),
  }
}

function totals(sessions) {
  const hosts = [...new Set(sessions.map((session) => session.session.host))].sort(compareText)
  return {
    schema: ROLLUPS_SCHEMA,
    hosts: Object.fromEntries(hosts.map((host) => [host, totalsOf(sessions.filter((session) => session.session.host === host))])),
    all: totalsOf(sessions),
  }
}

function toolKinds(sessions) {
  const fields = [...feeding("totals.tool_calls"), ...feeding("totals.tool_failures")]
  const totals = new Map()
  for (const session of sessions) {
    const tools = new Set([...Object.keys(session.counts.tool_calls), ...Object.keys(session.counts.tool_failures)])
    for (const tool of tools) {
      const entry = totals.get(tool) ?? { tool, members: [] }
      entry.members.push(session)
      totals.set(tool, entry)
    }
  }
  const rows = [...totals.values()].map(({ tool, members }) => {
    const calls = totalOf(members, fields, (session) => session.counts.tool_calls[tool] ?? 0)
    const failures = totalOf(members, fields, (session) => session.counts.tool_failures[tool] ?? 0)
    // An absent count sorts as 0 below for ordering only; it is never displayed as 0.
    return { tool, ...(calls.value === undefined ? {} : { calls: calls.value, failures: failures.value }), sessions: members.length, state: calls.state, n: calls.n, N: calls.N, reasons: calls.reasons }
  }).sort((left, right) => (right.failures ?? 0) - (left.failures ?? 0) || (right.calls ?? 0) - (left.calls ?? 0) || compareText(left.tool, right.tool))
  return { schema: ROLLUPS_SCHEMA, sessions: sessions.length, tool_kinds: rows }
}

// How many sessions carry each flag, over every session with facts.
function flagCounts(sessions) {
  const counts = new Map()
  for (const session of sessions) {
    for (const flag of new Set(session.unavailable.map((entry) => `${entry.field}\u0000${entry.reason}`))) counts.set(flag, (counts.get(flag) ?? 0) + 1)
  }
  return [...counts.entries()].map(([key, count]) => {
    const [field, reason] = key.split("\u0000")
    return { field, reason, sessions: count, N: sessions.length }
  }).sort((left, right) => compareText(left.field, right.field) || compareText(left.reason, right.reason))
}

function coverage(records, sessions, labels) {
  const unattributed = sessions.filter((session) => session.jobs.length === 0)
  const muda = records.map((record) => record.measures.muda_time)
  return {
    schema: ROLLUPS_SCHEMA,
    jobs: records.length,
    sessions_with_facts: sessions.length,
    bound_sessions: sessions.length - unattributed.length,
    unattributed_sessions: unattributed.length,
    session_time_ms: sessions.reduce((total, session) => total + session.session.duration_ms, 0),
    unattributed_session_time_ms: unattributed.reduce((total, session) => total + session.session.duration_ms, 0),
    labels: {
      files: labels.files,
      used: labels.files - labels.unused.reduce((total, entry) => total + entry.files, 0),
      unused: labels.unused,
      jobs_labeled: muda.filter(counted).length,
      jobs_partially_labeled: muda.filter((value) => value.excluded === "partial").length,
      jobs_unlabeled: muda.filter((value) => value.excluded === "not_labeled").length,
    },
    jobs_open: records.filter((record) => !record.finished).length,
    job_class: { assigned: DEFAULT_JOB_CLASS, reason: NOT_PUBLISHED },
    search_waste: { reason: NOT_PUBLISHED },
    hosts: [...new Set(sessions.map((session) => session.session.host))].sort(compareText).map((host) => ({ host, sessions: sessions.filter((session) => session.session.host === host).length })),
    flagged: flagCounts(sessions),
  }
}

/**
 * `computeRollups({ records, sessions, labels }) -> { measures, muda,
 * tool_kinds, coverage }`: the four rollup documents. `records` come from
 * `jobRecord`, `sessions` are every normalized session with facts, and
 * `labels` is `resolveLabels`' result.
 */
export function computeRollups({ records, sessions, labels }) {
  return {
    measures: {
      schema: ROLLUPS_SCHEMA,
      quantile_method: "nearest_rank",
      quality_measures: QUALITY_MEASURES,
      groupings: byGrouping(records, MEASURE_GROUPINGS, measureGroup),
    },
    muda: {
      schema: ROLLUPS_SCHEMA,
      wastes: PARETO_WASTES,
      groupings: byGrouping(records, MUDA_GROUPINGS, pareto),
    },
    tool_kinds: toolKinds(sessions),
    coverage: coverage(records, sessions, labels),
    totals: totals(sessions),
  }
}

function percentage(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`
}

/** `formatMeasure(id, value) -> string`: a measure's value as the pages print it (`ms` for durations, a percentage for ratios). */
export function formatMeasure(id, value) {
  if (value === null) return "not recorded"
  if (RATIO_MEASURES.has(id)) return percentage(value)
  return DURATION_MEASURES.has(id) ? `${value} ms` : `${value}`
}

function reasonsText(entries, noun, singular) {
  return entries.length === 0 ? "none" : entries.map((entry) => `${reasonText(entry.reason)} (${entry[noun]} ${entry[noun] === 1 ? singular : noun})`).join(", ")
}

// The words for a state; nothing recorded reads "not recorded", never a zero or a blank.
function stateWord(state) {
  return state === "unavailable" ? "not recorded" : state
}

function groupHeading(grouping, key) {
  return grouping === "overall" ? `### ${GROUPING_TITLES.overall}` : `### ${GROUPING_TITLES[grouping]}: ${key}`
}

// Every session speaks for itself with at least its file's evaluator version, so a row always lists one.
function paretoLines(summary) {
  const counted = `${summary.jobs_labeled} of ${summary.jobs} jobs fully labeled; excluded: ${reasonsText(summary.jobs_excluded, "jobs", "job")}.`
  if (summary.muda_time_ms === null) return [`No fully labeled finished job yet (${stateWord(summary.state)}): ${counted}`]
  return [
    `Muda time: ${summary.muda_time_ms} ms (${stateWord(summary.state)}) across ${counted} Sessions summed: ${summary.sessions_labeled}, each session's time once; shared by several jobs: ${summary.sessions_shared}.`,
    "",
    "| Waste | Time | Share | Cumulative | Jobs | Confidence (high / medium / low) | Evaluator versions |",
    "| --- | ---: | ---: | ---: | ---: | --- | --- |",
    ...summary.wastes.map((row) => `| ${row.waste} | ${row.total_ms} ms | ${percentage(row.share)} | ${percentage(row.cumulative_share)} | ${row.jobs} | ${confidenceText(row)} | ${row.evaluator_versions.join(", ")} |`),
  ]
}

// A row's time by confidence, or "not recorded" when a label that speaks to it recorded none: never a zero for missing data.
function confidenceText(row) {
  return Object.hasOwn(row, "confidence_ms") ? `${row.confidence_ms.high} / ${row.confidence_ms.medium} / ${row.confidence_ms.low} ms` : "not recorded"
}

function measureLines(summary, quality) {
  return [
    `Jobs: ${summary.jobs}; open, and so left out of every measure: ${summary.jobs_open}.`,
    "",
    "| Measure | State | Jobs counted (n of N) | Median | p75 | Excluded |",
    "| --- | --- | ---: | ---: | ---: | --- |",
    ...MEASURE_IDS.map((id) => {
      const stats = summary.measures[id]
      const name = [id === "compactions" ? "compactions (count)" : id, ...(quality.has(id) ? ["(quality)"] : [])].join(" ")
      return `| ${name} | ${stateWord(stats.state)} | ${stats.n} of ${stats.N} | ${formatMeasure(id, stats.median)} | ${formatMeasure(id, stats.p75)} | ${reasonsText(stats.jobs_excluded, "jobs", "job")} |`
    }),
  ]
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+)\.(\d+))?$/u

// Version order for the page: numeric parts, a release after its
// prereleases, then anything that is not a version (`mixed`, `unknown`) by name.
// Numeric parts, then a release after its prereleases, then the prerelease tag and number.
function versionKey(match) {
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] === undefined ? 1 : 0, match[4] ?? "", Number(match[5] ?? 0)]
}

function compareGroupKeys(left, right) {
  const a = VERSION.exec(left)
  const b = VERSION.exec(right)
  if (a === null || b === null) return (a === null) - (b === null) || compareText(left, right)
  const keyB = versionKey(b)
  return versionKey(a).reduce((order, part, index) => order || (typeof part === "string" ? compareText(part, keyB[index]) : part - keyB[index]), 0)
}

function groupSections(groupings, render) {
  return Object.entries(groupings).flatMap(([grouping, groups]) =>
    Object.entries(groups).sort(([left], [right]) => grouping === "plugin_version" ? compareGroupKeys(left, right) : compareText(left, right)).flatMap(([key, summary]) => [groupHeading(grouping, key), "", ...render(summary), ""]))
}

/** `renderRollupsMarkdown(rollups) -> string`: `rollups/index.md`. */
export function renderRollupsMarkdown(rollups) {
  const quality = new Set(rollups.measures.quality_measures)
  const cover = rollups.coverage
  const noJobs = cover.jobs === 0
  const tools = rollups.tool_kinds.tool_kinds
  return [
    "# Factory rollups",
    "",
    "Totals and distributions across jobs, grouped by plugin version, host, job class and waste type; tool kinds are summed per session. They name no person, machine, date or time of day.",
    "",
    "Only finished jobs count: every measure of a job that is not done or cancelled, or whose lead time is censored, is excluded because the job is not finished. Only complete values count: a measure a finished job could not supply, or could supply only for some sessions, is excluded and listed with its reason, never counted as zero. Jobs counted reads n of N: the jobs whose value counted, of all jobs in the group, open ones included. Compactions (count) is how many compactions happened, which every host records; compaction wait time is a different number and is recorded only where the host records it. Every group has a state: measured when n equals N, partial when some jobs counted, and not recorded when none did, in which case there is no median. A value the host records only partly is a lower bound, so it is left out of n and listed under its reason. Medians and p75 use the nearest-rank method: the value at rank ceil(p × n) of the counted values sorted ascending.",
    "",
    "## Waste by type",
    "",
    "Muda time from the independent evaluator's labels, largest first; ties are broken by waste name. A job counts only when it is finished and every one of its sessions is labeled. Each job counts only its own part of a session, and where several jobs hold the same time, a total counts it once. The unknown row, once any label could say it, is time the evaluator looked at and could not tell: it is not counted in muda time, but each row's share is of all labeled waste time, unknown included. Confidence is the time in the row by how sure the evaluator was; it reads not recorded when a label that speaks to the row is from an evaluator that recorded none. Evaluator versions are the versions of those labels.",
    "",
    ...groupSections(rollups.muda.groupings, paretoLines),
    "## Measures",
    "",
    "Quality measures, which andon watches first, are marked (quality).",
    "",
    ...(noJobs ? ["No job has published facts yet.", ""] : groupSections(rollups.measures.groupings, (summary) => measureLines(summary, quality))),
    "## Tool kinds",
    "",
    `Calls and failures summed over ${cover.sessions_with_facts} sessions with facts, each session counted once; most failures first.`,
    "",
    ...(tools.length === 0
      ? ["- None."]
      : [
          "| Tool kind | State | Calls | Failures | Sessions counted (n of N) | Why not whole |",
          "| --- | --- | ---: | ---: | ---: | --- |",
          ...tools.map((row) => `| ${row.tool} | ${stateWord(row.state)} | ${row.calls ?? "not recorded"} | ${row.failures ?? "not recorded"} | ${row.n} of ${row.N} | ${row.reasons.length === 0 ? "none" : row.reasons.map(reasonText).join(" and ")} |`),
        ]),
    "",
    ...outcomeSections(rollups.outcomes),
    "## Coverage",
    "",
    `- Jobs: ${cover.jobs}; open: ${cover.jobs_open}.`,
    `- Unattributed sessions: ${cover.unattributed_sessions} of ${cover.sessions_with_facts} (${cover.unattributed_session_time_ms} ms of ${cover.session_time_ms} ms session time).`,
    `- Jobs fully labeled: ${cover.labels.jobs_labeled}; partially labeled: ${cover.labels.jobs_partially_labeled}; unlabeled: ${cover.labels.jobs_unlabeled}.`,
    `- Labels files: ${cover.labels.files}; used: ${cover.labels.used}; unused: ${reasonsText(cover.labels.unused, "files", "file")}.`,
    `- Job class: every job is ${cover.job_class.assigned}; published facts do not carry the task card's kind.`,
    "- Search waste: unavailable; published facts do not carry the organization signal.",
    "",
  ].join("\n")
}
