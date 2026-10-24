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

import { createHash } from "node:crypto"
import { setMeta, getMeta } from "../db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "./spec.js"

// Bump when the way vectors are made changes in a way the specification's fields do not show.
const VECTOR_SPACE_SCHEMA_VERSION = 1

/**
 * The vector space of vectors made under `spec`: everything that makes two
 * vectors comparable, so vectors made under any other model, model revision,
 * dimension, chunker or normalization are never reused.
 */
export function vectorSpaceOf(spec, schemaVersion = VECTOR_SPACE_SCHEMA_VERSION) {
  const settings = JSON.stringify([schemaVersion, spec.id, spec.model, spec.model_revision ?? null, spec.dimension, spec.chunker_id, spec.normalization_id])
  return `${spec.id}#${createHash("sha256").update(settings).digest("hex").slice(0, 16)}`
}

export const ACTIVE_VECTOR_SPACE = vectorSpaceOf(ACTIVE_EMBEDDING_SPEC)
const MIGRATED_META_KEY = "text_vectors_migrated_from_chunk_vecs"
const MIGRATION_BATCH_SIZE = 2_000
// One cleanup round looks for at most this many unusable vectors of each kind in one read, then deletes them in
// transactions of at most CLEANUP_BATCH_SIZE rows, pausing between them so another build waiting to write goes first.
const CLEANUP_SCAN_LIMIT = 20_000
const CLEANUP_BATCH_SIZE = 500
const CLEANUP_PAUSE_MS = 5
// A text vector no section uses is kept this long: an older build that commits a stale copy of a card, or an edit that is undone, brings the text back, and its vector is still there.
export const UNUSED_TEXT_VECTOR_GRACE_MS = 60 * 60 * 1000
// Vectors embedded during a pass whose section vanished before the save, kept in memory in case the text comes back, so it is not embedded twice.
const DISCARDED_VECTOR_LIMIT = 1_000
const discardedVectors = new Map()

/** The vector space of vectors made by `model` under the active specification; another model's revision is unknown. */
export function vectorSpaceFor(model) {
  return model === ACTIVE_EMBEDDING_SPEC.model
    ? ACTIVE_VECTOR_SPACE
    : vectorSpaceOf({ ...ACTIVE_EMBEDDING_SPEC, model, model_revision: null })
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
 * Carry the old table's vectors over, once per index, when they are known to
 * be active-model vectors (`trusted`). Only vectors whose section row still
 * exists are copied, keyed by that section's text hash; nothing is embedded.
 * The copy runs in transactions of MIGRATION_BATCH_SIZE sections, and the
 * index is marked as migrated only after the last one. An untrusted start
 * copies nothing and leaves the copy for a later start that trusts them.
 *
 * @returns {{ migrated: boolean, vectors_copied: number }}
 */
export function migrateRowVectors(db, { trusted, batchSize = MIGRATION_BATCH_SIZE }) {
  if (!trusted || getMeta(db, MIGRATED_META_KEY) === ACTIVE_VECTOR_SPACE) return { migrated: false, vectors_copied: 0 }
  const active = "c.text_hash IS NOT NULL AND c.embedding_spec_id = ? AND c.chunker_id = ? AND c.normalization_id = ?"
  const spec = [ACTIVE_EMBEDDING_SPEC.id, ACTIVE_EMBEDDING_SPEC.chunker_id, ACTIVE_EMBEDDING_SPEC.normalization_id]
  const nextIds = db.prepare(`SELECT c.id FROM chunks c WHERE c.id > ? AND ${active} ORDER BY c.id LIMIT ?`)
  const copy = db.prepare(
    `INSERT OR IGNORE INTO text_vectors (vector_space, text_hash, embedding)
     SELECT ?, c.text_hash, v.embedding
     FROM chunks c
     JOIN chunk_vecs v ON v.chunk_id = c.id
     WHERE c.id BETWEEN ? AND ? AND ${active}`,
  )
  let copied = 0
  for (let after = 0; ;) {
    const ids = nextIds.all(after, ...spec, batchSize)
    if (ids.length === 0) break
    const last = ids.at(-1).id
    copied += db.transaction(() => copy.run(ACTIVE_VECTOR_SPACE, ids[0].id, last, ...spec).changes).immediate()
    after = last
  }
  db.transaction(() => setMeta(db, MIGRATED_META_KEY, ACTIVE_VECTOR_SPACE)).immediate()
  return { migrated: true, vectors_copied: copied }
}

/**
 * One cleanup round: remove vectors no section can use. A text vector whose
 * text no section has is marked unused, and removed once it has stayed unused
 * for UNUSED_TEXT_VECTOR_GRACE_MS. An old-table vector whose row is gone is
 * removed at once: row numbers are never reused, so no build can ever read it.
 * Each kind is found in one read of at most `scanLimit` rows, outside any
 * transaction, because finding them costs about the same however many there
 * are. They are then deleted in transactions of at most `batchSize` rows with
 * a pause between them, so another build waits at most one batch to write.
 * `complete` is false when a read found as many as it could take, so more may
 * be left.
 *
 * @returns {Promise<{ text_vectors_removed: number, row_vectors_removed: number, complete: boolean }>}
 */
export async function removeUnusableVectors(db, {
  scanLimit = CLEANUP_SCAN_LIMIT,
  batchSize = CLEANUP_BATCH_SIZE,
  pauseMs = CLEANUP_PAUSE_MS,
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
  const textRows = db.prepare(`SELECT rowid FROM text_vectors WHERE unused_since <= ? AND ${unused} LIMIT ?`)
    .all(started - UNUSED_TEXT_VECTOR_GRACE_MS, scanLimit).map((row) => row.rowid)
  const rowIds = db.prepare(
    `SELECT v.chunk_id FROM chunk_vecs v
     WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.id = v.chunk_id)
     LIMIT ?`,
  ).all(scanLimit).map((row) => row.chunk_id)
  // The text check runs again inside the write, so a section that came back since the read keeps its vector.
  const deleteTextVector = db.prepare(`DELETE FROM text_vectors WHERE rowid = ? AND ${unused}`)
  const deleteRowVector = db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?")
  const deleteTextBatch = db.transaction((ids) => ids.reduce((removed, id) => removed + deleteTextVector.run(id).changes, 0)).immediate
  const deleteRowBatch = db.transaction((ids) => { for (const id of ids) deleteRowVector.run(BigInt(id)) }).immediate
  const batches = [
    ...chunked(textRows, batchSize).map((ids) => () => { summary.text_vectors_removed += deleteTextBatch(ids) }),
    ...chunked(rowIds, batchSize).map((ids) => () => { deleteRowBatch(ids); summary.row_vectors_removed += ids.length }),
  ]
  for (let i = 0; i < batches.length; i += 1) {
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, pauseMs))
    batches[i]()
  }
  summary.complete = textRows.length < scanLimit && rowIds.length < scanLimit
  return summary
}

function chunked(items, size) {
  const chunks = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}
