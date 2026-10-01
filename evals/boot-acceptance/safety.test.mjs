// Tests for the harness's safety layers. Run: node --test evals/boot-acceptance/safety.test.mjs
// No network, no model calls, nothing outside a temp directory.

import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { buildChildEnv, classifyGh, findRealGh, ghWriteAttempts, installGhShim, writeGitConfig } from "./safety.mjs"
import { parseArgs, realpathThroughExisting } from "./run.mjs"

const allowed = (...args) => classifyGh(args).allowed

test("gh: read-only subcommands pass", () => {
  for (const args of [
    ["auth", "status"], ["auth", "token"], ["auth", "token", "--user", "someone"], ["pr", "list", "--repo", "a/b", "--author", "@me"], ["pr", "view", "3"], ["repo", "view", "a/b"],
    ["api", "repos/a/b"], ["api", "-X", "GET", "repos/a/b"], ["api", "--method=GET", "x"], ["issue", "list"], ["search", "prs", "x"], ["--version"], ["-R", "a/b", "pr", "list"],
  ]) assert.equal(allowed(...args), true, args.join(" "))
})

test("gh: writes and unknown commands are denied", () => {
  for (const args of [
    ["pr", "create", "--title", "x"], ["pr", "merge", "1"], ["repo", "fork", "a/b"], ["repo", "create", "x"], ["issue", "create"], ["issue", "comment", "1"],
    ["api", "-X", "POST", "repos/a/b/issues"], ["api", "-X", "DELETE", "x"], ["api", "x", "-f", "a=b"], ["api", "x", "-F", "a=b"], ["api", "x", "--field", "a=b"], ["api", "x", "--input", "f.json"], ["api", "graphql", "-f", "query=x"],
    ["auth", "status", "--show-token"], ["auth", "status", "-t"], ["auth", "login"], ["auth", "switch"], ["auth", "refresh"], ["auth", "setup-git"], ["config", "set", "a", "b"], ["extension", "install", "x"], ["release", "create"], ["workflow", "run", "x"], ["secret", "set", "x"], ["gist", "create"], ["somethingnew"],
  ]) assert.equal(allowed(...args), false, args.join(" "))
})

test("transcript check finds gh writes in shell command lines, including a real binary called by path", () => {
  assert.deepEqual(ghWriteAttempts(["gh pr list && gh auth status", "cd x; gh pr create --fill", "echo hi | gh api x -f a=b"]).length, 2)
  assert.equal(ghWriteAttempts(["/opt/homebrew/bin/gh pr list"]).length, 1)
  assert.deepEqual(ghWriteAttempts(["ghost pr create", "git status"]), [])
})

function scratch() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "boot-acceptance-safety-"))
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) }
}

test("the gh shim runs read-only calls, blocks writes with exit 97 and logs them", () => {
  const { dir, done } = scratch()
  try {
    const realDir = path.join(dir, "real")
    mkdirSync(realDir)
    writeFileSync(path.join(realDir, "gh"), '#!/bin/sh\necho "real gh: $@"\n', { mode: 0o755 })
    const log = path.join(dir, "log.jsonl")
    const shim = installGhShim({ shimDir: path.join(dir, "shim"), realGh: findRealGh(realDir), logFile: log })
    const ok = spawnSync(shim, ["pr", "list"], { encoding: "utf8" })
    assert.equal(ok.status, 0)
    assert.match(ok.stdout, /real gh: pr list/)
    const bad = spawnSync(shim, ["pr", "create", "--title", "x"], { encoding: "utf8" })
    assert.equal(bad.status, 97)
    assert.doesNotMatch(bad.stdout, /real gh/)
    assert.match(bad.stderr, /blocked by the boot-acceptance harness/)
    assert.match(readFileSync(log, "utf8"), /pr create/)
  } finally { done() }
})

test("the child environment is an allowlist: inherited secrets and redirects never reach it", () => {
  const parent = { PATH: "/usr/bin", LANG: "C", GH_TOKEN: "t", GITHUB_TOKEN: "t", XDG_STATE_HOME: "/real", XDG_CACHE_HOME: "/real", DESK_RUNTIME_CACHE_DIR: "/real", CLAUDE_CONFIG_DIR: "/real", DESK_PERSON: "x", DESK_FACTORY_STORE: "x", DESK: "/real", HOME: "/real" }
  const env = buildChildEnv({ parentEnv: parent, homeDir: "/h", shimDir: "/s", gitConfig: "/h/.gitconfig", ghLog: "/l" })
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "DESK_RUNTIME_CACHE_DIR", "CLAUDE_CONFIG_DIR", "DESK_PERSON", "DESK_FACTORY_STORE", "DESK"]) assert.equal(name in env, false, name)
  assert.equal(env.HOME, "/h")
  assert.equal(env.XDG_STATE_HOME, "/h/.local/state")
  assert.equal(env.XDG_CACHE_HOME, "/h/.cache")
  assert.equal(env.PATH.split(path.delimiter)[0], "/s")
})

test("git push to any GitHub URL fails at once against the run's git config, while a local remote still works", () => {
  const { dir, done } = scratch()
  try {
    const home = path.join(dir, "home")
    mkdirSync(home)
    const cfg = writeGitConfig(home)
    const env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_GLOBAL: cfg, GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" }
    const repo = path.join(dir, "repo")
    const bare = path.join(dir, "bare.git")
    const git = (cwd, ...args) => spawnSync("git", args, { cwd, env, encoding: "utf8" })
    mkdirSync(repo)
    assert.equal(git(repo, "init", "-q", "-b", "main").status, 0)
    assert.equal(git(repo, "commit", "-q", "--allow-empty", "-m", "x").status, 0)
    assert.equal(git(dir, "init", "-q", "--bare", bare).status, 0)
    assert.equal(git(repo, "push", "-q", bare, "main").status, 0, "local remote pushes")
    for (const url of ["https://github.com/example/none.git", "git@github.com:example/none.git", "ssh://git@github.com/example/none.git", "https://www.github.com/example/none.git", "http://www.github.com/example/none.git", "https://user:secret@github.com/example/none.git", "https://gitlab.example.org/example/none.git", "http://git.example.org/none.git", "git://git.example.org/none.git", "ssh://git@git.example.org/none.git"]) {
      const r = git(repo, "push", url, "main")
      assert.notEqual(r.status, 0, url)
      assert.match(r.stderr, /offline-remotes|does not appear to be a git repository|not found|No such/i, url)
      // A clone or fetch is rewritten the same way, so it fails at once instead of downloading a real repository.
      const clone = git(dir, "clone", "-q", url, path.join(dir, "cloned"))
      assert.notEqual(clone.status, 0, `clone ${url}`)
      assert.match(clone.stderr, /offline-remotes|does not appear to be a git repository|not found|No such/i, `clone ${url}`)
      const fetched = git(repo, "fetch", url)
      assert.notEqual(fetched.status, 0, `fetch ${url}`)
      assert.match(fetched.stderr, /offline-remotes|does not appear to be a git repository|not found|No such/i, `fetch ${url}`)
    }
    assert.equal(git(dir, "clone", "-q", bare, path.join(dir, "local-clone")).status, 0, "a local bare repository still clones")
    assert.equal(git(dir, "clone", "-q", `file://${bare}`, path.join(dir, "file-clone")).status, 0, "a file:// URL still clones")
    assert.equal(git(path.join(dir, "file-clone"), "fetch", "-q", "origin").status, 0, "and fetches from its local origin")
    assert.equal(git(path.join(dir, "file-clone"), "ls-remote", "-q", bare).status, 0, "a path remote is still readable")
  } finally { done() }
})

test("arguments: --help needs no out-dir, an out-dir inside the repository is refused even through a symlink", () => {
  assert.equal(parseArgs(["--help"]).help, true)
  assert.throws(() => parseArgs([]), /--out-dir is required/)
  assert.throws(() => parseArgs(["--out-dir", path.join(import.meta.dirname, "x")]), /outside the repository/)
  const { dir, done } = scratch()
  try {
    const link = path.join(dir, "link")
    symlinkSync(import.meta.dirname, link)
    assert.throws(() => parseArgs(["--out-dir", path.join(link, "sub")]), /outside the repository/)
    assert.equal(realpathThroughExisting(path.join(dir, "new", "deep")).endsWith(path.join("new", "deep")), true)
    assert.equal(parseArgs(["--out-dir", path.join(dir, "ok")]).outDir, path.join(dir, "ok"))
  } finally { done() }
})
