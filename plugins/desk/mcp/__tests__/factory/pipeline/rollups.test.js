import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../src/factory/pipeline/formulas.js"
import { normalizePublished, stableStringify } from "../../../src/factory/pipeline/normalize.js"
import {
  JOB_CLASSES,
  MEASURE_IDS,
  QUALITY_MEASURES,
  computeRollups,
  jobRecord,
  quantile,
  renderRollupsMarkdown,
  resolveLabels,
} from "../../../src/factory/pipeline/rollups.js"
import { buildTimelines } from "../../../src/factory/pipeline/timeline.js"
import { LABEL_WASTES } from "../../../src/factory/label-schema.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(here, "..", "fixtures", "rollup-store")
const J = (digit) => digit.repeat(32)
const S = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`

function readJsonDir(directory) {
  return readdirSync(directory).sort().map((name) => JSON.parse(readFileSync(path.join(directory, name), "utf8")))
}

function fixtureSessions() {
  return readJsonDir(path.join(STORE, "facts")).map(normalizePublished)
}

function fixtureLabels() {
  const root = path.join(STORE, "labels")
  return readdirSync(root).sort().flatMap((job) => readJsonDir(path.join(root, job)))
}

function fixtureRollups() {
  const sessions = fixtureSessions()
  const labels = resolveLabels(fixtureLabels(), sessions)
  const records = buildTimelines(sessions).map((timeline) => jobRecord({ timeline, formulas: calculateFormulas(timeline) }, labels.byJobSession))
  return { sessions, labels, records, rollups: computeRollups({ records, sessions, labels }) }
}

// A synthetic finished job; a job with muda values gets one labeled session of its own.
function record(job, overrides = {}) {
  const measures = { ...Object.fromEntries(MEASURE_IDS.map((id) => [id, { excluded: "not_in_fixture" }])), ...overrides.measures }
  const labeled = "value" in measures.muda_time
  const mudaSessions = labeled ? [{ key: `claude-code/${job}`, totals: Object.fromEntries(LABEL_WASTES.map((waste) => [waste, measures[`muda_time.${waste}`].value])) }] : null
  return { job, job_class: "other", plugin_version: "3.2.0", host: "claude-code", finished: true, muda_sessions: mudaSessions, ...overrides, measures }
}

test("the measure catalog is the brief's, with one muda measure per classic waste and andon's quality measures", () => {
  assert.deepEqual(MEASURE_IDS, [
    "lead_time", "queue_before_start", "active_time", "flow_efficiency", "human_wait", "permission_wait", "api_retry_wait",
    "tool_failures", "tool_retries", "api_retries", "compactions", "retouches", "muda_time",
    ...LABEL_WASTES.map((waste) => `muda_time.${waste}`),
    "search_waste",
  ])
  assert.deepEqual(QUALITY_MEASURES, ["tool_failures", "tool_retries", "api_retries", "retouches", "muda_time.defects"])
  assert.deepEqual(JOB_CLASSES, ["engineering", "review", "investigation", "operations", "other"])
})

test("quantile uses the nearest-rank method on sorted values and has no value for an empty list", () => {
  assert.equal(quantile([], 0.5), null)
  assert.equal(quantile([7], 0.5), 7)
  assert.equal(quantile([7], 0.75), 7)
  // Rank ceil(p * n), 1-based, on values sorted ascending; input order is irrelevant.
  assert.equal(quantile([40, 10, 30, 20], 0.5), 20)
  assert.equal(quantile([40, 10, 30, 20], 0.75), 30)
  assert.equal(quantile([5, 1, 4, 2, 3], 0.5), 3)
  assert.equal(quantile([5, 1, 4, 2, 3], 0.75), 4)
  assert.equal(quantile([3, 1, 2], 1), 3)
  assert.equal(quantile([3, 1, 2], 0), 1)
  const values = [9, 1, 5]
  quantile(values, 0.5)
  assert.deepEqual(values, [9, 1, 5], "the caller's list is not reordered")
})

test("resolveLabels uses labels that still match their facts and counts every other file by reason", () => {
  const sessions = fixtureSessions()
  const labels = resolveLabels(fixtureLabels(), sessions)
  assert.equal(labels.files, 9)
  assert.deepEqual([...labels.byJobSession.keys()].sort(), [
    `${J("1")}/${S(1)}`, `${J("2")}/${S(2)}`, `${J("3")}/${S(3)}`, `${J("3")}/${S(4)}`, `${J("5")}/${S(6)}`, `${J("6")}/${S(8)}`, `${J("6")}/${S(9)}`,
  ])
  assert.deepEqual(labels.unused, [{ reason: "evidence_unmatched", files: 1 }, { reason: "facts_missing", files: 1 }])

  const stale = fixtureLabels().find((entry) => entry.session === S(1))
  const orphan = { ...stale, session: S(99), job: J("9") }
  const unbound = { ...stale, job: J("8") }
  const declaredMissing = { ...stale, stretches: [], unavailable: ["facts_missing"] }
  const twice = [...sessions, { ...sessions.find((session) => session.session.id === S(1)), session: { ...sessions[0].session, host: "copilot-cli", id: S(1) } }]
  assert.deepEqual(resolveLabels([orphan, unbound, declaredMissing], sessions).unused, [
    { reason: "facts_missing", files: 1 },
    { reason: "job_unbound", files: 1 },
    { reason: "no_facts", files: 1 },
  ])
  assert.deepEqual(resolveLabels([stale], twice).unused, [{ reason: "facts_ambiguous", files: 1 }])
  assert.equal(resolveLabels([], sessions).byJobSession.size, 0)
})

test("jobRecord takes each measure from the formulas, excludes censored, partial and unavailable values, and sums labeled muda", () => {
  const { records } = fixtureRollups()
  const byJob = Object.fromEntries(records.map((entry) => [entry.job, entry]))
  assert.deepEqual(Object.keys(byJob), [J("1"), J("2"), J("3"), J("4"), J("5"), J("6")])

  const one = byJob[J("1")]
  assert.equal(one.job_class, "other")
  assert.equal(one.plugin_version, "3.1.0")
  assert.equal(one.host, "claude-code")
  assert.deepEqual(one.measures.lead_time, { value: 10000 })
  assert.deepEqual(one.measures.queue_before_start, { value: 0 })
  assert.deepEqual(one.measures.active_time, { value: 8000 })
  assert.deepEqual(one.measures.flow_efficiency, { value: 0.8 })
  assert.deepEqual(one.measures.human_wait, { value: 2000 })
  assert.deepEqual(one.measures.permission_wait, { excluded: "host_does_not_record" })
  assert.deepEqual(one.measures.api_retry_wait, { value: 0 })
  assert.deepEqual(one.measures.tool_failures, { value: 1 })
  assert.deepEqual(one.measures.tool_retries, { value: 1 })
  assert.deepEqual(one.measures.api_retries, { value: 0 })
  assert.deepEqual(one.measures.compactions, { value: 0 })
  assert.deepEqual(one.measures.retouches, { value: 0 })
  assert.deepEqual(one.measures.muda_time, { value: 4000 })
  assert.deepEqual(one.measures["muda_time.waiting"], { value: 2000 })
  assert.deepEqual(one.measures["muda_time.defects"], { value: 2000 })
  assert.deepEqual(one.measures["muda_time.motion"], { value: 0 }, "a labeled job's absent waste is a measured zero")
  assert.deepEqual(one.measures.search_waste, { excluded: "not_in_published_facts" })

  const three = byJob[J("3")]
  assert.deepEqual(three.measures.compactions, { value: 1 })
  assert.deepEqual(three.measures.retouches, { value: 1 })
  assert.deepEqual(three.measures.muda_time, { value: 4000 })

  // Job 4 is still processing: every measure is left out, not only the censored ones.
  const open = byJob[J("4")]
  assert.equal(open.finished, false)
  assert.equal(open.muda_sessions, null)
  for (const id of MEASURE_IDS) assert.deepEqual(open.measures[id], { excluded: "open_job" }, id)
  assert.equal(one.finished, true)
  assert.deepEqual(one.muda_sessions, [{ key: `claude-code/${S(1)}`, totals: { ...Object.fromEntries(LABEL_WASTES.map((waste) => [waste, 0])), waiting: 2000, defects: 2000 } }])

  const cancelled = byJob[J("5")]
  assert.equal(cancelled.finished, true, "a cancelled job is finished")
  assert.deepEqual(cancelled.measures.lead_time, { excluded: "cancelled" })
  assert.deepEqual(cancelled.measures.active_time, { value: 8000 })
  assert.deepEqual(cancelled.measures.muda_time, { excluded: "partial" })
  assert.deepEqual(cancelled.measures["muda_time.overproduction"], { excluded: "partial" })

  const mixed = byJob[J("6")]
  assert.equal(mixed.plugin_version, "mixed")
  assert.equal(mixed.host, "mixed")
  assert.deepEqual(mixed.measures.human_wait, { excluded: "partial" })
  assert.deepEqual(mixed.measures.muda_time, { value: 1000 })
})

test("jobRecord leaves out every measure of a job reopened after done, and of one with no status", () => {
  const sessions = fixtureSessions().filter((session) => session.session.id === S(1))
  const reopened = sessions.map((session) => ({ ...session, jobs: session.jobs.map((job) => ({ ...job, transitions: [...job.transitions, { to: "processing", offset_ms: 12000 }] })) }))
  const [timeline] = buildTimelines(reopened)
  const entry = jobRecord({ timeline, formulas: calculateFormulas(timeline) }, new Map())
  assert.equal(entry.finished, false)
  assert.deepEqual(entry.measures.tool_failures, { excluded: "open_job" })
  const silent = sessions.map((session) => ({ ...session, jobs: session.jobs.map((job) => ({ ...job, transitions: [], observed: null })) }))
  const [none] = buildTimelines(silent)
  assert.equal(jobRecord({ timeline: none, formulas: calculateFormulas(none) }, new Map()).finished, false)
})

test("jobRecord marks a job with no Desk plugin entry as unknown and one whose sessions report two versions as mixed", () => {
  const sessions = fixtureSessions()
  const plain = sessions.filter((session) => session.session.id === S(1)).map((session) => ({ ...session, plugins: [{ name: "plain-language", version: "1.0.0" }] }))
  const [timeline] = buildTimelines(plain)
  assert.equal(jobRecord({ timeline, formulas: calculateFormulas(timeline) }, new Map()).plugin_version, "unknown")
  const twice = sessions.filter((session) => session.session.id === S(1)).map((session) => ({ ...session, plugins: [{ name: "desk", version: "3.2.0" }, { name: "desk", version: "3.2.1" }] }))
  const [both] = buildTimelines(twice)
  assert.equal(jobRecord({ timeline: both, formulas: calculateFormulas(both) }, new Map()).plugin_version, "mixed")
  // A session without a Desk version makes the job unknown, not mixed, even beside a known one.
  const three = fixtureSessions().filter((session) => session.session.id === S(3) || session.session.id === S(4))
  const oneUnknown = [three[0], { ...three[1], plugins: [] }]
  const [partlyKnown] = buildTimelines(oneUnknown)
  assert.equal(jobRecord({ timeline: partlyKnown, formulas: calculateFormulas(partlyKnown) }, new Map()).plugin_version, "unknown")
})

test("jobRecord gives each plugin's lowest and highest version across the job's sessions, or null when a session lacks it", () => {
  const sessions = fixtureSessions()
  const one = sessions.filter((session) => session.session.id === S(1))
  const [plain] = buildTimelines(one)
  assert.deepEqual(jobRecord({ timeline: plain, formulas: calculateFormulas(plain) }, new Map()).plugins, { desk: { min: "3.1.0", max: "3.1.0" } })
  assert.deepEqual(jobRecord({ timeline: plain, formulas: calculateFormulas(plain) }, new Map()).sessions, [S(1)])
  const pair = sessions.filter((session) => session.session.id === S(3) || session.session.id === S(4))
  const spread = [
    { ...pair[0], plugins: [{ name: "desk", version: "3.2.0-alpha.10" }, { name: "desk", version: "3.2.0-alpha.9" }, { name: "plain-language", version: "1.0.0" }] },
    { ...pair[1], plugins: [{ name: "desk", version: "3.2.0" }] },
  ]
  const [timeline] = buildTimelines(spread)
  assert.deepEqual(jobRecord({ timeline, formulas: calculateFormulas(timeline) }, new Map()).plugins, {
    desk: { min: "3.2.0-alpha.9", max: "3.2.0" },
    "plain-language": null,
  })
  assert.deepEqual(jobRecord({ timeline, formulas: calculateFormulas(timeline) }, new Map()).sessions, [S(3), S(4)].sort(), "each session id once, sorted")
})

test("jobRecord leaves compactions unavailable when no session records turns, and excludes them as partial when some do not", () => {
  const sessions = fixtureSessions().filter((session) => session.session.id === S(3) || session.session.id === S(4))
  const noTurns = (session) => ({ ...session, unavailable: [...session.unavailable, { field: "turns", reason: "log_truncated" }] })
  const [all] = buildTimelines(sessions.map(noTurns))
  assert.deepEqual(jobRecord({ timeline: all, formulas: calculateFormulas(all) }, new Map()).measures.compactions, { excluded: "log_truncated" })
  const [some] = buildTimelines([noTurns(sessions[0]), sessions[1]])
  assert.deepEqual(jobRecord({ timeline: some, formulas: calculateFormulas(some) }, new Map()).measures.compactions, { excluded: "partial" })
})

test("the measure rollups report median, p75 and counted jobs per group, and list each exclusion reason", () => {
  const { rollups } = fixtureRollups()
  const overall = rollups.measures.groupings.overall.all
  assert.equal(overall.jobs, 6)
  assert.equal(overall.jobs_open, 1)
  // Done jobs 1, 2, 3 and 6: lead times 10000, 25000, 18000, 10000.
  assert.deepEqual(overall.measures.lead_time, {
    jobs_counted: 4,
    median: 10000,
    p75: 18000,
    jobs_excluded: [{ reason: "cancelled", jobs: 1 }, { reason: "open_job", jobs: 1 }],
  })
  // Open job 4 is out of every measure, including running totals such as active time.
  assert.deepEqual(overall.measures.active_time, { jobs_counted: 5, median: 8000, p75: 12000, jobs_excluded: [{ reason: "open_job", jobs: 1 }] })
  // Flow efficiencies 0.8, 0.68, 12000/18000 and 0.7.
  assert.equal(overall.measures.flow_efficiency.median, 0.68)
  assert.equal(overall.measures.flow_efficiency.p75, 0.7)
  assert.deepEqual(overall.measures.search_waste, { jobs_counted: 0, median: null, p75: null, jobs_excluded: [{ reason: "not_in_published_facts", jobs: 5 }, { reason: "open_job", jobs: 1 }] })
  assert.deepEqual(overall.measures.muda_time, {
    jobs_counted: 4,
    median: 4000,
    p75: 4000,
    jobs_excluded: [{ reason: "open_job", jobs: 1 }, { reason: "partial", jobs: 1 }],
  })

  const versions = rollups.measures.groupings.plugin_version
  assert.deepEqual(Object.keys(versions), ["3.1.0", "3.1.1", "mixed"])
  assert.equal(versions["3.1.0"].jobs, 2)
  assert.deepEqual(versions["3.1.0"].measures.lead_time, { jobs_counted: 2, median: 10000, p75: 25000, jobs_excluded: [] })
  assert.equal(versions["3.1.1"].jobs, 3)
  assert.equal(versions["3.1.1"].jobs_open, 1)
  assert.equal(versions["3.1.1"].measures.tool_failures.jobs_counted, 2)
  assert.deepEqual(Object.keys(rollups.measures.groupings.host), ["claude-code", "copilot-cli", "mixed"])
  assert.deepEqual(Object.keys(rollups.measures.groupings.job_class), ["other"])
  assert.deepEqual(rollups.measures.quality_measures, QUALITY_MEASURES)
  assert.equal(rollups.measures.quantile_method, "nearest_rank")
})

test("the muda Pareto sums labeled waste largest first, breaks ties by waste name, and is unavailable without a fully labeled job", () => {
  const { rollups } = fixtureRollups()
  const overall = rollups.muda.groupings.overall.all
  assert.equal(overall.jobs, 6)
  assert.equal(overall.jobs_labeled, 4)
  assert.deepEqual(overall.jobs_excluded, [{ reason: "open_job", jobs: 1 }, { reason: "partial", jobs: 1 }])
  assert.equal(overall.sessions_labeled, 6)
  assert.equal(overall.sessions_shared, 0)
  assert.equal(overall.muda_time_ms, 14000)
  assert.deepEqual(overall.wastes.slice(0, 4), [
    { waste: "waiting", total_ms: 8000, share: 8000 / 14000, cumulative_share: 8000 / 14000, jobs: 4 },
    { waste: "defects", total_ms: 4000, share: 4000 / 14000, cumulative_share: 12000 / 14000, jobs: 2 },
    { waste: "extra_processing", total_ms: 2000, share: 2000 / 14000, cumulative_share: 1, jobs: 1 },
    { waste: "inventory", total_ms: 0, share: 0, cumulative_share: 1, jobs: 0 },
  ])
  assert.deepEqual(overall.wastes.map((entry) => entry.waste), ["waiting", "defects", "extra_processing", "inventory", "motion", "non_utilized_talent", "overproduction", "transportation"])

  const versions = rollups.muda.groupings.plugin_version
  // 3.1.0: waiting 5000, then defects and extra_processing tie at 2000.
  assert.deepEqual(versions["3.1.0"].wastes.slice(0, 3).map((entry) => [entry.waste, entry.total_ms]), [["waiting", 5000], ["defects", 2000], ["extra_processing", 2000]])
  // 3.1.1: only job 3 is fully labeled; defects and waiting tie at 2000.
  assert.equal(versions["3.1.1"].jobs_labeled, 1)
  assert.deepEqual(versions["3.1.1"].wastes.slice(0, 2).map((entry) => [entry.waste, entry.total_ms]), [["defects", 2000], ["waiting", 2000]])
  assert.deepEqual(Object.keys(rollups.muda.groupings.job_class), ["other"])
  assert.equal(rollups.muda.groupings.host, undefined)

  const unlabeled = computeRollups({ records: [record(J("a"))], sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } })
  assert.deepEqual(unlabeled.muda.groupings.overall.all, { jobs: 1, jobs_labeled: 0, jobs_excluded: [{ reason: "not_in_fixture", jobs: 1 }], sessions_labeled: 0, sessions_shared: 0, muda_time_ms: null, wastes: [] })
})

test("a session bound to several jobs counts its labeled waste once in every Pareto total", () => {
  // Session 1 is bound to job 1 and to a second job, and labeled identically for both.
  const sessions = fixtureSessions()
  const shared = sessions.map((session) => session.session.id !== S(1) ? session : {
    ...session,
    jobs: [...session.jobs, { ...session.jobs[0], job: J("8") }],
  })
  const labels = fixtureLabels()
  const twin = { ...labels.find((entry) => entry.session === S(1)), job: J("8") }
  const resolved = resolveLabels([...labels, twin], shared)
  const records = buildTimelines(shared).map((timeline) => jobRecord({ timeline, formulas: calculateFormulas(timeline) }, resolved.byJobSession))
  const rollups = computeRollups({ records, sessions: shared, labels: resolved })
  const overall = rollups.muda.groupings.overall.all
  assert.equal(overall.jobs_labeled, 5)
  assert.equal(overall.sessions_labeled, 6)
  assert.equal(overall.sessions_shared, 1)
  assert.equal(overall.muda_time_ms, 14000, "session 1's 4000 ms counts once, not twice")
  assert.deepEqual(overall.wastes.slice(0, 2).map((entry) => [entry.waste, entry.total_ms, entry.jobs]), [["waiting", 8000, 5], ["defects", 4000, 3]])
  // Per-job measures still give each job the whole session, as active time does.
  assert.equal(rollups.measures.groupings.overall.all.measures.muda_time.jobs_counted, 5)
  assert.match(renderRollupsMarkdown(rollups), /Sessions summed: 6, each once; shared by several jobs: 1\./u)
})

test("a Pareto whose labeled jobs carry no muda has no shares, not zero shares", () => {
  const zeros = Object.fromEntries(["muda_time", ...LABEL_WASTES.map((waste) => `muda_time.${waste}`)].map((id) => [id, { value: 0 }]))
  const rollups = computeRollups({ records: [record(J("a"), { measures: zeros })], sessions: [], labels: { files: 1, byJobSession: new Map(), unused: [] } })
  const pareto = rollups.muda.groupings.overall.all
  assert.equal(pareto.muda_time_ms, 0)
  assert.deepEqual(pareto.wastes[0], { waste: "defects", total_ms: 0, share: null, cumulative_share: null, jobs: 0 })
  assert.match(renderRollupsMarkdown(rollups), /\| defects \| 0 ms \| n\/a \| n\/a \| 0 \|/u)
})

test("rollups group by job class, and the order of the records never changes the bytes", () => {
  const muda = (waste, ms) => ({ muda_time: { value: ms }, ...Object.fromEntries(LABEL_WASTES.map((name) => [`muda_time.${name}`, { value: name === waste ? ms : 0 }])) })
  const records = [
    record(J("a"), { job_class: "engineering", measures: { lead_time: { value: 100 }, ...muda("defects", 30) } }),
    record(J("b"), { job_class: "review", measures: { lead_time: { value: 300 }, ...muda("waiting", 50) } }),
    record(J("c"), { job_class: "engineering", measures: { lead_time: { value: 200 }, ...muda("waiting", 10) } }),
    record(J("d"), { job_class: "other", measures: { lead_time: { excluded: "partial" } } }),
  ]
  const labels = { files: 3, byJobSession: new Map(), unused: [] }
  const rollups = computeRollups({ records, sessions: [], labels })
  assert.deepEqual(Object.keys(rollups.measures.groupings.job_class), ["engineering", "other", "review"])
  assert.deepEqual(rollups.measures.groupings.job_class.engineering.measures.lead_time, { jobs_counted: 2, median: 100, p75: 200, jobs_excluded: [] })
  assert.deepEqual(rollups.measures.groupings.job_class.other.measures.lead_time, { jobs_counted: 0, median: null, p75: null, jobs_excluded: [{ reason: "partial", jobs: 1 }] })
  assert.deepEqual(rollups.muda.groupings.job_class.engineering.wastes.slice(0, 2).map((entry) => [entry.waste, entry.total_ms]), [["defects", 30], ["waiting", 10]])

  const reversed = computeRollups({ records: [...records].reverse(), sessions: [], labels })
  for (const key of ["measures", "muda", "tool_kinds", "coverage"]) assert.equal(stableStringify(reversed[key]), stableStringify(rollups[key]), key)
  assert.equal(renderRollupsMarkdown(reversed), renderRollupsMarkdown(rollups))
})

test("the fixture's rollups keep their bytes when sessions, labels and records arrive in any order", () => {
  const { rollups } = fixtureRollups()
  const sessions = fixtureSessions().reverse()
  const labels = resolveLabels(fixtureLabels().reverse(), sessions)
  const records = buildTimelines(sessions).map((timeline) => jobRecord({ timeline, formulas: calculateFormulas(timeline) }, labels.byJobSession)).reverse()
  const shuffled = computeRollups({ records, sessions, labels })
  for (const key of ["measures", "muda", "tool_kinds", "coverage"]) assert.equal(stableStringify(shuffled[key]), stableStringify(rollups[key]), key)
  assert.equal(renderRollupsMarkdown(shuffled), renderRollupsMarkdown(rollups))
})

test("the page lists plugin versions in version order, a release after its prereleases, then mixed and unknown", () => {
  const versions = ["unknown", "3.1.0-alpha.100", "3.2.0", "mixed", "3.1.0-alpha.70", "3.10.0", "3.2.0-beta.1", "3.9.0"]
  const labels = { files: 0, byJobSession: new Map(), unused: [] }
  const text = renderRollupsMarkdown(computeRollups({ records: versions.map((version, index) => record(String(index).repeat(32), { plugin_version: version })), sessions: [], labels }))
  const order = [...text.matchAll(/^### By plugin version: (.+)$/gmu)].map((match) => match[1])
  const expected = ["3.1.0-alpha.70", "3.1.0-alpha.100", "3.2.0-beta.1", "3.2.0", "3.9.0", "3.10.0", "mixed", "unknown"]
  assert.deepEqual(order, [...expected, ...expected], "the Pareto and the catalog both use version order")
})

test("tool-kind rollups count each session once, largest failure count first, ties by tool name", () => {
  const { rollups } = fixtureRollups()
  assert.equal(rollups.tool_kinds.sessions, 10)
  assert.deepEqual(rollups.tool_kinds.tool_kinds, [
    { tool: "shell", calls: 4, failures: 2, sessions: 2 },
    { tool: "edit", calls: 3, failures: 1, sessions: 1 },
    { tool: "search", calls: 2, failures: 1, sessions: 2 },
    { tool: "read", calls: 1, failures: 0, sessions: 1 },
  ])
  // Failures without a recorded call still count, with zero calls.
  const [first] = fixtureSessions()
  const failuresOnly = { ...first, counts: { ...first.counts, tool_calls: {}, tool_failures: { web: 2 } } }
  const failuresOnlyRollups = computeRollups({ records: [], sessions: [failuresOnly], labels: { files: 0, byJobSession: new Map(), unused: [] } })
  assert.deepEqual(failuresOnlyRollups.tool_kinds.tool_kinds, [{ tool: "web", calls: 0, failures: 2, sessions: 1 }])
})

test("coverage counts unattributed sessions and time, label use, and the two signals published facts do not carry", () => {
  const { rollups } = fixtureRollups()
  assert.deepEqual(rollups.coverage, {
    schema: "desk.factory.rollups/1",
    jobs: 6,
    sessions_with_facts: 10,
    bound_sessions: 9,
    unattributed_sessions: 1,
    session_time_ms: 70000,
    unattributed_session_time_ms: 3000,
    jobs_open: 1,
    labels: {
      files: 9,
      used: 7,
      unused: [{ reason: "evidence_unmatched", files: 1 }, { reason: "facts_missing", files: 1 }],
      jobs_labeled: 4,
      jobs_partially_labeled: 1,
      jobs_unlabeled: 0,
    },
    job_class: { assigned: "other", reason: "not_in_published_facts" },
    search_waste: { reason: "not_in_published_facts" },
  })
})

test("the rollups Markdown shows the Pareto, the catalog per group, tool kinds and coverage, and never a zero for a missing measure", () => {
  const { rollups } = fixtureRollups()
  const text = renderRollupsMarkdown(rollups)
  assert.match(text, /^# Factory rollups\n/u)
  assert.match(text, /nearest-rank/u)
  assert.match(text, /\| waiting \| 8000 ms \| 57\.14% \| 57\.14% \| 4 \|/u)
  assert.match(text, /\| lead_time \| 4 \| 10000 ms \| 18000 ms \| cancelled 1, open_job 1 \|/u)
  assert.match(text, /Jobs: 6; open, and so left out of every measure: 1\./u)
  assert.match(text, /\| flow_efficiency \| 4 \| 68\.00% \| 70\.00% \|/u)
  assert.match(text, /\| search_waste \| 0 \| unavailable \| unavailable \| not_in_published_facts 5, open_job 1 \|/u)
  assert.match(text, /\| tool_failures \(quality\) \|/u)
  assert.match(text, /### By plugin version: 3\.1\.0/u)
  assert.match(text, /### By host: mixed/u)
  assert.match(text, /### By job class: other/u)
  assert.match(text, /\| shell \| 4 \| 2 \| 2 \|/u)
  assert.match(text, /- Unattributed sessions: 1 of 10 \(3000 ms of 70000 ms session time\)\./u)
  assert.match(text, /- Job class: every job is other; published facts do not carry the task card's kind\./u)
  assert.doesNotMatch(text, /\| search_waste \| 0 \| 0/u)

  const empty = computeRollups({ records: [], sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } })
  const emptyText = renderRollupsMarkdown(empty)
  assert.match(emptyText, /No job has published facts yet\./u)
  assert.match(emptyText, /No fully labeled finished job yet/u)
  assert.doesNotMatch(emptyText, /\bNaN\b|undefined|null/u)
})
