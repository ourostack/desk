// The factory's read of Copilot CLI's machine-wide `session-store.db`.
//
// A read of a native local source, never a write to it, and never a copy of
// what was said: only `assistant_usage_events` (model, counters, timestamp)
// and `session_refs` (reference type and value) are queried, always filtered
// to one session. `turns` holds message text and is never touched.
//
// Derived from the work ledger's `measurement/copilot-usage.js`, which keeps
// its own `better-sqlite3` reader unchanged until the ledger retires (M3-12).
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files, so this copy opens the database with `node:sqlite`, loaded lazily at
// the first read. It never throws and never prints: `node:sqlite` is missing
// on Node 20 and needs a flag before Node 22.13, and on the versions that have
// it, the first load emits an experimental-feature warning that would reach a
// hook's stderr. A read that cannot happen for any reason — no driver, a file
// that is not a database, a different schema — reports `status:
// "unreadable"` and the caller records it as unavailable.

import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import * as os from "node:os"
import * as path from "node:path"

import { normalizeTimestamp } from "./time.js"

const nodeRequire = createRequire(import.meta.url)

/** Where the host keeps its local session records. Never caller-supplied. */
export function localRecordsPath(env) {
  const home = env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot")
  return path.join(home, "session-store.db")
}

/**
 * `node:sqlite`, or `null` when this runtime cannot load it. Any warning the
 * load emits is swallowed: the swap covers only this synchronous `require`,
 * and `require` caches, so later loads emit nothing either way.
 */
function loadSqlite(load) {
  const emitWarning = process.emitWarning
  process.emitWarning = () => {}
  try {
    return load("node:sqlite")
  } catch {
    return null
  } finally {
    process.emitWarning = emitWarning
  }
}

/**
 * Every row of one read-only query as plain objects, or `null` when the read
 * cannot happen. Integers are read as `BigInt` and converted back, because
 * `node:sqlite` otherwise refuses the whole read over one integer beyond
 * `Number.MAX_SAFE_INTEGER`; the lossy value then fails `normalizeRow`'s
 * safe-integer checks and only that row is refused.
 */
function query(file, sql, params, load) {
  const sqlite = loadSqlite(load)
  if (sqlite === null) return null
  let db = null
  try {
    db = new sqlite.DatabaseSync(file, { readOnly: true })
    const statement = db.prepare(sql)
    statement.setReadBigInts(true)
    return statement.all(...params).map((row) => {
      const plain = {}
      for (const [key, value] of Object.entries(row)) plain[key] = typeof value === "bigint" ? Number(value) : value
      return plain
    })
  } catch {
    return null
  } finally {
    db?.close()
  }
}

function read(sql, { sessionId, env = process.env, load = nodeRequire }) {
  const file = localRecordsPath(env)
  if (!existsSync(file)) return { status: "missing", rows: [] }
  const rows = query(file, sql, [sessionId], load)
  return rows === null ? { status: "unreadable", rows: [] } : { status: "ok", rows }
}

/**
 * One session's usage rows: `{ status: "ok" | "missing" | "unreadable", rows }`.
 * `load` is a test seam for a runtime without `node:sqlite`.
 */
export function readSessionRows(options) {
  return read(
    "SELECT id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, " +
      "reasoning_tokens, created_at FROM assistant_usage_events WHERE session_id = ? ORDER BY id",
    options,
  )
}

/** One session's references as raw `{ ref_type, ref_value }` rows, same statuses. */
export function readSessionRefs(options) {
  return read("SELECT ref_type, ref_value FROM session_refs WHERE session_id = ? ORDER BY id", options)
}

const COUNTER_FIELDS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"]

/**
 * One usage row as `{ fact }`, or `{ malformed: reason }` when it is not data.
 * A missing counter stays `null` (never zero); a negative, fractional or
 * unrepresentable counter, an unsafe id or a timestamp that is not one refuses
 * the row rather than guessing.
 */
export function normalizeRow(row) {
  if (!Number.isSafeInteger(row.id)) return { malformed: "unsafe_integer_id" }
  const fact = { model: row.model }
  for (const field of COUNTER_FIELDS) {
    const value = row[field] ?? null
    if (value !== null && !(Number.isSafeInteger(value) && value >= 0)) return { malformed: "invalid_counter" }
    fact[field] = value
  }
  fact.created_at = normalizeTimestamp(row.created_at)
  if (fact.created_at === null) return { malformed: "invalid_timestamp" }
  return { fact }
}

export const __internals__ = { loadSqlite }
