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
import { personPrefix, isPathContained, resolveWriteTarget } from "../util/paths.js"
import { isLiveCardPath } from "../desk/card-commit-guard.js"
import { DESK_COMMIT_HASH_NOTE, headSha } from "./task.js"
import { repositoryState, hasUnstagedWork, unstagedWorkState, stagedChanges, indexEntries, stagePaths, commitPaths, commitIndexPaths, gitFailure } from "../util/git-stage.js"
import { deskPushNote, schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { assertPublicationProducer, publicationReceiptOf, publicationGit, createPublicationIntent, requestPublication } from "../runtime/publication-state.js"

// Every field desk_save reads off `input`, kept next to the handler so a
// field added to its reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const DESK_SAVE_FIELDS = ["paths", "files", "message", "tidy"]

const TIDY_TRAILER = "Desk-Tidy: true"

function pathsInput(value, check = () => {}) {
  check()
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error("desk_save: `paths` must be a non-empty array of path strings (got a string that is not valid JSON)")
    }
    check()
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((p) => { check(); return typeof p === "string" && p.trim() !== "" })
  ) {
    throw new Error("desk_save: `paths` must be a non-empty array of path strings")
  }
  return parsed
}

const MAX_FILE_BYTES = 1024 * 1024
const FILES_SHAPE = "desk_save: `files` must be a non-empty array of { path, content } objects whose path and content are strings"
// Git reads these in a pathspec as a pattern or as magic, so `git add -- <path>` could stage files the call never wrote.
const PATHSPEC_SPECIAL = /[*?[\\]|^:/u

function filesInput(value, check = () => {}) {
  check()
  let parsed = value
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value)
    } catch {
      throw new Error(`${FILES_SHAPE} (got a string that is not valid JSON)`)
    }
    check()
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((entry) => { check(); return entry !== null && typeof entry === "object" && typeof entry.path === "string" && typeof entry.content === "string" })
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
function inspectTarget(absolute, check = () => {}) {
  let ancestor = path.dirname(absolute)
  while (lstatSync(ancestor, { throwIfNoEntry: false }) === undefined) { check(); ancestor = path.dirname(ancestor) }
  const resolved = path.join(realpathSync.native(ancestor), path.relative(ancestor, absolute))
  return { resolved, existing: lstatSync(resolved, { throwIfNoEntry: false }) }
}

// Every `files` entry, checked before any is written. Returns each entry's absolute target. Containment and symbolic links
// are resolveWriteTarget's job (the one confined-write helper the other write tools use); the checks here are the ones it lacks.
async function checkFiles(deskRoot, person, effectiveRoot, files, check = () => {}) {
  check()
  const realRoot = realpathSync.native(deskRoot)
  const seen = new Set()
  const checked = []
  for (const { path: relativePath, content } of files) {
    check()
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
    try {
      await resolveWriteTarget({ deskRoot, person, segments: path.relative(effectiveRoot, absolute).split(path.sep) })
    } catch (error) {
      throw refuse(error.message)
    }
    check()
    const { resolved, existing } = inspectTarget(absolute, check)
    if (existing?.isSymbolicLink()) throw refuse("the file there is a symbolic link")
    if (existing !== undefined && !existing.isFile()) throw refuse("what is there is not a file")
    const leads = pathRefusal(path.relative(realRoot, resolved).split(path.sep).join("/"))
    if (leads !== null) throw refuse(`it leads through a symbolic link to a path where ${leads}`)
    checked.push({ absolute, relativePath, content })
  }
  check()
  return checked
}

// O_NOFOLLOW: a symbolic link put at the target after the check fails the open instead of being written through.
async function writeFiles(checked, checkAuthority = () => {}) {
  const applied = []
  for (const { absolute, relativePath, content } of checked) {
    try {
      checkAuthority()
      await fs.mkdir(path.dirname(absolute), { recursive: true })
      checkAuthority()
      const handle = await fs.open(absolute, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | fsConstants.O_NOFOLLOW, 0o644)
      try {
        checkAuthority()
        await handle.writeFile(content, "utf8")
      } finally {
        await handle.close()
      }
      applied.push(relativePath)
    } catch (error) {
      error.mutation = {
        status: applied.length > 0 ? "partial" : "unknown",
        applied_paths: [...applied],
        uncertain_paths: [relativePath],
        readback_required: true,
      }
      throw error
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
 * real path of its deepest existing folder, inside the desk and the write prefix. Validation refuses before any write. A later write failure retains completed writes and names the uncertain path; it does not roll back.
 *
 * Stages exactly `paths` (`git add -A -- <paths>`, never repo-wide) and commits them with `message`, `git commit -- <paths>`,
 * never `-a`. A deletion or rename already staged at a listed path (`git rm`, `git mv`) is committed too; a staged rename with only
 * one of its two paths listed is refused (throws), naming the other path to add. When none of `paths`
 * holds an unstaged change, an untracked file or a staged change — a path that was never actually written — desk_save
 * reports `nothing_to_commit` without staging or committing anything, so a
 * caller's typo or stale path never becomes an empty commit. Failed inspection, staging or commit returns `status: "failed"` with a failed `commit`; uncertain mutation effects require readback before another dispatch. A confirmed non-Git desk returns `nothing_to_commit`.
 *
 * Returns: { status: "committed" | "nothing_to_commit" | "failed", commit?, effects?, desk_commit?, desk_pushed?, desk_note? }: a commit made here reports
 * its short sha as `desk_commit` (left out when Git cannot say) and `desk_pushed: false`, because the push is scheduled, not yet done.
 */
function tidyTrailer(message) {
  const trimmed = message.replace(/\s+$/u, "")
  return trimmed.split("\n").at(-1).trim() === TIDY_TRAILER ? trimmed : `${trimmed}\n\n${TIDY_TRAILER}`
}

/** Shared validation; it inspects targets but writes no bytes or index entries. */
export async function prepareDeskSaveInput({ deskRoot, person = null, input, deadline = Infinity }) {
  const check = () => { if (Date.now() >= deadline) throw Object.assign(new Error("producer_deadline"), { code: "producer_deadline" }) }
  check()
  const values = input ?? {}
  if (values.paths === undefined && values.files === undefined) throw new Error("desk_save: pass paths, files, or both")
  const paths = values.paths === undefined ? [] : pathsInput(values.paths, check)
  const files = values.files === undefined ? [] : filesInput(values.files, check)
  if (typeof values.message !== "string" || !values.message) throw new Error("desk_save: message is required")
  const tidy = values.tidy === true
  if (tidy && files.length) throw new Error("desk_save: files cannot be combined with tidy")
  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  for (const file of paths) {
    check()
    const absolute = path.resolve(deskRoot, file)
    if (!isPathContained(effectiveRoot, absolute)) throw new Error("desk_save: path is outside the write prefix")
    if (tidy && (TIDY_DIRECTORY_OR_GLOB.test(file) || (existsSync(absolute) && statSync(absolute).isDirectory()))) {
      throw new Error("desk_save: tidy takes exact file paths, not directories or patterns")
    }
    if (file.includes("\0") || PATHSPEC_SPECIAL.test(file)) throw new Error("desk_save: pathspec patterns are not permitted")
    if (!tidy && isLiveCardPath(path.relative(deskRoot, absolute))) throw new Error("desk_save: write task cards through task tools")
    const segments = path.relative(effectiveRoot, absolute).split(path.sep).filter(Boolean)
    if (segments.length) await resolveWriteTarget({ deskRoot, person, segments })
    check()
  }
  const checkedFiles = await checkFiles(deskRoot, person, effectiveRoot, files, check)
  const copied = files.map((file) => { check(); return { ...file } })
  check()
  return { paths: [...paths], files: copied,
    message: tidy ? tidyTrailer(values.message) : values.message, tidy, checkedFiles }
}

export async function desk_save({ deskRoot, input, person = null, spawnGit = spawnSync, schedulePush = schedulePushDefault, statusContext = {} }) {
  const publicationContext = statusContext.publicationContext
  const stateBranch = statusContext.stateBranch
  if (publicationContext !== undefined && statusContext.acceptedProducer === true) {
    const createdAtMs = Date.now()
    const { requestDeskSaveProducer } = await import("../runtime/producer-state.js")
    const producer = await requestDeskSaveProducer({ context: publicationContext, input, createdAtMs, root: deskRoot, person, stateBranch })
    return { status: "producer_pending", producer, desk_pushed: false, publication: "not_started",
      desk_note: "Accepted producer work is observed by its operation. Pending admission is not a local commit or remote verification." }
  }
  if (publicationContext !== undefined) assertPublicationProducer({ context: publicationContext, root: deskRoot, person, stateBranch })
  if (publicationContext !== undefined) spawnGit = publicationGit(publicationContext)
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
    const checked = await checkFiles(deskRoot, person, effectiveRoot, files)
    await writeFiles(checked, () => {
      if (publicationContext !== undefined) assertPublicationProducer({ context: publicationContext, root: deskRoot, person, stateBranch })
    })
    paths.push(...files.map((file) => file.path).filter((p) => !paths.includes(p)))
  }

  const failed = (commit) => ({
    status: "failed", commit,
    ...(files.length > 0 ? {
      effects: { status: "partial", applied_paths: files.map((file) => file.path), readback_required: true },
    } : {}),
  })
  const repository = repositoryState(deskRoot, spawnGit)
  if (repository.status === "failed") {
    return failed({ status: "failed", reason: repository.reason })
  }
  if (repository.status === "not_git") {
    return { status: "nothing_to_commit" }
  }

  if (tidy) return commitTidy({ deskRoot, paths, message, spawnGit, schedulePush, publicationContext, stateBranch })

  // No unstaged change, no untracked file and no staged change at any of these paths means there is nothing here to commit:
  // most often a path that was never actually written. Checking this before staging means a caller's typo never becomes an
  // empty commit. A deletion or rename already staged with `git rm` or `git mv` is a change to commit (issue #414).
  const unstaged = []
  for (const p of paths) {
    const state = unstagedWorkState(deskRoot, [p], spawnGit)
    if (state.status === "failed") return failed({ status: "failed", reason: `git could not inspect unstaged changes: ${state.reason}` })
    if (state.status === "changed") unstaged.push(p)
  }
  if (unstaged.length === 0) {
    const staged = stagedChanges(deskRoot, paths, spawnGit)
    if (staged === null) return failed({ status: "failed", reason: "git could not list the staged changes" })
    if (staged.length === 0) return { status: "nothing_to_commit" }
  }

  // Only the listed paths that hold unstaged work are staged: the old side of a `git rm` or `git mv` is neither on disk nor in
  // the index, and `git add` refuses the whole call for one such path.
  if (unstaged.length > 0) {
    if (publicationContext !== undefined) assertPublicationProducer({ context: publicationContext, root: deskRoot, person, stateBranch })
    const staged = stagePaths(deskRoot, unstaged, spawnGit, stateBranch, { all: true })
    if (!staged.ok) {
      return failed(gitFailure(staged))
    }
  }
  // A staged move committed by one side only keeps both files (the new path listed) or deletes the file on the remote while its
  // content stays staged here (the old path listed), so both paths must be listed, as a tidy requires.
  const everything = stagedChanges(deskRoot, [], spawnGit)
  if (everything === null) return failed({ status: "failed", reason: "git could not list the staged changes" })
  const listed = paths.map((p) => path.relative(deskRoot, path.resolve(deskRoot, p)).split(path.sep).join("/"))
  const covered = (p) => listed.some((rel) => rel === "" || p === rel || p.startsWith(`${rel}/`))
  for (const change of everything) {
    const missing = change.paths.filter((p) => !covered(p))
    if (change.paths.length === 2 && missing.length === 1) {
      throw new Error(`desk_save: add ${missing[0]} to \`paths\`: a move is committed with both its old and its new path`)
    }
  }
  const committed = await commitPaths(deskRoot, paths, message, spawnGit, stateBranch, { publicationContext })
  if (!committed.ok) {
    if (publicationContext !== undefined && publicationReceiptOf({ context: publicationContext, commitResult: committed }).status === "qualified") {
      return { ...publicationAnswer(publicationContext, committed), status: "failed", commit: gitFailure(committed), effects: committed.effects }
    }
    return failed(gitFailure(committed))
  }
  if (publicationContext !== undefined) return publicationAnswer(publicationContext, committed)
  // HEAD is read before the push is scheduled, so a push that rebases cannot hand back its own hash.
  const deskCommit = headSha(deskRoot, spawnGit)
  schedulePush({ root: deskRoot })
  const answer = { status: "committed", ...deskPushNote({ root: deskRoot, spawnGit, note: DESK_SAVE_NOTE }), desk_pushed: false }
  return deskCommit === null ? answer : { ...answer, desk_commit: deskCommit, desk_commit_note: DESK_COMMIT_HASH_NOTE }
}

// Said in the answer so no agent pushes by hand or reads `desk_pushed: false` as a failure.
const DESK_SAVE_NOTE = "Desk committed these files and is pushing them in the background, so run no git for them."

function publicationAnswer(context, commitResult) {
  const proof = publicationReceiptOf({ context, commitResult })
  if (proof.status !== "qualified") return { status: "committed", desk_pushed: false, publication: proof,
    ...(commitResult.effects ? { effects: commitResult.effects } : {}),
    desk_note: "The local commit is retained, but publication is unqualified. Do not retry the commit or enqueue the root." }
  const intent = createPublicationIntent({ context, commitReceipt: proof.receipt })
  const ticket = requestPublication({ context, intent })
  return { status: "committed", desk_commit: ticket.targetCommit, desk_pushed: false, publication: ticket,
    ...(commitResult.effects ? { effects: commitResult.effects } : {}),
    desk_note: "The local commit has a durable publication ticket. Queued is not remotely verified; observe this ticket rather than repeating the commit." }
}

// The tidy commit. Task cards must already be staged as pure renames or deletions; every other path is staged here when it holds unstaged work.
// What is committed is what was judged: the index at `paths`, through a temporary index (commitIndexPaths), never the working tree. `_archive/**` is not a live
// card path (isLiveCardPath, like the pre-commit hook), so a card moved into `_archive/` is checked as the move it is and an archived card is never judged as one.
const TIDY_DIRECTORY_OR_GLOB = /[*?[]/u

async function commitTidy({ deskRoot, paths, message, spawnGit, schedulePush, publicationContext, stateBranch }) {
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
  // Only the paths that hold unstaged work are staged. The old side of a move `git mv` already staged is neither on disk nor in the index, and `git add` refuses the whole call for one such path.
  const unstaged = []
  for (const p of others) {
    const state = unstagedWorkState(deskRoot, [p], spawnGit)
    if (state.status === "failed") return { status: "failed", commit: { status: "failed", reason: `git could not inspect unstaged changes: ${state.reason}` } }
    if (state.status === "changed") unstaged.push(p)
  }
  if (unstaged.length > 0) {
    const staged = stagePaths(deskRoot, unstaged, spawnGit)
    if (!staged.ok) return { status: "failed", commit: gitFailure(staged) }
  }
  const listed = new Set(rels)
  const everything = stagedChanges(deskRoot, [], spawnGit)
  if (everything === null) return { status: "failed", commit: { status: "failed", reason: "git could not list the staged changes" } }
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
  if (entries === null) return { status: "failed", commit: { status: "failed", reason: "git could not read the index" } }
  if (entries.filter((entry) => isCard(entry.path)).some((entry) => entry.mode !== "100644" && entry.mode !== "100755")) {
    throw new Error("desk_save: a task card in `paths` is not a regular file (a link, for example); restore it with git restore --staged and git restore, then pass only the moved cards")
  }
  const committed = await commitIndexPaths(deskRoot, rels, entries, tidyTrailer(message), spawnGit, stateBranch, { publicationContext })
  if (!committed.ok) {
    if (publicationContext !== undefined && publicationReceiptOf({ context: publicationContext, commitResult: committed }).status === "qualified") {
      return { ...publicationAnswer(publicationContext, committed), status: "failed", commit: gitFailure(committed), effects: committed.effects }
    }
    return { status: "failed", commit: gitFailure(committed) }
  }
  if (publicationContext !== undefined) return publicationAnswer(publicationContext, committed)
  schedulePush({ root: deskRoot })
  return { status: "committed" }
}
