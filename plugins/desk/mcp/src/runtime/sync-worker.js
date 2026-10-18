// The background push worker and its lock (M4-6 "agents never fight the
// desk" Part 3, spec.md §2 "Background push, one retry", controller ruling
// 1). A write tool's own `commitPaths` call is synchronous; pushing the
// result to the remote is not — `schedulePush` hands that off to a fully
// detached, unref'd child process (`mcp/scripts/sync-push.js`) so a push
// outlives the short-lived MCP tool call that scheduled it (Review Focus:
// "the push worker outliving its parent", pinned by this module's own
// tests).
//
// The lock. One file per desk at
// `$XDG_STATE_HOME/ouroboros-skills/desk/sync/<root key>.lock`
// (`resolveDeskStateDir`/`lastStartRootKey`, reused from `runtime/last-
// start.js` — outside the desk, so it can never itself be committed), JSON
// `{ token, pid, start }`, the same shape `boot-checks.cjs`'s own report
// lock writes. Staleness mirrors `readiness/owner-record.js`'s own
// `inspectOwner`: a PID that no longer exists is dead outright; a PID that
// exists but whose recorded start time (`readiness/process-start.js`)
// disagrees with its current one names a different process that reused the
// PID, so the recorded owner is dead too; anything else — no start
// recorded, or a start that cannot be read right now — stays alive, so a
// worker never steals a lock it cannot actually disprove is live. A worker
// that finds a live lock exits quietly: the holder will push everything
// that exists by the time it runs `git push`, so nothing this call
// committed is lost.
//
// The push, once the lock is held: sleep `debounceMs` (letting a burst of
// near-simultaneous commits land before the one push this coalesces them
// into), then loop while there is anything ahead of the upstream: push; on
// rejection, one `git pull --rebase --autostash` retry, then one more push
// (controller ruling 3). A failed rebase, or a still-rejected push after a
// clean one, always ends with `git rebase --abort` so the desk is never
// left mid-rebase, records the blocked state for `desk_status` (`tools/
// status.js`'s `syncStatus`) and queues the detached Desk-problem filer
// (`mcp/scripts/file-desk-problem.js`, mechanism `desk-sync`) — never
// `--force`, and filing is queued, never awaited inline, the same shape
// `boot-checks.cjs`'s detached repair launcher already uses. The loop's
// own re-check of what is ahead, each time through, is what makes the
// holder re-check for new commits before it ever releases the lock, so a
// commit that lands while it is pushing is never left behind.
//
// Every Git call here is bounded by a ~10s timeout and runs with
// `GIT_TERMINAL_PROMPT=0`, so a hung hook, a held lock or a credential
// prompt can never block the worker indefinitely — mirrors `util/git-
// stage.js`'s own `GIT_TIMEOUT_MS`. `spawnGit` is an injectable seam over
// `node:child_process`'s `spawnSync`, for tests only; real callers never
// pass it.

import { randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { lastStartRootKey, resolveDeskStateDir } from "./last-start.js"
import { readProcessStart } from "../readiness/process-start.js"
import { formatDeskProblem } from "./index-drift.js"
import { argvSafeReason } from "./argv-safe-reason.js"
import { shouldLaunchFiler } from "./filer-throttle.js"
import { DESK_TEST_REAL_STATE, assertNotRealStateUnderTest } from "./test-state-guard.js"
import { renameWithRetry } from "../util/rename-retry.js"
import { createGitReader } from "./git-read-worker.js"
import { withDeskMutation, deskMutationScope, notifyDeskPushRelease } from "../util/desk-mutation.js"

const GIT_TIMEOUT_MS = 10_000
export const DEFAULT_DEBOUNCE_MS = 2000

const SYNC_PUSH_SCRIPT = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))
const FILE_DESK_PROBLEM_SCRIPT = fileURLToPath(new URL("../../scripts/file-desk-problem.js", import.meta.url))

// `GIT_SSH_COMMAND` gets the same treatment `GIT_TERMINAL_PROMPT=0` already
// gives the HTTPS credential prompt: `-o BatchMode=yes` disables every
// interactive SSH prompt (a host-key question, a passphrase) so an
// SSH-remote desk can never hang this worker either. A caller's own
// `GIT_SSH_COMMAND` (an already-configured SSH wrapper, a custom identity
// file) is extended, never replaced.
function gitEnv() {
  const existing = process.env.GIT_SSH_COMMAND
  const sshCommand = typeof existing === "string" && existing.trim() !== "" ? `${existing} -o BatchMode=yes` : "ssh -o BatchMode=yes"
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: sshCommand }
}

function run(spawnGit, root, args) {
  return spawnGit("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: GIT_TIMEOUT_MS,
    env: gitEnv(),
  })
}

// ---------------------------------------------------------------------------
// The lock.
// ---------------------------------------------------------------------------

/** Where this root's sync lock lives — outside the desk, so it is never itself a path a commit could touch. */
export function resolveSyncLockPath({ root, env }) {
  return path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(root)}.lock`)
}

/** Where Desk's last successful fetch time for this root is recorded: its own file, so that write never rewrites the pull record. */
function fetchOkPath({ root, env }) {
  return path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(root)}.fetch-ok.json`)
}

/** Where this root's last sync outcome is recorded, for `desk_status` to read (never a network call — see status.js). */
export function syncStatusPath({ root, env }) {
  return path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(root)}.status.json`)
}

function tryCreateExclusive(file, bytes) {
  try {
    writeFileSync(file, bytes, { flag: "wx", mode: 0o600 })
    return true
  } catch {
    return false
  }
}

function readJsonIfPresent(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return null
  }
}

/**
 * Whether the owner a lock record names is still running: mirrors `owner-
 * record.js`'s `inspectOwner` staleness rule exactly (a dead PID is the only
 * thing that disproves liveness; anything unverifiable stays "alive" so a
 * worker never steals a lock it cannot actually show is dead).
 */
async function isLockLive(record, processStart, kill) {
  try {
    kill(record.pid, 0)
  } catch {
    return false
  }
  if (typeof record.start !== "string" || record.start === "") return true
  const current = await processStart(record.pid)
  if (current === null) return true
  return current === record.start
}

function releaseSyncLock(lockPath, token) {
  try {
    if (JSON.parse(readFileSync(lockPath, "utf8")).token === token) unlinkSync(lockPath)
  } catch {
    // Already gone, or now held by someone else's lock: either way, nothing more to do.
  }
}

/**
 * Acquires the sync lock for `root`, or resolves `null` when a live worker
 * already holds it (the contention rule: exit quietly, the holder will push
 * whatever exists by the time it runs). A lock whose owner is no longer
 * running is taken over — by a fresh exclusive create when it has already
 * been released, or a compare-and-write when it is still there and provably
 * stale. Never throws — including when the state guard refuses a real,
 * non-temp state home under what looks like a node:test run, which resolves
 * `{ refused: true }` instead (a session launched under any `node --test`
 * inherits `NODE_TEST_CONTEXT`, so this must degrade, not crash the detached
 * worker — Review Focus, `sync_worker.test.js`).
 */
export async function acquireSyncLock({
  root, env, pid = process.pid, processStart = readProcessStart, readLock = readJsonIfPresent, kill = process.kill, createOnly = false,
}) {
  const lockPath = resolveSyncLockPath({ root, env })
  try {
    assertNotRealStateUnderTest(path.dirname(lockPath), { env })
  } catch (error) {
    // istanbul ignore next -- assertNotRealStateUnderTest's own contract is "throws an Error with
    // .code = DESK_TEST_REAL_STATE; never throws otherwise", so this rethrow has no other error to see.
    if (error.code !== DESK_TEST_REAL_STATE) throw error
    return { refused: true }
  }
  mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const start = await processStart(pid)
  const bytes = `${JSON.stringify({ token, pid, start })}\n`

  if (tryCreateExclusive(lockPath, bytes)) return { token, release: () => releaseSyncLock(lockPath, token) }
  if (createOnly) return null

  const existing = readLock(lockPath)
  if (existing !== null && (await isLockLive(existing, processStart, kill))) return null

  // Stale (or now unreadable): take over, but only if the file has not
  // changed since the moment we judged it stale — a narrow, best-effort
  // compare-and-write, the same spirit as every other lock in this codebase.
  // `readLock` reads the real lock file by default; tests inject a stub to
  // simulate exactly this race deterministically.
  const before = existing === null ? null : JSON.stringify(existing)
  const now = readLock(lockPath)
  if (before !== null && (now === null || JSON.stringify(now) !== before)) return null

  const temporary = `${lockPath}.${token}.tmp`
  writeFileSync(temporary, bytes, { mode: 0o600 })
  renameSync(temporary, lockPath)
  return { token, release: () => releaseSyncLock(lockPath, token) }
}

// ---------------------------------------------------------------------------
// Local Git reads the worker (and `desk_status`) use — never a network call.
// ---------------------------------------------------------------------------

/** True when `root` has at least one Git remote configured. */
export function hasRemoteConfigured(root, spawnGit) {
  const result = run(spawnGit, root, ["remote"])
  return result.status === 0 && result.stdout.trim() !== ""
}

/** `{ ahead, behind }` against the current branch's upstream, or `null` when there is none (no push target). */
export function aheadBehindCounts({ root, spawnGit }) {
  const result = run(spawnGit, root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"])
  if (result.status !== 0 || typeof result.stdout !== "string") return null
  return parseAheadBehind(result.stdout)
}

function parseAheadBehind(stdout) {
  const [behind, ahead] = stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10))
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 }
}

// The same two reads without blocking the caller's thread: desk_status runs on the thread that answers the host, and starting a Git process there holds every other request until the operating system has created it, even through an asynchronous call (see git-read-worker.js). A read that cannot run answers as a failed one.
/** Says once, on stderr, that the Git read worker cannot run: its failed reads look the same as a desk with no remote. */
export function reportGitReadFailure(reason) {
  process.stderr.write(`[desk-mcp] sync status: ${reason}. desk_status treats a Git read that cannot run as failed, so it may report "no remote configured" for a desk that has a remote.\n`)
}

const gitReads = createGitReader({ onError: reportGitReadFailure })

// `signal` is the status run that asks. Once it aborts, the read throws its reason instead of answering: a read that was killed or never started looks the same as a desk with no remote, and that must not reach a status payload.
async function runAsync(root, args, signal) {
  signal?.throwIfAborted()
  const result = await gitReads.read({ root, args, env: gitEnv(), timeoutMs: GIT_TIMEOUT_MS }, { signal })
  signal?.throwIfAborted()
  return result
}

/** Start the Git read worker now, so a status run's first read does not wait for it. desk_status answers from a 90 ms budget, and a worker started at the first read spent most of it. */
export function warmStatusGitReads() {
  gitReads.warm()
}

/** Resolves when no Git read asked with `signal` is still running. */
export function waitForStatusGitReads(signal) {
  return gitReads.settled(signal)
}

export async function hasRemoteConfiguredAsync(root, { signal } = {}) {
  const result = await runAsync(root, ["remote"], signal)
  return result.status === 0 && result.stdout.trim() !== ""
}

export async function aheadBehindCountsAsync({ root, signal }) {
  const result = await runAsync(root, ["rev-list", "--left-right", "--count", "@{u}...HEAD"], signal)
  return result.status === 0 ? parseAheadBehind(result.stdout) : null
}

function canPush(root, spawnGit) {
  return hasRemoteConfigured(root, spawnGit) && aheadBehindCounts({ root, spawnGit }) !== null
}

function conflictedPaths(root, spawnGit) {
  const result = run(spawnGit, root, ["diff", "--name-only", "--diff-filter=U"])
  if (result.status !== 0 || typeof result.stdout !== "string") return []
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "")
}

// The number of stash entries `root` currently has — used only to notice a
// `git stash pop` that silently failed to drop its own entry (below).
export function stashCount(root, spawnGit) {
  const result = run(spawnGit, root, ["stash", "list"])
  if (result.status !== 0 || typeof result.stdout !== "string") return 0
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length
}

function abortRebase(root, spawnGit) {
  // Best-effort safety net: harmless (and ignored) when there is no rebase in progress.
  run(spawnGit, root, ["rebase", "--abort"])
}

/**
 * One push attempt with the one allowed retry (controller ruling 3): a
 * rejection gets exactly one `git pull --rebase --autostash`, then one more
 * push. A failed rebase, or a push still rejected after a clean one, always
 * leaves the repo not mid-rebase — never `--force`.
 *
 * A status-0 pull is not proof the tree actually ended up clean (fix round):
 * `git pull --rebase --autostash` can exit 0 even when popping its own
 * autostash conflicts — the rebase step itself finished, but the stash pop
 * leaves UU conflict markers and keeps the stash entry rather than failing
 * the pull's own exit code. `conflictedPaths` catches a pop that left
 * merge-conflict markers; `stashCount` growing catches the other shape (an
 * untracked file colliding with one the stash would restore), which leaves
 * the stash entry behind with no UU marker at all.
 */
function pushWithRetry(root, spawnGit) {
  if (run(spawnGit, root, ["push"]).status === 0) return { result: "ok" }
  const stashBefore = stashCount(root, spawnGit)
  const pulled = run(spawnGit, root, ["pull", "--rebase", "--autostash"])
  if (pulled.status !== 0) {
    const paths = conflictedPaths(root, spawnGit)
    abortRebase(root, spawnGit)
    return { result: "blocked", reason: "pull_rebase_failed", paths }
  }
  const stashConflictPaths = conflictedPaths(root, spawnGit)
  if (stashConflictPaths.length > 0 || stashCount(root, spawnGit) > stashBefore) {
    abortRebase(root, spawnGit)
    return { result: "blocked", reason: "autostash_pop_conflict", paths: stashConflictPaths }
  }
  if (run(spawnGit, root, ["push"]).status === 0) return { result: "ok" }
  abortRebase(root, spawnGit)
  return { result: "blocked", reason: "push_rejected_after_rebase", paths: [] }
}

// ---------------------------------------------------------------------------
// Recording the outcome for `desk_status`, and filing a Desk problem.
// ---------------------------------------------------------------------------

// Never throws: a status write that cannot be persisted -- an unwritable folder, or, under a node:test run, the
// state guard refusing a real, non-temp state home -- costs the next reader a recorded status, never a crash. A
// caller (`runPushWorker`, `finalUnpushedCheck`) that has already computed its own answer from Git still returns
// that answer; only the recording is best-effort.
//
// The read-merge-write runs under a short-lived lock file beside the status file (`<file>.lock`, made with an exclusive
// create, which is atomic on every platform Desk runs on), so two writers (a push worker and a boot sync) cannot each
// read the same old record and have the later rename drop the earlier one's fields. The file is also replaced
// atomically (a temp file, then a rename), so a reader never sees a half-written record. The lock never blocks for
// long: a writer waits at most `waitMs`, takes over a lock older than `STATUS_LOCK_STALE_MS` (its holder died; the
// critical section is a few milliseconds), and if the lock is still held after the wait it writes anyway, because a
// missed status update is a smaller harm than a hung boot or tool call. `fetchOkPath`'s fetch time keeps its own file.
const STATUS_LOCK_STALE_MS = 5000
const STATUS_LOCK_WAIT_MS = 1500

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Takes `lockFile` or returns `null` once `waitMs` has passed without getting it. Never throws. */
function acquireStatusLock(lockFile, waitMs) {
  const deadline = Date.now() + waitMs
  for (;;) {
    try {
      closeSync(openSync(lockFile, "wx", 0o600))
      return lockFile
    } catch {
      try {
        if (Date.now() - statSync(lockFile).mtimeMs > STATUS_LOCK_STALE_MS) unlinkSync(lockFile)
      } catch {
        // Gone already, or not removable: the next attempt decides.
      }
    }
    if (Date.now() >= deadline) return null
    sleepSync(5)
  }
}

// Handoff routing is authoritative pending state, unlike best-effort health
// telemetry. Its existing status-file lock must never time out into a write or
// steal an old/unknown owner. This is not a stale-lock recovery mechanism.
function acquireStrictStatusLock(file, waitMs) {
  const deadline = Date.now() + waitMs
  for (;;) {
    let fd
    try {
      fd = openSync(file, "wx", 0o600)
      const identity = fstatSync(fd)
      const token = randomUUID()
      writeFileSync(fd, token)
      return { file, identity, token }
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
    if (Date.now() >= deadline) throw new Error("Push handoff status is busy; no unfenced update was made")
    sleepSync(5)
  }
}

function assertStrictStatusLock(lock) {
  const found = lstatSync(lock.file)
  if (!found.isFile() || found.nlink !== 1 || found.dev !== lock.identity.dev || found.ino !== lock.identity.ino ||
      readFileSync(lock.file, "utf8") !== lock.token) throw new Error("Push handoff status owner changed; cleanup refused")
}

function readStrictStatus(file) {
  let identity
  try { identity = lstatSync(file) } catch (error) {
    if (error.code === "ENOENT") return { data: {}, assertUnchanged() {
      try { lstatSync(file) } catch (absent) { if (absent.code === "ENOENT") return; throw absent }
      throw new Error("Push handoff status appeared during its update")
    } }
    throw error
  }
  if (!identity.isFile() || identity.nlink !== 1) throw new Error("Unsafe push handoff status file")
  const text = readFileSync(file, "utf8")
  const data = JSON.parse(text)
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid push handoff status")
  return { data, assertUnchanged() {
    const found = lstatSync(file)
    if (!found.isFile() || found.nlink !== 1 || found.dev !== identity.dev || found.ino !== identity.ino ||
        readFileSync(file, "utf8") !== text) throw new Error("Push handoff status changed outside its owner")
  } }
}

/** Reads, merges `patch` into and atomically replaces the JSON file at `file`, under the lock described above. */
export function updateSyncStatus(root, env, patch, file = syncStatusPath({ root, env }), { waitMs = STATUS_LOCK_WAIT_MS, strict = false } = {}) {
  try {
    assertNotRealStateUnderTest(path.dirname(file), { env })
  } catch (error) {
    // istanbul ignore next -- assertNotRealStateUnderTest's own contract is "throws an Error with
    // .code = DESK_TEST_REAL_STATE; never throws otherwise", so this rethrow has no other error to see.
    if (error.code !== DESK_TEST_REAL_STATE) throw error
    return null
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const lock = strict ? acquireStrictStatusLock(`${file}.lock`, waitMs) : acquireStatusLock(`${file}.lock`, waitMs)
  try {
    if (strict) assertStrictStatusLock(lock)
    const previous = strict ? readStrictStatus(file) : null
    const current = previous?.data ?? readJsonIfPresent(file) ?? {}
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch }
    const temporary = `${file}.${randomUUID()}.tmp`
    writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600, ...(strict ? { flag: "wx" } : {}) })
    if (strict) {
      assertStrictStatusLock(lock)
      previous.assertUnchanged()
    }
    renameWithRetry(temporary, file)
    return next
  } finally {
    if (strict) {
      assertStrictStatusLock(lock)
      unlinkSync(lock.file)
    } else if (lock !== null) {
      try {
        unlinkSync(lock)
      } catch {
        // Already taken over as stale; nothing to release.
      }
    }
  }
}

/**
 * Records how the last desk sync (`syncWorkspace`'s pull) ended, for `desk_status`'s one health word: a failed pull
 * changes no ahead/behind count, so without this record `desk_status` reads "in sync" beside a boot that said
 * `degraded`. A synced outcome clears the record; so does a later successful push. A pull that really happened also
 * records `last_success_at`, which boot shows as "local desk is as of": FETCH_HEAD cannot say that, because a failed
 * fetch touches it too. A desk with nothing to sync against records no success time. Best effort, never throws.
 */
export function recordPullOutcome({ root, env, result }) {
  try {
    const failed = result?.state === "unresolved"
    const at = new Date().toISOString()
    updateSyncStatus(root, env, {
      last_pull: failed ? { state: "unresolved", reason: result.reason ?? null, cause: result.cause ?? null, at } : null,
      ...(failed || result?.nothingToSync ? {} : { last_success_at: at }),
    })
  } catch {
    // The record is a convenience for the next reader, never a reason to fail a sync.
  }
}

/**
 * Records that Desk's own fetch of the desk's remote succeeded (`fastForwardStateBranch`), as `last_fetch_ok_at`, in its
 * own file (`fetchOkPath`) so it can never overwrite the pull record with a stale copy. `at` is when the fetch STARTED
 * (ISO text): a pull that failed after the fetch began is not proven reachable by it. `desk_status` counts it as
 * proof of reachability only for a failure caused by reachability. It is Desk's own record, not Git's `FETCH_HEAD`,
 * which a failed fetch rewrites too. Best effort, never throws.
 */
export function recordFetchOk({ root, env, at }) {
  try {
    updateSyncStatus(root, env, { last_fetch_ok_at: at }, fetchOkPath({ root, env }))
  } catch {
    // The record is a convenience for the next reader, never a reason to fail a fetch.
  }
}

/** When Desk's last successful fetch started (ISO text), or `null`. Never throws. */
export function readFetchOkAt({ root, env }) {
  return readJsonIfPresent(fetchOkPath({ root, env }))?.last_fetch_ok_at ?? null
}

/** `desk_status`'s own read of the worker's last recorded outcome, or `null` when nothing has run yet. Never throws. */
export function readSyncStatus({ root, env }) {
  return readJsonIfPresent(syncStatusPath({ root, env }))
}

function text(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null
}

/**
 * Queues the detached Desk-problem filer (mechanism `desk-sync`) — the same
 * "launch it, never await it inline" shape `boot-checks.cjs`'s own
 * detached repair launcher uses for the identical reason: a real filing
 * attempt is an account lookup plus `gh` calls that can run for tens of
 * seconds, and this worker has already done its job by the time a push is
 * blocked. Never throws — a failure to even launch the filer must never
 * become a new failure of its own. `reason` and `host` are always supplied
 * by this module's own one caller (`runPushWorker`, below); `spawnImpl` is a
 * test seam only — every test injects one, since the real default really
 * shells out toward `gh` and could actually file a GitHub issue.
 *
 * `reason`'s raw text never becomes an argument on the detached filer's own
 * command line unredacted (fix round, spec.md §1 Part 5): `ps` shows a
 * process's argv to every account on the machine, not just this session, so
 * it is narrowed through `argvSafeReason` first, the same way `boot-
 * checks.cjs`'s own filing call sites already do. `shouldLaunchFiler`
 * throttles the actual *spawn* to once per hour per reason, matching `boot-
 * checks.cjs`'s own cooldown — the caller still gets a `file` field back
 * either way, since a filing that is merely deduped is not itself a new
 * failure to report.
 */
export function queueDeskProblemFiling({ root, env, reason, host, spawnImpl }) {
  const safeReason = argvSafeReason(reason)
  if (!shouldLaunchFiler({ env, mechanism: "desk-sync", signature: safeReason })) {
    return { file: "filing already queued (within the last hour)" }
  }
  try {
    // istanbul ignore next -- see the doc comment above: the real default is
    // exercised only by the real filer in production, never by a test.
    const spawnChild = spawnImpl ?? spawn
    const child = spawnChild(process.execPath, [
      FILE_DESK_PROBLEM_SCRIPT,
      "--mechanism", "desk-sync",
      "--reason", safeReason,
      "--host", host,
      "--fix-attempt", "retried once with git pull --rebase --autostash, then pushed again",
    ], { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Never let filing itself become a new failure.
  }
  return { file: "filing in background" }
}

/**
 * The host to name when filing a Desk problem: `CLAUDE_PLUGIN_ROOT`, set only
 * by Claude Code's own launcher, or `"unknown"` otherwise. Unlike `factory-context.js`'s
 * `factoryPluginScan`, `DESK_PLUGIN_ROOT` locates a plugin root on every host
 * (Claude included), so it is not a reliable "this is Copilot" signal, and a
 * filed problem naming the wrong host is worse than one that says it does
 * not know.
 */
export function hostFromEnv(env) {
  return text(env.CLAUDE_PLUGIN_ROOT) !== null ? "claude" : "unknown"
}

// ---------------------------------------------------------------------------
// The worker itself.
// ---------------------------------------------------------------------------

const REAL_CLOCK = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

function handoffRoutes(status) {
  if (Object.keys(status).length === 0) return []
  if (Object.keys(status).some((key) => !["push_handoff_version", "release_handoffs", "handoff_epoch"].includes(key)) ||
      status.push_handoff_version !== 1 || !Array.isArray(status.release_handoffs) ||
      (status.handoff_epoch !== undefined && (!Number.isSafeInteger(status.handoff_epoch) || status.handoff_epoch < 0)) ||
      status.release_handoffs.some((item) => !item || typeof item.root !== "string" || !path.isAbsolute(item.root) ||
        typeof item.state_home !== "string" || !path.isAbsolute(item.state_home) ||
        Object.keys(item).some((key) => !["root", "state_home"].includes(key)))) throw new Error("Unqualified push release handoff state")
  return status.release_handoffs
}

const handoffKey = (item) => `${item.root}\0${item.state_home}`

async function requestPushRelease(root, env) {
  const scope = await deskMutationScope(root)
  const item = { root: path.resolve(root), state_home: path.resolve(path.dirname(path.dirname(resolveDeskStateDir({ env })))) }
  const result = updateSyncStatus(root, env, (current) => {
    const routes = new Map(handoffRoutes(current).map((entry) => [handoffKey(entry), entry]))
    routes.set(handoffKey(item), item)
    return { push_handoff_version: 1, handoff_epoch: current.handoff_epoch ?? 0, release_handoffs: [...routes.values()] }
  }, scope.pushStatus, { strict: true })
  if (result === null) throw new Error("Push release handoff state was refused")
}

/**
 * A coalesced normal-release notification, not a task/job ledger or recovery
 * route. A fresh canonical claim and create-only sync reservations fence the
 * transfer. No existing canonical or sync claim is removed to make it happen.
 * `claim` is a source-owned closure from desk-mutation, never tool JSON.
 */
export async function continuePushHandoffs({ scope, claim, schedule = schedulePush }) {
  if (handoffRoutes(readStrictStatus(scope.pushStatus).data).length === 0) return
  let state = updateSyncStatus(scope.root, process.env, (current) => {
    handoffRoutes(current)
    const epoch = current.handoff_epoch ?? 0
    if (epoch === Number.MAX_SAFE_INTEGER) throw new Error("Push handoff notification epoch is exhausted")
    return { ...current, handoff_epoch: epoch + 1 }
  }, scope.pushStatus, { strict: true })
  if (state === null) throw new Error("Push handoff notification was refused")
  for (;;) {
    const epoch = state.handoff_epoch
    await transferPushHandoffs({ scope, claim, schedule })
    state = readStrictStatus(scope.pushStatus).data
    if (handoffRoutes(state).length === 0 || (state.handoff_epoch ?? 0) === epoch) return
    // A real owner/worker release raced a failed attempt behind this drainer's
    // short claim. Retry that notification; do not poll an unchanged owner.
  }
}

async function transferPushHandoffs({ scope, claim, schedule }) {
  const reserved = []
  try {
    await claim(async () => {
      const current = handoffRoutes(readStrictStatus(scope.pushStatus).data)
      for (const item of current) {
        if ((await deskMutationScope(item.root)).file !== scope.file) throw new Error("Push handoff crosses its canonical mutation scope")
        // Only state routing is persisted. Credentials, HOME and tool input are
        // never copied into the slot or changed for the continuing worker.
        const env = { ...process.env, XDG_STATE_HOME: item.state_home }
        const lock = await acquireSyncLock({ root: item.root, env, createOnly: true })
        if (lock?.refused) throw new Error("Push handoff sync reservation was refused")
        if (lock === null) continue
        reserved.push({ item, env, lock })
      }
      if (reserved.length === 0) return
      const selected = new Set(reserved.map(({ item }) => handoffKey(item)))
      const result = updateSyncStatus(scope.root, process.env, (latest) => ({
        push_handoff_version: 1,
        handoff_epoch: latest.handoff_epoch ?? 0,
        release_handoffs: handoffRoutes(latest).filter((item) => !selected.has(handoffKey(item))),
      }), scope.pushStatus, { strict: true })
      if (result === null) throw new Error("Push handoff transfer was refused")
    })
  } catch (error) {
    for (const { lock } of reserved) lock.release()
    if (error.code === "desk_mutation_busy") return
    const failures = [error]
    for (const { item, env } of reserved) {
      try { await requestPushRelease(item.root, env) } catch (restore) { failures.push(restore) }
    }
    if (failures.length > 1) throw new AggregateError(failures, `Push handoff transfer and pending-state restoration failed: ${failures.map((failure) => failure.message).join("; ")}`)
    throw error
  }
  // Both the old worker's sync lock and this drainer's canonical claim must
  // have ended before launch. Reservations prevent a different expiring worker
  // from registering a coalesced request that this transfer could erase.
  const scheduled = new Set()
  try {
    for (const { item, env, lock } of reserved) {
      lock.release()
      const result = schedule({ root: item.root, env })
      if (!result.scheduled) throw new Error(`Push continuation could not be scheduled: ${result.error}`)
      scheduled.add(handoffKey(item))
    }
  } catch (error) {
    const failures = [error]
    for (const { item, env } of reserved) {
      if (!scheduled.has(handoffKey(item))) {
        try { await requestPushRelease(item.root, env) } catch (restore) { failures.push(restore) }
      }
    }
    if (failures.length > 1) throw new AggregateError(failures, `Push continuation and pending-state restoration failed: ${failures.map((failure) => failure.message).join("; ")}`)
    throw error
  } finally {
    for (const { lock } of reserved) lock.release()
  }
}

/**
 * Runs the whole worker cycle for `root`: acquire the lock (exit quietly on
 * contention), skip entirely when there is no remote or no upstream (never
 * an error — controller ruling 2), otherwise debounce, then push (with the
 * one retry) in a loop that keeps re-checking what is ahead until nothing
 * is. Live canonical contention is retried for a bounded interval; a timeout
 * or unqualified owner retains `pending_push` in the existing sync status.
 * Unexpected I/O/ownership failures reject rather than acknowledge a push.
 * A lock refused under a node:test run returns
 * (`result: "test_isolation_refused"`, logged to `stderr` rather than left
 * silent), which `runSyncPushCli`/`sync-push.js` still resolve to exit code
 * 0 for, the same as `"busy"`, `"pending"` or `"skipped"`. `clock`, `spawnGit`,
 * `fileProblem` and `stderr` are test seams.
 */
export async function runPushWorker({
  root, env = process.env, debounceMs = DEFAULT_DEBOUNCE_MS, spawnGit = spawnSync, clock = REAL_CLOCK, fileProblem = queueDeskProblemFiling,
  stderr = process.stderr, mutationWaitMs = 30_000,
}) {
  const deadline = performance.now() + Math.max(0, mutationWaitMs)
  const pushCurrent = async (assertHeld) => {
    let pushed = false
    for (;;) {
      await assertHeld()
      const counts = aheadBehindCounts({ root, spawnGit })
      if (counts === null) {
        updateSyncStatus(root, env, { blocked: true, reason: "push_counts_unavailable", paths: [], pending_push: true })
        return { result: "pending", reason: "push_counts_unavailable" }
      }
      if (counts.ahead <= 0) {
        const patch = { blocked: false, reason: null, paths: [], pending_push: false }
        if (pushed) {
          patch.last_push_at = new Date().toISOString()
          patch.last_pull = null
        }
        updateSyncStatus(root, env, patch)
        return { result: "ok" }
      }
      const attempt = pushWithRetry(root, spawnGit)
      if (attempt.result === "ok") {
        pushed = true
        continue
      }
      updateSyncStatus(root, env, { blocked: true, reason: attempt.reason, paths: attempt.paths, pending_push: true, at: new Date().toISOString() })
      fileProblem({ root, env, reason: attempt.reason, host: hostFromEnv(env) })
      return { result: "blocked", reason: attempt.reason }
    }
  }
  for (;;) {
    const lock = await acquireSyncLock({ root, env })
    if (lock?.refused) {
      stderr.write(`Desk sync worker: refused the real state folder under what looks like a node:test run (${DESK_TEST_REAL_STATE}); not pushing this cycle.\n`)
      return { result: "test_isolation_refused" }
    }
    if (lock === null) return { result: "busy" }
    let outcome
    try {
      if (!canPush(root, spawnGit)) return { result: "skipped" }
      await clock.sleep(debounceMs)
      for (;;) {
        try {
          outcome = await withDeskMutation(root, pushCurrent)
          break
        } catch (error) {
          if (error.code !== "desk_mutation_busy") throw error
          const qualified = error.owner_state === "live" || error.owner_state === "absent"
          const reason = qualified ? "canonical_mutation_busy" : "mutation_owner_unqualified"
          updateSyncStatus(root, env, { blocked: true, reason, paths: [], pending_push: true })
          const remaining = deadline - performance.now()
          if (!qualified) return { result: "pending", reason }
          if (remaining <= 0) {
            await requestPushRelease(root, env)
            return { result: "pending", reason }
          }
          await clock.sleep(Math.min(100, remaining))
        }
      }
    } finally {
      lock.release()
      await notifyDeskPushRelease(root)
    }
    // A canonical writer can commit after the final claim release but before
    // sync-lock release. Its schedule records pending BEFORE launching another
    // worker, so coalescing cannot erase that last handoff.
    if (outcome.result !== "ok" || !readSyncStatus({ root, env })?.pending_push) return outcome
    debounceMs = 0
  }
}

// ---------------------------------------------------------------------------
// Scheduling: a synchronous, fire-and-forget hand-off to a detached worker.
// ---------------------------------------------------------------------------

/**
 * Starts `sync-push.js` detached with ignored stdio and returns without
 * waiting for it. `detached: true` plus `unref()` is what actually lets the
 * child outlive this process on exit (Review Focus: "the push worker
 * outliving its parent") — exported so that contract is asserted directly,
 * not just inferred from a slower end-to-end test. `spawnImpl` is a test seam.
 */
export function defaultSpawnWorker({ root, env, debounceMs, spawnImpl = spawn }) {
  const child = spawnImpl(process.execPath, [SYNC_PUSH_SCRIPT, "--root", root, "--debounce-ms", String(debounceMs)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env,
  })
  child.on("error", () => {})
  child.unref()
}

/**
 * Schedules a push for `root` after a successful commit (controller ruling
 * 2): fire-and-forget, never awaited by the caller, and never throws — the
 * MCP tool call this runs inside must never wait on the push. The actual
 * debounce, lock and retry logic all run in the detached worker this spawns
 * (`defaultSpawnWorker` → `mcp/scripts/sync-push.js` → `runPushWorker`
 * above), never in this process, so a push already scheduled survives this
 * call's own process exiting before the debounce window elapses (Review
 * Focus, pinned by `sync_worker.test.js`). `spawnWorker` is a test seam.
 */
export function schedulePush({ root, env = process.env, debounceMs = DEFAULT_DEBOUNCE_MS, spawnWorker = defaultSpawnWorker }) {
  let pendingRecorded = false
  let pendingError
  try {
    pendingRecorded = updateSyncStatus(root, env, { pending_push: true }) !== null
  } catch (error) {
    pendingError = error.message
  }
  try {
    spawnWorker({ root, env, debounceMs })
    return { scheduled: true, pending_recorded: pendingRecorded, ...(pendingError ? { pending_error: pendingError } : {}) }
  } catch (error) {
    return { scheduled: false, pending_recorded: pendingRecorded, error: error.message, ...(pendingError ? { pending_error: pendingError } : {}) }
  }
}

// ---------------------------------------------------------------------------
// The detached script's own CLI surface (`mcp/scripts/sync-push.js`).
// ---------------------------------------------------------------------------

function parseSyncPushArgs(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (typeof key !== "string" || !key.startsWith("--")) throw new Error(`sync-push.js: unexpected argument ${JSON.stringify(key ?? "")}`)
    options.set(key.slice(2), argv[index + 1])
  }
  return options
}

/**
 * The detached worker script's whole CLI surface, kept here so it is
 * unit-tested directly rather than through a subprocess — the script itself
 * is one line, the same shape as `file-desk-problem.js`'s own
 * `runFileDeskProblemCli`. `runWorker` is a test seam.
 */
export async function runSyncPushCli({ argv = process.argv.slice(2), env = process.env, runWorker = runPushWorker } = {}) {
  const options = parseSyncPushArgs(argv)
  const root = options.get("root")
  if (typeof root !== "string" || root === "") throw new Error("sync-push.js: --root <path> is required")
  const debounceMs = Number.parseInt(options.get("debounce-ms") ?? "", 10)
  await runWorker({ root, env, debounceMs: Number.isFinite(debounceMs) ? debounceMs : DEFAULT_DEBOUNCE_MS })
  return 0
}

// ---------------------------------------------------------------------------
// SessionEnd/sessionEnd's own safety net (`hooks/sync-end.cjs`).
// ---------------------------------------------------------------------------

/**
 * The one check `sync-end.cjs` runs at genuine session end (spec.md's
 * "offline rule": a push failure never re-raises on every turn — only once,
 * at genuine session end, if the desk still has unpushed commits then).
 * Purely local: `hasRemoteConfigured` plus one `git rev-list` against the
 * already-known upstream, never a network call and never a push attempt of
 * its own — the background worker alone owns pushing, and a hook that
 * reached for the real filer here would risk the exact hang `runtime/host-
 * enforcement-registration.js`'s own header warns about (a slow `gh` call
 * eating a hook's whole timeout budget).
 *
 * Never files (plan.md Part 3 Task 2 — "emits the plain diagnostic, never
 * files"): a session ending before its own scheduled push finished isn't
 * itself evidence of a defect — the detached worker may simply still be
 * running, independent of this process's exit — so this only records the
 * fact for `desk_status`'s `syncStatus` to surface next time (never
 * clobbering a more specific reason the worker itself already recorded) and
 * returns an honest, unfiled `Desk problem:` block for a filer its callers
 * can't afford to reach synchronously. Never throws.
 */
export function finalUnpushedCheck({ root, env, spawnGit = spawnSync }) {
  if (!hasRemoteConfigured(root, spawnGit)) return { state: "clean" }
  const counts = aheadBehindCounts({ root, spawnGit })
  if (counts === null || counts.ahead <= 0) return { state: "clean" }

  const existing = readSyncStatus({ root, env })
  const reason = existing?.blocked && typeof existing.reason === "string" ? existing.reason : "unpushed_at_session_end"
  if (!existing?.blocked) {
    updateSyncStatus(root, env, { blocked: true, reason, paths: existing?.paths ?? [], at: new Date().toISOString() })
  }

  const diagnostic = formatDeskProblem({
    mechanism: "desk-sync",
    symptom: "commits still unpushed at session end",
    broke: `${counts.ahead} commit(s) ahead of the upstream with no successful push recorded (${reason})`,
    means: "this desk's latest work is committed locally but has not reached the remote; another session or machine won't see it yet",
    fix: "not auto-repaired here — the background push worker retries on the next write, or push manually with `git push`",
    file: "not filed: session end is a safety net, not itself evidence of a defect",
    tell: "Run desk_status and check its sync section before assuming this work is shared elsewhere.",
  })
  return { state: "unpushed", diagnostic }
}
