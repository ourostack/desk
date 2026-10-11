import { test } from "node:test"
import { strict as assert } from "node:assert"
import { chmodSync, cpSync, existsSync, lstatSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const moduleFile = path.join(mcpRoot, "web-native-messaging.cjs")

test("native messaging ships eight independently verified artifacts", () => {
  const native = require(moduleFile)
  assert.deepEqual(native.verifyAssets(mcpRoot).targets.sort(),
    ["darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-x64", "win32-arm64", "win32-ia32", "win32-x64"])
  assert.throws(() => native.selectAsset(mcpRoot, "freebsd", "x64"), /browser_native_messaging_unsupported/u)
})

test("mode0644 messaging asset runs only from its private verified copy", async () => {
  const native = require(moduleFile)
  const root = await mkTempRoot("native-messaging-private-")
  const install = path.join(root, "install")
  cpSync(path.join(mcpRoot, "native", "browser-messaging"), path.join(install, "native", "browser-messaging"), { recursive: true })
  cpSync(path.join(mcpRoot, "artifacts", "browser-messaging"), path.join(install, "artifacts", "browser-messaging"), { recursive: true })
  const asset = native.selectAsset(install, process.platform, process.arch)
  chmodSync(asset.file, 0o644)
  const privateFile = path.join(root, "desk-browser-messaging" + (process.platform === "win32" ? ".exe" : ""))
  native.copyPrivateAsset(install, process.platform, process.arch, privateFile)
  assert.deepEqual(readFileSync(privateFile), readFileSync(asset.file))
  if (process.platform !== "win32") {
    assert.equal(lstatSync(privateFile).mode & 0o777, 0o700)
    assert.equal(lstatSync(asset.file).mode & 0o777, 0o644)
  }
  const ran = spawnSync(privateFile, [], { encoding: "utf8" })
  assert.equal(ran.status, 2, "the executable starts and refuses missing private configuration")
  assert.equal(ran.stdout, "")
  assert.match(ran.stderr, /NATIVE_CONFIG_REFUSED/u)
  assert.throws(() => native.copyPrivateAsset(install, process.platform, process.arch, privateFile), /EEXIST/u)
})

test("messaging source drift, altered bytes and symlinked assets refuse copying", async () => {
  const native = require(moduleFile)
  const root = await mkTempRoot("native-messaging-integrity-")
  cpSync(path.join(mcpRoot, "native", "browser-messaging"), path.join(root, "native", "browser-messaging"), { recursive: true })
  cpSync(path.join(mcpRoot, "artifacts", "browser-messaging"), path.join(root, "artifacts", "browser-messaging"), { recursive: true })
  const source = path.join(root, "native", "browser-messaging", "main.go")
  const original = readFileSync(source)
  writeFileSync(source, "source drift")
  assert.throws(() => native.selectAsset(root, process.platform, process.arch), /browser_native_messaging_integrity/u)
  writeFileSync(source, original)
  const selected = native.selectAsset(root, process.platform, process.arch)
  const bytes = readFileSync(selected.file)
  writeFileSync(selected.file, "modified bytes")
  const output = path.join(root, "private.exe")
  assert.throws(() => native.copyPrivateAsset(root, process.platform, process.arch, output), /browser_native_messaging_integrity/u)
  assert.equal(existsSync(output), false)
  const link = path.join(root, "linked")
  if (process.platform !== "win32") {
    symlinkSync(selected.file, link)
    assert.throws(() => native.checkAsset(link, selected.sha256), /browser_native_messaging_integrity/u)
  }
  writeFileSync(selected.file, bytes)
})
