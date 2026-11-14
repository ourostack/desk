// Session-start's own sync step (M4-6 "agents never fight the desk" Part 3,
// Task 3; spec.md §2 "Session-start pull"). Replaces `session-start/
// SKILL.md` Step 2's old bare `git pull --rebase --quiet origin main` +
// "warn the operator but proceed" text with a deterministic
// retry-quarantine-diagnose sequence, never a silent proceed.
//
// `syncWorkspace` never throws: `git pull --rebase --autostash` runs once;
// when it fails because git names untracked files the incoming commits would
// overwrite, exactly those files (and no others: an untracked file on a shared
// desk is usually another session's unfinished work) are quarantined to
// `_cache/stray-<date>[-n]/` -- moved, never deleted, and never clobbering an
// earlier same-day quarantine (Review Focus: "same-day double quarantine") --
// then the pull is retried once more. Anything still unresolved (git named no
// untracked file in the way, or the retry also fails -- a genuine tracked-file
// conflict) queues the detached
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

import { commandArgument } from "./pr-publication.js"
import { deskFailure } from "./desk-failure.js"
import { aheadBehindCounts, hasRemoteConfigured, hostFromEnv, readSyncStatus, recordPullOutcome, schedulePush } from "./sync-worker.js"
import { NOT_A_DESK_DEFECT, classifyPullFailure, namedUntrackedPaths, undeliveredCommits } from "./deliver.js"
import { argvSafeReason } from "./argv-safe-reason.js"
import { remoteIdentityEnv } from "./remote-identity.js"
import { shouldLaunchFiler } from "./filer-throttle.js"
import { applyPublicationMode } from "./publication-mode.js"

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
function run(spawnGit, root, args, timeoutMs) {
  if (timeoutMs <= 0) return { status: 1, stdout: "", stderr: "sync-workspace budget exhausted" }
  return spawnGit("git", ["-C", root, ...args], { windowsHide: true,
    encoding: "utf8",
    timeout: timeoutMs,
    env: remoteIdentityEnv({ root, args, env: gitEnv(), spawn: spawnGit }),
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
      resolve(timedOut ? { ...result, error: Object.assign(Object.assign(new Error("Run it again: git timed out"), { code: "session_sync_run_it_again_git_timed" }), { code: "ETIMEDOUT" }) } : result)
    })
  })
}

function pull(root, spawnPull, timeoutMs) {
  return run(spawnPull, root, ["pull", "--rebase", "--autostash"], timeoutMs)
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

// Untracked, non-ignored paths at `root`, unquoted (`-z`), so a name with spaces or non-ASCII letters matches git's own
// error text. Used only to confirm that a path git named really is untracked before it is moved.
function untrackedPaths(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["ls-files", "--others", "--exclude-standard", "-z"], timeoutMs)
  if (result.status !== 0 || typeof result.stdout !== "string") return []
  return result.stdout.split("\0").filter((line) => line !== "")
}

export function overwrittenUntrackedPaths(stderr) {
  const safe = namedUntrackedPaths(stderr).filter((relative) => relative !== "" && !path.isAbsolute(relative) && !relative.split(/[\\/]/u).includes("..") &&
    relative !== QUARANTINE_FOLDER && !relative.startsWith(`${QUARANTINE_FOLDER}/`))
  return [...new Set(safe)]
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
  const base = path.join(root, QUARANTINE_FOLDER, `stray-${today()}`)
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
      "--fix-attempt", "ran git pull --rebase --autostash; when git named untracked files in the way, moved only those to _cache/ and retried once more",
    ], { cwd: root, detached: true, stdio: "ignore", windowsHide: true, env })
    child.on("error", () => {})
    child.unref()
  } catch {
    // Never let filing itself become a new failure.
  }
  return { file: "filing in background" }
}

// Why a failed pull failed (a real conflict, a diverged history, refused credentials, an unreachable remote, or
// something else) is decided by `classifyPullFailure`, shared with delivery (runtime/deliver.js).
export { classifyPullFailure }

// The first meaningful line of git's own complaint, without any credentials a remote URL carried.
function firstErrorLine(stderr) {
  const line = String(stderr ?? "").split(/\r?\n/u).map((value) => value.trim()).find((value) => value !== "" && !/^hint:/iu.test(value)) ?? ""
  return line.replace(/\/\/[^/@\s]+@/gu, "//").slice(0, 200)
}

function originUrl(root, spawnGit, timeoutMs) {
  const result = run(spawnGit, root, ["remote", "get-url", "origin"], timeoutMs)
  const url = result.status === 0 && typeof result.stdout === "string" ? result.stdout.trim() : ""
  return url === "" ? null : url.replace(/\/\/[^/@\s]+@/u, "//")
}


// ---------------------------------------------------------------------------
// The one stuck state sync repairs by itself before pulling: a `git pull --rebase --autostash` replayed its commits,
// then re-applying its autostash conflicted, and git stopped before it finished removing `rebase-merge/`, leaving only
// the `autostash` file there. Git then calls the checkout mid-rebase, so every later pull refuses. The local change is
// kept in the stash list first, so nothing is lost; any state that does not match exactly is left alone.
// ---------------------------------------------------------------------------

export const STALE_AUTOSTASH_REBASE = "stale_autostash_rebase"
const STALE_AUTOSTASH_MESSAGE = "autostash Desk preserved from an interrupted pull"
// Any other operation or lock in the git directory means the state is not the stuck one: nothing is repaired.
const OTHER_GIT_MARKERS = ["rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer", "index.lock"]
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u

/** The plain sentence boot and `desk_status` use for the repair. */
export function staleAutostashSentence({ stash, commit }) {
  return `An earlier pull had stopped before finishing; the local change it held is kept as ${stash} (commit ${commit.slice(0, 12)}).`
}

function nulSeparated(result) {
  if (result.status !== 0 || typeof result.stdout !== "string") return null
  return result.stdout.split("\0").filter((entry) => entry !== "")
}

// Every tracked path `git status` reports as staged, modified or unmerged, both sides of a rename included.
function changedTrackedPaths(root, spawnGit, timeoutMs) {
  const entries = nulSeparated(run(spawnGit, root, ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--no-renames"], timeoutMs))
  if (entries === null) return null
  const paths = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    paths.push(entry.slice(3))
    if (entry[0] === "R" || entry[0] === "C") {
      index += 1
      if (index < entries.length) paths.push(entries[index])
    }
  }
  return paths
}

// `stash@{n}` for the stash entry whose commit is `sha`, `null` when there is none, `undefined` when unreadable.
function stashRefFor(root, spawnGit, timeoutMs, sha) {
  const result = run(spawnGit, root, ["stash", "list", "--format=%H"], timeoutMs)
  if (result.status !== 0 || typeof result.stdout !== "string") return undefined
  const index = result.stdout.split("\n").map((line) => line.trim()).indexOf(sha)
  return index === -1 ? null : `stash@{${index}}`
}

// The stuck state's autostash SHA and its unmerged paths, or null when anything differs from it at all.
async function staleAutostashState(root, spawnGit, timeoutMs) {
  const gitDirResult = run(spawnGit, root, ["rev-parse", "--git-dir"], timeoutMs)
  if (gitDirResult.status !== 0 || typeof gitDirResult.stdout !== "string" || gitDirResult.stdout.trim() === "") return null
  const gitDir = path.resolve(root, gitDirResult.stdout.trim())
  const marker = path.join(gitDir, "rebase-merge")
  let entries
  try {
    entries = await fs.readdir(marker)
  } catch {
    return null
  }
  if (entries.length !== 1 || entries[0] !== "autostash") return null
  for (const other of OTHER_GIT_MARKERS) if (await pathExists(path.join(gitDir, other))) return null
  let sha
  try {
    sha = (await fs.readFile(path.join(marker, "autostash"), "utf8")).trim()
  } catch {
    return null
  }
  if (!OBJECT_ID.test(sha)) return null
  if (run(spawnGit, root, ["cat-file", "-e", `${sha}^{commit}`], timeoutMs).status !== 0) return null
  // The interrupted pull had finished replaying: HEAD is back on its branch.
  if (run(spawnGit, root, ["symbolic-ref", "-q", "HEAD"], timeoutMs).status !== 0) return null
  const touched = nulSeparated(run(spawnGit, root, ["diff", "--name-only", "-z", "--no-renames", `${sha}^1`, sha], timeoutMs))
  if (touched === null) return null
  const autostashPaths = new Set(touched)
  const unmergedList = nulSeparated(run(spawnGit, root, ["diff", "--name-only", "-z", "--diff-filter=U"], timeoutMs))
  if (unmergedList === null) return null
  const unmerged = [...new Set(unmergedList)]
  // No unmerged path is the same state one step on (a repair whose quit failed after its checkout): only once the
  // autostash is already in the stash list.
  if (unmerged.length === 0 && typeof stashRefFor(root, spawnGit, timeoutMs, sha) !== "string") return null
  if (!unmerged.every((relative) => autostashPaths.has(relative))) return null
  const changed = changedTrackedPaths(root, spawnGit, timeoutMs)
  if (changed === null || !changed.every((relative) => autostashPaths.has(relative))) return null
  // `git checkout HEAD -- <path>` needs each path in HEAD.
  for (const relative of unmerged) {
    if (run(spawnGit, root, ["cat-file", "-e", `HEAD:${relative}`], timeoutMs).status !== 0) return null
  }
  return { marker, sha, unmerged }
}

/**
 * Repairs the stale-autostash rebase state, and only that state: keeps the autostash in the stash list (`git stash
 * store`, unless it is already there), restores each unmerged path from HEAD (the stash holds the local version), then
 * ends the leftover rebase with `git rebase --quit`, which moves neither HEAD, the index nor the working tree.
 * `{ stash, commit, paths }` when repaired, otherwise null. Never resets, never drops a stash, never throws.
 */
export async function repairStaleAutostashRebase({ root, spawnGit = spawnSync, timeoutMs = GIT_TIMEOUT_MS }) {
  try {
    const state = await staleAutostashState(root, spawnGit, timeoutMs)
    if (state === null) return null
    const { marker, sha, unmerged } = state
    let stash = stashRefFor(root, spawnGit, timeoutMs, sha)
    if (stash === undefined) return null
    if (stash === null) {
      if (run(spawnGit, root, ["stash", "store", "-m", STALE_AUTOSTASH_MESSAGE, sha], timeoutMs).status !== 0) return null
      stash = stashRefFor(root, spawnGit, timeoutMs, sha)
      if (typeof stash !== "string") return null
    }
    if (unmerged.length > 0 && run(spawnGit, root, ["--literal-pathspecs", "checkout", "HEAD", "--", ...unmerged], timeoutMs).status !== 0) return null
    // `git rebase --quit` would store the autostash file's commit in the stash list once more; it is already there.
    const autostashFile = path.join(marker, "autostash")
    await fs.unlink(autostashFile)
    if (run(spawnGit, root, ["rebase", "--quit"], timeoutMs).status !== 0 || await pathExists(marker)) {
      // Put the marker back as it was, so a later sync can still recognise and repair this state.
      if (await pathExists(marker)) await fs.writeFile(autostashFile, `${sha}\n`)
      return null
    }
    return { stash, commit: sha, paths: unmerged }
  } catch {
    return null
  }
}

function withRepair(result, repair) {
  if (repair === null) return result
  return { ...result, repaired: STALE_AUTOSTASH_REBASE, repairedStash: repair.stash, repairedCommit: repair.commit, repairedPaths: repair.paths,
    repairedNote: staleAutostashSentence(repair) }
}

// Causes that stop delivery too: no push is started for them.
const OFFLINE = new Set(["unreachable", "auth_failed"])

// Each cause's failure: what probably happened, how to look further, how to keep working and the fix. `git status` reads clean when the remote could not be asked.
function syncFailure({ cause, root, remote, reason, conflicted }) {
  const git = (...args) => `\`git -C ${commandArgument(root)} ${args.join(" ")}\``
  const delivery = "Desk's own writes still publish from a clean copy of the remote, so keep working, and never stash, rebase or reset the shared checkout for this"
  const causes = {
    auth_failed: {
      probably: `the remote refused this host's credentials, probably because no GitHub account signed in to gh can reach ${remote ?? "the desk's remote"}`,
      look: `run ${git("ls-remote", "origin")} to see git's own answer`,
      keepWorking: "the remote cannot be used from this machine right now, so nothing was pulled or pushed and `git status` will read clean; local work continues and Desk retries with every write",
      fix: "gh auth login --hostname github.com",
    },
    unreachable: {
      probably: "the remote could not be reached, probably because this machine is offline or the host is down",
      look: `run ${git("ls-remote", "origin")} to see whether it answers`,
      keepWorking: "the remote cannot be used from this machine right now, so `git status` will read clean; work continues on local state, and Desk delivers its local commits once it can",
      fix: null,
    },
    deadline: {
      probably: "sync ran out of time before it finished, probably because the remote or the network was slow",
      look: "call desk_status and read its sync section",
      keepWorking: "retry sync before pushing; local work is untouched",
      fix: null,
    },
  }
  const found = causes[cause] ?? {
    probably: "`git pull --rebase --autostash` did not finish, probably because local changes are in its way",
    look: `run ${git("status")} to see what is in the way`,
    keepWorking: `the checkout itself is not rebased and only untracked files git named are moved aside, then the pull is retried once; ${delivery}`,
    fix: null,
  }
  const what = `${reason}${conflicted.length ? `; conflicted: ${conflicted.join(", ")}` : ""}`
  return deskFailure({ code: "session_sync_unresolved", thing: "sync", ...found, probably: `${found.probably} (${what})` })
}

function unresolved({ root, env, fileProblem, reason, conflicted, quarantinedPaths, failed, spawnGit, timeoutMs }) {
  const cause = classifyPullFailure({
    stderr: failed?.stderr,
    conflicted,
    timedOut: failed?.error?.code === "ETIMEDOUT" || failed?.signal === "SIGTERM",
    deadline: reason === "sync_deadline_exceeded",
  })
  // A network outage, an expired sign-in and a ran-out budget are the host's state, not Desk defects: they still
  // surface to the agent below, but no Desk problem is filed. A failed pull's filed reason names its cause, so the
  // issue says what happened and each cause gets its own title and fingerprint.
  if (!NOT_A_DESK_DEFECT.has(cause)) fileProblem({ root, env, reason: failed === undefined ? reason : `${reason}:${cause}`, host: hostFromEnv(env) })
  const remote = originUrl(root, spawnGit, timeoutMs)
  const error = firstErrorLine(failed?.stderr)
  const diagnostic = syncFailure({ cause, root, remote, reason, conflicted })
  const result = { state: "unresolved", reason, diagnostic, cause, remote, error, conflicted }
  if (quarantinedPaths !== undefined) result.quarantinedPaths = quarantinedPaths
  return result
}

/**
 * `{ root, env, spawnGit? }` -> `{ state: "synced", nothingToSync? } | { state:
 * "quarantined", quarantinedPaths } | { state: "unresolved", reason, diagnostic,
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
 *
 * A pull that fails never holds back the desk's own commits (#396): whenever local commits are not on the remote,
 * and the remote is not known to be unreachable or refusing this machine, the detached push worker is started to
 * deliver them from a clean copy (runtime/deliver.js), and the result says so in `unpushed: { count, delivering,
 * reason, paths }`, `reason` being the last recorded push failure, if any. `scheduleDelivery` is a test seam.
 *
 * Before pulling, the one stuck state `repairStaleAutostashRebase` recognises is repaired; the result then also
 * carries `repaired: "stale_autostash_rebase"`, `repairedStash` (the stash entry holding the local change),
 * `repairedCommit`, `repairedPaths` and `repairedNote` (one plain sentence saying what was done), whatever the pull
 * itself did.
 */
export async function syncWorkspace(options) {
  const result = await runSync(options)
  // `desk_status` reads this back, so its health word carries a failed sync the way boot's does.
  recordPullOutcome({ root: options.root, env: options.env, result })
  return withDelivery(options, result)
}

function withDelivery({ root, env, spawnGit = spawnSync, scheduleDelivery = schedulePush }, result) {
  if (result.nothingToSync !== undefined) return result
  const recorded = readSyncStatus({ root, env })
  const left = undeliveredCommits({ root, spawnGit, delivered: Array.isArray(recorded?.delivered) ? recorded.delivered : [] })
  if (left === null || left.length === 0) return result
  const offline = result.state === "unresolved" && OFFLINE.has(result.cause)
  if (!offline) scheduleDelivery({ root, env, debounceMs: 0 })
  const reason = recorded?.blocked === true ? recorded.reason ?? null : offline ? result.cause : null
  const paths = recorded?.blocked === true && Array.isArray(recorded.paths) ? recorded.paths : []
  return { ...result, unpushed: { count: left.length, delivering: !offline, reason, paths } }
}

async function runSync({
  root, env, spawnGit = spawnSync, fileProblem = queueDeskProblemFiling, now = () => Date.now(),
  // The pull runs asynchronously unless a caller supplies its own `spawnGit`, which then runs every call.
  spawnPull = spawnGit === spawnSync ? spawnGitAsync : spawnGit,
}) {
  // Nothing to sync against is "synced" for every caller, with `nothingToSync` saying which kind so boot never reports it as a sync that worked.
  if (!hasRemoteConfigured(root, spawnGit)) return { state: "synced", nothingToSync: "no_remote" }
  if (aheadBehindCounts({ root, spawnGit }) === null) return { state: "synced", nothingToSync: "no_upstream" }

  const deadlineAt = now() + SYNC_WORKSPACE_DEADLINE_MS
  const remaining = () => deadlineAt - now()
  const budgetedTimeout = () => Math.min(GIT_TIMEOUT_MS, remaining())
  const deadlineExceeded = (conflicted, quarantinedPaths) => unresolved({
    root, env, fileProblem, reason: "sync_deadline_exceeded", conflicted, quarantinedPaths, spawnGit, timeoutMs: GIT_TIMEOUT_MS,
  })

  if (remaining() <= 0) return deadlineExceeded([])

  const repair = await repairStaleAutostashRebase({ root, spawnGit, timeoutMs: budgetedTimeout() })
  return withRepair(await pullSequence({ root, env, spawnGit, spawnPull, fileProblem, remaining, budgetedTimeout, deadlineExceeded }), repair)
}

async function pullSequence({ root, env, spawnGit, spawnPull, fileProblem, remaining, budgetedTimeout, deadlineExceeded }) {
  const stashBeforeFirst = stashCount(root, spawnGit, budgetedTimeout())
  const first = await pull(root, spawnPull, budgetedTimeout())
  if (first.status === 0) {
    const { conflicted, paths } = popConflicted(root, spawnGit, budgetedTimeout(), stashBeforeFirst)
    if (!conflicted) return { state: "synced" }
    abortRebase(root, spawnGit, budgetedTimeout())
    return unresolved({ root, env, fileProblem, reason: "autostash_pop_conflict", conflicted: paths, spawnGit, timeoutMs: GIT_TIMEOUT_MS })
  }
  // Captured before the abort below, which is what actually clears a genuine
  // mid-rebase conflict: reading it after cleanup would always see nothing.
  const firstConflicted = conflictedPaths(root, spawnGit, budgetedTimeout())
  abortRebase(root, spawnGit, budgetedTimeout())

  if (remaining() <= 0) return deadlineExceeded(firstConflicted)

  // Several sessions share a desk, so an untracked file usually belongs to another session's unfinished work. Only the
  // untracked files git itself named as in the pull's way are moved aside; any other failure (a conflict, an unreachable
  // remote, refused credentials) moves nothing.
  const named = overwrittenUntrackedPaths(first.stderr)
  const untracked = new Set(named.length === 0 ? [] : untrackedPaths(root, spawnGit, budgetedTimeout()))
  const stray = named.filter((relative) => untracked.has(relative))
  if (stray.length === 0) {
    return unresolved({ root, env, fileProblem, reason: "pull_rebase_failed", conflicted: firstConflicted, failed: first, spawnGit, timeoutMs: GIT_TIMEOUT_MS })
  }

  const quarantinedPaths = await quarantine(root, stray)
  if (remaining() <= 0) return deadlineExceeded(firstConflicted, quarantinedPaths)

  const stashBeforeSecond = stashCount(root, spawnGit, budgetedTimeout())
  const second = await pull(root, spawnPull, budgetedTimeout())
  if (second.status === 0) {
    const { conflicted, paths } = popConflicted(root, spawnGit, budgetedTimeout(), stashBeforeSecond)
    if (!conflicted) return { state: "quarantined", quarantinedPaths }
    abortRebase(root, spawnGit, budgetedTimeout())
    return unresolved({ root, env, fileProblem, reason: "autostash_pop_conflict_after_quarantine", conflicted: paths, quarantinedPaths, spawnGit, timeoutMs: GIT_TIMEOUT_MS })
  }

  const secondConflicted = conflictedPaths(root, spawnGit, budgetedTimeout())
  abortRebase(root, spawnGit, budgetedTimeout())
  return unresolved({ root, env, fileProblem, reason: "pull_rebase_failed_after_quarantine", conflicted: secondConflicted, quarantinedPaths, failed: second, spawnGit, timeoutMs: GIT_TIMEOUT_MS })
}

// ---------------------------------------------------------------------------
// The CLI surface (`mcp/scripts/session-sync.js`).
// ---------------------------------------------------------------------------

function parseSessionSyncArgs(argv) {
  const options = new Map()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    if (typeof key !== "string" || !key.startsWith("--")) throw Object.assign(new Error(`session-sync.js: Remove the unexpected argument: unexpected argument ${JSON.stringify(key ?? "")}`), { code: "session_sync_session_sync_js_remove_the" })
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
  applyPublicationMode({ publication: options.get("publication") }, env)
  const root = options.get("root") ?? env.DESK
  if (typeof root !== "string" || root === "") {
    io.stderr.write("session-sync.js: Pass --root <path>: --root <path> (or the DESK env var) is required\n")
    return 0
  }
  const result = await syncFn({ root, env })
  if (result.repaired === STALE_AUTOSTASH_REBASE) {
    io.stdout.write(`session-sync: ${result.repairedNote}\n`)
  }
  if (result.state === "unresolved") {
    io.stdout.write(`${result.diagnostic}\n`)
  } else if (result.state === "quarantined") {
    io.stdout.write(`session-sync: quarantined ${result.quarantinedPaths.length} stray path(s) (${result.quarantinedPaths.join(", ")}) and synced\n`)
  }
  return 0
}
