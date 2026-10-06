// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files, with one exception: `../desk/crew-roster.js` (the one crew rule),
// which itself imports only `node:` modules and says so in its header.
import { createHash } from "node:crypto"
import { readFileSync, realpathSync, statSync, promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { bindSession } from "./binding.js"
import { deriveClaudeSession } from "./derive-claude.js"
import { deriveCodexSession } from "./derive-codex.js"
import { deriveCopilotSession } from "./derive-copilot.js"
import { crewWorkspace } from "../desk/crew-roster.js"
import { createDeskReaders, readDeskRemote } from "./desk-repo.js"
import { validMarker } from "./marker.js"
import { factoryStateRoot, listMarkers, outboxCopies, retractionNames, readConsent, readLocalFacts, readMarker, jobsIndexRebuilt, rebuildJobsIndex, readStatus, setJobsForFile, withDerivationLock, writeLocalFacts, writeStatus } from "./outbox.js"
import { compareVersions, isVersion } from "./pipeline/versions.js"
import { backfillPluginSources } from "./plugin-registry.js"
import { githubRepoOfRemote } from "./desk-visibility.js"
import { isPlainObject } from "./schema.js"
import { declared, deskRootOf, markerRoute, proofIndex, provenBy } from "./session-route.js"
import { reconcileMarker } from "./session-lifetime.js"

async function sourceStamp(file) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.nlink !== 1) throw new Error("source_unreadable")
  return { size: stat.size, mtime: stat.mtimeMs, ino: stat.ino, dev: stat.dev }
}

/** Bump when binding changes what a derived session credits; sessions with a lower or missing receipt version re-derive once. */
export const BINDING_VERSION = 5

const sameSource = (a, b) => a.size === b.size && a.mtime === b.mtime && a.ino === b.ino && a.dev === b.dev

function markerHash(marker) {
  const { updated_at, ...content } = marker
  return createHash("sha256").update(JSON.stringify(content)).digest("hex")
}

// The version of Desk actually running this code, read from the plugin.json
// that ships beside it. A long-lived session's own plugin metadata can name a
// newer Desk than the one still executing (its hook stays pinned to whatever
// was on disk when the session started), so this is never taken from a
// marker or an installed-plugins registry.
function ownDeskVersion() {
  return JSON.parse(readFileSync(new URL("../../../plugin.json", import.meta.url), "utf8")).version
}

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

export async function deriveMarker(env, marker, { claude = deriveClaudeSession, copilot = deriveCopilotSession, codex = deriveCodexSession, quietMs = 0, requireQuiet = false, requireStored = false, ownVersion = ownDeskVersion, now = Date.now, siblings = lazyProofIndex(() => listMarkers(env)), admit = null } = {}) {
  if (!validMarker(marker)) return { result: "invalid", store: null }
  if (marker.desk_root === null) return { result: "held", store: null }
  try {
    return await withDerivationLock(env, `${marker.host}-${marker.session_id}.json`, (root) => deriveUnlocked(env, marker, { claude, copilot, codex, quietMs, requireQuiet, requireStored, root, ownVersion, now, siblings, admit }), { deskRoot: marker.desk_root })
  } catch {
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
async function deriveUnlocked(env, input, { claude, copilot, codex, quietMs, requireQuiet, requireStored, root, ownVersion, now, siblings, admit }) {
  let store = null
  try {
    let marker = await newestMarker(env, root, input, requireStored)
    if (marker.desk_root === null) return { result: "held", store }
    if (isStaleDeriver(ownVersion, marker.plugins, marker.updated_at, now)) return { result: "held", store }
    await factoryStateRoot(env, { deskRoot: marker.desk_root })
    const route = markerRoute(marker)
    store = route.store
    const refusal = admit === null ? null : await admit()
    if (refusal !== null) return { result: "refused", store, reason: refusal }
    const name = `${marker.host}-${marker.session_id}.json`
    if (route.warnings.length) await writeStatus(env, { routing_warnings: route.warnings })
    if (store === null) return { result: "held", store }
    if ((await readConsent(env)).stores[store]?.contribute !== true) return { result: "not_opted_in", store }
    if (marker.host === "codex-cli" && route.source === "default" && !provenBy(marker, await siblings())) return { result: "held", store: null, reason: "route_unverified" }
    const before = await sourceStamp(marker.log_path)
    marker = await reconcileMarker(marker)
    if (!sameSource(before, await sourceStamp(marker.log_path))) return { result: "skipped", store }
    if (quietMs > 0 && (requireQuiet || marker.ended_at === null) && Date.now() - before.mtime < quietMs) return { result: "skipped", store }
    const hash = markerHash(marker)
    const receipt = (await readStatus(env)).derivations?.[name]
    const destination = path.join(root, "outbox", store.replace("/", "__"), name)
    if (receipt?.store === store && receipt.marker === hash && receipt.binding_version >= BINDING_VERSION && sameSource(receipt, before)) {
      try {
        await sourceStamp(destination)
        return { result: "skipped", store }
      } catch {
        // A lost outbox file must be rebuilt even when the log is unchanged.
      }
    }
    let derived
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
    const personPrefix = marker.person_prefix ?? ""
    const deskRoot = marker.desk_root
    const deskRemote = readDeskRemote({ deskRoot })
    const { jobs, boundBy, disagrees, ownActivity, repoUnresolved, segmentsCappedMs } = bindSession({
      events: derived.events, agents: derived.facts.agents, session: derived.facts.session, deskRoot, deskRemote, personPrefix,
      ...createDeskReaders({ deskRoot, personPrefix }),
    })
    derived.facts.jobs = jobs
    // The decision that guards the write is made again right before it: the derivation above is long.
    const late = admit === null ? null : await admit()
    if (late !== null) return { result: "refused", store, reason: late }
    const written = await writeLocalFacts(env, store, derived.facts)
    if (!written.written) return { result: written.errors.length ? "invalid" : "not_opted_in", store }
    await setJobsForFile(env, written.name, jobs.map((j) => j.job))
    // `desk_root` stays local: the flush reads the desk's declaration from it once the marker is pruned (`session-route.js`).
    // So do `bound_by` (job ID -> "focus" | "inferred"), `own_activity` (spans in ms from the session's start), `focus_disagrees` (job IDs)
    // `repo_unresolved` (how many distinct directories outside the desk no longer exist and named no repository: lost evidence; a
    // directory that exists and is in no repository, or in one with no origin, is a true none and is not counted) and
    // `segments_capped_ms` (the time the segment cap dropped, 0 when none), which `factory reconcile` reads because it
    // cannot see transcripts; they are never written to facts. `desk_repo` (the desk's GitHub repository, lower case, absent when it has none)
    // is what the flush compares with the desk root's repository once the marker is pruned, so a session is published under its desk's
    // protection only when the desk is certainly the same one; a receipt without it is uncertain. `desk_unprotected` (set by the flush) is carried over.
    const deskRepo = githubRepoOfRemote(deskRemote)?.toLowerCase()
    await writeStatus(env, { derivations: { [name]: { store, marker: hash, binding_version: BINDING_VERSION, desk_root: deskRoot, bound_by: boundBy, own_activity: ownActivity, focus_disagrees: disagrees, repo_unresolved: repoUnresolved, segments_capped_ms: segmentsCappedMs, ...(deskRepo === undefined ? {} : { desk_repo: deskRepo }), ...(receipt?.desk_unprotected === true ? { desk_unprotected: true } : {}), ...before } } })
    return { result: "written", store }
  } catch (error) {
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
 * transcript, its stat, the derive) only inside `cap` orphans and `budgetMs` (`clock` is milliseconds). The others are `unexamined`. An orphan
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
export async function rebuildOrphans(env, { now = Date.now, quietMs = 0, markers = null, cap = ORPHAN_EXAMINE_CAP, budgetMs = ORPHAN_BUDGET_MS, clock = Date.now, retractions = retractionNames, ownVersion = ownDeskVersion, write = writeStatus, derive = deriveMarker } = {}) {
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
    const pass = await orphanPass(env, { now, quietMs, markers, cap, budgetMs, clock, retractions, ownVersion, cursor: walk.cursor, hung, version, attempt, derive })
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

async function orphanPass(env, { now, quietMs, markers, cap, budgetMs, clock, retractions, ownVersion, cursor, hung, version, attempt, derive }) {
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
  for (const [index, { store, name }] of copies.entries()) {
    let outcome
    const before = taken
    try {
      outcome = await rebuildOrphan(env, { store, name, receipts, retracted, retractions, find, room, refund, noteWaiting, now, quietMs, ownVersion, attempt, derive, hung, version })
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
  return { cursor: last, wrapped: tailUnexamined === 0, examined: copies.length - tally.unexamined, worked: taken, ...tally, oldest_pending_days: oldestMs === null ? null : Math.floor(oldestMs / DAY_MS) }
}

// One orphan: "rebuilt", "current", "pending" (examined, waiting for a known reason), "unexamined" (no slot left this sweep) or the reason it stays frozen.
async function rebuildOrphan(env, { store, name, receipts, retracted, retractions, find, room, refund, noteWaiting, now, quietMs, ownVersion, attempt, derive, hung, version }) {
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
  if (transcript === null) return "no_transcript"
  const receipt = receipts?.[name]
  if (receipt?.store === store && receipt.binding_version >= BINDING_VERSION && sameSource(receipt, await sourceStamp(transcript))) return "current"
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

export async function sweep(env, { quietMs = 600000 } = {}) {
  const summary = { written: 0, held: 0, route_unverified: 0, skipped: 0, not_opted_in: 0, log_missing: 0, source_unreadable: 0, invalid: 0 }
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
  // The orphan pass records its own failure (`orphans.failed`) and never throws, so it cannot stop a sweep.
  Object.assign(summary, await rebuildOrphans(env, { quietMs, markers }))
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
  try {
    if (!(await markerPresent(file))) return { result: "invalid", store: null }
    let marker = await readMarker(env, file)
    if (marker === null) return { result: "invalid", store: null }
    const deadline = Date.now() + maxWaitMs
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
    }
    return deriveMarker(env, marker, { quietMs, requireQuiet: true, requireStored: true })
  } catch (error) {
    return { result: error.code === "ENOENT" ? "log_missing" : "source_unreadable", store: null }
  }
}
