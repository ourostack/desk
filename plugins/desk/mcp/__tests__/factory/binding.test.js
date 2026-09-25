// Binding: which Desk tasks (jobs) a session worked on. Every input here is
// invented; the task-card reader and the desk Git readers are fakes, so no
// real desk, transcript or repository is touched. `SENTINEL` sits in every
// track and slug to prove none of them reaches a job.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { bindSession, jobId, normalizeRemote } from "../../src/factory/binding.js"
import { DESK_MARKER } from "../../src/factory/shell-git.js"
import { LIMITS } from "../../src/factory/schema.js"
import { deriveClaudeSession } from "../../src/factory/derive-claude.js"

const SENTINEL = "SENTINEL-7f3a"
const DESK = "/work/desk"
const REMOTE = "git@github.com:Owner/Desk.git"
const NORMALIZED = "https://github.com/owner/desk"
const TRACK = `track-${SENTINEL}`
const SLUG = `slug-${SENTINEL}`
const OTHER = `other-${SENTINEL}`
const SHA_A = "a".repeat(40)
const SHA_B = "b".repeat(40)

const expectedId = (remote, prefix, track, slug) => createHash("sha256").update(`${remote}\n${prefix}\n${track}/${slug}`).digest("hex").slice(0, 32)

const CARD = { status: "processing", created_at: "2026-09-20T10:00:00.000Z", updated_at: "2026-09-25T09:00:00.000Z" }

function fakes({ cards = {}, commitsBetween = [], nativeCommits = {} } = {}) {
  const calls = { readTask: [], between: [], native: [] }
  return {
    calls,
    readTask(track, slug) {
      calls.readTask.push(`${track}/${slug}`)
      return Object.hasOwn(cards, `${track}/${slug}`) ? cards[`${track}/${slug}`] : CARD
    },
    deskCommitsBetween(start, end) {
      calls.between.push([start, end])
      // Everything, in or out of the span: binding itself matches each commit to a call.
      return commitsBetween
    },
    gitCommitTaskPaths(sha) {
      calls.native.push(sha)
      return nativeCommits[sha] ?? { exists: false, taskPaths: [] }
    },
  }
}

function bind(events, { deskRoot = DESK, deskRemote = REMOTE, personPrefix = "", ...options } = {}) {
  const deps = fakes(options)
  const result = bindSession({ events, deskRoot, deskRemote, personPrefix, ...deps })
  assert.equal(JSON.stringify(result).includes(SENTINEL), false, "no track, slug or path ever reaches a job")
  return { ...result, calls: deps.calls }
}

const deskCall = (overrides = {}) => ({
  at: "2026-09-25T08:10:00.000Z",
  name: "mcp__plugin_desk_desk__task_update",
  track: TRACK,
  slug: SLUG,
  person: null,
  status: null,
  ok: true,
  ...overrides,
})

// --- Job IDs -----------------------------------------------------------------

test("normalizeRemote: scp-style, credentials, case, .git and trailing slashes all normalize to one https form", () => {
  assert.equal(normalizeRemote("git@github.com:Owner/Repo.git"), "https://github.com/owner/repo")
  assert.equal(normalizeRemote("https://user:tok@github.com/owner/repo/"), "https://github.com/owner/repo")
  assert.equal(normalizeRemote("  HTTPS://GitHub.COM/Owner/Repo.git/  "), "https://github.com/owner/repo")
  assert.equal(normalizeRemote("ssh://git@github.com:22/Owner/Repo.git"), "https://github.com/owner/repo")
  assert.equal(normalizeRemote("git://github.com/o/r"), "https://github.com/o/r")
  assert.equal(normalizeRemote("http://tok@example.com/O/R"), "http://example.com/o/r")
  assert.equal(normalizeRemote("local:/Users/Some/Desk"), "local:/Users/Some/Desk")
  assert.equal(normalizeRemote("/srv/git/Desk.git/"), "/srv/git/Desk")
  assert.equal(normalizeRemote("https://Example.COM"), "https://example.com")
  assert.equal(normalizeRemote("git@GitHub.com:/Owner/Repo.git"), "https://github.com/owner/repo", "an scp path with a leading slash")
  assert.equal(normalizeRemote("C:\\Users\\Me\\Desk.git\\"), "C:\\Users\\Me\\Desk", "a Windows path is a path, not an scp host")
  assert.equal(normalizeRemote("D:/repos/Desk"), "D:/repos/Desk")
})

test("jobId is the first 32 hex of sha256(remote, person prefix, track/slug), with the remote normalized", () => {
  const id = jobId({ deskRemote: "git@github.com:Owner/Repo.git", personPrefix: "", track: "t", slug: "s" })
  assert.equal(id, expectedId("https://github.com/owner/repo", "", "t", "s"))
  assert.match(id, /^[0-9a-f]{32}$/u)
  assert.equal(jobId({ deskRemote: "https://user:tok@github.com/owner/repo/", personPrefix: "", track: "t", slug: "s" }), id)
  assert.notEqual(jobId({ deskRemote: "https://github.com/owner/repo", personPrefix: "desks/ari", track: "t", slug: "s" }), id)
})

test("jobId refuses a caller bug instead of hashing garbage", () => {
  const good = { deskRemote: NORMALIZED, personPrefix: "", track: "t", slug: "s" }
  for (const bad of [
    { deskRemote: 7 }, { deskRemote: "" }, { personPrefix: "desks" }, { personPrefix: "desks/a/b" }, { personPrefix: "desks/.." },
    { personPrefix: null }, { track: "" }, { track: "_meta" }, { slug: "a/b" }, { slug: ".." }, { track: 3 },
  ]) {
    assert.throws(() => jobId({ ...good, ...bad }), TypeError, JSON.stringify(bad))
  }
})

// --- Each basis alone binds --------------------------------------------------

test("a successful Desk task tool call alone binds its task, with its status as a transition", () => {
  const { jobs } = bind({ deskToolCalls: [deskCall({ status: "processing" })] })
  assert.deepEqual(jobs, [{
    job: expectedId(NORMALIZED, "", TRACK, SLUG),
    basis: ["desk_tool"],
    task_created_at: CARD.created_at,
    transitions: [{ to: "processing", at: "2026-09-25T08:10:00.000Z" }],
    observed: { status: "processing", at: null },
  }])
})

test("a successful file write alone binds the task folder it lands in", () => {
  const { jobs } = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/notes/plan.md` }] })
  assert.deepEqual(jobs.map(({ job, basis, transitions }) => ({ job, basis, transitions })), [
    { job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"], transitions: [] },
  ])
})

test("a desk commit matched to the session's own git commit call alone binds the tasks it changed", () => {
  const commit = { sha: SHA_A, committed_at: "2026-09-25T08:20:01.000Z", taskPaths: [`${TRACK}/${SLUG}/task.md`, "_meta/log.md"] }
  const { jobs, calls } = bind(
    { shellGitCommits: [{ start: "2026-09-25T08:20:01.400Z", end: "2026-09-25T08:20:02.100Z", cwd: DESK }] },
    { commitsBetween: [commit] },
  )
  assert.deepEqual(calls.between, [["2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.100Z"]], "the window starts at the call's second, since Git keeps whole seconds")
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_commit"] }])
})

test("desk history is read once per session over the span of its calls, and a commit binds only inside a call", () => {
  const at = (time, slug) => ({ sha: SHA_A, committed_at: time, taskPaths: [`${TRACK}/${slug}/task.md`] })
  const { jobs, calls } = bind({ shellGitCommits: [
    { start: "2026-09-25T08:45:00.000Z", end: "2026-09-25T08:45:01.000Z", cwd: DESK },
    { start: "2026-09-25T09:00:00.700Z", end: "2026-09-25T09:00:02.000Z", cwd: DESK },
    { start: "2026-09-25T08:00:00.200Z", end: "2026-09-25T08:00:01.000Z", cwd: DESK },
    { start: "2026-09-25T08:30:00.000Z", end: "2026-09-25T08:30:04.000Z", cwd: "/elsewhere" },
  ] }, { commitsBetween: [at("2026-09-25T08:00:00.000Z", SLUG), at("2026-09-25T08:30:02.000Z", OTHER), at("2026-09-25T09:00:02.000Z", `third-${SENTINEL}`), { sha: SHA_B, committed_at: "bad", taskPaths: [`${TRACK}/${SLUG}/x`] }, null] })
  assert.deepEqual(calls.between, [["2026-09-25T08:00:00.000Z", "2026-09-25T09:00:02.000Z"]])
  assert.deepEqual(jobs.map(({ job }) => job).sort(), [expectedId(NORMALIZED, "", TRACK, SLUG), expectedId(NORMALIZED, "", TRACK, `third-${SENTINEL}`)].sort())
})

test("a commit from the session's native refs alone binds the tasks it changed; one missing from the desk binds nothing", () => {
  const { jobs, calls } = bind(
    { nativeCommitShas: [SHA_A, SHA_B, "not-a-sha", SHA_A.toUpperCase(), 7] },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/_archive/${SLUG}/task.md`] }, [SHA_B]: { exists: false, taskPaths: [`${TRACK}/${OTHER}/x.md`] } } },
  )
  assert.deepEqual(calls.native, [SHA_A, SHA_B])
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_commit"] }])
})

test("hashes scraped from tool output (events.commitShas) never bind: only native refs and matched git commit calls do", () => {
  const { jobs, calls } = bind({ commitShas: [SHA_A] }, { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/task.md`] } } })
  assert.deepEqual(jobs, [])
  assert.deepEqual(calls.native, [])
})

// --- Where the git commit ran -----------------------------------------------

test("a git commit call binds only when it ran in the desk: inside it, below it or at $DESK, never elsewhere or unknown", () => {
  const commit = { sha: SHA_A, committed_at: "2026-09-25T08:20:01.000Z", taskPaths: [`${TRACK}/${SLUG}/task.md`] }
  const window = { start: "2026-09-25T08:20:00.000Z", end: "2026-09-25T08:20:05.000Z" }
  for (const cwd of [DESK, `${DESK}/${TRACK}`, DESK_MARKER, `${DESK_MARKER}/${TRACK}`]) {
    const { jobs } = bind({ shellGitCommits: [{ ...window, cwd }] }, { commitsBetween: [commit] })
    assert.equal(jobs.length, 1, cwd)
  }
  for (const cwd of ["/work/other", "/work/desk-sibling", "/work", null, 7, `${DESK_MARKER}x`]) {
    const { jobs, calls } = bind({ shellGitCommits: [{ ...window, cwd }] }, { commitsBetween: [commit] })
    assert.deepEqual(jobs, [], String(cwd))
    assert.deepEqual(calls.between, [], "Git is not even asked")
  }
})

test("a git commit call with an unreadable window binds nothing", () => {
  const commit = { sha: SHA_A, committed_at: "2026-09-25T08:20:01.000Z", taskPaths: [`${TRACK}/${SLUG}/task.md`] }
  for (const window of [{ start: "nope", end: "2026-09-25T08:20:05.000Z" }, { start: "2026-09-25T08:20:05.000Z", end: null }, { start: "2026-09-25T08:20:05.000Z", end: "2026-09-25T08:20:00.000Z" }]) {
    const { jobs } = bind({ shellGitCommits: [{ ...window, cwd: DESK }] }, { commitsBetween: [commit] })
    assert.deepEqual(jobs, [])
  }
})

test("the desk root is matched through a symlink, so a transcript that recorded the real path still binds", () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "desk-binding-link-"))
  try {
    const real = path.join(scratch, "real-desk")
    mkdirSync(real)
    const link = path.join(scratch, "linked-desk")
    symlinkSync(real, link)
    const write = { fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: path.join(realpathSync(real), TRACK, SLUG, "a.md") }] }
    assert.equal(bind(write, { deskRoot: link }).jobs.length, 1)
    assert.equal(bind(write, { deskRoot: realpathSync(real) }).jobs.length, 1, "a real desk root needs no second form")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// --- Paths -------------------------------------------------------------------

test("an _archive path maps to the same job as the live path", () => {
  const live = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/task.md` }] }).jobs
  const archived = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/_archive/${SLUG}/task.md` }] }).jobs
  assert.equal(live.length, 1)
  assert.equal(archived[0].job, live[0].job)
})

test("a person prefix changes the job ID and scopes which paths and Desk calls bind", () => {
  const prefixed = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/desks/ari/${TRACK}/${SLUG}/x.md` }] }, { personPrefix: "desks/ari" }).jobs
  assert.deepEqual(prefixed.map(({ job }) => job), [expectedId(NORMALIZED, "desks/ari", TRACK, SLUG)])
  assert.notEqual(prefixed[0].job, expectedId(NORMALIZED, "", TRACK, SLUG))
  // The same task folder outside the prefix, or another person's desk, binds nothing.
  assert.deepEqual(bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/x.md` }] }, { personPrefix: "desks/ari" }).jobs, [])
  assert.deepEqual(bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/desks/bo/${TRACK}/${SLUG}/x.md` }] }, { personPrefix: "desks/ari" }).jobs, [])
  // Without a prefix, person desks are not tracks.
  assert.deepEqual(bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/desks/ari/${TRACK}/${SLUG}/x.md` }] }).jobs, [])
  // The person comes only from the caller's prefix; a call's own person field is ignored.
  const prefixedCall = bind({ deskToolCalls: [deskCall({ person: "bo" })] }, { personPrefix: "desks/ari" }).jobs
  assert.deepEqual(prefixedCall.map(({ job }) => job), [expectedId(NORMALIZED, "desks/ari", TRACK, SLUG)])
  assert.deepEqual(bind({ deskToolCalls: [deskCall({ person: "ari" })] }).jobs.map(({ job }) => job), [expectedId(NORMALIZED, "", TRACK, SLUG)])
})

test("paths outside the desk, under _meta, _friction, _planning, the top-level _archive, dot folders, or not inside a task folder bind nothing", () => {
  const paths = [
    "/elsewhere/t/s/x.md",
    `${DESK}-other/${TRACK}/${SLUG}/x.md`,
    `${DESK}/_meta/factory.json`,
    `${DESK}/_friction/2026-09-25-x.md`,
    `${DESK}/${TRACK}/_planning/plan.md`,
    `${DESK}/_archive/${TRACK}/${SLUG}/task.md`,
    `${DESK}/_planning/${TRACK}/x.md`,
    `${DESK}/.git/${TRACK}/${SLUG}`,
    `${DESK}/${TRACK}/.cache/x`,
    `${DESK}/${TRACK}/track.md`,
    `${DESK}/${TRACK}/${SLUG}`,
    `${DESK}/${TRACK}/_archive/${SLUG}`,
    `${DESK}/${TRACK}/_archive/_x/task.md`,
    `${DESK}/AGENTS.md`,
    DESK,
    `${TRACK}/${SLUG}/relative.md`,
    "",
    null,
  ]
  const { jobs, calls } = bind({ fileWrites: paths.map((filePath) => ({ at: "2026-09-25T08:00:00.000Z", path: filePath })) })
  assert.deepEqual(jobs, [])
  assert.deepEqual(calls.readTask, [])
})

test("commit paths are read the same way, and a commit's changes outside task folders bind nothing", () => {
  const commit = { sha: SHA_A, committed_at: "2026-09-25T08:20:01.000Z", taskPaths: ["_meta/x", `${TRACK}/track.md`, "README.md", `_archive/${TRACK}/${SLUG}/task.md`, 7] }
  const { jobs } = bind({ shellGitCommits: [{ start: "2026-09-25T08:20:00.000Z", end: "2026-09-25T08:20:05.000Z", cwd: DESK }] }, { commitsBetween: [commit] })
  assert.deepEqual(jobs, [])
})

// --- What never binds ---------------------------------------------------------

test("end to end: a derived session that only reads the desk binds nothing", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "desk-binding-reads-"))
  try {
    const sessionId = "2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b"
    let second = 0
    const line = (extra) => ({ sessionId, version: "2.1.282", cwd: DESK, timestamp: `2026-09-25T08:00:${String(second++).padStart(2, "0")}.000Z`, ...extra })
    const use = (id, name, input) => line({ type: "assistant", message: { id: `m-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] } })
    const result = (id) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content: SENTINEL }] } })
    const lines = [
      line({ type: "user", message: { role: "user", content: `look ${SENTINEL}` } }),
      use("r1", "Read", { file_path: `${DESK}/${TRACK}/${SLUG}/task.md` }), result("r1"),
      use("r2", "Grep", { pattern: SENTINEL, path: `${DESK}/${TRACK}/${SLUG}` }), result("r2"),
      use("r3", "Bash", { command: `cat ${DESK}/${TRACK}/${SLUG}/task.md && git -C ${DESK} log -1` }), result("r3"),
      use("r4", "mcp__plugin_desk_desk__desk_status", {}), result("r4"),
    ]
    const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
    const { events } = await deriveClaudeSession({ transcriptPath, contributor: "0f3a9c1d2b4e6f70", plugins: [], endReason: null })
    const { jobs, calls } = bind(events)
    assert.deepEqual(jobs, [])
    assert.deepEqual(calls.readTask, [])
    assert.deepEqual(calls.between, [])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("a Read-only session binds nothing and reads no card", () => {
  for (const events of [{}, { deskToolCalls: [], fileWrites: [], shellGitCommits: [], nativeCommitShas: [] }, null]) {
    const { jobs, calls } = bind(events)
    assert.deepEqual(jobs, [])
    assert.deepEqual(calls.readTask, [])
  }
})

test("a failed Desk task tool call does not bind; unsafe track or slug names are ignored", () => {
  assert.deepEqual(bind({ deskToolCalls: [deskCall({ ok: false, status: "done" })] }).jobs, [])
  for (const bad of [{ track: "../x" }, { slug: "a/b" }, { slug: "_archive" }, { track: ".git" }, { track: 4 }, { slug: "" }, { track: "a\\b" }]) {
    assert.deepEqual(bind({ deskToolCalls: [deskCall(bad)] }).jobs, [], JSON.stringify(bad))
  }
})

test("a task with no card, live or archived, is not a job", () => {
  const { jobs } = bind({ deskToolCalls: [deskCall()] }, { cards: { [`${TRACK}/${SLUG}`]: null } })
  assert.deepEqual(jobs, [])
})

// --- Several tasks, transitions, observations --------------------------------

test("two tasks bound by one session both appear, each with its own bases, and bases merge per task", () => {
  const commit = { sha: SHA_A, committed_at: "2026-09-25T08:20:01.000Z", taskPaths: [`${TRACK}/${SLUG}/task.md`] }
  const { jobs, calls } = bind({
    deskToolCalls: [deskCall()],
    fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${OTHER}/x.md` }, { at: "2026-09-25T08:00:01.000Z", path: `${DESK}/${TRACK}/${SLUG}/y.md` }],
    shellGitCommits: [{ start: "2026-09-25T08:20:00.000Z", end: "2026-09-25T08:20:05.000Z", cwd: DESK }],
  }, { commitsBetween: [commit] })
  const byId = Object.fromEntries(jobs.map((job) => [job.job, job.basis]))
  assert.deepEqual(byId, {
    [expectedId(NORMALIZED, "", TRACK, SLUG)]: ["desk_tool", "file_write", "desk_commit"],
    [expectedId(NORMALIZED, "", TRACK, OTHER)]: ["file_write"],
  })
  assert.deepEqual(jobs.map(({ job }) => job), [...jobs.map(({ job }) => job)].sort(), "jobs are sorted by ID")
  assert.equal(calls.readTask.length, 2, "each card is read once")
})

test("transitions are the successful calls' valid statuses in time order; others are skipped", () => {
  const { jobs } = bind({ deskToolCalls: [
    deskCall({ at: "2026-09-25T08:30:00.000Z", status: "done" }),
    deskCall({ at: "2026-09-25T08:10:00.000Z", name: "mcp__plugin_desk_desk__task_create", status: "drafting" }),
    deskCall({ at: "2026-09-25T08:20:00.000Z", status: "processing" }),
    deskCall({ at: "2026-09-25T08:25:00.000Z", status: `not-a-status-${SENTINEL}` }),
    deskCall({ at: "2026-09-25T08:26:00.000Z", status: "validating", ok: false }),
    deskCall({ at: "not a time", status: "blocked" }),
  ] })
  assert.deepEqual(jobs[0].transitions, [
    { to: "drafting", at: "2026-09-25T08:10:00.000Z" },
    { to: "processing", at: "2026-09-25T08:20:00.000Z" },
    { to: "done", at: "2026-09-25T08:30:00.000Z" },
  ])
})

test("observed: a terminal card is observed at its updated time, a non-terminal one with no time, an unreadable one not at all", () => {
  const observed = (card) => bind({ deskToolCalls: [deskCall()] }, { cards: { [`${TRACK}/${SLUG}`]: card } }).jobs[0].observed
  assert.deepEqual(observed({ ...CARD, status: "done" }), { status: "done", at: CARD.updated_at })
  assert.deepEqual(observed({ ...CARD, status: "cancelled" }), { status: "cancelled", at: CARD.updated_at })
  assert.deepEqual(observed({ ...CARD, status: "done", updated_at: null }), { status: "done", at: null })
  assert.deepEqual(observed({ ...CARD, status: "blocked" }), { status: "blocked", at: null })
  assert.equal(observed({ ...CARD, status: null }), null)
  assert.equal(observed({ ...CARD, status: `weird-${SENTINEL}` }), null)
})

test("a card without a readable created time gives task_created_at: null", () => {
  const { jobs } = bind({ deskToolCalls: [deskCall()] }, { cards: { [`${TRACK}/${SLUG}`]: { ...CARD, created_at: null } } })
  assert.equal(jobs[0].task_created_at, null)
  const bad = bind({ deskToolCalls: [deskCall()] }, { cards: { [`${TRACK}/${SLUG}`]: { ...CARD, created_at: "2026-09-20" } } })
  assert.equal(bad.jobs[0].task_created_at, null)
})

// --- Remotes -------------------------------------------------------------------

test("remote normalization reaches the job: scp-style and credentialed https give one ID; no remote uses local: plus the desk root", () => {
  const events = { deskToolCalls: [deskCall()] }
  const scp = bind(events, { deskRemote: "git@github.com:Owner/Desk.git" }).jobs[0].job
  const https = bind(events, { deskRemote: "https://user:tok@github.com/owner/desk/" }).jobs[0].job
  assert.equal(scp, https)
  for (const deskRemote of [null, ""]) {
    assert.equal(bind(events, { deskRemote }).jobs[0].job, expectedId(`local:${DESK}`, "", TRACK, SLUG))
  }
  // Through a symlink or its real path, an unpublished desk has one job ID: the real path's.
  const scratch = mkdtempSync(path.join(os.tmpdir(), "desk-binding-local-"))
  try {
    const real = path.join(scratch, "real-desk")
    mkdirSync(real)
    const link = path.join(scratch, "linked-desk")
    symlinkSync(real, link)
    const viaLink = bind(events, { deskRemote: null, deskRoot: link }).jobs[0].job
    assert.equal(viaLink, bind(events, { deskRemote: null, deskRoot: real }).jobs[0].job)
    assert.equal(viaLink, expectedId(`local:${realpathSync(real)}`, "", TRACK, SLUG))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// --- Caps and caller bugs -------------------------------------------------------

test("jobs and transitions are capped at the facts limits", () => {
  const writes = Array.from({ length: LIMITS.jobs + 1 }, (_, index) => ({ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/task-${index}/x.md` }))
  assert.equal(bind({ fileWrites: writes }).jobs.length, LIMITS.jobs)
  const calls = Array.from({ length: LIMITS.jobTransitions + 1 }, () => deskCall({ status: "processing" }))
  assert.equal(bind({ deskToolCalls: calls }).jobs[0].transitions.length, LIMITS.jobTransitions)
})

test("caller bugs throw a TypeError: a relative desk root, a bad person prefix, a missing reader", () => {
  const deps = fakes()
  assert.throws(() => bindSession({ events: {}, deskRoot: "desk", deskRemote: REMOTE, personPrefix: "", ...deps }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "people/ari", ...deps }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, readTask: null }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, deskCommitsBetween: undefined }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, gitCommitTaskPaths: 1 }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: 5, personPrefix: "", ...deps }), TypeError)
})

// --- End to end with the Claude deriver: a failed write never binds ---------------

test("end to end: a failed Write under the desk binds nothing; the successful one does", async () => {
  const scratch = mkdtempSync(path.join(os.tmpdir(), "desk-binding-claude-"))
  try {
    const sessionId = "0d1e2f30-4152-4637-8899-aabbccddeeff"
    let second = 0
    const line = (extra) => ({ sessionId, version: "2.1.282", cwd: DESK, timestamp: `2026-09-25T08:00:${String(second++).padStart(2, "0")}.000Z`, ...extra })
    const write = (id, filePath) => line({ type: "assistant", message: { id: `m-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Write", input: { file_path: filePath, content: SENTINEL } }] } })
    const result = (id, isError) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] } })
    const lines = [
      line({ type: "user", message: { role: "user", content: `go ${SENTINEL}` } }),
      write("w1", `${DESK}/${TRACK}/${OTHER}/failed.md`),
      result("w1", true),
      write("w2", `${DESK}/${TRACK}/${SLUG}/ok.md`),
      result("w2", false),
    ]
    const transcriptPath = path.join(scratch, `${sessionId}.jsonl`)
    writeFileSync(transcriptPath, `${lines.map((entry) => JSON.stringify(entry)).join("\n")}\n`)
    const { events } = await deriveClaudeSession({ transcriptPath, contributor: "0f3a9c1d2b4e6f70", plugins: [], endReason: null })
    const { jobs } = bind(events)
    assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"] }])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})
