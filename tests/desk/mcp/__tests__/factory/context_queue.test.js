import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { execFileSync } from "node:child_process"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { setConsent, taskContextPath } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { contextFacts, contextRecord, CONTEXT_JOB } from "./_context_fixture.js"
import { osEnv } from "../_os_env.js"

const queue = await import("../../../../../plugins/desk/mcp/src/factory/context-outbox.js").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})
const STORE = "ourostack/factory"
const VERSION = "3.2.0-alpha.1"
const json = (value) => `${JSON.stringify(value)}\n`
async function fixture({ prose = true, contribute = true } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desk-context-queue-")))
  const env = osEnv({ HOME: root, XDG_STATE_HOME: join(root, "state") })
  const desk = join(root, "desk")
  await mkdir(join(desk, "_meta"), { recursive: true })
  await writeFile(join(desk, "_meta", "factory.json"), json({ schema_version: 1, store: STORE }))
  if (prose) await writeFile(join(desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: true } }))
  await setConsent(env, { store: STORE, contribute, account: "synthetic" })
  const facts = contextFacts()
  const log = join(root, "session.jsonl")
  await writeFile(log, '{"synthetic":"private evidence"}\n')
  const entries = [{ facts, deskRoot: desk, personPrefix: "", localJobs: [{ local: CONTEXT_JOB, published: CONTEXT_JOB }], logPath: log, clockOrigin: "2026-10-01T00:00:00.000Z" }]
  return { env, root, desk, facts, entries, options: { store: STORE, entries, pluginVersion: VERSION } }
}
async function prepared() {
  const f = await fixture()
  await queue.prepareTaskContexts(f.env, f.options)
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  return { ...f, work }
}
const candidate = (facts) => ({ ...contextRecord(facts), privacy: null })
async function acceptedCandidate(f) {
  return queue.acceptContextCandidate(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(candidate(f.facts)) })
}
const review = (hash, verdict = "approved") => ({
  schema: "desk.factory.context-review/1", verdict, payload_sha256: hash,
  reviewer: { plugin_version: VERSION, rubric: "1" }, reason: verdict === "approved" ? "safe" : "sensitive",
})

test("numeric-only consent and an absent prose policy prepare no task context", async () => {
  assert.ok(queue, "the context queue is not implemented")
  for (const options of [{ prose: false }, { contribute: false }]) {
    const f = await fixture(options)
    assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 0)
    assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
  }
})

test("only an exact regular per-desk store policy authorizes prose", async () => {
  assert.ok(queue)
  const f = await fixture({ prose: false })
  const policy = join(f.desk, "_meta", "factory-context.json")
  assert.equal(queue.contextPermission(f.desk, STORE), "not_opted_in")
  await writeFile(policy, json({ schema_version: 1, stores: { [STORE]: true }, SENTINEL: "private" }))
  assert.equal(queue.contextPermission(f.desk, STORE), "policy_invalid")
  const linked = await fixture({ prose: false })
  const target = join(linked.root, "policy.json")
  await writeFile(target, json({ schema_version: 1, stores: { [STORE]: true } }))
  await symlink(target, join(linked.desk, "_meta", "factory-context.json"))
  assert.equal(queue.contextPermission(linked.desk, STORE), "policy_invalid")
})

test("preparation is source-current, idempotent and protected without publishing private paths", async () => {
  assert.ok(queue)
  const f = await prepared()
  assert.equal(f.work.phase, "candidate")
  const input = JSON.parse(await readFile(f.work.input, "utf8"))
  assert.equal(input.private_evidence[0].log_path, f.entries[0].logPath)
  assert.equal(input.sources[0].session.id, f.facts.session.id)
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).unchanged, 1)
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("an author's own approval is refused; a separate hash-bound privacy judgment makes context ready", async () => {
  assert.ok(queue)
  const f = await prepared()
  const selfApproved = await queue.acceptContextCandidate(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(contextRecord(f.facts)) })
  assert.equal(selfApproved.result, "review_not_independent")
  const accepted = await acceptedCandidate(f)
  assert.equal(accepted.result, "candidate_accepted")
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  const [privacy] = await queue.listContextWork(f.env, { store: STORE })
  assert.equal(privacy.phase, "privacy")
  const checked = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
  assert.equal(checked.result, "context_accepted")
  const [item] = await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries })
  assert.equal(item.path, `context/${CONTEXT_JOB}.json`)
  const publicText = item.bytes.toString("utf8")
  assert.equal(publicText.includes(f.root), false)
  assert.equal(publicText.includes("clock_origin"), false)
  assert.equal(JSON.parse(publicText).privacy.payload_sha256, accepted.payload_sha256)
  assert.deepEqual(await queue.listContextWork(f.env, { store: STORE }), [])
})

test("a privacy refusal or an edited payload hash cannot reach the public outbox", async () => {
  assert.ok(queue)
  for (const verdict of ["withheld", "wrong_hash"]) {
    const f = await prepared()
    const accepted = await acceptedCandidate(f)
    const value = review(verdict === "wrong_hash" ? "f".repeat(64) : accepted.payload_sha256, verdict === "withheld" ? "withheld" : "approved")
    const result = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(value) })
    assert.notEqual(result.result, "context_accepted")
    assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  }
})

test("a source update between generation and privacy invalidates the old phase", async () => {
  assert.ok(queue)
  const f = await prepared()
  const accepted = await acceptedCandidate(f)
  f.facts.intervals[0].end_ms += 1
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 1)
  const result = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
  assert.equal(result.result, "source_changed")
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("revoking prose permission or changing the route stops a reviewed record", async () => {
  assert.ok(queue)
  for (const route of [false, true]) {
    const f = await prepared()
    const accepted = await acceptedCandidate(f)
    await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
    if (route) await writeFile(join(f.desk, "_meta", "factory.json"), json({ schema_version: 1, store: "example/private" }))
    else await writeFile(join(f.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
    assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  }
})

test("a task card is associated by its real job identity and changes invalidate its context input", async () => {
  assert.ok(queue)
  const f = await fixture()
  const git = (...args) => execFileSync("git", args, { cwd: f.desk, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  const remote = "https://github.com/synthetic/desk.git"
  git("init", "-qb", "main")
  git("config", "user.email", "16390116+arimendelow@users.noreply.github.com")
  git("config", "user.name", "Context Test")
  git("config", "commit.gpgsign", "false")
  git("remote", "add", "origin", remote)
  const card = join(f.desk, "sample", "safe", "task.md")
  await mkdir(join(f.desk, "sample", "safe"), { recursive: true })
  const original = "---\nstatus: done\ncreated: '2026-10-01T00:00:00Z'\nupdated: '2026-10-02T00:00:00Z'\n---\nPrivate source: waiting for a software update.\n"
  await writeFile(card, original)
  git("add", "sample")
  git("commit", "-qm", "task")
  const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug: "safe" })
  f.facts.jobs[0].job = job
  f.facts.outcomes[0].job = job
  f.entries[0].localJobs = [{ local: job, published: job }]
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 1)
  const [work] = await queue.listContextWork(f.env, { store: STORE })
  const input = JSON.parse(await readFile(work.input, "utf8"))
  assert.equal(input.task_card.path, card)
  assert.match(input.task_card.sha256, /^[0-9a-f]{64}$/u)
  assert.equal(JSON.stringify(input).includes("Private source"), false)
  await writeFile(card, `${original}\nThe software update was installed and retesting resumed.\n`)
  assert.equal((await queue.prepareTaskContexts(f.env, f.options)).prepared, 1)
  assert.notEqual((await queue.listContextWork(f.env, { store: STORE }))[0].basis, work.basis)
})

test("changed private evidence invalidates review even before the next preparation pass", async () => {
  const f = await prepared()
  const accepted = await acceptedCandidate(f)
  await writeFile(f.entries[0].logPath, '{"synthetic":"new private evidence"}\n')
  const checked = await queue.acceptContextPrivacy(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(review(accepted.payload_sha256)) })
  assert.equal(checked.result, "source_changed")
})

test("editing a prepared input cannot silently change the source basis", async () => {
  const f = await prepared()
  const input = JSON.parse(await readFile(f.work.input, "utf8"))
  input.sources[0].intervals[0].end_ms += 1
  await writeFile(f.work.input, json(input))
  const changed = candidate(input.sources[0])
  const checked = await queue.acceptContextCandidate(f.env, { store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: json(changed) })
  assert.equal(checked.result, "source_changed")
})

test("a child-written ready flag cannot bypass the separate privacy acceptance receipt", async () => {
  const f = await prepared()
  const stateFile = await taskContextPath(f.env, STORE, CONTEXT_JOB, "state.json")
  const state = JSON.parse(await readFile(stateFile, "utf8"))
  state.phase = "ready"
  state.record = contextRecord(f.facts)
  await writeFile(stateFile, json(state))
  assert.deepEqual(await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("normal formatted local model responses are checked then canonically serialized for publication", async () => {
  const f = await prepared()
  const accepted = await queue.acceptContextCandidate(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: JSON.stringify(candidate(f.facts), null, 2),
  })
  assert.equal(accepted.result, "candidate_accepted")
  assert.equal((await queue.acceptContextPrivacy(f.env, {
    store: STORE, job: CONTEXT_JOB, basis: f.work.basis, bytes: JSON.stringify(review(accepted.payload_sha256), null, 2),
  })).result, "context_accepted")
  const [item] = await queue.readyTaskContexts(f.env, { store: STORE, entries: f.entries })
  assert.equal(item.bytes.toString("utf8"), `${JSON.stringify(JSON.parse(item.bytes.toString("utf8")))}\n`)
})
