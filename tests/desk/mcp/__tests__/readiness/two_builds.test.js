// Two Desk builds on one desk: each elects its own controller, but both write the one search index in the desk. A newer build whose controller finds the index last written by the other build reconciles it again on its own, without re-embedding vectors that are still valid, instead of refusing meaning-based search until the next file change.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs, mkdirSync } from "node:fs"
import * as path from "node:path"
import { desk_recall, desk_search } from "../../../../../plugins/desk/mcp/src/tools/search.js"
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

async function controllerFor(t, root, stateHome, build, embed) {
  const controller = await connectOrStartController({
    root, stateHome, ephemeral: true, ...readinessContracts({ lexical: "required" }, { build }),
    watcher: { fence: async () => ({ certain: true }) },
    semanticContract: { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC },
    handlers: { async beginConvergence({ eventCursor, journal }) {
      const summary = await rebuildIndex(root, { eventCursor, embed: { fetch: embed.fetch } })
      const db = openDb(root)
      try {
        await journal.compact({ db, generationId: summary.lexical_generation })
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
