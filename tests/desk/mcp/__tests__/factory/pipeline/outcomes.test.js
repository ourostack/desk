import { test } from "node:test"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import assert from "node:assert/strict"

import { ROLLUPS_SCHEMA } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"
import { methodRecord } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/attention.js"
import { sessionVersion } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/attention-rollup.js"
import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { OUTCOMES_SCHEMA, collectOutcomes, computeOutcomeRollups, firstPassFormula, reworkFormula, signoffFormula } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/outcomes.js"

const J1 = "1".repeat(32)
const J2 = "2".repeat(32)
const J3 = "3".repeat(32)
const J4 = "4".repeat(32)

const entry = (job, extra = {}) => ({ job, rev: 1, state: "delivered_unsigned", verified: null, reason: null, deliveries: 1, wait: null, ...extra })
const session = (outcomes) => (outcomes === undefined ? {} : { outcomes })
const withRecord = (...jobs) => jobs.map((job) => ({ timeline: { job } }))

test("the rollup schema string is the one rollups.js writes", () => {
  assert.equal(OUTCOMES_SCHEMA, ROLLUPS_SCHEMA)
})

test("the entry with the highest rev wins across a job's sessions", () => {
  const older = entry(J1, { rev: 2, state: "delivered_unsigned" })
  const newer = entry(J1, { rev: 3, state: "accepted", verified: true })
  for (const order of [[older, newer], [newer, older]]) {
    const collected = collectOutcomes(order.map((item) => session([item])))
    assert.deepEqual([...collected.keys()], [J1])
    assert.deepEqual(collected.get(J1), newer)
  }
  // Sessions with no outcomes key add nothing, and jobs come out in job order.
  const collected = collectOutcomes([session(undefined), session([entry(J2)]), session([entry(J1)])])
  assert.deepEqual([...collected.keys()], [J1, J2])
})

test("a tie in rev keeps the longer wait class, a null wait is shortest, and a further tie does not depend on order", () => {
  const short = entry(J1, { rev: 4, state: "delivered_unsigned", wait: { class: "lt_1h", censored: true } })
  const long = entry(J1, { rev: 4, state: "delivered_unsigned", wait: { class: "lt_7d", censored: true } })
  const none = entry(J1, { rev: 4, state: "delivered_unsigned", wait: null })
  for (const order of [[short, long, none], [none, long, short], [long, none, short]]) {
    assert.deepEqual(collectOutcomes(order.map((item) => session([item]))).get(J1), long)
  }
  for (const order of [[short, none], [none, short]]) {
    assert.deepEqual(collectOutcomes(order.map((item) => session([item]))).get(J1), short)
  }
  // Pairs whose text order is the opposite of their wait order, so only the wait rule can pick the longer one.
  const lt1d = entry(J1, { rev: 4, wait: { class: "lt_1d", censored: true } })
  const ge7d = entry(J1, { rev: 4, wait: { class: "ge_7d", censored: true } })
  const lt1h = entry(J1, { rev: 4, wait: { class: "lt_1h", censored: true } })
  const nothing = entry(J1, { rev: 4, wait: null })
  for (const [longer, shorter] of [[ge7d, lt1d], [lt1h, nothing], [lt1d, lt1h]]) {
    for (const order of [[longer, shorter], [shorter, longer]]) {
      assert.deepEqual(collectOutcomes(order.map((item) => session([item]))).get(J1), longer)
    }
  }
  const censored = entry(J1, { rev: 4, wait: { class: "lt_1d", censored: true } })
  const settled = entry(J1, { rev: 4, wait: { class: "lt_1d", censored: false } })
  const forward = collectOutcomes([session([censored]), session([settled])]).get(J1)
  const backward = collectOutcomes([session([settled]), session([censored])]).get(J1)
  assert.deepEqual(forward, backward)
  const same = collectOutcomes([session([censored]), session([structuredClone(censored)])]).get(J1)
  assert.deepEqual(same, censored)
})

test("a job with no outcome entry reads not recorded, not unsigned", () => {
  for (const missing of [undefined, null]) {
    const result = signoffFormula(missing)
    assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reasons: ["not_recorded"], reason: "not_recorded" })
    assert.equal(result.value, null)
  }
})

test("a legacy done job reads delivered, sign-off not recorded", () => {
  const result = signoffFormula(entry(J1, { state: "not_recorded", deliveries: 0 }))
  assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reasons: ["signoff_not_recorded"], reason: "signoff_not_recorded" })
})

test("a recorded sign-off is a declared, measured result that carries its verification, reason and wait", () => {
  const wait = { class: "lt_1d", censored: false }
  assert.deepEqual(signoffFormula(entry(J1, { state: "accepted", verified: true, wait })), {
    class: "declared", value: "accepted", verified: true, reason: null, wait, state: "measured", reasons: [],
  })
  assert.deepEqual(signoffFormula(entry(J1, { state: "refused", verified: false, reason: "defect", wait: null })), {
    class: "declared", value: "refused", verified: false, reason: "defect", wait: null, state: "measured", reasons: [],
  })
})

test("a store whose sessions carry no outcomes says not recorded and never counts zero accepted", () => {
  for (const sessions of [[], [session(undefined), session(undefined)]]) {
    const rollups = computeOutcomeRollups({ sessions, reports: withRecord(J1, J2) })
    assert.equal(rollups.schema, "desk.factory.rollups/1")
    assert.deepEqual(rollups.signoff, { recorded: false })
    assert.equal(Object.hasOwn(rollups.signoff, "accepted"), false)
  }
})

test("a store that records outcomes counts every state, and every acceptance counts whatever its verified flag", () => {
  const sessions = [
    session([
      entry(J1, { state: "accepted", verified: true, wait: { class: "lt_1d", censored: false } }),
      entry(J2, { state: "accepted", verified: false, wait: { class: "lt_1h", censored: false } }),
      entry(J3, { state: "accepted", verified: null }),
    ]),
    session([
      entry(J4, { state: "not_recorded", deliveries: 0 }),
      entry("5".repeat(32), { state: "reopened" }),
      entry("6".repeat(32), { state: "not_delivered", deliveries: 0 }),
    ]),
  ]
  const { signoff } = computeOutcomeRollups({ sessions, reports: withRecord(J1, J2, J3, J4, "5".repeat(32), "6".repeat(32)) })
  assert.equal(signoff.recorded, true)
  assert.equal(signoff.jobs, 6)
  assert.equal(signoff.accepted, 3)
  assert.equal(signoff.accepted_unverified, 0)
  assert.equal(signoff.not_recorded, 1)
  assert.equal(signoff.reopened, 1)
  assert.equal(signoff.not_delivered, 1)
  assert.equal(signoff.delivered_unsigned, 0)
  assert.equal(signoff.refused, 0)
  assert.equal(signoff.refused_unverified, 0)
  assert.equal(signoff.no_record, 0)
  assert.equal(signoff.jobs_without_work_record, 0)
})

test("a censored wait is counted under unsigned waits with its class, and a signed wait under signed waits", () => {
  const sessions = [session([
    entry(J1, { state: "delivered_unsigned", wait: { class: "lt_7d", censored: true } }),
    entry(J2, { state: "delivered_unsigned", wait: { class: "lt_7d", censored: true } }),
    entry(J3, { state: "delivered_unsigned", wait: null }),
    entry(J4, { state: "accepted", verified: true, wait: { class: "ge_7d", censored: false } }),
    entry("5".repeat(32), { state: "refused", reason: "defect", wait: { class: "lt_1h", censored: false } }),
  ])]
  const { signoff } = computeOutcomeRollups({ sessions, reports: withRecord(J1, J2, J3, J4, "5".repeat(32)) })
  assert.equal(signoff.delivered_unsigned, 3)
  assert.deepEqual(signoff.waits, {
    signed: { lt_1h: 1, lt_1d: 0, lt_7d: 0, ge_7d: 1 },
    unsigned: { lt_1h: 0, lt_1d: 0, lt_7d: 2, ge_7d: 0 },
  })
})

test("refusal reasons are counted by code whatever the verified flag, and refused_unverified stays 0", () => {
  const sessions = [session([
    entry(J1, { state: "refused", verified: true, reason: "defect" }),
    entry(J2, { state: "refused", verified: false, reason: "defect" }),
    entry(J3, { state: "refused", verified: null, reason: "changed_ask" }),
    entry(J4, { state: "accepted", verified: true }),
  ])]
  const { signoff } = computeOutcomeRollups({ sessions, reports: withRecord(J1, J2, J3, J4) })
  assert.equal(signoff.refused, 3)
  assert.equal(signoff.refused_unverified, 0)
  assert.deepEqual(signoff.refusal_reasons, { not_what_was_asked: 0, defect: 2, changed_ask: 1, incomplete: 0, other: 0 })
})

test("an outcome with no work record is counted and listed apart, and so is a work record with no outcome", () => {
  const sessions = [session([entry(J1, { state: "accepted", verified: true }), entry(J2, { state: "delivered_unsigned" })])]
  const { signoff } = computeOutcomeRollups({ sessions, reports: withRecord(J1, J3, J4) })
  assert.equal(signoff.jobs, 2)
  assert.equal(signoff.jobs_without_work_record, 1)
  assert.equal(signoff.no_record, 2)
})

test("a session that carries an empty outcomes list makes the counts real zeros", () => {
  const { signoff } = computeOutcomeRollups({ sessions: [session([])], reports: withRecord(J1) })
  assert.equal(signoff.recorded, true)
  assert.equal(signoff.accepted, 0)
  assert.equal(signoff.jobs, 0)
  assert.equal(signoff.no_record, 1)
})

// --- first-pass verdict and rework per job (task F5) ---------------------------

const ret = (extra = {}) => ({ reason: "agent_error", caught: "at_review", counts: true, refusal: null, refusal_verified: null, ...extra })
const created = (extra = {}) => entry(J1, { since: "created", returns: [], ...extra })
const verdict = (result) => ({ state: result.state, value: result.value, reasons: result.reasons })

test("a job accepted and verified with no return is 1 and measured", () => {
  const result = firstPassFormula(created({ state: "accepted", verified: true }))
  assert.deepEqual(result, { class: "declared", state: "measured", value: 1, reasons: [], returns: { counting: 0, changed_ask: 0 }, changed_ask_only: false })
})

test("a job with a return at review for agent_error is 0", () => {
  const result = firstPassFormula(created({ state: "accepted", verified: true, returns: [ret()] }))
  assert.deepEqual(verdict(result), { state: "measured", value: 0, reasons: [] })
  assert.deepEqual(result.returns, { counting: 1, changed_ask: 0 })
  assert.equal(result.changed_ask_only, false)
})

test("a job whose only return is changed_ask is 1 and flagged changed_ask_only", () => {
  const result = firstPassFormula(created({ state: "accepted", verified: true, returns: [ret({ reason: "changed_ask", counts: false })] }))
  assert.deepEqual(verdict(result), { state: "measured", value: 1, reasons: [] })
  assert.deepEqual(result.returns, { counting: 0, changed_ask: 1 })
  assert.equal(result.changed_ask_only, true)
  // A witnessed human changed_ask decides, whatever the agent declared.
  const human = firstPassFormula(created({ state: "accepted", verified: true, returns: [ret({ reason: "agent_error", counts: false, refusal: "changed_ask", refusal_verified: true })] }))
  assert.equal(human.changed_ask_only, true)
  // An unwitnessed human reason does not decide: the agent's does.
  const unwitnessed = firstPassFormula(created({ state: "accepted", verified: true, returns: [ret({ reason: "agent_error", counts: true, refusal: "changed_ask", refusal_verified: false })] }))
  assert.deepEqual(verdict(unwitnessed), { state: "measured", value: 0, reasons: [] })
  assert.equal(unwitnessed.changed_ask_only, false)
})

test("a refused job is 0 unless the human's reason is changed_ask", () => {
  const defect = firstPassFormula(created({ state: "refused", verified: true, reason: "defect", returns: [ret({ caught: "after_delivery", refusal: "defect", refusal_verified: true })] }))
  assert.deepEqual(verdict(defect), { state: "measured", value: 0, reasons: [] })
  const changed = firstPassFormula(created({ state: "refused", verified: true, reason: "changed_ask", returns: [ret({ caught: "after_delivery", counts: false, refusal: "changed_ask", refusal_verified: true })] }))
  assert.deepEqual(verdict(changed), { state: "partial", value: 1, reasons: ["awaiting_signoff"] })
  assert.equal(changed.changed_ask_only, true)
})

test("the pipeline reads the counts flag and never recomputes it from the reasons", () => {
  assert.equal(firstPassFormula(created({ state: "accepted", verified: true, returns: [ret({ reason: "changed_ask", counts: true })] })).value, 0)
  assert.equal(firstPassFormula(created({ state: "accepted", verified: true, returns: [ret({ reason: "agent_error", counts: false })] })).value, 1)
})

test("an unsigned job with no return is 1 and partial as awaiting_signoff", () => {
  assert.deepEqual(verdict(firstPassFormula(created({ state: "delivered_unsigned" }))), { state: "partial", value: 1, reasons: ["awaiting_signoff"] })
})

test("an acceptance is 1 and measured whatever its verified flag, or none", () => {
  for (const verified of [true, false, null, undefined]) {
    assert.deepEqual(verdict(firstPassFormula(created({ state: "accepted", verified }))), { state: "measured", value: 1, reasons: [] })
  }
})

test("a job never delivered is unavailable as not_delivered", () => {
  const result = firstPassFormula(created({ state: "not_delivered", deliveries: 0 }))
  assert.deepEqual(result, { class: "unavailable", state: "unavailable", value: null, reasons: ["not_delivered"], reason: "not_delivered" })
  assert.equal(result.value, null)
  // A card that says delivered but holds a delivery count above 0 yet is not delivered now is still not a verdict.
  assert.equal(firstPassFormula(created({ state: "not_delivered", deliveries: 1 })).reason, "not_delivered")
})

test("a job whose record was adopted is unavailable as history_not_recorded, even with a return", () => {
  for (const since of ["adopted", null]) {
    assert.equal(firstPassFormula(entry(J1, { since, state: "refused", returns: [ret()] })).reason, "history_not_recorded")
  }
  assert.equal(firstPassFormula(entry(J1, { state: "accepted", verified: true })).reason, "history_not_recorded")
  assert.equal(firstPassFormula(entry(J1, { since: "adopted", deliveries: 0 })).reason, "history_not_recorded")
  // A created record that lists no returns has no history, which is not zero returns.
  assert.equal(firstPassFormula(entry(J1, { since: "created", state: "accepted", verified: true })).reason, "history_not_recorded")
})

test("a job with no outcome entry is unavailable as not_recorded", () => {
  for (const missing of [undefined, null]) assert.equal(firstPassFormula(missing).reason, "not_recorded")
  assert.equal(firstPassFormula(created({ state: "not_recorded" })).reason, "not_recorded")
})

test("returns that are not fully recorded give no verdict unless a counting return is among those that are", () => {
  for (const damage of [{ returns_unreadable: 2 }, { returns_truncated: true }]) {
    assert.equal(firstPassFormula(created({ state: "accepted", verified: true, ...damage })).reason, "returns_not_fully_recorded")
    assert.equal(firstPassFormula(created({ state: "accepted", verified: true, returns: [ret({ counts: false, reason: "changed_ask" })], ...damage })).reason, "returns_not_fully_recorded")
    assert.deepEqual(verdict(firstPassFormula(created({ state: "accepted", verified: true, returns: [ret()], ...damage }))), { state: "measured", value: 0, reasons: [] })
  }
})

test("a reopened job is a verdict only once it has been delivered again", () => {
  assert.deepEqual(verdict(firstPassFormula(created({ state: "reopened", deliveries: 2, returns: [ret({ counts: false, reason: "changed_ask" })] }))), { state: "partial", value: 1, reasons: ["awaiting_signoff"] })
  assert.equal(firstPassFormula(created({ state: "reopened", deliveries: 1, returns: [ret({ counts: false, reason: "changed_ask" })] })).reason, "not_delivered")
  assert.equal(firstPassFormula(created({ state: "reopened", deliveries: 1, returns: [ret({ caught: "after_delivery" })] })).value, 0)
})

test("rework counts returns by catch point and compares reasons only on refusals", () => {
  const returns = [
    ret({ caught: "in_task", reason: "new_information" }),
    ret({ caught: "at_review", refusal: null }),
    ret({ caught: "after_delivery", reason: "agent_error", refusal: "defect", refusal_verified: true }),
    ret({ caught: "after_delivery", reason: "agent_error", refusal: "changed_ask", refusal_verified: false }),
    ret({ caught: "after_delivery", reason: "changed_ask", refusal: "changed_ask", refusal_verified: true, counts: false }),
    ret({ caught: "after_delivery", reason: "external", refusal: "not_what_was_asked", refusal_verified: null }),
    ret({ caught: "after_delivery", reason: "agent_error", refusal: "other", refusal_verified: true }),
  ]
  assert.deepEqual(reworkFormula(created({ state: "refused", returns })), {
    class: "declared",
    state: "measured",
    value: { in_task: 1, at_review: 1, after_delivery: 5 },
    reasons: [],
    reason_check: { compared: 4, disagree: 2, compared_verified: 4 },
  })
})

test("rework is zero only when the history is recorded, and partial or unavailable when it is not", () => {
  assert.deepEqual(reworkFormula(created()).value, { in_task: 0, at_review: 0, after_delivery: 0 })
  assert.deepEqual(reworkFormula(created()).reason_check, { compared: 0, disagree: 0, compared_verified: 0 })
  assert.equal(reworkFormula(null).reason, "not_recorded")
  const flowless = reworkFormula(entry(J1, { state: "accepted" }))
  assert.deepEqual(flowless, { class: "unavailable", state: "unavailable", value: null, reasons: ["history_not_recorded"], reason: "history_not_recorded" })
  const damaged = reworkFormula(created({ returns: [ret()], returns_unreadable: 1 }))
  assert.deepEqual(verdict(damaged), { state: "partial", value: { in_task: 0, at_review: 1, after_delivery: 0 }, reasons: ["returns_not_fully_recorded"] })
  assert.equal(reworkFormula(created({ returns_truncated: true })).state, "partial")
})

// --- first-pass yield, returns and the reason check across jobs (task F6) -------

const J5 = "5".repeat(32)
const J6 = "6".repeat(32)
const store = (...entries) => computeOutcomeRollups({ sessions: [session(entries)], reports: withRecord(...entries.map((item) => item.job)) })
const accepted = (job, extra = {}) => created({ job, state: "accepted", verified: true, ...extra })

test("yield is passed over the delivered jobs that have a verdict", () => {
  const { first_pass_yield: result } = store(
    accepted(J1),
    accepted(J2, { returns: [ret()] }),
    accepted(J3, { since: "adopted" }),
    created({ job: J4, state: "not_delivered", deliveries: 0 }),
  )
  assert.deepEqual(result, {
    state: "measured", value: 0.5, reasons: [], n: 1, N: 2, passed: 1, returned: 1, awaiting_signoff: 0, changed_ask_only: 0,
    excluded: [{ reason: "history_not_recorded", jobs: 1 }, { reason: "not_delivered", jobs: 1 }],
  })
})

test("yield is partial and an upper bound while any counted job awaits sign-off", () => {
  const { first_pass_yield: result } = store(
    created({ job: J1, state: "delivered_unsigned" }),
    accepted(J2, { verified: false }),
    accepted(J3),
    accepted(J4, { returns: [ret()] }),
  )
  assert.equal(result.state, "partial")
  assert.equal(result.value, 0.75)
  assert.deepEqual(result.reasons, ["awaiting_signoff"])
  assert.deepEqual([result.n, result.N, result.passed, result.returned, result.awaiting_signoff], [3, 4, 3, 1, 1])
})

test("yield is unavailable as no_delivered_jobs when none has a verdict, not zero", () => {
  for (const { first_pass_yield: result } of [
    store(accepted(J1, { since: "adopted" }), created({ job: J2, state: "not_delivered", deliveries: 0 })),
    computeOutcomeRollups({ sessions: [], reports: [] }),
  ]) {
    assert.equal(result.state, "unavailable")
    assert.deepEqual(result.reasons, ["no_delivered_jobs"])
    assert.equal(Object.hasOwn(result, "value"), false)
    assert.deepEqual([result.n, result.N], [0, 0])
  }
})

test("excluded jobs are listed by reason and are not in N, and a work record with no outcome is one of them", () => {
  const { first_pass_yield: result } = computeOutcomeRollups({
    sessions: [session([accepted(J1), accepted(J2, { since: "adopted" }), accepted(J3, { returns_unreadable: 1 })])],
    reports: withRecord(J1, J2, J3, J4),
  })
  assert.equal(result.N, 1)
  assert.deepEqual(result.excluded, [{ reason: "history_not_recorded", jobs: 1 }, { reason: "not_recorded", jobs: 1 }, { reason: "returns_not_fully_recorded", jobs: 1 }])
})

test("changed-ask returns are counted apart and do not lower the yield", () => {
  const changed = ret({ reason: "changed_ask", counts: false })
  const { first_pass_yield: result, rework } = store(accepted(J1, { returns: [changed] }), accepted(J2, { returns: [changed, ret()] }), accepted(J3))
  assert.equal(result.value, 2 / 3)
  assert.equal(result.changed_ask_only, 1)
  assert.equal(result.returned, 1)
  assert.equal(rework.changed_ask, 2)
})

test("returns are counted by catch point and reason", () => {
  const { rework } = store(
    accepted(J1, { returns: [ret({ caught: "in_task", reason: "new_information" }), ret({ caught: "at_review" })] }),
    accepted(J2, { returns: [ret({ caught: "after_delivery", reason: "external" }), ret({ caught: "after_delivery" })] }),
  )
  assert.equal(rework.state, "measured")
  assert.deepEqual([rework.n, rework.N], [2, 2])
  assert.deepEqual(rework.returns, {
    in_task: { agent_error: 0, changed_ask: 0, new_information: 1, external: 0 },
    at_review: { agent_error: 1, changed_ask: 0, new_information: 0, external: 0 },
    after_delivery: { agent_error: 1, changed_ask: 0, new_information: 0, external: 1 },
  })
})

test("the reason check counts compared and disagreeing refusals and is unavailable with none", () => {
  const refusal = (human, agent, verified) => ret({ caught: "after_delivery", reason: agent, refusal: human, refusal_verified: verified })
  const { rework } = store(
    accepted(J1, { returns: [refusal("defect", "agent_error", true), refusal("defect", "external", true), refusal("other", "agent_error", true), ret()] }),
    accepted(J2, { returns: [refusal("changed_ask", "agent_error", false)] }),
  )
  assert.deepEqual(rework.reason_check, { state: "measured", compared: 3, disagree: 2, compared_verified: 3, reasons: [] })
  const none = store(accepted(J1, { returns: [ret()] })).rework
  assert.deepEqual(none.reason_check, { state: "unavailable", reasons: ["no_refusals"] })
})

test("a store with no returns recorded anywhere says not recorded, not 100 percent", () => {
  const result = store(
    entry(J1, { state: "accepted", verified: true }),
    entry(J2, { state: "accepted", verified: true, since: "adopted" }),
  )
  assert.equal(result.first_pass_yield.state, "unavailable")
  assert.equal(Object.hasOwn(result.first_pass_yield, "value"), false)
  assert.deepEqual(result.rework, {
    state: "unavailable",
    reasons: ["history_not_recorded"],
    n: 0,
    N: 2,
    reason_check: { state: "unavailable", reasons: ["not_recorded"] },
    defects: { state: "unavailable", reasons: ["no_finished_jobs"], n: 0, N: 0 },
  })
  assert.deepEqual(computeOutcomeRollups({ sessions: [], reports: [] }).rework.reasons, ["not_recorded"])
})

test("rework is partial while some jobs have no recorded history or only part of it", () => {
  const { rework } = store(
    accepted(J1, { returns: [ret()] }),
    entry(J2, { state: "accepted", verified: true }),
    accepted(J3, { returns: [ret({ caught: "in_task" })], returns_unreadable: 1 }),
  )
  assert.equal(rework.state, "partial")
  assert.deepEqual(rework.reasons, ["history_not_recorded", "returns_not_fully_recorded"])
  assert.deepEqual([rework.n, rework.N], [2, 3])
  assert.equal(rework.returns.at_review.agent_error, 1)
  assert.equal(rework.returns.in_task.agent_error, 1)
})

test("the outcome rollups carry no key beyond the contract, and defects is the only addition to rework", () => {
  const result = store(accepted(J1))
  assert.deepEqual(Object.keys(result), ["schema", "signoff", "first_pass_yield", "rework", "attention", "groupings"])
  assert.deepEqual(Object.keys(result.rework).sort(), ["N", "changed_ask", "defects", "n", "reason_check", "reasons", "returns", "state"])
  assert.deepEqual(Object.keys(result.rework.defects), ["state", "reasons", "n", "N"])
})

test("a refusal's recorded reason decides whatever its verified flag, old shape or new", () => {
  const refusal = (human, agent, verified, counts) => ret({ caught: "after_delivery", reason: agent, refusal: human, refusal_verified: verified, counts })
  const cases = [
    // [return, per-job changed_ask, changed_ask_only, per-job yield]
    ...[true, false, null, undefined].flatMap((verified) => [
      [refusal("changed_ask", "agent_error", verified, false), 1, true, 1],
      [refusal("defect", "changed_ask", verified, true), 0, false, 0],
    ]),
  ]
  for (const [item, changedAsk, only, value] of cases) {
    const result = firstPassFormula(created({ state: "accepted", verified: true, returns: [item] }))
    assert.equal(result.returns.changed_ask, changedAsk, JSON.stringify(item))
    assert.equal(result.changed_ask_only, only, JSON.stringify(item))
    assert.equal(result.value, value, JSON.stringify(item))
    const { rework, first_pass_yield: rollup } = store(accepted(J1, { returns: [item] }))
    assert.equal(rework.changed_ask, changedAsk, JSON.stringify(item))
    assert.equal(rollup.changed_ask_only, only ? 1 : 0, JSON.stringify(item))
  }
})

// --- defect time by catch point (task F7) ---------------------------------------------

const record = (job, { finished = true, active = 1000, sessions = ["s1"], excluded = null } = {}) => ({
  job,
  finished,
  sessions,
  muda_sessions: excluded === null && finished ? sessions.map((key) => ({ key: `claude-code/${key}`, totals: {} })) : null,
  measures: {
    active_time: active === null ? { excluded: "unavailable" } : { value: active },
    muda_time: excluded === null ? (finished ? { value: 0 } : { excluded: "open_job" }) : { excluded },
  },
})
const stretchOf = (start, end, waste, caught) => ({ start_ms: start, end_ms: end, class: waste === null ? "value" : "muda", waste, ...(caught === undefined ? {} : { caught }) })
const labelsFor = (...files) => ({ byJobSession: new Map(files.map(([job, session, ...stretches]) => [`${job}/${session}`, { stretches }])) })
const defectsOf = (records, labels, jobs = records.map((item) => item.job)) => computeOutcomeRollups({ sessions: [], reports: withRecord(...jobs), records, labels }).rework.defects

test("defect time is split by catch point over active time, with unstamped time as not placed", () => {
  const result = defectsOf(
    [record(J1, { active: 10000 }), record(J2, { active: 5000, sessions: ["s2", "s3"] })],
    labelsFor(
      [J1, "s1", stretchOf(0, 1000, "defects", "in_task"), stretchOf(1000, 3000, "defects", "at_review"), stretchOf(3000, 4000, "waiting"), stretchOf(4000, 4500, "defects", "after_delivery")],
      [J2, "s2", stretchOf(0, 200, "defects")],
      [J2, "s3", stretchOf(0, 300, "defects", "in_task")],
    ),
  )
  assert.deepEqual(result, {
    state: "partial",
    reasons: ["catch_point_not_recorded"],
    n: 2,
    N: 2,
    active_ms: 15000,
    in_task_ms: 1300,
    at_review_ms: 2000,
    after_delivery_ms: 500,
    not_placed_ms: 200,
  })
})

test("defect time is measured when every defects stretch is placed, and a labeled job with none counts zero defect time", () => {
  const result = defectsOf([record(J1, { active: 4000 }), record(J2, { active: 6000 })], labelsFor([J1, "s1", stretchOf(0, 700, "defects", "in_task")], [J2, "s1", stretchOf(0, 900, "motion")]))
  assert.deepEqual(result, { state: "measured", reasons: [], n: 2, N: 2, active_ms: 10000, in_task_ms: 700, at_review_ms: 0, after_delivery_ms: 0, not_placed_ms: 0 })
})

test("a store with no labels reads no data, not zero rework", () => {
  const none = defectsOf([record(J1, { excluded: "not_labeled" }), record(J2, { excluded: "not_labeled" })], labelsFor())
  assert.deepEqual(none, { state: "unavailable", reasons: ["no_labels"], n: 0, N: 2 })
  assert.equal(Object.hasOwn(none, "in_task_ms"), false)
  assert.equal(Object.hasOwn(none, "active_ms"), false)
  // Open jobs are not eligible, so they are not in N and do not count as unlabeled.
  assert.deepEqual(defectsOf([record(J1, { finished: false }), record(J2, { excluded: "not_labeled" })], labelsFor()), { state: "unavailable", reasons: ["no_labels"], n: 0, N: 1 })
  assert.deepEqual(computeOutcomeRollups({ sessions: [], reports: [] }).rework.defects, { state: "unavailable", reasons: ["no_finished_jobs"], n: 0, N: 0 })
  assert.deepEqual(defectsOf([record(J1, { finished: false })], labelsFor()), { state: "unavailable", reasons: ["no_finished_jobs"], n: 0, N: 0 })
})

test("only finished jobs whose sessions are all labeled are counted, and the rest are said to be left out", () => {
  const result = defectsOf(
    [record(J1, { active: 1000 }), record(J2, { excluded: "partial", active: 9000 }), record(J3, { finished: false }), record(J4, { active: null })],
    labelsFor([J1, "s1", stretchOf(0, 100, "defects", "at_review")], [J2, "s1", stretchOf(0, 800, "defects", "in_task")], [J4, "s1", stretchOf(0, 50, "defects", "in_task")]),
  )
  assert.deepEqual(result, {
    state: "partial",
    reasons: ["active_time_unavailable", "not_all_labeled"],
    n: 1,
    N: 3,
    active_ms: 1000,
    in_task_ms: 0,
    at_review_ms: 100,
    after_delivery_ms: 0,
    not_placed_ms: 0,
  })
  const onlyPartial = defectsOf([record(J2, { excluded: "partial" })], labelsFor([J2, "s1", stretchOf(0, 800, "defects", "in_task")]))
  assert.deepEqual(onlyPartial, { state: "unavailable", reasons: ["not_all_labeled"], n: 0, N: 1 })
  const noTime = defectsOf([record(J4, { active: null })], labelsFor([J4, "s1", stretchOf(0, 50, "defects", "in_task")]))
  assert.deepEqual(noTime, { state: "unavailable", reasons: ["active_time_unavailable"], n: 0, N: 1 })
})

test("the defects figure is present, and unavailable as no_finished_jobs, when the caller gives no records or labels", () => {
  const { rework } = computeOutcomeRollups({ sessions: [], reports: [] })
  assert.deepEqual(Object.keys(rework.defects), ["state", "reasons", "n", "N"])
  assert.equal(rework.state, "unavailable")
})

// --- the headline and its companions (task E8) ---------------------------------

// A human turn that the estimator reads as 3000 ms: a 3-second window bounds a short prompt after no reply.
const EST = 3000
const turn = (at_ms, extra = {}) => ({ at_ms, basis: "after_stop", window_ms: 3000, prompt_class: "xs", output_class: "none", ...extra })
const segment = (start_ms, end_ms) => ({ start_ms, end_ms })
const binding = (job, segments) => ({ job, basis: ["desk_tool"], session_offset_ms: 0, transitions: [], observed: null, ...(segments === undefined ? {} : { agents: [0], segments }) })
let sessionCount = 0
// A published session reduced to what the rollups read.
const pub = ({ turns, jobs = [], unavailable = [], version = "1.0.0", outcomes, intervals = [], host = "claude-code" }) => {
  sessionCount += 1
  return {
    session: { host, id: `${String(sessionCount).padStart(8, "0")}-1111-4111-8111-111111111111` },
    plugins: version === null ? [] : [].concat(version).map((each) => ({ name: "desk", version: each })),
    jobs: jobs.map(([job, segments]) => binding(job, segments)),
    unavailable,
    intervals,
    ...(outcomes === undefined ? {} : { outcomes }),
    ...(turns === undefined ? {} : { human_turns: turns }),
  }
}
const flag = (reason, field = "human_turns") => ({ field, reason })
const acceptedEntry = (job, extra = {}) => entry(job, { state: "accepted", verified: true, ...extra })
const rollupsOf = (sessions, jobs, records = []) => computeOutcomeRollups({ sessions, reports: withRecord(...jobs), records })

test("the headline is all estimated attention in the period over accepted outcomes", () => {
  const sessions = [
    pub({ turns: [turn(1000), turn(2000), turn(3000)], jobs: [[J1, [segment(0, 10_000)]]], outcomes: [acceptedEntry(J1), acceptedEntry(J2)] }),
    pub({ turns: [turn(500)], jobs: [[J2, [segment(0, 10_000)]]] }),
  ]
  const { attention } = rollupsOf(sessions, [J1, J2])
  assert.deepEqual(attention.headline, { state: "measured", value: (4 * EST) / 2, reasons: [], n: 2, N: 2, numerator_ms: 4 * EST, accepted_outcomes: 2 })
  assert.equal(attention.human_turns, 4)
  assert.deepEqual(attention.sessions, { in_period: 2, complete: 2 })
})

test("attention on refused, unsigned and undelivered work stays in the numerator", () => {
  const outcomes = [
    acceptedEntry(J1),
    entry(J2, { state: "refused", verified: true, reason: "defect" }),
    entry(J3, { state: "delivered_unsigned" }),
    entry(J4, { state: "not_delivered", deliveries: 0 }),
  ]
  const sessions = [pub({ turns: [turn(1000), turn(11_000), turn(21_000), turn(31_000)], jobs: [[J1, [segment(0, 10_000)]], [J2, [segment(10_000, 20_000)]], [J3, [segment(20_000, 30_000)]], [J4, [segment(30_000, 40_000)]]], outcomes })]
  const { attention } = rollupsOf(sessions, [J1, J2, J3, J4])
  assert.equal(attention.headline.numerator_ms, 4 * EST)
  assert.equal(attention.headline.value, 4 * EST)
  assert.equal(attention.headline.accepted_outcomes, 1)
})

test("unattributed and unplaced attention stays in the numerator", () => {
  const sessions = [
    pub({ turns: [turn(1000), turn(50_000)], jobs: [[J1, [segment(0, 10_000)]]], outcomes: [acceptedEntry(J1)] }),
    pub({ turns: [turn(0), turn(1000)], jobs: [[J2, undefined]] }),
    pub({ turns: [turn(0)] }),
  ]
  const { attention } = rollupsOf(sessions, [J1, J2])
  assert.deepEqual(attention.est_ms, { attributed: EST, unattributed: 2 * EST, unplaced: 2 * EST })
  assert.equal(attention.human_turns, 5)
  assert.equal(attention.headline.numerator_ms, 5 * EST)
  assert.equal(attention.headline.value, 5 * EST)
})

test("every acceptance enters the denominator, verified or not, and the headline and the sign-off count cannot disagree", () => {
  const variants = [
    [acceptedEntry(J1), acceptedEntry(J2, { verified: false }), acceptedEntry(J3, { verified: null })],
    [acceptedEntry(J1, { verified: false })],
    [acceptedEntry(J1), acceptedEntry(J2), entry(J3, { state: "refused", verified: true, reason: "defect" }), entry(J4, { state: "reopened" })],
  ]
  for (const outcomes of variants) {
    const sessions = [pub({ turns: [turn(0)], outcomes })]
    const result = rollupsOf(sessions, [J1, J2, J3, J4])
    assert.equal(result.attention.headline.accepted_outcomes, result.signoff.accepted)
    assert.equal(result.attention.headline.n, result.signoff.accepted)
    assert.equal(result.attention.headline.N, result.signoff.accepted)
    assert.equal(result.attention.turns_per_accepted.N, result.signoff.accepted)
    const grouped = Object.values(result.groupings.plugin_version).reduce((total, group) => total + group.signoff.accepted, 0)
    assert.equal(grouped, result.signoff.accepted)
  }
  const one = rollupsOf([pub({ turns: [turn(0), turn(1)], outcomes: [acceptedEntry(J1), acceptedEntry(J2, { verified: false })] })], [J1, J2])
  assert.equal(one.attention.headline.accepted_outcomes, 2)
  assert.equal(one.attention.headline.value, EST)
  const { verified: _dropped, ...noFlag } = acceptedEntry(J2)
  const mixed = rollupsOf([pub({ turns: [turn(0), turn(1), turn(2)], outcomes: [acceptedEntry(J1), acceptedEntry(J2, { verified: false }), noFlag, acceptedEntry(J4, { verified: null })] })], [J1, J2, J4])
  assert.equal(mixed.signoff.accepted, 3)
  assert.equal(mixed.attention.headline.value, EST)
  assert.equal(mixed.attention.turns_per_accepted.value, 1)
})

test("with no accepted outcome the headline is unavailable as no_accepted_outcomes and the numerator is still published", () => {
  const sessions = [pub({ turns: [turn(0), turn(1)], jobs: [[J1, [segment(0, 10_000)]]], outcomes: [entry(J1, { state: "delivered_unsigned" }), entry(J2, { state: "refused", verified: false, reason: "defect" })] })]
  const { attention } = rollupsOf(sessions, [J1, J2])
  assert.deepEqual(attention.headline, { state: "unavailable", reasons: ["no_accepted_outcomes"], n: 0, N: 0, numerator_ms: 2 * EST, accepted_outcomes: 0 })
  assert.equal(attention.est_ms.attributed, 2 * EST)
  assert.equal(Object.hasOwn(attention.headline, "value"), false)
  assert.equal(attention.human_turns, 2)
  assert.deepEqual(attention.turns_per_accepted, { state: "unavailable", reasons: ["no_accepted_outcomes"], n: 0, N: 0 })
  // A store with no outcomes at all reads the same way, never a zero.
  const none = rollupsOf([pub({ turns: [turn(0)] })], [J1]).attention.headline
  assert.equal(none.state, "unavailable")
  assert.deepEqual(none.reasons, ["no_accepted_outcomes"])
  assert.equal(Object.hasOwn(none, "value"), false)
})

test("sessions from before the record are outside the period and do not make the headline partial", () => {
  const sessions = [
    pub({ turns: [turn(0)], outcomes: [acceptedEntry(J1)] }),
    pub({ jobs: [[J1, [segment(0, 1000)]]] }),
    pub({}),
  ]
  const { attention } = rollupsOf(sessions, [J1])
  assert.equal(attention.headline.state, "measured")
  assert.deepEqual(attention.headline.reasons, [])
  assert.deepEqual(attention.sessions, { in_period: 1, complete: 1 })
  // No session in the period at all: the headline has no value and says why; it is not a zero.
  const empty = rollupsOf([pub({ outcomes: [acceptedEntry(J1)] })], [J1]).attention
  assert.deepEqual(empty.headline, { state: "unavailable", reasons: ["no_turn_records"], n: 1, N: 1, accepted_outcomes: 1 })
  assert.deepEqual(empty.turns_per_accepted, { state: "unavailable", reasons: ["no_turn_records"], n: 1, N: 1 })
  assert.deepEqual(empty.sessions, { in_period: 0, complete: 0 })
})

test("a session in the period that flags the field makes the headline partial, with the reason", () => {
  const accepted = [acceptedEntry(J1)]
  const clean = pub({ turns: [turn(0)], outcomes: accepted })
  const cases = [
    // Codex: no list, the host does not record turns.
    [pub({ unavailable: [flag("host_does_not_record")], host: "codex" }), ["host_does_not_record", "turns_not_recorded"]],
    // Copilot: a list that is kept, but not proven complete.
    [pub({ turns: [turn(0)], unavailable: [flag("host_records_partly")], host: "copilot" }), ["host_records_partly", "turns_not_recorded"]],
    [pub({ turns: [turn(0)], unavailable: [flag("capped")] }), ["turns_capped"]],
    [pub({ unavailable: [flag("field_absent")] }), ["field_absent", "turns_not_recorded"]],
    [pub({ turns: [turn(0)], unavailable: [flag("log_truncated")] }), ["log_truncated", "turns_not_recorded"]],
  ]
  for (const [flagged, reasons] of cases) {
    const { attention } = rollupsOf([clean, flagged], [J1])
    assert.equal(attention.headline.state, "partial", reasons.join())
    assert.deepEqual(attention.headline.reasons, reasons)
    assert.equal(typeof attention.headline.value, "number", "a lower bound still has its number")
    assert.deepEqual(attention.sessions, { in_period: 2, complete: 1 })
  }
  // Another field's flag does not put a session into the period.
  assert.equal(rollupsOf([clean, pub({ unavailable: [flag("host_does_not_record", "permission_waits")] })], [J1]).attention.sessions.in_period, 1)
})

test("human turns per accepted outcome uses the raw count and the same denominator", () => {
  const sessions = [pub({ turns: [turn(0), turn(1), turn(2), turn(3), turn(4)], outcomes: [acceptedEntry(J1), acceptedEntry(J2), acceptedEntry(J3, { verified: false })] })]
  const { attention } = rollupsOf(sessions, [J1, J2, J3])
  assert.deepEqual(attention.turns_per_accepted, { state: "measured", value: 5 / 3, reasons: [], n: 3, N: 3 })
  // The count is not affected by a turn the estimator cannot read, so that reason is not on it.
  const broken = rollupsOf([pub({ turns: [turn(0), turn(1, { prompt_class: "huge" })], outcomes: [acceptedEntry(J1)] })], [J1]).attention
  assert.deepEqual(broken.turns_per_accepted, { state: "measured", value: 2, reasons: [], n: 1, N: 1 })
  const flagged = rollupsOf([pub({ turns: [turn(0)], unavailable: [flag("capped")], outcomes: [acceptedEntry(J1)] })], [J1]).attention
  assert.deepEqual(flagged.turns_per_accepted, { state: "partial", value: 1, reasons: ["turns_capped"], n: 1, N: 1 })
})

test("permission decisions are reported beside the headline, measured where recorded and unavailable where not", () => {
  const wait = (start_ms, end_ms) => ({ kind: "permission_wait", agent: 0, start_ms, end_ms })
  const recorded = pub({ turns: [turn(0)], host: "copilot", intervals: [wait(0, 12_000), wait(20_000, 23_000), { kind: "tool", agent: 0, start_ms: 0, end_ms: 5 }], outcomes: [acceptedEntry(J1)] })
  const none = pub({ turns: [turn(0)], unavailable: [flag("host_does_not_record", "permission_waits")] })
  assert.deepEqual(rollupsOf([recorded], [J1]).attention.permission, { state: "measured", decisions: 2, est_ms: 5000 + 3000, reasons: [] })
  assert.deepEqual(rollupsOf([none], [J1]).attention.permission, { state: "unavailable", reasons: ["host_does_not_record"] })
  assert.deepEqual(rollupsOf([recorded, none], [J1]).attention.permission, { state: "partial", decisions: 2, est_ms: 8000, reasons: ["host_does_not_record"] })
  assert.deepEqual(rollupsOf([], [J1]).attention.permission, { state: "unavailable", reasons: ["no_sessions"] })
  // A recorded session with no decision is a real zero.
  assert.deepEqual(rollupsOf([pub({ turns: [turn(0)] })], [J1]).attention.permission, { state: "measured", decisions: 0, est_ms: 0, reasons: [] })
  // The permission estimate is not part of the headline.
  assert.equal(rollupsOf([recorded], [J1]).attention.headline.numerator_ms, EST)
  // A wait the estimator cannot read is counted and stated.
  const bad = pub({ turns: [turn(0)], intervals: [wait(10, 5)] })
  assert.deepEqual(rollupsOf([bad], [J1]).attention.permission, { state: "partial", decisions: 1, est_ms: 0, reasons: ["decision_not_estimable"] })
  const partlyRecorded = pub({ turns: [turn(0)], unavailable: [flag("capped", "permission_waits")], intervals: [wait(0, 1000)] })
  assert.deepEqual(rollupsOf([partlyRecorded], [J1]).attention.permission, { state: "partial", decisions: 1, est_ms: 1000, reasons: ["capped"] })
})

test("the method version and constants are in the file", () => {
  const { attention } = rollupsOf([], [])
  assert.deepEqual(attention.method, methodRecord())
  assert.equal(attention.method.version, 1)
  assert.deepEqual(Object.keys(attention), ["method", "headline", "turns_per_accepted", "sessions", "permission"], "with no list recorded anywhere there is no turn count and no placed time")
  const recorded = rollupsOf([pub({ turns: [turn(0)] })], [J1]).attention
  assert.deepEqual(Object.keys(recorded), ["method", "headline", "turns_per_accepted", "human_turns", "est_ms", "sessions", "permission"])
  assert.deepEqual(Object.keys(recorded.est_ms), ["attributed", "unattributed", "unplaced"])
  // Nothing in the file shares the method's tables.
  attention.method.read_ms.s = 1
  assert.equal(methodRecord().read_ms.s, 5000)
})

test("a turn the estimator rejects is counted and stated, and a programming error still stops the build", () => {
  const bad = turn(1000, { output_class: "SENTINEL-CLASS" })
  const partial = rollupsOf([pub({ turns: [turn(0), bad], jobs: [[J1, [segment(0, 10_000)]]], outcomes: [acceptedEntry(J1)] })], [J1]).attention
  assert.equal(partial.headline.state, "partial")
  assert.deepEqual(partial.headline.reasons, ["turn_not_estimable"])
  assert.equal(partial.headline.numerator_ms, EST)
  assert.equal(partial.human_turns, 2)
  assert.deepEqual(partial.sessions, { in_period: 1, complete: 0 })
  assert.ok(!JSON.stringify(partial).includes("SENTINEL"))
  // Every turn broken: there is no number to give, and it is not zero.
  const all = rollupsOf([pub({ turns: [bad], outcomes: [acceptedEntry(J1)] })], [J1]).attention
  assert.deepEqual(all.headline, { state: "unavailable", reasons: ["turn_not_estimable"], n: 1, N: 1, accepted_outcomes: 1 })
  assert.equal(all.human_turns, 1, "the count of turns is known even when their time is not")
  assert.equal(Object.hasOwn(all, "est_ms"), false, "no estimable turn feeds the placed time, so it is left out, not given as zeros")
  assert.deepEqual(Object.keys(all), ["method", "headline", "turns_per_accepted", "human_turns", "sessions", "permission"])
  // Some turns estimated and some not: the time is given, and the headline says it is partial.
  assert.deepEqual(partial.est_ms, { attributed: EST, unattributed: 0, unplaced: 0 })
  const defect = { at_ms: 0, basis: "after_stop", window_ms: 3000, prompt_class: "xs", get output_class() { throw new TypeError("a defect in the code") } }
  assert.throws(() => rollupsOf([pub({ turns: [defect], outcomes: [acceptedEntry(J1)] })], [J1]), TypeError)
})

test("each plugin version group's attention and outcomes add up to the overall figures, mixed included", () => {
  const records = [{ job: J1, plugin_version: "1.0.0" }, { job: J2, plugin_version: "2.0.0" }, { job: J3, plugin_version: "mixed" }, { job: J4, plugin_version: "2.0.0" }]
  const sessions = [
    pub({ version: "1.0.0", turns: [turn(0), turn(20_000)], jobs: [[J1, [segment(0, 10_000)]]], outcomes: [acceptedEntry(J1), acceptedEntry(J4, { verified: false })] }),
    pub({ version: "2.0.0", turns: [turn(0), turn(1000), turn(30_000)], jobs: [[J2, [segment(0, 10_000)]], [J4, [segment(10_000, 20_000)]]], outcomes: [acceptedEntry(J2), entry(J4, { rev: 2, state: "accepted", verified: true })] }),
    pub({ version: ["1.0.0", "2.0.0"], turns: [turn(0)], jobs: [[J3, undefined]], outcomes: [acceptedEntry(J3)] }),
    pub({ version: null, turns: [turn(0)], unavailable: [flag("capped")] }),
    pub({ version: "2.0.0", unavailable: [flag("host_does_not_record")], host: "codex", jobs: [[J2, undefined]] }),
  ]
  const result = rollupsOf(sessions, [J1, J2, J3, J4], records)
  const groups = result.groupings.plugin_version
  assert.deepEqual(Object.keys(groups).sort(), ["1.0.0", "2.0.0", "mixed", "unknown"])
  const sum = (pick) => Object.values(groups).reduce((total, group) => total + (pick(group) ?? 0), 0)
  const { attention, signoff, first_pass_yield: yieldRollup } = result
  assert.equal(sum((group) => group.attention.headline.numerator_ms), attention.headline.numerator_ms)
  assert.equal(sum((group) => group.attention.headline.accepted_outcomes), attention.headline.accepted_outcomes)
  assert.equal(sum((group) => group.attention.human_turns), attention.human_turns)
  for (const part of ["attributed", "unattributed", "unplaced"]) assert.equal(sum((group) => group.attention.est_ms?.[part]), attention.est_ms[part], part)
  for (const key of ["jobs", "accepted", "accepted_unverified", "delivered_unsigned", "refused", "reopened", "not_recorded", "not_delivered", "no_record", "jobs_without_work_record"]) {
    assert.equal(sum((group) => group.signoff[key]), signoff[key], key)
  }
  for (const key of ["n", "N", "passed", "returned"]) assert.equal(sum((group) => group.first_pass_yield[key]), yieldRollup[key], key)
  // A job's attributed attention goes to the job's group; unattributed attention goes to its session's version.
  assert.equal(groups["1.0.0"].attention.est_ms.attributed, EST)
  assert.equal(groups["1.0.0"].attention.est_ms.unattributed, EST)
  assert.equal(groups.mixed.attention.est_ms.unplaced, EST)
  assert.equal(groups.unknown.attention.est_ms.unattributed, EST)
  assert.equal(groups["2.0.0"].attention.est_ms.attributed, 2 * EST)
  assert.equal(groups["2.0.0"].attention.headline.accepted_outcomes, 2)
  // A group's own state says what it knows.
  assert.equal(groups["1.0.0"].attention.headline.state, "measured")
  assert.equal(groups["2.0.0"].attention.headline.state, "partial")
  assert.ok(groups["2.0.0"].attention.headline.reasons.includes("host_does_not_record"))
  assert.equal(groups.unknown.attention.headline.state, "unavailable")
  assert.deepEqual(groups.unknown.attention.headline.reasons, ["no_accepted_outcomes", "turns_capped"])
  assert.deepEqual(Object.keys(groups["1.0.0"]), ["signoff", "first_pass_yield", "attention"])
  assert.deepEqual(Object.keys(groups["1.0.0"].attention), ["headline", "turns_per_accepted", "human_turns", "est_ms"])
  // A group with no list has no turn count and no placed time, not zeros.
  assert.equal(Object.hasOwn(groups.unknown.attention, "human_turns"), true)
  assert.deepEqual(Object.keys(result.groupings), ["plugin_version"])
})

test("a session's version is the one the job rollups use for a job of that one session", () => {
  const cases = [["1.2.3", "1.2.3"], [null, "unknown"]]
  for (const [version, expected] of cases) assert.equal(sessionVersion(pub({ version })), expected)
  const two = { ...pub({}), plugins: [{ name: "desk", version: "1.0.0" }, { name: "desk", version: "2.0.0" }, { name: "other", version: "9.9.9" }] }
  assert.equal(sessionVersion(two), "mixed")
  assert.equal(sessionVersion({ ...pub({}), plugins: [{ name: "other", version: "9.9.9" }] }), "unknown")
})

test("a period of sessions that keep no list gives no number: the figures are unavailable with the host's reason, never zero", () => {
  const codex = pub({ unavailable: [flag("host_does_not_record")], host: "codex", outcomes: [acceptedEntry(J1)] })
  const { attention } = rollupsOf([codex], [J1])
  assert.deepEqual(attention.headline, { state: "unavailable", reasons: ["host_does_not_record", "turns_not_recorded"], n: 1, N: 1, accepted_outcomes: 1 })
  assert.deepEqual(attention.turns_per_accepted, { state: "unavailable", reasons: ["host_does_not_record", "turns_not_recorded"], n: 1, N: 1 })
  assert.deepEqual(attention.sessions, { in_period: 1, complete: 0 })
  // Beside a session that does keep a list, the same host makes the number a lower bound.
  const beside = rollupsOf([codex, pub({ turns: [turn(0)] })], [J1]).attention
  assert.equal(beside.headline.state, "partial")
  assert.equal(beside.headline.value, EST)
})

test("with no list recorded the headline gives no numerator and no turn count, and says why beside no_accepted_outcomes", () => {
  const codex = pub({ unavailable: [flag("host_does_not_record")], host: "codex" })
  const { attention } = rollupsOf([codex], [J1])
  assert.deepEqual(attention.headline, { state: "unavailable", reasons: ["host_does_not_record", "no_accepted_outcomes", "turns_not_recorded"], n: 0, N: 0, accepted_outcomes: 0 })
  assert.equal(Object.hasOwn(attention.headline, "numerator_ms"), false)
  assert.equal(Object.hasOwn(attention, "human_turns"), false)
  assert.equal(Object.hasOwn(attention, "est_ms"), false)
  assert.deepEqual(attention.turns_per_accepted, { state: "unavailable", reasons: ["host_does_not_record", "no_accepted_outcomes", "turns_not_recorded"], n: 0, N: 0 })
  // No session in the period at all.
  const none = rollupsOf([pub({})], [J1]).attention
  assert.deepEqual(none.headline, { state: "unavailable", reasons: ["no_accepted_outcomes", "no_turn_records"], n: 0, N: 0, accepted_outcomes: 0 })
  assert.equal(Object.hasOwn(none, "human_turns"), false)
  // A group with no list says the same.
  const group = rollupsOf([codex], [J1], [{ job: J1, plugin_version: "1.0.0" }]).groupings.plugin_version
  for (const figures of Object.values(group)) {
    assert.equal(Object.hasOwn(figures.attention, "human_turns"), false)
    assert.equal(Object.hasOwn(figures.attention.headline, "numerator_ms"), false)
  }
})

test("a partial numerator keeps its reasons beside no_accepted_outcomes", () => {
  const { attention } = rollupsOf([pub({ turns: [turn(0)], unavailable: [flag("capped")] })], [J1])
  assert.deepEqual(attention.headline, { state: "unavailable", reasons: ["no_accepted_outcomes", "turns_capped"], n: 0, N: 0, numerator_ms: EST, accepted_outcomes: 0 })
  assert.deepEqual(attention.turns_per_accepted, { state: "unavailable", reasons: ["no_accepted_outcomes", "turns_capped"], n: 0, N: 0 })
  const broken = rollupsOf([pub({ turns: [turn(0), turn(1, { prompt_class: "huge" })] })], [J1]).attention
  assert.deepEqual(broken.headline.reasons, ["no_accepted_outcomes", "turn_not_estimable"])
  assert.equal(broken.headline.numerator_ms, EST)
})

// Real old-format records: the facts of the golden stores, read as the build reads them.
const FIXTURE_FACTS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "rollup-store", "facts")
const oldRecord = (name, host) => {
  const value = JSON.parse(readFileSync(path.join(FIXTURE_FACTS, name), "utf8"))
  return { ...value, session: { ...value.session, host } }
}

test("a session from an old-format file is outside the period, for Copilot and for Codex, and does not make the headline partial", () => {
  const copilot = normalizePublished(oldRecord("copilot-cli-10000000-0000-4000-8000-000000000002.json", "copilot-cli"))
  const codex = normalizePublished(oldRecord("copilot-cli-10000000-0000-4000-8000-000000000002.json", "codex-cli"))
  assert.ok(String(copilot.schema).endsWith("/1"), "a real old-format record")
  for (const old of [copilot, codex]) {
    assert.equal(old.unavailable.some((entry) => entry.field === "human_turns"), false, "reading an old file adds no flag for a field it never had")
    const { attention } = rollupsOf([pub({ turns: [turn(0)], outcomes: [acceptedEntry(J1)] }), old], [J1])
    assert.equal(attention.headline.state, "measured")
    assert.deepEqual(attention.sessions, { in_period: 1, complete: 1 })
  }
  // A current-format file that flags the field is in the period.
  const flagged = { ...copilot, unavailable: [...copilot.unavailable, flag("host_records_partly")] }
  assert.equal(rollupsOf([flagged], [J1]).attention.sessions.in_period, 1)
})
