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
// `boot-checks.cjs`'s own `hostEnforcementCheck` already uses. The loop's
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
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { lastStartRootKey, resolveDeskStateDir } from "./last-start.js"
import { readProcessStart } from "../readiness/process-start.js"
import { formatDeskProblem } from "./index-drift.js"
import { argvSafeReason } from "./argv-safe-reason.js"
import { shouldLaunchFiler } from "./filer-throttle.js"
import { DESK_TEST_REAL_STATE, assertNotRealStateUnderTest } from "./test-state-guard.js"

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
  root, env, pid = process.pid, processStart = readProcessStart, readLock = readJsonIfPresent, kill = process.kill,
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
  const [behind, ahead] = result.stdout.trim().split(/\s+/u).map((value) => Number.parseInt(value, 10))
  return { ahead: Number.isFinite(ahead) ? ahead : 0, behind: Number.isFinite(behind) ? behind : 0 }
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
// The read-merge-write is not locked: the file is replaced atomically (a temp file, then a rename), so a reader never
// sees a half-written record, but two writers racing (a push worker and a boot sync) are last-writer-wins and one
// patch can be lost. That is accepted: every field here is a hint that the next sync or push rewrites.
function updateSyncStatus(root, env, patch) {
  const file = syncStatusPath({ root, env })
  try {
    assertNotRealStateUnderTest(path.dirname(file), { env })
  } catch (error) {
    // istanbul ignore next -- assertNotRealStateUnderTest's own contract is "throws an Error with
    // .code = DESK_TEST_REAL_STATE; never throws otherwise", so this rethrow has no other error to see.
    if (error.code !== DESK_TEST_REAL_STATE) throw error
    return null
  }
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const next = { ...(readJsonIfPresent(file) ?? {}), ...patch }
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
  return next
}

/**
 * Records how the last desk sync (`syncWorkspace`'s pull) ended, for `desk_status`'s one health word: a failed pull
 * changes no ahead/behind count, so without this record `desk_status` reads "in sync" beside a boot that said
 * `degraded`. A synced outcome clears the record; so does a later successful push. Best effort, never throws.
 */
export function recordPullOutcome({ root, env, result }) {
  try {
    const failed = result?.state === "unresolved"
    updateSyncStatus(root, env, {
      last_pull: failed
        ? { state: "unresolved", reason: result.reason ?? null, cause: result.cause ?? null, at: new Date().toISOString() }
        : null,
    })
  } catch {
    // The record is a convenience for the next reader, never a reason to fail a sync.
  }
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
 * `hostEnforcementCheck` uses for the identical reason: a real filing
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
 * by Claude Code's own launcher, or `"unknown"` otherwise. Mirrors `tools/
 * status.js`'s own `hostEnforcementStatus`, not `factory-context.js`'s
 * `factoryPluginScan`: `DESK_PLUGIN_ROOT` locates a plugin root on every host
 * (Claude included), so it is not a reliable "this is Copilot" signal, and a
 * filed problem naming the wrong host is worse than one that says it does
 * not know (`status.js`'s own comment on the same choice).
 */
export function hostFromEnv(env) {
  return text(env.CLAUDE_PLUGIN_ROOT) !== null ? "claude" : "unknown"
}

// ---------------------------------------------------------------------------
// The worker itself.
// ---------------------------------------------------------------------------

const REAL_CLOCK = { sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }

/**
 * Runs the whole worker cycle for `root`: acquire the lock (exit quietly on
 * contention), skip entirely when there is no remote or no upstream (never
 * an error — controller ruling 2), otherwise debounce, then push (with the
 * one retry) in a loop that keeps re-checking what is ahead until nothing
 * is, so the lock holder never releases while a commit is left unpushed.
 * Never throws — including when the lock is refused under a node:test run
 * (`result: "test_isolation_refused"`, logged to `stderr` rather than left
 * silent), which `runSyncPushCli`/`sync-push.js` still resolve to exit code
 * 0 for, the same as `"busy"` or `"skipped"`. `clock`, `spawnGit`,
 * `fileProblem` and `stderr` are test seams.
 */
export async function runPushWorker({
  root, env = process.env, debounceMs = DEFAULT_DEBOUNCE_MS, spawnGit = spawnSync, clock = REAL_CLOCK, fileProblem = queueDeskProblemFiling,
  stderr = process.stderr,
}) {
  const lock = await acquireSyncLock({ root, env })
  if (lock?.refused) {
    // Not silent, even though the CLI's own stdio is ignored (`defaultSpawnWorker`): the reason still lands
    // wherever this process's stderr goes, for anyone inspecting it directly (a test, a manual `node sync-push.js`
    // run). A session launched under any `node --test` inherits NODE_TEST_CONTEXT, so this is the ordinary
    // shape of "this desk root is a node:test child process", not a defect -- treated as "could not run this
    // cycle", never a crash (Review Focus, `sync_worker.test.js`).
    stderr.write(`Desk sync worker: refused the real state folder under what looks like a node:test run (${DESK_TEST_REAL_STATE}); not pushing this cycle.\n`)
    return { result: "test_isolation_refused" }
  }
  if (lock === null) return { result: "busy" }
  try {
    if (!canPush(root, spawnGit)) return { result: "skipped" }
    await clock.sleep(debounceMs)
    let pushed = false
    for (;;) {
      const counts = aheadBehindCounts({ root, spawnGit })
      if (counts === null || counts.ahead <= 0) {
        const patch = { blocked: false, reason: null, paths: [] }
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
      updateSyncStatus(root, env, { blocked: true, reason: attempt.reason, paths: attempt.paths, at: new Date().toISOString() })
      fileProblem({ root, env, reason: attempt.reason, host: hostFromEnv(env) })
      return { result: "blocked", reason: attempt.reason }
    }
  } finally {
    lock.release()
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
  try {
    spawnWorker({ root, env, debounceMs })
  } catch {
    // Scheduling a push must never surface as a failure of the write tool that asked for one.
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
 * returns the same honest, unfiled `Desk problem:` block shape `runtime/
 * host-enforcement-registration.js` already uses for a filer its own callers
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
