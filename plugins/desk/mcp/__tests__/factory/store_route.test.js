// Store routing: which factory store a desk reports to. Fixture desks and
// plugin folders are built in a temporary folder; no real desk or installed
// plugin is read.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { DEFAULT_STORE, resolveStore } from "../../src/factory/store-route.js"

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
    assert.deepEqual(route({ deskRoot: desk, pluginDirs: [7, null, path.join(root, "missing")] }), { store: "ourostack/factory", source: "default" })
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

test("an unreadable or unparseable plugin manifest is skipped with a warning, so a broken unrelated plugin never blocks the facts", () => {
  scratch((root) => {
    const desk = makeDesk(root)
    const unreadable = makePlugin(root, "unreadable", undefined)
    mkdirSync(path.join(unreadable, "plugin.json"))
    const unparseable = makePlugin(root, "unparseable", "{ not json", ".claude-plugin/plugin.json")
    const notObject = makePlugin(root, "not-object", "[]")
    const good = makePlugin(root, "good", overlay("good-org/factory"))
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [unreadable, unparseable, notObject, good] }), {
      store: "good-org/factory",
      source: "overlay",
      warnings: [
        { code: "manifest_unreadable", manifest: path.join(unreadable, "plugin.json") },
        { code: "manifest_unparseable", manifest: path.join(unparseable, ".claude-plugin", "plugin.json") },
        { code: "manifest_unparseable", manifest: path.join(notObject, "plugin.json") },
      ],
    })
    assert.deepEqual(resolveStore({ deskRoot: desk, pluginDirs: [unreadable] }), {
      store: "ourostack/factory",
      source: "default",
      warnings: [{ code: "manifest_unreadable", manifest: path.join(unreadable, "plugin.json") }],
    })
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
