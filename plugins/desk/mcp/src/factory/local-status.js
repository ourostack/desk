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
// sorted. `pending` counts the store's outbox files never delivered, not
// quarantined and not routed elsewhere; `route_changed` counts its outbox
// files, not quarantined, whose session's marker now positively routes to
// another store (`session-route.js`, read as the flush reads it: the flush
// never publishes them there and retracts any it delivered); `quarantined`
// counts its quarantined files; `last_flush` is the last flush's result
// code, or `null`.
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
import { derivedStoreOf, sessionPlace, sessionRoute } from "./session-route.js"
import { resolveStore } from "./store-route.js"

const STATE_BYTES = 8 * 1024 * 1024
const MAX_ENTRIES = 4096
const OUTBOX_NAME = new RegExp(`^(?:${ENUMS.host.join("|")})-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.json$`, "u")
const RESULT_CODE = /^[a-z][a-z0-9_]{0,63}$/u
const UNREADABLE = Symbol("unreadable")

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
  return (store, name) => {
    // An outbox name ends in the 36-character session id and `.json`.
    const session = name.slice(-41, -5)
    const names = ENUMS.host.map((host) => `${host}-${session}.json`)
    const marker = names.map(markerOf).find((found) => found !== null) ?? null
    return sessionPlace(store, sessionRoute(marker, { siblings: listSiblings }), derivedStoreOf(receipts, names))
  }
}

function storeEntry(dir, records, store, lastFlush, place) {
  const slug = store.replace("/", "__")
  const delivered = readState(path.join(dir, "delivered", `${slug}.json`), {})
  const quarantined = new Set(outboxNames(path.join(dir, "quarantine", slug)))
  const listed = outboxNames(path.join(dir, "outbox", slug)).filter((name) => !quarantined.has(name))
  const away = new Set(listed.filter((name) => place(store, name) === "away"))
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
  return {
    store: routing.store,
    source: routing.source,
    consent: routing.store === null ? "held" : decision(records, routing.store),
    stores: stores.map((store) => storeEntry(dir, records, store, lastFlush, place)),
    warnings: [...new Set(routing.warnings.map((warning) => warning.code))].sort(),
  }
}

/** See the header: the task card's `factory_report` link, or `null` without consent. */
export function factoryReportLink({ env, deskRoot, deskRemote, personPrefix, track, slug, pluginDirs = [], pluginScanIncomplete = false }) {
  const routing = route({ deskRoot, pluginDirs, pluginScanIncomplete })
  if (routing.store === null || decision(consentRecords(factoryStateDir(env)), routing.store) !== "yes") return null
  return jobLink({ store: routing.store, deskRemote, personPrefix, track, slug })
}
