// The loop health record flattened to the capture record's loop slot (`loop-slot.js`): each key's source, null for anything not measured, the
// record's age, the store's rule on the result, the capture plan that carries it, and the alarm raised when the slot fails its rule.

import { test } from "node:test"
import assert from "node:assert/strict"

import { validateCaptureBytes, LOOP_SLOT_COUNTS } from "../../../../../plugins/desk/mcp/src/factory/capture-schema.js"
import { planCapture } from "../../../../../plugins/desk/mcp/src/factory/capture-flush.js"
import { assembleLoop, count, loopAlarms, unreadAlarms } from "../../../../../plugins/desk/mcp/src/factory/loop-health.js"
import { SLOT_MAX_AGE_HOURS, loopSlotFrom, slotFields, slotValid } from "../../../../../plugins/desk/mcp/src/factory/loop-slot.js"
import { cardTitle } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"

const HOUR = 3600 * 1000
const NOW = Date.parse("2026-10-05T12:00:00.000Z")
const measured = (value) => ({ state: "measured", value, reasons: [] })
const unavailable = (reason) => ({ state: "unavailable", value: null, reasons: [reason] })

function record(overrides = {}) {
  return {
    schema: "desk.factory.loop/1",
    written_at: new Date(NOW - HOUR).toISOString(),
    improvement: { open: measured(4), claimed: measured(1), shipped: measured(2), verifying: measured(3), oldest_open_age_days: measured(9), closed_confirmed_30d: measured(5), closed_unverified_30d: measured(0) },
    alarms: { loop_alarms_open: measured(2) },
    evaluator: { headless: { state: "idle" } },
    steps: { evaluate: { last_ran_at: new Date(NOW).toISOString(), stale: true }, route: { last_ran_at: null, stale: false }, mirror: { last_ran_at: new Date(NOW).toISOString(), stale: false } },
    ...overrides,
  }
}

test("each slot key reads its own measured field of the loop record", () => {
  const slot = loopSlotFrom(record(), NOW)
  assert.deepEqual(slot, {
    v: 1, improvement_open: 4, improvement_claimed: 1, improvement_shipped: 2, improvement_verifying: 3, oldest_open_age_days: 9,
    closed_confirmed_month: 5, closed_unverified_month: 0, loop_alarms_open: 2, steps_stale: 1, headless: "idle",
  })
  assert.deepEqual(Object.keys(slot).filter((key) => key !== "v" && key !== "headless").sort(), [...LOOP_SLOT_COUNTS].sort())
  assert.equal(slotValid(record()), true)
})

test("a field that was not measured is null, never 0", () => {
  const damaged = record({
    improvement: { open: unavailable("unreadable"), claimed: { state: "partial", value: 3, reasons: ["too_many_cards"] }, shipped: { state: "measured", value: -1 }, verifying: "x", oldest_open_age_days: unavailable("none_open") },
    alarms: undefined, evaluator: { headless: { state: "unavailable" } }, steps: { evaluate: { last_ran_at: null, stale: false } },
  })
  const slot = loopSlotFrom(damaged, NOW)
  assert.equal(slot.v, 1)
  for (const key of [...LOOP_SLOT_COUNTS, "headless"]) assert.equal(slot[key], null, key)
  assert.equal(slotFields({}).steps_stale, null)
  assert.equal(slotFields({ steps: null, evaluator: { headless: null } }).headless, null)
  assert.equal(slotFields({ evaluator: { headless: { state: 7 } } }).headless, null)
})

test("a record that is not current, not a loop record, or not valid gives no slot", () => {
  assert.equal(loopSlotFrom(null, NOW), null)
  assert.equal(loopSlotFrom([], NOW), null)
  assert.equal(loopSlotFrom(record({ schema: "other" }), NOW), null)
  assert.equal(loopSlotFrom(record({ written_at: undefined }), NOW), null)
  assert.equal(loopSlotFrom(record({ written_at: "not a time" }), NOW), null)
  assert.equal(loopSlotFrom(record({ written_at: new Date(NOW - (SLOT_MAX_AGE_HOURS + 1) * HOUR).toISOString() }), NOW), null)
  assert.equal(loopSlotFrom(record({ written_at: new Date(NOW + HOUR).toISOString() }), NOW), null)
  assert.ok(loopSlotFrom(record({ written_at: new Date(NOW - SLOT_MAX_AGE_HOURS * HOUR).toISOString() }), NOW))
  const tooBig = record({ improvement: { open: measured(1000001) } })
  assert.equal(loopSlotFrom(tooBig, NOW), null)
  assert.equal(slotValid(tooBig), false)
  assert.equal(slotValid(null), false)
  assert.equal(slotValid([]), false)
})

test("the slot holds only counts and a state code, whatever else the record carries", () => {
  const slot = loopSlotFrom(record({ desk_version: "1.2.3", title: "secret card", path: "/Users/x", written_at: new Date(NOW - HOUR).toISOString() }), NOW)
  const text = JSON.stringify(slot)
  assert.ok(!/secret|Users|1\.2\.3|2026/u.test(text))
  assert.ok(Buffer.byteLength(text) <= 512)
})

const STORE = "ourostack/factory"
const zero = { derived: 0, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 0 }
function status(loopHealth) {
  const rows = { [STORE]: { ...zero, derived: 2, not_seen: 1 } }
  const coverage = { method: 1, ran_at: new Date(NOW - HOUR).toISOString(), hosts: { "claude-code": { state: "counted", on_disk: 3, ...zero, derived: 2, not_seen: 1, unverified: false, frozen_by_reason: {}, by_owner: rows } } }
  return { coverage, ...(loopHealth === undefined ? {} : { loop: { health: loopHealth } }) }
}
const plan = (st) => planCapture({ status: st, consent: { [STORE]: { contribute: true } }, store: STORE, intakeId: "0123456789abcdef", nowMs: NOW, mayBeOpen: false })

test("the capture plan carries the slot from the stored loop record, and the store's rule on the bytes holds", () => {
  const made = plan(status(record())).record
  const parsed = JSON.parse(made.bytes.toString("utf8"))
  assert.deepEqual(parsed.loop, loopSlotFrom(record(), NOW))
  assert.equal(validateCaptureBytes(made.bytes.toString("utf8")).ok, true)
})

test("a missing, damaged or stale loop record leaves the slot out and the capture record still goes", () => {
  for (const loop of [undefined, null, "x", record({ written_at: new Date(NOW - 100 * HOUR).toISOString() })]) {
    const made = plan(status(loop)).record
    assert.ok(made !== null)
    assert.equal(Object.hasOwn(JSON.parse(made.bytes.toString("utf8")), "loop"), false)
  }
  assert.equal(Object.hasOwn(JSON.parse(plan({ ...status(), loop: 5 }).record.bytes.toString("utf8")), "loop"), false)
})

function assembled(readCards, statusInput = {}) {
  return assembleLoop({ status: statusInput, read: readCards, nowMs: NOW, version: "1.0.0" })
}

test("a slot that passes the rule raises no alarm; one that fails raises capture_loop_slot once, with no evidence", () => {
  const good = assembled({ cards: [], truncated: false, set_aside_total: 0, unreadable_files: 0 })
  assert.equal(good.signals.slot_invalid, false)
  assert.ok(!loopAlarms(good.loop, good.signals).some((alarm) => alarm.name === "capture_loop_slot"))
  const bad = { ...good.loop, improvement: { ...good.loop.improvement, open: count(1000001) } }
  const alarms = loopAlarms(bad, { slot_invalid: true })
  assert.deepEqual(alarms.filter((alarm) => alarm.name === "capture_loop_slot"), [{ name: "capture_loop_slot", evidence: {} }])
  assert.equal(assembled({ cards: Array.from({ length: 0 }), truncated: false, set_aside_total: 0, unreadable_files: 0 }).signals.slot_invalid, false)
  assert.ok(!unreadAlarms(good.loop, good.signals).includes("capture_loop_slot"))
  assert.equal(cardTitle("loop_alarm", "capture_loop_slot"), "The loop health record could not be sent to the store")
})

test("the record the measure step builds flattens to a slot the store's rule accepts", () => {
  const built = assembled({ cards: [], truncated: false, set_aside_total: 0, unreadable_files: 0 }, { loop: { steps: { measure: { last_ran_at: new Date(NOW).toISOString(), last_ok_at: new Date(NOW).toISOString(), last_result: "measured", runs: 1, failures: 0, failures_in_a_row: 0 } } } })
  const slot = loopSlotFrom(built.loop, NOW)
  assert.equal(slot.improvement_open, 0)
  assert.equal(slot.oldest_open_age_days, null)
  assert.equal(slot.steps_stale, 0)
  assert.equal(slot.headless, null)
})
