// The loop's verify step: close, reopen and escalate improvement cards. Every test uses a throwaway desk and state
// folder, the real card library, a fake GitHub (reader, issues client, release lookup, merged-with-green reader)
// and a fake commit function; nothing touches Git, GitHub, a real desk or the real factory state.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import { cardFile, cardKey, claimNext, MEASURE_IDS, openImprovement, readCards, RECONCILE_REASONS } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { readStatus, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import {
  CHECK_GAP_HOURS, CONFIRMED_COMMENT, DESK_PROBLEM_QUIET_DAYS, MAX_CHECKS_PER_RUN, MAX_READING_AGE_HOURS, RECURRING_VERIFYING_CHECKS, THIN_CHECKS_BEFORE_ESCALATION, UNVERIFIED_COMMENT,
  githubAccess, reading, runVerifyStep, withFields,
} from "../../../../../plugins/desk/mcp/src/factory/improvement-verify.js"

const NOW = new Date("2026-10-05T12:00:00.000Z")
const DAY = 24 * 3600 * 1000
const SIGNAL = MEASURE_IDS[0]
const PR = "https://github.com/ourostack/desk/pull/12"
const ISSUE = "https://github.com/ourostack/factory/issues/11"
const FR = "0123456789abcdef0123456789abcdef"
const FR2 = "fedcba9876543210fedcba9876543210"
const JOB = "00112233445566778899aabbccddeeff"
const REASON = RECONCILE_REASONS[0]
const ANDON = "ourostack/factory#5"
const DESK_PROBLEM = "ourostack/desk#12"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-verify-step-")))
  const deskRoot = path.join(base, "desk")
  mkdirSync(path.join(deskRoot, "_meta"), { recursive: true })
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  try {
    return await run({ env, deskRoot, personPrefix: "", base })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const open = (ctx, source, id, extra = {}) => openImprovement({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: cardKey(source, id), source, now: NOW, evidence: [], plugin: "desk", signal: null, ...extra })
const cards = async (ctx) => (await readCards({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix })).cards
const byKey = async (ctx, key) => (await cards(ctx)).find((card) => card.key === key)

// The card library is the only writer in production; a test sets up states the claim caps would make slow by editing front matter.
async function edit(ctx, key, fields) {
  const file = cardFile(ctx.deskRoot, ctx.personPrefix, key)
  let text = await fs.readFile(file, "utf8")
  for (const [name, value] of Object.entries(fields)) text = text.replace(new RegExp(`^${name}: .*$`, "m"), () => `${name}: ${JSON.stringify(value)}`)
  await fs.writeFile(file, text)
}
// `make(ctx, source, id, state, fields, openExtra)`: a card in a given state. The library builds every title.
async function make(ctx, source, id, state, fields = {}, openExtra = {}) {
  const extra = openExtra
  await open(ctx, source, id, extra)
  const key = cardKey(source, id)
  const base = state === "shipped" ? { state, countermeasure: PR } : state === "verifying" ? { state, countermeasure: PR, shipped_version: "3.2.0", verifying_since: new Date(NOW.getTime() - 2 * DAY).toISOString() } : {}
  if (Object.keys({ ...base, ...fields }).length > 0) await edit(ctx, key, { ...base, ...fields })
  return key
}

const commits = []
const commit = async ({ write, message }) => {
  const written = await write()
  const { file, ...rest } = written
  const result = typeof file === "string" ? { ...rest, file_name: path.basename(file) } : rest
  commits.push(typeof message === "function" ? message(result) : message)
  return { result, commit: "committed", left_alone: 0 }
}

const BODY = (cm = "null", version = "null") => `Card text\n\n\`\`\`yaml\nkaizen: 1\nsignal: ${SIGNAL}\njob_class: any\nevidence_jobs: []\ncountermeasure: ${cm}\nplugin: desk\nversion: ${version}\nhypothesis: { measure: ${SIGNAL}, direction: down }\n\`\`\`\n`
const mirrored = { signal: SIGNAL, kaizen_url: ISSUE }

function world({ failComment = false, issues = {}, found = { state: "version", version: "3.2.0" }, mergedState = "merged_green", status = {}, arm = { armed: true }, failClose = false } = {}) {
  const w = { issues, status, writes: [], comments: [], removed: [], gets: [], shippedCalls: [], mergedCalls: [], armCalls: 0, accessCalls: 0 }
  const reader = {
    async get(route) {
      w.gets.push(route)
      const issue = w.issues[/\/issues\/(\d+)$/u.exec(route)?.[1]]
      if (issue === undefined) throw Object.assign(new Error("missing"), { code: "http_404" })
      return { state: "open", labels: [], body: "", ...issue }
    },
  }
  const client = {
    async createComment(number, body) {
      if (failComment) throw new Error("refused")
      w.comments.push([number, body])
    },
    async updateIssue(number, patch) {
      if (failClose && patch.state === "closed") throw new Error("refused")
      w.writes.push([number, patch])
      if (patch.body !== undefined) w.issues[number].body = patch.body
      if (patch.state !== undefined) w.issues[number].state = patch.state
    },
    async removeLabel(number, label) {
      w.removed.push([number, label])
      w.issues[number].labels = w.issues[number].labels.filter((name) => name !== label)
    },
  }
  w.access = async () => { w.accessCalls += 1; return { ok: true, reader, issues: () => client } }
  w.shipped = async (input) => { w.shippedCalls.push(input); return typeof found === "function" ? found(input) : found }
  w.merged = async (input) => { w.mergedCalls.push(input); return { state: typeof mergedState === "function" ? mergedState(input) : mergedState } }
  w.arm = async (_env, { now }) => { w.armCalls += 1; w.armedAt = now(); return arm }
  return w
}

const recorded = []
const go = (ctx, w, over = {}) => runVerifyStep(ctx.env, {
  deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: NOW, access: w.access, shipped: w.shipped, merged: w.merged,
  readStatusImpl: async () => w.status, armImpl: w.arm, writeCardCommitted: commit, recordStepImpl: async (env, name, record) => { recorded.push({ name, ...record }) }, ...over,
})

const cond = (key, over = {}) => ({ [key]: { present: false, clear_runs: 1, observed_at: NOW.toISOString(), counted_at: NOW.toISOString(), ...over } })
const conditions = (...entries) => ({ loop: { conditions: Object.assign({}, ...entries) } })

test("a shipped card whose release is found gets its version on the card and the mirror issue, and a stale verdict label is cleared", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped", mirrored)
  const w = world({ issues: { 11: { body: BODY(), labels: ["kaizen", "not-confirmed"] } } })
  const out = await go(ctx, w)
  assert.deepEqual(out, { ok: true, result: "verified", counts: { version_set: 1 } })
  const card = await byKey(ctx, key)
  assert.equal(card.state, "verifying")
  assert.equal(card.shipped_version, "3.2.0")
  assert.equal(card.last_check_result, "version_set")
  assert.equal(card.last_check_at, NOW.toISOString())
  assert.equal(card.checks_run, 0)
  assert.equal(w.issues[11].body, BODY(PR, "3.2.0"))
  assert.deepEqual(w.removed, [[11, "not-confirmed"]])
  assert.deepEqual(w.shippedCalls.map((call) => [call.plugin, call.countermeasure]), [["desk", PR]])
  assert.match(commits.at(-1), /^improvement: verify friction_candidate--[0-9a-f]{12}\.md$/u)
  assert.equal(recorded.at(-1).name, "verify")
}))

test("a confirmed label closes the card and the mirror issue with one fixed comment that names no person or time", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["kaizen", "confirmed"] } } })
  const out = await go(ctx, w)
  assert.deepEqual(out.counts, { closed_confirmed: 1, confirmed: 1 })
  const card = await byKey(ctx, key)
  assert.equal(card.state, "closed_confirmed")
  assert.equal(card.close_reason, "confirmed")
  assert.deepEqual(w.comments, [[11, CONFIRMED_COMMENT]])
  assert.deepEqual(w.writes, [[11, { state: "closed", state_reason: "completed" }]])
  assert.match(CONFIRMED_COMMENT, /^[^0-9@]*$/u)
  assert.match(UNVERIFIED_COMMENT, /^[^0-9@]*$/u)
}))

test("an issue that is already closed gets no second comment", () => scratch(async (ctx) => {
  await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { state: "closed", body: BODY(PR, "3.2.0"), labels: ["confirmed"] } } })
  await go(ctx, w)
  assert.deepEqual(w.comments, [])
  assert.deepEqual(w.writes, [])
}))

test("a not-confirmed label reopens the card ahead of a later card, with the verdict as an issue pointer, and resets the issue", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", { ...mirrored, checks_run: 4 }, { evidence: [`job:${JOB}`], now: new Date(NOW.getTime() - 2 * DAY) })
  await make(ctx, "friction_candidate", FR2, "open", {}, { now: new Date(NOW.getTime() - DAY) })
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["not-confirmed"] } } })
  const out = await go(ctx, w)
  assert.deepEqual(out.counts, { reopened: 1, not_confirmed: 1 })
  const card = await byKey(ctx, key)
  assert.equal(card.state, "open")
  assert.equal(card.countermeasure, null)
  assert.equal(card.shipped_version, null)
  assert.equal(card.checks_run, 0)
  assert.equal(card.reopened, 1)
  assert.deepEqual(card.evidence, [`job:${JOB}`, "issue:ourostack/factory#11"])
  assert.equal(card.kaizen_url, ISSUE)
  assert.equal(w.issues[11].body, BODY("null", "null"))
  const claimed = await claimNext({ env: ctx.env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: NOW })
  assert.equal(claimed.card.key, key)
}))

test("both verdict labels, or a store body that changed this run, decide nothing", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["confirmed", "not-confirmed"] } } })
  assert.deepEqual((await go(ctx, w)).counts, { thin_data: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 1)
  const later = new Date(NOW.getTime() + DAY)
  w.issues[11].body = BODY(PR, "null")
  w.issues[11].labels = ["confirmed"]
  assert.deepEqual((await go(ctx, w, { now: later })).counts, { thin_data: 1 })
  assert.equal(w.issues[11].body, BODY(PR, "3.2.0"))
  assert.equal((await byKey(ctx, key)).state, "verifying")
}))

test("13 checks without a verdict change no state; the 14th closes unverified on a merged green fix, and the issue too", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["kaizen"] } } })
  for (let day = 0; day < 13; day += 1) await go(ctx, w, { now: new Date(NOW.getTime() + day * DAY) })
  let card = await byKey(ctx, key)
  assert.equal(card.checks_run, 13)
  assert.equal(card.state, "verifying")
  assert.equal(card.last_check_result, "thin_data")
  assert.equal(THIN_CHECKS_BEFORE_ESCALATION, 14)
  const out = await go(ctx, w, { now: new Date(NOW.getTime() + 13 * DAY) })
  assert.deepEqual(out.counts, { closed_unverified: 1, thin_data_after_14_checks: 1 })
  card = await byKey(ctx, key)
  assert.equal(card.state, "closed_unverified")
  assert.equal(card.close_reason, "thin_data_after_14_checks")
  assert.deepEqual(w.comments, [[11, UNVERIFIED_COMMENT]])
  assert.deepEqual(w.writes.at(-1), [11, { state: "closed", state_reason: "not_planned" }])
}))

test("on the 14th check an unmerged fix goes back to open with a note; a merged fix whose checks are not green, or a merge state that cannot be read, waits and advances nothing", () => scratch(async (ctx) => {
  for (const [state, expected, counts, checks] of [
    ["not_merged", "open", { reopened: 1, countermeasure_not_merged: 1 }, 0],
    ["merged_not_green", "verifying", { checks_not_green: 1 }, 13],
    ["unavailable", "verifying", { unreadable: 1 }, 13],
  ]) {
    const key = await make(ctx, "friction_candidate", FR, "verifying", { ...mirrored, checks_run: 13 })
    const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: [] } }, mergedState: state })
    const out = await go(ctx, w)
    const card = await byKey(ctx, key)
    assert.equal(card.state, expected, state)
    assert.deepEqual(out.counts, counts, state)
    assert.equal(card.checks_run, checks, state)
    if (expected === "verifying") {
      assert.equal(card.last_check_at, NOW.toISOString())
      assert.equal(card.last_check_result, state === "unavailable" ? "waiting" : "checks_not_green")
    }
    await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  }
}))

test("a second run in the same day does nothing", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: [] } } })
  await go(ctx, w)
  const seen = w.gets.length
  const again = await go(ctx, w, { now: new Date(NOW.getTime() + (CHECK_GAP_HOURS - 1) * 3600 * 1000) })
  assert.deepEqual(again, { ok: true, result: "nothing_to_verify", counts: {} })
  assert.equal(w.gets.length, seen)
  assert.equal((await byKey(ctx, key)).checks_run, 1)
  // a clock that moved backwards does not hold a card forever
  await go(ctx, w, { now: new Date(NOW.getTime() - DAY) })
  assert.equal((await byKey(ctx, key)).checks_run, 2)
}))

test("a recovered open or claimed card closes unverified as source_recovered, whatever its state", () => scratch(async (ctx) => {
  const status = conditions(cond(`andon:${ANDON}`), cond("loop_alarm:improvement_age", { clear_runs: 2 }))
  const open1 = await make(ctx, "andon", ANDON, "open")
  const held = await make(ctx, "loop_alarm", "improvement_age", "open")
  const claim = await claimNext({ env: ctx.env, deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: NOW })
  assert.equal(claim.card.key, open1)
  const w = world({ status })
  const out = await go(ctx, w)
  assert.deepEqual(out.counts, { closed_unverified: 2, source_recovered: 2 })
  assert.equal(w.accessCalls, 0)
  const claimed = await byKey(ctx, open1)
  assert.equal(claimed.state, "closed_unverified")
  assert.equal(claimed.close_reason, "source_recovered")
  assert.equal(claimed.claim.expires_at, null)
  assert.equal((await byKey(ctx, held)).close_reason, "source_recovered")
}))

test("a recovered open card with a mirror issue closes its issue too", () => scratch(async (ctx) => {
  await make(ctx, "andon", ANDON, "open", mirrored)
  const w = world({ status: conditions(cond(`andon:${ANDON}`)), issues: { 11: { body: BODY(), labels: [] } } })
  const out = await go(ctx, w)
  assert.deepEqual(out.counts, { closed_unverified: 1, source_recovered: 1 })
  assert.deepEqual(w.comments, [[11, UNVERIFIED_COMMENT]])
}))

test("andon: closed confirmed when the store's issue is closed, reopened when it keeps recurring after a few checks, waiting while a count is short", () => scratch(async (ctx) => {
  const key = await make(ctx, "andon", ANDON, "shipped")
  const w = world({ status: conditions(cond(`andon:${ANDON}`)) })
  assert.deepEqual((await go(ctx, w)).counts, { closed_confirmed: 1, andon_closed: 1 })
  assert.equal((await byKey(ctx, key)).state, "closed_confirmed")
  assert.equal(w.shippedCalls.length, 0)
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  await make(ctx, "andon", ANDON, "verifying", { checks_run: 0 })
  const present = world({ status: conditions(cond(`andon:${ANDON}`, { present: true, clear_runs: 0 })) })
  assert.equal(RECURRING_VERIFYING_CHECKS, 3)
  assert.deepEqual((await go(ctx, present)).counts, { waiting: 1 })
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, present)).counts, { waiting: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 2)
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, present)).counts, { reopened: 1, still_recurring: 1 })
  assert.equal((await byKey(ctx, key)).state, "open")
}))

test("a store build, loop alarm, evaluator and flush health card close on their own clear counts", () => scratch(async (ctx) => {
  const cases = [["store_build", "ourostack/factory#8", 1, "store_build_closed"], ["loop_alarm", "improvement_age", 2, "condition_cleared"], ["loop_alarm", "capture_loop_slot", 2, "condition_cleared"], ["evaluator", "expired_requests", 2, "condition_cleared"], ["flush_health", "no_account", 2, "condition_cleared"]]
  for (const [source, id, need, reason] of cases) {
    const key = cardKey(source, id)
    await make(ctx, source, id, "verifying")
    const short = world({ status: conditions(cond(key, { clear_runs: need - 1 })) })
    if (need > 1) {
      assert.deepEqual((await go(ctx, short)).counts, { waiting: 1 })
      await edit(ctx, key, { last_check_at: null })
    }
    const enough = world({ status: conditions(cond(key, { clear_runs: need })) })
    assert.deepEqual((await go(ctx, enough)).counts, { closed_confirmed: 1, [reason]: 1 })
    assert.equal((await byKey(ctx, key)).close_reason, reason)
    await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  }
}))

test("a reading that is not there decides nothing, advances no deadline and is stamped once a day", () => scratch(async (ctx) => {
  const key = await make(ctx, "evaluator", "expired_requests", "verifying", { checks_run: 13 })
  const none = world({ status: {} })
  assert.deepEqual((await go(ctx, none)).counts, { unreadable: 1 })
  let card = await byKey(ctx, key)
  assert.equal(card.state, "verifying")
  assert.equal(card.checks_run, 13)
  assert.equal(card.last_check_at, NOW.toISOString())
  assert.equal(card.last_check_result, "waiting")
  assert.deepEqual(await go(ctx, none), { ok: true, result: "nothing_to_verify", counts: {} })
  // an unreadable status leaves an open recovered card alone
  await open(ctx, "andon", ANDON)
  const out = await go(ctx, world({ status: conditions(cond(`andon:${ANDON}`)) }), { readStatusImpl: async () => { throw new Error("unreadable") } })
  assert.deepEqual(out.counts, {})
}))

test("a reading older than MAX_READING_AGE_HOURS is unavailable: a collector that stopped never reads as recovery", () => scratch(async (ctx) => {
  assert.equal(MAX_READING_AGE_HOURS, 72)
  const stale = new Date(NOW.getTime() - 73 * 3600 * 1000).toISOString()
  const fresh = new Date(NOW.getTime() - 71 * 3600 * 1000).toISOString()
  await make(ctx, "andon", ANDON, "open")
  await make(ctx, "evaluator", "expired_requests", "shipped")
  const old = world({ found: { state: "not_released_yet" }, status: conditions(cond(`andon:${ANDON}`, { observed_at: stale, counted_at: stale }), cond("evaluator:expired_requests", { clear_runs: 5, observed_at: stale, counted_at: stale })) })
  assert.deepEqual((await go(ctx, old)).counts, { waiting: 1 })
  assert.equal((await byKey(ctx, cardKey("andon", ANDON))).state, "open")
  const recent = world({ status: conditions(cond(`andon:${ANDON}`, { observed_at: fresh, counted_at: fresh })) })
  assert.deepEqual((await go(ctx, recent)).counts, { closed_unverified: 1, source_recovered: 1 })
}))

test("a reconcile summary older than MAX_READING_AGE_HOURS reads as no data", () => scratch(async (ctx) => {
  const key = await make(ctx, "reconcile_class", REASON, "verifying", { checks_run: 3 })
  const old = new Date(NOW.getTime() - 80 * 3600 * 1000).toISOString()
  assert.deepEqual((await go(ctx, world({ status: { reconcile: { at: old, runs: { [REASON]: { consecutive: 0, count: 0, clear: 5 } } } } }))).counts, { unreadable: 1 })
  assert.equal((await byKey(ctx, key)).state, "verifying")
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ status: { reconcile: { runs: { [REASON]: { consecutive: 0, count: 0, clear: 5 } } } } }))).counts, { unreadable: 1 })
}))

test("reconcile class: closed after two clear runs, reopened when still present after 3 runs, no data decides nothing", () => scratch(async (ctx) => {
  const key = cardKey("reconcile_class", REASON)
  const runs = (over) => ({ reconcile: { at: NOW.toISOString(), runs: { [REASON]: { consecutive: 0, count: 0, clear: 0, ...over } } } })
  await make(ctx, "reconcile_class", REASON, "verifying", { checks_run: 0 })
  assert.deepEqual((await go(ctx, world({ status: {} }))).counts, { unreadable: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 0)
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ status: runs({ clear: 1 }) }))).counts, { waiting: 1 })
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ status: runs({ consecutive: 3, count: 4 }) }))).counts, { waiting: 1 })
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ status: runs({ consecutive: 3, count: 4 }) }))).counts, { reopened: 1, still_recurring: 1 })
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  await make(ctx, "reconcile_class", REASON, "shipped")
  assert.deepEqual((await go(ctx, world({ status: runs({ clear: 2 }) }))).counts, { closed_confirmed: 1, reconcile_zero_twice: 1 })
  assert.equal((await byKey(ctx, key)).close_reason, "reconcile_zero_twice")
}))

test("reading is a pure reader of the conditions and reconcile records", () => {
  const card = (source, id) => ({ source, key: cardKey(source, id) })
  const at = NOW.toISOString()
  assert.deepEqual(reading({}, card("friction_candidate", FR), NOW), { kind: "none" })
  assert.deepEqual(reading(null, card("andon", ANDON), NOW), { kind: "unavailable" })
  assert.deepEqual(reading(conditions(cond(`andon:${ANDON}`, { clear_runs: 0 })), card("andon", ANDON), NOW), { kind: "clearing" })
  assert.deepEqual(reading({ reconcile: { at, runs: { [REASON]: "x" } } }, card("reconcile_class", REASON), NOW), { kind: "unavailable" })
  assert.deepEqual(reading({ reconcile: { at, runs: [] } }, card("reconcile_class", REASON), NOW), { kind: "unavailable" })
  assert.deepEqual(reading({ reconcile: { at, runs: { [REASON]: { consecutive: 1, count: 1, clear: 0 } } } }, card("reconcile_class", REASON), NOW), { kind: "clearing" })
  assert.deepEqual(reading({ reconcile: { at: "nonsense", runs: { [REASON]: { consecutive: 1, count: 1, clear: 0 } } } }, card("reconcile_class", REASON), NOW), { kind: "unavailable" })
})

test("desk problem: confirmed 7 days after it entered verification with no known hit, unverified when the record cannot say, reopened by a hit", () => scratch(async (ctx) => {
  const key = cardKey("desk_problem", DESK_PROBLEM)
  const known = { desk_problem_known_since: "2026-09-01T00:00:00.000Z", desk_problem_known: {} }
  const closed = conditions(cond(key))
  const since = (days) => new Date(NOW.getTime() - days * DAY).toISOString()
  assert.equal(DESK_PROBLEM_QUIET_DAYS, 7)
  const fresh = async (fields) => {
    await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key), { force: true })
    await make(ctx, "desk_problem", DESK_PROBLEM, "verifying", { verifying_since: since(7), ...fields })
  }
  await fresh()
  assert.deepEqual((await go(ctx, world({ status: { ...closed, ...known } }))).counts, { closed_confirmed: 1, desk_problem_quiet: 1 })
  assert.equal((await byKey(ctx, key)).close_reason, "desk_problem_quiet")

  await fresh()
  assert.deepEqual((await go(ctx, world({ status: { ...closed } }))).counts, { closed_unverified: 1, desk_problem_quiet: 1 })

  await fresh()
  const hit = { ...known, desk_problem_known: { 12: { count: 1, last_at: "2026-10-04T00:00:00.000Z", last_version: "3.2.1" } } }
  assert.deepEqual((await go(ctx, world({ status: { ...closed, ...hit } }))).counts, { reopened: 1, still_recurring: 1 })

  // a hit at an older version is not a recurrence
  await fresh()
  const older = { ...known, desk_problem_known: { 12: { count: 1, last_at: "2026-10-04T00:00:00.000Z", last_version: "3.1.0" } } }
  assert.deepEqual((await go(ctx, world({ status: { ...closed, ...older } }))).counts, { closed_confirmed: 1, desk_problem_quiet: 1 })

  // one day short of 7 days it waits
  await fresh({ verifying_since: since(6.9) })
  assert.deepEqual((await go(ctx, world({ status: { ...closed, ...known } }))).counts, { waiting: 1 })

  // an issue that is open again reopens after a few checks; before that it waits
  const present = { ...known, ...conditions(cond(key, { present: true, clear_runs: 0 })) }
  await fresh({ checks_run: 1 })
  assert.deepEqual((await go(ctx, world({ status: present }))).counts, { waiting: 1 })
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ status: present }))).counts, { reopened: 1, still_recurring: 1 })

  // no reading of the issue decides nothing and advances nothing
  await fresh({ checks_run: 5 })
  assert.deepEqual((await go(ctx, world({ status: known }))).counts, { unreadable: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 5)
}))

test("a desk problem that waited for its release, then got a version, is not closed before 7 days from the version", () => scratch(async (ctx) => {
  const key = cardKey("desk_problem", DESK_PROBLEM)
  const status = { ...conditions(cond(key)), desk_problem_known_since: "2026-09-01T00:00:00.000Z", desk_problem_known: {} }
  await make(ctx, "desk_problem", DESK_PROBLEM, "shipped")
  const waitingForRelease = world({ status, found: { state: "not_released_yet" } })
  for (let day = 0; day < 6; day += 1) await go(ctx, waitingForRelease, { now: new Date(NOW.getTime() + day * DAY) })
  assert.equal((await byKey(ctx, key)).checks_run, 6)
  const released = world({ status })
  const versionDay = new Date(NOW.getTime() + 6 * DAY)
  assert.deepEqual((await go(ctx, released, { now: versionDay })).counts, { version_set: 1 })
  const entered = await byKey(ctx, key)
  assert.equal(entered.verifying_since, versionDay.toISOString())
  assert.equal(entered.checks_run, 0)
  for (let day = 1; day < 7; day += 1) {
    const out = await go(ctx, released, { now: new Date(versionDay.getTime() + day * DAY), readStatusImpl: async () => ({ ...status, ...conditions(cond(key, { observed_at: new Date(versionDay.getTime() + day * DAY).toISOString() })) }) })
    assert.deepEqual(out.counts, { waiting: 1 }, `day ${day}`)
  }
  assert.equal((await byKey(ctx, key)).state, "verifying")
  const last = new Date(versionDay.getTime() + 7 * DAY)
  const out = await go(ctx, released, { now: last, readStatusImpl: async () => ({ ...status, ...conditions(cond(key, { observed_at: last.toISOString() })) }) })
  assert.deepEqual(out.counts, { closed_confirmed: 1, desk_problem_quiet: 1 })
}))

test("a desk problem card is armed for known-hit recording when it enters verification; an arm failure is counted", () => scratch(async (ctx) => {
  const key = await make(ctx, "desk_problem", DESK_PROBLEM, "shipped")
  const w = world()
  assert.deepEqual((await go(ctx, w)).counts, { version_set: 1 })
  assert.equal(w.armCalls, 1)
  assert.equal(typeof w.armedAt, "number", "the arm step is given a clock")
  assert.equal((await byKey(ctx, key)).state, "verifying")
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  await make(ctx, "desk_problem", DESK_PROBLEM, "shipped")
  const failing = world({ arm: { armed: false, code: "status_write_failed" } })
  assert.deepEqual((await go(ctx, failing)).counts, { version_set: 1, known_hits_not_armed: 1 })
  // an open desk problem card whose issue closed is recovered
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  await make(ctx, "desk_problem", DESK_PROBLEM, "open")
  assert.deepEqual((await go(ctx, world({ status: conditions(cond(key)) }))).counts, { closed_unverified: 1, source_recovered: 1 })
}))

test("a friction note with no measure closes unverified once its fix is merged green, and waits otherwise", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped")
  const wait = world({ mergedState: "not_merged" })
  assert.deepEqual((await go(ctx, wait)).counts, { countermeasure_not_merged: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 1)
  assert.equal(wait.shippedCalls.length, 0)
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ mergedState: "unavailable" }))).counts, { unreadable: 1 })
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ mergedState: "merged_not_green" }))).counts, { checks_not_green: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 1)
  await edit(ctx, key, { last_check_at: null })
  const out = await go(ctx, world())
  assert.deepEqual(out.counts, { closed_unverified: 1, merged_without_signal: 1 })
  assert.equal((await byKey(ctx, key)).close_reason, "merged_without_signal")
}))

test("a plugin with no release mapping takes the no-measure path and counts as closed unverified", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped", mirrored)
  const w = world({ found: { state: "unavailable", reason: "plugin_unmapped" }, issues: { 11: { body: BODY(), labels: [] } } })
  const out = await go(ctx, w)
  assert.deepEqual(out.counts, { closed_unverified: 1, version_unavailable: 1 })
  assert.equal((await byKey(ctx, key)).close_reason, "version_unavailable")
  assert.deepEqual(w.comments, [[11, UNVERIFIED_COMMENT]])
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  // not merged yet: waits
  await make(ctx, "friction_candidate", FR, "shipped", mirrored)
  const unmerged = world({ found: { state: "unavailable", reason: "countermeasure_unparsed" }, mergedState: "not_merged", issues: { 11: { body: BODY(), labels: [] } } })
  assert.deepEqual((await go(ctx, unmerged)).counts, { countermeasure_not_merged: 1 })
  // a source with its own recovery signal keeps waiting for it
  await make(ctx, "andon", ANDON, "shipped")
  const andon = world({ found: { state: "unavailable", reason: "plugin_unmapped" } })
  assert.deepEqual((await go(ctx, andon)).counts, { waiting: 1 })
}))

test("a release lookup that failed decides nothing and advances nothing; one that found nothing yet is a measured waiting check", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped", mirrored)
  const issues = { 11: { body: BODY(), labels: [] } }
  assert.deepEqual((await go(ctx, world({ issues, found: { state: "unavailable", reason: "http_500" } }))).counts, { unreadable: 1 })
  assert.equal((await byKey(ctx, key)).last_check_result, "version_unavailable")
  assert.equal((await byKey(ctx, key)).checks_run, 0)
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ issues, found: { state: "not_released_yet" } }))).counts, { waiting: 1 })
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ issues, found: { state: "not_merged" } }))).counts, { countermeasure_not_merged: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 2)
  await edit(ctx, key, { last_check_at: null })
  // a version string that is not safe to write to the issue is not written
  assert.deepEqual((await go(ctx, world({ issues, found: { state: "version", version: "not a version\nx" } }))).counts, { unreadable: 1 })
  assert.equal((await byKey(ctx, key)).state, "shipped")
  // an issue body without the block, or an issue that cannot be read, decides nothing
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ issues: { 11: { body: "no block", labels: [] } } }))).counts, { issue_failed: 1, unreadable: 1 })
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ issues: {} }))).counts, { issue_failed: 1, unreadable: 1 })
  const card = await byKey(ctx, key)
  assert.equal(card.state, "shipped")
  assert.equal(card.checks_run, 2)
}))

test("a verdict that cannot be read decides nothing and advances nothing; a closing that the store refuses leaves the card alone", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  assert.deepEqual((await go(ctx, world({ issues: {} }))).counts, { issue_failed: 1, unreadable: 1 })
  assert.deepEqual((await go(ctx, world({ issues: { 11: { body: "no block", labels: [] } } }), { now: new Date(NOW.getTime() + DAY) })).counts, { issue_failed: 1, unreadable: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 0)
  const refusing = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["confirmed"] } }, failClose: true })
  assert.deepEqual((await go(ctx, refusing, { now: new Date(NOW.getTime() + 2 * DAY) })).counts, { issue_failed: 1 })
  assert.equal((await byKey(ctx, key)).state, "verifying")
  assert.deepEqual(refusing.comments, [])
  // the issue reset after a reopen is best effort
  const reset = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["not-confirmed"] } } })
  const original = reset.access
  reset.access = async (...args) => {
    const granted = await original(...args)
    const reader = { get: async (route) => { if (reset.gets.length > 0) throw new Error("gone"); return granted.reader.get(route) } }
    return { ...granted, reader }
  }
  assert.deepEqual((await go(ctx, reset, { now: new Date(NOW.getTime() + 3 * DAY) })).counts, { reopened: 1, not_confirmed: 1, issue_failed: 1 })
}))

test("closing a mirror issue closes it first and comments after, so a retry never posts a second comment", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["confirmed"] } }, failClose: true })
  await go(ctx, w)
  assert.deepEqual(w.comments, [])
  assert.equal((await byKey(ctx, key)).state, "verifying")
  const retry = world({ issues: w.issues })
  await go(ctx, retry, { now: new Date(NOW.getTime() + DAY) })
  assert.deepEqual(retry.comments, [[11, CONFIRMED_COMMENT]])
  // the card write failed after the issue closed: the retry finds a closed issue and comments no more
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const third = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["confirmed"] } } })
  await go(ctx, third, { writeCardCommitted: async () => { throw new Error("git") } })
  assert.equal(third.comments.length, 1)
  await go(ctx, third, { now: new Date(NOW.getTime() + DAY) })
  assert.equal(third.comments.length, 1)
  assert.equal((await byKey(ctx, key)).state, "closed_confirmed")
}))

test("a comment that cannot be posted after the issue closed is counted and does not stop the close", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["confirmed"] } }, failComment: true })
  assert.deepEqual((await go(ctx, w)).counts, { comment_failed: 1, closed_confirmed: 1, confirmed: 1 })
  assert.equal((await byKey(ctx, key)).state, "closed_confirmed")
}))

test("a reopen leaves an issue body it does not recognise alone", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", { ...mirrored, checks_run: 13 })
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: [] } }, mergedState: "not_merged" })
  const original = w.access
  w.access = async (...args) => {
    const granted = await original(...args)
    let reads = 0
    const reader = { get: async (route) => { reads += 1; const issue = await granted.reader.get(route); return reads > 1 ? { ...issue, body: "no block" } : issue } }
    return { ...granted, reader }
  }
  assert.deepEqual((await go(ctx, w)).counts, { reopened: 1, countermeasure_not_merged: 1 })
  assert.equal((await byKey(ctx, key)).state, "open")
  assert.deepEqual(w.writes, [])
}))

test("a version already on the mirror issue is not written again", () => scratch(async (ctx) => {
  await make(ctx, "friction_candidate", FR, "shipped", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: [] } } })
  assert.deepEqual((await go(ctx, w)).counts, { version_set: 1 })
  assert.deepEqual(w.writes, [])
}))

test("a verifying card whose mirror issue is not made yet waits", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", { signal: SIGNAL })
  assert.deepEqual((await go(ctx, world())).counts, { waiting: 1 })
  assert.equal((await byKey(ctx, key)).checks_run, 1)
}))

test("gh missing or a failed sign-in stops the run and changes no card", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped", mirrored)
  for (const code of ["gh_missing", "auth_failed", "route_unknown"]) {
    const w = world()
    const out = await go(ctx, w, { access: async () => ({ ok: false, code }) })
    assert.deepEqual(out, { ok: false, result: code, counts: {} })
    assert.equal(recorded.at(-1).result, code)
    assert.equal(recorded.at(-1).ok, false)
  }
  const thrown = await go(ctx, world(), { access: async () => { throw new Error("boom") } })
  assert.deepEqual(thrown, { ok: false, result: "unexpected_error", counts: {} })
  const card = await byKey(ctx, key)
  assert.equal(card.state, "shipped")
  assert.equal(card.checks_run, 0)
  assert.equal(card.last_check_at, null)
}))

test("a headless session runs nothing and records nothing", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped")
  const before = recorded.length
  const out = await go({ ...ctx, env: { ...ctx.env, DESK_FACTORY_HEADLESS: "1" } }, world())
  assert.deepEqual(out, { ok: false, result: "headless_session", counts: {} })
  assert.equal(recorded.length, before)
  assert.equal((await byKey(ctx, key)).state, "shipped")
}))

test("the card folder being unreadable is a failed run, and bad arguments throw", () => scratch(async (ctx) => {
  const w = world()
  assert.deepEqual(await go(ctx, w, { readCardsImpl: async () => ({ unreadable: true, cards: [] }) }), { ok: false, result: "cards_unreadable", counts: {} })
  assert.deepEqual(await go(ctx, w, { readCardsImpl: async () => { throw new Error("x") } }), { ok: false, result: "cards_unreadable", counts: {} })
  await assert.rejects(runVerifyStep(ctx.env, { deskRoot: "relative" }), TypeError)
  await assert.rejects(runVerifyStep(ctx.env, { deskRoot: ctx.deskRoot, now: "not a time" }), TypeError)
  const throwing = await go(ctx, w, { recordStepImpl: async () => { throw new Error("bookkeeping") } })
  assert.deepEqual(throwing, { ok: true, result: "nothing_to_verify", counts: {} })
}))

test("a card write that fails or is refused is counted and the card is tried again next time", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped")
  const refused = await go(ctx, world(), { writeCardCommitted: async () => ({ result: { result: "invalid_move" }, commit: "committed" }) })
  assert.deepEqual(refused.counts, { card_write_failed: 1 })
  const thrown = await go(ctx, world(), { writeCardCommitted: async () => { throw new Error("git") } })
  assert.deepEqual(thrown.counts, { card_write_failed: 1 })
  assert.equal((await byKey(ctx, key)).state, "shipped")
  // an unexpected error inside one card does not stop the run
  const odd = await go(ctx, world(), { merged: async () => { throw new Error("boom") } })
  assert.deepEqual(odd.counts, { unexpected_error: 1 })
  // a close whose card write fails after the issue closed is retried
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const w = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: ["confirmed"] } } })
  assert.deepEqual((await go(ctx, w, { writeCardCommitted: async () => { throw new Error("git") } })).counts, { card_write_failed: 1 })
  assert.equal(w.issues[11].state, "closed")
}))

test("at most MAX_CHECKS_PER_RUN cards are checked a run, the longest unchecked first, so none is starved", () => scratch(async (ctx) => {
  const total = MAX_CHECKS_PER_RUN + 2
  const keys = []
  for (let n = 0; n < total; n += 1) {
    const id = n.toString(16).padStart(32, "0")
    keys.push(await make(ctx, "friction_candidate", id, "shipped"))
  }
  const w = world({ mergedState: "not_merged" })
  const first = await go(ctx, w)
  assert.deepEqual(first.counts, { countermeasure_not_merged: MAX_CHECKS_PER_RUN, deferred: 2 })
  const checked = (await cards(ctx)).filter((card) => card.last_check_at !== null).length
  assert.equal(checked, MAX_CHECKS_PER_RUN)
  const second = await go(ctx, w, { now: new Date(NOW.getTime() + 3600 * 1000) })
  assert.deepEqual(second.counts, { countermeasure_not_merged: 2 })
  assert.equal((await cards(ctx)).filter((card) => card.last_check_at !== null).length, total)
  assert.deepEqual((await go(ctx, w, { now: new Date(NOW.getTime() + 7200 * 1000) })).counts, {})
}))

test("recovered open cards beyond the cap are deferred", () => scratch(async (ctx) => {
  const total = MAX_CHECKS_PER_RUN + 1
  for (let n = 0; n < total; n += 1) await open(ctx, "store_build", `ourostack/factory#${n + 1}`)
  const all = Object.assign({}, ...Array.from({ length: total }, (_, n) => cond(`store_build:ourostack/factory#${n + 1}`)))
  const out = await go(ctx, world({ status: { loop: { conditions: all } } }))
  assert.deepEqual(out.counts, { closed_unverified: MAX_CHECKS_PER_RUN, source_recovered: MAX_CHECKS_PER_RUN, deferred: 1 })
}))

test("the run is recorded through recordStep", () => scratch(async (ctx) => {
  await make(ctx, "friction_candidate", FR, "shipped")
  const out = await go(ctx, world(), { recordStepImpl: undefined })
  assert.equal(out.result, "verified")
  const step = (await readStatus(ctx.env)).loop.steps.verify
  assert.equal(step.last_result, "verified")
  assert.equal(step.runs, 1)
}))

test("withFields sets exactly one countermeasure line and one version line, or refuses", () => {
  assert.equal(withFields(BODY(), PR, "3.2.0"), BODY(PR, "3.2.0"))
  assert.equal(withFields(BODY(PR, "3.2.0"), null, null), BODY())
  assert.equal(withFields("nothing", PR, "1.0.0"), null)
  assert.equal(withFields(`${BODY()}version: 2\n`, PR, "1.0.0"), null)
  assert.equal(withFields(`${BODY()}countermeasure: x\n`, PR, "1.0.0"), null)
})

test("githubAccess reads the desk's store, the consenting account and its token the way the kaizen filer does", () => scratch(async (ctx) => {
  const answered = []
  const runner = (auth) => async (args, options = {}) => { answered.push({ args, token: options.token }); return auth }
  const good = runner({ code: 0, stdout: "ghs_TOKEN\n", stderr: "" })
  assert.deepEqual(await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: good }), { ok: false, code: "route_unknown" })
  writeFileSync(path.join(ctx.deskRoot, "_meta", "factory.json"), "{ not json")
  assert.deepEqual(await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: good }), { ok: false, code: "store_invalid" })
  writeFileSync(path.join(ctx.deskRoot, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store: "ourostack/factory" }))
  assert.deepEqual(await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: good }), { ok: false, code: "not_opted_in" })
  await setConsent(ctx.env, { store: "ourostack/factory", contribute: true })
  assert.deepEqual(await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: good }), { ok: false, code: "no_account" })
  await setConsent(ctx.env, { store: "ourostack/factory", contribute: true, account: "contributor" })
  assert.deepEqual(await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: runner({ spawnError: "ENOENT" }) }), { ok: false, code: "gh_missing" })
  assert.deepEqual(await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: runner({ code: 1, stdout: "", stderr: "" }) }), { ok: false, code: "auth_failed" })
  assert.deepEqual(await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: runner({ code: 0, stdout: "", stderr: "" }) }), { ok: false, code: "auth_failed" })
  const granted = await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: good })
  assert.equal(granted.ok, true)
  assert.equal(typeof granted.issues("ourostack/factory").updateIssue, "function")
  answered.length = 0
  const rows = [{ number: 1 }]
  const reader = (await githubAccess(ctx.env, { deskRoot: ctx.deskRoot, runner: async (args, options = {}) => { answered.push({ args, token: options.token }); return args[0] === "auth" ? { code: 0, stdout: "ghs_TOKEN\n", stderr: "" } : { code: 0, stdout: JSON.stringify(rows), stderr: "" } } })).reader
  assert.deepEqual(await reader.get("repos/ourostack/factory/issues/1"), rows)
  assert.equal(answered.at(-1).token, "ghs_TOKEN")
  assert.deepEqual(answered[0].args, ["auth", "token", "--user", "contributor"])
}))

test("a shipped card of a source with a recovery signal and a mirror issue still gets its version from the release", () => scratch(async (ctx) => {
  const key = await make(ctx, "andon", ANDON, "shipped", mirrored)
  const w = world({ issues: { 11: { body: BODY(), labels: [] } }, status: conditions(cond(`andon:${ANDON}`)) })
  assert.deepEqual((await go(ctx, w)).counts, { version_set: 1 })
  assert.equal((await byKey(ctx, key)).shipped_version, "3.2.0")
}))

test("label objects from the store are read by name, and a malformed issue answer decides nothing", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const objects = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: [{ name: "confirmed" }] } } })
  assert.deepEqual((await go(ctx, objects)).counts, { closed_confirmed: 1, confirmed: 1 })
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, key))
  await make(ctx, "friction_candidate", FR, "verifying", mirrored)
  const bad = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: "none" } } })
  assert.deepEqual((await go(ctx, bad)).counts, { issue_failed: 1, unreadable: 1 })
}))

test("a refused card write on a reopen or a version change is counted and changes no count of success", () => scratch(async (ctx) => {
  const refuse = async () => ({ result: { result: "invalid_move" }, commit: "committed" })
  await make(ctx, "friction_candidate", FR, "verifying", { ...mirrored, checks_run: 13 })
  const reopen = world({ issues: { 11: { body: BODY(PR, "3.2.0"), labels: [] } }, mergedState: "not_merged" })
  assert.deepEqual((await go(ctx, reopen, { writeCardCommitted: refuse })).counts, { card_write_failed: 1 })
  await fs.rm(cardFile(ctx.deskRoot, ctx.personPrefix, cardKey("friction_candidate", FR)))
  await make(ctx, "friction_candidate", FR, "shipped", mirrored)
  assert.deepEqual((await go(ctx, world({ issues: { 11: { body: BODY(), labels: [] } } }), { writeCardCommitted: refuse })).counts, { card_write_failed: 1 })
}))

test("at the 14th shipped check with no release yet, the merge state is read and only a read state decides", () => scratch(async (ctx) => {
  const key = await make(ctx, "friction_candidate", FR, "shipped", { ...mirrored, checks_run: 13 })
  const issues = { 11: { body: BODY(), labels: [] } }
  const early = await make(ctx, "friction_candidate", FR2, "shipped", { ...mirrored, checks_run: 5 })
  const w = world({ issues, found: { state: "not_released_yet" }, mergedState: "unavailable" })
  assert.deepEqual((await go(ctx, w)).counts, { unreadable: 1, waiting: 1 })
  assert.equal(w.mergedCalls.length, 1)
  assert.equal((await byKey(ctx, early)).checks_run, 6)
  assert.equal((await byKey(ctx, key)).state, "shipped")
  assert.equal((await byKey(ctx, key)).checks_run, 13)
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ issues, found: { state: "not_released_yet" }, mergedState: "merged_not_green" }))).counts, { checks_not_green: 1 })
  assert.equal((await byKey(ctx, key)).state, "shipped")
  await edit(ctx, key, { last_check_at: null })
  assert.deepEqual((await go(ctx, world({ issues, found: { state: "not_released_yet" }, mergedState: "merged_green" }))).counts, { closed_unverified: 1, thin_data_after_14_checks: 1 })
  assert.equal((await byKey(ctx, key)).close_reason, "thin_data_after_14_checks")
}))
