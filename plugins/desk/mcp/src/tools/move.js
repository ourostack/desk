// Cheap moves — task_move, track_rename.
//
// Both move a folder (via `git mv` semantics when the desk is a Git
// repository, a plain rename otherwise), touch the small set of frontmatter
// fields that record ownership (`track:` on a moved/reparented task card),
// and best-effort keep each `track.md`'s "## Tasks" table in sync. Neither
// tool ever rewrites free text elsewhere — it only reports, in `mentions`,
// other text files under the desk that still mention the old relative path,
// so the agent (or the operator) can fix them if they matter. On a Git desk
// they stage every file they write (M4-5 fix round 4) and commit exactly
// the paths they wrote — the moved directory plus any track.md tables it
// edited — right after (M4-6 Part 2); a plain rename with no commit is as
// far as either goes on a non-Git desk.

import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { TERMINAL_STATES } from "../desk/lifecycle.js"
import {
  nowIso,
  readMarkdown,
  writeMarkdown,
  patchMarkdownFrontmatter,
  pathExists,
} from "../util/fm.js"
import { resolveWriteTarget, personPrefix } from "../util/paths.js"
import { withCreatedDirs } from "../util/created-dirs.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { isGitRepository, hasUnstagedWork, stagePaths, commitPaths } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { redactCredentialLikeText, redactName } from "../util/redact.js"
import { focusNote } from "./task-focus.js"
import { resolveTaskHandle, resolveTrackHandle } from "../desk/handles.js"
import {
  validateName,
  validateTrackName,
  operatorNames,
  describeNameRejection,
} from "../desk/naming.js"

const SKIP_DIRS = new Set(["node_modules", ".git", ".state"])

// Every field task_move/track_rename read off `input`, kept next to this
// module so a field added to either handler's reads is a field added here
// in the same diff. __tests__/tool_schema_parity.test.js checks these
// against each tool's declared schema in tool-schemas.js.
export const TASK_MOVE_FIELDS = ["track", "slug", "handle", "to_track", "to_slug", "unarchive", "into_task", "allow_dirty"]
export const TRACK_RENAME_FIELDS = ["track", "handle", "to", "allow_dirty"]

const TERMINAL_STATUSES = new Set(TERMINAL_STATES)

function relPath(root, absPath) {
  return path.relative(root, absPath)
}

// A path the tool shows (in a result or an error): relative to the desk, with
// forward slashes, and every segment that carries a secret's value replaced by
// the redaction marker, so renaming a credential-like folder by its handle
// never echoes the old name.
function shownPath(relative) {
  return relative.split(/[\\/]/u).map(redactName).join("/")
}

function shownRelPath(root, absPath) {
  return shownPath(relPath(root, absPath))
}

/**
 * Refuses traversal-shaped input (non-string, empty/whitespace-only, `..`,
 * `/`, `\`) before any path-resolution code runs, with a message that names
 * the field but never echoes the candidate. `track`/`slug` may legitimately
 * name a pre-existing item that predates every naming rule (M4-1: "existing
 * names are never rejected on read"), so this only screens out shapes that
 * could never be a real path segment — it is not the fuller name rules
 * `validateName`/`validateTrackName` enforce for a *new* name, and it exists
 * so a move tool's own refusals never fall through to
 * `resolveWriteTarget`'s `validateWriteSegment`, whose message is allowed to
 * quote the segment for tool-misuse debugging.
 */
function rejectTraversalShapedInput(tool, field, value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("..") ||
    value.includes("/") ||
    value.includes("\\")
  ) {
    throw new Error(
      `${tool}: \`${field}\` must be a non-empty path segment with no ".." or path separators`,
    )
  }
}

// ── Handles ──────────────────────────────────────────────────────────────
//
// A handle (desk/handles.js) names a folder without its name, so a task or
// track whose name carries a secret's value can be renamed without the caller
// ever reading, passing or seeing the old name. It is resolved inside this
// session's own desk only.

function taskMoveSource(deskRoot, person, values) {
  if (values.handle === undefined) {
    if (!Object.hasOwn(values, "track") || !Object.hasOwn(values, "slug")) {
      throw new Error("task_move: `track` and `slug` are required, or `handle` in their place")
    }
    return { track: values.track, slug: values.slug }
  }
  if (Object.hasOwn(values, "track") || Object.hasOwn(values, "slug")) {
    throw new Error("task_move: pass `handle` or `track` and `slug`, not both")
  }
  const source = resolveTaskHandle(deskRoot, personPrefix(deskRoot, person), values.handle)
  if (source === null) throw new Error(handleMiss("task_move", "task"))
  return source
}

function trackRenameSource(deskRoot, person, values) {
  if (values.handle === undefined) {
    if (!Object.hasOwn(values, "track")) {
      throw new Error("track_rename: `track` is required, or `handle` in its place")
    }
    return values.track
  }
  if (Object.hasOwn(values, "track")) {
    throw new Error("track_rename: pass `handle` or `track`, not both")
  }
  const track = resolveTrackHandle(deskRoot, personPrefix(deskRoot, person), values.handle)
  if (track === null) throw new Error(handleMiss("track_rename", "track"))
  return track
}

function handleMiss(tool, kind) {
  return (
    `${tool}: no ${kind} in this session's desk has that handle. A handle is \`${kind}-\` and ten hex characters, ` +
    "and it changes when the folder moves; take a fresh one from desk_status (active_tasks) or desk_doctor"
  )
}

// ── Git plumbing ─────────────────────────────────────────────────────────
//
// `spawnGit` is an injectable seam over `node:child_process`'s `spawnSync`,
// for tests only — real callers never pass it (mirrors `desk/naming.js`'s
// `spawnGitConfig`). The shared helpers live in `util/git-stage.js`.

/**
 * Refuse to touch a path another session may be working in (M4-5 fix rounds
 * 2-4): on a Git desk, the moved folder, or a `track.md` whose tasks table
 * the move would edit, with unstaged changes to tracked files or untracked,
 * non-ignored files is left alone unless the caller passes
 * `allow_dirty: true`. Staged changes don't count: the move tools and the
 * track tools stage everything they write, so a staged change is the
 * current tidy's own work in progress (fix round 4). The message never
 * quotes the path's names.
 */
function assertClean({ tool, root, paths, what, allowDirty, spawnGit }) {
  if (allowDirty || !isGitRepository(root, spawnGit)) return
  if (hasUnstagedWork(root, paths.map((p) => relPath(root, p)), spawnGit)) {
    throw new Error(
      `${tool}: ${what} has unstaged changes or untracked files, so another session may be working there; ` +
        "commit or finish that work first, or pass allow_dirty: true to move it anyway",
    )
  }
}

/**
 * Stage every file a move wrote after its `git mv` (the moved card, the
 * edited `track.md` tables), so a later move in the same tidy sees them as
 * this tidy's work, not another session's. A no-op on a non-Git desk.
 */
function stageWrites({ root, files, spawnGit }) {
  if (files.length === 0 || !isGitRepository(root, spawnGit)) return
  const result = stagePaths(root, files.map((p) => relPath(root, p)), spawnGit)
  if (!result.ok) {
    throw new Error(redactCredentialLikeText(`desk-mcp: git add failed staging the move's edits: ${result.stderr}`))
  }
}

/**
 * Commit everything a move touched (M4-6 Part 2): the moved directories
 * (already staged by `movePath`'s own `git mv`, so they are only named
 * here, never re-`git add`ed — `git add` on an already-fully-staged,
 * now-gone directory fails with "did not match any files", but `git commit
 * -- <pathspec>` still matches the staged rename by index content) plus
 * whatever `stageWrites` staged on top (the patched card, the edited
 * `track.md` tables). A no-op on a non-Git desk. Never throws: a commit
 * failure comes back as this function's return value, which a caller
 * attaches to its result under `commit` only on failure, so a normal,
 * silent success stays byte-identical to today's response shape.
 */
function commitMove({ root, movedDirs, writtenFiles, message, spawnGit }) {
  if (!isGitRepository(root, spawnGit)) return undefined
  const relPaths = [...new Set([...movedDirs, ...writtenFiles].map((p) => relPath(root, p)))]
  const committed = commitPaths(root, relPaths, message, spawnGit)
  return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
}

/**
 * Move `from` to `to` (both absolute paths under `root`). Stages the move
 * with `git add` (so an uncommitted/untracked source is picked up) then
 * `git mv` when `root` is a Git repository; a plain `fs.rename` otherwise.
 * Never commits.
 */
async function movePath({ root, from, to, spawnGit }) {
  // A move that fails leaves no empty destination folder behind.
  await withCreatedDirs(path.dirname(to), () => moveInto({ root, from, to, spawnGit }))
}

async function moveInto({ root, from, to, spawnGit }) {
  if (!isGitRepository(root, spawnGit)) {
    await fs.rename(from, to)
    return
  }

  const relFrom = relPath(root, from)
  const relTo = relPath(root, to)

  const addResult = spawnGit("git", ["-C", root, "add", "-A", "--", relFrom], {
    encoding: "utf8",
  })
  if (addResult.status !== 0) {
    throw new Error(redactCredentialLikeText(`desk-mcp: git add failed staging ${shownPath(relFrom)}: ${addResult.stderr}`))
  }

  const mvResult = spawnGit("git", ["-C", root, "mv", relFrom, relTo], {
    encoding: "utf8",
  })
  if (mvResult.status !== 0) {
    throw new Error(redactCredentialLikeText(`desk-mcp: git mv failed moving ${shownPath(relFrom)} to ${shownPath(relTo)}: ${mvResult.stderr}`))
  }
}

// ── "## Tasks" table maintenance (best-effort — see module doc) ────────────

function findTasksTableBounds(lines) {
  const headingIdx = lines.findIndex((line) => /^##\s+Tasks\s*$/.test(line.trim()))
  if (headingIdx === -1) return null

  let cursor = headingIdx + 1
  while (cursor < lines.length && lines[cursor].trim() === "") cursor += 1
  if (cursor >= lines.length || !lines[cursor].trim().startsWith("|")) return null

  const sepIdx = cursor + 1
  if (sepIdx >= lines.length || !/^\|?[\s:|-]+\|?$/.test(lines[sepIdx].trim())) return null

  let rowEnd = sepIdx + 1
  while (rowEnd < lines.length && lines[rowEnd].trim().startsWith("|")) rowEnd += 1

  return { rowStart: sepIdx + 1, rowEnd }
}

function rowSlugCell(rowLine) {
  const cells = rowLine.split("|")
  return cells[1].trim().replace(/^`/, "").replace(/`$/, "")
}

function findRowIndex(lines, bounds, slug) {
  for (let idx = bounds.rowStart; idx < bounds.rowEnd; idx += 1) {
    if (rowSlugCell(lines[idx]) === slug) return idx
  }
  return -1
}

function renameRowSlug(rowLine, newSlug) {
  const cells = rowLine.split("|")
  const original = cells[1].trim()
  const hadBackticks = original.startsWith("`") && original.endsWith("`")
  cells[1] = ` ${hadBackticks ? `\`${newSlug}\`` : newSlug} `
  return cells.join("|")
}

/**
 * Open `trackMdPath`'s "## Tasks" table, hand its lines + bounds to
 * `mutate`, and persist the result if `mutate` reports a change.
 * No-ops (returns `{ changed: false }`) when the file doesn't exist or has
 * no "## Tasks" pipe table — this is a dashboard convenience, not a source
 * of truth, so a track.md that doesn't follow the recommended template is
 * left untouched rather than corrupted.
 */
async function editTasksTable(trackMdPath, mutate) {
  if (!(await pathExists(trackMdPath))) return { changed: false }
  const existing = await readMarkdown(trackMdPath)
  const lines = existing.content.split("\n")
  const bounds = findTasksTableBounds(lines)
  if (!bounds) return { changed: false }

  const result = mutate(lines, bounds)
  if (!result.changed) return { changed: false }

  const merged = { ...existing.data, updated: nowIso() }
  await writeMarkdown(trackMdPath, merged, lines.join("\n"))
  return result
}

// ── Task-card discovery (for track_rename) ──────────────────────────────────

async function findTaskCards(dir) {
  const found = []
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(path.join(current, entry.name))
        continue
      }
      if (entry.name === "task.md") {
        found.push(path.join(current, entry.name))
      }
    }
  }
  await walk(dir)
  found.sort()
  return found
}

// ── Mentions report ─────────────────────────────────────────────────────────

/**
 * Other `.md` files under `root` whose text still contains `oldRelPath`
 * (the moved item's pre-move path, relative to `root`, POSIX-separated).
 * Never rewritten — only reported. `exclude` skips the files this move
 * already touched, so a rewritten frontmatter field can't self-report.
 */
async function findMentions({ root, oldRelPath, exclude }) {
  const mentions = []
  async function walk(current) {
    const entries = await fs.readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        await walk(abs)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      if (exclude.has(abs)) continue
      const text = await fs.readFile(abs, "utf8")
      if (text.includes(oldRelPath)) mentions.push(abs)
    }
  }
  await walk(root)
  mentions.sort()
  return mentions.map((abs) => relPath(root, abs))
}

// ── task_move ────────────────────────────────────────────────────────────

/**
 * A new "## Tasks" row for `slug`, shaped by the table's header row: the
 * slug in backticks, `state` in the second column when there is one, and
 * every other cell empty.
 */
function buildRow(headerLine, slug, state) {
  const columns = headerLine.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").length
  const cells = [`\`${slug}\``, state, ...Array(Math.max(columns - 2, 0)).fill("")].slice(0, columns)
  return `| ${cells.join(" | ")} |`
}

/** The date an iteration folder is named after: the card's `created` day, or today. */
function iterationDate(created) {
  const parsed = created instanceof Date ? created : new Date(String(created))
  return Number.isNaN(parsed.getTime()) ? nowIso().slice(0, 10) : parsed.toISOString().slice(0, 10)
}

function trueOrAbsent(tool, field, value) {
  if (value !== undefined && typeof value !== "boolean") {
    throw new Error(`${tool}: \`${field}\` must be true or false`)
  }
  return value === true
}

/**
 * task_move
 *
 * Input: { track, slug, to_track?, to_slug?, unarchive?, into_task?, allow_dirty? }
 *
 * Moves `<track>/<slug>/` (or, if the task is archived,
 * `<track>/_archive/<slug>/`) to `<to_track ?? track>/<to_slug ?? slug>/`
 * (staying archived if it started archived). Refuses if the target already
 * exists, if `to_slug` isn't a valid outcome name (M4-1's `validateName` —
 * only checked when renaming; an unchanged slug is never re-validated), if
 * `to_track` isn't a valid track name (M4-1's `validateTrackName` — same
 * rule, only checked when the destination track differs from the source),
 * or if that destination track doesn't already exist (its `track.md` must
 * be present — a move never creates a track implicitly). Sets `track:` on
 * the moved card, and best-effort moves its row between the two `track.md`
 * "## Tasks" tables (or renames the row in place, for a same-track rename).
 *
 * `unarchive: true` (M4-5) reopens an archived task: it moves
 * `<track>/_archive/<slug>/` back to a live `<to_track ?? track>/<to_slug ??
 * slug>/` and makes sure the destination table has a row for it — the
 * source row moved or renamed when there is one, a new row (slug and the
 * card's status) otherwise. It never changes the card's status.
 *
 * On a Git desk it refuses a source folder, or a `track.md` whose tasks
 * table it would edit, with unstaged changes or untracked, non-ignored files
 * (another session may be working there) unless `allow_dirty: true` (M4-5),
 * and it stages every file it writes, so its own earlier edits never block
 * a later move in the same tidy. `into_task` refuses to merge a live task
 * into a done or cancelled one.
 *
 * `into_task: "<keeper>"` (M4-5) merges a duplicate task into the task that
 * keeps the job: it moves the task folder to
 * `<to_track ?? track>/<keeper>/_iterations/<created-date>-<slug>/`, renames
 * its card to `merged-task.md` there (so it is history, not a second task
 * card), records `merged_into:` on it, and drops its row from the source
 * table. Nothing is deleted. It cannot be combined with `to_slug` or
 * `unarchive`.
 *
 * On a Git desk it also commits exactly the paths it wrote — the moved
 * directory and any `track.md` tables it edited — right after staging them
 * (M4-6 Part 2). A commit failure never loses the move: it comes back as
 * `commit: { status: "failed", reason }` on the result, omitted entirely on
 * a normal, silent success or on a non-Git desk.
 *
 * Returns: { from, to, updated_files, mentions, commit? }
 */
export async function task_move({ deskRoot, input, person = null, readiness, statusContext = {}, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  const { track, slug } = taskMoveSource(deskRoot, person, values)
  rejectTraversalShapedInput("task_move", "track", track)
  rejectTraversalShapedInput("task_move", "slug", slug)
  const unarchive = trueOrAbsent("task_move", "unarchive", values.unarchive)
  const allowDirty = trueOrAbsent("task_move", "allow_dirty", values.allow_dirty)
  const intoTask = values.into_task
  if (intoTask !== undefined) {
    rejectTraversalShapedInput("task_move", "into_task", intoTask)
    if (values.to_slug !== undefined || unarchive) {
      throw new Error("task_move: `into_task` cannot be combined with `to_slug` or `unarchive`")
    }
  }

  const toTrack = values.to_track ?? track
  const toSlug = values.to_slug ?? slug

  if (intoTask === slug && toTrack === track) {
    throw new Error("task_move: a task cannot be merged into itself")
  }

  if (values.to_slug !== undefined) {
    const nameResult = validateName(toSlug)
    if (!nameResult.ok) {
      throw new Error(`task_move: invalid to_slug: ${describeNameRejection(nameResult)}`)
    }
  }

  const target = (segments) => resolveWriteTarget({ deskRoot, person, segments })

  let destTrackMd = null
  if (values.to_track !== undefined) {
    const trackNameResult = validateTrackName(toTrack, { operatorNames: operatorNames(deskRoot) })
    if (!trackNameResult.ok) {
      throw new Error(`task_move: invalid to_track: ${describeNameRejection(trackNameResult)}`)
    }
    destTrackMd = await target([toTrack, "track.md"])
    if (!(await pathExists(destTrackMd))) {
      throw new Error(
        "task_move: the destination track doesn't exist; create it first with track_create (a scope line is required)",
      )
    }
  }

  const liveSrcFile = await target([track, slug, "task.md"])
  const archivedSrcFile = await target([track, "_archive", slug, "task.md"])

  let archived
  if (unarchive) {
    if (!(await pathExists(archivedSrcFile))) {
      throw new Error(
        `task_move: no archived task to unarchive at ${shownRelPath(deskRoot, path.dirname(archivedSrcFile))}`,
      )
    }
    archived = true
  } else if (await pathExists(liveSrcFile)) {
    archived = false
  } else if (await pathExists(archivedSrcFile)) {
    archived = true
  } else {
    throw new Error(
      `task_move: task does not exist at ${shownRelPath(deskRoot, path.dirname(liveSrcFile))}`,
    )
  }

  const srcSegments = archived ? [track, "_archive", slug] : [track, slug]
  const srcDir = await target(srcSegments)
  const srcCard = await readMarkdown(path.join(srcDir, "task.md"))

  let destSegments
  if (intoTask !== undefined) {
    if (!(await pathExists(await target([toTrack, intoTask, "task.md"])))) {
      throw new Error(
        `task_move: the task to merge into doesn't exist at ${shownRelPath(deskRoot, await target([toTrack, intoTask]))}`,
      )
    }
    // Never hide a live task behind a finished one (M4-5 fix round 3).
    const keeper = await readMarkdown(await target([toTrack, intoTask, "task.md"]))
    if (!TERMINAL_STATUSES.has(srcCard.data.status) && TERMINAL_STATUSES.has(keeper.data.status)) {
      throw new Error(
        "task_move: this task is still live but the task to merge into is done or cancelled; " +
          "keep the live task (merge the finished one into it instead) or skip the merge",
      )
    }
    destSegments = [toTrack, intoTask, "_iterations", `${iterationDate(srcCard.data.created)}-${slug}`]
  } else {
    destSegments = archived && !unarchive ? [toTrack, "_archive", toSlug] : [toTrack, toSlug]
  }
  const destDir = await target(destSegments)
  const cardName = intoTask === undefined ? "task.md" : "merged-task.md"
  const destFile = await target([...destSegments, cardName])

  if (await pathExists(destDir)) {
    throw new Error(`task_move: target already exists at ${shownRelPath(deskRoot, destDir)}`)
  }

  const srcTrackMd = await target([track, "track.md"])
  destTrackMd ??= await target([toTrack, "track.md"])
  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  assertClean({ tool: "task_move", root: effectiveRoot, paths: [srcDir], what: "the source", allowDirty, spawnGit })
  assertClean({
    tool: "task_move",
    root: effectiveRoot,
    paths: [srcTrackMd, destTrackMd],
    what: "a track.md this move would edit",
    allowDirty,
    spawnGit,
  })
  await movePath({ root: effectiveRoot, from: srcDir, to: destDir, spawnGit })
  if (intoTask !== undefined) {
    await movePath({ root: effectiveRoot, from: path.join(destDir, "task.md"), to: destFile, spawnGit })
  }

  // `movePath` above already relocated the file with its original bytes
  // intact; patch only the fields this move actually changes so every other
  // byte — quoting, date formats, block scalars, key order — survives.
  const patchFields = { track: toTrack, updated: nowIso() }
  if (intoTask !== undefined) patchFields.merged_into = intoTask
  await patchMarkdownFrontmatter(destFile, patchFields)

  const updatedFiles = [relPath(deskRoot, destFile)]
  const touched = new Set([destFile])

  touched.add(srcTrackMd)
  touched.add(destTrackMd)

  if (intoTask !== undefined) {
    const removed = await editTasksTable(srcTrackMd, (lines, bounds) => {
      const idx = findRowIndex(lines, bounds, slug)
      if (idx === -1) return { changed: false }
      lines.splice(idx, 1)
      return { changed: true }
    })
    if (removed.changed) updatedFiles.push(relPath(deskRoot, srcTrackMd))
  } else if (track === toTrack) {
    // A same-track move that isn't an unarchive is a rename: reaching here
    // with `toSlug === slug` would mean destDir === srcDir, which the
    // target-exists check above already refused.
    const result = await editTasksTable(srcTrackMd, (lines, bounds) => {
      const idx = findRowIndex(lines, bounds, slug)
      if (idx !== -1) {
        if (toSlug === slug) return { changed: false }
        lines[idx] = renameRowSlug(lines[idx], toSlug)
        return { changed: true }
      }
      if (!unarchive) return { changed: false }
      lines.splice(bounds.rowEnd, 0, buildRow(lines[bounds.rowStart - 2], toSlug, srcCard.data.status))
      return { changed: true }
    })
    if (result.changed) updatedFiles.push(relPath(deskRoot, srcTrackMd))
  } else {
    let row = null
    const removed = await editTasksTable(srcTrackMd, (lines, bounds) => {
      const idx = findRowIndex(lines, bounds, slug)
      if (idx === -1) return { changed: false }
      const [rowLine] = lines.splice(idx, 1)
      return { changed: true, row: rowLine }
    })
    if (removed.changed) {
      row = removed.row
      updatedFiles.push(relPath(deskRoot, srcTrackMd))
    }
    if (row !== null || unarchive) {
      const inserted = await editTasksTable(destTrackMd, (lines, bounds) => {
        const newRow = row === null
          ? buildRow(lines[bounds.rowStart - 2], toSlug, srcCard.data.status)
          : renameRowSlug(row, toSlug)
        lines.splice(bounds.rowEnd, 0, newRow)
        return { changed: true }
      })
      if (inserted.changed) updatedFiles.push(relPath(deskRoot, destTrackMd))
    }
  }

  const writtenFiles = updatedFiles.map((p) => path.join(deskRoot, p))
  stageWrites({
    root: effectiveRoot,
    files: writtenFiles,
    spawnGit,
  })
  const commit = commitMove({
    root: effectiveRoot,
    movedDirs: [srcDir, destDir],
    writtenFiles,
    message: `task_move: ${slug} → ${toTrack}`,
    spawnGit,
  })
  if (commit === undefined && isGitRepository(effectiveRoot, spawnGit)) schedulePush({ root: deskRoot })

  const mentions = await findMentions({
    root: effectiveRoot,
    oldRelPath: relPath(effectiveRoot, srcDir),
    exclude: touched,
  })

  await recordCanonicalChanges({
    root: deskRoot,
    readiness,
    changes: [
      { path: relPath(deskRoot, srcDir), operation: "delete" },
      ...updatedFiles.map((p) => ({ path: p, operation: "write" })),
    ],
  })

  const result = {
    from: shownRelPath(deskRoot, srcDir),
    to: shownRelPath(deskRoot, destDir),
    updated_files: updatedFiles.map(shownPath),
    mentions: mentions.map(shownPath),
  }
  if (commit) result.commit = commit
  // The held focus follows the card it names (a merge follows into the card that keeps the job); with nothing
  // focused, a task tool call carries the no-focus hint until the session declares. A different focus is left alone.
  const focus = statusContext.focus
  const current = focus?.get() ?? null
  if (current !== null && current.track === track && current.slug === slug) {
    focus.set({ track: toTrack, slug: intoTask ?? toSlug })
  } else {
    const note = focusNote(statusContext)
    if (note !== undefined) result.focus_note = note
  }
  return result
}

// ── track_rename ─────────────────────────────────────────────────────────

/**
 * track_rename
 *
 * Input: { track, to, allow_dirty? }
 *
 * Moves `<track>/` to `<to>/`. Refuses if the target already exists, or if
 * `to` isn't a valid track name (M4-1's `validateTrackName`), or, on a Git
 * desk, if the track has unstaged changes or untracked, non-ignored files,
 * unless `allow_dirty: true`. Rewrites `track:` in every `task.md` under the
 * moved tree, live and archived, and stages those edits on a Git desk, then
 * commits exactly the paths it wrote — the moved directory and every
 * rewritten task.md — right after (M4-6 Part 2). A commit failure never
 * loses the rename: it comes back as `commit: { status: "failed", reason }`
 * on the result, omitted entirely on a normal, silent success or on a
 * non-Git desk.
 *
 * Returns: { from, to, updated_files, mentions, commit? }
 */
export async function track_rename({ deskRoot, input, person = null, readiness, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  if (!Object.hasOwn(values, "to")) {
    throw new Error("track_rename: `to` is required, with `track` or `handle`")
  }
  const { to } = values
  const track = trackRenameSource(deskRoot, person, values)
  rejectTraversalShapedInput("track_rename", "track", track)
  const allowDirty = trueOrAbsent("track_rename", "allow_dirty", values.allow_dirty)

  const nameResult = validateTrackName(to, { operatorNames: operatorNames(deskRoot) })
  if (!nameResult.ok) {
    throw new Error(`track_rename: invalid to: ${describeNameRejection(nameResult)}`)
  }

  const target = (segments) => resolveWriteTarget({ deskRoot, person, segments })
  const srcTrackMd = await target([track, "track.md"])
  const srcDir = await target([track])
  const destDir = await target([to])

  if (!(await pathExists(srcTrackMd))) {
    throw new Error(`track_rename: track does not exist at ${shownRelPath(deskRoot, srcDir)}`)
  }
  if (await pathExists(destDir)) {
    throw new Error(`track_rename: target already exists at ${shownRelPath(deskRoot, destDir)}`)
  }

  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  assertClean({ tool: "track_rename", root: effectiveRoot, paths: [srcDir], what: "the source", allowDirty, spawnGit })
  await movePath({ root: effectiveRoot, from: srcDir, to: destDir, spawnGit })

  const taskFiles = await findTaskCards(destDir)
  const updatedFiles = []
  for (const file of taskFiles) {
    // Patch only `track:`/`updated:` in place: every other byte of each
    // card — quoting, date formats, block scalars, key order — survives.
    await patchMarkdownFrontmatter(file, { track: to, updated: nowIso() })
    updatedFiles.push(relPath(deskRoot, file))
  }
  stageWrites({ root: effectiveRoot, files: taskFiles, spawnGit })
  const commit = commitMove({
    root: effectiveRoot,
    movedDirs: [srcDir, destDir],
    writtenFiles: taskFiles,
    message: `track_rename: ${track} → ${to}`,
    spawnGit,
  })
  if (commit === undefined && isGitRepository(effectiveRoot, spawnGit)) schedulePush({ root: deskRoot })

  const mentions = await findMentions({
    root: effectiveRoot,
    oldRelPath: relPath(effectiveRoot, srcDir),
    exclude: new Set([path.join(destDir, "track.md"), ...taskFiles]),
  })

  await recordCanonicalChanges({
    root: deskRoot,
    readiness,
    changes: [
      { path: relPath(deskRoot, srcDir), operation: "delete" },
      ...updatedFiles.map((p) => ({ path: p, operation: "write" })),
    ],
  })

  const result = {
    from: shownRelPath(deskRoot, srcDir),
    to: shownRelPath(deskRoot, destDir),
    updated_files: updatedFiles.map(shownPath),
    mentions: mentions.map(shownPath),
  }
  if (commit) result.commit = commit
  return result
}
