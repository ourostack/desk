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
  evaluationKickDue,
  kickLoop,
  newestRequestAt,
} from "../../../../../plugins/desk/mcp/src/factory/evaluate-kick.js"
import { recordStep } from "../../../../../plugins/desk/mcp/src/factory/loop-status.js"
import { factoryStateRoot, requestEvaluation } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

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
  assert.deepEqual(await evaluationKickDue(env, { now: requestedMs + 61 * MINUTE }), { due: true, reason: "due" }, "past the gap with a request still waiting")
}))

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
