import { test } from "node:test"
import assert from "node:assert/strict"

import { withState } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"

import { ATTENTION_METHOD, EstimatorError, ATTENTION_REASONS, FLOOR_MS, PERMISSION_MS, READ_MS, TYPE_MS, attentionFormula, estimatePermission, estimateTurn, methodRecord, placeTurns } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/attention.js"

const turn = (basis, window_ms, output_class, prompt_class) => ({ at_ms: 0, basis, window_ms, output_class, prompt_class })

test("a 3-second yes after a long report is 3000 ms", () => {
  assert.equal(estimateTurn(turn("after_stop", 3000, "l", "xs")), 3000)
})

test("a prompt after an overnight gap is 175000 ms", () => {
  assert.equal(estimateTurn(turn("after_stop", 32_400_000, "l", "s")), 175_000)
})

test("an interruption mid-turn is 33000 ms", () => {
  assert.equal(estimateTurn(turn("mid_turn", 90_000, "m", "xs")), 33_000)
})

test("a permission decision answered in 12 seconds is 5000 ms", () => {
  assert.equal(estimatePermission(12_000), 5000)
  assert.equal(estimatePermission(3000), 3000)
  assert.equal(estimatePermission(0), FLOOR_MS)
})

test("a pasted 5000-character log 20 seconds after a short reply is 20000 ms", () => {
  assert.equal(estimateTurn(turn("after_stop", 20_000, "s", "l")), 20_000)
})

test("a second prompt 4 seconds after the first is 4000 ms", () => {
  assert.equal(estimateTurn(turn("mid_turn", 4000, "none", "s")), 4000)
})

test("the first prompt of a session is its typing time alone", () => {
  assert.equal(estimateTurn(turn("first", null, "none", "m")), 150_000)
})

test("no turn is under the floor", () => {
  assert.equal(estimateTurn(turn("mid_turn", 0, "none", "none")), FLOOR_MS)
  assert.equal(estimateTurn(turn("after_stop", 10, "xl", "xl")), FLOOR_MS)
  assert.equal(estimateTurn(turn("first", null, "none", "none")), 2000)
})

test("an unknown class throws instead of counting as zero", () => {
  assert.throws(() => estimateTurn(turn("first", null, "none", "huge")), /prompt_class/)
  assert.throws(() => estimateTurn(turn("first", null, "huge", "xs")), /output_class/)
  assert.throws(() => estimateTurn(turn("first", null, undefined, "xs")), /output_class/)
  assert.throws(() => estimateTurn(turn("first", null, "toString", "xs")), /output_class/)
  assert.throws(() => estimateTurn(turn("first", null, "xs", "constructor")), /prompt_class/)
  assert.throws(() => estimateTurn(null), /turn/)
})

test("a negative or non-finite window or wait throws instead of being clamped", () => {
  for (const bad of [-1, NaN, Infinity, "5", undefined]) {
    assert.throws(() => estimateTurn(turn("after_stop", bad, "s", "s")), /window_ms/)
    assert.throws(() => estimatePermission(bad), /wait/)
  }
})

test("a basis that disagrees with its window throws instead of giving a number", () => {
  assert.throws(() => estimateTurn(turn("after_stop", null, "xl", "xl")), /window_ms/)
  assert.throws(() => estimateTurn(turn("mid_turn", null, "l", "m")), /window_ms/)
  assert.throws(() => estimateTurn(turn("first", 5, "none", "m")), /window_ms/)
  assert.throws(() => estimateTurn(turn("first", undefined, "none", "m")), /window_ms/)
  assert.throws(() => estimateTurn(turn("bogus", 5, "s", "s")), /basis/)
  assert.throws(() => estimateTurn(turn("bogus", null, "s", "s")), /basis/)
  assert.throws(() => estimateTurn(turn(undefined, 5, "s", "s")), /basis/)
  assert.throws(() => estimateTurn({ window_ms: null, output_class: "s", prompt_class: "s" }), /basis/)
})

test("a class that is not a string throws even when it coerces to a valid key", () => {
  assert.throws(() => estimateTurn(turn("first", null, ["l"], "xs")), /output_class/)
  assert.throws(() => estimateTurn(turn("first", null, "xs", ["l"])), /prompt_class/)
})

test("an error never echoes the value it rejects", () => {
  const SENTINEL = "SENTINEL-value-with-text"
  const messages = []
  for (const bad of [turn("first", null, SENTINEL, "xs"), turn("first", null, "xs", SENTINEL), turn(SENTINEL, 5, "s", "s"), turn("after_stop", SENTINEL, "s", "s"), turn("after_stop", null, SENTINEL, "s")]) {
    try { estimateTurn(bad); messages.push("no throw") } catch (error) { messages.push(error.message) }
  }
  try { estimatePermission(SENTINEL) } catch (error) { messages.push(error.message) }
  assert.ok(messages.every((m) => m !== "no throw"))
  assert.ok(messages.every((m) => !m.includes("SENTINEL")))
})

test("a null window is no bound", () => {
  assert.equal(estimateTurn(turn("first", null, "xl", "xl")), 580_000)
})

test("the constants are frozen and the method record names the version", () => {
  assert.equal(ATTENTION_METHOD, 1)
  assert.ok(Object.isFrozen(READ_MS))
  assert.ok(Object.isFrozen(TYPE_MS))
  assert.equal(PERMISSION_MS, 5000)
  assert.equal(FLOOR_MS, 1000)
  assert.throws(() => { "use strict"; READ_MS.s = 1 }, TypeError)
  const rec = methodRecord()
  assert.deepEqual(rec, { version: 1, read_ms: { none: 0, xs: 1000, s: 5000, m: 30_000, l: 150_000, xl: 400_000 }, type_ms: { none: 2000, xs: 3000, s: 25_000, m: 150_000, l: 180_000, xl: 180_000 }, floor_ms: 1000, permission_ms: 5000 })
  rec.read_ms.s = 99
  rec.type_ms.s = 99
  rec.version = 7
  assert.deepEqual(methodRecord(), methodRecord())
  assert.equal(methodRecord().read_ms.s, 5000)
  assert.equal(methodRecord().type_ms.s, 25_000)
  assert.equal(methodRecord().version, 1)
  assert.notEqual(methodRecord().read_ms, methodRecord().read_ms)
  assert.equal(READ_MS.s, 5000)
})

test("the method record carries no text, path or name", () => {
  const SENTINEL = "SENTINEL"
  assert.ok(!JSON.stringify(methodRecord()).includes(SENTINEL))
  assert.deepEqual(Object.keys(methodRecord()), ["version", "read_ms", "type_ms", "floor_ms", "permission_ms"])
})

// ---------------------------------------------------------------------------
// Placing turns on jobs (task E7). A session here is a published session reduced to what placement reads.
// ---------------------------------------------------------------------------

const JOB_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const JOB_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
const at = (at_ms, window_ms = 3000) => ({ at_ms, basis: "after_stop", window_ms, prompt_class: "xs", output_class: "none" })
// A 3-second window bounds a short prompt after no reply at 3000 ms.
const EST = estimateTurn(at(0))
const seg = (start_ms, end_ms) => ({ start_ms, end_ms })
const session = ({ turns, jobs = [], unavailable = [], id = "11111111-1111-4111-8111-111111111111" }) => ({
  session: { host: "claude-code", id, duration_ms: 100_000 },
  ...(turns === undefined ? {} : { human_turns: turns }),
  jobs: jobs.map(([job, segments]) => ({ job, basis: ["desk_tool"], session_offset_ms: 0, transitions: [], observed: null, ...(segments ? { agents: [0], segments } : {}) })),
  unavailable,
})

test("a turn inside a job's segment goes to that job", () => {
  const placed = placeTurns(session({ turns: [at(5000)], jobs: [[JOB_A, [seg(0, 10_000)]], [JOB_B, [seg(20_000, 30_000)]]] }))
  assert.deepEqual(placed.byJob.get(JOB_A), { turns: 1, est_ms: EST, unestimated: 0 })
  assert.deepEqual(placed.byJob.get(JOB_B), { turns: 0, est_ms: 0, unestimated: 0 })
  assert.deepEqual(placed.unattributed, { turns: 0, est_ms: 0, unestimated: 0 })
  assert.deepEqual(placed.unplaced, { turns: 0, est_ms: 0, unestimated: 0 })
  assert.equal(placed.recorded, true)
  assert.equal(placed.capped, false)
})

test("a turn inside no segment is unattributed", () => {
  const placed = placeTurns(session({ turns: [at(15_000)], jobs: [[JOB_A, [seg(0, 10_000)]]] }))
  assert.deepEqual(placed.unattributed, { turns: 1, est_ms: EST, unestimated: 0 })
  assert.deepEqual(placed.byJob.get(JOB_A), { turns: 0, est_ms: 0, unestimated: 0 })
  assert.equal(placed.unplaced.turns, 0)
})

test("a segment holds its start and not its end", () => {
  const placed = placeTurns(session({ turns: [at(0), at(10_000)], jobs: [[JOB_A, [seg(0, 10_000)]]] }))
  assert.equal(placed.byJob.get(JOB_A).turns, 1)
  assert.equal(placed.unattributed.turns, 1)
})

test("a turn inside two jobs' segments goes to the one that started last", () => {
  const placed = placeTurns(session({ turns: [at(7000)], jobs: [[JOB_A, [seg(0, 10_000)]], [JOB_B, [seg(5000, 12_000)]]] }))
  assert.equal(placed.byJob.get(JOB_B).turns, 1)
  assert.equal(placed.byJob.get(JOB_A).turns, 0)
  // Two segments that start together go to the job that sorts first, so the answer never depends on the order the bindings come in.
  const tied = (jobs) => placeTurns(session({ turns: [at(7000)], jobs }))
  const forward = tied([[JOB_A, [seg(5000, 12_000)]], [JOB_B, [seg(5000, 12_000)]]])
  const backward = tied([[JOB_B, [seg(5000, 12_000)]], [JOB_A, [seg(5000, 12_000)]]])
  assert.equal(forward.byJob.get(JOB_A).turns, 1)
  assert.equal(backward.byJob.get(JOB_A).turns, 1)
  assert.equal(backward.byJob.get(JOB_B).turns, 0)
})

test("a session whose jobs publish no segments leaves its turns unplaced", () => {
  const placed = placeTurns(session({ turns: [at(5000), at(9000)], jobs: [[JOB_A, undefined], [JOB_B, undefined]] }))
  assert.deepEqual(placed.unplaced, { turns: 2, est_ms: 2 * EST, unestimated: 0 })
  assert.equal(placed.byJob.size, 0)
  assert.equal(placed.unattributed.turns, 0)
})

test("a session with no job leaves its turns unattributed", () => {
  const placed = placeTurns(session({ turns: [at(5000)], jobs: [] }))
  assert.deepEqual(placed.unattributed, { turns: 1, est_ms: EST, unestimated: 0 })
  assert.equal(placed.unplaced.turns, 0)
})

test("a session that records no list places nothing and says it was not recorded", () => {
  const placed = placeTurns(session({ jobs: [[JOB_A, [seg(0, 10_000)]]] }))
  assert.equal(placed.recorded, false)
  assert.equal(placed.byJob.size, 0)
  assert.deepEqual([placed.unattributed.turns, placed.unplaced.turns], [0, 0])
})

test("a list the session capped says so", () => {
  const placed = placeTurns(session({ turns: [at(5000)], jobs: [], unavailable: [{ field: "human_turns", reason: "capped" }] }))
  assert.equal(placed.capped, true)
  assert.equal(placed.recorded, true)
})

test("attributed, unattributed and unplaced add up to the session total", () => {
  const turns = [
    { at_ms: 1000, basis: "first", window_ms: null, prompt_class: "m", output_class: "none" },
    at(4000, 90_000), at(12_000, 20_000), { ...at(30_000, 500_000), output_class: "l", prompt_class: "s" }, at(95_000, 3000),
  ]
  const total = turns.reduce((sum, item) => sum + estimateTurn(item), 0)
  for (const jobs of [[[JOB_A, [seg(0, 6000)]], [JOB_B, [seg(11_000, 40_000)]]], [[JOB_A, undefined]], []]) {
    const placed = placeTurns(session({ turns, jobs }))
    const buckets = [...placed.byJob.values(), placed.unattributed, placed.unplaced]
    assert.equal(buckets.reduce((sum, bucket) => sum + bucket.turns, 0), turns.length)
    assert.equal(buckets.reduce((sum, bucket) => sum + bucket.est_ms, 0), total)
  }
})

test("a mid-turn window is bounded by the estimate and never added to a wait", () => {
  const placed = placeTurns(session({ turns: [{ at_ms: 5000, basis: "mid_turn", window_ms: 90_000, prompt_class: "xs", output_class: "m" }], jobs: [[JOB_A, [seg(0, 10_000)]]] }))
  assert.equal(placed.byJob.get(JOB_A).est_ms, 33_000)
  assert.deepEqual(Object.keys(placed).sort(), ["byJob", "capped", "recorded", "unattributed", "unestimated", "unplaced"])
})

test("a broken turn is counted and flagged, never skipped and never stops the build", () => {
  const broken = { at_ms: 5000, basis: "after_stop", window_ms: null, prompt_class: "xs", output_class: "none" }
  const placed = placeTurns(session({ turns: [at(4000), broken, { ...at(6000), prompt_class: "SENTINEL-CLASS" }], jobs: [[JOB_A, [seg(0, 10_000)]]] }))
  assert.deepEqual(placed.byJob.get(JOB_A), { turns: 3, est_ms: EST, unestimated: 2 })
  assert.equal(placed.unestimated, 2)
  assert.ok(!JSON.stringify(placed).includes("SENTINEL"))
  const total = placeTurns(session({ turns: [at(4000), broken], jobs: [] }))
  assert.deepEqual(total.unattributed, { turns: 2, est_ms: EST, unestimated: 1 })
})

// ---------------------------------------------------------------------------
// The per-job attention result.
// ---------------------------------------------------------------------------

const PUBLIC = [{ field: "job_offsets", reason: "desk_public" }]
const BROKEN = { at_ms: 5000, basis: "mid_turn", window_ms: null, prompt_class: "xs", output_class: "none" }
const recordsTurns = (extra = {}) => session({ turns: [at(5000), at(6000)], jobs: [[JOB_A, [seg(0, 10_000)]]], ...extra })
const another = (value, n) => ({ ...value, session: { ...value.session, id: `${n}`.repeat(8) + "-1111-4111-8111-111111111111" } })

test("a job's attention is the estimated time of the turns placed on it, inferred and stated", () => {
  const result = attentionFormula([recordsTurns()], JOB_A)
  assert.deepEqual(result, { class: "inferred", state: "measured", reasons: [], value: 2 * EST, turns: 2, method: ATTENTION_METHOD })
  assert.deepEqual(withState(result), result)
})

test("a job on a public desk has attention unavailable as desk_public", () => {
  const result = attentionFormula([session({ turns: [at(5000)], jobs: [[JOB_A, undefined]], unavailable: PUBLIC })], JOB_A)
  assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reason: "desk_public", reasons: ["desk_public"] })
  assert.deepEqual(withState(result), result)
})

test("a job with one session recording turns and one not is partial", () => {
  const result = attentionFormula([recordsTurns(), another(session({ jobs: [[JOB_A, [seg(0, 10_000)]]] }), 2)], JOB_A)
  assert.equal(result.state, "partial")
  assert.deepEqual(result.reasons, ["turns_not_recorded"])
  assert.deepEqual(result.partial_reasons, ["turns_not_recorded"])
  assert.equal(result.partial, true)
  assert.equal(result.value, 2 * EST)
  assert.deepEqual(withState(result), result)
})

test("a job whose sessions predate the record is unavailable, not zero", () => {
  const result = attentionFormula([session({ jobs: [[JOB_A, [seg(0, 10_000)]]] })], JOB_A)
  assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reason: "not_recorded", reasons: ["not_recorded"] })
  // A session that flags the field as not recorded has no list either.
  const flagged = attentionFormula([session({ jobs: [[JOB_A, undefined]], unavailable: [{ field: "human_turns", reason: "host_does_not_record" }] })], JOB_A)
  assert.equal(flagged.reason, "not_recorded")
  // A job with no session at all has nothing recorded.
  assert.equal(attentionFormula([], JOB_A).reason, "not_recorded")
})

test("a job whose recording sessions publish no segments is unavailable as no_segments", () => {
  const result = attentionFormula([session({ turns: [at(5000)], jobs: [[JOB_A, undefined]] })], JOB_A)
  assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reason: "no_segments", reasons: ["no_segments"] })
})

test("a job with several different causes is unavailable as mixed and lists them", () => {
  const result = attentionFormula([session({ turns: [at(5000)], jobs: [[JOB_A, undefined]] }), another(session({ jobs: [[JOB_A, undefined]] }), 2)], JOB_A)
  assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reason: "mixed", reasons: ["no_segments", "not_recorded"] })
  assert.deepEqual(withState(result), result)
})

test("a session that cannot place the job beside one that can makes the figure partial", () => {
  const result = attentionFormula([recordsTurns(), another(session({ turns: [at(5000)], jobs: [[JOB_A, undefined]] }), 2)], JOB_A)
  assert.deepEqual([result.state, result.reasons, result.value], ["partial", ["no_segments"], 2 * EST])
})

test("a capped list and a list the host records only in part make the figure partial", () => {
  const capped = attentionFormula([recordsTurns({ unavailable: [{ field: "human_turns", reason: "capped" }] })], JOB_A)
  assert.deepEqual([capped.state, capped.reasons, capped.value], ["partial", ["turns_capped"], 2 * EST])
  const partly = attentionFormula([recordsTurns({ unavailable: [{ field: "human_turns", reason: "host_records_partly" }, { field: "human_turns", reason: "source_unreadable" }] })], JOB_A)
  assert.deepEqual([partly.state, partly.reasons], ["partial", ["host_records_partly", "source_unreadable"]])
})

test("a turn the estimator rejects makes the figure partial with a reason, and unavailable when none can be estimated", () => {
  const some = attentionFormula([recordsTurns({ turns: [at(5000), BROKEN] })], JOB_A)
  assert.deepEqual([some.state, some.reasons, some.value, some.turns], ["partial", ["turn_not_estimable"], EST, 2])
  const none = attentionFormula([recordsTurns({ turns: [BROKEN] })], JOB_A)
  assert.deepEqual(none, { class: "unavailable", state: "unavailable", value: null, reason: "turn_not_estimable", reasons: ["turn_not_estimable"] })
  assert.deepEqual(withState(none), none)
})

test("when every turn is rejected and another session gave nothing, both causes are stated", () => {
  const result = attentionFormula([recordsTurns({ turns: [BROKEN] }), another(session({ jobs: [[JOB_A, undefined]] }), 2)], JOB_A)
  assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reason: "mixed", reasons: ["not_recorded", "turn_not_estimable"] })
})

test("a recorded list with no turn on the job is a measured zero", () => {
  const result = attentionFormula([session({ turns: [], jobs: [[JOB_A, [seg(0, 10_000)]]] })], JOB_A)
  assert.deepEqual([result.state, result.value, result.turns], ["measured", 0, 0])
})

test("only the job's own turns count when two jobs share a session", () => {
  const shared = session({ turns: [at(5000), at(15_000), at(25_000)], jobs: [[JOB_A, [seg(0, 10_000)]], [JOB_B, [seg(10_000, 20_000)]]] })
  assert.equal(attentionFormula([shared], JOB_A).turns, 1)
  assert.equal(attentionFormula([shared], JOB_B).turns, 1)
})

test("every reason the attention result can carry is listed and every listed reason is produced", () => {
  const cases = [
    [session({ turns: [at(5000)], jobs: [[JOB_A, undefined]], unavailable: PUBLIC })],
    [session({ jobs: [[JOB_A, undefined]] })],
    [session({ turns: [at(5000)], jobs: [[JOB_A, undefined]] })],
    [recordsTurns({ unavailable: [{ field: "human_turns", reason: "capped" }] })],
    [recordsTurns(), another(session({ jobs: [[JOB_A, undefined]] }), 2)],
    [recordsTurns({ turns: [BROKEN] })],
    [recordsTurns({ turns: [at(5000), BROKEN] })],
    [recordsTurns(), another(session({ jobs: [[JOB_A, undefined]], unavailable: PUBLIC }), 2)],
    [session({ turns: [at(5000)], jobs: [[JOB_A, undefined]] }), another(session({ jobs: [[JOB_A, undefined]] }), 2)],
  ]
  const seen = new Set(cases.flatMap((sessions) => attentionFormula(sessions, JOB_A).reasons))
  assert.deepEqual([...seen].filter((reason) => !ATTENTION_REASONS.includes(reason)), [])
  assert.deepEqual(ATTENTION_REASONS.filter((reason) => !seen.has(reason)), [])
})

test("the attention result carries counts and codes only", () => {
  const result = attentionFormula([recordsTurns()], JOB_A)
  assert.deepEqual(Object.keys(result).sort(), ["class", "method", "reasons", "state", "turns", "value"])
})

test("the estimator throws its own error class for a broken turn or wait, and only that class counts as a stated gap", () => {
  for (const call of [() => estimateTurn(null), () => estimateTurn(turn("first", null, "none", "huge")), () => estimateTurn(turn("bogus", 5, "s", "s")), () => estimateTurn(turn("first", 5, "none", "m")), () => estimateTurn(turn("after_stop", -1, "s", "s")), () => estimatePermission(-1)]) {
    assert.throws(call, (error) => error instanceof EstimatorError && error instanceof Error && error.name === "EstimatorError")
  }
  // A programming error inside the estimator's reach is not a broken turn: it is not swallowed.
  const defect = { at_ms: 5000, basis: "after_stop", window_ms: 3000, prompt_class: "xs", get output_class() { throw new TypeError("a defect in the code") } }
  assert.throws(() => placeTurns(session({ turns: [defect], jobs: [[JOB_A, [seg(0, 10_000)]]] })), TypeError)
  assert.throws(() => placeTurns(session({ turns: [defect], jobs: [] })), TypeError)
})
