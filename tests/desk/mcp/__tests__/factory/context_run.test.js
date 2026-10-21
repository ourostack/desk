import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, realpath, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { osEnv } from "../_os_env.js"
import { factoryStateRoot, requestEvaluation, setConsent, writeLocalFacts, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { listContextWork, prepareTaskContexts, readyTaskContexts } from "../../../../../plugins/desk/mcp/src/factory/context-outbox.js"
import { runEvaluatorStep } from "../../../../../plugins/desk/mcp/src/factory/evaluator-step.js"
import { indexJob } from "./_index_helper.js"
import { contextFacts, contextRecord } from "./_context_fixture.js"
import { contextSource } from "../../../../../plugins/desk/mcp/src/factory/context-schema.js"

const runner = await import("../../../../../plugins/desk/mcp/src/factory/context-run.js").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})
const STORE = "ourostack/factory"
const VERSION = "3.2.0-alpha.1"
const NOW = Date.parse("2026-10-21T00:00:00.000Z")
const json = (value) => `${JSON.stringify(value)}\n`
async function fixture(count = 1, { ready = true, spent = 0 } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desk-context-run-")))
  const desk = join(root, "desk")
  const env = osEnv({ HOME: root, XDG_STATE_HOME: join(root, "state") })
  await mkdir(join(desk, "_meta"), { recursive: true })
  await writeFile(join(desk, "_meta", "factory.json"), json({ schema_version: 1, store: STORE }))
  await writeFile(join(desk, "_meta", "factory-context.json"), json({ schema_version: 1, stores: { [STORE]: true } }))
  await setConsent(env, { store: STORE, contribute: true, account: "synthetic" })
  await writeStatus(env, {
    evaluator: { headless: { day: "2026-10-21", jobs: spent } },
    context_publication: { [STORE]: { ready, checked_at: new Date(NOW).toISOString() } },
  })
  const entries = []
  for (let index = 1; index <= count; index += 1) {
    const facts = contextFacts()
    const job = index.toString(16).padStart(32, "0")
    facts.jobs[0].job = job
    facts.outcomes[0].job = job
    facts.session.id = `${index.toString(16).padStart(8, "0")}-8a1d-4c2e-9f3a-1b2c3d4e5f60`
    const log = join(root, `session-${index}.jsonl`)
    await writeFile(log, '{"synthetic":"private evidence"}\n')
    entries.push({ facts, deskRoot: desk, personPrefix: "", localJobs: [{ local: job, published: job }], logPath: log, clockOrigin: "2026-10-01T00:00:00.000Z" })
  }
  await prepareTaskContexts(env, { store: STORE, entries, pluginVersion: VERSION })
  const phases = []
  const runHeadless = async (options) => {
    for (const file of options.briefPaths) {
      const brief = JSON.parse(await readFile(file, "utf8"))
      assert.ok(Array.isArray(brief.instructions) && brief.instructions.length > 30, "the runner carries the readable shipped rubric even without a host skill registration")
      const input = JSON.parse(await readFile(brief.input_file, "utf8"))
      const output = brief.phase === "candidate"
        ? { ...contextRecord(input.sources[0], brief.job), privacy: null }
        : { schema: "desk.factory.context-review/1", verdict: "approved", payload_sha256: brief.payload_sha256, reviewer: brief.evaluator, reason: "safe" }
      await writeFile(brief.output, json(output))
    }
    phases.push(options.purpose)
    return { state: "ran", cost_usd: 0.1 }
  }
  const options = {
    pluginVersion: VERSION, now: NOW, deadline: NOW + 3600000, clock: () => NOW,
    findAgentCli: () => "/synthetic/claude", probeSignIn: async () => ({ state: "subscription" }), runHeadless,
  }
  return { root, desk, env, entries, phases, options }
}

test("ordinary context runs generate then separately review, bounded to one launch and eight jobs", async () => {
  assert.ok(runner, "the ordinary context runner is not implemented")
  const f = await fixture(9)
  assert.equal((await runner.runTaskContextStep(f.env, f.options)).accepted, 8)
  assert.deepEqual(await readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  assert.equal((await runner.runTaskContextStep(f.env, f.options)).accepted, 8)
  assert.equal((await readyTaskContexts(f.env, { store: STORE, entries: f.entries })).length, 8)
  assert.deepEqual(f.phases, ["task_context", "context_privacy"])
  const ledger = JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8"))
  assert.equal(ledger.spent, 2)
  assert.equal(ledger.evaluate.launched, 2)
})

test("native readers receive short-line private JSON, a readable rubric and exact eligible anchor outlines", async () => {
  const f = await fixture()
  const facts = f.entries[0].facts
  facts.jobs[0].agents = [0]
  facts.jobs[0].segments = [{ start_ms: 1000, end_ms: 600000 }]
  facts.intervals.push({ kind: "turn", agent: 0, start_ms: 700000, end_ms: 710000 })
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION })
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options,
    runHeadless: async (options) => {
      for (const file of options.briefPaths) {
        const bytes = await readFile(file, "utf8")
        const brief = JSON.parse(bytes)
        const inputBytes = await readFile(brief.input_file, "utf8")
        assert.ok(bytes.split("\n").length > 100)
        assert.ok(inputBytes.split("\n").length > 100)
        assert.ok(bytes.split("\n").every((line) => line.length < 500), "rubric lines must not become one escaped, truncated native Read line")
        assert.ok(brief.instructions.includes("## Privacy phase"))
        const [outline] = brief.evidence_outline
        assert.equal(outline.session, facts.session.id)
        assert.equal(outline.source, contextSource(facts, brief.job).sha256)
        assert.equal(outline.session_offset_ms, facts.jobs[0].session_offset_ms)
        assert.equal(outline.clock_origin, f.entries[0].clockOrigin)
        assert.deepEqual(outline.shares, [[1000, 600000]])
        assert.deepEqual(outline.intervals.map((entry) => entry.range), [[1000, 250000], [5000, 9000], [250000, 600000]])
        assert.equal(outline.omitted_intervals, 0)
        assert.equal(outline.omitted_shares, 0)
      }
      return f.options.runHeadless(options)
    },
  })
  assert.equal(output.accepted, 1)
})

test("anchor outlines remain bounded and disclose omissions", async () => {
  const f = await fixture()
  const facts = f.entries[0].facts
  facts.intervals = Array.from({ length: 100 }, (_, index) => ({
    kind: index % 2 ? "human_wait" : "turn", agent: 0,
    start_ms: index * 1000, end_ms: (index + 1) * 1000,
  }))
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION })
  await runner.runTaskContextStep(f.env, {
    ...f.options,
    runHeadless: async (options) => {
      const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
      const [outline] = brief.evidence_outline
      assert.ok(outline.intervals.length <= 12)
      assert.equal(outline.omitted_intervals, 100 - outline.intervals.length)
      assert.deepEqual(outline.intervals[0].range, [0, 1000])
      assert.deepEqual(outline.intervals.at(-1).range, [99000, 100000])
      return { state: "failed", cost_usd: null }
    },
  })
})

test("outlines never guess a share for an unplaceable task in a shared session", async () => {
  const f = await fixture()
  f.entries[0].facts.jobs[0].agents = [1]
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION })
  await runner.runTaskContextStep(f.env, {
    ...f.options,
    runHeadless: async (options) => {
      const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
      assert.deepEqual(brief.evidence_outline[0].shares, [])
      assert.deepEqual(brief.evidence_outline[0].intervals, [])
      return { state: "failed", cost_usd: null }
    },
  })
})

test("absent store capability, nested headless execution and a disabled evaluator launch nothing", async () => {
  assert.ok(runner)
  for (const mode of ["not_ready", "headless", "disabled"]) {
    const f = await fixture(1, { ready: mode !== "not_ready" })
    const env = { ...f.env, ...(mode === "headless" ? { DESK_FACTORY_HEADLESS: "1" } : {}), ...(mode === "disabled" ? { DESK_FACTORY_HEADLESS_EVALUATOR: "off" } : {}) }
    const output = await runner.runTaskContextStep(env, f.options)
    assert.equal(output.launched, false)
    assert.equal((await readyTaskContexts(f.env, { store: STORE, entries: f.entries })).length, 0)
    assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
  }
})

test("the shared exhausted launch ledger cannot be bypassed by task context", async () => {
  assert.ok(runner)
  const f = await fixture(1, { spent: 30 })
  const output = await runner.runTaskContextStep(f.env, f.options)
  assert.equal(output.launched, false)
  assert.equal(output.result, "budget_exhausted")
  assert.deepEqual(f.phases, [])
})

test("a failed phase is attempted at most once a day and changed sources do not reset that day", async () => {
  assert.ok(runner)
  const f = await fixture()
  const options = { ...f.options, runHeadless: async () => ({ state: "failed", cost_usd: null }) }
  assert.equal((await runner.runTaskContextStep(f.env, options)).launched, true)
  assert.equal((await runner.runTaskContextStep(f.env, options)).launched, false)
  f.entries[0].facts.intervals[0].end_ms += 1
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION })
  assert.equal((await runner.runTaskContextStep(f.env, options)).launched, false)
  const ledger = JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8"))
  assert.equal(ledger.spent, 1)
})

test("a source changing while the model runs cannot become ready context", async () => {
  assert.ok(runner)
  const f = await fixture()
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options,
    runHeadless: async (options) => {
      const value = await f.options.runHeadless(options)
      await writeFile(f.entries[0].logPath, '{"synthetic":"updated evidence"}\n')
      return value
    },
  })
  assert.equal(output.accepted, 0)
  assert.equal(output.refused, 1)
  assert.deepEqual(await readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("the ordinary evaluator step advances context when no labels consumed its launch", async () => {
  const f = await fixture()
  const options = { ...f.options, maxRuns: 1 }
  assert.equal((await runEvaluatorStep(f.env, options)).result, "context_ran")
  assert.equal((await runEvaluatorStep(f.env, options)).result, "context_ran")
  assert.equal((await readyTaskContexts(f.env, { store: STORE, entries: f.entries })).length, 1)
})

test("an existing label launch retains priority and prevents a second context launch", async () => {
  const f = await fixture()
  const local = JSON.parse(await readFile(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
  local.jobs = [local.jobs[0]]
  const job = local.jobs[0].job
  const written = await writeLocalFacts(f.env, STORE, local)
  assert.equal(written.written, true)
  await indexJob(f.env, job, written.name)
  await requestEvaluation(f.env, { job, deskRoot: f.desk, finishedAt: "2026-10-20T23:00:00.000Z", requestedAt: "2026-10-20T23:00:00.000Z" })
  await runEvaluatorStep(f.env, { ...f.options, maxRuns: 1, runHeadless: async () => ({ state: "failed", cost_usd: null }) })
  assert.equal((await listContextWork(f.env, { store: STORE }))[0].phase, "candidate")
  const ledger = JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8"))
  assert.equal(ledger.spent, 1)
})
