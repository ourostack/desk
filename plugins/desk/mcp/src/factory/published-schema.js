// Published facts (`desk.factory.published/4`; `/1`, `/2` and `/3` files are still read): the public gate.
//
// A published facts file is the only thing that ever leaves this machine for
// a factory store, and the stores are public. It says how the work went and
// nothing about who did it: durations and offsets, and one date only, each
// job's UTC finish day (`jobs[].finished_on`, from `/4`); never another date,
// a time of day or an epoch value, and never a contributor, operator,
// machine, host name, desk path, account or branch. Only references to
// public repositories appear; the rest are counted in `refs.private`. A
// plugin is named only when it was installed from a public repository or the
// store is not public; the rest are counted in `refs.private.plugins`, an
// optional count that files published before it existed omit.
// `publish.js`'s `toPublished` produces this form from local facts, and the
// stores' CI runs `validatePublishedBytes` on every intake file.
//
// The shape is exact: any other key is `unknown_key`. It is walked by
// `schema.js`'s own spec walker (`validateObject` and the field primitives),
// so the published and local gates share one validator engine, one set of
// enums, patterns and caps, the same canonical-bytes rule and the same
// no-echo errors (`{ code, path }`, the path built only from schema field
// names and array indices). On top of the local rules:
//   - Every pattern-checked string is also refused, with code `date`, when it
//     contains a date shape (`DATE_SHAPE`), and with code `time` when it
//     contains a time of day (`TIME_SHAPE`). Model IDs, plugin names and
//     repository names are the patterns loose enough to hold one.
//   - Those free tokens (model IDs, plugin names, and PR and commit
//     repository names) are also refused, with code `credential_like`, when
//     they look like a secret (`credential.js`: a token prefix such as
//     `ghp_` or `sk-`, a 16+ character hex or letter-and-digit run, a
//     password value or an IPv4-looking run). Every published model field,
//     here and in labels (`label-schema.js`), uses the one `modelIdField`.
//     The rule can refuse a real name: a repository such as
//     `acme/build2026Q3release` holds a 16-character letter-and-digit run.
//   - `session.id` is a version-4 (random) UUID. Other versions can carry a
//     timestamp (v1, v6, v7) or a machine identifier (v1), and the ID is
//     also the file name (review I1, fix round 2).
//   - `session.duration_ms` is a safe non-negative integer of at most
//     `PUBLISHED_LIMITS.maxOffsetMs`, and `intervals[].start_ms` and `end_ms`
//     are safe non-negative integers with `start_ms <= end_ms <=
//     duration_ms`. The cap means a bogus early session start (one log line
//     dated 1970, say) can never publish interval offsets that are epoch
//     values (review Critical, fix round 2).
//   - `unavailable` holds no entry twice, and `refs` no PR (repository and
//     number) or commit (SHA) twice.
//   - A file whose `unavailable` says `{job_offsets, desk_public}` carries no
//     job timing: every job's `session_offset_ms` and `observed.offset_ms`
//     are `null` and its `transitions` empty, else `inconsistent` names the
//     job (fix round 3). The store's CI then does not have to trust the
//     flush's answer about the desk.
//   - A job's optional `segments` (the controller's spans of the session,
//     in milliseconds from its start), a PR's optional `at_ms` and a
//     commit's optional `at_ms` never run past `session.duration_ms`, else
//     `range`. A file marked `{job_offsets, desk_public}` carries none of
//     them, else `inconsistent`: with a public desk's commit history, a
//     public PR's creation time or a public commit's own date, they would
//     date the session.
//   - Two things are `/3` only, and a `/1` or `/2` file carrying either is
//     `inconsistent`: a commit's `at_ms`, and an `unavailable` entry for the
//     field `outcomes` (a session whose outcome list was cut at
//     `LIMITS.outcomes`). `/1` and `/2` files without them stay valid, so
//     records already in a store keep passing. A job carries `segments` only when its
//     `agents` lists worker 0, else `inconsistent`.
//   - Four keys are `/4` only, and each is required in a `/4` file and
//     `inconsistent` in an older one: a job's `finished_on` and
//     `finished_basis`, a PR's `created` and a human wait's `stop`.
//   - `jobs[].finished_on` is the one key exempt from the `date` refusal. It
//     is exactly `YYYY-MM-DD`, a real calendar day (else `pattern`) no earlier
//     than `FINISHED_ON_MIN` (else `range`), or `null`. `finished_basis` is
//     `transition`, `card_updated` or `null`, and is `null` exactly when
//     `finished_on` is (else `inconsistent`). A day sits only on a job whose
//     card was observed `done` or `cancelled` (else `inconsistent` at
//     `finished_on`), and its basis names a source the file itself carries:
//     a timed transition into that status, or a timed observation (else
//     `inconsistent` at `finished_basis`). A `{job_offsets, desk_public}`
//     file carries no finish day, and no PR in it says `created: true`. The store's intake also refuses a day
//     after the day it runs (`pipeline/validate-pr.js`, `future`).
//   - `intervals[].stop` exists only on a `human_wait` interval (elsewhere it
//     is an `unknown_key`) and holds `end` (`ENUMS.stopEnd`), and `asks` and
//     `pending_agents` as `true`, `false` or `null`: no text, no tool name.
//   - `jobs[].session_offset_ms` and every `offset_ms` are safe integers
//     (signed: a session may begin before its task card exists) or `null`,
//     and at most `PUBLISHED_LIMITS.maxOffsetMs` (ten years) either way. The
//     bound is less than the time since 1970, so an offset from a zeroed or
//     otherwise bogus creation time can never carry an epoch value out.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import {
  AGENT_SPEC,
  agentFields,
  COUNTS_SPEC,
  ENUMS,
  LIMITS,
  MODEL_SPEC,
  OUTCOME_SPEC,
  OUTCOME_STATE_CODES,
  REFUSAL_REASON_CODES,
  RETURN_SPEC,
  OUTCOME_SINCE_CODES,
  OUTCOME_OPTIONAL as OUTCOME_OPTIONAL_LOCAL,
  PATTERNS,
  PR_SPEC,
  __SPECS__ as LOCAL_SPECS,
  prFields,
  jobFields,
  addError,
  arrayField,
  booleanField,
  STOP_SPEC,
  checkAgentReferences,
  checkBasis,
  checkSegmentAgents,
  checkSessionBounds,
  commitFields,
  customField,
  enumField,
  isPlainObject,
  joinPath,
  leaf,
  nonNegIntField,
  nullableEnumField,
  nullableObjectField,
  objectField,
  patternField,
  rangeIntField,
  validateCanonicalBytes,
  validateObject,
} from "./schema.js"
import { isCredentialLike } from "./credential.js"

export const PUBLISHED_SCHEMA = "desk.factory.published/4"

/** The schema the transform writes for a session with `/3`-only content until it fills the `/4` keys. */
export const PUBLISHED_SCHEMA_V3 = "desk.factory.published/3"

/** Every published schema value a reader accepts: the legacy `/1`, `/2` and `/3`, and the current one. */
export const PUBLISHED_SCHEMAS = Object.freeze(["desk.factory.published/1", "desk.factory.published/2", PUBLISHED_SCHEMA_V3, PUBLISHED_SCHEMA])

/** The earliest finish day a published job may carry. */
const FINISHED_ON_MIN = "2025-01-01"

/** An ISO calendar date anywhere in a string. */
export const DATE_SHAPE = /\d{4}-\d{2}-\d{2}/u

/** A time of day (`08:30`) anywhere in a string. */
export const TIME_SHAPE = /\d{2}:\d{2}/u

/** A version-4 UUID: the only session ID a published file may carry. */
export const SESSION_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export const PUBLISHED_LIMITS = Object.freeze({
  maxOffsetMs: 3650 * 24 * 60 * 60 * 1000,
})

const PUBLISHED_SCHEMA_PATTERN = /^desk\.factory\.published\/[1234]$/u

// The `/4` keys a level adds: every one in a `/4` file (`ctx.v4`), else only those the value carries, so an older file that carries one is named `inconsistent` rather than `unknown_key`.
const v4Keys = (value, ctx, fields) => Object.fromEntries(Object.entries(fields).filter(([key]) => ctx?.v4 === true || Object.hasOwn(value, key)))

const FINISHED_ON = /^(\d{4})-(\d{2})-(\d{2})$/u

// Whether `text` is exactly `YYYY-MM-DD` and names a real day of the proleptic Gregorian calendar.
function isCalendarDay(text) {
  const match = FINISHED_ON.exec(text)
  if (match === null) return false
  const [year, month, day] = match.slice(1).map(Number)
  const date = new Date(0)
  date.setUTCFullYear(year, month - 1, day)
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

// `jobs[].finished_on`: a UTC calendar day or `null`. Not a `publicPatternField`: this is the one key whose value is a date.
const finishedOnField = () => leaf((value, path, errors) => {
  if (value === null) return true
  if (typeof value !== "string") {
    addError(errors, "type", path)
    return false
  }
  if (!isCalendarDay(value)) {
    addError(errors, "pattern", path)
    return false
  }
  if (value < FINISHED_ON_MIN) {
    addError(errors, "range", path)
    return false
  }
  return true
})

const DATE_PARTS = /(\d{4})-(\d{2})-(\d{2})/u
const TIME_PARTS = /(\d{2}):(\d{2})/u

/**
 * Removes the hyphens of every ISO date and the colons of every time of day
 * in an identifier, including one that an earlier removal uncovers
 * (`x-2024-08-06-01-02`, `m:08:30:00`).
 */
export function scrub(id) {
  let text = id
  // Each pass removes at least one character, so this ends.
  while (DATE_SHAPE.test(text) || TIME_SHAPE.test(text)) text = text.replace(DATE_PARTS, "$1$2$3").replace(TIME_PARTS, "$1$2")
  return text
}

/** Whether a free token passes the public rules `publicTokenField` applies beyond its pattern: no date, no time of day, not credential-like. Publishing asks this so it never emits a value the validator rejects. */
export const publishableToken = (value) => tokenRefusal(value) === null

// The one rule list: why a free token is unfit to publish (`date`, `time` or `credential_like`), or `null`.
function tokenRefusal(value) {
  return shapeRefusal(value) ?? (isCredentialLike(value) ? "credential_like" : null)
}

// `date` or `time` when the value carries an ISO date or a time of day, else `null`.
function shapeRefusal(value) {
  if (DATE_SHAPE.test(value)) return "date"
  return TIME_SHAPE.test(value) ? "time" : null
}

// A pattern-checked string that also passes `refusal` (a function from a value to a refusal code or `null`).
function refusingField(pattern, refusal) {
  const base = patternField(pattern)
  return leaf((value, path, errors) => {
    if (!base.check(value, path, errors)) return false
    const reason = refusal(value)
    if (reason !== null) {
      addError(errors, reason, path)
      return false
    }
    return true
  })
}

// A pattern-checked string that must also carry no date and no time of day.
// Exported for `label-schema.js`, which applies the same public rules.
export const publicPatternField = (pattern) => refusingField(pattern, shapeRefusal)

// A free token (a name chosen elsewhere, not a fixed-format ID): the public
// rules, then no credential-shaped value (`credential.js`).
const publicTokenField = (pattern) => refusingField(pattern, tokenRefusal)

/** The one model-ID validator for every published model field, in facts and labels alike. */
export const modelIdField = () => publicTokenField(PATTERNS.modelId)

// A duration in milliseconds, at most the offset cap.
export const durationField = () => leaf((value, path, errors) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    addError(errors, "integer", path)
    return false
  }
  if (value > PUBLISHED_LIMITS.maxOffsetMs) {
    addError(errors, "range", path)
    return false
  }
  return true
})

// A signed offset in milliseconds, or `null`.
const offsetField = () => leaf((value, path, errors) => {
  if (value === null) return true
  if (!Number.isSafeInteger(value)) {
    addError(errors, "integer", path)
    return false
  }
  if (Math.abs(value) > PUBLISHED_LIMITS.maxOffsetMs) {
    addError(errors, "range", path)
    return false
  }
  return true
})

// The levels shaped as in the local schema reuse its spec objects, with each
// pattern-checked string replaced by its date-refusing form.

// A published plugin is a name and a version only: the local install source
// decides whether the plugin is named at all and is never published.
const PLUGIN = {
  name: publicTokenField(PATTERNS.pluginName),
  version: publicPatternField(PATTERNS.semver),
}

const MODEL = {
  ...MODEL_SPEC,
  id: modelIdField(),
}

const AGENT = {
  ...AGENT_SPEC,
  model: modelIdField(),
}

// A requested model carries the same public rules as a resolved one.
const publishedAgentFields = (value) => agentFields(value, AGENT, publicTokenField(PATTERNS.agentType), modelIdField())

const PR = {
  ...PR_SPEC,
  repo: publicTokenField(PATTERNS.prRepo),
}

// The optional worker attribution and time, as in the local form, and from `/4` whether the session created the PR.
function prFieldsPublished(value, ctx) {
  return { ...prFields(value), ...PR, ...v4Keys(value, ctx, { created: booleanField() }) }
}

// Unlike the local form, a published commit always names its repository.
const COMMIT = {
  repo: publicTokenField(PATTERNS.prRepo),
  sha: publicPatternField(PATTERNS.commitSha),
}

// `plugins` is optional, so files published before plugins were counted stay
// valid: the stores' CI validates every intake file with Desk's main branch.
function privateFields(value) {
  const fields = { prs: nonNegIntField(), commits: nonNegIntField() }
  if (Object.hasOwn(value, "plugins")) fields.plugins = nonNegIntField()
  return fields
}

const REFS = {
  prs: arrayField(objectField(prFieldsPublished), LIMITS.prs),
  commits: arrayField(objectField((value) => commitFields(value, COMMIT)), LIMITS.commits),
  private: objectField(privateFields),
}

const TRANSITION = {
  to: enumField(ENUMS.jobStatus),
  offset_ms: offsetField(),
}

const OBSERVED = {
  status: enumField(ENUMS.jobStatus),
  offset_ms: offsetField(),
}

const JOB = {
  job: publicPatternField(PATTERNS.jobId),
  basis: customField(checkBasis),
  session_offset_ms: offsetField(),
  transitions: arrayField(objectField(TRANSITION), LIMITS.jobTransitions),
  observed: nullableObjectField(OBSERVED),
}

// From `/4`: the UTC day the task finished and its source.
const FINISH = {
  finished_on: finishedOnField(),
  finished_basis: nullableEnumField(ENUMS.finishedBasis),
}

const publishedJobFields = (value, ctx) => jobFields(value, { ...JOB, ...v4Keys(value, ctx, FINISH) })

const UNAVAILABLE = {
  field: enumField(ENUMS.publishedUnavailableField),
  reason: enumField(ENUMS.unavailableReason),
}

const SESSION = {
  host: enumField(ENUMS.host),
  id: publicPatternField(SESSION_ID_V4),
  host_version: publicPatternField(PATTERNS.semver),
  entrypoint: enumField(ENUMS.entrypoint),
  duration_ms: durationField(),
  ended: booleanField(),
  end_reason: nullableEnumField(ENUMS.endReason),
}

// As in the local schema, `tool`/`outcome` exist only on tool intervals and
// `stop` only on human waits, so their presence elsewhere is an `unknown_key`.
function intervalFields(value, ctx) {
  const fields = {
    kind: enumField(ENUMS.intervalKind),
    agent: rangeIntField(0, 9999),
    start_ms: nonNegIntField(),
    end_ms: nonNegIntField(),
  }
  if (value.kind === "tool") {
    fields.tool = enumField(ENUMS.toolKind)
    fields.outcome = enumField(ENUMS.outcome)
  }
  if (value.kind === "human_wait") Object.assign(fields, v4Keys(value, ctx, { stop: objectField(STOP_SPEC) }))
  return fields
}

function intervalOrderCheck(value, path, results, errors) {
  if (results.start_ms && results.end_ms && value.end_ms < value.start_ms) addError(errors, "order", joinPath(path, "end_ms"))
}

const TOP = {
  schema: patternField(PUBLISHED_SCHEMA_PATTERN),
  session: objectField(SESSION),
  plugins: arrayField(objectField(PLUGIN), LIMITS.plugins),
  models: arrayField(objectField(MODEL), LIMITS.models),
  agents: arrayField(objectField(publishedAgentFields), LIMITS.agents),
  intervals: arrayField(objectField(intervalFields, intervalOrderCheck), LIMITS.intervals),
  counts: objectField(COUNTS_SPEC),
  refs: objectField(REFS),
  jobs: arrayField(objectField(publishedJobFields), LIMITS.jobs),
  unavailable: arrayField(objectField(UNAVAILABLE), LIMITS.unavailable),
}

// `outcomes[]`: a job's sign-off state as a published fact. The wait is a coarse class and never a time, so no entry carries a date, an exact wait or a local time key (any of them is `unknown_key`). These lists are `WAIT_CLASSES` and `OUTCOME_STATES` in `outcome.js`; a test compares them, because this module imports nothing from there.
const WAIT_CLASS_CODES = ["lt_1h", "lt_1d", "lt_7d", "ge_7d"]
const WAIT = {
  class: enumField(WAIT_CLASS_CODES),
  censored: booleanField(),
}
const OUTCOME = {
  job: publicPatternField(PATTERNS.jobId),
  rev: rangeIntField(0, 9999),
  state: enumField(OUTCOME_STATE_CODES),
  verified: OUTCOME_SPEC.verified,
  reason: nullableEnumField(REFUSAL_REASON_CODES),
  deliveries: rangeIntField(0, 9999),
  wait: nullableObjectField(WAIT),
}

// The optional keys of an outcome entry: the record's start and the returns, never the two milestone times.
const OUTCOME_OPTIONAL = {
  since: nullableEnumField(OUTCOME_SINCE_CODES),
  returns: arrayField(objectField(RETURN_SPEC), LIMITS.returns),
  returns_truncated: OUTCOME_OPTIONAL_LOCAL.returns_truncated,
  returns_unreadable: rangeIntField(1, 9999),
}
const outcomeFields = (value) => ({ ...OUTCOME, ...Object.fromEntries(Object.entries(OUTCOME_OPTIONAL).filter(([key]) => Object.hasOwn(value, key))) })

// The reasons that say there is no list: a host that records none, or a log with no such field.
const NO_LIST_REASONS = new Set(["host_does_not_record", "field_absent"])

// `human_turns[]`: one human prompt as an offset on the session clock, a basis, the gap and two size classes. The classes and basis are the local schema's own; the local `at` becomes `at_ms`, so a date or time of day can never be written. The offset is at most `session.duration_ms`, checked in `validatePublished`.
const HUMAN_TURN = {
  at_ms: durationField(),
  basis: LOCAL_SPECS.humanTurn.basis,
  window_ms: LOCAL_SPECS.humanTurn.window_ms,
  prompt_class: LOCAL_SPECS.humanTurn.prompt_class,
  output_class: LOCAL_SPECS.humanTurn.output_class,
}

// At most `LIMITS.humanTurns` turns; a first turn has a null window and any other a number, and the offsets never go back (the local schema's rules, on `at_ms`).
const humanTurnsField = () => {
  const list = arrayField(objectField(HUMAN_TURN), LIMITS.humanTurns)
  return leaf((value, path, errors, ctx) => {
    const results = list.check(value, path, errors, ctx)
    if (results === undefined) return results
    let previous = null
    value.forEach((entry, index) => {
      const own = results[index]
      if (own?.basis === true && own.window_ms === true && (entry.basis === "first") !== (entry.window_ms === null)) {
        addError(errors, "inconsistent", joinPath(path, `${index}.window_ms`))
      }
      if (own?.at_ms !== true) return
      if (previous !== null && entry.at_ms < previous) addError(errors, "order", joinPath(path, `${index}.at_ms`))
      previous = entry.at_ms
    })
    return results
  })
}

// The optional top-level keys, added only when the file carries them.
const topFields = (value) => ({
  ...TOP,
  ...(Object.hasOwn(value, "outcomes") ? { outcomes: arrayField(objectField(outcomeFields), LIMITS.outcomes) } : {}),
  ...(Object.hasOwn(value, "human_turns") ? { human_turns: humanTurnsField() } : {}),
})

// For the structural test: every allowed key carries a real check.
export const __PUBLISHED_SPECS__ = Object.freeze({
  top: TOP,
  session: SESSION,
  plugin: PLUGIN,
  model: MODEL,
  agent: AGENT,
  pr: PR,
  commit: commitFields({ at_ms: 0 }, COMMIT),
  private: privateFields({ plugins: 0 }),
  refs: REFS,
  transition: TRANSITION,
  observed: OBSERVED,
  job: JOB,
  unavailable: UNAVAILABLE,
  intervalTool: intervalFields({ kind: "tool" }),
  intervalOther: intervalFields({ kind: "turn" }),
  intervalWaitV4: intervalFields({ kind: "human_wait" }, { v4: true }),
  jobV4: publishedJobFields({}, { v4: true }),
  prV4: prFieldsPublished({}, { v4: true }),
  stop: STOP_SPEC,
  outcome: OUTCOME,
  wait: WAIT,
  return: RETURN_SPEC,
  outcomeOptional: OUTCOME_OPTIONAL,
  humanTurn: HUMAN_TURN,
})

/**
 * `validatePublished(value) -> { ok, errors }`: the public gate for an
 * already-parsed value. Same contract as `validateLocalFacts`.
 */
export function validatePublished(value) {
  const errors = []
  const v4 = isPlainObject(value) && value.schema === PUBLISHED_SCHEMA
  const results = validateObject(value, "", topFields, errors, { v4 })
  if (results === undefined) return { ok: false, errors }
  checkAgentReferences(value, results, errors)
  checkSegmentAgents(value, results, errors)

  // No entry or reference twice. Only items whose own fields are sound are
  // compared, and the later one is named.
  const noDuplicates = (list, itemResults, fields, keyOf, listPath) => {
    const seen = new Set()
    list.forEach((item, index) => {
      if (!fields.every((field) => itemResults[index]?.[field] === true)) return
      const key = keyOf(item)
      if (seen.has(key)) addError(errors, "duplicate", `${listPath}.${index}`)
      seen.add(key)
    })
  }
  if (results.unavailable) noDuplicates(value.unavailable, results.unavailable, ["field", "reason"], (item) => `${item.field}|${item.reason}`, "unavailable")
  // One outcome per job, named at the job as in the local form.
  if (results.outcomes) {
    const seenJobs = new Set()
    value.outcomes.forEach((entry, index) => {
      if (results.outcomes[index]?.job !== true) return
      if (seenJobs.has(entry.job)) addError(errors, "duplicate", `outcomes.${index}.job`)
      seenJobs.add(entry.job)
    })
  }
  const refs = results.refs
  if (refs?.prs) noDuplicates(value.refs.prs, refs.prs, ["repo", "number"], (item) => `${item.repo}#${item.number}`, "refs.prs")
  if (refs?.commits) noDuplicates(value.refs.commits, refs.commits, ["sha"], (item) => item.sha, "refs.commits")

  // A desk marked public publishes no job timing.
  const deskPublic = Boolean(results.unavailable) && value.unavailable.some((entry, index) =>
    results.unavailable[index]?.field === true && results.unavailable[index].reason === true && entry.field === "job_offsets" && entry.reason === "desk_public")
  if (deskPublic && results.jobs) {
    value.jobs.forEach((job, index) => {
      if (!isPlainObject(job)) return
      const timed = job.session_offset_ms !== null
        || Object.hasOwn(job, "segments")
        || (Array.isArray(job.transitions) && job.transitions.length > 0)
        || (isPlainObject(job.observed) && job.observed.offset_ms !== null)
        || (Object.hasOwn(job, "finished_on") && job.finished_on !== null)
        || (Object.hasOwn(job, "finished_basis") && job.finished_basis !== null)
      if (timed) addError(errors, "inconsistent", `jobs.${index}`)
    })
  }
  // Nor a PR or commit time, which with a public PR's creation time or a public commit's date would date the session. Nor a PR the session says it created: GitHub's public creation time of that PR is an instant inside the session, so a public desk publishes every PR as `created: false`.
  if (deskPublic && refs?.prs) {
    value.refs.prs.forEach((pr, index) => {
      if (isPlainObject(pr) && Object.hasOwn(pr, "at_ms")) addError(errors, "inconsistent", `refs.prs.${index}`)
      else if (isPlainObject(pr) && pr.created === true && refs.prs[index].created === true) addError(errors, "inconsistent", `refs.prs.${index}.created`)
    })
  }
  if (deskPublic && refs?.commits) {
    value.refs.commits.forEach((commit, index) => {
      if (isPlainObject(commit) && Object.hasOwn(commit, "at_ms")) addError(errors, "inconsistent", `refs.commits.${index}`)
    })
  }
  // A commit time and the outcomes flag are `/3` and later only.
  if (results.schema === true && value.schema !== PUBLISHED_SCHEMA && value.schema !== PUBLISHED_SCHEMA_V3) {
    if (refs?.commits) {
      value.refs.commits.forEach((commit, index) => {
        if (isPlainObject(commit) && Object.hasOwn(commit, "at_ms")) addError(errors, "inconsistent", `refs.commits.${index}.at_ms`)
      })
    }
    if (results.unavailable) {
      value.unavailable.forEach((entry, index) => {
        if (results.unavailable[index]?.field === true && entry.field === "outcomes") addError(errors, "inconsistent", `unavailable.${index}`)
      })
    }
  }

  if (results.schema === true && !v4) checkNoV4Keys(value, results, errors)
  if (v4) checkFinishDays(value, results, errors)

  // No interval, job segment, PR time or commit time may run past the session's end.
  // Checked only when the duration itself is sound, so one bad duration is
  // one error.
  checkSessionBounds(value, results, errors, results.session?.duration_ms === true ? value.session.duration_ms : null)
  // A list of human turns is a `/2` field, and it never sits beside a flag that says the host records none or the field is absent: either the list is the record or the flag is, not both.
  if (results.human_turns) {
    if (value.schema === PUBLISHED_SCHEMAS[0]) addError(errors, "inconsistent", "human_turns")
    if (results.unavailable) {
      value.unavailable.forEach((entry, index) => {
        if (results.unavailable[index]?.field === true && results.unavailable[index].reason === true && entry.field === "human_turns" && NO_LIST_REASONS.has(entry.reason)) {
          addError(errors, "inconsistent", `unavailable.${index}`)
        }
      })
    }
  }
  // A human turn never lies past the session's end either.
  if (results.session?.duration_ms === true && results.human_turns) {
    value.human_turns.forEach((turn, index) => {
      if (results.human_turns[index]?.at_ms === true && turn.at_ms > value.session.duration_ms) addError(errors, "range", `human_turns.${index}.at_ms`)
    })
  }
  if (results.session?.duration_ms === true && results.intervals) {
    value.intervals.forEach((item, index) => {
      if (results.intervals[index]?.end_ms === true && item.end_ms > value.session.duration_ms) {
        addError(errors, "range", `intervals.${index}.end_ms`)
      }
    })
  }

  return { ok: errors.length === 0, errors }
}

// Whether a field's own check passed: `true`, or a nested object whose every field passed.
const sound = (result) => result === true || (isPlainObject(result) && Object.values(result).every((entry) => entry === true))

// A `/4` key in an older file is `inconsistent`, named once: only when its own check passed.
function checkNoV4Keys(value, results, errors) {
  results.jobs?.forEach((jobResult, index) => {
    for (const key of Object.keys(FINISH)) if (sound(jobResult?.[key])) addError(errors, "inconsistent", `jobs.${index}.${key}`)
  })
  results.refs?.prs?.forEach((prResult, index) => {
    if (sound(prResult?.created)) addError(errors, "inconsistent", `refs.prs.${index}.created`)
  })
  results.intervals?.forEach((intervalResult, index) => {
    if (sound(intervalResult?.stop)) addError(errors, "inconsistent", `intervals.${index}.stop`)
  })
}

const TERMINAL = new Set(["done", "cancelled"])

// A finish day and its basis agree with each other and with the job's own status and timing. Checked only on jobs whose two keys passed their own checks.
function checkFinishDays(value, results, errors) {
  results.jobs?.forEach((jobResult, index) => {
    if (jobResult?.finished_on !== true || jobResult.finished_basis !== true) return
    const job = value.jobs[index]
    if ((job.finished_on === null) !== (job.finished_basis === null)) {
      addError(errors, "inconsistent", `jobs.${index}.finished_basis`)
      return
    }
    if (job.finished_on === null) return
    if (!isPlainObject(job.observed) || !TERMINAL.has(job.observed.status)) {
      addError(errors, "inconsistent", `jobs.${index}.finished_on`)
      return
    }
    const timed = (offset) => Number.isSafeInteger(offset)
    const source = job.finished_basis === "transition"
      ? Array.isArray(job.transitions) && job.transitions.some((transition) => isPlainObject(transition) && transition.to === job.observed.status && timed(transition.offset_ms))
      : timed(job.observed.offset_ms)
    if (!source) addError(errors, "inconsistent", `jobs.${index}.finished_basis`)
  })
}

/** `validatePublishedBytes(buffer) -> { ok, errors }`: the size cap, the canonical-bytes rule, then `validatePublished`. */
export function validatePublishedBytes(buffer) {
  return validateCanonicalBytes(buffer, validatePublished)
}
