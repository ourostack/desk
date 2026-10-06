// Store routing: which factory store a desk reports to. Fixture desks and
// plugin folders are built in a temporary folder; no real desk or installed
// plugin is read.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DEFAULT_STORE, recheckRoute, rereadWarnings, resolveStore } from "../../../../../plugins/desk/mcp/src/factory/store-route.js"

// The result without its warnings; the warning tests below check those.
function route(args) {
  const { warnings, ...result } = resolveStore(args)
  assert.ok(Array.isArray(warnings))
  return result
}

function scratch(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-store-route-"))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

function writeJson(file, value) {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`)
}

// A desk, optionally with `_meta/factory.json`.
function makeDesk(root, declaration) {
  const desk = path.join(root, "desk")
  mkdirSync(desk, { recursive: true })
  if (declaration !== undefined) writeJson(path.join(desk, "_meta", "factory.json"), declaration)
  return desk
}

// A plugin folder with a manifest at `manifest` (relative) holding `json`.
function makePlugin(root, name, json, manifest = "plugin.json") {
  const dir = path.join(root, "plugins", name)
  mkdirSync(dir, { recursive: true })
  if (json !== undefined) writeJson(path.join(dir, manifest), json)
  return dir
}

const overlay = (store) => ({ name: "overlay", version: "1.0.0", desk: { factory: { store } } })

test("the default store is ourostack/factory", () => {
  assert.equal(DEFAULT_STORE, "ourostack/factory")
})

test("the desk's own _meta/factory.json wins over an overlay and the default", () => {
  scratch((root) => {
    const desk = makeDesk(root, { schema_version: 1, store: "example-org/desk-factory" })
    const plugins = [makePlugin(root, "overlay", overlay("other-org/factory"))]
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: plugins }), { store: "example-org/desk-factory", source: "desk" })
  })
})

test("with no desk declaration, the first plugin manifest that sets desk.factory.store wins, in the order given", () => {
  scratch((root) => {
    const desk = makeDesk(root)
    const plugins = [
      makePlugin(root, "desk-itself", { name: "desk", version: "3.2.0" }),
      makePlugin(root, "no-manifest", undefined),
      makePlugin(root, "other-key", { name: "x", desk: { other: true } }),
      makePlugin(root, "first", overlay("first-org/factory")),
      makePlugin(root, "second", overlay("second-org/factory")),
    ]
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: plugins }), { store: "first-org/factory", source: "overlay" })
  })
})

test("an overlay's manifest is found in the Claude and Codex manifest folders too", () => {
  scratch((root) => {
    const desk = makeDesk(root)
    const claude = makePlugin(root, "claude-only", overlay("claude-org/factory"), ".claude-plugin/plugin.json")
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: [claude] }), { store: "claude-org/factory", source: "overlay" })
    const codex = makePlugin(root, "codex-only", overlay("codex-org/factory"), ".codex-plugin/plugin.json")
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: [codex] }), { store: "codex-org/factory", source: "overlay" })
  })
})

test("with neither a desk declaration nor an overlay, the default store is used", () => {
  scratch((root) => {
    const desk = makeDesk(root)
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: [makePlugin(root, "plain", { name: "plain" })] }), { store: "ourostack/factory", source: "default" })
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: [] }), { store: "ourostack/factory", source: "default" })
    assert.deepEqual(route({ deskRoot: desk }), { store: "ourostack/factory", source: "default" })
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: "not-a-list" }), { store: "ourostack/factory", source: "default" })
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: [7, null, "relative"] }), { store: "ourostack/factory", source: "default" })
  })
})

test("an invalid desk declaration holds the facts: never the overlay, never the default", () => {
  const invalid = [
    "{ not json",
    "[]",
    "null",
    { schema_version: 2, store: "a/b" },
    { schema_version: 1 },
    { schema_version: 1, store: "no-slash" },
    { schema_version: 1, store: "a/b/c" },
    { schema_version: 1, store: "https://github.com/a/b" },
    { schema_version: 1, store: "a/.." },
    { schema_version: 1, store: 7 },
    { schema_version: 1, store: "a/b", extra: "field" },
  ]
  for (const declaration of invalid) {
    scratch((root) => {
      const desk = makeDesk(root, declaration)
      const plugins = [makePlugin(root, "overlay", overlay("other-org/factory"))]
      assert.deepEqual(route({ deskRoot: desk, pluginDirs: plugins }), { store: null, source: "invalid_declaration" }, JSON.stringify(declaration))
    })
  }
})

test("an unreadable desk declaration (a folder in its place) holds the facts too", () => {
  scratch((root) => {
    const desk = makeDesk(root)
    mkdirSync(path.join(desk, "_meta", "factory.json"), { recursive: true })
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: [] }), { store: null, source: "invalid_declaration" })
  })
})

test("an invalid overlay declaration holds the facts rather than falling through to a later overlay or the default", () => {
  for (const store of ["", "not a repo", 42, { owner: "a" }, "a/b/c", null]) {
    scratch((root) => {
      const desk = makeDesk(root)
      const plugins = [makePlugin(root, "bad", overlay(store)), makePlugin(root, "good", overlay("good-org/factory"))]
      assert.deepEqual(route({ deskRoot: desk, pluginDirs: plugins }), { store: null, source: "invalid_declaration" }, JSON.stringify(store))
    })
  }
})

test("a readable plugin manifest whose desk.factory declaration is malformed holds the facts", () => {
  const problems = {
    "a flat key": { name: "x", "desk.factory.store": "flat-org/factory" },
    "desk not an object": { name: "x", desk: "factory" },
    "factory not an object": { name: "x", desk: { factory: "flat-org/factory" } },
    "factory without a store": { name: "x", desk: { factory: {} } },
  }
  for (const [label, manifest] of Object.entries(problems)) {
    scratch((root) => {
      const desk = makeDesk(root)
      const plugins = [makePlugin(root, "bad", manifest), makePlugin(root, "good", overlay("good-org/factory"))]
      assert.deepEqual(route({ deskRoot: desk, pluginDirs: plugins }), { store: null, source: "invalid_declaration" }, label)
    })
  }
})

test("an unreadable or unparseable plugin manifest holds the route with a warning: it might be the overlay that declares a private store", () => {
  scratch((root) => {
    const desk = makeDesk(root)
    const unreadable = makePlugin(root, "unreadable", undefined)
    mkdirSync(path.join(unreadable, "plugin.json"))
    const unparseable = makePlugin(root, "unparseable", "{ not json", ".claude-plugin/plugin.json")
    const notObject = makePlugin(root, "not-object", "[]")
    const good = makePlugin(root, "good", overlay("good-org/factory"))
    const held = (code, manifest) => ({ store: null, source: "invalid_declaration", warnings: [{ code, manifest }] })
    // The scan stops at the first broken manifest: nothing after it can decide.
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [unreadable, unparseable, notObject, good] }), held("manifest_unreadable", path.join(unreadable, "plugin.json")))
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [unparseable, good] }), held("manifest_unparseable", path.join(unparseable, ".claude-plugin", "plugin.json")))
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [notObject] }), held("manifest_unparseable", path.join(notObject, "plugin.json")))
    // Never the default store: the reproduction's overlay truncated mid-write.
    const truncated = makePlugin(root, "truncated", '{"name":"corp","desk":{"factory":{"store":"corp/private-fac')
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [truncated] }), held("manifest_unparseable", path.join(truncated, "plugin.json")))
    // A read that throws without a code (the hook's bounded reader refuses a hard link or an oversized file) holds too.
    const refused = (file) => {
      if (file === path.join(good, "plugin.json")) throw new Error("metadata_unreadable")
      return readFileSync(file, "utf8")
    }
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [good], read: refused }), held("manifest_unreadable", path.join(good, "plugin.json")))
    // A declaring overlay ahead of a broken manifest decides, and the broken one is never read.
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [good, unreadable] }), { store: "good-org/factory", source: "overlay", warnings: [] })
    // A plugin folder with no manifest at all is still skipped, so the default stands.
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [makePlugin(root, "empty", undefined)] }), { store: "ourostack/factory", source: "default", warnings: [] })
  })
})

test("recheckRoute: a recorded route with no warnings stands as recorded", () => {
  for (const routing of [{ store: "ourostack/factory", source: "default", warnings: [] }, { store: "corp/private", source: "overlay", warnings: [] }, { store: null, source: "invalid_declaration", warnings: [] }]) {
    assert.equal(recheckRoute(routing, () => assert.fail("no manifest is read")), routing)
  }
})

test("recheckRoute: a route recorded while a manifest was unreadable is held until that manifest reads, then corrected", () => {
  scratch((root) => {
    const corp = makePlugin(root, "corp", '{"name":"corp","desk":{"factory":{"store":"corp/private-fac')
    const manifest = path.join(corp, "plugin.json")
    const warnings = [{ code: "manifest_unparseable", manifest }]
    const held = { store: null, source: "invalid_declaration", warnings }
    // A Desk before 2026-10-06 skipped the broken overlay and recorded the default; one from then on records no store.
    const legacy = { store: "ourostack/factory", source: "default", warnings }
    const current = { store: null, source: "invalid_declaration", warnings }
    for (const routing of [legacy, current]) assert.deepEqual(recheckRoute(routing), held, "still unparseable")
    writeJson(manifest, overlay("corp/private-factory"))
    for (const routing of [legacy, current]) assert.deepEqual(recheckRoute(routing), { store: "corp/private-factory", source: "overlay", warnings: [] }, "readable again: the overlay it declares")
    writeJson(manifest, overlay("not a store"))
    for (const routing of [legacy, current]) assert.deepEqual(recheckRoute(routing), held, "a malformed declaration holds")
    writeJson(manifest, overlay("ourostack/factory"))
    for (const routing of [legacy, current]) assert.deepEqual(recheckRoute(routing), held, "a reread never releases to the public store, even when it declares it")
    writeJson(manifest, overlay("OuroStack/Factory"))
    for (const routing of [legacy, current]) assert.deepEqual(recheckRoute(routing), held, "nor to the public store under another letter case")
    writeJson(manifest, { name: "corp", version: "1.0.0" })
    assert.deepEqual(recheckRoute(legacy), held, "declares nothing: the old hook's recorded public default is not proof")
    assert.deepEqual(recheckRoute({ store: "corp/other", source: "overlay", warnings }), { store: "corp/other", source: "overlay", warnings: [] })
    assert.deepEqual(recheckRoute(current), held, "declares nothing, but what came after it was never recorded")
    rmSync(corp, { recursive: true, force: true })
    for (const routing of [legacy, current]) assert.deepEqual(recheckRoute(routing), held, "gone: it can never be read again")
  })
})

test("recheckRoute: with several warned manifests, every one must read, and the first that declares decides", () => {
  scratch((root) => {
    const first = makePlugin(root, "first", { name: "first" })
    const second = makePlugin(root, "second", "{ broken")
    const warnings = [{ code: "manifest_unparseable", manifest: path.join(first, "plugin.json") }, { code: "manifest_unparseable", manifest: path.join(second, "plugin.json") }]
    const legacy = { store: "ourostack/factory", source: "default", warnings }
    assert.deepEqual(recheckRoute(legacy), { store: null, source: "invalid_declaration", warnings })
    writeJson(path.join(second, "plugin.json"), overlay("corp/second"))
    assert.deepEqual(recheckRoute(legacy), { store: "corp/second", source: "overlay", warnings: [] })
    writeJson(path.join(first, "plugin.json"), overlay("corp/first"))
    assert.deepEqual(recheckRoute(legacy), { store: "corp/first", source: "overlay", warnings: [] })
    // A manifest that reads as something other than an object is still broken.
    writeJson(path.join(first, "plugin.json"), "null")
    assert.deepEqual(recheckRoute(legacy), { store: null, source: "invalid_declaration", warnings })
  })
})

test("a clean resolution has no warnings, and the desk declaration reads no plugin manifest", () => {
  scratch((root) => {
    const desk = makeDesk(root, { schema_version: 1, store: "example-org/desk-factory" })
    const broken = makePlugin(root, "broken", "{ not json")
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [broken] }), { store: "example-org/desk-factory", source: "desk", warnings: [] })
    const plain = makeDesk(path.join(root, "second"))
    assert.deepEqual(resolveStore({ deskRoot: plain, pluginDirs: [] }), { store: "ourostack/factory", source: "default", warnings: [] })
  })
})

test("a relative or missing desk root is a caller bug", () => {
  assert.throws(() => resolveStore({ deskRoot: "desk", pluginDirs: [] }), TypeError)
  assert.throws(() => resolveStore({ pluginDirs: [] }), TypeError)
})

test("review finding 2: a plugin folder the host lists that is missing or not a folder holds the route, naming the folder", () => {
  scratch((root) => {
    const desk = makeDesk(root)
    const missing = path.join(root, "missing")
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [missing] }), { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unreadable", manifest: missing }] })
    const file = path.join(root, "file")
    writeFileSync(file, "x")
    assert.equal(resolveStore({ deskRoot: desk, pluginDirs: [file] }).store, null)
    // A folder that cannot be read for another reason holds too.
    const denied = { stat: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }) } }
    assert.equal(resolveStore({ deskRoot: desk, pluginDirs: [missing], ...denied }).store, null)
    // Read again: still missing holds; a folder whose manifest is broken holds; one with no manifest declares nothing.
    const warned = { store: null, source: "invalid_declaration", warnings: [{ code: "manifest_unreadable", manifest: missing }] }
    assert.deepEqual(recheckRoute(warned), warned)
    mkdirSync(missing)
    writeFileSync(path.join(missing, "plugin.json"), "{ broken")
    assert.deepEqual(recheckRoute(warned), warned)
    writeFileSync(path.join(missing, "plugin.json"), JSON.stringify({ name: "x" }))
    assert.deepEqual(recheckRoute(warned), warned, "declares nothing: what came after it was never recorded")
    assert.deepEqual(recheckRoute({ ...warned, store: "ourostack/factory", source: "default" }), warned, "an older Desk's public default is not released")
    writeFileSync(path.join(missing, "plugin.json"), JSON.stringify({ name: "x", desk: { factory: { store: "corp/private" } } }))
    assert.deepEqual(recheckRoute(warned), { store: "corp/private", source: "overlay", warnings: [] })
    assert.equal(rereadWarnings([{ code: "manifest_unreadable", manifest: missing }]).store, "corp/private")
  })
})
