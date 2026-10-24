// A Desk build from before vectors were keyed by text, run in its own thread the way an older session runs in its own process. Each catch-up commits a generation that re-indexes the busy card: it deletes the card's sections and their vectors in the old row-keyed table and inserts the sections again under new row numbers, even when the text is unchanged. A writer that embeds then asks for each new row's vector one request at a time and saves them all by row number at the end, without checking that the rows still exist.

import { parentPort, workerData } from "node:worker_threads"
import { createHash } from "node:crypto"
import { openDb, closeDb, setMeta } from "../../../../../../plugins/desk/mcp/src/db/init.js"
import { commitLexicalGeneration } from "../../../../../../plugins/desk/mcp/src/readiness/generations.js"
import { stableStringify } from "../../../../../../plugins/desk/mcp/src/readiness/identity.js"
import { discover } from "../../../../../../plugins/desk/mcp/src/indexer/discover.js"
import { chunkBody } from "../../../../../../plugins/desk/mcp/src/indexer/chunk.js"
import { ACTIVE_EMBEDDING_SPEC, chunkIdentity, writeActiveEmbeddingSpec } from "../../../../../../plugins/desk/mcp/src/indexer/spec.js"
import { loadTombstoneLedger } from "../../../../../../plugins/desk/mcp/src/artifacts/tombstones.js"

const { root, card, journal, record, intervalMs, embedDelayMs } = workerData
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const state = { commits: 0, embedded: 0, saved: 0, errors: [], stopped: false }
parentPort.on("message", (message) => { if (message === "stop") state.stopped = true })

const ledger = await loadTombstoneLedger({})
// The settings every build on this desk commits with, so the same files give the same generation content.
const identities = {
  schema_version: 1,
  chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
  normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
  embedding_spec: ACTIVE_EMBEDDING_SPEC,
  tombstone_identity: `sha256:${createHash("sha256").update(stableStringify(ledger.rows)).digest("hex")}`,
  policy_identity: "desk-lexical-required-v1",
}

function indexDoc(db, doc) {
  const docId = db.prepare(`INSERT INTO docs (path, kind, track, task_slug, status, schema_version, created_at, updated_at, hash, mtime, is_archived, frontmatter)
    VALUES (@path, @kind, @track, @task_slug, @status, @schema_version, @created_at, @updated_at, @hash, @mtime, @is_archived, @frontmatter)
    ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, mtime = excluded.mtime RETURNING id`).get({
    path: doc.path, kind: doc.kind, track: doc.track, task_slug: doc.task_slug, status: doc.status, schema_version: doc.schema_version,
    created_at: doc.created_at, updated_at: doc.updated_at, hash: doc.hash, mtime: doc.mtime, is_archived: doc.is_archived ? 1 : 0,
    frontmatter: JSON.stringify(doc.frontmatter),
  }).id
  const deleteVector = db.prepare("DELETE FROM chunk_vecs WHERE chunk_id = ?")
  for (const { id } of db.prepare("SELECT id FROM chunks WHERE doc_id = ?").all(docId)) deleteVector.run(BigInt(id))
  db.prepare("DELETE FROM chunks WHERE doc_id = ?").run(docId)
  const insert = db.prepare(`INSERT INTO chunks (doc_id, chunk_index, chunk_key, text_hash, embedding_spec_id, chunker_id, normalization_id, text, heading, start_offset, end_offset)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`)
  return chunkBody(doc.body).map((chunk) => {
    const id = chunkIdentity({ docPath: doc.path, chunk })
    return insert.get(docId, chunk.index, id.chunk_key, id.text_hash, id.embedding_spec_id, id.chunker_id, id.normalization_id,
      chunk.text, chunk.heading, chunk.start_offset, chunk.end_offset).id
  })
}

async function catchUp(sequence) {
  const documents = await discover(root)
  const db = openDb(root)
  let rows = []
  try {
    commitLexicalGeneration({
      db, documents, identities, eventCursor: { journal_id: journal, sequence }, writer: record ?? undefined,
      apply() {
        // An older build's commit starts by writing, as rebuildIndex does, so it waits for other writers instead of failing.
        writeActiveEmbeddingSpec(db, setMeta)
        const indexed = new Map(db.prepare("SELECT path, hash FROM docs").all().map((row) => [row.path, row.hash]))
        for (const doc of documents) {
          if (doc.path === card || indexed.get(doc.path) !== doc.hash) {
            const ids = indexDoc(db, doc)
            if (doc.path === card) rows = ids
          }
        }
      },
    })
  } finally { closeDb(db) }
  state.commits += 1
  if (embedDelayMs === null) return
  const vector = new Float32Array(768).fill(0.01)
  for (let i = 0; i < rows.length; i += 1) {
    if (state.stopped) return
    await sleep(embedDelayMs)
    state.embedded += 1
  }
  const save = openDb(root)
  try {
    const insert = save.prepare("INSERT INTO chunk_vecs (chunk_id, embedding) VALUES (?, ?)")
    save.transaction(() => { for (const id of rows) insert.run(BigInt(id), vector) })()
    state.saved += rows.length
  } finally { closeDb(save) }
}

for (let sequence = 1; !state.stopped; sequence += 1) {
  try { await catchUp(sequence) } catch (error) { state.errors.push(String(error?.stack ?? error)) }
  await sleep(intervalMs)
}
parentPort.postMessage({ commits: state.commits, embedded: state.embedded, saved: state.saved, errors: state.errors })
