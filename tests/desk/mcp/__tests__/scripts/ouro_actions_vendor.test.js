import { test } from "node:test"
import assert from "node:assert/strict"
import * as fs from "node:fs"
import * as crypto from "node:crypto"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const vendor = path.join(repoRoot, "plugins", "desk", "mcp", "src", "lib", "ouro-actions")
const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex")

test("the vendored action generator and claims are the ones core's release manifest names", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(vendor, "dist-manifest.json"), "utf8"))
  assert.equal(manifest.coreTag, "v0.16.0")
  for (const [key, file] of [["dist/actions/ouro-actions.mts", "ouro-actions.mts"], ["dist/ax/actions.claims.json", "actions.claims.json"]]) {
    assert.equal(sha256(path.join(vendor, file)), manifest.files[key], `${file} differs from ${key} in core v0.16.0`)
  }
})

test("the AX kit modules Desk's command and MCP surfaces import are vendored byte for byte", () => {
  const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, "upstream-sources.lock.json"), "utf8"))
  const source = lock.sources.find((item) => item.id === "ourostack-ouro-ui-ax")
  for (const file of ["command", "mcp", "xray", "cli"]) {
    const entry = source.files.find((item) => item.sourcePath === `registry/ouro/ax/${file}.ts`)
    assert.ok(entry, `registry/ouro/ax/${file}.ts is in the lock`)
    assert.equal(sha256(path.join(repoRoot, entry.generatedPath)), entry.sha256)
  }
})
