import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { closeDb, getMeta, openDb, setMeta } from "../../src/db/init.js"
import { rebuildIndex } from "../../src/indexer/index.js"
import { ACTIVE_EMBEDDING_SPEC } from "../../src/indexer/spec.js"
import { ensureIndex } from "../../src/server-helpers.js"

const KEY = "active_vector_provenance"
const NO_ARTIFACTS = { snapshots: false, vectorPacks: false }
const vector = (value) => Array(768).fill(value)
const embedding = (value) => new Response(JSON.stringify({ embedding: vector(value) }))

function fixture(t, body = "# Provenance\n\nLegacy document.\n") {
  const root = mkdtempSync(path.join(tmpdir(), "desk-vector-provenance-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  if (body) writeFileSync(path.join(root, "task.md"), body)
  return root
}

function inDb(root, action) {
  const db = openDb(root)
  try { return action(db) } finally { closeDb(db) }
}

function provenance(root) {
  return inDb(root, (db) => getMeta(db, KEY))
}

function assertCurrent(root, result) {
  assert.equal(result.semantic.provenance_current, true)
  const value = JSON.parse(provenance(root))
  assert.deepEqual(value, {
    schema_version: 1,
    embedding_spec: {
      id: ACTIVE_EMBEDDING_SPEC.id,
      model: ACTIVE_EMBEDDING_SPEC.model,
      model_revision: ACTIVE_EMBEDDING_SPEC.model_revision,
      dimension: ACTIVE_EMBEDDING_SPEC.dimension,
      chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
      normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
    },
  })
  assert.equal(result.semantic.missing_vectors, 0)
}

async function legacy(root) {
  await rebuildIndex(root, {
    embed: { model: "historical-custom-model", fetch: async () => embedding(0.9) },
  })
  inDb(root, (db) => {
    setMeta(db, "preserved_history", "not derived vector state")
    db.prepare(`INSERT INTO chunk_embedding_failures
      (chunk_key, text_hash, embedding_spec_id, chunker_id, normalization_id, reason, failed_at)
      SELECT chunk_key, text_hash, embedding_spec_id, chunker_id, normalization_id,
        'http_500', '2026-09-01T00:00:00.000Z' FROM chunks`).run()
  })
}

for (const existing of [null, "obsolete-provenance"]) {
  test(`legacy full vectors with ${existing ?? "absent"} provenance regenerate under the active model`, async (t) => {
    const root = fixture(t)
    await legacy(root)
    if (existing) inDb(root, (db) => setMeta(db, KEY, existing))
    const envBefore = { ...process.env }
    const requests = []
    const result = await ensureIndex(root, {
      ...NO_ARTIFACTS,
      embed: { fetch: async (_url, request) => {
        requests.push(JSON.parse(request.body))
        assert.equal(provenance(root), null, "no provenance before generation completes")
        return embedding(0.2)
      } },
    })
    assert.ok(requests.some(({ prompt }) => prompt.includes("Legacy document.")))
    assert.ok(requests.every(({ model }) => model === ACTIVE_EMBEDDING_SPEC.model))
    assertCurrent(root, result)
    inDb(root, (db) => {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_embedding_failures").get().n, 0)
      assert.equal(getMeta(db, "preserved_history"), "not derived vector state")
      const stored = db.prepare("SELECT embedding FROM chunk_vecs").get().embedding
      assert.ok(Math.abs(stored.readFloatLE(0) - 0.2) < 0.00001)
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunks_fts WHERE chunks_fts MATCH 'Legacy'").get().n, 1)
    })
    assert.deepEqual({ ...process.env }, envBefore)
  })
}

test("unavailable migration preserves lexical rows and history, leaves provenance absent, and retries", async (t) => {
  const root = fixture(t)
  await legacy(root)
  const before = inDb(root, (db) => ({
    docs: db.prepare("SELECT * FROM docs").all(),
    chunks: db.prepare("SELECT * FROM chunks").all(),
  }))
  let calls = 0
  const offline = await ensureIndex(root, {
    ...NO_ARTIFACTS,
    embed: { endpoint: "http://unavailable.invalid", fetch: async () => {
      calls += 1
      throw new Error("endpoint unavailable")
    } },
  })
  assert.equal(calls, 1)
  assert.equal(offline.semantic.missing_vectors, 1)
  assert.equal(offline.semantic.provenance_current, false)
  assert.equal(provenance(root), null)
  inDb(root, (db) => {
    assert.deepEqual(db.prepare("SELECT * FROM docs").all(), before.docs)
    assert.deepEqual(db.prepare("SELECT * FROM chunks").all(), before.chunks)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_vecs").get().n, 0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM chunk_embedding_failures").get().n, 0)
    assert.equal(getMeta(db, "preserved_history"), "not derived vector state")
  })
  assertCurrent(root, await ensureIndex(root, {
    ...NO_ARTIFACTS, embed: { fetch: async () => embedding(0.3) },
  }))
})

test("partial chunk-local regeneration cannot establish provenance or suppress the next retry", async (t) => {
  const root = fixture(t, "# First\n\nGood chunk.\n\n## Second\n\nRejected chunk.\n")
  await legacy(root)
  const partial = await ensureIndex(root, {
    ...NO_ARTIFACTS,
    embed: { endpoint: "http://fixture.invalid", fetch: async (_url, request) =>
      JSON.parse(request.body).prompt.includes("Rejected")
        ? new Response(JSON.stringify({ error: "input length exceeds the context length" }), { status: 500 })
        : embedding(0.2) },
  })
  assert.equal(partial.semantic.vectors_indexed, 1)
  assert.equal(partial.semantic.known_unembeddable_vectors, 1)
  assert.equal(partial.semantic.provenance_current, false)
  assert.equal(provenance(root), null)
  const prompts = []
  const retried = await ensureIndex(root, {
    ...NO_ARTIFACTS, embed: { fetch: async (_url, request) => {
      prompts.push(JSON.parse(request.body).prompt)
      return embedding(0.4)
    } },
  })
  assert.ok(prompts.some((prompt) => prompt.includes("Rejected")))
  assert.equal(retried.semantic.vectors_indexed, 2)
  assertCurrent(root, retried)
})

test("matching provenance preserves vectors without reembedding", async (t) => {
  const root = fixture(t)
  const first = await ensureIndex(root, { ...NO_ARTIFACTS, embed: { fetch: async () => embedding(0.2) } })
  assertCurrent(root, first)
  const before = inDb(root, (db) => db.prepare("SELECT * FROM chunk_vecs").all())
  const marker = provenance(root)
  let calls = 0
  const second = await ensureIndex(root, {
    ...NO_ARTIFACTS, embed: { fetch: async () => { calls += 1; throw new Error("must not reembed") } },
  })
  assert.equal(calls, 0)
  assert.equal(second.built, false)
  assert.equal(provenance(root), marker)
  assert.deepEqual(inDb(root, (db) => db.prepare("SELECT * FROM chunk_vecs").all()), before)
  assertCurrent(root, second)
})

for (const field of ["schema_version", "id", "model", "model_revision", "dimension", "chunker_id", "normalization_id"]) {
  test(`provenance mismatch in ${field} invalidates existing vectors`, async (t) => {
    const root = fixture(t)
    await ensureIndex(root, { ...NO_ARTIFACTS, embed: { fetch: async () => embedding(0.2) } })
    assert.notEqual(provenance(root), null)
    const stale = JSON.parse(provenance(root))
    if (field === "schema_version") stale.schema_version = 0
    else stale.embedding_spec[field] = "different"
    inDb(root, (db) => setMeta(db, KEY, JSON.stringify(stale)))
    const result = await ensureIndex(root, {
      ...NO_ARTIFACTS, embed: { fetch: async () => { throw new Error("offline") } },
    })
    assert.equal(result.semantic.vectors_indexed, 0)
    assert.equal(provenance(root), null)
  })
}

for (const existing of [null, "obsolete-provenance"]) {
  test(`skipEmbed preserves untrusted vectors and ${existing ?? "absent"} provenance without probing`, async (t) => {
    const root = fixture(t)
    await legacy(root)
    if (existing) inDb(root, (db) => setMeta(db, KEY, existing))
    const before = inDb(root, (db) => ({
      vectors: db.prepare("SELECT * FROM chunk_vecs").all(),
      failures: db.prepare("SELECT * FROM chunk_embedding_failures").all(),
    }))
    let calls = 0
    await ensureIndex(root, {
      ...NO_ARTIFACTS, skipEmbed: true,
      embed: { fetch: async () => { calls += 1; throw new Error("must not probe") } },
    })
    assert.equal(calls, 0)
    assert.equal(provenance(root), existing)
    assert.deepEqual(inDb(root, (db) => ({
      vectors: db.prepare("SELECT * FROM chunk_vecs").all(),
      failures: db.prepare("SELECT * FROM chunk_embedding_failures").all(),
    })), before)
    assertCurrent(root, await ensureIndex(root, {
      ...NO_ARTIFACTS, embed: { fetch: async () => embedding(0.3) },
    }))
  })
}

test("zero chunks establish active provenance without a document embedding call", async (t) => {
  const root = fixture(t, "")
  let calls = 0
  const result = await ensureIndex(root, {
    ...NO_ARTIFACTS, embed: { fetch: async () => { calls += 1; throw new Error("no documents") } },
  })
  assert.equal(calls, 0)
  assert.equal(result.semantic.chunks_total, 0)
  assertCurrent(root, result)
})

test("explicit alternate-model generation cannot establish active provenance", async (t) => {
  const root = fixture(t)
  const result = await ensureIndex(root, {
    ...NO_ARTIFACTS, embed: { model: "custom-model", fetch: async () => embedding(0.2) },
  })
  assert.equal(result.semantic.provenance_current, false)
  assert.equal(provenance(root), null)
})
