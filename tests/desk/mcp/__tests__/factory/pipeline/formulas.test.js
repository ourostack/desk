import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { buildJobTimeline } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"

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

  // Reopened and closed again: lead time ends at the reclosing, the first
  // done after the last reopen, not at the first close.
  reopened.jobs[0].transitions = [
    { to: "processing", offset_ms: 0 },
    { to: "done", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
    { to: "done", offset_ms: 300 },
  ]
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.status, { class: "measured", value: "done" })
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 300, censored: false, basis: "first_done_transition" })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 300 / 300, censored: false, method: "active_in_lead_ms/lead_time_ms" })

  // Consecutive terminal transitions after the last reopen: the first done of that stretch ends lead time.
  reopened.jobs[0].transitions = [
    { to: "processing", offset_ms: 0 },
    { to: "done", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
    { to: "done", offset_ms: 4000 },
    { to: "done", offset_ms: 9000 },
  ]
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.lead_time_ms, { class: "measured", value: 4000, censored: false, basis: "first_done_transition" })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 4000 / 4000, censored: false, method: "active_in_lead_ms/lead_time_ms" })

  reopened.jobs[0].transitions = [
    { to: "processing", offset_ms: 0 },
    { to: "done", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
  ]
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

const JOB_A = "cccccccccccccccccccccccccccccccc"
const JOB_B = "dddddddddddddddddddddddddddddddd"

// One session, three workers. Job A owns workers 0 and 1, job B owns worker 2.
function splitSession(overrides = {}) {
  return {
    schema: "desk.factory.published/1",
    session: { host: "claude-code", id: "55555555-5555-4555-8555-555555555555", host_version: "2.1.0", entrypoint: "cli", duration_ms: 20000, ended: true, end_reason: "complete" },
    plugins: [{ name: "desk", version: "3.2.0-alpha.48" }],
    models: [],
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }, { n: 2, parent: 0, model: "model-alpha" }],
    intervals: [
      { kind: "turn", agent: 0, start_ms: 0, end_ms: 4000 },
      { kind: "tool", agent: 0, tool: "shell", outcome: "ok", start_ms: 1000, end_ms: 2000 },
      { kind: "tool", agent: 1, tool: "edit", outcome: "error", start_ms: 3000, end_ms: 6000 },
      { kind: "turn", agent: 2, start_ms: 8000, end_ms: 11000 },
      { kind: "tool", agent: 2, tool: "shell", outcome: "error", start_ms: 9000, end_ms: 10000 },
    ],
    counts: { tool_calls: { edit: 1, shell: 2 }, tool_failures: { edit: 1, shell: 1 }, tool_retries: 2, api_retries: 1, compactions: 1 },
    refs: { prs: [], commits: [], private: { prs: 0, commits: 0 } },
    jobs: [
      { job: JOB_A, agents: [0, 1], basis: ["desk_tool"], session_offset_ms: 0, transitions: [], observed: { status: "processing", offset_ms: null } },
      { job: JOB_B, agents: [2], basis: ["spawn_brief"], session_offset_ms: 0, transitions: [], observed: { status: "processing", offset_ms: null } },
    ],
    unavailable: [],
    ...overrides,
  }
}

test("a session split across jobs credits each job only its workers", () => {
  const split = [splitSession()]
  const a = calculateFormulas(buildJobTimeline(JOB_A, split))
  const b = calculateFormulas(buildJobTimeline(JOB_B, split))
  // Whole session: turns 0-4000 and 8000-11000, tools 3000-6000 -> union
  // [0,6000] + [8000,11000] = 9000 ms.
  // Job A (workers 0, 1): [0,4000] + [3000,6000] -> [0,6000] = 6000 ms.
  // Job B (worker 2): [8000,11000] = 3000 ms.
  // The two are disjoint, so 6000 + 3000 = 9000 = the session's active time.
  assert.deepEqual(a.active_time_ms, { class: "measured", value: 6000 })
  assert.deepEqual(b.active_time_ms, { class: "measured", value: 3000 })
  assert.equal(a.active_time_ms.value + b.active_time_ms.value, 9000)
  // Busy time is the plain sum of the job's own intervals (4000+1000+3000, 3000+1000).
  assert.equal(a.busy_time_ms.value, 8000)
  assert.equal(b.busy_time_ms.value, 4000)
  assert.equal(calculateFormulas(buildJobTimeline(JOB_A, [splitSession({ jobs: [{ ...splitSession().jobs[0], agents: [0, 1, 2] }] })])).active_time_ms.value, 9000)

  const partial = { partial: true, uncovered_sessions: 1, partial_reasons: ["worker_split"] }
  assert.deepEqual(a.tool_calls_by_kind, { class: "measured", value: { edit: 1, shell: 1 }, ...partial })
  assert.deepEqual(b.tool_calls_by_kind, { class: "measured", value: { shell: 1 }, ...partial })
  assert.deepEqual(a.rework_signals.tool_failures, { class: "inferred", value: 1, ...partial })
  assert.deepEqual(b.rework_signals.tool_failures, { class: "inferred", value: 1, ...partial })
  // Retries have no worker: a job whose only session is split cannot say how many were its own, and an unknown count is not a measured zero.
  assert.deepEqual(a.rework_signals.tool_retries, { class: "unavailable", value: null, reason: "worker_split" })
  assert.deepEqual(b.rework_signals.api_retries, { class: "unavailable", value: null, reason: "worker_split" })
  assert.deepEqual(a.rework_signals.api_retries, { class: "unavailable", value: null, reason: "worker_split" })
})

test("a job with some whole sessions sums their retries and marks the measure partial; a split session also missing the field says mixed", () => {
  const whole = splitSession({ session: { ...splitSession().session, id: "66666666-6666-4666-8666-666666666666" } })
  whole.jobs = [{ ...whole.jobs[0], agents: [0, 1, 2] }]
  const formulas = calculateFormulas(buildJobTimeline(JOB_A, [splitSession(), whole]))
  const partial = { partial: true, uncovered_sessions: 1, partial_reasons: ["worker_split"] }
  assert.deepEqual(formulas.rework_signals.tool_retries, { class: "inferred", value: 2, ...partial })
  assert.deepEqual(formulas.rework_signals.api_retries, { class: "inferred", value: 1, ...partial })
  const lacking = splitSession()
  lacking.unavailable.push({ field: "api_retries", reason: "log_missing" })
  assert.deepEqual(calculateFormulas(buildJobTimeline(JOB_A, [lacking])).rework_signals.api_retries, { class: "unavailable", value: null, reason: "mixed", reasons: ["log_missing", "worker_split"] })
})

test("a binding that covers every worker behaves like the legacy session-level binding", () => {
  const legacy = splitSession()
  delete legacy.jobs[0].agents
  legacy.jobs = [legacy.jobs[0]]
  const covering = splitSession()
  covering.jobs[0].agents = [0, 1, 2]
  covering.jobs = [covering.jobs[0]]
  const legacyFormulas = calculateFormulas(buildJobTimeline(JOB_A, [legacy]))
  const coveringFormulas = calculateFormulas(buildJobTimeline(JOB_A, [covering]))
  assert.deepEqual(coveringFormulas, legacyFormulas)
  assert.deepEqual(legacyFormulas.tool_calls_by_kind, { class: "measured", value: { edit: 1, shell: 2 } })
  assert.deepEqual(legacyFormulas.rework_signals.tool_retries, { class: "inferred", value: 2 })
})

test("a PR is credited to the job of the worker that opened it", () => {
  const prs = [
    { repo: "ourostack/desk", number: 1, agent: 0 },
    { repo: "ourostack/desk", number: 2, agent: 2 },
    { repo: "ourostack/desk", number: 3 },
  ]
  const shared = [splitSession({ refs: { prs, commits: [], private: { prs: 0, commits: 0 } } })]
  const numbers = (job, input) => calculateFormulas(buildJobTimeline(job, input)).references.value.public_pull_requests.map((pr) => pr.number)
  assert.deepEqual(numbers(JOB_A, shared), [1])
  assert.deepEqual(numbers(JOB_B, shared), [2])
  // A PR with no worker credits a job only when the session binds exactly one job.
  const single = splitSession({ refs: { prs, commits: [], private: { prs: 0, commits: 0 } } })
  single.jobs = [single.jobs[0]]
  assert.deepEqual(numbers(JOB_A, [single]), [1, 3])
  // A legacy binding (no agents) counts every PR.
  const legacy = splitSession({ refs: { prs, commits: [], private: { prs: 0, commits: 0 } } })
  delete legacy.jobs[1].agents
  assert.deepEqual(numbers(JOB_B, [legacy]), [1, 2, 3])
})

const REFS = (prs, commits = []) => ({ prs, commits, private: { prs: 0, commits: 0 } })
const prNumbers = (job, input) => calculateFormulas(buildJobTimeline(job, input)).references.value.public_pull_requests.map((pr) => pr.number)
const referencesOf = (job, input) => calculateFormulas(buildJobTimeline(job, input)).references

test("a pull request whose worker is shared by several jobs is credited to none of them", () => {
  const prs = [1, 2, 3].map((number) => ({ repo: "ourostack/desk", number, agent: 0 }))
  const session = splitSession({ refs: REFS(prs) })
  session.jobs = [JOB_A, JOB_B, "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"].map((job) => ({ ...splitSession().jobs[0], job, agents: [0] }))
  for (const job of session.jobs.map((binding) => binding.job)) {
    const references = referencesOf(job, [session])
    assert.deepEqual(references.value.public_pull_requests, [])
    assert.equal(references.value.public_prs, 0)
    assert.equal(references.partial, true)
    assert.equal(references.uncovered_sessions, 1)
    assert.deepEqual(references.partial_reasons, ["worker_shared"])
  }
})

test("a pull request from a worker that belongs to one job alone is credited to that job only", () => {
  const prs = [{ repo: "ourostack/desk", number: 1, agent: 0 }, { repo: "ourostack/desk", number: 2, agent: 1 }]
  const session = splitSession({ refs: REFS(prs) })
  session.jobs[0].agents = [0, 1]
  session.jobs[1].agents = [0]
  assert.deepEqual(prNumbers(JOB_A, [session]), [2])
  assert.deepEqual(prNumbers(JOB_B, [session]), [])
  assert.deepEqual(referencesOf(JOB_A, [session]).partial_reasons, ["worker_shared"])
  // A listing every worker still yields the shared worker's PR to nobody.
  session.jobs[0].agents = [0, 1, 2]
  assert.deepEqual(prNumbers(JOB_A, [session]), [2])
})

test("a pull request with no worker in a multi-job per-worker session is credited to none", () => {
  const prs = [{ repo: "ourostack/desk", number: 3 }]
  const multi = splitSession({ refs: REFS(prs) })
  assert.deepEqual(prNumbers(JOB_A, [multi]), [])
  assert.deepEqual(referencesOf(JOB_A, [multi]).partial_reasons, ["worker_shared"])
  const single = splitSession({ refs: REFS(prs) })
  single.jobs = [single.jobs[0]]
  assert.deepEqual(prNumbers(JOB_A, [single]), [3])
  assert.equal(Object.hasOwn(referencesOf(JOB_A, [single]), "partial"), false)
})

test("commits in a multi-job per-worker session are credited to none; in a single-job session they are credited", () => {
  const commits = [{ repo: "ourostack/desk", sha: "a".repeat(40) }, { repo: "ourostack/desk", sha: "b".repeat(40) }]
  const multi = splitSession({ refs: REFS([], commits) })
  assert.equal(referencesOf(JOB_A, [multi]).value.public_commits, 0)
  assert.deepEqual(referencesOf(JOB_A, [multi]).partial_reasons, ["worker_shared"])
  const single = splitSession({ refs: REFS([], commits) })
  single.jobs = [single.jobs[0]]
  assert.equal(referencesOf(JOB_A, [single]).value.public_commits, 2)
  assert.equal(Object.hasOwn(referencesOf(JOB_A, [single]), "partial"), false)
  // Nothing withheld, nothing to mark: a multi-job session with no references is not partial.
  assert.equal(Object.hasOwn(referencesOf(JOB_A, [splitSession()]), "partial"), false)
})

test("legacy bindings keep every reference", () => {
  const prs = [{ repo: "ourostack/desk", number: 1, agent: 0 }, { repo: "ourostack/desk", number: 2 }]
  const commits = [{ repo: "ourostack/desk", sha: "c".repeat(40) }]
  const session = splitSession({ refs: REFS(prs, commits) })
  delete session.jobs[0].agents
  delete session.jobs[1].agents
  for (const job of [JOB_A, JOB_B]) {
    const references = referencesOf(job, [session])
    assert.deepEqual(references.value.public_pull_requests.map((pr) => pr.number), [1, 2])
    assert.equal(references.value.public_commits, 1)
    assert.equal(Object.hasOwn(references, "partial"), false)
  }
})

test("time from a worker that several jobs share is partial with worker_shared, and is not split", () => {
  const shared = splitSession()
  shared.jobs[0].agents = [0, 1]
  shared.jobs[1].agents = [0, 2]
  const a = calculateFormulas(buildJobTimeline(JOB_A, [shared]))
  const b = calculateFormulas(buildJobTimeline(JOB_B, [shared]))
  const partial = { partial: true, uncovered_sessions: 1, partial_reasons: ["worker_shared"] }
  // Worker 0 is in both jobs and keeps its whole time in each: A is [0,6000], B is [0,4000] + [8000,11000].
  assert.deepEqual(a.active_time_ms, { class: "measured", value: 6000, ...partial })
  assert.deepEqual(b.active_time_ms, { class: "measured", value: 7000, ...partial })
  assert.deepEqual(a.busy_time_ms, { class: "measured", value: 8000, ...partial })
  // Only the time is marked: the tool measures follow each job's own tool intervals and are marked worker_split.
  assert.deepEqual(a.tool_calls_by_kind.partial_reasons, ["worker_split"])
})

test("disjoint workers, legacy bindings and a lone job are not marked worker_shared", () => {
  const disjoint = calculateFormulas(buildJobTimeline(JOB_A, [splitSession()]))
  assert.equal(Object.hasOwn(disjoint.active_time_ms, "partial_reasons"), false)
  const legacySibling = splitSession()
  delete legacySibling.jobs[1].agents
  assert.equal(Object.hasOwn(calculateFormulas(buildJobTimeline(JOB_A, [legacySibling])).active_time_ms, "partial"), false)
  const legacyOwn = splitSession()
  delete legacyOwn.jobs[0].agents
  assert.equal(Object.hasOwn(calculateFormulas(buildJobTimeline(JOB_A, [legacyOwn])).active_time_ms, "partial"), false)
  const alone = splitSession()
  alone.jobs = [alone.jobs[0]]
  assert.equal(Object.hasOwn(calculateFormulas(buildJobTimeline(JOB_A, [alone])).active_time_ms, "partial"), false)
})

test("a job that shares workers in one session and not in another counts only the shared one as uncovered", () => {
  const shared = splitSession()
  shared.jobs[1].agents = [1]
  const other = splitSession()
  other.session.id = "66666666-6666-4666-8666-666666666666"
  const formulas = calculateFormulas(buildJobTimeline(JOB_A, [shared, other]))
  assert.equal(formulas.active_time_ms.uncovered_sessions, 1)
  assert.deepEqual(formulas.active_time_ms.partial_reasons, ["worker_shared"])
})
