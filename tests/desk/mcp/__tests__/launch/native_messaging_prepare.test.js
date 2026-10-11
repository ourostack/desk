import test from "node:test"
import assert from "node:assert/strict"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"
import path from "node:path"
import { createHash } from "node:crypto"
import http from "node:http"
import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"

const moduleUrl = new URL("../../../../../plugins/desk/mcp/native-messaging-prepare.mjs", import.meta.url)
const profile = createRequire(import.meta.url)(path.join(mcpRoot, "web-real-profile.cjs"))
const fixtureEnv = home => process.platform === "win32" ? { LOCALAPPDATA: home } : {}
const fixtureProfile = home => profile.userDataDir("msedge", process.platform, fixtureEnv(home), home)

test("declared native profile with no installed extension returns actionable setup without any browser launch", async () => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-messaging-prepare-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { user_name: "fixture@example.test" } } } }))
  const extensionDirectory = path.join(homeDir, "owned/extension")
  const result = await prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir,
    root: path.join(homeDir, "owned"), mcpRoot, env: fixtureEnv(homeDir),
    installer: async () => ({ stateDir: path.join(homeDir, "state"), extensionDirectory, extensionId: "bcejpajaingepdloiolbmbaflecgifbe" }),
  })
  assert.equal(result.payload.code, "browser_native_messaging_setup_required")
  assert.equal(result.payload.fix.includes("Load Unpacked"), true)
  assert.equal(result.payload.fix.includes(extensionDirectory), true)
  assert.equal(result.args, undefined)
})

test("missing declared signed-in profile refuses before native installation", async () => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-messaging-prepare-missing-")
  let installed = false
  const result = await prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir,
    root: path.join(homeDir, "owned"), mcpRoot, env: fixtureEnv(homeDir),
    installer: async () => { installed = true },
  })
  assert.equal(result.payload.code, "browser_profile_missing")
  assert.equal(installed, false)
})

test("changed native extension source requires deliberate update rather than a background reload", async () => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-messaging-update-refusal-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: { user_name: "fixture@example.test" } } },
  }))
  const result = await prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir,
    root: path.join(homeDir, "owned"), mcpRoot, env: fixtureEnv(homeDir),
    installer: async () => { throw Object.assign(new Error("source changed"), { code: "NATIVE_EXTENSION_UPDATE_REQUIRED" }) },
  })
  assert.equal(result.payload.code, "browser_native_messaging_update_required")
  assert.match(result.payload.fix, /deliberate/u)
  assert.equal(result.args, undefined)
})

test("installed source and running provider source must match before connection acquisition", async () => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-messaging-running-source-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: { user_name: "fixture@example.test" } } },
  }))
  const stateDir = path.join(homeDir, "state")
  await mkdir(stateDir, { mode: 0o700 })
  const profileRoot = path.join(userDataRoot, "Default")
  const readyFile = path.join(stateDir, "native-provider-" +
    createHash("sha256").update(process.execPath + "\0" + profileRoot).digest("hex") + ".json")
  await writeFile(readyFile, JSON.stringify({
    version: 1, processIdentity: { executable: process.execPath, profileRoot },
    endpoint: "http://127.0.0.1:1/provider/" + "a".repeat(64), extensionSourceDigest: "b".repeat(64),
  }), { mode: 0o600 })
  const result = await prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir,
    root: path.join(homeDir, "owned"), mcpRoot, env: fixtureEnv(homeDir),
    installer: async () => ({ stateDir, extensionSourceDigest: "c".repeat(64) }),
  })
  assert.equal(result.payload.code, "browser_native_messaging_update_required",
    "a different executed source must not be treated as merely missing connection setup")
  assert.equal(result.args, undefined)
})

test("explicit native setup update freshly attests existing provider and returns no private endpoint", async t => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-explicit-update-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: { user_name: "fixture@example.test" } } },
  }))
  const root = path.join(homeDir, "owned")
  const stateDir = path.join(root, "native-owned/state")
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  const identity = { executable: process.execPath, profileRoot: path.join(userDataRoot, "Default"), pid: 42, startIdentity: "exact-browser" }
  let attested = false
  const server = http.createServer(async (request, response) => {
    let text = ""
    for await (const chunk of request) text += chunk
    const input = JSON.parse(text)
    assert.equal(input.operation, "attest")
    assert.deepEqual(input.payload.expectedProcessIdentity, identity)
    attested = true
    response.end(JSON.stringify({ ok: true, result: { healthy: true, processIdentity: identity } }))
  })

  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const endpoint = `http://127.0.0.1:${server.address().port}/provider/${"a".repeat(64)}`
  await writeFile(path.join(stateDir, "native-provider-" + createHash("sha256")
    .update(process.execPath + "\0" + identity.profileRoot).digest("hex") + ".json"),
  JSON.stringify({ version: 1, endpoint, processIdentity: identity }), { mode: 0o600 })
  const result = await prepareNativeMessaging({
    update: true, declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform,
    homeDir, root, mcpRoot, env: fixtureEnv(homeDir),
    installer: async () => { throw new Error("ordinary installer must not replace deliberate update") },
    updater: async options => {
      assert.equal(attested, true)
      assert.equal(options.providerEndpoint, endpoint)
      assert.deepEqual(options.expectedProcessIdentity, identity)
      return { updated: true, reconciliationRequired: true }
    },
  })
  assert.equal(result.updated, true)
  assert.equal(result.reconciliationRequired, true)
  assert.equal(JSON.stringify(result).includes("a".repeat(64)), false)
  assert.equal(result.providerEndpoint, undefined)
})

test("unchanged extension digest cannot hide an older native runtime capsule", async t => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-running-runtime-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({
    profile: { info_cache: { Default: { user_name: "fixture@example.test" } } },
  }))
  const stateDir = path.join(homeDir, "state")
  await mkdir(stateDir, { mode: 0o700 })
  let attestations = 0
  const server = http.createServer((request, response) => {
    attestations++
    response.end(JSON.stringify({ ok: true, result: { healthy: true } }))
  })
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const endpoint = `http://127.0.0.1:${server.address().port}/provider/${"a".repeat(64)}`
  const profileRoot = path.join(userDataRoot, "Default")
  const digest = "c".repeat(64)
  await writeFile(path.join(stateDir, "native-provider-" +
    createHash("sha256").update(process.execPath + "\0" + profileRoot).digest("hex") + ".json"), JSON.stringify({
    version: 1, processIdentity: { executable: process.execPath, profileRoot },
    endpoint, extensionSourceDigest: digest,
    mediationChain: [
      { executable: path.join(homeDir, "old-runtime/entry"), profileRoot: path.join(homeDir, "old-runtime") },
      { executable: process.execPath, profileRoot: path.join(homeDir, "old-runtime") },
    ],
  }), { mode: 0o600 })
  const result = await prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir,
    root: path.join(homeDir, "owned"), mcpRoot, env: fixtureEnv(homeDir),
    installer: async () => ({ stateDir, extensionSourceDigest: digest,
      executable: path.join(homeDir, "new-runtime/entry"), runtimeDirectory: path.join(homeDir, "new-runtime") }),
  })
  assert.equal(result.payload?.code, "browser_native_messaging_update_required",
    "backend-only upgrades cannot silently continue using an older native provider")
  assert.equal(result.args, undefined)
  assert.equal(attestations, 0, "a known source mismatch is refused before acquisition or browser effects")
})
