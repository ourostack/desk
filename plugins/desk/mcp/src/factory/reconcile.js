// `factory reconcile`: compares a desk's real task activity over a time window with the factory's jobs, and
// names every mismatch with a reason code (`reconcile-reasons.js`). Read-only: it reads the desk's Git history
// and cards, the local factory state (markers, receipts, outbox, delivery and quarantine records, consent,
// the visibility cache) and, with `storeDir`, the facts of a local checkout of a store. It never writes, never
// throws, and never reads a session log or prompt: only whether a log exists. A Git failure, an unreadable file
// or a bad JSON file becomes a per-item reason or a `warnings` code.
//
// Desk side. `git log --since --until --name-status -M` on commit dates; `taskCommitRule` (binding.js, the same
// rule the binder uses) classes each task a commit touches: `real`, `housekeeping` (a card edit limited to
// title, track or updated, or a pure rename) or `mass` (a commit spanning more than three tasks). A task with
// only housekeeping or mass commits is `mechanical_only` and not activity. Bound sessions in local facts whose
// span touches the window are activity too.
//
// Reasons, per task with activity (first that explains it wins; see the table in the task report):
//   card_missing   no readable card (a task with no card is never a job)
//   no_marker      no bound session in local facts; the detail counts the desk's unbound markers in the
//                  window (`unbound_markers_<n>`). A task is never blamed on a marker: nothing ties an unbound
//                  marker to a task.
//   not_opted_in, route_changed, held, log_missing   the bound session's marker, pipeline order
//   stale_binding  receipt below BINDING_VERSION
//   quarantined, not_delivered   the outbox file is held, or was never delivered
//   pr_open        delivered, and the store's intake pull request is still open
//   invalid_status the card's status is outside the eight (reported in addition to any other reason)
// `store_only`: a store job whose session falls in the window while the desk shows no real activity for it. A
// job the desk cannot map to a task (unknown, or keyed and not known on this machine) prints `job: null`. On a
// keyed (public) desk the store's job ids are keyed, so `store_only` fires only for jobs with local facts on this
// machine, which place the session in time; the card's `created` plus the offset is not published there.
//
// The top-level `unbound_markers` lists the desk's markers in the window (`since <= time <= until`) that have no
// local facts, each with its own reason from the same pipeline order (`held`, `not_opted_in`, `route_changed`,
// `log_missing`) or `reason: null` when the marker has no problem. It is how `held` and `not_opted_in` stay
// visible without claiming that a marker belongs to a task. `pr_open` read from the last flush alone, with no
// `--store` to check, has the detail `pr_<n>_unchecked`.
//
// Privacy: names tracks and slugs only for the desk given; details are short codes and counts, never prompt
// text, file contents, store names, a local path (the desk is named by its person alias only) or the machine secret.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import * as path from "node:path"

import { checkPersonPrefix, jobId, normalizeRemote, taskCommitRule } from "./binding.js"
import { allTasks, consentDecision, consentRecords, factoryStateDir, readState } from "./boot-check.js"
import { BINDING_VERSION } from "./derive-run.js"
import { createDeskReaders, gitEnv, parseNameStatus, readDeskRemote } from "./desk-repo.js"
import { readSmallText, validMarker } from "./marker.js"
import { validatePublishedBytes } from "./published-schema.js"
import { REFUSALS, keyedJobId } from "./publish.js"
import { RECONCILE_REASONS } from "./reconcile-reasons.js"
import { ENUMS, PATTERNS, isPlainObject } from "./schema.js"
import { RETRACTED_COPIES, derivedStoreOf, deskRootOf, markerRoute, routeProven, sessionPlace, sessionRoute } from "./session-route.js"
import { resolveStore } from "./store-route.js"
import { normalizeTimestamp } from "./time.js"

const SESSION_SRC = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
const OUTBOX_NAME = new RegExp(`^(?:${ENUMS.host.join("|")})-${SESSION_SRC}\\.json$`, "u")
const STORE_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}__[A-Za-z0-9._-]{1,100}$/u
// The refusal codes the flush records in a quarantine record (`outbox.js`, `flush.js`, `publish.js`); any other
// reason in a local file, including the open-ended gate and store-CI codes, is printed as `refused_other`.
const REFUSAL_CODES = new Set(["invalid", "facts_quarantined", "private_plugins_missing", ...REFUSALS])
const GITHUB_REMOTE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})$/u
const PRIVATE_DESKS = new Set(["private", "internal"])
const OPEN_PR_RESULTS = new Set(["delivered_pr_open", "intake_stale_retried"])
const ELSEWHERE_DETAIL = Object.freeze({ __proto__: null, away: "routes_elsewhere", stale: "stale_copy", stalled: "retraction_stalled" })
const MIN_SECRET_BYTES = 32
const GIT_TIMEOUT_MS = 120000

const rank = (reason) => RECONCILE_REASONS.indexOf(reason)
const byKey = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function listNames(dir) {
  try {
    return readdirSync(dir).sort()
  } catch {
    return []
  }
}

function msOf(value) {
  const exact = normalizeTimestamp(value)
  return exact === null ? null : Date.parse(exact)
}

// The commits of the window: `[{ sha, at, entries }]`, or `null` when Git failed.
function gitCommits({ git, root, since, until }) {
  const result = spawnSync(git, [
    "-C", root, "-c", "core.quotepath=off", "-c", "log.showSignature=false",
    "log", `--since=${since}`, `--until=${until}`, "--name-status", "-M", "-z", "--format=%x1e%H%x1f%cI",
  ], { encoding: "utf8", env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
  if (result.error || result.status !== 0) return null
  const commits = []
  for (const record of result.stdout.split("\x1e")) {
    const headerEnd = record.indexOf("\0")
    if (headerEnd === -1) continue
    const [sha, committed] = record.slice(0, headerEnd).split("\x1f")
    const at = normalizeTimestamp(committed)
    if (!/^[0-9a-f]{40,64}$/u.test(sha) || at === null) continue
    commits.push({ sha, at, entries: parseNameStatus(record.slice(headerEnd + 1).replace(/^\n/u, "")) })
  }
  return commits
}

// The paths the commit rule judges: both sides of a rename, except a pure rename (R100), which only moves a task.
function commitPaths(entries) {
  const judged = []
  const moved = []
  for (const entry of entries) {
    if (entry.status === "R100") moved.push(entry.oldPath, entry.path)
    else judged.push(...(entry.oldPath === undefined ? [entry.path] : [entry.oldPath, entry.path]))
  }
  return { judged, moved }
}

function exists(file) {
  try {
    lstatSync(file)
    return true
  } catch {
    return false
  }
}

function isDirectory(dir) {
  try {
    return lstatSync(dir).isDirectory()
  } catch {
    return false
  }
}

function realOf(file) {
  try {
    return realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

/**
 * `reconcile({ deskRoot, personPrefix, since, until, storeDir, env, git })`: see the header. `deskRoot` is an
 * absolute path, `since` and `until` exact UTC timestamps with `since < until`. Returns the report, or
 * `{ ok: false, error }` for a desk that cannot be read; never throws.
 */
export function reconcile(options) {
  try {
    return run(options)
  } catch {
    return { ok: false, error: "reconcile: unexpected failure" }
  }
}

function run({ deskRoot, personPrefix = "", since, until, storeDir = null, env, git = "git" }) {
  const warnings = new Set()
  const warn = (code) => warnings.add(code)

  let root
  let alias
  try {
    root = realpathSync(deskRoot)
    alias = checkPersonPrefix(personPrefix, "reconcile")
  } catch {
    return { ok: false, error: "reconcile: the desk folder could not be read" }
  }
  const sinceMs = Date.parse(since)
  const untilMs = Date.parse(until)
  const overlaps = (start, end) => start !== null && end !== null && start <= untilMs && end >= sinceMs

  const readers = createDeskReaders({ deskRoot: root, personPrefix, git })
  const rule = taskCommitRule({ alias, isCardHousekeeping: readers.isCardHousekeeping })
  const cards = new Map(allTasks({ deskRoot: root, personPrefix }).map((card) => [`${card.track}/${card.slug}`, card]))
  const deskRemote = readDeskRemote({ deskRoot: root, git }) || `local:${root}`

  // job IDs, computed as the task tools compute them (birth path, then `jobId`).
  const jobs = new Map()
  const jobOfKey = (key) => {
    if (!jobs.has(key)) {
      const [track, slug] = key.split("/")
      const birth = cards.has(key) ? readers.resolveJobIdentity(track, slug) : { track, slug }
      jobs.set(key, { job: jobId({ deskRemote, personPrefix, track: birth.track, slug: birth.slug }), birth: `${birth.track}/${birth.slug}` })
    }
    return jobs.get(key)
  }
  let everyJob
  const allJobs = () => {
    if (everyJob === undefined) everyJob = new Map([...cards.keys()].map((key) => [jobOfKey(key).job, key]))
    return everyJob
  }
  let births
  const keyOfBirth = (key) => {
    births ??= new Map([...cards.keys()].map((card) => [jobOfKey(card).birth, card]))
    return births.get(key) ?? key
  }

  // ---- desk activity: commits ----
  const tasks = new Map()
  const taskOf = (rawKey) => {
    const key = cards.has(rawKey) ? rawKey : keyOfBirth(rawKey)
    if (!tasks.has(key)) {
      const [track, slug] = key.split("/")
      tasks.set(key, { key, track, slug, card: cards.get(key) ?? null, commits: [], sessions: [] })
    }
    return tasks.get(key)
  }
  const commits = gitCommits({ git, root, since, until })
  if (commits === null) warn("git_log_failed")
  for (const commit of commits ?? []) {
    const { judged, moved } = commitPaths(commit.entries)
    const verdict = rule(commit.sha, judged)
    const classes = new Map()
    for (const task of verdict.touched) classes.set(`${task.track}/${task.slug}`, "housekeeping")
    for (const task of verdict.real) classes.set(`${task.track}/${task.slug}`, verdict.mass ? "mass" : "real")
    for (const task of rule(commit.sha, moved).touched) {
      if (!classes.has(`${task.track}/${task.slug}`)) classes.set(`${task.track}/${task.slug}`, "housekeeping")
    }
    for (const [key, kind] of classes) taskOf(key).commits.push({ at: commit.at, class: kind })
  }

  // ---- local factory state ----
  const dir = factoryStateDir(env)
  const consent = consentRecords(dir)
  if (consent === null) warn("consent_unreadable")
  const status = readState(path.join(dir, "status.json"), {}) ?? (warn("status_unreadable"), {})
  const deliveredCache = new Map()
  const deliveredOf = (slug) => {
    if (!deliveredCache.has(slug)) deliveredCache.set(slug, readState(path.join(dir, "delivered", `${slug}.json`), {}) ?? (warn("delivered_unreadable"), {}))
    return deliveredCache.get(slug)
  }
  const deliveredSlugs = listNames(path.join(dir, "delivered")).filter((name) => name.endsWith(".json") && STORE_SLUG.test(name.slice(0, -5))).map((name) => name.slice(0, -5))

  // Outbox facts: the sessions bound to each job (local facts only; times are absolute).
  const sessionsByJob = new Map()
  const withFacts = new Set() // outbox file names, in any store
  const localSessions = new Map() // published-comparable session id -> { start, end }
  // A retracted session's kept copy (`retracted-copies/`, see `session-route.js`) is evidence like any outbox file, and what `route_changed` reports.
  const seen = new Set()
  const slugs = new Set([...listNames(path.join(dir, "outbox")), ...listNames(path.join(dir, RETRACTED_COPIES))].filter((name) => STORE_SLUG.test(name)))
  for (const [slug, folder] of [...slugs].sort().flatMap((slug) => [[slug, "outbox"], [slug, RETRACTED_COPIES]])) {
    for (const name of listNames(path.join(dir, folder, slug)).filter((item) => OUTBOX_NAME.test(item))) {
      if (seen.has(`${slug}/${name}`)) continue
      seen.add(`${slug}/${name}`)
      const facts = readState(path.join(dir, folder, slug, name), null)
      const start = msOf(facts?.session?.started_at)
      const end = msOf(facts?.session?.derived_through)
      if (facts === null || !PATTERNS.sessionId.test(String(facts?.session?.id)) || start === null || end === null || !Array.isArray(facts.jobs)) {
        warn("outbox_file_unreadable")
        continue
      }
      withFacts.add(name)
      localSessions.set(facts.session.id, { start, end })
      for (const binding of facts.jobs) {
        if (typeof binding?.job !== "string" || !PATTERNS.jobId.test(binding.job)) continue
        if (!sessionsByJob.has(binding.job)) sessionsByJob.set(binding.job, [])
        sessionsByJob.get(binding.job).push({ slug, name, start, end, created: msOf(binding.task_created_at) })
      }
    }
  }

  // Bound sessions touching the window are activity too.
  for (const [job, sessions] of sessionsByJob) {
    const touching = sessions.filter((session) => overlaps(session.start, session.end))
    if (touching.length === 0) continue
    const key = allJobs().get(job)
    if (key !== undefined) taskOf(key)
  }

  // Markers of this desk in the window (a marker is read lazily, by name).
  const markerCache = new Map()
  const markerOf = (name) => {
    if (!markerCache.has(name)) {
      let marker = null
      try {
        const parsed = JSON.parse(readSmallText(path.join(dir, "markers", name)))
        marker = validMarker(parsed) && `${parsed.host}-${parsed.session_id}.json` === name ? parsed : null
      } catch (error) {
        if (error.code !== "ENOENT") warn("marker_unreadable")
      }
      markerCache.set(name, marker)
    }
    return markerCache.get(name)
  }
  const markerNames = listNames(path.join(dir, "markers")).filter((name) => OUTBOX_NAME.test(name))
  const markerTime = (marker) => msOf(marker.ended_at ?? marker.updated_at)
  // Markers with no outbox file: sessions that never became facts. A marker with facts is explained by its own job.
  const deskMarkers = markerNames.filter((name) => !withFacts.has(name)).map((name) => ({ name, marker: markerOf(name) })).filter(({ marker }) => marker !== null && marker.desk_root !== null
    && realOf(marker.desk_root) === root && (marker.person_prefix ?? "") === personPrefix && markerTime(marker) >= sinceMs && markerTime(marker) <= untilMs)
  // A Codex marker's default route is proven only by a Claude Code or Copilot marker for the desk within 30 days, as the sweep and the flush prove it.
  const siblings = () => markerNames.map(markerOf).filter((other) => other !== null)
  const proven = (marker) => routeProven(marker, siblings())

  // Why a marker's session did not become delivered facts, or `null`: held, consent, route, log, in pipeline order.
  const markerProblem = (name, marker) => {
    if (marker.desk_root === null) return { reason: "held", detail: "no_desk_root" }
    const route = markerRoute(marker)
    const store = route.store
    if (store === null) return { reason: "held", detail: "store_unresolved" }
    if (consentDecision(consent, store) !== "yes") return { reason: "not_opted_in", detail: "store_without_consent" }
    const slug = store.replace("/", "__")
    if (deliveredSlugs.some((other) => other !== slug && Object.hasOwn(deliveredOf(other), name))) return { reason: "route_changed", detail: "delivered_to_other_store" }
    if (marker.host === "codex-cli" && route.source === "default" && !proven(marker)) return { reason: "held", detail: "route_unverified" }
    return exists(marker.log_path) ? null : { reason: "log_missing", detail: "log_absent" }
  }

  // ---- the store ----
  const storeFacts = new Map() // store job id -> [{ id, start, end }]
  let deskPrivate = true
  let secret = null
  if (storeDir !== null) {
    const repo = GITHUB_REMOTE.exec(normalizeRemote(deskRemote))?.[1]?.toLowerCase() ?? null
    const visibility = readState(path.join(dir, "visibility.json"), {}) ?? (warn("visibility_unreadable"), {})
    deskPrivate = repo !== null && PRIVATE_DESKS.has(visibility[Object.keys(visibility).find((name) => name.toLowerCase() === repo)]?.visibility)
    if (!deskPrivate) {
      try {
        const bytes = readFileSync(path.join(dir, "machine-secret"))
        if (bytes.length >= MIN_SECRET_BYTES) secret = new Uint8Array(bytes)
      } catch {
        // Reported below.
      }
      if (secret === null) warn("machine_secret_unavailable")
    }
    const factsDir = path.join(storeDir, "facts")
    const names = listNames(factsDir).filter((name) => name.endsWith(".json"))
    if (names.length === 0 && !isDirectory(factsDir)) warn("store_facts_missing")
    for (const name of names) {
      let published = null
      try {
        const bytes = readFileSync(path.join(factsDir, name))
        if (validatePublishedBytes(bytes).ok) published = JSON.parse(bytes.toString("utf8"))
      } catch {
        // Counted below.
      }
      if (published === null) {
        warn("store_file_unreadable")
        continue
      }
      for (const job of published.jobs) {
        if (!storeFacts.has(job.job)) storeFacts.set(job.job, [])
        const local = localSessions.get(published.session.id)
        storeFacts.get(job.job).push({ id: published.session.id, local, offset: job.session_offset_ms, duration: published.session.duration_ms })
      }
    }
  }
  const storeIdOf = (job) => (deskPrivate ? job : secret === null ? null : keyedJobId(job, secret))
  // Where a store session sits in time: local facts when this machine has them, else the card's `created` plus the offset.
  const placement = (session, created) => {
    if (session.local !== undefined) return session.local
    if (created === null || created === undefined || session.offset === null) return null
    const start = created + session.offset
    return { start, end: start + session.duration }
  }

  // ---- reasons ----
  const createdMs = (card) => (card?.created ? Date.parse(card.created) : null)
  const inWindow = (session, created) => {
    const place = placement(session, created)
    return place !== null && overlaps(place.start, place.end)
  }
  const mismatches = []
  const report = []
  const push = (task, reason, detail) => mismatches.push({ track: task.track, slug: task.slug, job: task.job, reason, detail })
  const openPr = (slug) => {
    const flush = status.last_flush?.[slug.replace("__", "/")]
    if (!OPEN_PR_RESULTS.has(flush?.result)) return null
    if (!Number.isSafeInteger(flush.pr)) return "pr_open"
    return storeDir === null ? `pr_${flush.pr}_unchecked` : `pr_${flush.pr}`
  }

  // Why an outbox file's session is placed elsewhere than the store whose outbox holds it, read as the flush and the local status read it
  // (`session-route.js`), or `undefined`: the flush never publishes it there. `away` (a positive route elsewhere, or a finished retraction's
  // tombstone) is `routes_elsewhere`, `stale` (its last known route is another store) is `stale_copy`, and `stalled` (a retraction open with no
  // positive route) is `retraction_stalled`. An unreadable retracting file reads as none.
  const retractingCache = new Map()
  const retractingOf = (slug) => {
    if (!retractingCache.has(slug)) retractingCache.set(slug, readState(path.join(dir, "retracting", `${slug}.json`), {}) ?? {})
    return retractingCache.get(slug)
  }
  const elsewhere = (session) => {
    const id = session.name.slice(-41, -5)
    const names = ENUMS.host.map((host) => `${host}-${id}.json`)
    const marker = names.map(markerOf).find((found) => found !== null) ?? null
    const records = Object.entries(retractingOf(session.slug)).filter(([key, record]) => key.slice(-41, -5) === id && isPlainObject(record)).map(([, record]) => record)
    const route = sessionRoute(marker, { siblings, deskRoot: deskRootOf(status.derivations, names) })
    return ELSEWHERE_DETAIL[sessionPlace(session.slug.replace("__", "/"), route, derivedStoreOf(status.derivations, names), records)]
  }

  // Why one outbox file's session is not delivered facts in the store, or `null` when it is.
  const sessionProblem = (session, inStore) => {
    const moved = elsewhere(session)
    if (moved !== undefined) return { reason: "route_changed", detail: moved }
    const marker = markerOf(session.name)
    const fromMarker = marker === null ? null : markerProblem(session.name, marker)
    if (fromMarker !== null) return fromMarker
    const receipt = status.derivations?.[session.name]
    if (!(receipt?.binding_version >= BINDING_VERSION)) return { reason: "stale_binding", detail: `binding_version_${Number.isSafeInteger(receipt?.binding_version) ? receipt.binding_version : "none"}` }
    const held = readState(path.join(dir, "quarantine", session.slug, session.name), undefined)
    if (held !== undefined) return { reason: "quarantined", detail: `refused_${REFUSAL_CODES.has(held?.reason) ? held.reason : "other"}` }
    if (!Object.hasOwn(deliveredOf(session.slug), session.name)) return { reason: "not_delivered", detail: "outbox_only" }
    const open = inStore ? null : openPr(session.slug)
    return open === null ? null : { reason: "pr_open", detail: open }
  }

  // The reason a task with real activity is not counted, or `null`: the best bound session's. No bound session is `no_marker`.
  const taskProblem = (bound, inStore) => {
    if (bound.length === 0) return { reason: "no_marker", detail: `unbound_markers_${deskMarkers.length}` }
    let furthest = null
    for (const session of bound) {
      const problem = sessionProblem(session, inStore)
      if (problem === null) return null
      if (furthest === null || rank(problem.reason) > rank(furthest.reason)) furthest = problem
    }
    return furthest
  }

  const storeToPlain = new Map()
  if (storeDir !== null) {
    for (const plain of [...allJobs().keys(), ...sessionsByJob.keys()]) {
      const id = storeIdOf(plain)
      if (id !== null) storeToPlain.set(id, plain)
    }
  }

  for (const task of [...tasks.values()].sort((a, b) => byKey(a.key, b.key))) {
    task.job = jobOfKey(task.key).job
    const bound = (sessionsByJob.get(task.job) ?? []).filter((session) => overlaps(session.start, session.end))
    const real = task.commits.some((commit) => commit.class === "real") || bound.length > 0
    const storeId = storeIdOf(task.job)
    const storeSessions = storeId === null ? null : storeFacts.get(storeId) ?? []
    const before = mismatches.length

    if (!real) push(task, "mechanical_only", `commits_${task.commits.length}`)
    else if (task.card === null) push(task, "card_missing", "no_card")
    else {
      const problem = taskProblem(bound, storeSessions !== null && storeSessions.length > 0)
      if (problem !== null) push(task, problem.reason, problem.detail)
      if (!ENUMS.jobStatus.includes(task.card.status)) push(task, "invalid_status", "status_outside_lifecycle")
    }
    // The factory counted a session in the window that the desk's history does not show as real work.
    if (!real && storeSessions !== null && storeSessions.some((session) => inWindow(session, createdMs(task.card)))) push(task, "store_only", "store_session_in_window")

    report.push({
      track: task.track,
      slug: task.slug,
      job: task.job,
      activity: [
        ...task.commits.map((commit) => ({ kind: "commit", at: commit.at, class: commit.class })),
        ...bound.map((session) => ({ kind: "session", session: session.name.slice(0, -5), start: new Date(session.start).toISOString(), end: new Date(session.end).toISOString() })),
      ],
      store: storeDir === null ? { checked: false } : { checked: true, sessions: storeSessions === null ? null : storeSessions.length },
      mismatched: mismatches.length > before,
    })
  }

  // Store jobs in the window that no task above covers.
  for (const [storeId, sessions] of storeFacts) {
    const plain = storeToPlain.get(storeId) ?? null
    const key = plain === null ? null : allJobs().get(plain) ?? null
    if (key !== null && tasks.has(key)) continue
    const created = key === null ? sessionsByJob.get(plain)?.[0]?.created ?? null : createdMs(cards.get(key))
    if (!sessions.some((session) => inWindow(session, created))) continue
    const [track, slug] = key === null ? [null, null] : key.split("/")
    mismatches.push({ track, slug, job: plain ?? (deskPrivate ? storeId : null), reason: "store_only", detail: "store_session_in_window" })
    if (key !== null) report.push({ track, slug, job: plain, activity: [], store: { checked: true, sessions: sessions.length }, mismatched: true })
  }

  mismatches.sort((a, b) => byKey(`${a.track}/${a.slug}`, `${b.track}/${b.slug}`) || rank(a.reason) - rank(b.reason))
  const byReason = {}
  for (const reason of RECONCILE_REASONS) {
    const count = mismatches.filter((item) => item.reason === reason).length
    if (count > 0) byReason[reason] = count
  }
  const outTasks = report.map(({ mismatched, ...rest }) => rest)
  return {
    ok: true,
    window: { since, until },
    desk: { person: alias },
    tasks: outTasks,
    mismatches,
    unbound_markers: deskMarkers.map(({ name, marker }) => ({ session: name.slice(0, -5), ...(markerProblem(name, marker) ?? { reason: null, detail: "marker_not_bound" }) })),
    counts: { tasks: report.length, matched: report.filter((item) => !item.mismatched).length, mismatched: mismatches.length, by_reason: byReason },
    ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
  }
}
