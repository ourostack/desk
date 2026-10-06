// The evaluator step: the loop worker's way to label finished jobs without a person. It sweeps the retained
// evaluation requests (`evaluatePending`), runs the headless runner (`headless.js`, the only way a run ever
// starts) on each ready job within the daily cap, checks the answer through the existing gate
// (`acceptEvaluations`) and records what happened under `status.evaluator`.
//
// Rules, in order of importance:
//
//   - The factory never spends money by itself. A machine-level blocked state from the runner (`no_agent_cli`,
//     `no_credentials`, `disabled_would_bill`, `sign_in_unknown`), a spent daily cap and the switch
//     `DESK_FACTORY_HEADLESS_EVALUATOR` set to anything but 1, true, on or yes each stop the loop over jobs, keep every request waiting and are
//     recorded as `evaluator.headless.state`. The sign-in is probed once per step and the result is handed to
//     every run.
//   - A headless session never starts another: with `DESK_FACTORY_HEADLESS` set (not empty, not `0`) the step
//     returns `headless_session` before it starts anything, not even the probe, and writes no state.
//   - A job the runner cannot evaluate (a host it does not support) is skipped and counted as an
//     `unsupported_host` job; it does not stop the jobs that can run. Of a job's briefs only those of a
//     supported host are handed to the runner; the rest keep waiting.
//   - No run starts that could not finish before the caller's `deadline` (required) or before 25 minutes after the
//     step took its lock, whichever is first; the jobs left wait for the next worker. A run is counted (day count
//     and attempt, saved) before it starts and taken back only if the runner reports that none started. Stored
//     bookkeeping that is damaged fails closed (a damaged day count is a spent day, a damaged attempt entry a job
//     at its limit) and the clock never moves the day backwards; the day is re-read before each run. `onChild` and `onChildExit` go to the runner and the probe unchanged. This step signals nothing.
//   - A step that did not run never looks like one that found nothing: the result codes `no_jobs_waiting`,
//     `none_could_run` and the blocked states differ, `waiting` counts the jobs left, and cost is `null` unless
//     a run reported a number (`cost_unreported_runs` says how many of the day's runs reported none).
//
// `status.evaluator` (codes, counts and the cost number only; read by the measure step and the boot line):
//
//   { expired_total, gave_up, waiting,
//     headless: { state, day, jobs, accepted, rejected, cost_usd, cost_unreported_runs,
//                 unsupported_jobs, deferred_jobs, blocked_days } }
//
//   expired_total  requests moved to `evaluate-requests/expired/`, ever (each counted once)
//   gave_up        waiting jobs that were attempted 3 times without an accepted answer
//   waiting        ready jobs left after this step
//   state          `idle` | `ran` | a blocked state | `unsupported_host` (jobs waiting, every one unsupported)
//                  | `budget_exhausted` | `disabled`; with `idle`, `waiting` above 0 means nothing could run now
//   day            the UTC day the counts below belong to; they start again each UTC day
//   jobs, accepted, rejected   jobs run today, and how many got an accepted or a rejected answer
//   cost_usd       the sum of the costs the day's runs reported, or `null`
//   unsupported_jobs, deferred_jobs   this step's skipped jobs: unsupported host, and left for a later step
//                  (already attempted today, past the deadline, or after a stop)
//   blocked_days   consecutive days the step has seen a machine-level blocked state (`no_agent_cli`,
//                  `no_credentials`, `disabled_would_bill`, `sign_in_unknown`, `disabled`, `budget_exhausted`)
//
// Per-job bookkeeping keyed by job ID is kept apart, in `status.loop.evaluate.attempts`
// (`{ <job>: { attempts, last_day } }`, with `blocked_last_day`): it holds only jobs whose request still waits
// and is pruned at every save, so it is bounded by the number of waiting requests and never reaches a health
// record.

import { promises as fsp } from "node:fs"
import * as path from "node:path"

import { acceptEvaluations, evaluatePending } from "./evaluate-run.js"
import {
  HEADLESS_TIMEOUT_MS,
  MAX_HEADLESS_JOBS_PER_DAY,
  billingVariableBlocks,
  findAgentCli,
  hostSupported,
  probeSignIn,
  runHeadless,
} from "./headless.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { recordStep } from "./loop-status.js"
import { factoryStateRoot, readStatus, updateStatus } from "./outbox.js"
import { statusResetDay } from "./loop-worker-state.js"
import { processAlive, releaseLock, takeLock } from "./process-lock.js"

const MAX_ATTEMPTS = 3
// The step starts no run that could end after this long since it took the lock, so a live step never outlasts
// the age of a guard left behind.
const STEP_LIMIT_MS = 25 * 60 * 1000
const SWITCH_ON = new Set(["1", "true", "on", "yes"])
const LOCK_FILE = "evaluator-step.running"
const COST_ROUNDING = 1e6

// The runner's machine-level blocked states: the step stops, and the step itself did not do its work.
const MACHINE_BLOCKED = new Set(["no_agent_cli", "no_credentials", "disabled_would_bill", "sign_in_unknown"])
// Every state that counts toward `blocked_days`.
const BLOCKED_DAY_STATES = new Set([...MACHINE_BLOCKED, "disabled", "budget_exhausted"])

const DEFAULT_SEAMS = { runHeadless, probeSignIn, findAgentCli, processAlive, clock: Date.now }
const BRIEF_NAME = /^(claude-code|copilot-cli|codex-cli)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.brief\.json$/u
const DAY_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const count = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0)
const costOrNull = (value) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null)

function toMs(value, name) {
  const ms = value === null ? Number.NaN : new Date(value).getTime()
  if (Number.isNaN(ms)) throw new TypeError(`${name}: must be a valid time`)
  return ms
}

// The job's briefs of a supported host (paths and session IDs), by the brief's file name.
function supportedBriefs(paths) {
  const mine = paths.map((file) => ({ file, match: BRIEF_NAME.exec(path.basename(file)) })).filter(({ match }) => match !== null && hostSupported(match[1]))
  return { paths: mine.map(({ file }) => file), sessions: new Set(mine.map(({ match }) => match[2])), host: mine[0]?.match[1] ?? null }
}

// The folders of the session logs the briefs name; a missing log names none.
async function logFolders(paths) {
  const folders = new Set()
  for (const file of paths) {
    // The brief was written by this step's own sweep: `session_log` is an absolute path or `null`.
    const log = JSON.parse(await fsp.readFile(file, "utf8")).session_log
    if (log !== null) folders.add(path.dirname(log))
  }
  return [...folders]
}

// Only an absent record means zero attempts: a record that is present but damaged is a job at its limit, and
// an attempt dated today, later than today or unreadable keeps the job from running today.
function readAttempts(status, retained, day) {
  const stored = status.loop?.evaluate?.attempts
  const attempts = {}
  for (const job of retained) {
    const entry = isObject(stored) ? stored[job] : stored
    if (entry === undefined) continue
    const valid = isObject(entry) && Number.isSafeInteger(entry.attempts) && entry.attempts >= 0
    attempts[job] = valid ? { attempts: entry.attempts, last_day: DAY_TEXT.test(entry.last_day) ? entry.last_day : day } : { attempts: MAX_ATTEMPTS, last_day: day }
  }
  return attempts
}

// The day's counts from the stored record. Only an absent record, or a stored day before `clockDay`, starts the
// day at zero. A day later than `clockDay` stands (the clock never moves the budget backwards), and a record
// that is present but damaged means the day is spent.
function readDay(evaluator, clockDay) {
  const stored = isObject(evaluator) ? evaluator.headless : evaluator
  if (stored === undefined) return { day: clockDay, jobs: 0 }
  if (!isObject(stored) || !DAY_TEXT.test(stored.day)) return { day: clockDay, jobs: MAX_HEADLESS_JOBS_PER_DAY }
  if (stored.day < clockDay) return { day: clockDay, jobs: 0 }
  if (!Number.isSafeInteger(stored.jobs) || stored.jobs < 0) return { day: stored.day, jobs: MAX_HEADLESS_JOBS_PER_DAY }
  return { day: stored.day, jobs: stored.jobs, accepted: count(stored.accepted), rejected: count(stored.rejected), cost_usd: costOrNull(stored.cost_usd), cost_unreported_runs: count(stored.cost_unreported_runs) }
}

/**
 * `runEvaluatorStep(env, { pluginVersion, now, deadline, onChild, onChildExit, ...seams }) -> { ok, result }`.
 * `now` is a time (default: the real clock) and `deadline` a time and required (the step also stops starting
 * runs 25 minutes after it took its lock, whatever the deadline says); a violated contract throws a `TypeError`. Seams for tests: `runHeadless`, `probeSignIn`, `findAgentCli`, `clock` (milliseconds).
 * `result` is one of `ran`, `no_jobs_waiting`, `none_could_run`, `unsupported_host`, `busy`, `no_factory_state`,
 * `headless_session`, `step_error` or a blocked state (see the header); only `busy`, `no_factory_state` and
 * `headless_session` record nothing.
 */
export async function runEvaluatorStep(env, options = {}) {
  const impl = { ...DEFAULT_SEAMS, ...options }
  const { pluginVersion, onChild, onChildExit } = impl
  if (typeof pluginVersion !== "string" || pluginVersion === "") throw new TypeError("pluginVersion: must be a Desk version")
  const nowMs = toMs(impl.now === undefined ? new Date() : impl.now, "now")
  const deadlineMs = toMs(impl.deadline ?? null, "deadline")
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session" }
  const root = await factoryStateRoot(env, { create: false })
  if (root === null) return { ok: true, result: "no_factory_state" }
  const lock = await takeLock(root, { name: LOCK_FILE, alive: impl.processAlive })
  if (lock === null) return { ok: true, result: "busy" }
  const limitMs = Math.min(deadlineMs, impl.clock() + STEP_LIMIT_MS)
  let outcome
  try {
    outcome = await execute(env, { impl, root, nowMs, limitMs, pluginVersion, onChild, onChildExit })
  } catch {
    outcome = { ok: false, result: "step_error" }
  }
  await releaseLock(lock)
  if (outcome.result === "step_error") await recordStep(env, "evaluate", { ok: false, result: "step_error", now: nowMs })
  return outcome
}

const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)

async function execute(env, { impl, root, nowMs, limitMs, pluginVersion, onChild, onChildExit }) {
  const clockStart = impl.clock()
  const sweep = await evaluatePending(env, { pluginVersion, now: nowMs })
  const ready = sweep.jobs.filter((entry) => entry.result === "ready")
  const live = new Set(sweep.jobs.filter((entry) => entry.result === "ready" || entry.result === "no_sessions").map((entry) => entry.job))

  const status = await readStatus(env)
  const prior = isObject(status.evaluator) ? status.evaluator : {}
  const before = readDay(status.evaluator, dayOf(nowMs))
  const ledger = {
    expired_total: count(prior.expired_total) + sweep.jobs.filter((entry) => entry.result === "expired").length,
    day: before.day,
    jobs: before.jobs,
    accepted: before.accepted ?? 0,
    rejected: before.rejected ?? 0,
    cost_usd: before.cost_usd ?? null,
    cost_unreported_runs: before.cost_unreported_runs ?? 0,
    blocked_days: count(prior.headless?.blocked_days),
    blocked_last_day: typeof status.loop?.evaluate?.blocked_last_day === "string" ? status.loop.evaluate.blocked_last_day : null,
    attempts: readAttempts(status, live, before.day),
    state: "ran",
    unsupported: 0,
    deferred: 0,
  }
  let stillWaiting = ready.length

  async function save() {
    for (const job of Object.keys(ledger.attempts)) if (!live.has(job)) delete ledger.attempts[job]
    const gaveUp = Object.values(ledger.attempts).filter((entry) => entry.attempts >= MAX_ATTEMPTS).length
    await updateStatus(env, (current) => ({
      ...current,
      evaluator: {
        expired_total: ledger.expired_total,
        gave_up: gaveUp,
        waiting: stillWaiting,
        headless: {
          state: ledger.state,
          day: ledger.day,
          jobs: ledger.jobs,
          accepted: ledger.accepted,
          rejected: ledger.rejected,
          cost_usd: ledger.cost_usd,
          cost_unreported_runs: ledger.cost_unreported_runs,
          unsupported_jobs: ledger.unsupported,
          deferred_jobs: ledger.deferred,
          blocked_days: ledger.blocked_days,
        },
      },
      loop: { ...(isObject(current.loop) ? current.loop : {}), evaluate: { attempts: ledger.attempts, blocked_last_day: ledger.blocked_last_day } },
    }))
  }

  // Anything set that is not a clear "on" (1, true, on, yes; padded or in capitals) turns the evaluator off.
  const switchValue = env.DESK_FACTORY_HEADLESS_EVALUATOR
  let stop = switchValue === undefined || SWITCH_ON.has(switchValue.trim().toLowerCase()) ? null : "disabled"
  // A UTC day on which the status file was damaged and set aside is a spent day: its day count was lost, and failing open costs money.
  if (stop === null && statusResetDay(root) === dayOf(nowMs)) stop = "budget_exhausted"
  let ranJobs = 0
  let probed = false
  let cli = null
  let signIn
  let workDir = null
  for (const entry of ready) {
    // The day is read from the clock before each run; a new day starts its count at zero, and never an earlier one.
    const clockDay = dayOf(nowMs + (impl.clock() - clockStart))
    if (clockDay > ledger.day) Object.assign(ledger, { day: clockDay, jobs: 0, accepted: 0, rejected: 0, cost_usd: null, cost_unreported_runs: 0 })
    const attempt = ledger.attempts[entry.job] ?? { attempts: 0, last_day: null }
    if (attempt.attempts >= MAX_ATTEMPTS) continue
    if (attempt.last_day >= ledger.day) {
      ledger.deferred += 1
      continue
    }
    const plan = supportedBriefs(entry.briefs)
    if (plan.paths.length === 0) {
      ledger.unsupported += 1
      continue
    }
    if (stop === null && ledger.jobs >= MAX_HEADLESS_JOBS_PER_DAY) stop = "budget_exhausted"
    if (stop !== null || impl.clock() + HEADLESS_TIMEOUT_MS > limitMs) {
      ledger.deferred += 1
      continue
    }
    if (!probed) {
      probed = true
      cli = impl.findAgentCli({ env })
      signIn = cli !== null && !billingVariableBlocks(env) ? await impl.probeSignIn({ cli, env, onChild, onChildExit }) : undefined
      workDir = path.join(root, "scratch", "evaluator")
      await fsp.mkdir(workDir, { recursive: true, mode: 0o700 })
    }
    // The probe and the folder work took time: check the limit again right before the run.
    if (impl.clock() + HEADLESS_TIMEOUT_MS > limitMs) {
      ledger.deferred += 1
      continue
    }
    // The run is counted as started before it starts, so a throw or a killed worker never leaves an uncounted run.
    const priorAttempt = ledger.attempts[entry.job]
    ledger.jobs += 1
    ledger.attempts[entry.job] = { attempts: attempt.attempts + 1, last_day: ledger.day }
    await save()
    const run = await impl.runHeadless({
      env,
      job: { job: entry.job, host: plan.host },
      briefPaths: plan.paths,
      evaluationDir: path.dirname(path.dirname(plan.paths[0])),
      logDirs: await logFolders(plan.paths),
      workDir,
      cli,
      signIn,
      onChild,
      onChildExit,
    })
    if (run.state === "headless_session" || run.state === "unsupported_host" || MACHINE_BLOCKED.has(run.state)) {
      // No run started: take the count back.
      ledger.jobs -= 1
      if (priorAttempt === undefined) delete ledger.attempts[entry.job]
      else ledger.attempts[entry.job] = priorAttempt
      await save()
      if (run.state === "headless_session") return { ok: false, result: "headless_session" }
      if (run.state === "unsupported_host") ledger.unsupported += 1
      else {
        stop = run.state
        ledger.deferred += 1
      }
      continue
    }
    // Every other answer is an attempt: the run happened, whatever came of it.
    ranJobs += 1
    const cost = costOrNull(run.cost_usd)
    if (cost === null) ledger.cost_unreported_runs += 1
    else ledger.cost_usd = Math.round(((ledger.cost_usd ?? 0) + cost) * COST_ROUNDING) / COST_ROUNDING
    await save()
    const accepted = await acceptEvaluations(env, { job: entry.job, pluginVersion })
    const mine = accepted.sessions.filter((session) => plan.sessions.has(session.session))
    if (mine.length > 0 && mine.every((session) => session.result === "accepted")) ledger.accepted += 1
    else ledger.rejected += 1
    if (accepted.request === "cleared") {
      stillWaiting -= 1
      live.delete(entry.job)
    }
    await save()
  }

  const unsupportedOnly = ranJobs === 0 && ledger.unsupported > 0
  ledger.state = stop ?? (ranJobs > 0 ? "ran" : unsupportedOnly ? "unsupported_host" : "idle")
  const result = stop ?? (ranJobs > 0 ? "ran" : ready.length === 0 ? "no_jobs_waiting" : unsupportedOnly ? "unsupported_host" : "none_could_run")
  if (BLOCKED_DAY_STATES.has(ledger.state)) {
    if (ledger.blocked_last_day !== ledger.day) ledger.blocked_days += 1
    ledger.blocked_last_day = ledger.day
  } else {
    ledger.blocked_days = 0
    ledger.blocked_last_day = null
  }
  await save()
  const ok = !MACHINE_BLOCKED.has(result)
  await recordStep(env, "evaluate", { ok, result, now: nowMs })
  return { ok, result }
}
