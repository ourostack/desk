// The real short-SHA resolver, against a temporary repository built here.
// No real repository is read.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { SHORT_SHA, createCommitResolver } from "../../src/factory/commit-resolve.js"

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function makeRepo() {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "desk-commit-resolve-")))
  const repo = path.join(scratch, "repo")
  mkdirSync(path.join(repo, "sub"), { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  writeFileSync(path.join(repo, "sub", "a.txt"), "a\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "first")
  return { scratch, repo, full: git(repo, "rev-parse", "HEAD"), tree: git(repo, "rev-parse", "HEAD^{tree}") }
}

test("a short SHA in the repository's top level resolves to its full SHA", () => {
  const { scratch, repo, full } = makeRepo()
  try {
    const resolve = createCommitResolver()
    assert.equal(resolve(repo, full.slice(0, 7)), full)
    assert.equal(resolve(repo, full.slice(0, 9).toUpperCase()), full)
    assert.equal(resolve(repo, full), full)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("an unknown SHA, a tree, a subdirectory, a missing or relative root and a bad SHA shape resolve to null", () => {
  const { scratch, repo, full, tree } = makeRepo()
  try {
    const resolve = createCommitResolver()
    assert.equal(resolve(repo, "0000000"), null)
    assert.equal(resolve(repo, tree.slice(0, 12)), null, "only a commit resolves")
    assert.equal(resolve(path.join(repo, "sub"), full.slice(0, 7)), null, "a subdirectory is not a top level")
    assert.equal(resolve(path.join(scratch, "none"), full.slice(0, 7)), null)
    assert.equal(resolve(scratch, full.slice(0, 7)), null, "a directory outside any repository")
    assert.equal(resolve("repo", full.slice(0, 7)), null)
    assert.equal(resolve(null, full.slice(0, 7)), null)
    for (const bad of ["abc", "--output=/tmp/x", "g123456", `${full}0`, 7, null]) assert.equal(resolve(repo, bad), null, String(bad))
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("Git that cannot run, or runs out of time, resolves nothing and never throws", () => {
  const { scratch, repo, full } = makeRepo()
  try {
    assert.equal(createCommitResolver({ git: path.join(scratch, "no-git") })(repo, full.slice(0, 7)), null)
    assert.equal(createCommitResolver({ timeoutMs: 1 })(repo, full.slice(0, 7)), null)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("the top-level check runs once per root, and a hook's GIT_DIR cannot point Git elsewhere", () => {
  const { scratch, repo, full } = makeRepo()
  const saved = process.env.GIT_DIR
  try {
    process.env.GIT_DIR = path.join(scratch, "elsewhere")
    const resolve = createCommitResolver()
    assert.equal(resolve(repo, full.slice(0, 7)), full)
    assert.equal(resolve(repo, full.slice(0, 8)), full)
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR
    else process.env.GIT_DIR = saved
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("SHORT_SHA admits 4 to 40 hex characters only", () => {
  assert.ok(SHORT_SHA.test("abcd"))
  assert.ok(SHORT_SHA.test("a".repeat(40)))
  assert.equal(SHORT_SHA.test("abc"), false)
  assert.equal(SHORT_SHA.test("a".repeat(41)), false)
  assert.equal(SHORT_SHA.test("-abcd"), false)
})
