// The capture record's gate (`capture-schema.js`): counts per host and fixed
// enums only, an exact key set at every level, one optional `loop` slot.
import { test } from "node:test"
import assert from "node:assert/strict"

import {
  CAPTURE_LOOP_KEY,
  CAPTURE_MAX_BYTES,
  CAPTURE_PATH,
  CAPTURE_SCHEMA,
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
  variants.push(host, { ...record(), loop: { [SENTINEL]: 1 } }, { ...record(), loop: { state: SENTINEL } }, { ...record(), loop: SENTINEL }, { ...record(), loop: [SENTINEL] })
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

test("the optional loop slot is validated, and a record without it stays valid", () => {
  const withLoop = (loop) => ({ ...record(), loop })
  assert.deepEqual(validateCapture(withLoop({ ok: true, n: 3, last: null, state: "closed_loop" })), { ok: true, errors: [] })
  assert.deepEqual(validateCapture(withLoop({})), { ok: true, errors: [] })
  assert.deepEqual(validateCapture({ ...record({}), loop: { a: 1 } }), { ok: true, errors: [] })
  assert.equal(Object.hasOwn(record({}), CAPTURE_LOOP_KEY), false)
  const refused = [
    [null, "type"], [[], "type"], ["x", "type"], [3, "type"],
    [{ a: { b: 1 } }, "type"], [{ a: [1] }, "type"], [{ a: 1.5 }, "range"], [{ a: -1 }, "range"], [{ a: 1000001 }, "range"],
    [{ a: "Has-Dash" }, "pattern"], [{ a: "" }, "pattern"], [{ a: "x".repeat(33) }, "pattern"], [{ Bad: 1 }, "pattern"],
  ]
  for (const [loop, code] of refused) {
    assert.deepEqual(codes(validateCapture(withLoop(loop))), [code], JSON.stringify(loop))
  }
  const wide = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`key_${"abcdefghijklmnopqrstuvwxyz"[index % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(index / 26)]}`, 1000000]))
  assert.deepEqual(validateCapture(withLoop(wide)).errors, [{ code: "size", path: "loop" }])
  assert.equal(CAPTURE_LOOP_KEY, "loop")
})

test("validateLoopSlot reports into the caller's list at the caller's path", () => {
  const errors = []
  assert.equal(validateLoopSlot({ a: 1 }, "loop", errors), true)
  assert.deepEqual(errors, [])
  assert.equal(validateLoopSlot({ a: "No" }, "loop", errors), false)
  assert.deepEqual(errors, [{ code: "pattern", path: "loop.a" }])
})

test("validateCaptureBytes returns a type error unless the input is a string or a Buffer", () => {
  for (const input of [undefined, null, 5, {}, [], true]) {
    assert.deepEqual(validateCaptureBytes(input), { ok: false, errors: [{ code: "type", path: "" }] }, String(input))
  }
  assert.deepEqual(validateCaptureBytes(new Uint8Array(2)), { ok: false, errors: [{ code: "type", path: "" }] })
})

test("the loop slot cap is exactly 512 bytes and the 2 KiB cap is exact", () => {
  // Text values hold at most 32 letters, so build the loop from many two-letter keys. An entry costs 8 + its text length (key, quotes, colon, comma) and the braces cost 1 net, so each step takes at most 40 and leaves 0 or at least 9.
  const loopOfSize = (size) => {
    const loop = {}
    let remaining = size - 1
    for (let index = 0; remaining > 0; index += 1) {
      const key = `${"abcdefghijklmnopqrstuvwxyz"[index % 26]}${"abcdefghijklmnopqrstuvwxyz"[Math.floor(index / 26)]}`
      const take = remaining <= 40 ? remaining : remaining - 40 >= 9 ? 40 : remaining - 9
      loop[key] = "a".repeat(take - 8)
      remaining -= take
    }
    return loop
  }
  assert.equal(Buffer.byteLength(JSON.stringify(loopOfSize(512))), 512)
  assert.equal(Buffer.byteLength(JSON.stringify(loopOfSize(513))), 513)
  assert.deepEqual(validateCapture({ ...record({}), loop: loopOfSize(512) }), { ok: true, errors: [] })
  assert.deepEqual(validateCapture({ ...record({}), loop: loopOfSize(513) }).errors, [{ code: "size", path: "loop" }])
  // A full-size loop slot on a three-host record is valid and well under the cap, so no valid record reaches 2048 bytes.
  const full = { ...record({ "claude-code": claude(), "copilot-cli": copilot(), "codex-cli": copilot() }), loop: loopOfSize(500) }
  assert.equal(Buffer.byteLength(JSON.stringify(full)) < CAPTURE_MAX_BYTES, true)
  assert.deepEqual(validateCaptureBytes(JSON.stringify(full)), { ok: true, errors: [] })
  // The byte cap itself: exactly 2048 bytes passes the size rule, 2049 does not.
  assert.deepEqual(validateCaptureBytes(Buffer.alloc(CAPTURE_MAX_BYTES, " ")), { ok: false, errors: [{ code: "json", path: "" }] })
  assert.deepEqual(validateCaptureBytes(Buffer.alloc(CAPTURE_MAX_BYTES + 1, " ")), { ok: false, errors: [{ code: "size", path: "" }] })
})
