// Runtime CRUD tools for `task.md` cards — task_create, task_update, task_archive.
//
// Each export is invoked from server.js with a parsed { deskRoot, input }
// pair. The implementation owns the on-disk layout under
// `<root>/<track>/<slug>/task.md` and obeys the schema documented in
// `plugins/desk/skills/task-card-format/SKILL.md` (schema_version 1).

import { promises as fs } from "node:fs"
import * as path from "node:path"
import {
  nowIso,
  readMarkdown,
  writeMarkdown,
  patchMarkdownFrontmatter,
  pathExists,
} from "../util/fm.js"
import { isPathContained, resolveWriteTarget, personPrefix } from "../util/paths.js"
import { recordCanonicalChanges } from "../readiness/journal.js"
import { validateName, describeNameRejection } from "../desk/naming.js"
import { factoryStateRoot, requestEvaluation, requestFinalize } from "../factory/outbox.js"
import { jobId } from "../factory/binding.js"
import { readDeskRemote, resolveJobIdentity } from "../factory/desk-repo.js"
import { objectInput } from "../util/object-input.js"
import { reportLink } from "./factory-context.js"

const TERMINAL_STATUSES = new Set(["done", "cancelled"])

/**
 * The task's job identity as binding computes it: the desk's real path, its
 * remote (else `local:<path>`), the person prefix and the task's birth
 * track/slug (`resolveJobIdentity`, ourostack/desk#76) — the same one
 * `jobId` was hashed over, so a caller building a link or a request from
 * this task uses that birth track/slug too, not the one it was asked about.
 */
async function taskJob({ deskRoot, person, track, slug }) {
  const root = await fs.realpath(deskRoot)
  const prefix = path.relative(deskRoot, personPrefix(deskRoot, person)).split(path.sep).join("/")
  const deskRemote = readDeskRemote({ deskRoot: root }) || `local:${root}`
  const birth = resolveJobIdentity({ deskRoot: root, personPrefix: prefix, track, slug })
  return { root, prefix, deskRemote, track: birth.track, slug: birth.slug, job: jobId({ deskRemote, personPrefix: prefix, track: birth.track, slug: birth.slug }) }
}

async function requestTaskFinalize({ deskRoot, env, identity }) {
  try {
    if (await factoryStateRoot(env, { create: false, deskRoot }) === null) return
    await requestFinalize(env, { job: identity.job, deskRoot: identity.root })
  } catch {
    console.error("desk_factory: finalize_request_deferred")
  }
}

// Records the job's waste-evaluator request (`evaluate-requests/<job>.json`),
// like a finalize request: same opt-in gate (no factory state yet => no-op,
// and never creates it just to check), and any failure is swallowed so it
// can never block or reopen the task. `done` never waits for it, and briefs
// are prepared later, off this path, by the session-start hook's
// `evaluate --pending` (`evaluatePending` in factory/evaluate-run.js).
async function requestTaskEvaluation({ deskRoot, env, identity }) {
  try {
    if (await factoryStateRoot(env, { create: false, deskRoot }) === null) return
    await requestEvaluation(env, { job: identity.job, deskRoot: identity.root })
  } catch {
    console.error("desk_factory: evaluation_request_deferred")
  }
}

// The terminal-status sync a Desk task tool runs alongside the status write:
// a finalize request for every terminal status (`done`/`cancelled`, matching
// `requestFinalize`'s own contract), and, on either terminal status, an
// evaluation request too — `docs/factory-local-capture.md` treats `done` and
// `cancelled` alike as a finished job, and the waste in a cancelled job is
// exactly what the waste evaluator needs to see. The job identity is
// resolved once here (it never differs between the two calls) and handed to
// both; if resolving it throws, both calls still degrade the same way each
// would have on its own, so both deferred messages are logged below.
async function requestTaskTerminalSync({ deskRoot, person, track, slug, env, status }) {
  let identity = null
  try {
    identity = await taskJob({ deskRoot, person, track, slug })
  } catch {
    // Left null: requestTaskFinalize/requestTaskEvaluation each fail the
    // same way reading `identity.job`/`identity.root`, and each logs its
    // own deferred message via its own try/catch below.
  }
  await requestTaskFinalize({ deskRoot, env, identity })
  if (TERMINAL_STATUSES.has(status)) await requestTaskEvaluation({ deskRoot, env, identity })
}

// The `factory_report` link written on the transition to `done`, or `null`
// when the desk's resolved store has no consent. It is deterministic and
// resolves once the store merges the job's facts; done never waits for it,
// and nothing here can fail the task update.
async function factoryReportFor({ deskRoot, person, track, slug, env }) {
  try {
    const { root, prefix, deskRemote, track: birthTrack, slug: birthSlug } = await taskJob({ deskRoot, person, track, slug })
    return reportLink({ env, deskRoot: root, deskRemote, personPrefix: prefix, track: birthTrack, slug: birthSlug })
  } catch {
    return null
  }
}

// Optional runtime fields the operator (or harness) may pass at create time.
// Kept explicit so we don't silently accept arbitrary keys.
const OPTIONAL_RUNTIME_FIELDS = [
  "category",
  "cadence",
  "scheduledAt",
  "requester",
  "validator",
  "artifacts",
  "active_bridge",
  "bridge_sessions",
  "planning_complete",
  "adopted_at",
  "repos",
  "iterations",
  "predecessor",
  "initiated_by",
  "origin_note",
]

function relPath(deskRoot, absPath) {
  return path.relative(deskRoot, absPath)
}

async function assertArchiveSourceIsRelocationSafe({
  srcDir,
  srcFile,
  archiveDir,
}) {
  if ((await fs.lstat(srcDir)).isSymbolicLink()) {
    throw new Error(`task_archive: source directory symlink cannot be archived safely: ${srcDir}`)
  }
  if (!(await pathExists(srcFile))) return

  const fileStat = await fs.lstat(srcFile)
  if (!fileStat.isSymbolicLink()) return

  const realSrcDir = await fs.realpath(srcDir)
  const realArchiveDir = await prospectiveArchiveDir(archiveDir)
  if (isPathContained(realSrcDir, realArchiveDir)) {
    throw new Error(`task_archive: archive destination cannot be inside source directory: ${archiveDir}`)
  }

  const sourceReferent = await fs.realpath(srcFile)
  const expectedReferent = isPathContained(realSrcDir, sourceReferent)
    ? path.join(realArchiveDir, path.relative(realSrcDir, sourceReferent))
    : sourceReferent
  const relocatedReferent = await realpathAfterArchive(
    path.join(realArchiveDir, path.basename(srcFile)),
    { realSrcDir, realArchiveDir },
  )
  if (relocatedReferent !== expectedReferent) {
    throw new Error(`task_archive: task.md symlink would change referent when archived: ${srcFile}`)
  }
}

async function prospectiveArchiveDir(archiveDir) {
  const archiveParent = path.dirname(archiveDir)
  const realArchiveParent = await pathExists(archiveParent)
    ? await fs.realpath(archiveParent)
    : path.join(
        await fs.realpath(path.dirname(archiveParent)),
        path.basename(archiveParent),
      )
  return path.join(realArchiveParent, path.basename(archiveDir))
}

async function realpathAfterArchive(candidate, { realSrcDir, realArchiveDir }) {
  let { root, segments } = splitAbsolutePath(candidate)
  let resolved = root
  let followedLinks = 0

  while (segments.length > 0) {
    const virtualPath = path.join(resolved, segments.shift())
    const inspectionPath = pathBeforeArchive(virtualPath, {
      realSrcDir,
      realArchiveDir,
    })
    if (inspectionPath === null) return null

    let stat
    try {
      stat = await fs.lstat(inspectionPath)
    } catch (error) {
      if (
        error?.code === "ENOENT" &&
        isPathContained(virtualPath, realArchiveDir)
      ) {
        resolved = virtualPath
        continue
      }
      const unavailableAfterMove = ["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)
      /* istanbul ignore next -- defensive: lstat during archive-move symlink
       * resolution only fails with ENOENT/ENOTDIR/ELOOP in practice; any
       * other error must still propagate rather than being swallowed, but
       * that path isn't reachable from a portable test fixture. */
      if (!unavailableAfterMove) {
        throw error
      }
      return null
    }

    if (!stat.isSymbolicLink()) {
      resolved = virtualPath
      continue
    }
    followedLinks += 1
    if (followedLinks > 40) return null

    const linkTarget = await fs.readlink(inspectionPath)
    const nextPath = path.resolve(
      path.dirname(virtualPath),
      linkTarget,
      ...segments,
    )
    const splitPath = splitAbsolutePath(nextPath)
    root = splitPath.root
    segments = splitPath.segments
    resolved = root
  }

  return resolved
}

function pathBeforeArchive(candidate, { realSrcDir, realArchiveDir }) {
  if (isPathContained(realArchiveDir, candidate)) {
    return path.join(realSrcDir, path.relative(realArchiveDir, candidate))
  }
  if (isPathContained(realSrcDir, candidate)) return null
  return candidate
}

function splitAbsolutePath(candidate) {
  const resolved = path.resolve(candidate)
  const root = path.parse(resolved).root
  return {
    root,
    segments: resolved.slice(root.length).split(path.sep).filter(Boolean),
  }
}

/**
 * task_create
 *
 * Input:
 *   {
 *     track: string,            // required — a path segment; not itself
 *                               // name-validated (that's track_create's job)
 *     slug: string,             // required — validated, see Errors
 *     title: string,            // required
 *     status?: string,          // default "drafting"
 *     body?: string,            // markdown body (no frontmatter)
 *     ...optional runtime fields per task-card schema
 *   }
 *
 * Side effects: creates `<root>/<track>/<slug>/task.md` (and parent dirs).
 *
 * Errors:
 *   - refuses if the target task.md already exists.
 *   - refuses `slug` that isn't a valid outcome name per `validateName` (see
 *     `desk/naming.js`): wrong shape, too long, prompt-like, or
 *     credential-like.
 *
 * Returns: { status: "created", path: "<track>/<slug>/task.md" }
 */
export async function task_create({ deskRoot, input, person = null, readiness }) {
  const values = input ?? {}
  const { track, slug, title } = values
  if (!Object.hasOwn(values, "track")) {
    throw new Error("task_create: `track` is required (string)")
  }
  if (!Object.hasOwn(values, "slug")) {
    throw new Error("task_create: `slug` is required (string)")
  }
  if (!title || typeof title !== "string") {
    throw new Error("task_create: `title` is required (string)")
  }

  const filePath = await resolveWriteTarget({
    deskRoot,
    person,
    segments: [track, slug, "task.md"],
  })

  // Path/segment/alias safety (above) is a tool-misuse concern and takes
  // precedence over naming content rules, which are business rules
  // evaluated once the target path itself is known-safe.
  const nameResult = validateName(slug)
  if (!nameResult.ok) {
    throw new Error(
      `task_create: invalid slug: ${describeNameRejection(nameResult)}`,
    )
  }
  if (await pathExists(filePath)) {
    throw new Error(
      `task_create: task already exists at ${relPath(deskRoot, filePath)}`,
    )
  }

  const ts = nowIso()
  const data = {
    schema_version: 1,
    title,
    status: values.status ?? "drafting",
    created: ts,
    updated: ts,
    track,
  }
  for (const k of OPTIONAL_RUNTIME_FIELDS) {
    if (values[k] !== undefined) data[k] = values[k]
  }

  await writeMarkdown(filePath, data, values.body ?? "")
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  return { status: "created", path: relPath(deskRoot, filePath) }
}

/**
 * task_update
 *
 * Input:
 *   {
 *     track: string,
 *     slug: string,
 *     frontmatter?: object,   // shallow-merged into existing frontmatter; a
 *                             // JSON-string object is parsed, anything else
 *                             // is refused before the card is touched
 *     body_append?: string,   // appended to existing body (blank line sep)
 *   }
 *
 * Side effects: rewrites `<root>/<track>/<slug>/task.md` in place.
 *
 * Preserves: `schema_version`, `created`. Always refreshes `updated` to now.
 *
 * Errors: refuses if the task doesn't exist.
 *
 * Returns: { status: "updated", path }
 */
export async function task_update({ deskRoot, input, person = null, readiness, env = process.env }) {
  const values = input ?? {}
  const { track, slug, body_append } = values
  if (
    !Object.hasOwn(values, "track") ||
    !Object.hasOwn(values, "slug")
  ) {
    throw new Error("task_update: `track` and `slug` are required")
  }
  // Checked before anything is read or written: a string spread into the
  // card would write one key per character.
  const frontmatter = objectInput(values.frontmatter, { tool: "task_update", field: "frontmatter" })

  const filePath = await resolveWriteTarget({
    deskRoot,
    person,
    segments: [track, slug, "task.md"],
  })
  if (!(await pathExists(filePath))) {
    throw new Error(
      `task_update: task does not exist at ${relPath(deskRoot, filePath)}`,
    )
  }

  const existing = await readMarkdown(filePath)
  const merged = { ...existing.data, ...(frontmatter ?? {}) }

  // Preserve immutable fields even if the caller passed them.
  if (existing.data.schema_version !== undefined) {
    merged.schema_version = existing.data.schema_version
  } else {
    merged.schema_version = 1
  }
  if (existing.data.created !== undefined) {
    merged.created = existing.data.created
  }
  merged.updated = nowIso()
  if (merged.status === "done" && existing.data.status !== "done") {
    const link = await factoryReportFor({ deskRoot, person, track, slug, env })
    if (link !== null) merged.factory_report = link
  }

  let newBody = existing.content
  if (typeof body_append === "string" && body_append.length > 0) {
    const sep = newBody.endsWith("\n\n") || newBody.length === 0 ? "" : "\n\n"
    newBody = `${newBody}${sep}${body_append}`
  }

  await writeMarkdown(filePath, merged, newBody)
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
  if (TERMINAL_STATUSES.has(merged.status)) await requestTaskTerminalSync({ deskRoot, person, track, slug, env, status: merged.status })
  return { status: "updated", path: relPath(deskRoot, filePath) }
}

// The already-archived card's status, read fail-safe: a missing file reads
// as no status (as before), and corrupted frontmatter (bad YAML from hand
// editing or a partial write) degrades the same way rather than throwing
// out of `task_archive` — the idempotent already-archived branch must keep
// returning `already_archived`, not break, on a card it doesn't control the
// shape of. A `null` status skips the evaluation request further down
// (`requestTaskTerminalSync` only requests one for a terminal status), but
// the finalize request still fires.
async function archivedTaskStatus(archivedFile) {
  if (!(await pathExists(archivedFile))) return null
  try {
    return (await readMarkdown(archivedFile)).data.status
  } catch {
    return null
  }
}

/**
 * task_archive
 *
 * Input: { track, slug }
 *
 * Side effects: moves `<root>/<track>/<slug>/` → `<root>/<track>/_archive/<slug>/`.
 * Marks the task `done` if not already in a terminal status.
 *
 * Idempotent: if the source dir doesn't exist AND `_archive/<slug>` does,
 * returns `{ status: "already_archived" }`. Throws if neither exists.
 *
 * Returns: { status: "archived" | "already_archived", path }
 */
export async function task_archive({ deskRoot, input, person = null, readiness, env = process.env }) {
  const values = input ?? {}
  const { track, slug } = values
  if (
    !Object.hasOwn(values, "track") ||
    !Object.hasOwn(values, "slug")
  ) {
    throw new Error("task_archive: `track` and `slug` are required")
  }

  const target = (segments) =>
    resolveWriteTarget({ deskRoot, person, segments })
  const srcDir = await target([track, slug])
  const srcFile = await target([track, slug, "task.md"])
  const archiveDir = await target([track, "_archive", slug])
  const archivedFile = await target([track, "_archive", slug, "task.md"])

  const srcExists = await pathExists(srcDir)
  const dstExists = await pathExists(archiveDir)

  if (!srcExists && dstExists) {
    const archivedStatus = await archivedTaskStatus(archivedFile)
    await requestTaskTerminalSync({ deskRoot, person, track, slug, env, status: archivedStatus })
    return {
      status: "already_archived",
      path: relPath(deskRoot, archivedFile),
    }
  }
  if (!srcExists && !dstExists) {
    throw new Error(
      `task_archive: task does not exist at ${relPath(deskRoot, srcDir)}`,
    )
  }
  if (srcExists && dstExists) {
    throw new Error(
      `task_archive: archive destination already exists at ${relPath(
        deskRoot,
        archiveDir,
      )} but source ${relPath(deskRoot, srcDir)} also exists`,
    )
  }

  await assertArchiveSourceIsRelocationSafe({
    srcDir,
    srcFile,
    archiveDir,
  })

  // Move the dir. fs.rename is atomic on the same filesystem.
  await fs.mkdir(path.dirname(archiveDir), { recursive: true })
  await fs.rename(srcDir, archiveDir)
  // A directory move invalidates both subtrees, including companion documents.
  await recordCanonicalChanges({ root: deskRoot, readiness, changes: [
    { path: relPath(deskRoot, srcDir), operation: "delete" },
    { path: relPath(deskRoot, archiveDir), operation: "write" },
  ] })

  // Bump task status to `done` (and refresh `updated`) if not already terminal.
  await target([track, "_archive", slug])
  const filePath = await target([track, "_archive", slug, "task.md"])
  let finalStatus = null
  if (await pathExists(filePath)) {
    const existing = await readMarkdown(filePath)
    const currentStatus = existing.data.status
    finalStatus = currentStatus
    if (!TERMINAL_STATUSES.has(currentStatus)) {
      // Patch only `status:`/`updated:`/`factory_report:` in place: every
      // other byte of the card — quoting, date formats, block scalars, key
      // order — survives.
      const patchFields = { status: "done", updated: nowIso() }
      const link = await factoryReportFor({ deskRoot, person, track, slug, env })
      if (link !== null) patchFields.factory_report = link
      await patchMarkdownFrontmatter(filePath, patchFields)
      await recordCanonicalChanges({ root: deskRoot, readiness, changes: [{ path: relPath(deskRoot, filePath) }] })
      finalStatus = "done"
    }
  }

  await requestTaskTerminalSync({ deskRoot, person, track, slug, env, status: finalStatus })
  return { status: "archived", path: relPath(deskRoot, filePath) }
}
