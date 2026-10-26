-- desk MCP search index schema. The search engine (src/search/engine.js) keeps it in memory.

-- ---------------------------------------------------------------------------
-- meta: key-value state of the change journal's generations (readiness/generations.js).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

-- A generation is published only in the transaction that changes its lexical rows.
CREATE TABLE IF NOT EXISTS readiness_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  completed_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lexical_generations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  chunker_id TEXT NOT NULL,
  normalization_id TEXT NOT NULL,
  embedding_spec TEXT NOT NULL,
  tombstone_identity TEXT NOT NULL,
  policy_identity TEXT NOT NULL,
  documents TEXT NOT NULL,
  event_cursor TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  operation_id TEXT NOT NULL REFERENCES readiness_operations(id)
);

-- ---------------------------------------------------------------------------
-- docs: one row per file under <root>/ that gets indexed (task.md,
-- planning.md, doing.md, friction notes, lessons, etc.).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS docs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE,                -- relative to deskRoot
  kind TEXT NOT NULL,                       -- task | planning | doing | feedback | friction | lesson | other
  track TEXT,                               -- nullable; null for top-level _meta/ docs
  task_slug TEXT,                           -- nullable; null for non-task docs
  status TEXT,                              -- task status field (null for non-task)
  schema_version INTEGER DEFAULT 0,
  created_at TEXT,                          -- ISO 8601, from frontmatter
  updated_at TEXT,                          -- ISO 8601, from frontmatter
  hash TEXT NOT NULL,                       -- sha256 of file content for dirty-detection
  mtime INTEGER NOT NULL,                   -- filesystem mtime for fast first-pass dirty check
  is_archived INTEGER NOT NULL DEFAULT 0,   -- 1 if the doc lives under any _archive/ ancestor
  frontmatter TEXT                          -- raw JSON of full frontmatter object
);

CREATE INDEX IF NOT EXISTS idx_docs_track ON docs(track);
CREATE INDEX IF NOT EXISTS idx_docs_kind ON docs(kind);
CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
CREATE INDEX IF NOT EXISTS idx_docs_is_archived ON docs(is_archived);
CREATE INDEX IF NOT EXISTS idx_docs_updated_at ON docs(updated_at);

-- ---------------------------------------------------------------------------
-- chunks: one row per semantic chunk extracted from a doc.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,             -- 0-based position within doc
  text_hash TEXT,                           -- keys the section's vector (indexer/text-hash.js)
  text TEXT NOT NULL,
  heading TEXT,                             -- nearest preceding heading, if any
  start_offset INTEGER,                     -- byte offset into doc
  end_offset INTEGER
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_id ON chunks(doc_id);
CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON chunks(text_hash);

-- ---------------------------------------------------------------------------
-- refs_graph: directed edges between docs (e.g., task.md → its planning.md,
-- doing.md → its task.md). Powers desk_thread (provenance walk) in Unit 6.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refs_graph (
  src_doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  dst_doc_id INTEGER NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  ref_kind TEXT NOT NULL,                   -- planning_of | doing_of | feedback_of | linked_from_body | predecessor | etc.
  PRIMARY KEY (src_doc_id, dst_doc_id, ref_kind)
);

CREATE INDEX IF NOT EXISTS idx_refs_src ON refs_graph(src_doc_id);
CREATE INDEX IF NOT EXISTS idx_refs_dst ON refs_graph(dst_doc_id);

-- ---------------------------------------------------------------------------
-- chunks_fts: FTS5 virtual table over chunks.text, content-linked to chunks
-- so we can search the text without duplicating it. Kept in sync by triggers
-- below.
-- ---------------------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text,
  content='chunks',
  content_rowid='id'
);

-- Trigger fan-out: keep chunks_fts in lockstep with chunks.
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
END;

CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
