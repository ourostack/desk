// The waste evaluator's local half (spec §6, classification): what Desk
// hands a fresh `desk:observer` when a task reaches `done`, and the check
// its answer must pass before it becomes local labels.
//
// The evaluator is never the agent that did the work and never sees that
// agent's conversation context: it gets one bounded brief per session and
// reads the evidence the brief points at. A brief (`desk.factory.evaluator-
// brief/2`) holds:
//
//   - the job and the session's host and ID;
//   - `evaluator`: the Desk plugin version and rubric version the labels
//     must carry, copied as they are;
//   - `session_log`: the host's local session log, or `null` when its marker
//     is gone or the file is missing;
//   - `clock_origin`: the session's start, so a log line's time can be put
//     on the session clock (`offset = time - clock_origin`); it stays in the
//     brief and never reaches labels;
//   - `facts`: the session on the published clock (`publish.js`'s
//     `publishedClock`), with the counts. Its intervals are exactly the ones
//     the store will hold, so evidence copied from them matches the store's
//     gate. `null` when the session could never be published;
//   - `own_share`: the job's own spans of the session (`[{ start_ms,
//     end_ms }]` on the same clock): its binding's segments, or the whole
//     session for a binding from before workers were recorded that is the
//     session's only job, as the store reads it. `null` when the store cannot
//     tell which part was the job's (a subagent-only binding, or one of
//     several without segments): no label of it can be credited to the job,
//     so the evaluator writes no stretches. The store counts labels only
//     inside the job's share, so a shared session is labeled there, not whole;
//   - `stops`: one hint per `human_wait` interval of `facts` that overlaps
//     `own_share` (none when it is `null`, as the store counts no other), in order:
//     `{ wait: [start_ms, end_ms], stop, rule }`. `stop` is the interval's
//     stop facts from the session's local facts (`{ end, asks,
//     pending_agents }`, how the agent's turn ended before the wait) or
//     `null` when the facts do not record them; `rule` is the class a rule
//     gives that end (`STOP_RULES`), or `null` when the evaluator decides.
//     The evaluator writes a stop only for a wait whose `rule` is `null`;
//   - `unavailable`: `session_log_missing` and `facts_missing` as they apply;
//   - `output`: where the evaluator writes its labels.
//
// `acceptEvaluation(brief, bytes)` is the check. The answer must be JSON of
// at most the facts size cap and pass `validateLabels`; it must be the
// current labels form (`desk.factory.labels/3`, else `schema_outdated`), so
// every new label carries its confidence and version and the file carries
// its stops; it must name the
// brief's job and session and carry the brief's evaluator version and rubric,
// on the file, on every stretch and on every stop (`job_mismatch`, `session_mismatch`,
// `evaluator_mismatch`); it must declare
// everything the brief says is unavailable and never declare facts missing
// that the brief holds (`inconsistent`); and it must pass
// `checkLabelsAgainstFacts` against the brief's facts, with each wait's stop
// facts from the brief's hints (`range`, `evidence_unmatched`, and
// `inconsistent` for a stop on a wait a rule decides). Errors are `{ code, path }` only, as in every
// factory gate, so nothing the evaluator wrote is ever echoed. Accepted
// labels are rebuilt from the parsed value, so formatting and a duplicated
// key's shadowed value are dropped. After every check passes, Desk puts a
// catch point (`caught`) on each `defects` stretch it can place from the
// session's own local facts (`catch-point.js`); a `caught` the evaluator
// wrote is dropped with the rest.
//
// The done step (`evaluateTask`) first records an evaluation request for
// the job (`evaluate-requests/<job>.json`), because the session that
// finished the job is usually not derived yet. `evaluatePending` prepares
// retained requests again; a request is cleared only once every session of
// the job has settled labels: accepted labels whose evidence (`labelsBasis`:
// the job's own share, the facts intervals in it and the stop hints) is still
// the session's, whether the session has ended or runs on with other work
// (labels of an older rubric are labeled again while the session's log is
// still on disk and its facts carry stop facts; otherwise they stand), moved to
// `evaluate-requests/expired/` when it expires (the evaluator step counts
// these) and quarantined with a stable code when its stores lose consent. A session whose facts are
// quarantined can never deliver labels, so it is not briefed: its labels key
// is quarantined instead (`holdLabels`, `facts_quarantined` naming the
// facts), and it counts as settled rather than keeping the request pending.
//
// `prepareEvaluation(env, { job, pluginVersion })` writes a brief for each
// of the job's sessions (from the jobs index) that a store with consent
// holds, and `acceptEvaluations(env, { job })` checks each answer against
// its brief and writes accepted labels to the outbox (`writeLocalLabels`),
// clearing the brief. A rejected answer stays where it is, beside its brief,
// for another try; it never enters the outbox. The brief file is for the
// evaluator only: the answer is checked against a brief rebuilt from the
// session's own local facts, so editing the brief changes nothing, and a
// session whose facts are gone is refused as `facts_missing`.
//
// `requestFinishedJobs(env, { deskRoot })` is the backstop for a request the
// done step never recorded or that was settled while it could not be labeled
// (a session held back behind quarantined facts that were later released):
// every job in the jobs index whose latest observed card status is `done` or
// `cancelled`, that has no request, expired request or quarantined request,
// and that has a labelable session needing labels (`sessionNeedsLabels`:
// none yet, labels whose evidence changed since they were made, or labels of
// an older rubric on facts with stop facts while the session's log is still
// on disk) gets a request, with the card's observed time as its finish time.
// A session held back behind quarantined facts is passed over; the job's
// other sessions still count. It is how the rubric-4 relabel of
// already-labeled finished jobs is asked for, and how labels follow facts
// derived again: a job whose request expires is never asked for again.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createHash } from "node:crypto"
import * as path from "node:path"
import { promises as fsp } from "node:fs"

import { outcomeForStamping, stampCatchPoints } from "./catch-point.js"
import { LABELS_SCHEMA, STOP_RULES, checkLabelsAgainstFacts, validateLabels } from "./label-schema.js"
import {
  clearEvaluation,
  clearEvaluationRequest,
  evaluationPaths,
  expireEvaluationRequest,
  factoryStateRoot,
  holdLabels,
  listEvaluationBriefs,
  listEvaluationRequests,
  localLabelsRubric,
  readConsent,
  readEvaluationOutput,
  readJobsIndex,
  readLocalFacts,
  readLabelsBasis,
  readMarker,
  readStatus,
  requestEvaluation,
  settledEvaluationRequests,
  writeEvaluationBrief,
  writeLabelsBasis,
  writeLocalLabels,
} from "./outbox.js"
import { publishedClock } from "./publish.js"
import { SESSION_ID_V4 } from "./published-schema.js"
import { LIMITS, PATTERNS, isPlainObject, validateLocalFacts } from "./schema.js"

export const BRIEF_SCHEMA = "desk.factory.evaluator-brief/2"
export const EVALUATOR_SKILL = "desk:factory-evaluator"
/** The rubric `skills/factory-evaluator/SKILL.md` states; labels carry it as `evaluator.rubric`. */
export const RUBRIC_VERSION = "4"
/**
 * The derive receipt's `binding_version` (`derive-run.js` `BINDING_VERSION`) from which the derivers record each human wait's stop facts
 * (ourostack/desk #254 raises it to 7). Labels of an older rubric are labeled again under rubric 4 only for a session derived at this version
 * or later, so the one-time relabel never runs on facts without the stop facts it classifies.
 */
export const STOP_FACTS_BINDING_VERSION = 7

const DESK_VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-(?:alpha|beta|rc)\.[0-9]{1,4})?$/u
// The session ID an outbox file name (`<host>-<session_id>.json`) carries.
const SESSION_OF = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/u

function contract(ok, detail) {
  if (!ok) throw new TypeError(`buildEvaluatorBrief: ${detail}`)
}

/**
 * `buildEvaluatorBrief({ job, localFacts, logPath, outputPath, pluginVersion })
 * -> Brief | null`: the brief for one session of `job`, or `null` when the
 * session ID could never be published (labels for it could never be either).
 * `localFacts` must be valid and bind `job`; `logPath` is an absolute path or
 * `null`; `outputPath` is absolute; `pluginVersion` is a Desk version. These
 * are caller contracts: a violation throws a `TypeError` that names no value.
 */
export function buildEvaluatorBrief({ job, localFacts, logPath, outputPath, pluginVersion }) {
  contract(typeof job === "string" && PATTERNS.jobId.test(job), "job must be a job ID")
  contract(validateLocalFacts(localFacts).ok, "localFacts must pass validateLocalFacts")
  contract(localFacts.jobs.some((bound) => bound.job === job), "localFacts must bind the job")
  contract(logPath === null || (typeof logPath === "string" && path.isAbsolute(logPath)), "logPath must be absolute or null")
  contract(typeof outputPath === "string" && path.isAbsolute(outputPath), "outputPath must be absolute")
  contract(typeof pluginVersion === "string" && DESK_VERSION.test(pluginVersion), "pluginVersion must be a Desk version")

  // Codex sessions carry a version-7 ID and are not labelled yet (parked for milestone 4); their published ID is keyed, which labels cannot carry.
  if (!SESSION_ID_V4.test(localFacts.session.id)) return null
  const evidence = briefEvidence(job, localFacts)
  const unavailable = []
  if (logPath === null) unavailable.push("session_log_missing")
  if (evidence.facts === null) unavailable.push("facts_missing")
  return {
    schema: BRIEF_SCHEMA,
    skill: EVALUATOR_SKILL,
    job,
    session: { host: localFacts.session.host, id: localFacts.session.id },
    evaluator: { plugin_version: pluginVersion, rubric: RUBRIC_VERSION },
    session_log: logPath,
    clock_origin: evidence.facts === null ? null : localFacts.session.started_at,
    facts: evidence.facts,
    own_share: evidence.own_share,
    stops: evidence.stops,
    unavailable,
    output: outputPath,
  }
}

// What a brief tells the evaluator about the session: the published facts, the job's own share and the stop hints.
function briefEvidence(job, localFacts) {
  const { clock } = publishedClock(localFacts)
  if (clock === null) return { facts: null, own_share: null, stops: [] }
  const binding = localFacts.jobs.find((bound) => bound.job === job)
  const share = ownShareOf(binding, localFacts.jobs.length, clock.duration_ms)
  return { facts: { ...clock, counts: structuredClone(localFacts.counts) }, own_share: share, stops: stopHints(localFacts, clock, share) }
}

const inShare = (share, start, end) => share !== null && share.some((span) => start < span.end_ms && end > span.start_ms)

/**
 * `labelsBasis(evidence) -> string`: the fingerprint (64 hex) of the evidence a session's labels for one job rest on, from a brief or
 * `briefEvidence`: the job's own share, the facts intervals that overlap it and the stop hints. The session's other work, its counts and the
 * evaluator's version are left out, so a session that runs on with other jobs keeps the basis of a job that finished in it. Accepted labels
 * record it (`writeLabelsBasis`); facts derived again with a different basis make the labels unsettled, so they are labeled again.
 */
export function labelsBasis({ facts, own_share: share, stops }) {
  const evidence = facts === null ? null : { share, intervals: facts.intervals.filter((interval) => inShare(share, interval.start_ms, interval.end_ms)), stops }
  return createHash("sha256").update(JSON.stringify(evidence)).digest("hex")
}

// One hint per human wait the published clock keeps inside the job's own share (none when the share is unknown, as the store counts no stop
// there): its range, its local stop facts (or `null`) and the class a rule gives them (or `null`).
function stopHints(localFacts, clock, share) {
  const startedMs = Date.parse(localFacts.session.started_at)
  const kept = new Set(clock.intervals.filter((interval) => interval.kind === "human_wait" && inShare(share, interval.start_ms, interval.end_ms)).map((interval) => `${interval.start_ms}:${interval.end_ms}`))
  // One hint per kept range, in the facts' order; a range listed twice keeps the stop facts one of them records.
  const hints = new Map()
  for (const interval of localFacts.intervals) {
    const wait = [Date.parse(interval.start) - startedMs, Date.parse(interval.end) - startedMs]
    const key = `${wait[0]}:${wait[1]}`
    if (interval.kind !== "human_wait" || !kept.has(key) || hints.get(key)?.stop) continue
    const stop = Object.hasOwn(interval, "stop") ? { end: interval.stop.end, asks: interval.stop.asks, pending_agents: interval.stop.pending_agents } : null
    hints.set(key, { wait, stop, rule: stop === null ? null : (STOP_RULES[stop.end] ?? null) })
  }
  return [...hints.values()]
}

// The job's own spans of the session, as the store's build reads the published binding (`resolveLabels`), or `null` when unknown.
function ownShareOf(binding, jobs, durationMs) {
  if (Object.hasOwn(binding, "segments")) return binding.segments.map((segment) => ({ start_ms: segment.start_ms, end_ms: segment.end_ms }))
  return !Object.hasOwn(binding, "agents") && jobs === 1 ? [{ start_ms: 0, end_ms: durationMs }] : null
}

const rejected = (errors) => ({ ok: false, errors })

/**
 * `acceptEvaluation(brief, bytes) -> { ok: true, errors: [], labels } |
 * { ok: false, errors }`: the evaluator's answer for `brief` (a value
 * `buildEvaluatorBrief` returned), checked as the header describes. `bytes`
 * is a `Buffer` or a string; anything else is a caller bug. `stamping` is
 * `{ outcome, startedAt }` (`catch-point.js`): when given, each accepted
 * `defects` stretch Desk can place gets its catch point after every check
 * has passed. A `caught` the evaluator wrote is never kept.
 */
export function acceptEvaluation(brief, bytes, stamping = null) {
  if (!Buffer.isBuffer(bytes) && typeof bytes !== "string") throw new TypeError("acceptEvaluation: bytes must be a Buffer or a string")
  if (Buffer.byteLength(bytes) > LIMITS.maxBytes) return rejected([{ code: "too_large", path: "" }])
  let value
  try {
    value = JSON.parse(bytes.toString("utf8"))
  } catch {
    return rejected([{ code: "json", path: "" }])
  }
  const schema = validateLabels(value)
  if (!schema.ok) return rejected(schema.errors)

  if (value.schema !== LABELS_SCHEMA) return rejected([{ code: "schema_outdated", path: "schema" }])
  const identity = []
  if (value.job !== brief.job) identity.push({ code: "job_mismatch", path: "job" })
  if (value.session !== brief.session.id) identity.push({ code: "session_mismatch", path: "session" })
  if (value.evaluator.plugin_version !== brief.evaluator.plugin_version) identity.push({ code: "evaluator_mismatch", path: "evaluator.plugin_version" })
  if (value.evaluator.rubric !== brief.evaluator.rubric) identity.push({ code: "evaluator_mismatch", path: "evaluator.rubric" })
  value.stretches.forEach((stretch, index) => {
    if (stretch.evaluator_version !== brief.evaluator.plugin_version) identity.push({ code: "evaluator_mismatch", path: `stretches.${index}.evaluator_version` })
  })
  value.stops.forEach((stop, index) => {
    if (stop.evaluator_version !== brief.evaluator.plugin_version) identity.push({ code: "evaluator_mismatch", path: `stops.${index}.evaluator_version` })
  })
  if (identity.length > 0) return rejected(identity)

  const undeclared = brief.unavailable.some((code) => !value.unavailable.includes(code))
  const falselyMissing = brief.facts !== null && value.unavailable.includes("facts_missing")
  if (undeclared || falselyMissing) return rejected([{ code: "inconsistent", path: "unavailable" }])

  if (brief.facts !== null) {
    // Each wait carries its stop facts from the hints, so a stop on a wait a rule decides is refused here as the store refuses it.
    const stops = new Map(brief.stops.filter((hint) => hint.stop !== null).map((hint) => [`${hint.wait[0]}:${hint.wait[1]}`, hint.stop]))
    const intervals = brief.facts.intervals.map((interval) => {
      const stop = interval.kind === "human_wait" ? stops.get(`${interval.start_ms}:${interval.end_ms}`) : undefined
      return stop === undefined ? interval : { ...interval, stop }
    })
    const facts = { session: { id: brief.session.id, duration_ms: brief.facts.duration_ms }, jobs: [{ job: brief.job }], intervals }
    const against = checkLabelsAgainstFacts(value, facts)
    if (!against.ok) return rejected(against.errors)
  }

  const hinted = new Set(brief.stops.map((hint) => `${hint.wait[0]}:${hint.wait[1]}`))
  // Rebuilt field by field in schema order: nothing but the schema's own keys survives.
  const labels = {
    schema: value.schema,
    job: value.job,
    session: value.session,
    evaluator: { plugin_version: value.evaluator.plugin_version, model: value.evaluator.model, rubric: value.evaluator.rubric },
    stretches: value.stretches.map((stretch) => ({
      start_ms: stretch.start_ms,
      end_ms: stretch.end_ms,
      class: stretch.class,
      waste: stretch.waste,
      mura: stretch.mura,
      muri: stretch.muri,
      evidence: stretch.evidence.map((range) => [range[0], range[1]]),
      confidence: stretch.confidence,
      evaluator_version: stretch.evaluator_version,
    })),
    // A stop on a wait the brief gave no hint for (outside the job's own share) counts for nothing in the store, so it is not kept.
    stops: value.stops.filter((stop) => hinted.has(`${stop.wait[0]}:${stop.wait[1]}`)).map((stop) => ({ wait: [stop.wait[0], stop.wait[1]], why: stop.why, confidence: stop.confidence, evaluator_version: stop.evaluator_version })),
    unavailable: [...value.unavailable],
  }
  return { ok: true, errors: [], labels: stamping === null ? labels : stampCatchPoints(labels, stamping) }
}

// The host log a session's marker names, while it is still a regular file.
async function sessionLog(env, root, name) {
  try {
    const marker = await readMarker(env, path.join(root, "markers", name))
    const stat = await fsp.lstat(marker.log_path)
    return stat.isFile() ? marker.log_path : null
  } catch {
    return null
  }
}

// The session's local facts when they bind `job` and could ever be published, else `null`.
async function labelableFacts(env, store, name, job) {
  const localFacts = await readLocalFacts(env, store, name)
  if (localFacts === null || !localFacts.jobs.some((bound) => bound.job === job)) return null
  return SESSION_ID_V4.test(localFacts.session.id) ? localFacts : null
}

// Whether the session of outbox file `name` has its labels held back because its facts are quarantined, even facts too broken to read.
async function heldBack(env, store, job, name) {
  const session = SESSION_OF.exec(name)?.[1]
  return session !== undefined && (await holdLabels(env, store, { job, session })) !== null
}

async function consentedStores(env) {
  const consent = await readConsent(env)
  return Object.keys(consent.stores).filter((store) => consent.stores[store].contribute === true).sort()
}

/**
 * `prepareEvaluation(env, { job, pluginVersion }) -> { result, job, briefs }`:
 * `result` is `ready` with the brief paths, `not_opted_in` when no store has
 * consent, `no_sessions` when no consented store holds a session of the job
 * that could be published, or `complete` when every such session has settled
 * labels (`sessionNeedsLabels`), or has its labels held back because its
 * facts are quarantined (`holdLabels`). A `ready` answer also says how many
 * of its briefed sessions have no labels at all (`unlabeled`) and which
 * briefs those are (`unlabeled_briefs`).
 */
export async function prepareEvaluation(env, { job, pluginVersion }) {
  if (typeof job !== "string" || !PATTERNS.jobId.test(job)) throw new TypeError("prepareEvaluation: job must be a job ID")
  const stores = await consentedStores(env)
  if (stores.length === 0) return { result: "not_opted_in", job, briefs: [] }
  const root = await factoryStateRoot(env)
  const names = (await readJobsIndex(env))[job] ?? []
  const receipts = (await readStatus(env)).derivations
  const briefs = []
  const unlabeledBriefs = []
  let sessions = 0
  for (const store of stores) {
    for (const name of names) {
      if (await heldBack(env, store, job, name)) {
        sessions += 1
        continue
      }
      const localFacts = await labelableFacts(env, store, name, job)
      if (localFacts === null) continue
      sessions += 1
      const paths = await evaluationPaths(env, { job, store, name })
      const logPath = await sessionLog(env, root, name)
      const brief = buildEvaluatorBrief({ job, localFacts, logPath, outputPath: paths.output, pluginVersion })
      const needs = await sessionNeedsLabels(env, { store, job, name, localFacts, evidence: brief, logPath, receipts })
      if (needs === null) continue
      const file = await writeEvaluationBrief(env, { job, store, name, brief })
      briefs.push(file)
      if (needs === "unlabeled") unlabeledBriefs.push(file)
    }
  }
  if (sessions === 0) return { result: "no_sessions", job, briefs }
  return briefs.length > 0 ? { result: "ready", job, briefs, unlabeled: unlabeledBriefs.length, unlabeled_briefs: unlabeledBriefs } : { result: "complete", job, briefs }
}

/**
 * Whether one session still needs labels for `job`: `"unlabeled"` (it has none), `"relabel"` or `null` (its labels are settled). Labels are
 * settled when the evidence they were made against (`labelsBasis`, recorded on acceptance) is still the session's evidence, open or ended:
 * a job that finished in a session that runs on is labeled once at its finish, and again only when its facts are derived again with different
 * evidence. Labels recorded before the basis was kept follow the old rule: an open session is labeled again, an ended one stands. Either way,
 * labels of an older rubric are labeled again while the session's log is on disk, but only on facts that carry stop facts
 * (`STOP_FACTS_BINDING_VERSION`).
 */
async function sessionNeedsLabels(env, { store, job, name, localFacts, evidence, logPath, receipts }) {
  const session = localFacts.session.id
  const rubric = await localLabelsRubric(env, store, job, session)
  if (rubric === null) return "unlabeled"
  const outdated = Number(rubric) < Number(RUBRIC_VERSION) && logPath !== null && receipts?.[name]?.binding_version >= STOP_FACTS_BINDING_VERSION
  const basis = await readLabelsBasis(env, store, job, session)
  const stale = basis === null ? localFacts.session.ended_at === null : basis !== labelsBasis(evidence)
  return outdated || stale ? "relabel" : null
}

// The brief the answer is checked against: rebuilt from the session's local
// facts and marker, never read from the brief file the evaluator can edit.
async function trustedBrief(env, { job, store, name, output, pluginVersion }) {
  const localFacts = await labelableFacts(env, store, name, job)
  if (localFacts === null) return null
  const root = await factoryStateRoot(env)
  const brief = buildEvaluatorBrief({ job, localFacts, logPath: await sessionLog(env, root, name), outputPath: output, pluginVersion })
  return { brief, stamping: { outcome: outcomeForStamping(localFacts, job), startedAt: localFacts.session.started_at } }
}

async function answerBytes(env, output) {
  try {
    return { bytes: await readEvaluationOutput(env, output) }
  } catch (error) {
    return { error: /too large/u.test(error.message) ? "too_large" : "unsafe_file" }
  }
}

/**
 * `acceptEvaluations(env, { job, pluginVersion }) -> { job, sessions, request }`:
 * for each brief of `job`, `missing` (no answer yet), `rejected` with
 * `{ code, path }` errors, `accepted` (written to the outbox, brief and
 * answer cleared), `not_opted_in` (the store's consent was withdrawn;
 * nothing written) or `invalid_brief` (the brief file is unreadable or no
 * longer names this job and session; run `prepareEvaluation` again). The
 * answer is checked against the session's own local facts, rebuilt here;
 * facts that are gone are `facts_missing`. `request` is `cleared` when the
 * job's labels are then complete (its evaluation request is removed), else
 * `kept`.
 */
export async function acceptEvaluations(env, { job, pluginVersion }) {
  const sessions = []
  for (const { store, name, brief, output } of await listEvaluationBriefs(env, job)) {
    // The session comes from the brief's file name, which the listing checked.
    const session = name.slice(-".json".length - 36, -".json".length)
    if (!isPlainObject(brief) || brief.schema !== BRIEF_SCHEMA || brief.job !== job || `${brief.session?.host}-${brief.session?.id}.json` !== name) {
      sessions.push({ session, result: "invalid_brief" })
      continue
    }
    const answer = await answerBytes(env, output)
    if (answer.error !== undefined) {
      sessions.push({ session, result: "rejected", errors: [{ code: answer.error, path: "" }] })
      continue
    }
    if (answer.bytes === null) {
      sessions.push({ session, result: "missing" })
      continue
    }
    const trusted = await trustedBrief(env, { job, store, name, output, pluginVersion })
    if (trusted === null) {
      sessions.push({ session, result: "rejected", errors: [{ code: "facts_missing", path: "" }] })
      continue
    }
    const checked = acceptEvaluation(trusted.brief, answer.bytes, trusted.stamping)
    if (!checked.ok) {
      sessions.push({ session, result: "rejected", errors: checked.errors })
      continue
    }
    const written = await writeLocalLabels(env, store, checked.labels)
    if (!written.written) {
      sessions.push({ session, result: "not_opted_in" })
      continue
    }
    await writeLabelsBasis(env, store, { job, session, basis: labelsBasis(trusted.brief) })
    await clearEvaluation(env, { job, store, name })
    sessions.push({ session, result: "accepted" })
  }
  const status = await labelStatus(env, job)
  if (status === "complete") await clearEvaluationRequest(env, job)
  return { job, sessions, request: status === "complete" ? "cleared" : "kept" }
}

// Whether the job's labels are complete, without writing any brief.
async function labelStatus(env, job) {
  const stores = await consentedStores(env)
  const names = (await readJobsIndex(env))[job] ?? []
  const root = await factoryStateRoot(env)
  const receipts = (await readStatus(env)).derivations
  let sessions = 0
  for (const store of stores) {
    for (const name of names) {
      if (await heldBack(env, store, job, name)) {
        sessions += 1
        continue
      }
      const localFacts = await labelableFacts(env, store, name, job)
      if (localFacts === null) continue
      sessions += 1
      const needs = await sessionNeedsLabels(env, { store, job, name, localFacts, evidence: briefEvidence(job, localFacts), logPath: await sessionLog(env, root, name), receipts })
      if (needs !== null) return "incomplete"
    }
  }
  return sessions > 0 ? "complete" : "incomplete"
}

/**
 * `evaluateTask(env, { job, deskRoot, pluginVersion })`: the done step.
 * Without factory state or consent it answers `not_opted_in` and creates
 * nothing. Otherwise it records the job's evaluation request, then prepares
 * briefs; a `complete` job's request is cleared at once.
 */
export async function evaluateTask(env, { job, deskRoot, pluginVersion }) {
  if ((await factoryStateRoot(env, { create: false, deskRoot })) === null || (await consentedStores(env)).length === 0) {
    return { result: "not_opted_in", job, briefs: [] }
  }
  await requestEvaluation(env, { job, deskRoot })
  const prepared = await prepareEvaluation(env, { job, pluginVersion })
  if (prepared.result === "complete") await clearEvaluationRequest(env, job)
  return prepared
}

const REQUEST_TTL_MS = 30 * 24 * 60 * 60 * 1000

/**
 * `evaluatePending(env, { pluginVersion, now })`: every retained evaluation
 * request, prepared again. A request older than 30 days is moved to
 * `evaluate-requests/expired/` (the evaluator step counts these), one whose
 * stores all lack consent is quarantined as `not_opted_in`, and a
 * `complete` one is cleared; the rest are kept for the next run.
 */
export async function evaluatePending(env, { pluginVersion, now = Date.now() }) {
  const jobs = []
  for (const request of await listEvaluationRequests(env)) {
    const { job } = request
    if (now - Date.parse(request.requested_at) > REQUEST_TTL_MS) {
      await expireEvaluationRequest(env, job)
      jobs.push({ result: "expired", job, briefs: [] })
      continue
    }
    const prepared = await prepareEvaluation(env, { job, pluginVersion })
    if (prepared.result === "not_opted_in") await clearEvaluationRequest(env, job, "not_opted_in")
    if (prepared.result === "complete") await clearEvaluationRequest(env, job)
    // A ready job says when it finished: the finish time the request records, else the request's own time.
    jobs.push(prepared.result === "ready" ? { ...prepared, finished_at: request.finished_at ?? request.requested_at } : prepared)
  }
  return { jobs }
}

const TERMINAL = new Set(["done", "cancelled"])

// The latest observation of a job's card across the sessions read: `{ status, at }`, or null when none is timed. Facts that read are valid, so
// `observed` is null or an object whose `at` is null or a timestamp.
function laterObservation(current, { observed }) {
  if (observed === null || observed.at === null) return current
  return current === null || Date.parse(observed.at) > Date.parse(current.at) ? { status: observed.status, at: observed.at } : current
}

/**
 * `requestFinishedJobs(env, { deskRoot, now }) -> { requested: [job] }`: records an evaluation request for every finished job that needs labels and has
 * none (see the header). `deskRoot` (absolute, or null) stands in for a session marker that names no desk; a job with neither is left alone. `now`
 * (milliseconds, or null for the clock) is the time the requests record: the evaluator step passes its own start, so the requests it records
 * itself never make the step due again. Each session's facts are read once, however many jobs it binds.
 */
export async function requestFinishedJobs(env, { deskRoot = null, now = null } = {}) {
  if (deskRoot !== null && !path.isAbsolute(deskRoot)) throw new TypeError("requestFinishedJobs: deskRoot must be absolute or null")
  if (now !== null && !Number.isFinite(now)) throw new TypeError("requestFinishedJobs: now must be milliseconds or null")
  const stores = await consentedStores(env)
  if (stores.length === 0) return { requested: [] }
  const root = await factoryStateRoot(env)
  const index = await readJobsIndex(env)
  const waiting = new Set((await listEvaluationRequests(env)).map((request) => request.job))
  const settled = await settledEvaluationRequests(env)
  const receipts = (await readStatus(env)).derivations
  const factsRead = new Map()
  const markerRead = new Map()
  const facts = async (store, name) => {
    const key = `${store}\n${name}`
    if (!factsRead.has(key)) factsRead.set(key, await readLocalFacts(env, store, name))
    return factsRead.get(key)
  }
  const marker = async (name) => {
    if (!markerRead.has(name)) {
      let found = null
      try {
        found = await readMarker(env, path.join(root, "markers", name))
      } catch {
        found = null
      }
      markerRead.set(name, found)
    }
    return markerRead.get(name)
  }
  const requested = []
  for (const job of Object.keys(index).sort()) {
    if (!PATTERNS.jobId.test(job) || waiting.has(job) || settled.has(job)) continue
    let latest = null
    let needs = false
    const desks = []
    for (const store of stores) {
      for (const name of index[job]) {
        if (await heldBack(env, store, job, name)) continue
        const localFacts = await facts(store, name)
        if (localFacts === null || !SESSION_ID_V4.test(localFacts.session.id)) continue
        const binding = localFacts.jobs.find((bound) => bound.job === job)
        if (binding === undefined) continue
        latest = laterObservation(latest, binding)
        const logPath = await sessionLog(env, root, name)
        if ((await sessionNeedsLabels(env, { store, job, name, localFacts, evidence: briefEvidence(job, localFacts), logPath, receipts })) !== null) needs = true
        desks.push((await marker(name))?.desk_root)
      }
    }
    // A valid marker's desk is absolute or null; the first one named wins, else the caller's.
    const desk = desks.find((named) => typeof named === "string") ?? deskRoot
    if (!needs || latest === null || !TERMINAL.has(latest.status) || desk === null) continue
    await requestEvaluation(env, { job, deskRoot: desk, finishedAt: latest.at, requestedAt: now === null ? null : new Date(now).toISOString() })
    requested.push(job)
  }
  return { requested }
}
