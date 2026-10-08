// How waste labels travel like facts: the published session clock the
// evaluator cites, the labels' publishing transform, and the local labels
// files and evaluator briefs in the protected outbox. Every test runs against
// a throwaway HOME/XDG_STATE_HOME and synthetic fixtures only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { validateLabelsBytes } from "../../../../../plugins/desk/mcp/src/factory/label-schema.js"
import {
  clearEvaluation,
  evaluationPaths,
  factoryStateRoot,
  gitBlobSha,
  listEvaluationBriefs,
  markDelivered,
  pendingLabels,
  readEvaluationOutput,
  readLocalFacts,
  setConsent,
  writeEvaluationBrief,
  writeLocalFacts,
  writeLocalLabels,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { publishedClock, serializePublished, toPublished, toPublishedLabels } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { osEnv } from "../_os_env.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCAL = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const PUBLISHED = JSON.parse(readFileSync(path.join(here, "fixtures", "published-golden-v4.json"), "utf8"))
const LABELS = JSON.parse(readFileSync(path.join(here, "fixtures", "labels-golden.json"), "utf8"))
const STORE = "ourostack/factory"
const JOB = LABELS.job
const SESSION = LABELS.session
const NAME = `claude-code-${SESSION}.json`
const SECRET = Buffer.alloc(32, 7)

const local = () => structuredClone(LOCAL)
const labels = () => structuredClone(LABELS)

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-factory-labels-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  try {
    return await run(env, base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The published session clock.
// ---------------------------------------------------------------------------

test("publishedClock gives the golden session the published facts' duration and intervals", () => {
  const { clock } = publishedClock(local())
  assert.deepEqual(clock, { duration_ms: PUBLISHED.session.duration_ms, ended: true, intervals: PUBLISHED.intervals })
})

test("publishedClock drops the intervals toPublished drops and refuses what it refuses", () => {
  const skewed = local()
  skewed.intervals[0].start = "2026-09-25T07:59:00.000Z"
  const { clock } = publishedClock(skewed)
  const { published } = toPublished(skewed, { visibility: () => "unknown", deskVisibility: "private" })
  assert.deepEqual(clock.intervals, published.intervals)
  assert.equal(clock.intervals.length, LOCAL.intervals.length - 1)

  const open = local()
  open.session.ended_at = null
  open.session.end_reason = null
  assert.equal(publishedClock(open).clock.ended, false)

  const early = local()
  early.session.started_at = "2020-01-01T00:00:00.000Z"
  assert.deepEqual(publishedClock(early), { clock: null, reason: "implausible_session_span" })

  const notV4 = local()
  notV4.session.id = "3b0c1f5e-8a1d-1c2e-9f3a-1b2c3d4e5f60"
  assert.deepEqual(publishedClock(notV4), { clock: null, reason: "session_id_not_v4" })
})

test("publishedClock refuses invalid local facts without naming a value", () => {
  assert.throws(() => publishedClock({ schema: "SENTINEL" }), (error) => error instanceof TypeError && !error.message.includes("SENTINEL"))
})

// ---------------------------------------------------------------------------
// The labels' publishing transform.
// ---------------------------------------------------------------------------

test("a private desk's labels publish unchanged at labels/<job>/<session>.json", () => {
  const { path: file, published } = toPublishedLabels(labels(), { deskVisibility: "private" })
  assert.equal(file, `labels/${JOB}/${SESSION}.json`)
  assert.equal(serializePublished(published), readFileSync(path.join(here, "fixtures", "labels-golden.json"), "utf8"))
  assert.deepEqual(validateLabelsBytes(serializePublished(published)), { ok: true, errors: [] })
})

test("labels of a desk that is not surely private carry the same keyed job ID as its facts", () => {
  const keyed = createHmac("sha256", SECRET).update(JOB).digest("hex").slice(0, 32)
  const { published: facts } = toPublished(local(), { visibility: () => "unknown", deskVisibility: "public", machineSecret: SECRET })
  assert.ok(facts.jobs.some((job) => job.job === keyed))
  for (const deskVisibility of ["public", "unknown", undefined]) {
    const result = toPublishedLabels(labels(), { deskVisibility, machineSecret: SECRET })
    assert.equal(result.published.job, keyed)
    assert.equal(result.path, `labels/${keyed}/${SESSION}.json`)
  }
})

test("toPublishedLabels shares no object with its input and never mutates it", () => {
  const input = labels()
  const { published } = toPublishedLabels(input, { deskVisibility: "internal" })
  published.stretches[0].evidence[0][0] = 1
  published.unavailable.push("facts_missing")
  published.evaluator.rubric = "2"
  assert.deepEqual(input, LABELS)
})

test("a stretch's catch point publishes as written, and a stretch without one publishes without the key", () => {
  const { published } = toPublishedLabels(labels(), { deskVisibility: "private" })
  assert.equal(published.stretches[0].caught, "in_task")
  assert.equal(Object.hasOwn(published.stretches[1], "caught"), false)
  const unplaced = labels()
  delete unplaced.stretches[0].caught
  assert.equal(Object.hasOwn(toPublishedLabels(unplaced, { deskVisibility: "private" }).published.stretches[0], "caught"), false)
  const keyed = toPublishedLabels(labels(), { deskVisibility: "public", machineSecret: SECRET })
  assert.equal(keyed.published.stretches[0].caught, "in_task")
  assert.deepEqual(Object.keys(keyed.published.stretches[0]).slice(-4), ["evidence", "confidence", "evaluator_version", "caught"])
  // A /1 stretch publishes as it was: no confidence and no version appear.
  const legacy = labels()
  legacy.schema = "desk.factory.labels/1"
  legacy.evaluator.rubric = "1"
  for (const stretch of legacy.stretches) {
    delete stretch.confidence
    delete stretch.evaluator_version
  }
  assert.deepEqual(Object.keys(toPublishedLabels(legacy, { deskVisibility: "private" }).published.stretches[0]), ["start_ms", "end_ms", "class", "waste", "mura", "muri", "evidence", "caught"])
})

test("a catch point that is not one of the three codes is refused without naming it", () => {
  for (const value of ["SENTINEL", null, 3]) {
    const bad = labels()
    bad.stretches[0].caught = value
    assert.throws(() => toPublishedLabels(bad, { deskVisibility: "private" }), (error) => error instanceof TypeError && !error.message.includes("SENTINEL"))
  }
})

test("toPublishedLabels refuses invalid labels and a missing key without naming a value", () => {
  const bad = labels()
  bad.stretches[0].note = "SENTINEL"
  assert.throws(() => toPublishedLabels(bad, { deskVisibility: "private" }), (error) => error instanceof TypeError && !error.message.includes("SENTINEL"))
  assert.throws(() => toPublishedLabels(labels()), /machineSecret/u)
  assert.throws(() => toPublishedLabels(labels(), { deskVisibility: "public", machineSecret: Buffer.alloc(8) }), /machineSecret/u)
})

// ---------------------------------------------------------------------------
// Local facts and labels in the outbox.
// ---------------------------------------------------------------------------

test("readLocalFacts returns a consented store's local facts and null for anything else", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  assert.equal(await readLocalFacts(env, STORE, NAME), null)
  await writeLocalFacts(env, STORE, local())
  assert.deepEqual(await readLocalFacts(env, STORE, NAME), LOCAL)
  assert.equal(await readLocalFacts(env, STORE, "../consent.json"), null)
  const root = await factoryStateRoot(env)
  const file = path.join(root, "outbox", "ourostack__factory", NAME)
  await fs.writeFile(file, "{")
  assert.equal(await readLocalFacts(env, STORE, NAME), null)
  await fs.writeFile(file, JSON.stringify({ schema: "desk.factory.local/1" }))
  assert.equal(await readLocalFacts(env, STORE, NAME), null)
  await fs.rm(file)
  await fs.symlink(path.join(root, "consent.json"), file)
  await assert.rejects(readLocalFacts(env, STORE, NAME))
}))

test("writeLocalLabels writes valid labels only for a consented store, as canonical bytes", () => scratch(async (env) => {
  assert.deepEqual(await writeLocalLabels(env, STORE, labels()), { written: false, errors: [] })
  await setConsent(env, { store: STORE, contribute: false })
  assert.deepEqual(await writeLocalLabels(env, STORE, labels()), { written: false, errors: [] })
  await setConsent(env, { store: STORE, contribute: true })
  const bad = labels()
  bad.stretches[0].class = "SENTINEL"
  const refused = await writeLocalLabels(env, STORE, bad)
  assert.equal(refused.written, false)
  assert.deepEqual(refused.errors, [{ code: "enum", path: "stretches.0.class" }])
  assert.deepEqual(await writeLocalLabels(env, STORE, labels()), { written: true, name: `labels/${JOB}/${SESSION}.json` })
  const root = await factoryStateRoot(env)
  const file = path.join(root, "labels", "ourostack__factory", JOB, `${SESSION}.json`)
  assert.equal(await fs.readFile(file, "utf8"), `${JSON.stringify(LABELS)}\n`)
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
}))

test("pendingLabels lists local labels whose published bytes the store has not received", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const publish = (value) => serializePublished(toPublishedLabels(value, { deskVisibility: "private" }).published)
  assert.deepEqual(await pendingLabels(env, STORE, { publishedBytesFor: publish }), [])
  await writeLocalLabels(env, STORE, labels())
  const name = `labels/${JOB}/${SESSION}.json`
  const pending = await pendingLabels(env, STORE, { publishedBytesFor: publish })
  assert.deepEqual(pending.map((entry) => entry.name), [name])
  assert.equal(pending[0].localBytes.toString("utf8"), `${JSON.stringify(LABELS)}\n`)
  assert.deepEqual(await pendingLabels(env, STORE, { publishedBytesFor: () => null }), [])

  await markDelivered(env, STORE, { name, publishedBlobSha: gitBlobSha(publish(labels())) })
  assert.deepEqual(await pendingLabels(env, STORE, { publishedBytesFor: publish }), [])

  // Anything that is not a labels file of the right shape is skipped, never read.
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "labels", "ourostack__factory")
  await fs.mkdir(path.join(dir, "not-a-job"))
  await fs.writeFile(path.join(dir, "not-a-job", `${SESSION}.json`), "{}")
  await fs.writeFile(path.join(dir, JOB, "notes.txt"), "SENTINEL")
  await fs.writeFile(path.join(dir, "loose.json"), "{}")
  const otherSession = "4c1d2e6f-9b2e-4d3f-8a4b-2c3d4e5f6071"
  await fs.writeFile(path.join(dir, JOB, `${otherSession}.json`), "{")
  assert.deepEqual(await pendingLabels(env, STORE, { publishedBytesFor: publish }), [])
  await assert.rejects(pendingLabels(env, STORE, {}), /publishedBytesFor/u)
  await assert.rejects(pendingLabels(env, STORE), /publishedBytesFor/u)
}))

// ---------------------------------------------------------------------------
// Evaluator briefs and their outputs.
// ---------------------------------------------------------------------------

test("evaluation files live under evaluations/<job>/<store>/ and round-trip through the listing", () => scratch(async (env) => {
  const paths = await evaluationPaths(env, { job: JOB, store: STORE, name: NAME })
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "evaluations", JOB, "ourostack__factory")
  assert.deepEqual(paths, { brief: path.join(dir, `claude-code-${SESSION}.brief.json`), output: path.join(dir, `claude-code-${SESSION}.labels.json`) })
  assert.deepEqual(await listEvaluationBriefs(env, JOB), [])
  const brief = { schema: "desk.factory.evaluator-brief/1", output: paths.output }
  assert.equal(await writeEvaluationBrief(env, { job: JOB, store: STORE, name: NAME, brief }), paths.brief)
  assert.deepEqual(await listEvaluationBriefs(env, JOB), [{ store: STORE, name: NAME, brief, output: paths.output }])
  if (process.platform !== "win32") assert.equal((await fs.stat(paths.brief)).mode & 0o777, 0o600)

  // Only brief files of the right shape are listed; a corrupt brief is skipped.
  await fs.writeFile(path.join(dir, "notes.txt"), "x")
  await fs.writeFile(path.join(dir, `copilot-cli-${SESSION}.brief.json`), "{")
  await fs.mkdir(path.join(root, "evaluations", JOB, "not-a-store"))
  await fs.writeFile(path.join(root, "evaluations", JOB, "not-a-store", `claude-code-${SESSION}.brief.json`), "{}")
  assert.deepEqual((await listEvaluationBriefs(env, JOB)).map((entry) => [entry.name, entry.brief === null]), [[NAME, false], [`copilot-cli-${SESSION}.json`, true]].sort())

  assert.equal(await readEvaluationOutput(env, paths.output), null)
  await fs.writeFile(paths.output, "SENTINEL", { mode: 0o644 })
  assert.equal((await readEvaluationOutput(env, paths.output)).toString("utf8"), "SENTINEL")
  if (process.platform !== "win32") assert.equal((await fs.stat(paths.output)).mode & 0o777, 0o600)
  await assert.rejects(readEvaluationOutput(env, path.join(root, "consent.json")), /evaluation output/u)
  await assert.rejects(readEvaluationOutput(env, 42), /evaluation output/u)
  await assert.rejects(readEvaluationOutput(env, path.join(dir, `claude-code-${SESSION}.brief.json`)), /evaluation output/u)

  await clearEvaluation(env, { job: JOB, store: STORE, name: NAME })
  await clearEvaluation(env, { job: JOB, store: STORE, name: NAME })
  await assert.rejects(fs.stat(paths.brief), { code: "ENOENT" })
  await assert.rejects(fs.stat(paths.output), { code: "ENOENT" })
}))

test("evaluation files refuse a bad job, store or session name, and an oversized output", () => scratch(async (env) => {
  await assert.rejects(evaluationPaths(env, { job: "SENTINEL", store: STORE, name: NAME }), (error) => !error.message.includes("SENTINEL"))
  await assert.rejects(evaluationPaths(env, { job: JOB, store: "SENTINEL", name: NAME }), (error) => !error.message.includes("SENTINEL"))
  await assert.rejects(evaluationPaths(env, { job: JOB, store: STORE, name: "SENTINEL.json" }), (error) => !error.message.includes("SENTINEL"))
  await assert.rejects(listEvaluationBriefs(env, "SENTINEL"), (error) => !error.message.includes("SENTINEL"))
  const paths = await evaluationPaths(env, { job: JOB, store: STORE, name: NAME })
  await fs.mkdir(path.dirname(paths.output), { recursive: true })
  const handle = await fs.open(paths.output, "w")
  await handle.truncate(16 * 1024 * 1024 + 1)
  await handle.close()
  await assert.rejects(readEvaluationOutput(env, paths.output), /too large/u)
}))
