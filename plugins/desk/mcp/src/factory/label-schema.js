// Published labels (`desk.factory.labels/3`; `/1` and `/2` files are still
// read): the waste labels for one job's session, and why its agent stopped.
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
//   - `/2` adds, on every stretch, the evaluator's `confidence` in that
//     label (`high`, `medium` or `low`) and the `evaluator_version` that
//     assigned it (the same shape as `evaluator.plugin_version`, and never
//     newer than it, else `inconsistent`). `/2` also allows the label
//     "could not tell": `class: "unknown"` with `waste: "unknown"`, each only
//     with the other (else `inconsistent`). It is not muda: the rollups keep
//     it as its own row, in labeled time but out of every waste total. A `/1`
//     file has none of these (a `/2` key is `unknown_key`, `unknown` is not
//     an enum member) and stays valid as it is.
//   - `/3` adds `stops`, required in a `/3` file and an `unknown_key` in an
//     older one: why the agent stopped before each human wait the evaluator
//     classified. A stop is `{ wait, why, confidence, evaluator_version }`:
//     `wait` is the `[start_ms, end_ms]` of one `human_wait` interval, with
//     `start_ms <= end_ms` (else `order`); `why` is one of `LABEL_STOP_WHY`
//     (`decision`, `approval`, `acceptance`, `question`, `stopped_short`, or
//     `unknown` for "could not tell"); `confidence` and `evaluator_version`
//     are as on a `/2` stretch (a version newer than the file's evaluator is
//     `inconsistent`). Stops are listed in wait order (else `order`), at most
//     one per wait (else `duplicate`), and a `facts_missing` file has none
//     (else `inconsistent`). Stops are not stretches: they describe a wait,
//     which is idle time, and never enter class or waste totals. The causes a
//     rule decides from the wait's stop facts (`STOP_RULES`: an error or limit,
//     an interrupt, an open question or plan tool) are never the evaluator's,
//     so they are not `why` values.
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
// exactly (`evidence_unmatched`). Every stop's wait must end within the
// session (`range`) and equal one `human_wait` interval's `start_ms` and
// `end_ms` exactly (`evidence_unmatched`), and a stop on a wait whose
// `stop.end` a rule already decides (`STOP_RULES`) is `inconsistent` at its
// `why`. Facts from before `/4` carry no stop facts, so no rule decides their
// waits.
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

export const LABELS_SCHEMA = "desk.factory.labels/3"

/** The labels form before stops: confidence, versions and "could not tell" on stretches only. */
export const LABELS_SCHEMA_V2 = "desk.factory.labels/2"

/** Every labels schema value a reader accepts: the legacy `/1` and `/2`, and the current one. */
export const LABELS_SCHEMAS = Object.freeze(["desk.factory.labels/1", LABELS_SCHEMA_V2, LABELS_SCHEMA])

/** Why the agent stopped before a human wait, as the evaluator classifies it (`/3` `stops[].why`); `unknown` is "could not tell". */
export const LABEL_STOP_WHY = Object.freeze(["decision", "approval", "acceptance", "question", "stopped_short", "unknown"])

/** The stop ends (`intervals[kind=human_wait].stop.end`) a rule classifies, and the class each gets; the evaluator never labels these waits. */
export const STOP_RULES = Object.freeze({
  max_tokens: "error_limit",
  rate_limit: "error_limit",
  api_error: "error_limit",
  refusal: "error_limit",
  interrupted: "interrupted",
  ask_question: "question",
  ask_plan: "approval",
})

export const LABEL_CLASSES = Object.freeze(["value", "support", "muda"])

/** The `/2` label for time the evaluator looked at and could not tell: its class and its waste row. */
export const UNKNOWN_LABEL = "unknown"

/** How sure the evaluator is of one `/2` label. */
export const LABEL_CONFIDENCE = Object.freeze(["high", "medium", "low"])

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
const LABEL_CAUGHT = Object.freeze(["in_task", "at_review", "after_delivery"])

export const LABEL_LIMITS = Object.freeze({
  stretches: 10000,
  evidence: 1000,
  stops: 10000,
})

/**
 * The reason codes this Desk's own check gives a labels file: `invalid` (the publishing transform refused it) and the schema walker's codes. They are
 * the one list of what a quarantine record may say when this Desk, and not the store, condemned the file. A Desk older than the file can give them for
 * a file that is fine (it predates the file's schema), which is why a newer Desk judges such a record again; every other reason (a store's refusal, a
 * hold behind quarantined facts, `too_large`, which a store also gives) is never judged again here.
 */
export const LABEL_CHECK_CODES = Object.freeze(new Set(["invalid", "type", "missing", "unknown_key", "enum", "pattern", "integer", "range", "order", "overlap", "duplicate", "empty", "too_many", "inconsistent"]))

const LABELS_SCHEMA_PATTERN = /^desk\.factory\.labels\/[123]$/u
export const DESK_VERSION = /^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})(?:-(alpha|beta|rc)\.([0-9]{1,4}))?$/u
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

// `/2` stretch keys: the label's confidence and version, and the "could not tell" class and waste.
const STRETCH_V2 = {
  ...STRETCH,
  class: enumField([...LABEL_CLASSES, UNKNOWN_LABEL]),
  waste: nullableEnumField([...LABEL_WASTES, UNKNOWN_LABEL]),
  confidence: enumField(LABEL_CONFIDENCE),
  evaluator_version: patternField(DESK_VERSION),
}

// A stretch's waste agrees with its class: one of the eight for `muda`, `unknown` for `unknown`, `null` otherwise.
function wasteAgrees(value) {
  if (value.class === "muda") return value.waste !== null && value.waste !== UNKNOWN_LABEL
  return value.waste === (value.class === UNKNOWN_LABEL ? UNKNOWN_LABEL : null)
}

function stretchCheck(value, path, results, errors) {
  if (results.start_ms === true && results.end_ms === true && value.end_ms <= value.start_ms) {
    addError(errors, "order", joinPath(path, "end_ms"))
  }
  if (results.class === true && results.waste === true && !wasteAgrees(value)) {
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

// The stretch spec for one schema version, with `caught` when the stretch carries it.
const stretchesField = (base) => arrayField(objectField((value) => (Object.hasOwn(value, "caught") ? { ...base, ...CAUGHT } : base), stretchCheck), LABEL_LIMITS.stretches)

const TOP = {
  schema: patternField(LABELS_SCHEMA_PATTERN),
  job: publicPatternField(PATTERNS.jobId),
  session: publicPatternField(SESSION_ID_V4),
  evaluator: objectField(EVALUATOR),
  stretches: stretchesField(STRETCH),
  unavailable: arrayField(enumField(LABEL_UNAVAILABLE), LABEL_UNAVAILABLE.length),
}

const TOP_V2 = { ...TOP, stretches: stretchesField(STRETCH_V2) }

// `/3`: one stop per classified human wait.
const STOP = {
  wait: customField(checkEvidenceRange),
  why: enumField(LABEL_STOP_WHY),
  confidence: enumField(LABEL_CONFIDENCE),
  evaluator_version: patternField(DESK_VERSION),
}

const { unavailable: UNAVAILABLE_FIELD, ...TOP_V2_HEAD } = TOP_V2
const TOP_V3 = { ...TOP_V2_HEAD, stops: arrayField(objectField(STOP), LABEL_LIMITS.stops), unavailable: UNAVAILABLE_FIELD }

// Each file is walked with its own schema's spec. A wrong schema value (refused once, as `pattern`) is walked with the current spec when it
// carries stops and with the `/2` spec when it does not, so its keys add no second error.
function topFields(value) {
  if (value.schema === LABELS_SCHEMAS[0]) return TOP
  if (value.schema === LABELS_SCHEMA_V2) return TOP_V2
  return value.schema === LABELS_SCHEMA || Object.hasOwn(value, "stops") ? TOP_V3 : TOP_V2
}

// For the structural test: every allowed key carries a real check.
export const __LABEL_SPECS__ = Object.freeze({
  top: TOP,
  evaluator: EVALUATOR,
  stretch: { ...STRETCH, ...CAUGHT },
  stretchV2: { ...STRETCH_V2, ...CAUGHT },
  stop: STOP,
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
  const results = validateObject(value, "", topFields, errors)
  if (results === undefined) return { ok: false, errors }

  // No label is newer than the evaluator that wrote the file, so the store's file-level replacement rule still compares the newest label.
  if (results.evaluator?.plugin_version === true && Array.isArray(results.stretches)) {
    value.stretches.forEach((stretch, index) => {
      if (results.stretches[index]?.evaluator_version !== true) return
      if (compareVersions(stretch.evaluator_version, value.evaluator.plugin_version) > 0) addError(errors, "inconsistent", `stretches.${index}.evaluator_version`)
    })
  }

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

  if (Array.isArray(results.stops)) checkStops(value, results, errors)

  if (Array.isArray(results.unavailable)) {
    const seen = new Set()
    value.unavailable.forEach((code, index) => {
      if (results.unavailable[index] !== true) return
      if (seen.has(code)) addError(errors, "duplicate", `unavailable.${index}`)
      seen.add(code)
    })
    // Without the job's facts there is no evidence to cite.
    if (seen.has("facts_missing") && Array.isArray(value.stretches) && value.stretches.length > 0) addError(errors, "inconsistent", "stretches")
    if (seen.has("facts_missing") && Array.isArray(value.stops) && value.stops.length > 0) addError(errors, "inconsistent", "stops")
  }

  return { ok: errors.length === 0, errors }
}

// Stops in wait order, one per wait, none newer than the file's evaluator. A stop whose own wait is unsound is skipped, so one bad stop is one error.
function checkStops(value, results, errors) {
  const fileVersion = results.evaluator?.plugin_version === true ? value.evaluator.plugin_version : null
  const seen = new Set()
  let previous = null
  value.stops.forEach((stop, index) => {
    const result = results.stops[index]
    if (!isPlainObject(result)) return
    if (fileVersion !== null && result.evaluator_version === true && compareVersions(stop.evaluator_version, fileVersion) > 0) addError(errors, "inconsistent", `stops.${index}.evaluator_version`)
    if (result.wait !== true) return
    const key = `${stop.wait[0]}:${stop.wait[1]}`
    if (seen.has(key)) addError(errors, "duplicate", `stops.${index}`)
    else if (previous !== null && stop.wait[0] <= previous) addError(errors, "order", `stops.${index}`)
    seen.add(key)
    previous = Math.max(previous ?? stop.wait[0], stop.wait[0])
  })
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
  // Each human wait by its exact range, with its stop facts when the facts carry them.
  const waits = new Map(facts.intervals.filter((interval) => interval.kind === "human_wait").map((interval) => [`${interval.start_ms}:${interval.end_ms}`, interval]))
  for (const [index, stop] of (labels.stops ?? []).entries()) {
    if (stop.wait[1] > facts.session.duration_ms) {
      addError(errors, "range", `stops.${index}.wait`)
      continue
    }
    const wait = waits.get(`${stop.wait[0]}:${stop.wait[1]}`)
    if (wait === undefined) addError(errors, "evidence_unmatched", `stops.${index}.wait`)
    else if (Object.hasOwn(STOP_RULES, wait.stop?.end ?? "")) addError(errors, "inconsistent", `stops.${index}.why`)
  }
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

/** `compareVersions(left, right) -> number`: two valid evaluator versions in release order (negative, zero or positive). */
export function compareVersions(left, right) {
  return compareTuples(versionTuple(left), versionTuple(right))
}

/**
 * `evaluatorDowngrade(previous, current) -> boolean`: whether valid labels
 * `current` come from an older evaluator than valid labels `previous`, by
 * plugin version or by rubric.
 */
export function evaluatorDowngrade(previous, current) {
  return compareVersions(current.evaluator.plugin_version, previous.evaluator.plugin_version) < 0
    || Number(current.evaluator.rubric) < Number(previous.evaluator.rubric)
}
