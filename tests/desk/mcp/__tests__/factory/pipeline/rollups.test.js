import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { normalizePublished, stableStringify } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import {
  JOB_CLASSES,
  MEASURE_IDS,
  assertNamed,
  fromFormula,
  QUALITY_MEASURES,
  computeRollups,
  jobRecord,
  quantile,
  renderRollupsMarkdown,
  resolveLabels,
} from "../../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"
import { buildTimelines } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"
import { ENUMS } from "../../../../../../plugins/desk/mcp/src/factory/schema.js"
import { LABEL_WASTES } from "../../../../../../plugins/desk/mcp/src/factory/label-schema.js"

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
  const measures = { ...Object.fromEntries(MEASURE_IDS.map((id) => [id, { excluded: "not_in_published_facts" }])), ...overrides.measures }
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
  assert.deepEqual(one.measures.lead_time, { value: 10000, state: "measured" })
  assert.deepEqual(one.measures.queue_before_start, { value: 0, state: "measured" })
  assert.deepEqual(one.measures.active_time, { value: 8000, state: "measured" })
  assert.deepEqual(one.measures.flow_efficiency, { value: 0.8, state: "measured" })
  assert.deepEqual(one.measures.human_wait, { value: 2000, state: "measured" })
  assert.deepEqual(one.measures.permission_wait, { excluded: "host_does_not_record" })
  assert.deepEqual(one.measures.api_retry_wait, { value: 0, state: "partial", reasons: ["host_records_partly"] })
  assert.deepEqual(one.measures.tool_failures, { value: 1, state: "measured" })
  assert.deepEqual(one.measures.tool_retries, { value: 1, state: "measured" })
  assert.deepEqual(one.measures.api_retries, { value: 0, state: "partial", reasons: ["host_records_partly"] }, "a lower bound the host records partly keeps its value and its state")
  assert.deepEqual(one.measures.compactions, { value: 0, state: "measured" })
  assert.deepEqual(one.measures.retouches, { value: 0, state: "measured" })
  assert.deepEqual(one.measures.muda_time, { value: 4000, state: "measured" })
  assert.deepEqual(one.measures["muda_time.waiting"], { value: 2000, state: "measured" })
  assert.deepEqual(one.measures["muda_time.defects"], { value: 2000, state: "measured" })
  assert.deepEqual(one.measures["muda_time.motion"], { value: 0, state: "measured" }, "a labeled job's absent waste is a measured zero")
  assert.deepEqual(one.measures.search_waste, { excluded: "not_in_published_facts" })

  const three = byJob[J("3")]
  assert.deepEqual(three.measures.compactions, { value: 1, state: "measured" })
  assert.deepEqual(three.measures.retouches, { value: 1, state: "measured" })
  assert.deepEqual(three.measures.muda_time, { value: 4000, state: "measured" })

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
  assert.deepEqual(cancelled.measures.active_time, { value: 8000, state: "measured" })
  assert.deepEqual(cancelled.measures.muda_time, { excluded: "partial" })
  assert.deepEqual(cancelled.measures["muda_time.overproduction"], { excluded: "partial" })

  const mixed = byJob[J("6")]
  assert.equal(mixed.plugin_version, "mixed")
  assert.equal(mixed.host, "mixed")
  assert.deepEqual(mixed.measures.human_wait, { excluded: "partial" })
  assert.deepEqual(mixed.measures.muda_time, { value: 1000, state: "measured" })
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

test("jobRecord excludes compactions of a session split across jobs as partial, and a covering binding counts them", () => {
  const sessions = fixtureSessions().filter((session) => session.session.id === S(3) || session.session.id === S(4))
  const workers = [...sessions[0].agents, { n: 1, parent: 0, model: sessions[0].agents[0].model }]
  const bound = (agents) => ({ ...sessions[0], agents: workers, jobs: sessions[0].jobs.map((binding) => ({ ...binding, agents })) })
  const record = (list) => {
    const [timeline] = buildTimelines(list)
    return jobRecord({ timeline, formulas: calculateFormulas(timeline) }, new Map()).measures.compactions
  }
  assert.deepEqual(record([bound([0]), sessions[1]]), { excluded: "partial" })
  assert.deepEqual(record([bound([0, 1]), sessions[1]]), record(sessions))
  const second = { ...sessions[1], agents: [...sessions[1].agents, { n: 1, parent: 0, model: sessions[1].agents[0].model }] }
  const split = (session, extra = {}) => ({ ...second, ...extra, jobs: second.jobs.map((binding) => ({ ...binding, agents: [0] })) })
  assert.deepEqual(record([bound([0]), split(second)]), { excluded: "worker_split" }, "a job whose sessions are all split has no compactions to report, and never a zero")
  const noTurns = { ...bound([0]), unavailable: [...sessions[0].unavailable, { field: "turns", reason: "log_truncated" }] }
  assert.deepEqual(record([noTurns, split(second)]), { excluded: "mixed" }, "an all-split job that also lacks turns names both reasons")
})

test("the measure rollups report median, p75 and counted jobs per group, and list each exclusion reason", () => {
  const { rollups } = fixtureRollups()
  const overall = rollups.measures.groupings.overall.all
  assert.equal(overall.jobs, 6)
  assert.equal(overall.jobs_open, 1)
  // Done jobs 1, 2, 3 and 6: lead times 10000, 25000, 18000, 10000.
  assert.deepEqual(overall.measures.lead_time, {
    jobs_counted: 4,
    n: 4,
    N: 6,
    state: "partial",
    median: 10000,
    p75: 18000,
    jobs_excluded: [{ reason: "cancelled", jobs: 1 }, { reason: "open_job", jobs: 1 }],
  })
  // Open job 4 is out of every measure, including running totals such as active time.
  assert.deepEqual(overall.measures.active_time, { jobs_counted: 5, n: 5, N: 6, state: "partial", median: 8000, p75: 12000, jobs_excluded: [{ reason: "open_job", jobs: 1 }] })
  // Flow efficiencies 0.8, 0.68, 12000/18000 and 0.7.
  assert.equal(overall.measures.flow_efficiency.median, 0.68)
  assert.equal(overall.measures.flow_efficiency.p75, 0.7)
  assert.deepEqual(overall.measures.search_waste, { jobs_counted: 0, n: 0, N: 6, state: "unavailable", median: null, p75: null, jobs_excluded: [{ reason: "not_in_published_facts", jobs: 5 }, { reason: "open_job", jobs: 1 }] })
  assert.deepEqual(overall.measures.muda_time, {
    jobs_counted: 4,
    n: 4,
    N: 6,
    state: "partial",
    median: 4000,
    p75: 4000,
    jobs_excluded: [{ reason: "open_job", jobs: 1 }, { reason: "partial", jobs: 1 }],
  })

  const versions = rollups.measures.groupings.plugin_version
  assert.deepEqual(Object.keys(versions), ["3.1.0", "3.1.1", "mixed"])
  assert.equal(versions["3.1.0"].jobs, 2)
  assert.deepEqual(versions["3.1.0"].measures.lead_time, { jobs_counted: 2, n: 2, N: 2, state: "measured", median: 10000, p75: 25000, jobs_excluded: [] })
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
  assert.deepEqual(unlabeled.muda.groupings.overall.all, { jobs: 1, jobs_labeled: 0, n: 0, N: 1, state: "unavailable", jobs_excluded: [{ reason: "not_in_published_facts", jobs: 1 }], sessions_labeled: 0, sessions_shared: 0, muda_time_ms: null, wastes: [] })
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
  const zeros = Object.fromEntries(["muda_time", ...LABEL_WASTES.map((waste) => `muda_time.${waste}`)].map((id) => [id, { value: 0, state: "measured" }]))
  const rollups = computeRollups({ records: [record(J("a"), { measures: zeros })], sessions: [], labels: { files: 1, byJobSession: new Map(), unused: [] } })
  const pareto = rollups.muda.groupings.overall.all
  assert.equal(pareto.muda_time_ms, 0)
  assert.deepEqual(pareto.wastes[0], { waste: "defects", total_ms: 0, share: null, cumulative_share: null, jobs: 0 })
  assert.match(renderRollupsMarkdown(rollups), /\| defects \| 0 ms \| n\/a \| n\/a \| 0 \|/u)
})

test("rollups group by job class, and the order of the records never changes the bytes", () => {
  const muda = (waste, ms) => ({ muda_time: { value: ms, state: "measured" }, ...Object.fromEntries(LABEL_WASTES.map((name) => [`muda_time.${name}`, { value: name === waste ? ms : 0, state: "measured" }])) })
  const records = [
    record(J("a"), { job_class: "engineering", measures: { lead_time: { value: 100, state: "measured" }, ...muda("defects", 30) } }),
    record(J("b"), { job_class: "review", measures: { lead_time: { value: 300, state: "measured" }, ...muda("waiting", 50) } }),
    record(J("c"), { job_class: "engineering", measures: { lead_time: { value: 200, state: "measured" }, ...muda("waiting", 10) } }),
    record(J("d"), { job_class: "other", measures: { lead_time: { excluded: "partial" } } }),
  ]
  const labels = { files: 3, byJobSession: new Map(), unused: [] }
  const rollups = computeRollups({ records, sessions: [], labels })
  assert.deepEqual(Object.keys(rollups.measures.groupings.job_class), ["engineering", "other", "review"])
  assert.deepEqual(rollups.measures.groupings.job_class.engineering.measures.lead_time, { jobs_counted: 2, n: 2, N: 2, state: "measured", median: 100, p75: 200, jobs_excluded: [] })
  assert.deepEqual(rollups.measures.groupings.job_class.other.measures.lead_time, { jobs_counted: 0, n: 0, N: 1, state: "unavailable", median: null, p75: null, jobs_excluded: [{ reason: "partial", jobs: 1 }] })
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
    { tool: "shell", calls: 4, failures: 2, sessions: 2, state: "measured", n: 2, N: 2, reasons: [] },
    { tool: "edit", calls: 3, failures: 1, sessions: 1, state: "measured", n: 1, N: 1, reasons: [] },
    { tool: "search", calls: 2, failures: 1, sessions: 2, state: "measured", n: 2, N: 2, reasons: [] },
    { tool: "read", calls: 1, failures: 0, sessions: 1, state: "measured", n: 1, N: 1, reasons: [] },
  ])
  // Failures without a recorded call still count, with zero calls.
  const [first] = fixtureSessions()
  const failuresOnly = { ...first, counts: { ...first.counts, tool_calls: {}, tool_failures: { web: 2 } } }
  const failuresOnlyRollups = computeRollups({ records: [], sessions: [failuresOnly], labels: { files: 0, byJobSession: new Map(), unused: [] } })
  assert.deepEqual(failuresOnlyRollups.tool_kinds.tool_kinds, [{ tool: "web", calls: 0, failures: 2, sessions: 1, state: "measured", n: 1, N: 1, reasons: [] }])
})

test("coverage counts unattributed sessions and time, label use, and the two signals published facts do not carry", () => {
  const { rollups } = fixtureRollups()
  assert.deepEqual(rollups.coverage, {
    schema: "desk.factory.rollups/1",
    jobs: 6,
    hosts: [{ host: "claude-code", sessions: 5 }, { host: "copilot-cli", sessions: 5 }],
    flagged: [
      { field: "api_retries", reason: "host_records_partly", sessions: 5, N: 10 },
      { field: "commits", reason: "host_does_not_record", sessions: 5, N: 10 },
      { field: "compaction_waits", reason: "host_does_not_record", sessions: 5, N: 10 },
      { field: "entrypoint", reason: "host_does_not_record", sessions: 5, N: 10 },
      { field: "human_waits", reason: "host_does_not_record", sessions: 5, N: 10 },
      { field: "models", reason: "field_absent", sessions: 10, N: 10 },
      { field: "permission_waits", reason: "host_does_not_record", sessions: 5, N: 10 },
      { field: "prs", reason: "host_records_partly", sessions: 10, N: 10 },
      { field: "reasoning_tokens", reason: "host_does_not_record", sessions: 5, N: 10 },
      { field: "requests", reason: "field_absent", sessions: 10, N: 10 },
      { field: "tokens", reason: "field_absent", sessions: 10, N: 10 },
    ],
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
  assert.match(text, /\| lead_time \| partial \| 4 of 6 \| 10000 ms \| 18000 ms \| the job was cancelled \(1 job\), the job is not finished \(1 job\) \|/u)
  assert.match(text, /Jobs: 6; open, and so left out of every measure: 1\./u)
  assert.match(text, /\| flow_efficiency \| partial \| 4 of 6 \| 68\.00% \| 70\.00% \|/u)
  assert.match(text, /\| search_waste \| not recorded \| 0 of 6 \| not recorded \| not recorded \| published facts do not carry it \(5 jobs\), the job is not finished \(1 job\) \|/u)
  assert.match(text, /\| tool_failures \(quality\) \|/u)
  assert.match(text, /### By plugin version: 3\.1\.0/u)
  assert.match(text, /### By host: mixed/u)
  assert.match(text, /### By job class: other/u)
  assert.match(text, /\| shell \| measured \| 4 \| 2 \| 2 of 2 \| none \|/u)
  assert.match(text, /- Unattributed sessions: 1 of 10 \(3000 ms of 70000 ms session time\)\./u)
  assert.match(text, /- Job class: every job is other; published facts do not carry the task card's kind\./u)
  assert.doesNotMatch(text, /\| search_waste \| [^|]* \| 0 \| 0 \|/u)

  const empty = computeRollups({ records: [], sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } })
  const emptyText = renderRollupsMarkdown(empty)
  assert.match(emptyText, /No job has published facts yet\./u)
  assert.match(emptyText, /No fully labeled finished job yet/u)
  assert.doesNotMatch(emptyText, /\bNaN\b|undefined|null/u)
})

test("sessions_shared counts a session only when two labeled jobs' segments overlap, or one has none", () => {
  const sharedCount = (firstSegments, secondSegments) => {
    const sessions = fixtureSessions().map((session) => {
      if (session.session.id !== S(1)) return session
      const first = { ...session.jobs[0], ...(firstSegments ? { segments: firstSegments } : {}) }
      const second = { ...session.jobs[0], job: J("8"), ...(secondSegments ? { segments: secondSegments } : {}) }
      return { ...session, jobs: [first, second] }
    })
    const labels = fixtureLabels()
    const resolved = resolveLabels([...labels, { ...labels.find((entry) => entry.session === S(1)), job: J("8") }], sessions)
    const records = buildTimelines(sessions).map((timeline) => jobRecord({ timeline, formulas: calculateFormulas(timeline) }, resolved.byJobSession))
    return computeRollups({ records, sessions, labels: resolved }).muda.groupings.overall.all.sessions_shared
  }
  const early = [{ start_ms: 0, end_ms: 1000 }]
  assert.equal(sharedCount(early, [{ start_ms: 1000, end_ms: 2000 }]), 0)
  assert.equal(sharedCount(early, [{ start_ms: 500, end_ms: 2000 }]), 1)
  assert.equal(sharedCount(early, null), 1)
  assert.equal(sharedCount(null, null), 1)
})

const measuredValue = (value) => ({ value, state: "measured" })
const partialValue = (value) => ({ value, state: "partial", reasons: ["host_records_partly"] })

test("a measure stat carries n, N and state and n equals jobs_counted", () => {
  const records = [
    record(J("1"), { measures: { lead_time: measuredValue(10) } }),
    record(J("2"), { measures: { lead_time: measuredValue(30) } }),
    record(J("3"), { measures: { lead_time: measuredValue(20) } }),
  ]
  const all = computeRollups({ records, sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } }).measures.groupings.overall.all
  assert.deepEqual(all.measures.lead_time, { jobs_counted: 3, n: 3, N: 3, state: "measured", median: 20, p75: 30, jobs_excluded: [] })
  for (const id of MEASURE_IDS) assert.equal(all.measures[id].n, all.measures[id].jobs_counted, id)
})

test("a mixed population is partial with the counts, an empty one unavailable with a null median", () => {
  const records = [
    record(J("1"), { measures: { lead_time: measuredValue(10), tool_failures: measuredValue(0) } }),
    record(J("2"), { measures: { lead_time: { excluded: "cancelled" }, tool_failures: measuredValue(0) } }),
  ]
  const all = computeRollups({ records, sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } }).measures.groupings.overall.all
  assert.deepEqual(all.measures.lead_time, { jobs_counted: 1, n: 1, N: 2, state: "partial", median: 10, p75: 10, jobs_excluded: [{ reason: "cancelled", jobs: 1 }] })
  assert.equal(all.measures.tool_failures.state, "measured")
  assert.equal(all.measures.tool_failures.median, 0, "a measured zero stays a zero")
  assert.deepEqual(all.measures.search_waste, { jobs_counted: 0, n: 0, N: 2, state: "unavailable", median: null, p75: null, jobs_excluded: [{ reason: "not_in_published_facts", jobs: 2 }] })
  const none = computeRollups({ records: [], sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } }).measures.groupings.overall.all
  assert.deepEqual(none.measures.lead_time, { jobs_counted: 0, n: 0, N: 0, state: "unavailable", median: null, p75: null, jobs_excluded: [] })
})

test("open jobs count in N and are excluded as open_job", () => {
  const { records, rollups } = fixtureRollups()
  const lead = rollups.measures.groupings.overall.all.measures.lead_time
  assert.equal(lead.N, records.length)
  assert.equal(lead.n, 4)
  assert.equal(lead.state, "partial")
  assert.deepEqual(lead.jobs_excluded.find((entry) => entry.reason === "open_job"), { reason: "open_job", jobs: 1 })
  assert.equal(lead.n + lead.jobs_excluded.reduce((total, entry) => total + entry.jobs, 0), lead.N, "every job is counted or excluded with a reason")
})

test("the waste Pareto carries n, N and state", () => {
  const { rollups } = fixtureRollups()
  const overall = rollups.muda.groupings.overall.all
  assert.equal(overall.n, overall.jobs_labeled)
  assert.equal(overall.N, overall.jobs)
  assert.equal(overall.state, "partial")
  const none = computeRollups({ records: [], sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } }).muda.groupings.overall.all
  assert.deepEqual([none.n, none.N, none.state], [0, 0, "unavailable"])
  const all = computeRollups({ records: [record(J("1"), { measures: { muda_time: measuredValue(0), ...Object.fromEntries(LABEL_WASTES.map((waste) => [`muda_time.${waste}`, measuredValue(0)])) } })], sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } }).muda.groupings.overall.all
  assert.deepEqual([all.n, all.N, all.state], [1, 1, "measured"])
})

test("the Markdown table prints n of N", () => {
  const { rollups } = fixtureRollups()
  const text = renderRollupsMarkdown(rollups)
  assert.match(text, /\| compactions \(count\) \| /u)
  assert.match(text, /Compactions \(count\) is how many compactions happened, which every host records; compaction wait time is a different number/u)
  assert.match(text, /\| Measure \| State \| Jobs counted \(n of N\) \|/u)
  assert.match(text, /\| lead_time \| partial \| 4 of 6 \| 10000 ms \| 18000 ms \| the job was cancelled \(1 job\), the job is not finished \(1 job\) \|/u)
  assert.match(text, /\| search_waste \| not recorded \| 0 of 6 \| not recorded \| not recorded \|/u)
})

test("a partial job value is never counted in a median", () => {
  const records = [
    record(J("1"), { measures: { api_retries: measuredValue(2) } }),
    record(J("2"), { measures: { api_retries: partialValue(900) } }),
  ]
  const stats = computeRollups({ records, sessions: [], labels: { files: 0, byJobSession: new Map(), unused: [] } }).measures.groupings.overall.all.measures.api_retries
  assert.deepEqual(stats, { jobs_counted: 1, n: 1, N: 2, state: "partial", median: 2, p75: 2, jobs_excluded: [{ reason: "host_records_partly", jobs: 1 }] })
})

test("a job record keeps a value that is partial only because the host records partly, with its state, and measured values say measured", () => {
  const { records } = fixtureRollups()
  const byJob = Object.fromEntries(records.map((entry) => [entry.job, entry]))
  assert.deepEqual(byJob[J("1")].measures.api_retries, { value: 0, state: "partial", reasons: ["host_records_partly"] })
  assert.deepEqual(byJob[J("2")].measures.api_retries, { value: 1, state: "measured" })
  assert.deepEqual(byJob[J("1")].measures.lead_time, { value: 10000, state: "measured" })
  assert.deepEqual(byJob[J("1")].measures.muda_time, { value: 4000, state: "measured" })
  assert.deepEqual(byJob[J("6")].measures.human_wait, { excluded: "partial" }, "any other partial stays excluded")
  assert.deepEqual(byJob[J("4")].measures.api_retries, { excluded: "open_job" })
})

// A normalized session built for the totals tests: every counter is a plain number, so a state other than measured can only come from a flag.
function totalsSession(host, index, { unavailable = [], models, agents, calls = { shell: 2, read: 3 }, failures = { shell: 1 } } = {}) {
  return {
    session: { host, id: S(index), duration_ms: 1000 },
    models: models ?? [{ id: "model-alpha", requests: 3, tokens: { input: 100, output: 200, cache_read: 30, cache_write: 4, reasoning: 5 } }],
    agents: agents ?? [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    counts: { tool_calls: calls, tool_failures: failures },
    unavailable: unavailable.map(([field, reason]) => ({ field, reason })),
    jobs: [],
  }
}
const NO_LABELS = { files: 0, byJobSession: new Map(), unused: [] }
const totalsOfSessions = (sessions) => computeRollups({ records: [], sessions, labels: NO_LABELS }).totals

test("totals sums tool calls only over sessions whose tool durations are not flagged and says n of N", () => {
  const sessions = [
    totalsSession("claude-code", 1, { calls: { shell: 2, read: 3 } }),
    totalsSession("claude-code", 2, { calls: { shell: 10 } }),
    totalsSession("claude-code", 3, { calls: { shell: 100 }, unavailable: [["tool_durations", "source_unreadable"]] }),
    totalsSession("codex-cli", 4, { calls: { shell: 7 } }),
  ]
  const { all, hosts } = totalsOfSessions(sessions)
  assert.deepEqual(all.tool_calls, { state: "partial", value: 22, n: 3, N: 4, reasons: ["source_unreadable"] })
  assert.deepEqual(hosts["claude-code"].tool_calls, { state: "partial", value: 15, n: 2, N: 3, reasons: ["source_unreadable"] })
  assert.deepEqual(hosts["codex-cli"].tool_calls, { state: "measured", value: 7, n: 1, N: 1, reasons: [] })
  assert.deepEqual(all.sessions, { state: "measured", value: 4, n: 4, N: 4, reasons: [] })
  assert.deepEqual(Object.keys(totalsOfSessions(sessions).hosts), ["claude-code", "codex-cli"])
  assert.equal(totalsOfSessions(sessions).schema, "desk.factory.rollups/1")
})

test("a host_records_partly session is not in n but its count stays in the value, and a null counter with no flag is never summed as zero", () => {
  const sessions = [
    totalsSession("codex-cli", 1, { failures: { shell: 1 } }),
    totalsSession("codex-cli", 2, { failures: { shell: 4 }, unavailable: [["tool_outcomes", "host_records_partly"]] }),
    totalsSession("codex-cli", 3, { failures: { shell: 9 }, unavailable: [["tool_outcomes", "host_does_not_record"]] }),
  ]
  assert.deepEqual(totalsOfSessions(sessions).all.tool_failures, { state: "partial", value: 5, n: 1, N: 3, reasons: ["host_does_not_record", "host_records_partly"] })
  const old = [
    totalsSession("claude-code", 1),
    totalsSession("claude-code", 2, { models: [{ id: "model-alpha", requests: null, tokens: { input: null, output: null, cache_read: null, cache_write: null, reasoning: null } }] }),
    totalsSession("claude-code", 3, { models: [] }),
  ]
  const { all } = totalsOfSessions(old)
  assert.deepEqual(all.model_requests, { state: "partial", value: 3, n: 1, N: 3, reasons: ["field_absent"] })
  assert.deepEqual(all.tokens.input, { state: "partial", value: 100, n: 1, N: 3, reasons: ["field_absent"] })
})

test("a session flagged only host_records_partly with nothing else keeps a lower bound and the leaf is partial, not unavailable", () => {
  const { all } = totalsOfSessions([totalsSession("codex-cli", 1, { unavailable: [["requests", "host_records_partly"]] })])
  assert.deepEqual(all.model_requests, { state: "partial", value: 3, n: 0, N: 1, reasons: ["host_records_partly"] })
})

test("model requests are unavailable when every session lacks requests and never zero", () => {
  const lacking = [{ id: "model-alpha", requests: null, tokens: { input: 1, output: 2, cache_read: 0, cache_write: 0, reasoning: 0 } }]
  const sessions = [totalsSession("copilot-cli", 1, { models: lacking }), totalsSession("copilot-cli", 2, { models: lacking, unavailable: [["requests", "source_unreadable"]] })]
  const leaf = totalsOfSessions(sessions).all.model_requests
  assert.deepEqual(leaf, { state: "unavailable", n: 0, N: 2, reasons: ["field_absent", "source_unreadable"] })
  assert.equal(Object.hasOwn(leaf, "value"), false, "the value key is absent")
})

test("token totals per type follow the flag table and reasoning is unavailable for Claude", () => {
  const claude = [totalsSession("claude-code", 1, { unavailable: [["reasoning_tokens", "host_does_not_record"]] }), totalsSession("claude-code", 2, { unavailable: [["reasoning_tokens", "host_does_not_record"]] })]
  const { all } = totalsOfSessions(claude)
  assert.deepEqual(all.tokens.reasoning, { state: "unavailable", n: 0, N: 2, reasons: ["host_does_not_record"] })
  assert.deepEqual(all.tokens.input, { state: "measured", value: 200, n: 2, N: 2, reasons: [] })
  assert.deepEqual(Object.keys(all.tokens), ["input", "output", "cache_read", "cache_write", "reasoning"])
  const flagged = totalsOfSessions([totalsSession("claude-code", 1), totalsSession("claude-code", 2, { unavailable: [["tokens", "source_unreadable"]] })]).all.tokens
  for (const type of Object.keys(flagged)) assert.deepEqual([flagged[type].state, flagged[type].n, flagged[type].N, flagged[type].reasons], ["partial", 1, 2, ["source_unreadable"]], type)
  assert.equal(flagged.output.value, 200)
  const models = totalsOfSessions([totalsSession("claude-code", 1, { unavailable: [["models", "log_truncated"]] })]).all.tokens
  for (const type of Object.keys(models)) assert.equal(models[type].state, "unavailable", type)
})

test("subagent dispatches are partial when some sessions flagged agents", () => {
  const sessions = [
    totalsSession("claude-code", 1),
    totalsSession("claude-code", 2, { agents: [{ n: 0, parent: null, model: "m" }, { n: 1, parent: 0, model: "m" }, { n: 2, parent: 0, model: "m" }] }),
    totalsSession("claude-code", 3, { unavailable: [["agents", "source_unreadable"]] }),
  ]
  assert.deepEqual(totalsOfSessions(sessions).all.subagent_dispatches, { state: "partial", value: 3, n: 2, N: 3, reasons: ["source_unreadable"] })
  const none = totalsOfSessions([totalsSession("claude-code", 1, { agents: [{ n: 0, parent: null, model: "m" }] })]).all.subagent_dispatches
  assert.deepEqual(none, { state: "measured", value: 0, n: 1, N: 1, reasons: [] }, "a measured zero stays a zero")
})

test("totals over no sessions have no value and a stable shape (the reason is in the next test)", () => {
  const { all, hosts } = totalsOfSessions([])
  assert.deepEqual(hosts, {})
  assert.deepEqual(all.tool_calls, { state: "unavailable", n: 0, N: 0, reasons: ["no_sessions"] })
})

test("tool kind rows carry state, n and N", () => {
  const sessions = [
    totalsSession("claude-code", 1, { calls: { shell: 2, read: 1 }, failures: { shell: 1 } }),
    totalsSession("claude-code", 2, { calls: { shell: 5 }, failures: {}, unavailable: [["tool_durations", "source_unreadable"]] }),
    totalsSession("codex-cli", 3, { calls: { edit: 4 }, failures: {}, unavailable: [["tool_outcomes", "host_records_partly"]] }),
    totalsSession("codex-cli", 4, { calls: { search: 1 }, failures: {}, unavailable: [["tool_durations", "source_unreadable"]] }),
  ]
  const rows = Object.fromEntries(computeRollups({ records: [], sessions, labels: NO_LABELS }).tool_kinds.tool_kinds.map((row) => [row.tool, row]))
  assert.deepEqual(rows.shell, { tool: "shell", calls: 2, failures: 1, sessions: 2, state: "partial", n: 1, N: 2, reasons: ["source_unreadable"] })
  assert.deepEqual(rows.read, { tool: "read", calls: 1, failures: 0, sessions: 1, state: "measured", n: 1, N: 1, reasons: [] })
  assert.deepEqual(rows.edit, { tool: "edit", calls: 4, failures: 0, sessions: 1, state: "partial", n: 0, N: 1, reasons: ["host_records_partly"] })
  assert.deepEqual(rows.search, { tool: "search", sessions: 1, state: "unavailable", n: 0, N: 1, reasons: ["source_unreadable"] })
  const text = renderRollupsMarkdown(computeRollups({ records: [], sessions, labels: NO_LABELS }))
  assert.match(text, /\| search \| not recorded \| not recorded \| not recorded \| 0 of 1 \| the source could not be read \|/u)
})

test("coverage lists sessions per host and the flagged counts", () => {
  const sessions = [
    totalsSession("codex-cli", 1, { unavailable: [["tokens", "host_records_partly"], ["agents", "source_unreadable"]] }),
    totalsSession("claude-code", 2, { unavailable: [["tokens", "host_records_partly"]] }),
    totalsSession("claude-code", 3),
  ]
  const { coverage } = computeRollups({ records: [], sessions, labels: NO_LABELS })
  assert.deepEqual(coverage.hosts, [{ host: "claude-code", sessions: 2 }, { host: "codex-cli", sessions: 1 }])
  assert.deepEqual(coverage.flagged, [
    { field: "agents", reason: "source_unreadable", sessions: 1, N: 3 },
    { field: "tokens", reason: "host_records_partly", sessions: 2, N: 3 },
  ])
})

test("totals over no sessions say no_sessions, a report-only reason, and never an empty reason list", () => {
  const { all } = totalsOfSessions([])
  for (const leaf of [all.tool_calls, all.tool_failures, all.model_requests, all.subagent_dispatches, ...Object.values(all.tokens)]) {
    assert.deepEqual(leaf, { state: "unavailable", n: 0, N: 0, reasons: ["no_sessions"] })
  }
  assert.equal(ENUMS.unavailableReason.includes("no_sessions"), false, "the reason is not a facts enum value")
})

test("every non-measured totals leaf and tool-kind row names a reason, in every fixture and synthetic case", () => {
  const { rollups } = fixtureRollups()
  const leaves = (totals) => [...Object.values(totals).filter((entry) => "state" in entry), ...Object.values(totals.tokens)]
  for (const totals of [rollups.totals.all, ...Object.values(rollups.totals.hosts)]) {
    for (const leaf of leaves(totals)) assert.equal(leaf.state === "measured" || leaf.reasons.length > 0, true)
  }
  for (const row of rollups.tool_kinds.tool_kinds) assert.equal(row.state === "measured" || row.reasons.length > 0, true)
})

test("a rollup number with a state other than measured and no reason is refused", () => {
  assert.throws(() => assertNamed({ state: "partial", reasons: [] }), /no reason/u)
  assert.throws(() => assertNamed({ state: "unavailable", reasons: [] }), /no reason/u)
  assert.deepEqual(assertNamed({ state: "measured", reasons: [] }), { state: "measured", reasons: [] })
  assert.deepEqual(assertNamed({ state: "partial", reasons: ["capped"] }), { state: "partial", reasons: ["capped"] })
})

test("a formula result with a missing or unknown state is refused, never read as measured", () => {
  assert.throws(() => fromFormula({ value: 3 }), /state/u)
  assert.throws(() => fromFormula({ value: 3, state: "fine" }), /state/u)
  assert.deepEqual(fromFormula({ value: 3, state: "measured" }), { value: 3, state: "measured" })
})

test("the rollups page prints states, n of N and plain reasons, and a tool kind with no counts reads not recorded", () => {
  const { rollups } = fixtureRollups()
  const tools = rollups.tool_kinds.tool_kinds.map((row, index) => index === 0
    ? { tool: row.tool, sessions: row.sessions, state: "unavailable", n: 0, N: row.N, reasons: ["host_does_not_record", "log_missing"] }
    : row)
  const text = renderRollupsMarkdown({ ...rollups, tool_kinds: { ...rollups.tool_kinds, tool_kinds: tools } })
  assert.match(text, /\| Measure \| State \| Jobs counted \(n of N\) \| Median \| p75 \| Excluded \|/u)
  assert.match(text, /\| Tool kind \| State \| Calls \| Failures \| Sessions counted \(n of N\) \| Why not whole \|/u)
  assert.match(text, /\| shell \| not recorded \| not recorded \| not recorded \| 0 of 2 \| the host does not record it and the session log was missing \|/u)
  assert.match(text, /Muda time: 14000 ms \(partial\) across 4 of 6 jobs fully labeled; excluded: the job is not finished \(1 job\), only some sessions supplied it \(1 job\)\./u)
  assert.match(text, /unused: the labeled evidence no longer matches the facts \(1 file\), the session's facts are missing \(1 file\)\./u)
  for (const row of text.split("\n").filter((line) => /^\| [a-z_]+( \(quality\))? \| (measured|partial|not recorded) \|/u.test(line))) {
    assert.match(row, /\| \d+ of \d+ \|/u, row)
  }
  assert.doesNotMatch(text, /\b(open_job|host_records_partly|host_does_not_record|field_absent|not_labeled|not_in_published_facts|facts_missing)\b/u)
})
