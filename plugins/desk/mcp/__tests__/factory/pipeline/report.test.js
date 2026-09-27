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
  assert.match(section, /^- Active time: 14000 ms \(100\.00% of lead time\)\.\n- Human wait: 2000 ms \(14\.29% of lead time\)\.\n- Longest single wait: human wait, 2000 ms\.\n$/u)
})

test("what was waste begins with the approved disclaimer and labels only candidate signals", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  const report = renderJobMarkdown({ timeline, formulas: calculateFormulas(timeline) })
  const section = report.split("## What was waste\n\n")[1].split("\n## What we could not see")[0]
  assert.ok(section.startsWith("Not classified yet: the independent evaluator arrives in slice 2.\n"))
  assert.match(section, /Candidate signals only:/u)
  assert.doesNotMatch(section, /wasted|waste verdict|productivity/u)
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
    sessions_seen: 4,
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
  assert.match(index, new RegExp(`\\| ${CLOSED} \\| 14000 ms \\| 14000 ms \\| 100\\.00% \\|`, "u"))
  assert.match(index, /Sessions seen: 4/u)
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
