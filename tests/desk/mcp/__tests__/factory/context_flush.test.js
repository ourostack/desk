import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import {
  readConsent, readDelivered, readStatus, readTaskContextFile, setConsent, writeLocalFacts, writeStatus,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { acceptContextCandidate, acceptContextPrivacy, listContextWork } from "../../../../../plugins/desk/mcp/src/factory/context-outbox.js"
import { validatePr } from "../../../../../plugins/desk/mcp/src/factory/pipeline/validate-pr.js"
import { runEvaluatorStep } from "../../../../../plugins/desk/mcp/src/factory/evaluator-step.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { contextRecord } from "./_context_fixture.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const T0 = Date.parse("2026-10-21T00:00:00.000Z")
const json = (value) => `${JSON.stringify(value)}\n`
async function world(w, { prose = true, contextJson = '{"task_context":1}', push = true, card = false } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd: w.desk, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-qb", "main")
  git("remote", "add", "origin", "https://github.com/synthetic/context-desk.git")
  await fs.writeFile(path.join(w.desk, "_meta", "factory.json"), json({ schema_version: 1, store: STORE }))
  if (prose) await fs.writeFile(path.join(w.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: true } }))
  await setConsent(w.env, { store: STORE, contribute: true, account: "synthetic" })
  const local = JSON.parse(await fs.readFile(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
  local.jobs = [local.jobs[0]]
  let cardFile = null
  if (card) {
    git("config", "user.email", "16390116+arimendelow@users.noreply.github.com")
    git("config", "user.name", "Context Test")
    git("config", "commit.gpgsign", "false")
    cardFile = path.join(w.desk, "sample", "device", "task.md")
    await fs.mkdir(path.dirname(cardFile), { recursive: true })
    await fs.writeFile(cardFile, "---\nstatus: done\ncreated: '2026-10-01T00:00:00Z'\nupdated: '2026-10-02T00:00:00Z'\n---\nTested the device connection.\n")
    git("add", "sample")
    git("commit", "-qm", "task")
    local.jobs[0].job = jobId({ deskRemote: "https://github.com/synthetic/context-desk.git", personPrefix: "", track: "sample", slug: "device" })
  }
  const written = await writeLocalFacts(w.env, STORE, local)
  assert.equal(written.written, true)
  await writeStatus(w.env, { derivations: { [written.name]: { store: STORE, checked_route: STORE, desk_root: w.desk, desk_repo: "synthetic/context-desk" } } })
  const hub = fakeGitHub({ store: STORE, account: "synthetic", push, contextJson, visibility: { "synthetic/context-desk": "private", "ourostack/desk": "public" } })
  const run = (extra = {}) => flush(w.env, { store: STORE, runner: hub.runner, anonymousLookup: hub.anonymousLookup, now: () => T0, ...extra })
  const files = async () => hub.headFiles(STORE, `intake/${(await readConsent(w.env)).stores[STORE].intake_id}`)
  return { ...w, hub, local, name: written.name, job: local.jobs[0].job, cardFile, run, files }
}
async function approve(w) {
  const [work] = await listContextWork(w.env, { store: STORE })
  assert.ok(work, "the ordinary flush must prepare the context input")
  const candidate = { ...contextRecord(work.source.sources[0], work.job), evaluator: work.source.evaluator, privacy: null }
  const accepted = await acceptContextCandidate(w.env, { store: STORE, job: work.job, basis: work.basis, bytes: json(candidate) })
  assert.equal(accepted.result, "candidate_accepted")
  const review = { schema: "desk.factory.context-review/1", verdict: "approved", payload_sha256: accepted.payload_sha256, reviewer: work.source.evaluator, reason: "safe" }
  assert.equal((await acceptContextPrivacy(w.env, { store: STORE, job: work.job, basis: work.basis, bytes: json(review) })).result, "context_accepted")
  return work
}
const contexts = (files) => [...files].filter(([name]) => name.startsWith("context/"))

test("ordinary flush stages public evidence, publishes reviewed context, and acknowledges only actual main", () => scratch(async (base) => {
  const w = await world(base)
  assert.equal((await w.run()).result, "delivered_pr_open")
  assert.equal((await readStatus(w.env)).context_publication[STORE].ready, true)
  const work = await approve(w)
  await w.run()
  const [[contextPath, blob]] = contexts(await w.files())
  const bytes = w.hub.blobs.get(blob)
  assert.equal(bytes.includes(w.base), false)
  const facts = [...await w.files()].filter(([name]) => name.startsWith("facts/")).map(([name, sha]) => ({ path: name, bytes: w.hub.blobs.get(sha) }))
  assert.deepEqual(validatePr({ trustedMaintainer: true, changes: [{ path: contextPath, status: "added", bytes, facts }] }), { ok: true, errors: [] })
  const before = JSON.parse((await readTaskContextFile(w.env, STORE, work.job, "state.json")).toString("utf8"))
  assert.equal(before.published_sha, null)
  w.hub.mergeOpenPr()
  assert.equal((await w.run()).result, "nothing_pending")
  const after = JSON.parse((await readTaskContextFile(w.env, STORE, work.job, "state.json")).toString("utf8"))
  assert.equal(after.published_sha, blob)
  assert.equal(after.pr, null)
}))

test("numeric-only consent or an incompatible store never sends context and facts still go", () => scratch(async (base) => {
  const w = await world(base, { prose: false })
  assert.equal((await w.run()).result, "delivered_pr_open")
  assert.equal(contexts(await w.files()).length, 0)
  assert.deepEqual(await listContextWork(w.env, { store: STORE }), [])
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
}))

test("a store with no context capability keeps reviewed prose out of its intake", () => scratch(async (base) => {
  const w = await world(base, { contextJson: null })
  await w.run()
  await approve(w)
  await w.run()
  assert.equal(contexts(await w.files()).length, 0)
  assert.equal((await readStatus(w.env)).context_publication[STORE].ready, false)
}))

test("a context refusal is isolated from numerical facts and retries without manual replay", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  await approve(w)
  await w.run()
  w.hub.rejectOpenPr("factory-rejected: source_changed")
  await w.run()
  assert.equal(contexts(await w.files()).length, 0)
  assert.equal((await readDelivered(w.env, STORE)).quarantined.size, 0)
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
  await w.run({ now: () => T0 + 24 * 3600 * 1000 + 1 })
  assert.equal(contexts(await w.files()).length, 1)
}))

test("revoking prose permission retracts only the exact context this machine actually delivered", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  await approve(w)
  await w.run()
  w.hub.mergeOpenPr()
  await w.run()
  assert.equal(contexts(w.hub.mainFiles()).length, 1)
  await fs.writeFile(path.join(w.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: false } }))
  await w.run()
  assert.equal(contexts(await w.files()).length, 0)
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
  w.hub.mergeOpenPr()
  await w.run()
  assert.equal(contexts(w.hub.mainFiles()).length, 0)
}))

test("ordinary flush and evaluator entries complete the whole producer path without a per-session replay", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  const [work] = await listContextWork(w.env, { store: STORE })
  const options = {
    pluginVersion: work.source.evaluator.plugin_version, now: T0, clock: () => T0, deadline: T0 + 3600000, maxRuns: 1,
    findAgentCli: () => "/synthetic/claude", probeSignIn: async () => ({ state: "subscription" }),
    runHeadless: async ({ briefPaths }) => {
      for (const file of briefPaths) {
        const brief = JSON.parse(await fs.readFile(file, "utf8"))
        const input = JSON.parse(await fs.readFile(brief.input_file, "utf8"))
        const value = brief.phase === "candidate"
          ? { ...contextRecord(input.sources[0], brief.job), evaluator: brief.evaluator, privacy: null }
          : { schema: "desk.factory.context-review/1", verdict: "approved", payload_sha256: brief.payload_sha256, reviewer: brief.evaluator, reason: "safe" }
        await fs.writeFile(brief.output, json(value))
      }
      return { state: "ran", cost_usd: null }
    },
  }
  assert.equal((await runEvaluatorStep(w.env, options)).result, "context_ran")
  assert.equal((await runEvaluatorStep(w.env, options)).result, "context_ran")
  await w.run()
  assert.equal(contexts(await w.files()).length, 1)
  w.hub.mergeOpenPr()
  await w.run()
  assert.equal(contexts(w.hub.mainFiles()).length, 1)
}))

test("context never displaces its source facts from a one-file intake batch", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  await approve(w)
  w.hub.rejectOpenPr("factory-rejected: merge_conflict")
  await w.run({ maxFiles: 1 })
  assert.equal(contexts(await w.files()).length, 0)
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
  w.hub.mergeOpenPr()
  await w.run({ maxFiles: 1 })
  assert.equal(contexts(await w.files()).length, 1)
}))

test("a context-capable store still requires the author's current maintainer permission", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  await approve(w)
  w.hub.setPush(false)
  await w.run()
  for (const pr of w.hub.pulls.filter((item) => item.state === "open")) {
    assert.equal(contexts(w.hub.headFiles(pr.headRepo, pr.head.ref)).length, 0)
  }
  assert.equal((await readStatus(w.env)).context_publication[STORE].ready, false)
}))

test("a changed private source withdraws old public wording while its replacement awaits review", () => scratch(async (base) => {
  const w = await world(base, { card: true })
  await w.run()
  await approve(w)
  await w.run()
  w.hub.mergeOpenPr()
  await w.run()
  await fs.appendFile(w.cardFile, "\nCorrection: the earlier observation needs another retest.\n")
  assert.equal((await w.run()).result, "delivered_pr_open")
  const [[, blob]] = contexts(await w.files())
  const cleared = JSON.parse(w.hub.blobs.get(blob))
  assert.equal(cleared.state, "unavailable")
  assert.equal(cleared.heading, null)
  assert.deepEqual(cleared.events, [])
  assert.equal(cleared.privacy.verdict, "not_required")
  assert.equal(cleared.privacy.reviewer, null)
  assert.deepEqual(cleared.coverage.reasons, ["review_pending"])
}))

test("context waits rather than exceeding the intake byte budget", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  await approve(w)
  w.hub.mergeOpenPr()
  assert.equal((await w.run({ maxBytes: 1 })).result, "nothing_pending")
  assert.equal(contexts(await w.files()).length, 0)
  await w.run()
  assert.equal(contexts(await w.files()).length, 1)
}))
