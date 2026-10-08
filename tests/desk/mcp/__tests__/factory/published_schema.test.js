// Published facts (`desk.factory.published/3`, with `/1` and `/2` still read): the public gate the
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
  publishableToken,
  validatePublishedBytes,
  PUBLISHED_SCHEMA,
  PUBLISHED_SCHEMA_V3,
  PUBLISHED_SCHEMAS,
  PUBLISHED_LIMITS,
  DATE_SHAPE,
  TIME_SHAPE,
  SESSION_ID_V4,
  __PUBLISHED_SPECS__,
} from "../../../../../plugins/desk/mcp/src/factory/published-schema.js"
import { CATCH_POINTS, RETURN_REASONS, WAIT_CLASSES } from "../../../../../plugins/desk/mcp/src/factory/outcome.js"
import { ENUMS, LIMITS } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { normalizePublished } from "../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_BYTES = readFileSync(path.join(here, "fixtures", "published-golden.json"))
const GOLDEN = JSON.parse(GOLDEN_BYTES.toString("utf8"))
const LOCAL_GOLDEN = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
const SENTINEL = "SENTINEL-7f3a"

// The golden file is `/2`, as the transform writes a session with nothing only `/3` allows; the cases below run on its `/3` form, with a timed commit. The `/4` cases at the end start from `golden4()`.
function golden() {
  const value = structuredClone(GOLDEN)
  value.schema = PUBLISHED_SCHEMA_V3
  value.refs.commits[0].at_ms = 600000
  return value
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
  assert.equal(GOLDEN.schema, "desk.factory.published/2")
  assert.equal(PUBLISHED_SCHEMA, "desk.factory.published/4")
  assert.equal(PUBLISHED_SCHEMA_V3, "desk.factory.published/3")
  assert.deepEqual(PUBLISHED_SCHEMAS, ["desk.factory.published/1", "desk.factory.published/2", PUBLISHED_SCHEMA_V3, PUBLISHED_SCHEMA])
})

test("published facts accept schema /1, /2 and /3 without the /4 keys and refuse /5", () => {
  const bare = golden()
  delete bare.human_turns // a /1 file carries no human_turns
  delete bare.refs.commits[0].at_ms // nor does a /1 or /2 file carry a commit time
  for (const schema of ["desk.factory.published/1", "desk.factory.published/2", "desk.factory.published/3"]) {
    assert.deepEqual(validatePublished({ ...bare, schema }), { ok: true, errors: [] }, schema)
  }
  assertSingle(validatePublished({ ...golden(), schema: "desk.factory.published/5" }), "pattern", "schema")
})

test("a commit time is /3 only, within the session, and never beside a public desk's withheld timing", () => {
  assert.deepEqual(validatePublished(golden()), { ok: true, errors: [] })
  for (const schema of ["desk.factory.published/1", "desk.factory.published/2"]) {
    const value = golden()
    delete value.human_turns
    value.schema = schema
    assertSingle(validatePublished(value), "inconsistent", "refs.commits.0.at_ms")
    // A commit that is not an object is named once, by its own check.
    value.refs.commits[0] = "not a commit"
    const result = validatePublished(value)
    assert.equal(result.ok, false)
    assert.ok(result.errors.every((error) => error.path === "refs.commits.0" && error.code !== "inconsistent"), JSON.stringify(result.errors))
  }
  // At the session's end exactly is inside; one past it is `range`.
  assert.deepEqual(validatePublished(setPath(golden(), ["refs", "commits", 0, "at_ms"], 5400000)), { ok: true, errors: [] })
  assertSingle(validatePublished(setPath(golden(), ["refs", "commits", 0, "at_ms"], 5400001)), "range", "refs.commits.0.at_ms")
  // An unsound duration skips the bound, so one bad number is one error.
  assertSingle(validatePublished(setPath(setPath(golden(), ["refs", "commits", 0, "at_ms"], 5400001), ["session", "duration_ms"], -1)), "integer", "session.duration_ms")
  for (const bad of [-1, 1.5, "600000", null]) {
    const result = validatePublished(setPath(golden(), ["refs", "commits", 0, "at_ms"], bad))
    assert.equal(result.ok, false, String(bad))
    assert.ok(result.errors.every((error) => error.path === "refs.commits.0.at_ms"), String(bad))
  }
  // A commit time on a desk that withholds its timing would date the session.
  const withheld = golden()
  withheld.jobs = withheld.jobs.map((job) => ({ ...job, session_offset_ms: null, transitions: [], observed: job.observed === null ? null : { ...job.observed, offset_ms: null } }))
  withheld.unavailable = [{ field: "job_offsets", reason: "desk_public" }]
  assertSingle(validatePublished(withheld), "inconsistent", "refs.commits.0")
  delete withheld.refs.commits[0].at_ms
  assert.deepEqual(validatePublished(withheld), { ok: true, errors: [] })
})

test("an older file whose refs or unavailable list fails its own check gets no /3 error beside it", () => {
  const older = golden()
  delete older.human_turns
  older.schema = "desk.factory.published/2"
  older.refs = "not refs"
  older.unavailable = "not a list"
  const result = validatePublished(older)
  assert.deepEqual(result.errors.map((error) => `${error.code} ${error.path}`).sort(), ["type refs", "type unavailable"])
})

test("the outcomes flag is /3 only, with any reason it carries", () => {
  const value = golden()
  value.unavailable = [{ field: "outcomes", reason: "capped" }]
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
  for (const schema of ["desk.factory.published/1", "desk.factory.published/2"]) {
    const older = structuredClone(value)
    delete older.human_turns
    delete older.refs.commits[0].at_ms
    older.schema = schema
    assertSingle(validatePublished(older), "inconsistent", "unavailable.0")
    older.unavailable = [{ field: "outcomes", reason: "log_missing" }]
    assertSingle(validatePublished(older), "inconsistent", "unavailable.0")
    // A field that fails its own check is named once, by that check.
    older.unavailable = [{ field: "made_up", reason: "capped" }]
    assertSingle(validatePublished(older), "enum", "unavailable.0.field")
    older.unavailable = ["outcomes"]
    const result = validatePublished(older)
    assert.equal(result.ok, false)
    assert.ok(result.errors.every((error) => error.path === "unavailable.0" && error.code !== "inconsistent"), JSON.stringify(result.errors))
  }
})

test("every new unavailable field and reason is accepted in published facts", () => {
  const fields = ["compaction_waits", "agents", "prs", "reasoning_tokens", "entrypoint", "tool_outcomes", "job_segments"]
  const reasons = ["field_absent", "host_records_partly", "withheld_public"]
  for (const field of fields) {
    for (const reason of reasons) {
      const value = golden()
      value.unavailable = [{ field, reason }]
      assert.deepEqual(validatePublished(value), { ok: true, errors: [] }, `${field}/${reason}`)
    }
  }
  assert.deepEqual(ENUMS.publishedUnavailableField.slice(-2), ["job_offsets", "outcomes"])
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
    for (const bad of ["2026-09-25", "2026-09-25T08:00:00.000Z", `${SENTINEL}-2026-09-25`, "08:30", `${SENTINEL}-08:30`]) {
      const result = validatePublished(setPath(golden(), keys, bad))
      assert.equal(result.ok, false, `${ps(keys)} accepted ${bad}`)
      // A basis entry is checked as part of its array.
      const expected = keys.includes("basis") ? ps(keys.slice(0, keys.indexOf("basis") + 1)) : ps(keys)
      assert.ok(result.errors.some((error) => error.path === expected && ["date", "time", "pattern", "enum"].includes(error.code)), `${ps(keys)}: ${JSON.stringify(result.errors)}`)
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

// Credential-shaped free tokens with no spaces: each carries a sentinel, or
// is a bare hex run asserted absent by value.
const CREDENTIAL_TOKENS = [
  { keys: ["models", 0, "id"], value: "ghp_SENTINEL0123456789abcdefghijklmnopqrstuv" },
  { keys: ["agents", 0, "model"], value: "github_pat_SENTINEL0123456789_abcdefghijklmnopqrstuvwxyz" },
  { keys: ["agents", 1, "model"], value: "gho_SENTINEL0123456789abcdefghijklmnopqrstuv" },
  { keys: ["models", 1, "id"], value: "sk-ant-SENTINEL-api03-abcdefghijklmnop" },
  { keys: ["models", 0, "id"], value: "0123456789abcdef0123456789abcdef" },
  { keys: ["plugins", 0, "name"], value: "sentinel-0123456789abcdef0123456789abcdef" },
  { keys: ["refs", "prs", 0, "repo"], value: "acme/ghp_SENTINEL0123456789abcdefghijklmnopqrstuv" },
  { keys: ["refs", "commits", 0, "repo"], value: "acme/sentinel-0123456789abcdef0123456789abcdef" },
]

for (const { keys, value } of CREDENTIAL_TOKENS) {
  test(`a credential-shaped ${ps(keys)} with no spaces fails with credential_like and is never echoed`, () => {
    const result = validatePublished(setPath(golden(), keys, value))
    assertSingle(result, "credential_like", ps(keys))
    const serialized = JSON.stringify(result).toLowerCase()
    for (const fragment of ["sentinel", "ghp_", "github_pat_", "gho_", "sk-ant", "0123456789abcdef0123456789abcdef"]) assert.equal(serialized.includes(fragment), false, value)
  })
}

test("real model IDs, plugin names and repositories are not credential-like", () => {
  for (const [keys, value] of [
    [["models", 0, "id"], "claude-3-5-sonnet-20241022"],
    [["agents", 0, "model"], "us.anthropic.claude-3-7-sonnet-20250219-v1:0"],
    [["plugins", 0, "name"], "plain-language"],
    [["refs", "prs", 0, "repo"], "ourostack/ouroboros-agent-harness"],
  ]) {
    assert.deepEqual(validatePublished(setPath(golden(), keys, value)), { ok: true, errors: [] }, value)
  }
})

test("TIME_SHAPE matches a time of day; compact release stamps are not one", () => {
  assert.ok(TIME_SHAPE.test("m:08:30:00"))
  assert.equal(TIME_SHAPE.test("gpt-4o-20240806"), false)
  assert.equal(TIME_SHAPE.test("1.0.0-20260925.083000"), false)
})

for (const { keys, value } of [{ keys: ["models", 0, "id"], value: "m:08:30:00" }, { keys: ["agents", 1, "model"], value: `${SENTINEL}:08:30` }]) {
  test(`a time of day inside an otherwise valid ${ps(keys)} fails with time`, () => {
    const result = validatePublished(setPath(golden(), keys, value))
    assertSingle(result, "time", ps(keys))
    assertNoLeak(result)
  })
}

// ---------------------------------------------------------------------------
// Session ID and span (fix round 2: review I1 and Critical).
// ---------------------------------------------------------------------------

test("session.id must be a version-4 UUID: v1 and v7 carry a time, v1 a machine", () => {
  assert.ok(SESSION_ID_V4.test(GOLDEN.session.id))
  for (const id of ["c232ab00-9414-11ec-b3c8-9f6bdeced846", "01927a3b-8c00-7abc-8def-0123456789ab", "3b0c1f5e-8a1d-4c2e-7f3a-1b2c3d4e5f60"]) {
    assertSingle(validatePublished(setPath(golden(), ["session", "id"], id)), "pattern", "session.id")
  }
})

test("session.duration_ms may not exceed the offset cap, so no interval offset can be an epoch value", () => {
  const value = golden()
  value.session.duration_ms = PUBLISHED_LIMITS.maxOffsetMs
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
  value.session.duration_ms = PUBLISHED_LIMITS.maxOffsetMs + 1
  assertSingle(validatePublished(value), "range", "session.duration_ms")
  // A 1970 anchor: the interval offset would be the interval's epoch time.
  value.session.duration_ms = Date.parse("2026-09-25T09:30:00.000Z")
  value.intervals[0].start_ms = Date.parse("2026-09-25T08:00:01.000Z")
  value.intervals[0].end_ms = value.intervals[0].start_ms
  assertSingle(validatePublished(value), "range", "session.duration_ms")
})

// ---------------------------------------------------------------------------
// Duplicates (fix round 2: review M3).
// ---------------------------------------------------------------------------

test("a repeated unavailable entry, PR or commit fails with duplicate naming the later one", () => {
  let value = golden()
  value.unavailable.push({ ...value.unavailable[0] })
  assertSingle(validatePublished(value), "duplicate", `unavailable.${value.unavailable.length - 1}`)
  value = golden()
  value.refs.prs.push({ ...value.refs.prs[0] })
  assertSingle(validatePublished(value), "duplicate", "refs.prs.1")
  value = golden()
  value.refs.commits.push({ repo: "ourostack/factory", sha: value.refs.commits[0].sha })
  assertSingle(validatePublished(value), "duplicate", "refs.commits.1")
  value = golden()
  value.refs.prs.push({ repo: "ourostack/desk", number: 10 }, { repo: "ourostack/factory", number: 9 })
  assert.equal(validatePublished(value).ok, true, "another number or repository is not a duplicate")
})

// ---------------------------------------------------------------------------
// A desk marked public carries no job timing (fix round 3, N4).
// ---------------------------------------------------------------------------

function publicDesk() {
  const value = golden()
  value.jobs = value.jobs.map((job) => ({ ...job, session_offset_ms: null, transitions: [], observed: job.observed === null ? null : { status: job.observed.status, offset_ms: null } }))
  value.unavailable = [{ field: "job_offsets", reason: "desk_public" }]
  delete value.refs.commits[0].at_ms // a commit time is job timing too
  return value
}

test("a desk_public file with no job timing passes; any timing on a job is inconsistent", () => {
  assert.deepEqual(validatePublished(publicDesk()), { ok: true, errors: [] })
  let value = publicDesk()
  value.jobs[0].session_offset_ms = 5
  value.jobs[1].transitions = [{ to: "done", offset_ms: 1 }]
  value.jobs[2].observed.offset_ms = 3
  const result = validatePublished(value)
  assert.deepEqual(result.errors, [{ code: "inconsistent", path: "jobs.0" }, { code: "inconsistent", path: "jobs.1" }, { code: "inconsistent", path: "jobs.2" }])
  value = publicDesk()
  value.jobs[1].transitions = [{ to: "done", offset_ms: null }]
  assertSingle(validatePublished(value), "inconsistent", "jobs.1")
})

test("the desk_public check skips jobs and markers it cannot read, and ignores other job_offsets reasons", () => {
  let value = publicDesk()
  value.jobs[0] = `${SENTINEL} not a job`
  value.jobs[1].transitions = `${SENTINEL} not a list`
  const result = validatePublished(value)
  assert.deepEqual(result.errors, [{ code: "type", path: "jobs.0" }, { code: "type", path: "jobs.1.transitions" }])
  assertNoLeak(result)
  value = publicDesk()
  value.unavailable = [{ field: "job_offsets", reason: `${SENTINEL}` }]
  value.jobs[0].session_offset_ms = 5
  assertSingle(validatePublished(value), "enum", "unavailable.0.reason")
  value = publicDesk()
  value.unavailable = [{ field: "job_offsets", reason: "source_unreadable" }]
  value.jobs[0].session_offset_ms = 5
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
  value = publicDesk()
  value.unavailable = [`${SENTINEL}`]
  assertSingle(validatePublished(value), "type", "unavailable.0")
  value = publicDesk()
  value.jobs = `${SENTINEL}`
  assertSingle(validatePublished(value), "type", "jobs")
  value = publicDesk()
  value.unavailable = new Array(LIMITS.unavailable + 1).fill({ field: "job_offsets", reason: "desk_public" })
  value.jobs[0].session_offset_ms = 5
  assertSingle(validatePublished(value), "too_many", "unavailable")
})

test("an item with a bad field is left out of the duplicate check", () => {
  const value = golden()
  value.refs.prs.push({ repo: "ourostack/desk", number: 0 })
  value.refs.prs.push({ repo: "ourostack/desk", number: 0 })
  const result = validatePublished(value)
  assert.deepEqual(result.errors, [{ code: "integer", path: "refs.prs.1.number" }, { code: "integer", path: "refs.prs.2.number" }])
})

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
  { keys: ["schema"], value: `desk.factory.published/3 ${SENTINEL}`, code: "pattern" },
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
  { keys: ["refs", "private", "plugins"], value: -1, code: "integer" },
  { keys: ["refs", "private", "plugins"], value: 1.5, code: "integer" },
  { keys: ["refs", "private", "plugins"], value: SENTINEL, code: "integer" },
  { keys: ["refs", "private", "plugins"], value: null, code: "integer" },
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
  delete value.human_turns
  delete value.refs.commits[0].at_ms
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

test("refs.private.plugins is optional, so files published before plugins were counted stay valid", () => {
  const without = golden()
  delete without.refs.private.plugins
  assert.deepEqual(validatePublished(without), { ok: true, errors: [] })
  assert.deepEqual(validatePublishedBytes(Buffer.from(`${JSON.stringify(without)}\n`)), { ok: true, errors: [] })
  const counted = golden()
  counted.refs.private.plugins = 5
  assert.deepEqual(validatePublished(counted), { ok: true, errors: [] })
})

test("a published plugin never carries its install source", () => {
  const value = golden()
  value.plugins[0].source = "ourostack/desk"
  assertSingle(validatePublished(value), "unknown_key", "plugins.0")
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
  const text = GOLDEN_BYTES.toString("utf8").replace(`"schema":"${GOLDEN.schema}"`, `"schema":"${SENTINEL} free text","schema":"${GOLDEN.schema}"`)
  assert.equal(JSON.parse(text).schema, GOLDEN.schema)
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

// --- per-worker bindings: jobs[].agents and refs.prs[].agent ---------------

test("published jobs[].agents and refs.prs[].agent validate when they name real workers", () => {
  const value = setPath(setPath(golden(), ["jobs", 0, "agents"], [0, 1]), ["refs", "prs", 0, "agent"], 1)
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
})

test("published jobs[].agents refuses duplicates, empty lists, non-arrays and unknown workers", () => {
  const cases = [[[0, 0], "duplicate", "jobs.0.agents"], [[], "empty", "jobs.0.agents"], ["0", "type", "jobs.0.agents"], [[7], "agent_unknown", "jobs.0.agents.0"], [Array.from({ length: LIMITS.agents + 1 }, (_, n) => n), "too_many", "jobs.0.agents"]]
  for (const [agents, code, where] of cases) {
    const result = validatePublished(setPath(golden(), ["jobs", 0, "agents"], agents))
    assert.ok(result.errors.some((error) => error.code === code && error.path === where), JSON.stringify(result.errors))
  }
})

test("published refs.prs[].agent refuses an unknown or negative worker", () => {
  assertSingle(validatePublished(setPath(golden(), ["refs", "prs", 0, "agent"], 7)), "agent_unknown", "refs.prs.0.agent")
  assertSingle(validatePublished(setPath(golden(), ["refs", "prs", 0, "agent"], -1)), "range", "refs.prs.0.agent")
})

test("an unsorted jobs[].agents is refused with order (canonical form is ascending)", () => {
  assertSingle(validatePublished(setPath(golden(), ["jobs", 0, "agents"], [1, 0])), "order", "jobs.0.agents")
  assert.equal(validatePublished(setPath(golden(), ["jobs", 0, "agents"], [0, 1])).ok, true)
})

test("publishableToken and the published token fields apply one rule", () => {
  const samples = ["desk", "claude-opus-5-5", "x-2024-08-06", "m-08:30", "ghp_0123456789abcdef0123", "sk-live-abc", "pwd-hunter2", "a1b2c3d4e5f60718293a", "10-0-0-1"]
  for (const sample of samples) {
    const fieldOk = validatePublished(withModelId(sample)).errors.every((error) => !error.path.startsWith("models.0.id"))
    assert.equal(publishableToken(sample), fieldOk, sample)
  }
})

function withModelId(id) {
  const value = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "published-golden.json"), "utf8"))
  value.models[0].id = id
  return value
}

// --- outcomes: sign-off state with a wait class, never a time -------------

const OUTCOME = { job: "1a2b3c4d5e6f708192a3b4c5d6e7f809", rev: 4, state: "accepted", verified: true, reason: null, deliveries: 1, wait: { class: "lt_1h", censored: false } }
const withOutcomes = (outcomes) => ({ ...golden(), outcomes })

test("published facts without outcomes are valid, and facts with a well-formed list are valid", () => {
  const without = golden()
  delete without.outcomes
  assert.deepEqual(validatePublished(without), { ok: true, errors: [] })
  assert.deepEqual(validatePublished({ ...without, outcomes: [] }), { ok: true, errors: [] })
  assert.deepEqual(validatePublished(golden()), { ok: true, errors: [] }, "the golden carries outcomes")
  assert.equal(Array.isArray(GOLDEN.outcomes), true)
  const entries = ["not_delivered", "not_recorded", "delivered_unsigned", "accepted", "refused", "reopened"].map((state, index) => ({
    ...OUTCOME, job: index.toString(16).padStart(32, "0"), state, verified: state === "refused" ? false : null, reason: state === "refused" ? "defect" : null, wait: index % 2 === 0 ? null : { class: ["lt_1h", "lt_1d", "lt_7d", "ge_7d"][index % 4], censored: index % 3 === 0 },
  }))
  assert.deepEqual(validatePublished(withOutcomes([OUTCOME, ...entries])), { ok: true, errors: [] })
  assert.equal(typeof __PUBLISHED_SPECS__.outcome.wait.check, "function")
  assert.equal(typeof __PUBLISHED_SPECS__.wait.class.check, "function")
})

for (const [name, change, code, where] of [
  ["an unknown state", { state: `${SENTINEL}-state` }, "enum", "outcomes.0.state"],
  ["an unknown reason", { reason: SENTINEL }, "enum", "outcomes.0.reason"],
  ["an unknown wait class", { wait: { class: `${SENTINEL}-class`, censored: false } }, "enum", "outcomes.0.wait.class"],
  ["a censored flag that is not a boolean", { wait: { class: "lt_1h", censored: SENTINEL } }, "type", "outcomes.0.wait.censored"],
  ["a wait that is an exact number", { wait: 1200000 }, "type", "outcomes.0.wait"],
  ["a verified that is not a boolean or null", { verified: SENTINEL }, "type", "outcomes.0.verified"],
  ["a negative rev", { rev: -1 }, "range", "outcomes.0.rev"],
  ["a job that is not a job ID", { job: SENTINEL }, "pattern", "outcomes.0.job"],
  ["a job that holds a date shape", { job: "2026-09-25".padEnd(32, "0") }, "pattern", "outcomes.0.job"],
]) {
  test(`a published outcome with ${name} is rejected with ${code} at its path and no value`, () => {
    const result = validatePublished(withOutcomes([{ ...OUTCOME, ...change }]))
    assertSingle(result, code, where)
    assertNoLeak(result)
  })
}

test("a published outcome with a time key, an unknown key or a missing key is rejected with a path and no value", () => {
  for (const key of ["delivered_at", "signed_at", "observed_at"]) {
    const result = validatePublished(withOutcomes([{ ...OUTCOME, [key]: "2026-09-25T09:00:00.000Z" }]))
    assertSingle(result, "unknown_key", "outcomes.0")
    assertNoLeak(result)
  }
  assertSingle(validatePublished(withOutcomes([{ ...OUTCOME, wait: { class: "lt_1h", censored: false, ms: 5 } }])), "unknown_key", "outcomes.0.wait")
  const extra = validatePublished(withOutcomes([{ ...OUTCOME, [`${SENTINEL}-key`]: SENTINEL }]))
  assertSingle(extra, "unknown_key", "outcomes.0")
  assertNoLeak(extra)
  for (const key of Object.keys(OUTCOME)) {
    const { [key]: _gone, ...rest } = OUTCOME
    assertSingle(validatePublished(withOutcomes([rest])), "missing", `outcomes.0.${key}`)
  }
  assertSingle(validatePublished(withOutcomes([{ ...OUTCOME, wait: { class: "lt_1h" } }])), "missing", "outcomes.0.wait.censored")
  assertSingle(validatePublished(withOutcomes([null])), "type", "outcomes.0")
  assertSingle(validatePublished(withOutcomes(`${SENTINEL}`)), "type", "outcomes")
})

test("two published outcomes for one job are a duplicate, and a list over the cap is too_many", () => {
  assertSingle(validatePublished(withOutcomes([OUTCOME, { ...OUTCOME, rev: 5 }])), "duplicate", "outcomes.1.job")
  const many = Array.from({ length: LIMITS.outcomes + 1 }, (_, index) => ({ ...OUTCOME, job: index.toString(16).padStart(32, "0") }))
  assertSingle(validatePublished(withOutcomes(many)), "too_many", "outcomes")
})

test("normalizing published facts sorts outcomes by job and leaves facts without outcomes alone", () => {
  const value = withOutcomes([{ ...OUTCOME, job: "f".repeat(32) }, { ...OUTCOME, job: "0".repeat(32) }])
  assert.deepEqual(normalizePublished(value).outcomes.map((entry) => entry.job), ["0".repeat(32), "f".repeat(32)])
  const without = golden()
  delete without.outcomes
  assert.equal(Object.hasOwn(normalizePublished(without), "outcomes"), false)
})

// --- outcomes: the record's start and its returns, with no time -----------

const RETURN = { reason: "agent_error", caught: "at_review", counts: true, refusal: null, refusal_verified: null }
const FULL = { ...OUTCOME, since: "created", returns: [RETURN] }

test("a published outcome entry without the new keys stays valid, and one with them is valid", () => {
  assert.deepEqual(validatePublished(withOutcomes([OUTCOME])), { ok: true, errors: [] })
  assert.deepEqual(validatePublished(withOutcomes([FULL])), { ok: true, errors: [] })
  assert.deepEqual(validatePublished(withOutcomes([{ ...FULL, since: null, returns: [], returns_truncated: true, returns_unreadable: 3 }])), { ok: true, errors: [] })
  assert.deepEqual(validatePublished(withOutcomes([{ ...FULL, returns: [{ ...RETURN, caught: "after_delivery", refusal: "defect", refusal_verified: true }] }])), { ok: true, errors: [] })
  assert.equal(typeof __PUBLISHED_SPECS__.return.counts.check, "function")
})

for (const [name, change, code, where] of [
  ["a reason off the list", { returns: [{ ...RETURN, reason: `${SENTINEL}-reason` }] }, "enum", "outcomes.0.returns.0.reason"],
  ["a catch point off the list", { returns: [{ ...RETURN, caught: `${SENTINEL}-point` }] }, "enum", "outcomes.0.returns.0.caught"],
  ["a refusal off the list", { returns: [{ ...RETURN, refusal: SENTINEL }] }, "enum", "outcomes.0.returns.0.refusal"],
  ["a counts flag that is not a boolean", { returns: [{ ...RETURN, counts: SENTINEL }] }, "type", "outcomes.0.returns.0.counts"],
  ["a since off the list", { since: SENTINEL }, "enum", "outcomes.0.since"],
  ["a returns_truncated of false", { returns_truncated: false }, "type", "outcomes.0.returns_truncated"],
  ["a fractional returns_unreadable", { returns_unreadable: 1.5 }, "range", "outcomes.0.returns_unreadable"],
  ["a return with a time", { returns: [{ ...RETURN, at: "2026-09-25T09:00:00.000Z" }] }, "unknown_key", "outcomes.0.returns.0"],
  ["a first_validating_at", { first_validating_at: "2026-09-25T09:00:00.000Z" }, "unknown_key", "outcomes.0"],
  ["a first_delivered_at", { first_delivered_at: "2026-09-25T09:00:00.000Z" }, "unknown_key", "outcomes.0"],
]) {
  test(`a published outcome with ${name} is rejected with ${code} at its path and no value`, () => {
    const result = validatePublished(withOutcomes([{ ...FULL, ...change }]))
    assertSingle(result, code, where)
    assertNoLeak(result)
  })
}

test("more than 32 published returns are too_many, and a return missing a key is missing", () => {
  assertSingle(validatePublished(withOutcomes([{ ...FULL, returns: Array.from({ length: 33 }, () => RETURN) }])), "too_many", "outcomes.0.returns")
  assert.equal(validatePublished(withOutcomes([{ ...FULL, returns: Array.from({ length: 32 }, () => RETURN) }])).ok, true)
  const { counts: _gone, ...rest } = RETURN
  assertSingle(validatePublished(withOutcomes([{ ...FULL, returns: [rest] }])), "missing", "outcomes.0.returns.0.counts")
})

test("the published schema accepts exactly the wait classes, return reasons and catch points outcome.js defines", () => {
  const facts = (entry) => withOutcomes([entry])
  for (const value of WAIT_CLASSES) assert.equal(validatePublished(facts({ ...OUTCOME, wait: { class: value, censored: false } })).ok, true, value)
  for (const reason of RETURN_REASONS) assert.equal(validatePublished(facts({ ...FULL, returns: [{ ...RETURN, reason }] })).ok, true, reason)
  for (const caught of CATCH_POINTS) assert.equal(validatePublished(facts({ ...FULL, returns: [{ ...RETURN, caught }] })).ok, true, caught)
  assert.equal(validatePublished(facts({ ...OUTCOME, wait: { class: "lt_2h", censored: false } })).ok, false)
})

test("a published rev and deliveries are 0 to 9999, and returns_unreadable is 1 to 9999", () => {
  for (const key of ["rev", "deliveries"]) {
    assert.equal(validatePublished(withOutcomes([{ ...OUTCOME, [key]: 0 }])).ok, true, `${key} 0`)
    assert.equal(validatePublished(withOutcomes([{ ...OUTCOME, [key]: 9999 }])).ok, true, `${key} 9999`)
    assertSingle(validatePublished(withOutcomes([{ ...OUTCOME, [key]: 10000 }])), "range", `outcomes.0.${key}`)
  }
  assert.equal(validatePublished(withOutcomes([{ ...OUTCOME, returns_unreadable: 1 }])).ok, true)
  assert.equal(validatePublished(withOutcomes([{ ...OUTCOME, returns_unreadable: 9999 }])).ok, true)
  assertSingle(validatePublished(withOutcomes([{ ...OUTCOME, returns_unreadable: 0 }])), "range", "outcomes.0.returns_unreadable")
  assertSingle(validatePublished(withOutcomes([{ ...OUTCOME, returns_unreadable: 10000 }])), "range", "outcomes.0.returns_unreadable")
})

// --- human_turns: offsets, a basis and size classes, nothing else --------------

const TURN = { at_ms: 5000, basis: "first", window_ms: null, prompt_class: "s", output_class: "none" }
const TURNS = [
  TURN,
  { at_ms: 65000, basis: "after_stop", window_ms: 4000, prompt_class: "xs", output_class: "l" },
  { at_ms: 70000, basis: "mid_turn", window_ms: 5000, prompt_class: "m", output_class: "none" },
]
const withTurns = (human_turns) => ({ ...golden(), human_turns })

test("published facts without human_turns stay valid, and a well-formed list is valid", () => {
  const without = golden()
  delete without.human_turns
  assert.deepEqual(validatePublished(without), { ok: true, errors: [] })
  assert.deepEqual(validatePublished(withTurns([])), { ok: true, errors: [] })
  assert.deepEqual(validatePublished(withTurns(TURNS)), { ok: true, errors: [] })
  assert.deepEqual(validatePublishedBytes(`${JSON.stringify(withTurns(TURNS))}\n`), { ok: true, errors: [] })
  const old = withTurns(TURNS)
  delete old.human_turns
  delete old.refs.commits[0].at_ms
  old.schema = "desk.factory.published/1"
  assert.deepEqual(validatePublished(old), { ok: true, errors: [] }, "a stored /1 file stays valid")
})

test("the published list holds offsets, classes and a basis and nothing else (SENTINEL)", () => {
  for (const key of ["at", "text", "prompt", "delivered_at", "ts", SENTINEL]) {
    const result = validatePublished(withTurns([{ ...TURN, [key]: key === "at" ? "2026-09-25T08:00:05.000Z" : SENTINEL }]))
    assertSingle(result, "unknown_key", "human_turns.0")
    assertNoLeak(result)
  }
  const { at_ms: _drop, ...noOffset } = TURN
  assertSingle(validatePublished(withTurns([noOffset])), "missing", "human_turns.0.at_ms")
  assert.deepEqual(Object.keys(__PUBLISHED_SPECS__.humanTurn), ["at_ms", "basis", "window_ms", "prompt_class", "output_class"])
  for (const [overrides, code, where] of [
    [{ basis: SENTINEL }, "enum", "basis"],
    [{ prompt_class: SENTINEL }, "enum", "prompt_class"],
    [{ output_class: SENTINEL }, "enum", "output_class"],
    [{ at_ms: SENTINEL }, "integer", "at_ms"],
    [{ at_ms: -1 }, "integer", "at_ms"],
    [{ at_ms: 1.5 }, "integer", "at_ms"],
    [{ at_ms: PUBLISHED_LIMITS.maxOffsetMs + 1 }, "range", "at_ms"],
    [{ at_ms: GOLDEN.session.duration_ms + 1 }, "range", "at_ms"],
    [{ basis: "after_stop", window_ms: SENTINEL }, "integer", "window_ms"],
  ]) {
    const result = validatePublished(withTurns([{ ...TURN, ...overrides }]))
    assert.equal(result.ok, false, JSON.stringify(Object.keys(overrides)))
    assert.deepEqual(result.errors[0].path, `human_turns.0.${where}`)
    assert.equal(result.errors[0].code, code)
    assertNoLeak(result)
  }
  assertSingle(validatePublished(withTurns(SENTINEL)), "type", "human_turns")
  assertSingle(validatePublished(withTurns([null])), "type", "human_turns.0")
})

test("a published first turn has a null window, any other has a number, and the list is in time order", () => {
  assertSingle(validatePublished(withTurns([{ ...TURN, window_ms: 5 }])), "inconsistent", "human_turns.0.window_ms")
  assertSingle(validatePublished(withTurns([{ ...TURN, basis: "after_stop" }])), "inconsistent", "human_turns.0.window_ms")
  assertSingle(validatePublished(withTurns([TURNS[1], TURNS[0]])), "order", "human_turns.1.at_ms")
  assert.deepEqual(validatePublished(withTurns([TURNS[1], { ...TURNS[2], at_ms: TURNS[1].at_ms }])), { ok: true, errors: [] }, "equal offsets are in order")
})

test("a published list is capped at 1000 turns", () => {
  const turn = (index) => ({ at_ms: index, basis: index === 0 ? "first" : "after_stop", window_ms: index === 0 ? null : 1, prompt_class: "xs", output_class: "xs" })
  const full = Array.from({ length: LIMITS.humanTurns }, (_, index) => turn(index))
  assert.deepEqual(validatePublished(withTurns(full)), { ok: true, errors: [] })
  assertSingle(validatePublished(withTurns([...full, turn(LIMITS.humanTurns)])), "too_many", "human_turns")
})

test("normalizing published facts keeps the human_turns list as it is, in order, and adds none when absent", () => {
  const value = withTurns(TURNS)
  assert.deepEqual(normalizePublished(value).human_turns, TURNS)
  const bare = golden()
  delete bare.human_turns
  assert.equal(Object.hasOwn(normalizePublished(bare), "human_turns"), false)
})

test("the golden published file carries a human_turns list that validates", () => {
  assert.equal(GOLDEN.human_turns.length, 3)
  assert.deepEqual(validatePublished(golden()), { ok: true, errors: [] })
})

test("a file with a human_turns list cannot also say the host does not record it, or that the field is absent", () => {
  for (const reason of ["host_does_not_record", "field_absent"]) {
    const value = withTurns(TURNS)
    value.unavailable.push({ field: "human_turns", reason })
    assertSingle(validatePublished(value), "inconsistent", `unavailable.${value.unavailable.length - 1}`)
  }
  // a flag that says the list is partial sits beside a list
  for (const reason of ["capped", "source_unreadable", "host_records_partly", "log_truncated", "session_open"]) {
    const value = withTurns(TURNS)
    value.unavailable.push({ field: "human_turns", reason })
    assert.deepEqual(validatePublished(value), { ok: true, errors: [] }, reason)
  }
  // the flag with no list is how a host that does not record reads
  const flagged = golden()
  delete flagged.human_turns
  flagged.unavailable.push({ field: "human_turns", reason: "host_does_not_record" })
  assert.deepEqual(validatePublished(flagged), { ok: true, errors: [] })
  // an empty list is a recorded, empty list: it does not sit beside a not-recorded flag either
  const empty = withTurns([])
  empty.unavailable.push({ field: "human_turns", reason: "host_does_not_record" })
  assert.equal(validatePublished(empty).ok, false)
})

test("human_turns is refused in a /1 file", () => {
  const value = withTurns(TURNS)
  value.schema = "desk.factory.published/1"
  delete value.refs.commits[0].at_ms
  assertSingle(validatePublished(value), "inconsistent", "human_turns")
  const bare = golden()
  delete bare.human_turns
  delete bare.refs.commits[0].at_ms
  bare.schema = "desk.factory.published/1"
  assert.deepEqual(validatePublished(bare), { ok: true, errors: [] })
})

// ---------------------------------------------------------------------------
// `/4`: each job's UTC finish day, whether the session created each PR, and
// the mechanical facts of why the agent stopped before each human wait.
// ---------------------------------------------------------------------------

// The golden `/3` file as `/4`: the first job finished on a transition into `done`, the others carry no day (open, no readable card creation time, no observation); the PR was created by the session; the one human wait records how the turn ended.
function golden4() {
  const value = golden()
  value.schema = PUBLISHED_SCHEMA
  value.refs.prs = value.refs.prs.map((pr) => ({ ...pr, created: true }))
  value.jobs = value.jobs.map((job) => ({ ...job, finished_on: null, finished_basis: null }))
  value.jobs[0].finished_on = "2026-09-25"
  value.jobs[0].finished_basis = "transition"
  value.intervals = value.intervals.map((item) => (item.kind === "human_wait" ? { ...item, stop: { end: "end_turn", asks: true, pending_agents: false } } : item))
  return value
}

const WAIT_INDEX = 2
const V4_KEYS = [
  ["jobs", 0, "finished_on"],
  ["jobs", 0, "finished_basis"],
  ["refs", "prs", 0, "created"],
  ["intervals", WAIT_INDEX, "stop"],
]

test("the /4 golden value validates, and its new keys are the ones the design names", () => {
  const value = golden4()
  assert.equal(value.intervals[WAIT_INDEX].kind, "human_wait")
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
  assert.deepEqual(validatePublishedBytes(JSON.stringify(value)), { ok: true, errors: [] })
  assert.deepEqual(ENUMS.stopEnd, ["end_turn", "max_tokens", "rate_limit", "api_error", "refusal", "interrupted", "ask_question", "ask_plan", "not_recorded"])
  assert.deepEqual(ENUMS.finishedBasis, ["transition", "card_updated"])
})

for (const keys of V4_KEYS) {
  test(`a /4 file without ${ps(keys)} fails with missing`, () => {
    assertSingle(validatePublished(deletePath(golden4(), keys)), "missing", ps(keys))
  })
  test(`${ps(keys)} is /4 only: an older file carrying it is inconsistent`, () => {
    const value = golden4()
    const carried = at(value, keys)[keys[keys.length - 1]]
    for (const schema of PUBLISHED_SCHEMAS.slice(0, 3)) {
      const older = golden()
      if (schema !== PUBLISHED_SCHEMA_V3) delete older.refs.commits[0].at_ms
      if (schema === PUBLISHED_SCHEMAS[0]) delete older.human_turns
      older.schema = schema
      setPath(older, keys, carried)
      assertSingle(validatePublished(older), "inconsistent", ps(keys))
    }
  })
}

test("an older file whose /4-only key fails its own check is named once, by that check", () => {
  const older = setPath(golden(), ["jobs", 0, "finished_on"], `${SENTINEL}`)
  const result = validatePublished(older)
  assertSingle(result, "pattern", "jobs.0.finished_on")
  assertNoLeak(result)
  assertSingle(validatePublished(setPath(golden(), ["refs", "prs", 0, "created"], "yes")), "type", "refs.prs.0.created")
})

test("a /4 file keeps every older rule: a /3 commit time and outcomes flag stay valid in it", () => {
  const value = golden4()
  value.unavailable = [{ field: "outcomes", reason: "capped" }]
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
})

test("finished_on is a real calendar day, written exactly as YYYY-MM-DD, no earlier than 2025-01-01", () => {
  for (const day of ["2025-01-01", "2026-09-25", "2028-02-29", "2026-12-31"]) {
    assert.deepEqual(validatePublished(setPath(golden4(), ["jobs", 0, "finished_on"], day)), { ok: true, errors: [] }, day)
  }
  for (const day of ["2026-9-25", "2026-02-30", "2027-02-29", "2026-13-01", "2026-00-10", "2026-09-25T00:00:00.000Z", " 2026-09-25", "2026-09-25\n", "20260925", "", `${SENTINEL}-2026-09-25`]) {
    const result = validatePublished(setPath(golden4(), ["jobs", 0, "finished_on"], day))
    assertSingle(result, "pattern", "jobs.0.finished_on")
    assertNoLeak(result)
  }
  for (const day of ["2024-12-31", "1970-01-01", "0000-01-01"]) {
    assertSingle(validatePublished(setPath(golden4(), ["jobs", 0, "finished_on"], day)), "range", "jobs.0.finished_on")
  }
  for (const bad of [20260925, true, {}, ["2026-09-25"]]) {
    assertSingle(validatePublished(setPath(golden4(), ["jobs", 0, "finished_on"], bad)), "type", "jobs.0.finished_on")
  }
})

test("finished_basis is transition, card_updated or null, and is null exactly when finished_on is", () => {
  const result = validatePublished(setPath(golden4(), ["jobs", 0, "finished_basis"], SENTINEL))
  assertSingle(result, "enum", "jobs.0.finished_basis")
  assertNoLeak(result)
  assertSingle(validatePublished(setPath(golden4(), ["jobs", 0, "finished_basis"], null)), "inconsistent", "jobs.0.finished_basis")
  assertSingle(validatePublished(setPath(golden4(), ["jobs", 1, "finished_basis"], "card_updated")), "inconsistent", "jobs.1.finished_basis")
  // A day of either source on a job whose card was seen done.
  const card = setPath(golden4(), ["jobs", 0, "finished_basis"], "card_updated")
  assert.deepEqual(validatePublished(card), { ok: true, errors: [] })
})

test("finished_on is set only on a job whose card was observed done or cancelled", () => {
  // Open (processing) and never observed.
  for (const index of [1, 3]) {
    const value = golden4()
    value.jobs[index].finished_on = "2026-09-25"
    value.jobs[index].finished_basis = "card_updated"
    assertSingle(validatePublished(value), "inconsistent", `jobs.${index}.finished_on`)
  }
  const cancelled = golden4()
  cancelled.jobs[0].observed.status = "cancelled"
  cancelled.jobs[0].transitions[1].to = "cancelled"
  assert.deepEqual(validatePublished(cancelled), { ok: true, errors: [] })
})

test("the basis names a source the file itself carries: a timed transition into the observed status, or a timed observation", () => {
  // No transition into the observed status.
  let value = golden4()
  value.jobs[0].transitions = [{ to: "processing", offset_ms: 86700000 }]
  assertSingle(validatePublished(value), "inconsistent", "jobs.0.finished_basis")
  // A transition into it with no offset (no readable card creation time).
  value = golden4()
  value.jobs[0].transitions[1].offset_ms = null
  assertSingle(validatePublished(value), "inconsistent", "jobs.0.finished_basis")
  // The card's update with no offset.
  value = golden4()
  value.jobs[0].finished_basis = "card_updated"
  value.jobs[0].observed.offset_ms = null
  assertSingle(validatePublished(value), "inconsistent", "jobs.0.finished_basis")
  // Job 2 was seen done but has no offsets, so it can carry no day.
  value = golden4()
  value.jobs[2].finished_on = "2026-09-25"
  value.jobs[2].finished_basis = "card_updated"
  assertSingle(validatePublished(value), "inconsistent", "jobs.2.finished_basis")
})

test("finished_on is the only key exempt from the date refusal: every other string in a /4 file still refuses a date", () => {
  const leaves = stringLeaves(golden4()).filter((keys) => keys[keys.length - 1] !== "finished_on")
  assert.ok(leaves.some((keys) => keys[keys.length - 1] === "finished_basis"))
  assert.ok(leaves.some((keys) => keys.includes("stop")))
  for (const keys of leaves) {
    const result = validatePublished(setPath(golden4(), keys, "2026-09-25"))
    assert.equal(result.ok, false, ps(keys))
    assertNoLeak(result)
  }
  // The exemption is the field, not the value: a date in a model ID is still `date`.
  assertSingle(validatePublished(setPath(golden4(), ["models", 0, "id"], "gpt-4o-2024-08-06")), "date", "models.0.id")
  // And a time of day is never a finish day.
  assertSingle(validatePublished(setPath(golden4(), ["jobs", 0, "finished_on"], "08:30")), "pattern", "jobs.0.finished_on")
})

test("a desk_public /4 file carries no finish day: both keys null, else the job is inconsistent", () => {
  const value = golden4()
  value.jobs = value.jobs.map((job) => ({ ...job, session_offset_ms: null, transitions: [], observed: job.observed === null ? null : { status: job.observed.status, offset_ms: null }, finished_on: null, finished_basis: null }))
  value.unavailable = [{ field: "job_offsets", reason: "desk_public" }]
  delete value.refs.commits[0].at_ms
  // The PR flag and the stop facts are no job timing.
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
  const dated = structuredClone(value)
  dated.jobs[0].finished_on = "2026-09-25"
  const result = validatePublished(dated)
  assert.ok(result.errors.some((error) => error.code === "inconsistent" && error.path === "jobs.0"), JSON.stringify(result.errors))
})

test("stop exists only on a human_wait interval: on any other kind it is an unknown key", () => {
  for (const index of [0, 1, 3]) {
    const value = golden4()
    value.intervals[index].stop = { end: "end_turn", asks: null, pending_agents: null }
    assertSingle(validatePublished(value), "unknown_key", `intervals.${index}`)
  }
})

test("stop holds a stop end, and asks and pending_agents as true, false or null, and nothing else", () => {
  for (const end of ENUMS.stopEnd) {
    for (const flag of [true, false, null]) {
      const value = setPath(golden4(), ["intervals", WAIT_INDEX, "stop"], { end, asks: flag, pending_agents: flag })
      assert.deepEqual(validatePublished(value), { ok: true, errors: [] }, `${end} ${flag}`)
    }
  }
  const stopPath = ["intervals", WAIT_INDEX, "stop"]
  const cases = [
    { keys: [...stopPath, "end"], value: SENTINEL, code: "enum" },
    { keys: [...stopPath, "end"], value: null, code: "type" },
    { keys: [...stopPath, "asks"], value: SENTINEL, code: "type" },
    { keys: [...stopPath, "asks"], value: 1, code: "type" },
    { keys: [...stopPath, "pending_agents"], value: SENTINEL, code: "type" },
    { keys: stopPath, value: SENTINEL, code: "type" },
    { keys: stopPath, value: null, code: "type" },
  ]
  for (const spec of cases) {
    const result = validatePublished(setPath(golden4(), spec.keys, spec.value))
    assertSingle(result, spec.code, ps(spec.keys))
    assertNoLeak(result)
  }
  for (const key of ["end", "asks", "pending_agents"]) {
    assertSingle(validatePublished(deletePath(golden4(), [...stopPath, key])), "missing", ps([...stopPath, key]))
  }
  // No text and no tool name rides along.
  for (const key of [SENTINEL, "text", "tool"]) {
    const result = validatePublished(setPath(golden4(), [...stopPath, key], SENTINEL))
    assertSingle(result, "unknown_key", ps(stopPath))
    assertNoLeak(result)
  }
})

test("refs.prs[].created is a boolean, and a PR the session only looked at is false", () => {
  assert.deepEqual(validatePublished(setPath(golden4(), ["refs", "prs", 0, "created"], false)), { ok: true, errors: [] })
  for (const bad of [null, "true", 1]) {
    assertSingle(validatePublished(setPath(golden4(), ["refs", "prs", 0, "created"], bad)), "type", "refs.prs.0.created")
  }
  // With the optional keys it already had.
  const value = golden4()
  value.refs.prs[0].agent = 1
  value.refs.prs[0].at_ms = 600000
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
})

test("a /4 file with no job, PR or human wait needs none of the new keys", () => {
  const value = golden4()
  value.jobs = []
  value.refs.prs = []
  value.intervals = value.intervals.filter((item) => item.kind !== "human_wait")
  value.outcomes = []
  assert.deepEqual(validatePublished(value), { ok: true, errors: [] })
})

test("the /4 level specs carry check functions", () => {
  for (const name of ["stop", "jobV4", "prV4", "intervalWaitV4"]) {
    assert.ok(__PUBLISHED_SPECS__[name], name)
    for (const [fieldName, field] of Object.entries(__PUBLISHED_SPECS__[name])) assert.equal(typeof field.check, "function", `${name}.${fieldName}`)
  }
})
