// The current route of a session, read the same way by the sweep, the flush, the local status and reconcile.
//
// `markerRoute(marker)` is the one rule for a marker's route: the desk's current route (`resolveStore` from the marker's desk root), or,
// when that is the default route, the route the marker's hook recorded after checking the plugin overlays, if it recorded one. A recorded
// route with warnings (a plugin manifest the hook could not read) is read again (`recheckRoute`): it is held until every manifest it names
// reads, so a marker recorded while an overlay was unreadable never routes to the default store, and is corrected once the overlay reads.
// A Claude Code or Copilot CLI marker that recorded a default route beside no plugins at all came from a scan that read nothing (an older
// hook read a missing registry as empty), so it is held the same way. A held route whose cause cleared without a declaration is settled
// by the next complete plugin scan on that host (`held-route.js`). A default route recorded with warnings, or beside no plugins, never
// proves a Codex default route either.
// `proofIndex(markers)` and `provenBy(marker, index)` (together `routeProven(marker, siblings)`) are the one R3 proof of a Codex default
// route: a Claude Code or Copilot CLI marker for the same desk, within `ROUTE_PROOF_WINDOW_MS` (30 days), that routed by default after
// checking the overlays. The sweep memoizes the index once per sweep; the others build it as they need it.
//
// `sessionRoute(marker, { siblings, deskRoot, now })` answers where a session routes now:
//
//   { kind: "store", store }  the session positively routes to `store`
//   { kind: "unknown" }       the desk root read is an existing folder whose `_meta/factory.json` is present but unreadable or invalid,
//                             or the marker's hook recorded a route that names no store (an invalid overlay, an incomplete plugin scan):
//                             the desk owner has said the route is changing, but it cannot be read where to
//   { kind: "derived" }       nothing new is known: the marker is missing or past the 30 days after which markers are pruned, it has no
//                             desk root, its desk folder is gone (moved or renamed, as the sweep reads it), an older hook recorded no
//                             overlay check for a default route, or a Codex default route is not proven now (a Codex session held at
//                             derive time never reached an outbox, so one that did was proven then)
//
// A marker whose recorded route is still held is `unknown` whatever its age or desk folder: a held route never becomes a route through the
// receipt. When the marker is missing, pruned, has no desk root or its desk folder is gone, `deskRoot` (the desk root its derivation receipt
// recorded, `deskRootOf`) is read instead: a desk that declares a store there is a positive route to it, and an invalid declaration there
// is `unknown`; a default route, or a root that is gone, is `derived`.
//
// `sessionPlace(store, route, derivedStore, records)` places the session relative to `store`, checking the session's retracting records
// for `store` (`records`) before anything but a positive route:
//
//   here     a positive route to `store`, or a `derived` route whose last checked route is `store`
//   away     a positive route to another store, or no positive route and a finished retraction from `store` (a `done` tombstone in
//            `records`), which keeps the session away until a positive route says here
//   stalled  no positive route and a retraction still open in `records`: the record is kept, and its delete never goes
//   unknown  an `unknown` route and no retracting record: frozen, never published and never deleted, until the declaration is fixed
//   stale    a `derived` route whose last checked route is another store, or that has no checked route
//
// The last checked route is `derivedStore` (`derivedStoreOf`: the receipt's `checked_route`, which this Desk records whenever it sees the
// session route positively: at derive, in the sweep's keeping step and in every flush that places it). The receipt's `store` and `route`
// are not enough: an older Desk wrote both from a route that skipped an unreadable overlay, so a session whose marker was pruned before
// this Desk first read it would otherwise be published to the default store (ruling 2026-10-06). No checked route, a lost `status.json`
// included, freezes the session. The receipt is needed because placement alone is not reliable: a re-derive writes a new copy into the
// new store's outbox and leaves the old one, and a route to a store without consent is never re-derived, so neither the folder nor the
// receipt's `store` would show it. A delete needs a positive current route, or a tombstone of a delete that already went.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { realpathSync, statSync } from "node:fs"
import * as path from "node:path"

import { PATTERNS } from "./schema.js"
import { readSmallText } from "./marker.js"
import { recheckRoute, resolveStore } from "./store-route.js"

const DAY_MS = 24 * 60 * 60 * 1000
/** A marker older than this is pruned by `listMarkers`; it says nothing about the route. */
export const MARKER_TTL_MS = 30 * DAY_MS
/** A Codex default route is proven by a non-Codex marker for the same desk within this window, as the sweep proves it. */
export const ROUTE_PROOF_WINDOW_MS = 30 * DAY_MS

/**
 * The state folder (`<factory state>/retracted-copies/<store-slug>/`) that keeps the local copies of a session that left a store: the flush
 * moves there the copies of every session it does not place `here` (and of one whose delete it pushed), and the sweep the copies of a session
 * in every store it no longer routes to (every store, when it has no route at all). They leave `outbox/<store-slug>/` because an older Desk's flush publishes every file it
 * lists there, and so that "away" outlives `status.json`: a kept copy is here again only on a positive route. Facts keep their outbox name,
 * labels keep `labels/<job>/<session>.json`. A route back moves them home before they publish. The route decisions here stay the only ones:
 * this is only where the copies live.
 */
export const RETRACTED_COPIES = "retracted-copies"

const UNKNOWN = Object.freeze({ kind: "unknown" })
const DERIVED = Object.freeze({ kind: "derived" })
const isStore = (value) => typeof value === "string" && PATTERNS.prRepo.test(value) && !/(?:^|\/)\.\.?$/u.test(value)
/** The time a marker last spoke for its session: when it ended, else when it was last updated. */
export const markerTime = (marker) => Date.parse(marker.ended_at ?? marker.updated_at)

function realDesk(root) {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

const HELD = Object.freeze({ store: null, source: "invalid_declaration", warnings: Object.freeze([]) })

// The route the marker's hook recorded. A Claude Code or Copilot CLI hook that read its plugin set always lists Desk itself, so a default
// route recorded beside no plugins at all came from a scan that read nothing (an older hook treated a missing registry as empty): held.
function recordedRouting(marker) {
  const { routing } = marker
  if (routing?.source === "default" && routing.warnings.length === 0 && marker.host !== "codex-cli" && marker.plugins.length === 0) return HELD
  return routing
}

/** See the header: the route `marker` gives now, as `{ store, source, warnings }`. `marker.desk_root` is an absolute path. */
export function markerRoute(marker) {
  const current = resolveStore({ deskRoot: marker.desk_root })
  const routing = recordedRouting(marker)
  return current.source === "default" && routing ? recheckRoute(routing, (file) => readSmallText(file)) : current
}

/** Whether the marker's hook recorded a held route (no store) or one beside a manifest it could not read. */
export const recordedHeld = (marker) => {
  const routing = recordedRouting(marker)
  return routing !== undefined && (routing.store === null || routing.warnings.length > 0)
}

/** See the header: the markers that can prove a Codex default route, as `{ desk, at }`. */
export function proofIndex(markers) {
  return markers.filter((other) => other.host !== "codex-cli" && typeof other.desk_root === "string" && recordedRouting(other)?.source === "default" && other.routing.warnings.length === 0)
    .map((other) => ({ desk: realDesk(other.desk_root), at: markerTime(other) }))
}

/** Whether `index` (`proofIndex`) proves Codex `marker`'s default route. */
export function provenBy(marker, index) {
  const desk = realDesk(marker.desk_root)
  const at = markerTime(marker)
  return index.some((other) => other.desk === desk && Math.abs(other.at - at) <= ROUTE_PROOF_WINDOW_MS)
}

/** Whether a Claude Code or Copilot CLI marker among `siblings`, for the same desk within 30 days, routed by default after checking for overlays. */
export function routeProven(marker, siblings) {
  return provenBy(marker, proofIndex(siblings))
}

/** Whether `root` is an existing folder (following links). */
export const isFolder = (root) => {
  try {
    return statSync(root).isDirectory()
  } catch {
    return false
  }
}

// What a desk root declares now: a positive route for a store the desk itself declares, `unknown` for a present but invalid declaration.
export function declared(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !isFolder(root)) return DERIVED
  const current = resolveStore({ deskRoot: root })
  if (current.source === "invalid_declaration") return UNKNOWN
  return current.source === "desk" ? { kind: "store", store: current.store } : DERIVED
}

/** See the header. `marker` is the session's marker or `null`; `siblings()` lists the other markers, read only for a Codex default route. */
export function sessionRoute(marker, { siblings, deskRoot, now = Date.now() }) {
  // A held route is read again whatever the marker's age or desk folder: an old marker, or a desk folder that is gone, never turns it into
  // a route through the receipt.
  if (marker !== null && typeof marker.desk_root === "string" && recordedHeld(marker) && markerRoute(marker).store === null) return UNKNOWN
  if (marker === null || !(now - Date.parse(marker.updated_at) <= MARKER_TTL_MS) || !isFolder(marker.desk_root)) return declared(deskRoot)
  const route = markerRoute(marker)
  const codex = marker.host === "codex-cli"
  if (route.source === "default" && !marker.routing && !codex) return DERIVED
  if (codex && route.source === "default" && !routeProven(marker, siblings())) return DERIVED
  return isStore(route.store) ? { kind: "store", store: route.store } : UNKNOWN
}

const receiptValue = (receipts, names, key, valid) => names.map((name) => receipts?.[name]?.[key]).find(valid)

/**
 * The last checked route of a session from its derivation receipts (`names`, its facts file names): the `checked_route` that this Desk
 * recorded the last time it saw the session route positively (at derive, in the sweep's keeping step, or in a flush), else `undefined`.
 * The receipt's `store` and `route` are never proof on their own; see the header.
 */
export function derivedStoreOf(receipts, names) {
  return receiptValue(receipts, names, "checked_route", isStore)
}

/** The desk root a session's receipts recorded (local only, never published), or `undefined`. */
export function deskRootOf(receipts, names) {
  return receiptValue(receipts, names, "desk_root", (value) => typeof value === "string" && path.isAbsolute(value))
}

/** See the header. Store names compare without regard to case. `records` are the session's retracting records for `store`. */
export function sessionPlace(store, route, derivedStore, records = []) {
  const isHere = (target) => target.toLowerCase() === store.toLowerCase()
  if (route.kind === "store") return isHere(route.store) ? "here" : "away"
  if (records.some((record) => record.done !== true)) return "stalled"
  if (records.length > 0) return "away"
  if (route.kind === "unknown") return "unknown"
  return isStore(derivedStore) && isHere(derivedStore) ? "here" : "stale"
}
