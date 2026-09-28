import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { normalizePublished, stableStringify } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { buildJobTimeline, buildTimelines } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FACTS = path.join(here, "..", "fixtures", "store", "facts")
const sessions = readdirSync(FACTS).sort().map((name) => JSON.parse(readFileSync(path.join(FACTS, name), "utf8")))
const CLOSED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OPEN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

test("normalizePublished sorts every collection and stableStringify sorts every object key", () => {
  const input = structuredClone(sessions[2])
  input.plugins.reverse()
  input.agents.reverse()
  input.intervals.reverse()
  input.refs.prs.reverse()
  input.jobs.reverse()
  input.unavailable.reverse()
  input.refs.prs.push({ repo: "ourostack/desk", number: 9 })
  input.refs.commits.push({ repo: "ourostack/desk", sha: "3333333333333333333333333333333333333333" })
  input.intervals.push(structuredClone(input.intervals[0]))
  const before = structuredClone(input)
  const normalized = normalizePublished(input)
  assert.deepEqual(normalized.plugins.map((item) => item.name), ["desk", "plain-language"])
  assert.deepEqual(normalized.agents.map((item) => item.n), [0, 1])
  assert.deepEqual(normalized.intervals.map((item) => item.start_ms), [0, 1000, 2000, 2500, 4000, 4000])
  assert.deepEqual(normalized.refs.prs.map((item) => item.number), [8, 9])
  assert.deepEqual(normalized.refs.commits.map((item) => item.sha), ["2222222222222222222222222222222222222222", "3333333333333333333333333333333333333333"])
  assert.deepEqual(normalized.jobs.map((item) => item.job), [CLOSED, OPEN])
  assert.equal(stableStringify({ z: 1, a: { z: 2, a: 3 } }), "{\"a\":{\"a\":3,\"z\":2},\"z\":1}")
  assert.deepEqual(input, before, "normalization must not mutate the caller")
})

test("buildJobTimeline places intervals on the job clock and labels shared sessions", () => {
  const timeline = buildJobTimeline(CLOSED, sessions)
  assert.equal(timeline.job, CLOSED)
  assert.equal(timeline.sessions.length, 2)
  assert.deepEqual(timeline.sessions.map((item) => ({
    host: item.host,
    offset_ms: item.offset_ms,
    end_ms: item.end_ms,
    shared_with: item.shared_with,
  })), [
    { host: "claude-code", offset_ms: -1000, end_ms: 15000, shared_with: 0 },
    { host: "copilot-cli", offset_ms: 5000, end_ms: 15000, shared_with: 1 },
  ])
  assert.deepEqual(timeline.intervals.slice(0, 3), [
    { host: "claude-code", session_id: "11111111-1111-4111-8111-111111111111", kind: "turn", agent: 0, start_ms: -1000, end_ms: 3000 },
    { host: "claude-code", session_id: "11111111-1111-4111-8111-111111111111", kind: "tool", agent: 0, start_ms: 0, end_ms: 2000, tool: "shell", outcome: "error" },
    { host: "claude-code", session_id: "11111111-1111-4111-8111-111111111111", kind: "subagent", agent: 1, start_ms: 1000, end_ms: 6000 },
  ])
  assert.deepEqual(timeline.transitions, [
    { to: "processing", offset_ms: 0 },
    { to: "validating", offset_ms: 7000 },
    { to: "done", offset_ms: 14000 },
  ])
})

test("sessions without offsets count toward totals but do not enter the timeline", () => {
  const timeline = buildJobTimeline(OPEN, sessions)
  assert.equal(timeline.sessions.length, 2)
  assert.equal(timeline.sessions.filter((item) => item.offset_ms !== null).length, 1)
  assert.equal(timeline.sessions.find((item) => item.host === "claude-code").end_ms, null)
  assert.equal(timeline.intervals.every((item) => item.session_id !== "33333333-3333-4333-8333-333333333333"), true)
})

test("buildTimelines returns jobs in job-ID order and does not invent an unattributed job", () => {
  assert.deepEqual(buildTimelines(sessions).map((timeline) => timeline.job), [CLOSED, OPEN])
})

test("timeline observations and duplicate transitions are normalized deterministically", () => {
  const duplicated = sessions.map((session) => structuredClone(session))
  duplicated[1].jobs[0].transitions = [{ to: "processing", offset_ms: 2500 }]
  duplicated[1].jobs[0].session_offset_ms = 4000
  const timeline = buildJobTimeline(OPEN, duplicated)
  assert.deepEqual(timeline.transitions, [{ to: "processing", offset_ms: 2500 }])
  assert.deepEqual(timeline.observations, [{ status: "processing", offset_ms: null }])
})

test("timeline handles empty inputs and null observations without inventing records", () => {
  assert.deepEqual(buildTimelines([]), [])
  const one = structuredClone(sessions[0])
  one.jobs[0].observed = null
  const timeline = buildJobTimeline(CLOSED, [one])
  assert.deepEqual(timeline.observations, [])

  const same = buildJobTimeline(CLOSED, [one, structuredClone(one)])
  assert.equal(same.sessions.length, 2)
  assert.deepEqual(same.transitions, one.jobs[0].transitions)

  const nullOffsets = [structuredClone(sessions[1]), structuredClone(sessions[2])]
  nullOffsets[1].jobs = [structuredClone(nullOffsets[0].jobs[0])]
  nullOffsets[1].jobs[0].observed = { status: "paused", offset_ms: null }
  const nullTimeline = buildJobTimeline(OPEN, nullOffsets)
  assert.deepEqual(nullTimeline.observations, [
    { status: "processing", offset_ms: null },
    { status: "paused", offset_ms: null },
  ])

  assert.deepEqual(buildJobTimeline(OPEN, [sessions[2], sessions[1]]).sessions.map((entry) => entry.offset_ms), [2000, null])
})

test("transitions with unknown offsets sort after every known one instead of posing as zero", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [
    { to: "done", offset_ms: null },
    { to: "paused", offset_ms: null },
    { to: "processing", offset_ms: 500 },
    { to: "validating", offset_ms: -200 },
  ]
  assert.deepEqual(normalizePublished(one).jobs[0].transitions, [
    { to: "validating", offset_ms: -200 },
    { to: "processing", offset_ms: 500 },
    { to: "paused", offset_ms: null },
    { to: "done", offset_ms: null },
  ])
  const reversed = structuredClone(one)
  reversed.jobs[0].transitions.reverse()
  const expected = [
    { to: "validating", offset_ms: -200 },
    { to: "processing", offset_ms: 500 },
    { to: "paused", offset_ms: null },
    { to: "done", offset_ms: null },
  ]
  assert.deepEqual(buildJobTimeline(CLOSED, [one]).transitions, expected)
  assert.deepEqual(buildJobTimeline(CLOSED, [reversed]).transitions, expected)
})
