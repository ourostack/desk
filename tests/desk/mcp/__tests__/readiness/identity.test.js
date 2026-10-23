import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import os from "node:os"
import { syncBuiltinESMExports } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  controllerIdentity,
  lexicalControllerIdentity,
  stableStringify,
} from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { readinessContracts, sourceMirrorBuild } from "../../../../../plugins/desk/mcp/src/readiness/contracts.js"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"

function environment(t, key, value) {
  const previous = process.env[key]
  process.env[key] = value
  t.after(() => {
    if (previous === undefined) delete process.env[key]
    else process.env[key] = previous
  })
}

function privateKernel(t, { marker = "1", platform = "linux", uid = () => 19071, euid = () => 19071 } = {}) {
  environment(t, "DESK_ISOLATED_HOSTED", marker)
  for (const [key, value] of Object.entries({ platform, getuid: uid, geteuid: euid })) {
    const descriptor = Object.getOwnPropertyDescriptor(process, key)
    Object.defineProperty(process, key, { configurable: true, value })
    t.after(() => {
      if (descriptor) Object.defineProperty(process, key, descriptor)
      else delete process[key]
    })
  }
}

function noNss(t) {
  t.mock.method(os, "userInfo", () => {
    throw Object.assign(new Error("uv_os_get_passwd ENOENT"), { code: "ERR_SYSTEM_ERROR" })
  })
  syncBuiltinESMExports()
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
}

test("private controller admits matching kernel ownership without an NSS account", (t) => {
  privateKernel(t)
  noNss(t)
  const options = { root: import.meta.dirname, protocolVersion: 1, lexicalContract: { schema: 1 } }
  const first = controllerIdentity(options)
  assert.deepEqual(first.user, { uid: 19071, username: "isolated-kernel" })
  assert.equal(Object.isFrozen(first.user), true)
  environment(t, "UID", "99999")
  environment(t, "USER", "foreign-human")
  environment(t, "HOME", "/foreign-account")
  assert.equal(controllerIdentity(options).id, first.id, "account-like environment cannot change kernel ownership")
  Object.defineProperty(process, "getuid", { configurable: true, value: () => 19072 })
  Object.defineProperty(process, "geteuid", { configurable: true, value: () => 19072 })
  const other = controllerIdentity(options)
  assert.equal(other.user.uid, 19072)
  assert.notEqual(other.id, first.id)
})

for (const [name, observations] of [
  ["missing uid", { uid: null }],
  ["missing euid", { euid: null }],
  ["throwing uid", { uid: () => { throw new Error("unavailable") } }],
  ["throwing euid", { euid: () => { throw new Error("unavailable") } }],
  ["mismatched", { euid: () => 19072 }],
  ...[undefined, null, "19071", NaN, Infinity, -1, 0, 1.5, 2 ** 32, Number.MAX_SAFE_INTEGER + 1].flatMap((value) => [
    [`invalid uid ${String(value)}`, { uid: () => value }],
    [`invalid euid ${String(value)}`, { euid: () => value }],
  ]),
  ["unsupported Windows", { platform: "win32" }],
  ["unsupported macOS", { platform: "darwin" }],
]) {
  test(`private controller explicitly refuses ${name}`, (t) => {
    privateKernel(t, observations)
    noNss(t)
    assert.throws(() => controllerIdentity({ root: import.meta.dirname }), {
      code: "DESK_CONTROLLER_KERNEL_IDENTITY_INVALID",
    })
  })
}

for (const platform of ["linux", "win32"]) {
  test(`marker-off ${platform} retains NSS identity and failure semantics`, (t) => {
    privateKernel(t, { marker: "0", platform, uid: () => { throw new Error("kernel must not be read") } })
    // One mock whose behavior changes: a second mock of the same method restores to the first, leaving os.userInfo mocked for later tests.
    const userInfo = t.mock.method(os, "userInfo", () => ({ uid: platform === "win32" ? -1 : 501, username: "legacy-owner" }))
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    assert.deepEqual(controllerIdentity({ root: import.meta.dirname }).user, {
      uid: platform === "win32" ? -1 : 501, username: "legacy-owner",
    })
    userInfo.mock.mockImplementation(() => {
      throw Object.assign(new Error("uv_os_get_passwd ENOENT"), { code: "ERR_SYSTEM_ERROR" })
    })
    syncBuiltinESMExports()
    assert.throws(() => controllerIdentity({ root: import.meta.dirname }), /uv_os_get_passwd ENOENT/)
  })
}

test("controller identity canonicalizes path aliases and compatibility contracts", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-identity-"))
  const other = path.join(root, "other")
  const alias = path.join(root, "alias")
  mkdirSync(other)
  try {
    symlinkSync(other, alias, "junction")
    const lexicalContract = {
      schema: 1,
      chunker: "markdown-v1",
      normalization: "unicode-v1",
    }
    const direct = controllerIdentity({
      root: other,
      protocolVersion: 1,
      lexicalContract,
    })
    const throughAlias = controllerIdentity({
      root: alias,
      protocolVersion: 1,
      lexicalContract,
    })
    assert.equal(direct.id, throughAlias.id)
    assert.equal(direct.root, throughAlias.root)
    assert.notEqual(
      direct.id,
      controllerIdentity({
        root,
        protocolVersion: 1,
        lexicalContract,
      }).id,
    )
    assert.notEqual(
      direct.id,
      controllerIdentity({
        root: other,
        protocolVersion: 2,
        lexicalContract,
      }).id,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})


test("controllers for different Desk builds get different identities", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-identity-build-"))
  try {
    const policy = { lexical: "required" }
    const older = controllerIdentity({ root, ...readinessContracts(policy, { build: "a".repeat(64) }) })
    const newer = controllerIdentity({ root, ...readinessContracts(policy, { build: "b".repeat(64) }) })
    assert.equal(older.build, "a".repeat(64))
    assert.equal(newer.build, "b".repeat(64))
    assert.notEqual(older.id, newer.id, "a different build elects its own controller")
    assert.notEqual(
      stableStringify(lexicalControllerIdentity(older)),
      stableStringify(lexicalControllerIdentity(newer)),
      "the rendezvous socket name derives from this, so it differs too",
    )
    // A run without a source mirror (tests, development) has no build and still gets one stable identity.
    const unbuilt = controllerIdentity({ root, ...readinessContracts(policy) })
    assert.equal(unbuilt.build, null)
    assert.equal(unbuilt.id, controllerIdentity({ root, ...readinessContracts(policy) }).id)
    assert.notEqual(unbuilt.id, older.id)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the same build on the same root shares one controller", async (t) => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-identity-share-"))
  const stateHome = path.join(root, "state")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const build = "c".repeat(64)
  const policy = { lexical: "required" }
  const first = controllerIdentity({ root, ...readinessContracts(policy, { build }) })
  assert.equal(first.id, controllerIdentity({ root, ...readinessContracts(policy, { build }) }).id)

  const current = await connectOrStartController({ root, stateHome, ephemeral: true, ...readinessContracts(policy, { build }) })
  t.after(() => current.close())
  const joined = await connectOrStartController({ root, stateHome, ephemeral: true, ...readinessContracts(policy, { build }) })
  t.after(() => joined.close())
  const other = await connectOrStartController({ root, stateHome, ephemeral: true, ...readinessContracts(policy, { build: "d".repeat(64) }) })
  t.after(() => other.close())
  const owner = async (client) => (await client.status()).owner.token
  assert.equal(joined.id, current.id)
  assert.equal(await owner(joined), await owner(current), "the same build joins the running controller")
  assert.notEqual(other.id, current.id)
  assert.notEqual(await owner(other), await owner(current), "another build elects its own controller")
  assert.equal((await current.status()).state, "CONTROL_READY", "the other build's controller is left alone and keeps answering")
})

test("the running build is the source mirror's digest, and nothing outside a mirror", () => {
  const digest = "0123456789abcdef".repeat(4)
  assert.equal(sourceMirrorBuild(path.join("/cache", "desk", "1.0.0", "darwin", "x", "source-mirror", digest)), digest)
  assert.equal(sourceMirrorBuild(path.join("/cache", "source-mirror", digest) + path.sep), digest)
  assert.equal(sourceMirrorBuild(path.join("/plugins", "desk", "mcp")), null)
  assert.equal(sourceMirrorBuild(path.join("/cache", "source-mirror", "not-a-digest")), null)
  assert.equal(sourceMirrorBuild(null), null)
  assert.equal(sourceMirrorBuild(undefined), null)
})

test("the runtime server elects the controller of the build it was loaded from", async (t) => {
  const server = await import("../../../../../plugins/desk/mcp/src/server.js")
  const mcpRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../plugins/desk/mcp")
  assert.equal(server.RUNNING_BUILD, sourceMirrorBuild(mcpRoot), "a source checkout has no build; a mirror has its digest")
  const root = mkdtempSync(path.join(tmpdir(), "desk-identity-server-"))
  const stateHome = path.join(root, "state")
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const identities = []
  const controllerLauncher = async (options) => { identities.push(options.identity); throw new Error("launcher stops here") }
  const policy = { lexical: "required", semantic: "unsupported" }
  await assert.rejects(server.connectOrStartController({ deskRoot: root, policy, stateHome, ephemeral: true, controllerLauncher }), /launcher stops here/u)
  await assert.rejects(server.connectOrStartController({ deskRoot: root, policy, stateHome, ephemeral: true, controllerLauncher, build: "9".repeat(64) }), /launcher stops here/u)
  assert.equal(identities[0].build, server.RUNNING_BUILD)
  assert.equal(identities[1].build, "9".repeat(64))
  assert.notEqual(identities[0].id, identities[1].id)
})
