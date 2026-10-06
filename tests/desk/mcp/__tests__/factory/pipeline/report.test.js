import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { withState } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"
import { ATTENTION_REASON_TEXT, ATTENTION_ROLLUP_REASONS, FIELD_TEXT, LABEL_REASONS, REASON_TEXT, REPORT_ONLY_REASONS, buildCoverage, reasonText, outcomeSections, renderIndexMarkdown, renderJobMarkdown, renderReadme } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/report.js"
import { ENUMS } from "../../../../../../plugins/desk/mcp/src/factory/schema.js"
import { LABEL_UNAVAILABLE } from "../../../../../../plugins/desk/mcp/src/factory/label-schema.js"
import { ATTENTION_REASONS } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/attention.js"
import { build } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { buildJobTimeline, buildTimelines } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"

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
    "- Active time inside the lead-time window: 13000 ms, 92.86% of lead time (measured, inferred evidence).",
    "- Human wait: 2000 ms, 14.29% of lead time (partial: the host does not record it; 1 session uncovered; inferred evidence).",
    "- Lead-time contributors are partial: the host does not record it and the host records only some of it, so this is a lower bound.",
    "- Longest single wait: human wait, 2000 ms (partial: the host does not record it and the host records only some of it, so this is a lower bound; 2 sessions uncovered).",
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
    "- Classified by the independent evaluator: 2 sessions labeled (measured).",
    "- Muda: 5000 ms, 50.00% of labeled time, by type: waiting 3000 ms in 2 stretches, defects 2000 ms in 1 stretch (measured).",
    "- Value 4000 ms; support 1000 ms (measured).",
    "- Mura (unevenness) flagged on 1 stretch; muri (overburden) on 1 stretch (measured).",
  ].join("\n"))
  assert.doesNotMatch(section, /Not classified yet/u)
  assert.match(section, /Candidate signals only \(inferred\):/u)
})

test("what was waste shows unknown time on a line of its own, in labeled time and never in muda", () => {
  const labels = new Map([
    [`${CLOSED}/${FIRST}`, { stretches: [stretch(0, 4000, "value"), stretch(4000, 6000, "muda", "waiting"), stretch(6000, 9000, "unknown", "unknown")], unavailable: [] }],
    [`${CLOSED}/${SECOND}`, { stretches: [stretch(0, 1000, "support")], unavailable: [] }],
  ])
  assert.equal(wasteSection(labels).split("\n- Mura")[0], [
    "- Classified by the independent evaluator: 2 sessions labeled (measured).",
    "- Muda: 2000 ms, 20.00% of labeled time, by type: waiting 2000 ms in 1 stretch (measured).",
    "- Value 4000 ms; support 1000 ms (measured).",
    "- Unknown (the evaluator could not tell, not counted as muda): 3000 ms (measured).",
  ].join("\n"))
})

test("what was waste names unlabeled sessions, labels with no muda and what the evaluator could not read", () => {
  const section = wasteSection(new Map([[`${CLOSED}/${SECOND}`, { stretches: [stretch(0, 3000, "value")], unavailable: ["session_log_missing"] }]]))
  assert.equal(section.split("\n- Candidate signals")[0], [
    "- Classified by the independent evaluator: 1 of 2 sessions labeled (partial: the independent evaluator has not labeled it; 1 session uncovered).",
    "- Muda: none in the labeled stretches (partial: the independent evaluator has not labeled it; 1 session uncovered).",
    "- Value 3000 ms; support 0 ms (partial: the independent evaluator has not labeled it; 1 session uncovered).",
    "- Mura (unevenness) flagged on 0 stretches; muri (overburden) on 0 stretches (partial: the independent evaluator has not labeled it; 1 session uncovered).",
    "- The evaluator could not read: the session log was missing in 1 session (measured).",
  ].join("\n"))
  const empty = wasteSection(new Map([
    [`${CLOSED}/${SECOND}`, { stretches: [], unavailable: ["session_log_missing"] }],
    [`${CLOSED}/${FIRST}`, { stretches: [], unavailable: ["facts_missing"] }],
  ]))
  assert.match(empty, /- Muda: none in the labeled stretches \(measured\)\.\n- Value 0 ms; support 0 ms \(measured\)\./u)
  assert.match(empty, /could not read: the session's facts are missing in 1 session, the session log was missing in 1 session \(measured\)\./u)
})

test("the report labels a shared session and groups every unavailable field plus first-pass yield", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  assert.match(report, /1 session shared with 1 other job/u)
  assert.match(report, /- Human waits: the host does not record it \(1 session\)/u)
  assert.match(report, /- Permission waits: the host does not record it \(1 session\)/u)
  assert.match(report, /First-pass yield: not recorded \(no outcome record is available\)/u)
  assert.match(report, /Rework: not recorded \(no outcome record is available\)/u)
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
  assert.ok(index.includes(`| ${CLOSED} | 14000 ms (measured) | 14000 ms (measured) | 1000 ms (measured) | 92.86% (measured, inferred evidence) |`))
  assert.match(index, /Sessions seen: not recorded \(the store only receives published facts/u)
  assert.match(index, /Sessions with facts: 4/u)
  assert.match(index, /Bound sessions: 3/u)
  assert.match(index, /Unattributed sessions: 1/u)
  assert.match(index, /Session end time: the session was still open \(1 of 4 sessions, 25\.00%\)/u)
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
  assert.match(report, /Status: not recorded \(the job's status was not recorded\)/u)
  assert.match(report, /Status transitions: none \(measured\)/u)
  assert.match(report, /Tool calls: none \(partial: it was cut to a size limit; 1 session uncovered\)/u)
  assert.match(report, /Lead-time contributors: not recorded \(the job clock could not be read\)/u)
  assert.match(report, /Longest single wait: not recorded \(the job clock could not be read\)/u)
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
  assert.match(index, /not recorded \(the job clock could not be read\)/u)

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
  assert.match(report, /- Lead time: 9000 ms \(measured, declared evidence\)\./u)
  assert.match(report, /permission not recorded \(it was cut to a size limit and the host does not record it\)/u)
  assert.match(report, /1 API retry \(partial: the host records only some of it, so this is a lower bound and the session log was missing; 1 session uncovered\)/u)
  assert.match(report, /paused at an unknown offset \(partial: the job clock could not be read\)/u)
  assert.match(report, /- Public pull requests: ourostack\/desk#7, ourostack\/desk#8 \(partial: [^)]*\); public commits: 2 \(partial: the host does not record it; 1 session uncovered\);/u)
  const index = renderIndexMarkdown([{ timeline, formulas }], buildCoverage([declaredLead]))
  assert.ok(index.includes("| 9000 ms (measured, declared evidence) |"))

  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "api_retries", reason: "log_missing" })
  lacking.refs.prs = []
  const lackingTimeline = buildJobTimeline(CLOSED, [lacking])
  const lackingReport = renderJobMarkdown({ timeline: lackingTimeline, formulas: calculateFormulas(lackingTimeline) })
  assert.match(lackingReport, /API retries not recorded \(the session log was missing\)/u)
  assert.match(lackingReport, /- Public pull requests: none \(partial: [^)]*\);/u)
})

test("a job whose lead-time contributors are all measured has no partial-contributors line", () => {
  const whole = structuredClone(sessions[2])
  whole.schema = "desk.factory.published/2"
  whole.unavailable = []
  whole.intervals.push({ kind: "permission_wait", agent: 0, start_ms: 100, end_ms: 200 }, { kind: "compaction", agent: 0, start_ms: 300, end_ms: 400 })
  const timeline = buildJobTimeline(CLOSED, [whole])
  const formulas = calculateFormulas(timeline)
  assert.equal(formulas.lead_contributors.state, "measured")
  const report = renderJobMarkdown({ timeline, formulas })
  const section = report.split("## What mattered\n\n")[1].split("\n## What was waste")[0]
  assert.doesNotMatch(section, /Lead-time contributors are partial/u)
  assert.match(section, /^- .*% of lead time \(measured, inferred evidence\)\.$/mu)
})

test("an empty store renders an index with no job table and explicit empty sections", () => {
  const index = renderIndexMarkdown([], buildCoverage([]))
  assert.match(index, /## Jobs\n\nNo job has published facts yet\.\n/u)
  assert.doesNotMatch(index, /\| Job \|/u)
  assert.match(index, /### Unavailable evidence\n\n- None\.\n/u)
  assert.match(index, /### Plugin versions\n\n- None\.\n/u)
  assert.match(index, /Sessions with facts: 0 \(measured\)\./u)
})

test("the job page says not recorded for commit counts a host never recorded, not 0", () => {
  const session = structuredClone(sessions[0])
  session.schema = "desk.factory.published/2"
  session.unavailable.push({ field: "commits", reason: "host_does_not_record" })
  const timeline = buildJobTimeline(CLOSED, [session])
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  assert.match(report, /public commits: not recorded \(the host does not record it\); private pull requests counted: 1 \([^)]*\); private commits counted: not recorded \(the host does not record it\)\./u)
})

// ---- Every number prints with its state ----

const ROLLUP_FACTS = path.join(here, "..", "fixtures", "rollup-store", "facts")
const readFacts = (directory) => readdirSync(directory).sort().map((name) => normalizePublished(JSON.parse(readFileSync(path.join(directory, name), "utf8"))))

// Every session flagged with every field and reason: the pages must explain each of them.
function everyFlag() {
  const base = structuredClone(normalizePublished(sessions[0]))
  base.unavailable = ENUMS.publishedUnavailableField.flatMap((field) => ENUMS.unavailableReason.map((reason) => ({ field, reason })))
  return base
}

function pagesOf(sessionList) {
  const reports = buildTimelines(sessionList).map((timeline) => ({ timeline, formulas: calculateFormulas(timeline) }))
  return {
    jobs: reports.map(({ timeline, formulas }) => renderJobMarkdown({ timeline, formulas })),
    index: renderIndexMarkdown(reports, buildCoverage(sessionList)),
    readme: renderReadme(),
  }
}

function allPages() {
  const stores = [readFacts(FACTS), readFacts(ROLLUP_FACTS), [everyFlag()]]
  return stores.flatMap((list) => {
    const pages = pagesOf(list)
    return [...pages.jobs, pages.index, pages.readme]
  })
}

// A state marker is `(measured...)`, `(partial: ...)` or `not recorded (...)`. A number is
// printed with its state when a marker closes the clause after it: none may be left over at the end of a line.
const STATE_OR_NUMBER = /(\((?:measured|partial:)[^()]*\)|not recorded \([^()]*\))|(\d[\d.]*)/gu

function numbersWithoutState(line) {
  // Version names and the release name carry digits that are not numbers of the factory.
  const text = line.replace(/\b\d+\.\d+\.\d+(?:-[\w.]+)?|\bv\d+\b/gu, "")
  let pending = null
  for (const match of text.matchAll(STATE_OR_NUMBER)) pending = match[1] === undefined ? (pending ?? match[2]) : null
  return pending
}

// The only lines exempt from the walk, each with its reason. Nothing else is exempt by line type.
const WALK_ALLOWED = [
  { name: "page title", reason: "the job id is a name, not a number of the factory", test: (line) => line.startsWith("# ") },
  { name: "section heading", reason: "headings carry no number", test: (line) => line.startsWith("## ") || line.startsWith("### ") },
  { name: "table rule", reason: "the table's dashes carry no number", test: (line) => /^\| -/u.test(line) },
  { name: "gap list", reason: "each line names a field a host did not record, and the count says how many sessions it covers; the line is itself the not-recorded statement", test: (line, section) => section === "What we could not see" || section === "Unavailable evidence" },
]

// Every line of a page, with the section it sits in and whether it is exempt.
function walkLines(page) {
  let section = ""
  return page.split("\n").filter((line) => line.length > 0).map((line) => {
    if (line.startsWith("## ") || line.startsWith("### ")) section = line.replace(/^#+ /u, "")
    return { line, allowed: WALK_ALLOWED.find((entry) => entry.test(line, section)) }
  })
}

function sectionLines(page, heading) {
  return (page.split(`## ${heading}\n\n`)[1] ?? "").split("\n## ")[0].split("\n").filter((line) => line.startsWith("- "))
}

test("no number on any job page or the index prints without its state word", () => {
  let checked = 0
  const exempt = new Set()
  for (const sessionList of [readFacts(FACTS), readFacts(ROLLUP_FACTS), [everyFlag()]]) {
    const pages = pagesOf(sessionList)
    for (const page of [...pages.jobs, pages.index]) {
      for (const { line, allowed } of walkLines(page)) {
        if (allowed !== undefined) {
          exempt.add(allowed.name)
          continue
        }
        assert.equal(numbersWithoutState(line), null, line)
        checked += 1
      }
    }
  }

  assert.ok(checked > 200)
  assert.deepEqual([...exempt].sort(), ["gap list", "page title", "section heading", "table rule"])
  assert.equal(numbersWithoutState("- Human wait: 2000 ms (14.29% of lead time)"), "2000")
  assert.equal(numbersWithoutState("- Wait: 5 ms (measured), 6 ms"), "6")
  assert.equal(numbersWithoutState("- Muda: 5000 ms, by type: waiting 3000 ms in 2 stretches"), "5000")
})
test("an unavailable number prints not recorded with its plain reason", () => {
  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "api_retries", reason: "log_missing" })
  const timeline = buildJobTimeline(CLOSED, [lacking])
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  assert.match(report, /API retries not recorded \(the session log was missing\)/u)
  const mixed = structuredClone(sessions[0])
  mixed.unavailable.push({ field: "permission_waits", reason: "capped" }, { field: "permission_waits", reason: "host_does_not_record" })
  const mixedTimeline = buildJobTimeline(CLOSED, [mixed])
  assert.match(renderJobMarkdown({ timeline: mixedTimeline, formulas: calculateFormulas(mixedTimeline) }), /permission not recorded \(it was cut to a size limit and the host does not record it\)/u)
  const unreadable = buildJobTimeline("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", [])
  assert.match(renderJobMarkdown({ timeline: unreadable, formulas: calculateFormulas(unreadable) }), /Longest single wait: not recorded \(the job clock could not be read\)/u)
  assert.doesNotMatch(report, /not recorded \(\)|undefined|null/u)
})

test("Claude and Codex job pages print commits as not recorded, never zero", () => {
  for (const host of ["claude-code", "codex-cli"]) {
    const raw = structuredClone(sessions[0])
    raw.session.host = host
    const session = normalizePublished(raw)
    const timeline = buildJobTimeline(CLOSED, [session])
    const line = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) }).split("\n").find((entry) => entry.startsWith("- Public pull requests"))
    assert.match(line, /public commits: not recorded \(the host does not record it\)/u, host)
    assert.match(line, /private commits counted: not recorded \(the host does not record it\)/u, host)
    assert.doesNotMatch(line, /commits: 0/u, host)
    assert.match(line, /public pull requests: .*\(partial: the host records only some of it/iu)
  }
})

test("a partial token total prints worker_split in plain words and each token type has its state", () => {
  const timeline = buildJobTimeline(CLOSED, sessions.slice(0, 1))
  const formulas = calculateFormulas(timeline)
  const split = (value) => withState({ class: "measured", value, partial: true, uncovered_sessions: 1, partial_reasons: ["worker_split"] })
  formulas.tokens_total = { total: split(30), input: split(10), output: split(20), cache_read: split(0), cache_write: split(0), reasoning: withState({ class: "unavailable", value: null, reason: "worker_split" }) }
  const line = renderJobMarkdown({ timeline, formulas }).split("\n").find((entry) => entry.startsWith("- Tokens"))
  assert.equal(line, "- Tokens: total 30 (partial: the job owns only some workers of a session, and that session is not counted; 1 session uncovered), input 10 (partial: the job owns only some workers of a session, and that session is not counted; 1 session uncovered), output 20 (partial: the job owns only some workers of a session, and that session is not counted; 1 session uncovered), cache read 0 (partial: the job owns only some workers of a session, and that session is not counted; 1 session uncovered), cache write 0 (partial: the job owns only some workers of a session, and that session is not counted; 1 session uncovered), reasoning not recorded (the job owns only some workers of a session, and that session is not counted).")
  const whole = renderJobMarkdown({ timeline: buildJobTimeline(CLOSED, sessions), formulas: calculateFormulas(buildJobTimeline(CLOSED, sessions)) })
  assert.match(whole, /- Tokens: total \d+ \(measured\), input \d+ \(measured\)/u)
})

test("the index prints states and the new unavailable fields with plain text, one line per field", () => {
  const list = readFacts(FACTS)
  const reports = buildTimelines(list).map((timeline) => ({ timeline, formulas: calculateFormulas(timeline) }))
  const index = renderIndexMarkdown(reports, buildCoverage(list))
  assert.match(index, /\| 12000 ms \(partial: the job was still open/u)
  assert.match(index, /- Commits: the host does not record it \(2 of 4 sessions, 50\.00%\)\./u)
  assert.match(index, /- Compaction wait time: the host does not record it \(2 of 4 sessions/u)
  assert.match(index, /- Pull requests: the host records only some of it, so this is a lower bound \(4 of 4 sessions, 100\.00%\)\./u)
  assert.match(index, /- Reasoning tokens: the host does not record it/u)
  assert.match(index, /- Models: the host's record did not include it \(1 of 4 sessions, 25\.00%\); the host does not record it \(1 of 4 sessions, 25\.00%\)\./u)
  assert.equal([...index.matchAll(/^- Models:/gmu)].length, 1)
  assert.match(index, /- Sessions seen: not recorded \(the store only receives published facts, so it cannot count sessions that never published any\)\./u)
  assert.doesNotMatch(index, /host_|_ms|field_absent/u)
})
test("every reason and field a page can print has plain text, found structurally", () => {
  const reasons = new Set([...ENUMS.unavailableReason, ...REPORT_ONLY_REASONS, ...LABEL_REASONS, ...LABEL_UNAVAILABLE])
  // The reasons named in the code that produces them.
  const sourceDir = path.join(here, "..", "..", "..", "..", "..", "..", "plugins", "desk", "mcp", "src", "factory", "pipeline")
  const literals = [/unavailable\("(\w+)"/gu, /excluded: "(\w+)"/gu, /reasons?\.(?:push|add)\("(\w+)"\)/gu, /\b(?:OPEN_JOB|NO_SESSIONS|NOT_PUBLISHED|PARTLY) = "(\w+)"/gu, /reason: "(\w+)"/gu]
  let found = 0
  for (const file of ["formulas.js", "rollups.js"]) {
    const source = readFileSync(path.join(sourceDir, file), "utf8")
    for (const pattern of literals) for (const match of source.matchAll(pattern)) {
      reasons.add(match[1])
      found += 1
    }
  }
  assert.ok(found > 20)
  // The reasons in the built output of both fixture stores.
  const stores = [path.join(STORE, "..", "store"), path.join(STORE, "..", "rollup-store")]
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-factory-reasons-"))
  try {
    for (const [index, store] of stores.entries()) {
      const out = path.join(root, String(index))
      build({ storeDir: store, outDir: out })
      const walk = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(directory, entry.name)) : [path.join(directory, entry.name)])
      for (const file of walk(out).filter((name) => name.endsWith(".json"))) {
        const visit = (value) => {
          if (Array.isArray(value)) value.forEach(visit)
          else if (value !== null && typeof value === "object") {
            for (const [key, child] of Object.entries(value)) {
              if (key === "reason" && typeof child === "string") reasons.add(child)
              else if (key === "reasons" && Array.isArray(child)) child.forEach((entry) => typeof entry === "string" && reasons.add(entry))
              else visit(child)
            }
          }
        }
        visit(JSON.parse(readFileSync(file, "utf8")))
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  // Reasons that are not reasons to print: the label-check codes, the schema string, and facts keys named `reason` in the coverage entries are all in the map or listed here.
  const NOT_PRINTED = new Set(["completed"])
  for (const id of [...reasons].filter((entry) => !NOT_PRINTED.has(entry))) {
    assert.equal(typeof REASON_TEXT[id], "string", `reason ${id} has no plain text`)
    assert.ok(REASON_TEXT[id].length > 0 && !/[_;()]/u.test(REASON_TEXT[id]), id)
  }
  for (const field of ENUMS.publishedUnavailableField) assert.equal(typeof FIELD_TEXT[field], "string", `field ${field} has no plain name`)
  assert.throws(() => reasonText("not_a_known_reason"), /no plain text for the reason not_a_known_reason/u)
  const ids = [...Object.keys(REASON_TEXT), ...Object.keys(FIELD_TEXT)].filter((id) => id.includes("_"))
  const pages = allPages()
  assert.ok(pages.length > 6)
  for (const page of pages) {
    for (const id of ids) assert.equal(new RegExp(`\\b${id}\\b`, "u").test(page), false, id)
    for (const line of page.split("\n").filter((entry) => !/^- (Muda|Value|Mura|Classified|The evaluator)/u.test(entry))) {
      assert.doesNotMatch(line, /\b[a-z]+(?:_[a-z0-9]+)+\b/u, line)
    }
  }
})
test("the README states the rules, totals.json and that cost is not measured", () => {
  const readme = renderReadme()
  assert.match(readme, /`rollups\/totals\.json`/u)
  assert.match(readme, /measured, partial or not recorded/u)
  assert.match(readme, /n of N/u)
  assert.match(readme, /lower bound/u)
  assert.match(readme, /Cost in money is not measured/u)
  assert.match(readme, /API retry counts are the errors the host surfaced/u)
  assert.match(readme, /Human wait is the gaps between prompts inside a session/u)
  assert.match(readme, /Codex reads an output layout it does not recognise as ok/u)
  assert.match(readme, /Copilot adds denied/u)
  assert.equal(readme.split("\n").filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("- ") && line.length < 60).length, 0)
})

test("the report README explains the attention estimate, its method version and that it is an estimate", () => {
  const readme = renderReadme()
  assert.match(readme, /^## Human attention$/mu)
  assert.match(readme, /Human attention per accepted outcome is an estimate, not a measurement/u)
  assert.match(readme, /method version 1/u)
  assert.match(readme, /Desk changes the method version whenever it changes a constant/u)
  assert.match(readme, /reading the reply and writing the prompt/u)
  assert.match(readme, /never more than the gap the host shows, when there is one/u)
  assert.match(readme, /printed beside the attention figures/u)
  assert.match(readme, /counts every human turn of every session in the period[^\n]+including turns on jobs that were refused, are unsigned or were never delivered/u)
  assert.match(readme, /divided by the jobs accepted \(recorded by the agent on the operator's word\)/u)
  assert.match(readme, /It is partial, a lower bound, when some session in the period flags the field[^\n]+Codex records no human turns[^\n]+Copilot records them only in part/u)
  assert.match(readme, /It is unavailable, with no value and no total, when no session in the period kept a list[^\n]+no human-turn records[^\n]+turns not recorded/u)
  assert.match(readme, /A turn the estimator cannot read is counted, adds no time and gives the reason that a turn could not be estimated/u)
  assert.match(readme, /also unavailable, with no total, when every turn is unreadable/u)
  assert.match(readme, /With no accepted outcome the headline is unavailable[^\n]+the total so far is still shown/u)
  assert.match(readme, /Sessions in the old format \(`\/1`\) are outside the period/u)
  assert.match(readme, /no accepted outcomes yet/u)
  assert.match(readme, /Permission decisions are shown beside the headline, not in it/u)
  assert.equal(readme.split("\n").filter((line) => line.length > 0 && !line.startsWith("#") && !line.startsWith("- ") && line.length < 60).length, 0)
})

test("each job page carries the footnote that defines retries, human wait, tool outcomes and cost", () => {
  for (const page of pagesOf(readFacts(FACTS)).jobs) {
    assert.match(page, /\nHow to read these numbers: measured means/u)
    assert.match(page, /API retry counts are the errors the host surfaced/u)
    assert.match(page, /Cost in money is not measured/u)
    assert.deepEqual(page.match(/^## .+$/gmu).length, 4)
  }
})

test("a field or reason with no words stops the page, and a number with no state stops it too", () => {
  const odd = structuredClone(sessions[0])
  odd.unavailable.push({ field: "future_field", reason: "log_missing" })
  const timeline = buildJobTimeline(CLOSED, [odd])
  const formulas = calculateFormulas(timeline)
  assert.throws(() => renderIndexMarkdown([{ timeline, formulas }], buildCoverage([odd])), /no plain name for the field future_field/u)
  const oddReason = structuredClone(sessions[0])
  oddReason.unavailable.push({ field: "tokens", reason: "future_reason" })
  assert.throws(() => renderIndexMarkdown([{ timeline, formulas }], buildCoverage([oddReason])), /no plain text for the reason future_reason/u)
  assert.throws(() => renderJobMarkdown({ timeline, formulas }), /no plain name for the field future_field/u)
  const cleanTimeline = buildJobTimeline(CLOSED, sessions)
  const clean = calculateFormulas(cleanTimeline)
  const stateless = structuredClone(clean)
  delete stateless.lead_time_ms.state
  assert.throws(() => renderJobMarkdown({ timeline: cleanTimeline, formulas: stateless }), /a number has no known state/u)
  const noCounts = structuredClone(clean)
  noCounts.tool_calls_by_kind = withState({ class: "unavailable", value: null, reason: "log_missing" })
  assert.match(renderJobMarkdown({ timeline: cleanTimeline, formulas: noCounts }), /- Tool calls: not recorded \(the session log was missing\)\./u)
})

test("the compaction count and compaction wait time cannot be confused on a page", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const page = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  assert.match(page, /compaction wait time \d+ ms \(/u)
  assert.doesNotMatch(page, /compaction \d+ ms/u)
  assert.match(page, /The number of compactions is recorded on every host; compaction wait time is recorded only where the host records it\./u)
  assert.match(renderReadme(), /The number of compactions is recorded on every host; compaction wait time is recorded only where the host records it\./u)
  assert.match(page, /- Compaction wait time: the host does not record it/u)
})

test("token types that share one not-recorded state and reason are said once", () => {
  const timeline = buildJobTimeline(CLOSED, sessions.slice(0, 1))
  const formulas = calculateFormulas(timeline)
  const none = (reason) => withState({ class: "unavailable", value: null, reason })
  formulas.tokens_total = { total: none("field_absent"), input: none("field_absent"), output: none("field_absent"), cache_read: none("field_absent"), cache_write: none("field_absent"), reasoning: none("host_does_not_record") }
  const line = renderJobMarkdown({ timeline, formulas }).split("\n").find((entry) => entry.startsWith("- Tokens"))
  assert.equal(line, "- Tokens: total, input, output, cache read, cache write not recorded (the host's record did not include it), reasoning not recorded (the host does not record it).")
})

function signoffLine(outcome) {
  const recorded = structuredClone(sessions)
  if (outcome !== null) recorded[0].outcomes = [{ job: CLOSED, rev: 1, deliveries: 1, verified: null, reason: null, wait: null, ...outcome }]
  const timeline = buildJobTimeline(CLOSED, recorded)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  return report.split("\n").filter((line) => line.startsWith("- Sign-off:"))
}

test("the job page says which sign-off the job has, in the plan's words", () => {
  const class1 = (waitClass, censored) => ({ class: waitClass, censored })
  assert.deepEqual(signoffLine({ state: "accepted", verified: true, wait: class1("lt_1d", false) }), ["- Sign-off: accepted, waited under 1 day."])
  assert.deepEqual(signoffLine({ state: "accepted", verified: false, wait: class1("lt_1h", false) }), ["- Sign-off: accepted, waited under 1 hour."])
  assert.deepEqual(signoffLine({ state: "accepted", verified: null, wait: class1("lt_7d", false) }), ["- Sign-off: accepted, waited under 7 days."])
  assert.deepEqual(signoffLine({ state: "accepted", verified: true, wait: class1("ge_7d", false) }), ["- Sign-off: accepted, waited 7 days or more."])
  assert.deepEqual(signoffLine({ state: "accepted", verified: true, wait: null }), ["- Sign-off: accepted."])
  assert.deepEqual(signoffLine({ state: "delivered_unsigned", wait: class1("lt_7d", true) }), ["- Sign-off: delivered, waiting at least 1 day."])
  assert.deepEqual(signoffLine({ state: "delivered_unsigned", wait: class1("lt_1h", true) }), ["- Sign-off: delivered, waiting, under 1 hour so far."])
  assert.deepEqual(signoffLine({ state: "delivered_unsigned", wait: class1("lt_1d", true) }), ["- Sign-off: delivered, waiting at least 1 hour."])
  assert.deepEqual(signoffLine({ state: "delivered_unsigned", wait: class1("ge_7d", true) }), ["- Sign-off: delivered, waiting at least 7 days."])
  assert.deepEqual(signoffLine({ state: "delivered_unsigned", wait: null }), ["- Sign-off: delivered, waiting for sign-off."])
  assert.deepEqual(signoffLine({ state: "refused", verified: true, reason: "defect", wait: class1("lt_1d", false) }), ["- Sign-off: refused (verified), reason defect, waited under 1 day."])
  assert.deepEqual(signoffLine({ state: "refused", verified: false, reason: "changed_ask", wait: null }), ["- Sign-off: refused (unverified), reason changed_ask."])
  assert.deepEqual(signoffLine({ state: "reopened" }), ["- Sign-off: reopened after delivery."])
  assert.deepEqual(signoffLine({ state: "not_delivered", deliveries: 0 }), ["- Sign-off: not delivered yet."])
})

test("a job with no entry and a legacy done job read not recorded and delivered, sign-off not recorded", () => {
  assert.deepEqual(signoffLine(null), ["- Sign-off: not recorded."])
  assert.deepEqual(signoffLine({ state: "not_recorded", deliveries: 0 }), ["- Sign-off: delivered, sign-off not recorded."])
})

function qualityLines(outcome) {
  const recorded = structuredClone(sessions)
  recorded[0].outcomes = [{ job: CLOSED, rev: 1, deliveries: 1, verified: null, reason: null, wait: null, since: "created", returns: [], ...outcome }]
  const timeline = buildJobTimeline(CLOSED, recorded)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  return report.split("\n").filter((line) => line.startsWith("- First-pass yield:") || line.startsWith("- Rework:"))
}

const RETURN = { reason: "agent_error", caught: "at_review", counts: true, refusal: null, refusal_verified: null }

test("the job page says whether the job passed first time and what was sent back", () => {
  assert.deepEqual(qualityLines({ state: "accepted", verified: true }), [
    "- First-pass yield: 1, passed first time.",
    "- Rework: returned in the task 0, at review 0, after delivery 0; reason check on refusals: compared 0, disagree 0.",
  ])
  assert.deepEqual(qualityLines({ state: "accepted", verified: true, returns: [RETURN, { ...RETURN, caught: "after_delivery", refusal: "defect", refusal_verified: true }] }), [
    "- First-pass yield: 0, sent back after review (2 returns counted).",
    "- Rework: returned in the task 0, at review 1, after delivery 1; reason check on refusals: compared 1, disagree 0 (a lower bound).",
  ])
  assert.equal(qualityLines({ state: "delivered_unsigned" })[0], "- First-pass yield: 1, upper bound (passed so far, waiting for sign-off).")
  assert.equal(qualityLines({ state: "accepted", verified: false })[0], "- First-pass yield: 1, passed first time.")
  assert.equal(qualityLines({ state: "accepted", verified: true, returns: [{ ...RETURN, reason: "changed_ask", counts: false }] })[0], "- First-pass yield: 1, passed first time; only changed asks came back.")
  assert.equal(qualityLines({ state: "accepted", verified: true, returns: [RETURN], returns_unreadable: 1 })[1].endsWith("(partial: some of what was sent back was not recorded)."), true)
})

test("an unavailable first-pass yield or rework figure is listed under what we could not see as not recorded", () => {
  const recorded = structuredClone(sessions)
  recorded[0].outcomes = [{ job: CLOSED, rev: 1, state: "not_delivered", verified: null, reason: null, deliveries: 0, wait: null, since: "created", returns: [] }]
  const timeline = buildJobTimeline(CLOSED, recorded)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  const seen = report.split("## What we could not see\n\n")[1]
  assert.match(seen, /- First-pass yield: not recorded \(the job has no standing delivery yet\)\./u)
  assert.doesNotMatch(seen, /- Rework:/u)
  assert.match(report.split("## What mattered")[0], /- Rework: returned in the task 0/u)
  assert.doesNotMatch(report.split("## What mattered")[0], /First-pass yield/u)
})

const NO_YIELD = { state: "unavailable", reasons: ["no_delivered_jobs"], n: 0, N: 0, passed: 0, returned: 0, awaiting_signoff: 0, changed_ask_only: 0, excluded: [] }
const NO_REWORK = { state: "unavailable", reasons: ["not_recorded"], n: 0, N: 0, reason_check: { state: "unavailable", reasons: ["not_recorded"] } }
const rollupsOf = (signoff, rest = {}) => ({ schema: "desk.factory.rollups/1", signoff, first_pass_yield: NO_YIELD, rework: NO_REWORK, ...rest })

test("the rollups page section names the sign-off counts, or says they are not recorded", () => {
  assert.deepEqual(outcomeSections(undefined), [])
  assert.deepEqual(outcomeSections(rollupsOf({ recorded: false })).slice(0, 4), [
    "## Sign-off", "", "Sign-off: not recorded in any session of this store.", "",
  ])
  const signoff = {
    recorded: true, jobs: 9, accepted: 3, accepted_unverified: 0, delivered_unsigned: 2, refused: 1, refused_unverified: 1, reopened: 0, not_recorded: 1, not_delivered: 1,
    no_record: 2, jobs_without_work_record: 1,
    refusal_reasons: { not_what_was_asked: 0, defect: 1, changed_ask: 0, incomplete: 0, other: 0 },
    waits: { signed: { lt_1h: 1, lt_1d: 2, lt_7d: 0, ge_7d: 0 }, unsigned: { lt_1h: 0, lt_1d: 0, lt_7d: 2, ge_7d: 0 } },
  }
  assert.deepEqual(outcomeSections(rollupsOf(signoff)).slice(0, 11), [
    "## Sign-off", "",
    "- Jobs with a sign-off record: 9; with no work record: 1. Jobs with a work record and no sign-off record: 2.",
    "- Accepted (recorded by the agent on the operator's word): 3.",
    "- Delivered, waiting for sign-off: 2. Refused: 1 (unverified: 1). Reopened: 0.",
    "- Delivered before sign-off was recorded: 1. Not delivered yet: 1.",
    "- Refusal reasons: defect 1.",
    "- Waits that ended in an answer: under 1 hour 1, under 1 day 2.",
    "- Waits still open (at least this long): at least 1 day 2.",
    "",
    "## First-pass yield",
  ])
})

test("the rollups page says first-pass yield as n of N, an upper bound while sign-offs are pending, and not recorded when there is none", () => {
  const section = (value) => outcomeSections(rollupsOf({ recorded: false }, value)).join("\n").split("## First-pass yield\n\n")[1].split("\n## Rework")[0]
  const base = { n: 2, N: 3, passed: 2, returned: 1, awaiting_signoff: 0, changed_ask_only: 1, excluded: [{ reason: "history_not_recorded", jobs: 4 }, { reason: "not_delivered", jobs: 1 }] }
  assert.equal(section({ first_pass_yield: { state: "measured", value: 2 / 3, reasons: [], ...base } }), [
    "- First-pass yield: 2 of 3 delivered jobs passed first time (66.67%).",
    "- Sent back: 1. Only changed asks came back: 1.",
    "- Left out of the count: 4 jobs (the task card does not record what was sent back), 1 job (the job has no standing delivery yet).",
    "",
  ].join("\n"))
  const partial = section({ first_pass_yield: { state: "partial", value: 1, reasons: ["awaiting_signoff"], ...base, N: 2, returned: 0, awaiting_signoff: 1, excluded: [] } })
  assert.equal(partial, [
    "- First-pass yield: at most 2 of 2 delivered jobs passed first time (upper bound 100.00%; 1 waiting for sign-off).",
    "- Sent back: 0. Only changed asks came back: 1.",
    "- Left out of the count: none.",
    "",
  ].join("\n"))
  assert.match(section({ first_pass_yield: { state: "partial", value: 1, reasons: ["awaiting_signoff"], ...base, awaiting_signoff: 2 } }), /\(upper bound 100\.00%; 2 waiting for sign-off\)/u)
  assert.match(section({}), /^- First-pass yield: not recorded \(no delivered job has a first-pass result yet\)\.\n/u)
})

test("the rollups page says what was sent back, where it was caught and how often the reasons differ, or that none is recorded", () => {
  const section = (rework) => outcomeSections(rollupsOf({ recorded: false }, { rework })).join("\n").split("## Rework\n\n")[1]
  const returns = {
    in_task: { agent_error: 0, changed_ask: 0, new_information: 1, external: 0 },
    at_review: { agent_error: 0, changed_ask: 0, new_information: 0, external: 0 },
    after_delivery: { agent_error: 2, changed_ask: 1, new_information: 0, external: 0 },
  }
  assert.equal(section({ state: "measured", reasons: [], n: 3, N: 3, returns, changed_ask: 1, reason_check: { state: "measured", reasons: [], compared: 4, disagree: 1, compared_verified: 3 } }), [
    "- Jobs with returns recorded: 3 of 3.",
    "- Returns caught in the task: new_information 1. At review: none. After delivery: agent_error 2, changed_ask 1.",
    "- Returns that were changed asks: 1.",
    "- Reason check on refusals: compared 4, disagree 1, of which 3 of the compared refusals were verified. This is a lower bound on disagreement.",
    "",
  ].join("\n"))
  const partial = section({ state: "partial", reasons: ["history_not_recorded"], n: 1, N: 3, returns, changed_ask: 0, reason_check: { state: "unavailable", reasons: ["no_refusals"] } })
  assert.match(partial, /^- Jobs with returns recorded: 1 of 3 \(partial: the task card does not record what was sent back\)\./u)
  assert.match(partial, /- Reason check on refusals: not recorded \(no refusal could be compared with the agent's reason\)\./u)
  assert.equal(section({ state: "unavailable", reasons: ["history_not_recorded"], n: 0, N: 2, reason_check: { state: "unavailable", reasons: ["not_recorded"] } }), "- Rework: not recorded (the task card does not record what was sent back).\n")
})

test("a store with finished jobs and no outcome records does not say that nothing was delivered", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-factory-no-outcomes-"))
  try {
    build({ storeDir: STORE, outDir: root + "/out" })
    const page = readFileSync(path.join(root, "out", "rollups", "index.md"), "utf8")
    assert.match(page, /- First-pass yield: not recorded \(no delivered job has a first-pass result yet\)\./u)
    assert.match(page, /Left out of the count: 2 jobs \(no outcome record is available\)/u)
    assert.doesNotMatch(page, /no job has been delivered/u)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// --- the attention headline on the rollups page and the job page (task E8) -----

const METHOD = { version: 1, read_ms: { none: 0, xs: 1000, s: 5000, m: 30_000, l: 150_000, xl: 400_000 }, type_ms: { none: 2000, xs: 3000, s: 25_000, m: 150_000, l: 180_000, xl: 180_000 }, floor_ms: 1000, permission_ms: 5000 }
const attentionOf = (headline, rest = {}) => ({
  method: METHOD,
  headline: { reasons: [], n: 3, N: 3, numerator_ms: 3_600_000, accepted_outcomes: 3, ...headline },
  turns_per_accepted: { state: "measured", value: 2.5, reasons: [], n: 3, N: 3 },
  human_turns: 40,
  est_ms: { attributed: 3_000_000, unattributed: 450_000, unplaced: 150_000 },
  sessions: { in_period: 5, complete: 5 },
  permission: { state: "measured", decisions: 2, est_ms: 8000, reasons: [] },
  ...rest,
})
const attentionPage = (attention) => outcomeSections(rollupsOf({ recorded: false }, { attention })).join("\n").split("## Human attention\n\n")[1].split("\n## ")[0]

test("the rollups page leads with the headline number, says it is an estimate with its method version, then its state", () => {
  const page = attentionPage(attentionOf({ state: "measured", value: 1_200_000, reasons: [] }))
  const lines = page.split("\n")
  assert.equal(lines[0], "- Human attention per accepted outcome: about 20 minutes (an estimate, method version 1; measured). That is 1 hour of estimated attention over 3 accepted outcomes.")
  assert.match(page, /- Human turns per accepted outcome: 2\.5 \(40 human turns over 3 accepted outcomes\)\./u)
  assert.match(page, /- Where the estimate went: 50 minutes on jobs, 7\.5 minutes on sessions that were not on any job, 2\.5 minutes on sessions that could not be placed on a job\./u)
  assert.match(page, /- Sessions in the period: 5, of which 5 record the human's turns completely\./u)
  assert.doesNotMatch(page, /Codex|Copilot/u, "no host sentence when no session in the period has a host reason")
  assert.match(page, /- Permission decisions, reported beside the headline and not in it: 2, estimated at 8 seconds\./u)
  assert.match(page, /- Method: version 1\. An estimate of the time the human spent reading the reply and writing the prompt/u)
  assert.doesNotMatch(page, /_ms|undefined|NaN/u)
})

test("a partial headline says it is a lower bound and why, and names Codex and Copilot", () => {
  const reasons = ["host_does_not_record", "host_records_partly", "turns_capped", "turns_not_recorded"]
  const page = attentionPage(attentionOf({ state: "partial", value: 1_200_000, reasons }, { turns_per_accepted: { state: "partial", value: 2.5, reasons, n: 3, N: 3 } }))
  assert.match(page.split("\n")[0], /^- Human attention per accepted outcome: about 20 minutes \(an estimate, method version 1; partial, so a lower bound: /u)
  assert.match(page.split("\n")[0], /a host does not record the human's turns/u)
  assert.match(page.split("\n")[0], /a host records the human's turns only in part/u)
  assert.doesNotMatch(page.split("\n")[0], /Codex|Copilot|Claude/u, "a reason names the reason, not a host")
  assert.match(page, /such as Codex.*such as Copilot/u, "the sentence about hosts is printed when a host reason is present")
  assert.match(page, /- Human turns per accepted outcome: at least 2\.5/u)
  assert.doesNotMatch(page, /host_|turns_capped|turns_not_recorded/u)
})

test("with no accepted outcome the page says no accepted outcomes yet and still gives the estimated attention", () => {
  const page = attentionPage(attentionOf(
    { state: "unavailable", reasons: ["no_accepted_outcomes"], n: 0, N: 0, accepted_outcomes: 0 },
    { turns_per_accepted: { state: "unavailable", reasons: ["no_accepted_outcomes"], n: 0, N: 0 } },
  ))
  assert.equal(page.split("\n")[0], "- Human attention per accepted outcome: no accepted outcomes yet. The estimated attention so far, with nothing to divide it by, is 1 hour over 40 human turns.")
  const bound = attentionPage(attentionOf({ state: "unavailable", reasons: ["no_accepted_outcomes", "turns_capped"], n: 0, N: 0, accepted_outcomes: 0 }, { turns_per_accepted: { state: "unavailable", reasons: ["no_accepted_outcomes"], n: 0, N: 0 } }))
  assert.equal(bound.split("\n")[0], "- Human attention per accepted outcome: no accepted outcomes yet. The estimated attention so far, with nothing to divide it by, is at least 1 hour over at least 40 human turns (a session's list of human turns was cut to a size limit, so this is a lower bound).")
  const unknown = attentionPage(attentionOf({ state: "unavailable", reasons: ["host_does_not_record", "no_accepted_outcomes", "turns_not_recorded"], n: 0, N: 0, accepted_outcomes: 0, numerator_ms: undefined }, { turns_per_accepted: { state: "unavailable", reasons: ["no_accepted_outcomes"], n: 0, N: 0 }, human_turns: undefined, est_ms: undefined, sessions: { in_period: 1, complete: 0 } }))
  assert.equal(unknown.split("\n")[0], "- Human attention per accepted outcome: no accepted outcomes yet, and no human attention is recorded in the period (a host does not record the human's turns, so this is a lower bound and some sessions did not record all of the human's turns, so this is a lower bound).")
  assert.doesNotMatch(unknown, /over 0 ms|0 human turns|Where the estimate went/u)
  assert.match(page, /- Human turns per accepted outcome: no accepted outcomes yet\./u)
  assert.doesNotMatch(page, /about|NaN/u)
})

test("an unavailable headline for another reason says so in words and gives no number", () => {
  const page = attentionPage(attentionOf({ state: "unavailable", reasons: ["no_turn_records"], numerator_ms: undefined }, { human_turns: undefined, sessions: { in_period: 0, complete: 0 }, est_ms: undefined }))
  assert.match(page.split("\n")[0], /^- Human attention per accepted outcome: not available \(no session in the store records the human's turns\)\./u)
  const permission = attentionPage(attentionOf({ state: "measured", value: 1 }, { permission: { state: "unavailable", reasons: ["host_does_not_record", "no_sessions"] } }))
  assert.match(permission, /- Permission decisions, reported beside the headline and not in it: not recorded \(the host does not record it and no session has reported yet\)\./u)
  assert.equal(outcomeSections(rollupsOf({ recorded: false })).join("\n").includes("Human attention"), false, "a caller with no attention figure adds nothing")
})

test("attention reasons print through the attention words on every page, never through the outcome words for not_recorded", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const base = calculateFormulas(timeline)
  const outcomeWords = REASON_TEXT.not_recorded
  assert.notEqual(outcomeWords, ATTENTION_REASON_TEXT.not_recorded)
  const line = (attention) => renderJobMarkdown({ timeline, formulas: { ...base, attention } }).split("\n").find((entry) => entry.startsWith("- Human attention"))
  // The built fixture has no recorded turns: the job page says so in the attention words.
  assert.equal(line(base.attention), `- Human attention: not recorded (${ATTENTION_REASON_TEXT.not_recorded}).`)
  for (const code of ATTENTION_REASONS) {
    const unavailable = { class: "unavailable", state: "unavailable", value: null, reasons: [code], reason: code }
    const text = line(withState(unavailable))
    assert.ok(text.includes(ATTENTION_REASON_TEXT[code]), code)
    assert.ok(!text.includes(outcomeWords), `${code} does not print the outcome words`)
  }
  const partial = withState({ class: "inferred", value: 90_000, turns: 3, method: 1, reasons: ["turns_not_recorded", "turns_capped"], state: "partial", partial: true, partial_reasons: ["turns_not_recorded", "turns_capped"] })
  assert.equal(line(partial), `- Human attention: about 1.5 minutes over 3 human turns (an estimate, method version 1; partial: ${ATTENTION_REASON_TEXT.turns_capped} and ${ATTENTION_REASON_TEXT.turns_not_recorded}).`)
  const measured = withState({ class: "inferred", value: 9000, turns: 3, method: 1, reasons: [], state: "measured" })
  assert.equal(line(measured), "- Human attention: about 9 seconds over 3 human turns (an estimate, method version 1; measured).")
  const mixed = withState({ class: "unavailable", state: "unavailable", value: null, reasons: ["desk_public", "no_segments"], reason: "mixed" })
  assert.equal(line(mixed), `- Human attention: not recorded (${REASON_TEXT.desk_public} and ${ATTENTION_REASON_TEXT.no_segments}).`)
  // The rollup words for the headline never use the outcome words either.
  for (const code of ATTENTION_ROLLUP_REASONS) assert.ok(Object.hasOwn(REASON_TEXT, code) && REASON_TEXT[code].length > 10 && !/[_;()]/u.test(REASON_TEXT[code]), code)
})

test("durations read in seconds, minutes and hours with singular and plural words, and a host's own flag keeps its shared words on the job page", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const base = calculateFormulas(timeline)
  const line = (value, turns, reasons = []) => renderJobMarkdown({
    timeline,
    formulas: { ...base, attention: withState({ class: "inferred", value, turns, method: 1, reasons, state: reasons.length === 0 ? "measured" : "partial", ...(reasons.length === 0 ? {} : { partial: true, partial_reasons: reasons }) }) },
  }).split("\n").find((entry) => entry.startsWith("- Human attention"))
  assert.equal(line(500, 1), "- Human attention: about 500 ms over 1 human turn (an estimate, method version 1; measured).")
  assert.equal(line(1000, 1), "- Human attention: about 1 second over 1 human turn (an estimate, method version 1; measured).")
  assert.equal(line(60_000, 2), "- Human attention: about 1 minute over 2 human turns (an estimate, method version 1; measured).")
  assert.equal(line(3_600_000, 2), "- Human attention: about 1 hour over 2 human turns (an estimate, method version 1; measured).")
  assert.equal(line(7_200_000, 2), "- Human attention: about 2 hours over 2 human turns (an estimate, method version 1; measured).")
  assert.match(line(9000, 2, ["host_records_partly"]), /partial: the host records only some of it, so this is a lower bound\)\.$/u)
})

test("the rollups page says a partial permission figure in words, from the attention words or the shared ones", () => {
  const line = (reasons) => attentionPage(attentionOf({ state: "measured", value: 1 }, { permission: { state: "partial", decisions: 2, est_ms: 8000, reasons } })).split("\n").find((entry) => entry.startsWith("- Permission"))
  assert.match(line(["capped", "decision_not_estimable"]), /estimated at 8 seconds \(partial: it was cut to a size limit and some permission decisions could not be estimated, so this is a lower bound\)\.$/u)
})
