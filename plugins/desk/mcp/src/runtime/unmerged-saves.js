// A save that went out as a publication pull request is not on the desk's main until that PR merges. This module keeps the
// record of those PRs (in the desk's sync status, so every session on the desk and `drains status` read the same one), says
// loudly which of them has been waiting past ten minutes, and settles them: a PR whose changes are already on main is closed
// as superseded with the evidence, a PR that conflicts with main is rebuilt on the newest main and published again, and
// anything else stays open and named.

import { spawnSync } from "node:child_process"
import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { deliveryPaths, removeWorktree, replay, runner, upstreamOf } from "./deliver.js"
import { resolveDeskStateDir } from "./last-start.js"
import { publicationPolicy, publishPullRequest } from "./pr-publication.js"
import { readSyncStatus, updateSyncStatus } from "./sync-worker.js"

const STUCK_AFTER_MS = 10 * 60 * 1000
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const KEY = "unmerged_saves"
const NETWORK_TIMEOUT_MS = 60_000

const entries = (record) => (Array.isArray(record?.[KEY]) ? record[KEY].filter((save) => typeof save?.url === "string" && typeof save.since === "string") : [])

/** The registry callers hand to `publishPullRequest` for the desk at `root`. */
export function savesFor({ root, env = process.env, now = Date.now }) {
  return { record: (receipt) => recordUnmerged({ root, env, receipt, at: now() }), clear: (receipt) => clearUnmerged({ root, env, url: receipt.url }) }
}

/** Notes a publication PR as waiting to merge; the first time it was noted stays its start. Never throws. */
function recordUnmerged({ root, env = process.env, receipt, at = Date.now() }) {
  try {
    updateSyncStatus(root, env, (current) => {
      const list = entries(current)
      if (list.some((save) => save.url === receipt.url)) return {}
      return { [KEY]: [...list, { url: receipt.url, head: receipt.head, branch: receipt.branch, base: receipt.base, since: new Date(at).toISOString() }] }
    })
  } catch {
    // The record only makes a waiting save louder; losing it never fails the save.
  }
}

/** Forgets a PR that merged or was closed. Never throws. */
function clearUnmerged({ root, env = process.env, url }) {
  try {
    updateSyncStatus(root, env, (current) => ({ [KEY]: entries(current).filter((save) => save.url !== url) }))
  } catch {
    // See recordUnmerged.
  }
}

const stuckOf = (list, at) => list.map((save) => ({ ...save, minutes: Math.floor((at - Date.parse(save.since)) / 60_000) })).filter((save) => save.minutes * 60_000 >= STUCK_AFTER_MS)

/** The desk's saves still unmerged after ten minutes, oldest first, each `{ url, head, branch, base, since, minutes }`. Local read. */
export function stuckSaves({ root, env = process.env, now = Date.now }) {
  return stuckOf(entries(readSyncStatus({ root, env })), now()).sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
}

/** The stuck saves of every desk on this machine, for `drains status`. Never throws. */
export function allStuckSaves({ env = process.env, now = Date.now }) {
  try {
    const dir = path.join(resolveDeskStateDir({ env }), "sync")
    const found = []
    for (const name of readdirSync(dir).filter((file) => file.endsWith(".status.json"))) {
      let record = null
      try { record = JSON.parse(readFileSync(path.join(dir, name), "utf8")) } catch { continue }
      found.push(...stuckOf(entries(record), now()))
    }
    return found.sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
  } catch {
    return []
  }
}

/** One plain sentence per stuck save, naming its PR link. */
export const stuckLine = (save) => `Desk save not on main after ${save.minutes} min: ${save.url} (the pull request is still open; Desk rebases it and the merge-when-green relay merges it once its checks are green)`

/** `reply` with the stuck saves named, when there are any. A reply that is not an object, or a call with no desk, is returned as it is. */
export function withStuckSaves(reply, { root, env = process.env, now = Date.now }) {
  if (typeof root !== "string" || reply === null || typeof reply !== "object" || Array.isArray(reply)) return reply
  const stuck = stuckSaves({ root, env, now })
  if (stuck.length === 0) return reply
  return {
    ...reply,
    desk_unmerged_saves: stuck.map((save) => ({ pr: save.url, minutes: save.minutes })),
    desk_unmerged_note: `${stuck.map(stuckLine).join("; ")}. Tell the operator this save is not merged yet; do not report it as merged.`,
  }
}

// The lines a save's pull request adds, and the file's text on `commit`, for the supersession check.
const FRONTMATTER_KEY = /^([A-Za-z][\w-]*):(?:\s|$)/u

/**
 * Evidence that everything a pull request commit changes is already on `main`, or null. A file counts when it is the same on
 * main, when every line the commit adds is on main, or when the commit only sets frontmatter fields that a newer commit on
 * main has since set differently.
 */
function supersession(git, head, main) {
  const parent = `${head}^`
  const files = git(["diff-tree", "--root", "-r", "--name-only", "--no-renames", "--no-commit-id", "-z", head]).stdout.split("\0").filter(Boolean)
  const headTime = Number(git(["log", "-1", "--format=%ct", head]).stdout.trim())
  const evidence = []
  for (const file of files) {
    const onMain = git(["cat-file", "blob", `${main}:${file}`])
    const onHead = git(["cat-file", "blob", `${head}:${file}`])
    if (onMain.status !== 0 || onHead.status !== 0) {
      // Deleted by the save: superseded only when main has it gone too.
      if (onMain.status !== 0 && onHead.status !== 0) { evidence.push(`${file} is absent on main, as the save left it`); continue }
      return null
    }
    if (onMain.stdout === onHead.stdout) { evidence.push(`${file} is identical on main`); continue }
    const had = new Set(git(["cat-file", "blob", `${parent}:${file}`]).stdout.split("\n"))
    const added = onHead.stdout.split("\n").filter((line) => line.trim() !== "" && !had.has(line))
    const mainLines = onMain.stdout.split("\n")
    const missing = added.filter((line) => !mainLines.includes(line))
    if (missing.length === 0) { evidence.push(`every line the save adds to ${file} is on main`); continue }
    const newer = Number(git(["log", "-1", "--format=%ct", main, "--", file]).stdout.trim()) > headTime
    const replaced = missing.every((line) => {
      const key = FRONTMATTER_KEY.exec(line)?.[1]
      return key !== undefined && mainLines.some((other) => FRONTMATTER_KEY.exec(other)?.[1] === key)
    })
    if (newer && replaced) { evidence.push(`${file}: the fields the save sets were set again by newer commits on main`); continue }
    return null
  }
  return evidence
}

const short = (sha) => sha.slice(0, 12)

function ghRun(spawnGit, root, args) {
  const result = spawnGit("gh", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: NETWORK_TIMEOUT_MS, env: process.env })
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" }
}

/** Closes a publication PR with the comment saying why, drops its branch and forgets it. Returns whether GitHub closed it. */
export function closeSaved({ spawnGit = spawnSync, root, env = process.env, url, comment }) {
  const closed = ghRun(spawnGit, root, ["pr", "close", url, "--delete-branch", "--comment", comment]).status === 0
  if (closed) clearUnmerged({ root, env, url })
  return closed
}

const supersededComment = (main, evidence) => `Superseded: this save is already on main (${short(main)}), so this pull request is closed without merging. Evidence: ${evidence.join("; ")}.`

/** Why a publication PR that a rebuild replaced is closed: superseded when its content is on main without it, else rebuilt as `publication`. */
export const abandonedComment = ({ target, branch, publication }) => publication === undefined
  ? supersededComment(target, [`rebuilding the save on the newest ${branch} landed it directly or left nothing to add`])
  : `Rebuilt on the newest ${branch} as ${publication.url} because ${branch} moved or this pull request conflicted; this pull request is closed in its favour.`

/**
 * Settles every recorded save of the desk at `root` against the newest main (a network step; call it where a fetch is
 * expected). Returns `{ closed, rebased, waiting }` (PR urls); never throws.
 */
export function settleSaves(options) {
  try {
    return settle(options)
  } catch {
    // A settle that fails leaves the saves recorded, and named.
    return { closed: [], rebased: [], waiting: [] }
  }
}

function settle({ root, env = process.env, spawnGit = spawnSync, clock }) {
  const outcome = { closed: [], rebased: [], waiting: [] }
  const list = entries(readSyncStatus({ root, env }))
  if (list.length === 0) return outcome
  const git = runner(spawnGit, root)
  const upstream = upstreamOf(git)
  if (upstream === null || git(["fetch", "--quiet", "--no-tags", upstream.remote, `+${upstream.merge}:${upstream.tracking}`], NETWORK_TIMEOUT_MS).status !== 0) {
    outcome.waiting.push(...list.map((save) => save.url))
    return outcome
  }
  const main = git(["rev-parse", upstream.tracking]).stdout.trim()
  for (const save of list) {
    const viewed = ghRun(spawnGit, root, ["pr", "view", save.url, "--json", "state,mergeable"])
    let view
    try { view = JSON.parse(viewed.stdout) } catch { view = null }
    if (viewed.status !== 0 || view === null) { outcome.waiting.push(save.url); continue }
    if (view.state !== "OPEN") { clearUnmerged({ root, env, url: save.url }); continue }
    if (git(["cat-file", "-e", `${save.head}^{commit}`]).status !== 0) git(["fetch", "--quiet", "--no-tags", upstream.remote, `refs/heads/${save.branch}`], NETWORK_TIMEOUT_MS)
    if (git(["merge-base", "--is-ancestor", save.head, main]).status === 0) { clearUnmerged({ root, env, url: save.url }); continue }
    const evidence = supersession(git, save.head, main)
    if (evidence !== null) {
      if (closeSaved({ spawnGit, root, env, url: save.url, comment: supersededComment(main, evidence) })) outcome.closed.push(save.url)
      else outcome.waiting.push(save.url)
      continue
    }
    if (view.mergeable !== "CONFLICTING") { outcome.waiting.push(save.url); continue }
    const rebased = rebaseSave({ git, spawnGit, root, env, upstream, save, main, clock })
    if (rebased === "rebased") outcome.rebased.push(save.url)
    else outcome.waiting.push(save.url)
  }
  return outcome
}

// Builds the save on the newest main (Desk's card and log conflict rules apply) and publishes it again; the old PR is closed
// once the new one exists.
function rebaseSave({ git, spawnGit, root, env, upstream, save, main, clock }) {
  let policy
  try { policy = publicationPolicy(git, main) } catch { return "waiting" }
  if (policy === null) return "waiting"
  const paths = deliveryPaths({ root, env })
  const prefix = git(["rev-parse", "--show-prefix"]).stdout.trim()
  const built = replay({ git, spawnGit, paths, onto: main, commits: [save.head], prefix })
  removeWorktree(git, paths)
  if (built.error !== undefined || built.skipped.length > 0 || !OBJECT_ID.test(built.head) || built.head === main) return "waiting"
  let receipt
  try {
    receipt = publishPullRequest({ git, spawnGit, root, upstream, head: built.head, onto: main, policy, clock, track: savesFor({ root, env }) }).receipt
  } catch (error) {
    receipt = error.publication
  }
  if (receipt === undefined) return "waiting"
  return closeSaved({ spawnGit, root, env, url: save.url, comment: `Rebased onto ${short(main)} as ${receipt.url} because it conflicted with main; this pull request is closed in its favour.` }) ? "rebased" : "waiting"
}
