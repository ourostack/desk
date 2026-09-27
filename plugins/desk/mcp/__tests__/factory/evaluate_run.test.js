// The waste evaluator's local half: the bounded brief Desk hands a fresh
// `desk:observer`, and the validation path its answer must pass before it
// becomes local labels. Nothing the evaluator writes is echoed back: every
// rejection is `{ code, path }` only, and a rejected answer never reaches
// the outbox. Every input is synthetic; every test runs against a throwaway
// HOME/XDG_STATE_HOME.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  BRIEF_SCHEMA,
  EVALUATOR_SKILL,
  RUBRIC_VERSION,
  acceptEvaluation,
  acceptEvaluations,
  buildEvaluatorBrief,
  prepareEvaluation,
} from "../../src/factory/evaluate-run.js"
import { factoryStateRoot, setConsent, updateJobsIndex, writeLocalFacts, writeMarker } from "../../src/factory/outbox.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCAL = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const PUBLISHED = JSON.parse(readFileSync(path.join(here, "fixtures", "published-golden.json"), "utf8"))
const LABELS = JSON.parse(readFileSync(path.join(here, "fixtures", "labels-golden.json"), "utf8"))
const SKILL = readFileSync(path.join(here, "..", "..", "..", "skills", "factory-evaluator", "SKILL.md"), "utf8")
const STORE = "ourostack/factory"
const JOB = LABELS.job
const SESSION = LABELS.session
const NAME = `claude-code-${SESSION}.json`
const VERSION = LABELS.evaluator.plugin_version
const SENTINEL = "SENTINEL-evaluator-9c1e"
const LOG = "/tmp/m5-2-session.jsonl"
const OUTPUT = "/tmp/m5-2-output.labels.json"

const local = () => structuredClone(LOCAL)
const labels = () => structuredClone(LABELS)
const bytes = (value) => Buffer.from(JSON.stringify(value))

function brief(overrides = {}) {
  return buildEvaluatorBrief({ job: JOB, localFacts: local(), logPath: LOG, outputPath: OUTPUT, pluginVersion: VERSION, ...overrides })
}

function noEcho(value) {
  assert.equal(JSON.stringify(value).includes("SENTINEL"), false)
}

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-factory-evaluate-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run(env, base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------
// The brief builder.
// ---------------------------------------------------------------------------

test("the brief carries the job, the session on the published clock, the rubric and the output path", () => {
  const { counts } = LOCAL
  assert.deepEqual(brief(), {
    schema: BRIEF_SCHEMA,
    skill: EVALUATOR_SKILL,
    job: JOB,
    session: { host: "claude-code", id: SESSION },
    evaluator: { plugin_version: VERSION, rubric: RUBRIC_VERSION },
    session_log: LOG,
    clock_origin: LOCAL.session.started_at,
    facts: { duration_ms: PUBLISHED.session.duration_ms, ended: true, intervals: PUBLISHED.intervals, counts },
    unavailable: [],
    output: OUTPUT,
  })
})

test("the brief's intervals are exactly the published facts' intervals, so cited evidence matches the store", () => {
  const skewed = local()
  skewed.intervals[0].start = "2026-09-25T07:59:00.000Z"
  const { facts } = brief({ localFacts: skewed })
  assert.equal(facts.intervals.length, LOCAL.intervals.length - 1)
  assert.ok(facts.intervals.every((interval) => Number.isSafeInteger(interval.start_ms) && Number.isSafeInteger(interval.end_ms)))
})

test("the brief says what the evaluator cannot read: a missing log, facts the store will never hold", () => {
  assert.deepEqual(brief({ logPath: null }).unavailable, ["session_log_missing"])
  assert.equal(brief({ logPath: null }).session_log, null)
  const early = local()
  early.session.started_at = "2020-01-01T00:00:00.000Z"
  const missing = brief({ localFacts: early, logPath: null })
  assert.equal(missing.facts, null)
  assert.equal(missing.clock_origin, null)
  assert.deepEqual(missing.unavailable, ["session_log_missing", "facts_missing"])
})

test("a session whose ID could never be published gets no brief", () => {
  const notV4 = local()
  notV4.session.id = "3b0c1f5e-8a1d-1c2e-9f3a-1b2c3d4e5f60"
  assert.equal(brief({ localFacts: notV4 }), null)
})

test("the brief builder's caller contracts throw without naming a value", () => {
  const unbound = local()
  unbound.jobs = unbound.jobs.filter((job) => job.job !== JOB)
  for (const overrides of [
    { job: SENTINEL },
    { localFacts: { schema: SENTINEL } },
    { localFacts: unbound },
    { logPath: `relative/${SENTINEL}` },
    { outputPath: `relative/${SENTINEL}` },
    { pluginVersion: `3.2.0-${SENTINEL}` },
  ]) {
    assert.throws(() => brief(overrides), (error) => error instanceof TypeError && !error.message.includes("SENTINEL"))
  }
})

test("the rubric the skill states is the rubric version labels carry", () => {
  assert.equal(RUBRIC_VERSION, "1")
  assert.match(SKILL, new RegExp(`^Rubric version: ${RUBRIC_VERSION}$`, "mu"))
  assert.match(SKILL, /^name: factory-evaluator$/mu)
  assert.equal(EVALUATOR_SKILL, "desk:factory-evaluator")
})

// ---------------------------------------------------------------------------
// The validation path: accept.
// ---------------------------------------------------------------------------

test("labels that match the brief are accepted and returned as a canonical copy", () => {
  const result = acceptEvaluation(brief(), bytes(labels()))
  assert.deepEqual(result, { ok: true, errors: [], labels: LABELS })
  const pretty = acceptEvaluation(brief(), Buffer.from(`${JSON.stringify(labels(), null, 2)}\n`))
  assert.deepEqual(pretty, { ok: true, errors: [], labels: LABELS })
  assert.deepEqual(acceptEvaluation(brief(), JSON.stringify(labels())).ok, true)
})

test("labels that declare what the brief could not read are accepted", () => {
  const withoutLog = labels()
  withoutLog.unavailable = ["session_log_missing"]
  assert.equal(acceptEvaluation(brief({ logPath: null }), bytes(withoutLog)).ok, true)

  const early = local()
  early.session.started_at = "2020-01-01T00:00:00.000Z"
  const empty = { ...labels(), stretches: [], unavailable: ["facts_missing"] }
  assert.equal(acceptEvaluation(brief({ localFacts: early }), bytes(empty)).ok, true)
})

// ---------------------------------------------------------------------------
// The validation path: reject.
// ---------------------------------------------------------------------------

test("bytes that are not JSON, or too large, are rejected before anything is parsed further", () => {
  assert.deepEqual(acceptEvaluation(brief(), Buffer.from(`not json ${SENTINEL}`)), { ok: false, errors: [{ code: "json", path: "" }] })
  const huge = Buffer.alloc(16 * 1024 * 1024 + 1, 0x20)
  assert.deepEqual(acceptEvaluation(brief(), huge), { ok: false, errors: [{ code: "too_large", path: "" }] })
  assert.throws(() => acceptEvaluation(brief(), 42), TypeError)
})

test("labels that fail the labels schema are rejected with its codes", () => {
  const bad = labels()
  bad.stretches[1].waste = "waiting"
  assert.deepEqual(acceptEvaluation(brief(), bytes(bad)), { ok: false, errors: [{ code: "inconsistent", path: "stretches.1.waste" }] })
})

test("labels for another job or session, or from another evaluator version or rubric, are rejected", () => {
  const other = labels()
  other.job = "5e6f708192a3b4c5d6e7f8091a2b3c4d"
  other.session = "4c1d2e6f-9b2e-4d3f-8a4b-2c3d4e5f6071"
  other.evaluator.plugin_version = "3.2.0-alpha.41"
  other.evaluator.rubric = "2"
  assert.deepEqual(acceptEvaluation(brief(), bytes(other)).errors, [
    { code: "job_mismatch", path: "job" },
    { code: "session_mismatch", path: "session" },
    { code: "evaluator_mismatch", path: "evaluator.plugin_version" },
    { code: "evaluator_mismatch", path: "evaluator.rubric" },
  ])
})

test("labels must declare what the brief says is unavailable, and never claim facts the brief holds are missing", () => {
  assert.deepEqual(acceptEvaluation(brief({ logPath: null }), bytes(labels())).errors, [{ code: "inconsistent", path: "unavailable" }])
  const claimsMissing = { ...labels(), stretches: [], unavailable: ["facts_missing"] }
  assert.deepEqual(acceptEvaluation(brief(), bytes(claimsMissing)).errors, [{ code: "inconsistent", path: "unavailable" }])
})

test("evidence that is not exactly one interval of the brief, and a stretch past the session, are rejected", () => {
  const bad = labels()
  bad.stretches[0].evidence = [[5000, 9001]]
  bad.stretches[3].end_ms = PUBLISHED.session.duration_ms + 1
  assert.deepEqual(acceptEvaluation(brief(), bytes(bad)).errors, [
    { code: "evidence_unmatched", path: "stretches.0.evidence.0" },
    { code: "range", path: "stretches.3.end_ms" },
  ])
})

// ---------------------------------------------------------------------------
// The no-echo sentinel.
// ---------------------------------------------------------------------------

test("no rejection echoes what the evaluator wrote, wherever it planted free text", () => {
  const plants = [
    (value) => { value.note = SENTINEL },
    (value) => { value[SENTINEL] = true },
    (value) => { value.stretches[0].reason = SENTINEL },
    (value) => { value.stretches[0].class = SENTINEL },
    (value) => { value.stretches[0].waste = SENTINEL },
    (value) => { value.evaluator.model = `${SENTINEL} with spaces` },
    (value) => { value.evaluator.rubric = SENTINEL },
    (value) => { value.job = SENTINEL },
    (value) => { value.session = SENTINEL },
    (value) => { value.unavailable = [SENTINEL] },
    (value) => { value.stretches[0].evidence = [[SENTINEL, 9000]] },
  ]
  for (const plant of plants) {
    const value = labels()
    plant(value)
    const result = acceptEvaluation(brief(), bytes(value))
    assert.equal(result.ok, false)
    assert.equal(Object.hasOwn(result, "labels"), false)
    noEcho(result)
  }
  noEcho(acceptEvaluation(brief(), Buffer.from(`{"note": "${SENTINEL}"`)))
})

test("a duplicated key cannot carry free text through: accepted labels are rebuilt from what parses", () => {
  const text = JSON.stringify(labels()).replace('"schema":', `"schema":"${SENTINEL}","schema":`)
  const result = acceptEvaluation(brief(), Buffer.from(text))
  assert.equal(result.ok, true)
  noEcho(result)
})

// ---------------------------------------------------------------------------
// Preparing briefs and accepting answers on this machine.
// ---------------------------------------------------------------------------

async function seed(env, { marker = true } = {}) {
  await setConsent(env, { store: STORE, contribute: true })
  await writeLocalFacts(env, STORE, local())
  await updateJobsIndex(env, JOB, NAME)
  if (marker) {
    const log = path.join(env.HOME, "m5-2-session.jsonl")
    await fs.writeFile(log, "{}\n")
    await writeMarker(env, {
      schema_version: 1, host: "claude-code", session_id: SESSION, log_path: log, cwd: env.HOME, desk_root: null,
      end_reason: "prompt_input_exit", ended_at: "2026-09-25T09:30:00.000Z", plugins: [], updated_at: "2026-09-25T09:30:00.000Z",
    })
    return log
  }
  return null
}

test("prepareEvaluation needs a consented store and a session of the job", () => scratch(async (env) => {
  assert.deepEqual(await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION }), { result: "not_opted_in", job: JOB, briefs: [] })
  await setConsent(env, { store: STORE, contribute: false })
  assert.deepEqual(await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION }), { result: "not_opted_in", job: JOB, briefs: [] })
  await setConsent(env, { store: STORE, contribute: true })
  assert.deepEqual(await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION }), { result: "no_sessions", job: JOB, briefs: [] })
  await updateJobsIndex(env, JOB, NAME)
  assert.deepEqual(await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION }), { result: "no_sessions", job: JOB, briefs: [] })
  await assert.rejects(prepareEvaluation(env, { job: SENTINEL, pluginVersion: VERSION }), (error) => !error.message.includes("SENTINEL"))
}))

test("prepareEvaluation writes one brief per session, pointing at the host log when its marker still names one", () => scratch(async (env) => {
  const log = await seed(env)
  const prepared = await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "evaluations", JOB, "ourostack__factory")
  assert.deepEqual(prepared, { result: "ready", job: JOB, briefs: [path.join(dir, `claude-code-${SESSION}.brief.json`)] })
  const written = JSON.parse(await fs.readFile(prepared.briefs[0], "utf8"))
  assert.deepEqual(written, brief({ logPath: log, outputPath: path.join(dir, `claude-code-${SESSION}.labels.json`) }))

  await fs.rm(log)
  await fs.mkdir(log)
  const again = JSON.parse(await fs.readFile((await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).briefs[0], "utf8"))
  assert.equal(again.session_log, null)
  assert.deepEqual(again.unavailable, ["session_log_missing"])
}))

test("prepareEvaluation reads the log as missing without a marker and skips a session that can never publish", () => scratch(async (env) => {
  await seed(env, { marker: false })
  const [file] = (await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).briefs
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).session_log, null)

  const notV4 = local()
  notV4.session.id = "3b0c1f5e-8a1d-1c2e-9f3a-1b2c3d4e5f60"
  await writeLocalFacts(env, STORE, notV4)
  await updateJobsIndex(env, JOB, `claude-code-${notV4.session.id}.json`)
  assert.equal((await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).briefs.length, 1)
}))

test("acceptEvaluations turns a valid answer into local labels and clears the brief", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "evaluations", JOB, "ourostack__factory")
  const output = path.join(dir, `claude-code-${SESSION}.labels.json`)
  assert.deepEqual(await acceptEvaluations(env, { job: JOB }), { job: JOB, sessions: [{ session: SESSION, result: "missing" }] })

  await fs.writeFile(output, JSON.stringify(labels(), null, 2))
  assert.deepEqual(await acceptEvaluations(env, { job: JOB }), { job: JOB, sessions: [{ session: SESSION, result: "accepted" }] })
  const stored = path.join(root, "labels", "ourostack__factory", JOB, `${SESSION}.json`)
  assert.equal(await fs.readFile(stored, "utf8"), `${JSON.stringify(LABELS)}\n`)
  assert.deepEqual(await fs.readdir(dir), [])
  assert.deepEqual(await acceptEvaluations(env, { job: JOB }), { job: JOB, sessions: [] })
}))

test("a rejected answer stays out of the outbox, keeps its brief for a retry and is never echoed", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const root = await factoryStateRoot(env)
  const output = path.join(root, "evaluations", JOB, "ourostack__factory", `claude-code-${SESSION}.labels.json`)
  const bad = labels()
  bad.stretches[0].note = SENTINEL
  await fs.writeFile(output, JSON.stringify(bad))
  const result = await acceptEvaluations(env, { job: JOB })
  assert.deepEqual(result, { job: JOB, sessions: [{ session: SESSION, result: "rejected", errors: [{ code: "unknown_key", path: "stretches.0" }] }] })
  noEcho(result)
  await assert.rejects(fs.stat(path.join(root, "labels")), { code: "ENOENT" })
  assert.equal((await fs.readdir(path.dirname(output))).length, 2)
}))

test("an answer accepted after consent is withdrawn is not written", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "evaluations", JOB, "ourostack__factory", `claude-code-${SESSION}.labels.json`), JSON.stringify(labels()))
  await setConsent(env, { store: STORE, contribute: false })
  assert.deepEqual(await acceptEvaluations(env, { job: JOB }), { job: JOB, sessions: [{ session: SESSION, result: "not_opted_in" }] })
  await assert.rejects(fs.stat(path.join(root, "labels")), { code: "ENOENT" })
}))

test("a brief file that no longer names its job and session is reported, not trusted", () => scratch(async (env) => {
  await seed(env)
  const [file] = (await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).briefs
  const original = JSON.parse(await fs.readFile(file, "utf8"))
  for (const edit of [
    () => [],
    (value) => ({ ...value, schema: "other" }),
    (value) => ({ ...value, job: "5e6f708192a3b4c5d6e7f8091a2b3c4d" }),
    (value) => ({ ...value, session: { host: "copilot-cli", id: SESSION } }),
    (value) => ({ ...value, session: null }),
  ]) {
    await fs.writeFile(file, JSON.stringify(edit(structuredClone(original))))
    assert.deepEqual(await acceptEvaluations(env, { job: JOB }), { job: JOB, sessions: [{ session: SESSION, result: "invalid_brief" }] })
  }
}))
