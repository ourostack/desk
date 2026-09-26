// The publishing transform: local facts in, the only bytes that ever leave
// the machine out. No who, no when, just how.
//
// Every input is synthetic: the golden local fixture, the derivers' own
// synthetic transcript and events fixtures (bound to invented tasks through
// fake readers), and seeded random local facts. No real transcript, log or
// desk is read.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, cpSync, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { createHmac } from "node:crypto"

import { toPublished, serializePublished, publishedFileName, REFUSALS, EARLIEST_SESSION_START } from "../../src/factory/publish.js"
import { validatePublished, validatePublishedBytes, PUBLISHED_LIMITS, DATE_SHAPE } from "../../src/factory/published-schema.js"
import { validateLocalFacts, LIMITS, ENUMS } from "../../src/factory/schema.js"
import { deriveClaudeSession } from "../../src/factory/derive-claude.js"
import { deriveCopilotSession } from "../../src/factory/derive-copilot.js"
import { bindSession } from "../../src/factory/binding.js"
import { SESSION_IDS } from "./fixtures/claude/make.js"
import { SESSIONS, buildSessionStore, defaultStoreRows, fakeCommitResolver } from "./fixtures/copilot/make.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, "fixtures")
const LOCAL_GOLDEN = JSON.parse(readFileSync(path.join(FIXTURES, "local-golden.json"), "utf8"))
const PUBLISHED_GOLDEN_TEXT = readFileSync(path.join(FIXTURES, "published-golden.json"), "utf8")
const SENTINEL = "SENTINEL-7f3a"

const SECRET = Buffer.alloc(32, 7)
const VISIBILITY = Object.freeze({ "ourostack/desk": "public", "ourostack/factory": "public", "private-org/private-repo": "private" })
const visibility = (repo) => VISIBILITY[repo] ?? "unknown"

function local() {
  return structuredClone(LOCAL_GOLDEN)
}

function publish(value, options = {}) {
  return toPublished(value, { visibility, deskVisibility: "private", ...options })
}

// ---------------------------------------------------------------------------
// The golden pair.
// ---------------------------------------------------------------------------

test("the golden local fixture is valid local facts", () => {
  assert.deepEqual(validateLocalFacts(local()), { ok: true, errors: [] })
})

test("the golden local fixture transforms to the golden published fixture byte for byte", () => {
  const { published, dropped } = publish(local())
  assert.equal(serializePublished(published), PUBLISHED_GOLDEN_TEXT)
  assert.deepEqual(dropped, { prs: 3, commits: 3 })
  assert.deepEqual(validatePublishedBytes(serializePublished(published)), { ok: true, errors: [] })
})

test("the published file is named <host>-<session id>.json", () => {
  const { published } = publish(local())
  assert.equal(publishedFileName(published), "claude-code-3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60.json")
})

test("the transform is pure and deterministic: the input is untouched and two runs agree", () => {
  const input = local()
  const first = publish(input)
  assert.deepEqual(input, LOCAL_GOLDEN)
  const second = publish(input)
  assert.deepEqual(first, second)
  assert.notEqual(first.published, second.published)
  first.published.models[0].tokens.input = 1
  first.published.refs.private.prs = 99
  assert.deepEqual(input, LOCAL_GOLDEN, "the output shares no object with the input")
})

// ---------------------------------------------------------------------------
// No when.
// ---------------------------------------------------------------------------

test("the session carries its duration and whether it ended, never a time", () => {
  const value = local()
  value.session.ended_at = null
  value.session.end_reason = null
  const { published } = publish(value)
  assert.deepEqual(published.session, {
    host: "claude-code",
    id: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60",
    host_version: "2.1.282",
    entrypoint: "desktop",
    duration_ms: 5400000,
    ended: false,
    end_reason: null,
  })
})

test("intervals become milliseconds since the session started", () => {
  const { published } = publish(local())
  assert.deepEqual(published.intervals[1], { kind: "tool", agent: 0, tool: "shell", outcome: "error", start_ms: 5000, end_ms: 9000 })
})

test("an interval outside the session's span is dropped and its field marked unreadable, never clamped", () => {
  const value = local()
  value.intervals = [
    { kind: "turn", agent: 0, start: "2026-09-25T07:59:59.999Z", end: "2026-09-25T08:01:00.000Z" },
    { kind: "tool", agent: 0, tool: "read", outcome: "ok", start: "2026-09-25T09:29:00.000Z", end: "2026-09-25T09:30:00.001Z" },
    { kind: "compaction", agent: 0, start: "2026-09-25T07:00:00.000Z", end: "2026-09-25T07:01:00.000Z" },
    { kind: "permission_wait", agent: 0, start: "2026-09-25T09:31:00.000Z", end: "2026-09-25T09:32:00.000Z" },
    { kind: "human_wait", agent: 0, start: "2026-09-25T08:00:00.000Z", end: "2026-09-25T09:30:00.000Z" },
  ]
  const { published } = publish(value)
  assert.deepEqual(published.intervals, [{ kind: "human_wait", agent: 0, start_ms: 0, end_ms: 5400000 }])
  assert.deepEqual(published.unavailable.slice(2), [
    { field: "turns", reason: "source_unreadable" },
    { field: "tool_durations", reason: "source_unreadable" },
    { field: "permission_waits", reason: "source_unreadable" },
    { field: "job_offsets", reason: "source_unreadable" },
  ])
  assert.equal(validatePublished(published).ok, true)
})

test("every interval kind maps its loss to an unavailable field the published schema knows", () => {
  for (const kind of ENUMS.intervalKind) {
    const value = local()
    value.intervals = [kind === "tool"
      ? { kind, agent: 0, tool: "read", outcome: "ok", start: "2026-09-25T07:00:00.000Z", end: "2026-09-25T07:00:01.000Z" }
      : { kind, agent: 0, start: "2026-09-25T07:00:00.000Z", end: "2026-09-25T07:00:01.000Z" }]
    const { published } = publish(value)
    assert.deepEqual(published.intervals, [], kind)
    assert.equal(validatePublished(published).ok, true, kind)
    assert.ok(published.unavailable.some((entry) => entry.reason === "source_unreadable" && entry.field !== "job_offsets"), kind)
  }
})

test("job offsets are measured from the task card's creation, signed", () => {
  const { published } = publish(local())
  assert.deepEqual(published.jobs[0], {
    job: "1a2b3c4d5e6f708192a3b4c5d6e7f809",
    basis: ["desk_tool", "file_write"],
    session_offset_ms: 86400000,
    transitions: [{ to: "processing", offset_ms: 86700000 }, { to: "done", offset_ms: 90000000 }],
    observed: { status: "done", offset_ms: 90000500 },
  })
  assert.equal(published.jobs[1].session_offset_ms, -1800000, "a session may begin before its task card exists")
})

test("a non-terminal card publishes its status with a null offset, and no observation publishes null", () => {
  const { published } = publish(local())
  assert.deepEqual(published.jobs[1].observed, { status: "processing", offset_ms: null })
  assert.equal(published.jobs[3].observed, null)
})

test("a job without task_created_at publishes no offsets, drops its transitions and marks job_offsets unreadable", () => {
  const { published } = publish(local())
  assert.deepEqual(published.jobs[2], {
    job: "9f2c4b1a7d3e5f60718293a4b5c6d7e8",
    basis: ["desk_commit"],
    session_offset_ms: null,
    transitions: [],
    observed: { status: "done", offset_ms: null },
  })
  assert.deepEqual(published.unavailable.at(-1), { field: "job_offsets", reason: "source_unreadable" })
})

test("when every job has its creation time, job_offsets is not marked", () => {
  const value = local()
  value.jobs = value.jobs.filter((job) => job.task_created_at !== null)
  const { published } = publish(value)
  assert.equal(published.unavailable.some((entry) => entry.field === "job_offsets"), false)
})

test("an offset beyond the cap is treated as unreadable, so a bad creation time cannot publish an epoch value", () => {
  const value = local()
  value.jobs = [{
    job: "c0ffee00c0ffee00c0ffee00c0ffee00",
    basis: ["desk_tool"],
    task_created_at: "1970-01-01T00:00:00.000Z",
    transitions: [{ to: "done", at: "2026-09-25T09:00:00.000Z" }],
    observed: { status: "done", at: "2026-09-25T09:00:00.000Z" },
  }, {
    job: "d0ffee00c0ffee00c0ffee00c0ffee00",
    basis: ["desk_tool"],
    task_created_at: "2026-09-25T08:00:00.000Z",
    transitions: [{ to: "processing", at: "1970-01-01T00:00:00.000Z" }, { to: "done", at: "2026-09-25T09:00:00.000Z" }],
    observed: { status: "done", at: "2026-09-25T09:00:00.000Z" },
  }]
  const { published } = publish(value)
  assert.deepEqual(published.jobs, [
    { job: "c0ffee00c0ffee00c0ffee00c0ffee00", basis: ["desk_tool"], session_offset_ms: null, transitions: [], observed: { status: "done", offset_ms: null } },
    { job: "d0ffee00c0ffee00c0ffee00c0ffee00", basis: ["desk_tool"], session_offset_ms: 0, transitions: [{ to: "done", offset_ms: 3600000 }], observed: { status: "done", offset_ms: 3600000 } },
  ])
  assert.deepEqual(published.unavailable.at(-1), { field: "job_offsets", reason: "source_unreadable" })
  assert.equal(validatePublished(published).ok, true)
  assert.ok(PUBLISHED_LIMITS.maxOffsetMs < Date.parse("2026-01-01T00:00:00.000Z"))
})

test("an offset exactly at the cap is kept", () => {
  const value = local()
  const created = new Date(Date.parse(value.session.started_at) - PUBLISHED_LIMITS.maxOffsetMs).toISOString()
  value.jobs = [{ job: "c0ffee00c0ffee00c0ffee00c0ffee00", basis: ["desk_tool"], task_created_at: created, transitions: [], observed: null }]
  assert.equal(publish(value).published.jobs[0].session_offset_ms, PUBLISHED_LIMITS.maxOffsetMs)
})

// ---------------------------------------------------------------------------
// Public references only.
// ---------------------------------------------------------------------------

test("private, unknown, repo-less and unresolved references are dropped and counted; public ones are kept", () => {
  const { published, dropped } = publish(local())
  assert.deepEqual(published.refs, {
    prs: [{ repo: "ourostack/desk", number: 9 }],
    commits: [{ repo: "ourostack/desk", sha: "fc6ea8a0000000000000000000000000000000aa" }],
    private: { prs: 3, commits: 3 },
  })
  assert.deepEqual(dropped, { prs: 3, commits: 3 }, "two dropped here and one the deriver could not resolve, of each kind")
})

test("only an exact \"public\" keeps a reference; the visibility check sees each repository once and never a null", () => {
  const seen = []
  const answers = { "ourostack/desk": "PUBLIC", "private-org/private-repo": "public", "someone/unknown-repo": undefined }
  const value = local()
  value.refs.prs.push({ repo: "ourostack/desk", number: 10 })
  const { published, dropped } = publish(value, { visibility: (repo) => { seen.push(repo); return answers[repo] } })
  assert.deepEqual(seen, ["ourostack/desk", "private-org/private-repo", "someone/unknown-repo"])
  assert.deepEqual(published.refs.prs, [{ repo: "private-org/private-repo", number: 3 }])
  assert.deepEqual(published.refs.commits, [{ repo: "private-org/private-repo", sha: "fc6ea8a0000000000000000000000000000000bb" }])
  assert.deepEqual(dropped, { prs: 4, commits: 3 })
})

test("a public reference whose repository name is date-shaped is withheld and counted with the dropped ones", () => {
  const value = local()
  value.refs.prs = [{ repo: "acme/notes-2026-09-25", number: 1 }]
  value.refs.commits = [{ repo: "acme/notes-2026-09-25", sha: "a".repeat(40) }]
  value.refs.unresolved = { prs: 0, commits: 0 }
  const seen = []
  const { published, dropped } = publish(value, { visibility: (repo) => { seen.push(repo); return "public" } })
  assert.deepEqual(seen, [])
  assert.deepEqual(published.refs, { prs: [], commits: [], private: { prs: 1, commits: 1 } })
  assert.deepEqual(dropped, { prs: 1, commits: 1 })
})

// ---------------------------------------------------------------------------
// Identifiers carrying a date.
// ---------------------------------------------------------------------------

test("a date inside a model id or plugin name loses its hyphens so no date shape is published", () => {
  const value = local()
  value.models[0].id = "gpt-4o-2024-08-06"
  value.agents[0].model = "gpt-4o-2024-08-06"
  value.agents[1].model = "x-2024-08-06-01-02"
  value.plugins[0].name = "notes-2026-09-25"
  const { published } = publish(value)
  assert.equal(published.models[0].id, "gpt-4o-20240806")
  assert.equal(published.agents[0].model, "gpt-4o-20240806")
  assert.equal(published.agents[1].model, "x-202408060102", "a date shape the first rewrite uncovers is rewritten too")
  assert.equal(published.plugins[0].name, "notes-20260925")
  assert.equal(DATE_SHAPE.test(serializePublished(published)), false)
  assert.equal(validatePublished(published).ok, true)
})

// ---------------------------------------------------------------------------
// unavailable: kept, extended, deduplicated and capped.
// ---------------------------------------------------------------------------

test("unavailable keeps the local entries, adds each new one once, and stays within the cap", () => {
  const value = local()
  value.jobs = [value.jobs[2], { ...value.jobs[2], job: "9f2c4b1a7d3e5f60718293a4b5c6d7e9" }]
  const combos = ENUMS.unavailableField.flatMap((field) => ENUMS.unavailableReason.map((reason) => ({ field, reason })))
  value.unavailable = [...combos.slice(0, LIMITS.unavailable - 1), combos[0]]
  const { published } = publish(value)
  assert.equal(published.unavailable.length, LIMITS.unavailable, "a repeated local entry is kept once; the new one fills the last place")
  assert.deepEqual(published.unavailable.at(-1), { field: "job_offsets", reason: "source_unreadable" })
  assert.equal(validatePublished(published).ok, true)

  value.unavailable = combos.slice(0, LIMITS.unavailable)
  const full = publish(value).published
  assert.equal(full.unavailable.length, LIMITS.unavailable)
  assert.deepEqual(full.unavailable.at(-1), { field: "job_offsets", reason: "source_unreadable" }, "the transform's own entry displaces the last local one")
  assert.deepEqual(full.unavailable.slice(0, -1), combos.slice(0, LIMITS.unavailable - 1))
  assert.equal(validatePublished(full).ok, true)

  // The local file already holds the marker, in the place the cap cuts.
  const cut = local()
  cut.jobs = []
  cut.intervals.push({ kind: "turn", agent: 0, start: "2026-09-25T09:29:00.000Z", end: "2026-09-25T09:31:00.000Z" })
  const others = combos.filter((entry) => !(entry.field === "turns" && entry.reason === "source_unreadable"))
  cut.unavailable = [...others.slice(0, LIMITS.unavailable - 1), { field: "turns", reason: "source_unreadable" }]
  const kept = publish(cut).published.unavailable
  assert.equal(kept.length, LIMITS.unavailable)
  assert.deepEqual(kept.at(-1), { field: "turns", reason: "source_unreadable" }, "the transform's own marker is kept first")

  const few = local()
  few.jobs = [few.jobs[2], { ...few.jobs[2], job: "9f2c4b1a7d3e5f60718293a4b5c6d7e9" }]
  const result = publish(few).published.unavailable
  assert.equal(result.filter((entry) => entry.field === "job_offsets").length, 1)
})

// ---------------------------------------------------------------------------
// Caller bugs.
// ---------------------------------------------------------------------------

test("invalid local facts are refused with a TypeError that echoes nothing", () => {
  const value = local()
  value.session.id = `${SENTINEL} free text`
  assert.throws(() => publish(value), (error) => error instanceof TypeError && !error.message.includes(SENTINEL))
  assert.throws(() => publish({ ...local(), contributor: SENTINEL }), TypeError)
  assert.throws(() => publish(null), TypeError)
})

test("a missing visibility function is a caller bug", () => {
  assert.throws(() => toPublished(local()), TypeError)
  assert.throws(() => toPublished(local(), {}), TypeError)
  assert.throws(() => toPublished(local(), { visibility: "public" }), TypeError)
})

test("a desk that is not surely private needs a machine secret of at least 32 bytes", () => {
  for (const deskVisibility of ["public", "unknown", undefined, "PRIVATE"]) {
    assert.throws(() => toPublished(local(), { visibility, deskVisibility }), TypeError, String(deskVisibility))
    assert.throws(() => toPublished(local(), { visibility, deskVisibility, machineSecret: Buffer.alloc(31) }), TypeError)
    assert.throws(() => toPublished(local(), { visibility, deskVisibility, machineSecret: "x".repeat(64) }), TypeError)
    assert.ok(toPublished(local(), { visibility, deskVisibility, machineSecret: SECRET }).published)
  }
})

// ---------------------------------------------------------------------------
// Fix round 2: refusals (review Critical and I1).
// ---------------------------------------------------------------------------

test("REFUSALS names every reason the transform can give", () => {
  assert.deepEqual(REFUSALS, ["implausible_session_span", "session_id_not_v4"])
})

test("a session starting at a 1970 or 2000 anchor is refused, never published with epoch offsets", () => {
  for (const anchor of ["1970-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z"]) {
    const value = local()
    value.session.started_at = anchor
    assert.equal(validateLocalFacts(value).ok, true)
    assert.deepEqual(publish(value), { published: null, dropped: null, reason: "implausible_session_span" }, anchor)
  }
})

test("a session exactly at the ten-year cap is published; one millisecond more is refused", () => {
  const value = local()
  value.session.started_at = EARLIEST_SESSION_START
  value.session.derived_through = new Date(Date.parse(EARLIEST_SESSION_START) + PUBLISHED_LIMITS.maxOffsetMs).toISOString()
  value.jobs = []
  const { published } = publish(value)
  assert.equal(published.session.duration_ms, PUBLISHED_LIMITS.maxOffsetMs)
  assert.equal(validatePublished(published).ok, true)
  value.session.derived_through = new Date(Date.parse(value.session.derived_through) + 1).toISOString()
  assert.equal(publish(value).reason, "implausible_session_span")
})

test("a session that starts before 2025, when neither host existed, is refused even inside the cap", () => {
  assert.equal(EARLIEST_SESSION_START, "2025-01-01T00:00:00.000Z")
  for (const anchor of ["2020-01-01T00:00:00.000Z", "2024-12-31T23:59:59.999Z"]) {
    const value = local()
    value.session.started_at = anchor
    assert.deepEqual(publish(value), { published: null, dropped: null, reason: "implausible_session_span" }, anchor)
  }
  const value = local()
  value.session.started_at = EARLIEST_SESSION_START
  value.jobs = []
  assert.equal(publish(value).published.session.duration_ms, Date.parse(value.session.derived_through) - Date.parse(EARLIEST_SESSION_START))
})

test("a session ID that is not version 4 is refused; a v4 one is published", () => {
  for (const id of ["c232ab00-9414-11ec-b3c8-9f6bdeced846", "01927a3b-8c00-7abc-8def-0123456789ab"]) {
    const value = local()
    value.session.id = id
    assert.equal(validateLocalFacts(value).ok, true, "the local schema keeps every version")
    assert.deepEqual(publish(value), { published: null, dropped: null, reason: "session_id_not_v4" }, id)
  }
  const value = local()
  value.session.id = "0b1c2d3e-4f50-4617-a829-3a4b5c6d7e8f"
  assert.equal(publish(value).published.session.id, "0b1c2d3e-4f50-4617-a829-3a4b5c6d7e8f")
})

// ---------------------------------------------------------------------------
// Fix round 2: a public desk keeps its job timing (review I3).
// ---------------------------------------------------------------------------

const keyed = (job) => createHmac("sha256", SECRET).update(job).digest("hex").slice(0, 32)

test("a public or unknown desk publishes keyed job IDs, no job timing and desk_public", () => {
  for (const deskVisibility of ["public", "unknown"]) {
    const { published } = publish(local(), { deskVisibility, machineSecret: SECRET })
    assert.deepEqual(published.jobs, LOCAL_GOLDEN.jobs.map((job) => ({
      job: keyed(job.job),
      basis: job.basis,
      session_offset_ms: null,
      transitions: [],
      observed: job.observed === null ? null : { status: job.observed.status, offset_ms: null },
    })).sort((a, b) => (a.job < b.job ? -1 : 1)), deskVisibility)
    const keys = published.jobs.map((job) => job.job)
    assert.deepEqual(keys, [...keys].sort(), "sorted by keyed ID")
    assert.notDeepEqual(keys, LOCAL_GOLDEN.jobs.map((job) => keyed(job.job)), "the fixture's plain order differs, so the sort is real")
    assert.equal(published.jobs.some((job) => LOCAL_GOLDEN.jobs.some((plain) => plain.job === job.job)), false)
    assert.deepEqual(published.unavailable, [
      { field: "permission_waits", reason: "host_does_not_record" },
      { field: "tool_durations", reason: "capped" },
      { field: "job_offsets", reason: "desk_public" },
    ], "timing withheld on purpose, so no source_unreadable")
    assert.equal(validatePublished(published).ok, true)
  }
  const other = publish(local(), { deskVisibility: "public", machineSecret: Buffer.alloc(32, 8) }).published
  assert.notEqual(other.jobs[0].job, keyed(LOCAL_GOLDEN.jobs[0].job), "another machine's secret gives other IDs")
})

test("a public desk with no jobs adds no desk_public entry", () => {
  const value = local()
  value.jobs = []
  const { published } = publish(value, { deskVisibility: "public", machineSecret: SECRET })
  assert.equal(published.unavailable.some((entry) => entry.reason === "desk_public"), false)
})

test("private and internal desks keep plain job IDs and their offsets", () => {
  for (const deskVisibility of ["private", "internal"]) {
    const { published } = publish(local(), { deskVisibility })
    assert.equal(serializePublished(published), PUBLISHED_GOLDEN_TEXT, deskVisibility)
  }
})

// ---------------------------------------------------------------------------
// Fix round 2: times of day and repeated references (review M1, M3).
// ---------------------------------------------------------------------------

test("a time of day inside a model ID loses its colons, repeatedly, even when that uncovers a date", () => {
  const value = local()
  value.models[0].id = "m:08:30:00"
  value.models[1].id = "m20:26-09-25"
  value.agents[0].model = "m-2024-08-06:08:30"
  value.agents[1].model = "m:20:26-09-25"
  const { published } = publish(value)
  assert.equal(published.models[0].id, "m:083000")
  assert.equal(published.models[1].id, "m20260925")
  assert.equal(published.agents[0].model, "m-202408060830")
  assert.equal(published.agents[1].model, "m:20260925")
  assert.equal(validatePublished(published).ok, true)
})

test("a reference repeated in the local file is published once and not counted as dropped", () => {
  const value = local()
  value.refs.prs.push({ repo: "ourostack/desk", number: 9 })
  value.refs.commits.push({ repo: "ourostack/desk", sha: "fc6ea8a0000000000000000000000000000000aa" })
  const { published, dropped } = publish(value)
  assert.deepEqual(published.refs.prs, [{ repo: "ourostack/desk", number: 9 }])
  assert.equal(published.refs.commits.length, 1)
  assert.deepEqual(dropped, { prs: 3, commits: 3 })
  assert.equal(validatePublished(published).ok, true)
})

test("publishedFileName refuses a value that is not valid published facts", () => {
  assert.throws(() => publishedFileName(local()), TypeError)
  assert.throws(() => publishedFileName({ session: { host: "../../x", id: SENTINEL } }), (error) => error instanceof TypeError && !error.message.includes(SENTINEL))
})

// ---------------------------------------------------------------------------
// Property test: nothing that leaves the machine carries a when, a who, a
// path, an epoch-sized value or planted content — over every fixture.
// ---------------------------------------------------------------------------

const EPOCH_SECONDS = [Date.parse("2000-01-01T00:00:00.000Z") / 1000, Date.parse("2100-01-01T00:00:00.000Z") / 1000]
const EPOCH_MS = [EPOCH_SECONDS[0] * 1000, EPOCH_SECONDS[1] * 1000]
const isEpochSized = (n) => (n >= EPOCH_SECONDS[0] && n <= EPOCH_SECONDS[1]) || (n >= EPOCH_MS[0] && n <= EPOCH_MS[1])
const REPO_KEYS = new Set(["repo"])
// Durations and offsets are milliseconds by definition, so a value there may
// be as large as epoch seconds; it may never reach epoch milliseconds.
const MS_KEYS = new Set(["duration_ms", "start_ms", "end_ms", "session_offset_ms", "offset_ms"])

function* leaves(value, keys = []) {
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) yield* leaves(child, [...keys, key])
    for (const key of Object.keys(value)) yield { key: true, value: key, keys }
    return
  }
  yield { key: false, value, keys }
}

function assertNothingLeaves(published, label) {
  const text = serializePublished(published)
  assert.deepEqual(validatePublishedBytes(text), { ok: true, errors: [] }, label)
  assert.equal(DATE_SHAPE.test(text), false, `${label}: a date-shaped substring`)
  assert.equal(text.includes(SENTINEL), false, `${label}: a sentinel`)
  assert.equal(/contributor|operator|hostname/u.test(text), false, `${label}: an identity key`)
  for (const leaf of leaves(JSON.parse(text))) {
    if (typeof leaf.value === "number") {
      const where = `${label}: epoch-sized ${leaf.keys.join(".")}`
      if (MS_KEYS.has(leaf.keys.at(-1))) assert.ok(Math.abs(leaf.value) < EPOCH_MS[0], where)
      else assert.equal(isEpochSized(Math.abs(leaf.value)), false, where)
    }
    if (typeof leaf.value !== "string") continue
    const where = `${label}: ${leaf.keys.join(".")}`
    assert.equal(/^[0-9a-f]{16}$/u.test(leaf.value), false, `${where}: a contributor-shaped id`)
    assert.equal(/[\\~]|^\//u.test(leaf.value), false, `${where}: a path`)
    assert.equal(/\d{2}:\d{2}/u.test(leaf.value), false, `${where}: a time of day`)
    if (leaf.value.includes("/")) {
      const allowed = (!leaf.key && REPO_KEYS.has(leaf.keys.at(-1))) || (leaf.keys.length === 1 && leaf.keys[0] === "schema")
      assert.ok(allowed, `${where}: a slash outside a repository name`)
    }
  }
}

// Fake readers: every task binds, and its card has invented times.
const FAKE_DESK = `/tmp/${SENTINEL}/desk`
function bindFixture(facts, events) {
  const { jobs } = bindSession({
    events,
    deskRoot: FAKE_DESK,
    deskRemote: `git@github.com:${SENTINEL}/desk.git`,
    personPrefix: "",
    readTask: (track) => (track.length % 2 === 0
      ? { status: "done", created_at: "2026-09-20T08:00:00.000Z", updated_at: "2026-09-25T08:00:30.000Z" }
      : { status: "processing", created_at: null, updated_at: null }),
    deskCommitsBetween: () => [],
    gitCommitTaskPaths: () => ({ exists: false }),
  })
  return { ...facts, jobs }
}

async function derivedFixtures() {
  const out = []
  const claudeDir = path.join(FIXTURES, "claude")
  for (const [name, id] of Object.entries(SESSION_IDS)) {
    for (const endReason of [null, "prompt_input_exit"]) {
      const result = await deriveClaudeSession({ transcriptPath: path.join(claudeDir, `${id}.jsonl`), plugins: [{ name: "desk", version: "3.2.0-alpha.29" }], endReason })
      if (result.facts !== null) out.push({ label: `claude ${name} ${endReason}`, facts: bindFixture(result.facts, result.events) })
    }
  }
  const home = mkdtempSync(path.join(os.tmpdir(), "desk-publish-copilot-"))
  try {
    for (const id of Object.values(SESSIONS)) {
      const dir = path.join(home, "session-state", id)
      mkdirSync(dir, { recursive: true })
      cpSync(path.join(FIXTURES, "copilot", id, "events.jsonl"), path.join(dir, "events.jsonl"))
    }
    buildSessionStore(path.join(home, "session-store.db"), defaultStoreRows())
    for (const [name, id] of Object.entries(SESSIONS)) {
      for (const endReason of [null, "complete"]) {
        const result = await deriveCopilotSession({ sessionId: id, copilotHome: home, plugins: [], endReason, resolveCommits: fakeCommitResolver() })
        if (result.facts !== null) out.push({ label: `copilot ${name} ${endReason}`, facts: bindFixture(result.facts, result.events) })
      }
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
  return out
}

test("property: every fixture's published file carries no date, time of day, who, path, epoch-sized value or sentinel", async () => {
  const fixtures = [{ label: "golden", facts: local() }, ...(await derivedFixtures())]
  assert.ok(fixtures.length >= 10, `only ${fixtures.length} fixtures`)
  let jobs = 0
  for (const { label, facts } of fixtures) {
    assert.deepEqual(validateLocalFacts(facts).errors, [], `${label}: local facts must be valid`)
    jobs += facts.jobs.length
    const { published } = publish(facts)
    assertNothingLeaves(published, label)
  }
  assert.ok(jobs > 0, "the fixtures bind at least one job")
})

// A small seeded generator (mulberry32), so a failure reproduces exactly.
function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randomLocal(random) {
  const int = (max) => Math.floor(random() * max)
  const pick = (list) => list[int(list.length)]
  const iso = (ms) => new Date(ms).toISOString()
  // Most sessions start between 2001 and 2099; some start near 1970 or
  // 2000, the anchors a bogus first log line would give, and some run for
  // years, so the transform's refusal is exercised too.
  const anchorKind = random()
  let start = Date.parse(EARLIEST_SESSION_START) + int(74 * 365) * 86400000 + int(86400000)
  if (anchorKind < 0.1) start = int(30 * 86400000)
  else if (anchorKind < 0.2) start = Date.parse("2000-01-01T00:00:00.000Z") + int(30 * 86400000) - 15 * 86400000
  else if (anchorKind < 0.3) start = Date.parse("2020-01-01T00:00:00.000Z") + int(30 * 86400000)
  const duration = random() < 0.2 ? int(40 * 365 * 86400000) : int(3 * 86400000)
  const hex = (length) => Array.from({ length }, () => "0123456789abcdef"[int(16)]).join("")
  const within = () => start + int(duration + 1)
  const intervals = Array.from({ length: int(40) }, () => {
    const a = within()
    const b = a + int(start + duration - a + 1)
    const kind = pick(ENUMS.intervalKind)
    return kind === "tool"
      ? { kind, agent: 0, tool: pick(ENUMS.toolKind), outcome: pick(ENUMS.outcome), start: iso(a), end: iso(b) }
      : { kind, agent: 0, start: iso(a), end: iso(b) }
  })
  const repos = ["ourostack/desk", "private-org/private-repo", `${SENTINEL}/secret`, "acme/notes-2031-01-01", null]
  return {
    schema: "desk.factory.local/1",
    session: {
      host: pick(ENUMS.host),
      id: `${hex(8)}-${hex(4)}-4${hex(3)}-8${hex(3)}-${hex(12)}`,
      host_version: `${int(3)}.${int(20)}.${int(400)}`,
      entrypoint: pick(ENUMS.entrypoint),
      started_at: iso(start),
      ended_at: random() < 0.5 ? null : iso(start + duration),
      end_reason: random() < 0.5 ? null : pick(ENUMS.endReason),
      derived_through: iso(start + duration),
    },
    plugins: [{ name: pick(["desk", "superpowers", "notes-2026-09-25"]), version: "3.2.0-alpha.29" }],
    models: [{ id: pick(["claude-opus-5-5", "gpt-4o-2024-08-06", "gpt-5.2"]), requests: int(1000), tokens: { input: int(1e6), output: int(1e6), cache_read: int(9e8), cache_write: null, reasoning: int(1e5) } }],
    intervals,
    agents: [{ n: 0, parent: null, model: pick(["claude-opus-5-5", "gpt-4o-2024-08-06"]) }],
    counts: { tool_calls: { shell: int(500) }, tool_failures: {}, tool_retries: int(10), api_retries: int(10), compactions: int(3) },
    refs: {
      prs: Array.from({ length: int(5) }, (_, index) => ({ repo: pick(repos.slice(0, 4)), number: 1 + index })),
      commits: Array.from({ length: int(5) }, () => ({ repo: pick(repos), sha: hex(40) })),
      unresolved: { prs: int(3), commits: int(3) },
    },
    jobs: Array.from({ length: int(4) }, () => {
      const created = random() < 0.2 ? null : iso(start - int(400 * 86400000) + int(2 * 86400000))
      const terminal = random() < 0.5
      return {
        job: hex(32),
        basis: ["desk_tool"],
        task_created_at: created,
        transitions: Array.from({ length: int(3) }, () => ({ to: pick(ENUMS.jobStatus), at: iso(within()) })).sort((a, b) => (a.at < b.at ? -1 : 1)),
        observed: random() < 0.2 ? null : { status: terminal ? "done" : "processing", at: terminal ? iso(within()) : null },
      }
    }),
    unavailable: [],
  }
}

test("property: 300 seeded random local files publish nothing that identifies a when, a who, a path or planted content", () => {
  const random = rng(0x5eed)
  const visible = (repo) => (repo === "ourostack/desk" || repo === "acme/notes-2031-01-01" ? "public" : repo.startsWith(SENTINEL) ? "private" : "unknown")
  const seen = { refused: 0, published: 0, publicDesk: 0 }
  for (let index = 0; index < 300; index += 1) {
    const value = randomLocal(random)
    assert.deepEqual(validateLocalFacts(value).errors, [], `sample ${index}`)
    const deskVisibility = ["private", "internal", "public", "unknown"][index % 4]
    const result = toPublished(value, { visibility: visible, deskVisibility, machineSecret: SECRET })
    const span = Date.parse(value.session.derived_through) - Date.parse(value.session.started_at)
    if (span > PUBLISHED_LIMITS.maxOffsetMs || Date.parse(value.session.started_at) < Date.parse(EARLIEST_SESSION_START)) {
      assert.deepEqual(result, { published: null, dropped: null, reason: "implausible_session_span" }, `sample ${index}`)
      seen.refused += 1
      continue
    }
    const { published, dropped } = result
    seen.published += 1
    assertNothingLeaves(published, `sample ${index}`)
    if (deskVisibility === "public" || deskVisibility === "unknown") {
      seen.publicDesk += 1
      for (const job of published.jobs) {
        assert.equal(job.session_offset_ms, null)
        assert.deepEqual(job.transitions, [])
        assert.ok(job.observed === null || job.observed.offset_ms === null)
      }
      assert.deepEqual(published.jobs.map((job) => job.job), value.jobs.map((job) => keyed(job.job)).sort())
    }
    assert.equal(published.session.duration_ms, Date.parse(value.session.derived_through) - Date.parse(value.session.started_at))
    assert.equal(published.intervals.length, value.intervals.length, "in-span intervals are all kept")
    assert.equal(published.refs.prs.length + dropped.prs, value.refs.prs.length + value.refs.unresolved.prs)
    assert.equal(published.refs.commits.length + dropped.commits, value.refs.commits.length + value.refs.unresolved.commits)
    assert.deepEqual(published.refs.private, dropped)
  }
  assert.ok(seen.refused > 10 && seen.published > 150 && seen.publicDesk > 50, JSON.stringify(seen))
})
