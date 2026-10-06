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
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import {
  isGitRepository,
  hasUnstagedWork,
  stagePaths,
  commitPaths,
  commitBranchRefusal,
  commitIndexPaths,
  indexEntries,
} from "../../../../../plugins/desk/mcp/src/util/git-stage.js"

async function mkTempRepo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "desk-git-stage-test-"))
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

  const plain = await fs.mkdtemp(path.join(os.tmpdir(), "desk-git-stage-test-plain-"))
  assert.equal(isGitRepository(plain, spawnSync), false)
})

test("isGitRepository fails safe to false when the spawned command throws", async () => {
  const root = await mkTempRepo()
  const throwing = () => { throw new Error("spawn ENOENT") }
  assert.equal(isGitRepository(root, throwing), false)
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

test("commitPaths reports { ok: false, stderr: \"timeout\" } when the git call times out, without throwing", async () => {
  const root = await mkTempRepo()
  const result = commitPaths(root, ["a.txt"], "message", etimedoutResult)
  assert.deepEqual(result, { ok: false, stderr: "timeout" })
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
