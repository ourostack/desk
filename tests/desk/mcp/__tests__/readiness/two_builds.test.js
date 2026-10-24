// Two Desk builds on one desk: each elects its own controller, but both write the one search index in the desk. A newer build whose controller finds the index last written by the other build reconciles it again on its own, without re-embedding vectors that are still valid, instead of refusing meaning-based search until the next file change. Builds that record who wrote the index agree on one owner, so they never take it from each other on every query.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, mkdirSync } from "node:fs"
import * as path from "node:path"
import { desk_recall, desk_search } from "../../../../../plugins/desk/mcp/src/tools/search.js"
import { createDeskQueryRouter, createQueryRouter } from "../../../../../plugins/desk/mcp/src/readiness/query-router.js"
import { RETAINED_LEXICAL_GENERATIONS } from "../../../../../plugins/desk/mcp/src/readiness/generations.js"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { controllerIdentity } from "../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { readinessContracts } from "../../../../../plugins/desk/mcp/src/readiness/contracts.js"
import { openDb, closeDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"
import { getSemanticCoverage, verifyIndexCoversDesk } from "../../../../../plugins/desk/mcp/src/server-helpers.js"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"
import { desk_reindex } from "../../../../../plugins/desk/mcp/src/tools/reindex.js"
import { compactStatus } from "../../../../../plugins/desk/mcp/src/runtime/status-compact.js"
import { makeEmbedFetch, mkTempDeskRoot, writeFile } from "../tools/_search_helpers.js"

// An embedding service that counts the document texts it is asked to embed.
function countingEmbed() {
  const fetch = makeEmbedFetch()
  const counter = { documents: 0 }
  counter.fetch = async (url, options) => {
    counter.documents += 1
    return fetch(url, options)
  }
  return counter
}

// `version` set: a build with the writer record, as the production handler in server.js passes it. Unset: an older alpha that records no writer. `policy` indexes under other settings, so the generation's content differs from the other build's even for the same files.
async function controllerFor(t, root, stateHome, build, embed, { version, policy, converged = { count: 0 }, verified = { count: 0 }, before = async () => {}, between = async () => {}, after = async () => {} } = {}) {
  const contracts = { ...readinessContracts({ lexical: "required" }, { build }), semanticContract: { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC } }
  // The production handler records the writing controller's identity id, which names its state folder.
  const id = controllerIdentity({ root, ...contracts }).id
  const controller = await connectOrStartController({
    root, stateHome, ephemeral: true, ...contracts, ...(version ? { version } : {}),
    watcher: { fence: async () => ({ certain: true }) },
    handlers: { async beginConvergence({ eventCursor, journal }) {
      converged.count += 1
      await before()
      const summary = await rebuildIndex(root, {
        eventCursor, embed: { fetch: embed.fetch }, ...(version ? { writer: { version, build, controller: id } } : {}),
        ...(policy ? { identities: { policy_identity: policy } } : {}),
      })
      // Embedding stands between the commit and the change-log cleanup.
      await between()
      const db = openDb(root)
      try {
        await journal.compact({ db, generationId: summary.lexical_generation })
        await after()
        return { summary, semantic: { ...getSemanticCoverage(db), provenance_current: true,
          query_embedding: { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } } } }
      } finally { closeDb(db) }
    },
    // As server.js checks the owner's index when a higher build owns it; the index fixture records no vector provenance.
    async verifyIndex() {
      verified.count += 1
      const result = await verifyIndexCoversDesk(root)
      if (result.semantic !== null) {
        result.semantic = { ...result.semantic, provenance_current: true,
          query_embedding: { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } } }
      }
      return result
    } },
  })
  t.after(() => controller.close())
  return controller
}

test("a newer build reclaims the shared index the older build wrote last, without re-embedding valid vectors", async (t) => {
  const root = await fs.realpath(await mkTempDeskRoot())
  for (const name of ["one", "two", "three"]) {
    await writeFile(root, `track/${name}/task.md`, `---\nstatus: processing\nschema_version: 1\n---\nquartz rollout ${name} detail\n`)
  }
  const stateHome = path.join(root, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  const embed = countingEmbed()
  // An older build that indexed the desk the same way would leave an index the newer build reads as it is; this one used other settings.
  const older = await controllerFor(t, root, stateHome, "a".repeat(64), embed, { policy: "older-policy" })
  const newer = await controllerFor(t, root, stateHome, "b".repeat(64), embed)
  const recall = (readiness) => desk_recall({ deskRoot: root, readiness, input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })

  await newer.beginConvergence()
  assert.equal((await recall(newer)).results.length, 3, "the newer build serves meaning-based search once it converged")
  // The older build reacts to a desk change after the newer one did, and writes the index last.
  await older.beginConvergence()
  assert.equal((await older.status()).state, "READY")
  const embeddedBefore = embed.documents

  const reclaimed = await recall(newer)
  assert.equal(reclaimed.status, undefined, JSON.stringify(reclaimed))
  assert.equal(reclaimed.results.length, 3, "the newer build reconciled the index again by itself")
  assert.equal(embed.documents, embeddedBefore, "no vector that was valid under the same embedding specification was embedded again")
  assert.equal((await recall(newer)).results.length, 3, "and keeps serving it")

  // Exact-word search does not wait: it reads the files at once and asks its controller to reconcile in the background.
  await older.beginConvergence()
  const search = await desk_search({ deskRoot: root, readiness: newer, input: { query: "quartz" } })
  assert.equal(search.results.length, 3)
  await newer.barrier({ capability: "lexical", wait: true })
  const indexed = await desk_search({ deskRoot: root, readiness: newer, input: { query: "quartz" }, opts: { embed: { fetch: makeEmbedFetch() } } })
  assert.equal(indexed.readiness_diagnostic, undefined, "the background reconcile made the index the newer build's again")
  assert.equal(indexed.search_mode, "hybrid")
})

async function deskWithThreeTasks() {
  const root = await fs.realpath(await mkTempDeskRoot())
  for (const name of ["one", "two", "three"]) {
    await writeFile(root, `track/${name}/task.md`, `---\nstatus: processing\nschema_version: 1\n---\nquartz rollout ${name} detail\n`)
  }
  const stateHome = path.join(root, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  return { root, stateHome }
}

function generationRows(root) {
  const db = openDb(root)
  try {
    return {
      generations: db.prepare("SELECT COUNT(*) AS n FROM lexical_generations").get().n,
      operations: db.prepare("SELECT COUNT(*) AS n FROM readiness_operations").get().n,
    }
  } finally { closeDb(db) }
}

test("two builds that record their writer agree on one owner: only the higher one writes, and the lower one reads its index", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  // The higher version wins even with the smaller build digest: version ranks before the digest.
  const high = { build: "0".repeat(64), version: "3.2.0-alpha.343", converged: { count: 0 }, verified: { count: 0 } }
  const low = { build: "f".repeat(64), version: "3.2.0-alpha.342", converged: { count: 0 }, verified: { count: 0 } }
  high.controller = await controllerFor(t, root, stateHome, high.build, embed, high)
  low.controller = await controllerFor(t, root, stateHome, low.build, embed, low)
  const router = (side) => createDeskQueryRouter({ controller: side.controller, version: side.version })
  const recall = (side) => desk_recall({ deskRoot: root, queryRouter: router(side), input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })
  const search = (side) => desk_search({ deskRoot: root, queryRouter: router(side), input: { query: "quartz" }, opts: { embed: { fetch: makeEmbedFetch() } } })

  // The lower build catches up first, but the higher build's controller runs: it writes nothing and waits for the owner's index.
  await low.controller.beginConvergence()
  assert.equal(low.converged.count, 0, "the lower build does not write the index while the higher build runs")
  assert.equal((await low.controller.status()).freshness.reason, "index_owner_catching_up")
  await high.controller.beginConvergence()
  await low.controller.barrier({ capability: "semantic", wait: true })
  const settled = { high: high.converged.count, embedded: embed.documents, rows: generationRows(root) }

  for (let round = 0; round < 3; round += 1) {
    const served = await recall(high)
    assert.equal(served.results?.length, 3, JSON.stringify(served))
    const read = await recall(low)
    assert.equal(read.results?.length, 3, `the lower build reads the owner's index: ${JSON.stringify(read)}`)
    assert.equal((await search(low)).readiness_diagnostic, undefined, "exact-word search reads the owner's index too")
    assert.equal((await search(high)).readiness_diagnostic, undefined)
  }
  assert.equal(high.converged.count, settled.high, "alternating queries start no reconcile in the owning build")
  assert.equal(low.converged.count, 0, "nor any write by the lower build")
  assert.deepEqual(generationRows(root), settled.rows, "so no generation rows are added")
  assert.equal(embed.documents, settled.embedded)
  assert.deepEqual((await low.controller.status()).index_owner, { version: high.version, build: high.build, this_controller: false })
  assert.deepEqual((await high.controller.status()).index_owner, { version: high.version, build: high.build, this_controller: true })

  // A desk change the lower build reconciles only checks the owner's index again; it still writes nothing.
  const checks = low.verified.count
  await low.controller.beginConvergence()
  assert.equal(low.verified.count, checks + 1)
  assert.equal(low.converged.count, 0)
  assert.deepEqual(generationRows(root), settled.rows)
  assert.equal((await recall(low)).results.length, 3)

  for (let i = 0; i < RETAINED_LEXICAL_GENERATIONS; i += 1) await high.controller.beginConvergence()
  const rows = generationRows(root)
  assert.equal(rows.generations, RETAINED_LEXICAL_GENERATIONS, "generation rows stay bounded however often the owner reconciles")
  assert.equal(rows.operations, RETAINED_LEXICAL_GENERATIONS)

  // The newer session ends. The lower build keeps reading the unchanged index, and becomes the owner on its next catch-up.
  await high.controller.close()
  assert.equal((await recall(low)).results?.length, 3)
  assert.equal(low.converged.count, 0, "an unchanged index needs no write")
  await writeFile(root, "track/four/task.md", "---\nstatus: processing\nschema_version: 1\n---\nquartz rollout four detail\n")
  await low.controller.beginConvergence()
  assert.equal(low.converged.count, 1, "with no higher build running, the lower build writes the desk change")
  assert.deepEqual((await low.controller.status()).index_owner, { version: low.version, build: low.build, this_controller: true })
  assert.equal((await recall(low)).results?.length, 3)
  assert.equal(embed.documents, settled.embedded + 1, "only the new card is embedded")
})

test("taking the index back waits only for what is left of the call's deadline", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  const deadlineMs = 5_000
  const spentMs = 2_000
  let phase = "idle"
  const hold = Promise.withResolvers()
  t.after(() => hold.resolve())
  const older = await controllerFor(t, root, stateHome, "a".repeat(64), embed, { policy: "older-policy" })
  const newer = await controllerFor(t, root, stateHome, "b".repeat(64), embed, {
    version: "3.2.0-alpha.342",
    // The reclaim's own reconcile never finishes in time.
    async before() { if (phase === "reclaim") await hold.promise },
    async after() {
      if (phase !== "spend") return
      // This convergence uses up part of the call's deadline, and the older build writes the index last.
      phase = "reclaim"
      await older.beginConvergence()
      await new Promise((resolve) => setTimeout(resolve, spentMs))
    },
  })
  await newer.beginConvergence()
  let reclaimStarted = null
  const timed = Object.create(newer, {
    markUncertain: { value: (reason) => {
      if (reason === "index_written_by_other_controller") reclaimStarted = Date.now()
      return newer.markUncertain(reason)
    } },
  })
  const router = createQueryRouter({
    controller: timed,
    version: "3.2.0-alpha.342",
    semanticDeadlineMs: deadlineMs,
    semanticBackend: () => assert.fail("the reclaim does not finish within the deadline"),
  })
  phase = "spend"
  await newer.markUncertain("test_change")
  const refused = await router.semantic({ deskRoot: root, kind: "recall", topic: "quartz rollout" })
  const waited = Date.now() - reclaimStarted
  hold.resolve()
  assert.equal(refused.diagnostic.reason, "semantic_deadline", JSON.stringify(refused))
  assert.ok(reclaimStarted !== null, "the call reached the reclaim wait")
  assert.ok(waited < deadlineMs - spentMs / 2, `the reclaim wait used the rest of one deadline, not a fresh one (waited ${waited} ms)`)
})

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// Polls the controller until its meaning-based search is current, or gives up after `limitMs`.
async function readyWithin(controller, limitMs) {
  const end = Date.now() + limitMs
  while (Date.now() < end) {
    if ((await controller.barrier({ capability: "semantic" })).current === true) return true
    await sleep(25)
  }
  return false
}

test("overlapping catch-ups: the higher build becomes ready and the lower build writes nothing to the index", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  const committed = Promise.withResolvers()
  // Each catch-up pauses between its commit and its change-log cleanup, the way embedding a large card does.
  const high = { build: "0".repeat(64), version: "3.2.0-alpha.350", converged: { count: 0 },
    async between() { committed.resolve(); await sleep(150) } }
  const low = { build: "f".repeat(64), version: "3.2.0-alpha.349", converged: { count: 0 }, between: () => sleep(150) }
  high.controller = await controllerFor(t, root, stateHome, high.build, embed, high)
  low.controller = await controllerFor(t, root, stateHome, low.build, embed, low)

  // The higher build starts first; the lower build starts while the higher one is between commit and cleanup.
  void high.controller.beginConvergence().catch(() => {})
  await committed.promise
  void low.controller.beginConvergence().catch(() => {})

  assert.equal(await readyWithin(high.controller, 5_000), true,
    `the higher build became ready within 5 s (state ${(await high.controller.status()).state}, reason ${(await high.controller.status()).freshness.reason})`)
  assert.equal(low.converged.count, 0, "the lower build wrote nothing to the index")
  assert.equal(high.converged.count, 1, "so nothing undid the higher build's catch-up and it never had to start over")
  const recall = (side) => desk_recall({ deskRoot: root, queryRouter: createDeskQueryRouter({ controller: side.controller, version: side.version }),
    input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })
  const served = await recall(high)
  assert.equal(served.results?.length, 3, JSON.stringify(served))
})

test("beside an older build that keeps committing the unchanged desk, the owning build becomes ready within a bound", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  // Embedding stands between this build's commit and its change-log cleanup, long enough for the older build to commit in between.
  const high = { build: "0".repeat(64), version: "3.2.0-alpha.350", converged: { count: 0 }, between: () => sleep(100) }
  high.controller = await controllerFor(t, root, stateHome, high.build, embed, high)
  // A build from before writers were recorded: it cannot stand aside, records no writer and commits the desk under its own journal on a timer.
  const older = { commits: 0, stopped: false }
  older.loop = (async () => {
    while (!older.stopped) {
      await rebuildIndex(root, { eventCursor: { journal_id: "pre-461-journal", sequence: older.commits + 1 }, embed: { fetch: embed.fetch } })
      older.commits += 1
      await sleep(20)
    }
  })()
  t.after(async () => { older.stopped = true; await older.loop })
  await sleep(50)

  void high.controller.beginConvergence().catch(() => {})
  assert.equal(await readyWithin(high.controller, 5_000), true,
    `the owning build became ready within 5 s (reason ${(await high.controller.status()).freshness.reason})`)
  const recall = () => desk_recall({ deskRoot: root, queryRouter: createDeskQueryRouter({ controller: high.controller, version: high.version }),
    input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })
  const before = older.commits
  for (let round = 0; round < 5; round += 1) {
    const served = await recall()
    assert.equal(served.results?.length, 3, JSON.stringify(served))
    await sleep(30)
  }
  assert.ok(older.commits > before, "the older build kept committing while the owning build served")
  assert.equal(high.converged.count, 1, "and the owning build never had to catch up again")
})

test("a lower build started while a higher build runs stands aside, reads the higher build's index, and its status names the owner", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  const high = { build: "0".repeat(64), version: "3.2.0-alpha.349", converged: { count: 0 }, verified: { count: 0 } }
  const low = { build: "f".repeat(64), version: "3.2.0-alpha.348", converged: { count: 0 }, verified: { count: 0 } }
  high.controller = await controllerFor(t, root, stateHome, high.build, embed, high)
  await high.controller.beginConvergence()
  assert.equal((await high.controller.status()).state, "READY")
  const rows = generationRows(root)

  low.controller = await controllerFor(t, root, stateHome, low.build, embed, low)
  await low.controller.beginConvergence()
  assert.equal(low.converged.count, 0, "the lower build stands aside: it writes nothing")
  assert.equal(low.verified.count, 1, "it checks that the owner's index covers the desk")
  assert.equal((await low.controller.status()).state, "READY")
  assert.deepEqual(generationRows(root), rows)
  const router = (side, options = {}) => createDeskQueryRouter({ ...options, controller: side.controller, version: side.version })
  const recall = (side, options) => desk_recall({ deskRoot: root, queryRouter: router(side, options), input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })
  const read = await recall(low)
  assert.equal(read.results?.length, 3, JSON.stringify(read))
  // A reindex asked of the lower build writes nothing and says so, naming the owner.
  const reindexed = await desk_reindex({ deskRoot: root, queryRouter: router(low), input: {} })
  assert.deepEqual(reindexed, { status: "not_reindexed", action: "none", index_current: true,
    message: "This session reindexed nothing. Desk 3.2.0-alpha.349 (another session) owns the search index; this session only reads it. The index already covers the desk's files." })
  assert.equal(low.converged.count, 0)
  assert.equal((await desk_reindex({ deskRoot: root, queryRouter: router(high), input: {} })).status, "ok")

  const owner = "Desk 3.2.0-alpha.349 (another session) owns the search index; this session only reads it."
  const status = await desk_status({ deskRoot: root, statusContext: { admission: { controller: low.controller } } })
  assert.equal(status.readiness.owner, owner)
  assert.equal(status.readiness.owned_by_this_session, false)
  assert.equal(compactStatus(status).search_owner, owner)
  const ownStatus = await desk_status({ deskRoot: root, statusContext: { admission: { controller: high.controller } } })
  assert.equal(ownStatus.readiness.owner, "Desk 3.2.0-alpha.349 (this session) owns the search index.")
  assert.equal(ownStatus.readiness.owned_by_this_session, true)

  // A desk change the owner has not indexed yet: the lower build waits for the owner, and its refusal names the owner in plain words.
  await writeFile(root, "track/four/task.md", "---\nstatus: processing\nschema_version: 1\n---\nquartz rollout four detail\n")
  await low.controller.markUncertain("pending_change")
  const refused = await recall(low, { semanticDeadlineMs: 1_000 })
  assert.equal(refused.status, "error", JSON.stringify(refused))
  assert.equal(refused.diagnostic.reason, "semantic_deadline")
  assert.equal(refused.diagnostic.message, "Meaning-based search did not finish catching up within 1 second.")
  assert.equal(refused.diagnostic.detail, `The search index was still being updated when the wait ran out. ${owner}`)
  assert.equal(low.converged.count, 0, "waiting, the lower build still writes nothing")

  await high.controller.markUncertain("pending_change")
  await high.controller.barrier({ capability: "semantic", wait: true })
  assert.equal(await readyWithin(low.controller, 5_000), true, "the lower build reads the owner's index once the owner has caught up")
  assert.equal((await recall(low)).results?.length, 3)
  assert.equal(low.converged.count, 0)
})

test("a lower build that finds the owner's index rebuilt under other settings refuses, naming the owner, and writes nothing", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  const high = { build: "0".repeat(64), version: "3.2.0-alpha.349", converged: { count: 0 }, verified: { count: 0 } }
  const low = { build: "f".repeat(64), version: "3.2.0-alpha.348", converged: { count: 0 }, verified: { count: 0 } }
  high.controller = await controllerFor(t, root, stateHome, high.build, embed, high)
  await high.controller.beginConvergence()
  low.controller = await controllerFor(t, root, stateHome, low.build, embed, low)
  await low.controller.beginConvergence()
  assert.equal((await low.controller.status()).state, "READY")

  // The owner indexes the same files again under settings this build does not use, before this build has looked again.
  const db = openDb(root)
  let eventCursor
  try { eventCursor = JSON.parse(db.prepare("SELECT event_cursor FROM lexical_generations ORDER BY id DESC LIMIT 1").get().event_cursor) } finally { closeDb(db) }
  const highId = controllerIdentity({ root, ...readinessContracts({ lexical: "required" }, { build: high.build }), semanticContract: { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC } }).id
  await rebuildIndex(root, { eventCursor, embed: { fetch: embed.fetch }, writer: { version: high.version, build: high.build, controller: highId }, identities: { policy_identity: "newer-policy" } })

  const router = createDeskQueryRouter({ controller: low.controller, version: low.version })
  const refused = await desk_recall({ deskRoot: root, queryRouter: router, input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })
  assert.equal(refused.status, "error", JSON.stringify(refused))
  assert.equal(refused.diagnostic.reason, "index_owned_by_newer_desk")
  assert.equal(refused.diagnostic.detail, "Desk 3.2.0-alpha.349 (another session) owns the search index, and this session's Desk cannot read it.")
  assert.equal(low.converged.count, 0)
})
