// Version skew between Desk processes. Several Desks of different versions share one state folder. The kept local copy of a retracted session
// lives in `retracted-copies/`, out of the outbox an older Desk's flush lists; a file a newer Desk wrote, with keys this Desk does not know, is
// skipped and counted, never quarantined.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import {
  factoryStateRoot, keepRetractedCopies, keptSessions, pendingFiles, pendingLabels, readDelivered, readStatus, restoreRetractedCopies, setConsent, writeLocalFacts, writeLocalLabels, writeMarker,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { factoryLocalStatus } from "../../../../../plugins/desk/mcp/src/factory/local-status.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"
import { isWindows } from "../_platform.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
const OTHER = "shared-internal-tools/ms-desk-factory"
const SLUG = "ourostack__factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n) => `claude-code-${sessionId(n)}.json`

function localFacts(n) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.session.host = "claude-code"
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  return value
}

const run = (env, github) => flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })
const reroute = (desk, store) => fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
const lastFlush = async (ctx) => (await readStatus(ctx.env)).last_flush[STORE]
const exists = (file) => fs.stat(file).then(() => true, () => false)
// What an older Desk's flush sees: a plain listing of the store's outbox folder.
const olderListing = async (ctx) => (await fs.readdir(path.join(await factoryStateRoot(ctx.env), "outbox", SLUG))).sort()

async function deliver(ctx, count) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desks = []
  for (let n = 1; n <= count; n += 1) {
    const desk = path.join(ctx.base, `desk-${n}`)
    await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
    await reroute(desk, STORE)
    desks.push(desk)
    const log = path.join(ctx.base, `log-${n}.jsonl`)
    await fs.writeFile(log, "{}\n")
    await writeMarker(ctx.env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: ctx.base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString() })
    assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
    assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(n) })).written, true)
  }
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal((await run(ctx.env, github)).result, "nothing_pending")
  return { github, desks }
}

test("a pushed delete moves the local copies to retracted-copies, so an older Desk's outbox listing finds nothing; a route back restores and publishes", () => scratch(async (ctx) => {
  const { github, desks } = await deliver(ctx, 2)
  const root = await factoryStateRoot(ctx.env)
  await reroute(desks[0], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.deepEqual(await olderListing(ctx), [nameOf(2)])
  const kept = path.join(root, "retracted-copies", SLUG)
  assert.equal(await exists(path.join(kept, nameOf(1))), true)
  assert.equal(await exists(path.join(kept, "labels", LABELS.job, `${sessionId(1)}.json`)), true)
  assert.equal(await exists(path.join(root, "labels", SLUG, LABELS.job, `${sessionId(1)}.json`)), false)
  if (!isWindows) assert.equal(((await fs.stat(path.join(kept, nameOf(1)))).mode & 0o777), 0o600)
  // The older Desk's own listing, with nothing delivered for it, publishes nothing of the retracted session.
  assert.deepEqual((await pendingFiles(ctx.env, STORE, { publishedBytesFor: () => Buffer.from("x") })).map(({ name }) => name), [nameOf(2)])
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(await exists(path.join(kept, nameOf(1))), true)
  // The kept copy is what the local status reports as a route change.
  const status = factoryLocalStatus({ env: ctx.env, deskRoot: desks[1] }).stores.find((entry) => entry.store === STORE)
  assert.equal(status.route_changed, 1)
  // The route comes back: the copies return before they publish.
  await reroute(desks[0], STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.deepEqual(await olderListing(ctx), [nameOf(1), nameOf(2)])
  assert.equal(await exists(path.join(kept, nameOf(1))), false)
  assert.equal(await exists(path.join(root, "labels", SLUG, LABELS.job, `${sessionId(1)}.json`)), true)
  github.mergeOpenPr()
  assert.ok([...github.mainFiles().keys()].includes(`facts/${nameOf(1)}`))
  assert.deepEqual(Object.keys((await readDelivered(ctx.env, STORE)).retracting), [])
}))

test("the flush migrates a retracting session's copy left in the outbox, and adopts a file already in retracted-copies", () => scratch(async (ctx) => {
  const { github, desks } = await deliver(ctx, 3)
  const root = await factoryStateRoot(ctx.env)
  const kept = path.join(root, "retracted-copies", SLUG)
  await reroute(desks[0], OTHER)
  await reroute(desks[1], OTHER)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  // An older Desk or a person put copies back in the outbox, and a hand-moved file sits flat in retracted-copies with a loose mode.
  await fs.copyFile(path.join(kept, nameOf(1)), path.join(root, "outbox", SLUG, nameOf(1)))
  await fs.chmod(path.join(root, "outbox", SLUG, nameOf(1)), 0o600)
  await fs.writeFile(path.join(kept, nameOf(2)), await fs.readFile(path.join(kept, nameOf(2))), { mode: 0o644 })
  await fs.chmod(path.join(kept, nameOf(2)), 0o644)
  // Session 2's outbox copy differs from the kept one: both survive.
  const changed = localFacts(2)
  changed.session.end_reason = "clear"
  await fs.writeFile(path.join(root, "outbox", SLUG, nameOf(2)), `${JSON.stringify(changed)}\n`, { mode: 0o600 })
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await olderListing(ctx), [nameOf(3)])
  if (!isWindows) assert.equal(((await fs.stat(path.join(kept, nameOf(2)))).mode & 0o777), 0o600)
  assert.deepEqual((await fs.readdir(kept)).filter((name) => name.startsWith(nameOf(2))).length, 2)
  assert.equal(await exists(path.join(kept, nameOf(1))), true)
  // A folder under labels that is not a job is ignored on both sides.
  await fs.mkdir(path.join(root, "labels", SLUG, "not-a-job"), { recursive: true })
  await fs.mkdir(path.join(kept, "labels", "not-a-job"), { recursive: true })
  assert.deepEqual(await keptSessions(ctx.env, STORE), [sessionId(1), sessionId(2)])
  // Idempotent.
  assert.deepEqual(await keepRetractedCopies(ctx.env, STORE, [sessionId(1), sessionId(2)]), [])
  // A restore never overwrites a file that is already there, and moves nothing for a session with no copy. The kept copy the live one beat is
  // retired beside itself, never deleted, so the session no longer reads as kept.
  await fs.writeFile(path.join(root, "outbox", SLUG, nameOf(1)), `${JSON.stringify(localFacts(1))}\n`, { mode: 0o600 })
  assert.deepEqual(await restoreRetractedCopies(ctx.env, STORE, [sessionId(1), sessionId(9)]), [`labels/${LABELS.job}/${sessionId(1)}.json`])
  assert.equal(await exists(path.join(kept, nameOf(1))), false)
  assert.equal(await exists(path.join(kept, `${nameOf(1)}.kept-1`)), true)
  assert.deepEqual(await keptSessions(ctx.env, STORE), [sessionId(2)])
}))

test("facts or labels with keys a newer Desk wrote are skipped and counted as newer_format, never quarantined; any other failure still is", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const root = await factoryStateRoot(ctx.env)
  const outbox = path.join(root, "outbox", SLUG)
  const writeFacts = (n, value) => fs.mkdir(outbox, { recursive: true, mode: 0o700 }).then(() => fs.writeFile(path.join(outbox, nameOf(n)), `${JSON.stringify(value)}\n`, { mode: 0o600 }))
  const desk = path.join(ctx.base, "desk")
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await reroute(desk, STORE)
  for (const n of [1, 2, 3, 4, 5]) {
    const log = path.join(ctx.base, `log-${n}.jsonl`)
    await fs.writeFile(log, "{}\n")
    await writeMarker(ctx.env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: ctx.base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString() })
  }
  const extra = localFacts(1)
  extra.session.at_ms = 5
  const nested = localFacts(2)
  nested.refs.prs = []
  nested.jobs[0].future_key = []
  const wrongType = localFacts(3)
  wrongType.session.end_reason = 7
  const mixed = localFacts(4)
  mixed.session.at_ms = 5
  mixed.session.end_reason = 7
  const future = { schema: "desk.factory.local/3", anything: true }
  await writeFacts(1, extra)
  await writeFacts(2, nested)
  await writeFacts(3, wrongType)
  await writeFacts(4, mixed)
  await writeFacts(5, future)
  await fs.mkdir(path.join(root, "labels", SLUG, LABELS.job), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(root, "labels", SLUG, LABELS.job, `${sessionId(1)}.json`), `${JSON.stringify({ ...structuredClone(LABELS), session: sessionId(1), extra_key: 1 })}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(root, "labels", SLUG, LABELS.job, `${sessionId(2)}.json`), `${JSON.stringify({ ...structuredClone(LABELS), session: sessionId(2), schema: "desk.factory.labels/9" })}\n`, { mode: 0o600 })
  await fs.writeFile(path.join(root, "labels", SLUG, LABELS.job, `${sessionId(3)}.json`), `${JSON.stringify([])}\n`, { mode: 0o600 })
  const skipped = []
  const found = await pendingFiles(ctx.env, STORE, { publishedBytesFor: () => Buffer.from("x"), onNewerFormat: (name) => skipped.push(name) })
  assert.deepEqual(found.map(({ name }) => name), [nameOf(3), nameOf(4)])
  assert.deepEqual(skipped.sort(), [nameOf(1), nameOf(2), nameOf(5)])
  const labelsSkipped = []
  await pendingLabels(ctx.env, STORE, { publishedBytesFor: () => Buffer.from("x"), onNewerFormat: (name) => labelsSkipped.push(name) })
  assert.deepEqual(labelsSkipped.sort(), [`labels/${LABELS.job}/${sessionId(1)}.json`, `labels/${LABELS.job}/${sessionId(2)}.json`])
  const github = fakeGitHub()
  const result = await run(ctx.env, github)
  assert.equal(result.result, "nothing_pending")
  const entry = await lastFlush(ctx)
  assert.equal(entry.newer_format, 5)
  const held = await fs.readdir(path.join(root, "quarantine", SLUG))
  assert.deepEqual(held.filter((name) => name !== "labels").sort(), [nameOf(3), nameOf(4)])
  for (const n of [1, 2, 5]) assert.equal(await exists(path.join(outbox, nameOf(n))), true)
}))

test("a session whose receipt records a newer binding version is skipped and counted", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = path.join(ctx.base, "desk")
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await reroute(desk, STORE)
  const log = path.join(ctx.base, "log.jsonl")
  await fs.writeFile(log, "{}\n")
  await writeMarker(ctx.env, { schema_version: 1, host: "claude-code", session_id: sessionId(1), log_path: log, cwd: ctx.base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString() })
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  const { writeStatus } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, marker: "x", binding_version: 999 } } })
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "nothing_pending")
  assert.equal((await lastFlush(ctx)).newer_format, 1)
  assert.equal(github.calls.length, 0)
}))
