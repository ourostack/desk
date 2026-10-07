// A delivered waste label whose session's facts no longer bind its job is withdrawn through the flush's ordinary retraction, and only then. Each case
// runs the real flush against the in-memory GitHub model in `_fake_github.js`, with synthetic fixtures only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { labelBinding, releaseReboundLabels, withdrawLabels } from "../../../../../plugins/desk/mcp/src/factory/label-binding.js"
import { factoryStateRoot, quarantine, readConsent, readDelivered, setConsent, writeLocalFacts, writeLocalLabels, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
const SLUG = "ourostack__factory"
const JOB = LABELS.job
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n, host = "claude-code") => `${host}-${sessionId(n)}.json`
const keyOf = (n) => `labels/${JOB}/${sessionId(n)}.json`

function localFacts(n, { binds = true } = {}) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  if (!binds) value.jobs = value.jobs.filter((binding) => binding.job !== JOB)
  return value
}

const run = (env, github) => flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })

async function deskFor(base, name) {
  const desk = path.join(base, name)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store: STORE }))
  return desk
}

async function marker(env, base, n, desk) {
  const log = path.join(base, `log-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString() })
}

// Sessions 1 and 2, each with facts and a label for the job, delivered and merged.
async function delivered(ctx) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  for (const n of [1, 2]) {
    await marker(ctx.env, ctx.base, n, await deskFor(ctx.base, `desk-${n}`))
    assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
    assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(n) })).written, true)
  }
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal((await run(ctx.env, github)).result, "nothing_pending")
  assert.deepEqual(Object.keys((await readDelivered(ctx.env, STORE)).blobs).filter((name) => name.startsWith("labels/")).sort(), [keyOf(1), keyOf(2)])
  return github
}

const root = (ctx) => factoryStateRoot(ctx.env)
const outboxFile = async (ctx, n) => path.join(await root(ctx), "outbox", SLUG, nameOf(n))
const labelFile = async (ctx, n) => path.join(await root(ctx), "labels", SLUG, JOB, `${sessionId(n)}.json`)
const quarantineFile = async (ctx, n) => path.join(await root(ctx), "quarantine", SLUG, keyOf(n))
const rewriteFacts = async (ctx, n, value) => fs.writeFile(await outboxFile(ctx, n), JSON.stringify(value))
const exists = (file) => fs.stat(file).then(() => true, () => false)
const mainFiles = (github) => [...github.mainFiles().keys()].sort()
// The labels the store holds; a desk not known private publishes them under a keyed job folder, so they are told apart by session.
const labelsOnMain = (github) => mainFiles(github).filter((file) => file.startsWith("labels/"))
const labelSessions = (github) => labelsOnMain(github).map((file) => path.basename(file, ".json")).sort()

test("a delivered label whose session's facts no longer bind its job is deleted, its facts stay, and the next flush withdraws it for good", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "1\n\nRetracted: 1 files (route_changed)")
  github.mergeOpenPr()
  assert.deepEqual(labelSessions(github), [sessionId(2)])
  assert.equal(mainFiles(github).includes(`facts/${nameOf(1)}`), true, "the session's facts stay")
  // The merge is seen by the next flush: the label is held back as job_unbound and no longer delivered; its local file stays.
  assert.equal((await run(ctx.env, github)).result, "nothing_pending")
  const state = await readDelivered(ctx.env, STORE)
  assert.equal(Object.hasOwn(state.blobs, keyOf(1)), false)
  assert.equal(state.quarantined.has(keyOf(1)), true)
  assert.equal(JSON.parse(await fs.readFile(await quarantineFile(ctx, 1), "utf8")).reason, "job_unbound")
  assert.equal(await exists(await labelFile(ctx, 1)), true)
  assert.equal(Object.hasOwn(state.retracting, keyOf(1)), false)
  assert.equal(Object.hasOwn(state.retracted, keyOf(1)), false)
  // Settled: nothing more to do, and no network call.
  const before = github.calls.length
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.calls.length, before)
}))

test("a label whose session still binds its job is never withdrawn", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  const before = github.calls.length
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.calls.length, before)
  assert.deepEqual(labelsOnMain(github).length, 2)
}))

test("an older Desk's delivery that recorded no path is still found and deleted, because the store holds exactly what this Desk would publish", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  const file = path.join(await root(ctx), "delivered-paths", `${SLUG}.json`)
  const paths = JSON.parse(await fs.readFile(file, "utf8"))
  delete paths[keyOf(1)]
  await fs.writeFile(file, JSON.stringify(paths))
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(labelSessions(github), [sessionId(2)])
}))

test("a label whose local copy changed since it was delivered is left alone, because the path cannot be proven", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  const file = path.join(await root(ctx), "delivered-paths", `${SLUG}.json`)
  const paths = JSON.parse(await fs.readFile(file, "utf8"))
  delete paths[keyOf(1)]
  await fs.writeFile(file, JSON.stringify(paths))
  const changed = { ...structuredClone(LABELS), session: sessionId(1) }
  changed.stretches = changed.stretches.slice(0, 1)
  await fs.writeFile(await labelFile(ctx, 1), JSON.stringify(changed))
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.deepEqual(labelSessions(github), [sessionId(1), sessionId(2)])
}))

test("unknown is not unbound: facts that are missing, unreadable, not a file or in a newer format never withdraw a label", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  const facts = await outboxFile(ctx, 1)
  const original = await fs.readFile(facts)
  for (const damage of [
    () => fs.rm(facts),
    () => fs.writeFile(facts, "{not json"),
    async () => { await fs.rm(facts, { force: true }); await fs.mkdir(facts) },
    async () => { await fs.rm(facts, { recursive: true, force: true }); await fs.writeFile(facts, JSON.stringify({ ...localFacts(1, { binds: false }), schema: "desk.factory.local/99" })) },
  ]) {
    await damage()
    assert.equal(await labelBinding(ctx.env, STORE, keyOf(1)), "unknown")
    const calls = github.calls.length
    await run(ctx.env, github)
    assert.equal(labelsOnMain(github).length, 2)
    assert.equal(github.calls.length >= calls, true)
    await fs.rm(facts, { recursive: true, force: true })
    await fs.writeFile(facts, original)
  }
  assert.equal(await labelBinding(ctx.env, STORE, keyOf(1)), "bound")
}))

test("labelBinding reads only a valid labels key and a readable state folder", () => scratch(async (ctx) => {
  await delivered(ctx)
  assert.equal(await labelBinding(ctx.env, STORE, "labels/x/y.json"), "unknown")
  assert.equal(await labelBinding(ctx.env, STORE, keyOf(1)), "bound")
  // A host's facts that bind another job, and a second host's facts that bind this one: bound wins as soon as one binds.
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  assert.equal(await labelBinding(ctx.env, STORE, keyOf(1)), "unbound")
  const other = localFacts(1)
  other.session.host = "copilot-cli"
  await fs.writeFile(path.join(await root(ctx), "outbox", SLUG, nameOf(1, "copilot-cli")), JSON.stringify(other))
  assert.equal(await labelBinding(ctx.env, STORE, keyOf(1)), "bound")
  // An outbox folder that is not a folder cannot be read: unknown.
  await fs.rm(path.join(await root(ctx), "outbox", SLUG), { recursive: true })
  await fs.writeFile(path.join(await root(ctx), "outbox", SLUG), "x")
  assert.equal(await labelBinding(ctx.env, STORE, keyOf(1)), "unknown")
}))

test("labelBinding with no factory state at all is unknown", () => scratch(async (ctx) => {
  assert.equal(await labelBinding(ctx.env, STORE, keyOf(1)), "unknown")
}))

test("a withdrawn label comes back when its session binds the job again, and other quarantine records are not lifted", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  await run(ctx.env, github)
  github.mergeOpenPr()
  await run(ctx.env, github)
  assert.equal(await exists(await quarantineFile(ctx, 1)), true)
  // Still unbound: the record stays. An unreadable record, and one with another reason, stay too.
  assert.deepEqual(await releaseReboundLabels(ctx.env, STORE), [])
  await quarantine(ctx.env, STORE, keyOf(2), "invalid")
  await fs.mkdir(path.join(await root(ctx), "quarantine", SLUG, "labels", JOB), { recursive: true })
  const odd = `labels/${JOB}/${sessionId(3)}.json`
  await fs.writeFile(path.join(await root(ctx), "quarantine", SLUG, odd), "{not json")
  assert.deepEqual(await releaseReboundLabels(ctx.env, STORE), [])
  // Bound again: the label publishes again.
  await rewriteFacts(ctx, 1, localFacts(1))
  assert.deepEqual(await releaseReboundLabels(ctx.env, STORE), [keyOf(1)])
  assert.equal(await exists(await quarantineFile(ctx, 1)), false)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(labelSessions(github), [sessionId(1), sessionId(2)])
}))

test("the flush lifts a withdrawn label's quarantine itself when the session binds the job again", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  await run(ctx.env, github)
  github.mergeOpenPr()
  await run(ctx.env, github)
  await rewriteFacts(ctx, 1, localFacts(1))
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal(labelsOnMain(github).length, 2)
}))

test("withdrawLabels with nothing to withdraw changes nothing", () => scratch(async (ctx) => {
  await delivered(ctx)
  await withdrawLabels(ctx.env, STORE, [])
  assert.equal(Object.hasOwn((await readDelivered(ctx.env, STORE)).blobs, keyOf(1)), true)
}))

test("with consent off nothing is withdrawn", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  await setConsent(ctx.env, { store: STORE, contribute: false, account: "contributor" })
  assert.equal((await readConsent(ctx.env)).stores[STORE].contribute, false)
  assert.equal((await run(ctx.env, github)).result, "not_opted_in")
  assert.equal(labelsOnMain(github).length, 2)
}))

test("a session held in quarantine keeps its labels where they are", () => scratch(async (ctx) => {
  const github = await delivered(ctx)
  await quarantine(ctx.env, STORE, nameOf(1), "invalid", { blob: "e".repeat(40) })
  await rewriteFacts(ctx, 1, localFacts(1, { binds: false }))
  await run(ctx.env, github)
  assert.equal(labelsOnMain(github).length, 2)
}))
