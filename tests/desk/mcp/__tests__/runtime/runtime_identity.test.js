import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { runtimeIdentity } from "../../../../../plugins/desk/mcp/src/runtime/runtime-identity.js"
import { mkTempRoot } from "../_temp_roots.js"

async function pluginFolder(version) {
  const root = path.join(await mkTempRoot("desk-runtime-identity-"), "plugin")
  mkdirSync(root, { recursive: true })
  writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "desk", version }))
  return root
}

test("before the runtime loads, the identity is the launching plugin folder and its version", async () => {
  const root = await pluginFolder("3.1.4")
  assert.deepEqual(runtimeIdentity({ env: { DESK_PLUGIN_ROOT: root } }), {
    plugin: { name: "desk", version: "3.1.4" }, plugin_root: root, source_mirror_path: null, source_mirror_hash: null, loaded: false,
  })
  assert.equal(runtimeIdentity({ env: { DESK_PLUGIN_ROOT: root }, runtime: { plugin_root: "" } }).plugin_root, root)
})

test("once loaded, the identity is the loaded folder, its version and the mirror's hash", async () => {
  const root = await pluginFolder("3.1.5")
  const mirror = path.join(root, "source-mirror", "feedface")
  const identity = runtimeIdentity({ env: { DESK_PLUGIN_ROOT: "/elsewhere" }, runtime: { plugin_root: root, sourceMirrorPath: mirror, newest_release: { state: "loaded" } } })
  assert.deepEqual(identity, { plugin: { name: "desk", version: "3.1.5" }, plugin_root: root, source_mirror_path: mirror, source_mirror_hash: "feedface", loaded: true, newest_release: { state: "loaded" } })
})

test("an unreadable manifest leaves the version null instead of failing", () => {
  assert.equal(runtimeIdentity({ env: { DESK_PLUGIN_ROOT: path.join(path.sep, "no", "such", "folder") } }).plugin.version, null)
})
