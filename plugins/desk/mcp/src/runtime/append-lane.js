// Write-behind for the cheap append path: a task's `log.md` entry is written to the file at once, so every reader sees it,
// and its commit waits for a quiet moment so rapid appends become one commit and one push instead of one each.
//
// A lane holds the files written and not yet committed, per desk root. The commit runs `quietMs` after the last append, and
// never more than `maxWaitMs` after the first, and again at process exit. A commit the desk cannot make yet (a base it must
// not build on, a Git failure) leaves the files written and waiting; the next append, or the next flush, tries again. A
// process killed outright leaves the written file in the checkout, where the next append to it finds it and commits it.
//
// `spawnGit` and `schedulePush` are test seams; real callers pass the defaults.

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { assertPublishedContentBase } from "../desk/content-home.js"
import { commitPaths, hasUnstagedWork, stagePaths, stagedChanges } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "./sync-worker.js"

const APPEND_QUIET_MS = 5000
const APPEND_MAX_WAIT_MS = 30_000

const lanes = new Map()
let exitHook = false

const posix = (rel) => rel.split(path.sep).join("/")
const digest = (file) => {
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex")
  } catch {
    return null
  }
}

function laneFor(root) {
  let lane = lanes.get(root)
  if (lane === undefined) {
    lane = { root, pending: new Map(), timer: null, firstAt: 0, admission: null, label: null, spawnGit: spawnSync, schedulePush: schedulePushDefault, quietMs: APPEND_QUIET_MS, maxWaitMs: APPEND_MAX_WAIT_MS }
    lanes.set(root, lane)
  }
  return lane
}

/** The digest of what this process wrote to `rel` and has not committed, or null when nothing of it waits here. */
export function pendingDigest(root, rel) {
  return lanes.get(root)?.pending.get(posix(rel)) ?? null
}

/** How many files wait for a commit under `root`. */
export function pendingCount(root) {
  return lanes.get(root)?.pending.size ?? 0
}

function commitMessage(lane) {
  const names = [...lane.pending.keys()]
  return names.length === 1 ? `task_update: log ${path.posix.dirname(names[0]).split("/").slice(-2).join("/")}` : `task_update: log ${names.length} cards`
}

/** Commits what the lane holds in one commit and schedules one push. Returns "committed", "empty" or the reason it waits. Never throws. */
export function flushAppends(root) {
  const lane = lanes.get(root)
  if (lane === undefined) return "empty"
  if (lane.timer !== null) {
    clearTimeout(lane.timer)
    lane.timer = null
  }
  try {
    const rels = [...lane.pending.keys()].filter((rel) => digest(path.join(root, rel)) !== null)
    for (const rel of [...lane.pending.keys()]) if (!rels.includes(rel)) lane.pending.delete(rel)
    if (rels.length === 0) return "empty"
    assertPublishedContentBase(root, lane.admission, "task_update")
    if (!stagePaths(root, rels, lane.spawnGit).ok) return arm(lane, "stage_failed")
    const committed = commitPaths(root, rels, commitMessage(lane), lane.spawnGit)
    // A commit reported as failed or unknown may have landed (a timeout on a slow machine): when nothing at these paths is left to commit, it did, and it is not made twice.
    if (!committed.ok && (hasUnstagedWork(root, rels, lane.spawnGit) || stagedChanges(root, rels, lane.spawnGit)?.length !== 0)) return arm(lane, "commit_failed")
    lane.pending.clear()
    lane.firstAt = 0
    lane.schedulePush({ root })
    return "committed"
  } catch {
    return arm(lane, "waiting")
  }
}

// A commit that could not be made yet is tried again later, unhurried, while the process lives.
function arm(lane, reason) {
  if (lane.pending.size > 0 && lane.timer === null) {
    lane.timer = setTimeout(() => flushAppends(lane.root), lane.maxWaitMs)
    lane.timer.unref?.()
  }
  return reason
}

/**
 * Registers `rels` (relative to `root`, already written) for the lane's next commit and arms its timer. Returns how many
 * files now wait. `admission` is the content receipt the append was admitted under; the commit re-checks its base.
 */
export function queueAppend({ root, rels, admission = null, spawnGit = spawnSync, schedulePush = schedulePushDefault, quietMs = APPEND_QUIET_MS, maxWaitMs = APPEND_MAX_WAIT_MS }) {
  const lane = laneFor(root)
  Object.assign(lane, { spawnGit, schedulePush, quietMs, maxWaitMs, admission })
  for (const rel of rels) lane.pending.set(posix(rel), digest(path.join(root, rel)))
  const now = Date.now()
  if (lane.firstAt === 0) lane.firstAt = now
  if (lane.timer !== null) clearTimeout(lane.timer)
  const wait = Math.max(0, Math.min(quietMs, lane.firstAt + maxWaitMs - now))
  lane.timer = setTimeout(() => flushAppends(root), wait)
  lane.timer.unref?.()
  if (!exitHook) {
    exitHook = true
    process.once("exit", () => {
      for (const key of lanes.keys()) flushAppends(key)
    })
  }
  return lane.pending.size
}

/** Commits every lane now. For the end of a session, a test or a measurement. */
export async function drainAppendLanes() {
  for (const key of [...lanes.keys()]) flushAppends(key)
}
