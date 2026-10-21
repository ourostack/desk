import { randomBytes } from "node:crypto"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import {
  acceptContextCandidate, acceptContextPrivacy, listContextWork,
} from "./context-outbox.js"
import { CONTEXT_SCHEMA, contextShare, contextSource } from "./context-schema.js"
import {
  factoryStateRoot, readConsent, readStatus, readTaskContextFile,
  taskContextPath, updateStatus, updateTaskContextState, writeTaskContextFile,
} from "./outbox.js"
import {
  HEADLESS_TIMEOUT_MS, billingVariableBlocks, findAgentCli, probeSignIn, runHeadless,
} from "./headless.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { finishAgentLaunch, reserveAgentLaunch, witnessedEvaluationQuota } from "./headless-ledger.js"

const MAX_BATCH = 8
const DAY = 24 * 3600 * 1000
const ON = new Set(["1", "true", "on", "yes"])
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)
const idle = (result, ok = true) => ({ ok, result, launched: false, accepted: 0, refused: 0 })
const INSTRUCTIONS = new URL("../../../skills/factory-task-context/SKILL.md", import.meta.url)

function due(work, now) {
  const attempts = work.state.attempts?.[work.phase]
  const last = work.state.last_attempts?.[work.phase]
  return Number.isSafeInteger(attempts) && attempts < 3 &&
    (last === undefined || (typeof last === "string" && isoDay(Date.parse(last)) < isoDay(now)))
}

function template(work) {
  return {
    schema: CONTEXT_SCHEMA, job: work.job, evaluator: work.source.evaluator,
    state: "unavailable", heading: null, events: [],
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
  const impl = { runHeadless, probeSignIn, findAgentCli, reserveAgentLaunch, finishAgentLaunch, clock: Date.now, ...options }
  if (isHeadlessFactorySession(env)) return idle("headless_session", false)
  if (env.DESK_FACTORY_HEADLESS_EVALUATOR !== undefined && !ON.has(env.DESK_FACTORY_HEADLESS_EVALUATOR.trim().toLowerCase())) return idle("disabled")
  const now = options.now === undefined ? impl.clock() : new Date(options.now).getTime()
  const deadline = new Date(options.deadline).getTime()
  if (!Number.isFinite(now) || !Number.isFinite(deadline)) throw new TypeError("runTaskContextStep: valid now and deadline required")
  const status = await readStatus(env)
  const stores = Object.entries((await readConsent(env)).stores).filter(([, value]) => value.contribute === true).map(([store]) => store).sort()
  const jobs = []
  for (const store of stores) {
    const readiness = status.context_publication?.[store]
    const checked = Date.parse(readiness?.checked_at)
    if (readiness?.ready !== true || !Number.isFinite(checked) || checked - now > 300000 || now - checked > 3 * DAY) continue
    for (const work of await listContextWork(env, { store })) if (due(work, now)) jobs.push({ ...work, store })
  }
  if (jobs.length === 0) return idle("no_context_waiting")
  jobs.sort((left, right) => Number(right.phase === "privacy") - Number(left.phase === "privacy") || left.job.localeCompare(right.job))
  const selected = jobs.filter((work) => work.phase === jobs[0].phase).slice(0, MAX_BATCH)
  if (impl.clock() + HEADLESS_TIMEOUT_MS > deadline) return idle("no_time_for_a_run", false)
  const quota = witnessedEvaluationQuota(status, now)
  if (["quota_exhausted", "window_protected", "clock_regressed"].includes(quota)) return idle("budget_exhausted")
  if (billingVariableBlocks(env)) return idle("disabled_would_bill", false)
  const cli = impl.findAgentCli({ env })
  if (cli === null) return idle("no_agent_cli", false)
  const signIn = await impl.probeSignIn({ cli, env, onChild: impl.onChild, onChildExit: impl.onChildExit })
  if (signIn?.state !== "subscription") return idle(signIn?.state ?? "sign_in_unknown", false)
  if (impl.clock() + HEADLESS_TIMEOUT_MS > deadline) return idle("no_time_for_a_run", false)
  const reservation = await impl.reserveAgentLaunch(env, { kind: "evaluate", generation: null, now, legacyEvaluator: status.evaluator })
  if (reservation.state !== "reserved") return idle("budget_exhausted")
  const phase = selected[0].phase
  const instructions = readFileSync(INSTRUCTIONS, "utf8").split(/\r?\n/u)
  const briefs = []
  const logDirs = new Set()
  let run
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
        input_file: work.input, output: await taskContextPath(env, work.store, work.job, outputName),
        instructions, template: template(work), evidence_outline: evidenceOutline(work),
        ...(phase === "privacy" ? { candidate: work.state.candidate, payload_sha256: work.state.candidate_hash } : {}),
      }
      const file = await writeTaskContextFile(env, work.store, work.job, `${token}.brief.json`, brief)
      for (const entry of work.source.private_evidence) if (entry.log_path !== null) logDirs.add(path.dirname(entry.log_path))
      if (work.source.task_card !== null) logDirs.add(path.dirname(work.source.task_card.path))
      logDirs.add(path.dirname(file))
      briefs.push({ ...work, file, outputName })
    }
    const root = await factoryStateRoot(env)
    const workDir = path.join(root, "scratch", "context")
    await fs.mkdir(workDir, { recursive: true, mode: 0o700 })
    run = briefs.length === 0 ? { state: "not_started", cost_usd: null } : await impl.runHeadless({
      env, job: { host: "claude-code" }, briefPaths: briefs.map((brief) => brief.file),
      purpose: phase === "privacy" ? "context_privacy" : "task_context",
      evaluationDir: path.dirname(briefs[0].file), logDirs: [...logDirs], workDir, cli, signIn,
      onChild: impl.onChild, onChildExit: impl.onChildExit,
    })
  } finally {
    await impl.finishAgentLaunch(env, { token: reservation.token, state: run?.state === "ran" ? "ran" : briefs.length === 0 ? "not_started" : "failed", now: impl.clock() })
  }
  let accepted = 0
  let refused = 0
  if (run.state === "ran") {
    for (const work of briefs) {
      const bytes = await readTaskContextFile(env, work.store, work.job, work.outputName)
      const checked = await (phase === "privacy" ? acceptContextPrivacy : acceptContextCandidate)(env, {
        store: work.store, job: work.job, basis: work.basis, bytes,
      })
      if (["context_accepted", "candidate_accepted"].includes(checked.result)) accepted += 1
      else refused += 1
    }
  } else refused = briefs.length
  const output = { ok: run.state === "ran" && refused === 0, result: run.state === "ran" ? "context_ran" : run.state, launched: briefs.length > 0, accepted, refused }
  await updateStatus(env, (current) => ({
    ...current,
    context_evaluation: {
      at: new Date(impl.clock()).toISOString(), phase, result: output.result, accepted, refused,
      cost_usd: Number.isFinite(run.cost_usd) && run.cost_usd >= 0 ? run.cost_usd : null,
    },
  }))
  return output
}
