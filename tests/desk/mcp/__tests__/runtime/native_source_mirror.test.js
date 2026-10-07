import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { mkTempRoot } from "../_temp_roots.js"

const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
const mcpVersion = JSON.parse(readFileSync(path.join(mcpRoot, "package.json"), "utf8")).version
const target = `${process.platform}-${process.arch}-node-${process.versions.modules}`
const matrix = JSON.parse(readFileSync(path.join(mcpRoot, "artifacts", "runtime-deps", mcpVersion, "support-matrix.json"), "utf8"))
const shippedTarget = matrix.targets.some(({ id }) => id === target)

// The runtime server must load from the source mirror on this platform: the check that native Windows runs.
test("native source-mirror load: importRuntimeServer reports loaded_from_source_mirror", {
  skip: shippedTarget ? false : `no shipped runtime pack for ${target}`,
}, async () => {
  const base = await mkTempRoot("desk-source-mirror-")
  try {
    // A child process keeps native-library handles out of the process that removes the fixture.
    const output = execFileSync(process.execPath, [
      fileURLToPath(new URL("./_source_mirror_smoke.js", import.meta.url)),
      path.join(base, "runtime-cache"),
    ], { encoding: "utf8", timeout: 60_000 })
    assert.equal(output, "source-mirror-load-ok\n")
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
})
