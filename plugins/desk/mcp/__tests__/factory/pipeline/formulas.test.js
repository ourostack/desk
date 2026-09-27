import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../src/factory/pipeline/formulas.js"
import { buildJobTimeline } from "../../../src/factory/pipeline/timeline.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FACTS = path.join(here, "..", "fixtures", "store", "facts")
const sessions = readdirSync(FACTS).sort().map((name) => JSON.parse(readFileSync(path.join(FACTS, name), "utf8")))
const CLOSED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OPEN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

test("closed-job formulas match hand-computed overlapping session and parallel-agent values", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, sessions))
  assert.deepEqual(formulas.status, { class: "measured", value: "done" })
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 14000, censored: false, basis: "first_done_transition" })
  assert.deepEqual(formulas.queue_before_start_ms, { class: "measured", value: 0 })
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 14000 })
  assert.deepEqual(formulas.busy_time_ms, { class: "measured", value: 27000 })
  assert.deepEqual(formulas.parallelism, { class: "inferred", value: 27 / 14, method: "busy_time_ms/active_time_ms" })
  assert.deepEqual(formulas.concurrent_sessions, { class: "inferred", value: { maximum: 2, average: 15 / 14 }, method: "active_session_interval_concurrency" })
  assert.deepEqual(formulas.concurrent_agents, { class: "inferred", value: { maximum: 2, average: 1.5 }, method: "active_agent_interval_concurrency" })
  assert.deepEqual(formulas.waits, {
    human_wait_ms: { class: "measured", value: 2000 },
    permission_wait_ms: { class: "measured", value: 1000 },
    api_retry_ms: { class: "measured", value: 500 },
    compaction_ms: { class: "measured", value: 0 },
  })
  assert.deepEqual(formulas.longest_wait, {
    class: "measured",
    value: { kind: "human_wait", duration_ms: 2000, start_ms: 6000, end_ms: 8000 },
  })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 1, censored: false, method: "active_time_ms/lead_time_ms" })
  assert.deepEqual(formulas.rework_signals, {
    tool_failures: { class: "inferred", value: 2 },
    tool_retries: { class: "inferred", value: 3 },
    api_retries: { class: "inferred", value: 1 },
    session_retouches: { class: "inferred", value: 1 },
  })
  assert.deepEqual(formulas.first_pass_yield, { class: "unavailable", value: null, reason: "not_collected_in_slice_1" })
})

test("open-job lead and flow are censored at the latest positioned session end", () => {
  const formulas = calculateFormulas(buildJobTimeline(OPEN, sessions))
  assert.deepEqual(formulas.status, { class: "declared", value: "processing" })
  assert.deepEqual(formulas.sessions, { class: "measured", value: { bound: 2, timeline: 1, shared: 1 } })
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 12000, censored: true, basis: "latest_session_end" })
  assert.deepEqual(formulas.queue_before_start_ms, { class: "measured", value: 2000 })
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 8000 })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 2 / 3, censored: true, method: "active_time_ms/lead_time_ms" })
  assert.deepEqual(formulas.concurrent_sessions.value, { maximum: 1, average: 1 })
  assert.deepEqual(formulas.concurrent_agents.value, { maximum: 2, average: 1.5 })
})

test("a done observation supplies declared lead time only when no done transition exists", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "validating", offset_ms: 7000 }]
  one.jobs[0].observed = { status: "done", offset_ms: 9000 }
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.lead_time_ms, { class: "declared", value: 9000, censored: false, basis: "terminal_observation" })
  assert.deepEqual(formulas.status, { class: "declared", value: "done" })
})

test("cancelled jobs have unavailable delivery lead time and flow efficiency", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "cancelled", offset_ms: 9000 }]
  one.jobs[0].observed = { status: "cancelled", offset_ms: 9000 }
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.status, { class: "measured", value: "cancelled" })
  assert.deepEqual(formulas.lead_time_ms, { class: "unavailable", value: null, reason: "cancelled" })
  assert.deepEqual(formulas.flow_efficiency, { class: "unavailable", value: null, reason: "cancelled" })
})

test("a job with no offsets retains coverage and signals but reports timeline formulas unavailable", () => {
  const one = structuredClone(sessions[1])
  const formulas = calculateFormulas(buildJobTimeline(OPEN, [one]))
  assert.deepEqual(formulas.sessions, { class: "measured", value: { bound: 1, timeline: 0, shared: 0 } })
  for (const field of ["lead_time_ms", "queue_before_start_ms", "active_time_ms", "busy_time_ms", "parallelism", "concurrent_sessions", "concurrent_agents", "flow_efficiency", "longest_wait"]) {
    assert.deepEqual(formulas[field], { class: "unavailable", value: null, reason: "job_offsets_unavailable" }, field)
  }
  for (const wait of Object.values(formulas.waits)) {
    assert.deepEqual(wait, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
  }
  assert.equal(formulas.rework_signals.session_retouches.value, 0)
})
