// Published facts v1 (`desk.factory.published/1`): the public gate the
// factory stores' CI runs on every intake PR.
//
// As in `schema.test.js`, every violating case plants the sentinel where the
// violation is string-shaped (or as an unknown key's own name) and asserts it
// never appears in the serialized errors: errors are `{ code, path }` only.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  validatePublished,
  validatePublishedBytes,
  PUBLISHED_SCHEMA,
  PUBLISHED_LIMITS,
  DATE_SHAPE,
  __PUBLISHED_SPECS__,
} from "../../src/factory/published-schema.js"
import { LIMITS } from "../../src/factory/schema.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_BYTES = readFileSync(path.join(here, "fixtures", "published-golden.json"))
const GOLDEN = JSON.parse(GOLDEN_BYTES.toString("utf8"))
const LOCAL_GOLDEN = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
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

const ps = (keys) => keys.join(".")

function assertSingle(result, code, pathStr) {
  assert.equal(result.ok, false)
  assert.deepEqual(result.errors, [{ code, path: pathStr }])
}

function assertNoLeak(result) {
  assert.equal(JSON.stringify(result.errors).includes(SENTINEL), false)
}

// ---------------------------------------------------------------------------
// The golden file.
// ---------------------------------------------------------------------------

test("the golden published file validates, as a value and as its exact bytes", () => {
  assert.deepEqual(validatePublished(golden()), { ok: true, errors: [] })
  assert.deepEqual(validatePublishedBytes(GOLDEN_BYTES), { ok: true, errors: [] })
  assert.equal(GOLDEN.schema, PUBLISHED_SCHEMA)
  assert.equal(PUBLISHED_SCHEMA, "desk.factory.published/1")
})

test("a local facts file is refused by the public gate", () => {
  const result = validatePublished(structuredClone(LOCAL_GOLDEN))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === "pattern" && error.path === "schema"))
})

test("a non-object top-level value fails with type at the root", () => {
  assertSingle(validatePublished(null), "type", "")
  assertSingle(validatePublished("nope"), "type", "")
  assertSingle(validatePublished([1]), "type", "")
})

// ---------------------------------------------------------------------------
// No when: the local time fields are unknown keys here.
// ---------------------------------------------------------------------------

const LOCAL_TIME_KEYS = [
  { keys: ["session", "started_at"], path: "session" },
  { keys: ["session", "ended_at"], path: "session" },
  { keys: ["session", "derived_through"], path: "session" },
  { keys: ["intervals", 0, "start"], path: "intervals.0" },
  { keys: ["intervals", 0, "end"], path: "intervals.0" },
  { keys: ["jobs", 0, "task_created_at"], path: "jobs.0" },
  { keys: ["jobs", 0, "transitions", 0, "at"], path: "jobs.0.transitions.0" },
  { keys: ["jobs", 0, "observed", "at"], path: "jobs.0.observed" },
]

for (const { keys, path: containerPath } of LOCAL_TIME_KEYS) {
  test(`a local time field ${ps(keys)} is an unknown key in a published file`, () => {
    const result = validatePublished(setPath(golden(), keys, "2026-09-25T08:00:00.000Z"))
    assertSingle(result, "unknown_key", containerPath)
  })
}

// ---------------------------------------------------------------------------
// No who.
// ---------------------------------------------------------------------------

for (const key of ["contributor", "operator", "machine", "hostname", "account", "branch", "desk"]) {
  test(`an identity key ${key} at the top level is an unknown key`, () => {
    const result = validatePublished({ ...golden(), [key]: "0f3a9c1d2b4e6f70" })
    assertSingle(result, "unknown_key", "")
  })
}

// ---------------------------------------------------------------------------
// Date-shaped strings are refused everywhere.
// ---------------------------------------------------------------------------

function stringLeaves(value, keys = []) {
  if (typeof value === "string") return [keys]
  if (value === null || typeof value !== "object") return []
  return Object.entries(value).flatMap(([key, child]) => stringLeaves(child, [...keys, Array.isArray(value) ? Number(key) : key]))
}

test("DATE_SHAPE matches an ISO date anywhere in a string", () => {
  assert.ok(DATE_SHAPE.test("2026-09-25"))
  assert.ok(DATE_SHAPE.test("gpt-4o-2024-08-06"))
  assert.ok(DATE_SHAPE.test("2026-09-25T08:00:00.000Z"))
  assert.equal(DATE_SHAPE.test("claude-3-5-sonnet-20241022"), false)
  assert.equal(DATE_SHAPE.test("3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"), false)
})

test("every string field in the golden file refuses a date-shaped value, naming only its path", () => {
  const leaves = stringLeaves(golden())
  assert.ok(leaves.length > 20)
  for (const keys of leaves) {
    for (const bad of ["2026-09-25", "2026-09-25T08:00:00.000Z", `${SENTINEL}-2026-09-25`]) {
      const result = validatePublished(setPath(golden(), keys, bad))
      assert.equal(result.ok, false, `${ps(keys)} accepted ${bad}`)
      // A basis entry is checked as part of its array.
      const expected = keys.includes("basis") ? ps(keys.slice(0, keys.indexOf("basis") + 1)) : ps(keys)
      assert.ok(result.errors.some((error) => error.path === expected && ["date", "pattern", "enum"].includes(error.code)), `${ps(keys)}: ${JSON.stringify(result.errors)}`)
      assertNoLeak(result)
    }
  }
})

const PATTERN_DATES = [
  { keys: ["models", 0, "id"], value: "gpt-4o-2024-08-06" },
  { keys: ["models", 0, "id"], value: `${SENTINEL}-2026-09-25T08` },
  { keys: ["agents", 0, "model"], value: "gpt-4o-2024-08-06" },
  { keys: ["plugins", 0, "name"], value: "notes-2026-09-25" },
  { keys: ["refs", "prs", 0, "repo"], value: "acme/log-2026-09-25" },
  { keys: ["refs", "commits", 0, "repo"], value: "acme/2026-09-25" },
]

for (const { keys, value } of PATTERN_DATES) {
  test(`a date inside an otherwise valid ${ps(keys)} fails with date`, () => {
    const result = validatePublished(setPath(golden(), keys, value))
    assertSingle(result, "date", ps(keys))
    assertNoLeak(result)
  })
}

// ---------------------------------------------------------------------------
// One violation per value rule.
// ---------------------------------------------------------------------------

const SIMPLE_VIOLATIONS = [
  { keys: ["schema"], value: `desk.factory.published/2 ${SENTINEL}`, code: "pattern" },
  { keys: ["schema"], value: "desk.factory.local/1", code: "pattern" },
  { keys: ["session", "host"], value: SENTINEL, code: "enum" },
  { keys: ["session", "id"], value: SENTINEL, code: "pattern" },
  { keys: ["session", "host_version"], value: SENTINEL, code: "pattern" },
  { keys: ["session", "entrypoint"], value: SENTINEL, code: "enum" },
  { keys: ["session", "duration_ms"], value: -1, code: "integer" },
  { keys: ["session", "duration_ms"], value: 1.5, code: "integer" },
  { keys: ["session", "duration_ms"], value: null, code: "integer" },
  { keys: ["session", "ended"], value: SENTINEL, code: "type" },
  { keys: ["session", "ended"], value: null, code: "type" },
  { keys: ["session", "end_reason"], value: SENTINEL, code: "enum" },
  { keys: ["plugins", 0, "name"], value: SENTINEL, code: "pattern" },
  { keys: ["plugins", 0, "version"], value: SENTINEL, code: "pattern" },
  { keys: ["models", 0, "id"], value: `bad model ${SENTINEL}`, code: "pattern" },
  { keys: ["models", 0, "requests"], value: SENTINEL, code: "integer" },
  { keys: ["models", 0, "tokens", "input"], value: -5, code: "integer" },
  { keys: ["agents", 1, "model"], value: `bad model ${SENTINEL}`, code: "pattern" },
  { keys: ["agents", 1, "n"], value: 10000, code: "range" },
  { keys: ["intervals", 0, "kind"], value: SENTINEL, code: "enum" },
  { keys: ["intervals", 0, "agent"], value: -1, code: "range" },
  { keys: ["intervals", 0, "start_ms"], value: -1, code: "integer" },
  { keys: ["intervals", 0, "start_ms"], value: SENTINEL, code: "integer" },
  { keys: ["intervals", 0, "end_ms"], value: 1.5, code: "integer" },
  { keys: ["intervals", 1, "tool"], value: SENTINEL, code: "enum" },
  { keys: ["intervals", 1, "outcome"], value: SENTINEL, code: "enum" },
  { keys: ["counts", "tool_retries"], value: -1, code: "integer" },
  { keys: ["refs", "prs", 0, "repo"], value: SENTINEL, code: "pattern" },
  { keys: ["refs", "prs", 0, "number"], value: 0, code: "integer" },
  { keys: ["refs", "commits", 0, "repo"], value: SENTINEL, code: "pattern" },
  { keys: ["refs", "commits", 0, "repo"], value: null, code: "type" },
  { keys: ["refs", "commits", 0, "sha"], value: SENTINEL, code: "pattern" },
  { keys: ["refs", "private", "prs"], value: -1, code: "integer" },
  { keys: ["refs", "private", "commits"], value: SENTINEL, code: "integer" },
  { keys: ["jobs", 0, "job"], value: SENTINEL, code: "pattern" },
  { keys: ["jobs", 0, "session_offset_ms"], value: SENTINEL, code: "integer" },
  { keys: ["jobs", 0, "session_offset_ms"], value: 1.5, code: "integer" },
  { keys: ["jobs", 0, "session_offset_ms"], value: PUBLISHED_LIMITS.maxOffsetMs + 1, code: "range" },
  { keys: ["jobs", 0, "session_offset_ms"], value: -(PUBLISHED_LIMITS.maxOffsetMs + 1), code: "range" },
  { keys: ["jobs", 0, "session_offset_ms"], value: Date.parse("2026-09-25T08:00:00.000Z"), code: "range" },
  { keys: ["jobs", 0, "transitions", 0, "to"], value: SENTINEL, code: "enum" },
  { keys: ["jobs", 0, "transitions", 0, "offset_ms"], value: SENTINEL, code: "integer" },
  { keys: ["jobs", 0, "transitions", 0, "offset_ms"], value: Number.MAX_SAFE_INTEGER + 1, code: "integer" },
  { keys: ["jobs", 0, "observed", "status"], value: SENTINEL, code: "enum" },
  { keys: ["jobs", 0, "observed", "offset_ms"], value: SENTINEL, code: "integer" },
  { keys: ["unavailable", 0, "field"], value: SENTINEL, code: "enum" },
  { keys: ["unavailable", 0, "reason"], value: SENTINEL, code: "enum" },
]

for (const spec of SIMPLE_VIOLATIONS) {
  test(`${ps(spec.keys)} = ${JSON.stringify(spec.value)} fails with ${spec.code}`, () => {
    const result = validatePublished(setPath(golden(), spec.keys, spec.value))
    assertSingle(result, spec.code, ps(spec.keys))
    assertNoLeak(result)
  })
}

// ---------------------------------------------------------------------------
// Accepted values.
// ---------------------------------------------------------------------------

const ACCEPTED = [
  { name: "a negative session_offset_ms (a session that began before its task card existed)", keys: ["jobs", 0, "session_offset_ms"], value: -1800000 },
  { name: "session_offset_ms at the negative cap", keys: ["jobs", 0, "session_offset_ms"], value: -PUBLISHED_LIMITS.maxOffsetMs },
  { name: "session_offset_ms at the positive cap", keys: ["jobs", 0, "session_offset_ms"], value: PUBLISHED_LIMITS.maxOffsetMs },
  { name: "a null session_offset_ms", keys: ["jobs", 0, "session_offset_ms"], value: null },
  { name: "a negative transition offset_ms", keys: ["jobs", 0, "transitions", 0, "offset_ms"], value: -5 },
  { name: "a null transition offset_ms", keys: ["jobs", 0, "transitions", 0, "offset_ms"], value: null },
  { name: "a null observed.offset_ms", keys: ["jobs", 0, "observed", "offset_ms"], value: null },
  { name: "a null observed", keys: ["jobs", 0, "observed"], value: null },
  { name: "ended false", keys: ["session", "ended"], value: false },
  { name: "a null end_reason", keys: ["session", "end_reason"], value: null },
  { name: "no intervals", keys: ["intervals"], value: [] },
  { name: "the job_offsets unavailable field", keys: ["unavailable", 0, "field"], value: "job_offsets" },
  { name: "the capped unavailable reason", keys: ["unavailable", 0, "reason"], value: "capped" },
  { name: "an interval ending exactly at the session's duration", keys: ["intervals", 0, "end_ms"], value: GOLDEN.session.duration_ms },
]

for (const spec of ACCEPTED) {
  test(`accepted: ${spec.name}`, () => {
    assert.deepEqual(validatePublished(setPath(golden(), spec.keys, spec.value)), { ok: true, errors: [] })
  })
}

test("accepted: a zero-length session", () => {
  const value = golden()
  value.session.duration_ms = 0
  value.intervals = [{ kind: "turn", agent: 0, start_ms: 0, end_ms: 0 }]
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
})

// ---------------------------------------------------------------------------
// Order and bounds.
// ---------------------------------------------------------------------------

test("an interval ending before it starts fails with order", () => {
  assertSingle(validatePublished(setPath(golden(), ["intervals", 0, "end_ms"], 0)), "order", "intervals.0.end_ms")
})

test("an interval ending after the session's duration fails with range", () => {
  assertSingle(validatePublished(setPath(golden(), ["intervals", 0, "end_ms"], GOLDEN.session.duration_ms + 1)), "range", "intervals.0.end_ms")
})

test("a malformed duration suppresses the interval bound check rather than cascading", () => {
  assertSingle(validatePublished(setPath(golden(), ["session", "duration_ms"], "long")), "integer", "session.duration_ms")
})

test("an unusable session suppresses the interval bound check", () => {
  assertSingle(validatePublished(setPath(golden(), ["session"], "gone")), "type", "session")
})

test("an interval's agent must exist in agents", () => {
  assertSingle(validatePublished(setPath(golden(), ["intervals", 0, "agent"], 5)), "ref", "intervals.0.agent")
})

test("agents keep the local rules: unique n and a real parent", () => {
  assertSingle(validatePublished(setPath(golden(), ["agents", 1, "n"], 0)), "duplicate", "agents.1.n")
  assertSingle(validatePublished(setPath(golden(), ["agents", 1, "parent"], 7)), "reference", "agents.1.parent")
})

test("intervals[].tool and outcome are required for tool intervals and forbidden otherwise", () => {
  assertSingle(validatePublished(deletePath(golden(), ["intervals", 1, "tool"])), "missing", "intervals.1.tool")
  assertSingle(validatePublished(setPath(golden(), ["intervals", 0, "tool"], "shell")), "unknown_key", "intervals.0")
})

test("jobs[].basis keeps the local rules", () => {
  assertSingle(validatePublished(setPath(golden(), ["jobs", 0, "basis"], [])), "empty", "jobs.0.basis")
  assertSingle(validatePublished(setPath(golden(), ["jobs", 0, "basis"], ["desk_tool", "desk_tool"])), "duplicate", "jobs.0.basis")
})

test("an unknown key in counts.tool_calls names the map, not the key", () => {
  const value = golden()
  value.counts.tool_calls[SENTINEL] = 1
  const result = validatePublished(value)
  assertSingle(result, "unknown_key", "counts.tool_calls")
  assertNoLeak(result)
})

// ---------------------------------------------------------------------------
// unknown_key at every object level, the sentinel planted as the key itself.
// ---------------------------------------------------------------------------

const UNKNOWN_KEY_LEVELS = [
  [], ["session"], ["plugins", 0], ["models", 0], ["models", 0, "tokens"], ["agents", 0], ["intervals", 0], ["intervals", 1],
  ["counts"], ["refs"], ["refs", "prs", 0], ["refs", "commits", 0], ["refs", "private"],
  ["jobs", 0], ["jobs", 0, "transitions", 0], ["jobs", 0, "observed"], ["unavailable", 0],
]

for (const keys of UNKNOWN_KEY_LEVELS) {
  test(`an unknown key named with the sentinel at ${keys.length === 0 ? "the top level" : ps(keys)} fails with unknown_key naming the container`, () => {
    const value = golden()
    const target = keys.length === 0 ? value : at(value, [...keys, "x"])
    target[SENTINEL] = true
    const result = validatePublished(value)
    assertSingle(result, "unknown_key", ps(keys))
    assertNoLeak(result)
  })
}

// ---------------------------------------------------------------------------
// missing: every required field.
// ---------------------------------------------------------------------------

const MISSING_CASES = [
  ["schema"], ["session"], ["plugins"], ["models"], ["agents"], ["intervals"], ["counts"], ["refs"], ["jobs"], ["unavailable"],
  ["session", "host"], ["session", "id"], ["session", "host_version"], ["session", "entrypoint"], ["session", "duration_ms"],
  ["session", "ended"], ["session", "end_reason"],
  ["plugins", 0, "name"], ["plugins", 0, "version"],
  ["models", 0, "id"], ["models", 0, "requests"], ["models", 0, "tokens"], ["models", 0, "tokens", "reasoning"],
  ["agents", 1, "n"], ["agents", 1, "parent"], ["agents", 1, "model"],
  ["intervals", 0, "kind"], ["intervals", 0, "agent"], ["intervals", 0, "start_ms"], ["intervals", 0, "end_ms"], ["intervals", 1, "outcome"],
  ["counts", "tool_calls"], ["counts", "tool_failures"], ["counts", "tool_retries"], ["counts", "api_retries"], ["counts", "compactions"],
  ["refs", "prs"], ["refs", "commits"], ["refs", "private"], ["refs", "private", "prs"], ["refs", "private", "commits"],
  ["refs", "prs", 0, "repo"], ["refs", "prs", 0, "number"], ["refs", "commits", 0, "repo"], ["refs", "commits", 0, "sha"],
  ["jobs", 0, "job"], ["jobs", 0, "basis"], ["jobs", 0, "session_offset_ms"], ["jobs", 0, "transitions"], ["jobs", 0, "observed"],
  ["jobs", 0, "transitions", 0, "to"], ["jobs", 0, "transitions", 0, "offset_ms"],
  ["jobs", 0, "observed", "status"], ["jobs", 0, "observed", "offset_ms"],
  ["unavailable", 0, "field"], ["unavailable", 0, "reason"],
]

for (const keys of MISSING_CASES) {
  test(`a missing ${ps(keys)} fails with missing`, () => {
    assertSingle(validatePublished(deletePath(golden(), keys)), "missing", ps(keys))
  })
}

// ---------------------------------------------------------------------------
// type: every nested object and array, given the wrong shape.
// ---------------------------------------------------------------------------

const badScalar = `${SENTINEL} is not an object`

const TYPE_CASES = [
  ["session"], ["plugins"], ["plugins", 0], ["models"], ["models", 0], ["models", 0, "tokens"], ["agents", 1],
  ["intervals"], ["intervals", 0], ["counts"], ["counts", "tool_calls"], ["counts", "tool_failures"],
  ["refs"], ["refs", "prs"], ["refs", "prs", 0], ["refs", "commits"], ["refs", "commits", 0], ["refs", "private"],
  ["jobs"], ["jobs", 0], ["jobs", 0, "transitions"], ["jobs", 0, "transitions", 0], ["jobs", 0, "observed"],
  ["unavailable"], ["unavailable", 0],
]

for (const keys of TYPE_CASES) {
  test(`${ps(keys)} of the wrong type fails with type`, () => {
    const result = validatePublished(setPath(golden(), keys, badScalar))
    assertSingle(result, "type", ps(keys))
    assertNoLeak(result)
  })
}

// ---------------------------------------------------------------------------
// Caps, the local ones reused.
// ---------------------------------------------------------------------------

const CAPS = [
  { keys: ["plugins"], limit: LIMITS.plugins, item: { name: "desk", version: SENTINEL } },
  { keys: ["models"], limit: LIMITS.models, item: { id: SENTINEL } },
  { keys: ["agents"], limit: LIMITS.agents, item: { n: 0, parent: null, model: SENTINEL } },
  { keys: ["intervals"], limit: LIMITS.intervals, item: { kind: SENTINEL } },
  { keys: ["refs", "prs"], limit: LIMITS.prs, item: { repo: SENTINEL, number: 1 } },
  { keys: ["refs", "commits"], limit: LIMITS.commits, item: { repo: SENTINEL, sha: SENTINEL } },
  { keys: ["jobs"], limit: LIMITS.jobs, item: { job: SENTINEL } },
  { keys: ["jobs", 0, "transitions"], limit: LIMITS.jobTransitions, item: { to: SENTINEL, offset_ms: 0 } },
  { keys: ["unavailable"], limit: LIMITS.unavailable, item: { field: SENTINEL, reason: "capped" } },
]

for (const { keys, limit, item } of CAPS) {
  test(`more than ${limit} ${ps(keys)} fails with too_many and reads no item`, () => {
    const result = validatePublished(setPath(golden(), keys, new Array(limit + 1).fill(item)))
    assertSingle(result, "too_many", ps(keys))
    assertNoLeak(result)
  })
}

test("exactly the cap is accepted (intervals)", () => {
  const value = golden()
  value.intervals = new Array(LIMITS.intervals).fill(value.intervals[0])
  assert.equal(validatePublished(value).ok, true)
})

// ---------------------------------------------------------------------------
// validatePublishedBytes: the same canonical-bytes and size rules as M3-1.
// ---------------------------------------------------------------------------

test("validatePublishedBytes rejects a buffer over the 16 MiB cap without parsing it", () => {
  assert.deepEqual(validatePublishedBytes(Buffer.alloc(LIMITS.maxBytes + 1)), { ok: false, errors: [{ code: "too_large", path: "" }] })
})

test("validatePublishedBytes rejects bytes that are not JSON", () => {
  assert.deepEqual(validatePublishedBytes(`{${SENTINEL}`), { ok: false, errors: [{ code: "json", path: "" }] })
})

test("validatePublishedBytes rejects a duplicate key that would carry free text past the parser", () => {
  const text = GOLDEN_BYTES.toString("utf8").replace(`"schema":"${PUBLISHED_SCHEMA}"`, `"schema":"${SENTINEL} free text","schema":"${PUBLISHED_SCHEMA}"`)
  assert.equal(JSON.parse(text).schema, PUBLISHED_SCHEMA)
  const result = validatePublishedBytes(Buffer.from(text, "utf8"))
  assert.deepEqual(result, { ok: false, errors: [{ code: "canonical", path: "" }] })
  assertNoLeak(result)
})

test("validatePublishedBytes rejects pretty-printed bytes and accepts one trailing newline only", () => {
  assert.deepEqual(validatePublishedBytes(JSON.stringify(GOLDEN, null, 2)), { ok: false, errors: [{ code: "canonical", path: "" }] })
  assert.deepEqual(validatePublishedBytes(JSON.stringify(GOLDEN)), { ok: true, errors: [] })
  assert.deepEqual(validatePublishedBytes(`${JSON.stringify(GOLDEN)}\n\n`), { ok: false, errors: [{ code: "canonical", path: "" }] })
})

test("validatePublishedBytes delegates shape errors to validatePublished", () => {
  const result = validatePublishedBytes(JSON.stringify(setPath(golden(), ["models", 0, "id"], `${SENTINEL}-2026-09-25`)))
  assertSingle(result, "date", "models.0.id")
  assertNoLeak(result)
})

// ---------------------------------------------------------------------------
// The walker is M3-1's: every published level spec carries real checks.
// ---------------------------------------------------------------------------

test("every field in every published level spec carries a check function", () => {
  for (const [levelName, spec] of Object.entries(__PUBLISHED_SPECS__)) {
    for (const [fieldName, field] of Object.entries(spec)) {
      assert.equal(typeof field.check, "function", `${levelName}.${fieldName}`)
    }
  }
  assert.ok(Object.isFrozen(PUBLISHED_LIMITS))
})
