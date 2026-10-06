// Retraction, tested against three invariants. I1: a session is published to a store only while its marker positively routes there; an
// unknown route or a held session is frozen (never published, never deleted). I2: the intake branch is always rebuilt from the change set
// the current state wants, and an open intake PR is closed when that set is empty. I3: retraction never deletes local files; a finished
// retraction drops only its record. Every GitHub interaction goes through the in-memory model in `_fake_github.js`; every fixture is
// synthetic, and the other store's name is a stand-in that must never reach the first store. Each sequence ends by asserting what the
// store's main holds after the fake merges.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import {
  factoryStateRoot, keepRetractedCopies, keptSessions, pruneTombstones, pendingFiles, pendingLabels, quarantine, readConsent, readDelivered, readMachineSecret, readStatus, setConsent, writeLocalFacts, writeLocalLabels, writeMarker, writeStatus,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub, httpError } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
const OTHER = "shared-internal-tools/ms-desk-factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n, host = "claude-code") => `${host}-${sessionId(n)}.json`

function localFacts(n, host = "claude-code") {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.session.host = host
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  return value
}

const run = (env, github) => flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })
const branchOf = async (env) => `intake/${(await readConsent(env)).stores[STORE].intake_id}`
const keyedJob = async (env) => createHmac("sha256", await readMachineSecret(env)).update(LABELS.job).digest("hex").slice(0, 32)

// A desk folder under `base` that declares `store` (or nothing, with `store` null).
async function deskFor(base, name, store) {
  const desk = path.join(base, name)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  if (store !== null) await fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
  return desk
}

async function marker(env, base, n, desk, extra = {}, host = "claude-code") {
  const log = path.join(base, `log-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host, session_id: sessionId(n), log_path: log, cwd: base, desk_root: desk, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString(), ...extra })
}

// Sessions 1..count delivered to the store and merged there, each from a desk declaring the store, with labels for the sessions in `labelled`.
async function delivered({ base, env }, count, { labelled = [], github: options = {} } = {}) {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const desks = []
  for (let n = 1; n <= count; n += 1) {
    desks.push(await deskFor(base, `desk-${n}`, STORE))
    await marker(env, base, n, desks[n - 1])
    assert.equal((await writeLocalFacts(env, STORE, localFacts(n))).written, true)
  }
  for (const n of labelled) assert.equal((await writeLocalLabels(env, STORE, { ...structuredClone(LABELS), session: sessionId(n) })).written, true)
  const github = fakeGitHub(options)
  assert.equal((await run(env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  // The merged delivery is confirmed by the next flush, as any delivery is.
  assert.equal((await run(env, github)).result, "nothing_pending")
  return { github, desks }
}

const reroute = (desk, store) => fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
const dataFiles = (github) => [...github.mainFiles().keys()].sort()

const names = async (ctx, which = "blobs") => Object.keys((await readDelivered(ctx.env, STORE))[which]).sort()
const retractingFile = async (ctx) => path.join(await factoryStateRoot(ctx.env), "retracting", "ourostack__factory.json")
const outboxFile = async (ctx, n) => path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", nameOf(n))
const keptFile = async (ctx, n) => path.join(await factoryStateRoot(ctx.env), "retracted-copies", "ourostack__factory", nameOf(n))
const lastFlush = async (ctx) => (await readStatus(ctx.env)).last_flush[STORE]
// A flush that makes no GitHub call at all: the idle fast path.
async function offline(ctx, github) {
  const before = github.calls.length
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.calls.length, before, "no network call")
}
// A new session 9 routed to the store, so the next flush goes online for a reason of its own.
async function another(ctx, n = 9) {
  const desk = await deskFor(ctx.base, `desk-${n}`, STORE)
  await marker(ctx.env, ctx.base, n, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
}

// ---------------------------------------------------------------------------
// The basic retraction.
// ---------------------------------------------------------------------------

test("a delivered file whose desk now routes to another store is deleted in the next intake PR, with route_changed in the body", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  const result = await run(ctx.env, github)
  assert.equal(result.result, "delivered_pr_open")
  const branch = await branchOf(ctx.env)
  assert.deepEqual([...github.headFiles(STORE, branch).keys()], [`facts/${nameOf(2)}`])
  const pr = github.pulls.at(-1)
  assert.equal(pr.body, "0\n\nRetracted: 1 files (route_changed)")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`])
}))

test("a file whose session still routes to the store is never deleted, and an idle flush makes no network call", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2, { labelled: [1] })
  // One desk declares the store again, another reaches it by default with the overlay check its hook recorded.
  await fs.rm(path.join(desks[1], "_meta", "factory.json"))
  await marker(ctx.env, ctx.base, 2, desks[1], { routing: { store: STORE, source: "default", warnings: [] } })
  const before = github.pullCount()
  await offline(ctx, github)
  assert.equal(github.pullCount(), before)
  assert.equal((await lastFlush(ctx)).intake_pushed, undefined)
  assert.equal(dataFiles(github).length, 3)
}))

test("an invalid declaration, or a desk folder that no longer resolves, freezes the session wherever it is read; only a missing marker or a null desk root keeps the last known route", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 6)
  const root = await factoryStateRoot(ctx.env)
  // 1: desk folder gone (moved or renamed): frozen, where it routes now cannot be read; its delivered file stays. 2: unreadable declaration. 3: a declaration that is not a
  // store. 4: default route whose hook recorded that it could not resolve one. 5: marker pruned, its receipt's desk folder still there
  // with an unreadable declaration. 6: a marker with no desk root, whose receipt's desk now declares the other store.
  await fs.rm(desks[0], { recursive: true })
  await fs.writeFile(path.join(desks[1], "_meta", "factory.json"), "{ not json")
  await reroute(desks[2], "not a store")
  await fs.rm(path.join(desks[3], "_meta", "factory.json"))
  await marker(ctx.env, ctx.base, 4, desks[3], { routing: { store: null, source: "invalid_declaration", warnings: [] } })
  await fs.rm(path.join(root, "markers", nameOf(5)))
  await fs.writeFile(path.join(desks[4], "_meta", "factory.json"), "{ not json")
  await marker(ctx.env, ctx.base, 6, null)
  await reroute(desks[5], OTHER)
  // Changed facts of frozen sessions 2 and 5 wait. 7: a new session in desk 2 waits too. 8: a new session whose desk folder is gone
  // is frozen too, never published to the store the sweep put it in.
  for (const n of [2, 5]) {
    const changed = localFacts(n)
    changed.session.end_reason = "clear"
    assert.equal((await writeLocalFacts(ctx.env, STORE, changed)).written, true)
  }
  await marker(ctx.env, ctx.base, 7, desks[1])
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(7))).written, true)
  await marker(ctx.env, ctx.base, 8, path.join(ctx.base, "moved-desk"))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(8))).written, true)
  const before = github.mainFiles()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "0\n\nRetracted: 1 files (route_changed)")
  assert.equal((await lastFlush(ctx)).route_unknown, 5)
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [1, 2, 3, 4, 5].map((n) => `facts/${nameOf(n)}`))
  for (const n of [2, 5]) assert.equal(github.mainFiles().get(`facts/${nameOf(n)}`), before.get(`facts/${nameOf(n)}`), "a frozen session's change never goes")
  // The declaration is fixed: the session publishes again.
  await reroute(desks[1], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "2")
}))

test("a pruned marker keeps the derive-time route: a pending facts file and late labels publish, and nothing is deleted", () => scratch(async (ctx) => {
  const { github } = await delivered(ctx, 1)
  const root = await factoryStateRoot(ctx.env)
  // Session 2 was derived while its marker lived, which the receipt records; then the marker was pruned. Session 1's labels arrive late.
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(2))).written, true)
  await writeStatus(ctx.env, { derivations: { [nameOf(2)]: { store: STORE, marker: "x", binding_version: 4 } } })
  await fs.rm(path.join(root, "markers", nameOf(1)))
  assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(1) })).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "2")
  github.mergeOpenPr()
  const job = await keyedJob(ctx.env)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`, `facts/${nameOf(2)}`, `labels/${job}/${sessionId(1)}.json`])
}))

test("an older hook's marker with no recorded route keeps the derive-time route: it publishes, and is never deleted", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  // The desk declares nothing, so its default route needs the overlay check this hook never recorded.
  const desk = await deskFor(ctx.base, "old-desk", null)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a copy left in an older store's outbox is stale once the receipt names the store the session moved to: never published, never deleted", () => scratch(async (ctx) => {
  const { github } = await delivered(ctx, 1)
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "markers", nameOf(1)))
  // A later derive went to the other store; the copy here is stale. A new session left behind the same way never goes either.
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: OTHER, marker: "x", binding_version: 4 }, [nameOf(2)]: { store: OTHER, marker: "x", binding_version: 4 } } })
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(2))).written, true)
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a finished retraction stays finished after the marker is pruned: the receipt keeps the route the marker last gave", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  await run(ctx.env, github)
  // The other store has no consent here, so the sweep never re-derived the session: only the flush saw the new route.
  const receipt = (await readStatus(ctx.env)).derivations[nameOf(1)]
  assert.equal(receipt.route, OTHER)
  await fs.rm(path.join(await factoryStateRoot(ctx.env), "markers", nameOf(1)))
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(9)}`])
}))

test("a held session keeps its file: a marker with no desk root, and a Codex default route nothing has verified", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await marker(ctx.env, ctx.base, 1, null)
  await fs.rm(path.join(desks[1], "_meta", "factory.json"))
  const log = path.join(ctx.base, "log-2.jsonl")
  const codex = nameOf(2, "codex-cli")
  await writeMarker(ctx.env, { schema_version: 1, host: "codex-cli", session_id: sessionId(2), log_path: log, cwd: ctx.base, desk_root: desks[1], end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString(), routing: { store: OTHER, source: "default", warnings: [] } })
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "markers", nameOf(2)))
  assert.equal((await fs.readdir(path.join(root, "markers"))).includes(codex), true)
  await offline(ctx, github)
  assert.equal(dataFiles(github).length, 2)
}))

test("a Codex session on the default route: published when proven, kept by its derive-time route when the proof is gone, deleted only on a positive route elsewhere", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "codex-desk", null)
  const id = "01927a3b-8c00-7abc-8def-0123456789ab"
  const log = path.join(ctx.base, "codex.jsonl")
  await fs.writeFile(log, "{}\n")
  await writeMarker(ctx.env, { schema_version: 1, host: "codex-cli", session_id: id, log_path: log, cwd: desk, desk_root: desk, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
  const facts = localFacts(1, "codex-cli")
  facts.session.id = id
  assert.equal((await writeLocalFacts(ctx.env, STORE, facts)).written, true)
  // A proof candidate for a desk that no longer exists proves nothing; a Claude Code session in the same desk whose hook checked the
  // plugin overlays and found none proves the default route.
  await marker(ctx.env, ctx.base, 3, path.join(ctx.base, "gone-desk"), { routing: { store: STORE, source: "default", warnings: [] } })
  await marker(ctx.env, ctx.base, 2, desk, { routing: { store: STORE, source: "default", warnings: [] } })
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal(dataFiles(github).length, 1)
  // The proving marker is gone: the session was proven when it was derived, so it keeps its route and nothing happens.
  await fs.rm(path.join(await factoryStateRoot(ctx.env), "markers", nameOf(2)))
  await run(ctx.env, github)
  await offline(ctx, github)
  assert.equal(dataFiles(github).length, 1)
  // The desk now declares another store: a positive route, so the file is retracted.
  await reroute(desk, OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [])
}))

test("labels are retracted with their facts, at the keyed path they were delivered at, and nothing else goes", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2, { labelled: [1, 2] })
  const job = await keyedJob(ctx.env)
  assert.notEqual(job, LABELS.job)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`, `facts/${nameOf(2)}`, `labels/${job}/${sessionId(1)}.json`, `labels/${job}/${sessionId(2)}.json`])
  // The record keeps the published path, which is not the local key.
  const recorded = (await readDelivered(ctx.env, STORE)).paths[`labels/${LABELS.job}/${sessionId(1)}.json`]
  assert.equal(recorded.path, `labels/${job}/${sessionId(1)}.json`)
  assert.match(recorded.blob, /^[0-9a-f]{40}$/u)
  await reroute(desks[0], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "0\n\nRetracted: 2 files (route_changed)")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`, `labels/${job}/${sessionId(2)}.json`])
}))

test("a delivered record from before paths were recorded is retracted at the path republishing gives, only when the blob matches", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "delivered-paths"), { recursive: true })
  await reroute(desks[0], OTHER)
  const record = path.join(root, "delivered", "ourostack__factory.json")
  const blobs = JSON.parse(await fs.readFile(record, "utf8"))
  // Session 2's record no longer matches what this Desk publishes, so it is not trusted as a path; session 1 still is.
  await reroute(desks[1], OTHER)
  blobs[nameOf(2)] = "e".repeat(40)
  await fs.writeFile(record, JSON.stringify(blobs))
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`])
}))

test("an older delivered record with labels is retracted at the republished paths; one whose local files are gone or no longer publish is kept, never quarantined", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 4, { labelled: [1, 4] })
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "delivered-paths"), { recursive: true })
  // Session 3's local facts are gone, so nothing says where it was delivered.
  await fs.rm(path.join(root, "outbox", "ourostack__factory", nameOf(3)))
  // Session 4's local facts and labels no longer publish at all (the transform refuses the one and the labels gate the other).
  const refused = localFacts(4)
  refused.session.started_at = "2020-01-01T00:00:00.000Z"
  refused.intervals = []
  await fs.writeFile(await outboxFile(ctx, 4), `${JSON.stringify(refused)}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(root, "labels", "ourostack__factory", LABELS.job, `${sessionId(4)}.json`), `${JSON.stringify({ ...structuredClone(LABELS), session: sessionId(5) })}\n`, { mode: 0o600 })
  for (const desk of desks) await reroute(desk, OTHER)
  // Session 2's desk folder is a plain file, which is not a desk.
  await fs.rm(desks[1], { recursive: true })
  await fs.writeFile(desks[1], "not a folder")
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "0\n\nRetracted: 2 files (route_changed)")
  github.mergeOpenPr()
  const job = await keyedJob(ctx.env)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`, `facts/${nameOf(3)}`, `facts/${nameOf(4)}`, `labels/${job}/${sessionId(4)}.json`])
  assert.equal((await readDelivered(ctx.env, STORE)).quarantined.size, 0)
}))

test("the PR names neither the other store nor a session, and its branch and commit stay as they were", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const pr = github.pulls.at(-1)
  const branch = await branchOf(ctx.env)
  const commit = github.commit(github.ref(STORE, branch))
  // The store's flush status never names the other store; the session's local derivation receipt keeps its route, as receipts keep every derive's store.
  assert.doesNotMatch(JSON.stringify(await lastFlush(ctx)), /ms-desk-factory|shared-internal-tools/u)
  // The tree call names the deleted path, which holds the session id by design; everything else must not.
  const trees = github.calls.filter((call) => /git\/trees/u.test(call.args.join(" "))).map((call) => call.input ?? "")
  const texts = [pr.title, pr.body, pr.head.ref, commit.message, ...github.calls.filter((call) => /pulls|commits|refs/u.test(call.args.join(" "))).map((call) => call.input ?? "")]
  for (const text of [...texts, ...trees]) {
    assert.equal(text.includes(ctx.base), false, "no desk path")
    assert.doesNotMatch(text, /ms-desk-factory|shared-internal-tools|internal/iu)
  }
  for (const text of texts) assert.doesNotMatch(text, new RegExp(sessionId(1), "u"))
  assert.equal(commit.message, "Factory intake")
}))

test("a session is never both published and deleted in one PR", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  // New facts for the retracted session and for another one arrive in the same flush.
  const changed = localFacts(1)
  changed.session.end_reason = "clear"
  const written = await writeLocalFacts(ctx.env, STORE, changed)
  assert.equal(written.written, true, JSON.stringify(written))
  const other = localFacts(3)
  await marker(ctx.env, ctx.base, 3, desks[1])
  assert.equal((await writeLocalFacts(ctx.env, STORE, other)).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  const pr = github.pulls.at(-1)
  assert.equal(pr.body, "1\n\nRetracted: 1 files (route_changed)")
  const head = [...github.headFiles(STORE, await branchOf(ctx.env)).keys()].sort()
  assert.deepEqual(head, [`facts/${nameOf(2)}`, `facts/${nameOf(3)}`])
}))

// ---------------------------------------------------------------------------
// The retracting state, I2 and I3.
// ---------------------------------------------------------------------------

test("a pushed delete moves the session to retracting and is retried while open; once merged the record goes, the local files stay, and nothing more is pushed", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  const root = await factoryStateRoot(ctx.env)
  const both = [`labels/${LABELS.job}/${sessionId(1)}.json`, nameOf(1)].sort()
  await reroute(desks[0], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  const open = github.pulls.at(-1).number
  assert.deepEqual(await names(ctx), [])
  assert.deepEqual(await names(ctx, "paths"), [])
  assert.deepEqual(await names(ctx, "retracting"), both)
  assert.equal((await lastFlush(ctx)).intake_pushed, true)
  // Still open: the next flush deletes again on the same PR and keeps the state.
  assert.equal((await run(ctx.env, github)).pr.number, open)
  assert.equal(github.pullCount(), 2)
  assert.deepEqual(await names(ctx, "retracting"), both)
  github.mergeOpenPr()
  // Merged and still routed elsewhere: done. Only the record goes; the local files stay (I3), and are never published while away (I1).
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.equal((await fs.stat(path.join(root, "retracted-copies", "ourostack__factory", nameOf(1)))).isFile(), true)
  assert.equal((await fs.stat(path.join(root, "retracted-copies", "ourostack__factory", "labels", LABELS.job, `${sessionId(1)}.json`))).isFile(), true)
  await offline(ctx, github)
  assert.equal(github.pullCount(), 2)
  assert.deepEqual(dataFiles(github), [])
}))

test("delete pushed and merged, then the session routes back with no flush between: the file is republished", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [])
  await reroute(desks[0], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal(dataFiles(github).length, 2)
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal((await names(ctx)).length, 2)
}))

test("delete pushed and still open, then the session routes back: the PR is closed, the branch reset, and main keeps the file", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const open = github.pulls.at(-1)
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(open.state, "closed")
  assert.deepEqual([...github.headFiles(STORE, await branchOf(ctx.env)).keys()], [`facts/${nameOf(1)}`])
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(await names(ctx), [nameOf(1)])
  assert.equal((await lastFlush(ctx)).intake_pushed, undefined)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
  await offline(ctx, github)
}))

test("delete pushed and open, its branch removed by someone, then the session routes back: the PR is closed with no branch to reset", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const open = github.pulls.at(-1)
  github.dropBranch(STORE, await branchOf(ctx.env))
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(open.state, "closed")
  assert.equal(github.ref(STORE, await branchOf(ctx.env)), null)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("delete pushed, status.json lost, then the session routes back: the file is not lost", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  await fs.rm(path.join(await factoryStateRoot(ctx.env), "status.json"))
  await reroute(desks[0], STORE)
  await run(ctx.env, github)
  while (github.pulls.some((pr) => pr.state === "open")) github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("delete pushed and merged, status.json lost, routed back: the file is republished", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  await fs.rm(path.join(await factoryStateRoot(ctx.env), "status.json"))
  await reroute(desks[0], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("F1: the retracting record is lost while the delete PR is open, then the session routes back: the PR is closed and main keeps the file", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const open = github.pulls.at(-1)
  await fs.rm(await retractingFile(ctx))
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(open.state, "closed")
  while (github.pulls.some((pr) => pr.state === "open")) github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
  assert.deepEqual(await names(ctx), [nameOf(1)])
}))

test("F1, still away: the retracting record is lost while the delete PR is open; the delete is found again by its blob and finishes", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  const first = await run(ctx.env, github)
  await fs.rm(await retractingFile(ctx))
  // The pushed batch is still unsettled, so the flush goes online, sees its own file on main and keeps deleting it on the same PR.
  assert.equal((await run(ctx.env, github)).pr.number, first.pr.number)
  assert.deepEqual(await names(ctx, "retracting"), [nameOf(1)])
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [])
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [])
}))

test("F2: a finished retraction keeps the local file, and a later flush that goes online never publishes it while the session is away", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  await run(ctx.env, github)
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.equal((await fs.stat(await keptFile(ctx, 1))).isFile(), true)
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, await branchOf(ctx.env)).keys()], [`facts/${nameOf(9)}`])
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(9)}`])
}))

test("F3: a session with no record whose route is away is never published, and costs no network call", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  // Derived for the store, then the desk moved before any flush.
  await reroute(desk, OTHER)
  const github = fakeGitHub()
  await offline(ctx, github)
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(9)}`])
}))

test("a retracting session whose route can no longer be shown positive is stalled: its delete leaves the branch, its record stays, counted, and it never sends a flush online", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const open = github.pulls.at(-1)
  await fs.writeFile(path.join(desks[0], "_meta", "factory.json"), "{ not json")
  // Online because the pushed batch is unsettled: nothing is wanted now, so the PR is closed; nothing is published or deleted.
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(open.state, "closed")
  assert.deepEqual(await names(ctx, "retracting"), [nameOf(1)])
  assert.equal((await lastFlush(ctx)).retraction_stalled, 1)
  assert.equal((await lastFlush(ctx)).route_unknown, undefined)
  await offline(ctx, github)
  assert.equal((await lastFlush(ctx)).retraction_stalled, 1)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("F4: a finished retraction, then a route back, restores the file from the kept local copy without a re-derive", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(dataFiles(github), [])
  await reroute(desks[0], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal(dataFiles(github).length, 2)
}))

test("a truncated tree listing never reads as absent: the retraction is not done until a full listing shows the file gone", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  github.setTruncated((_sha, entries) => entries.has(nameOf(2)))
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [nameOf(1)])
  github.setTruncated(() => false)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`])
}))

test("a delete whose new tree listing is truncated cannot be verified and stops the flush, keeping the session delivered", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  github.setTruncated((_sha, entries) => entries.has(nameOf(2)) && !entries.has(nameOf(1)))
  assert.deepEqual(await run(ctx.env, github), { result: "unexpected" })
  assert.deepEqual(await names(ctx), [nameOf(1), nameOf(2)])
  assert.deepEqual(await names(ctx, "retracting"), [])
}))

test("a crash between the delivered and retracting writes leaves a safe state", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  const root = await factoryStateRoot(ctx.env)
  const blobs = JSON.parse(await fs.readFile(path.join(root, "delivered", "ourostack__factory.json"), "utf8"))
  const paths = JSON.parse(await fs.readFile(path.join(root, "delivered-paths", "ourostack__factory.json"), "utf8"))
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  // Retracting written but delivered not yet dropped: the next flush reads retracting, finishes it, and no stale delivered record is left.
  await fs.writeFile(path.join(root, "delivered", "ourostack__factory.json"), JSON.stringify(blobs))
  await fs.writeFile(path.join(root, "delivered-paths", "ourostack__factory.json"), JSON.stringify(paths))
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx), [])
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(dataFiles(github), [])
}))

test("delivered records lost while away: the store's copy is found by its blob the next time the flush is online, and deleted", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "delivered"), { recursive: true })
  await fs.rm(path.join(root, "delivered-paths"), { recursive: true })
  await reroute(desks[0], OTHER)
  // Nothing local says this machine has anything in the store, so an idle flush stays offline.
  await offline(ctx, github)
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "1\n\nRetracted: 1 files (route_changed)")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(9)}`])
}))

test("a delivered file of an away session that the store no longer holds ends its record without a delete", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  const root = await factoryStateRoot(ctx.env)
  // Session 1's record says it was delivered, but its delete merged and the retracting record was lost before the delivered one was dropped.
  const blobs = JSON.parse(await fs.readFile(path.join(root, "delivered", "ourostack__factory.json"), "utf8"))
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  await fs.rm(await retractingFile(ctx))
  await fs.writeFile(path.join(root, "delivered", "ourostack__factory.json"), JSON.stringify(blobs))
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx), [nameOf(2)])
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`])
}))

// ---------------------------------------------------------------------------
// Refusals and holds.
// ---------------------------------------------------------------------------

test("a delete the store refuses returns the session to delivered, is counted, and never sends a flush online again", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.deepEqual(await names(ctx, "retracting"), [nameOf(1)])
  github.rejectOpenPr("factory-rejected: removal")
  const pr = github.pulls.at(-1)
  github.addClosedPr({ comment: "factory-rejected: removal", fileNames: [nameOf(1)], headLabel: pr.head.label })
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(await names(ctx), [nameOf(1)])
  assert.equal((await lastFlush(ctx)).retractions_refused, 1)
  const before = github.pullCount()
  await offline(ctx, github)
  assert.equal(github.pullCount(), before)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a refusal whose return to delivered was cut short is finished by the next flush, which stays offline", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const retracting = await fs.readFile(await retractingFile(ctx), "utf8")
  github.rejectOpenPr("factory-rejected: removal")
  github.addClosedPr({ comment: "factory-rejected: removal", fileNames: [nameOf(1)], headLabel: github.pulls.at(-1).head.label })
  await run(ctx.env, github)
  assert.equal((await lastFlush(ctx)).retractions_refused, 1)
  // The crash: the retracting record was never removed, and in one order the delivered record was never written either.
  await fs.writeFile(await retractingFile(ctx), retracting)
  await offline(ctx, github)
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(await names(ctx), [nameOf(1)])
  const root = await factoryStateRoot(ctx.env)
  await fs.writeFile(await retractingFile(ctx), retracting)
  await fs.rm(path.join(root, "delivered"), { recursive: true })
  await offline(ctx, github)
  assert.deepEqual(await names(ctx), [nameOf(1)])
  assert.equal((await lastFlush(ctx)).retractions_refused, 1)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a refused delete is counted, not quarantined, not retried, cleared when the route changes, and publishable again when the session routes back", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  github.addClosedPr({ comment: "factory-rejected: removal", fileNames: [nameOf(1)], headLabel: `ourostack:${await branchOf(ctx.env)}` })
  const before = github.pullCount()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal((await lastFlush(ctx)).retractions_refused, 1)
  assert.deepEqual((await readDelivered(ctx.env, STORE)).quarantined.size, 0)
  await offline(ctx, github)
  assert.equal((await lastFlush(ctx)).retractions_refused, 1)
  assert.equal(github.pullCount(), before)
  // An unknown route is a state change too: the stale entry goes, so nothing can keep a flush online.
  await fs.writeFile(path.join(desks[0], "_meta", "factory.json"), "{ not json")
  await offline(ctx, github)
  assert.equal((await lastFlush(ctx)).retractions_refused, undefined)
  // Routed back: a changed file for the session goes out.
  await reroute(desks[0], STORE)
  const changed = localFacts(1)
  changed.session.end_reason = "clear"
  assert.equal((await writeLocalFacts(ctx.env, STORE, changed)).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal((await lastFlush(ctx)).retractions_refused, undefined)
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a held away session is frozen: delivered, it is not deleted and an idle flush stays offline; retracting, its record stays", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await quarantine(ctx.env, STORE, nameOf(1), "invalid", { blob: "e".repeat(40) })
  await reroute(desks[0], OTHER)
  await offline(ctx, github)
  assert.equal((await lastFlush(ctx)).held_elsewhere, 1)
  // Session 2 is retracted and then held after the delete merged.
  await reroute(desks[1], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  await quarantine(ctx.env, STORE, nameOf(2), "invalid", { blob: "e".repeat(40) })
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [nameOf(2)])
  assert.equal((await lastFlush(ctx)).held_elsewhere, 2)
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a held session is never released to a store it routes away from; junk records are ignored", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  const root = await factoryStateRoot(ctx.env)
  const record = path.join(root, "delivered", "ourostack__factory.json")
  const blobs = JSON.parse(await fs.readFile(record, "utf8"))
  blobs["junk-name"] = "e".repeat(40)
  await fs.writeFile(record, JSON.stringify(blobs))
  // A legacy quarantine record names no blob, so a session routed here would be released and sent again.
  await quarantine(ctx.env, STORE, nameOf(2), "invalid")
  await reroute(desks[0], OTHER)
  await reroute(desks[1], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "0\n\nRetracted: 1 files (route_changed)")
  github.mergeOpenPr()
  github.dropBranch(STORE, await branchOf(ctx.env))
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`])
  assert.equal((await readDelivered(ctx.env, STORE)).quarantined.has(nameOf(2)), true)
}))

// ---------------------------------------------------------------------------
// The other cases kept from earlier rounds.
// ---------------------------------------------------------------------------

test("a route back with other deletes still pending rebuilds the branch without the delete it no longer needs", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  await reroute(desks[1], OTHER)
  await run(ctx.env, github)
  await reroute(desks[0], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "0\n\nRetracted: 1 files (route_changed)")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a store name that differs only in case is the same store: the file stays", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], "Ourostack/Factory")
  const before = github.pullCount()
  await offline(ctx, github)
  assert.equal(github.pullCount(), before)
  assert.equal(dataFiles(github).length, 1)
}))

test("a recorded path that holds another session's blob is never deleted", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "delivered-paths", "ourostack__factory.json")
  const record = JSON.parse(await fs.readFile(file, "utf8"))
  // Session 1's record is pointed at session 2's file, first with its own blob and then with no blob at all; the store holds session 2's blob there.
  const own = (await readDelivered(ctx.env, STORE)).blobs[nameOf(1)]
  record[nameOf(1)] = { path: `facts/${nameOf(2)}`, blob: own }
  await fs.writeFile(file, JSON.stringify(record))
  await reroute(desks[0], OTHER)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`, `facts/${nameOf(2)}`])
  // The mismatch ended session 1's delivered record; a bare-string record for it is never consulted again.
  assert.deepEqual(await names(ctx), [nameOf(2)])
}))

test("a bare-string path record pointing at another session's file is never deleted", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "delivered-paths", "ourostack__factory.json")
  const record = JSON.parse(await fs.readFile(file, "utf8"))
  record[nameOf(1)] = `facts/${nameOf(2)}`
  await fs.writeFile(file, JSON.stringify(record))
  await reroute(desks[0], OTHER)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`, `facts/${nameOf(2)}`])
}))

test("a session that routes back after its delete PR was closed unmerged, or its branch removed, is settled without a PR to close", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  await reroute(desks[1], OTHER)
  await run(ctx.env, github)
  // Someone closes the PR without merging; session 1 routes back. Session 2's delete is pushed again on a new PR.
  github.pulls.at(-1).state = "closed"
  await reroute(desks[0], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
  // The store removes the branch; session 1 retracts again and routes back once more.
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.pulls.at(-1).state = "closed"
  github.dropBranch(STORE, await branchOf(ctx.env))
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(await names(ctx), [nameOf(1)])
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

// ---------------------------------------------------------------------------
// Adjudicated follow-up: intake PRs under an earlier head, tombstones, desk roots, store_missing.
// ---------------------------------------------------------------------------

const openPrs = (github) => github.pulls.filter((pr) => pr.state === "open")

test("H1: a delete PR opened from the fork, then push permission, then a route back: the fork PR is closed by its number and main keeps the file", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { github: { push: false, fork: "ready" } })
  await reroute(desks[0], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  const forkPr = github.pulls.at(-1)
  assert.equal(forkPr.head.label, `contributor:${await branchOf(ctx.env)}`)
  assert.deepEqual((await lastFlush(ctx)).intake_prs, [{ number: forkPr.number, head: forkPr.head.label }])
  // The account is given push permission: the intake head is the store's own branch now, where the fork PR is invisible.
  github.setPush(true)
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(forkPr.state, "closed")
  assert.deepEqual(openPrs(github), [])
  const entry = await lastFlush(ctx)
  assert.equal(entry.intake_pushed, undefined)
  assert.equal(entry.intake_prs, undefined)
  assert.deepEqual(await names(ctx), [nameOf(1)])
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("H1: a delete PR open under one account, then the consent account changes and the session routes back: the old PR is closed and main keeps the file", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { github: { push: false, fork: "ready" } })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const oldPr = github.pulls.at(-1)
  // Another account, one with push permission, delivers for this store from now on.
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "maintainer" })
  github.setAccount("maintainer")
  github.setPush(true)
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(oldPr.state, "closed")
  assert.deepEqual(openPrs(github), [])
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
  // A later change goes under the new head, and only the new PR is recorded.
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  const pr = github.pulls.at(-1)
  assert.deepEqual((await lastFlush(ctx)).intake_prs, [{ number: pr.number, head: `ourostack:${await branchOf(ctx.env)}` }])
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`, `facts/${nameOf(9)}`])
}))

test("H1: a recorded PR under an earlier head that cannot be read or closed stays recorded and keeps the flush online until it is closed; a missing or closed one is dropped", () => scratch(async (ctx) => {
  let refuse = true
  const { github, desks } = await delivered(ctx, 1, {
    github: {
      push: false, fork: "ready",
      intercept: (call) => (refuse && call.args.includes("PATCH") && call.args.some((arg) => /^repos\/[^/]+\/[^/]+\/pulls\/\d+$/u.test(arg)) && !call.input?.includes("body") ? httpError(403, "Forbidden") : undefined),
    },
  })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const forkPr = github.pulls.at(-1)
  // Recorded beside it: a PR the store no longer has, a PR already closed, and one whose read fails.
  const closed = github.addClosedPr({ headLabel: `old:${await branchOf(ctx.env)}` })
  const entry = await lastFlush(ctx)
  await writeStatus(ctx.env, { last_flush: { [STORE]: { ...entry, intake_prs: [...entry.intake_prs, { number: 999, head: "gone:intake/x" }, { number: closed, head: `old:${await branchOf(ctx.env)}` }, { number: "junk" }] } } })
  github.setPush(true)
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(forkPr.state, "open")
  assert.deepEqual((await lastFlush(ctx)).intake_prs, [{ number: forkPr.number, head: forkPr.head.label }])
  assert.equal((await lastFlush(ctx)).intake_pushed, true)
  // The next flush goes online for it, and closes it once the store lets it.
  refuse = false
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(forkPr.state, "closed")
  assert.equal((await lastFlush(ctx)).intake_prs, undefined)
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("H1: a recorded PR whose read fails stays recorded", () => scratch(async (ctx) => {
  let fail = false
  const { github, desks } = await delivered(ctx, 1, {
    github: { push: false, fork: "ready", intercept: (call) => (fail && call.args.includes("GET") && call.args.some((arg) => /\/pulls\/\d+$/u.test(arg)) ? httpError(502, "Bad Gateway") : undefined) },
  })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const forkPr = github.pulls.at(-1)
  github.setPush(true)
  fail = true
  await reroute(desks[0], STORE)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual((await lastFlush(ctx)).intake_prs, [{ number: forkPr.number, head: forkPr.head.label }])
  fail = false
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(forkPr.state, "closed")
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("P1b: a finished retraction keeps a tombstone, so losing status.json after the marker is pruned never publishes the session again", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  const job = await keyedJob(ctx.env)
  const tombstones = JSON.parse(await fs.readFile(await retractingFile(ctx), "utf8"))
  assert.deepEqual(Object.keys(tombstones).sort(), [`labels/${LABELS.job}/${sessionId(1)}.json`, nameOf(1)].sort())
  assert.ok(Object.values(tombstones).every((record) => record.done === true))
  assert.equal(tombstones[nameOf(1)].path, `facts/${nameOf(1)}`)
  assert.deepEqual(await names(ctx, "retracting"), [])
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "markers", nameOf(1)))
  await fs.rm(path.join(root, "status.json"))
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(9)}`])
  assert.ok(!dataFiles(github).includes(`labels/${job}/${sessionId(1)}.json`))
  // A positive route back clears the tombstone, and the session publishes again.
  await marker(ctx.env, ctx.base, 1, desks[0])
  await reroute(desks[0], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(Object.keys(JSON.parse(await fs.readFile(await retractingFile(ctx), "utf8"))), [])
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`, `facts/${nameOf(9)}`, `labels/${job}/${sessionId(1)}.json`])
}))

// A retraction merged, the marker pruned, status.json lost; `lose` then takes away the tombstone's protection in one of two ways.
async function retractedAndLost(ctx, lose) {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  const root = await factoryStateRoot(ctx.env)
  await lose(root)
  await fs.rm(path.join(root, "markers", nameOf(1)))
  await fs.rm(path.join(root, "status.json"))
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  return github
}

test("C1: a tombstone past its retention is not pruned while a kept copy exists, so losing status.json afterwards never republishes the session", () => scratch(async (ctx) => {
  const github = await retractedAndLost(ctx, async () => {
    assert.equal(await pruneTombstones(ctx.env, { now: () => new Date(Date.now() + 200 * 24 * 60 * 60 * 1000).toISOString() }), 0, "stamped now by the first sweep that sees it")
    assert.equal(await pruneTombstones(ctx.env, { now: () => new Date(Date.now() + 400 * 24 * 60 * 60 * 1000).toISOString() }), 0, "kept copies exist: nothing goes")
  })
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(9)}`])
  assert.equal(Object.keys(JSON.parse(await fs.readFile(await retractingFile(ctx), "utf8"))).length, 2, "both tombstones stay")
}))

test("C1: a kept copy with no record and no positive route fails closed: it stays away even with the tombstone gone and status.json lost", () => scratch(async (ctx) => {
  const github = await retractedAndLost(ctx, async () => { await fs.writeFile(await retractingFile(ctx), "{}") })
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(9)}`], "the retracted session is not published again")
  const kept = await keptSessions(ctx.env, STORE)
  assert.deepEqual(kept, [sessionId(1)], "its copies are still kept, not restored")
}))

test("P2c: a desk that reroutes after its sessions' markers were pruned retracts them, read from the desk root the receipt recorded", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  const receipt = (await readStatus(ctx.env)).derivations[nameOf(1)]
  assert.equal(receipt.desk_root, desks[0])
  const root = await factoryStateRoot(ctx.env)
  for (const n of [1, 2]) await fs.rm(path.join(root, "markers", nameOf(n)))
  // Still declaring the store: nothing moves. Desk 2 declares nothing any more, the default route, which says nothing new.
  await fs.rm(path.join(desks[1], "_meta", "factory.json"))
  await offline(ctx, github)
  await reroute(desks[0], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal((await readStatus(ctx.env)).derivations[nameOf(1)].route, OTHER)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`])
}))

test("P2: a marker pruned while its delete is open keeps retracting with a resolvable desk root, and is counted stalled without one", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  await reroute(desks[1], OTHER)
  await run(ctx.env, github)
  const open = github.pulls.at(-1)
  const root = await factoryStateRoot(ctx.env)
  for (const n of [1, 2]) await fs.rm(path.join(root, "markers", nameOf(n)))
  // Desk 2 is gone too: its root cannot be resolved, so its delete leaves the branch and its record stays, counted.
  await fs.rm(desks[1], { recursive: true })
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(open.state, "open")
  assert.deepEqual([...github.headFiles(STORE, await branchOf(ctx.env)).keys()], [`facts/${nameOf(2)}`])
  assert.equal((await lastFlush(ctx)).retraction_stalled, 1)
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [nameOf(2)])
  assert.equal((await lastFlush(ctx)).retraction_stalled, 1)
  await offline(ctx, github)
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`])
}))

test("Q1: store_missing clears intake_pushed, so an idle flush after it makes no call", () => scratch(async (ctx) => {
  let missing = false
  const { github } = await delivered(ctx, 1, { github: { intercept: (call) => (missing && call.args.includes(`repos/${STORE}`) ? httpError(404, "Not Found") : undefined) } })
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal((await lastFlush(ctx)).intake_pushed, true)
  // The session's file goes away locally, and the store answers 404.
  await fs.rm(await outboxFile(ctx, 9))
  missing = true
  assert.deepEqual(await run(ctx.env, github), { result: "store_missing" })
  const entry = await lastFlush(ctx)
  assert.equal(entry.intake_pushed, undefined)
  assert.equal(entry.intake_prs, undefined)
  await offline(ctx, github)
}))
