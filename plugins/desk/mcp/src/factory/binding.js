// Binding: decides which Desk tasks (jobs) one session worked on, and which of
// its workers belong to each, from the in-memory events a deriver returns
// (`derive-claude.js`, `derive-codex.js`, `derive-copilot.js`).
//
// A job is one durable outcome, recorded as one task card. Everything a
// session tree does while working an outcome belongs to that outcome's job:
// the controller (worker 0), every subagent, and the time spent briefing,
// waiting on and reading back from them. Mentioning, filing, tidying or
// updating another card is not working on it, and binds nothing.
//
// The controller's timeline (`focus.js` has the rules). Worker 0's
// `task_focus` calls, and its `task_create` calls with `focus: true`
// (`events.focusCalls` holds both), cut the session into declared stretches. A stretch with no declaration is inferred from the session
// tree's evidence events:
//   - `write`: a file write under a task's folder,
//     `<deskRoot>/[<personPrefix>/]<track>/<task>/…` or
//     `<track>/_archive/<task>/…` (`events.fileWrites`: file tools, shell
//     redirects and `desk_save` paths; a relative path is a `desk_save` path
//     and resolves against the desk root).
//   - `tool`: a successful Desk task tool call naming the task
//     (`events.deskToolCalls`), other than `task_create` and a status-only
//     `task_update`. The person desk is the caller's `personPrefix`: Desk's
//     task tools take it from the server's `--person` flag, never from the call.
//   - `spawn`: a subagent's brief carrying a `Desk-Task:` line for the task
//     (`events.spawns`), at the spawn's time, as its parent's event.
//   - `commit`: one of the session's own `git … commit` shell calls whose
//     `git add` or `git commit` names a path at or under the task's folder
//     (`events.shellGitCommits[].paths`). A call naming no path (`git add -A`,
//     `git add .`, `git commit -am`) counts for nothing, and so does one naming
//     more than MASS_COMMIT_TASKS tasks, a sweep. Desk history is never read by
//     time: another session's commit that lands while this one's `git commit`
//     runs binds nothing. A commit from the session's native refs
//     (`events.nativeCommitShas`, Copilot's `session_refs`) that exists in the
//     desk is the session's own too, and counts for the tasks it changed
//     (`taskCommitRule`). It has no time, so it counts toward candidacy only
//     and never earns a task time over another.
//   - `repo`: work in a code repository. A file write outside the desk, one of
//     the session's `git … commit` calls that ran outside the desk or named a
//     path there (one event for each repository the call touches, at its
//     start), and a pull request the session created (`events.prRefs` with
//     `created: true`). `repoLookup` names the repository a path is in; a path
//     it cannot name is no evidence, never a guess, and its directory is
//     counted in `repoUnresolved` only when the evidence was not available. A `repo` event counts only for the one card
//     that lists the repository and has another event (`focus.js`).
// Events of a subagent bound by a `Desk-Task:` line, and of the subagents
// below it, are left out: that subtree has its own job. Reads never bind (no
// deriver emits them). Paths outside the desk, and paths under `_meta/`,
// `_friction/`, `_planning/`, the top-level `_archive/`, a dot folder, or
// directly in a track (such as `track.md`) name no task. A task whose card is
// found neither live nor archived is not a task: its events are dropped, a
// focus on it holds its stretch for no job, and a `Desk-Task:` line for it is
// ignored.
//
// Workers. Worker 0 is in every job that holds part of its timeline. Each
// subagent is in at most one job, chosen in this order: the task of its
// `Desk-Task:` line; else, for a nested subagent, its parent's job; else the
// job that held the controller's timeline when it was spawned
// (`events.spawns[].at`). A subagent with no spawn time, spawned while the
// controller had no job, or whose parent cannot be traced, is in no job. A
// subagent's own touches never create a job, and a subagent that keeps
// running, or is resumed, after the controller moves on keeps its job.
//
// Output. `{ jobs, boundBy, disagrees, ownActivity, repoUnresolved, segmentsCappedMs }`.
//   - `jobs` is `LocalJob[]`, sorted by job ID: `{ job, basis, agents,
//     task_created_at, transitions, observed, segments? }`, the hashed job ID
//     only, never a track, slug, title or path. `agents` lists the job's
//     workers. `segments` are the spans of the session, in milliseconds from
//     its start, that worker 0's timeline gives the job. They are present
//     exactly when `agents` lists worker 0, even for a session with one job, so
//     a cleared or unbound stretch is never counted; no two jobs' segments
//     overlap; and a job keeps at most `LIMITS.jobSegments` (`capSegments`).
//     `basis` follows `ENUMS.jobBasis` order: `desk_tool` for a declared task
//     or `tool` evidence, `file_write`, `desk_commit` and `spawn_brief` for the
//     other evidence of a job worker 0 is in, `spawn_brief` for a subagent's
//     own line and `inherited` for a subagent placed by its parent or its spawn
//     time. `transitions` are the valid statuses of the session's successful
//     task tool calls on that job, `at` being the call time, in time order; a
//     status change on a card that is not one of the session's jobs is not
//     recorded. `task_created_at` is the card's `created`, or `null` when
//     unreadable. `observed` is the card's status now — `{ status, at }`, `at`
//     being the card's `updated` for a terminal status (`done`, `cancelled`)
//     and otherwise `null` — or `null` when the card has no valid status.
//     Jobs and transitions are capped at the facts limits.
//   - `boundBy` maps a job ID to `focus` or `inferred`, for the jobs worker 0
//     is in. `disagrees` lists the declared jobs with a stretch that holds
//     none of their own events and ten or more on another task.
//   - `ownActivity` is up to 500 `[start_ms, end_ms]` spans, in milliseconds
//     from the session's start (they may run before it or past its end): the
//     session's `git commit` calls that ran in the desk and each successful
//     task tool call widened by a minute each way, merged where they touch.
//     `factory reconcile` matches desk commits to the session with it.
//   - `repoUnresolved` is how many distinct directories outside the desk the
//     session wrote or committed in whose repository evidence was not
//     available: the directory is gone (ENOENT, ENOTDIR), any other stat
//     error, or Git failed or timed out. A directory that exists and is in no
//     repository, or in one with no origin, is a true none and is not
//     counted. A number, never a path.
//   - `segmentsCappedMs` is the time the segment cap dropped (`capSegments`
//     reports it): 0 only when nothing was dropped.
// These five are local only (`derive-run.js` keeps them in the derivation
// receipt) and never reach facts.
//
// Without the session's `started_at` and `derived_through` there is no
// timeline, so worker 0 is in no job. Without `agents` the session is read as
// worker 0 alone, and every event as its own.
//
// A job's ID hashes its task's *birth* path, not the path a touch was
// matched against: once a task is found (`readTask` answers), its track and
// slug are handed to `resolveJobIdentity`, which is where the desk's Git
// decides whether the task has ever been renamed or moved (the controller
// ruling in ourostack/desk#76). Evidence is keyed by that birth path, so a
// task renamed in the middle of a session is still one task and one job.
//
// Dependencies are injected so tests can fake them (`desk-repo.js` has the
// real ones): `readTask(track, slug)`, `gitCommitTaskPaths(sha)`,
// `isCardHousekeeping(sha, path)`, `resolveJobIdentity(track, slug)` and
// `repoLookup(absolutePath)`, which answers `{ repo: "owner/name" }`,
// `{ none: true }` (a true none) or `{ unavailable: true }`. The
// desk root is passed in rather than resolved here: `src/util/paths.js` is
// outside `src/factory`, so the caller resolves it (with
// `resolveDeskRootWithSource`) and hands it over.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createHash } from "node:crypto"
import { realpathSync } from "node:fs"
import * as path from "node:path"

import { capSegments, controllerTimeline } from "./focus.js"
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

const CARD_FILE = "task.md"

// A desk commit spanning more tasks than this is a sweep and binds none.
const MASS_COMMIT_TASKS = 3

const CREATE_CALL = /task_create$/u
// A task tool call commits the card within moments; a minute each way covers Git's whole seconds and a slow push.
const TOOL_CALL_REACH_MS = 60000
const OWN_ACTIVITY_SPANS = 500
const KIND_BASIS = Object.freeze({ tool: "desk_tool", write: "file_write", commit: "desk_commit", spawn: "spawn_brief" })

/**
 * `{ track, slug, bare }` for desk-relative path segments naming a path
 * inside a task folder, or null. `bare` is true when the only segment past
 * `<track>/<slug>` (or `<track>/_archive/<slug>`) is the card itself,
 * `task.md`, matched case-insensitively so `Task.md` and `TASK.MD` are the
 * same card; a nested `task.md` inside a subfolder is not bare. See the
 * header for what a caller does with `bare`.
 */
export function taskOfSegments(segments, alias) {
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
  const inner = rest.slice(archived ? 3 : 2)
  if (!isTaskSegment(track) || !isTaskSegment(slug) || inner.length < 1) return null
  const bare = inner.length === 1 && inner[0].toLowerCase() === CARD_FILE
  return { track, slug, bare }
}

export function relativeSegments(relative) {
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

// Epoch milliseconds of a facts timestamp, or `null`.
function msOf(value) {
  return isTime(value) ? Date.parse(value) : null
}

/**
 * `taskCommitRule({ alias, isCardHousekeeping })` -> `(sha, taskPaths) => { tasks, real, touched, mass }`:
 * how one desk commit counts toward tasks, shared by the binder and `factory reconcile`.
 * `touched` is every task a path names. `real` leaves out a bare card whose diff in that commit
 * is identity or placement only (`isCardHousekeeping` is the judge). `mass` is true when `real`
 * spans more than MASS_COMMIT_TASKS tasks, a housekeeping sweep rather than work on any one of
 * them. `tasks` is what the commit binds: `real`, or nothing for a mass commit. Each task is
 * `{ track, slug, bare }`.
 */
export function taskCommitRule({ alias, isCardHousekeeping }) {
  return (sha, taskPaths) => {
    const touched = new Map()
    const real = new Map()
    for (const taskPath of asArray(taskPaths)) {
      if (typeof taskPath !== "string") continue
      const task = taskOfSegments(relativeSegments(taskPath), alias)
      if (task === null) continue
      const key = `${task.track}/${task.slug}`
      touched.set(key, task)
      if (task.bare && isCardHousekeeping(sha, taskPath)) continue
      real.set(key, task)
    }
    const mass = real.size > MASS_COMMIT_TASKS
    return { tasks: mass ? [] : [...real.values()], real: [...real.values()], touched: [...touched.values()], mass }
  }
}

function requireFunction(value, name) {
  if (typeof value !== "function") throw new TypeError(`bindSession: ${name} must be a function`)
}

/**
 * `bindSession({ events, agents, session, deskRoot, deskRemote, personPrefix,
 * readTask, gitCommitTaskPaths, isCardHousekeeping, resolveJobIdentity,
 * repoLookup }) -> { jobs, boundBy, disagrees, ownActivity, repoUnresolved, segmentsCappedMs }`; the
 * header describes each. `agents` is the facts' `agents[]` (`{ n, parent }`),
 * used for ancestry. `session` is the facts' `session` (`started_at` and
 * `derived_through` are read). `deskRemote` is the desk's `origin` URL, or
 * empty when it has none (the job IDs then use `local:` plus the desk root).
 */
export function bindSession({ events, agents, session, deskRoot, deskRemote, personPrefix, readTask, gitCommitTaskPaths, isCardHousekeeping, resolveJobIdentity, repoLookup }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("bindSession: deskRoot must be an absolute path")
  const alias = checkPersonPrefix(personPrefix, "bindSession")
  requireFunction(readTask, "readTask")
  requireFunction(gitCommitTaskPaths, "gitCommitTaskPaths")
  requireFunction(isCardHousekeeping, "isCardHousekeeping")
  requireFunction(resolveJobIdentity, "resolveJobIdentity")
  // One reader with three answers, so a caller cannot take evidence that is not available for a true none; a caller that omits it is an error.
  requireFunction(repoLookup, "repoLookup")
  if (deskRemote !== undefined && deskRemote !== null && typeof deskRemote !== "string") throw new TypeError("bindSession: deskRemote must be a string or empty")
  // One unpublished desk reached through a symlink and through its real path is one desk.
  const remote = typeof deskRemote === "string" && deskRemote.trim() !== "" ? deskRemote : `local:${realOrResolved(deskRoot)}`
  const roots = deskRootsOf(deskRoot)
  const source = events ?? {}

  // Without `agents` the session is worker 0 alone, and every event is its own.
  const hasAgents = Array.isArray(agents)
  const workers = hasAgents ? agents : [{ n: 0, parent: null }]
  const agentOf = (item) => (hasAgents && Number.isInteger(item?.agent) && item.agent >= 0 ? item.agent : 0)
  // A worker `agents` does not list contributes nothing: the facts could not name it in a job's `agents`.
  const listed = new Set(workers.map((worker) => worker?.n))
  const parents = new Map()
  for (const worker of workers) {
    if (Number.isInteger(worker?.n) && Number.isInteger(worker.parent)) parents.set(worker.n, worker.parent)
  }
  const startedMs = msOf(session?.started_at)
  const endMs = msOf(session?.derived_through)

  // Tasks by birth key, `{ key, birth, card, transitions }`, each card read once per name it was touched under.
  const tasks = new Map()
  const named = new Map()
  const taskOf = ({ track, slug }) => {
    const name = `${track}/${slug}`
    if (!named.has(name)) {
      const card = readTask(track, slug)
      let task = null
      if (card !== null && card !== undefined) {
        const birth = resolveJobIdentity(track, slug)
        const key = `${birth.track}/${birth.slug}`
        if (!tasks.has(key)) tasks.set(key, { key, birth, card, transitions: [] })
        task = tasks.get(key)
      }
      named.set(name, task)
    }
    return named.get(name)
  }
  // Where a path an event names lies: `{ segments }`, its desk-relative segments, or `{ outside }`, its absolute path outside the
  // desk; `null` for no path. A relative path is taken from the desk root.
  const locate = (value) => {
    if (typeof value !== "string" || value === "") return null
    const absolute = path.resolve(roots[0], expandDeskMarker(value, roots[0]))
    const segments = segmentsInDesk(absolute, roots)
    return segments === null ? { outside: absolute } : { segments }
  }
  // The `{ track, slug }` desk segments name: a path inside a task folder, or (`folder`) the folder itself.
  const nameOf = (segments, folder = false) => taskOfSegments(folder ? [...segments, CARD_FILE] : segments, alias)
  // The repository holding an absolute path outside the desk, or `null`; `directory` is counted when it cannot be named.
  const unresolved = new Set()
  const repoAt = (directory) => {
    const found = repoLookup(directory)
    if (typeof found?.repo === "string" && found.repo !== "") return found.repo
    // A true none is nothing lost. Anything else, including an answer that is none of the three, is evidence that was not available.
    if (found?.none !== true) unresolved.add(directory)
    return null
  }

  // The session tree's evidence, `{ at, key, kind, agent }` (`at` in epoch ms, null when unknown), and its own activity spans in epoch ms.
  const evidence = []
  const spans = []
  const note = (item, name, kind, at) => {
    const agent = agentOf(item)
    const task = name === null || !listed.has(agent) ? null : taskOf(name)
    if (task !== null) evidence.push({ at, key: task.key, kind, agent })
  }

  for (const call of asArray(source.deskToolCalls)) {
    if (call?.ok !== true) continue
    const at = msOf(call.at)
    if (at !== null) spans.push([at - TOOL_CALL_REACH_MS, at + TOOL_CALL_REACH_MS])
    if (!isTaskSegment(call.track) || !isTaskSegment(call.slug) || !listed.has(agentOf(call))) continue
    const task = taskOf(call)
    if (task === null) continue
    if (ENUMS.jobStatus.includes(call.status) && at !== null) task.transitions.push({ to: call.status, at: call.at })
    // Filing a card, or only moving its status, is not working on it.
    const filing = typeof call.name === "string" && CREATE_CALL.test(call.name)
    if (!filing && call.statusOnly !== true) evidence.push({ at, key: task.key, kind: "tool", agent: agentOf(call) })
  }

  for (const write of asArray(source.fileWrites)) {
    const place = locate(write?.path)
    if (place === null || !listed.has(agentOf(write))) continue
    if (place.segments !== undefined) {
      note(write, nameOf(place.segments), "write", msOf(write.at))
      continue
    }
    const repo = repoAt(path.dirname(place.outside))
    if (repo !== null) evidence.push({ at: msOf(write.at), repo, kind: "repo", agent: agentOf(write) })
  }

  // Each subagent's spawn time, and the task of its `Desk-Task:` line when that card exists.
  const spawnedAt = new Map()
  const briefed = new Map()
  for (const spawn of asArray(source.spawns)) {
    const child = spawn?.agent
    if (!Number.isInteger(child) || child < 1 || !listed.has(child)) continue
    const at = msOf(spawn.at)
    if (at !== null) spawnedAt.set(child, at)
    if (!isTaskSegment(spawn.task?.track) || !isTaskSegment(spawn.task.slug)) continue
    const task = taskOf(spawn.task)
    if (task === null) continue
    briefed.set(child, task.key)
    // The brief is its parent's event; with no parent on record it is nobody's.
    evidence.push({ at, key: task.key, kind: "spawn", agent: parents.get(child) })
  }

  for (const call of asArray(source.shellGitCommits)) {
    if (!isTime(call?.start) || !isTime(call.end) || call.end < call.start) continue
    if (segmentsInDesk(expandDeskMarker(call.cwd, roots[0]), roots) !== null) spans.push([Date.parse(floorToSecond(call.start)), Date.parse(call.end)])
    if (!listed.has(agentOf(call))) continue
    const names = new Map()
    const repos = new Set()
    const cwd = locate(call.cwd)
    // A directory that is not absolute says nothing about where the call ran.
    if (cwd?.outside !== undefined && path.isAbsolute(call.cwd)) repos.add(repoAt(cwd.outside))
    for (const entry of asArray(call.paths)) {
      const place = locate(entry)
      if (place === null) continue
      if (place.segments === undefined) {
        repos.add(repoAt(path.dirname(place.outside)))
        continue
      }
      const name = nameOf(place.segments, true)
      if (name !== null) names.set(`${name.track}/${name.slug}`, name)
    }
    for (const repo of repos) if (repo !== null) evidence.push({ at: Date.parse(call.start), repo, kind: "repo", agent: agentOf(call) })
    if (names.size > MASS_COMMIT_TASKS) continue
    for (const name of names.values()) note(call, name, "commit", Date.parse(call.start))
  }

  // The tasks a native commit's paths count for (`taskCommitRule` judges).
  const rule = taskCommitRule({ alias, isCardHousekeeping })
  for (const entry of asArray(source.nativeCommitShas)) {
    const sha = entry?.sha
    if (typeof sha !== "string" || !PATTERNS.commitSha.test(sha)) continue
    const found = gitCommitTaskPaths(sha)
    if (found?.exists === true) for (const name of rule(sha, found.taskPaths).tasks) note(entry, name, "commit", null)
  }

  for (const ref of asArray(source.prRefs)) {
    if (ref?.created === true && typeof ref.repo === "string") evidence.push({ at: msOf(ref.at), repo: ref.repo, kind: "repo", agent: agentOf(ref) })
  }

  // Where a subagent's job comes from: `{ line }`, the task of the nearest `Desk-Task:` line from itself upward,
  // or `{ top }`, its ancestor that worker 0 spawned; neither when its ancestry cannot be traced.
  const originOf = (agent) => {
    const seen = new Set()
    let current = agent
    while (!seen.has(current)) {
      if (briefed.has(current)) return { line: briefed.get(current) }
      seen.add(current)
      const parent = parents.get(current)
      if (parent === 0) return { top: current }
      current = parent
    }
    return {}
  }

  // Worker 0's timeline, `[{ key, start, end }]` in epoch ms.
  let timeline = { segments: [], boundBy: new Map(), disagrees: new Set() }
  // The time the segment cap dropped (`capSegments` reports it); 0 when nothing was dropped, which includes a session with no timeline.
  let segmentsCappedMs = 0
  let kept = []
  if (startedMs !== null && endMs !== null && endMs >= startedMs && listed.has(0)) {
    const focusCalls = []
    for (const call of asArray(source.focusCalls)) {
      if (agentOf(call) !== 0) continue
      const at = msOf(call?.at)
      if (call?.clear === true) focusCalls.push({ agent: 0, at, clear: true })
      else if (isTaskSegment(call?.track) && isTaskSegment(call.slug)) {
        // A focus on a task whose card is gone still ends the stretch before it, and binds nothing.
        const task = taskOf(call)
        focusCalls.push(task === null ? { agent: 0, at, clear: true } : { agent: 0, at, key: task.key })
      }
    }
    kept = evidence.filter((event) => listed.has(event.agent) && originOf(event.agent).line === undefined)
    const cards = new Map([...tasks].map(([key, task]) => [key, { repos: asArray(task.card.repos) }]))
    timeline = controllerTimeline({ events: { focusCalls, evidence: kept }, startMs: startedMs, endMs, cards })
    const capped = capSegments({ segments: timeline.segments, main: timeline.main, cap: LIMITS.jobSegments })
    timeline.segments = capped.segments
    segmentsCappedMs = capped.droppedMs
  }
  // The task holding worker 0's timeline at a time; the session's last instant belongs to its last segment.
  const controllerAt = (at) => {
    if (at === undefined) return undefined
    const time = Math.min(endMs, Math.max(startedMs, at))
    return timeline.segments.find((segment) => segment.start <= time && (time < segment.end || (time === endMs && segment.end === endMs)))?.key
  }

  // Task key -> Map(worker -> how it got there).
  const members = new Map()
  const join = (key, agent, basis) => {
    if (!members.has(key)) members.set(key, new Map())
    members.get(key).set(agent, basis)
  }
  for (const segment of timeline.segments) join(segment.key, 0, null)
  for (const worker of workers) {
    const n = worker?.n
    if (!Number.isInteger(n) || n < 1) continue
    const { line, top } = originOf(n)
    if (line !== undefined) join(line, n, briefed.has(n) ? "spawn_brief" : "inherited")
    else if (controllerAt(spawnedAt.get(top)) !== undefined) join(controllerAt(spawnedAt.get(top)), n, "inherited")
  }

  const jobs = []
  const ids = new Map()
  for (const [key, task] of tasks) {
    const own = members.get(key)
    if (own === undefined) continue
    const basis = new Set([...own.values()])
    if (timeline.boundBy.get(key) === "focus") basis.add("desk_tool")
    // The evidence that placed worker 0 here; a job only subagents hold rests on their lines alone.
    if (own.has(0)) for (const event of kept) if (event.key === key) basis.add(KIND_BASIS[event.kind])
    const { card } = task
    const status = ENUMS.jobStatus.includes(card.status) ? card.status : null
    let observedAt = null
    if (status !== null && TERMINAL.has(status) && isTime(card.updated_at)) observedAt = card.updated_at
    const segments = timeline.segments.filter((segment) => segment.key === key).map((segment) => ({ start_ms: segment.start - startedMs, end_ms: segment.end - startedMs }))
    const id = jobId({ deskRemote: remote, personPrefix, track: task.birth.track, slug: task.birth.slug })
    ids.set(key, id)
    jobs.push({
      job: id,
      basis: ENUMS.jobBasis.filter((item) => basis.has(item)),
      agents: [...own.keys()].sort((x, y) => x - y),
      task_created_at: isTime(card.created_at) ? card.created_at : null,
      transitions: task.transitions.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).slice(0, LIMITS.jobTransitions),
      observed: status === null ? null : { status, at: observedAt },
      ...(segments.length > 0 ? { segments } : {}),
    })
  }
  jobs.sort((a, b) => (a.job < b.job ? -1 : 1))

  const boundBy = Object.fromEntries([...timeline.boundBy].map(([key, how]) => [ids.get(key), how]).sort(([a], [b]) => (a < b ? -1 : 1)))
  const disagrees = [...timeline.disagrees].map((key) => ids.get(key)).sort()
  const ownActivity = []
  for (const [start, end] of startedMs === null ? [] : spans.sort((a, b) => a[0] - b[0] || a[1] - b[1])) {
    const last = ownActivity.at(-1)
    if (last !== undefined && start - startedMs <= last[1]) last[1] = Math.max(last[1], end - startedMs)
    else ownActivity.push([start - startedMs, end - startedMs])
  }
  return { jobs: jobs.slice(0, LIMITS.jobs), boundBy, disagrees, ownActivity: ownActivity.slice(0, OWN_ACTIVITY_SPANS), repoUnresolved: unresolved.size, segmentsCappedMs }
}
