// The evaluation kick: what makes a finished job's evaluation start within the hour, not at the next session start.
//
// The loop worker (`loop-worker.js`) runs the evaluator step, and the session-start hook used to be the only thing
// that started the worker. A long session never starts again, so a job finished in one could wait for labels until
// some later session began. The kick closes that gap: at the end of a turn (`hooks/lib/factory-end.cjs`, the Stop
// hook) and right after a finalize run has derived the finished job's sessions (`factory.js finalize`), Desk starts
// the loop worker the same way the session-start hook does (`hooks/loop-start.cjs`, detached), but only when the
// evaluator step is due:
//
//   - an evaluation request was recorded after the step last ran (a fresh finish: due at once, whatever the gap), or
//   - requests wait and the step's own minimum gap (`MIN_GAP_HOURS.evaluate`, 1 hour) has passed.
//
// It starts nothing in a headless factory session, with the loop switched off (`DESK_FACTORY_LOOP`), without factory
// state, with no request waiting, or while a loop worker holds its lock and is younger than the worker's own hard
// stop. The kick changes no budget rule: the worker it starts runs the same evaluator step, under the same daily cap,
// sign-in probe and billing rules (`disabled_would_bill` stays the person's decision), and a busy worker answers
// `busy` as before. Answers are codes only.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files; the launcher is a path, not an import.

import { spawn as nodeSpawn } from "node:child_process"
import { createRequire } from "node:module"
import { promises as fsp } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { isHeadlessFactorySession } from "./headless-flag.js"
import { dueStep } from "./loop-status.js"
import { factoryStateRoot, listEvaluationRequests, readStatus } from "./outbox.js"

const { isLoopEnabled } = createRequire(import.meta.url)("./loop-switch.cjs")

/** The loop worker's lock file name under `<state>/locks/` (`loop-worker.js`). */
export const LOOP_LOCK_NAME = "loop-worker.running"
/** A worker lock younger than this is a worker still running (the launcher's hard stop is 22 minutes); an older one is left to the worker's own takeover. */
export const KICK_LOCK_AGE_MS = 22 * 60 * 1000
/** The launcher the kick starts, the one the session-start hook starts. */
export const LOOP_START_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "loop-start.cjs")

/** `newestRequestAt(env) -> number | null`: the newest waiting evaluation request's own time in milliseconds, `null` when none waits. */
export async function newestRequestAt(env) {
  const times = (await listEvaluationRequests(env)).map((request) => Date.parse(request.requested_at))
  return times.length === 0 ? null : Math.max(...times)
}

/**
 * `evaluationKickDue(env, { now, readStatusImpl }) -> { due, reason }`: whether the end of this turn should start the loop worker, as the header
 * says. `reason` is `due`, `headless_session`, `disabled`, `no_factory_state`, `no_requests`, `worker_running` or `not_due`. It never throws:
 * anything it cannot read is `unreadable`, which starts nothing.
 */
export async function evaluationKickDue(env, { now = Date.now(), readStatusImpl = readStatus } = {}) {
  if (isHeadlessFactorySession(env)) return { due: false, reason: "headless_session" }
  if (!isLoopEnabled(env)) return { due: false, reason: "disabled" }
  try {
    const root = await factoryStateRoot(env, { create: false })
    if (root === null) return { due: false, reason: "no_factory_state" }
    const newest = await newestRequestAt(env)
    if (newest === null) return { due: false, reason: "no_requests" }
    if (await workerRunning(root, now)) return { due: false, reason: "worker_running" }
    const due = dueStep(await readStatusImpl(env), "evaluate", new Date(now), { newWorkAt: newest })
    return { due, reason: due ? "due" : "not_due" }
  } catch {
    return { due: false, reason: "unreadable" }
  }
}

async function workerRunning(root, now) {
  try {
    const stat = await fsp.lstat(path.join(root, "locks", LOOP_LOCK_NAME))
    return now - stat.mtimeMs < KICK_LOCK_AGE_MS
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

/**
 * `kickLoop(env, { now, spawn, execPath, readStatusImpl }) -> { kicked, reason }`: starts the loop launcher detached, with ignored stdio and
 * this process's environment, when `evaluationKickDue` says so, and returns at once. A launcher that cannot be started is `spawn_failed`.
 * `spawn` and `execPath` are seams for tests.
 */
export async function kickLoop(env, { now = Date.now(), spawn = nodeSpawn, execPath = process.execPath, readStatusImpl = readStatus } = {}) {
  const { due, reason } = await evaluationKickDue(env, { now, readStatusImpl })
  if (!due) return { kicked: false, reason }
  try {
    const child = spawn(execPath, [LOOP_START_SCRIPT], { detached: true, stdio: "ignore", windowsHide: true, env })
    child.once?.("error", () => {})
    child.unref?.()
    return { kicked: true, reason }
  } catch {
    return { kicked: false, reason: "spawn_failed" }
  }
}
