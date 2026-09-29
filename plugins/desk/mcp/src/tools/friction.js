// friction_add — append a friction entry to the operator's friction log.
//
// Two scopes per `plugins/desk/skills/friction-management/SKILL.md`:
//   - Cross-cutting (no `track`):  `<root>/_meta/friction.md`
//   - Track-local (with `track`):  `<root>/<track>/_friction/<YYYY-MM-DD>-<theme>.md`
//
// Both are append-only; if the file already exists, the new entry is
// appended with a separator (no rewriting of prior entries — see the skill's
// "never delete, never rewrite" rule).
//
// `about` says what the friction is about: `setup` (the default) is this
// desk's own setup and stays on the desk; `system` is the shared system
// (Desk, its skills, the factory) and is recorded on the desk as a kaizen
// candidate: the entry plus the structured fields a card needs. Nothing
// leaves the machine then. A card is filed only by the curator, after its
// signoff step, with `file_card: true`: the desk write target is resolved
// and its folder created first, then the card is filed in the desk's
// factory store (`src/factory/kaizen-file.js`, which routes, dedupes and
// caps it), and a short record of the outcome is appended to the desk.
//
// On a Git desk, stages the file it wrote and commits exactly that file
// right after, synchronously in the call (M4-6 Part 2); pushing is a later
// part.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { findFilenameEquivalent, today, slugify, pathExists } from "../util/fm.js"
import { resolveWriteTarget } from "../util/paths.js"
import { isGitRepository, hasUnstagedWork, stagePaths, commitPaths } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { FRICTION_CLASSES, fileKaizenCard } from "../factory/kaizen-file.js"
import { PATTERNS } from "../factory/schema.js"

const ABOUT = new Set(["setup", "system"])

function relPath(deskRoot, absPath) {
  return path.relative(deskRoot, absPath)
}

function trackFrictionIdentity(themeSlug) {
  return `<!-- desk-friction:v2 theme=${themeSlug} -->`
}

// On a Git desk, friction_add stages the file it writes (new or appended-to)
// only when it held no unstaged changes before this write, so a dirty or
// untracked friction file left by another session is never adopted as this
// call's own work — mirrors track.js/task.js's identically named helper.
// `spawnGit` is a test-only seam over `spawnSync`.
function stagingAllowed(filePath, spawnGit) {
  const dir = path.dirname(filePath)
  return isGitRepository(dir, spawnGit) && !hasUnstagedWork(dir, [path.basename(filePath)], spawnGit)
}

// After staging, commits exactly the one file staged (M4-6 Part 2: every
// write tool commits its own paths synchronously; push is a later part).
// A stage failure (e.g. a concurrent call holding .git/index.lock) leaves
// nothing to commit, and neither it nor a commit failure ever throws away
// the write or the tool's own result — either comes back as this function's
// return value, which the caller attaches to its result under `commit` only
// on failure, so a normal, silent success stays byte-identical to today's
// response shape.
function stageAndCommitFriction(filePath, message, spawnGit) {
  const dir = path.dirname(filePath)
  const basename = path.basename(filePath)
  const staged = stagePaths(dir, [basename], spawnGit)
  if (!staged.ok) return { status: "failed", reason: staged.stderr }
  const committed = commitPaths(dir, [basename], message, spawnGit)
  return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
}

async function resolveTrackFrictionPath({ deskRoot, person, track, themeSlug }) {
  const date = today()
  const identity = trackFrictionIdentity(themeSlug)
  let fileSlug = themeSlug
  const resolveCandidate = (name) => resolveWriteTarget({
    deskRoot,
    person,
    segments: [track, "_friction", name],
  })
  while (true) {
    const filePath = await resolveCandidate(`${date}-${fileSlug}.md`)
    const existingPath = await findFilenameEquivalent(filePath, resolveCandidate)
    if (!existingPath) return { filePath, identity }
    const [firstLine] = (await fs.readFile(existingPath, "utf8")).split(/\r?\n/u)
    if (firstLine === identity) return { filePath: existingPath, identity }
    fileSlug = `_${fileSlug}`
  }
}

/**
 * friction_add
 *
 * Input:
 *   {
 *     track?: string,    // omit for cross-cutting; include for track-local
 *     theme?: string,    // short slug for the track-local filename; defaults "untitled"
 *     body: string,      // the entry body (without surrounding `---` separators)
 *     about?: "setup" | "system",  // default "setup"; "system" records a kaizen candidate
 *     title?: string,    // required for "system": the card's title
 *     plugin?: string,   // "system": the plugin the friction is in; default "desk"
 *     friction_class?: string,  // "system": one of FRICTION_CLASSES; default "other"
 *     signal?: string,   // "system": the rollups measure the friction moves, when known
 *     evidence_jobs?: string[],  // "system": factory job ids that show it, when known
 *     file_card?: true,  // "system", curator only, after signoff: file the card now
 *   }
 *
 * Side effects: appends to the resolved friction file. Track-local files begin
 * with an identity comment so lossy legacy filenames cannot absorb unrelated
 * entries. Creates parent dirs + the file itself if missing. Adds a leading
 * `---` separator between entries (and a trailing newline) so future entries
 * land cleanly.
 *
 * On a Git desk, also stages the file it wrote — when it held no unstaged
 * changes before this write — and commits exactly that file right after
 * (M4-6 Part 2). A commit failure never loses the write: it comes back as
 * `commit: { status: "failed", reason }` on the result, omitted entirely on
 * a normal, silent success, when the file was already dirty, or on a
 * non-Git desk.
 *
 * Returns: { status: "added", path, commit? }; { status: "added", path,
 * kaizen: "candidate", commit? } for system friction; with `file_card`,
 * { status: "filed", path, url, kaizen: "filed" | "duplicate", commit? } or
 * { status: "added", path, kaizen: <code>, commit? } when the card was not
 * filed.
 */
export async function friction_add({ deskRoot, input, person = null, readiness, env = process.env, fileCard = fileKaizenCard, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const values = input ?? {}
  const { track, theme } = values
  const { body } = values
  if (!body || typeof body !== "string") {
    throw new Error("friction_add: `body` is required (string)")
  }
  const about = values.about ?? "setup"
  if (!ABOUT.has(about)) throw new Error("friction_add: `about` must be \"setup\" or \"system\"")
  const fileNow = values.file_card === true
  if (values.file_card !== undefined && values.file_card !== false && !fileNow) throw new Error("friction_add: `file_card` must be true or false")
  if (fileNow && about !== "system") throw new Error("friction_add: `file_card` is only for system friction")
  let card = null
  if (about === "system") {
    if (typeof values.title !== "string" || values.title.trim() === "" || /[\r\n]/u.test(values.title)) throw new Error("friction_add: `title` is required for system friction, on one line")
    const plugin = values.plugin ?? "desk"
    if (typeof plugin !== "string" || !PATTERNS.pluginName.test(plugin)) throw new Error("friction_add: `plugin` must be a plugin name")
    const frictionClass = values.friction_class ?? "other"
    if (!FRICTION_CLASSES.includes(frictionClass)) throw new Error(`friction_add: \`friction_class\` must be one of ${FRICTION_CLASSES.join(", ")}`)
    card = { title: values.title.trim(), plugin, frictionClass, signal: values.signal ?? null, evidenceJobs: values.evidence_jobs ?? [] }
  }

  let filePath
  let identity = null
  if (typeof track === "string" && track.length > 0) {
    const themeSlug = slugify(theme) || "untitled"
    const resolved = await resolveTrackFrictionPath({
      deskRoot,
      person,
      track,
      themeSlug,
    })
    filePath = resolved.filePath
    identity = resolved.identity
  } else {
    filePath = await resolveWriteTarget({
      deskRoot,
      person,
      segments: ["_meta", "friction.md"],
    })
  }

  // The desk write must be possible before anything is filed.
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  // Checked once the parent dir exists (a brand-new track's `_friction/`
  // folder may not, yet) and before this call's own write, so it reads only
  // whether another session already left this file dirty.
  const stage = stagingAllowed(filePath, spawnGit)

  let filed = null
  let entry = body
  if (card !== null && fileNow) {
    filed = await fileCard(env, { deskRoot, title: card.title, body, plugin: card.plugin, frictionClass: card.frictionClass, signal: card.signal, evidenceJobs: card.evidenceJobs })
    entry = filed.result === "filed" || filed.result === "duplicate"
      ? `Kaizen card for "${card.title}": ${filed.result === "filed" ? "filed" : "already open"} at ${filed.url}`
      : `Kaizen card for "${card.title}": not filed (${filed.result}); it stays a candidate.`
  } else if (card !== null) {
    const measure = card.signal === null ? "not chosen" : `\`${card.signal}\``
    const jobs = Array.isArray(card.evidenceJobs) && card.evidenceJobs.length > 0 ? card.evidenceJobs.join(", ") : "none yet"
    entry = `${body.trimEnd()}\n\nKaizen candidate for the curator: "${card.title}"; plugin \`${card.plugin}\`, class \`${card.frictionClass}\`, measure ${measure}, evidence jobs ${jobs}.`
  }

  const trimmedBody = entry.endsWith("\n") ? entry : `${entry}\n`
  if (await pathExists(filePath)) {
    // Append with a separator so each entry is visually distinct.
    const existing = await fs.readFile(filePath, "utf8")
    const sep = existing.endsWith("\n") ? "" : "\n"
    await fs.writeFile(
      filePath,
      `${existing}${sep}\n---\n\n${trimmedBody}`,
      "utf8",
    )
  } else {
    const initial = identity ? `${identity}\n\n${trimmedBody}` : trimmedBody
    await fs.writeFile(filePath, initial, "utf8")
  }

  const commit = stage
    ? stageAndCommitFriction(filePath, `friction_add: ${values.plugin ?? "desk-plugin"}`, spawnGit)
    : undefined
  if (stage && !commit) schedulePush({ root: deskRoot })

  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  const written = relPath(deskRoot, filePath)
  let result
  if (card === null) {
    result = { status: "added", path: written }
  } else if (filed === null) {
    result = { status: "added", path: written, kaizen: "candidate" }
  } else if (filed.result === "filed" || filed.result === "duplicate") {
    result = { status: "filed", path: written, url: filed.url, kaizen: filed.result }
  } else {
    result = { status: "added", path: written, kaizen: filed.result }
  }
  if (commit) result.commit = commit
  return result
}
