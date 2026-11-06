// git-stage.js — isGitRepository, hasUnstagedWork, stagePaths, commitPaths.
//
// `commitPaths` is the new primitive every write tool's commit step uses
// (M4-6, "agents never fight the desk" Part 2). It commits exactly the given
// paths, `git commit -- <paths> -m <message>` semantics, never `-a`/`-A`/a
// pattern, so a path staged by another process in the same window is left
// untouched (Review Focus: TOCTOU).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import { unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import {
  isGitRepository,
  hasUnstagedWork,
  stagePaths,
  commitPaths,
  commitBranchRefusal,
  commitIndexPaths,
  indexEntries,
  readBackCommit,
  YIELD_ENV,
} from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { finishCommit } from "../../../../../plugins/desk/mcp/src/util/finish-commit.js"
import { afterLanding, beforeLanding, branchUpdate } from "../_index_commit_seam.js"

async function mkTempRepo() {
  const root = await mkTempRoot("desk-git-stage-test-")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  return root
}

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

function lastCommitMessage(root) {
  return git(root, ["log", "-1", "--format=%s"]).trim()
}

function lastCommitFiles(root) {
  return git(root, ["show", "--stat", "--format=", "--name-only", "HEAD"])
    .split("\n")
    .filter(Boolean)
    .sort()
}

function commitCount(root) {
  return git(root, ["log", "--oneline"]).trim().split("\n").filter(Boolean).length
}

test("isGitRepository is true inside a Git work tree and false otherwise", async () => {
  const root = await mkTempRepo()
  assert.equal(isGitRepository(root, spawnSync), true)

  const plain = await mkTempRoot("desk-git-stage-test-plain-")
  assert.equal(isGitRepository(plain, spawnSync), false)
})

test("isGitRepository fails safe to false when the spawned command throws", async () => {
  const root = await mkTempRepo()
  const throwing = () => { throw new Error("spawn ENOENT") }
  assert.equal(isGitRepository(root, throwing), false)
})

test("a read-only repository observation retries a transient lock with the same bounded command", () => {
  const before = process.env[YIELD_ENV]
  delete process.env[YIELD_ENV]
  try {
    let dispatches = 0
    const found = isGitRepository("/owned-read-probe", (command, args, options) => {
      assert.equal(command, "git")
      assert.deepEqual(args, ["-C", "/owned-read-probe", "rev-parse", "--is-inside-work-tree"])
      assert.deepEqual(options, { windowsHide: true, encoding: "utf8", timeout: 10_000 })
      return ++dispatches === 1
        ? { status: 128, stdout: "", stderr: "fatal: cannot lock ref during owned read" }
        : { status: 0, stdout: "true\n", stderr: "" }
    })
    assert.equal(found, true)
    assert.equal(dispatches, 2)
  } finally {
    if (before === undefined) delete process.env[YIELD_ENV]
    else process.env[YIELD_ENV] = before
  }
})

test("hasUnstagedWork is true for an untracked file and for an unstaged edit, false once committed", async () => {
  const root = await mkTempRepo()
  await fs.writeFile(path.join(root, "a.txt"), "one\n")
  assert.equal(hasUnstagedWork(root, ["a.txt"], spawnSync), true, "untracked file counts as unstaged work")

  git(root, ["add", "--", "a.txt"])
  git(root, ["commit", "-q", "-m", "add a.txt"])
  assert.equal(hasUnstagedWork(root, ["a.txt"], spawnSync), false)

  await fs.writeFile(path.join(root, "a.txt"), "two\n")
  assert.equal(hasUnstagedWork(root, ["a.txt"], spawnSync), true, "an unstaged edit to a tracked file counts")
})

test("hasUnstagedWork fails safe to true when the spawned command fails", async () => {
  const root = await mkTempRepo()
  const failing = () => ({ status: 1, stdout: "", stderr: "boom" })
  assert.equal(hasUnstagedWork(root, ["missing.txt"], failing), true)
})

test("stagePaths adds exactly the given paths, never -a or -A", async () => {
  const root = await mkTempRepo()
  await fs.writeFile(path.join(root, "one.txt"), "1\n")
  await fs.writeFile(path.join(root, "two.txt"), "2\n")
  const result = stagePaths(root, ["one.txt"], spawnSync)
  assert.equal(result.ok, true)
  const staged = git(root, ["diff", "--cached", "--name-only"]).trim()
  assert.equal(staged, "one.txt")
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).trim()
  assert.equal(untracked, "two.txt")
})

test("stagePaths reports failure without throwing when the pathspec matches nothing", async () => {
  const root = await mkTempRepo()
  const result = stagePaths(root, ["does-not-exist.txt"], spawnSync)
  assert.equal(result.ok, false)
  assert.match(result.stderr, /pathspec/)
})

test("commitPaths commits exactly the given paths with the given message, never -a or -A", async () => {
  const root = await mkTempRepo()
  await fs.mkdir(path.join(root, "track"))
  await fs.writeFile(path.join(root, "track", "track.md"), "hello\n")
  await fs.writeFile(path.join(root, "other.txt"), "unrelated\n")
  stagePaths(root, ["other.txt"], spawnSync) // simulates another process's staged, unrelated path
  stagePaths(root, ["track/track.md"], spawnSync)

  const result = commitPaths(root, ["track/track.md"], "track_create: track", spawnSync)
  assert.equal(result.ok, true)
  assert.equal(lastCommitMessage(root), "track_create: track")
  assert.deepEqual(lastCommitFiles(root), ["track/track.md"])

  // Review Focus (TOCTOU): the unrelated path stays staged, not swept in.
  const stillStaged = git(root, ["diff", "--cached", "--name-only"]).trim()
  assert.equal(stillStaged, "other.txt")
  assert.equal(commitCount(root), 1)
})

test("commitPaths reports failure without throwing, and keeps the index unchanged", async () => {
  const root = await mkTempRepo()
  // Nothing staged at all: a commit naming an unstaged pathspec fails ("did
  // not match any file(s) known to git" or "nothing to commit"), and must
  // never create an empty commit.
  const result = commitPaths(root, ["missing.txt"], "message", spawnSync)
  assert.equal(result.ok, false)
  assert.equal(typeof result.stderr, "string")
  const log = spawnSync("git", ["-C", root, "log", "--oneline"], { encoding: "utf8" })
  assert.notEqual(log.status, 0, "no commit exists yet in this fresh repo")
})

// A hung git hook or a lock held past the bound must never block a tool call
// indefinitely (independent review, fix round). `spawnSync`'s own `timeout`
// option kills the child and returns `{ status: null, error: { code:
// "ETIMEDOUT" } }` rather than throwing — these mock that exact shape.
function etimedoutResult() {
  return {
    status: null,
    signal: "SIGTERM",
    stdout: "",
    stderr: "",
    error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }),
  }
}

test("every git call is bounded by a ~10s timeout so a hung hook or lock can never block indefinitely", async () => {
  const root = await mkTempRepo()
  let capturedOptions
  const spy = (cmd, args, opts) => {
    capturedOptions = opts
    return spawnSync(cmd, args, opts)
  }
  stagePaths(root, ["does-not-exist.txt"], spy)
  assert.equal(capturedOptions.timeout, 10_000)
})

test("stagePaths reports { ok: false, stderr: \"timeout\" } when the git call times out, without throwing", async () => {
  const root = await mkTempRepo()
  const result = stagePaths(root, ["a.txt"], etimedoutResult)
  assert.deepEqual(result, { ok: false, stderr: "timeout" })
})

test("commitPaths reports { ok: false, stderr: \"timeout\" } when the git call times out, without throwing, and cannot tell whether it landed when every read-back times out too", async () => {
  const root = await mkTempRepo()
  const result = commitPaths(root, ["a.txt"], "message", etimedoutResult)
  assert.deepEqual(result, { ok: false, stderr: "timeout", readback: "unknown" })
})

// Desk stages and commits only where it is meant to. A detached HEAD is always refused. With a configured state branch the checkout must be on it; with none configured it must be on the branch origin/HEAD names when the remote has one, and any named branch will do otherwise. A caller that was not told (undefined) gets only the detached-HEAD rule.
async function repoWithChange(branch = "main") {
  const root = await mkTempRepo()
  git(root, ["switch", "-q", "-c", branch])
  await fs.writeFile(path.join(root, "a.txt"), "one\n")
  git(root, ["add", "--", "a.txt"])
  git(root, ["commit", "-q", "-m", "first"])
  await fs.writeFile(path.join(root, "a.txt"), "two\n")
  return root
}

const originHead = (root, name) => {
  git(root, ["update-ref", `refs/remotes/origin/${name}`, "HEAD"])
  git(root, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${name}`])
}

test("with no remote default and no state branch, any named branch is allowed, master and feature included", async () => {
  for (const branch of ["master", "feature"]) {
    const root = await repoWithChange(branch)
    assert.equal(stagePaths(root, ["a.txt"], spawnSync, null).ok, true, branch)
    assert.equal(commitPaths(root, ["a.txt"], `on ${branch}`, spawnSync, null).ok, true, branch)
    assert.equal(lastCommitMessage(root), `on ${branch}`)
  }
})

test("a detached HEAD is refused by stage and commit whatever the caller knows, and nothing is staged", async () => {
  const root = await repoWithChange()
  git(root, ["switch", "-q", "--detach"])
  for (const known of [undefined, null, "main"]) {
    const staged = stagePaths(root, ["a.txt"], spawnSync, known)
    assert.equal(staged.ok, false)
    assert.match(staged.stderr, /detached HEAD/u)
    assert.equal(commitPaths(root, ["a.txt"], "detached", spawnSync, known).ok, false)
  }
  assert.equal(git(root, ["diff", "--cached", "--name-only"]).trim(), "")
  assert.equal(commitCount(root), 1)
})

test("with the remote's default branch known, staging and committing off it are refused and name both branches", async () => {
  const root = await repoWithChange("trunk")
  originHead(root, "trunk")
  git(root, ["switch", "-q", "-c", "feature"])
  const staged = stagePaths(root, ["a.txt"], spawnSync, null)
  assert.equal(staged.ok, false)
  assert.match(staged.stderr, /on branch `feature`/u)
  assert.match(staged.stderr, /only on `trunk`/u)
  assert.equal(commitPaths(root, ["a.txt"], "off", spawnSync, null).ok, false)
  assert.equal(git(root, ["diff", "--cached", "--name-only"]).trim(), "")
  git(root, ["switch", "-q", "trunk"])
  assert.equal(stagePaths(root, ["a.txt"], spawnSync, null).ok, true)
  assert.equal(commitPaths(root, ["a.txt"], "on trunk", spawnSync, null).ok, true)
})

test("a configured state branch is the one branch Desk writes on, whatever the remote's default is", async () => {
  const root = await repoWithChange("main")
  originHead(root, "main")
  const wrong = stagePaths(root, ["a.txt"], spawnSync, "desk-state")
  assert.equal(wrong.ok, false)
  assert.match(wrong.stderr, /on branch `main`/u)
  assert.match(wrong.stderr, /only on `desk-state`/u)
  git(root, ["add", "--", "a.txt"])
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  assert.equal(commitIndexPaths(root, ["a.txt"], entries, "wrong", spawnSync, "desk-state").ok, false)
  assert.equal(commitPaths(root, ["a.txt"], "wrong", spawnSync, "desk-state").ok, false)
  git(root, ["switch", "-q", "-c", "desk-state"])
  assert.equal(stagePaths(root, ["a.txt"], spawnSync, "desk-state").ok, true)
  assert.equal(commitPaths(root, ["a.txt"], "on state", spawnSync, "desk-state").ok, true)
  assert.equal(commitCount(root), 2)
})

test("a caller that was not told is only held to the detached-HEAD rule", async () => {
  const root = await repoWithChange("feature")
  originHead(root, "trunk")
  assert.equal(stagePaths(root, ["a.txt"], spawnSync).ok, true)
  assert.equal(commitPaths(root, ["a.txt"], "untold", spawnSync).ok, true)
})

test("a Git that cannot answer the branch question, or answers with no output, is not mistaken for a wrong branch", async () => {
  const root = await repoWithChange()
  assert.equal(commitBranchRefusal(root, () => null, null), null)
  assert.equal(commitBranchRefusal(root, () => ({ status: 128, stdout: "", stderr: "fatal" }), null), null)
  assert.match(commitBranchRefusal(root, () => ({ status: 0, stdout: null }), null), /detached HEAD/u)
})

for (const indexed of [false, true]) test(`a ${indexed ? "temporary-index" : "path"} commit with a lock-shaped failure is dispatched only once`, async t => {
  const root = await mkTempRepo()
  t.diagnostic(`Owned fixture: ${root}; removed by the exact-root registry at file teardown.`)
  await fs.writeFile(path.join(root, "a.txt"), "one\n")
  git(root, ["add", "a.txt"])
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  let dispatches = 0
  // The temporary-index commit's lock-shaped failure comes after the commit landed: its post-commit step (#632).
  const landing = indexed ? afterLanding : (args) => args[2] === "commit"
  const spawn = (command, args, options) => {
    if (!landing(args)) return spawnSync(command, args, options)
    dispatches++
    if (dispatches === 1) {
      const applied = spawnSync(command, args, options)
      assert.equal(applied.status, 0, applied.stderr)
    }
    return { status: 1, stdout: "", stderr: "cannot lock ref after hook" }
  }
  const result = indexed
    ? commitIndexPaths(root, ["a.txt"], entries, "save", spawn)
    : commitPaths(root, ["a.txt"], "save", spawn)
  // The failed dispatch had landed, so the read-back (never a second dispatch) reports it committed (#561).
  assert.equal(result.ok, true)
  assert.equal(result.readback, "committed")
  assert.equal(dispatches, 1)
  assert.equal(commitCount(root), 1)
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "one\n")
})

test("a stage response with a lock-shaped failure is dispatched only once", async t => {
  const root = await mkTempRepo()
  t.diagnostic(`Owned fixture: ${root}; removed by the exact-root registry at file teardown.`)
  await fs.writeFile(path.join(root, "a.txt"), "one\n")
  let dispatches = 0
  const result = stagePaths(root, ["a.txt"], (command, args, options) => {
    const actual = spawnSync(command, args, options)
    if (args[2] !== "add") return actual
    dispatches++
    assert.equal(actual.status, 0, actual.stderr)
    return { status: 128, stdout: "", stderr: "fatal: Unable to create 'owned.lock': File exists" }
  })
  assert.equal(result.ok, false)
  assert.equal(dispatches, 1)
  assert.equal(git(root, ["show", ":a.txt"]), "one\n")
})

test("staging waits for an observed index lock before its single mutation dispatch", async t => {
  const root = await mkTempRepo()
  t.diagnostic(`Owned fixture: ${root}; removed by the exact-root registry at file teardown.`)
  await fs.writeFile(path.join(root, "a.txt"), "one\n")
  const lock = path.join(root, ".git", "index.lock")
  await fs.writeFile(lock, "")
  let probes = 0, stages = 0
  const result = stagePaths(root, ["a.txt"], (command, args, options) => {
    if (args.includes("--git-path") && ++probes === 3) unlinkSync(lock)
    if (args[2] === "add") stages++
    return spawnSync(command, args, options)
  })
  assert.equal(result.ok, true)
  assert.equal(probes, 3)
  assert.equal(stages, 1)
  assert.equal(git(root, ["show", ":a.txt"]), "one\n")
})

// #561: a commit can land and still come back as a failure, most often because a post-commit hook (Git LFS, say) ran past the bound and the commit
// was killed after it had already written. A failed commit call is read back once, never redispatched: the commit is `committed` when a new commit on
// HEAD holds exactly this call's message, only these paths and the content this call meant to commit; `absent` when HEAD shows no new commit to them;
// and `unknown` otherwise. Only the read-back reads Git again.
const isCommit = (args) => args[2] === "commit"
const landedThenTimedOut = (counter, landing = isCommit) => (command, args, options) => {
  const actual = spawnSync(command, args, options)
  if (!landing(args)) return actual
  counter.commits++
  assert.equal(actual.status, 0, actual.stderr)
  return etimedoutResult()
}
const neverRanThenTimedOut = (counter, dispatch = isCommit) => (command, args, options) => {
  if (!dispatch(args)) return spawnSync(command, args, options)
  counter.commits++
  return etimedoutResult()
}


// A failure carries the change captured before dispatch (R2, R3): the HEAD and branch it was made on and the staged entries at
// exactly its paths, so a route can finish that change and never whatever the paths hold later.
function withoutCapture(root, result) {
  const { capture, ...rest } = result
  assert.deepEqual(capture, {
    before: git(root, ["rev-list", "--max-parents=0", "HEAD"]).trim(),
    branch: git(root, ["symbolic-ref", "--short", "HEAD"]).trim(),
    expected: [`100644 ${git(root, ["hash-object", "a.txt"]).trim()}\ta.txt`],
  })
  return rest
}

for (const indexed of [false, true]) {
  const kind = indexed ? "temporary-index" : "path"
  const commit = (root, spawn, message = "save") => {
    const entries = indexEntries(root, ["a.txt"], spawnSync)
    return indexed ? commitIndexPaths(root, ["a.txt"], entries, message, spawn) : commitPaths(root, ["a.txt"], message, spawn)
  }
  const staged = async (root) => {
    await fs.writeFile(path.join(root, "a.txt"), "two\n")
    git(root, ["add", "--", "a.txt"])
  }
  // The path commit is one `git commit`. The temporary-index commit (#632) is hooks, `git commit-tree` and one compare-and-swap
  // `git update-ref`: a cut-off before it lands is its pre-commit step's, after it lands its post-commit step's, a race its branch
  // update's; and its failures say which step and why, where the path commit says `timeout` or Git's own words.
  const before = indexed ? beforeLanding : isCommit
  const landing = indexed ? afterLanding : isCommit
  const racing = indexed ? branchUpdate : isCommit
  const said = (result, words, pattern) => {
    const { stderr, ...rest } = result
    if (indexed) assert.match(stderr, pattern)
    else assert.equal(stderr, words)
    return rest
  }

  test(`a ${kind} commit that lands but times out is read back as committed, dispatched once`, async () => {
    const root = await repoWithChange()
    await staged(root)
    const counter = { commits: 0 }
    const result = commit(root, landedThenTimedOut(counter, landing))
    assert.equal(result.ok, true)
    assert.equal(result.readback, "committed")
    assert.equal(counter.commits, 1)
    assert.equal(commitCount(root), 2)
    assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
  })

  test(`a ${kind} commit that times out before it lands is read back as absent, dispatched once`, async () => {
    const root = await repoWithChange()
    await staged(root)
    const counter = { commits: 0 }
    const result = commit(root, neverRanThenTimedOut(counter, before))
    assert.deepEqual(said(withoutCapture(root, result), "timeout", /pre-commit hook was cut off/u), { ok: false, readback: "absent" })
    assert.equal(counter.commits, 1)
    assert.equal(commitCount(root), 1)
  })

  test(`a ${kind} commit whose new commit on these paths is not this call's is read back as unknown, never committed`, async () => {
    const root = await repoWithChange()
    await staged(root)
    const counter = { commits: 0 }
    const spawn = (command, args, options) => {
      if (!racing(args)) return spawnSync(command, args, options)
      counter.commits++
      git(root, ["commit", "-q", "-m", "someone else", "--", "a.txt"])
      return etimedoutResult()
    }
    const result = commit(root, spawn)
    assert.deepEqual(said(withoutCapture(root, result), "timeout", /branch update was cut off/u), { ok: false, readback: "unknown" })
    assert.equal(counter.commits, 1)
  })

  test(`a ${kind} commit is read back as unknown when Git cannot answer the read-back, and never redispatched`, async () => {
    const root = await repoWithChange()
    await staged(root)
    const counter = { commits: 0 }
    let broken = false
    const spawn = (command, args, options) => {
      if (broken) return etimedoutResult()
      if (!racing(args)) return spawnSync(command, args, options)
      counter.commits++
      broken = true
      return etimedoutResult()
    }
    const result = commit(root, spawn)
    assert.deepEqual(said(withoutCapture(root, result), "timeout", /branch update was cut off/u), { ok: false, readback: "unknown" })
    assert.equal(counter.commits, 1)
  })

  // R4 (0972 on #625): "it happened" and "it is in effect now" are separate proofs. A commit of ours that a later commit overwrote before the
  // read-back is not completion, and nothing is replayed.
  test(`a ${kind} commit that lands but is overwritten before the read-back is unknown, never committed or replayed`, async () => {
    const root = await repoWithChange()
    await staged(root)
    const counter = { commits: 0 }
    const spawn = (command, args, options) => {
      const actual = spawnSync(command, args, options)
      if (!landing(args)) return actual
      counter.commits++
      assert.equal(actual.status, 0, actual.stderr)
      writeFileSync(path.join(root, "a.txt"), "someone else\n")
      git(root, ["commit", "-q", "-m", "someone else", "--", "a.txt"])
      return etimedoutResult()
    }
    const result = commit(root, spawn)
    assert.equal(result.ok, false)
    assert.equal(said(result, "timeout", /post-commit hook/u).readback, "unknown")
    assert.equal(result.landed.head, git(root, ["rev-parse", "HEAD"]).trim())
    assert.equal(git(root, ["log", "-1", "--format=%s", result.landed.commit]).trim(), "save")
    assert.equal(counter.commits, 1)
  })

  test(`a ${kind} commit Git refused with an error is read back as absent`, async () => {
    const root = await repoWithChange()
    await staged(root)
    const spawn = (command, args, options) => (before(args) ? { status: 1, stdout: "", stderr: "hook said no" } : spawnSync(command, args, options))
    assert.deepEqual(said(withoutCapture(root, commit(root, spawn)), "hook said no", /pre-commit hook refused the commit: hook said no/u), { ok: false, readback: "absent" })
  })
}

test("a path commit from a subfolder that lands but times out is read back as committed", async () => {
  const root = await repoWithChange()
  await fs.mkdir(path.join(root, "desks", "me"), { recursive: true })
  await fs.writeFile(path.join(root, "desks", "me", "AGENTS.md"), "rule\n")
  const dir = path.join(root, "desks", "me")
  git(dir, ["add", "--", "AGENTS.md"])
  const counter = { commits: 0 }
  const result = commitPaths(dir, ["AGENTS.md"], "lesson_add: personal rule", landedThenTimedOut(counter))
  assert.equal(result.ok, true)
  assert.equal(result.readback, "committed")
  assert.equal(counter.commits, 1)
})

// R4 (0972 on #625): what a path commit meant is captured before it is dispatched, never rebuilt from the working tree afterwards. A later edit
// to the working tree is someone's change after ours, not evidence about ours; a commit that landed with other bytes than the captured ones is not ours.
test("a path commit that lands as captured is committed even when the working tree changes before the read-back", async () => {
  const root = await repoWithChange()
  await fs.writeFile(path.join(root, "a.txt"), "two\n")
  git(root, ["add", "--", "a.txt"])
  const spawn = (command, args, options) => {
    const actual = spawnSync(command, args, options)
    if (args[2] !== "commit") return actual
    unlinkSync(path.join(root, "a.txt"))
    return etimedoutResult()
  }
  const result = commitPaths(root, ["a.txt"], "save", spawn)
  assert.equal(result.ok, true)
  assert.equal(result.readback, "committed")
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
})

test("a path commit that lands with bytes other than the ones captured before dispatch is unknown, even when the working tree now matches them", async () => {
  const root = await repoWithChange()
  await fs.writeFile(path.join(root, "a.txt"), "two\n")
  git(root, ["add", "--", "a.txt"])
  let commits = 0
  const spawn = (command, args, options) => {
    if (args[2] !== "commit") return spawnSync(command, args, options)
    commits++
    writeFileSync(path.join(root, "a.txt"), "rewritten by a hook\n")
    const actual = spawnSync(command, args, options)
    assert.equal(actual.status, 0, actual.stderr)
    return etimedoutResult()
  }
  const result = commitPaths(root, ["a.txt"], "save", spawn)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.equal(commits, 1)
})

test("a real post-commit hook that outlasts the bound: the commit lands, Git is killed, and the read-back says committed", { skip: process.platform === "win32" ? "a POSIX sleep hook" : false }, async t => {
  const root = await repoWithChange()
  t.diagnostic(`Owned fixture: ${root}; removed by the exact-root registry at file teardown.`)
  const hooks = git(root, ["rev-parse", "--git-path", "hooks"]).trim()
  const hook = path.resolve(root, hooks, "post-commit")
  await fs.mkdir(path.dirname(hook), { recursive: true })
  await fs.writeFile(hook, "#!/bin/sh\nsleep 3\n", { mode: 0o755 })
  await fs.writeFile(path.join(root, "a.txt"), "two\n")
  git(root, ["add", "--", "a.txt"])
  let killed = null
  const shortBound = (command, args, options) => {
    const result = spawnSync(command, args, args[2] === "commit" ? { ...options, timeout: 1000 } : options)
    if (args[2] === "commit") killed = result.error?.code ?? null
    return result
  }
  const result = commitPaths(root, ["a.txt"], "save", shortBound)
  assert.equal(killed, "ETIMEDOUT")
  assert.equal(result.ok, true)
  assert.equal(result.readback, "committed")
  assert.equal(git(root, ["log", "-1", "--format=%s"]).trim(), "save")
})

// readBackCommit answers only what Git proves: every read it cannot make is `unknown`, a HEAD that moved without touching these paths is
// `absent`, and nothing it reads is taken as this call's commit unless the commit, its message, its paths and its entries all match.
async function landedSave(root) {
  const before = git(root, ["rev-parse", "HEAD"]).trim()
  await fs.writeFile(path.join(root, "a.txt"), "two\n")
  git(root, ["commit", "-q", "-m", "save", "--", "a.txt"])
  const expected = [`100644 ${git(root, ["rev-parse", "HEAD:a.txt"]).trim()}\ta.txt`]
  return { before, expected }
}
const failing = (verb, when = () => true) => (command, args, options) =>
  (args[2] === verb && when(args) ? { status: 1, stdout: "", stderr: `${verb} failed` } : spawnSync(command, args, options))

test("readBackCommit: a HEAD that moved only by commits to other paths is absent", async () => {
  const root = await repoWithChange()
  const before = git(root, ["rev-parse", "HEAD"]).trim()
  await fs.writeFile(path.join(root, "b.txt"), "theirs\n")
  git(root, ["add", "b.txt"])
  git(root, ["commit", "-q", "-m", "theirs"])
  assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, [], spawnSync), { readback: "absent" })
})

test("readBackCommit: a commit to these paths with nothing captured to compare it with is unknown", async () => {
  const root = await repoWithChange()
  const { before } = await landedSave(root)
  assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, null, spawnSync), { readback: "unknown" })
})

test("readBackCommit: more new commits than it reads is unknown, never a guess from the newest few", async () => {
  const root = await repoWithChange()
  const { before, expected } = await landedSave(root)
  for (let i = 0; i < 50; i++) git(root, ["commit", "-q", "--allow-empty", "-m", `later ${i}`])
  assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, expected, spawnSync), { readback: "unknown" })
})

test("readBackCommit: an unborn HEAD after a born one, or a HEAD read with no output, is unknown", async () => {
  const root = await repoWithChange()
  const before = git(root, ["rev-parse", "HEAD"]).trim()
  const silentUnborn = (command, args, options) => (args[2] === "rev-parse" ? { status: 1 } : spawnSync(command, args, options))
  assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, [], silentUnborn), { readback: "unknown" })
})

test("readBackCommit: each read Git cannot make is unknown, never absent or committed", async () => {
  const root = await repoWithChange()
  const { before, expected } = await landedSave(root)
  const ours = git(root, ["rev-parse", "HEAD"]).trim()
  assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, expected, spawnSync), { readback: "committed" }, "the reads that work prove it")
  for (const [verb, when] of [["rev-list"], ["diff-tree"], ["log"], ["ls-tree"]])
    assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, expected, failing(verb, when)), { readback: "unknown" }, verb)
  // Ours is not the newest commit: HEAD's own entries are read apart, and a failure there is unknown too.
  git(root, ["commit", "-q", "--allow-empty", "-m", "later"])
  const after = git(root, ["rev-parse", "HEAD"]).trim()
  assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, expected, spawnSync), { readback: "committed" })
  assert.deepEqual(readBackCommit(root, ["a.txt"], "save", before, expected, failing("ls-tree", (args) => args.includes(after))), { readback: "unknown" })
  assert.notEqual(ours, after)
})

test("a commit whose branch read comes back empty carries no capture, so its route can never commit", async () => {
  const root = await repoWithChange()
  git(root, ["add", "--", "a.txt"])
  let branchReads = 0
  const spawn = (command, args, options) => {
    if (args[2] === "symbolic-ref" && args.includes("HEAD") && ++branchReads === 2) return { status: 0 }
    if (args[2] === "commit") return { status: 1, stdout: "", stderr: "hook said no" }
    return spawnSync(command, args, options)
  }
  const result = commitPaths(root, ["a.txt"], "save", spawn)
  assert.deepEqual(result, { ok: false, stderr: "hook said no", readback: "absent" })
  assert.equal(branchReads, 2, "the refusal check and the branch read")
})

test("a path commit whose working tree differs from the index carries no capture: the commit would take bytes no read hashed", async () => {
  const root = await repoWithChange()
  git(root, ["add", "--", "a.txt"])
  await fs.writeFile(path.join(root, "a.txt"), "three\n")
  const result = commitPaths(root, ["a.txt"], "save", (command, args, options) => (args[2] === "commit" ? { status: 1, stdout: "", stderr: "hook said no" } : spawnSync(command, args, options)))
  assert.deepEqual(result, { ok: false, stderr: "hook said no", readback: "absent" })
})

// #632: the normal temporary-index commit publishes only against the HEAD it qualified. It used to seed a private index from HEAD and then run a
// plain `git commit`, which takes whatever HEAD is when it starts as the parent: another writer's commit landing in between was silently undone
// by a tree built before it. Now the commit is made on exactly the HEAD it read and moves the branch by one compare-and-swap, so the other
// writer's commit stands, nothing of this call's is committed, and the call carries its capture for the route to finish later.
const headOf632 = (root) => git(root, ["rev-parse", "HEAD"]).trim()
const branchOf632 = (root) => git(root, ["symbolic-ref", "--short", "HEAD"]).trim()

async function stagedChange() {
  const root = await repoWithChange()
  git(root, ["add", "--", "a.txt"])
  await fs.writeFile(path.join(root, "b.txt"), "someone's staged selection\n")
  git(root, ["add", "--", "b.txt"])
  return root
}

function foreignCommit(root) {
  writeFileSync(path.join(root, "foreign.txt"), "theirs\n")
  git(root, ["add", "--", "foreign.txt"])
  git(root, ["commit", "-q", "-m", "another writer", "--", "foreign.txt"])
  return headOf632(root)
}

// A real commit by another writer, made once, at the first Git call `when` picks.
function raceAt(when) {
  let theirs = null
  let seeded = false
  const spawn = (command, args, options) => {
    const verb = args.slice(2)
    if (theirs === null && when(verb, seeded)) theirs = foreignCommit(args[1])
    if (verb[0] === "update-index" && verb.includes("--index-info")) seeded = true
    return spawnSync(command, args, options)
  }
  return { spawn, theirs: () => theirs }
}

const publishing = (verb) => verb[0] === "commit" || verb[0] === "update-ref"
const afterSeeding = (verb, seeded) => seeded

for (const [label, when] of [["after the private index is built", afterSeeding], ["at the call that would publish the commit", publishing]]) {
  test(`#632: another writer's commit ${label} stands: nothing is committed over it, and the call carries its capture`, async () => {
    const root = await stagedChange()
    const before = headOf632(root)
    const entries = indexEntries(root, ["a.txt"], spawnSync)
    const race = raceAt(when)
    const result = commitIndexPaths(root, ["a.txt"], entries, "save", race.spawn)
    const theirs = race.theirs()
    assert.ok(theirs, "the other writer committed")
    assert.equal(headOf632(root), theirs, "HEAD is the other writer's commit")
    assert.equal(git(root, ["show", "HEAD:foreign.txt"]), "theirs\n", "their commit is not undone")
    assert.equal(git(root, ["show", "HEAD:a.txt"]), "one\n", "nothing of this call's is committed")
    assert.equal(result.ok, false)
    assert.equal(result.readback, "absent")
    assert.deepEqual(result.capture, { before, branch: branchOf632(root), expected: [`100644 ${git(root, ["rev-parse", ":a.txt"]).trim()}\ta.txt`] })
    assert.deepEqual(git(root, ["diff", "--cached", "--name-only"]).trim().split("\n"), ["a.txt", "b.txt"], "the shared index and its staged selection are as they were")
  })
}

test("#632: a HEAD that moves before the private index is seeded is not committed on: the capture names the HEAD that was read", async () => {
  const root = await stagedChange()
  const before = headOf632(root)
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const race = raceAt((verb) => verb[0] === "read-tree")
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", race.spawn)
  assert.equal(headOf632(root), race.theirs())
  assert.equal(git(root, ["show", "HEAD:foreign.txt"]), "theirs\n")
  assert.deepEqual([result.ok, result.readback, result.capture?.before], [false, "absent", before])
})

test("#632: the refused commit's capture finishes later on top of the other writer's commit, which stands", async () => {
  const root = await stagedChange()
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const race = raceAt(publishing)
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", race.spawn)
  const { before, branch, expected } = result.capture
  const finished = finishCommit({ root, paths: ["a.txt"], expected, before, branch, message: "save", commit: true, env: {} })
  assert.equal(finished.state, "finished", finished.reason)
  assert.equal(git(root, ["rev-parse", "HEAD^"]).trim(), race.theirs())
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
  assert.equal(git(root, ["show", "HEAD:foreign.txt"]), "theirs\n")
})

// What the commit holds is exactly the selected entries, as the index holds them, and HEAD's own entries everywhere else; the shared index is untouched.
const treeLine = (entry, at = entry.path) => `${entry.mode} blob ${entry.sha}\t${at}\n`

test("#632: a desk in a subfolder of the repository commits its paths there, not at the repository's top", async () => {
  const top = await mkTempRepo()
  const desk = path.join(top, "desk")
  await fs.mkdir(desk)
  await fs.writeFile(path.join(desk, "a.txt"), "one\n")
  await fs.writeFile(path.join(top, "top.txt"), "top\n")
  git(top, ["add", "--", "desk/a.txt", "top.txt"])
  git(top, ["commit", "-q", "-m", "first"])
  const outside = git(top, ["ls-tree", "HEAD", "--", "top.txt"])
  await fs.writeFile(path.join(desk, "a.txt"), "two\n")
  git(desk, ["add", "--", "a.txt"])
  await fs.writeFile(path.join(desk, "b.txt"), "someone's staged selection\n")
  git(desk, ["add", "--", "b.txt"])
  const index = git(top, ["ls-files", "-s"])
  const entries = indexEntries(desk, ["a.txt"], spawnSync)
  const result = commitIndexPaths(desk, ["a.txt"], entries, "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.equal(git(top, ["show", "HEAD:desk/a.txt"]), "two\n")
  assert.equal(git(top, ["ls-tree", "-r", "HEAD"]), `${treeLine(entries[0], "desk/a.txt")}${outside}`, "the selected entry lands under the desk with its mode and blob; nothing lands at the repository's top")
  assert.equal(git(top, ["ls-files", "-s"]), index, "the shared index is as it was")
  assert.deepEqual(git(top, ["diff", "--cached", "--name-only"]).trim().split("\n"), ["desk/b.txt"], "the other staged selection stays staged and uncommitted")
})

async function docsChange(change) {
  const root = await mkTempRepo()
  await fs.mkdir(path.join(root, "docs"))
  await fs.writeFile(path.join(root, "docs", "keep.txt"), "keep\n")
  await fs.writeFile(path.join(root, "docs", "old.txt"), "old\n")
  await fs.writeFile(path.join(root, "out.txt"), "outside\n")
  git(root, ["add", "--", "docs", "out.txt"])
  git(root, ["commit", "-q", "-m", "first"])
  await fs.writeFile(path.join(root, "docs", "keep.txt"), "kept and edited\n")
  git(root, ["add", "--", "docs/keep.txt"])
  change(root)
  await fs.writeFile(path.join(root, "staged.txt"), "someone's staged selection\n")
  git(root, ["add", "--", "staged.txt"])
  return root
}

for (const [label, change, leaves] of [
  ["a deleted file", (root) => git(root, ["rm", "-q", "--", "docs/old.txt"]), ["docs/keep.txt"]],
  ["a renamed file", (root) => git(root, ["mv", "docs/old.txt", "docs/new.txt"]), ["docs/keep.txt", "docs/new.txt"]],
]) {
  test(`#632: a folder path with ${label} is committed as the index holds it: no leaf HEAD held under it survives`, async () => {
    const root = await docsChange(change)
    const outside = git(root, ["ls-tree", "HEAD", "--", "out.txt"])
    const index = git(root, ["ls-files", "-s"])
    const entries = indexEntries(root, ["docs"], spawnSync)
    assert.deepEqual(entries.map((entry) => entry.path), leaves)
    const result = commitIndexPaths(root, ["docs"], entries, "save", spawnSync)
    assert.equal(result.ok, true, result.stderr)
    assert.deepEqual(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n"), [...leaves, "out.txt"])
    assert.equal(git(root, ["ls-tree", "-r", "HEAD"]), `${entries.map((entry) => treeLine(entry)).join("")}${outside}`, "each selected leaf with its mode and blob, and HEAD's entry outside the folder")
    assert.equal(git(root, ["ls-files", "-s"]), index, "the shared index is as it was")
    assert.deepEqual(git(root, ["diff", "--cached", "--name-only"]).trim().split("\n"), ["staged.txt"], "the other staged selection stays staged and uncommitted")
  })
}

test("#632 (behaviour change): a commit while a merge is in progress is refused: nothing is committed, and the merge is left as it was", async () => {
  const root = await repoWithChange()
  const main = branchOf632(root)
  git(root, ["switch", "-q", "-c", "other"])
  await fs.writeFile(path.join(root, "o.txt"), "other\n")
  git(root, ["add", "--", "o.txt"])
  git(root, ["commit", "-q", "-m", "other"])
  git(root, ["switch", "-q", main])
  await fs.writeFile(path.join(root, "m.txt"), "main\n")
  git(root, ["add", "--", "m.txt"])
  git(root, ["commit", "-q", "-m", "main"])
  git(root, ["merge", "-q", "--no-commit", "--no-ff", "other"])
  git(root, ["add", "--", "a.txt"])
  const before = headOf632(root)
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.deepEqual([result.ok, result.readback], [false, "absent"])
  assert.match(result.stderr, /merge is in progress/u)
  assert.equal(headOf632(root), before)
  assert.equal(spawnSync("git", ["-C", root, "rev-parse", "-q", "--verify", "MERGE_HEAD"]).status, 0, "MERGE_HEAD is still there")
})

const cutOff = () => ({ status: null, signal: "SIGTERM", stdout: "", stderr: "", error: Object.assign(new Error("spawnSync git ETIMEDOUT"), { code: "ETIMEDOUT" }) })

test("#632: a branch update cut off before it moved the branch is unknown, never absent: the commit was made and its dispatch is uncertain", async () => {
  const root = await stagedChange()
  const before = headOf632(root)
  let updates = 0
  const spawn = (command, args, options) => (args[2] === "update-ref" ? (updates++, cutOff()) : spawnSync(command, args, options))
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawn)
  assert.equal(updates, 1, "dispatched once, never repeated")
  assert.equal(headOf632(root), before)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
})

// One 10 s budget for the whole commit, not 10 s for each step: three hooks of 4 s each outlast it, and the third is given only what is left.
// Time is Date's mock, advanced by the stand-in hooks; every other Git call is real.
function budgetedHooks(t, seconds) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const seen = []
  const spawn = (command, args, options) => {
    const verb = args.slice(2)
    if (verb[0] === "hook" && ["pre-commit", "prepare-commit-msg", "commit-msg"].includes(verb[3])) {
      seen.push({ hook: verb[3], timeout: options.timeout })
      if (options.timeout < seconds * 1000) {
        t.mock.timers.tick(options.timeout)
        return cutOff()
      }
      t.mock.timers.tick(seconds * 1000)
    }
    return spawnSync(command, args, options)
  }
  return { spawn, seen }
}

test("#632: hooks that together outlast the one 10 s budget are cut off at what is left, and nothing is committed", async (t) => {
  const root = await stagedChange()
  const before = headOf632(root)
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const { spawn, seen } = budgetedHooks(t, 4)
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", spawn)
  assert.deepEqual(seen.map((s) => s.hook), ["pre-commit", "prepare-commit-msg", "commit-msg"])
  assert.ok(seen[2].timeout <= 2000, `the third hook is given only what is left (${seen[2].timeout} ms)`)
  assert.equal(result.ok, false)
  assert.equal(headOf632(root), before)
})

test("#632: hooks that together stay inside the one 10 s budget commit", async (t) => {
  const root = await stagedChange()
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const { spawn, seen } = budgetedHooks(t, 3)
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", spawn)
  assert.equal(seen.length, 3)
  assert.equal(result.ok, true, result.stderr)
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
})

// The one 10 s budget is the whole commit's: the reads after the branch update and the read-back after a failure are inside it too. One step
// spends the rest of the budget ("ran": it runs for real and the clock moves to the end; "cut": it is cut off at the end). The double records
// every call that reaches Git and whether it was given time past the end. No call may be, the branch is moved at most once, and an answer the
// budget left unread is unknown, never absent or committed.
function spendsTheBudget(t, spends) {
  t.mock.timers.enable({ apis: ["Date"], now: Date.now() })
  const end = Date.now() + 10_000
  const calls = []
  const toEnd = () => t.mock.timers.tick(Math.max(0, end - Date.now()))
  const spawn = (command, args, options) => {
    const verb = args.slice(2)
    calls.push({ verb: verb.join(" "), past: Date.now() + options.timeout > end })
    const how = spends(verb)
    if (how === "cut") {
      toEnd()
      return cutOff()
    }
    const answer = spawnSync(command, args, options)
    if (how === "ran") toEnd()
    return answer
  }
  const past = () => calls.filter((call) => call.past).map((call) => call.verb)
  const dispatched = (start) => calls.filter((call) => call.verb.startsWith(start)).length
  return { spawn, past, dispatched }
}
const hookNamed = (name) => (verb) => verb[0] === "hook" && verb.at(-1) === name

test("#632: a post-commit hook that spends the rest of the budget: HEAD is not read past the budget, and the commit is unknown, never committed", async (t) => {
  const root = await stagedChange()
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const budget = spendsTheBudget(t, (verb) => (hookNamed("post-commit")(verb) ? "ran" : null))
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", budget.spawn)
  assert.deepEqual(budget.past(), [], "no Git call is given time past the one budget")
  assert.equal(budget.dispatched("update-ref"), 1)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.match(result.stderr, /time budget ran out/u)
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n", "the commit stands; only reading it back was left undone")
})

test("#632: a branch update that spends the rest of the budget is dispatched once and is unknown: nothing is read and no hook is run past the budget", async (t) => {
  const root = await stagedChange()
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const budget = spendsTheBudget(t, (verb) => (verb[0] === "update-ref" ? "ran" : null))
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", budget.spawn)
  assert.deepEqual(budget.past(), [], "no Git call is given time past the one budget")
  assert.equal(budget.dispatched("update-ref"), 1)
  assert.equal(budget.dispatched("hook run --ignore-missing post-commit"), 0, "the post-commit hook is not run once the budget has ended")
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.match(result.stderr, /could not be read back inside the commit's time budget/u)
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
})

test("#632: a branch read that spends the rest of the budget after the branch moved: the post-commit hook is not run, and the commit is unknown", async (t) => {
  const root = await stagedChange()
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const budget = spendsTheBudget(t, (verb) => (verb[0] === "rev-parse" && verb.at(-1) === "refs/heads/main" ? "ran" : null))
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", budget.spawn)
  assert.deepEqual(budget.past(), [], "no Git call is given time past the one budget")
  assert.equal(budget.dispatched("update-ref"), 1)
  assert.equal(budget.dispatched("hook run --ignore-missing post-commit"), 0)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.match(result.stderr, /time budget ran out before the post-commit hook could run/u)
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
})

test("#632: a pre-commit hook cut off at the end of the budget is unknown, never absent: it may still be running, and the read-back is not run past the budget", async (t) => {
  const root = await stagedChange()
  const before = headOf632(root)
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const budget = spendsTheBudget(t, (verb) => (hookNamed("pre-commit")(verb) ? "cut" : null))
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", budget.spawn)
  assert.deepEqual(budget.past(), [], "no Git call is given time past the one budget")
  assert.equal(budget.dispatched("commit-tree") + budget.dispatched("update-ref"), 0)
  assert.equal(headOf632(root), before)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.match(result.stderr, /pre-commit hook was cut off/u)
})

test("#632: a commit made as the budget ends does not move the branch, and is unknown, never absent: the read-back is not run past the budget", async (t) => {
  const root = await stagedChange()
  const before = headOf632(root)
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const budget = spendsTheBudget(t, (verb) => (verb[0] === "commit-tree" ? "ran" : null))
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", budget.spawn)
  assert.deepEqual(budget.past(), [], "no Git call is given time past the one budget")
  assert.equal(budget.dispatched("update-ref"), 0, "the branch is not moved once the budget has ended")
  assert.equal(headOf632(root), before)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.match(result.stderr, /time budget ran out before the branch was moved/u)
})

// The answer after the branch update says only what was read: a branch that could not be read is unread, never "does not hold", and a branch
// update the budget left no room for was never dispatched, never "cut off".
test("#632: a branch read cut off after the branch moved says the branch could not be read, never that it does not hold the commit", async (t) => {
  const root = await stagedChange()
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const budget = spendsTheBudget(t, (verb) => (verb[0] === "rev-parse" && verb.at(-1) === "refs/heads/main" ? "cut" : null))
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", budget.spawn)
  assert.deepEqual(budget.past(), [], "no Git call is given time past the one budget")
  assert.equal(budget.dispatched("update-ref"), 1)
  assert.equal(budget.dispatched("hook run --ignore-missing post-commit"), 0)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.match(result.stderr, /refs\/heads\/main could not be read \(cut off at the end of the commit's time budget\)/u)
  assert.doesNotMatch(result.stderr, /does not hold/u)
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n", "the branch does hold the commit")
})

test("#632: a branch read that fails after the branch moved says the branch could not be read, never that it does not hold the commit", async () => {
  const root = await stagedChange()
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  const failure = { status: 128, signal: null, stdout: "", stderr: "fatal: the read failed" }
  let updates = 0
  const spawn = (command, args, options) => {
    if (args[2] === "update-ref") updates++
    return args[2] === "rev-parse" && args.at(-1) === "refs/heads/main" ? failure : spawnSync(command, args, options)
  }
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", spawn)
  assert.equal(updates, 1, "dispatched once, never repeated")
  assert.match(result.stderr, /refs\/heads\/main could not be read \(git exited 128\)/u)
  assert.doesNotMatch(result.stderr, /does not hold/u)
  assert.deepEqual([result.ok, result.readback], [true, "committed"], "the read-back, not the failed read, says the commit is in effect")
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
})

test("#632: a branch update the budget left no room for says it was never dispatched, never that it was cut off", async (t) => {
  const root = await stagedChange()
  const before = headOf632(root)
  const entries = indexEntries(root, ["a.txt"], spawnSync)
  let operationReads = 0
  // The second read of which Git operation is in progress is the core's last before the branch update; it spends the rest of the budget.
  const budget = spendsTheBudget(t, (verb) => (verb[1] === "--path-format=absolute" && operationReads++ === 1 ? "ran" : null))
  const result = commitIndexPaths(root, ["a.txt"], entries, "save", budget.spawn)
  assert.equal(operationReads, 2)
  assert.deepEqual(budget.past(), [], "no Git call is given time past the one budget")
  assert.equal(budget.dispatched("commit-tree"), 1)
  assert.equal(budget.dispatched("update-ref"), 0, "the branch update was never dispatched")
  assert.equal(headOf632(root), before)
  assert.deepEqual([result.ok, result.readback], [false, "unknown"])
  assert.match(result.stderr, /the branch update was never dispatched/u)
  assert.doesNotMatch(result.stderr, /cut off/u)
})

// What a plain git commit did that the commit keeps.
function hookIn(root, name, script) {
  const hooks = path.resolve(root, git(root, ["rev-parse", "--git-path", "hooks"]).trim())
  writeFileSync(path.join(hooks, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 })
}
const posix = { skip: process.platform === "win32" ? "POSIX shell hooks" : false }

test("#632: the hooks see Desk's own commit marker, so the card guard still lets Desk commit", posix, async () => {
  const root = await stagedChange()
  hookIn(root, "pre-commit", '[ "$DESK_TOOL_COMMIT" = 1 ] || { echo "not Desk" >&2; exit 1; }')
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
})

test("#632: a pre-commit hook that refuses commits nothing: absent, with its capture", posix, async () => {
  const root = await stagedChange()
  const before = headOf632(root)
  hookIn(root, "pre-commit", 'echo "no" >&2; exit 1')
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.deepEqual([result.ok, result.readback, result.capture?.before], [false, "absent", before])
  assert.equal(headOf632(root), before)
})

test("#632: a commit-msg hook's rewrite is the message committed", posix, async () => {
  const root = await stagedChange()
  hookIn(root, "commit-msg", 'printf "\\nSigned-off-by: Hook <h@example.com>\\n" >> "$1"')
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.equal(git(root, ["log", "-1", "--format=%B"]).trim(), "save\n\nSigned-off-by: Hook <h@example.com>")
})

test("#632: commit.gpgSign still signs the commit", posix, async () => {
  const root = await stagedChange()
  const signer = path.join(root, ".git", "fake-gpg")
  writeFileSync(signer, '#!/bin/sh\ncat >/dev/null\nprintf "\\n[GNUPG:] SIG_CREATED D 1 8 00 0 0 0\\n" >&2\nprintf -- "-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n"\n', { mode: 0o755 })
  git(root, ["config", "commit.gpgSign", "true"])
  git(root, ["config", "gpg.program", signer])
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.match(git(root, ["cat-file", "commit", "HEAD"]), /^gpgsig -----BEGIN PGP SIGNATURE-----$/mu)
})

test("#632: a post-commit hook that fails does not undo a commit HEAD holds", posix, async () => {
  const root = await stagedChange()
  hookIn(root, "post-commit", "exit 1")
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
})

test("#632: a post-commit hook that commits other paths after it leaves this commit in effect", posix, async () => {
  const root = await stagedChange()
  hookIn(root, "post-commit", 'unset GIT_INDEX_FILE; [ -e hooked.txt ] || { echo hooked > hooked.txt; git add hooked.txt; git commit -q -m hooked -- hooked.txt; }')
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.equal(lastCommitMessage(root), "hooked")
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
})

test("#632: the first commit on an unborn branch is a root commit", async () => {
  const root = await mkTempRepo()
  await fs.writeFile(path.join(root, "a.txt"), "one\n")
  git(root, ["add", "--", "a.txt"])
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.equal(git(root, ["rev-list", "--count", "HEAD"]).trim(), "1")
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "one\n")
})

test("#632: nothing to commit is no commit: absent, and no empty commit is made", async () => {
  const root = await repoWithChange()
  const before = headOf632(root)
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.deepEqual([result.ok, result.readback], [false, "absent"])
  assert.equal(headOf632(root), before)
})

// A HEAD or branch Git cannot read before anything is built: nothing that could commit was run, so it is absent, with no capture to finish.
for (const [label, unreadable] of [["HEAD", "rev-parse"], ["the branch", "symbolic-ref"]]) {
  test(`#632: ${label} that Git cannot read before the commit is built dispatches nothing and commits nothing`, async () => {
    const root = await stagedChange()
    const before = headOf632(root)
    const entries = indexEntries(root, ["a.txt"], spawnSync)
    const verbs = []
    let branchReads = 0
    const spawn = (command, args, options) => {
      const verb = args[2]
      verbs.push(verb)
      // The branch refusal's own symbolic-ref read passes; the read of the branch to commit on after it fails.
      if (verb === unreadable && (verb === "rev-parse" || branchReads++ > 0)) return { status: 128, stdout: "", stderr: "fatal: cannot read" }
      return spawnSync(command, args, options)
    }
    const result = commitIndexPaths(root, ["a.txt"], entries, "save", spawn)
    assert.deepEqual(result, { ok: false, stderr: "Git could not read the branch and HEAD to commit on, so nothing was committed", readback: "absent" })
    assert.equal(headOf632(root), before)
    assert.deepEqual(verbs.filter((verb) => ["read-tree", "hook", "commit-tree", "update-ref"].includes(verb)), [], "nothing was built, hooked or dispatched")
  })
}

// The hook runs as git commit runs it, and what it writes stays written: Desk does not undo it. Only a change to the tree Desk judged holds.
test("#632 (behaviour change): a pre-commit hook that changes what would be committed is held: the branch does not move and the shared index loses nothing", posix, async () => {
  const root = await stagedChange()
  const before = headOf632(root)
  const index = git(root, ["ls-files", "-s"])
  hookIn(root, "pre-commit", "echo extra > extra.txt && git add extra.txt")
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.deepEqual([result.ok, result.readback], [false, "absent"])
  assert.equal(result.stderr, "nothing was committed: the pre-commit hook changed what would be committed; Desk commits only the captured change")
  assert.deepEqual(result.capture, { before, branch: branchOf632(root), expected: [`100644 ${git(root, ["rev-parse", ":a.txt"]).trim()}\ta.txt`] })
  assert.equal(headOf632(root), before, "the branch does not move")
  assert.equal(git(root, ["ls-files", "-s"]), index, "every entry of the shared index is as it was, the other staged b.txt included")
  assert.equal(await fs.readFile(path.join(root, "extra.txt"), "utf8"), "extra\n", "the hook ran, and what it wrote is not undone")
})

test("#632: a pre-commit hook that writes only to the working tree does not hold the commit: the tree Desk judged is committed", posix, async () => {
  const root = await stagedChange()
  hookIn(root, "pre-commit", "echo note > hook-note.txt")
  const result = commitIndexPaths(root, ["a.txt"], indexEntries(root, ["a.txt"], spawnSync), "save", spawnSync)
  assert.equal(result.ok, true, result.stderr)
  assert.deepEqual(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).trim().split("\n"), ["a.txt"])
  assert.equal(git(root, ["show", "HEAD:a.txt"]), "two\n")
  assert.equal(await fs.readFile(path.join(root, "hook-note.txt"), "utf8"), "note\n")
})
