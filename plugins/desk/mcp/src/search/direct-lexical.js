import Database from "better-sqlite3"
import { discover } from "../indexer/discover.js"
import { chunkBody } from "../indexer/chunk.js"
import { isTombstoned, loadTombstoneLedger } from "../artifacts/tombstones.js"
import { deskPluginRoot } from "../package-metadata.js"
import { indexedSearch, indexedTimeline } from "../tools/search.js"

/**
 * Read the desk's files afresh into a disposable in-memory corpus and search it with the same FTS5 tokenizer, BM25 and
 * query serialization as the search engine. Serves searches made before the session's search engine has started.
 */
export async function directLexicalSearch({ deskRoot, query, filters, scope, limit, now, signal, kind, from, to }) {
  signal?.throwIfAborted()
  const tombstones = await loadTombstoneLedger({ pluginRoot: deskPluginRoot() })
  const documents = await discover(deskRoot, { signal })
  const db = new Database(":memory:")
  try {
    db.exec(`
      CREATE TABLE docs (
        id INTEGER PRIMARY KEY, path TEXT, kind TEXT, track TEXT, task_slug TEXT,
        status TEXT, updated_at TEXT, is_archived INTEGER, frontmatter TEXT
      );
      CREATE TABLE chunks (
        id INTEGER PRIMARY KEY, doc_id INTEGER, chunk_index INTEGER, text TEXT, heading TEXT
      );
      CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id');
    `)
    const addDoc = db.prepare("INSERT INTO docs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    const addChunk = db.prepare("INSERT INTO chunks (doc_id, chunk_index, text, heading) VALUES (?, ?, ?, ?)")
    db.transaction(() => {
      let id = 0
      for (const doc of documents) {
        signal?.throwIfAborted()
        if (isTombstoned(tombstones, doc)) continue
        addDoc.run(++id, doc.path, doc.kind, doc.track, doc.task_slug, doc.status,
          doc.updated_at, Number(doc.is_archived), JSON.stringify(doc.frontmatter))
        for (const [index, chunk] of chunkBody(doc.body).entries()) {
          addChunk.run(id, index, chunk.text, chunk.heading)
        }
      }
      db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES ('rebuild')")
    })()
    signal?.throwIfAborted()
    const search = kind === "timeline" ? indexedTimeline : indexedSearch
    return await search({
      deskRoot, db, input: { query, filters, scope, limit, from, to }, opts: { now },
    })
  } finally {
    db.close()
  }
}
