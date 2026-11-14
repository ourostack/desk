import { createHash } from "node:crypto"
import { lstatSync, realpathSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { localRecordsPath } from "./copilot-usage.js"
import { stableStringify } from "./pipeline/normalize.js"
import { normalizeTimestamp } from "./time.js"
import { SESSION_ID_V4 } from "./published-schema.js"

const require = createRequire(import.meta.url)
const MAX_ROWS = 256
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_PROJECTION_BYTES = 256 * 1024
const hash = value => createHash("sha256").update(stableStringify(value)).digest("hex")
const absent = (status, reason = status) => ({ status, reason, digest: null, turns: [], excluded_rows: 0 })

/** Native identity is admitted only from a complete one-job local binding, never from a public alias. */
export function copilotContextIdentity(local) {
  const session = local?.session
  const jobs = local?.jobs
  if (session?.host !== "copilot-cli" || !SESSION_ID_V4.test(session.id) || jobs?.length !== 1) return null
  const started = normalizeTimestamp(session.started_at)
  const through = normalizeTimestamp(session.derived_through)
  const duration = Date.parse(through) - Date.parse(started)
  const spans = jobs[0].segments
  if (started === null || through === null || !Number.isSafeInteger(duration) || duration <= 0 ||
      spans?.length !== 1 || spans[0].start_ms !== 0 || spans[0].end_ms !== duration) return null
  return { session: session.id, job: jobs[0].job, started_at: started, duration_ms: duration, full_share: true }
}

/** Indexed requests/replies are documentary evidence, never a reconstructed tool trace or action clock. */
export function readCopilotConversation({ env = process.env, sessionId, recordedUntil, expectedDesk, load = require }) {
  const until = normalizeTimestamp(recordedUntil)
  if (typeof sessionId !== "string" || !SESSION_ID_V4.test(sessionId) || until === null ||
      typeof expectedDesk !== "string" || !path.isAbsolute(expectedDesk))
    throw new TypeError("readCopilotConversation: Pass the native session and its capture boundary")
  const file = localRecordsPath(env)
  try {
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return absent("unreadable", "unsafe_source")
  } catch (error) {
    if (error.code === "ENOENT") return absent("missing")
    if (["EACCES", "EPERM"].includes(error.code)) return absent("unreadable", "source_permission")
    throw error
  }
  let driver
  try { driver = load("node:sqlite") } catch (error) {
    if (["ERR_UNKNOWN_BUILTIN_MODULE", "MODULE_NOT_FOUND"].includes(error.code)) return absent("unsupported", "driver_unavailable")
    throw error
  }
  let db
  try {
    db = new driver.DatabaseSync(file, { readOnly: true })
    db.exec("BEGIN")
    const identity = db.prepare("SELECT id, cwd FROM sessions WHERE id = ?").get(sessionId)
    if (!identity) return absent("session_missing")
    if (typeof identity.cwd !== "string" || !path.isAbsolute(identity.cwd)) return absent("not_eligible", "desk_identity_unavailable")
    try {
      if (realpathSync(identity.cwd) !== realpathSync(expectedDesk)) return absent("not_eligible", "desk_identity_mismatch")
    } catch (error) {
      if (["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code)) return absent("not_eligible", "desk_identity_unavailable")
      throw error
    }
    const size = db.prepare("SELECT COUNT(*) AS rows, COALESCE(SUM(length(CAST(user_message AS BLOB))), 0) + COALESCE(SUM(length(CAST(assistant_response AS BLOB))), 0) AS bytes FROM (SELECT user_message, assistant_response FROM turns WHERE session_id = ? LIMIT 257)")
    size.setReadBigInts(true)
    const stats = size.get(sessionId)
    if (stats.rows > BigInt(MAX_ROWS) || stats.bytes > BigInt(MAX_TEXT_BYTES)) return absent("too_large")
    const query = db.prepare("SELECT turn_index, timestamp, user_message, assistant_response FROM turns WHERE session_id = ? ORDER BY turn_index LIMIT 257")
    query.setReadBigInts(true)
    const rows = query.all(sessionId).map(row => ({ ...row, turn_index: typeof row.turn_index === "bigint" ? Number(row.turn_index) : NaN }))
    if (rows.length !== Number(stats.rows) || rows.some((row, index) =>
      !Number.isSafeInteger(row.turn_index) || row.turn_index < 0 ||
      index > 0 && row.turn_index <= rows[index - 1].turn_index ||
      ![row.user_message, row.assistant_response].every(value => value === null || typeof value === "string")))
      return absent("unreadable", "invalid_rows")
    const digest = hash({ session: sessionId, recorded_until: until, rows })
    const selected = rows.filter(row => {
      const timestamp = normalizeTimestamp(row.timestamp)
      return timestamp !== null && timestamp <= until
    })
    const turns = selected.map(({ turn_index, user_message, assistant_response }) => ({ turn_index, user_message, assistant_response }))
    const excluded_rows = rows.length - turns.length
    if (Buffer.byteLength(stableStringify(turns)) > MAX_PROJECTION_BYTES) return absent("too_large")
    const hasText = turns.some(row => [row.user_message, row.assistant_response].some(value => typeof value === "string" && value.trim().length > 0))
    return { status: hasText ? "available" : "no_attributable_turns", reason: "derived_conversation",
      digest, turns, excluded_rows }
  } catch (error) {
    if (typeof error.code === "string" && error.code.startsWith("ERR_SQLITE")) return absent("unreadable", "source_query_failed")
    throw error
  } finally {
    db?.close()
  }
}
