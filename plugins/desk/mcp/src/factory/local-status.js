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
// `unknown`, waiting for its route); `route_changed` counts its outbox files,
// not quarantined, whose session routes elsewhere as the flush reads it
// (`session-route.js`: `away`, including a finished retraction's tombstone,
// `stale` or `stalled`): the flush never publishes them there; `quarantined`
// counts its quarantined files; `last_flush` is the last flush's result
// code, or `null`.
//
// `orphans` is present only when the orphan pass (`derive-run.js` `rebuildOrphans`) needs attention: `"pass_failed"` (the last pass threw),
// `"pass_interrupted"` (a record with a start older than `ORPHAN_INTERRUPTED_MS`, or with a start that does not parse, and no result),
// `"orphans_hung"` (an orphan was interrupted twice and is frozen; `orphans_hung` then counts them), `"pass_stale"` (the last pass ran more than
// `ORPHAN_STALE_MS` ago) or `"walk_not_advancing"` (`sweeps_in_walk` is past `ceil((worked + unexamined) / max(1, worked))`, `worked` counting only
// the orphans that took a transcript slot, so the walk should have wrapped). `orphanPassLine(record, now)` is the one-line
// reading `factory.js status` prints; both read counts, times and fixed codes only.
//
// The result carries store names, codes and counts only: never the machine
// secret, an account, an intake ID, a token, a time, a local path or any
// content. Manifest warnings keep their codes and drop their paths.
//
// `factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug,
// pluginDirs, pluginScanIncomplete })` is the task card's `factory_report`
// link (`jobLink`) when the resolved store has consent `contribute: true`,
// else `null`. The link is deterministic and resolves once the store has
// merged the job's facts and rebuilt its reports.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { readdirSync } from "node:fs"
import * as path from "node:path"

import { consentDecision, consentRecords as readConsentRecords, factoryStateDir } from "./boot-check.js"
import { readSmallText, validMarker } from "./marker.js"
import { jobLink } from "./pipeline/build.js"
import { ENUMS, PATTERNS, isPlainObject } from "./schema.js"
import { RETRACTED_COPIES, derivedStoreOf, deskRootOf, sessionPlace, sessionRoute } from "./session-route.js"
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

/** How many orphans the record holds frozen by repeated interruptions (two strikes), or 0. */
export function orphansHung(record) {
  if (!isPlainObject(record) || !isPlainObject(record.hung)) return 0
  return Object.values(record.hung).filter((entry) => isPlainObject(entry) && Number.isSafeInteger(entry.strikes) && entry.strikes >= HUNG_STRIKES).length
}

/** What is wrong with the orphan pass's record, or `null`: see the header. `now` is milliseconds. */
export function orphanPassFinding(record, now = Date.now()) {
  if (!isPlainObject(record)) return null
  if (record.failed !== undefined) return "pass_failed"
  // A start time that does not parse is never "running".
  if (record.ran_at === undefined) return now - Date.parse(record.started_at) <= ORPHAN_INTERRUPTED_MS ? null : "pass_interrupted"
  if (orphansHung(record) > 0) return "orphans_hung"
  if (now - Date.parse(record.ran_at) > ORPHAN_STALE_MS) return "pass_stale"
  // `worked` is the orphans that took a transcript slot (a record from before it counted `examined`, which includes cheaply frozen ones).
  const worked = finiteCount(record.worked) ?? finiteCount(record.examined)
  const unexamined = finiteCount(record.unexamined)
  const sweeps = finiteCount(record.sweeps_in_walk)
  if (worked === null || unexamined === null || sweeps === null) return null
  return sweeps > Math.ceil((worked + unexamined) / Math.max(1, worked)) ? "walk_not_advancing" : null
}

/** One sentence saying what to do about a finding. */
export const ORPHAN_FINDING_ADVICE = "Run the factory status command and read its orphan_pass line; if the pass keeps failing or stalling, file a Desk problem."

/** One line for the orphan pass's record: counts, times and fixed codes only (a failure is its class, never a message). */
export function orphanPassLine(record, now = Date.now()) {
  if (!isPlainObject(record)) return "orphan pass: no record yet"
  const wrap = typeof record.last_wrap_at === "string" ? record.last_wrap_at : "never"
  if (record.failed !== undefined) return `orphan pass: failed (${typeof record.failed === "string" && RESULT_CODE.test(record.failed) ? record.failed : "unknown"}), last full walk ${wrap}`
  if (record.ran_at === undefined) return `orphan pass: ${orphanPassFinding(record, now) === null ? "running" : "interrupted"}, started ${typeof record.started_at === "string" ? record.started_at : "unknown"}, last full walk ${wrap}`
  const frozen = isPlainObject(record.frozen) ? Object.values(record.frozen).reduce((sum, count) => sum + (finiteCount(count) ?? 0), 0) : 0
  const count = (value) => finiteCount(value) ?? "unknown"
  const hung = orphansHung(record)
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
  // `retracting` is the store's retracting records and tombstones, by name.
  return (store, name, retracting) => {
    // An outbox name, like a labels key, ends in the 36-character session id and `.json`.
    const session = name.slice(-41, -5)
    const names = ENUMS.host.map((host) => `${host}-${session}.json`)
    const marker = names.map(markerOf).find((found) => found !== null) ?? null
    const records = Object.entries(retracting).filter(([key, record]) => key.slice(-41, -5) === session && isPlainObject(record)).map(([, record]) => record)
    return sessionPlace(store, sessionRoute(marker, { siblings: listSiblings, deskRoot: deskRootOf(receipts, names) }), derivedStoreOf(receipts, names), records)
  }
}

function storeEntry(dir, records, store, lastFlush, place) {
  const slug = store.replace("/", "__")
  const delivered = readState(path.join(dir, "delivered", `${slug}.json`), {})
  const quarantined = new Set(outboxNames(path.join(dir, "quarantine", slug)))
  const retracting = readState(path.join(dir, "retracting", `${slug}.json`), {})
  // The kept copies of retracted sessions (`session-route.js`) count with the outbox files: they are what `route_changed` reports.
  const listed = [...new Set([...outboxNames(path.join(dir, "outbox", slug)), ...outboxNames(path.join(dir, RETRACTED_COPIES, slug))])].filter((name) => !quarantined.has(name))
  const away = new Set(listed.filter((name) => ELSEWHERE.has(place(store, name, retracting === UNREADABLE ? {} : retracting))))
  const pending = listed.filter((name) => !away.has(name) && (delivered === UNREADABLE || !Object.hasOwn(delivered, name))).length
  const flush = isPlainObject(lastFlush) && isPlainObject(lastFlush[store]) ? lastFlush[store].result : null
  return { store, consent: decision(records, store), pending, route_changed: away.size, quarantined: quarantined.size, last_flush: typeof flush === "string" && RESULT_CODE.test(flush) ? flush : null }
}

/** See the header. Never writes and never throws for missing or unreadable state. */
export function factoryLocalStatus({ env, deskRoot, pluginDirs = [], pluginScanIncomplete = false }) {
  const routing = route({ deskRoot, pluginDirs, pluginScanIncomplete })
  const dir = factoryStateDir(env)
  const records = consentRecords(dir)
  const status = readState(path.join(dir, "status.json"), {})
  const lastFlush = status === UNREADABLE ? null : status.last_flush
  const place = placer(dir, status === UNREADABLE ? {} : status.derivations)
  const decided = records === UNREADABLE ? [] : Object.keys(records).filter((store) => PATTERNS.prRepo.test(store)).sort()
  const stores = [...new Set([...(routing.store === null ? [] : [routing.store]), ...decided])]
  const orphans = status === UNREADABLE ? null : orphanPassFinding(status.orphans)
  const hung = status === UNREADABLE ? 0 : orphansHung(status.orphans)
  return {
    store: routing.store,
    source: routing.source,
    consent: routing.store === null ? "held" : decision(records, routing.store),
    stores: stores.map((store) => storeEntry(dir, records, store, lastFlush, place)),
    warnings: [...new Set(routing.warnings.map((warning) => warning.code))].sort(),
    ...(orphans === null ? {} : { orphans }),
    ...(hung > 0 ? { orphans_hung: hung } : {}),
  }
}

/** See the header: the task card's `factory_report` link, or `null` without consent. */
export function factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug, pluginDirs = [], pluginScanIncomplete = false }) {
  const routing = route({ deskRoot, pluginDirs, pluginScanIncomplete })
  if (routing.store === null || decision(consentRecords(factoryStateDir(env)), routing.store) !== "yes") return null
  return jobLink({ store: routing.store, deskRemote, personPrefix, track, slug })
}
