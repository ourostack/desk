import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  controllerIdentity,
  lexicalControllerIdentity,
  stableStringify,
} from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { readinessContracts, sourceMirrorBuild } from "../../../../../plugins/desk/mcp/src/readiness/contracts.js"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"

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
