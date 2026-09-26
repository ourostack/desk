// Local facts v1 (`desk.factory.local/1`): schema, privacy gate and
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
// clean. The M3-1 names `validateFacts` and `validateFactsBytes` remain as
// aliases until M3-12 retires them.
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
  host: Object.freeze(["claude-code", "copilot-cli"]),
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
  jobBasis: Object.freeze(["desk_tool", "file_write", "desk_commit"]),
  unavailableField: Object.freeze([
    "tokens", "requests", "models", "turns", "tool_durations", "permission_waits",
    "human_waits", "api_retries", "commits", "ci_runs", "plugins", "ended_at",
  ]),
  // The published form adds `job_offsets`: a job whose offsets could not be
  // measured (no readable task-card creation time).
  publishedUnavailableField: Object.freeze([
    "tokens", "requests", "models", "turns", "tool_durations", "permission_waits",
    "human_waits", "api_retries", "commits", "ci_runs", "plugins", "ended_at", "job_offsets",
  ]),
  // `log_truncated` is a log that ends mid-record; `capped` is data a deriver
  // trimmed to a schema limit; `desk_public` is job timing the transform
  // withholds because the desk's own remote is (or may be) public.
  unavailableReason: Object.freeze([
    "host_does_not_record", "log_missing", "log_truncated", "session_open",
    "not_collected_in_slice_1", "source_unreadable", "capped", "desk_public",
  ]),
})

export const LOCAL_SCHEMA = "desk.factory.local/1"

export const PATTERNS = Object.freeze({
  schema: /^desk\.factory\.local\/1$/u,
  sessionId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  // The prerelease part is bounded (controller ruling, M1): unbounded free text there
  // would let word-shaped strings ride through as a "version".
  semver: /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]{1,32})?$/u,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
  pluginName: /^[a-z0-9][a-z0-9-]{0,63}$/u,
  modelId: /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/u,
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
  unavailable: 64,
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

export const AGENT_SPEC = {
  n: rangeIntField(0, 9999),
  parent: nullableRangeIntField(0, 9999),
  model: patternField(PATTERNS.modelId),
}

export const PR_SPEC = {
  repo: patternField(PATTERNS.prRepo),
  number: positiveIntField(),
}

// A commit's repository, when the deriver can attribute one; `null` when it
// cannot (the transform drops and counts those).
const COMMIT_SPEC = {
  repo: leaf((value, path, errors) => (value === null ? true : checkPattern(value, path, PATTERNS.prRepo, errors))),
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
  prs: arrayField(objectField(PR_SPEC), LIMITS.prs),
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
  plugins: arrayField(objectField(PLUGIN_SPEC), LIMITS.plugins),
  models: arrayField(objectField(MODEL_SPEC), LIMITS.models),
  agents: arrayField(objectField(AGENT_SPEC), LIMITS.agents),
  intervals: arrayField(INTERVAL_FIELD, LIMITS.intervals),
  counts: objectField(COUNTS_SPEC),
  refs: objectField(REFS_SPEC),
  jobs: arrayField(objectField(JOB_SPEC), LIMITS.jobs),
  unavailable: arrayField(objectField(UNAVAILABLE_SPEC), LIMITS.unavailable),
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
  plugin: PLUGIN_SPEC,
  agent: AGENT_SPEC,
  pr: PR_SPEC,
  commit: COMMIT_SPEC,
  refs: REFS_SPEC,
  unresolved: UNRESOLVED_SPEC,
  transition: TRANSITION_SPEC,
  observed: OBSERVED_SPEC,
  job: JOB_SPEC,
  unavailable: UNAVAILABLE_SPEC,
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
  const results = validateObject(value, "", TOP_SPEC, errors)
  if (results === undefined) return { ok: false, errors }
  checkAgentReferences(value, results, errors)
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

// The M3-1 names, kept as aliases of the local validators until M3-12.
export const validateFacts = validateLocalFacts
export const validateFactsBytes = validateLocalFactsBytes
