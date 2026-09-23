// search.test.js — desk_search hybrid lexical+semantic ranking + filters.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { promises as fs } from "node:fs"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"

// Keep legacy indexed ranking coverage separate from the alpha consumer contract.
import { __searchInternalsForTests, desk_search as routedSearch, indexedSearch as desk_search, indexedTimeline } from "../../src/tools/search.js"
import { connectOrStartController } from "../../src/readiness/controller-client.js"
import { openDb, closeDb } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { getSemanticCoverage } from "../../src/server-helpers.js"
import {
  buildFixtureIndex,
  makeEmbedFetch,
  makeFailingFetch,
  mkTempDeskRoot,
  topicVector,
  writeFile,
} from "./_search_helpers.js"

async function createRoutedSemanticReadiness(t, root, { semanticCurrent = true } = {}) {
  const canonicalRoot = await fs.realpath(root)
  const stateHome = path.join(canonicalRoot, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  const controller = await connectOrStartController({
    root: canonicalRoot,
    stateHome,
    ephemeral: true,
    watcher: { fence: async () => ({ certain: true }) },
    semanticContract: { mode: "background", embedding_spec: ACTIVE_EMBEDDING_SPEC },
    handlers: { async beginConvergence({ eventCursor }) {
      const summary = await rebuildIndex(canonicalRoot, {
        eventCursor,
        embed: { fetch: makeEmbedFetch() },
      })
      const db = openDb(canonicalRoot)
      try {
        return {
          summary,
          semantic: {
            ...getSemanticCoverage(db),
            provenance_current: semanticCurrent,
            query_embedding: semanticCurrent
              ? { available: true, diagnostic: { model: ACTIVE_EMBEDDING_SPEC.model } }
              : {
                  available: false,
                  diagnostic: {
                    model: ACTIVE_EMBEDDING_SPEC.model,
                    reason: "semantic_unavailable",
                    message: "semantic convergence is not current for the active generation",
                  },
                },
          },
        }
      } finally {
        closeDb(db)
      }
    } },
  })
  t.after(async () => controller.close())
  await controller.beginConvergence()
  return controller
}

test("search without a readiness controller reads files immediately without index or embedding work", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/work/task.md", "immediatequartz")
  let independentEmbeds = 0
  const result = await routedSearch({
    deskRoot: root, input: { query: "immediatequartz" },
    opts: { embed: { fetch: async () => { independentEmbeds++; throw new Error("query must not embed") } } },
  })
  assert.equal(result.results[0].snippet, "immediatequartz")
  assert.equal(result.search_mode, "lexical")
  assert.equal(result.readiness_diagnostic.reason, "controller_unavailable")
  assert.equal(independentEmbeds, 0)
  await assert.rejects(fs.stat(path.join(root, ".state", "desk-index.sqlite")), { code: "ENOENT" })
})

test("indexed search closes and propagates sqlite extension load failures", async (t) => {
  const root = await mkTempDeskRoot()
  await buildFixtureIndex(root, {
    files: [{ path: "track/work/task.md", text: "indexed quartz" }],
  })
  const original = Database.prototype.loadExtension
  Database.prototype.loadExtension = () => { throw new Error("sqlite vec load failed") }
  t.after(() => { Database.prototype.loadExtension = original })
  await assert.rejects(
    () => desk_search({ deskRoot: root, input: { query: "quartz" } }),
    /sqlite vec load failed/u,
  )
})

test("routed semantic tools serve the current semantic snapshot", async (t) => {
  const { desk_recall, desk_similar } = await import("../../src/tools/search.js")
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/work/task.md", "---\nstatus: processing\nschema_version: 1\n---\nquartz rollout detail\n")
  await writeFile(root, "track/other/task.md", "---\nstatus: processing\nschema_version: 1\n---\nrollout plan near quartz\n")
  const readiness = await createRoutedSemanticReadiness(t, root)
  const recall = await desk_recall({
    deskRoot: root,
    readiness,
    input: { topic: "quartz rollout", limit: 1 },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  const similar = await desk_similar({
    deskRoot: root,
    readiness,
    input: { path: "track/work/task.md", limit: 1 },
  })
  assert.equal(recall.results[0].path, "track/work/task.md")
  assert.equal(similar.results[0].path, "track/other/task.md")
})

test("routed timeline serves hybrid query results and temporal no-query results", async (t) => {
  const { desk_timeline } = await import("../../src/tools/search.js")
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/old/task.md", "---\nupdated: 2025-01-01\n---\nquartz old")
  await writeFile(root, "track/new/task.md", "---\nupdated: 2026-09-19\n---\nquartz current")
  const readiness = await createRoutedSemanticReadiness(t, root)
  const temporal = await desk_timeline({
    deskRoot: root,
    readiness,
    input: { from: "2026-01-01" },
  })
  const hybrid = await desk_timeline({
    deskRoot: root,
    readiness,
    input: { from: "2026-01-01", query: "quartz" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.deepEqual(temporal.results.map((r) => r.path), [path.join("track", "new", "task.md")])
  assert.equal(temporal.search_mode, "temporal")
  assert.deepEqual(hybrid.results.map((r) => r.path), [path.join("track", "new", "task.md")])
  assert.equal(hybrid.search_mode, "hybrid")
  assert.equal(hybrid.semantic_unavailable, false)
})

test("timeline hybrid keeps the strongest chunk per document", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/work/task.md", "---\nupdated: 2026-09-19\n---\nalpha opening")
  await buildFixtureIndex(root)
  const db = new Database(path.join(root, ".state", "desk-index.sqlite"))
  try {
    sqliteVec.load(db)
    const doc = db.prepare("SELECT id FROM docs WHERE path = ?").get("track/work/task.md")
    const info = db.prepare(`INSERT INTO chunks
      (doc_id, chunk_index, chunk_key, text_hash, embedding_spec_id, chunker_id, normalization_id, text)
      SELECT doc_id, 1, chunk_key || '-second', text_hash || '-second', embedding_spec_id, chunker_id, normalization_id, ?
      FROM chunks WHERE doc_id = ? AND chunk_index = 0`).run("alpha later stronger detail", doc.id)
    db.prepare("INSERT INTO chunks_fts(rowid, text) VALUES (?, ?)").run(info.lastInsertRowid, "alpha later stronger detail")
    db.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)").run(BigInt(info.lastInsertRowid), new Float32Array(topicVector("alpha later stronger detail")))
  } finally {
    db.close()
  }
  const result = await indexedTimeline({
    deskRoot: root,
    input: { from: "2026-01-01", query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.search_mode, "hybrid")
  assert.equal(result.results.length, 1)
  assert.equal(result.results[0].path, "track/work/task.md")
})

test("routed search falls back to proven lexical ranking while semantic convergence is unavailable", async (t) => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "track/work/task.md", "---\nstatus: processing\nschema_version: 1\n---\nquartz lexical fallback\n")
  const readiness = await createRoutedSemanticReadiness(t, root, { semanticCurrent: false })
  const result = await routedSearch({
    deskRoot: root,
    readiness,
    input: { query: "quartz" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.equal(result.search_mode, "lexical")
  assert.equal(result.semantic_unavailable, true)
  assert.equal(result.results[0].path, "track/work/task.md")
})

test("alpha consumer concurrent startup search and reindex leave zero orphan vectors and one writer", async (t) => {
  const { connectOrStartController } = await import("../../src/readiness/controller-client.js")
  const { rebuildIndex } = await import("../../src/indexer/index.js")
  const { desk_reindex } = await import("../../src/tools/reindex.js")
  const root = await fs.realpath(await mkTempDeskRoot())
  await writeFile(root, "track/work/task.md", "startupquartz")
  const stateHome = path.join(root, "controller-state")
  mkdirSync(stateHome, { recursive: true, mode: 0o700 })
  let release, enter
  const held = new Promise((resolve) => { release = resolve })
  const entered = new Promise((resolve) => { enter = resolve })
  let passes = 0, active = 0, maxActive = 0
  let independentEmbeds = 0
  const options = {
    root, stateHome, ephemeral: true,
    watcher: { fence: async () => ({ certain: true }) },
    handlers: { async beginConvergence({ eventCursor }) {
      passes++
      active++
      maxActive = Math.max(maxActive, active)
      try { return { summary: await rebuildIndex(root, {
        eventCursor, embed: { fetch: async (...args) => {
          enter(); await held; return makeEmbedFetch()(...args)
        } },
      }) } } finally { active-- }
    } },
  }
  const controller = await connectOrStartController(options)
  const consumer = await connectOrStartController(options)
  let joined
  const join = new Promise((resolve) => { joined = resolve })
  const begin = consumer.beginConvergence
  consumer.beginConvergence = async () => {
    const result = await begin()
    joined()
    return result
  }
  t.after(async () => { release(); await consumer.close(); await controller.close() })
  const convergence = controller.beginConvergence()
  await entered
  let reindex
  try {
    const result = await routedSearch({
      deskRoot: root, readiness: consumer, input: { query: "startupquartz" },
      opts: { embed: { fetch: async () => { independentEmbeds++; return makeEmbedFetch()() } } },
    })
    assert.equal(result.results[0].snippet, "startupquartz")
    assert.equal(independentEmbeds, 0, "search must not start an ensureIndex repair")
    reindex = desk_reindex({ deskRoot: root, readiness: consumer, input: { force: true } })
    const outcome = Promise.allSettled([reindex])
    await join
    release()
    await convergence
    const [resultReindex] = await outcome
    assert.equal(resultReindex.status, "fulfilled")
    assert.equal(resultReindex.value.status, "ok")
    assert.equal(resultReindex.value.reused, true, "compatibility reindex joins the in-flight controller operation")
    assert.equal(maxActive, 1, "only the controller serializes index passes, including uncertainty reconciliation")
    const db = openDb(root)
    try {
      assert.equal(db.prepare(`SELECT COUNT(*) AS orphan_count FROM chunk_vecs v
        LEFT JOIN chunks c ON c.id = v.chunk_id WHERE c.id IS NULL`).get().orphan_count, 0)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n, 1)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM lexical_generations").get().n, passes)
    } finally { closeDb(db) }
  } finally { release(); await Promise.allSettled([convergence, reindex]) }
})

// Build a fixture desk where chunks across multiple tracks share or differ
// on the first-word "family" (deterministic 768-dim vectors per
// _search_helpers.js). A query whose first letter matches a doc's first
// letter produces a strong semantic hit; mismatched produces near-zero.

async function buildBaseDesk() {
  const root = await mkTempDeskRoot()
  // Track A — alpha-family docs
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\ntitle: A1\n---\nalpha retry exponential backoff details\n",
  )
  await writeFile(
    root,
    "trackA/task-1/planning.md",
    "alpha retry plan body content\n",
  )
  // Track B — bravo-family docs
  await writeFile(
    root,
    "trackB/task-2/task.md",
    "---\nstatus: done\nschema_version: 1\ntitle: B1\n---\nbravo widget design notes\n",
  )
  // Track C — alpha-family but blocked status
  await writeFile(
    root,
    "trackC/task-3/task.md",
    "---\nstatus: blocked\nschema_version: 1\ntitle: C1\n---\nalpha retry insight\n",
  )
  return root
}

test("search internals cover defensive helper branches", async () => {
  const helpers = __searchInternalsForTests

  const featureRoot = await mkTempDeskRoot()
  assert.equal(await helpers.readFeaturedTrack(featureRoot), null)
  await writeFile(featureRoot, "_meta/featured.md", "# comment\n\ntrackA\n")
  assert.equal(await helpers.readFeaturedTrack(featureRoot), "trackA")
  await writeFile(featureRoot, "_meta/blank.md", "")
  const blankFeatureRoot = await mkTempDeskRoot()
  await writeFile(blankFeatureRoot, "_meta/featured.md", "# comment only\n")
  assert.equal(await helpers.readFeaturedTrack(blankFeatureRoot), null)

  assert.match(
    helpers.semanticUnavailableFields(undefined).semantic_note,
    /embedding service did not return/u,
  )
  assert.equal(helpers.semanticUnavailableFields(undefined).semantic_diagnostic, null)
  assert.equal(
    Object.hasOwn(helpers.semanticUnavailableFields({ reason: "alpha_scope", message: "semantic intentionally out of scope" }), "semantic_repair"),
    false,
  )

  assert.deepEqual(helpers.buildFtsQuery(null), { matchExpr: null, terms: [] })
  assert.deepEqual(helpers.buildFtsQuery("a"), { matchExpr: null, terms: [] })
  assert.equal(helpers.clampLimit(Number.NaN), 10)
  assert.equal(helpers.clampLimit(999), 50)
  assert.equal(helpers.decodeEmbedding(null), null)
  assert.deepEqual(helpers.decodeEmbedding(Buffer.from([0, 0, 128, 63])), [1])

  assert.deepEqual(helpers.resolveScopeFilter("all", "active"), { sql: "", params: [] })
  assert.deepEqual(helpers.resolveScopeFilter("archived", "active"), {
    sql: " AND d.is_archived = 1",
    params: [],
  })
  assert.deepEqual(helpers.resolveScopeFilter("bogus", "active"), {
    sql: " AND d.is_archived = 0",
    params: [],
  })
  assert.deepEqual(helpers.resolveScopeFilter(undefined, "archived", "doc"), {
    sql: " AND doc.is_archived = 1",
    params: [],
  })

  assert.deepEqual(helpers.buildDocsFilter(null), { sql: "", params: [] })
  assert.deepEqual(helpers.buildDocsFilter("bad"), { sql: "", params: [] })
  assert.equal(
    helpers.buildDocsFilter({
      track: ["trackA", "trackB"],
      status: ["processing"],
      kind: ["task"],
      since: "2025-01-01",
      until: "2026-01-01",
    }).params.length,
    6,
  )
  assert.deepEqual(helpers.buildDocsFilter({ status: [""], kind: [""] }), {
    sql: "",
    params: [],
  })
  assert.deepEqual(helpers.buildDocsFilter({ track: [], since: 123, until: false }), {
    sql: "",
    params: [],
  })
  assert.deepEqual(
    helpers.buildDocsFilter({ track: "trackA", status: "processing", kind: "task" }).params,
    ["trackA", "processing", "task"],
  )

  assert.deepEqual(helpers.gatherFtsCandidates({}, null, "", [], 10), [])
  assert.deepEqual(helpers.gatherVecCandidates({}, null, 10), [])
  assert.equal(helpers.hydrateChunks({}, []).size, 0)

  assert.equal(helpers.makeSnippet("", ["alpha"]), "")
  const long = `${Array.from({ length: 90 }, (_, i) => `before${i}`).join(" ")} alpha ${Array.from({ length: 90 }, (_, i) => `after${i}`).join(" ")}`
  assert.match(helpers.makeSnippet(long, [""]), /\.\.\.$/u)
  assert.match(helpers.makeSnippet(long, null), /\.\.\.$/u)
  assert.match(helpers.makeSnippet(long, ["missing"]), /\.\.\.$/u)
  assert.match(helpers.makeSnippet(long, ["alpha"]), /alpha/u)

  const row = {
    track: "trackA",
    status: "processing",
    kind: "task",
    updated_at: "2025-06-01",
    is_archived: 0,
  }
  assert.equal(helpers.passesFilter(row, null), true)
  assert.equal(helpers.passesFilter(row, { track: ["trackB"] }), false)
  assert.equal(helpers.passesFilter(row, { track: ["trackA"] }), true)
  assert.equal(helpers.passesFilter(row, { track: "trackB" }), false)
  assert.equal(helpers.passesFilter(row, { track: "trackA" }), true)
  assert.equal(helpers.passesFilter(row, { status: ["done"] }), false)
  assert.equal(helpers.passesFilter(row, { status: "processing" }), true)
  assert.equal(helpers.passesFilter(row, { kind: ["planning"] }), false)
  assert.equal(helpers.passesFilter(row, { kind: "task" }), true)
  assert.equal(helpers.passesFilter(row, { since: "2026-01-01" }), false)
  assert.equal(helpers.passesFilter(row, { until: "2025-01-01" }), false)
  assert.equal(helpers.passesFilter(row, { until: "2026-01-01" }), true)
  assert.equal(helpers.passesFilter({ ...row, updated_at: null }, { since: "2026-01-01" }), true)
  assert.equal(helpers.passesFilter({ ...row, updated_at: null }, { until: "2025-01-01" }), true)

  assert.equal(helpers.passesScope({ is_archived: 1 }, "all", "active"), true)
  assert.equal(helpers.passesScope({ is_archived: 1 }, "archived", "active"), true)
  assert.equal(helpers.passesScope({ is_archived: 0 }, "archived", "active"), false)
  assert.equal(helpers.passesScope({ is_archived: 0 }, "active", "all"), true)
  assert.equal(helpers.passesScope({ is_archived: 1 }, "active", "all"), false)
  assert.equal(helpers.passesScope({ is_archived: 1 }, undefined, "archived"), true)
  assert.equal(helpers.shouldReplaceBest(undefined, 1), true)
  assert.equal(helpers.shouldReplaceBest({ score: 0.5 }, 0.6), true)
  assert.equal(helpers.shouldReplaceBest({ score: 0.5 }, 0.4), false)
  assert.equal(helpers.comparableUpdatedAt({ updated_at: "2026-01-01" }), "2026-01-01")
  assert.equal(helpers.comparableUpdatedAt({ updated_at: null }), "")
  assert.equal(helpers.firstChunkText({ text: "body" }), "body")
  assert.equal(helpers.firstChunkText({ text: null }), "")

  const fakeDb = {
    prepare() {
      return {
        all() {
          return [
            { path: "trackA/bad-json/task.md", frontmatter: "{bad" },
            { path: "trackA/default-frontmatter/task.md" },
            { path: "trackA/no-history/task.md", frontmatter: "{}" },
            {
              path: "trackA/not-array/task.md",
              frontmatter: JSON.stringify({ iterations: { history: "nope" } }),
            },
            {
              path: "trackA/null-entry/task.md",
              frontmatter: JSON.stringify({ iterations: { history: [null] } }),
            },
            {
              path: "trackA/missing-outcome/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ path: "./repo" }] },
              }),
            },
            {
              path: "trackA/done/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ outcome: "done", path: "./repo" }] },
              }),
            },
            {
              path: "trackA/no-path/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ outcome: "in-progress", path: "" }] },
              }),
            },
            {
              path: "trackA/pinned/task.md",
              frontmatter: JSON.stringify({
                iterations: { history: [{ outcome: "in-progress", path: "./repo/iter" }] },
              }),
            },
          ]
        },
      }
    },
  }
  const prefixes = helpers.computePinPrefixes(fakeDb, "trackA")
  assert.equal(prefixes.has(path.join("trackA", "pinned", "repo", "iter")), true)
  assert.equal(helpers.computePinPrefixes(fakeDb, null).size, 0)
  assert.equal(helpers.isPinned("anything.md", new Set()), false)
  assert.equal(
    helpers.isPinned(
      path.join("trackA", "pinned", "repo", "iter", "doing.md"),
      prefixes,
    ),
    true,
  )
  assert.equal(helpers.isPinned(path.join("trackA", "pinned", "repo", "iter"), prefixes), true)
  assert.equal(helpers.isPinned("trackA/other/doing.md", prefixes), false)
})

test("desk_search — happy path returns ranked results with score_breakdown", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.ok(Array.isArray(res.results), "results is an array")
  assert.ok(res.results.length >= 1, "at least one result")
  // Alpha-family docs should rank ahead of bravo-family.
  const top = res.results[0]
  assert.match(top.snippet.toLowerCase(), /alpha/, "top result mentions alpha")
  assert.ok(typeof top.score === "number" && top.score > 0)
  assert.ok(top.score_breakdown && typeof top.score_breakdown === "object")
  assert.ok(top.score_breakdown.semantic >= 0)
  assert.ok(top.score_breakdown.bm25 >= 0)
  assert.equal(res.semantic_unavailable, false)
  assert.ok(typeof res.latency_ms === "number")
})

test("desk_search — Ollama-down soft-fails to FTS-only with semantic_unavailable=true", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeFailingFetch() } },
  })

  assert.equal(res.semantic_unavailable, true, "flag set when query embed fails")
  // FTS still finds the alpha hits.
  assert.ok(res.results.length >= 1)
  // Semantic component in breakdown should be 0 (no embedding available).
  assert.equal(res.results[0].score_breakdown.semantic, 0)
})

test("desk_search — empty or missing query returns before indexing", async () => {
  const root = await mkTempDeskRoot()
  const empty = await desk_search({ deskRoot: root, input: null })
  assert.deepEqual(empty.results, [])
  assert.equal(empty.query, "")
  assert.equal(empty.semantic_unavailable, false)
})

test("desk_search — lexical no-match returns empty results with unavailable semantic note", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "zzzz-no-match" },
    opts: { embed: { fetch: makeFailingFetch() } },
  })

  assert.equal(res.search_mode, "lexical")
  assert.equal(res.semantic_unavailable, true)
  assert.deepEqual(res.results, [])
  assert.match(res.semantic_note, /Semantic search unavailable/u)
})

test("desk_search — single-character query uses semantic candidates without FTS", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "a" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.equal(res.search_mode, "hybrid")
  assert.equal(res.semantic_unavailable, false)
  assert.ok(res.results.length >= 1)
})

test("indexed search reads vectors after explicit fixture repair, never repairs itself", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha semantic repair body\n",
  )
  const { rebuildIndex } = await import("../../src/indexer/index.js")
  await rebuildIndex(root, { embed: { fetch: makeFailingFetch() } })
  await rebuildIndex(root, { reembedMissing: true, embed: { fetch: makeEmbedFetch() } })

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.equal(res.semantic_unavailable, false)
  assert.ok(res.results.length >= 1)
  assert.ok(
    res.results[0].score_breakdown.semantic > 0,
    "semantic component should be restored after repair",
  )
})

test("desk_search — default embed options use global fetch", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)
  const originalFetch = globalThis.fetch
  globalThis.fetch = makeEmbedFetch()
  try {
    const res = await desk_search({
      deskRoot: root,
      input: { query: "alpha" },
    })
    assert.equal(res.search_mode, "hybrid")
    assert.equal(res.semantic_unavailable, false)
  } finally {
    if (originalFetch === undefined) {
      delete globalThis.fetch
    } else {
      globalThis.fetch = originalFetch
    }
  }
})

test("desk_search — default active scope skips archived semantic candidates", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/active/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha active content\n",
  )
  await writeFile(
    root,
    "trackA/_archive/old/task.md",
    "---\nstatus: done\nschema_version: 1\n---\nalpha archived content\n",
  )
  await buildFixtureIndex(root)

  const active = await desk_search({
    deskRoot: root,
    input: { query: "a" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(active.results.length >= 1)
  assert.ok(active.results.every((result) => !result.path.includes("_archive")))

  const all = await desk_search({
    deskRoot: root,
    input: { query: "a", scope: "all" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(all.results.some((result) => result.path.includes("_archive")))
})

test("desk_search — track filter narrows to one track", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { track: "trackA" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.equal(r.track, "trackA")
  }
})

test("desk_search — invalid and empty filters behave as no-ops", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const invalid = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: "not-an-object" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(invalid.results.length >= 1)

  const emptyArrays = await desk_search({
    deskRoot: root,
    input: {
      query: "alpha",
      filters: { track: [] },
    },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(emptyArrays.results.length >= 1)

  const nonStringTrack = await desk_search({
    deskRoot: root,
    input: {
      query: "alpha",
      filters: { track: 42 },
    },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.deepEqual(nonStringTrack.results, [])
})

test("desk_search — track array filter excludes semantic candidates outside the set", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { track: ["trackA", "trackC"] } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.ok(["trackA", "trackC"].includes(r.track))
  }
  assert.ok(!res.results.some((r) => r.track === "trackB"))
})

test("desk_search — status filter (single value)", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { status: "processing" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.equal(r.status, "processing")
  }
})

test("desk_search — status filter (array of values)", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { status: ["processing", "blocked"] } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.ok(["processing", "blocked"].includes(r.status))
  }
})

test("desk_search — kind filter narrows by doc kind", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { kind: "planning" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.equal(r.kind, "planning")
  }
  assert.ok(res.results.length >= 1, "at least one planning doc")
})

test("desk_search — kind array filter narrows by doc kind", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { kind: ["planning"] } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.equal(r.kind, "planning")
  }
})

test("desk_search — since filter excludes older docs", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2024-01-01\n---\nalpha old content\n",
  )
  await writeFile(
    root,
    "trackA/task-2/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha new content\n",
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { since: "2025-01-01" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  for (const r of res.results) {
    assert.ok(
      r.updated_at >= "2025-01-01",
      `expected updated_at >= 2025-01-01, got ${r.updated_at}`,
    )
  }
})

test("desk_search — until filter excludes newer docs", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2024-01-01\n---\nalpha old content\n",
  )
  await writeFile(
    root,
    "trackA/task-2/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha new content\n",
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha", filters: { until: "2025-01-01" } },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  for (const r of res.results) {
    assert.ok(
      r.updated_at <= "2025-01-01",
      `expected updated_at <= 2025-01-01, got ${r.updated_at}`,
    )
  }
})

test("desk_search — limit is clamped to [1, 50]", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const huge = await desk_search({
    deskRoot: root,
    input: { query: "alpha", limit: 9999 },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(huge.results.length <= 50, "limit clamped to 50 max")

  const tiny = await desk_search({
    deskRoot: root,
    input: { query: "alpha", limit: 0 },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  // 0 → clamped to 1; depending on data we get 0 or 1 result, but never
  // more than 1.
  assert.ok(tiny.results.length <= 1, "limit=0 clamped to >= 1 (so <=1 result)")
})

test("desk_search — state_bias raises active-status docs above terminal-status docs", async () => {
  const root = await mkTempDeskRoot()
  // Two docs with identical text → same FTS + semantic scores. State_bias
  // is the only differentiator.
  await writeFile(
    root,
    "trackA/active/task.md",
    "---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha identical body content\n",
  )
  await writeFile(
    root,
    "trackA/finished/task.md",
    "---\nstatus: done\nschema_version: 1\nupdated: 2026-05-01\n---\nalpha identical body content\n",
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 2)
  const processingResult = res.results.find((r) => r.status === "processing")
  const doneResult = res.results.find((r) => r.status === "done")
  assert.ok(processingResult, "found processing-status result")
  assert.ok(doneResult, "found done-status result")
  assert.ok(
    processingResult.score > doneResult.score,
    `expected processing(${processingResult.score}) > done(${doneResult.score})`,
  )
  // Verify the state component is what differentiates them.
  assert.ok(
    processingResult.score_breakdown.state >
      doneResult.score_breakdown.state,
  )
})

test("desk_search — empty query returns empty results", async () => {
  const root = await buildBaseDesk()
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.deepEqual(res.results, [])
})

test("desk_search — long snippets center around query terms", async () => {
  const root = await mkTempDeskRoot()
  const prefix = Array.from({ length: 90 }, (_, index) => `prefix${index}`).join(" ")
  const suffix = Array.from({ length: 90 }, (_, index) => `suffix${index}`).join(" ")
  await writeFile(
    root,
    "trackA/task-long/task.md",
    `---\nstatus: processing\nschema_version: 1\n---\n${prefix} alpha-centered ${suffix}\n`,
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha-centered" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  assert.match(res.results[0].snippet, /alpha-centered/u)
  assert.match(res.results[0].snippet, /^\.\.\./u)
  assert.match(res.results[0].snippet, /\.\.\.$/u)
})

test("desk_search — long semantic-only snippets fall back when query term is absent", async () => {
  const root = await mkTempDeskRoot()
  const longBody = Array.from({ length: 120 }, (_, index) => `aardvark${index}`).join(" ")
  await writeFile(
    root,
    "trackA/task-semantic/task.md",
    `---\nstatus: processing\nschema_version: 1\n---\n${longBody}\n`,
  )
  await buildFixtureIndex(root)

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  assert.match(res.results[0].snippet, /\.\.\.$/u)
  assert.doesNotMatch(res.results[0].snippet, /alpha/u)
})

test("desk_search — long snippets handle start and end query-term boundaries", async () => {
  const root = await mkTempDeskRoot()
  const tail = Array.from({ length: 90 }, (_, index) => `tail${index}`).join(" ")
  const head = Array.from({ length: 90 }, (_, index) => `head${index}`).join(" ")
  await writeFile(
    root,
    "trackA/task-start/task.md",
    `---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-02\n---\nalpha-start ${tail}\n`,
  )
  await writeFile(
    root,
    "trackA/task-end/task.md",
    `---\nstatus: processing\nschema_version: 1\nupdated: 2026-05-01\n---\n${head} alpha-end\n`,
  )
  await buildFixtureIndex(root)

  const start = await desk_search({
    deskRoot: root,
    input: { query: "alpha-start" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.doesNotMatch(start.results[0].snippet, /^\.\.\./u)
  assert.match(start.results[0].snippet, /\.\.\.$/u)

  const end = await desk_search({
    deskRoot: root,
    input: { query: "alpha-end" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  const endResult = end.results.find((result) =>
    result.path.includes(path.join("task-end", "task.md")),
  )
  assert.ok(endResult, "end-boundary result surfaced")
  assert.match(endResult.snippet, /^\.\.\./u)
  assert.doesNotMatch(endResult.snippet, /\.\.\.$/u)
})

test("desk_search — active-iteration pin adds the +0.30 bonus", async () => {
  const root = await mkTempDeskRoot()
  // Featured track + a task with an in-progress iteration whose path points
  // at a doc that should get the pin bonus.
  await writeFile(root, "_meta/featured.md", "trackP\n")
  await writeFile(
    root,
    "trackP/task-pinned/task.md",
    `---
schema_version: 1
status: processing
updated: 2026-05-01
title: P1
iterations:
  active: ./repo-x/2026-05-01-impl
  history:
    - slug: 2026-05-01-impl
      repo: repo-x
      trigger: initial-impl
      path: ./repo-x/2026-05-01-impl
      outcome: in-progress
---
alpha pinned body summary
`,
  )
  // The iteration directory has its own doing.md which should get pinned.
  await writeFile(
    root,
    "trackP/task-pinned/repo-x/2026-05-01-impl/doing.md",
    "alpha iteration body content\n",
  )
  // A control doc, same alpha text, NOT under the pinned prefix.
  await writeFile(
    root,
    "trackQ/task-other/doing.md",
    "alpha control body content\n",
  )

  await buildFixtureIndex(root)
  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })

  // The pinned doing.md should rank top — its pin breakdown should be 0.3.
  const pinned = res.results.find((r) =>
    r.path.includes(path.join("2026-05-01-impl", "doing.md")),
  )
  const control = res.results.find((r) =>
    r.path.includes(path.join("trackQ", "task-other", "doing.md")),
  )
  assert.ok(pinned, "pinned doc surfaced in results")
  assert.ok(control, "control doc surfaced in results")
  assert.ok(
    pinned.score_breakdown.pin > 0,
    "pin component on the pinned chunk > 0",
  )
  assert.equal(control.score_breakdown.pin, 0, "control chunk not pinned")
  assert.ok(
    pinned.score > control.score,
    `pin bumps pinned (${pinned.score}) above control (${control.score})`,
  )
})

test("desk_search — ignores malformed featured task frontmatter when pinning", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "_meta/featured.md", "trackP\n")
  await writeFile(
    root,
    "trackP/task-pinned/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha malformed pin body\n",
  )
  await buildFixtureIndex(root)

  const db = openDb(root)
  try {
    db.prepare("UPDATE docs SET frontmatter = ? WHERE path = ?").run(
      "{malformed-json",
      "trackP/task-pinned/task.md",
    )
  } finally {
    closeDb(db)
  }

  const res = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(res.results.length >= 1)
  assert.equal(res.results[0].score_breakdown.pin, 0)
})

test("desk_search — ignores blank featured track and no-op iteration histories", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(root, "_meta/featured.md", "# comment only\n\n")
  await writeFile(
    root,
    "trackP/no-history/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha no history\n",
  )
  await buildFixtureIndex(root)

  const blankFeatured = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(blankFeatured.results.length >= 1)
  assert.equal(blankFeatured.results[0].score_breakdown.pin, 0)

  await writeFile(root, "_meta/featured.md", "trackP\n")
  const rows = [
    ["trackP/no-history/task.md", { status: "processing" }],
    ["trackP/string-history/task.md", { iterations: { history: "nope" } }],
    ["trackP/null-entry/task.md", { iterations: { history: [null] } }],
    ["trackP/done-entry/task.md", { iterations: { history: [{ outcome: "done", path: "./repo" }] } }],
    ["trackP/bad-path/task.md", { iterations: { history: [{ outcome: "in-progress", path: "" }] } }],
  ]
  for (const [docPath] of rows.slice(1)) {
    await writeFile(root, docPath, "---\nstatus: processing\nschema_version: 1\n---\nalpha pin edge\n")
  }
  await buildFixtureIndex(root)

  const db = openDb(root)
  try {
    for (const [docPath, frontmatter] of rows) {
      db.prepare("UPDATE docs SET frontmatter = ? WHERE path = ?").run(
        JSON.stringify(frontmatter),
        docPath,
      )
    }
  } finally {
    closeDb(db)
  }

  const noPins = await desk_search({
    deskRoot: root,
    input: { query: "alpha" },
    opts: { embed: { fetch: makeEmbedFetch() } },
  })
  assert.ok(noPins.results.length >= 1)
  assert.ok(noPins.results.every((result) => result.score_breakdown.pin === 0))
})

test("desk_search — propagates unexpected featured-track read errors", async () => {
  const root = await mkTempDeskRoot()
  await writeFile(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\nalpha body\n",
  )
  await buildFixtureIndex(root)
  await fs.mkdir(path.join(root, "_meta", "featured.md"), { recursive: true })

  await assert.rejects(
    () => desk_search({
      deskRoot: root,
      input: { query: "alpha" },
      opts: { embed: { fetch: makeEmbedFetch() } },
    }),
    /EISDIR|illegal operation/u,
  )
})
