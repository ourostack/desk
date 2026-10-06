// The capture record's gate (`capture-schema.js`): counts per host and fixed
// enums only, an exact key set at every level, one optional `loop` slot.
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CAPTURE_LOOP_KEY,
  CAPTURE_MAX_BYTES,
  CAPTURE_PATH,
  CAPTURE_SCHEMA,
  LOOP_SLOT_COUNTS,
  LOOP_SLOT_VERSION,
  NOT_COUNTED,
  validateCapture,
  validateCaptureBytes,
  validateLoopSlot,
} from "../../../../../plugins/desk/mcp/src/factory/capture-schema.js"

const SENTINEL = "SENTINEL-PRIVATE-2026-10-05T01:02:03Z/Users/ari/code/desk-11111111-1111-4111-8111-111111111111"

const claude = () => ({ on_disk: 280, derived: 248, held: 0, frozen: 0, pending: 2, not_seen: 18, not_in_a_desk: 12, unverified: false })
const copilot = () => ({ on_disk: 188, derived: 49, held: 0, frozen: 0, pending: 0, not_seen: 139, not_in_a_desk: null, unverified: false })
const record = (hosts = { "claude-code": claude(), "copilot-cli": copilot() }) => ({ schema: CAPTURE_SCHEMA, basis: "still_on_disk", hosts })
const bytes = (value) => Buffer.from(`${JSON.stringify(value)}\n`)
const codes = (result) => result.errors.map((item) => item.code)

test("constants name the schema, the path shape, the size and the loop slot", () => {
  assert.equal(CAPTURE_SCHEMA, "desk.factory.capture/1")
  assert.equal(CAPTURE_MAX_BYTES, 2048)
  assert.equal(CAPTURE_LOOP_KEY, "loop")
  assert.equal(CAPTURE_PATH.test("capture/0123456789abcdef.json"), true)
  for (const bad of ["capture/0123456789abcde.json", "capture/0123456789abcdef0.json", "capture/0123456789ABCDEF.json", "capture/x/0123456789abcdef.json", "capture/0123456789abcdef.json.bak", "xcapture/0123456789abcdef.json"]) {
    assert.equal(CAPTURE_PATH.test(bad), false, bad)
  }
})

test("a valid record passes, including the empty record and a record with a null not_in_a_desk", () => {
  assert.deepEqual(validateCapture(record()), { ok: true, errors: [] })
  assert.deepEqual(validateCapture(record({})), { ok: true, errors: [] })
  assert.deepEqual(validateCapture(record({ "copilot-cli": copilot() })), { ok: true, errors: [] })
  assert.deepEqual(validateCapture(record({ "claude-code": claude(), "copilot-cli": copilot(), "codex-cli": copilot() })), { ok: true, errors: [] })
  assert.deepEqual(validateCaptureBytes(bytes(record())), { ok: true, errors: [] })
  assert.deepEqual(validateCaptureBytes(JSON.stringify(record({}))), { ok: true, errors: [] })
})

test("a record with an extra key at any level is refused", () => {
  const top = { ...record(), extra: 1 }
  assert.deepEqual(codes(validateCapture(top)), ["unknown_key"])
  const host = record()
  host.hosts["claude-code"].extra = 1
  assert.deepEqual(codes(validateCapture(host)), ["unknown_key"])
  assert.deepEqual(codes(validateCapture(record({ "unknown-host": claude() }))), ["unknown_key"])
  assert.deepEqual(codes(validateCapture(record({ [SENTINEL]: claude() }))), ["unknown_key"])
  const missing = record()
  delete missing.hosts["claude-code"].held
  assert.deepEqual(validateCapture(missing).errors, [{ code: "missing", path: "hosts.claude-code.held" }])
  const noHosts = record()
  delete noHosts.hosts
  assert.deepEqual(validateCapture(noHosts).errors, [{ code: "missing", path: "hosts" }])
})

test("a record whose buckets do not sum to on_disk is refused as inconsistent", () => {
  const high = record()
  high.hosts["claude-code"].on_disk = 281
  assert.deepEqual(validateCapture(high).errors, [{ code: "inconsistent", path: "hosts.claude-code" }])
  const low = record()
  low.hosts["copilot-cli"].held = 1
  assert.deepEqual(validateCapture(low).errors, [{ code: "inconsistent", path: "hosts.copilot-cli" }])
  // A null not_in_a_desk counts as zero in the sum.
  const nullSum = record({ "copilot-cli": { ...copilot(), on_disk: 188 } })
  assert.deepEqual(validateCapture(nullSum), { ok: true, errors: [] })
  // A bad count is its own error, not also an inconsistent one.
  const bad = record()
  bad.hosts["claude-code"].held = -1
  assert.deepEqual(validateCapture(bad).errors, [{ code: "range", path: "hosts.claude-code.held" }])
})

test("a missing or different basis is refused", () => {
  const other = { ...record(), basis: "all_time" }
  assert.deepEqual(validateCapture(other).errors, [{ code: "enum", path: "basis" }])
  const missing = record()
  delete missing.basis
  assert.deepEqual(validateCapture(missing).errors, [{ code: "missing", path: "basis" }])
  assert.deepEqual(validateCapture({ ...record(), schema: "desk.factory.capture/2" }).errors, [{ code: "enum", path: "schema" }])
  assert.deepEqual(codes(validateCapture(null)), ["type"])
  assert.deepEqual(codes(validateCapture([])), ["type"])
  assert.deepEqual(validateCapture({ ...record(), hosts: [] }).errors, [{ code: "type", path: "hosts" }])
})

test("a count above 1,000,000, a negative count, a float and a string count are refused", () => {
  for (const bad of [1000001, -1, 1.5, "7", null, Number.MAX_SAFE_INTEGER + 2, NaN]) {
    const value = record()
    value.hosts["claude-code"].held = bad
    assert.deepEqual(validateCapture(value).errors, [{ code: "range", path: "hosts.claude-code.held" }], String(bad))
  }
  const edge = record({ "claude-code": { on_disk: 1000000, derived: 1000000, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 0, unverified: true } })
  assert.deepEqual(validateCapture(edge), { ok: true, errors: [] })
  const badNull = record()
  badNull.hosts["claude-code"].not_in_a_desk = "12"
  assert.deepEqual(validateCapture(badNull).errors, [{ code: "range", path: "hosts.claude-code.not_in_a_desk" }])
  const badFlag = record()
  badFlag.hosts["claude-code"].unverified = "no"
  assert.deepEqual(validateCapture(badFlag).errors, [{ code: "type", path: "hosts.claude-code.unverified" }])
})

test("a string that looks like a date, a path or a session id is refused wherever it is put", () => {
  const variants = []
  for (const key of ["on_disk", "derived", "held", "frozen", "pending", "not_seen", "not_in_a_desk", "unverified"]) {
    const value = record()
    value.hosts["claude-code"][key] = SENTINEL
    variants.push(value)
  }
  variants.push({ ...record(), basis: SENTINEL }, { ...record(), schema: SENTINEL }, { ...record(), [SENTINEL]: 1 }, record({ [SENTINEL]: claude() }))
  const host = record()
  host.hosts["claude-code"][SENTINEL] = 1
  variants.push(host, { ...record(), loop: { v: 1, [SENTINEL]: 1 } }, { ...record(), loop: { v: 1, headless: SENTINEL } }, { ...record(), loop: SENTINEL }, { ...record(), loop: [SENTINEL] })
  for (const value of variants) {
    const result = validateCapture(value)
    assert.equal(result.ok, false)
    assert.equal(JSON.stringify(result).includes("SENTINEL"), false)
    assert.equal(JSON.stringify(result).includes("2026"), false)
    assert.equal(JSON.stringify(result).includes("/Users"), false)
    const viaBytes = validateCaptureBytes(bytes(value))
    assert.equal(viaBytes.ok, false)
    assert.equal(JSON.stringify(viaBytes).includes("SENTINEL"), false)
  }
})

test("a record over 2 KiB or not in canonical bytes is refused", () => {
  const big = Buffer.alloc(CAPTURE_MAX_BYTES + 1, " ")
  assert.deepEqual(validateCaptureBytes(big), { ok: false, errors: [{ code: "size", path: "" }] })
  assert.deepEqual(validateCaptureBytes(`${JSON.stringify(record())}\n\n`), { ok: false, errors: [{ code: "canonical", path: "" }] })
  assert.deepEqual(validateCaptureBytes(JSON.stringify(record(), null, 2)), { ok: false, errors: [{ code: "canonical", path: "" }] })
  const duplicate = JSON.stringify(record({})).replace('"basis":"still_on_disk"', `"basis":"${SENTINEL}","basis":"still_on_disk"`)
  assert.deepEqual(validateCaptureBytes(duplicate), { ok: false, errors: [{ code: "canonical", path: "" }] })
  assert.deepEqual(validateCaptureBytes("{not json"), { ok: false, errors: [{ code: "json", path: "" }] })
  // Exactly at the cap is fine for the size rule: a record with a full loop slot stays well under it.
  assert.equal(bytes(record()).length < CAPTURE_MAX_BYTES, true)
})

const LOOP = { v: 1, improvement_open: 3, improvement_claimed: 0, oldest_open_age_days: null, steps_stale: 1000000, headless: "closed_loop" }

test("the optional loop slot is the store's loop_slot_v1, and a record without it stays valid", () => {
  const withLoop = (loop) => ({ ...record(), loop })
  assert.deepEqual(validateCapture(withLoop(LOOP)), { ok: true, errors: [] })
  assert.deepEqual(validateCapture(withLoop({ v: 1 })), { ok: true, errors: [] })
  assert.deepEqual(validateCapture(withLoop({ v: 1, headless: null })), { ok: true, errors: [] })
  assert.deepEqual(validateCapture({ ...record({}), loop: { v: 1, steps_stale: 1 } }), { ok: true, errors: [] })
  assert.equal(Object.hasOwn(record({}), CAPTURE_LOOP_KEY), false)
  assert.equal(LOOP_SLOT_VERSION, 1)
  // The slot with every key at its largest still fits the store's 512 bytes.
  const full = { v: 1, ...Object.fromEntries(LOOP_SLOT_COUNTS.map((key) => [key, 1000000])), headless: "x".repeat(32) }
  assert.deepEqual(validateCapture(withLoop(full)), { ok: true, errors: [] })
  assert.equal(Buffer.byteLength(JSON.stringify(full)) <= 512, true)
  const refused = [
    [null, "type"], [[], "type"], ["x", "type"], [3, "type"],
    // v is required and exactly 1: missing, another number, a string, a boolean.
    [{}, "enum", "loop.v"], [{ steps_stale: 1 }, "enum", "loop.v"], [{ v: 2 }, "enum", "loop.v"], [{ v: "1" }, "enum", "loop.v"], [{ v: true }, "enum", "loop.v"],
    // A count is a whole number from 0 to 1,000,000 or null: never a boolean, a string, a float, a nested value.
    [{ v: 1, steps_stale: true }, "range", "loop.steps_stale"], [{ v: 1, steps_stale: "1" }, "range", "loop.steps_stale"], [{ v: 1, steps_stale: 1.5 }, "range", "loop.steps_stale"],
    [{ v: 1, steps_stale: -1 }, "range", "loop.steps_stale"], [{ v: 1, steps_stale: 1000001 }, "range", "loop.steps_stale"], [{ v: 1, steps_stale: { a: 1 } }, "range", "loop.steps_stale"],
    // headless is a plain code or null.
    [{ v: 1, headless: true }, "pattern", "loop.headless"], [{ v: 1, headless: 3 }, "pattern", "loop.headless"], [{ v: 1, headless: "Has-Dash" }, "pattern", "loop.headless"], [{ v: 1, headless: "" }, "pattern", "loop.headless"], [{ v: 1, headless: "x".repeat(33) }, "pattern", "loop.headless"],
    // A key the store does not know, whatever its value; a key that is not a plain code is named "?".
    [{ v: 1, made_up: 1 }, "unknown_key", "loop.made_up"], [{ v: 1, Bad: 1 }, "unknown_key", "loop.?"],
  ]
  for (const [loop, code, at = "loop"] of refused) {
    assert.deepEqual(validateCapture(withLoop(loop)).errors, [{ code, path: at }], JSON.stringify(loop))
  }
  // Over 512 bytes is its own refusal, whatever else is wrong.
  const wide = { v: 1, ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key_${"abcdefghijklmnopqrstuvwxyz"[index % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(index / 26)]}`, 1000000])) }
  assert.deepEqual(validateCapture(withLoop(wide)).errors, [{ code: "size", path: "loop" }])
  assert.equal(CAPTURE_LOOP_KEY, "loop")
})

test("a host the machine could not count is exactly not_counted: true, beside counted hosts", () => {
  assert.equal(NOT_COUNTED, "not_counted")
  assert.deepEqual(validateCapture(record({ "claude-code": claude(), "codex-cli": { not_counted: true } })), { ok: true, errors: [] })
  assert.deepEqual(validateCapture(record({ "claude-code": { not_counted: true } })), { ok: true, errors: [] })
  assert.deepEqual(validateCaptureBytes(bytes(record({ "copilot-cli": { not_counted: true } }))), { ok: true, errors: [] })
  for (const bad of [false, null, 1, "true", {}, []]) {
    assert.deepEqual(validateCapture(record({ "claude-code": { not_counted: bad } })).errors, [{ code: "enum", path: "hosts.claude-code.not_counted" }], JSON.stringify(bad))
  }
  // Any other key beside it is refused, so a count can never ride along with the flag.
  assert.deepEqual(codes(validateCapture(record({ "claude-code": { not_counted: true, on_disk: 0 } }))), ["unknown_key"])
  assert.deepEqual(codes(validateCapture(record({ "claude-code": { not_counted: true, [SENTINEL]: 1 } }))), ["unknown_key"])
  // A host that is not a plain object is still a type error, and the flag is only a host's own entry.
  assert.deepEqual(codes(validateCapture(record({ "claude-code": null }))), ["type"])
  assert.equal(validateCapture({ ...record(), not_counted: true }).ok, false)
})

test("validateLoopSlot reports into the caller's list at the caller's path", () => {
  const errors = []
  assert.equal(validateLoopSlot({ v: 1, steps_stale: 1 }, "loop", errors), true)
  assert.deepEqual(errors, [])
  assert.equal(validateLoopSlot({ v: 1, headless: "No" }, "loop", errors), false)
  assert.deepEqual(errors, [{ code: "pattern", path: "loop.headless" }])
})

test("validateCaptureBytes returns a type error unless the input is a string or a Buffer", () => {
  for (const input of [undefined, null, 5, {}, [], true]) {
    assert.deepEqual(validateCaptureBytes(input), { ok: false, errors: [{ code: "type", path: "" }] }, String(input))
  }
  assert.deepEqual(validateCaptureBytes(new Uint8Array(2)), { ok: false, errors: [{ code: "type", path: "" }] })
})

test("the loop slot cap is 512 bytes and the 2 KiB cap is exact", () => {
  // A valid slot is far under 512 bytes, so the cap only ever stops a slot padded with unknown keys.
  const padded = (size) => ({ v: 1, pad: "a".repeat(size - Buffer.byteLength(JSON.stringify({ v: 1, pad: "" }))) })
  assert.equal(Buffer.byteLength(JSON.stringify(padded(512))), 512)
  assert.deepEqual(validateCapture({ ...record({}), loop: padded(512) }).errors, [{ code: "unknown_key", path: "loop.pad" }])
  assert.deepEqual(validateCapture({ ...record({}), loop: padded(513) }).errors, [{ code: "size", path: "loop" }])
  // A full-size valid loop slot on a three-host record is well under the cap, so no valid record reaches 2048 bytes.
  const full = { ...record({ "claude-code": claude(), "copilot-cli": copilot(), "codex-cli": copilot() }), loop: { v: 1, ...Object.fromEntries(LOOP_SLOT_COUNTS.map((key) => [key, 1000000])), headless: "x".repeat(32) } }
  assert.equal(Buffer.byteLength(JSON.stringify(full)) < CAPTURE_MAX_BYTES, true)
  assert.deepEqual(validateCaptureBytes(JSON.stringify(full)), { ok: true, errors: [] })
  // The byte cap itself: exactly 2048 bytes passes the size rule, 2049 does not.
  assert.deepEqual(validateCaptureBytes(Buffer.alloc(CAPTURE_MAX_BYTES, " ")), { ok: false, errors: [{ code: "json", path: "" }] })
  assert.deepEqual(validateCaptureBytes(Buffer.alloc(CAPTURE_MAX_BYTES + 1, " ")), { ok: false, errors: [{ code: "size", path: "" }] })
})
