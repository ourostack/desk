// Git staging helpers shared by the tools that write track and task cards
// (M4-5 fix round 4).
//
// The one-time tidy makes many moves and edits and commits once, at the end.
// To tell the tidy's own earlier steps apart from another session's work,
// every Desk tool the tidy uses stages what it writes. So on a Git desk:
//   - staged changes are this tidy's in-flight work, and never block a move;
//   - unstaged changes to tracked files, and untracked files that are not
//     ignored, belong to someone else, and do.
//
// `spawnGit` is an injectable seam over `node:child_process`'s `spawnSync`,
// for tests only; real callers never pass it.

import { existsSync } from "node:fs"
import * as path from "node:path"

import { budgeted, commitCaptured, operationAnswer } from "./cas-commit.js"

// Bounds every git call so a hung hook or a held lock can never block a tool
// call indefinitely. Git hooks stay enabled — disabling them is not this
// module's call to make; a hook that runs long simply times out like any
// other slow git command and is reported the same way a stage or commit
// failure is.
const GIT_TIMEOUT_MS = 10_000
const TOOL_COMMIT_ENV = "DESK_TOOL_COMMIT" // the same name `desk/card-commit-guard.js` exports; card_commit_guard.test.js checks they match

/**
 * Why Desk must not stage or commit in `root` right now, or null when it may. A detached HEAD is always refused. Beyond that, `stateBranch` says what the caller knows:
 * - a branch name: the checkout must be on it (the host configured a state branch);
 * - `null`: no state branch is configured, so the checkout must be on the branch `origin/HEAD` names when the remote has one, and any named branch will do otherwise;
 * - `undefined`: the caller was not told, so only the detached-HEAD rule applies. The session's write gate has already applied the full rule before a tool runs; this is the backstop for any path that skips it.
 * A Git read that cannot run (a status other than 0, or 1 for a detached HEAD) is not a refusal here: the stage or commit itself then fails and says why.
 */
export function commitBranchRefusal(root, spawnGit, stateBranch) {
  const head = run(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
  const status = head?.status
  if (status !== 0 && status !== 1) return null
  const found = status === 0 ? String(head.stdout ?? "").trim() : ""
  if (found === "") return "Desk did not write: the desk checkout is on a detached HEAD. Switch it to a branch and try again."
  let expected = stateBranch
  if (expected === null) {
    const remote = run(spawnGit, root, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"])
    const name = remote.status === 0 ? String(remote.stdout).trim() : ""
    expected = name.startsWith("origin/") ? name.slice("origin/".length) : undefined
  }
  if (expected === undefined || found === expected) return null
  return `Desk did not write: the desk checkout is on branch \`${found}\`, and Desk writes only on \`${expected}\`. Switch the checkout to \`${expected}\` and try again.`
}

// Another Git process (often Desk's own background loop committing an improvement card) can hold the desk's index or a ref lock
// for a moment. Staging waits for an observed index lock before dispatch; a failed mutation is never redispatched,
// because its hooks or filters may already have taken effect. Desk's background writers run with DESK_GIT_YIELD=1 and never wait.
const LOCK_WAIT_MS = 3000
const LOCK_RETRY_MS = 50
const LOCK_HELD = /Unable to create '[^']*\.lock'|\.lock': File exists|cannot lock ref/u
export const YIELD_ENV = "DESK_GIT_YIELD"

/** True when this process is one of Desk's background writers, which give way to a person's writes. */
export function yieldsGitLock() {
  return process.env[YIELD_ENV] === "1"
}

function lockHeld(result) {
  return result?.status !== 0 && LOCK_HELD.test(String(result?.stderr))
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function run(spawnGit, root, args, extra = {}) {
  const once = () => spawnGit("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS, ...extra })
  let result = once()
  if (!["symbolic-ref", "rev-parse", "diff", "ls-files"].includes(args[0]) || result?.error || yieldsGitLock()) return result
  const deadline = Date.now() + LOCK_WAIT_MS
  while (!result?.error && lockHeld(result) && Date.now() < deadline) {
    sleepSync(LOCK_RETRY_MS)
    result = once()
  }
  return result
}

/** True when another Git process holds `root`'s index lock right now. False when Git cannot say. */
export function indexLockHeld(root, spawnGit) {
  const result = spawnGit("git", ["-C", root, "rev-parse", "--git-path", "index.lock"], { windowsHide: true, encoding: "utf8", timeout: GIT_TIMEOUT_MS })
  return result.status === 0 && existsSync(path.resolve(root, String(result.stdout).trim()))
}

/** True when `result` (a `spawnSync`-shaped return value) is `spawnGit` reporting its own timeout kill. */
function timedOut(result) {
  return Boolean(result.error) && result.error.code === "ETIMEDOUT"
}

/** True when `root` is inside a Git work tree. A failing or missing `git` means no. */
export function isGitRepository(root, spawnGit) {
  let result
  try {
    result = run(spawnGit, root, ["rev-parse", "--is-inside-work-tree"])
  } catch {
    return false
  }
  return result.status === 0 && result.stdout.trim() === "true"
}

/**
 * True when any of `relPaths` (relative to `root`) holds unstaged changes to a
 * tracked file (`git diff --name-only`) or an untracked, non-ignored file
 * (`git ls-files --others --exclude-standard`). A failing Git command counts
 * as unstaged work, so a caller refusing on it fails safe.
 */
export function hasUnstagedWork(root, relPaths, spawnGit) {
  for (const args of [
    ["diff", "--name-only", "--", ...relPaths],
    ["ls-files", "--others", "--exclude-standard", "--", ...relPaths],
  ]) {
    const result = run(spawnGit, root, args)
    if (result.status !== 0 || result.stdout.trim() !== "") return true
  }
  return false
}

/**
 * Whether Git holds any of `relPaths` as a conflict (unmerged index entries): staging such a path marks the conflict resolved with its
 * markers still in the file. `false` when Git cannot say, so the caller's own stage or commit reports Git's failure.
 */
export function hasUnmergedPath(root, relPaths, spawnGit) {
  const result = run(spawnGit, root, ["ls-files", "-u", "--", ...relPaths])
  return result.status === 0 && result.stdout.trim() !== ""
}

/**
 * What is staged at `relPaths`, with renames detected: `[{ status, paths }]`, where `status` is git's letter plus a rename's similarity (`R100`, `D`, `A`, `M`)
 * and `paths` is the old and new path of a rename or the one path otherwise. Returns `null` when Git fails, so a caller refusing on it fails safe.
 */
export function stagedChanges(root, relPaths, spawnGit) {
  const result = run(spawnGit, root, ["diff", "--cached", "-M", "--name-status", "-z", "--", ...relPaths])
  if (result.status !== 0) return null
  const fields = result.stdout.split("\0")
  const changes = []
  for (let i = 0; i < fields.length && fields[i] !== ""; ) {
    const status = fields[i]
    const count = status.startsWith("R") || status.startsWith("C") ? 2 : 1
    changes.push({ status, paths: fields.slice(i + 1, i + 1 + count) })
    i += 1 + count
  }
  return changes
}

/** The index entries at exactly `relPaths`: `[{ mode, sha, stage, path }]`, or `null` when Git fails. A path the index does not hold has no entry. */
export function indexEntries(root, relPaths, spawnGit) {
  const result = run(spawnGit, root, ["ls-files", "-s", "-z", "--", ...relPaths])
  if (result.status !== 0) return null
  return result.stdout.split("\0").filter(Boolean).map((record) => {
    const [meta, entryPath] = record.split("\t")
    const [mode, sha, stage] = meta.split(" ")
    return { mode, sha, stage, path: entryPath }
  })
}

// #561: a commit Git was killed for (a post-commit hook such as Git LFS's outlasting GIT_TIMEOUT_MS) or reported as failed can
// still have landed. The failed dispatch is never repeated (a commit's hooks may already have run); HEAD is read back once instead.
const READBACK_LIMIT = 50

/** HEAD's full hash, `""` for an unborn branch, or null when Git cannot say. A read; only `run`'s read retry applies. */
function headOf(root, spawnGit) {
  const result = run(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"])
  if (result?.error) return null
  if (result?.status === 0) return String(result.stdout).trim()
  return result?.status === 1 && String(result?.stdout ?? "").trim() === "" ? "" : null
}

// Git's own message clean-up, near enough to compare: trailing spaces off each line, runs of blank lines folded, ends trimmed.
const cleanMessage = (text) => String(text).split("\n").map((line) => line.replace(/\s+$/u, "")).join("\n").replace(/\n{3,}/gu, "\n\n").trim()

function nulList(result) {
  return String(result.stdout).split("\0").filter(Boolean)
}

/** The entries `commit`'s tree holds at `relPaths`, as sorted `mode sha\tpath` lines, or null when Git cannot say. */
function treeEntries(root, commit, relPaths, spawnGit) {
  const tree = run(spawnGit, root, ["ls-tree", "-r", "-z", commit, "--", ...relPaths])
  if (tree?.status !== 0) return null
  return nulList(tree).map((record) => {
    const [meta, entryPath] = record.split("\t")
    const [mode, , sha] = meta.split(" ")
    return `${mode} ${sha}\t${entryPath}`
  }).sort()
}

const entryLines = (entries) => entries.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}`).sort()
const sameEntries = (a, b) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Whether a commit of exactly `relPaths` with `message` landed after HEAD was `before` (`""` for unborn), and whether it is still in effect.
 * `expected` is what this call meant to commit at `relPaths`, captured before it was dispatched (sorted `mode sha\tpath` lines; null when it
 * could not be captured). Returns `{ readback, landed }`:
 * - `committed`: a new commit on HEAD has that message, changes only those paths and holds `expected` there, and HEAD holds `expected` there now;
 * - `absent`: HEAD has not moved, or no new commit touches those paths;
 * - `unknown` otherwise, and whenever Git cannot answer. When our commit landed but HEAD no longer holds it, `landed` names both
 *   (`{ commit, head }`): it happened, but it is not in effect, so nothing claims completion and nothing replays it. Reads only.
 */
export function readBackCommit(root, relPaths, message, before, expected, spawnGit) {
  const unknown = { readback: "unknown" }
  if (before === null) return unknown
  const after = headOf(root, spawnGit)
  if (after === null) return unknown
  if (after === before) return { readback: "absent" }
  if (after === "") return unknown
  const listed = run(spawnGit, root, ["rev-list", `--max-count=${READBACK_LIMIT + 1}`, before === "" ? after : `${before}..${after}`])
  if (listed?.status !== 0) return unknown
  const commits = String(listed.stdout).split("\n").map((line) => line.trim()).filter(Boolean)
  if (commits.length > READBACK_LIMIT) return unknown
  let touched = false
  for (const commit of commits) {
    const ours = run(spawnGit, root, ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "-z", commit, "--", ...relPaths])
    if (ours?.status !== 0) return unknown
    const inside = nulList(ours).length
    if (inside === 0) continue
    touched = true
    if (expected === null) return unknown
    const all = run(spawnGit, root, ["diff-tree", "--root", "--no-commit-id", "-r", "--name-only", "-z", commit])
    const body = run(spawnGit, root, ["log", "-1", "--format=%B", commit])
    if (all?.status !== 0 || body?.status !== 0) return unknown
    if (nulList(all).length !== inside || cleanMessage(body.stdout) !== cleanMessage(message)) continue
    const held = treeEntries(root, commit, relPaths, spawnGit)
    if (held === null) return unknown
    if (!sameEntries(held, expected)) continue
    const now = commit === after ? held : treeEntries(root, after, relPaths, spawnGit)
    if (now === null) return unknown
    return sameEntries(now, expected) ? { readback: "committed" } : { readback: "unknown", landed: { commit, head: after } }
  }
  return touched ? unknown : { readback: "absent" }
}

// A failed commit call's answer: `ok` when the read-back finds it landed and in effect (`readback: "committed"`), so every caller schedules its push; otherwise the failure with its read-back.
// A failure also carries what the call meant to commit (`capture`: the HEAD and branch it read before dispatch and the captured entries),
// so its route can finish exactly that change and never whatever the paths hold later (R2, R3). No capture means no route may commit.
// `made` is set when the call is known to have made a commit object whose effect is uncertain (a branch update cut off, or a
// post-commit hook that moved HEAD): a read-back that finds nothing then says `unknown`, never `absent`.
function afterFailedCommit(stderr, root, relPaths, message, before, expected, spawnGit, branch, made = false) {
  const { readback, landed } = readBackCommit(root, relPaths, message, before, expected, spawnGit)
  if (readback === "committed") return { ok: true, stderr, readback }
  const capture = before !== null && expected !== null && branch ? { before, branch, expected } : null
  return { ok: false, stderr, readback: made && readback === "absent" ? "unknown" : readback, ...(landed ? { landed } : {}), ...(capture ? { capture } : {}) }
}

/** The branch HEAD is on, or null for a detached HEAD or when Git cannot say. A read. */
function branchOf(root, spawnGit) {
  const head = run(spawnGit, root, ["symbolic-ref", "--short", "-q", "HEAD"])
  const name = head?.status === 0 ? String(head.stdout ?? "").trim() : ""
  return name === "" ? null : name
}

/**
 * Commits exactly what the index holds at `relPaths` (`entries`, from `indexEntries` for the same paths), never what the working tree holds there, and only on
 * the HEAD it read (#632). It builds a private index from that HEAD with the real index's entry for each path (and every leaf HEAD holds under a folder path
 * that the index no longer does removed), runs the hooks git commit runs, makes the commit on that HEAD, and moves the branch by one compare-and-swap from it:
 * another writer's commit landing at any point in between makes Git refuse, so it stands and nothing of this call's is committed over it. That is
 * `cas-commit.js`'s `commitCaptured`, the core the hand finish uses, here with Desk's own commit marker and one total `GIT_TIMEOUT_MS` budget for the whole
 * commit. While a merge, cherry-pick, revert or rebase is in progress it commits nothing. A pre-commit hook that changes the tree Desk judged holds the
 * commit (what the hook wrote stays written); one that writes only to the working tree does not. The real index is untouched, so other staged work stays staged,
 * and a later edit to a file in the working tree can never ride along. Returns `{ ok, stderr }`, and on a failure the read-back and capture
 * (`afterFailedCommit`); never throws on a Git failure.
 */
export function commitIndexPaths(root, relPaths, entries, message, spawnGit, stateBranch) {
  const deadline = Date.now() + GIT_TIMEOUT_MS
  const step = budgeted(spawnGit, deadline)
  const refusal = commitBranchRefusal(root, step, stateBranch)
  if (refusal !== null) return { ok: false, stderr: refusal, readback: "absent" }
  const before = headOf(root, step)
  const branch = branchOf(root, step)
  if (before === null || branch === null) return { ok: false, stderr: "Git could not read the branch and HEAD to commit on, so nothing was committed", readback: "absent" }
  // What this call means to commit is exactly `entries` at `relPaths`, and nothing at the paths the index does not hold.
  const expected = entryLines(entries)
  const failed = (reason, made) => afterFailedCommit(reason, root, relPaths, message, before, expected, spawnGit, branch, made)
  const operation = operationAnswer(step, root)
  if (operation) return failed(operation.reason, false)
  if (sameEntries(before === "" ? [] : treeEntries(root, before, relPaths, step), expected)) return failed("nothing to commit: HEAD already holds these paths as the index does", false)
  const answer = commitCaptured({ root, paths: relPaths, wanted: expected, head: before, branch, message, spawnGit, env: { ...process.env, [TOOL_COMMIT_ENV]: "1" }, toolCommit: true, deadline })
  if (answer.state === "finished") return { ok: true, stderr: "" }
  return failed(answer.reason, answer.commit !== undefined)
}

/**
 * `git add` exactly `relPaths` (relative to `root`); `all: true` adds `-A`, so a deletion in the working tree is staged too,
 * still only at those paths. Returns `{ ok, stderr }`; never throws on a Git failure. A call that runs past `GIT_TIMEOUT_MS` is
 * killed and reported as `{ ok: false, stderr: "timeout" }`.
 */
export function stagePaths(root, relPaths, spawnGit, stateBranch, { all = false } = {}) {
  const refusal = commitBranchRefusal(root, spawnGit, stateBranch)
  if (refusal !== null) return { ok: false, stderr: refusal }
  if (!yieldsGitLock()) {
    const deadline = Date.now() + LOCK_WAIT_MS
    while (indexLockHeld(root, spawnGit) && Date.now() < deadline) sleepSync(LOCK_RETRY_MS)
  }
  const result = run(spawnGit, root, ["add", ...(all ? ["-A"] : []), "--", ...relPaths])
  if (timedOut(result)) return { ok: false, stderr: "timeout" }
  return { ok: result.status === 0, stderr: result.stderr }
}

/**
 * What `git commit -- <relPaths>` is about to commit, captured before it is dispatched (R4, 0972 on #625): the index entries at those paths, as sorted
 * `mode sha\tpath` lines, when the working tree there matches the index (the case for every Desk caller, which stages first). Null when it does not or
 * Git cannot say: then the commit would take working-tree bytes this read did not hash, so a read-back can never call it committed. Reads only.
 */
function capturedPaths(root, relPaths, spawnGit) {
  const entries = indexEntries(root, relPaths, spawnGit)
  if (entries === null || entries.some((entry) => entry.stage !== "0")) return null
  const differs = run(spawnGit, root, ["diff", "--quiet", "--", ...relPaths])
  return differs?.status === 0 ? entryLines(entries) : null
}

/**
 * `git commit` exactly `relPaths` (relative to `root`) with `message`, never
 * `-a`/`-A` and never a pattern: the pathspec after `--` names precisely the
 * paths this call commits, so a path another process staged in the same
 * index in the meantime is left staged and untouched, not swept into this
 * commit. Returns `{ ok, stderr }`; never throws on a Git failure. A call
 * that runs past `GIT_TIMEOUT_MS` (a hung commit hook, most often) is killed
 * and reported as `{ ok: false, stderr: "timeout" }`.
 */
export function commitPaths(root, relPaths, message, spawnGit, stateBranch) {
  const refusal = commitBranchRefusal(root, spawnGit, stateBranch)
  if (refusal !== null) return { ok: false, stderr: refusal, readback: "absent" }
  const before = headOf(root, spawnGit)
  const branch = branchOf(root, spawnGit)
  const expected = capturedPaths(root, relPaths, spawnGit)
  // The desk's own pre-commit hook (`desk/card-commit-guard.js`) refuses a commit that changes a task card unless Desk is the one committing:
  // this is Desk's commit path, so it says so for the git call (and only for that call).
  const result = run(spawnGit, root, ["commit", "-m", message, "--", ...relPaths], { env: { ...process.env, [TOOL_COMMIT_ENV]: "1" } })
  if (!timedOut(result) && result.status === 0) return { ok: true, stderr: result.stderr }
  return afterFailedCommit(timedOut(result) ? "timeout" : result.stderr, root, relPaths, message, before, expected, spawnGit, branch)
}
