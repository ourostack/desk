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
import { isGitRepository, hasUnstagedWork, stagePaths, commitPaths } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"

// Every field desk_save reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const DESK_SAVE_FIELDS = ["paths", "message"]

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
 *   }
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
export async function desk_save({ deskRoot, input, person = null, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  const paths = pathsInput(values.paths)
  const { message } = values
  if (!message || typeof message !== "string") {
    throw new Error("desk_save: `message` is required (string)")
  }

  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  for (const relativePath of paths) {
    const absolute = path.resolve(deskRoot, relativePath)
    if (!isPathContained(effectiveRoot, absolute)) {
      throw new Error(`desk_save: \`paths\` includes a path outside the resolved write prefix: ${relativePath}`)
    }
  }

  if (!isGitRepository(deskRoot, spawnGit)) {
    return { status: "nothing_to_commit" }
  }

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
