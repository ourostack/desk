// desk_save — commit files the agent wrote directly (Write/Edit), not through
// a structured Desk tool: a planning doc, a spec, a report.
//
// Every other write tool stages and commits exactly the path(s) it wrote,
// synchronously in the call (M4-6 Part 2). desk_save gives hand-written files
// the same treatment: `git add -- <paths>` then `git commit -- <paths>`, so
// writing the file and calling desk_save is the same amount of effort as
// writing it and stopping, and it's the path that leaves nothing uncommitted.
// Pushing is a later part.
//
// `paths` are given relative to the desk root, exactly as every other tool's
// path-shaped fields are. On a crew desk (`--person <alias>`), each path must
// resolve inside that alias's `desks/<alias>/` write prefix — desk_save never
// commits on another participant's behalf.

import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { personPrefix, isPathContained } from "../util/paths.js"
import { isLiveCardPath } from "../desk/card-commit-guard.js"
import { isGitRepository, hasUnstagedWork, stagedChanges, stagePaths, commitPaths } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"

// Every field desk_save reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const DESK_SAVE_FIELDS = ["paths", "message", "tidy"]

export const TIDY_TRAILER = "Desk-Tidy: true"

function pathsInput(value) {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error("desk_save: `paths` must be a non-empty array of path strings (got a string that is not valid JSON)")
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((p) => typeof p === "string" && p.trim() !== "")
  ) {
    throw new Error("desk_save: `paths` must be a non-empty array of path strings")
  }
  return parsed
}

/**
 * desk_save
 *
 * Input:
 *   {
 *     paths: string[],   // relative to the desk root
 *     message: string,   // the commit message
 *     tidy?: boolean,    // commit the desk tidy (or its undo): see below
 *   }
 *
 * `tidy: true` commits housekeeping that moved task cards. `paths` are the old and new path of every move, plus any file the tidy fixed or recorded
 * (`_meta/organization.json`). Moves and renames are already staged by task_move, track_rename or `git mv`; files that are not task cards and hold
 * unstaged changes are staged here. A task card is never staged here, and it is accepted only as a staged pure rename (`R100`) or deletion, so a
 * card edit cannot ride through. The commit is limited to `paths`, so other staged work stays staged, and the message ends with the
 * `Desk-Tidy: true` trailer (added when missing) so reports count it as housekeeping. The same call commits the undo of a tidy after
 * `git revert --no-commit`.
 *
 * Refuses (throws) any path that resolves outside the resolved --person
 * write prefix — a crew participant can commit only their own paths.
 *
 * Stages and commits exactly `paths` with `message`, `git commit -- <paths>`,
 * never `-a`/`-A`. When none of `paths` holds an unstaged change or an
 * untracked file — a path that was never actually written — desk_save
 * reports `nothing_to_commit` without staging or committing anything, so a
 * caller's typo or stale path never becomes an empty commit. A stage or
 * commit failure for paths that do hold real changes is reported the same
 * way, via `commit: { status: "failed", reason }`, distinguishing "nothing
 * to commit" as a Git-level failure from the benign case above. On a
 * non-Git desk, or when the desk root isn't a Git repository, there is
 * nothing desk_save can do, so it reports `nothing_to_commit` too.
 *
 * Returns: { status: "committed" | "nothing_to_commit", commit? }
 */
function tidyTrailer(message) {
  const trimmed = message.replace(/\s+$/u, "")
  return trimmed.split("\n").at(-1).trim() === TIDY_TRAILER ? trimmed : `${trimmed}\n\n${TIDY_TRAILER}`
}

export async function desk_save({ deskRoot, input, person = null, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  const paths = pathsInput(values.paths)
  const { message } = values
  if (!message || typeof message !== "string") {
    throw new Error("desk_save: `message` is required (string)")
  }

  const tidy = values.tidy === true
  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  for (const relativePath of paths) {
    const absolute = path.resolve(deskRoot, relativePath)
    if (!isPathContained(effectiveRoot, absolute)) {
      throw new Error(`desk_save: \`paths\` includes a path outside the resolved write prefix: ${relativePath}`)
    }
    // Desk's commit path is the one the desk's pre-commit hook trusts, so a card must not be able to ride through it.
    if (!tidy && isLiveCardPath(path.relative(deskRoot, absolute))) {
      throw new Error(`desk_save: remove ${relativePath} from \`paths\` and write the task card with task_update, task_create, task_move or task_archive, which commit it; to commit a tidy that moved cards, pass tidy: true`)
    }
  }

  if (!isGitRepository(deskRoot, spawnGit)) {
    return { status: "nothing_to_commit" }
  }

  if (tidy) return commitTidy({ deskRoot, paths, message, spawnGit, schedulePush })

  // No unstaged change and no untracked file at any of these paths means
  // there is nothing here to commit — most often a path that was never
  // actually written. Checking this before staging means a caller's typo
  // never becomes an empty commit.
  if (!hasUnstagedWork(deskRoot, paths, spawnGit)) {
    return { status: "nothing_to_commit" }
  }

  const staged = stagePaths(deskRoot, paths, spawnGit)
  if (!staged.ok) {
    return { status: "nothing_to_commit", commit: { status: "failed", reason: staged.stderr } }
  }
  const committed = commitPaths(deskRoot, paths, message, spawnGit)
  if (!committed.ok) {
    return { status: "nothing_to_commit", commit: { status: "failed", reason: committed.stderr } }
  }
  schedulePush({ root: deskRoot })
  return { status: "committed" }
}

// The tidy commit. Task cards must already be staged as pure renames or deletions; every other path is staged here when it holds unstaged work.
function commitTidy({ deskRoot, paths, message, spawnGit, schedulePush }) {
  const isCard = (p) => isLiveCardPath(path.relative(deskRoot, path.resolve(deskRoot, p)))
  const others = paths.filter((p) => !isCard(p))
  if (others.length > 0 && hasUnstagedWork(deskRoot, others, spawnGit)) {
    const staged = stagePaths(deskRoot, others, spawnGit)
    if (!staged.ok) return { status: "nothing_to_commit", commit: { status: "failed", reason: staged.stderr } }
  }
  const changes = stagedChanges(deskRoot, paths, spawnGit)
  if (changes === null) return { status: "nothing_to_commit", commit: { status: "failed", reason: "git could not list the staged changes" } }
  if (changes.length === 0) return { status: "nothing_to_commit" }
  for (const change of changes) {
    const pureMove = change.status === "R100" || change.status === "D"
    const card = change.paths.find(isCard)
    if (card !== undefined && !pureMove) {
      throw new Error(`desk_save: unstage ${card} (git restore --staged -- <path>) and change that task card with task_update; a tidy commits a task card only as a move or a delete, not an edit`)
    }
  }
  const committed = commitPaths(deskRoot, paths, tidyTrailer(message), spawnGit)
  if (!committed.ok) return { status: "nothing_to_commit", commit: { status: "failed", reason: committed.stderr } }
  schedulePush({ root: deskRoot })
  return { status: "committed" }
}
