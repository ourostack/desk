// The commit for the cheap append path: a task's `log.md` entry is in the file when `task_update` returns, and the detached
// push worker (`runtime/sync-worker.js`) commits it, so the entry never depends on the server living through a quiet moment.
//
// A waiting log is a task's `log.md` (a `log.md` beside a `task.md`) that Git holds as changed or untracked. The worker
// waits until no waiting log has changed for `quietMs`, and never more than `maxWaitMs`, then commits every waiting log in
// one commit and pushes once, so rapid appends become one commit and one push. Session start commits any a server left
// behind (`runtime/session-sync.js`). A commit Git refuses leaves the logs written and waiting for the next worker or start.

import { spawnSync } from "node:child_process"
import { existsSync, statSync } from "node:fs"
import * as path from "node:path"
import { commitPaths, hasUnstagedWork, stagePaths, stagedChanges } from "../util/git-stage.js"

const APPEND_QUIET_MS = 5000
const APPEND_MAX_WAIT_MS = 30_000

/** The task logs under `root` that differ from HEAD or are untracked, relative to `root` and with `/`. Empty when Git cannot say. */
export function waitingLogs(root, spawnGit = spawnSync) {
  const git = (args) => spawnGit("git", ["-C", root, ...args], { windowsHide: true, encoding: "utf8", timeout: 10_000 })
  const glob = [":(glob)**/log.md"]
  let found
  if (existsSync(path.join(root, ".git"))) {
    // One status call (what differs from HEAD, and what is untracked) in place of a diff and an ls-files; it takes no lock. Its paths are
    // relative to the top of the repository, which `root` is here.
    const status = git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all", "--", ...glob])
    if (status.status !== 0) return []
    found = String(status.stdout).split("\0").filter((entry) => entry.length > 3).map((entry) => entry.slice(3))
  } else {
    const changed = git(["diff", "--name-only", "-z", "--relative", "HEAD", "--", ...glob])
    const untracked = git(["ls-files", "-z", "--others", "--exclude-standard", "--", ...glob])
    if (changed.status !== 0 || untracked.status !== 0) return []
    found = `${changed.stdout}${untracked.stdout}`.split("\0")
  }
  // A removed log is not an append. A conflicted one never commits: Git refuses a commit of named paths mid-merge, and Desk refuses one on a detached HEAD.
  return found.filter((rel) => rel !== "" && existsSync(path.join(root, rel)) && existsSync(path.join(root, path.dirname(rel), "task.md")))
}

/** Waits until no waiting log has changed for `quietMs`, at most `maxWaitMs`. `sleep` is the caller's clock. */
export async function settleLogs(root, { sleep, spawnGit = spawnSync, quietMs = APPEND_QUIET_MS, maxWaitMs = APPEND_MAX_WAIT_MS, now = Date.now }) {
  const until = now() + maxWaitMs
  for (;;) {
    // A log removed since Git listed it has no time to wait for.
    const times = waitingLogs(root, spawnGit).map((rel) => statSync(path.join(root, rel), { throwIfNoEntry: false })).filter(Boolean).map((stats) => stats.mtimeMs)
    const newest = Math.max(0, ...times)
    const wait = Math.min(newest + quietMs, until) - now()
    if (wait <= 0) return
    await sleep(wait)
  }
}

function commitMessage(rels) {
  return rels.length === 1 ? `task_update: log ${path.posix.dirname(rels[0]).split("/").slice(-2).join("/")}` : `task_update: log ${rels.length} cards`
}

/** Commits every waiting log under `root` in one commit. Returns "committed", "empty", "stage_failed" or "commit_failed". Never throws. */
export function commitWaitingLogs(root, spawnGit = spawnSync) {
  try {
    const rels = waitingLogs(root, spawnGit)
    if (rels.length === 0) return "empty"
    if (!stagePaths(root, rels, spawnGit).ok) return "stage_failed"
    const committed = commitPaths(root, rels, commitMessage(rels), spawnGit)
    // A commit reported as failed or unknown may have landed (a timeout on a slow machine): when nothing at these paths is left to commit, it did.
    if (!committed.ok && (hasUnstagedWork(root, rels, spawnGit) || stagedChanges(root, rels, spawnGit)?.length !== 0)) return "commit_failed"
    return "committed"
  } catch {
    return "commit_failed"
  }
}
