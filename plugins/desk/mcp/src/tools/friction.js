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
// (Desk, its skills, the factory) and becomes a kaizen card in the desk's
// factory store (`src/factory/kaizen-file.js`). A filed card leaves only its
// URL on the desk; a card that could not be filed leaves the entry on the
// desk with the reason, for the kaizen worker to file later.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { findFilenameEquivalent, today, slugify, pathExists } from "../util/fm.js"
import { resolveWriteTarget } from "../util/paths.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { fileKaizenCard } from "../factory/kaizen-file.js"

const ABOUT = new Set(["setup", "system"])

function relPath(deskRoot, absPath) {
  return path.relative(deskRoot, absPath)
}

function trackFrictionIdentity(themeSlug) {
  return `<!-- desk-friction:v2 theme=${themeSlug} -->`
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
 *     about?: "setup" | "system",  // default "setup"; "system" files a kaizen card
 *     title?: string,    // required for "system": the card's generic title
 *     signal?: string,   // "system": the rollups measure the friction moves, when known
 *     evidence_jobs?: string[],  // "system": factory job ids that show it, when known
 *   }
 *
 * Side effects: appends to the resolved friction file. Track-local files begin
 * with an identity comment so lossy legacy filenames cannot absorb unrelated
 * entries. Creates parent dirs + the file itself if missing. Adds a leading
 * `---` separator between entries (and a trailing newline) so future entries
 * land cleanly.
 *
 * Returns: { status: "added", path }, { status: "filed", url, path } when a
 * kaizen card was filed, or { status: "added", path, kaizen: <code> } when
 * system friction could not be filed.
 */
export async function friction_add({ deskRoot, input, person = null, readiness, env = process.env, fileCard = fileKaizenCard }) {
  const values = input ?? {}
  const { track, theme } = values
  let { body } = values
  if (!body || typeof body !== "string") {
    throw new Error("friction_add: `body` is required (string)")
  }
  const about = values.about ?? "setup"
  if (!ABOUT.has(about)) throw new Error("friction_add: `about` must be \"setup\" or \"system\"")
  let filed = null
  if (about === "system") {
    if (typeof values.title !== "string" || values.title.trim() === "") throw new Error("friction_add: `title` is required for system friction")
    filed = await fileCard(env, { deskRoot, title: values.title, body, signal: values.signal ?? null, evidenceJobs: values.evidence_jobs ?? [] })
    body = filed.result === "filed"
      ? `Filed as a kaizen card: ${filed.url}`
      : `${body.trimEnd()}\n\nNot filed as a kaizen card yet (${filed.result}). Title: ${values.title.trim()}`
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

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const trimmedBody = body.endsWith("\n") ? body : `${body}\n`
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

  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  const written = relPath(deskRoot, filePath)
  if (filed === null) return { status: "added", path: written }
  if (filed.result === "filed") return { status: "filed", url: filed.url, path: written }
  return { status: "added", path: written, kaizen: filed.result }
}
