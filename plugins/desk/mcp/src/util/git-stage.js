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

import { mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

// Bounds every git call so a hung hook or a held lock can never block a tool
// call indefinitely. Git hooks stay enabled — disabling them is not this
// module's call to make; a hook that runs long simply times out like any
// other slow git command and is reported the same way a stage or commit
// failure is.
const GIT_TIMEOUT_MS = 10_000
const TOOL_COMMIT_ENV = "DESK_TOOL_COMMIT" // the same name `desk/card-commit-guard.js` exports; kept literal so this module stays dependency-free

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

function run(spawnGit, root, args, extra = {}) {
  return spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS, ...extra })
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

/**
 * Commits exactly what the index holds at `relPaths` (`entries`, from `indexEntries` for the same paths), never what the working tree holds there: it builds a temporary index from HEAD, copies in the real index's
 * entry for each path (or removes the path when the real index has none), and commits that index. The real index is untouched, so other staged work stays
 * staged, and a later edit to a file in the working tree can never ride along. Returns `{ ok, stderr }`; never throws on a Git failure.
 */
export function commitIndexPaths(root, relPaths, entries, message, spawnGit, stateBranch) {
  const refusal = commitBranchRefusal(root, spawnGit, stateBranch)
  if (refusal !== null) return { ok: false, stderr: refusal }
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-tidy-index-"))
  try {
    const env = { ...process.env, [TOOL_COMMIT_ENV]: "1", GIT_INDEX_FILE: path.join(dir, "index") }
    const hasHead = run(spawnGit, root, ["rev-parse", "--verify", "-q", "HEAD"]).status === 0
    const seed = run(spawnGit, root, hasHead ? ["read-tree", "HEAD"] : ["read-tree", "--empty"], { env })
    if (seed.status !== 0) return { ok: false, stderr: seed.stderr }
    const held = new Set(entries.map((entry) => entry.path))
    const lines = [
      ...entries.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}\0`),
      ...relPaths.filter((p) => !held.has(p)).map((p) => `0 ${"0".repeat(40)}\t${p}\0`),
    ]
    const update = run(spawnGit, root, ["update-index", "-z", "--index-info"], { env, input: lines.join("") })
    if (update.status !== 0) return { ok: false, stderr: update.stderr }
    const result = run(spawnGit, root, ["commit", "-m", message], { env })
    if (timedOut(result)) return { ok: false, stderr: "timeout" }
    return { ok: result.status === 0, stderr: result.stderr }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * `git add` exactly `relPaths` (relative to `root`). Returns `{ ok, stderr }`;
 * never throws on a Git failure. A call that runs past `GIT_TIMEOUT_MS` is
 * killed and reported as `{ ok: false, stderr: "timeout" }`.
 */
export function stagePaths(root, relPaths, spawnGit, stateBranch) {
  const refusal = commitBranchRefusal(root, spawnGit, stateBranch)
  if (refusal !== null) return { ok: false, stderr: refusal }
  const result = run(spawnGit, root, ["add", "--", ...relPaths])
  if (timedOut(result)) return { ok: false, stderr: "timeout" }
  return { ok: result.status === 0, stderr: result.stderr }
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
  if (refusal !== null) return { ok: false, stderr: refusal }
  // The desk's own pre-commit hook (`desk/card-commit-guard.js`) refuses a commit that changes a task card unless Desk is the one committing:
  // this is Desk's commit path, so it says so for the git call (and only for that call).
  const result = run(spawnGit, root, ["commit", "-m", message, "--", ...relPaths], { env: { ...process.env, [TOOL_COMMIT_ENV]: "1" } })
  if (timedOut(result)) return { ok: false, stderr: "timeout" }
  return { ok: result.status === 0, stderr: result.stderr }
}
