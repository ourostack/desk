import { test } from "node:test"
import { strict as assert } from "node:assert"

import {
  SIGNOFF_STATES,
  OUTCOME_STATES,
  REFUSAL_REASONS,
  RETURN_REASONS,
  CATCH_POINTS,
  WAIT_CLASSES,
  SIGNOFF_ALARM_DAYS,
  waitClass,
  readRecord,
  recordFromLines,
  toFrontmatter,
  deliver,
  sign,
  outcomeState,
  outcomeSnapshot,
  MAIN_LINE,
  STATUSES,
  needsReturnReason,
  catchPoint,
  formatReturn,
  parseReturn,
  move,
  refuse,
  returnCounts,
  reasonsAgree,
} from "../../../../../plugins/desk/mcp/src/factory/outcome.js"

const T1 = "2026-10-06T11:00:00.000Z"
const T2 = "2026-10-07T09:00:00.000Z"
const T3 = "2026-10-08T09:00:00.000Z"
const EMPTY = { signoff: null, flow: null, returns: [], returns_damaged: 0 }
const frozen = (value) => JSON.parse(JSON.stringify(value))

const fullData = () => ({
  signoff: { state: "refused", at: T2, verified: true, reason: "defect" },
  flow: {
    since: "created",
    rev: 5,
    reached: "processing",
    first_validating_at: "2026-10-06T10:00:00.000Z",
    first_delivered_at: T1,
    delivered_at: T1,
    deliveries: 1,
  },
  returns: [
    "2026-10-06T10:30:00.000Z validating processing agent_error at_review",
    "2026-10-07T09:00:00.000Z done processing agent_error after_delivery refused=defect verified",
  ],
})

const REFUSED = { state: "refused", at: T2, verified: true, reason: "defect" }
const legacyRefused = () => sign(EMPTY, { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", verified: true, at: T2 }).record
const delivered = (extra = {}) => deliver({ ...EMPTY, ...extra }, { at: T1 })
const codeOf = (fn) => {
  try {
    fn()
  } catch (error) {
    return error.code
  }
  return null
}

test("the lists are closed and in the plan's order", () => {
  assert.deepEqual(SIGNOFF_STATES, ["delivered_unsigned", "accepted", "refused"])
  assert.deepEqual(OUTCOME_STATES, ["not_delivered", "not_recorded", "delivered_unsigned", "accepted", "refused", "reopened"])
  assert.deepEqual(REFUSAL_REASONS, ["not_what_was_asked", "defect", "changed_ask", "incomplete", "other"])
  assert.deepEqual(RETURN_REASONS, ["agent_error", "changed_ask", "new_information", "external"])
  assert.deepEqual(CATCH_POINTS, ["in_task", "at_review", "after_delivery"])
  assert.deepEqual(WAIT_CLASSES, ["lt_1h", "lt_1d", "lt_7d", "ge_7d"])
  assert.equal(SIGNOFF_ALARM_DAYS, 7)
})

test("waitClass puts each edge in the higher class and refuses a negative wait", () => {
  assert.equal(waitClass(0), "lt_1h")
  assert.equal(waitClass(3_599_999), "lt_1h")
  assert.equal(waitClass(3_600_000), "lt_1d")
  assert.equal(waitClass(86_399_999), "lt_1d")
  assert.equal(waitClass(86_400_000), "lt_7d")
  assert.equal(waitClass(604_799_999), "lt_7d")
  assert.equal(waitClass(604_800_000), "ge_7d")
  assert.throws(() => waitClass(-1), RangeError)
  assert.throws(() => waitClass(Number.NaN), RangeError)
  assert.throws(() => waitClass(Infinity), RangeError)
  assert.throws(() => waitClass("5"), RangeError)
})

test("readRecord reads a full record and reads a malformed signoff as absent", () => {
  assert.deepEqual(readRecord(fullData()), { ...fullData(), returns_damaged: 0 })
  assert.deepEqual(readRecord({ signoff: { state: "approved", at: T2, verified: true, reason: null } }).signoff, null)
  assert.deepEqual(readRecord({ signoff: "accepted" }).signoff, null)
  assert.deepEqual(readRecord({ signoff: ["accepted"] }).signoff, null)
  assert.deepEqual(readRecord({}), EMPTY)
  assert.deepEqual(readRecord(null), EMPTY)
  assert.deepEqual(readRecord(undefined), EMPTY)
})

test("readRecord reads a malformed part as null, never as a guess", () => {
  const signoff = readRecord({ signoff: { state: "accepted", at: "yesterday", verified: "yes", reason: "nonsense" } }).signoff
  assert.deepEqual(signoff, { state: "accepted", at: null, reason: null })
  assert.equal(readRecord({ signoff: { state: "accepted", verified: 1 } }).signoff.verified, undefined)
  assert.equal(readRecord({ signoff: { state: "accepted", verified: false } }).signoff.verified, false)
  assert.equal(readRecord({ signoff: { state: "accepted", verified: "true" } }).signoff.verified, undefined)
  const flow = readRecord({
    flow: { since: "born", rev: -1, reached: "sleeping", first_validating_at: 7, first_delivered_at: "", delivered_at: {}, deliveries: 1.5 },
  }).flow
  assert.deepEqual(flow, {
    since: null,
    rev: null,
    reached: null,
    first_validating_at: null,
    first_delivered_at: null,
    delivered_at: null,
    deliveries: null,
  })
  assert.equal(readRecord({ flow: { rev: "5" } }).flow.rev, null)
  assert.equal(readRecord({ flow: { rev: 2.5 } }).flow.rev, null)
  assert.equal(readRecord({ flow: { rev: 0 } }).flow.rev, 0)
  assert.equal(readRecord({ flow: "created" }).flow, null)
  assert.equal(readRecord({ flow: [] }).flow, null)
  assert.deepEqual(readRecord({ returns: "one line" }).returns, [])
  assert.deepEqual(readRecord({ returns: ["a b", 3, null, "", "c d"] }).returns, ["a b", "c d"])
})

test("readRecord reads a Date a YAML reader produced as its ISO string", () => {
  const read = readRecord({ signoff: { state: "accepted", at: new Date(T2), verified: true } })
  assert.equal(read.signoff.at, T2)
  assert.equal(readRecord({ signoff: { state: "accepted", at: new Date("nope") } }).signoff.at, null)
})

test("recordFromLines reads block and flow frontmatter to the same record", () => {
  const block = [
    "title: Fix login",
    "signoff:",
    "  state: refused",
    `  at: ${T2}`,
    "  verified: true",
    "  reason: defect",
    "flow:",
    "  since: created",
    "  rev: 5",
    "  reached: processing",
    `  first_validating_at: ${fullData().flow.first_validating_at}`,
    `  first_delivered_at: ${T1}`,
    `  delivered_at: "${T1}"`,
    "  deliveries: 1",
    "returns:",
    `  - "${fullData().returns[0]}"`,
    `  - '${fullData().returns[1]}'`,
    "status: processing",
  ]
  const flow = [
    "title: Fix login",
    `signoff: { state: refused, at: ${T2}, verified: true, reason: defect }`,
    `flow: { since: created, rev: 5, reached: processing, first_validating_at: ${fullData().flow.first_validating_at}, first_delivered_at: ${T1}, delivered_at: ${T1}, deliveries: 1 }`,
    `returns: ["${fullData().returns[0]}", "${fullData().returns[1]}"]`,
  ]
  assert.deepEqual(recordFromLines(block), { ...fullData(), returns_damaged: 0 })
  assert.deepEqual(recordFromLines(flow), { ...fullData(), returns_damaged: 0 })
})

test("recordFromLines reads null, empty, comment and unindented-list forms", () => {
  const lines = [
    "signoff:",
    "  # a comment",
    "",
    "  state: delivered_unsigned",
    "  at: null",
    "  verified: ~",
    "  reason:",
    "returns:",
    `- "${fullData().returns[0]}"`,
    "- ",
    "flow: {}",
  ]
  const read = recordFromLines(lines)
  assert.deepEqual(read.signoff, { state: "delivered_unsigned", at: null, reason: null })
  assert.deepEqual(read.returns, [fullData().returns[0]])
  assert.equal(read.flow.rev, null)
  assert.deepEqual(recordFromLines(["returns: []"]).returns, [])
  assert.deepEqual(recordFromLines(["returns:"]).returns, [])
  assert.deepEqual(recordFromLines(["signoff: { state: accepted, verified: false }"]).signoff.verified, false)
  assert.deepEqual(recordFromLines(["flow: { rev: 3, since: adopted, note: \"a, b: c\" }"]).flow.rev, 3)
  assert.deepEqual(recordFromLines(["returns: [\"a, b\", 'c d', e f]"]).returns, ["a, b", "c d", "e f"])
  assert.deepEqual(recordFromLines(["title: x"]), EMPTY)
  assert.deepEqual(recordFromLines([]), EMPTY)
  assert.deepEqual(recordFromLines(undefined), EMPTY)
})

test("recordFromLines reads the first copy of a key, as the card reader does, and ignores a malformed shape", () => {
  const twice = ["signoff: { state: accepted, verified: true }", "signoff: { state: refused, verified: false }"]
  assert.equal(recordFromLines(twice).signoff.state, "accepted")
  assert.equal(recordFromLines(["signoff: accepted"]).signoff, null)
  assert.equal(recordFromLines(["signoff: { state: accepted"]).signoff, null)
  assert.deepEqual(recordFromLines(["returns: one line"]).returns, [])
  assert.equal(recordFromLines(["flow:", "  rev: 4", "    deeper: 1", "  since: created"]).flow.rev, 4)
  assert.equal(recordFromLines(["flow:", "  nonsense line", "  rev: 4"]).flow.rev, 4)
})

test("toFrontmatter writes only the keys that exist and round-trips through readRecord", () => {
  assert.deepEqual(toFrontmatter(EMPTY), {})
  assert.deepEqual(toFrontmatter({}), {})
  assert.deepEqual(toFrontmatter(readRecord(fullData())), fullData())
  assert.deepEqual(Object.keys(toFrontmatter(readRecord(fullData()))), ["signoff", "flow", "returns"])
  const onlyFlow = { signoff: null, flow: readRecord(fullData()).flow, returns: [] }
  assert.deepEqual(Object.keys(toFrontmatter(onlyFlow)), ["flow"])
  const done = delivered()
  assert.deepEqual(readRecord(toFrontmatter(done)), { ...done, returns_damaged: 0 })
  const out = toFrontmatter(done)
  out.flow.rev = 99
  assert.equal(done.flow.rev, 1)
})

test("deliver marks the card delivered_unsigned, counts the delivery and raises rev", () => {
  const before = { ...readRecord(fullData()), signoff: null }
  const snapshot = frozen(before)
  const after = deliver(before, { at: T3 })
  assert.deepEqual(before, snapshot)
  assert.deepEqual(after.signoff, { state: "delivered_unsigned", at: null, reason: null })
  assert.equal(after.flow.delivered_at, T3)
  assert.equal(after.flow.first_delivered_at, T1)
  assert.equal(after.flow.deliveries, 2)
  assert.equal(after.flow.reached, "done")
  assert.equal(after.flow.rev, 6)
  assert.equal(after.flow.since, "created")
  assert.deepEqual(after.returns, before.returns)
})

test("deliver on a card with no flow starts one as adopted", () => {
  const after = delivered()
  assert.deepEqual(after.flow, {
    since: "adopted",
    rev: 1,
    reached: "done",
    first_validating_at: T1,
    first_delivered_at: T1,
    delivered_at: T1,
    deliveries: 1,
  })
  assert.deepEqual(deliver(null, { at: T1 }), after)
  const noRev = deliver({ signoff: null, flow: readRecord({ flow: { since: "created" } }).flow, returns: [] }, { at: T1 })
  assert.equal(noRev.flow.rev, 1)
  assert.equal(noRev.flow.deliveries, 1)
})

test("a second delivery keeps first_delivered_at and resets signoff", () => {
  const first = delivered()
  const signed = sign(first, { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", verified: true, at: T2 }).record
  assert.equal(signed.signoff.state, "refused")
  const second = deliver(signed, { at: T3 })
  assert.equal(second.flow.first_delivered_at, T1)
  assert.equal(second.flow.delivered_at, T3)
  assert.equal(second.flow.deliveries, 2)
  assert.deepEqual(second.signoff, { state: "delivered_unsigned", at: null, reason: null })
})

test("deliver refuses a time that is not an ISO time", () => {
  assert.equal(codeOf(() => deliver(EMPTY, { at: "soon" })), "invalid_time")
  assert.equal(codeOf(() => deliver(EMPTY, { at: undefined })), "invalid_time")
  assert.equal(codeOf(() => deliver(EMPTY, { at: new Date(T1) })), null)
})

test("sign refuses a card that is not done", () => {
  for (const status of ["processing", "drafting", undefined]) {
    assert.equal(codeOf(() => sign(delivered(), { status, outcome: "accepted", verified: true, at: T2 })), "not_delivered")
  }
})

test("sign refuses a refusal without a reason and an acceptance with one", () => {
  const base = { status: "done", verified: true, at: T2 }
  const record = delivered()
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "refused", returnReason: "agent_error" })), "reason_required")
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "refused", reason: "defect" })), "return_reason_required")
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "accepted", reason: "defect" })), "reason_not_allowed")
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "accepted", returnReason: "agent_error" })), "reason_not_allowed")
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "accepted", reason: null, returnReason: null })), null)
})

test("sign refuses an unknown outcome and an unknown reason", () => {
  const base = { status: "done", verified: true, at: T2 }
  const record = delivered()
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "approved" })), "unknown_outcome")
  assert.equal(codeOf(() => sign(record, { ...base, outcome: undefined })), "unknown_outcome")
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "refused", reason: "meh", returnReason: "agent_error" })), "unknown_reason")
  assert.equal(codeOf(() => sign(record, { ...base, outcome: "refused", reason: "defect", returnReason: "meh" })), "unknown_return_reason")
})

test("sign writes the acceptance or the refusal, raises rev and never mutates its input", () => {
  const record = delivered()
  const snapshot = frozen(record)
  const accepted = sign(record, { status: "done", outcome: "accepted", verified: true, at: T2 })
  assert.deepEqual(record, snapshot)
  assert.equal(accepted.changed, true)
  assert.deepEqual(accepted.record.signoff, { state: "accepted", at: T2, reason: null })
  assert.equal(accepted.record.flow.rev, 2)
  const refused = sign(record, { status: "done", outcome: "refused", reason: "incomplete", returnReason: "agent_error", verified: false, at: T2 })
  assert.deepEqual(refused.record.signoff, { state: "refused", at: T2, reason: "incomplete" })
  assert.deepEqual(refused.record.returns, [])
})

test("sign on a done card with no record adopts a flow and records the sign-off", () => {
  const result = sign(EMPTY, { status: "done", outcome: "accepted", verified: true, at: T2 })
  assert.equal(result.changed, true)
  assert.equal(result.record.flow.since, "adopted")
  assert.equal(result.record.flow.rev, 1)
  assert.equal(result.record.flow.deliveries, 1)
  assert.equal(result.record.flow.delivered_at, null)
  assert.equal(result.record.flow.first_delivered_at, null)
  assert.equal(result.record.signoff.state, "accepted")
  assert.equal(outcomeState(result.record, "done"), "accepted")
})

test("sign ignores a verified argument and writes no verified flag", () => {
  const result = sign(delivered(), { status: "done", outcome: "accepted", verified: true, at: T2 })
  assert.equal(Object.hasOwn(result.record.signoff, "verified"), false)
})

test("sign over a legacy card that carries verified replaces it by outcome alone", () => {
  const legacy = { ...delivered(), signoff: { state: "accepted", at: T2, verified: false, reason: null } }
  assert.equal(sign(legacy, { status: "done", outcome: "accepted", at: T3 }).changed, false)
  const other = sign(legacy, { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", at: T3 })
  assert.equal(other.changed, true)
  assert.deepEqual(other.record.signoff, { state: "refused", at: T3, reason: "defect" })
})

test("a different outcome at the same evidence replaces the record", () => {
  const accepted = sign(delivered(), { status: "done", outcome: "accepted", verified: true, at: T2 }).record
  const refused = sign(accepted, { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", verified: true, at: T3 })
  assert.equal(refused.changed, true)
  assert.equal(refused.record.signoff.state, "refused")
  assert.equal(refused.record.flow.rev, 3)
})

test("repeating the same sign changes nothing", () => {
  const first = sign(delivered(), { status: "done", outcome: "accepted", at: T2 }).record
  const again = sign(first, { status: "done", outcome: "accepted", at: T3 })
  assert.equal(again.changed, false)
  assert.deepEqual(again.record, first)
})

test("repeating a refusal with other reasons changes nothing and does not raise rev", () => {
  const first = sign(delivered(), { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", at: T2 }).record
  const again = sign(first, { status: "done", outcome: "refused", reason: "other", returnReason: "external", at: T3 })
  assert.equal(again.changed, false)
  assert.equal(again.record.flow.rev, first.flow.rev)
})

test("a delivered_unsigned record is replaced by any sign-off", () => {
  const unsigned = delivered()
  assert.equal(unsigned.signoff.state, "delivered_unsigned")
  assert.equal(sign(unsigned, { status: "done", outcome: "accepted", verified: false, at: T2 }).changed, true)
})

test("outcomeState reads a done card with no signoff as not_recorded, never unsigned and never accepted", () => {
  assert.equal(outcomeState(EMPTY, "done"), "not_recorded")
  assert.equal(outcomeState({ signoff: null, flow: readRecord(fullData()).flow, returns: [] }, "done"), "not_recorded")
  assert.equal(outcomeState(delivered(), "done"), "delivered_unsigned")
  const accepted = sign(delivered(), { status: "done", outcome: "accepted", verified: true, at: T2 }).record
  assert.equal(outcomeState(accepted, "done"), "accepted")
  assert.equal(outcomeState(null, "done"), "not_recorded")
})

test("outcomeState tells refused from reopened by the signoff the card carries", () => {
  const refusedCard = { ...readRecord(fullData()) }
  assert.equal(outcomeState(refusedCard, "processing"), "refused")
  assert.equal(outcomeState({ ...refusedCard, signoff: null }, "processing"), "reopened")
  assert.equal(outcomeState({ ...refusedCard, signoff: { state: "accepted", at: T2, verified: true, reason: null } }, "paused"), "reopened")
  assert.equal(outcomeState(EMPTY, "processing"), "not_delivered")
  assert.equal(outcomeState(readRecord({ flow: { deliveries: 0 } }), "validating"), "not_delivered")
  assert.equal(outcomeState(null, "drafting"), "not_delivered")
  for (const state of OUTCOME_STATES) assert.ok(OUTCOME_STATES.includes(state))
})

test("outcomeSnapshot of a card with no record has rev 0 and takes delivered_at from the evidence time", () => {
  assert.deepEqual(outcomeSnapshot(EMPTY, { status: "done", now: T3, evidenceAt: T1 }), {
    rev: 0,
    state: "not_recorded",
    verified: null,
    reason: null,
    deliveries: 0,
    delivered_at: T1,
    signed_at: null,
    observed_at: T3,
    since: null,
    first_validating_at: null,
    first_delivered_at: null,
    returns: [],
    returns_unreadable: 0,
  })
})

test("outcomeSnapshot returns the times as the card holds them and does not invent a delivery", () => {
  const record = sign(delivered(), { status: "done", outcome: "accepted", verified: true, at: T2 }).record
  assert.deepEqual(outcomeSnapshot(record, { status: "done", now: T3, evidenceAt: "2020-01-01T00:00:00.000Z" }), {
    rev: 2,
    state: "accepted",
    verified: null,
    reason: null,
    deliveries: 1,
    delivered_at: T1,
    signed_at: T2,
    observed_at: T3,
    since: "adopted",
    first_validating_at: T1,
    first_delivered_at: T1,
    returns: [],
    returns_unreadable: 0,
  })
  const never = outcomeSnapshot(EMPTY, { status: "processing", now: T3, evidenceAt: T1 })
  assert.equal(never.delivered_at, null)
  assert.equal(never.state, "not_delivered")
  const unsigned = outcomeSnapshot(delivered(), { status: "done", now: new Date(T3) })
  assert.equal(unsigned.state, "delivered_unsigned")
  assert.equal(unsigned.signed_at, null)
  assert.equal(unsigned.observed_at, T3)
  assert.equal(outcomeSnapshot(delivered(), { status: "done" }).observed_at, null)
  assert.equal(outcomeSnapshot(delivered(), { status: "done", now: 12 }).observed_at, new Date(12).toISOString())
  assert.equal(outcomeSnapshot(delivered(), { status: "done", now: {} }).observed_at, null)
  assert.equal(outcomeSnapshot(delivered(), { status: "done", now: T3 }).deliveries, 1)
  const refused = readRecord(fullData())
  const snap = outcomeSnapshot(refused, { status: "processing", now: T3 })
  assert.equal(snap.state, "refused")
  assert.equal(snap.reason, "defect")
  assert.equal(snap.verified, true)
  assert.equal(outcomeSnapshot(null, { status: "done" }).rev, 0)
})

test("outcomeSnapshot carries no text and no name: only codes, counts, booleans and times", () => {
  const SENTINEL = "SENTINEL-DO-NOT-LEAK"
  const record = readRecord({
    ...fullData(),
    returns: [`${T1} done processing agent_error after_delivery ${SENTINEL}`],
    signoff: { state: "accepted", at: T2, verified: true, reason: SENTINEL },
  })
  const snap = outcomeSnapshot(record, { status: "done", now: T3 })
  assert.equal(JSON.stringify(snap).includes(SENTINEL), false)
  assert.deepEqual(Object.keys(snap), [
    "rev",
    "state",
    "verified",
    "reason",
    "deliveries",
    "delivered_at",
    "signed_at",
    "observed_at",
    "since",
    "first_validating_at",
    "first_delivered_at",
    "returns",
    "returns_unreadable",
  ])
})

test("an unterminated flow list reads as no returns", () => {
  assert.deepEqual(recordFromLines(['returns: ["a b"']).returns, [])
})

test("sign on a flow whose rev is unreadable starts counting from zero", () => {
  const record = { signoff: null, flow: readRecord({ flow: { since: "created", deliveries: 1 } }).flow, returns: [] }
  const result = sign(record, { status: "done", outcome: "accepted", verified: true, at: T2 })
  assert.equal(result.record.flow.rev, 1)
  assert.equal(result.record.flow.since, "created")
})

test("a bad clock value reads as no observation, not a crash", () => {
  assert.equal(outcomeSnapshot(delivered(), { status: "done", now: Number.NaN }).observed_at, null)
  assert.equal(outcomeSnapshot(delivered(), { status: "done", now: Infinity }).observed_at, null)
})

test("a comment after a key or after a flow value does not hide the record", () => {
  const read = recordFromLines(["signoff: # the answer", "  state: accepted", "  verified: true", "flow: { rev: 4, since: created } # written by the tool"])
  assert.equal(read.signoff.state, "accepted")
  assert.equal(read.flow.rev, 4)
  assert.deepEqual(recordFromLines(['returns: ["a b"] # list']).returns, ["a b"])
})

// ---------------------------------------------------------------- Package F: returns

const V1 = "2026-10-06T10:00:00.000Z"
const R1 = "2026-10-06T10:30:00.000Z"
const flowAt = (reached, extra = {}) => ({
  signoff: null,
  flow: { since: "created", rev: 1, reached, first_validating_at: null, first_delivered_at: null, delivered_at: null, deliveries: 0, ...extra },
  returns: [],
})
const entry = (extra = {}) => ({ at: R1, from: "validating", to: "processing", reason: "agent_error", caught: "at_review", refusal: null, refusal_verified: null, ...extra })

test("the main line and the status list are the plan's", () => {
  assert.deepEqual(MAIN_LINE, { drafting: 0, processing: 1, validating: 2, done: 3 })
  assert.deepEqual(STATUSES, ["drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled"])
})

test("every from, to and reached triple says whether a reason is needed, with no pair left to a default", () => {
  const BELOW = { drafting: [], processing: ["drafting"], validating: ["drafting", "processing"], done: ["drafting", "processing", "validating"] }
  let checked = 0
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const reached of [undefined, null, "drafting", "processing", "validating", "done"]) {
        const held = reached ?? from
        const expected = from === "done" ? to !== "done" : from !== to && (BELOW[held] ?? []).includes(to)
        const label = `${from} -> ${to} reached ${reached}`
        assert.equal(needsReturnReason({ from, to, reached }), expected, label)
        const record = reached === undefined ? { signoff: null, flow: null, returns: [] } : flowAt(reached ?? "drafting")
        const base = reached === null ? { ...record, flow: { ...record.flow, reached: null } } : record
        assert.equal(codeOf(() => move(base, { from, to, at: R1 })), expected ? "return_reason_required" : null, label)
        assert.equal(codeOf(() => move(base, { from, to, at: R1, returnReason: "external" })), expected ? null : "return_reason_not_needed", label)
        checked += 1
      }
    }
  }
  assert.equal(checked, 8 * 8 * 6)
})

test("the plan's named moves", () => {
  assert.equal(needsReturnReason({ from: "validating", to: "processing", reached: "validating" }), true)
  assert.equal(needsReturnReason({ from: "done", to: "processing", reached: "done" }), true)
  assert.equal(needsReturnReason({ from: "processing", to: "drafting", reached: "processing" }), true)
  assert.equal(needsReturnReason({ from: "collaborating", to: "processing", reached: "validating" }), true)
  assert.equal(needsReturnReason({ from: "blocked", to: "validating", reached: "validating" }), false)
  assert.equal(needsReturnReason({ from: "done", to: "paused", reached: "done" }), true)
  assert.equal(needsReturnReason({ from: "paused", to: "processing", reached: "drafting" }), false)
  assert.equal(needsReturnReason({ from: "drafting", to: "done", reached: "drafting" }), false)
  assert.equal(needsReturnReason({ from: "validating", to: "cancelled", reached: "validating" }), false)
  assert.equal(needsReturnReason({ from: "done", to: "cancelled", reached: "done" }), true)
  assert.equal(needsReturnReason({ from: "validating", to: "validating", reached: "validating" }), false)
})

test("the catch point is where the work was when it went back", () => {
  assert.equal(catchPoint({ from: "done", reached: "done" }), "after_delivery")
  assert.equal(catchPoint({ from: "validating", reached: "validating" }), "at_review")
  assert.equal(catchPoint({ from: "collaborating", reached: "validating" }), "at_review")
  assert.equal(catchPoint({ from: "processing", reached: "processing" }), "in_task")
  assert.equal(catchPoint({ from: "paused", reached: "drafting" }), "in_task")
  assert.equal(catchPoint({ from: "paused", reached: null }), "in_task")
  for (const point of ["in_task", "at_review", "after_delivery"]) assert.ok(CATCH_POINTS.includes(point))
})

test("validating to processing needs a reason and is caught at review", () => {
  const record = flowAt("validating", { first_validating_at: V1 })
  assert.equal(codeOf(() => move(record, { from: "validating", to: "processing", at: R1 })), "return_reason_required")
  const next = move(record, { from: "validating", to: "processing", at: R1, returnReason: "agent_error" })
  assert.deepEqual(next.returns, [`${R1} validating processing agent_error at_review`])
  assert.equal(next.flow.reached, "processing")
  assert.equal(next.flow.rev, 2)
  assert.equal(next.flow.first_validating_at, V1)
})

test("done to processing needs a reason and is caught after delivery", () => {
  const next = move(delivered(), { from: "done", to: "processing", at: T2, returnReason: "changed_ask" })
  assert.deepEqual(next.returns, [`${T2} done processing changed_ask after_delivery`])
})

test("processing to drafting needs a reason and is caught in the task", () => {
  const next = move(flowAt("processing"), { from: "processing", to: "drafting", at: R1, returnReason: "new_information" })
  assert.deepEqual(next.returns, [`${R1} processing drafting new_information in_task`])
  assert.equal(next.flow.reached, "drafting")
})

test("validating to collaborating to processing needs a reason at the second move", () => {
  const record = flowAt("validating", { first_validating_at: V1 })
  const side = move(record, { from: "validating", to: "collaborating", at: R1 })
  assert.equal(side.flow.reached, "validating")
  assert.deepEqual(side.returns, [])
  assert.equal(codeOf(() => move(side, { from: "collaborating", to: "processing", at: T2 })), "return_reason_required")
  const back = move(side, { from: "collaborating", to: "processing", at: T2, returnReason: "external" })
  assert.deepEqual(back.returns, [`${T2} collaborating processing external at_review`])
})

test("validating to blocked to validating needs none", () => {
  const record = flowAt("validating", { first_validating_at: V1 })
  const blocked = move(record, { from: "validating", to: "blocked", at: R1 })
  const again = move(blocked, { from: "blocked", to: "validating", at: T2 })
  assert.deepEqual(again.returns, [])
  assert.equal(again.flow.reached, "validating")
})

test("done to paused needs a reason, and paused to processing afterwards needs none", () => {
  assert.equal(codeOf(() => move(delivered(), { from: "done", to: "paused", at: T2 })), "return_reason_required")
  const paused = move(delivered(), { from: "done", to: "paused", at: T2, returnReason: "external" })
  assert.equal(paused.returns.length, 1)
  assert.equal(paused.flow.reached, "drafting")
  const resumed = move(paused, { from: "paused", to: "processing", at: T3 })
  assert.equal(resumed.returns.length, 1)
  assert.equal(resumed.flow.reached, "processing")
})

test("a forward move never needs a reason, raises reached and sets first_validating_at once", () => {
  const start = flowAt("drafting", { rev: 0 })
  const processing = move(start, { from: "drafting", to: "processing", at: V1 })
  assert.equal(processing.flow.reached, "processing")
  assert.equal(processing.flow.first_validating_at, null)
  assert.equal(processing.flow.rev, 1)
  const validating = move(processing, { from: "processing", to: "validating", at: V1 })
  assert.equal(validating.flow.first_validating_at, V1)
  assert.equal(validating.flow.reached, "validating")
  const second = move(move(validating, { from: "validating", to: "blocked", at: R1 }), { from: "blocked", to: "validating", at: T2 })
  assert.equal(second.flow.first_validating_at, V1)
  assert.equal(codeOf(() => move(start, { from: "drafting", to: "validating", at: V1, returnReason: "external" })), "return_reason_not_needed")
})

test("a move into done delivers: signoff starts over, the delivery is counted and review is marked", () => {
  const next = move(flowAt("processing"), { from: "processing", to: "done", at: T1 })
  assert.equal(next.signoff.state, "delivered_unsigned")
  assert.equal(next.flow.deliveries, 1)
  assert.equal(next.flow.first_delivered_at, T1)
  assert.equal(next.flow.first_validating_at, T1)
  assert.equal(next.flow.reached, "done")
  assert.equal(next.flow.rev, 2)
})

test("a move that changes nothing returns the record unchanged and writes no new rev", () => {
  const record = flowAt("processing")
  assert.equal(move(record, { from: "processing", to: "processing", at: R1 }), record)
  assert.equal(move(record, { from: "processing", to: "paused", at: R1 }), record)
  assert.equal(codeOf(() => move(record, { from: "processing", to: "processing", at: R1, returnReason: "external" })), "return_reason_not_needed")
  assert.equal(codeOf(() => move(record, { from: "processing", to: "processing", at: "bad" })), null)
})

test("a move out of done removes signoff and keeps the return", () => {
  const signed = sign(delivered(), { status: "done", outcome: "accepted", verified: true, at: T2 }).record
  const next = move(signed, { from: "done", to: "processing", at: T3, returnReason: "changed_ask" })
  assert.equal(next.signoff, null)
  assert.equal(toFrontmatter(next).signoff, undefined)
  assert.equal(next.returns.length, 1)
  assert.equal(next.flow.deliveries, 1)
  assert.equal(next.flow.rev, 3)
  assert.equal(next.flow.first_delivered_at, T1)
})

test("a refused signoff is kept by a return that is not out of done", () => {
  const refused = { signoff: { state: "refused", at: T2, verified: true, reason: "defect" }, flow: { ...flowAt("processing").flow, deliveries: 1 }, returns: [] }
  const next = move(refused, { from: "processing", to: "drafting", at: T3, returnReason: "agent_error" })
  assert.equal(next.signoff.state, "refused")
})

test("a reason off the list is refused and the record is unchanged", () => {
  const record = flowAt("validating")
  const before = frozen(record)
  assert.equal(codeOf(() => move(record, { from: "validating", to: "processing", at: R1, returnReason: "because" })), "unknown_return_reason")
  assert.deepEqual(record, before)
})

test("a bad status or time throws and the input is never changed", () => {
  const record = flowAt("validating")
  const before = frozen(record)
  assert.equal(codeOf(() => move(record, { from: "nowhere", to: "processing", at: R1 })), "unknown_status")
  assert.equal(codeOf(() => move(record, { from: "validating", to: "nowhere", at: R1 })), "unknown_status")
  assert.equal(codeOf(() => move(record, { from: "validating", to: "processing", at: "yesterday", returnReason: "external" })), "invalid_time")
  assert.deepEqual(record, before)
  const ok = move(record, { from: "validating", to: "processing", at: R1, returnReason: "external" })
  assert.notEqual(ok, record)
  assert.deepEqual(record, before)
})

test("a card with no flow record adopts one and reads returns not recorded before that point", () => {
  const forward = move(EMPTY, { from: "processing", to: "validating", at: V1 })
  assert.equal(forward.flow.since, "adopted")
  assert.equal(forward.flow.first_validating_at, V1)
  assert.equal(forward.flow.reached, "validating")
  assert.equal(forward.flow.rev, 1)
  assert.equal(outcomeSnapshot(EMPTY, { status: "validating", now: T3 }).since, null)
  assert.deepEqual(outcomeSnapshot(EMPTY, { status: "validating", now: T3 }).returns, [])
  const back = move(EMPTY, { from: "validating", to: "processing", at: R1, returnReason: "agent_error" })
  assert.equal(back.flow.since, "adopted")
  assert.equal(back.flow.reached, "processing")
  assert.equal(back.returns.length, 1)
  const side = move(EMPTY, { from: "paused", to: "processing", at: R1 })
  assert.equal(side.flow.reached, "processing")
  const sideBack = move(EMPTY, { from: "paused", to: "blocked", at: R1 })
  assert.equal(sideBack.flow.reached, "drafting")
  const done = move(EMPTY, { from: "validating", to: "done", at: T1 })
  assert.equal(done.flow.since, "adopted")
  assert.equal(done.flow.deliveries, 1)
  assert.equal(snapshotOf(done).since, "adopted")
})

const snapshotOf = (record, status = "processing") => outcomeSnapshot(record, { status, now: T3 })

test("a flow with an unreadable reached falls back to the status the card is at", () => {
  const record = { signoff: null, flow: { ...flowAt("validating").flow, reached: null }, returns: [] }
  assert.equal(codeOf(() => move(record, { from: "validating", to: "processing", at: R1 })), "return_reason_required")
  assert.equal(move(record, { from: "paused", to: "validating", at: R1 }).flow.reached, "validating")
})

test("a return line round-trips through formatReturn and parseReturn, with and without a refusal", () => {
  const plain = entry()
  assert.equal(formatReturn(plain), `${R1} validating processing agent_error at_review`)
  assert.deepEqual(parseReturn(formatReturn(plain)), plain)
  const refused = entry({ from: "done", caught: "after_delivery", refusal: "defect", refusal_verified: null })
  assert.equal(formatReturn(refused), `${R1} done processing agent_error after_delivery refused=defect`)
  assert.deepEqual(parseReturn(formatReturn(refused)), refused)
  // A line written before Desk dropped the witness still reads, and writes back without the token.
  for (const [token, flag] of [["verified", true], ["unverified", false]]) {
    const legacy = parseReturn(`${R1} done processing agent_error after_delivery refused=defect ${token}`)
    assert.equal(legacy.refusal_verified, flag)
    assert.equal(formatReturn(legacy), `${R1} done processing agent_error after_delivery refused=defect`)
  }
  const card = fullData().returns.map((line) => line.replace(/ verified$/u, ""))
  assert.deepEqual(card.map((line) => formatReturn(parseReturn(line))), card)
})

test("formatReturn refuses an entry it could not read back", () => {
  assert.equal(codeOf(() => formatReturn(entry({ reason: "tired" }))), "invalid_return")
  assert.equal(codeOf(() => formatReturn(entry({ at: "soon" }))), "invalid_return")
  assert.equal(codeOf(() => formatReturn(entry({ refusal: "rude", refusal_verified: true }))), "invalid_return")
  assert.equal(codeOf(() => formatReturn(entry({ from: "a b" }))), "invalid_return")
  assert.equal(codeOf(() => formatReturn(null)), "invalid_return")
})

test("parseReturn reads a line in full or not at all", () => {
  const good = `${R1} validating processing agent_error at_review`
  assert.notEqual(parseReturn(good), null)
  const bad = [
    "",
    "   ",
    good + " ",
    " " + good,
    good.replace(" validating ", "  validating "),
    good.replace("agent_error", "tired"),
    good.replace("at_review", "later"),
    good.replace("validating", "reviewing"),
    good.replace("processing", "fixing"),
    good.replace(R1, "tomorrow"),
    good.replace(R1, "2026-13-45T99:00:00.000Z"),
    good + " extra",
    `${R1} validating processing agent_error`,
    good + " refused=defect",
    good + " refused=defect verified extra",
    good + " refused=rude verified",
    good + " refused=defect maybe",
    good + " refusal=defect verified",
    good + " refused= verified",
    good + " blocked=defect verified",
    null,
    undefined,
    42,
    {},
  ]
  for (const line of bad) assert.equal(parseReturn(line), null, String(line))
})

test("a changed_ask return does not count against yield", () => {
  assert.equal(returnCounts(entry({ reason: "changed_ask" }), V1), false)
  assert.equal(returnCounts(entry({ reason: "agent_error" }), V1), true)
  assert.equal(returnCounts(entry({ reason: "external" }), V1), true)
  assert.equal(returnCounts(entry({ reason: "new_information" }), V1), true)
})

test("a return before the first review does not count against yield", () => {
  assert.equal(returnCounts(entry({ at: V1 }), V1), true)
  assert.equal(returnCounts(entry({ at: "2026-10-06T10:00:01+00:00" }), "2026-10-06T10:00:00.000Z"), true)
  const early = entry({ at: "2026-10-06T09:59:59.000Z", from: "processing", to: "drafting", caught: "in_task" })
  assert.equal(returnCounts(early, V1), false)
  assert.equal(returnCounts({ ...early, at: V1 }, V1), true)
  assert.equal(returnCounts(early, null), false)
  assert.equal(returnCounts(early, "not a time"), false)
  assert.equal(returnCounts(entry(), null), true)
  assert.equal(returnCounts(entry({ at: "2026-10-06T09:59:59.000Z" }), V1), true)
  assert.equal(returnCounts(entry({ from: "done", caught: "after_delivery" }), null), true)
  assert.equal(returnCounts(entry({ reason: "changed_ask" }), null), false)
})

test("a refusal the human calls changed_ask does not count, whatever the agent declared", () => {
  assert.equal(returnCounts(entry({ reason: "agent_error", refusal: "changed_ask", refusal_verified: true }), V1), false)
  assert.equal(returnCounts(entry({ reason: "changed_ask", refusal: "defect", refusal_verified: true }), V1), true)
  assert.equal(returnCounts(entry({ reason: "changed_ask", refusal: "other", refusal_verified: true }), V1), true)
})

test("defect against agent_error agrees, defect against external disagrees, other is not compared", () => {
  assert.equal(reasonsAgree("defect", "agent_error"), true)
  assert.equal(reasonsAgree("not_what_was_asked", "agent_error"), true)
  assert.equal(reasonsAgree("incomplete", "agent_error"), true)
  assert.equal(reasonsAgree("defect", "external"), false)
  assert.equal(reasonsAgree("defect", "new_information"), false)
  assert.equal(reasonsAgree("defect", "changed_ask"), false)
  assert.equal(reasonsAgree("changed_ask", "changed_ask"), true)
  assert.equal(reasonsAgree("changed_ask", "agent_error"), false)
  assert.equal(reasonsAgree("changed_ask", "external"), false)
  assert.equal(reasonsAgree("other", "agent_error"), null)
  assert.equal(reasonsAgree("other", "external"), null)
  assert.equal(reasonsAgree("rude", "agent_error"), null)
  assert.equal(reasonsAgree("defect", "tired"), null)
  assert.equal(reasonsAgree(undefined, undefined), null)
  for (const human of REFUSAL_REASONS) for (const agent of RETURN_REASONS) assert.ok([true, false, null].includes(reasonsAgree(human, agent)))
})

test("refuse appends the return with both reasons, resets reached and keeps the refused signoff", () => {
  const signed = sign(delivered(), { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", verified: true, at: T2 }).record
  const before = frozen(signed)
  const next = refuse(signed, { at: T2, reason: "defect", returnReason: "agent_error", verified: true })
  assert.deepEqual(signed, before)
  assert.deepEqual(next.returns, [`${T2} done processing agent_error after_delivery refused=defect`])
  assert.equal(next.flow.reached, "processing")
  assert.equal(next.flow.rev, signed.flow.rev + 1)
  assert.deepEqual(next.signoff, signed.signoff)
  assert.equal(outcomeState(next, "processing"), "refused")
  assert.equal(refuse(signed, { at: T2, reason: "other", returnReason: "external", verified: false }).returns[0].endsWith("refused=other"), true)
  assert.equal(refuse(legacyRefused(), { at: T2, reason: "defect", returnReason: "agent_error", verified: true }).flow.since, "adopted")
})

test("refuse checks its inputs the way sign does and changes nothing when it throws", () => {
  const record = delivered()
  const before = frozen(record)
  const args = { at: T2, reason: "defect", returnReason: "agent_error", verified: true }
  assert.equal(codeOf(() => refuse(record, { ...args, reason: undefined })), "reason_required")
  assert.equal(codeOf(() => refuse(record, { ...args, reason: "rude" })), "unknown_reason")
  assert.equal(codeOf(() => refuse(record, { ...args, returnReason: undefined })), "return_reason_required")
  assert.equal(codeOf(() => refuse(record, { ...args, returnReason: "tired" })), "unknown_return_reason")
  assert.equal(codeOf(() => refuse(record, { ...args, at: "later" })), "invalid_time")
  assert.deepEqual(record, before)
})

test("outcomeSnapshot carries the record's start, the two milestones and each return as codes", () => {
  const record = readRecord(fullData())
  const snap = outcomeSnapshot(record, { status: "processing", now: T3 })
  assert.equal(snap.since, "created")
  assert.equal(snap.first_validating_at, "2026-10-06T10:00:00.000Z")
  assert.equal(snap.first_delivered_at, T1)
  assert.equal(snap.returns_unreadable, 0)
  assert.deepEqual(snap.returns, [
    { reason: "agent_error", caught: "at_review", counts: true, refusal: null, refusal_verified: null },
    { reason: "agent_error", caught: "after_delivery", counts: true, refusal: "defect", refusal_verified: true },
  ])
  for (const item of snap.returns) assert.deepEqual(Object.keys(item), ["reason", "caught", "counts", "refusal", "refusal_verified"])
})

test("outcomeSnapshot counts and skips a return line it cannot read, so a damaged card is not read as no returns", () => {
  const data = fullData()
  data.returns = [data.returns[0], "garbled line", `${R1} validating processing tired at_review`, data.returns[1]]
  const snap = outcomeSnapshot(readRecord(data), { status: "processing", now: T3 })
  assert.equal(snap.returns.length, 2)
  assert.equal(snap.returns_unreadable, 2)
})

test("a card with no flow has since null and no returns, and its returns are not read", () => {
  const record = { signoff: null, flow: null, returns: [`${R1} validating processing agent_error at_review`] }
  const snap = outcomeSnapshot(record, { status: "processing", now: T3 })
  assert.equal(snap.since, null)
  assert.deepEqual(snap.returns, [])
  assert.equal(snap.returns_unreadable, 0)
})

test("a return caught at review or after delivery counts whatever the first-review mark says, an in-task one needs the mark", () => {
  const data = fullData()
  data.flow.first_validating_at = null
  const counts = outcomeSnapshot(readRecord(data), { status: "processing", now: T3 }).returns.map((item) => item.counts)
  assert.deepEqual(counts, [true, true])
  data.returns = [`${R1} processing drafting agent_error in_task`]
  assert.equal(outcomeSnapshot(readRecord(data), { status: "processing", now: T3 }).returns[0].counts, false)
  const asked = fullData()
  asked.returns = [`${T2} done processing agent_error after_delivery refused=changed_ask verified`]
  assert.equal(outcomeSnapshot(readRecord(asked), { status: "processing", now: T3 }).returns[0].counts, false)
})

test("more than 32 returns are all kept in the snapshot", () => {
  const data = fullData()
  data.returns = Array.from({ length: 40 }, () => `${R1} validating processing agent_error at_review`)
  assert.equal(outcomeSnapshot(readRecord(data), { status: "processing", now: T3 }).returns.length, 40)
})

test("the return paths carry no text: a planted string never reaches a snapshot or a written line", () => {
  const SENTINEL = "SENTINEL-DO-NOT-LEAK"
  const data = fullData()
  data.returns = [`${R1} validating processing ${SENTINEL} at_review`, `${R1} validating processing agent_error at_review refused=${SENTINEL} verified`, data.returns[0]]
  const snap = outcomeSnapshot(readRecord(data), { status: "processing", now: T3 })
  assert.equal(JSON.stringify(snap).includes(SENTINEL), false)
  assert.equal(snap.returns.length, 1)
  assert.equal(snap.returns_unreadable, 2)
  for (const call of [
    () => move(flowAt("validating"), { from: "validating", to: "processing", at: R1, returnReason: SENTINEL }),
    () => refuse(delivered(), { at: T2, reason: SENTINEL, returnReason: "agent_error", verified: true }),
    () => formatReturn(entry({ reason: SENTINEL })),
  ]) {
    try {
      call()
      assert.fail("expected a throw")
    } catch (error) {
      assert.equal(String(error.message).includes(SENTINEL), false)
    }
  }
  assert.equal(JSON.stringify(move(flowAt("validating"), { from: "validating", to: "processing", at: R1, returnReason: "external" })).includes(SENTINEL), false)
})

test("a flow whose rev is unreadable counts from zero in every Package F write", () => {
  const noRev = (reached) => ({ signoff: REFUSED, flow: { ...flowAt(reached).flow, rev: null }, returns: [] })
  assert.equal(move(noRev("validating"), { from: "validating", to: "processing", at: R1, returnReason: "external" }).flow.rev, 1)
  assert.equal(move(noRev("drafting"), { from: "drafting", to: "processing", at: R1 }).flow.rev, 1)
  assert.equal(refuse(noRev("done"), { at: T2, reason: "defect", returnReason: "agent_error", verified: true }).flow.rev, 1)
})

test("returns that move through the rule in sequence are each recorded once", () => {
  let record = flowAt("validating", { first_validating_at: V1 })
  record = move(record, { from: "validating", to: "processing", at: R1, returnReason: "agent_error" })
  record = move(record, { from: "processing", to: "drafting", at: T2, returnReason: "new_information" })
  assert.deepEqual(record.returns, [`${R1} validating processing agent_error at_review`, `${T2} processing drafting new_information in_task`])
  let cancelled = flowAt("validating", { first_validating_at: V1 })
  cancelled = move(cancelled, { from: "validating", to: "cancelled", at: R1 })
  assert.equal(cancelled.returns.length, 0)
  assert.equal(codeOf(() => move(cancelled, { from: "cancelled", to: "processing", at: T2 })), "return_reason_required")
})

test("a legacy done task that is refused or reopened reads refused or reopened, not not_delivered", () => {
  const signed = sign(EMPTY, { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", verified: true, at: T2 }).record
  assert.equal(signed.flow.deliveries, 1)
  const refused = refuse(signed, { at: T2, reason: "defect", returnReason: "agent_error", verified: true })
  const snap = outcomeSnapshot(refused, { status: "processing", now: T3 })
  assert.equal(snap.state, "refused")
  assert.equal(snap.deliveries, 1)
  assert.equal(snap.since, "adopted")
  assert.equal(snap.first_delivered_at, null)
  assert.equal(snap.returns[0].caught, "after_delivery")
  const reopened = move(EMPTY, { from: "done", to: "processing", at: T2, returnReason: "changed_ask" })
  assert.equal(reopened.flow.deliveries, 1)
  assert.equal(reopened.flow.delivered_at, null)
  assert.equal(outcomeSnapshot(reopened, { status: "processing", now: T3 }).state, "reopened")
  assert.equal(move(EMPTY, { from: "validating", to: "processing", at: T2, returnReason: "changed_ask" }).flow.deliveries, 0)
})

test("a card delivered by any path carries the first-review mark, and one already set is kept", () => {
  assert.equal(delivered().flow.first_validating_at, T1)
  const set = deliver(flowAt("validating", { first_validating_at: V1 }), { at: T1 })
  assert.equal(set.flow.first_validating_at, V1)
  const refused = sign(delivered(), { status: "done", outcome: "refused", reason: "defect", returnReason: "agent_error", verified: true, at: T2 }).record
  const snap = outcomeSnapshot(refuse(refused, { at: T2, reason: "defect", returnReason: "agent_error", verified: true }), { status: "processing", now: T3 })
  assert.equal(snap.returns[0].counts, true)
})

test("refuse only follows a recorded refusal", () => {
  const args = { at: T2, reason: "defect", returnReason: "agent_error", verified: true }
  assert.equal(codeOf(() => refuse(EMPTY, args)), "not_refused")
  assert.equal(codeOf(() => refuse(delivered(), args)), "not_refused")
  const accepted = sign(delivered(), { status: "done", outcome: "accepted", verified: true, at: T2 }).record
  assert.equal(codeOf(() => refuse(accepted, args)), "not_refused")
})

test("a damaged returns list is counted, never read as no returns", () => {
  const withFlow = (returns) => outcomeSnapshot(readRecord({ ...fullData(), returns }), { status: "processing", now: T3 })
  const good = fullData().returns[0]
  assert.equal(readRecord({ returns: [null, 42, { a: 1 }, "", good] }).returns_damaged, 4)
  assert.equal(withFlow([null, 42, { a: 1 }, ""]).returns_unreadable, 4)
  assert.equal(withFlow([good, 7, "garbled"]).returns_unreadable, 2)
  assert.equal(withFlow([good, 7, "garbled"]).returns.length, 1)
  assert.equal(readRecord({ returns: "oops" }).returns_damaged, 1)
  assert.equal(readRecord({ returns: { a: 1 } }).returns_damaged, 1)
  assert.equal(readRecord({ returns: 5 }).returns_damaged, 1)
  assert.equal(readRecord({ returns: null }).returns_damaged, 0)
  assert.equal(readRecord({}).returns_damaged, 0)
  assert.equal(readRecord({ returns: [good] }).returns_damaged, 0)
  assert.equal(readRecord({ returns: [good], returns_damaged: 2 }).returns_damaged, 2)
  assert.equal(readRecord({ returns: [null], returns_damaged: 2 }).returns_damaged, 3)
  assert.equal(readRecord({ returns_damaged: -1 }).returns_damaged, 0)
  assert.equal(withFlow([good]).returns_unreadable, 0)
  assert.equal(Object.hasOwn(toFrontmatter(readRecord({ ...fullData(), returns: [null, good] })), "returns_damaged"), false)
})

test("a damaged returns block read from raw lines is counted", () => {
  const flow = ["flow:", "  since: created", "  rev: 2"]
  const good = `${R1} validating processing agent_error at_review`
  const lines = (...rest) => [...flow, "returns:", ...rest]
  assert.equal(recordFromLines(lines(`  - "${good}"`)).returns_damaged, 0)
  assert.equal(recordFromLines(lines(`  - "${good}"`, `  "${good}"`)).returns_damaged, 1)
  assert.equal(recordFromLines(lines("  -", "  - 7")).returns_damaged, 2)
  assert.equal(recordFromLines(lines("  # a note", "")).returns_damaged, 0)
  assert.equal(recordFromLines([...flow, "returns: oops"]).returns_damaged, 1)
  assert.equal(recordFromLines([...flow, 'returns: ["a b"']).returns_damaged, 1)
  assert.equal(recordFromLines(flow).returns_damaged, 0)
  const snap = outcomeSnapshot(recordFromLines(lines(`  - "${good}"`, "  stray text")), { status: "processing", now: T3 })
  assert.equal(snap.returns.length, 1)
  assert.equal(snap.returns_unreadable, 1)
  const flowless = outcomeSnapshot(recordFromLines(["returns:", "  - 7"]), { status: "processing", now: T3 })
  assert.equal(flowless.returns_unreadable, 1)
  assert.deepEqual(flowless.returns, [])
})

test("parseReturn refuses a line that contradicts itself", () => {
  const T = R1
  const bad = [
    `${T} drafting done agent_error at_review`,
    `${T} paused paused agent_error after_delivery`,
    `${T} processing drafting agent_error after_delivery`,
    `${T} done processing agent_error at_review`,
    `${T} done processing agent_error in_task`,
    `${T} validating processing agent_error at_review refused=defect verified`,
    `${T} done paused agent_error after_delivery refused=defect verified`,
  ]
  for (const line of bad) assert.equal(parseReturn(line), null, line)
  assert.notEqual(parseReturn(`${T} done paused agent_error after_delivery`), null)
  assert.notEqual(parseReturn(`${T} done processing agent_error after_delivery refused=defect verified`), null)
  assert.notEqual(parseReturn(`${T} paused processing agent_error at_review`), null)
})

test("refuse on a refusal with no flow record starts an adopted flow that counts the delivery", () => {
  const next = refuse({ signoff: REFUSED, flow: null, returns: [] }, { at: T2, reason: "defect", returnReason: "agent_error", verified: true })
  assert.equal(next.flow.since, "adopted")
  assert.equal(next.flow.deliveries, 1)
  assert.equal(next.flow.rev, 1)
})

test("the human's refusal reason decides whatever the verified flag says, or when it is absent", () => {
  const refused = (extra) => entry({ from: "done", caught: "after_delivery", refusal_verified: true, ...extra })
  assert.equal(returnCounts(refused({ reason: "agent_error", refusal: "changed_ask" }), V1), false)
  for (const refusal_verified of [true, false, null, undefined]) {
    assert.equal(returnCounts(refused({ reason: "agent_error", refusal: "changed_ask", refusal_verified }), V1), false)
    assert.equal(returnCounts(refused({ reason: "changed_ask", refusal: "defect", refusal_verified }), V1), true)
  }
  assert.equal(returnCounts(refused({ reason: "agent_error", refusal: null, refusal_verified: null }), V1), true)
  const line = `${T2} done processing agent_error after_delivery refused=changed_ask unverified`
  assert.equal(outcomeSnapshot(readRecord({ ...fullData(), returns: [line] }), { status: "processing", now: T3 }).returns[0].counts, false)
})
