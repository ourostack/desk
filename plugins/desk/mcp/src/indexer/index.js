// index.js — top-level indexer orchestrator.
//
// Walks the desk root, parses each doc, hash-compares to the existing index,
// re-chunks + re-embeds + upserts on change, and refreshes refs_graph.
// Idempotent — running it twice on a clean tree results in 0 reindexed docs.
//
// Soft-fail: if Ollama is down, FTS5 still gets populated; text_vectors rows
// for new section texts are left absent so semantic search degrades gracefully.

import { promises as fs } from "node:fs"
import { createHash } from "node:crypto"
import { openDb, closeDb, setMeta } from "../db/init.js"
import {
  filterTombstonedDocuments,
  loadTombstoneLedger,
  tombstoneDecisionForDoc,
  tombstoneStatusForDocuments,
} from "../artifacts/tombstones.js"
import { commitLexicalGeneration } from "../readiness/generations.js"
import { stableStringify } from "../readiness/identity.js"
import { discover } from "./discover.js"
import { chunkBody } from "./chunk.js"
import {
  embedChunksDetailed,
  EMBEDDING_DIM,
  isChunkLocalEmbeddingFailure,
  resolveEmbeddingModel,
} from "./embed.js"
import { computeRefs } from "./refs.js"
import {
  ACTIVE_EMBEDDING_SPEC,
  chunkIdentity,
  writeActiveEmbeddingSpec,
} from "./spec.js"
import { importVectorPacks } from "./vector-packs.js"
import { discardedVector, prepareTextVectorSave, removeUnusableVectors, vectorSpaceFor } from "./text-vectors.js"

// Vectors are saved after every this many embeddings, so a long pass keeps what it finished.
const EMBED_SAVE_BATCH_SIZE = 32
const MISSING_VECTOR_ROUNDS = 3
const ACTIVE_CHUNK_FAILURE_JOIN = `
  f.chunk_key = c.chunk_key AND
  f.text_hash = c.text_hash AND
  f.embedding_spec_id = c.embedding_spec_id AND
  f.chunker_id = c.chunker_id AND
  f.normalization_id = c.normalization_id
`

/**
 * Run the indexer against `deskRoot`. Creates/refreshes
 * `<deskRoot>/.state/desk-index.sqlite` and returns a summary.
 *
 * @param {string} deskRoot
 * @param {object} [opts]
 * @param {object} [opts.db] — reuse an already-open DB handle (tests).
 * @param {string} [opts.dbPath] — override DB path (tests).
 * @param {object} [opts.embed] — override embed options (endpoint/model/fetch).
 * @param {boolean} [opts.skipEmbed] — skip embedding entirely (testing).
 * @param {boolean} [opts.reembedMissing] — accepted for older callers. Every
 *   section text without a vector is embedded on each run that embeds,
 *   whichever document it is in, and no document is reindexed for it.
 * @param {boolean} [opts.embedChangedOnly] — embed only the sections of the
 *   documents this run reindexes (the caller found the embedding service not
 *   answering, so it tries only the new text). Ignored with reembedMissing.
 * @param {object|null} [opts.eventCursor] — journal identity/sequence captured before discovery.
 * @param {object} [opts.identities] — controller policy_identity recorded with the generation.
 * @param {object} [opts.vectorPacks] — import shared vector packs before
 *   live embedding generation.
 * @param {string} [opts.vectorPacks.pluginRoot] — plugin root containing
 *   artifacts/vector-packs/<embedding-spec-id>/.
 * @returns {Promise<{ docs_indexed: number, docs_skipped: number,
 *                     docs_removed: number, chunks_inserted: number,
 *                     semantic_warnings: number }>}
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
    semantic_warnings: 0,
    embedding_failures_recorded: 0,
  }

  try {
    throwIfAborted(opts.signal)
    const discoveredRaw = await discover(deskRoot, { signal: opts.signal })
    const ledger = await loadTombstoneLedger({ pluginRoot: opts.tombstones?.pluginRoot })
    if (!ledger.valid) {
      const error = new Error("artifact tombstone ledger is invalid")
      error.code = "artifact_tombstone_ledger_invalid"
      error.diagnostics = ledger.diagnostics
      throw error
    }
    const discovered = discoveredRaw.filter((doc) => !tombstoneDecisionForDoc({ ledger, doc }).tombstoned)
    summary.docs_tombstoned = discoveredRaw.length - discovered.length
    throwIfAborted(opts.signal)
    const discoveredByPath = new Map(discovered.map((d) => [d.path, d]))
    const reindexedDocIds = new Set()
    const identities = {
      schema_version: 1,
      chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
      normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
      embedding_spec: ACTIVE_EMBEDDING_SPEC,
      tombstone_identity: `sha256:${createHash("sha256").update(stableStringify(ledger.rows)).digest("hex")}`,
      policy_identity: opts.identities?.policy_identity ?? "desk-lexical-required-v1",
    }

    summary.lexical_generation = commitLexicalGeneration({
      db, documents: discovered, eventCursor: opts.eventCursor ?? null, identities, writer: opts.writer,
      apply() {
        writeActiveEmbeddingSpec(db, setMeta)
        const existing = db.prepare("SELECT id, path, hash, mtime FROM docs").all()
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
          const existingRow = existingByPath.get(doc.path)
          if (existingRow && existingRow.hash === doc.hash &&
              !docNeedsActiveChunkMetadata(db, existingRow.id, doc)) {
            summary.docs_skipped += 1
            continue
          }
          reindexedDocIds.add(indexOneDoc(db, doc, summary))
          summary.docs_indexed += 1
        }
        refreshRefs(db, discovered)
        pruneStaleEmbeddingFailures(db)
        setMeta(db, "embedding_dim", String(EMBEDDING_DIM))
        setMeta(db, "embedding_model", opts.embed?.model ?? "nomic-embed-text")
        throwIfAborted(opts.signal)
      },
    })

    if (opts.vectorPacks?.pluginRoot) {
      summary.vector_packs = vectorPackImportStatus(await importVectorPackRoots({
        db,
        vectorPacks: opts.vectorPacks,
        signal: opts.signal,
      }))
    }

    if (!opts.skipEmbed) {
      throwIfAborted(opts.signal)
      // Every text without a vector, not only those of the documents just indexed: an older build sharing the desk may have indexed a change first.
      await embedMissingVectors(db, opts, summary, opts.embedChangedOnly && !opts.reembedMissing ? reindexedDocIds : null)
    }
    summary.vector_cleanup = await removeUnusableVectors(db)

  } finally {
    if (ownsDb) closeDb(db)
  }

  return summary
}

async function importVectorPackRoots({ db, vectorPacks, signal }) {
  const roots = uniquePaths([
    vectorPacks.pluginRoot,
    ...(Array.isArray(vectorPacks.fallbackPluginRoots)
      ? vectorPacks.fallbackPluginRoots
      : []),
  ])
  const combined = emptyVectorPackSummary()
  for (const pluginRoot of roots) {
    try {
      const rootSummary = await importVectorPacks({ db, pluginRoot, signal })
      mergeVectorPackSummary(combined, rootSummary)
    } catch (error) {
      if (!vectorPacks.ignoreInvalidRoots || error?.name === "AbortError") throw error
      combined.import_errors.push({
        pluginRoot,
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return combined
}

function emptyVectorPackSummary() {
  return {
    packs_considered: 0,
    packs_imported: 0,
    rows_imported: 0,
    rows_skipped_duplicate: 0,
    rows_skipped_missing_chunk: 0,
    import_errors: [],
  }
}

function mergeVectorPackSummary(target, source) {
  target.packs_considered += source.packs_considered
  target.packs_imported += source.packs_imported
  target.rows_imported += source.rows_imported
  target.rows_skipped_duplicate += source.rows_skipped_duplicate
  target.rows_skipped_missing_chunk += source.rows_skipped_missing_chunk
}

function uniquePaths(values) {
  return [...new Set(values.filter((value) =>
    typeof value === "string" && value.trim().length > 0
  ))]
}

function vectorPackImportStatus(summary) {
  return {
    import_state: summary.rows_imported > 0
      ? "imported"
      : summary.packs_imported > 0
        ? "validated"
        : "absent",
    ...summary,
  }
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return
  const err = new Error("operation aborted")
  err.name = "AbortError"
  throw err
}

function docNeedsActiveChunkMetadata(db, docId, doc) {
  const expectedKeys = chunkBody(doc.body).map((chunk) =>
    chunkIdentity({ docPath: doc.path, chunk }).chunk_key
  )
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS total,
         COALESCE(SUM(
           CASE
             WHEN chunk_key IS NULL OR
                  text_hash IS NULL OR
                  embedding_spec_id IS NULL OR
                  embedding_spec_id != ? OR
                  chunker_id IS NULL OR
                  chunker_id != ? OR
                  normalization_id IS NULL OR
                  normalization_id != ?
             THEN 1 ELSE 0 END
         ), 0) AS stale
       FROM chunks
       WHERE doc_id = ?`,
    )
    .get(
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
      docId,
    )
  if (row.stale > 0) return true
  if (row.total !== expectedKeys.length) return true
  if (expectedKeys.length === 0) return false
  const storedKeys = db
    .prepare(
      `SELECT chunk_key
       FROM chunks
       WHERE doc_id = ?
       ORDER BY chunk_index`,
    )
    .all(docId)
    .map((chunk) => chunk.chunk_key)
  return storedKeys.some((chunkKey, index) => chunkKey !== expectedKeys[index])
}

function indexOneDoc(db, doc, summary) {
  const chunks = chunkBody(doc.body).map((chunk) => ({
    ...chunk,
    ...chunkIdentity({ docPath: doc.path, chunk }),
  }))

  // Upsert in a transaction so a crash mid-doc doesn't leave a half-indexed row.
  const txn = db.transaction(() => {
    // Upsert docs row.
    const upsert = db.prepare(
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
    )
    const row = upsert.get({
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
    // rewriting them all. The triggers on the chunks table keep chunks_fts in
    // sync. Vectors live by text in text_vectors and stay; a replaced row's
    // entry in the old row-keyed table goes with it, so older builds that read
    // it never find a vector under a vanished row.
    const stored = new Map()
    const deleteChunk = db.prepare("DELETE FROM chunks WHERE id = ?")
    const deleteRowVector = db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?")
    const remove = (id) => {
      deleteRowVector.run(BigInt(id))
      deleteChunk.run(id)
    }
    for (const old of db.prepare("SELECT * FROM chunks WHERE doc_id = ? ORDER BY id").all(docId)) {
      if (stored.has(old.chunk_index)) remove(old.id)
      else stored.set(old.chunk_index, old)
    }

    const insertChunk = db.prepare(
      `INSERT INTO chunks (
         doc_id,
         chunk_index,
         chunk_key,
         text_hash,
         embedding_spec_id,
         chunker_id,
         normalization_id,
         text,
         heading,
         start_offset,
         end_offset
       )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    for (const c of chunks) {
      const old = stored.get(c.index)
      stored.delete(c.index)
      if (old && sameChunk(old, c)) continue
      if (old) remove(old.id)
      insertChunk.run(
        docId,
        c.index,
        c.chunk_key,
        c.text_hash,
        c.embedding_spec_id,
        c.chunker_id,
        c.normalization_id,
        c.text,
        c.heading,
        c.start_offset,
        c.end_offset,
      )
      summary.chunks_inserted += 1
    }
    for (const old of stored.values()) remove(old.id)
    return docId
  })
  return txn()
}

function sameChunk(row, chunk) {
  return row.chunk_key === chunk.chunk_key &&
    row.text_hash === chunk.text_hash &&
    row.embedding_spec_id === chunk.embedding_spec_id &&
    row.chunker_id === chunk.chunker_id &&
    row.normalization_id === chunk.normalization_id &&
    row.text === chunk.text &&
    row.heading === chunk.heading &&
    row.start_offset === chunk.start_offset &&
    row.end_offset === chunk.end_offset
}

// Embeds each section text that has no vector yet, once however many sections share it; with `docIds`, only those documents' sections.
async function embedMissingVectors(db, opts, summary, docIds) {
  summary.vectors_saved = 0
  summary.vectors_discarded = 0
  // A vector is discarded when its section vanished during the pass, as when an older build re-commits a stale copy of the document; look once more, in case the text is back.
  for (let round = 0; round < MISSING_VECTOR_ROUNDS; round += 1) {
    const discarded = summary.vectors_discarded
    if (!await embedMissingRound(db, opts, summary, docIds)) return
    if (summary.vectors_discarded === discarded) return
  }
}

// One pass over the missing texts. Returns false when there was nothing to embed or the embedding service failed.
async function embedMissingRound(db, opts, summary, docIds) {
  const embedOptions = opts.embed ?? {}
  const vectorSpace = vectorSpaceFor(resolveEmbeddingModel(embedOptions))
  const rows = db.prepare(
    `SELECT
       c.doc_id,
       c.text,
       c.chunk_key,
       c.text_hash,
       c.embedding_spec_id,
       c.chunker_id,
       c.normalization_id
     FROM chunks c
     LEFT JOIN text_vectors tv ON tv.vector_space = ? AND tv.text_hash = c.text_hash
     LEFT JOIN chunk_embedding_failures f ON ${ACTIVE_CHUNK_FAILURE_JOIN}
     WHERE tv.text_hash IS NULL
       AND c.text_hash IS NOT NULL
       AND f.chunk_key IS NULL
     ORDER BY c.id`,
  ).all(vectorSpace).filter((row) => docIds === null || docIds.has(row.doc_id))
  const missing = new Map()
  for (const row of rows) {
    const entry = missing.get(row.text_hash)
    if (entry) entry.sections.push(row)
    else missing.set(row.text_hash, { text_hash: row.text_hash, text: row.text, sections: [row] })
  }
  if (missing.size === 0) return false

  const saveVector = prepareTextVectorSave(db, vectorSpace)
  const upsertFailure = db.prepare(
    `INSERT INTO chunk_embedding_failures (
       chunk_key,
       text_hash,
       embedding_spec_id,
       chunker_id,
       normalization_id,
       reason,
       message,
       failed_at
     )
     VALUES (@chunk_key, @text_hash, @embedding_spec_id, @chunker_id,
             @normalization_id, @reason, @message, @failed_at)
     ON CONFLICT (
       chunk_key,
       text_hash,
       embedding_spec_id,
       chunker_id,
       normalization_id
     ) DO UPDATE SET
       reason = excluded.reason,
       message = excluded.message,
       failed_at = excluded.failed_at`,
  )
  const deleteFailure = db.prepare(
    `DELETE FROM chunk_embedding_failures
     WHERE chunk_key = @chunk_key
       AND text_hash = @text_hash
       AND embedding_spec_id = @embedding_spec_id
       AND chunker_id = @chunker_id
       AND normalization_id = @normalization_id`,
  )
  // One transaction per batch: the check that the section still exists and the save are one commit. It takes the write lock first, so it waits for another build's commit instead of failing on it.
  const saveTransaction = db.transaction((entries, results, failedAt) => {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const result = results[i]
      if (result.vector) {
        if (saveVector(entry.text_hash, result.vector)) {
          summary.vectors_saved += 1
          for (const section of entry.sections) deleteFailure.run(section)
        } else {
          summary.vectors_discarded += 1
        }
      } else if (isChunkLocalEmbeddingFailure(result.diagnostic)) {
        for (const section of entry.sections) {
          upsertFailure.run({
            ...section,
            reason: result.diagnostic.reason,
            message: result.diagnostic.message,
            failed_at: failedAt,
          })
          summary.embedding_failures_recorded += 1
        }
      }
    }
  })

  const save = (...args) => saveTransaction.immediate(...args)
  const entries = []
  const known = []
  for (const entry of missing.values()) {
    const vector = discardedVector(vectorSpace, entry.text_hash)
    if (vector) known.push({ entry, vector })
    else entries.push(entry)
  }
  // Texts back after their section vanished mid-pass are saved from memory, not embedded again.
  save(known.map(({ entry }) => entry), known.map(({ vector }) => ({ vector })), new Date().toISOString())
  for (let start = 0; start < entries.length; start += EMBED_SAVE_BATCH_SIZE) {
    const batch = entries.slice(start, start + EMBED_SAVE_BATCH_SIZE)
    const results = await embedChunksDetailed(batch.map((entry) => entry.text), embedOptions)
    save(batch, results, new Date().toISOString())
    const serviceFailure = results.some((result) => (
      result.vector == null && !isChunkLocalEmbeddingFailure(result.diagnostic)
    ))
    if (serviceFailure) {
      // The run stops embedding here, so this is its one log line; downstream
      // tools surface the semantic_unavailable warning at query time.
      summary.semantic_warnings += 1
      console.warn(
        "[desk-mcp] semantic_unavailable: Ollama embeddings endpoint did not respond; index built with FTS5 only",
      )
      return false
    }
  }
  return true
}

function pruneStaleEmbeddingFailures(db) {
  const result = db.prepare(
    `DELETE FROM chunk_embedding_failures
     WHERE NOT EXISTS (
       SELECT 1
       FROM chunks c
       WHERE c.chunk_key = chunk_embedding_failures.chunk_key
         AND c.text_hash = chunk_embedding_failures.text_hash
         AND c.embedding_spec_id = chunk_embedding_failures.embedding_spec_id
         AND c.chunker_id = chunk_embedding_failures.chunker_id
         AND c.normalization_id = chunk_embedding_failures.normalization_id
     )`,
  ).run()
  return result.changes
}

function refreshRefs(db, docs) {
  const edges = computeRefs(docs)
  const txn = db.transaction(() => {
    db.exec("DELETE FROM refs_graph")
    if (!edges.length) return
    const lookup = db.prepare("SELECT id FROM docs WHERE path = ?")
    const ins = db.prepare(
      "INSERT OR IGNORE INTO refs_graph (src_doc_id, dst_doc_id, ref_kind) VALUES (?, ?, ?)",
    )
    for (const e of edges) {
      ins.run(lookup.get(e.from).id, lookup.get(e.to).id, e.ref_kind)
    }
  })
  txn()
}

/**
 * Check whether the index at `dbPath` is fresh — i.e., no markdown file
 * under `deskRoot` has an mtime newer than the recorded last_indexed_at.
 *
 * Cheap heuristic; the real correctness invariant is the hash-compare
 * inside rebuildIndex. This is just for the boot-time "do we need to do
 * anything?" decision.
 */
export async function isIndexFresh(deskRoot, db, { signal, tombstones } = {}) {
  const row = db
    .prepare("SELECT value FROM meta WHERE key = 'last_indexed_at'")
    .get()
  if (!row) return false
  const indexedMs = Date.parse(row.value)
  if (Number.isNaN(indexedMs)) return false
  const tombstoneStatus = await tombstoneStatusForDocuments({
    pluginRoot: tombstones?.pluginRoot,
    docs: db.prepare("SELECT path, hash FROM docs").all(),
  })
  if (tombstoneStatus.tombstoned) return false
  // Walk discover() targets and bail on the first newer mtime.
  const docs = await discover(deskRoot, { signal })
  for (const d of docs) {
    throwIfAborted(signal)
    if (d.mtime > indexedMs) return false
  }
  return true
}
