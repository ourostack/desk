// The scheduled reconcile step: which desks it reconciles, what it keeps from the result, and how a run that
// did not happen differs from a run that found nothing. Every test uses a throwaway state directory, a fake clock
// and a fake `reconcileImpl`; nothing reads a real desk.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { createHash } from "node:crypto"

import { readStatus, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { RECONCILE_REASONS } from "../../../../../plugins/desk/mcp/src/factory/reconcile-reasons.js"
import {
  DESK_STALE_DAYS, MAX_RECONCILE_DESKS, RECONCILE_CONFIRM_RUNS, RECONCILE_WINDOW_DAYS, runReconcileStep, summarizeReconcile,
} from "../../../../../plugins/desk/mcp/src/factory/reconcile-step.js"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-reconcile-step-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run(env)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const HOUR = 3600 * 1000
const NOW = new Date("2026-10-05T12:00:00Z")
const later = (hours) => new Date(NOW.getTime() + hours * HOUR)
const receipts = (...roots) => ({ derivations: Object.fromEntries(roots.map((root, i) => [`s${i}.json`, { desk_root: root }])) })
const clean = { ok: true, counts: { by_reason: {} }, tasks: [], mismatches: [] }
const withReasons = (by_reason, extra = {}) => ({ ok: true, counts: { by_reason }, tasks: [{ track: "secret-track", slug: "secret-slug" }], mismatches: [{ reason: "pr_open", detail: "/Users/x/desk" }], ...extra })

function fake(results) {
  const calls = []
  const impl = (options) => {
    calls.push(options)
    const next = typeof results === "function" ? results(options, calls.length) : results
    if (next instanceof Error) throw next
    return next
  }
  return { impl, calls }
}

test("constants name the schedule", () => {
  assert.equal(RECONCILE_WINDOW_DAYS, 7)
  assert.equal(RECONCILE_CONFIRM_RUNS, 2)
  assert.equal(MAX_RECONCILE_DESKS, 3)
})

test("up to three due desks are reconciled; a fourth is never reached; a desk done 2 hours ago is skipped", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a", "/d/b", "/d/c", "/d/d"))
  const first = fake(clean)
  const run = await runReconcileStep(env, { now: NOW, reconcileImpl: first.impl })
  assert.deepEqual(run, { ok: true, result: "reconciled" })
  assert.equal(first.calls.length, 3)
  assert.equal(new Set(first.calls.map((call) => call.deskRoot)).size, 3)
  assert.equal(first.calls[0].until, NOW.toISOString())
  assert.equal(first.calls[0].since, new Date(NOW.getTime() - 7 * 24 * HOUR).toISOString())
  assert.equal((await readStatus(env)).reconcile.desks, 3)
  // two hours later: the three are skipped, the fourth is reconciled
  const second = fake(clean)
  await runReconcileStep(env, { now: later(2), reconcileImpl: second.impl })
  assert.equal(second.calls.length, 1)
  assert.equal(second.calls[0].deskRoot, first.calls.length === 3 ? ["/d/a", "/d/b", "/d/c", "/d/d"].find((root) => !first.calls.some((call) => call.deskRoot === root)) : null)
  // 25 hours after the start every desk is due again
  const third = fake(clean)
  await runReconcileStep(env, { now: later(26), reconcileImpl: third.impl })
  assert.equal(third.calls.length, 3)
}))

test("two desks are both reconciled and their counts add up as one run", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a", "/d/b", "/d/a"))
  const { impl, calls } = fake((options) => withReasons(options.deskRoot === "/d/a" ? { pr_open: 2, held: 1 } : { pr_open: 1 }))
  await runReconcileStep(env, { now: NOW, reconcileImpl: impl, personPrefix: "ari" })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].personPrefix, "ari")
  const { reconcile } = await readStatus(env)
  assert.equal(reconcile.desks, 2)
  assert.deepEqual(reconcile.runs.pr_open, { consecutive: 1, count: 3, clear: 0 })
  assert.deepEqual(reconcile.runs.held, { consecutive: 1, count: 1, clear: 0 })
}))

test("an explicit desk list replaces the receipts and nothing due is a skipped run", () => scratch(async (env) => {
  const one = fake(clean)
  assert.deepEqual(await runReconcileStep(env, { now: NOW, reconcileImpl: one.impl, desks: ["/x/only"] }), { ok: true, result: "reconciled" })
  assert.equal(one.calls[0].deskRoot, "/x/only")
  const none = fake(clean)
  assert.deepEqual(await runReconcileStep(env, { now: later(1), reconcileImpl: none.impl, desks: ["/x/only"] }), { ok: true, result: "nothing_due" })
  assert.equal(none.calls.length, 0)
  const status = await readStatus(env)
  assert.equal(status.reconcile.last_result, "nothing_due")
  assert.equal(status.reconcile.at, NOW.toISOString())
  assert.equal(status.reconcile.desks, 1)
}))

test("no receipts, a non-object receipt, a relative root and a missing derivations map give no desks and no summary of a finding", () => scratch(async (env) => {
  const never = fake(clean)
  assert.deepEqual(await runReconcileStep(env, { now: NOW, reconcileImpl: never.impl }), { ok: true, result: "no_desks" })
  await writeStatus(env, { derivations: { "a.json": 5, "b.json": { desk_root: "relative/path" }, "c.json": { desk_root: 7 } } })
  assert.deepEqual(await runReconcileStep(env, { now: NOW, reconcileImpl: never.impl }), { ok: true, result: "no_desks" })
  assert.equal(never.calls.length, 0)
  const { reconcile } = await readStatus(env)
  assert.deepEqual(reconcile, { at: null, window_days: 7, desks_known: 0, desks: 0, desks_failed: 0, runs: {}, warnings: [], last_result: "no_desks", report_link_unavailable: null })
}))

test("the summary holds counts and codes only, by a deep scan", () => scratch(async (env) => {
  await writeStatus(env, receipts("/Users/someone/secret-desk"))
  const { impl } = fake(withReasons({ pr_open: 1 }, { warnings: ["consent_unreadable", "Not A Code /Users/x", "status_unreadable", "status_unreadable"] }))
  await runReconcileStep(env, { now: NOW, reconcileImpl: impl })
  const { reconcile } = await readStatus(env)
  assert.deepEqual(Object.keys(reconcile).sort(), ["at", "desks", "desks_failed", "desks_known", "last_result", "report_link_unavailable", "runs", "warnings", "window_days"])
  assert.deepEqual(reconcile.warnings, ["consent_unreadable", "unknown_warning", "status_unreadable"])
  const strings = []
  const walk = (value, key) => {
    if (key !== undefined) strings.push(key)
    if (typeof value === "string") strings.push(value)
    else if (value !== null && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k)
  }
  walk(reconcile)
  for (const text of strings) assert.ok(!/[\/\\]|secret|someone|\s/.test(text), text)
}))

test("path-keyed bookkeeping stays outside the summary and holds no path", () => scratch(async (env) => {
  await writeStatus(env, receipts("/Users/someone/secret-desk"))
  await runReconcileStep(env, { now: NOW, reconcileImpl: fake(clean).impl })
  const status = await readStatus(env)
  const keys = Object.keys(status.loop.reconcile_desks)
  assert.equal(keys.length, 1)
  assert.match(keys[0], /^[0-9a-f]{16}$/)
  assert.equal(status.loop.reconcile_desks[keys[0]].at, NOW.toISOString())
  assert.ok(!JSON.stringify(status.reconcile).includes(keys[0]))
}))

test("consecutive rises across runs for a repeating reason, resets when it disappears and rises again from 1", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  const run = async (hours, byReason) => {
    await runReconcileStep(env, { now: later(hours), reconcileImpl: fake(withReasons(byReason)).impl })
    return (await readStatus(env)).reconcile.runs
  }
  assert.deepEqual((await run(0, { pr_open: 2 })).pr_open, { consecutive: 1, count: 2, clear: 0 })
  assert.deepEqual((await run(25, { pr_open: 1 })).pr_open, { consecutive: 2, count: 1, clear: 0 })
  assert.deepEqual((await run(50, {})).pr_open, { consecutive: 0, count: 0, clear: 1 })
  assert.deepEqual((await run(75, {})).pr_open, { consecutive: 0, count: 0, clear: 2 })
  assert.deepEqual((await run(100, { pr_open: 4 })).pr_open, { consecutive: 1, count: 4, clear: 0 })
}))

test("a reason outside the list is counted under one fixed code, never passed through", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  const known = RECONCILE_REASONS[0]
  await runReconcileStep(env, { now: NOW, reconcileImpl: fake(withReasons({ [known]: 1, "totally new /path": 2, another: 3 })).impl })
  const { runs } = (await readStatus(env)).reconcile
  assert.deepEqual(Object.keys(runs).sort(), [known, "unknown_reason"].sort())
  assert.deepEqual(runs.unknown_reason, { consecutive: 1, count: 5, clear: 0 })
}))

test("every reason in the shared list is counted under its own code", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  await runReconcileStep(env, { now: NOW, reconcileImpl: fake(withReasons(Object.fromEntries(RECONCILE_REASONS.map((reason) => [reason, 1])))).impl })
  assert.deepEqual(Object.keys((await readStatus(env)).reconcile.runs).sort(), [...RECONCILE_REASONS].sort())
}))

test("a failed result keeps the previous summary, records reconcile_failed and stamps no desk", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  await runReconcileStep(env, { now: NOW, reconcileImpl: fake(withReasons({ held: 2 })).impl })
  const before = (await readStatus(env)).reconcile
  const failed = await runReconcileStep(env, { now: later(30), reconcileImpl: fake({ ok: false, error: "reconcile: the desk folder could not be read" }).impl })
  assert.deepEqual(failed, { ok: false, result: "reconcile_failed" })
  const status = await readStatus(env)
  assert.deepEqual({ ...status.reconcile, last_result: before.last_result }, before)
  assert.equal(status.reconcile.last_result, "reconcile_failed")
  assert.equal(status.loop.steps.reconcile.last_result, "reconcile_failed")
  assert.equal(status.loop.steps.reconcile.failures_in_a_row, 1)
  // the desk is retried at once, since a failure stamps nothing
  const retry = fake(clean)
  await runReconcileStep(env, { now: later(31), reconcileImpl: retry.impl })
  assert.equal(retry.calls.length, 1)
}))

test("a first failure writes an empty summary with no completed run, not a clean one", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  await runReconcileStep(env, { now: NOW, reconcileImpl: fake({ ok: false }).impl })
  assert.deepEqual((await readStatus(env)).reconcile, { at: null, window_days: 7, desks_known: 0, desks: 0, desks_failed: 0, runs: {}, warnings: [], last_result: "reconcile_failed", report_link_unavailable: null })
}))

test("a thrown error, an invalid result and a Git failure are ok false with a code and never throw", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  const code = async (result, hours) => (await runReconcileStep(env, { now: later(hours), reconcileImpl: fake(result).impl }))
  assert.deepEqual(await code(new Error("boom /Users/x"), 0), { ok: false, result: "reconcile_failed" })
  assert.deepEqual(await code(null, 1), { ok: false, result: "reconcile_invalid" })
  assert.deepEqual(await code({ ok: true }, 2), { ok: false, result: "reconcile_invalid" })
  assert.deepEqual(await code({ ok: true, counts: { by_reason: [] } }, 3), { ok: false, result: "reconcile_invalid" })
  assert.deepEqual(await code({ ok: true, counts: { by_reason: { held: -1 } } }, 4), { ok: false, result: "reconcile_invalid" })
  assert.deepEqual(await code({ ok: true, counts: { by_reason: {} }, warnings: "x" }, 5), { ok: false, result: "reconcile_invalid" })
  assert.deepEqual(await code({ ok: true, counts: { by_reason: {} }, warnings: ["git_log_failed"] }, 6), { ok: false, result: "git_failed" })
  const status = await readStatus(env)
  assert.equal(status.reconcile.at, null)
  assert.equal(status.loop.steps.reconcile.failures_in_a_row, 7)
}))

test("one unreadable desk among readable ones is a completed run that says so", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a", "/d/b"))
  const { impl } = fake((options) => (options.deskRoot === "/d/a" ? { ok: false } : withReasons({ held: 1 })))
  assert.deepEqual(await runReconcileStep(env, { now: NOW, reconcileImpl: impl }), { ok: true, result: "reconciled_some_failed" })
  const { reconcile } = await readStatus(env)
  assert.deepEqual([reconcile.desks_known, reconcile.desks, reconcile.desks_failed], [2, 1, 1])
  assert.deepEqual(reconcile.warnings, ["desk_unreadable"])
  assert.equal(reconcile.runs.held.count, 1)
}))

test("the step records itself through recordStep with the result code", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  await runReconcileStep(env, { now: NOW, reconcileImpl: fake(clean).impl })
  let step = (await readStatus(env)).loop.steps.reconcile
  assert.deepEqual(step, { last_ran_at: NOW.toISOString(), last_ok_at: NOW.toISOString(), last_result: "reconciled", runs: 1, failures: 0, failures_in_a_row: 0 })
  await runReconcileStep(env, { now: later(1), reconcileImpl: fake(clean).impl })
  step = (await readStatus(env)).loop.steps.reconcile
  assert.equal(step.last_result, "nothing_due")
  assert.equal(step.runs, 2)
}))

test("an unreadable or unwritable status is a coded failure, not a throw", async () => {
  const blocked = { HOME: "/nonexistent-reconcile-step-home", XDG_STATE_HOME: "/dev/null/state" }
  const result = await runReconcileStep(blocked, { now: NOW, reconcileImpl: fake(clean).impl, desks: ["/d/a"] })
  assert.equal(result.ok, false)
  assert.match(result.result, /^status_(unavailable|write_failed)$/)
})

test("a status write that fails after the run is a coded failure, and a failed bookkeeping write is swallowed", () => scratch(async (env) => {
  await writeStatus(env, receipts("/d/a"))
  const broken = async () => { throw new Error("disk full /Users/x") }
  assert.deepEqual(await runReconcileStep(env, { now: NOW, reconcileImpl: fake(clean).impl, updateStatusImpl: broken, recordStepImpl: broken }), { ok: false, result: "status_write_failed" })
  assert.equal((await readStatus(env)).reconcile, undefined)
}))

test("an invalid clock is refused by name before anything runs", () => scratch(async (env) => {
  await assert.rejects(() => runReconcileStep(env, { now: "not a time", reconcileImpl: fake(clean).impl }), /now/)
}))

test("summarizeReconcile keeps counts and codes only", () => {
  assert.deepEqual(summarizeReconcile(withReasons({ held: 2, weird: 1 }, { warnings: ["a_code"] })), { counts: { held: 2, unknown_reason: 1 }, warnings: ["a_code"], links: null })
  assert.deepEqual(summarizeReconcile({ ok: true, counts: { by_reason: { held: 0 } } }), { counts: {}, warnings: [], links: null })
  assert.equal(summarizeReconcile({ ok: false }), null)
})

const keyOf = (root) => createHash("sha256").update(root).digest("hex").slice(0, 16)
const only = (byDesk) => (options) => withReasons(byDesk[options.deskRoot] ?? {})

test("a desk that was skipped keeps its streak: a run over another desk does not reset it", () => scratch(async (env) => {
  const desks = ["/d/a", "/d/b", "/d/c", "/d/d"]
  const by = { "/d/a": { held: 2 } }
  await runReconcileStep(env, { now: NOW, reconcileImpl: only(by), desks })
  assert.deepEqual((await readStatus(env)).reconcile.runs.held, { consecutive: 1, count: 2, clear: 0 })
  const second = fake(only(by))
  await runReconcileStep(env, { now: later(2), reconcileImpl: second.impl, desks })
  assert.deepEqual(second.calls.map((call) => call.deskRoot), ["/d/d"])
  assert.deepEqual((await readStatus(env)).reconcile.runs.held, { consecutive: 1, count: 2, clear: 0 })
  await runReconcileStep(env, { now: later(26), reconcileImpl: only(by), desks })
  assert.deepEqual((await readStatus(env)).reconcile.runs.held, { consecutive: 2, count: 2, clear: 0 })
}))

test("an unreadable desk keeps its reasons and streak", () => scratch(async (env) => {
  const desks = ["/d/a", "/d/b"]
  await runReconcileStep(env, { now: NOW, reconcileImpl: only({ "/d/a": { held: 1 } }), desks })
  const impl = (options) => (options.deskRoot === "/d/a" ? { ok: false } : withReasons({}))
  await runReconcileStep(env, { now: later(25), reconcileImpl: impl, desks })
  assert.deepEqual((await readStatus(env)).reconcile.runs.held, { consecutive: 1, count: 1, clear: 0 })
}))

test("two same-day runs over different desks do not raise a streak twice", () => scratch(async (env) => {
  const desks = ["/d/a", "/d/b", "/d/c", "/d/d", "/d/e"]
  const by = { "/d/a": { held: 1 }, "/d/e": { held: 1 } }
  await runReconcileStep(env, { now: NOW, reconcileImpl: only(by), desks })
  await runReconcileStep(env, { now: later(1), reconcileImpl: only(by), desks })
  const { reconcile } = await readStatus(env)
  assert.deepEqual(reconcile.runs.held, { consecutive: 1, count: 2, clear: 0 })
  assert.deepEqual([reconcile.desks_known, reconcile.desks, reconcile.desks_failed], [5, 2, 0])
}))

test("the summary says how complete it is, in numbers: known, reconciled and failed", () => scratch(async (env) => {
  const desks = ["/d/a", "/d/b", "/d/c", "/d/d", "/d/e"]
  await runReconcileStep(env, { now: NOW, reconcileImpl: fake(clean).impl, desks })
  const { reconcile } = await readStatus(env)
  assert.deepEqual([reconcile.desks_known, reconcile.desks, reconcile.desks_failed], [5, 3, 0])
}))

test("clear is the lowest clean streak among desks that showed the reason, and a skipped desk cannot meet it", () => scratch(async (env) => {
  const by = { "/d/a": { held: 1 }, "/d/b": { held: 1 } }
  await runReconcileStep(env, { now: NOW, reconcileImpl: only(by), desks: ["/d/a", "/d/b"] })
  await runReconcileStep(env, { now: later(25), reconcileImpl: only({}), desks: ["/d/a"] })
  await runReconcileStep(env, { now: later(50), reconcileImpl: only({}), desks: ["/d/a"] })
  assert.deepEqual((await readStatus(env)).reconcile.runs.held, { consecutive: 1, count: 1, clear: 0 })
  await runReconcileStep(env, { now: later(51), reconcileImpl: only({}), desks: ["/d/b"] })
  assert.deepEqual((await readStatus(env)).reconcile.runs.held, { consecutive: 0, count: 0, clear: 1 })
}))

test("a hostile previous summary and desk record are rebuilt from known fields only", () => scratch(async (env) => {
  const good = keyOf("/d/a")
  await writeStatus(env, {
    reconcile: { at: "/Users/x/secret", desks: "many", desks_known: -4, warnings: ["/Users/x/secret", "ok_code", 7], extra: "/Users/x", runs: { "/Users/x/secret": { consecutive: 9, count: 9, clear: 0 } } },
    loop: { reconcile_desks: {
      "/Users/x/secret": { at: NOW.toISOString(), reasons: { held: { streak: 1, count: 1, clear: 0 } } },
      [good]: { at: NOW.toISOString(), reasons: { "/Users/x/secret": { streak: 3, count: 3, clear: 0 }, held: { streak: 2, count: 1, clear: 0 }, not_delivered: "x" }, links: { cards: 1, archived: 0, by_reason: { "/Users/x/secret": 1 } } },
      "0123456789abcdef": { at: "bad", reasons: {} },
      fedcba9876543210: { at: NOW.toISOString(), reasons: "nope" },
    } },
  })
  await runReconcileStep(env, { now: later(1), reconcileImpl: fake(clean).impl, desks: [] })
  const status = await readStatus(env)
  assert.deepEqual(Object.keys(status.reconcile).sort(), ["at", "desks", "desks_failed", "desks_known", "last_result", "report_link_unavailable", "runs", "warnings", "window_days"])
  assert.deepEqual(status.reconcile, { at: null, window_days: 7, desks_known: 0, desks: 0, desks_failed: 0, runs: { held: { consecutive: 2, count: 1, clear: 0 } }, warnings: ["ok_code"], last_result: "no_desks", report_link_unavailable: null })
  assert.deepEqual(Object.keys(status.loop.reconcile_desks).sort(), ["fedcba9876543210", good].sort())
  assert.deepEqual(Object.keys(status.loop.reconcile_desks[good].reasons).sort(), ["held"])
  assert.ok(!JSON.stringify(status).includes("secret"))
}))

test("at most 20 desks are tracked; the ones reconciled longest ago are dropped", () => scratch(async (env) => {
  const desks = Array.from({ length: 22 }, (_, i) => `/d/${String(i).padStart(2, "0")}`)
  for (let day = 0; day < 7; day++) await runReconcileStep(env, { now: later(day * 25), reconcileImpl: fake(clean).impl, desks })
  const tracked = (await readStatus(env)).loop.reconcile_desks
  assert.equal(Object.keys(tracked).length, 20)
  assert.equal(["/d/00", "/d/01", "/d/02"].filter((root) => !(keyOf(root) in tracked)).length, 1)
}))

test("a damaged previous summary restarts its counters, and never-reconciled desks go in a stable order", () => scratch(async (env) => {
  await writeStatus(env, { reconcile: { runs: 5 } })
  const order = fake(clean)
  await runReconcileStep(env, { now: NOW, reconcileImpl: order.impl, desks: ["/d/z", "/d/a"] })
  assert.deepEqual(order.calls.map((call) => call.deskRoot), ["/d/a", "/d/z"])
  assert.deepEqual((await readStatus(env)).reconcile.runs, {})
  await writeStatus(env, { loop: { reconcile_desks: { [keyOf("/d/a")]: { at: NOW.toISOString(), reasons: { held: { streak: "x", count: "z", clear: "y" } } } } } })
  await runReconcileStep(env, { now: later(30), reconcileImpl: fake(clean).impl, desks: ["/d/a"] })
  assert.deepEqual((await readStatus(env)).reconcile.runs.held, { consecutive: 0, count: 0, clear: 1 })
}))

test("a desk not reconciled for more than 14 days is dropped, with its reasons, before the summary is derived", () => scratch(async (env) => {
  assert.equal(DESK_STALE_DAYS, 14)
  await runReconcileStep(env, { now: NOW, reconcileImpl: only({ "/d/a": { held: 2 } }), desks: ["/d/a"] })
  const day = (n) => later(n * 24)
  await runReconcileStep(env, { now: day(14), reconcileImpl: only({}), desks: ["/d/b"] })
  let status = await readStatus(env)
  assert.deepEqual(status.reconcile.runs.held, { consecutive: 1, count: 2, clear: 0 })
  assert.equal(status.reconcile.desks_known, 2)
  await runReconcileStep(env, { now: later(14 * 24 + 1), reconcileImpl: only({}), desks: ["/d/c"] })
  status = await readStatus(env)
  assert.equal(status.reconcile.runs.held, undefined)
  assert.equal(status.reconcile.desks_known, 2)
  assert.ok(!(keyOf("/d/a") in status.loop.reconcile_desks))
}))

const withLinks = (links) => ({ ok: true, counts: { by_reason: {}, report_link_unavailable: links }, tasks: [], mismatches: [] })

test("summarizeReconcile keeps the report-link count field by field, and drops a damaged one rather than guess", () => {
  const links = { cards: 2, archived: 1, by_reason: { visibility_not_known: 1, unrecognized: 1 } }
  assert.deepEqual(summarizeReconcile(withLinks(links)).links, links)
  for (const damaged of ["x", { cards: -1, archived: 0, by_reason: {} }, { cards: 1, archived: "1", by_reason: {} }, { cards: 1, archived: 0, by_reason: null },
    { cards: 1, archived: 0, by_reason: { "a hand-written secret": 1 } }, { cards: 1, archived: 0, by_reason: { desk_not_private: -2 } }]) {
    assert.equal(summarizeReconcile(withLinks(damaged)).links, null, JSON.stringify(damaged))
  }
})

test("the summary sums each desk's latest report-link count, keeps a skipped desk's, and is null until one is recorded", () => scratch(async (env) => {
  const desks = ["/d/a", "/d/b", "/d/c", "/d/d"]
  await runReconcileStep(env, { now: NOW, reconcileImpl: () => clean, desks: ["/d/z"] })
  assert.equal((await readStatus(env)).reconcile.report_link_unavailable, null, "a run whose result carries no count is not zero cards")
  const counts = {
    "/d/a": { cards: 2, archived: 1, by_reason: { visibility_not_known: 1, desk_not_private: 1 } },
    "/d/b": { cards: 1, archived: 1, by_reason: { visibility_not_known: 1 } },
    "/d/c": { cards: 0, archived: 0, by_reason: {}, jobs_missing: { cards: 2, archived: 1, by_reason: { job_missing: 1, job_removed: 1 }, named: [{ track: "t", slug: "a", reason: "job_missing" }] }, not_checked: { cards: 3, by_reason: { too_fresh: 1, no_store: 2 } } },
  }
  await runReconcileStep(env, { now: NOW, reconcileImpl: (options) => withLinks(counts[options.deskRoot]), desks })
  assert.deepEqual((await readStatus(env)).reconcile.report_link_unavailable, { cards: 3, archived: 2, by_reason: { visibility_not_known: 2, desk_not_private: 1 }, jobs_missing: { cards: 2, archived: 1, by_reason: { job_missing: 1, job_removed: 1 } }, not_checked: { cards: 3, by_reason: { too_fresh: 1, no_store: 2 } } })
  // Two hours later only the fourth desk is due; the other three keep their latest counts, and a desk with none adds nothing.
  await runReconcileStep(env, { now: later(2), reconcileImpl: () => clean, desks })
  const status = await readStatus(env)
  assert.deepEqual(status.reconcile.report_link_unavailable, { cards: 3, archived: 2, by_reason: { visibility_not_known: 2, desk_not_private: 1 }, jobs_missing: { cards: 2, archived: 1, by_reason: { job_missing: 1, job_removed: 1 } }, not_checked: { cards: 3, by_reason: { too_fresh: 1, no_store: 2 } } })
  assert.deepEqual(status.loop.reconcile_desks[keyOf("/d/a")].links, counts["/d/a"])
  // The names of missing jobs are never kept in the summary or the per-desk record.
  assert.equal(JSON.stringify(status.loop.reconcile_desks[keyOf("/d/c")].links).includes("\"slug\""), false)
}))

test("desks that recorded none of the newer parts leave them out of the sum", () => scratch(async (env) => {
  await runReconcileStep(env, { now: NOW, reconcileImpl: () => withLinks({ cards: 1, archived: 0, by_reason: { desk_not_private: 1 } }), desks: ["/d/a"] })
  assert.deepEqual((await readStatus(env)).reconcile.report_link_unavailable, { cards: 1, archived: 0, by_reason: { desk_not_private: 1 } })
}))

test("a damaged newer part of the link counts is left out and never discards the rest; the parts read cleanly are kept without their names", () => {
  const base = { cards: 1, archived: 0, by_reason: { desk_not_private: 1 } }
  const good = { jobs_missing: { cards: 1, archived: 0, by_reason: { job_missing: 1 }, named: [{ track: "t", slug: "s", reason: "job_missing" }] }, not_checked: { cards: 2, by_reason: { no_store: 2 } } }
  assert.deepEqual(summarizeReconcile(withLinks({ ...base, ...good })).links, { ...base, jobs_missing: { cards: 1, archived: 0, by_reason: { job_missing: 1 } }, not_checked: { cards: 2, by_reason: { no_store: 2 } } })
  for (const damaged of [{ jobs_missing: { cards: 1, archived: 0, by_reason: { job_unknown_future: 1 } }, not_checked: { cards: "x", by_reason: {} } }, { not_checked: { cards: 1, by_reason: { future_reason: 1 } }, jobs_missing: "x" }, { jobs_missing: { cards: 1, by_reason: {} } }]) {
    assert.deepEqual(summarizeReconcile(withLinks({ ...base, ...damaged })).links, base, JSON.stringify(damaged))
  }
})
