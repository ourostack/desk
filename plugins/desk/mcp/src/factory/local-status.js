// The factory's local status: what desk_status, desk_doctor and the task
// tools need to know about the bound desk's store, read synchronously from
// bounded local state and never written.
//
// `factoryLocalStatus({ env, deskRoot, pluginDirs, pluginScanIncomplete })`
// resolves the desk's store exactly as the end hook and the boot check do
// (`resolveStore`; an incomplete plugin scan holds routing unless the desk
// declares its own store) and returns:
//
//   {
//     store:   "<owner/repo>" | null,
//     source:  "desk" | "overlay" | "default" | "invalid_declaration" | "plugin_scan_incomplete" | "no_desk",
//     consent: "yes" | "no" | "undecided" | "unreadable" | "held",
//     stores:  [{ store, consent, pending, route_changed, quarantined, last_flush }],
//     warnings: ["manifest_unreadable" | "manifest_unparseable", ...],
//   }
//
// `consent` is the resolved store's decision; `held` means no store is
// resolved, so nothing is asked and nothing is sent. `stores` lists the
// resolved store first, then every other store with a recorded decision,
// sorted. `pending` counts the store's outbox files never delivered and not
// quarantined whose session the flush would publish there (`here`, or
// `unknown`, waiting for its route); `route_changed` counts its outbox files
// and kept copies (`retracted-copies/`), not quarantined, whose session routes
// elsewhere as the flush reads it (`session-route.js`: `away`, including a
// finished retraction's tombstone, `stale` or `stalled`; a copy without a
// positive route here and no checked route here is `stale`): the flush never publishes them there; `quarantined`
// counts its quarantined files; `last_flush` is the last flush's result
// code, or `null`.
//
// `visibility_unasked` is present only when a store's flushes have held sessions back, unable to ask their desk's visibility, for over 7 days:
// `[{ store, sessions }]` (the last flush records `visibility_unasked` and `visibility_unasked_since`).
// `orphans` is present only when the orphan pass (`derive-run.js` `rebuildOrphans`) needs attention: `"pass_failed"` (the last pass threw),
// `"pass_interrupted"` (a record with a start older than `ORPHAN_INTERRUPTED_MS`, or with a start that does not parse, and no result),
// `"orphans_hung"` (an orphan was interrupted twice and is frozen; `orphans_hung` then counts them), `"pass_stale"` (the last pass ran more than
// `ORPHAN_STALE_MS` ago) or `"walk_not_advancing"` (`sweeps_in_walk` is past `ceil((worked + unexamined) / max(1, worked))`, `worked` counting only
// the orphans that took a transcript slot, so the walk should have wrapped). `orphanPassLine(record, now)` is the one-line
// reading `factory.js status` prints; both read counts, times and fixed codes only.
// `retention` is present only when a pruning part stopped (`retention.js` `retentionFinding`): `"prune_failed"` (the last sweep's tombstone
// pruning failed) or `"copies_prune_failed"` (the last orphan pass counted a delivered-copy prune that threw). `capture_check_unavailable` is
// present only when a store's own capture check could not read the record `CHECK_UNAVAILABLE_ALARM` (3) or more times in a row:
// `[{ store, times }]`. Like `orphans`, both are pushed to the doctor and the boot status, not only shown by `factory.js status`.
//
// The result carries store names, codes and counts only: never the machine
// secret, an account, an intake ID, a token or any content, and no local
// path or time except where a held route needs one to be fixed. Manifest
// warnings keep their codes and drop their paths. `held_by` (this desk's
// route is held now), `route_holds` (`{ count, reasons }`: the sessions the
// last sweep counted as held, `held-route.js` `routeHolds`) and
// `held_pruned` (`{ count, last_at }`: held sessions pruned uncaptured after
// 90 days) name each hold's reason, the manifest or plugin folder to fix
// (`path`, or `null` when the hook named none) and its remedy, so a hold is
// never silent; the doctor and the boot print them.
//
// `factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug,
// pluginDirs, pluginScanIncomplete })` is the task card's `factory_report`
// link, `{ link }`, when the resolved store has consent `contribute: true`
// and the desk is known to be private: its cached visibility is `private` or
// `internal`, so the store publishes the plain job ID the link names. Any
// other contributing desk gets `{ link: null, reason }`: `desk_not_private`
// (a public or unknown desk, or one with no GitHub remote: its store job is
// keyed so that nobody can tie the desk's public cards to it, and a link
// would make that tie) or `visibility_not_known` (a GitHub desk whose cached
// answer is expired, absent or unreadable). Without consent it is
// `{ link: null }` with no reason: the factory is not in use for this desk.
// A link names the job's report path; the report exists only once the store
// has merged facts for the job and rebuilt its reports, so a job never
// credited with a session has none.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { readFileSync, readdirSync, statSync } from "node:fs"
import * as path from "node:path"

import { consentDecision, consentRecords as readConsentRecords, factoryStateDir } from "./boot-check.js"
import { jobId } from "./binding.js"
import { deskTimingKept, deskVisibilityOf, freshVisibility, githubRepoOfRemote, visibilityMap } from "./desk-visibility.js"
import { readSmallText, validMarker } from "./marker.js"
import { jobReportUrl } from "./pipeline/build.js"
import { ENUMS, PATTERNS, isPlainObject } from "./schema.js"
import { captureCheckFindings, retentionFinding } from "./retention.js"
import { HOLD_REMEDIES, holdReason } from "./held-route.js"
import { RETRACTED_COPIES, derivedStoreOf, deskRootOf, isFolder, sessionPlace, sessionRoute } from "./session-route.js"
import { resolveStore } from "./store-route.js"

const STATE_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 4096
const OUTBOX_NAME = new RegExp(`^(?:${ENUMS.host.join("|")})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`, "u")
const RESULT_CODE = /^[a-z][a-z0-9_]{0,63}$/u
const UNREADABLE = Symbol("unreadable")
// The places whose files the flush never publishes to the store they sit in (`session-route.js`).
const ELSEWHERE = new Set(["away", "stale", "stalled"])

/** A JSON object state file: `fallback` when absent, `UNREADABLE` when unsafe, unreadable or not an object (as the boot check reads it). */
function readState(file, fallback) {
  let text
  try {
    text = readSmallText(file, STATE_BYTES)
  } catch (error) {
    return error.code === "ENOENT" ? fallback : UNREADABLE
  }
  try {
    const value = JSON.parse(text)
    return isPlainObject(value) ? value : UNREADABLE
  } catch {
    return UNREADABLE
  }
}

/** How long a pass may run before a record with a start and no result reads as interrupted: past the 150 s the start hook allows. */
export const ORPHAN_INTERRUPTED_MS = 5 * 60 * 1000
/** How long since the last pass ran before the doctor reports it: the pass runs at every session start. */
export const ORPHAN_STALE_MS = 2 * 24 * 60 * 60 * 1000
/** Interrupted passes that freeze an orphan (`derive-run.js` `ORPHAN_HUNG_STRIKES`; the status code stays in `src/factory/`). */
const HUNG_STRIKES = 2

const finiteCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/** The version of Desk running this code, from the plugin.json beside it, or `null` (the same source `derive-run.js` reads). */
export function ownVersion(read = readFileSync) {
  try {
    const { version } = JSON.parse(read(new URL("../../../plugin.json", import.meta.url), "utf8"))
    return typeof version === "string" ? version : null
  } catch {
    return null
  }
}

/** How many orphans the record holds frozen by repeated interruptions (two strikes) under Desk `version` (a newer Desk starts the count again), or 0. */
export function orphansHung(record, version) {
  if (!isPlainObject(record) || !isPlainObject(record.hung) || typeof version !== "string") return 0
  return Object.values(record.hung).filter((entry) => isPlainObject(entry) && entry.version === version && Number.isSafeInteger(entry.strikes) && entry.strikes >= HUNG_STRIKES).length
}

/**
 * What is wrong with the orphan pass's record, or `null`: see the header. `now` is milliseconds; `version` is the running Desk's (hung strikes of
 * another version do not count); `active` is whether this machine ended a session in the last `ORPHAN_STALE_MS` (a machine that stopped
 * contributing is not alarmed that the pass has not run).
 */
export function orphanPassFinding(record, now = Date.now(), { version = null, active = false } = {}) {
  if (!isPlainObject(record)) return null
  if (record.failed !== undefined) return "pass_failed"
  // A start time that does not parse is never "running".
  if (record.ran_at === undefined) return now - Date.parse(record.started_at) <= ORPHAN_INTERRUPTED_MS ? null : "pass_interrupted"
  if (orphansHung(record, version) > 0) return "orphans_hung"
  if (active && now - Date.parse(record.ran_at) > ORPHAN_STALE_MS) return "pass_stale"
  // `worked` is the orphans that took a transcript slot (a record from before it counted `examined`, which includes cheaply frozen ones).
  const worked = finiteCount(record.worked) ?? finiteCount(record.examined)
  const unexamined = finiteCount(record.unexamined)
  const sweeps = finiteCount(record.sweeps_in_walk)
  if (worked === null || unexamined === null || sweeps === null) return null
  return sweeps > Math.ceil((worked + unexamined) / Math.max(1, worked)) ? "walk_not_advancing" : null
}

/** Whether any marker on this machine records a session that ended within `ORPHAN_STALE_MS`. */
function endedSessionRecently(dir, now = Date.now()) {
  return outboxNames(path.join(dir, "markers")).some((name) => {
    const marker = readState(path.join(dir, "markers", name), null)
    return validMarker(marker) && typeof marker.ended_at === "string" && now - Date.parse(marker.ended_at) <= ORPHAN_STALE_MS
  })
}

/** How long a desk's visibility may go unasked (every flush deferring its sessions) before the doctor reports it. */
export const UNASKED_REPORT_MS = 7 * 24 * 60 * 60 * 1000

/** `[{ store, sessions, age? }]` (`age: "unknown"` when the start time does not parse) for each store whose last flush has held sessions back for want of a visibility answer for longer than `UNASKED_REPORT_MS`. */
export function visibilityUnasked(lastFlush, stores, now = Date.now()) {
  if (!isPlainObject(lastFlush)) return []
  return stores.flatMap((store) => {
    const entry = lastFlush[store]
    if (!isPlainObject(entry) || !Number.isSafeInteger(entry.visibility_unasked) || entry.visibility_unasked <= 0) return []
    const age = now - Date.parse(entry.visibility_unasked_since)
    // A start time that does not parse is a deferral of unknown age, reported, never ignored.
    if (Number.isNaN(age)) return [{ store, sessions: entry.visibility_unasked, age: "unknown" }]
    return age > UNASKED_REPORT_MS ? [{ store, sessions: entry.visibility_unasked }] : []
  })
}

/** One sentence saying what to do about sessions held back for want of a visibility answer. */
export const UNASKED_ADVICE = (store) => `Run \`node mcp/scripts/factory.js flush --store ${store}\` from the Desk plugin folder and read its result; if it keeps failing, file a Desk problem.`

/** One sentence saying what to do about a finding. */
export const ORPHAN_FINDING_ADVICE = "Run `node mcp/scripts/factory.js status` from the Desk plugin folder and read its orphan_pass line; if the pass keeps failing or stalling, file a Desk problem."

/** One sentence saying what to do about a retention finding. */
export const RETENTION_FINDING_ADVICE = "Run `node mcp/scripts/factory.js status` from the Desk plugin folder and read its retention line; if pruning keeps failing, file a Desk problem."

/** One sentence saying what to do about a store whose own capture check keeps failing. */
export const CAPTURE_CHECK_ADVICE = (store) => `The store's own check, not this machine, is failing: file a problem against ${store}'s capture check, and run \`node mcp/scripts/factory.js status\` from the Desk plugin folder to see its capture line.`

/** One line for the orphan pass's record: counts, times and fixed codes only (a failure is its class, never a message). */
export function orphanPassLine(record, now = Date.now(), { version = null } = {}) {
  if (!isPlainObject(record)) return "orphan pass: no record yet"
  const wrap = typeof record.last_wrap_at === "string" ? record.last_wrap_at : "never"
  if (record.failed !== undefined) return `orphan pass: failed (${typeof record.failed === "string" && RESULT_CODE.test(record.failed) ? record.failed : "unknown"}), last full walk ${wrap}`
  if (record.ran_at === undefined) return `orphan pass: ${orphanPassFinding(record, now, { version }) === null ? "running" : "interrupted"}, started ${typeof record.started_at === "string" ? record.started_at : "unknown"}, last full walk ${wrap}`
  const frozen = isPlainObject(record.frozen) ? Object.values(record.frozen).reduce((sum, count) => sum + (finiteCount(count) ?? 0), 0) : 0
  const count = (value) => finiteCount(value) ?? "unknown"
  const hung = orphansHung(record, version)
  return `orphan pass: ran ${record.ran_at}, examined ${count(record.examined)}, unexamined ${count(record.unexamined)}, pending ${count(record.pending)}, frozen ${frozen}${hung > 0 ? ` (${hung} hung)` : ""}, last full walk ${wrap}, ${count(record.sweeps_in_walk)} sweeps into the walk`
}

function outboxNames(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).slice(0, MAX_ENTRIES).filter((entry) => entry.isFile() && OUTBOX_NAME.test(entry.name)).map((entry) => entry.name)
  } catch {
    return []
  }
}

/** The recorded consent map, `{}` when nothing is decided, or `UNREADABLE`; read exactly as the boot check reads it. */
function consentRecords(dir) {
  return readConsentRecords(dir) ?? UNREADABLE
}

function decision(records, store) {
  return consentDecision(records === UNREADABLE ? null : records, store)
}

function route({ deskRoot, pluginDirs, pluginScanIncomplete }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) return { store: null, source: "no_desk", warnings: [] }
  const resolved = resolveStore({ deskRoot, pluginDirs, read: (file) => readSmallText(file) })
  // As in the end hook and the boot check: an incomplete scan may have missed an overlay's declaration.
  if (resolved.store !== null && pluginScanIncomplete && resolved.source !== "desk") return { store: null, source: "plugin_scan_incomplete", warnings: resolved.warnings }
  return resolved
}

// Where an outbox file's session routes now, for `store`, read from the markers and receipts the flush reads (`session-route.js`).
// A marker that is missing, unreadable or malformed says nothing new, as `listMarkers` drops it for the flush.
function placer(dir, receipts) {
  const markerOf = (name) => {
    const marker = readState(path.join(dir, "markers", name), null)
    return validMarker(marker) && `${marker.host}-${marker.session_id}.json` === name ? marker : null
  }
  let siblings = null
  const listSiblings = () => (siblings ??= outboxNames(path.join(dir, "markers")).map(markerOf).filter((marker) => marker !== null))
  // `retracting` is the store's retracting records and tombstones, by name. A session whose recorded desk folder no longer resolves is here
  // only on a positive route, as the flush reads it. Returns `{ place, positive }`.
  return (store, name, retracting) => {
    // An outbox name, like a labels key, ends in the 36-character session id and `.json`.
    const session = name.slice(-41, -5)
    const names = ENUMS.host.map((host) => `${host}-${session}.json`)
    const marker = names.map(markerOf).find((found) => found !== null) ?? null
    const records = Object.entries(retracting).filter(([key, record]) => key.slice(-41, -5) === session && isPlainObject(record)).map(([, record]) => record)
    const deskRoot = deskRootOf(receipts, names)
    const route = sessionRoute(marker, { siblings: listSiblings, deskRoot })
    const place = sessionPlace(store, route, derivedStoreOf(receipts, names), records)
    const recorded = [marker?.desk_root, deskRoot].filter((root) => typeof root === "string")
    const gone = recorded.length > 0 && !recorded.some(isFolder)
    return { place: place === "here" && route.kind !== "store" && gone ? "stale" : place, positive: route.kind === "store" }
  }
}

function storeEntry(dir, consents, store, lastFlush, place, now) {
  const slug = store.replace("/", "__")
  const delivered = readState(path.join(dir, "delivered", `${slug}.json`), {})
  const quarantined = new Set(outboxNames(path.join(dir, "quarantine", slug)))
  const retracting = readState(path.join(dir, "retracting", `${slug}.json`), {})
  // The kept copies of sessions that left the store (`session-route.js`) count with the outbox files: they are what `route_changed` reports.
  const records = retracting === UNREADABLE ? {} : retracting
  const live = new Set(outboxNames(path.join(dir, "outbox", slug)))
  const keptDir = path.join(dir, RETRACTED_COPIES, slug)
  const kept = outboxNames(keptDir).filter((name) => !live.has(name))
  const listed = [...new Set([...live, ...kept])].filter((name) => !quarantined.has(name))
  const away = new Set(listed.filter((name) => ELSEWHERE.has(place(store, name, records).place)))
  // Kept copies with no positive route anywhere that are not here on a checked route are frozen (never published, never deleted): counted, with
  // the oldest one's age.
  const frozen = kept.filter((name) => { const { place: where, positive } = place(store, name, records); return !positive && where !== "here" })
  const ages = frozen.map((name) => keptAgeDays(path.join(keptDir, name), now)).filter((days) => days !== null)
  const pending = listed.filter((name) => !away.has(name) && (delivered === UNREADABLE || !Object.hasOwn(delivered, name))).length
  const flush = isPlainObject(lastFlush) && isPlainObject(lastFlush[store]) ? lastFlush[store].result : null
  const waiting = isPlainObject(lastFlush) && isPlainObject(lastFlush[store]) && Number.isSafeInteger(lastFlush[store].visibility_unasked) ? lastFlush[store].visibility_unasked : 0
  const frozenFields = frozen.length > 0 ? { kept_frozen: frozen.length, kept_frozen_oldest_days: ages.length > 0 ? Math.max(...ages) : null } : {}
  return { store, consent: decision(consents, store), pending, ...(waiting > 0 ? { waiting_for_visibility: waiting } : {}), route_changed: away.size, quarantined: quarantined.size, ...frozenFields, last_flush: typeof flush === "string" && RESULT_CODE.test(flush) ? flush : null }
}

// A kept copy's age in whole days from its file's time, or null when it cannot be read.
function keptAgeDays(file, now) {
  try {
    return Math.max(0, Math.floor((now - statSync(file).mtimeMs) / (24 * 60 * 60 * 1000)))
  } catch {
    return null
  }
}

/** See the header. Never writes and never throws for missing or unreadable state. */
export function factoryLocalStatus({ env, deskRoot, pluginDirs = [], pluginScanIncomplete = false, pluginScanReason = null }) {
  const routing = route({ deskRoot, pluginDirs, pluginScanIncomplete })
  const dir = factoryStateDir(env)
  const records = consentRecords(dir)
  const status = readState(path.join(dir, "status.json"), {})
  const lastFlush = status === UNREADABLE ? null : status.last_flush
  const place = placer(dir, status === UNREADABLE ? {} : status.derivations)
  const decided = records === UNREADABLE ? [] : Object.keys(records).filter((store) => PATTERNS.prRepo.test(store)).sort()
  const stores = [...new Set([...(routing.store === null ? [] : [routing.store]), ...decided])]
  const version = ownVersion()
  // Contribution must be switched on for a stale pass to mean anything: a machine that wrote markers but never opted in has no pass to run.
  const contributing = stores.some((store) => decision(records, store) === "yes")
  const orphans = status === UNREADABLE ? null : orphanPassFinding(status.orphans, Date.now(), { version, active: contributing && endedSessionRecently(dir) })
  const unasked = visibilityUnasked(lastFlush, stores)
  const hung = status === UNREADABLE ? 0 : orphansHung(status.orphans, version)
  const retention = status === UNREADABLE ? null : retentionFinding(status)
  // Only a store this machine still contributes to: a count left from before consent was withdrawn never settles, so it is no finding.
  const captureCheck = status === UNREADABLE ? [] : captureCheckFindings(status).filter(({ store }) => PATTERNS.prRepo.test(store) && decision(records, store) === "yes")
  return {
    store: routing.store,
    source: routing.source,
    consent: routing.store === null ? "held" : decision(records, routing.store),
    stores: stores.map((store) => storeEntry(dir, records, store, lastFlush, place, Date.now())),
    warnings: [...new Set(routing.warnings.map((warning) => warning.code))].sort(),
    ...(orphans === null ? {} : { orphans }),
    ...(unasked.length > 0 ? { visibility_unasked: unasked } : {}),
    ...(hung > 0 ? { orphans_hung: hung } : {}),
    ...(retention === null ? {} : { retention }),
    ...(captureCheck.length > 0 ? { capture_check_unavailable: captureCheck } : {}),
    ...heldFields(routing, pluginScanReason, status === UNREADABLE ? {} : status),
  }
}

const HELD_PRUNED_SHOWN_MS = 30 * 24 * 60 * 60 * 1000
const described = (reason, file) => ({ reason, path: file, remedy: HOLD_REMEDIES[reason] })

// What holds routes, with the paths to fix and the remedy (`held-route.js`): this desk's own route now (`held_by`), the sessions the last sweep
// counted as held (`route_holds`), and the held sessions pruned uncaptured (`held_pruned`). Present only when there is something to say.
function heldFields(routing, scanReason, status) {
  const fields = {}
  if (routing.store === null && routing.warnings.length > 0) fields.held_by = routing.warnings.map(({ code, manifest }) => described(holdReason(manifest, { code }), manifest))
  else if (routing.source === "plugin_scan_incomplete") fields.held_by = [described(Object.hasOwn(HOLD_REMEDIES, scanReason ?? "") ? scanReason : "plugin_scan_incomplete", null)]
  const holds = status.route_holds
  if (isPlainObject(holds) && Number.isSafeInteger(holds.count) && holds.count > 0 && Array.isArray(holds.reasons)) {
    const reasons = holds.reasons.filter((entry) => isPlainObject(entry) && (entry.path === null || typeof entry.path === "string") && Number.isSafeInteger(entry.sessions))
    fields.route_holds = { count: holds.count, reasons: reasons.map((entry) => ({ ...described(holdReason(entry.path, { code: entry.code }), entry.path), sessions: entry.sessions })) }
  }
  const pruned = status.held_pruned
  // Said for 30 days after the last such prune: long enough to be read, never a standing line.
  const recent = isPlainObject(pruned) && Date.now() - Date.parse(pruned.last_at) <= HELD_PRUNED_SHOWN_MS
  if (recent && Number.isSafeInteger(pruned.count) && pruned.count > 0) fields.held_pruned = { count: pruned.count, last_at: pruned.last_at }
  return fields
}

/**
 * The job ID a task card may link for plain job ID `job` of the desk at `deskRemote`, read from this machine's factory state without creating
 * anything: `{ job }` for a desk whose cached visibility is `private` or `internal`, else `{ job: null, reason }` with `visibility_not_known`
 * (a GitHub desk whose cached answer is expired, absent or unreadable) or `desk_not_private` (any other desk). See the header.
 */
export function publishedJobId({ env, deskRemote, job, now = Date.now() }) {
  const repo = githubRepoOfRemote(deskRemote)
  if (repo === null) return { job: null, reason: "desk_not_private" }
  const cached = readState(path.join(factoryStateDir(env), "visibility.json"), {})
  const known = cached === UNREADABLE ? new Map() : visibilityMap(freshVisibility(cached, now))
  if (!known.has(repo.toLowerCase())) return { job: null, reason: "visibility_not_known" }
  return deskTimingKept(deskVisibilityOf(repo, known)) ? { job } : { job: null, reason: "desk_not_private" }
}

/**
 * See the header: `{ link }`, the task card's `factory_report` link; `{ link: null, reason }` when the desk contributes but no link can be
 * named; `{ link: null }` when the resolved store has no consent `contribute: true`, so the factory is not in use for this desk.
 */
export function factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug, pluginDirs = [], pluginScanIncomplete = false }) {
  const routing = route({ deskRoot, pluginDirs, pluginScanIncomplete })
  if (routing.store === null || decision(consentRecords(factoryStateDir(env)), routing.store) !== "yes") return { link: null }
  const { job, reason } = publishedJobId({ env, deskRemote, job: jobId({ deskRemote, personPrefix, track, slug }) })
  return job === null ? { link: null, reason } : { link: jobReportUrl({ store: routing.store, job }) }
}
