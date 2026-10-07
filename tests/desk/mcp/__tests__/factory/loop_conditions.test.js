// The loop's conditions record: for each card key, whether its condition held at the last successful
// observation and how many counted observations in a row it has been clear. Every test runs against a
// throwaway state directory and a fake clock.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import { readStatus, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { MAX_CONDITIONS, MIN_OBSERVATION_GAP_HOURS, conditionOf, observeConditions } from "../../../../../plugins/desk/mcp/src/factory/loop-conditions.js"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-loop-conditions-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  try {
    return await run(env)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const HOUR = 3600 * 1000
const T0 = Date.parse("2026-10-05T00:00:00Z")
const at = (hours) => new Date(T0 + hours * HOUR)
const FLUSH = ["no_account", "frozen", "gh_missing"]

test("the minimum gap is a named number of hours and the bound is a named count", () => {
  assert.equal(MIN_OBSERVATION_GAP_HOURS, 6)
  assert.equal(MAX_CONDITIONS, 500)
})

test("a present id is recorded as present with no clear runs", () => scratch(async (env) => {
  const out = await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0) })
  assert.deepEqual(out, { ok: true, result: "observed" })
  const status = await readStatus(env)
  assert.deepEqual(conditionOf(status, "flush_health:frozen"), { state: "measured", present: true, clear_runs: 0, observed_at: at(0).toISOString() })
}))

test("an id that stops being present counts clear runs, one per observation past the gap", () => scratch(async (env) => {
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0) })
  assert.deepEqual(await observeConditions(env, { source: "flush_health", present: [], now: at(7) }), { ok: true, result: "observed" })
  let c = conditionOf(await readStatus(env), "flush_health:frozen")
  assert.equal(c.present, false)
  assert.equal(c.clear_runs, 1)
  assert.equal(c.observed_at, at(7).toISOString())
  await observeConditions(env, { source: "flush_health", present: [], now: at(14) })
  c = conditionOf(await readStatus(env), "flush_health:frozen")
  assert.equal(c.clear_runs, 2)
}))

test("two looks inside the minimum gap count once", () => scratch(async (env) => {
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0) })
  await observeConditions(env, { source: "flush_health", present: [], now: at(7) })
  const again = await observeConditions(env, { source: "flush_health", present: [], now: at(7.5) })
  assert.deepEqual(again, { ok: true, result: "observed_within_gap" })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 1)
  await observeConditions(env, { source: "flush_health", present: [], now: at(12.99) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 1)
  await observeConditions(env, { source: "flush_health", present: [], now: at(13) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 2)
}))

test("a look inside the gap that finds the condition present still records it, and the next clear look starts from zero", () => scratch(async (env) => {
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0) })
  await observeConditions(env, { source: "flush_health", present: [], now: at(7) })
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(8) })
  let c = conditionOf(await readStatus(env), "flush_health:frozen")
  assert.deepEqual([c.present, c.clear_runs], [true, 0])
  await observeConditions(env, { source: "flush_health", present: [], now: at(9) })
  c = conditionOf(await readStatus(env), "flush_health:frozen")
  assert.deepEqual([c.present, c.clear_runs], [false, 0])
  await observeConditions(env, { source: "flush_health", present: [], now: at(15) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 1)
}))

test("an observation touches only keys of its own source", () => scratch(async (env) => {
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0) })
  await observeConditions(env, { source: "loop_alarm", present: ["headless_blocked"], now: at(0) })
  await observeConditions(env, { source: "loop_alarm", present: [], now: at(7) })
  const status = await readStatus(env)
  assert.equal(conditionOf(status, "flush_health:frozen").present, true)
  assert.equal(conditionOf(status, "loop_alarm:headless_blocked").clear_runs, 1)
}))

test("present ids are deduplicated and other status keys are kept", () => scratch(async (env) => {
  await writeStatus(env, { note: "kept", loop: { steps: { route: 1 } } })
  const out = await observeConditions(env, { source: "flush_health", present: ["frozen", "frozen", "gh_missing"], now: at(0) })
  assert.equal(out.ok, true)
  const status = await readStatus(env)
  assert.equal(status.note, "kept")
  assert.deepEqual(status.loop.steps, { route: 1 })
  assert.deepEqual(Object.keys(status.loop.conditions).sort(), ["flush_health:frozen", "flush_health:gh_missing"])
}))

test("anything that is not a well-formed key is refused and nothing is written", () => scratch(async (env) => {
  await writeStatus(env, { loop: {} })
  const before = await readStatus(env)
  for (const present of [["not_a_code"], [""], [5], ["frozen", "../x"]]) {
    assert.deepEqual(await observeConditions(env, { source: "flush_health", present, now: at(0) }), { ok: false, result: "invalid_key" })
  }
  assert.deepEqual(await observeConditions(env, { source: "bogus", present: [], now: at(0) }), { ok: false, result: "invalid_source" })
  assert.deepEqual(await observeConditions(env, { source: 7, present: [], now: at(0) }), { ok: false, result: "invalid_source" })
  assert.deepEqual(await observeConditions(env, { source: "flush_health", present: "frozen", now: at(0) }), { ok: false, result: "invalid_present" })
  assert.deepEqual(await observeConditions(env, { source: "flush_health", now: at(0) }), { ok: false, result: "invalid_present" })
  assert.deepEqual(await observeConditions(env, { source: "flush_health", present: [], now: "not a time" }), { ok: false, result: "invalid_time" })
  assert.deepEqual(await observeConditions(env, { source: "flush_health", present: [], now: null }), { ok: false, result: "invalid_time" })
  assert.deepEqual(await readStatus(env), before)
}))

test("now defaults to the current time", () => scratch(async (env) => {
  await observeConditions(env, { source: "flush_health", present: ["frozen"] })
  const c = conditionOf(await readStatus(env), "flush_health:frozen")
  assert.ok(Math.abs(Date.parse(c.observed_at) - Date.now()) < 60 * 1000)
}))

test("a headless factory session writes nothing", () => scratch(async (env) => {
  const headless = { ...env, DESK_FACTORY_HEADLESS: "1" }
  assert.deepEqual(await observeConditions(headless, { source: "flush_health", present: ["frozen"], now: at(0) }), { ok: false, result: "headless_session" })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").state, "unavailable")
}))

test("a status that cannot be written gives a code, not an exception", async () => {
  const updateStatusImpl = async () => { throw new Error("secret /Users/x/path") }
  const out = await observeConditions({}, { source: "flush_health", present: [], now: at(0), updateStatusImpl })
  assert.deepEqual(out, { ok: false, result: "status_unwritable" })
})

test("updateStatusImpl receives the env and a mutator", async () => {
  let seen
  const impl = async (env, mutate) => { seen = { env, next: mutate({ last_flush: {} }) } }
  const env = { A: "1" }
  const out = await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0), updateStatusImpl: impl })
  assert.deepEqual(out, { ok: true, result: "observed" })
  assert.equal(seen.env, env)
  assert.equal(seen.next.loop.conditions["flush_health:frozen"].present, true)
})

test("conditionOf reads a missing entry as not_observed and never as clear", () => {
  assert.deepEqual(conditionOf({}, "flush_health:frozen"), { state: "unavailable", reason: "not_observed" })
  assert.deepEqual(conditionOf(null, "flush_health:frozen"), { state: "unavailable", reason: "not_observed" })
  assert.deepEqual(conditionOf({ loop: { conditions: {} } }, "flush_health:frozen"), { state: "unavailable", reason: "not_observed" })
  assert.deepEqual(conditionOf({ loop: 4 }, "flush_health:frozen"), { state: "unavailable", reason: "not_observed" })
  assert.deepEqual(conditionOf({ loop: { conditions: {} } }, "bogus"), { state: "unavailable", reason: "not_observed" })
})

test("conditionOf reads a damaged entry or record as damaged", () => {
  const ok = { present: false, clear_runs: 2, observed_at: "2026-10-05T00:00:00.000Z" }
  const read = (entry) => conditionOf({ loop: { conditions: { "flush_health:frozen": entry } } }, "flush_health:frozen")
  assert.equal(read(ok).state, "measured")
  for (const bad of [null, 3, "x", [], { ...ok, present: "no" }, { ...ok, clear_runs: -1 }, { ...ok, clear_runs: 1.5 }, { ...ok, clear_runs: "2" }, { ...ok, observed_at: "nope" }, { ...ok, observed_at: 5 }, { present: true, clear_runs: 3, observed_at: ok.observed_at }]) {
    assert.deepEqual(read(bad), { state: "unavailable", reason: "damaged" })
  }
  assert.deepEqual(conditionOf({ loop: { conditions: "x" } }, "flush_health:frozen"), { state: "unavailable", reason: "damaged" })
  assert.deepEqual(conditionOf({ loop: { conditions: [] } }, "flush_health:frozen"), { state: "unavailable", reason: "damaged" })
})

test("a damaged entry for an absent id is left damaged, never turned into a clear one; a present id repairs it", () => scratch(async (env) => {
  await writeStatus(env, { loop: { conditions: { "flush_health:frozen": { present: "x" }, "flush_health:gh_missing": 5 } } })
  await observeConditions(env, { source: "flush_health", present: ["gh_missing"], now: at(0) })
  const status = await readStatus(env)
  assert.deepEqual(conditionOf(status, "flush_health:frozen"), { state: "unavailable", reason: "damaged" })
  assert.equal(conditionOf(status, "flush_health:gh_missing").present, true)
}))

test("a damaged conditions record is replaced by the new observation and does not read as clear", () => scratch(async (env) => {
  await writeStatus(env, { loop: { conditions: "broken" } })
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0) })
  const status = await readStatus(env)
  assert.equal(conditionOf(status, "flush_health:frozen").present, true)
  assert.equal(conditionOf(status, "flush_health:no_account").reason, "not_observed")
}))

test("an entry without a counted time (older shape) counts on the next look", () => scratch(async (env) => {
  await writeStatus(env, { loop: { conditions: { "flush_health:frozen": { present: false, clear_runs: 1, observed_at: at(0).toISOString() } } } })
  await observeConditions(env, { source: "flush_health", present: [], now: at(7) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 2)
}))

test("a clock that went backwards does not count, and the stamp is pulled back so counting resumes after one gap", () => scratch(async (env) => {
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(10) })
  assert.deepEqual(await observeConditions(env, { source: "flush_health", present: [], now: at(1) }), { ok: true, result: "observed_within_gap" })
  let c = conditionOf(await readStatus(env), "flush_health:frozen")
  assert.deepEqual([c.present, c.clear_runs], [false, 0])
  await observeConditions(env, { source: "flush_health", present: [], now: at(6.9) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 0)
  await observeConditions(env, { source: "flush_health", present: [], now: at(7) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 1)
}))

test("an entry dated in the future does not count a clear run", () => scratch(async (env) => {
  const future = at(100).toISOString()
  await writeStatus(env, { loop: { conditions: { "flush_health:frozen": { present: false, clear_runs: 1, observed_at: future, counted_at: future } } } })
  await observeConditions(env, { source: "flush_health", present: [], now: at(0) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 1)
  await observeConditions(env, { source: "flush_health", present: [], now: at(6) })
  assert.equal(conditionOf(await readStatus(env), "flush_health:frozen").clear_runs, 2)
}))

test("an id that is not a string is refused", () => scratch(async (env) => {
  const odd = { toString: () => "frozen" }
  assert.deepEqual(await observeConditions(env, { source: "desk_problem", present: [odd], now: at(0) }), { ok: false, result: "invalid_key" })
  assert.deepEqual(await observeConditions(env, { source: "flush_health", present: [odd], now: at(0) }), { ok: false, result: "invalid_key" })
  assert.deepEqual(await observeConditions(env, { source: "desk_problem", present: [["ourostack/desk#13"]], now: at(0) }), { ok: false, result: "invalid_key" })
}))

test("stored times must match the factory timestamp pattern", () => {
  const read = (observed_at) => conditionOf({ loop: { conditions: { "flush_health:frozen": { present: false, clear_runs: 0, observed_at } } } }, "flush_health:frozen")
  assert.equal(read("2026-10-05T00:00:00.000Z").state, "measured")
  for (const bad of ["1", "2026-10-05", "2026-10-05T00:00:00Z", "Oct 5 2026", "2026-13-45T00:00:00.000Z"]) assert.equal(read(bad).reason, "damaged")
})

test("the record is bounded: damaged entries go first, then the oldest observed; present keys are never dropped", () => scratch(async (env) => {
  const conditions = {}
  for (let i = 0; i < MAX_CONDITIONS; i++) conditions[`reconcile_class:code_${i}`] = { present: false, clear_runs: i % 5, observed_at: at(i === 3 ? -9 : 0).toISOString() }
  conditions["junk"] = 1
  conditions["flush_health:frozen"] = { present: true, clear_runs: 0, observed_at: at(-99).toISOString() }
  await writeStatus(env, { loop: { conditions } })
  const out = await observeConditions(env, { source: "flush_health", present: ["frozen", "gh_missing"], now: at(1) })
  assert.deepEqual(out, { ok: true, result: "observed" })
  const kept = (await readStatus(env)).loop.conditions
  assert.equal(Object.keys(kept).length, MAX_CONDITIONS)
  assert.equal("junk" in kept, false)
  assert.equal("reconcile_class:code_3" in kept, false)
  assert.equal("reconcile_class:code_0" in kept, false)
  assert.equal("reconcile_class:code_4" in kept, true)
  assert.equal(kept["flush_health:frozen"].present, true)
  assert.equal(kept["flush_health:gh_missing"].present, true)
}))

test("when present keys alone exceed the bound, none of them is dropped", () => scratch(async (env) => {
  const many = []
  for (let i = 0; i < MAX_CONDITIONS + 3; i++) many.push(`ourostack/desk#${i + 1}`)
  const out = await observeConditions(env, { source: "desk_problem", present: many, now: at(0) })
  assert.deepEqual(out, { ok: true, result: "observed" })
  assert.equal(Object.keys((await readStatus(env)).loop.conditions).length, MAX_CONDITIONS + 3)
}))

test("bounding ties on the observation time keep the key with fewer clear runs", () => scratch(async (env) => {
  const conditions = {}
  for (let i = 0; i < MAX_CONDITIONS; i++) conditions[`reconcile_class:code_${i}`] = { present: false, clear_runs: i === 7 ? 4 : 1, observed_at: at(0).toISOString() }
  await writeStatus(env, { loop: { conditions } })
  await observeConditions(env, { source: "flush_health", present: ["frozen"], now: at(0.5) })
  const kept = (await readStatus(env)).loop.conditions
  assert.equal(Object.keys(kept).length, MAX_CONDITIONS)
  assert.equal("reconcile_class:code_7" in kept, true)
}))
