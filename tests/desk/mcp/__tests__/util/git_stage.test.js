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
