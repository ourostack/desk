// index.test.js — end-to-end indexer behaviour against a small fixture desk.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"

import { rebuildIndex } from "../../../../../plugins/desk/mcp/src/indexer/index.js"
import { openDb, closeDb } from "../../../../../plugins/desk/mcp/src/db/init.js"
import { chunkTextHash } from "../../../../../plugins/desk/mcp/src/indexer/text-hash.js"
import { mkTempRoot } from "../_temp_roots.js"

async function mkRoot() {
  return mkTempRoot("desk-idx-")
}
async function w(root, rel, body) {
  const abs = path.join(root, rel)
  await fs.mkdir(path.dirname(abs), { recursive: true })
  await fs.writeFile(abs, body, "utf8")
}

test("empty desk → empty index", async () => {
  const root = await mkRoot()
  const summary = await rebuildIndex(root)
  assert.equal(summary.docs_indexed, 0)
  assert.equal(summary.docs_skipped, 0)
  assert.equal(summary.chunks_inserted, 0)
})

test("small fixture desk → expected doc + chunk counts", async () => {
  const root = await mkRoot()
  await w(
    root,
    "trackA/task-1/task.md",
    "---\nstatus: processing\nschema_version: 1\n---\n# T1\n\nbody one\n\n## H2\n\nbody two",
  )
  await w(root, "trackA/task-1/planning.md", "## Plan\n\nplan body")
  await w(root, "trackA/task-1/doing.md", "# Doing\n\ndoing body")
  await w(root, "_meta/friction.md", "# Friction\n\nentry")

  const summary = await rebuildIndex(root)
  assert.equal(summary.docs_indexed, 4)
  assert.ok(summary.chunks_inserted >= 4)

  const db = openDb(root)
  try {
    const docCount = db.prepare("SELECT count(*) AS c FROM docs").get().c
    assert.equal(docCount, 4)
    const chunkCount = db.prepare("SELECT count(*) AS c FROM chunks").get().c
    assert.ok(chunkCount >= 4, `expected >=4 chunks; got ${chunkCount}`)

    // refs_graph picked up planning_of + doing_of for the trackA/task-1
    // task.
    const refs = db.prepare("SELECT ref_kind FROM refs_graph").all().map((r) => r.ref_kind)
    assert.ok(refs.includes("planning_of"), `refs=${refs.join(",")}`)
    assert.ok(refs.includes("doing_of"), `refs=${refs.join(",")}`)
  } finally {
    closeDb(db)
  }
})

test("re-running on an unchanged desk is a no-op (hash unchanged)", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")
  await w(root, "trackA/task-1/planning.md", "body")

  const first = await rebuildIndex(root)
  assert.equal(first.docs_indexed, 2)
  assert.equal(first.docs_skipped, 0)

  const second = await rebuildIndex(root)
  assert.equal(second.docs_indexed, 0, "no docs should reindex on no-op run")
  assert.equal(second.docs_skipped, 2)
})

test("each section stores the hash of its text, unchanged across rebuilds", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/doing.md", "## Stable\n\nsame body\n")

  await rebuildIndex(root)
  const read = () => {
    const db = openDb(root)
    try {
      return db.prepare("SELECT text, text_hash FROM chunks ORDER BY chunk_index").all()
    } finally {
      closeDb(db)
    }
  }
  const first = read()
  assert.ok(first.length >= 1)
  for (const row of first) assert.equal(row.text_hash, chunkTextHash(row.text))

  const second = await rebuildIndex(root)
  assert.equal(second.docs_skipped, 1)
  assert.deepEqual(read(), first)
})

test("archived docs keep archive metadata and every section is in the exact-word index", async () => {
  const root = await mkRoot()
  await w(root, "trackA/_archive/old-task/task.md", "---\nstatus: done\n---\narchived hybrid body")

  const summary = await rebuildIndex(root)
  assert.equal(summary.docs_indexed, 1)

  const db = openDb(root)
  try {
    const doc = db.prepare("SELECT is_archived FROM docs WHERE path = ?").get("trackA/_archive/old-task/task.md")
    assert.equal(doc.is_archived, 1)
    const hits = db.prepare("SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?").all("hybrid")
    assert.equal(hits.length, 1)
  } finally {
    closeDb(db)
  }
})

test("an in-memory index can be rebuilt through a handle the caller owns", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")
  const db = openDb(root, { dbPath: ":memory:" })
  try {
    const summary = await rebuildIndex(root, { db })
    assert.equal(summary.docs_indexed, 1)
    assert.equal(db.open, true, "a caller's handle stays open")
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM docs").get().n, 1)
  } finally { closeDb(db) }
})

test("an aborted signal stops the rebuild before anything is written", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "# task")
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(rebuildIndex(root, { signal: controller.signal }), { name: "AbortError" })
})

test("modifying one doc → that doc reindexed, others skipped", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")
  await w(root, "trackA/task-1/planning.md", "plan v1")
  await w(root, "trackA/task-2/task.md", "---\nstatus: blocked\n---\nbody")

  await rebuildIndex(root)

  // Touch one file with new content.
  await w(root, "trackA/task-1/planning.md", "plan v2 has different content")
  // Bump mtime forward in case the FS gives us the same-second mtime.
  const future = new Date(Date.now() + 5000)
  await fs.utimes(path.join(root, "trackA/task-1/planning.md"), future, future)

  const summary = await rebuildIndex(root)
  assert.equal(summary.docs_indexed, 1)
  assert.equal(summary.docs_skipped, 2)
})

test("deleting a doc removes it from the index on next pass", async () => {
  const root = await mkRoot()
  await w(root, "trackA/task-1/task.md", "---\nstatus: processing\n---\nbody")
  await w(root, "trackA/task-1/planning.md", "plan")

  await rebuildIndex(root)

  await fs.unlink(path.join(root, "trackA/task-1/planning.md"))

  const summary = await rebuildIndex(root)
  assert.equal(summary.docs_removed, 1)

  const db = openDb(root)
  try {
    const remaining = db.prepare("SELECT path FROM docs").all().map((r) => r.path)
    assert.deepEqual(remaining, ["trackA/task-1/task.md"])
  } finally {
    closeDb(db)
  }
})

test("a lexical failure rolls back deletions, earlier documents, chunks and refs", async () => {
  const root = await mkRoot()
  await w(root, "track/a/task.md", "# before")
  await w(root, "track/a/planning.md", "# plan")
  await w(root, "track/removed/task.md", "# removed later")
  const db = openDb(root)
  try {
    await rebuildIndex(root, { db })
    const snapshot = () => ["docs", "chunks", "refs_graph", "meta"].map((table) =>
      db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all())
    const before = snapshot()
    await fs.rm(path.join(root, "track", "removed"), { recursive: true })
    await w(root, "track/a/task.md", "# after")
    await w(root, "track/z/task.md", "# fail-late")
    db.exec(`CREATE TRIGGER reject_late_chunk BEFORE INSERT ON chunks
      WHEN NEW.text LIKE '%fail-late%' BEGIN SELECT RAISE(ABORT, 'injected lexical failure'); END`)
    await assert.rejects(rebuildIndex(root, { db }), /injected lexical failure/)
    assert.deepEqual(snapshot(), before)
  } finally { closeDb(db) }
})

test("an invalid tombstone ledger stops a rebuild before any document is indexed", async () => {
  const root = await mkRoot()
  await w(root, "track/a/task.md", "# task")
  const pluginRoot = await mkTempRoot("desk-idx-plugin-")
  await w(pluginRoot, "artifacts/tombstones/tombstones.jsonl", "{not json\n")
  await assert.rejects(rebuildIndex(root, { tombstones: { pluginRoot } }), (error) => {
    assert.equal(error.code, "artifact_tombstone_ledger_invalid")
    assert.deepEqual(error.diagnostics, ["tombstone ledger line 1 must be valid JSON"])
    return true
  })
  const db = openDb(root)
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM docs").get().n, 0)
  } finally { closeDb(db) }
})
