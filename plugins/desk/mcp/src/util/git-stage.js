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

// Bounds every git call so a hung hook or a held lock can never block a tool
// call indefinitely. Git hooks stay enabled — disabling them is not this
// module's call to make; a hook that runs long simply times out like any
// other slow git command and is reported the same way a stage or commit
// failure is.
const GIT_TIMEOUT_MS = 10_000

function run(spawnGit, root, args) {
  return spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })
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
 * `git add` exactly `relPaths` (relative to `root`). Returns `{ ok, stderr }`;
 * never throws on a Git failure. A call that runs past `GIT_TIMEOUT_MS` is
 * killed and reported as `{ ok: false, stderr: "timeout" }`.
 */
export function stagePaths(root, relPaths, spawnGit) {
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
export function commitPaths(root, relPaths, message, spawnGit) {
  const result = run(spawnGit, root, ["commit", "-m", message, "--", ...relPaths])
  if (timedOut(result)) return { ok: false, stderr: "timeout" }
  return { ok: result.status === 0, stderr: result.stderr }
}
