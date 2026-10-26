import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { validateActivationManifest } from "../../../../../plugins/desk/mcp/src/activation/validate.js"

const activation = () => JSON.parse(readFileSync(new URL("../../../../../plugins/desk/activation/desk.activation.json", import.meta.url), "utf8"))

for (const [field, mutate] of [
  ["mcp_servers[0]", (manifest) => { manifest.mcp_servers = [null] }],
  ["artifacts.embeddings", (manifest) => { manifest.artifacts.embeddings = null }],
  ["artifacts.snapshots", (manifest) => { manifest.artifacts.snapshots = null }],
  ["host_support[0]", (manifest) => { manifest.host_support = [null] }],
]) {
  test(`activation validation rejects null ${field} with its object diagnostic and no partial value`, () => {
    const manifest = activation()
    mutate(manifest)
    const before = structuredClone(manifest)
    const result = validateActivationManifest(manifest)
    assert.equal(result.ok, false)
    assert.equal(result.value, undefined)
    assert.deepEqual(result.errors.filter((error) => error.code === "missing_required_object").map((error) => error.path), [field])
    assert.deepEqual(manifest, before)
  })
}
