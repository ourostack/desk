import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { createMcpServer } from "../../../../../plugins/desk/mcp/src/server.js"
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

test("the in-process MCP server announces the release, or 0.0.0 when plugin.json cannot be read", () => {
  assert.equal(createMcpServer()._serverInfo.version, plugin.version)
  const saved = process.env.DESK_PLUGIN_ROOT
  process.env.DESK_PLUGIN_ROOT = mkdtempSync(path.join(tmpdir(), "desk-version-"))
  try {
    assert.equal(createMcpServer()._serverInfo.version, "0.0.0")
  } finally {
    if (saved === undefined) delete process.env.DESK_PLUGIN_ROOT
    else process.env.DESK_PLUGIN_ROOT = saved
  }
})
