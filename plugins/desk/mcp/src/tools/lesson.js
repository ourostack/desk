// lesson_add — write/append a lesson under `<root>/_meta/tips/<topic>.md`.
//
// Per `plugins/desk/skills/lesson-capture/SKILL.md`, lessons are agent-driven
// post-task captures. We write one file per topic slug; subsequent calls with
// the same topic append `## Update <date>` sections so the file accumulates
// without losing prior content.
//
// On a Git desk, stages exactly what it wrote and commits exactly those
// paths right after, synchronously in the call (M4-6 Part 2); pushing is a
// later part.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { findFilenameEquivalent, today, slugify, pathExists } from "../util/fm.js"
import { resolveWriteTarget } from "../util/paths.js"
import { isGitRepository, hasUnstagedWork, stagePaths, commitPaths } from "../util/git-stage.js"
import { recordCanonicalChanges } from "../readiness/journal.js"

function relPath(deskRoot, absPath) {
  return path.relative(deskRoot, absPath)
}

async function availableLessonPath(canonicalName, resolveCandidate) {
  let candidateName = `_${canonicalName}`
  let candidatePath = await resolveCandidate(candidateName)
  while (await findFilenameEquivalent(candidatePath, resolveCandidate)) {
    candidateName = `_${candidateName}`
    candidatePath = await resolveCandidate(candidateName)
  }
  return candidatePath
}

async function lessonPathMatches(filePath, topicSlug) {
  const [firstLine] = (await fs.readFile(filePath, "utf8")).split(/\r?\n/u)
  return firstLine.startsWith("# ") && slugify(firstLine.slice(2)) === topicSlug
}

// Decides where this call writes, and whether that requires first renaming
// an existing, differently-named file onto it — but performs neither the
// rename nor the write itself, so the caller can check the *pre-rename*
// path's Git status (M4-6 Part 2: a file this call is about to rename away
// from is the one that might hold another session's untracked work; the
// rename's destination, by construction, never already exists as a lesson
// for this topic).
async function decideLessonPath({ directory, topicSlug, canonicalPath, resolveCandidate }) {
  const canonicalName = path.basename(canonicalPath)
  const canonicalExistingPath = await findFilenameEquivalent(canonicalPath, resolveCandidate)
  const canonicalExists = canonicalExistingPath !== null
  if (canonicalExistingPath && await lessonPathMatches(canonicalExistingPath, topicSlug)) {
    return { filePath: canonicalExistingPath, renameFrom: null }
  }
  const names = (await fs.readdir(directory, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort()
  const matches = []
  for (const name of names) {
    const candidate = path.join(directory, name)
    if (await lessonPathMatches(candidate, topicSlug)) {
      matches.push(name)
    }
  }
  if (matches.length > 0) {
    const match = matches[0]
    const matchedPath = path.join(directory, match)
    if (!match.startsWith("_") && slugify(path.basename(match, ".md")) === topicSlug) {
      const destination = canonicalExists
        ? await availableLessonPath(canonicalName, resolveCandidate)
        : canonicalPath
      return { filePath: destination, renameFrom: matchedPath }
    }
    return { filePath: matchedPath, renameFrom: null }
  }
  return {
    filePath: canonicalExists ? await availableLessonPath(canonicalName, resolveCandidate) : canonicalPath,
    renameFrom: null,
  }
}

// On a Git desk, lesson_add stages what it wrote — the lesson file, plus the
// path it renamed away from when housekeeping moved an existing file onto
// the canonical name — only when that pre-rename identity held no unstaged
// changes beforehand, then commits exactly those paths (M4-6 Part 2). A
// bare `git add -- <old> <new>` stages a rename the same way `fs.rename`
// itself doesn't tell Git about (mirrors task.js's task_archive). `spawnGit`
// is a test-only seam over `spawnSync`.
function stagingAllowed(filePath, spawnGit) {
  const dir = path.dirname(filePath)
  return isGitRepository(dir, spawnGit) && !hasUnstagedWork(dir, [path.basename(filePath)], spawnGit)
}

// A stage failure (e.g. a concurrent call holding .git/index.lock) leaves
// nothing to commit, and neither it nor a commit failure ever throws away
// the write or the tool's own result — either comes back as this function's
// return value, which the caller attaches to its result under `commit` only
// on failure, so a normal, silent success stays byte-identical to today's
// response shape.
function stageAndCommitLesson(root, paths, message, spawnGit) {
  const relPaths = paths.map((p) => path.relative(root, p))
  const staged = stagePaths(root, relPaths, spawnGit)
  if (!staged.ok) return { status: "failed", reason: staged.stderr }
  const committed = commitPaths(root, relPaths, message, spawnGit)
  return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
}

/**
 * lesson_add
 *
 * Input:
 *   {
 *     topic: string,    // human-readable; gets slugified for the filename
 *     body: string,     // markdown body
 *   }
 *
 * Side effects: writes `<root>/_meta/tips/<topic-slug>.md`. If the file
 * exists, appends an `## Update <YYYY-MM-DD>` section + the new body. May
 * first rename an existing, differently-named file for the same topic onto
 * this path (housekeeping, not a caller-visible move).
 *
 * On a Git desk, stages what it wrote — plus any rename above — when the
 * file it renamed from (or, with no rename, the file it wrote) held no
 * unstaged changes beforehand, and commits exactly those paths right after
 * (M4-6 Part 2). A commit failure never loses the write: it comes back as
 * `commit: { status: "failed", reason }` on the result, omitted entirely on
 * a normal, silent success, when the file was already dirty, or on a
 * non-Git desk.
 *
 * Returns: { status: "added", path, commit? }
 */
export async function lesson_add({ deskRoot, input, person = null, readiness, spawnGit = spawnSync }) {
  const values = input ?? {}
  const { topic, body } = values
  if (!topic || typeof topic !== "string") {
    throw new Error("lesson_add: `topic` is required (string)")
  }
  if (!body || typeof body !== "string") {
    throw new Error("lesson_add: `body` is required (string)")
  }

  const topicSlug = slugify(topic)
  if (!topicSlug) {
    throw new Error("lesson_add: `topic` slugified to empty string")
  }

  let filePath = await resolveWriteTarget({
    deskRoot,
    person,
    segments: ["_meta", "tips", `${topicSlug}.md`],
  })
  const directory = path.dirname(filePath)
  const resolveCandidate = (name) => resolveWriteTarget({
    deskRoot,
    person,
    segments: ["_meta", "tips", name],
  })
  await fs.mkdir(directory, { recursive: true })
  const decided = await decideLessonPath({
    directory,
    topicSlug,
    canonicalPath: filePath,
    resolveCandidate,
  })
  filePath = decided.filePath
  const { renameFrom } = decided

  // Checked against the pre-rename identity, before either this call's own
  // housekeeping rename or its content write.
  const stage = stagingAllowed(renameFrom ?? filePath, spawnGit)

  if (renameFrom !== null) {
    await fs.rename(renameFrom, filePath)
    await recordCanonicalChanges({ root: deskRoot, readiness, changes: [
      { path: relPath(deskRoot, renameFrom), operation: "delete" },
      { path: relPath(deskRoot, filePath), operation: "write" },
    ] })
  }

  const trimmedBody = body.endsWith("\n") ? body : `${body}\n`
  if (await pathExists(filePath)) {
    const existing = await fs.readFile(filePath, "utf8")
    const sep = existing.endsWith("\n") ? "" : "\n"
    const update = `${existing}${sep}\n## Update ${today()}\n\n${trimmedBody}`
    await fs.writeFile(filePath, update, "utf8")
  } else {
    // Initial write: include a top-level heading derived from the topic.
    const header = `# ${topic}\n\n`
    await fs.writeFile(filePath, `${header}${trimmedBody}`, "utf8")
  }

  const commit = stage
    ? stageAndCommitLesson(
        path.dirname(filePath),
        renameFrom !== null ? [filePath, renameFrom] : [filePath],
        `lesson_add: ${topicSlug}`,
        spawnGit,
      )
    : undefined

  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  const result = { status: "added", path: relPath(deskRoot, filePath) }
  if (commit) result.commit = commit
  return result
}
