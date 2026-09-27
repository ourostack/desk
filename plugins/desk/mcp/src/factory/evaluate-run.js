// The waste evaluator's local half (spec §6, classification): what Desk
// hands a fresh `desk:observer` when a task reaches `done`, and the check
// its answer must pass before it becomes local labels.
//
// The evaluator is never the agent that did the work and never sees that
// agent's conversation context: it gets one bounded brief per session and
// reads the evidence the brief points at. A brief (`desk.factory.evaluator-
// brief/1`) holds:
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
//   - `unavailable`: `session_log_missing` and `facts_missing` as they apply;
//   - `output`: where the evaluator writes its labels.
//
// `acceptEvaluation(brief, bytes)` is the check. The answer must be JSON of
// at most the facts size cap and pass `validateLabels`; it must name the
// brief's job and session and carry the brief's evaluator version and rubric
// (`job_mismatch`, `session_mismatch`, `evaluator_mismatch`); it must declare
// everything the brief says is unavailable and never declare facts missing
// that the brief holds (`inconsistent`); and it must pass
// `checkLabelsAgainstFacts` against the brief's facts (`range`,
// `evidence_unmatched`). Errors are `{ code, path }` only, as in every
// factory gate, so nothing the evaluator wrote is ever echoed. Accepted
// labels are rebuilt from the parsed value, so formatting and a duplicated
// key's shadowed value are dropped.
//
// `prepareEvaluation(env, { job, pluginVersion })` writes a brief for each
// of the job's sessions (from the jobs index) that a store with consent
// holds, and `acceptEvaluations(env, { job })` checks each answer against
// its brief and writes accepted labels to the outbox (`writeLocalLabels`),
// clearing the brief. A rejected answer stays where it is, beside its brief,
// for another try; it never enters the outbox. The brief is the snapshot the
// evaluator worked from, so a session that grew since is checked against
// what the evaluator saw; the store's own gate checks the labels again
// against the facts it holds.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import * as path from "node:path"
import { promises as fsp } from "node:fs"

import { checkLabelsAgainstFacts, validateLabels } from "./label-schema.js"
import {
  clearEvaluation,
  evaluationPaths,
  factoryStateRoot,
  listEvaluationBriefs,
  readConsent,
  readEvaluationOutput,
  readJobsIndex,
  readLocalFacts,
  readMarker,
  writeEvaluationBrief,
  writeLocalLabels,
} from "./outbox.js"
import { publishedClock } from "./publish.js"
import { LIMITS, PATTERNS, isPlainObject, validateLocalFacts } from "./schema.js"

export const BRIEF_SCHEMA = "desk.factory.evaluator-brief/1"
export const EVALUATOR_SKILL = "desk:factory-evaluator"
/** The rubric `skills/factory-evaluator/SKILL.md` states; labels carry it as `evaluator.rubric`. */
export const RUBRIC_VERSION = "1"

const DESK_VERSION = /^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}(?:-(?:alpha|beta|rc)\.[0-9]{1,4})?$/u

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

  const { clock, reason } = publishedClock(localFacts)
  if (reason === "session_id_not_v4") return null
  const unavailable = []
  if (logPath === null) unavailable.push("session_log_missing")
  if (clock === null) unavailable.push("facts_missing")
  return {
    schema: BRIEF_SCHEMA,
    skill: EVALUATOR_SKILL,
    job,
    session: { host: localFacts.session.host, id: localFacts.session.id },
    evaluator: { plugin_version: pluginVersion, rubric: RUBRIC_VERSION },
    session_log: logPath,
    clock_origin: clock === null ? null : localFacts.session.started_at,
    facts: clock === null ? null : { ...clock, counts: structuredClone(localFacts.counts) },
    unavailable,
    output: outputPath,
  }
}

const rejected = (errors) => ({ ok: false, errors })

/**
 * `acceptEvaluation(brief, bytes) -> { ok: true, errors: [], labels } |
 * { ok: false, errors }`: the evaluator's answer for `brief` (a value
 * `buildEvaluatorBrief` returned), checked as the header describes. `bytes`
 * is a `Buffer` or a string; anything else is a caller bug.
 */
export function acceptEvaluation(brief, bytes) {
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

  const identity = []
  if (value.job !== brief.job) identity.push({ code: "job_mismatch", path: "job" })
  if (value.session !== brief.session.id) identity.push({ code: "session_mismatch", path: "session" })
  if (value.evaluator.plugin_version !== brief.evaluator.plugin_version) identity.push({ code: "evaluator_mismatch", path: "evaluator.plugin_version" })
  if (value.evaluator.rubric !== brief.evaluator.rubric) identity.push({ code: "evaluator_mismatch", path: "evaluator.rubric" })
  if (identity.length > 0) return rejected(identity)

  const undeclared = brief.unavailable.some((code) => !value.unavailable.includes(code))
  const falselyMissing = brief.facts !== null && value.unavailable.includes("facts_missing")
  if (undeclared || falselyMissing) return rejected([{ code: "inconsistent", path: "unavailable" }])

  if (brief.facts !== null) {
    const facts = { session: { id: brief.session.id, duration_ms: brief.facts.duration_ms }, jobs: [{ job: brief.job }], intervals: brief.facts.intervals }
    const against = checkLabelsAgainstFacts(value, facts)
    if (!against.ok) return rejected(against.errors)
  }

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
    })),
    unavailable: [...value.unavailable],
  }
  return { ok: true, errors: [], labels }
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

/**
 * `prepareEvaluation(env, { job, pluginVersion }) -> { result, job, briefs }`:
 * `result` is `ready` with the brief paths, `not_opted_in` when no store has
 * consent, or `no_sessions` when no consented store holds a session of the
 * job that could be published.
 */
export async function prepareEvaluation(env, { job, pluginVersion }) {
  if (typeof job !== "string" || !PATTERNS.jobId.test(job)) throw new TypeError("prepareEvaluation: job must be a job ID")
  const consent = await readConsent(env)
  const stores = Object.keys(consent.stores).filter((store) => consent.stores[store].contribute === true).sort()
  if (stores.length === 0) return { result: "not_opted_in", job, briefs: [] }
  const root = await factoryStateRoot(env)
  const names = (await readJobsIndex(env))[job] ?? []
  const briefs = []
  for (const store of stores) {
    for (const name of names) {
      const localFacts = await readLocalFacts(env, store, name)
      if (localFacts === null) continue
      const paths = await evaluationPaths(env, { job, store, name })
      const brief = buildEvaluatorBrief({ job, localFacts, logPath: await sessionLog(env, root, name), outputPath: paths.output, pluginVersion })
      if (brief === null) continue
      briefs.push(await writeEvaluationBrief(env, { job, store, name, brief }))
    }
  }
  return { result: briefs.length > 0 ? "ready" : "no_sessions", job, briefs }
}

/**
 * `acceptEvaluations(env, { job }) -> { job, sessions: [{ session, result,
 * errors? }] }`: for each brief of `job`, `missing` (no answer yet),
 * `rejected` with `{ code, path }` errors, `accepted` (written to the outbox,
 * brief and answer cleared), `not_opted_in` (the store's consent was
 * withdrawn; nothing written) or `invalid_brief` (the brief file no longer
 * names this job and session; run `prepareEvaluation` again).
 */
export async function acceptEvaluations(env, { job }) {
  const sessions = []
  for (const { store, name, brief, output } of await listEvaluationBriefs(env, job)) {
    // The session comes from the brief's file name, which the listing checked.
    const session = name.slice(-".json".length - 36, -".json".length)
    if (!isPlainObject(brief) || brief.schema !== BRIEF_SCHEMA || brief.job !== job || `${brief.session?.host}-${brief.session?.id}.json` !== name) {
      sessions.push({ session, result: "invalid_brief" })
      continue
    }
    const bytes = await readEvaluationOutput(env, output)
    if (bytes === null) {
      sessions.push({ session, result: "missing" })
      continue
    }
    const checked = acceptEvaluation(brief, bytes)
    if (!checked.ok) {
      sessions.push({ session, result: "rejected", errors: checked.errors })
      continue
    }
    const written = await writeLocalLabels(env, store, checked.labels)
    if (!written.written) {
      sessions.push({ session, result: "not_opted_in" })
      continue
    }
    await clearEvaluation(env, { job, store, name })
    sessions.push({ session, result: "accepted" })
  }
  return { job, sessions }
}
