// The evaluator step: the plugin runs the waste evaluator itself, bounded and counted. Every run goes
// through an injected fake runner; nothing here starts an agent CLI, and every test uses a throwaway
// HOME and state folder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { osEnv } from "../_os_env.js"
import { NO_FILE_SYMLINKS } from "../_platform.js"

import { runEvaluatorStep } from "../../../../../plugins/desk/mcp/src/factory/evaluator-step.js"
import { runLoopWorker } from "../../../../../plugins/desk/mcp/src/factory/loop-worker.js"
import { evaluateDue } from "../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js"
import { STOP_FACTS_BINDING_VERSION } from "../../../../../plugins/desk/mcp/src/factory/evaluate-run.js"
import { HEADLESS_TIMEOUT_MS, MAX_HEADLESS_JOBS_PER_DAY } from "../../../../../plugins/desk/mcp/src/factory/headless.js"
import { labelsBootCheck } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"
import { factoryStateRoot, listEvaluationRequests, readStatus, requestEvaluation, setConsent, updateStatus, writeLocalFacts, writeLocalLabels, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { indexJob } from "./_index_helper.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const LOCAL = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const LABELS = JSON.parse(readFileSync(path.join(here, "fixtures", "labels-golden.json"), "utf8"))
const STORE = "ourostack/factory"
// The labels check also reports the evaluator record; these tests read only the waiting and quarantined counts.
const pick = ({ count, quarantined }) => ({ count, quarantined })
const VERSION = LABELS.evaluator.plugin_version
const DAY = 24 * 60 * 60 * 1000
const DAY0 = Math.floor(Date.now() / DAY) * DAY + 12 * 60 * 60 * 1000

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-evaluator-step-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state"), PATH: path.join(base, "no-bin") })
  try {
    return await run(env, base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const hex = (index) => `${String(index).padStart(2, "0")}${"ab".repeat(15)}`
const sessionId = (index) => `3b0c1f5e-8a1d-4c2e-9f3a-${String(index).padStart(12, "0")}`

// A finished job with one session on `host`; its evaluation request is recorded.
async function seedJob(env, base, index, { host = "claude-code", hosts = [host] } = {}) {
  await setConsent(env, { store: STORE, contribute: true })
  const job = hex(index)
  for (const [offset, sessionHost] of hosts.entries()) {
    const facts = structuredClone(LOCAL)
    facts.session.id = sessionId(index * 10 + offset)
    facts.session.host = sessionHost
    facts.jobs = [{ ...facts.jobs[0], job }]
    await writeLocalFacts(env, STORE, facts)
    await indexJob(env, job, `${sessionHost}-${facts.session.id}.json`)
  }
  await requestEvaluation(env, { job, deskRoot: path.join(base, "desk") })
  return job
}

// The current labels form (labels /3 under rubric 4), with no stops: the fixture's one wait is left unclassified.
function labelsFor(brief) {
  const { unavailable, ...head } = structuredClone(LABELS)
  return { ...head, schema: "desk.factory.labels/3", job: brief.job, session: brief.session.id, evaluator: { ...head.evaluator, rubric: "4" }, stops: [], unavailable: ["session_log_missing"] }
}

// A fake runner. `script(call, count)` answers `{ state, cost_usd }`; `write` makes the evaluator answer.
function fakeRunner(script = () => ({ state: "ran", cost_usd: 0.25 }), { write = true } = {}) {
  const calls = []
  async function runHeadless(call) {
    calls.push(call)
    const outcome = await script(call, calls.length)
    if (write && outcome.state === "ran") {
      for (const file of call.briefPaths) {
        const brief = JSON.parse(await fs.readFile(file, "utf8"))
        await fs.writeFile(brief.output, JSON.stringify(labelsFor(brief)))
      }
    }
    return { detail: null, ...outcome }
  }
  runHeadless.calls = calls
  return runHeadless
}

function seams(overrides = {}) {
  const probes = []
  const found = []
  return {
    pluginVersion: VERSION,
    now: DAY0,
    deadline: Date.now() + 365 * DAY,
    runHeadless: fakeRunner(),
    findAgentCli: () => { found.push(1); return "claude" },
    probeSignIn: async (call) => { probes.push(call); return { state: "subscription" } },
    probes,
    found,
    ...overrides,
  }
}

const step = (env, options) => runEvaluatorStep(env, options)
const evaluatorOf = async (env) => (await readStatus(env)).evaluator

// ---------------------------------------------------------------------------

test("a ready job runs the headless runner once, its answer is accepted and the day's counts say so", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  const onChild = () => {}
  const onChildExit = () => {}
  const options = seams({ onChild, onChildExit })
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(options.runHeadless.calls.length, 1)
  const [call] = options.runHeadless.calls
  assert.equal(call.job.host, "claude-code")
  assert.equal(call.env, env)
  assert.equal(call.onChild, onChild)
  assert.equal(call.onChildExit, onChildExit)
  assert.equal(call.briefPaths.length, 1)
  assert.equal(path.basename(call.evaluationDir), job)
  assert.ok((await fs.stat(call.workDir)).isDirectory())
  assert.equal(path.dirname(path.dirname(call.workDir)), await factoryStateRoot(env), "the scratch folder sits under the protected factory state")
  assert.equal(options.probes.length, 1)
  assert.equal(options.probes[0].onChild, onChild)
  assert.equal(options.probes[0].onChildExit, onChildExit)
  assert.equal(call.signIn.state, "subscription")

  const evaluator = await evaluatorOf(env)
  assert.deepEqual(evaluator, {
    expired_total: 0,
    gave_up: 0,
    waiting: 0,
    ready_now: 0,
    ready_later: 0,
    accepted_last_step: 1,
    scan_ms: evaluator.scan_ms,
    headless: {
      state: "ran",
      day: new Date(DAY0).toISOString().slice(0, 10),
      jobs: 1,
      accepted: 1,
      rejected: 0,
      cost_usd: 0.25,
      cost_unreported_runs: 0,
      unsupported_jobs: 0,
      deferred_jobs: 0,
      deferred_reason: null,
      blocked_days: 0,
    },
    lag: { at: new Date(DAY0).toISOString(), unlabeled_jobs: 0, oldest_finished_at: null, unsupported_jobs: [], gave_up_jobs: [] },
  })
  const record = (await readStatus(env)).loop.steps.evaluate
  assert.equal(record.last_result, "ran")
  assert.equal(record.runs, 1)
  assert.equal(record.failures, 0)
}))

test("a step with no jobs waiting says so, runs and probes nothing, and records no cost", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const options = seams()
  assert.deepEqual(await step(env, options), { ok: true, result: "no_jobs_waiting" })
  assert.equal(options.runHeadless.calls.length, 0)
  assert.equal(options.probes.length, 0)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "idle")
  assert.equal(evaluator.headless.cost_usd, null)
  assert.equal(evaluator.waiting, 0)
  assert.equal((await readStatus(env)).loop.steps.evaluate.last_result, "no_jobs_waiting")
}))

test("the seventh job in a day is not run and the state is budget_exhausted; the next day it runs", () => scratch(async (env, base) => {
  // Six jobs already ran today (a step records its counts after every job), and two more are waiting.
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  const today = new Date(DAY0).toISOString().slice(0, 10)
  await updateStatus(env, (current) => ({ ...current, evaluator: { headless: { day: today, jobs: MAX_HEADLESS_JOBS_PER_DAY - 1, accepted: MAX_HEADLESS_JOBS_PER_DAY - 1 } } }))
  const options = seams()
  assert.deepEqual(await step(env, options), { ok: true, result: "budget_exhausted" })
  assert.equal(options.runHeadless.calls.length, 1, "one more job fits under the cap")
  let evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "budget_exhausted")
  assert.equal(evaluator.headless.jobs, MAX_HEADLESS_JOBS_PER_DAY)
  assert.equal(evaluator.headless.accepted, MAX_HEADLESS_JOBS_PER_DAY)
  assert.equal(evaluator.waiting, 1)
  assert.equal(evaluator.headless.deferred_jobs, 1)
  assert.equal(evaluator.headless.deferred_reason, null, "a spent cap is its own state, not a lack of time")
  assert.equal(evaluator.headless.blocked_days, 1)
  assert.equal(options.probes.length, 1, "the sign-in is probed once per step")

  const again = seams()
  assert.deepEqual(await step(env, again), { ok: true, result: "budget_exhausted" })
  assert.equal(again.runHeadless.calls.length, 0, "the seventh job is not run")
  assert.equal(again.probes.length, 0)

  const next = seams({ now: DAY0 + DAY })
  assert.deepEqual(await step(env, next), { ok: true, result: "ran" })
  assert.equal(next.runHeadless.calls.length, 1)
  evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.jobs, 1, "a new UTC day starts the counts again")
  assert.equal(evaluator.headless.accepted, 1)
  assert.equal(evaluator.waiting, 0)
}))

for (const state of ["no_agent_cli", "no_credentials", "disabled_would_bill", "sign_in_unknown"]) {
  test(`a ${state} result stops the step, keeps every request, counts no run and is recorded`, () => scratch(async (env, base) => {
    await seedJob(env, base, 1)
    await seedJob(env, base, 2)
    const options = seams({ runHeadless: fakeRunner(() => ({ state, cost_usd: null })) })
    assert.deepEqual(await step(env, options), { ok: false, result: state })
    assert.equal(options.runHeadless.calls.length, 1, "the loop over jobs stops")
    const evaluator = await evaluatorOf(env)
    assert.equal(evaluator.headless.state, state)
    assert.equal(evaluator.headless.jobs, 0)
    assert.equal(evaluator.headless.cost_usd, null)
    assert.equal(evaluator.waiting, 2)
    assert.equal(evaluator.headless.blocked_days, 1)
    assert.equal((await readStatus(env)).loop.steps.evaluate.failures, 1)
    assert.deepEqual(pick(labelsBootCheck({ env, now: DAY0 })), { count: 2, quarantined: 0 }, "both requests are still waiting")
  }))
}

test("a blocked day counts once however often the step runs, counts again the next day and resets when a run goes through", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const blocked = () => seams({ runHeadless: fakeRunner(() => ({ state: "no_agent_cli", cost_usd: null })) })
  await step(env, blocked())
  await step(env, { ...blocked(), now: DAY0 + 1000 })
  assert.equal((await evaluatorOf(env)).headless.blocked_days, 1)
  await step(env, { ...blocked(), now: DAY0 + DAY })
  assert.equal((await evaluatorOf(env)).headless.blocked_days, 2)
  await step(env, seams({ now: DAY0 + 2 * DAY }))
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "ran")
  assert.equal(evaluator.headless.blocked_days, 0)
}))

test("a rejected answer is counted, retried the next day, and after 3 attempts the job is given up and no longer run", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const nothing = () => seams({ runHeadless: fakeRunner(() => ({ state: "ran", cost_usd: 0.1 }), { write: false }) })
  let options = { ...nothing(), now: DAY0 }
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  let evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.rejected, 1)
  assert.equal(evaluator.headless.accepted, 0)
  assert.equal(evaluator.waiting, 1)
  assert.equal(evaluator.gave_up, 0)

  options = { ...nothing(), now: DAY0 + 1000 }
  assert.deepEqual(await step(env, options), { ok: true, result: "none_could_run" }, "not retried the same day")
  assert.equal(options.runHeadless.calls.length, 0)
  evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "idle")
  assert.equal(evaluator.headless.deferred_jobs, 1)
  assert.equal(evaluator.headless.deferred_reason, null, "a job already tried today waits by rule, not for lack of time")
  assert.equal(evaluator.waiting, 1)

  for (const day of [1, 2]) {
    options = { ...nothing(), now: DAY0 + day * DAY }
    assert.equal((await step(env, options)).result, "ran")
    assert.equal(options.runHeadless.calls.length, 1)
  }
  evaluator = await evaluatorOf(env)
  assert.equal(evaluator.gave_up, 1)
  options = { ...nothing(), now: DAY0 + 3 * DAY }
  assert.deepEqual(await step(env, options), { ok: true, result: "none_could_run" })
  assert.equal(options.runHeadless.calls.length, 0, "a given-up job is not run")
  evaluator = await evaluatorOf(env)
  assert.equal(evaluator.gave_up, 1)
  assert.equal(evaluator.waiting, 1)
  assert.equal(evaluator.headless.jobs, 0)
}))

test("a job whose sessions are only partly accepted counts as rejected", () => scratch(async (env, base) => {
  await seedJob(env, base, 1, { hosts: ["claude-code", "claude-code"] })
  let seen = 0
  const runHeadless = fakeRunner(() => ({ state: "ran", cost_usd: null }), { write: false })
  const writing = async (call) => {
    const outcome = await runHeadless(call)
    const brief = JSON.parse(await fs.readFile(call.briefPaths[0], "utf8"))
    seen += 1
    await fs.writeFile(brief.output, JSON.stringify(labelsFor(brief)))
    return outcome
  }
  writing.calls = runHeadless.calls
  await step(env, seams({ runHeadless: writing }))
  assert.equal(seen, 1)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.accepted, 0)
  assert.equal(evaluator.headless.rejected, 1)
  assert.equal(evaluator.waiting, 1)
}))

test("timeout, failed and budget_exceeded runs count as attempts, keep their cost and do not stop the loop", () => scratch(async (env, base) => {
  for (let index = 1; index <= 3; index += 1) await seedJob(env, base, index)
  const states = [{ state: "timeout", cost_usd: null }, { state: "failed", cost_usd: null }, { state: "budget_exceeded", cost_usd: 1 }]
  const options = seams({ runHeadless: fakeRunner((_call, count) => states[count - 1]) })
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(options.runHeadless.calls.length, 3)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.jobs, 3)
  assert.equal(evaluator.headless.rejected, 3)
  assert.equal(evaluator.headless.cost_usd, 1)
  assert.equal(evaluator.headless.cost_unreported_runs, 2, "a sum over reported and unreported costs says it is partial")
}))

test("cost stays null unless a run reports a number, and reported costs add up exactly enough", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  await step(env, seams({ runHeadless: fakeRunner(() => ({ state: "ran", cost_usd: null })) }))
  let evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.cost_usd, null)
  assert.equal(evaluator.headless.cost_unreported_runs, 2)

  await seedJob(env, base, 3)
  await seedJob(env, base, 4)
  await step(env, seams({ now: DAY0 + DAY, runHeadless: fakeRunner((_call, count) => ({ state: "ran", cost_usd: count === 1 ? 0.1 : 0.2 })) }))
  evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.cost_usd, 0.3)
  assert.equal(evaluator.headless.cost_unreported_runs, 0)
}))

test("two concurrent steps: the second returns busy and runs nothing, and the lock is released afterwards", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let entered
  const inside = new Promise((resolve) => { entered = resolve })
  const slow = seams({ runHeadless: fakeRunner(async () => { entered(); await gate; return { state: "ran", cost_usd: null } }) })
  const first = step(env, slow)
  await inside
  const second = seams()
  assert.deepEqual(await step(env, second), { ok: true, result: "busy" })
  assert.equal(second.runHeadless.calls.length, 0)
  assert.equal(second.probes.length, 0)
  release()
  assert.deepEqual(await first, { ok: true, result: "ran" })
  const root = await factoryStateRoot(env)
  assert.deepEqual((await fs.readdir(path.join(root, "locks"))).filter((name) => name.includes("evaluator-step")), [])
  assert.equal((await step(env, seams())).result, "no_jobs_waiting")
}))

const HOURS = 60 * 60 * 1000
const age = async (file, ms) => { const when = new Date(Date.now() - ms); await fs.utimes(file, when, when) }
const DEAD = 424242

test("a lock is taken over only when its process is gone, or when it is older than the outer age", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "locks"), { recursive: true })
  const lock = path.join(root, "locks", "evaluator-step.running")
  const gone = (pid) => pid !== DEAD
  const seen = []
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, token: "x" }))
  assert.deepEqual(await step(env, seams({ processAlive: (pid) => { seen.push(pid); return true } })), { ok: true, result: "busy" })
  assert.deepEqual(seen, [process.pid], "the recorded process id is probed")
  await age(lock, 5 * HOURS)
  assert.deepEqual(await step(env, seams({ processAlive: () => true })), { ok: true, result: "busy" }, "age alone, even hours, does not take over a live lock")

  await fs.writeFile(lock, "{}")
  await age(lock, 5 * HOURS)
  assert.deepEqual(await step(env, seams({ processAlive: gone })), { ok: true, result: "busy" }, "an unreadable record is held until the outer age")
  await fs.writeFile(lock, "not json")
  assert.deepEqual(await step(env, seams({ processAlive: gone })), { ok: true, result: "busy" }, "a record that does not parse is held")
  await fs.writeFile(lock, JSON.stringify({ pid: "12", token: "x" }))
  assert.deepEqual(await step(env, seams({ processAlive: gone })), { ok: true, result: "busy" }, "a record without a usable process id is held")
  await age(lock, 7 * HOURS)
  assert.deepEqual(await step(env, seams({ processAlive: () => true })), { ok: true, result: "no_jobs_waiting" }, "past the outer age the lock is taken over")

  await fs.writeFile(lock, JSON.stringify({ pid: DEAD, token: "x" }))
  assert.deepEqual(await step(env, seams({ processAlive: gone })), { ok: true, result: "no_jobs_waiting" }, "a lock whose process is gone is taken over at once")
  await assert.rejects(fs.stat(lock))
}))

// A dangling symbolic link stands in for a lock whose age cannot be read.
test("a lock whose age cannot be read is respected", { skip: NO_FILE_SYMLINKS }, () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "locks"), { recursive: true })
  const lock = path.join(root, "locks", "evaluator-step.running")
  await fs.symlink(path.join(root, "nowhere"), lock)
  assert.deepEqual(await step(env, seams({ processAlive: (pid) => pid !== DEAD })), { ok: true, result: "busy" }, "a lock whose age cannot be read is respected")
}))

test("the default liveness probe sees this process as alive, a finished one as gone, and a process it may not signal as alive", { skip: process.platform === "win32" }, () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "locks"), { recursive: true })
  const lock = path.join(root, "locks", "evaluator-step.running")
  const { spawnSync } = await import("node:child_process")
  const finished = spawnSync(process.execPath, ["-e", ""]).pid
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid }))
  assert.equal((await step(env, seams())).result, "busy")
  await fs.writeFile(lock, JSON.stringify({ pid: 1 }))
  assert.equal((await step(env, seams())).result, "busy", "process 1 exists whether or not it may be signalled")
  await fs.writeFile(lock, JSON.stringify({ pid: finished }))
  assert.equal((await step(env, seams())).result, "no_jobs_waiting")
}))

test("DESK_FACTORY_HEADLESS_EVALUATOR=0 records disabled and runs nothing, but still counts expired requests", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const options = seams({ now: DAY0 + 31 * DAY })
  assert.deepEqual(await step({ ...env, DESK_FACTORY_HEADLESS_EVALUATOR: "0" }, options), { ok: true, result: "disabled" })
  assert.equal(options.runHeadless.calls.length, 0)
  assert.equal(options.probes.length, 0)
  assert.equal(options.found.length, 0)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "disabled")
  assert.equal(evaluator.expired_total, 1)

  await seedJob(env, base, 2)
  const live = seams({ now: DAY0 + DAY })
  await step({ ...env, DESK_FACTORY_HEADLESS_EVALUATOR: "1" }, live)
  assert.equal(live.runHeadless.calls.length, 1, "any other value leaves the evaluator on")
}))

test("a headless session starts nothing, not even the probe, and writes no state", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const root = await factoryStateRoot(env)
  const before = await fs.readdir(root)
  const options = seams()
  assert.deepEqual(await step({ ...env, DESK_FACTORY_HEADLESS: "1" }, options), { ok: false, result: "headless_session" })
  assert.equal(options.runHeadless.calls.length, 0)
  assert.equal(options.probes.length, 0)
  assert.equal(options.found.length, 0)
  assert.deepEqual(await fs.readdir(root), before)
  await assert.rejects(fs.stat(path.join(root, "status.json")))
  assert.equal((await listRequests(root)).length, 1, "the request is untouched")

  for (const value of ["", "0"]) {
    const normal = seams()
    assert.notEqual((await step({ ...env, DESK_FACTORY_HEADLESS: value }, normal)).result, "headless_session", `value "${value}" is not a headless session`)
  }
}))

async function listRequests(root) {
  return (await fs.readdir(path.join(root, "evaluate-requests"))).filter((name) => name.endsWith(".json"))
}

test("a runner that answers headless_session stops the step without recording anything", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const options = seams({ runHeadless: fakeRunner(() => ({ state: "headless_session", cost_usd: null })) })
  assert.deepEqual(await step(env, options), { ok: false, result: "headless_session" })
  const status = await readStatus(env)
  assert.equal(status.evaluator.headless.jobs, 0, "the run that never started is taken back out")
  assert.deepEqual(status.loop.evaluate.attempts, {})
  assert.equal(status.loop.steps, undefined, "the step records nothing")
}))

test("an expired request lands in evaluate-requests/expired, counts once, and a second sweep does not count it again", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  assert.deepEqual(pick(labelsBootCheck({ env, now: DAY0 })), { count: 1, quarantined: 0 })
  const late = seams({ now: DAY0 + 31 * DAY })
  assert.deepEqual(await step(env, late), { ok: true, result: "no_jobs_waiting" })
  const root = await factoryStateRoot(env)
  const expired = JSON.parse(await fs.readFile(path.join(root, "evaluate-requests", "expired", `${job}.json`), "utf8"))
  assert.equal(expired.reason, "expired")
  await assert.rejects(fs.stat(path.join(root, "evaluate-requests", `${job}.json`)))
  await assert.rejects(fs.stat(path.join(root, "evaluate-requests", "quarantine", `${job}.json`)))
  assert.equal((await evaluatorOf(env)).expired_total, 1)
  assert.deepEqual(pick(labelsBootCheck({ env, now: DAY0 })), { count: 0, quarantined: 0 }, "the request is no longer waiting")
  await step(env, seams({ now: DAY0 + 32 * DAY }))
  assert.equal((await evaluatorOf(env)).expired_total, 1)

  await seedJob(env, base, 2)
  await step(env, seams({ now: DAY0 + 64 * DAY }))
  assert.equal((await evaluatorOf(env)).expired_total, 2)
}))

test("a job with only an unsupported host is counted unsupported and skipped; the others still run", () => scratch(async (env, base) => {
  await seedJob(env, base, 1, { host: "copilot-cli" })
  await seedJob(env, base, 2)
  const options = seams()
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(options.runHeadless.calls.length, 1)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "ran")
  assert.equal(evaluator.headless.unsupported_jobs, 1)
  assert.equal(evaluator.headless.accepted, 1)
  assert.equal(evaluator.waiting, 1)
}))

test("when every waiting job is unsupported nothing runs, nothing is probed and the state says unsupported_host", () => scratch(async (env, base) => {
  await seedJob(env, base, 1, { host: "copilot-cli" })
  const options = seams()
  assert.deepEqual(await step(env, options), { ok: true, result: "unsupported_host" })
  assert.equal(options.runHeadless.calls.length, 0)
  assert.equal(options.probes.length, 0)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "unsupported_host")
  assert.equal(evaluator.headless.unsupported_jobs, 1)
  assert.equal(evaluator.headless.blocked_days, 0, "a job-level state is not a machine block")
}))

test("a job with a supported and an unsupported session runs only the supported brief", () => scratch(async (env, base) => {
  await seedJob(env, base, 1, { hosts: ["copilot-cli", "claude-code"] })
  const options = seams()
  await step(env, options)
  const [call] = options.runHeadless.calls
  assert.equal(call.briefPaths.length, 1)
  assert.match(path.basename(call.briefPaths[0]), /^claude-code-/u)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.accepted, 1)
  assert.equal(evaluator.waiting, 1, "the copilot session still waits")
  const again = seams({ now: DAY0 + DAY })
  assert.deepEqual(await step(env, again), { ok: true, result: "unsupported_host" })
  assert.equal(again.runHeadless.calls.length, 0)
}))

test("a runner that answers unsupported_host for a job skips it without stopping the loop", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  const options = seams({ runHeadless: fakeRunner((_call, count) => (count === 1 ? { state: "unsupported_host", cost_usd: null } : { state: "ran", cost_usd: null })) })
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(options.runHeadless.calls.length, 2)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.unsupported_jobs, 1)
  assert.equal(evaluator.headless.jobs, 1)
}))

test("no new run starts that could not finish before the deadline; the jobs left wait for the next worker, and the step says it had no time", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  await seedJob(env, base, 3)
  let clock = 1000
  const tooLate = seams({ clock: () => clock, deadline: clock + HEADLESS_TIMEOUT_MS - 1 })
  assert.deepEqual(await step(env, tooLate), { ok: false, result: "no_time_for_a_run" }, "a step that deferred every ready job for lack of time is not a clean run")
  assert.equal(tooLate.runHeadless.calls.length, 0)
  assert.equal(tooLate.probes.length, 0)
  let evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "no_time_for_a_run")
  assert.equal(evaluator.headless.deferred_jobs, 3)
  assert.equal(evaluator.headless.deferred_reason, "no_time_for_a_run")
  assert.equal(evaluator.waiting, 3)
  const record = (await readStatus(env)).loop.steps.evaluate
  assert.equal(record.last_result, "no_time_for_a_run")
  assert.equal(record.failures, 1, "the step record counts it as a failure, so last_ok_at does not move")
  assert.equal(record.last_ok_at, null)

  const exact = seams({
    clock: () => clock,
    deadline: new Date(clock + HEADLESS_TIMEOUT_MS + 5 * 60 * 1000).toISOString(),
    runHeadless: fakeRunner(() => { clock += 10 * 60 * 1000; return { state: "ran", cost_usd: null } }),
  })
  assert.deepEqual(await step(env, exact), { ok: true, result: "ran" })
  assert.equal(exact.runHeadless.calls.length, 1, "after the first run the second no longer fits")
  evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "ran")
  assert.equal(evaluator.headless.deferred_jobs, 2)
  assert.equal(evaluator.headless.deferred_reason, "no_time_for_a_run", "the jobs left after a run still say why they wait")
  assert.equal(evaluator.waiting, 2)
}))

test("a probe happens once per step and is skipped when the machine is already blocked", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  const billing = seams({ runHeadless: fakeRunner(() => ({ state: "disabled_would_bill", cost_usd: null })) })
  await step({ ...env, ANTHROPIC_API_KEY: "x" }, billing)
  assert.equal(billing.probes.length, 0, "a per-token key in the environment needs no probe")
  assert.equal(billing.runHeadless.calls[0].signIn, undefined)

  const noCli = seams({ findAgentCli: () => null, runHeadless: fakeRunner(() => ({ state: "no_agent_cli", cost_usd: null })) })
  await step(env, noCli)
  assert.equal(noCli.probes.length, 0)
  assert.equal(noCli.runHeadless.calls[0].signIn, undefined)
}))

test("the defaults reach the real runner, which finds no agent CLI on an empty path and starts nothing", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  assert.deepEqual(await step(env, { pluginVersion: VERSION, deadline: Date.now() + DAY }), { ok: false, result: "no_agent_cli" })
  assert.equal((await evaluatorOf(env)).headless.state, "no_agent_cli")
}))

test("a failure inside the step is recorded as a failed step with a code, the lock is released and nothing is echoed", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const options = seams({ runHeadless: async () => { throw new Error("SENTINEL-boom /secret/path") } })
  assert.deepEqual(await step(env, options), { ok: false, result: "step_error" })
  const record = (await readStatus(env)).loop.steps.evaluate
  assert.equal(record.last_result, "step_error")
  assert.equal(record.failures, 1)
  assert.equal(JSON.stringify(await readStatus(env)).includes("SENTINEL"), false)
  assert.equal((await step(env, seams({ now: DAY0 + DAY }))).result, "ran", "the lock was released")
}))

test("a step with no factory state creates nothing", () => scratch(async (env, base) => {
  const options = seams()
  assert.deepEqual(await step(env, options), { ok: true, result: "no_factory_state" })
  await assert.rejects(fs.stat(path.join(base, "state")))
}))

test("the status record holds only codes, counts and the cost number; per-job bookkeeping lives apart and is bounded", () => scratch(async (env, base) => {
  const jobs = []
  for (let index = 1; index <= 3; index += 1) jobs.push(await seedJob(env, base, index))
  await step(env, seams({ runHeadless: fakeRunner((_call, count) => ({ state: "ran", cost_usd: 0.5 }), { write: false }) }))
  const status = await readStatus(env)
  const strings = []
  const walk = (value) => {
    if (typeof value === "string") strings.push(value)
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk)
  }
  walk(status.evaluator)
  assert.ok(strings.length > 0)
  assert.deepEqual(strings.filter((text) => text.includes("/") || /[0-9a-f]{32}/u.test(text)), [])
  assert.equal(JSON.stringify(status.evaluator).includes(jobs[0]), false, "no job ID in the evaluator object")
  assert.deepEqual(Object.keys(status.loop.evaluate.attempts).sort(), [...jobs].sort())
  assert.deepEqual(status.loop.evaluate.attempts[jobs[0]], { attempts: 1, last_day: new Date(DAY0).toISOString().slice(0, 10) })

  // A job whose request is gone drops out of the bookkeeping.
  const root = await factoryStateRoot(env)
  await fs.rm(path.join(root, "evaluate-requests", `${jobs[0]}.json`))
  await step(env, seams({ now: DAY0 + DAY, runHeadless: fakeRunner(() => ({ state: "ran", cost_usd: null }), { write: false }) }))
  assert.deepEqual(Object.keys((await readStatus(env)).loop.evaluate.attempts).sort(), jobs.slice(1).sort())
}))

test("the caller's contract is checked", () => scratch(async (env) => {
  await assert.rejects(step(env, { pluginVersion: 7 }), TypeError)
  await assert.rejects(step(env, { pluginVersion: VERSION, now: "not a time" }), TypeError)
  await assert.rejects(step(env, { pluginVersion: VERSION, now: null }), TypeError)
  await assert.rejects(step(env, { pluginVersion: VERSION, deadline: "not a time" }), TypeError)
  await assert.rejects(step(env, { pluginVersion: VERSION }), TypeError, "a deadline is required")
  await assert.rejects(step(env, { pluginVersion: VERSION, deadline: null }), TypeError, "a deadline is required")
  await assert.rejects(step(env), TypeError)
  await assert.rejects(step(env, { pluginVersion: VERSION, deadline: Date.now(), deskRoot: "relative" }), TypeError)
  await assert.rejects(step(env, { pluginVersion: VERSION, deadline: Date.now(), deskRoot: 7 }), TypeError)
}))

test("the runner is told the folder of each session log the briefs name", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  const log = path.join(base, "logs", "session.jsonl")
  await fs.mkdir(path.dirname(log), { recursive: true })
  await fs.writeFile(log, "{}\n")
  const { writeMarker } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  const id = sessionId(10)
  await writeMarker(env, {
    schema_version: 1, host: "claude-code", session_id: id, log_path: log, cwd: base, desk_root: null,
    end_reason: "prompt_input_exit", ended_at: "2026-09-25T09:30:00.000Z", plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString(),
  })
  const options = seams()
  await step(env, options)
  assert.deepEqual(options.runHeadless.calls[0].logDirs, [path.dirname(log)])
  assert.equal(path.basename(options.runHeadless.calls[0].evaluationDir), job)
}))

test("a lock folder that cannot be written to is an error, not a busy answer", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  const locks = path.join(root, "locks")
  await fs.mkdir(locks, { recursive: true })
  await fs.chmod(locks, 0o500)
  try {
    await assert.rejects(step(env, seams()), (error) => error.code === "EACCES")
  } finally {
    await fs.chmod(locks, 0o700)
  }
}))

// ---------------------------------------------------------------------------
// Fix round 1: the bounds are structural.
// ---------------------------------------------------------------------------

const TODAY = new Date(DAY0).toISOString().slice(0, 10)
const dayOf = (offsetDays) => new Date(DAY0 + offsetDays * DAY).toISOString().slice(0, 10)
const setEvaluator = (env, evaluator, loop) => updateStatus(env, (current) => ({ ...current, evaluator, ...(loop === undefined ? {} : { loop: { ...(current.loop ?? {}), ...loop } }) }))

test("a run is counted as started before it starts: the day's count and the attempt are saved first", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  let seen
  const options = seams({ runHeadless: fakeRunner(async () => {
    const status = await readStatus(env)
    seen = { jobs: status.evaluator.headless.jobs, attempts: status.loop.evaluate.attempts[job], cost: status.evaluator.headless.cost_usd }
    return { state: "ran", cost_usd: 0.4 }
  }) })
  await step(env, options)
  assert.deepEqual(seen, { jobs: 1, attempts: { attempts: 1, last_day: TODAY }, cost: null })
  assert.equal((await evaluatorOf(env)).headless.cost_usd, 0.4)
}))

test("a runner that throws still leaves the run counted, so the next step does not run the job again that day", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const first = seams({ runHeadless: async () => { throw new Error("boom") } })
  assert.deepEqual(await step(env, first), { ok: false, result: "step_error" })
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.jobs, 1)
  const second = seams()
  assert.deepEqual(await step(env, second), { ok: true, result: "none_could_run" })
  assert.equal(second.runHeadless.calls.length, 0)
}))

test("a run that never started (a blocked answer) is taken back out of the counts", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await step(env, seams({ runHeadless: fakeRunner(() => ({ state: "no_agent_cli", cost_usd: null })) }))
  assert.equal((await evaluatorOf(env)).headless.jobs, 0)
  assert.deepEqual((await readStatus(env)).loop.evaluate.attempts, {})
  await seedJob(env, base, 2)
  await step(env, seams({ runHeadless: fakeRunner((_call, count) => ({ state: count === 1 ? "unsupported_host" : "ran", cost_usd: null }), { write: false }) }))
  assert.deepEqual(Object.values((await readStatus(env)).loop.evaluate.attempts).map((entry) => entry.attempts), [1], "only the job that ran keeps an attempt")
}))

test("a damaged day count means the day is spent; only an absent record means zero", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  for (const headless of [{ day: TODAY, jobs: "many" }, { day: TODAY, jobs: -1 }, { day: TODAY }, { day: "someday", jobs: 0 }, {}, "garbage", 7]) {
    await setEvaluator(env, { headless })
    const options = seams()
    assert.deepEqual(await step(env, options), { ok: true, result: "budget_exhausted" }, JSON.stringify(headless))
    assert.equal(options.runHeadless.calls.length, 0)
    const evaluator = await evaluatorOf(env)
    assert.equal(evaluator.headless.jobs, MAX_HEADLESS_JOBS_PER_DAY)
    assert.equal(evaluator.headless.day, TODAY)
  }
  await updateStatus(env, ({ evaluator, ...rest }) => rest)
  const fresh = seams()
  assert.equal((await step(env, fresh)).result, "ran", "no record at all is a new day")
}))

test("a stored day that is earlier is a new day even when its counts are damaged", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await setEvaluator(env, { headless: { day: dayOf(-1), jobs: "many" } })
  assert.equal((await step(env, seams())).result, "ran")
  assert.equal((await evaluatorOf(env)).headless.jobs, 1)
}))

test("a clock that moves backwards never gives the day a fresh budget", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  await setEvaluator(env, { headless: { day: dayOf(1), jobs: MAX_HEADLESS_JOBS_PER_DAY, accepted: 0, rejected: 0 } })
  const spent = seams()
  assert.deepEqual(await step(env, spent), { ok: true, result: "budget_exhausted" })
  assert.equal(spent.runHeadless.calls.length, 0)
  assert.equal((await evaluatorOf(env)).headless.day, dayOf(1), "the stored later day stands")

  await setEvaluator(env, { headless: { day: dayOf(1), jobs: 2, accepted: 2, rejected: 0 } })
  const room = seams()
  assert.equal((await step(env, room)).result, "ran")
  assert.equal(room.runHeadless.calls.length, 2)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.jobs, 4)
  assert.equal(evaluator.headless.day, dayOf(1))
}))

test("damaged attempt bookkeeping fails closed: a damaged entry is a job at its limit", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  const other = await seedJob(env, base, 2)
  for (const attempts of [{ [job]: "bad", [other]: { attempts: 0, last_day: dayOf(-1) } }, { [job]: { attempts: "two", last_day: dayOf(-1) } }, { [job]: { attempts: -1, last_day: dayOf(-1) } }]) {
    await setEvaluator(env, undefined, { evaluate: { attempts } })
    const options = seams()
    await step(env, options)
    assert.ok(options.runHeadless.calls.every((call) => call.job.job !== job), "the damaged job is not run")
    assert.equal((await evaluatorOf(env)).gave_up >= 1, true)
    await updateStatus(env, ({ evaluator, ...rest }) => rest)
  }
  // The whole map damaged: every waiting job is at its limit.
  await setEvaluator(env, undefined, { evaluate: { attempts: "garbage" } })
  const all = seams()
  assert.deepEqual(await step(env, all), { ok: true, result: "none_could_run" })
  assert.equal(all.runHeadless.calls.length, 0)
  assert.equal((await evaluatorOf(env)).gave_up, 1)
}))

test("an attempt dated today, later than today or unreadable keeps the job from running today", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  for (const last_day of [dayOf(1), "never", 5, null]) {
    await setEvaluator(env, undefined, { evaluate: { attempts: { [job]: { attempts: 1, last_day } } } })
    const options = seams()
    assert.deepEqual(await step(env, options), { ok: true, result: "none_could_run" }, String(last_day))
    assert.equal(options.runHeadless.calls.length, 0)
  }
  await setEvaluator(env, undefined, { evaluate: { attempts: { [job]: { attempts: 1, last_day: dayOf(-1) } } } })
  assert.equal((await step(env, seams())).result, "ran")
}))

test("a step that crosses UTC midnight starts the new day's count; no day starts more than the cap", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  const nextMidnight = Math.floor(DAY0 / DAY) * DAY + DAY
  let clock = 0
  await setEvaluator(env, { headless: { day: TODAY, jobs: MAX_HEADLESS_JOBS_PER_DAY - 1, accepted: 0, rejected: 0 } })
  const options = seams({
    now: nextMidnight - 60 * 1000,
    clock: () => clock,
    deadline: 100 * DAY,
    runHeadless: fakeRunner(() => { clock += 2 * 60 * 1000; return { state: "ran", cost_usd: 0.1 } }),
  })
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(options.runHeadless.calls.length, 2, "the second job starts after midnight under the new day")
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.day, new Date(nextMidnight).toISOString().slice(0, 10))
  assert.equal(evaluator.headless.jobs, 1)
  assert.equal(evaluator.headless.cost_usd, 0.1)
}))

test("a step never starts a run that could end after its own limit, below the lock's stale age", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  await seedJob(env, base, 2)
  let clock = 5000
  const options = seams({ clock: () => clock, deadline: clock + 100 * DAY, runHeadless: fakeRunner(() => { clock += 12 * 60 * 1000; return { state: "ran", cost_usd: null } }) })
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(options.runHeadless.calls.length, 1, "12 minutes in, a 15-minute run would end after the 25-minute limit")
  assert.equal((await evaluatorOf(env)).headless.deferred_jobs, 1)
}))

test("two steps taking over one stale lock: exactly one wins", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "locks"), { recursive: true })
  const lock = path.join(root, "locks", "evaluator-step.running")
  await fs.writeFile(lock, JSON.stringify({ pid: DEAD }))
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = () => seams({ processAlive: (pid) => pid !== DEAD, runHeadless: fakeRunner(async () => { await gate; return { state: "ran", cost_usd: null } }) })
  const a = step(env, slow())
  const b = step(env, slow())
  const early = await Promise.race([a, b])
  assert.deepEqual(early, { ok: true, result: "busy" })
  release()
  const results = await Promise.all([a, b])
  assert.deepEqual(results.map((result) => result.result).sort(), ["busy", "ran"])
  assert.deepEqual((await fs.readdir(path.join(root, "locks"))).filter((name) => name.includes("evaluator-step")), [])
}))

test("a takeover guard that is held is respected, and one left behind long ago is cleared for the next step", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "locks"), { recursive: true })
  const lock = path.join(root, "locks", "evaluator-step.running")
  const guard = `${lock}.takeover`
  const old = new Date(Date.now() - 31 * 60 * 1000)
  await fs.writeFile(lock, "{}")
  await age(lock, 7 * HOURS)
  await fs.writeFile(guard, "{}")
  assert.deepEqual(await step(env, seams()), { ok: true, result: "busy" })
  await fs.utimes(guard, old, old)
  assert.deepEqual(await step(env, seams()), { ok: true, result: "busy" }, "the abandoned guard is cleared, the takeover waits for the next step")
  await assert.rejects(fs.stat(guard))
  assert.deepEqual(await step(env, seams()), { ok: true, result: "no_jobs_waiting" })
}))

test("a lock that is fresh again once the takeover guard is held is left alone", () => scratch(async (env) => {
  await setConsent(env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "locks"), { recursive: true })
  const lock = path.join(root, "locks", "evaluator-step.running")
  await fs.writeFile(lock, "{}")
  await age(lock, 7 * HOURS)
  // The lock's age is read twice (before and under the guard); the second read finds it fresh.
  const realStat = fs.stat
  let reads = 0
  fs.stat = async (file, ...rest) => {
    const stat = await realStat(file, ...rest)
    if (String(file) === lock && (reads += 1) === 2) return { ...stat, mtimeMs: Date.now() }
    return stat
  }
  try {
    assert.deepEqual(await step(env, seams()), { ok: true, result: "busy" })
  } finally {
    fs.stat = realStat
  }
  assert.equal((await fs.stat(lock)).isFile(), true)
}))

test("a step releases only a lock that is still its own", () => scratch(async (env, base) => {
  const root = await factoryStateRoot(env)
  const lock = path.join(root, "locks", "evaluator-step.running")
  for (const [index, content] of [JSON.stringify({ token: "someone-else" }), "not json"].entries()) {
    await seedJob(env, base, index + 1)
    const options = seams({ now: DAY0 + index * DAY, runHeadless: fakeRunner(async () => { await fs.writeFile(lock, content); return { state: "ran", cost_usd: null } }) })
    await step(env, options)
    assert.equal(await fs.readFile(lock, "utf8"), content, "another owner's lock is not removed")
    await fs.rm(lock)
  }
}))

for (const [value, disabled] of [["0", true], [" 0 ", true], ["false", true], ["FALSE", true], ["", true], ["off", true], ["maybe", true], ["1", false], [" 1 ", false], ["true", false], ["TRUE", false], ["on", false], ["yes", false]]) {
  test(`the evaluator switch value "${value}" ${disabled ? "turns the evaluator off" : "leaves it on"}`, () => scratch(async (env, base) => {
    await seedJob(env, base, 1)
    const options = seams()
    const result = await step({ ...env, DESK_FACTORY_HEADLESS_EVALUATOR: value }, options)
    assert.equal(result.result, disabled ? "disabled" : "ran")
    assert.equal(options.runHeadless.calls.length, disabled ? 0 : 1)
  }))
}

test("a blocked answer restores the job's earlier attempts exactly", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  const earlier = { attempts: 1, last_day: dayOf(-1) }
  await setEvaluator(env, undefined, { evaluate: { attempts: { [job]: earlier } } })
  await step(env, seams({ runHeadless: fakeRunner(() => ({ state: "no_credentials", cost_usd: null })) }))
  assert.deepEqual((await readStatus(env)).loop.evaluate.attempts, { [job]: earlier })
  assert.equal((await evaluatorOf(env)).headless.jobs, 0)
}))

test("the step's headless-flag rule is the runner's: set, not empty, not 0, no trimming", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  for (const value of [" 0 ", " ", "false", "1"]) {
    const options = seams()
    assert.deepEqual(await step({ ...env, DESK_FACTORY_HEADLESS: value }, options), { ok: false, result: "headless_session" }, JSON.stringify(value))
    assert.equal(options.runHeadless.calls.length, 0)
  }
}))

test("the time limit is checked again right before the run, after the sign-in probe", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  let clock = 1000
  const options = seams({
    clock: () => clock,
    deadline: clock + HEADLESS_TIMEOUT_MS + 60 * 1000,
    probeSignIn: async () => { clock += 2 * 60 * 1000; return { state: "subscription" } },
  })
  assert.deepEqual(await step(env, options), { ok: false, result: "no_time_for_a_run" })
  assert.equal(options.runHeadless.calls.length, 0, "the probe used up the time the run needed")
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.jobs, 0)
  assert.equal(evaluator.headless.deferred_jobs, 1)
  assert.equal(evaluator.headless.deferred_reason, "no_time_for_a_run")
  assert.deepEqual((await readStatus(env)).loop.evaluate.attempts, {})
}))

// The regression seen on 2026-10-09 with Desk 3.2.0-alpha.247: the loop worker gives the evaluator a deadline 17 minutes after it starts, the facts
// scan took 131 seconds, so less than the 15 minutes a run needs was left and every one of 18 ready jobs was deferred, while the step looked healthy.
const SCAN_MS = 131000
const WORKER_DEADLINE_MS = 17 * 60 * 1000

async function slowScan(env, base, { extendDeadline, jobs = 18 } = {}) {
  for (let index = 1; index <= jobs; index += 1) await seedJob(env, base, index)
  let clock = 1000
  const granted = []
  const options = seams({
    clock: () => clock,
    deadline: clock + WORKER_DEADLINE_MS,
    requestFinishedJobs: async () => { clock += SCAN_MS; return { requested: [] } },
    runHeadless: fakeRunner(() => { clock += 10 * 60 * 1000; return { state: "ran", cost_usd: null } }),
    ...(extendDeadline === undefined ? {} : { extendDeadline: async (ms) => { granted.push(ms); return extendDeadline(ms) } }),
  })
  return { options, granted, outcome: await step(env, options) }
}

test("a facts scan of 131 seconds with 18 ready jobs still starts a run when the caller leaves the scan out of the run window", () => scratch(async (env, base) => {
  const { options, granted, outcome } = await slowScan(env, base, { extendDeadline: (ms) => ms })
  assert.deepEqual(outcome, { ok: true, result: "ran" })
  assert.deepEqual(granted, [SCAN_MS], "the step asks for exactly the time its scan took")
  assert.equal(options.runHeadless.calls.length, 1, "one 15-minute run fits after the scan; the second no longer does")
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.scan_ms, SCAN_MS)
  assert.equal(evaluator.headless.state, "ran")
  assert.equal(evaluator.headless.jobs, 1)
  assert.equal(evaluator.headless.deferred_jobs, 17)
  assert.equal(evaluator.headless.deferred_reason, "no_time_for_a_run")
}))

test("inside the real loop worker, a 131-second scan with 18 ready jobs starts a run: the worker's grant reaches the step's limit", () => scratch(async (env, base) => {
  for (let index = 1; index <= 18; index += 1) await seedJob(env, base, index)
  // One fake clock on the real time for both, so the worker's lock file and the clock agree.
  let clock = Date.now()
  const runner = fakeRunner(() => { clock += 10 * 60 * 1000; return { state: "ran", cost_usd: null } })
  const done = async () => ({ ok: true, result: "done" })
  const outcome = await runLoopWorker(env, {
    deskRoot: path.join(base, "desk"), pluginVersion: VERSION, clock: () => clock, exit: () => {}, notify: () => {},
    impls: {
      evaluate: (stepEnv, options) => runEvaluatorStep(stepEnv, {
        ...options, clock: () => clock, runHeadless: runner, findAgentCli: () => "claude", probeSignIn: async () => ({ state: "subscription" }),
        requestFinishedJobs: async () => { clock += SCAN_MS; return { requested: [] } },
      }),
      routeIssues: done, routeLocal: done, mirror: done, reconcile: done, verify: done, measure: done, kick: async () => ({ kicked: false, reason: "test" }),
    },
  })
  assert.equal(outcome.steps.evaluate, "ran")
  assert.equal(runner.calls.length, 1)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.jobs, 1)
  assert.equal(evaluator.headless.deferred_reason, "no_time_for_a_run")
}))

test("without a caller that leaves the scan out, the same slow scan defers every job and says it had no time", () => scratch(async (env, base) => {
  const { options, outcome } = await slowScan(env, base)
  assert.deepEqual(outcome, { ok: false, result: "no_time_for_a_run" })
  assert.equal(options.runHeadless.calls.length, 0)
  const evaluator = await evaluatorOf(env)
  assert.equal(evaluator.headless.state, "no_time_for_a_run")
  assert.equal(evaluator.headless.deferred_jobs, 18)
  assert.equal(evaluator.headless.deferred_reason, "no_time_for_a_run")
  assert.equal(evaluator.ready_now, 18, "the jobs stay ready for the next worker")
}))

test("the step extends its run window only by what the caller grants, never more than the scan took", () => scratch(async (env, base) => {
  // A grant short of the 11 seconds that were missing leaves no time for a run.
  let { options, outcome } = await slowScan(env, base, { jobs: 1, extendDeadline: () => 1000 })
  assert.deepEqual(outcome, { ok: false, result: "no_time_for_a_run" })
  assert.equal(options.runHeadless.calls.length, 0)
}))

test("a grant outside zero to the scan's own time is read as the nearest bound, and a grant that is not a number as none", async () => {
  for (const [name, answer, runs] of [["junk", "x", 0], ["negative", -5, 0], ["not finite", Number.NaN, 0], ["too much", 365 * DAY, 1]]) {
    await scratch(async (env, base) => {
      const { options, outcome } = await slowScan(env, base, { jobs: 2, extendDeadline: () => answer })
      assert.equal(options.runHeadless.calls.length, runs, `${name}: capped at the scan, one run fits and the second does not`)
      assert.equal(outcome.result, runs === 0 ? "no_time_for_a_run" : "ran", name)
    })
  }
})

// ---------------------------------------------------------------------------
// The tight loop: the backstop, fresh finishes first, and the label lag.
// ---------------------------------------------------------------------------

// Labels of an older rubric for a seeded job's first session, with a marker whose log is still on disk, so it is relabeled.
async function labeledUnderRubric3(env, base, index) {
  const job = await seedJob(env, base, index)
  const session = sessionId(index * 10)
  const { unavailable, ...old } = structuredClone(LABELS)
  for (const stretch of old.stretches) delete stretch.caught
  await writeLocalLabels(env, STORE, { ...old, job, session, unavailable })
  const log = path.join(base, `log-${index}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, {
    schema_version: 1, host: "claude-code", session_id: session, log_path: log, cwd: base, desk_root: null,
    end_reason: "prompt_input_exit", ended_at: "2026-09-25T09:30:00.000Z", plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString(),
  })
  // The session's facts were derived with stop facts, so the rubric-4 relabel may run.
  const name = `claude-code-${session}.json`
  await updateStatus(env, (current) => ({ ...current, derivations: { ...current.derivations, [name]: { store: STORE, binding_version: STOP_FACTS_BINDING_VERSION } } }))
  return job
}

test("a finished job with no request is found by the backstop and labeled in the same step", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  const root = await factoryStateRoot(env)
  await fs.rm(path.join(root, "evaluate-requests", `${job}.json`))
  const options = seams({ deskRoot: path.join(base, "desk") })
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(options.runHeadless.calls.length, 1)
  assert.deepEqual(await listEvaluationRequests(env), [], "labeled, so the request it recorded is cleared")
}))

test("a backstop that fails never stops the step: the requests already waiting run", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const options = seams({ requestFinishedJobs: async () => { throw new Error("SENTINEL backstop") } })
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.equal(JSON.stringify(await readStatus(env)).includes("SENTINEL"), false)
}))

test("fresh finishes run before relabels, and the oldest finish first", () => scratch(async (env, base) => {
  const relabel = await labeledUnderRubric3(env, base, 1)
  const newer = await seedJob(env, base, 2)
  const older = await seedJob(env, base, 3)
  const root = await factoryStateRoot(env)
  const at = (job, finished) => fs.writeFile(path.join(root, "evaluate-requests", `${job}.json`), JSON.stringify({ schema_version: 1, job, desk_root: path.join(base, "desk"), requested_at: "2026-09-25T09:00:00.000Z", finished_at: finished }))
  await at(relabel, "2026-09-20T00:00:00.000Z")
  await at(newer, "2026-09-25T10:00:00.000Z")
  await at(older, "2026-09-24T10:00:00.000Z")
  const options = seams()
  await step(env, options)
  assert.deepEqual(options.runHeadless.calls.map((call) => call.job.job), [older, newer, relabel])
}))

test("the lag names the oldest finished job still unlabeled, counts them, and leaves out relabels", () => scratch(async (env, base) => {
  await labeledUnderRubric3(env, base, 1)
  const first = await seedJob(env, base, 2)
  const second = await seedJob(env, base, 3)
  const root = await factoryStateRoot(env)
  await fs.writeFile(path.join(root, "evaluate-requests", `${first}.json`), JSON.stringify({ schema_version: 1, job: first, desk_root: path.join(base, "desk"), requested_at: "2026-09-25T09:00:00.000Z", finished_at: "2026-09-24T10:00:00.000Z" }))
  // Every run fails, so nothing is labeled and both fresh finishes stay unlabeled.
  await step(env, seams({ runHeadless: fakeRunner(() => ({ state: "failed", cost_usd: null }), { write: false }) }))
  const { lag } = await evaluatorOf(env)
  assert.deepEqual(lag, { at: new Date(DAY0).toISOString(), unlabeled_jobs: 2, oldest_finished_at: "2026-09-24T10:00:00.000Z", unsupported_jobs: [], gave_up_jobs: [] })
  assert.ok(second)
}))

test("only a step that accepted a job's labels counts as labeling: a timeout, a spent run budget, a failed run and a rejected answer do not", () => scratch(async (env, base) => {
  const outcomes = [
    ["timeout", fakeRunner(() => ({ state: "timeout", cost_usd: null }), { write: false })],
    ["budget_exceeded", fakeRunner(() => ({ state: "budget_exceeded", cost_usd: 1 }), { write: false })],
    ["failed", fakeRunner(() => ({ state: "failed", cost_usd: null }), { write: false })],
    ["rejected", async (call) => {
      for (const file of call.briefPaths) await fs.writeFile(JSON.parse(await fs.readFile(file, "utf8")).output, JSON.stringify({ schema: "desk.factory.labels/3" }))
      return { state: "ran", cost_usd: 0.1, detail: null }
    }],
  ]
  for (const [index, [name, runner]] of outcomes.entries()) {
    await seedJob(env, base, index + 1)
    assert.deepEqual(await step(env, seams({ runHeadless: runner, now: DAY0 + index * DAY })), { ok: true, result: "ran" }, name)
    const evaluator = await evaluatorOf(env)
    assert.equal(evaluator.accepted_last_step, 0, name)
    assert.equal(evaluateDue(await readStatus(env), new Date(DAY0 + index * DAY + 60 * 1000), { kick: true }), false, `${name}: no drain`)
  }
  await seedJob(env, base, 9)
  const options = seams({ now: DAY0 + 5 * DAY })
  await step(env, options)
  assert.equal((await evaluatorOf(env)).accepted_last_step, options.runHeadless.calls.length, "every run that day was accepted")
  assert.ok(options.runHeadless.calls.length > 0)
}))

test("the step records how long its facts scan took, so the shrinking start window shows", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  let now = 0
  const clock = () => now
  const requestFinishedJobs = async () => { now += 4000; return { requested: [] } }
  await step(env, seams({ clock, requestFinishedJobs, runHeadless: fakeRunner(async () => { now += 60000; return { state: "ran", cost_usd: 0.1 } }) }))
  assert.equal((await evaluatorOf(env)).scan_ms, 4000)
}))

test("a finished job whose share keeps growing in a session that stays open is labeled again at most once a UTC day", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  const name = `claude-code-${sessionId(10)}.json`
  const grown = async (minutes) => {
    const facts = structuredClone(LOCAL)
    facts.session.id = sessionId(10)
    facts.session.ended_at = null
    facts.session.end_reason = null
    facts.session.derived_through = new Date(Date.parse(LOCAL.session.derived_through) + minutes * 60 * 1000).toISOString()
    facts.jobs = [{ ...facts.jobs[0], job }]
    await writeLocalFacts(env, STORE, facts)
  }
  await grown(0)
  const runs = []
  const options = (day) => seams({ now: DAY0 + day * DAY, deskRoot: path.join(base, "desk"), runHeadless: fakeRunner((call) => { runs.push(day); return { state: "ran", cost_usd: 0.1 } }) })
  await step(env, options(0))
  assert.deepEqual(runs, [0], "labeled at its finish")
  // The session runs on and is derived again twice the same day: the job's share grew, so it needs labels again, but it already ran today.
  await grown(10)
  await step(env, { ...options(0), now: DAY0 + 2 * 3600 * 1000 })
  await grown(20)
  await step(env, { ...options(0), now: DAY0 + 4 * 3600 * 1000 })
  assert.deepEqual(runs, [0])
  await step(env, options(1))
  assert.deepEqual(runs, [0, 1], "once the next day")
  await step(env, { ...options(1), now: DAY0 + DAY + 3600 * 1000 })
  assert.deepEqual(runs, [0, 1], "and not again that day: its evidence has not changed")
  assert.equal((await evaluatorOf(env)).gave_up, 0)
  assert.ok(name)
}))

test("a job whose unlabeled session the runner cannot label is named apart and never holds the lag; its labelable session still runs", () => scratch(async (env, base) => {
  const mixed = await seedJob(env, base, 1, { hosts: ["claude-code", "copilot-cli"] })
  const copilot = await seedJob(env, base, 2, { host: "copilot-cli" })
  const options = seams()
  assert.deepEqual(await step(env, options), { ok: true, result: "ran" })
  assert.deepEqual(options.runHeadless.calls.map((call) => call.job.job), [mixed])
  const evaluator = await evaluatorOf(env)
  assert.deepEqual(evaluator.lag, { at: new Date(DAY0).toISOString(), unlabeled_jobs: 0, oldest_finished_at: null, unsupported_jobs: [mixed, copilot], gave_up_jobs: [] })
  assert.deepEqual([evaluator.waiting, evaluator.ready_now, evaluator.ready_later], [2, 0, 0], "both wait, and neither can run here")
  // The accepted run starts the job's attempts again, keeping today's date.
  assert.deepEqual((await readStatus(env)).loop.evaluate.attempts[mixed], { attempts: 0, last_day: new Date(DAY0).toISOString().slice(0, 10) })
}))

test("a job at the attempt limit is named apart and never holds the lag, and an accepted run starts the count again", () => scratch(async (env, base) => {
  const job = await seedJob(env, base, 1)
  const failing = seams({ runHeadless: fakeRunner(() => ({ state: "failed", cost_usd: null }), { write: false }) })
  for (const day of [0, 1]) await step(env, { ...failing, now: DAY0 + day * DAY })
  let evaluator = await evaluatorOf(env)
  assert.deepEqual([evaluator.lag.unlabeled_jobs, evaluator.ready_now, evaluator.ready_later], [1, 0, 1], "tried today, so it runs again tomorrow")
  await step(env, { ...failing, now: DAY0 + 2 * DAY })
  evaluator = await evaluatorOf(env)
  assert.equal(evaluator.gave_up, 1)
  assert.deepEqual(evaluator.lag, { at: new Date(DAY0 + 2 * DAY).toISOString(), unlabeled_jobs: 0, oldest_finished_at: null, unsupported_jobs: [], gave_up_jobs: [job] })
  assert.deepEqual([evaluator.ready_now, evaluator.ready_later], [0, 0])

  // A second job fails twice, then is accepted: its count starts again, so it never reaches the limit.
  const other = await seedJob(env, base, 2, { hosts: ["claude-code", "copilot-cli"] })
  for (const day of [3, 4]) await step(env, { ...failing, now: DAY0 + day * DAY })
  assert.equal((await readStatus(env)).loop.evaluate.attempts[other].attempts, 2)
  await step(env, seams({ now: DAY0 + 5 * DAY }))
  assert.equal((await readStatus(env)).loop.evaluate.attempts[other].attempts, 0)
  assert.deepEqual((await evaluatorOf(env)).lag.gave_up_jobs, [job])
}))

test("a job left for want of time still counts as ready now", () => scratch(async (env, base) => {
  await seedJob(env, base, 1)
  const options = seams({ deadline: Date.now() })
  assert.deepEqual(await step(env, options), { ok: false, result: "no_time_for_a_run" })
  const evaluator = await evaluatorOf(env)
  assert.deepEqual([evaluator.waiting, evaluator.ready_now, evaluator.ready_later], [1, 1, 0])
  assert.equal(evaluator.headless.deferred_reason, "no_time_for_a_run")
}))

test("a job labeled in the step leaves the lag; a step with nothing waiting records none", () => scratch(async (env, base) => {
  await step(env, seams())
  await seedJob(env, base, 1)
  await step(env, seams({ now: DAY0 + DAY }))
  assert.deepEqual((await evaluatorOf(env)).lag, { at: new Date(DAY0 + DAY).toISOString(), unlabeled_jobs: 0, oldest_finished_at: null, unsupported_jobs: [], gave_up_jobs: [] })
}))
