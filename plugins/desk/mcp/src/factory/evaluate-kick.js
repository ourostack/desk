// The evaluation kick: what makes a finished job's evaluation start within the hour, not at the next session start.
//
// The loop worker (`loop-worker.js`) runs the evaluator step, and the session-start hook used to be the only thing
// that started the worker. A long session never starts again, so a job finished in one could wait for labels until
// some later session began. The kick closes that gap: at the end of a turn (`hooks/lib/factory-end.cjs`, the Stop
// hook) and right after a finalize run has derived the finished job's sessions (`factory.js finalize`), Desk starts
// the loop worker the same way the session-start hook does (`hooks/loop-start.cjs`, detached), but only when the
// evaluator step is due for the kick (`evaluateDue` with `kick`):
//
//   - an evaluation request was recorded after the step last ran (a fresh finish: due at once, whatever the gap);
//   - the queue is draining: the step's last run accepted a job's labels (`status.evaluator.accepted_last_step`), jobs the runner can run today are left
//     (`status.evaluator.ready_now`) and the day's ceiling is not spent (due at once); or
//   - the step's own minimum gap (`MIN_GAP_HOURS.evaluate`, 1 hour) has passed and a job the runner can run waits: one
//     not attempted today, or one attempted on an earlier UTC day than today. Requests this machine cannot prepare
//     (a job with no session here) or run (an unsupported host, the attempt limit) never keep the kick firing.
//
// A loop worker whose evaluator step labeled a job kicks once more when it ends (`loop-worker.js`), so the queue
// drains back to back, one worker after another, until nothing the runner can run today is left. Every run stays
// inside the daily ceiling (`MAX_HEADLESS_JOBS_PER_DAY`), the 3-attempt limit and one attempt per job per UTC day. The ceiling is the
// shared launch ledger's (`headless-ledger.js`): the day is spent for the kick when the evaluator's own count reached it, or when the
// witnessed shared quota leaves no evaluation launch now (spent, or held back for triage's unused windows).
//
// The kick also starts the worker when improvement triage is due with no evaluation request waiting (`triageKickDue`): the
// shared ledger's witness leaves a triage launch now, the last triage step found cards waiting for a review,
// its runner was not unavailable on this host, and the step last ran at least `TRIAGE_KICK_GAP_MS` ago. No request no longer
// means no worker when triage is due. A triage-only worker generation kicks once more when it ends with a fresh evaluation
// continuation (`kickLoop` with `continuation`), so the evaluation it deferred starts without another turn; that kick skips
// only the due check, never the switches, the state folder or a running worker.
//
// It starts nothing in a headless factory session, with the loop switched off (`DESK_FACTORY_LOOP`), without factory
// state, with no request waiting and no triage due, or while a loop worker holds its lock and is younger than the worker's own hard
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
import { MAX_HEADLESS_JOBS_PER_DAY } from "./headless.js"
import { evaluationQuotaOpen, quotaFor, validWitness } from "./headless-ledger.js"
import { dueStep } from "./loop-status.js"
import { factoryStateRoot, listEvaluationRequests, readStatus } from "./outbox.js"

const { isLoopEnabled } = createRequire(import.meta.url)("./loop-switch.cjs")

/** The loop worker's lock file name under `<state>/locks/` (`loop-worker.js`). */
export const LOOP_LOCK_NAME = "loop-worker.running"
/** A worker lock younger than this is a worker still running (the launcher's hard stop is 22 minutes, and a worker granted facts-scan time rewrites its lock then, with less than this left to run); an older one is left to the worker's own takeover. */
export const KICK_LOCK_AGE_MS = 22 * 60 * 1000
/** The launcher the kick starts, the one the session-start hook starts. */
export const LOOP_START_SCRIPT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "hooks", "loop-start.cjs")

/** `newestRequestAt(env) -> number | null`: the newest waiting evaluation request's own time in milliseconds, `null` when none waits. */
export async function newestRequestAt(env) {
  const times = (await listEvaluationRequests(env)).map((request) => Date.parse(request.requested_at))
  return times.length === 0 ? null : Math.max(...times)
}

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const tally = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)

/**
 * `evaluateDue(status, now, { newWorkAt, kick }) -> boolean`: whether the evaluator step is due. The loop worker asks without `kick`: the step's
 * gap (`dueStep`) or a request newer than its last run, or the queue draining (see the header). The kick (`kick: true`) asks the same, except
 * that past the gap it starts a worker only when a job the runner can run waits.
 */
export function evaluateDue(status, now, { newWorkAt = null, kick = false } = {}) {
  const evaluator = isObject(status?.evaluator) ? status.evaluator : {}
  const record = isObject(status?.loop?.steps?.evaluate) ? status.loop.steps.evaluate : {}
  const ranAt = Date.parse(record.last_ran_at)
  if (Number.isNaN(ranAt) || (Number.isFinite(newWorkAt) && newWorkAt > ranAt)) return dueStep(status, "evaluate", now, { newWorkAt })
  const today = new Date(now).toISOString().slice(0, 10)
  const headless = isObject(evaluator.headless) ? evaluator.headless : {}
  // Spent by the evaluator's own count, or by the shared launch ledger's witnessed quota (triage's protected windows included).
  const spent = (headless.day === today && tally(headless.jobs) >= MAX_HEADLESS_JOBS_PER_DAY) || !evaluationQuotaOpen(status, now)
  // Only a step that accepted a job's labels drains on: a run that timed out, spent its budget, failed or was rejected waits out the gap.
  if (record.last_result === "ran" && tally(evaluator.accepted_last_step) > 0 && tally(evaluator.ready_now) > 0 && !spent) return true
  if (!kick) return dueStep(status, "evaluate", now)
  const runnable = tally(evaluator.ready_now) > 0 || (tally(evaluator.ready_later) > 0 && typeof headless.day === "string" && headless.day < today)
  return runnable && !spent && dueStep(status, "evaluate", now)
}

const HOUR_MS = 60 * 60 * 1000
/** The shortest time between two kicks for triage: a triage step that could not launch is not asked again at every turn's end. */
export const TRIAGE_KICK_GAP_MS = HOUR_MS
// The triage step's runner states in which no run can start until the host or the person changes something (`triage-step.js`).
const TRIAGE_RUNNER_UNAVAILABLE = new Set(["unsupported_host", "scope_unqualified", "no_agent_cli", "no_credentials", "disabled_would_bill", "sign_in_unknown", "headless_session"])
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
// How far the clock may read behind the witnessed clock, as the ledger allows.
const CLOCK_SKEW_MS = 5 * 60 * 1000

/**
 * `triageQuotaFor(status, nowMs) -> state`: what the shared ledger's high-water witness (`status.loop.agent_launch_highwater`) says about
 * one triage launch at `nowMs`, without the ledger's lock: `ok`, `unwitnessed` (no witness yet: the reservation migrates or refuses),
 * `witness_invalid`, `clock_regressed`, or a quota code (`quota_exhausted`, `window_used`, `triage_cooldown`). Only a reservation is
 * authoritative; this only spares preparing a run that cannot start.
 */
export function triageQuotaFor(status, nowMs) {
  const witness = isObject(status?.loop) ? status.loop.agent_launch_highwater : undefined
  if (witness === undefined) return "unwitnessed"
  if (!validWitness(witness)) return "witness_invalid"
  if (witness.max_clock_ms > nowMs + CLOCK_SKEW_MS || witness.max_day > dayOf(nowMs + CLOCK_SKEW_MS)) return "clock_regressed"
  const at = Math.max(nowMs, witness.max_clock_ms)
  const later = dayOf(at) > witness.max_day
  const ledger = { day: later ? dayOf(at) : witness.max_day, spent: later ? 0 : witness.spent_at_max_day, windows: later ? [0, 0, 0, 0] : witness.windows, last_triage_at: witness.last_triage_at }
  return quotaFor(ledger, "triage", at).state
}

/**
 * `triageKickDue(status, now) -> boolean`: whether improvement triage alone makes the end of a turn start the loop worker (see the header).
 * Never before the triage step has run once on this machine (the session-start worker runs it first), so a machine whose worker cannot
 * reach the step is not kicked at every turn's end.
 */
export function triageKickDue(status, now) {
  const nowMs = new Date(now).getTime()
  const triage = isObject(status?.triage) ? status.triage : null
  const ranAt = Date.parse(status?.loop?.steps?.triage?.last_ran_at)
  if (triage === null || Number.isNaN(ranAt) || nowMs - ranAt < TRIAGE_KICK_GAP_MS) return false
  if (TRIAGE_RUNNER_UNAVAILABLE.has(triage.runner?.state) || !(Number.isSafeInteger(triage.eligible) && triage.eligible > 0)) return false
  return ["ok", "unwitnessed"].includes(triageQuotaFor(status, nowMs))
}

/**
 * `evaluationKickDue(env, { now, readStatusImpl }) -> { due, reason }`: whether the end of this turn should start the loop worker, as the header
 * says, or, with `continuation`, whether anything but the due check stops the one kick a triage-only worker owes its deferred evaluation.
 * `reason` is `due`, `continuation`, `headless_session`, `disabled`, `no_factory_state`, `no_requests` (no request waits and triage is
 * not due), `worker_running` or `not_due`. It never throws: anything it cannot read is `unreadable`, which starts nothing.
 */
export async function evaluationKickDue(env, { now = Date.now(), readStatusImpl = readStatus, continuation = false } = {}) {
  if (isHeadlessFactorySession(env)) return { due: false, reason: "headless_session" }
  if (!isLoopEnabled(env)) return { due: false, reason: "disabled" }
  try {
    const root = await factoryStateRoot(env, { create: false })
    if (root === null) return { due: false, reason: "no_factory_state" }
    if (continuation) {
      if (await workerRunning(root, now)) return { due: false, reason: "worker_running" }
      return { due: true, reason: "continuation" }
    }
    const newest = await newestRequestAt(env)
    const status = await readStatusImpl(env)
    const triage = triageKickDue(status, now)
    if (newest === null && !triage) return { due: false, reason: "no_requests" }
    if (await workerRunning(root, now)) return { due: false, reason: "worker_running" }
    const due = triage || evaluateDue(status, new Date(now), { newWorkAt: newest, kick: true })
    return { due, reason: due ? "due" : "not_due" }
  } catch {
    return { due: false, reason: "unreadable" }
  }
}

async function workerRunning(root, now) {
  try {
    const locks = path.join(root, "locks")
    // Windows reports ENOENT for a leaf below a non-directory too.
    if (!(await fsp.lstat(locks)).isDirectory()) {
      throw new Error("factory loop locks path is not a directory")
    }
    const stat = await fsp.lstat(path.join(locks, LOOP_LOCK_NAME))
    return now - stat.mtimeMs < KICK_LOCK_AGE_MS
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  }
}

/**
 * `kickLoop(env, { now, spawn, execPath, readStatusImpl, continuation }) -> { kicked, reason }`: starts the loop launcher detached, with ignored
 * stdio and this process's environment, when `evaluationKickDue` says so, and returns at once. A launcher that cannot be started is
 * `spawn_failed`; nothing retries it. `continuation` (true) is the one kick a triage-only worker owes its deferred evaluation. `spawn` and
 * `execPath` are seams for tests.
 */
export async function kickLoop(env, { now = Date.now(), spawn = nodeSpawn, execPath = process.execPath, readStatusImpl = readStatus, continuation = false } = {}) {
  const { due, reason } = await evaluationKickDue(env, { now, readStatusImpl, continuation })
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
