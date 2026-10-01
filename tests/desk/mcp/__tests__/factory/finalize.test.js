// Finalize: when a task is done, its job's sessions are re-derived and flushed,
// and the finalize request is removed only once every one of the job's files is
// delivered or quarantined. Every store interaction is a fake; fixtures are
// synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  factoryStateRoot, listFinalizeRequests, requestFinalize, setConsent, writeLocalFacts, writeMarker, writeStatus,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { indexJob } from "./_index_helper.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, routeTo, scratch, session } from "./_session_helpers.js"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/src/factory/flush.js", import.meta.url)
async function load() {
  assert.ok(existsSync(moduleUrl), "the flush module must exist")
  return import(moduleUrl)
}

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const JOB = "1a2b3c4d5e6f708192a3b4c5d6e7f809"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n) => `claude-code-${sessionId(n)}.json`
const REQUESTED = "2026-09-27T10:00:00.000Z"
const at = (offsetMs) => new Date(Date.parse(REQUESTED) + offsetMs).toISOString()

async function marker(ctx, n, updatedAt) {
  const log = path.join(ctx.base, "logs", `${sessionId(n)}.jsonl`)
  await fs.mkdir(path.dirname(log), { recursive: true })
  await fs.writeFile(log, "{}\n")
  const old = new Date(Date.now() - 60 * 60 * 1000)
  await fs.utimes(log, old, old)
  await writeMarker(ctx.env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: ctx.desk, desk_root: ctx.desk, end_reason: null, ended_at: null, plugins: [], updated_at: updatedAt })
  return log
}

async function jobFile(ctx, n) {
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(n)
  facts.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  await routeTo(ctx.env, facts.session.id)
  const written = await writeLocalFacts(ctx.env, STORE, facts)
  assert.equal(written.written, true)
  await indexJob(ctx.env, JOB, written.name)
  await writeStatus(ctx.env, { derivations: { [written.name]: { store: STORE, marker: "x", size: 1, mtime: 1, ino: 1, dev: 1 } } })
  return written.name
}

async function requested(ctx, now = () => REQUESTED) {
  await requestFinalize(ctx.env, { job: JOB, deskRoot: ctx.desk }, { now })
}

const pendingRequest = async (env) => (await listFinalizeRequests(env)).some((entry) => entry.job === JOB)
const clockAt = (iso) => () => Date.parse(iso)

test("finalize re-derives only the job's indexed sessions and markers updated since the request", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await marker(ctx, 1, at(-2 * 60 * 60 * 1000))
  await marker(ctx, 2, at(60 * 1000))
  await marker(ctx, 3, at(-60 * 60 * 1000))
  await indexJob(ctx.env, JOB, nameOf(1))
  await requested(ctx)
  const derived = []
  const result = await finalize(ctx.env, {
    job: JOB,
    now: clockAt(at(5 * 60 * 1000)),
    derive: async (_env, file, options) => { derived.push({ name: path.basename(file), options }); return { result: "written", store: STORE } },
    flush: async () => assert.fail("no file of this job is in an outbox"),
  })
  assert.deepEqual(result, { result: "cleared", flushes: {} })
  assert.deepEqual(derived.map((entry) => entry.name).sort(), [nameOf(1), nameOf(2)])
  assert.ok(derived.every((entry) => entry.options.quietMs === 5000), "the current session gets five quiet seconds")
  assert.equal(await pendingRequest(ctx.env), false)
}))

test("finalize waits for the current session log to go quiet before deriving it", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const live = await session(ctx)
  await writeMarker(ctx.env, { ...live, updated_at: new Date().toISOString() })
  await requestFinalize(ctx.env, { job: JOB, deskRoot: ctx.desk }, { now: () => new Date(Date.now() - 1000).toISOString() })
  await fs.appendFile(live.log_path, "")
  await fs.utimes(live.log_path, new Date(), new Date())
  const { deriveFile } = await import("../../../../../plugins/desk/mcp/src/factory/derive-run.js")
  const seen = []
  const derive = async (env, file, options) => {
    const waitedFrom = performance.now()
    const outcome = await deriveFile(env, file, options)
    seen.push({ outcome, waited: performance.now() - waitedFrom, options })
    return outcome
  }
  const result = await finalize(ctx.env, { job: JOB, quietMs: 300, derive, flush: async () => ({ result: "nothing_pending", pending: [] }) })
  assert.equal(seen.length, 1, JSON.stringify(seen))
  assert.equal(seen[0].options.quietMs, 300)
  assert.ok(seen[0].waited >= 250, `finalize waited for the log to go quiet: ${JSON.stringify(seen)}`)
  assert.equal(seen[0].outcome.result, "written", JSON.stringify(seen))
  assert.equal(result.result, "cleared", JSON.stringify(result))
  const root = await factoryStateRoot(ctx.env)
  assert.equal(existsSync(path.join(root, "outbox", "ourostack__factory", `claude-code-${live.session_id}.json`)), true, "the quiet session was derived")
}))

test("finalize clears the request once the job's files are delivered or quarantined", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const name = await jobFile(ctx, 1)
  await requested(ctx)
  const calls = []
  const result = await finalize(ctx.env, {
    job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "skipped" }),
    flush: async (_env, options) => { calls.push(options.store); return { result: "delivered_pr_open", pr: { number: 1, url: "u" }, pending: ["claude-code-00000000-0000-4000-8000-0000000000ff.json"] } },
  })
  assert.deepEqual(result, { result: "cleared", flushes: { [STORE]: "delivered_pr_open" } })
  assert.deepEqual(calls, [STORE])
  assert.equal(await pendingRequest(ctx.env), false)
  await requested(ctx)
  assert.equal((await finalize(ctx.env, { job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "skipped" }), flush: async () => ({ result: "nothing_pending", pending: [] }) })).result, "cleared")
  await requested(ctx)
  const retried = await finalize(ctx.env, { job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "skipped" }), flush: async () => ({ result: "intake_stale_retried", pr: { number: 2, url: "u" }, stale_retries: 1, pending: [name] }) })
  assert.deepEqual(retried, { result: "retained", flushes: { [STORE]: "intake_stale_retried" } }, "a stale retry still has the job's file in its new PR")
  assert.ok(name)
}))

const RETAINING = [
  ...["not_opted_in", "no_account", "gh_missing", "gh_too_old", "auth_failed", "store_missing", "account_cannot_deliver", "fork_pending", "rate_limited", "offline", "deadline", "unexpected"].map((code) => [code, { result: code, pending: null }]),
  ["the job's file still in the open PR", { result: "delivered_pr_open", pr: { number: 1, url: "u" }, pending: [null] }],
]

for (const [label, answer] of RETAINING) {
  test(`finalize keeps the request when the flush ends ${label}`, () => scratch(async (ctx) => {
    const { finalize } = await load()
    await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
    const name = await jobFile(ctx, 1)
    await requested(ctx)
    const reply = answer.pending?.[0] === null ? { ...answer, pending: [name] } : answer
    const result = await finalize(ctx.env, { job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "skipped" }), flush: async () => reply })
    assert.equal(result.result, "retained")
    assert.equal(result.flushes[STORE], reply.result)
    assert.equal(await pendingRequest(ctx.env), true)
  }))
}

test("finalize keeps the request while a session is unreadable or still busy", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const log = await marker(ctx, 1, at(-60 * 1000))
  await indexJob(ctx.env, JOB, nameOf(1))
  await requested(ctx)
  const nothing = async () => ({ result: "nothing_pending", pending: [] })
  assert.equal((await finalize(ctx.env, { job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "source_unreadable" }), flush: nothing })).result, "retained")
  await fs.utimes(log, new Date(), new Date())
  assert.equal((await finalize(ctx.env, { job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "skipped" }), flush: nothing })).result, "retained")
  await fs.unlink(log)
  await requested(ctx)
  assert.equal((await finalize(ctx.env, { job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "skipped" }), flush: nothing })).result, "cleared", "a log that is gone is quiet")
  await requested(ctx)
  assert.equal((await finalize(ctx.env, { job: JOB, now: clockAt(REQUESTED), derive: async () => ({ result: "log_missing" }), flush: nothing })).result, "cleared")
}))

test("finalize waits out a locked flush, and keeps the request when the lock outlives its deadline", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await jobFile(ctx, 1)
  await requested(ctx)
  const answers = [{ result: "locked", pending: null }, { result: "nothing_pending", pending: [] }]
  assert.equal((await finalize(ctx.env, { job: JOB, derive: async () => ({ result: "skipped" }), flush: async () => answers.shift() })).result, "cleared")
  await requested(ctx)
  const result = await finalize(ctx.env, { job: JOB, deadlineMs: 50, derive: async () => ({ result: "skipped" }), flush: async () => ({ result: "locked", pending: null }) })
  assert.deepEqual(result, { result: "retained", flushes: { [STORE]: "deadline" } })
  assert.equal(await pendingRequest(ctx.env), true)
}))

test("finalize ignores index entries whose store is unknown or whose outbox file is gone", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const name = await jobFile(ctx, 1)
  await indexJob(ctx.env, JOB, nameOf(2))
  await fs.unlink(path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", name))
  await requested(ctx)
  const result = await finalize(ctx.env, { job: JOB, derive: async () => ({ result: "skipped" }), flush: async () => assert.fail("nothing to flush") })
  assert.deepEqual(result, { result: "cleared", flushes: {} })
}))

test("a request older than 30 days is dropped; bad jobs and a machine without factory state do nothing", () => scratch(async (ctx) => {
  const { finalize } = await load()
  assert.deepEqual(await finalize(ctx.env, { job: JOB }), { result: "retained", reason: "no_state" })
  assert.deepEqual(await finalize(ctx.env, { job: "../x" }), { result: "invalid" })
  assert.deepEqual(await finalize(ctx.env, {}), { result: "invalid" })
  assert.deepEqual(await finalize(ctx.env), { result: "invalid" })
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await requested(ctx)
  const result = await finalize(ctx.env, { job: JOB, now: clockAt(at(31 * 24 * 60 * 60 * 1000)), derive: async () => assert.fail("expired"), flush: async () => assert.fail("expired") })
  assert.deepEqual(result, { result: "expired" })
  assert.equal(await pendingRequest(ctx.env), false)
}))

test("end to end with the real flush: the request stays while the PR is open and clears once the store has merged it", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await jobFile(ctx, 1)
  await requested(ctx)
  const github = fakeGitHub()
  const first = await finalize(ctx.env, { job: JOB, runner: github.runner, anonymousLookup: github.anonymousLookup, derive: async () => ({ result: "skipped" }) })
  assert.deepEqual(first, { result: "retained", flushes: { [STORE]: "delivered_pr_open" } })
  // The referenced repo's visibility check 404s against the fake's authenticated call and must retry through
  // the fake's anonymousLookup, never the real fetch: a regression guard for finalize threading its
  // anonymousLookup option through to the flush, instead of falling back to a real, rate-limitable request.
  assert.ok(github.anonymousCalls.length > 0, "finalize's flush must use the fake anonymousLookup, not a real fetch")
  assert.equal(await pendingRequest(ctx.env), true)
  github.mergeOpenPr()
  const second = await finalize(ctx.env, { job: JOB, runner: github.runner, anonymousLookup: github.anonymousLookup, derive: async () => ({ result: "skipped" }) })
  assert.deepEqual(second, { result: "cleared", flushes: { [STORE]: "nothing_pending" } })
  assert.equal(await pendingRequest(ctx.env), false)
}))

test("without a request finalize works from the jobs index alone, and flushes every store holding the job's files in order", () => scratch(async (ctx) => {
  const { finalize } = await load()
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(ctx.env, { store: "acme/second", contribute: true, account: "contributor" })
  await jobFile(ctx, 1)
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(2)
  const written = await writeLocalFacts(ctx.env, "acme/second", facts)
  await indexJob(ctx.env, JOB, written.name)
  await writeStatus(ctx.env, { derivations: { [written.name]: { store: "acme/second", marker: "x", size: 1, mtime: 1, ino: 1, dev: 1 } } })
  await marker(ctx, 3, at(0))
  const derived = []
  const flushed = []
  const result = await finalize(ctx.env, {
    job: JOB,
    derive: async (_env, file) => { derived.push(path.basename(file)); return { result: "skipped" } },
    flush: async (_env, options) => { flushed.push(options.store); return { result: "nothing_pending", pending: [] } },
  })
  assert.deepEqual(result, { result: "cleared", flushes: { "acme/second": "nothing_pending", [STORE]: "nothing_pending" } })
  assert.deepEqual(flushed, ["acme/second", STORE])
  // Session 1 is indexed and routed (it has a marker); session 3 has a marker but is not indexed, and there is no request.
  assert.deepEqual(derived, [`claude-code-${sessionId(1)}.json`], "no request, so only indexed sessions with markers are derived")
}))
