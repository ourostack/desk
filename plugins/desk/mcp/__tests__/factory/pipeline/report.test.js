import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../src/factory/pipeline/formulas.js"
import { buildCoverage, renderIndexMarkdown, renderJobMarkdown, renderReadme } from "../../../src/factory/pipeline/report.js"
import { buildJobTimeline, buildTimelines } from "../../../src/factory/pipeline/timeline.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(here, "..", "fixtures", "store")
const FACTS = path.join(STORE, "facts")
const sessions = readdirSync(FACTS).sort().map((name) => JSON.parse(readFileSync(path.join(FACTS, name), "utf8")))
const CLOSED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SENTINEL = "SENTINEL-STORE-FREE-TEXT"

test("the job report has exactly the four approved headings in order", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  assert.deepEqual(report.match(/^## .+$/gmu), [
    "## What happened",
    "## What mattered",
    "## What was waste",
    "## What we could not see",
  ])
})

test("what mattered deterministically names the two largest contributors and longest wait", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  const section = report.split("## What mattered\n\n")[1].split("\n## What was waste")[0]
  assert.equal(section, [
    "- Active time inside the lead-time window: 13000 ms (92.86% of lead time; inferred).",
    "- Human wait: 2000 ms (14.29% of lead time; inferred, partial: 1 session uncovered).",
    "- Longest single wait: human wait, 2000 ms (measured, partial: 2 sessions uncovered).",
    "",
  ].join("\n"))
})

function wasteSection(labels) {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline), labels })
  return report.split("## What was waste\n\n")[1].split("\n## What we could not see")[0]
}

function stretch(start, end, cls, waste = null, flags = {}) {
  return { start_ms: start, end_ms: end, class: cls, waste, mura: flags.mura ?? false, muri: flags.muri ?? false, evidence: [[start, end]] }
}

const FIRST = "11111111-1111-4111-8111-111111111111"
const SECOND = "22222222-2222-4222-8222-222222222222"

test("what was waste says not classified yet only when no session of the job has labels", () => {
  for (const section of [wasteSection(undefined), wasteSection(new Map()), wasteSection(new Map([[`other/${FIRST}`, { stretches: [stretch(0, 5, "muda", "waiting")], unavailable: [] }]]))]) {
    assert.ok(section.startsWith("Not classified yet: no session of this job has labels from the independent evaluator.\n"))
    assert.match(section, /Candidate signals only \(inferred\):/u)
    assert.doesNotMatch(section, /slice 2|Classified by|wasted|waste verdict|productivity/u)
  }
})

test("what was waste renders the evaluator's classified waste when every session is labeled", () => {
  const labels = new Map([
    [`${CLOSED}/${FIRST}`, { stretches: [stretch(0, 4000, "value"), stretch(4000, 6000, "muda", "waiting", { mura: true }), stretch(6000, 7000, "support")], unavailable: [] }],
    [`${CLOSED}/${SECOND}`, { stretches: [stretch(0, 2000, "muda", "defects", { muri: true }), stretch(2000, 3000, "muda", "waiting")], unavailable: [] }],
  ])
  const section = wasteSection(labels)
  assert.equal(section.split("\n- Candidate signals")[0], [
    "- Classified by the independent evaluator: 2 sessions labeled.",
    "- Muda: 5000 ms (50.00% of labeled time): waiting 3000 ms (2 stretches), defects 2000 ms (1 stretch).",
    "- Value 4000 ms; support 1000 ms.",
    "- Mura (unevenness) flagged on 1 stretch; muri (overburden) on 1 stretch.",
  ].join("\n"))
  assert.doesNotMatch(section, /Not classified yet/u)
  assert.match(section, /Candidate signals only \(inferred\):/u)
})

test("what was waste names unlabeled sessions, labels with no muda and what the evaluator could not read", () => {
  const section = wasteSection(new Map([[`${CLOSED}/${SECOND}`, { stretches: [stretch(0, 3000, "value")], unavailable: ["session_log_missing"] }]]))
  assert.equal(section.split("\n- Candidate signals")[0], [
    "- Classified by the independent evaluator: 1 of 2 sessions labeled; not classified yet: 1 session.",
    "- Muda: none in the labeled stretches.",
    "- Value 3000 ms; support 0 ms.",
    "- Mura (unevenness) flagged on 0 stretches; muri (overburden) on 0 stretches.",
    "- The evaluator could not read: session_log_missing (1 session).",
  ].join("\n"))
  const empty = wasteSection(new Map([
    [`${CLOSED}/${SECOND}`, { stretches: [], unavailable: ["session_log_missing"] }],
    [`${CLOSED}/${FIRST}`, { stretches: [], unavailable: ["facts_missing"] }],
  ]))
  assert.match(empty, /- Muda: none in the labeled stretches\.\n- Value 0 ms; support 0 ms\./u)
  assert.match(empty, /could not read: facts_missing \(1 session\), session_log_missing \(1 session\)\./u)
})

test("the report labels a shared session and groups every unavailable field plus first-pass yield", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  assert.match(report, /1 session shared with 1 other job/u)
  assert.match(report, /human_waits: host_does_not_record \(1 session\)/u)
  assert.match(report, /permission_waits: host_does_not_record \(1 session\)/u)
  assert.match(report, /First-pass yield: unavailable \(not_collected_in_slice_1\)/u)
})

test("index coverage includes every required count, unavailable rate, and plugin version", () => {
  const timelines = buildTimelines(sessions)
  const reports = timelines.map((timeline) => ({ timeline, formulas: calculateFormulas(timeline) }))
  const coverage = buildCoverage(sessions)
  assert.deepEqual(coverage, {
    sessions_seen: { class: "unavailable", value: null, reason: "not_reported_to_store" },
    sessions_with_facts: 4,
    bound_sessions: 3,
    unattributed_sessions: 1,
    hosts: [
      { host: "claude-code", sessions: 2 },
      { host: "copilot-cli", sessions: 2 },
    ],
    unavailable: [
      { field: "ended_at", reason: "session_open", sessions: 1, rate: 0.25 },
      { field: "human_waits", reason: "host_does_not_record", sessions: 1, rate: 0.25 },
      { field: "job_offsets", reason: "source_unreadable", sessions: 1, rate: 0.25 },
      { field: "models", reason: "host_does_not_record", sessions: 1, rate: 0.25 },
      { field: "permission_waits", reason: "host_does_not_record", sessions: 1, rate: 0.25 },
      { field: "tokens", reason: "host_does_not_record", sessions: 1, rate: 0.25 },
      { field: "tool_durations", reason: "capped", sessions: 1, rate: 0.25 },
    ],
    plugins: [
      { name: "desk", version: "3.2.0-alpha.47", sessions: 1 },
      { name: "desk", version: "3.2.0-alpha.48", sessions: 3 },
      { name: "plain-language", version: "1.0.0-alpha.3", sessions: 1 },
    ],
  })
  const index = renderIndexMarkdown(reports, coverage)
  assert.ok(index.includes(`| ${CLOSED} | 14000 ms (measured) | 14000 ms (measured) | 1000 ms (measured) | 92.86% (inferred) |`))
  assert.match(index, /Sessions seen: unavailable \(not_reported_to_store\)/u)
  assert.match(index, /Sessions with facts: 4/u)
  assert.match(index, /Bound sessions: 3/u)
  assert.match(index, /Unattributed sessions: 1/u)
  assert.match(index, /ended_at \/ session_open: 1 of 4 sessions \(25\.00%\)/u)
  assert.match(index, /desk 3\.2\.0-alpha\.48: 3 sessions/u)
})

test("fixed report prose contains no date, time-of-day, path, or planted free text", () => {
  const timelines = buildTimelines(sessions)
  const outputs = [
    renderReadme(),
    renderIndexMarkdown(timelines.map((timeline) => ({ timeline, formulas: calculateFormulas(timeline) })), buildCoverage(sessions)),
    ...timelines.map((timeline) => renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })),
  ]
  for (const output of outputs) {
    assert.doesNotMatch(output, /\d{4}-\d{2}-\d{2}/u)
    assert.doesNotMatch(output, /\d{2}:\d{2}/u)
    assert.doesNotMatch(output, /\/(?:Users|home|tmp|var)\/|[A-Za-z]:\\/u)
    assert.equal(output.includes(SENTINEL), false)
  }
})

test("reports render unavailable timing, no transitions, no tool calls, and empty-store coverage explicitly", () => {
  const one = structuredClone(sessions[1])
  one.counts.tool_calls = {}
  one.jobs[0].observed = null
  const timeline = buildJobTimeline("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [one])
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  assert.match(report, /Status: unavailable \(status_unavailable\)/u)
  assert.match(report, /Status transitions: none/u)
  assert.match(report, /Tool calls: none/u)
  assert.match(report, /Lead-time contributors: unavailable \(job_offsets_unavailable\)/u)
  assert.match(report, /Longest single wait: unavailable \(job_offsets_unavailable\)/u)
  const coverage = buildCoverage([])
  assert.deepEqual(coverage, {
    sessions_seen: { class: "unavailable", value: null, reason: "not_reported_to_store" },
    sessions_with_facts: 0,
    bound_sessions: 0,
    unattributed_sessions: 0,
    hosts: [],
    unavailable: [],
    plugins: [],
  })
  const index = renderIndexMarkdown([{ timeline, formulas: calculateFormulas(timeline) }], coverage)
  assert.match(index, /unavailable \(job_offsets_unavailable\)/u)

  const sameField = structuredClone(sessions[0])
  sameField.unavailable.push({ field: "permission_waits", reason: "capped" })
  assert.deepEqual(buildCoverage([sameField]).unavailable, [
    { field: "permission_waits", reason: "capped", sessions: 1, rate: 1 },
    { field: "permission_waits", reason: "host_does_not_record", sessions: 1, rate: 1 },
  ])
})

test("reports print the evidence class, partial and mixed-reason qualifiers, and unknown transition offsets", () => {
  const declaredLead = structuredClone(sessions[0])
  declaredLead.jobs[0].transitions = [{ to: "validating", offset_ms: 7000 }, { to: "paused", offset_ms: null }]
  declaredLead.jobs[0].observed = { status: "done", offset_ms: 9000 }
  declaredLead.unavailable.push({ field: "api_retries", reason: "log_missing" })
  const copilot = structuredClone(sessions[2])
  copilot.unavailable.push({ field: "permission_waits", reason: "capped" })
  const timeline = buildJobTimeline(CLOSED, [declaredLead, copilot])
  const formulas = calculateFormulas(timeline)
  const report = renderJobMarkdown({ timeline, formulas })
  assert.match(report, /- Lead time: 9000 ms \(declared\)\./u)
  assert.match(report, /permission unavailable \(mixed: capped, host_does_not_record\)/u)
  assert.match(report, /1 API retry \(partial: 1 session uncovered\)/u)
  assert.match(report, /paused at an unknown offset/u)
  assert.match(report, /- Public pull requests: ourostack\/desk#7, ourostack\/desk#8; public commits: 2;/u)
  const index = renderIndexMarkdown([{ timeline, formulas }], buildCoverage([declaredLead]))
  assert.ok(index.includes("| 9000 ms (declared) |"))

  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "api_retries", reason: "log_missing" })
  lacking.refs.prs = []
  const lackingTimeline = buildJobTimeline(CLOSED, [lacking])
  const lackingReport = renderJobMarkdown({ timeline: lackingTimeline, formulas: calculateFormulas(lackingTimeline) })
  assert.match(lackingReport, /API retries unavailable \(log_missing\)/u)
  assert.match(lackingReport, /- Public pull requests: none;/u)
})

test("an empty store renders an index with no job table and explicit empty sections", () => {
  const index = renderIndexMarkdown([], buildCoverage([]))
  assert.match(index, /## Jobs\n\nNo job has published facts yet\.\n/u)
  assert.doesNotMatch(index, /\| Job \|/u)
  assert.match(index, /### Unavailable evidence\n\n- None\.\n/u)
  assert.match(index, /### Plugin versions\n\n- None\.\n/u)
  assert.match(index, /Sessions with facts: 0\./u)
})
