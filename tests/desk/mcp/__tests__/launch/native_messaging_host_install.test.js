import test from "node:test"
import assert from "node:assert/strict"
import { readFile, unlink } from "node:fs/promises"
import { spawnSync } from "node:child_process"
import path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import { installNativeMessaging, registrationLocation, nativeRegistryManifestPath } from "../../../../../plugins/desk/mcp/native-messaging-install.mjs"

test("native host installation publishes executable configuration accepted by the real local Go entry", async () => {
  const root = await mkTempRoot("native-host-installed-")
  const owned = path.join(root, "owned")
  const location = registrationLocation({ platform: process.platform, channel: "msedge", userDataRoot: path.join(root, "browser") })
  const reg = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32", "reg.exe") : null
  if (reg) {
    const previous = spawnSync(reg, ["query", location.registryKey, "/ve"], { encoding: "utf8", windowsHide: true })
    assert.equal(previous.status, 1, "the native runner must have no pre-existing registration; never replace another owner")
  }
  let installed
  try {
    installed = await installNativeMessaging({
      mcpRoot, root: owned, userDataRoot: path.join(root, "browser"), profile: "Default", channel: "msedge",
      browserExecutable: process.execPath, runtimeExecutable: process.execPath, levelModule: path.join(root, "level"),
    })
    const manifest = JSON.parse(await readFile(installed.registration.file, "utf8"))
    assert.equal(manifest.path, installed.executable)
    assert.deepEqual(manifest.allowed_origins, ["chrome-extension://" + installed.extensionId + "/"])
    if (reg) {
      const observed = spawnSync(reg, ["query", location.registryKey, "/ve"], { encoding: "utf8", windowsHide: true })
      assert.equal(observed.status, 0)
      assert.equal(nativeRegistryManifestPath(observed.stdout, owned).toLowerCase(), installed.registration.file.toLowerCase())
    }
    const ran = spawnSync(installed.executable, ["chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/"], {
      encoding: "utf8", windowsHide: true, timeout: 15000,
    })
    assert.equal(ran.error, undefined)
    assert.equal(ran.status, 2)
    assert.equal(ran.stdout, "")
    assert.equal(ran.stderr.trim(), "NATIVE_HOST_REFUSED",
      "real Go configuration/privacy checks must accept the published config before the deliberately wrong origin is refused")
    console.log(`Actual installed Go entry/configuration executed on ${process.platform}-${process.arch}; no browser or authenticated profile used.`)
  } finally {
    if (installed) {
      if (reg) {
        const observed = spawnSync(reg, ["query", location.registryKey, "/ve"], { encoding: "utf8", windowsHide: true })
        assert.equal(observed.status, 0)
        assert.equal(nativeRegistryManifestPath(observed.stdout, owned).toLowerCase(), installed.registration.file.toLowerCase())
        const removed = spawnSync(reg, ["delete", location.registryKey, "/f"], { encoding: "utf8", windowsHide: true })
        assert.equal(removed.status, 0)
      }
      await unlink(installed.registration.file)
    }
  }
})
