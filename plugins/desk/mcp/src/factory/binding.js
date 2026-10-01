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
// nothing.
//
// A `desk_commit` whose only change inside a task's folder is the card
// itself, `task.md` (matched case-insensitively), binds only when that
// change is real. The commit's diff of the card is read
// (`isCardHousekeeping`), and the touch is dropped when the card was
// renamed or moved with no content change (an exact, R100-equivalent
// rename) or when the only lines that differ are frontmatter `title:`,
// `track:` or `updated:`. A changed `status`, a changed body (so a
// checkbox toggle or a progress note binds), or any other changed
// frontmatter field makes it a real touch, and it binds. A `file_write`
// cannot be read this way: the deriver hands the binder a path only, never
// the write's or edit's content, so a bare-card `file_write` always binds,
// the same as any other write in the folder — that is how a hand-edited
// card (`skills/task-lifecycle` has agents toggle checkboxes and add
// progress notes this way, since `task_update` cannot) still counts as
// work. `task_update`, `task_create` and `task_archive` bind their task
// precisely through `desk_tool` either way. A task whose card is found
// neither live nor archived is not a job. A session with no jobs gets
// `jobs: []`.
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
// Controller segments. When the controller (worker 0) has evidence of its
// own for two or more jobs and the caller passes the session's
// `started_at` and `derived_through`, each of those jobs also gets
// `segments`: the spans of the session, in milliseconds from its start,
// that worker 0's evidence gives to the job (`controllerSegments`). The
// pipeline clips worker 0's time to them and credits worker 0's PRs by them,
// so the controller's time is split across its jobs instead of copied into
// each. A session whose controller binds one job gets no `segments`.
//
// A job's ID hashes its task's *birth* path, not the path a touch was
// matched against: once a task is found (`readTask` answers), `entry.track`
// and `entry.slug` are handed to `resolveJobIdentity`, which is where the
// desk's Git decides whether the task has ever been renamed or moved (the
// controller ruling in ourostack/desk#76). This is how a track rename or a
// task move keeps one job's history in one place instead of starting a new
// job at zero.
//
// Dependencies are injected so tests can fake them (`desk-repo.js` has the
// real ones): `readTask(track, slug)`, `deskCommitsBetween(startIso,
// endIso)`, `gitCommitTaskPaths(sha)`, `isCardHousekeeping(sha, path)` and
// `resolveJobIdentity(track, slug)`. The desk root is passed in rather than
// resolved here: `src/util/paths.js` is outside `src/factory`, so the
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

const CARD_FILE = "task.md"

// A desk commit spanning more tasks than this is a sweep and binds none.
const MASS_COMMIT_TASKS = 3

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
 * `controllerSegments({ evidence, keys, startedMs, endMs })`: the controller's
 * session split among its jobs, as `Map(key -> [{ start_ms, end_ms, shared? }])`,
 * or `null` when it cannot be split (then no job gets `segments` and the
 * pipeline counts worker 0's whole time in each of its jobs, marked partial).
 *
 * `evidence` is worker 0's binding evidence, `{ key, start, end }` in epoch
 * milliseconds (`start` null when the evidence has no time; an instant has
 * `end === start`), and `keys` the jobs worker 0 binds. Times are clamped to
 * the session, `[0, endMs - startedMs]`. Evidence starting at one instant forms
 * a group. The stretch from one group's start to the next group's belongs to
 * the group's jobs, the stretch before the first group to the first group's,
 * and the last group's runs to the session's end. A span covered by a timed
 * piece (a commit window, a spawn) also belongs to its job. A stretch with
 * more than one job is held by each of them, marked `shared`. Adjacent pieces
 * of one job with the same marking merge. No split when a job has no timed
 * evidence, a job would end with no time at all (its evidence clamped to the
 * session's end, say), or any job would need more than `LIMITS.jobSegments`
 * segments.
 */
export function controllerSegments({ evidence, keys, startedMs, endMs }) {
  const total = endMs - startedMs
  const clamp = (ms) => Math.min(total, Math.max(0, ms - startedMs))
  const items = evidence
    .filter((item) => keys.has(item.key) && item.start !== null)
    .map((item) => ({ key: item.key, start: clamp(item.start), end: clamp(Math.max(item.start, item.end)) }))
    .sort((x, y) => x.start - y.start || x.end - y.end || (x.key < y.key ? -1 : x.key > y.key ? 1 : 0))
  const timedKeys = new Set(items.map((item) => item.key))
  if ([...keys].some((key) => !timedKeys.has(key))) return null

  const spans = items.filter((item) => item.end > item.start)
  const bounds = [...new Set([0, total, ...items.flatMap((item) => [item.start, item.end])])].sort((x, y) => x - y)
  const segments = new Map([...keys].map((key) => [key, []]))
  // The jobs of the latest group to start; before the first evidence, the first group's.
  const groupAt = (instant) => new Set(items.filter((item) => item.start === instant).map((item) => item.key))
  let group = groupAt(items[0].start)
  let next = 0
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const start = bounds[index]
    const end = bounds[index + 1]
    if (next < items.length && items[next].start <= start) {
      while (next < items.length && items[next].start <= start) next += 1
      group = groupAt(items[next - 1].start)
    }
    const owners = new Set([...group, ...spans.filter((item) => item.start <= start && start < item.end).map((item) => item.key)])
    const shared = owners.size > 1
    for (const key of owners) {
      const list = segments.get(key)
      const last = list.at(-1)
      if (last !== undefined && last.end_ms === start && Object.hasOwn(last, "shared") === shared) last.end_ms = end
      else list.push(shared ? { start_ms: start, end_ms: end, shared: true } : { start_ms: start, end_ms: end })
    }
  }
  const lists = [...segments.values()]
  if (lists.some((list) => list.length === 0)) return null
  return lists.some((list) => list.length > LIMITS.jobSegments) ? null : segments
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
 * readTask, deskCommitsBetween, gitCommitTaskPaths, isCardHousekeeping,
 * resolveJobIdentity }) -> { jobs: LocalJob[] }`. `agents` is the facts'
 * `agents[]` (`{ n, parent }`), used for ancestry; each job lists the
 * workers bound to it in `agents`. Every event counts as worker 0 without it. `deskRemote` is the desk's
 * `origin` URL, or empty when it has none (the job IDs then use `local:`
 * plus the desk root). `session` is the facts' `session` (`started_at` and
 * `derived_through` are read); without it, or without `agents`, no job gets
 * `segments`.
 */
export function bindSession({ events, agents, session, deskRoot, deskRemote, personPrefix, readTask, deskCommitsBetween, gitCommitTaskPaths, isCardHousekeeping, resolveJobIdentity }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("bindSession: deskRoot must be an absolute path")
  const alias = checkPersonPrefix(personPrefix, "bindSession")
  requireFunction(readTask, "readTask")
  requireFunction(deskCommitsBetween, "deskCommitsBetween")
  requireFunction(gitCommitTaskPaths, "gitCommitTaskPaths")
  requireFunction(isCardHousekeeping, "isCardHousekeeping")
  requireFunction(resolveJobIdentity, "resolveJobIdentity")
  if (deskRemote !== undefined && deskRemote !== null && typeof deskRemote !== "string") throw new TypeError("bindSession: deskRemote must be a string or empty")
  // One unpublished desk reached through a symlink and through its real path is one desk.
  const remote = typeof deskRemote === "string" && deskRemote.trim() !== "" ? deskRemote : `local:${realOrResolved(deskRoot)}`
  const roots = deskRootsOf(deskRoot)
  const source = events ?? {}

  // "track/slug" -> { track, slug, transitions: [] }, and worker -> ("track/slug" -> basis Set).
  const tasks = new Map()
  const evidence = new Map()
  // Without `agents` (a legacy caller) every event is the root worker's (0).
  const hasAgents = Array.isArray(agents)
  const agentOf = (item) => (hasAgents && Number.isInteger(item?.agent) && item.agent >= 0 ? item.agent : 0)
  // With `agents`, a worker it does not list contributes no evidence: the
  // facts could not name it in a job's `agents`, and the validator refuses that.
  const listed = new Set((hasAgents ? agents : []).map((worker) => worker?.n))
  const parents = new Map()
  for (const worker of hasAgents ? agents : []) {
    if (Number.isInteger(worker?.n) && Number.isInteger(worker.parent)) parents.set(worker.n, worker.parent)
  }
  // Worker 0's evidence with its time, for its segments: `{ key, start, end }` in epoch ms.
  const controller = []
  // `start` and `end` (epoch ms, `start` null when untimed) place the evidence in time.
  const touch = (agent, task, basis, start = null, end = start) => {
    if (hasAgents && !listed.has(agent)) return { transitions: [] }
    const key = `${task.track}/${task.slug}`
    if (!tasks.has(key)) tasks.set(key, { track: task.track, slug: task.slug, transitions: [] })
    if (!evidence.has(agent)) evidence.set(agent, new Map())
    const own = evidence.get(agent)
    if (!own.has(key)) own.set(key, new Set())
    own.get(key).add(basis)
    if (agent === 0) controller.push({ key, start, end })
    return tasks.get(key)
  }
  // Worker 0's spawn calls, timed by the spawning call: they place worker 0 in time but bind nothing for it.
  const spawnSpans = []
  // The tasks a commit's paths bind (`taskCommitRule` judges).
  const rule = taskCommitRule({ alias, isCardHousekeeping })
  const commitTasks = (sha, taskPaths) => rule(sha, taskPaths).tasks

  for (const call of asArray(source.deskToolCalls)) {
    if (call?.ok !== true || !isTaskSegment(call.track) || !isTaskSegment(call.slug)) continue
    const entry = touch(agentOf(call), { track: call.track, slug: call.slug }, "desk_tool", msOf(call.at))
    if (ENUMS.jobStatus.includes(call.status) && isTime(call.at)) entry.transitions.push({ to: call.status, at: call.at })
  }

  for (const write of asArray(source.fileWrites)) {
    const segments = segmentsInDesk(write?.path, roots)
    const task = segments === null ? null : taskOfSegments(segments, alias)
    if (task !== null) touch(agentOf(write), task, "file_write", msOf(write.at))
  }

  // A brief naming a task with a card is that worker's own evidence.
  for (const spawn of asArray(source.spawnTasks)) {
    if (!isTaskSegment(spawn?.track) || !isTaskSegment(spawn.slug)) continue
    const card = readTask(spawn.track, spawn.slug)
    if (card === null || card === undefined) continue
    const child = agentOf(spawn)
    touch(child, { track: spawn.track, slug: spawn.slug }, "spawn_brief")
    if (hasAgents && listed.has(child) && parents.get(child) === 0) {
      const start = msOf(spawn.start)
      const end = msOf(spawn.end)
      if (start !== null && end !== null) spawnSpans.push({ key: `${spawn.track}/${spawn.slug}`, start, end })
    }
  }

  const windows = []
  for (const call of asArray(source.shellGitCommits)) {
    if (!isTime(call?.start) || !isTime(call.end) || call.end < call.start) continue
    if (segmentsInDesk(expandDeskMarker(call.cwd, roots[0]), roots) === null) continue
    windows.push({ start: floorToSecond(call.start), end: call.end, agent: agentOf(call) })
  }
  if (windows.length > 0) {
    const first = windows.reduce((earliest, window) => (window.start < earliest ? window.start : earliest), windows[0].start)
    const last = windows.reduce((latest, window) => (window.end > latest ? window.end : latest), windows[0].end)
    for (const commit of asArray(deskCommitsBetween(first, last))) {
      const at = commit?.committed_at
      if (!isTime(at)) continue
      const owners = windows.filter((window) => at >= window.start && at <= window.end)
      if (owners.length === 0) continue
      const bound = commitTasks(commit.sha, commit.taskPaths)
      for (const owner of owners) for (const task of bound) touch(owner.agent, task, "desk_commit", msOf(owner.start), msOf(owner.end))
    }
  }

  for (const entry of asArray(source.nativeCommitShas)) {
    const sha = entry?.sha
    if (typeof sha !== "string" || !PATTERNS.commitSha.test(sha)) continue
    const found = gitCommitTaskPaths(sha)
    if (found?.exists === true) for (const task of commitTasks(sha, found.taskPaths)) touch(agentOf(entry), task, "desk_commit")
  }

  // Only a task with a card is a job.
  const cards = new Map()
  for (const key of tasks.keys()) {
    const task = tasks.get(key)
    const card = readTask(task.track, task.slug)
    if (card !== null && card !== undefined) cards.set(key, card)
  }
  const ownJobs = new Map() // worker -> Map(key -> basis Set), jobs with a card only
  for (const [agent, own] of evidence) {
    const kept = new Map([...own].filter(([key]) => cards.has(key)))
    if (kept.size > 0) ownJobs.set(agent, kept)
  }
  // A worker with no evidence of its own inherits from its nearest ancestor
  // that has some, when that ancestor binds exactly one job; the walk stops
  // at the first ancestor with evidence, and at a cycle or unknown parent.
  const bound = new Map(ownJobs) // worker -> Map(key -> basis Set)
  for (const worker of hasAgents ? agents : []) {
    if (!Number.isInteger(worker?.n) || ownJobs.has(worker.n)) continue
    const seen = new Set([worker.n])
    let ancestor = parents.get(worker.n)
    while (ancestor !== undefined && !seen.has(ancestor) && !ownJobs.has(ancestor)) {
      seen.add(ancestor)
      ancestor = parents.get(ancestor)
    }
    const inherited = ancestor === undefined || seen.has(ancestor) ? null : ownJobs.get(ancestor)
    if (inherited !== null && inherited.size === 1) bound.set(worker.n, new Map([[inherited.keys().next().value, new Set(["inherited"])]]))
  }

  // The controller's session split among its jobs, when it binds several.
  const startedMs = msOf(session?.started_at)
  const endMs = msOf(session?.derived_through)
  const controllerKeys = new Set(ownJobs.get(0)?.keys() ?? [])
  const split = hasAgents && controllerKeys.size > 1 && startedMs !== null && endMs !== null && endMs >= startedMs
    ? controllerSegments({ evidence: [...controller, ...spawnSpans], keys: controllerKeys, startedMs, endMs })
    : null

  const jobs = []
  for (const [key, card] of cards) {
    const entry = tasks.get(key)
    const basis = new Set()
    const workers = []
    for (const [agent, own] of bound) {
      if (!own.has(key)) continue
      workers.push(agent)
      for (const item of own.get(key)) basis.add(item)
    }
    const status = ENUMS.jobStatus.includes(card.status) ? card.status : null
    let observedAt = null
    if (status !== null && TERMINAL.has(status) && isTime(card.updated_at)) observedAt = card.updated_at
    const birth = resolveJobIdentity(entry.track, entry.slug)
    jobs.push({
      job: jobId({ deskRemote: remote, personPrefix, track: birth.track, slug: birth.slug }),
      basis: ENUMS.jobBasis.filter((item) => basis.has(item)),
      // A legacy caller passes no `agents`: the key is left out, which reads as every worker.
      ...(hasAgents ? { agents: workers.sort((x, y) => x - y) } : {}),
      task_created_at: isTime(card.created_at) ? card.created_at : null,
      transitions: entry.transitions.sort((x, y) => (x.at < y.at ? -1 : x.at > y.at ? 1 : 0)).slice(0, LIMITS.jobTransitions),
      observed: status === null ? null : { status, at: observedAt },
      ...(split?.has(key) ? { segments: split.get(key) } : {}),
    })
  }
  jobs.sort((a, b) => (a.job < b.job ? -1 : 1))
  return { jobs: jobs.slice(0, LIMITS.jobs) }
}
