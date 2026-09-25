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
//      `desk` key, is skipped. So is a manifest that exists but can't be
//      read or parsed as a JSON object, with a warning: one broken,
//      unrelated plugin must not stop every desk's facts.
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
// The result carries `warnings`: `{ code, manifest }` for each skipped
// manifest, `code` being `manifest_unreadable` or `manifest_unparseable`
// and `manifest` its local path, for `desk_doctor` to surface. Warnings stay
// on this machine; they are never part of facts.
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
function readJson(file) {
  let text
  try {
    text = readFileSync(file, "utf8")
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

function deskDeclaration(deskRoot) {
  const { found, json } = readJson(path.join(deskRoot, "_meta", "factory.json"))
  if (!found) return null
  const keys = isObject(json) ? Object.keys(json).sort() : []
  if (keys.join(",") !== "schema_version,store" || json.schema_version !== 1 || !isStore(json.store)) return invalid()
  return { store: json.store, source: "desk" }
}

// `undefined` when the manifest declares nothing, else the declaration. A
// manifest that can't be read as an object adds a warning and declares nothing.
function manifestDeclaration(file, warnings) {
  const { found, json, problem } = readJson(file)
  if (!found) return undefined
  if (!isObject(json)) {
    warnings.push({ code: problem ?? "manifest_unparseable", manifest: file })
    return undefined
  }
  if (Object.hasOwn(json, "desk.factory.store")) return invalid()
  if (!Object.hasOwn(json, "desk")) return undefined
  const { desk } = json
  if (!isObject(desk)) return invalid()
  if (!Object.hasOwn(desk, "factory")) return undefined
  const { factory } = desk
  if (!isObject(factory) || !isStore(factory.store)) return invalid()
  return { store: factory.store, source: "overlay" }
}

function overlayDeclaration(pluginDirs, warnings) {
  for (const dir of Array.isArray(pluginDirs) ? pluginDirs : []) {
    if (typeof dir !== "string") continue
    for (const manifest of MANIFESTS) {
      const declaration = manifestDeclaration(path.join(dir, manifest), warnings)
      if (declaration !== undefined) return declaration
    }
  }
  return null
}

/** `resolveStore({ deskRoot, pluginDirs }) -> { store, source, warnings }`; see the header. */
export function resolveStore({ deskRoot, pluginDirs = [] }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("resolveStore: deskRoot must be an absolute path")
  const warnings = []
  const result = deskDeclaration(deskRoot) ?? overlayDeclaration(pluginDirs, warnings) ?? { store: DEFAULT_STORE, source: "default" }
  return { ...result, warnings }
}
