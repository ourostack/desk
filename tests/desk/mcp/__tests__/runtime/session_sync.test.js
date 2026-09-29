// session-sync.js — session-start's own sync step (M4-6 "agents never fight
// the desk" Part 3, Task 3; spec.md §2 "Session-start pull").
//
// Real synthetic Git repos throughout (a bare origin plus clones), per
// spec.md §7 — never mocked command shapes, except for the one TOCTOU race
// (a stray path vanishing between being listed and being moved) that real
// Git/the filesystem cannot be made to hit deterministically, which uses a
// scripted `spawnGit` that falls through to the real command for everything
// it does not deliberately intercept — the same pattern
// `runtime/sync_worker.test.js` already uses for its own forced-failure
// paths.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, existsSync, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import {
  queueDeskProblemFiling,
  runSessionSyncCli,
  syncWorkspace,
} from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function mkBareOrigin() {
  const root = await mkTempRoot("desk-session-sync-origin-")
  git(root, ["init", "--bare", "-q"])
  return root
}

async function mkClone(originDir, label, { trackMain = false } = {}) {
  const root = await mkTempRoot(`desk-session-sync-${label}-`)
  git(root, ["clone", "-q", originDir, "."])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  if (trackMain) git(root, ["checkout", "-q", "-B", "main", "origin/main"])
  else git(root, ["symbolic-ref", "HEAD", "refs/heads/main"])
  return root
}

async function writeAndCommit(root, name, content, message) {
  await fs.writeFile(path.join(root, name), content)
  git(root, ["add", "--", name])
  git(root, ["commit", "-q", "-m", message])
}

// Every real desk's `.gitignore` includes `_cache/` (the quarantine directory itself is
// git-ignored, never committed -- `first-run-bootstrap/SKILL.md`'s own fresh-create step), so the
// fixtures mirror that here: without it, `untrackedPaths` would sweep up a same-day quarantine
// directory as more stray content to quarantine.
async function mkOriginWithClone() {
  const origin = await mkBareOrigin()
  const cloneA = await mkClone(origin, "a")
  await writeAndCommit(cloneA, ".gitignore", "_cache/\n", "gitignore _cache")
  await writeAndCommit(cloneA, "seed.md", "seed\n", "seed")
  git(cloneA, ["push", "-q", "-u", "origin", "main"])
  return { origin, cloneA }
}

async function mkPlainRepo() {
  const root = await mkTempRoot("desk-session-sync-plain-")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  return root
}

// origin has one commit (seed.md, pushed from cloneA). cloneB then adds
// stray.txt and pushes it, while cloneA independently gets an *untracked*,
// uncommitted stray.txt of its own — the classic dirty-index pull failure:
// `git pull --rebase --autostash` fetches cloneB's commit fine, but refuses
// to check it out because the incoming tracked stray.txt would overwrite
// cloneA's own untracked one.
async function mkDirtyIndexFixture() {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "stray.txt", "from origin\n", "add stray from origin")
  git(cloneB, ["push", "-q"])
  await fs.writeFile(path.join(cloneA, "stray.txt"), "local uncommitted\n")
  return { origin, cloneA, cloneB }
}

// origin gets a conflicting edit to seed.md from cloneB; cloneA commits its
// own conflicting edit to the same file locally, never pushed — a genuine
// tracked-file rebase conflict, with no untracked path to blame.
async function mkConflictFixture() {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "seed.md", "seed\nfrom origin\n", "origin edits seed")
  git(cloneB, ["push", "-q"])
  await writeAndCommit(cloneA, "seed.md", "seed\nfrom local\n", "local edits seed")
  return { origin, cloneA, cloneB }
}

const env = process.env

// ---------------------------------------------------------------------------
// The "nothing to sync against" guards (no remote at all, or no upstream yet).
// ---------------------------------------------------------------------------

test("syncWorkspace reports synced, without ever pulling, on a plain repo with no remote configured", async () => {
  const root = await mkPlainRepo()
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const result = await syncWorkspace({ root, env })
  assert.deepEqual(result, { state: "synced" })
})

test("syncWorkspace reports synced when a remote exists but the current branch has no upstream", async () => {
  const origin = await mkBareOrigin()
  const root = await mkPlainRepo()
  git(root, ["remote", "add", "origin", origin])
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const result = await syncWorkspace({ root, env })
  assert.deepEqual(result, { state: "synced" })
})

// ---------------------------------------------------------------------------
// The ordinary happy path.
// ---------------------------------------------------------------------------

test("syncWorkspace reports synced when the pull needs nothing (already up to date)", async () => {
  const { cloneA } = await mkOriginWithClone()
  const result = await syncWorkspace({ root: cloneA, env })
  assert.deepEqual(result, { state: "synced" })
})

// ---------------------------------------------------------------------------
// Dirty-index pull failure -> quarantine -> retry succeeds.
// ---------------------------------------------------------------------------

test("a dirty-index pull failure is resolved by quarantining the stray paths and retrying", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const today = new Date().toISOString().slice(0, 10)
  const result = await syncWorkspace({ root: cloneA, env })
  assert.equal(result.state, "quarantined")
  assert.deepEqual(result.quarantinedPaths, [path.join("_cache", `stray-${today}`, "stray.txt")])
  assert.ok(existsSync(path.join(cloneA, "_cache", `stray-${today}`, "stray.txt")))
  assert.equal(await fs.readFile(path.join(cloneA, "_cache", `stray-${today}`, "stray.txt"), "utf8"), "local uncommitted\n")
  // The pull actually completed: the incoming tracked stray.txt landed too, cleanly.
  assert.equal(await fs.readFile(path.join(cloneA, "stray.txt"), "utf8"), "from origin\n")
  assert.ok(!git(cloneA, ["status", "--porcelain"]).includes("stray.txt"))
})

test("a second (and third) same-day quarantine does not clobber the ones before it", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const today = new Date().toISOString().slice(0, 10)
  const firstDir = path.join(cloneA, "_cache", `stray-${today}`)
  const secondDir = path.join(cloneA, "_cache", `stray-${today}-2`)
  mkdirSync(firstDir, { recursive: true })
  writeFileSync(path.join(firstDir, "existing.txt"), "from an earlier quarantine today\n")
  mkdirSync(secondDir, { recursive: true })
  writeFileSync(path.join(secondDir, "existing2.txt"), "from a second earlier quarantine today\n")

  const result = await syncWorkspace({ root: cloneA, env })
  assert.equal(result.state, "quarantined")
  assert.deepEqual(result.quarantinedPaths, [path.join("_cache", `stray-${today}-3`, "stray.txt")])
  assert.ok(existsSync(path.join(cloneA, "_cache", `stray-${today}-3`, "stray.txt")))
  // Both earlier quarantine directories are untouched.
  assert.equal(await fs.readFile(path.join(firstDir, "existing.txt"), "utf8"), "from an earlier quarantine today\n")
  assert.equal(await fs.readFile(path.join(secondDir, "existing2.txt"), "utf8"), "from a second earlier quarantine today\n")
  assert.ok(!existsSync(path.join(firstDir, "stray.txt")))
  assert.ok(!existsSync(path.join(secondDir, "stray.txt")))
})

test("quarantine skips a stray path that no longer exists by the time it runs, and does not lose the real one", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const spawnGit = (cmd, args, opts) => {
    const result = spawnSync(cmd, args, opts)
    if (args.includes("ls-files")) return { ...result, stdout: `${result.stdout.replace(/\n+$/u, "")}\nghost.txt\n` }
    return result
  }
  const result = await syncWorkspace({ root: cloneA, env, spawnGit })
  assert.equal(result.state, "quarantined")
  assert.ok(result.quarantinedPaths.some((p) => p.endsWith("stray.txt")))
  assert.ok(!result.quarantinedPaths.some((p) => p.includes("ghost")))
  assert.ok(!existsSync(path.join(cloneA, "_cache", `stray-${new Date().toISOString().slice(0, 10)}`, "ghost.txt")))
})

// ---------------------------------------------------------------------------
// Unresolved: a genuine tracked-file conflict, with nothing to quarantine.
// ---------------------------------------------------------------------------

test("a genuine tracked-file conflict with no untracked paths is unresolved, files through the detached filer, and leaves no rebase in progress", async () => {
  const { cloneA } = await mkConflictFixture()
  let filed = null
  const fileProblem = (args) => { filed = args }
  const result = await syncWorkspace({ root: cloneA, env, fileProblem })

  assert.equal(result.state, "unresolved")
  assert.equal(result.quarantinedPaths, undefined)
  assert.match(result.diagnostic, /^Desk problem: session-sync — session-start pull did not resolve$/mu)
  assert.match(result.diagnostic, /pull_rebase_failed\)/u)
  assert.match(result.diagnostic, /conflicted: seed\.md/u)
  assert.match(result.diagnostic, /filing in background/u)

  assert.deepEqual(filed, { root: cloneA, env, reason: "pull_rebase_failed", host: "unknown" })
  // The abort actually ran: no rebase left mid-flight, and the working tree is restored to
  // cloneA's own (still-local, unpushed) commit, clean of conflict markers.
  assert.ok(!existsSync(path.join(cloneA, ".git", "rebase-apply")))
  assert.ok(!existsSync(path.join(cloneA, ".git", "rebase-merge")))
  assert.equal(git(cloneA, ["status", "--porcelain"]).trim(), "")
})

test("a quarantine retry that still fails is unresolved, reports the quarantined paths, and files through the detached filer", async () => {
  const { cloneA, cloneB } = await mkDirtyIndexFixture()
  // Make the retry fail too, for a different (tracked-file conflict) reason: cloneA commits a
  // conflicting local edit to seed.md that origin also changed.
  await writeAndCommit(cloneB, "seed.md", "seed\nfrom origin\n", "origin edits seed")
  git(cloneB, ["push", "-q"])
  await writeAndCommit(cloneA, "seed.md", "seed\nfrom local\n", "local edits seed")

  let filed = null
  const fileProblem = (args) => { filed = args }
  const result = await syncWorkspace({ root: cloneA, env, fileProblem })

  assert.equal(result.state, "unresolved")
  assert.ok(Array.isArray(result.quarantinedPaths) && result.quarantinedPaths.length === 1)
  assert.match(result.diagnostic, /pull_rebase_failed_after_quarantine\)/u)
  assert.match(result.diagnostic, /conflicted: seed\.md/u)
  assert.equal(filed.reason, "pull_rebase_failed_after_quarantine")
  assert.ok(!existsSync(path.join(cloneA, ".git", "rebase-merge")))
})

test("conflictedPaths and untrackedPaths degrade to empty when their own git commands fail, still reaching unresolved", async () => {
  const { cloneA } = await mkDirtyIndexFixture()
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("ls-files") || args.includes("--diff-filter=U")) return { status: 1, stdout: "" }
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await syncWorkspace({ root: cloneA, env, spawnGit, fileProblem: (args) => { filed = args } })
  assert.equal(result.state, "unresolved")
  assert.equal(result.quarantinedPaths, undefined)
  assert.doesNotMatch(result.diagnostic, /conflicted:/u)
  assert.equal(filed.reason, "pull_rebase_failed")
})

// ---------------------------------------------------------------------------
// queueDeskProblemFiling — the real default `fileProblem`, tested directly
// with an injected `spawnImpl` so the real detached filer never actually
// launches from a test (it really does shell out toward `gh`).
// ---------------------------------------------------------------------------

test("queueDeskProblemFiling spawns the detached filer with mechanism session-sync and the given reason/host", () => {
  let captured = null
  const spawnImpl = (cmd, args, opts) => {
    captured = { cmd, args, opts }
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => {} }
  }
  queueDeskProblemFiling({ root: "/some/root", env: { A: "1" }, reason: "pull_rebase_failed", host: "claude", spawnImpl })
  assert.equal(captured.cmd, process.execPath)
  assert.ok(captured.args.includes("--mechanism"))
  assert.ok(captured.args.includes("session-sync"))
  assert.ok(captured.args.includes("--reason"))
  assert.ok(captured.args.includes("pull_rebase_failed"))
  assert.ok(captured.args.includes("--host"))
  assert.ok(captured.args.includes("claude"))
  assert.ok(captured.args.includes("--fix-attempt"))
  assert.equal(captured.opts.detached, true)
  assert.equal(captured.opts.stdio, "ignore")
  assert.equal(captured.opts.cwd, "/some/root")
})

test("queueDeskProblemFiling never throws, even when the spawn implementation itself throws", () => {
  assert.doesNotThrow(() => queueDeskProblemFiling({ root: "/x", env: {}, reason: "x", host: "unknown", spawnImpl: () => { throw new Error("boom") } }))
})

// ---------------------------------------------------------------------------
// runSessionSyncCli — the CLI surface `mcp/scripts/session-sync.js` wraps.
// ---------------------------------------------------------------------------

function fakeIo() {
  const out = []
  const err = []
  return { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, out, err }
}

test("runSessionSyncCli requires --root (or the DESK env var) and never throws when both are missing", async () => {
  const io = fakeIo()
  const code = await runSessionSyncCli({ argv: [], env: {}, io, syncFn: async () => { throw new Error("must not be called") } })
  assert.equal(code, 0)
  assert.equal(io.out.length, 0)
  assert.match(io.err[0], /--root.*DESK/u)
})

test("runSessionSyncCli's argument parser rejects a malformed flag shape (a bad launch site is a bug in the caller)", async () => {
  await assert.rejects(runSessionSyncCli({ argv: [42, "x"], env: {} }), /unexpected argument/u)
  await assert.rejects(runSessionSyncCli({ argv: ["notflag", "x"], env: {} }), /unexpected argument/u)
  await assert.rejects(runSessionSyncCli({ argv: [undefined, "x"], env: {} }), /unexpected argument ""/u)
})

test("runSessionSyncCli treats an explicit empty --root the same as a missing one", async () => {
  const io = fakeIo()
  const code = await runSessionSyncCli({ argv: ["--root", ""], env: {}, io, syncFn: async () => { throw new Error("must not be called") } })
  assert.equal(code, 0)
  assert.equal(io.out.length, 0)
  assert.match(io.err[0], /--root.*DESK/u)
})

test("runSessionSyncCli falls back to the DESK env var when --root is not passed", async () => {
  const io = fakeIo()
  let seenRoot = null
  const code = await runSessionSyncCli({ argv: [], env: { DESK: "/a/desk" }, io, syncFn: async ({ root }) => { seenRoot = root; return { state: "synced" } } })
  assert.equal(code, 0)
  assert.equal(seenRoot, "/a/desk")
  assert.equal(io.out.length, 0)
})

test("runSessionSyncCli prints nothing for a synced result", async () => {
  const io = fakeIo()
  await runSessionSyncCli({ argv: ["--root", "/a/desk"], env: {}, io, syncFn: async () => ({ state: "synced" }) })
  assert.equal(io.out.length, 0)
  assert.equal(io.err.length, 0)
})

test("runSessionSyncCli prints a one-line summary for a quarantined result", async () => {
  const io = fakeIo()
  await runSessionSyncCli({
    argv: ["--root", "/a/desk"],
    env: {},
    io,
    syncFn: async () => ({ state: "quarantined", quarantinedPaths: ["_cache/stray-2026-09-28/stray.txt"] }),
  })
  assert.equal(io.out.length, 1)
  assert.match(io.out[0], /quarantined 1 stray path\(s\)/u)
  assert.match(io.out[0], /stray\.txt/u)
})

test("runSessionSyncCli prints the diagnostic block for an unresolved result", async () => {
  const io = fakeIo()
  await runSessionSyncCli({
    argv: ["--root", "/a/desk"],
    env: {},
    io,
    syncFn: async () => ({ state: "unresolved", diagnostic: "Desk problem: session-sync — session-start pull did not resolve" }),
  })
  assert.equal(io.out.length, 1)
  assert.match(io.out[0], /^Desk problem: session-sync/u)
})

// ---------------------------------------------------------------------------
// scripts/session-sync.js — the one-line CLI entry point itself, run for
// real as a subprocess (the same pattern scripts/tidy-status.js's own test
// uses). A plain repo with no remote settles into "synced" almost
// instantly and prints nothing, so this is a fast, side-effect-free way to
// exercise the actual shipped file's own single statement.
// ---------------------------------------------------------------------------

test("scripts/session-sync.js runs the command line for real, as a subprocess", async () => {
  const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/session-sync.js", import.meta.url))
  const root = await mkPlainRepo()
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const stdout = execFileSync(process.execPath, [SCRIPT, "--root", root], { encoding: "utf8", env: process.env })
  assert.equal(stdout, "")
})
