// Reports D5: why the agent stopped before each wait for the next prompt, by rule from the stop facts or from the evaluator's stop labels,
// and the task's next-prompt waiting split by why, on gaps, bursts, task and stack-up rows and the causes rollup.
import { test } from "node:test"
import assert from "node:assert/strict"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { REASON_TEXT } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/report.js"
import { computeRollups, jobRecord, resolveLabels } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"
import { timelineAdditions } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/stretches.js"
import { buildTimelines } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"
import { NOT_KNOWN_REASONS, REASON_CHANGE, WHY_CLASSES, WHY_SPLIT, bounded, causesRollup, figure, jobWalk, stackupRollup, tasksRollup } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/walk.js"

const J = (digit) => digit.repeat(32)
const S = (n) => `50000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const MIN = 60_000
const VERSION = "3.2.0-alpha.243"

const CLAUDE_FLAGS = [{ field: "prs", reason: "host_records_partly" }]

// A published session, normalized as the pipeline reads it; `/4` unless `schema` says otherwise.
function facts({ id, duration, schema = "desk.factory.published/4", agents = [{ n: 0, parent: null, model: "model-alpha" }], intervals, jobs, unavailable = CLAUDE_FLAGS }) {
  return normalizePublished({
    schema,
    session: { host: "claude-code", id, host_version: "2.1.0", entrypoint: "cli", duration_ms: duration, ended: true, end_reason: "complete" },
    plugins: [{ name: "desk", version: VERSION }],
    models: [{ id: "model-alpha", requests: 1, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: null } }],
    agents,
    intervals,
    counts: { tool_calls: {}, tool_failures: {}, tool_retries: 0, api_retries: 0, compactions: 0 },
    refs: { prs: [], commits: [], private: { prs: 0, commits: 0 } },
    jobs,
    unavailable,
  })
}

// A binding of the session to `job` from `offset`, worker 0 over `length`, done at `done` on the job clock.
function bound(job, offset, { done = 200 * MIN, length = 200 * MIN, status = "done", agents = [0], segments } = {}) {
  return {
    job,
    basis: ["desk_tool"],
    session_offset_ms: offset,
    agents,
    segments: segments ?? [{ start_ms: 0, end_ms: length }],
    transitions: [{ to: "processing", offset_ms: 0 }, { to: status, offset_ms: done }],
    observed: { status, offset_ms: done },
    finished_on: status === "done" ? "2026-10-07" : null,
    finished_basis: status === "done" ? "transition" : null,
  }
}

const span = (kind, agent, start, end) => ({ kind, agent, start_ms: start, end_ms: end })
const tool = (agent, start, end, toolKind = "shell") => ({ kind: "tool", agent, tool: toolKind, outcome: "ok", start_ms: start, end_ms: end })
const wait = (start, end, stop, agent = 0) => ({ ...span("human_wait", agent, start, end), ...(stop === undefined ? {} : { stop }) })
const stopOf = (end, asks = false, pending = false) => ({ end, asks, pending_agents: pending })

const stretch = (start, end, cls, waste, evidence) => ({ start_ms: start, end_ms: end, class: cls, waste, mura: false, muri: false, evidence, confidence: "high", evaluator_version: VERSION })
const stopLabel = (start, end, why, confidence = "high") => ({ wait: [start, end], why, confidence, evaluator_version: VERSION })
// Labels `/3` (rubric 4) with stops, or `/2` without when `stops` is undefined.
function labelsFile(job, session, stretches, stops) {
  return stops === undefined
    ? { schema: "desk.factory.labels/2", job, session, evaluator: { plugin_version: VERSION, model: "model-observer", rubric: "3" }, stretches, unavailable: [] }
    : { schema: "desk.factory.labels/3", job, session, evaluator: { plugin_version: VERSION, model: "model-observer", rubric: "4" }, stretches, stops, unavailable: [] }
}

function walksOf(sessions, labelFiles = []) {
  const labels = resolveLabels(labelFiles, sessions)
  return {
    labels,
    walks: buildTimelines(sessions).map((timeline) => {
      const formulas = calculateFormulas(timeline)
      const record = jobRecord({ timeline, formulas }, labels.byJobSession)
      const additions = timelineAdditions(timeline)
      return { timeline, record, walk: jobWalk({ timeline, formulas, additions }, labels, record.finished) }
    }),
  }
}
const walkOf = (sessions, job, labelFiles = []) => walksOf(sessions, labelFiles).walks.find((entry) => entry.timeline.job === job).walk

const sum = (values) => values.reduce((total, value) => total + value, 0)
const values = (split) => Object.fromEntries(Object.entries(split).map(([key, number]) => [key, number.value]))
const whyOf = (walk) => walk.waits.map((entry) => [entry.start_ms / MIN, entry.why, entry.why_source, entry.confidence, entry.reasons])

// One session of task a with a wait of every kind: an evaluator's stopped_short, each rule class, the evaluator's "could not tell" and
// one wait not labeled. Work runs 0-10, 30-40, 60-70, 90-130 (the ask tool's wait 100-120 is idle), 150-160 and 180-200.
const EVERY = Object.freeze({
  id: S(1),
  duration: 200 * MIN,
  intervals: [
    span("turn", 0, 0, 10 * MIN),
    wait(10 * MIN, 30 * MIN, stopOf("end_turn", true)),
    span("turn", 0, 30 * MIN, 40 * MIN),
    wait(40 * MIN, 60 * MIN, stopOf("max_tokens")),
    span("turn", 0, 60 * MIN, 70 * MIN),
    wait(70 * MIN, 90 * MIN, stopOf("interrupted")),
    span("turn", 0, 90 * MIN, 130 * MIN),
    tool(0, 100 * MIN, 120 * MIN, "other"),
    wait(100 * MIN, 120 * MIN, stopOf("ask_question")),
    wait(130 * MIN, 150 * MIN, stopOf("end_turn")),
    span("turn", 0, 150 * MIN, 160 * MIN),
    wait(160 * MIN, 180 * MIN, stopOf("end_turn")),
    span("turn", 0, 180 * MIN, 200 * MIN),
  ],
  jobs: [bound(J("a"), 0)],
})
const EVERY_LABELS = [labelsFile(J("a"), S(1), [stretch(0, 10 * MIN, "value", null, [[0, 10 * MIN]])], [stopLabel(10 * MIN, 30 * MIN, "stopped_short"), stopLabel(130 * MIN, 150 * MIN, "unknown", "low")])]

// --- each wait's why ---------------------------------------------------------------------------------------------------------

test("the classes, in the order the page stacks them, and the reasons a why is not known", () => {
  assert.deepEqual(WHY_CLASSES, ["stopped_short", "question", "error_limit", "interrupted", "decision", "approval", "acceptance"])
  assert.deepEqual(WHY_SPLIT, [...WHY_CLASSES, "not_known"])
  assert.deepEqual(NOT_KNOWN_REASONS, ["not_labeled", "could_not_tell", "stop_not_recorded", "outside_own_share", "not_in_published_facts"])
})

test("a mechanical stop is classified by rule at high confidence; every other wait takes the evaluator's stop label that matches it exactly, else is not known with its reason", () => {
  const walk = walkOf([facts(EVERY)], J("a"), EVERY_LABELS)
  assert.deepEqual(whyOf(walk), [
    [10, "stopped_short", "evaluator", "high", []],
    [40, "error_limit", "rule", "high", []],
    [70, "interrupted", "rule", "high", []],
    [100, "question", "rule", "high", []],
    [130, "not_known", "evaluator", "low", ["could_not_tell"]],
    [160, "not_known", "none", null, ["not_labeled"]],
  ])
  // Each wait keeps its stop facts and its worker, and the published keys are exactly these.
  assert.deepEqual(Object.keys(walk.waits[0]).sort(), ["confidence", "end_ms", "host", "next_prompt_ms", "reasons", "session", "start_ms", "stop", "why", "why_source", "worker"])
  assert.equal(walk.waits[0].worker, 0)
  assert.deepEqual(walk.waits[1].stop, stopOf("max_tokens"))
})

test("every rule end gives its class: a token cap, a rate limit, an API error and a refusal are error_limit; an interrupt, an open question and a plan are their own", () => {
  const rules = { max_tokens: "error_limit", rate_limit: "error_limit", api_error: "error_limit", refusal: "error_limit", interrupted: "interrupted", ask_question: "question", ask_plan: "approval" }
  for (const [end, why] of Object.entries(rules)) {
    const session = facts({ id: S(2), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf(end)), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("a"), 0, { done: 60 * MIN, length: 60 * MIN })] })
    // A label on a rule-decided wait never overrides the rule.
    const walk = walkOf([session], J("a"), [labelsFile(J("a"), S(2), [], [stopLabel(10 * MIN, 30 * MIN, "acceptance")])])
    assert.deepEqual(whyOf(walk), [[10, why, "rule", "high", []]], end)
  }
  // A stop the deriver could not read, or an ordinary end of turn, is the evaluator's to judge.
  const unread = facts({ id: S(3), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("not_recorded")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("a"), 0, { done: 60 * MIN, length: 60 * MIN })] })
  assert.deepEqual(whyOf(walkOf([unread], J("a"))), [[10, "not_known", "none", null, ["not_labeled"]]])
  assert.deepEqual(whyOf(walkOf([unread], J("a"), [labelsFile(J("a"), S(3), [], [stopLabel(10 * MIN, 30 * MIN, "decision", "medium")])])), [[10, "decision", "evaluator", "medium", []]])
})

test("labels made before the facts were derived again whose stops now conflict with the facts give no class: the wait reads not labeled until the relabel lands, and the stretches still count", () => {
  // Re-derived facts: the first wait now ends on an interrupt (a rule decides it) and the second's range moved.
  const session = facts({
    id: S(4),
    duration: 80 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("interrupted")), span("turn", 0, 30 * MIN, 40 * MIN), wait(40 * MIN, 60 * MIN, stopOf("end_turn")), span("turn", 0, 60 * MIN, 80 * MIN)],
    jobs: [bound(J("a"), 0, { done: 80 * MIN, length: 80 * MIN })],
  })
  const stale = labelsFile(J("a"), S(4), [stretch(0, 10 * MIN, "value", null, [[0, 10 * MIN]])], [stopLabel(10 * MIN, 30 * MIN, "acceptance"), stopLabel(40 * MIN, 55 * MIN, "stopped_short")])
  const { labels, walks } = walksOf([session], [stale])
  assert.equal(labels.byJobSession.has(`${J("a")}/${S(4)}`), true, "the stretches still match their facts, so the file is used")
  assert.deepEqual(labels.unused, [])
  assert.deepEqual(labels.byJobSession.get(`${J("a")}/${S(4)}`).stops, [], "only the stops that conflict are left out")
  // The dropped stops are counted by the check's code, beside the unused files, so the relabel backlog shows.
  assert.deepEqual(labels.stops_dropped, [{ reason: "evidence_unmatched", stops: 1 }, { reason: "inconsistent", stops: 1 }])
  const coverage = computeRollups({ records: walks.map(({ record }) => record), sessions: [session], labels }).coverage
  assert.deepEqual(coverage.labels.stops_dropped, labels.stops_dropped)
  const walk = walks[0].walk
  assert.deepEqual(whyOf(walk), [[10, "interrupted", "rule", "high", []], [40, "not_known", "none", null, ["not_labeled"]]])
  assert.equal(walk.task.value_in_working_ms.value, 10 * MIN)
  assert.equal(walk.task.value_in_working_ms.state, "measured")
  // A stretch that no longer matches its facts still leaves the whole file unused, as before.
  const broken = labelsFile(J("a"), S(4), [stretch(0, 10 * MIN, "value", null, [[0, 9 * MIN]])], [stopLabel(40 * MIN, 60 * MIN, "acceptance")])
  const again = walksOf([session], [broken])
  assert.deepEqual(again.labels.unused, [{ reason: "evidence_unmatched", files: 1 }])
  assert.deepEqual(again.labels.stops_dropped, [], "a file left unused drops no stop on its own")
  assert.deepEqual(whyOf(again.walks[0].walk)[1], [40, "not_known", "none", null, ["not_labeled"]])
})

test("a wait the task's segments cut takes the label of the whole wait it is part of", () => {
  const session = facts({
    id: S(5),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 50 * MIN, stopOf("end_turn")), span("turn", 0, 50 * MIN, 60 * MIN)],
    jobs: [bound(J("a"), 0, { done: 30 * MIN, length: 30 * MIN })],
  })
  const walk = walkOf([session], J("a"), [labelsFile(J("a"), S(5), [], [stopLabel(10 * MIN, 50 * MIN, "acceptance")])])
  assert.deepEqual(walk.waits.map((entry) => [entry.start_ms / MIN, entry.end_ms / MIN, entry.why, entry.why_source]), [[10, 30, "acceptance", "evaluator"]])
})

test("older facts carry no stop: their waits are not known (not in the published facts) unless the evaluator classified them", () => {
  const session = facts({
    id: S(6),
    schema: "desk.factory.published/3",
    duration: 80 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN), span("turn", 0, 30 * MIN, 40 * MIN), wait(40 * MIN, 60 * MIN), span("turn", 0, 60 * MIN, 80 * MIN)],
    jobs: [{ job: J("a"), basis: ["desk_tool"], session_offset_ms: 0, agents: [0], segments: [{ start_ms: 0, end_ms: 80 * MIN }], transitions: [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: 80 * MIN }], observed: { status: "done", offset_ms: 80 * MIN } }],
  })
  assert.deepEqual(whyOf(walkOf([session], J("a"), [labelsFile(J("a"), S(6), [], [stopLabel(10 * MIN, 30 * MIN, "acceptance")])])), [
    [10, "acceptance", "evaluator", "high", []],
    [40, "not_known", "none", null, ["not_in_published_facts"]],
  ])
})

test("a wait in a session whose share of the task the facts do not record is not known (outside its own share): the evaluator never judges it for the task", () => {
  const unsegmented = (job) => {
    const { segments, ...binding } = bound(job, 0, { done: 60 * MIN, length: 60 * MIN })
    return binding
  }
  const session = facts({ id: S(7), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), wait(30 * MIN, 40 * MIN, stopOf("rate_limit")), span("turn", 0, 40 * MIN, 60 * MIN)], jobs: [unsegmented(J("a")), unsegmented(J("b"))] })
  const walk = walkOf([session], J("a"), [labelsFile(J("a"), S(7), [], [stopLabel(10 * MIN, 30 * MIN, "acceptance")])])
  assert.deepEqual(whyOf(walk), [[10, "not_known", "none", null, ["outside_own_share"]], [30, "error_limit", "rule", "high", []]])
})

test("a subagent's recorded ask wait is listed with its worker and classified by rule, never counted as a stop not recorded", () => {
  const agents = [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }]
  const session = facts({
    id: S(8),
    duration: 60 * MIN,
    agents,
    intervals: [span("turn", 0, 0, 60 * MIN), span("subagent", 0, 0, 60 * MIN), span("turn", 1, 0, 60 * MIN), tool(1, 10 * MIN, 50 * MIN, "other"), wait(10 * MIN, 50 * MIN, stopOf("ask_question"), 1), tool(0, 20 * MIN, 30 * MIN)],
    jobs: [{ ...bound(J("a"), 0, { done: 60 * MIN, length: 60 * MIN }), agents: [0, 1] }],
  })
  const walk = walkOf([session], J("a"))
  assert.deepEqual(walk.waits.map((entry) => [entry.worker, entry.start_ms / MIN, entry.end_ms / MIN, entry.next_prompt_ms / MIN, entry.why, entry.why_source]), [[1, 10, 50, 30, "question", "rule"]])
  assert.equal(walk.task.not_known_by_reason_ms.stop_not_recorded.value, 0)
  assert.equal(walk.task.next_prompt_by_why_ms.question.value, 30 * MIN)
  assert.equal(walk.task.next_prompt_by_why_ms.question.state, "measured")
})

// --- the split ---------------------------------------------------------------------------------------------------------------

test("the task's next-prompt waiting splits by why and adds up: the classes plus every not-known reason are the task figure, and the not-known part is visible", () => {
  const walk = walkOf([facts(EVERY)], J("a"), EVERY_LABELS)
  const total = walk.task.waiting_by_waited_on_ms.next_prompt
  assert.equal(total.state, "measured")
  assert.equal(total.value, 120 * MIN)
  assert.deepEqual(values(walk.task.next_prompt_by_why_ms), { stopped_short: 20 * MIN, question: 20 * MIN, error_limit: 20 * MIN, interrupted: 20 * MIN, decision: 0, approval: 0, acceptance: 0, not_known: 40 * MIN })
  assert.deepEqual(values(walk.task.not_known_by_reason_ms), { not_labeled: 20 * MIN, could_not_tell: 20 * MIN, stop_not_recorded: 0, outside_own_share: 0, not_in_published_facts: 0 })
  // The acceptance check: every value of the split, not known included, sums to the task figure.
  assert.equal(sum(Object.values(walk.task.next_prompt_by_why_ms).map((number) => number.value)), total.value)
  assert.equal(sum(WHY_CLASSES.map((why) => walk.task.next_prompt_by_why_ms[why].value)) + sum(Object.values(walk.task.not_known_by_reason_ms).map((number) => number.value)), total.value)
  assert.equal(sum(walk.waits.map((entry) => entry.next_prompt_ms)), total.value)
  // With some waiting not classified, each class is at least its figure; not known is exact.
  assert.deepEqual(walk.task.next_prompt_by_why_ms.stopped_short, { class: "inferred", state: "partial", value: 20 * MIN, reasons: ["stop_partly_classified"], bound: "lower" })
  assert.deepEqual(walk.task.next_prompt_by_why_ms.decision, { class: "inferred", state: "partial", value: 0, reasons: ["stop_partly_classified"], bound: "lower" })
  assert.deepEqual(walk.task.next_prompt_by_why_ms.not_known, { class: "inferred", state: "measured", value: 40 * MIN, reasons: [] })
  assert.deepEqual(walk.task.not_known_by_reason_ms.not_labeled, { class: "inferred", state: "measured", value: 20 * MIN, reasons: [] })
  // The stack-up row carries the same split.
  assert.deepEqual(walk.stackup.next_prompt_by_why_ms, walk.task.next_prompt_by_why_ms)
  assert.deepEqual(stackupRollup([walk]).jobs[0].next_prompt_by_why_ms, walk.task.next_prompt_by_why_ms)
  assert.deepEqual(tasksRollup([walk]).jobs[0].not_known_by_reason_ms, walk.task.not_known_by_reason_ms)
})

test("with every wait classified, each class is measured", () => {
  const session = facts({ id: S(9), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 40 * MIN), wait(40 * MIN, 50 * MIN, stopOf("refusal")), span("turn", 0, 50 * MIN, 60 * MIN)], jobs: [bound(J("a"), 0, { done: 60 * MIN, length: 60 * MIN })] })
  const walk = walkOf([session], J("a"), [labelsFile(J("a"), S(9), [], [stopLabel(10 * MIN, 30 * MIN, "acceptance")])])
  for (const why of WHY_SPLIT) assert.equal(walk.task.next_prompt_by_why_ms[why].state, "measured", why)
  assert.deepEqual(values(walk.task.next_prompt_by_why_ms), { stopped_short: 0, question: 0, error_limit: 10 * MIN, interrupted: 0, decision: 0, approval: 0, acceptance: 20 * MIN, not_known: 0 })
})

test("next-prompt time no wait holds is published as not known, the stop not recorded", () => {
  // A labeled wait that runs 15 minutes past its human wait: no recorded wait holds those minutes.
  const session = facts({ id: S(10), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("rate_limit")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("a"), 0, { done: 60 * MIN, length: 60 * MIN })] })
  const walk = walkOf([session], J("a"), [labelsFile(J("a"), S(10), [stretch(10 * MIN, 45 * MIN, "muda", "waiting", [[10 * MIN, 30 * MIN]])])])
  assert.equal(walk.waits[0].next_prompt_ms, 20 * MIN)
  assert.equal(walk.task.not_known_by_reason_ms.stop_not_recorded.value, 15 * MIN)
  assert.equal(walk.task.next_prompt_by_why_ms.not_known.value, 15 * MIN)
  assert.equal(walk.task.next_prompt_by_why_ms.error_limit.value + walk.task.next_prompt_by_why_ms.not_known.value, walk.task.waiting_by_waited_on_ms.next_prompt.value)
  assert.equal(walk.task.next_prompt_by_why_ms.error_limit.bound, "lower")
})

test("a partial task figure makes every part of the split partial with the same reasons and bound, and the classes add that some are not classified", () => {
  const intervals = [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 40 * MIN), wait(40 * MIN, 50 * MIN, stopOf("api_error")), span("turn", 0, 50 * MIN, 60 * MIN)]
  const open = facts({ id: S(11), duration: 60 * MIN, intervals, jobs: [bound(J("a"), 0, { status: "processing", done: 0, length: 60 * MIN })] })
  const walk = walkOf([open], J("a"))
  const total = walk.task.waiting_by_waited_on_ms.next_prompt
  assert.deepEqual([total.state, total.reasons, total.bound], ["partial", ["censored"], "lower"])
  assert.deepEqual(walk.task.next_prompt_by_why_ms.error_limit, { class: "inferred", state: "partial", value: 10 * MIN, reasons: ["censored", "stop_partly_classified"], bound: "lower" })
  assert.deepEqual(walk.task.next_prompt_by_why_ms.not_known, { class: "inferred", state: "partial", value: 20 * MIN, reasons: ["censored"], bound: "lower" })
  assert.deepEqual(walk.task.not_known_by_reason_ms.not_labeled, { class: "inferred", state: "partial", value: 20 * MIN, reasons: ["censored"], bound: "lower" })
  assert.equal(sum(Object.values(walk.task.next_prompt_by_why_ms).map((number) => number.value)), total.value)

  const truncated = facts({ id: S(12), duration: 60 * MIN, intervals, jobs: [bound(J("b"), 0, { done: 60 * MIN, length: 60 * MIN })], unavailable: [...CLAUDE_FLAGS, { field: "tool_durations", reason: "log_truncated" }] })
  const cut = walkOf([truncated], J("b"))
  const figureOf = cut.task.waiting_by_waited_on_ms.next_prompt
  for (const why of NOT_KNOWN_REASONS) assert.deepEqual([cut.task.not_known_by_reason_ms[why].state, cut.task.not_known_by_reason_ms[why].reasons, cut.task.not_known_by_reason_ms[why].bound], [figureOf.state, figureOf.reasons, figureOf.bound], why)
})

test("an unavailable task figure leaves every part of the split unavailable with its reasons: no plain number the figure does not support", () => {
  const session = facts({
    id: S(13),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("interrupted")), span("turn", 0, 30 * MIN, 60 * MIN)],
    jobs: [bound(J("a"), 0, { done: 60 * MIN, length: 60 * MIN })],
    unavailable: [...CLAUDE_FLAGS, { field: "turns", reason: "source_unreadable" }, { field: "tool_durations", reason: "source_unreadable" }],
  })
  const walk = walkOf([session], J("a"))
  const none = { class: "unavailable", state: "unavailable", reasons: ["source_unreadable"] }
  for (const why of WHY_SPLIT) assert.deepEqual(walk.task.next_prompt_by_why_ms[why], none, why)
  for (const reason of NOT_KNOWN_REASONS) assert.deepEqual(walk.task.not_known_by_reason_ms[reason], none, reason)
  for (const why of WHY_SPLIT) assert.deepEqual(walk.stackup.next_prompt_by_why_ms[why], none, why)
  // The wait is still classified: why it stopped does not need its time.
  assert.deepEqual(walk.waits.map((entry) => [entry.next_prompt_ms, entry.why, entry.reasons]), [[null, "interrupted", ["source_unreadable"]]])

  // Without a lead window (a cancelled task), the same.
  const cancelled = facts({ id: S(14), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("end_turn")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("b"), 0, { status: "cancelled", done: 60 * MIN, length: 60 * MIN })] })
  const gone = walkOf([cancelled], J("b"))
  for (const why of WHY_SPLIT) assert.deepEqual(gone.task.next_prompt_by_why_ms[why], { class: "unavailable", state: "unavailable", reasons: ["cancelled"] }, why)
  for (const reason of NOT_KNOWN_REASONS) assert.equal(gone.task.not_known_by_reason_ms[reason].state, "unavailable", reason)
  for (const why of WHY_SPLIT) assert.equal(gone.stackup.next_prompt_by_why_ms[why].state, "unavailable", why)
  assert.deepEqual(whyOf(gone), [[10, "not_known", "none", null, ["cancelled", "not_labeled"]]])
})

test("each gap and burst splits its next-prompt idle time by why, stated as its own next-prompt figure is, and the gaps and bursts add up to the task's split", () => {
  // The 10-minute wait 160-170 is too short to end a burst, so it sits inside one.
  const session = facts({
    id: S(15),
    duration: 200 * MIN,
    intervals: [...EVERY.intervals.filter((interval) => interval.start_ms < 150 * MIN), span("turn", 0, 150 * MIN, 160 * MIN), wait(160 * MIN, 170 * MIN, stopOf("refusal")), span("turn", 0, 170 * MIN, 200 * MIN)],
    jobs: [bound(J("a"), 0)],
  })
  const walk = walkOf([session], J("a"), [{ ...EVERY_LABELS[0], session: S(15) }])
  for (const part of [...walk.gaps, ...walk.bursts]) {
    const split = part.idle_by_why_ms
    assert.deepEqual(Object.keys(split), WHY_SPLIT)
    assert.equal(sum(Object.values(split).map((number) => number.value)), part.idle_by_waited_on_ms.next_prompt.value, `${part.start_ms / MIN}`)
  }
  for (const why of WHY_SPLIT) {
    const parts = sum([...walk.gaps, ...walk.bursts].map((part) => part.idle_by_why_ms[why].value))
    assert.equal(parts, walk.task.next_prompt_by_why_ms[why].value, why)
  }
  const inside = walk.bursts.find((burst) => burst.start_ms === 150 * MIN)
  assert.equal(inside.idle_by_why_ms.error_limit.value, 10 * MIN)
  assert.equal(walk.gaps.find((gap) => gap.start_ms === 10 * MIN).idle_by_why_ms.stopped_short.value, 20 * MIN)
  // A gap with unclassified next-prompt time is partial in its classes, like the task.
  assert.deepEqual(walk.gaps.find((gap) => gap.start_ms === 130 * MIN).idle_by_why_ms.question, { class: "inferred", state: "partial", value: 0, reasons: ["stop_partly_classified"], bound: "lower" })
  assert.deepEqual(walk.gaps.find((gap) => gap.start_ms === 10 * MIN).idle_by_why_ms.question, { class: "inferred", state: "measured", value: 0, reasons: [] })
})

test("the longest gap says why the agent stopped when it waited on the next prompt, and nothing when it waited on something else", () => {
  const walk = walkOf([facts(EVERY)], J("a"), EVERY_LABELS)
  // Every gap is 20 minutes; the earliest wins the tie.
  assert.deepEqual(walk.task.longest_gap.value, { start_ms: 10 * MIN, end_ms: 30 * MIN, duration_ms: 20 * MIN, waited_on: "next_prompt", why: "stopped_short" })
  // A gap whose time the label holds past every human wait reads not known.
  const late = facts({ id: S(16), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 15 * MIN, stopOf("interrupted")), span("turn", 0, 50 * MIN, 60 * MIN)], jobs: [bound(J("b"), 0, { done: 60 * MIN, length: 60 * MIN })] })
  const held = walkOf([late], J("b"), [labelsFile(J("b"), S(16), [stretch(10 * MIN, 50 * MIN, "muda", "waiting", [[10 * MIN, 15 * MIN]])])])
  assert.equal(held.task.longest_gap.value.why, "not_known")
  // A gap no next-prompt time holds has no why.
  const quiet = facts({ id: S(17), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), span("turn", 0, 50 * MIN, 60 * MIN)], jobs: [bound(J("c"), 0, { done: 60 * MIN, length: 60 * MIN })] })
  const unknown = walkOf([quiet], J("c")).task.longest_gap.value
  assert.equal(unknown.waited_on, "unknown")
  assert.equal(unknown.why, null)
})

test("stops never enter class or waste totals: the same stretches with and without stop labels give the same working figures", () => {
  const stretches = [stretch(0, 10 * MIN, "value", null, [[0, 10 * MIN]]), stretch(30 * MIN, 40 * MIN, "muda", "defects", [[30 * MIN, 40 * MIN]])]
  const plain = walkOf([facts(EVERY)], J("a"), [labelsFile(J("a"), S(1), stretches)])
  const stopped = walkOf([facts(EVERY)], J("a"), [labelsFile(J("a"), S(1), stretches, EVERY_LABELS[0].stops)])
  assert.deepEqual(stopped.stackup.working, plain.stackup.working)
  assert.deepEqual(stopped.task.working_ms, plain.task.working_ms)
  assert.deepEqual(stopped.task.value_in_working_ms, plain.task.value_in_working_ms)
  assert.deepEqual(stopped.task.waiting_by_waited_on_ms, plain.task.waiting_by_waited_on_ms)
  assert.notDeepEqual(stopped.task.next_prompt_by_why_ms, plain.task.next_prompt_by_why_ms)
})

// --- the causes rollup -------------------------------------------------------------------------------------------------------

test("the causes rollup splits waiting for the next prompt into sub-cause rows by why that add up to it, and leaves the ranking and its total unchanged", () => {
  const sessions = [facts(EVERY)]
  const { labels, walks } = walksOf(sessions, EVERY_LABELS)
  const causes = causesRollup({ records: walks.map(({ record }) => record), walks: walks.map(({ walk }) => walk), labels })
  const parent = causes.causes.find((row) => row.cause === "waiting:next_prompt")
  assert.equal(parent.total_ms, 120 * MIN)
  assert.ok(causes.causes.every((row) => row.parent === undefined), "the sub-causes are not ranked beside their parent")
  assert.equal(causes.total_ms, sum(causes.causes.map((row) => row.total_ms)))
  assert.deepEqual(parent.children.map((row) => [row.cause, row.parent, row.total_ms / MIN, row.jobs]), [
    ["waiting:next_prompt:stopped_short", "waiting:next_prompt", 20, [J("a")]],
    ["waiting:next_prompt:question", "waiting:next_prompt", 20, [J("a")]],
    ["waiting:next_prompt:error_limit", "waiting:next_prompt", 20, [J("a")]],
    ["waiting:next_prompt:interrupted", "waiting:next_prompt", 20, [J("a")]],
    ["waiting:next_prompt:not_known", "waiting:next_prompt", 40, [J("a")]],
  ])
  assert.equal(sum(parent.children.map((row) => row.total_ms)), parent.total_ms)
  const child = parent.children[0]
  assert.equal(child.waste, "waiting")
  assert.equal(child.hours, 20 / 60)
  assert.equal(child.share, child.total_ms / causes.total_ms)
  assert.deepEqual(child.spans, [{ job: J("a"), start_ms: 10 * MIN, end_ms: 30 * MIN }])
  assert.deepEqual(parent.children.at(-1).reasons, ["could_not_tell", "not_labeled"])
  // While some of it is not known, each class's job-hours are at least its figure, and say so.
  for (const row of parent.children.slice(0, -1)) assert.deepEqual([row.reasons, row.bound], [["stop_partly_classified"], "lower"], row.cause)
  assert.equal(Object.hasOwn(parent.children.at(-1), "bound"), false)
  // With every wait classified, the classes are exact.
  const whole = facts({ id: S(18), duration: 60 * MIN, intervals: [span("turn", 0, 0, 10 * MIN), wait(10 * MIN, 30 * MIN, stopOf("rate_limit")), span("turn", 0, 30 * MIN, 60 * MIN)], jobs: [bound(J("b"), 0, { done: 60 * MIN, length: 60 * MIN })] })
  const exact = walksOf([whole], [labelsFile(J("b"), S(18), [stretch(0, 10 * MIN, "value", null, [[0, 10 * MIN]])], [])])
  const exactCauses = causesRollup({ records: exact.walks.map(({ record }) => record), walks: exact.walks.map(({ walk }) => walk), labels: exact.labels })
  const [only] = exactCauses.causes.find((row) => row.cause === "waiting:next_prompt").children
  assert.deepEqual([only.cause, only.reasons, Object.hasOwn(only, "bound")], ["waiting:next_prompt:error_limit", [], false])
  // Other causes have no children.
  assert.ok(causes.causes.filter((row) => row.cause !== "waiting:next_prompt").every((row) => !Object.hasOwn(row, "children")))
})

// --- words and directions ----------------------------------------------------------------------------------------------------

test("every new reason has plain words, and a class is at least its figure while some waiting is not classified", () => {
  assert.equal(REASON_TEXT.stop_not_recorded, "no recorded wait for the operator covers this time, so there is no record of why the agent stopped, and some hosts do not record stops")
  assert.equal(REASON_TEXT.stop_partly_classified, "why the agent stopped is not known for some of this waiting, and some of that may belong here, so this is at least this much")
  for (const reason of ["could_not_tell", "stop_not_recorded", "outside_own_share", "stop_partly_classified", "not_labeled", "not_in_published_facts"]) {
    assert.equal(typeof REASON_TEXT[reason], "string", reason)
    assert.ok(!/[_;()]/u.test(REASON_TEXT[reason]), reason)
  }
  assert.ok(Object.hasOwn(REASON_CHANGE, "stop_partly_classified"))
  assert.equal(bounded(figure("partial", 5, ["stop_partly_classified"]), "why").bound, "lower")
  assert.equal(bounded(figure("partial", 5, ["stop_partly_classified", "log_truncated"]), "why").bound, "lower")
})
