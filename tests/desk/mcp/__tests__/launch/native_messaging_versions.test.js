import test from "node:test"
import assert from "node:assert/strict"
import path from "node:path"
import { mkdir, stat, writeFile } from "node:fs/promises"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"

const versions = await import(new URL("../../../../../plugins/desk/mcp/native-messaging-versions.mjs", import.meta.url))

test("Desk versions order as semantic versions, and an unknown version orders first", () => {
  const ordered = [null, "not-a-version", "3.2.0-alpha.9", "3.2.0-alpha.10", "3.2.0-alpha.300", "3.2.0-beta", "3.2.0", "3.10.0"]
  for (let index = 1; index < ordered.length; index++) {
    if (index > 1) assert.equal(versions.compareVersions(ordered[index - 1], ordered[index]), -1, `${ordered[index - 1]} < ${ordered[index]}`)
    assert.equal(versions.compareVersions(ordered[index], ordered[index - 1]) >= 0, true)
  }
  assert.equal(versions.compareVersions(null, "garbage"), 0)
  assert.equal(versions.compareVersions("3.2.0-alpha", "3.2.0-alpha.1"), -1)
  assert.equal(versions.compareVersions("3.2.0-alpha.1", "3.2.0-alpha.1"), 0)
})

test("the Desk version is read from either plugin manifest", async () => {
  assert.match(await versions.readDeskVersion(mcpRoot), /^\d+\.\d+\.\d+/u)
  const root = await mkTempRoot("native-versions-manifest-")
  await mkdir(path.join(root, "mcp"))
  assert.equal(await versions.readDeskVersion(path.join(root, "mcp")), null)
  await mkdir(path.join(root, ".claude-plugin"))
  await writeFile(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify({ version: "3.2.0-alpha.301" }))
  assert.equal(await versions.readDeskVersion(path.join(root, "mcp")), "3.2.0-alpha.301")
})

test("each digest keeps the newest release that installed it, in a private file", async () => {
  const root = await mkTempRoot("native-versions-record-")
  assert.deepEqual(await versions.readVersions(root), { version: 1, capsules: {}, extensions: {} })
  const capsule = "a".repeat(64)
  const extension = "b".repeat(64)
  await versions.recordVersions(root, { capsule, extension, deskVersion: "3.2.0-alpha.301" })
  await versions.recordVersions(root, { capsule, extension: "not-a-digest", deskVersion: "3.2.0-alpha.300" })
  await versions.recordVersions(root, { capsule, extension, deskVersion: "unknown" })
  const recorded = await versions.readVersions(root)
  assert.equal(versions.versionOf(recorded, "capsules", capsule), "3.2.0-alpha.301")
  assert.equal(versions.versionOf(recorded, "extensions", extension), "3.2.0-alpha.301")
  assert.equal(versions.versionOf(recorded, "extensions", "c".repeat(64)), null)
  if (process.platform !== "win32") assert.equal((await stat(path.join(root, "versions.json"))).mode & 0o777, 0o600)
  await writeFile(path.join(root, "versions.json"), "{")
  assert.deepEqual(await versions.readVersions(root), { version: 1, capsules: {}, extensions: {} })
})
