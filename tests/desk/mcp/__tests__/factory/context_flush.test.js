import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { promises as fs } from "node:fs"
import { syncBuiltinESMExports } from "node:module"
import * as path from "node:path"
import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import {
  readConsent, readDelivered, readStatus, readTaskContextFile, setConsent, writeLocalFacts, writeStatus,
  taskContextPath, updateStatus, updateTaskContextState,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { acceptContextCandidate, acceptContextPrivacy, listContextWork, planContextPublication, saveContextSent } from "../../../../../plugins/desk/mcp/src/factory/context-outbox.js"
import { validatePr } from "../../../../../plugins/desk/mcp/src/factory/pipeline/validate-pr.js"
import { runEvaluatorStep } from "../../../../../plugins/desk/mcp/src/factory/evaluator-step.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { contextRecord } from "./_context_fixture.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const T0 = Date.parse("2026-10-21T00:00:00.000Z")
const json = (value) => `${JSON.stringify(value)}\n`
async function world(w, { prose = true, contextJson = '{"task_context":1}', push = true, card = false, deskVisibility = "private" } = {}) {
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
  const hub = fakeGitHub({ store: STORE, account: "synthetic", push, contextJson, visibility: { "synthetic/context-desk": deskVisibility, "ourostack/desk": "public" } })
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
async function reviewedBatch(base) {
  const w = await world(base)
  for (let index = 1; index < 9; index += 1) {
    const local = structuredClone(w.local)
    local.session.id = `${String(index).padStart(8, "0")}-1234-4abc-8abc-123456789abc`
    local.jobs[0].job = String(index).repeat(32)
    const written = await writeLocalFacts(w.env, STORE, local)
    assert.equal(written.written, true)
    await updateStatus(w.env, (status) => ({
      ...status, derivations: { ...status.derivations, [written.name]: {
        store: STORE, checked_route: STORE, desk_root: w.desk, desk_repo: "synthetic/context-desk",
      } },
    }))
  }
  await w.run()
  w.hub.mergeOpenPr()
  await w.run()
  const work = await listContextWork(w.env, { store: STORE })
  assert.equal(work.length, 9)
  for (const item of work) {
    const candidate = { ...contextRecord(item.source.sources[0], item.job), evaluator: item.source.evaluator, privacy: null }
    const accepted = await acceptContextCandidate(w.env, { store: STORE, job: item.job, basis: item.basis, bytes: json(candidate) })
    assert.equal(accepted.result, "candidate_accepted")
    assert.equal((await acceptContextPrivacy(w.env, {
      store: STORE, job: item.job, basis: item.basis, bytes: json({
        schema: "desk.factory.context-review/1", verdict: "approved", payload_sha256: accepted.payload_sha256,
        reviewer: item.source.evaluator, reason: "safe",
      }),
    })).result, "context_accepted")
  }
  return w
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

test("settled unchanged context neither reopens its intake nor rewrites its accepted publication record", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  const work = await approve(w)
  await w.run()
  w.hub.mergeOpenPr()
  assert.equal((await w.run()).result, "nothing_pending")
  const before = await readTaskContextFile(w.env, STORE, work.job, "state.json")
  const pulls = w.hub.pulls.length
  assert.equal((await w.run()).result, "nothing_pending")
  assert.equal(w.hub.pulls.length, pulls)
  assert.deepEqual(await readTaskContextFile(w.env, STORE, work.job, "state.json"), before)
}))

test("a public desk's private source mapping uses the same keyed job identity as its numerical publication", () => scratch(async (base) => {
  const w = await world(base, { deskVisibility: "public" })
  assert.equal((await w.run()).result, "delivered_pr_open")
  const [work] = await listContextWork(w.env, { store: STORE })
  assert.notEqual(work.job, w.job)
  assert.equal(work.source.local_job, w.job)
  assert.equal(work.source.sources[0].jobs[0].job, work.job)
  const facts = [...await w.files()].filter(([name]) => name.startsWith("facts/")).map(([, sha]) => JSON.parse(w.hub.blobs.get(sha)))
  assert.equal(facts[0].jobs[0].job, work.job)
  assert.equal(JSON.stringify(facts).includes(w.job), false)
}))

test("numeric-only consent or an incompatible store never sends context and facts still go", () => scratch(async (base) => {
  const w = await world(base, { prose: false })
  assert.equal((await w.run()).result, "delivered_pr_open")
  assert.equal(contexts(await w.files()).length, 0)
  assert.deepEqual(await listContextWork(w.env, { store: STORE }), [])
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
}))

for (const elapsed of [98000, 117000]) {
  test(`ordinary context preparation still progresses after ${elapsed} ms of a 120000 ms flush`, () => scratch(async (base) => {
    const w = await world(base, { card: true })
    let now = T0
    const result = await w.run({
      now: () => now,
      planContexts: (env, options) => {
        now += elapsed
        return planContextPublication(env, {
          ...options,
          readRemote: () => "https://github.com/synthetic/context-desk.git",
          resolveIdentity: ({ track, slug }) => ({ track, slug }),
        })
      },
    })
    assert.equal(result.result, "delivered_pr_open")
    assert.equal(result.context_held, undefined)
    const [work] = await listContextWork(w.env, { store: STORE })
    assert.ok(work, "the remaining flush window must prepare the eligible job")
    assert.equal(work.job, w.job)
    assert.equal(work.phase, "candidate")
    assert.equal(work.source.task_card.path, w.cardFile)
    assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
    assert.equal(contexts(await w.files()).length, 0)
  }))
}

test("near-expiry context preparation preserves numerical transport's remaining opportunity", () => scratch(async (base) => {
  const w = await world(base, { card: true })
  let now = T0, planning = false, delayed = false
  const result = await w.run({
    now: () => now,
    runner: (args, options) => {
      if (planning && !delayed) { now += 750; delayed = true }
      return w.hub.runner(args, options)
    },
    planContexts: (env, options) => {
      now += 119000
      planning = true
      return planContextPublication(env, {
        ...options,
        readRemote: () => { now += 500; return "https://github.com/synthetic/context-desk.git" },
      })
    },
  })
  assert.equal(result.result, "delivered_pr_open")
  assert.equal(result.context_held, "context_preparation_deferred")
  assert.equal(now - T0, 119750)
  assert.deepEqual(await listContextWork(w.env, { store: STORE }), [])
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
  assert.equal(contexts(await w.files()).length, 0)
}))

test("late context preparation cannot extend an expired total flush deadline", () => scratch(async (base) => {
  const w = await world(base, { card: true })
  let now = T0
  const result = await w.run({
    now: () => now,
    planContexts: (env, options) => {
      now += 120000
      return planContextPublication(env, options)
    },
  })
  assert.equal(result.result, "deadline")
  assert.deepEqual(await listContextWork(w.env, { store: STORE }), [])
  assert.equal(w.hub.pulls.length, 0)
  assert.equal(await w.files(), null)
}))

test("slow optional context preparation defers prose while ordinary numeric delivery keeps its time window", () => scratch(async (base) => {
  const w = await world(base, { card: true })
  let now = T0
  const result = await w.run({
    now: () => now, deadlineMs: 60000,
    planContexts: (env, options) => planContextPublication(env, {
      ...options,
      readRemote: () => { now += 1000; return "https://github.com/synthetic/context-desk.git" },
      resolveIdentity: ({ track, slug }) => { now += 1000; return { track, slug } },
    }),
  })
  assert.equal(result.result, "delivered_pr_open")
  assert.equal(result.context_held, "context_preparation_deferred")
  assert.ok(now - T0 <= 2000)
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
  assert.equal(contexts(await w.files()).length, 0)
}))

for (const code of ["context_preparation_deferred", "boot_check_budget", "git_deadline", "EIO"]) {
  test(`optional context ${code} failure stays visible while numerical facts are delivered`, () => scratch(async (base) => {
    const w = await world(base)
    let planned = false
    const result = await w.run({ planContexts: () => {
      planned = true
      throw Object.assign(new Error("SENTINEL private preparation failure"), { code })
    } })
    assert.equal(planned, true)
    assert.equal(result.result, "delivered_pr_open")
    assert.equal(result.context_held, code === "EIO" ? "context_error" : "context_preparation_deferred")
    assert.equal(JSON.stringify(result).includes("SENTINEL"), false)
    assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
    assert.equal(contexts(await w.files()).length, 0)
  }))
}

test("a failed context diagnostic write cannot turn numerical delivery into a context failure", (t) => scratch(async (base) => {
  const w = await world(base)
  const rename = fs.rename
  let diagnostic = false, failed = false
  t.mock.method(fs, "rename", async (from, to, ...args) => {
    if (diagnostic && !failed && path.basename(String(to)) === "status.json") {
      failed = true
      throw Object.assign(new Error("synthetic_diagnostic_write"), { code: "EIO" })
    }
    return rename(from, to, ...args)
  })
  syncBuiltinESMExports()
  try {
    const result = await w.run({ planContexts: () => { diagnostic = true; throw new Error("synthetic_context_failure") } })
    assert.equal(failed, true)
    assert.equal(result.result, "delivered_pr_open")
    assert.equal(result.context_held, "context_status_error")
    assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
  } finally { t.mock.restoreAll(); syncBuiltinESMExports() }
}))

test("a real flush cancellation remains a cancellation rather than an optional-context hold", () => scratch(async (base) => {
  const originalError = globalThis.Error
  const observed = []
  let subject
  // Observe the actual private cancellation type without fabricating a lookalike error.
  globalThis.Error = new Proxy(originalError, { construct(target, args, newTarget) {
    const value = Reflect.construct(target, args, newTarget)
    observed.push(value)
    return value
  } })
  try { subject = await import("../../../../../plugins/desk/mcp/src/factory/flush.js?context-cancellation-observation") }
  finally { globalThis.Error = originalError }
  assert.equal((await subject.chooseAccount({ store: STORE, now: () => T0, deadlineMs: -1,
    runner: () => assert.fail("an expired operation cannot reach the transport") })).result, "deadline")
  const cancellation = observed.find((error) => error.code === "deadline")
  assert.ok(cancellation)
  const w = await world(base)
  const result = await subject.flush(w.env, { store: STORE, runner: w.hub.runner, anonymousLookup: w.hub.anonymousLookup,
    now: () => T0, planContexts: () => { throw cancellation } })
  assert.equal(result.result, "deadline")
  assert.equal(result.context_held, undefined)
  assert.equal(w.hub.pulls.length, 0)
  assert.equal(await w.files(), null)
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
  w.hub.rejectOpenPr("factory-rejected: context_source_changed")
  await w.run()
  assert.equal(contexts(await w.files()).length, 0)
  assert.equal((await readDelivered(w.env, STORE)).quarantined.size, 0)
  assert.equal([...await w.files()].filter(([name]) => name.startsWith("facts/")).length, 1)
  await w.run({ now: () => T0 + 24 * 3600 * 1000 + 1 })
  assert.equal(contexts(await w.files()).length, 1)
}))

test("rotating bounded plans keep the actual open intake head unchanged until its batch merges", () => scratch(async (base) => {
  const w = await reviewedBatch(base)
  const sent = await w.run()
  assert.equal(sent.result, "delivered_pr_open")
  const branch = `intake/${(await readConsent(w.env)).stores[STORE].intake_id}`
  const before = w.hub.ref(STORE, branch)
  assert.equal(contexts(await w.files()).length, 8)
  await w.run()
  await w.run()
  assert.equal(w.hub.ref(STORE, branch), before, "an ordinary retry must not restart checks for unchanged context")
  w.hub.mergeOpenPr()
  await w.run()
  assert.equal(contexts(w.hub.mainFiles()).length, 8)
  assert.equal(contexts(await w.files()).length, 9, "the later task enters intake only after the earlier batch settles")
}))

test("a rejected rotated intake accounts for its complete batch before advancing the rejection watermark", () => scratch(async (base) => {
  const w = await reviewedBatch(base)
  const sent = await w.run()
  const sentJobs = contexts(await w.files()).map(([name]) => name.slice("context/".length, -".json".length))
  assert.equal(sentJobs.length, 8)
  w.hub.rejectOpenPr("factory-rejected: context_source_changed")
  await w.run()
  for (const job of sentJobs) {
    const state = JSON.parse((await readTaskContextFile(w.env, STORE, job, "state.json")).toString("utf8"))
    assert.equal(state.refusals, 1)
    assert.equal(state.pr, null)
    assert.equal(state.hold_until, T0 + 24 * 3600 * 1000)
  }
  assert.ok((await readStatus(w.env)).last_flush[STORE].rejections_through >= sent.pr.number)
}))

test("failed refusal accounting preserves the watermark and a repaired retry counts the refusal once", () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  w.hub.mergeOpenPr()
  await w.run()
  await approve(w)
  const sent = await w.run()
  const before = JSON.parse((await readTaskContextFile(w.env, STORE, w.job, "state.json")).toString("utf8"))
  const through = (await readStatus(w.env)).last_flush[STORE].rejections_through ?? 0
  w.hub.rejectOpenPr("factory-rejected: context_source_changed")
  await updateTaskContextState(w.env, STORE, w.job, (state) => ({ ...state, publication_seal: "f".repeat(64) }))
  await w.run()
  const failed = await readStatus(w.env)
  assert.equal(failed.last_flush[STORE].rejections_through, through)
  assert.equal(failed.context_publication[STORE].code, "context_error")
  await updateTaskContextState(w.env, STORE, w.job, (state) => ({ ...state, publication_seal: before.publication_seal }))
  await w.run()
  await w.run()
  const repaired = JSON.parse((await readTaskContextFile(w.env, STORE, w.job, "state.json")).toString("utf8"))
  assert.equal(repaired.refusals, 1)
  assert.equal(repaired.pr, null)
  assert.ok((await readStatus(w.env)).last_flush[STORE].rejections_through >= sent.pr.number)
}))

test("a refused receipt race holds context replay keys while numerical delivery continues", (t) => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  w.hub.mergeOpenPr()
  await w.run()
  await approve(w)
  const sent = await w.run()
  const file = await taskContextPath(w.env, STORE, w.job, "state.json")
  const before = JSON.parse(await fs.readFile(file, "utf8"))
  const through = (await readStatus(w.env)).last_flush[STORE].rejections_through ?? 0
  await saveContextSent(w.env, STORE, [{ job: w.job, basis: before.basis, sha: "e".repeat(40) }], sent.pr.number)
  const winner = JSON.parse(await fs.readFile(file, "utf8"))
  await fs.writeFile(file, json(before))
  w.hub.rejectOpenPr("factory-rejected: context_source_changed")
  const local = structuredClone(w.local)
  local.session.id = "99000000-1234-4abc-8abc-123456789abc"
  local.jobs[0].job = "9".repeat(32)
  const written = await writeLocalFacts(w.env, STORE, local)
  await updateStatus(w.env, (status) => ({ ...status, derivations: { ...status.derivations, [written.name]: {
    store: STORE, checked_route: STORE, desk_root: w.desk, desk_repo: "synthetic/context-desk",
  } } }))
  const open = fs.open.bind(fs)
  let raced = false
  t.mock.method(fs, "open", async (target, ...args) => {
    if (String(target) === `${file}.lock` && !raced) {
      raced = true
      await fs.writeFile(file, json(winner))
    }
    return open(target, ...args)
  })
  try {
    assert.equal((await w.run()).result, "intake_stale_retried", "numerical delivery stays admitted")
  } finally {
    t.mock.restoreAll()
    syncBuiltinESMExports()
  }
  assert.equal(raced, true)
  assert.equal([...(await w.files())].filter(([name]) => name.startsWith("facts/")).length, 2)
  assert.equal(contexts(await w.files()).length, 0, "a failed refusal must not be republished under a new PR")
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).pr, sent.pr.number, "retain the original replay key")
  assert.equal((await readStatus(w.env)).last_flush[STORE].rejections_through, through)
  await w.run()
  await w.run()
  const after = JSON.parse(await fs.readFile(file, "utf8"))
  assert.equal(after.refusals, 1)
  assert.equal(after.pr, null)
  assert.ok((await readStatus(w.env)).last_flush[STORE].rejections_through >= sent.pr.number)
}))

for (const contextRefused of [false, true]) test(`mixed intake keeps numeric quarantine separate from context refusal: ${contextRefused}`, () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  w.hub.mergeOpenPr()
  await w.run()
  const work = await approve(w)
  const other = structuredClone(w.local)
  other.session.id = "22bc1234-1234-4abc-8abc-123456789abc"
  other.jobs[0].job = "f".repeat(32)
  const written = await writeLocalFacts(w.env, STORE, other)
  assert.equal(written.written, true)
  await updateStatus(w.env, (status) => ({
    ...status, derivations: { ...status.derivations, [written.name]: { store: STORE, checked_route: STORE, desk_root: w.desk, desk_repo: "synthetic/context-desk" } },
  }))
  await w.run()
  const files = await w.files()
  assert.equal(contexts(files).length, 1)
  const otherPath = [...files.keys()].find((file) => file.startsWith("facts/") && file.includes(other.session.id))
  assert.ok(otherPath)
  w.hub.rejectOpenPr(`factory-rejected: duration_decreased${contextRefused ? "\nfactory-rejected: context_source_changed" : ""}`)
  await w.run()
  const delivered = await readDelivered(w.env, STORE)
  assert.equal(delivered.quarantined.has(written.name), true, "the numeric refusal must quarantine the rejected facts")
  const state = JSON.parse((await readTaskContextFile(w.env, STORE, work.job, "state.json")).toString("utf8"))
  assert.equal(state.refusals, contextRefused ? 1 : 0)
}))

for (const stores of [
  { [STORE]: false },
  { "OuroStack/Factory": true, [STORE]: false },
  { [STORE]: false, "OuroStack/Factory": true },
]) test(`revoking prose permission retracts only owned context: ${Object.keys(stores).join(", ")}`, () => scratch(async (base) => {
  const w = await world(base)
  await w.run()
  await approve(w)
  await w.run()
  w.hub.mergeOpenPr()
  await w.run()
  assert.equal(contexts(w.hub.mainFiles()).length, 1)
  await fs.writeFile(path.join(w.desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores }))
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
    qualifyHeadlessSource: async () => ({ state: "qualified" }),
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
