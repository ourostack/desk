import { lstatSync } from "node:fs"
import * as path from "node:path"

const OPERATION_MARKERS = [
  "rebase-merge", "rebase-apply", "MERGE_HEAD", "MERGE_AUTOSTASH",
  "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "sequencer", "index.lock",
]

export const PRESERVE_SYNC_WORK = Object.freeze({ state: "not_attempted", reason: "preserve_pending_work" })

function knownNonGitRoot(root, failed) {
  if (typeof root !== "string" || uncertainGitResult(failed) ||
      !/not a git repository \(or any of the parent directories\): \.git/iu.test(String(failed.stderr))) return false
  for (let directory = path.resolve(root); ; directory = path.dirname(directory)) {
    try {
      lstatSync(path.join(directory, ".git"))
      return false
    } catch (error) {
      if (error.code !== "ENOENT") return false
    }
    if (path.dirname(directory) === directory) return true
  }
}

/** Read-only preconditions, not exclusion of concurrent filesystem writers. */
export function inspectSyncState(runGit, root) {
  const unknown = (failed) => ({ state: "unknown", reason: "git_state_unavailable", error: gitErrorLine(failed?.stderr) })
  const located = runGit(["rev-parse", "--absolute-git-dir"])
  if (located.status !== 0 || uncertainGitResult(located)) return knownNonGitRoot(root, located) ? { state: "not_git" } : unknown(located)
  if (!path.isAbsolute(String(located.stdout ?? "").trim())) return unknown(located)
  const directory = located.stdout.trim()
  const operations = []
  for (const marker of OPERATION_MARKERS) {
    try {
      lstatSync(path.join(directory, marker))
      operations.push(marker)
    } catch (error) {
      if (error.code !== "ENOENT") return unknown({ stderr: `Git operation metadata could not be read (${error.code})` })
    }
  }
  if (operations.length > 0) return { state: "blocked", reason: "git_operation_in_progress", operations }
  const entries = runGit(["ls-files", "--stage", "-z"])
  if (entries.status !== 0 || uncertainGitResult(entries) || typeof entries.stdout !== "string") return unknown(entries)
  const conflicted = []
  for (const entry of entries.stdout.split("\0").filter(Boolean)) {
    const match = /^\d+ [a-f0-9]+ ([0-3])\t([\s\S]+)$/u.exec(entry)
    if (!match) return unknown({ stderr: "Git index entries could not be read" })
    if (match[1] !== "0") conflicted.push(match[2])
  }
  if (conflicted.length > 0) return { state: "blocked", reason: "unmerged_index", conflicted: [...new Set(conflicted)] }
  const branch = runGit(["symbolic-ref", "--quiet", "HEAD"])
  if (branch.status === 1) return { state: "blocked", reason: "detached_head" }
  if (branch.status !== 0 || uncertainGitResult(branch) || typeof branch.stdout !== "string" || !branch.stdout.trim()) return unknown(branch)
  const head = runGit(["rev-parse", "--verify", "--quiet", "HEAD"])
  if (uncertainGitResult(head) || (head.status !== 0 && head.status !== 1) ||
      (head.status === 0 && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(String(head.stdout ?? "").trim()))) return unknown(head)
  return { state: "clear", head: head.status === 0 ? head.stdout.trim() : null, branch: branch.stdout.trim(), index: entries.stdout }
}

export function sameSyncVersion(before, after) {
  return before.state === "clear" && after.state === "clear" &&
    before.head === after.head && before.branch === after.branch && before.index === after.index
}

export function inspectSyncTarget(runGit) {
  const unavailable = (failed) => ({ state: "unknown", reason: "git_state_unavailable", error: gitErrorLine(failed?.stderr) })
  const remote = runGit(["remote"])
  if (remote.status !== 0 || uncertainGitResult(remote) || typeof remote.stdout !== "string") return unavailable(remote)
  if (!remote.stdout.trim()) return { state: "none", reason: "no_remote" }
  const upstream = runGit(["rev-parse", "--symbolic-full-name", "@{upstream}"])
  if (upstream.status !== 0 || uncertainGitResult(upstream)) {
    return !uncertainGitResult(upstream) && /no upstream configured|no such branch/iu.test(String(upstream.stderr))
      ? { state: "none", reason: "no_upstream" } : unavailable(upstream)
  }
  if (typeof upstream.stdout !== "string" || !upstream.stdout.trim()) return unavailable(upstream)
  const counts = runGit(["rev-list", "--left-right", "--count", "@{u}...HEAD"])
  const match = /^(\d+)\s+(\d+)$/u.exec(String(counts.stdout ?? "").trim())
  if (counts.status !== 0 || uncertainGitResult(counts) || !match) return unavailable(counts)
  const [, behind, ahead] = match.map(Number)
  if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind)) return unavailable(counts)
  return { state: "configured", ahead, behind }
}

export function uncertainGitResult(result) {
  return result.status === null || result.status === undefined || Boolean(result.error) || Boolean(result.signal)
}

export function gitErrorLine(stderr) {
  const line = String(stderr ?? "").split(/\r?\n/u).map((value) => value.trim()).find((value) => value !== "" && !/^hint:/iu.test(value)) ?? ""
  return line.replace(/\/\/[^/@\s]+@/gu, "//").slice(0, 200)
}

export function pushFailure(result) {
  const error = gitErrorLine(result.stderr)
  const text = String(result.stderr ?? "")
  if (uncertainGitResult(result)) return { reason: "push_failed", cause: result.error?.code === "ETIMEDOUT" || result.signal ? "deadline" : "other", effects: { push: "unknown" }, error }
  const refs = String(result.stdout ?? "").split(/\r?\n/u).filter((line) => /^[ !+=*_-]\t/u.test(line))
  if (refs.some((line) => line.startsWith("!\t")) && refs.every((line) => /^[!=]\t/u.test(line))) {
    return { reason: "push_rejected", cause: "rejected", effects: { push: "not_applied" }, error }
  }
  const cause = /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey|Invalid username or password|Host key verification failed|Repository not found|returned error: 40[13]|HTTP 40[13]|terminal prompts disabled/iu.test(text)
    ? "auth_failed"
    : /Could not resolve host|unable to access|Could not read from remote|Connection (?:refused|timed out|reset)|Network is unreachable|No route to host|Failed to connect|unable to connect|Operation timed out|timed out|Temporary failure in name resolution|ssh: connect to host/iu.test(text)
      ? "unreachable" : "other"
  return { reason: "push_failed", cause, effects: { push: "unknown" }, error }
}
