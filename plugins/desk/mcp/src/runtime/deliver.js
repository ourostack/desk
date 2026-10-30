// Delivering the desk's local commits to its remote without touching the shared checkout (#396).
//
// A desk is often one checkout shared by several sessions, so its working tree holds other sessions' uncommitted and
// untracked files. The push worker used to make room for its own push by rebasing that checkout (`git pull --rebase
// --autostash`), and anything in the way stopped every later push: an untracked file matching an incoming tracked one,
// or a conflict on a task card while other files were dirty. Desk's commits then piled up locally while every tool reply
// still said they were being pushed.
//
// Delivery now never depends on the shared checkout's working tree:
// 1. Fetch the upstream branch. When it already contains everything local, there is nothing to push.
// 2. When the local branch is a fast-forward of the upstream, push it as it is.
// 3. Otherwise replay the local commits onto the upstream in a private, temporary worktree under Desk's state folder,
//    resolving conflicts on Desk's own text files (task cards keep both sides' lines and the newer frontmatter; logs
//    keep both sides' lines), and push the result. A commit with a conflict Desk cannot resolve is left out and named;
//    every other commit still lands. A push that loses a race is fetched and replayed again.
// 4. Move the shared checkout to what was pushed only the way `git checkout` would: files that differ are updated, and
//    a file another session has changed, or an untracked file in the way, stops the move instead of being overwritten.
//    An untracked file whose content is exactly what is coming in is the one exception: it is replaced by itself.
//
// Never `--force`, never a stash, never a rebase in the shared checkout. Every Git call runs with
// `GIT_TERMINAL_PROMPT=0` and a timeout. `spawnGit` (over `spawnSync`) is a test seam.

import { spawnSync } from "node:child_process"
import { mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs"
import * as path from "node:path"

import { lastStartRootKey, resolveDeskStateDir } from "./last-start.js"

const GIT_TIMEOUT_MS = 10_000
const NETWORK_TIMEOUT_MS = 60_000
const CHECKOUT_TIMEOUT_MS = 120_000
const PUSH_ATTEMPTS = 3

// `GIT_SSH_COMMAND` gets `-o BatchMode=yes` so an SSH remote can never prompt; a caller's own command is extended.
export function gitEnv() {
  const existing = process.env.GIT_SSH_COMMAND
  const sshCommand = typeof existing === "string" && existing.trim() !== "" ? `${existing} -o BatchMode=yes` : "ssh -o BatchMode=yes"
  return { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: sshCommand, GIT_EDITOR: "true", GIT_LFS_SKIP_SMUDGE: "1" }
}

function runner(spawnGit, cwd) {
  return (args, timeout = GIT_TIMEOUT_MS) => {
    const result = spawnGit("git", ["-C", cwd, ...args], { windowsHide: true, encoding: "utf8", timeout, env: gitEnv(), maxBuffer: 64 * 1024 * 1024 })
    return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "", stderr: typeof result.stderr === "string" ? result.stderr : "" }
  }
}

const lines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line !== "")

// ---------------------------------------------------------------------------
// Why a Git network step failed, from what Git said.
// ---------------------------------------------------------------------------

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

/** The host's state rather than a Desk defect: these are reported, never filed as Desk problems. */
export const NOT_A_DESK_DEFECT = new Set(["unreachable", "auth_failed", "deadline"])

const BLOCKED_WORDS = {
  auth_failed: "the remote refused this machine's credentials",
  unreachable: "the remote could not be reached",
  deadline: "git timed out",
  conflict: "a conflict Desk could not resolve on its own",
  push_rejected: "the remote kept rejecting the push",
  unpushed_at_session_end: "a session ended before its push finished",
}

/** Plain words for why a push is blocked, from the reason the push worker recorded. */
export function blockedWords(reason, paths = []) {
  const words = BLOCKED_WORDS[reason] ?? `the push failed (${reason ?? "reason unknown"})`
  return paths.length > 0 ? `${words}: ${paths.join(", ")}` : words
}

// ---------------------------------------------------------------------------
// Which local commits the remote does not have yet.
// ---------------------------------------------------------------------------

/**
 * The local commits, oldest first, that the upstream has neither by identity nor by an identical change, and that
 * were not already delivered as a resolved copy (`delivered`, the original commits a replay delivered). Local, never
 * a network call; `null` when there is no upstream to compare with.
 */
export function undeliveredCommits({ root, spawnGit = spawnSync, delivered = [] }) {
  const result = runner(spawnGit, root)(["rev-list", "--reverse", "--no-merges", "--right-only", "--cherry-pick", "@{u}...HEAD"])
  if (result.status !== 0) return null
  const done = new Set(delivered)
  return lines(result.stdout).filter((sha) => !done.has(sha))
}

// ---------------------------------------------------------------------------
// Resolving a conflict on one of Desk's own files.
// ---------------------------------------------------------------------------

const FRONTMATTER = /^---\r?\n((?:[\s\S]*?\r?\n)?)---(?:\r?\n|$)/u
const KEY_LINE = /^([^\s#:][^:]*):/u

// Top-level frontmatter keys and their raw text (continuation lines included), in order; text before the first key is kept under "".
function frontmatterBlocks(text) {
  const blocks = new Map()
  let key = ""
  for (const line of text.split(/(?<=\n)/u)) {
    const match = KEY_LINE.exec(line)
    if (match !== null) key = match[1].trim()
    blocks.set(key, (blocks.get(key) ?? "") + line)
  }
  return blocks
}

// A three-way merge of top-level keys: a key only one side changed takes that side's value; a key both changed takes the newer side's.
function mergeFrontmatter(base, newer, older) {
  const [b, n, o] = [frontmatterBlocks(base), frontmatterBlocks(newer), frontmatterBlocks(older)]
  const merged = new Map(n)
  for (const [key, value] of o) {
    if (b.get(key) !== value && n.get(key) === b.get(key)) merged.set(key, value)
  }
  for (const key of b.keys()) {
    if (!o.has(key) && n.get(key) === b.get(key)) merged.delete(key)
  }
  return [...merged.values()].join("")
}

function updatedAt(frontmatter) {
  const match = /^updated:\s*["']?([^"'\r\n]+)/mu.exec(frontmatter)
  const at = match === null ? Number.NaN : Date.parse(match[1].trim())
  return Number.isNaN(at) ? null : at
}

/**
 * Merges a conflicted Desk text file. `union(base, ours, theirs)` is a line merge that keeps both sides' lines. A file
 * with frontmatter on every side merges its body that way and its frontmatter key by key, the newer side (by its
 * `updated:` field, else by `oursIsNewer`) winning a key both sides changed.
 */
export function mergeDeskText({ base, ours, theirs, oursIsNewer, union }) {
  const split = [base, ours, theirs].map((text) => FRONTMATTER.exec(text))
  if (split.some((match) => match === null)) return union(base, ours, theirs)
  const [b, o, t] = split
  const [oursAt, theirsAt] = [updatedAt(o[1]), updatedAt(t[1])]
  const newerIsOurs = oursAt !== null && theirsAt !== null ? oursAt > theirsAt : oursIsNewer
  const frontmatter = newerIsOurs ? mergeFrontmatter(b[1], o[1], t[1]) : mergeFrontmatter(b[1], t[1], o[1])
  const body = union(base.slice(b[0].length), ours.slice(o[0].length), theirs.slice(t[0].length))
  return `---\n${frontmatter}---\n${body}`
}

// Only Desk's own Markdown and line logs under the desk folder are merged automatically; anything else is a real conflict.
const MERGEABLE = /\.(?:md|jsonl|ndjson|log)$/iu

function stageBlobs(git, file) {
  const stages = {}
  for (const entry of git(["ls-files", "-u", "-z", "--", file]).stdout.split("\0")) {
    const match = /^\d+ ([0-9a-f]+) ([123])\t/u.exec(entry)
    if (match !== null) stages[match[2]] = match[1]
  }
  return stages
}

function resolveConflict({ git, tree, scratch, file, prefix, commit }) {
  if (!file.startsWith(prefix) || !MERGEABLE.test(file)) return false
  const stages = stageBlobs(git, file)
  const read = (sha) => (sha === undefined ? null : git(["cat-file", "blob", sha]).stdout)
  const [base, ours, theirs] = [read(stages[1]) ?? "", read(stages[2]), read(stages[3])]
  // One side deleted or moved the file and the other changed it: keep the changed copy, so no line is lost.
  const kept = ours === null || theirs === null ? (ours ?? theirs) : null
  if ([base, ours, theirs].some((text) => text?.includes("\0"))) return false
  const union = (b, o, t) => {
    mkdirSync(scratch, { recursive: true })
    const [bf, of, tf] = ["base", "ours", "theirs"].map((name) => path.join(scratch, name))
    writeFileSync(bf, b)
    writeFileSync(of, o)
    writeFileSync(tf, t)
    return git(["merge-file", "-p", "--union", of, bf, tf]).stdout
  }
  const oursTime = Number(git(["log", "-1", "--format=%ct", "HEAD", "--", file]).stdout.trim())
  const theirsTime = Number(git(["log", "-1", "--format=%ct", commit]).stdout.trim())
  const merged = kept ?? mergeDeskText({ base, ours, theirs, oursIsNewer: oursTime > theirsTime, union })
  mkdirSync(path.dirname(path.join(tree, file)), { recursive: true })
  writeFileSync(path.join(tree, file), merged)
  return git(["add", "--", file]).status === 0
}

// ---------------------------------------------------------------------------
// Replaying in a private worktree, and pushing.
// ---------------------------------------------------------------------------

function deliveryPaths({ root, env }) {
  const dir = path.join(resolveDeskStateDir({ env }), "sync")
  const key = lastStartRootKey(root)
  return { tree: path.join(dir, `${key}.deliver`), scratch: path.join(dir, `${key}.merge`), hooks: path.join(dir, "no-hooks") }
}

function removeWorktree(git, paths) {
  git(["worktree", "remove", "--force", paths.tree])
  for (const dir of [paths.tree, paths.scratch]) rmSync(dir, { recursive: true, force: true })
  git(["worktree", "prune"])
}

// Replays `commits` onto `onto` in the private worktree: `{ head, replayed, skipped }`, or `{ error }` when the worktree cannot be made.
function replay({ git, spawnGit, paths, onto, commits, prefix }) {
  removeWorktree(git, paths)
  mkdirSync(paths.hooks, { recursive: true })
  const added = git(["-c", `core.hooksPath=${paths.hooks}`, "worktree", "add", "--detach", "--force", paths.tree, onto], CHECKOUT_TIMEOUT_MS)
  if (added.status !== 0) return { error: added.stderr }
  const inTree = runner(spawnGit, paths.tree)
  const wt = (args, timeout) => inTree(["-c", `core.hooksPath=${paths.hooks}`, ...args], timeout)
  const replayed = []
  const skipped = []
  for (const commit of commits) {
    if (wt(["cherry-pick", "--allow-empty-message", commit], CHECKOUT_TIMEOUT_MS).status === 0) {
      replayed.push(commit)
      continue
    }
    const conflicted = lines(wt(["diff", "--name-only", "--diff-filter=U"]).stdout)
    const unresolved = conflicted.filter((file) => !resolveConflict({ git: wt, tree: paths.tree, scratch: paths.scratch, file, prefix, commit }))
    // Resolved, or nothing left to commit because the remote already has this change: either way it is delivered.
    if (unresolved.length === 0) {
      const empty = wt(["diff", "--cached", "--quiet"]).status === 0
      if (wt(["cherry-pick", empty ? "--skip" : "--continue"], CHECKOUT_TIMEOUT_MS).status === 0) {
        replayed.push(commit)
        continue
      }
    }
    wt(["cherry-pick", "--abort"])
    skipped.push({ commit, paths: unresolved })
  }
  return { head: wt(["rev-parse", "HEAD"]).stdout.trim(), replayed, skipped }
}

function upstreamOf(git) {
  const branch = git(["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim()
  const remote = git(["config", `branch.${branch}.remote`]).stdout.trim()
  const merge = git(["config", `branch.${branch}.merge`]).stdout.trim()
  const tracking = git(["rev-parse", "--symbolic-full-name", "@{u}"]).stdout.trim()
  return branch === "" || remote === "" || merge === "" || tracking === "" ? null : { branch, remote, merge, tracking }
}

function failure(result, reason) {
  const cause = classifyPullFailure({ stderr: result.stderr, timedOut: result.status === null })
  const error = result.stderr.split("\n").find((line) => line.trim() !== "")?.trim() ?? ""
  return { state: "failed", reason: NOT_A_DESK_DEFECT.has(cause) ? cause : reason, error, delivered: [], skipped: [] }
}

/**
 * Delivers every undelivered local commit to the upstream branch. Never throws. Returns
 * `{ state: "nothing" | "delivered" | "failed", delivered, skipped, checkout, reason?, error? }`: `delivered` lists the
 * local commits now on the remote (as themselves or as a resolved copy), `skipped` the ones with a conflict Desk could not
 * resolve (`{ commit, paths }`), and `checkout` whether the shared checkout now matches the remote (see `catchUp`).
 */
export function deliver({ root, env = process.env, spawnGit = spawnSync, delivered = [] }) {
  const git = runner(spawnGit, root)
  const upstream = upstreamOf(git)
  if (upstream === null) return { state: "failed", reason: "no_upstream", error: "", delivered: [], skipped: [] }
  const paths = deliveryPaths({ root, env })
  const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim()
  const head = git(["rev-parse", "HEAD"]).stdout.trim()
  for (let attempt = 1; ; attempt += 1) {
    const fetched = git(["fetch", "--quiet", "--no-tags", upstream.remote, `+${upstream.merge}:${upstream.tracking}`], NETWORK_TIMEOUT_MS)
    if (fetched.status !== 0) return failure(fetched, "fetch_failed")
    const commits = undeliveredCommits({ root, spawnGit, delivered })
    const onto = git(["rev-parse", upstream.tracking]).stdout.trim()
    if (commits.length === 0) return { state: "nothing", delivered: [], skipped: [], checkout: catchUp({ git, upstream, head, target: onto }) }
    const fastForward = git(["merge-base", "--is-ancestor", onto, head]).status === 0
    const built = fastForward ? { head, replayed: commits, skipped: [] } : replay({ git, spawnGit, paths, onto, commits, prefix })
    if (built.error !== undefined) return { state: "failed", reason: "replay_failed", error: built.error.trim(), delivered: [], skipped: [] }
    const pushed = built.head === onto ? { status: 0 } : git(["push", "--quiet", upstream.remote, `${built.head}:${upstream.merge}`], NETWORK_TIMEOUT_MS)
    if (!fastForward) removeWorktree(git, paths)
    if (pushed.status === 0) {
      git(["update-ref", upstream.tracking, built.head])
      const checkout = built.skipped.length === 0 ? catchUp({ git, upstream, head, target: built.head }) : { state: "behind", reason: "skipped_commits" }
      return { state: "delivered", delivered: built.replayed, skipped: built.skipped, checkout }
    }
    // Rejected because the remote moved on while this ran: fetch and replay again, a bounded number of times.
    const failed = failure(pushed, "push_rejected")
    if (failed.reason !== "push_rejected" || attempt >= PUSH_ATTEMPTS) return failed
  }
}

// ---------------------------------------------------------------------------
// Moving the shared checkout to what was delivered, without overwriting anyone's work.
// ---------------------------------------------------------------------------

const OVERWRITTEN_LIST = /^(?:error: )?The following untracked working tree files would be overwritten by (?:merge|checkout):\s*$/u
const OVERWRITTEN_ONE = /^(?:error: )?Untracked working tree file '(.+)' would be overwritten by (?:merge|checkout)\.?\s*$/u

/** The untracked files Git named as in the way of a merge or checkout, from its own error text, in either of its two forms. */
export function namedUntrackedPaths(stderr) {
  const found = []
  const text = String(stderr ?? "").split(/\r?\n/u)
  for (let index = 0; index < text.length; index += 1) {
    const one = OVERWRITTEN_ONE.exec(text[index])
    if (one !== null) found.push(one[1])
    if (!OVERWRITTEN_LIST.test(text[index])) continue
    while (index + 1 < text.length && text[index + 1].startsWith("\t")) found.push(text[(index += 1)].slice(1))
  }
  return found
}

// An untracked file in the way whose bytes are exactly the incoming file's is removed: the checkout puts the same bytes back.
function removeIdenticalUntracked(git, target, stderr) {
  const top = git(["rev-parse", "--show-toplevel"]).stdout.trim()
  let removed = 0
  for (const file of namedUntrackedPaths(stderr)) {
    const incoming = git(["rev-parse", "--verify", "--quiet", `${target}:${file}`]).stdout.trim()
    const local = git(["hash-object", "--", path.join(top, file)]).stdout.trim()
    if (incoming === "" || incoming !== local) continue
    unlinkSync(path.join(top, file))
    removed += 1
  }
  return removed
}

/**
 * Moves the shared checkout's branch from `head` to `target` the way `git checkout` would, only while the branch still
 * points at `head`: `{ state: "current" | "caught_up" | "behind", paths?, reason? }`. A path another session changed, or
 * an untracked file in the way, leaves the checkout where it was (`behind`), naming what stopped it.
 */
function catchUp({ git, upstream, head, target }) {
  const now = git(["rev-parse", "HEAD"]).stdout.trim()
  if (now === target) return { state: "current" }
  if (now !== head) return { state: "behind", reason: "moved" }
  git(["update-index", "-q", "--refresh"])
  let moved = git(["read-tree", "-m", "-u", head, target], CHECKOUT_TIMEOUT_MS)
  if (moved.status !== 0 && removeIdenticalUntracked(git, target, moved.stderr) > 0) moved = git(["read-tree", "-m", "-u", head, target], CHECKOUT_TIMEOUT_MS)
  if (moved.status !== 0) {
    const named = [...moved.stderr.matchAll(/^(?:error: )?Entry '(.+)' (?:not uptodate|would be overwritten)/gmu)].map((match) => match[1])
    return { state: "behind", reason: "local_changes", paths: [...new Set([...named, ...namedUntrackedPaths(moved.stderr)])] }
  }
  // Through HEAD, so the move is in HEAD's reflog as well as the branch's; the old value makes it a compare-and-swap.
  if (git(["update-ref", "-m", "desk: catch up with delivered commits", "HEAD", target, head]).status === 0) return { state: "caught_up" }
  // Another commit landed in the moment between: put the files back to match the branch as it now is.
  git(["read-tree", "-m", "-u", target, "HEAD"], CHECKOUT_TIMEOUT_MS)
  return { state: "behind", reason: "moved" }
}

