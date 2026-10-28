import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, sep } from "node:path"
import { osEnv } from "../_os_env.js"
import { factoryStateRoot, readStatus, requestEvaluation, setConsent, taskContextPath, updateStatus, updateTaskContextState, writeLocalFacts, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { acceptContextCandidate, listContextWork, prepareTaskContexts, readyTaskContexts } from "../../../../../plugins/desk/mcp/src/factory/context-outbox.js"
import { runEvaluatorStep } from "../../../../../plugins/desk/mcp/src/factory/evaluator-step.js"
import { indexJob } from "./_index_helper.js"
import { contextFacts, contextRecord, replaceContextInput } from "./_context_fixture.js"
import { contextPayloadHash, contextSource } from "../../../../../plugins/desk/mcp/src/factory/context-schema.js"
import { stableStringify } from "../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { runLoopWorker } from "../../../../../plugins/desk/mcp/src/factory/loop-worker.js"
import { evaluationKickDue, kickLoop, LOOP_LOCK_NAME } from "../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js"
import { recordStep } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"
import { reserveAgentLaunch } from "../../../../../plugins/desk/mcp/src/factory/headless-ledger.js"
import { jobId } from "../../../../../plugins/desk/mcp/src/factory/binding.js"

const runner = await import("../../../../../plugins/desk/mcp/src/factory/context-run.js").catch((error) => {
  if (error.code === "ERR_MODULE_NOT_FOUND") return null
  throw error
})
const STORE = "ourostack/factory"
const VERSION = "3.2.0-alpha.1"
const NEXT_VERSION = "3.2.0-alpha.2"
const NOW = Date.parse("2026-10-21T00:00:00.000Z")
const json = (value) => `${JSON.stringify(value)}\n`
async function writePluginVersion(root, version) {
  const bytes = json({ name: "desk", version })
  await writeFile(join(root, "plugin.json"), bytes)
  await writeFile(join(root, ".claude-plugin", "plugin.json"), bytes)
}
async function fixture(count = 1, { ready = true, spent = 0, rubricSuffix = "" } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desk-context-run-")))
  const desk = join(root, "desk")
  const pluginRoot = join(root, "plugin source")
  const env = osEnv({ HOME: root, XDG_STATE_HOME: join(root, "state"), DESK_PLUGIN_ROOT: pluginRoot })
  await mkdir(join(pluginRoot, ".claude-plugin"), { recursive: true })
  await mkdir(join(pluginRoot, "skills", "factory-task-context"), { recursive: true })
  await writePluginVersion(pluginRoot, VERSION)
  await writeFile(join(pluginRoot, "skills", "factory-task-context", "SKILL.md"),
    await readFile(new URL("../../../../../plugins/desk/skills/factory-task-context/SKILL.md", import.meta.url), "utf8") + rubricSuffix)
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
  const prepared = await prepareTaskContexts(env, {
    store: STORE, entries, pluginVersion: VERSION, clock: () => NOW, readRemote: () => null,
  })
  assert.equal(prepared.prepared, count)
  const phases = []
  const runHeadless = async (options) => {
    for (const file of options.briefPaths) {
      const brief = JSON.parse(await readFile(file, "utf8"))
      assert.ok(Array.isArray(brief.instructions) && brief.instructions.length > 30, "the runner carries the readable shipped rubric even without a host skill registration")
      assert.ok(brief.instructions.includes('Use exactly `published`, `withheld` or `unavailable` for `state`.'),
        "native authors need the successful state enum, not just withheld/unavailable instructions")
      const input = JSON.parse(await readFile(brief.input_file, "utf8"))
      const output = brief.phase === "candidate"
        ? { ...contextRecord(input.sources[0], brief.job), evaluator: brief.evaluator, privacy: null }
        : { schema: "desk.factory.context-review/1", verdict: "approved", payload_sha256: brief.payload_sha256, reviewer: brief.evaluator, reason: "safe" }
      await writeFile(brief.output, json(output))
    }
    phases.push(options.purpose)
    return { state: "ran", cost_usd: 0.1 }
  }
  const options = {
    pluginVersion: VERSION, now: NOW, deadline: NOW + 3600000, clock: () => NOW,
    findAgentCli: () => "/synthetic/claude", probeSignIn: async () => ({ state: "subscription" }), runHeadless,
    qualifyHeadlessSource: async () => ({ state: "qualified" }),
  }
  return { root, desk, pluginRoot, env, entries, phases, options }
}

async function pendingPrivacy(f) {
  const [work] = await listContextWork(f.env, { store: STORE })
  const result = await acceptContextCandidate(f.env, {
    store: STORE, job: work.job, basis: work.basis,
    bytes: json({ ...contextRecord(work.source.sources[0], work.job), evaluator: work.source.evaluator, privacy: null }),
  })
  assert.equal(result.result, "candidate_accepted")
  await updateTaskContextState(f.env, STORE, work.job, (state) => ({
    ...state, attempts: { candidate: 1, privacy: 0 }, last_attempts: { candidate: new Date(NOW).toISOString() },
  }))
}

async function legacyInput(f) {
  const [work] = await listContextWork(f.env, { store: STORE })
  const input = structuredClone(work.source)
  delete input.task_card_status
  input.basis = createHash("sha256").update(stableStringify({
    sources: input.sources.map((facts) => contextSource(facts, work.job)),
    private_evidence: input.private_evidence, task_card: input.task_card, plugin_version: VERSION,
  })).digest("hex")
  await replaceContextInput(f.env, STORE, work, input)
  return input
}

test("legacy null-card inputs retain their completed-lookup meaning in native briefs", async () => {
  const f = await fixture()
  await legacyInput(f)
  const result = await runner.runTaskContextStep(f.env, { ...f.options, runHeadless: async (options) => {
    const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
    assert.equal(brief.task_card, null)
    assert.equal(brief.task_card_status, "not_associated")
    return f.options.runHeadless(options)
  } })
  assert.equal(result.accepted, 1)
})

for (const phase of ["candidate", "privacy"]) {
  test(`unqualified native ${phase} source is held before any claim or reservation`, async () => {
    const f = await fixture()
    if (phase === "privacy") await pendingPrivacy(f)
    const [work] = await listContextWork(f.env, { store: STORE })
    const statePath = await taskContextPath(f.env, STORE, work.job, "state.json")
    const before = await readFile(statePath, "utf8")
    const output = await runner.runTaskContextStep(f.env, {
      ...f.options,
      qualifyHeadlessSource: async () => ({ state: "source_unqualified" }),
      reserveAgentLaunch: () => assert.fail("unqualified source reached the ledger"),
      runHeadless: () => assert.fail("unqualified source requested a model"),
    })
    assert.equal(output.result, "context_source_unqualified")
    assert.equal(output.launched, false)
    assert.equal(await readFile(statePath, "utf8"), before)
    assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
  })

  test(`a native ${phase} source change immediately before launch preserves spend without requesting a model`, async () => {
    const f = await fixture()
    if (phase === "privacy") await pendingPrivacy(f)
    let checks = 0
    const output = await runner.runTaskContextStep(f.env, {
      ...f.options,
      qualifyHeadlessSource: async () => ({ state: ++checks === 1 ? "qualified" : "source_unqualified" }),
      runHeadless: () => assert.fail("the second source check must precede the model"),
    })
    assert.equal(checks, 2)
    assert.equal(output.result, "context_source_unqualified")
    assert.equal(output.launched, false)
    assert.equal(output.accepted, 0)
    assert.equal(output.refused, 1)
    const [work] = await listContextWork(f.env, { store: STORE })
    assert.equal(work.state.attempts[phase], 1)
    const ledger = JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8"))
    assert.equal(ledger.spent, 1)
    assert.equal(ledger.evaluate.not_started, 1)
    assert.equal((await readStatus(f.env)).context_evaluation.cost_usd, null)
  })

  test(`a native ${phase} source change after generation refuses outputs without refunding cost or attempt`, async () => {
    const f = await fixture()
    if (phase === "privacy") await pendingPrivacy(f)
    let checks = 0
    const output = await runner.runTaskContextStep(f.env, {
      ...f.options,
      qualifyHeadlessSource: async () => ({ state: ++checks < 3 ? "qualified" : "source_unqualified" }),
    })
    assert.equal(checks, 3)
    assert.equal(output.result, "context_source_unqualified")
    assert.equal(output.launched, true)
    assert.equal(output.accepted, 0)
    assert.equal(output.refused, 1)
    const [work] = await listContextWork(f.env, { store: STORE })
    assert.equal(work.phase, phase)
    assert.equal(work.state.attempts[phase], 1)
    const ledger = JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8"))
    assert.equal(ledger.spent, 1)
    assert.equal(ledger.evaluate.ran, 1)
    assert.equal((await readStatus(f.env)).context_evaluation.cost_usd, 0.1)
    assert.deepEqual(await readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
  })
}

test("metadata qualification cannot consume the remaining model deadline", async () => {
  for (const blockedCheck of [1, 2]) {
    const f = await fixture()
    let checks = 0, clock = NOW
    const output = await runner.runTaskContextStep(f.env, {
      ...f.options, clock: () => clock,
      qualifyHeadlessSource: async () => {
        if (++checks === blockedCheck) clock = f.options.deadline
        return { state: "qualified" }
      },
      runHeadless: () => assert.fail("qualification consumed the remaining model time"),
    })
    assert.equal(output.result, "no_time_for_a_run")
    assert.equal(output.launched, false)
    assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), blockedCheck === 2)
  }
})

test("an expired parent deadline refuses model outputs without starting a post-run metadata child", async () => {
  const f = await fixture()
  let clock = NOW, checks = 0
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options, clock: () => clock,
    qualifyHeadlessSource: async () => { checks += 1; return { state: "qualified" } },
    runHeadless: async (options) => {
      const result = await f.options.runHeadless(options)
      clock = f.options.deadline
      return result
    },
  })
  assert.equal(checks, 2)
  assert.equal(output.accepted, 0)
  assert.equal(output.refused, 1)
  assert.equal(output.launched, true)
  assert.equal(output.result, "context_source_unqualified")
  assert.equal((await readStatus(f.env)).context_evaluation.cost_usd, 0.1)
})

test("all three native checks carry the frozen source and actual source-relevant child directories", async () => {
  const f = await fixture()
  const calls = []
  let modelOptions
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options,
    qualifyHeadlessSource: async (options) => {
      assert.ok(existsSync(options.workDir))
      calls.push(options)
      return { state: "qualified" }
    },
    runHeadless: async (options) => {
      modelOptions = options
      return f.options.runHeadless(options)
    },
  })
  assert.equal(output.accepted, 1)
  assert.equal(calls.length, 3)
  assert.equal(modelOptions.pluginRoot, f.pluginRoot)
  for (const options of calls) {
    assert.equal(options.pluginRoot, f.pluginRoot)
    assert.equal(options.pluginVersion, VERSION)
    assert.equal(options.cli, "/synthetic/claude")
    assert.equal(options.workDir, modelOptions.workDir)
    assert.equal(options.evaluationDir, modelOptions.evaluationDir)
    assert.deepEqual(new Set(options.logDirs), new Set(modelOptions.logDirs))
  }
})

for (const phase of ["candidate", "privacy"]) {
  test(`source upgrades hold pending ${phase} work without relabeling it or spending another reservation`, async () => {
    const f = await fixture(1, { spent: 4 })
    if (phase === "privacy") await pendingPrivacy(f)
    const job = f.entries[0].facts.jobs[0].job
    const statePath = await taskContextPath(f.env, STORE, job, "state.json")
    const before = await readFile(statePath, "utf8")
    const ledgerPath = join(await factoryStateRoot(f.env), "agent-launch-ledger.json")
    const ledger = existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : null
    await writePluginVersion(f.pluginRoot, NEXT_VERSION)
    const output = await runner.runTaskContextStep(f.env, {
      ...f.options, pluginVersion: NEXT_VERSION,
      reserveAgentLaunch: () => assert.fail("an incompatible source reached the launch ledger"),
    })
    assert.equal(output.result, "context_source_stale")
    assert.equal(output.launched, false)
    assert.equal(await readFile(statePath, "utf8"), before)
    assert.equal(existsSync(ledgerPath) ? await readFile(ledgerPath, "utf8") : null, ledger)
    assert.equal((await readStatus(f.env)).evaluator.headless.jobs, 4)
    assert.equal(await runner.contextEvaluationDue(f.env, await readStatus(f.env), NOW), false)
  })
}

test("a stale caller version cannot authorize a different executing source", async () => {
  const f = await fixture()
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options, pluginVersion: NEXT_VERSION,
    reserveAgentLaunch: () => assert.fail("a stale caller reached the launch ledger"),
  })
  assert.equal(output.result, "context_source_mismatch")
  assert.equal(output.launched, false)
  assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
})

test("an unreadable producer identity starts no context run", async () => {
  const f = await fixture()
  await rename(join(f.pluginRoot, "plugin.json"), join(f.pluginRoot, "plugin.kept.json"))
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options, reserveAgentLaunch: () => assert.fail("an unknown producer reached the launch ledger"),
  })
  assert.equal(output.result, "context_source_unavailable")
  assert.equal(output.launched, false)
  assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
  assert.equal(await runner.contextEvaluationDue(f.env, await readStatus(f.env), NOW), false)
})

test("the brief carries the declared producer's rubric rather than a different module copy", async () => {
  const marker = "Synthetic source-specific rubric instruction."
  const f = await fixture(1, { rubricSuffix: `\n${marker}\n` })
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options,
    reserveAgentLaunch: async () => ({ state: "reserved", token: "a".repeat(32), day: "2026-10-21", remaining: 29 }),
    finishAgentLaunch: async () => ({ state: "finished" }),
    runHeadless: async (options) => {
      const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
      assert.ok(brief.instructions.includes(marker))
      return f.options.runHeadless(options)
    },
  })
  assert.equal(output.accepted, 1)
})

test("a missing declared rubric is held before reaching the launch ledger", async () => {
  const f = await fixture()
  const rubric = join(f.pluginRoot, "skills", "factory-task-context", "SKILL.md")
  await rename(rubric, `${rubric}.kept`)
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options, reserveAgentLaunch: () => assert.fail("an unavailable rubric reached the launch ledger"),
  })
  assert.equal(output.result, "context_source_unavailable")
  assert.equal(output.launched, false)
  assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
})

test("an unexpected rubric read failure propagates before reaching the launch ledger", async () => {
  const f = await fixture()
  const rubric = join(f.pluginRoot, "skills", "factory-task-context", "SKILL.md")
  await rename(rubric, `${rubric}.kept`)
  await mkdir(rubric)
  await assert.rejects(runner.runTaskContextStep(f.env, {
    ...f.options, reserveAgentLaunch: () => assert.fail("a failed rubric read reached the launch ledger"),
  }), (error) => error.code === "EISDIR")
  assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
})

test("current-source work proceeds without consuming older privacy work", async () => {
  const f = await fixture()
  await pendingPrivacy(f)
  const oldJob = f.entries[0].facts.jobs[0].job
  const oldState = await readFile(await taskContextPath(f.env, STORE, oldJob, "state.json"), "utf8")
  await writePluginVersion(f.pluginRoot, NEXT_VERSION)
  const facts = contextFacts(), job = "2".padStart(32, "0")
  facts.jobs[0].job = job
  facts.outcomes[0].job = job
  facts.session.id = "00000002-8a1d-4c2e-9f3a-1b2c3d4e5f60"
  await prepareTaskContexts(f.env, { store: STORE, pluginVersion: NEXT_VERSION, clock: () => NOW, readRemote: () => null, entries: [{
    facts, deskRoot: f.desk, personPrefix: "", localJobs: [{ local: job, published: job }], logPath: null, clockOrigin: null,
  }] })
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options, pluginVersion: NEXT_VERSION,
    reserveAgentLaunch: async () => ({ state: "reserved", token: "a".repeat(32), day: "2026-10-21", remaining: 29 }),
    finishAgentLaunch: async () => ({ state: "finished" }),
  })
  assert.equal(output.accepted, 1)
  assert.equal(await readFile(await taskContextPath(f.env, STORE, oldJob, "state.json"), "utf8"), oldState)
  const state = JSON.parse(await readFile(await taskContextPath(f.env, STORE, job, "state.json"), "utf8"))
  assert.equal(state.phase, "privacy")
  assert.equal(state.candidate.evaluator.plugin_version, NEXT_VERSION)
})

test("ordinary candidate briefs emit context2 with an empty recommendation template", async () => {
  const f = await fixture()
  const result = await runner.runTaskContextStep(f.env, {
    ...f.options,
    runHeadless: async (options) => {
      const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
      assert.equal(brief.template.schema, "desk.factory.context/2")
      assert.deepEqual(brief.template.recommendations, [])
      assert.equal(brief.template.privacy, null)
      return f.options.runHeadless(options)
    },
  })
  assert.equal(result.accepted, 1)
})

for (const changedReview of [false, true]) {
  test(`ordinary context2 recommendations ${changedReview ? "reject a different payload hash" : "need a separate exact-payload privacy review"}`, async () => {
    const f = await fixture()
    const phases = []
    const recommendation = {
      id: "fedcba9876543210", observations: ["0123456789abcdef"],
      problem: "The connection result needed a clearer summary.",
      change: "Keep one short summary of the observed result.",
      hypothesis: "A shared summary may make follow-up checks easier.",
      check: "Ask the next reviewer to locate the result without repeating the check.",
      confidence: "medium",
    }
    const runHeadless = async (options) => {
      const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
      phases.push(brief.phase)
      let output
      if (brief.phase === "candidate") {
        const input = JSON.parse(await readFile(brief.input_file, "utf8"))
        output = {
          ...contextRecord(input.sources[0], brief.job), schema: brief.template.schema,
          evaluator: brief.evaluator, privacy: null, recommendations: [recommendation],
        }
      } else {
        const changed = structuredClone(brief.candidate)
        changed.recommendations[0].change = "Use a different proposed summary."
        output = {
          schema: "desk.factory.context-review/1", verdict: "approved",
          payload_sha256: changedReview ? contextPayloadHash(changed) : brief.payload_sha256,
          reviewer: brief.evaluator, reason: "safe",
        }
        assert.deepEqual(brief.candidate.recommendations, [recommendation])
      }
      await writeFile(brief.output, json(output))
      return { state: "ran", cost_usd: 0.1 }
    }
    const candidate = await runner.runTaskContextStep(f.env, { ...f.options, runHeadless })
    assert.equal(candidate.accepted, 1)
    assert.deepEqual(await readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
    const privacy = await runner.runTaskContextStep(f.env, { ...f.options, runHeadless })
    assert.deepEqual(phases, ["candidate", "privacy"])
    assert.equal(privacy.accepted, changedReview ? 0 : 1)
    assert.equal(privacy.refused, changedReview ? 1 : 0)
    const ready = await readyTaskContexts(f.env, { store: STORE, entries: f.entries })
    assert.equal(ready.length, changedReview ? 0 : 1)
    if (!changedReview) {
      const record = JSON.parse(ready[0].bytes)
      assert.equal(record.schema, "desk.factory.context/2")
      assert.deepEqual(record.recommendations, [recommendation])
      assert.equal(record.privacy.verdict, "approved")
    }
  })
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
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW })
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
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW })
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

test("many job shares disclose omissions and missing private logs grant no log-directory access", async () => {
  const f = await fixture()
  f.entries[0].facts.jobs[0].agents = [0]
  f.entries[0].facts.jobs[0].segments = Array.from({ length: 12 }, (_, index) => ({
    start_ms: index * 100000, end_ms: (index + 1) * 100000,
  }))
  f.entries[0].logPath = null
  f.entries[0].clockOrigin = null
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW })
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options, runHeadless: async (options) => {
      const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
      const [outline] = brief.evidence_outline
      assert.deepEqual(outline.shares, [[0, 100000], [100000, 200000], [200000, 300000], [300000, 400000],
        [800000, 900000], [900000, 1000000], [1000000, 1100000], [1100000, 1200000]])
      assert.equal(outline.omitted_shares, 4)
      assert.equal(outline.log_path, null)
      assert.equal(outline.clock_origin, null)
      assert.equal(options.logDirs.includes(f.root), false)
      return { state: "failed", cost_usd: -1 }
    },
  })
  assert.equal(output.refused, 1)
  assert.equal((await readStatus(f.env)).context_evaluation.cost_usd, null)
})

test("equal-start evidence is ordered by its actual endpoint in the native outline", async () => {
  const f = await fixture()
  f.entries[0].facts.intervals.unshift({ kind: "tool", agent: 0, tool: "shell", outcome: "error", start_ms: 1000, end_ms: 2000 })
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW })
  await runner.runTaskContextStep(f.env, { ...f.options, runHeadless: async (options) => {
    const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
    assert.deepEqual(brief.evidence_outline[0].intervals.slice(0, 2).map((entry) => entry.range), [[1000, 2000], [1000, 250000]])
    return { state: "failed", cost_usd: null }
  } })
})

test("unavailable optional cards stay explicit in both native briefs without granting task-directory access", async () => {
  const f = await fixture()
  const folder = join(f.desk, "sample", "unresolved")
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, "task.md"), "---\nstatus: done\n---\nPrivate task context.\n")
  const logFolder = join(f.root, "logs")
  await mkdir(logFolder)
  const log = join(logFolder, "session.jsonl")
  await rename(f.entries[0].logPath, log)
  f.entries[0].logPath = log
  await prepareTaskContexts(f.env, {
    store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW,
    readRemote: () => "https://github.com/synthetic/desk.git",
    resolveIdentity: () => { throw Object.assign(new Error("git_deadline"), { code: "git_deadline" }) },
  })
  const phases = []
  const options = { ...f.options, runHeadless: async (run) => {
    const brief = JSON.parse(await readFile(run.briefPaths[0], "utf8"))
    assert.equal(brief.task_card, null)
    assert.equal(brief.task_card_status, "unavailable")
    assert.ok(run.logDirs.every((dir) => folder !== dir && !folder.startsWith(`${dir}${sep}`)))
    assert.ok(run.logDirs.includes(logFolder))
    const input = JSON.parse(await readFile(brief.input_file, "utf8"))
    const output = brief.phase === "candidate"
      ? { ...contextRecord(input.sources[0], brief.job), evaluator: brief.evaluator, privacy: null,
        coverage: { state: "partial", reasons: ["not_recorded"], omitted_events: 0 } }
      : { schema: "desk.factory.context-review/1", verdict: "approved", payload_sha256: brief.payload_sha256, reviewer: brief.evaluator, reason: "safe" }
    await writeFile(brief.output, json(output))
    phases.push(brief.phase)
    return { state: "ran", cost_usd: 0.1 }
  } }
  assert.equal((await runner.runTaskContextStep(f.env, options)).accepted, 1)
  assert.equal((await runner.runTaskContextStep(f.env, options)).accepted, 1)
  assert.deepEqual(phases, ["candidate", "privacy"])
})

for (const legacy of [false, true]) test(`the ${legacy ? "legacy" : "current"} native task-card handoff exposes its verified pointer and only its own directory`, async () => {
  const f = await fixture(0)
  const remote = "https://github.com/synthetic/desk.git"
  const git = (...args) => execFileSync("git", args, { cwd: f.desk, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
  git("init", "-qb", "main")
  git("config", "user.email", "16390116+arimendelow@users.noreply.github.com")
  git("config", "user.name", "Context Test")
  git("config", "commit.gpgsign", "false")
  git("remote", "add", "origin", remote)
  const folder = join(f.desk, "sample", "safe")
  await mkdir(folder, { recursive: true })
  const card = "---\nstatus: done\n---\nRetesting resumed after the required update.\n"
  await writeFile(join(folder, "task.md"), card)
  git("add", "sample")
  git("commit", "-qm", "create task")
  const job = jobId({ deskRemote: remote, personPrefix: "", track: "sample", slug: "safe" })
  const facts = contextFacts()
  facts.jobs[0].job = job
  facts.outcomes[0].job = job
  const entries = [{ facts, deskRoot: f.desk, personPrefix: "", localJobs: [{ local: job, published: job }], logPath: null, clockOrigin: null }]
  assert.equal((await prepareTaskContexts(f.env, { store: STORE, entries, pluginVersion: VERSION, clock: () => NOW })).prepared, 1)
  if (legacy) {
    const before = await legacyInput(f)
    const counts = await prepareTaskContexts(f.env, {
      store: STORE, entries, pluginVersion: VERSION, clock: () => NOW,
      resolveIdentity: () => { throw Object.assign(new Error("git_deadline"), { code: "git_deadline" }) },
    })
    assert.equal(counts.unchanged, 1)
    assert.equal((await listContextWork(f.env, { store: STORE }))[0].basis, before.basis)
  }
  await runner.runTaskContextStep(f.env, { ...f.options, runHeadless: async (options) => {
    assert.equal(options.logDirs.includes(folder), true)
    assert.equal(options.logDirs.includes(f.desk), false)
    const brief = JSON.parse(await readFile(options.briefPaths[0], "utf8"))
    assert.equal(brief.task_card_status, "associated")
    assert.deepEqual(brief.task_card, {
      path: join(folder, "task.md"),
      sha256: createHash("sha256").update(card).digest("hex"),
    })
    assert.equal(await readFile(brief.task_card.path, "utf8"), card)
    return { state: "failed", cost_usd: null }
  } })
})

test("outlines never guess a share for an unplaceable task in a shared session", async () => {
  const f = await fixture()
  f.entries[0].facts.jobs[0].agents = [1]
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW })
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

test("context readiness expires or refuses malformed observations instead of launching from an old capability", async () => {
  for (const checked_at of [undefined, "invalid", new Date(NOW + 300001).toISOString(), new Date(NOW - 3 * 86400000 - 1).toISOString()]) {
    const f = await fixture()
    await updateStatus(f.env, (status) => ({ ...status, context_publication: { [STORE]: { ready: true, checked_at } } }))
    const result = await runner.runTaskContextStep(f.env, { ...f.options, runHeadless: () => assert.fail("capability is not current") })
    assert.equal(result.result, "no_context_waiting")
    assert.equal(result.launched, false)
    assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
  }
  const withdrawn = await fixture()
  await setConsent(withdrawn.env, { store: STORE, contribute: false, account: "synthetic" })
  assert.equal((await runner.runTaskContextStep(withdrawn.env, withdrawn.options)).result, "no_context_waiting")
})

test("context phase attempt caps and malformed attempt-day metadata remain ineligible", async () => {
  for (const [attempts, last] of [[3, undefined], [null, undefined], [0, 42], [0, new Date(NOW).toISOString()]]) {
    const f = await fixture()
    const [work] = await listContextWork(f.env, { store: STORE })
    await updateTaskContextState(f.env, STORE, work.job, (state) => ({
      ...state, attempts: { ...state.attempts, candidate: attempts },
      last_attempts: last === undefined ? {} : { candidate: last },
    }))
    const result = await runner.runTaskContextStep(f.env, { ...f.options, runHeadless: () => assert.fail("phase is ineligible") })
    assert.equal(result.result, "no_context_waiting")
    assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
  }
  const f = await fixture()
  const [work] = await listContextWork(f.env, { store: STORE })
  await updateTaskContextState(f.env, STORE, work.job, (state) => ({
    ...state, last_attempts: { candidate: "2026-10-20T00:00:00.000Z" },
  }))
  assert.equal(await runner.contextEvaluationDue(f.env, await readStatus(f.env), NOW), true)
})

test("context launch prerequisites refuse billing, missing native hosts and unknown sign-in before reservation", async () => {
  for (const [mode, expected] of [
    ["billing", "disabled_would_bill"], ["missing_cli", "no_agent_cli"],
    ["unknown_sign_in", "sign_in_unknown"], ["no_credentials", "no_credentials"],
  ]) {
    const f = await fixture()
    const env = mode === "billing" ? { ...f.env, ANTHROPIC_API_KEY: "synthetic" } : f.env
    const result = await runner.runTaskContextStep(env, {
      ...f.options, findAgentCli: () => mode === "missing_cli" ? null : "/synthetic/claude",
      probeSignIn: async () => mode === "unknown_sign_in" ? null : { state: "no_credentials" },
      reserveAgentLaunch: () => assert.fail("launch prerequisites did not pass"),
      runHeadless: () => assert.fail("launch prerequisites did not pass"),
    })
    assert.equal(result.result, expected)
    assert.equal(result.launched, false)
    assert.equal(result.ok, false)
    assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
  }
})

test("context launch keeps both deadline checks and refuses a denied reservation", async () => {
  const f = await fixture()
  await assert.rejects(runner.runTaskContextStep(f.env, { ...f.options, now: "invalid" }), /valid now and deadline required/u)
  await assert.rejects(runner.runTaskContextStep(f.env, { ...f.options, deadline: "invalid" }), /valid now and deadline required/u)
  const early = await runner.runTaskContextStep(f.env, {
    ...f.options, deadline: NOW + 1, probeSignIn: () => assert.fail("not enough time even before sign-in"),
  })
  assert.equal(early.result, "no_time_for_a_run")
  let clock = NOW
  const late = await runner.runTaskContextStep(f.env, {
    ...f.options, clock: () => clock,
    probeSignIn: async () => { clock = f.options.deadline; return { state: "subscription" } },
    reserveAgentLaunch: () => assert.fail("sign-in consumed the remaining launch time"),
  })
  assert.equal(late.result, "no_time_for_a_run")
  const denied = await runner.runTaskContextStep(f.env, {
    ...f.options, reserveAgentLaunch: async () => ({ state: "quota_exhausted" }),
    finishAgentLaunch: () => assert.fail("no reservation exists to finish"), runHeadless: () => assert.fail("no reservation"),
  })
  assert.equal(denied.result, "budget_exhausted")
  assert.equal(denied.launched, false)
  assert.equal(existsSync(join(await factoryStateRoot(f.env), "agent-launch-ledger.json")), false)
})

test("headless default options stay inert and an omitted now uses the supplied clock", async () => {
  assert.equal((await runner.runTaskContextStep({ DESK_FACTORY_HEADLESS: "1" })).result, "headless_session")
  const f = await fixture()
  const options = { ...f.options, findAgentCli: () => null }
  delete options.now
  assert.equal((await runner.runTaskContextStep(f.env, options)).result, "no_agent_cli")
})

test("a genuine later ledger observation blocks a stale-clock caller before another reservation", async () => {
  const f = await fixture()
  const reserved = await reserveAgentLaunch(f.env, {
    kind: "evaluate", generation: null, now: NOW + 3600000, legacyEvaluator: (await readStatus(f.env)).evaluator,
  })
  assert.equal(reserved.state, "reserved")
  const status = await readStatus(f.env)
  assert.equal(await runner.contextEvaluationDue(f.env, status, NOW), false)
  const output = await runner.runTaskContextStep(f.env, {
    ...f.options, reserveAgentLaunch: () => assert.fail("the recorded witness already forbids another launch"),
  })
  assert.equal(output.result, "budget_exhausted")
  assert.equal(output.launched, false)
  assert.equal(JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8")).spent, 1)
})

test("a successful numerical-label phase can make context due without waiting through the ordinary gap", async () => {
  const f = await fixture()
  await recordStep(f.env, "evaluate", { ok: true, result: "ran", now: NOW })
  await updateStatus(f.env, (status) => ({ ...status, evaluator: { ...status.evaluator, accepted_last_step: 1 } }))
  assert.equal(await runner.contextEvaluationDue(f.env, await readStatus(f.env), NOW), true)
  await updateStatus(f.env, (status) => ({ ...status, evaluator: { ...status.evaluator, accepted_last_step: 0 } }))
  assert.equal(await runner.contextEvaluationDue(f.env, await readStatus(f.env), NOW), false)
})

for (const race of ["basis", "phase", "already_attempted"]) {
  test(`a context ${race} change after reservation cannot claim or launch the old work`, async () => {
    const f = await fixture()
    const [work] = await listContextWork(f.env, { store: STORE })
    const output = await runner.runTaskContextStep(f.env, {
      ...f.options,
      reserveAgentLaunch: async (...args) => {
        const reserved = await reserveAgentLaunch(...args)
        assert.equal(reserved.state, "reserved")
        if (race === "basis") {
          f.entries[0].facts.intervals[0].end_ms += 1
          await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW })
        } else await updateTaskContextState(f.env, STORE, work.job, (state) => race === "phase"
          ? { ...state, phase: "refused" }
          : { ...state, last_attempts: { candidate: new Date(NOW).toISOString() } })
        return reserved
      },
      runHeadless: () => assert.fail("the selected generation is no longer claimable"),
    })
    assert.equal(output.result, "not_started")
    assert.equal(output.launched, false)
    assert.equal(output.accepted, 0)
    assert.equal(output.refused, 0)
    assert.deepEqual(f.phases, [])
    const ledger = JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8"))
    assert.equal(ledger.spent, 1)
    assert.equal(ledger.evaluate.not_started, 1)
  })
}

test("a throwing context provider closes the spent reservation as failed and cannot retry that phase today", async () => {
  const f = await fixture()
  await assert.rejects(runner.runTaskContextStep(f.env, {
    ...f.options, runHeadless: async () => { throw new Error("synthetic_provider_failure") },
  }), /synthetic_provider_failure/u)
  const ledgerFile = join(await factoryStateRoot(f.env), "agent-launch-ledger.json")
  const ledger = JSON.parse(await readFile(ledgerFile, "utf8"))
  assert.equal(ledger.spent, 1)
  assert.equal(ledger.evaluate.failed, 1)
  assert.equal(ledger.evaluate.ran, 0)
  assert.equal((await runner.runTaskContextStep(f.env, f.options)).result, "no_context_waiting")
  assert.equal(JSON.parse(await readFile(ledgerFile, "utf8")).spent, 1)
  assert.deepEqual(await readyTaskContexts(f.env, { store: STORE, entries: f.entries }), [])
})

test("a failed phase is attempted at most once a day and changed sources do not reset that day", async () => {
  assert.ok(runner)
  const f = await fixture()
  const options = { ...f.options, runHeadless: async () => ({ state: "failed", cost_usd: null }) }
  assert.equal((await runner.runTaskContextStep(f.env, options)).launched, true)
  assert.equal((await runner.runTaskContextStep(f.env, options)).launched, false)
  f.entries[0].facts.intervals[0].end_ms += 1
  await prepareTaskContexts(f.env, { store: STORE, entries: f.entries, pluginVersion: VERSION, clock: () => NOW })
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

test("an empty context queue preserves the ordinary evaluator's no-jobs result", async () => {
  const f = await fixture(0)
  assert.deepEqual(await runEvaluatorStep(f.env, {
    ...f.options, maxRuns: 1, runHeadless: () => assert.fail("neither labels nor context need a launch"),
  }), { ok: true, result: "no_jobs_waiting" })
  assert.deepEqual(f.phases, [])
})

test("ordinary kicks and separate workers drain context generation and privacy with no label request", async () => {
  const f = await fixture(9)
  await recordStep(f.env, "evaluate", { ok: true, result: "no_jobs_waiting", now: NOW - 3600001 })
  assert.equal((await evaluationKickDue(f.env, { now: NOW })).due, true)
  const kicks = []
  const quiet = async () => ({ ok: true, result: "nothing_waiting", launched: false })
  const impls = {
    routeIssues: quiet, routeLocal: quiet, mirror: quiet, reconcile: quiet, verify: quiet, measure: quiet,
    evaluate: (env, options) => runEvaluatorStep(env, { ...f.options, ...options }),
    kick: async (env, options) => {
      const decision = await evaluationKickDue(env, { ...options, now: NOW })
      kicks.push(decision.due)
      return { kicked: decision.due, reason: decision.reason }
    },
  }
  for (let generation = 0; generation < 4; generation += 1) {
    const before = f.phases.length
    const result = await runLoopWorker(f.env, { deskRoot: f.desk, pluginVersion: VERSION, clock: () => NOW, impls })
    assert.equal(result.steps.evaluate, "context_ran")
    assert.equal(f.phases.length - before, 1, "one worker starts only one phase")
    assert.equal(kicks.at(-1), generation < 3, "only a remaining eligible phase continues")
  }
  assert.deepEqual(f.phases, ["task_context", "context_privacy", "task_context", "context_privacy"])
  assert.equal((await readyTaskContexts(f.env, { store: STORE, entries: f.entries })).length, 9)
  assert.equal((await evaluationKickDue(f.env, { now: NOW })).due, false)
  const ledger = JSON.parse(await readFile(join(await factoryStateRoot(f.env), "agent-launch-ledger.json"), "utf8"))
  assert.equal(ledger.spent, 4)
})

test("context kicks preserve failed-run cooldowns, per-phase attempt days, switches and shared quota", async () => {
  const f = await fixture()
  await recordStep(f.env, "evaluate", { ok: true, result: "no_jobs_waiting", now: NOW - 3600001 })
  assert.equal((await evaluationKickDue({ ...f.env, DESK_FACTORY_HEADLESS_EVALUATOR: "off" }, { now: NOW })).due, false)
  assert.equal((await evaluationKickDue({ ...f.env, ANTHROPIC_API_KEY: "synthetic" }, { now: NOW })).due, false)
  await runEvaluatorStep(f.env, { ...f.options, runHeadless: async () => ({ state: "failed", cost_usd: null }) })
  assert.equal((await evaluationKickDue(f.env, { now: NOW })).due, false)
  assert.equal((await evaluationKickDue(f.env, { now: NOW + 3600001 })).due, false, "a phase already attempted today cannot kick")
  const spent = await fixture(1, { spent: 30 })
  await recordStep(spent.env, "evaluate", { ok: true, result: "no_jobs_waiting", now: NOW - 3600001 })
  assert.equal((await evaluationKickDue(spent.env, { now: NOW })).due, false)
  assert.equal((await readStatus(spent.env)).evaluator.headless.jobs, 30)
})

test("a failed privacy run does not immediately drain other candidates", async () => {
  const f = await fixture(9)
  await runEvaluatorStep(f.env, f.options)
  await runEvaluatorStep(f.env, { ...f.options, runHeadless: async () => ({ state: "failed", cost_usd: null }) })
  assert.equal((await evaluationKickDue(f.env, { now: NOW + 1 })).due, false)
  assert.equal((await evaluationKickDue(f.env, { now: NOW + 3600001 })).due, true)
})

for (const damage of ["input", "state"]) {
  test(`a broken optional context ${damage} cannot suppress an ordinary label kick`, async () => {
    const f = await fixture()
    const [work] = await listContextWork(f.env, { store: STORE })
    if (damage === "input") await rename(work.input, `${work.input}.preserved`)
    else await writeFile(await taskContextPath(f.env, STORE, work.job, "state.json"), "{}\n")
    await recordStep(f.env, "evaluate", { ok: true, result: "no_jobs_waiting", now: NOW - 3600001 })
    const scope = { deskRoot: f.desk, personPrefix: "" }
    await requestEvaluation(f.env, {
      job: "f".repeat(32), deskRoot: f.desk, requestedAt: new Date(NOW).toISOString(),
    })
    const result = await kickLoop(f.env, { now: NOW, scope, spawn: () => ({ once() {}, unref() {} }) })
    assert.equal(result.kicked, true)
    assert.equal(result.context_held, "context_error")
    assert.equal((await readStatus(f.env)).context_probe.result, "context_error")
    await assert.rejects(listContextWork(f.env, { store: STORE }), /context_(?:input_missing|state_invalid)/u)
    const locks = join(await factoryStateRoot(f.env), "locks")
    await mkdir(locks, { recursive: true })
    await writeFile(join(locks, LOOP_LOCK_NAME), "{}\n")
    const locked = await kickLoop(f.env, { now: NOW, scope, spawn: () => assert.fail("the live worker lock remains authoritative") })
    assert.equal(locked.kicked, false)
    assert.equal(locked.reason, "worker_running")
  })
}

test("an unwritable context diagnostic still leaves an ordinary evaluation due with an explicit status error", async () => {
  const f = await fixture()
  const [work] = await listContextWork(f.env, { store: STORE })
  await writeFile(await taskContextPath(f.env, STORE, work.job, "state.json"), "{}\n")
  await recordStep(f.env, "evaluate", { ok: true, result: "no_jobs_waiting", now: NOW - 3600001 })
  await requestEvaluation(f.env, { job: "f".repeat(32), deskRoot: f.desk, requestedAt: new Date(NOW).toISOString() })
  const snapshot = await readStatus(f.env)
  const statusFile = join(await factoryStateRoot(f.env), "status.json")
  await rename(statusFile, `${statusFile}.preserved`)
  await mkdir(statusFile)
  const result = await evaluationKickDue(f.env, {
    now: NOW, scope: { deskRoot: f.desk, personPrefix: "" }, readStatusImpl: async () => snapshot,
  })
  assert.equal(result.due, true)
  assert.equal(result.reason, "due")
  assert.equal(result.context_held, "context_status_error")
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
