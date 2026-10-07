import { test } from "node:test"
import assert from "node:assert/strict"

import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { normalizePublished, stableStringify } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { computeRollups, jobRecord, resolveLabels } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"
import { AGENTS_WORKING, LONG_TOOL_CALL_MS, UNLABELED_CLASS, WAITED_ON, causeKey, compareFields, correctStretches, evidenceIntervals, sessionDetail, timelineAdditions, waitedOn } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/stretches.js"
import { buildTimelines } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"
import { BURST_IDLE_GAP_MS, GAP_WAITED_ON, causesRollup, figure, jobWalk, stackupRollup } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/walk.js"
import { DETAIL_FILE_BUDGET_BYTES } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"

const J = (digit) => digit.repeat(32)
const S = (n) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const MIN = 60_000

// A published session, already in the normalized shape the pipeline reads.
function facts({ id, duration, agents = [{ n: 0, parent: null, model: "model-alpha" }], intervals, jobs, prs = [], humanTurns, unavailable = [] }) {
  return normalizePublished({
    schema: "desk.factory.published/2",
    session: { host: "claude-code", id, host_version: "2.1.0", entrypoint: "cli", duration_ms: duration, ended: true, end_reason: "complete" },
    plugins: [{ name: "desk", version: "3.2.0-alpha.230" }],
    models: [{ id: "model-alpha", requests: 1, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 0, reasoning: null } }],
    agents,
    intervals,
    counts: { tool_calls: {}, tool_failures: {}, tool_retries: 0, api_retries: 0, compactions: 0 },
    refs: { prs, commits: [], private: { prs: 0, commits: 0 } },
    jobs,
    ...(humanTurns === undefined ? {} : { human_turns: humanTurns }),
    unavailable,
  })
}

const binding = (job, offset, extra = {}) => ({ job, basis: ["desk_tool"], session_offset_ms: offset, transitions: [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: extra.done ?? 0 }], observed: null, ...extra.fields })

const stretch = (start, end, cls, waste, evidence, extra = {}) => ({ start_ms: start, end_ms: end, class: cls, waste, mura: false, muri: false, evidence, confidence: "high", evaluator_version: "3.2.0-alpha.230", ...extra })

const labelsFile = (job, session, stretches) => ({ schema: "desk.factory.labels/2", job, session, evaluator: { plugin_version: "3.2.0-alpha.230", model: "model-observer", rubric: "2" }, stretches, unavailable: [] })

const tool = (agent, start, end, toolKind = "shell", outcome = "ok") => ({ kind: "tool", agent, tool: toolKind, outcome, start_ms: start, end_ms: end })
const span = (kind, agent, start, end) => ({ kind, agent, start_ms: start, end_ms: end })

function walkOf(sessions, labelFiles, job) {
  const labels = resolveLabels(labelFiles, sessions)
  const timeline = buildTimelines(sessions).find((candidate) => candidate.job === job)
  const formulas = calculateFormulas(timeline)
  const record = jobRecord({ timeline, formulas }, labels.byJobSession)
  const additions = timelineAdditions(timeline)
  return { labels, timeline, formulas, record, additions, walk: jobWalk({ timeline, formulas, additions }, labels, record.finished) }
}

const sumOf = (row) => [row.queue_before_start_ms, row.not_labeled_ms, row.no_session_ms, row.agents_working_unlabeled_ms, ...Object.values(row.class_ms), ...Object.values(row.waste_ms)]
  .reduce((total, entry) => total + (entry.value ?? 0), 0)

test("waited_on names each cause from its evidence, the most time wins, a tie goes to the listed order and no cause is unknown", () => {
  assert.deepEqual(WAITED_ON, ["next_prompt", "api_retry", "tool_failure", "long_tool_call", "unknown"])
  assert.equal(waitedOn([span("human_wait", 0, 0, 10)]), "next_prompt")
  assert.equal(waitedOn([span("api_retry", 0, 0, 10)]), "api_retry")
  assert.equal(waitedOn([tool(0, 0, 10, "shell", "error")]), "tool_failure")
  assert.equal(waitedOn([tool(0, 0, 10, "shell", "timeout")]), "tool_failure")
  assert.equal(waitedOn([tool(0, 0, LONG_TOOL_CALL_MS)]), "long_tool_call", "five minutes exactly is a long call")
  assert.equal(waitedOn([tool(0, 0, LONG_TOOL_CALL_MS - 1)]), "unknown", "a shorter successful call names no cause")
  assert.equal(waitedOn([span("turn", 0, 0, 10)]), "unknown")
  // Mixed: the cause covering the most evidence time wins.
  assert.equal(waitedOn([span("human_wait", 0, 0, 10), span("api_retry", 0, 20, 50)]), "api_retry")
  assert.equal(waitedOn([span("human_wait", 0, 0, 10), span("api_retry", 0, 20, 25), span("api_retry", 0, 30, 35)]), "next_prompt", "a tie goes to the first listed")
  assert.equal(waitedOn([tool(0, 0, 10, "shell", "error"), span("api_retry", 0, 20, 30)]), "api_retry", "a tie goes to the first listed")
  assert.equal(waitedOn([]), "unknown")
})

test("a cause key names waiting by waited_on, defects by the failed tool kind they rest on most, and every other waste as all", () => {
  assert.equal(causeKey({ waste: "waiting", waited_on: "api_retry" }, []), "waiting:api_retry")
  assert.equal(causeKey({ waste: "defects" }, [tool(0, 0, 10, "shell", "error"), tool(0, 10, 30, "desk", "error"), tool(0, 30, 100, "edit", "ok")]), "defects:desk")
  assert.equal(causeKey({ waste: "defects" }, [tool(0, 0, 10, "shell", "error"), tool(0, 10, 20, "desk", "error")]), "defects:desk", "a tie goes to the tool name first in order")
  assert.equal(causeKey({ waste: "defects" }, [span("turn", 0, 0, 10)]), "defects:all")
  assert.equal(causeKey({ waste: "extra_processing" }, []), "extra_processing:all")
})

test("the overlap split moves the waiting time a worker of the job was working into an unlabeled agents_working part", () => {
  const session = facts({
    id: S(1),
    duration: 100 * MIN,
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }, { n: 2, parent: 0, model: "model-alpha" }],
    intervals: [span("turn", 0, 0, 10 * MIN), span("human_wait", 0, 10 * MIN, 60 * MIN), span("turn", 1, 20 * MIN, 30 * MIN), span("turn", 2, 40 * MIN, 50 * MIN)],
    // Worker 2 belongs to another job, so its work is no reason to say this job was working.
    jobs: [binding(J("a"), 0, { fields: { agents: [0, 1], segments: [{ start_ms: 0, end_ms: 100 * MIN }] } }), binding(J("b"), 0, { fields: { agents: [2] } })],
  })
  const parts = correctStretches([stretch(10 * MIN, 60 * MIN, "muda", "waiting", [[10 * MIN, 60 * MIN]]), stretch(0, 10 * MIN, "value", null, [[0, 10 * MIN]])], session, session.jobs[0])
  assert.deepEqual(parts.map((part) => [part.start_ms / MIN, part.end_ms / MIN, part.class, part.waste, part.waited_on ?? null, part.reason ?? null]), [
    [10, 20, "muda", "waiting", "next_prompt", null],
    [20, 30, UNLABELED_CLASS, null, null, AGENTS_WORKING],
    [30, 60, "muda", "waiting", "next_prompt", null],
    [0, 10, "value", null, null, null],
  ])
  assert.equal(parts[0].source, parts[1].source, "each part keeps the label it came from")
})

test("the worker a waiting stretch shows blocked is not working: its long call and the turn around it stay waiting", () => {
  const session = facts({
    id: S(2),
    duration: 30 * MIN,
    intervals: [span("turn", 0, 0, 30 * MIN), tool(0, 5 * MIN, 25 * MIN)],
    jobs: [binding(J("a"), 0)],
  })
  const [part, ...rest] = correctStretches([stretch(5 * MIN, 25 * MIN, "muda", "waiting", [[5 * MIN, 25 * MIN]])], session, session.jobs[0])
  assert.equal(rest.length, 0)
  assert.equal(part.class, "muda")
  assert.equal(part.waited_on, "long_tool_call")
})

test("existing totals keep their meaning; the Pareto adds waiting_corrected_ms and agents_working_unlabeled_ms, which add up to the waiting row", () => {
  const session = facts({
    id: S(3),
    duration: 60 * MIN,
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    intervals: [span("turn", 0, 0, 10 * MIN), span("human_wait", 0, 10 * MIN, 60 * MIN), span("turn", 1, 20 * MIN, 30 * MIN)],
    jobs: [binding(J("a"), 0, { done: 60 * MIN })],
  })
  const labels = resolveLabels([labelsFile(J("a"), S(3), [stretch(0, 10 * MIN, "value", null, [[0, 10 * MIN]]), stretch(10 * MIN, 60 * MIN, "muda", "waiting", [[10 * MIN, 60 * MIN]])])], [session])
  assert.equal(labels.byJobSession.get(`${J("a")}/${S(3)}`).stretches[1].end_ms, 60 * MIN, "the used labels are as written")
  const records = buildTimelines([session]).map((timeline) => jobRecord({ timeline, formulas: calculateFormulas(timeline) }, labels.byJobSession))
  assert.deepEqual(records[0].measures["muda_time.waiting"], { value: 50 * MIN, state: "measured" }, "the muda measure is unchanged")
  const pareto = computeRollups({ records, sessions: [session], labels }).muda.groupings.overall.all
  assert.equal(pareto.wastes.find((row) => row.waste === "waiting").total_ms, 50 * MIN)
  assert.deepEqual(pareto.waiting_corrected_ms, { state: "measured", value: 40 * MIN, n: 1, N: 1, reasons: [] })
  assert.deepEqual(pareto.agents_working_unlabeled_ms, { state: "measured", value: 10 * MIN, n: 1, N: 1, reasons: [] })
  const empty = computeRollups({ records: [], sessions: [], labels: resolveLabels([], []) }).muda.groupings.overall.all
  assert.equal(empty.waiting_corrected_ms.state, "unavailable")
  assert.equal(Object.hasOwn(empty.waiting_corrected_ms, "value"), false, "no labels is no figure, never a zero")
})

test("labels from a session shared with other jobs are marked when they are whole-session or the same as another job's", () => {
  const segments = (start, end) => [{ start_ms: start, end_ms: end }]
  const session = facts({
    id: S(4),
    duration: 40 * MIN,
    intervals: [span("turn", 0, 0, 40 * MIN)],
    jobs: [binding(J("a"), 0, { fields: { agents: [0], segments: segments(0, 20 * MIN) } }), binding(J("b"), 0, { fields: { agents: [0], segments: segments(20 * MIN, 40 * MIN) } })],
  })
  const whole = [stretch(0, 40 * MIN, "support", null, [[0, 40 * MIN]])]
  const both = resolveLabels([labelsFile(J("a"), S(4), whole), labelsFile(J("b"), S(4), whole)], [session])
  assert.deepEqual([...both.sharedLabels].sort(), [`${J("a")}/${S(4)}`, `${J("b")}/${S(4)}`])
  const own = resolveLabels([labelsFile(J("a"), S(4), [stretch(0, 20 * MIN, "support", null, [[0, 40 * MIN]])])], [session])
  assert.equal(own.sharedLabels.size, 0, "labels of the job's own share only are not marked")
  const alone = facts({ id: S(5), duration: 40 * MIN, intervals: [span("turn", 0, 0, 40 * MIN)], jobs: [binding(J("a"), 0)] })
  assert.equal(resolveLabels([labelsFile(J("a"), S(5), whole)], [alone]).sharedLabels.size, 0)
})

test("work bursts break on an idle gap of 15 minutes or an operator turn, and bursts and gaps add up to the lead time", () => {
  assert.equal(BURST_IDLE_GAP_MS, 15 * MIN)
  const session = facts({
    id: S(6),
    duration: 100 * MIN,
    intervals: [
      span("turn", 0, 0, 10 * MIN), tool(0, 1 * MIN, 2 * MIN, "shell", "error"),
      // 10 minutes idle: the same burst.
      span("turn", 0, 20 * MIN, 30 * MIN),
      span("human_wait", 0, 30 * MIN, 60 * MIN),
      // 30 minutes idle: a new burst.
      span("turn", 0, 60 * MIN, 70 * MIN),
      // A turn arriving after only 5 idle minutes still starts a new burst.
      span("turn", 0, 75 * MIN, 90 * MIN),
    ],
    humanTurns: [{ at_ms: 60 * MIN, basis: "after_stop", window_ms: 30 * MIN, prompt_class: "short", output_class: "short" }, { at_ms: 75 * MIN, basis: "after_stop", window_ms: 5 * MIN, prompt_class: "short", output_class: "short" }],
    jobs: [binding(J("a"), 10 * MIN, { done: 120 * MIN, fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 100 * MIN }] } })],
  })
  const { walk } = walkOf([session], [labelsFile(J("a"), S(6), [stretch(0, 10 * MIN, "value", null, [[0, 10 * MIN]]), stretch(30 * MIN, 60 * MIN, "muda", "waiting", [[30 * MIN, 60 * MIN]])])], J("a"))
  assert.deepEqual(walk.bursts.map((burst) => [burst.start_ms / MIN, burst.end_ms / MIN, burst.working_ms / MIN, burst.operator_turns, burst.tool_calls, burst.tool_failures, burst.value_ms / MIN]), [
    [10, 40, 20, 0, 1, 1, 10],
    [70, 80, 10, 1, 0, 0, 0],
    [85, 100, 15, 1, 0, 0, 0],
  ])
  assert.deepEqual(walk.gaps.map((gap) => [gap.start_ms / MIN, gap.end_ms / MIN, gap.waited_on]), [
    [0, 10, "queue_before_start"],
    [40, 70, "next_prompt"],
    [80, 85, "unknown"],
    [100, 120, "no_session"],
  ])
  const total = [...walk.bursts, ...walk.gaps].reduce((sum, entry) => sum + entry.end_ms - entry.start_ms, 0)
  assert.equal(total, walk.window.lead.value)
  assert.deepEqual(GAP_WAITED_ON, ["next_prompt", "api_retry", "queue_before_start", "no_session", "unknown"])
})

test("an operator turn arriving while work runs splits the burst at the turn", () => {
  const session = facts({
    id: S(7),
    duration: 20 * MIN,
    intervals: [span("subagent", 0, 0, 20 * MIN)],
    humanTurns: [{ at_ms: 8 * MIN, basis: "mid_turn", window_ms: 0, prompt_class: "short", output_class: "short" }],
    jobs: [binding(J("a"), 0, { done: 20 * MIN, fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 20 * MIN }] } })],
  })
  const { walk } = walkOf([session], [], J("a"))
  assert.deepEqual(walk.bursts.map((burst) => [burst.start_ms / MIN, burst.end_ms / MIN, burst.operator_turns]), [[0, 8, 0], [8, 20, 1]])
})

test("the stack-up splits lead time into segments that add up exactly, counting overlapping sessions' time once by precedence", () => {
  const first = facts({
    id: S(8),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 30 * MIN), span("human_wait", 0, 30 * MIN, 60 * MIN)],
    jobs: [binding(J("a"), 10 * MIN, { done: 200 * MIN })],
  })
  // A second session runs alongside the first, then a gap with no session, then it ends before done.
  const second = facts({
    id: S(9),
    duration: 40 * MIN,
    intervals: [span("turn", 0, 0, 40 * MIN)],
    jobs: [binding(J("a"), 40 * MIN, { done: 200 * MIN })],
  })
  const labels = [
    labelsFile(J("a"), S(8), [stretch(0, 30 * MIN, "support", null, [[0, 30 * MIN]]), stretch(30 * MIN, 60 * MIN, "muda", "waiting", [[30 * MIN, 60 * MIN]])]),
    labelsFile(J("a"), S(9), [stretch(0, 20 * MIN, "value", null, [[0, 40 * MIN]])]),
  ]
  const { walk } = walkOf([first, second], labels, J("a"))
  const row = walk.stackup
  assert.equal(row.lead_time_ms.value, 200 * MIN)
  assert.equal(sumOf(row), row.lead_time_ms.value)
  assert.equal(row.queue_before_start_ms.value, 10 * MIN)
  assert.equal(row.class_ms.value.value, 20 * MIN)
  assert.equal(row.class_ms.support.value, 30 * MIN)
  // The waiting stretch (40 to 70) overlaps the second session's value stretch (40 to 60), which takes those moments first. The overlap
  // split reads one session's own workers, so the second session's turn does not split the first session's wait.
  assert.equal(row.waste_ms.waiting.value, 10 * MIN)
  assert.equal(row.agents_working_unlabeled_ms.value, 0)
  assert.equal(row.not_labeled_ms.value, 10 * MIN)
  assert.equal(row.no_session_ms.value, 120 * MIN)
  assert.equal(row.waste_ms.defects.state, "measured")
  assert.equal(row.waste_ms.defects.value, 0, "a waste the labels did not find is a measured zero")
})

test("the stack-up states partial and unavailable figures with reasons and never a zero for no data", () => {
  const open = facts({ id: S(10), duration: 30 * MIN, intervals: [span("turn", 0, 0, 30 * MIN)], jobs: [{ ...binding(J("a"), 0), transitions: [{ to: "processing", offset_ms: 0 }] }] })
  const openRow = walkOf([open], [], J("a")).walk.stackup
  assert.equal(openRow.lead_time_ms.state, "partial")
  assert.deepEqual(openRow.lead_time_ms.reasons, ["censored"])
  assert.equal(openRow.class_ms.value.state, "unavailable")
  assert.deepEqual(openRow.class_ms.value.reasons, ["open_job"])
  assert.equal(Object.hasOwn(openRow.class_ms.value, "value"), false)
  assert.equal(sumOf(openRow), openRow.lead_time_ms.value, "unlabeled time is in not labeled, so the bar still adds up")
  const unplaced = facts({ id: S(11), duration: 30 * MIN, intervals: [span("turn", 0, 0, 30 * MIN)], jobs: [{ ...binding(J("b"), null), transitions: [{ to: "done", offset_ms: null }] }] })
  const none = walkOf([unplaced], [], J("b")).walk
  assert.equal(none.stackup.queue_before_start_ms.state, "unavailable")
  assert.deepEqual(none.stackup.queue_before_start_ms.reasons, none.stackup.lead_time_ms.reasons)
  assert.equal(none.task.bursts.state, "unavailable")
})

test("a shared session's labels make the job's labeled figures partial with labels_from_shared_session", () => {
  const session = facts({
    id: S(12),
    duration: 40 * MIN,
    intervals: [span("turn", 0, 0, 40 * MIN)],
    jobs: [binding(J("a"), 0, { done: 20 * MIN, fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 20 * MIN }] } }), binding(J("b"), -20 * MIN, { done: 20 * MIN, fields: { agents: [0], segments: [{ start_ms: 20 * MIN, end_ms: 40 * MIN }] } })],
  })
  const whole = [stretch(0, 40 * MIN, "support", null, [[0, 40 * MIN]])]
  const { walk } = walkOf([session], [labelsFile(J("a"), S(12), whole), labelsFile(J("b"), S(12), whole)], J("a"))
  assert.equal(walk.stackup.class_ms.support.state, "partial")
  assert.deepEqual(walk.stackup.class_ms.support.reasons, ["labels_from_shared_session"])
  assert.equal(walk.task.labels_from_shared_session, true)
  assert.equal(sumOf(walk.stackup), walk.stackup.lead_time_ms.value)
})

test("timeline additions place workers, human turns and pull requests on the job clock and invent no time", () => {
  const session = facts({
    id: S(13),
    duration: 30 * MIN,
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha", agent_type: "general-purpose" }, { n: 2, parent: 0, model: "model-alpha" }],
    intervals: [span("turn", 0, 0, 30 * MIN)],
    prs: [{ repo: "ourostack/desk", number: 2, agent: 0, at_ms: 5 * MIN }, { repo: "ourostack/desk", number: 1, agent: 1 }],
    humanTurns: [{ at_ms: 1000, basis: "first", window_ms: null, prompt_class: "short", output_class: "short" }],
    jobs: [binding(J("a"), 2 * MIN, { fields: { agents: [0, 1], segments: [{ start_ms: 0, end_ms: 30 * MIN }] } }), binding(J("b"), 0, { fields: { agents: [2] } })],
  })
  const timeline = buildTimelines([session]).find((candidate) => candidate.job === J("a"))
  const additions = timelineAdditions(timeline)
  assert.deepEqual(additions.agents, [
    { host: "claude-code", session: S(13), n: 0, parent: null },
    { host: "claude-code", session: S(13), n: 1, parent: 0 },
  ])
  assert.deepEqual(additions.human_turns, [{ host: "claude-code", session: S(13), at_ms: 2 * MIN + 1000, basis: "first", window_ms: null, prompt_class: "short", output_class: "short" }])
  assert.deepEqual(additions.prs, [
    { host: "claude-code", session: S(13), repo: "ourostack/desk", number: 2, worker: 0, at_ms: 7 * MIN },
    { host: "claude-code", session: S(13), repo: "ourostack/desk", number: 1, worker: 1 },
  ])
})

test("a public desk's session, which carries no job offset and no pull request times, places nothing on the job clock", () => {
  const session = facts({
    id: S(14),
    duration: 30 * MIN,
    intervals: [span("turn", 0, 0, 30 * MIN)],
    prs: [{ repo: "ourostack/desk", number: 3 }],
    humanTurns: [{ at_ms: 1000, basis: "first", window_ms: null, prompt_class: "short", output_class: "short" }],
    jobs: [{ ...binding(J("a"), null), transitions: [{ to: "done", offset_ms: null }] }],
    unavailable: [{ field: "job_offsets", reason: "desk_public" }],
  })
  const labels = resolveLabels([labelsFile(J("a"), S(14), [stretch(0, 30 * MIN, "value", null, [[0, 30 * MIN]])])], [session])
  const timeline = buildTimelines([session])[0]
  const additions = timelineAdditions(timeline)
  assert.deepEqual(additions.human_turns, [])
  assert.deepEqual(additions.prs, [{ host: "claude-code", session: S(14), repo: "ourostack/desk", number: 3 }])
  assert.equal(sessionDetail(timeline, 0, labels), null)
})

test("a session detail file lists the lane intervals and gives each stretch's evidence as indices into them", () => {
  const session = facts({
    id: S(15),
    duration: 30 * MIN,
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    intervals: [span("turn", 0, 0, 10 * MIN), tool(0, 1 * MIN, 2 * MIN, "desk", "error"), span("human_wait", 0, 10 * MIN, 30 * MIN), span("turn", 1, 0, 5 * MIN)],
    // Worker 1 is another job's: a stretch citing its turn still resolves, as an evidence-only interval.
    jobs: [binding(J("a"), 1000, { fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 30 * MIN }] } }), binding(J("b"), 0, { fields: { agents: [1] } })],
  })
  const labels = resolveLabels([labelsFile(J("a"), S(15), [
    stretch(0, 5 * MIN, "muda", "defects", [[1 * MIN, 2 * MIN], [0, 5 * MIN]]),
    stretch(10 * MIN, 30 * MIN, "muda", "waiting", [[10 * MIN, 30 * MIN]]),
  ])], [session])
  const timeline = buildTimelines([session]).find((candidate) => candidate.job === J("a"))
  const detail = sessionDetail(timeline, 0, labels)
  assert.equal(detail.offset_ms, 1000)
  assert.equal(detail.labeled, true)
  for (const entry of detail.stretches) for (const index of entry.evidence) assert.ok(detail.intervals[index], "every index resolves")
  const defect = detail.stretches[0]
  assert.deepEqual(defect.evidence.map((index) => detail.intervals[index]), [
    { kind: "turn", worker: 1, start_ms: 1000, end_ms: 5 * MIN + 1000, evidence_only: true },
    { kind: "tool", worker: 0, start_ms: MIN + 1000, end_ms: 2 * MIN + 1000, tool: "desk", outcome: "error" },
  ])
  assert.equal(detail.stretches[1].waited_on, "next_prompt")
  assert.equal(detail.intervals.filter((entry) => entry.worker === 1 && entry.evidence_only !== true).length, 0, "another job's worker is no lane of this job")
})

test("a session detail file at the label cap (10,000 stretches, 20,000 intervals) stays inside the per-file budget", () => {
  const count = 10_000
  const intervals = Array.from({ length: count * 2 }, (_, index) => tool(0, index * 1000, index * 1000 + 500, "shell", index % 7 === 0 ? "error" : "ok"))
  const session = facts({ id: S(16), duration: count * 2000, intervals: [span("turn", 0, 0, count * 2000), ...intervals], jobs: [binding(J("a"), 0)] })
  const stretches = Array.from({ length: count }, (_, index) => stretch(index * 2000, index * 2000 + 2000, index % 2 === 0 ? "muda" : "support", index % 2 === 0 ? "defects" : null, [[index * 2000, index * 2000 + 500], [index * 2000 + 1000, index * 2000 + 1500]]))
  const labels = resolveLabels([labelsFile(J("a"), S(16), stretches)], [session])
  const timeline = buildTimelines([session])[0]
  const bytes = Buffer.byteLength(`${stableStringify(sessionDetail(timeline, 0, labels))}\n`)
  assert.ok(bytes < DETAIL_FILE_BUDGET_BYTES, `${bytes} bytes`)
})

test("the causes rollup counts each session's time once, largest first, and its waste totals equal the Pareto's corrected ones", () => {
  const session = facts({
    id: S(17),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 20 * MIN), tool(0, 1 * MIN, 2 * MIN, "shell", "error"), span("human_wait", 0, 20 * MIN, 60 * MIN)],
    jobs: [binding(J("a"), 0, { done: 60 * MIN, fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 60 * MIN, shared: true }] } }), binding(J("b"), 0, { done: 60 * MIN, fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 60 * MIN, shared: true }] } })],
  })
  const same = [stretch(0, 20 * MIN, "muda", "defects", [[1 * MIN, 2 * MIN]]), stretch(20 * MIN, 60 * MIN, "muda", "waiting", [[20 * MIN, 60 * MIN]])]
  const files = [labelsFile(J("a"), S(17), same), labelsFile(J("b"), S(17), same)]
  const labels = resolveLabels(files, [session])
  const timelines = buildTimelines([session])
  const records = timelines.map((timeline) => jobRecord({ timeline, formulas: calculateFormulas(timeline) }, labels.byJobSession))
  const causes = causesRollup({ records, timelines, labels })
  assert.equal(causes.state, "measured")
  assert.deepEqual(causes.causes.map((row) => [row.cause, row.total_ms / MIN, row.jobs]), [["waiting:next_prompt", 40, [J("a")]], ["defects:shell", 20, [J("a")]]])
  assert.deepEqual(causes.causes[0].stretches, [{ job: J("a"), host: "claude-code", session: S(17), start_ms: 20 * MIN, end_ms: 60 * MIN }])
  const pareto = computeRollups({ records, sessions: [session], labels }).muda.groupings.overall.all
  assert.equal(causes.total_ms, pareto.muda_time_ms - pareto.agents_working_unlabeled_ms.value)
  assert.equal(stackupRollup([]).jobs.length, 0)
})

test("a figure that is not measured must name a reason", () => {
  assert.throws(() => figure("partial", 1, []), /no reason/u)
  assert.deepEqual(figure("measured", 1, ["ignored"]), { class: "inferred", state: "measured", value: 1, reasons: [] })
})

test("evidence that names no interval resolves to nothing, and a range two intervals share resolves to both", () => {
  const session = facts({ id: S(20), duration: 10, intervals: [span("turn", 0, 0, 10), span("turn", 1, 0, 10)], agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }], jobs: [binding(J("a"), 0)] })
  assert.deepEqual(evidenceIntervals(session, [[1, 2]]), [])
  assert.deepEqual(evidenceIntervals(session, [[0, 10], [0, 10]]).map((interval) => interval.agent), [0, 1])
})

test("a lead time floored to the recorded work measures its window from where the work starts, and a timed pull request counts in its burst", () => {
  const session = facts({
    id: S(21),
    duration: 40 * MIN,
    intervals: [span("turn", 0, 0, 40 * MIN)],
    prs: [{ repo: "ourostack/desk", number: 4, agent: 0, at_ms: 30 * MIN }],
    // The card is created after the work began and closed before it ended.
    jobs: [binding(J("a"), -10 * MIN, { done: 5 * MIN, fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 40 * MIN }] } })],
  })
  const { walk } = walkOf([session], [], J("a"))
  assert.equal(walk.window.start_ms, -10 * MIN)
  assert.equal(walk.window.end_ms, 30 * MIN)
  assert.deepEqual(walk.window.lead.reasons, ["card_dates_shorter_than_work"])
  assert.equal(walk.bursts.length, 1)
  assert.equal(walk.bursts[0].prs, 1)
  assert.equal(walk.stackup.queue_before_start_ms.state, "partial")
  assert.equal(sumOf(walk.stackup), walk.stackup.lead_time_ms.value)
})

test("a lead time of zero has no flow efficiency, never a division by zero", () => {
  const session = facts({ id: S(22), duration: 5 * MIN, intervals: [], jobs: [binding(J("a"), -10 * MIN, { done: 0 })] })
  const { walk } = walkOf([session], [], J("a"))
  assert.equal(walk.window.lead.value, 0)
  assert.deepEqual(walk.task.flow_efficiency, { class: "unavailable", state: "unavailable", reasons: ["zero_lead_time"] })
  assert.equal(walk.task.longest_gap.state, "unavailable")
})

test("a detail file keeps a stretch's catch point and marks the part split off a wait; a human turn in another job's segment is not this job's", () => {
  const session = facts({
    id: S(23),
    duration: 60 * MIN,
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    intervals: [span("turn", 0, 0, 10 * MIN), tool(0, 1 * MIN, 2 * MIN, "edit", "error"), span("human_wait", 0, 10 * MIN, 30 * MIN), span("turn", 1, 15 * MIN, 20 * MIN), span("turn", 0, 40 * MIN, 50 * MIN)],
    humanTurns: [{ at_ms: 0, basis: "first", window_ms: null, prompt_class: "short", output_class: "short" }, { at_ms: 40 * MIN, basis: "after_stop", window_ms: 10 * MIN, prompt_class: "short", output_class: "short" }],
    jobs: [binding(J("a"), 0, { fields: { agents: [0, 1], segments: [{ start_ms: 0, end_ms: 30 * MIN }] } }), binding(J("b"), 0, { fields: { agents: [0], segments: [{ start_ms: 30 * MIN, end_ms: 60 * MIN }] } })],
  })
  const labels = resolveLabels([labelsFile(J("a"), S(23), [stretch(0, 5 * MIN, "muda", "defects", [[1 * MIN, 2 * MIN]], { caught: "in_task" }), stretch(10 * MIN, 30 * MIN, "muda", "waiting", [[10 * MIN, 30 * MIN]])])], [session])
  const timeline = buildTimelines([session]).find((candidate) => candidate.job === J("a"))
  const detail = sessionDetail(timeline, 0, labels)
  assert.equal(detail.stretches[0].caught, "in_task")
  assert.deepEqual(detail.stretches.map((entry) => entry.reason ?? entry.waited_on ?? null), [null, "next_prompt", AGENTS_WORKING, "next_prompt"])
  assert.deepEqual(timelineAdditions(timeline).human_turns.map((turn) => turn.at_ms), [0])
})

test("a pull request two sessions mention is listed once, at its earliest time", () => {
  const one = facts({ id: S(24), duration: 10 * MIN, intervals: [span("turn", 0, 0, 10 * MIN)], prs: [{ repo: "ourostack/desk", number: 5, agent: 0 }], jobs: [binding(J("a"), 0)] })
  const two = facts({ id: S(25), duration: 10 * MIN, intervals: [span("turn", 0, 0, 10 * MIN)], prs: [{ repo: "ourostack/desk", number: 5, agent: 0, at_ms: 2 * MIN }, { repo: "ourostack/desk", number: 6, agent: 0, at_ms: 1 * MIN }], jobs: [binding(J("a"), 20 * MIN)] })
  const timeline = buildTimelines([one, two])[0]
  assert.deepEqual(timelineAdditions(timeline).prs.map((pr) => [pr.number, pr.at_ms ?? null, pr.session]), [[6, 21 * MIN, S(25)], [5, 22 * MIN, S(25)]])
})

test("compareFields orders by each field in turn and calls entries equal on every field equal", () => {
  assert.equal(compareFields({ a: 1, b: "x" }, { a: 1, b: "y" }, ["a", "b"]), -1)
  assert.equal(compareFields({ a: 2 }, { a: 1 }, ["a"]), 1)
  assert.equal(compareFields({ a: 1, b: "x" }, { a: 1, b: "x" }, ["a", "b"]), 0)
})

test("a turn after the last burst and a pull request opened in a gap belong to no burst", () => {
  const session = facts({
    id: S(26),
    duration: 60 * MIN,
    intervals: [span("turn", 0, 0, 10 * MIN)],
    prs: [{ repo: "ourostack/desk", number: 7, agent: 0, at_ms: 40 * MIN }],
    humanTurns: [{ at_ms: 0, basis: "first", window_ms: null, prompt_class: "short", output_class: "short" }, { at_ms: 50 * MIN, basis: "after_stop", window_ms: 40 * MIN, prompt_class: "short", output_class: "short" }],
    jobs: [binding(J("a"), 0, { done: 60 * MIN, fields: { agents: [0], segments: [{ start_ms: 0, end_ms: 60 * MIN }] } })],
  })
  const { walk } = walkOf([session], [], J("a"))
  assert.deepEqual(walk.bursts.map((burst) => [burst.operator_turns, burst.prs]), [[1, 0]])
  assert.deepEqual(walk.gaps.map((gap) => [gap.start_ms / MIN, gap.end_ms / MIN]), [[10, 60]])
})

test("a counted job's session with no job offset adds its causes' time but no stretch reference", () => {
  const placed = facts({ id: S(27), duration: 10 * MIN, intervals: [span("turn", 0, 0, 5 * MIN), span("human_wait", 0, 5 * MIN, 10 * MIN)], jobs: [binding(J("a"), 0, { done: 30 * MIN })] })
  const unplaced = facts({ id: S(28), duration: 10 * MIN, intervals: [span("turn", 0, 0, 5 * MIN), span("human_wait", 0, 5 * MIN, 10 * MIN)], jobs: [{ ...binding(J("a"), null), transitions: [{ to: "processing", offset_ms: null }] }] })
  const wait = [stretch(5 * MIN, 10 * MIN, "muda", "waiting", [[5 * MIN, 10 * MIN]])]
  const sessions = [placed, unplaced]
  const labels = resolveLabels([labelsFile(J("a"), S(27), wait), labelsFile(J("a"), S(28), wait)], sessions)
  const timelines = buildTimelines(sessions)
  const records = timelines.map((timeline) => jobRecord({ timeline, formulas: calculateFormulas(timeline) }, labels.byJobSession))
  assert.equal(records[0].measures.muda_time.state, "measured")
  const [row] = causesRollup({ records, timelines, labels }).causes
  assert.equal(row.total_ms, 10 * MIN)
  assert.deepEqual(row.stretches.map((entry) => entry.session), [S(27)])
})

test("the overlap split handles work that starts before a wait and runs past its end", () => {
  const session = facts({
    id: S(29),
    duration: 80 * MIN,
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    intervals: [span("human_wait", 0, 10 * MIN, 60 * MIN), span("turn", 1, 5 * MIN, 20 * MIN), span("turn", 1, 50 * MIN, 70 * MIN)],
    jobs: [binding(J("a"), 0)],
  })
  const parts = correctStretches([stretch(10 * MIN, 60 * MIN, "muda", "waiting", [[10 * MIN, 60 * MIN]])], session, session.jobs[0])
  assert.deepEqual(parts.map((part) => [part.start_ms / MIN, part.end_ms / MIN, part.class]), [[10, 20, UNLABELED_CLASS], [20, 50, "muda"], [50, 60, UNLABELED_CLASS]])
})
