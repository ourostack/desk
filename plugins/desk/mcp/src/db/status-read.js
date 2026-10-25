import { existsSync } from "node:fs"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { indexDbPath } from "./init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { ACTIVE_VECTOR_SPACE } from "../indexer/text-vectors.js"
import { INDEX_WRITER_KEY, readIndexWriter } from "../readiness/index-writer.js"
import { readGenerationContent } from "../readiness/generations.js"

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
    const vectorsTableExists = tableExists(db, "text_vectors")
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
    const tooLong = tooLongSections(db, { chunksTableExists, vectorsTableExists })
    const note = tooLongNote(tooLong, knownUnembeddableVectors)
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
        shortened_sections: tooLong.shortened.sections,
        skipped_sections: tooLong.skipped.sections,
        coverage: vectorsIndexed / Math.max(1, chunksTotal),
        ...(note ? { note } : {}),
      },
    }
  } finally {
    db.close()
  }
}

const NOTE_CARD_LIMIT = 5

// Sections the embedding model refused as too long: shortened ones have a vector for their start, skipped ones none. Both count as covered.
function tooLongSections(db, { chunksTableExists, vectorsTableExists }) {
  const result = { shortened: { sections: 0, cards: [] }, skipped: { sections: 0, cards: [] } }
  if (!chunksTableExists || !vectorsTableExists || !tableExists(db, "docs")) return result
  const rows = db.prepare(
    `SELECT d.path, tv.embedding IS NULL AS skipped, COUNT(*) AS sections
     FROM chunks c
     JOIN docs d ON d.id = c.doc_id
     JOIN text_vectors tv ON tv.vector_space = ? AND tv.text_hash = c.text_hash
     WHERE (tv.embedding IS NULL OR tv.kept_chars IS NOT NULL)
       AND c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?
     GROUP BY d.path, skipped
     ORDER BY d.path`,
  ).all(
    ACTIVE_VECTOR_SPACE,
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  )
  for (const row of rows) {
    const entry = row.skipped ? result.skipped : result.shortened
    entry.sections += row.sections
    entry.cards.push(row.path)
  }
  return result
}

const sectionCount = (count) => count === 1 ? "1 section" : `${count} sections`

function cardList(cards) {
  const named = cards.slice(0, NOTE_CARD_LIMIT).join(", ")
  return cards.length > NOTE_CARD_LIMIT ? `${named} and ${cards.length - NOTE_CARD_LIMIT} more` : named
}

// Says in plain words which sections the embedding model found too long, and that exact-word search still finds them.
function tooLongNote({ shortened, skipped }, waiting) {
  const parts = []
  if (shortened.sections > 0) {
    parts.push(`${sectionCount(shortened.sections)} ${shortened.sections === 1 ? "was" : "were"} too long for the embedding model and ${shortened.sections === 1 ? "was" : "were"} shortened, so meaning-based search reads only the start (${cardList(shortened.cards)})`)
  }
  if (skipped.sections > 0) {
    parts.push(`${sectionCount(skipped.sections)} ${skipped.sections === 1 ? "was" : "were"} too long even when shortened and ${skipped.sections === 1 ? "is" : "are"} skipped by meaning-based search (${cardList(skipped.cards)})`)
  }
  if (waiting > 0) {
    parts.push(`${sectionCount(waiting)} refused as too long by an older Desk build ${waiting === 1 ? "waits" : "wait"} to be shortened`)
  }
  if (parts.length === 0) return null
  return `${parts.join("; ")}. Exact-word search (desk_search) still finds ${shortened.sections + skipped.sections + waiting === 1 ? "it" : "them"} in full.`
}

function unavailableLocalDb(dbPath, state) {
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
      shortened_sections: 0,
      skipped_sections: 0,
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
     JOIN text_vectors tv ON tv.vector_space = ? AND tv.text_hash = c.text_hash
     WHERE c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_VECTOR_SPACE,
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
     LEFT JOIN text_vectors tv ON tv.vector_space = ? AND tv.text_hash = c.text_hash
     JOIN chunk_embedding_failures f
       ON f.chunk_key = c.chunk_key
      AND f.text_hash = c.text_hash
      AND f.embedding_spec_id = c.embedding_spec_id
      AND f.chunker_id = c.chunker_id
      AND f.normalization_id = c.normalization_id
     WHERE tv.text_hash IS NULL
       AND c.embedding_spec_id = ?
       AND c.chunker_id = ?
       AND c.normalization_id = ?`,
  ).get(
    ACTIVE_VECTOR_SPACE,
    ACTIVE_EMBEDDING_SPEC.id,
    ACTIVE_EMBEDDING_SPEC.chunker_id,
    ACTIVE_EMBEDDING_SPEC.normalization_id,
  ).count
}

function metaValue(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  return row?.value ?? null
}

function activeGeneration(db) {
  return db.prepare(`
    SELECT g.id, g.event_cursor, g.schema_version, g.chunker_id, g.normalization_id,
           g.embedding_spec, g.tombstone_identity, g.policy_identity
    FROM lexical_generations g
    JOIN meta m ON m.key = 'active_lexical_generation' AND m.value = CAST(g.id AS TEXT)
    JOIN readiness_operations o ON o.id = g.operation_id AND o.status = 'committed'
  `).get()
}

// Runs `read` on one read-only snapshot of the index, or returns null when there is no index.
function readIndex(deskRoot, read) {
  if (!deskRoot || !existsSync(indexDbPath(deskRoot))) return null
  const db = new Database(indexDbPath(deskRoot), { readonly: true, fileMustExist: true })
  try {
    db.exec("BEGIN")
    return read(db)
  } finally { db.close() }
}

// Who wrote the active generation, without counting vectors or reading its documents: a controller reads this before each catch-up and each status answer to learn whether another Desk build owns the index.
export function readActiveIndex(deskRoot) {
  return readIndex(deskRoot, (db) => {
    const generation = activeGeneration(db)
    if (!generation) return null
    const cursor = JSON.parse(generation.event_cursor)
    return {
      generation: generation.id,
      writer: readIndexWriter(db.prepare("SELECT value FROM meta WHERE key = ?").get(INDEX_WRITER_KEY)?.value, cursor),
    }
  })
}

// What the stored generation `generationId` indexes, or null when it is gone.
export function readCommittedContent(deskRoot, generationId) {
  if (!Number.isSafeInteger(generationId)) return null
  return readIndex(deskRoot, (db) => readGenerationContent(db, generationId))
}

export function openSnapshot(deskRoot) {
  if (!deskRoot || !existsSync(indexDbPath(deskRoot))) return null
  const db = new Database(indexDbPath(deskRoot), { readonly: true, fileMustExist: true })
  try {
    sqliteVec.load(db)
    db.exec("BEGIN")
    const generation = activeGeneration(db)
    const covered = db.prepare("SELECT value FROM meta WHERE key = 'covered_event_cursor'").get()
    const activeEmbeddingSpecId = db.prepare("SELECT value FROM meta WHERE key = 'active_embedding_spec_id'").get()?.value ?? null
    // An index no build of this version has opened yet has no text vectors.
    const vectorsIndexed = tableExists(db, "text_vectors") ? db.prepare(
      `SELECT COUNT(*) AS n
       FROM chunks c
       JOIN text_vectors tv ON tv.vector_space = ? AND tv.text_hash = c.text_hash
       WHERE c.embedding_spec_id = ?
         AND c.chunker_id = ?
         AND c.normalization_id = ?`,
    ).get(
      ACTIVE_VECTOR_SPACE,
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
    ).n : 0
    const chunksTotal = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n
    const cursor = generation ? JSON.parse(generation.event_cursor) : null
    const writer = readIndexWriter(db.prepare("SELECT value FROM meta WHERE key = ?").get(INDEX_WRITER_KEY)?.value, cursor)
    return { db, generation: generation?.id ?? null, identities: generation, cursor, writer,
      content: generation ? readGenerationContent(db, generation.id) : null,
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
