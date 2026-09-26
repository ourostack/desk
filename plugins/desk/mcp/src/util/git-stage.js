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

function run(spawnGit, root, args) {
  return spawnGit("git", ["-C", root, ...args], { encoding: "utf8" })
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

/** `git add` exactly `relPaths` (relative to `root`). Returns `{ ok, stderr }`; never throws on a Git failure. */
export function stagePaths(root, relPaths, spawnGit) {
  const result = run(spawnGit, root, ["add", "--", ...relPaths])
  return { ok: result.status === 0, stderr: result.stderr }
}
