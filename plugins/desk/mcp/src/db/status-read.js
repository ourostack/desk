import { existsSync } from "node:fs"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { indexDbPath } from "./init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"

const DB_SCHEMA = { id: "desk-index", version: 1 }

export function inspectLocalDb(deskRoot) {
  const dbPath = indexDbPath(deskRoot)
  if (!existsSync(dbPath)) {
    return unavailableLocalDb(dbPath, "missing")
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    sqliteVec.load(db)
    tableExists(db, "chunks")
  } catch {
    // An unreadable index is reported, never thrown: the readiness controller moves it aside and rebuilds it.
    db.close()
    return unavailableLocalDb(dbPath, "corrupt")
  }
  try {
    const chunksTableExists = tableExists(db, "chunks")
    const vectorsTableExists = tableExists(db, "chunk_vecs")
    const embeddingFailuresTableExists = tableExists(db, "chunk_embedding_failures")
    const lexicalAvailable = tableExists(db, "chunks_fts")
    const chunksTotal = chunksTableExists ? countRows(db, "chunks") : 0
    const vectorsIndexed = countActiveVectors(db, {
      chunksTableExists,
      vectorsTableExists,
    })
    const missingVectors = Math.max(0, chunksTotal - vectorsIndexed)
    const knownUnembeddableVectors = countKnownUnembeddableVectors(db, {
      chunksTableExists,
      vectorsTableExists,
      embeddingFailuresTableExists,
    })
    const repairableMissingVectors = Math.max(0, missingVectors - knownUnembeddableVectors)
    const freshness = inspectFreshness(deskRoot, db)
    return {
      local_db: {
        path: dbPath,
        exists: true,
        schema: DB_SCHEMA,
        state: "available",
        freshness,
      },
      lexical_index: {
        available: lexicalAvailable,
        state: ["missing", "available"][Number(lexicalAvailable)],
      },
      document_vectors: {
        state: documentVectorState({
          chunksTotal,
          missingVectors,
          repairableMissingVectors,
          vectorsIndexed,
          vectorsTableExists,
        }),
        chunks_total: chunksTotal,
        vectors_indexed: vectorsIndexed,
        missing_vectors: missingVectors,
        known_unembeddable_vectors: knownUnembeddableVectors,
        repairable_missing_vectors: repairableMissingVectors,
        coverage: vectorsIndexed / Math.max(1, chunksTotal),
      },
    }
  } finally {
    db.close()
  }
}

export function unavailableLocalDb(dbPath, state) {
  return {
    local_db: {
      path: dbPath,
      exists: false,
      schema: { id: DB_SCHEMA.id, version: null },
      state,
      freshness: { state: "unknown", reason: state },
    },
    lexical_index: {
      available: false,
      state: state === "missing" ? "missing_local_db" : state,
    },
    document_vectors: {
      state: state === "missing" ? "missing_local_db" : state,
      chunks_total: 0,
      vectors_indexed: 0,
      missing_vectors: 0,
      known_unembeddable_vectors: 0,
      repairable_missing_vectors: 0,
      coverage: null,
    },
  }
}

function documentVectorState({
  chunksTotal,
  missingVectors,
  repairableMissingVectors,
  vectorsIndexed,
  vectorsTableExists,
}) {
  if (!vectorsTableExists) return "missing"
  if (chunksTotal === 0) return "available"
  if (vectorsIndexed === 0 && repairableMissingVectors > 0) return "missing"
  return repairableMissingVectors > 0 ? "partial" : "available"
}

function inspectFreshness(deskRoot, db) {
  if (!tableExists(db, "meta")) {
    return { state: "unknown", reason: "meta_table_missing" }
  }
  const lastIndexedAt = metaValue(db, "last_indexed_at")
  if (lastIndexedAt === null) {
    return { state: "unknown", reason: "last_indexed_at_missing" }
  }
  const indexedMs = Date.parse(lastIndexedAt)
  if (Number.isNaN(indexedMs)) {
    return { state: "unknown", reason: "last_indexed_at_invalid", last_indexed_at: lastIndexedAt }
  }
  return {
    state: "unknown",
    reason: "requires_controller_proof",
    last_indexed_at: lastIndexedAt,
  }
}

function countRows(db, table) {
  return db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count
}

function tableExists(db, table) {
  return db.prepare("SELECT 1 AS found FROM sqlite_master WHERE name = ?").get(table) !== undefined
}

function tableHasColumns(db, table, columns) {
  const names = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name))
  return columns.every((column) => names.has(column))
}

function countActiveVectors(db, { chunksTableExists, vectorsTableExists }) {
  if (!chunksTableExists || !vectorsTableExists) return 0
  if (!tableHasColumns(db, "chunks", [
    "embedding_spec_id",
    "chunker_id",
    "normalization_id",
  ])) {
    return 0
  }
  return db.prepare(
    `SELECT COUNT(*) AS count
     FROM chunks c
     JOIN chunk_vecs v ON v.chunk_id = c.id
     WHERE c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  ).count
}

function countKnownUnembeddableVectors(db, {
  chunksTableExists,
  vectorsTableExists,
  embeddingFailuresTableExists,
}) {
  if (!chunksTableExists || !vectorsTableExists || !embeddingFailuresTableExists) return 0
  if (!tableHasColumns(db, "chunks", [
    "chunk_key",
    "text_hash",
    "embedding_spec_id",
    "chunker_id",
    "normalization_id",
  ])) {
    return 0
  }
  if (!tableHasColumns(db, "chunk_embedding_failures", [
    "chunk_key",
    "text_hash",
    "embedding_spec_id",
    "chunker_id",
    "normalization_id",
  ])) {
    return 0
  }
  return db.prepare(
    `SELECT COUNT(*) AS count
     FROM chunks c
     LEFT JOIN chunk_vecs v ON v.chunk_id = c.id
     JOIN chunk_embedding_failures f
       ON f.chunk_key = c.chunk_key
      AND f.text_hash = c.text_hash
      AND f.embedding_spec_id = c.embedding_spec_id
      AND f.chunker_id = c.chunker_id
      AND f.normalization_id = c.normalization_id
     WHERE v.chunk_id IS NULL
       AND c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  ).count
}

function metaValue(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  return row?.value ?? null
}

export function openSnapshot(deskRoot) {
  if (!deskRoot || !existsSync(indexDbPath(deskRoot))) return null
  const db = new Database(indexDbPath(deskRoot), { readonly: true, fileMustExist: true })
  try {
    sqliteVec.load(db)
    db.exec("BEGIN")
    const generation = db.prepare(`
      SELECT g.id, g.event_cursor, g.schema_version, g.chunker_id, g.normalization_id,
             g.embedding_spec, g.tombstone_identity, g.policy_identity
      FROM lexical_generations g
      JOIN meta m ON m.key = 'active_lexical_generation' AND m.value = CAST(g.id AS TEXT)
      JOIN readiness_operations o ON o.id = g.operation_id AND o.status = 'committed'
    `).get()
    const covered = db.prepare("SELECT value FROM meta WHERE key = 'covered_event_cursor'").get()
    const activeEmbeddingSpecId = db.prepare("SELECT value FROM meta WHERE key = 'active_embedding_spec_id'").get()?.value ?? null
    const vectorsIndexed = db.prepare(
      `SELECT COUNT(*) AS n
       FROM chunks c
       JOIN chunk_vecs v ON v.chunk_id = c.id
       WHERE c.embedding_spec_id = ?
         AND c.chunker_id = ?
         AND c.normalization_id = ?`,
    ).get(
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
    ).n
    const chunksTotal = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n
    const cursor = generation ? JSON.parse(generation.event_cursor) : null
    return { db, generation: generation?.id ?? null, identities: generation, cursor,
      covered: covered ? JSON.parse(covered.value) : null,
      semantic: {
        active_embedding_spec_id: activeEmbeddingSpecId,
        chunks_total: chunksTotal,
        vectors_indexed: vectorsIndexed,
        missing_vectors: Math.max(0, chunksTotal - vectorsIndexed),
      } }
  } catch (error) {
    db.close()
    throw error
  }
}

export function inspectStatusIndex(deskRoot) {
  const snapshot = openSnapshot(deskRoot)
  try {
    if (!snapshot) return null
    const { db, ...metadata } = snapshot
    return metadata
  } finally {
    snapshot?.db.close()
  }
}
