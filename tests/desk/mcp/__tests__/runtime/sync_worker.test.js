// sync-worker.js — the background push worker and its lock (M4-6 "agents
// never fight the desk" Part 3, spec.md §2 "Background push, one retry").
//
// Real synthetic Git repos throughout (a bare origin plus one or more
// clones), per spec.md §7 — not mocked command shapes, except for the
// specific race windows and forced-rejection paths that real Git cannot be
// made to hit deterministically (the lock's compare-and-write race, and a
// push still rejected after an already-clean rebase), which use a scripted
// `spawnGit`/`readLock` seam that falls through to the real command for
// everything it does not deliberately intercept.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { spawnSync } from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"
import { mkFakeRealRoot } from "../_fake_real_root.js"
import { lastStartRootKey, resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { DESK_TEST_REAL_STATE } from "../../../../../plugins/desk/mcp/src/runtime/test-state-guard.js"
import {
  DEFAULT_DEBOUNCE_MS,
  acquireSyncLock,
  aheadBehindCounts,
  aheadBehindCountsAsync,
  defaultSpawnWorker,
  finalUnpushedCheck,
  hasRemoteConfigured,
  hasRemoteConfiguredAsync,
  hostFromEnv,
  queueDeskProblemFiling,
  readSyncStatus,
  resolveSyncLockPath,
  runPushWorker,
  runSyncPushCli,
  schedulePush,
  stashCount,
  syncStatusPath,
} from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"

const instantClock = { sleep: () => Promise.resolve() }
const dead = () => { throw Object.assign(new Error("ESRCH"), { code: "ESRCH" }) }

function git(root, args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`)
  return result.stdout
}

async function mkPlainRepo() {
  const root = await mkTempRoot("desk-sync-worker-plain-")
  git(root, ["init", "-q"])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  return root
}

async function mkBareOrigin() {
  const root = await mkTempRoot("desk-sync-worker-origin-")
  git(root, ["init", "--bare", "-q"])
  return root
}

async function mkClone(originDir, label, { trackMain = false } = {}) {
  const root = await mkTempRoot(`desk-sync-worker-${label}-`)
  git(root, ["clone", "-q", originDir, "."])
  git(root, ["config", "user.email", "test@example.com"])
  git(root, ["config", "user.name", "Test"])
  // Never rely on the ambient `init.defaultBranch`: name the branch directly, the same way for every fixture.
  if (trackMain) git(root, ["checkout", "-q", "-B", "main", "origin/main"])
  else git(root, ["symbolic-ref", "HEAD", "refs/heads/main"])
  return root
}

async function writeAndCommit(root, name, content, message) {
  await fs.writeFile(path.join(root, name), content)
  git(root, ["add", "--", name])
  git(root, ["commit", "-q", "-m", message])
}

async function mkOriginWithClone() {
  const origin = await mkBareOrigin()
  const cloneA = await mkClone(origin, "a")
  await writeAndCommit(cloneA, "seed.md", "seed\n", "seed")
  git(cloneA, ["push", "-q", "-u", "origin", "main"])
  return { origin, cloneA }
}

function originCommitCount(origin) {
  return git(origin, ["log", "--oneline", "main"]).trim().split("\n").filter(Boolean).length
}

function writeLockFile(root, env, record) {
  const file = resolveSyncLockPath({ root, env })
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, `${JSON.stringify(record)}\n`)
  return file
}

function readLockFile(root, env) {
  return JSON.parse(readFileSync(resolveSyncLockPath({ root, env }), "utf8"))
}

// ---------------------------------------------------------------------------
// Path resolution.
// ---------------------------------------------------------------------------

test("resolveSyncLockPath and syncStatusPath live under the desk state directory, keyed by the root", async () => {
  const root = await mkTempRoot("desk-sync-worker-paths-")
  const env = process.env
  assert.equal(resolveSyncLockPath({ root, env }), path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(root)}.lock`))
  assert.equal(syncStatusPath({ root, env }), path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(root)}.status.json`))
})

// ---------------------------------------------------------------------------
// The lock.
// ---------------------------------------------------------------------------

test("under a node:test run, acquireSyncLock refuses a real (non-temp) state home rather than writing to it, without throwing", async (t) => {
  // Fix round for PR #101 (review: CHANGES NEEDED). The reviewer reproduced a crash: acquireSyncLock used to reject
  // with DESK_TEST_REAL_STATE here, uncaught all the way through runPushWorker and the detached sync-push.js worker's
  // own top-level await, so a real session launched under any `node --test` (NODE_TEST_CONTEXT is inherited by every
  // child process) would crash instead of silently skipping a push cycle. Ruling (a): the guard now degrades locally
  // to `{ refused: true }`, a third sentinel distinct from both a normal `{ token, release }` lock and the `null`
  // "busy" contention result, so runPushWorker can tell the two apart and treat a refusal as "could not run this
  // cycle", never a crash.
  //
  // A HOME that genuinely exists and is genuinely writable, but sits outside the OS temp directory: stands in for
  // the developer's real home, so a lock file landing here would be exactly the incident the guard exists to stop.
  const fakeReal = mkFakeRealRoot("desk-sync-worker-fake-real-")
  t.after(() => fs.rm(fakeReal, { recursive: true, force: true, maxRetries: 5 }))
  const lock = await acquireSyncLock({ root: "/some/desk-root", env: { HOME: fakeReal } })
  assert.deepEqual(lock, { refused: true })
  assert.equal(existsSync(path.join(fakeReal, ".local")), false, "the guard refuses before creating anything under the fake real home")
})

test("acquireSyncLock creates a fresh lock file, and release() removes it", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  const lock = await acquireSyncLock({ root, env: process.env })
  assert.notEqual(lock, null)
  const record = readLockFile(root, process.env)
  assert.equal(record.token, lock.token)
  assert.equal(record.pid, process.pid)
  lock.release()
  assert.equal(existsSync(resolveSyncLockPath({ root, env: process.env })), false)
})

test("release() is a no-op, without throwing, once the lock file is already gone", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  const lock = await acquireSyncLock({ root, env: process.env })
  lock.release()
  assert.doesNotThrow(() => lock.release())
})

test("release() leaves a different token's lock alone", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  const lock = await acquireSyncLock({ root, env: process.env })
  writeLockFile(root, process.env, { token: "someone-else", pid: process.pid, start: null })
  lock.release()
  assert.equal(readLockFile(root, process.env).token, "someone-else")
})

test("a second acquire on a still-live root returns null: the contention rule is to exit quietly", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  const first = await acquireSyncLock({ root, env: process.env })
  const second = await acquireSyncLock({ root, env: process.env })
  assert.notEqual(first, null)
  assert.equal(second, null)
  first.release()
})

test("a lock whose recorded owner is no longer running is taken over", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(root, process.env, { token: "stale", pid: 4242, start: "whatever" })
  const lock = await acquireSyncLock({ root, env: process.env, kill: dead })
  assert.notEqual(lock, null)
  assert.notEqual(readLockFile(root, process.env).token, "stale")
  lock.release()
})

test("a lock with no recorded start, or an empty one, is treated as alive and not taken over", async () => {
  const rootA = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(rootA, process.env, { token: "no-start", pid: process.pid })
  assert.equal(await acquireSyncLock({ root: rootA, env: process.env }), null)

  const rootB = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(rootB, process.env, { token: "empty-start", pid: process.pid, start: "" })
  assert.equal(await acquireSyncLock({ root: rootB, env: process.env }), null)
})

test("a lock whose recorded start no longer matches its pid's current start (a reused pid) is taken over", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(root, process.env, { token: "reused-pid", pid: process.pid, start: "not-the-real-start" })
  const lock = await acquireSyncLock({ root, env: process.env })
  assert.notEqual(lock, null)
  lock.release()
})

test("a lock whose current start cannot be read is treated as alive and not taken over", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(root, process.env, { token: "unreadable-start", pid: process.pid, start: "whatever" })
  const result = await acquireSyncLock({ root, env: process.env, processStart: async () => null })
  assert.equal(result, null)
})

test("a corrupt (unparseable) lock file is treated as already gone, and taken over", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  const file = resolveSyncLockPath({ root, env: process.env })
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeFileSync(file, "not json")
  const lock = await acquireSyncLock({ root, env: process.env })
  assert.notEqual(lock, null)
  lock.release()
})

test("the takeover re-confirms the lock has not changed since the staleness check, aborting when it has", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(root, process.env, { token: "placeholder", pid: 4242, start: "x" }) // forces the fast create-exclusive path to fail
  const staleRecord = { token: "stale", pid: 4242, start: "x" }
  const racedInRecord = { token: "raced-in", pid: 4242, start: "x" }
  let calls = 0
  const readLock = () => (calls++ === 0 ? staleRecord : racedInRecord)
  assert.equal(await acquireSyncLock({ root, env: process.env, readLock, kill: dead }), null)
})

test("the takeover aborts when the lock disappears between the staleness check and the write", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(root, process.env, { token: "placeholder", pid: 4242, start: "x" })
  const staleRecord = { token: "stale", pid: 4242, start: "x" }
  let calls = 0
  const readLock = () => (calls++ === 0 ? staleRecord : null)
  assert.equal(await acquireSyncLock({ root, env: process.env, readLock, kill: dead }), null)
})

test("the takeover proceeds when the lock is unchanged between the staleness check and the write", async () => {
  const root = await mkTempRoot("desk-sync-worker-lock-")
  writeLockFile(root, process.env, { token: "placeholder", pid: 4242, start: "x" })
  const staleRecord = { token: "stale", pid: 4242, start: "x" }
  const readLock = () => staleRecord
  const lock = await acquireSyncLock({ root, env: process.env, readLock, kill: dead })
  assert.notEqual(lock, null)
  assert.equal(readLockFile(root, process.env).token, lock.token)
  lock.release()
})

// ---------------------------------------------------------------------------
// Local reads: remote/upstream and ahead/behind.
// ---------------------------------------------------------------------------

test("hasRemoteConfigured and aheadBehindCounts reflect real remote/upstream state, never a network call", async () => {
  const plain = await mkPlainRepo()
  assert.equal(hasRemoteConfigured(plain, spawnSync), false)
  assert.equal(aheadBehindCounts({ root: plain, spawnGit: spawnSync }), null)

  const { cloneA } = await mkOriginWithClone()
  assert.equal(hasRemoteConfigured(cloneA, spawnSync), true)
  assert.deepEqual(aheadBehindCounts({ root: cloneA, spawnGit: spawnSync }), { ahead: 0, behind: 0 })

  await writeAndCommit(cloneA, "x.md", "x\n", "x")
  assert.deepEqual(aheadBehindCounts({ root: cloneA, spawnGit: spawnSync }), { ahead: 1, behind: 0 })
})

test("the asynchronous remote and upstream reads give the same answers as the synchronous ones, and a missing folder reads as no remote", async () => {
  const plain = await mkPlainRepo()
  assert.equal(await hasRemoteConfiguredAsync(plain), false)
  assert.equal(await aheadBehindCountsAsync({ root: plain }), null)

  const { cloneA } = await mkOriginWithClone()
  assert.equal(await hasRemoteConfiguredAsync(cloneA), true)
  assert.deepEqual(await aheadBehindCountsAsync({ root: cloneA }), { ahead: 0, behind: 0 })
  await writeAndCommit(cloneA, "y.md", "y\n", "y")
  assert.deepEqual(await aheadBehindCountsAsync({ root: cloneA }), { ahead: 1, behind: 0 })

  assert.equal(await hasRemoteConfiguredAsync(path.join(plain, "no-such-folder")), false)
})

test("aheadBehindCounts falls back to 0 for any count it cannot parse as a number", () => {
  const stub = () => ({ status: 0, stdout: "not-a-number\tnope\n" })
  assert.deepEqual(aheadBehindCounts({ root: "/x", spawnGit: stub }), { ahead: 0, behind: 0 })
})

// ---------------------------------------------------------------------------
// hostFromEnv.
// ---------------------------------------------------------------------------

test("hostFromEnv names claude only when CLAUDE_PLUGIN_ROOT is a real value, else unknown", () => {
  assert.equal(hostFromEnv({}), "unknown")
  assert.equal(hostFromEnv({ CLAUDE_PLUGIN_ROOT: "   " }), "unknown")
  assert.equal(hostFromEnv({ CLAUDE_PLUGIN_ROOT: "/x" }), "claude")
})

// ---------------------------------------------------------------------------
// queueDeskProblemFiling.
// ---------------------------------------------------------------------------

// A fresh, throwaway HOME per test -- never `process.env` itself, whose own
// `XDG_STATE_HOME` is one shared directory for this whole test-file run (set
// once by `_isolated_env.mjs`), which would let one test's throttle stamp
// leak into a sibling test using the same mechanism+reason pair. Matches
// `filer_throttle.test.js`'s own `fixtureEnv` exactly.
function fixtureFilerEnv(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-sync-worker-filer-"))
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }))
  return { HOME: root }
}

test("queueDeskProblemFiling spawns the detached filer with mechanism desk-sync and the given reason/host", (t) => {
  let captured = null
  const spawnImpl = (cmd, args, opts) => {
    captured = { cmd, args, opts }
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => {} }
  }
  const env = fixtureFilerEnv(t)
  queueDeskProblemFiling({ root: "/some/root", env, reason: "pull_rebase_failed", host: "claude", spawnImpl })
  assert.equal(captured.cmd, process.execPath)
  assert.ok(captured.args.includes("--mechanism"))
  assert.ok(captured.args.includes("desk-sync"))
  assert.ok(captured.args.includes("--reason"))
  assert.ok(captured.args.includes("pull_rebase_failed"))
  assert.ok(captured.args.includes("--host"))
  assert.ok(captured.args.includes("claude"))
  assert.ok(captured.args.includes("--fix-attempt"))
  assert.equal(captured.opts.detached, true)
  assert.equal(captured.opts.stdio, "ignore")
  assert.equal(captured.opts.cwd, "/some/root")
  assert.equal(captured.opts.env, env)
})

test("queueDeskProblemFiling never throws, even when the spawn implementation itself throws", (t) => {
  assert.doesNotThrow(() => queueDeskProblemFiling({ root: "/x", env: fixtureFilerEnv(t), reason: "x", host: "unknown", spawnImpl: () => { throw new Error("boom") } }))
})

// Fix round, spec.md §1 Part 5: `reason`'s raw text must never reach the
// spawned filer's own argv unredacted -- `ps` shows a process's argv to every
// account on the machine. A path-shaped reason here mirrors `boot-checks.cjs`'s
// own filer-argv redaction test (`boot_checks_error_skip.test.js`).
test("queueDeskProblemFiling redacts a path-shaped reason out of the spawned filer's own argv", (t) => {
  let captured = null
  const spawnImpl = (cmd, args, opts) => {
    captured = { cmd, args, opts }
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => {} }
  }
  const rawReason = "boom: failed to read /Users/ari/personal-desk/track/task/notes.md"
  queueDeskProblemFiling({ root: "/some/root", env: fixtureFilerEnv(t), reason: rawReason, host: "claude", spawnImpl })
  const reasonIndex = captured.args.indexOf("--reason")
  assert.ok(reasonIndex >= 0)
  const safeReason = captured.args[reasonIndex + 1]
  assert.doesNotMatch(safeReason, /\/Users\//u)
  assert.doesNotMatch(safeReason, /personal-desk/u)
  assert.ok(!captured.args.some((arg) => typeof arg === "string" && arg.includes("/Users/ari")))
})

// Fix round, spec.md §1 Part 5: `shouldLaunchFiler` throttles the actual spawn
// to once per hour per mechanism+reason pair -- the caller still reports a
// `file` field either way.
test("queueDeskProblemFiling does not launch a second filer for the same reason within the cooldown", (t) => {
  const env = fixtureFilerEnv(t)
  let spawnCalls = 0
  const spawnImpl = () => {
    spawnCalls += 1
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => {} }
  }
  const first = queueDeskProblemFiling({ root: "/some/root", env, reason: "pull_rebase_failed", host: "claude", spawnImpl })
  const second = queueDeskProblemFiling({ root: "/some/root", env, reason: "pull_rebase_failed", host: "claude", spawnImpl })
  assert.equal(spawnCalls, 1, "only the first call actually spawns")
  assert.deepEqual(first, { file: "filing in background" })
  assert.deepEqual(second, { file: "filing already queued (within the last hour)" })
})

// ---------------------------------------------------------------------------
// defaultSpawnWorker and schedulePush.
// ---------------------------------------------------------------------------

test("defaultSpawnWorker starts sync-push.js detached, with ignored stdio, and unrefs it", () => {
  let captured = null
  let unrefed = false
  const spawnImpl = (cmd, args, opts) => {
    captured = { cmd, args, opts }
    return { on: (event, handler) => { if (event === "error") handler(new Error("unused")) }, unref: () => { unrefed = true } }
  }
  defaultSpawnWorker({ root: "/some/root", env: { A: "1" }, debounceMs: 1234, spawnImpl })
  assert.equal(captured.cmd, process.execPath)
  assert.ok(captured.args.includes("--root"))
  assert.ok(captured.args.includes("/some/root"))
  assert.ok(captured.args.includes("--debounce-ms"))
  assert.ok(captured.args.includes("1234"))
  assert.equal(captured.opts.detached, true)
  assert.equal(captured.opts.stdio, "ignore")
  assert.equal(unrefed, true, "detached + unref is what lets the child outlive this process")
})

test("schedulePush hands off to spawnWorker synchronously, and never throws even if it throws", () => {
  let called = null
  schedulePush({ root: "/r", env: { A: "1" }, debounceMs: 99, spawnWorker: (args) => { called = args } })
  assert.deepEqual(called, { root: "/r", env: { A: "1" }, debounceMs: 99 })
  assert.doesNotThrow(() => schedulePush({ root: "/r", spawnWorker: () => { throw new Error("boom") } }))
})

test("Review Focus: schedulePush returns immediately, and the real detached worker pushes on its own afterward", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")

  const startedAt = Date.now()
  schedulePush({ root: cloneA, env: process.env, debounceMs: 50 })
  const elapsed = Date.now() - startedAt
  assert.ok(elapsed < 1000, `schedulePush must not wait on the worker it starts (took ${elapsed}ms)`)

  const deadline = Date.now() + 15_000
  let pushed = false
  while (Date.now() < deadline) {
    if (originCommitCount(origin) === 2) { pushed = true; break }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  assert.ok(pushed, "the detached worker eventually pushed the commit to origin, entirely on its own")
})

// ---------------------------------------------------------------------------
// runPushWorker.
// ---------------------------------------------------------------------------

test("runPushWorker exits quietly (busy) without pushing when another worker already holds the lock", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "extra.md", "extra\n", "extra")
  const held = await acquireSyncLock({ root: cloneA, env: process.env })
  assert.notEqual(held, null)

  let pushCalled = false
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("push")) pushCalled = true
    return spawnSync(cmd, args, opts)
  }
  const result = await runPushWorker({ root: cloneA, env: process.env, spawnGit, clock: instantClock })
  assert.deepEqual(result, { result: "busy" })
  assert.equal(pushCalled, false)
  assert.equal(originCommitCount(origin), 1, "nothing was pushed while busy")
  held.release()
})

test("under a node:test run, runPushWorker treats a refused lock as a non-throwing 'could not run' result, and logs it to stderr rather than staying silent", async (t) => {
  // Fix round for PR #101 (review: CHANGES NEEDED). Ruling (a) and (b) together: a refused lock is a third outcome
  // distinct from both a normal push and "busy" (another worker holds the lock) -- runPushWorker must resolve, not
  // reject, and the refusal must be visible on stderr rather than silently swallowed, even though the CLI's own
  // stdio is ignored in production (defaultSpawnWorker's real spawn uses `stdio: "ignore"`; this only matters to a
  // caller -- a test, a manual invocation -- that inspects this process's stderr directly).
  const fakeReal = mkFakeRealRoot("desk-sync-worker-runworker-fake-real-")
  t.after(() => fs.rm(fakeReal, { recursive: true, force: true, maxRetries: 5 }))
  const written = []
  const stderr = { write: (chunk) => { written.push(chunk) } }
  const result = await runPushWorker({ root: "/some/desk-root", env: { HOME: fakeReal }, clock: instantClock, stderr })
  assert.deepEqual(result, { result: "test_isolation_refused" })
  assert.equal(written.length, 1)
  assert.match(written[0], /test_isolation_refused|DESK_TEST_REAL_STATE/u)
  assert.match(written[0], new RegExp(DESK_TEST_REAL_STATE, "u"))
  assert.equal(existsSync(path.join(fakeReal, ".local")), false, "the guard refuses before creating anything under the fake real home")
})

test("runPushWorker skips (no error) when there is no remote configured", async () => {
  const root = await mkPlainRepo()
  await writeAndCommit(root, "a.md", "a\n", "a")
  const result = await runPushWorker({ root, env: process.env, clock: instantClock })
  assert.deepEqual(result, { result: "skipped" })
  assert.equal(readSyncStatus({ root, env: process.env }), null)
})

test("runPushWorker skips (no error) when a remote exists but there is no upstream", async () => {
  const root = await mkPlainRepo()
  const origin = await mkBareOrigin()
  git(root, ["remote", "add", "origin", origin])
  await writeAndCommit(root, "a.md", "a\n", "a")
  const result = await runPushWorker({ root, env: process.env, clock: instantClock })
  assert.deepEqual(result, { result: "skipped" })
})

test("runPushWorker records blocked:false and does nothing when nothing is ahead of the upstream", async () => {
  const { cloneA } = await mkOriginWithClone()
  // Deliberately omits `env` (exercises its own default, `process.env`) and `clock` (exercises the real
  // clock); debounceMs is overridden to 0 to keep the real sleep negligible.
  const result = await runPushWorker({ root: cloneA, debounceMs: 0 })
  assert.deepEqual(result, { result: "ok" })
  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status.blocked, false)
  assert.equal(Object.hasOwn(status, "last_push_at"), false)
})

test("runPushWorker pushes a real ahead commit, records last_push_at, and preserves it across a later no-op", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  const before = Date.now()

  const result = await runPushWorker({ root: cloneA, env: process.env, clock: instantClock })
  assert.deepEqual(result, { result: "ok" })
  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status.blocked, false)
  assert.equal(typeof status.last_push_at, "string")
  assert.ok(Date.parse(status.last_push_at) >= before)
  assert.equal(originCommitCount(origin), 2, "the commit really reached origin")

  const again = await runPushWorker({ root: cloneA, env: process.env, clock: instantClock })
  assert.deepEqual(again, { result: "ok" })
  const status2 = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status2.last_push_at, status.last_push_at, "a later no-op must not erase the last recorded push")
})

test("runPushWorker retries once via pull --rebase --autostash and pushes, after a non-conflicting rejection", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "from-b.md", "b\n", "from b")
  git(cloneB, ["push", "-q", "origin", "main"])

  await writeAndCommit(cloneA, "from-a.md", "a\n", "from a") // diverges from origin, but touches a different file

  const result = await runPushWorker({ root: cloneA, env: process.env, clock: instantClock })
  assert.deepEqual(result, { result: "ok" })
  assert.equal(originCommitCount(origin), 3, "seed + from-b + from-a all landed")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-merge")), false)
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-apply")), false)
})

test("runPushWorker aborts the rebase and reports blocked with the conflicted paths when the retry pull conflicts", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await fs.writeFile(path.join(cloneB, "seed.md"), "seed from b\n")
  git(cloneB, ["commit", "-q", "-am", "b edits seed"])
  git(cloneB, ["push", "-q", "origin", "main"])

  await fs.writeFile(path.join(cloneA, "seed.md"), "seed from a\n")
  git(cloneA, ["commit", "-q", "-am", "a edits seed"])

  let filed = null
  const result = await runPushWorker({
    root: cloneA, env: process.env, clock: instantClock,
    fileProblem: (args) => { filed = args },
  })
  assert.deepEqual(result, { result: "blocked", reason: "pull_rebase_failed" })

  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status.blocked, true)
  assert.equal(status.reason, "pull_rebase_failed")
  assert.deepEqual(status.paths, ["seed.md"])

  assert.notEqual(filed, null)
  assert.equal(filed.reason, "pull_rebase_failed")

  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-merge")), false, "never left mid-rebase")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-apply")), false, "never left mid-rebase")
  assert.equal(spawnSync("git", ["-C", cloneA, "status", "--porcelain"], { encoding: "utf8" }).stdout, "")
  assert.equal(originCommitCount(origin), 2, "never force-pushed: origin still only has seed + b's edit")
})

test("stashCount reports the real number of stash entries, and 0 when the list command itself fails", async () => {
  const { cloneA } = await mkOriginWithClone()
  assert.equal(stashCount(cloneA, spawnSync), 0)
  await fs.writeFile(path.join(cloneA, "seed.md"), "seed\nlocal edit\n")
  git(cloneA, ["stash", "push", "-u"])
  assert.equal(stashCount(cloneA, spawnSync), 1)
  assert.equal(stashCount(cloneA, () => ({ status: 1, stdout: "" })), 0)
})

// GIT_SSH_COMMAND (fix round, controller ruling 4): every git call disables
// interactive SSH prompts too, the same way GIT_TERMINAL_PROMPT=0 already
// disables the HTTPS one, extending rather than replacing any value the
// caller's own environment already set.
test("every git call extends an already-set GIT_SSH_COMMAND with -o BatchMode=yes, rather than replacing it", async () => {
  const root = await mkPlainRepo()
  const originalSsh = process.env.GIT_SSH_COMMAND
  process.env.GIT_SSH_COMMAND = "ssh -i /custom/identity"
  try {
    let captured = null
    const spawnGit = (cmd, args, opts) => {
      if (captured === null) captured = opts.env.GIT_SSH_COMMAND
      return spawnSync(cmd, args, opts)
    }
    hasRemoteConfigured(root, spawnGit)
    assert.equal(captured, "ssh -i /custom/identity -o BatchMode=yes")
  } finally {
    if (originalSsh === undefined) delete process.env.GIT_SSH_COMMAND
    else process.env.GIT_SSH_COMMAND = originalSsh
  }
})

test("GIT_SSH_COMMAND defaults to -o BatchMode=yes alone when nothing was already set", async () => {
  const root = await mkPlainRepo()
  const originalSsh = process.env.GIT_SSH_COMMAND
  delete process.env.GIT_SSH_COMMAND
  try {
    let captured = null
    const spawnGit = (cmd, args, opts) => {
      if (captured === null) captured = opts.env.GIT_SSH_COMMAND
      return spawnSync(cmd, args, opts)
    }
    hasRemoteConfigured(root, spawnGit)
    assert.equal(captured, "ssh -o BatchMode=yes")
  } finally {
    if (originalSsh !== undefined) process.env.GIT_SSH_COMMAND = originalSsh
  }
})

// Fix round, controller ruling 2: a status-0 `git pull --rebase --autostash`
// is not proof the tree ended up clean -- popping the autostash can itself
// conflict without failing the pull's own exit code. Verified directly with
// real git before writing this test: after a rejected push, `git pull
// --rebase --autostash` prints "Applying autostash resulted in conflicts..."
// yet still exits 0, leaves `UU seed.md` in `git status --porcelain`, and
// does not drop its own stash entry.
test("runPushWorker treats a pull that succeeds but leaves its own autostash pop conflicted as blocked, and never force-pushes", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "seed.md", "seed\nfrom origin\n", "origin edits seed")
  git(cloneB, ["push", "-q"])

  // An unrelated committed change makes cloneA's own push get rejected as
  // behind; an *uncommitted* working-tree edit to the very file origin just
  // changed is what autostash then fails to pop cleanly.
  await writeAndCommit(cloneA, "mine.md", "mine\n", "mine")
  await fs.writeFile(path.join(cloneA, "seed.md"), "seed\nfrom A working tree\n")

  let filed = null
  const result = await runPushWorker({
    root: cloneA, env: process.env, clock: instantClock,
    fileProblem: (args) => { filed = args },
  })
  assert.deepEqual(result, { result: "blocked", reason: "autostash_pop_conflict" })

  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status.blocked, true)
  assert.equal(status.reason, "autostash_pop_conflict")
  assert.deepEqual(status.paths, ["seed.md"])

  assert.notEqual(filed, null)
  assert.equal(filed.reason, "autostash_pop_conflict")

  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-merge")), false, "never left mid-rebase")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-apply")), false, "never left mid-rebase")
  assert.match(git(cloneA, ["status", "--porcelain"]), /^UU seed\.md/mu, "the stash-pop conflict is real, left on disk exactly as real git leaves it")
  assert.match(git(cloneA, ["stash", "list"]), /autostash/u, "the stash entry is deliberately not dropped, exactly as real git leaves it")
  assert.equal(originCommitCount(origin), 2, "never force-pushed: origin still only has seed + b's edit")
})

// The other shape `stashCount` growing guards against (an untracked file
// colliding with one the stash would restore, which leaves no UU marker at
// all) is not reliably reproducible with real git in one deterministic step,
// so -- exactly as this file's own header reserves scripted `spawnGit` for
// ("forced-rejection paths that real Git cannot be made to hit
// deterministically") -- this exercises it directly instead.
test("runPushWorker also treats a stash count that grew without leaving UU markers as an autostash pop conflict", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  const cloneB = await mkClone(origin, "b", { trackMain: true })
  await writeAndCommit(cloneB, "other.md", "other\n", "other")
  git(cloneB, ["push", "-q"])
  await writeAndCommit(cloneA, "mine.md", "mine\n", "mine") // cloneA's own push is rejected as behind

  let stashListCalls = 0
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("diff") && args.includes("--diff-filter=U")) return { status: 0, stdout: "" }
    if (args.includes("stash") && args.includes("list")) {
      stashListCalls += 1
      return { status: 0, stdout: stashListCalls <= 1 ? "" : "stash@{0}: autostash\n" }
    }
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await runPushWorker({
    root: cloneA, env: process.env, clock: instantClock, spawnGit,
    fileProblem: (args) => { filed = args },
  })
  assert.deepEqual(result, { result: "blocked", reason: "autostash_pop_conflict" })
  assert.equal(filed.reason, "autostash_pop_conflict")
  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status.reason, "autostash_pop_conflict")
  assert.deepEqual(status.paths, [])
})

test("a conflicted-paths lookup that itself fails leaves the blocked report with an empty path list", async () => {
  const { cloneA } = await (async () => {
    const origin = await mkBareOrigin()
    const a = await mkClone(origin, "a")
    await writeAndCommit(a, "seed.md", "seed\n", "seed")
    git(a, ["push", "-q", "-u", "origin", "main"])
    const b = await mkClone(origin, "b", { trackMain: true })
    await fs.writeFile(path.join(b, "seed.md"), "seed from b\n")
    git(b, ["commit", "-q", "-am", "b edits seed"])
    git(b, ["push", "-q", "origin", "main"])
    return { origin, cloneA: a }
  })()
  await fs.writeFile(path.join(cloneA, "seed.md"), "seed from a\n")
  git(cloneA, ["commit", "-q", "-am", "a edits seed"])

  const spawnGit = (cmd, args, opts) => {
    if (args.includes("diff") && args.includes("--diff-filter=U")) return { status: 1, stdout: "", stderr: "boom" }
    return spawnSync(cmd, args, opts)
  }
  const result = await runPushWorker({
    root: cloneA, env: process.env, clock: instantClock, spawnGit, fileProblem: () => {},
  })
  assert.equal(result.reason, "pull_rebase_failed")
  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.deepEqual(status.paths, [])
})

test("runPushWorker aborts the rebase defensively and reports blocked when the push is still rejected after a clean rebase", async () => {
  const { cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")

  let pushCalls = 0
  const spawnGit = (cmd, args, opts) => {
    if (args.includes("push")) {
      pushCalls += 1
      return { status: 1, stdout: "", stderr: "! [rejected]" }
    }
    return spawnSync(cmd, args, opts)
  }
  let filed = null
  const result = await runPushWorker({
    root: cloneA, env: process.env, clock: instantClock, spawnGit,
    fileProblem: (args) => { filed = args },
  })
  assert.deepEqual(result, { result: "blocked", reason: "push_rejected_after_rebase" })
  assert.equal(pushCalls, 2, "the one allowed retry, no more")
  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status.reason, "push_rejected_after_rebase")
  assert.deepEqual(status.paths, [])
  assert.equal(filed.reason, "push_rejected_after_rebase")
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-merge")), false)
  assert.equal(existsSync(path.join(cloneA, ".git", "rebase-apply")), false)
})

test("the loop re-checks for new commits before releasing the lock, so a commit made mid-push is not left behind", async () => {
  const { origin, cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "first.md", "first\n", "first")

  let pushCalls = 0
  const spawnGit = (cmd, args, opts) => {
    const result = spawnSync(cmd, args, opts)
    if (args.includes("push") && result.status === 0) {
      pushCalls += 1
      if (pushCalls === 1) {
        // Simulate a second commit landing in the window between this push finishing and the loop's own re-check.
        writeFileSync(path.join(cloneA, "second.md"), "second\n")
        git(cloneA, ["add", "--", "second.md"])
        git(cloneA, ["commit", "-q", "-m", "second"])
      }
    }
    return result
  }
  const result = await runPushWorker({ root: cloneA, env: process.env, clock: instantClock, spawnGit })
  assert.deepEqual(result, { result: "ok" })
  assert.equal(pushCalls, 2, "the loop pushed again for the commit that landed mid-push")
  assert.equal(originCommitCount(origin), 3, "seed + first + second all reached origin in one worker run")
})

// ---------------------------------------------------------------------------
// runSyncPushCli.
// ---------------------------------------------------------------------------

test("runSyncPushCli requires --root", async () => {
  await assert.rejects(runSyncPushCli({ argv: [], env: {} }), /--root/)
})

test("runSyncPushCli rejects a malformed argument", async () => {
  await assert.rejects(runSyncPushCli({ argv: [42, "x"], env: {} }), /unexpected argument/)
  await assert.rejects(runSyncPushCli({ argv: ["notflag", "x"], env: {} }), /unexpected argument/)
  await assert.rejects(runSyncPushCli({ argv: [undefined, "x"], env: {} }), /unexpected argument ""/)
})

test("runSyncPushCli parses --root and --debounce-ms and passes them to runWorker", async () => {
  let called = null
  const exitCode = await runSyncPushCli({
    argv: ["--root", "/x", "--debounce-ms", "500"],
    env: { A: "1" },
    runWorker: async (args) => { called = args },
  })
  assert.equal(exitCode, 0)
  assert.deepEqual(called, { root: "/x", env: { A: "1" }, debounceMs: 500 })
})

test("runSyncPushCli falls back to DEFAULT_DEBOUNCE_MS when --debounce-ms is omitted or unparseable", async () => {
  let called = null
  await runSyncPushCli({ argv: ["--root", "/x"], env: {}, runWorker: async (args) => { called = args } })
  assert.equal(called.debounceMs, DEFAULT_DEBOUNCE_MS)

  await runSyncPushCli({ argv: ["--root", "/x", "--debounce-ms", "nope"], env: {}, runWorker: async (args) => { called = args } })
  assert.equal(called.debounceMs, DEFAULT_DEBOUNCE_MS)
})

// ---------------------------------------------------------------------------
// finalUnpushedCheck (sync-end.cjs's own SessionEnd/sessionEnd safety net).
// ---------------------------------------------------------------------------

test("finalUnpushedCheck reports clean with no remote configured", async () => {
  const root = await mkPlainRepo()
  await writeAndCommit(root, "a.md", "a\n", "a")
  assert.deepEqual(finalUnpushedCheck({ root, env: process.env }), { state: "clean" })
})

test("finalUnpushedCheck reports clean when a remote exists but there is no upstream", async () => {
  const root = await mkPlainRepo()
  const origin = await mkBareOrigin()
  git(root, ["remote", "add", "origin", origin])
  await writeAndCommit(root, "a.md", "a\n", "a")
  assert.deepEqual(finalUnpushedCheck({ root, env: process.env }), { state: "clean" })
})

test("finalUnpushedCheck reports clean when nothing is ahead of the upstream", async () => {
  const { cloneA } = await mkOriginWithClone()
  assert.deepEqual(finalUnpushedCheck({ root: cloneA, env: process.env }), { state: "clean" })
})

test("finalUnpushedCheck reports unpushed and records a fresh blocked status when nothing was recorded yet", async () => {
  const { cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  assert.equal(readSyncStatus({ root: cloneA, env: process.env }), null)

  const result = finalUnpushedCheck({ root: cloneA, env: process.env })
  assert.equal(result.state, "unpushed")
  assert.match(result.diagnostic, /Desk problem: desk-sync/)
  assert.match(result.diagnostic, /unpushed_at_session_end/)
  assert.match(result.diagnostic, /file: not filed:/)

  const status = readSyncStatus({ root: cloneA, env: process.env })
  assert.equal(status.blocked, true)
  assert.equal(status.reason, "unpushed_at_session_end")
  assert.deepEqual(status.paths, [])
})

test("finalUnpushedCheck preserves a more specific reason and paths the worker already recorded, without overwriting them", async () => {
  const { cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  const recordedAt = new Date(0).toISOString()
  const seeded = { blocked: true, reason: "pull_rebase_failed", paths: ["conflict.md"], at: recordedAt }
  const statusFile = syncStatusPath({ root: cloneA, env: process.env })
  mkdirSync(path.dirname(statusFile), { recursive: true, mode: 0o700 })
  writeFileSync(statusFile, `${JSON.stringify(seeded)}\n`)

  const result = finalUnpushedCheck({ root: cloneA, env: process.env })
  assert.equal(result.state, "unpushed")
  assert.match(result.diagnostic, /pull_rebase_failed/)
  assert.deepEqual(readSyncStatus({ root: cloneA, env: process.env }), seeded, "an already-blocked status is left exactly as the worker recorded it")
})

test("finalUnpushedCheck falls back to its own reason when an existing blocked status has none", async () => {
  const { cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  const statusFile = syncStatusPath({ root: cloneA, env: process.env })
  mkdirSync(path.dirname(statusFile), { recursive: true, mode: 0o700 })
  writeFileSync(statusFile, `${JSON.stringify({ blocked: true })}\n`)

  const result = finalUnpushedCheck({ root: cloneA, env: process.env })
  assert.match(result.diagnostic, /unpushed_at_session_end/)
  assert.deepEqual(readSyncStatus({ root: cloneA, env: process.env }), { blocked: true }, "an already-blocked status is never rewritten, even with no reason of its own")
})

test("under a node:test run, finalUnpushedCheck still reports unpushed even though its own status write is refused", async (t) => {
  // Fix round for PR #101 (review: CHANGES NEEDED). Ruling (b): finalUnpushedCheck computes "unpushed" straight from
  // Git, independent of whether it manages to record that in the status file; a status write that cannot be
  // persisted -- an unwritable folder, or here, the state guard refusing a real, non-temp state home under what
  // looks like a node:test run -- must never be reported as "unavailable" just because the write failed. It used to
  // reject with DESK_TEST_REAL_STATE here (the same uncaught-crash shape as acquireSyncLock, since updateSyncStatus
  // had the identical unguarded throw); now the write degrades to a no-op and finalUnpushedCheck's own git-derived
  // answer is untouched. Only the state directory is faked; the Git root stays a real, temp-based fixture.
  const { cloneA } = await mkOriginWithClone()
  await writeAndCommit(cloneA, "more.md", "more\n", "more")
  const fakeReal = mkFakeRealRoot("desk-sync-worker-status-fake-real-")
  t.after(() => fs.rm(fakeReal, { recursive: true, force: true, maxRetries: 5 }))
  const env = { HOME: fakeReal }
  const result = finalUnpushedCheck({ root: cloneA, env })
  assert.equal(result.state, "unpushed")
  assert.match(result.diagnostic, /Desk problem: desk-sync/)
  assert.match(result.diagnostic, /unpushed_at_session_end/)
  assert.equal(existsSync(path.join(fakeReal, ".local")), false, "the guard refuses before creating anything under the fake real home; the status write is best-effort only")
})
