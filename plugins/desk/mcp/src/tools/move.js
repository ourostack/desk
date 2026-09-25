// Cheap moves — task_move, track_rename.
//
// Both move a folder (via `git mv` semantics when the desk is a Git
// repository, a plain rename otherwise), touch the small set of frontmatter
// fields that record ownership (`track:` on a moved/reparented task card),
// and best-effort keep each `track.md`'s "## Tasks" table in sync. Neither
// tool ever rewrites free text elsewhere — it only reports, in `mentions`,
// other text files under the desk that still mention the old relative path,
// so the agent (or the operator) can fix them if they matter. Neither
// commits; staging (or a plain rename on a non-Git desk) is as far as this
// goes, matching M4-1's "channels never commits" carry-in.

import { promises as fs } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import {
  nowIso,
  readMarkdown,
  writeMarkdown,
  pathExists,
} from "../util/fm.js"
import { resolveWriteTarget, personPrefix } from "../util/paths.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import {
  validateName,
  validateTrackName,
  operatorNames,
  describeNameRejection,
} from "../desk/naming.js"

const SKIP_DIRS = new Set(["node_modules", ".git", ".state"])

function relPath(root, absPath) {
  return path.relative(root, absPath)
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

// ── Git plumbing ─────────────────────────────────────────────────────────
//
// `spawnGit` is an injectable seam over `node:child_process`'s `spawnSync`,
// for tests only — real callers never pass it (mirrors `desk/naming.js`'s
// `spawnGitConfig`).

function isGitRepository(root, spawnGit) {
  let result
  try {
    result = spawnGit("git", ["-C", root, "rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
    })
  } catch {
    return false
  }
  return result.status === 0 && result.stdout.trim() === "true"
}

/**
 * Move `from` to `to` (both absolute paths under `root`). Stages the move
 * with `git add` (so an uncommitted/untracked source is picked up) then
 * `git mv` when `root` is a Git repository; a plain `fs.rename` otherwise.
 * Never commits.
 */
async function movePath({ root, from, to, spawnGit }) {
  await fs.mkdir(path.dirname(to), { recursive: true })

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
    throw new Error(`desk-mcp: git add failed staging ${relFrom}: ${addResult.stderr}`)
  }

  const mvResult = spawnGit("git", ["-C", root, "mv", relFrom, relTo], {
    encoding: "utf8",
  })
  if (mvResult.status !== 0) {
    throw new Error(`desk-mcp: git mv failed moving ${relFrom} to ${relTo}: ${mvResult.stderr}`)
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
 * task_move
 *
 * Input: { track, slug, to_track?, to_slug? }
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
 * Returns: { from, to, updated_files, mentions }
 */
export async function task_move({ deskRoot, input, person = null, readiness, spawnGit = spawnSync }) {
  const values = input ?? {}
  if (!Object.hasOwn(values, "track") || !Object.hasOwn(values, "slug")) {
    throw new Error("task_move: `track` and `slug` are required")
  }
  const { track, slug } = values
  rejectTraversalShapedInput("task_move", "track", track)
  rejectTraversalShapedInput("task_move", "slug", slug)

  const toTrack = values.to_track ?? track
  const toSlug = values.to_slug ?? slug

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
  if (await pathExists(liveSrcFile)) {
    archived = false
  } else if (await pathExists(archivedSrcFile)) {
    archived = true
  } else {
    throw new Error(
      `task_move: task does not exist at ${relPath(deskRoot, path.dirname(liveSrcFile))}`,
    )
  }

  const srcSegments = archived ? [track, "_archive", slug] : [track, slug]
  const destSegments = archived ? [toTrack, "_archive", toSlug] : [toTrack, toSlug]
  const srcDir = await target(srcSegments)
  const destDir = await target(destSegments)
  const destFile = await target([...destSegments, "task.md"])

  if (await pathExists(destDir)) {
    throw new Error(`task_move: target already exists at ${relPath(deskRoot, destDir)}`)
  }

  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  await movePath({ root: effectiveRoot, from: srcDir, to: destDir, spawnGit })

  const existingCard = await readMarkdown(destFile)
  const mergedCard = { ...existingCard.data, track: toTrack, updated: nowIso() }
  await writeMarkdown(destFile, mergedCard, existingCard.content)

  const updatedFiles = [relPath(deskRoot, destFile)]
  const touched = new Set([destFile])

  const srcTrackMd = await target([track, "track.md"])
  destTrackMd ??= await target([toTrack, "track.md"])
  touched.add(srcTrackMd)
  touched.add(destTrackMd)

  if (track === toTrack) {
    // Reaching here with `toSlug === slug` would mean destDir === srcDir,
    // which the target-exists check above already refused — so a rename is
    // the only way to get this far on a same-track move.
    const result = await editTasksTable(srcTrackMd, (lines, bounds) => {
      const idx = findRowIndex(lines, bounds, slug)
      if (idx === -1) return { changed: false }
      lines[idx] = renameRowSlug(lines[idx], toSlug)
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
    if (row !== null) {
      const inserted = await editTasksTable(destTrackMd, (lines, bounds) => {
        lines.splice(bounds.rowEnd, 0, renameRowSlug(row, toSlug))
        return { changed: true }
      })
      if (inserted.changed) updatedFiles.push(relPath(deskRoot, destTrackMd))
    }
  }

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

  return {
    from: relPath(deskRoot, srcDir),
    to: relPath(deskRoot, destDir),
    updated_files: updatedFiles,
    mentions,
  }
}

// ── track_rename ─────────────────────────────────────────────────────────

/**
 * track_rename
 *
 * Input: { track, to }
 *
 * Moves `<track>/` to `<to>/`. Refuses if the target already exists, or if
 * `to` isn't a valid track name (M4-1's `validateTrackName`). Rewrites
 * `track:` in every `task.md` under the moved tree, live and archived.
 *
 * Returns: { from, to, updated_files, mentions }
 */
export async function track_rename({ deskRoot, input, person = null, readiness, spawnGit = spawnSync }) {
  const values = input ?? {}
  if (!Object.hasOwn(values, "track") || !Object.hasOwn(values, "to")) {
    throw new Error("track_rename: `track` and `to` are required")
  }
  const { track, to } = values
  rejectTraversalShapedInput("track_rename", "track", track)

  const nameResult = validateTrackName(to, { operatorNames: operatorNames(deskRoot) })
  if (!nameResult.ok) {
    throw new Error(`track_rename: invalid to: ${describeNameRejection(nameResult)}`)
  }

  const target = (segments) => resolveWriteTarget({ deskRoot, person, segments })
  const srcTrackMd = await target([track, "track.md"])
  const srcDir = await target([track])
  const destDir = await target([to])

  if (!(await pathExists(srcTrackMd))) {
    throw new Error(`track_rename: track does not exist at ${relPath(deskRoot, srcDir)}`)
  }
  if (await pathExists(destDir)) {
    throw new Error(`track_rename: target already exists at ${relPath(deskRoot, destDir)}`)
  }

  const effectiveRoot = path.resolve(personPrefix(deskRoot, person))
  await movePath({ root: effectiveRoot, from: srcDir, to: destDir, spawnGit })

  const taskFiles = await findTaskCards(destDir)
  const updatedFiles = []
  for (const file of taskFiles) {
    const existing = await readMarkdown(file)
    const merged = { ...existing.data, track: to, updated: nowIso() }
    await writeMarkdown(file, merged, existing.content)
    updatedFiles.push(relPath(deskRoot, file))
  }

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

  return {
    from: relPath(deskRoot, srcDir),
    to: relPath(deskRoot, destDir),
    updated_files: updatedFiles,
    mentions,
  }
}
