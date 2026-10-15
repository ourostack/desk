import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import os from "node:os"
import { syncBuiltinESMExports } from "node:module"
import * as path from "node:path"

import {
  controllerIdentity,
} from "../../../../../plugins/desk/mcp/src/readiness/identity.js"

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
    t.mock.method(os, "userInfo", () => ({ uid: platform === "win32" ? -1 : 501, username: "legacy-owner" }))
    syncBuiltinESMExports()
    t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports() })
    assert.deepEqual(controllerIdentity({ root: import.meta.dirname }).user, {
      uid: platform === "win32" ? -1 : 501, username: "legacy-owner",
    })
    noNss(t)
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
