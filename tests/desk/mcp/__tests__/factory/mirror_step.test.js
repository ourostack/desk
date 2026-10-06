// The loop's mirror step: an open or claimed card that names a measure gets its public store issue by itself.
// Every test uses a throwaway desk and state folder, the real card library, a fake filer and a fake commit
// function; nothing touches Git, GitHub, a real desk or the real factory state.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import { claimNext, openImprovement, readCards, updateCard, cardKey, SOURCES, LOOP_ALARMS, EVALUATOR_NAMES, FLUSH_HEALTH_CODES, RECONCILE_REASONS, MEASURE_IDS } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { FRICTION_CLASSES } from "../../../../../plugins/desk/mcp/src/factory/kaizen-file.js"
import { readStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { frictionClassOf, runMirrorStep } from "../../../../../plugins/desk/mcp/src/factory/mirror-step.js"

const NOW = new Date("2026-10-05T12:00:00Z")
const JOB = "0123456789abcdef0123456789abcdef"
const JOB2 = "fedcba9876543210fedcba9876543210"
const FP = "0123456789abcdef"
const SIGNAL = MEASURE_IDS[0]
const URL1 = "https://github.com/ourostack/factory/issues/11"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-mirror-step-")))
  const deskRoot = path.join(base, "desk")
  await fs.mkdir(deskRoot, { recursive: true })
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  try {
    return await run({ env, deskRoot, personPrefix: "" })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const open = (ctx, source, id, extra = {}) => openImprovement({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, key: cardKey(source, id), source, now: NOW, evidence: [], plugin: "desk", signal: null, ...extra })
const cards = async (ctx) => (await readCards({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix })).cards
const byKey = async (ctx, key) => (await cards(ctx)).find((card) => card.key === key)

// A commit seam that runs the write and reports what the real one reports; no Git.
const commits = []
const commit = async ({ write, message }) => {
  const written = await write()
  const { file, ...rest } = written
  const result = typeof file === "string" ? { ...rest, file_name: path.basename(file) } : rest
  commits.push(typeof message === "function" ? message(result) : message)
  return { result, commit: "committed", left_alone: 0 }
}

function filer(answers) {
  const calls = []
  const fileCard = async (env, input) => {
    calls.push(input)
    const next = typeof answers === "function" ? answers(input, calls.length) : answers
    if (next instanceof Error) throw next
    return next
  }
  return { fileCard, calls }
}
const filed = { result: "filed", store: "ourostack/factory", url: URL1, visibility: "public" }
const run = (ctx, seams = {}) => runMirrorStep(ctx.env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: NOW, writeCardCommitted: commit, ...seams })
const stepRecord = async (env) => (await readStatus(env)).loop?.steps?.mirror

test("a card with a signal gets its kaizen_url after filed; a second run files nothing", () => scratch(async (ctx) => {
  const reason = RECONCILE_REASONS[0]
  await open(ctx, "reconcile_class", reason, { signal: SIGNAL, evidence: [`job:${JOB}`, `reconcile:${reason}@3`] })
  const first = filer(filed)
  const one = await run(ctx, { fileCard: first.fileCard })
  assert.deepEqual(one, { ok: true, result: "mirrored", mirrored: [cardKey("reconcile_class", reason)], counts: { filed: 1 } })
  assert.equal((await byKey(ctx, cardKey("reconcile_class", reason))).kaizen_url, URL1)
  assert.equal(commits.at(-1), `improvement: mirror ${path.basename((await fs.readdir(path.join(ctx.deskRoot, "_meta", "improvement")))[0])}`)
  const second = filer(filed)
  assert.deepEqual(await run(ctx, { fileCard: second.fileCard }), { ok: true, result: "nothing_to_mirror", mirrored: [], counts: {} })
  assert.equal(second.calls.length, 0)
  assert.equal((await stepRecord(ctx.env)).runs, 2)
  assert.equal((await stepRecord(ctx.env)).last_result, "nothing_to_mirror")
}))

test("the filer gets the card's title, plugin, signal, class and job evidence only", () => scratch(async (ctx) => {
  const reason = RECONCILE_REASONS[0]
  await open(ctx, "reconcile_class", reason, { signal: SIGNAL, plugin: "desk", evidence: [`job:${JOB}`, `reconcile:${reason}@3`, `fingerprint:${FP}`, `job:${JOB2}`] })
  const f = filer(filed)
  await run(ctx, { fileCard: f.fileCard })
  assert.equal(f.calls.length, 1)
  const call = f.calls[0]
  assert.deepEqual(Object.keys(call).sort(), ["body", "deskRoot", "evidenceJobs", "frictionClass", "plugin", "signal", "title"])
  assert.equal(call.title, `Reconcile mismatch: ${reason}`)
  assert.equal(call.plugin, "desk")
  assert.equal(call.signal, SIGNAL)
  assert.equal(call.frictionClass, "factory")
  assert.deepEqual(call.evidenceJobs, [JOB, JOB2])
  assert.equal(call.deskRoot, ctx.deskRoot)
  assert.doesNotMatch(call.body, /[\\/]|```/u)
}))

test("a card without a signal, and a card past the open and claimed states, is skipped", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0])
  await open(ctx, "reconcile_class", RECONCILE_REASONS[1], { signal: SIGNAL })
  const all = await cards(ctx)
  const base = all.find((card) => card.signal === null)
  const shipped = { ...base, key: "reconcile_class:x", state: "shipped", signal: SIGNAL }
  const closed = { ...base, key: "reconcile_class:y", state: "closed_unverified", signal: SIGNAL }
  const withUrl = { ...base, key: "reconcile_class:z", signal: SIGNAL, kaizen_url: URL1 }
  const f = filer(filed)
  const out = await run(ctx, { fileCard: f.fileCard, readCardsImpl: async () => ({ unreadable: false, cards: [base, shipped, closed, withUrl] }) })
  assert.equal(f.calls.length, 0)
  assert.deepEqual(out, { ok: true, result: "nothing_to_mirror", mirrored: [], counts: { no_signal: 1 } })
}))

test("a claimed card is mirrored, and a duplicate answer stores the existing URL", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  const claim = await claimNext({ env: ctx.env, deskRoot: ctx.deskRoot, personPrefix: "", now: NOW })
  assert.equal(claim.result, "claimed")
  assert.equal((await cards(ctx))[0].state, "claimed")
  const f = filer({ result: "duplicate", store: "ourostack/factory", url: URL1, visibility: "public" })
  const out = await run(ctx, { fileCard: f.fileCard })
  assert.deepEqual(out.counts, { duplicate: 1 })
  assert.equal(out.result, "mirrored")
}))

test("held_cap leaves the card unmirrored, the result counts it, and the next run retries", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  const held = filer({ result: "held_cap", store: "ourostack/factory" })
  const one = await run(ctx, { fileCard: held.fileCard })
  assert.deepEqual(one, { ok: true, result: "all_held", mirrored: [], counts: { held_cap: 1 } })
  assert.equal((await byKey(ctx, cardKey("reconcile_class", RECONCILE_REASONS[0]))).kaizen_url, null)
  assert.equal((await stepRecord(ctx.env)).last_result, "all_held")
  const retry = filer(filed)
  const two = await run(ctx, { fileCard: retry.fileCard })
  assert.equal(two.result, "mirrored")
  assert.equal(retry.calls.length, 1)
}))

test("a store-level hold stops the run and counts every remaining card under that code", () => scratch(async (ctx) => {
  for (const reason of RECONCILE_REASONS.slice(0, 3)) await open(ctx, "reconcile_class", reason, { signal: SIGNAL })
  const f = filer((input, n) => (n === 1 ? filed : { result: "held_cap", store: "ourostack/factory" }))
  const out = await run(ctx, { fileCard: f.fileCard })
  assert.equal(f.calls.length, 2)
  assert.deepEqual(out.counts, { filed: 1, held_cap: 2 })
  assert.equal(out.result, "mirrored_some_held")
  assert.equal(out.mirrored.length, 1)
}))

for (const code of ["route_unknown", "not_opted_in", "store_invalid", "no_account"]) {
  test(`${code} holds every card without failing the step`, () => scratch(async (ctx) => {
    for (const reason of RECONCILE_REASONS.slice(0, 2)) await open(ctx, "reconcile_class", reason, { signal: SIGNAL })
    const f = filer({ result: code })
    const out = await run(ctx, { fileCard: f.fileCard })
    assert.equal(f.calls.length, 1)
    assert.deepEqual(out, { ok: true, result: "all_held", mirrored: [], counts: { [code]: 2 } })
  }))
}

test("plugin_not_public and evidence_jobs_local are counted per card and the run goes on", () => scratch(async (ctx) => {
  const [a, b, c] = RECONCILE_REASONS
  await open(ctx, "reconcile_class", a, { signal: SIGNAL })
  await open(ctx, "reconcile_class", b, { signal: SIGNAL })
  await open(ctx, "reconcile_class", c, { signal: SIGNAL })
  const answers = ["plugin_not_public", "evidence_jobs_local"]
  const f = filer((input, n) => (n <= 2 ? { result: answers[n - 1], store: "ourostack/factory" } : filed))
  const out = await run(ctx, { fileCard: f.fileCard })
  assert.equal(f.calls.length, 3)
  assert.deepEqual(out.counts, { plugin_not_public: 1, evidence_jobs_local: 1, filed: 1 })
  assert.equal(out.result, "mirrored_some_held")
  assert.equal((await cards(ctx)).filter((card) => card.kaizen_url === null).length, 2)
}))

test("a delivery failure with nothing mirrored is ok false and keeps the card; the filer throwing is a code, not a throw", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  const down = await run(ctx, { fileCard: filer({ result: "http_503", store: "ourostack/factory" }).fileCard })
  assert.deepEqual(down, { ok: false, result: "delivery_failed", mirrored: [], counts: { http_503: 1 } })
  assert.equal((await stepRecord(ctx.env)).failures, 1)
  const boom = await run(ctx, { fileCard: filer(new Error("/Users/x/secret")).fileCard })
  assert.deepEqual(boom, { ok: false, result: "delivery_failed", mirrored: [], counts: { unexpected_error: 1 } })
  assert.doesNotMatch(JSON.stringify(boom), /Users/u)
}))

test("a filer code outside the closed shape is counted as unexpected_error", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  const out = await run(ctx, { fileCard: filer({ result: "Some Free Text /Users/x" }).fileCard })
  assert.deepEqual(out.counts, { unexpected_error: 1 })
  const none = await run(ctx, { fileCard: filer({}).fileCard })
  assert.deepEqual(none.counts, { unexpected_error: 1 })
}))

test("some mirrored and some delivery failures is mirrored_some_held and stays ok", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  await open(ctx, "reconcile_class", RECONCILE_REASONS[1], { signal: SIGNAL })
  const f = filer((input, n) => (n === 1 ? filed : { result: "timeout", store: "x" }))
  const out = await run(ctx, { fileCard: f.fileCard })
  assert.equal(out.ok, true)
  assert.equal(out.result, "mirrored_some_held")
  assert.deepEqual(out.counts, { filed: 1, timeout: 1 })
}))

test("a refused or throwing card write is card_write_failed and the issue is found again as a duplicate next run", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  const one = await run(ctx, { fileCard: filer({ ...filed, url: "not a url" }).fileCard })
  assert.deepEqual(one, { ok: false, result: "card_write_failed", mirrored: [], counts: { card_write_failed: 1 } })
  const throws = async () => { throw new Error("disk") }
  const two = await run(ctx, { fileCard: filer(filed).fileCard, writeCardCommitted: throws })
  assert.equal(two.result, "card_write_failed")
  assert.equal((await cards(ctx))[0].kaizen_url, null)
  const three = await run(ctx, { fileCard: filer({ result: "duplicate", store: "s", url: URL1 }).fileCard })
  assert.equal(three.result, "mirrored")
}))

test("an unreadable card folder is ok false cards_unreadable and the filer is never called", () => scratch(async (ctx) => {
  const f = filer(filed)
  const out = await run(ctx, { fileCard: f.fileCard, readCardsImpl: async () => ({ unreadable: true, cards: [] }) })
  assert.deepEqual(out, { ok: false, result: "cards_unreadable", mirrored: [], counts: {} })
  assert.equal(f.calls.length, 0)
  const thrown = await run(ctx, { fileCard: f.fileCard, readCardsImpl: async () => { throw new Error("x") } })
  assert.equal(thrown.result, "cards_unreadable")
}))

test("at most 20 filer attempts per run; the rest are deferred", () => scratch(async (ctx) => {
  const cardsIn = Array.from({ length: 22 }, (_, i) => ({ key: `reconcile_class:r${i}`, source: "reconcile_class", title: "t", evidence: [], state: "open", plugin: "desk", signal: SIGNAL, kaizen_url: null, opened_at: NOW.toISOString() }))
  const f = filer({ result: "plugin_not_public", store: "s" })
  const out = await run(ctx, { fileCard: f.fileCard, readCardsImpl: async () => ({ unreadable: false, cards: cardsIn }) })
  assert.equal(f.calls.length, 20)
  assert.deepEqual(out.counts, { plugin_not_public: 20, deferred: 2 })
}))

test("the friction class is always in FRICTION_CLASSES and follows the source", () => {
  const expected = { andon: "factory", evaluator: "factory", reconcile_class: "factory", flush_health: "hook" }
  for (const source of SOURCES) assert.equal(frictionClassOf(source), expected[source] ?? "other")
  for (const source of [...SOURCES, "unknown", undefined, 5]) assert.ok(FRICTION_CLASSES.includes(frictionClassOf(source)))
  assert.ok(LOOP_ALARMS.length > 0 && EVALUATOR_NAMES.length > 0 && FLUSH_HEALTH_CODES.length > 0)
})

test("a headless factory session runs nothing and writes nothing", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  const f = filer(filed)
  const out = await runMirrorStep({ ...ctx.env, DESK_FACTORY_HEADLESS: "1" }, { deskRoot: ctx.deskRoot, personPrefix: "", now: NOW, fileCard: f.fileCard, writeCardCommitted: commit })
  assert.deepEqual(out, { ok: false, result: "headless_session", mirrored: [], counts: {} })
  assert.equal(f.calls.length, 0)
  assert.equal(await stepRecord(ctx.env), undefined)
}))

test("bookkeeping failure never turns a finished run into a throw; bad arguments throw TypeError", () => scratch(async (ctx) => {
  await open(ctx, "reconcile_class", RECONCILE_REASONS[0], { signal: SIGNAL })
  const out = await run(ctx, { fileCard: filer(filed).fileCard, recordStepImpl: async () => { throw new Error("status") } })
  assert.equal(out.result, "mirrored")
  await assert.rejects(() => runMirrorStep(ctx.env, { deskRoot: "relative", personPrefix: "", now: NOW }), TypeError)
  await assert.rejects(() => runMirrorStep(ctx.env, { deskRoot: ctx.deskRoot, personPrefix: "", now: "nope" }), TypeError)
  const defaults = await runMirrorStep(ctx.env, { deskRoot: ctx.deskRoot, personPrefix: "", now: NOW.getTime(), writeCardCommitted: commit, fileCard: filer(filed).fileCard })
  assert.equal(defaults.result, "nothing_to_mirror")
}))
