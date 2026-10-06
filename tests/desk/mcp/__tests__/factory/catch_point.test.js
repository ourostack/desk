// Where a defect was caught, placed by Desk from the job's own record: before the first review, at review, or after the first delivery. The evaluator never writes it.

import { test } from "node:test"
import assert from "node:assert/strict"

import { outcomeForStamping, stampCatchPoints } from "../../../../../plugins/desk/mcp/src/factory/catch-point.js"

const JOB = "1".repeat(32)
const OTHER = "2".repeat(32)
const STARTED = "2026-09-25T08:00:00.000Z"
// Offsets on the session clock: review begins at 600 s, delivery at 1200 s.
const REVIEW = "2026-09-25T08:10:00.000Z"
const DELIVERED = "2026-09-25T08:20:00.000Z"

const stretch = (start, end, waste = "defects", extra = {}) => ({
  start_ms: start,
  end_ms: end,
  class: waste === null ? "value" : "muda",
  waste,
  mura: false,
  muri: false,
  evidence: [[start, end]],
  ...extra,
})
const labelsOf = (...stretches) => ({ schema: "desk.factory.labels/1", job: JOB, session: "s", stretches, unavailable: [] })
const outcome = (extra = {}) => ({ job: JOB, rev: 3, state: "delivered_unsigned", deliveries: 1, since: "created", first_validating_at: REVIEW, first_delivered_at: DELIVERED, ...extra })
const caught = (labels, ...rest) => stampCatchPoints(labels, { outcome: outcome(...rest), startedAt: STARTED }).stretches.map((item) => item.caught)

test("a defects stretch before the first review is stamped in_task", () => {
  assert.deepEqual(caught(labelsOf(stretch(0, 5000), stretch(599000, 599999))), ["in_task", "in_task"])
})

test("a defects stretch after the first review and before delivery is stamped at_review", () => {
  assert.deepEqual(caught(labelsOf(stretch(600000, 601000), stretch(1199999, 1200000))), ["at_review", "at_review"])
})

test("a defects stretch after the first delivery is stamped after_delivery", () => {
  assert.deepEqual(caught(labelsOf(stretch(1200000, 1300000), stretch(9000000, 9001000))), ["after_delivery", "after_delivery"])
})

test("a stretch that spans a milestone is placed by its start", () => {
  assert.deepEqual(caught(labelsOf(stretch(500000, 700000), stretch(1000000, 1500000))), ["in_task", "at_review"])
})

test("a stretch of another waste is never stamped", () => {
  const stamped = stampCatchPoints(labelsOf(stretch(0, 1000, "waiting"), stretch(2000, 3000, null), stretch(4000, 5000, "motion")), { outcome: outcome(), startedAt: STARTED })
  assert.deepEqual(stamped.stretches.map((item) => Object.hasOwn(item, "caught")), [false, false, false])
})

test("nothing is stamped when the job's record was adopted or is missing", () => {
  const input = labelsOf(stretch(0, 1000))
  for (const given of [outcome({ since: "adopted" }), outcome({ since: null }), outcome({ since: undefined }), null, undefined]) {
    const stamped = stampCatchPoints(input, { outcome: given, startedAt: STARTED })
    assert.equal(Object.hasOwn(stamped.stretches[0], "caught"), false)
  }
})

test("a caught value the evaluator wrote is replaced by Desk's, and removed when Desk cannot place it", () => {
  const written = labelsOf(stretch(0, 1000, "defects", { caught: "after_delivery" }), stretch(2000, 3000, "waiting", { caught: "at_review" }))
  const placed = stampCatchPoints(written, { outcome: outcome(), startedAt: STARTED })
  assert.equal(placed.stretches[0].caught, "in_task")
  assert.equal(Object.hasOwn(placed.stretches[1], "caught"), false)
  const unplaced = stampCatchPoints(written, { outcome: null, startedAt: STARTED })
  assert.deepEqual(unplaced.stretches.map((item) => Object.hasOwn(item, "caught")), [false, false])
})

test("a missing first_validating_at with a present first_delivered_at places by delivery only", () => {
  assert.deepEqual(caught(labelsOf(stretch(700000, 800000), stretch(1300000, 1400000)), { first_validating_at: null }), ["in_task", "after_delivery"])
})

test("a present first_validating_at with no delivery yet places by review only", () => {
  assert.deepEqual(caught(labelsOf(stretch(100000, 200000), stretch(700000, 800000)), { deliveries: 0, first_delivered_at: null }), ["in_task", "at_review"])
})

test("a job that has reached neither milestone is in_task throughout", () => {
  assert.deepEqual(caught(labelsOf(stretch(100000, 200000), stretch(9000000, 9100000)), { state: "not_delivered", deliveries: 0, first_validating_at: null, first_delivered_at: null }), ["in_task", "in_task"])
})

test("a milestone the record does not carry, or contradicts, is never guessed", () => {
  const input = labelsOf(stretch(0, 1000))
  const missingKeys = outcome()
  delete missingKeys.first_validating_at
  delete missingKeys.first_delivered_at
  const noDeliveryTime = outcome({ first_delivered_at: null })
  const badTime = outcome({ first_delivered_at: "not a time" })
  for (const given of [missingKeys, noDeliveryTime, badTime, outcome({ first_validating_at: 5 })]) {
    assert.equal(Object.hasOwn(stampCatchPoints(input, { outcome: given, startedAt: STARTED }).stretches[0], "caught"), false)
  }
  assert.equal(Object.hasOwn(stampCatchPoints(input, { outcome: outcome(), startedAt: "bad" }).stretches[0], "caught"), false)
})

test("stamping returns a new labels value and never changes its input", () => {
  const input = labelsOf(stretch(0, 1000), stretch(1300000, 1400000))
  const before = structuredClone(input)
  const stamped = stampCatchPoints(input, { outcome: outcome(), startedAt: STARTED })
  assert.deepEqual(input, before)
  stamped.stretches[0].evidence[0][0] = 99
  assert.deepEqual(input, before)
  assert.deepEqual(stamped.stretches.map((item) => item.caught), ["in_task", "after_delivery"])
})

test("the record is taken only from a session bound to exactly one job, and only that job's entry", () => {
  const facts = (jobs, outcomes) => ({ jobs: jobs.map((job) => ({ job })), ...(outcomes === undefined ? {} : { outcomes }) })
  assert.deepEqual(outcomeForStamping(facts([JOB], [outcome()]), JOB), outcome())
  assert.equal(outcomeForStamping(facts([JOB, OTHER], [outcome()]), JOB), null, "two jobs share the session")
  assert.equal(outcomeForStamping(facts([JOB], [outcome({ job: OTHER })]), JOB), null, "no entry for this job")
  assert.equal(outcomeForStamping(facts([JOB], []), JOB), null)
  assert.equal(outcomeForStamping(facts([JOB]), JOB), null, "no outcomes key")
  assert.equal(outcomeForStamping(facts([JOB], [outcome(), outcome({ rev: 4 })]), JOB), null, "two entries for the job")
  assert.equal(outcomeForStamping(facts([OTHER], [outcome()]), JOB), null, "the session is not bound to this job")
})
