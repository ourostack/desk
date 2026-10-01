// Retraction: a file this machine delivered to a store is deleted from it, in the next intake pull request, when its
// session now routes to a different store. Every GitHub interaction goes through the in-memory model in `_fake_github.js`;
// every fixture is synthetic, and the other store's name is a stand-in that must never reach the first store.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import {
  factoryStateRoot, quarantine, readConsent, readDelivered, readMachineSecret, readStatus, setConsent, writeLocalFacts, writeLocalLabels, writeMarker,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub } from "./_fake_github.js"
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
async function delivered({ base, env }, count, { labelled = [] } = {}) {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const desks = []
  for (let n = 1; n <= count; n += 1) {
    desks.push(await deskFor(base, `desk-${n}`, STORE))
    await marker(env, base, n, desks[n - 1])
    assert.equal((await writeLocalFacts(env, STORE, localFacts(n))).written, true)
  }
  for (const n of labelled) assert.equal((await writeLocalLabels(env, STORE, { ...structuredClone(LABELS), session: sessionId(n) })).written, true)
  const github = fakeGitHub()
  assert.equal((await run(env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  // The merged delivery is confirmed by the next flush, as any delivery is.
  assert.equal((await run(env, github)).result, "nothing_pending")
  return { github, desks }
}

const reroute = (desk, store) => fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
const dataFiles = (github) => [...github.mainFiles().keys()].sort()

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

test("a file whose session still routes to the store is never deleted", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2, { labelled: [1] })
  // One desk declares the store again, another reaches it by default with the overlay check its hook recorded.
  await fs.rm(path.join(desks[1], "_meta", "factory.json"))
  await marker(ctx.env, ctx.base, 2, desks[1], { routing: { store: STORE, source: "default", warnings: [] } })
  const before = github.pullCount()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.pullCount(), before)
  assert.equal(dataFiles(github).length, 3)
}))

test("a route that cannot be resolved keeps the file: no marker, no desk root, a bad declaration, a default with no recorded check", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 5)
  const root = await factoryStateRoot(ctx.env)
  // 1: no marker. 2: desk folder gone. 3: unreadable declaration. 4: default route without a recorded overlay check. 5: Codex-style default is covered separately.
  await fs.rm(path.join(root, "markers", nameOf(1)))
  await fs.rm(desks[1], { recursive: true })
  await fs.writeFile(path.join(desks[2], "_meta", "factory.json"), "{ not json")
  await fs.rm(path.join(desks[3], "_meta", "factory.json"))
  await reroute(desks[4], "not a store")
  const before = github.pullCount()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.pullCount(), before)
  assert.equal(dataFiles(github).length, 5)
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
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(dataFiles(github).length, 2)
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

test("an older delivered record with labels is retracted at the republished paths, and one whose local files are gone is kept", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 3, { labelled: [1] })
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "delivered-paths"), { recursive: true })
  // Session 3's local facts are gone, so nothing says where it was delivered.
  await fs.rm(path.join(root, "outbox", "ourostack__factory", nameOf(3)))
  for (const desk of desks) await reroute(desk, OTHER)
  // Session 2's desk folder is a plain file, which is not a desk.
  await fs.rm(desks[1], { recursive: true })
  await fs.writeFile(desks[1], "not a folder")
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "0\n\nRetracted: 2 files (route_changed)")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(2)}`, `facts/${nameOf(3)}`])
}))

test("the PR names neither the other store nor a session, and its branch and commit stay as they were", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  const pr = github.pulls.at(-1)
  const branch = await branchOf(ctx.env)
  const commit = github.commit(github.ref(STORE, branch))
  const status = await fs.readFile(path.join(await factoryStateRoot(ctx.env), "status.json"), "utf8")
  assert.doesNotMatch(status, /ms-desk-factory|shared-internal-tools/u)
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

const names = async (ctx, which = "blobs") => Object.keys((await readDelivered(ctx.env, STORE))[which]).sort()
const retractingFile = async (ctx) => path.join(await factoryStateRoot(ctx.env), "retracting", "ourostack__factory.json")

test("a pushed delete moves the session from delivered to retracting, is retried while open, and is done once the store no longer has the file", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1, { labelled: [1] })
  const root = await factoryStateRoot(ctx.env)
  const both = [`labels/${LABELS.job}/${sessionId(1)}.json`, nameOf(1)].sort()
  await reroute(desks[0], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  const open = github.pulls.at(-1).number
  assert.deepEqual(await names(ctx), [])
  assert.deepEqual(await names(ctx, "paths"), [])
  assert.deepEqual(await names(ctx, "retracting"), both)
  // The local files stay, so the session can publish again if it routes back.
  assert.equal((await fs.stat(path.join(root, "outbox", "ourostack__factory", nameOf(1)))).isFile(), true)
  // Still open: the next flush deletes again on the same PR and keeps the state.
  assert.equal((await run(ctx.env, github)).pr.number, open)
  assert.equal(github.pullCount(), 2)
  assert.deepEqual(await names(ctx, "retracting"), both)
  github.mergeOpenPr()
  // Merged and still routed elsewhere: done. The state and the local files go, and nothing more is pushed.
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx, "retracting"), [])
  await assert.rejects(fs.stat(path.join(root, "outbox", "ourostack__factory", nameOf(1))))
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.pullCount(), 2)
  assert.deepEqual(dataFiles(github), [])
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

test("delete pushed and still open, then the session routes back: the branch is rebuilt without the delete and main keeps the file", () => scratch(async (ctx) => {
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

test("a crash between the delivered and retracting writes leaves a safe state, in either order", () => scratch(async (ctx) => {
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
}))

test("a delete the store refuses returns the session to delivered and is counted", () => scratch(async (ctx) => {
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
  assert.equal((await readStatus(ctx.env)).last_flush[STORE].retractions_refused, 1)
  const before = github.pullCount()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.pullCount(), before)
}))

test("a held session is not in the delete set: while retracting it keeps its record and nothing is pushed", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  await quarantine(ctx.env, STORE, nameOf(1), "invalid", { blob: "e".repeat(40) })
  const before = github.pullCount()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.pullCount(), before)
  assert.deepEqual(await names(ctx, "retracting"), [nameOf(1)])
  assert.equal((await readStatus(ctx.env)).last_flush[STORE].held_elsewhere, 1)
}))

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

test("after a retraction merges, routing back publishes the session again as new", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(dataFiles(github), [])
  await reroute(desks[0], STORE)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`])
}))

test("a store name that differs only in case is the same store: the file stays", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], STORE.toUpperCase().replace("OUROSTACK/FACTORY", "Ourostack/Factory"))
  const before = github.pullCount()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
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
  record[nameOf(1)] = `facts/${nameOf(2)}`
  await fs.writeFile(file, JSON.stringify(record))
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`, `facts/${nameOf(2)}`])
}))

test("a refused delete is counted in status, not quarantined, not retried, and publishable again when the session routes back", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  await reroute(desks[0], OTHER)
  github.addClosedPr({ comment: "factory-rejected: removal", fileNames: [nameOf(1)], headLabel: `ourostack:${await branchOf(ctx.env)}` })
  const before = github.pullCount()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  const entry = async () => (await readStatus(ctx.env)).last_flush[STORE]
  assert.equal((await entry()).retractions_refused, 1)
  assert.deepEqual((await readDelivered(ctx.env, STORE)).quarantined.size, 0)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal((await entry()).retractions_refused, 1)
  assert.equal(github.pullCount(), before)
  // Routed back: forgotten, and a changed file for the session goes out.
  await reroute(desks[0], STORE)
  const changed = localFacts(1)
  changed.session.end_reason = "clear"
  assert.equal((await writeLocalFacts(ctx.env, STORE, changed)).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal((await entry()).retractions_refused, undefined)
}))

test("junk and quarantined records are ignored; a store that deletes its branch after the merge does not stop the status from clearing", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  const root = await factoryStateRoot(ctx.env)
  const record = path.join(root, "delivered", "ourostack__factory.json")
  const blobs = JSON.parse(await fs.readFile(record, "utf8"))
  blobs["junk-name"] = "e".repeat(40)
  await fs.writeFile(record, JSON.stringify(blobs))
  await quarantine(ctx.env, STORE, nameOf(2), "invalid")
  await reroute(desks[0], OTHER)
  await reroute(desks[1], OTHER)
  // The quarantined session's file is neither deleted nor published in this flush.
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pulls.at(-1).body, "0\n\nRetracted: 1 files (route_changed)")
  github.mergeOpenPr()
  github.dropBranch(STORE, await branchOf(ctx.env))
  // Its quarantine record named no blob, so the flush released it; it retracts now.
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  github.dropBranch(STORE, await branchOf(ctx.env))
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal((await readStatus(ctx.env)).last_flush[STORE].retractions_pushed, undefined)
  assert.deepEqual(dataFiles(github), [])
}))

test("the other crash order, delivered dropped and retracting never written, ends with a redundant republish and then the retraction", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 1)
  const root = await factoryStateRoot(ctx.env)
  await fs.rm(path.join(root, "delivered"), { recursive: true })
  await fs.rm(path.join(root, "delivered-paths"), { recursive: true })
  await reroute(desks[0], OTHER)
  // The file is on the store with the same blob: it is recorded as delivered again, and nothing is lost.
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await names(ctx), [nameOf(1)])
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(dataFiles(github), [])
}))

test("a session that routes back after its delete PR was closed unmerged, or its branch removed, is settled without a PR to close", () => scratch(async (ctx) => {
  const { github, desks } = await delivered(ctx, 2)
  await reroute(desks[0], OTHER)
  await reroute(desks[1], OTHER)
  await run(ctx.env, github)
  // Someone closes the PR without merging; session 1 routes back.
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
  await run(ctx.env, github)
  // Session 2's delete had merged with the first PR, so it is done; session 1 is delivered again.
  assert.deepEqual(await names(ctx, "retracting"), [])
  assert.deepEqual(dataFiles(github), [`facts/${nameOf(1)}`].filter(() => github.mainFiles().has(`facts/${nameOf(1)}`)))
}))
