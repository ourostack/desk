// Section vectors, kept in `.state/desk-vectors.sqlite` by section text hash and model, so a text is embedded once and
// unchanged text is never embedded again. Several sessions on one desk may write it at once; a vector for a text is the
// same whoever writes it, so the first write wins.
import Database from "better-sqlite3"
import { existsSync, mkdirSync, renameSync } from "node:fs"
import * as path from "node:path"

export function vectorsDbPath(stateDir) {
  return path.join(stateDir, "desk-vectors.sqlite")
}

function openDatabase(file) {
  const db = new Database(file)
  try {
    db.pragma("journal_mode = WAL")
    db.pragma("busy_timeout = 5000")
    db.exec(`CREATE TABLE IF NOT EXISTS vectors (
      model TEXT NOT NULL, text_hash TEXT NOT NULL, embedding BLOB NOT NULL,
      UNIQUE (model, text_hash)
    )`)
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

/** Opens the store and reads every vector of `model` into memory. A damaged file is moved aside and the vectors are made again. */
export function openVectorStore(stateDir, model, { now = Date.now } = {}) {
  mkdirSync(stateDir, { recursive: true })
  const file = vectorsDbPath(stateDir)
  let db
  try {
    db = openDatabase(file)
  } catch (error) {
    if (error.code !== "SQLITE_NOTADB" && error.code !== "SQLITE_CORRUPT") throw error
    const aside = `${file}.corrupt-${now()}`
    for (const suffix of ["", "-wal", "-shm"]) if (existsSync(file + suffix)) renameSync(file + suffix, aside + suffix)
    db = openDatabase(file)
  }
  const vectors = new Map()
  for (const row of db.prepare("SELECT text_hash, embedding FROM vectors WHERE model = ?").iterate(model)) {
    vectors.set(row.text_hash, new Float32Array(row.embedding.buffer.slice(row.embedding.byteOffset, row.embedding.byteOffset + row.embedding.byteLength)))
  }
  const insert = db.prepare("INSERT OR IGNORE INTO vectors (model, text_hash, embedding) VALUES (?, ?, ?)")
  const save = db.transaction((entries) => {
    for (const [hash, vector] of entries) insert.run(model, hash, Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength))
  })
  return {
    vectors,
    /** Saves `[textHash, Float32Array]` pairs and keeps them in memory. */
    save(entries) {
      save(entries)
      for (const [hash, vector] of entries) vectors.set(hash, vector)
    },
    close() {
      db.close()
    },
  }
}
