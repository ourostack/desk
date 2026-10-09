// Reports D4: each task's finish day, the list states of its operator prompts and pull requests, whether its session created each pull
// request, its after-stop waits with the `next_prompt` time each holds, and the ask-tool idle rule.
import { test } from "node:test"
import assert from "node:assert/strict"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { validatePublished } from "../../../../../../plugins/desk/mcp/src/factory/published-schema.js"
import { REASON_TEXT } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/report.js"
import { jobRecord, resolveLabels } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"
import { ASK_ENDS, timelineAdditions } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/stretches.js"
import { buildTimelines } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"
import { REASON_CHANGE, jobWalk, stackupRollup, tasksRollup } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/walk.js"

const J = (digit) => digit.repeat(32)
const S = (n) => `30000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const MIN = 60_000

const CLAUDE_FLAGS = [{ field: "prs", reason: "host_records_partly" }]

// A published session; `/4` unless `schema` says otherwise.
function rawFacts({ id, duration, host = "claude-code", schema = "desk.factory.published/4", agents = [{ n: 0, parent: null, model: "model-alpha" }], intervals, jobs, prs = [], humanTurns, unavailable = CLAUDE_FLAGS }) {
  return {
    schema,
    session: { host, id, host_version: "2.1.0", entrypoint: "cli", duration_ms: duration, ended: true, end_reason: "complete" },
    plugins: [{ name: "desk", version: "3.2.0-alpha.240" }],
    models: [{ id: "model-alpha", requests: 1, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: null } }],
    agents,
    intervals,
    counts: { tool_calls: {}, tool_failures: {}, tool_retries: 0, api_retries: 0, compactions: 0 },
    refs: { prs, commits: [], private: { prs: 0, commits: 0 } },
    jobs,
    ...(humanTurns === undefined ? {} : { human_turns: humanTurns }),
    unavailable,
  }
}

// The same, in the normalized shape the pipeline reads.
const facts = (fields) => normalizePublished(rawFacts(fields))

// A binding of a whole session to `job` (worker 0 over every segment), done at `done` on the job clock, finished on `day` by `basis`.
function bound(job, offset, { done = 60 * MIN, status = "done", day = "2026-10-07", basis = "transition", transitions, observed, segments, length = 60 * MIN } = {}) {
  return {
    job,
    basis: ["desk_tool"],
    session_offset_ms: offset,
    agents: [0],
    segments: segments ?? [{ start_ms: 0, end_ms: length }],
    transitions: transitions ?? [{ to: "processing", offset_ms: 0 }, { to: status, offset_ms: done }],
    observed: observed ?? { status, offset_ms: done },
    finished_on: day,
    finished_basis: day === null ? null : basis,
  }
}

// An older binding: no finish day keys.
function older(job, offset, done = 60 * MIN) {
  return { job, basis: ["desk_tool"], session_offset_ms: offset, agents: [0], segments: [{ start_ms: 0, end_ms: done }], transitions: [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: done }], observed: { status: "done", offset_ms: done } }
}

const span = (kind, agent, start, end) => ({ kind, agent, start_ms: start, end_ms: end })
const tool = (agent, start, end, toolKind = "shell", outcome = "ok") => ({ kind: "tool", agent, tool: toolKind, outcome, start_ms: start, end_ms: end })
const wait = (start, end, stop, agent = 0) => ({ ...span("human_wait", agent, start, end), ...(stop === undefined ? {} : { stop }) })
const stopOf = (end, asks = false, pending = false) => ({ end, asks, pending_agents: pending })
const turn = (at, window = 1 * MIN) => ({ at_ms: at, basis: "after_stop", window_ms: window, prompt_class: "s", output_class: "s" })

const stretch = (start, end, cls, waste, evidence) => ({ start_ms: start, end_ms: end, class: cls, waste, mura: false, muri: false, evidence, confidence: "high", evaluator_version: "3.2.0-alpha.240" })
const labelsFile = (job, session, stretches) => ({ schema: "desk.factory.labels/2", job, session, evaluator: { plugin_version: "3.2.0-alpha.240", model: "model-observer", rubric: "2" }, stretches, unavailable: [] })

function walkOf(sessions, job, labelFiles = []) {
  const labels = resolveLabels(labelFiles, sessions)
  const timeline = buildTimelines(sessions).find((candidate) => candidate.job === job)
  const formulas = calculateFormulas(timeline)
  const record = jobRecord({ timeline, formulas }, labels.byJobSession)
  const additions = timelineAdditions(timeline)
  return { timeline, formulas, additions, walk: jobWalk({ timeline, formulas, additions }, labels, record.finished) }
}

const sum = (values) => values.reduce((total, value) => total + value, 0)

// --- finish day ---------------------------------------------------------------------------------------------------------------

test("a finish day from the session's own transition is measured, and the task and stack-up rows carry the same envelope", () => {
  const session = facts({ id: S(1), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0)] })
  const { walk } = walkOf([session], J("a"))
  assert.deepEqual(walk.finished_on, { class: "measured", state: "measured", value: "2026-10-07", basis: "transition", reasons: [] })
  assert.deepEqual(walk.task.finished_on, walk.finished_on)
  assert.deepEqual(walk.stackup.finished_on, walk.finished_on)
  assert.deepEqual(tasksRollup([walk]).jobs[0].finished_on, walk.finished_on)
  assert.deepEqual(stackupRollup([walk]).jobs[0].finished_on, walk.finished_on)
})

test("a finish day from the card's last update is an upper bound, said so in its reason", () => {
  const session = facts({ id: S(2), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0, { basis: "card_updated", transitions: [{ to: "processing", offset_ms: 0 }] })] })
  const { walk } = walkOf([session], J("a"))
  assert.deepEqual(walk.finished_on, { class: "declared", state: "partial", value: "2026-10-07", basis: "card_updated", reasons: ["finish_from_card_update"], bound: "upper" })
})

test("sessions that finished the task on different days (a reopened task) give the latest day, with the reason reopened", () => {
  const first = facts({ id: S(3), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0, { day: "2026-10-05" })] })
  const reopened = [{ to: "processing", offset_ms: 2 * 24 * 60 * MIN }, { to: "done", offset_ms: 2 * 24 * 60 * MIN + 30 * MIN }]
  const second = facts({ id: S(4), duration: 60 * MIN, intervals: [span("turn", 0, 0, 30 * MIN)], jobs: [bound(J("a"), 2 * 24 * 60 * MIN, { day: "2026-10-07", transitions: reopened, observed: { status: "done", offset_ms: 2 * 24 * 60 * MIN + 30 * MIN } })] })
  const { walk } = walkOf([first, second], J("a"))
  // The latest finish is exact as the task's final finish: the reason moves it neither way.
  assert.deepEqual(walk.finished_on, { class: "measured", state: "partial", value: "2026-10-07", basis: "transition", reasons: ["reopened"], bound: null, bound_reason: "bound_not_moved" })
})

// Finding B1: a card created in planning and edited by hand to done, reopened and done again, kept `updated` equal to `created`, so an old
// session published the day the card was created as an upper bound on a finish that came two days later.
test("a finish day the facts prove is earlier than the day the last work ended is no bound: partial, bound null, finish_before_last_work", () => {
  const leadEnd = 192_171_828
  const stale = bound(J("a"), 0, { day: "2026-09-29", basis: "card_updated", transitions: [], observed: { status: "done", offset_ms: 0 }, length: leadEnd })
  const session = facts({ id: S(40), duration: leadEnd, intervals: [span("turn", 0, 0, leadEnd)], jobs: [stale] })
  const { walk } = walkOf([session], J("a"))
  assert.equal(walk.window.end_ms, leadEnd)
  assert.deepEqual(walk.finished_on, { class: "declared", state: "partial", value: "2026-09-29", basis: "card_updated", reasons: ["finish_before_last_work", "finish_from_card_update"], bound: null, bound_reason: "bound_reasons_conflict" })
  assert.deepEqual(walk.task.finished_on, walk.finished_on)
  assert.deepEqual(walk.stackup.finished_on, walk.finished_on)
})

// The B1 shape after the binding fix: the card is done but no record gives when, so the facts carry no finish time. The lead time must
// not go blank: it runs from card creation to the end of the recorded work, a partial lower bound with its own reason.
test("a done task with no recorded finish time keeps its lead window: the recorded work, at least that, reason finish_time_not_known", () => {
  const leadEnd = 192_171_828
  const unknown = bound(J("a"), 0, { day: null, transitions: [], observed: { status: "done", offset_ms: null }, length: leadEnd })
  const session = facts({ id: S(47), duration: leadEnd, intervals: [span("turn", 0, 0, 10 * MIN), span("turn", 0, leadEnd - 10 * MIN, leadEnd)], jobs: [unknown] })
  const { walk, formulas } = walkOf([session], J("a"))
  assert.equal(formulas.lead_time_ms.state, "partial")
  assert.deepEqual(formulas.lead_time_ms.reasons, ["finish_time_not_known"])
  assert.equal(formulas.lead_time_ms.value, leadEnd)
  assert.equal(formulas.active_in_lead_ms.state, "measured")
  assert.deepEqual([walk.window.start_ms, walk.window.end_ms], [0, leadEnd])
  assert.equal(walk.stackup.lead_time_ms.bound, "lower")
  assert.equal(walk.task.lead_time_ms.bound, "lower")
  for (const key of ["working_ms", "idle_ms"]) assert.notEqual(walk.stackup[key].state, "unavailable", key)
  assert.equal(walk.stackup.idle_ms.bound, "lower")
  assert.ok(walk.gaps.length > 0)
  // The finish day names why it has none.
  assert.deepEqual(walk.finished_on, { class: "unavailable", state: "unavailable", basis: null, reasons: ["finish_time_not_known"] })
  // Work that began before the card was made still floors the lead time, and both reasons stay.
  const early = facts({ id: S(48), duration: leadEnd, intervals: [span("turn", 0, 0, leadEnd)], jobs: [{ ...unknown, session_offset_ms: -10 * MIN }] })
  const floored = walkOf([early], J("a"))
  assert.deepEqual(floored.formulas.lead_time_ms.reasons, ["card_dates_shorter_than_work", "finish_time_not_known"])
  assert.deepEqual([floored.walk.window.start_ms, floored.walk.window.end_ms], [-10 * MIN, leadEnd - 10 * MIN])
  // A done move whose time was lost is a clock that could not be read, not an unknown finish; and with no recorded work there is no window.
  const lost = facts({ id: S(49), duration: leadEnd, intervals: [span("turn", 0, 0, leadEnd)], jobs: [{ ...unknown, transitions: [{ to: "done", offset_ms: null }] }] })
  assert.deepEqual(walkOf([lost], J("a")).formulas.lead_time_ms.reasons, ["job_offsets_unavailable"])
  const idle = facts({ id: S(50), duration: leadEnd, intervals: [], jobs: [{ ...unknown, segments: [] }] })
  assert.deepEqual(walkOf([idle], J("a")).formulas.lead_time_ms.reasons, ["job_offsets_unavailable"])
})

test("the guard holds for a measured day too, and only where the facts prove the last work ended on a later day", () => {
  const day = 24 * 60 * MIN
  // A transition, then a full day and more of work: the session saw the card move to done that day, so the task finished then or later.
  const moved = bound(J("a"), 0, { day: "2026-10-05", transitions: [{ to: "done", offset_ms: 10 * MIN }], observed: { status: "done", offset_ms: 10 * MIN }, length: day + 11 * MIN })
  const late = facts({ id: S(41), duration: day + 11 * MIN, intervals: [span("turn", 0, 0, day + 11 * MIN)], jobs: [moved] })
  assert.deepEqual(walkOf([late], J("a")).walk.finished_on, { class: "measured", state: "partial", value: "2026-10-05", basis: "transition", reasons: ["finish_before_last_work"], bound: "lower" })
  // Less than a day of later work may still end on the same UTC day, so the facts prove nothing and the upper bound stands.
  const near = bound(J("a"), 0, { day: "2026-10-05", basis: "card_updated", transitions: [], observed: { status: "done", offset_ms: 10 * MIN }, length: day + 9 * MIN })
  const close = facts({ id: S(42), duration: day + 9 * MIN, intervals: [span("turn", 0, 0, day + 9 * MIN)], jobs: [near] })
  assert.deepEqual(walkOf([close], J("a")).walk.finished_on, { class: "declared", state: "partial", value: "2026-10-05", basis: "card_updated", reasons: ["finish_from_card_update"], bound: "upper" })
  // Every session's day narrows when the task was created. The last finish alone (14 hours before the work ended) proves nothing; an
  // earlier session's day pins the creation late enough that the same work ends on a later day.
  const hour = 60 * MIN
  const lastFinish = bound(J("a"), 35 * hour, { day: "2026-10-06", basis: "card_updated", transitions: [], observed: { status: "done", offset_ms: 36 * hour }, length: 15 * hour })
  const last = facts({ id: S(43), duration: 15 * hour, intervals: [span("turn", 0, 0, 15 * hour)], jobs: [lastFinish] })
  assert.deepEqual(walkOf([last], J("a")).walk.finished_on.reasons, ["finish_from_card_update"])
  const firstFinish = bound(J("a"), 0, { day: "2026-10-05", basis: "card_updated", transitions: [], observed: { status: "done", offset_ms: 1 * hour }, length: 2 * hour })
  const first = facts({ id: S(45), duration: 2 * hour, intervals: [span("turn", 0, 0, 2 * hour)], jobs: [firstFinish] })
  const both = walkOf([first, last], J("a")).walk.finished_on
  assert.equal(both.value, "2026-10-06")
  assert.deepEqual(both.reasons, ["finish_before_last_work", "finish_from_card_update"])
})

test("a finish day with no published offset for its source is left as it is", () => {
  const open = bound(J("a"), 0, { day: "2026-10-05", basis: "card_updated", transitions: [], observed: { status: "done", offset_ms: null } })
  const session = facts({ id: S(44), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [open] })
  assert.deepEqual(walkOf([session], J("a")).walk.finished_on.reasons, ["finish_from_card_update"])
  const untimed = bound(J("a"), 0, { day: "2026-10-05", transitions: [{ to: "done", offset_ms: null }], length: 2 * 24 * 60 * MIN })
  const moved = facts({ id: S(46), duration: 2 * 24 * 60 * MIN, intervals: [span("turn", 0, 0, 2 * 24 * 60 * MIN)], jobs: [untimed] })
  assert.deepEqual(walkOf([moved], J("a")).walk.finished_on.reasons, [])
})

test("a later card update does not displace the day of a recorded transition, and days that contradict each other prove nothing", () => {
  const moved = facts({ id: S(5), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0, { day: "2026-10-06" })] })
  const looked = facts({ id: S(6), duration: 10 * MIN, intervals: [span("turn", 0, 0, 10 * MIN)], jobs: [bound(J("a"), 24 * 60 * MIN, { day: "2026-10-08", basis: "card_updated", transitions: [], observed: { status: "done", offset_ms: 24 * 60 * MIN + 5 * MIN } })] })
  const { walk } = walkOf([moved, looked], J("a"))
  assert.equal(walk.finished_on.value, "2026-10-06")
  assert.equal(walk.finished_on.state, "measured")
})

test("a finish day is unavailable, with its reason, for an open task, older facts, a public desk and a job clock that could not be read", () => {
  const open = facts({ id: S(7), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0, { status: "processing", day: null, observed: { status: "processing", offset_ms: 10 * MIN } })] })
  assert.deepEqual(walkOf([open], J("a")).walk.finished_on, { class: "unavailable", state: "unavailable", basis: null, reasons: ["open_job"] })

  const old = facts({ id: S(8), duration: 60 * MIN, schema: "desk.factory.published/3", intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [older(J("a"), 0)] })
  assert.deepEqual(walkOf([old], J("a")).walk.finished_on.reasons, ["not_in_published_facts"])

  const hidden = { ...bound(J("a"), null, { day: null }), transitions: [{ to: "done", offset_ms: null }], observed: { status: "done", offset_ms: null } }
  const publicDesk = facts({ id: S(9), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [hidden], unavailable: [...CLAUDE_FLAGS, { field: "job_offsets", reason: "desk_public" }] })
  assert.deepEqual(walkOf([publicDesk], J("a")).walk.finished_on.reasons, ["job_offsets_withheld"])

  const unread = facts({ id: S(10), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [hidden] })
  assert.deepEqual(walkOf([unread], J("a")).walk.finished_on.reasons, ["job_offsets_unavailable"])
})

test("a task whose status was never recorded has no finish day", () => {
  const session = facts({ id: S(34), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [{ ...bound(J("a"), 0, { day: null }), transitions: [], observed: null }] })
  assert.deepEqual(walkOf([session], J("a")).walk.finished_on, { class: "unavailable", state: "unavailable", basis: null, reasons: ["status_unavailable"] })
})

test("a missing finish day names the job clock only when the clock was not read: a session that did not see the card end gives no reason of its own", () => {
  // An earlier /4 session saw the card still processing; the finishing session wrote /3 facts.
  const early = facts({ id: S(46), duration: 30 * MIN, intervals: [span("turn", 0, 0, 30 * MIN)], jobs: [bound(J("a"), 0, { length: 30 * MIN, status: "processing", day: null, transitions: [{ to: "processing", offset_ms: 0 }], observed: { status: "processing", offset_ms: 0 } })] })
  const late = facts({ id: S(47), schema: "desk.factory.published/3", duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [older(J("a"), 0)] })
  assert.deepEqual(walkOf([early, late], J("a")).walk.finished_on.reasons, ["not_in_published_facts"])
  // A /4 session with a timed done transition but no observation of the card: the clock was read, the day was not published.
  const unobserved = facts({ id: S(48), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [{ ...bound(J("b"), 0, { day: null }), observed: null }] })
  assert.deepEqual(walkOf([unobserved], J("b")).walk.finished_on.reasons, ["not_in_published_facts"])
})

test("a cancelled task has a finish day though it has no lead window", () => {
  const session = facts({ id: S(11), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0, { status: "cancelled", day: "2026-10-04" })] })
  const { walk } = walkOf([session], J("a"))
  assert.equal(walk.task.lead_time_ms.state, "unavailable")
  assert.equal(walk.finished_on.value, "2026-10-04")
  assert.deepEqual(walk.stackup.finished_on, walk.finished_on)
})

// --- list states and created ----------------------------------------------------------------------------------------------------

test("the operator prompts' list state is measured when every session records them, and never reads as an empty list when none does", () => {
  const recorded = facts({ id: S(12), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0)], humanTurns: [turn(10 * MIN), turn(20 * MIN)] })
  const { walk: whole } = walkOf([recorded], J("a"))
  assert.deepEqual(whole.human_turns_state, { class: "measured", state: "measured", value: 2, reasons: [] })

  const codex = facts({ id: S(13), host: "codex-cli", duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("b"), 0)], unavailable: [{ field: "human_turns", reason: "host_does_not_record" }, { field: "prs", reason: "host_records_partly" }] })
  assert.deepEqual(walkOf([codex], J("b")).walk.human_turns_state, { class: "unavailable", state: "unavailable", reasons: ["host_does_not_record"] })

  const old = facts({ id: S(14), schema: "desk.factory.published/1", duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [older(J("c"), 0)] })
  assert.deepEqual(walkOf([old], J("c")).walk.human_turns_state.reasons, ["not_in_published_facts"])

  // One session records the prompts and one cannot: there may be more prompts than these.
  const both = [facts({ id: S(15), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("d"), 0)], humanTurns: [turn(10 * MIN)] }), facts({ id: S(16), host: "codex-cli", duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("d"), 0)], unavailable: [{ field: "human_turns", reason: "host_does_not_record" }] })]
  assert.deepEqual(walkOf(both, J("d")).walk.human_turns_state, { class: "measured", state: "partial", value: 1, reasons: ["host_does_not_record"], bound: "lower" })

  // A list the host recorded only in part, and a binding the turns cannot be placed on.
  const partly = facts({ id: S(17), host: "copilot-cli", duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("e"), 0)], humanTurns: [turn(10 * MIN)], unavailable: [{ field: "human_turns", reason: "host_records_partly" }] })
  assert.deepEqual(walkOf([partly], J("e")).walk.human_turns_state.reasons, ["host_records_partly"])
  const whole2 = { ...bound(J("f"), 0) }
  delete whole2.segments
  delete whole2.agents
  const unsegmented = facts({ id: S(18), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [whole2], humanTurns: [turn(10 * MIN)] })
  assert.deepEqual(walkOf([unsegmented], J("f")).walk.human_turns_state.reasons, ["no_segments"])
})

test("the pull requests' list state takes the formulas' coverage of them: a lower bound where the host records them only in part", () => {
  const session = facts({ id: S(19), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0)], prs: [{ repo: "ourostack/desk", number: 1, agent: 0, at_ms: 5 * MIN, created: true }] })
  assert.deepEqual(walkOf([session], J("a")).walk.prs_state, { class: "measured", state: "partial", value: 1, reasons: ["host_records_partly"], bound: "lower" })
  const whole = facts({ id: S(20), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("b"), 0)], unavailable: [] })
  assert.deepEqual(walkOf([whole], J("b")).walk.prs_state, { class: "measured", state: "measured", value: 0, reasons: [] })
})

test("each pull request says whether a session of the task created it: true when any did, false when only mentioned, null in older facts", () => {
  const opener = facts({ id: S(21), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0)], prs: [{ repo: "ourostack/desk", number: 1, agent: 0, at_ms: 20 * MIN, created: true }, { repo: "ourostack/desk", number: 2, agent: 0, at_ms: 5 * MIN, created: false }] })
  // A later session mentions #1 earlier on its own clock than the creating call: the creating session's time still places it.
  const mention = facts({ id: S(22), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), -30 * MIN)], prs: [{ repo: "ourostack/desk", number: 1, agent: 0, at_ms: 10 * MIN, created: false }] })
  const old = facts({ id: S(23), schema: "desk.factory.published/3", duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [older(J("a"), 0)], prs: [{ repo: "ourostack/desk", number: 3, agent: 0 }] })
  const { additions } = walkOf([opener, mention, old], J("a"))
  const byNumber = Object.fromEntries(additions.prs.map((pr) => [pr.number, pr]))
  assert.equal(byNumber[1].created, true)
  assert.equal(byNumber[1].at_ms, 20 * MIN)
  assert.equal(byNumber[1].session, S(21))
  assert.equal(byNumber[2].created, false)
  assert.equal(byNumber[3].created, null)
  assert.equal(Object.hasOwn(byNumber[3], "at_ms"), false)
})

test("a pull request marked created never takes a mention's time: with no timed creating call it is published without a time", () => {
  // Session A creates #7 without a time; session B, placed two hours later, mentions it at 40 minutes on its own clock.
  const creator = facts({ id: S(44), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 0)], prs: [{ repo: "ourostack/desk", number: 7, agent: 0, created: true }] })
  const mention = facts({ id: S(45), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN)], jobs: [bound(J("a"), 120 * MIN)], prs: [{ repo: "ourostack/desk", number: 7, agent: 0, at_ms: 40 * MIN, created: false }] })
  const { additions } = walkOf([creator, mention], J("a"))
  assert.deepEqual(additions.prs, [{ host: "claude-code", session: S(44), repo: "ourostack/desk", number: 7, worker: 0, created: true }])
})

// --- waits ----------------------------------------------------------------------------------------------------------------------

test("each after-stop wait is listed on the job clock with its stop facts and the next-prompt time it holds; older facts say the stop was not recorded", () => {
  const fields = {
    id: S(24),
    duration: 100 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 40 * MIN, stopOf("end_turn", true)), span("turn", 0, 40 * MIN, 50 * MIN), wait(50 * MIN, 90 * MIN, stopOf("rate_limit")), span("turn", 0, 90 * MIN, 100 * MIN)],
    jobs: [bound(J("a"), 5 * MIN, { done: 105 * MIN, length: 100 * MIN })],
    humanTurns: [turn(40 * MIN, 30 * MIN), turn(90 * MIN, 40 * MIN)],
  }
  // The fixture is a file the public gate accepts.
  assert.deepEqual(validatePublished(rawFacts(fields)), { ok: true, errors: [] })
  const session = facts(fields)
  const { walk, additions } = walkOf([session], J("a"))
  assert.deepEqual(walk.waits, [
    { host: "claude-code", session: S(24), worker: 0, start_ms: 15 * MIN, end_ms: 45 * MIN, next_prompt_ms: 30 * MIN, stop: { end: "end_turn", asks: true, pending_agents: false }, why: "not_known", why_source: "none", confidence: null, reasons: ["not_labeled"] },
    { host: "claude-code", session: S(24), worker: 0, start_ms: 55 * MIN, end_ms: 95 * MIN, next_prompt_ms: 40 * MIN, stop: { end: "rate_limit", asks: false, pending_agents: false }, why: "error_limit", why_source: "rule", confidence: "high", reasons: [] },
  ])
  // A prompt joins the wait it ends: the same session, end_ms == at_ms.
  assert.equal(additions.human_turns.length, 2)
  for (const prompt of additions.human_turns) assert.ok(walk.waits.some((entry) => entry.session === prompt.session && entry.end_ms === prompt.at_ms))
  assert.equal(sum(walk.waits.map((entry) => entry.next_prompt_ms)), walk.task.waiting_by_waited_on_ms.next_prompt.value)

  const old = facts({ id: S(25), schema: "desk.factory.published/3", duration: 40 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN), span("turn", 0, 30 * MIN, 40 * MIN)], jobs: [older(J("b"), 0, 40 * MIN)] })
  assert.deepEqual(walkOf([old], J("b")).walk.waits, [{ host: "claude-code", session: S(25), worker: 0, start_ms: 10 * MIN, end_ms: 30 * MIN, next_prompt_ms: 20 * MIN, stop: null, why: "not_known", why_source: "none", confidence: null, reasons: ["not_in_published_facts"] }])
})

test("a wait's next-prompt time is only its idle part: another worker's work while it waits is not in it", () => {
  const session = facts({
    id: S(26),
    duration: 100 * MIN,
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 100 * MIN, stopOf("end_turn", false, true)), span("turn", 1, 20 * MIN, 30 * MIN)],
    jobs: [{ ...bound(J("a"), 0, { done: 100 * MIN, length: 100 * MIN }), agents: [0, 1] }],
  })
  const { walk } = walkOf([session], J("a"))
  // Idle 10 to 20 and 30 to 100: the subagent worked 20 to 30.
  assert.equal(walk.waits[0].next_prompt_ms, 80 * MIN)
  assert.equal(walk.task.waiting_by_waited_on_ms.next_prompt.value, 80 * MIN)
})

test("the next-prompt time no wait holds plus every wait's share is the task's next-prompt waiting, and overlapping waits count each moment once", () => {
  // Two sessions of the task wait on the operator at overlapping times; a labeled next-prompt wait in the first runs on past its human wait.
  const one = facts({ id: S(27), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("a"), 0, { done: 100 * MIN })] })
  const two = facts({ id: S(28), duration: 60 * MIN, intervals: [span("turn", 0, 0, 5 * MIN), wait(5 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("a"), 20 * MIN, { done: 100 * MIN })] })
  const labels = [labelsFile(J("a"), S(27), [stretch(10 * MIN, 40 * MIN, "muda", "waiting", [[10 * MIN, 30 * MIN]])])]
  const { walk } = walkOf([one, two], J("a"), labels)
  const total = walk.task.waiting_by_waited_on_ms.next_prompt.value
  // Session one waits 10 to 30, and its label keeps it waiting to 40, but session two works 20 to 25: idle is 10 to 20 and 25 to 40.
  // Session two waits 25 to 50 and session one works from 40: idle 25 to 40 is held by both waits, and given once, to the earlier.
  assert.deepEqual(walk.waits.map((entry) => [entry.session, entry.start_ms / MIN, entry.end_ms / MIN, entry.next_prompt_ms / MIN]), [[S(27), 10, 30, 15], [S(28), 25, 50, 10]])
  const unheld = walk.next_prompt_unheld_ms
  assert.equal(sum(walk.waits.map((entry) => entry.next_prompt_ms)) + unheld, total)
  assert.equal(unheld, 0, "the label's run past its own wait lies inside the other session's wait")
  assert.equal(total, 25 * MIN)
})

test("next-prompt time a labeled wait holds outside every human wait is the part no wait holds", () => {
  const session = facts({ id: S(29), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("a"), 0, { done: 60 * MIN })] })
  const labels = [labelsFile(J("a"), S(29), [stretch(10 * MIN, 45 * MIN, "muda", "waiting", [[10 * MIN, 30 * MIN]])])]
  const { walk } = walkOf([session], J("a"), labels)
  assert.equal(walk.waits[0].next_prompt_ms, 20 * MIN)
  assert.equal(walk.next_prompt_unheld_ms, 15 * MIN)
  assert.equal(walk.waits[0].next_prompt_ms + walk.next_prompt_unheld_ms, walk.task.waiting_by_waited_on_ms.next_prompt.value)
})

test("without a lead window a wait has no next-prompt time, and says why", () => {
  const session = facts({ id: S(30), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("a"), 0, { status: "cancelled" })] })
  const { walk } = walkOf([session], J("a"))
  assert.deepEqual(walk.waits, [{ host: "claude-code", session: S(30), worker: 0, start_ms: 10 * MIN, end_ms: 30 * MIN, next_prompt_ms: null, stop: { end: "end_turn", asks: false, pending_agents: false }, why: "not_known", why_source: "none", confidence: null, reasons: ["cancelled", "not_labeled"] }])
  assert.deepEqual(walk.waits_state, { state: "unavailable", reasons: ["cancelled"] })
})

test("when the task's next-prompt figure is unavailable, no wait publishes a number: each is null with the figure's reasons, and the list says so", () => {
  const session = facts({
    id: S(40),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)],
    jobs: [bound(J("a"), 0)],
    unavailable: [...CLAUDE_FLAGS, { field: "turns", reason: "source_unreadable" }, { field: "tool_durations", reason: "source_unreadable" }],
  })
  const { walk } = walkOf([session], J("a"))
  assert.equal(walk.task.waiting_by_waited_on_ms.next_prompt.state, "unavailable")
  assert.deepEqual(walk.waits.map((entry) => [entry.next_prompt_ms, entry.reasons]), [[null, ["not_labeled", "source_unreadable"]]])
  assert.deepEqual(walk.waits_state, { state: "unavailable", reasons: ["source_unreadable"] })
})

test("when the task's next-prompt figure is partial, the waits' list state says so with the figure's bound", () => {
  const truncated = facts({
    id: S(41),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)],
    jobs: [bound(J("a"), 0)],
    unavailable: [...CLAUDE_FLAGS, { field: "tool_durations", reason: "log_truncated" }],
  })
  const { walk } = walkOf([truncated], J("a"))
  const figure = walk.task.waiting_by_waited_on_ms.next_prompt
  assert.equal(figure.state, "partial")
  assert.deepEqual(walk.waits_state, { state: "partial", reasons: figure.reasons, bound: figure.bound })
  assert.equal(walk.waits[0].next_prompt_ms, 20 * MIN, "a partial figure still has its value, and each wait its share")
  assert.deepEqual(walk.waits[0].reasons, ["not_labeled"], "the list state carries the figure's reasons; a wait's own reasons hold only why its why is not known")

  const open = facts({ id: S(42), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("b"), 0, { status: "processing", day: null, observed: { status: "processing", offset_ms: 0 } })] })
  const { walk: still } = walkOf([open], J("b"))
  assert.deepEqual(still.waits_state, { state: "partial", reasons: ["censored"], bound: "lower" })

  const whole = facts({ id: S(43), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("c"), 0)] })
  assert.deepEqual(walkOf([whole], J("c")).walk.waits_state, { state: "measured", reasons: [] })
})

// --- the ask-tool idle rule -----------------------------------------------------------------------------------------------------

test("time inside a question or plan tool's wait is idle next-prompt time, not working time, except where another worker of the task works", () => {
  assert.deepEqual(ASK_ENDS, ["ask_question", "ask_plan"])
  const intervals = (end) => [span("turn", 0, 0, 60 * MIN), tool(0, 10 * MIN, 50 * MIN, end === "ask_plan" ? "plan" : "other"), wait(10 * MIN, 50 * MIN, stopOf(end)), span("turn", 1, 20 * MIN, 30 * MIN)]
  const agents = [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }]
  for (const end of ASK_ENDS) {
    const session = facts({ id: S(31), duration: 60 * MIN, agents, intervals: intervals(end), jobs: [{ ...bound(J("a"), 0), agents: [0, 1] }] })
    const { walk, formulas } = walkOf([session], J("a"))
    // Worked 0 to 10, 20 to 30 (the subagent) and 50 to 60; the operator was answering the rest.
    assert.equal(walk.task.working_ms.value, 30 * MIN, end)
    assert.equal(walk.task.waiting_by_waited_on_ms.next_prompt.value, 30 * MIN, end)
    assert.equal(walk.task.flow_efficiency.value, 0.5, end)
    assert.equal(walk.waits[0].next_prompt_ms, 30 * MIN, end)
    assert.deepEqual(walk.waits[0].stop, stopOf(end))
    // The formulas' recorded active time keeps its meaning.
    assert.equal(formulas.active_time_ms.value, 60 * MIN, end)
  }
  // An ordinary stop inside a turn changes nothing: only the ask tools' waits are idle by rule.
  const plain = facts({ id: S(32), duration: 60 * MIN, intervals: [span("turn", 0, 0, 60 * MIN), wait(10 * MIN, 50 * MIN, stopOf("end_turn"))], jobs: [bound(J("a"), 0)] })
  assert.equal(walkOf([plain], J("a")).walk.task.working_ms.value, 60 * MIN)
})

test("a subagent's ask wait is idle through its parent's turn around it, but not through the parent's own tool call", () => {
  const agents = [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }]
  const session = facts({
    id: S(35),
    duration: 60 * MIN,
    agents,
    // The parent's turn holds the whole wait, so it is the wait one level up; its tool call from 20 to 30 is its own work.
    intervals: [span("turn", 0, 0, 60 * MIN), span("subagent", 0, 0, 60 * MIN), span("turn", 1, 0, 60 * MIN), tool(1, 10 * MIN, 50 * MIN, "other"), wait(10 * MIN, 50 * MIN, stopOf("ask_question"), 1), tool(0, 20 * MIN, 30 * MIN)],
    jobs: [{ ...bound(J("a"), 0), agents: [0, 1] }],
  })
  const { walk } = walkOf([session], J("a"))
  assert.equal(walk.task.working_ms.value, 30 * MIN)
  // The subagent's recorded ask wait is listed with its worker, so it holds its own idle time and no time is left that no wait holds.
  assert.deepEqual(walk.waits.map((entry) => [entry.worker, entry.next_prompt_ms, entry.why]), [[1, 30 * MIN, "question"]])
  assert.equal(walk.next_prompt_unheld_ms, 0)
  assert.equal(walk.task.waiting_by_waited_on_ms.next_prompt.value, 30 * MIN)
})

test("an ask wait cut by the task's segments is idle only inside them", () => {
  const session = facts({
    id: S(33),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 60 * MIN), tool(0, 10 * MIN, 50 * MIN, "other"), wait(10 * MIN, 50 * MIN, stopOf("ask_question"))],
    jobs: [bound(J("a"), 0, { length: 30 * MIN, done: 30 * MIN })],
  })
  const { walk } = walkOf([session], J("a"))
  assert.equal(walk.task.working_ms.value, 10 * MIN)
  assert.deepEqual(walk.waits.map((entry) => [entry.start_ms / MIN, entry.end_ms / MIN, entry.next_prompt_ms / MIN]), [[10, 30, 20]])
})

// --- words and directions -------------------------------------------------------------------------------------------------------

test("every new reason has plain words and a decided direction", () => {
  for (const reason of ["finish_from_card_update", "reopened", "finish_before_last_work", "finish_time_not_known", "job_offsets_withheld", "not_in_published_facts", "no_segments"]) {
    assert.equal(typeof REASON_TEXT[reason], "string", reason)
    assert.ok(!/[_;()]/u.test(REASON_TEXT[reason]), reason)
  }
  for (const reason of ["finish_from_card_update", "reopened", "finish_before_last_work", "finish_time_not_known", "not_in_published_facts", "no_segments"]) assert.ok(Object.hasOwn(REASON_CHANGE, reason), reason)
})
