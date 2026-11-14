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
import { existsSync, statSync, lstatSync, realpathSync, readFileSync, readlinkSync, constants as fsConstants, promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import { personPrefix, isPathContained, resolveWriteTarget } from "../util/paths.js"
import { isLiveCardPath } from "../desk/card-commit-guard.js"
import { DESK_COMMIT_HASH_NOTE, headSha } from "./task.js"
import { isGitRepository, hasUnmergedPath, hasUnstagedWork, stagedChanges, indexEntries, stagePaths, commitPaths, commitIndexPaths } from "../util/git-stage.js"
import { commitFailure, commitRoute, withNext } from "../util/route-around.js"
import { operationAnswer } from "../util/cas-commit.js"
import { deskPushNote, schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { admitContent, assertCleanContentTarget } from "../desk/content-home.js"

// Every field desk_save reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const DESK_SAVE_FIELDS = ["paths", "files", "message", "tidy", "content_home"]

const TIDY_TRAILER = "Desk-Tidy: true"

function pathsInput(value) {
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw Object.assign(new Error("desk_save: Pass `paths` as a non-empty array of path strings: `paths` must be a non-empty array of path strings (got a string that is not valid JSON)"), { code: "desk_save_paths_must_be_a_non_2" })
    }
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((p) => typeof p === "string" && p.trim() !== "")
  ) {
    throw Object.assign(new Error("desk_save: Pass `paths` as a non-empty array of path strings: `paths` must be a non-empty array of path strings"), { code: "desk_save_paths_must_be_a_non" })
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
      throw Object.assign(new Error(`${FILES_SHAPE} (got a string that is not valid JSON)`), { code: "desk_save_got_a_string_that_is" })
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

// Where `absolute` really leads, through the real path of its deepest existing folder, and what is there now.
// resolveWriteTarget has already refused a path with a file in the middle of it and a link it cannot resolve, so what is
// left is a missing tail. Any other error (no permission, say) is not caught here: it ends the call, so nothing is written.
function inspectTarget(absolute) {
  let ancestor = path.dirname(absolute)
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) ancestor = path.dirname(ancestor)
  const resolved = path.join(realpathSync.native(ancestor), path.relative(ancestor, absolute))
  return { resolved, existing: lstatSync(resolved, { throwIfNoEntry: false }) }
}

// Every `files` entry, checked before any is written. Returns each entry's absolute target. Containment and symbolic links
// are resolveWriteTarget's job (the one confined-write helper the other write tools use); the checks here are the ones it lacks.
async function checkFiles(deskRoot, person, effectiveRoot, files) {
  const realRoot = realpathSync.native(deskRoot)
  const seen = new Set()
  const checked = []
  for (const { path: relativePath, content } of files) {
    const refuse = (why, { code = "desk_save_files_cannot_write" } = {}) => Object.assign(new Error(`desk_save: Fix or drop that entry in \`files\`: \`files\` cannot write ${relativePath}: ${why}`), { code })
    if (relativePath.includes("\0")) throw refuse("the path holds a NUL character", { code: "desk_save_path_nul" })
    if (path.isAbsolute(relativePath)) throw refuse("give the path relative to the desk root", { code: "desk_save_path_absolute" })
    if (PATHSPEC_SPECIAL.test(relativePath)) throw refuse("the path holds *, ?, [ or a backslash, or starts with :, which Git would read as a pattern", { code: "desk_save_path_pathspec" })
    const given = pathRefusal(relativePath)
    if (given !== null) throw refuse(given)
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) throw refuse("the content is over 1 MiB", { code: "desk_save_content_too_large" })
    const absolute = path.resolve(deskRoot, relativePath)
    if (!isPathContained(effectiveRoot, absolute)) throw refuse("it is outside the resolved write prefix", { code: "desk_save_path_outside_prefix" })
    if (seen.has(absolute)) throw refuse("it is listed twice", { code: "desk_save_path_listed_twice" })
    seen.add(absolute)
    try {
      await resolveWriteTarget({ deskRoot, person, segments: path.relative(effectiveRoot, absolute).split(path.sep) })
    } catch (error) {
      throw refuse(error.message)
    }
    const { resolved, existing } = inspectTarget(absolute)
    if (existing?.isSymbolicLink()) throw refuse("the file there is a symbolic link", { code: "desk_save_target_symlink" })
    if (existing !== undefined && !existing.isFile()) throw refuse("what is there is not a file", { code: "desk_save_target_not_file" })
    const leads = pathRefusal(path.relative(realRoot, resolved).split(path.sep).join("/"))
    if (leads !== null) throw refuse(`it leads through a symbolic link to a path where ${leads}`, { code: "desk_save_path_via_symlink" })
    checked.push({ absolute, content })
  }
  return checked
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
 * `git revert --no-commit` once a revert that applied cleanly is ended with `git revert --quit`; while the revert is still in progress, or a listed
 * path is in conflict, it holds and commits nothing (#632).
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
 * Stages exactly `paths` (`git add -A -- <paths>`, never repo-wide) and commits them with `message`, `git commit -- <paths>`,
 * never `-a`. A deletion or rename already staged at a listed path (`git rm`, `git mv`) is committed too; a staged rename with only
 * one of its two paths listed is refused (throws), naming the other path to add. When none of `paths`
 * holds an unstaged change, an untracked file or a staged change — a path that was never actually written — desk_save
 * reports `nothing_to_commit` without staging or committing anything, so a
 * caller's typo or stale path never becomes an empty commit. A stage or
 * commit failure for paths that do hold real changes is reported the same
 * way, via `commit: { status: "failed", reason }`, distinguishing "nothing
 * to commit" as a Git-level failure from the benign case above. On a
 * non-Git desk, or when the desk root isn't a Git repository, there is
 * nothing desk_save can do, so it reports `nothing_to_commit` too.
 *
 * Returns: { status: "committed" | "nothing_to_commit", commit?, desk_commit?, desk_pushed?, desk_note? }: a commit made here reports
 * its short sha as `desk_commit` (left out when Git cannot say) and `desk_pushed: false`, because the push is scheduled, not yet done.
 */
function tidyTrailer(message) {
  const trimmed = message.replace(/\s+$/u, "")
  return trimmed.split("\n").at(-1).trim() === TIDY_TRAILER ? trimmed : `${trimmed}\n\n${TIDY_TRAILER}`
}

export async function desk_save(args) {
  return withNext(await saveDesk(args))
}

async function saveDesk({ deskRoot, input, person = null, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  if (values.paths === undefined && values.files === undefined) {
    throw Object.assign(new Error("desk_save: pass `paths` (a non-empty array of path strings), `files`, or both"), { code: "desk_save_pass_paths_a_non_empty" })
  }
  const paths = values.paths === undefined ? [] : pathsInput(values.paths)
  const files = values.files === undefined ? [] : filesInput(values.files)
  const { message } = values
  if (!message || typeof message !== "string") {
    throw Object.assign(new Error("desk_save: Pass `message` as a string: `message` is required (string)"), { code: "desk_save_message_is_required_string" })
  }

  const tidy = values.tidy === true
  if (tidy && files.length > 0) {
    throw Object.assign(new Error("desk_save: Pass only `paths` with tidy: true: `files` cannot be combined with tidy: true; a tidy commits moves already staged, so pass only `paths`"), { code: "desk_save_true_files_cannot_be_combined" })
  }
  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  for (const relativePath of paths) {
    const absolute = path.resolve(deskRoot, relativePath)
    if (!isPathContained(effectiveRoot, absolute)) {
      throw Object.assign(new Error(`desk_save: Pass only paths inside the write prefix: \`paths\` includes a path outside the resolved write prefix: ${relativePath}`), { code: "desk_save_paths_includes_a_path_outside" })
    }
    // Desk's commit path is the one the desk's pre-commit hook trusts, so a card must not be able to ride through it.
    if (!tidy && isLiveCardPath(path.relative(deskRoot, absolute).split(path.sep).join("/"))) {
      throw Object.assign(new Error(`desk_save: remove ${relativePath} from \`paths\` and write the task card with task_update, task_create, task_move or task_archive, which commit it; to commit a tidy that moved cards, pass tidy: true`), { code: "desk_save_true" })
    }
  }
  const checked = files.length > 0 ? await checkFiles(deskRoot, person, effectiveRoot, files) : []
  const contentAdmission = admitContent({
    deskRoot,
    tool: "desk_save",
    declaration: values.content_home,
    subjects: () => {
      const subjects = files.map((file, i) => ({ id: `files/${i}/content`, content: file.content }))
      const supplied = new Set(files.map((file) => path.resolve(deskRoot, file.path)))
      for (const [i, relativePath] of paths.entries()) {
        if (PATHSPEC_SPECIAL.test(relativePath)) throw Object.assign(new Error("desk_save: content_home_unresolved: use exact file paths with forward slashes, not Git patterns or magic; nothing was written or committed"), { code: "desk_save_use_exact_file_paths_with" })
        const absolute = path.resolve(deskRoot, relativePath)
        if (supplied.has(absolute)) continue
        const entry = lstatSync(absolute, { throwIfNoEntry: false })
        if (entry?.isDirectory()) throw Object.assign(new Error("desk_save: content_home_unresolved: use exact file paths so every committed subject has a declared purpose; nothing was written or committed"), { code: "desk_save_use_exact_file_paths_so" })
        let content = Buffer.alloc(0)
        if (entry !== undefined) {
          if (!isPathContained(realpathSync.native(effectiveRoot), realpathSync.native(path.dirname(absolute)))) {
            throw Object.assign(new Error("desk_save: Pass a path inside the write prefix: content_home_unresolved: a path leads outside the write prefix; nothing was written or committed"), { code: "desk_save_content_home_unresolved_a_path" })
          }
          content = entry.isSymbolicLink() ? Buffer.from(readlinkSync(absolute), "utf8") : readFileSync(absolute)
        }
        subjects.push({ id: `paths/${i}`, content })
      }
      return subjects
    },
  })
  for (const { absolute } of checked) assertCleanContentTarget(deskRoot, path.relative(deskRoot, absolute), contentAdmission, "desk_save")
  if (files.length > 0) {
    await writeFiles(checked)
    paths.push(...files.map((file) => file.path).filter((p) => !paths.includes(p)))
  }

  if (!isGitRepository(deskRoot, spawnGit)) {
    return { status: "nothing_to_commit" }
  }

  if (tidy) {
    const result = commitTidy({ deskRoot, paths, message, spawnGit, schedulePush })
    if (contentAdmission !== null) result.content_admission = contentAdmission
    return result
  }

  // No unstaged change, no untracked file and no staged change at any of these paths means there is nothing here to commit:
  // most often a path that was never actually written. Checking this before staging means a caller's typo never becomes an
  // empty commit. A deletion or rename already staged with `git rm` or `git mv` is a change to commit (issue #414).
  const unstaged = paths.filter((p) => hasUnstagedWork(deskRoot, [p], spawnGit))
  if (unstaged.length === 0 && (stagedChanges(deskRoot, paths, spawnGit)?.length ?? 0) === 0) {
    return { status: "nothing_to_commit" }
  }

  // Only the listed paths that hold unstaged work are staged: the old side of a `git rm` or `git mv` is neither on disk nor in
  // the index, and `git add` refuses the whole call for one such path.
  if (unstaged.length > 0) {
    const staged = stagePaths(deskRoot, unstaged, spawnGit, undefined, { all: true })
    if (!staged.ok) {
      return { status: "nothing_to_commit", commit: notCommitted(deskRoot, paths, message, staged.stderr) }
    }
  }
  // A staged move committed by one side only keeps both files (the new path listed) or deletes the file on the remote while its
  // content stays staged here (the old path listed), so both paths must be listed, as a tidy requires.
  const everything = stagedChanges(deskRoot, [], spawnGit)
  if (everything === null) return { status: "nothing_to_commit", commit: notCommitted(deskRoot, paths, message, "git could not list the staged changes") }
  const listed = paths.map((p) => path.relative(deskRoot, path.resolve(deskRoot, p)).split(path.sep).join("/"))
  const covered = (p) => listed.some((rel) => rel === "" || p === rel || p.startsWith(`${rel}/`))
  for (const change of everything) {
    const missing = change.paths.filter((p) => !covered(p))
    if (change.paths.length === 2 && missing.length === 1) {
      throw Object.assign(new Error(`desk_save: add ${missing[0]} to \`paths\`: a move is committed with both its old and its new path`), { code: "desk_save_a_move_is_committed_with_2" })
    }
  }
  const committed = commitPaths(deskRoot, paths, message, spawnGit)
  if (!committed.ok) {
    return { status: "nothing_to_commit", commit: commitFailure({ root: deskRoot, paths: listed, message, committed }) }
  }
  // HEAD is read before the push is scheduled, so a push that rebases cannot hand back its own hash.
  const deskCommit = headSha(deskRoot, spawnGit)
  schedulePush({ root: deskRoot })
  const answer = { status: "committed", ...deskPushNote({ root: deskRoot, spawnGit, note: DESK_SAVE_NOTE }), desk_pushed: false }
  if (contentAdmission !== null) answer.content_admission = contentAdmission
  return deskCommit === null ? answer : { ...answer, desk_commit: deskCommit, desk_commit_note: DESK_COMMIT_HASH_NOTE }
}

// A stage or read failure: nothing was committed, and the route finishes the commit by hand (#623).
function notCommitted(deskRoot, paths, message, reason) {
  const rels = paths.map((p) => path.relative(deskRoot, path.resolve(deskRoot, p)).split(path.sep).join("/"))
  return { status: "failed", reason, route_around: commitRoute({ root: deskRoot, paths: rels, message, readback: "absent" }) }
}

// Said in the answer so no agent pushes by hand or reads `desk_pushed: false` as a failure.
const DESK_SAVE_NOTE = "Desk committed these files and is pushing them in the background, so run no git for them."

// The tidy commit. Task cards must already be staged as pure renames or deletions; every other path is staged here when it holds unstaged work.
// What is committed is what was judged: the index at `paths`, through a temporary index (commitIndexPaths), never the working tree. `_archive/**` is not a live
// card path (isLiveCardPath, like the pre-commit hook), so a card moved into `_archive/` is checked as the move it is and an archived card is never judged as one.
const TIDY_DIRECTORY_OR_GLOB = /[*?[]/u

function commitTidy({ deskRoot, paths, message, spawnGit, schedulePush }) {
  const rels = paths.map((p) => path.relative(deskRoot, path.resolve(deskRoot, p)).split(path.sep).join("/"))
  for (const [i, rel] of rels.entries()) {
    const absolute = path.resolve(deskRoot, rel)
    if (TIDY_DIRECTORY_OR_GLOB.test(rel) || (existsSync(absolute) && statSync(absolute).isDirectory())) {
      throw Object.assign(new Error(`desk_save: Use the file paths of the tidy instead of a folder or pattern: replace ${paths[i]} with the file paths of the tidy (the old and new path of each moved task card, and each file you fixed); tidy: true takes files, never a folder or a pattern`), { code: "desk_save_replace_with_the_file_paths" })
    }
  }
  // A path Git holds in conflict (an unfinished merge, cherry-pick or revert, the tidy's undo included) is never staged: staging it
  // would mark the conflict resolved with its markers in the file. It holds before anything is staged, so the index stays as it was.
  if (hasUnmergedPath(deskRoot, rels, spawnGit)) {
    const conflicted = rels.filter((p) => hasUnmergedPath(deskRoot, [p], spawnGit)).join(", ")
    return { status: "nothing_to_commit", commit: notCommitted(deskRoot, rels, tidyTrailer(message), `Git holds ${conflicted} in conflict, so Desk staged and committed nothing; resolve the conflict, or leave it for the human`) }
  }
  // A merge, cherry-pick, revert or rebase in progress holds the same way, before anything is staged: commitIndexPaths would hold
  // anyway, and staging first would leave this tidy's files in the index for that operation's own commit.
  const operation = operationAnswer(spawnGit, deskRoot)
  if (operation) return { status: "nothing_to_commit", commit: notCommitted(deskRoot, rels, tidyTrailer(message), operation.reason) }
  const isCard = (p) => isLiveCardPath(p)
  const cards = rels.filter(isCard)
  const others = rels.filter((p) => !isCard(p))
  if (cards.length > 0 && hasUnstagedWork(deskRoot, cards, spawnGit)) {
    throw Object.assign(new Error("desk_save: Run task_update for a card edit, or restore the card and pass only moved cards: a task card in `paths` has an unstaged change, is untracked, or git could not check it; run task_update for a card edit, or git restore --staged and git restore the card, and pass only cards that task_move, track_rename or git mv staged as moves"), { code: "desk_save_a_task_card_in_paths_2" })
  }
  // Only the paths that hold unstaged work are staged. The old side of a move `git mv` already staged is neither on disk nor in the index, and `git add` refuses the whole call for one such path.
  const unstaged = others.filter((p) => hasUnstagedWork(deskRoot, [p], spawnGit))
  if (unstaged.length > 0) {
    const staged = stagePaths(deskRoot, unstaged, spawnGit)
    if (!staged.ok) return { status: "nothing_to_commit", commit: notCommitted(deskRoot, rels, tidyTrailer(message), staged.stderr) }
  }
  const listed = new Set(rels)
  const everything = stagedChanges(deskRoot, [], spawnGit)
  if (everything === null) return { status: "nothing_to_commit", commit: notCommitted(deskRoot, rels, tidyTrailer(message), "git could not list the staged changes") }
  for (const change of everything) {
    const missing = change.paths.filter((p) => !listed.has(p))
    if (change.paths.length === 2 && missing.length === 1) {
      throw Object.assign(new Error(`desk_save: add ${missing[0]} to \`paths\`: a move is committed with both its old and its new path`), { code: "desk_save_a_move_is_committed_with" })
    }
  }
  const changes = everything.filter((change) => change.paths.some((p) => listed.has(p)))
  if (changes.length === 0) return { status: "nothing_to_commit" }
  for (const change of changes) {
    const card = change.paths.find(isCard)
    if (card !== undefined && change.status !== "R100" && change.status !== "D") {
      throw Object.assign(new Error(`desk_save: unstage ${card} (git restore --staged -- <path>) and change that task card with task_update; a tidy commits a task card only as a move or a delete, not an edit`), { code: "desk_save_unstage_git_restore_staged_path" })
    }
  }
  const entries = indexEntries(deskRoot, rels, spawnGit)
  if (entries === null) return { status: "nothing_to_commit", commit: notCommitted(deskRoot, rels, tidyTrailer(message), "git could not read the index") }
  if (entries.filter((entry) => isCard(entry.path)).some((entry) => entry.mode !== "100644" && entry.mode !== "100755")) {
    throw Object.assign(new Error("desk_save: Run git restore --staged and git restore on the card, then pass only the moved cards: a task card in `paths` is not a regular file (a link, for example); restore it with git restore --staged and git restore, then pass only the moved cards"), { code: "desk_save_a_task_card_in_paths" })
  }
  const committed = commitIndexPaths(deskRoot, rels, entries, tidyTrailer(message), spawnGit)
  if (!committed.ok) return { status: "nothing_to_commit", commit: commitFailure({ root: deskRoot, paths: rels, message: tidyTrailer(message), committed }) }
  schedulePush({ root: deskRoot })
  return { status: "committed" }
}
