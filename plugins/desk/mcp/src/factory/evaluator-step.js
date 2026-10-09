// The evaluator step: the loop worker's way to label finished jobs without a person. It first asks for every
// finished job that needs labels and has no request (`requestFinishedJobs`, the backstop for a request the done
// step never recorded or that was settled while it could not be labeled), then sweeps the retained
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
//     step took its lock, whichever is first; the jobs left wait for the next worker. The facts scan comes first and
//     its time grows with history, so a caller that can move its own later limits passes `extendDeadline(scanMs)`:
//     the step asks it for the scan's time once the scan ends and moves both limits by what it grants (at most the
//     scan's time), so a slow scan never leaves less than a run's time on its own. Without it, nothing moves.
//     Jobs left only because no run fits are recorded as `deferred_reason: "no_time_for_a_run"`, and a step that
//     ran nothing for that reason answers `no_time_for_a_run` with `ok: false`, never a clean `none_could_run`. A run is counted (day count
//     and attempt, saved) before it starts and taken back only if the runner reports that none started. Stored
//     bookkeeping that is damaged fails closed (a damaged day count is a spent day, a damaged attempt entry a job
//     at its limit) and the clock never moves the day backwards; the day is re-read before each run. `onChild` and `onChildExit` go to the runner and the probe unchanged. This step signals nothing.
//   - Jobs with a session that has no labels at all run first, oldest finish first; relabels (an older rubric, or
//     facts derived again with other evidence) come after them, so a relabel pass never holds up a fresh finish.
//   - A job runs at most once a UTC day and at most 3 times without an accepted answer; an accepted run starts its
//     count again, so a session that runs on and is labeled again as its facts change never gives up.
//   - A step that did not run never looks like one that found nothing: the result codes `no_jobs_waiting`,
//     `none_could_run`, `no_time_for_a_run` and the blocked states differ, `waiting` counts the jobs left, and cost is `null` unless
//     a run reported a number (`cost_unreported_runs` says how many of the day's runs reported none).
//
// `status.evaluator` (codes, counts and the cost number only; read by the measure step and the boot line):
//
//   { expired_total, gave_up, waiting, ready_now, ready_later, accepted_last_step, scan_ms,
//     headless: { state, day, jobs, accepted, rejected, cost_usd, cost_unreported_runs,
//                 unsupported_jobs, deferred_jobs, deferred_reason, blocked_days },
//     lag: { at, unlabeled_jobs, oldest_finished_at, unsupported_jobs, gave_up_jobs } }
//
//   expired_total  requests moved to `evaluate-requests/expired/`, ever (each counted once)
//   gave_up        waiting jobs that were attempted 3 times without an accepted answer
//   waiting        ready jobs left after this step
//   ready_now, ready_later   of those, the jobs the runner can still run (a supported brief, attempts to spare) that
//                  were not attempted today, and that were: what the loop kick reads to drain the queue
//   accepted_last_step   jobs whose every run brief this step ran was accepted; only a step above 0 drains the queue
//                  on (a run that timed out, spent its budget, failed or was rejected labels nothing)
//   scan_ms        how long this step's backstop and sweep took to read the facts, in milliseconds
//   state          `idle` | `ran` | a blocked state | `unsupported_host` (jobs waiting, every one unsupported)
//                  | `budget_exhausted` | `disabled` | `no_time_for_a_run` (jobs a run could take were waiting, and none
//                  started because no run would have finished in time); with `idle`, `waiting` above 0 means
//                  nothing could run now by rule (each job already tried today, or at its attempt limit)
//   day            the UTC day the counts below belong to; they start again each UTC day
//   jobs, accepted, rejected   jobs run today, and how many got an accepted or a rejected answer
//   cost_usd       the sum of the costs the day's runs reported, or `null`
//   unsupported_jobs, deferred_jobs   this step's skipped jobs: unsupported host, and left for a later step
//                  (already attempted today, past the deadline, or after a stop)
//   deferred_reason   `no_time_for_a_run` when at least one job was left only because no run would have finished
//                  before the step's limit, else `null`
//   blocked_days   consecutive days the step has seen a machine-level blocked state (`no_agent_cli`,
//                  `no_credentials`, `disabled_would_bill`, `sign_in_unknown`, `disabled`, `budget_exhausted`)
//   lag            the label lag as this step left it: `at` (when it was read), `unlabeled_jobs` (finished
//                  jobs with a session that has no labels yet and that the runner can label, not at the attempt
//                  limit), `unsupported_jobs` and `gave_up_jobs` (the job IDs left out of the lag: an unlabeled
//                  session on a host the runner does not support, and the attempt limit reached), and `oldest_finished_at` (the oldest
//                  such job's finish time, `null` when there is none). The measure step turns it into the age
//                  the health record, the session-start line and the `label_lag` alarm read.
//
// Per-job bookkeeping keyed by job ID is kept apart, in `status.loop.evaluate.attempts`
// (`{ <job>: { attempts, last_day } }`, with `blocked_last_day`): it holds jobs whose request still waits and jobs
// run today whose request has cleared (so a relabel asked for later the same day waits for the next day), and is
// pruned at every save, so it is bounded by the waiting requests plus the day's runs and never reaches a health
// record.

import { promises as fsp } from "node:fs"
import * as path from "node:path"

import { acceptEvaluations, evaluatePending, requestFinishedJobs } from "./evaluate-run.js"
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
// The step starts no run that could end after this long since it took the lock, plus the facts scan its caller
// granted (`extendDeadline`; the loop worker grants at most 5 hours), so a live step stays well inside the lock's
// 6-hour outer age.
const STEP_LIMIT_MS = 25 * 60 * 1000
const SWITCH_ON = new Set(["1", "true", "on", "yes"])
const LOCK_FILE = "evaluator-step.running"
const COST_ROUNDING = 1e6

// The runner's machine-level blocked states: the step stops, and the step itself did not do its work.
const MACHINE_BLOCKED = new Set(["no_agent_cli", "no_credentials", "disabled_would_bill", "sign_in_unknown"])
// Every state that counts toward `blocked_days`.
const BLOCKED_DAY_STATES = new Set([...MACHINE_BLOCKED, "disabled", "budget_exhausted"])

const DEFAULT_SEAMS = { runHeadless, probeSignIn, findAgentCli, processAlive, requestFinishedJobs, clock: Date.now }
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
  // A job run today whose request has since cleared keeps its day, so a relabel asked for later the same day still waits for tomorrow.
  if (isObject(stored)) {
    for (const [job, entry] of Object.entries(stored)) {
      if (!Object.hasOwn(attempts, job) && isObject(entry) && entry.last_day === day && Number.isSafeInteger(entry.attempts) && entry.attempts >= 0) attempts[job] = { attempts: entry.attempts, last_day: day }
    }
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
 * `runEvaluatorStep(env, { pluginVersion, now, deadline, deskRoot, onChild, onChildExit, ...seams }) -> { ok, result }`.
 * `deskRoot` (absolute, or null) is the desk the backstop names on a request whose session marker names none.
 * `now` is a time (default: the real clock) and `deadline` a time and required (the step also stops starting
 * runs 25 minutes after it took its lock, whatever the deadline says); a violated contract throws a `TypeError`.
 * `extendDeadline(scanMs) -> grantedMs` (optional, may be async) leaves the facts scan out of both limits, up to what it grants. Seams for tests: `runHeadless`, `probeSignIn`, `findAgentCli`, `requestFinishedJobs`, `clock` (milliseconds).
 * `result` is one of `ran`, `no_jobs_waiting`, `none_could_run`, `no_time_for_a_run`, `unsupported_host`, `busy`, `no_factory_state`,
 * `headless_session`, `step_error` or a blocked state (see the header); only `busy`, `no_factory_state` and
 * `headless_session` record nothing.
 */
export async function runEvaluatorStep(env, options = {}) {
  const impl = { ...DEFAULT_SEAMS, ...options }
  const { pluginVersion, onChild, onChildExit } = impl
  if (typeof pluginVersion !== "string" || pluginVersion === "") throw new TypeError("pluginVersion: must be a Desk version")
  const nowMs = toMs(impl.now === undefined ? new Date() : impl.now, "now")
  const deadlineMs = toMs(impl.deadline ?? null, "deadline")
  if (impl.deskRoot !== undefined && impl.deskRoot !== null && (typeof impl.deskRoot !== "string" || !path.isAbsolute(impl.deskRoot))) throw new TypeError("deskRoot: must be an absolute path or null")
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

// Fresh finishes first (a session with no labels at all), then relabels; within each, the oldest finish first.
const byPriority = (left, right) => Number(right.unlabeled > 0) - Number(left.unlabeled > 0) || Date.parse(left.finished_at) - Date.parse(right.finished_at)

// A caller's grant as whole milliseconds from 0 to `scanMs`; anything that is not a number grants nothing.
const grantOf = (value, scanMs) => (typeof value === "number" && !Number.isNaN(value) ? Math.min(scanMs, Math.max(0, Math.floor(value))) : 0)

async function execute(env, { impl, root, nowMs, limitMs, pluginVersion, onChild, onChildExit }) {
  const clockStart = impl.clock()
  // The backstop never stops the step: a job it cannot ask for now is asked for at the next step.
  try {
    await impl.requestFinishedJobs(env, { deskRoot: impl.deskRoot ?? null, now: nowMs })
  } catch {
    // Nothing recorded: the requests already waiting are swept as before.
  }
  const sweep = await evaluatePending(env, { pluginVersion, now: nowMs })
  // How long the backstop and the sweep took to read the facts: a run starts only with 15 minutes left before the deadline, so a scan that
  // grows with history shrinks that window, and this number shows it before every step ends with no_time_for_a_run.
  const scanMs = Math.max(0, impl.clock() - clockStart)
  // The caller may leave the scan out of the run window; a grant is read as a whole number from 0 to the scan's own time.
  if (typeof impl.extendDeadline === "function") limitMs += grantOf(await impl.extendDeadline(scanMs), scanMs)
  const ready = sweep.jobs.filter((entry) => entry.result === "ready").sort(byPriority)
  // Finished jobs with a session that has no labels and that the runner can label, and when each finished: the label lag. Jobs with an
  // unlabeled session the runner cannot label (a host it does not support) are named apart and never hold the lag.
  const unlabeled = new Map()
  const unsupportedJobs = new Set()
  for (const entry of ready) {
    const runnable = supportedBriefs(entry.unlabeled_briefs).paths.length
    if (runnable > 0) unlabeled.set(entry.job, Date.parse(entry.finished_at))
    if (runnable < entry.unlabeled_briefs.length) unsupportedJobs.add(entry.job)
  }
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
    acceptedHere: 0,
    deferred: 0,
    deferredForTime: 0,
  }
  let stillWaiting = ready.length

  // A ready job left that the runner could still run: a supported brief not labeled in this step, and attempts to spare.
  const labeledHere = new Set()
  const runnable = (entry) => live.has(entry.job) && !labeledHere.has(entry.job) && supportedBriefs(entry.briefs).paths.length > 0 && (ledger.attempts[entry.job]?.attempts ?? 0) < MAX_ATTEMPTS
  const triedToday = (entry) => (ledger.attempts[entry.job]?.last_day ?? "") >= ledger.day

  async function save() {
    for (const job of Object.keys(ledger.attempts)) if (!live.has(job) && ledger.attempts[job].last_day !== ledger.day) delete ledger.attempts[job]
    const gaveUpJobs = Object.keys(ledger.attempts).filter((job) => live.has(job) && ledger.attempts[job].attempts >= MAX_ATTEMPTS).sort()
    const gaveUp = gaveUpJobs.length
    // The lag counts only jobs this machine can label and is still trying.
    const lagging = [...unlabeled].filter(([job]) => !gaveUpJobs.includes(job)).map(([, at]) => at)
    await updateStatus(env, (current) => ({
      ...current,
      evaluator: {
        expired_total: ledger.expired_total,
        gave_up: gaveUp,
        waiting: stillWaiting,
        ready_now: ready.filter((entry) => runnable(entry) && !triedToday(entry)).length,
        ready_later: ready.filter((entry) => runnable(entry) && triedToday(entry)).length,
        accepted_last_step: ledger.acceptedHere,
        scan_ms: scanMs,
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
          deferred_reason: ledger.deferredForTime > 0 ? "no_time_for_a_run" : null,
          blocked_days: ledger.blocked_days,
        },
        lag: {
          at: new Date(nowMs).toISOString(),
          unlabeled_jobs: lagging.length,
          oldest_finished_at: lagging.length === 0 ? null : new Date(Math.min(...lagging)).toISOString(),
          unsupported_jobs: [...unsupportedJobs].filter((job) => live.has(job)).sort(),
          gave_up_jobs: gaveUpJobs,
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
    if (stop !== null) {
      ledger.deferred += 1
      continue
    }
    if (impl.clock() + HEADLESS_TIMEOUT_MS > limitMs) {
      ledger.deferred += 1
      ledger.deferredForTime += 1
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
      ledger.deferredForTime += 1
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
    const allAccepted = mine.length > 0 && mine.every((session) => session.result === "accepted")
    // An accepted run starts the job's attempts again (it keeps today's date, so the job runs at most once a day): a session that runs on and is
    // labeled again as its facts change never reaches the attempt limit.
    if (allAccepted) {
      ledger.accepted += 1
      ledger.acceptedHere += 1
      ledger.attempts[entry.job] = { attempts: 0, last_day: ledger.day }
    } else ledger.rejected += 1
    // Every brief the runner could take was run and accepted: none of the job's sessions it can label is unlabeled any more.
    if (allAccepted) {
      unlabeled.delete(entry.job)
      labeledHere.add(entry.job)
    }
    if (accepted.request === "cleared") {
      stillWaiting -= 1
      live.delete(entry.job)
    }
    await save()
  }

  const unsupportedOnly = ranJobs === 0 && ledger.unsupported > 0
  // Nothing ran, and a job was left only because no run would have finished in time: the step did not do its work, and says why.
  const noTime = ranJobs === 0 && ledger.deferredForTime > 0
  ledger.state = stop ?? (ranJobs > 0 ? "ran" : noTime ? "no_time_for_a_run" : unsupportedOnly ? "unsupported_host" : "idle")
  const result = stop ?? (ranJobs > 0 ? "ran" : ready.length === 0 ? "no_jobs_waiting" : noTime ? "no_time_for_a_run" : unsupportedOnly ? "unsupported_host" : "none_could_run")
  if (BLOCKED_DAY_STATES.has(ledger.state)) {
    if (ledger.blocked_last_day !== ledger.day) ledger.blocked_days += 1
    ledger.blocked_last_day = ledger.day
  } else {
    ledger.blocked_days = 0
    ledger.blocked_last_day = null
  }
  await save()
  const ok = !MACHINE_BLOCKED.has(result) && result !== "no_time_for_a_run"
  await recordStep(env, "evaluate", { ok, result, now: nowMs })
  return { ok, result }
}
