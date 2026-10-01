// Controller segments: a controller (worker 0) that works several jobs in one
// session has its time and its pull requests split across those jobs instead
// of copied into each. Covers the binder (`controllerSegments`, `bindSession`
// with `session`), timed PR refs (`dedupePrRefs`), both schemas, publishing,
// the pipeline (`timeline.js` clipping, `worker_shared`, PR crediting) and one
// derive -> bind -> publish -> build run. Every input is invented.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const FACTORY = "../../../../../plugins/desk/mcp/src/factory/"
const { bindSession, controllerSegments, jobId } = await import(`${FACTORY}binding.js`)
const { applyLimits, dedupePrRefs } = await import(`${FACTORY}derive-common.js`)
const { deriveClaudeSession } = await import(`${FACTORY}derive-claude.js`)
const { LIMITS, validateLocalFacts } = await import(`${FACTORY}schema.js`)
const { validatePublished, validatePublishedBytes } = await import(`${FACTORY}published-schema.js`)
const { serializePublished, toPublished } = await import(`${FACTORY}publish.js`)
const { build } = await import(`${FACTORY}pipeline/build.js`)
const { buildJobTimeline } = await import(`${FACTORY}pipeline/timeline.js`)
const { calculateFormulas, sharedSessions } = await import(`${FACTORY}pipeline/formulas.js`)

const here = path.dirname(fileURLToPath(import.meta.url))
const REMOTE = "https://github.com/o/desk"
const T0 = Date.UTC(2026, 8, 25, 8, 0, 0)
const iso = (seconds) => new Date(T0 + seconds * 1000).toISOString()
const SESSION = { started_at: iso(0), derived_through: iso(100) }
const AGENTS = [{ n: 0, parent: null, model: "m" }, { n: 1, parent: 0, model: "m" }, { n: 2, parent: 1, model: "m" }]
const CARD = { status: "processing", created_at: iso(-3600), updated_at: iso(0) }
const id = (slug) => jobId({ deskRemote: REMOTE, personPrefix: "", track: "t", slug })
const A = id("a")
const B = id("b")
const C = id("c")

const deskCall = (seconds, slug, agent = 0) => ({ at: seconds === null ? null : iso(seconds), name: "mcp__plugin_desk_desk__task_update", track: "t", slug, person: null, status: null, ok: true, agent })

// `session` and `agents` may be passed as `undefined` to leave them out.
function bind(events, options = {}) {
  const { commits = [], native = {}, cards = null } = options
  const session = Object.hasOwn(options, "session") ? options.session : SESSION
  const agents = Object.hasOwn(options, "agents") ? options.agents : AGENTS
  return bindSession({
    events, agents, session, deskRoot: "/desk", deskRemote: REMOTE, personPrefix: "",
    readTask: (track, slug) => (cards === null || cards.includes(slug) ? CARD : null),
    deskCommitsBetween: () => commits,
    gitCommitTaskPaths: (sha) => native[sha] ?? { exists: false, taskPaths: [] },
    isCardHousekeeping: () => false,
    resolveJobIdentity: (track, slug) => ({ track, slug }),
  }).jobs
}

const segmentsOf = (jobs) => Object.fromEntries(jobs.map((job) => [job.job, Object.hasOwn(job, "segments") ? job.segments : "none"]))
const span = (start, end, shared = false) => (shared ? { start_ms: start, end_ms: end, shared: true } : { start_ms: start, end_ms: end })

// The pieces of every job, unshared plus shared, cover [0, duration) with no gap.
function assertPartition(jobs, durationMs) {
  const points = jobs.flatMap((job) => job.segments ?? [])
  const covered = new Set()
  for (const segment of points) for (let ms = segment.start_ms; ms < segment.end_ms; ms += 1000) covered.add(ms)
  for (let ms = 0; ms < durationMs; ms += 1000) assert.ok(covered.has(ms), `${ms} is covered`)
  for (const job of jobs) {
    job.segments?.forEach((segment, index) => {
      assert.ok(segment.start_ms < segment.end_ms)
      if (index > 0) assert.ok(segment.start_ms >= job.segments[index - 1].end_ms)
    })
  }
}

// --- Binding ------------------------------------------------------------------

test("three jobs worked in sequence split the controller's session at each job's first evidence", () => {
  const jobs = bind({ deskToolCalls: [deskCall(10, "a"), deskCall(20, "a"), deskCall(30, "b"), deskCall(60, "c")], fileWrites: [{ at: iso(45), path: "/desk/t/b/notes.md", agent: 0 }] })
  // Time before the first evidence is the first job's; the last runs to the session's end.
  assert.deepEqual(segmentsOf(jobs), { [A]: [span(0, 30000)], [B]: [span(30000, 60000)], [C]: [span(60000, 100000)] })
  assertPartition(jobs, 100000)
})

test("a commit window that binds two tasks is a span both jobs hold, marked shared", () => {
  const jobs = bind({
    deskToolCalls: [deskCall(10, "a"), deskCall(70, "c")],
    shellGitCommits: [{ start: iso(40), end: iso(50), cwd: "/desk", agent: 0 }],
  }, { commits: [{ sha: "1".repeat(40), committed_at: iso(45), taskPaths: ["t/a/notes.md", "t/b/notes.md"] }] })
  // The window's evidence names a and b at one instant, so both hold the window and the stretch after it, until c.
  assert.deepEqual(segmentsOf(jobs), {
    [A]: [span(0, 40000), span(40000, 70000, true)],
    [B]: [span(40000, 70000, true)],
    [C]: [span(70000, 100000)],
  })
  assertPartition(jobs, 100000)
})

test("two Desk calls at one instant share the stretch after them, and a first group shares the time before it", () => {
  assert.deepEqual(segmentsOf(bind({ deskToolCalls: [deskCall(10, "a"), deskCall(40, "c"), deskCall(40, "b")] })), {
    [A]: [span(0, 40000)],
    [B]: [span(40000, 100000, true)],
    [C]: [span(40000, 100000, true)],
  })
  assert.deepEqual(segmentsOf(bind({ deskToolCalls: [deskCall(10, "c"), deskCall(10, "b"), deskCall(50, "a")] })), {
    [A]: [span(50000, 100000)],
    [B]: [span(0, 50000, true)],
    [C]: [span(0, 50000, true)],
  })
})

test("a zero-length commit window that binds two tasks shares the stretch after it", () => {
  const jobs = bind({
    deskToolCalls: [deskCall(10, "a"), deskCall(70, "a")],
    shellGitCommits: [{ start: iso(40), end: iso(40), cwd: "/desk", agent: 0 }],
  }, { commits: [{ sha: "1".repeat(40), committed_at: iso(40), taskPaths: ["t/b/notes.md", "t/c/notes.md"] }] })
  assert.deepEqual(segmentsOf(jobs), {
    [A]: [span(0, 40000), span(70000, 100000)],
    [B]: [span(40000, 70000, true)],
    [C]: [span(40000, 70000, true)],
  })
})

test("two jobs on one commit window take none of each other's surrounding time by name, and share the time after it", () => {
  // The review's hand scenario: a 10, b 20, a 35 (a file write), a window [45,55] whose commit binds b and c, c 70.
  const jobs = bind({
    deskToolCalls: [deskCall(10, "a"), deskCall(20, "b"), deskCall(70, "c")],
    fileWrites: [{ at: iso(35), path: "/desk/t/a/notes.md", agent: 0 }],
    shellGitCommits: [{ start: iso(45), end: iso(55), cwd: "/desk", agent: 0 }],
  }, { commits: [{ sha: "1".repeat(40), committed_at: iso(50), taskPaths: ["t/b/notes.md", "t/c/notes.md"] }] })
  assert.deepEqual(segmentsOf(jobs), {
    [A]: [span(0, 20000), span(35000, 45000)],
    [B]: [span(20000, 35000), span(45000, 70000, true)],
    [C]: [span(45000, 70000, true), span(70000, 100000)],
  })
  assertPartition(jobs, 100000)
})

test("a controller spawn for one of its jobs places the controller in that job for the spawn's span", () => {
  const jobs = bind({
    deskToolCalls: [deskCall(10, "a"), deskCall(20, "b")],
    spawnTasks: [
      { agent: 1, track: "t", slug: "a", start: iso(40), end: iso(60) },
      // A nested spawn (worker 2's parent is 1) and an untimed one place nothing.
      { agent: 2, track: "t", slug: "b", start: iso(70), end: iso(80) },
      { agent: 1, track: "t", slug: "b" },
    ],
  })
  assert.deepEqual(segmentsOf(jobs), { [A]: [span(0, 20000), span(40000, 100000)], [B]: [span(20000, 40000)] })
})

test("a controller spawn for a job the controller does not bind moves none of its time", () => {
  const jobs = bind({ deskToolCalls: [deskCall(10, "a"), deskCall(20, "b")], spawnTasks: [{ agent: 1, track: "t", slug: "c", start: iso(40), end: iso(60) }] })
  assert.deepEqual(segmentsOf(jobs), { [A]: [span(0, 20000)], [B]: [span(20000, 100000)], [C]: "none" })
  // A spawn whose child `agents` does not list binds nothing and places nothing.
  const unlisted = bind({ deskToolCalls: [deskCall(10, "a"), deskCall(20, "b")], spawnTasks: [{ agent: 7, track: "t", slug: "a", start: iso(40), end: iso(60) }] })
  assert.deepEqual(segmentsOf(unlisted), { [A]: [span(0, 20000)], [B]: [span(20000, 100000)] })
})

test("a controller bound to one job gets no segments, exactly as before", () => {
  const events = { deskToolCalls: [deskCall(10, "a"), deskCall(20, "a"), deskCall(30, "b", 1)] }
  const jobs = bind(events)
  assert.deepEqual(segmentsOf(jobs), { [A]: "none", [B]: "none" })
  assert.deepEqual(jobs, bind(events, { session: undefined }))
})

test("no segments without the session's times, without agents, or with a session that ends before it starts", () => {
  const events = { deskToolCalls: [deskCall(10, "a"), deskCall(30, "b")] }
  for (const options of [{ session: undefined }, { session: { started_at: iso(0) } }, { session: { started_at: "bad", derived_through: iso(9) } }, { session: { started_at: iso(50), derived_through: iso(10) } }, { agents: undefined }]) {
    assert.ok(bind(events, options).every((job) => !Object.hasOwn(job, "segments")), JSON.stringify(options))
  }
  // Worker 0 missing from `agents` binds nothing, so nothing is split.
  assert.deepEqual(bind(events, { agents: [{ n: 1, parent: null, model: "m" }] }), [])
})

test("a controller job with no timed evidence leaves the session unsplit", () => {
  // Job c is bound only through a native commit, which has no time.
  const native = { ["2".repeat(40)]: { exists: true, taskPaths: ["t/c/notes.md"] } }
  const jobs = bind({ deskToolCalls: [deskCall(10, "a"), deskCall(30, "b")], nativeCommitShas: [{ sha: "2".repeat(40), agent: 0 }] }, { native })
  assert.equal(jobs.length, 3)
  assert.ok(jobs.every((job) => !Object.hasOwn(job, "segments")))
  // Likewise a Desk call with no readable time.
  assert.ok(bind({ deskToolCalls: [deskCall(10, "a"), deskCall(null, "b")] }).every((job) => !Object.hasOwn(job, "segments")))
})

test("past LIMITS.jobSegments segments a job, the whole session falls back to no segments", () => {
  assert.equal(LIMITS.jobSegments, 200)
  const session = { started_at: iso(0), derived_through: iso(1000) }
  const alternating = (count) => ({ deskToolCalls: Array.from({ length: count }, (_, index) => deskCall(index, index % 2 === 0 ? "a" : "b")) })
  const atCap = bind(alternating(400), { session })
  assert.deepEqual(atCap.map((job) => job.segments.length), [200, 200])
  assert.equal(validateLocalFacts(localFacts({ jobs: atCap.map(({ segments, ...job }) => ({ ...job, segments: segments.map((s) => ({ ...s })) })), derivedThrough: iso(1000) })).ok, true)
  const over = bind(alternating(402), { session })
  assert.equal(over.length, 2)
  assert.ok(over.every((job) => !Object.hasOwn(job, "segments")))
})

test("hostile evidence: out of order, at one instant, before the start and past the end, all handled", () => {
  const jobs = bind({ deskToolCalls: [deskCall(30, "b"), deskCall(-10, "a"), deskCall(30, "a"), deskCall(30, "b")] })
  // a's evidence before the start counts from 0; a and b at one instant share what follows, never a zero-length segment.
  assert.deepEqual(segmentsOf(jobs), { [A]: [span(0, 30000), span(30000, 100000, true)], [B]: [span(30000, 100000, true)] })
  assertPartition(jobs, 100000)
  // c's only evidence is past the end: it clamps to the end, would hold no time at all, so the session is not split.
  const clamped = bind({ deskToolCalls: [deskCall(500, "c"), deskCall(30, "b"), deskCall(-10, "a")] })
  assert.equal(clamped.length, 3)
  assert.ok(clamped.every((entry) => !Object.hasOwn(entry, "segments")))
  // A window whose end precedes its start is an instant.
  assert.deepEqual(controllerSegments({ evidence: [{ key: "x", start: T0 + 5000, end: T0 }, { key: "y", start: T0 + 8000, end: T0 + 8000 }], keys: new Set(["x", "y"]), startedMs: T0, endMs: T0 + 10000 }),
    new Map([["x", [span(0, 8000)]], ["y", [span(8000, 10000)]]]))
  // A zero-length session is not split.
  assert.equal(controllerSegments({ evidence: [{ key: "x", start: T0, end: T0 }, { key: "y", start: T0, end: T0 }], keys: new Set(["x", "y"]), startedMs: T0, endMs: T0 }), null)
})

// --- Timed PR refs -----------------------------------------------------------

test("dedupePrRefs times each PR from the session's start, keeps the earliest of one worker's refs, and drops a time outside the session", () => {
  const session = { startedAt: iso(0), derivedThrough: iso(100) }
  const ref = (agent, created, seconds) => ({ repo: "o/r", number: 1, agent, created, ...(seconds === undefined ? {} : { at: iso(seconds) }) })
  assert.deepEqual(dedupePrRefs([ref(0, true, 40), ref(0, true, 20)], session), [{ repo: "o/r", number: 1, agent: 0, at_ms: 20000 }])
  assert.deepEqual(dedupePrRefs([ref(0, true, 20), ref(0, true, 40)], session), [{ repo: "o/r", number: 1, agent: 0, at_ms: 20000 }])
  assert.deepEqual(dedupePrRefs([ref(0, true), ref(0, true, 30)], session), [{ repo: "o/r", number: 1, agent: 0, at_ms: 30000 }])
  assert.deepEqual(dedupePrRefs([ref(0, true, 30), ref(0, true)], session), [{ repo: "o/r", number: 1, agent: 0, at_ms: 30000 }])
  // The creating worker still outranks an earlier sighting.
  assert.deepEqual(dedupePrRefs([ref(0, false, 5), ref(2, true, 50)], session), [{ repo: "o/r", number: 1, agent: 2, at_ms: 50000 }])
  // Before the start, past the end, unreadable, or no session: no time.
  for (const [refs, given] of [[[ref(0, true, -1)], session], [[ref(0, true, 101)], session], [[{ ...ref(0, true), at: "nope" }], session], [[ref(0, true, 10)], undefined], [[ref(0, true, 10)], { startedAt: iso(0) }]]) {
    assert.deepEqual(dedupePrRefs(refs, given), [{ repo: "o/r", number: 1, agent: 0 }])
  }
  // applyLimits keeps the time.
  assert.deepEqual(applyLimits({ agents: [{ n: 0, parent: null, model: "m" }], intervals: [], models: [], prs: [{ repo: "o/r", number: 1, agent: 0, at_ms: 5 }] }, []).prs, [{ repo: "o/r", number: 1, agent: 0, at_ms: 5 }])
})

// --- Schemas -----------------------------------------------------------------

function localFacts({ jobs, prs = [], derivedThrough = iso(100) } = {}) {
  const facts = JSON.parse(readFileSync(path.join(here, "fixtures", "local-golden.json"), "utf8"))
  facts.session = { ...facts.session, started_at: iso(0), ended_at: derivedThrough, derived_through: derivedThrough }
  facts.intervals = [{ kind: "turn", agent: 0, start: iso(1), end: iso(50) }]
  facts.refs.prs = prs
  facts.jobs = jobs ?? facts.jobs
  return facts
}

const job = (hex, extra = {}) => ({ job: hex.repeat(32), basis: ["desk_tool"], agents: [0], task_created_at: iso(-60), transitions: [], observed: null, ...extra })
const errorsOf = (result) => result.errors.map((error) => `${error.code}@${error.path}`)

test("local facts accept segments and PR times, and files without them stay valid", () => {
  assert.equal(validateLocalFacts(localFacts()).ok, true)
  const value = localFacts({ jobs: [job("a", { segments: [span(0, 40000), span(40000, 50000, true)] }), job("b", { segments: [span(40000, 50000, true)] })], prs: [{ repo: "o/r", number: 1, agent: 0, at_ms: 100000 }, { repo: "o/r", number: 2, at_ms: 0 }] })
  assert.deepEqual(validateLocalFacts(value), { ok: true, errors: [] })
})

for (const [name, segments, expected] of [
  ["a non-array", {}, ["type@jobs.0.segments"]],
  ["an empty list", [], ["empty@jobs.0.segments"]],
  ["too many", Array.from({ length: 201 }, (_, index) => span(index, index + 1)), ["too_many@jobs.0.segments"]],
  ["a non-integer", [{ start_ms: 0.5, end_ms: 9 }], ["integer@jobs.0.segments.0.start_ms"]],
  ["a negative start", [{ start_ms: -1, end_ms: 9 }], ["integer@jobs.0.segments.0.start_ms"]],
  ["an empty span", [span(9, 9)], ["order@jobs.0.segments.0.end_ms"]],
  ["overlapping spans", [span(0, 10), span(5, 20)], ["order@jobs.0.segments.1.start_ms"]],
  ["spans out of order", [span(20, 30), span(0, 10)], ["order@jobs.0.segments.1.start_ms"]],
  ["shared that is not true", [{ start_ms: 0, end_ms: 9, shared: false }], ["type@jobs.0.segments.0.shared"]],
  ["an unknown key", [{ start_ms: 0, end_ms: 9, job: 1 }], ["unknown_key@jobs.0.segments.0"]],
  ["a missing end", [{ start_ms: 0 }, span(0, 9)], ["missing@jobs.0.segments.0.end_ms"]],
  ["a span past the session's end", [span(0, 100001)], ["range@jobs.0.segments.0.end_ms"]],
]) {
  test(`local facts refuse job segments with ${name}`, () => {
    assert.deepEqual(errorsOf(validateLocalFacts(localFacts({ jobs: [job("a", { segments })] }))), expected)
  })
}

test("local facts refuse a PR time that is negative or past the session's end, and skip the bound when the session's times are unsound", () => {
  assert.deepEqual(errorsOf(validateLocalFacts(localFacts({ prs: [{ repo: "o/r", number: 1, at_ms: -1 }] }))), ["integer@refs.prs.0.at_ms"])
  assert.deepEqual(errorsOf(validateLocalFacts(localFacts({ prs: [{ repo: "o/r", number: 1, at_ms: 100001 }] }))), ["range@refs.prs.0.at_ms"])
  const backwards = localFacts({ jobs: [job("a", { segments: [span(0, 9)] })] })
  backwards.session.derived_through = iso(-1)
  backwards.session.ended_at = iso(-1)
  assert.deepEqual(errorsOf(validateLocalFacts(backwards)), ["order@session.ended_at", "order@session.derived_through"])
  const unreadable = localFacts({ jobs: [job("a", { segments: [span(0, 999999999)] })] })
  unreadable.session.started_at = "bad"
  assert.deepEqual(errorsOf(validateLocalFacts(unreadable)), ["pattern@session.started_at"])
})

function publishedSession(jobs, prs = []) {
  return {
    schema: "desk.factory.published/1",
    session: { host: "claude-code", id: "55555555-5555-4555-8555-555555555555", host_version: "2.1.0", entrypoint: "cli", duration_ms: 100000, ended: true, end_reason: "complete" },
    plugins: [],
    models: [],
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    intervals: [
      { kind: "turn", agent: 0, start_ms: 0, end_ms: 20000 },
      { kind: "turn", agent: 0, start_ms: 25000, end_ms: 70000 },
      { kind: "turn", agent: 0, start_ms: 80000, end_ms: 100000 },
    ],
    counts: { tool_calls: {}, tool_failures: {}, tool_retries: 0, api_retries: 0, compactions: 0 },
    refs: { prs, commits: [], private: { prs: 0, commits: 0 } },
    jobs: jobs.map(([hex, agents, segments]) => ({
      job: hex.repeat(32), basis: ["desk_tool"], session_offset_ms: 0, transitions: [], observed: null, agents,
      ...(segments === undefined ? {} : { segments }),
    })),
    unavailable: [],
  }
}

const THREE = [["a", [0], [span(0, 30000)]], ["b", [0], [span(30000, 60000)]], ["c", [0], [span(60000, 100000)]]]

test("published facts accept segments and PR times, refuse them past the session's end, and refuse segments on a public desk", () => {
  assert.deepEqual(validatePublished(publishedSession(THREE, [{ repo: "o/r", number: 1, agent: 0, at_ms: 30000 }])), { ok: true, errors: [] })
  assert.deepEqual(errorsOf(validatePublished(publishedSession([["a", [0], [span(0, 100001)]]], [{ repo: "o/r", number: 1, at_ms: 100001 }]))), ["range@jobs.0.segments.0.end_ms", "range@refs.prs.0.at_ms"])
  assert.deepEqual(errorsOf(validatePublished(publishedSession([["a", [0], [span(5, 1)]]]))), ["order@jobs.0.segments.0.end_ms"])
  const badDuration = publishedSession([["a", [0], [span(0, 100001)]]])
  badDuration.session.duration_ms = -1
  badDuration.intervals = []
  assert.deepEqual(errorsOf(validatePublished(badDuration)), ["integer@session.duration_ms"])
  const deskPublic = publishedSession([["a", [0], [span(0, 100000)]]])
  deskPublic.jobs[0].session_offset_ms = null
  deskPublic.unavailable = [{ field: "job_offsets", reason: "desk_public" }]
  assert.deepEqual(errorsOf(validatePublished(deskPublic)), ["inconsistent@jobs.0"])
  delete deskPublic.jobs[0].segments
  assert.equal(validatePublished(deskPublic).ok, true)
  // A public desk carries no PR time either.
  deskPublic.refs.prs = [{ repo: "o/r", number: 1, agent: 0 }, { repo: "o/r", number: 2, agent: 0, at_ms: 5 }]
  assert.deepEqual(errorsOf(validatePublished(deskPublic)), ["inconsistent@refs.prs.1"])
})

test("both validators refuse segments on a job whose agents is absent or lacks worker 0", () => {
  const legacy = job("a", { segments: [span(0, 9)] })
  delete legacy.agents
  assert.deepEqual(errorsOf(validateLocalFacts(localFacts({ jobs: [legacy] }))), ["inconsistent@jobs.0.segments"])
  assert.deepEqual(errorsOf(validateLocalFacts(localFacts({ jobs: [job("a", { agents: [1], segments: [span(0, 9)] })] }))), ["inconsistent@jobs.0.segments"])
  const published = publishedSession([["a", [1], [span(0, 9)]], ["b", [0], [span(0, 9)]]])
  delete published.jobs[1].agents
  assert.deepEqual(errorsOf(validatePublished(published)), ["inconsistent@jobs.0.segments", "inconsistent@jobs.1.segments"])
})

test("the pipeline ignores segments on a binding that lists no workers or not worker 0", () => {
  const session = publishedSession([["a", [0], [span(0, 10000)]], ["b", [1], [span(10000, 100000)]]], [{ repo: "o/r", number: 1, agent: 0, at_ms: 50000 }])
  delete session.jobs[0].agents
  // a is a legacy binding: all of worker 0's time and every PR; b's segments decide nothing.
  assert.equal(formulasOf("a", [session]).active_time_ms.value, 85000)
  assert.deepEqual(prNumbers("a", [session]), [1])
  assert.deepEqual(prNumbers("b", [session]), [])
})

// --- Publishing --------------------------------------------------------------

test("a private desk publishes segments and its controller PRs' times; a public desk publishes neither", () => {
  const local = localFacts({
    jobs: [job("a", { segments: [span(0, 40000), span(40000, 50000, true)] }), job("b", { segments: [span(40000, 50000, true), span(50000, 100000)] })],
    prs: [{ repo: "o/r", number: 1, agent: 0, at_ms: 45000 }, { repo: "o/r", number: 2, agent: 1, at_ms: 5000 }, { repo: "o/r", number: 3, agent: 0 }],
  })
  local.agents = [{ n: 0, parent: null, model: "m" }, { n: 1, parent: 0, model: "m" }]
  assert.equal(validateLocalFacts(local).ok, true)
  const { published } = toPublished(local, { visibility: () => "public", deskVisibility: "private", storeVisibility: "private" })
  assert.deepEqual(published.jobs.map((entry) => entry.segments), [local.jobs[0].segments, local.jobs[1].segments])
  assert.notEqual(published.jobs[0].segments[0], local.jobs[0].segments[0], "copied, not shared")
  // Only a controller PR keeps its time: no other worker's time decides a job.
  assert.deepEqual(published.refs.prs, [{ repo: "o/r", number: 1, agent: 0, at_ms: 45000 }, { repo: "o/r", number: 2, agent: 1 }, { repo: "o/r", number: 3, agent: 0 }])
  assert.equal(validatePublishedBytes(serializePublished(published)).ok, true)

  const open = toPublished(local, { visibility: () => "public", deskVisibility: "public", storeVisibility: "public", machineSecret: new Uint8Array(32).fill(7) }).published
  assert.ok(open.jobs.every((entry) => !Object.hasOwn(entry, "segments")))
  assert.ok(open.refs.prs.every((pr) => !Object.hasOwn(pr, "at_ms")))
  assert.equal(validatePublishedBytes(serializePublished(open)).ok, true)

  // A private session with no segments publishes no PR time either.
  const unsplit = localFacts({ jobs: [job("a")], prs: [{ repo: "o/r", number: 1, agent: 0, at_ms: 45000 }] })
  assert.deepEqual(toPublished(unsplit, { visibility: () => "public", deskVisibility: "private", storeVisibility: "private" }).published.refs.prs, [{ repo: "o/r", number: 1, agent: 0 }])
})

// --- Pipeline ----------------------------------------------------------------

const formulasOf = (hex, sessions) => calculateFormulas(buildJobTimeline(hex.repeat(32), sessions))
const prNumbers = (hex, sessions) => formulasOf(hex, sessions).references.value.public_pull_requests.map((pr) => pr.number)

test("three jobs in sequence: the controller's time is split, and the jobs' active times sum to the controller's", () => {
  const session = publishedSession(THREE)
  const [a, b, c] = ["a", "b", "c"].map((hex) => formulasOf(hex, [session]))
  // Worker 0 is active [0,20000) + [25000,70000) + [80000,100000) = 85000 ms.
  // a: [0,20000) + [25000,30000); b: [30000,60000); c: [60000,70000) + [80000,100000).
  assert.deepEqual([a, b, c].map((formulas) => formulas.active_time_ms), [25000, 30000, 30000].map((value) => ({ class: "measured", value })))
  assert.equal(a.active_time_ms.value + b.active_time_ms.value + c.active_time_ms.value, 85000)
  // The same session with no segments copies the controller's whole time into each job, marked worker_shared.
  const copied = formulasOf("a", [publishedSession(THREE.map(([hex, agents]) => [hex, agents]))])
  assert.deepEqual(copied.active_time_ms, { class: "measured", value: 85000, partial: true, uncovered_sessions: 1, partial_reasons: ["worker_shared"] })
})

test("other workers' time is not clipped by the controller's segments", () => {
  const session = publishedSession([["a", [0], [span(0, 30000)]], ["b", [0, 1], [span(30000, 100000)]]])
  session.intervals.push({ kind: "turn", agent: 1, start_ms: 5000, end_ms: 10000 })
  // b: worker 0 [30000,70000) + [80000,100000), worker 1 [5000,10000) whole.
  assert.equal(formulasOf("b", [session]).active_time_ms.value, 65000)
  assert.equal(formulasOf("a", [session]).active_time_ms.value, 25000)
})

test("an overlap span is shared: only the jobs holding it are worker_shared, and only because of it", () => {
  const overlap = [
    ["a", [0], [span(0, 40000), span(40000, 50000, true)]],
    ["b", [0], [span(40000, 50000, true), span(50000, 70000)]],
    ["c", [0], [span(70000, 100000)]],
  ]
  const session = publishedSession(overlap)
  const shared = { partial: true, uncovered_sessions: 1, partial_reasons: ["worker_shared"] }
  // a: [0,20000) + [25000,50000); b: [40000,70000); c: [80000,100000).
  assert.deepEqual(formulasOf("a", [session]).active_time_ms, { class: "measured", value: 45000, ...shared })
  assert.deepEqual(formulasOf("b", [session]).active_time_ms, { class: "measured", value: 30000, ...shared })
  assert.deepEqual(formulasOf("c", [session]).active_time_ms, { class: "measured", value: 20000 })
  // The jobs' times sum to the controller's 85000 plus the shared span counted twice (10000), which is flagged.
  assert.equal(45000 + 30000 + 20000, 85000 + 10000)
  // Without the shared span, nothing is worker_shared.
  const apart = publishedSession(THREE)
  for (const hex of ["a", "b", "c"]) assert.equal(sharedSessions(buildJobTimeline(hex.repeat(32), [apart])).size, 0)
  // Another worker shared with another job still counts as before.
  const worker = publishedSession([["a", [0, 1], [span(0, 50000)]], ["b", [0, 1], [span(50000, 100000)]]])
  assert.equal(sharedSessions(buildJobTimeline("a".repeat(32), [worker])).size, 1)
})

test("the controller's tool calls are split with its time, by the segment that holds each call's start", () => {
  const withTools = (jobs) => {
    const session = publishedSession(jobs)
    const tool = (start, outcome = "ok") => ({ kind: "tool", agent: 0, tool: "shell", outcome, start_ms: start, end_ms: start + 1000 })
    session.intervals.push(tool(5000), tool(15000, "error"), tool(29500), tool(45000), tool(65000, "error"), { kind: "subagent", agent: 0, start_ms: 66000, end_ms: 69000 })
    session.counts = { tool_calls: { shell: 5, agent: 1 }, tool_failures: { shell: 2 }, tool_retries: 1, api_retries: 0, compactions: 0 }
    return session
  }
  // Copied, the old way: every job reported the session's { agent: 1, shell: 5 }.
  const split = withTools(THREE)
  const counts = ["a", "b", "c"].map((hex) => formulasOf(hex, [split]))
  // A call crossing a boundary (29500-30500) counts where it starts.
  assert.deepEqual(counts.map((formulas) => formulas.tool_calls_by_kind.value), [{ shell: 3 }, { shell: 1 }, { agent: 1, shell: 1 }])
  assert.deepEqual(counts.map((formulas) => formulas.rework_signals.tool_failures.value), [1, 0, 1])
  assert.deepEqual(counts[0].tool_calls_by_kind.partial_reasons, ["worker_split"])
  // A call starting in a shared span counts for each job sharing it, and those jobs are also flagged worker_shared.
  const shared = withTools([["a", [0], [span(0, 40000), span(40000, 50000, true)]], ["b", [0], [span(40000, 50000, true), span(50000, 70000)]], ["c", [0], [span(70000, 100000)]]])
  const sharedCounts = ["a", "b", "c"].map((hex) => formulasOf(hex, [shared]))
  assert.deepEqual(sharedCounts.map((formulas) => formulas.tool_calls_by_kind.value), [{ shell: 4 }, { agent: 1, shell: 2 }, {}])
  assert.deepEqual(sharedCounts.map((formulas) => formulas.tool_calls_by_kind.partial_reasons), [["worker_split", "worker_shared"], ["worker_split", "worker_shared"], ["worker_split"]])
})

test("tool and API retries carry the same partial reasons: split, and shared when the job holds a shared span", () => {
  const segmented = publishedSession([["a", [0], [span(0, 40000), span(40000, 50000, true)]], ["b", [0], [span(40000, 50000, true), span(50000, 100000)]]])
  segmented.counts = { tool_calls: {}, tool_failures: {}, tool_retries: 1, api_retries: 3, compactions: 0 }
  const whole = publishedSession([["a", [0, 1]]])
  whole.session.id = "66666666-6666-4666-8666-666666666666"
  whole.counts = { tool_calls: {}, tool_failures: {}, tool_retries: 2, api_retries: 1, compactions: 0 }
  const signals = formulasOf("a", [segmented, whole]).rework_signals
  const reasons = ["worker_split", "worker_shared"]
  assert.deepEqual(signals.tool_retries, { class: "inferred", value: 2, partial: true, uncovered_sessions: 1, partial_reasons: reasons })
  assert.deepEqual(signals.api_retries, { class: "inferred", value: 1, partial: true, uncovered_sessions: 1, partial_reasons: reasons })
  // Every session split: nothing to report, for either.
  const alone = formulasOf("a", [segmented]).rework_signals
  assert.deepEqual([alone.tool_retries.class, alone.api_retries.class, alone.api_retries.reason], ["unavailable", "unavailable", "worker_split"])
})

test("each controller PR with a time lands in exactly one job; a boundary goes to the later job", () => {
  const prs = [
    { repo: "o/r", number: 1, agent: 0, at_ms: 10000 },
    { repo: "o/r", number: 2, agent: 0, at_ms: 30000 },
    { repo: "o/r", number: 3, agent: 0, at_ms: 59999 },
    { repo: "o/r", number: 4, agent: 0, at_ms: 100000 },
  ]
  const session = publishedSession(THREE, prs)
  assert.deepEqual(["a", "b", "c"].map((hex) => prNumbers(hex, [session])), [[1], [2, 3], [4]])
  // Every PR is accounted for, so no job's list is partial.
  for (const hex of ["a", "b", "c"]) assert.equal(Object.hasOwn(formulasOf(hex, [session]).references, "partial"), false)
})

test("a controller PR without a time, in a shared span, or in no segment follows the old rule", () => {
  const overlap = [["a", [0], [span(0, 40000), span(40000, 50000, true)]], ["b", [0, 1], [span(40000, 50000, true), span(50000, 100000)]]]
  const prs = [
    { repo: "o/r", number: 1, agent: 0 },
    { repo: "o/r", number: 2, agent: 0, at_ms: 45000 },
    { repo: "o/r", number: 3, agent: 1, at_ms: 5000 },
    { repo: "o/r", number: 4, agent: 0, at_ms: 20000 },
  ]
  const session = publishedSession(overlap, prs)
  // The old rule credits a PR of a shared worker to none; worker 1's PR goes to b, its only job.
  assert.deepEqual(prNumbers("a", [session]), [4])
  assert.deepEqual(prNumbers("b", [session]), [3])
  assert.deepEqual(formulasOf("a", [session]).references.partial_reasons, ["worker_shared"])
  // One job whose own span is marked shared (an inconsistent file) decides nothing either.
  const lone = publishedSession([["a", [0], [span(0, 100000, true)]], ["b", [0]]], [{ repo: "o/r", number: 5, agent: 0, at_ms: 10 }])
  assert.deepEqual(prNumbers("a", [lone]), [])
  // A time no segment holds decides nothing.
  const gap = publishedSession([["a", [0], [span(0, 10)]], ["b", [0], [span(10, 20)]]], [{ repo: "o/r", number: 6, agent: 0, at_ms: 50 }])
  assert.deepEqual(prNumbers("a", [gap]), [])
  // A legacy binding still keeps every reference.
  const legacy = publishedSession(THREE, [{ repo: "o/r", number: 7, agent: 0, at_ms: 10 }])
  delete legacy.jobs[1].agents
  delete legacy.jobs[1].segments
  assert.deepEqual(prNumbers("b", [legacy]), [7])
})

test("a published file from before segments builds with exactly the old numbers", () => {
  const before = publishedSession(THREE.map(([hex, agents]) => [hex, agents]), [{ repo: "o/r", number: 1, agent: 0 }])
  const after = structuredClone(before)
  after.jobs.forEach((entry, index) => { entry.segments = THREE[index][2] })
  // Same input, no segments: the old copy-and-withhold numbers.
  const old = formulasOf("a", [before])
  assert.equal(old.active_time_ms.value, 85000)
  assert.deepEqual(old.references.value.public_pull_requests, [])
  assert.equal(validatePublished(before).ok, true)
})

// --- Derive -> bind -> publish -> build ----------------------------------------

const SID = "7a3b4c5d-6e7f-4809-9a0b-1c2d3e4f5a6b"
const DT = "mcp__plugin_desk_desk__task_update"
const at = (minute) => new Date(T0 + minute * 60000).toISOString()

function writeSession(dir) {
  let mid = 0
  const line = (minute, extra) => ({ sessionId: SID, version: "2.1.282", cwd: "/tmp/work", timestamp: at(minute), ...extra })
  const assistant = (minute, content) => line(minute, { type: "assistant", message: { id: `m${mid++}`, model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 1 }, content } })
  const use = (useId, name, input) => ({ type: "tool_use", id: useId, name, input })
  const result = (minute, useId, extra = {}) => line(minute, { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: useId, content: "ok" }] }, ...extra })
  const prompt = (minute, text) => line(minute, { type: "user", message: { role: "user", content: text } })
  const created = (minute, useId, number) => [
    assistant(minute, [use(useId, "Bash", { command: "gh pr create" })]),
    result(minute + 1, useId, { toolUseResult: { stdout: "ok", gitOperation: { pr: { number, url: `https://github.com/o/r/pull/${number}`, action: "created" } } } }),
  ]
  const root = [
    prompt(0, "go"),
    assistant(1, [use("d1", DT, { track: "t", slug: "a", status: "processing" })]), result(2, "d1"),
    ...created(3, "p1", 20),
    assistant(5, [use("d2", DT, { track: "t", slug: "b", status: "processing" })]), result(6, "d2"),
    assistant(7, [use("s1", "Agent", { prompt: "Desk-Task: t/b\nbrief" })]), result(20, "s1"),
    assistant(21, [use("d3", DT, { track: "t", slug: "c", status: "processing" })]), result(22, "d3"),
    ...created(23, "p2", 21),
    assistant(25, [{ type: "text", text: "done" }]),
  ]
  const child = [prompt(7, "brief"), ...created(8, "c1", 22), assistant(15, [{ type: "text", text: "x" }])]
  const jsonl = (lines) => `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`
  writeFileSync(path.join(dir, `${SID}.jsonl`), jsonl(root))
  mkdirSync(path.join(dir, SID, "subagents"), { recursive: true })
  writeFileSync(path.join(dir, SID, "subagents", "agent-x.jsonl"), jsonl(child))
  writeFileSync(path.join(dir, SID, "subagents", "agent-x.meta.json"), JSON.stringify({ toolUseId: "s1" }))
}

test("a Claude controller working three jobs: derive, bind, publish and build split its time and PRs", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-segments-"))
  const store = mkdtempSync(path.join(os.tmpdir(), "desk-segments-store-"))
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "desk-segments-out-")), "built")
  try {
    writeSession(dir)
    const { facts, events } = await deriveClaudeSession({ transcriptPath: path.join(dir, `${SID}.jsonl`), plugins: [], endReason: "prompt_input_exit" })
    assert.deepEqual(facts.refs.prs, [{ repo: "o/r", number: 20, agent: 0, at_ms: 4 * 60000 }, { repo: "o/r", number: 21, agent: 0, at_ms: 24 * 60000 }, { repo: "o/r", number: 22, agent: 1, at_ms: 9 * 60000 }])
    facts.jobs = bindSession({
      events, agents: facts.agents, session: facts.session, deskRoot: "/desk", deskRemote: REMOTE, personPrefix: "",
      readTask: () => ({ status: "processing", created_at: at(-60), updated_at: at(0) }),
      deskCommitsBetween: () => [], gitCommitTaskPaths: () => ({ exists: false }), isCardHousekeeping: () => false,
      resolveJobIdentity: (track, slug) => ({ track, slug }),
    }).jobs
    // The spawn for b keeps the controller on b through its span.
    assert.deepEqual(segmentsOf(facts.jobs), { [A]: [span(0, 5 * 60000)], [B]: [span(5 * 60000, 21 * 60000)], [C]: [span(21 * 60000, 25 * 60000)] })
    assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })

    const { published } = toPublished(facts, { visibility: () => "public", deskVisibility: "private", storeVisibility: "private" })
    const bytes = serializePublished(published)
    assert.deepEqual(validatePublishedBytes(bytes), { ok: true, errors: [] })
    mkdirSync(path.join(store, "facts"))
    writeFileSync(path.join(store, "facts", `claude-code-${SID}.json`), bytes)
    build({ storeDir: store, outDir: out })
    const built = (hex) => JSON.parse(readFileSync(path.join(out, "jobs", `${hex}.json`), "utf8")).formulas

    // Worker 0 is active the whole 25 minutes; the child (in b only) adds nothing outside b's span.
    assert.deepEqual([A, B, C].map((hex) => built(hex).active_time_ms), [5, 16, 4].map((minutes) => ({ class: "measured", value: minutes * 60000 })))
    // Each PR is in exactly one job: the controller's by time, the child's by its worker.
    assert.deepEqual([A, B, C].map((hex) => built(hex).references.value.public_pull_requests.map((pr) => pr.number)), [[20], [22], [21]])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(store, { recursive: true, force: true })
    rmSync(path.dirname(out), { recursive: true, force: true })
  }
})
