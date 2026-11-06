// Session-start's own sync step (M4-6 "agents never fight the desk" Part 3,
// Task 3; spec.md §2 "Session-start pull"). Replaces `session-start/
// SKILL.md` Step 2's old bare `git pull --rebase --quiet origin main` +
// "warn the operator but proceed" text with a deterministic
// retry-quarantine-diagnose sequence, never a silent proceed.
//
// Incoming sync is fast-forward-only, with rebase and autostash explicitly disabled.
// Existing operations and uncertain effects are preserved; sync never aborts them.
// `syncWorkspace` never throws: the pull runs once;
// when it fails because git names untracked files the incoming commits would
// overwrite, exactly those files (and no others: an untracked file on a shared
// desk is usually another session's unfinished work) are quarantined to
// `_cache/stray-<date>[-n]/` -- moved, never deleted, and never clobbering an
// earlier same-day quarantine (Review Focus: "same-day double quarantine") --
// then the fast-forward pull is retried once more, only after a known failure
// with an unchanged branch, HEAD and index. Other unresolved pulls queue the detached
// Desk-problem filer (mechanism `session-sync`) and returns the same
// honest, five-field `Desk problem:` block shape every other mechanism in
// this codebase uses -- this is the "unresolved branch" upgrade originally
// slated for a later PR (plan.md Part 5, Task 3) and folded into this one
// instead, since the failure-contract filer (Part 4) already exists on
// `main` by the time this Part started.
//
// Every Git call here is bounded by a ~10s timeout and runs with
// `GIT_TERMINAL_PROMPT=0`, mirroring `runtime/sync-worker.js`'s own `run`
// helper. `spawnGit` is an injectable seam over `node:child_process`'s
// `spawnSync`, for tests only; real callers never pass it.

import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { formatDeskProblem } from "./index-drift.js"
import { hostFromEnv, inspectSyncStatus, recordPullOutcome } from "./sync-worker.js"
import { argvSafeReason } from "./argv-safe-reason.js"
import { shouldLaunchFiler } from "./filer-throttle.js"
import { gitErrorLine, inspectSyncState, inspectSyncTarget, PRESERVE_SYNC_WORK, sameSyncVersion, uncertainGitResult } from "./sync-safety.js"

const GIT_TIMEOUT_MS = 10_000
const MAX_QUARANTINE_SUFFIX = 1000
// Where stray paths are moved, relative to the desk root, and so never itself a stray path.
const QUARANTINE_FOLDER = "_cache"
// The whole retry-quarantine-diagnose sequence's own wall-clock budget
// (controller ruling, fix round): session start cannot afford an unbounded
// sync step, so each git call below gets whatever of this remains, capped at
// `GIT_TIMEOUT_MS`, and the sequence gives up (as `unresolved`, never a
// hang) once it is gone.
const SYNC_WORKSPACE_DEADLINE_MS = 20_000
const FILE_DESK_PROBLEM_SCRIPT = fileURLToPath(new URL("../../scripts/file-desk-problem.js", import.meta.url))

// `GIT_SSH_COMMAND` gets the same treatment `GIT_TERMINAL_PROMPT=0` already
// gives the HTTPS credential prompt: `-o BatchMode=yes` disables every
// interactive SSH prompt so an SSH-remote desk can never hang session start
// either. A caller's own `GIT_SSH_COMMAND` is extended, never replaced.
function gitEnv() {
  const existing = process.env.GIT_SSH_COMMAND
  const sshCommand = typeof existing === "string" && existing.trim() !== "" ? `${existing} -o BatchMode=yes` : "ssh -o BatchMode=yes"
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: sshCommand }
}

// A budget-exhausted caller must never hand `spawnSync` a `timeout` of `0`
// (or less) -- Node treats that as "no timeout at all," the exact opposite
// of what an exhausted budget needs -- so `run` itself refuses to spawn once
// `timeoutMs` runs out and reports a synthetic failure instead. Every call
// site below threads its own budgeted timeout through explicitly (fix
// round), so `timeoutMs` has no default of its own left to fall back to.
function run(spawnGit, root, args, timeoutMs, readOnly = false) {
  if (timeoutMs <= 0) return { status: 1, stdout: "", stderr: "sync-workspace budget exhausted" }
  return spawnGit("git", ["-C", root, ...args], { windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
    env: { ...gitEnv(), ...(readOnly ? { GIT_NO_LAZY_FETCH: "1", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" } : {}) },
  })
}

function today() {
  return new Date().toISOString().slice(0, 10)
}

async function pathExists(file) {
  try {
    await fs.access(file)
    return true
  } catch {
    return false
  }
}

/**
 * `spawnSync`'s result shape, without blocking the event loop: the pull is the one network call here and can take
 * seconds, and boot's own network checks run while it does. A timeout ends the child with SIGTERM, as `spawnSync` does.
 */
export function spawnGitAsync(command, args, { timeout, env, spawnImpl = spawn }) {
  return new Promise((resolve) => {
    const stdout = []
    const stderr = []
    let timedOut = false
    const child = spawnImpl(command, args, { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true })
    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeout)
    child.stdout.on("data", (chunk) => stdout.push(chunk))
    child.stderr.on("data", (chunk) => stderr.push(chunk))
    child.on("error", (error) => {
      clearTimeout(timer)
      resolve({ status: null, signal: null, stdout: "", stderr: "", error })
    })
    child.on("close", (status, signal) => {
      clearTimeout(timer)
      const result = { status, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }
      resolve(timedOut ? { ...result, error: Object.assign(new Error("git timed out"), { code: "ETIMEDOUT" }) } : result)
    })
  })
}

function pull(root, spawnPull, timeoutMs) {
  return run(spawnPull, root, ["pull", "--ff-only", "--no-rebase", "--no-autostash"], timeoutMs)
}

// Untracked, non-ignored paths at `root`, unquoted (`-z`), so a name with spaces or non-ASCII letters matches git's own
// error text. Used only to confirm that a path git named really is untracked before it is moved.
function untrackedPaths(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["ls-files", "--others", "--exclude-standard", "-z"], timeoutMs)
  if (result.status !== 0 || typeof result.stdout !== "string") return []
  return result.stdout.split("\0").filter((line) => line !== "")
}

const OVERWRITTEN_LIST = /^(?:error: )?The following untracked working tree files would be overwritten by (?:merge|checkout):\s*$/u
const OVERWRITTEN_ONE = /^(?:error: )?Untracked working tree file '(.+)' would be overwritten by (?:merge|checkout)\.?\s*$/u

/**
 * The untracked files a failed pull named as in its way, from git's own error text: the tab-indented list under "The
 * following untracked working tree files would be overwritten by merge:" (or "...by checkout:"), or the older one-file
 * form. Nothing else in the text counts. A path that is absolute, climbs out with `..`, or sits in the `_cache/` folder
 * the moved files go to is dropped, so a quarantine can never reach outside the desk or into itself.
 */
export function overwrittenUntrackedPaths(stderr) {
  const found = []
  const lines = String(stderr ?? "").split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const one = OVERWRITTEN_ONE.exec(lines[index])
    if (one !== null) found.push(one[1])
    if (!OVERWRITTEN_LIST.test(lines[index])) continue
    while (index + 1 < lines.length && lines[index + 1].startsWith("\t")) found.push(lines[(index += 1)].slice(1))
  }
  const safe = found.filter((relative) => relative !== "" && !path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes("..") &&
    relative !== QUARANTINE_FOLDER && !relative.startsWith(`${QUARANTINE_FOLDER}/`))
  return [...new Set(safe)]
}

// Reserve the destination atomically so concurrent calls cannot share it.
export async function reserveQuarantineDir(root) {
  const base = path.join(root, QUARANTINE_FOLDER, `stray-${today()}`)
  await fs.mkdir(path.dirname(base), { recursive: true })
  for (let suffix = 1; suffix <= MAX_QUARANTINE_SUFFIX; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}-${suffix}`
    try {
      await fs.mkdir(candidate)
      return candidate
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
  }
  throw new Error("quarantine destination capacity exhausted; existing paths were retained")
}

// Moves every path in `paths` (relative to `root`) into a fresh quarantine
// directory, preserving each path's own relative structure so two stray
// files with the same basename in different directories never collide.
// Never deletes: a path that no longer exists by the time this runs (a rare
// race) is simply skipped, not treated as an error.
async function quarantine(root, paths) {
  const moved = []
  try {
    const dir = await reserveQuarantineDir(root)
    for (const relative of paths) {
      const from = path.join(root, relative)
      if (!(await pathExists(from))) continue
      const to = path.join(dir, relative)
      await fs.mkdir(path.dirname(to), { recursive: true })
      await fs.rename(from, to)
      moved.push(path.relative(root, to))
    }
    return { moved }
  } catch (error) {
    return { moved, error }
  }
}

/**
 * Queues the detached Desk-problem filer (mechanism `session-sync`) -- the
 * same "launch it, never await it inline" shape `runtime/sync-worker.js`'s
 * own `queueDeskProblemFiling` and `boot-checks.cjs`'s
 * detached repair launcher both already use, for the identical reason: a real
 * filing attempt is an account lookup plus `gh` calls that can run for tens
 * of seconds, and session-start cannot afford to block on it. Never throws.
 * `reason` and `host` are always supplied by this module's own one caller
 * (`unresolved`, below); `spawnImpl` is a test seam only -- every test
 * injects one, since the real default really shells out toward `gh` and
 * could actually file a GitHub issue.
 *
 * `reason`'s raw text never becomes an argument on the detached filer's own
 * command line unredacted (fix round, spec.md §1 Part 5): `ps` shows a
 * process's argv to every account on the machine, not just this session, so
 * it is narrowed through `argvSafeReason` first, the same way `runtime/sync-
 * worker.js`'s own `queueDeskProblemFiling` and `boot-checks.cjs`'s filing
 * call sites already do. `shouldLaunchFiler` throttles the actual *spawn* to
 * once per hour per reason; the caller still gets a `file` field back either
 * way, since a filing that is merely deduped is not itself a new failure.
 */
export function queueDeskProblemFiling({ root, env, reason, host, spawnImpl }) {
  const safeReason = argvSafeReason(reason)
  if (!shouldLaunchFiler({ env, mechanism: "session-sync", signature: safeReason })) {
    return { file: "filing already queued (within the last hour)" }
  }
  try {
    // istanbul ignore next -- see the doc comment above: the real default is
    // exercised only by the real filer in production, never by a test.
    const spawnChild = spawnImpl ?? spawn
    const child = spawnChild(process.execPath, [
      FILE_DESK_PROBLEM_SCRIPT,
      "--mechanism", "session-sync",
      "--reason", safeReason,
      "--host", host,
      "--fix-attempt", "attempted fast-forward-only sync without rebase or autostash; preserved existing operations and uncertain effects",
    ], { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Never let filing itself become a new failure.
  }
  return { file: "filing in background" }
}

// Why a failed pull failed, from what git said: a real conflict, a diverged history, credentials the
// remote refused, a remote that could not be reached, or something else. Session start used to call
// every failure a conflict, so an unreachable origin sent agents to a `git status` that read clean.
const CONFLICT_TEXT = /CONFLICT|could not apply|Cannot rebase|would be overwritten|overwritten by/iu
const AUTH_TEXT = /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey|Invalid username or password|Host key verification failed|Repository not found|returned error: 40[13]|HTTP 40[13]|terminal prompts disabled/iu
const UNREACHABLE_TEXT = /Could not resolve host|unable to access '(?:https?|git|ssh):\/\/|Could not read from remote|Connection (?:refused|timed out|reset)|Network is unreachable|No route to host|Failed to connect|unable to connect|Operation timed out|timed out|Temporary failure in name resolution|ssh: connect to host/iu
const DIVERGED_TEXT = /diverg|not possible to fast-forward|Need to specify how to reconcile/iu

export function classifyPullFailure({ stderr = "", conflicted = [], timedOut = false, deadline = false } = {}) {
  if (deadline || timedOut) return "deadline"
  if (conflicted.length > 0 || CONFLICT_TEXT.test(stderr)) return "conflict"
  if (AUTH_TEXT.test(stderr)) return "auth_failed"
  if (UNREACHABLE_TEXT.test(stderr)) return "unreachable"
  if (DIVERGED_TEXT.test(stderr)) return "diverged"
  return "other"
}

// The first meaningful line of git's own complaint, without any credentials a remote URL carried.
function originUrl(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["remote", "get-url", "origin"], timeoutMs)
  const url = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : ""
  return url === "" ? null : url.replace(/\/\/[^/@\s]+@/u, "//")
}

const NOT_A_DESK_DEFECT = new Set(["unreachable", "auth_failed", "deadline"])

const TELL = {
  unreachable: "The remote could not be reached; local Git status does not prove remote delivery. Read back unknown effects before retry.",
  auth_failed: "The remote refused this host's credentials. Use the existing sign-in path, then read back unknown effects before retry.",
  deadline: "Sync ran out of time before finishing; read back unknown effects before retry.",
}

function unresolved({ root, env, fileProblem, reason, conflicted, quarantinedPaths, failed, spawnGit, timeoutMs, safety, effects }) {
  const cause = classifyPullFailure({
    stderr: failed?.stderr,
    conflicted,
    timedOut: failed?.error?.code === "ETIMEDOUT" || failed?.signal === "SIGTERM",
    deadline: reason === "sync_deadline_exceeded",
  })
  // A network outage, an expired sign-in and a ran-out budget are the host's state, not Desk defects: they still
  // surface to the agent below, but no Desk problem is filed. A failed pull's filed reason names its cause, so the
  // issue says what happened and each cause gets its own title and fingerprint.
  const filing = safety || NOT_A_DESK_DEFECT.has(cause)
    ? undefined
    : fileProblem({ root, env, reason: failed === undefined ? reason : `${reason}:${cause}`, host: hostFromEnv(env) })
  const diagnostic = formatDeskProblem({
    mechanism: "session-sync",
    symptom: "session-start pull did not resolve",
    broke: `${effects?.pull === "not_attempted" ? "sync paused before pulling" : "fast-forward-only pull did not finish cleanly"} (${reason})${conflicted.length ? `; conflicted: ${conflicted.join(", ")}` : ""}`,
    means: "this desk did not sync with its remote at session start; local work continues, but it may be out of date or diverged from the remote",
    fix: "pending work and Git operation metadata were retained; no rebase, autostash, abort or reset was attempted. Read back the source and retained operation before any retry; tracked-history recovery remains unresolved.",
    file: filing?.file ?? (safety ? "not filed: existing or unverified Git state"
      : NOT_A_DESK_DEFECT.has(cause) ? "not filed: host or remote condition" : "filing in background"),
    tell: TELL[cause] ?? "Run `git status` in the desk and inspect its retained operation; do not treat a clean index as recovered history.",
  })
  const result = { state: "unresolved", reason, diagnostic, cause, remote: originUrl(root, spawnGit, timeoutMs), error: gitErrorLine(failed?.stderr) || safety?.error || "", conflicted, cleanup: PRESERVE_SYNC_WORK, effects: effects ?? { pull: "unknown" } }
  if (safety?.operations) result.operations = safety.operations
  if (quarantinedPaths !== undefined) result.quarantinedPaths = quarantinedPaths
  return result
}

/**
 * `{ root, env, spawnGit? }` -> `{ state: "synced", nothingToSync? } | { state:
 * "quarantined", quarantinedPaths } | { state: "unresolved", reason, diagnostic,
 * quarantinedPaths? }`. Never throws.
 *
 * A desk with no remote at all, or whose current branch has no upstream yet,
 * has nothing to sync against once retained operations have been ruled out: this
 * is an ordinary state for a brand-new or purely-local desk, not a defect, so it
 * is reported as `synced` without ever attempting a pull.
 *
 * The whole retry-quarantine-diagnose sequence below shares one 20s
 * wall-clock budget (`SYNC_WORKSPACE_DEADLINE_MS`, fix round, controller
 * ruling): `now` is a test seam (defaults to the real clock), and each git
 * call gets whatever of the budget remains, capped at `GIT_TIMEOUT_MS`.
 * Running out of budget before either pull attempt ends the sequence as
 * `unresolved` (reason `sync_deadline_exceeded`) rather than pushing ahead
 * with an unbounded or zero-timeout git call.
 */
export async function syncWorkspace(options) {
  const operation = { attempt: undefined, remaining: null }
  const result = await runSync({ ...options, operation })
  const recorded = recordPullOutcome({ root: options.root, env: options.env, result, attempt: operation.attempt,
    waitMs: operation.attempt ? operation.remaining() : 0 })
  if (operation.attempt && recorded === null) {
    return { ...unresolved({ root: options.root, env: options.env, reason: "sync_status_unavailable",
      conflicted: result.conflicted ?? [], quarantinedPaths: result.quarantinedPaths,
      safety: { error: "the incoming attempt could not settle its own retained outcome; readback is required" },
      effects: { pull: "unknown" }, spawnGit: options.spawnGit ?? spawnSync, timeoutMs: 0 }), attempt: operation.attempt }
  }
  return result
}

async function runSync({
  root, env, operation, spawnGit = spawnSync, fileProblem = queueDeskProblemFiling, now = () => Date.now(),
  // The pull runs asynchronously unless a caller supplies its own `spawnGit`, which then runs every call.
  spawnPull = spawnGit === spawnSync ? spawnGitAsync : spawnGit,
}) {
  const deadlineAt = now() + SYNC_WORKSPACE_DEADLINE_MS
  const remaining = () => deadlineAt - now()
  operation.remaining = remaining
  const budgetedTimeout = () => Math.min(GIT_TIMEOUT_MS, remaining())
  const deadlineExceeded = (conflicted, quarantinedPaths) => unresolved({
    root, env, fileProblem, reason: "sync_deadline_exceeded", conflicted, quarantinedPaths, spawnGit, timeoutMs: budgetedTimeout(),
  })

  if (remaining() <= 0) return deadlineExceeded([])

  const inspect = () => inspectSyncState((args) => run(spawnGit, root, args, budgetedTimeout(), true), root)
  const preserved = (safety, quarantinedPaths, failed, attempted = false) => remaining() <= 0 ? deadlineExceeded(safety.conflicted ?? [], quarantinedPaths) : unresolved({
    root, env, fileProblem, reason: safety.reason, conflicted: safety.conflicted ?? [], safety, failed, quarantinedPaths,
    spawnGit, timeoutMs: budgetedTimeout(), effects: { pull: attempted ? "unknown" : "not_attempted" },
  })
  const before = inspect()
  if (before.state !== "clear" && before.state !== "not_git") return preserved(before)
  const priorStatus = inspectSyncStatus({ root, env })
  if (!priorStatus.ok) return preserved({ state: "unknown", reason: "sync_status_unavailable" })
  if (priorStatus.value?.last_pull?.effects?.pull === "unknown") {
    return unresolved({ root, env, fileProblem, reason: "previous_pull_outcome_unknown", conflicted: [],
      safety: { error: "the previous incoming outcome needs source/remote readback before retry" },
      effects: { pull: "unknown" }, spawnGit, timeoutMs: budgetedTimeout() })
  }
  if (before.state === "not_git") return { state: "synced", nothingToSync: "no_remote" }
  // Absence of an upstream is ordinary only after ruling out a retained operation.
  const target = inspectSyncTarget((args) => run(spawnGit, root, args, budgetedTimeout(), true))
  if (target.state === "unknown") return preserved(target)
  if (target.state === "none") return { state: "synced", nothingToSync: target.reason }
  if (remaining() <= 0) return deadlineExceeded([])

  const preparePull = (quarantinedPaths) => {
    const attempt = operation.attempt ?? randomUUID()
    const recorded = recordPullOutcome({ root, env, attempt: operation.attempt, waitMs: remaining(),
      result: { state: "unresolved", reason: "pull_in_progress",
        effects: { pull: "unknown" }, cleanup: PRESERVE_SYNC_WORK, attempt, quarantinedPaths } })
    if (recorded?.last_pull?.attempt !== attempt) return false
    operation.attempt = attempt
    return true
  }
  if (!preparePull()) return preserved({ state: "unknown", reason: "sync_status_unavailable" })
  const first = await pull(root, spawnPull, budgetedTimeout())
  const after = inspect()
  if (remaining() <= 0) return deadlineExceeded(after.conflicted ?? [])
  if (after.state !== "clear") return preserved(after, undefined, first, true)
  if (first.status === 0 && !uncertainGitResult(first)) {
    return { state: "synced" }
  }
  const firstConflicted = []

  if (remaining() <= 0) return deadlineExceeded(firstConflicted)

  // Several sessions share a desk, so an untracked file usually belongs to another session's unfinished work. Only the
  // untracked files git itself named as in the pull's way are moved aside; any other failure (a conflict, an unreachable
  // remote, refused credentials) moves nothing.
  const named = uncertainGitResult(first) || !sameSyncVersion(before, after) ? [] : overwrittenUntrackedPaths(first.stderr)
  const untracked = new Set(named.length === 0 ? [] : untrackedPaths(root, spawnGit, budgetedTimeout()))
  const stray = named.filter((relative) => untracked.has(relative))
  if (remaining() <= 0) return deadlineExceeded([])
  if (stray.length === 0) {
    const refused = !uncertainGitResult(first) && sameSyncVersion(before, after) &&
      /not possible to fast-forward|would be overwritten/iu.test(String(first.stderr))
    return unresolved({ root, env, fileProblem, reason: "pull_rebase_failed", conflicted: firstConflicted, failed: first,
      effects: { pull: refused ? "not_applied" : "unknown" }, spawnGit, timeoutMs: budgetedTimeout() })
  }

  const quarantined = await quarantine(root, stray)
  const quarantinedPaths = quarantined.moved
  if (quarantined.error) {
    return unresolved({ root, env, fileProblem, reason: "quarantine_failed", conflicted: [], quarantinedPaths,
      failed: { stderr: quarantined.error.message }, spawnGit, timeoutMs: budgetedTimeout() })
  }
  if (remaining() <= 0) return deadlineExceeded(firstConflicted, quarantinedPaths)

  const retryState = inspect()
  if (!sameSyncVersion(after, retryState)) {
    return preserved(retryState.state === "clear" ? { reason: "source_changed", state: "unknown" } : retryState, quarantinedPaths, first, true)
  }
  if (!preparePull(quarantinedPaths)) return preserved({ state: "unknown", reason: "sync_status_unavailable" }, quarantinedPaths, first, true)
  const second = await pull(root, spawnPull, budgetedTimeout())
  const finalState = inspect()
  if (remaining() <= 0) return deadlineExceeded(finalState.conflicted ?? [], quarantinedPaths)
  if (finalState.state !== "clear") return preserved(finalState, quarantinedPaths, second, true)
  if (second.status === 0 && !uncertainGitResult(second)) {
    return { state: "quarantined", quarantinedPaths }
  }

  return unresolved({ root, env, fileProblem, reason: "pull_rebase_failed_after_quarantine", conflicted: [], quarantinedPaths, failed: second, spawnGit, timeoutMs: budgetedTimeout() })
}

// ---------------------------------------------------------------------------
// The CLI surface (`mcp/scripts/session-sync.js`).
// ---------------------------------------------------------------------------

function parseSessionSyncArgs(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (typeof key !== "string" || !key.startsWith("--")) throw new Error(`session-sync.js: unexpected argument ${JSON.stringify(key ?? "")}`)
    options.set(key.slice(2), argv[index + 1])
  }
  return options
}

/**
 * Session-start's own CLI entry point, kept here so it is unit-tested
 * directly rather than through a subprocess -- the script itself is one
 * line, the same shape as `sync-worker.js`'s own `runSyncPushCli`. Always
 * exits 0: a hook must not block session start. `--root` falls back to
 * `env.DESK`, matching every other Desk script's own root resolution.
 * `syncFn` is a test seam.
 */
export async function runSessionSyncCli({ argv = process.argv.slice(2), env = process.env, io = process, syncFn = syncWorkspace } = {}) {
  const options = parseSessionSyncArgs(argv)
  const root = options.get("root") ?? env.DESK
  if (typeof root !== "string" || root === "") {
    io.stderr.write("session-sync.js: --root <path> (or the DESK env var) is required\n")
    return 0
  }
  const result = await syncFn({ root, env })
  if (result.state === "unresolved") {
    io.stdout.write(`${result.diagnostic}\n`)
  } else if (result.state === "quarantined") {
    io.stdout.write(`session-sync: quarantined ${result.quarantinedPaths.length} stray path(s) (${result.quarantinedPaths.join(", ")}) and synced\n`)
  }
  return 0
}
