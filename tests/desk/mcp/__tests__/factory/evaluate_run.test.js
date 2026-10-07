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
  evaluatePending,
  evaluateTask,
  prepareEvaluation,
} from "../../../../../plugins/desk/mcp/src/factory/evaluate-run.js"
import {
  clearEvaluationRequest,
  expireEvaluationRequest,
  factoryStateRoot,
  listEvaluationRequests,
  quarantine,
  requestEvaluation,
  setConsent,
  writeLocalFacts,
  writeMarker,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { indexJob } from "./_index_helper.js"
import { osEnv } from "../_os_env.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCAL = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const PUBLISHED = JSON.parse(readFileSync(path.join(here, "fixtures", "published-golden.json"), "utf8"))
const LABELS = JSON.parse(readFileSync(path.join(here, "fixtures", "labels-golden.json"), "utf8"))
const SKILL = readFileSync(path.join(here, "../../../../../plugins/desk/skills/factory-evaluator/SKILL.md"), "utf8")
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
// What Desk accepts when it cannot place a stretch: the evaluator's own `caught` is never kept.
const UNSTAMPED = structuredClone(LABELS)
for (const stretch of UNSTAMPED.stretches) delete stretch.caught
const bytes = (value) => Buffer.from(JSON.stringify(value))

function brief(overrides = {}) {
  return buildEvaluatorBrief({ job: JOB, localFacts: local(), logPath: LOG, outputPath: OUTPUT, pluginVersion: VERSION, ...overrides })
}

function noEcho(value) {
  assert.equal(JSON.stringify(value).includes("SENTINEL"), false)
}

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-factory-evaluate-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
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
    own_share: null,
    unavailable: [],
    output: OUTPUT,
  })
})

test("the brief names the job's own share of the session when its binding records segments, and none without facts", () => {
  const shared = local()
  const binding = shared.jobs.find((bound) => bound.job === JOB)
  binding.agents = [0]
  binding.segments = [{ start_ms: 0, end_ms: 1000 }, { start_ms: 5000, end_ms: 6000, shared: true }]
  assert.deepEqual(brief({ localFacts: shared }).own_share, [{ start_ms: 0, end_ms: 1000 }, { start_ms: 5000, end_ms: 6000 }])
  shared.session.started_at = "2020-01-01T00:00:00.000Z"
  assert.equal(brief({ localFacts: shared }).own_share, null, "a session the store will never hold has no share to label")
})

test("the brief's share follows the store: a sole binding from before workers were recorded owns the session, a subagent-only one has none", () => {
  const sole = local()
  sole.jobs = sole.jobs.filter((bound) => bound.job === JOB)
  assert.deepEqual(brief({ localFacts: sole }).own_share, [{ start_ms: 0, end_ms: PUBLISHED.session.duration_ms }])
  sole.jobs[0].agents = [1]
  assert.equal(brief({ localFacts: sole }).own_share, null)
  assert.equal(brief().own_share, null, "one of several bindings without segments has no known share")
  // With no share to credit, the evaluator writes no stretches, and that answer is accepted.
  const empty = { ...labels(), stretches: [] }
  assert.equal(acceptEvaluation(brief({ localFacts: sole }), bytes(empty)).ok, true)
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

test("a Codex session (v7 id) gets no brief and is skipped when evaluations are prepared", () => scratch(async (env) => {
  const codex = local()
  codex.session.id = "01927a3b-8c00-7abc-8def-0123456789ab"
  codex.session.host = "codex-cli"
  assert.equal(brief({ localFacts: codex }), null)
  await seed(env, { marker: false })
  await writeLocalFacts(env, STORE, codex)
  await indexJob(env, JOB, `codex-cli-${codex.session.id}.json`)
  assert.equal((await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).briefs.length, 1, "only the seeded Claude session")
}))

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
  assert.equal(RUBRIC_VERSION, "2")
  assert.match(SKILL, new RegExp(`^Rubric version: ${RUBRIC_VERSION}$`, "mu"))
  assert.match(SKILL, /^name: factory-evaluator$/mu)
  assert.equal(EVALUATOR_SKILL, "desk:factory-evaluator")
})

// ---------------------------------------------------------------------------
// The validation path: accept.
// ---------------------------------------------------------------------------

test("labels that match the brief are accepted and returned as a canonical copy", () => {
  const result = acceptEvaluation(brief(), bytes(labels()))
  assert.deepEqual(result, { ok: true, errors: [], labels: UNSTAMPED })
  const pretty = acceptEvaluation(brief(), Buffer.from(`${JSON.stringify(labels(), null, 2)}\n`))
  assert.deepEqual(pretty, { ok: true, errors: [], labels: UNSTAMPED })
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
  other.evaluator.rubric = "3"
  assert.deepEqual(acceptEvaluation(brief(), bytes(other)).errors, [
    { code: "job_mismatch", path: "job" },
    { code: "session_mismatch", path: "session" },
    { code: "evaluator_mismatch", path: "evaluator.plugin_version" },
    { code: "evaluator_mismatch", path: "evaluator.rubric" },
  ])
})

test("an answer in the older labels form is refused, and every stretch must carry the brief's version", () => {
  const old = labels()
  old.schema = "desk.factory.labels/1"
  for (const stretch of old.stretches) {
    delete stretch.confidence
    delete stretch.evaluator_version
    delete stretch.caught
  }
  assert.deepEqual(acceptEvaluation(brief(), bytes(old)), { ok: false, errors: [{ code: "schema_outdated", path: "schema" }] })
  const older = labels()
  older.stretches[1].evaluator_version = "3.2.0-alpha.39"
  older.stretches[3].evaluator_version = "3.1.0"
  assert.deepEqual(acceptEvaluation(brief(), bytes(older)).errors, [
    { code: "evaluator_mismatch", path: "stretches.1.evaluator_version" },
    { code: "evaluator_mismatch", path: "stretches.3.evaluator_version" },
  ])
  // An accepted answer keeps each label's confidence and version, and the "could not tell" label as written.
  const unsure = labels()
  unsure.stretches[2] = { ...unsure.stretches[2], class: "unknown", waste: "unknown", confidence: "low" }
  const accepted = acceptEvaluation(brief(), bytes(unsure))
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.labels.stretches.map((stretch) => [stretch.class, stretch.confidence, stretch.evaluator_version]), [
    ["muda", "high", VERSION], ["value", "medium", VERSION], ["unknown", "low", VERSION], ["support", "high", VERSION],
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
  await indexJob(env, JOB, NAME)
  if (marker) {
    const log = path.join(env.HOME, "m5-2-session.jsonl")
    await fs.writeFile(log, "{}\n")
    await writeMarker(env, {
      schema_version: 1, host: "claude-code", session_id: SESSION, log_path: log, cwd: env.HOME, desk_root: null,
      end_reason: "prompt_input_exit", ended_at: "2026-09-25T09:30:00.000Z", plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString(),
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
  await indexJob(env, JOB, NAME)
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
  await indexJob(env, JOB, `claude-code-${notV4.session.id}.json`)
  assert.equal((await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).briefs.length, 1)
}))

test("acceptEvaluations turns a valid answer into local labels and clears the brief", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "evaluations", JOB, "ourostack__factory")
  const output = path.join(dir, `claude-code-${SESSION}.labels.json`)
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), { job: JOB, sessions: [{ session: SESSION, result: "missing" }], request: "kept" })

  await fs.writeFile(output, JSON.stringify(labels(), null, 2))
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), { job: JOB, sessions: [{ session: SESSION, result: "accepted" }], request: "cleared" })
  const stored = path.join(root, "labels", "ourostack__factory", JOB, `${SESSION}.json`)
  assert.equal(await fs.readFile(stored, "utf8"), `${JSON.stringify(UNSTAMPED)}\n`)
  assert.deepEqual(await fs.readdir(dir), [])
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), { job: JOB, sessions: [], request: "cleared" })
  assert.deepEqual(await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION }), { result: "complete", job: JOB, briefs: [] })
}))

test("a rejected answer stays out of the outbox, keeps its brief for a retry and is never echoed", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const root = await factoryStateRoot(env)
  const output = path.join(root, "evaluations", JOB, "ourostack__factory", `claude-code-${SESSION}.labels.json`)
  const bad = labels()
  bad.stretches[0].note = SENTINEL
  await fs.writeFile(output, JSON.stringify(bad))
  const result = await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })
  assert.deepEqual(result, { job: JOB, sessions: [{ session: SESSION, result: "rejected", errors: [{ code: "unknown_key", path: "stretches.0" }] }], request: "kept" })
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
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), { job: JOB, sessions: [{ session: SESSION, result: "not_opted_in" }], request: "kept" })
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
    assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), { job: JOB, sessions: [{ session: SESSION, result: "invalid_brief" }], request: "kept" })
  }
}))

// ---------------------------------------------------------------------------
// Review fix round 1: facts read at accept time, evaluation requests, edges.
// ---------------------------------------------------------------------------

async function answer(env, value) {
  const root = await factoryStateRoot(env)
  const dir = path.join(root, "evaluations", JOB, "ourostack__factory")
  const output = path.join(dir, `claude-code-${SESSION}.labels.json`)
  await fs.writeFile(output, typeof value === "string" ? value : JSON.stringify(value))
  return { dir, output, brief: path.join(dir, `claude-code-${SESSION}.brief.json`), root }
}

test("an edited brief cannot change what the answer is checked against", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const forged = labels()
  forged.stretches[0].evidence = [[1, 2]]
  const { brief } = await answer(env, forged)
  const original = JSON.parse(await fs.readFile(brief, "utf8"))
  const rejected = { job: JOB, sessions: [{ session: SESSION, result: "rejected", errors: [{ code: "evidence_unmatched", path: "stretches.0.evidence.0" }] }], request: "kept" }
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), rejected)

  const widened = structuredClone(original)
  widened.facts.intervals.push({ kind: "turn", agent: 0, start_ms: 1, end_ms: 2 })
  await fs.writeFile(brief, JSON.stringify(widened))
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), rejected)

  await fs.writeFile(brief, JSON.stringify({ ...original, facts: null, unavailable: [] }))
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), rejected)
}))

test("a brief written before the rubric changed cannot let /2 labels through as the older rubric", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const stale = labels()
  stale.evaluator.rubric = "1"
  const { brief } = await answer(env, stale)
  const written = JSON.parse(await fs.readFile(brief, "utf8"))
  await fs.writeFile(brief, JSON.stringify({ ...written, evaluator: { ...written.evaluator, rubric: "1" } }))
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), {
    job: JOB, sessions: [{ session: SESSION, result: "rejected", errors: [{ code: "evaluator_mismatch", path: "evaluator.rubric" }] }], request: "kept",
  })
}))

test("an answer whose session facts are gone is refused as facts_missing", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const { root } = await answer(env, labels())
  await fs.rm(path.join(root, "outbox", "ourostack__factory", NAME))
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), {
    job: JOB, sessions: [{ session: SESSION, result: "rejected", errors: [{ code: "facts_missing", path: "" }] }], request: "kept",
  })
}))

test("an unreadable answer or brief is one session's result, not a failed run", () => scratch(async (env) => {
  await seed(env)
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const { output, brief, root } = await answer(env, "x")
  const handle = await fs.open(output, "w")
  await handle.truncate(16 * 1024 * 1024 + 1)
  await handle.close()
  assert.deepEqual((await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })).sessions, [{ session: SESSION, result: "rejected", errors: [{ code: "too_large", path: "" }] }])
  await fs.rm(output)
  await fs.symlink(path.join(root, "consent.json"), output)
  assert.deepEqual((await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })).sessions, [{ session: SESSION, result: "rejected", errors: [{ code: "unsafe_file", path: "" }] }])
  await fs.writeFile(brief, "{")
  assert.deepEqual((await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })).sessions, [{ session: SESSION, result: "invalid_brief" }])
}))

test("the done step creates nothing without factory state or consent", () => scratch(async (env, base) => {
  const deskRoot = path.join(base, "desk")
  assert.deepEqual(await evaluateTask(env, { job: JOB, deskRoot, pluginVersion: VERSION }), { result: "not_opted_in", job: JOB, briefs: [] })
  await assert.rejects(fs.stat(path.join(base, "state", "ouroboros-skills")), { code: "ENOENT" })
  await factoryStateRoot(env)
  assert.equal((await evaluateTask(env, { job: JOB, deskRoot, pluginVersion: VERSION })).result, "not_opted_in")
  assert.deepEqual(await listEvaluationRequests(env), [])
}))

test("the done step keeps the job's request until every session has ended and has labels", () => scratch(async (env, base) => {
  const deskRoot = path.join(base, "desk")
  await setConsent(env, { store: STORE, contribute: true })
  assert.deepEqual(await evaluateTask(env, { job: JOB, deskRoot, pluginVersion: VERSION }), { result: "no_sessions", job: JOB, briefs: [] })
  assert.deepEqual((await listEvaluationRequests(env)).map((request) => request.job), [JOB])

  // The finishing session is derived later, still open.
  const open = local()
  open.session.ended_at = null
  open.session.end_reason = null
  await writeLocalFacts(env, STORE, open)
  await indexJob(env, JOB, NAME)
  const labelsOpen = { ...labels(), unavailable: ["session_log_missing"] }
  labelsOpen.stretches = labelsOpen.stretches.slice(0, 1)
  const [pending] = (await evaluatePending(env, { pluginVersion: VERSION })).jobs
  assert.equal(pending.result, "ready")
  await answer(env, labelsOpen)
  assert.equal((await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })).request, "kept")
  assert.equal((await evaluateTask(env, { job: JOB, deskRoot, pluginVersion: VERSION })).result, "ready")

  // Once the session has ended and its labels are accepted, the request is cleared.
  await writeLocalFacts(env, STORE, local())
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  await answer(env, labelsOpen)
  assert.equal((await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })).request, "cleared")
  assert.deepEqual(await listEvaluationRequests(env), [])
  assert.deepEqual(await evaluateTask(env, { job: JOB, deskRoot, pluginVersion: VERSION }), { result: "complete", job: JOB, briefs: [] })
  assert.deepEqual(await listEvaluationRequests(env), [])
}))

test("pending requests are cleared when complete and quarantined when expired or without consent", () => scratch(async (env, base) => {
  const deskRoot = path.join(base, "desk")
  const other = "5e6f708192a3b4c5d6e7f8091a2b3c4d"
  await setConsent(env, { store: STORE, contribute: true })
  const first = await requestEvaluation(env, { job: JOB, deskRoot })
  assert.equal((await requestEvaluation(env, { job: JOB, deskRoot })).requested_at, first.requested_at)
  await requestEvaluation(env, { job: other, deskRoot })
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "evaluate-requests", "c0ffee00c0ffee00c0ffee00c0ffee00.json"), JSON.stringify({ job: "c0ffee00c0ffee00c0ffee00c0ffee00", desk_root: deskRoot }))
  await fs.writeFile(path.join(root, "evaluate-requests", "d0ffee00c0ffee00c0ffee00c0ffee00.json"), JSON.stringify({ job: "c0ffee00c0ffee00c0ffee00c0ffee00" }))
  assert.deepEqual((await listEvaluationRequests(env)).map((request) => request.job).sort(), [other, JOB].sort())

  assert.deepEqual((await evaluatePending(env, { pluginVersion: VERSION })).jobs.map((job) => job.result), ["no_sessions", "no_sessions"])
  const later = Date.parse(first.requested_at) + 31 * 24 * 60 * 60 * 1000
  assert.deepEqual((await evaluatePending(env, { pluginVersion: VERSION, now: later })).jobs.map((job) => job.result), ["expired", "expired"])
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "evaluate-requests", "expired", `${JOB}.json`), "utf8")).reason, "expired")
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "evaluate-requests", "expired", `${other}.json`), "utf8")).reason, "expired")
  await assert.rejects(fs.stat(path.join(root, "evaluate-requests", "quarantine", `${JOB}.json`)), "an expired request is not in the unread quarantine folder")
  assert.deepEqual(await listEvaluationRequests(env), [], "an expired request is no longer waiting")

  await requestEvaluation(env, { job: JOB, deskRoot })
  await setConsent(env, { store: STORE, contribute: false })
  assert.deepEqual((await evaluatePending(env, { pluginVersion: VERSION })).jobs.map((job) => job.result), ["not_opted_in"])
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "evaluate-requests", "quarantine", `${JOB}.json`), "utf8")).reason, "not_opted_in")

  await seed(env)
  await requestEvaluation(env, { job: JOB, deskRoot })
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  await answer(env, labels())
  await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })
  await requestEvaluation(env, { job: JOB, deskRoot })
  assert.deepEqual((await evaluatePending(env, { pluginVersion: VERSION })).jobs, [{ result: "complete", job: JOB, briefs: [] }])
  assert.deepEqual(await listEvaluationRequests(env), [])
  await assert.rejects(clearEvaluationRequest(env, JOB, "Not A Code"), /reason/u)
  await assert.rejects(expireEvaluationRequest(env, "not a job"), /job/u)
}))

test("a session of another job in the index, or one that can never publish, is not counted", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const unbound = local()
  unbound.jobs = unbound.jobs.filter((job) => job.job !== JOB)
  await writeLocalFacts(env, STORE, unbound)
  await indexJob(env, JOB, NAME)
  assert.equal((await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).result, "no_sessions")
  assert.deepEqual(await acceptEvaluations(env, { job: "5e6f708192a3b4c5d6e7f8091a2b3c4d", pluginVersion: VERSION }), { job: "5e6f708192a3b4c5d6e7f8091a2b3c4d", sessions: [], request: "kept" })
}))

test("a session whose facts are quarantined is not briefed: its labels are quarantined naming the facts, and the request is settled", () => scratch(async (env, base) => {
  const deskRoot = path.join(base, "desk")
  await seed(env)
  await quarantine(env, STORE, NAME, "evidence_unmatched")
  // A name that is not an outbox file name holds nothing back and is not a session.
  await indexJob(env, JOB, "bogus")
  assert.deepEqual(await evaluateTask(env, { job: JOB, deskRoot, pluginVersion: VERSION }), { result: "complete", job: JOB, briefs: [] })
  assert.deepEqual(await listEvaluationRequests(env), [])
  const root = await factoryStateRoot(env)
  const record = JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", "labels", JOB, `${SESSION}.json`), "utf8"))
  assert.deepEqual([record.reason, record.facts], ["facts_quarantined", NAME])
  await assert.rejects(fs.stat(path.join(root, "evaluations", JOB)), { code: "ENOENT" })

  // Facts too broken to read, but quarantined, hold their labels back too.
  const broken = "copilot-cli-00000009-0000-4000-8000-000000000009.json"
  await fs.writeFile(path.join(root, "outbox", "ourostack__factory", broken), "not json", { mode: 0o600 })
  await quarantine(env, STORE, broken, "invalid")
  await indexJob(env, JOB, broken)
  await requestEvaluation(env, { job: JOB, deskRoot })
  assert.deepEqual((await evaluatePending(env, { pluginVersion: VERSION })).jobs, [{ result: "complete", job: JOB, briefs: [] }])
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", "labels", JOB, "00000009-0000-4000-8000-000000000009.json"), "utf8")).facts, broken)
}))

test("facts quarantined after a brief was written settle the request when answers are accepted", () => scratch(async (env, base) => {
  await seed(env)
  await requestEvaluation(env, { job: JOB, deskRoot: path.join(base, "desk") })
  assert.equal((await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })).result, "ready")
  await quarantine(env, STORE, NAME, "evidence_unmatched")
  assert.deepEqual(await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION }), { job: JOB, sessions: [{ session: SESSION, result: "missing" }], request: "cleared" })
  assert.deepEqual(await listEvaluationRequests(env), [])
}))

// ---------------------------------------------------------------------------
// The catch point Desk places on each defects stretch.
// ---------------------------------------------------------------------------

const BOUND = LOCAL.jobs[0].job
const STARTED = LOCAL.session.started_at
// The golden labels' first stretch is a defects stretch at 5 s; the others are not defects.
const stamping = (extra = {}) => ({ outcome: { job: BOUND, rev: 2, since: "created", deliveries: 1, first_validating_at: "2026-09-25T08:00:03.000Z", first_delivered_at: "2026-09-25T08:00:30.000Z", ...extra }, startedAt: STARTED })

test("acceptEvaluation stamps the defects stretches from the record it is given, after every check has passed", () => {
  const written = labels()
  written.stretches[0].caught = "after_delivery"
  const accepted = acceptEvaluation(brief(), bytes(written), stamping())
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.labels.stretches.map((stretch) => stretch.caught), ["at_review", undefined, undefined, undefined])
  const late = acceptEvaluation(brief(), bytes(labels()), stamping({ first_delivered_at: "2026-09-25T08:00:04.000Z" }))
  assert.equal(late.labels.stretches[0].caught, "after_delivery")
  assert.equal(acceptEvaluation(brief(), bytes(labels()), stamping({ since: "adopted" })).labels.stretches[0].caught, undefined)
  const rejected = labels()
  rejected.stretches[0].note = SENTINEL
  assert.deepEqual(acceptEvaluation(brief(), bytes(rejected), stamping()), { ok: false, errors: [{ code: "unknown_key", path: "stretches.0" }] })
})

// A session bound to one job only, with that job's record.
async function seedSingle(env, entryExtra = {}) {
  await seed(env)
  const facts = local()
  facts.jobs = facts.jobs.filter((bound) => bound.job === JOB)
  facts.outcomes = [{ job: JOB, rev: 2, state: "delivered_unsigned", verified: null, reason: null, deliveries: 1, delivered_at: "2026-09-25T08:00:30.000Z", signed_at: null, observed_at: "2026-09-25T09:30:00.000Z", since: "created", first_validating_at: "2026-09-25T08:00:03.000Z", first_delivered_at: "2026-09-25T08:00:30.000Z", returns: [], ...entryExtra }]
  await writeLocalFacts(env, STORE, facts)
}

async function acceptStored(env) {
  await prepareEvaluation(env, { job: JOB, pluginVersion: VERSION })
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "evaluations", JOB, "ourostack__factory", `claude-code-${SESSION}.labels.json`), JSON.stringify(labels()))
  assert.equal((await acceptEvaluations(env, { job: JOB, pluginVersion: VERSION })).sessions[0].result, "accepted")
  return JSON.parse(await fs.readFile(path.join(root, "labels", "ourostack__factory", JOB, `${SESSION}.json`), "utf8"))
}

test("accepted labels of a session bound to one job carry the catch point from that job's record", () => scratch(async (env) => {
  await seedSingle(env)
  assert.deepEqual((await acceptStored(env)).stretches.map((stretch) => stretch.caught), ["at_review", undefined, undefined, undefined])
}))

test("accepted labels carry no catch point when the session is bound to more than one job, or the record is adopted", () => scratch(async (env) => {
  await seed(env)
  assert.deepEqual((await acceptStored(env)).stretches.map((stretch) => stretch.caught), [undefined, undefined, undefined, undefined])
}))

test("accepted labels carry no catch point when the record is adopted", () => scratch(async (env) => {
  await seedSingle(env, { since: "adopted" })
  assert.equal((await acceptStored(env)).stretches[0].caught, undefined)
}))
