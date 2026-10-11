import test from "node:test"
import assert from "node:assert/strict"
import { mkTempRoot as createTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import path from "node:path"
import { createHash } from "node:crypto"
import http from "node:http"
import { mkdir, readFile, stat, writeFile, chmod, readdir, symlink, link } from "node:fs/promises"
import { spawnSync } from "node:child_process"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/native-messaging-install.mjs", import.meta.url)
const ownRoots = []
async function mkTempRoot(prefix) {
  const root = await createTempRoot(prefix)
  ownRoots.push(root)
  return root
}
const reg = process.platform === "win32" ? path.join(process.env.SystemRoot, "System32/reg.exe") : null
const registryKey = "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.ourostack.desk.browser"
if (reg) {
  test.before(() => assert.equal(spawnSync(reg, ["query", registryKey, "/ve"], { encoding: "utf8" }).status, 1,
    "never replace a pre-existing native registration on the test runner"))
  test.afterEach(async () => {
    const observed = spawnSync(reg, ["query", registryKey, "/ve"], { encoding: "utf8" })
    if (observed.status === 1) return
    assert.equal(observed.status, 0)
    const file = observed.stdout.match(/REG_SZ\s+([^\r\n]+)/u)?.[1].trim()
    assert.ok(file && ownRoots.some(root => path.resolve(file).startsWith(path.resolve(root) + path.sep)),
      "remove only the exact registration created by this file's owned fixtures")
    assert.equal(spawnSync(reg, ["delete", registryKey, "/f"], { encoding: "utf8" }).status, 0)
  })
}

test("native registration locations follow browser user-data root or exact per-user Windows key", async () => {
  const { registrationLocation } = await import(moduleUrl)
  assert.deepEqual(registrationLocation({ platform: "darwin", channel: "msedge", userDataRoot: "/profiles/edge" }),
    { file: "/profiles/edge/NativeMessagingHosts/com.ourostack.desk.browser.json" })
  assert.deepEqual(registrationLocation({ platform: "linux", channel: "chrome", userDataRoot: "/profiles/chrome" }),
    { file: "/profiles/chrome/NativeMessagingHosts/com.ourostack.desk.browser.json" })
  assert.deepEqual(registrationLocation({ platform: "win32", channel: "msedge" }),
    { registryKey: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.ourostack.desk.browser" })
  assert.deepEqual(registrationLocation({ platform: "win32", channel: "chrome" }),
    { registryKey: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.ourostack.desk.browser" })
})

test("private native install copies verified assets and stable extension without compiling or launching browser", async () => {
  const { installNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-install-")
  const userDataRoot = path.join(root, "browser")
  await mkdir(userDataRoot, { mode: 0o700 })
  const installed = await installNativeMessaging({
    mcpRoot, root: path.join(root, "owned"), userDataRoot, profile: "Default", channel: "msedge",
    browserExecutable: process.execPath, runtimeExecutable: process.execPath, levelModule: "/existing/level",
    platform: process.platform, arch: process.arch,
  })
  assert.equal(installed.extensionId, "bcejpajaingepdloiolbmbaflecgifbe")
  assert.equal(installed.extensionDirectory, path.join(root, "owned", "extension"), "one-time unpacked installation must keep a stable directory across native runtime digests")
  const native = JSON.parse(await readFile(path.join(installed.runtimeDirectory, "native-host.json"), "utf8"))
  assert.equal(native.runtime, process.execPath)
  assert.ok(path.isAbsolute(native.hostModule))
  assert.equal(native.extensionOrigin, "chrome-extension://bcejpajaingepdloiolbmbaflecgifbe/")
  const manifest = JSON.parse(await readFile(installed.registration.file, "utf8"))
  assert.equal(manifest.path, installed.executable)
  assert.deepEqual(manifest.allowed_origins, [native.extensionOrigin])
  assert.equal(manifest.type, "stdio")
  if (process.platform !== "win32") assert.equal((await stat(installed.runtimeDirectory)).mode & 0o077, 0)
  assert.equal((await stat(installed.executable)).mode & 0o777, process.platform === "win32" ? (await stat(installed.executable)).mode & 0o777 : 0o700)
  const repeated = await installNativeMessaging({
    mcpRoot, root: path.join(root, "owned"), userDataRoot, profile: "Default", channel: "msedge",
    browserExecutable: process.execPath, runtimeExecutable: process.execPath, levelModule: "/existing/level",
    platform: process.platform, arch: process.arch,
  })
  assert.equal(repeated.runtimeDirectory, installed.runtimeDirectory)
  await writeFile(path.join(installed.runtimeDirectory, "native-host.json"),
    JSON.stringify({ ...native, runtime: "/foreign/runtime" }), { mode: 0o600 })
  await assert.rejects(installNativeMessaging({
    mcpRoot, root: path.join(root, "owned"), userDataRoot, profile: "Default", channel: "msedge",
    browserExecutable: process.execPath, runtimeExecutable: process.execPath, levelModule: "/existing/level",
    platform: process.platform, arch: process.arch,
  }), error => error.code === "NATIVE_RUNTIME_INTEGRITY")
})

test("installer pins the actual selected extension token in a private immutable capsule instead of delegating profile reads", async () => {
  const { installNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-profile-pin-")
  const userDataRoot = path.join(root, "browser"), owned = path.join(root, "owned")
  const store = path.join(userDataRoot, "Default/Local Storage/leveldb")
  const levelModule = path.join(root, "level.cjs")
  const extensionId = "bcejpajaingepdloiolbmbaflecgifbe"
  await mkdir(store, { recursive: true })
  await writeFile(levelModule, `
    const fs = require("node:fs"), path = require("node:path");
    exports.ClassicLevel = class {
      constructor(directory) { this.directory = directory; }
      iterator() {
        const rows = JSON.parse(fs.readFileSync(path.join(this.directory, "fixture.json"), "utf8")); let index = 0;
        return { next: async () => {
          const row = rows[index++];
          return row && [Buffer.from(row.key, "latin1"), Buffer.concat([Buffer.from([1]), Buffer.from(row.token)])];
        }, close: async () => {} };
      }
      close() { return Promise.resolve(); }
    };
  `)
  const writeToken = token => writeFile(path.join(store, "fixture.json"), JSON.stringify([
    { key: "_chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\u0000\u0001deskBrowserProfileToken", token: "d".repeat(64) },
    { key: "_chrome-extension://" + extensionId + "\u0000\u0001deskBrowserProfileToken", token },
  ]))
  const options = { mcpRoot, root: owned, userDataRoot, profile: "Default", channel: "msedge",
    browserExecutable: process.execPath, runtimeExecutable: process.execPath, levelModule }
  await writeToken("a".repeat(64))
  const first = await installNativeMessaging(options)
  const firstConfig = path.join(first.runtimeDirectory, "provider-config.json")
  assert.equal(JSON.parse(await readFile(firstConfig, "utf8")).expectedProfileToken, "a".repeat(64))
  if (process.platform !== "win32") assert.equal((await stat(firstConfig)).mode & 0o077, 0)
  await writeToken("b".repeat(64))
  const second = await installNativeMessaging(options)
  assert.notEqual(second.runtimeDirectory, first.runtimeDirectory)
  assert.equal(JSON.parse(await readFile(firstConfig, "utf8")).expectedProfileToken, "a".repeat(64))
  assert.equal(JSON.parse(await readFile(path.join(second.runtimeDirectory, "provider-config.json"), "utf8")).expectedProfileToken, "b".repeat(64))
  assert.equal(second.extensionDirectory, first.extensionDirectory)
  assert.equal(second.extensionSourceDigest, first.extensionSourceDigest)
  await writeToken("corrupt")
  await assert.rejects(installNativeMessaging(options), error => error.code === "NATIVE_PROFILE_MISMATCH")
})

test("foreign native registration is refused instead of silently overwritten", async () => {
  const { installNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-foreign-")
  const userDataRoot = path.join(root, "browser")
  await mkdir(path.join(userDataRoot, "NativeMessagingHosts"), { recursive: true })
  const foreignManifest = path.join(userDataRoot, "NativeMessagingHosts", "com.ourostack.desk.browser.json")
  await writeFile(foreignManifest,
    JSON.stringify({ name: "com.ourostack.desk.browser", path: "/foreign/host", type: "stdio", allowed_origins: ["chrome-extension://foreign/"] }), { mode: 0o600 })
  if (reg) assert.equal(spawnSync(reg, ["add", registryKey, "/ve", "/t", "REG_SZ", "/d", foreignManifest, "/f"]).status, 0)
  await assert.rejects(installNativeMessaging({
    mcpRoot, root: path.join(root, "owned"), userDataRoot, profile: "Default", channel: "msedge",
    browserExecutable: process.execPath, runtimeExecutable: process.execPath, levelModule: "/existing/level",
    platform: process.platform, arch: process.arch,
  }), error => error.code === "NATIVE_REGISTRATION_CONFLICT")
})

test("deliberate native update changes stable extension bytes only after exact live-effect gate", async () => {
  const { updateNativeExtension } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-update-")
  const source = path.join(root, "source")
  const installed = path.join(root, "owned", "extension")
  await mkdir(source, { recursive: true })
  await mkdir(installed, { recursive: true })
  await chmod(path.dirname(installed), 0o700)
  await writeFile(path.join(source, "manifest.json"), '{"key":"same","version":"2"}')
  await writeFile(path.join(source, "background.js"), "new")
  await writeFile(path.join(installed, "manifest.json"), '{"key":"same","version":"1"}')
  await writeFile(path.join(installed, "background.js"), "old")
  const order = []
  await updateNativeExtension({
    sourceDirectory: source, extensionDirectory: installed,
    gate: async () => { order.push("gate"); return { safe: true } },
    reload: async () => { order.push("reload"); assert.equal(await readFile(path.join(installed, "background.js"), "utf8"), "new") },
  })
  assert.deepEqual(order, ["gate", "reload"])
  assert.equal(await readFile(path.join(installed, "manifest.json"), "utf8"), '{"key":"same","version":"2"}')
  await writeFile(path.join(source, "background.js"), "third")
  await assert.rejects(updateNativeExtension({
    sourceDirectory: source, extensionDirectory: installed,
    gate: async () => ({ safe: false }), reload: async () => { throw new Error("must not reload") },
  }), error => error.code === "NATIVE_UPDATE_EFFECTS_PENDING")
  assert.equal(await readFile(path.join(installed, "background.js"), "utf8"), "new")
})

test("native update publishes a complete source snapshot without obsolete installed files", async () => {
  const { updateNativeExtension } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-snapshot-")
  const source = path.join(root, "source")
  const installed = path.join(root, "owned", "extension")
  await mkdir(source, { recursive: true })
  await mkdir(installed, { recursive: true })
  await chmod(path.dirname(installed), 0o700)
  await writeFile(path.join(source, "manifest.json"), '{"key":"same","version":"2"}')
  await writeFile(path.join(source, "background.js"), "verified-new")
  await writeFile(path.join(installed, "manifest.json"), '{"key":"same","version":"1"}')
  await writeFile(path.join(installed, "obsolete.js"), "old")
  const result = await updateNativeExtension({
    sourceDirectory: source, extensionDirectory: installed,
    gate: async () => {
      await writeFile(path.join(source, "background.js"), "changed-after-snapshot")
      return { safe: true }
    },
    reload: async () => {
      assert.equal(await readFile(path.join(installed, "background.js"), "utf8"), "verified-new")
      assert.deepEqual((await readdir(installed)).sort(), ["background.js", "manifest.json"])
    },
  })

  assert.equal(await readFile(path.join(result.previousDirectory, "obsolete.js"), "utf8"), "old",
    "keep the exact prior source until disconnected consumers reconcile")
})

test("native installation refuses a symlinked ancestor before changing the external directory", async () => {
    const { installNativeMessaging } = await import(moduleUrl)
    const root = await mkTempRoot("native-messaging-path-")
    const external = path.join(root, "external")
    await mkdir(external, { mode: 0o755 })
    await symlink(external, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
    const before = (await stat(external)).mode
    await assert.rejects(installNativeMessaging({
      mcpRoot, root: path.join(root, "link", "owned"), userDataRoot: path.join(root, "browser"),
      profile: "Default", channel: "msedge", browserExecutable: process.execPath,
      runtimeExecutable: process.execPath, levelModule: "/existing/level",
    }), error => error.code === "NATIVE_PATH_INVALID")
    assert.equal((await stat(external)).mode, before)
    assert.deepEqual(await readdir(external), [])
  })

test("repeat native installation refuses extra executable extension source", async () => {
    const { installNativeMessaging } = await import(moduleUrl)
    const root = await mkTempRoot("native-messaging-inventory-")
    const options = {
      mcpRoot, root: path.join(root, "owned"), userDataRoot: path.join(root, "browser"),
      profile: "Default", channel: "msedge", browserExecutable: process.execPath,
      runtimeExecutable: process.execPath, levelModule: "/existing/level",
    }
    const installed = await installNativeMessaging(options)
    await writeFile(path.join(installed.extensionDirectory, "unexpected.js"), "unexpected source")
    await assert.rejects(installNativeMessaging(options), error => error.code === "NATIVE_EXTENSION_UPDATE_REQUIRED")
  })

test("interrupted native extension swap restores the registered directory from its exact journal", async () => {
  const { recoverNativeExtensionUpdate } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-recover-")
  const installed = path.join(root, "extension")
  const previous = path.join(root, ".extension-previous-12345678-1234-1234-1234-123456789abc")
  const staged = path.join(root, ".extension-update-fixture")
  await mkdir(previous, { mode: 0o700 })
  await mkdir(staged, { mode: 0o700 })
  const oldFiles = [["manifest.json", '{"key":"same","version":"1"}']]
  const newFiles = [["background.js", "new"], ["manifest.json", '{"key":"same","version":"2"}']]
  for (const [name, content] of oldFiles) await writeFile(path.join(previous, name), content, { mode: 0o600 })
  for (const [name, content] of newFiles) await writeFile(path.join(staged, name), content, { mode: 0o600 })
  const digest = files => createHash("sha256").update(JSON.stringify(files.map(([name, content]) =>
    [name, createHash("sha256").update(content).digest("hex")]))).digest("hex")
  await writeFile(path.join(root, "extension-update.json"), JSON.stringify({
    version: 1, stable: "extension", staged: path.basename(staged), previous: path.basename(previous),
    newDigest: digest(newFiles), previousDigest: digest(oldFiles),
  }), { mode: 0o600 })
  const recovered = await recoverNativeExtensionUpdate({ extensionDirectory: installed })
  assert.equal(recovered.reloadRequired, true, "filesystem recovery must not claim transport continuity")
  assert.equal(await readFile(path.join(installed, "background.js"), "utf8"), "new")
  assert.equal(await readFile(path.join(previous, "manifest.json"), "utf8"), '{"key":"same","version":"1"}')
  const repeated = await recoverNativeExtensionUpdate({ extensionDirectory: installed })
  assert.equal(repeated.reloadRequired, true)
  assert.deepEqual((await readdir(installed)).sort(), ["background.js", "manifest.json"])
})

test("concurrent native installation publishes one complete verified runtime and registration", async () => {
  const { installNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-concurrent-")
  const options = {
    mcpRoot, root: path.join(root, "owned"), userDataRoot: path.join(root, "browser"),
    profile: "Default", channel: "msedge", browserExecutable: process.execPath,
    runtimeExecutable: process.execPath, levelModule: "/existing/level",
  }
  const [first, second] = await Promise.all([installNativeMessaging(options), installNativeMessaging(options)])
  assert.equal(first.runtimeDirectory, second.runtimeDirectory)
  assert.equal(JSON.parse(await readFile(first.registration.file, "utf8")).path, first.executable)
  assert.equal(await readFile(path.join(first.extensionDirectory, "background.js"), "utf8"),
    await readFile(path.resolve(mcpRoot, "../browser-extension/background.js"), "utf8"))
})

test("ordinary native installation refuses an invalid pending update journal without replacing it", async () => {
  const { installNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-pending-")
  const owned = path.join(root, "owned")
  await mkdir(owned, { mode: 0o700 })
  const journal = '{"version":1,"staged":"../external","stable":"extension"}'
  await writeFile(path.join(owned, "extension-update.json"), journal, { mode: 0o600 })
  await assert.rejects(installNativeMessaging({
    mcpRoot, root: owned, userDataRoot: path.join(root, "browser"),
    profile: "Default", channel: "msedge", browserExecutable: process.execPath,
    runtimeExecutable: process.execPath, levelModule: "/existing/level",
  }), error => error.code === "NATIVE_UPDATE_JOURNAL_INVALID")
  assert.equal(await readFile(path.join(owned, "extension-update.json"), "utf8"), journal)
  assert.deepEqual(await readdir(owned), ["extension-update.json"])
})

test("explicit native messaging update gates source and registration before exact provider reload", async t => {
  const { installNativeMessaging, updateNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-product-update-")
  const options = {
    mcpRoot, root: path.join(root, "owned"), userDataRoot: path.join(root, "browser"),
    profile: "Default", channel: "msedge", browserExecutable: process.execPath,
    runtimeExecutable: process.execPath, levelModule: "/existing/level",
  }
  const installed = await installNativeMessaging(options)
  const operations = []
  const updateToken = "b".repeat(64)
  const expectedProcessIdentity = { pid: 42, startIdentity: "actual-browser-generation" }
  const server = http.createServer(async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk
    const input = JSON.parse(text)
    operations.push(input.operation)
    let result
    if (input.operation === "prepareUpdate") {
      assert.deepEqual(input.payload.expectedProcessIdentity, expectedProcessIdentity)
      result = { safe: true, updateToken }
    } else if (input.operation === "reloadExtension") {
      assert.equal(input.payload.updateToken, updateToken)
      assert.equal(JSON.parse(await readFile(installed.registration.file, "utf8")).path, installed.executable)
      assert.equal(await readFile(path.join(installed.extensionDirectory, "background.js"), "utf8"),
        await readFile(path.resolve(mcpRoot, "../browser-extension/background.js"), "utf8"))
      result = { reloading: true, reconciliationRequired: true }
    } else {
      assert.fail("unexpected product update operation")
    }
    response.setHeader("content-type", "application/json")
    response.end(JSON.stringify({ ok: true, result }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const result = await updateNativeMessaging({
    ...options, providerEndpoint: `http://127.0.0.1:${server.address().port}/provider/${"a".repeat(64)}`,
    expectedProcessIdentity,
  })
  assert.deepEqual(operations, ["prepareUpdate", "reloadExtension"])
  assert.equal(result.reconciliationRequired, true)
  assert.equal(result.extensionDirectory, installed.extensionDirectory)
})

test("failed native runtime staging cannot poison the next verified installation", async t => {
  const { installNativeMessaging } = await import(moduleUrl)
  const fs = (await import("node:fs/promises")).default
  const root = await mkTempRoot("native-messaging-runtime-interrupted-")
  const options = {
    mcpRoot, root: path.join(root, "owned"), userDataRoot: path.join(root, "browser"),
    profile: "Default", channel: "msedge", browserExecutable: process.execPath,
    runtimeExecutable: process.execPath, levelModule: "/existing/level",
  }
  const write = fs.writeFile
  t.mock.method(fs, "writeFile", async (file, ...args) => {
    if (path.basename(file) === "provider-config.json") {
      throw Object.assign(new Error("owned fixture interrupted runtime publication"), { code: "EIO" })
    }
    return write(file, ...args)
  })
  await assert.rejects(installNativeMessaging(options), error => error.code === "EIO")
  t.mock.restoreAll()
  const installed = await installNativeMessaging(options)
  assert.equal(JSON.parse(await readFile(path.join(installed.runtimeDirectory, "provider-config.json"), "utf8")).extensionId,
    "bcejpajaingepdloiolbmbaflecgifbe")
  assert.equal(JSON.parse(await readFile(installed.registration.file, "utf8")).path, installed.executable)
})

test("repeat native install refuses shared hard-linked configuration before registration publication", async () => {
  const { installNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-hardlink-")
  const options = {
    mcpRoot, root: path.join(root, "owned"), userDataRoot: path.join(root, "browser"),
    profile: "Default", channel: "msedge", browserExecutable: process.execPath,
    runtimeExecutable: process.execPath, levelModule: "/existing/level",
  }
  const installed = await installNativeMessaging(options)
  const registration = await readFile(installed.registration.file, "utf8")
  await link(path.join(installed.runtimeDirectory, "native-host.json"), path.join(root, "shared-config.json"))
  await assert.rejects(installNativeMessaging(options), error => error.code === "NATIVE_RUNTIME_INTEGRITY")
  assert.equal(await readFile(installed.registration.file, "utf8"), registration)
})

test("native private root belonging to another owner is refused without repairing its mode", {
  skip: process.platform === "win32" ? "POSIX owner evidence; Windows uses the maintained ACL path" : false,
}, async t => {
  const { installNativeMessaging } = await import(moduleUrl)
  const fs = (await import("node:fs/promises")).default
  const root = await mkTempRoot("native-messaging-owner-")
  const owned = path.join(root, "owned")
  await mkdir(owned, { mode: 0o755 })
  const original = fs.lstat
  t.mock.method(fs, "lstat", async (file, ...args) => {
    const info = await original(file, ...args)
    if (file === owned) info.uid = process.getuid() + 1
    return info
  })
  await assert.rejects(installNativeMessaging({
    mcpRoot, root: owned, userDataRoot: path.join(root, "browser"),
    profile: "Default", channel: "msedge", browserExecutable: process.execPath,
    runtimeExecutable: process.execPath, levelModule: "/existing/level",
  }), error => error.code === "NATIVE_PATH_OWNER_MISMATCH")
  assert.notEqual((await stat(owned)).mode & 0o077, 0, "never repair somebody else's private directory")
})

test("known owned native configuration permissions are restored before Go-entry verification", {
  skip: process.platform === "win32" ? "POSIX mode drift; native Windows lane checks the exact DACL" : false,
}, async () => {
  const { installNativeMessaging } = await import(moduleUrl)
  const root = await mkTempRoot("native-messaging-private-config-")
  const options = {
    mcpRoot, root: path.join(root, "owned"), userDataRoot: path.join(root, "browser"),
    profile: "Default", channel: "msedge", browserExecutable: process.execPath,
    runtimeExecutable: process.execPath, levelModule: path.join(root, "existing/level"),
  }
  const installed = await installNativeMessaging(options)
  const file = path.join(installed.runtimeDirectory, "native-host.json")
  const source = await readFile(file, "utf8")
  await chmod(file, 0o644)
  await installNativeMessaging(options)
  assert.equal((await stat(file)).mode & 0o777, 0o600)
  assert.equal(await readFile(file, "utf8"), source)
})

test("Windows native registration readback requires one exact REG_SZ manifest under the private root", async () => {
  const { nativeRegistryManifestPath } = await import(moduleUrl)
  const root = "C:\\Users\\fixture\\private-native"
  assert.equal(nativeRegistryManifestPath("HKCU\\key\r\n    (Default)    REG_SZ    " + root + "\\runtimes\\digest\\host-manifest.json\r\n", root),
    root + "\\runtimes\\digest\\host-manifest.json")
  for (const output of [
    "(Default) REG_SZ C:\\Users\\fixture\\private-native-foreign\\host-manifest.json",
    "(Default) REG_SZ C:\\Users\\fixture\\private-native\\..\\foreign\\host-manifest.json",
    "(Default) REG_EXPAND_SZ %TEMP%\\host-manifest.json",
    "(Default) REG_SZ " + root + "\\host-manifest.json\nOther REG_SZ " + root + "\\other.json",
  ]) {
    assert.throws(() => nativeRegistryManifestPath(output, root), error => error.code === "NATIVE_REGISTRATION_CONFLICT")
  }
})

test("explicit native update refuses a symlinked private root before gating or writing outside it", async () => {
  const { updateNativeExtension } = await import(moduleUrl)
  const root = await mkTempRoot("native-update-path-")
  const source = path.join(root, "source")
  const external = path.join(root, "external")
  await mkdir(source, { mode: 0o700 })
  await mkdir(path.join(external, "extension"), { recursive: true, mode: 0o700 })
  await chmod(external, 0o700)
  await writeFile(path.join(source, "manifest.json"), '{"key":"same","version":"2"}')
  await writeFile(path.join(external, "extension/manifest.json"), '{"key":"same","version":"1"}')
  await symlink(external, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
  let gated = false
  await assert.rejects(updateNativeExtension({
    sourceDirectory: source, extensionDirectory: path.join(root, "link/extension"),
    gate: async () => { gated = true; return { safe: true } }, reload: async () => {},
  }), error => error.code === "NATIVE_PATH_INVALID")
  assert.equal(gated, false)
  assert.equal(await readFile(path.join(external, "extension/manifest.json"), "utf8"), '{"key":"same","version":"1"}')
})
