// Timestamp and interval helpers shared by the factory.
//
// `src/factory/**` may only import `node:` built-ins and other
// `src/factory/` files; this module imports the shared patterns from
// `./schema.js`, itself a factory file, and nothing else.

import { PATTERNS } from "./schema.js"

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

// A strict, unambiguous instant only: `PATTERNS.timestamp` (the same shape a
// facts file requires) or nothing. `Date.parse` alone would also accept a
// host-local form with no offset, silently displacing the instant by the
// host's UTC offset — exactly the ambiguity `normalizeTimestamp` above
// refuses. A non-string (including `null`, from a malformed or absent
// entry) simply doesn't match rather than throwing.
function parseStrictTimestamp(value) {
  if (typeof value !== "string" || !PATTERNS.timestamp.test(value)) return NaN
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? NaN : parsed
}

/**
 * Merge `{start, end}` intervals (ISO strings) into sorted, non-overlapping
 * spans. An entry whose times don't match `PATTERNS.timestamp`, or whose
 * `end` is before its `start`, is dropped and counted in `invalid` rather
 * than distorting the union.
 */
function mergeNumeric(intervals) {
  const valid = []
  let invalid = 0
  for (const entry of intervals) {
    const start = parseStrictTimestamp(entry?.start)
    const end = parseStrictTimestamp(entry?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      invalid += 1
      continue
    }
    valid.push([start, end])
  }
  valid.sort((a, b) => a[0] - b[0])
  const merged = []
  for (const [start, end] of valid) {
    const last = merged[merged.length - 1]
    if (last && start <= last[1]) last[1] = Math.max(last[1], end)
    else merged.push([start, end])
  }
  return { merged, invalid }
}

export function unionIntervals(intervals) {
  const { merged, invalid } = mergeNumeric(intervals)
  return {
    intervals: merged.map(([start, end]) => ({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
    })),
    invalid,
  }
}

/** Total milliseconds covered by the merged union of `intervals`. */
export function intervalUnion(intervals) {
  const { merged } = mergeNumeric(intervals)
  return merged.reduce((total, [start, end]) => total + (end - start), 0)
}
