// The local index inspection reports old or partial index files without throwing.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync } from "node:fs"
import * as path from "node:path"
import Database from "better-sqlite3"
import { indexDbPath } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { inspectLocalDb } from "../../../../../plugins/desk/mcp/src/db/status-read.js"
import { mkTempRoot } from "../_temp_roots.js"

async function deskWithIndex(sql) {
  const root = await mkTempRoot("desk-status-read-")
  mkdirSync(path.dirname(indexDbPath(root)), { recursive: true })
  const db = new Database(indexDbPath(root))
  db.exec(sql)
  db.close()
  return root
}

const FULL_CHUNKS = "CREATE TABLE chunks (chunk_key TEXT, text_hash TEXT, embedding_spec_id TEXT, chunker_id TEXT, normalization_id TEXT);"

test("an index without a meta table or the vector columns reports unknown freshness and no vectors", async () => {
  const root = await deskWithIndex("CREATE TABLE chunks (id INTEGER); CREATE TABLE text_vectors (x); CREATE TABLE chunk_embedding_failures (x);")
  const status = inspectLocalDb(root)
  assert.match(JSON.stringify(status), /meta_table_missing/u)
  assert.equal(status.document_vectors.vectors_indexed, 0)
})

test("an unreadable last-indexed time and failure rows without their columns are reported, not thrown", async () => {
  const root = await deskWithIndex(`${FULL_CHUNKS} CREATE TABLE text_vectors (vector_space TEXT, text_hash TEXT); CREATE TABLE chunk_embedding_failures (x);
    CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('last_indexed_at', 'not a time');`)
  const status = inspectLocalDb(root)
  assert.match(JSON.stringify(status), /last_indexed_at_invalid/u)
  assert.equal(status.document_vectors.vectors_indexed, 0)
})

test("document vectors read as missing, then partial, as the active vectors arrive", async () => {
  const { ACTIVE_EMBEDDING_SPEC: spec } = await import("../../../../../plugins/desk/mcp/src/indexer/spec.js")
  const { ACTIVE_VECTOR_SPACE } = await import("../../../../../plugins/desk/mcp/src/indexer/text-vectors.js")
  const rows = ["a", "b"].map((hash) => `('k-${hash}', '${hash}', '${spec.id}', '${spec.chunker_id}', '${spec.normalization_id}')`).join(", ")
  assert.equal(inspectLocalDb(await deskWithIndex(`${FULL_CHUNKS} INSERT INTO chunks VALUES ${rows};`)).document_vectors.state, "missing")
  const vectors = `${FULL_CHUNKS} INSERT INTO chunks VALUES ${rows}; CREATE TABLE text_vectors (vector_space TEXT, text_hash TEXT);`
  assert.equal(inspectLocalDb(await deskWithIndex(vectors)).document_vectors.state, "missing")
  const partial = await deskWithIndex(`${vectors} INSERT INTO text_vectors VALUES ('${ACTIVE_VECTOR_SPACE}', 'a');`)
  assert.equal(inspectLocalDb(partial).document_vectors.state, "partial")
})

test("the active index and a stored generation read as nothing without a desk, an index or a generation id", async () => {
  const { readActiveIndex, readCommittedContent } = await import("../../../../../plugins/desk/mcp/src/db/status-read.js")
  assert.equal(readActiveIndex(null), null)
  assert.equal(readActiveIndex(await mkTempRoot("desk-status-read-none-")), null)
  assert.equal(readCommittedContent("/nowhere", "1"), null)
})
