// A controller that another, higher-ranked Desk build's controller outranks stands aside: it writes nothing, checks the owner's index, and looks again only after a bounded pause. A cleanup refused because another build committed different content is retried the same way.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, mkdirSync, statSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { startReadinessController } from "../../../../../plugins/desk/mcp/src/readiness/controller-server.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"
import { indexDbPath } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { closeDb, openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { connectOrStartController as connectRuntime, startControllerRuntime } from "../../../../../plugins/desk/mcp/src/server.js"
import { verifyIndexCoversDesk } from "../../../../../plugins/desk/mcp/src/server-helpers.js"
import { makeEmbedFetch, writeFile } from "../tools/_search_helpers.js"
import { mkTempRoot } from "../_temp_roots.js"

const SEMANTIC = { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC }
const OWNER_FOLDER = "e".repeat(64)

async function desk() {
  const root = await fs.realpath(await mkTempRoot("desk-stand-aside-"))
  const stateHome = path.join(root, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  return { root, stateHome }
}

// A running controller of a newer Desk build beside this one: its owner record names this process, so it counts as running.
function newerOwnerBeside({ root, stateHome }) {
  mkdirSync(path.join(stateHome, OWNER_FOLDER), { recursive: true, mode: 0o700 })
  writeFileSync(path.join(stateHome, OWNER_FOLDER, "owner.json"), JSON.stringify({
    identity: { root, build: "f".repeat(64) },
    owner: { pid: process.pid, token: "newer-owner", started_at: new Date().toISOString() },
    desk_version: "99.0.0",
  }))
}

async function controllerFor(t, { root, stateHome }, handlers, { retryDelaysMs = [1], semanticContract = null } = {}) {
  const controller = await connectOrStartController({
    root, stateHome, ephemeral: true, version: "1.0.0", build: "a".repeat(64), ...(semanticContract ? { semanticContract } : {}),
    watcher: { fence: async () => ({ certain: true }) },
    handlers,
    startController: (options) => startReadinessController({ ...options, retryDelaysMs }),
  })
  t.after(() => controller.close())
  return controller
}

test("a lower build with no way to check the owner's index stands aside and stops looking", async (t) => {
  const fixture = await desk()
  newerOwnerBeside(fixture)
  const calls = { converged: 0 }
  const controller = await controllerFor(t, fixture, { async beginConvergence() { calls.converged += 1; return { indexed: true } } })
  await controller.beginConvergence()
  const settled = await controller.barrier({ capability: "lexical", wait: true })
  assert.equal(settled.current, false)
  assert.equal(settled.reason, "index_owned_by_newer_desk")
  assert.equal(calls.converged, 0, "the lower build wrote nothing")
  const status = await controller.status()
  assert.deepEqual(status.index_owner, { version: "99.0.0", build: "f".repeat(64), this_controller: false })
  assert.equal(status.convergence.status, "succeeded", "no retry is pending")
})

test("a lower build whose owner has not caught up looks again a bounded number of times, and a new catch-up starts the count over", async (t) => {
  const fixture = await desk()
  newerOwnerBeside(fixture)
  const calls = { verified: 0 }
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() { throw new Error("the lower build must not write") },
    async verifyIndex() { calls.verified += 1; return { verified: false, same_settings: true, content: "sha256:other", semantic: null } },
  }, { retryDelaysMs: [1, 1] })
  await controller.beginConvergence()
  const settled = await controller.barrier({ capability: "lexical", wait: true })
  assert.equal(settled.reason, "index_owner_catching_up")
  assert.equal(calls.verified, 3, "one check, then one per pause")
  await controller.beginConvergence()
  await controller.barrier({ capability: "lexical", wait: true })
  assert.equal(calls.verified, 6, "the pauses start over")
})

test("a lower build reads the owner's index at once and keeps checking while the owner embeds", async (t) => {
  const fixture = await desk()
  newerOwnerBeside(fixture)
  const calls = { verified: 0 }
  const controller = await controllerFor(t, fixture, {
    async verifyIndex() {
      calls.verified += 1
      return { verified: true, same_settings: true, content: "sha256:owner", semantic: { chunks_total: 2, vectors_indexed: 1, missing_vectors: 1, provenance_current: true } }
    },
  }, { retryDelaysMs: [60_000], semanticContract: SEMANTIC })
  await controller.beginConvergence()
  // An exact-word wait does not sit out the pause before the next check.
  const lexical = await controller.barrier({ capability: "lexical", wait: true })
  assert.equal(lexical.current, true)
  const status = await controller.status()
  assert.equal(status.convergence.status, "pending")
  assert.equal(status.freshness.content, "sha256:owner")
  assert.equal(calls.verified, 1)
})

test("a cleanup refused by another build's different commit is retried after a pause, and a wait sits the pause out", async (t) => {
  const fixture = await desk()
  const calls = { converged: 0 }
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() {
      calls.converged += 1
      if (calls.converged < 3) throw Object.assign(new Error("superseded"), { code: "generation_superseded" })
      return { indexed: true, content: "sha256:own" }
    },
  // Each pause outlasts the wait's arrival: the wait sits out the first pause, sees the second try fail, and sits out the next pause too.
  }, { retryDelaysMs: [200, 200] })
  await controller.beginConvergence().catch(() => {})
  const settled = await controller.barrier({ capability: "lexical", wait: true })
  assert.equal(settled.current, true)
  assert.equal(calls.converged, 3)
})

test("a cleanup refused every time stops after the last pause, and the waiting search hears why", async (t) => {
  const fixture = await desk()
  const calls = { converged: 0 }
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() {
      calls.converged += 1
      throw Object.assign(new Error("superseded"), { code: "generation_superseded" })
    },
  // The pause outlasts the wait's arrival, so the wait sits it out and sees the last try fail.
  }, { retryDelaysMs: [200] })
  await controller.beginConvergence().catch(() => {})
  await assert.rejects(controller.barrier({ capability: "lexical", wait: true }), (error) => /superseded/.test(`${error.code} ${error.message}`))
  assert.equal(calls.converged, 2)
  assert.equal((await controller.status()).convergence.status, "failed")
})

test("an index the controller cannot read after its catch-up leaves its content unknown", async (t) => {
  const fixture = await desk()
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() {
      mkdirSync(path.dirname(indexDbPath(fixture.root)), { recursive: true })
      writeFileSync(indexDbPath(fixture.root), "not a database")
      return { indexed: true, summary: { lexical_generation: 1 } }
    },
  })
  await controller.beginConvergence()
  const settled = await controller.barrier({ capability: "lexical", wait: true })
  assert.equal(settled.current, true)
  assert.equal((await controller.status()).freshness.content, null)
})

// The production handler, run in this process: a newer build's controller runs beside it, so it only checks the owner's index.
async function runtimeFor(t, fixture, policy) {
  const controller = await connectRuntime({ deskRoot: fixture.root, stateHome: fixture.stateHome, ephemeral: true, policy, controllerLauncher: startControllerRuntime })
  t.after(() => controller.close())
  return controller
}

test("the production check of the owner's index writes nothing and reads how far it is", async (t) => {
  const fetch = globalThis.fetch
  globalThis.fetch = makeEmbedFetch()
  t.after(() => { globalThis.fetch = fetch })
  // No index yet: the owner has not caught up, and there is nothing to embed.
  const empty = await desk()
  newerOwnerBeside(empty)
  await writeFile(empty.root, "track/one/task.md", "---\nstatus: processing\nschema_version: 1\n---\nquartz rollout\n")
  const before = await runtimeFor(t, empty, { lexical: "required", semantic: "background" })
  await before.beginConvergence()
  const unchecked = await before.status()
  assert.equal(unchecked.freshness.reason, "index_owner_catching_up", JSON.stringify(unchecked.freshness))
  assert.equal(fsExists(empty.root), false, "the lower build created no index")

  for (const semantic of ["unsupported", "background"]) {
    const fixture = await desk()
    newerOwnerBeside(fixture)
    await writeFile(fixture.root, "track/one/task.md", "---\nstatus: processing\nschema_version: 1\n---\nquartz rollout\n")
    const db = openDb(fixture.root)
    try { await rebuildIndex(fixture.root, { db, skipEmbed: true }) } finally { closeDb(db) }
    const controller = await runtimeFor(t, fixture, { lexical: "required", semantic })
    await controller.beginConvergence()
    const status = await controller.status()
    assert.equal(status.index_owner.this_controller, false, semantic)
    assert.equal(status.index_owner.version, "99.0.0", semantic)
  }
})

function fsExists(root) {
  try { return statSync(indexDbPath(root)).isFile() } catch { return false }
}

test("the check of the owner's index refuses an unreadable tombstone ledger", async () => {
  const fixture = await desk()
  const pluginRoot = path.join(fixture.root, "plugin")
  mkdirSync(path.join(pluginRoot, "artifacts", "tombstones"), { recursive: true })
  writeFileSync(path.join(pluginRoot, "artifacts", "tombstones", "tombstones.jsonl"), "not json\n")
  await assert.rejects(verifyIndexCoversDesk(fixture.root, { tombstones: { pluginRoot } }), { code: "artifact_tombstone_ledger_invalid" })
})

test("status names the owner as it is now: a newer build that starts after this one's catch-up", async (t) => {
  const fixture = await desk()
  const controller = await controllerFor(t, fixture, { async beginConvergence() { return { indexed: true } } })
  assert.deepEqual((await controller.status()).index_owner, { version: "1.0.0", build: "a".repeat(64), this_controller: true }, "known before any catch-up")
  await controller.beginConvergence()
  await controller.barrier({ capability: "lexical", wait: true })
  newerOwnerBeside(fixture)
  assert.deepEqual((await controller.status()).index_owner, { version: "99.0.0", build: "f".repeat(64), this_controller: false }, "no catch-up ran since the newer build started")
})

test("status names this session once the owner's session ends, and this build takes the index over", async (t) => {
  const fixture = await desk()
  newerOwnerBeside(fixture)
  const calls = { converged: 0 }
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() { calls.converged += 1; return { indexed: true } },
    async verifyIndex() { return { verified: false, same_settings: false, content: "sha256:other", semantic: null } },
  })
  await controller.beginConvergence()
  assert.equal((await controller.barrier({ capability: "lexical", wait: true })).reason, "index_owned_by_newer_desk")
  assert.equal((await controller.status()).index_owner.this_controller, false)
  // The owner's session ends: its owner record goes away.
  await fs.rename(path.join(fixture.stateHome, OWNER_FOLDER, "owner.json"), path.join(fixture.stateHome, OWNER_FOLDER, "ended.json"))
  assert.equal((await controller.status()).index_owner.this_controller, true)
  const settled = await controller.barrier({ capability: "lexical", wait: true })
  assert.equal(settled.current, true, "this build caught up without waiting for a desk change")
  assert.equal(calls.converged, 1)
})
