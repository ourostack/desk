// The real commit resolver, against temporary repositories built here. No
// real repository is read.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { SHORT_SHA, createCommitResolver } from "../../src/factory/commit-resolve.js"

function git(repo, ...args) {
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function makeRepo({ origin = "git@github.com:Octo-Org/Widgets.git" } = {}) {
  const scratch = realpathSync(mkdtempSync(path.join(os.tmpdir(), "desk-commit-resolve-")))
  const repo = path.join(scratch, "repo")
  mkdirSync(path.join(repo, "sub"), { recursive: true })
  git(repo, "init", "-q", "-b", "main")
  if (origin !== null) git(repo, "remote", "add", "origin", origin)
  writeFileSync(path.join(repo, "sub", "a.txt"), "a\n")
  git(repo, "add", ".")
  git(repo, "commit", "-q", "-m", "first")
  return { scratch, repo, full: git(repo, "rev-parse", "HEAD"), tree: git(repo, "rev-parse", "HEAD^{tree}") }
}

test("one batch resolves short, uppercase and full SHAs in the repository's top level, and reports its normalized origin", () => {
  const { scratch, repo, full, tree } = makeRepo()
  try {
    const resolve = createCommitResolver()
    const shas = [full.slice(0, 7), full.slice(0, 9).toUpperCase(), full, "0000000", tree.slice(0, 12), "abc", 7, `${full.slice(0, 7)}\n${full}`]
    assert.deepEqual(resolve({ gitRoot: repo, shas }), { origin: "https://github.com/octo-org/widgets", fulls: [full, full, full, null, null, null, null, null] })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("a gitRoot that is not a top level falls back to the repository holding cwd, which may be a subdirectory", () => {
  const { scratch, repo, full } = makeRepo()
  try {
    const resolve = createCommitResolver()
    const sub = path.join(repo, "sub")
    assert.deepEqual(resolve({ gitRoot: sub, cwd: null, shas: [full.slice(0, 7)] }), { origin: null, fulls: [null] }, "a subdirectory is not a gitRoot")
    assert.deepEqual(resolve({ gitRoot: sub, cwd: sub, shas: [full.slice(0, 7)] }), { origin: "https://github.com/octo-org/widgets", fulls: [full] })
    assert.deepEqual(resolve({ gitRoot: path.join(scratch, "none"), cwd: sub, shas: [full.slice(0, 7)] }).fulls, [full])
    assert.deepEqual(resolve({ gitRoot: "relative", cwd: "relative", shas: [full.slice(0, 7)] }), { origin: null, fulls: [null] })
    assert.deepEqual(resolve({ cwd: scratch, shas: [full.slice(0, 7)] }), { origin: null, fulls: [null] }, "a directory outside any repository")
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("a repository with no origin resolves commits but reports no origin", () => {
  const { scratch, repo, full } = makeRepo({ origin: null })
  try {
    assert.deepEqual(createCommitResolver()({ gitRoot: repo, shas: [full.slice(0, 7)] }), { origin: null, fulls: [full] })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("no SHAs, or no list, asks nothing of cat-file", () => {
  const { scratch, repo } = makeRepo()
  try {
    const resolve = createCommitResolver()
    assert.deepEqual(resolve({ gitRoot: repo, shas: [] }), { origin: "https://github.com/octo-org/widgets", fulls: [] })
    assert.deepEqual(resolve({ gitRoot: repo, shas: "abc1234" }), { origin: "https://github.com/octo-org/widgets", fulls: [] })
    assert.deepEqual(resolve(), { origin: null, fulls: [] })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("Git that cannot run, runs out of time or fails at cat-file resolves nothing and never throws", { skip: process.platform === "win32" }, () => {
  const { scratch, repo, full } = makeRepo()
  try {
    const short = full.slice(0, 7)
    assert.deepEqual(createCommitResolver({ git: path.join(scratch, "no-git") })({ gitRoot: repo, shas: [short] }), { origin: null, fulls: [null] })
    assert.deepEqual(createCommitResolver({ timeoutMs: 1 })({ gitRoot: repo, shas: [short] }), { origin: null, fulls: [null] })
    // A Git whose rev-parse answers (as a top level) but whose cat-file and remote fail.
    const fake = path.join(scratch, "fake-git")
    writeFileSync(fake, '#!/bin/sh\nif [ "$3" = "rev-parse" ]; then exit 0; fi\nexit 1\n')
    chmodSync(fake, 0o755)
    assert.deepEqual(createCommitResolver({ git: fake })({ gitRoot: repo, shas: [short] }), { origin: null, fulls: [null] })
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
})

test("a hook's GIT_DIR cannot point Git elsewhere", () => {
  const { scratch, repo, full } = makeRepo()
  const saved = process.env.GIT_DIR
  try {
    process.env.GIT_DIR = path.join(scratch, "elsewhere")
    assert.deepEqual(createCommitResolver()({ gitRoot: repo, shas: [full.slice(0, 8)] }).fulls, [full])
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
