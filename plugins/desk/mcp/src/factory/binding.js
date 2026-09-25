// Binding: decides which Desk tasks (jobs) one session worked on, from the
// in-memory binding events a deriver returns (`derive-claude.js`,
// `derive-copilot.js`).
//
// A session binds task T when any of these holds (research §4, M3-4 brief):
//   - `desk_tool`: a successful Desk task tool call (`task_create`,
//     `task_update`, `task_archive`) names T. Its valid `status` values
//     become T's `transitions`, `at` being the call time, in time order.
//     The person desk is the caller's `personPrefix`: Desk's task tools take
//     it from the server's `--person` flag, never from the call.
//   - `file_write`: a successful file write lands in T's folder,
//     `<deskRoot>/[<personPrefix>/]<track>/<task>/…` or
//     `<track>/_archive/<task>/…`.
//   - `desk_commit`: a desk commit changed files in T's folder, and either
//     (a) this clone made the commit (a commit, initial-commit, amend or
//     merge-commit reflog entry, from `deskCommitsBetween`) at a time
//     inside one of the session's own
//     successful `git … commit` shell calls that ran in the desk
//     (`events.shellGitCommits`), or (b) the commit is one of the session's
//     native refs (`events.nativeCommitShas`, Copilot's `session_refs`) and
//     exists in the desk. Agents rarely use the Desk task tools and commit
//     with `git commit -q`, which prints no hash, so the commit basis never
//     depends on hashes in tool output: the Claude deriver's
//     `events.commitShas`, scraped from output, never binds, since `git log`
//     output alone would bind other sessions' commits. Desk history is read
//     once per session, over the span from the first call's start to the
//     last call's end, and each commit is then matched to the calls.
//     Commits fetched or pulled from another clone or machine have no
//     `commit` entry here, so they never bind; a commit later rebased keeps
//     its original entry and time.
//     One ambiguity remains: two sessions on the same clone whose successful
//     `git commit` calls overlap in time both bind a commit made in the
//     overlap. It is rare, and it only adds that session's time to the job,
//     so both are bound rather than guessing which one made it.
// Reads never bind (no deriver emits them). Paths outside the desk, relative
// paths, and paths under `_meta/`, `_friction/`, `_planning/`, the top-level
// `_archive/`, a dot folder, or directly in a track (such as `track.md`) bind
// nothing. A task whose card is found neither live nor archived is not a
// job. A session with no jobs gets `jobs: []`.
//
// Output. `{ jobs: LocalJob[] }`, sorted by job ID, where `LocalJob` is
// `{ job, basis, task_created_at, transitions, observed }`: the hashed job
// ID only, never a track, slug, title or path. `basis` follows
// `ENUMS.jobBasis` order. `task_created_at` is the card's `created`, or
// `null` when unreadable. `observed` is the card's status now — `{ status,
// at }`, `at` being the card's `updated` for a terminal status (`done`,
// `cancelled`) and otherwise `null` — or `null` when the card has no valid
// status. Jobs and transitions are capped at the facts limits.
//
// Dependencies are injected so tests can fake them (`desk-repo.js` has the
// real ones): `readTask(track, slug)`, `deskCommitsBetween(startIso,
// endIso)` and `gitCommitTaskPaths(sha)`. The desk root is passed in rather
// than resolved here: `src/util/paths.js` is outside `src/factory`, so the
// caller resolves it (with `resolveDeskRootWithSource`) and hands it over.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import * as path from "node:path"

import { ENUMS, LIMITS, PATTERNS } from "./schema.js"
import { DESK_MARKER } from "./shell-git.js"

const TERMINAL = new Set(["done", "cancelled"])
const PERSON_PREFIX = /^(?:desks\/([^/\\]+))?$/u
const SCP_REMOTE = /^([^@/\s]+@)?([^:/\s]{2,}):\/?([^/].*)$/u
const WINDOWS_PATH = /^[A-Za-z]:[\\/]/u
const URL_REMOTE = /^([a-z][a-z0-9+.-]*):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?(\/.*)?$/iu
const HTTPS_SCHEMES = new Set(["ssh", "git", "git+ssh", "ssh+git"])

// ---------------------------------------------------------------------------
// Job IDs.
// ---------------------------------------------------------------------------

function stripSuffixes(text) {
  let result = text.replace(/[/\\]+$/u, "")
  if (result.toLowerCase().endsWith(".git")) result = result.slice(0, -4)
  return result.replace(/[/\\]+$/u, "")
}

/**
 * Normalizes a desk remote so every spelling of one repository hashes the
 * same: lowercases the host and owner/repo, strips credentials, a port, a
 * `.git` suffix and trailing slashes, and maps `git@host:owner/repo` (also
 * `git@host:/owner/repo`) and `ssh://`/`git://` URLs to
 * `https://host/owner/repo`. `local:<root>` (a desk with no remote) is kept
 * as is; any other string, a Windows path such as `C:\\repos\\desk` included,
 * only loses its `.git` suffix and trailing slashes.
 */
export function normalizeRemote(remote) {
  if (typeof remote !== "string" || remote.trim() === "") throw new TypeError("normalizeRemote: remote must be a non-empty string")
  const text = remote.trim()
  if (text.startsWith("local:")) return text
  if (WINDOWS_PATH.test(text)) return stripSuffixes(text)
  const url = URL_REMOTE.exec(text)
  if (url) {
    const scheme = url[1].toLowerCase()
    const target = HTTPS_SCHEMES.has(scheme) ? "https" : scheme
    return `${target}://${url[2].toLowerCase()}${stripSuffixes(url[3] ?? "").toLowerCase()}`
  }
  const scp = SCP_REMOTE.exec(text)
  if (scp) return `https://${scp[2].toLowerCase()}/${stripSuffixes(scp[3]).toLowerCase()}`
  return stripSuffixes(text)
}

/** A track or task folder name: one path segment, not hidden, not reserved (`_…`). */
export function isTaskSegment(value) {
  return typeof value === "string" && value !== "" && !value.startsWith("_") && !value.startsWith(".") && !/[/\\]/u.test(value)
}

/** The alias in a `desks/<alias>` person prefix, `null` for `""`; anything else is a caller bug. */
export function checkPersonPrefix(personPrefix, caller) {
  const match = typeof personPrefix === "string" ? PERSON_PREFIX.exec(personPrefix) : null
  if (match === null || match[1] === "." || match[1] === "..") {
    throw new TypeError(`${caller}: personPrefix must be "" or "desks/<alias>"`)
  }
  return match[1] ?? null
}

/** `jobId({ deskRemote, personPrefix, track, slug })`: the first 32 hex of the job's SHA-256. */
export function jobId({ deskRemote, personPrefix, track, slug }) {
  checkPersonPrefix(personPrefix, "jobId")
  if (!isTaskSegment(track) || !isTaskSegment(slug)) throw new TypeError("jobId: track and slug must be task folder names")
  const input = `${normalizeRemote(deskRemote)}\n${personPrefix}\n${track}/${slug}`
  return createHash("sha256").update(input).digest("hex").slice(0, 32)
}

// ---------------------------------------------------------------------------
// Paths to tasks.
// ---------------------------------------------------------------------------

/** `{ track, slug }` for desk-relative path segments, or null. */
function taskOfSegments(segments, alias) {
  let rest = segments
  if (alias !== null) {
    if (rest[0] !== "desks" || rest[1] !== alias) return null
    rest = rest.slice(2)
  } else if (rest[0] === "desks") {
    return null
  }
  const [track, second, third] = rest
  const archived = second === "_archive"
  const slug = archived ? third : second
  const inside = rest.length - (archived ? 3 : 2)
  if (!isTaskSegment(track) || !isTaskSegment(slug) || inside < 1) return null
  return { track, slug }
}

function relativeSegments(relative) {
  return relative.split(/[/\\]/u).filter((segment) => segment !== "")
}

// The desk-relative segments of an absolute path inside one of `roots`, or null.
function segmentsInDesk(filePath, roots) {
  if (typeof filePath !== "string" || !path.isAbsolute(filePath)) return null
  for (const root of roots) {
    const relative = path.relative(root, path.resolve(filePath))
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return relativeSegments(relative)
  }
  return null
}

// The desk root's real path, or the root as given when it can't be resolved.
function realOrResolved(deskRoot) {
  try {
    return realpathSync(deskRoot)
  } catch {
    return path.resolve(deskRoot)
  }
}

function deskRootsOf(deskRoot) {
  return [...new Set([path.resolve(deskRoot), realOrResolved(deskRoot)])]
}

// A shell commit's directory with `$DESK` replaced by the desk root.
function expandDeskMarker(cwd, deskRoot) {
  if (typeof cwd !== "string") return null
  if (cwd === DESK_MARKER) return deskRoot
  if (cwd.startsWith(`${DESK_MARKER}/`)) return path.join(deskRoot, cwd.slice(DESK_MARKER.length + 1))
  return cwd
}

// ---------------------------------------------------------------------------
// Binding.
// ---------------------------------------------------------------------------

function isTime(value) {
  return typeof value === "string" && PATTERNS.timestamp.test(value)
}

// Git keeps whole seconds, so a commit made during a call that started at
// 08:00:05.600 is stamped 08:00:05; the window opens at the start's second.
function floorToSecond(iso) {
  return `${iso.slice(0, 19)}.000Z`
}

function asArray(value) {
  return Array.isArray(value) ? value : []
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`bindSession: ${name} must be a function`)
}

/**
 * `bindSession({ events, deskRoot, deskRemote, personPrefix, readTask,
 * deskCommitsBetween, gitCommitTaskPaths }) -> { jobs: LocalJob[] }`.
 * `deskRemote` is the desk's `origin` URL, or empty when it has none (the
 * job IDs then use `local:` plus the desk root).
 */
export function bindSession({ events, deskRoot, deskRemote, personPrefix, readTask, deskCommitsBetween, gitCommitTaskPaths }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("bindSession: deskRoot must be an absolute path")
  const alias = checkPersonPrefix(personPrefix, "bindSession")
  requireFunction(readTask, "readTask")
  requireFunction(deskCommitsBetween, "deskCommitsBetween")
  requireFunction(gitCommitTaskPaths, "gitCommitTaskPaths")
  if (deskRemote !== undefined && deskRemote !== null && typeof deskRemote !== "string") throw new TypeError("bindSession: deskRemote must be a string or empty")
  // One unpublished desk reached through a symlink and through its real path is one desk.
  const remote = typeof deskRemote === "string" && deskRemote.trim() !== "" ? deskRemote : `local:${realOrResolved(deskRoot)}`
  const roots = deskRootsOf(deskRoot)
  const source = events ?? {}

  const tasks = new Map() // "track/slug" -> { track, slug, basis: Set, transitions: [] }
  const touch = (task, basis) => {
    const key = `${task.track}/${task.slug}`
    if (!tasks.has(key)) tasks.set(key, { ...task, basis: new Set(), transitions: [] })
    const entry = tasks.get(key)
    entry.basis.add(basis)
    return entry
  }
  const bindCommitPaths = (taskPaths) => {
    for (const taskPath of asArray(taskPaths)) {
      if (typeof taskPath !== "string") continue
      const task = taskOfSegments(relativeSegments(taskPath), alias)
      if (task !== null) touch(task, "desk_commit")
    }
  }

  for (const call of asArray(source.deskToolCalls)) {
    if (call?.ok !== true || !isTaskSegment(call.track) || !isTaskSegment(call.slug)) continue
    const entry = touch({ track: call.track, slug: call.slug }, "desk_tool")
    if (ENUMS.jobStatus.includes(call.status) && isTime(call.at)) entry.transitions.push({ to: call.status, at: call.at })
  }

  for (const write of asArray(source.fileWrites)) {
    const segments = segmentsInDesk(write?.path, roots)
    const task = segments === null ? null : taskOfSegments(segments, alias)
    if (task !== null) touch(task, "file_write")
  }

  const windows = []
  for (const call of asArray(source.shellGitCommits)) {
    if (!isTime(call?.start) || !isTime(call.end) || call.end < call.start) continue
    if (segmentsInDesk(expandDeskMarker(call.cwd, roots[0]), roots) === null) continue
    windows.push({ start: floorToSecond(call.start), end: call.end })
  }
  if (windows.length > 0) {
    const first = windows.reduce((earliest, window) => (window.start < earliest ? window.start : earliest), windows[0].start)
    const last = windows.reduce((latest, window) => (window.end > latest ? window.end : latest), windows[0].end)
    for (const commit of asArray(deskCommitsBetween(first, last))) {
      const at = commit?.committed_at
      if (isTime(at) && windows.some((window) => at >= window.start && at <= window.end)) bindCommitPaths(commit.taskPaths)
    }
  }

  for (const sha of asArray(source.nativeCommitShas)) {
    if (typeof sha !== "string" || !PATTERNS.commitSha.test(sha)) continue
    const found = gitCommitTaskPaths(sha)
    if (found?.exists === true) bindCommitPaths(found.taskPaths)
  }

  const jobs = []
  for (const entry of tasks.values()) {
    const card = readTask(entry.track, entry.slug)
    if (card === null || card === undefined) continue
    const status = ENUMS.jobStatus.includes(card.status) ? card.status : null
    let observedAt = null
    if (status !== null && TERMINAL.has(status) && isTime(card.updated_at)) observedAt = card.updated_at
    jobs.push({
      job: jobId({ deskRemote: remote, personPrefix, track: entry.track, slug: entry.slug }),
      basis: ENUMS.jobBasis.filter((basis) => entry.basis.has(basis)),
      task_created_at: isTime(card.created_at) ? card.created_at : null,
      transitions: entry.transitions.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0)).slice(0, LIMITS.jobTransitions),
      observed: status === null ? null : { status, at: observedAt },
    })
  }
  jobs.sort((a, b) => (a.job < b.job ? -1 : 1))
  return { jobs: jobs.slice(0, LIMITS.jobs) }
}
