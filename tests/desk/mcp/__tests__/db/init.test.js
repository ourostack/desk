// db/init.test.js — schema applies cleanly, the FTS5 table is present after
// openDb, and the chunks→chunks_fts trigger actually fires.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"

import {
  openDb,
  closeDb,
  runMigrations,
} from "../../../../../plugins/desk/mcp/src/db/init.js"
import { mkTempRoot } from "../_temp_roots.js"

async function tmpRoot() {
  return mkTempRoot("desk-init-")
}

test("openDb creates parent .state dir + applies schema idempotently", async () => {
  const root = await tmpRoot()
  const db = openDb(root)
  try {
    // Re-applying migrations on an already-initialized DB is a no-op.
    assert.doesNotThrow(() => runMigrations(db))
    // .state dir got created.
    const stateDir = path.join(root, ".state")
    const stat = await fs.stat(stateDir)
    assert.ok(stat.isDirectory(), "expected <root>/.state to exist")
  } finally {
    closeDb(db)
  }
})

test("openDb installs all required tables (docs, chunks, refs_graph)", async () => {
  const root = await tmpRoot()
  const db = openDb(root)
  try {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','virtual') ORDER BY name")
      .all()
      .map((r) => r.name)
    for (const t of ["docs", "chunks", "refs_graph"]) {
      assert.ok(rows.includes(t), `missing table ${t}; got: ${rows.join(", ")}`)
    }
  } finally {
    closeDb(db)
  }
})

test("FTS5 virtual table chunks_fts is queryable", async () => {
  const root = await tmpRoot()
  const db = openDb(root)
  try {
    // sqlite_master reports FTS5 as 'table' kind, but the underlying
    // shadow tables (chunks_fts_data etc.) confirm FTS5 wired up correctly.
    const shadow = db
      .prepare("SELECT name FROM sqlite_master WHERE name LIKE 'chunks_fts%'")
      .all()
      .map((r) => r.name)
    assert.ok(
      shadow.includes("chunks_fts"),
      `expected chunks_fts; got: ${shadow.join(", ")}`,
    )
    // A bare MATCH query against an empty FTS table should return zero rows
    // (not error out).
    const hits = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all("hello")
    assert.equal(hits.length, 0)
  } finally {
    closeDb(db)
  }
})

test("insert into chunks triggers a chunks_fts row via the AFTER INSERT trigger", async () => {
  const root = await tmpRoot()
  const db = openDb(root)
  try {
    const docId = db
      .prepare(
        "INSERT INTO docs (path, kind, hash, mtime) VALUES ('a.md','task','h',0) RETURNING id",
      )
      .get().id
    const chunkId = db
      .prepare(
        "INSERT INTO chunks (doc_id, chunk_index, text) VALUES (?, 0, 'hybrid retrieval makes search fast') RETURNING id",
      )
      .get(docId).id

    const hits = db
      .prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH 'hybrid' ORDER BY rowid")
      .all()
    assert.ok(
      hits.some((r) => r.rowid === chunkId),
      `chunk inserted but not in FTS5 index; got hits=${JSON.stringify(hits)}`,
    )
  } finally {
    closeDb(db)
  }
})
