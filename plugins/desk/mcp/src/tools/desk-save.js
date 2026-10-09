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
//
// A client with no filesystem of its own (claude.ai, through hosted Desk) passes `files` instead: each entry's
// content is written to its desk-relative path and committed with `paths`. Every entry is checked before any is
// written, so a refused call writes nothing.

import * as path from "node:path"
import { existsSync, statSync, lstatSync, realpathSync, constants as fsConstants, promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { personPrefix, isPathContained } from "../util/paths.js"
import { isLiveCardPath } from "../desk/card-commit-guard.js"
import { isGitRepository, hasUnstagedWork, stagedChanges, indexEntries, stagePaths, commitPaths, commitIndexPaths } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"

// Every field desk_save reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const DESK_SAVE_FIELDS = ["paths", "files", "message", "tidy"]

const TIDY_TRAILER = "Desk-Tidy: true"

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

const MAX_FILE_BYTES = 1024 * 1024
const FILES_SHAPE = "desk_save: `files` must be a non-empty array of { path, content } objects whose path and content are strings"
// Git reads these in a pathspec as a pattern or as magic, so `git add -- <path>` could stage files the call never wrote.
const PATHSPEC_SPECIAL = /[*?[\\]|^:/u

function filesInput(value) {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`${FILES_SHAPE} (got a string that is not valid JSON)`)
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((entry) => entry !== null && typeof entry === "object" && typeof entry.path === "string" && typeof entry.content === "string")
  ) {
    throw new Error(FILES_SHAPE)
  }
  return parsed
}

// Why `files` may not write to this desk-relative path, or null when it may. Checked on the path as given and again on where it leads through symlinks.
function pathRefusal(relativePath) {
  const parts = relativePath.toLowerCase().split("/").filter((part) => part !== "" && part !== ".")
  if (parts.length === 0) return "it names no file"
  if (parts.includes("..")) return "it climbs out of its folder with `..`"
  if (parts.includes(".git")) return "it is inside a .git folder"
  if (parts[0] === ".state") return "it is inside .state/, which Desk keeps for itself"
  if (parts[0] === ".github" && parts[1] === "workflows") return "it is a GitHub Actions workflow, which the desk's push credentials cannot push"
  if (isLiveCardPath(relativePath)) return "it is a task card; write it with task_update, task_create, task_move or task_archive"
  return null
}

// Where `absolute` really leads, through the real path of its deepest existing folder, and what is there now; or the problem that stops a write to it.
function inspectTarget(absolute) {
  let ancestor = path.dirname(absolute)
  let real
  for (;;) {
    try {
      real = realpathSync.native(ancestor)
      break
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") return { problem: `Desk could not resolve its folder (${error.code})` }
      ancestor = path.dirname(ancestor)
    }
  }
  if (!statSync(real).isDirectory()) return { problem: "part of the path is a file, not a folder" }
  const resolved = path.join(real, path.relative(ancestor, absolute))
  return { resolved, existing: lstatSync(resolved, { throwIfNoEntry: false }) }
}

// Every `files` entry, checked before any is written. Returns each entry's absolute target.
function checkFiles(deskRoot, effectiveRoot, files) {
  const realRoot = realpathSync.native(deskRoot)
  const realPrefix = path.resolve(realRoot, path.relative(path.resolve(deskRoot), effectiveRoot))
  const seen = new Set()
  return files.map(({ path: relativePath, content }) => {
    const refuse = (why) => new Error(`desk_save: \`files\` cannot write ${relativePath}: ${why}`)
    if (relativePath.includes("\0")) throw refuse("the path holds a NUL character")
    if (path.isAbsolute(relativePath)) throw refuse("give the path relative to the desk root")
    if (PATHSPEC_SPECIAL.test(relativePath)) throw refuse("the path holds *, ?, [ or a backslash, or starts with :, which Git would read as a pattern")
    const given = pathRefusal(relativePath)
    if (given !== null) throw refuse(given)
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw refuse("the content is over 1 MiB")
    const absolute = path.resolve(deskRoot, relativePath)
    if (!isPathContained(effectiveRoot, absolute)) throw refuse("it is outside the resolved write prefix")
    if (seen.has(absolute)) throw refuse("it is listed twice")
    seen.add(absolute)
    const { problem, resolved, existing } = inspectTarget(absolute)
    if (problem !== undefined) throw refuse(problem)
    if (!isPathContained(realPrefix, resolved)) throw refuse("it leads outside the desk, or outside the resolved write prefix, through a symbolic link")
    if (existing?.isSymbolicLink()) throw refuse("the file there is a symbolic link")
    if (existing !== undefined && !existing.isFile()) throw refuse("what is there is not a file")
    const leads = pathRefusal(path.relative(realRoot, resolved).split(path.sep).join("/"))
    if (leads !== null) throw refuse(`it leads through a symbolic link to a path where ${leads}`)
    return { absolute, content }
  })
}

// O_NOFOLLOW: a symbolic link put at the target after the check fails the open instead of being written through.
async function writeFiles(checked) {
  for (const { absolute, content } of checked) {
    await fs.mkdir(path.dirname(absolute), { recursive: true })
    const handle = await fs.open(absolute, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644)
    try {
      await handle.writeFile(content, "utf8")
    } finally {
      await handle.close()
    }
  }
}

/**
 * desk_save
 *
 * Input:
 *   {
 *     paths?: string[],  // relative to the desk root
 *     files?: { path: string, content: string }[],  // UTF-8 text to write, then commit; at least one of paths, files
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
 * `files` (refused with `tidy: true`) are written before staging and join `paths` in the commit. Each path must be
 * relative, with no `..`, `.git`, a leading `.state/` or `.github/workflows/` (any case), no live task card, no Git
 * pathspec pattern characters, content of at most 1 MiB, no symbolic link at the target, and must lead, through the
 * real path of its deepest existing folder, inside the desk and the write prefix. Any failure refuses the whole call
 * before a byte is written.
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
  if (values.paths === undefined && values.files === undefined) {
    throw new Error("desk_save: pass `paths` (a non-empty array of path strings), `files`, or both")
  }
  const paths = values.paths === undefined ? [] : pathsInput(values.paths)
  const files = values.files === undefined ? [] : filesInput(values.files)
  const { message } = values
  if (!message || typeof message !== "string") {
    throw new Error("desk_save: `message` is required (string)")
  }

  const tidy = values.tidy === true
  if (tidy && files.length > 0) {
    throw new Error("desk_save: `files` cannot be combined with tidy: true; a tidy commits moves already staged, so pass only `paths`")
  }
  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  for (const relativePath of paths) {
    const absolute = path.resolve(deskRoot, relativePath)
    if (!isPathContained(effectiveRoot, absolute)) {
      throw new Error(`desk_save: \`paths\` includes a path outside the resolved write prefix: ${relativePath}`)
    }
    // Desk's commit path is the one the desk's pre-commit hook trusts, so a card must not be able to ride through it.
    if (!tidy && isLiveCardPath(path.relative(deskRoot, absolute).split(path.sep).join("/"))) {
      throw new Error(`desk_save: remove ${relativePath} from \`paths\` and write the task card with task_update, task_create, task_move or task_archive, which commit it; to commit a tidy that moved cards, pass tidy: true`)
    }
  }
  if (files.length > 0) {
    await writeFiles(checkFiles(deskRoot, effectiveRoot, files))
    paths.push(...files.map((file) => file.path).filter((p) => !paths.includes(p)))
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
// What is committed is what was judged: the index at `paths`, through a temporary index (commitIndexPaths), never the working tree. `_archive/**` is not a live
// card path (isLiveCardPath, like the pre-commit hook), so a card moved into `_archive/` is checked as the move it is and an archived card is never judged as one.
const TIDY_DIRECTORY_OR_GLOB = /[*?[]/u

function commitTidy({ deskRoot, paths, message, spawnGit, schedulePush }) {
  const rels = paths.map((p) => path.relative(deskRoot, path.resolve(deskRoot, p)).split(path.sep).join("/"))
  for (const [i, rel] of rels.entries()) {
    const absolute = path.resolve(deskRoot, rel)
    if (TIDY_DIRECTORY_OR_GLOB.test(rel) || (existsSync(absolute) && statSync(absolute).isDirectory())) {
      throw new Error(`desk_save: replace ${paths[i]} with the file paths of the tidy (the old and new path of each moved task card, and each file you fixed); tidy: true takes files, never a folder or a pattern`)
    }
  }
  const isCard = (p) => isLiveCardPath(p)
  const cards = rels.filter(isCard)
  const others = rels.filter((p) => !isCard(p))
  if (cards.length > 0 && hasUnstagedWork(deskRoot, cards, spawnGit)) {
    throw new Error("desk_save: a task card in `paths` has an unstaged change, is untracked, or git could not check it; run task_update for a card edit, or git restore --staged and git restore the card, and pass only cards that task_move, track_rename or git mv staged as moves")
  }
  if (others.length > 0 && hasUnstagedWork(deskRoot, others, spawnGit)) {
    const staged = stagePaths(deskRoot, others, spawnGit)
    if (!staged.ok) return { status: "nothing_to_commit", commit: { status: "failed", reason: staged.stderr } }
  }
  const listed = new Set(rels)
  const everything = stagedChanges(deskRoot, [], spawnGit)
  if (everything === null) return { status: "nothing_to_commit", commit: { status: "failed", reason: "git could not list the staged changes" } }
  for (const change of everything) {
    const missing = change.paths.filter((p) => !listed.has(p))
    if (change.paths.length === 2 && missing.length === 1) {
      throw new Error(`desk_save: add ${missing[0]} to \`paths\`: a move is committed with both its old and its new path`)
    }
  }
  const changes = everything.filter((change) => change.paths.some((p) => listed.has(p)))
  if (changes.length === 0) return { status: "nothing_to_commit" }
  for (const change of changes) {
    const card = change.paths.find(isCard)
    if (card !== undefined && change.status !== "R100" && change.status !== "D") {
      throw new Error(`desk_save: unstage ${card} (git restore --staged -- <path>) and change that task card with task_update; a tidy commits a task card only as a move or a delete, not an edit`)
    }
  }
  const entries = indexEntries(deskRoot, rels, spawnGit)
  if (entries === null) return { status: "nothing_to_commit", commit: { status: "failed", reason: "git could not read the index" } }
  if (entries.filter((entry) => isCard(entry.path)).some((entry) => entry.mode !== "100644" && entry.mode !== "100755")) {
    throw new Error("desk_save: a task card in `paths` is not a regular file (a link, for example); restore it with git restore --staged and git restore, then pass only the moved cards")
  }
  const committed = commitIndexPaths(deskRoot, rels, entries, tidyTrailer(message), spawnGit)
  if (!committed.ok) return { status: "nothing_to_commit", commit: { status: "failed", reason: committed.stderr } }
  schedulePush({ root: deskRoot })
  return { status: "committed" }
}
