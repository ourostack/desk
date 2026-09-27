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
  assert.deepEqual(formulas.active_in_lead_ms, { class: "measured", value: 13000 })
  assert.deepEqual(formulas.active_before_card_ms, { class: "measured", value: 1000 })
  assert.deepEqual(formulas.busy_time_ms, { class: "measured", value: 27000 })
  assert.deepEqual(formulas.parallelism, { class: "inferred", value: 27 / 14, method: "busy_time_ms/active_time_ms" })
  assert.deepEqual(formulas.concurrent_sessions, { class: "inferred", value: { maximum: 2, average: 15 / 14 }, method: "active_session_interval_concurrency" })
  assert.deepEqual(formulas.concurrent_agents, { class: "inferred", value: { maximum: 2, average: 1.5 }, method: "active_agent_interval_concurrency" })
  // Each Claude and Copilot session lacks one wait kind, so each of those
  // totals is partial rather than a complete measurement.
  assert.deepEqual(formulas.waits, {
    human_wait_ms: { class: "measured", value: 2000, partial: true, uncovered_sessions: 1 },
    permission_wait_ms: { class: "measured", value: 1000, partial: true, uncovered_sessions: 1 },
    api_retry_ms: { class: "measured", value: 500 },
    compaction_ms: { class: "measured", value: 0 },
  })
  assert.deepEqual(formulas.longest_wait, {
    class: "measured",
    value: { kind: "human_wait", duration_ms: 2000, start_ms: 6000, end_ms: 8000 },
    partial: true,
    uncovered_sessions: 2,
  })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 13 / 14, censored: false, method: "active_in_lead_ms/lead_time_ms" })
  assert.deepEqual(formulas.lead_contributors, {
    class: "inferred",
    censored: false,
    method: "clipped_to_lead_window",
    value: [
      { key: "active_in_lead_ms", value_ms: 13000, share: 13 / 14 },
      { key: "human_wait_ms", value_ms: 2000, share: 2 / 14, partial: true, uncovered_sessions: 1 },
      { key: "permission_wait_ms", value_ms: 1000, share: 1 / 14, partial: true, uncovered_sessions: 1 },
      { key: "api_retry_ms", value_ms: 500, share: 0.5 / 14 },
      { key: "queue_before_start_ms", value_ms: 0, share: 0 },
      { key: "compaction_ms", value_ms: 0, share: 0 },
    ],
  })
  assert.deepEqual(formulas.references, {
    class: "measured",
    value: {
      public_pull_requests: [{ repo: "ourostack/desk", number: 7 }, { repo: "ourostack/desk", number: 8 }],
      public_prs: 2,
      public_commits: 2,
      private_prs: 1,
      private_commits: 2,
    },
  })
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
  assert.deepEqual(formulas.sessions, { class: "measured", value: { bound: 2, timeline: 1, shared: 1, shared_with_jobs: 1 } })
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 12000, censored: true, basis: "latest_session_end" })
  assert.deepEqual(formulas.queue_before_start_ms, { class: "measured", value: 2000 })
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 8000 })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 2 / 3, censored: true, method: "active_in_lead_ms/lead_time_ms" })
  // The only timed session is a Copilot session, which records no human
  // waits: that total is unavailable, never a measured zero.
  assert.deepEqual(formulas.waits.human_wait_ms, { class: "unavailable", value: null, reason: "host_does_not_record" })
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

test("a current cancellation overrides an earlier done transition", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions.push({ to: "cancelled", offset_ms: 15000 })
  one.jobs[0].observed = { status: "cancelled", offset_ms: 15000 }
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.status, { class: "measured", value: "cancelled" })
  assert.deepEqual(formulas.lead_time_ms, { class: "unavailable", value: null, reason: "cancelled" })
})

test("a job with no offsets retains coverage and signals but reports timeline formulas unavailable", () => {
  const one = structuredClone(sessions[1])
  const formulas = calculateFormulas(buildJobTimeline(OPEN, [one]))
  assert.deepEqual(formulas.sessions, { class: "measured", value: { bound: 1, timeline: 0, shared: 0, shared_with_jobs: 0 } })
  for (const field of ["lead_time_ms", "queue_before_start_ms", "active_time_ms", "active_in_lead_ms", "active_before_card_ms", "busy_time_ms", "parallelism", "concurrent_sessions", "concurrent_agents", "flow_efficiency", "longest_wait", "lead_contributors"]) {
    assert.deepEqual(formulas[field], { class: "unavailable", value: null, reason: "job_offsets_unavailable" }, field)
  }
  for (const wait of Object.values(formulas.waits)) {
    assert.deepEqual(wait, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
  }
  assert.equal(formulas.rework_signals.session_retouches.value, 0)
})

test("a done declaration without a usable job offset is unavailable rather than treated as open", () => {
  const one = structuredClone(sessions[1])
  one.jobs[0].observed = { status: "done", offset_ms: null }
  const formulas = calculateFormulas(buildJobTimeline(OPEN, [one]))
  assert.deepEqual(formulas.status, { class: "declared", value: "done" })
  assert.deepEqual(formulas.lead_time_ms, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
})

test("cancelled observation, nonterminal transition, and absent status retain their evidence classes", () => {
  let one = structuredClone(sessions[0])
  one.jobs[0].transitions = []
  one.jobs[0].observed = { status: "cancelled", offset_ms: 9000 }
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [one])).status, { class: "declared", value: "cancelled" })

  one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "paused", offset_ms: 5000 }]
  one.jobs[0].observed = null
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [one])).status, { class: "measured", value: "paused" })

  one.jobs[0].transitions = []
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [one])).status, { class: "unavailable", value: null, reason: "status_unavailable" })
})

test("zero active time and zero lead time stay explicit", () => {
  let one = structuredClone(sessions[0])
  one.intervals = one.intervals.filter((entry) => entry.kind === "human_wait")
  let formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 0 })
  assert.deepEqual(formulas.parallelism, { class: "unavailable", value: null, reason: "no_active_intervals" })
  assert.deepEqual(formulas.concurrent_sessions, { class: "unavailable", value: null, reason: "no_active_intervals" })
  assert.deepEqual(formulas.concurrent_agents, { class: "unavailable", value: null, reason: "no_active_intervals" })

  one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "done", offset_ms: 0 }]
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.flow_efficiency, { class: "unavailable", value: null, reason: "zero_lead_time" })
})

test("a timed job with no waits reports the absence rather than inventing zero-duration evidence", () => {
  const one = structuredClone(sessions[0])
  one.intervals = one.intervals.filter((entry) => !entry.kind.endsWith("_wait"))
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.longest_wait, { class: "unavailable", value: null, reason: "no_wait_intervals" })
})

test("disjoint activity and tied waits use deterministic interval ordering", () => {
  const one = structuredClone(sessions[0])
  one.intervals = [
    { kind: "turn", agent: 0, start_ms: 0, end_ms: 1000 },
    { kind: "subagent", agent: 1, start_ms: 0, end_ms: 500 },
    { kind: "tool", agent: 0, tool: "shell", outcome: "ok", start_ms: 2000, end_ms: 3000 },
    { kind: "permission_wait", agent: 0, start_ms: 0, end_ms: 1000 },
    { kind: "api_retry", agent: 0, start_ms: 0, end_ms: 1000 },
    { kind: "human_wait", agent: 0, start_ms: 1000, end_ms: 2000 },
    { kind: "human_wait", agent: 0, start_ms: 0, end_ms: 1000 },
  ]
  one.unavailable.push({ field: "permission_waits", reason: "capped" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.equal(formulas.active_time_ms.value, 2000)
  assert.deepEqual(formulas.longest_wait.value, { kind: "human_wait", duration_ms: 1000, start_ms: -1000, end_ms: 0 })
  assert.deepEqual(formulas.unavailable.value.filter((entry) => entry.field === "permission_waits"), [
    { field: "permission_waits", reason: "capped", count: 1 },
    { field: "permission_waits", reason: "host_does_not_record", count: 1 },
  ])
})

test("a done transition before the job clock starts clamps lead time to zero", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "done", offset_ms: -1 }]
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 0, censored: false, basis: "first_done_transition" })
  assert.deepEqual(formulas.flow_efficiency, { class: "unavailable", value: null, reason: "zero_lead_time" })
})

test("a wait kind every timed session lacks is unavailable, one some sessions lack is partial, and mixed reasons are listed", () => {
  const claude = structuredClone(sessions[0])
  const copilot = structuredClone(sessions[2])
  copilot.unavailable.push({ field: "permission_waits", reason: "log_truncated" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [claude, copilot]))
  assert.deepEqual(formulas.waits.permission_wait_ms, {
    class: "unavailable",
    value: null,
    reason: "mixed",
    reasons: ["host_does_not_record", "log_truncated"],
  })
  assert.deepEqual(formulas.waits.human_wait_ms, { class: "measured", value: 2000, partial: true, uncovered_sessions: 1 })
  assert.equal(formulas.lead_contributors.value.some((entry) => entry.key === "permission_wait_ms"), false)
  assert.equal(formulas.longest_wait.value.kind, "human_wait")

  // A session bound with a null offset never counts toward timed coverage.
  const untimed = structuredClone(sessions[1])
  untimed.jobs[0].job = CLOSED
  const withUntimed = calculateFormulas(buildJobTimeline(CLOSED, [structuredClone(sessions[2]), untimed]))
  assert.deepEqual(withUntimed.waits.human_wait_ms, { class: "unavailable", value: null, reason: "host_does_not_record" })
  assert.deepEqual(withUntimed.active_time_ms.class, "measured")
  assert.equal(withUntimed.active_time_ms.partial, undefined)
})

test("missing tool durations make active-time values partial, never complete and never unavailable", () => {
  const partial = structuredClone(sessions[0])
  partial.unavailable.push({ field: "tool_durations", reason: "log_truncated" })
  let formulas = calculateFormulas(buildJobTimeline(CLOSED, [partial, structuredClone(sessions[2])]))
  const mark = { partial: true, uncovered_sessions: 1 }
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 14000, ...mark })
  assert.deepEqual(formulas.active_in_lead_ms, { class: "measured", value: 13000, ...mark })
  assert.deepEqual(formulas.active_before_card_ms, { class: "measured", value: 1000, ...mark })
  assert.deepEqual(formulas.busy_time_ms, { class: "measured", value: 27000, ...mark })
  assert.deepEqual(formulas.parallelism, { class: "inferred", value: 27 / 14, method: "busy_time_ms/active_time_ms", ...mark })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 13 / 14, censored: false, method: "active_in_lead_ms/lead_time_ms", ...mark })
  assert.deepEqual(formulas.lead_contributors.value[0], { key: "active_in_lead_ms", value_ms: 13000, share: 13 / 14, ...mark })

  // An open session with an unfinished tool call still has its turns, so its
  // active time is partial, not unavailable.
  const open = structuredClone(sessions[0])
  open.session.ended = false
  open.session.end_reason = null
  open.unavailable.push({ field: "tool_durations", reason: "session_open" })
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [open]))
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 7000, ...mark })
  assert.deepEqual(formulas.active_in_lead_ms, { class: "measured", value: 6000, ...mark })
  assert.deepEqual(formulas.active_before_card_ms, { class: "measured", value: 1000, ...mark })
  assert.deepEqual(formulas.busy_time_ms, { class: "measured", value: 11000, ...mark })
  assert.deepEqual(formulas.parallelism, { class: "inferred", value: 11 / 7, method: "busy_time_ms/active_time_ms", ...mark })
  assert.equal(formulas.concurrent_sessions.partial, true)
  assert.equal(formulas.concurrent_agents.uncovered_sessions, 1)
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 6000 / 14000, censored: false, method: "active_in_lead_ms/lead_time_ms", ...mark })
  assert.deepEqual(formulas.lead_contributors.value.find((entry) => entry.key === "active_in_lead_ms"), { key: "active_in_lead_ms", value_ms: 6000, share: 6000 / 14000, ...mark })
})

test("active time is unavailable only when every timed session lacks its turns, with the turns reason", () => {
  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "turns", reason: "log_truncated" }, { field: "tool_durations", reason: "capped" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [lacking]))
  for (const field of ["active_time_ms", "active_in_lead_ms", "active_before_card_ms", "busy_time_ms", "parallelism", "concurrent_sessions", "concurrent_agents", "flow_efficiency"]) {
    assert.deepEqual(formulas[field], { class: "unavailable", value: null, reason: "log_truncated" }, field)
  }
  assert.equal(formulas.lead_contributors.value.some((entry) => entry.key === "active_in_lead_ms"), false)

  // One session without turns and one with only a tool-duration gap: both are uncovered, neither decides alone.
  const toolGap = structuredClone(sessions[2])
  toolGap.unavailable.push({ field: "tool_durations", reason: "session_open" })
  const mixed = calculateFormulas(buildJobTimeline(CLOSED, [lacking, toolGap]))
  assert.deepEqual(mixed.active_time_ms, { class: "measured", value: 14000, partial: true, uncovered_sessions: 2 })
})

test("the API retry signal is unavailable when no session records retries and partial when some do not", () => {
  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "api_retries", reason: "log_missing" })
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [lacking])).rework_signals.api_retries, { class: "unavailable", value: null, reason: "log_missing" })
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [lacking, structuredClone(sessions[2])])).rework_signals.api_retries, {
    class: "inferred",
    value: 1,
    partial: true,
    uncovered_sessions: 1,
  })
})

test("a job whose sessions record no wait kind reports the longest wait unavailable", () => {
  const one = structuredClone(sessions[0])
  one.unavailable.push(
    { field: "human_waits", reason: "log_missing" },
    { field: "api_retries", reason: "log_missing" },
    { field: "turns", reason: "log_missing" },
  )
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.longest_wait, { class: "unavailable", value: null, reason: "wait_fields_unavailable" })
})

test("a session starting long before the task card never pushes flow efficiency or lead shares past the lead window", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].session_offset_ms = -10000
  one.intervals = [
    { kind: "turn", agent: 0, start_ms: 0, end_ms: 12000 },
    { kind: "human_wait", agent: 0, start_ms: 5000, end_ms: 13000 },
  ]
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 14000, censored: false, basis: "first_done_transition" })
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 12000 })
  assert.deepEqual(formulas.active_before_card_ms, { class: "measured", value: 10000 })
  assert.deepEqual(formulas.active_in_lead_ms, { class: "measured", value: 2000 })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 2000 / 14000, censored: false, method: "active_in_lead_ms/lead_time_ms" })
  assert.deepEqual(formulas.queue_before_start_ms, { class: "measured", value: 0 })
  // The wait runs from -5000 to 3000 on the job clock: 3000 ms of it is inside the lead window.
  assert.deepEqual(formulas.lead_contributors.value.slice(0, 2), [
    { key: "human_wait_ms", value_ms: 3000, share: 3000 / 14000 },
    { key: "active_in_lead_ms", value_ms: 2000, share: 2000 / 14000 },
  ])
  for (const entry of formulas.lead_contributors.value) assert.ok(entry.share <= 1, entry.key)

  const late = structuredClone(sessions[0])
  late.jobs[0].session_offset_ms = 20000
  const lateFormulas = calculateFormulas(buildJobTimeline(CLOSED, [late]))
  assert.deepEqual(lateFormulas.lead_contributors.value.find((entry) => entry.key === "queue_before_start_ms"), { key: "queue_before_start_ms", value_ms: 14000, share: 1 })
  assert.deepEqual(lateFormulas.active_in_lead_ms, { class: "measured", value: 0 })
})

test("the latest terminal transition decides status, so a reopened job reports its current state", () => {
  const reopened = structuredClone(sessions[0])
  reopened.jobs[0].transitions = [
    { to: "cancelled", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
    { to: "done", offset_ms: 14000 },
  ]
  let formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.status, { class: "measured", value: "done" })
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 14000, censored: false, basis: "first_done_transition" })

  // Reopened after done: the job is open again, so lead time and flow
  // efficiency are censored like any open job's, and the done stays in history.
  reopened.jobs[0].transitions = [
    { to: "processing", offset_ms: 0 },
    { to: "done", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
  ]
  const timeline = buildJobTimeline(CLOSED, [reopened])
  formulas = calculateFormulas(timeline)
  assert.deepEqual(formulas.status, { class: "measured", value: "processing" })
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 15000, censored: true, basis: "latest_session_end" })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 6000 / 15000, censored: true, method: "active_in_lead_ms/lead_time_ms" })
  assert.equal(formulas.lead_contributors.censored, true)
  assert.deepEqual(timeline.transitions.map((entry) => entry.to), ["processing", "done", "processing"])

  // A done observation cannot close a job whose latest transition reopened it.
  reopened.jobs[0].observed = { status: "done", offset_ms: 150 }
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.status, { class: "measured", value: "processing" })
  assert.equal(formulas.lead_time_ms.censored, true)

  reopened.jobs[0].transitions = [{ to: "cancelled", offset_ms: 100 }, { to: "processing", offset_ms: 200 }]
  reopened.jobs[0].observed = null
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.status, { class: "measured", value: "processing" })
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 15000, censored: true, basis: "latest_session_end" })
})

test("a done transition with no offset is never a measured zero lead time", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: null }]
  one.jobs[0].observed = null
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.status, { class: "measured", value: "done" })
  assert.deepEqual(formulas.lead_time_ms, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
  assert.deepEqual(formulas.flow_efficiency, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
  assert.deepEqual(formulas.active_in_lead_ms, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
  assert.deepEqual(formulas.lead_contributors, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })

  const cancelled = structuredClone(sessions[0])
  cancelled.jobs[0].transitions = [{ to: "cancelled", offset_ms: null }]
  cancelled.jobs[0].observed = null
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [cancelled])).status, { class: "measured", value: "cancelled" })
})

test("lead contributors are unavailable for zero lead time and for lead time without a job clock", () => {
  const zero = structuredClone(sessions[0])
  zero.jobs[0].transitions = [{ to: "done", offset_ms: 0 }]
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [zero])).lead_contributors, { class: "unavailable", value: null, reason: "zero_lead_time" })

  const untimed = structuredClone(sessions[0])
  untimed.jobs[0].session_offset_ms = null
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [untimed]))
  assert.equal(formulas.lead_time_ms.class, "measured")
  assert.deepEqual(formulas.lead_contributors, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
  assert.deepEqual(formulas.flow_efficiency, { class: "unavailable", value: null, reason: "job_offsets_unavailable" })
})

test("shared work counts distinct other jobs and public pull requests are named once", () => {
  const first = structuredClone(sessions[2])
  const second = structuredClone(sessions[2])
  second.session.id = "55555555-5555-4555-8555-555555555555"
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [first, second]))
  assert.deepEqual(formulas.sessions.value, { bound: 2, timeline: 2, shared: 2, shared_with_jobs: 1 })
  assert.deepEqual(formulas.references.value.public_pull_requests, [{ repo: "ourostack/desk", number: 8 }])
  assert.equal(formulas.references.value.public_prs, 1)
  assert.equal(formulas.references.value.public_commits, 1)
  assert.equal(formulas.references.value.private_commits, 2)
})
