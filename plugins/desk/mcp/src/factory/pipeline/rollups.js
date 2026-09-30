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
//     efficiency). Every group reports how many jobs each measure counted and
//     why the rest were excluded; a measure no job supplies has no median, not
//     a zero.
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
//   - In the waste Pareto, each session's labeled waste counts once in any
//     one total, even when the session is bound to several jobs: the labels of
//     the first such job by job ID are used. Each Pareto reports how many
//     labeled sessions it summed and how many of them several jobs share.
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

import { LABEL_WASTES, checkLabelsAgainstFacts } from "../label-schema.js"
import { covered, fieldCoverage, splitSessions } from "./formulas.js"
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

/**
 * `resolveLabels(labels, sessions) -> { files, byJobSession, unused }`:
 * matches already-valid labels (`validateLabelsBytes`) with the store's
 * normalized sessions. Labels are used when exactly one facts file holds
 * their session and `checkLabelsAgainstFacts` passes; `byJobSession` maps
 * `<job>/<session id>` to them. Every other file is counted under one reason:
 * `facts_missing` (the labels declare it), `no_facts`, `facts_ambiguous`, or
 * the first cross-check code (a facts file re-derived after the labels
 * merged can leave them `evidence_unmatched`, for example).
 */
export function resolveLabels(labels, sessions) {
  const sessionsById = new Map()
  for (const session of sessions) {
    if (!sessionsById.has(session.session.id)) sessionsById.set(session.session.id, [])
    sessionsById.get(session.session.id).push(session)
  }
  const byJobSession = new Map()
  const reasons = []
  for (const entry of labels) {
    const matches = sessionsById.get(entry.session) ?? []
    if (entry.unavailable.includes("facts_missing")) reasons.push("facts_missing")
    else if (matches.length === 0) reasons.push("no_facts")
    else if (matches.length > 1) reasons.push("facts_ambiguous")
    else {
      const check = checkLabelsAgainstFacts(entry, matches[0])
      if (check.ok) byJobSession.set(`${entry.job}/${entry.session}`, entry)
      else reasons.push(check.errors[0].code)
    }
  }
  return { files: labels.length, byJobSession, unused: countReasons(reasons, "files") }
}

// A formula value as a rollup input: a complete value, or the reason it is left out.
function fromFormula(value) {
  if (value.class === "unavailable") return { excluded: value.reason }
  if (value.censored) return { excluded: "censored" }
  if (value.partial) return { excluded: "partial" }
  return { value: value.value }
}

function oneOrMixed(values) {
  const distinct = new Set(values)
  return distinct.size === 1 ? [...distinct][0] : "mixed"
}

function pluginVersion(sources) {
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
// A session split across jobs cannot say which job's worker compacted.
function compactions(sources, split) {
  const coverage = fieldCoverage(sources, ["turns"], [], split)
  return fromFormula(covered(coverage, () => ({ class: "measured", value: sources.reduce((total, session) => total + (split.has(session) ? 0 : session.counts.compactions), 0) })))
}

function wasteTotals(stretches) {
  const totals = Object.fromEntries(LABEL_WASTES.map((waste) => [waste, 0]))
  for (const stretch of stretches) {
    if (stretch.class === "muda") totals[stretch.waste] += stretch.end_ms - stretch.start_ms
  }
  return totals
}

// The job's muda measures, and each labeled session's waste totals for the
// Pareto's per-session sums (`null` unless every session is labeled).
function mudaMeasures(timeline, labelsByJobSession) {
  const labeled = timeline.sessions.flatMap((session) => {
    const entry = labelsByJobSession.get(`${timeline.job}/${session.id}`)
    return entry === undefined ? [] : [{ key: `${session.host}/${session.id}`, totals: wasteTotals(entry.stretches) }]
  })
  if (labeled.length < timeline.sessions.length) {
    const excluded = { excluded: labeled.length === 0 ? "not_labeled" : "partial" }
    return { measures: Object.fromEntries(["muda_time", ...MUDA_MEASURES].map((id) => [id, excluded])), sessions: null }
  }
  const totals = Object.fromEntries(LABEL_WASTES.map((waste) => [waste, labeled.reduce((sum, session) => sum + session.totals[waste], 0)]))
  return {
    measures: {
      muda_time: { value: Object.values(totals).reduce((total, value) => total + value, 0) },
      ...Object.fromEntries(LABEL_WASTES.map((waste) => [`muda_time.${waste}`, { value: totals[waste] }])),
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
 * `{ value }` or `{ excluded: reason }`), and, when it is finished and fully
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
  const values = records.flatMap((record) => "value" in record.measures[id] ? [record.measures[id].value] : [])
  return {
    jobs_counted: values.length,
    median: quantile(values, 0.5),
    p75: quantile(values, 0.75),
    jobs_excluded: countReasons(records.flatMap((record) => "excluded" in record.measures[id] ? [record.measures[id].excluded] : []), "jobs"),
  }
}

function measureGroup(records) {
  return { jobs: records.length, jobs_open: records.filter((record) => !record.finished).length, measures: Object.fromEntries(MEASURE_IDS.map((id) => [id, measureStats(records, id)])) }
}

function pareto(records) {
  const labeled = records.filter((record) => "value" in record.measures.muda_time)
  const excluded = countReasons(records.flatMap((record) => "excluded" in record.measures.muda_time ? [record.measures.muda_time.excluded] : []), "jobs")
  // Each session once: the first labeled job by job ID supplies its totals.
  const sessions = new Map()
  const jobsPerSession = new Map()
  for (const record of [...labeled].sort((left, right) => compareText(left.job, right.job))) {
    for (const session of record.muda_sessions) {
      if (!sessions.has(session.key)) sessions.set(session.key, session.totals)
      jobsPerSession.set(session.key, (jobsPerSession.get(session.key) ?? 0) + 1)
    }
  }
  const base = {
    jobs: records.length,
    jobs_labeled: labeled.length,
    jobs_excluded: excluded,
    sessions_labeled: sessions.size,
    sessions_shared: [...jobsPerSession.values()].filter((count) => count > 1).length,
  }
  if (labeled.length === 0) return { ...base, muda_time_ms: null, wastes: [] }
  const sums = Object.fromEntries(LABEL_WASTES.map((waste) => [waste, [...sessions.values()].reduce((sum, totals) => sum + totals[waste], 0)]))
  const total = Object.values(sums).reduce((sum, value) => sum + value, 0)
  const rows = LABEL_WASTES.map((waste) => {
    const values = labeled.map((record) => record.measures[`muda_time.${waste}`].value)
    return { waste, total_ms: sums[waste], jobs: values.filter((value) => value > 0).length }
  }).sort((left, right) => right.total_ms - left.total_ms || compareText(left.waste, right.waste))
  let running = 0
  const wastes = rows.map((row) => {
    running += row.total_ms
    return { ...row, share: total === 0 ? null : row.total_ms / total, cumulative_share: total === 0 ? null : running / total }
  })
  return { ...base, muda_time_ms: total, wastes }
}

function byGrouping(records, groupings, summarize) {
  return Object.fromEntries(groupings.map((grouping) => [
    grouping,
    Object.fromEntries(groupRecords(records, grouping).map(([key, members]) => [key, summarize(members)])),
  ]))
}

function toolKinds(sessions) {
  const totals = new Map()
  for (const session of sessions) {
    const tools = new Set([...Object.keys(session.counts.tool_calls), ...Object.keys(session.counts.tool_failures)])
    for (const tool of tools) {
      const entry = totals.get(tool) ?? { tool, calls: 0, failures: 0, sessions: 0 }
      entry.calls += session.counts.tool_calls[tool] ?? 0
      entry.failures += session.counts.tool_failures[tool] ?? 0
      entry.sessions += 1
      totals.set(tool, entry)
    }
  }
  const rows = [...totals.values()].sort((left, right) => right.failures - left.failures || right.calls - left.calls || compareText(left.tool, right.tool))
  return { schema: ROLLUPS_SCHEMA, sessions: sessions.length, tool_kinds: rows }
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
      jobs_labeled: muda.filter((value) => "value" in value).length,
      jobs_partially_labeled: muda.filter((value) => value.excluded === "partial").length,
      jobs_unlabeled: muda.filter((value) => value.excluded === "not_labeled").length,
    },
    jobs_open: records.filter((record) => !record.finished).length,
    job_class: { assigned: DEFAULT_JOB_CLASS, reason: NOT_PUBLISHED },
    search_waste: { reason: NOT_PUBLISHED },
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
      wastes: LABEL_WASTES,
      groupings: byGrouping(records, MUDA_GROUPINGS, pareto),
    },
    tool_kinds: toolKinds(sessions),
    coverage: coverage(records, sessions, labels),
  }
}

function percentage(value) {
  return value === null ? "n/a" : `${(value * 100).toFixed(2)}%`
}

/** `formatMeasure(id, value) -> string`: a measure's value as the pages print it (`ms` for durations, a percentage for ratios). */
export function formatMeasure(id, value) {
  if (value === null) return "unavailable"
  if (RATIO_MEASURES.has(id)) return percentage(value)
  return DURATION_MEASURES.has(id) ? `${value} ms` : `${value}`
}

function reasonsText(entries, noun) {
  return entries.length === 0 ? "none" : entries.map((entry) => `${entry.reason} ${entry[noun]}`).join(", ")
}

function groupHeading(grouping, key) {
  return grouping === "overall" ? `### ${GROUPING_TITLES.overall}` : `### ${GROUPING_TITLES[grouping]}: ${key}`
}

function paretoLines(summary) {
  const counted = `${summary.jobs_labeled} of ${summary.jobs} jobs fully labeled; excluded: ${reasonsText(summary.jobs_excluded, "jobs")}.`
  if (summary.muda_time_ms === null) return [`No fully labeled finished job yet: ${counted}`]
  return [
    `Muda time: ${summary.muda_time_ms} ms across ${counted} Sessions summed: ${summary.sessions_labeled}, each once; shared by several jobs: ${summary.sessions_shared}.`,
    "",
    "| Waste | Muda time | Share | Cumulative | Jobs |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...summary.wastes.map((row) => `| ${row.waste} | ${row.total_ms} ms | ${percentage(row.share)} | ${percentage(row.cumulative_share)} | ${row.jobs} |`),
  ]
}

function measureLines(summary, quality) {
  return [
    `Jobs: ${summary.jobs}; open, and so left out of every measure: ${summary.jobs_open}.`,
    "",
    "| Measure | Jobs counted | Median | p75 | Excluded |",
    "| --- | ---: | ---: | ---: | --- |",
    ...MEASURE_IDS.map((id) => {
      const stats = summary.measures[id]
      const name = quality.has(id) ? `${id} (quality)` : id
      return `| ${name} | ${stats.jobs_counted} | ${formatMeasure(id, stats.median)} | ${formatMeasure(id, stats.p75)} | ${reasonsText(stats.jobs_excluded, "jobs")} |`
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
    "Only finished jobs count: every measure of a job that is not done or cancelled, or whose lead time is censored, is excluded as open_job. Only complete values count: a measure a finished job could not supply, or could supply only for some sessions (partial), is excluded and listed with its reason, never counted as zero. Medians and p75 use the nearest-rank method: the value at rank ceil(p × n) of the counted values sorted ascending.",
    "",
    "## Waste by type",
    "",
    "Muda time from the independent evaluator's labels, largest first; ties are broken by waste name. A job counts only when it is finished and every one of its sessions is labeled. Each session's waste counts once in a total, even when several jobs share the session.",
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
          "| Tool kind | Calls | Failures | Sessions |",
          "| --- | ---: | ---: | ---: |",
          ...tools.map((row) => `| ${row.tool} | ${row.calls} | ${row.failures} | ${row.sessions} |`),
        ]),
    "",
    "## Coverage",
    "",
    `- Jobs: ${cover.jobs}; open: ${cover.jobs_open}.`,
    `- Unattributed sessions: ${cover.unattributed_sessions} of ${cover.sessions_with_facts} (${cover.unattributed_session_time_ms} ms of ${cover.session_time_ms} ms session time).`,
    `- Jobs fully labeled: ${cover.labels.jobs_labeled}; partially labeled: ${cover.labels.jobs_partially_labeled}; unlabeled: ${cover.labels.jobs_unlabeled}.`,
    `- Labels files: ${cover.labels.files}; used: ${cover.labels.used}; unused: ${reasonsText(cover.labels.unused, "files")}.`,
    `- Job class: every job is ${cover.job_class.assigned}; published facts do not carry the task card's kind.`,
    "- Search waste: unavailable; published facts do not carry the organization signal.",
    "",
  ].join("\n")
}
