// While a build owns the index, its controller removes vectors no section can use on its own timer, without waiting for a catch-up, in transactions of bounded size. A build standing aside for a higher one removes nothing.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, mkdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { setTimeout as sleep } from "node:timers/promises"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { startReadinessController } from "../../../../../plugins/desk/mcp/src/readiness/controller-server.js"
import { closeDb, openDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { removeUnusableVectors } from "../../../../../plugins/desk/mcp/src/indexer/text-vectors.js"
import { makeEmbedFetch, writeFile } from "../tools/_search_helpers.js"
import { mkTempRoot } from "../_temp_roots.js"

async function desk() {
  const root = await fs.realpath(await mkTempRoot("desk-vector-cleanup-"))
  const stateHome = path.join(root, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  await writeFile(root, "track/a/task.md", "---\nstatus: processing\n---\nquartz cleanup card\n")
  return { root, stateHome }
}

async function controllerFor(t, { root, stateHome }, handlers) {
  const controller = await connectOrStartController({
    root, stateHome, ephemeral: true, version: "1.0.0", build: "a".repeat(64),
    watcher: { fence: async () => ({ certain: true }) },
    handlers,
    startController: (options) => startReadinessController({ ...options, cleanupBusyMs: 10, cleanupIdleMs: 50 }),
  })
  t.after(() => controller.close())
  return controller
}

// The database `removeUnusableVectors` sees, recording how many rows each of its delete transactions takes.
function countingDb(db, sizes) {
  return new Proxy(db, {
    get(target, property) {
      if (property === "transaction") {
        return (body) => target.transaction((ids, ...rest) => {
          if (Array.isArray(ids)) sizes.push(ids.length)
          return body(ids, ...rest)
        })
      }
      const value = Reflect.get(target, property)
      return typeof value === "function" ? value.bind(target) : value
    },
  })
}

const orphanCount = (root) => {
  const db = openDb(root)
  try {
    return db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs v WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = v.chunk_id)").get().n
  } finally { closeDb(db) }
}

test("the owner removes old-table vectors left by older builds on its own timer, without a catch-up, in bounded batches", async (t) => {
  const fixture = await desk()
  const calls = { converged: 0, rounds: 0 }
  const sizes = []
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() {
      calls.converged += 1
      return { summary: await rebuildIndex(fixture.root, { vectorCleanup: false, embed: { fetch: makeEmbedFetch() } }) }
    },
    async cleanupVectors() {
      calls.rounds += 1
      const db = openDb(fixture.root)
      try {
        return await removeUnusableVectors(countingDb(db, sizes), { scanLimit: 300, batchSize: 100, pauseMs: 1 })
      } finally { closeDb(db) }
    },
  })
  await controller.beginConvergence()
  await controller.barrier({ capability: "lexical", wait: true })

  // An older build re-indexed a card and saved its vectors by row onto rows that are already gone.
  const db = openDb(fixture.root)
  try {
    const insert = db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)")
    db.transaction(() => { for (let id = 1_000_000; id < 1_001_000; id += 1) insert.run(BigInt(id), new Float32Array(768).fill(0.5)) })()
  } finally { closeDb(db) }
  const roundsBefore = calls.rounds

  for (let waited = 0; waited < 10_000 && orphanCount(fixture.root) > 0; waited += 20) await sleep(20)
  assert.equal(orphanCount(fixture.root), 0, "the timer removed every vector whose row is gone")
  assert.equal(calls.converged, 1, "no catch-up ran")
  assert.ok(calls.rounds - roundsBefore >= 4, `each round takes at most 300, so it took several (${calls.rounds - roundsBefore})`)
  assert.ok(sizes.length >= 10 && sizes.every((size) => size <= 100), `every delete transaction took at most 100 rows (${sizes.join(" ")})`)
})

test("a build standing aside for a higher one runs no cleanup", async (t) => {
  const fixture = await desk()
  // A running controller of a newer Desk build beside this one.
  const folder = path.join(fixture.stateHome, "e".repeat(64))
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(folder, "owner.json"), JSON.stringify({
    identity: { root: fixture.root, build: "f".repeat(64) },
    owner: { pid: process.pid, token: "newer-owner", started_at: new Date().toISOString() },
    desk_version: "99.0.0",
  }))
  let rounds = 0
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() { throw new Error("the lower build must not write") },
    async cleanupVectors() { rounds += 1; return { complete: true } },
  })
  await controller.beginConvergence()
  await controller.barrier({ capability: "lexical", wait: true })
  await sleep(200)
  assert.equal(rounds, 0)
})

test("a round due during a catch-up waits for it, and runs nothing once a higher build owns the index", async (t) => {
  const fixture = await desk()
  let rounds = 0
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() {
      return { summary: await rebuildIndex(fixture.root, { vectorCleanup: false, skipEmbed: true }) }
    },
    async verifyIndex() {
      await sleep(300)
      throw new Error("the owner's index could not be read")
    },
    async cleanupVectors() { rounds += 1; return { complete: true } },
  })
  await controller.beginConvergence()
  await controller.barrier({ capability: "lexical", wait: true })
  for (let waited = 0; waited < 5_000 && rounds === 0; waited += 10) await sleep(10)
  assert.ok(rounds > 0, "the owner ran a round")

  // A newer build starts; at the next catch-up this build stands aside, and the round that fell due meanwhile does nothing.
  const folder = path.join(fixture.stateHome, "e".repeat(64))
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  writeFileSync(path.join(folder, "owner.json"), JSON.stringify({
    identity: { root: fixture.root, build: "f".repeat(64) },
    owner: { pid: process.pid, token: "newer-owner", started_at: new Date().toISOString() },
    desk_version: "99.0.0",
  }))
  const before = rounds
  await controller.beginConvergence().catch(() => {})
  await sleep(500)
  assert.equal(rounds, before)
})

test("a catch-up that ends while a cleanup round runs does not start a second round beside it", async (t) => {
  const fixture = await desk()
  let rounds = 0
  let running = 0
  let most = 0
  let release
  const held = new Promise((resolve) => { release = resolve })
  let started
  const firstRound = new Promise((resolve) => { started = resolve })
  const controller = await controllerFor(t, fixture, {
    async beginConvergence() {
      return { summary: await rebuildIndex(fixture.root, { vectorCleanup: false, skipEmbed: true }) }
    },
    async cleanupVectors() {
      rounds += 1
      running += 1
      most = Math.max(most, running)
      started()
      if (rounds === 1) await held
      running -= 1
      return { complete: true }
    },
  })
  await controller.beginConvergence()
  await controller.barrier({ capability: "lexical", wait: true })
  await firstRound

  // A catch-up starts and ends while the first round is still deleting.
  await controller.beginConvergence()
  await sleep(100)
  assert.equal(rounds, 1, "no second round started while the first ran")
  release()
  for (let waited = 0; waited < 5_000 && rounds < 2; waited += 10) await sleep(10)
  assert.ok(rounds >= 2, "the timer ran again after the first round finished")
  assert.equal(most, 1, "rounds never overlapped")
})
