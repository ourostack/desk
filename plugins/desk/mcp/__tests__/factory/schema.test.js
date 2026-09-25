// Facts file v1 schema/privacy-gate tests.
//
// Every violating case below plants the sentinel string in the bad value
// (and, where the violation is about an unrecognized key, as the key name
// itself) where the violation is string-shaped, and asserts the sentinel
// never appears in the serialized errors — errors are `{ code, path }` only,
// never the offending value, and never the offending key name either.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { validateFacts, validateFactsBytes, ENUMS, PATTERNS, LIMITS, __SPECS__ } from "../../src/factory/schema.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN = JSON.parse(readFileSync(path.join(here, "fixtures", "facts-golden.json"), "utf8"))
const SENTINEL = "SENTINEL-7f3a"

function golden() {
  return structuredClone(GOLDEN)
}

function at(obj, keys) {
  let cur = obj
  for (const key of keys.slice(0, -1)) cur = cur[key]
  return cur
}

function setPath(obj, keys, value) {
  at(obj, keys)[keys[keys.length - 1]] = value
  return obj
}

function deletePath(obj, keys) {
  delete at(obj, keys)[keys[keys.length - 1]]
  return obj
}

function ps(keys) {
  return keys.join(".")
}

function assertSingle(result, code, pathStr) {
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [{ code, path: pathStr }])
}

function assertNoLeak(result) {
  assert.equal(JSON.stringify(result.errors).includes(SENTINEL), false)
}

test("the golden fixture validates cleanly", () => {
  const result = validateFacts(golden())
  assert.deepEqual(result, { ok: true, errors: [] })
})

test("a non-object top-level value fails with type at the root", () => {
  assertSingle(validateFacts(null), "type", "")
  assertSingle(validateFacts("nope"), "type", "")
  assertSingle(validateFacts([1, 2]), "type", "")
})

test("a non-string value in a pattern-checked field fails with type", () => {
  const result = validateFacts(setPath(golden(), ["contributor"], 12345))
  assertSingle(result, "type", "contributor")
})

test("a non-string value in an enum-checked field fails with type", () => {
  const result = validateFacts(setPath(golden(), ["session", "host"], 12345))
  assertSingle(result, "type", "session.host")
})

test("a non-string value in a timestamp-checked field fails with type", () => {
  const result = validateFacts(setPath(golden(), ["session", "started_at"], 12345))
  assertSingle(result, "type", "session.started_at")
})

// --- One violation per value-rule-table row -------------------------------

const SIMPLE_VIOLATIONS = [
  { name: "schema must match the literal pattern", keys: ["schema"], value: `desk.factory.facts/2 ${SENTINEL}`, code: "pattern", path: "schema" },
  { name: "contributor must be 16 lowercase hex", keys: ["contributor"], value: SENTINEL, code: "pattern", path: "contributor" },
  { name: "session.host must be a known host", keys: ["session", "host"], value: SENTINEL, code: "enum", path: "session.host" },
  { name: "session.id must be a UUID", keys: ["session", "id"], value: SENTINEL, code: "pattern", path: "session.id" },
  { name: "a sentence in session.id fails as a pattern violation", keys: ["session", "id"], value: `please read my prompt ${SENTINEL}`, code: "pattern", path: "session.id" },
  { name: "session.host_version must be semver", keys: ["session", "host_version"], value: SENTINEL, code: "pattern", path: "session.host_version" },
  { name: "plugins[].version must be semver", keys: ["plugins", 0, "version"], value: SENTINEL, code: "pattern", path: "plugins.0.version" },
  { name: "session.entrypoint must be a known entrypoint", keys: ["session", "entrypoint"], value: SENTINEL, code: "enum", path: "session.entrypoint" },
  { name: "session.started_at must match the timestamp pattern", keys: ["session", "started_at"], value: SENTINEL, code: "pattern", path: "session.started_at" },
  { name: "session.ended_at must match the timestamp pattern when non-null", keys: ["session", "ended_at"], value: SENTINEL, code: "pattern", path: "session.ended_at" },
  { name: "session.end_reason must be a known reason or null", keys: ["session", "end_reason"], value: SENTINEL, code: "enum", path: "session.end_reason" },
  { name: "session.derived_through must match the timestamp pattern", keys: ["session", "derived_through"], value: SENTINEL, code: "pattern", path: "session.derived_through" },
  { name: "plugins[].name must match the plugin-name pattern", keys: ["plugins", 0, "name"], value: SENTINEL, code: "pattern", path: "plugins.0.name" },
  { name: "models[].id must match the model-id pattern", keys: ["models", 0, "id"], value: `bad model ${SENTINEL}`, code: "pattern", path: "models.0.id" },
  { name: "models[].requests must be a safe non-negative integer or null", keys: ["models", 0, "requests"], value: SENTINEL, code: "integer", path: "models.0.requests" },
  { name: "models[].tokens.input must be a safe non-negative integer or null", keys: ["models", 0, "tokens", "input"], value: -5, code: "integer", path: "models.0.tokens.input" },
  { name: "intervals[].kind must be a known kind", keys: ["intervals", 0, "kind"], value: SENTINEL, code: "enum", path: "intervals.0.kind" },
  { name: "intervals[].start must match the timestamp pattern", keys: ["intervals", 0, "start"], value: SENTINEL, code: "pattern", path: "intervals.0.start" },
  { name: "intervals[].end must match the timestamp pattern", keys: ["intervals", 0, "end"], value: SENTINEL, code: "pattern", path: "intervals.0.end" },
  { name: "intervals[].tool must be ENUMS.toolKind", keys: ["intervals", 1, "tool"], value: SENTINEL, code: "enum", path: "intervals.1.tool" },
  { name: "intervals[].outcome must be a known outcome", keys: ["intervals", 1, "outcome"], value: SENTINEL, code: "enum", path: "intervals.1.outcome" },
  { name: "agents[].model must match the model-id pattern", keys: ["agents", 1, "model"], value: `bad model ${SENTINEL}`, code: "pattern", path: "agents.1.model" },
  { name: "counts.tool_retries and siblings must be safe non-negative integers", keys: ["counts", "tool_retries"], value: -1, code: "integer", path: "counts.tool_retries" },
  { name: "refs.prs[].repo must match owner/repo", keys: ["refs", "prs", 0, "repo"], value: SENTINEL, code: "pattern", path: "refs.prs.0.repo" },
  { name: "refs.prs[].number must be a positive integer", keys: ["refs", "prs", 0, "number"], value: 0, code: "integer", path: "refs.prs.0.number" },
  { name: "refs.commits[].sha must be 40 lowercase hex", keys: ["refs", "commits", 0, "sha"], value: SENTINEL, code: "pattern", path: "refs.commits.0.sha" },
  { name: "jobs[].job must be 32 lowercase hex", keys: ["jobs", 0, "job"], value: SENTINEL, code: "pattern", path: "jobs.0.job" },
  { name: "jobs[].transitions[].to must be a job status", keys: ["jobs", 0, "transitions", 0, "to"], value: SENTINEL, code: "enum", path: "jobs.0.transitions.0.to" },
  { name: "jobs[].transitions[].at must match the timestamp pattern", keys: ["jobs", 0, "transitions", 0, "at"], value: SENTINEL, code: "pattern", path: "jobs.0.transitions.0.at" },
  { name: "jobs[].observed.status must be a job status", keys: ["jobs", 0, "observed", "status"], value: SENTINEL, code: "enum", path: "jobs.0.observed.status" },
  { name: "jobs[].observed.at must match the timestamp pattern", keys: ["jobs", 0, "observed", "at"], value: SENTINEL, code: "pattern", path: "jobs.0.observed.at" },
  { name: "unavailable[].field must be a known field", keys: ["unavailable", 0, "field"], value: SENTINEL, code: "enum", path: "unavailable.0.field" },
  { name: "unavailable[].reason must be a known reason", keys: ["unavailable", 0, "reason"], value: SENTINEL, code: "enum", path: "unavailable.0.reason" },
]

for (const spec of SIMPLE_VIOLATIONS) {
  test(spec.name, () => {
    const value = setPath(golden(), spec.keys, spec.value)
    const result = validateFacts(value)
    assertSingle(result, spec.code, spec.path)
    if (typeof spec.value === "string" && spec.value.includes(SENTINEL)) assertNoLeak(result)
  })
}

// --- Minor ruling M1: the semver prerelease part is bounded to 32 chars ----

test("a semver prerelease part over 32 characters fails with pattern", () => {
  const result = validateFacts(setPath(golden(), ["session", "host_version"], `1.0.0-${"a".repeat(33)}`))
  assertSingle(result, "pattern", "session.host_version")
})

test("a semver prerelease part of exactly 32 characters is accepted", () => {
  const result = validateFacts(setPath(golden(), ["session", "host_version"], `1.0.0-${"a".repeat(32)}`))
  assert.equal(result.ok, true)
})

// --- Minor ruling M2: a timestamp that matches the pattern but is not a real instant is `pattern`, not silently skipped

test("a shape-only timestamp that Date.parse cannot resolve fails with pattern (session.started_at)", () => {
  const result = validateFacts(setPath(golden(), ["session", "started_at"], "2026-13-40T25:61:61.999Z"))
  assertSingle(result, "pattern", "session.started_at")
})

test("a shape-only timestamp that Date.parse cannot resolve fails with pattern (intervals[].start), and the order check does not crash on it", () => {
  const result = validateFacts(setPath(golden(), ["intervals", 0, "start"], "2026-13-40T25:61:61.999Z"))
  assertSingle(result, "pattern", "intervals.0.start")
})

// --- Range rules: intervals[].agent, agents[].n, agents[].parent ----------

test("intervals[].agent below range fails with range", () => {
  const result = validateFacts(setPath(golden(), ["intervals", 0, "agent"], -1))
  assertSingle(result, "range", "intervals.0.agent")
})

test("intervals[].agent above range fails with range", () => {
  const result = validateFacts(setPath(golden(), ["intervals", 0, "agent"], 10000))
  assertSingle(result, "range", "intervals.0.agent")
})

test("agents[].n above range fails with range (agent 1 is unreferenced by any interval)", () => {
  const result = validateFacts(setPath(golden(), ["agents", 1, "n"], 10000))
  assertSingle(result, "range", "agents.1.n")
})

test("agents[].n that is not a safe integer fails with range", () => {
  const result = validateFacts(setPath(golden(), ["agents", 1, "n"], 1.5))
  assertSingle(result, "range", "agents.1.n")
})

test("agents[].parent out of range fails with range", () => {
  const result = validateFacts(setPath(golden(), ["agents", 0, "parent"], 10000))
  assertSingle(result, "range", "agents.0.parent")
})

test("agents[].parent may be null", () => {
  const result = validateFacts(setPath(golden(), ["agents", 0, "parent"], null))
  assert.equal(result.ok, true)
})

// --- Minor ruling M3: agents[].n uniqueness and agents[].parent existence --

test("a duplicate agents[].n fails with duplicate, naming the later occurrence", () => {
  const result = validateFacts(setPath(golden(), ["agents", 1, "n"], 0))
  assertSingle(result, "duplicate", "agents.1.n")
})

test("agents[].parent naming an agent that does not exist fails with reference", () => {
  const result = validateFacts(setPath(golden(), ["agents", 0, "parent"], 5))
  assertSingle(result, "reference", "agents.0.parent")
})

test("agents[].parent naming a real agent is accepted (golden fixture: agent 1's parent is agent 0)", () => {
  const result = validateFacts(golden())
  assert.equal(result.ok, true)
})

// --- Nullable fields: positive cases ---------------------------------------

test("session.ended_at may be null", () => {
  const result = validateFacts(setPath(golden(), ["session", "ended_at"], null))
  assert.equal(result.ok, true)
})

test("session.end_reason may be null", () => {
  const result = validateFacts(setPath(golden(), ["session", "end_reason"], null))
  assert.equal(result.ok, true)
})

test("models[].requests may be null", () => {
  const result = validateFacts(setPath(golden(), ["models", 0, "requests"], null))
  assert.equal(result.ok, true)
})

test("models[].tokens.* may be null (reasoning already is in the golden fixture)", () => {
  const result = validateFacts(setPath(golden(), ["models", 0, "tokens", "output"], null))
  assert.equal(result.ok, true)
})

test("jobs[].observed may be null", () => {
  const result = validateFacts(setPath(golden(), ["jobs", 0, "observed"], null))
  assert.equal(result.ok, true)
})

// --- Chronological order ---------------------------------------------------

test("session.ended_at before session.started_at fails with order", () => {
  const result = validateFacts(setPath(golden(), ["session", "ended_at"], "2026-09-25T07:00:00.000Z"))
  assertSingle(result, "order", "session.ended_at")
})

test("intervals[].end before intervals[].start fails with order", () => {
  const result = validateFacts(setPath(golden(), ["intervals", 0, "end"], "2026-09-25T07:00:00.000Z"))
  assertSingle(result, "order", "intervals.0.end")
})

// --- intervals[].tool / outcome: required for kind=tool, forbidden otherwise

test("intervals[].tool is required when kind is tool", () => {
  const result = validateFacts(deletePath(golden(), ["intervals", 1, "tool"]))
  assertSingle(result, "missing", "intervals.1.tool")
})

test("intervals[].outcome is required when kind is tool", () => {
  const result = validateFacts(deletePath(golden(), ["intervals", 1, "outcome"]))
  assertSingle(result, "missing", "intervals.1.outcome")
})

test("intervals[].tool is forbidden when kind is not tool (surfaces as an unrecognized key, since the walker's allow-list is kind-dependent)", () => {
  const result = validateFacts(setPath(golden(), ["intervals", 0, "tool"], "shell"))
  assertSingle(result, "unknown_key", "intervals.0")
})

test("intervals[].outcome is forbidden when kind is not tool (surfaces as an unrecognized key)", () => {
  const result = validateFacts(setPath(golden(), ["intervals", 0, "outcome"], "ok"))
  assertSingle(result, "unknown_key", "intervals.0")
})

// --- Every interval's agent must exist in agents ---------------------------

test("an interval referencing an unknown agent fails with ref", () => {
  const result = validateFacts(setPath(golden(), ["intervals", 0, "agent"], 5))
  assertSingle(result, "ref", "intervals.0.agent")
})

test("a malformed agents array suppresses ref checking rather than cascading", () => {
  const value = golden()
  value.agents = "not-an-array"
  const result = validateFacts(value)
  assertSingle(result, "type", "agents")
})

// --- counts.tool_calls / tool_failures maps ---------------------------------

test("an unrecognized key in counts.tool_calls fails with unknown_key naming the map, not the key (sentinel planted as the key name)", () => {
  const value = golden()
  value.counts.tool_calls[SENTINEL] = 1
  const result = validateFacts(value)
  assertSingle(result, "unknown_key", "counts.tool_calls")
  assertNoLeak(result)
})

test("an unrecognized key in counts.tool_failures fails with unknown_key naming the map, not the key (sentinel planted as the key name)", () => {
  const value = golden()
  value.counts.tool_failures[SENTINEL] = 1
  const result = validateFacts(value)
  assertSingle(result, "unknown_key", "counts.tool_failures")
  assertNoLeak(result)
})

test("a negative value in counts.tool_calls fails with integer", () => {
  const value = golden()
  value.counts.tool_calls.shell = -1
  const result = validateFacts(value)
  assertSingle(result, "integer", "counts.tool_calls.shell")
})

// --- jobs[].basis: non-empty, duplicate-free subset of ENUMS.jobBasis ------

test("an empty jobs[].basis fails with empty", () => {
  const result = validateFacts(setPath(golden(), ["jobs", 0, "basis"], []))
  assertSingle(result, "empty", "jobs.0.basis")
})

test("a jobs[].basis entry outside the enum fails with enum", () => {
  const result = validateFacts(setPath(golden(), ["jobs", 0, "basis"], ["desk_tool", "bogus"]))
  assertSingle(result, "enum", "jobs.0.basis")
})

test("a non-string jobs[].basis entry fails with enum", () => {
  const result = validateFacts(setPath(golden(), ["jobs", 0, "basis"], [42]))
  assertSingle(result, "enum", "jobs.0.basis")
})

test("a non-array jobs[].basis fails with type", () => {
  const result = validateFacts(setPath(golden(), ["jobs", 0, "basis"], "desk_tool"))
  assertSingle(result, "type", "jobs.0.basis")
})

test("a duplicated jobs[].basis entry fails with duplicate", () => {
  const result = validateFacts(setPath(golden(), ["jobs", 0, "basis"], ["desk_tool", "desk_tool"]))
  assertSingle(result, "duplicate", "jobs.0.basis")
})

// --- Oversized arrays: too_many, and their at-limit boundary --------------

function fillWithSentinel(template, count) {
  return new Array(count).fill(0).map(() => ({ ...template }))
}

test("more than 64 plugins fails with too_many (sentinel planted in the unread items, no leak)", () => {
  const value = golden()
  value.plugins = fillWithSentinel({ name: "desk", version: SENTINEL }, LIMITS.plugins + 1)
  const result = validateFacts(value)
  assertSingle(result, "too_many", "plugins")
  assertNoLeak(result)
})

test("exactly 64 plugins is accepted", () => {
  const value = golden()
  value.plugins = fillWithSentinel({ name: "desk", version: "1.0.0" }, LIMITS.plugins)
  assert.equal(validateFacts(value).ok, true)
})

test("more than 32 models fails with too_many", () => {
  const value = golden()
  value.models = new Array(LIMITS.models + 1).fill(value.models[0])
  assertSingle(validateFacts(value), "too_many", "models")
})

test("exactly 32 models is accepted", () => {
  const value = golden()
  value.models = new Array(LIMITS.models).fill(value.models[0])
  assert.equal(validateFacts(value).ok, true)
})

test("more than 100000 intervals fails with too_many", () => {
  const value = golden()
  value.intervals = new Array(LIMITS.intervals + 1).fill(value.intervals[0])
  assertSingle(validateFacts(value), "too_many", "intervals")
})

test("exactly 100000 intervals is accepted", () => {
  const value = golden()
  value.intervals = new Array(LIMITS.intervals).fill(value.intervals[0])
  assert.equal(validateFacts(value).ok, true)
})

test("more than 500 PR refs fails with too_many", () => {
  const value = golden()
  value.refs.prs = new Array(LIMITS.prs + 1).fill(value.refs.prs[0])
  assertSingle(validateFacts(value), "too_many", "refs.prs")
})

test("exactly 500 PR refs is accepted", () => {
  const value = golden()
  value.refs.prs = new Array(LIMITS.prs).fill(value.refs.prs[0])
  assert.equal(validateFacts(value).ok, true)
})

test("more than 2000 commit refs fails with too_many", () => {
  const value = golden()
  value.refs.commits = new Array(LIMITS.commits + 1).fill(value.refs.commits[0])
  assertSingle(validateFacts(value), "too_many", "refs.commits")
})

test("exactly 2000 commit refs is accepted", () => {
  const value = golden()
  value.refs.commits = new Array(LIMITS.commits).fill(value.refs.commits[0])
  assert.equal(validateFacts(value).ok, true)
})

test("more than 10000 agents fails with too_many", () => {
  const value = golden()
  value.agents = new Array(LIMITS.agents + 1).fill(value.agents[0])
  assertSingle(validateFacts(value), "too_many", "agents")
})

test("exactly 10000 agents (each with a unique n) is accepted", () => {
  const value = golden()
  value.agents = Array.from({ length: LIMITS.agents }, (_, index) => ({ n: index, parent: null, model: "claude-opus-5-5" }))
  assert.equal(validateFacts(value).ok, true)
})

test("more than 1000 jobs fails with too_many", () => {
  const value = golden()
  value.jobs = new Array(LIMITS.jobs + 1).fill(value.jobs[0])
  assertSingle(validateFacts(value), "too_many", "jobs")
})

test("exactly 1000 jobs is accepted", () => {
  const value = golden()
  value.jobs = new Array(LIMITS.jobs).fill(value.jobs[0])
  assert.equal(validateFacts(value).ok, true)
})

test("more than 1000 transitions in one job fails with too_many", () => {
  const value = golden()
  value.jobs[0].transitions = new Array(LIMITS.jobTransitions + 1).fill(value.jobs[0].transitions[0])
  assertSingle(validateFacts(value), "too_many", "jobs.0.transitions")
})

test("exactly 1000 transitions in one job is accepted", () => {
  const value = golden()
  value.jobs[0].transitions = new Array(LIMITS.jobTransitions).fill(value.jobs[0].transitions[0])
  assert.equal(validateFacts(value).ok, true)
})

test("more than 64 unavailable entries fails with too_many", () => {
  const value = golden()
  value.unavailable = new Array(LIMITS.unavailable + 1).fill(value.unavailable[0])
  assertSingle(validateFacts(value), "too_many", "unavailable")
})

test("exactly 64 unavailable entries is accepted", () => {
  const value = golden()
  value.unavailable = new Array(LIMITS.unavailable).fill(value.unavailable[0])
  assert.equal(validateFacts(value).ok, true)
})

// --- unknown_key at every object level, sentinel planted as the key itself -

const UNKNOWN_KEY_LEVELS = [
  { label: "top level", keys: [], path: "" },
  { label: "session", keys: ["session"], path: "session" },
  { label: "plugins[]", keys: ["plugins", 0], path: "plugins.0" },
  { label: "models[]", keys: ["models", 0], path: "models.0" },
  { label: "models[].tokens", keys: ["models", 0, "tokens"], path: "models.0.tokens" },
  { label: "intervals[]", keys: ["intervals", 0], path: "intervals.0" },
  { label: "agents[]", keys: ["agents", 0], path: "agents.0" },
  { label: "counts", keys: ["counts"], path: "counts" },
  { label: "refs", keys: ["refs"], path: "refs" },
  { label: "refs.prs[]", keys: ["refs", "prs", 0], path: "refs.prs.0" },
  { label: "refs.commits[]", keys: ["refs", "commits", 0], path: "refs.commits.0" },
  { label: "jobs[]", keys: ["jobs", 0], path: "jobs.0" },
  { label: "jobs[].transitions[]", keys: ["jobs", 0, "transitions", 0], path: "jobs.0.transitions.0" },
  { label: "jobs[].observed", keys: ["jobs", 0, "observed"], path: "jobs.0.observed" },
  { label: "unavailable[]", keys: ["unavailable", 0], path: "unavailable.0" },
]

for (const level of UNKNOWN_KEY_LEVELS) {
  test(`an unknown key named with the sentinel at ${level.label} fails with unknown_key naming the container, not the key`, () => {
    const value = golden()
    const target = level.keys.length === 0 ? value : at(value, [...level.keys, "x"])
    target[SENTINEL] = true
    const result = validateFacts(value)
    assertSingle(result, "unknown_key", level.path)
    assertNoLeak(result)
  })
}

// --- missing: every required field, at every level --------------------------

const MISSING_CASES = [
  [["schema"]], [["contributor"]], [["session"]], [["plugins"]], [["models"]],
  [["agents"]], [["intervals"]], [["counts"]], [["refs"]], [["jobs"]], [["unavailable"]],
  [["session", "host"]], [["session", "id"]], [["session", "host_version"]], [["session", "entrypoint"]],
  [["session", "started_at"]], [["session", "ended_at"]], [["session", "end_reason"]], [["session", "derived_through"]],
  [["plugins", 0, "name"]], [["plugins", 0, "version"]],
  [["models", 0, "id"]], [["models", 0, "requests"]], [["models", 0, "tokens"]], [["models", 0, "tokens", "input"]],
  [["intervals", 0, "kind"]], [["intervals", 0, "agent"]], [["intervals", 0, "start"]], [["intervals", 0, "end"]],
  [["intervals", 1, "tool"]], [["intervals", 1, "outcome"]],
  [["agents", 1, "n"]], [["agents", 1, "parent"]], [["agents", 1, "model"]],
  [["counts", "tool_calls"]], [["counts", "tool_failures"]], [["counts", "tool_retries"]],
  [["refs", "prs"]], [["refs", "commits"]],
  [["refs", "prs", 0, "repo"]], [["refs", "prs", 0, "number"]], [["refs", "commits", 0, "sha"]],
  [["jobs", 0, "job"]], [["jobs", 0, "basis"]], [["jobs", 0, "transitions"]], [["jobs", 0, "observed"]],
  [["jobs", 0, "transitions", 0, "to"]], [["jobs", 0, "transitions", 0, "at"]],
  [["jobs", 0, "observed", "status"]], [["jobs", 0, "observed", "at"]],
  [["unavailable", 0, "field"]], [["unavailable", 0, "reason"]],
]

for (const [keys] of MISSING_CASES) {
  test(`a missing ${ps(keys)} fails with missing`, () => {
    const result = validateFacts(deletePath(golden(), keys))
    assertSingle(result, "missing", ps(keys))
  })
}

// --- type: every nested object/array field, given the wrong shape ----------

const badScalar = `${SENTINEL} is not an object`

const OBJECT_TYPE_CASES = [
  ["session"], ["plugins", 0], ["models", 0], ["models", 0, "tokens"],
  ["intervals", 0], ["agents", 1], ["counts"], ["counts", "tool_calls"], ["counts", "tool_failures"],
  ["refs"], ["refs", "prs", 0], ["refs", "commits", 0],
  ["jobs", 0], ["jobs", 0, "transitions", 0], ["jobs", 0, "observed"], ["unavailable", 0],
]

for (const keys of OBJECT_TYPE_CASES) {
  test(`${ps(keys)} of the wrong type fails with type`, () => {
    const result = validateFacts(setPath(golden(), keys, badScalar))
    assertSingle(result, "type", ps(keys))
    assertNoLeak(result)
  })
}

const ARRAY_TYPE_CASES = [
  ["plugins"], ["models"], ["intervals"], ["refs", "prs"], ["refs", "commits"],
  ["jobs"], ["unavailable"], ["jobs", 0, "transitions"],
]

for (const keys of ARRAY_TYPE_CASES) {
  test(`${ps(keys)} that is not an array fails with type`, () => {
    const result = validateFacts(setPath(golden(), keys, badScalar))
    assertSingle(result, "type", ps(keys))
    assertNoLeak(result)
  })
}

test("jobs[].observed of the wrong non-null type fails with type", () => {
  const result = validateFacts(setPath(golden(), ["jobs", 0, "observed"], badScalar))
  assertSingle(result, "type", "jobs.0.observed")
  assertNoLeak(result)
})

// --- validateFactsBytes ------------------------------------------------------

test("validateFactsBytes rejects a buffer over the 16 MiB cap without parsing it", () => {
  const buffer = Buffer.alloc(LIMITS.maxBytes + 1)
  const result = validateFactsBytes(buffer)
  assert.deepEqual(result, { ok: false, errors: [{ code: "too_large", path: "" }] })
})

test("validateFactsBytes measures the cap in bytes, not characters: a string of multi-byte characters under the char count but over the byte cap fails with too_large", () => {
  // "€" is 1 UTF-16 code unit (so `.length` counts it as 1) but 3 UTF-8 bytes.
  // At maxBytes/2 characters the byte length (3x) is well over the cap while
  // the character length is well under it — this is exactly what a naive
  // `.length` cap check would miss.
  const text = "€".repeat(Math.floor(LIMITS.maxBytes / 2))
  assert.ok(text.length < LIMITS.maxBytes)
  const result = validateFactsBytes(text)
  assert.deepEqual(result, { ok: false, errors: [{ code: "too_large", path: "" }] })
})

test("validateFactsBytes rejects bytes that are not valid JSON", () => {
  const result = validateFactsBytes(Buffer.from("{not json", "utf8"))
  assert.deepEqual(result, { ok: false, errors: [{ code: "json", path: "" }] })
})

test("validateFactsBytes rejects bytes with a duplicate JSON key even though the parsed value looks valid (I1: canonical bytes)", () => {
  const raw = `{"schema":"desk.factory.facts/1","contributor":"${SENTINEL} the customer password is hunter2","contributor":"0f3a9c1d2b4e6f70"}`
  // JSON.parse silently keeps only the last "contributor" — the value it sees is valid — but the
  // raw bytes that would actually be committed to a store still carry the sentence.
  assert.equal(JSON.parse(raw).contributor, "0f3a9c1d2b4e6f70")
  const result = validateFactsBytes(Buffer.from(raw, "utf8"))
  assert.deepEqual(result, { ok: false, errors: [{ code: "canonical", path: "" }] })
  assertNoLeak(result)
})

test("validateFactsBytes accepts canonical bytes with exactly one trailing newline", () => {
  const text = `${JSON.stringify(golden())}\n`
  const result = validateFactsBytes(Buffer.from(text, "utf8"))
  assert.deepEqual(result, { ok: true, errors: [] })
})

test("validateFactsBytes rejects non-canonical whitespace padding (more than one trailing newline)", () => {
  const text = `${JSON.stringify(golden())}\n\n`
  const result = validateFactsBytes(Buffer.from(text, "utf8"))
  assert.deepEqual(result, { ok: false, errors: [{ code: "canonical", path: "" }] })
})

test("validateFactsBytes also accepts a plain string (not just a Buffer) under the cap", () => {
  const result = validateFactsBytes(JSON.stringify(golden()))
  assert.deepEqual(result, { ok: true, errors: [] })
})

test("validateFactsBytes accepts valid JSON bytes carrying the golden fixture", () => {
  const result = validateFactsBytes(Buffer.from(JSON.stringify(golden()), "utf8"))
  assert.deepEqual(result, { ok: true, errors: [] })
})

test("validateFactsBytes delegates to validateFacts for valid JSON with an invalid shape", () => {
  const result = validateFactsBytes(Buffer.from(JSON.stringify(setPath(golden(), ["contributor"], "bad")), "utf8"))
  assertSingle(result, "pattern", "contributor")
})

// --- Exported surface --------------------------------------------------------

test("ENUMS matches the brief's table exactly, and every array (and ENUMS itself) is frozen", () => {
  assert.ok(Object.isFrozen(ENUMS))
  const table = {
    host: ["claude-code", "copilot-cli"],
    entrypoint: ["cli", "desktop", "sdk", "launcher", "unknown"],
    endReason: ["clear", "resume", "logout", "prompt_input_exit", "complete", "user_exit", "error", "other"],
    toolKind: ["read", "edit", "shell", "search", "web", "agent", "desk", "skill", "mcp", "plan", "other"],
    intervalKind: ["turn", "tool", "subagent", "human_wait", "permission_wait", "api_retry", "compaction"],
    outcome: ["ok", "error", "denied", "interrupted", "timeout"],
    jobStatus: ["drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled"],
    jobBasis: ["desk_tool", "file_write", "desk_commit"],
    unavailableField: [
      "tokens", "requests", "models", "turns", "tool_durations", "permission_waits",
      "human_waits", "api_retries", "commits", "ci_runs", "plugins", "ended_at",
    ],
    unavailableReason: [
      "host_does_not_record", "log_missing", "log_truncated", "session_open",
      "not_collected_in_slice_1", "source_unreadable",
    ],
  }
  assert.deepEqual(Object.keys(ENUMS).sort(), Object.keys(table).sort())
  for (const [name, expected] of Object.entries(table)) {
    assert.deepEqual(ENUMS[name], expected, name)
    assert.ok(Object.isFrozen(ENUMS[name]), `ENUMS.${name} should be frozen`)
  }
})

test("PATTERNS and LIMITS are frozen", () => {
  assert.ok(Object.isFrozen(PATTERNS))
  assert.ok(Object.isFrozen(LIMITS))
})

// --- I2: the spec walker is real — every allowed key carries a validator ---

test("every field in every level spec carries a real check function (the allow-list and the validators cannot disagree)", () => {
  for (const [levelName, spec] of Object.entries(__SPECS__)) {
    assert.ok(spec && typeof spec === "object", levelName)
    for (const [fieldName, field] of Object.entries(spec)) {
      assert.equal(typeof field.check, "function", `${levelName}.${fieldName} should carry a check function`)
    }
  }
})
