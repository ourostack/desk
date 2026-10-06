// Held routes settle. A session hook that could not read the plugin set (a manifest or plugin folder it could not read, a registry that is
// missing or does not list Desk, too many plugins) records a held route: no store, so the session is never derived or published. Every
// reader reads the warned manifests again (`store-route.js` `recheckRoute`), and a manifest that now declares a store settles the route.
// What is left is a hold whose cause cleared without a declaration: every warned manifest now reads and declares nothing, or the scan was
// incomplete and named no manifest. Those are settled here, by the next complete plugin scan on the same host (`settleHeldMarkers`, run by
// the end hook after it has written its own marker): the session is routed as a session there would be routed now, its marker rewritten
// with that route and the time it was settled. A default route needs the plugins the session's own scan listed, so a session whose scan
// read no plugin list at all (a missing registry) settles only on a declaration (the desk's `_meta/factory.json` or an overlay). A hold whose warned manifest is still unreadable or gone stays held: that plugin may be the
// overlay that declares a private store, and only it can say. A held marker is kept past the usual 30 days (`outbox.js` `listMarkers`), and
// counted with its reason by the sweep for `desk_doctor` and the boot line (`routeHolds`), so a hold is never silent.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { lstatSync, statSync } from "node:fs"
import * as path from "node:path"

import { MAX_MARKER_BYTES, readSmallText } from "./marker.js"
import { listMarkers, writeMarker } from "./outbox.js"
import { markerRoute, recordedHeld } from "./session-route.js"
import { rereadWarnings, resolveStore } from "./store-route.js"

/** The most markers one hook run settles: the hook has a short deadline, and the next one goes on. */
export const SETTLE_LIMIT = 16

const HOST = Object.freeze({ claude: "claude-code", copilot: "copilot-cli" })
const read = (file) => readSmallText(file)

// Whether the hook recorded this marker's route as held (no store) or beside a manifest it could not read, from the marker as written.
const writtenHeld = (routing) => routing !== undefined && (routing.store === null || routing.warnings.length > 0)

/**
 * `settleHeldMarkers(env, { host, dirs, now, deadline }) -> string[]`: routes again every ended marker of `host` ("claude" or "copilot")
 * whose recorded route is still held and whose cause has cleared, with `dirs` (the plugin folders of a complete scan on that host now). A
 * marker is settled only to a positive route with no warnings. Returns the settled marker names. Never throws.
 */
export async function settleHeldMarkers(env, { host, dirs, now = () => new Date().toISOString(), deadline = Infinity }) {
  const settled = []
  try {
    for (const marker of await listMarkers(env)) {
      if (settled.length >= SETTLE_LIMIT || performance.now() > deadline) break
      if (marker.host !== HOST[host] || marker.ended_at === null || !writtenHeld(marker.routing) || markerRoute(marker).store !== null) continue
      // A warned manifest still unreadable or gone keeps the hold.
      if (marker.routing.warnings.length > 0 && rereadWarnings(marker.routing.warnings, read) === null) continue
      const routing = resolveStore({ deskRoot: marker.desk_root, pluginDirs: dirs, read })
      // A default route needs the plugin list the session's own scan read (`session-route.js`): a scan that read nothing never proves it.
      if (routing.store === null || routing.warnings.length > 0 || (routing.source === "default" && marker.plugins.length === 0)) continue
      await writeMarker(env, { ...marker, routing, updated_at: now() })
      settled.push(`${marker.host}-${marker.session_id}.json`)
    }
  } catch {
    // The next hook run settles what this one could not.
  }
  return settled
}

/**
 * `routeHolds(markers) -> { count, reasons }`: the markers whose route is held now (`session-route.js`), with each distinct reason: `{ code,
 * path, sessions }`, `code` being the recorded warning's code and `path` its manifest or plugin folder, or `plugin_scan_incomplete` with no
 * path when the hook named none. At most 8 reasons, the most common first.
 */
export function routeHolds(markers) {
  const reasons = new Map()
  let count = 0
  for (const marker of markers) {
    if (typeof marker.desk_root !== "string" || !recordedHeld(marker) || markerRoute(marker).store !== null) continue
    count += 1
    const { warnings } = marker.routing
    const keys = warnings.length > 0 ? warnings.map(({ code, manifest }) => [code, manifest]) : [["plugin_scan_incomplete", null]]
    for (const [code, file] of keys) {
      const key = `${code}\0${file}`
      reasons.set(key, { code, path: file, sessions: (reasons.get(key)?.sessions ?? 0) + 1 })
    }
  }
  return { count, reasons: [...reasons.values()].sort((a, b) => b.sessions - a.sessions).slice(0, 8) }
}

const REMEDY_LINKS = "install the plugin without links (Desk reads only a plain manifest file), or declare the store in the desk's `_meta/factory.json`"
const REMEDY_PLUGIN = "fix, reinstall or remove that plugin, or declare the store in the desk's `_meta/factory.json`"
const REMEDY_SCAN = "start sessions from an installed Desk (not `claude --plugin-dir`) so the plugin list can be read, or declare the store in the desk's `_meta/factory.json`"
/** What the operator can do about each hold reason (`holdReason`). */
export const HOLD_REMEDIES = Object.freeze({
  manifest_symlinked: REMEDY_LINKS,
  manifest_hardlinked: REMEDY_LINKS,
  manifest_too_large: REMEDY_PLUGIN,
  manifest_missing: REMEDY_PLUGIN,
  manifest_unreadable: REMEDY_PLUGIN,
  manifest_unparseable: REMEDY_PLUGIN,
  plugin_missing: REMEDY_PLUGIN,
  plugin_unreadable: REMEDY_PLUGIN,
  registry_missing: REMEDY_SCAN,
  registry_unreadable: REMEDY_SCAN,
  desk_not_in_registry: REMEDY_SCAN,
  too_many_plugins: "remove plugins until at most 64 are installed, or declare the store in the desk's `_meta/factory.json`",
  scan_deadline: "nothing; the next session reads the plugin list again",
  plugin_scan_incomplete: REMEDY_SCAN,
  awaiting_settle: "nothing; the next session that ends on this host settles it",
})

/**
 * Why `file` (a recorded warning's manifest or plugin folder, or `null` for a hold that named none) holds a route now, as a `HOLD_REMEDIES`
 * key, read from the file as it is now: a link, a hard link, a file too large, a file or folder that is missing, or one that cannot be read
 * or parsed; `awaiting_settle` when it now reads (the next complete scan settles the hold).
 */
export function holdReason(file, { code = "manifest_unreadable" } = {}) {
  if (file === null) return "plugin_scan_incomplete"
  const manifest = path.basename(file) === "plugin.json"
  let info
  try {
    info = lstatSync(file)
  } catch {
    return path.basename(file) === "installed_plugins.json" ? "registry_missing" : manifest ? "manifest_missing" : "plugin_missing"
  }
  if (!manifest && !info.isFile()) {
    // A plugin folder, or a link to one: held only while it does not resolve to a folder that reads.
    try {
      return statSync(file).isDirectory() ? "awaiting_settle" : "plugin_unreadable"
    } catch {
      return "plugin_missing"
    }
  }
  if (info.isSymbolicLink()) return "manifest_symlinked"
  if (info.nlink > 1) return "manifest_hardlinked"
  if (info.size > MAX_MARKER_BYTES) return "manifest_too_large"
  try {
    JSON.parse(readSmallText(file))
    return "awaiting_settle"
  } catch {
    return code === "manifest_unparseable" ? "manifest_unparseable" : "manifest_unreadable"
  }
}
