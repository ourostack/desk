// A store refuses facts from an older Desk that named every plugin with
// `private_plugins_missing`. That older Desk quarantined the files for good,
// but this Desk always writes `refs.private.plugins`, so it releases those
// records and sends the files again. Every GitHub interaction goes through
// the in-memory model in `_fake_github.js`; every fixture is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import {
  factoryStateRoot, quarantine, readConsent, readMachineSecret, releaseRefusedPluginNames, setConsent, writeLocalFacts, writeLocalLabels, writeStatus,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub, httpError } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
const JOB = LABELS.job
const SLUG = "ourostack__factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n) => `claude-code-${sessionId(n)}.json`
const keyOf = (n) => `labels/${JOB}/${sessionId(n)}.json`

async function put(env, n, { labels = true } = {}) {
  const facts = structuredClone(GOLDEN)
  facts.session.id = sessionId(n)
  facts.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  assert.equal((await writeLocalFacts(env, STORE, facts)).written, true)
  // The derivation receipt a sweep writes, so a held session is known to have been derived for this store.
  await writeStatus(env, { derivations: { [`claude-code-${sessionId(n)}.json`]: { store: STORE } } })
  if (labels) assert.equal((await writeLocalLabels(env, STORE, { ...structuredClone(LABELS), session: sessionId(n) })).written, true)
}

async function record(env, name) {
  const root = await factoryStateRoot(env)
  try {
    return JSON.parse(await fs.readFile(path.join(root, "quarantine", SLUG, name), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

async function keyed(env) {
  return createHmac("sha256", await readMachineSecret(env)).update(JOB).digest("hex").slice(0, 32)
}

test("releaseRefusedPluginNames lifts only the older client's refusal and the labels it held back", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.deepEqual(await releaseRefusedPluginNames(env, STORE), { facts: [], labels: [] })

  // Session 1: refused by the store for the missing field, facts and labels in one PR.
  await quarantine(env, STORE, nameOf(1), "private_plugins_missing")
  await quarantine(env, STORE, keyOf(1), "private_plugins_missing")
  // Session 2: facts refused for the missing field; labels held back behind them.
  await quarantine(env, STORE, nameOf(2), "private_plugins_missing")
  await quarantine(env, STORE, keyOf(2), "facts_quarantined", { facts: nameOf(2) })
  // Session 3: refused for another reason; its held labels stay too.
  await quarantine(env, STORE, nameOf(3), "evidence_unmatched")
  await quarantine(env, STORE, keyOf(3), "facts_quarantined", { facts: nameOf(3) })
  // Session 4: labels refused for another reason although their facts are released.
  await quarantine(env, STORE, nameOf(4), "private_plugins_missing")
  await quarantine(env, STORE, keyOf(4), "too_large")
  // A record that does not parse, or is not an object, is left alone.
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "quarantine", SLUG, nameOf(5)), "not json")
  await fs.writeFile(path.join(root, "quarantine", SLUG, nameOf(6)), `${JSON.stringify(["private_plugins_missing"])}\n`)

  assert.deepEqual(await releaseRefusedPluginNames(env, STORE), { facts: [nameOf(1), nameOf(2), nameOf(4)], labels: [keyOf(1), keyOf(2)] })
  for (const name of [nameOf(1), keyOf(1), nameOf(2), keyOf(2), nameOf(4)]) assert.equal(await record(env, name), null, name)
  assert.equal((await record(env, nameOf(3))).reason, "evidence_unmatched")
  assert.equal((await record(env, keyOf(3))).reason, "facts_quarantined")
  assert.equal((await record(env, keyOf(4))).reason, "too_large")
  assert.equal(await fs.readFile(path.join(root, "quarantine", SLUG, nameOf(5)), "utf8"), "not json")
  assert.deepEqual(await record(env, nameOf(6)), ["private_plugins_missing"])
  // A second call finds nothing left to release.
  assert.deepEqual(await releaseRefusedPluginNames(env, STORE), { facts: [], labels: [] })
}))

test("releaseRefusedPluginNames with a set of sessions lifts only those sessions' refusals", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  for (const n of [1, 2]) {
    await quarantine(env, STORE, nameOf(n), "private_plugins_missing")
    await quarantine(env, STORE, keyOf(n), "private_plugins_missing")
  }
  assert.deepEqual(await releaseRefusedPluginNames(env, STORE, { sessions: new Set([sessionId(2)]) }), { facts: [nameOf(2)], labels: [keyOf(2)] })
  assert.equal((await record(env, nameOf(1))).reason, "private_plugins_missing")
  assert.equal((await record(env, keyOf(1))).reason, "private_plugins_missing")
}))

test("releaseRefusedPluginNames never follows a symlink or reads outside the labels shape", () => scratch(async ({ base, env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await quarantine(env, STORE, nameOf(1), "evidence_unmatched")
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "quarantine", SLUG)
  const outside = path.join(base, "outside.json")
  await fs.writeFile(outside, `${JSON.stringify({ reason: "private_plugins_missing", at: "x" })}\n`)
  await fs.symlink(outside, path.join(dir, nameOf(2)))
  await fs.mkdir(path.join(dir, "labels", "not-a-job"), { recursive: true })
  await fs.writeFile(path.join(dir, "labels", "not-a-job", `${sessionId(3)}.json`), `${JSON.stringify({ reason: "private_plugins_missing" })}\n`)
  await fs.writeFile(path.join(dir, "labels", "stray-file"), "x")
  assert.deepEqual(await releaseRefusedPluginNames(env, STORE), { facts: [], labels: [] })
  assert.equal((await fs.lstat(path.join(dir, nameOf(2)))).isSymbolicLink(), true)
  assert.equal(JSON.parse(await fs.readFile(outside, "utf8")).reason, "private_plugins_missing")
  await assert.rejects(releaseRefusedPluginNames(env, "not a store"), /store/u)
}))

test("a flush sends again the facts and labels an older client quarantined for private_plugins_missing", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1)
  await put(env, 2, { labels: false })
  await quarantine(env, STORE, nameOf(1), "private_plugins_missing")
  await quarantine(env, STORE, keyOf(1), "private_plugins_missing")
  // Session 2's file publishes now and carries no refused blob, so it goes again too.
  await quarantine(env, STORE, nameOf(2), "date")
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  const branch = `intake/${(await readConsent(env)).stores[STORE].intake_id}`
  const files = [...github.headFiles(STORE, branch).keys()].sort()
  assert.deepEqual(files, [`facts/${nameOf(1)}`, `facts/${nameOf(2)}`, `labels/${await keyed(env)}/${sessionId(1)}.json`])
  const facts = JSON.parse(github.blobs.get(github.headFiles(STORE, branch).get(`facts/${nameOf(1)}`)))
  assert.equal(Object.hasOwn(facts.refs.private, "plugins"), true)
  assert.equal(await record(env, nameOf(1)), null)
  assert.equal(await record(env, nameOf(2)), null)
}))

test("quarantine records the refused blob sha when given", () => scratch(async ({ env }) => {
  const now = () => "2026-09-29T00:00:00.000Z"
  const blob = "a".repeat(40)
  assert.deepEqual(await quarantine(env, STORE, nameOf(1), "plugin_not_public", { blob, now }), { reason: "plugin_not_public", blob, at: now() })
  assert.deepEqual(await record(env, nameOf(1)), { reason: "plugin_not_public", blob, at: now() })
  await assert.rejects(quarantine(env, STORE, nameOf(2), "plugin_not_public", { blob: "nope", now }), /blob/u)
  assert.equal(await record(env, nameOf(2)), null)
}))

test("a store rejection quarantines each file with the blob the PR carried", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1, { labels: false })
  const github = fakeGitHub()
  const branch = `intake/${(await readConsent(env)).stores[STORE].intake_id}`
  github.addClosedPr({ comment: "factory-rejected: plugin_not_public", fileNames: [nameOf(1)], fileShas: { [nameOf(1)]: "b".repeat(40) }, headLabel: `ourostack:${branch}` })
  await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })
  const found = await record(env, nameOf(1))
  assert.equal(found.reason, "plugin_not_public")
  assert.equal(found.blob, "b".repeat(40))
}))

const flushOnce = (env, github) => flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })
const branchOf = async (env) => `intake/${(await readConsent(env)).stores[STORE].intake_id}`

test("a legacy quarantine record without blob is retried once the file publishes", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1, { labels: false })
  await quarantine(env, STORE, nameOf(1), "plugin_not_public")
  const github = fakeGitHub()
  const out = await flushOnce(env, github)
  assert.equal(out.result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, await branchOf(env)).keys()], [`facts/${nameOf(1)}`])
  assert.equal(await record(env, nameOf(1)), null)
}))

test("a quarantined file whose published blob equals the refused blob stays quarantined", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1, { labels: false })
  const first = fakeGitHub()
  assert.equal((await flushOnce(env, first)).result, "delivered_pr_open")
  const blob = first.headFiles(STORE, await branchOf(env)).get(`facts/${nameOf(1)}`)
  await quarantine(env, STORE, nameOf(1), "plugin_not_public", { blob })
  const before = await record(env, nameOf(1))
  const second = fakeGitHub()
  assert.equal((await flushOnce(env, second)).result, "nothing_pending")
  assert.deepEqual(await record(env, nameOf(1)), before)
  assert.equal(second.pullCount(), 0)
}))

test("a re-refused unchanged file is not sent a third time", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1, { labels: false })
  await quarantine(env, STORE, nameOf(1), "plugin_not_public")
  const github = fakeGitHub()
  assert.equal((await flushOnce(env, github)).result, "delivered_pr_open")
  const sent = github.headFiles(STORE, await branchOf(env)).get(`facts/${nameOf(1)}`)
  github.rejectOpenPr("factory-rejected: plugin_not_public")
  await flushOnce(env, github)
  assert.equal((await record(env, nameOf(1))).blob, sent)
  const prs = github.pullCount()
  assert.equal((await flushOnce(env, github)).result, "nothing_pending")
  assert.equal(github.pullCount(), prs)
  assert.equal((await record(env, nameOf(1))).reason, "plugin_not_public")
}))

test("labels held back behind released facts go with them", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 2)
  await quarantine(env, STORE, nameOf(2), "plugin_not_public")
  await quarantine(env, STORE, keyOf(2), "facts_quarantined", { facts: nameOf(2) })
  const github = fakeGitHub()
  assert.equal((await flushOnce(env, github)).result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, await branchOf(env)).keys()].sort(), [`facts/${nameOf(2)}`, `labels/${await keyed(env)}/${sessionId(2)}.json`])
  assert.equal(await record(env, nameOf(2)), null)
  assert.equal(await record(env, keyOf(2)), null)
}))

test("labels quarantined on their own are not candidates", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1)
  await quarantine(env, STORE, keyOf(1), "too_large")
  const github = fakeGitHub()
  await flushOnce(env, github)
  assert.equal((await record(env, keyOf(1))).reason, "too_large")
}))

test("an unparseable quarantine record keeps its file quarantined", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1, { labels: false })
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "quarantine", SLUG), { recursive: true })
  const file = path.join(root, "quarantine", SLUG, nameOf(1))
  await fs.writeFile(file, "{")
  const github = fakeGitHub()
  assert.equal((await flushOnce(env, github)).result, "nothing_pending")
  assert.equal(await fs.readFile(file, "utf8"), "{")
  assert.equal(github.pullCount(), 0)
}))

test("a quarantined file that no longer parses keeps its record and does not block the others", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await put(env, 1, { labels: false })
  await put(env, 2, { labels: false })
  await quarantine(env, STORE, nameOf(1), "plugin_not_public")
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "outbox", SLUG, nameOf(1)), "{")
  const file = path.join(root, "quarantine", SLUG, nameOf(1))
  const before = await fs.readFile(file)
  const github = fakeGitHub()
  assert.equal((await flushOnce(env, github)).result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, await branchOf(env)).keys()], [`facts/${nameOf(2)}`])
  assert.deepEqual(await fs.readFile(file), before)
}))

for (const status of [500, 422]) {
  test(`a held file whose repo cannot be resolved does not block pending files (${status})`, () => scratch(async ({ env }) => {
    await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
    await put(env, 1, { labels: false })
    await put(env, 2, { labels: false })
    // Session 1 is held and references a repository only it names.
    const held = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(env), "outbox", SLUG, nameOf(1)), "utf8"))
    held.refs = { prs: [{ repo: "acme/held-only", number: 1 }], commits: [], unresolved: { prs: 0, commits: 0 } }
    await fs.writeFile(path.join(await factoryStateRoot(env), "outbox", SLUG, nameOf(1)), `${JSON.stringify(held)}\n`)
    await quarantine(env, STORE, nameOf(1), "plugin_not_public")
    const file = path.join(await factoryStateRoot(env), "quarantine", SLUG, nameOf(1))
    const before = await fs.readFile(file)
    const github = fakeGitHub({ intercept: (call) => (call.args.some((arg) => /repos\/acme\/held-only$/u.test(arg)) ? httpError(status, "boom") : undefined) })
    const out = await flushOnce(env, github)
    assert.equal(out.result, "delivered_pr_open")
    assert.deepEqual([...github.headFiles(STORE, await branchOf(env)).keys()], [`facts/${nameOf(2)}`])
    assert.deepEqual(await fs.readFile(file), before)
  }))
}

// A quarantine record that is not a regular file keeps its file where it is; it must never stop an unrelated file from going.
const ODD_RECORDS = {
  symlink: async (file, base) => {
    const target = path.join(base, "elsewhere.json")
    await fs.writeFile(target, JSON.stringify({ reason: "plugin_not_public", at: "2026-09-29T00:00:00.000Z" }))
    await fs.symlink(target, file)
  },
  directory: async (file) => fs.mkdir(file),
  "hard-linked file": async (file, base) => {
    const target = path.join(base, "elsewhere.json")
    await fs.writeFile(target, JSON.stringify({ reason: "plugin_not_public", at: "2026-09-29T00:00:00.000Z" }))
    await fs.link(target, file)
  },
}
for (const [kind, make] of Object.entries(ODD_RECORDS)) {
  test(`a ${kind} quarantine record never blocks an unrelated pending file`, () => scratch(async ({ base, env }) => {
    await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
    await put(env, 1, { labels: false })
    await put(env, 2, { labels: false })
    const root = await factoryStateRoot(env)
    await fs.mkdir(path.join(root, "quarantine", SLUG), { recursive: true })
    const file = path.join(root, "quarantine", SLUG, nameOf(1))
    await make(file, base)
    const before = await fs.lstat(file)
    const github = fakeGitHub()
    const out = await flushOnce(env, github)
    assert.equal(out.result, "delivered_pr_open")
    assert.deepEqual([...github.headFiles(STORE, await branchOf(env)).keys()], [`facts/${nameOf(2)}`])
    const after = await fs.lstat(file)
    assert.equal(after.ino, before.ino)
    assert.equal(after.isSymbolicLink(), before.isSymbolicLink())
    assert.equal(after.isDirectory(), before.isDirectory())
  }))
}

// Counts the state-root checks (`factoryStateRoot` resolves the state folder's real path once per call) a flush makes.
async function stateRootChecks(held) {
  return scratch(async ({ env }) => {
    await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
    for (let n = 1; n <= held; n += 1) {
      await put(env, n, { labels: false })
      await quarantine(env, STORE, nameOf(n), "plugin_not_public")
    }
    const github = fakeGitHub()
    assert.equal((await flushOnce(env, github)).result, "delivered_pr_open")
    github.rejectOpenPr("factory-rejected: plugin_not_public")
    await flushOnce(env, github)
    for (let n = 1; n <= held; n += 1) assert.equal(typeof (await record(env, nameOf(n))).blob, "string")
    const prs = github.pullCount()
    const original = fs.realpath
    let checks = 0
    fs.realpath = async (...args) => {
      checks += 1
      return original(...args)
    }
    try {
      assert.equal((await flushOnce(env, github)).result, "nothing_pending")
    } finally {
      fs.realpath = original
    }
    assert.equal(github.pullCount(), prs)
    return checks
  })
}

test("held files that have not changed cost no state-root check each", async () => {
  const one = await stateRootChecks(1)
  const many = await stateRootChecks(6)
  assert.ok(one > 0)
  assert.equal(many, one)
})

test("a held file is released with every other in one release, and its labels go with it", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  for (const n of [1, 2, 3]) {
    await put(env, n)
    await quarantine(env, STORE, nameOf(n), "plugin_not_public")
    await quarantine(env, STORE, keyOf(n), "facts_quarantined", { facts: nameOf(n) })
  }
  const github = fakeGitHub()
  assert.equal((await flushOnce(env, github)).result, "delivered_pr_open")
  assert.equal([...github.headFiles(STORE, await branchOf(env)).keys()].length, 6)
  for (const n of [1, 2, 3]) {
    assert.equal(await record(env, nameOf(n)), null)
    assert.equal(await record(env, keyOf(n)), null)
  }
}))

for (const [code, spec] of [
  ["rate_limited", { intercept: (call) => (call.args.some((arg) => /repos\/acme\/held-only$/u.test(arg)) ? httpError(429, "Too Many Requests") : undefined) }],
]) {
  test(`a held file's lookup that ends the flush (${code}) still ends it and keeps the record`, () => scratch(async ({ env }) => {
    await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
    await put(env, 1, { labels: false })
    const name = path.join(await factoryStateRoot(env), "outbox", SLUG, nameOf(1))
    const held = JSON.parse(await fs.readFile(name, "utf8"))
    held.refs = { prs: [{ repo: "acme/held-only", number: 1 }], commits: [], unresolved: { prs: 0, commits: 0 } }
    await fs.writeFile(name, `${JSON.stringify(held)}\n`)
    await quarantine(env, STORE, nameOf(1), "plugin_not_public")
    const file = path.join(await factoryStateRoot(env), "quarantine", SLUG, nameOf(1))
    const before = await fs.readFile(file)
    const github = fakeGitHub(spec)
    assert.equal((await flushOnce(env, github)).result, code)
    assert.deepEqual(await fs.readFile(file), before)
  }))
}
