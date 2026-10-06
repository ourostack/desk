// The loop's health record and its own alarms. Every test uses a throwaway desk and state folder, the real card
// library, a fake commit function and a recording observer; nothing touches Git, GitHub, a real desk, the
// installed plugin or the real factory state.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { cardFile, cardKey, openImprovement, readCards, LOOP_ALARMS } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { conditionOf, observeConditions } from "../../../../../plugins/desk/mcp/src/factory/loop-conditions.js"
import { readStatus, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { RECONCILE_REASONS } from "../../../../../plugins/desk/mcp/src/factory/reconcile-reasons.js"
import { STEPS, recordStep } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"
import {
  AGE_ALARM_DAYS, STALE_AFTER_HOURS, STUCK_ALARM_DAYS, BLOCKING_STATES, HEADLESS_STATES,
  STORE_SIDE_REASONS, buildLoopHealth, count, loopAlarms, runMeasureStep, unreadAlarms,
} from "../../../../../plugins/desk/mcp/src/factory/loop-health.js"

const DAY = 24 * 3600 * 1000
const NOW = new Date("2026-10-05T12:00:00.000Z")
const ago = (days) => new Date(NOW.getTime() - days * DAY)
const PR = "https://github.com/ourostack/desk/pull/1"
const TIME = "2026-10-05T10:00:00.000Z"

async function scratch(run, { version = "3.2.0-alpha.9" } = {}) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-loop-health-")))
  const deskRoot = path.join(base, "desk")
  const pluginRoot = path.join(base, "plugin")
  await fs.mkdir(deskRoot, { recursive: true })
  await fs.mkdir(pluginRoot, { recursive: true })
  if (version !== null) await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "desk", version }))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state"), DESK_PLUGIN_ROOT: pluginRoot }
  try {
    return await run({ env, deskRoot, personPrefix: "", base, pluginRoot })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const setStatus = (ctx, patch) => updateStatus(ctx.env, (status) => ({ ...status, ...patch }))
const setLoop = (ctx, patch) => updateStatus(ctx.env, (status) => ({ ...status, loop: { ...(status.loop ?? {}), ...patch } }))
const allCards = async (ctx) => (await readCards({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix })).cards

async function edit(ctx, key, fields) {
  const file = cardFile(ctx.deskRoot, ctx.personPrefix, key)
  let text = await fs.readFile(file, "utf8")
  for (const [name, value] of Object.entries(fields)) text = text.replace(new RegExp(`^${name}: .*$`, "m"), () => `${name}: ${JSON.stringify(value)}`)
  await fs.writeFile(file, text)
}
const CLAIM = (expires) => ({ claim_id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60", claimed_at: ago(1).toISOString(), expires_at: expires.toISOString(), machine: "ab".repeat(8), session: null })
// A card in a given state, last opened `days` ago. The library builds every title and checks every shape.
async function make(ctx, source, id, { state = "open", days = 0, fields = {} } = {}) {
  const key = cardKey(source, id)
  await openImprovement({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key, source, now: ago(days), evidence: [], plugin: "desk", signal: null })
  const states = {
    open: {},
    claimed: { state, claim: CLAIM(new Date(NOW.getTime() + 3600 * 1000)), claim_log: [{ at: ago(1).toISOString(), machine: "ab".repeat(8) }] },
    expired: { state: "claimed", claim: CLAIM(new Date(NOW.getTime() - 3600 * 1000)), claim_log: [{ at: ago(1).toISOString(), machine: "ab".repeat(8) }] },
    shipped: { state, countermeasure: PR },
    verifying: { state, countermeasure: PR, shipped_version: "3.2.0", verifying_since: ago(1).toISOString() },
    closed_confirmed: { state, closed_at: ago(days).toISOString(), close_reason: "confirmed" },
    closed_unverified: { state, closed_at: ago(days).toISOString(), close_reason: "source_recovered" },
  }
  const change = { ...states[state], ...fields }
  if (Object.keys(change).length > 0) await edit(ctx, key, change)
  return key
}

const commit = async ({ write, message }) => {
  const written = await write()
  const { file, ...rest } = written
  const result = typeof file === "string" ? { ...rest, file_name: path.basename(file) } : rest
  if (typeof message === "function") message(result)
  return { result, commit: "committed", left_alone: 0 }
}
function observer(answer = { ok: true, result: "observed" }) {
  const calls = []
  const observe = async (env, input) => {
    calls.push({ source: input.source, present: [...input.present].sort() })
    if (answer instanceof Error) throw answer
    return answer
  }
  return { observe, calls }
}
const measure = (ctx, seams = {}) => {
  const spy = seams.observe === undefined ? observer() : null
  return runMeasureStep(ctx.env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: NOW, writeCardCommitted: commit, observe: spy?.observe, ...seams }).then((out) => ({ ...out, spy }))
}
const build = (ctx, seams = {}) => buildLoopHealth({ env: ctx.env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: NOW, ...seams })
const M = (value) => ({ state: "measured", value, reasons: [] })
const U = (reason) => ({ state: "unavailable", value: null, reasons: [reason] })
const STORE = { status_unobserved: U("store_not_compared"), store_only: U("store_not_compared") }
const headless = (patch = {}) => ({ state: "ran", day: "2026-10-05", jobs: 2, accepted: 1, rejected: 1, cost_usd: 0.5, cost_unreported_runs: 0, unsupported_jobs: 0, deferred_jobs: 0, blocked_days: 0, ...patch })
const evaluator = (patch = {}, hl = {}) => ({ evaluator: { expired_total: 3, gave_up: 1, waiting: 4, headless: headless(hl), ...patch } })
const keysOf = (value) => Object.keys(value).sort()

function leaves(value, trail = "", out = []) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) for (const [key, child] of Object.entries(value)) leaves(child, `${trail}.${key}`, out)
  else out.push([trail, value])
  return out
}
function isCount(value) {
  return value !== null && typeof value === "object" && ((value.state === "measured" && Number.isSafeInteger(value.value) && value.value >= 0 && value.reasons.length === 0 && keysOf(value).join() === "reasons,state,value") ||
    (value.state === "unavailable" && value.value === null && value.reasons.length === 1 && /^[a-z_]+$/u.test(value.reasons[0]) && keysOf(value).join() === "reasons,state,value"))
}

test("the constants and the Count helper", () => {
  assert.deepEqual([AGE_ALARM_DAYS, STUCK_ALARM_DAYS, STALE_AFTER_HOURS], [7, 21, 72])
  assert.deepEqual(count(3), M(3))
  assert.deepEqual(count(null, "none_open"), U("none_open"))
  assert.deepEqual(count(undefined), U("not_recorded"))
  assert.deepEqual(count(-1), U("not_recorded"))
  assert.deepEqual(count(1.5, "x"), U("x"))
  assert.ok(HEADLESS_STATES.includes("sign_in_unknown") && HEADLESS_STATES.includes("disabled_would_bill"))
  assert.deepEqual([...BLOCKING_STATES].sort(), ["no_agent_cli", "no_credentials", "sign_in_unknown", "unsupported_host"])
})

test("the record has exactly the contract's keys, every number is a Count, and a deep scan finds no path, title or job id", () => scratch(async (ctx) => {
  await make(ctx, "andon", "ourostack/factory#12", { days: 2 })
  await make(ctx, "friction_candidate", "a".repeat(32), { days: 9 })
  await setStatus(ctx, { ...evaluator(), reconcile: { at: TIME, window_days: 7, desks: 2, desks_known: 2, desks_failed: 0, runs: { [RECONCILE_REASONS[0]]: { consecutive: 2, count: 3, clear: 0 } }, warnings: [], last_result: "reconciled" } })
  await setLoop(ctx, { route_issues: { at: TIME, andon_open: 1, store_build_failing: 0, desk_problems_open: 2 }, labels_quarantined: { count: 0, at: TIME }, evaluate: { attempts: { "job-secret": { attempts: 1, last_day: "2026-10-05" } }, blocked_last_day: "2026-10-05" } })
  await recordStep(ctx.env, "route", { ok: true, result: "routed", now: ago(0.1) })
  const loop = await build(ctx)
  assert.deepEqual(keysOf(loop), ["alarms", "desk_version", "evaluator", "improvement", "reconcile", "schema", "steps", "unsigned_deliveries", "worker", "written_at"])
  assert.deepEqual(loop.worker, { last_result: "never_ran", last_ran_at: null })
  assert.equal(loop.schema, "desk.factory.loop/1")
  assert.equal(loop.written_at, NOW.toISOString())
  assert.equal(loop.desk_version, "3.2.0-alpha.9")
  assert.deepEqual(keysOf(loop.improvement), ["age_alarm_days", "by_source", "claim_expired", "claimed", "closed_confirmed_30d", "closed_unverified_30d", "oldest_in_verification_age_days", "oldest_open_age_days", "open", "reopened_30d", "reopened_from_verification", "shipped", "stuck_alarm_days", "verifying"])
  assert.deepEqual([loop.improvement.age_alarm_days, loop.improvement.stuck_alarm_days], [M(7), M(21)])
  assert.deepEqual(keysOf(loop.improvement.by_source), ["andon", "desk_problem", "evaluator", "flush_health", "friction_candidate", "loop_alarm", "reconcile_class", "store_build"])
  assert.deepEqual(keysOf(loop.unsigned_deliveries), ["count", "oldest_age_days"])
  assert.deepEqual(keysOf(loop.alarms), ["andon_open", "desk_problems_open", "loop_alarms_open", "store_build_failing"])
  assert.deepEqual(keysOf(loop.evaluator), ["expired_total", "gave_up", "headless", "labels_quarantined", "oldest_wait_days", "waiting"])
  assert.deepEqual(keysOf(loop.evaluator.headless), ["accepted_today", "cap_per_day", "cost_usd_today", "jobs_today", "rejected_today", "state"])
  assert.deepEqual(keysOf(loop.reconcile), ["desks", "last_ran_at", "mismatches", "report_link_unavailable", "store_side", "window_days"])
  assert.deepEqual(keysOf(loop.steps), [...STEPS].sort())
  assert.deepEqual(keysOf(loop.steps.route), ["expected_interval_hours", "failures", "last_ok_at", "last_ran_at", "last_result", "runs", "stale"])
  for (const [trail, value] of leaves(loop)) {
    if (typeof value === "string" && trail !== ".schema") {
      assert.equal(value.includes("/"), false, `${trail} holds a slash`)
      assert.equal(value.includes("job-secret"), false)
    }
  }
  const text = JSON.stringify(loop)
  for (const card of await allCards(ctx)) assert.equal(text.includes(card.title), false)
  assert.equal(text.includes("attempts"), false)
  assert.equal(text.includes(ctx.base), false)
  const bare = []
  let counted = 0
  const walk = (value, trail) => {
    if (value !== null && typeof value === "object" && (value.state === "measured" || value.state === "unavailable")) {
      assert.equal(isCount(value) || (trail.endsWith("cost_usd_today") && value.state === "measured" && typeof value.value === "number"), true, trail)
      counted += 1
    } else if (value !== null && typeof value === "object") for (const [key, child] of Object.entries(value)) walk(child, `${trail}.${key}`)
    else if (typeof value === "number") bare.push(trail.split(".").pop())
  }
  walk(loop, "")
  assert.ok(counted > 40)
  assert.deepEqual(bare, [], "no bare number: every number in the record is a Count")
  assert.equal(isCount(loop.improvement.open), true)
  assert.equal(isCount(loop.steps.route.runs), true)
  assert.equal(isCount(loop.reconcile.desks), true)
}))

test("no cards: open is measured 0 and the oldest ages are unavailable with their own reasons", () => scratch(async (ctx) => {
  const { improvement, alarms } = await build(ctx)
  assert.deepEqual([improvement.open, improvement.claimed, improvement.claim_expired, improvement.shipped, improvement.verifying], [M(0), M(0), M(0), M(0), M(0)])
  assert.deepEqual([improvement.oldest_open_age_days, improvement.oldest_in_verification_age_days], [U("none_open"), U("none_in_verification")])
  assert.deepEqual([improvement.closed_confirmed_30d, improvement.closed_unverified_30d, improvement.reopened_30d], [M(0), M(0), M(0)])
  for (const value of Object.values(improvement.by_source)) assert.deepEqual(value, M(0))
  assert.deepEqual(alarms.loop_alarms_open, M(0))
}))

test("an unreadable card folder, a truncated read and a thrown read make every card number unavailable, never 0", () => scratch(async (ctx) => {
  await fs.mkdir(path.join(ctx.deskRoot, "_meta", "improvement"), { recursive: true })
  await fs.writeFile(path.join(ctx.deskRoot, "_meta", "improvement", "invalid"), "not a folder")
  const real = await build(ctx)
  assert.deepEqual(real.improvement.open, U("unreadable"))
  const seamed = [
    [() => ({ cards: [], unreadable: true, truncated: false, set_aside_total: 0, unreadable_files: 0 }), "unreadable"],
    [() => ({ cards: [], unreadable: false, truncated: true, set_aside_total: 0, unreadable_files: 0 }), "too_many_cards"],
    [() => { throw new Error("boom") }, "unreadable"],
    [() => null, "unreadable"],
  ]
  for (const [readCardsImpl, reason] of seamed) {
    const { improvement, alarms } = await build(ctx, { readCardsImpl })
    for (const value of [improvement.open, improvement.claimed, improvement.claim_expired, improvement.shipped, improvement.verifying, improvement.closed_confirmed_30d, improvement.closed_unverified_30d, improvement.reopened_30d, improvement.by_source.andon, improvement.reopened_from_verification, alarms.loop_alarms_open, improvement.oldest_open_age_days, improvement.oldest_in_verification_age_days]) assert.deepEqual(value, U(reason))
  }
}))

test("states, claims, by_source, closed counts and reopens are counted; by_source agrees with open", () => scratch(async (ctx) => {
  await make(ctx, "andon", "ourostack/factory#1", { days: 1 })
  await make(ctx, "andon", "ourostack/factory#2", { days: 2 })
  await make(ctx, "evaluator", "gave_up", { days: 3 })
  await make(ctx, "flush_health", "frozen", { state: "claimed", days: 4 })
  await make(ctx, "flush_health", "no_account", { state: "expired", days: 5 })
  await make(ctx, "store_build", "ourostack/factory#3", { state: "shipped", days: 6 })
  await make(ctx, "desk_problem", "ourostack/desk#4", { state: "verifying", days: 7 })
  await make(ctx, "evaluator", "expired_requests", { state: "closed_confirmed", days: 10 })
  await make(ctx, "reconcile_class", RECONCILE_REASONS[0], { state: "closed_unverified", days: 40 })
  await make(ctx, "reconcile_class", RECONCILE_REASONS[1], { state: "closed_unverified", days: 3 })
  await make(ctx, "friction_candidate", "b".repeat(32), { days: 2, fields: { recurrences: 1 } })
  await make(ctx, "friction_candidate", "c".repeat(32), { days: 50, fields: { recurrences: 2 } })
  await make(ctx, "loop_alarm", "headless_blocked", { days: 1, fields: { recurrences: 4 } })
  await make(ctx, "flush_health", "held_markers", { state: "shipped", days: 9, fields: { reopened: 2 } })
  await make(ctx, "flush_health", "route_unknown", { state: "closed_confirmed", days: 9, fields: { reopened: 5 } })
  await make(ctx, "loop_alarm", "cards_invalid", { state: "verifying", days: 9, fields: { reopened: 7 } })
  const { improvement } = await build(ctx)
  assert.deepEqual([improvement.open, improvement.claimed, improvement.claim_expired, improvement.shipped, improvement.verifying], [M(5), M(1), M(1), M(2), M(1)])
  assert.deepEqual([improvement.closed_confirmed_30d, improvement.closed_unverified_30d, improvement.reopened_30d, improvement.reopened_from_verification], [M(2), M(1), M(1), M(2)])
  const bySource = Object.fromEntries(Object.entries(improvement.by_source).map(([name, value]) => [name, value.value]))
  assert.deepEqual(bySource, { andon: 2, friction_candidate: 2, reconcile_class: 0, desk_problem: 0, store_build: 0, evaluator: 1, flush_health: 0, loop_alarm: 1 })
  // The open count leaves loop alarm cards out (they are `loop_alarms_open`), so it is the by-source sum without them.
  assert.equal(Object.values(bySource).reduce((sum, n) => sum + n, 0) - bySource.loop_alarm, improvement.open.value)
  assert.deepEqual(improvement.oldest_open_age_days, M(50))
}))

test("the oldest open age counts open and claimed cards from last_opened_at and ignores loop_alarm cards", () => scratch(async (ctx) => {
  await make(ctx, "loop_alarm", "improvement_age", { days: 30 })
  await make(ctx, "andon", "ourostack/factory#1", { days: 3 })
  assert.deepEqual((await build(ctx)).improvement.oldest_open_age_days, M(3))
  await make(ctx, "flush_health", "frozen", { state: "expired", days: 6 })
  assert.deepEqual((await build(ctx)).improvement.oldest_open_age_days, M(6))
  // A reopened card counts from when it was last opened, not from its first opening.
  await make(ctx, "evaluator", "gave_up", { days: 40, fields: { opened_at: ago(40).toISOString(), last_opened_at: ago(2).toISOString(), recurrences: 1 } })
  assert.deepEqual((await build(ctx)).improvement.oldest_open_age_days, M(6))
  const onlyAlarm = await scratch(async (other) => {
    await make(other, "loop_alarm", "improvement_age", { days: 30 })
    return build(other)
  })
  assert.deepEqual(onlyAlarm.improvement.oldest_open_age_days, U("none_open"))
  assert.deepEqual(onlyAlarm.improvement.by_source.loop_alarm, M(1))
  assert.deepEqual(onlyAlarm.alarms.loop_alarms_open, M(1))
}))

test("the oldest shipped or verifying age ignores loop_alarm cards", () => scratch(async (ctx) => {
  await make(ctx, "loop_alarm", "headless_blocked", { state: "verifying", days: 90 })
  assert.deepEqual((await build(ctx)).improvement.oldest_in_verification_age_days, U("none_in_verification"))
  await make(ctx, "store_build", "ourostack/factory#3", { state: "shipped", days: 12 })
  await make(ctx, "andon", "ourostack/factory#5", { state: "verifying", days: 23 })
  assert.deepEqual((await build(ctx)).improvement.oldest_in_verification_age_days, M(23))
}))

test("a card open 8 days opens loop_alarm:improvement_age once; the alarm does not move the age or open another", () => scratch(async (ctx) => {
  await make(ctx, "andon", "ourostack/factory#1", { days: 8 })
  const first = await measure(ctx)
  assert.deepEqual([first.ok, first.result], [true, "measured"])
  const keys = (await allCards(ctx)).map((card) => card.key).sort()
  assert.deepEqual(keys, ["andon:ourostack/factory#1", "loop_alarm:improvement_age"])
  assert.deepEqual(first.spy.calls, [{ source: "loop_alarm", present: ["improvement_age"] }])
  const second = await measure(ctx)
  assert.deepEqual((await allCards(ctx)).length, 2)
  assert.deepEqual(second.spy.calls[0].present, ["improvement_age"])
  const health = (await readStatus(ctx.env)).loop.health
  assert.deepEqual(health.improvement.oldest_open_age_days, M(8))
  assert.deepEqual(health.alarms.loop_alarms_open, M(1))
  const [alarm] = (await allCards(ctx)).filter((card) => card.source === "loop_alarm")
  assert.equal(alarm.title, "An improvement card has waited past the age threshold")
  assert.deepEqual(alarm.evidence, [])
}))

test("a card open 7 days or less opens no age alarm, and a claimed card past 7 days does", () => scratch(async (ctx) => {
  await make(ctx, "andon", "ourostack/factory#1", { days: 7 })
  const none = await measure(ctx)
  assert.deepEqual(none.spy.calls, [{ source: "loop_alarm", present: [] }])
  await make(ctx, "flush_health", "frozen", { state: "claimed", days: 9 })
  const some = await measure(ctx)
  assert.deepEqual(some.spy.calls[0].present, ["improvement_age"])
}))

test("a shipped or verifying card older than 21 days opens improvement_stuck, not improvement_age", () => scratch(async (ctx) => {
  await make(ctx, "store_build", "ourostack/factory#3", { state: "shipped", days: 22 })
  const out = await measure(ctx)
  assert.deepEqual(out.spy.calls[0].present, ["improvement_stuck"])
  const [alarm] = (await allCards(ctx)).filter((card) => card.source === "loop_alarm")
  assert.equal(alarm.key, "loop_alarm:improvement_stuck")
  assert.match(alarm.title, /verification|waited|stuck/iu)
  assert.ok(LOOP_ALARMS.includes("improvement_stuck"))
  assert.equal((await measure(ctx)).spy.calls[0].present[0], "improvement_stuck")
  const fresh = await scratch(async (other) => {
    await make(other, "store_build", "ourostack/factory#3", { state: "verifying", days: 21 })
    return measure(other)
  })
  assert.deepEqual(fresh.spy.calls[0].present, [])
}))

test("unsigned deliveries: absent is not_recorded with no alarm; a measured oldest age above 7 days opens unsigned_age", () => scratch(async (ctx) => {
  const absent = await build(ctx)
  assert.deepEqual(absent.unsigned_deliveries, { count: U("not_recorded"), oldest_age_days: U("not_recorded") })
  assert.deepEqual((await measure(ctx)).spy.calls[0].present, [])
  await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), unsigned: M(2), oldest_unsigned_age_days: M(7) } })
  assert.deepEqual((await measure(ctx)).spy.calls[0].present, [])
  await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), unsigned: M(2), oldest_unsigned_age_days: M(8) } })
  const out = await measure(ctx)
  assert.deepEqual(out.spy.calls[0].present, ["unsigned_age"])
  assert.equal((await allCards(ctx)).find((card) => card.key === "loop_alarm:unsigned_age").title, "A delivery has waited unsigned past the age threshold")
  assert.deepEqual((await readStatus(ctx.env)).loop.health.unsigned_deliveries, { count: M(2), oldest_age_days: M(8) })
}))

test("unsigned_age reads clear when the unsigned count is a measured 0; it is unread only when the count is unavailable or the count is above 0 with no age", () => scratch(async (ctx) => {
  const unread = async (signoff) => { await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), ...signoff } }); return unreadAlarms(await build(ctx), { attempted: [...STEPS], blocked_days: 0, cards_invalid: 0 }).includes("unsigned_age") }
  assert.equal(await unread({ unsigned: M(0), oldest_unsigned_age_days: U("none_unsigned") }), false)
  assert.equal(await unread({ unsigned: M(2), oldest_unsigned_age_days: U("none_unsigned") }), true)
  assert.equal(await unread({ unsigned: U("scan_failed"), oldest_unsigned_age_days: M(1) }), true)
  assert.equal(await unread({ unsigned: M(2), oldest_unsigned_age_days: M(1) }), false)
  await observeConditions(ctx.env, { source: "loop_alarm", present: ["unsigned_age"], now: ago(1) })
  await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), unsigned: M(0), oldest_unsigned_age_days: U("none_unsigned") } })
  await measure(ctx, { observe: observeConditions, attempted: [...STEPS] })
  assert.equal(conditionOf(await readStatus(ctx.env), "loop_alarm:unsigned_age").present, false)
}))

test("damaged signoff values stay unavailable and the alarm keeps what was recorded", () => scratch(async (ctx) => {
  await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), unsigned: U("scan_failed"), oldest_unsigned_age_days: { state: "measured", value: -3 } } })
  assert.deepEqual((await build(ctx)).unsigned_deliveries, { count: U("scan_failed"), oldest_age_days: U("not_recorded") })
  await setStatus(ctx, { signoff: "oops" })
  assert.deepEqual((await build(ctx)).unsigned_deliveries, { count: U("not_recorded"), oldest_age_days: U("not_recorded") })
  await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), unsigned: { state: "unavailable", reason: "has a/slash" }, oldest_unsigned_age_days: { state: "measured", value: 1, extra: 1 } } })
  assert.deepEqual((await build(ctx)).unsigned_deliveries, { count: U("not_recorded"), oldest_age_days: U("not_recorded") })
}))

test("the unsigned-deliveries alarm reads the sign-off scan's own record: a lower bound above 7 days alarms, an old or undated scan is stale or not recorded and alarms nothing", () => scratch(async (ctx) => {
  await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), unsigned: { state: "partial", value: 500, reason: "archive_cap" }, oldest_unsigned_age_days: { state: "partial", value: 30, reason: "archive_cap" } } })
  assert.deepEqual(loopAlarms(await build(ctx), {}).map((alarm) => alarm.name), ["unsigned_age"])
  await setStatus(ctx, { signoff: { checked_at: ago(5).toISOString(), unsigned: M(2), oldest_unsigned_age_days: M(30) } })
  const stale = await build(ctx)
  assert.deepEqual(stale.unsigned_deliveries, { count: U("stale"), oldest_age_days: U("stale") })
  assert.deepEqual(loopAlarms(stale, {}), [])
  await setStatus(ctx, { signoff: { unsigned: M(2), oldest_unsigned_age_days: M(30) } })
  assert.deepEqual((await build(ctx)).unsigned_deliveries, { count: U("not_recorded"), oldest_age_days: U("not_recorded") })
}))

test("the store-side reconcile reasons are reported as not compared, never as a count or as none, and the record's constants are Counts", () => scratch(async (ctx) => {
  await setStatus(ctx, { ...evaluator(), reconcile: { at: TIME, window_days: 7, desks: 2, desks_known: 2, desks_failed: 0, runs: { [RECONCILE_REASONS[0]]: { consecutive: 2, count: 3, clear: 0 }, status_unobserved: { consecutive: 1, count: 4, clear: 0 }, store_only: { consecutive: 1, count: 1, clear: 0 } }, warnings: [], last_result: "reconciled" } })
  const loop = await build(ctx)
  assert.deepEqual(loop.reconcile.mismatches, { [RECONCILE_REASONS[0]]: M(3) })
  assert.deepEqual(loop.reconcile.store_side, { status_unobserved: U("store_not_compared"), store_only: U("store_not_compared") })
  assert.deepEqual(STORE_SIDE_REASONS, ["status_unobserved", "store_only"])
  assert.deepEqual([loop.reconcile.window_days, loop.improvement.age_alarm_days, loop.improvement.stuck_alarm_days, loop.steps.mirror.expected_interval_hours], [M(7), M(7), M(21), M(6)])
}))

test("a stored count reads back in the contract shape from either spelling and nothing else", () => scratch(async (ctx) => {
  const read = async (unsigned, oldest) => {
    await setStatus(ctx, { signoff: { checked_at: NOW.toISOString(), unsigned, oldest_unsigned_age_days: oldest } })
    const { unsigned_deliveries: out } = await build(ctx)
    return [out.count, out.oldest_age_days]
  }
  assert.deepEqual(await read({ state: "measured", value: 2 }, { state: "unavailable", reason: "none_open" }), [M(2), U("none_open")])
  assert.deepEqual(await read({ state: "measured", value: 2, reasons: [] }, { state: "unavailable", value: null, reasons: ["none_open"] }), [M(2), U("none_open")])
  assert.deepEqual(await read({ state: "partial", value: 4, reason: "archive_cap" }, { state: "partial", value: 9, reason: "cards_unreadable" }), [{ state: "partial", value: 4, reasons: ["archive_cap"] }, { state: "partial", value: 9, reasons: ["cards_unreadable"] }])
  assert.deepEqual(await read({ state: "partial", value: 4, reasons: ["archive_cap"] }, { state: "partial", value: 1 }), [{ state: "partial", value: 4, reasons: ["archive_cap"] }, U("not_recorded")])
  assert.deepEqual(await read({ state: "partial", value: 4, reason: "bad/slash" }, { state: "partial", value: -1, reason: "x" }), [U("not_recorded"), U("not_recorded")])
  assert.deepEqual(await read({ state: "weird", value: 1 }, { state: "weird", reason: "x" }), [U("not_recorded"), U("not_recorded")])
  assert.deepEqual(await read(5, null), [U("not_recorded"), U("not_recorded")])
  assert.deepEqual(await read({ state: "measured", value: 2, reasons: ["x"] }, { state: "unavailable", value: 0, reasons: ["none_open"] }), [U("not_recorded"), U("not_recorded")])
  assert.deepEqual(await read({ state: "unavailable", value: null, reasons: ["a", "b"] }, { state: "partial", value: 1 }), [U("not_recorded"), U("not_recorded")])
  assert.deepEqual(await read({ state: "measured", value: 2, reasons: "none" }, { state: "unavailable", value: null, reasons: "none_open" }), [U("not_recorded"), U("not_recorded")])
  assert.deepEqual(await read({ state: "unavailable", value: null, reasons: [5] }, { state: "measured", value: 1, reasons: [], extra: 1 }), [U("not_recorded"), U("not_recorded")])
}))

test("a step attempted this run that is 4 days past its last success, or failed 3 times in a row, opens step_stale:<step>; steps not attempted open none", () => scratch(async (ctx) => {
  await recordStep(ctx.env, "mirror", { ok: true, result: "mirrored", now: ago(4) })
  for (let i = 0; i < 3; i++) await recordStep(ctx.env, "verify", { ok: false, result: "step_error", now: ago(0.1) })
  await recordStep(ctx.env, "route", { ok: true, result: "routed", now: ago(0.1) })
  const idle = await measure(ctx)
  assert.deepEqual(idle.spy.calls[0].present, [], "no step was attempted")
  const out = await measure(ctx, { attempted: ["mirror", "verify", "route", "deliver", "bogus"] })
  assert.deepEqual(out.spy.calls[0].present, ["step_stale:mirror", "step_stale:verify"])
  const titles = (await allCards(ctx)).filter((card) => card.source === "loop_alarm").map((card) => card.title).sort()
  assert.deepEqual(titles, ["Loop step mirror is stale", "Loop step verify is stale"])
  const { steps } = (await readStatus(ctx.env)).loop.health
  assert.equal(steps.mirror.stale, true)
  assert.equal(steps.verify.stale, true)
  assert.equal(steps.route.stale, false)
  assert.deepEqual(steps.verify.failures, M(3))
}))

test("the steps section: a step that never ran, one that ran, and damaged step records", () => scratch(async (ctx) => {
  await recordStep(ctx.env, "evaluate", { ok: true, result: "ran", now: ago(0.5) })
  await setLoop(ctx, { steps: { ...(await readStatus(ctx.env)).loop.steps, verify: { last_ran_at: "not a time", last_ok_at: "also not", last_result: "Bad Code/x", runs: -1, failures: "x", failures_in_a_row: 0 }, mirror: "oops" } })
  const { steps } = await build(ctx)
  assert.deepEqual(steps.measure, { last_ran_at: null, last_ok_at: null, last_result: "never_ran", runs: M(0), failures: M(0), expected_interval_hours: M(24), stale: false })
  assert.equal(steps.evaluate.last_ran_at, ago(0.5).toISOString())
  assert.equal(steps.evaluate.last_result, "ran")
  assert.deepEqual(steps.evaluate.expected_interval_hours, M(1))
  assert.deepEqual([steps.route.expected_interval_hours, steps.mirror.expected_interval_hours, steps.reconcile.expected_interval_hours], [M(6), M(6), M(24)])
  assert.deepEqual(steps.verify, { last_ran_at: null, last_ok_at: null, last_result: "unknown", runs: U("not_recorded"), failures: U("not_recorded"), expected_interval_hours: M(24), stale: true })
  assert.equal(steps.mirror.last_result, "never_ran")
  assert.deepEqual([steps.mirror.runs, steps.mirror.failures], [M(0), M(0)], "a step with no usable record is not a damaged counter")
  await setLoop(ctx, { steps: { ...(await readStatus(ctx.env)).loop.steps, route: { last_ran_at: TIME, last_ok_at: TIME, last_result: "routed", runs: "bad", failures: -1, failures_in_a_row: 0 } } })
  const damaged = (await build(ctx)).steps.route
  assert.deepEqual([damaged.runs, damaged.failures], [U("not_recorded"), U("not_recorded")])
  await updateStatus(ctx.env, (status) => ({ ...status, loop: "damaged" }))
  assert.equal((await build(ctx)).steps.evaluate.last_result, "never_ran")
}))

test("headless_blocked opens only after 2 consecutive blocked days and only for a state an agent can fix", () => scratch(async (ctx) => {
  await setStatus(ctx, evaluator({}, { state: "no_credentials", blocked_days: 1 }))
  assert.deepEqual((await measure(ctx)).spy.calls[0].present, [])
  await setStatus(ctx, evaluator({}, { state: "no_credentials", blocked_days: 2 }))
  const out = await measure(ctx)
  assert.deepEqual(out.spy.calls[0].present, ["headless_blocked"])
  assert.equal((await allCards(ctx)).find((card) => card.key === "loop_alarm:headless_blocked").title, "The headless evaluator is blocked")
  for (const state of ["no_agent_cli", "unsupported_host", "sign_in_unknown"]) {
    await setStatus(ctx, evaluator({}, { state, blocked_days: 5 }))
    assert.deepEqual((await measure(ctx)).spy.calls[0].present, ["headless_blocked"], state)
  }
  for (const state of ["disabled_would_bill", "disabled", "budget_exhausted", "idle", "ran"]) {
    await setStatus(ctx, evaluator({}, { state, blocked_days: 9 }))
    assert.deepEqual((await measure(ctx)).spy.calls[0].present, [], state)
    assert.equal((await readStatus(ctx.env)).loop.health.evaluator.headless.state, state)
  }
}))

test("the headless block: today's numbers count only for today's UTC day, and cost is measured only when no run went unreported", () => scratch(async (ctx) => {
  await setStatus(ctx, evaluator())
  let hl = (await build(ctx)).evaluator.headless
  assert.deepEqual(hl, { state: "ran", jobs_today: M(2), cap_per_day: M(6), accepted_today: M(1), rejected_today: M(1), cost_usd_today: M(0.5) })
  await setStatus(ctx, evaluator({}, { day: "2026-10-04" }))
  hl = (await build(ctx)).evaluator.headless
  assert.deepEqual([hl.jobs_today, hl.accepted_today, hl.rejected_today, hl.cost_usd_today], [M(0), M(0), M(0), M(0)])
  assert.equal(hl.state, "unavailable", "yesterday's state is not today's")
  await setStatus(ctx, evaluator({}, { cost_usd: 0.4, cost_unreported_runs: 1 }))
  assert.deepEqual((await build(ctx)).evaluator.headless.cost_usd_today, U("not_recorded"))
  await setStatus(ctx, evaluator({}, { cost_usd: null, cost_unreported_runs: 0, jobs: 0, accepted: 0, rejected: 0 }))
  assert.deepEqual((await build(ctx)).evaluator.headless.cost_usd_today, M(0))
  await setStatus(ctx, evaluator({}, { cost_usd: null, cost_unreported_runs: 0 }))
  assert.deepEqual((await build(ctx)).evaluator.headless.cost_usd_today, U("not_recorded"))
  await setStatus(ctx, evaluator({}, { cost_usd: -1 }))
  assert.deepEqual((await build(ctx)).evaluator.headless.cost_usd_today, U("not_recorded"))
  await setStatus(ctx, evaluator({}, { day: "garbage" }))
  hl = (await build(ctx)).evaluator.headless
  assert.deepEqual([hl.jobs_today, hl.cost_usd_today, hl.state], [U("not_recorded"), U("not_recorded"), "unavailable"])
  await setStatus(ctx, evaluator({}, { day: "2026-10-06" }))
  assert.deepEqual((await build(ctx)).evaluator.headless.jobs_today, U("not_recorded"))
  await setStatus(ctx, evaluator({}, { state: "from_the_future" }))
  assert.equal((await build(ctx)).evaluator.headless.state, "unavailable")
  await setStatus(ctx, evaluator({}, { jobs: "x" }))
  assert.deepEqual((await build(ctx)).evaluator.headless.jobs_today, U("not_recorded"))
}))

test("no evaluator record: every evaluator number is not_recorded and the state is unavailable", () => scratch(async (ctx) => {
  const { evaluator: summary } = await build(ctx)
  assert.deepEqual(summary, {
    waiting: U("not_recorded"), oldest_wait_days: U("not_recorded"), expired_total: U("not_recorded"), labels_quarantined: U("not_recorded"), gave_up: U("not_recorded"),
    headless: { state: "unavailable", jobs_today: U("not_recorded"), cap_per_day: M(6), accepted_today: U("not_recorded"), rejected_today: U("not_recorded"), cost_usd_today: U("not_recorded") },
  })
  await setStatus(ctx, { evaluator: "x" })
  assert.equal((await build(ctx)).evaluator.headless.state, "unavailable")
  await setStatus(ctx, evaluator({ expired_total: 7, gave_up: "x", waiting: 2 }))
  const part = (await build(ctx)).evaluator
  assert.deepEqual([part.expired_total, part.gave_up, part.waiting], [M(7), U("not_recorded"), M(2)])
}))

test("route issue numbers: absent is not_recorded, a stale look is stale, a fresh look is read field by field", () => scratch(async (ctx) => {
  assert.deepEqual((await build(ctx)).alarms, { andon_open: U("not_recorded"), store_build_failing: U("not_recorded"), desk_problems_open: U("not_recorded"), loop_alarms_open: M(0) })
  await setLoop(ctx, { route_issues: { at: TIME, andon_open: 2, desk_problems_open: -1 } })
  const fresh = (await build(ctx)).alarms
  assert.deepEqual([fresh.andon_open, fresh.store_build_failing, fresh.desk_problems_open], [M(2), U("not_recorded"), U("not_recorded")])
  await setLoop(ctx, { route_issues: { at: new Date(NOW.getTime() - (STALE_AFTER_HOURS + 1) * 3600 * 1000).toISOString(), andon_open: 2, store_build_failing: 1, desk_problems_open: 1 } })
  const stale = (await build(ctx)).alarms
  assert.deepEqual([stale.andon_open, stale.store_build_failing, stale.desk_problems_open], [U("stale"), U("stale"), U("stale")])
  await setLoop(ctx, { route_issues: { at: "garbage", andon_open: 1 } })
  assert.deepEqual((await build(ctx)).alarms.andon_open, U("stale"))
  await setLoop(ctx, { route_issues: { andon_open: 1 } })
  assert.deepEqual((await build(ctx)).alarms.andon_open, U("not_recorded"))
  await setLoop(ctx, { route_issues: { at: new Date(NOW.getTime() + 2 * 60 * 1000).toISOString(), andon_open: 4 } })
  assert.deepEqual((await build(ctx)).alarms.andon_open, M(4), "a small clock difference is tolerated")
  await setLoop(ctx, { route_issues: { at: new Date(NOW.getTime() + 3600 * 1000).toISOString(), andon_open: 4 } })
  assert.deepEqual((await build(ctx)).alarms.andon_open, U("stale"), "a time far ahead of the clock is stale, not fresh")
  await setLoop(ctx, { route_issues: "x" })
  assert.deepEqual((await build(ctx)).alarms.andon_open, U("not_recorded"))
}))

test("labels quarantined: read from the hand-off value with the same stale rule, and a count above zero opens its alarm", () => scratch(async (ctx) => {
  assert.deepEqual((await build(ctx)).evaluator.labels_quarantined, U("not_recorded"))
  await setLoop(ctx, { labels_quarantined: { count: 0, at: TIME } })
  assert.deepEqual((await measure(ctx)).spy.calls[0].present, [])
  await setLoop(ctx, { labels_quarantined: { count: 2, at: TIME } })
  const out = await measure(ctx)
  assert.deepEqual(out.spy.calls[0].present, ["labels_quarantined"])
  assert.equal((await allCards(ctx)).find((card) => card.key === "loop_alarm:labels_quarantined").title, "Evaluation labels were quarantined")
  await setLoop(ctx, { labels_quarantined: { count: 2, at: "2026-09-01T00:00:00.000Z" } })
  assert.deepEqual((await build(ctx)).evaluator.labels_quarantined, U("stale"))
  await setLoop(ctx, { labels_quarantined: { count: "x", at: TIME } })
  assert.deepEqual((await build(ctx)).evaluator.labels_quarantined, U("not_recorded"))
  await setLoop(ctx, { labels_quarantined: { count: 1, at: "junk" } })
  assert.deepEqual((await build(ctx)).evaluator.labels_quarantined, U("stale"))
  await setLoop(ctx, { labels_quarantined: [] })
  assert.deepEqual((await build(ctx)).evaluator.labels_quarantined, U("not_recorded"))
}))

test("cards the library set aside or could not read open cards_invalid", () => scratch(async (ctx) => {
  const read = (extra) => async () => ({ cards: [], unreadable: false, truncated: false, skipped: {}, set_aside_total: 0, unreadable_files: 0, ...extra })
  assert.deepEqual((await measure(ctx, { readCardsImpl: read({}) })).spy.calls[0].present, [])
  assert.deepEqual((await measure(ctx, { readCardsImpl: read({ set_aside_total: 1 }) })).spy.calls[0].present, ["cards_invalid"])
  assert.deepEqual((await measure(ctx, { readCardsImpl: read({ unreadable_files: 2 }) })).spy.calls[0].present, ["cards_invalid"])
  assert.equal((await allCards(ctx)).find((card) => card.key === "loop_alarm:cards_invalid").title, "Improvement card files were set aside as invalid")
}))

const NO_LINKS = { cards: U("not_recorded"), archived: U("not_recorded"), by_reason: {} }

test("the reconcile block shows the cards still waiting for a report link, as Counts, and never zero when none were counted", () => scratch(async (ctx) => {
  await setStatus(ctx, { reconcile: { at: TIME, desks: 1, runs: {}, report_link_unavailable: { cards: 3, archived: 2, by_reason: { visibility_not_known: 2, desk_not_private: 1, "Bad Key": 4 } } } })
  assert.deepEqual((await build(ctx)).reconcile.report_link_unavailable, { cards: M(3), archived: M(2), by_reason: { visibility_not_known: M(2), desk_not_private: M(1) } })
  await setStatus(ctx, { reconcile: { at: TIME, desks: 1, runs: {}, report_link_unavailable: null } })
  assert.deepEqual((await build(ctx)).reconcile.report_link_unavailable, NO_LINKS, "a run before the count existed is not zero cards")
  await setStatus(ctx, { reconcile: { at: TIME, desks: 1, runs: {}, report_link_unavailable: { cards: -1, archived: "x", by_reason: {} } } })
  assert.deepEqual((await build(ctx)).reconcile.report_link_unavailable, NO_LINKS, "a damaged count reads unavailable")
}))

test("the reconcile block: no summary is last_ran_at null with desks unavailable; a summary gives counts per reason", () => scratch(async (ctx) => {
  assert.deepEqual((await build(ctx)).reconcile, { last_ran_at: null, window_days: M(7), desks: U("not_recorded"), mismatches: {}, store_side: STORE, report_link_unavailable: NO_LINKS })
  await setStatus(ctx, { reconcile: { at: null, last_result: "no_desks", runs: {} } })
  assert.equal((await build(ctx)).reconcile.last_ran_at, null)
  await setStatus(ctx, { reconcile: { at: TIME, window_days: 7, desks: 3, runs: { [RECONCILE_REASONS[0]]: { consecutive: 1, count: 4, clear: 0 }, [RECONCILE_REASONS[1]]: { consecutive: 0, count: 0, clear: 3 }, unknown_reason: { count: 1 }, "bad/key": { count: 2 }, [RECONCILE_REASONS[2]]: { count: -1 }, [RECONCILE_REASONS[3]]: "x" }, warnings: [], last_result: "reconciled" } })
  assert.deepEqual((await build(ctx)).reconcile, { last_ran_at: TIME, window_days: M(7), desks: M(3), mismatches: { [RECONCILE_REASONS[0]]: M(4), unknown_reason: M(1) }, store_side: STORE, report_link_unavailable: NO_LINKS })
  await setStatus(ctx, { reconcile: { at: TIME, desks: "x", runs: "y" } })
  assert.deepEqual((await build(ctx)).reconcile, { last_ran_at: TIME, window_days: M(7), desks: U("runs_damaged"), mismatches: {}, store_side: STORE, report_link_unavailable: NO_LINKS })
  await setStatus(ctx, { reconcile: { at: TIME, desks: 2 } })
  assert.deepEqual((await build(ctx)).reconcile.desks, U("runs_damaged"))
  await setStatus(ctx, { reconcile: { at: TIME, desks: "x", runs: {} } })
  assert.deepEqual((await build(ctx)).reconcile, { last_ran_at: TIME, window_days: M(7), desks: U("not_recorded"), mismatches: {}, store_side: STORE, report_link_unavailable: NO_LINKS })
  await setStatus(ctx, { reconcile: "x" })
  assert.equal((await build(ctx)).reconcile.last_ran_at, null)
}))

test("the Desk version comes from the plugin folder, and an unreadable one reads unknown", async () => {
  await scratch(async (ctx) => assert.equal((await build(ctx)).desk_version, "unknown"), { version: null })
  await scratch(async (ctx) => assert.equal((await build(ctx)).desk_version, "unknown"), { version: "has a/slash" })
  await scratch(async (ctx) => assert.equal((await build(ctx, { pluginVersion: "9.9.9" })).desk_version, "9.9.9"))
  await scratch(async (ctx) => assert.equal((await build(ctx, { pluginVersion: "not ok/x" })).desk_version, "unknown"))
})

test("an unreadable status builds a record of unavailable numbers", () => scratch(async (ctx) => {
  for (const readStatusImpl of [async () => { throw new Error("x") }, async () => null, async () => [] ]) {
    const loop = await build(ctx, { readStatusImpl })
    assert.deepEqual(loop.evaluator.waiting, U("not_recorded"))
    assert.deepEqual(loop.steps.verify.last_result, "never_ran")
  }
}))

test("loopAlarms and unreadAlarms work from a record and its signals alone", () => scratch(async (ctx) => {
  await make(ctx, "andon", "ourostack/factory#1", { days: 9 })
  const loop = await build(ctx)
  assert.deepEqual(loopAlarms(loop), [{ name: "improvement_age", evidence: { age_days: 9 } }])
  assert.deepEqual(loopAlarms(loop, { attempted: ["route"], blocked_days: 3, cards_invalid: 1 }).map((alarm) => alarm.name), ["improvement_age", "cards_invalid"])
  assert.deepEqual(unreadAlarms(loop, { attempted: [...STEPS], blocked_days: 0, cards_invalid: 0 }), ["unsigned_age", "headless_blocked", "labels_quarantined"])
  assert.deepEqual(unreadAlarms(loop, {}), ["unsigned_age", "headless_blocked", "cards_invalid", "labels_quarantined", ...STEPS.map((step) => `step_stale:${step}`)])
  const blind = await build(ctx, { readCardsImpl: async () => ({ unreadable: true }) })
  assert.deepEqual(unreadAlarms(blind, { attempted: [...STEPS], blocked_days: 0, cards_invalid: null }), ["improvement_age", "improvement_stuck", "unsigned_age", "headless_blocked", "cards_invalid", "labels_quarantined"])
}))

test("an alarm whose input could not be read is not observed clear when it is recorded present", () => scratch(async (ctx) => {
  await observeConditions(ctx.env, { source: "loop_alarm", present: ["improvement_age", "improvement_stuck", "unsigned_age", "step_stale:mirror"], now: ago(1) })
  const out = await measure(ctx, { readCardsImpl: async () => ({ unreadable: true, cards: [] }), observe: observeConditions, attempted: [] })
  assert.deepEqual([out.ok, out.result], [true, "measured"])
  const status = await readStatus(ctx.env)
  for (const name of ["improvement_age", "improvement_stuck", "unsigned_age", "step_stale:mirror"]) assert.equal(conditionOf(status, `loop_alarm:${name}`).present, true, name)
  assert.equal(conditionOf(status, "loop_alarm:headless_blocked").state, "unavailable")
  // An alarm that was recorded clear stays clear, and one that is read and no longer holds is recorded clear.
  const read = await measure(ctx, { observe: observeConditions, attempted: [...STEPS] })
  const after = await readStatus(ctx.env)
  assert.equal(conditionOf(after, "loop_alarm:improvement_age").present, false)
  assert.equal(conditionOf(after, "loop_alarm:step_stale:mirror").present, false)
  assert.equal(read.ok, true)
}))

test("a headless factory session runs nothing and writes nothing", () => scratch(async (ctx) => {
  const spy = observer()
  const out = await runMeasureStep({ ...ctx.env, DESK_FACTORY_HEADLESS: "1" }, { deskRoot: ctx.deskRoot, now: NOW, writeCardCommitted: commit, observe: spy.observe })
  assert.deepEqual(out, { ok: false, result: "headless_session", counts: {} })
  assert.deepEqual(spy.calls, [])
  assert.equal((await readStatus(ctx.env)).loop, undefined)
}))

test("the record is written under status.loop.health, beside the other loop keys, and the step records itself", () => scratch(async (ctx) => {
  await setLoop(ctx, { evaluate: { attempts: { j: { attempts: 1, last_day: "2026-10-05" } } }, route_issues: { at: TIME, andon_open: 0, store_build_failing: 0, desk_problems_open: 0 } })
  const out = await measure(ctx)
  assert.deepEqual([out.ok, out.result], [true, "measured"])
  const { loop } = await readStatus(ctx.env)
  assert.equal(loop.health.schema, "desk.factory.loop/1")
  assert.deepEqual(loop.evaluate, { attempts: { j: { attempts: 1, last_day: "2026-10-05" } } })
  assert.equal(loop.steps.measure.last_result, "measured")
  assert.equal(loop.steps.measure.last_ok_at, NOW.toISOString())
  assert.equal(JSON.stringify(loop.health).includes("attempts"), false)
}))

test("failures: unreadable status, unwritable status, a failed card write, a throwing card write and a failed observation each give a stable code", () => scratch(async (ctx) => {
  const none = await measure(ctx, { readStatusImpl: async () => { throw new Error("x") } })
  assert.deepEqual([none.ok, none.result], [false, "status_unavailable"])
  assert.equal((await measure(ctx, { readStatusImpl: async () => "x" })).result, "status_unavailable")
  const locked = await measure(ctx, { updateStatusImpl: async () => { throw new Error("x") } })
  assert.deepEqual([locked.ok, locked.result], [false, "status_write_failed"])
  assert.equal((await readStatus(ctx.env)).loop?.steps?.measure, undefined, "a status that cannot be written leaves no step record")
  await make(ctx, "andon", "ourostack/factory#1", { days: 9 })
  const refused = await measure(ctx, { writeCardCommitted: async ({ message }) => { message({ result: "lock_busy" }); return { result: { result: "lock_busy" }, commit: "committed", left_alone: 0 } } })
  assert.deepEqual([refused.ok, refused.result], [false, "alarm_write_failed"])
  const thrown = await measure(ctx, { writeCardCommitted: async () => { throw new Error("x") } })
  assert.deepEqual([thrown.ok, thrown.result], [false, "alarm_write_failed"])
  const notCommitted = await measure(ctx, { writeCardCommitted: async (input) => ({ ...(await commit(input)), commit: "commit_failed" }) })
  assert.deepEqual([notCommitted.ok, notCommitted.result], [true, "measured"])
  assert.equal(notCommitted.counts.commit_failed, 1)
  for (const answer of [{ ok: false, result: "status_unwritable" }, new Error("x")]) {
    const bad = await measure(ctx, { observe: observer(answer).observe })
    assert.deepEqual([bad.ok, bad.result], [false, "observe_failed"])
  }
  assert.equal((await readStatus(ctx.env)).loop.steps.measure.last_result, "observe_failed")
  const record = await measure(ctx, { recordStepImpl: async () => { throw new Error("x") } })
  assert.deepEqual([record.ok, record.result], [false, "step_not_recorded"])
}))

test("an invalid deskRoot or time is refused", () => scratch(async (ctx) => {
  await assert.rejects(() => runMeasureStep(ctx.env, { deskRoot: "relative", now: NOW }), /deskRoot/u)
  await assert.rejects(() => runMeasureStep(ctx.env, { deskRoot: ctx.deskRoot, now: "nope" }), /now/u)
  await assert.rejects(() => runMeasureStep(ctx.env, { deskRoot: ctx.deskRoot, now: null }), /now/u)
  await assert.rejects(() => buildLoopHealth({ env: ctx.env, deskRoot: ctx.deskRoot, now: "nope" }), /now/u)
}))

test("an alarm card that is already open is not written again", () => scratch(async (ctx) => {
  await make(ctx, "andon", "ourostack/factory#1", { days: 9 })
  let writes = 0
  const counting = async (input) => { writes += 1; return commit(input) }
  await measure(ctx, { writeCardCommitted: counting })
  await measure(ctx, { writeCardCommitted: counting })
  assert.equal(writes, 1)
  await edit(ctx, "loop_alarm:improvement_age", { state: "closed_confirmed", closed_at: NOW.toISOString(), close_reason: "condition_cleared" })
  await measure(ctx, { writeCardCommitted: counting })
  assert.equal(writes, 2)
  assert.equal((await allCards(ctx)).find((card) => card.key === "loop_alarm:improvement_age").state, "open")
}))

test("a desk with a person prefix keeps its cards there", () => scratch(async (ctx) => {
  const prefixed = { ...ctx, personPrefix: "desks/ari" }
  await make(prefixed, "andon", "ourostack/factory#1", { days: 9 })
  const out = await measure(prefixed)
  assert.deepEqual(out.spy.calls[0].present, ["improvement_age"])
  assert.equal((await allCards(prefixed)).length, 2)
}))

test("every alarm name the step can open is in the card library's list", () => {
  for (const name of ["improvement_age", "improvement_stuck", "unsigned_age", "headless_blocked", "cards_invalid", "labels_quarantined", ...STEPS.map((step) => `step_stale:${step}`)]) assert.ok(LOOP_ALARMS.includes(name), name)
  assert.deepEqual(RECONCILE_REASONS.length > 0, true)
})

test("a slot that fails the store's rule opens the capture_loop_slot alarm once, through the real measure step", () => scratch(async (ctx) => {
  const card = { key: "andon:ourostack/factory#1", source: "andon", state: "closed_confirmed", last_opened_at: ago(1).toISOString(), closed_at: ago(1).toISOString(), recurrences: 0, reopened: 0 }
  const huge = { cards: Array.from({ length: 1000001 }, () => card), set_aside_total: 0, unreadable_files: 0 }
  const spy = observer()
  const out = await measure(ctx, { readCardsImpl: async () => huge, observe: spy.observe })
  assert.deepEqual([out.ok, out.result, out.counts.opened], [true, "measured", 1])
  assert.ok(spy.calls[0].present.includes("capture_loop_slot"))
  const stored = (await readStatus(ctx.env)).loop.health
  assert.equal(stored.improvement.closed_confirmed_30d.value, 1000001)
  assert.deepEqual((await allCards(ctx)).map((entry) => entry.key), ["loop_alarm:capture_loop_slot"])
}))

test("loop alarm cards are in no card count but loop_alarms_open: open, claimed, shipped and verifying", () => scratch(async (ctx) => {
  await make(ctx, "loop_alarm", "headless_blocked", { state: "claimed", days: 1 })
  await make(ctx, "loop_alarm", "cards_invalid", { state: "shipped", days: 1 })
  await make(ctx, "loop_alarm", "unsigned_age", { state: "verifying", days: 1 })
  await make(ctx, "loop_alarm", "labels_quarantined", { days: 1 })
  await make(ctx, "andon", "ourostack/factory#1", { state: "claimed", days: 1 })
  const { improvement, alarms } = await build(ctx)
  assert.deepEqual([improvement.open, improvement.claimed, improvement.shipped, improvement.verifying, alarms.loop_alarms_open], [M(0), M(1), M(0), M(0), M(4)])
}))
