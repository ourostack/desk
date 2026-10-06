// Local facts (`desk.factory.local/2`; `/1` files are still read): schema, privacy gate and
// validator, plus the spec walker the published schema reuses.
//
// Local facts are what the derivers and binding write to the local outbox,
// one file per session per store. They keep exact times and never leave the
// machine as they are: `publish.js`'s `toPublished` is the only transform
// that produces what leaves it, and `published-schema.js` is the public gate
// for that form. Local facts carry no contributor.
//
// Every string in a local facts file matches an enum or a strict pattern —
// there is no free-text field, so there is nothing here a transcript, a
// prompt, a file path or a task title could hide inside.
// `validateLocalFacts` enforces that shape exactly: an unrecognized key is
// refused, not ignored. `validateLocalFactsBytes` additionally requires the
// raw bytes to be the canonical serialization of what they parse to, so a
// duplicate JSON key — which `JSON.parse` silently collapses to its last
// value — cannot let free text ride along in bytes that otherwise parse
// clean.
//
// The schema is a real declarative spec walker: one field-spec object per
// level (`SESSION_SPEC`, `MODEL_SPEC`, ...) is the *only* place that names a
// level's keys, and both the allowed-key check and the per-key validators are
// derived from that same object by `validateObject`. There is no second,
// hand-kept list to fall out of sync with it.
//
// Error reporting follows the same discipline. `{ code, path }` only, and
// `path` is built only from fixed schema field names and numeric array
// indices — never from a value the input supplied and never from a key name
// the input supplied (an "unknown key" names its containing object, not
// itself) — so a malformed or adversarial input cannot smuggle its own
// content out through an error report.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files; this module needs no import at all — `Buffer` is a Node global, and
// every other check here is plain object/regex/Date arithmetic.

export const ENUMS = Object.freeze({
  host: Object.freeze(["claude-code", "copilot-cli", "codex-cli"]),
  entrypoint: Object.freeze(["cli", "desktop", "sdk", "launcher", "unknown"]),
  endReason: Object.freeze([
    "clear", "resume", "logout", "prompt_input_exit", "complete", "user_exit", "error", "other",
  ]),
  toolKind: Object.freeze([
    "read", "edit", "shell", "search", "web", "agent", "desk", "skill", "mcp", "plan", "other",
  ]),
  intervalKind: Object.freeze([
    "turn", "tool", "subagent", "human_wait", "permission_wait", "api_retry", "compaction",
  ]),
  outcome: Object.freeze(["ok", "error", "denied", "interrupted", "timeout"]),
  jobStatus: Object.freeze([
    "drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled",
  ]),
  jobBasis: Object.freeze(["desk_tool", "file_write", "desk_commit", "spawn_brief", "inherited"]),
  // A field a file lists here was not recorded; its value in the file is not a measured zero.
  unavailableField: Object.freeze([
    "tokens", "requests", "models", "turns", "tool_durations", "permission_waits",
    "human_waits", "api_retries", "commits", "ci_runs", "plugins", "ended_at",
    "compaction_waits", "agents", "prs", "reasoning_tokens", "entrypoint", "tool_outcomes", "job_segments",
    "human_turns",
  ]),
  // The published form adds `job_offsets`: a job whose offsets could not be
  // measured (no readable task-card creation time).
  publishedUnavailableField: Object.freeze([
    "tokens", "requests", "models", "turns", "tool_durations", "permission_waits",
    "human_waits", "api_retries", "commits", "ci_runs", "plugins", "ended_at",
    "compaction_waits", "agents", "prs", "reasoning_tokens", "entrypoint", "tool_outcomes", "job_segments",
    "human_turns", "job_offsets",
  ]),
  // `log_truncated` is a log that ends mid-record; `capped` is data a deriver
  // trimmed to a schema limit; `desk_public` is job timing the transform
  // withholds because the desk's own remote is (or may be) public.
  unavailableReason: Object.freeze([
    "host_does_not_record", "log_missing", "log_truncated", "session_open",
    "not_collected_in_slice_1", "source_unreadable", "capped", "desk_public",
    "field_absent", "host_records_partly", "withheld_public",
  ]),
  // The size class of a character count (`sizeClass` in `derive-common.js`), and how a human turn relates to the agent's last stop.
  sizeClass: Object.freeze(["none", "xs", "s", "m", "l", "xl"]),
  turnBasis: Object.freeze(["first", "after_stop", "mid_turn"]),
})

export const LOCAL_SCHEMA = "desk.factory.local/2"

/** Every local schema value a reader accepts: the legacy `/1` and the current one. */
export const LOCAL_SCHEMAS = Object.freeze(["desk.factory.local/1", LOCAL_SCHEMA])

export const PATTERNS = Object.freeze({
  schema: /^desk\.factory\.local\/[12]$/u,
  sessionId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  // The prerelease part is bounded (controller ruling, M1): unbounded free text there
  // would let word-shaped strings ride through as a "version".
  semver: /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]{1,32})?$/u,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  pluginName: /^[a-z0-9][a-z0-9-]{0,63}$/u,
  modelId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u,
  // The harness's own agent type (`general-purpose`, `plugin:name`). A requested model
  // uses `modelId`: a short alias such as `sonnet` is a subset of that pattern.
  agentType: /^[A-Za-z0-9][A-Za-z0-9:_.-]{0,63}$/u,
  prRepo: /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u,
  commitSha: /^[0-9a-f]{40}$/u,
  jobId: /^[0-9a-f]{32}$/u,
})

export const LIMITS = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  plugins: 64,
  models: 32,
  intervals: 100000,
  prs: 500,
  commits: 2000,
  agents: 10000,
  jobs: 1000,
  jobTransitions: 1000,
  jobSegments: 200,
  // Every field with every reason once: no entry set can overflow when an enum grows.
  unavailable: ENUMS.publishedUnavailableField.length * ENUMS.unavailableReason.length,
  outcomes: 256,
  returns: 32,
  humanTurns: 1000,
})

export const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const isSafeNonNegInt = (value) => Number.isSafeInteger(value) && value >= 0
const isSafePositiveInt = (value) => Number.isSafeInteger(value) && value > 0
export const joinPath = (parent, segment) => (parent === "" ? String(segment) : `${parent}.${segment}`)

export function addError(errors, code, path) {
  errors.push({ code, path })
}

/** Every object here has an exact key set; anything else is `unknown_key`. */
function checkKnownKeys(value, path, allowedKeys, errors) {
  const allowed = new Set(allowedKeys)
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) addError(errors, "unknown_key", path)
  }
}

function checkPattern(value, path, pattern, errors) {
  if (typeof value !== "string") {
    addError(errors, "type", path)
    return false
  }
  if (!pattern.test(value)) {
    addError(errors, "pattern", path)
    return false
  }
  return true
}

function checkEnum(value, path, allowed, errors) {
  if (typeof value !== "string") {
    addError(errors, "type", path)
    return false
  }
  if (!allowed.includes(value)) {
    addError(errors, "enum", path)
    return false
  }
  return true
}

function checkSafeNonNegInt(value, path, errors) {
  if (!isSafeNonNegInt(value)) {
    addError(errors, "integer", path)
    return false
  }
  return true
}

function checkNullableSafeNonNegInt(value, path, errors) {
  if (value === null) return true
  return checkSafeNonNegInt(value, path, errors)
}

function checkRangeInt(value, path, min, max, errors) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    addError(errors, "range", path)
    return false
  }
  return true
}

function checkNullableRangeInt(value, path, min, max, errors) {
  if (value === null) return true
  return checkRangeInt(value, path, min, max, errors)
}

// A timestamp must both match the strict pattern and be a real instant
// (controller ruling, M2): `2026-99-99T99:99:99.999Z` matches the pattern's
// shape but is not a date `Date.parse` can resolve, and reporting anything
// other than `pattern` for it would let a shape-only check stand in for a
// real one.
function checkTimestamp(value, path, errors) {
  if (typeof value !== "string") {
    addError(errors, "type", path)
    return false
  }
  if (!PATTERNS.timestamp.test(value) || Number.isNaN(Date.parse(value))) {
    addError(errors, "pattern", path)
    return false
  }
  return true
}

function checkNullableTimestamp(value, path, errors) {
  if (value === null) return true
  return checkTimestamp(value, path, errors)
}

function requireField(value, path, field, errors) {
  if (!Object.hasOwn(value, field)) {
    addError(errors, "missing", joinPath(path, field))
    return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Spec primitives. Each returns `{ check(value, path, errors, ctx) }`. A
// level's spec is a plain object mapping its field names to one of these —
// that same object drives both `checkKnownKeys`'s allow-list and the actual
// per-key validation in `validateObject`, so the two can never disagree.
// They are exported for `published-schema.js`, which builds its own level
// specs from them and walks them with this same `validateObject`: there is
// one validator engine, not two.
// ---------------------------------------------------------------------------

export const leaf = (check) => ({ check })

export const patternField = (pattern) => leaf((value, path, errors) => checkPattern(value, path, pattern, errors))
export const enumField = (allowed) => leaf((value, path, errors) => checkEnum(value, path, allowed, errors))
export const nullableEnumField = (allowed) => leaf((value, path, errors) => (value === null ? true : checkEnum(value, path, allowed, errors)))
export const nonNegIntField = () => leaf(checkSafeNonNegInt)
const nullableNonNegIntField = () => leaf(checkNullableSafeNonNegInt)
export const booleanField = () => leaf((value, path, errors) => {
  if (typeof value !== "boolean") {
    addError(errors, "type", path)
    return false
  }
  return true
})
const positiveIntField = () => leaf((value, path, errors) => {
  if (!isSafePositiveInt(value)) {
    addError(errors, "integer", path)
    return false
  }
  return true
})
export const rangeIntField = (min, max) => leaf((value, path, errors) => checkRangeInt(value, path, min, max, errors))
const nullableRangeIntField = (min, max) => leaf((value, path, errors) => checkNullableRangeInt(value, path, min, max, errors))
const timestampField = () => leaf(checkTimestamp)
const nullableTimestampField = () => leaf(checkNullableTimestamp)
export const customField = (check) => leaf(check)

/** A nested fixed-shape object. `specOrFn` may compute the spec from the raw value (for a shape that depends on a sibling field, e.g. `intervals[].kind`). */
export function objectField(specOrFn, post) {
  return leaf((value, path, errors, ctx) => {
    const results = validateObject(value, path, specOrFn, errors, ctx)
    if (results !== undefined && post) post(value, path, results, errors, ctx)
    return results
  })
}

/** Same shape, but `null` is also accepted. */
export function nullableObjectField(spec) {
  return leaf((value, path, errors, ctx) => (value === null ? true : validateObject(value, path, spec, errors, ctx)))
}

/** An array of `itemField`-shaped entries, capped at `max` (every array in this schema has one — see `LIMITS`). Over cap fails fast with one `too_many`, items left unchecked. */
export function arrayField(itemField, max) {
  return leaf((value, path, errors, ctx) => {
    if (!Array.isArray(value)) {
      addError(errors, "type", path)
      return undefined
    }
    if (value.length > max) {
      addError(errors, "too_many", path)
      return undefined
    }
    return value.map((item, index) => itemField.check(item, joinPath(path, index), errors, ctx))
  })
}

/** An open map keyed by members of `allowedKeys` (e.g. `counts.tool_calls`), each value shaped by `valueField`. An unrecognized key names the map itself, never the key. */
function mapOfField(allowedKeys, valueField) {
  return leaf((value, path, errors) => {
    if (!isPlainObject(value)) {
      addError(errors, "type", path)
      return undefined
    }
    let sawUnknownKey = false
    for (const key of Object.keys(value)) {
      if (!allowedKeys.includes(key)) sawUnknownKey = true
    }
    if (sawUnknownKey) addError(errors, "unknown_key", path)
    for (const [key, entry] of Object.entries(value)) {
      if (!allowedKeys.includes(key)) continue
      valueField.check(entry, joinPath(path, key), errors)
    }
    return true
  })
}

/**
 * Validate `value` as an object shaped by `specOrFn` (a field-spec object, or
 * a function of `value` returning one). Checks the key set exactly once
 * against `Object.keys(spec)`, then runs each present field's own check —
 * the single source of truth I2 (real declarative spec walker) asks for.
 * Returns a map of field name -> that field's check result, or `undefined`
 * when `value` isn't even a plain object.
 */
export function validateObject(value, path, specOrFn, errors, ctx) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return undefined
  }
  const spec = typeof specOrFn === "function" ? specOrFn(value) : specOrFn
  checkKnownKeys(value, path, Object.keys(spec), errors)
  const results = {}
  for (const [key, field] of Object.entries(spec)) {
    if (!requireField(value, path, key, errors)) continue
    results[key] = field.check(value[key], joinPath(path, key), errors, ctx)
  }
  return results
}

// ---------------------------------------------------------------------------
// Per-level specs.
// ---------------------------------------------------------------------------

// The levels whose shape is the same in the local and published forms are
// exported for `published-schema.js`.

const TOKEN_FIELDS = ["input", "output", "cache_read", "cache_write", "reasoning"]
const TOKENS_SPEC = Object.fromEntries(TOKEN_FIELDS.map((name) => [name, nullableNonNegIntField()]))

export const MODEL_SPEC = {
  id: patternField(PATTERNS.modelId),
  requests: nullableNonNegIntField(),
  tokens: objectField(TOKENS_SPEC),
}

export const PLUGIN_SPEC = {
  name: patternField(PATTERNS.pluginName),
  version: patternField(PATTERNS.semver),
}

// A local plugin may also say where it was installed from: the GitHub
// `owner/repo` of its marketplace or cache entry, or `null` when that is
// unknown. The key is optional, so older local facts stay valid and read as
// `null`; the transform names a plugin in a public store only when this
// repository is public, and it never publishes the source itself.
const nullableRepoField = () => leaf((value, path, errors) => (value === null ? true : checkPattern(value, path, PATTERNS.prRepo, errors)))

/** Whether a plugin entry's optional `source` is absent, `null` or an `owner/repo` name. */
export function validPluginSource(plugin) {
  return !Object.hasOwn(plugin, "source") || plugin.source === null || (typeof plugin.source === "string" && PATTERNS.prRepo.test(plugin.source))
}

function localPluginFields(value) {
  return Object.hasOwn(value, "source") ? { ...PLUGIN_SPEC, source: nullableRepoField() } : PLUGIN_SPEC
}

export const AGENT_SPEC = {
  n: rangeIntField(0, 9999),
  parent: nullableRangeIntField(0, 9999),
  model: patternField(PATTERNS.modelId),
}

/** `base` plus the optional worker keys `agent_type` and `requested_model`, each only when the entry carries it, so files written before they existed stay valid. Local and published validation both build their agent spec here. */
export function agentFields(value, base, agentType, requestedModel) {
  return {
    ...base,
    ...(Object.hasOwn(value, "agent_type") ? { agent_type: agentType } : {}),
    ...(Object.hasOwn(value, "requested_model") ? { requested_model: requestedModel } : {}),
  }
}

const LOCAL_AGENT_TYPE = patternField(PATTERNS.agentType)
const localAgentFields = (value) => agentFields(value, AGENT_SPEC, LOCAL_AGENT_TYPE, patternField(PATTERNS.modelId))

export const PR_SPEC = {
  repo: patternField(PATTERNS.prRepo),
  number: positiveIntField(),
}

// `agent` (the worker that opened the PR) is optional, so files written before
// workers were attributed stay valid. Whether it names a real worker is a
// cross-field check (`checkAgentReferences`).
// `at_ms` (when the creating tool result came, in milliseconds from session
// start) is optional too: files written before PRs were timed stay valid.
export function prFields(value) {
  return {
    ...PR_SPEC,
    ...(Object.hasOwn(value, "agent") ? { agent: rangeIntField(0, 9999) } : {}),
    ...(Object.hasOwn(value, "at_ms") ? { at_ms: nonNegIntField() } : {}),
  }
}

// `jobs[].agents`: the workers whose work belongs to the job. A non-empty,
// duplicate-free list of worker numbers; absent means every worker in the session.
export function checkJobAgents(value, path, errors) {
  if (!Array.isArray(value)) {
    addError(errors, "type", path)
    return false
  }
  if (value.length === 0) {
    addError(errors, "empty", path)
    return false
  }
  if (value.length > LIMITS.agents) {
    addError(errors, "too_many", path)
    return false
  }
  let ok = true
  value.forEach((entry, index) => {
    if (!rangeIntField(0, 9999).check(entry, joinPath(path, index), errors)) ok = false
  })
  if (ok && new Set(value).size !== value.length) {
    addError(errors, "duplicate", path)
    ok = false
  }
  // Canonical form: ascending, so one content gives one set of bytes.
  if (ok && value.some((entry, index) => index > 0 && entry < value[index - 1])) {
    addError(errors, "order", path)
    ok = false
  }
  return ok
}

// `jobs[].segments`: the spans of the session, in milliseconds from its start,
// that the controller's (worker 0's) evidence gives to the job. Each is
// half-open, `[start_ms, end_ms)`, and `shared: true` marks a span another job
// of the session holds too. Within a job they are ascending and never overlap.
export const SEGMENT_SPEC = {
  start_ms: nonNegIntField(),
  end_ms: nonNegIntField(),
}

const trueField = () => leaf((value, path, errors) => {
  if (value !== true) {
    addError(errors, "type", path)
    return false
  }
  return true
})

const segmentFields = (value) => (Object.hasOwn(value, "shared") ? { ...SEGMENT_SPEC, shared: trueField() } : SEGMENT_SPEC)

export function checkSegments(value, path, errors) {
  if (!Array.isArray(value)) {
    addError(errors, "type", path)
    return false
  }
  // A job the controller holds no time in has no segments at all, never an empty list.
  if (value.length === 0) {
    addError(errors, "empty", path)
    return false
  }
  if (value.length > LIMITS.jobSegments) {
    addError(errors, "too_many", path)
    return false
  }
  const before = errors.length
  let previousEnd = null
  value.forEach((segment, index) => {
    const itemPath = joinPath(path, index)
    const results = validateObject(segment, itemPath, segmentFields, errors)
    if (results?.start_ms !== true || results.end_ms !== true) {
      previousEnd = null
      return
    }
    if (segment.end_ms <= segment.start_ms) addError(errors, "order", joinPath(itemPath, "end_ms"))
    else if (previousEnd !== null && segment.start_ms < previousEnd) addError(errors, "order", joinPath(itemPath, "start_ms"))
    previousEnd = segment.end_ms
  })
  return errors.length === before
}

// Adds the optional `agents` and `segments` keys to a job spec when the job carries them.
export function jobFields(value, base) {
  return {
    ...base,
    ...(Object.hasOwn(value, "agents") ? { agents: customField(checkJobAgents) } : {}),
    ...(Object.hasOwn(value, "segments") ? { segments: customField(checkSegments) } : {}),
  }
}

/**
 * Segments split the controller's (worker 0's) time, so a job carries them
 * only when its `agents` lists worker 0; anything else is `inconsistent`.
 * Shared by the local and published validators.
 */
export function checkSegmentAgents(value, results, errors) {
  results.jobs?.forEach((jobResult, index) => {
    if (jobResult?.segments === undefined) return
    const job = value.jobs[index]
    if (!Array.isArray(job.agents) || !job.agents.includes(0)) addError(errors, "inconsistent", `jobs.${index}.segments`)
  })
}

/**
 * No job segment and no PR time may run past the session's end
 * (`durationMs`, or `null` when the session's own times are unsound, which
 * skips the check so one bad time is one error). Shared by the local and
 * published validators.
 */
export function checkSessionBounds(value, results, errors, durationMs) {
  if (durationMs === null) return
  results.jobs?.forEach((jobResult, index) => {
    if (jobResult?.segments !== true) return
    value.jobs[index].segments.forEach((segment, entry) => {
      if (segment.end_ms > durationMs) addError(errors, "range", `jobs.${index}.segments.${entry}.end_ms`)
    })
  })
  results.refs?.prs?.forEach((prResult, index) => {
    if (prResult?.at_ms === true && value.refs.prs[index].at_ms > durationMs) addError(errors, "range", `refs.prs.${index}.at_ms`)
  })
}

// A commit's repository, when the deriver can attribute one; `null` when it
// cannot (the transform drops and counts those).
const COMMIT_SPEC = {
  repo: nullableRepoField(),
  sha: patternField(PATTERNS.commitSha),
}

// `unresolved` counts references the deriver saw but could not publish
// exactly: a bare PR number with no session repository, a short commit SHA
// that does not resolve locally. The transform adds them to `refs.private`.
const UNRESOLVED_SPEC = {
  prs: nonNegIntField(),
  commits: nonNegIntField(),
}

const REFS_SPEC = {
  prs: arrayField(objectField(prFields), LIMITS.prs),
  commits: arrayField(objectField(COMMIT_SPEC), LIMITS.commits),
  unresolved: objectField(UNRESOLVED_SPEC),
}

const TRANSITION_SPEC = {
  to: enumField(ENUMS.jobStatus),
  at: timestampField(),
}

// `at` is the card's `updated` for a terminal status, else `null` (M3-4).
const OBSERVED_SPEC = {
  status: enumField(ENUMS.jobStatus),
  at: nullableTimestampField(),
}

// jobs[].basis: a non-empty, duplicate-free subset of ENUMS.jobBasis
// (controller ruling, M3: duplicates are their own `duplicate` error, not
// folded into `enum`).
export function checkBasis(value, path, errors) {
  if (!Array.isArray(value)) {
    addError(errors, "type", path)
    return false
  }
  if (value.length === 0) {
    addError(errors, "empty", path)
    return false
  }
  let sawInvalid = false
  for (const entry of value) {
    if (typeof entry !== "string" || !ENUMS.jobBasis.includes(entry)) sawInvalid = true
  }
  if (sawInvalid) {
    addError(errors, "enum", path)
    return false
  }
  const seen = new Set()
  let sawDuplicate = false
  for (const entry of value) {
    if (seen.has(entry)) sawDuplicate = true
    seen.add(entry)
  }
  if (sawDuplicate) {
    addError(errors, "duplicate", path)
    return false
  }
  return true
}

// M3-4's `LocalJob`.
const JOB_SPEC = {
  job: patternField(PATTERNS.jobId),
  basis: customField(checkBasis),
  task_created_at: nullableTimestampField(),
  transitions: arrayField(objectField(TRANSITION_SPEC), LIMITS.jobTransitions),
  observed: nullableObjectField(OBSERVED_SPEC),
}

const UNAVAILABLE_SPEC = {
  field: enumField(ENUMS.unavailableField),
  reason: enumField(ENUMS.unavailableReason),
}

// `outcomes[]`: the outcome record of one task the session touched (`derive-run.js` `outcomesFor`). These two lists are `OUTCOME_STATES` and `REFUSAL_REASONS` in `outcome.js`; a test compares them, because this module imports nothing.
const OUTCOME_STATE_CODES = ["not_delivered", "not_recorded", "delivered_unsigned", "accepted", "refused", "reopened"]
const REFUSAL_REASON_CODES = ["not_what_was_asked", "defect", "changed_ask", "incomplete", "other"]
const OUTCOME_SPEC = {
  job: patternField(PATTERNS.jobId),
  rev: nonNegIntField(),
  state: enumField(OUTCOME_STATE_CODES),
  verified: leaf((value, path, errors) => (value === null ? true : booleanField().check(value, path, errors))),
  reason: nullableEnumField(REFUSAL_REASON_CODES),
  deliveries: nonNegIntField(),
  delivered_at: nullableTimestampField(),
  signed_at: nullableTimestampField(),
  observed_at: nullableTimestampField(),
}

// The optional keys of an outcome entry: the record's start, the two milestone times (local only), the returns the record holds (newest `LIMITS.returns`), and the two flags that say a returns list is not the whole story. These lists are `RETURN_REASONS` and `CATCH_POINTS` in `outcome.js`; a test compares them.
const RETURN_REASON_CODES = ["agent_error", "changed_ask", "new_information", "external"]
const CATCH_POINT_CODES = ["in_task", "at_review", "after_delivery"]
const OUTCOME_SINCE_CODES = ["created", "adopted"]
const RETURN_SPEC = {
  reason: enumField(RETURN_REASON_CODES),
  caught: enumField(CATCH_POINT_CODES),
  counts: booleanField(),
  refusal: nullableEnumField(REFUSAL_REASON_CODES),
  refusal_verified: OUTCOME_SPEC.verified,
}
const OUTCOME_OPTIONAL = {
  since: nullableEnumField(OUTCOME_SINCE_CODES),
  first_validating_at: nullableTimestampField(),
  first_delivered_at: nullableTimestampField(),
  returns: arrayField(objectField(RETURN_SPEC), LIMITS.returns),
  returns_truncated: leaf((value, path, errors) => {
    if (value === true) return true
    addError(errors, "type", path)
    return false
  }),
  returns_unreadable: positiveIntField(),
}
// An entry's spec: the required keys, and each optional key the entry carries.
const outcomeFields = (value) => ({ ...OUTCOME_SPEC, ...Object.fromEntries(Object.entries(OUTCOME_OPTIONAL).filter(([key]) => Object.hasOwn(value, key))) })

// A list capped at `LIMITS.outcomes` with one entry per job.
const outcomesField = () => {
  const list = arrayField(objectField(outcomeFields), LIMITS.outcomes)
  return leaf((value, path, errors, ctx) => {
    const results = list.check(value, path, errors, ctx)
    if (results === undefined) return results
    const seen = new Set()
    value.forEach((entry, index) => {
      if (results[index]?.job !== true) return
      if (seen.has(entry.job)) addError(errors, "duplicate", joinPath(path, `${index}.job`))
      seen.add(entry.job)
    })
    return results
  })
}

// `ended_at` and `derived_through` never precede `started_at`: the published
// duration is `derived_through - started_at` and must not be negative.
function sessionOrderCheck(value, path, results, errors) {
  if (!results.started_at) return
  const started = Date.parse(value.started_at)
  if (value.ended_at !== null && results.ended_at && Date.parse(value.ended_at) < started) {
    addError(errors, "order", joinPath(path, "ended_at"))
  }
  if (results.derived_through && Date.parse(value.derived_through) < started) {
    addError(errors, "order", joinPath(path, "derived_through"))
  }
}

const SESSION_SPEC = {
  host: enumField(ENUMS.host),
  id: patternField(PATTERNS.sessionId),
  host_version: patternField(PATTERNS.semver),
  entrypoint: enumField(ENUMS.entrypoint),
  started_at: timestampField(),
  ended_at: nullableTimestampField(),
  end_reason: nullableEnumField(ENUMS.endReason),
  derived_through: timestampField(),
}

// intervals[].tool / outcome are required exactly when kind is "tool", and
// forbidden otherwise. Because the object walker derives its allow-list from
// the very same spec it validates against, "forbidden" is not a separate
// error path: when kind isn't "tool" those two keys are simply absent from
// the computed spec, so their presence is already an `unknown_key`.
function intervalFields(value) {
  const fields = {
    kind: enumField(ENUMS.intervalKind),
    agent: rangeIntField(0, 9999),
    start: timestampField(),
    end: timestampField(),
  }
  // `validateObject` only ever calls this after confirming `value` is a
  // plain object, so no further type guard is needed here.
  if (value.kind === "tool") {
    fields.tool = enumField(ENUMS.toolKind)
    fields.outcome = enumField(ENUMS.outcome)
  }
  return fields
}

function intervalOrderCheck(value, path, results, errors) {
  if (results.start && results.end && Date.parse(value.end) < Date.parse(value.start)) {
    addError(errors, "order", joinPath(path, "end"))
  }
}

const INTERVAL_FIELD = objectField(intervalFields, intervalOrderCheck)

export const COUNTS_SPEC = {
  tool_calls: mapOfField(ENUMS.toolKind, nonNegIntField()),
  tool_failures: mapOfField(ENUMS.toolKind, nonNegIntField()),
  tool_retries: nonNegIntField(),
  api_retries: nonNegIntField(),
  compactions: nonNegIntField(),
}

const TOP_SPEC = {
  schema: patternField(PATTERNS.schema),
  session: objectField(SESSION_SPEC, sessionOrderCheck),
  plugins: arrayField(objectField(localPluginFields), LIMITS.plugins),
  models: arrayField(objectField(MODEL_SPEC), LIMITS.models),
  agents: arrayField(objectField(localAgentFields), LIMITS.agents),
  intervals: arrayField(INTERVAL_FIELD, LIMITS.intervals),
  counts: objectField(COUNTS_SPEC),
  refs: objectField(REFS_SPEC),
  jobs: arrayField(objectField((value) => jobFields(value, JOB_SPEC)), LIMITS.jobs),
  unavailable: arrayField(objectField(UNAVAILABLE_SPEC), LIMITS.unavailable),
}

// `human_turns[]`: one human prompt, as sizes and times only. `at` is the prompt's time in the form local intervals use; `window_ms` is null exactly for the first prompt.
const HUMAN_TURN_SPEC = {
  at: timestampField(),
  basis: enumField(ENUMS.turnBasis),
  window_ms: nullableNonNegIntField(),
  prompt_class: enumField(ENUMS.sizeClass),
  output_class: enumField(ENUMS.sizeClass),
}

// A list capped at `LIMITS.humanTurns`, in time order, where `window_ms` is null exactly for a `first` turn (the estimator throws on a mismatch, so the gate catches it first).
const humanTurnsField = () => {
  const list = arrayField(objectField(HUMAN_TURN_SPEC), LIMITS.humanTurns)
  return leaf((value, path, errors, ctx) => {
    const results = list.check(value, path, errors, ctx)
    if (results === undefined) return results
    let previous = null
    value.forEach((entry, index) => {
      const own = results[index]
      if (own?.basis === true && own.window_ms === true && (entry.basis === "first") !== (entry.window_ms === null)) {
        addError(errors, "inconsistent", joinPath(path, `${index}.window_ms`))
      }
      if (own?.at !== true) return
      const ms = Date.parse(entry.at)
      if (previous !== null && ms < previous) addError(errors, "order", joinPath(path, `${index}.at`))
      previous = ms
    })
    return results
  })
}

// The optional top-level keys, added only when the file carries them (as `agents` and `segments` are on a job).
const topFields = (value) => {
  const withOutcomes = Object.hasOwn(value, "outcomes") ? { ...TOP_SPEC, outcomes: outcomesField() } : TOP_SPEC
  return Object.hasOwn(value, "human_turns") ? { ...withOutcomes, human_turns: humanTurnsField() } : withOutcomes
}

// Every spec object above, keyed for the structural regression test that
// walks each one and asserts every allowed key carries a real validator
// (I2): with this architecture that's true by construction, but the test
// still guards against a future edit that adds a bare value instead of a
// spec primitive.
export const __SPECS__ = Object.freeze({
  top: TOP_SPEC,
  session: SESSION_SPEC,
  model: MODEL_SPEC,
  tokens: TOKENS_SPEC,
  plugin: localPluginFields({ source: null }),
  agent: AGENT_SPEC,
  pr: prFields({ agent: 0, at_ms: 0 }),
  segment: segmentFields({ shared: true }),
  commit: COMMIT_SPEC,
  refs: REFS_SPEC,
  unresolved: UNRESOLVED_SPEC,
  transition: TRANSITION_SPEC,
  observed: OBSERVED_SPEC,
  job: JOB_SPEC,
  unavailable: UNAVAILABLE_SPEC,
  outcome: OUTCOME_SPEC,
  humanTurn: HUMAN_TURN_SPEC,
  return: RETURN_SPEC,
  outcomeOptional: OUTCOME_OPTIONAL,
  counts: COUNTS_SPEC,
  intervalTool: intervalFields({ kind: "tool" }),
  intervalOther: intervalFields({ kind: "turn" }),
})

/**
 * Cross-field checks that no single field's own spec can express, shared by
 * the local and published validators: an interval's agent must name a real
 * entry in `agents`, an agent's own `n` must be unique, and an agent's
 * `parent` must name a real agent (M3). Both gate on `results.agents` (not
 * merely `Array.isArray(value.agents)`): when `agents` is over its cap the
 * array's items are left unchecked, same as every other capped array, so
 * nothing here can trust it enough to cross-reference against it either —
 * that would cascade one `too_many` into a `ref`/`reference`/`duplicate`
 * error per sibling item.
 */
export function checkAgentReferences(value, results, errors) {
  if (!results.agents) return
  const agentIds = new Set()
  const validAgents = value.agents
    .map((item, index) => ({ item, index, ok: results.agents[index]?.n === true }))
    .filter((entry) => entry.ok)
  const seenNs = new Set()
  for (const { item, index } of validAgents) {
    if (seenNs.has(item.n)) addError(errors, "duplicate", `agents.${index}.n`)
    else seenNs.add(item.n)
    agentIds.add(item.n)
  }
  value.agents.forEach((item, index) => {
    if (!isPlainObject(item)) return
    if (results.agents[index]?.parent === true && item.parent !== null && !agentIds.has(item.parent)) {
      addError(errors, "reference", `agents.${index}.parent`)
    }
  })

  // A job's or PR's worker must be a real worker of this session.
  results.jobs?.forEach((jobResult, index) => {
    if (jobResult?.agents !== true) return
    value.jobs[index].agents.forEach((n, entry) => {
      if (!agentIds.has(n)) addError(errors, "agent_unknown", `jobs.${index}.agents.${entry}`)
    })
  })
  results.refs?.prs?.forEach((prResult, index) => {
    if (prResult?.agent === true && !agentIds.has(value.refs.prs[index].agent)) {
      addError(errors, "agent_unknown", `refs.prs.${index}.agent`)
    }
  })

  if (results.intervals) {
    value.intervals.forEach((item, index) => {
      const itemResult = results.intervals[index]
      if (itemResult && itemResult.agent === true && !agentIds.has(item.agent)) {
        addError(errors, "ref", `intervals.${index}.agent`)
      }
    })
  }
}

/**
 * `validateLocalFacts(value) -> { ok, errors }`. Accepts an already-parsed
 * value (use `validateLocalFactsBytes` for a raw buffer, which also enforces
 * the byte cap and canonical-bytes check). Collects every violation rather
 * than stopping at the first, but a single-violation input surfaces exactly
 * one error.
 */
export function validateLocalFacts(value) {
  const errors = []
  const results = validateObject(value, "", topFields, errors)
  if (results === undefined) return { ok: false, errors }
  checkAgentReferences(value, results, errors)
  checkSegmentAgents(value, results, errors)
  const sessionSound = results.session?.started_at === true && results.session.derived_through === true
  const durationMs = sessionSound ? Date.parse(value.session.derived_through) - Date.parse(value.session.started_at) : -1
  checkSessionBounds(value, results, errors, durationMs >= 0 ? durationMs : null)
  return { ok: errors.length === 0, errors }
}

/**
 * Parse and validate raw bytes (or a string) with `validate`. Enforces the
 * 16 MiB cap first, measured with `Buffer.byteLength` so a multi-byte string
 * can't undercount itself past the cap the way `.length` (UTF-16 code units)
 * would. Then requires the text to be the exact canonical `JSON.stringify`
 * of what it parses to (one trailing `\n` allowed) — `JSON.parse` silently
 * keeps only the last of any duplicate key, so without this a file carrying
 * `"schema": "<free text>", "schema": "<valid value>"` would validate clean
 * while its raw bytes, which are what a store actually receives and commits,
 * still carry the free text. Shared by the local and published gates.
 */
export function validateCanonicalBytes(buffer, validate) {
  if (Buffer.byteLength(buffer) > LIMITS.maxBytes) {
    return { ok: false, errors: [{ code: "too_large", path: "" }] }
  }
  const text = typeof buffer === "string" ? buffer : buffer.toString("utf8")
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return { ok: false, errors: [{ code: "json", path: "" }] }
  }
  const canonical = JSON.stringify(parsed)
  if (text !== canonical && text !== `${canonical}\n`) {
    return { ok: false, errors: [{ code: "canonical", path: "" }] }
  }
  return validate(parsed)
}

/** `validateLocalFactsBytes(buffer) -> { ok, errors }`: the canonical-bytes gate over `validateLocalFacts`. */
export function validateLocalFactsBytes(buffer) {
  return validateCanonicalBytes(buffer, validateLocalFacts)
}

// The outcome entry's spec and enum lists, for the published form (`published-schema.js`), which shares them.
export { OUTCOME_SPEC, OUTCOME_STATE_CODES, REFUSAL_REASON_CODES }
export { OUTCOME_OPTIONAL, OUTCOME_SINCE_CODES, RETURN_SPEC }
