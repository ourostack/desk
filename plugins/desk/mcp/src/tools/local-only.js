// Which recorded repos are local-only: a clone with no remote at all, so a commit in it is the delivered work.
//
// Round 9 let a commit in such a clone count as `done` evidence, and the review showed how an agent could manufacture
// that state: remove the remote, point at a commit older than the task, `git init` a repo inside the done call, name an
// unreachable commit, or point at a folder inside the desk. The rule that closes them is that Desk itself records
// `local_only: true` on a card's repo entry, once, when `task_create` or boot first sees the clone with no remote and
// the entry has no `url`; the done check then trusts only that record (see `done-evidence.js`), and `task_update` refuses
// to set or change it. This module holds the one test of "a clone Desk may record as local-only" and the recording.
//
// What stays possible, by design: an agent can still make a new commit in a repo that really is local-only. That commit
// is real work in the recorded repo, so accepting it is correct.

import { realpathSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { isGitRepository, hasUnstagedWork, stagePaths, commitPaths, commitBranchRefusal } from "../util/git-stage.js"
import { deskRelativePath, resolveLocalPath, isPathContained } from "../util/paths.js"

const GIT_TIMEOUT_MS = 5000

function git(spawnGit, dir, args) {
  const result = spawnGit("git", ["-C", dir, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })
  return result?.status === 0 && typeof result.stdout === "string" ? result.stdout : null
}

function real(target) {
  try {
    return realpathSync(target)
  } catch {
    return null
  }
}

/** Whether `a` is `b` or inside it, by real path. An unreadable path counts as related, the safe side. */
function nested(a, b) {
  const first = real(a)
  const second = real(b)
  return first === null || second === null || isPathContained(second, first)
}

/**
 * Whether the clone at `dir` is a repository with no remote at all that has nothing to do with the desk: its folder and
 * its repository's top level are neither inside the desk nor containing it (a desk subfolder, or a folder that holds the
 * desk, is the desk's own history, never a separate repo with nowhere to push).
 */
export function isLocalOnlyClone(dir, { spawnGit = spawnSync, deskRoot }) {
  const top = git(spawnGit, dir, ["rev-parse", "--show-toplevel"])?.trim()
  if (top === undefined || top === "") return false
  if (git(spawnGit, dir, ["remote"])?.trim() !== "") return false
  for (const folder of [dir, top]) {
    if (nested(folder, deskRoot) || nested(deskRoot, folder)) return false
  }
  return true
}

const hasUrl = (entry) => typeof entry.url === "string" && entry.url.trim() !== ""

// An object entry with a `local_path`, no `url` and a clone that is a local-only repository.
function qualifies(entry, { spawnGit, homeDir, deskRoot }) {
  return (
    entry !== null && typeof entry === "object" && typeof entry.local_path === "string" && entry.local_path.trim() !== "" && !hasUrl(entry) &&
    isLocalOnlyClone(resolveLocalPath(entry.local_path.trim(), { homeDir, deskRoot }), { spawnGit, deskRoot })
  )
}

/**
 * `task_create`'s side of the record: `repos` with `local_only: true` on exactly the entries that qualify now. Any
 * `local_only` the caller wrote is dropped first, so it cannot be claimed.
 */
export function withLocalOnlyRecorded(repos, { spawnGit = spawnSync, homeDir = os.homedir(), deskRoot }) {
  if (!Array.isArray(repos)) return repos
  return repos.map((entry) => {
    if (entry === null || typeof entry !== "object") return entry
    const { local_only: _claimed, ...rest } = entry
    return qualifies(rest, { spawnGit, homeDir, deskRoot }) ? { ...rest, local_only: true } : rest
  })
}

/**
 * Boot's side of the record: for each open card, add `local_only: true` to any repo entry whose clone it now sees with no
 * remote. Boot only ever adds the mark (the done check re-reads the clone's remotes itself). Returns the cards it
 * changed as `track/slug`. Never throws.
 */
export async function recordLocalOnlyOnCards({ cards, deskRoot, spawnGit = spawnSync, homeDir = os.homedir(), stateBranch = null }) {
  const recorded = []
  for (const card of cards) {
    if (["done", "cancelled"].includes(card.data?.status) || !Array.isArray(card.data?.repos)) continue
    try {
      let changed = false
      const entries = card.data.repos.map((entry) => {
        if (entry?.local_only === true || !qualifies(entry, { spawnGit, homeDir, deskRoot })) return entry
        changed = true
        return { ...entry, local_only: true }
      })
      if (!changed) continue
      // The same read-merge-write the card tools use: `updated` is left as it was, since the work itself did not change.
      // Loaded here, not at the top: boot must run from a plugin folder with no installed dependencies, and the card
      // reader needs them (a boot without them simply leaves the card unrecorded).
      const { readMarkdown, writeMarkdown } = await import("../util/fm.js")
      // On a git desk the write is committed the way every other card write is (`commitPaths`), so boot never leaves a modified card behind for a
      // hand commit; a card another session has edited and not staged is left unrecorded rather than adopted.
      const git = isGitRepository(deskRoot, spawnGit)
      const rel = deskRelativePath(deskRoot, card.file)
      if (git && hasUnstagedWork(deskRoot, [rel], spawnGit)) continue
      // Off the desk's branch, Desk writes nothing: the card stays unrecorded.
      if (git && commitBranchRefusal(deskRoot, spawnGit, stateBranch) !== null) continue
      const parsed = await readMarkdown(card.file)
      await writeMarkdown(card.file, { ...parsed.data, repos: entries }, parsed.content)
      if (git && stagePaths(deskRoot, [rel], spawnGit, stateBranch).ok) commitPaths(deskRoot, [rel], `boot: record local-only clone on ${card.track}/${card.slug}`, spawnGit, stateBranch)
      recorded.push(`${card.track}/${card.slug}`)
    } catch {
      // Recording is a convenience; a card that cannot be patched simply stays unrecorded.
    }
  }
  return recorded
}

/** The path form two entries share when they are the same recorded clone. */
export const repoKey = (entry) => `${String(entry?.name ?? "").trim()}\u0000${String(entry?.local_path ?? "").trim()}`

/**
 * Throws when `repos` (a task_update's new list) sets or changes `local_only` against `prior` (the card's list before the
 * call): an entry may carry `local_only: true` only if a prior entry for the same clone (same name and `local_path`)
 * carried it, and only Desk writes it.
 */
export function assertLocalOnlyUnchanged(repos, prior) {
  if (!Array.isArray(repos)) return
  const recorded = new Set((Array.isArray(prior) ? prior : []).filter((entry) => entry !== null && typeof entry === "object" && entry.local_only === true).map(repoKey))
  for (const entry of repos) {
    if (entry === null || typeof entry !== "object" || entry.local_only === undefined) continue
    if (entry.local_only !== true || !recorded.has(repoKey(entry))) {
      throw new Error(
        "task_update: `local_only` on a repos entry is written by Desk itself (when `task_create` or boot first sees the clone with no remote and the entry has no `url`), " +
          "so a call cannot set or change it. Leave it out of the entry, or copy it unchanged from the card's current entry.",
      )
    }
  }
}

