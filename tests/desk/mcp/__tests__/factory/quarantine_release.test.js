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
  factoryStateRoot, quarantine, readConsent, readMachineSecret, releaseRefusedPluginNames, setConsent, writeLocalFacts, writeLocalLabels,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub } from "./_fake_github.js"
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
  await quarantine(env, STORE, nameOf(2), "date")
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  const branch = `intake/${(await readConsent(env)).stores[STORE].intake_id}`
  const files = [...github.headFiles(STORE, branch).keys()].sort()
  assert.deepEqual(files, [`facts/${nameOf(1)}`, `labels/${await keyed(env)}/${sessionId(1)}.json`])
  const facts = JSON.parse(github.blobs.get(github.headFiles(STORE, branch).get(`facts/${nameOf(1)}`)))
  assert.equal(Object.hasOwn(facts.refs.private, "plugins"), true)
  assert.equal(await record(env, nameOf(1)), null)
  assert.equal((await record(env, nameOf(2))).reason, "date")
}))
