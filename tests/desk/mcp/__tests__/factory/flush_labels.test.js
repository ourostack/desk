// Delivery of waste labels: accepted local labels travel in the same intake
// pull request as facts, keyed as their facts are, under the same stale-retry
// and quarantine rules. Every GitHub interaction goes through the in-memory
// model in `_fake_github.js`; every fixture is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { toPublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { checkLabelsAgainstFacts, validateLabelsBytes } from "../../../../../plugins/desk/mcp/src/factory/label-schema.js"
import {
  factoryStateRoot, gitBlobSha, holdLabels, quarantine, readConsent, readMachineSecret, setConsent, writeLocalFacts, writeLocalLabels, writeMarker,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { validatePublishedBytes } from "../../../../../plugins/desk/mcp/src/factory/published-schema.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, routeTo, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
const ACCOUNT = "contributor"
const JOB = LABELS.job
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n) => `claude-code-${sessionId(n)}.json`
const keyOf = (n) => `labels/${JOB}/${sessionId(n)}.json`

function localFacts(n) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  return value
}

function localLabels(n) {
  return { ...structuredClone(LABELS), session: sessionId(n) }
}

async function setup(env) {
  await setConsent(env, { store: STORE, contribute: true, account: ACCOUNT })
}

async function putFacts(env, n) {
  await routeTo(env, sessionId(n))
  assert.equal((await writeLocalFacts(env, STORE, localFacts(n))).written, true)
}

async function putLabels(env, n, value = localLabels(n)) {
  await routeTo(env, value.session)
  assert.equal((await writeLocalLabels(env, STORE, value)).written, true)
}

async function branch(env) {
  return `intake/${(await readConsent(env)).stores[STORE].intake_id}`
}

async function keyed(env, job = JOB) {
  return createHmac("sha256", await readMachineSecret(env)).update(job).digest("hex").slice(0, 32)
}

async function delivered(env) {
  const root = await factoryStateRoot(env)
  try {
    return JSON.parse(await fs.readFile(path.join(root, "delivered", "ourostack__factory.json"), "utf8"))
  } catch {
    return {}
  }
}

test("labels go in the same intake PR as their facts, keyed as the facts are, and pass the store's gate against them", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  await putLabels(env, 1)
  const github = fakeGitHub()
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "delivered_pr_open", pr: { number: 101, url: `https://github.com/${STORE}/pull/101` } })
  assert.equal(github.pulls[0].body, "2")
  const job = await keyed(env)
  const files = github.headFiles(STORE, await branch(env))
  const factsBytes = Buffer.from(github.blobs.get(files.get(`facts/${nameOf(1)}`)))
  const labelsBytes = Buffer.from(github.blobs.get(files.get(`labels/${job}/${sessionId(1)}.json`)))
  assert.deepEqual(validatePublishedBytes(factsBytes), { ok: true, errors: [] })
  assert.deepEqual(validateLabelsBytes(labelsBytes), { ok: true, errors: [] })
  const labels = JSON.parse(labelsBytes.toString("utf8"))
  assert.equal(labels.job, job)
  assert.deepEqual(checkLabelsAgainstFacts(labels, JSON.parse(factsBytes.toString("utf8"))), { ok: true, errors: [] })

  // Once merged, both are delivered and nothing is pending.
  github.mergeOpenPr()
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "nothing_pending" })
  const record = await delivered(env)
  assert.equal(record[keyOf(1)], gitBlobSha(labelsBytes))
  assert.equal(record[nameOf(1)], gitBlobSha(factsBytes))
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "nothing_pending" })
}))

test("a private desk's labels keep their plain job, as its facts do", () => scratch(async ({ base, env }) => {
  await setup(env)
  const desk = path.join(base, "private-desk")
  await fs.mkdir(desk)
  execFileSync("git", ["init", "-q", desk])
  execFileSync("git", ["-C", desk, "remote", "add", "origin", "https://github.com/acme/private-desk.git"])
  const log = path.join(base, "log-1.jsonl")
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(1), log_path: log, cwd: desk, desk_root: await fs.realpath(desk), routing: { store: STORE, source: "default", warnings: [] }, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
  await putFacts(env, 1)
  await putLabels(env, 1)
  const github = fakeGitHub({ visibility: { "acme/private-desk": "private" } })
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  const files = github.headFiles(STORE, await branch(env))
  assert.ok(files.has(`labels/${JOB}/${sessionId(1)}.json`))
  assert.ok(JSON.parse(github.blobs.get(files.get(`facts/${nameOf(1)}`))).jobs.some((job) => job.job === JOB))
}))

test("labels wait for their facts: they go with them, after them, or not at all", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  await putLabels(env, 1)
  const other = "5e6f708192a3b4c5d6e7f8091a2b3c4d"
  await putLabels(env, 2, { ...localLabels(2), job: other })
  const github = fakeGitHub()
  // A one-file batch takes the facts; their labels and the labels without facts wait.
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup, maxFiles: 1 })).result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, await branch(env)).keys()], [`facts/${nameOf(1)}`])
  github.mergeOpenPr()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  const job = await keyed(env)
  assert.deepEqual([...github.headFiles(STORE, await branch(env)).keys()].sort(), [`facts/${nameOf(1)}`, `labels/${job}/${sessionId(1)}.json`])
  github.mergeOpenPr()
  // Labels whose session never had facts stay local and are never sent alone.
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "nothing_pending" })
  assert.equal(Object.hasOwn(await delivered(env), `labels/${other}/${sessionId(2)}.json`), false)
}))

test("a rejected intake PR quarantines its labels with its facts; a stale one sends them again", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  await putLabels(env, 1)
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  const all = [`facts/${nameOf(1)}`, `labels/${await keyed(env)}/${sessionId(1)}.json`]
  github.rejectOpenPr("factory-rejected: merge_conflict")
  const retried = await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })
  assert.equal(retried.result, "intake_stale_retried")
  assert.deepEqual([...github.headFiles(STORE, await branch(env)).keys()].sort(), all)

  github.rejectOpenPr("factory-rejected: evidence_unmatched")
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "nothing_pending" })
  const root = await factoryStateRoot(env)
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", nameOf(1)), "utf8")).reason, "evidence_unmatched")
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", keyOf(1)), "utf8")).reason, "evidence_unmatched")
}))

test("labels the transform or the gate refuses are quarantined and never sent", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  await putFacts(env, 3)
  const root = await factoryStateRoot(env)
  // A labels file filed under another job than it names.
  const misfiled = path.join(root, "labels", "ourostack__factory", "c0ffee00c0ffee00c0ffee00c0ffee00", `${sessionId(1)}.json`)
  await fs.mkdir(path.dirname(misfiled), { recursive: true })
  await fs.writeFile(misfiled, `${JSON.stringify(localLabels(1))}\n`)
  // A labels file whose content no longer passes the labels schema.
  const broken = path.join(root, "labels", "ourostack__factory", JOB, `${sessionId(1)}.json`)
  await fs.mkdir(path.dirname(broken), { recursive: true })
  await fs.writeFile(broken, `${JSON.stringify({ ...localLabels(1), unavailable: ["SENTINEL"] })}\n`)
  // Labels valid in shape but too large for the store: 10,000 stretches of 100 evidence ranges each.
  const huge = localLabels(3)
  huge.stretches = Array.from({ length: 10000 }, (_, index) => ({
    start_ms: index * 10, end_ms: index * 10 + 10, class: "value", waste: null, mura: false, muri: false,
    evidence: Array.from({ length: 100 }, (__, range) => [1000000000 + range, 1000000001 + range]),
  }))
  await putLabels(env, 3, huge)
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, await branch(env)).keys()].sort(), [`facts/${nameOf(1)}`, `facts/${nameOf(3)}`])
  const reason = async (key) => JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", key), "utf8")).reason
  assert.equal(await reason(`labels/c0ffee00c0ffee00c0ffee00c0ffee00/${sessionId(1)}.json`), "invalid")
  assert.equal(await reason(keyOf(3)), "too_large")
  assert.equal(await reason(keyOf(1)), "invalid")
}))

test("labels alone, with nothing else pending, open an intake PR", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  github.mergeOpenPr()
  await putLabels(env, 1)
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  assert.deepEqual([...github.headFiles(STORE, await branch(env)).keys()].filter((name) => name.startsWith("labels/")), [`labels/${await keyed(env)}/${sessionId(1)}.json`])
  assert.equal(github.pulls.at(-1).body, "1")
}))

test("quarantine accepts a labels key and refuses anything else", () => scratch(async ({ env }) => {
  await setup(env)
  assert.equal((await quarantine(env, STORE, keyOf(1), "invalid")).reason, "invalid")
  await assert.rejects(quarantine(env, STORE, `labels/${JOB}/../x.json`, "invalid"), /name/u)
  await assert.rejects(quarantine(env, STORE, undefined, "invalid"), /name/u)
  assert.equal(existsSync(path.join(await factoryStateRoot(env), "quarantine", "ourostack__factory", keyOf(1))), true)
}))

test("labels whose facts were quarantined by an earlier flush are quarantined too, naming the facts, instead of waiting forever", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })).result, "delivered_pr_open")
  github.rejectOpenPr("factory-rejected: evidence_unmatched")
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "nothing_pending" })
  // The facts are quarantined now; labels written afterwards can never go with them.
  await putLabels(env, 1)
  const pulls = github.pulls.length
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "nothing_pending" })
  assert.equal(github.pulls.length, pulls)
  const root = await factoryStateRoot(env)
  const record = JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", keyOf(1)), "utf8"))
  assert.equal(record.reason, "facts_quarantined")
  assert.equal(record.facts, nameOf(1))
  assert.equal(Object.hasOwn(await delivered(env), keyOf(1)), false)
}))

test("labels whose facts the transform refuses in the same flush are quarantined with them; other labels still go", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  await putFacts(env, 2)
  await putLabels(env, 1)
  await putLabels(env, 2)
  const github = fakeGitHub()
  const transform = (local, options) => {
    if (local.session.id === sessionId(1)) throw Object.assign(new Error("refused"), { reason: "date" })
    return toPublished(local, options)
  }
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup, transform })).result, "delivered_pr_open")
  const job = await keyed(env)
  assert.deepEqual([...github.headFiles(STORE, await branch(env)).keys()].sort(), [`facts/${nameOf(2)}`, `labels/${job}/${sessionId(2)}.json`])
  const root = await factoryStateRoot(env)
  const record = JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", keyOf(1)), "utf8"))
  assert.deepEqual([record.reason, record.facts], ["facts_quarantined", nameOf(1)])
}))

test("labels waiting behind a rejected PR that held only their facts are quarantined in the same flush", () => scratch(async ({ env }) => {
  await setup(env)
  await putFacts(env, 1)
  await putLabels(env, 1)
  const github = fakeGitHub()
  // A one-file batch sends the facts alone; the labels wait for them.
  assert.equal((await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup, maxFiles: 1 })).result, "delivered_pr_open")
  github.rejectOpenPr("factory-rejected: evidence_unmatched")
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "nothing_pending" })
  const root = await factoryStateRoot(env)
  const reason = async (key) => JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", key), "utf8"))
  assert.equal((await reason(nameOf(1))).reason, "evidence_unmatched")
  assert.deepEqual(await reason(keyOf(1)), { reason: "facts_quarantined", facts: nameOf(1), at: (await reason(keyOf(1))).at })
}))

test("holdLabels answers the quarantined facts, keeps an earlier labels record and checks its arguments", () => scratch(async ({ env }) => {
  await setup(env)
  assert.equal(await holdLabels(env, STORE, { job: JOB, session: sessionId(1) }), null)
  await quarantine(env, STORE, `copilot-cli-${sessionId(1)}.json`, "date")
  assert.equal(await holdLabels(env, STORE, { job: JOB, session: sessionId(1) }), `copilot-cli-${sessionId(1)}.json`)
  const root = await factoryStateRoot(env)
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", keyOf(1)), "utf8")).facts, `copilot-cli-${sessionId(1)}.json`)
  // Labels already quarantined for their own reason keep it.
  await quarantine(env, STORE, keyOf(2), "too_large")
  await quarantine(env, STORE, nameOf(2), "date")
  assert.equal(await holdLabels(env, STORE, { job: JOB, session: sessionId(2) }), nameOf(2))
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", keyOf(2)), "utf8")).reason, "too_large")
  await assert.rejects(holdLabels(env, STORE, { job: "nope", session: sessionId(1) }), /job/u)
  await assert.rejects(holdLabels(env, STORE, { job: JOB, session: "../x" }), /session/u)
  await assert.rejects(quarantine(env, STORE, keyOf(3), "facts_quarantined", { facts: "../x.json" }), /facts/u)
}))
