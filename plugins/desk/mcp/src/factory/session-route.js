// The current route of a session, read the same way by the flush, the local status and reconcile.
//
// `sessionRoute(marker, { siblings, now })` answers where a session's marker routes now, resolved the way the sweep resolves it
// (`resolveStore` from the marker's desk root, the hook's recorded overlay check for a default route, and for a Codex default route
// the R3 proof by a Claude Code or Copilot CLI marker for the same desk within 30 days):
//
//   { kind: "store", store }  the marker positively routes to `store`
//   { kind: "unknown" }       the marker exists but its route cannot be resolved: a desk root that is missing, relative or not a
//                             folder, an unreadable or invalid declaration, a recorded route that names no store, or an error
//   { kind: "derived" }       the marker says nothing new: it is missing or past the 30 days after which markers are pruned, an
//                             older hook recorded no overlay check for a default route, or a Codex default route is not proven now
//                             (a Codex session held at derive time never reached an outbox, so one that did was proven then)
//
// `sessionPlace(store, route, derivedStore)` places the session relative to `store`: `here`, `away` (positively another store),
// `unknown`, or `stale`. A `derived` route is the last route known for the session: `derivedStore` (`derivedStoreOf`: the receipt's
// `route`, which the flush records whenever a marker routes positively, else the receipt's `store`, the sweep's latest choice), or
// `store` itself when there is no receipt, because the sweep placed the file in that store's outbox. The receipt is needed because
// placement alone is not reliable: a re-derive writes a new copy into the new store's outbox and leaves the old one, and a route to a
// store without consent is never re-derived, so neither the folder nor the receipt's `store` would show it. A derived route to another store is `stale`, never `away`: a copy left in an older outbox is neither published nor deleted,
// since a delete needs a positive current route.
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

/** See the header. `marker` is the session's marker or `null`; `siblings()` lists the other markers, read only for a Codex default route. */
export function sessionRoute(marker, { siblings, now = Date.now() }) {
  if (marker === null || !(now - Date.parse(marker.updated_at) <= MARKER_TTL_MS)) return DERIVED
  if (typeof marker.desk_root !== "string" || !path.isAbsolute(marker.desk_root)) return UNKNOWN
  try {
    if (!statSync(marker.desk_root).isDirectory()) return UNKNOWN
    const current = resolveStore({ deskRoot: marker.desk_root })
    if (current.source !== "default") return isStore(current.store) ? { kind: "store", store: current.store } : UNKNOWN
    const codex = marker.host === "codex-cli"
    const route = marker.routing ?? (codex ? current : undefined)
    if (route === undefined) return DERIVED
    if (codex && route.source === "default" && !routeProven(marker, siblings())) return DERIVED
    return isStore(route.store) ? { kind: "store", store: route.store } : UNKNOWN
  } catch {
    return UNKNOWN
  }
}

/**
 * The derive-time route of a session from its derivation receipts (`names`, its facts file names): the `route` the flush last saw its
 * marker positively give, else the `store` the sweep last derived it to, else `undefined`.
 */
export function derivedStoreOf(receipts, names) {
  const of = (key) => names.map((name) => receipts?.[name]?.[key]).find(isStore)
  return of("route") ?? of("store")
}

/** See the header. Store names compare without regard to case. */
export function sessionPlace(store, route, derivedStore) {
  if (route.kind === "unknown") return "unknown"
  const target = route.kind === "store" ? route.store : isStore(derivedStore) ? derivedStore : store
  if (target.toLowerCase() === store.toLowerCase()) return "here"
  return route.kind === "store" ? "away" : "stale"
}
