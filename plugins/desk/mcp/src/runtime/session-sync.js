// Session-start's own sync step (M4-6 "agents never fight the desk" Part 3,
// Task 3; spec.md §2 "Session-start pull"). Replaces `session-start/
// SKILL.md` Step 2's old bare `git pull --rebase --quiet origin main` +
// "warn the operator but proceed" text with a deterministic
// retry-quarantine-diagnose sequence, never a silent proceed.
//
// `syncWorkspace` never throws: `git pull --rebase --autostash` runs once;
// on failure, every untracked, non-ignored path at the desk root (the
// classic cause of a dirty-index pull failure: a stray file another tool or
// a previous session left lying around, which the incoming pull would
// overwrite) is quarantined to `_cache/stray-<date>[-n]/` -- moved, never
// deleted, and never clobbering an earlier same-day quarantine (Review
// Focus: "same-day double quarantine") -- then the pull is retried once
// more. Anything still unresolved (no untracked paths to blame, or the
// retry also fails -- a genuine tracked-file conflict) queues the detached
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
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { formatDeskProblem } from "./index-drift.js"
import { aheadBehindCounts, hasRemoteConfigured, hostFromEnv } from "./sync-worker.js"
import { argvSafeReason } from "./argv-safe-reason.js"
import { shouldLaunchFiler } from "./filer-throttle.js"

const GIT_TIMEOUT_MS = 10_000
const MAX_QUARANTINE_SUFFIX = 1000
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
// `timeoutMs` runs out and reports a synthetic failure instead.
function run(spawnGit, root, args, timeoutMs = GIT_TIMEOUT_MS) {
  if (timeoutMs <= 0) return { status: 1, stdout: "", stderr: "sync-workspace budget exhausted" }
  return spawnGit("git", ["-C", root, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    env: gitEnv(),
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

function pull(root, spawnGit, timeoutMs) {
  return run(spawnGit, root, ["pull", "--rebase", "--autostash"], timeoutMs)
}

function abortRebase(root, spawnGit, timeoutMs) {
  // Best-effort safety net: harmless (and ignored) when there is no rebase in progress.
  run(spawnGit, root, ["rebase", "--abort"], timeoutMs)
}

function conflictedPaths(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["diff", "--name-only", "--diff-filter=U"], timeoutMs)
  if (result.status !== 0 || typeof result.stdout !== "string") return []
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "")
}

// Untracked, non-ignored paths at `root` -- what a dirty-index pull failure
// most often blames (`--exclude-standard` already respects `.gitignore`, so
// scratch directories such as `_cache/` never appear here).
function untrackedPaths(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["ls-files", "--others", "--exclude-standard"], timeoutMs)
  if (result.status !== 0 || typeof result.stdout !== "string") return []
  return result.stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "")
}

// The number of stash entries `root` currently has -- used only to notice a
// `git stash pop` that silently failed to drop its own entry (see
// `popConflicted`, below).
function stashCount(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["stash", "list"], timeoutMs)
  if (result.status !== 0 || typeof result.stdout !== "string") return 0
  return result.stdout.split("\n").filter((line) => line.trim() !== "").length
}

// A status-0 `git pull --rebase --autostash` is not proof the tree actually
// ended up clean (fix round, controller ruling): the rebase step can finish
// while popping its own autostash conflicts, without necessarily failing the
// pull's own exit code. `conflictedPaths` catches a pop that left
// merge-conflict markers; `stashCount` growing past `stashBefore` catches
// the other shape (an untracked file colliding with one the stash would
// restore), which leaves the stash entry behind with no UU marker at all.
function popConflicted(root, spawnGit, timeoutMs, stashBefore) {
  const paths = conflictedPaths(root, spawnGit, timeoutMs)
  const conflicted = paths.length > 0 || stashCount(root, spawnGit, timeoutMs) > stashBefore
  return { conflicted, paths }
}

// The first `_cache/stray-<date>[-n]/` directory that does not already exist
// today -- never clobbers an earlier quarantine from the same day.
async function freshQuarantineDir(root) {
  const base = path.join(root, "_cache", `stray-${today()}`)
  if (!(await pathExists(base))) return base
  for (let suffix = 2; suffix <= MAX_QUARANTINE_SUFFIX; suffix += 1) {
    const candidate = `${base}-${suffix}`
    if (!(await pathExists(candidate))) return candidate
  }
  // istanbul ignore next -- practically unreachable (1000 same-day
  // quarantines): falls back to the last candidate rather than looping
  // forever.
  return `${base}-${MAX_QUARANTINE_SUFFIX}`
}

// Moves every path in `paths` (relative to `root`) into a fresh quarantine
// directory, preserving each path's own relative structure so two stray
// files with the same basename in different directories never collide.
// Never deletes: a path that no longer exists by the time this runs (a rare
// race) is simply skipped, not treated as an error.
async function quarantine(root, paths) {
  const dir = await freshQuarantineDir(root)
  const moved = []
  for (const relative of paths) {
    const from = path.join(root, relative)
    if (!(await pathExists(from))) continue
    const to = path.join(dir, relative)
    await fs.mkdir(path.dirname(to), { recursive: true })
    await fs.rename(from, to)
    moved.push(path.relative(root, to))
  }
  return moved
}

/**
 * Queues the detached Desk-problem filer (mechanism `session-sync`) -- the
 * same "launch it, never await it inline" shape `runtime/sync-worker.js`'s
 * own `queueDeskProblemFiling` and `boot-checks.cjs`'s
 * `hostEnforcementCheck` both already use, for the identical reason: a real
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
      "--fix-attempt", "retried once with git pull --rebase --autostash; quarantined stray paths and retried once more",
    ], { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Never let filing itself become a new failure.
  }
  return { file: "filing in background" }
}

function unresolved({ root, env, fileProblem, reason, conflicted, quarantinedPaths }) {
  const filing = fileProblem({ root, env, reason, host: hostFromEnv(env) })
  const diagnostic = formatDeskProblem({
    mechanism: "session-sync",
    symptom: "session-start pull did not resolve",
    broke: `git pull --rebase --autostash failed (${reason})${conflicted.length ? `; conflicted: ${conflicted.join(", ")}` : ""}`,
    means: "this desk did not sync with its remote at session start; local work continues, but it may be out of date or diverged from the remote",
    fix: "not auto-repaired past one retry (and one quarantine attempt) -- inspect the conflict and resolve it, or ask the operator",
    file: filing?.file ?? "filing in background",
    tell: "Run `git status` in the desk to see what is in the way before making further changes there.",
  })
  const result = { state: "unresolved", diagnostic }
  if (quarantinedPaths !== undefined) result.quarantinedPaths = quarantinedPaths
  return result
}

/**
 * `{ root, env, spawnGit? }` -> `{ state: "synced" } | { state:
 * "quarantined", quarantinedPaths } | { state: "unresolved", diagnostic,
 * quarantinedPaths? }`. Never throws.
 *
 * A desk with no remote at all, or whose current branch has no upstream yet
 * (mirrors `runtime/sync-worker.js`'s own `canPush` guard -- `hasRemoteConfigured`
 * plus an `aheadBehindCounts` probe of `@{u}`), has nothing to sync against: this
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
export async function syncWorkspace({
  root, env, spawnGit = spawnSync, fileProblem = queueDeskProblemFiling, now = () => Date.now(),
}) {
  if (!hasRemoteConfigured(root, spawnGit)) return { state: "synced" }
  if (aheadBehindCounts({ root, spawnGit }) === null) return { state: "synced" }

  const deadlineAt = now() + SYNC_WORKSPACE_DEADLINE_MS
  const remaining = () => deadlineAt - now()
  const budgetedTimeout = () => Math.min(GIT_TIMEOUT_MS, remaining())
  const deadlineExceeded = (conflicted, quarantinedPaths) => unresolved({
    root, env, fileProblem, reason: "sync_deadline_exceeded", conflicted, quarantinedPaths,
  })

  if (remaining() <= 0) return deadlineExceeded([])

  const stashBeforeFirst = stashCount(root, spawnGit, budgetedTimeout())
  const first = pull(root, spawnGit, budgetedTimeout())
  if (first.status === 0) {
    const { conflicted, paths } = popConflicted(root, spawnGit, budgetedTimeout(), stashBeforeFirst)
    if (!conflicted) return { state: "synced" }
    abortRebase(root, spawnGit, budgetedTimeout())
    return unresolved({ root, env, fileProblem, reason: "autostash_pop_conflict", conflicted: paths })
  }
  // Captured before the abort below, which is what actually clears a genuine
  // mid-rebase conflict: reading it after cleanup would always see nothing.
  const firstConflicted = conflictedPaths(root, spawnGit, budgetedTimeout())
  abortRebase(root, spawnGit, budgetedTimeout())

  if (remaining() <= 0) return deadlineExceeded(firstConflicted)

  const stray = untrackedPaths(root, spawnGit, budgetedTimeout())
  if (stray.length === 0) {
    return unresolved({ root, env, fileProblem, reason: "pull_rebase_failed", conflicted: firstConflicted })
  }

  const quarantinedPaths = await quarantine(root, stray)
  if (remaining() <= 0) return deadlineExceeded(firstConflicted, quarantinedPaths)

  const stashBeforeSecond = stashCount(root, spawnGit, budgetedTimeout())
  const second = pull(root, spawnGit, budgetedTimeout())
  if (second.status === 0) {
    const { conflicted, paths } = popConflicted(root, spawnGit, budgetedTimeout(), stashBeforeSecond)
    if (!conflicted) return { state: "quarantined", quarantinedPaths }
    abortRebase(root, spawnGit, budgetedTimeout())
    return unresolved({ root, env, fileProblem, reason: "autostash_pop_conflict_after_quarantine", conflicted: paths, quarantinedPaths })
  }

  const secondConflicted = conflictedPaths(root, spawnGit, budgetedTimeout())
  abortRebase(root, spawnGit, budgetedTimeout())
  return unresolved({ root, env, fileProblem, reason: "pull_rebase_failed_after_quarantine", conflicted: secondConflicted, quarantinedPaths })
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
