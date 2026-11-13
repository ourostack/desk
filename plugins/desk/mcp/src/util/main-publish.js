// Card writes from a checkout on another branch (a worktree for parallel work) land on the remote's default branch.
//
// A worktree cannot switch to the default branch while the main checkout holds it, so Desk does not commit on the
// worktree's own branch. The files are staged as usual in the worktree, then one commit is built on the remote's
// default branch from those staged entries. A private index in the worktree's own Git folder does the building, so the
// main checkout is never touched. The commit is published the way delivery publishes: through the pull-request policy
// when the repository has one, otherwise by a fast-forward push. A rejected push means the remote moved, so the commit
// is rebuilt on the new default branch a bounded number of times.
//
// Once the card is published the worktree catches up (`catchUp`), so no staged copy of it is left against an older HEAD
// and a repository's content-home check, which needs HEAD to be the published commit, passes on the next write. A call
// that was cut off after the remote took the commit is read back from the remote, so a landed write is never reported
// as a failure.
//
// `spawnGit` is a test seam over `spawnSync`; real callers never pass it.

import { spawnSync } from "node:child_process"
import { rmSync } from "node:fs"
import * as path from "node:path"

import { gitEnv } from "../runtime/deliver.js"
import { publicationPolicy, publishPullRequest } from "../runtime/pr-publication.js"

const GIT_TIMEOUT_MS = 10_000
const NETWORK_TIMEOUT_MS = 60_000
const PUSH_ATTEMPTS = 3
const REMOTE = "origin"
const PRIVATE_INDEX = "desk-publish-index"
const REJECTED = /rejected|non-fast-forward|fetch first|failed to push/iu

function runner(spawnGit, cwd, env) {
  return (args, timeout = GIT_TIMEOUT_MS) => {
    const result = spawnGit("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8", timeout, env, maxBuffer: 64 * 1024 * 1024 })
    return {
      status: result.status,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      timedOut: result.status === null,
    }
  }
}

/**
 * The default branch a card write must publish to, when the checkout at `root` is on a different named branch; null when
 * the checkout's own branch is the target, when it is detached, or when the remote names no default branch.
 */
export function defaultBranchForPublication(root, spawnGit) {
  const git = runner(spawnGit, root, gitEnv())
  const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"])
  if (head.status !== 0 || head.stdout.trim() === "") return null
  const remote = git(["symbolic-ref", "--quiet", "--short", `refs/remotes/${REMOTE}/HEAD`])
  const name = remote.status === 0 ? remote.stdout.trim() : ""
  if (!name.startsWith(`${REMOTE}/`)) return null
  const branch = name.slice(REMOTE.length + 1)
  return branch === head.stdout.trim() ? null : branch
}

/**
 * True when Desk's commits for this checkout are published to the default branch by `publishCardCommit`, and its own upstream
 * is not that checkout's branch (a worktree on a feature branch, with no upstream or tracking main). The push worker has nothing
 * to deliver for such a checkout.
 */
export function deliveryIsPublication(root, spawnGit = spawnSync) {
  if (defaultBranchForPublication(root, spawnGit) === null) return false
  const git = runner(spawnGit, root, gitEnv())
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout.trim()
  const merge = git(["config", `branch.${branch}.merge`]).stdout.trim()
  return merge !== `refs/heads/${branch}`
}

/** The commit the remote's default branch holds when it contains `commit`, else null. Reads the remote, so a cut-off call is judged by what landed. */
function landedOn(git, commit, defaultBranch) {
  const remoteRef = `refs/remotes/${REMOTE}/${defaultBranch}`
  if (git(["fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${defaultBranch}:${remoteRef}`], NETWORK_TIMEOUT_MS).status !== 0) return null
  if (git(["merge-base", "--is-ancestor", commit, remoteRef]).status !== 0) return null
  const tip = git(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`]).stdout.trim()
  return tip === "" ? null : tip
}

/**
 * Brings the checkout up to the commit it just published, so the card it staged is not left staged against an older HEAD.
 * A branch that is behind the published commit fast-forwards to it (Git refuses when that would overwrite local changes).
 * A branch with commits of its own stays where it is, and only the entries Desk staged and published are unstaged; the files on disk are untouched.
 * Returns `current`, `fast-forwarded` or `left-on-own-commits`; never throws.
 */
function catchUp(git, top, full, entries, target) {
  try {
    const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]).stdout.trim()
    if (head === target) return "current"
    if (head !== "" && git(["merge-base", "--is-ancestor", head, target]).status === 0 &&
        git(["merge", "--ff-only", "--quiet", target], NETWORK_TIMEOUT_MS).status === 0) return "fast-forwarded"
    const held = git(["ls-files", "-s", "-z", "--full-name", "--", ...full])
    const heldEntries = new Map()
    for (const record of held.stdout.split("\0").filter(Boolean)) {
      const [meta, file] = record.split("\t")
      const [mode, sha, stage] = meta.split(" ")
      if (stage === "0") heldEntries.set(file, `${mode} ${sha}`)
    }
    const unchanged = full.every((file) => heldEntries.get(file) === (entries.get(file) === undefined ? undefined : `${entries.get(file).mode} ${entries.get(file).sha}`))
    if (held.status === 0 && unchanged) git(["reset", "--quiet", "--", ...full])
  } catch {
    // The card is published either way; the worktree just keeps what it had.
  }
  return "left-on-own-commits"
}

function fail(relPaths, what, cause, look, keep, readback = "absent") {
  const files = relPaths.join(", ")
  return { ok: false, readback, stderr: `Desk did not commit ${files}: ${what}. Probable cause: ${cause}. Look further: ${look}. Keep working: ${keep}` }
}

/**
 * Commits `relPaths` (staged in the checkout at `root`) with `message` on top of `defaultBranch` on the remote, and publishes
 * it there. Returns `{ ok, stderr, readback }`; `readback` is `unknown` only when a Git call was cut off, since it may have
 * landed. Never throws on a Git failure.
 */
export function publishCardCommit({ root, relPaths, message, defaultBranch, spawnGit, clock }) {
  const env = gitEnv()
  const probe = runner(spawnGit, root, env)
  const top = probe(["rev-parse", "--show-toplevel"]).stdout.trim()
  const prefix = probe(["rev-parse", "--show-prefix"]).stdout.trim()
  const gitDir = probe(["rev-parse", "--absolute-git-dir"]).stdout.trim()
  const full = relPaths.map((rel) => path.posix.join(prefix, rel.split(path.sep).join("/")))
  // A failed read must stop here: an empty entry list would publish the removal of every path.
  const staged = probe(["ls-files", "-s", "-z", "--full-name", "--", ...relPaths])
  if (staged.status !== 0) return fail(relPaths, "Git could not read the staged entries", "git ls-files failed", `git -C ${root} ls-files -s -- ${relPaths.join(" ")}`, "the card is unchanged on disk; retry the write")
  const entries = new Map()
  for (const record of staged.stdout.split("\0").filter(Boolean)) {
    const [meta, file] = record.split("\t")
    const [mode, sha, stage] = meta.split(" ")
    if (stage !== "0") return fail(relPaths, `${file} has a merge conflict in the index`, "an earlier merge left the file unresolved", `git -C ${root} status`, "resolve the conflict in the checkout, then retry the write")
    entries.set(file, { mode, sha })
  }
  const indexFile = path.join(gitDir, PRIVATE_INDEX)
  const indexGit = runner(spawnGit, top, { ...env, GIT_INDEX_FILE: indexFile })
  const git = runner(spawnGit, top, env)
  const remoteRef = `refs/remotes/${REMOTE}/${defaultBranch}`
  try {
    for (let attempt = 1; attempt <= PUSH_ATTEMPTS; attempt += 1) {
      const fetched = git(["fetch", "--quiet", "--no-tags", REMOTE, `+refs/heads/${defaultBranch}:${remoteRef}`], NETWORK_TIMEOUT_MS)
      if (fetched.status !== 0) {
        return fail(relPaths, `Desk could not fetch ${REMOTE}/${defaultBranch}: ${fetched.stderr.split("\n")[0] || "git fetch failed"}`, "the remote is unreachable, refused this machine's credentials, or is not configured", `git -C ${root} fetch ${REMOTE} ${defaultBranch}`, "the card is still on disk and staged, so the next write publishes it too; retry once the remote answers", fetched.timedOut ? "unknown" : "absent")
      }
      const onto = git(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`]).stdout.trim()
      if (indexGit(["read-tree", onto]).status !== 0) return fail(relPaths, `Desk could not read ${REMOTE}/${defaultBranch} into a private index`, "git read-tree failed", `git -C ${root} log -1 ${remoteRef}`, "nothing was written; retry the write")
      for (const file of full) {
        const entry = entries.get(file)
        const step = entry === undefined
          ? indexGit(["update-index", "--force-remove", "--", file])
          : indexGit(["update-index", "--add", "--cacheinfo", entry.mode, entry.sha, file])
        if (step.status !== 0) return fail(relPaths, `Desk could not stage ${file} for ${defaultBranch}`, "git update-index failed", `git -C ${root} status`, "nothing was written; retry the write")
      }
      const tree = indexGit(["write-tree"]).stdout.trim()
      if (tree === "") return fail(relPaths, "Desk could not write the tree", "git write-tree failed", `git -C ${root} status`, "nothing was written; retry the write")
      if (tree === git(["rev-parse", `${onto}^{tree}`]).stdout.trim()) return { ok: true, stderr: "", published: onto, worktree: catchUp(git, top, full, entries, onto) }
      const commit = git(["commit-tree", tree, "-p", onto, "-m", message]).stdout.trim()
      if (commit === "") return fail(relPaths, "Desk could not create the commit", "git commit-tree failed (check user.name and user.email)", `git -C ${root} config user.email`, "nothing was published; retry the write")
      let policy
      try {
        policy = publicationPolicy(git, onto)
      } catch (error) {
        return fail(relPaths, error.message, "the repository's publication policy cannot be read", `git -C ${root} show ${onto}:.desk/publication.json`, "nothing was published; repair the policy through a pull request")
      }
      let target
      if (policy !== null) {
        try {
          target = publishPullRequest({ git, spawnGit, root: top, upstream: { remote: REMOTE, merge: `refs/heads/${defaultBranch}`, tracking: remoteRef }, head: commit, onto, policy, clock }).head
        } catch (error) {
          // A call cut off after GitHub merged the pull request still published the card.
          target = landedOn(git, commit, defaultBranch)
          if (target === null) return fail(relPaths, error.message, "the publication pull request did not merge", `gh pr list --head desk/publish/${commit} --state all`, "the card is still staged; check the pull request, then retry the write", "unknown")
        }
      } else {
        const pushed = git(["push", "--quiet", REMOTE, `${commit}:refs/heads/${defaultBranch}`], NETWORK_TIMEOUT_MS)
        const landed = pushed.timedOut ? landedOn(git, commit, defaultBranch) : null
        if (landed !== null) target = landed
        else if (pushed.status !== 0) {
          if (!pushed.timedOut && REJECTED.test(pushed.stderr)) continue
          return fail(relPaths, `the remote refused the push to ${defaultBranch}`, pushed.timedOut ? "the push was cut off" : "the remote rejected the commit", `git -C ${root} push ${REMOTE} HEAD:refs/heads/${defaultBranch}`, "the card is still staged, so the next write retries the publication", pushed.timedOut ? "unknown" : "absent")
        } else target = commit
      }
      git(["update-ref", remoteRef, target])
      return { ok: true, stderr: "", published: target, worktree: catchUp(git, top, full, entries, target) }
    }
    return fail(relPaths, `the remote kept rejecting the push to ${defaultBranch} after ${PUSH_ATTEMPTS} tries`, "other writers pushed to the default branch at the same time, or a hook declined the commit", `git -C ${root} fetch ${REMOTE} ${defaultBranch}`, "the card is still staged; retry the write")
  } finally {
    rmSync(indexFile, { force: true })
  }
}
