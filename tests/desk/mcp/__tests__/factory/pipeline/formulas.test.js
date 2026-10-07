import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, readdirSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { FORMULA_IDS, NOT_FED, NUMBER_STATES, reasonsOf, stateOf, withState } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"
import { buildJobTimeline } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"

const S = (result, state, reasons = []) => ({ ...result, state, reasons })
const here = path.dirname(fileURLToPath(import.meta.url))
const FACTS = path.join(here, "..", "fixtures", "store", "facts")
const sessions = readdirSync(FACTS).sort().map((name) => JSON.parse(readFileSync(path.join(FACTS, name), "utf8")))
const CLOSED = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const OPEN = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

test("closed-job formulas match hand-computed overlapping session and parallel-agent values", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, sessions))
  assert.deepEqual(formulas.status, S({ class: "measured", value: "done" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "measured", value: 14000, censored: false, basis: "first_done_transition" }, "measured"))
  assert.deepEqual(formulas.queue_before_start_ms, S({ class: "measured", value: 0, basis: "first_captured_session" }, "measured"))
  assert.deepEqual(formulas.active_time_ms, S({ class: "measured", value: 14000 }, "measured"))
  assert.deepEqual(formulas.active_in_lead_ms, S({ class: "measured", value: 13000 }, "measured"))
  assert.deepEqual(formulas.active_before_card_ms, S({ class: "measured", value: 1000 }, "measured"))
  assert.deepEqual(formulas.busy_time_ms, S({ class: "measured", value: 27000 }, "measured"))
  assert.deepEqual(formulas.parallelism, S({ class: "inferred", value: 27 / 14, method: "busy_time_ms/active_time_ms" }, "measured"))
  assert.deepEqual(formulas.concurrent_sessions, S({ class: "inferred", value: { maximum: 2, average: 15 / 14 }, method: "active_session_interval_concurrency" }, "measured"))
  assert.deepEqual(formulas.concurrent_agents, S({ class: "inferred", value: { maximum: 2, average: 1.5 }, method: "active_agent_interval_concurrency" }, "measured"))
  // Each Claude and Copilot session lacks one wait kind, so each of those
  // totals is partial rather than a complete measurement.
  assert.deepEqual(formulas.waits, {
    human_wait_ms: { class: "measured", value: 2000, partial: true, uncovered_sessions: 1, partial_reasons: ["host_does_not_record"], state: "partial", reasons: ["host_does_not_record"] },
    permission_wait_ms: { class: "measured", value: 1000, partial: true, uncovered_sessions: 1, partial_reasons: ["host_does_not_record"], state: "partial", reasons: ["host_does_not_record"] },
    api_retry_ms: { class: "measured", value: 500, partial: true, uncovered_sessions: 1, partial_reasons: ["host_records_partly"], state: "partial", reasons: ["host_records_partly"] },
    compaction_ms: { class: "measured", value: 0, partial: true, uncovered_sessions: 1, partial_reasons: ["host_does_not_record"], state: "partial", reasons: ["host_does_not_record"] },
  })
  assert.deepEqual(formulas.longest_wait, {
    class: "measured",
    value: { kind: "human_wait", duration_ms: 2000, start_ms: 6000, end_ms: 8000 },
    partial: true,
    uncovered_sessions: 2,
    partial_reasons: ["host_does_not_record", "host_records_partly"],
    state: "partial",
    reasons: ["host_does_not_record", "host_records_partly"],
  })
  assert.deepEqual(formulas.flow_efficiency, S({ class: "inferred", value: 13 / 14, censored: false, method: "active_in_lead_ms/lead_time_ms" }, "measured"))
  assert.deepEqual(formulas.lead_contributors, {
    class: "inferred",
    state: "partial",
    reasons: ["host_does_not_record", "host_records_partly"],
    partial: true,
    partial_reasons: ["host_does_not_record", "host_records_partly"],
    censored: false,
    method: "clipped_to_lead_window",
    value: [
      { key: "active_in_lead_ms", value_ms: 13000, share: 13 / 14 },
      { key: "human_wait_ms", value_ms: 2000, share: 2 / 14, partial: true, uncovered_sessions: 1 },
      { key: "permission_wait_ms", value_ms: 1000, share: 1 / 14, partial: true, uncovered_sessions: 1 },
      { key: "api_retry_ms", value_ms: 500, share: 0.5 / 14, partial: true, uncovered_sessions: 1 },
      { key: "queue_before_start_ms", value_ms: 0, share: 0 },
      { key: "compaction_ms", value_ms: 0, share: 0, partial: true, uncovered_sessions: 1 },
    ],
  })
  // The /1 facts gain host flags on reading: every host records PRs only in part, and the Claude session records no commits, so those counts are partial and keep their values.
  const noCommits = (value) => ({ class: "measured", value, partial: true, uncovered_sessions: 1, partial_reasons: ["host_does_not_record"], state: "partial", reasons: ["host_does_not_record"] })
  const partlyPrs = (value, uncovered) => ({ class: "measured", value, partial: true, uncovered_sessions: uncovered, partial_reasons: ["host_records_partly"], state: "partial", reasons: ["host_records_partly"] })
  assert.deepEqual(formulas.references, {
    class: "measured",
    state: "partial",
    reasons: ["host_does_not_record", "host_records_partly"],
    partial: true,
    uncovered_sessions: 2,
    partial_reasons: ["host_does_not_record", "host_records_partly"],
    value: {
      public_pull_requests: [{ repo: "ourostack/desk", number: 7 }, { repo: "ourostack/desk", number: 8 }],
      public_prs: 2,
      public_commits: 2,
      private_prs: 1,
      private_commits: 2,
    },
    parts: {
      public_prs: partlyPrs(2, 2),
      public_commits: noCommits(2),
      private_prs: partlyPrs(1, 2),
      private_commits: noCommits(2),
    },
  })
  assert.deepEqual(formulas.rework_signals, {
    tool_failures: S({ class: "inferred", value: 2 }, "measured"),
    tool_retries: S({ class: "inferred", value: 3 }, "measured"),
    api_retries: { class: "inferred", value: 1, partial: true, uncovered_sessions: 1, partial_reasons: ["host_records_partly"], state: "partial", reasons: ["host_records_partly"] },
    session_retouches: S({ class: "inferred", value: 1, basis: "captured_sessions" }, "measured"),
  })
  assert.deepEqual(formulas.first_pass_yield, { class: "unavailable", state: "unavailable", value: null, reasons: ["not_recorded"], reason: "not_recorded" })
  assert.deepEqual(formulas.rework, { class: "unavailable", state: "unavailable", value: null, reasons: ["not_recorded"], reason: "not_recorded" })
})

test("open-job lead and flow are censored at the latest positioned session end, and the lost-clock session makes the clock numbers partial", () => {
  const formulas = calculateFormulas(buildJobTimeline(OPEN, sessions))
  assert.deepEqual(formulas.status, S({ class: "declared", value: "processing" }, "measured"))
  assert.deepEqual(formulas.sessions, S({ class: "measured", value: { bound: 2, timeline: 1, shared: 1, shared_with_jobs: 1 }, basis: "captured_sessions" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "measured", value: 12000, censored: true, basis: "latest_session_end" }, "partial", ["censored"]))
  // The other bound session lost its job offsets (flagged job_offsets, offset null): its time exists and cannot be placed, so every clock number is partial, with the flag's reason and that session counted as uncovered.
  const lost = { partial: true, uncovered_sessions: 1 }
  assert.deepEqual(formulas.queue_before_start_ms, { class: "measured", value: 2000, basis: "first_captured_session", ...lost, partial_reasons: ["source_unreadable"], state: "partial", reasons: ["source_unreadable"] })
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 8000, ...lost, partial_reasons: ["capped", "source_unreadable"], state: "partial", reasons: ["capped", "source_unreadable"] })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 2 / 3, censored: true, method: "active_in_lead_ms/lead_time_ms", ...lost, partial_reasons: ["capped", "source_unreadable"], state: "partial", reasons: ["capped", "censored", "source_unreadable"] })
  // The timed session is a Copilot session, which records no human waits, and the lost-clock session cannot place its waits: that total is unavailable for both reasons, never a measured zero.
  assert.deepEqual(formulas.waits.human_wait_ms, { class: "unavailable", value: null, reason: "mixed", reasons: ["host_does_not_record", "source_unreadable"], state: "unavailable" })
  assert.deepEqual(formulas.concurrent_sessions.value, { maximum: 1, average: 1 })
  assert.deepEqual(formulas.concurrent_agents.value, { maximum: 2, average: 1.5 })
})

test("a done observation supplies declared lead time only when no done transition exists", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "validating", offset_ms: 7000 }]
  one.jobs[0].observed = { status: "done", offset_ms: 9000 }
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "declared", value: 9000, censored: false, basis: "terminal_observation" }, "measured"))
  assert.deepEqual(formulas.status, S({ class: "declared", value: "done" }, "measured"))
})

test("cancelled jobs have unavailable delivery lead time and flow efficiency", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "cancelled", offset_ms: 9000 }]
  one.jobs[0].observed = { status: "cancelled", offset_ms: 9000 }
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.status, S({ class: "measured", value: "cancelled" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "unavailable", value: null, reason: "cancelled" }, "unavailable", ["cancelled"]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: "cancelled" }, "unavailable", ["cancelled"]))
})

test("a current cancellation overrides an earlier done transition", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions.push({ to: "cancelled", offset_ms: 15000 })
  one.jobs[0].observed = { status: "cancelled", offset_ms: 15000 }
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.status, S({ class: "measured", value: "cancelled" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "unavailable", value: null, reason: "cancelled" }, "unavailable", ["cancelled"]))
})

test("a job with no offsets retains coverage and signals but reports timeline formulas unavailable", () => {
  const one = structuredClone(sessions[1])
  const formulas = calculateFormulas(buildJobTimeline(OPEN, [one]))
  assert.deepEqual(formulas.sessions, S({ class: "measured", value: { bound: 1, timeline: 0, shared: 0, shared_with_jobs: 0 }, basis: "captured_sessions" }, "measured"))
  for (const field of ["lead_time_ms", "queue_before_start_ms", "active_time_ms", "active_in_lead_ms", "active_before_card_ms", "busy_time_ms", "parallelism", "concurrent_sessions", "concurrent_agents", "flow_efficiency", "longest_wait", "lead_contributors"]) {
    assert.deepEqual(formulas[field], S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]), field)
  }
  for (const wait of Object.values(formulas.waits)) {
    assert.deepEqual(wait, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))
  }
  assert.equal(formulas.rework_signals.session_retouches.value, 0)
})

test("a done declaration without a usable job offset is unavailable rather than treated as open", () => {
  const one = structuredClone(sessions[1])
  one.jobs[0].observed = { status: "done", offset_ms: null }
  const formulas = calculateFormulas(buildJobTimeline(OPEN, [one]))
  assert.deepEqual(formulas.status, S({ class: "declared", value: "done" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))
})

test("cancelled observation, nonterminal transition, and absent status retain their evidence classes", () => {
  let one = structuredClone(sessions[0])
  one.jobs[0].transitions = []
  one.jobs[0].observed = { status: "cancelled", offset_ms: 9000 }
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [one])).status, S({ class: "declared", value: "cancelled" }, "measured"))

  one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "paused", offset_ms: 5000 }]
  one.jobs[0].observed = null
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [one])).status, S({ class: "measured", value: "paused" }, "measured"))

  one.jobs[0].transitions = []
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [one])).status, S({ class: "unavailable", value: null, reason: "status_unavailable" }, "unavailable", ["status_unavailable"]))
})

test("zero active time and zero lead time stay explicit", () => {
  let one = structuredClone(sessions[0])
  one.intervals = one.intervals.filter((entry) => entry.kind === "human_wait")
  let formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.active_time_ms, S({ class: "measured", value: 0 }, "measured"))
  assert.deepEqual(formulas.parallelism, S({ class: "unavailable", value: null, reason: "no_active_intervals" }, "unavailable", ["no_active_intervals"]))
  assert.deepEqual(formulas.concurrent_sessions, S({ class: "unavailable", value: null, reason: "no_active_intervals" }, "unavailable", ["no_active_intervals"]))
  assert.deepEqual(formulas.concurrent_agents, S({ class: "unavailable", value: null, reason: "no_active_intervals" }, "unavailable", ["no_active_intervals"]))

  one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "done", offset_ms: 0 }]
  one.intervals = []
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: "zero_lead_time" }, "unavailable", ["zero_lead_time"]))
})

test("a timed job with no waits reports the absence rather than inventing zero-duration evidence", () => {
  const one = structuredClone(sessions[0])
  one.intervals = one.intervals.filter((entry) => !entry.kind.endsWith("_wait"))
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.longest_wait, S({ class: "unavailable", value: null, reason: "no_wait_intervals" }, "unavailable", ["no_wait_intervals"]))
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
  // The card says the job closed before it began, but the sessions recorded 9000 ms of work: the lead time is at least that span.
  assert.deepEqual(formulas.lead_time_ms, S({ class: "inferred", value: 9000, censored: false, basis: "recorded_segment_span", partial: true, partial_reasons: ["card_dates_shorter_than_work"] }, "partial", ["card_dates_shorter_than_work"]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: "card_dates_shorter_than_work" }, "unavailable", ["card_dates_shorter_than_work"]))
})

test("a wait kind every timed session lacks is unavailable, one some sessions lack is partial, mixed reasons are listed, and a lost-clock session now counts (superseding: a null offset never counts toward timed coverage)", () => {
  const claude = structuredClone(sessions[0])
  const copilot = structuredClone(sessions[2])
  copilot.unavailable.push({ field: "permission_waits", reason: "log_truncated" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [claude, copilot]))
  assert.deepEqual(formulas.waits.permission_wait_ms, {
    class: "unavailable",
    value: null,
    reason: "mixed",
    reasons: ["host_does_not_record", "log_truncated"],
    state: "unavailable",
  })
  assert.deepEqual(formulas.waits.human_wait_ms, { class: "measured", value: 2000, partial: true, uncovered_sessions: 1, partial_reasons: ["host_does_not_record"], state: "partial", reasons: ["host_does_not_record"] })
  assert.equal(formulas.lead_contributors.value.some((entry) => entry.key === "permission_wait_ms"), false)
  assert.equal(formulas.longest_wait.value.kind, "human_wait")

  // Superseded rule: a session bound with a null offset that says its job offsets were lost now counts in the clock coverage (it used to be left out). With a timed session beside it the numbers are partial; with none they are unavailable.
  const lostClock = structuredClone(sessions[1])
  lostClock.jobs[0].job = CLOSED
  const withLost = calculateFormulas(buildJobTimeline(CLOSED, [structuredClone(sessions[2]), lostClock]))
  assert.equal(withLost.waits.human_wait_ms.state, "unavailable")
  assert.deepEqual(withLost.waits.human_wait_ms.reasons, ["host_does_not_record", "source_unreadable"])
  assert.equal(withLost.active_time_ms.state, "partial")
  assert.equal(withLost.active_time_ms.uncovered_sessions, 1)
  assert.ok(withLost.active_time_ms.reasons.includes("source_unreadable"))
})

test("missing tool durations make active-time values partial, never complete and never unavailable", () => {
  const partial = structuredClone(sessions[0])
  partial.unavailable.push({ field: "tool_durations", reason: "log_truncated" })
  let formulas = calculateFormulas(buildJobTimeline(CLOSED, [partial, structuredClone(sessions[2])]))
  const mark = { partial: true, uncovered_sessions: 1, partial_reasons: ["log_truncated"], state: "partial", reasons: ["log_truncated"] }
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 14000, ...mark })
  assert.deepEqual(formulas.active_in_lead_ms, { class: "measured", value: 13000, ...mark })
  assert.deepEqual(formulas.active_before_card_ms, { class: "measured", value: 1000, ...mark })
  assert.deepEqual(formulas.busy_time_ms, { class: "measured", value: 27000, ...mark })
  assert.deepEqual(formulas.parallelism, { class: "inferred", value: 27 / 14, method: "busy_time_ms/active_time_ms", ...mark })
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 13 / 14, censored: false, method: "active_in_lead_ms/lead_time_ms", ...mark })
  assert.deepEqual(formulas.lead_contributors.value[0], { key: "active_in_lead_ms", value_ms: 13000, share: 13 / 14, partial: true, uncovered_sessions: 1 })

  // An open session with an unfinished tool call still has its turns, so its
  // active time is partial, not unavailable.
  const open = structuredClone(sessions[0])
  open.session.ended = false
  open.session.end_reason = null
  open.unavailable.push({ field: "tool_durations", reason: "session_open" })
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [open]))
  const openMark = { ...mark, partial_reasons: ["session_open"], reasons: ["session_open"] }
  assert.deepEqual(formulas.active_time_ms, { class: "measured", value: 7000, ...openMark })
  assert.deepEqual(formulas.active_in_lead_ms, { class: "measured", value: 6000, ...openMark })
  assert.deepEqual(formulas.active_before_card_ms, { class: "measured", value: 1000, ...openMark })
  assert.deepEqual(formulas.busy_time_ms, { class: "measured", value: 11000, ...openMark })
  assert.deepEqual(formulas.parallelism, { class: "inferred", value: 11 / 7, method: "busy_time_ms/active_time_ms", ...openMark })
  assert.equal(formulas.concurrent_sessions.state, "partial")
  assert.equal(formulas.concurrent_agents.uncovered_sessions, 1)
  assert.deepEqual(formulas.flow_efficiency, { class: "inferred", value: 6000 / 14000, censored: false, method: "active_in_lead_ms/lead_time_ms", ...openMark })
  assert.deepEqual(formulas.lead_contributors.value.find((entry) => entry.key === "active_in_lead_ms"), { key: "active_in_lead_ms", value_ms: 6000, share: 6000 / 14000, partial: true, uncovered_sessions: 1 })
})

test("active time is unavailable only when every timed session lacks its turns, with the turns reason", () => {
  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "turns", reason: "log_truncated" }, { field: "tool_durations", reason: "capped" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [lacking]))
  for (const field of ["active_time_ms", "active_in_lead_ms", "active_before_card_ms", "busy_time_ms", "parallelism", "concurrent_sessions", "concurrent_agents", "flow_efficiency"]) {
    assert.deepEqual(formulas[field], S({ class: "unavailable", value: null, reason: "log_truncated" }, "unavailable", ["log_truncated"]), field)
  }
  assert.equal(formulas.lead_contributors.value.some((entry) => entry.key === "active_in_lead_ms"), false)

  // One session without turns and one with only a tool-duration gap: both are uncovered, neither decides alone.
  const toolGap = structuredClone(sessions[2])
  toolGap.unavailable.push({ field: "tool_durations", reason: "session_open" })
  const mixed = calculateFormulas(buildJobTimeline(CLOSED, [lacking, toolGap]))
  assert.deepEqual(mixed.active_time_ms, { class: "measured", value: 14000, partial: true, uncovered_sessions: 2, partial_reasons: ["capped", "log_truncated", "session_open"], state: "partial", reasons: ["capped", "log_truncated", "session_open"] })
})

test("the API retry signal is unavailable when no session records retries and partial when some do not", () => {
  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "api_retries", reason: "log_missing" })
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [lacking])).rework_signals.api_retries, S({ class: "unavailable", value: null, reason: "log_missing" }, "unavailable", ["log_missing"]))
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [lacking, structuredClone(sessions[2])])).rework_signals.api_retries, {
    class: "inferred",
    value: 1,
    partial: true,
    uncovered_sessions: 1,
    partial_reasons: ["host_records_partly", "log_missing"],
    state: "partial",
    reasons: ["host_records_partly", "log_missing"],
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
  assert.deepEqual(formulas.longest_wait, S({ class: "unavailable", value: null, reason: "wait_fields_unavailable" }, "unavailable", ["wait_fields_unavailable"]))
})

test("a session starting long before the task card never pushes flow efficiency or lead shares past the lead window", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].session_offset_ms = -10000
  one.intervals = [
    { kind: "turn", agent: 0, start_ms: 0, end_ms: 12000 },
    { kind: "human_wait", agent: 0, start_ms: 5000, end_ms: 13000 },
  ]
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "measured", value: 14000, censored: false, basis: "first_done_transition" }, "measured"))
  assert.deepEqual(formulas.active_time_ms, S({ class: "measured", value: 12000 }, "measured"))
  assert.deepEqual(formulas.active_before_card_ms, S({ class: "measured", value: 10000 }, "measured"))
  assert.deepEqual(formulas.active_in_lead_ms, S({ class: "measured", value: 2000 }, "measured"))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "inferred", value: 2000 / 14000, censored: false, method: "active_in_lead_ms/lead_time_ms" }, "measured"))
  assert.deepEqual(formulas.queue_before_start_ms, S({ class: "measured", value: 0, basis: "first_captured_session" }, "measured"))
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
  assert.deepEqual(lateFormulas.active_in_lead_ms, S({ class: "measured", value: 0 }, "measured"))
})

test("the latest terminal transition decides status, so a reopened job reports its current state", () => {
  const reopened = structuredClone(sessions[0])
  reopened.jobs[0].transitions = [
    { to: "cancelled", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
    { to: "done", offset_ms: 14000 },
  ]
  let formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.status, S({ class: "measured", value: "done" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "measured", value: 14000, censored: false, basis: "first_done_transition" }, "measured"))

  // Reopened after done: the job is open again, so lead time and flow
  // efficiency are censored like any open job's, and the done stays in history.
  reopened.jobs[0].transitions = [
    { to: "processing", offset_ms: 0 },
    { to: "done", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
  ]
  const timeline = buildJobTimeline(CLOSED, [reopened])
  formulas = calculateFormulas(timeline)
  assert.deepEqual(formulas.status, S({ class: "measured", value: "processing" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "measured", value: 15000, censored: true, basis: "latest_session_end" }, "partial", ["censored"]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "inferred", value: 6000 / 15000, censored: true, method: "active_in_lead_ms/lead_time_ms" }, "partial", ["censored"]))
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
  assert.deepEqual(formulas.status, S({ class: "measured", value: "done" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "inferred", value: 9000, censored: false, basis: "recorded_segment_span", partial: true, partial_reasons: ["card_dates_shorter_than_work"] }, "partial", ["card_dates_shorter_than_work"]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: "card_dates_shorter_than_work" }, "unavailable", ["card_dates_shorter_than_work"]))

  // Consecutive terminal transitions after the last reopen: the first done of that stretch ends lead time.
  reopened.jobs[0].transitions = [
    { to: "processing", offset_ms: 0 },
    { to: "done", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
    { to: "done", offset_ms: 4000 },
    { to: "done", offset_ms: 9000 },
  ]
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "inferred", value: 9000, censored: false, basis: "recorded_segment_span", partial: true, partial_reasons: ["card_dates_shorter_than_work"] }, "partial", ["card_dates_shorter_than_work"]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: "card_dates_shorter_than_work" }, "unavailable", ["card_dates_shorter_than_work"]))

  reopened.jobs[0].transitions = [
    { to: "processing", offset_ms: 0 },
    { to: "done", offset_ms: 100 },
    { to: "processing", offset_ms: 200 },
  ]
  // A done observation cannot close a job whose latest transition reopened it.
  reopened.jobs[0].observed = { status: "done", offset_ms: 150 }
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.status, S({ class: "measured", value: "processing" }, "measured"))
  assert.equal(formulas.lead_time_ms.censored, true)

  reopened.jobs[0].transitions = [{ to: "cancelled", offset_ms: 100 }, { to: "processing", offset_ms: 200 }]
  reopened.jobs[0].observed = null
  formulas = calculateFormulas(buildJobTimeline(CLOSED, [reopened]))
  assert.deepEqual(formulas.status, S({ class: "measured", value: "processing" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "measured", value: 15000, censored: true, basis: "latest_session_end" }, "partial", ["censored"]))
})

test("a done transition with no offset is never a measured zero lead time", () => {
  const one = structuredClone(sessions[0])
  one.jobs[0].transitions = [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: null }]
  one.jobs[0].observed = null
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.status, S({ class: "measured", value: "done" }, "measured"))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))
  assert.deepEqual(formulas.active_in_lead_ms, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))
  assert.deepEqual(formulas.lead_contributors, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))

  const cancelled = structuredClone(sessions[0])
  cancelled.jobs[0].transitions = [{ to: "cancelled", offset_ms: null }]
  cancelled.jobs[0].observed = null
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [cancelled])).status, S({ class: "measured", value: "cancelled" }, "measured"))
})

test("lead contributors are unavailable for zero lead time and for lead time without a job clock", () => {
  const zero = structuredClone(sessions[0])
  zero.jobs[0].transitions = [{ to: "done", offset_ms: 0 }]
  zero.intervals = []
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [zero])).lead_contributors, S({ class: "unavailable", value: null, reason: "zero_lead_time" }, "unavailable", ["zero_lead_time"]))

  const untimed = structuredClone(sessions[0])
  untimed.jobs[0].session_offset_ms = null
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [untimed]))
  assert.equal(formulas.lead_time_ms.class, "measured")
  assert.deepEqual(formulas.lead_contributors, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: "job_offsets_unavailable" }, "unavailable", ["job_offsets_unavailable"]))
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
    schema: "desk.factory.published/2",
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
  assert.deepEqual(a.active_time_ms, S({ class: "measured", value: 6000 }, "measured"))
  assert.deepEqual(b.active_time_ms, S({ class: "measured", value: 3000 }, "measured"))
  assert.equal(a.active_time_ms.value + b.active_time_ms.value, 9000)
  // Busy time is the plain sum of the job's own intervals (4000+1000+3000, 3000+1000).
  assert.equal(a.busy_time_ms.value, 8000)
  assert.equal(b.busy_time_ms.value, 4000)
  assert.equal(calculateFormulas(buildJobTimeline(JOB_A, [splitSession({ jobs: [{ ...splitSession().jobs[0], agents: [0, 1, 2] }] })])).active_time_ms.value, 9000)

  const partial = { partial: true, uncovered_sessions: 1, partial_reasons: ["worker_split"], state: "partial", reasons: ["worker_split"] }
  assert.deepEqual(a.tool_calls_by_kind, { class: "measured", value: { edit: 1, shell: 1 }, ...partial })
  assert.deepEqual(b.tool_calls_by_kind, { class: "measured", value: { shell: 1 }, ...partial })
  assert.deepEqual(a.rework_signals.tool_failures, { class: "inferred", value: 1, ...partial })
  assert.deepEqual(b.rework_signals.tool_failures, { class: "inferred", value: 1, ...partial })
  // Retries have no worker: a job whose only session is split cannot say how many were its own, and an unknown count is not a measured zero.
  assert.deepEqual(a.rework_signals.tool_retries, S({ class: "unavailable", value: null, reason: "worker_split" }, "unavailable", ["worker_split"]))
  assert.deepEqual(b.rework_signals.api_retries, S({ class: "unavailable", value: null, reason: "worker_split" }, "unavailable", ["worker_split"]))
  assert.deepEqual(a.rework_signals.api_retries, S({ class: "unavailable", value: null, reason: "worker_split" }, "unavailable", ["worker_split"]))
})

test("a job with some whole sessions sums their retries and marks the measure partial; a split session also missing the field says mixed", () => {
  const whole = splitSession({ session: { ...splitSession().session, id: "66666666-6666-4666-8666-666666666666" } })
  whole.jobs = [{ ...whole.jobs[0], agents: [0, 1, 2] }]
  const formulas = calculateFormulas(buildJobTimeline(JOB_A, [splitSession(), whole]))
  const partial = { partial: true, uncovered_sessions: 1, partial_reasons: ["worker_split"], state: "partial", reasons: ["worker_split"] }
  assert.deepEqual(formulas.rework_signals.tool_retries, { class: "inferred", value: 2, ...partial })
  assert.deepEqual(formulas.rework_signals.api_retries, { class: "inferred", value: 1, ...partial })
  const lacking = splitSession()
  lacking.unavailable.push({ field: "api_retries", reason: "log_missing" })
  assert.deepEqual(calculateFormulas(buildJobTimeline(JOB_A, [lacking])).rework_signals.api_retries, S({ class: "unavailable", value: null, reason: "mixed", reasons: ["log_missing", "worker_split"] }, "unavailable", ["log_missing", "worker_split"]))
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
  assert.deepEqual(legacyFormulas.tool_calls_by_kind, S({ class: "measured", value: { edit: 1, shell: 2 } }, "measured"))
  assert.deepEqual(legacyFormulas.rework_signals.tool_retries, S({ class: "inferred", value: 2 }, "measured"))
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
  const partial = { partial: true, uncovered_sessions: 1, partial_reasons: ["worker_shared"], state: "partial", reasons: ["worker_shared"] }
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

// Two jobs that both hold the controller (worker 0), each with its own segments.
function segmentedSession(aSegments, bSegments, overrides = {}) {
  const session = splitSession(overrides)
  session.jobs[0].agents = [0, 1]
  session.jobs[0].segments = aSegments
  session.jobs[1].agents = [0, 2]
  session.jobs[1].segments = bSegments
  return session
}
const DISJOINT = [[{ start_ms: 0, end_ms: 10000 }], [{ start_ms: 10000, end_ms: 20000 }]]
const OVERLAP = [[{ start_ms: 0, end_ms: 10000 }], [{ start_ms: 5000, end_ms: 20000 }]]

test("two jobs with disjoint segments share nothing, and overlapping segments share", () => {
  const disjoint = [segmentedSession(...DISJOINT)]
  for (const job of [JOB_A, JOB_B]) {
    const formulas = calculateFormulas(buildJobTimeline(job, disjoint))
    assert.deepEqual(formulas.sessions.value, { bound: 1, timeline: 1, shared: 0, shared_with_jobs: 0 })
    assert.equal(Object.hasOwn(formulas.active_time_ms, "partial_reasons"), false)
  }
  const overlap = [segmentedSession(...OVERLAP)]
  for (const job of [JOB_A, JOB_B]) {
    const formulas = calculateFormulas(buildJobTimeline(job, overlap))
    assert.deepEqual(formulas.sessions.value, { bound: 1, timeline: 1, shared: 1, shared_with_jobs: 1 })
    assert.deepEqual(formulas.active_time_ms.partial_reasons, ["worker_shared"])
  }
})

test("an unsegmented job counts as overlapping every segmented one, and a legacy pair keeps one other job", () => {
  const mixed = segmentedSession(...DISJOINT)
  delete mixed.jobs[1].segments
  mixed.jobs[1].agents = [0, 2]
  for (const job of [JOB_A, JOB_B]) {
    assert.deepEqual(calculateFormulas(buildJobTimeline(job, [mixed])).sessions.value, { bound: 1, timeline: 1, shared: 1, shared_with_jobs: 1 })
  }
  // A job held only by a subagent holds no controller time, so it shares the session with no job that has none of its agents.
  mixed.jobs[1].agents = [2]
  for (const job of [JOB_A, JOB_B]) {
    assert.deepEqual(calculateFormulas(buildJobTimeline(job, [mixed])).sessions.value, { bound: 1, timeline: 1, shared: 0, shared_with_jobs: 0 })
  }
  const unsegmentedController = segmentedSession(...DISJOINT)
  delete unsegmentedController.jobs[1].segments
  assert.deepEqual(calculateFormulas(buildJobTimeline(JOB_A, [unsegmentedController])).active_time_ms.partial_reasons, ["worker_shared"])
  const legacy = splitSession()
  delete legacy.jobs[0].agents
  delete legacy.jobs[1].agents
  assert.equal(calculateFormulas(buildJobTimeline(JOB_A, [legacy])).sessions.value.shared, 1)
})

test("a pull request is flagged worker_shared only when it falls inside an overlap of segments", () => {
  const prs = [
    { repo: "ourostack/desk", number: 1, agent: 0, at_ms: 2000 },
    { repo: "ourostack/desk", number: 2, agent: 0, at_ms: 15000 },
    { repo: "ourostack/desk", number: 3, agent: 0, at_ms: 7000 },
  ]
  const withPrs = (segments) => [segmentedSession(...segments, { refs: REFS(prs) })]
  const disjoint = withPrs(DISJOINT)
  assert.deepEqual(prNumbers(JOB_A, disjoint), [1, 3])
  assert.deepEqual(prNumbers(JOB_B, disjoint), [2])
  for (const job of [JOB_A, JOB_B]) assert.equal(Object.hasOwn(referencesOf(job, disjoint), "partial_reasons"), false)
  // With overlapping segments PR 3 (at 7000) is in the overlap: neither job gets it, and both say so.
  const overlap = withPrs(OVERLAP)
  assert.deepEqual(prNumbers(JOB_A, overlap), [1])
  assert.deepEqual(prNumbers(JOB_B, overlap), [2])
  for (const job of [JOB_A, JOB_B]) assert.deepEqual(referencesOf(job, overlap).partial_reasons, ["worker_shared"])
  // A PR outside the overlap, with no other PR inside it, leaves the list unflagged.
  const outside = [segmentedSession(...OVERLAP, { refs: REFS(prs.slice(0, 2)) })]
  for (const job of [JOB_A, JOB_B]) assert.equal(Object.hasOwn(referencesOf(job, outside), "partial_reasons"), false)
})

test("idle inside a segment is not active time", () => {
  const HOUR = 3600000
  const MINUTE = 60000
  const session = splitSession({
    intervals: [
      { kind: "turn", agent: 0, start_ms: 0, end_ms: 10 * MINUTE },
      { kind: "turn", agent: 0, start_ms: 4 * HOUR, end_ms: 4 * HOUR + 10 * MINUTE },
    ],
    counts: { tool_calls: {}, tool_failures: {}, tool_retries: 0, api_retries: 0, compactions: 0 },
  })
  session.session.duration_ms = 5 * HOUR
  session.jobs = [{ job: JOB_A, agents: [0], basis: ["desk_tool"], session_offset_ms: 0, segments: [{ start_ms: 0, end_ms: 5 * HOUR }], transitions: [], observed: { status: "processing", offset_ms: null } }]
  const formulas = calculateFormulas(buildJobTimeline(JOB_A, [session]))
  assert.equal(formulas.active_time_ms.value, 20 * MINUTE)
  assert.equal(formulas.busy_time_ms.value, 20 * MINUTE)
  // No figure of the job reads the segment's five-hour span as work or as a wait.
  for (const wait of Object.values(formulas.waits)) assert.equal(wait.value, 0)
})

test("the sign-off formula reads the job's current outcome and says not recorded when there is none", () => {
  const none = calculateFormulas(buildJobTimeline(CLOSED, sessions))
  assert.deepEqual(none.signoff, { class: "unavailable", state: "unavailable", value: null, reasons: ["not_recorded"], reason: "not_recorded" })
  const recorded = structuredClone(sessions)
  const wait = { class: "lt_1d", censored: false }
  recorded[0].outcomes = [{ job: CLOSED, rev: 2, state: "accepted", verified: true, reason: null, deliveries: 1, wait }]
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, recorded)).signoff, {
    class: "declared", value: "accepted", verified: true, reason: null, wait, state: "measured", reasons: [],
  })
  recorded[0].outcomes[0].state = "not_recorded"
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, recorded)).signoff.reasons, ["signoff_not_recorded"])
})

test("the first-pass and rework formulas read the job's returns and give a verdict only from a created record", () => {
  const recorded = structuredClone(sessions)
  const returns = [{ reason: "agent_error", caught: "at_review", counts: true, refusal: null, refusal_verified: null }]
  recorded[0].outcomes = [{ job: CLOSED, rev: 2, state: "accepted", verified: true, reason: null, deliveries: 1, wait: null, since: "created", returns }]
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, recorded))
  assert.deepEqual(formulas.first_pass_yield, { class: "declared", state: "measured", value: 0, reasons: [], returns: { counting: 1, changed_ask: 0 }, changed_ask_only: false })
  assert.deepEqual(formulas.rework, { class: "declared", state: "measured", value: { in_task: 0, at_review: 1, after_delivery: 0 }, reasons: [], reason_check: { compared: 0, disagree: 0 } })
  recorded[0].outcomes[0].since = "adopted"
  assert.equal(calculateFormulas(buildJobTimeline(CLOSED, recorded)).first_pass_yield.reason, "history_not_recorded")
})

const hasState = (result) => result.state === stateOf(without(result)) && JSON.stringify(result.reasons) === JSON.stringify(reasonsOf(without(result)))
// A mixed unavailable result carries its reasons as input; any other result's reasons are derived and must not be read back.
const without = ({ state, ...rest }) => rest.reason === "mixed" ? rest : (({ reasons, ...others }) => others)(rest)
const walkResults = (formulas) => Object.entries(formulas).flatMap(([name, result]) =>
  Object.hasOwn(result, "class") ? [[name, result]] : walkResults(result).map(([inner, value]) => [`${name}.${inner}`, value]))

test("every result calculateFormulas returns carries state and reasons", () => {
  for (const job of [CLOSED, OPEN]) {
    const results = walkResults(calculateFormulas(buildJobTimeline(job, sessions)))
    assert.ok(results.length >= 20)
    for (const [name, result] of results) {
      assert.ok(hasState(result), `${name} state or reasons disagree with its keys`)
      assert.equal(result.state === "unavailable", result.class === "unavailable", name)
      assert.ok(NUMBER_STATES.includes(result.state), name)
      if (result.state !== "measured") assert.ok(result.reasons.length > 0, `${name} is ${result.state} with no reason`)
    }
  }
  const open = calculateFormulas(buildJobTimeline(OPEN, sessions))
  assert.deepEqual(open.lead_time_ms.reasons, ["censored"])
  assert.equal(open.lead_time_ms.state, "partial")
  const closed = calculateFormulas(buildJobTimeline(CLOSED, sessions))
  assert.equal(closed.status.state, "measured")
  assert.equal(closed.first_pass_yield.state, "unavailable")
  assert.deepEqual(closed.first_pass_yield.reasons, ["not_recorded"])
})

test("every top-level result is a known formula id or a not-fed name", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, sessions))
  for (const name of Object.keys(formulas)) {
    const known = Object.hasOwn(NOT_FED, name) || FORMULA_IDS.some((id) => id === name || id.startsWith(`${name}.`))
    assert.ok(known || name === "references", `${name} is neither a formula id nor a not-fed name`)
  }
})

test("a host_records_partly entry makes a formula partial and never unavailable, even when every session has it", () => {
  const partly = structuredClone(sessions[2])
  partly.unavailable.push({ field: "api_retries", reason: "host_records_partly" })
  const only = calculateFormulas(buildJobTimeline(CLOSED, [partly]))
  for (const result of [only.waits.api_retry_ms, only.rework_signals.api_retries]) {
    assert.equal(result.class === "unavailable", false)
    assert.equal(result.state, "partial")
    assert.equal(result.partial, true)
    assert.equal(result.uncovered_sessions, 1)
    assert.ok(result.reasons.includes("host_records_partly"))
  }
  assert.equal(only.waits.api_retry_ms.value, 500)
  assert.equal(only.rework_signals.api_retries.value, 1)
  assert.equal(only.longest_wait.state, "partial")
  assert.ok(only.longest_wait.reasons.includes("host_records_partly"))

  // A current (/2) session carries no legacy api_retries flag, so only `partly` is uncovered.
  const current = structuredClone(sessions[0])
  current.schema = "desk.factory.published/2"
  const whole = calculateFormulas(buildJobTimeline(CLOSED, [partly, current]))
  assert.equal(whole.rework_signals.api_retries.uncovered_sessions, 1)
  assert.deepEqual(whole.rework_signals.api_retries.partial_reasons, ["host_records_partly"])
})

test("partial_reasons now includes the flag reasons of the incomplete sessions", () => {
  const gap = structuredClone(sessions[0])
  gap.unavailable.push({ field: "tool_durations", reason: "log_truncated" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [gap, structuredClone(sessions[2])]))
  assert.deepEqual(formulas.active_time_ms.partial_reasons, ["log_truncated"])
  assert.deepEqual(formulas.active_time_ms.reasons, ["log_truncated"])
  const lacking = calculateFormulas(buildJobTimeline(CLOSED, [structuredClone(sessions[0]), structuredClone(sessions[2])]))
  assert.deepEqual(lacking.waits.human_wait_ms.partial_reasons, ["host_does_not_record"])
})

test("a job whose sessions lack turns but have other waits reports the longest wait as partial", () => {
  const lacking = structuredClone(sessions[0])
  lacking.unavailable.push({ field: "turns", reason: "log_truncated" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [lacking, structuredClone(sessions[2])]))
  assert.equal(formulas.longest_wait.class, "measured")
  assert.equal(formulas.longest_wait.state, "partial")
  assert.ok(formulas.longest_wait.reasons.includes("log_truncated"))
  assert.equal(formulas.waits.compaction_ms.state, "partial")
})

test("a result that is partial with no reason is refused where its state is set", () => {
  assert.throws(() => withState({ class: "measured", value: 1, partial: true }), /partial.*no reason/)
})

const codexSession = () => {
  const codex = structuredClone(sessions[2])
  codex.session.host = "codex-cli"
  codex.unavailable = []
  return codex
}

test("compaction wait is unavailable for a Claude job and for a Codex job, with host_does_not_record", () => {
  for (const session of [structuredClone(sessions[0]), codexSession()]) {
    const formulas = calculateFormulas(buildJobTimeline(CLOSED, [session]))
    assert.deepEqual(formulas.waits.compaction_ms, S({ class: "unavailable", value: null, reason: "host_does_not_record" }, "unavailable", ["host_does_not_record"]))
    assert.equal(formulas.lead_contributors.value.some((entry) => entry.key === "compaction_ms"), false)
  }
})

test("compaction wait stays measured for a Copilot job that recorded compactions", () => {
  const copilot = structuredClone(sessions[2])
  copilot.intervals.push({ kind: "compaction", agent: 0, start_ms: 1000, end_ms: 1400 })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [copilot]))
  assert.equal(formulas.waits.compaction_ms.state, "measured")
  assert.equal(formulas.waits.compaction_ms.value, 400)
  assert.deepEqual(formulas.waits.compaction_ms.reasons, [])
})

test("lead contributors are partial and name the omitted wait when one kind is unavailable", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [structuredClone(sessions[0]), structuredClone(sessions[2])]))
  assert.equal(formulas.waits.permission_wait_ms.state, "partial")
  const claudeOnly = calculateFormulas(buildJobTimeline(CLOSED, [structuredClone(sessions[0])]))
  assert.equal(claudeOnly.waits.permission_wait_ms.state, "unavailable")
  assert.equal(claudeOnly.lead_contributors.class, "inferred")
  assert.equal(claudeOnly.lead_contributors.state, "partial")
  assert.ok(claudeOnly.lead_contributors.reasons.includes("host_does_not_record"))
  assert.equal(claudeOnly.lead_contributors.value.some((entry) => entry.key === "permission_wait_ms"), false)
  const shares = claudeOnly.lead_contributors.value.map((entry) => entry.key)
  assert.deepEqual(shares, [...shares].sort((a, b) => claudeOnly.lead_contributors.value.find((e) => e.key === b).value_ms - claudeOnly.lead_contributors.value.find((e) => e.key === a).value_ms || 0))
})

test("lead contributors list no zero-valued entry for an unmeasured kind", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [structuredClone(sessions[0])]))
  for (const key of ["permission_wait_ms", "compaction_ms"]) {
    assert.equal(formulas.lead_contributors.value.some((entry) => entry.key === key), false, key)
  }
  const codex = calculateFormulas(buildJobTimeline(CLOSED, [codexSession()]))
  assert.equal(codex.lead_contributors.value.some((entry) => entry.key === "compaction_ms"), false)
})

test("a contributor whose host records it partly keeps its value and is not omitted", () => {
  const partly = structuredClone(sessions[2])
  partly.unavailable.push({ field: "api_retries", reason: "host_records_partly" })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [partly]))
  const entry = formulas.lead_contributors.value.find((item) => item.key === "api_retry_ms")
  assert.equal(entry.value_ms, 500)
  assert.equal(entry.partial, true)
  assert.equal(formulas.lead_contributors.state, "partial")
  assert.ok(formulas.lead_contributors.reasons.includes("host_records_partly"))
})

test("longest wait is partial when a wait kind is unavailable and measured when none is", () => {
  const claudeOnly = calculateFormulas(buildJobTimeline(CLOSED, [structuredClone(sessions[0])]))
  assert.equal(claudeOnly.waits.permission_wait_ms.state, "unavailable")
  assert.equal(claudeOnly.longest_wait.state, "partial")
  assert.ok(claudeOnly.longest_wait.reasons.includes("host_does_not_record"))
  const whole = structuredClone(sessions[2])
  whole.schema = "desk.factory.published/2"
  whole.unavailable = []
  whole.intervals.push({ kind: "permission_wait", agent: 0, start_ms: 100, end_ms: 200 }, { kind: "compaction", agent: 0, start_ms: 300, end_ms: 400 })
  const clean = calculateFormulas(buildJobTimeline(CLOSED, [whole]))
  assert.equal(clean.longest_wait.state, "measured")
  assert.deepEqual(clean.longest_wait.reasons, [])
})

test("a human wait with no interval stays a measured zero when no human_waits flag exists", () => {
  const copilot = structuredClone(sessions[2])
  copilot.schema = "desk.factory.published/2"
  copilot.unavailable = []
  copilot.intervals = copilot.intervals.filter((interval) => interval.kind !== "human_wait")
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [copilot]))
  assert.deepEqual(formulas.waits.human_wait_ms, S({ class: "measured", value: 0 }, "measured"))
})

const partsOf = (input, job = CLOSED) => calculateFormulas(buildJobTimeline(job, input)).references.parts
// The stored /1 facts gain host flags when read; these sessions are made /2 and carry exactly the flags given.
const flagged = (session, ...entries) => {
  const copy = structuredClone(session)
  copy.schema = "desk.factory.published/2"
  copy.unavailable = [...copy.unavailable.filter((entry) => !["commits", "prs"].includes(entry.field)), ...entries.map(([field, reason]) => ({ field, reason }))]
  return copy
}
const NO_COMMITS = ["commits", "host_does_not_record"]
const PARTLY_PRS = ["prs", "host_records_partly"]
const claudeJob = () => flagged(sessions[0], NO_COMMITS, PARTLY_PRS)
const codexJob = () => flagged(codexSession(), NO_COMMITS)
const copilotJob = () => flagged(sessions[2])

test("commit counts are unavailable for a Claude job and a Codex job", () => {
  for (const session of [claudeJob(), codexJob()]) {
    const parts = partsOf([session])
    for (const name of ["public_commits", "private_commits"]) {
      assert.equal(parts[name].class, "unavailable", name)
      assert.equal(parts[name].state, "unavailable", name)
      assert.deepEqual(parts[name].reasons, ["host_does_not_record"], name)
    }
  }
})

test("commit counts are measured for a Copilot job whose commits were read, partial when capped", () => {
  const copilot = copilotJob()
  const whole = partsOf([copilot])
  for (const name of ["public_commits", "private_commits"]) {
    assert.equal(whole[name].state, "measured", name)
    assert.deepEqual(whole[name].reasons, [], name)
  }
  assert.equal(whole.public_commits.value, copilot.refs.commits.length)
  const partly = partsOf([flagged(sessions[2], ["commits", "host_records_partly"])])
  for (const name of ["public_commits", "private_commits"]) {
    assert.equal(partly[name].state, "partial", name)
    assert.deepEqual(partly[name].reasons, ["host_records_partly"], name)
  }
  assert.equal(partly.public_commits.value, copilot.refs.commits.length)
  // Some sessions record commits and one does not: the count covers the others only.
  const mixed = partsOf([copilot, claudeJob()])
  assert.equal(mixed.public_commits.state, "partial")
  assert.deepEqual(mixed.public_commits.reasons, ["host_does_not_record"])
})

test("private reference counts follow the same flags", () => {
  const parts = partsOf([claudeJob()])
  assert.equal(parts.private_commits.state, "unavailable")
  assert.equal(parts.private_prs.state, "partial")
  assert.deepEqual(parts.private_prs.reasons, ["host_records_partly"])
  assert.equal(parts.private_prs.value, sessions[0].refs.private.prs)
  const clean = partsOf([copilotJob()])
  assert.equal(clean.private_commits.state, "measured")
  assert.equal(clean.private_prs.state, "measured")
})

test("public PRs are partial with host_records_partly on every host", () => {
  for (const session of [claudeJob(), flagged(codexSession(), NO_COMMITS, PARTLY_PRS), flagged(sessions[2], PARTLY_PRS)]) {
    const part = partsOf([session]).public_prs
    assert.equal(part.state, "partial")
    assert.deepEqual(part.reasons, ["host_records_partly"])
    assert.equal(part.value, session.refs.prs.length)
  }
})

test("references.parts exists and the composite takes the worst state", () => {
  const claude = calculateFormulas(buildJobTimeline(CLOSED, [claudeJob()])).references
  assert.deepEqual(Object.keys(claude.parts), ["public_prs", "public_commits", "private_prs", "private_commits"])
  assert.equal(claude.parts.public_commits.state, "unavailable")
  assert.equal(claude.state, "partial")
  assert.deepEqual(claude.reasons, ["host_does_not_record", "host_records_partly"])
  assert.equal(claude.value.public_commits, null)
  const clean = calculateFormulas(buildJobTimeline(CLOSED, [copilotJob()])).references
  assert.equal(clean.state, "measured")
  assert.deepEqual(clean.reasons, [])
  for (const part of Object.values(clean.parts)) assert.equal(part.state, "measured")
})

test("existing worker_shared PR credit tests are unchanged in value", () => {
  const prs = [{ repo: "ourostack/desk", number: 1, agent: 0 }]
  const session = splitSession({ refs: REFS(prs) })
  session.jobs = [JOB_A, JOB_B].map((job) => ({ ...splitSession().jobs[0], job, agents: [0] }))
  const references = referencesOf(JOB_A, [session])
  assert.equal(references.value.public_prs, 0)
  assert.equal(references.parts.public_prs.value, 0)
  assert.equal(references.parts.public_prs.state, "partial")
  assert.deepEqual(references.parts.public_prs.reasons, ["worker_shared"])
  assert.deepEqual(references.partial_reasons, ["worker_shared"])
})

test("a /1 Claude job and a /1 Codex job read commit counts as unavailable with host_does_not_record, never 0", () => {
  for (const host of ["claude-code", "codex-cli"]) {
    const session = structuredClone(sessions[0])
    session.session.host = host
    session.refs.commits = []
    session.refs.private.commits = 0
    assert.equal(session.schema.endsWith("/1"), true)
    const parts = partsOf([session])
    for (const name of ["public_commits", "private_commits"]) {
      assert.equal(parts[name].state, "unavailable", `${host} ${name}`)
      assert.deepEqual(parts[name].reasons, ["host_does_not_record"], `${host} ${name}`)
    }
  }
})

test("a count whose part is unavailable is null in the composite value, never 0", () => {
  const claude = calculateFormulas(buildJobTimeline(CLOSED, [claudeJob()])).references
  assert.equal(claude.value.public_commits, null)
  assert.equal(claude.value.private_commits, null)
  assert.equal(claude.value.public_prs, sessions[0].refs.prs.length)
  assert.equal(claude.value.private_prs, sessions[0].refs.private.prs)
  const copilot = calculateFormulas(buildJobTimeline(CLOSED, [copilotJob()])).references
  assert.equal(copilot.value.public_commits, sessions[2].refs.commits.length)
  assert.equal(copilot.value.private_commits, sessions[2].refs.private.commits)
})

const withFlags = (session, ...entries) => {
  const copy = structuredClone(session)
  copy.schema = "desk.factory.published/2"
  copy.unavailable = entries.map(([field, reason]) => ({ field, reason }))
  return copy
}
const toolCounts = (formulas) => [formulas.tool_calls_by_kind, formulas.rework_signals.tool_failures, formulas.rework_signals.tool_retries]

test("tool calls by kind are partial when a session has unresolved tool durations", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [withFlags(sessions[0], ["tool_durations", "session_open"]), withFlags(sessions[2])]))
  for (const result of toolCounts(formulas)) {
    assert.equal(result.state, "partial")
    assert.equal(result.partial, true)
    assert.equal(result.uncovered_sessions, 1)
    assert.deepEqual(result.reasons, ["session_open"])
    assert.notEqual(result.class, "unavailable")
  }
  assert.deepEqual(formulas.tool_calls_by_kind.value, calculateFormulas(buildJobTimeline(CLOSED, [withFlags(sessions[0]), withFlags(sessions[2])])).tool_calls_by_kind.value)
})

test("tool failures are partial for a Codex session (tool_outcomes) and for a session with capped segments", () => {
  const codex = calculateFormulas(buildJobTimeline(CLOSED, [withFlags(codexSession(), ["tool_outcomes", "host_records_partly"])]))
  assert.equal(codex.rework_signals.tool_failures.state, "partial")
  assert.deepEqual(codex.rework_signals.tool_failures.reasons, ["host_records_partly"])
  assert.equal(typeof codex.rework_signals.tool_failures.value, "number")
  assert.equal(codex.tool_calls_by_kind.state, "measured")
  const capped = calculateFormulas(buildJobTimeline(CLOSED, [withFlags(sessions[0], ["job_segments", "capped"])]))
  for (const result of toolCounts(capped).slice(0, 2)) {
    assert.equal(result.state, "partial")
    assert.deepEqual(result.reasons, ["capped"])
  }
})

test("a session with unflagged data leaves tool counts measured", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [withFlags(sessions[0], ["permission_waits", "host_does_not_record"]), withFlags(sessions[2])]))
  for (const result of toolCounts(formulas)) {
    assert.equal(result.state, "measured")
    assert.deepEqual(result.reasons, [])
    assert.equal(result.partial, undefined)
  }
})

test("sessions, queue before start and session retouches name their basis", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, sessions))
  assert.equal(formulas.sessions.basis, "captured_sessions")
  assert.equal(formulas.queue_before_start_ms.basis, "first_captured_session")
  assert.equal(formulas.rework_signals.session_retouches.basis, "captured_sessions")
  for (const result of [formulas.sessions, formulas.queue_before_start_ms, formulas.rework_signals.session_retouches]) assert.equal(result.state, "measured")
  assert.equal(formulas.queue_before_start_ms.value, 0)
  const none = calculateFormulas(buildJobTimeline(CLOSED, []))
  assert.equal(none.queue_before_start_ms.state, "unavailable")
  assert.equal(none.queue_before_start_ms.basis, undefined)
})

test("active time is partial for a capped-segment session with reason capped", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [withFlags(sessions[0], ["job_segments", "capped"])]))
  for (const name of ["active_time_ms", "active_in_lead_ms", "busy_time_ms", "flow_efficiency"]) {
    assert.equal(formulas[name].state, "partial", name)
    assert.deepEqual(formulas[name].reasons, ["capped"], name)
  }
})

test("references are unavailable when every part is, with a real reason", () => {
  const references = calculateFormulas(buildJobTimeline(CLOSED, [])).references
  for (const part of Object.values(references.parts)) {
    assert.equal(part.state, "unavailable")
    assert.deepEqual(part.reasons, ["job_offsets_unavailable"])
  }
  assert.equal(references.class, "unavailable")
  assert.equal(references.state, "unavailable")
  assert.deepEqual(references.reasons, ["job_offsets_unavailable"])
  assert.equal(references.reason, "job_offsets_unavailable")
  assert.deepEqual(references.value, { public_pull_requests: [], public_prs: null, public_commits: null, private_prs: null, private_commits: null })
  // One part still measured or partial keeps the composite partial, not unavailable.
  assert.equal(calculateFormulas(buildJobTimeline(CLOSED, [claudeJob()])).references.state, "partial")
})

const TOKEN_TYPES = ["input", "output", "cache_read", "cache_write", "reasoning"]
const usage = (input, output, extra = {}) => ({ input, output, cache_read: 1, cache_write: 1, reasoning: 1, ...extra })
const tokenSession = (models, flags = [], base = sessions[2], job = CLOSED) => {
  const copy = withFlags(base, ...flags)
  copy.models = models
  copy.jobs = copy.jobs.map((binding) => ({ ...binding, job }))
  return copy
}
const modelOf = (id, tokens) => ({ id, requests: 1, tokens })
const totalsOf = (job, list) => calculateFormulas(buildJobTimeline(job, list)).tokens_total

test("a job with one whole Claude session gets measured input, output and total", () => {
  const claude = tokenSession([modelOf("model-alpha", usage(100, 200, { reasoning: null })), modelOf("model-beta", usage(50, 80, { reasoning: null }))], [["reasoning_tokens", "host_does_not_record"]], sessions[0])
  const total = totalsOf(CLOSED, [claude])
  assert.deepEqual(Object.keys(total), ["total", "input", "output", "cache_read", "cache_write", "reasoning"])
  assert.equal(Object.hasOwn(total, "class"), false)
  assert.deepEqual(total.input, { class: "measured", value: 150, state: "measured", reasons: [] })
  assert.deepEqual(total.output, { class: "measured", value: 280, state: "measured", reasons: [] })
  assert.deepEqual(total.total, { class: "measured", value: 430, state: "measured", reasons: [] })
  assert.equal(total.cache_read.value, 2)
})

test("reasoning is unavailable for a Claude job and does not make the total partial", () => {
  const claude = tokenSession([modelOf("model-alpha", usage(100, 200, { reasoning: null }))], [["reasoning_tokens", "host_does_not_record"]], sessions[0])
  const total = totalsOf(CLOSED, [claude])
  assert.deepEqual(total.reasoning, { class: "unavailable", value: null, reason: "host_does_not_record", state: "unavailable", reasons: ["host_does_not_record"] })
  assert.equal(total.total.state, "measured")
  assert.equal(total.total.value, 300)
})

test("a null token counter makes that type partial and the others stay measured", () => {
  const first = tokenSession([modelOf("model-alpha", usage(100, 200, { cache_read: null }))])
  const second = tokenSession([modelOf("model-beta", usage(10, 20, { cache_read: 7 }))], [], sessions[0])
  const total = totalsOf(CLOSED, [first, second])
  assert.deepEqual(total.cache_read, { class: "measured", value: 7, partial: true, uncovered_sessions: 1, partial_reasons: ["field_absent"], state: "partial", reasons: ["field_absent"] })
  assert.equal(total.input.state, "measured")
  assert.equal(total.input.value, 110)
  assert.equal(total.total.state, "measured")
  const noCache = totalsOf(CLOSED, [tokenSession([modelOf("model-alpha", usage(1, 2, { cache_read: null }))])])
  assert.deepEqual(noCache.cache_read, { class: "unavailable", value: null, reason: "field_absent", state: "unavailable", reasons: ["field_absent"] })
  const noInput = totalsOf(CLOSED, [tokenSession([modelOf("model-alpha", usage(null, 2))]), second])
  assert.equal(noInput.total.state, "partial")
  assert.equal(noInput.total.value, 32)
  assert.deepEqual(noInput.total.reasons, ["field_absent"])
  const outputGone = totalsOf(CLOSED, [tokenSession([modelOf("model-alpha", usage(5, null))])])
  assert.equal(outputGone.output.state, "unavailable")
  assert.equal(outputGone.total.state, "unavailable")
  assert.equal(outputGone.total.value, null)
  assert.deepEqual(outputGone.total.reasons, ["field_absent"])
})

test("the total counts a session once for each part it is missing from, never only the larger part's count", () => {
  const noInput = tokenSession([modelOf("model-alpha", usage(null, 2))])
  const noOutput = tokenSession([modelOf("model-beta", usage(3, null))], [], sessions[0])
  const whole = tokenSession([modelOf("model-beta", usage(10, 20))], [], sessions[1])
  const total = totalsOf(CLOSED, [noInput, noOutput, whole])
  assert.equal(total.input.uncovered_sessions, 1)
  assert.equal(total.output.uncovered_sessions, 1)
  assert.equal(total.total.state, "partial")
  assert.equal(total.total.value, 35)
  assert.equal(total.total.uncovered_sessions, 2, "two different sessions are missing a part, so two are uncovered in the total")
})

test("a host that records tokens partly leaves the type partial with its value", () => {
  const codex = tokenSession([modelOf("model-gamma", usage(30, 40))], [["tokens", "host_records_partly"]])
  const total = totalsOf(CLOSED, [codex])
  assert.equal(total.input.state, "partial")
  assert.equal(total.input.value, 30)
  assert.deepEqual(total.input.reasons, ["host_records_partly"])
  assert.equal(total.total.state, "partial")
  assert.equal(total.total.value, 70)
})

test("a job whose sessions have empty models has an unavailable token total, never zero", () => {
  for (const flags of [[["tokens", "field_absent"], ["models", "field_absent"]], []]) {
    const total = totalsOf(CLOSED, [tokenSession([], flags)])
    for (const type of ["total", ...TOKEN_TYPES]) {
      assert.equal(total[type].state, "unavailable", type)
      assert.equal(total[type].value, null, type)
      assert.deepEqual(total[type].reasons, ["field_absent"], type)
    }
  }
  const none = totalsOf(CLOSED, [])
  assert.equal(none.total.state, "unavailable")
  assert.deepEqual(none.total.reasons, ["job_offsets_unavailable"])
  const mixed = totalsOf(CLOSED, [tokenSession([], [["tokens", "field_absent"]]), tokenSession([], [["models", "log_truncated"]])])
  assert.equal(mixed.input.reason, "mixed")
  assert.deepEqual(mixed.input.reasons, ["field_absent", "log_truncated"])
})

const splitWithModels = (...models) => splitSession({ models })
const WHOLE_JOB = [modelOf("model-alpha", usage(100, 200))]

test("a job owning some workers of a session is partial with worker_split and the split session is not counted", () => {
  const whole = tokenSession([modelOf("model-gamma", usage(10, 20))], [], sessions[2], JOB_A)
  const total = totalsOf(JOB_A, [whole, splitWithModels(...WHOLE_JOB)])
  for (const type of ["total", ...TOKEN_TYPES]) {
    assert.equal(total[type].state, "partial", type)
    assert.deepEqual(total[type].reasons, ["worker_split"], type)
    assert.equal(total[type].uncovered_sessions, 1, type)
  }
  assert.equal(total.input.value, 10)
  assert.equal(total.output.value, 20)
  assert.equal(total.total.value, 30)
})

test("a job whose every session is split is unavailable with worker_split", () => {
  const total = totalsOf(JOB_A, [splitWithModels(...WHOLE_JOB)])
  for (const type of ["total", ...TOKEN_TYPES]) {
    assert.equal(total[type].state, "unavailable", type)
    assert.equal(total[type].value, null, type)
    assert.deepEqual(total[type].reasons, ["worker_split"], type)
  }
})

test("two jobs sharing a session each report worker_split and neither reports the whole", () => {
  const shared = [splitWithModels(...WHOLE_JOB)]
  for (const job of [JOB_A, JOB_B]) {
    const total = totalsOf(job, shared)
    assert.equal(total.total.state, "unavailable")
    assert.deepEqual(total.total.reasons, ["worker_split"])
    assert.equal(total.total.value, null)
  }
})

test("a split session that also lacks the type keeps both reasons when no whole session counts", () => {
  const total = totalsOf(JOB_A, [splitWithModels(...WHOLE_JOB), tokenSession([], [["tokens", "log_truncated"]], sessions[2], JOB_A)])
  assert.equal(total.input.state, "unavailable")
  assert.deepEqual(total.input.reasons, ["log_truncated", "worker_split"])
})

// A session whose job clock is flagged unreadable. `untimed` also drops its offsets, as publishing does for a job whose offsets were lost.
const clockFlagged = (session, { untimed = false, reason = "source_unreadable" } = {}) => {
  const copy = withFlags(session, ["job_offsets", reason])
  if (untimed) copy.jobs = copy.jobs.map((binding) => binding.job === CLOSED ? { ...binding, session_offset_ms: null, transitions: [], observed: { status: "done", offset_ms: null } } : binding)
  return copy
}
const CLOCK_RESULTS = ["queue_before_start_ms", "active_time_ms", "active_in_lead_ms", "active_before_card_ms", "busy_time_ms", "parallelism", "concurrent_sessions", "concurrent_agents", "flow_efficiency"]

test("queue before start is unavailable when every timed session has an unreadable job clock, and partial when one has", () => {
  const all = calculateFormulas(buildJobTimeline(CLOSED, [clockFlagged(sessions[0]), clockFlagged(sessions[2])]))
  assert.equal(all.queue_before_start_ms.state, "unavailable")
  assert.equal(all.queue_before_start_ms.value, null)
  assert.deepEqual(all.queue_before_start_ms.reasons, ["source_unreadable"])
  const one = calculateFormulas(buildJobTimeline(CLOSED, [clockFlagged(sessions[0]), withFlags(sessions[2])]))
  assert.equal(one.queue_before_start_ms.state, "partial")
  assert.equal(one.queue_before_start_ms.uncovered_sessions, 1)
  assert.equal(one.queue_before_start_ms.basis, "first_captured_session")
  assert.notEqual(one.queue_before_start_ms.value, null)
})

test("lead contributors never list an unavailable queue as a zero", () => {
  // One of two sessions flagged: the queue is partial, so it is listed with its own partial mark.
  const some = calculateFormulas(buildJobTimeline(CLOSED, [clockFlagged(sessions[0]), withFlags(sessions[2])]))
  assert.equal(some.lead_contributors.state, "partial")
  assert.ok(some.lead_contributors.value.some((entry) => entry.key === "queue_before_start_ms" && entry.partial === true))
  // The queue is unavailable: it is not listed as a zero.
  const queueOnly = calculateFormulas(buildJobTimeline(CLOSED, [clockFlagged(sessions[0]), clockFlagged(sessions[2])]))
  assert.equal(queueOnly.queue_before_start_ms.state, "unavailable")
  assert.equal(queueOnly.lead_contributors.value?.some((entry) => entry.key === "queue_before_start_ms") ?? false, false)
})

test("lead contributors with no entry left are unavailable, never an empty partial list", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [clockFlagged(sessions[0]), clockFlagged(sessions[2])]))
  assert.equal(formulas.lead_contributors.state, "unavailable")
  assert.equal(formulas.lead_contributors.value, null)
  assert.deepEqual(formulas.lead_contributors.reasons, ["source_unreadable"])
})

// Human attention (task E7): the per-job result is built from the job's sessions and stated through `withState`.
test("attention is unavailable as not recorded for sessions that predate the record, and the key is a known formula", () => {
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, sessions))
  assert.deepEqual(formulas.attention, { class: "unavailable", state: "unavailable", value: null, reason: "not_recorded", reasons: ["not_recorded"] })
  assert.ok(FORMULA_IDS.includes("attention"))
})

test("attention is a measured inferred figure when the job's sessions record turns and publish segments", () => {
  const turn = (at_ms) => ({ at_ms, basis: "after_stop", window_ms: 3000, prompt_class: "xs", output_class: "none" })
  const own = sessions.map((facts) => ({
    ...structuredClone(facts),
    schema: "desk.factory.published/2",
    unavailable: facts.unavailable.filter((entry) => entry.field !== "human_turns"),
    human_turns: [turn(1000), turn(2000)],
    jobs: facts.jobs.map((binding) => ({ ...binding, agents: [0, 1], segments: [{ start_ms: 0, end_ms: 10_000 }] })),
  }))
  const formulas = calculateFormulas(buildJobTimeline(OPEN, own))
  assert.equal(formulas.attention.class, "inferred")
  assert.equal(formulas.attention.method, 1)
  assert.ok(formulas.attention.turns > 0)
  assert.equal(formulas.attention.value, formulas.attention.turns * 3000)
  assert.deepEqual(withState(formulas.attention), formulas.attention)
})

// A lead time never reads shorter than the work the job's own sessions recorded (the floor).
const FLOOR = "card_dates_shorter_than_work"
const segmented = (offset, transitions, observed) => {
  const one = structuredClone(sessions[0])
  one.jobs[0].agents = [0, 1]
  one.jobs[0].segments = [{ start_ms: 0, end_ms: 16000 }]
  one.jobs[0].session_offset_ms = offset
  one.jobs[0].transitions = transitions
  one.jobs[0].observed = observed
  return one
}

test("a declared lead time shorter than the job's own segments is raised to their span, as a lower bound with its reason", () => {
  // An adopted card: created and closed at the same instant, while its one session ran 16 seconds.
  const one = segmented(-1000, [], { status: "done", offset_ms: 0 })
  const formulas = calculateFormulas(buildJobTimeline(CLOSED, [one]))
  assert.deepEqual(formulas.lead_time_ms, S({ class: "inferred", value: 16000, censored: false, basis: "recorded_segment_span", partial: true, partial_reasons: [FLOOR] }, "partial", [FLOOR]))
  // What reads the card's window says so instead of answering over the wrong one.
  assert.deepEqual(formulas.flow_efficiency, S({ class: "unavailable", value: null, reason: FLOOR }, "unavailable", [FLOOR]))
  assert.deepEqual(formulas.lead_contributors, S({ class: "unavailable", value: null, reason: FLOOR }, "unavailable", [FLOOR]))
})

test("a measured done transition shorter than the segments is raised too, and an open job keeps its censored reason", () => {
  const closed = calculateFormulas(buildJobTimeline(CLOSED, [segmented(-1000, [{ to: "done", offset_ms: 5000 }], null)]))
  assert.deepEqual(closed.lead_time_ms, S({ class: "inferred", value: 16000, censored: false, basis: "recorded_segment_span", partial: true, partial_reasons: [FLOOR] }, "partial", [FLOOR]))
  assert.equal(closed.flow_efficiency.reason, FLOOR)
  const open = calculateFormulas(buildJobTimeline(CLOSED, [segmented(-1000, [{ to: "processing", offset_ms: 0 }], null)]))
  assert.deepEqual(open.lead_time_ms, S({ class: "inferred", value: 16000, censored: true, basis: "recorded_segment_span", partial: true, partial_reasons: [FLOOR] }, "partial", [FLOOR, "censored"]))
})

test("a declared lead time at least as long as the segment span is not changed", () => {
  const same = calculateFormulas(buildJobTimeline(CLOSED, [segmented(-1000, [], { status: "done", offset_ms: 16000 })]))
  assert.deepEqual(same.lead_time_ms, S({ class: "declared", value: 16000, censored: false, basis: "terminal_observation" }, "measured"))
  assert.equal(same.flow_efficiency.class, "inferred")
  assert.equal(same.lead_contributors.class, "inferred")
  const longer = calculateFormulas(buildJobTimeline(CLOSED, [segmented(-1000, [], { status: "done", offset_ms: 30000 })]))
  assert.deepEqual(longer.lead_time_ms, S({ class: "declared", value: 30000, censored: false, basis: "terminal_observation" }, "measured"))
})

test("a session whose offset is unknown, or a job with no recorded work, never moves the lead time", () => {
  const timed = segmented(-1000, [], { status: "done", offset_ms: 20000 })
  const lost = segmented(null, [], null)
  lost.session.id = "99999999-9999-4999-8999-999999999999"
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [timed, lost])).lead_time_ms, S({ class: "declared", value: 20000, censored: false, basis: "terminal_observation" }, "measured"))
  const bare = structuredClone(sessions[0])
  bare.intervals = []
  bare.jobs[0].transitions = []
  bare.jobs[0].observed = { status: "done", offset_ms: 0 }
  assert.deepEqual(calculateFormulas(buildJobTimeline(CLOSED, [bare])).lead_time_ms, S({ class: "declared", value: 0, censored: false, basis: "terminal_observation" }, "measured"))
})

test("a span that cannot be read keeps the declared figure as it is", () => {
  const timeline = buildJobTimeline(CLOSED, [segmented(-1000, [], { status: "done", offset_ms: 0 })])
  timeline.intervals[0].start_ms = Number.NaN
  assert.deepEqual(calculateFormulas(timeline).lead_time_ms, S({ class: "declared", value: 0, censored: false, basis: "terminal_observation" }, "measured"))
})
