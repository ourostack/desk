import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { withState } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"
import { FIELD_TEXT, LABEL_REASONS, REASON_TEXT, REPORT_ONLY_REASONS, buildCoverage, reasonText, renderIndexMarkdown, renderJobMarkdown, renderReadme } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/report.js"
import { ENUMS } from "../../../../../../plugins/desk/mcp/src/factory/schema.js"
import { LABEL_UNAVAILABLE } from "../../../../../../plugins/desk/mcp/src/factory/label-schema.js"
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
  assert.match(report, /First-pass yield: not recorded \(it is not collected yet\)/u)
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
