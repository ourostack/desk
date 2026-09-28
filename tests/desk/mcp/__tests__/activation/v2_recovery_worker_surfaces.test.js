import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"

const pluginRoot = new URL("../../../", import.meta.url)

for (const surface of ["agents/worker.toml"]) {
  test(`${surface} leaves process continuity and delivery to their owning skills`, () => {
    const source = readFileSync(new URL(surface, pluginRoot), "utf8")
    assert.doesNotMatch(source, /Long-lived work, bounded processes/u)
    assert.doesNotMatch(source, /Delivery has an owner/u)
    assert.doesNotMatch(source, /cleanup_pending/u)
  })
}
