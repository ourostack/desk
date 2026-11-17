// A save that went out as a publication pull request is not on the desk's main until that PR merges. This module keeps the
// record of those PRs (in the desk's sync status, so every session on the desk and `drains status` read the same one), says
// loudly which of them has been waiting past ten minutes, and settles them: a PR whose changes are already on main is closed
// as superseded with the evidence, a PR that conflicts with main is rebuilt on the newest main and published again (append-only
// logs and cards merge), a conflict in the content itself stays open and is named with its files, and every open desk/publish/*
// PR of the repository that conflicts is found and settled even when this machine never recorded it.

import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

import { deliveryPaths, removeWorktree, replay, runner, upstreamOf } from "./deliver.js"
import { resolveDeskStateDir } from "./last-start.js"
import { publicationPolicy, publishPullRequest, repository } from "./pr-publication.js"
import { readSyncStatus, updateSyncStatus } from "./sync-worker.js"

const STUCK_AFTER_MS = 10 * 60 * 1000
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const KEY = "unmerged_saves"
const NETWORK_TIMEOUT_MS = 60_000

const entries = (record) => (Array.isArray(record?.[KEY]) ? record[KEY].filter((save) => typeof save?.url === "string" && typeof save.since === "string") : [])

/** The registry callers hand to `publishPullRequest` for the desk at `root`. */
export function savesFor({ root, env, now }) {
  return { record: (receipt) => recordUnmerged({ root, env, receipt, at: now() }), clear: (receipt) => clearUnmerged({ root, env, url: receipt.url }) }
}

/** Notes a publication PR as waiting to merge; the first time it was noted stays its start. Never throws. */
function recordUnmerged({ root, env, receipt, at }) {
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
function clearUnmerged({ root, env, url }) {
  try {
    updateSyncStatus(root, env, (current) => ({ [KEY]: entries(current).filter((save) => save.url !== url) }))
  } catch {
    // See recordUnmerged.
  }
}

const stuckOf = (list, at) => list.map((save) => ({ ...save, minutes: Math.floor((at - Date.parse(save.since)) / 60_000) })).filter((save) => save.minutes * 60_000 >= STUCK_AFTER_MS)

/** The desk's saves still unmerged after ten minutes, oldest first, each `{ url, head, branch, base, since, minutes }`. Local read. */
export function stuckSaves({ root, env, now }) {
  return stuckOf(entries(readSyncStatus({ root, env })), now()).sort((a, b) => Date.parse(a.since) - Date.parse(b.since))
}

/** The stuck saves of every desk on this machine, for `drains status`. Never throws. */
export function allStuckSaves({ env, now }) {
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

/** Notes the files a save's pull request conflicts on with main, which Desk could not merge by itself. Never throws. */
function markConflict({ root, env, url, files }) {
  try {
    updateSyncStatus(root, env, (current) => ({ [KEY]: entries(current).map((save) => (save.url === url ? { ...save, conflict: { files } } : save)) }))
  } catch {
    // See recordUnmerged.
  }
}

const conflictFiles = (save) => (Array.isArray(save.conflict?.files) ? save.conflict.files.filter((file) => typeof file === "string") : [])

/** One plain sentence per stuck save, naming its PR link, and the files that conflict when Desk could not merge them. */
export const stuckLine = (save) => conflictFiles(save).length > 0
  ? `Desk save not on main after ${save.minutes} min: ${save.url} conflicts with main in ${conflictFiles(save).join(", ")}, which Desk cannot merge by itself; open the pull request, resolve ${conflictFiles(save).length === 1 ? "that file" : "those files"} and merge it`
  : `Desk save not on main after ${save.minutes} min: ${save.url} (the pull request is still open; Desk rebases it and the merge-when-green relay merges it once its checks are green)`

/** `reply` with the stuck saves named, when there are any. A reply that is not an object, or a call with no desk, is returned as it is. */
export function withStuckSaves(reply, { root, env, now }) {
  if (typeof root !== "string" || reply === null || typeof reply !== "object" || Array.isArray(reply)) return reply
  const stuck = stuckSaves({ root, env, now })
  if (stuck.length === 0) return reply
  return {
    ...reply,
    desk_unmerged_saves: stuck.map((save) => ({ pr: save.url, minutes: save.minutes, ...(conflictFiles(save).length > 0 ? { conflicts: conflictFiles(save) } : {}) })),
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
function supersession(git, head, main, link) {
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
    if (onMain.stdout === onHead.stdout) { evidence.push(`${file} is identical on main (${link(file)})`); continue }
    const had = new Set(git(["cat-file", "blob", `${parent}:${file}`]).stdout.split("\n"))
    const added = onHead.stdout.split("\n").filter((line) => line.trim() !== "" && !had.has(line))
    const mainLines = onMain.stdout.split("\n")
    const missing = added.filter((line) => !mainLines.includes(line))
    if (missing.length === 0) { evidence.push(`every line the save adds to ${file} is already on main (${link(file)})`); continue }
    const newer = Number(git(["log", "-1", "--format=%ct", main, "--", file]).stdout.trim()) > headTime
    const replaced = missing.every((line) => {
      const key = FRONTMATTER_KEY.exec(line)?.[1]
      return key !== undefined && mainLines.some((other) => FRONTMATTER_KEY.exec(other)?.[1] === key)
    })
    if (newer && replaced) { evidence.push(`${file}: the fields the save sets were set again by newer commits on main (${link(file)})`); continue }
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
export function closeSaved({ spawnGit, root, env, url, comment }) {
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

// Open desk/publish/* pull requests against `base` that GitHub reports as conflicting and this desk never recorded (another
// machine's save, or a record lost): recorded from the time they were opened, so they are as loud as any other waiting save.
function adoptConflicting({ git, spawnGit, root, env, repo, base, known }) {
  const listed = ghRun(spawnGit, root, ["pr", "list", "--repo", repo.full, "--state", "open", "--base", base, "--limit", "200", "--json", "url,headRefName,headRefOid,baseRefName,mergeable,createdAt"])
  let prs
  try { prs = JSON.parse(listed.stdout) } catch { return }
  if (listed.status !== 0 || !Array.isArray(prs)) return
  for (const pr of prs) {
    if (typeof pr?.url !== "string" || typeof pr.headRefName !== "string" || !pr.headRefName.startsWith("desk/publish/") || pr.baseRefName !== base) continue
    if (pr.mergeable !== "CONFLICTING" || known.has(pr.url) || !OBJECT_ID.test(String(pr.headRefOid)) || Number.isNaN(Date.parse(pr.createdAt))) continue
    updateSyncStatus(root, env, (current) => ({ [KEY]: [...entries(current), { url: pr.url, head: pr.headRefOid, branch: pr.headRefName, base, since: pr.createdAt }] }))
  }
}

function settle({ root, env, spawnGit, clock }) {
  const outcome = { closed: [], rebased: [], waiting: [] }
  const git = runner(spawnGit, root)
  const upstream = upstreamOf(git)
  let list = entries(readSyncStatus({ root, env }))
  let repo = null
  if (upstream !== null) {
    let remote = git(["remote", "get-url", upstream.remote])
    if (remote.status !== 0 || remote.stdout.trim() === "") remote = git(["ls-remote", "--get-url", upstream.remote])
    try { repo = repository(remote.stdout.trim()) } catch { repo = null }
  }
  if (repo !== null) {
    try {
      adoptConflicting({ git, spawnGit, root, env, repo, base: upstream.merge.replace(/^refs\/heads\//u, ""), known: new Set(list.map((save) => save.url)) })
      list = entries(readSyncStatus({ root, env }))
    } catch {
      // Finding strays is best effort; the recorded saves are still settled.
    }
  }
  if (list.length === 0) return outcome
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
    const evidence = supersession(git, save.head, main, (file) => `https://${repo?.full ?? ""}/blob/${main}/${file.split("/").map(encodeURIComponent).join("/")}`)
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
  if (built.skipped.length > 0) markConflict({ root, env, url: save.url, files: [...new Set(built.skipped.flatMap((skip) => skip.paths))] })
  if (built.error !== undefined || built.skipped.length > 0 || !OBJECT_ID.test(built.head) || built.head === main) return "waiting"
  let receipt
  try {
    receipt = publishPullRequest({ git, spawnGit, root, upstream, head: built.head, onto: main, policy, clock, track: savesFor({ root, env, now: Date.now }) }).receipt
  } catch (error) {
    receipt = error.publication
  }
  if (receipt === undefined) return "waiting"
  return closeSaved({ spawnGit, root, env, url: save.url, comment: `Rebased onto ${short(main)} as ${receipt.url} because it conflicted with main; this pull request is closed in its favour.` }) ? "rebased" : "waiting"
}
