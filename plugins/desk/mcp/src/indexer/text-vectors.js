// text-vectors.js — section vectors keyed by text, not by row.
//
// Re-indexing a document replaces its section rows with new row numbers, and
// older Desk builds on a shared desk re-index busy cards every minute or so.
// A vector stored by row number is lost at every re-index; a vector stored by
// its section's text hash survives it. Each vector lives once per vector
// space (the embedding settings that make vectors comparable) and text hash
// in `text_vectors`. The row-keyed `chunk_vecs` table stays for older builds:
// this build reads it once, to carry valid vectors over, and removes the rows
// no build can ever read.

import { setMeta, getMeta } from "../db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "./spec.js"

export const ACTIVE_VECTOR_SPACE = ACTIVE_EMBEDDING_SPEC.id
const MIGRATED_META_KEY = "text_vectors_migrated_from_chunk_vecs"
const CLEANUP_BATCH_SIZE = 500
const CLEANUP_BUDGET_MS = 500
// A text vector no section uses is kept this long: an older build that commits a stale copy of a card, or an edit that is undone, brings the text back, and its vector is still there.
export const UNUSED_TEXT_VECTOR_GRACE_MS = 60 * 60 * 1000
// Vectors embedded during a pass whose section vanished before the save, kept in memory in case the text comes back, so it is not embedded twice.
const DISCARDED_VECTOR_LIMIT = 1_000
const discardedVectors = new Map()

/** The vector space of vectors made by `model` under the active specification. */
export function vectorSpaceFor(model) {
  return model === ACTIVE_EMBEDDING_SPEC.model
    ? ACTIVE_VECTOR_SPACE
    : `${ACTIVE_VECTOR_SPACE}+model:${model}`
}

/**
 * Prepare the guarded save: a vector is stored only while a section with its
 * text still exists, checked in the caller's transaction. `keptChars` says how
 * many characters were embedded when the text was shortened, and a null
 * vector records the text as skipped. The returned function reports false
 * when that section has vanished and nothing was stored.
 */
export function prepareTextVectorSave(db, vectorSpace) {
  const live = db.prepare("SELECT 1 FROM chunks WHERE text_hash = ? LIMIT 1")
  const insert = db.prepare(
    "INSERT OR IGNORE INTO text_vectors (vector_space, text_hash, embedding, kept_chars) VALUES (?, ?, ?, ?)",
  )
  return (textHash, vector, keptChars = null) => {
    const key = `${vectorSpace}\0${textHash}`
    if (live.get(textHash) === undefined) {
      if (vector) {
        discardedVectors.delete(key)
        discardedVectors.set(key, { vector, keptChars })
        if (discardedVectors.size > DISCARDED_VECTOR_LIMIT) discardedVectors.delete(discardedVectors.keys().next().value)
      }
      return false
    }
    insert.run(vectorSpace, textHash, vector ? Buffer.from(new Float32Array(vector).buffer) : null, keptChars)
    discardedVectors.delete(key)
    return true
  }
}

/** The vector, and the characters it kept, that this process embedded for the text but could not save because its section had vanished, or undefined. */
export function discardedVector(vectorSpace, textHash) {
  return discardedVectors.get(`${vectorSpace}\0${textHash}`)
}

/**
 * Carry the old table's vectors over, once per index. Only vectors whose
 * section row still exists are copied, keyed by that section's text hash;
 * nothing is embedded. `trusted` says whether the old table's vectors were
 * made under the active specification; untrusted ones are left behind and
 * regenerated as needed.
 *
 * @returns {{ migrated: boolean, vectors_copied: number }}
 */
export function migrateRowVectors(db, { trusted }) {
  if (getMeta(db, MIGRATED_META_KEY) === ACTIVE_VECTOR_SPACE) return { migrated: false, vectors_copied: 0 }
  return db.transaction(() => {
    const copied = trusted
      ? db.prepare(
        `INSERT OR IGNORE INTO text_vectors (vector_space, text_hash, embedding)
         SELECT ?, c.text_hash, v.embedding
         FROM chunks c
         JOIN chunk_vecs v ON v.chunk_id = c.id
         WHERE c.text_hash IS NOT NULL
           AND c.embedding_spec_id = ?
           AND c.chunker_id = ?
           AND c.normalization_id = ?`,
      ).run(
        ACTIVE_VECTOR_SPACE,
        ACTIVE_EMBEDDING_SPEC.id,
        ACTIVE_EMBEDDING_SPEC.chunker_id,
        ACTIVE_EMBEDDING_SPEC.normalization_id,
      ).changes
      : 0
    setMeta(db, MIGRATED_META_KEY, ACTIVE_VECTOR_SPACE)
    return { migrated: true, vectors_copied: copied }
  }).immediate()
}

/**
 * Remove vectors no section can use. A text vector whose text no section has
 * is marked unused, and removed once it has stayed unused for
 * UNUSED_TEXT_VECTOR_GRACE_MS. An old-table vector whose row is gone is
 * removed at once: row numbers are never reused, so no build can ever read it.
 * Each batch is its own short transaction, and the work stops after
 * `budgetMs`, so other writers wait at most one batch; what is left goes at
 * the next catch-up.
 *
 * @returns {Promise<{ text_vectors_removed: number, row_vectors_removed: number, complete: boolean }>}
 */
export async function removeUnusableVectors(db, {
  batchSize = CLEANUP_BATCH_SIZE,
  budgetMs = CLEANUP_BUDGET_MS,
  now = Date.now,
} = {}) {
  const started = now()
  const summary = { text_vectors_removed: 0, row_vectors_removed: 0, complete: false }
  const unused = "NOT EXISTS (SELECT 1 FROM chunks c WHERE c.text_hash = text_vectors.text_hash)"
  // Each step looks first and takes the write lock only when it has something to write: on a busy desk every
  // write waits its turn behind the other builds' commits.
  const toUnmark = db.prepare(`SELECT 1 FROM text_vectors WHERE unused_since IS NOT NULL AND NOT ${unused} LIMIT 1`)
  const toMark = db.prepare(`SELECT 1 FROM text_vectors WHERE unused_since IS NULL AND ${unused} LIMIT 1`)
  if (toUnmark.get() || toMark.get()) {
    db.transaction(() => {
      db.prepare(`UPDATE text_vectors SET unused_since = NULL WHERE unused_since IS NOT NULL AND NOT ${unused}`).run()
      db.prepare(`UPDATE text_vectors SET unused_since = ? WHERE unused_since IS NULL AND ${unused}`).run(started)
    }).immediate()
  }
  const findTextVectors = db.prepare(
    `SELECT rowid FROM text_vectors WHERE unused_since <= ? AND ${unused} LIMIT ?`,
  )
  const findRowVectors = db.prepare(
    `SELECT v.chunk_id FROM chunk_vecs v
     WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = v.chunk_id)
     LIMIT ?`,
  )
  const deleteTextVector = db.prepare(`DELETE FROM text_vectors WHERE rowid = ? AND ${unused}`)
  const deleteRowVector = db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?")
  // The checks run again inside the write, so a section that came back in between keeps its vector.
  const deleteBatch = db.transaction((textRows, rowIds) => {
    let removedText = 0
    for (const rowid of textRows) removedText += deleteTextVector.run(rowid).changes
    for (const id of rowIds) deleteRowVector.run(BigInt(id))
    return removedText
  }).immediate
  for (;;) {
    const textRows = findTextVectors.all(started - UNUSED_TEXT_VECTOR_GRACE_MS, batchSize).map((row) => row.rowid)
    const rowIds = findRowVectors.all(batchSize - textRows.length).map((row) => row.chunk_id)
    if (textRows.length + rowIds.length === 0) {
      summary.complete = true
      return summary
    }
    summary.text_vectors_removed += deleteBatch(textRows, rowIds)
    summary.row_vectors_removed += rowIds.length
    if (textRows.length + rowIds.length < batchSize) {
      summary.complete = true
      return summary
    }
    if (now() - started >= budgetMs) return summary
    await new Promise((resolve) => setImmediate(resolve))
  }
}
