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
// (Desk, its skills, the factory): the entry is written, and then an
// improvement card opens by itself, with no signoff. The card is its own
// committed write; the entry names the card's key, which carries the
// friction fingerprint. Nothing leaves the machine until the loop's mirror
// step. `file_card: true` files the factory store's kaizen issue
// immediately (`src/factory/kaizen-file.js`, which routes, dedupes and caps
// it) and a short record of the outcome is appended to the desk.
//
// On a Git desk, stages the file it wrote and commits exactly that file
// right after, synchronously in the call (M4-6 Part 2); pushing is a later
// part.

import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { findFilenameEquivalent, today, slugify, pathExists } from "../util/fm.js"
import { deskRelativePath, resolveWriteTarget, personPrefix } from "../util/paths.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { stagingAllowed, stageAndCommitFile, writeCardCommitted, cardCommitMessage } from "./_card-commit.js"
import { cardKey, openImprovement } from "../desk/improvement-cards.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { FRICTION_CLASSES, fileKaizenCard, fingerprintOf } from "../factory/kaizen-file.js"
import { PATTERNS } from "../factory/schema.js"
import { factoryStateRoot } from "../factory/outbox.js"

const ABOUT = new Set(["setup", "system"])

// Every field friction_add reads off `input`, kept next to the handler so a
// field added to its reads below is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const FRICTION_ADD_FIELDS = [
  "track",
  "theme",
  "body",
  "about",
  "file_card",
  "title",
  "plugin",
  "friction_class",
  "signal",
  "evidence_jobs",
]

function relPath(deskRoot, absPath) {
  return deskRelativePath(deskRoot, absPath)
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

const OPENED_CODES = new Set(["opened", "duplicate", "reopened"])

// The friction fingerprint, or null when this machine has no factory state. The check never creates the state.
async function fingerprintIfReady(env, deskRoot, card) {
  try {
    if ((await factoryStateRoot(env, { create: false, deskRoot })) === null) return null
    return await fingerprintOf(env, { plugin: card.plugin, frictionClass: card.frictionClass, title: card.title })
  } catch {
    return null
  }
}

// Opens (or finds, or reopens) the improvement card for system friction, as its own committed write after the friction
// entry. Never throws: the entry is already written, so every failure is a stable code on the result. The library builds
// the card's title from fixed words; the card holds the key (which carries the fingerprint), the plugin, the signal and
// the evidence jobs as pointers, and nothing of the note.
async function openCard({ deskRoot, person, card, fingerprint, now, commitCard, spawnGit, schedulePush }) {
  if (fingerprint === null) return { improvement: "factory_state_unavailable" }
  const prefix = deskRelativePath(deskRoot, personPrefix(deskRoot, person))
  const key = cardKey("friction_candidate", fingerprint)
  const evidence = Array.isArray(card.evidenceJobs) ? card.evidenceJobs.map((job) => `job:${job}`) : []
  try {
    const { result, commit } = await commitCard({
      deskRoot,
      personPrefix: prefix,
      message: (written) => cardCommitMessage("friction", written.file_name ?? "set_aside"),
      spawnGit,
      schedulePush,
      write: () => openImprovement({ deskRoot, personPrefix: prefix, key, source: "friction_candidate", evidence, plugin: card.plugin, signal: card.signal, now }),
    })
    const out = { improvement: result.result }
    if (OPENED_CODES.has(result.result) && commit !== "committed" && commit !== "no_change" && commit !== "no_files") out.improvement_commit = commit
    return out
  } catch {
    return { improvement: "card_write_failed" }
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
 *     file_card?: true,  // "system": also file the store's kaizen issue now (the immediate mirror)
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
 * For system friction the improvement card is opened after the entry is written (the key is the friction fingerprint, so a
 * retry never opens a second card; a closed card with the key is reopened), as a second, separate committed write; the
 * result gains `improvement`: "opened" | "duplicate" | "reopened" or the card library's refusal code (for example
 * `not_generic`), or `factory_state_unavailable` (no machine secret, so no fingerprint) or `card_write_failed`; and
 * `improvement_commit` when the card was written but not committed. A refused or failed card never loses the entry.
 * The call behaves the same in a noninteractive session; only picking a card up is refused there.
 *
 * Returns: { status: "added", path, commit? }; { status: "added", path,
 * kaizen: "candidate", commit? } for system friction; with `file_card`,
 * { status: "filed", path, url, kaizen: "filed" | "duplicate", commit? } or
 * { status: "added", path, kaizen: <code>, commit? } when the card was not
 * filed.
 */
export async function friction_add({ deskRoot, input, person = null, readiness, env = process.env, now, fileCard = fileKaizenCard, commitCard = writeCardCommitted, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
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

  const fingerprint = card === null ? null : await fingerprintIfReady(env, deskRoot, card)
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
    entry = `${body.trimEnd()}\n\nSystem friction: "${card.title}"; plugin \`${card.plugin}\`, class \`${card.frictionClass}\`, measure ${measure}, evidence jobs ${jobs}.`
  }

  // The card's key carries the fingerprint, so the note names it: the agent that picks the card up finds the note by it.
  if (fingerprint !== null) entry = `${entry.trimEnd()}\n\nImprovement card key: \`friction_candidate:${fingerprint}\`.`
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
    ? stageAndCommitFile(filePath, `friction_add: ${values.plugin ?? "desk-plugin"}`, spawnGit)
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
  if (card !== null) Object.assign(result, await openCard({ deskRoot, person, card, fingerprint, now, commitCard, spawnGit, schedulePush }))
  return result
}
