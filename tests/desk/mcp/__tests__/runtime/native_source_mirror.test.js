import { test } from "node:test"
import { strict as assert } from "node:assert"
import { execFileSync } from "node:child_process"
import { readFileSync, rmSync, copyFileSync, appendFileSync, existsSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { hashCurrentSource, sourceFilesForHash, syncSourceMirror } from "../../../../../plugins/desk/mcp/src/runtime/bootstrap.js"

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

test("native: source mirror hashes native src MJS but explicitly refuses native installation without the normal plugin payload", async () => {
  const base = await mkTempRoot("desk-native-D-mirror-")
  const files = sourceFilesForHash(mcpRoot)
  for (const file of ["src/browser/native-provider.mjs", "src/browser/native-host.mjs", "src/util/broker-lock.mjs"])
    assert.ok(files.includes(file), `${file} must remain source hashed`)
  for (const excluded of ["native-host.mjs", "web-native-messaging.cjs", "native/browser-messaging/main.go", "artifacts/browser-messaging/manifest.json"])
    assert.equal(files.includes(excluded), false, "normal bootstrap mirror roots are not expanded")
  const mirror = syncSourceMirror({ mcpRoot, runtimeCacheDir: path.join(base, "runtime-cache") })
  assert.equal(hashCurrentSource(mirror), hashCurrentSource(mcpRoot))
  assert.equal(readFileSync(path.join(mirror, "src/browser/native-provider.mjs"), "utf8"),
    readFileSync(path.join(mcpRoot, "src/browser/native-provider.mjs"), "utf8"))
  appendFileSync(path.join(mirror, "src/util/broker-error.mjs"), "\n// owned mirror hash mutation\n")
  assert.notEqual(hashCurrentSource(mirror), hashCurrentSource(mcpRoot))
  // Place only the actual install API in the incomplete copy so its bounded
  // distribution refusal is exercised, not an ERR_MODULE_NOT_FOUND assertion.
  copyFileSync(path.join(mcpRoot, "native-messaging-install.mjs"), path.join(mirror, "native-messaging-install.mjs"))
  const installer = await import(pathToFileURL(path.join(mirror, "native-messaging-install.mjs")))
  assert.equal(typeof installer.installNativeMessaging, "function")
  await assert.rejects(installer.installNativeMessaging({}), { code: "NATIVE_DISTRIBUTION_INCOMPLETE" })
  assert.equal(existsSync(path.join(mirror, "native")), false)
  assert.equal(existsSync(path.join(mirror, "artifacts")), false)
})
