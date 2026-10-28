import { randomBytes } from "node:crypto"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { deskPluginRoot, deskVersion } from "../package-metadata.js"
import {
  acceptContextCandidate, acceptContextPrivacy, listContextWork,
} from "./context-outbox.js"
import { RECOMMENDATION_SCHEMA, contextShare, contextSource } from "./context-schema.js"
import {
  factoryStateRoot, readConsent, readStatus, readTaskContextFile,
  taskContextPath, updateStatus, updateTaskContextState, writeTaskContextFile,
} from "./outbox.js"
import {
  HEADLESS_TIMEOUT_MS, MAX_HEADLESS_JOBS_PER_DAY, billingVariableBlocks, findAgentCli, probeSignIn, qualifyHeadlessSource, runHeadless,
} from "./headless.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { finishAgentLaunch, reserveAgentLaunch, witnessedEvaluationQuota } from "./headless-ledger.js"
import { dueStep } from "./loop-status.js"
import { EVALUATOR_LOCK_NAME, releaseLock, takeLock, trackChild } from "./process-lock.js"
import { PATTERNS } from "./schema.js"

const MAX_BATCH = 8
const DAY = 24 * 3600 * 1000
const ON = new Set(["1", "true", "on", "yes"])
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const idle = (result, ok = true) => ({ ok, result, launched: false, accepted: 0, refused: 0 })
const sourceVersionMatches = (work, version) => work.source.evaluator.plugin_version === version

function due(work, now) {
  const attempts = work.state.attempts?.[work.phase]
  const last = work.state.last_attempts?.[work.phase]
  return Number.isSafeInteger(attempts) && attempts < 3 &&
    (last === undefined || (typeof last === "string" && isoDay(Date.parse(last)) < isoDay(now)))
}

async function runnableContextWork(env, status, now) {
  const stores = Object.entries((await readConsent(env)).stores).filter(([, value]) => value.contribute === true).map(([store]) => store).sort()
  const jobs = []
  for (const store of stores) {
    const readiness = status.context_publication?.[store]
    const checked = Date.parse(readiness?.checked_at)
    if (readiness?.ready !== true || !Number.isFinite(checked) || checked - now > 300000 || now - checked > 3 * DAY) continue
    for (const work of await listContextWork(env, { store })) if (due(work, now)) jobs.push({ ...work, store })
  }
  return jobs
}

/** Read the actual eligible phases; a successful phase drains immediately, failures keep the ordinary gap. */
export async function contextEvaluationDue(env, status, now) {
  const at = new Date(now).getTime()
  if (isHeadlessFactorySession(env) || billingVariableBlocks(env) ||
      (env.DESK_FACTORY_HEADLESS_EVALUATOR !== undefined && !ON.has(env.DESK_FACTORY_HEADLESS_EVALUATOR.trim().toLowerCase()))) return false
  const record = status?.loop?.steps?.evaluate
  const context = status?.context_evaluation
  const accepted = record?.last_result === "context_ran" && context?.result === "context_ran" &&
    context.accepted > 0 && context.refused === 0 && Date.parse(context.at) >= Date.parse(record.last_ran_at)
  const labeled = record?.last_result === "ran" && status?.evaluator?.accepted_last_step > 0
  if (!accepted && !labeled && !dueStep(status, "evaluate", at)) return false
  const headless = status?.evaluator?.headless
  if (headless?.day >= isoDay(at) && headless.jobs >= MAX_HEADLESS_JOBS_PER_DAY) return false
  if (["quota_exhausted", "window_protected", "clock_regressed"].includes(witnessedEvaluationQuota(status, at))) return false
  const version = deskVersion(env)
  return version !== null && (await runnableContextWork(env, status, at)).some((work) => sourceVersionMatches(work, version))
}

function template(work) {
  return {
    schema: RECOMMENDATION_SCHEMA, job: work.job, evaluator: work.source.evaluator,
    state: "unavailable", heading: null, events: [], recommendations: [],
    sources: work.source.sources.map((facts) => contextSource(facts, work.job)),
    coverage: { state: "unavailable", reasons: ["not_recorded"], omitted_events: 0 }, privacy: null,
  }
}

function evidenceOutline(work) {
  return work.source.sources.map((facts) => {
    const share = contextShare(facts, work.job)
    const eligible = facts.intervals.filter((interval) => share.some((span) => interval.start_ms >= span.start_ms && interval.end_ms <= span.end_ms))
      .sort((left, right) => left.start_ms - right.start_ms || left.end_ms - right.end_ms)
    const waits = eligible.filter((interval) => ["human_wait", "permission_wait", "api_retry"].includes(interval.kind))
    const selected = new Set([...eligible.slice(0, 2), ...eligible.slice(-2), ...waits.slice(0, 4), ...waits.slice(-4)])
    const intervals = eligible.filter((interval) => selected.has(interval))
    const shares = share.length <= 8 ? share : [...share.slice(0, 4), ...share.slice(-4)]
    const evidence = work.source.private_evidence.find((entry) => entry.session === facts.session.id)
    return {
      session: facts.session.id, source: contextSource(facts, work.job).sha256,
      session_offset_ms: facts.jobs.find((entry) => entry.job === work.job).session_offset_ms,
      duration_ms: facts.session.duration_ms, ended: facts.session.ended,
      clock_origin: evidence.clock_origin, log_path: evidence.log_path,
      shares: shares.map((span) => [span.start_ms, span.end_ms]), omitted_shares: share.length - shares.length,
      intervals: intervals.map((interval) => ({ kind: interval.kind, range: [interval.start_ms, interval.end_ms] })),
      omitted_intervals: eligible.length - intervals.length,
    }
  })
}

/** One existing-ledger launch, one phase, at most eight jobs. Labels retain priority in the caller. */
export async function runTaskContextStep(env, options = {}) {
  return runContextStep(env, options, null)
}

/** Explicit requested work owns one generation/review pair; automatic callers never receive this allowance. */
export async function runRequestedTaskContext(env, options = {}) {
  const { store, job } = options
  if (typeof store !== "string" || !PATTERNS.prRepo.test(store) || typeof job !== "string" || !PATTERNS.jobId.test(job))
    throw new TypeError("runRequestedTaskContext: valid store and job required")
  if (isHeadlessFactorySession(env)) return idle("headless_session", false)
  const clock = options.clock ?? Date.now
  const deadline = options.deadline ?? clock() + 2 * HEADLESS_TIMEOUT_MS + 120000
  if (!Number.isFinite(new Date(deadline).getTime())) throw new TypeError("runRequestedTaskContext: valid deadline required")
  const root = await factoryStateRoot(env, { create: false })
  if (root === null) return idle("no_factory_state", false)
  const lock = await takeLock(root, { name: EVALUATOR_LOCK_NAME, record: { children: [], requested: { store, job } } })
  if (lock === null) return idle("busy", false)
  const slots = new Set(["candidate", "privacy"])
  const phases = []
  const reservations = []
  const budget = () => ({ allocated: 2, consumed: 2 - slots.size, remaining: slots.size })
  const cost = () => phases.length > 0 && phases.every(value => Number.isFinite(value.cost_usd) && value.cost_usd >= 0)
    ? phases.reduce((sum, value) => sum + value.cost_usd, 0) : null
  const persist = async (result, ready = false) => updateStatus(env, current => ({
    ...current,
    requested_context: { at: new Date(clock()).toISOString(), store, job, result, ready, budget: budget(), cost_usd: cost(), reservations, phases },
  }))
  const policy = {
    store, job, phase: null,
    reserve: async (phase) => {
      if (!slots.delete(phase)) return { state: "request_budget_exhausted" }
      policy.phase = phase
      reservations.push({ phase, state: "reserved" })
      await persist("running")
      return { state: "reserved", token: phase }
    },
    finish: async ({ token, state }) => {
      reservations.find(value => value.phase === token).state = state
      await persist("checking_output")
    },
  }
  try {
    await persist("running")
    let output = idle("no_context_waiting")
    let ready = false
    for (let turn = 0; turn < 2; turn += 1) {
      policy.phase = null
      output = await runContextStep(env, {
        ...options, deadline,
        onChild: async (pid) => { await trackChild(lock, pid, true); await options.onChild?.(pid) },
        onChildExit: async (pid) => { await trackChild(lock, pid, false); await options.onChildExit?.(pid) },
      }, policy)
      phases.push({ phase: policy.phase, ...output })
      ready = policy.phase === "privacy" && output.ok && output.accepted === 1
      await persist(ready ? "context_requested" : output.result, ready)
      if (ready || !output.ok || output.accepted !== 1 || policy.phase !== "candidate") break
    }
    return {
      ok: ready, result: ready ? "context_requested" : output.result, ready,
      launched: phases.some(value => value.launched), accepted: phases.reduce((sum, value) => sum + value.accepted, 0),
      refused: phases.reduce((sum, value) => sum + value.refused, 0), budget: budget(), cost_usd: cost(), phases,
    }
  } catch (error) {
    await persist("error")
    throw error
  } finally {
    await releaseLock(lock)
  }
}

async function runContextStep(env, options, requestPolicy) {
  const impl = { runHeadless, probeSignIn, qualifyHeadlessSource, findAgentCli, reserveAgentLaunch, finishAgentLaunch, clock: Date.now, ...options }
  if (isHeadlessFactorySession(env)) return idle("headless_session", false)
  if (env.DESK_FACTORY_HEADLESS_EVALUATOR !== undefined && !ON.has(env.DESK_FACTORY_HEADLESS_EVALUATOR.trim().toLowerCase())) return idle("disabled")
  const now = options.now === undefined ? impl.clock() : new Date(options.now).getTime()
  const deadline = new Date(options.deadline).getTime()
  if (!Number.isFinite(now) || !Number.isFinite(deadline)) throw new TypeError("runTaskContextStep: valid now and deadline required")
  const status = await readStatus(env)
  const waiting = (await runnableContextWork(env, status, now)).filter(work => requestPolicy === null ||
    work.store.toLowerCase() === requestPolicy.store.toLowerCase() && work.job === requestPolicy.job)
  if (waiting.length === 0) return idle("no_context_waiting")
  const version = deskVersion(env)
  if (version === null) return idle("context_source_unavailable", false)
  const pluginRoot = deskPluginRoot(env)
  if (options.pluginVersion !== undefined && options.pluginVersion !== version) return idle("context_source_mismatch", false)
  const jobs = waiting.filter((work) => sourceVersionMatches(work, version))
  if (jobs.length === 0) return idle("context_source_stale")
  jobs.sort((left, right) => Number(right.phase === "privacy") - Number(left.phase === "privacy") || left.job.localeCompare(right.job))
  const selected = jobs.filter((work) => work.phase === jobs[0].phase).slice(0, MAX_BATCH)
  if (impl.clock() + HEADLESS_TIMEOUT_MS > deadline) return idle("no_time_for_a_run", false)
  const quota = witnessedEvaluationQuota(status, now)
  if (quota === "clock_regressed" || requestPolicy !== null && quota === "witness_invalid" ||
      requestPolicy === null && ["quota_exhausted", "window_protected"].includes(quota)) return idle("budget_exhausted")
  if (billingVariableBlocks(env)) return idle("disabled_would_bill", false)
  const cli = impl.findAgentCli({ env })
  if (cli === null) return idle("no_agent_cli", false)
  const signIn = await impl.probeSignIn({ cli, env, onChild: impl.onChild, onChildExit: impl.onChildExit })
  if (signIn?.state !== "subscription") return idle(signIn?.state ?? "sign_in_unknown", false)
  if (impl.clock() + HEADLESS_TIMEOUT_MS > deadline) return idle("no_time_for_a_run", false)
  let instructions
  try {
    instructions = readFileSync(path.join(pluginRoot, "skills", "factory-task-context", "SKILL.md"), "utf8").split(/\r?\n/u)
  } catch (error) {
    if (error.code === "ENOENT") return idle("context_source_unavailable", false)
    throw error
  }
  const root = await factoryStateRoot(env)
  const workDir = path.join(root, "scratch", "context")
  await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
  const selectedDirs = new Set(selected.map((work) => path.dirname(work.input)))
  for (const work of selected) {
    for (const entry of work.source.private_evidence) if (entry.log_path !== null) selectedDirs.add(path.dirname(entry.log_path))
    if (work.source.task_card !== null) selectedDirs.add(path.dirname(work.source.task_card.path))
  }
  const sourceOptions = {
    env, cli, pluginRoot, pluginVersion: version, workDir,
    evaluationDir: path.dirname(selected[0].input), logDirs: [...selectedDirs],
    onChild: impl.onChild, onChildExit: impl.onChildExit,
  }
  const qualify = async (options) => {
    const remaining = deadline - impl.clock()
    return remaining > 0 && (await impl.qualifyHeadlessSource({ ...options, timeoutMs: remaining }))?.state === "qualified"
  }
  if (!await qualify(sourceOptions)) return idle("context_source_unqualified", false)
  if (impl.clock() + HEADLESS_TIMEOUT_MS > deadline) return idle("no_time_for_a_run", false)
  const phase = selected[0].phase
  const reservation = requestPolicy === null
    ? await impl.reserveAgentLaunch(env, { kind: "evaluate", generation: null, now, legacyEvaluator: status.evaluator })
    : await requestPolicy.reserve(phase)
  if (reservation.state !== "reserved") return idle("budget_exhausted")
  const briefs = []
  const logDirs = new Set()
  let run
  let requested = false
  let sourceQualified = true
  try {
    for (const work of selected) {
      const token = randomBytes(8).toString("hex")
      const claimed = await updateTaskContextState(env, work.store, work.job, (state) => {
        if (state.basis !== work.basis || state.phase !== phase || !due({ ...work, state }, now)) return state
        return {
          ...state, attempts: { ...state.attempts, [phase]: state.attempts[phase] + 1 },
          last_attempts: { ...state.last_attempts, [phase]: new Date(now).toISOString() }, run: token,
        }
      })
      if (claimed.run !== token) continue
      const outputName = `${token}.${phase}.json`
      const brief = {
        schema: "desk.factory.context-brief/1", phase, job: work.job, evaluator: work.source.evaluator,
        input_file: work.input, task_card: work.source.task_card,
        task_card_status: work.source.task_card_status ?? (work.source.task_card === null ? "not_associated" : "associated"),
        output: await taskContextPath(env, work.store, work.job, outputName),
        instructions, template: template(work), evidence_outline: evidenceOutline(work),
        ...(phase === "privacy" ? { candidate: work.state.candidate, payload_sha256: work.state.candidate_hash } : {}),
      }
      const file = await writeTaskContextFile(env, work.store, work.job, `${token}.brief.json`, brief)
      for (const entry of work.source.private_evidence) if (entry.log_path !== null) logDirs.add(path.dirname(entry.log_path))
      if (work.source.task_card !== null) logDirs.add(path.dirname(work.source.task_card.path))
      logDirs.add(path.dirname(file))
      briefs.push({ ...work, file, outputName })
    }
    run = { state: "not_started", cost_usd: null }
    if (briefs.length > 0) {
      const actualSourceOptions = { ...sourceOptions, evaluationDir: path.dirname(briefs[0].file), logDirs: [...logDirs] }
      sourceQualified = await qualify(actualSourceOptions)
      if (!sourceQualified) run = { state: "context_source_unqualified", cost_usd: null }
      else if (impl.clock() + HEADLESS_TIMEOUT_MS > deadline) run = { state: "no_time_for_a_run", cost_usd: null }
      else {
        requested = true
        run = await impl.runHeadless({
          env, job: { host: "claude-code" }, briefPaths: briefs.map((brief) => brief.file),
          purpose: phase === "privacy" ? "context_privacy" : "task_context",
          evaluationDir: actualSourceOptions.evaluationDir, logDirs: actualSourceOptions.logDirs, workDir, cli, signIn, pluginRoot,
          onChild: impl.onChild, onChildExit: impl.onChildExit,
        })
        sourceQualified = await qualify(actualSourceOptions)
      }
    }
  } finally {
    const finished = { token: reservation.token, state: run?.state === "ran" ? "ran" : !requested ? "not_started" : "failed", now: impl.clock() }
    if (requestPolicy === null) await impl.finishAgentLaunch(env, finished)
    else await requestPolicy.finish(finished)
  }
  let accepted = 0
  let refused = 0
  if (run.state === "ran" && sourceQualified) {
    for (const work of briefs) {
      const bytes = await readTaskContextFile(env, work.store, work.job, work.outputName)
      const checked = await (phase === "privacy" ? acceptContextPrivacy : acceptContextCandidate)(env, {
        store: work.store, job: work.job, basis: work.basis, bytes,
      })
      if (["context_accepted", "candidate_accepted"].includes(checked.result)) accepted += 1
      else refused += 1
    }
  } else refused = briefs.length
  const output = {
    ok: sourceQualified && run.state === "ran" && refused === 0,
    result: !sourceQualified ? "context_source_unqualified" : run.state === "ran" ? "context_ran" : run.state,
    launched: requested, accepted, refused,
  }
  if (requestPolicy !== null) output.cost_usd = Number.isFinite(run.cost_usd) && run.cost_usd >= 0 ? run.cost_usd : null
  if (requestPolicy === null) await updateStatus(env, (current) => ({
    ...current,
    context_evaluation: {
      at: new Date(impl.clock()).toISOString(), phase, result: output.result, accepted, refused,
      cost_usd: Number.isFinite(run.cost_usd) && run.cost_usd >= 0 ? run.cost_usd : null,
    },
  }))
  return output
}
