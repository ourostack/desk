// Builds the capture record one store receives from this machine's local
// coverage (`status.coverage`, written by `capture-sweep.js`), and the empty
// record that retracts it.
//
// Scope, which is the privacy rule of this file: the record for store S sums
// only the `by_owner` buckets of owner S and of `-` (no owner). The owner `?`
// (withheld: the session's store cannot be told, a desk's receipts name two stores, or an unowned session on a machine with two contributing stores) and every other store are
// left out of both the numerator and the denominator, so the record shows
// nothing about work that belongs elsewhere. Store names in `by_owner` are
// lower-cased by the sweep, so the store is lower-cased here and compared
// exactly. A host that is not `counted`, or that has no session in scope, is
// omitted (never zero): an all-zero host cannot be told from an uncounted one. When any host could not be counted (capped or unreadable) the result is `null`: a record without it would overwrite the store's true counts for that host, and the local `status.json` says why.
//
// Unowned sessions (`-`) count only while at most one store contributes. The sweep decides that
// when it runs, so the caller passes the current number of contributing stores (`contributing`)
// and `-` is left out above one: coverage swept before a second store opted in cannot leak.
// The `unverified` flag is scoped too. The host's own flag for Codex rests on receipts, which can
// belong to any store, so it is never read for Codex: the Codex entry is verified only when this
// store's scope holds a derived Codex session, the host's `undetermined` count is absent or
// exactly 0, and `fallback` is not true. The other hosts' flag comes from the listing itself.
// The optional `loop` is a pass-through: the caller owns per-store scoping of it, and the sibling
// that defines it must use enums only. This module never makes one.
//
// Result of `captureFor`:
//   - `{ path, bytes, sha }`: publish `bytes` at `path`; `sha` is the git blob
//     sha of the bytes, the value the delivered record keeps.
//   - `null`: nothing to say and nothing to retract.
//   - `{ invalid: "capture_invalid" }` (`CAPTURE_INVALID`): the record failed
//     its own gate, or an input was malformed. That is a bug in the caller or
//     the coverage, never a user problem; record the fixed code and send nothing.
// The result never carries a store name, a count or a message.

import { gitBlobSha } from "./outbox.js"
import { CAPTURE_LOOP_KEY, CAPTURE_PATH, CAPTURE_SCHEMA, validateCaptureBytes, validateLoopSlot } from "./capture-schema.js"
import { ENUMS, PATTERNS } from "./schema.js"

export const CAPTURE_INVALID = "capture_invalid"
export const OWNER_NONE = "-"

const INTAKE_ID = /^[0-9a-f]{16}$/u
const BUCKETS = ["derived", "held", "frozen", "pending", "not_seen"]
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const serialize = (record) => `${JSON.stringify(record)}\n`

/** The retraction bytes: no host, no loop. */
export const EMPTY_RECORD = serialize({ schema: CAPTURE_SCHEMA, basis: "still_on_disk", hosts: {} })

const invalid = () => ({ invalid: CAPTURE_INVALID })

/** `isCaptureInvalid(result) -> boolean`, for the flush. */
export const isCaptureInvalid = (result) => isObject(result) && result.invalid === CAPTURE_INVALID

// One host's entry for `owners`, `null` when the host is out of scope, or `undefined` when its input is malformed.
function hostEntry(name, host, owners) {
  if (!isObject(host) || host.state !== "counted") return null
  if (!isObject(host.by_owner) || typeof host.unverified !== "boolean") return undefined
  const withDesk = host.not_in_a_desk !== null
  const keys = withDesk ? [...BUCKETS, "not_in_a_desk"] : BUCKETS
  // The host's own buckets must add up to its on_disk: an input that does not is refused, not repaired.
  const hostTotal = keys.reduce((sum, key) => sum + (isCount(host[key]) ? host[key] : Number.NaN), 0)
  if (!isCount(host.on_disk) || hostTotal !== host.on_disk) return undefined
  const sums = Object.fromEntries(keys.map((key) => [key, 0]))
  const all = Object.fromEntries(keys.map((key) => [key, 0]))
  for (const [owner, buckets] of Object.entries(host.by_owner)) {
    if (!isObject(buckets)) return undefined
    for (const key of keys) {
      if (!isCount(buckets[key])) return undefined
      all[key] += buckets[key]
      if (owners.has(owner)) sums[key] += buckets[key]
    }
    // A bucket the host cannot tell (null `not_in_a_desk`) must not be filled in an owner row.
    if (!withDesk && buckets.not_in_a_desk !== undefined && buckets.not_in_a_desk !== null && buckets.not_in_a_desk !== 0) return undefined
  }
  // The owner rows over every owner must add up to the host's own buckets: an input that does not is refused, not repaired.
  if (keys.some((key) => all[key] !== host[key])) return undefined
  const onDisk = keys.reduce((sum, key) => sum + sums[key], 0)
  if (onDisk === 0) return null
  return {
    on_disk: onDisk,
    derived: sums.derived,
    held: sums.held,
    frozen: sums.frozen,
    pending: sums.pending,
    not_seen: sums.not_seen,
    not_in_a_desk: withDesk ? sums.not_in_a_desk : null,
    // Only Codex is told by evidence that can belong to another store, so it needs a derived session in this scope.
    unverified: name === "codex-cli" ? !(sums.derived > 0 && (host.undetermined === undefined || host.undetermined === 0) && host.fallback !== true) : host.unverified,
  }
}

// The loop slot, key-sorted so equal input gives equal bytes; `null` when absent or not valid (never invented, never repaired).
function loopSlot(loop) {
  if (!isObject(loop) || Object.keys(loop).length === 0 || !validateLoopSlot(loop, "", [])) return null
  return Object.fromEntries(Object.keys(loop).sort().map((key) => [key, loop[key]]))
}

/**
 * `captureFor(coverage, { store, intakeId, sentBefore, loop, contributing }) -> { path, bytes, sha } | null | { invalid }`.
 * `coverage` is the local `status.coverage` (or null). `store` is the store the record goes to; `intakeId`
 * is the machine's 16-hex id for it, and `contributing` is the current count of stores with `contribute: true`
 * (an integer of 1 or more, else the result is invalid); above 1, unowned sessions are left out. `sentBefore` says a record was delivered earlier, so an empty scope
 * retracts it. `loop` is the optional closed-loop health record (this module never makes one); it is
 * carried only when valid and only on a record that has hosts.
 */
export function captureFor(coverage, { store, intakeId, sentBefore = false, loop, contributing } = {}) {
  if (typeof store !== "string" || !PATTERNS.prRepo.test(store) || typeof intakeId !== "string" || !INTAKE_ID.test(intakeId)) return invalid()
  if (!Number.isSafeInteger(contributing) || contributing < 1) return invalid()
  // No coverage is not an emptied scope: say nothing, and retract nothing.
  if (!isObject(coverage) || !isObject(coverage.hosts)) return null
  const owners = new Set(contributing > 1 ? [store.toLowerCase()] : [store.toLowerCase(), OWNER_NONE])
  const path = `capture/${intakeId}.json`
  const hosts = {}
  const sourceHosts = coverage.hosts
  for (const name of ENUMS.host) {
    if (!Object.hasOwn(sourceHosts, name)) continue
    const entry = hostEntry(name, sourceHosts[name], owners)
    if (entry === undefined) return invalid()
    // A host that could not be counted (capped, unreadable) means the record would drop it and overwrite the store's true counts for it: say nothing and keep the record already there.
    if (entry === null && !["counted", "absent"].includes(sourceHosts[name]?.state)) return null
    if (entry !== null) hosts[name] = entry
  }
  let bytes = EMPTY_RECORD
  if (Object.keys(hosts).length === 0) {
    if (sentBefore !== true) return null
  } else {
    const slot = loopSlot(loop)
    bytes = serialize({ schema: CAPTURE_SCHEMA, basis: "still_on_disk", hosts, ...(slot === null ? {} : { [CAPTURE_LOOP_KEY]: slot }) })
  }
  if (!CAPTURE_PATH.test(path) || !validateCaptureBytes(bytes).ok) return invalid()
  return { path, bytes, sha: gitBlobSha(bytes) }
}
