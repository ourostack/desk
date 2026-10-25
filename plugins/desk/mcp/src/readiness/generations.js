import { createHash, randomUUID } from "node:crypto"
import { getMeta, setMeta } from "../db/init.js"
import { stableStringify } from "./identity.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { INDEX_WRITER_KEY, indexWriterRecord } from "./index-writer.js"

// Each commit adds a generation row holding the whole document list, and builds sharing a desk commit often. Older rows are kept only so a compaction that is still running can find the generation it started from.
export const RETAINED_LEXICAL_GENERATIONS = 8

// Mirrors the identities committed by the canonical indexer, not the event cursor.
export function expectedLexicalGenerationIdentity({ ledger, policyIdentity = "desk-lexical-required-v1" }) {
  return {
    schema_version: 1,
    chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
    normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
    embedding_spec: stableStringify(ACTIVE_EMBEDDING_SPEC),
    tombstone_identity: `sha256:${createHash("sha256").update(stableStringify(ledger.rows)).digest("hex")}`,
    policy_identity: policyIdentity,
  }
}

// The callback is synchronous: lexical rows and their coverage are one SQLite commit.
// Network work (including embedding) belongs after this function returns.
export function commitLexicalGeneration({ db, documents, eventCursor = null, identities, writer, apply = () => {} }) {
  if (db.inTransaction) throw new Error("a lexical generation must own its commit")
  if (!Number.isSafeInteger(identities?.schema_version) || identities.schema_version < 1 ||
      ["chunker_id", "normalization_id", "tombstone_identity", "policy_identity"]
        .some((key) => typeof identities[key] !== "string" || !identities[key]) ||
      typeof identities.embedding_spec?.id !== "string" || !identities.embedding_spec.id) {
    throw new Error("lexical generation identities are incomplete")
  }
  if (eventCursor !== null && (typeof eventCursor?.journal_id !== "string" || !eventCursor.journal_id ||
      !Number.isSafeInteger(eventCursor.sequence) || eventCursor.sequence < 0)) {
    throw new Error("invalid lexical generation event cursor")
  }
  if (!Array.isArray(documents) ||
      documents.some((doc) => typeof doc.path !== "string" || !doc.path || typeof doc.hash !== "string" || !doc.hash) ||
      new Set(documents.map((doc) => doc.path)).size !== documents.length) {
    throw new Error("invalid lexical generation documents")
  }
  return db.transaction(() => {
    const result = apply()
    if (result?.then) throw new Error("lexical generation apply must be synchronous")
    const actual = db.prepare("SELECT path, hash FROM docs ORDER BY path").all()
    const expected = new Map(documents.map((doc) => [doc.path, doc.hash]))
    if (actual.length !== expected.size || actual.some((doc) => expected.get(doc.path) !== doc.hash)) {
      throw new Error("lexical generation documents do not match committed rows")
    }
    const completedAt = new Date().toISOString()
    const operationId = randomUUID()
    db.prepare("INSERT INTO readiness_operations (id, kind, status, completed_at) VALUES (?, 'lexical', 'committed', ?)")
      .run(operationId, completedAt)
    const cursorJson = JSON.stringify(eventCursor)
    const row = db.prepare(`INSERT INTO lexical_generations
      (schema_version, chunker_id, normalization_id, embedding_spec, tombstone_identity,
       policy_identity, documents, event_cursor, completed_at, operation_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`).get(
      identities.schema_version, identities.chunker_id, identities.normalization_id,
      stableStringify(identities.embedding_spec), identities.tombstone_identity,
      identities.policy_identity, JSON.stringify(actual), cursorJson, completedAt, operationId,
    )
    setMeta(db, "active_lexical_generation", String(row.id))
    setMeta(db, "covered_event_cursor", cursorJson)
    setMeta(db, "last_indexed_at", completedAt)
    if (writer && eventCursor) setMeta(db, INDEX_WRITER_KEY, indexWriterRecord(writer, eventCursor))
    else db.prepare("DELETE FROM meta WHERE key = ?").run(INDEX_WRITER_KEY)
    db.prepare("DELETE FROM lexical_generations WHERE id <= ?").run(row.id - RETAINED_LEXICAL_GENERATIONS)
    db.prepare(`DELETE FROM readiness_operations WHERE kind = 'lexical'
      AND id NOT IN (SELECT operation_id FROM lexical_generations)`).run()
    return row.id
  })()
}

// What a generation indexes: its documents (path and content hash) and the identities that decide how they were chunked and embedded. Two generations with the same content index the same desk the same way, whichever controller committed them, so either one serves the same answers.
export function generationContent(documents, identities) {
  const docs = documents.map((doc) => [doc.path, doc.hash]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const embeddingSpec = identities.embedding_spec
  return `sha256:${createHash("sha256").update(stableStringify({
    documents: docs,
    schema_version: identities.schema_version,
    chunker_id: identities.chunker_id,
    normalization_id: identities.normalization_id,
    embedding_spec: typeof embeddingSpec === "string" ? embeddingSpec : stableStringify(embeddingSpec),
    tombstone_identity: identities.tombstone_identity,
    policy_identity: identities.policy_identity,
  })).digest("hex")}`
}

// The content of the stored generation `generationId`, or null when the row is gone or unreadable. The last digest is kept with the row text it was computed from: the documents list of a large desk is long, every search reads it, and comparing the text is much cheaper than parsing and hashing it again.
const contentCache = { key: null, content: null }
export function readGenerationContent(db, generationId) {
  const row = db.prepare(`SELECT documents, schema_version, chunker_id, normalization_id, embedding_spec,
    tombstone_identity, policy_identity FROM lexical_generations WHERE id = ?`).get(generationId)
  if (!row) return null
  const key = stableStringify(row)
  if (contentCache.key === key) return contentCache.content
  let documents
  try { documents = JSON.parse(row.documents) } catch { return null }
  if (!Array.isArray(documents)) return null
  const content = generationContent(documents, row)
  contentCache.key = key
  contentCache.content = content
  return content
}

// Hold SQLite's writer reservation across the final check and synchronous journal swap. The change log may be cleaned up when the active generation is this controller's own, or when another controller has since committed a generation with the same content: that one covers the same desk changes just as well. An older Desk build that cannot stand aside keeps committing the unchanged desk, and refusing then would leave the owning build catching up forever.
export function withActiveLexicalGeneration({ db, generationId, eventCursor }, replace) {
  if (db.inTransaction) throw new Error("journal compaction requires a committed generation")
  return db.transaction(() => {
    const row = db.prepare("SELECT event_cursor FROM lexical_generations WHERE id = ?").get(generationId)
    const active = getMeta(db, "active_lexical_generation")
    const own = active === String(generationId) && sameCursor(getMeta(db, "covered_event_cursor"), eventCursor)
    const covers = sameCursor(row?.event_cursor, eventCursor) && (own || (active !== null && active !== String(generationId) &&
      readGenerationContent(db, generationId) !== null &&
      readGenerationContent(db, Number(active)) === readGenerationContent(db, generationId)))
    if (!covers) {
      const error = new Error("active lexical generation or journal coverage changed before compaction")
      error.code = "generation_superseded"
      throw error
    }
    return replace()
  }).immediate()
}

function sameCursor(encoded, expected) {
  try {
    const cursor = JSON.parse(encoded)
    return cursor?.journal_id === expected.journal_id && cursor?.sequence === expected.sequence
  } catch (error) {
    if (error instanceof SyntaxError) return false
    throw error
  }
}
