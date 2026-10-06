// The known-hit record of the Desk-problem filer: every time `fileDeskProblem` recognises an already
// filed problem (`known`, closed ones included), the hit is counted per issue number in
// `status.json.desk_problem_known`, so a Desk problem that comes back after its fix is visible. The
// verify step of the improvement loop reads it through `knownHitsSince`, the one place that compares
// versions.
//
// Shape: `{ "<issue number>": { count, last_at, last_version } }` -- integers, one ISO timestamp and one
// version string, never text from the failure. `last_version` is the highest Desk version that hit the
// issue (not simply the latest hit), so a later hit from a machine on an older Desk cannot hide a hit at
// a newer one.
//
// Bounded: at most `MAX_KNOWN_ISSUES` issues are kept; past that the entries with the oldest `last_at`
// are dropped, and entries that are not a valid record are dropped too. A dropped issue reads as
// `not_recorded` (never as "no hits").
//
// Whenever an entry is removed (by the bound, or because it was not a valid record) the record
// remembers it in `status.json.desk_problem_known_dropped = { count, last_dropped_at }` (two content-free
// values), so the reader can tell "never hit" from "the answer may have been dropped". The filer counts a drop
// the same way for every Desk problem it could not file or whose hit it could not record (`recordLostHit`).
//
// `status.json.desk_problem_known_since` is the time recording started on this machine, set once (by the
// first recording or by `armKnownHits`) and never moved; a reset or replaced status file has none, so the
// reader cannot mistake it for "nothing was hit". A write never turns damage into a clean record: damage it
// finds (a damaged drop record, a map of the wrong type, a damaged entry for the issue, a damaged start time)
// is counted in the drop record.
//
// A headless factory session (`DESK_FACTORY_HEADLESS` set and not empty or `0`) writes no state.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { randomBytes } from "node:crypto"

import { isHeadlessFactorySession } from "./headless-flag.js"
import { updateStatus } from "./outbox.js"

export const KNOWN_KEY = "desk_problem_known"
export const DROPPED_KEY = "desk_problem_known_dropped"
export const SINCE_KEY = "desk_problem_known_since"
export const PENDING_KEY = "desk_problem_known_pending"
export const MAX_PENDING_FILINGS = 32
export const MAX_KNOWN_ISSUES = 50

const VERSION_PATTERN = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/u

function parseVersion(text) {
  const match = typeof text === "string" ? VERSION_PATTERN.exec(text) : null
  if (match === null) return null
  return { core: [match[1], match[2] ?? "0", match[3] ?? "0"].map(Number), pre: match[4] === undefined ? null : match[4].split(".") }
}

function compareIdentifier(a, b) {
  const aNumber = /^\d+$/u.test(a)
  const bNumber = /^\d+$/u.test(b)
  if (aNumber && bNumber) return Math.sign(Number(a) - Number(b))
  if (aNumber !== bNumber) return aNumber ? -1 : 1
  return a === b ? 0 : (a < b ? -1 : 1)
}

/** `compareVersions(a, b) -> -1 | 0 | 1 | null`: semver precedence of two Desk versions; `null` when either is not a version. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1
  }
  if (left.pre === null || right.pre === null) return left.pre === right.pre ? 0 : (left.pre === null ? 1 : -1)
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1
    if (right.pre[index] === undefined) return 1
    const order = compareIdentifier(left.pre[index], right.pre[index])
    if (order !== 0) return order
  }
  return 0
}

const validEntry = (entry) => entry !== null && typeof entry === "object" && Number.isSafeInteger(entry.count) && entry.count >= 1
  && typeof entry.last_at === "string" && Number.isFinite(Date.parse(entry.last_at)) && parseVersion(entry.last_version) !== null

const validTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value))
const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

const validDropped = (dropped) => dropped !== null && typeof dropped === "object" && Number.isSafeInteger(dropped.count) && dropped.count >= 0
  && (dropped.last_dropped_at === null || validTime(dropped.last_dropped_at))

const isHeadless = isHeadlessFactorySession

// The start time and the drop record after one write: `removed` is how many entries or damaged pieces this write discarded.
function stamped(current, at, removed) {
  const damaged = (current[SINCE_KEY] !== undefined && !validTime(current[SINCE_KEY])) + (current[DROPPED_KEY] !== undefined && !validDropped(current[DROPPED_KEY]))
  const total = removed + damaged
  const earlier = validDropped(current[DROPPED_KEY]) ? current[DROPPED_KEY] : { count: 0, last_dropped_at: null }
  const dropped = total === 0 ? earlier : { count: earlier.count + total, last_dropped_at: at }
  return { [SINCE_KEY]: validTime(current[SINCE_KEY]) ? current[SINCE_KEY] : at, ...(total === 0 && current[DROPPED_KEY] === undefined ? {} : { [DROPPED_KEY]: dropped }) }
}

/**
 * `recordKnownHit(env, issueNumber, { version, now }) -> { recorded: true } | { recorded: false, code }`.
 * Never throws. Codes: `headless_session`, `bad_issue_number`, `bad_version`, `status_write_failed`.
 */
export async function recordKnownHit(env, issueNumber, { version, now = Date.now } = {}) {
  if (isHeadless(env)) return { recorded: false, code: "headless_session" }
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return { recorded: false, code: "bad_issue_number" }
  if (parseVersion(version) === null) return { recorded: false, code: "bad_version" }
  const at = new Date(now()).toISOString()
  try {
    await updateStatus(env, (current) => {
      const raw = current[KNOWN_KEY]
      const wrongType = raw !== undefined && (raw === null || typeof raw !== "object" || Array.isArray(raw))
      const kept = raw !== undefined && !wrongType ? raw : {}
      const others = Object.entries(kept).filter(([key]) => key !== String(issueNumber))
      const entries = others.filter(([key, entry]) => /^[1-9]\d*$/u.test(key) && validEntry(entry))
      const before = kept[issueNumber]
      const ownDamaged = before !== undefined && !validEntry(before)
      const highest = validEntry(before) && compareVersions(before.last_version, version) === 1 ? before.last_version : version
      entries.push([String(issueNumber), { count: validEntry(before) ? before.count + 1 : 1, last_at: at, last_version: highest }])
      entries.sort((a, b) => Date.parse(b[1].last_at) - Date.parse(a[1].last_at))
      const removed = others.length - (entries.length - 1) + Math.max(0, entries.length - MAX_KNOWN_ISSUES) + wrongType + ownDamaged
      return { ...current, [KNOWN_KEY]: Object.fromEntries(entries.slice(0, MAX_KNOWN_ISSUES)), ...stamped(current, at, removed) }
    })
    return { recorded: true }
  } catch {
    return { recorded: false, code: "status_write_failed" }
  }
}

/**
 * `recordLostHit(env, { now }) -> { recorded: true } | { recorded: false, code }`: a Desk problem happened on this machine and the filer
 * could not tell whether it was a known issue coming back, or could not record that it was (no suitable account, offline, the deadline, a
 * failed listing, a failed hit write). It counts one drop in `desk_problem_known_dropped`, so `knownHitsSince` reads `not_recorded` for a
 * window that includes it, never a measured "no hit" (fail closed, ruling 2026-10-06). Never throws. Codes: `headless_session`,
 * `status_write_failed`.
 */
export async function recordLostHit(env, { now = Date.now } = {}) {
  if (isHeadless(env)) return { recorded: false, code: "headless_session" }
  const at = new Date(now()).toISOString()
  try {
    await updateStatus(env, (current) => ({ ...current, ...stamped(current, at, 1) }))
    return { recorded: true }
  } catch {
    return { recorded: false, code: "status_write_failed" }
  }
}

/**
 * `beginFiling(env, { now }) -> token | null`: the filer is about to look for a Desk problem's issue. It records the attempt in
 * `desk_problem_known_pending` (`{ <token>: <ISO time> }`) before any network step, and `endFiling` removes it once the outcome (a hit, a
 * new issue, a cap hold or a drop) is recorded. A filer that is killed or dies before then leaves the attempt behind, and `knownHitsSince`
 * reads a window that includes it as `not_recorded`, never a measured "no hit". At most `MAX_PENDING_FILINGS` are kept; an older one past
 * that counts as a drop. `null` (headless, or the write failed) means nothing was recorded. Never throws.
 */
export async function beginFiling(env, { now = Date.now } = {}) {
  if (isHeadless(env)) return null
  const at = new Date(now()).toISOString()
  const token = randomBytes(8).toString("hex")
  try {
    await updateStatus(env, (current) => {
      const raw = current[PENDING_KEY]
      const kept = isRecord(raw) ? Object.entries(raw).filter(([, value]) => validTime(value)) : []
      const removed = (raw !== undefined && !isRecord(raw)) + (isRecord(raw) ? Object.keys(raw).length - kept.length : 0)
      kept.sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
      const pending = [[token, at], ...kept.slice(0, MAX_PENDING_FILINGS - 1)]
      return { ...current, [PENDING_KEY]: Object.fromEntries(pending), ...stamped(current, at, removed + Math.max(0, kept.length - (MAX_PENDING_FILINGS - 1))) }
    })
    return token
  } catch {
    return null
  }
}

/** `endFiling(env, token)`: removes the attempt `beginFiling` recorded. Never throws; an attempt left behind reads as a drop. */
export async function endFiling(env, token) {
  if (token === null) return
  try {
    await updateStatus(env, (current) => {
      if (!isRecord(current[PENDING_KEY]) || !Object.hasOwn(current[PENDING_KEY], token)) return current
      const { [token]: _done, ...rest } = current[PENDING_KEY]
      return { ...current, [PENDING_KEY]: rest }
    })
  } catch {
    // Left behind, the attempt reads as a drop: fail closed.
  }
}

/**
 * `armKnownHits(env, { now }) -> { armed: true } | { armed: false, code }`: stamps `recording_since` if the
 * status has none (the verify step calls it when a Desk-problem card starts being verified); an existing
 * start time is never moved. Never throws. Codes: `headless_session`, `status_write_failed`.
 */
export async function armKnownHits(env, { now = Date.now } = {}) {
  if (isHeadless(env)) return { armed: false, code: "headless_session" }
  const at = new Date(now()).toISOString()
  try {
    await updateStatus(env, (current) => ({ ...current, ...stamped(current, at, 0) }))
    return { armed: true }
  } catch {
    return { armed: false, code: "status_write_failed" }
  }
}

/**
 * `knownHitsSince(status, issueNumber, version, { since, launches }) -> { state: "measured", hit: boolean } | { state: "unavailable", reason }`.
 * `launches` are the times of filer launches whose filer has not recorded an outcome (`filer-launch.js` `pendingLaunchTimes`); one at or
 * after `since` reads like a drop.
 * Pure, and the answer is for this machine only. `since` (an ISO string, a Date or epoch milliseconds) is
 * required: the answer is `measured` only when recording started on this machine at or before `since`
 * (`recording_since`); a reset or fresh status, or one that started later, is `not_recorded`. Every machine
 * running a Desk at or after a fix runs the recorder, so with recording started an issue with no entry means
 * "no hit recorded here", provided nothing was dropped at or after `since` (`DROPPED_KEY`, whose
 * `last_dropped_at` is the latest drop): a drop in that window could have lost the answer, so it reads
 * `not_recorded`. A drop before `since` cannot hide a hit after it, and a drop count with no time is read as
 * in the window. The filer counts a drop for every Desk problem it could not file or whose hit it could not
 * record (`recordLostHit`). `hit` is true when the issue was hit at `version` or a later Desk version.
 *
 * Accepted gap: a headless evaluator session records nothing by rule, and reads as no hit. So does a hit
 * whose drop record could not be written either (one stderr code).
 *
 * Reasons: `not_recorded`, `damaged`, `bad_version`, `bad_issue_number`, `bad_since`.
 */
export function knownHitsSince(status, issueNumber, version, { since, launches = [] } = {}) {
  const unavailable = (reason) => ({ state: "unavailable", reason })
  if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) return unavailable("bad_issue_number")
  if (parseVersion(version) === null) return unavailable("bad_version")
  const sinceMs = since instanceof Date ? since.getTime() : (typeof since === "string" ? Date.parse(since) : since)
  if (typeof sinceMs !== "number" || !Number.isFinite(sinceMs)) return unavailable("bad_since")
  if (status === undefined || status === null) return unavailable("not_recorded")
  const map = status[KNOWN_KEY]
  const dropped = status[DROPPED_KEY]
  if (dropped !== undefined && !validDropped(dropped)) return unavailable("damaged")
  if (map !== undefined && (map === null || typeof map !== "object" || Array.isArray(map))) return unavailable("damaged")
  const started = status[SINCE_KEY]
  if (started === undefined) return unavailable("not_recorded")
  if (!validTime(started)) return unavailable("damaged")
  if (Date.parse(started) > sinceMs) return unavailable("not_recorded")
  const pending = status[PENDING_KEY]
  if (pending !== undefined && !isRecord(pending)) return unavailable("damaged")
  // A filing that started in the window and never recorded its outcome (killed, or still running) may have lost a hit.
  const pendingInWindow = pending !== undefined && Object.values(pending).some((at) => !validTime(at) || Date.parse(at) >= sinceMs)
  // So may a filer launched in the window that never recorded an outcome, or never started (`filer-launch.js` `pendingLaunchTimes`).
  const launchedInWindow = launches.some((at) => !(at < sinceMs))
  const droppedInWindow = pendingInWindow || launchedInWindow || (dropped?.count > 0 && (dropped.last_dropped_at === null || Date.parse(dropped.last_dropped_at) >= sinceMs))
  if (map === undefined || !Object.hasOwn(map, issueNumber)) return droppedInWindow ? unavailable("not_recorded") : { state: "measured", hit: false }
  const entry = map[issueNumber]
  if (!validEntry(entry)) return unavailable("damaged")
  return { state: "measured", hit: compareVersions(entry.last_version, version) >= 0 }
}
