// Facts file v1: schema, privacy gate and validator.
//
// A facts file is the only thing that ever leaves this machine for the
// factory stores. Every string in it matches an enum or a strict pattern —
// there is no free-text field, so there is nothing here a transcript, a
// prompt, a file path or a task title could hide inside. `validateFacts`
// enforces that shape exactly: an unrecognized key is refused, not ignored.
//
// Error reporting follows the same discipline. `{ code, path }` only, and
// `path` is built only from fixed schema field names and numeric array
// indices — never from a value the input supplied and never from a key name
// the input supplied (an "unknown key" names its containing object, not
// itself) — so a malformed or adversarial input cannot smuggle its own
// content out through an error report.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files; this module needs no import at all — `validateFactsBytes` only
// calls methods on the `Buffer` its caller hands it.

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
  unavailableReason: Object.freeze([
    "host_does_not_record", "log_missing", "log_truncated", "session_open",
    "not_collected_in_slice_1", "source_unreadable",
  ]),
})

export const PATTERNS = Object.freeze({
  schema: /^desk\.factory\.facts\/1$/u,
  contributor: /^[0-9a-f]{16}$/u,
  sessionId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
  semver: /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$/u,
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
})

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const isSafeNonNegInt = (value) => Number.isSafeInteger(value) && value >= 0
const isSafePositiveInt = (value) => Number.isSafeInteger(value) && value > 0
const joinPath = (parent, segment) => (parent === "" ? String(segment) : `${parent}.${segment}`)

function addError(errors, code, path) {
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

function checkNullableEnum(value, path, allowed, errors) {
  if (value === null) return true
  return checkEnum(value, path, allowed, errors)
}

function checkNullablePattern(value, path, pattern, errors) {
  if (value === null) return true
  return checkPattern(value, path, pattern, errors)
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

/**
 * Run `validate(item, itemPath, errors)` over each entry of an array field,
 * after checking its own type and, if given, its max length. Oversized
 * arrays fail fast: a single `too_many` error, with items left unchecked, so
 * one violation stays one error even at 100000 entries.
 */
function checkArray(value, path, { max, validate }, errors) {
  if (!Array.isArray(value)) {
    addError(errors, "type", path)
    return
  }
  if (max !== undefined && value.length > max) {
    addError(errors, "too_many", path)
    return
  }
  value.forEach((item, index) => validate(item, joinPath(path, index), errors))
}

function requireField(value, path, field, errors) {
  if (!Object.hasOwn(value, field)) {
    addError(errors, "missing", joinPath(path, field))
    return false
  }
  return true
}

function checkTokens(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["input", "output", "cache_read", "cache_write", "reasoning"], errors)
  for (const field of ["input", "output", "cache_read", "cache_write", "reasoning"]) {
    if (!requireField(value, path, field, errors)) continue
    checkNullableSafeNonNegInt(value[field], joinPath(path, field), errors)
  }
}

function checkModel(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["id", "requests", "tokens"], errors)
  if (requireField(value, path, "id", errors)) checkPattern(value.id, joinPath(path, "id"), PATTERNS.modelId, errors)
  if (requireField(value, path, "requests", errors)) checkNullableSafeNonNegInt(value.requests, joinPath(path, "requests"), errors)
  if (requireField(value, path, "tokens", errors)) checkTokens(value.tokens, joinPath(path, "tokens"), errors)
}

function checkPlugin(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["name", "version"], errors)
  if (requireField(value, path, "name", errors)) checkPattern(value.name, joinPath(path, "name"), PATTERNS.pluginName, errors)
  if (requireField(value, path, "version", errors)) checkPattern(value.version, joinPath(path, "version"), PATTERNS.semver, errors)
}

function checkInterval(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  const isTool = value.kind === "tool"
  const allowedKeys = isTool
    ? ["kind", "agent", "start", "end", "tool", "outcome"]
    : ["kind", "agent", "start", "end"]
  checkKnownKeys(value, path, allowedKeys, errors)

  let kindOk = false
  if (requireField(value, path, "kind", errors)) kindOk = checkEnum(value.kind, joinPath(path, "kind"), ENUMS.intervalKind, errors)

  let agentOk = false
  if (requireField(value, path, "agent", errors)) agentOk = checkRangeInt(value.agent, joinPath(path, "agent"), 0, 9999, errors)

  let startOk = false
  if (requireField(value, path, "start", errors)) startOk = checkPattern(value.start, joinPath(path, "start"), PATTERNS.timestamp, errors)

  let endOk = false
  if (requireField(value, path, "end", errors)) endOk = checkPattern(value.end, joinPath(path, "end"), PATTERNS.timestamp, errors)

  if (startOk && endOk && Date.parse(value.end) < Date.parse(value.start)) {
    addError(errors, "order", joinPath(path, "end"))
  }

  // When kind isn't "tool", `tool`/`outcome` are simply not in `allowedKeys`
  // above, so their presence already surfaces as `unknown_key` — a separate
  // "forbidden" code would only double-report the same violation.
  if (kindOk && value.kind === "tool") {
    if (requireField(value, path, "tool", errors)) checkEnum(value.tool, joinPath(path, "tool"), ENUMS.toolKind, errors)
    if (requireField(value, path, "outcome", errors)) checkEnum(value.outcome, joinPath(path, "outcome"), ENUMS.outcome, errors)
  }

  return { agentOk, agent: value.agent }
}

function checkAgent(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["n", "parent", "model"], errors)
  if (requireField(value, path, "n", errors)) checkRangeInt(value.n, joinPath(path, "n"), 0, 9999, errors)
  if (requireField(value, path, "parent", errors)) checkNullableRangeInt(value.parent, joinPath(path, "parent"), 0, 9999, errors)
  if (requireField(value, path, "model", errors)) checkPattern(value.model, joinPath(path, "model"), PATTERNS.modelId, errors)
}

function checkToolCountMap(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  let sawUnknownKey = false
  for (const key of Object.keys(value)) {
    if (!ENUMS.toolKind.includes(key)) sawUnknownKey = true
  }
  if (sawUnknownKey) addError(errors, "unknown_key", path)
  for (const [key, entry] of Object.entries(value)) {
    if (!ENUMS.toolKind.includes(key)) continue
    checkSafeNonNegInt(entry, joinPath(path, key), errors)
  }
}

function checkCounts(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["tool_calls", "tool_failures", "tool_retries", "api_retries", "compactions"], errors)
  if (requireField(value, path, "tool_calls", errors)) checkToolCountMap(value.tool_calls, joinPath(path, "tool_calls"), errors)
  if (requireField(value, path, "tool_failures", errors)) checkToolCountMap(value.tool_failures, joinPath(path, "tool_failures"), errors)
  for (const field of ["tool_retries", "api_retries", "compactions"]) {
    if (requireField(value, path, field, errors)) checkSafeNonNegInt(value[field], joinPath(path, field), errors)
  }
}

function checkPr(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["repo", "number"], errors)
  if (requireField(value, path, "repo", errors)) checkPattern(value.repo, joinPath(path, "repo"), PATTERNS.prRepo, errors)
  if (requireField(value, path, "number", errors)) {
    if (!isSafePositiveInt(value.number)) addError(errors, "integer", joinPath(path, "number"))
  }
}

function checkCommit(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["sha"], errors)
  if (requireField(value, path, "sha", errors)) checkPattern(value.sha, joinPath(path, "sha"), PATTERNS.commitSha, errors)
}

function checkRefs(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["prs", "commits"], errors)
  if (requireField(value, path, "prs", errors)) {
    checkArray(value.prs, joinPath(path, "prs"), { max: LIMITS.prs, validate: checkPr }, errors)
  }
  if (requireField(value, path, "commits", errors)) {
    checkArray(value.commits, joinPath(path, "commits"), { max: LIMITS.commits, validate: checkCommit }, errors)
  }
}

function checkTransition(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["to", "at"], errors)
  if (requireField(value, path, "to", errors)) checkEnum(value.to, joinPath(path, "to"), ENUMS.jobStatus, errors)
  if (requireField(value, path, "at", errors)) checkPattern(value.at, joinPath(path, "at"), PATTERNS.timestamp, errors)
}

function checkObserved(value, path, errors) {
  if (value === null) return
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["status", "at"], errors)
  if (requireField(value, path, "status", errors)) checkEnum(value.status, joinPath(path, "status"), ENUMS.jobStatus, errors)
  if (requireField(value, path, "at", errors)) checkPattern(value.at, joinPath(path, "at"), PATTERNS.timestamp, errors)
}

function checkBasis(value, path, errors) {
  if (!Array.isArray(value)) {
    addError(errors, "type", path)
    return
  }
  if (value.length === 0) {
    addError(errors, "empty", path)
    return
  }
  let sawInvalid = false
  value.forEach((entry) => {
    if (typeof entry !== "string" || !ENUMS.jobBasis.includes(entry)) sawInvalid = true
  })
  if (sawInvalid) addError(errors, "enum", path)
}

function checkJob(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["job", "basis", "transitions", "observed"], errors)
  if (requireField(value, path, "job", errors)) checkPattern(value.job, joinPath(path, "job"), PATTERNS.jobId, errors)
  if (requireField(value, path, "basis", errors)) checkBasis(value.basis, joinPath(path, "basis"), errors)
  if (requireField(value, path, "transitions", errors)) {
    checkArray(value.transitions, joinPath(path, "transitions"), { validate: checkTransition }, errors)
  }
  if (requireField(value, path, "observed", errors)) checkObserved(value.observed, joinPath(path, "observed"), errors)
}

function checkUnavailable(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  checkKnownKeys(value, path, ["field", "reason"], errors)
  if (requireField(value, path, "field", errors)) checkEnum(value.field, joinPath(path, "field"), ENUMS.unavailableField, errors)
  if (requireField(value, path, "reason", errors)) checkEnum(value.reason, joinPath(path, "reason"), ENUMS.unavailableReason, errors)
}

function checkSession(value, path, errors) {
  if (!isPlainObject(value)) {
    addError(errors, "type", path)
    return
  }
  const keys = ["host", "id", "host_version", "entrypoint", "started_at", "ended_at", "end_reason", "derived_through"]
  checkKnownKeys(value, path, keys, errors)
  if (requireField(value, path, "host", errors)) checkEnum(value.host, joinPath(path, "host"), ENUMS.host, errors)
  if (requireField(value, path, "id", errors)) checkPattern(value.id, joinPath(path, "id"), PATTERNS.sessionId, errors)
  if (requireField(value, path, "host_version", errors)) checkPattern(value.host_version, joinPath(path, "host_version"), PATTERNS.semver, errors)
  if (requireField(value, path, "entrypoint", errors)) checkEnum(value.entrypoint, joinPath(path, "entrypoint"), ENUMS.entrypoint, errors)

  let startedOk = false
  if (requireField(value, path, "started_at", errors)) startedOk = checkPattern(value.started_at, joinPath(path, "started_at"), PATTERNS.timestamp, errors)

  let endedOk = false
  let endedPresent = false
  if (requireField(value, path, "ended_at", errors)) {
    endedPresent = value.ended_at !== null
    endedOk = checkNullablePattern(value.ended_at, joinPath(path, "ended_at"), PATTERNS.timestamp, errors)
  }

  if (startedOk && endedPresent && endedOk && Date.parse(value.ended_at) < Date.parse(value.started_at)) {
    addError(errors, "order", joinPath(path, "ended_at"))
  }

  if (requireField(value, path, "end_reason", errors)) checkNullableEnum(value.end_reason, joinPath(path, "end_reason"), ENUMS.endReason, errors)
  if (requireField(value, path, "derived_through", errors)) checkPattern(value.derived_through, joinPath(path, "derived_through"), PATTERNS.timestamp, errors)
}

const TOP_LEVEL_KEYS = [
  "schema", "contributor", "session", "plugins", "models", "intervals",
  "agents", "counts", "refs", "jobs", "unavailable",
]

/**
 * `validateFacts(value) -> { ok, errors }`. Accepts an already-parsed value
 * (use `validateFactsBytes` for a raw buffer, which also enforces the byte
 * cap). Collects every violation rather than stopping at the first, but a
 * single-violation input surfaces exactly one error.
 */
export function validateFacts(value) {
  const errors = []
  if (!isPlainObject(value)) {
    addError(errors, "type", "")
    return { ok: false, errors }
  }

  checkKnownKeys(value, "", TOP_LEVEL_KEYS, errors)

  if (requireField(value, "", "schema", errors)) checkPattern(value.schema, "schema", PATTERNS.schema, errors)
  if (requireField(value, "", "contributor", errors)) checkPattern(value.contributor, "contributor", PATTERNS.contributor, errors)
  if (requireField(value, "", "session", errors)) checkSession(value.session, "session", errors)

  if (requireField(value, "", "plugins", errors)) {
    checkArray(value.plugins, "plugins", { max: LIMITS.plugins, validate: checkPlugin }, errors)
  }
  if (requireField(value, "", "models", errors)) {
    checkArray(value.models, "models", { max: LIMITS.models, validate: checkModel }, errors)
  }

  const agentIds = new Set()
  let agentsOk = false
  if (requireField(value, "", "agents", errors)) {
    agentsOk = Array.isArray(value.agents)
    checkArray(value.agents, "agents", { validate: checkAgent }, errors)
    if (agentsOk) {
      for (const agent of value.agents) {
        if (isPlainObject(agent) && Number.isSafeInteger(agent.n)) agentIds.add(agent.n)
      }
    }
  }

  if (requireField(value, "", "intervals", errors)) {
    const results = []
    checkArray(value.intervals, "intervals", {
      max: LIMITS.intervals,
      validate: (item, itemPath, itemErrors) => {
        results.push({ result: checkInterval(item, itemPath, itemErrors), path: itemPath })
      },
    }, errors)
    if (agentsOk) {
      for (const { result, path } of results) {
        if (result && result.agentOk && !agentIds.has(result.agent)) {
          addError(errors, "ref", joinPath(path, "agent"))
        }
      }
    }
  }

  if (requireField(value, "", "counts", errors)) checkCounts(value.counts, "counts", errors)
  if (requireField(value, "", "refs", errors)) checkRefs(value.refs, "refs", errors)
  if (requireField(value, "", "jobs", errors)) checkArray(value.jobs, "jobs", { validate: checkJob }, errors)
  if (requireField(value, "", "unavailable", errors)) {
    checkArray(value.unavailable, "unavailable", { validate: checkUnavailable }, errors)
  }

  return { ok: errors.length === 0, errors }
}

/**
 * Parse and validate raw bytes, enforcing the 16 MiB cap first so an
 * oversized file is never even handed to `JSON.parse`.
 */
export function validateFactsBytes(buffer) {
  if (buffer.length > LIMITS.maxBytes) {
    return { ok: false, errors: [{ code: "too_large", path: "" }] }
  }
  let parsed
  try {
    parsed = JSON.parse(buffer.toString("utf8"))
  } catch {
    return { ok: false, errors: [{ code: "json", path: "" }] }
  }
  return validateFacts(parsed)
}
