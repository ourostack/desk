// A proof-marked session whose record the store holds is withdrawn through the existing retraction path, whatever its route says, and is tombstoned
// once the store no longer holds it. Each case runs the real flush against the in-memory GitHub model in `_fake_github.js`, with synthetic sessions
// and temporary state only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { markProofSession } from "../../../../../plugins/desk/mcp/src/factory/proof-session.js"
import { factoryStateRoot, readDelivered, setConsent, settledProofChecks, writeLocalFacts, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub, httpError } from "./_fake_github.js"
import { STORE, recent, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const SLUG = "ourostack__factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n, host = "claude-code") => `${host}-${sessionId(n)}.json`

function localFacts(n) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  return value
}

const run = (env, github) => flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })

async function deskFor(base, name) {
  const desk = path.join(base, name)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store: STORE }))
  return desk
}

async function marker(env, base, n, desk, host = "claude-code") {
  const log = path.join(base, `log-${host}-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host, session_id: sessionId(n), log_path: log, cwd: base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: recent() })
}

// Session `n` is ordinary, routed here, and published: its facts are on the store's default branch, merged.
async function published(ctx, n, options = {}) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await marker(ctx.env, ctx.base, n, await deskFor(ctx.base, `desk-${n}`))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
  const github = fakeGitHub(options)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  // The flush that sees the merged file on the default branch is the one that records its delivery.
  await run(ctx.env, github)
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).blobs, nameOf(n)))
  assert.ok(github.mainFiles().has(`facts/${nameOf(n)}`))
  return github
}

const root = (ctx) => factoryStateRoot(ctx.env)
const auditEntries = async (ctx) => JSON.parse(await fs.readFile(path.join(await root(ctx), "proof-audit.json"), "utf8")).entries
const mark = (ctx, n) => markProofSession(ctx.env, { sessionId: sessionId(n) })

// Session `n` is a proof on this machine with a local copy and no record: nothing of it has been published.
async function proofOnly(ctx, n) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await marker(ctx.env, ctx.base, n, await deskFor(ctx.base, `desk-${n}`))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
  assert.deepEqual(await mark(ctx, n), { result: "marked" })
}

test("a proof session the store holds is withdrawn while its route still resolves here, and is tombstoned once merged", () => scratch(async (ctx) => {
  const github = await published(ctx, 1)
  assert.deepEqual(await mark(ctx, 1), { result: "marked" })
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.ok(github.mainFiles().has(`facts/${nameOf(1)}`), "the delete waits for its pull request to merge")
  github.mergeOpenPr()
  assert.equal(github.mainFiles().has(`facts/${nameOf(1)}`), false)
  await run(ctx.env, github)
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracted, nameOf(1)))
  const outcomes = (await auditEntries(ctx)).filter(({ reason }) => reason === "proof").map(({ action, state_before, outcome }) => [action, state_before, outcome])
  assert.deepEqual(outcomes, [["withdraw", "published", "pushed"], ["withdraw", "retracting", "withdrawn"]])
  await another(ctx, github, 9)
  assert.equal(github.mainFiles().has(`facts/${nameOf(1)}`), false, "a withdrawn session is never re-added")
}))

test("a withdrawal already in an open pull request is read back and not pushed again", () => scratch(async (ctx) => {
  const github = await published(ctx, 2)
  await mark(ctx, 2)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  const pulls = github.pullCount()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pullCount(), pulls)
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracting, nameOf(2)))
}))

test("an unmarked session, and a session two hosts record, are left on the store", () => scratch(async (ctx) => {
  const github = await published(ctx, 3)
  await marker(ctx.env, ctx.base, 4, await deskFor(ctx.base, "desk-4"), "copilot-cli")
  await marker(ctx.env, ctx.base, 4, await deskFor(ctx.base, "desk-4-claude"), "claude-code")
  assert.deepEqual(await mark(ctx, 4), { result: "refused", reason: "ambiguous" })
  await another(ctx, github, 9)
  assert.ok(github.mainFiles().has(`facts/${nameOf(3)}`))
  assert.equal(github.mainFiles().has(`facts/${nameOf(4)}`), false)
  assert.equal(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracting, nameOf(3)), false)
}))

// Publishes session `n` as an ordinary session of its own desk, so a flush goes online for a reason of its own.
async function another(ctx, github, n) {
  await marker(ctx.env, ctx.base, n, await deskFor(ctx.base, `desk-${n}`))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
}

// Removes session `n`'s delivery records, as a flush that never saw its file merged would have left them.
async function forgetRecord(ctx, n) {
  for (const dir of ["delivered", "delivered-paths"]) {
    const file = path.join(await root(ctx), dir, `${SLUG}.json`)
    const value = JSON.parse(await fs.readFile(file, "utf8"))
    delete value[nameOf(n)]
    await fs.writeFile(file, JSON.stringify(value))
  }
  assert.equal(Object.hasOwn((await readDelivered(ctx.env, STORE)).blobs, nameOf(n)), false)
}

const unrecordedAudit = async (ctx) => (await auditEntries(ctx)).filter(({ reason }) => reason === "proof, unrecorded").map(({ action, state_before, outcome }) => [action, state_before, outcome])

test("an owned proof record the flush never recorded is withdrawn, once its store file is exactly this owner's", () => scratch(async (ctx) => {
  const github = await published(ctx, 5)
  await forgetRecord(ctx, 5)
  assert.deepEqual(await mark(ctx, 5), { result: "marked" })
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.ok(github.mainFiles().has(`facts/${nameOf(5)}`), "the delete waits for its pull request to merge")
  github.mergeOpenPr()
  await run(ctx.env, github)
  assert.equal(github.mainFiles().has(`facts/${nameOf(5)}`), false)
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracted, nameOf(5)))
  assert.deepEqual(await unrecordedAudit(ctx), [["withdraw", "unrecorded", "pushed"], ["withdraw", "retracting", "withdrawn"]])
  const pulls = github.pullCount()
  const entries = (await auditEntries(ctx)).length
  assert.equal((await run(ctx.env, github)).result, "nothing_pending")
  assert.equal(github.pullCount(), pulls, "a rerun opens no pull request")
  assert.equal((await auditEntries(ctx)).length, entries, "a rerun audits nothing")
}))

test("a file at the expected path that another owner wrote is refused and audited, and never deleted", () => scratch(async (ctx) => {
  const github = await published(ctx, 6)
  const owned = github.blobText(github.mainFiles().get(`facts/${nameOf(6)}`))
  let foreign
  await scratch(async (other) => {
    const elsewhere = await published(other, 6)
    foreign = elsewhere.blobText(elsewhere.mainFiles().get(`facts/${nameOf(6)}`))
  })
  assert.notEqual(foreign, owned, "another machine's secret writes other bytes for the same session")
  await forgetRecord(ctx, 6)
  assert.deepEqual(await mark(ctx, 6), { result: "marked" })
  const theirs = fakeGitHub({ mainFacts: { [nameOf(6)]: foreign } })
  await run(ctx.env, theirs)
  await run(ctx.env, theirs)
  assert.equal(theirs.pullCount(), 0, "nothing is deleted or pushed for a file that is not ours")
  assert.ok(theirs.mainFiles().has(`facts/${nameOf(6)}`))
  assert.deepEqual(await unrecordedAudit(ctx), [["refuse", "unrecorded", "refused"]], "a refusal is audited once, not on every flush")
  const [refusal] = (await auditEntries(ctx)).filter(({ action }) => action === "refuse")
  assert.match(refusal.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/, "the refusal is timed like every other proof audit entry")
}))

test("a proof copy with no file on the store settles without a pull request, and later flushes do not go online for it", () => scratch(async (ctx) => {
  await proofOnly(ctx, 7)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "nothing_pending")
  assert.equal(github.pullCount(), 0)
  assert.equal(await unrecordedAudit(ctx).then((entries) => entries.length), 0, "a missing file is not audited")
  assert.equal((await run(ctx.env, fakeGitHub())).result, "nothing_pending")
}))

test("a listing too large to show the path leaves the check open, and the next flush that can read it settles it", () => scratch(async (ctx) => {
  await proofOnly(ctx, 8)
  const truncated = fakeGitHub()
  truncated.setTruncated(() => true)
  await run(ctx.env, truncated)
  assert.equal(truncated.pullCount(), 0)
  assert.deepEqual([...await settledProofChecks(ctx.env, STORE)], [], "an unknown path is not settled")
  assert.equal((await run(ctx.env, fakeGitHub())).result, "nothing_pending")
  assert.deepEqual([...await settledProofChecks(ctx.env, STORE)], [nameOf(8)])
}))

test("a delete whose pull request fails to open is audited as uncertain, and the next flush reads the store before it retries", () => scratch(async (ctx) => {
  let failing = false
  const github = await published(ctx, 9, { intercept: (call) => (failing && call.args.includes("POST") && call.args.includes(`repos/${STORE}/pulls`) ? httpError(502, "bad gateway") : undefined) })
  await forgetRecord(ctx, 9)
  await mark(ctx, 9)
  failing = true
  await run(ctx.env, github)
  assert.deepEqual(await unrecordedAudit(ctx), [["withdraw", "unrecorded", "uncertain"]])
  assert.equal(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracting, nameOf(9)), false, "nothing is recorded as withdrawn yet")
  failing = false
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracting, nameOf(9)))
  assert.deepEqual(await unrecordedAudit(ctx), [["withdraw", "unrecorded", "uncertain"], ["withdraw", "unrecorded", "pushed"]])
  github.mergeOpenPr()
  await run(ctx.env, github)
  assert.equal(github.mainFiles().has(`facts/${nameOf(9)}`), false)
}))
