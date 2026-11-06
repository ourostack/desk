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
// 4. Report whether the shared branch already matches the delivered tip. Otherwise leave its branch, index and files untouched; automatic source application needs custody this worker does not have.
//
// Never `--force`, never a stash, never a rebase in the shared checkout. Every Git call runs with
// `GIT_TERMINAL_PROMPT=0` and a timeout. `spawnGit` (over `spawnSync`) is a test seam.

import { spawnSync } from "node:child_process"
import { accessSync, constants, mkdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import { fileURLToPath } from "node:url"
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
const PUSH_TRANSPORT_ERROR = /RPC failed|unexpected disconnect|remote end hung up|early EOF|broken pipe|empty reply|transfer closed|connection reset|recv failure|send failure|protocol error|timed out|HTTP 50[0-9]/iu
const PUSH_CONNECT_REFUSAL = /Could not resolve (?:host|hostname)|Failed to connect|ssh: connect to host .*: Connection refused/iu

export function classifyPullFailure({ stderr = "", conflicted = [], timedOut = false, deadline = false } = {}) {
  if (deadline || timedOut) return "deadline"
  if (conflicted.length > 0 || CONFLICT_TEXT.test(stderr)) return "conflict"
  if (AUTH_TEXT.test(stderr)) return "auth_failed"
  if (UNREACHABLE_TEXT.test(stderr)) return "unreachable"
  if (DIVERGED_TEXT.test(stderr)) return "diverged"
  return "other"
}

/** The host's state rather than a Desk defect: these are reported, never filed as Desk problems. */
export const UNVERIFIED_DELIVERY_REASONS = new Set([
  "delivery_context_changed", "delivery_route_unverified", "unsupported_delivery_route",
  "delivery_ledger_unverified", "push_outcome_unverified", "source_history_changed", "delivery_evidence_capacity",
  "delivery_unverified",
])
export const NOT_A_DESK_DEFECT = new Set(["unreachable", "auth_failed", "deadline", ...UNVERIFIED_DELIVERY_REASONS])

const BLOCKED_WORDS = {
  auth_failed: "the remote refused this machine's credentials",
  unreachable: "the remote could not be reached",
  deadline: "git timed out",
  conflict: "a conflict Desk could not resolve on its own",
  push_rejected: "the remote kept rejecting the push",
  unpushed_at_session_end: "a session ended before its push finished",
  delivery_context_changed: "the delivery destination or credential context changed",
  delivery_route_unverified: "the configured delivery route could not be verified",
  unsupported_delivery_route: "the configured delivery route is unsupported or ambiguous",
  delivery_ledger_unverified: "the retained delivery record has no matching destination",
  push_outcome_unverified: "the pinned destination could not confirm the push outcome",
  source_history_changed: "the remote history no longer matches retained delivery evidence",
  delivery_evidence_capacity: "retained delivery evidence needs reconciliation before another delivery",
  delivery_unverified: "the delivery evidence could not be verified",
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
export function undeliveredCommits({ root, spawnGit = spawnSync, delivered = [], upstreamTip, localTip }) {
  const result = runner(spawnGit, root)(["rev-list", "--reverse", "--no-merges", "--right-only", "--cherry-pick", `${upstreamTip ?? "@{u}"}...${localTip ?? "HEAD"}`])
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

const fingerprint = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u

function destination(root, value) {
  if (value.includes("::")) return null
  if (path.isAbsolute(value) || !/^[^/]+:/u.test(value)) {
    try { return realpathSync(path.resolve(root, value)) } catch { return null }
  }
  if (!value.includes("://")) return /^[^:\s]+:[^\s]+$/u.test(value) ? value : null
  try {
    const url = new URL(value)
    if (url.password || url.search || url.hash || !["file:", "https:", "http:", "ssh:", "git:"].includes(url.protocol)) return null
    if (url.protocol === "file:") return realpathSync(fileURLToPath(url))
    if (url.username && url.protocol !== "ssh:") return null
    return value
  } catch { return null }
}

function upstreamOf(git, root) {
  const branch = git(["symbolic-ref", "-q", "--short", "HEAD"]).stdout.trim()
  const remote = git(["config", `branch.${branch}.remote`]).stdout.trim()
  const merge = git(["config", "--get-all", `branch.${branch}.merge`]).stdout.trim()
  const tracking = git(["rev-parse", "--symbolic-full-name", "@{u}"]).stdout.trim()
  if (branch === "" || remote === "" || merge === "" || tracking === "") return null
  if (!merge.startsWith("refs/heads/") || git(["check-ref-format", merge]).status !== 0) return { error: "unsupported_delivery_route" }
  const config = git(["config", "--null", "--list"])
  const fetch = git(["remote", "get-url", "--all", remote])
  const push = git(["remote", "get-url", "--push", "--all", remote])
  if (config.status !== 0 || fetch.status !== 0 || push.status !== 0) return { error: "delivery_route_unverified" }
  const fetchUrls = lines(fetch.stdout), pushUrls = lines(push.stdout)
  if ([fetch.stdout, push.stdout].some((value) => value.replace(/\r?\n$/u, "").split(/\r?\n/u).some((line) => line !== line.trim()))) {
    return { error: "unsupported_delivery_route" }
  }
  if (fetchUrls.length !== 1 || pushUrls.length !== 1) return { error: "unsupported_delivery_route" }
  const entries = config.stdout.split("\0").filter(Boolean).map((entry) => {
    const split = entry.indexOf("\n")
    return [entry.slice(0, split), entry.slice(split + 1)]
  })
  if (entries.some(([key, value]) => /^hook\..*\.event$/iu.test(key) && value === "pre-push")) {
    return { error: "unsupported_delivery_route", detail: "Configured pre-push hook policy is not qualified for captured-URL delivery." }
  }
  const hook = git(["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"])
  if (hook.status !== 0 || !hook.stdout.trim()) return { error: "delivery_route_unverified" }
  let hookFile
  try {
    hookFile = statSync(hook.stdout.trim())
  } catch (error) {
    if (!["ENOENT", "ENOTDIR"].includes(error.code)) return { error: "delivery_route_unverified" }
  }
  if (hookFile !== undefined) {
    let executable = false
    try { accessSync(hook.stdout.trim(), constants.X_OK); executable = true } catch (error) {
      if (!["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return { error: "delivery_route_unverified" }
    }
    if (executable) return { error: "unsupported_delivery_route", detail: "An executable pre-push hook requires named-remote policy that captured-URL delivery cannot preserve." }
  }
  if (entries.some(([key]) => (
    /^url\..*\.(?:insteadof|pushinsteadof)$/iu.test(key) ||
    key.toLowerCase().startsWith(`remote.${remote.toLowerCase()}.`) &&
      !["url", "pushurl", "fetch", "push", "tagopt"].includes(key.slice(`remote.${remote}.`.length).toLowerCase())
  ))) return { error: "unsupported_delivery_route" }
  const fetchUrl = destination(root, fetchUrls[0]), pushUrl = destination(root, pushUrls[0])
  if (!fetchUrl || !pushUrl || fetchUrl !== pushUrl) return { error: "unsupported_delivery_route" }
  const environment = Object.entries(process.env).filter(([key]) =>
    /^(?:GIT_|SSH_|GH_|GITHUB_|GCM_|AZURE_|VSS_|SYSTEM_ACCESSTOKEN$|HOME$|XDG_CONFIG_HOME$|PATH$)/iu.test(key)).sort(([a], [b]) => a.localeCompare(b))
  const identity = fingerprint([branch, remote, merge, tracking, fetchUrl, pushUrl, config.stdout, environment])
  return { branch, remote, merge, tracking, fetchUrl, pushUrl, identity }
}

export function isDeliverySnapshot(snapshot) {
  return snapshot !== null && typeof snapshot === "object" && /^[a-f0-9]{64}$/u.test(snapshot.identity ?? "") &&
    OID.test(snapshot.tip ?? "") && /^refs\/heads\/[^\s]+$/u.test(snapshot.ref ?? "")
}

export function deliverySnapshotMatches({ root, spawnGit = spawnSync, snapshot }) {
  if (!isDeliverySnapshot(snapshot)) return false
  const target = upstreamOf(runner(spawnGit, root), root)
  return target !== null && !target.error && target.identity === snapshot.identity && target.merge === snapshot.ref
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
 * resolve (`{ commit, paths }`), and `checkout` whether the shared branch already matches the delivered tip. Source following is otherwise deferred.
 */
export function deliver({ root, env = process.env, spawnGit = spawnSync, delivered = [], snapshot, expectedIdentity }) {
  const git = runner(spawnGit, root)
  const upstream = upstreamOf(git, root)
  if (upstream === null) return { state: "failed", reason: "no_upstream", error: "", delivered: [], skipped: [] }
  if (upstream.error) return { state: "failed", reason: upstream.error, error: upstream.detail ?? "The configured delivery route is unsupported or could not be verified.", delivered: [], skipped: [] }
  if (expectedIdentity !== undefined && expectedIdentity !== upstream.identity) {
    return { state: "failed", reason: "delivery_context_changed", error: "The delivery context changed between worker rounds.", delivered: [], skipped: [], contextChanged: true }
  }
  if (delivered.length > 0 && snapshot?.identity !== upstream.identity) {
    return { state: "failed", reason: "delivery_ledger_unverified", error: "Retained delivery entries have no matching destination identity.", delivered: [], skipped: [] }
  }
  const paths = deliveryPaths({ root, env })
  const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim()
  const head = git(["rev-parse", "HEAD"]).stdout.trim()
  if (!OID.test(head)) return failure({ status: 1, stderr: "The local delivery tip could not be verified." }, "delivery_unverified")
  const scope = `refs/desk/delivery/${lastStartRootKey(root)}`
  const sameContext = () => upstreamOf(git, root)?.identity === upstream.identity
  const receipt = (tip) => ({ identity: upstream.identity, tip, ref: upstream.merge })
  const contextChanged = (tip, commits = []) => ({
    state: "failed", reason: "delivery_context_changed", error: "Delivery context changed; the current destination was not confirmed.",
    delivered: [], skipped: [], contextChanged: true, checkout: { state: "behind", reason: "delivery_context_changed" },
    pinnedDelivery: { ...receipt(tip), commits, confirmed: false },
  })
  for (let attempt = 1; ; attempt += 1) {
    if (!sameContext()) return contextChanged(head)
    const fetched = git(["fetch", "--quiet", "--no-tags", upstream.fetchUrl, `+${upstream.merge}:${scope}/upstream`], NETWORK_TIMEOUT_MS)
    if (fetched.status !== 0) return failure(fetched, "fetch_failed")
    if (!sameContext()) return contextChanged(head)
    const onto = git(["rev-parse", `${scope}/upstream`]).stdout.trim()
    if (!OID.test(onto)) return failure({ status: 1, stderr: "The fetched tip could not be verified." }, "fetch_failed")
    if (git(["merge-base", head, onto]).status !== 0 ||
        snapshot && git(["merge-base", "--is-ancestor", snapshot.tip, onto]).status !== 0) {
      return failure({ status: 1, stderr: "The source history changed; retained delivery evidence needs reconciliation." }, "source_history_changed")
    }
    const commits = undeliveredCommits({ root, spawnGit, delivered, upstreamTip: onto, localTip: head })
    if (commits === null) return failure({ status: 1, stderr: "The pending commits could not be inspected." }, "delivery_unverified")
    if (!sameContext()) return contextChanged(head)
    if (commits.length === 0) return { state: "nothing", delivered: [], skipped: [], snapshot: receipt(onto), checkout: sourceState({ git, target: onto }) }
    const fastForward = git(["merge-base", "--is-ancestor", onto, head]).status === 0
    const built = fastForward ? { head, replayed: commits, skipped: [] } : replay({ git, spawnGit, paths, onto, commits, prefix })
    if (built.error !== undefined) return { state: "failed", reason: "replay_failed", error: built.error.trim(), delivered: [], skipped: [] }
    if (!sameContext()) {
      if (!fastForward) removeWorktree(git, paths)
      return contextChanged(built.head, built.replayed)
    }
    const retained = git(["update-ref", `${scope}/candidate`, built.head])
    if (retained.status !== 0) {
      if (!fastForward) removeWorktree(git, paths)
      return failure(retained, "delivery_unverified")
    }
    const unverified = (result) => ({
      ...failure(result, "push_outcome_unverified"), reason: "push_outcome_unverified",
      pinnedDelivery: { ...receipt(built.head), commits: built.replayed, confirmed: false },
    })
    const pushed = built.head === onto ? { status: 0 } : git(["push", "--porcelain", "--quiet", upstream.pushUrl, `${built.head}:${upstream.merge}`], NETWORK_TIMEOUT_MS)
    if (!fastForward) removeWorktree(git, paths)
    if (pushed.status === 0) {
      if (!sameContext()) return contextChanged(built.head, built.replayed)
      const readback = git(["ls-remote", "--refs", upstream.pushUrl, upstream.merge], NETWORK_TIMEOUT_MS)
      const observed = readback.status === 0 ? readback.stdout.trim().split(/\s+/u) : []
      const confirmed = observed.length === 2 && observed[0] === built.head && observed[1] === upstream.merge
      if (!sameContext()) return contextChanged(built.head, built.replayed)
      if (!confirmed) return unverified(readback)
      const checkout = built.skipped.length === 0 ? sourceState({ git, target: built.head }) : { state: "behind", reason: "skipped_commits" }
      return { state: "delivered", delivered: built.replayed, skipped: built.skipped, snapshot: receipt(built.head), checkout }
    }
    const failed = failure(pushed, "push_rejected")
    const transportUnknown = PUSH_TRANSPORT_ERROR.test(pushed.stderr)
    const refStatuses = pushed.stdout.split(/\r?\n/u).filter(line => /^[ =*+!-]\t/u.test(line))
    const allRejected = /(?:^|\n)Done\r?\n?$/u.test(pushed.stdout) &&
      refStatuses.some(line => line.split("\t")[1].endsWith(`:${upstream.merge}`)) &&
      refStatuses.every(line => line.startsWith("!\t"))
    const beforeEffect = !transportUnknown && (failed.reason === "auth_failed" ||
      failed.reason === "unreachable" && PUSH_CONNECT_REFUSAL.test(pushed.stderr))
    if (pushed.status === null || transportUnknown || !allRejected && !beforeEffect) return unverified(pushed)
    // Only confirmed rejection is retried; a transport failure can follow acceptance at any nonzero exit status.
    if (failed.reason !== "push_rejected" || attempt >= PUSH_ATTEMPTS) return failed
  }
}

// ---------------------------------------------------------------------------
// Shared source observation and the overwrite-error parser also used by session sync.
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

/** Observe the current ref; never mutate the shared branch, index or files to follow a private replay. */
function sourceState({ git, target }) {
  const now = git(["rev-parse", "HEAD"]).stdout.trim()
  if (now === target) return { state: "current" }
  return { state: "behind", reason: "source_follow_deferred" }
}
