// The loop worker: the ordered steps, the one-at-a-time lock, the time budget, the switches and the printed line.
// Every step is a fake that records its call; nothing starts a real agent CLI, a real network call or a process,
// and every test uses a throwaway HOME and state folder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import "../_isolated_env.mjs"
import { LOOP_BUDGET_MS, LOOP_STEP_NAMES, LATER_STEPS_RESERVE_MS, runLoopWorker } from "../../../../../plugins/desk/mcp/src/factory/loop-worker.js"
import { main, runLoopCommand, SUPPORTED_COMMANDS } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { recordStep } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"
import { takeLock } from "../../../../../plugins/desk/mcp/src/factory/process-lock.js"
import { readWorker, WORKER_STATE_FILE } from "../../../../../plugins/desk/mcp/src/factory/loop-worker-state.js"
import { factoryStateRoot, readStatus, requestEvaluation, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

const STORE = "ourostack/factory"
const MINUTE = 60 * 1000

async function scratch(run, { consent = true } = {}) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-loop-worker-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state"), PATH: path.join(base, "no-bin") })
  const desk = path.join(base, "desk-for-test")
  await fs.mkdir(desk)
  if (consent) await setConsent(env, { store: STORE, contribute: true, account: "someone" })
  try {
    return await run({ env, base, desk })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// A clock on the real time, so a lock file's real modification time and the fake clock agree.
function fakeClock() {
  const clock = { now: Date.now() }
  clock.read = () => clock.now
  clock.advance = (ms) => { clock.now += ms }
  return clock
}

// Fake steps in the shape of the real ones; the ones that record themselves do so, as the real ones do.
function fakes(log, { clock, over = {} } = {}) {
  const selfRecording = (name, key = name) => async (env, options) => {
    log.push([key, options])
    const { ok, result } = over[key]?.result ?? { ok: true, result: "done" }
    await recordStep(env, name, { ok, result, now: options.now })
    return { ok, result }
  }
  const collector = (key) => async (env, options) => {
    log.push([key, options])
    return over[key]?.result ?? { ok: true, result: "done" }
  }
  const impls = {
    evaluate: selfRecording("evaluate"), routeIssues: collector("routeIssues"), routeLocal: collector("routeLocal"),
    mirror: selfRecording("mirror"), reconcile: selfRecording("reconcile"), verify: selfRecording("verify"), measure: selfRecording("measure"),
  }
  for (const [key, value] of Object.entries(over)) if (value.throws) impls[key] = async () => { log.push([key]); throw new Error("PRIVATE boom") }
  return impls
}

const run = (ctx, log, extra = {}, over = {}) => runLoopWorker(ctx.env, {
  deskRoot: ctx.desk, personPrefix: "desks/ari", pluginVersion: "9.9.9", ...extra,
  impls: fakes(log, { over }),
})

const names = (log) => log.map(([name]) => name)

test("the steps run in exactly this order, each with the desk, the person and a time, and measure last with the names of the steps that ran", () => scratch(async (ctx) => {
  const log = []
  const clock = fakeClock()
  const outcome = await run(ctx, log, { clock: clock.read })
  assert.deepEqual(names(log), ["evaluate", "routeIssues", "routeLocal", "mirror", "reconcile", "verify", "measure"])
  assert.deepEqual(LOOP_STEP_NAMES, ["evaluate", "route", "mirror", "reconcile", "verify", "measure"])
  const by = Object.fromEntries(log)
  assert.equal(by.evaluate.pluginVersion, "9.9.9")
  assert.ok(by.evaluate.deadline.getTime() <= clock.now - 0 + LOOP_BUDGET_MS - LATER_STEPS_RESERVE_MS, "the evaluator's deadline leaves room for the later steps")
  assert.ok(by.evaluate.deadline.getTime() > clock.now, "and is in the future")
  assert.equal(typeof by.evaluate.onChild, "function")
  for (const key of ["routeIssues", "routeLocal", "mirror", "verify", "measure"]) {
    assert.equal(by[key].deskRoot, ctx.desk)
    assert.equal(by[key].personPrefix, "desks/ari")
    assert.ok(by[key].now instanceof Date)
  }
  assert.deepEqual(by.reconcile.desks, [ctx.desk])
  assert.equal(by.reconcile.personPrefix, "desks/ari")
  assert.deepEqual(by.measure.attempted, ["evaluate", "route", "mirror", "reconcile", "verify"])
  assert.deepEqual(outcome, {
    result: "completed", ran: 6, skipped: 0, failed: 0,
    steps: { evaluate: "done", route: "routed", mirror: "done", reconcile: "done", verify: "done", measure: "done" },
  })
  const status = await readStatus(ctx.env)
  assert.deepEqual(Object.keys(status.loop.steps).sort(), ["evaluate", "measure", "mirror", "reconcile", "route", "verify"])
  assert.equal(status.loop.steps.route.last_result, "routed")
  assert.equal(status.loop.steps.route.runs, 1, "the route pair records once")
}))

test("a step that throws records a failure and the next step still runs, with nothing of the error kept", () => scratch(async (ctx) => {
  const log = []
  const outcome = await run(ctx, log, {}, { mirror: { throws: true }, evaluate: { throws: true } })
  assert.deepEqual(names(log), ["evaluate", "routeIssues", "routeLocal", "mirror", "reconcile", "verify", "measure"])
  assert.equal(outcome.steps.evaluate, "step_error")
  assert.equal(outcome.steps.mirror, "step_error")
  assert.equal(outcome.steps.reconcile, "done")
  assert.equal(outcome.failed, 2)
  const status = await readStatus(ctx.env)
  assert.equal(status.loop.steps.mirror.last_result, "step_error")
  assert.equal(status.loop.steps.mirror.failures, 1)
  assert.equal(status.loop.steps.mirror.last_ok_at, null)
  assert.doesNotMatch(JSON.stringify(status), /PRIVATE/)
  assert.deepEqual((await run(ctx, [], {}, { measure: { throws: true } })).steps.measure, "step_error")
}))

test("a step that answers in the wrong shape counts as failed with a stable code and is not recorded by the worker", () => scratch(async (ctx) => {
  const impls = fakes([])
  impls.mirror = async () => undefined
  impls.verify = async () => ({ ok: true, result: "Has A Path /x/y" })
  impls.reconcile = async () => ({ ok: "yes", result: "done" })
  const outcome = await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls })
  assert.equal(outcome.steps.mirror, "invalid_result")
  assert.equal(outcome.steps.verify, "invalid_result")
  assert.equal(outcome.steps.reconcile, "invalid_result")
  assert.equal(outcome.failed, 3)
  assert.equal((await readStatus(ctx.env)).loop.steps.mirror, undefined)
}))

test("the route step is recorded once for the pair: ok only when both halves are, and the code says which half failed", () => scratch(async (ctx) => {
  const code = async (over) => {
    const outcome = await run(ctx, [], {}, over)
    const record = (await readStatus(ctx.env)).loop.steps.route
    await fs.rm(path.join(await factoryStateRoot(ctx.env), "status.json"), { force: true })
    return { code: outcome.steps.route, ok: record.last_ok_at !== null, failures: record.failures }
  }
  assert.deepEqual(await code({}), { code: "routed", ok: true, failures: 0 })
  assert.deepEqual(await code({ routeIssues: { result: { ok: false, result: "consent_unreadable" } } }), { code: "issues_failed", ok: false, failures: 1 })
  assert.deepEqual(await code({ routeLocal: { result: { ok: false, result: "status_unavailable" } } }), { code: "local_failed", ok: false, failures: 1 })
  assert.deepEqual(await code({ routeIssues: { result: { ok: false, result: "x" } }, routeLocal: { result: { ok: false, result: "y" } } }), { code: "both_failed", ok: false, failures: 1 })
  assert.deepEqual(await code({ routeIssues: { throws: true } }), { code: "issues_failed", ok: false, failures: 1 })
}))

test("a half that reports a headless session writes no route record", () => scratch(async (ctx) => {
  const outcome = await run(ctx, [], {}, { routeLocal: { result: { ok: false, result: "headless_session" } } })
  assert.equal(outcome.steps.route, "headless_session")
  assert.equal((await readStatus(ctx.env)).loop.steps.route, undefined)
}))

test("steps inside their minimum gap are skipped, leave last_ran_at as it was and are not in the attempted list", () => scratch(async (ctx) => {
  const clock = fakeClock()
  const earlier = new Date(clock.now - 60 * MINUTE)
  await recordStep(ctx.env, "route", { ok: true, result: "routed", now: earlier })
  await recordStep(ctx.env, "reconcile", { ok: true, result: "done", now: earlier })
  const log = []
  const outcome = await run(ctx, log, { clock: clock.read })
  assert.deepEqual(names(log), ["evaluate", "mirror", "verify", "measure"], "route and reconcile are inside their gaps (6 hours and 24 hours)")
  assert.deepEqual(Object.fromEntries(log).measure.attempted, ["evaluate", "mirror", "verify"])
  assert.equal(outcome.steps.route, "skipped")
  assert.equal(outcome.steps.reconcile, "skipped")
  assert.equal(outcome.skipped, 2)
  assert.equal(outcome.ran, 4)
  const status = await readStatus(ctx.env)
  assert.equal(status.loop.steps.route.last_ran_at, earlier.toISOString())
  assert.equal(status.loop.steps.route.runs, 1)
}))

test("a second worker finds the lock and answers busy without running anything, even when its clock jumps forward", () => scratch(async (ctx) => {
  const clock = fakeClock()
  const root = await factoryStateRoot(ctx.env)
  const held = await takeLock(root, { name: "loop-worker.running", record: { children: [] } })
  const log = []
  for (const jump of [0, 30 * MINUTE, 2 * 60 * MINUTE, 5 * 60 * MINUTE]) {
    clock.now = Date.now() + jump
    assert.deepEqual(await run(ctx, log, { clock: clock.read, alive: () => true }), { result: "busy", ran: 0, skipped: 0, failed: 0, steps: {} })
  }
  assert.deepEqual(log, [])
  assert.equal(JSON.parse(await fs.readFile(held.file, "utf8")).token, held.token, "the holder's lock is untouched")
}))

test("a lock whose process is gone, or that is older than the outer age, is taken over; the worker's own lock is released at the end", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  const lockFile = path.join(root, "locks", "loop-worker.running")
  await takeLock(root, { name: "loop-worker.running" })
  const log = []
  assert.equal((await run(ctx, log, { alive: () => false })).result, "completed", "a dead holder is replaced at once")
  await assert.rejects(fs.stat(lockFile), "the worker removed its lock")
  await takeLock(root, { name: "loop-worker.running" })
  const clock = fakeClock()
  clock.now += 7 * 60 * 60 * 1000
  assert.equal((await run(ctx, [], { clock: clock.read, alive: () => true })).result, "completed", "past the outer age a live-looking holder is replaced")
  await assert.rejects(fs.stat(lockFile))
}))

test("the worker does not remove a lock that now belongs to someone else", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  const lockFile = path.join(root, "locks", "loop-worker.running")
  const impls = fakes([])
  impls.mirror = async (env, options) => {
    await fs.writeFile(lockFile, JSON.stringify({ pid: process.pid, token: "another-worker", children: [] }))
    return { ok: true, result: "done" }
  }
  await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls })
  assert.equal(JSON.parse(await fs.readFile(lockFile, "utf8")).token, "another-worker")
}))

test("the child ids the evaluator step reports are listed in the lock while they run and removed when they exit, and nothing is signalled", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  const lockFile = path.join(root, "locks", "loop-worker.running")
  const seen = []
  const impls = fakes([])
  const kill = process.kill
  const signals = []
  process.kill = (...args) => { signals.push(args); return true }
  try {
    impls.evaluate = async (env, { onChild, onChildExit, now }) => {
      onChild(4321)
      onChild(4322)
      await new Promise((resolve) => setTimeout(resolve, 60))
      seen.push(JSON.parse(await fs.readFile(lockFile, "utf8")))
      onChildExit(4321)
      await new Promise((resolve) => setTimeout(resolve, 60))
      seen.push(JSON.parse(await fs.readFile(lockFile, "utf8")))
      onChild(4323)
      await recordStep(env, "evaluate", { ok: true, result: "ran", now })
      return { ok: true, result: "ran" }
    }
    await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls })
  } finally {
    process.kill = kill
  }
  assert.equal(seen[0].pid, process.pid)
  assert.ok(Number.isFinite(Date.parse(seen[0].started_at)))
  assert.deepEqual(seen[0].children, [4321, 4322])
  assert.deepEqual(seen[1].children, [4322])
  assert.deepEqual(signals, [], "the worker sends no signal at all")
  await assert.rejects(fs.stat(lockFile), "a child still listed when the step ends goes with the lock")
}))

test("the worker stops starting steps once the 20-minute budget is spent, and says so", () => scratch(async (ctx) => {
  const clock = fakeClock()
  const log = []
  const impls = fakes(log)
  const inner = impls.routeIssues
  impls.routeIssues = async (env, options) => { clock.advance(LOOP_BUDGET_MS + MINUTE); return inner(env, options) }
  const outcome = await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", clock: clock.read, impls })
  assert.deepEqual(names(log), ["evaluate", "routeIssues", "routeLocal"], "route's second half was already inside its step; no later step starts")
  assert.equal(outcome.result, "budget_spent")
  assert.deepEqual(outcome.steps, { evaluate: "done", route: "routed", mirror: "not_started", reconcile: "not_started", verify: "not_started", measure: "not_started" })
  assert.equal(outcome.ran, 2)
  const budgetOf = (value) => value
  assert.equal(budgetOf(LOOP_BUDGET_MS), 20 * MINUTE)
}))

test("a headless factory session starts nothing and writes nothing", () => scratch(async (ctx) => {
  const log = []
  const before = await fs.readdir(path.join(await factoryStateRoot(ctx.env)))
  for (const value of ["1", "yes", "anything"]) {
    assert.deepEqual(await runLoopWorker({ ...ctx.env, DESK_FACTORY_HEADLESS: value }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes(log) }), { result: "headless_session", ran: 0, skipped: 0, failed: 0, steps: {} })
  }
  assert.deepEqual(log, [])
  assert.deepEqual(await fs.readdir(path.join(await factoryStateRoot(ctx.env))), before, "no lock, no status, nothing new")
  assert.equal((await run({ ...ctx, env: { ...ctx.env, DESK_FACTORY_HEADLESS: "0" } }, [])).result, "completed", "the flag set to 0 is not a headless session")
}))

test("a damaged status file moved aside by the real reader stops the run, runs nothing, is recorded, and the next run that day goes on", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  await fs.writeFile(path.join(root, "status.json"), "{ damaged")
  const log = []
  const outcome = await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes(log) })
  assert.equal(outcome.result, "status_reset")
  assert.deepEqual(log, [])
  assert.ok(Object.values(outcome.steps).every((code) => code === "not_started"))
  assert.equal((await readStatus(ctx.env)).loop.worker.result, "status_reset")
  assert.equal((await run(ctx, log)).result, "completed", "the evaluator itself rests for the day (see loop_status_reset.test.js); the worker does not stop twice")
}))

test("every outcome is recorded as loop.worker { at, result, since } and since keeps the start of a repeated result", () => scratch(async (ctx) => {
  const clock = fakeClock()
  await runLoopWorker({ ...ctx.env, DESK_FACTORY_LOOP: "off" }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]), clock: clock.read })
  const first = (await readStatus(ctx.env)).loop.worker
  assert.deepEqual(first, { at: new Date(clock.now).toISOString(), result: "disabled", since: new Date(clock.now).toISOString() })
  clock.advance(3 * 60 * MINUTE)
  await runLoopWorker({ ...ctx.env, DESK_FACTORY_LOOP: "off" }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]), clock: clock.read })
  const second = (await readStatus(ctx.env)).loop.worker
  assert.equal(second.since, first.since)
  assert.equal(second.at, new Date(clock.now).toISOString())
  const root = await factoryStateRoot(ctx.env)
  const held = await takeLock(root, { name: "loop-worker.running", record: { children: [] } })
  clock.advance(MINUTE)
  assert.equal((await run(ctx, [], { clock: clock.read, alive: () => true })).result, "busy")
  const busy = (await readStatus(ctx.env)).loop.worker
  assert.equal(busy.result, "busy")
  assert.equal(busy.since, new Date(clock.now).toISOString(), "a different result starts a new since")
  clock.advance(2 * 60 * MINUTE)
  assert.equal((await run(ctx, [], { clock: clock.read, alive: () => true })).result, "busy")
  assert.equal((await readStatus(ctx.env)).loop.worker.since, busy.since, "a lock held for hours shows its age")
  await fs.rm(held.file)
  await run(ctx, [], {})
  assert.equal((await readStatus(ctx.env)).loop.worker.result, "completed")
  const impls = fakes([])
  const inner = impls.evaluate
  impls.evaluate = async (env, options) => { clock.advance(LOOP_BUDGET_MS + MINUTE); return inner(env, options) }
  await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", clock: clock.read, impls })
  assert.equal((await readStatus(ctx.env)).loop.worker.result, "budget_spent")
  await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]), readStatusImpl: async () => { throw new Error("x") } })
  assert.equal((await readStatus(ctx.env)).loop.worker.result, "status_unavailable")
}))

test("when the status cannot be written the same three fields go to a small file beside the lock, and readers take the newer of the two", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  const broken = async () => { throw new Error("cannot write") }
  await runLoopWorker({ ...ctx.env, DESK_FACTORY_LOOP: "off" }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]), updateStatusImpl: broken })
  const file = path.join(root, "locks", WORKER_STATE_FILE)
  const written = JSON.parse(await fs.readFile(file, "utf8"))
  assert.deepEqual(Object.keys(written).sort(), ["at", "result", "since"])
  assert.equal(written.result, "disabled")
  await runLoopWorker({ ...ctx.env, DESK_FACTORY_LOOP: "off" }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]), updateStatusImpl: broken })
  assert.equal(JSON.parse(await fs.readFile(file, "utf8")).since, written.since)
  assert.equal(readWorker(await readStatus(ctx.env), root).result, "disabled")
  assert.equal(readWorker(null, root).result, "disabled")
  await fs.writeFile(file, "not json")
  assert.equal(readWorker({ loop: { worker: { at: "2026-01-01T00:00:00.000Z", result: "completed", since: "2026-01-01T00:00:00.000Z" } } }, root).result, "completed")
  assert.equal(readWorker({ loop: { worker: { at: "x" } } }, root), null)
  const newer = { at: "2030-01-01T00:00:00.000Z", result: "busy", since: "2030-01-01T00:00:00.000Z" }
  await fs.writeFile(file, JSON.stringify(newer))
  assert.equal(readWorker({ loop: { worker: { at: "2026-01-01T00:00:00.000Z", result: "completed", since: "2026-01-01T00:00:00.000Z" } } }, root).result, "busy")
  assert.equal(readWorker({ loop: { worker: { at: "2031-01-01T00:00:00.000Z", result: "completed", since: "2031-01-01T00:00:00.000Z" } } }, root).result, "completed")
  await fs.rm(path.join(root, "locks"), { recursive: true, force: true })
  await fs.writeFile(path.join(root, "locks"), "a file where a folder should be")
  await runLoopWorker({ ...ctx.env, DESK_FACTORY_LOOP: "off" }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]), updateStatusImpl: broken })
}))

test("a headless session records nothing and no state folder records nothing, while a loop that is off records nothing without a state folder", async () => {
  await scratch(async (ctx) => {
    await runLoopWorker({ ...ctx.env, DESK_FACTORY_HEADLESS: "1" }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]) })
    assert.equal((await readStatus(ctx.env)).loop, undefined)
  })
  await scratch(async (ctx) => {
    assert.equal((await runLoopWorker({ ...ctx.env, DESK_FACTORY_LOOP: "off" }, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]) })).result, "disabled")
    await assert.rejects(fs.stat(path.join(ctx.base, "state")), "nothing is created")
  }, { consent: false })
})

test("the off switch turns the whole loop off for anything but 1, true, on or yes, and is reported as a result code", () => scratch(async (ctx) => {
  for (const value of ["0", "no", "off", "false", "", "2", "enabled"]) {
    const log = []
    const outcome = await run({ ...ctx, env: { ...ctx.env, DESK_FACTORY_LOOP: value } }, log)
    assert.equal(outcome.result, "disabled", `value ${JSON.stringify(value)}`)
    assert.deepEqual(log, [])
  }
  for (const value of [undefined, "1", "true", "on", "yes", " YES ", "On"]) {
    const env = { ...ctx.env }
    if (value !== undefined) env.DESK_FACTORY_LOOP = value
    assert.equal((await run({ ...ctx, env }, [])).result, "completed", `value ${JSON.stringify(value)}`)
  }
}))

test("no state folder, no consenting store and no desk each launch nothing and say why", async () => {
  await scratch(async (ctx) => {
    const log = []
    assert.equal((await run(ctx, log)).result, "no_factory_state")
    assert.deepEqual(log, [])
    await assert.rejects(fs.stat(path.join(ctx.base, "state")), "nothing was created")
  }, { consent: false })
  await scratch(async (ctx) => {
    await setConsent(ctx.env, { store: STORE, contribute: false })
    const log = []
    assert.equal((await run(ctx, log)).result, "no_consenting_store")
    assert.deepEqual(log, [])
  }, { consent: false })
  await scratch(async (ctx) => {
    const log = []
    assert.equal((await runLoopWorker(ctx.env, { deskRoot: null, pluginVersion: "9.9.9", impls: fakes(log) })).result, "no_desk")
    assert.deepEqual(log, [])
    await assert.rejects(runLoopWorker(ctx.env, { deskRoot: "relative/desk", pluginVersion: "9.9.9", impls: fakes(log) }), TypeError)
    await assert.rejects(runLoopWorker(ctx.env, { deskRoot: ctx.desk, personPrefix: "elsewhere", pluginVersion: "9.9.9", impls: fakes(log) }), TypeError)
  })
})

test("an unreadable status stops the worker before any step runs that would not know its gap", () => scratch(async (ctx) => {
  const log = []
  const outcome = await runLoopWorker(ctx.env, {
    deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes(log),
    readStatusImpl: async () => { throw new Error("/secret/path") },
  })
  assert.equal(outcome.result, "status_unavailable")
  assert.deepEqual(log, [])
  assert.equal(outcome.steps.evaluate, "not_started")
  await assert.rejects(fs.stat(path.join(await factoryStateRoot(ctx.env), "locks", "loop-worker.running")), "the lock is released")
}))

test("the worker ends the process itself if a step hangs past the ceiling, and not when it finishes in time", () => scratch(async (ctx) => {
  const exits = []
  const impls = fakes([])
  impls.mirror = () => new Promise((resolve) => setTimeout(() => resolve({ ok: true, result: "done" }), 120))
  await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls, ceilingMs: 30, exit: (code) => exits.push(code) })
  assert.deepEqual(exits, [0])
  const quick = []
  await runLoopWorker(ctx.env, { deskRoot: ctx.desk, pluginVersion: "9.9.9", impls: fakes([]), ceilingMs: 5000, exit: (code) => quick.push(code) })
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(quick, [])
}))

test("the command parses its options, takes the desk and person from the arguments and prints a result holding codes and integers only", () => scratch(async (ctx) => {
  assert.ok(SUPPORTED_COMMANDS.includes("loop"))
  await assert.rejects(runLoopCommand({ argv: ["--desk"], env: ctx.env }), /Usage: factory.js loop/)
  await assert.rejects(runLoopCommand({ argv: ["--desk", "relative"], env: ctx.env }), /Usage: factory.js loop/)
  await assert.rejects(runLoopCommand({ argv: ["--desk", ctx.desk, "--store", "x/y"], env: ctx.env }), /Usage: factory.js loop/)
  await assert.rejects(runLoopCommand({ argv: ["--desk", ctx.desk, "--person-prefix", "nope"], env: ctx.env }), /Usage: factory.js loop/)
  const log = []
  const outcome = await runLoopCommand({ argv: ["--desk", ctx.desk, "--person-prefix", "desks/ari"], env: ctx.env, impls: fakes(log), pluginVersion: "9.9.9" })
  assert.equal(outcome.result, "completed")
  assert.equal(Object.fromEntries(log).mirror.deskRoot, ctx.desk)
  assert.equal(Object.fromEntries(log).mirror.personPrefix, "desks/ari")
  assert.equal((await runLoopCommand({ argv: [], env: ctx.env, impls: fakes([]) })).result, "no_desk")
  const solo = []
  await runLoopCommand({ argv: ["--desk", ctx.desk], env: ctx.env, impls: fakes(solo), pluginVersion: "9.9.9" })
  assert.equal(Object.fromEntries(solo).measure.personPrefix, "")
  // Everything the command can print is a short code or an integer.
  const walk = (value, where) => {
    if (typeof value === "object" && value !== null) for (const [key, inner] of Object.entries(value)) walk(inner, `${where}.${key}`)
    else assert.ok(Number.isSafeInteger(value) || (typeof value === "string" && /^[a-z0-9_:-]{1,64}$/u.test(value)), `${where} is a code or an integer`)
  }
  walk(outcome, "result")
  assert.doesNotMatch(JSON.stringify(outcome), /desk-for-test|ourostack|someone|\//u)
}))

test("main prints one JSON line for the loop command and exits 1 only when a step failed", () => scratch(async (ctx) => {
  const out = []
  const code = await main({ argv: ["loop", "--desk", ctx.desk], env: { ...ctx.env, DESK_FACTORY_LOOP: "off" }, write: (text) => out.push(text), logError: () => {} })
  assert.equal(code, 0)
  assert.equal(out.length, 1)
  assert.deepEqual(JSON.parse(out[0]), { result: "disabled", ran: 0, skipped: 0, failed: 0, steps: {} })
  assert.ok(out[0].endsWith("\n"))
  assert.doesNotMatch(out[0], /desk-for-test|\//u)
}))

test("an evaluation request newer than the evaluator step's last run makes the step run inside its gap, and the step is given the desk", () => scratch(async (ctx) => {
  const clock = fakeClock()
  await recordStep(ctx.env, "evaluate", { ok: true, result: "no_jobs_waiting", now: new Date(clock.now - 10 * MINUTE) })
  const log = []
  await run(ctx, log, { clock: clock.read })
  assert.equal(names(log).includes("evaluate"), false, "inside its gap with no newer request")
  await requestEvaluation(ctx.env, { job: "ab".repeat(16), deskRoot: ctx.desk })
  const again = []
  await run(ctx, again, { clock: clock.read })
  assert.equal(names(again)[0], "evaluate")
  assert.equal(Object.fromEntries(again).evaluate.deskRoot, ctx.desk)
}))

test("requests that cannot be read make nothing due early", () => scratch(async (ctx) => {
  const clock = fakeClock()
  await recordStep(ctx.env, "evaluate", { ok: true, result: "no_jobs_waiting", now: new Date(clock.now - 10 * MINUTE) })
  const root = await factoryStateRoot(ctx.env)
  await fs.writeFile(path.join(root, "evaluate-requests"), "not a folder")
  const log = []
  const outcome = await run(ctx, log, { clock: clock.read })
  assert.equal(outcome.steps.evaluate, "skipped")
}))
