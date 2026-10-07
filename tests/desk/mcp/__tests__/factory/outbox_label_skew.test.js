// Version skew on waste labels. An older Desk must never condemn a labels file only because a newer Desk wrote it, and a newer Desk judges again
// what an older one quarantined. Every fixture is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import {
  factoryStateRoot, outdatedLabelRecords, ownDeskVersion, pendingLabels, quarantine, readConsent, releaseOutdatedLabelQuarantines, setConsent, writeLocalFacts, writeMarker, writeStatus,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { LABEL_CHECK_CODES, validateLabels } from "../../../../../plugins/desk/mcp/src/factory/label-schema.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
const SLUG = "ourostack__factory"
const JOB = LABELS.job
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const keyOf = (n) => `labels/${JOB}/${sessionId(n)}.json`
const own = () => "3.2.0-alpha.215"
const older = "3.2.0-alpha.177"

const labelsFor = (n, patch = {}) => ({ ...structuredClone(LABELS), session: sessionId(n), ...patch })
// A labels file this Desk's gate rejects with a code other than `unknown_key` (an enum member it does not know).
const outOfRange = (n, writer) => {
  const value = labelsFor(n, { evaluator: { ...LABELS.evaluator, plugin_version: writer } })
  value.stretches[0].class = "future_class"
  return value
}
const recordFile = async (env, n) => path.join(await factoryStateRoot(env), "quarantine", SLUG, "labels", JOB, `${sessionId(n)}.json`)
const readRecord = async (env, n) => JSON.parse(await fs.readFile(await recordFile(env, n), "utf8"))
const exists = (file) => fs.stat(file).then(() => true, () => false)

// Written as the evaluator's own file, so a file this Desk's gate rejects can be put where an older Desk's flush would list it.
async function putLabels(env, n, value = labelsFor(n)) {
  const dir = path.join(await factoryStateRoot(env), "labels", SLUG, JOB)
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(dir, `${sessionId(n)}.json`), `${JSON.stringify(value)}\n`, { mode: 0o600 })
}

async function putOldRecord(env, n, record = { reason: "invalid", at: "2026-10-06T21:52:37.267Z" }) {
  const file = await recordFile(env, n)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.writeFile(file, `${JSON.stringify(record)}\n`, { mode: 0o600 })
}

test("a labels file written by a newer Desk that fails this Desk's gate is skipped as newer, not quarantined; the same defect from an older writer is not", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await putLabels(env, 1, outOfRange(1, "99.0.0"))
  await putLabels(env, 2, outOfRange(2, "1.0.0"))
  const skipped = []
  const found = await pendingLabels(env, STORE, { publishedBytesFor: () => Buffer.from("x"), onNewerFormat: (name) => skipped.push(name) })
  assert.deepEqual(skipped, [keyOf(1)])
  assert.deepEqual(found.map(({ name }) => name), [keyOf(2)])
}))

test("a file that is valid is never newer by its writer's version alone", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await putLabels(env, 1, labelsFor(1, { evaluator: { ...LABELS.evaluator, plugin_version: "99.0.0" } }))
  const skipped = []
  const found = await pendingLabels(env, STORE, { publishedBytesFor: () => Buffer.from("x"), onNewerFormat: (name) => skipped.push(name) })
  assert.deepEqual(skipped, [])
  assert.equal(found.length, 1)
}))

test("a quarantine record names the Desk that wrote it, unless that Desk cannot say", () => scratch(async ({ env }) => {
  const named = await quarantine(env, STORE, keyOf(1), "invalid")
  assert.equal(named.desk_version, ownDeskVersion())
  assert.match(named.desk_version, /^3\./u)
  const unnamed = await quarantine(env, STORE, keyOf(2), "invalid", { ownVersion: () => null })
  assert.equal(Object.hasOwn(unnamed, "desk_version"), false)
}))

test("ownDeskVersion reads the plugin version and says null for anything else", () => {
  assert.equal(ownDeskVersion(() => JSON.stringify({ version: "3.2.0-alpha.215" })), "3.2.0-alpha.215")
  assert.equal(ownDeskVersion(() => JSON.stringify({ version: "latest" })), null)
  assert.equal(ownDeskVersion(() => JSON.stringify({})), null)
  assert.equal(ownDeskVersion(() => { throw new Error("gone") }), null)
  assert.equal(ownDeskVersion(() => "not json"), null)
})

test("releasing outdated label quarantines judges only this Desk's own check codes from an older or unnamed Desk, and releases only files that publish now", () => scratch(async ({ env }) => {
  await assert.rejects(releaseOutdatedLabelQuarantines(env, STORE), /check/u)
  await assert.rejects(releaseOutdatedLabelQuarantines(env, STORE, {}), /check/u)
  assert.deepEqual(await releaseOutdatedLabelQuarantines(env, STORE, { check: () => true, ownVersion: () => null }), [])
  assert.deepEqual(await releaseOutdatedLabelQuarantines(env, STORE, { check: () => true, ownVersion: own }), [])
  const root = await factoryStateRoot(env)
  const calls = []
  const check = (labels, key) => { calls.push(key); return labels.stretches[0].class !== "future_class" }
  // 1: no Desk named (an old record). 2: an older Desk. 3: this Desk. 4: a newer Desk. 5: a store refusal (a blob). 6: held behind facts. 7: a malformed Desk name.
  // 8: the file still fails. 9: no local file. 10: a local file that is not JSON. 11: a file a newer Desk wrote. 12: a record that is not JSON. 13: a schema code.
  for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 11, 13]) await putLabels(env, n, n === 8 ? outOfRange(n, older) : n === 11 ? outOfRange(n, "99.0.0") : labelsFor(n))
  await putOldRecord(env, 1)
  await putOldRecord(env, 2, { reason: "invalid", desk_version: older, at: "2026-10-06T21:52:37.267Z" })
  await putOldRecord(env, 3, { reason: "invalid", desk_version: "3.2.0-alpha.215", at: "2026-10-06T21:52:37.267Z" })
  await putOldRecord(env, 4, { reason: "invalid", desk_version: "3.2.0-alpha.300", at: "2026-10-06T21:52:37.267Z" })
  await putOldRecord(env, 5, { reason: "invalid", blob: "a".repeat(40), at: "2026-10-06T21:52:37.267Z" })
  await putOldRecord(env, 6, { reason: "facts_quarantined", facts: `claude-code-${sessionId(6)}.json`, at: "2026-10-06T21:52:37.267Z" })
  await putOldRecord(env, 7, { reason: "invalid", desk_version: "garbage", at: "2026-10-06T21:52:37.267Z" })
  await putOldRecord(env, 8)
  await putOldRecord(env, 9)
  await putOldRecord(env, 10)
  await putOldRecord(env, 11)
  await putOldRecord(env, 13, { reason: "unknown_key", desk_version: older, at: "2026-10-06T21:52:37.267Z" })
  await fs.writeFile(await recordFile(env, 12), "not json", { mode: 0o600 })
  await fs.mkdir(path.join(root, "labels", SLUG, JOB), { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(root, "labels", SLUG, JOB, `${sessionId(10)}.json`), "not json", { mode: 0o600 })
  // A folder that is not a job and a file that is not a labels name are ignored.
  await fs.mkdir(path.join(root, "quarantine", SLUG, "labels", "not-a-job"), { recursive: true })
  await fs.writeFile(path.join(root, "quarantine", SLUG, "labels", JOB, "stray.txt"), "x")
  // A record with no Desk named, or a malformed name, cannot be told from an older Desk's decision: the same gate that would publish the file judges it. A valid name at or above this Desk's is left.
  assert.deepEqual(await releaseOutdatedLabelQuarantines(env, STORE, { check, ownVersion: own, sessions: new Set([1, 2, 7, 8].map(sessionId)) }), [keyOf(1), keyOf(2), keyOf(7)].sort())
  assert.equal(await exists(await recordFile(env, 13)), true, "a session outside the set keeps its record")
  assert.deepEqual(await releaseOutdatedLabelQuarantines(env, STORE, { check, ownVersion: own }), [keyOf(13)])
  assert.deepEqual([...new Set(calls)].sort(), [keyOf(1), keyOf(13), keyOf(2), keyOf(7), keyOf(8)].sort())
  for (const n of [1, 2, 7, 13]) assert.equal(await exists(await recordFile(env, n)), false)
  for (const n of [3, 4, 5, 6, 8, 9, 10, 11, 12]) assert.equal(await exists(await recordFile(env, n)), true, `record ${n} stays`)
}))

test("a record whose reason is not one of this Desk's own check codes is never released, with or without a blob, whatever else is true", () => scratch(async ({ env }) => {
  const reasons = ["evidence_unmatched", "plugin_not_public", "desk_not_private", "too_large", "labels_without_facts", "facts_quarantined", "private_plugins_missing", "date"]
  assert.equal(LABEL_CHECK_CODES.has("invalid"), true)
  for (const reason of reasons) assert.equal(LABEL_CHECK_CODES.has(reason), false, reason)
  let n = 0
  for (const reason of reasons) {
    n += 1
    await putLabels(env, n)
    await putOldRecord(env, n, { reason, at: "2026-10-06T21:52:37.267Z" })
    await putLabels(env, n + 20)
    await putOldRecord(env, n + 20, { reason, blob: "b".repeat(40), desk_version: older, at: "2026-10-06T21:52:37.267Z" })
  }
  assert.deepEqual(await releaseOutdatedLabelQuarantines(env, STORE, { check: () => true, ownVersion: own }), [])
  for (let k = 1; k <= n; k += 1) {
    assert.equal(await exists(await recordFile(env, k)), true, `reason ${k} stays`)
    assert.equal(await exists(await recordFile(env, k + 20)), true, `reason ${k} with a blob stays`)
  }
}))

test("a record the flush wrote for a store's refusal is never judged again, even with no blob and a check code", () => scratch(async ({ env }) => {
  await putLabels(env, 1)
  const written = await quarantine(env, STORE, keyOf(1), "unknown_key", { source: "store", ownVersion: () => older })
  assert.equal(written.source, "store")
  assert.equal(Object.hasOwn(await quarantine(env, STORE, keyOf(2), "invalid"), "source"), false)
  assert.deepEqual(await outdatedLabelRecords(env, STORE, { ownVersion: own }), [])
}))

test("every code the labels gate can give a file is one of the check codes, so a record of it can be judged again", () => {
  const breakers = [
    (v) => { v.stretches[0].class = "zzz" },
    (v) => { delete v.stretches[0].class },
    (v) => { v.extra = 1 },
    (v) => { v.stretches[0].start_ms = "x" },
    (v) => { v.stretches[0].evidence = [] },
    (v) => { v.stretches[1].start_ms = v.stretches[0].start_ms },
    (v) => { v.session = "nope" },
    (v) => { v.schema = "desk.factory.labels/9" },
  ]
  for (const breakIt of breakers) {
    const value = labelsFor(1)
    breakIt(value)
    const result = validateLabels(value)
    assert.equal(result.ok, false)
    for (const { code } of result.errors) assert.equal(LABEL_CHECK_CODES.has(code), true, code)
  }
})

test("a flush releases labels an older Desk quarantined as invalid and delivers them; one that still fails keeps its record", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(1)
  facts.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  const { name } = await writeLocalFacts(env, STORE, facts)
  await writeStatus(env, { derivations: { [name]: { store: STORE, checked_route: STORE } } })
  await putLabels(env, 1)
  await putOldRecord(env, 1)
  await putLabels(env, 2, outOfRange(2, older))
  await putOldRecord(env, 2)
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  assert.equal(await exists(await recordFile(env, 1)), false)
  assert.equal((await readRecord(env, 2)).reason, "invalid", "a file that still fails keeps its record")
  const files = [...github.headFiles(STORE, `intake/${(await readConsent(env)).stores[STORE].intake_id}`).keys()]
  assert.ok(files.some((file) => file.startsWith("labels/") && file.endsWith(`${sessionId(1)}.json`)))
  assert.equal(files.some((file) => file.endsWith(`${sessionId(2)}.json`)), false)
}))

// A session with a marker whose desk declares `store`, as a live session has: the flush places it by that route.
async function routedSession(ctx, n, store) {
  const desk = path.join(ctx.base, `desk-${n}`)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
  const log = path.join(ctx.base, `log-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(ctx.env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: ctx.base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString() })
}

test("a machine with nothing else pending still releases a label record an older Desk wrote, for a session routed here only", () => scratch(async (ctx) => {
  const { env } = ctx
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await routedSession(ctx, 1, STORE)
  await routedSession(ctx, 2, "shared-internal-tools/ms-desk-factory")
  await routedSession(ctx, 3, "not a store")
  for (const n of [1, 2, 3]) {
    await putLabels(env, n)
    await putOldRecord(env, n)
  }
  const github = fakeGitHub()
  await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })
  assert.equal(await exists(await recordFile(env, 1)), false, "routed here: released")
  assert.equal(await exists(await recordFile(env, 2)), true, "routed to another store: the record stays")
  assert.equal(await exists(await recordFile(env, 3)), true, "an invalid declaration freezes the session: the record stays")
}))

test("the outdated records are listed without changing anything", () => scratch(async ({ env }) => {
  await putLabels(env, 1)
  await putOldRecord(env, 1)
  await putOldRecord(env, 2, { reason: "date", at: "2026-10-06T21:52:37.267Z" })
  assert.deepEqual((await outdatedLabelRecords(env, STORE)).map(({ key, session }) => [key, session]), [[keyOf(1), sessionId(1)]])
  assert.deepEqual(await outdatedLabelRecords(env, STORE, { ownVersion: () => null }), [])
  assert.equal(await exists(await recordFile(env, 1)), true)
}))

test("ownDeskVersion without a reader is read once and kept", () => {
  assert.equal(ownDeskVersion(), ownDeskVersion())
  assert.match(ownDeskVersion(), /^3\./u)
})
