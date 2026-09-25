// The real binding readers — task-card frontmatter and desk Git history —
// against a temporary Git repository built here. No real desk is read.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createDeskReaders, readDeskRemote } from "../../src/factory/desk-repo.js"
import { bindSession, jobId } from "../../src/factory/binding.js"

let desk
let shas

const card = (fields) => `---\n${fields.join("\n")}\n---\n\n# A task\n`

function git(args, env = {}) {
  const result = spawnSync("git", ["-C", desk, ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...env },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function write(relative, text) {
  const target = path.join(desk, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
}

function commitAt({ committed, authored = committed, message }) {
  git(["add", "-A"])
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message], {
    GIT_COMMITTER_DATE: committed,
    GIT_AUTHOR_DATE: authored,
  })
  return git(["rev-parse", "HEAD"])
}

before(() => {
  desk = mkdtempSync(path.join(os.tmpdir(), "desk-repo-"))
  git(["init", "-q", "-b", "main"])
  shas = {}
  write("track/live-task/task.md", card(["title: A live task", "status: processing", "created: \"2026-09-20T10:00:00Z\"", "updated: '2026-09-25T09:00:00Z'"]))
  shas.first = commitAt({ committed: "2026-09-25T08:00:00Z", message: "first" })

  write("track/_archive/old-task/task.md", card(["status: done # finished", "created: 2026-09-01T00:00:00Z", "updated: 2026-09-02T12:30:00+02:00"]))
  write("track/live-task/notes with space.md", "notes\n")
  shas.second = commitAt({ committed: "2026-09-25T08:20:01Z", message: "second" })

  // A rebased commit: authored inside the window, re-committed long after.
  write("track/other-task/task.md", card(["status: blocked"]))
  shas.rebased = commitAt({ authored: "2026-09-25T08:30:00Z", committed: "2026-09-25T11:00:00Z", message: "rebased" })

  // A side branch merged back: the merge commit itself is skipped.
  git(["checkout", "-q", "-b", "side"])
  write("track/side-task/task.md", card(["status: drafting"]))
  shas.side = commitAt({ committed: "2026-09-25T12:00:00Z", message: "side" })
  git(["checkout", "-q", "main"])
  write("_meta/log.md", "log\n")
  shas.main = commitAt({ committed: "2026-09-25T12:00:10Z", message: "main" })
  git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "-q", "--no-ff", "-m", "merge", "side"], {
    GIT_COMMITTER_DATE: "2026-09-25T12:00:20Z",
    GIT_AUTHOR_DATE: "2026-09-25T12:00:20Z",
  })
  shas.merge = git(["rev-parse", "HEAD"])

  // Cards that are not committed, for the reader's edge cases.
  write("track/no-frontmatter/task.md", "# Just a heading\nstatus: done\n")
  write("track/bad-values/task.md", card(["status: finished", "created: 2026-09-20", "updated: soon"]))
  write("track/unterminated/task.md", "---\nstatus: paused\n")
  write("track/late-frontmatter/task.md", `---\n${"x: y\n".repeat(45)}status: done\n---\n`)
  write("track/indented/task.md", card(["repos:", "  status: done", "status: validating"]))
  mkdirSync(path.join(desk, "track/dir-card/task.md"), { recursive: true })
  write("desks/ari/track/person-task/task.md", card(["status: collaborating", "created: 2026-09-21T00:00:00.000Z"]))
})

after(() => {
  rmSync(desk, { recursive: true, force: true })
})

// --- readTask --------------------------------------------------------------------

test("readTask reads status, created and updated from a live card's frontmatter, unquoting values", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(readTask("track", "live-task"), { status: "processing", created_at: "2026-09-20T10:00:00.000Z", updated_at: "2026-09-25T09:00:00.000Z" })
})

test("readTask falls back to the _archive card, drops trailing comments and normalizes offsets to UTC", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(readTask("track", "old-task"), { status: "done", created_at: "2026-09-01T00:00:00.000Z", updated_at: "2026-09-02T10:30:00.000Z" })
})

test("readTask returns null when no card exists, live or archived, or when the names are unsafe", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  assert.equal(readTask("track", "missing"), null)
  for (const [track, slug] of [["..", "x"], ["track", "../live-task"], ["_meta", "x"], ["track", ""], [7, "x"]]) {
    assert.equal(readTask(track, slug), null, `${track}/${slug}`)
  }
})

test("readTask gives nulls for fields it cannot read: no frontmatter, invalid values, unterminated, past 40 lines, or a folder", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  const empty = { status: null, created_at: null, updated_at: null }
  assert.deepEqual(readTask("track", "no-frontmatter"), empty)
  assert.deepEqual(readTask("track", "bad-values"), empty)
  assert.deepEqual(readTask("track", "unterminated"), empty)
  assert.deepEqual(readTask("track", "late-frontmatter"), empty)
  assert.deepEqual(readTask("track", "dir-card"), empty)
  assert.deepEqual(readTask("track", "indented"), { status: "validating", created_at: null, updated_at: null })
})

test("readTask treats a card it may not open as unreadable, and a track that is a file as no card", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk })
  write("track/locked/task.md", card(["status: done"]))
  write("file-track", "not a folder\n")
  chmodSync(path.join(desk, "track/locked/task.md"), 0o000)
  try {
    assert.deepEqual(readTask("track", "locked"), { status: null, created_at: null, updated_at: null })
    assert.equal(readTask("file-track", "x"), null)
  } finally {
    chmodSync(path.join(desk, "track/locked/task.md"), 0o644)
  }
})

test("readTask reads under the person prefix when one is given", () => {
  const { readTask } = createDeskReaders({ deskRoot: desk, personPrefix: "desks/ari" })
  assert.deepEqual(readTask("track", "person-task"), { status: "collaborating", created_at: "2026-09-21T00:00:00.000Z", updated_at: null })
  assert.equal(readTask("track", "live-task"), null)
  assert.throws(() => createDeskReaders({ deskRoot: desk, personPrefix: "people/ari" }), TypeError)
  assert.throws(() => createDeskReaders({ deskRoot: "relative" }), TypeError)
})

// --- deskCommitsBetween --------------------------------------------------------------

test("deskCommitsBetween finds the commit made in the window, with every path it changed", () => {
  const { deskCommitsBetween } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(deskCommitsBetween("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z"), [{
    sha: shas.second,
    committed_at: "2026-09-25T08:20:01.000Z",
    authored_at: "2026-09-25T08:20:01.000Z",
    taskPaths: ["track/_archive/old-task/task.md", "track/live-task/notes with space.md"],
  }])
  assert.deepEqual(deskCommitsBetween("2026-09-25T08:20:02.000Z", "2026-09-25T08:25:00.000Z"), [])
})

test("deskCommitsBetween matches a rebased commit by its author time, and skips merge commits", () => {
  const { deskCommitsBetween } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(deskCommitsBetween("2026-09-25T08:29:59.000Z", "2026-09-25T08:30:05.000Z").map(({ sha }) => sha), [shas.rebased])
  const late = deskCommitsBetween("2026-09-25T12:00:00.000Z", "2026-09-25T12:00:30.000Z").map(({ sha }) => sha)
  assert.deepEqual(late.sort(), [shas.main, shas.side].sort())
  assert.equal(late.includes(shas.merge), false)
})

test("deskCommitsBetween returns nothing for an invalid window, outside a repository, or when Git is missing", () => {
  const { deskCommitsBetween } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(deskCommitsBetween("yesterday", "2026-09-25T08:20:02.000Z"), [])
  assert.deepEqual(deskCommitsBetween("2026-09-25T08:20:02.000Z", "2026-09-25T08:20:01.000Z"), [])
  assert.deepEqual(deskCommitsBetween("2026-09-25T08:20:01.000Z", 5), [])
  const outside = mkdtempSync(path.join(os.tmpdir(), "desk-repo-none-"))
  try {
    assert.deepEqual(createDeskReaders({ deskRoot: outside }).deskCommitsBetween("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z"), [])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
  const noGit = createDeskReaders({ deskRoot: desk, git: path.join(desk, "no-such-git") })
  assert.deepEqual(noGit.deskCommitsBetween("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z"), [])
})

// --- gitCommitTaskPaths ------------------------------------------------------------------

test("gitCommitTaskPaths confirms a desk commit and lists what it changed, the root commit included", () => {
  const { gitCommitTaskPaths } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(gitCommitTaskPaths(shas.first), { exists: true, taskPaths: ["track/live-task/task.md"] })
  assert.deepEqual(gitCommitTaskPaths(shas.rebased), { exists: true, taskPaths: ["track/other-task/task.md"] })
})

test("gitCommitTaskPaths reports a commit Git confirms but cannot list as changing nothing", () => {
  // A stand-in Git that confirms every commit and fails every other command.
  const fakeGit = path.join(desk, "..", `${path.basename(desk)}-fake-git.sh`)
  writeFileSync(fakeGit, "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = cat-file ] && exit 0; done\nexit 1\n", { mode: 0o755 })
  try {
    const { gitCommitTaskPaths } = createDeskReaders({ deskRoot: desk, git: fakeGit })
    assert.deepEqual(gitCommitTaskPaths(shas.first), { exists: true, taskPaths: [] })
  } finally {
    rmSync(fakeGit, { force: true })
  }
})

test("gitCommitTaskPaths says a commit that is not in the desk, or is not a SHA, does not exist", () => {
  const { gitCommitTaskPaths } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(gitCommitTaskPaths("0".repeat(40)), { exists: false, taskPaths: [] })
  assert.deepEqual(gitCommitTaskPaths("--output=/tmp/x"), { exists: false, taskPaths: [] })
  assert.deepEqual(gitCommitTaskPaths(shas.first.toUpperCase()), { exists: false, taskPaths: [] })
})

// --- readDeskRemote ---------------------------------------------------------------------

test("readDeskRemote reads origin's URL, and is null with no origin or no repository", () => {
  assert.equal(readDeskRemote({ deskRoot: desk }), null)
  git(["remote", "add", "origin", "git@github.com:Owner/Desk.git"])
  try {
    assert.equal(readDeskRemote({ deskRoot: desk }), "git@github.com:Owner/Desk.git")
  } finally {
    git(["remote", "remove", "origin"])
  }
  assert.equal(readDeskRemote({ deskRoot: path.join(desk, "track") }), null, "a folder inside the desk reads the desk's remote, which is none here")
  assert.equal(readDeskRemote({ deskRoot: path.join(os.tmpdir(), "desk-repo-missing-folder") }), null)
})

// --- The real readers drive binding end to end ---------------------------------------------

test("end to end: a session's git commit call in the desk binds the tasks its commit changed", () => {
  const readers = createDeskReaders({ deskRoot: desk })
  const { jobs } = bindSession({
    events: { shellGitCommits: [{ start: "2026-09-25T08:20:01.300Z", end: "2026-09-25T08:20:01.900Z", cwd: desk }] },
    deskRoot: desk,
    deskRemote: null,
    personPrefix: "",
    ...readers,
  })
  const id = (slug) => jobId({ deskRemote: `local:${desk}`, personPrefix: "", track: "track", slug })
  assert.deepEqual(jobs.map(({ job, basis, observed }) => ({ job, basis, observed })).sort((a, b) => (a.job < b.job ? -1 : 1)), [
    { job: id("live-task"), basis: ["desk_commit"], observed: { status: "processing", at: null } },
    { job: id("old-task"), basis: ["desk_commit"], observed: { status: "done", at: "2026-09-02T10:30:00.000Z" } },
  ].sort((a, b) => (a.job < b.job ? -1 : 1)))
})
