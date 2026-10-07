// The timestamp helper shared by the factory. `src/factory/**` may only
// import `node:` built-ins and other `src/factory/` files; this module
// imports nothing.

/**
 * A source or operator timestamp, or nothing.
 *
 * Exactly two shapes are admitted, because `Date.parse` reads a date-time with
 * no offset as *host-local* and a bare date or year as a valid instant. Either
 * would silently displace an observation by the host's UTC offset, or invent
 * an instant from a calendar day, and then report the result as measured.
 *
 * 1. Any date-time carrying its own `Z` or `±HH:MM` offset — unambiguous.
 * 2. `YYYY-MM-DD HH:MM:SS[.sss]` with no offset, read deliberately as UTC.
 *    This is SQLite's own `datetime()` / `CURRENT_TIMESTAMP` output, whose
 *    documented convention is UTC. It is admitted by that convention alone,
 *    not by guessing.
 *
 * Everything else — a date, a year, a `T`-separated form with no offset, a
 * shape that is not a real instant — is refused rather than guessed.
 */
const INSTANT_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/u
const SQLITE_UTC_INSTANT = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/u

export function normalizeTimestamp(value) {
  if (typeof value !== "string") return null
  const text = value.trim()
  let candidate = null
  if (INSTANT_WITH_OFFSET.test(text)) candidate = text.replace(" ", "T")
  else if (SQLITE_UTC_INSTANT.test(text)) candidate = `${text.replace(" ", "T")}Z`
  if (candidate === null) return null
  // The shape can be right while the instant is not: month 13, hour 25.
  const parsed = Date.parse(candidate)
  if (Number.isNaN(parsed)) return null
  return new Date(parsed).toISOString()
}
