// Two Desk builds on one desk: each elects its own controller, but both write the one search index in the desk. A newer build whose controller finds the index last written by the other build reconciles it again on its own, without re-embedding vectors that are still valid, instead of refusing meaning-based search until the next file change. Builds that record who wrote the index agree on one owner, so they never take it from each other on every query.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, mkdirSync } from "node:fs"
import * as path from "node:path"
import { desk_recall, desk_search } from "../../../../../plugins/desk/mcp/src/tools/search.js"
import { createDeskQueryRouter, createQueryRouter } from "../../../../../plugins/desk/mcp/src/readiness/query-router.js"
import { RETAINED_LEXICAL_GENERATIONS } from "../../../../../plugins/desk/mcp/src/readiness/generations.js"
import { connectOrStartController } from "../../../../../plugins/desk/mcp/src/readiness/controller-client.js"
import { readinessContracts } from "../../../../../plugins/desk/mcp/src/readiness/contracts.js"
import { openDb, closeDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../../../../plugins/desk/mcp/src/indexer/spec.js"
import { getSemanticCoverage } from "../../../../../plugins/desk/mcp/src/server-helpers.js"
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

// `version` set: a build with the writer record, as the production handler in server.js passes it. Unset: an older alpha that records no writer.
async function controllerFor(t, root, stateHome, build, embed, { version, converged = { count: 0 }, before = async () => {}, after = async () => {} } = {}) {
  const controller = await connectOrStartController({
    root, stateHome, ephemeral: true, ...readinessContracts({ lexical: "required" }, { build }),
    watcher: { fence: async () => ({ certain: true }) },
    semanticContract: { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC },
    handlers: { async beginConvergence({ eventCursor, journal }) {
      converged.count += 1
      await before()
      const summary = await rebuildIndex(root, {
        eventCursor, embed: { fetch: embed.fetch }, ...(version ? { writer: { version, build } } : {}),
      })
      const db = openDb(root)
      try {
        await journal.compact({ db, generationId: summary.lexical_generation })
        await after()
        return { summary, semantic: { ...getSemanticCoverage(db), provenance_current: true,
          query_embedding: { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } } } }
      } finally { closeDb(db) }
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
  const older = await controllerFor(t, root, stateHome, "a".repeat(64), embed)
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

test("two builds that record their writer agree on one owner: the lower one never takes the index back", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  // The higher version wins even with the smaller build digest: version ranks before the digest.
  const high = { build: "0".repeat(64), version: "3.2.0-alpha.343", converged: { count: 0 } }
  const low = { build: "f".repeat(64), version: "3.2.0-alpha.342", converged: { count: 0 } }
  high.controller = await controllerFor(t, root, stateHome, high.build, embed, high)
  low.controller = await controllerFor(t, root, stateHome, low.build, embed, low)
  const router = (side) => createDeskQueryRouter({ controller: side.controller, version: side.version })
  const recall = (side) => desk_recall({ deskRoot: root, queryRouter: router(side), input: { topic: "quartz rollout", limit: 3 }, opts: { embed: { fetch: makeEmbedFetch() } } })
  const search = (side) => desk_search({ deskRoot: root, queryRouter: router(side), input: { query: "quartz" }, opts: { embed: { fetch: makeEmbedFetch() } } })

  await low.controller.beginConvergence()
  await high.controller.beginConvergence()
  const settled = { high: high.converged.count, low: low.converged.count, embedded: embed.documents, rows: generationRows(root) }

  for (let round = 0; round < 3; round += 1) {
    const served = await recall(high)
    assert.equal(served.results?.length, 3, JSON.stringify(served))
    const refused = await recall(low)
    assert.equal(refused.status, "error")
    assert.equal(refused.diagnostic.reason, "index_owned_by_newer_desk")
    assert.equal(refused.diagnostic.message, "A newer Desk session on this desk is serving meaning-based search.")
    assert.equal(refused.fix, "Restart this session to update Desk. desk_search answers now with exact-word matches.")
    const exact = await search(low)
    assert.equal(exact.results.length, 3, "the lower build still answers exact-word search from the files")
    assert.equal((await search(high)).readiness_diagnostic, undefined, "and leaves the index to the higher build")
  }
  assert.equal(high.converged.count, settled.high, "alternating queries start no reconcile in the owning build")
  assert.equal(low.converged.count, settled.low, "nor in the lower build")
  assert.deepEqual(generationRows(root), settled.rows, "so no generation rows are added")
  assert.equal(embed.documents, settled.embedded)

  // A desk change the lower build reconciles last hands the index to it; the higher build takes it back once, on its next query.
  await low.controller.beginConvergence()
  assert.equal((await recall(high)).results.length, 3)
  assert.equal(high.converged.count, settled.high + 1)
  assert.equal((await recall(low)).diagnostic.reason, "index_owned_by_newer_desk")
  assert.equal((await recall(high)).results.length, 3)
  assert.equal(high.converged.count, settled.high + 1, "one reconcile per foreign write, not one per query")
  assert.equal(low.converged.count, settled.low + 1)
  assert.equal(embed.documents, settled.embedded, "nothing is embedded again under the same embedding settings")

  for (let i = 0; i < RETAINED_LEXICAL_GENERATIONS; i += 1) await high.controller.beginConvergence()
  const rows = generationRows(root)
  assert.equal(rows.generations, RETAINED_LEXICAL_GENERATIONS, "generation rows stay bounded however often the builds reconcile")
  assert.equal(rows.operations, RETAINED_LEXICAL_GENERATIONS)
})

test("taking the index back waits only for what is left of the call's deadline", async (t) => {
  const { root, stateHome } = await deskWithThreeTasks()
  const embed = countingEmbed()
  const deadlineMs = 5_000
  const spentMs = 2_000
  let phase = "idle"
  const hold = Promise.withResolvers()
  t.after(() => hold.resolve())
  const older = await controllerFor(t, root, stateHome, "a".repeat(64), embed)
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
