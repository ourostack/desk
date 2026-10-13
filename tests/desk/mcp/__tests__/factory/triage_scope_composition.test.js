import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { kickLoop, evaluationKickDue } from "../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js"
import { main as loopMain } from "../../../../../plugins/desk/hooks/loop-start.cjs"
import { runTriageStep } from "../../../../../plugins/desk/mcp/src/factory/triage-step.js"
import { planTriage, prepareTriage, recordTriageCoverage } from "../../../../../plugins/desk/mcp/src/factory/triage-outbox.js"
import { readStatus, updateStatus, updateTriageOutbox, readTriageOutbox } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { STORE, NEEDS_PREPARED_RUN, triageWorld, qualifiedSeams, pushDesk } from "./_triage_world.js"

const T0 = Date.parse("2026-10-12T01:00:00.000Z")
const HOUR = 3600_000
const scopeOf = (deskRoot) => ({ deskRoot, personPrefix: "" })
const scopeKey = (deskRoot) => JSON.stringify([path.resolve(deskRoot), ""])
const deadline = () => new Date(Date.now() + 20 * 60_000)

async function fixture() {
  const w = await triageWorld({ now: new Date(T0) })
  await fs.mkdir(path.join(w.deskRoot, "_meta"), { recursive: true })
  await fs.writeFile(path.join(w.deskRoot, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store: STORE }))
  pushDesk(w, "declared route")
  w.denied = path.join(w.base, "denied")
  await fs.mkdir(path.join(w.denied, "_meta"), { recursive: true })
  await fs.writeFile(path.join(w.denied, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store: "private/not-consented" }))
  return w
}

const observe = (w, root, hours, impls = qualifiedSeams()) => runTriageStep(w.env, {
  deskRoot: root, personPrefix: "", now: new Date(T0 + hours * HOUR), deadline: deadline(), impls,
})

async function launchSelected(w, scope, hours) {
  let launched = null
  let work
  const result = await kickLoop(w.env, {
    scope, now: T0 + hours * HOUR,
    spawn: async (_node, args) => {
      const child = new EventEmitter()
      child.kill = () => true
      const launcher = loopMain({
        env: w.env, argv: args.slice(1), resolveRoot: async () => w.denied,
        resolvePerson: async () => ({ status: "ok", personPrefix: "" }),
        spawnImpl: (_exec, workerArgs) => {
          launched = { deskRoot: workerArgs[workerArgs.indexOf("--desk") + 1], personPrefix: workerArgs.includes("--person-prefix") ? workerArgs.at(-1) : "" }
          work = observe(w, launched.deskRoot, hours)
          work.finally(() => child.emit("exit", 0))
          return child
        },
      })
      await launcher
      return {}
    },
  })
  if (work) await work
  return { result, launched }
}

async function prepare(w, hours, extra = {}) {
  const now = T0 + hours * HOUR
  return prepareTriage(w.env, {
    store: STORE, plan: await planTriage(w.env, { store: STORE, now }), ref: "main", direct: true,
    consent: { contribute: true }, status: await readStatus(w.env), now,
    client: { api: async () => ({ status: 200, json: { type: "file", encoding: "base64", content: Buffer.from('{"triage":1}\n').toString("base64") } }) },
    visibility: async (repos) => new Map(repos.map((repo) => [repo.toLowerCase(), "public"])),
    publishedJobs: () => new Set(), readMain: async () => ({ blobs: new Map(), unknown: false }), ...extra,
  })
}

test("legacy consenting work survives the first denied scoped pass through a real re-observation launch", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await updateStatus(w.env, (status) => ({ ...status,
    triage: { at: new Date(T0).toISOString(), ok: true, eligible: 3, runner: { state: "qualified" } },
    loop: { steps: { triage: { last_ran_at: new Date(T0).toISOString() } } },
  }))
  assert.equal((await observe(w, w.denied, 2)).result, "no_consenting_store")
  const before = await readStatus(w.env)
  assert.equal(before.triage_by_desk[scopeKey(w.deskRoot)], undefined, "no legacy success was assigned to the active scope")
  const selected = await launchSelected(w, scopeOf(w.deskRoot), 3)
  assert.equal(selected.result.kicked, true)
  assert.deepEqual(selected.launched, scopeOf(w.deskRoot), "the selected desk/person, not the launcher's ambient wrong root, receives work")
  const after = await readStatus(w.env)
  assert.equal(after.triage_by_desk[scopeKey(w.deskRoot)].counts.reviewed, 3)
  assert.equal(after.triage_by_desk[scopeKey(w.denied)].last_success_at, null)
})

test("wrong-context turns do not borrow another scope's due hint and the due context receives actual work", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await observe(w, w.denied, 0)
  await updateStatus(w.env, (status) => ({ ...status, triage_by_desk: { ...status.triage_by_desk,
    [scopeKey(w.deskRoot)]: { at: new Date(T0).toISOString(), ok: true, eligible: 3, runner: { state: "qualified" } },
  } }))
  let spawns = 0
  for (let turn = 0; turn < 5; turn++) {
    const result = await kickLoop(w.env, { scope: scopeOf(w.denied), now: T0 + (2 + turn / 3600) * HOUR, spawn: () => { spawns++; return {} } })
    assert.equal(result.kicked, false)
  }
  assert.equal(spawns, 0)
  const selected = await launchSelected(w, scopeOf(w.deskRoot), 3)
  assert.deepEqual(selected.launched, scopeOf(w.deskRoot))
  assert.equal((await readStatus(w.env)).triage_by_desk[scopeKey(w.deskRoot)].counts.reviewed, 3)
})

test("prepareTriage preserves pending bytes and new success age after an unrelated denied pass", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  assert.equal((await observe(w, w.deskRoot, 0)).reviewed, 3)
  const first = (await prepare(w, 1)).items[0]
  assert.equal(JSON.parse(first.bytes).runner.last_success_age, "recent")
  await observe(w, w.denied, 2)
  assert.equal((await readStatus(w.env)).triage.last_success_at, null)
  const again = (await prepare(w, 3)).items[0]
  assert.equal(again.path, first.path)
  assert.equal(again.sha, first.sha)
  await prepare(w, 4, { readMain: async () => ({ blobs: new Map([[first.path, first.sha]]), unknown: false }) })
  await updateTriageOutbox(w.env, STORE, "state.json", (state) => ({ ...state, published: { ...state.published, scan: "unreadable" } }))
  const fresh = (await prepare(w, 5)).items[0]
  assert.deepEqual(JSON.parse(fresh.bytes).rows, [])
  assert.equal(JSON.parse(fresh.bytes).runner.last_success_age, "recent")
})

test("a different scope's later success cannot freshen this store's public success witness", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await observe(w, w.deskRoot, 0)
  await updateStatus(w.env, (status) => ({ ...status, triage: { at: new Date(T0 + 30 * HOUR).toISOString(), last_success_at: new Date(T0 + 30 * HOUR).toISOString() } }))
  const first = (await prepare(w, 31)).items[0]
  assert.equal(JSON.parse(first.bytes).runner.last_success_age, "aging")
  const stored = await readTriageOutbox(w.env, STORE, "state.json")
  assert.equal(stored.scan_desk, w.deskRoot)
})

test("an explicitly different success store cannot borrow matching review metadata", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await observe(w, w.deskRoot, 0)
  const before = await readTriageOutbox(w.env, STORE, "state.json")
  const observation = (await readStatus(w.env)).triage_by_desk[scopeKey(w.deskRoot)]
  const later = new Date(T0 + 30 * HOUR).toISOString()
  await recordTriageCoverage(w.env, {
    store: STORE, deskRoot: w.deskRoot, personPrefix: "", coverage: before.coverage, counts: {},
    runner: "qualified", now: T0 + 30 * HOUR, lastSuccessAt: later, lastSuccessStore: "different/store",
    lastReview: { ...observation.last_review, at: later },
  })
  const kept = await readTriageOutbox(w.env, STORE, "state.json")
  assert.equal(kept.runner_success.at, before.runner_success.at)
  assert.equal(JSON.parse((await prepare(w, 31)).items[0].bytes).runner.last_success_age, "aging")
})

test("legacy outbox success requires scoped review metadata for this store", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await observe(w, w.deskRoot, 0)
  const observed = (await readStatus(w.env)).triage_by_desk[scopeKey(w.deskRoot)]
  await updateTriageOutbox(w.env, STORE, "state.json", ({ runner_success: _success, scan_person_prefix: _prefix, ...state }) => state)
  const known = JSON.parse((await prepare(w, 1)).items[0].bytes)
  assert.equal(known.runner.last_success_age, "recent")
  for (const scan of [
    { scan_desk: w.denied, scan_person_prefix: "" },
    { scan_desk: w.deskRoot, scan_person_prefix: "desks/other" },
  ]) {
    await updateTriageOutbox(w.env, STORE, "state.json", (state) => ({ ...state, ...scan }))
    const value = JSON.parse((await prepare(w, 2)).items[0].bytes)
    assert.equal(value.runner.last_success_age, "unknown")
  }
  await updateTriageOutbox(w.env, STORE, "state.json", (state) => ({ ...state, scan_desk: w.deskRoot, scan_person_prefix: "" }))
  for (const observation of [
    undefined,
    { ...observed, last_success_store: "different/store" },
    { ...observed, last_review: { ...observed.last_review, revision: observed.last_review.revision + 1 } },
    { ...observed, last_review: { ...observed.last_review, key: "andon:example-org/example-repo#9999" } },
    { ...observed, last_success_at: "unreadable" },
  ]) {
    await updateStatus(w.env, (status) => ({ ...status, triage_by_desk: { [scopeKey(w.deskRoot)]: observation } }))
    const value = JSON.parse((await prepare(w, 2)).items[0].bytes)
    assert.equal(value.runner.last_success_age, "unknown")
  }
})

test("a stored runner witness from another desk is unknown, not a fresh success", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await observe(w, w.deskRoot, 0)
  for (const wrong of [{ desk_root: w.denied }, { desk_root: w.deskRoot, store: "different/store" }]) {
    await updateTriageOutbox(w.env, STORE, "state.json", (state) => ({
      ...state, runner_success: { ...state.runner_success, ...wrong },
    }))
    const value = JSON.parse((await prepare(w, 1)).items[0].bytes)
    assert.equal(value.runner.last_success_age, "unknown")
  }
  await updateTriageOutbox(w.env, STORE, "state.json", (state) => ({
    ...state, runner_success: { store: STORE, desk_root: w.deskRoot, person_prefix: "", at: null },
  }))
  assert.equal(JSON.parse((await prepare(w, 1)).items[0].bytes).runner.last_success_age, "never")
  const before = await readTriageOutbox(w.env, STORE, "state.json")
  await recordTriageCoverage(w.env, {
    store: STORE, deskRoot: w.deskRoot, coverage: before.coverage, counts: {}, runner: "ran", now: T0 + HOUR,
  })
  assert.equal((await readTriageOutbox(w.env, STORE, "state.json")).runner_success.at, null)
})

test("legacy success restoration accepts only this desk's matching acknowledged review", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await observe(w, w.deskRoot, 0)
  const observation = (await readStatus(w.env)).triage_by_desk[scopeKey(w.deskRoot)]
  const before = await readTriageOutbox(w.env, STORE, "state.json")
  for (const review of [
    null,
    { ...observation.last_review, revision: observation.last_review.revision + 1 },
    observation.last_review,
  ]) {
    await updateTriageOutbox(w.env, STORE, "state.json", ({ runner_success: _success, ...state }) => state)
    await recordTriageCoverage(w.env, {
      store: STORE, deskRoot: w.deskRoot, coverage: before.coverage, counts: {}, runner: "qualified",
      now: T0 + HOUR, lastSuccessAt: observation.last_success_at, lastReview: review,
    })
    const kept = await readTriageOutbox(w.env, STORE, "state.json")
    assert.equal(kept.runner_success.at, review === observation.last_review ? observation.last_success_at : undefined)
  }
})

test("a scan without an owning desk retains valid requests and the prior witness", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await observe(w, w.deskRoot, 0)
  const before = await readTriageOutbox(w.env, STORE, "state.json")
  await recordTriageCoverage(w.env, {
    store: STORE, coverage: { scan: "truncated", reviewed: null, unreviewed: null, more_unreviewed: null },
    counts: {}, runner: null, now: T0 + HOUR,
  })
  const after = await readTriageOutbox(w.env, STORE, "state.json")
  assert.deepEqual(after.requests, before.requests)
  assert.deepEqual(after.runner_success, before.runner_success)
  assert.equal(after.scan_desk, undefined)
  assert.equal(after.coverage.scan, "truncated")
})

test("legacy mechanical re-observation retains unknown success history until a native review is acknowledged", { skip: NEEDS_PREPARED_RUN }, async () => {
  const w = await fixture()
  await recordTriageCoverage(w.env, {
    store: STORE, deskRoot: w.deskRoot, now: T0,
    coverage: { scan: "complete", reviewed: 0, unreviewed: 3 },
    counts: { reviewed: 0, refused: 0, deferred: 0 }, runner: "ran",
    lastSuccessAt: new Date(T0).toISOString(), lastSuccessStore: STORE,
  })
  await updateTriageOutbox(w.env, STORE, "state.json", (state) => ({ ...state, published: { scan: "unreadable" } }))
  assert.equal(JSON.parse((await prepare(w, 1)).items[0].bytes).runner.last_success_age, "recent")
  await updateTriageOutbox(w.env, STORE, "state.json", ({ runner_success: _witness, scan_person_prefix: _prefix, ...state }) => state)
  await updateStatus(w.env, (status) => ({
    ...status, triage_by_desk: undefined,
    triage: { last_success_at: new Date(T0).toISOString() },
  }))
  const unavailable = { loadRunner: async () => ({ state: "unavailable" }) }
  for (const hours of [2, 3]) {
    await observe(w, w.deskRoot, hours, unavailable)
    assert.equal(JSON.parse((await prepare(w, hours + 0.5)).items[0].bytes).runner.last_success_age, "unknown")
  }
  assert.equal((await observe(w, w.deskRoot, 4)).reviewed, 3)
  assert.equal(JSON.parse((await prepare(w, 5)).items[0].bytes).runner.last_success_age, "recent")
})
