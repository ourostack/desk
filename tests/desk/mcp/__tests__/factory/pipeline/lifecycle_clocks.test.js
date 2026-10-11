// Factory v1.2 lifecycle clocks: the report-level request, queue and production clocks and their production periods
// (`lifecycle-clocks.js`). The paired fixture (`fixtures/v12-clocks.json`) is byte-identical to the store's
// (ourostack/factory `.github/scripts/__tests__/fixtures/v12-clocks.json`), whose readers check the same envelopes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { CLOCK_BASES, CLOCK_KEYS, deriveLifecycleClocks, jobLifecycleClocks, lifecycleCoverage } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/lifecycle-clocks.js"
import { build } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { jobRecord, resolveLabels } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"
import { timelineAdditions } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/stretches.js"
import { buildTimelines } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"
import { jobWalk } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/walk.js"
import { validatePublished } from "../../../../../../plugins/desk/mcp/src/factory/published-schema.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = path.join(here, "..", "fixtures", "v12-clocks.json")
const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"))
const MIN = 60_000
const J = (digit) => digit.repeat(32)
const S = (n) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`

const WHOLE = Object.freeze({ state: "measured", reasons: [], bound: null })
const allWhole = () => ({ activity: { ...WHOLE }, classification: { ...WHOLE }, placement: { ...WHOLE }, history: { ...WHOLE } })
const derive = (transitions, observations, working, coverage = allWhole(), sessions) => deriveLifecycleClocks({ timeline: { transitions, observations, ...(sessions === undefined ? {} : { sessions }) }, working, coverage })
const value = (clock) => (clock.state === "unavailable" ? null : clock.value)

// --- the paired synthetic contract ------------------------------------------------------------------------------------------------

test("every paired synthetic case derives exactly the store's expected envelopes", () => {
  assert.equal(fixture.schema, "factory.v12.clocks.fixture/1")
  assert.equal(fixture.synthetic, true)
  assert.deepEqual(fixture.cases.map((c) => c.id), ["new_request_unknown", "adopted_positive_uncaptured", "adopted_negative", "reopened", "late_work", "untimed_boundary", "root_wait_child_work", "ask_wait", "opposing_bounds", "truncated_segments"])
  for (const c of fixture.cases) assert.deepEqual(deriveLifecycleClocks(structuredClone(c.input)), c.expected, c.id)
})

test("the derivation does not change its inputs", () => {
  for (const c of fixture.cases) {
    const input = structuredClone(c.input)
    deriveLifecycleClocks(input)
    assert.deepEqual(input, c.input, c.id)
  }
})

// --- review focus 1: an adopted task never acquires a request or queue clock ------------------------------------------------------

test("positive_adoption_is_not_a_request", () => {
  // The card was made for work already under way: the first recorded work is ten minutes after the card, but the true request and the
  // earlier work were never captured. A positive first offset is not proof of the original request.
  const adopted = derive([{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: 40 * MIN }], [{ status: "done", offset_ms: 40 * MIN }], [[10 * MIN, 30 * MIN]])
  for (const key of ["request_to_delivery_ms", "queue_ms"]) {
    assert.deepEqual(adopted[key], { class: "unavailable", state: "unavailable", reasons: ["original_request_not_recorded"], basis: ["original_request_not_recorded"], so_far: false }, key)
    assert.equal(Object.hasOwn(adopted[key], "value"), false, key)
  }
  // Production still reads from the evidenced work boundary.
  assert.equal(adopted.production_ms.value, 30 * MIN)
  // Work recorded before the card existed never gives a negative queue: the queue stays unavailable and says why.
  const early = derive([{ to: "done", offset_ms: 5 * MIN }], [], [[-20 * MIN, -10 * MIN], [0, 2 * MIN]])
  for (const key of ["request_to_delivery_ms", "queue_ms"]) {
    assert.equal(early[key].state, "unavailable", key)
    assert.deepEqual(early[key].reasons, ["original_request_not_recorded", "work_before_card"], key)
  }
  assert.deepEqual(early.production_periods.items, [{ start_ms: -20 * MIN, end_ms: 5 * MIN, start_basis: "recorded_activity", end_basis: "done_transition", so_far: false }])
  assert.equal(early.production_ms.value, 25 * MIN)
  // No clock anywhere carries a negative value.
  for (const c of fixture.cases) for (const key of CLOCK_KEYS) if (c.expected[key].state !== "unavailable") assert.ok(c.expected[key].value >= 0, `${c.id} ${key}`)
})

// --- reopened work keeps its episodes apart -----------------------------------------------------------------------------------------

test("episodes_exclude_between_deliveries", () => {
  const transitions = [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: 30 }, { to: "processing", offset_ms: 100 }, { to: "done", offset_ms: 130 }]
  const observations = [{ status: "done", offset_ms: 30 }, { status: "done", offset_ms: 60 }, { status: "done", offset_ms: 130 }]
  const clocks = derive(transitions, observations, [[10, 20], [110, 120]])
  assert.deepEqual(clocks.production_periods, {
    state: "measured",
    reasons: [],
    items: [
      { start_ms: 10, end_ms: 30, start_basis: "recorded_activity", end_basis: "done_transition", so_far: false },
      { start_ms: 110, end_ms: 130, start_basis: "recorded_activity", end_basis: "done_transition", so_far: false },
    ],
  })
  assert.deepEqual([value(clocks.production_ms), value(clocks.active_in_production_ms), value(clocks.production_remainder_ms)], [40, 20, 20])
  // The delivery-to-reopen stretch (30 to 110) is neither production nor active time: the remainder holds only in-episode time.
  assert.ok(value(clocks.production_remainder_ms) < 110 - 30)
  // A repeated done observation (60) opens no episode.
  assert.equal(clocks.production_periods.items.length, 2)
  // The legacy lead time of the same history is unchanged: it still runs from the card to the final done.
  const session = facts({ id: S(1), duration: 140, intervals: [turn(0, 10, 20), turn(0, 110, 120)], jobs: [binding(J("a"), 0, { transitions, observed: { status: "done", offset_ms: 130 } })] })
  const { formulas, clocks: reported } = walkOf([session], J("a"))
  assert.equal(formulas.lead_time_ms.value, 130)
  assert.equal(formulas.lead_time_ms.state, "measured")
  assert.deepEqual(reported.production_periods.items.map((p) => [p.start_ms, p.end_ms]), [[10, 30], [110, 130]])
})

test("an open episode runs only to the latest supported observation and says so far, never to the reader's clock", () => {
  const clocks = derive([{ to: "processing", offset_ms: 0 }], [], [[5, 10]], allWhole(), [{ offset_ms: 0, end_ms: 50 }])
  assert.deepEqual(clocks.production_periods.items, [{ start_ms: 5, end_ms: 50, start_basis: "recorded_activity", end_basis: "latest_observation", so_far: true }])
  assert.deepEqual(clocks.production_ms, { class: "measured", state: "partial", value: 45, reasons: ["censored"], basis: ["recorded_activity", "latest_observation", "lifecycle_history"], bound: "lower", so_far: true })
  assert.equal(clocks.active_in_production_ms.so_far, true)
  // Reopened and not yet worked on: the delivered episode stays, the job is open, so production is at least that.
  const reopened = derive([{ to: "done", offset_ms: 30 }, { to: "processing", offset_ms: 100 }], [], [[10, 20]], allWhole(), [{ offset_ms: 0, end_ms: 40 }, { offset_ms: 100, end_ms: 105 }])
  assert.deepEqual(reopened.production_periods, { state: "partial", reasons: ["censored"], items: [{ start_ms: 10, end_ms: 30, start_basis: "recorded_activity", end_basis: "done_transition", so_far: false }] })
  assert.equal(reopened.production_ms.bound, "lower")
})

test("the delivering turn's tail is not late work, and work under way at a reopen starts the new episode at the reopen", () => {
  // The turn that recorded the delivery ran on for five more: it is clipped at the delivery, not a reason to drop the clocks.
  const tail = derive([{ to: "done", offset_ms: 20 }], [], [[0, 25]])
  assert.deepEqual([value(tail.production_ms), value(tail.active_in_production_ms), value(tail.production_remainder_ms)], [20, 20, 0])
  // One stretch of work runs through a delivery and a reopen: the time between them is in neither episode.
  const through = derive([{ to: "done", offset_ms: 20 }, { to: "processing", offset_ms: 50 }, { to: "done", offset_ms: 80 }], [], [[0, 60], [70, 75]])
  assert.deepEqual(through.production_periods.items.map((p) => [p.start_ms, p.end_ms]), [[0, 20], [50, 80]])
  assert.deepEqual([value(through.production_ms), value(through.active_in_production_ms), value(through.production_remainder_ms)], [50, 35, 15])
})

// --- missing or late history is never exact --------------------------------------------------------------------------------------

test("late_or_untimed_history_is_not_exact", () => {
  const unavailableEverywhere = (clocks, reasons, label) => {
    for (const key of ["production_ms", "active_in_production_ms", "production_remainder_ms"]) {
      assert.equal(clocks[key].state, "unavailable", `${label} ${key}`)
      assert.equal(Object.hasOwn(clocks[key], "value"), false, `${label} ${key}`)
      assert.deepEqual(clocks[key].reasons, reasons, `${label} ${key}`)
    }
    assert.deepEqual(clocks.production_periods, { state: "unavailable", reasons, items: [] }, label)
  }
  // Work after the delivery with no recorded reopen.
  unavailableEverywhere(derive([{ to: "done", offset_ms: 20 }], [], [[0, 10], [30, 40]]), ["late_work_without_reopen"], "late")
  // Work between a delivery and a later reopen is late too: the reopen does not reach back.
  unavailableEverywhere(derive([{ to: "done", offset_ms: 20 }, { to: "processing", offset_ms: 50 }, { to: "done", offset_ms: 80 }], [], [[0, 10], [30, 40], [60, 70]]), ["late_work_without_reopen"], "between")
  // A transition with no time cannot split episodes, even when the coverage given does not say so.
  unavailableEverywhere(derive([{ to: "done", offset_ms: null }, { to: "processing", offset_ms: null }], [], [[0, 10], [30, 40]]), ["episode_boundary_not_recorded"], "untimed")
  // A reopen seen only as a later open observation has no recorded boundary.
  unavailableEverywhere(derive([{ to: "done", offset_ms: 20 }], [{ status: "processing", offset_ms: 60 }], [[0, 10], [30, 40]]), ["episode_boundary_not_recorded"], "observed reopen")
  // Truncated or dropped lifecycle history.
  const truncated = { ...allWhole(), history: { state: "partial", reasons: ["episode_history_incomplete"], bound: null } }
  unavailableEverywhere(derive([{ to: "done", offset_ms: 20 }], [], [[0, 10]], truncated), ["episode_history_incomplete"], "truncated")
  // No recorded work at all is no production, not a zero.
  unavailableEverywhere(derive([{ to: "done", offset_ms: 20 }], [], []), ["no_active_intervals"], "no work")
  // Unread activity is not a zero either.
  unavailableEverywhere(derive([{ to: "done", offset_ms: 20 }], [], [], { ...allWhole(), activity: { state: "unavailable", reasons: ["log_missing"], bound: null } }), ["log_missing"], "unread")
  // A cancelled job delivered nothing.
  unavailableEverywhere(derive([{ to: "cancelled", offset_ms: 20 }], [], [[0, 10]]), ["cancelled"], "cancelled")
  // A job whose status was never recorded has no delivery boundary.
  unavailableEverywhere(derive([], [], [[0, 10]]), ["status_unavailable"], "no status")
})

test("a delivery seen only as a card observation or with no time at all is a bounded fallback, never an exact episode", () => {
  // A timed done observation is the card's last update: the delivery came on or before it.
  const observed = derive([{ to: "processing", offset_ms: 0 }], [{ status: "done", offset_ms: 50 }], [[10, 20]])
  assert.deepEqual(observed.production_ms, { class: "declared", state: "partial", value: 40, reasons: ["finish_from_card_update"], basis: ["recorded_activity", "terminal_observation", "lifecycle_history"], bound: "upper", so_far: false })
  assert.equal(observed.production_periods.state, "partial")
  assert.equal(observed.production_periods.items[0].end_basis, "terminal_observation")
  // Done, but no record gives when: the episode runs to the end of the recorded work and is at least that.
  const untimed = derive([{ to: "processing", offset_ms: 0 }], [{ status: "done", offset_ms: null }], [[10, 20], [25, 35]])
  assert.deepEqual(untimed.production_ms, { class: "inferred", state: "partial", value: 25, reasons: ["finish_time_not_known"], basis: ["recorded_activity", "recorded_work_end", "lifecycle_history"], bound: "lower", so_far: false })
  assert.equal(untimed.production_periods.items[0].end_basis, "recorded_work_end")
  // The remainder takes the production's direction when the active time is whole.
  assert.equal(untimed.production_remainder_ms.bound, "lower")
  assert.equal(observed.production_remainder_ms.bound, "upper")
})

test("the active and remainder clocks add up to production wherever production is known", () => {
  for (const c of fixture.cases) {
    const clocks = deriveLifecycleClocks(structuredClone(c.input))
    if (clocks.production_ms.state === "unavailable") {
      assert.equal(clocks.active_in_production_ms.state, "unavailable", c.id)
      assert.equal(clocks.production_remainder_ms.state, "unavailable", c.id)
      continue
    }
    assert.equal(clocks.active_in_production_ms.value + clocks.production_remainder_ms.value, clocks.production_ms.value, c.id)
    const periods = clocks.production_periods.items.reduce((total, p) => total + p.end_ms - p.start_ms, 0)
    assert.equal(periods, clocks.production_ms.value, c.id)
  }
})

// --- the shape stays the store's ----------------------------------------------------------------------------------------------------

test("Clock classes are pinned to their basis and the shapes stay inside the closed vocabulary", () => {
  const classes = new Set()
  for (const c of fixture.cases) {
    const clocks = deriveLifecycleClocks(structuredClone(c.input))
    assert.deepEqual(Object.keys(clocks).sort(), [...CLOCK_KEYS, "production_periods"].sort(), c.id)
    for (const key of CLOCK_KEYS) {
      const clock = clocks[key]
      classes.add(clock.class)
      for (const basis of clock.basis) assert.ok(CLOCK_BASES.includes(basis), `${c.id} ${key} ${basis}`)
      assert.equal(clock.state === "unavailable", clock.class === "unavailable", `${c.id} ${key}`)
      if (clock.state === "partial") assert.ok(Object.hasOwn(clock, "bound"), `${c.id} ${key}`)
      if (clock.state === "partial" && clock.bound === null) assert.equal(typeof clock.bound_reason, "string", `${c.id} ${key}`)
      if (clock.state !== "partial") assert.equal(Object.hasOwn(clock, "bound"), false, `${c.id} ${key}`)
    }
    // Remainder is derived from two other figures, so it is inferred; the recorded-activity union is measured.
    if (clocks.production_remainder_ms.state !== "unavailable") assert.equal(clocks.production_remainder_ms.class, "inferred", c.id)
    if (clocks.active_in_production_ms.state !== "unavailable") assert.equal(clocks.active_in_production_ms.class, "measured", c.id)
  }
  assert.deepEqual([...classes].sort(), ["inferred", "measured", "unavailable"])
  // A delivery read from a card observation is declared, one read from the end of the recorded work inferred.
  assert.equal(derive([], [{ status: "done", offset_ms: 50 }], [[10, 20]]).production_ms.class, "declared")
  assert.equal(derive([], [{ status: "done", offset_ms: null }], [[10, 20]]).production_ms.class, "inferred")
})

test("opposing bounds give a null direction with its reason, never a rounded figure", () => {
  const opposing = fixture.cases.find((c) => c.id === "opposing_bounds")
  const clocks = deriveLifecycleClocks(structuredClone(opposing.input))
  assert.equal(clocks.production_ms.bound, "lower")
  assert.equal(clocks.active_in_production_ms.bound, "lower")
  assert.deepEqual([clocks.production_remainder_ms.bound, clocks.production_remainder_ms.bound_reason], [null, "bound_reasons_conflict"])
  // Labels that may count waits as work make the active time at most this, and the remainder at least this.
  const partlyLabeled = derive([{ to: "done", offset_ms: 20 }], [], [[0, 10]], { ...allWhole(), classification: { state: "partial", reasons: ["partial"], bound: "upper" } })
  assert.equal(partlyLabeled.active_in_production_ms.bound, "upper")
  assert.equal(partlyLabeled.production_remainder_ms.bound, "lower")
  assert.equal(partlyLabeled.production_ms.state, "measured")
})

// --- the coverage adapter keeps capture, placement, labels and history apart -------------------------------------------------------

test("coverage_adapter_does_not_substitute_labels_for_capture", () => {
  const placed = { offset_ms: 0, end_ms: 100 }
  const timeline = (overrides = {}) => ({ transitions: [{ to: "done", offset_ms: 50 }], observations: [], sessions: [placed], source_sessions: [{ unavailable: [], jobs: [{ job: J("a"), transitions: [{ to: "done", offset_ms: 50 }] }] }], job: J("a"), ...overrides })
  const measuredActivity = { class: "measured", state: "measured", value: 10, reasons: [] }
  // Complete labels, truncated capture: the activity stays partial, whatever the labels say.
  const truncated = lifecycleCoverage({ activity: { class: "measured", state: "partial", value: 10, reasons: ["log_truncated"] }, labels: { reasons: [] }, placement: timeline().sessions, history: timeline() })
  assert.deepEqual(truncated, {
    activity: { state: "partial", reasons: ["log_truncated"], bound: "lower" },
    classification: { state: "measured", reasons: [], bound: null },
    placement: { state: "measured", reasons: [], bound: null },
    history: { state: "measured", reasons: [], bound: null },
  })
  // Complete labels, an unplaced session: placement and history say so; the labels and capture do not hide it.
  const unplacedTimeline = timeline({ sessions: [placed, { offset_ms: null, end_ms: null }], source_sessions: [...timeline().source_sessions, { unavailable: [{ field: "job_offsets", reason: "source_unreadable" }], jobs: [{ job: J("a"), transitions: [] }] }] })
  const unplaced = lifecycleCoverage({ activity: measuredActivity, labels: { reasons: [] }, placement: unplacedTimeline.sessions, history: unplacedTimeline })
  assert.deepEqual(unplaced.placement, { state: "partial", reasons: ["job_offsets_unavailable"], bound: "lower" })
  assert.deepEqual(unplaced.history, { state: "partial", reasons: ["episode_history_incomplete"], bound: null })
  assert.deepEqual(unplaced.classification, { state: "measured", reasons: [], bound: null })
  // No labels, whole capture: classification is unavailable, capture stays measured.
  const unlabeled = lifecycleCoverage({ activity: measuredActivity, labels: { unavailable: ["not_labeled"] }, placement: timeline().sessions, history: timeline() })
  assert.deepEqual(unlabeled.activity, { state: "measured", reasons: [], bound: null })
  assert.deepEqual(unlabeled.classification, { state: "unavailable", reasons: ["not_labeled"], bound: null })
  // Some sessions labeled: the corrected working time may still count waits as work, so it is at most this.
  const partly = lifecycleCoverage({ activity: measuredActivity, labels: { reasons: ["partial"] }, placement: timeline().sessions, history: timeline() })
  assert.deepEqual(partly.classification, { state: "partial", reasons: ["partial"], bound: "upper" })
  // Untimed transitions and capped transition lists are lifecycle history gaps, not capture gaps.
  const untimed = lifecycleCoverage({ activity: measuredActivity, labels: { reasons: [] }, placement: timeline().sessions, history: timeline({ transitions: [{ to: "done", offset_ms: null }] }) })
  assert.deepEqual(untimed.history, { state: "partial", reasons: ["episode_boundary_not_recorded"], bound: null })
  assert.deepEqual(untimed.activity, { state: "measured", reasons: [], bound: null })
  const capped = timeline({ source_sessions: [{ unavailable: [], jobs: [{ job: J("a"), transitions: Array.from({ length: 1000 }, (_, i) => ({ to: i % 2 ? "done" : "processing", offset_ms: i })) }] }] })
  assert.deepEqual(lifecycleCoverage({ activity: measuredActivity, labels: { reasons: [] }, placement: capped.sessions, history: capped }).history, { state: "partial", reasons: ["episode_history_incomplete"], bound: null })
  // Every session unplaced: placement is unavailable, and the clocks say so rather than read zero.
  const none = timeline({ sessions: [{ offset_ms: null, end_ms: null }] })
  const nowhere = lifecycleCoverage({ activity: { class: "unavailable", state: "unavailable", reasons: ["job_offsets_unavailable"] }, labels: { unavailable: ["not_labeled"] }, placement: none.sessions, history: none })
  assert.deepEqual(nowhere.placement, { state: "unavailable", reasons: ["job_offsets_unavailable"], bound: null })
  const clocks = deriveLifecycleClocks({ timeline: none, working: [], coverage: nowhere })
  assert.equal(clocks.production_ms.state, "unavailable")
  assert.ok(clocks.production_ms.reasons.includes("job_offsets_unavailable"))
  // Complete labels never turn a truncated capture whole in the clocks either.
  const derived = deriveLifecycleClocks({ timeline: timeline(), working: [[0, 10]], coverage: truncated })
  assert.deepEqual([derived.active_in_production_ms.state, derived.active_in_production_ms.reasons], ["partial", ["log_truncated"]])
})

// --- through the reports: worker union and the ask-tool pause --------------------------------------------------------------------

const AGENTS = [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }]
const turn = (agent, start, end) => ({ kind: "turn", agent, start_ms: start, end_ms: end })
const sub = (agent, start, end) => ({ kind: "subagent", agent, start_ms: start, end_ms: end })
const askTool = (agent, start, end) => ({ kind: "tool", agent, tool: "other", outcome: "ok", start_ms: start, end_ms: end })
const askWait = (agent, start, end) => ({ kind: "human_wait", agent, start_ms: start, end_ms: end, stop: { end: "ask_question", asks: true, pending_agents: false } })

function rawFacts({ id, duration, agents = [AGENTS[0]], intervals, jobs }) {
  return {
    schema: "desk.factory.published/4",
    session: { host: "claude-code", id, host_version: "2.1.0", entrypoint: "cli", duration_ms: duration, ended: true, end_reason: "complete" },
    plugins: [{ name: "desk", version: "3.2.0-alpha.240" }],
    models: [{ id: "model-alpha", requests: 1, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: null } }],
    agents,
    intervals,
    counts: { tool_calls: {}, tool_failures: {}, tool_retries: 0, api_retries: 0, compactions: 0 },
    refs: { prs: [], commits: [], private: { prs: 0, commits: 0 } },
    jobs,
    human_turns: [],
    unavailable: [{ field: "prs", reason: "host_records_partly" }],
  }
}
const facts = (fields) => normalizePublished(rawFacts(fields))

function binding(job, offset, { transitions, observed, agents = [0], done = 30 * MIN } = {}) {
  return {
    job,
    basis: ["desk_tool"],
    session_offset_ms: offset,
    agents,
    transitions: transitions ?? [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: done }],
    observed: observed ?? { status: "done", offset_ms: done },
    finished_on: "2026-10-07",
    finished_basis: "transition",
  }
}

function walkOf(sessions, job) {
  const labels = resolveLabels([], sessions)
  const timeline = buildTimelines(sessions).find((candidate) => candidate.job === job)
  const formulas = calculateFormulas(timeline)
  const record = jobRecord({ timeline, formulas }, labels.byJobSession)
  const additions = timelineAdditions(timeline)
  const walk = jobWalk({ timeline, formulas, additions }, labels, record.finished)
  return { timeline, formulas, walk, clocks: jobLifecycleClocks({ timeline, formulas, walk }) }
}

// Builds a store of `raws` and returns the built job file and rollup rows of `job`.
function built(raws, job) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-factory-clocks-"))
  try {
    mkdirSync(path.join(root, "store", "facts"), { recursive: true })
    for (const raw of raws) {
      assert.ok(validatePublished(raw).ok, JSON.stringify(validatePublished(raw).errors))
      writeFileSync(path.join(root, "store", "facts", `${raw.session.host}-${raw.session.id}.json`), `${JSON.stringify(raw)}\n`)
    }
    build({ storeDir: path.join(root, "store"), outDir: path.join(root, "out") })
    const read = (relative) => JSON.parse(readFileSync(path.join(root, "out", relative), "utf8"))
    return {
      report: read(`jobs/${job}.json`),
      markdown: readFileSync(path.join(root, "out", "jobs", `${job}.md`), "utf8"),
      task: read("rollups/tasks.json").jobs.find((row) => row.job === job),
      stackup: read("rollups/stackup.json").jobs.find((row) => row.job === job),
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test("worker_union_through_reports", () => {
  // The root asks the operator from 10 to 20 minutes while its subagent works from 12 to 18: six minutes of that pause are recorded
  // work, neither zero nor counted twice.
  const raw = rawFacts({
    id: S(10),
    duration: 30 * MIN,
    agents: AGENTS,
    intervals: [turn(0, 0, 30 * MIN), askTool(0, 10 * MIN, 20 * MIN), askWait(0, 10 * MIN, 20 * MIN), sub(0, 12 * MIN, 18 * MIN), turn(1, 12 * MIN, 18 * MIN)],
    jobs: [binding(J("a"), 0, { agents: [0, 1] })],
  })
  const { report, markdown, task, stackup } = built([raw], J("a"))
  assert.equal(report.clocks.production_ms.value, 30 * MIN)
  assert.equal(report.clocks.active_in_production_ms.value, 26 * MIN)
  assert.equal(report.clocks.production_remainder_ms.value, 4 * MIN)
  // The same envelope is on the job report, its task row and its stack-up row; the legacy working time agrees with it.
  assert.deepEqual(task.clocks, report.clocks)
  assert.deepEqual(stackup.clocks, report.clocks)
  assert.equal(task.working_ms.value, 26 * MIN)
  assert.match(markdown, /^- Recorded working time in production: 1560000 ms \(measured; basis: recorded activity, lifecycle history\)\.$/mu)
  // Root and child overlapping for their whole span count once: the elapsed production is not multiplied by the workers.
  const overlap = rawFacts({ id: S(11), duration: 30 * MIN, agents: AGENTS, intervals: [turn(0, 0, 30 * MIN), sub(0, 5 * MIN, 25 * MIN), turn(1, 5 * MIN, 25 * MIN)], jobs: [binding(J("b"), 0, { agents: [0, 1] })] })
  const union = built([overlap], J("b")).report.clocks
  assert.deepEqual([union.production_ms.value, union.active_in_production_ms.value, union.production_remainder_ms.value], [30 * MIN, 30 * MIN, 0])
  // A root interruption the subagent fully covers holds no idle time, but stays a listed wait.
  const covered = rawFacts({ id: S(12), duration: 30 * MIN, agents: AGENTS, intervals: [turn(0, 0, 30 * MIN), askTool(0, 10 * MIN, 20 * MIN), askWait(0, 10 * MIN, 20 * MIN), sub(0, 10 * MIN, 20 * MIN), turn(1, 10 * MIN, 20 * MIN)], jobs: [binding(J("c"), 0, { agents: [0, 1] })] })
  const zeroIdle = built([covered], J("c"))
  assert.equal(zeroIdle.report.clocks.active_in_production_ms.value, 30 * MIN)
  assert.deepEqual(zeroIdle.report.timeline.waits.map((entry) => [entry.start_ms, entry.end_ms, entry.next_prompt_ms]), [[10 * MIN, 20 * MIN, 0]])
})

test("an ask-tool pause is not recorded work unless another worker of the task works then", () => {
  const raw = rawFacts({ id: S(13), duration: 30 * MIN, intervals: [turn(0, 0, 30 * MIN), askTool(0, 10 * MIN, 20 * MIN), askWait(0, 10 * MIN, 20 * MIN)], jobs: [binding(J("d"), 0)] })
  const { report } = built([raw], J("d"))
  assert.deepEqual([report.clocks.production_ms.value, report.clocks.active_in_production_ms.value, report.clocks.production_remainder_ms.value], [30 * MIN, 20 * MIN, 10 * MIN])
  // The legacy recorded active time keeps its meaning beside it.
  assert.equal(report.formulas.active_time_ms.value, 30 * MIN)
})

test("current published records never carry a request or queue clock, and their legacy lead time is preserved beside the clocks", () => {
  // Adopted: the card was created ten minutes into work that started earlier and was not captured.
  const raw = rawFacts({ id: S(14), duration: 30 * MIN, intervals: [turn(0, 0, 20 * MIN)], jobs: [binding(J("e"), 10 * MIN, { transitions: [{ to: "processing", offset_ms: 10 * MIN }, { to: "done", offset_ms: 40 * MIN }], observed: { status: "done", offset_ms: 40 * MIN } })] })
  const { report, task } = built([raw], J("e"))
  for (const key of ["request_to_delivery_ms", "queue_ms"]) assert.deepEqual(report.clocks[key].reasons, ["original_request_not_recorded"], key)
  assert.equal(report.formulas.lead_time_ms.value, 40 * MIN)
  assert.equal(task.lead_time_ms.value, 40 * MIN)
  assert.equal(report.clocks.production_ms.value, 30 * MIN)
})
