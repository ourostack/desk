// Published facts v1 (`desk.factory.published/1`): the public gate.
//
// A published facts file is the only thing that ever leaves this machine for
// a factory store, and the stores are public. It says how the work went and
// nothing about who did it or when: durations and offsets only, never a
// date, a time of day or an epoch value, and never a contributor, operator,
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
  COUNTS_SPEC,
  ENUMS,
  LIMITS,
  MODEL_SPEC,
  PATTERNS,
  PR_SPEC,
  prFields,
  jobFields,
  addError,
  arrayField,
  booleanField,
  checkAgentReferences,
  checkBasis,
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

export const PUBLISHED_SCHEMA = "desk.factory.published/1"

/** An ISO calendar date anywhere in a string. */
export const DATE_SHAPE = /\d{4}-\d{2}-\d{2}/u

/** A time of day (`08:30`) anywhere in a string. */
export const TIME_SHAPE = /\d{2}:\d{2}/u

/** A version-4 UUID: the only session ID a published file may carry. */
export const SESSION_ID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

export const PUBLISHED_LIMITS = Object.freeze({
  maxOffsetMs: 3650 * 24 * 60 * 60 * 1000,
})

const PUBLISHED_SCHEMA_PATTERN = /^desk\.factory\.published\/1$/u

// A pattern-checked string that must also carry no date and no time of day.
// Exported for `label-schema.js`, which applies the same public rules.
export function publicPatternField(pattern) {
  const base = patternField(pattern)
  return leaf((value, path, errors) => {
    if (!base.check(value, path, errors)) return false
    if (DATE_SHAPE.test(value)) {
      addError(errors, "date", path)
      return false
    }
    if (TIME_SHAPE.test(value)) {
      addError(errors, "time", path)
      return false
    }
    return true
  })
}

// A free token (a name chosen elsewhere, not a fixed-format ID): the public
// rules, then no credential-shaped value (`credential.js`).
function publicTokenField(pattern) {
  const base = publicPatternField(pattern)
  return leaf((value, path, errors) => {
    if (!base.check(value, path, errors)) return false
    if (isCredentialLike(value)) {
      addError(errors, "credential_like", path)
      return false
    }
    return true
  })
}

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

const PR = {
  ...PR_SPEC,
  repo: publicTokenField(PATTERNS.prRepo),
}

// The optional worker attribution, as in the local form.
function prFieldsPublished(value) {
  return { ...prFields(value), ...PR }
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
  commits: arrayField(objectField(COMMIT), LIMITS.commits),
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

// As in the local schema, `tool`/`outcome` exist only on tool intervals, so
// their presence elsewhere is an `unknown_key`.
function intervalFields(value) {
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
  agents: arrayField(objectField(AGENT), LIMITS.agents),
  intervals: arrayField(objectField(intervalFields, intervalOrderCheck), LIMITS.intervals),
  counts: objectField(COUNTS_SPEC),
  refs: objectField(REFS),
  jobs: arrayField(objectField((value) => jobFields(value, JOB)), LIMITS.jobs),
  unavailable: arrayField(objectField(UNAVAILABLE), LIMITS.unavailable),
}

// For the structural test: every allowed key carries a real check.
export const __PUBLISHED_SPECS__ = Object.freeze({
  top: TOP,
  session: SESSION,
  plugin: PLUGIN,
  model: MODEL,
  agent: AGENT,
  pr: PR,
  commit: COMMIT,
  private: privateFields({ plugins: 0 }),
  refs: REFS,
  transition: TRANSITION,
  observed: OBSERVED,
  job: JOB,
  unavailable: UNAVAILABLE,
  intervalTool: intervalFields({ kind: "tool" }),
  intervalOther: intervalFields({ kind: "turn" }),
})

/**
 * `validatePublished(value) -> { ok, errors }`: the public gate for an
 * already-parsed value. Same contract as `validateLocalFacts`.
 */
export function validatePublished(value) {
  const errors = []
  const results = validateObject(value, "", TOP, errors)
  if (results === undefined) return { ok: false, errors }
  checkAgentReferences(value, results, errors)

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
        || (Array.isArray(job.transitions) && job.transitions.length > 0)
        || (isPlainObject(job.observed) && job.observed.offset_ms !== null)
      if (timed) addError(errors, "inconsistent", `jobs.${index}`)
    })
  }

  // No interval may run past the session's end. Checked only when the
  // duration itself is sound, so one bad duration is one error.
  if (results.session?.duration_ms === true && results.intervals) {
    value.intervals.forEach((item, index) => {
      if (results.intervals[index]?.end_ms === true && item.end_ms > value.session.duration_ms) {
        addError(errors, "range", `intervals.${index}.end_ms`)
      }
    })
  }

  return { ok: errors.length === 0, errors }
}

/** `validatePublishedBytes(buffer) -> { ok, errors }`: the size cap, the canonical-bytes rule, then `validatePublished`. */
export function validatePublishedBytes(buffer) {
  return validateCanonicalBytes(buffer, validatePublished)
}
