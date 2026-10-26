// index.js — builds the exact-word search index.
//
// Walks the desk root, parses each doc, hash-compares to the existing index,
// re-chunks and upserts on change, and refreshes refs_graph. Idempotent:
// running it twice on a clean tree reindexes nothing. Section vectors are not
// made here; the search engine (src/search/engine.js) embeds sections by their
// text_hash in the background.

import { openDb, closeDb } from "../db/init.js"
import { isTombstoned, loadTombstoneLedger } from "../artifacts/tombstones.js"
import { discover } from "./discover.js"
import { chunkBody } from "./chunk.js"
import { computeRefs } from "./refs.js"
import { chunkTextHash } from "./text-hash.js"

/**
 * Run the indexer against `deskRoot` and return a summary.
 *
 * @param {string} deskRoot
 * @param {object} [opts]
 * @param {object} [opts.db] — reuse an already-open DB handle (the search engine's in-memory one).
 * @param {string} [opts.dbPath] — override DB path (tests).
 * @param {object} [opts.tombstones] — `{ pluginRoot }` whose redaction ledger keeps documents out of the index.
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ docs_indexed: number, docs_skipped: number,
 *                     docs_removed: number, docs_tombstoned: number,
 *                     chunks_inserted: number }>}
 */
export async function rebuildIndex(deskRoot, opts = {}) {
  const ownsDb = !opts.db
  const db = opts.db ?? openDb(deskRoot, { dbPath: opts.dbPath })

  const summary = {
    docs_indexed: 0,
    docs_skipped: 0,
    docs_removed: 0,
    docs_tombstoned: 0,
    chunks_inserted: 0,
  }

  try {
    throwIfAborted(opts.signal)
    const discoveredRaw = await discover(deskRoot, { signal: opts.signal })
    const tombstones = await loadTombstoneLedger({ pluginRoot: opts.tombstones?.pluginRoot })
    const discovered = discoveredRaw.filter((doc) => !isTombstoned(tombstones, doc))
    summary.docs_tombstoned = discoveredRaw.length - discovered.length
    throwIfAborted(opts.signal)
    const discoveredByPath = new Map(discovered.map((d) => [d.path, d]))

    db.transaction(() => {
      const existing = db.prepare("SELECT id, path, hash FROM docs").all()
      const existingByPath = new Map(existing.map((row) => [row.path, row]))
      const delStmt = db.prepare("DELETE FROM docs WHERE path = ?")
      for (const row of existing) {
        throwIfAborted(opts.signal)
        if (!discoveredByPath.has(row.path)) {
          delStmt.run(row.path)
          summary.docs_removed += 1
        }
      }
      for (const doc of discovered) {
        throwIfAborted(opts.signal)
        if (existingByPath.get(doc.path)?.hash === doc.hash) {
          summary.docs_skipped += 1
          continue
        }
        indexOneDoc(db, doc, summary)
        summary.docs_indexed += 1
      }
      refreshRefs(db, discovered)
    })()
  } finally {
    if (ownsDb) closeDb(db)
  }

  return summary
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error("operation aborted")
  err.name = "AbortError"
  throw err
}

function indexOneDoc(db, doc, summary) {
  const chunks = chunkBody(doc.body).map((chunk) => ({ ...chunk, text_hash: chunkTextHash(chunk.text) }))

  const row = db.prepare(
    `INSERT INTO docs (path, kind, track, task_slug, status, schema_version,
                       created_at, updated_at, hash, mtime, is_archived, frontmatter)
     VALUES (@path, @kind, @track, @task_slug, @status, @schema_version,
             @created_at, @updated_at, @hash, @mtime, @is_archived, @frontmatter)
     ON CONFLICT(path) DO UPDATE SET
       kind=excluded.kind,
       track=excluded.track,
       task_slug=excluded.task_slug,
       status=excluded.status,
       schema_version=excluded.schema_version,
       created_at=excluded.created_at,
       updated_at=excluded.updated_at,
       hash=excluded.hash,
       mtime=excluded.mtime,
       is_archived=excluded.is_archived,
       frontmatter=excluded.frontmatter
     RETURNING id`,
  ).get({
    path: doc.path,
    kind: doc.kind,
    track: doc.track,
    task_slug: doc.task_slug,
    status: doc.status,
    schema_version: doc.schema_version,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    hash: doc.hash,
    mtime: doc.mtime,
    is_archived: doc.is_archived ? 1 : 0,
    frontmatter: JSON.stringify(doc.frontmatter),
  })
  const docId = row.id

  // Replace only the sections that changed. A row is kept when every stored
  // field matches, so an append to a long card writes one row instead of
  // rewriting them all. The triggers on the chunks table keep chunks_fts in sync.
  const stored = new Map()
  const deleteChunk = db.prepare("DELETE FROM chunks WHERE id = ?")
  for (const old of db.prepare("SELECT * FROM chunks WHERE doc_id = ? ORDER BY id").all(docId)) {
    if (stored.has(old.chunk_index)) deleteChunk.run(old.id)
    else stored.set(old.chunk_index, old)
  }

  const insertChunk = db.prepare(
    `INSERT INTO chunks (doc_id, chunk_index, text_hash, text, heading, start_offset, end_offset)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const c of chunks) {
    const old = stored.get(c.index)
    stored.delete(c.index)
    if (old && sameChunk(old, c)) continue
    if (old) deleteChunk.run(old.id)
    insertChunk.run(docId, c.index, c.text_hash, c.text, c.heading, c.start_offset, c.end_offset)
    summary.chunks_inserted += 1
  }
  for (const old of stored.values()) deleteChunk.run(old.id)
}

function sameChunk(row, chunk) {
  return row.text_hash === chunk.text_hash &&
    row.text === chunk.text &&
    row.heading === chunk.heading &&
    row.start_offset === chunk.start_offset &&
    row.end_offset === chunk.end_offset
}

function refreshRefs(db, docs) {
  const edges = computeRefs(docs)
  db.exec("DELETE FROM refs_graph")
  if (!edges.length) return
  const lookup = db.prepare("SELECT id FROM docs WHERE path = ?")
  const ins = db.prepare(
    "INSERT OR IGNORE INTO refs_graph (src_doc_id, dst_doc_id, ref_kind) VALUES (?, ?, ?)",
  )
  for (const e of edges) {
    ins.run(lookup.get(e.from).id, lookup.get(e.to).id, e.ref_kind)
  }
}
