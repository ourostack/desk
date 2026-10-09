// The evaluation kick: the end of a turn and a finalize run start the loop worker when the evaluator step is due, so a finished job's
// evaluation starts within the hour. Every spawn goes through an injected fake; nothing starts a process, and every test uses a throwaway
// HOME and state folder.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync, utimesSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import {
  KICK_LOCK_AGE_MS,
  LOOP_LOCK_NAME,
  LOOP_START_SCRIPT,
  evaluateDue,
  evaluationKickDue,
  kickLoop,
  newestRequestAt,
} from "../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js"
import { recordStep } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"
import { MAX_HEADLESS_JOBS_PER_DAY } from "../../../../../plugins/desk/mcp/src/factory/headless.js"
import { factoryStateRoot, requestEvaluation, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

const MINUTE = 60 * 1000
const JOB = "ab".repeat(16)

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-evaluate-kick-")))
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  try {
    return await run(env, base)
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function fakeSpawn() {
  const calls = []
  const spawn = (...args) => {
    calls.push(args)
    return { once: () => {}, unref: () => { calls.unrefd = true } }
  }
  spawn.calls = calls
  return spawn
}

test("the launcher the kick starts is the session-start hook's own", async () => {
  assert.equal(path.basename(LOOP_START_SCRIPT), "loop-start.cjs")
  assert.equal(path.basename(path.dirname(LOOP_START_SCRIPT)), "hooks")
  await fs.access(LOOP_START_SCRIPT)
  assert.equal(LOOP_LOCK_NAME, "loop-worker.running")
  assert.equal(KICK_LOCK_AGE_MS, 22 * MINUTE)
})

test("nothing is due in a headless session, with the loop off, without factory state or with no request waiting", () => scratch(async (env, base) => {
  assert.deepEqual(await evaluationKickDue({ ...env, DESK_FACTORY_HEADLESS: "1" }), { due: false, reason: "headless_session" })
  assert.deepEqual(await evaluationKickDue({ ...env, DESK_FACTORY_LOOP: "0" }), { due: false, reason: "disabled" })
  assert.deepEqual(await evaluationKickDue(env), { due: false, reason: "no_factory_state" })
  await factoryStateRoot(env)
  assert.deepEqual(await evaluationKickDue(env), { due: false, reason: "no_requests" })
  assert.equal(await newestRequestAt(env), null)
  await requestEvaluation(env, { job: JOB, deskRoot: path.join(base, "desk") })
  assert.equal(typeof (await newestRequestAt(env)), "number")
}))

test("a request newer than the step's last run is due at once; an older one waits out the 1-hour gap", () => scratch(async (env, base) => {
  const request = await requestEvaluation(env, { job: JOB, deskRoot: path.join(base, "desk") })
  const requestedMs = Date.parse(request.requested_at)
  assert.deepEqual(await evaluationKickDue(env, { now: requestedMs }), { due: true, reason: "due" }, "the step never ran")
  await recordStep(env, "evaluate", { ok: true, result: "no_jobs_waiting", now: requestedMs - MINUTE })
  assert.deepEqual(await evaluationKickDue(env, { now: requestedMs + MINUTE }), { due: true, reason: "due" }, "a fresh finish")
  await recordStep(env, "evaluate", { ok: true, result: "ran", now: requestedMs + MINUTE })
  assert.deepEqual(await evaluationKickDue(env, { now: requestedMs + 2 * MINUTE }), { due: false, reason: "not_due" })
  // A request this machine cannot prepare or run keeps no kick firing past the gap.
  assert.deepEqual(await evaluationKickDue(env, { now: requestedMs + 61 * MINUTE }), { due: false, reason: "not_due" }, "nothing the runner can run waits")
  await updateStatus(env, (current) => ({ ...current, evaluator: { ready_now: 1, ready_later: 0, accepted_last_step: 1 } }))
  assert.deepEqual(await evaluationKickDue(env, { now: requestedMs + 2 * MINUTE }), { due: true, reason: "due" }, "the queue drains at once after a run that labeled a job")
}))

// A status with the evaluator step's record and its own counts, on `day` (an ISO day) at `ranAt`.
const stored = ({ result, ranAt, readyNow = 0, readyLater = 0, day, jobs = 0, accepted = 1 }) => ({
  loop: { steps: { evaluate: { last_ran_at: new Date(ranAt).toISOString(), last_result: result } } },
  evaluator: { ready_now: readyNow, ready_later: readyLater, accepted_last_step: accepted, headless: { day, jobs } },
})

test("evaluateDue drains after a run that labeled a job, within the day's ceiling, and past the gap kicks only for a job the runner can run", () => {
  const now = Date.parse("2026-10-08T12:00:00.000Z")
  const today = "2026-10-08"
  const soon = now - 5 * MINUTE
  const long = now - 61 * MINUTE
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: soon, readyNow: 2, day: today, jobs: 3 }), new Date(now), { kick: true }), true, "draining")
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: soon, readyNow: 2, day: today, jobs: MAX_HEADLESS_JOBS_PER_DAY }), new Date(now), { kick: true }), false, "the ceiling is spent")
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: soon, readyNow: 2, day: today, accepted: 0 }), new Date(now), { kick: true }), false, "a run that labeled nothing ends the drain")
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: soon, readyNow: 2, day: today, accepted: 0 }), new Date(now)), false, "and the worker waits out the gap too")
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: soon, readyNow: 0, readyLater: 2, day: today }), new Date(now), { kick: true }), false, "only jobs tried today are left")
  assert.equal(evaluateDue(stored({ result: "none_could_run", ranAt: soon, readyNow: 1, day: today }), new Date(now), { kick: true }), false, "inside the gap without a labeled job")
  assert.equal(evaluateDue(stored({ result: "none_could_run", ranAt: long, readyNow: 1, day: today }), new Date(now), { kick: true }), true, "past the gap with a job to run")
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: long, readyLater: 1, day: today }), new Date(now), { kick: true }), false, "tried today waits for tomorrow")
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: long, readyLater: 1, day: "2026-10-07" }), new Date(now), { kick: true }), true, "tried on an earlier day")
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: long, readyLater: 1, day: today, jobs: MAX_HEADLESS_JOBS_PER_DAY }), new Date(now), { kick: true }), false)
  // The worker itself keeps the plain gap, so its backstop still looks for finished jobs every hour.
  assert.equal(evaluateDue(stored({ result: "no_jobs_waiting", ranAt: long, day: today }), new Date(now)), true)
  assert.equal(evaluateDue(stored({ result: "no_jobs_waiting", ranAt: soon, day: today }), new Date(now)), false)
  // New work always counts, and a step that never ran, or a damaged record, is due.
  assert.equal(evaluateDue(stored({ result: "ran", ranAt: soon, day: today }), new Date(now), { newWorkAt: now - MINUTE, kick: true }), true)
  assert.equal(evaluateDue({}, new Date(now), { kick: true }), true)
  assert.equal(evaluateDue({ evaluator: "x", loop: { steps: { evaluate: "x" } } }, new Date(now), { kick: true }), true)
  assert.equal(evaluateDue({ loop: { steps: { evaluate: { last_ran_at: new Date(long).toISOString(), last_result: "ran" } } }, evaluator: { ready_now: -1, headless: "x" } }, new Date(now), { kick: true }), false)
})

test("a loop worker that holds its lock and is younger than its hard stop is left alone; an older lock is the worker's own takeover", () => scratch(async (env, base) => {
  await requestEvaluation(env, { job: JOB, deskRoot: path.join(base, "desk") })
  const root = await factoryStateRoot(env)
  await fs.mkdir(path.join(root, "locks"), { recursive: true })
  const lock = path.join(root, "locks", LOOP_LOCK_NAME)
  await fs.writeFile(lock, "{}")
  assert.deepEqual(await evaluationKickDue(env), { due: false, reason: "worker_running" })
  const old = (Date.now() - KICK_LOCK_AGE_MS - MINUTE) / 1000
  utimesSync(lock, old, old)
  assert.deepEqual(await evaluationKickDue(env), { due: true, reason: "due" })
}))

test("anything that cannot be read starts nothing", () => scratch(async (env, base) => {
  await requestEvaluation(env, { job: JOB, deskRoot: path.join(base, "desk") })
  assert.deepEqual(await evaluationKickDue(env, { readStatusImpl: async () => { throw new Error("SENTINEL") } }), { due: false, reason: "unreadable" })
  const root = await factoryStateRoot(env)
  await fs.rm(path.join(root, "locks"), { recursive: true, force: true })
  await fs.writeFile(path.join(root, "locks"), "not a folder")
  assert.deepEqual(await evaluationKickDue(env), { due: false, reason: "unreadable" })
  const spawn = fakeSpawn()
  assert.deepEqual(await kickLoop(env, { spawn }), { kicked: false, reason: "unreadable" })
  assert.equal(spawn.calls.length, 0, "an invalid lock directory must not start a worker")
}))

test("a missing lock directory or missing worker lock still permits a due kick", () => scratch(async (env, base) => {
  await requestEvaluation(env, { job: JOB, deskRoot: path.join(base, "desk") })
  const root = await factoryStateRoot(env)
  const locks = path.join(root, "locks")
  await fs.rm(locks, { recursive: true, force: true })
  assert.deepEqual(await evaluationKickDue(env), { due: true, reason: "due" }, "a genuinely absent directory is not malformed")
  await fs.mkdir(locks)
  assert.deepEqual(await evaluationKickDue(env), { due: true, reason: "due" }, "a real directory without a worker lock permits the kick")
}))

test("kickLoop starts the launcher detached with this environment only when due, and a spawn that throws is spawn_failed", () => scratch(async (env, base) => {
  const spawn = fakeSpawn()
  assert.deepEqual(await kickLoop(env, { spawn }), { kicked: false, reason: "no_factory_state" })
  assert.equal(spawn.calls.length, 0)
  await requestEvaluation(env, { job: JOB, deskRoot: path.join(base, "desk") })
  assert.deepEqual(await kickLoop(env, { spawn, execPath: "/node" }), { kicked: true, reason: "due" })
  const [[cmd, args, options]] = spawn.calls
  assert.deepEqual([cmd, args], ["/node", [LOOP_START_SCRIPT]])
  assert.deepEqual({ detached: options.detached, stdio: options.stdio, env: options.env }, { detached: true, stdio: "ignore", env })
  assert.equal(spawn.calls.unrefd, true)
  // A launcher that fails to start after spawn returns raises an error event; the kick listens for it so it cannot crash the hook.
  let onError = null
  assert.deepEqual(await kickLoop(env, { spawn: () => ({ once: (event, handler) => { if (event === "error") onError = handler } }) }), { kicked: true, reason: "due" })
  assert.equal(typeof onError, "function")
  assert.equal(onError(new Error("ENOENT")), undefined)
  assert.deepEqual(await kickLoop(env, { spawn: () => { throw new Error("SENTINEL") } }), { kicked: false, reason: "spawn_failed" })
  // A spawn answer without the event methods (as a test double may give) is still fine.
  assert.deepEqual(await kickLoop(env, { spawn: () => ({}) }), { kicked: true, reason: "due" })
}))

test("with its defaults and nothing due, kickLoop starts nothing", () => scratch(async (env) => {
  assert.deepEqual(await kickLoop(env), { kicked: false, reason: "no_factory_state" })
}))
