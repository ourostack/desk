// The loop health record flattened to the capture record's loop slot (`loop-slot.js`): each key's source, null for anything not measured, the
// record's age, the store's rule on the result, the capture plan that carries it, and the alarm raised when the slot fails its rule.

import { test } from "node:test"
import assert from "node:assert/strict"

import { validateCaptureBytes, LOOP_SLOT_COUNTS } from "../../../../../plugins/desk/mcp/src/factory/capture-schema.js"
import { planCapture } from "../../../../../plugins/desk/mcp/src/factory/capture-flush.js"
import { assembleLoop, loopAlarms, unreadAlarms } from "../../../../../plugins/desk/mcp/src/factory/loop-health.js"
import { SLOT_MAX_AGE_HOURS, loopSlotFrom, slotFields, slotValid } from "../../../../../plugins/desk/mcp/src/factory/loop-slot.js"
import { cardTitle } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import * as slots from "../../../../../plugins/desk/mcp/src/factory/loop-slot.js"

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

test("specific refresh context requires a fresh matching operation for this store, not a stale-step guess", () => {
  assert.equal(typeof slots.triageRefreshFrom, "function")
  const at = new Date(NOW - HOUR).toISOString()
  const triage = { at, store: "ourostack/factory", result: "refresh_incomplete",
    refresh: { scan: "complete", changes: 37, written: 0, held: 37, foreign: 0, unknown: 0, deferred: 0, alarm: "triage_resource_unrecoverable" } }
  const status = { triage, loop: { health: record({ steps: { triage: { last_ran_at: at, stale: true } } }) } }
  const options = { store: "ourostack/factory", nowMs: NOW }
  assert.equal(slots.triageRefreshFrom(status, options), "resource_unrecoverable")
  for (const change of [
    (value) => { delete value.triage.store },
    (value) => { value.triage.store = "other/store" },
    (value) => { value.triage.at = new Date(NOW - 100 * HOUR).toISOString() },
    (value) => { value.loop.health.steps.triage.last_ran_at = new Date(NOW).toISOString() },
    (value) => { value.triage.refresh.alarm = "PRIVATE/path" },
  ]) {
    const value = structuredClone(status); change(value)
    assert.equal(slots.triageRefreshFrom(value, options), null)
  }
  assert.equal(Object.hasOwn(loopSlotFrom(status.loop.health, NOW), "triage_refresh"), false, "legacy slot bytes stay unchanged without a capability")
  const slot = loopSlotFrom(status.loop.health, NOW, { triageRefresh: "resource_unrecoverable" })
  assert.equal(slot.triage_refresh, "resource_unrecoverable")
  assert.equal(validateCaptureBytes(`${JSON.stringify({ schema: "desk.factory.capture/1", basis: "still_on_disk", hosts: {}, loop: slot })}\n`).ok, true)
  assert.equal(slot.triage_refresh.includes(at), false)
})

test("refresh context distinguishes a complete current operation from each incomplete operation", () => {
  const at = new Date(NOW - HOUR).toISOString()
  const refresh = { scan: "complete", changes: 2, written: 2, held: 0, foreign: 0, unknown: 0, deferred: 0, alarm: null }
  const status = (fields = {}) => ({ triage: { at, store: "OuroStack/Factory", refresh: { ...refresh, ...fields } },
    loop: { health: { steps: { triage: { last_ran_at: at } } } } })
  const options = { store: "ourostack/factory", nowMs: NOW }
  assert.equal(slots.triageRefreshFrom(status(), options), "current")
  for (const fields of [{ scan: "truncated" }, { held: 1 }, { unknown: 1 }, { deferred: 1 }]) {
    assert.equal(slots.triageRefreshFrom(status(fields), options), "incomplete")
  }
  assert.equal(slots.triageRefreshFrom(status({ alarm: "triage_resource_unrecoverable" }), options), null)
  for (const code of [null, "current", "incomplete"]) assert.equal(loopSlotFrom(record(), NOW, { triageRefresh: code }).triage_refresh, code)
  assert.equal(Object.hasOwn(loopSlotFrom(record(), NOW, { triageRefresh: "unsupported" }), "triage_refresh"), false)
})

test("refresh context refuses missing, malformed, future and old observations before publishing a diagnosis", () => {
  const options = { store: "ourostack/factory", nowMs: NOW }
  const status = (at, refresh) => ({ triage: { at, store: options.store, refresh },
    loop: { health: { steps: { triage: { last_ran_at: at } } } } })
  const refresh = { scan: "complete", changes: 0, written: 0, held: 0, foreign: 0, unknown: 0, deferred: 0, alarm: null }
  assert.equal(slots.triageRefreshFrom(undefined, options), null)
  for (const at of [undefined, 1, "invalid", new Date(NOW + HOUR).toISOString(), new Date(NOW - 73 * HOUR).toISOString()]) {
    assert.equal(slots.triageRefreshFrom(status(at, refresh), options), null)
  }
  for (const value of [null, [], {}, { ...refresh, scan: "invalid" }, { ...refresh, written: -1 },
    { ...refresh, foreign: 0.5 }, { ...refresh, changes: "0" }]) {
    assert.equal(slots.triageRefreshFrom(status(new Date(NOW).toISOString(), value), options), null)
  }
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
  const tooBig = record({ improvement: { open: measured(1000001), claimed: measured(1) } })
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
  const bad = assembled({ cards: Array.from({ length: 1000001 }, () => ({ source: "andon", state: "closed_confirmed", last_opened_at: new Date(NOW).toISOString(), closed_at: new Date(NOW - HOUR).toISOString() })), set_aside_total: 0, unreadable_files: 0 })
  assert.equal(bad.signals.slot_invalid, true)
  const alarms = loopAlarms(bad.loop, bad.signals)
  assert.deepEqual(alarms.filter((alarm) => alarm.name === "capture_loop_slot"), [{ name: "capture_loop_slot", evidence: {} }])
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

test("a value that fails the rule is null and the rest of the slot still goes", () => {
  const slot = loopSlotFrom(record({ improvement: { open: measured(1000001), claimed: measured(1) }, evaluator: { headless: { state: "Not A Code" } } }), NOW)
  assert.equal(slot.improvement_open, null)
  assert.equal(slot.improvement_claimed, 1)
  assert.equal(slot.headless, null)
  assert.equal(slotValid(record({ evaluator: { headless: { state: "Not A Code" } } })), false)
  assert.equal(slotValid(record()), true)
})

test("the oldest open age is aged by the record's own age in whole days, so the store's 7-day alarm is never late", () => {
  const old = record({ written_at: new Date(NOW - 71 * HOUR).toISOString(), improvement: { oldest_open_age_days: measured(5) } })
  assert.equal(loopSlotFrom(old, NOW).oldest_open_age_days, 7)
  const fresh = record({ written_at: new Date(NOW - 2 * HOUR).toISOString(), improvement: { oldest_open_age_days: measured(5) } })
  assert.equal(loopSlotFrom(fresh, NOW).oldest_open_age_days, 5)
  const none = record({ written_at: new Date(NOW - 71 * HOUR).toISOString(), improvement: { oldest_open_age_days: unavailable("none_open") } })
  assert.equal(loopSlotFrom(none, NOW).oldest_open_age_days, null)
  const ahead = record({ written_at: new Date(NOW + 60000).toISOString(), improvement: { oldest_open_age_days: measured(5) } })
  assert.equal(loopSlotFrom(ahead, NOW).oldest_open_age_days, 5)
})

test("a slot that fails the rule still lets the capture record go, with the failing key null", () => {
  const made = plan(status(record({ improvement: { open: measured(1000001), claimed: measured(2) } }))).record
  const parsed = JSON.parse(made.bytes.toString("utf8"))
  assert.equal(parsed.loop.improvement_open, null)
  assert.equal(parsed.loop.improvement_claimed, 2)
  assert.equal(validateCaptureBytes(made.bytes.toString("utf8")).ok, true)
})
