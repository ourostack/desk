// Store routing: which factory store a desk's facts go to.
//
// Order (controller ruling, 2026-09-25):
//   1. The desk's committed `_meta/factory.json`, exactly
//      `{ "schema_version": 1, "store": "owner/repo" }` — source `desk`.
//   2. The first plugin manifest among `pluginDirs` (the plugins installed
//      beside Desk, in the host's order) that sets `desk.factory.store`,
//      that is `{ "desk": { "factory": { "store": "owner/repo" } } }` —
//      source `overlay`. Each folder's `plugin.json`,
//      `.claude-plugin/plugin.json` and `.codex-plugin/plugin.json` are
//      read in that order. A missing manifest, or one with no top-level
//      `desk` key, is skipped. A manifest that exists but can't be read or
//      parsed as a JSON object is not: it might be the very overlay that
//      declares a private store, so it holds the route as
//      `invalid_declaration`, with a warning naming it (fail closed, ruling
//      2026-10-06). One broken plugin, even an unrelated one, holds the
//      sessions of every desk that does not declare its own store, until it
//      is fixed or removed; `desk_doctor` names it.
//   3. `ourostack/factory` — source `default`.
// A declaration that is present but invalid returns `{ store: null, source:
// "invalid_declaration" }`, and the caller holds the facts. It never falls
// through to a later overlay or the default: a desk that meant to report to
// a private store must never report to a public one by mistake. Invalid
// means, for `_meta/factory.json`: unreadable or malformed, a wrong shape or
// schema version, an extra key, or a store that is not `owner/repo`. For a
// readable plugin manifest it means a malformed declaration: a flat
// `"desk.factory.store"` key, a `desk` or `desk.factory` that is not an
// object, a `desk.factory` with no `store`, or a store (`null` included)
// that is not `owner/repo`. The desk's own `_meta/factory.json` stays the
// primary declaration; when it decides, no plugin manifest is read.
//
// The result carries `warnings`: `{ code, manifest }` for the manifest that
// held the route, `code` being `manifest_unreadable` or `manifest_unparseable`
// and `manifest` its local path, for `desk_doctor` to surface. Warnings stay
// on this machine; they are never part of facts.
//
// `recheckRoute(routing, read)` reads again a route a session hook recorded
// with warnings, for the readers of a marker (`session-route.js`); see it.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { readFileSync } from "node:fs"
import * as path from "node:path"

export const DEFAULT_STORE = "ourostack/factory"

const STORE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u
const MANIFESTS = ["plugin.json", path.join(".claude-plugin", "plugin.json"), path.join(".codex-plugin", "plugin.json")]
const invalid = () => ({ store: null, source: "invalid_declaration" })

function isStore(value) {
  if (typeof value !== "string" || !STORE.test(value)) return false
  const repo = value.split("/")[1]
  return repo !== "." && repo !== ".."
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

// `{ found: false }` when the file does not exist, else `{ found: true,
// json, problem }`: `json` is `undefined` and `problem` names why when the
// file could not be read or parsed.
function readJson(file, read) {
  let text
  try {
    text = read(file, "utf8")
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { found: false }
    return { found: true, json: undefined, problem: "manifest_unreadable" }
  }
  try {
    return { found: true, json: JSON.parse(text) }
  } catch {
    return { found: true, json: undefined, problem: "manifest_unparseable" }
  }
}

function deskDeclaration(deskRoot, read) {
  const { found, json } = readJson(path.join(deskRoot, "_meta", "factory.json"), read)
  if (!found) return null
  const keys = isObject(json) ? Object.keys(json).sort() : []
  if (keys.join(",") !== "schema_version,store" || json.schema_version !== 1 || !isStore(json.store)) return invalid()
  return { store: json.store, source: "desk" }
}

// What a manifest that parsed as an object declares: `undefined` for nothing, else the declaration.
function declarationOf(json) {
  if (Object.hasOwn(json, "desk.factory.store")) return invalid()
  if (!Object.hasOwn(json, "desk")) return undefined
  const { desk } = json
  if (!isObject(desk)) return invalid()
  if (!Object.hasOwn(desk, "factory")) return undefined
  const { factory } = desk
  if (!isObject(factory) || !isStore(factory.store)) return invalid()
  return { store: factory.store, source: "overlay" }
}

// `undefined` when the manifest is missing or declares nothing, else the declaration. A manifest that can't be read as an object
// adds a warning and holds the route: it may be the overlay that declares a private store.
function manifestDeclaration(file, warnings, read) {
  const { found, json, problem } = readJson(file, read)
  if (!found) return undefined
  if (!isObject(json)) {
    warnings.push({ code: problem ?? "manifest_unparseable", manifest: file })
    return invalid()
  }
  return declarationOf(json)
}

function overlayDeclaration(pluginDirs, warnings, read) {
  for (const dir of Array.isArray(pluginDirs) ? pluginDirs : []) {
    if (typeof dir !== "string") continue
    for (const manifest of MANIFESTS) {
      const declaration = manifestDeclaration(path.join(dir, manifest), warnings, read)
      if (declaration !== undefined) return declaration
    }
  }
  return null
}

/** `resolveStore({ deskRoot, pluginDirs }) -> { store, source, warnings }`; see the header. */
export function resolveStore({ deskRoot, pluginDirs = [], read = readFileSync }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("resolveStore: deskRoot must be an absolute path")
  const warnings = []
  const result = deskDeclaration(deskRoot, read) ?? overlayDeclaration(pluginDirs, warnings, read) ?? { store: DEFAULT_STORE, source: "default" }
  return { ...result, warnings }
}

/**
 * A route a session hook recorded (`routing`, the marker's `{ store, source, warnings }`), read again now. A route recorded with no
 * warnings is returned as it is. A warning means a manifest could not be read when the hook ran, so the recorded route says nothing for
 * certain: that manifest might have declared a private store. Each warned manifest is read again, in the recorded order (every one of
 * them came before whatever decided the recorded route, because the scan stops at the first declaration):
 *
 * - one that is still unreadable, or is gone, holds the route (`invalid_declaration`, the warnings kept);
 * - the first one that now declares something decides: its store as `overlay`, or `invalid_declaration`;
 * - when all of them now declare nothing, the recorded store stands if the hook recorded one (a Desk before 2026-10-06 skipped a broken
 *   manifest and went on to the next overlay or the default). A hook from 2026-10-06 on records no store once a manifest is broken, so
 *   what the later plugins declared is not known, and the route stays held.
 *
 * A route that a read settles carries no warnings: the manifests it names are readable now.
 */
export function recheckRoute(routing, read = readFileSync) {
  if (routing.warnings.length === 0) return routing
  const held = { store: null, source: "invalid_declaration", warnings: routing.warnings }
  for (const { manifest } of routing.warnings) {
    const { found, json } = readJson(manifest, read)
    if (!found || !isObject(json)) return held
    const declaration = declarationOf(json)
    if (declaration !== undefined) return { ...declaration, warnings: [] }
  }
  return routing.store === null ? held : { ...routing, warnings: [] }
}
