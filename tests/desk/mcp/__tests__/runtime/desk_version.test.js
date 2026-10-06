import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deskVersion } from "../../../../../plugins/desk/mcp/src/package-metadata.js"

const plugin = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../plugins/desk/plugin.json", import.meta.url)), "utf8"))
const runtimePackage = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../../plugins/desk/mcp/package.json", import.meta.url)), "utf8"))

test("the Desk version an agent sees is the plugin release, not the runtime package's", () => {
  assert.equal(deskVersion({}), plugin.version)
  assert.notEqual(deskVersion({}), runtimePackage.version)
})

test("the Desk version is read from DESK_PLUGIN_ROOT, which a source mirror relies on", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-version-"))
  writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ version: "9.9.9-alpha.1" }))
  assert.equal(deskVersion({ DESK_PLUGIN_ROOT: root }), "9.9.9-alpha.1")
})

test("the Desk version is null when plugin.json is missing or carries no version", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-version-"))
  assert.equal(deskVersion({ DESK_PLUGIN_ROOT: root }), null)
  writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ version: 3 }))
  assert.equal(deskVersion({ DESK_PLUGIN_ROOT: root }), null)
})

test("the process environment is the default", () => {
  assert.equal(typeof deskVersion(), "string")
})
