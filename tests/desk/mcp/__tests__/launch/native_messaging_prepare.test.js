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
    readyWait: { waitMs: 50, pollMs: 10 },
  })
  assert.equal(result.payload.code, "browser_native_messaging_setup_required")
  assert.match(result.payload.summary, /\(the provider's readiness file .+ is missing\)$/u, "the summary names the missing file")
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

test("extension source that no Desk release shipped is refused rather than driven", async () => {
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
  assert.match(result.payload.fix, /cannot verify/u)
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

test("a deliberate update while the provider is not running names it, with the readiness file", async () => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-messaging-update-not-running-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { user_name: "fixture@example.test" } } } }))
  const result = await prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir,
    root: path.join(homeDir, "owned"), mcpRoot, env: fixtureEnv(homeDir), update: true, readyWait: { waitMs: 50, pollMs: 10 },
    updater: async () => assert.fail("no update without a running provider"),
  })
  assert.equal(result.payload.code, "browser_native_provider_not_running")
  assert.match(result.payload.summary, /native-owned[\\/]state[\\/]native-provider-[a-f0-9]{64}\.json is missing\.$/u)
})

// Windows reports a file standing where a folder belongs as missing, so only POSIX can tell the two apart.
test("a deliberate update with an unreadable readiness path reports that failure, not a stopped provider", { skip: process.platform === "win32" }, async () => {
  const { prepareNativeMessaging } = await import(moduleUrl)
  const homeDir = await mkTempRoot("native-messaging-update-unreadable-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { user_name: "fixture@example.test" } } } }))
  await mkdir(path.join(homeDir, "owned"), { recursive: true })
  await writeFile(path.join(homeDir, "owned", "native-owned"), "a file where the state folder belongs")
  await assert.rejects(prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir,
    root: path.join(homeDir, "owned"), mcpRoot, env: fixtureEnv(homeDir), update: true, readyWait: { waitMs: 50, pollMs: 10 },
  }), error => error.code === "ENOTDIR")
})

// Several Desk copies share one browser. A session never refuses the provider and extension the browser runs: it uses them, and an
// update is pending only when this copy is newer than what runs.
async function loadedScenario(t, { loaded = { capsule: "1".repeat(64), extension: "d".repeat(64) }, versions, ownVersion = "3.2.0-alpha.400",
  loadedRuntimeOutside = false } = {}) {
  const homeDir = await mkTempRoot("native-loaded-")
  const userDataRoot = fixtureProfile(homeDir)
  await mkdir(userDataRoot, { recursive: true })
  await writeFile(path.join(userDataRoot, "Local State"), JSON.stringify({ profile: { info_cache: { Default: { user_name: "fixture@example.test" } } } }))
  const root = path.join(homeDir, "owned")
  const owned = path.join(root, "native-owned")
  const stateDir = path.join(owned, "state")
  await mkdir(stateDir, { recursive: true, mode: 0o700 })
  if (versions) await writeFile(path.join(owned, "versions.json"), JSON.stringify({ version: 1, ...versions }), { mode: 0o600 })
  const profileRoot = path.join(userDataRoot, "Default")
  const identity = { executable: process.execPath, profileRoot, pid: 42, startIdentity: "browser" }
  const server = http.createServer((request, response) => response.end(JSON.stringify({ ok: true, result: { healthy: true, processIdentity: identity } })))
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const loadedRuntime = loadedRuntimeOutside ? path.join(homeDir, "elsewhere", loaded.capsule) : path.join(owned, "runtimes", loaded.capsule)
  await writeFile(path.join(stateDir, "native-provider-" + createHash("sha256").update(process.execPath + "\0" + profileRoot).digest("hex") + ".json"),
    JSON.stringify({ version: 1, processIdentity: identity, endpoint: `http://127.0.0.1:${server.address().port}/provider/${"a".repeat(64)}`,
      extensionSourceDigest: loaded.extension, mediationChain: [
        { executable: path.join(loadedRuntime, "desk-browser-messaging"), profileRoot: loadedRuntime },
        { executable: process.execPath, profileRoot: loadedRuntime },
      ] }), { mode: 0o600 })
  const ownRuntime = path.join(owned, "runtimes", "2".repeat(64))
  const { prepareNativeMessaging } = await import(moduleUrl)
  return prepareNativeMessaging({
    declaration: { channel: "msedge", domain: "example.test" }, installed: { dir: "/installed" },
    executable: process.execPath, runtimeExecutable: process.execPath, platform: process.platform, homeDir, root, mcpRoot,
    env: fixtureEnv(homeDir),
    installer: async () => ({ stateDir, extensionSourceDigest: "c".repeat(64), deskVersion: ownVersion,
      executable: path.join(ownRuntime, "desk-browser-messaging"), runtimeDirectory: ownRuntime }),
  })
}

test("a session on a newer Desk copy uses the provider the browser runs and marks the update pending", async t => {
  const result = await loadedScenario(t)
  assert.equal(result.payload, undefined, "never update_required")
  assert.ok(result.providerEndpoint)
  assert.equal(result.updatePending, true)
})

test("a session on an older Desk copy uses the newer provider the browser runs and never updates it", async t => {
  const result = await loadedScenario(t, { ownVersion: "3.2.0-alpha.300",
    versions: { capsules: { ["1".repeat(64)]: "3.2.0-alpha.400" }, extensions: { ["d".repeat(64)]: "3.2.0-alpha.400" } } })
  assert.equal(result.payload, undefined)
  assert.equal(result.updatePending, false)
})

test("a loaded provider that does not run from this installation's runtimes is refused", async t => {
  const result = await loadedScenario(t, { loadedRuntimeOutside: true })
  assert.equal(result.payload.code, "browser_native_messaging_unavailable")
})
