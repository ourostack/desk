// The loop worker: one detached run of the improvement cycle, started by the session-start hook (hooks/loop-start.cjs)
// through `factory.js loop`. It runs the steps in order (the list `STEPS` below is data, so a step added later is
// one more entry), one at a time and each inside its own try, so one failing step never stops the next. A step that
// is not due (`dueStep`, inside its minimum gap with no newer work for it) is skipped and leaves no record. Besides the
// session-start hook, the end of a turn and a finalize run start the worker when the evaluator step is due (`evaluate-kick.js`).
//
// Safe and detached:
//   - One worker at a time per machine, under one lock file in the factory state folder (`process-lock.js`: the
//     worker's process id, start time, a random token and the child ids it started, which `onChild` and
//     `onChildExit` of the evaluator step keep). A second worker answers `busy`. A lock is taken over only when
//     its recorded process is not alive or it is older than 6 hours. Nothing is ever matched by name or signalled.
//   - A fixed time budget: no step starts after `LOOP_BUDGET_MS` (20 minutes); the evaluator step gets a deadline
//     that leaves `LATER_STEPS_RESERVE_MS` for the later steps; and the process ends itself at the budget plus
//     `CEILING_GRACE_MS` if a step hangs.
//   - A headless factory session (`DESK_FACTORY_HEADLESS`) starts nothing and writes nothing. `DESK_FACTORY_LOOP`
//     set to anything but 1, true, on or yes turns the loop off (`disabled`). No state folder, no consenting store
//     and no desk root each start nothing. Every outcome but a headless session or a missing state folder is recorded
//     (`loop-worker-state.js`) so the session-start line and the health record can say what the loop last did.
//
// The result holds codes and integers only: `{ result, ran, skipped, failed, steps: { <step>: <code> } }`, where
// `result` is `completed`, `budget_spent`, `status_unavailable`, `status_reset` (the status file was damaged and moved aside during this run: nothing more runs, and that UTC day is a spent day for the evaluator), `busy`, `headless_session`, `disabled`,
// `no_factory_state`, `no_consenting_store` or `no_desk`, and a step's code is its own result code, `skipped`
// (not due), `not_started` (the budget was spent, or the status unreadable or reset), `step_error` (it threw) or
// `invalid_result`. The `route` step is the two route collectors as one: `routed`, `issues_failed`, `local_failed`
// or `both_failed`. Every other step records itself; the worker records `route`, and records `step_error` for a
// step that threw. The measure step runs last and is told which steps ran.

import { createRequire } from "node:module"
import * as path from "node:path"

import { checkPersonPrefix } from "./binding.js"
import { hasContributingStore } from "./boot-check.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { runMeasureStep } from "./loop-health.js"
import { dueStep, recordStep } from "./loop-status.js"
import { runMirrorStep } from "./mirror-step.js"
import { listStatusAside, recordWorker } from "./loop-worker-state.js"
import { factoryStateRoot, readStatus, updateStatus } from "./outbox.js"
import { processAlive, releaseLock, takeLock, trackChild } from "./process-lock.js"
import { runReconcileStep } from "./reconcile-step.js"
import { runRouteIssuesStep } from "./route-issues.js"
import { runRouteLocalStep } from "./route-local.js"
import { runEvaluatorStep } from "./evaluator-step.js"
import { LOOP_LOCK_NAME, newestRequestAt } from "./evaluate-kick.js"
import { runVerifyStep } from "./improvement-verify.js"

const { isLoopEnabled } = createRequire(import.meta.url)("./loop-switch.cjs")

export const LOOP_BUDGET_MS = 20 * 60 * 1000
// What the evaluator step leaves for the steps after it: it starts no run that could end later than this before the budget.
export const LATER_STEPS_RESERVE_MS = 3 * 60 * 1000
// The process ends itself this long after the budget if a step is still running.
const CEILING_GRACE_MS = 60 * 1000
const LOCK_NAME = LOOP_LOCK_NAME
const CODE = /^[a-z0-9][a-z0-9_:-]{0,63}$/u

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const answer = (result, extra = {}) => ({ result, ran: 0, skipped: 0, failed: 0, steps: {}, ...extra })

// A step's answer, or null when it is not `{ ok: boolean, result: <code> }`.
const readAnswer = (value) => (isObject(value) && typeof value.ok === "boolean" && typeof value.result === "string" && CODE.test(value.result) ? { ok: value.ok, result: value.result } : null)

const swallow = async (fn) => {
  try {
    return await fn()
  } catch {
    return undefined
  }
}

// The two route collectors count as one step, recorded once by the worker.
async function routeStep(env, ctx, impls) {
  const half = async (fn) => readAnswer(await swallow(() => fn(env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: ctx.now }))) ?? { ok: false, result: "step_error" }
  const issues = await half(impls.routeIssues)
  const local = await half(impls.routeLocal)
  if (issues.result === "headless_session" || local.result === "headless_session") return { ok: false, result: "headless_session" }
  const result = issues.ok && local.ok ? "routed" : !issues.ok && !local.ok ? "both_failed" : !issues.ok ? "issues_failed" : "local_failed"
  const outcome = { ok: result === "routed", result }
  await swallow(() => recordStep(env, "route", { ...outcome, now: ctx.now }))
  return outcome
}

// The ordered steps. Each `run(env, ctx, impls)` answers `{ ok, result }`; a step that records itself needs nothing more. A step with
// `newWorkAt(env)` is due as soon as work newer than its last run arrives (`dueStep`): an evaluation request makes the evaluator step due at once.
const STEPS = Object.freeze([
  { name: "evaluate", newWorkAt: newestRequestAt, run: (env, ctx, impls) => impls.evaluate(env, { pluginVersion: ctx.pluginVersion, now: ctx.now, deadline: ctx.evaluatorDeadline, deskRoot: ctx.deskRoot, onChild: ctx.onChild, onChildExit: ctx.onChildExit }) },
  { name: "route", run: routeStep },
  { name: "mirror", run: (env, ctx, impls) => impls.mirror(env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: ctx.now }) },
  { name: "reconcile", run: (env, ctx, impls) => impls.reconcile(env, { now: ctx.now, desks: [ctx.deskRoot], personPrefix: ctx.personPrefix }) },
  { name: "verify", run: (env, ctx, impls) => impls.verify(env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: ctx.now }) },
  { name: "measure", run: (env, ctx, impls) => impls.measure(env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: ctx.now, attempted: [...ctx.attempted] }) },
])

export const LOOP_STEP_NAMES = Object.freeze(STEPS.map(({ name }) => name))

const DEFAULT_IMPLS = { evaluate: runEvaluatorStep, routeIssues: runRouteIssuesStep, routeLocal: runRouteLocalStep, mirror: runMirrorStep, reconcile: runReconcileStep, verify: runVerifyStep, measure: runMeasureStep }

/**
 * `runLoopWorker(env, { deskRoot, personPrefix, pluginVersion, clock, alive, budgetMs, ceilingMs, exit, readStatusImpl, impls }) -> result`
 * (see the header). `clock` (milliseconds), `alive`, `exit`, `readStatusImpl` and `impls` (the step functions) are seams for tests.
 * Throws a `TypeError` for a `deskRoot` that is neither null nor absolute or a `personPrefix` that is not `""` or `desks/<alias>`.
 */
export async function runLoopWorker(env, {
  deskRoot, personPrefix = "", pluginVersion, clock = Date.now, alive = processAlive, budgetMs = LOOP_BUDGET_MS,
  ceilingMs = budgetMs + CEILING_GRACE_MS, exit = process.exit, readStatusImpl = readStatus, updateStatusImpl = updateStatus, impls = {},
}) {
  if (deskRoot !== null && !path.isAbsolute(deskRoot)) throw new TypeError("deskRoot: must be an absolute path")
  checkPersonPrefix(personPrefix, "runLoopWorker")
  if (isHeadlessFactorySession(env)) return answer("headless_session")
  const root = await factoryStateRoot(env, { create: false })
  // Every run's outcome is recorded where the health record and the session-start line can read it; nothing when there is no state folder.
  const ended = async (outcome) => {
    if (root !== null) await recordWorker(env, root, outcome.result, new Date(clock()).toISOString(), updateStatusImpl)
    return outcome
  }
  if (!isLoopEnabled(env)) return ended(answer("disabled"))
  if (deskRoot === null) return ended(answer("no_desk"))
  if (root === null) return answer("no_factory_state")
  if (!hasContributingStore(env)) return ended(answer("no_consenting_store"))
  const lock = await takeLock(root, { name: LOCK_NAME, alive, clock, record: { children: [] } })
  if (lock === null) return ended(answer("busy"))

  const ceiling = setTimeout(() => exit(0), ceilingMs)
  ceiling.unref()
  const functions = { ...DEFAULT_IMPLS, ...impls }
  const started = clock()
  // Child ids go into the lock file one write at a time, in the order they were reported.
  let pending = Promise.resolve()
  const track = (pid, on) => { pending = pending.then(() => trackChild(lock, pid, on)) }
  const ctx = {
    deskRoot, personPrefix, pluginVersion, attempted: [],
    evaluatorDeadline: new Date(started + budgetMs - LATER_STEPS_RESERVE_MS),
    onChild: (pid) => track(pid, true),
    onChildExit: (pid) => track(pid, false),
  }
  const outcome = answer("completed")
  // A status file that the reader moves aside and reads as empty must not look like a machine that never ran: it would restart the evaluator's daily cap.
  const known = new Set(listStatusAside(root))
  try {
    let stopped = null
    for (const step of STEPS) {
      if (stopped === null && clock() >= started + budgetMs) stopped = "budget_spent"
      let status
      if (stopped === null) {
        try {
          status = await readStatusImpl(env)
          if (listStatusAside(root).some((name) => !known.has(name))) stopped = "status_reset"
        } catch {
          stopped = "status_unavailable"
        }
      }
      // New work that cannot be read makes nothing due early; the gap still applies.
      const newWorkAt = stopped === null && step.newWorkAt !== undefined ? ((await swallow(() => step.newWorkAt(env))) ?? null) : null
      if (stopped === null && !dueStep(status, step.name, new Date(clock()), { newWorkAt })) {
        outcome.steps[step.name] = "skipped"
        outcome.skipped += 1
        continue
      }
      if (stopped !== null) {
        outcome.steps[step.name] = "not_started"
        continue
      }
      ctx.now = new Date(clock())
      let result
      try {
        result = await step.run(env, ctx, functions)
      } catch {
        result = { ok: false, result: "step_error" }
        await swallow(() => recordStep(env, step.name, { ok: false, result: "step_error", now: ctx.now }))
      }
      const read = readAnswer(result) ?? { ok: false, result: "invalid_result" }
      ctx.attempted.push(step.name)
      outcome.ran += 1
      if (!read.ok) outcome.failed += 1
      outcome.steps[step.name] = read.result
    }
    if (stopped !== null) outcome.result = stopped
    await ended(outcome)
  } finally {
    clearTimeout(ceiling)
    await pending
    await releaseLock(lock)
  }
  return outcome
}
