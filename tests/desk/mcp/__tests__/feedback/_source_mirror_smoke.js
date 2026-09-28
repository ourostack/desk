import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

import { importRuntimeServer } from "../../src/runtime/bootstrap.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const mcpVersion = JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8")).version
const deskVersion = JSON.parse(readFileSync(path.join(mcpRoot, "..", "plugin.json"), "utf8")).version
const fixture = JSON.parse(process.argv[2])
const runtime = await importRuntimeServer({
  mcpRoot,
  runtimeCacheDir: path.join(fixture.base, "runtime-cache"),
})
assert.equal(runtime._deskRuntime.loaded_from_source_mirror, true)
assert.equal(runtime.TOOL_NAMES.includes("desk_feedback"), false)

// The mirrored copy of the retained protected-storage primitive — the same
// module the mirrored server would load — must attribute a record to the
// installed Desk plugin, not to the MCP component or the cache parent.
const mirroredStore = await import(pathToFileURL(
  path.join(runtime._deskRuntime.source_mirror_path, "src", "feedback", "store.js"),
).href)
const binding = {
  deskRoot: fixture.deskRoot,
  pluginRoot: runtime._deskRuntime.plugin_root,
}
const entry = await mirroredStore.withPrivateStore(binding, (store) =>
  store.capture({ text: "Source-mirror feedback fixture.", taskRef: null }))
assert.equal(entry.preview_version, deskVersion)
assert.notEqual(entry.preview_version, mcpVersion)

const listed = await mirroredStore.withPrivateStore(binding, (store) => store.list({ limit: 20 }))
assert.deepEqual(listed.entries, [entry])
process.stdout.write("source-mirror-feedback-ok\n")
