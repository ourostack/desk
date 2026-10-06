// The loop's local route collectors: reconcile classes, delivery faults, expired evaluation requests and
// quarantined labels open improvement cards. Every test uses a throwaway desk and state folder, the real card
// library, a fake commit function, a fake labels check and a recording observer; nothing touches Git, GitHub, a
// real desk or the real factory state.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import { cardKey, claimNext, readCards, updateCard, EVALUATOR_NAMES, FLUSH_HEALTH_CODES, RECONCILE_REASONS } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { factoryStateDir } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"
import { readStatus, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { FLUSH_CONFIRM_RUNS, MIN_RUN_GAP_HOURS, runRouteLocalStep } from "../../../../../plugins/desk/mcp/src/factory/route-local.js"

const T0 = new Date("2026-10-05T00:00:00Z")
const at = (hours) => new Date(T0.getTime() + hours * 3600 * 1000)
const REASON = RECONCILE_REASONS[0]

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-route-local-")))
  const deskRoot = path.join(base, "desk")
  await fs.mkdir(deskRoot, { recursive: true })
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  try {
    return await run({ env, deskRoot, personPrefix: "", base })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const setStatus = (ctx, patch) => updateStatus(ctx.env, (status) => ({ ...status, ...patch }))
const cards = async (ctx) => (await readCards({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix })).cards
const keys = async (ctx) => (await cards(ctx)).map((card) => card.key).sort()

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

const quiet = () => ({ quarantined: 0, count: 0 })
const run = (ctx, hours = 0, seams = {}) => {
  const spy = seams.observe === undefined ? observer() : null
  return runRouteLocalStep(ctx.env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: at(hours), writeCardCommitted: commit, labelsCheck: quiet, observe: spy?.observe, ...seams }).then((out) => ({ ...out, spy }))
}
const reconcileSummary = (runs) => ({ at: "2026-10-04T00:00:00.000Z", window_days: 7, desks: 1, runs, warnings: [], last_result: "reconciled" })

test("a reconcile class seen in 1 run opens nothing; in 2 consecutive runs opens one card with a pointer", () => scratch(async (ctx) => {
  await setStatus(ctx, { reconcile: reconcileSummary({ [REASON]: { consecutive: 1, count: 3, clear: 0 } }) })
  const one = await run(ctx)
  assert.deepEqual([one.ok, one.result, one.opened], [true, "routed", []])
  assert.deepEqual(await keys(ctx), [])
  assert.equal(one.spy.calls.some((call) => call.source === "reconcile_class"), false)
  await setStatus(ctx, { reconcile: reconcileSummary({ [REASON]: { consecutive: 2, count: 3, clear: 0 } }) })
  const two = await run(ctx, 1)
  assert.deepEqual(two.opened, [cardKey("reconcile_class", REASON)])
  assert.deepEqual(two.counts.opened, 1)
  const [card] = await cards(ctx)
  assert.deepEqual(card.evidence, [`reconcile:${REASON}@3`])
  assert.equal(card.title, `Reconcile mismatch: ${REASON}`)
  const again = await run(ctx, 2)
  assert.deepEqual([again.opened, again.counts.duplicate], [[], 1])
}))

test("a clear or malformed reconcile reason opens nothing and the source is never observed (verify closes from the summary)", () => scratch(async (ctx) => {
  await setStatus(ctx, { reconcile: reconcileSummary({ [REASON]: { consecutive: 0, count: 0, clear: 2 }, [RECONCILE_REASONS[1]]: { consecutive: 5, count: 0, clear: 0 }, bogus: { consecutive: 9, count: 9, clear: 0 }, [RECONCILE_REASONS[2]]: "x", [RECONCILE_REASONS[3]]: { consecutive: -1, count: 1, clear: 0 } }) })
  const out = await run(ctx)
  assert.deepEqual(out.opened, [])
  assert.equal(out.spy.calls.some((call) => call.source === "reconcile_class"), false)
}))

test("a missing, malformed or not-completed reconcile summary observes nothing and opens nothing", () => scratch(async (ctx) => {
  for (const reconcile of [undefined, { at: null, runs: {} }, { at: "2026-10-04T00:00:00.000Z" }, []]) {
    await setStatus(ctx, { reconcile })
    const out = await run(ctx)
    assert.equal(out.counts.no_reconcile_summary, 1)
    assert.equal(out.spy.calls.some((call) => call.source === "reconcile_class"), false)
  }
  assert.deepEqual(await keys(ctx), [])
}))

for (const code of ["no_account", "auth_failed", "gh_missing", "account_cannot_deliver", "route_unknown"]) {
  test(`flush result ${code} opens its card after 2 runs and not before; a recovery resets`, () => scratch(async (ctx) => {
    await setStatus(ctx, { last_flush: { "ourostack/factory": { at: "2026-10-04T00:00:00.000Z", result: code } } })
    const first = await run(ctx, 0)
    assert.deepEqual([first.opened, await keys(ctx)], [[], []])
    assert.deepEqual(first.spy.calls.find((call) => call.source === "flush_health").present, [code])
    assert.equal((await readStatus(ctx.env)).loop.route_seen.flush[code].runs, 1)
    await setStatus(ctx, { last_flush: { "ourostack/factory": { at: "2026-10-04T06:00:00.000Z", result: "delivered" } } })
    const clear = await run(ctx, MIN_RUN_GAP_HOURS)
    assert.deepEqual(clear.spy.calls.find((call) => call.source === "flush_health").present, [])
    assert.deepEqual((await readStatus(ctx.env)).loop.route_seen.flush, {})
    await setStatus(ctx, { last_flush: { "ourostack/factory": { at: "2026-10-04T12:00:00.000Z", result: code } } })
    assert.deepEqual((await run(ctx, 2 * MIN_RUN_GAP_HOURS)).opened, [])
    const second = await run(ctx, 3 * MIN_RUN_GAP_HOURS)
    assert.deepEqual(second.opened, [cardKey("flush_health", code)])
    assert.deepEqual((await cards(ctx))[0].evidence, [])
  }))
}

test("held markers and frozen counts count as faults; zero or non-count values do not", () => scratch(async (ctx) => {
  await setStatus(ctx, { last_flush: { a: { result: "delivered", held_elsewhere: 2, retraction_stalled: 1 }, b: { result: "delivered", held_elsewhere: 0, retraction_stalled: "3" }, c: "x" } })
  const first = await run(ctx, 0)
  assert.deepEqual(first.spy.calls.find((call) => call.source === "flush_health").present, ["frozen", "held_markers"])
  const second = await run(ctx, MIN_RUN_GAP_HOURS)
  assert.deepEqual(second.opened.sort(), [cardKey("flush_health", "frozen"), cardKey("flush_health", "held_markers")])
  await setStatus(ctx, { last_flush: { a: { result: "delivered", route_unknown: 1 } } })
  const third = await run(ctx, 2 * MIN_RUN_GAP_HOURS)
  assert.deepEqual(third.spy.calls.find((call) => call.source === "flush_health").present, ["route_unknown"])
}))

test("a run inside the short gap does not count twice; a clock that moved back does not count", () => scratch(async (ctx) => {
  await setStatus(ctx, { last_flush: { s: { result: "no_account" } } })
  await run(ctx, 1)
  const inside = await run(ctx, 1.5)
  assert.deepEqual(inside.opened, [])
  assert.equal((await readStatus(ctx.env)).loop.route_seen.flush.no_account.runs, 1)
  const back = await run(ctx, 0)
  assert.deepEqual(back.opened, [])
  assert.equal((await readStatus(ctx.env)).loop.route_seen.flush.no_account.seen_at, at(0).toISOString())
  assert.equal(FLUSH_CONFIRM_RUNS, 2)
  const later = await run(ctx, MIN_RUN_GAP_HOURS)
  assert.deepEqual(later.opened, [cardKey("flush_health", "no_account")])
}))

test("damaged counters start again at one run; other loop keys are kept", () => scratch(async (ctx) => {
  await setStatus(ctx, { last_flush: { s: { result: "gh_missing" } }, loop: { steps: { route: { runs: 4 } }, route_seen: { flush: { gh_missing: { runs: "x", seen_at: "nope" }, bogus: { runs: 1 } } } } })
  await run(ctx, 0)
  const status = await readStatus(ctx.env)
  assert.equal(status.loop.route_seen.flush.gh_missing.runs, 1)
  assert.equal(Object.hasOwn(status.loop.route_seen.flush, "bogus"), false)
  assert.deepEqual(status.loop.steps, { route: { runs: 4 } })
  await setStatus(ctx, { loop: { ...status.loop, route_seen: "junk" } })
  await run(ctx, 1)
  assert.equal((await readStatus(ctx.env)).loop.route_seen.flush.gh_missing.runs, 1)
}))

test("no last_flush entry opens nothing, observes nothing and keeps the counters", () => scratch(async (ctx) => {
  await setStatus(ctx, { last_flush: { s: { result: "no_account" } } })
  await run(ctx, 0)
  for (const last_flush of [{}, { s: "x" }]) {
    await setStatus(ctx, { last_flush })
    const out = await run(ctx, 1)
    assert.equal(out.counts.no_last_flush, 1)
    assert.equal(out.spy.calls.some((call) => call.source === "flush_health"), false)
    assert.equal((await readStatus(ctx.env)).loop.route_seen.flush.no_account.runs, 1)
  }
  await setStatus(ctx, { last_flush: { s: { result: "no_account" } }, loop: {} })
  await setStatus(ctx, { last_flush: {} })
  const none = await run(ctx, 2)
  assert.equal(none.counts.no_last_flush, 1)
  assert.deepEqual((await readStatus(ctx.env)).loop.route_seen, { flush: {} })
}))

test("a nonzero expired_total opens evaluator:expired_requests once; no rise afterwards is not present; a rise opens again", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 2, gave_up: 0 } })
  const first = await run(ctx, 0)
  assert.deepEqual(first.opened, [cardKey("evaluator", "expired_requests")])
  assert.deepEqual(first.spy.calls.find((call) => call.source === "evaluator").present, ["expired_requests"])
  const second = await run(ctx, 1)
  assert.deepEqual(second.opened, [])
  assert.deepEqual(second.spy.calls.find((call) => call.source === "evaluator").present, [])
  assert.equal((await readStatus(ctx.env)).loop.route_seen.expired_total, 2)
  await setStatus(ctx, { evaluator: { expired_total: 3, gave_up: 0 } })
  const third = await run(ctx, 2)
  assert.equal(third.counts.duplicate, 1)
  await setStatus(ctx, { evaluator: { expired_total: 0, gave_up: 0 } })
  const reset = await run(ctx, 3)
  assert.deepEqual(reset.spy.calls.find((call) => call.source === "evaluator").present, [])
  assert.equal((await readStatus(ctx.env)).loop.route_seen.expired_total, 0)
}))

test("a zero expired_total on the first look opens nothing; gave_up above zero opens evaluator:gave_up", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 0, gave_up: 1 } })
  const out = await run(ctx)
  assert.deepEqual(out.opened, [cardKey("evaluator", "gave_up")])
  assert.deepEqual(out.spy.calls.find((call) => call.source === "evaluator").present, ["gave_up"])
  assert.ok(EVALUATOR_NAMES.includes("gave_up"))
  assert.equal((await cards(ctx))[0].title, "Evaluation requests were given up after repeated attempts")
}))

test("missing or partial evaluator data is not observed; the baseline is kept", () => scratch(async (ctx) => {
  const out = await run(ctx)
  assert.equal(out.counts.no_evaluator_data, 1)
  assert.equal(out.spy.calls.some((call) => call.source === "evaluator"), false)
  await setStatus(ctx, { evaluator: { expired_total: 4 } })
  const partial = await run(ctx, 1)
  assert.deepEqual(partial.opened, [cardKey("evaluator", "expired_requests")])
  assert.equal(partial.counts.no_evaluator_data, 1)
  assert.equal(partial.spy.calls.some((call) => call.source === "evaluator"), false)
  await setStatus(ctx, { evaluator: { expired_total: "x", gave_up: -1 } })
  const bad = await run(ctx, 2)
  assert.equal(bad.counts.no_evaluator_data, 1)
  assert.equal((await readStatus(ctx.env)).loop.route_seen.expired_total, 4)
}))

test("a quarantined-labels count above zero opens loop_alarm:labels_quarantined and records the count for the measure step; this step never observes loop_alarm", () => scratch(async (ctx) => {
  const out = await run(ctx, 0, { labelsCheck: () => ({ count: 1, quarantined: 3 }) })
  assert.deepEqual(out.opened, [cardKey("loop_alarm", "labels_quarantined")])
  assert.equal(out.spy.calls.some((call) => call.source === "loop_alarm"), false)
  assert.deepEqual((await readStatus(ctx.env)).loop.labels_quarantined, { count: 3, at: at(0).toISOString() })
  assert.equal((await cards(ctx))[0].title, "Evaluation labels were quarantined")
  const clear = await run(ctx, 1, { labelsCheck: () => ({ quarantined: 0 }) })
  assert.deepEqual(clear.opened, [])
  assert.deepEqual((await readStatus(ctx.env)).loop.labels_quarantined, { count: 0, at: at(1).toISOString() })
}))

test("a labels check that fails or answers badly records nothing and says so", () => scratch(async (ctx) => {
  for (const labelsCheck of [() => { throw new Error("x") }, () => ({ quarantined: "3" }), () => null]) {
    const out = await run(ctx, 0, { labelsCheck })
    assert.equal(out.counts.labels_unreadable, 1)
    assert.equal(Object.hasOwn((await readStatus(ctx.env)).loop ?? {}, "labels_quarantined"), false)
  }
}))

test("nothing written contains a path, a store name or a login", () => scratch(async (ctx) => {
  await setStatus(ctx, {
    last_flush: { "ourostack/factory": { at: "2026-10-04T00:00:00.000Z", result: "no_account", account: "someone-login", path: ctx.base } },
    reconcile: reconcileSummary({ [REASON]: { consecutive: 2, count: 4, clear: 0 } }),
    evaluator: { expired_total: 1, gave_up: 1 },
  })
  await run(ctx, 0, { labelsCheck: () => ({ quarantined: 1 }) })
  await run(ctx, MIN_RUN_GAP_HOURS, { labelsCheck: () => ({ quarantined: 1 }) })
  const written = []
  for (const name of await fs.readdir(path.join(ctx.deskRoot, "_meta", "improvement"))) written.push(await fs.readFile(path.join(ctx.deskRoot, "_meta", "improvement", name), "utf8"))
  written.push(JSON.stringify((await readStatus(ctx.env)).loop))
  const all = written.join("\n")
  for (const secret of [ctx.base, "ourostack", "someone-login", os.tmpdir()]) assert.equal(all.includes(secret), false, secret)
  assert.equal(written.length, 6)
  assert.deepEqual(FLUSH_HEALTH_CODES.includes("no_account"), true)
}))

test("an unreadable status opens nothing and is reported; a headless session runs nothing", () => scratch(async (ctx) => {
  for (const readStatusImpl of [async () => { throw new Error("x") }, async () => []]) {
    const out = await run(ctx, 0, { readStatusImpl })
    assert.deepEqual([out.ok, out.result, out.opened, out.counts], [false, "status_unavailable", [], {}])
    assert.equal(out.spy.calls.length, 0)
  }
  const headless = await runRouteLocalStep({ ...ctx.env, DESK_FACTORY_HEADLESS: "1" }, { deskRoot: ctx.deskRoot, now: T0, writeCardCommitted: () => assert.fail("wrote") })
  assert.deepEqual([headless.ok, headless.result], [false, "headless_session"])
  await assert.rejects(() => runRouteLocalStep(ctx.env, { deskRoot: "relative" }), /absolute/)
  await assert.rejects(() => runRouteLocalStep(ctx.env, { deskRoot: ctx.deskRoot, now: "nope" }), /valid time/)
  assert.equal(await fs.stat(path.join(ctx.base, "state")).then(() => true, () => false), false)
}))

test("a status that cannot be saved opens no card and reports it", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 1, gave_up: 0 } })
  const out = await run(ctx, 0, { updateStatusImpl: async () => { throw new Error("x") } })
  assert.deepEqual([out.ok, out.result, out.counts, out.opened], [false, "status_write_failed", { no_last_flush: 1, status_write_failed: 1 }, []])
  assert.deepEqual(await keys(ctx), [])
}))

test("a failed observation is counted and does not stop the step; a card that cannot be written is reported", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 1, gave_up: 1 } })
  const down = await run(ctx, 0, { observe: async () => ({ ok: false, result: "status_unwritable" }) })
  assert.equal(down.counts.observe_failed, 1)
  assert.equal(down.ok, true)
  const thrown = await run(ctx, 1, { observe: async () => { throw new Error("x") } })
  assert.equal(thrown.counts.observe_failed, 1)
  const bad = await run(ctx, 2, { writeCardCommitted: async () => { throw new Error("x") } })
  assert.deepEqual([bad.ok, bad.result, bad.counts.card_write_failed], [false, "card_write_failed", 1])
  const refused = await run(ctx, 3, { writeCardCommitted: async () => ({ result: { result: "lock_busy" }, commit: "committed" }) })
  assert.deepEqual([refused.ok, refused.counts.card_write_failed], [false, 1])
}))

test("a commit that did not happen is counted under its code", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 1, gave_up: 0 } })
  const out = await run(ctx, 0, { writeCardCommitted: async ({ write }) => ({ result: await write(), commit: "not_git" }) })
  assert.deepEqual([out.ok, out.counts.opened, out.counts.not_git], [true, 1, 1])
  const quietCommit = await run(ctx, 1, { writeCardCommitted: async ({ write }) => ({ result: await write(), commit: "no_change" }) })
  assert.equal(quietCommit.counts.not_git, undefined)
  const none = await run(ctx, 2, { writeCardCommitted: async ({ write }) => ({ result: await write(), commit: "no_files" }) })
  assert.equal(none.counts.not_git, undefined)
}))

test("the real observer records the condition when none is injected", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 1, gave_up: 0 } })
  const out = await runRouteLocalStep(ctx.env, { deskRoot: ctx.deskRoot, labelsCheck: quiet, writeCardCommitted: commit })
  assert.equal(out.ok, true)
  assert.ok((await readStatus(ctx.env)).loop.conditions["evaluator:expired_requests"].present)
}))

test("a closed card whose condition returns is reopened", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 0, gave_up: 1 } })
  await run(ctx, 0)
  const key = cardKey("evaluator", "gave_up")
  const claim = await claimNext({ env: ctx.env, deskRoot: ctx.deskRoot, personPrefix: "", now: at(1) })
  assert.equal(claim.result, "claimed")
  const closed = await updateCard({ deskRoot: ctx.deskRoot, personPrefix: "", key, claim_id: claim.claim_id, patch: { state: "closed_unverified", close_reason: "wont_fix" }, now: at(1) })
  assert.equal(closed.result, "updated")
  const out = await run(ctx, 2)
  assert.deepEqual([out.opened, out.counts.reopened], [[key], 1])
}))

test("the commit message falls back for a result without a file, and a status with no last_flush object reads as no look", () => scratch(async (ctx) => {
  const messages = []
  await setStatus(ctx, { evaluator: { expired_total: 1, gave_up: 0 } })
  const out = await run(ctx, 0, {
    readStatusImpl: async () => ({ last_flush: null, evaluator: { expired_total: 1, gave_up: 0 } }),
    writeCardCommitted: async ({ write, message }) => { messages.push(message({})); return { result: await write(), commit: "committed" } },
  })
  assert.equal(out.counts.no_last_flush, 1)
  assert.deepEqual(messages, ["improvement: route set_aside"])
}))

test("a card write that fails on a rise keeps the old baseline, so the next look still opens the card", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 1, gave_up: 0 } })
  await run(ctx, 0)
  await setStatus(ctx, { evaluator: { expired_total: 3, gave_up: 0 } })
  const failed = await run(ctx, 1, { writeCardCommitted: async () => { throw new Error("x") } })
  assert.equal(failed.result, "card_write_failed")
  assert.equal((await readStatus(ctx.env)).loop.route_seen.expired_total, 1)
  const next = await run(ctx, 2)
  assert.equal(next.counts.duplicate, 1)
  assert.equal((await readStatus(ctx.env)).loop.route_seen.expired_total, 3)
}))

test("a first look that fails to write its card is retried on the next look", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 2, gave_up: 0 } })
  await run(ctx, 0, { writeCardCommitted: async () => { throw new Error("x") } })
  assert.equal((await readStatus(ctx.env)).loop.route_seen.expired_seen, undefined)
  const next = await run(ctx, 1)
  assert.deepEqual(next.opened, [cardKey("evaluator", "expired_requests")])
}))

test("a missing or damaged baseline after one was written is not a first look: it opens nothing, records the total and says so", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 2, gave_up: 0 } })
  await run(ctx, 0)
  for (const [index, bad] of [undefined, "x", -1].entries()) {
    const status = await readStatus(ctx.env)
    const { expired_total: _gone, ...rest } = status.loop.route_seen
    await setStatus(ctx, { loop: { ...status.loop, route_seen: bad === undefined ? rest : { ...rest, expired_total: bad } } })
    const out = await run(ctx, 1 + index)
    assert.deepEqual([out.opened, out.counts.expired_baseline_reset], [[], 1])
    assert.equal(out.spy.calls.some((call) => call.source === "evaluator"), false)
    assert.equal((await readStatus(ctx.env)).loop.route_seen.expired_total, 2)
  }
}))

test("a failed baseline write is counted and the look still counts as made", () => scratch(async (ctx) => {
  await setStatus(ctx, { evaluator: { expired_total: 2, gave_up: 0 } })
  let calls = 0
  const out = await run(ctx, 0, { updateStatusImpl: async (env, mutate) => { calls += 1; if (calls === 2) throw new Error("x"); return updateStatus(env, mutate) } })
  assert.deepEqual([out.ok, out.counts.baseline_write_failed, out.counts.opened], [true, 1, 1])
}))

test("a labels folder that cannot be read records nothing, not a zero", () => scratch(async (ctx) => {
  const out = await run(ctx, 0, { labelsCheck: () => ({ quarantined: 0 }), labelsReadable: () => false })
  assert.equal(out.counts.labels_unreadable, 1)
  assert.equal(Object.hasOwn((await readStatus(ctx.env)).loop ?? {}, "labels_quarantined"), false)
}))

test("the default readability check treats a missing folder as readable and a file in its place as not", () => scratch(async (ctx) => {
  const ok = await run(ctx, 0)
  assert.equal(ok.counts.labels_unreadable, undefined)
  assert.equal((await readStatus(ctx.env)).loop.labels_quarantined.count, 0)
  await fs.writeFile(path.join(factoryStateDir(ctx.env), "evaluate-requests"), "x")
  const bad = await run(ctx, 1)
  assert.equal(bad.counts.labels_unreadable, 1)
  assert.equal((await readStatus(ctx.env)).loop.labels_quarantined.at, at(0).toISOString())
}))
