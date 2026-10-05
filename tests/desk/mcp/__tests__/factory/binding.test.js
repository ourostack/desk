// Binding: which Desk tasks (jobs) a session worked on. Every input here is
// invented; the task-card reader and the desk Git readers are fakes, so no
// real desk, transcript or repository is touched. `SENTINEL` sits in every
// track and slug to prove none of them reaches a job.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { bindSession, jobId, normalizeRemote } from "../../../../../plugins/desk/mcp/src/factory/binding.js"
import { DESK_MARKER } from "../../../../../plugins/desk/mcp/src/factory/shell-git.js"
import { LIMITS, validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { deriveClaudeSession } from "../../../../../plugins/desk/mcp/src/factory/derive-claude.js"

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

function fakes({ cards = {}, commitsBetween = [], nativeCommits = {}, housekeeping = {}, birthPaths = {}, repos = {}, unavailable = [] } = {}) {
  const calls = { readTask: [], between: [], native: [], housekeeping: [], resolveJobIdentity: [], repoLookup: [] }
  return {
    calls,
    readTask(track, slug) {
      calls.readTask.push(`${track}/${slug}`)
      return Object.hasOwn(cards, `${track}/${slug}`) ? cards[`${track}/${slug}`] : CARD
    },
    // Not a `bindSession` parameter any more. It is still handed over so a test can show desk history is never read by time.
    deskCommitsBetween(start, end) {
      calls.between.push([start, end])
      return commitsBetween
    },
    // `repos` maps a directory to the `owner/name` of the repository holding it and everything below it; `unavailable` lists directories
    // (and everything below them) whose evidence cannot be read; anything else is a true none.
    repoLookup(absPath) {
      calls.repoLookup.push(absPath)
      const root = Object.keys(repos).sort((a, b) => b.length - a.length).find((directory) => absPath === directory || absPath.startsWith(`${directory}/`))
      if (root !== undefined) return { repo: repos[root] }
      return unavailable.some((prefix) => absPath === prefix || absPath.startsWith(`${prefix}/`)) ? { unavailable: true } : { none: true }
    },
    gitCommitTaskPaths(sha) {
      calls.native.push(sha)
      return nativeCommits[sha] ?? { exists: false, taskPaths: [] }
    },
    // Keyed `${sha}:${path}`; defaults to false (a real, binding change) like
    // the real reader does on anything it cannot positively call housekeeping.
    isCardHousekeeping(sha, filePath) {
      calls.housekeeping.push([sha, filePath])
      return Boolean(housekeeping[`${sha}:${filePath}`])
    },
    // Defaults to the identity (current path is the birth path), like a task
    // that has never been renamed; `birthPaths` overrides by `track/slug`.
    resolveJobIdentity(track, slug) {
      calls.resolveJobIdentity.push(`${track}/${slug}`)
      return Object.hasOwn(birthPaths, `${track}/${slug}`) ? birthPaths[`${track}/${slug}`] : { track, slug }
    },
  }
}

// The golden facts' session: 90 minutes from 08:00. `minute(n)` is a time n minutes into it.
const T0 = Date.parse("2026-09-25T08:00:00.000Z")
const minute = (n) => new Date(T0 + n * 60000).toISOString()
const SESSION = { started_at: minute(0), derived_through: minute(90) }

function bind(events, { deskRoot = DESK, deskRemote = REMOTE, personPrefix = "", agents, session = SESSION, ...options } = {}) {
  const deps = fakes(options)
  const result = bindSession({ events, agents, session, deskRoot, deskRemote, personPrefix, ...deps })
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

const tree = (...parentsOf) => [{ n: 0, parent: null }, ...parentsOf.map((parent, index) => ({ n: index + 1, parent }))]
const writeAt = (n, slug, agent = 0) => ({ at: minute(n), path: `${DESK}/${TRACK}/${slug}/notes.md`, agent })
const focusAt = (n, slug, agent = 0) => (slug === null ? { agent, at: minute(n), clear: true } : { agent, at: minute(n), track: TRACK, slug })
const spawnAt = (agent, n, slug = null, parent = 0) => ({ agent, parent, at: n === null ? null : minute(n), task: slug === null ? null : { track: TRACK, slug } })
const span = (start, end) => ({ start_ms: start * 60000, end_ms: end * 60000 })
const X = SLUG
const Y = OTHER
const Z = `third-${SENTINEL}`
const shape = (jobs) => Object.fromEntries(jobs.map((job) => [job.job, { agents: job.agents, segments: job.segments ?? "none" }]))

// Every job set must pass the local validator: `checkSegments`, `checkSegmentAgents` and the session bounds.
function assertValid(jobs, agents = tree()) {
  const golden = JSON.parse(readFileSync(new URL("./fixtures/local-golden.json", import.meta.url), "utf8"))
  const facts = { ...golden, agents: agents.map((agent) => ({ ...agent, model: "claude-sonnet-5" })), intervals: golden.intervals.filter((interval) => interval.agent === 0), jobs }
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
}

const idOf = (slug) => expectedId(NORMALIZED, "", TRACK, slug)
const summary = (jobs) => jobs.map(({ job, basis, agents }) => ({ job, basis, agents }))
const SHA_C = "c".repeat(40)
// Three Desk calls ten minutes apart: enough events, over enough time, to make their task a candidate with an episode.
const threeCalls = (overrides = {}) => [10, 20, 30].map((n) => deskCall({ at: minute(n), ...overrides }))
// One write is enough when its task is the only one with events.
const oneWrite = (slug = SLUG) => ({ fileWrites: [{ at: minute(10), path: `${DESK}/${TRACK}/${slug}/notes.md` }] })
const native = (sha, agent = 0) => ({ sha, agent })

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

test("three Desk task tool calls bind their task, with each valid status as a transition; one alone binds nothing", () => {
  const { jobs, boundBy } = bind({ deskToolCalls: threeCalls({ status: "processing" }) })
  assert.deepEqual(jobs, [{
    job: expectedId(NORMALIZED, "", TRACK, SLUG),
    basis: ["desk_tool"],
    agents: [0],
    task_created_at: CARD.created_at,
    transitions: [10, 20, 30].map((n) => ({ to: "processing", at: minute(n) })),
    observed: { status: "processing", at: null },
    segments: [span(0, 90)],
  }])
  assert.deepEqual(boundBy, { [idOf(SLUG)]: "inferred" })
  assert.deepEqual(bind({ deskToolCalls: [deskCall({ status: "processing" })] }).jobs, [], "updating a card once is not working on it")
})

test("a successful file write alone binds the task folder it lands in", () => {
  const { jobs } = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/notes/plan.md` }] })
  assert.deepEqual(jobs.map(({ job, basis, transitions }) => ({ job, basis, transitions })), [
    { job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"], transitions: [] },
  ])
})

test("a git commit call that names a path under a task folder alone binds that task, without reading desk history", () => {
  const { jobs, calls } = bind({ shellGitCommits: [{ start: "2026-09-25T08:20:01.400Z", end: "2026-09-25T08:20:02.100Z", cwd: DESK, paths: [`${DESK}/${TRACK}/${SLUG}/notes.md`, `${DESK}/_meta/log.md`] }] })
  assert.deepEqual(calls.between, [], "a commit is the session's own by the paths it names, never by its time")
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_commit"] }])
})

test("a commit from the session's native refs alone binds the tasks it changed; one missing from the desk binds nothing", () => {
  const { jobs, calls } = bind(
    { nativeCommitShas: [SHA_A, SHA_B, "not-a-sha", SHA_A.toUpperCase(), 7, null, {}].map((entry) => (typeof entry === "string" ? { sha: entry, agent: 0 } : entry)) },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/_archive/${SLUG}/notes.md`] }, [SHA_B]: { exists: false, taskPaths: [`${TRACK}/${OTHER}/x.md`] } } },
  )
  assert.deepEqual(calls.native, [SHA_A, SHA_B])
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_commit"] }])
})

test("hashes scraped from tool output (events.commitShas) never bind: only native refs and matched git commit calls do", () => {
  const { jobs, calls } = bind({ commitShas: [SHA_A] }, { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/task.md`] } } })
  assert.deepEqual(jobs, [])
  assert.deepEqual(calls.native, [])
})

// --- The bare card: housekeeping never binds, real content always does -------
//
// task_update/task_create/task_archive stay a precise, deliberate signal
// (desk_tool, unaffected below). A commit whose only change inside a task's
// folder is the card itself, task.md, binds only when `isCardHousekeeping`
// says the card's own diff in that commit is real, not identity or
// placement. A file_write cannot be judged this way (the deriver hands the
// binder a path only, never content), so a bare-card file_write always
// binds, same as before this rule existed at all: that is how a
// hand-edited card (a checkbox, a progress note, task_update cannot do
// either) still counts as work.

test("a file write to the bare task card alone still binds, live or archived: file_write has no diff to judge", () => {
  const live = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/task.md` }] })
  assert.deepEqual(live.jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"] }])
  assert.deepEqual(live.calls.housekeeping, [], "file_write never consults the housekeeping reader")
  const archived = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/_archive/${SLUG}/task.md` }] })
  assert.deepEqual(archived.jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"] }])
})

test("a file write alongside the bare card still binds as one job with one file_write basis", () => {
  const { jobs } = bind({ fileWrites: [
    { at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/task.md` },
    { at: "2026-09-25T08:00:01.000Z", path: `${DESK}/${TRACK}/${SLUG}/notes.md` },
  ] })
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"] }])
})

test("a native commit touching only the bare card, live or archived, binds nothing when the card's diff is housekeeping", () => {
  const { jobs, calls } = bind(
    { nativeCommitShas: [native(SHA_A), native(SHA_B)] },
    {
      nativeCommits: {
        [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/task.md`] },
        [SHA_B]: { exists: true, taskPaths: [`${TRACK}/_archive/${OTHER}/task.md`] },
      },
      housekeeping: { [`${SHA_A}:${TRACK}/${SLUG}/task.md`]: true, [`${SHA_B}:${TRACK}/_archive/${OTHER}/task.md`]: true },
    },
  )
  assert.deepEqual(calls.native, [SHA_A, SHA_B])
  assert.deepEqual(calls.housekeeping.sort(), [[SHA_A, `${TRACK}/${SLUG}/task.md`], [SHA_B, `${TRACK}/_archive/${OTHER}/task.md`]].sort())
  assert.deepEqual(jobs, [])
})

test("a native commit touching only the bare card binds when the card's diff is real content, not housekeeping", () => {
  const { jobs } = bind(
    { nativeCommitShas: [{ sha: SHA_A, agent: 0 }] },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/task.md`] } } },
    // No housekeeping entry: the fake's default (false) is a real change, so it binds.
  )
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_commit"] }])
})

test("a native commit whose only change to one task is a housekeeping card edit binds nothing there, but still binds a task it actually changed", () => {
  const { jobs } = bind(
    { nativeCommitShas: [native(SHA_A)] },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/task.md`, `${TRACK}/${OTHER}/notes.md`] } }, housekeeping: { [`${SHA_A}:${TRACK}/${SLUG}/task.md`]: true } },
  )
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, OTHER), basis: ["desk_commit"] }])
})

// Finding 5: a card whose diff changes status or body must bind.
test("a native commit whose only change to one task is the card, and the card's diff changes status or body, binds that task", () => {
  const { jobs, calls } = bind(
    { nativeCommitShas: [native(SHA_A)] },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/task.md`] } } },
    // No housekeeping entry: the fake's default (false) stands in for a status or body change.
  )
  assert.deepEqual(calls.housekeeping, [[SHA_A, `${TRACK}/${SLUG}/task.md`]])
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_commit"] }])
})

test("a bulk commit that only touches card files across many tasks, live and archived, binds none of them when every card's diff is housekeeping", () => {
  const taskPaths = [`${TRACK}/${SLUG}/task.md`, `${TRACK}/${OTHER}/task.md`, `${TRACK}/_archive/${SLUG}/task.md`]
  const housekeeping = Object.fromEntries(taskPaths.map((taskPath) => [`${SHA_A}:${taskPath}`, true]))
  const { jobs } = bind({ nativeCommitShas: [native(SHA_A)] }, { nativeCommits: { [SHA_A]: { exists: true, taskPaths } }, housekeeping })
  assert.deepEqual(jobs, [])
})

test("one commit that changes the cards of two tasks is one event on each, which makes neither a candidate", () => {
  const taskPaths = [`${TRACK}/${SLUG}/task.md`, `${TRACK}/${OTHER}/task.md`]
  const { jobs, calls } = bind({ nativeCommitShas: [native(SHA_A)] }, { nativeCommits: { [SHA_A]: { exists: true, taskPaths } } })
  assert.equal(calls.housekeeping.length, 2, "both cards' diffs were judged real")
  assert.deepEqual(jobs, [])
  // The same holds for a git commit call that names both cards.
  assert.deepEqual(bind({ shellGitCommits: [{ start: minute(20), end: minute(21), cwd: DESK, paths: taskPaths.map((taskPath) => `${DESK}/${taskPath}`) }] }).jobs, [])
})

test("Desk task tool calls still bind on their own when the only other touch to the task is a housekeeping card commit", () => {
  const { jobs } = bind(
    { deskToolCalls: threeCalls({ status: "done" }), nativeCommitShas: [native(SHA_A)] },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/task.md`] } }, housekeeping: { [`${SHA_A}:${TRACK}/${SLUG}/task.md`]: true } },
  )
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_tool"] }])
})

// Finding 4: the card name is matched case-insensitively, on both sides.
test("the bare card is matched case-insensitively, so Task.MD is still judged by its diff, not bound outright", () => {
  const housekeepingRun = bind(
    { nativeCommitShas: [native(SHA_A)] },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/Task.MD`] } }, housekeeping: { [`${SHA_A}:${TRACK}/${SLUG}/Task.MD`]: true } },
  )
  // If the match were case-sensitive, "Task.MD" would not be seen as the card, the
  // housekeeping reader would never be asked, and it would bind outright instead.
  assert.deepEqual(housekeepingRun.calls.housekeeping, [[SHA_A, `${TRACK}/${SLUG}/Task.MD`]])
  assert.deepEqual(housekeepingRun.jobs, [])
})

// Finding 5: a nested task.md, inside a subfolder of the task, is not the
// bare card at all (only a card at the task's own root is) and always binds.
test("a task.md nested inside a subfolder is not the bare card and always binds", () => {
  const { jobs, calls } = bind({ nativeCommitShas: [native(SHA_A)] }, { nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/notes/task.md`] } } })
  assert.deepEqual(calls.housekeeping, [], "a nested task.md is a real file signal, never routed through the housekeeping check")
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["desk_commit"] }])
})

// Finding 5: Windows-separated paths.
test("a commit path spelled with Windows separators maps to the right task, and the bare card check still applies", () => {
  const taskPaths = [`${TRACK}\\${SLUG}\\task.md`, `${TRACK}\\${OTHER}\\notes.md`]
  const { jobs } = bind(
    { nativeCommitShas: [native(SHA_A)] },
    { nativeCommits: { [SHA_A]: { exists: true, taskPaths } }, housekeeping: { [`${SHA_A}:${TRACK}\\${SLUG}\\task.md`]: true } },
  )
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, OTHER), basis: ["desk_commit"] }])
})

// --- Where the git commit ran -----------------------------------------------

test("where a git commit call ran decides only the session's own activity; the paths it names decide what it binds", () => {
  const window = { start: "2026-09-25T08:20:00.000Z", end: "2026-09-25T08:20:05.000Z" }
  const named = [`${DESK}/${TRACK}/${SLUG}/notes.md`]
  for (const cwd of [DESK, `${DESK}/${TRACK}`, DESK_MARKER, `${DESK_MARKER}/${TRACK}`]) {
    const { jobs, ownActivity } = bind({ shellGitCommits: [{ ...window, cwd, paths: named }] })
    assert.equal(jobs.length, 1, cwd)
    assert.deepEqual(ownActivity, [[20 * 60000, 20 * 60000 + 5000]], cwd)
  }
  for (const cwd of ["/work/other", "/work/desk-sibling", "/work", null, 7, `${DESK_MARKER}x`]) {
    const { jobs, ownActivity, calls } = bind({ shellGitCommits: [{ ...window, cwd, paths: named }] })
    assert.equal(jobs.length, 1, `${cwd}: the named path is in the desk wherever the command ran`)
    assert.deepEqual(ownActivity, [], String(cwd))
    assert.deepEqual(calls.between, [], "Git is never asked")
  }
  // The `$DESK` form of a named path is the desk root's.
  assert.equal(bind({ shellGitCommits: [{ ...window, cwd: "/work", paths: [`${DESK_MARKER}/${TRACK}/${SLUG}/notes.md`] }] }).jobs.length, 1)
  assert.deepEqual(bind({ shellGitCommits: [{ ...window, cwd: DESK, paths: [DESK_MARKER, `${DESK_MARKER}/${TRACK}`] }] }).jobs, [])
})

test("a git commit call with an unreadable window binds nothing", () => {
  for (const window of [{ start: "nope", end: "2026-09-25T08:20:05.000Z" }, { start: "2026-09-25T08:20:05.000Z", end: null }, { start: "2026-09-25T08:20:05.000Z", end: "2026-09-25T08:20:00.000Z" }]) {
    const { jobs, ownActivity } = bind({ shellGitCommits: [{ ...window, cwd: DESK, paths: [`${DESK}/${TRACK}/${SLUG}/notes.md`] }, null] })
    assert.deepEqual(jobs, [])
    assert.deepEqual(ownActivity, [])
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
  const live = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/notes.md` }] }).jobs
  const archived = bind({ fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/_archive/${SLUG}/notes.md` }] }).jobs
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
  const prefixedCall = bind({ deskToolCalls: threeCalls({ person: "bo" }) }, { personPrefix: "desks/ari" }).jobs
  assert.deepEqual(prefixedCall.map(({ job }) => job), [expectedId(NORMALIZED, "desks/ari", TRACK, SLUG)])
  assert.deepEqual(bind({ deskToolCalls: threeCalls({ person: "ari" }) }).jobs.map(({ job }) => job), [expectedId(NORMALIZED, "", TRACK, SLUG)])
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
    `../${TRACK}/${SLUG}/escapes.md`,
    `_meta/${SLUG}/relative.md`,
    "",
    null,
  ]
  const { jobs, calls } = bind({ fileWrites: [...paths.map((filePath) => ({ at: "2026-09-25T08:00:00.000Z", path: filePath })), null] })
  assert.deepEqual(jobs, [])
  assert.deepEqual(calls.readTask, [])
})

test("a relative write path is a desk_save path and is taken from the desk root", () => {
  const { jobs } = bind({ fileWrites: [{ at: minute(10), path: `${TRACK}/${SLUG}/relative.md` }] })
  assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"] }])
  // A write with no readable time still counts; it owns no time of its own.
  assert.equal(bind({ fileWrites: [{ path: `${DESK}/${TRACK}/${SLUG}/x.md` }] }).jobs.length, 1)
})

test("commit paths are read the same way, and a commit's changes outside task folders bind nothing", () => {
  const taskPaths = ["_meta/x", `${TRACK}/track.md`, "README.md", `_archive/${TRACK}/${SLUG}/task.md`, 7]
  const { jobs } = bind({ nativeCommitShas: [native(SHA_A)] }, { nativeCommits: { [SHA_A]: { exists: true, taskPaths } } })
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
    const { events } = await deriveClaudeSession({ transcriptPath, plugins: [], endReason: null })
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
  assert.deepEqual(bind({ deskToolCalls: threeCalls({ ok: false, status: "done" }) }).jobs, [])
  for (const bad of [{ track: "../x" }, { slug: "a/b" }, { slug: "_archive" }, { track: ".git" }, { track: 4 }, { slug: "" }, { track: "a\\b" }]) {
    assert.deepEqual(bind({ deskToolCalls: threeCalls(bad) }).jobs, [], JSON.stringify(bad))
  }
})

test("a task with no card, live or archived, is not a job", () => {
  const { jobs } = bind({ deskToolCalls: threeCalls(), ...oneWrite() }, { cards: { [`${TRACK}/${SLUG}`]: null } })
  assert.deepEqual(jobs, [])
  // Its events are dropped, so they never keep another task from being the only one with events.
  const beside = bind({ deskToolCalls: threeCalls(), ...oneWrite(OTHER) }, { cards: { [`${TRACK}/${SLUG}`]: null } })
  assert.deepEqual(beside.jobs.map(({ job }) => job), [idOf(OTHER)])
})

// --- Several tasks, transitions, observations --------------------------------

test("two tasks worked in one session both appear, each with its own bases, and bases merge per task", () => {
  const { jobs, calls } = bind({
    // SLUG: a call, a write and a named commit over twenty minutes. OTHER: three writes later on.
    deskToolCalls: [deskCall()],
    fileWrites: [{ at: minute(1), path: `${DESK}/${TRACK}/${SLUG}/y.md` }, ...[50, 60, 70].map((n) => ({ at: minute(n), path: `${DESK}/${TRACK}/${OTHER}/x.md` }))],
    shellGitCommits: [{ start: minute(20), end: minute(21), cwd: DESK, paths: [`${DESK}/${TRACK}/${SLUG}`] }],
  })
  const byId = Object.fromEntries(jobs.map((job) => [job.job, { basis: job.basis, segments: job.segments }]))
  assert.deepEqual(byId, {
    // Equal counts: SLUG is the main task by its earlier first event, and takes the time no episode covers.
    [expectedId(NORMALIZED, "", TRACK, SLUG)]: { basis: ["desk_tool", "file_write", "desk_commit"], segments: [span(0, 50), span(70, 90)] },
    [expectedId(NORMALIZED, "", TRACK, OTHER)]: { basis: ["file_write"], segments: [span(50, 70)] },
  })
  assert.deepEqual(jobs.map(({ job }) => job), [...jobs.map(({ job }) => job)].sort(), "jobs are sorted by ID")
  assert.equal(calls.readTask.length, 2, "each card is read once")
  assertValid(jobs)
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
  const observed = (card) => bind(oneWrite(), { cards: { [`${TRACK}/${SLUG}`]: card } }).jobs[0].observed
  assert.deepEqual(observed({ ...CARD, status: "done" }), { status: "done", at: CARD.updated_at })
  assert.deepEqual(observed({ ...CARD, status: "cancelled" }), { status: "cancelled", at: CARD.updated_at })
  assert.deepEqual(observed({ ...CARD, status: "done", updated_at: null }), { status: "done", at: null })
  assert.deepEqual(observed({ ...CARD, status: "blocked" }), { status: "blocked", at: null })
  assert.equal(observed({ ...CARD, status: null }), null)
  assert.equal(observed({ ...CARD, status: `weird-${SENTINEL}` }), null)
})

test("a card without a readable created time gives task_created_at: null", () => {
  const { jobs } = bind(oneWrite(), { cards: { [`${TRACK}/${SLUG}`]: { ...CARD, created_at: null } } })
  assert.equal(jobs[0].task_created_at, null)
  const bad = bind(oneWrite(), { cards: { [`${TRACK}/${SLUG}`]: { ...CARD, created_at: "2026-09-20" } } })
  assert.equal(bad.jobs[0].task_created_at, null)
})

// --- Remotes -------------------------------------------------------------------

test("remote normalization reaches the job: scp-style and credentialed https give one ID; no remote uses local: plus the desk root", () => {
  // A desk-relative write, so the same events bind under any desk root.
  const events = { fileWrites: [{ at: minute(10), path: `${TRACK}/${SLUG}/notes.md` }] }
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

// --- Birth path resolution ----------------------------------------------------

test("a job's ID hashes the birth path resolveJobIdentity returns for the touched task, not the touched path itself", () => {
  const birthTrack = `birth-${SENTINEL}`
  const birthSlug = `birth-slug-${SENTINEL}`
  const { jobs, calls } = bind(
    { fileWrites: [{ at: "2026-09-25T08:00:00.000Z", path: `${DESK}/${TRACK}/${SLUG}/notes.md` }] },
    { birthPaths: { [`${TRACK}/${SLUG}`]: { track: birthTrack, slug: birthSlug } } },
  )
  assert.deepEqual(jobs.map(({ job }) => job), [expectedId(NORMALIZED, "", birthTrack, birthSlug)])
  assert.notEqual(jobs[0].job, expectedId(NORMALIZED, "", TRACK, SLUG), "not the touched path's own ID")
  assert.deepEqual(calls.resolveJobIdentity, [`${TRACK}/${SLUG}`], "resolved once, from the touched (current) track/slug")
  assert.deepEqual(calls.readTask, [`${TRACK}/${SLUG}`], "the card is still read at the touched path, not the birth path")
})

// --- Caps and caller bugs -------------------------------------------------------

test("jobs and transitions are capped at the facts limits", () => {
  // One second of declared focus on each of LIMITS.jobs + 1 tasks.
  const focusCalls = Array.from({ length: LIMITS.jobs + 1 }, (_, index) => ({ agent: 0, at: new Date(T0 + index * 1000).toISOString(), track: TRACK, slug: `task-${index}` }))
  assert.equal(bind({ focusCalls }).jobs.length, LIMITS.jobs)
  const calls = Array.from({ length: LIMITS.jobTransitions + 1 }, () => deskCall({ status: "processing" }))
  assert.equal(bind({ deskToolCalls: calls }).jobs[0].transitions.length, LIMITS.jobTransitions)
})

test("caller bugs throw a TypeError: a relative desk root, a bad person prefix, a missing reader", () => {
  const deps = fakes()
  assert.throws(() => bindSession({ events: {}, deskRoot: "desk", deskRemote: REMOTE, personPrefix: "", ...deps }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "people/ari", ...deps }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, readTask: null }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, repoLookup: undefined }), TypeError)
  assert.doesNotThrow(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, deskCommitsBetween: undefined }), "desk history is no longer a reader the binder needs")
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, gitCommitTaskPaths: 1 }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, isCardHousekeeping: undefined }), TypeError)
  assert.throws(() => bindSession({ events: {}, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...deps, resolveJobIdentity: null }), TypeError)
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
    const { events } = await deriveClaudeSession({ transcriptPath, plugins: [], endReason: null })
    const { jobs } = bind(events)
    assert.deepEqual(jobs.map(({ job, basis }) => ({ job, basis })), [{ job: expectedId(NORMALIZED, "", TRACK, SLUG), basis: ["file_write"] }])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

// --- Per-worker binding -------------------------------------------------------


test("a commit touching cards in 21 tasks binds none of them", () => {
  const taskPaths = Array.from({ length: 21 }, (_, i) => `${TRACK}/task-${i}-${SENTINEL}/task.md`)
  const { jobs } = bind({ shellGitCommits: [{ start: minute(20), end: minute(21), cwd: DESK, paths: taskPaths.map((taskPath) => `${DESK}/${taskPath}`) }] })
  assert.deepEqual(jobs, [])
  const fromRefs = bind({ nativeCommitShas: [native(SHA_A)] }, { nativeCommits: { [SHA_A]: { exists: true, taskPaths } } })
  assert.deepEqual(fromRefs.jobs, [])
})

test("a commit naming 3 tasks counts for each of them; one naming 4 is a sweep and counts for none", () => {
  const commits = (names) => [10, 20, 30].map((n) => ({ start: minute(n), end: minute(n + 1), cwd: DESK, paths: names.map((name) => `${DESK}/${TRACK}/${name}-${SENTINEL}/notes.md`) }))
  // Three commits give each of the three tasks three events: all are candidates, and the first in key order is the main task.
  const three = bind({ shellGitCommits: commits(["a", "b", "c", "a"]) })
  assert.deepEqual(three.jobs.map(({ job, basis }) => ({ job, basis })), [{ job: idOf(`a-${SENTINEL}`), basis: ["desk_commit"] }])
  assert.equal(three.calls.readTask.length, 3)
  assert.deepEqual(bind({ shellGitCommits: commits(["a", "b", "c", "d"]) }).jobs, [])
})

test("a commit whose housekeeping cards are filtered out to 3 or fewer tasks still counts for the rest", () => {
  const taskPaths = ["a", "b", "c", "d", "e"].map((name) => `${TRACK}/${name}-${SENTINEL}/task.md`)
  const shas = [SHA_A, SHA_B, SHA_C]
  const nativeCommits = Object.fromEntries(shas.map((sha) => [sha, { exists: true, taskPaths }]))
  const housekeeping = Object.fromEntries(shas.flatMap((sha) => taskPaths.slice(0, 2).map((p) => [`${sha}:${p}`, true])))
  // Three commits, each real on c, d and e only: c is the main task.
  const { jobs } = bind({ nativeCommitShas: shas.map((sha) => native(sha)) }, { nativeCommits, housekeeping })
  assert.deepEqual(jobs.map(({ job }) => job), [idOf(`c-${SENTINEL}`)])
  // With every card's change real, each commit spans five tasks and counts for none.
  assert.deepEqual(bind({ nativeCommitShas: shas.map((sha) => native(sha)) }, { nativeCommits }).jobs, [])
})

test("a subagent's own commits are the session tree's evidence, never a job of its own", () => {
  // Worker 1, spawned at minute 5 with no line, names SLUG in three commits. Worker 2 does nothing.
  const commits = [10, 20, 30].map((n) => ({ start: minute(n), end: minute(n + 1), cwd: DESK, paths: [`${DESK}/${TRACK}/${SLUG}/notes.md`, 7], agent: 1 }))
  const { jobs } = bind({ shellGitCommits: commits, spawns: [spawnAt(1, 5), spawnAt(2, 6)] }, { agents: tree(0, 0) })
  assert.deepEqual(summary(jobs), [{ job: idOf(SLUG), basis: ["desk_commit", "inherited"], agents: [0, 1, 2] }])
})

test("a subagent with a Desk-Task line binds that task only", () => {
  const { jobs } = bind({ focusCalls: [focusAt(1, SLUG)], spawns: [spawnAt(1, 10, OTHER)] }, { agents: tree(0) })
  assert.deepEqual(summary(jobs).sort((a, b) => a.agents[0] - b.agents[0]), [
    { job: idOf(SLUG), basis: ["desk_tool"], agents: [0] },
    { job: idOf(OTHER), basis: ["spawn_brief"], agents: [1] },
  ].sort((a, b) => a.agents[0] - b.agents[0]))
})

test("a Desk-Task line naming a task with no card binds nothing", () => {
  const { jobs } = bind({ spawns: [spawnAt(1, 10, OTHER), { agent: 1, parent: 0, at: minute(10), task: { track: "../x", slug: OTHER } }, null] }, { agents: tree(0), cards: { [`${TRACK}/${OTHER}`]: null } })
  assert.deepEqual(jobs, [])
})

test("subagents spawned while the controller works one job are in that job", () => {
  const { jobs } = bind({ deskToolCalls: threeCalls({ agent: 0 }), spawns: [spawnAt(1, 15), spawnAt(2, 40)] }, { agents: tree(0, 0) })
  assert.deepEqual(summary(jobs), [{ job: idOf(SLUG), basis: ["desk_tool", "inherited"], agents: [0, 1, 2] }])
})

test("a subagent under a controller that works several jobs is in the one job that held the controller when it was spawned", () => {
  const { jobs } = bind({ focusCalls: [focusAt(1, SLUG), focusAt(40, OTHER)], spawns: [spawnAt(1, 50)] }, { agents: tree(0) })
  assert.deepEqual(summary(jobs).sort((a, b) => a.agents.length - b.agents.length), [
    { job: idOf(SLUG), basis: ["desk_tool"], agents: [0] },
    { job: idOf(OTHER), basis: ["desk_tool", "inherited"], agents: [0, 1] },
  ])
})

test("a nested subagent follows its parent into the parent's job", () => {
  const { jobs } = bind({ deskToolCalls: threeCalls({ agent: 0 }), spawns: [spawnAt(1, 15), spawnAt(2, 16, null, 1)] }, { agents: tree(0, 1) })
  assert.deepEqual(summary(jobs), [{ job: idOf(SLUG), basis: ["desk_tool", "inherited"], agents: [0, 1, 2] }])
})

test("a subagent's own touches never give it a job: it and its children stay in the job it was spawned for", () => {
  // Worker 1 is spawned under SLUG and then writes five times into OTHER's folder; worker 2 is its child.
  const writes = [20, 25, 30, 35, 40].map((n) => writeAt(n, OTHER, 1))
  const { jobs } = bind({ focusCalls: [focusAt(1, SLUG)], spawns: [spawnAt(1, 10), spawnAt(2, 22, null, 1)], fileWrites: writes, deskToolCalls: [deskCall({ agent: 1, slug: OTHER })] }, { agents: tree(0, 1) })
  assert.deepEqual(summary(jobs), [{ job: idOf(SLUG), basis: ["desk_tool", "inherited"], agents: [0, 1, 2] }])
})

test("a worker whose ancestry cannot be traced to the controller stays unattributed, without looping", () => {
  const cyclic = [{ n: 0 }, { n: 1, parent: 2 }, { n: 2, parent: 1 }, { n: 3 }, { n: 4, parent: 9 }, { n: 5, parent: 5 }, { n: "x", parent: 0 }, null]
  const spawns = [1, 2, 3, 4, 5].map((agent) => spawnAt(agent, 20))
  const { jobs } = bind({ focusCalls: [focusAt(1, SLUG)], spawns }, { agents: cyclic })
  assert.deepEqual(summary(jobs), [{ job: idOf(SLUG), basis: ["desk_tool"], agents: [0] }])
})

test("a worker missing from agents binds nothing and nothing inherits from it", () => {
  const { jobs } = bind({
    deskToolCalls: [...threeCalls({ agent: 4 }), ...threeCalls({ agent: -1, slug: OTHER }), ...threeCalls({ agent: 1.5, slug: OTHER })],
    fileWrites: [{ path: `${DESK}/${TRACK}/${OTHER}/x.md`, agent: 4 }],
    spawns: [spawnAt(4, 10, OTHER), spawnAt(1, 10, null, 4), spawnAt(5, 10, null, 4)],
    focusCalls: [focusAt(1, SLUG)],
  }, { agents: [{ n: 1, parent: 4 }, { n: 5, parent: 4 }] })
  assert.deepEqual(jobs, [], "workers 4, and 0 (the fallback for a bad id), are not listed")
  // With worker 0 listed, an unlisted worker's events still count for nothing, and its line binds nothing.
  const listedOnly = bind({ deskToolCalls: threeCalls({ agent: 4 }), fileWrites: [writeAt(10, OTHER, 4)], spawns: [spawnAt(4, 10, OTHER)], prRefs: [{ agent: 4, at: minute(10), repo: "o/r", created: true }] }, { agents: tree(0) })
  assert.deepEqual(listedOnly.jobs, [])
  assert.deepEqual(listedOnly.calls.readTask, [], "an unlisted worker's cards are not read")
})

test("a bound session's jobs pass the local facts validator, agents included", () => {
  const agents = tree(0, 1)
  const { jobs } = bind(
    { deskToolCalls: [...threeCalls({ agent: 0 }), ...threeCalls({ agent: 7, slug: OTHER })], spawns: [spawnAt(1, 15, "third"), spawnAt(2, 20, null, 1)] },
    { agents },
  )
  assert.deepEqual(summary(jobs).map((job) => job.agents).sort(), [[0], [1, 2]])
  assertValid(jobs, agents)
})

test("without agents the session is worker 0 alone: every event is its own, and each job lists worker 0 and carries its segments", () => {
  const { jobs } = bind({ deskToolCalls: threeCalls({ agent: 3 }), fileWrites: [50, 60, 70].map((n) => writeAt(n, OTHER, 2)), spawns: [spawnAt(1, 10, "third")], focusCalls: [focusAt(80, "fourth", 5)] })
  assert.deepEqual(shape(jobs), {
    [idOf(SLUG)]: { agents: [0], segments: [span(0, 50), span(70, 80)] },
    [idOf(OTHER)]: { agents: [0], segments: [span(50, 70)] },
    [idOf("fourth")]: { agents: [0], segments: [span(80, 90)] },
  })
  assertValid(jobs)
})

test("a subagent's native commit is the session tree's evidence, and a native commit has no time of its own", () => {
  const { jobs, boundBy } = bind(
    { nativeCommitShas: [native(SHA_A, 1)], spawns: [spawnAt(1, 10)] },
    { agents: tree(0), nativeCommits: { [SHA_A]: { exists: true, taskPaths: [`${TRACK}/${SLUG}/notes.md`] } } },
  )
  assert.deepEqual(summary(jobs), [{ job: idOf(SLUG), basis: ["desk_commit", "inherited"], agents: [0, 1] }])
  assert.deepEqual(jobs[0].segments, [span(0, 90)])
  assert.deepEqual(boundBy, { [idOf(SLUG)]: "inferred" })
})

test("without the session's times, or with a session that ends before it starts, the controller has no timeline and is in no job", () => {
  const events = { deskToolCalls: threeCalls(), focusCalls: [focusAt(1, SLUG)], spawns: [spawnAt(1, 10), spawnAt(2, 10, OTHER)] }
  for (const session of [null, { started_at: minute(0) }, { started_at: "bad", derived_through: minute(9) }, { started_at: minute(50), derived_through: minute(10) }]) {
    const { jobs, boundBy, disagrees } = bind(events, { agents: tree(0, 0), session })
    // A subagent with its own line is still in that task's job, which then carries no segments.
    assert.deepEqual(shape(jobs), { [idOf(OTHER)]: { agents: [2], segments: "none" } }, JSON.stringify(session))
    assert.deepEqual([boundBy, disagrees], [{}, []])
  }
  // A session of no length has no time to give.
  assert.deepEqual(bind(events, { agents: tree(0), session: { started_at: minute(0), derived_through: minute(0) } }).jobs, [])
})

// --- Declared and inferred focus (Milestone 5a) ---------------------------------

test("bulk create batch binds nothing", () => {
  const creates = Array.from({ length: 6 }, (_, index) => deskCall({ at: minute(5), name: "mcp__plugin_desk_desk__task_create", slug: `filed-${index}-${SENTINEL}`, status: "drafting" }))
  const writes = Array.from({ length: 40 }, (_, index) => writeAt(10 + index, X))
  const { jobs, boundBy } = bind({ deskToolCalls: creates, fileWrites: writes }, { agents: tree() })
  assert.deepEqual(shape(jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(boundBy, { [idOf(X)]: "inferred" })
  assertValid(jobs)
  // The batch alone, however large, binds nothing.
  assert.deepEqual(bind({ deskToolCalls: creates }, { agents: tree() }).jobs, [])
})

test("status-only task_update on another card binds nothing", () => {
  const statusOnly = (n) => deskCall({ at: minute(n), slug: Y, status: "done", statusOnly: true })
  const { jobs } = bind({ deskToolCalls: [statusOnly(20), statusOnly(21), statusOnly(22), statusOnly(23)], fileWrites: [writeAt(10, X), writeAt(30, X), writeAt(50, X)] }, { agents: tree() })
  assert.deepEqual(shape(jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(jobs[0].transitions, [], "a transition on a card outside the session's jobs is not recorded")
  // The same calls on the bound job are its transitions, though they are no evidence.
  const own = bind({ deskToolCalls: [deskCall({ at: minute(20), status: "done", statusOnly: true })], fileWrites: [writeAt(10, X), writeAt(30, X), writeAt(50, X)] }, { agents: tree() })
  assert.deepEqual(own.jobs[0].transitions, [{ to: "done", at: minute(20) }])
  assert.deepEqual(own.jobs[0].basis, ["file_write"])
  // Three updates that carry more than a status are evidence.
  const real = bind({ deskToolCalls: [20, 25, 40].map((n) => deskCall({ at: minute(n), slug: Y, statusOnly: false })) }, { agents: tree() })
  assert.deepEqual(real.jobs.map(({ job, basis }) => ({ job, basis })), [{ job: idOf(Y), basis: ["desk_tool"] }])
  // One alone is not: a task_update never makes the one-event exception.
  assert.deepEqual(bind({ deskToolCalls: [deskCall({ at: minute(20) })] }, { agents: tree() }).jobs, [])
})

test("window-only and pathless commits bind nothing", () => {
  const window = (n, paths) => ({ start: minute(n), end: minute(n + 1), cwd: DESK, paths, agent: 0 })
  // Another session's commit lands inside this session's `git commit` window: Git history is never asked.
  const leaked = { sha: SHA_A, committed_at: minute(10), taskPaths: [`${TRACK}/${X}/notes.md`] }
  const windowOnly = bind({ shellGitCommits: [window(10, [])] }, { agents: tree(), commitsBetween: [leaked] })
  assert.deepEqual(windowOnly.jobs, [])
  assert.deepEqual(windowOnly.calls.between, [], "deskCommitsBetween binds nothing and is not called")
  // `git add -A`, `git add .` and `git commit -am` name no path, however many there are.
  assert.deepEqual(bind({ shellGitCommits: [window(10, []), window(20, []), window(30, []), window(40)] }, { agents: tree(), commitsBetween: [leaked] }).jobs, [])
  // Paths that name no task folder: the desk root, a track, a track's own file (no card answers to it), another repository.
  assert.deepEqual(bind({ shellGitCommits: [window(10, [DESK, `${DESK}/${TRACK}`, `${DESK}/${TRACK}/track.md`, `/elsewhere/${TRACK}/${X}/notes.md`, 7, null])] }, { agents: tree(), cards: { [`${TRACK}/track.md`]: null } }).jobs, [])
  // A commit that names a path at or under the task folder is the session's own work on it.
  const named = bind({ shellGitCommits: [window(10, [`${DESK}/${TRACK}/${X}/notes.md`]), window(40, [`${DESK_MARKER}/${TRACK}/${X}`])] }, { agents: tree() })
  assert.deepEqual(named.jobs.map(({ job, basis, segments }) => ({ job, basis, segments })), [{ job: idOf(X), basis: ["desk_commit"], segments: [span(0, 90)] }])
  // One commit naming more than three tasks is a sweep and counts for none of them.
  const sweep = window(10, ["a", "b", "c", "d"].map((name) => `${DESK}/${TRACK}/${name}-${SENTINEL}/task.md`))
  const swept = bind({ shellGitCommits: [sweep] }, { agents: tree() })
  assert.deepEqual(swept.jobs, [])
  assert.deepEqual(swept.calls.readTask, [], "a sweep's cards are not even read")
})

test("subagent focus call ignored", () => {
  const events = { focusCalls: [focusAt(10, X), focusAt(30, Y, 1)], spawns: [spawnAt(1, 20)] }
  const { jobs, boundBy, calls } = bind(events, { agents: tree(0) })
  assert.deepEqual(shape(jobs), { [idOf(X)]: { agents: [0, 1], segments: [span(0, 90)] } })
  assert.deepEqual(boundBy, { [idOf(X)]: "focus" })
  assert.deepEqual(calls.readTask, [`${TRACK}/${X}`], "the subagent's task is never read")
  assertValid(jobs, tree(0))
})

test("background agent keeps spawn-time job", () => {
  // Spawned at minute 20 under X; the controller switches to Y at 40; the agent writes into Y's folder until 80.
  const events = { focusCalls: [focusAt(5, X), focusAt(40, Y)], spawns: [spawnAt(1, 20)], fileWrites: [writeAt(50, Y, 1), writeAt(60, Y, 1), writeAt(80, Y, 1)] }
  const { jobs } = bind(events, { agents: tree(0) })
  assert.deepEqual(shape(jobs), {
    [idOf(X)]: { agents: [0, 1], segments: [span(0, 40)] },
    [idOf(Y)]: { agents: [0], segments: [span(40, 90)] },
  })
  assert.deepEqual(jobs.find((job) => job.job === idOf(X)).basis, ["desk_tool", "inherited"])
  assertValid(jobs, tree(0))
})

test("Desk-Task line wins over spawn-time focus", () => {
  const events = { focusCalls: [focusAt(5, X)], spawns: [spawnAt(1, 20, Y), spawnAt(2, 30, `gone-${SENTINEL}`)] }
  const { jobs, boundBy } = bind(events, { agents: tree(0, 0), cards: { [`${TRACK}/gone-${SENTINEL}`]: null } })
  // Worker 1's line names Y. Worker 2's line names a task with no card, so it falls through to the controller's job.
  assert.deepEqual(shape(jobs), {
    [idOf(X)]: { agents: [0, 2], segments: [span(0, 90)] },
    [idOf(Y)]: { agents: [1], segments: "none" },
  })
  assert.deepEqual(jobs.find((job) => job.job === idOf(Y)).basis, ["spawn_brief"])
  assert.deepEqual(boundBy, { [idOf(X)]: "focus" }, "a job only subagents hold is bound by neither focus nor inference")
  assertValid(jobs, tree(0, 0))
})

test("nested agent takes parent's job", () => {
  // 1 is spawned under X; 2 is 1's child, spawned after the controller moved to Y; 3 has a line for Z and 4 is its child.
  const events = { focusCalls: [focusAt(5, X), focusAt(40, Y)], spawns: [spawnAt(1, 20), spawnAt(2, 50, null, 1), spawnAt(3, 60, Z), spawnAt(4, 70, null, 3)] }
  const { jobs } = bind(events, { agents: tree(0, 1, 0, 3) })
  assert.deepEqual(shape(jobs), {
    [idOf(X)]: { agents: [0, 1, 2], segments: [span(0, 40)] },
    [idOf(Y)]: { agents: [0], segments: [span(40, 90)] },
    [idOf(Z)]: { agents: [3, 4], segments: "none" },
  })
  assert.deepEqual(jobs.find((job) => job.job === idOf(Z)).basis, ["spawn_brief", "inherited"])
  assertValid(jobs, tree(0, 1, 0, 3))
})

test("a subagent with no spawn time, spawned in a cleared stretch, or with an untraceable parent binds nothing", () => {
  const events = {
    focusCalls: [focusAt(5, X), focusAt(40, null), focusAt(60, X)],
    // 1: no usable timestamp. 2: spawned while nothing was in focus. 3: 1's child. 4: its parent is not a worker. 5 and 6: a cycle.
    // 7: spawned at the session's last instant. 8: its record is missing altogether.
    spawns: [spawnAt(1, null), spawnAt(2, 50), spawnAt(3, 20, null, 1), spawnAt(4, 20, null, 9), spawnAt(5, 20, null, 6), spawnAt(6, 20, null, 5), spawnAt(7, 90), null, { agent: "x" }, spawnAt(99, 20)],
  }
  const agents = tree(0, 0, 1, 9, 6, 5, 0, 0)
  const { jobs } = bind(events, { agents })
  assert.deepEqual(shape(jobs), { [idOf(X)]: { agents: [0, 7], segments: [span(0, 40), span(60, 90)] } })
  assertValid(jobs, tree(0, 0, 0, 0, 0, 0, 0, 0))
})

test("segments emitted for a single job with a clear stretch", () => {
  const { jobs, boundBy, disagrees } = bind({ focusCalls: [focusAt(0, X), focusAt(30, null), focusAt(50, X)] }, { agents: tree() })
  assert.deepEqual(jobs.map(({ job, basis, agents, segments }) => ({ job, basis, agents, segments })), [{ job: idOf(X), basis: ["desk_tool"], agents: [0], segments: [span(0, 30), span(50, 90)] }])
  assert.deepEqual(boundBy, { [idOf(X)]: "focus" })
  assert.deepEqual(disagrees, [])
  assertValid(jobs)
  // One job with no clear still carries its segments.
  assert.deepEqual(bind({ focusCalls: [focusAt(10, X)] }, { agents: tree() }).jobs[0].segments, [span(0, 90)])
  // A focus on a task whose card is gone holds its stretch for no job.
  const gone = bind({ focusCalls: [focusAt(0, X), focusAt(30, Y)] }, { agents: tree(), cards: { [`${TRACK}/${Y}`]: null } })
  assert.deepEqual(shape(gone.jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 30)] } })
  // Unreadable focus entries are skipped.
  assert.deepEqual(bind({ focusCalls: [null, { agent: 0, at: minute(5) }, { agent: 0, at: minute(5), track: "../x", slug: X }, { agent: 0, at: "bad", track: TRACK, slug: X }] }, { agents: tree() }).jobs, [])
})

test("segment cap reassigns shortest to main", () => {
  // X is the main task: 250 writes in the first minute. Y is declared for one second 201 times, clearing in between.
  const second = (n) => new Date(T0 + n * 1000).toISOString()
  const writes = Array.from({ length: 250 }, (_, index) => ({ at: second(40 + index / 100), path: `${DESK}/${TRACK}/${X}/notes.md`, agent: 0 }))
  const flips = Array.from({ length: 201 }, (_, index) => [
    { agent: 0, at: second(100 + index * 10), track: TRACK, slug: Y },
    { agent: 0, at: second(100 + index * 10 + (index === 0 ? 1 : 2)), clear: true },
  ]).flat()
  const { jobs } = bind({ fileWrites: writes, focusCalls: flips }, { agents: tree() })
  const byId = Object.fromEntries(jobs.map((job) => [job.job, job]))
  assert.equal(LIMITS.jobSegments, 200)
  assert.equal(byId[idOf(Y)].segments.length, 200)
  // Y's shortest stretch, the one-second one at 100 s, went to X and joined its prefix.
  assert.deepEqual(byId[idOf(X)].segments, [{ start_ms: 0, end_ms: 101000 }])
  assert.deepEqual(byId[idOf(Y)].segments[0], { start_ms: 110000, end_ms: 112000 })
  assertValid(jobs)
})

test("repo evidence counts only for the one listing card", () => {
  const pr = (n, repo, created = true) => ({ agent: 0, at: minute(n), repo, created })
  const cards = { [`${TRACK}/${X}`]: { ...CARD, repos: ["owner/code"] }, [`${TRACK}/${Y}`]: { ...CARD, repos: ["owner/code"] } }
  // X lists the repository and has one write: two created PRs make it a candidate. A PR only seen is no evidence.
  const events = { fileWrites: [writeAt(10, X)], deskToolCalls: [deskCall({ at: minute(12), slug: Z })], prRefs: [pr(20, "Owner/Code"), pr(40, "owner/code"), pr(50, "owner/code", false), pr(60, 7), null] }
  assert.deepEqual(shape(bind(events, { agents: tree(), cards }).jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(bind({ ...events, prRefs: [pr(20, "owner/code"), pr(50, "owner/code", false)] }, { agents: tree(), cards }).jobs, [], "one created PR leaves X at two events")
  // Y lists it too and has an event of its own: the PRs count for neither.
  assert.deepEqual(bind({ ...events, fileWrites: [writeAt(10, X), writeAt(11, Y)] }, { agents: tree(), cards }).jobs, [])
})

test("events from a subagent bound by a Desk-Task line, and from its own subagents, are left out of inference", () => {
  // Worker 1 has a line for Y and writes into X's folder; its child 2 does too. Neither makes X a candidate.
  const events = { spawns: [spawnAt(1, 10, Y), spawnAt(2, 15, null, 1)], fileWrites: [writeAt(20, X, 1), writeAt(30, X, 1), writeAt(40, X, 2), writeAt(50, X, 2)] }
  const briefed = bind(events, { agents: tree(0, 1) })
  // The spawn brief is the controller's one event on Y, and a spawn makes the only task with events a candidate.
  assert.deepEqual(shape(briefed.jobs), { [idOf(Y)]: { agents: [0, 1, 2], segments: [span(0, 90)] } })
  assert.deepEqual(briefed.jobs[0].basis, ["spawn_brief", "inherited"])
  // Without the line the same writes are the session tree's evidence for X.
  const plain = bind({ ...events, spawns: [spawnAt(1, 10), spawnAt(2, 15, null, 1)] }, { agents: tree(0, 1) })
  assert.deepEqual(shape(plain.jobs), { [idOf(X)]: { agents: [0, 1, 2], segments: [span(0, 90)] } })
  assert.deepEqual(plain.jobs[0].basis, ["file_write", "inherited"])
})

test("focus disagrees is reported by job, and a task renamed mid-session is one job", () => {
  const writes = Array.from({ length: 10 }, (_, index) => writeAt(20 + index, Y))
  const { jobs, disagrees, boundBy } = bind({ focusCalls: [focusAt(10, X)], fileWrites: writes }, { agents: tree() })
  assert.deepEqual(shape(jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(disagrees, [idOf(X)])
  assert.deepEqual(boundBy, { [idOf(X)]: "focus" })
  // Y was born as X: writes to either folder and a focus on either name are one task, read at each path once.
  const renamed = bind({ focusCalls: [focusAt(10, Y)], fileWrites: [writeAt(20, X), writeAt(30, Y)] }, { agents: tree(), birthPaths: { [`${TRACK}/${Y}`]: { track: TRACK, slug: X } } })
  assert.deepEqual(shape(renamed.jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(renamed.disagrees, [])
  assert.deepEqual(renamed.calls.readTask.sort(), [`${TRACK}/${X}`, `${TRACK}/${Y}`].sort())
})

test("own activity is the session's desk commit windows and its task-tool calls widened by a minute, merged and capped at 500", () => {
  const events = {
    deskToolCalls: [deskCall({ at: minute(10) }), deskCall({ at: minute(11), ok: false }), deskCall({ at: "bad" }), deskCall({ at: minute(10.5), track: "../x" })],
    shellGitCommits: [
      { start: "2026-09-25T08:30:00.400Z", end: "2026-09-25T08:30:02.000Z", cwd: DESK, paths: [] },
      { start: minute(50), end: minute(51), cwd: "/elsewhere", paths: [] },
      { start: "bad", end: minute(51), cwd: DESK, paths: [] },
    ],
  }
  const { ownActivity } = bind(events, { agents: tree() })
  // Milliseconds from the session's start: the two calls a half minute apart merge; the commit window opens at its second.
  assert.deepEqual(ownActivity, [[9 * 60000, 11.5 * 60000], [30 * 60000, 30 * 60000 + 2000]])
  const many = Array.from({ length: 501 }, (_, index) => ({ start: new Date(T0 + index * 5000).toISOString(), end: new Date(T0 + index * 5000 + 1000).toISOString(), cwd: DESK, paths: [] }))
  assert.equal(bind({ shellGitCommits: many }, { agents: tree() }).ownActivity.length, 500)
  // Without the session's start there is nothing to measure from.
  assert.deepEqual(bind(events, { agents: tree(), session: null }).ownActivity, [])
})

// --- Work in a code repository ---------------------------------------------------

const CODE = "/work/code"
const codeWrite = (n, file = "src/a.js", agent = 0) => ({ at: minute(n), path: `${CODE}/${file}`, agent })
const listing = (...slugs) => Object.fromEntries(slugs.map((slug) => [`${TRACK}/${slug}`, { ...CARD, repos: ["ourostack/desk"] }]))

test("file writes and commits in a card's listed repository count for that card", () => {
  // The reviewer's case: X lists the repository and has two desk writes, forty writes and a commit in the repository; Y has three notes.
  const events = {
    fileWrites: [writeAt(1, X), writeAt(2, X), ...Array.from({ length: 40 }, (_, index) => codeWrite(5 + index * 2, `src/${index % 4}/file-${SENTINEL}.js`)), writeAt(3, Y), writeAt(4, Y), writeAt(5, Y)],
    shellGitCommits: [{ start: minute(86), end: minute(87), cwd: CODE, paths: [`${CODE}/src`], agent: 0 }],
  }
  const result = bind(events, { agents: tree(), cards: listing(X), repos: { [CODE]: "OurOStack/Desk" } })
  assert.deepEqual(shape(result.jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(result.boundBy, { [idOf(X)]: "inferred" })
  assert.equal(result.repoUnresolved, 0)
  assert.deepEqual(summary(result.jobs), [{ job: idOf(X), basis: ["file_write"], agents: [0] }])
  assertValid(result.jobs)
  // Without the repository evidence X has two events, and the session is Y's.
  assert.deepEqual(Object.keys(shape(bind(events, { agents: tree(), cards: listing(X) }).jobs)), [idOf(Y)])
  // A card that lists the repository by its bare name counts the same way.
  const bare = { [`${TRACK}/${X}`]: { ...CARD, repos: ["desk"] } }
  assert.deepEqual(Object.keys(shape(bind(events, { agents: tree(), cards: bare, repos: { [CODE]: "ourostack/desk" } }).jobs)), [idOf(X)])
})

test("a repository listed by two cards that both have events counts for neither", () => {
  const events = { fileWrites: [writeAt(1, X), writeAt(2, Y), ...Array.from({ length: 12 }, (_, index) => codeWrite(5 + index * 2))] }
  const result = bind(events, { agents: tree(), cards: listing(X, Y), repos: { [CODE]: "ourostack/desk" } })
  assert.deepEqual(result.jobs, [])
  assert.equal(result.repoUnresolved, 0)
  // With one of the two cards untouched, the repository is the other's.
  const one = bind({ fileWrites: events.fileWrites.filter((write) => write.path !== writeAt(2, Y).path) }, { agents: tree(), cards: listing(X, Y), repos: { [CODE]: "ourostack/desk" } })
  assert.deepEqual(Object.keys(shape(one.jobs)), [idOf(X)])
  // A repository no card lists is no evidence for anyone.
  assert.deepEqual(bind(events, { agents: tree(), repos: { [CODE]: "ourostack/desk" } }).jobs, [])
})

test("a path outside the desk that resolves to no repository binds nothing, and only a directory whose evidence is not available is counted", () => {
  const events = {
    fileWrites: [
      writeAt(1, X), writeAt(2, X), writeAt(3, Y),
      ...Array.from({ length: 10 }, (_, index) => ({ at: minute(10 + index), path: `/tmp/scratch-${SENTINEL}/${index % 2}/out.txt`, agent: 0 })),
      { at: minute(30), path: `/tmp/scratch-${SENTINEL}/0/other.txt`, agent: 0 },
      // A subagent `agents` does not list is no evidence, and is not counted either.
      { at: minute(31), path: "/tmp/unlisted/out.txt", agent: 9 },
    ],
    shellGitCommits: [
      { start: minute(40), end: minute(41), cwd: "/tmp/not-a-repo", paths: ["/tmp/not-a-repo/a/b.txt", "/tmp/not-a-repo/a/c.txt", 7], agent: 0 },
      // No directory, or one that is not absolute, is nothing to resolve.
      { start: minute(42), end: minute(43), cwd: null, paths: [], agent: 0 },
      { start: minute(44), end: minute(45), cwd: "relative/dir", paths: [], agent: 0 },
      // An unlisted worker's commit call is no evidence, and its directory is not counted.
      { start: minute(46), end: minute(47), cwd: "/tmp/unlisted", paths: ["/tmp/unlisted/a.txt"], agent: 9 },
    ],
  }
  const result = bind(events, { agents: tree(), cards: listing(X), unavailable: ["/tmp"] })
  assert.deepEqual(result.jobs, [], "two desk writes beside another task's are not enough, and an unresolved path is never guessed")
  // Two write directories, the commit's directory and the directory of the paths it named.
  assert.equal(result.repoUnresolved, 4)
  assert.equal(typeof result.repoUnresolved, "number")
  // A reader that answers with something other than one of its three answers is not available evidence either.
  const odd = bindSession({ events, agents: tree(), session: SESSION, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...fakes({ cards: listing(X), unavailable: ["/tmp"] }), repoLookup: () => ({ repo: "" }) })
  assert.deepEqual([odd.jobs, odd.repoUnresolved], [[], 4])
  // Directories that exist and are in no repository are a true none: nothing was lost, so nothing is counted.
  assert.equal(bind(events, { agents: tree(), cards: listing(X) }).repoUnresolved, 0)
  // A repository that resolves is never counted, available or not.
  assert.equal(bind(events, { agents: tree(), cards: listing(X), unavailable: ["/tmp"], repos: { "/tmp": "someone/else" } }).repoUnresolved, 0)
  // A caller that omits the reader is an error, never a silent zero.
  const { repoLookup, ...blind } = fakes({ cards: listing(X) })
  assert.throws(() => bindSession({ events, agents: tree(), session: SESSION, deskRoot: DESK, deskRemote: REMOTE, personPrefix: "", ...blind }), TypeError)
})

test("a commit call in a repository is one event per repository it touches, at the call's start, and paths inside the desk are never asked about", () => {
  const OTHER_CODE = "/work/other"
  const commit = (n, cwd, paths = []) => ({ start: minute(n), end: minute(n + 1), cwd, paths, agent: 0 })
  const events = {
    fileWrites: [writeAt(1, X)],
    // Three commit calls in the repository, ten minutes apart, one of which also names a file in another repository.
    shellGitCommits: [commit(10, CODE, [`${CODE}/a.js`, `${CODE}/b.js`]), commit(20, `${CODE}/sub`), commit(30, CODE, [`${OTHER_CODE}/c.js`]), commit(40, DESK, [`${DESK}/${TRACK}/${X}/notes.md`]), commit(50, DESK_MARKER, [`${DESK_MARKER}/${TRACK}/${X}`])],
  }
  const result = bind(events, { agents: tree(), cards: listing(X), repos: { [CODE]: "ourostack/desk", [OTHER_CODE]: "someone/else" } })
  assert.deepEqual(shape(result.jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(summary(result.jobs)[0].basis, ["file_write", "desk_commit"])
  assert.equal(result.repoUnresolved, 0)
  assert.ok(result.calls.repoLookup.every((asked) => !asked.startsWith(DESK) && !asked.includes(DESK_MARKER)), "the desk is never resolved as a code repository")
  // A subagent bound by its own Desk-Task line keeps its repository work out of the controller's inference.
  const subagentWrites = [writeAt(1, X), ...Array.from({ length: 12 }, (_, index) => codeWrite(5 + index * 2, "src/a.js", 1))]
  const options = { agents: tree(0), cards: listing(X), repos: { [CODE]: "ourostack/desk" } }
  assert.deepEqual(shape(bind({ fileWrites: subagentWrites, spawns: [spawnAt(1, 2)] }, options).jobs), { [idOf(X)]: { agents: [0, 1], segments: [span(0, 90)] } })
  assert.deepEqual(shape(bind({ fileWrites: subagentWrites, spawns: [spawnAt(1, 2, Y)] }, options).jobs), { [idOf(Y)]: { agents: [1], segments: "none" } })
})

test("task_create with focus declares the new card: the session is bound by declaration, not as one that never declared", () => {
  const create = deskCall({ at: minute(10), name: "mcp__plugin_desk_desk__task_create", slug: X })
  // The parser emits the focus call beside the create call; ten notes on Y would otherwise take the whole session.
  const events = { deskToolCalls: [create], focusCalls: [focusAt(10, X)], fileWrites: Array.from({ length: 10 }, (_, index) => writeAt(20 + index * 5, Y)) }
  const result = bind(events, { agents: tree() })
  assert.deepEqual(shape(result.jobs)[idOf(X)], { agents: [0], segments: [span(0, 90)] })
  assert.deepEqual(result.boundBy, { [idOf(X)]: "focus" })
  assert.deepEqual(result.disagrees, [idOf(X)])
  // Without the focus call the create is no evidence at all, and the session is Y's.
  assert.deepEqual(Object.keys(shape(bind({ ...events, focusCalls: [] }, { agents: tree() }).jobs)), [idOf(Y)])
})

test("native commits count toward candidacy only, never toward time", () => {
  const shas = ["1", "2", "3", "4", "5"].map((digit) => digit.repeat(40))
  const nativeCommits = Object.fromEntries(shas.map((sha) => [sha, { exists: true, taskPaths: [`${TRACK}/${Y}/notes.md`] }]))
  // X has three timed writes; Y has five native commits, which have no time.
  const events = { fileWrites: [writeAt(10, X), writeAt(20, X), writeAt(30, X)], nativeCommitShas: shas.map((sha) => native(sha)) }
  const result = bind(events, { agents: tree(), nativeCommits })
  // Y is a candidate, but more untimed events do not make it the main task, so it gets none of the time X's episode leaves open.
  assert.deepEqual(shape(result.jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(result.boundBy, { [idOf(X)]: "inferred" })
  // Two native commits beside one timed write make Y a candidate (three events); X's three timed writes still hold every minute.
  const lifted = bind({ fileWrites: [...events.fileWrites, writeAt(50, Y)], nativeCommitShas: shas.slice(0, 2).map((sha) => native(sha)) }, { agents: tree(), nativeCommits })
  assert.deepEqual(shape(lifted.jobs), { [idOf(X)]: { agents: [0], segments: [span(0, 90)] } })
  // Candidacy is what they do count toward: alone in a session that never declares, three native commits bind their task.
  const alone = bind({ nativeCommitShas: shas.slice(0, 3).map((sha) => native(sha)) }, { agents: tree(), nativeCommits })
  assert.deepEqual(shape(alone.jobs), { [idOf(Y)]: { agents: [0], segments: [span(0, 90)] } })
  assert.deepEqual(summary(alone.jobs)[0].basis, ["desk_commit"])
  // In a session that declares, evidence with no time counts for nothing.
  const declared = bind({ ...events, focusCalls: [focusAt(40, X)] }, { agents: tree(), nativeCommits })
  assert.deepEqual(Object.keys(shape(declared.jobs)), [idOf(X)])
})

test("the cap's dropped time comes out as segmentsCappedMs: 0 when nothing dropped, the lost time when a task over the cap stands alone", () => {
  assert.equal(bind({ focusCalls: [focusAt(1, SLUG)] }).segmentsCappedMs, 0)
  assert.equal(bind({}).segmentsCappedMs, 0, "a session with no focus and no evidence drops nothing")
  const at = (seconds) => new Date(T0 + seconds * 1000).toISOString()
  const focusCalls = []
  for (let index = 0; index < LIMITS.jobSegments + 2; index += 1) {
    focusCalls.push({ agent: 0, at: at(index * 20), track: TRACK, slug: SLUG }, { agent: 0, at: at(index * 20 + 10), clear: true })
  }
  const result = bind({ focusCalls })
  assert.equal(result.segmentsCappedMs, 2 * 10000)
  assert.equal(result.jobs[0].segments.length, LIMITS.jobSegments)
})
