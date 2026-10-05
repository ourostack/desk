// `factory reconcile`: compares a desk's real task activity over a time window with the factory's jobs, and
// names every mismatch with a reason code (`reconcile-reasons.js`). Read-only: it reads the desk's Git history
// and cards, the local factory state (markers, receipts, outbox, delivery and quarantine records, consent,
// the visibility cache) and, with `storeDir`, the facts of a local checkout of a store. It never writes, never
// throws, and never reads a session log or prompt: only whether a log exists. A Git failure, an unreadable file
// or a bad JSON file becomes a per-item reason or a `warnings` code.
//
// Desk side. `git log --since --until --name-status -M` on commit dates; `taskCommitRule` (binding.js, the same
// rule the binder uses) classes each task a commit touches: `real`, `housekeeping` (a card edit limited to
// title, track or updated, or a pure rename), `mass` (a commit spanning more than three tasks) or `tidy` (a
// commit with a `Desk-Tidy: true` trailer, or, for history, a subject starting `Tidy desk`, `Revert the desk
// tidy` or `Revert "Tidy desk`; the subject is matched and never kept). A task is real work in the window when
// it has a real commit, or a bound session holds time in the window: a job holds its segments, not its whole
// session (a job with none holds the whole session). A task with neither is listed in `housekeeping_cards`
// and in no mismatch, unless the store counted a session of it in the window (`store_only`).
//
// Measures. A number that may be missing is never a bare number, 0, null or a string: it is `{ state, value }` (`measure`), `state` one of
// `measured` (with `value`), `not_recorded` (the receipt or facts cannot say), `not_checked` (the check was not run, as `status_unobserved`
// without `--store`) or `withheld` (the desk keeps no job timing, so the pipeline publishes no timeline). A total over several is
// `{ state, value, of, not_recorded }`: `of` were measured, `not_recorded` were not, and `value` is a floor when `not_recorded` is above zero.
//
// Story. Each listed task carries `story`: its bound sessions by start, each with `active_ms` (a measure: the session's turn, tool and subagent
// time cut to the job exactly as the pipeline publishes it, `jobActiveMs`, never a segment's wall span; `not_recorded` where the pipeline would
// publish nothing or the facts cannot be read, `withheld` on a desk not known to be private) and `bound_by`, from the local receipt: `focus`,
// `inferred`, `subagent_only` (a current receipt with no entry for the job: only subagents worked it) or `not_recorded` (a receipt older
// than BINDING_VERSION, or none). `counts.bound_by` counts the story entries each way. The top-level `sessions` lists each story session once
// with the receipt's two measures, `segments_capped_ms` and `repository_evidence_unavailable` (the receipt's `repo_unresolved`: directories
// that no longer exist), each a measure that is `not_recorded` when the receipt predates it; `counts` gives their totals. `counts.mentioned`
// is a total over the sessions that recorded their own activity for this desk (`of`; `not_recorded` counts this desk's sessions in the window
// that did not, and sessions recorded for another desk are in neither); it is `not_recorded` when none did.
//
// Reasons, per task with real work (first that explains it wins; see the table in the task report):
//   card_missing   no readable card (a task with no card is never a job)
//   not_bound      no bound session, and a real commit that no session bound to another task owns by its receipt's `own_activity`
//                  (a session that bound no task and recorded its activity does not explain it);
//                  the detail counts the desk's unbound markers in the window (`unbound_markers_<n>`). A task
//                  is never blamed on a marker: nothing ties an unbound marker to a task. A real commit inside
//                  the own activity of a session bound to another task is `counts.mentioned`, not a mismatch.
//   not_opted_in, route_changed, held, log_missing   the bound session's marker, pipeline order
//   stale_binding  receipt below BINDING_VERSION
//   receipt_too_old  no bound session, and a real commit that no recorded own activity owns but a session of this desk overlaps whose receipt
//                  predates `own_activity` (it names this desk, or binds one of its tasks): it may have made the commit, so `not_bound` would be untrue
//   focus_disagrees  the receipt says a declared stretch held none of the job's own events (reported in addition)
//   quarantined, not_delivered   the outbox file is held, or was never delivered
//   pr_open        delivered, and the store's intake pull request is still open
//   invalid_status the card's status is outside the eight (reported in addition to any other reason)
//   status_unobserved  with `--store`: the card's status differs from the latest status the store observed
//                  for the job (a transition on a card outside a session's focus is not recorded)
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

import { checkPersonPrefix, jobId, taskCommitRule } from "./binding.js"
import { allTasks, consentDecision, consentRecords, factoryStateDir, readState } from "./boot-check.js"
import { BINDING_VERSION } from "./derive-run.js"
import { deskTimingKept, deskVisibilityOf, freshVisibility, githubRepoOfRemote, visibilityMap } from "./desk-visibility.js"
import { createDeskReaders, gitEnv, parseNameStatus, readDeskRemote } from "./desk-repo.js"
import { readSmallText, validMarker } from "./marker.js"
import { PUBLISHED_LIMITS, validatePublishedBytes } from "./published-schema.js"
import { REFUSALS, keyedJobId } from "./publish.js"
import { jobActiveMs } from "./pipeline/timeline.js"
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
const OPEN_PR_RESULTS = new Set(["delivered_pr_open", "intake_stale_retried"])
const ELSEWHERE_DETAIL = Object.freeze({ __proto__: null, away: "routes_elsewhere", stale: "stale_copy", stalled: "retraction_stalled" })
const MIN_SECRET_BYTES = 32
const GIT_TIMEOUT_MS = 120000
// A commit is a tidy when its subject starts like this (history from before the `Desk-Tidy: true` trailer) or it carries the trailer.
const TIDY_SUBJECT = /^(?:Tidy desk|Revert the desk tidy|Revert "Tidy desk)/u
const NOT_RECORDED = "not_recorded" // a category (`bound_by`) with no value; a number that may be missing is a `measure`
const BOUND_BY_VALUES = new Set(["focus", "inferred"])

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

// The commits of the window: `[{ sha, at, tidy, entries }]`, or `null` when Git failed.
function gitCommits({ git, root, since, until }) {
  const result = spawnSync(git, [
    "-C", root, "-c", "core.quotepath=off", "-c", "log.showSignature=false",
    "log", `--since=${since}`, `--until=${until}`, "--name-status", "-M", "-z", "--format=%x1e%H%x1f%cI%x1f%s%x1f%(trailers:key=Desk-Tidy,valueonly)",
  ], { encoding: "utf8", env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] })
  if (result.error || result.status !== 0) return null
  const commits = []
  for (const record of result.stdout.split("\x1e")) {
    const headerEnd = record.indexOf("\0")
    if (headerEnd === -1) continue
    const [sha, committed, subject = "", ...trailers] = record.slice(0, headerEnd).split("\x1f")
    const at = normalizeTimestamp(committed)
    if (!/^[0-9a-f]{40,64}$/u.test(sha) || at === null) continue
    // The subject and trailer are read to tell a tidy and are never kept.
    const tidy = TIDY_SUBJECT.test(subject) || trailers.join("").split("\n").some((line) => line.trim().toLowerCase() === "true")
    commits.push({ sha, at, tidy, entries: parseNameStatus(record.slice(headerEnd + 1).replace(/^\n/u, "")) })
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

// The one way this report gives a number that may be missing: `{ state, value }`, `state` one of `measured`, `not_recorded` (the receipt
// or facts cannot say), `not_checked` (the check was not run) or `withheld` (the desk withholds job timing), and `value` only when measured.
// A total adds `of` (how many were measured) and `not_recorded` (how many were not), so a measured total is a floor when `not_recorded` is
// above zero. A consumer reads `state` first and never sums a raw field.
function measure(state, value, population = {}) {
  return { state, ...(state === "measured" ? { value } : {}), ...population }
}

// The total of measures over a population: measured when any was, with how many were and were not.
function totalOf(measures) {
  const recorded = measures.filter((item) => item.state === "measured")
  return measure(recorded.length === 0 ? "not_recorded" : "measured", recorded.reduce((sum, item) => sum + item.value, 0), { of: recorded.length, not_recorded: measures.length - recorded.length })
}

const isSpan = (item) => isPlainObject(item) && Number.isFinite(item.start_ms) && Number.isFinite(item.end_ms)

// Where a job holds its session, as absolute `[start, end]` spans: its segments, or the whole session when it has none (a job with only
// subagents holds no controller time).
function jobSpans(binding, start, end) {
  if (!Array.isArray(binding.segments)) return [[start, end]]
  return binding.segments.filter(isSpan).map((segment) => [start + segment.start_ms, start + segment.end_ms])
}

// The active time the pipeline would publish for this session and job (`jobActiveMs`, the pipeline's own rule, fed the session as publishing
// would carry it: offsets in ms from the session's start, the job's offset from its card's creation time) as a measure, `not_recorded` where
// the pipeline would publish nothing (no readable card creation time, an offset beyond the published limit) or the facts cannot be read as that.
function activeMsOf(facts, binding, startedMs, created) {
  try {
    const offset = created === null ? null : startedMs - created
    const active = jobActiveMs({
      duration_ms: Date.parse(facts.session.derived_through) - startedMs,
      intervals: facts.intervals.map((interval) => ({ ...interval, start_ms: Date.parse(interval.start) - startedMs, end_ms: Date.parse(interval.end) - startedMs })),
    }, { ...binding, session_offset_ms: offset !== null && Math.abs(offset) <= PUBLISHED_LIMITS.maxOffsetMs ? offset : null })
    return active === null ? measure("not_recorded") : measure("measured", active)
  } catch {
    return measure("not_recorded")
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

function run({ deskRoot, personPrefix = "", since, until, storeDir = null, env, git = "git", now = () => new Date().toISOString() }) {
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
    for (const task of verdict.real) classes.set(`${task.track}/${task.slug}`, commit.tidy ? "tidy" : verdict.mass ? "mass" : "real")
    for (const task of rule(commit.sha, moved).touched) {
      if (!classes.has(`${task.track}/${task.slug}`)) classes.set(`${task.track}/${task.slug}`, "housekeeping")
    }
    for (const [key, kind] of classes) taskOf(key).commits.push({ at: commit.at, ms: Date.parse(commit.at), sha: commit.sha, class: kind })
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
  const localSessions = new Map() // published-comparable session id -> { start, end, spans: job -> absolute spans }
  // outbox file name -> { start, end, jobs: the jobs it binds, kind, own }. `kind` is `here` (its receipt records its own activity for this desk, `own`
  // as absolute spans), `elsewhere` (it records it for another desk) or `unrecorded` (its receipt predates `own_activity`, or there is none; `named` when
  // the receipt still names this desk).
  const sessionInfo = new Map()

  // The receipt of a derived session, or `null`; a receipt is current from BINDING_VERSION on, and only a current one says how jobs were bound.
  const receiptOf = (name) => (isPlainObject(status.derivations?.[name]) ? status.derivations[name] : null)
  const isCurrent = (receipt) => receipt !== null && receipt.binding_version >= BINDING_VERSION
  const boundByOf = (name, job) => {
    const receipt = receiptOf(name)
    if (!isCurrent(receipt) || !isPlainObject(receipt.bound_by)) return NOT_RECORDED
    if (!Object.hasOwn(receipt.bound_by, job)) return "subagent_only"
    return BOUND_BY_VALUES.has(receipt.bound_by[job]) ? receipt.bound_by[job] : NOT_RECORDED
  }
  const disagreesOn = (name, job) => {
    const list = receiptOf(name)?.focus_disagrees
    return Array.isArray(list) && list.includes(job)
  }
  const measureOf = (name, field) => {
    const value = receiptOf(name)?.[field]
    return Number.isSafeInteger(value) && value >= 0 ? measure("measured", value) : measure("not_recorded")
  }
  const sameDesk = new Map()
  const isThisDesk = (deskRootOfReceipt) => {
    if (!sameDesk.has(deskRootOfReceipt)) sameDesk.set(deskRootOfReceipt, realOf(deskRootOfReceipt) === root)
    return sameDesk.get(deskRootOfReceipt)
  }
  // A session's own activity counts here only when its receipt names this desk, so another desk's session never owns this desk's commit.
  const ownOf = (name, start) => {
    const receipt = receiptOf(name)
    const named = typeof receipt?.desk_root === "string" && isThisDesk(receipt.desk_root)
    if (!Array.isArray(receipt?.own_activity)) return { kind: "unrecorded", named, own: [] }
    if (!named) return { kind: "elsewhere", own: [] }
    return { kind: "here", own: receipt.own_activity.filter((span) => Array.isArray(span) && Number.isFinite(span[0]) && Number.isFinite(span[1])).map(([from, to]) => [start + from, start + to]) }
  }
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
      const local = { start, end, spans: new Map() }
      localSessions.set(facts.session.id, local)
      if (!sessionInfo.has(name)) sessionInfo.set(name, { start, end, jobs: new Set(), ...ownOf(name, start) })
      for (const binding of facts.jobs) {
        if (typeof binding?.job !== "string" || !PATTERNS.jobId.test(binding.job)) continue
        if (!sessionsByJob.has(binding.job)) sessionsByJob.set(binding.job, [])
        const spans = jobSpans(binding, start, end)
        local.spans.set(binding.job, spans)
        sessionInfo.get(name).jobs.add(binding.job)
        sessionsByJob.get(binding.job).push({ slug, name, start, end, spans, created: msOf(binding.task_created_at), facts, binding })
      }
    }
  }

  // Bound sessions holding time in the window are activity too: a job holds its segments, not the whole session.
  const holdsWindow = (session) => session.spans.some(([from, to]) => overlaps(from, to))
  for (const [job, sessions] of sessionsByJob) {
    if (!sessions.some(holdsWindow)) continue
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
  // Whether the desk keeps job timing, by the one rule the publisher and the flush use (`desk-visibility.js`), read from the same cache with the
  // same seven-day expiry. No network call is made: a desk with a GitHub repository whose answer is expired or absent is `visibilityKnown: false`
  // and nothing is guessed from it.
  const deskRepo = githubRepoOfRemote(deskRemote)
  let cached = readState(path.join(dir, "visibility.json"), {})
  if (cached === null) {
    if (storeDir !== null) warn("visibility_unreadable")
    cached = {}
  }
  const known = visibilityMap(freshVisibility(cached, Date.parse(now())))
  const visibilityKnown = deskRepo === null || known.has(deskRepo.toLowerCase())
  const deskPrivate = deskTimingKept(deskVisibilityOf(deskRepo, known))
  let secret = null
  if (storeDir !== null) {
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
        storeFacts.get(job.job).push({ id: published.session.id, local, offset: job.session_offset_ms, duration: published.session.duration_ms, observed: job.observed === null ? null : job.observed.status })
      }
    }
  }
  const storeIdOf = (job) => (deskPrivate ? job : secret === null ? null : keyedJobId(job, secret))
  // Where a store session sits in time, as `[start, end]` spans: this machine's local facts when it has them (the job's segments, else the
  // whole session), else the card's `created` plus the offset. `null` when nothing places it.
  const placement = (session, created, plain) => {
    if (session.local !== undefined) return session.local.spans.get(plain) ?? [[session.local.start, session.local.end]]
    if (created === null || created === undefined || session.offset === null) return null
    const start = created + session.offset
    return [[start, start + session.duration]]
  }
  // When a store session ended, or -Infinity when nothing places it.
  const endOf = (session, created) => {
    if (session.local !== undefined) return session.local.end
    const place = placement(session, created)
    return place === null ? -Infinity : place[0][1]
  }

  // ---- reasons ----
  const createdMs = (card) => (card?.created ? Date.parse(card.created) : null)
  const inWindow = (session, created, plain) => {
    const place = placement(session, created, plain)
    return place !== null && place.some(([from, to]) => overlaps(from, to))
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
    const receipt = receiptOf(session.name)
    if (!isCurrent(receipt)) return { reason: "stale_binding", detail: `binding_version_${Number.isSafeInteger(receipt?.binding_version) ? receipt.binding_version : "none"}` }
    const held = readState(path.join(dir, "quarantine", session.slug, session.name), undefined)
    if (held !== undefined) return { reason: "quarantined", detail: `refused_${REFUSAL_CODES.has(held?.reason) ? held.reason : "other"}` }
    if (!Object.hasOwn(deliveredOf(session.slug), session.name)) return { reason: "not_delivered", detail: "outbox_only" }
    const open = inStore ? null : openPr(session.slug)
    return open === null ? null : { reason: "pr_open", detail: open }
  }

  // The reason a task with a bound session is not counted, or `null`: the best bound session's.
  const taskProblem = (bound, inStore) => {
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

  // The sessions that own a commit: those whose receipt's own activity (a `git commit` window or a task-tool call's minute) holds its time.
  const ownersOf = (ms) => [...sessionInfo.entries()].filter(([, info]) => info.own.some(([from, to]) => from <= ms && ms <= to)).map(([, info]) => info)
  // The sessions of this desk that could not say what they owned (their receipt predates own_activity), among those holding a time.
  const deskJobSet = () => new Set(allJobs().keys())
  let deskJobs
  const unsaid = (info) => {
    deskJobs ??= deskJobSet()
    return info.kind === "unrecorded" && (info.named || [...info.jobs].some((job) => deskJobs.has(job)))
  }
  const unsaidAt = (ms) => [...sessionInfo.entries()].filter(([, info]) => unsaid(info) && info.start <= ms && ms <= info.end).map(([name]) => name)
  const mentioned = new Set() // shas of real commits made by a session bound to another task
  const housekeeping = []

  for (const task of [...tasks.values()].sort((a, b) => byKey(a.key, b.key))) {
    task.job = jobOfKey(task.key).job
    const bound = (sessionsByJob.get(task.job) ?? []).filter(holdsWindow)
    // A real commit on this task made by a session bound to another task is mentioned. One that a session recorded no own activity for cannot be
    // placed (`receipt_too_old`); one that every overlapping session could have claimed and none did leaves the task not bound.
    let unowned = 0
    const undetermined = new Set()
    const realCommits = task.commits.filter((commit) => commit.class === "real")
    for (const commit of realCommits) {
      const owners = ownersOf(commit.ms)
      if (owners.some((owner) => owner.jobs.has(task.job))) continue
      if (owners.some((owner) => owner.jobs.size > 0)) mentioned.add(commit.sha)
      else if (owners.length === 0 && unsaidAt(commit.ms).length > 0) unsaidAt(commit.ms).forEach((name) => undetermined.add(name))
      else unowned += 1
    }
    const real = realCommits.length > 0 || bound.length > 0
    const storeId = storeIdOf(task.job)
    const storeSessions = storeId === null ? null : storeFacts.get(storeId) ?? []
    const before = mismatches.length

    if (!real) {
      // The factory counted a session in the window that the desk's history does not show as real work.
      if (storeSessions === null || !storeSessions.some((session) => inWindow(session, createdMs(task.card), task.job))) {
        housekeeping.push({ track: task.track, slug: task.slug })
        continue
      }
      push(task, "store_only", "store_session_in_window")
    } else if (task.card === null) push(task, "card_missing", "no_card")
    else {
      if (bound.length === 0) {
        if (unowned > 0) push(task, "not_bound", `unbound_markers_${deskMarkers.length}`)
        if (undetermined.size > 0) push(task, "receipt_too_old", `own_activity_not_recorded_${undetermined.size}`)
      } else {
        const problem = taskProblem(bound, storeSessions !== null && storeSessions.length > 0)
        if (problem !== null) push(task, problem.reason, problem.detail)
        // The receipt's own finding: a declared stretch in which inference found other work and none on this task.
        if (bound.some((session) => disagreesOn(session.name, task.job))) push(task, "focus_disagrees", "declared_stretch_without_own_events")
      }
      if (!ENUMS.jobStatus.includes(task.card.status)) push(task, "invalid_status", "status_outside_lifecycle")
      else if (storeSessions !== null) {
        // The latest status the store observed for the job, when the card has since moved on without a session seeing it.
        const created = createdMs(task.card)
        const seen = storeSessions.filter((session) => session.observed !== null).sort((a, b) => endOf(a, created) - endOf(b, created)).at(-1)
        if (seen !== undefined && seen.observed !== task.card.status) push(task, "status_unobserved", "card_status_not_in_store")
      }
    }

    const story = new Map() // by file name: a session copied in two outboxes tells its story once
    for (const session of bound) {
      story.set(session.name, {
        session: session.name.slice(0, -5), start: new Date(session.start).toISOString(),
        active_ms: !visibilityKnown ? measure("not_checked", undefined, { reason: "visibility_not_known" }) : deskPrivate ? activeMsOf(session.facts, session.binding, session.start, session.created) : measure("withheld"), bound_by: boundByOf(session.name, task.job),
      })
    }
    report.push({
      track: task.track,
      slug: task.slug,
      job: task.job,
      activity: [
        ...task.commits.map((commit) => ({ kind: "commit", at: commit.at, class: commit.class })),
        ...bound.map((session) => ({ kind: "session", session: session.name.slice(0, -5), start: new Date(session.start).toISOString(), end: new Date(session.end).toISOString() })),
      ],
      story: [...story.values()].sort((a, b) => byKey(a.start, b.start) || byKey(a.session, b.session)),
      store: storeDir === null ? { checked: false } : { checked: true, sessions: storeSessions === null ? measure("not_recorded") : measure("measured", storeSessions.length) },
      mismatched: mismatches.length > before,
    })
  }

  // Store jobs in the window that no task above covers.
  for (const [storeId, sessions] of storeFacts) {
    const plain = storeToPlain.get(storeId) ?? null
    const key = plain === null ? null : allJobs().get(plain) ?? null
    if (key !== null && tasks.has(key)) continue
    const created = key === null ? sessionsByJob.get(plain)?.[0]?.created ?? null : createdMs(cards.get(key))
    if (!sessions.some((session) => inWindow(session, created, plain))) continue
    const [track, slug] = key === null ? [null, null] : key.split("/")
    mismatches.push({ track, slug, job: plain ?? (deskPrivate ? storeId : null), reason: "store_only", detail: "store_session_in_window" })
    if (key !== null) report.push({ track, slug, job: plain, activity: [], story: [], store: { checked: true, sessions: sessions.length }, mismatched: true })
  }

  mismatches.sort((a, b) => byKey(`${a.track}/${a.slug}`, `${b.track}/${b.slug}`) || rank(a.reason) - rank(b.reason))
  const byReason = {}
  for (const reason of RECONCILE_REASONS) {
    const count = mismatches.filter((item) => item.reason === reason).length
    if (count > 0) byReason[reason] = count
  }
  const outTasks = report.map(({ mismatched, ...rest }) => rest)
  // Each session that tells a task's story, once, with the receipt's two measures: how much time the segment cap dropped, and how many
  // directories no longer existed, so no repository evidence is available for them. A receipt that predates a measure says `not_recorded`.
  const storied = new Map()
  const boundBy = { focus: 0, inferred: 0, subagent_only: 0, not_recorded: 0 }
  for (const entry of outTasks.flatMap((task) => task.story)) {
    storied.set(entry.session, entry)
    boundBy[entry.bound_by] += 1
  }
  const sessions = [...storied.values()].sort((a, b) => byKey(a.start, b.start) || byKey(a.session, b.session)).map((entry) => ({
    session: entry.session, start: entry.start,
    segments_capped_ms: measureOf(`${entry.session}.json`, "segments_capped_ms"), repository_evidence_unavailable: measureOf(`${entry.session}.json`, "repo_unresolved"),
  }))
  // Real commits made by a session bound to another task, which only a receipt that records own activity can say: not recorded where none does.
  const holding = [...sessionInfo.values()].filter((info) => overlaps(info.start, info.end))
  const recordedSessions = holding.filter((info) => info.kind === "here").length
  const mentionedCount = measure(recordedSessions === 0 ? "not_recorded" : "measured", mentioned.size, { of: recordedSessions, not_recorded: holding.filter(unsaid).length })
  return {
    ok: true,
    window: { since, until },
    desk: { person: alias },
    tasks: outTasks,
    housekeeping_cards: housekeeping,
    sessions,
    mismatches,
    unbound_markers: deskMarkers.map(({ name, marker }) => ({ session: name.slice(0, -5), ...(markerProblem(name, marker) ?? { reason: null, detail: "marker_not_bound" }) })),
    counts: {
      tasks: report.length, matched: report.filter((item) => !item.mismatched).length, mismatched: mismatches.length, by_reason: byReason, mentioned: mentionedCount,
      status_unobserved: measure(storeDir === null ? "not_checked" : "measured", byReason.status_unobserved ?? 0),
      bound_by: boundBy, segments_capped_ms: totalOf(sessions.map((session) => session.segments_capped_ms)),
      repository_evidence_unavailable: totalOf(sessions.map((session) => session.repository_evidence_unavailable)),
    },
    ...(warnings.size > 0 ? { warnings: [...warnings] } : {}),
  }
}
