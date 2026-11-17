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
import { promises as fs, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { removeTree } from "../_remove_tree.js"
import {
  runSessionSyncCli,
  spawnGitAsync,
  syncWorkspace,
} from "../../../../../plugins/desk/mcp/src/runtime/session-sync.js"

// These tests are about the sync; the detached delivery it may start is covered in sync_deliver.test.js.
const noDelivery = () => {}


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
const env = process.env

// ---------------------------------------------------------------------------
// The "nothing to sync against" guards (no remote at all, or no upstream yet).
// ---------------------------------------------------------------------------

test("syncWorkspace reports synced, without ever pulling, on a plain repo with no remote configured", async () => {
  const root = await mkPlainRepo()
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env })
  assert.deepEqual(result, { state: "synced", nothingToSync: "no_remote" })
})

test("syncWorkspace reports synced when a remote exists but the current branch has no upstream", async () => {
  const origin = await mkBareOrigin()
  const root = await mkPlainRepo()
  git(root, ["remote", "add", "origin", origin])
  await writeAndCommit(root, "seed.md", "seed\n", "seed")
  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root, env })
  assert.deepEqual(result, { state: "synced", nothingToSync: "no_upstream" })
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

test("syncWorkspace's own git calls extend an already-set GIT_SSH_COMMAND with -o BatchMode=yes, rather than replacing it", async () => {
  const { cloneA } = await mkOriginWithClone()
  const originalSsh = process.env.GIT_SSH_COMMAND
  process.env.GIT_SSH_COMMAND = "ssh -i /custom/identity"
  try {
    let captured = null
    const spawnGit = (cmd, args, opts) => {
      if (captured === null && opts?.env?.GIT_SSH_COMMAND) captured = opts.env.GIT_SSH_COMMAND
      return spawnSync(cmd, args, opts)
    }
    await syncWorkspace({ scheduleDelivery: noDelivery, root: cloneA, env, spawnGit })
    assert.equal(captured, "ssh -i /custom/identity -o BatchMode=yes")
  } finally {
    if (originalSsh === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = originalSsh
  }
})

test("GIT_SSH_COMMAND defaults to -o BatchMode=yes alone when nothing was already set", async () => {
  const { cloneA } = await mkOriginWithClone()
  const originalSsh = process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH_COMMAND
  try {
    let captured = null
    const spawnGit = (cmd, args, opts) => {
      if (captured === null && opts?.env?.GIT_SSH_COMMAND) captured = opts.env.GIT_SSH_COMMAND
      return spawnSync(cmd, args, opts)
    }
    await syncWorkspace({ scheduleDelivery: noDelivery, root: cloneA, env, spawnGit })
    assert.equal(captured, "ssh -o BatchMode=yes")
  } finally {
    if (originalSsh !== undefined) process.env.GIT_SSH_COMMAND = originalSsh
  }
})

// ---------------------------------------------------------------------------
// Fix round, controller ruling 2: a status-0 `git pull --rebase --autostash`
// is not proof the tree ended up clean -- popping the autostash can itself
// conflict without failing the pull's own exit code. Verified directly with
// real git before writing this test: with a plain dirty (uncommitted, no
// local commit needed) tracked-file edit that collides with an incoming
// fast-forward pull, `git pull --rebase --autostash` prints "Applying
// autostash resulted in conflicts..." yet still exits 0, leaves `UU seed.md`
// in `git status --porcelain`, and does not drop its own stash entry.
// ---------------------------------------------------------------------------

// A clock for the budget test below: a read that does not come from `remaining` sets the deadline (time 0), and the first
// `remaining()` read finds the budget long gone. `checkpoints()` says how many were reached.
function checkpointClock() {
  let reached = 0
  const now = () => {
    if (!new Error().stack.includes("at remaining (")) return 0
    reached += 1
    return 999_999
  }
  return { now, checkpoints: () => reached }
}

function fakeIo() {
  const out = []
  const err = []
  return { stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => err.push(s) }, out, err }
}

test("session start commits a task log entry an earlier server left uncommitted, and starts its delivery", async () => {
  const { cloneA } = await mkOriginWithClone()
  await fs.mkdir(path.join(cloneA, "track", "work"), { recursive: true })
  await writeAndCommit(cloneA, "track/work/task.md", "card\n", "card")
  git(cloneA, ["push", "-q", "origin", "main"])
  // What an older Desk left when its server ended inside the quiet window: the entry written, its commit never made.
  await fs.writeFile(path.join(cloneA, "track", "work", "log.md"), "## 2026-11-15 16:00\n\nRuling: keep it.\n")
  const scheduled = []
  const result = await syncWorkspace({ scheduleDelivery: (options) => scheduled.push(options), root: cloneA, env })
  assert.equal(git(cloneA, ["log", "-1", "--format=%s"]).trim(), "task_update: log track/work")
  assert.equal(git(cloneA, ["status", "--porcelain"]), "")
  assert.equal(result.unpushed.count, 1)
  assert.deepEqual(scheduled.map((options) => options.root), [cloneA])
})

test("syncWorkspace reports sync_deadline_exceeded and never attempts a fetch when the budget is already exhausted", async () => {
  const { cloneA } = await mkOriginWithClone()
  const clock = checkpointClock()
  const now = clock.now
  let fetchCalled = false
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("fetch")) fetchCalled = true
    return spawnSync(cmd, args, opts)
  }
  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root: cloneA, env, spawnGit, now })
  assert.equal(result.state, "unresolved")
  assert.match(result.diagnostic, /sync_deadline_exceeded/u)
  assert.equal(clock.checkpoints(), 1, "the sequence stopped at its first budget checkpoint")
  assert.equal(fetchCalled, false, "no fetch was ever attempted once the budget was already exhausted")
})

test("runSessionSyncCli requires --root (or the DESK env var) and never throws when both are missing", async () => {
  const io = fakeIo()
  const code = await runSessionSyncCli({ argv: [], env: {}, io, syncFn: async () => { throw new Error("must not be called") } })
  assert.equal(code, 0)
  assert.equal(io.out.length, 0)
  assert.match(io.err[0], /--root.*DESK/u)
})

test("runSessionSyncCli answers an unknown flag with one usage line and exit 2, without syncing", async () => {
  const io = fakeIo()
  const code = await runSessionSyncCli({ argv: ["--bogus", "x"], env: {}, io, syncFn: async () => { throw new Error("must not be called") } })
  assert.equal(code, 2)
  assert.equal(io.out.length, 0)
  assert.match(io.err[0], /^session-sync\.js: .*--bogus.*Fix: .*\n$/u)
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

// Boot starts its network checks before the sync and times them with timers. A pull that blocked the event loop held
// those timers back until it returned, and then a check that had long finished read as timed out.
test("syncWorkspace: a slow pull leaves the event loop running", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  git(cloneA, ["push", "-q", "origin", "main"])
  git(cloneB, ["config", "remote.origin.uploadpack", "sleep 1; git-upload-pack"])
  let ticks = 0
  const ticker = setInterval(() => { ticks += 1 }, 50)
  try {
    const result = await syncWorkspace({ scheduleDelivery: noDelivery, root: cloneB, env: {} })
    assert.equal(result.state, "synced")
  } finally {
    clearInterval(ticker)
  }
  assert.ok(ticks >= 5, `the event loop ran during the pull (${ticks} ticks)`)
  assert.ok(existsSync(path.join(cloneB, "more.md")))
})

test("spawnGitAsync: spawnSync's result shape for an exit, a timeout and a spawn failure", async () => {
  const done = await spawnGitAsync(process.execPath, ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"], { timeout: 10000 })
  assert.deepEqual(done, { status: 3, signal: null, stdout: "out", stderr: "err" })
  const slow = await spawnGitAsync(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { timeout: 50 })
  assert.equal(slow.status, null)
  assert.equal(slow.signal, "SIGTERM")
  assert.equal(slow.error.code, "ETIMEDOUT")
  const missing = await spawnGitAsync(path.join(os.tmpdir(), "no-such-git-binary"), [], { timeout: 1000 })
  assert.equal(missing.status, null)
  assert.equal(missing.error.code, "ENOENT")
})

test("syncWorkspace reports sync_deadline_exceeded when the budget runs out during the fetch", async () => {
  const { cloneA } = await mkOriginWithClone()
  let reads = 0
  const now = () => {
    if (!new Error().stack.includes("at remaining (")) return 0
    reads += 1
    return reads <= 2 ? 0 : 999_999
  }
  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root: cloneA, env, now })
  assert.equal(result.state, "unresolved")
  assert.match(result.diagnostic, /sync_deadline_exceeded/u)
})

test("syncWorkspace names an untracked file in the way of what was delivered, and leaves it untouched", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "card.md", "theirs\n", "b card")
  git(cloneB, ["push", "-q", "origin", "main"])
  writeFileSync(path.join(cloneA, "card.md"), "mine\n")

  const result = await syncWorkspace({ scheduleDelivery: noDelivery, root: cloneA, env })
  assert.equal(result.state, "unresolved")
  assert.match(result.diagnostic, /card\.md/u)
  assert.equal(await fs.readFile(path.join(cloneA, "card.md"), "utf8"), "mine\n")
})
