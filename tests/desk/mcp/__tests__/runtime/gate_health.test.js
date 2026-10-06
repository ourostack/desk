// The done-claim gate's quiet failures are counted locally and shown by desk_doctor as a warning; nothing is ever blocked for them.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { GATE_HEALTH_FILE, GATE_HEALTH_WINDOW_MS, gateHealthSummary, readGateHealth, recordGateFailure } from "../../../../../plugins/desk/mcp/src/runtime/gate-health.js"
import { resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { doctorRuntime } from "../../../../../plugins/desk/mcp/src/tools/doctor.js"

const ROOT = mkdtempSync(path.join(tmpdir(), "gate-health-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = () => path.join(ROOT, `state-${(counter += 1)}`)
const at = (iso) => () => Date.parse(iso)

test("a failure is counted with its kind and time, and the count grows", () => {
  const stateDir = fresh()
  assert.equal(readGateHealth({ stateDir }), null)
  recordGateFailure("stop_error", { stateDir, now: at("2026-10-06T10:00:00Z") })
  assert.deepEqual(readGateHealth({ stateDir }), { count: 1, last_at: "2026-10-06T10:00:00.000Z", last_kind: "stop_error", lost_history: false })
  recordGateFailure("wrapper_error", { stateDir, now: at("2026-10-06T11:00:00Z") })
  assert.deepEqual(readGateHealth({ stateDir }), { count: 2, last_at: "2026-10-06T11:00:00.000Z", last_kind: "wrapper_error", lost_history: false })
})

test("the summary is a warning with the count and the last time, singular or plural, and goes quiet after a week", () => {
  const stateDir = fresh()
  assert.equal(gateHealthSummary({ stateDir }), null, "no record, no section")
  recordGateFailure("record_failed", { stateDir, now: at("2026-10-06T10:00:00Z") })
  const one = gateHealthSummary({ stateDir, now: at("2026-10-07T10:00:00Z") })
  assert.match(one, /^Done-claim gate\n {2}warning: 1 quiet failure \(last record_failed at 2026-10-06T10:00:00\.000Z\)/u)
  recordGateFailure("record_failed", { stateDir, now: at("2026-10-06T12:00:00Z") })
  assert.match(gateHealthSummary({ stateDir, now: at("2026-10-07T10:00:00Z") }), /warning: 2 quiet failures \(/u)
  assert.equal(gateHealthSummary({ stateDir, now: () => Date.parse("2026-10-06T12:00:00Z") + GATE_HEALTH_WINDOW_MS + 1 }), null, "an old failure no longer warns")
})

test("the summary says what the last failure means, per kind", () => {
  const meanings = { stop_error: /blocked it once/u, record_failed: /not recorded.*unchecked/u, wrapper_error: /wrapper failed.*unchecked/u, reply_unread: /long Copilot transcript.*unchecked/u, something_new: /could not check a reply/u }
  for (const [kind, meaning] of Object.entries(meanings)) {
    const stateDir = fresh()
    recordGateFailure(kind, { stateDir, now: at("2026-10-06T10:00:00Z") })
    const summary = gateHealthSummary({ stateDir, now: at("2026-10-06T11:00:00Z") })
    assert.match(summary, meaning, kind)
    assert.doesNotMatch(summary, /nothing was blocked/u)
  }
  const stateDir = fresh()
  mkdirSync(stateDir, { recursive: true })
  writeFileSync(path.join(stateDir, GATE_HEALTH_FILE), JSON.stringify({ count: 3, last_at: "2026-10-06T10:00:00.000Z" }))
  assert.equal(readGateHealth({ stateDir }).last_kind, "unknown")
})

test("a corrupt record is reported as unreadable, never as a time or a count, and the next failure keeps it and says history was lost", () => {
  const stateDir = fresh()
  mkdirSync(stateDir, { recursive: true })
  const file = path.join(stateDir, GATE_HEALTH_FILE)
  for (const text of ["{{{", "null", JSON.stringify({ count: 0, last_at: "2026-10-06T10:00:00Z" }), JSON.stringify({ count: 2 }), JSON.stringify({ count: 2, last_at: "garbage" })]) {
    writeFileSync(file, text)
    assert.deepEqual(readGateHealth({ stateDir }), { unreadable: true }, text)
    const summary = gateHealthSummary({ stateDir })
    assert.match(summary, /^Done-claim gate\n {2}warning: the failure record \(done-gate-failures\.json\) is unreadable/u, text)
    assert.doesNotMatch(summary, /garbage/u)
  }
  writeFileSync(file, "{{{")
  recordGateFailure("stop_error", { stateDir, now: at("2026-10-06T10:00:00Z") })
  assert.equal(readFileSync(`${file}.unreadable`, "utf8"), "{{{", "the unreadable file is set aside, not erased")
  assert.deepEqual(readGateHealth({ stateDir }), { count: 1, last_at: "2026-10-06T10:00:00.000Z", last_kind: "stop_error", lost_history: true })
  assert.match(gateHealthSummary({ stateDir, now: at("2026-10-06T11:00:00Z") }), /earlier history was unreadable and was set aside/u)
  recordGateFailure("stop_error", { stateDir, now: at("2026-10-06T12:00:00Z") })
  assert.equal(readGateHealth({ stateDir }).lost_history, true, "the note stays")
  assert.equal(readGateHealth({ stateDir }).count, 2)
  // A file that cannot be read at all (a folder where it should be) is unreadable too, and a record that cannot be written is swallowed.
  const odd = fresh()
  mkdirSync(path.join(odd, GATE_HEALTH_FILE), { recursive: true })
  assert.deepEqual(readGateHealth({ stateDir: odd }), { unreadable: true })
  const blocked = path.join(ROOT, "a-file")
  writeFileSync(blocked, "x")
  assert.doesNotThrow(() => recordGateFailure("stop_error", { stateDir: path.join(blocked, "inside") }))
  assert.equal(existsSync(path.join(blocked, "inside")), false)
})

test("the default state folder comes from the environment", () => {
  const home = fresh()
  const env = { HOME: home, XDG_STATE_HOME: home }
  recordGateFailure("stop_error", { env })
  assert.equal(readGateHealth({ env }).count, 1)
  assert.equal(readGateHealth({ stateDir: resolveDeskStateDir({ env }) }).count, 1)
  assert.match(gateHealthSummary({ env }), /^Done-claim gate/u)
})

test("desk_doctor shows the warning only while there is a recent failure, and leaves the rest of its summary alone", () => {
  const home = fresh()
  const env = { HOME: home, XDG_STATE_HOME: home }
  assert.equal(doctorRuntime({ input: {}, env }).summary, "Desk MCP runtime dependencies are ready.")
  recordGateFailure("stop_error", { env })
  const summary = doctorRuntime({ input: {}, env }).summary
  assert.match(summary, /^Desk MCP runtime dependencies are ready\.\n\n(?:.|\n)*Done-claim gate\n {2}warning: 1 quiet failure/u)
})
