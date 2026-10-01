// The current route of a session, read the same way by the sweep, the flush, the local status and reconcile.
//
// `markerRoute(marker)` is the one rule for a marker's route: the desk's current route (`resolveStore` from the marker's desk root), or,
// when that is the default route, the route the marker's hook recorded after checking the plugin overlays, if it recorded one.
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
// When the marker is missing, pruned, has no desk root or its desk folder is gone, `deskRoot` (the desk root its derivation receipt
// recorded, `deskRootOf`) is read instead: a desk that declares a store there is a positive route to it, and an invalid declaration there
// is `unknown`; a default route, or a root that is gone, is `derived`.
//
// `sessionPlace(store, route, derivedStore, records)` places the session relative to `store`, checking the session's retracting records
// for `store` (`records`) before anything but a positive route:
//
//   here     a positive route to `store`, or a `derived` route whose last known route is `store`
//   away     a positive route to another store, or no positive route and a finished retraction from `store` (a `done` tombstone in
//            `records`), which keeps the session away until a positive route says here
//   stalled  no positive route and a retraction still open in `records`: the record is kept, and its delete never goes
//   unknown  an `unknown` route and no retracting record: frozen, never published and never deleted, until the declaration is fixed
//   stale    a `derived` route whose last known route is another store
//
// The last known route is `derivedStore` (`derivedStoreOf`: the receipt's `route`, which the flush records whenever the session routes
// positively, else the receipt's `store`, the sweep's latest choice), or `store` itself when there is no receipt, because the sweep placed
// the file in that store's outbox. The receipt is needed because placement alone is not reliable: a re-derive writes a new copy into the
// new store's outbox and leaves the old one, and a route to a store without consent is never re-derived, so neither the folder nor the
// receipt's `store` would show it. A delete needs a positive current route, or a tombstone of a delete that already went.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { realpathSync, statSync } from "node:fs"
import * as path from "node:path"

import { PATTERNS } from "./schema.js"
import { resolveStore } from "./store-route.js"

const DAY_MS = 24 * 60 * 60 * 1000
/** A marker older than this is pruned by `listMarkers`; it says nothing about the route. */
export const MARKER_TTL_MS = 30 * DAY_MS
/** A Codex default route is proven by a non-Codex marker for the same desk within this window, as the sweep proves it. */
export const ROUTE_PROOF_WINDOW_MS = 30 * DAY_MS

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

/** See the header: the route `marker` gives now, as `{ store, source, warnings }`. `marker.desk_root` is an absolute path. */
export function markerRoute(marker) {
  const current = resolveStore({ deskRoot: marker.desk_root })
  return current.source === "default" && marker.routing ? marker.routing : current
}

/** See the header: the markers that can prove a Codex default route, as `{ desk, at }`. */
export function proofIndex(markers) {
  return markers.filter((other) => other.host !== "codex-cli" && typeof other.desk_root === "string" && other.routing?.source === "default")
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

const isFolder = (root) => {
  try {
    return statSync(root).isDirectory()
  } catch {
    return false
  }
}

// What a desk root declares now: a positive route for a store the desk itself declares, `unknown` for a present but invalid declaration.
function declared(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !isFolder(root)) return DERIVED
  const current = resolveStore({ deskRoot: root })
  if (current.source === "invalid_declaration") return UNKNOWN
  return current.source === "desk" ? { kind: "store", store: current.store } : DERIVED
}

/** See the header. `marker` is the session's marker or `null`; `siblings()` lists the other markers, read only for a Codex default route. */
export function sessionRoute(marker, { siblings, deskRoot, now = Date.now() }) {
  if (marker === null || !(now - Date.parse(marker.updated_at) <= MARKER_TTL_MS) || !isFolder(marker.desk_root)) return declared(deskRoot)
  const route = markerRoute(marker)
  const codex = marker.host === "codex-cli"
  if (route.source === "default" && !marker.routing && !codex) return DERIVED
  if (codex && route.source === "default" && !routeProven(marker, siblings())) return DERIVED
  return isStore(route.store) ? { kind: "store", store: route.store } : UNKNOWN
}

const receiptValue = (receipts, names, key, valid) => names.map((name) => receipts?.[name]?.[key]).find(valid)

/**
 * The derive-time route of a session from its derivation receipts (`names`, its facts file names): the `route` the flush last saw it
 * positively give, else the `store` the sweep last derived it to, else `undefined`.
 */
export function derivedStoreOf(receipts, names) {
  return receiptValue(receipts, names, "route", isStore) ?? receiptValue(receipts, names, "store", isStore)
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
  if (!isStore(derivedStore)) return "here"
  return isHere(derivedStore) ? "here" : "stale"
}
