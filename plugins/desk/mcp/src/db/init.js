// SQLite index init.
//
// Opens (or creates) the search index, applies schema.sql idempotently and
// returns a better-sqlite3 Database handle. The search engine opens it in
// memory (`dbPath: ":memory:"`); without `dbPath` it is
// `<deskRoot>/.state/desk-index.sqlite`.

import { readFileSync, mkdirSync, existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import Database from "better-sqlite3"
import { ensureStateIgnored } from "../util/state-ignore.js"
import { ensureCardGuard } from "../desk/card-commit-guard.js"

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Read the schema.sql file as a string. Exposed for tests + diagnostics. */
function readSchemaSql() {
  return readFileSync(path.join(__dirname, "schema.sql"), "utf-8")
}

/**
 * Resolve the on-disk path where the index DB lives for a given desk root.
 * Lives under `<root>/.state/` per desk-search-design §3.
 */
export function indexDbPath(deskRoot) {
  return path.join(deskRoot, ".state", "desk-index.sqlite")
}

/**
 * Open (or create) the desk index DB. Applies the schema and returns a
 * ready-to-use better-sqlite3 handle.
 *
 * @param {string} deskRoot — absolute path to the desk workspace.
 * @param {object} [opts]
 * @param {string} [opts.dbPath] — override the resolved DB path (used by tests).
 * @returns {import("better-sqlite3").Database}
 */
export function openDb(deskRoot, opts = {}) {
  const dbPath = opts.dbPath ?? indexDbPath(deskRoot)
  const dbDir = path.dirname(dbPath)
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true })
  }
  // Only the index in its own place: a test's `dbPath` override says nothing about the desk.
  if (opts.dbPath === undefined) {
    ensureStateIgnored(deskRoot)
    ensureCardGuard(deskRoot)
  }
  const db = new Database(dbPath)
  try {
    // foreign_keys lets ON DELETE CASCADE actually cascade. WAL and FULL matter only for an index on disk.
    db.pragma("journal_mode = WAL")
    db.pragma("synchronous = FULL")
    db.pragma("foreign_keys = ON")
    runMigrations(db)
  } catch (error) {
    // An unreadable database fails on the first pragma, after the handle is open. Windows will not rename or delete a file that is still open, so the quarantine that moves a corrupt index aside would fail while the handle waits for garbage collection.
    try { db.close() } catch { /* the original error is the one to report */ }
    throw error
  }
  return db
}

/** Apply schema.sql; every statement is idempotent (IF NOT EXISTS). */
export function runMigrations(db) {
  db.exec(readSchemaSql())
}

/** Clean shutdown — close DB handle. Safe to call multiple times. */
export function closeDb(db) {
  if (db && db.open) {
    db.close()
  }
}

/** Read a meta key. Returns null if absent. */
export function getMeta(db, key) {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  return row ? row.value : null
}

/** Set (or upsert) a meta key. */
export function setMeta(db, key, value) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value)
}
