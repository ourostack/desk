// Held routes. A session hook that could not read the plugin set (a manifest or plugin folder it could not read, a registry that is missing
// or does not list Desk, too many plugins, a scan cut short) records a held route: no store, so the session is never derived or published.
// A hold is released only by something that positively declares a store for that session: every reader routes a desk that declares its
// store in `_meta/factory.json` to it, and reads the warned manifests again (`store-route.js` `recheckRoute`), so a manifest the session
// itself loaded that now declares a store routes it there. Nothing infers the default store for a held session: another session's plugin
// scan says nothing about the plugins this one ran with (a `claude --plugin-dir` overlay, another config folder, an overlay uninstalled
// since), so a hold whose cause cleared without a declaration waits. A held marker is kept for 90 days (`outbox.js` `listMarkers`),
// counted with its reason by the sweep for `desk_doctor` and the boot line (`routeHolds`), and reported once pruned (`held_pruned`), so a
// hold is never silent.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { lstatSync, statSync } from "node:fs"
import * as path from "node:path"

import { MAX_MARKER_BYTES, readSmallText } from "./marker.js"
import { markerRoute, recordedHeld } from "./session-route.js"

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
  needs_declaration: "the plugin reads now but declares no store, and the plugins this session ran with cannot be read again; declare the store in the desk's `_meta/factory.json` to release it, or it is pruned after 90 days",
})

/**
 * Why `file` (a recorded warning's manifest or plugin folder, or `null` for a hold that named none) holds a route now, as a `HOLD_REMEDIES`
 * key, read from the file as it is now: a link, a hard link, a file too large, a file or folder that is missing, or one that cannot be read
 * or parsed; `needs_declaration` when it now reads (only a declaration releases the hold).
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
      return statSync(file).isDirectory() ? "needs_declaration" : "plugin_unreadable"
    } catch {
      return "plugin_missing"
    }
  }
  if (info.isSymbolicLink()) return "manifest_symlinked"
  if (info.nlink > 1) return "manifest_hardlinked"
  if (info.size > MAX_MARKER_BYTES) return "manifest_too_large"
  try {
    JSON.parse(readSmallText(file))
    return "needs_declaration"
  } catch {
    return code === "manifest_unparseable" ? "manifest_unparseable" : "manifest_unreadable"
  }
}
