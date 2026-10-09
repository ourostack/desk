// Step bookkeeping for the factory loop: when each automatic step last ran,
// whether it succeeded, and which steps are due or stale. Every test runs
// against a throwaway state directory and a fake clock.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import { readStatus, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { MIN_GAP_HOURS, STEPS, dueStep, recordStep, staleSteps } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-loop-status-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  try {
    return await run(env)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const at = (iso) => new Date(iso)
const HOUR = 3600 * 1000

test("STEPS and MIN_GAP_HOURS are frozen and name the seven steps", () => {
  assert.deepEqual([...STEPS], ["evaluate", "route", "mirror", "reconcile", "verify", "measure", "deliver"])
  assert.ok(Object.isFrozen(STEPS))
  assert.ok(Object.isFrozen(MIN_GAP_HOURS))
  assert.deepEqual(MIN_GAP_HOURS, { evaluate: 1, route: 6, mirror: 6, reconcile: 24, verify: 24, measure: 0, deliver: 0 })
})

test("recordStep creates loop.steps.<name> on success and keeps other status keys", () => scratch(async (env) => {
  await writeStatus(env, { note: "kept", loop: { other: 1 } })
  const record = await recordStep(env, "route", { ok: true, result: "routed", now: at("2026-10-05T10:00:00Z") })
  assert.deepEqual(record, {
    last_ran_at: "2026-10-05T10:00:00.000Z",
    last_ok_at: "2026-10-05T10:00:00.000Z",
    last_result: "routed",
    runs: 1,
    failures: 0,
    failures_in_a_row: 0,
  })
  const status = await readStatus(env)
  assert.deepEqual(status.loop.steps.route, record)
  assert.equal(status.loop.other, 1)
  assert.equal(status.note, "kept")
}))

test("recordStep on failure raises the counters, keeps last_ok_at, and a success resets the streak", () => scratch(async (env) => {
  await recordStep(env, "verify", { ok: true, result: "done", now: at("2026-10-05T10:00:00Z") })
  const one = await recordStep(env, "verify", { ok: false, result: "gh_missing", now: at("2026-10-06T10:00:00Z") })
  assert.equal(one.last_ok_at, "2026-10-05T10:00:00.000Z")
  assert.equal(one.last_ran_at, "2026-10-06T10:00:00.000Z")
  assert.equal(one.last_result, "gh_missing")
  assert.equal(one.failures, 1)
  assert.equal(one.failures_in_a_row, 1)
  const two = await recordStep(env, "verify", { ok: false, result: "gh_missing", now: at("2026-10-07T10:00:00Z") })
  assert.equal(two.failures, 2)
  assert.equal(two.failures_in_a_row, 2)
  assert.equal(two.runs, 3)
  const three = await recordStep(env, "verify", { ok: true, result: "done", now: at("2026-10-08T10:00:00Z") })
  assert.equal(three.failures_in_a_row, 0)
  assert.equal(three.failures, 2)
  assert.equal(three.last_ok_at, "2026-10-08T10:00:00.000Z")
}))

test("a first failure leaves last_ok_at null, never looking like a success", () => scratch(async (env) => {
  const record = await recordStep(env, "mirror", { ok: false, result: "held_cap", now: at("2026-10-05T10:00:00Z") })
  assert.equal(record.last_ok_at, null)
  assert.equal(record.last_ran_at, "2026-10-05T10:00:00.000Z")
}))

test("recordStep accepts a timestamp string or number and defaults to the real clock", () => scratch(async (env) => {
  const a = await recordStep(env, "measure", { ok: true, result: "ok", now: "2026-10-05T10:00:00Z" })
  assert.equal(a.last_ran_at, "2026-10-05T10:00:00.000Z")
  const b = await recordStep(env, "measure", { ok: true, result: "ok", now: Date.parse("2026-10-05T11:00:00Z") })
  assert.equal(b.last_ran_at, "2026-10-05T11:00:00.000Z")
  const before = Date.now()
  const c = await recordStep(env, "measure", { ok: true, result: "ok" })
  assert.ok(Date.parse(c.last_ran_at) >= before)
}))

test("recordStep survives a status whose loop or steps are not objects", () => scratch(async (env) => {
  await writeStatus(env, { loop: "bad" })
  const a = await recordStep(env, "deliver", { ok: true, result: "ok", now: at("2026-10-05T10:00:00Z") })
  assert.equal(a.runs, 1)
  await writeStatus(env, { loop: { steps: { deliver: "bad" } } })
  const b = await recordStep(env, "deliver", { ok: true, result: "ok", now: at("2026-10-05T11:00:00Z") })
  assert.equal(b.runs, 1)
}))

test("recordStep refuses an unknown step, a free-text result, a long result, a non-boolean ok and a bad time", () => scratch(async (env) => {
  const now = at("2026-10-05T10:00:00Z")
  await assert.rejects(() => recordStep(env, "nope", { ok: true, result: "ok", now }), TypeError)
  await assert.rejects(() => recordStep(env, "__proto__", { ok: true, result: "ok", now }), TypeError)
  for (const result of ["Has Capitals", "has space", "path/to/x", "", "x".repeat(65), undefined, 7, "line\nbreak"]) {
    await assert.rejects(() => recordStep(env, "route", { ok: true, result, now }), TypeError, String(result))
  }
  await recordStep(env, "route", { ok: true, result: "x".repeat(64), now })
  await assert.rejects(() => recordStep(env, "route", { ok: "yes", result: "ok", now }), TypeError)
  await assert.rejects(() => recordStep(env, "route", { ok: true, result: "ok", now: "not a date" }), TypeError)
  await assert.rejects(() => recordStep(env, "route", undefined), TypeError)
  const status = await readStatus(env)
  assert.equal(status.loop.steps.route.runs, 1)
  assert.equal(status.loop.steps.nope, undefined)
}))

test("two concurrent recordStep calls both count", () => scratch(async (env) => {
  await Promise.all([
    recordStep(env, "route", { ok: true, result: "ok", now: at("2026-10-05T10:00:00Z") }),
    recordStep(env, "mirror", { ok: true, result: "ok", now: at("2026-10-05T10:00:00Z") }),
    recordStep(env, "route", { ok: true, result: "ok", now: at("2026-10-05T10:01:00Z") }),
  ])
  const { steps } = (await readStatus(env)).loop
  assert.equal(steps.route.runs, 2)
  assert.equal(steps.mirror.runs, 1)
}))

test("dueStep is true for a never-run step, false inside the gap and true after it", () => {
  const status = { last_flush: {}, loop: { steps: { route: { last_ran_at: "2026-10-05T10:00:00.000Z" } } } }
  assert.equal(dueStep({ last_flush: {} }, "route", at("2026-10-05T10:00:00Z")), true)
  assert.equal(dueStep({ last_flush: {}, loop: { steps: { route: { last_ran_at: null } } } }, "route", at("2026-10-05T10:00:00Z")), true)
  assert.equal(dueStep(status, "route", at("2026-10-05T10:00:00Z")), false)
  assert.equal(dueStep(status, "route", new Date(Date.parse("2026-10-05T10:00:00Z") + 6 * HOUR - 1)), false)
  assert.equal(dueStep(status, "route", new Date(Date.parse("2026-10-05T10:00:00Z") + 6 * HOUR)), true)
  const gapless = { loop: { steps: { measure: { last_ran_at: "2026-10-05T10:00:00.000Z" } } } }
  assert.equal(dueStep(gapless, "measure", at("2026-10-05T10:00:00Z")), true)
  assert.equal(dueStep(status, "route", "2026-10-06T10:00:00Z"), true)
})

test("dueStep treats an unreadable last_ran_at as never run and refuses an unknown step", () => {
  assert.equal(dueStep({ loop: { steps: { route: { last_ran_at: "garbage" } } } }, "route", at("2026-10-05T10:00:00Z")), true)
  assert.equal(dueStep({ loop: "bad" }, "route", at("2026-10-05T10:00:00Z")), true)
  assert.throws(() => dueStep({}, "nope", at("2026-10-05T10:00:00Z")), TypeError)
})

test("staleSteps returns an attempted step with an old last_ok_at or three failures in a row, and only attempted ones", () => {
  const now = at("2026-10-10T10:00:00Z")
  const ago = (hours) => new Date(now.getTime() - hours * HOUR).toISOString()
  const status = {
    loop: {
      steps: {
        route: { last_ok_at: ago(73), failures_in_a_row: 0 },
        mirror: { last_ok_at: ago(72), failures_in_a_row: 0 },
        verify: { last_ok_at: ago(1), failures_in_a_row: 3 },
        reconcile: { last_ok_at: ago(1), failures_in_a_row: 2 },
        evaluate: { last_ok_at: null, failures_in_a_row: 3 },
        deliver: { last_ok_at: null, failures_in_a_row: 1 },
        measure: "bad",
      },
    },
  }
  assert.deepEqual(staleSteps(status, now, ["route", "mirror", "verify", "reconcile", "evaluate", "deliver", "measure", "nope"]), ["route", "verify", "evaluate"])
  assert.deepEqual(staleSteps(status, now, []), [])
  assert.deepEqual(staleSteps(status, now, ["mirror", "reconcile"]), [])
  assert.deepEqual(staleSteps({ loop: "bad" }, now, ["route"]), [])
  // A success dated more than the window ahead of the clock (the clock moved back) has no knowable age: it reads stale, not fresh for days.
  const ahead = (hours) => new Date(now.getTime() + hours * HOUR).toISOString()
  const future = { loop: { steps: { route: { last_ok_at: ahead(73), failures_in_a_row: 0 }, mirror: { last_ok_at: ahead(2), failures_in_a_row: 0 } } } }
  assert.deepEqual(staleSteps(future, now, ["route", "mirror"]), ["route"])
  assert.deepEqual(staleSteps({}, now, ["route"]), [])
  assert.deepEqual(staleSteps({ loop: { steps: { route: { last_ok_at: ago(1) } } } }, now, ["route"]), [])
  assert.deepEqual(staleSteps({ loop: { steps: { route: { last_ok_at: "garbage", failures_in_a_row: 0 } } } }, now, ["route"]), ["route"])
  assert.deepEqual(staleSteps({ loop: { steps: { route: { last_ok_at: 5, failures_in_a_row: 0 } } } }, now, ["route"]), ["route"])
  assert.deepEqual(staleSteps(status, now.toISOString(), ["route"]), ["route"])
})

test("dueStep counts a last_ran_at in the future as due", () => {
  const status = { loop: { steps: { route: { last_ran_at: "2099-01-01T00:00:00.000Z" } } } }
  assert.equal(dueStep(status, "route", at("2026-10-05T10:00:00Z")), true)
})

test("recordStep refuses a null time rather than recording 1970", () => scratch(async (env) => {
  await assert.rejects(() => recordStep(env, "route", { ok: true, result: "ok", now: null }), TypeError)
  assert.equal((await readStatus(env)).loop, undefined)
  assert.throws(() => dueStep({}, "route", null), TypeError)
}))

test("recordStep restarts damaged counters from zero and never concatenates them", () => scratch(async (env) => {
  await writeStatus(env, { loop: { steps: { route: { runs: "1", failures: -2, failures_in_a_row: 1.5, last_ok_at: "2026-10-05T09:00:00.000Z" } } } })
  const record = await recordStep(env, "route", { ok: false, result: "bad", now: at("2026-10-05T10:00:00Z") })
  assert.equal(record.runs, 1)
  assert.equal(record.failures, 1)
  assert.equal(record.failures_in_a_row, 1)
  assert.equal(record.last_ok_at, "2026-10-05T09:00:00.000Z")
  await writeStatus(env, { loop: { steps: { route: { runs: Number.MAX_SAFE_INTEGER + 2 } } } })
  assert.equal((await recordStep(env, "route", { ok: true, result: "ok", now: at("2026-10-05T11:00:00Z") })).runs, 1)
}))

test("dueStep is due at once for work newer than the step's last run, whatever the gap, and only then", () => {
  const ran = "2026-10-05T10:00:00.000Z"
  const status = { loop: { steps: { evaluate: { last_ran_at: ran } } } }
  const now = at("2026-10-05T10:10:00Z")
  assert.equal(dueStep(status, "evaluate", now), false, "inside the 1-hour gap")
  assert.equal(dueStep(status, "evaluate", now, { newWorkAt: Date.parse(ran) + 1 }), true, "a request after the last run")
  assert.equal(dueStep(status, "evaluate", now, { newWorkAt: Date.parse(ran) }), false, "a request the last run already saw")
  assert.equal(dueStep(status, "evaluate", now, { newWorkAt: null }), false)
  assert.equal(dueStep(status, "evaluate", now, { newWorkAt: Number.NaN }), false, "a time that does not read makes nothing due")
  assert.equal(dueStep({}, "evaluate", now, { newWorkAt: 0 }), true, "a step that never ran is due anyway")
})
