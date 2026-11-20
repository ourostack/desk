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
import { unfinishedNext } from "../util/route-around.js"
import { cardKey, openImprovement } from "../desk/improvement-cards.js"
import { FRICTION_CLASSES, fileKaizenCard, fingerprintOf } from "../factory/kaizen-file.js"
import { PATTERNS } from "../factory/schema.js"
import { OWNED_TOOLS, fileToolIssue, ownedToolFor } from "../factory/tool-issue-file.js"
import { factoryStateRoot } from "../factory/outbox.js"
import { failureEvidence } from "../runtime/failure-evidence.js"

const ISSUE_FIXES = {
  not_generic: "the repo is public, so take credentials, home paths and email addresses out of `title` and `body`, then call again",
  invalid_title: "`title` must be one line of at most 120 characters, then call again",
  invalid_body: "`body` must hold the evidence and be at most 8000 characters, then call again",
  no_suitable_account: "sign in to GitHub with an account that can open issues on that repo, then call again",
}

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
  "error_code",
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
// the card's title from fixed words, or for a lesson from its owner and topic; the card holds the key (which carries the
// fingerprint), the plugin, the signal and the evidence jobs as pointers, and nothing of the note. The result names the
// card it opened or found, by key and desk-relative path, so the caller can point at it.
async function openCard({ deskRoot, person, card, fingerprint, lesson, now, commitCard, spawnGit, schedulePush }) {
  if (fingerprint === null) return { improvement: "factory_state_unavailable" }
  const prefix = deskRelativePath(deskRoot, personPrefix(deskRoot, person))
  const key = cardKey("friction_candidate", fingerprint)
  const evidence = Array.isArray(card.evidenceJobs) ? card.evidenceJobs.map((job) => `job:${job}`) : []
  try {
    const { result, commit, route_around: routeAround } = await commitCard({
      deskRoot,
      personPrefix: prefix,
      message: (written) => cardCommitMessage("friction", written.file_name ?? "set_aside"),
      spawnGit,
      schedulePush,
      write: () => openImprovement({ deskRoot, personPrefix: prefix, key, source: "friction_candidate", lesson, evidence, plugin: card.plugin, signal: card.signal, now }),
    })
    const out = { improvement: result.result }
    if (OPENED_CODES.has(result.result) && typeof result.file_name === "string") Object.assign(out, { improvement_key: key, improvement_path: path.posix.join(prefix, "_meta", "improvement", result.file_name) })
    if (OPENED_CODES.has(result.result) && commit !== "committed" && commit !== "no_change" && commit !== "no_files") {
      out.improvement_commit = commit
      if (routeAround) {
        out.improvement_route_around = routeAround
        return { next: unfinishedNext(routeAround, "improvement_route_around"), ...out }
      }
    }
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
 *     error_code?: string,  // the code of a Desk failure line: the one call that reports it. Defaults `about` to "system" and `title` to "Desk error <code>", makes `body` optional, and appends the failure's evidence (its message and stack, the Desk version, host, desk path and recent sync status, credentials redacted) to the entry on the desk
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
 * `improvement_commit` when the card was written but not committed; an opened, found or reopened card is named by
 * `improvement_key` and `improvement_path` (desk-relative). `lesson: { owner, topic }` (lesson_add's own call) titles
 * the card from the lesson. A refused or failed card never loses the entry.
 * The call behaves the same in a noninteractive session; only picking a card up is refused there.
 *
 * System friction about a tool owned in ourostack files a GitHub issue on that tool's repo for its drain
 * (`src/factory/tool-issue-file.js`): `plugin` defaults to "desk", and `desk-*` names and `superpowers` are Desk's repo. The title
 * and `body` are the issue, so the body carries the evidence. Desk's own parts also keep the improvement card; the other
 * tools get the issue alone. The result gains `issue` ("filed" | "known"), `issue_url` and `repo`. A `plugin` that names no
 * owned tool gains `issue: "unknown_tool"` and `issue_next`, which names the argument that files it. A filing that fails
 * writes the entry (with the paste-ready text), then throws `friction_add_issue_not_filed`. `error_code` reports and a
 * `fileIssue` of `null` (a caller that must not file, such as lesson_add) file nothing.
 *
 * Returns: { status: "added", path, commit? }; { status: "added", path,
 * kaizen: "candidate", commit? } for system friction; with `file_card`,
 * { status: "filed", path, url, kaizen: "filed" | "duplicate", commit? } or
 * { status: "added", path, kaizen: <code>, commit? } when the card was not
 * filed.
 */
export async function friction_add({ deskRoot, input, person = null, search, env = process.env, now, fileCard = fileKaizenCard, fileIssue = fileToolIssue, commitCard = writeCardCommitted, spawnGit = spawnSync, schedulePush = schedulePushDefault, lesson }) {
  const values = input ?? {}
  const { track, theme } = values
  const errorCode = values.error_code
  if (errorCode !== undefined && (typeof errorCode !== "string" || !/^[a-z][a-z0-9_]*$/u.test(errorCode))) {
    throw Object.assign(new Error("friction_add: Pass `error_code` as the code a Desk failure line gave: `error_code` must be the code a Desk failure line gave in its friction_add call, such as desk_push_blocked"), { code: "friction_add_error_code_must_be_the" })
  }
  const reporting = errorCode !== undefined
  if (!reporting && (!values.body || typeof values.body !== "string")) {
    throw Object.assign(new Error("friction_add: Pass `body` as a string: `body` is required (string)"), { code: "friction_add_body_is_required_string" })
  }
  if (reporting && values.body !== undefined && typeof values.body !== "string") throw Object.assign(new Error("friction_add: Pass `body` as a string: `body` must be a string"), { code: "friction_add_body_must_be_a_string" })
  const body = reporting ? [values.body?.trim(), failureEvidence({ code: errorCode, deskRoot, env })].filter(Boolean).join("\n\n") : values.body
  const about = values.about ?? (reporting ? "system" : "setup")
  if (!ABOUT.has(about)) throw Object.assign(new Error("friction_add: Pass `about` as \"setup\" or \"system\": `about` must be \"setup\" or \"system\""), { code: "friction_add_about_must_be_setup_or" })
  const fileNow = values.file_card === true
  if (values.file_card !== undefined && values.file_card !== false && !fileNow) throw Object.assign(new Error("friction_add: Pass `file_card` as true or false: `file_card` must be true or false"), { code: "friction_add_file_card_must_be_true" })
  if (fileNow && about !== "system") throw Object.assign(new Error("friction_add: Drop `file_card`, or set `about` to \"system\": `file_card` is only for system friction"), { code: "friction_add_file_card_is_only_for" })
  let card = null
  if (about === "system") {
    const title = values.title ?? (reporting ? `Desk error ${errorCode}` : undefined)
    if (typeof title !== "string" || title.trim() === "" || /[\r\n]/u.test(title)) throw Object.assign(new Error("friction_add: Pass `title`: `title` is required for system friction, on one line"), { code: "friction_add_title_is_required_for_system" })
    const plugin = values.plugin ?? "desk"
    if (typeof plugin !== "string" || !PATTERNS.pluginName.test(plugin)) throw Object.assign(new Error("friction_add: Pass `plugin` as a plugin name: `plugin` must be a plugin name"), { code: "friction_add_plugin_must_be_a_plugin" })
    const frictionClass = values.friction_class ?? "other"
    if (!FRICTION_CLASSES.includes(frictionClass)) throw Object.assign(new Error(`friction_add: Pass \`friction_class\` as one of the listed values: \`friction_class\` must be one of ${FRICTION_CLASSES.join(", ")}`), { code: "friction_add_friction_class_must_be_one" })
    card = { title: title.trim(), plugin, frictionClass, signal: values.signal ?? null, evidenceJobs: values.evidence_jobs ?? [] }
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

  // Friction about a tool owned in ourostack (Desk included) becomes an issue on that tool's repo, where its drain reads it.
  // Desk's own parts also keep their improvement card; the other tools get the issue alone.
  const tool = card !== null && !reporting && fileIssue !== null ? ownedToolFor(card.plugin) : null
  const keepsCard = card !== null && (tool === null || tool === "desk" || tool === "superpowers")
  const fingerprint = card === null || !keepsCard ? null : await fingerprintIfReady(env, deskRoot, card)
  let filed = null
  let issue = null
  let entry = body
  if (keepsCard && fileNow) {
    filed = await fileCard(env, { deskRoot, title: card.title, body, plugin: card.plugin, frictionClass: card.frictionClass, signal: card.signal, evidenceJobs: card.evidenceJobs })
    entry = filed.result === "filed" || filed.result === "duplicate"
      ? `Kaizen card for "${card.title}": ${filed.result === "filed" ? "filed" : "already open"} at ${filed.url}`
      : `Kaizen card for "${card.title}": not filed (${filed.result}); it stays a candidate.`
  } else if (keepsCard) {
    const measure = card.signal === null ? "not chosen" : `\`${card.signal}\``
    const jobs = Array.isArray(card.evidenceJobs) && card.evidenceJobs.length > 0 ? card.evidenceJobs.join(", ") : "none yet"
    entry = `${body.trimEnd()}\n\nSystem friction: "${card.title}"; plugin \`${card.plugin}\`, class \`${card.frictionClass}\`, measure ${measure}, evidence jobs ${jobs}.`
  }
  if (tool !== null) {
    issue = await fileIssue(env, { tool, title: card.title, body })
    const ok = issue.result === "filed" || issue.result === "known"
    const line = ok
      ? `Issue for "${card.title}" on ${issue.repo}: ${issue.result === "filed" ? "filed" : "already open, new evidence added"} at ${issue.url}`
      : `Issue for "${card.title}" on ${issue.repo ?? tool}: not filed (${issue.reason ?? issue.result}); file it by hand with the text below.\n\n${issue.body ?? body}`
    entry = keepsCard ? `${entry.trimEnd()}\n\n${line}` : line
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
    ? stageAndCommitFile(filePath, `friction_add: ${values.plugin ?? "desk-plugin"}`, spawnGit, deskRoot)
    : undefined
  if (stage && !commit) schedulePush({ root: deskRoot })

  search?.noteChange(relPath(deskRoot, filePath))
  const written = relPath(deskRoot, filePath)
  let result
  if (card === null) {
    result = { status: "added", path: written }
  } else if (keepsCard && filed === null) {
    result = { status: "added", path: written, kaizen: "candidate" }
  } else if (keepsCard && (filed.result === "filed" || filed.result === "duplicate")) {
    result = { status: "filed", path: written, url: filed.url, kaizen: filed.result }
  } else if (keepsCard) {
    result = { status: "added", path: written, kaizen: filed.result }
  } else {
    result = { status: issue.url ? "filed" : "added", path: written }
  }
  if (issue !== null) Object.assign(result, issue.url ? { issue: issue.result, issue_url: issue.url, repo: issue.repo } : { issue: issue.reason ?? issue.result, repo: issue.repo })
  if (issue?.url) {
    result.status = "filed"
    if (!keepsCard) result.url = issue.url
  }
  if (card !== null && !reporting && fileIssue !== null && tool === null) {
    result.issue = "unknown_tool"
    result.issue_next = `Not filed as an issue: Desk does not know a tool called \`${card.plugin}\`. Pass \`plugin\` as one of ${Object.keys(OWNED_TOOLS).join(", ")} to file it on that tool's repo.`
  }
  if (commit) result.commit = commit
  if (keepsCard) {
    const opened = await openCard({ deskRoot, person, card, fingerprint, lesson, now, commitCard, spawnGit, schedulePush })
    // A card whose commit did not finish says what to do first, as the answer's first key (#623).
    result = opened.next === undefined ? { ...result, ...opened } : { next: opened.next, ...result, ...opened }
  }
  if (issue !== null && issue.url === undefined) {
    throw Object.assign(new Error(`friction_add: Pass a title and body the repo can take, or sign in: the issue on ${issue.repo ?? tool} was not filed (${issue.reason ?? issue.result}); ${ISSUE_FIXES[issue.reason] ?? "run the call again"}. Your note is saved at ${written}`), { code: "friction_add_issue_not_filed" })
  }
  return result
}
