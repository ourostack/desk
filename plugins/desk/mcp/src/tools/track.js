// Runtime CRUD tools for `track.md` cards — track_create, track_update.
//
// On-disk layout: `<root>/<slug>/track.md`. Schema documented in
// `plugins/desk/skills/track-card-format/SKILL.md` (schema_version 1).

import * as path from "node:path"
import {
  nowIso,
  readMarkdown,
  writeMarkdown,
  pathExists,
} from "../util/fm.js"
import { resolveWriteTarget } from "../util/paths.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
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

/**
 * track_create
 *
 * Input:
 *   {
 *     slug: string,        // required
 *     title: string,       // required
 *     status?: string,     // default "active"
 *     body?: string,
 *     ...optional fields per track-card schema
 *   }
 *
 * Side effects: creates `<root>/<slug>/track.md` (and parent dir).
 *
 * Errors: refuses if `<root>/<slug>/track.md` already exists.
 *
 * Returns: { status: "created", path }
 */
export async function track_create({ deskRoot, input, person = null, readiness }) {
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
      `track_create: invalid slug: ${describeNameRejection(slug, nameResult)}`,
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
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  return { status: "created", path: relPath(deskRoot, filePath) }
}

/**
 * track_update
 *
 * Input:
 *   {
 *     slug: string,
 *     frontmatter?: object,
 *     body_append?: string,
 *   }
 *
 * Side effects: rewrites `<root>/<slug>/track.md` in place.
 *
 * Preserves: `schema_version`, `created`. Always refreshes `updated`.
 *
 * Errors: refuses if the track doesn't exist.
 *
 * Returns: { status: "updated", path }
 */
export async function track_update({ deskRoot, input, person = null, readiness }) {
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

  await writeMarkdown(filePath, merged, newBody)
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  return { status: "updated", path: relPath(deskRoot, filePath) }
}
