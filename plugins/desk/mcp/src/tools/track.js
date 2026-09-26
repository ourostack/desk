// Runtime CRUD tools for `track.md` cards — track_create, track_update.
//
// On-disk layout: `<root>/<slug>/track.md`. Schema documented in
// `plugins/desk/skills/track-card-format/SKILL.md` (schema_version 1).

import * as path from "node:path"
import { spawnSync } from "node:child_process"
import {
  nowIso,
  readMarkdown,
  writeMarkdown,
  pathExists,
} from "../util/fm.js"
import { resolveWriteTarget } from "../util/paths.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { isGitRepository, hasUnstagedWork, stagePaths } from "../util/git-stage.js"
import {
  validateTrackName,
  validateScope,
  operatorNames,
  describeNameRejection,
} from "../desk/naming.js"

// Optional fields a caller may supply at create time.
const OPTIONAL_TRACK_FIELDS = [
  "predecessor",
  "adopted_from",
  "planning",
]

function relPath(deskRoot, absPath) {
  return path.relative(deskRoot, absPath)
}

// On a Git desk, a track tool stages the track.md it writes (M4-5 fix round
// 4), so the move tools treat that write as the current tidy's work in
// progress rather than another session's. It stages only a file that held
// no unstaged changes before the write, so it never adopts another
// session's edit. Staging is best-effort: if `git add` fails the write still
// stands, and a later move refuses that track.md, which is the safe side.
// `spawnGit` is a test-only seam over `spawnSync`.
function stagingAllowed(filePath, spawnGit) {
  const dir = path.dirname(filePath)
  return isGitRepository(dir, spawnGit) && !hasUnstagedWork(dir, [path.basename(filePath)], spawnGit)
}

function stageTrackCard(filePath, spawnGit) {
  stagePaths(path.dirname(filePath), [path.basename(filePath)], spawnGit)
}

/**
 * track_create
 *
 * Input:
 *   {
 *     slug: string,        // required — validated, see Errors
 *     title: string,       // required
 *     scope: string,       // required — one line, at most 240 characters,
 *                          // in the form "<what belongs>; not <what doesn't>"
 *     status?: string,     // default "active"
 *     body?: string,
 *     ...optional fields per track-card schema
 *   }
 *
 * Side effects: creates `<root>/<slug>/track.md` (and parent dir), and
 * stages it on a Git desk.
 *
 * Errors:
 *   - refuses if `<root>/<slug>/track.md` already exists.
 *   - refuses `slug` that isn't a valid outcome name per `validateTrackName`
 *     (see `desk/naming.js`): wrong shape, too long, prompt-like,
 *     credential-like, a catch-all name, or named after the operator.
 *   - refuses a missing or invalid `scope` per `validateScope`.
 *
 * Returns: { status: "created", path }
 */
export async function track_create({ deskRoot, input, person = null, readiness, spawnGit = spawnSync }) {
  const values = input ?? {}
  const { slug, title } = values
  if (!Object.hasOwn(values, "slug")) {
    throw new Error("track_create: `slug` is required (string)")
  }
  if (!title || typeof title !== "string") {
    throw new Error("track_create: `title` is required (string)")
  }

  const filePath = await resolveWriteTarget({
    deskRoot,
    person,
    segments: [slug, "track.md"],
  })

  // Path/segment/alias safety (above) is a tool-misuse concern and takes
  // precedence over naming/scope content rules, which are business rules
  // evaluated once the target path itself is known-safe.
  const nameResult = validateTrackName(slug, {
    operatorNames: operatorNames(deskRoot),
  })
  if (!nameResult.ok) {
    throw new Error(
      `track_create: invalid slug: ${describeNameRejection(nameResult)}`,
    )
  }

  const scopeResult = validateScope(values.scope)
  if (!scopeResult.ok) {
    throw new Error(`track_create: invalid \`scope\`: ${scopeResult.hint}`)
  }

  if (await pathExists(filePath)) {
    throw new Error(
      `track_create: track already exists at ${relPath(deskRoot, filePath)}`,
    )
  }

  const ts = nowIso()
  const data = {
    schema_version: 1,
    title,
    status: values.status ?? "active",
    created: ts,
    updated: ts,
    scope: values.scope,
  }
  for (const k of OPTIONAL_TRACK_FIELDS) {
    if (values[k] !== undefined) data[k] = values[k]
  }

  await writeMarkdown(filePath, data, values.body ?? "")
  if (isGitRepository(path.dirname(filePath), spawnGit)) stageTrackCard(filePath, spawnGit)
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  return { status: "created", path: relPath(deskRoot, filePath) }
}

/**
 * track_update
 *
 * Input:
 *   {
 *     slug: string,
 *     frontmatter?: object,  // may set `scope` — validated, see Errors;
 *                            // `slug` itself is never re-validated, so an
 *                            // update to a track named before these rules
 *                            // existed still works
 *     body_append?: string,
 *   }
 *
 * Side effects: rewrites `<root>/<slug>/track.md` in place, and on a Git
 * desk stages it when it held no unstaged changes before the write.
 *
 * Preserves: `schema_version`, `created`. Always refreshes `updated`.
 *
 * Errors:
 *   - refuses if the track doesn't exist.
 *   - refuses an invalid `frontmatter.scope` per `validateScope`, when the
 *     caller sets it; an update that doesn't touch `scope` is unaffected.
 *
 * Returns: { status: "updated", path }
 */
export async function track_update({ deskRoot, input, person = null, readiness, spawnGit = spawnSync }) {
  const values = input ?? {}
  const { slug, frontmatter, body_append } = values
  if (!Object.hasOwn(values, "slug")) {
    throw new Error("track_update: `slug` is required")
  }

  if (frontmatter && Object.hasOwn(frontmatter, "scope")) {
    const scopeResult = validateScope(frontmatter.scope)
    if (!scopeResult.ok) {
      throw new Error(`track_update: invalid \`scope\`: ${scopeResult.hint}`)
    }
  }

  const filePath = await resolveWriteTarget({
    deskRoot,
    person,
    segments: [slug, "track.md"],
  })
  if (!(await pathExists(filePath))) {
    throw new Error(
      `track_update: track does not exist at ${relPath(deskRoot, filePath)}`,
    )
  }

  const existing = await readMarkdown(filePath)
  const merged = { ...existing.data, ...(frontmatter ?? {}) }

  if (existing.data.schema_version !== undefined) {
    merged.schema_version = existing.data.schema_version
  } else {
    merged.schema_version = 1
  }
  if (existing.data.created !== undefined) {
    merged.created = existing.data.created
  }
  merged.updated = nowIso()

  let newBody = existing.content
  if (typeof body_append === "string" && body_append.length > 0) {
    const sep = newBody.endsWith("\n\n") || newBody.length === 0 ? "" : "\n\n"
    newBody = `${newBody}${sep}${body_append}`
  }

  const stage = stagingAllowed(filePath, spawnGit)
  await writeMarkdown(filePath, merged, newBody)
  if (stage) stageTrackCard(filePath, spawnGit)
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  return { status: "updated", path: relPath(deskRoot, filePath) }
}
