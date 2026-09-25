// The real binding readers — task-card frontmatter and desk Git history —
// against a temporary Git repository built here. No real desk is read.

import { test, before, after } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { createDeskReaders, readDeskRemote } from "../../src/factory/desk-repo.js"
import { bindSession, jobId } from "../../src/factory/binding.js"

let scratch
let desk
let other
let origin
let shas

const card = (fields, body = "# A task") => `---\n${fields.join("\n")}\n---\n\n${body}\n`
const LIVE_CARD = ["title: A live task", "status: processing", "created: \"2026-09-20T10:00:00Z\"", "updated: '2026-09-25T09:00:00Z'"]

// Runs Git in `repo`; `at` stamps the commit and every reflog entry it makes.
function gitIn(repo, args, at) {
  const dates = at === undefined ? {} : { GIT_COMMITTER_DATE: at, GIT_AUTHOR_DATE: at }
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...dates },
  })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}
const git = (args, at) => gitIn(desk, args, at)

function writeIn(repo, relative, text) {
  const target = path.join(repo, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
}
const write = (relative, text) => writeIn(desk, relative, text)

function commitIn(repo, at, message, extra = []) {
  gitIn(repo, ["add", "-A"])
  gitIn(repo, ["commit", "-q", "-m", message, ...extra], at)
  return gitIn(repo, ["rev-parse", "HEAD"])
}
const commitAt = (at, message, extra) => commitIn(desk, at, message, extra)

before(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), "desk-repo-"))
  origin = path.join(scratch, "origin.git")
  desk = path.join(scratch, "desk")
  other = path.join(scratch, "other")
  mkdirSync(desk)
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin])
  git(["init", "-q", "-b", "main"])
  git(["remote", "add", "origin", origin])
  shas = {}

  // The initial commit: a `commit (initial)` entry, which is not listed.
  write("track/live-task/task.md", card(LIVE_CARD))
  shas.first = commitAt("2026-09-25T08:00:00Z", "first")

  write("track/_archive/old-task/task.md", card(["status: done # finished", "created: 2026-09-01T00:00:00Z", "updated: 2026-09-02T12:30:00+02:00"]))
  write("track/live-task/notes with space.md", "notes\n")
  shas.second = commitAt("2026-09-25T08:20:01Z", "second")
  git(["push", "-q", "origin", "main"], "2026-09-25T08:20:02Z")

  // Another clone commits and pushes; this clone fetches and fast-forwards.
  gitIn(scratch, ["clone", "-q", origin, other], "2026-09-25T08:25:00Z")
  writeIn(other, "track/fetched-task/task.md", card(["status: blocked"]))
  shas.fetched = commitIn(other, "2026-09-25T08:40:00Z", "fetched")
  gitIn(other, ["push", "-q", "origin", "main"], "2026-09-25T08:40:01Z")
  git(["pull", "-q", "--ff-only", "origin", "main"], "2026-09-25T08:45:00Z")

  // A commit, then its amend: both are this clone's.
  write("track/amended-task/task.md", card(["status: drafting"]))
  shas.beforeAmend = commitAt("2026-09-25T09:00:00Z", "draft")
  write("track/amended-task/notes.md", "more\n")
  shas.amended = commitAt("2026-09-25T09:05:00Z", "drafted", ["--amend"])

  // A commit later rebased onto another clone's work keeps its own entry.
  write("track/other-task/task.md", card(["status: blocked"]))
  shas.preRebase = commitAt("2026-09-25T09:30:00Z", "before rebase")
  gitIn(other, ["pull", "-q", "--ff-only", "origin", "main"], "2026-09-25T09:50:00Z")
  writeIn(other, "_meta/log.md", "log\n")
  commitIn(other, "2026-09-25T10:00:00Z", "upstream")
  gitIn(other, ["push", "-q", "origin", "main"], "2026-09-25T10:00:01Z")
  git(["pull", "-q", "--rebase", "origin", "main"], "2026-09-25T11:00:00Z")

  // A side branch merged with `git merge`: the merge entry is not listed.
  git(["checkout", "-q", "-b", "side"], "2026-09-25T11:59:00Z")
  write("track/side-task/task.md", card(["status: drafting"]))
  shas.side = commitAt("2026-09-25T12:00:00Z", "side")
  git(["checkout", "-q", "main"], "2026-09-25T12:00:05Z")
  write("_meta/other.md", "main\n")
  shas.main = commitAt("2026-09-25T12:00:10Z", "main")
  git(["merge", "-q", "--no-ff", "-m", "merge", "side"], "2026-09-25T12:00:20Z")

  // A conflicted merge committed by hand: a `commit (merge)` entry, whose
  // paths are only the file resolved by hand.
  git(["checkout", "-q", "-b", "conflict"], "2026-09-25T12:29:00Z")
  write("track/live-task/task.md", card(LIVE_CARD, "# One side"))
  write("track/c1-only/task.md", card(["status: drafting"]))
  commitAt("2026-09-25T12:30:00Z", "one side")
  git(["checkout", "-q", "main"], "2026-09-25T12:30:05Z")
  write("track/live-task/task.md", card(LIVE_CARD, "# Other side"))
  commitAt("2026-09-25T12:30:10Z", "other side")
  // The merge stops on the conflict (exit 1), leaving MERGE_HEAD for the commit.
  const merge = spawnSync("git", ["-C", desk, "-c", "user.name=Test", "-c", "user.email=test@example.com", "merge", "-q", "conflict"], {
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_COMMITTER_DATE: "2026-09-25T12:30:20Z" },
  })
  assert.equal(merge.status, 1)
  write("track/live-task/task.md", card(LIVE_CARD, "# Resolved"))
  git(["add", "-A"])
  git(["commit", "-q", "-m", "resolved"], "2026-09-25T12:30:30Z")
  shas.conflictMerge = git(["rev-parse", "HEAD"])

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
  rmSync(scratch, { recursive: true, force: true })
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

// --- deskCommitsBetween: the commits this clone made -------------------------------------

const between = (start, end, root = desk) => createDeskReaders({ deskRoot: root }).deskCommitsBetween(start, end)

test("deskCommitsBetween lists this clone's commit made in the window, once, with every path it changed", () => {
  assert.deepEqual(between("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z"), [{
    sha: shas.second,
    committed_at: "2026-09-25T08:20:01.000Z",
    taskPaths: ["track/_archive/old-task/task.md", "track/live-task/notes with space.md"],
  }])
  assert.deepEqual(between("2026-09-25T08:20:02.000Z", "2026-09-25T08:25:00.000Z"), [], "the window's end bounds it")
})

test("deskCommitsBetween never lists a commit fetched or pulled from another clone, nor the pull itself", () => {
  assert.deepEqual(between("2026-09-25T08:39:59.000Z", "2026-09-25T08:45:05.000Z"), [])
  assert.deepEqual(between("2026-09-25T09:59:59.000Z", "2026-09-25T10:00:05.000Z"), [])
})

test("deskCommitsBetween lists a commit and its amend, and a commit later rebased keeps its original entry", () => {
  assert.deepEqual(between("2026-09-25T09:00:00.000Z", "2026-09-25T09:05:00.000Z").map(({ sha, taskPaths }) => ({ sha, taskPaths })), [
    { sha: shas.amended, taskPaths: ["track/amended-task/notes.md", "track/amended-task/task.md"] },
    { sha: shas.beforeAmend, taskPaths: ["track/amended-task/task.md"] },
  ])
  assert.deepEqual(between("2026-09-25T09:29:59.000Z", "2026-09-25T09:30:05.000Z"), [
    { sha: shas.preRebase, committed_at: "2026-09-25T09:30:00.000Z", taskPaths: ["track/other-task/task.md"] },
  ])
  assert.deepEqual(between("2026-09-25T10:59:59.000Z", "2026-09-25T11:00:05.000Z"), [], "the rebase's own entries are not commits")
})

test("deskCommitsBetween skips checkouts and git merge entries, and lists a hand-committed merge with only the files resolved", () => {
  assert.deepEqual(between("2026-09-25T11:58:00.000Z", "2026-09-25T12:00:25.000Z").map(({ sha }) => sha).sort(), [shas.main, shas.side].sort())
  assert.deepEqual(between("2026-09-25T12:30:25.000Z", "2026-09-25T12:30:35.000Z"), [
    { sha: shas.conflictMerge, committed_at: "2026-09-25T12:30:30.000Z", taskPaths: ["track/live-task/task.md"] },
  ])
})

test("the initial commit's entry is not one of the listed kinds", () => {
  assert.deepEqual(between("2026-09-25T07:59:59.000Z", "2026-09-25T08:00:05.000Z"), [])
})

test("Git ignores GIT_* variables the caller inherited, so a hook's GIT_DIR cannot point it at another repository", () => {
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE }
  process.env.GIT_DIR = path.join(os.tmpdir(), "desk-repo-not-a-repository")
  process.env.GIT_WORK_TREE = os.tmpdir()
  try {
    assert.deepEqual(between("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z").map(({ sha }) => sha), [shas.second])
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test("deskCommitsBetween returns nothing for an invalid window, outside a repository, or when Git is missing", () => {
  assert.deepEqual(between("yesterday", "2026-09-25T08:20:02.000Z"), [])
  assert.deepEqual(between("2026-09-25T08:20:02.000Z", "2026-09-25T08:20:01.000Z"), [])
  assert.deepEqual(between("2026-09-25T08:20:01.000Z", 5), [])
  const outside = mkdtempSync(path.join(os.tmpdir(), "desk-repo-none-"))
  try {
    assert.deepEqual(between("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z", outside), [])
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
  const noGit = createDeskReaders({ deskRoot: desk, git: path.join(desk, "no-such-git") })
  assert.deepEqual(noGit.deskCommitsBetween("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z"), [])
})

test("a desk root that is not its repository's top level reads no history and no remote: Git never walks up", () => {
  const inner = path.join(desk, "track")
  assert.deepEqual(between("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z", inner), [])
  assert.deepEqual(createDeskReaders({ deskRoot: inner }).gitCommitTaskPaths(shas.second), { exists: false, taskPaths: [] })
  assert.equal(readDeskRemote({ deskRoot: inner }), null)
  assert.equal(readDeskRemote({ deskRoot: desk }), origin)
})

test("a repository with no commits yet lists nothing", () => {
  const empty = path.join(scratch, "empty")
  mkdirSync(empty)
  gitIn(empty, ["init", "-q", "-b", "main"])
  assert.deepEqual(between("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z", empty), [])
})

test("a stand-in Git whose branch listing fails lists nothing", () => {
  const fakeGit = path.join(scratch, "fake-git-no-refs.sh")
  writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = for-each-ref ] && exit 1; done\nexec git "$@"\n`, { mode: 0o755 })
  assert.deepEqual(createDeskReaders({ deskRoot: desk, git: fakeGit }).deskCommitsBetween("2026-09-25T08:20:01.000Z", "2026-09-25T08:20:02.500Z"), [])
})

test("reflog lines with an unreadable time are skipped", () => {
  const fakeGit = path.join(scratch, "fake-git-bad-time.sh")
  const record = `\x1e${"a".repeat(40)}\x1fHEAD@{not a time}\x1fcommit: x\x00\ntrack/t/task.md\x00\x1e${"b".repeat(40)}\x1fHEAD\x1fcommit: y\x00`
  writeFileSync(fakeGit, `#!/bin/sh\nfor arg in "$@"; do [ "$arg" = --walk-reflogs ] && { printf '${record.replaceAll("\x1e", "\\036").replaceAll("\x1f", "\\037").replaceAll("\x00", "\\000").replaceAll("\n", "\\n")}'; exit 0; }; done\nexec git "$@"\n`, { mode: 0o755 })
  assert.deepEqual(createDeskReaders({ deskRoot: desk, git: fakeGit }).deskCommitsBetween("2026-09-25T08:00:00.000Z", "2026-09-25T13:00:00.000Z"), [])
})

// --- gitCommitTaskPaths ------------------------------------------------------------------

test("gitCommitTaskPaths confirms a desk commit and lists what it changed, the root commit included", () => {
  const { gitCommitTaskPaths } = createDeskReaders({ deskRoot: desk })
  assert.deepEqual(gitCommitTaskPaths(shas.first), { exists: true, taskPaths: ["track/live-task/task.md"] })
  assert.deepEqual(gitCommitTaskPaths(shas.fetched), { exists: true, taskPaths: ["track/fetched-task/task.md"] }, "a native ref needs only to exist in the desk")
})

test("gitCommitTaskPaths reports a commit Git confirms but cannot list as changing nothing", () => {
  // A stand-in Git that confirms every commit, finds the desk, and fails every other command.
  const fakeGit = path.join(desk, "..", `${path.basename(desk)}-fake-git.sh`)
  writeFileSync(fakeGit, "#!/bin/sh\nfor arg in \"$@\"; do [ \"$arg\" = cat-file ] && exit 0; [ \"$arg\" = rev-parse ] && exec git \"$@\"; done\nexit 1\n", { mode: 0o755 })
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
  git(["remote", "set-url", "origin", "git@github.com:Owner/Desk.git"])
  try {
    assert.equal(readDeskRemote({ deskRoot: desk }), "git@github.com:Owner/Desk.git")
    git(["remote", "remove", "origin"])
    assert.equal(readDeskRemote({ deskRoot: desk }), null)
  } finally {
    spawnSync("git", ["-C", desk, "remote", "remove", "origin"])
    git(["remote", "add", "origin", origin])
  }
  assert.equal(readDeskRemote({ deskRoot: path.join(os.tmpdir(), "desk-repo-missing-folder") }), null)
})

// --- The real readers drive binding end to end ---------------------------------------------

function bindWith(windows) {
  return bindSession({
    events: { shellGitCommits: windows.map(([start, end]) => ({ start, end, cwd: desk })) },
    deskRoot: desk,
    deskRemote: null,
    personPrefix: "",
    ...createDeskReaders({ deskRoot: desk }),
  }).jobs
}
const id = (slug) => jobId({ deskRemote: `local:${realpathSync(desk)}`, personPrefix: "", track: "track", slug })
const byJob = (a, b) => (a.job < b.job ? -1 : 1)

test("end to end: a session's git commit call in the desk binds the tasks its own commit changed", () => {
  const jobs = bindWith([["2026-09-25T08:20:01.300Z", "2026-09-25T08:20:01.900Z"]])
  assert.deepEqual(jobs.map(({ job, basis, observed }) => ({ job, basis, observed })).sort(byJob), [
    { job: id("live-task"), basis: ["desk_commit"], observed: { status: "processing", at: null } },
    { job: id("old-task"), basis: ["desk_commit"], observed: { status: "done", at: "2026-09-02T10:30:00.000Z" } },
  ].sort(byJob))
})

test("end to end, two clones: a session in this clone never binds the other clone's commit, fetched here during its call", () => {
  // The other clone committed track/fetched-task at 08:40:00 and this clone
  // fetched it at 08:45; a session here had a git commit call spanning both.
  assert.deepEqual(bindWith([["2026-09-25T08:39:59.000Z", "2026-09-25T08:45:05.000Z"]]), [])
})

test("end to end, same clone: two sessions whose git commit calls overlap one commit both bind it (the documented ambiguity)", () => {
  const first = bindWith([["2026-09-25T09:29:58.000Z", "2026-09-25T09:30:01.000Z"]])
  const second = bindWith([["2026-09-25T09:29:59.500Z", "2026-09-25T09:30:03.000Z"]])
  assert.deepEqual(first.map(({ job }) => job), [id("other-task")])
  assert.deepEqual(second.map(({ job }) => job), [id("other-task")])
})
