// Published labels v1 (`desk.factory.labels/1`): the waste labels for one
// job's session.
//
// An independent evaluator (the `observer` agent, never the agent that did
// the work) reads a finished job's evidence and writes one labels file per
// session. It travels like facts: through the outbox, as a pull request to a
// public factory store, at `labels/<job>/<session id>.json`, and the store's
// CI gates it (`pipeline/validate-pr.js`). Like published facts it carries
// no person, machine, date or time of day, and no free text anywhere: every
// string is an enum member or a tightly bounded pattern.
//
// The shape is exact (any other key is `unknown_key`) and is walked by
// `schema.js`'s spec walker, so labels share the facts gates' engine, the
// canonical-bytes rule and the no-echo errors (`{ code, path }`, the path
// built only from schema field names and array indices).
//
//   - `job` is a job ID and `session` a version-4 session ID, as in
//     published facts.
//   - `evaluator.plugin_version` is a Desk version: `major.minor.patch`, each
//     of at most three digits, optionally followed by `-alpha.N`, `-beta.N`
//     or `-rc.N` with N of at most four digits. No other prerelease token is
//     allowed, so the field cannot carry a name or a date.
//   - `evaluator.model` uses published facts' own model-ID validator
//     (`published-schema.js`'s `modelIdField`): a token of at most 80
//     characters with no spaces, refused as `date` or `time` when it holds a
//     date or a time of day and as `credential_like` when it looks like a
//     secret.
//   - `evaluator.rubric` is the rubric's version number as a digit string,
//     1 to 999 with no leading zero, too short to hold a date or an epoch
//     value.
//   - Each stretch is `[start_ms, end_ms)` on the session clock, with
//     `start_ms < end_ms` (else `order`). Stretches are listed in start order
//     (else `order`) and never overlap (else `overlap`); touching ends and
//     gaps are fine.
//   - `class` is `value`, `support` or `muda`. `waste` is one of the eight
//     classic wastes for `muda` and `null` otherwise (else `inconsistent`).
//     `mura` (unevenness) and `muri` (overburden) are flags on the stretch.
//   - `caught` is optional: where the defect was caught (`in_task`,
//     `at_review` or `after_delivery`). Desk writes it on `defects` stretches
//     from the job's record; the evaluator never does.
//   - `evidence` is a non-empty list (else `empty`) of distinct (else
//     `duplicate`) `[start_ms, end_ms]` ranges with `start_ms <= end_ms`.
//     They are time ranges, not list positions, so labels stay valid when a
//     still-running session is re-derived and grows. Evidence may cite any
//     interval of the session, not only one inside its own stretch: a
//     defect stretch may rest on an earlier failed tool call, for example.
//   - `unavailable` lists what the evaluator could not read, from a closed
//     set of codes, none twice:
//       `session_log_missing`: the host's session log for this session was
//         gone or unreadable, so the labels rest on the facts alone.
//       `facts_missing`: the job's local facts for this session were missing,
//         so there is no evidence to cite and `stretches` must be empty
//         (else `inconsistent`). The store accepts such labels even when it
//         holds no facts file for the session.
//
// `checkLabelsAgainstFacts` is the store-side half: it compares
// already-valid labels with the session's already-valid published facts.
// The labels must name that session (`session_mismatch`) and a job its facts
// bind (`job_unbound`), every stretch must end within the session (`range`),
// and every evidence range must equal one interval's `start_ms` and `end_ms`
// exactly (`evidence_unmatched`).
//
// `evaluatorDowngrade` supports the store's replacement rule: a labels file
// may be replaced only by labels from an evaluator whose plugin version and
// rubric are both no lower than the ones it replaces.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { durationField, modelIdField, publicPatternField, SESSION_ID_V4 } from "./published-schema.js"
import {
  PATTERNS,
  addError,
  arrayField,
  booleanField,
  customField,
  enumField,
  isPlainObject,
  joinPath,
  nullableEnumField,
  objectField,
  patternField,
  validateCanonicalBytes,
  validateObject,
} from "./schema.js"

export const LABELS_SCHEMA = "desk.factory.labels/1"

export const LABEL_CLASSES = Object.freeze(["value", "support", "muda"])

export const LABEL_WASTES = Object.freeze([
  "defects",
  "overproduction",
  "waiting",
  "non_utilized_talent",
  "transportation",
  "inventory",
  "motion",
  "extra_processing",
])

/** The closed set of `unavailable` codes; see the header for their meaning. */
export const LABEL_UNAVAILABLE = Object.freeze(["session_log_missing", "facts_missing"])

/** Where a defect was caught, placed by Desk (`catch-point.js`), never written by the evaluator. */
export const LABEL_CAUGHT = Object.freeze(["in_task", "at_review", "after_delivery"])

export const LABEL_LIMITS = Object.freeze({
  stretches: 10000,
  evidence: 1000,
})

const LABELS_SCHEMA_PATTERN = /^desk\.factory\.labels\/1$/u
const DESK_VERSION = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(?:-(alpha|beta|rc)\.([0-9]{1,4}))?$/u
const RUBRIC = /^[1-9][0-9]{0,2}$/u
const STAGES = Object.freeze(["alpha", "beta", "rc"])

// One `[start_ms, end_ms]` evidence range: exactly two durations, in order.
function checkEvidenceRange(value, path, errors) {
  if (!Array.isArray(value) || value.length !== 2) {
    addError(errors, "type", path)
    return false
  }
  const field = durationField()
  const scratch = []
  if (!value.every((item) => field.check(item, path, scratch))) {
    addError(errors, scratch[0].code, path)
    return false
  }
  if (value[1] < value[0]) {
    addError(errors, "order", path)
    return false
  }
  return true
}

const EVALUATOR = {
  plugin_version: patternField(DESK_VERSION),
  model: modelIdField(),
  rubric: patternField(RUBRIC),
}

// `caught` is optional: a stretch carries it only when Desk placed it, so it is added to the stretch's spec only when present.
const CAUGHT = { caught: enumField(LABEL_CAUGHT) }

const STRETCH = {
  start_ms: durationField(),
  end_ms: durationField(),
  class: enumField(LABEL_CLASSES),
  waste: nullableEnumField(LABEL_WASTES),
  mura: booleanField(),
  muri: booleanField(),
  evidence: arrayField(customField(checkEvidenceRange), LABEL_LIMITS.evidence),
}

function stretchCheck(value, path, results, errors) {
  if (results.start_ms === true && results.end_ms === true && value.end_ms <= value.start_ms) {
    addError(errors, "order", joinPath(path, "end_ms"))
  }
  if (results.class === true && results.waste === true && (value.class === "muda") === (value.waste === null)) {
    addError(errors, "inconsistent", joinPath(path, "waste"))
  }
  if (Array.isArray(results.evidence)) {
    if (value.evidence.length === 0) addError(errors, "empty", joinPath(path, "evidence"))
    const seen = new Set()
    value.evidence.forEach((range, index) => {
      if (results.evidence[index] !== true) return
      const key = `${range[0]}:${range[1]}`
      if (seen.has(key)) addError(errors, "duplicate", joinPath(joinPath(path, "evidence"), index))
      seen.add(key)
    })
  }
}

const TOP = {
  schema: patternField(LABELS_SCHEMA_PATTERN),
  job: publicPatternField(PATTERNS.jobId),
  session: publicPatternField(SESSION_ID_V4),
  evaluator: objectField(EVALUATOR),
  stretches: arrayField(objectField((value) => (Object.hasOwn(value, "caught") ? { ...STRETCH, ...CAUGHT } : STRETCH), stretchCheck), LABEL_LIMITS.stretches),
  unavailable: arrayField(enumField(LABEL_UNAVAILABLE), LABEL_UNAVAILABLE.length),
}

// For the structural test: every allowed key carries a real check.
export const __LABEL_SPECS__ = Object.freeze({
  top: TOP,
  evaluator: EVALUATOR,
  stretch: { ...STRETCH, ...CAUGHT },
})

// A stretch whose own start and end are sound and in order.
function soundStretch(value, result) {
  return isPlainObject(result) && result.start_ms === true && result.end_ms === true && value.start_ms < value.end_ms
}

/**
 * `validateLabels(value) -> { ok, errors }`: the labels gate for an
 * already-parsed value, on its own. Same contract as `validatePublished`.
 */
export function validateLabels(value) {
  const errors = []
  const results = validateObject(value, "", TOP, errors)
  if (results === undefined) return { ok: false, errors }

  // Stretches in start order, none overlapping any earlier one. Unsound
  // stretches are skipped, so one bad stretch is one error.
  if (Array.isArray(results.stretches)) {
    let previous = null
    value.stretches.forEach((stretch, index) => {
      if (!soundStretch(stretch, results.stretches[index])) return
      if (previous !== null && stretch.start_ms < previous.start) addError(errors, "order", `stretches.${index}`)
      else if (previous !== null && stretch.start_ms < previous.end) addError(errors, "overlap", `stretches.${index}`)
      previous = { start: stretch.start_ms, end: Math.max(previous?.end ?? 0, stretch.end_ms) }
    })
  }

  if (Array.isArray(results.unavailable)) {
    const seen = new Set()
    value.unavailable.forEach((code, index) => {
      if (results.unavailable[index] !== true) return
      if (seen.has(code)) addError(errors, "duplicate", `unavailable.${index}`)
      seen.add(code)
    })
    // Without the job's facts there is no evidence to cite.
    if (seen.has("facts_missing") && Array.isArray(value.stretches) && value.stretches.length > 0) addError(errors, "inconsistent", "stretches")
  }

  return { ok: errors.length === 0, errors }
}

/** `validateLabelsBytes(buffer) -> { ok, errors }`: the size cap, the canonical-bytes rule, then `validateLabels`. */
export function validateLabelsBytes(buffer) {
  return validateCanonicalBytes(buffer, validateLabels)
}

/**
 * `checkLabelsAgainstFacts(labels, facts) -> { ok, errors }`: labels that
 * passed `validateLabels` against the session's published facts, which
 * passed `validatePublished`. See the header for the codes.
 */
export function checkLabelsAgainstFacts(labels, facts) {
  const errors = []
  if (labels.session !== facts.session.id) addError(errors, "session_mismatch", "session")
  if (!facts.jobs.some((job) => job.job === labels.job)) addError(errors, "job_unbound", "job")
  const intervals = new Set(facts.intervals.map((interval) => `${interval.start_ms}:${interval.end_ms}`))
  labels.stretches.forEach((stretch, index) => {
    if (stretch.end_ms > facts.session.duration_ms) addError(errors, "range", `stretches.${index}.end_ms`)
    stretch.evidence.forEach((range, rangeIndex) => {
      if (!intervals.has(`${range[0]}:${range[1]}`)) addError(errors, "evidence_unmatched", `stretches.${index}.evidence.${rangeIndex}`)
    })
  })
  return { ok: errors.length === 0, errors }
}

// A Desk version as a comparable tuple; a release sorts after its prereleases.
function versionTuple(version) {
  const [, major, minor, patch, stage, number] = DESK_VERSION.exec(version)
  return [Number(major), Number(minor), Number(patch), stage === undefined ? STAGES.length : STAGES.indexOf(stage), Number(number ?? 0)]
}

function compareTuples(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

/**
 * `evaluatorDowngrade(previous, current) -> boolean`: whether valid labels
 * `current` come from an older evaluator than valid labels `previous`, by
 * plugin version or by rubric.
 */
export function evaluatorDowngrade(previous, current) {
  return compareTuples(versionTuple(current.evaluator.plugin_version), versionTuple(previous.evaluator.plugin_version)) < 0
    || Number(current.evaluator.rubric) < Number(previous.evaluator.rubric)
}
