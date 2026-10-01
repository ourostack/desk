// The current route of a session, read the same way by the flush, the local status and reconcile.
//
// `sessionRoute(marker, { siblings, deskRoot, now })` answers where a session's marker routes now, resolved the way the sweep resolves it
// (`resolveStore` from the marker's desk root, the hook's recorded overlay check for a default route, and for a Codex default route
// the R3 proof by a Claude Code or Copilot CLI marker for the same desk within 30 days):
//
//   { kind: "store", store }  the session positively routes to `store`
//   { kind: "unknown" }       the marker exists but claims a route that cannot be resolved: a desk root that is not an absolute path, an
//                             unreadable or invalid declaration, a recorded route that names no store
//   { kind: "derived" }       nothing new is known: the marker is missing or past the 30 days after which markers are pruned, its desk
//                             folder is gone (moved or renamed, as the sweep reads it), an older hook recorded no overlay check for a default
//                             route, or a Codex default route is not proven now (a Codex session held at derive time never reached an outbox,
//                             so one that did was proven then)
//
// When the marker is missing, pruned or its desk folder is gone, `deskRoot` (the desk root its derivation receipt recorded, `deskRootOf`)
// is read instead: a desk that declares a store there is a positive route to it; a default route, or a root that cannot be resolved, is
// `derived`.
//
// `sessionPlace(store, route, derivedStore, records)` places the session relative to `store`:
//
//   here     a positive route to `store`, or no positive route and the last known route is `store`
//   away     a positive route to another store, or no positive route and a finished retraction from `store` (a `done` tombstone in
//            `records`, the session's retracting records for `store`), which keeps the session away until a positive route says here
//   stalled  no positive route and a retraction still open in `records`: the record is kept, and its delete never goes
//   unknown  an unresolvable marker and no last known route at all
//   stale    no positive route and the last known route is another store
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
const markerTime = (marker) => Date.parse(marker.ended_at ?? marker.updated_at)

function realDesk(root) {
  try {
    return realpathSync(root)
  } catch {
    return path.resolve(root)
  }
}

/** Whether a Claude Code or Copilot CLI marker among `siblings`, for the same desk within 30 days, routed by default after checking for overlays. */
export function routeProven(marker, siblings) {
  const desk = realDesk(marker.desk_root)
  return siblings.some((other) => other.host !== "codex-cli" && typeof other.desk_root === "string" && other.routing?.source === "default"
    && realDesk(other.desk_root) === desk && Math.abs(markerTime(other) - markerTime(marker)) <= ROUTE_PROOF_WINDOW_MS)
}

const isFolder = (root) => {
  try {
    return statSync(root).isDirectory()
  } catch {
    return false
  }
}

// What a desk root declares now: a positive route only for a store the desk itself declares.
function declared(root) {
  if (typeof root !== "string" || !path.isAbsolute(root) || !isFolder(root)) return DERIVED
  const current = resolveStore({ deskRoot: root })
  return current.source === "desk" && isStore(current.store) ? { kind: "store", store: current.store } : DERIVED
}

/** See the header. `marker` is the session's marker or `null`; `siblings()` lists the other markers, read only for a Codex default route. */
export function sessionRoute(marker, { siblings, deskRoot, now = Date.now() }) {
  if (marker === null || !(now - Date.parse(marker.updated_at) <= MARKER_TTL_MS)) return declared(deskRoot)
  if (typeof marker.desk_root !== "string" || !path.isAbsolute(marker.desk_root)) return UNKNOWN
  if (!isFolder(marker.desk_root)) return declared(deskRoot)
  const current = resolveStore({ deskRoot: marker.desk_root })
  if (current.source !== "default") return isStore(current.store) ? { kind: "store", store: current.store } : UNKNOWN
  const codex = marker.host === "codex-cli"
  const route = marker.routing ?? (codex ? current : undefined)
  if (route === undefined) return DERIVED
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
  if (!isStore(derivedStore)) return route.kind === "unknown" ? "unknown" : "here"
  return isHere(derivedStore) ? "here" : "stale"
}
