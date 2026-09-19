import { randomUUID } from "node:crypto"
import { getMeta, setMeta } from "../db/init.js"
import { stableStringify } from "./identity.js"

// The callback is synchronous: lexical rows and their coverage are one SQLite commit.
// Network work (including embedding) belongs after this function returns.
export function commitLexicalGeneration({ db, documents, eventCursor = null, identities, apply = () => {} }) {
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
    return row.id
  })()
}

// Hold SQLite's writer reservation across the final check and synchronous journal swap.
export function withActiveLexicalGeneration({ db, generationId, eventCursor }, replace) {
  if (db.inTransaction) throw new Error("journal compaction requires a committed generation")
  return db.transaction(() => {
    const row = db.prepare("SELECT event_cursor FROM lexical_generations WHERE id = ?").get(generationId)
    if (getMeta(db, "active_lexical_generation") !== String(generationId) ||
        !sameCursor(row?.event_cursor, eventCursor) ||
        !sameCursor(getMeta(db, "covered_event_cursor"), eventCursor)) {
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
