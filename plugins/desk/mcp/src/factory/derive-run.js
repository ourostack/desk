// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files, with one exception: `../desk/crew-roster.js` (the one crew rule),
// which itself imports only `node:` modules and says so in its header.
import { createHash } from "node:crypto"
import { realpathSync, statSync, promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { deskVersion } from "../package-metadata.js"
import { setTimeout as sleep } from "node:timers/promises"
import { bindSession, isTaskSegment, jobId } from "./binding.js"
import { recordCoverage } from "./capture-sweep.js"
import { deriveClaudeSession } from "./derive-claude.js"
import { addUnavailable } from "./derive-common.js"
import { deriveCodexSession } from "./derive-codex.js"
import { deriveCopilotSession } from "./derive-copilot.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { createDeskReaders, readDeskRemote } from "./desk-repo.js"
import { validMarker } from "./marker.js"
import { outcomeSnapshot } from "./outcome.js"
import { COPY_RETENTION_MS, factoryStateRoot, keepCopiesElsewhere, listMarkers, outboxCopies, pruneDeliveredCopy, pruneTombstones, retractionNames, readConsent, readLocalFacts, readMarker, jobsIndexRebuilt, rebuildJobsIndex, readStatus, recordRoutes, setJobsForFile, updateStatus, withDerivationLock, writeLocalFacts, writeStatus } from "./outbox.js"
import { compareVersions, isVersion } from "./pipeline/versions.js"
import { backfillPluginSources } from "./plugin-registry.js"
import { githubRepoOfRemote } from "./desk-visibility.js"
import { ENUMS, LIMITS, isPlainObject } from "./schema.js"
import { normalizeTimestamp } from "./time.js"
import { RETRACTED_COPIES, declared, deskRootOf, markerRoute, proofIndex, provenBy, sessionRoute } from "./session-route.js"
import { reconcileMarker } from "./session-lifetime.js"
import { routeHolds } from "./held-route.js"

async function sourceStamp(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.nlink !== 1) throw Object.assign(new Error("source_unreadable"), { path: file })
  return { size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev }
}

/**
 * Bump when binding changes what a derived session credits; sessions with a lower or missing receipt version re-derive once. 6: a Git rename
 * between two different cards no longer joins them, a focus on a merged task follows the merge, and `segments_capped_ms` also counts time the
 * cap hands to another task, so an older receipt's credit, and its `segments_capped_ms: 0`, is not this binder's. 7: the derivers record
 * each human wait's stop facts, the ask-tool waits and whether the session created each PR (published facts /4), so every ended session
 * still on disk is derived once more to carry them.
 */
export const BINDING_VERSION = 7

// The Desk task tool calls that can change a card's outcome record: the session's facts carry the record of every task one of them named.
const LIFECYCLE_CALL = /task_(?:signoff|update|create|archive)$/u

// One entry of `facts.outcomes`, from a card's snapshot. A time the card holds in another written form is made the canonical instant, or `null`, so one hand-edited card cannot make the whole session's facts invalid. The snapshot's other keys are dropped here.
function outcomeEntry(job, found, now) {
  const snapshot = outcomeSnapshot(found.record, { status: found.status, now, evidenceAt: found.evidenceAt })
  const { rev, state, verified, reason, deliveries, observed_at: observedAt } = snapshot
  const entry = { job, rev, state, verified, reason, deliveries, delivered_at: normalizeTimestamp(snapshot.delivered_at), signed_at: normalizeTimestamp(snapshot.signed_at), observed_at: observedAt }
  // The record's start, the two milestone times and the returns are written only when the card holds them; a card with no record has none of these, and an empty returns list on a card with a record means no returns.
  if (snapshot.since !== null) entry.since = snapshot.since
  for (const key of ["first_validating_at", "first_delivered_at"]) {
    const time = normalizeTimestamp(snapshot[key])
    if (time !== null) entry[key] = time
  }
  if (snapshot.since !== null || snapshot.returns.length > 0) {
    // The newest `LIMITS.returns` are kept, the oldest dropped first, and the entry says when any were.
    entry.returns = snapshot.returns.slice(-LIMITS.returns)
    if (snapshot.returns.length > LIMITS.returns) entry.returns_truncated = true
  }
  if (snapshot.returns_unreadable > 0) entry.returns_unreadable = snapshot.returns_unreadable
  return entry
}

/**
 * `outcomesFor({ jobs, lifecycleCalls, readers, identity, now, unavailable }) -> entry[]`: the outcome record of each task the session touched, sorted by job, one entry per job and at most `LIMITS.outcomes`; when there are more, the rest are cut and `{outcomes, capped}` is added to `unavailable` (the session's list), so a cut list never reads as the whole one. The tasks are the bound jobs (`jobs`: `{ job, track, slug }` as `bindSession` returns them as `tasks`) and every task a successful `task_signoff`, `task_update`, `task_create` or `task_archive` call named (`lifecycleCalls`: the deriver's `deskToolCalls`). A call's job ID is computed as binding computes it: the birth path from `readers.resolveJobIdentity`, hashed with `identity` (`{ deskRemote, personPrefix }`). A task whose card cannot be read, or whose job ID cannot be made, gets no entry and never stops the others. `observed_at` is `now` (epoch milliseconds or an ISO string), never the clock.
 */
export function outcomesFor({ jobs, lifecycleCalls, readers, identity, now, unavailable = [] }) {
  const entries = new Map()
  const add = (job, track, slug) => {
    if (entries.has(job)) return
    try {
      const found = readers.readOutcome(track, slug)
      // A card whose status cannot be read has no state to report: no entry, never a default.
      if (found !== null && found.status !== null) entries.set(job, outcomeEntry(job, found, now))
    } catch {
      // A card that cannot be read leaves the session's other outcomes as they are.
    }
  }
  for (const { job, track, slug } of jobs) add(job, track, slug)
  const named = new Set()
  for (const call of lifecycleCalls) {
    if (call?.ok !== true || typeof call.name !== "string" || !LIFECYCLE_CALL.test(call.name) || !isTaskSegment(call.track) || !isTaskSegment(call.slug)) continue
    if (named.has(`${call.track}/${call.slug}`)) continue
    named.add(`${call.track}/${call.slug}`)
    let job
    try {
      const birth = readers.resolveJobIdentity(call.track, call.slug)
      job = jobId({ ...identity, track: birth.track, slug: birth.slug })
    } catch {
      continue
    }
    add(job, call.track, call.slug)
  }
  if (entries.size > LIMITS.outcomes) addUnavailable(unavailable, "outcomes", "capped")
  return [...entries.values()].sort((a, b) => (a.job < b.job ? -1 : 1)).slice(0, LIMITS.outcomes)
}

const sameSource = (a, b) => a.size === b.size && a.mtime === b.mtime && a.ino === b.ino && a.dev === b.dev

function markerHash(marker) {
  const { updated_at, ...content } = marker
  return createHash("sha256").update(JSON.stringify(content)).digest("hex")
}

// The version of Desk actually running this code (package-metadata.js's one
// resolver, which reads plugin.json). A long-lived session's own plugin metadata can name a
// newer Desk than the one still executing (its hook stays pinned to whatever
// was on disk when the session started), so this is never taken from a
// marker or an installed-plugins registry.

// How long a stale-deriver hold (below) is honored before this deriver stops
// waiting for a fresher process and derives with the code it is actually
// running. A marker's declared version is frozen at the moment it is
// written; if the machine later rolls back to an older Desk, the marker
// keeps naming a version no installed deriver can ever reach, and without an
// expiry every deriver would hold it forever, until outbox.js's own marker
// pruning (MARKER_TTL_MS, 30 days) deletes it unpublished and the session's
// facts are lost outright. Seven days sits well inside that 30-day window,
// so a genuinely stale process still gets a real chance to be replaced by a
// fresher one before this deriver gives up on waiting and just derives.
const STALE_DERIVER_HOLD_MS = 7 * 24 * 60 * 60 * 1000

// The marker's declared "desk" plugin version, or null when there is none to
// trust: no "desk" entry, or more than one "desk" entry naming different
// versions. Two different-origin "desk" installs can coexist in
// marker.plugins; when they disagree, picking one over the other would be
// arbitrary, so an ambiguous declaration is treated the same as no
// declaration at all — it never causes a hold.
function declaredDeskVersion(plugins) {
  const versions = new Set(plugins.filter((plugin) => plugin.name === "desk").map((plugin) => plugin.version))
  return versions.size === 1 ? [...versions][0] : null
}

// Whether the marker declares a "desk" plugin newer than the code actually
// running it. A stale deriver must hold rather than bind with logic its own
// declared version has already superseded (an unreadable or malformed own
// version fails open: proceed as before, as does an ambiguous declaration —
// see declaredDeskVersion — and a hold older than STALE_DERIVER_HOLD_MS).
function isStaleDeriver(ownVersion, plugins, updatedAt, now) {
  if (now() - Date.parse(updatedAt) > STALE_DERIVER_HOLD_MS) return false
  return newerDeskRecorded(ownVersion, plugins)
}

// Whether the declared "desk" plugin is newer than the code running (an unreadable or malformed own version, and an ambiguous or missing
// declaration, are not: they fail open).
function newerDeskRecorded(ownVersion, plugins) {
  const declared = declaredDeskVersion(plugins)
  if (declared === null) return false
  let own
  try {
    own = ownVersion()
  } catch {
    return false
  }
  return isVersion(own) && compareVersions(own, declared) < 0
}

// A derivation that fails for a reason other than an unreadable session log leaves a diagnostic in `status.json` under `derive_failures`, keyed by the
// marker's file name: `{ at, step, code }`, where `step` names the part that failed and `code` is the error's code, else its constructor's name. No message
// is stored: an error message can quote a path or session text, and `factory.js status` prints this record. The result handed back is unchanged
// (`source_unreadable`, which the flush reads as "try again later"), so a failed write is retried and is also seen. The session log itself missing or not
// a regular file is expected and benign, and is recorded nowhere; the same error on any other path is recorded. Every settled result clears the session's
// record, and the status is read first so a result with no record to clear takes no lock and writes nothing. Recording never throws.
const FAILURES_KEPT = 20
const FAILURE_CODE = /^[A-Za-z0-9_]{1,40}$/u
const READ_ONLY_STEPS = new Set(["route", "source", "derive", "read_marker", "wait_quiet"])
const SETTLED = new Set(["written", "not_opted_in", "held", "skipped", "invalid", "log_missing"])

const unreadable = (error, step, logs) => READ_ONLY_STEPS.has(step) && (error?.code === "ENOENT" || error?.message === "source_unreadable") && logs.has(error.path)

const codeOf = (error) => [error?.code, error?.constructor?.name].find((code) => typeof code === "string" && FAILURE_CODE.test(code)) ?? "unknown"

// `failure` is `{ step, error, logs }` for a failed derivation and `null` to clear the session's record. `diag.failed` tells the caller a failure was seen.
async function noteDerive(env, name, failure, diag = { failed: false }) {
  try {
    if (failure !== null) {
      if (unreadable(failure.error, failure.step, failure.logs ?? new Set())) return
      diag.failed = true
    } else if (!Object.hasOwn((await readStatus(env)).derive_failures ?? {}, name)) {
      return
    }
    const at = new Date().toISOString()
    await updateStatus(env, ({ derive_failures: before, ...current }) => {
      const kept = Object.entries(isPlainObject(before) ? before : {}).filter(([key]) => key !== name)
      if (failure !== null) kept.push([name, { at, step: failure.step, code: codeOf(failure.error) }])
      return kept.length === 0 ? current : { ...current, derive_failures: Object.fromEntries(kept.slice(-FAILURES_KEPT)) }
    })
  } catch {
    // A diagnostic that cannot be written must not stop the derivation, nor the end hook.
  }
}

export async function deriveMarker(env, marker, { claude = deriveClaudeSession, copilot = deriveCopilotSession, codex = deriveCodexSession, quietMs = 0, requireQuiet = false, requireStored = false, ownVersion = deskVersion, now = Date.now, siblings = lazyProofIndex(() => listMarkers(env)), admit = null } = {}) {
  if (!validMarker(marker)) return { result: "invalid", store: null }
  if (marker.desk_root === null) return { result: "held", store: null }
  const name = `${marker.host}-${marker.session_id}.json`
  const diag = { failed: false }
  try {
    const outcome = await withDerivationLock(env, name, (root) => deriveUnlocked(env, marker, { claude, copilot, codex, quietMs, requireQuiet, requireStored, root, ownVersion, now, siblings, admit, diag }), { deskRoot: marker.desk_root })
    if (!diag.failed && SETTLED.has(outcome.result)) await noteDerive(env, name, null)
    return outcome
  } catch (error) {
    await noteDerive(env, name, { step: "lock", error }, diag)
    return { result: "source_unreadable", store: null }
  }
}

// A Codex marker records no plugins, so its default route never saw a plugin overlay; it is proven as the flush and reconcile prove it
// (`session-route.js`). One memoized proof index for a whole sweep; a single derive builds its own.
const lazyProofIndex = (load) => {
  let pending = null
  return () => (pending ??= load().then(proofIndex))
}

async function newestMarker(env, root, marker, requireStored) {
  try {
    const stored = await readMarker(env, path.join(root, "markers", `${marker.host}-${marker.session_id}.json`))
    if (stored === null) throw new Error("invalid_marker")
    if (requireStored) return stored
    return (stored.ended_at ?? stored.updated_at) > (marker.ended_at ?? marker.updated_at) ? stored : marker
  } catch (error) {
    if (error.code === "ENOENT" && !requireStored) return marker
    throw error
  }
}

// `admit`, when given, runs inside the derivation lock before anything is read or written and answers a refusal reason or null, so a decision that
// guards the write is made under the same lock as the write.
async function deriveUnlocked(env, input, { claude, copilot, codex, quietMs, requireQuiet, requireStored, root, ownVersion, now, siblings, admit, diag }) {
  const logs = new Set([input.log_path])
  let store = null
  let step = "route"
  try {
    let marker = await newestMarker(env, root, input, requireStored)
    logs.add(marker.log_path)
    if (marker.desk_root === null) return { result: "held", store }
    if (isStaleDeriver(ownVersion, marker.plugins, marker.updated_at, now)) return { result: "held", store }
    await factoryStateRoot(env, { deskRoot: marker.desk_root })
    const route = markerRoute(marker)
    store = route.store
    const refusal = admit === null ? null : await admit()
    if (refusal !== null) return { result: "refused", store, reason: refusal }
    const name = `${marker.host}-${marker.session_id}.json`
    if (store === null) return { result: "held", store }
    if ((await readConsent(env)).stores[store]?.contribute !== true) return { result: "not_opted_in", store }
    if (marker.host === "codex-cli" && route.source === "default" && !provenBy(marker, await siblings())) return { result: "held", store: null, reason: "route_unverified" }
    step = "source"
    const before = await sourceStamp(marker.log_path)
    marker = await reconcileMarker(marker)
    logs.add(marker.log_path)
    if (!sameSource(before, await sourceStamp(marker.log_path))) return { result: "skipped", store }
    if (quietMs > 0 && (requireQuiet || marker.ended_at === null) && Date.now() - before.mtime < quietMs) return { result: "skipped", store }
    const hash = markerHash(marker)
    const receipt = (await readStatus(env)).derivations?.[name]
    const destination = path.join(root, "outbox", store.replace("/", "__"), name)
    if (receipt?.store === store && receipt.marker === hash && receipt.binding_version >= BINDING_VERSION && sameSource(receipt, before)) {
      // A copy kept in `retracted-copies/` is not lost: the session left the store, and deriving it again would only be kept again.
      for (const copy of [destination, path.join(root, RETRACTED_COPIES, store.replace("/", "__"), name)]) {
        try {
          await sourceStamp(copy)
          return { result: "skipped", store }
        } catch {
          // A lost outbox file must be rebuilt even when the log is unchanged.
        }
      }
    }
    let derived
    step = "derive"
    // A marker from a hook older than 58adb141 names plugins without `source`; the host's plugin cache and install records fill it in for this derivation only.
    const plugins = backfillPluginSources(marker.host, marker.plugins, { env })
    if (marker.host === "claude-code") {
      derived = await claude({ transcriptPath: marker.log_path, plugins, endReason: marker.end_reason })
    } else if (marker.host === "codex-cli") {
      // A rollout lives at <codexHome>/sessions/YYYY/MM/DD/rollout-*.jsonl; when it does not, the deriver resolves the home itself.
      const sessions = path.resolve(marker.log_path, "..", "..", "..", "..")
      derived = await codex({ rolloutPath: marker.log_path, codexHome: path.basename(sessions) === "sessions" ? path.dirname(sessions) : undefined, plugins, endReason: marker.end_reason })
    } else {
      const home = path.resolve(marker.log_path, "..", "..", "..")
      if (path.join(home, "session-state", marker.session_id, "events.jsonl") !== marker.log_path) return { result: "invalid", store }
      derived = await copilot({ sessionId: marker.session_id, copilotHome: home, plugins, endReason: marker.end_reason, entrypoint: marker.entrypoint })
    }
    if (!sameSource(before, await sourceStamp(marker.log_path))) return { result: "skipped", store }
    if (derived.facts === null) return { result: derived.reason, store }
    if (derived.facts.session.id !== marker.session_id) return { result: "invalid", store }
    step = "bind"
    const personPrefix = marker.person_prefix ?? ""
    const deskRoot = marker.desk_root
    const deskRemote = readDeskRemote({ deskRoot })
    const { jobs, boundBy, disagrees, ownActivity, repoUnresolved, segmentsCappedMs, tasks, remote } = bindSession({
      events: derived.events, agents: derived.facts.agents, session: derived.facts.session, deskRoot, deskRemote, personPrefix,
      ...createDeskReaders({ deskRoot, personPrefix }),
    })
    derived.facts.jobs = jobs
    derived.facts.outcomes = outcomesFor({ jobs: tasks, lifecycleCalls: derived.events.deskToolCalls, readers: createDeskReaders({ deskRoot, personPrefix }), identity: { deskRemote: remote, personPrefix }, now: now(), unavailable: derived.facts.unavailable })
    if (segmentsCappedMs > 0) addUnavailable(derived.facts.unavailable, "job_segments", "capped")
    // The decision that guards the write is made again right before it: the derivation above is long.
    const late = admit === null ? null : await admit()
    if (late !== null) return { result: "refused", store, reason: late }
    step = "write_facts"
    const written = await writeLocalFacts(env, store, derived.facts)
    if (!written.written) return { result: written.errors.length ? "invalid" : "not_opted_in", store }
    step = "write_jobs"
    await setJobsForFile(env, written.name, [...new Set([...jobs, ...derived.facts.outcomes].map((j) => j.job))])
    // `desk_root` stays local: the flush reads the desk's declaration from it once the marker is pruned (`session-route.js`).
    // So do `bound_by` (job ID -> "focus" | "inferred"), `own_activity` (spans in ms from the session's start), `focus_disagrees` (job IDs)
    // `repo_unresolved` (how many distinct directories outside the desk no longer exist and named no repository: lost evidence; a
    // directory that exists and is in no repository, or in one with no origin, is a true none and is not counted) and
    // `segments_capped_ms` (the time the segment cap dropped, 0 when none), which `factory reconcile` reads because it
    // cannot see transcripts; they are never written to facts. `desk_repo` (the desk's GitHub repository, lower case, absent when it has none)
    // is what the flush compares with the desk root's repository once the marker is pruned, so a session is published under its desk's
    // protection only when the desk is certainly the same one; a receipt without it is uncertain. `desk_unprotected` (set by the flush) is carried over.
    const deskRepo = githubRepoOfRemote(deskRemote)?.toLowerCase()
    // `checked_route` is the store this derive checked, written only on a positive route (an older hook's default route with no overlay check
    // is not one), so a session whose marker is later pruned is placed on it (`session-route.js`).
    const checked = route.source === "default" && !marker.routing && marker.host !== "codex-cli" ? {} : { checked_route: store }
    step = "write_receipt"
    await writeStatus(env, { derivations: { [name]: { store, ...checked, marker: hash, binding_version: BINDING_VERSION, desk_root: deskRoot, bound_by: boundBy, own_activity: ownActivity, focus_disagrees: disagrees, repo_unresolved: repoUnresolved, segments_capped_ms: segmentsCappedMs, ...(deskRepo === undefined ? {} : { desk_repo: deskRepo }), ...(receipt?.desk_unprotected === true ? { desk_unprotected: true } : {}), ...before } } })
    return { result: "written", store }
  } catch (error) {
    await noteDerive(env, `${input.host}-${input.session_id}.json`, { step, error, logs }, diag)
    return { result: error.code === "ENOENT" ? "log_missing" : "source_unreadable", store }
  }
}

const isFolder = (folder) => {
  try {
    return statSync(folder).isDirectory()
  } catch {
    return false
  }
}

// Whether the desk is a crew workspace, by `crewWorkspace` (the one rule, `src/desk/crew-roster.js`, which imports only `node:` built-ins), with
// one more fail-closed case: a `desks/` entry that cannot be checked at all is crew. A person prefix this rebuild cannot give would put the
// session under the wrong job.
function isCrewDesk(root) {
  try {
    statSync(path.join(root, "desks"))
  } catch (error) {
    if (error.code !== "ENOENT") return true
  }
  return crewWorkspace(root).crew
}

// Finds the Claude Code transcript of a session: `<config dir>/projects/<folder>/<session id>.jsonl`. The folders are listed once per finder.
function transcriptFinder(env) {
  const configDir = env.CLAUDE_CONFIG_DIR || path.join(env.HOME || os.homedir(), ".claude")
  const projects = path.join(configDir, "projects")
  let folders = null
  return async (sessionId) => {
    folders ??= await fs.readdir(projects).then((list) => list.sort(), () => [])
    for (const folder of folders) {
      const file = path.join(projects, folder, `${sessionId}.jsonl`)
      try {
        const stat = await fs.lstat(file)
        if (stat.isFile() && stat.nlink === 1) return file
      } catch {
        // Not in this folder.
      }
    }
    return null
  }
}

const CWD_SCAN_BYTES = 1024 * 1024

// The first `cwd` the transcript records, read from its first megabyte only, or null. Only the working directory is read; no other field is kept.
async function firstCwd(file) {
  const handle = await fs.open(file, "r")
  try {
    const buffer = Buffer.alloc(CWD_SCAN_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, CWD_SCAN_BYTES, 0)
    const lines = buffer.toString("utf8", 0, bytesRead).split("\n")
    // The last piece may be cut short by the scan limit; a file that ends in a newline leaves an empty piece there.
    for (const line of lines.slice(0, -1)) {
      let cwd
      try {
        cwd = JSON.parse(line)?.cwd
      } catch {
        continue
      }
      if (typeof cwd === "string") return path.isAbsolute(cwd) ? cwd : null
    }
    return null
  } finally {
    await handle.close()
  }
}

// The desk root a transcript's first `cwd` names, or null: only when it resolves exactly to a solo desk workspace (`_meta/` and `_archive/`).
async function cwdRoot(transcript) {
  const cwd = await firstCwd(transcript)
  if (cwd === null) return null
  let real
  try {
    real = realpathSync(cwd)
  } catch {
    return null
  }
  return isFolder(path.join(real, "_meta")) && isFolder(path.join(real, "_archive")) ? real : null
}

/** The reasons an orphan stays frozen, a closed list: one for each condition of spec section 4 that can fail, and the one rule below. `factory.js status` prints the pass and `desk_doctor` reports a pass that failed, was interrupted or is not advancing (`local-status.js`); `reconcile` does not read the reasons. */
export const ORPHAN_REASONS = Object.freeze(["no_facts", "no_transcript", "no_desk_root", "crew_desk", "route_unknown", "retracted", "not_opted_in", "recorded_by_newer_desk", "derive_failed"])
/** The most orphans one sweep gives transcript work (facts, transcript, derive); the rest are `unexamined` and the next pass starts after the last one served. */
export const ORPHAN_EXAMINE_CAP = 25
/** The time one sweep's orphan pass may spend on transcript work, half of the 120 s the delivery deadline allows; the rest is `pending`. */
export const ORPHAN_BUDGET_MS = 60000
/** What a pass that threw records, instead of counts: a fixed class, never a message or a path. */
export const ORPHAN_PASS_FAILED = "pass_failed"
/** How many orphans whose derive never finished the record remembers. */
const HUNG_KEPT = 50
/** Separate interrupted passes that must find the same orphan mid-derive before it is frozen as `derive_failed`. */
export const ORPHAN_HUNG_STRIKES = 2
/** The start hook's hard stop: a record with no result younger than this may be a pass still running, so it is no strike. */
export const ORPHAN_HARD_STOP_MS = 150000

const DAY_MS = 24 * 60 * 60 * 1000

// The reason the desk at `root` does not allow a rebuild into `store`, or null: a crew desk, or one that does not itself declare `store`.
function rootRefusal(root, store) {
  if (isCrewDesk(root)) return "crew_desk"
  const route = declared(root)
  return route.kind === "store" && route.store.toLowerCase() === store.toLowerCase() ? null : "route_unknown"
}

const zeroReasons = () => Object.fromEntries(ORPHAN_REASONS.map((reason) => [reason, 0]))

/**
 * `rebuildOrphans(env, { now, quietMs, markers, cap, budgetMs, clock, retractions, ownVersion, write }) -> { rebuilt, current, pending, frozen,
 * orphans }`: Claude Code sessions with an outbox copy and no marker (it was pruned after 30 days) are derived again, from their transcript,
 * when all of these hold (spec section 4): the desk root is known (the receipt's `desk_root`, or the transcript's first `cwd` when that is
 * exactly a desk root); that desk's own `_meta/factory.json` declares the store whose outbox holds the copy (a desk that routes by default is
 * never rebuilt this way); no store holds a retraction record or a kept copy of the session (checked again inside the derivation lock and
 * right before the write); and the desk is not a crew desk. `end_reason` and `ended_at` come from the outbox copy. The session is derived as
 * a marker would be, so its receipt carries the same fields.
 *
 * Orphans are taken in name order starting after the `cursor` the last pass recorded, and wrapping, so a stuck orphan cannot keep a later one
 * from its turn. Cheap checks (a retraction, the receipt's desk root, roster and declaration) run for every orphan; the rest (facts, the
 * transcript, its stat, the derive) only inside `cap` orphans and `budgetMs` (`clock` is milliseconds); a current orphan, which needs no derive, gives its slot back. The others are `unexamined`. An orphan whose transcript is gone, whose facts were delivered and whose record is over `COPY_RETENTION_MS` old loses its outbox copy (`pruneCopy`, default `pruneDeliveredCopy`), counted as `copies_pruned` in the record when above 0 (`copies_prune_failed` when a prune threw). An orphan
 * whose outbox copy records a newer Desk than this one is held `pending` (taking no slot) for the seven days `STALE_DERIVER_HOLD_MS` allows,
 * counted from the copy's `ended_at` (its file's mtime when there is none), then frozen as `recorded_by_newer_desk`.
 *
 * The record is written to `status.json` as `orphans` twice: `{ started_at, cursor, last_wrap_at, sweeps_in_walk }` before the work, and
 * after it `{ started_at, ran_at, cursor, last_wrap_at, sweeps_in_walk, examined, rebuilt, current, pending, unexamined, oldest_pending_days,
 * frozen: { <reason>: n } }`, or `{ started_at, ran_at, cursor, last_wrap_at, sweeps_in_walk, failed: "pass_failed" }` when the pass threw (the
 * summary then has no counts). `last_wrap_at` is when every orphan from the cursor to the end of the list was last reached (null: not yet) and
 * `sweeps_in_walk` the sweeps since (0 right after a wrap), so a walk that is not advancing shows as a wrap time that grows old and a count that
 * grows. A record with a start and no `ran_at` is a pass that was interrupted or could not report.
 * `pending` is orphans examined and waiting for a known reason; `unexamined` is those left over by the cap or the budget this sweep, verdict not yet known (a count only; the cursor works through them), and `examined` is how many the pass looked at, so a reader can see the queue move. `oldest_pending_days` is the age in whole days of the oldest orphan found waiting (null when none was): a queue that does not drain shows
 * as a number that grows. `retractions(env)` lists the retracted session names; `ownVersion()` is this Desk's version; `write` is
 * `writeStatus`; `derive` is `deriveMarker`.
 *
 * Before each derive the record is written again with `cursor` and `attempting` set to that orphan, so a process stopped inside the derive (the
 * start hook's hard stop) leaves the walk past it. The next pass finds a record with `attempting` and no `ran_at`; when that record is at least
 * `ORPHAN_HARD_STOP_MS` old (a younger one may be a pass still running) it is one strike, kept in `hung` as
 * `{ <session file>: { strikes, version } }`. After `ORPHAN_HUNG_STRIKES` strikes under the same Desk version the orphan is examined and frozen as
 * `derive_failed` without another derive, so one orphan whose derive never finishes cannot hold up every sweep; a newer Desk starts again. An orphan
 * whose receipt is current, or that is rebuilt, is never frozen by a strike and loses its strikes.
 */
export async function rebuildOrphans(env, { now = Date.now, quietMs = 0, markers = null, cap = ORPHAN_EXAMINE_CAP, budgetMs = ORPHAN_BUDGET_MS, clock = Date.now, retractions = retractionNames, ownVersion = deskVersion, write = writeStatus, derive = deriveMarker, pruneCopy = pruneDeliveredCopy } = {}) {
  const startedAt = new Date(now()).toISOString()
  // Where the walk stands, from the last record: the cursor, when it last wrapped (null: not yet) and how many sweeps this walk has taken.
  let walk = { cursor: null, last_wrap_at: null, sweeps_in_walk: 0 }
  let version = null
  try {
    version = ownVersion()
  } catch {
    // Without a version nothing is recorded as hung and nothing is skipped as hung.
  }
  let hung = {}
  try {
    const previous = (await readStatus(env)).orphans
    hung = isPlainObject(previous?.hung) ? Object.fromEntries(Object.entries(previous.hung).filter(([, value]) => isPlainObject(value) && Number.isSafeInteger(value.strikes) && typeof value.version === "string")) : {}
    // The orphan a stopped pass was deriving: its record ends there, with no result. A start time that does not parse reads as old, never as running.
    const startedMs = Date.parse(previous?.started_at)
    const interrupted = previous?.ran_at === undefined && typeof previous?.attempting === "string" && typeof version === "string" && !(now() - startedMs < ORPHAN_HARD_STOP_MS)
    if (interrupted) hung[previous.attempting] = { strikes: hung[previous.attempting]?.version === version ? hung[previous.attempting].strikes + 1 : 1, version }
    hung = Object.fromEntries(Object.entries(hung).slice(-HUNG_KEPT))
    walk = {
      cursor: typeof previous?.cursor === "string" ? previous.cursor : null,
      last_wrap_at: typeof previous?.last_wrap_at === "string" ? previous.last_wrap_at : null,
      sweeps_in_walk: Number.isInteger(previous?.sweeps_in_walk) ? previous.sweeps_in_walk : 0,
    }
  } catch {
    // No walk to resume: the pass starts from the first orphan.
  }
  const hungRecord = () => (Object.keys(hung).length > 0 ? { hung } : {})
  try {
    await write(env, { orphans: { started_at: startedAt, ...walk, ...hungRecord() } })
  } catch {
    // The pass still runs; the closing record may still be written.
  }
  const attempt = async (name) => {
    try {
      await write(env, { orphans: { started_at: startedAt, ...walk, ...hungRecord(), cursor: name, attempting: name } })
    } catch {
      // The pass still runs; only the protection against a stop inside this derive is lost.
    }
  }
  let orphans
  try {
    const pass = await orphanPass(env, { now, quietMs, markers, cap, budgetMs, clock, retractions, ownVersion, cursor: walk.cursor, hung, version, attempt, derive, pruneCopy })
    const { wrapped, ...counts } = pass
    orphans = { started_at: startedAt, ran_at: new Date(now()).toISOString(), ...counts, last_wrap_at: wrapped ? new Date(now()).toISOString() : walk.last_wrap_at, sweeps_in_walk: wrapped ? 0 : walk.sweeps_in_walk + 1, ...hungRecord() }
  } catch {
    orphans = { started_at: startedAt, ran_at: new Date(now()).toISOString(), ...walk, ...hungRecord(), failed: ORPHAN_PASS_FAILED }
  }
  try {
    await write(env, { orphans })
  } catch {
    // The start record stands, with no result: it reads as a pass that did not finish.
  }
  // A failed pass has no counts to give: they are absent, never zeros.
  if (orphans.failed !== undefined) return { orphans }
  return { rebuilt: orphans.rebuilt, current: orphans.current, pending: orphans.pending, unexamined: orphans.unexamined, frozen: Object.values(orphans.frozen).reduce((sum, count) => sum + count, 0), orphans }
}

// Plain code-unit order, the same in every locale, so the cursor means the same thing in every session.
const byName = (a, b) => Number(a.name > b.name) - Number(a.name < b.name)

async function orphanPass(env, { now, quietMs, markers, cap, budgetMs, clock, retractions, ownVersion, cursor, hung, version, attempt, derive, pruneCopy }) {
  const kept = new Set((markers ?? await listMarkers(env)).map((marker) => `${marker.host}-${marker.session_id}.json`))
  const receipts = (await readStatus(env)).derivations
  const all = (await outboxCopies(env, "claude-code")).filter(({ name }) => !kept.has(name)).sort(byName)
  // Start after the cursor and wrap.
  const after = cursor === null ? 0 : all.findIndex(({ name }) => name > cursor)
  const start = after === -1 ? 0 : after
  const copies = [...all.slice(start), ...all.slice(0, start)]
  const tail = all.length - start
  const retracted = await retractions(env)
  const find = transcriptFinder(env)
  const started = clock()
  let spent = 0
  let taken = 0
  // Takes one of this pass's transcript-work slots, or says there is none left (the cap, or the time budget). `refund` gives the slot back
  // (the orphan was served but needs no transcript work); the orphan still counts as reached for the cursor.
  const room = () => {
    if (spent >= cap || clock() - started >= budgetMs) return false
    spent += 1
    taken += 1
    return true
  }
  const refund = () => {
    spent -= 1
  }
  let oldestMs = null
  const noteWaiting = (sinceMs) => {
    const age = Math.max(0, now() - sinceMs)
    oldestMs = oldestMs === null ? age : Math.max(oldestMs, age)
  }
  const tally = { rebuilt: 0, current: 0, pending: 0, unexamined: 0, frozen: zeroReasons() }
  let last = cursor
  let tailUnexamined = 0
  let copiesPruned = 0
  let copiesPruneFailed = 0
  for (const [index, { store, name }] of copies.entries()) {
    let outcome
    const before = taken
    try {
      outcome = await rebuildOrphan(env, { store, name, receipts, retracted, retractions, find, room, refund, noteWaiting, now, quietMs, ownVersion, attempt, derive, hung, version, pruneCopy, pruned: () => { copiesPruned += 1 }, pruneFailed: () => { copiesPruneFailed += 1 } })
    } catch {
      outcome = "derive_failed"
    }
    if (taken > before) last = name
    if ((outcome === "rebuilt" || outcome === "current") && hung[name] !== undefined) delete hung[name]
    if (outcome === "unexamined" && index < tail) tailUnexamined += 1
    if (ORPHAN_REASONS.includes(outcome)) tally.frozen[outcome] += 1
    else tally[outcome] += 1
  }
  // The walk wrapped when every orphan from the cursor to the end of the list was reached.
  return { cursor: last, wrapped: tailUnexamined === 0, examined: copies.length - tally.unexamined, worked: taken, ...tally, oldest_pending_days: oldestMs === null ? null : Math.floor(oldestMs / DAY_MS), ...(copiesPruned > 0 ? { copies_pruned: copiesPruned } : {}), ...(copiesPruneFailed > 0 ? { copies_prune_failed: copiesPruneFailed } : {}) }
}

// One orphan: "rebuilt", "current", "pending" (examined, waiting for a known reason), "unexamined" (no slot left this sweep) or the reason it stays frozen.
async function rebuildOrphan(env, { store, name, receipts, retracted, retractions, find, room, refund, noteWaiting, now, quietMs, ownVersion, attempt, derive, hung, version, pruneCopy, pruned, pruneFailed }) {
  if (retracted.has(name)) return "retracted"
  const receiptRoot = deskRootOf(receipts, [name])
  if (receiptRoot !== undefined) {
    const refusal = rootRefusal(receiptRoot, store)
    if (refusal !== null) return refusal
  }
  if (!room()) return "unexamined"
  const facts = await readLocalFacts(env, store, name)
  if (facts === null || `claude-code-${facts.session.id}.json` !== name) return "no_facts"
  const { end_reason: endReason, ended_at: endedAt } = facts.session
  const plugins = facts.plugins.map(({ name: pluginName, version, source }) => (source === null ? { name: pluginName, version } : { name: pluginName, version, source }))
  // The time the session's own record gives, for the hold below and for the marker, never now: so a hold can expire.
  const recordedAt = endedAt !== null ? Date.parse(endedAt) : (await fs.stat(path.join(await factoryStateRoot(env), "outbox", store.replace("/", "__"), name))).mtimeMs
  if (newerDeskRecorded(ownVersion, plugins)) {
    refund()
    if (now() - recordedAt > STALE_DERIVER_HOLD_MS) return "recorded_by_newer_desk"
    noteWaiting(recordedAt)
    return "pending"
  }
  const transcript = await find(facts.session.id)
  if (transcript === null) {
    // Delivered, recorded long ago and its transcript gone: nothing can rebuild it and the host no longer lists it, so the local copy is inventory. It goes; the store keeps the facts.
    if (now() - recordedAt > COPY_RETENTION_MS) {
      let removed = false
      try {
        removed = await pruneCopy(env, store, name)
      } catch {
        // Counted, never swallowed: the copy stays and the next sweep tries again.
        pruneFailed()
      }
      if (removed) pruned()
    }
    return "no_transcript"
  }
  const receipt = receipts?.[name]
  if (receipt?.store === store && receipt.binding_version >= BINDING_VERSION && sameSource(receipt, await sourceStamp(transcript))) {
    // A current orphan needs no derive, so it gives its slot back: a long list of current orphans no longer makes a new one wait ceil(N / cap) sweeps for its turn. The time budget still bounds the checks.
    refund()
    return "current"
  }
  // A derive that was interrupted twice under this Desk is not tried again until a newer one (a derive that finished is `current` above).
  if (hung[name]?.version === version && hung[name].strikes >= ORPHAN_HUNG_STRIKES) return "derive_failed"
  let root = receiptRoot
  if (root === undefined) {
    root = await cwdRoot(transcript)
    if (root === null) return "no_desk_root"
    const refusal = rootRefusal(root, store)
    if (refusal !== null) return refusal
  }
  const marker = { schema_version: 1, host: "claude-code", session_id: facts.session.id, log_path: transcript, cwd: root, desk_root: root, end_reason: endReason, ended_at: endedAt, plugins, updated_at: new Date(recordedAt).toISOString() }
  const admit = async () => ((await retractions(env)).has(name) ? "retracted" : null)
  await attempt(name)
  const { result, reason } = await derive(env, marker, { quietMs, admit, ownVersion })
  if (result === "written") return "rebuilt"
  // Inside the quiet window, or the source changed: not done yet.
  if (result === "skipped") {
    noteWaiting(recordedAt)
    return "pending"
  }
  if (result === "refused") return reason
  // The desk no longer yields a store (or a root): nothing to wait for.
  if (result === "held") return "route_unknown"
  return result === "not_opted_in" ? "not_opted_in" : "derive_failed"
}

// Where a session with a copy belongs now, for the sweep's keeping step (`keepCopiesElsewhere`): a store on a positive route, `null` when no
// route can be found (an unknown route, or no desk folder that still resolves), else `undefined`. The desk folder is the marker's, else the one
// its receipt recorded, else (no marker and no receipt: `status.json` was lost) the one its Claude Code transcript names, as the orphan pass
// reads it, so a copy that pass could still rebuild is never kept away from its store.
async function keepRoute(marker, { receipts, session, markers, find }) {
  let deskRoot = deskRootOf(receipts, ENUMS.host.map((host) => `${host}-${session}.json`))
  if (marker === null && deskRoot === undefined) {
    const transcript = await find(session)
    deskRoot = (transcript === null ? null : await cwdRoot(transcript).catch(() => null)) ?? undefined
  }
  const route = sessionRoute(marker, { siblings: () => markers, deskRoot })
  if (route.kind === "store") return route.store
  if (route.kind === "unknown") return null
  return [marker?.desk_root, deskRoot].some((root) => typeof root === "string" && isFolder(root)) ? undefined : null
}

export async function sweep(env, { quietMs = 600000 } = {}) {
  const summary = { written: 0, held: 0, route_unverified: 0, skipped: 0, not_opted_in: 0, log_missing: 0, source_unreadable: 0, invalid: 0, coverage: null }
  try {
    if (!(await jobsIndexRebuilt(env))) await rebuildJobsIndex(env)
  } catch {
    // The rebuild retries on the next sweep; it must never stop this one deriving.
  }
  const markers = await listMarkers(env)
  const siblings = lazyProofIndex(async () => markers)
  for (const marker of markers) {
    const { result, reason } = await deriveMarker(env, marker, { quietMs, requireStored: true, siblings })
    summary[result] += 1
    if (reason === "route_unverified") summary.route_unverified += 1
  }
  // Every held route is counted with its reason (`held-route.js`), for `desk_doctor` and the boot line: a hold is never silent.
  await writeStatus(env, { route_holds: { ...routeHolds(markers), at: new Date().toISOString() } }).catch(() => {})
  // The orphan pass records its own failure (`orphans.failed`) and never throws, so it cannot stop a sweep.
  Object.assign(summary, await rebuildOrphans(env, { quietMs, markers }))
  // "Away" is made durable as soon as anything shows it: every session with a copy in some store's outbox is routed as the flush routes it
  // (its marker, else the desk folder its receipt recorded), and a copy in a store it no longer routes to moves to that store's
  // `retracted-copies/`, so that store never publishes it again once the marker and `status.json` are gone, even when its own flush (which
  // does the same for the stores it flushes) never runs because its consent is off. A session with no route at all (an invalid declaration, or
  // no recorded desk folder that still resolves) belongs nowhere and is kept in every store. It runs after the orphan pass, so a copy that pass
  // rebuilds has its receipt first.
  try {
    const receipts = (await readStatus(env)).derivations
    const bySession = new Map(markers.map((marker) => [marker.session_id, marker]))
    const memo = new Map()
    const find = transcriptFinder(env)
    const routeOf = async (session) => {
      if (!memo.has(session)) memo.set(session, await keepRoute(bySession.get(session) ?? null, { receipts, session, markers, find }))
      return memo.get(session)
    }
    summary.kept_elsewhere = (await keepCopiesElsewhere(env, routeOf)).length
    // A positive route seen here is checked: it is recorded, as the flush records it, so the session keeps it once its marker is pruned.
    const checked = {}
    for (const [session, target] of memo) {
      if (typeof target !== "string") continue
      const names = ENUMS.host.map((host) => `${host}-${session}.json`).filter((name) => isPlainObject(receipts?.[name]))
      const deskRoot = bySession.get(session)?.desk_root ?? deskRootOf(receipts, names)
      for (const name of names.filter((name) => receipts[name].checked_route !== target && typeof deskRoot === "string")) checked[name] = { store: target, deskRoot }
    }
    if (Object.keys(checked).length > 0) await recordRoutes(env, checked)
  } catch {
    // The flush of each consented store still moves the copies of its sessions that are not here; this step is the second line for the rest.
    summary.kept_elsewhere = null
  }
  // Tombstones past their retention go (inventory). The result is a count, or a fixed code when the pruning itself failed, so a stopped part signals.
  let retention
  try {
    retention = { ran_at: new Date().toISOString(), tombstones_pruned: await pruneTombstones(env) }
  } catch {
    retention = { ran_at: new Date().toISOString(), failed: "prune_failed" }
  }
  await writeStatus(env, { retention }).catch(() => undefined)
  // Capture coverage never throws and keeps the previous record when it fails.
  summary.coverage = await recordCoverage(env, { markers, orphans: summary.orphans, bindingVersion: BINDING_VERSION })
  // `route_unverified` counts the Codex markers held inside `held`; `factory.js status` shows it.
  try {
    await writeStatus(env, { held_markers: { route_unverified: summary.route_unverified } })
  } catch {
    // The status line is only a report; it must never stop a sweep.
  }
  return summary
}

// Whether the marker file is still there. `readMarker` and `deriveMarker` create Desk's state folders on the way, so a worker that waited while its home or state root was deleted must look first, with a plain stat that creates nothing.
async function markerPresent(file) {
  try {
    await fs.lstat(file)
    return true
  } catch {
    // Missing, or its folder is gone, or unreadable: in each case there is nothing for this worker to continue.
    return false
  }
}

export async function deriveFile(env, file, { quietMs = 0, maxWaitMs = 300000 } = {}) {
  let step = "read_marker"
  const logs = new Set()
  try {
    if (!(await markerPresent(file))) return { result: "invalid", store: null }
    let marker = await readMarker(env, file)
    if (marker === null) return { result: "invalid", store: null }
    logs.add(marker.log_path)
    const deadline = Date.now() + maxWaitMs
    step = "wait_quiet"
    while (quietMs > 0) {
      const stamp = await sourceStamp(marker.log_path)
      const remaining = quietMs - (Date.now() - stamp.mtime)
      if (remaining <= 0) break
      if (Date.now() + remaining > deadline) return { result: "skipped", store: null }
      await sleep(remaining)
      // The home, desk or state root may be gone by now (a throwaway profile, a removed desk): write nothing, create nothing.
      if (!(await markerPresent(file))) return { result: "invalid", store: null }
      marker = await readMarker(env, file)
      if (marker === null) return { result: "invalid", store: null }
      logs.add(marker.log_path)
    }
    return deriveMarker(env, marker, { quietMs, requireQuiet: true, requireStored: true })
  } catch (error) {
    await noteDerive(env, path.basename(file), { step, error, logs })
    return { result: error.code === "ENOENT" ? "log_missing" : "source_unreadable", store: null }
  }
}
