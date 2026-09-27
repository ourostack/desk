// Factory rollups: which waste costs the most across jobs, and how the
// measure catalog moves between plugin versions. No who, no when: jobs are
// grouped only by plugin version, host, job class and waste type (tool kinds
// are summed per session), never by contributor, and nothing here reads or
// writes a date or a time of day.
//
// Rules:
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
//   - `search_waste` (milestone 4's organization signal) and the task card's
//     `kind` are not in published facts (`desk.factory.published/1`), so
//     `search_waste` is unavailable for every job (`not_in_published_facts`)
//     and every job's class is `other`.
//   - A job's plugin version is the Desk version all its sessions report:
//     `unknown` when none reports one, `mixed` when they disagree or one
//     reports two. Its host is the one host of all its sessions, else `mixed`.
//   - Output is byte-stable: JSON keys are sorted (`stableStringify`), and
//     every list has an explicit order. Pareto rows run largest total first,
//     ties broken by waste name; exclusion reasons and group keys sort by
//     name; tool kinds run most failures first, then most calls, then name.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { LABEL_WASTES, checkLabelsAgainstFacts } from "../label-schema.js"
import { covered, fieldCoverage } from "./formulas.js"

export const ROLLUPS_SCHEMA = "desk.factory.rollups/1"

export const JOB_CLASSES = Object.freeze(["engineering", "review", "investigation", "operations", "other"])

const DEFAULT_JOB_CLASS = "other"
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
  for (const session of sessions) sessionsById.set(session.session.id, [...(sessionsById.get(session.session.id) ?? []), session])
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
  return oneOrMixed(sources.map((session) => {
    const versions = new Set(session.plugins.filter((plugin) => plugin.name === DESK_PLUGIN).map((plugin) => plugin.version))
    if (versions.size === 0) return "unknown"
    return versions.size === 1 ? [...versions][0] : "mixed"
  }))
}

// Compactions are counted with turns, so a session without turns cannot say.
function compactions(sources) {
  const coverage = fieldCoverage(sources, ["turns"])
  return fromFormula(covered(coverage, () => ({ class: "measured", value: sources.reduce((total, session) => total + session.counts.compactions, 0) })))
}

function mudaMeasures(timeline, labelsByJobSession) {
  const labeled = timeline.sessions
    .map((session) => labelsByJobSession.get(`${timeline.job}/${session.id}`))
    .filter((entry) => entry !== undefined)
  if (labeled.length < timeline.sessions.length) {
    const excluded = { excluded: labeled.length === 0 ? "not_labeled" : "partial" }
    return Object.fromEntries(["muda_time", ...MUDA_MEASURES].map((id) => [id, excluded]))
  }
  const totals = Object.fromEntries(LABEL_WASTES.map((waste) => [waste, 0]))
  for (const entry of labeled) {
    for (const stretch of entry.stretches) {
      if (stretch.class === "muda") totals[stretch.waste] += stretch.end_ms - stretch.start_ms
    }
  }
  return {
    muda_time: { value: Object.values(totals).reduce((total, value) => total + value, 0) },
    ...Object.fromEntries(LABEL_WASTES.map((waste) => [`muda_time.${waste}`, { value: totals[waste] }])),
  }
}

/**
 * `jobRecord({ timeline, formulas }, labelsByJobSession) -> record`: one
 * job's grouping keys and its catalog values, each `{ value }` or
 * `{ excluded: reason }`.
 */
export function jobRecord({ timeline, formulas }, labelsByJobSession) {
  const sources = timeline.source_sessions
  const signals = formulas.rework_signals
  const measures = {
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
    compactions: compactions(sources),
    retouches: fromFormula(signals.session_retouches),
    ...mudaMeasures(timeline, labelsByJobSession),
    search_waste: { excluded: NOT_PUBLISHED },
  }
  return {
    job: timeline.job,
    job_class: DEFAULT_JOB_CLASS,
    plugin_version: pluginVersion(sources),
    host: oneOrMixed(sources.map((session) => session.session.host)),
    measures,
  }
}

// The overall group always exists, so an empty store still says "no job".
function groupRecords(records, grouping) {
  if (grouping === "overall") return [["all", records]]
  const groups = new Map()
  for (const record of records) {
    const key = record[grouping]
    groups.set(key, [...(groups.get(key) ?? []), record])
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
  return { jobs: records.length, measures: Object.fromEntries(MEASURE_IDS.map((id) => [id, measureStats(records, id)])) }
}

function pareto(records) {
  const labeled = records.filter((record) => "value" in record.measures.muda_time)
  const excluded = countReasons(records.flatMap((record) => "excluded" in record.measures.muda_time ? [record.measures.muda_time.excluded] : []), "jobs")
  const base = { jobs: records.length, jobs_labeled: labeled.length, jobs_excluded: excluded }
  if (labeled.length === 0) return { ...base, muda_time_ms: null, wastes: [] }
  const total = labeled.reduce((sum, record) => sum + record.measures.muda_time.value, 0)
  const rows = LABEL_WASTES.map((waste) => {
    const values = labeled.map((record) => record.measures[`muda_time.${waste}`].value)
    return { waste, total_ms: values.reduce((sum, value) => sum + value, 0), jobs: values.filter((value) => value > 0).length }
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
      jobs_unlabeled: muda.filter((value) => "excluded" in value && value.excluded !== "partial").length,
    },
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

function measureValue(id, value) {
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
  if (summary.muda_time_ms === null) return [`No fully labeled job yet: ${counted}`]
  return [
    `Muda time: ${summary.muda_time_ms} ms across ${counted}`,
    "",
    "| Waste | Muda time | Share | Cumulative | Jobs |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...summary.wastes.map((row) => `| ${row.waste} | ${row.total_ms} ms | ${percentage(row.share)} | ${percentage(row.cumulative_share)} | ${row.jobs} |`),
  ]
}

function measureLines(summary, quality) {
  return [
    `Jobs: ${summary.jobs}.`,
    "",
    "| Measure | Jobs counted | Median | p75 | Excluded |",
    "| --- | ---: | ---: | ---: | --- |",
    ...MEASURE_IDS.map((id) => {
      const stats = summary.measures[id]
      const name = quality.has(id) ? `${id} (quality)` : id
      return `| ${name} | ${stats.jobs_counted} | ${measureValue(id, stats.median)} | ${measureValue(id, stats.p75)} | ${reasonsText(stats.jobs_excluded, "jobs")} |`
    }),
  ]
}

function groupSections(groupings, render) {
  return Object.entries(groupings).flatMap(([grouping, groups]) =>
    Object.entries(groups).sort(([left], [right]) => compareText(left, right)).flatMap(([key, summary]) => [groupHeading(grouping, key), "", ...render(summary), ""]))
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
    "Only complete values count: a measure a job could not supply, could supply only for some sessions (partial), or cannot have yet (censored, an open job) is excluded and listed with its reason, never counted as zero. Medians and p75 use the nearest-rank method: the value at rank ceil(p × n) of the counted values sorted ascending.",
    "",
    "## Waste by type",
    "",
    "Muda time from the independent evaluator's labels, largest first; ties are broken by waste name. A job counts only when every one of its sessions is labeled.",
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
    `- Jobs: ${cover.jobs}.`,
    `- Unattributed sessions: ${cover.unattributed_sessions} of ${cover.sessions_with_facts} (${cover.unattributed_session_time_ms} ms of ${cover.session_time_ms} ms session time).`,
    `- Jobs fully labeled: ${cover.labels.jobs_labeled}; partially labeled: ${cover.labels.jobs_partially_labeled}; unlabeled: ${cover.labels.jobs_unlabeled}.`,
    `- Labels files: ${cover.labels.files}; used: ${cover.labels.used}; unused: ${reasonsText(cover.labels.unused, "files")}.`,
    `- Job class: every job is ${cover.job_class.assigned}; published facts do not carry the task card's kind.`,
    "- Search waste: unavailable; published facts do not carry the organization signal.",
    "",
  ].join("\n")
}
