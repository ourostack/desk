// Improvement cards: one file per card, a stable key, a claim and legal moves.
//
// A card lives on the desk at `<desk>/<person prefix>/_meta/improvement/<source>--<12 hex of
// sha256(key)>.md`. `personPrefix` is "" for a solo desk and `desks/<alias>` in a crew desk.
// A card holds pointers and counts only: never prompt text, command text, file content or an
// absolute path. The only URLs are `countermeasure` (a GitHub pull request) and `kaizen_url`
// (a GitHub issue), each checked by shape. This module does not commit to Git: every function
// that writes returns the card file's absolute path so the caller can commit exactly that file.
//
// Reading checks shape only; writing enforces the frozen tables and lists. Machines on different Desk
// versions share a desk through Git, so a card whose title, id, close reason or check result is well
// formed but not in this version's tables is a valid card on read, and only what this version writes
// (`openImprovement`, `updateCard`) must be in the tables.
//
// Wrong states are impossible, not discouraged. A file that does not parse, breaks the shape, is
// oversized, or is a link or directory is never read as a card and never guessed at: `readCards` counts
// it, and the three writers (`claimNext`, `openImprovement`, `updateCard`) move it aside by rename into
// `improvement/invalid/` under the lock before they act, so the loop heals itself and a set-aside
// card's claim no longer counts (a bounded, visible gap). A file that cannot be read at all (a
// permission fault) is left in place and counted, never moved, and does not block a claim. Files that
// may appear beside the cards, and that a commit step must never stage: the directory
// `_meta/.improvement.lock/` and `_meta/.improvement-<pid>-<hex>.tmp`.
//
// The file is YAML front matter in which every value is JSON (valid YAML) plus a fixed body.
// Every write takes a lock file created with `wx` beside the card folder (a lock older than two
// minutes is taken over) and writes a temp file that is renamed over the card.

import { promises as fs, constants as fsConstants } from "node:fs"
import * as path from "node:path"
import { createHash, randomBytes, randomUUID } from "node:crypto"
import { PUBLIC_PLUGINS, isGeneric } from "../factory/kaizen-file.js"
import { PATTERNS } from "../factory/schema.js"
import { readMachineSecret } from "../factory/outbox.js"
import { RECONCILE_REASONS } from "../factory/reconcile-reasons.js"
import { MEASURE_IDS } from "../factory/pipeline/rollups.js"

export const SOURCES = Object.freeze(["andon", "friction_candidate", "reconcile_class", "desk_problem", "store_build", "evaluator", "loop_alarm", "flush_health"])
export const STATES = Object.freeze(["open", "claimed", "shipped", "verifying", "closed_confirmed", "closed_unverified"])
export const MOVES = Object.freeze({
  open: Object.freeze(["claimed", "closed_unverified"]),
  claimed: Object.freeze(["open", "shipped", "closed_unverified"]),
  shipped: Object.freeze(["verifying", "closed_confirmed", "closed_unverified", "open"]),
  verifying: Object.freeze(["closed_confirmed", "closed_unverified", "open"]),
  closed_confirmed: Object.freeze(["open"]),
  closed_unverified: Object.freeze(["open"]),
})
export const CLAIM_TTL_HOURS = 4
export const MAX_CLAIMS_PER_DAY = 2
export const MAX_LIVE_CLAIMS = 1
const STEP_NAMES = ["evaluate", "route", "mirror", "reconcile", "verify", "measure", "deliver"]
export const LOOP_ALARMS = Object.freeze(["improvement_age", "improvement_stuck", "unsigned_age", "headless_blocked", "labels_quarantined", "cards_invalid", "capture_loop_slot", ...STEP_NAMES.map((step) => `step_stale:${step}`)])
export const EVALUATOR_NAMES = Object.freeze(["expired_requests", "gave_up"])
export const FLUSH_HEALTH_CODES = Object.freeze(["no_account", "auth_failed", "gh_missing", "account_cannot_deliver", "route_unknown", "held_markers", "frozen"])
// The reconcile reasons come from the one list the reconcile code keeps; the measure IDs from the one list the kaizen filer accepts.
export { RECONCILE_REASONS, MEASURE_IDS }
// Why a card closed (the close-rules ruling and the verify step), and what a daily check found.
export const CLOSE_REASONS = Object.freeze([
  "confirmed", "thin_data_after_14_checks", "merged_without_signal", "version_unavailable", "andon_closed", "desk_problem_quiet",
  "reconcile_zero_twice", "store_build_closed", "condition_cleared", "wont_fix", "duplicate", "not_reproducible",
  "source_recovered",
])
export const CHECK_RESULTS = Object.freeze([
  "version_set", "confirmed", "not_confirmed", "thin_data", "version_unavailable", "countermeasure_not_merged", "recovered", "still_recurring", "waiting", "checks_not_green",
])
export const MAX_CARD_FILES = 2000
export const SET_ASIDE_FOLDER = "invalid"

const SCHEMA = "desk.improvement/1"
const MAX_TITLE = 120
const MAX_EVIDENCE = 10
const MAX_CLAIM_LOG = 10
const MAX_FILE_BYTES = 16 * 1024
const MAX_FILES = 200
const LOCK_NAME = ".improvement.lock"
const MACHINE = /^[0-9a-f]{8,64}$/u
const CODE = /^[a-z][a-z0-9_]{0,63}$/u
const MEASURE_SHAPE = /^[a-z][a-z0-9_.]{0,63}$/u
const LOCK_STALE_MS = 2 * 60 * 1000
const LOCK_WAIT_MS = 5000
const LOCK_POLL_MS = 10
const HOUR_MS = 60 * 60 * 1000

const FIELDS = [
  "schema", "key", "source", "title", "evidence", "opened_at", "last_opened_at", "state", "claim", "claim_log", "countermeasure", "plugin", "signal",
  "kaizen_url", "shipped_version", "checks_run", "last_check_at", "last_check_result", "recurrences", "reopened", "closed_at", "close_reason", "verifying_since",
]
const IMMUTABLE = ["key", "source", "opened_at"]
const REPO_ISSUE = /^(.+)#(\d{1,9})$/u
const URL_SHAPE = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})\/(pull|issues)\/\d{1,9}$/u
const FILE_NAME = /^([a-z_]+)--([0-9a-f]{12})\.md$/u
const CONTROL = /[\u0000-\u001f\u007f]/u
const ABSOLUTE_PATH = /(^|[\s("'`=])(\/[A-Za-z0-9._-]+|[A-Za-z]:[\\/])/u
const PREFIX_SEGMENT = /^[A-Za-z0-9._-]+$/u

const isRepoIssue = (id) => {
  const match = REPO_ISSUE.exec(id)
  return match !== null && PATTERNS.prRepo.test(match[1])
}
const ID_CHECKS = {
  andon: isRepoIssue,
  store_build: isRepoIssue,
  desk_problem: (id) => isRepoIssue(id) && id.startsWith("ourostack/desk#"),
  friction_candidate: (id) => /^[0-9a-f]{32}$/u.test(id),
  reconcile_class: (id) => RECONCILE_REASONS.includes(id),
  evaluator: (id) => EVALUATOR_NAMES.includes(id),
  flush_health: (id) => FLUSH_HEALTH_CODES.includes(id),
  loop_alarm: (id) => LOOP_ALARMS.includes(id),
}

// Reading and updating accept any well-formed id (`ID_SHAPES`); writing a new key needs the frozen lists (`ID_CHECKS`).
const ID_SHAPES = {
  ...ID_CHECKS,
  desk_problem: isRepoIssue,
  reconcile_class: (id) => CODE.test(id),
  evaluator: (id) => CODE.test(id),
  flush_health: (id) => CODE.test(id),
  loop_alarm: (id) => /^[a-z][a-z0-9_]{0,63}(:[a-z][a-z0-9_]{0,63})?$/u.test(id),
}

function keyParts(key, strict = false) {
  if (typeof key !== "string") return null
  const colon = key.indexOf(":")
  const source = key.slice(0, colon)
  if (colon < 0 || !SOURCES.includes(source) || !(strict ? ID_CHECKS : ID_SHAPES)[source](key.slice(colon + 1))) return null
  return { source, id: key.slice(colon + 1) }
}

const FLUSH_TITLES = {
  no_account: "Factory delivery has no account signed in",
  auth_failed: "Factory delivery account sign in failed",
  gh_missing: "Factory delivery cannot find the GitHub command",
  account_cannot_deliver: "No account that is signed in can deliver to the store",
  route_unknown: "Factory store route is unknown",
  held_markers: "Factory markers are held back",
  frozen: "Factory delivery is frozen",
}
const LOOP_TITLES = {
  improvement_age: "An improvement card has waited past the age threshold",
  improvement_stuck: "An improvement card has waited in verification past the stuck threshold",
  unsigned_age: "A delivery has waited unsigned past the age threshold",
  headless_blocked: "The headless evaluator is blocked",
  labels_quarantined: "Evaluation labels were quarantined",
  cards_invalid: "Improvement card files were set aside as invalid",
  capture_loop_slot: "The loop health record could not be sent to the store",
}

/**
 * `cardTitle(source, id, { plugin, signal }?) -> string | null`: the title the library builds for every source, from frozen
 * tables, so no free text enters a card. A friction candidate's title is fixed words plus the plugin name when it is a
 * public plugin and the signal when it is a known measure (null only for an unknown source).
 */
export function cardTitle(source, id, { plugin, signal } = {}) {
  switch (source) {
    case "andon": return "Store build andon is open"
    case "store_build": return "Store build is failing"
    case "desk_problem": return "Desk problem filed as a GitHub issue"
    case "reconcile_class": return `Reconcile mismatch: ${id}`
    case "friction_candidate": return `System friction${PUBLIC_PLUGINS.includes(plugin) ? ` in the ${plugin} plugin` : ""}${MEASURE_IDS.includes(signal) ? ` moving ${signal}` : ""}`
    case "evaluator": return id === "gave_up" ? "Evaluation requests were given up after repeated attempts" : "Evaluation requests expired without a label"
    case "flush_health": return FLUSH_TITLES[id]
    case "loop_alarm": return id.startsWith("step_stale:") ? `Loop step ${id.slice("step_stale:".length)} is stale` : LOOP_TITLES[id]
    default: return null
  }
}

/** `cardKey(source, id) -> string`: the stable key `<source>:<id>`; throws `invalid_source` for an id the source does not allow. */
export function cardKey(source, id) {
  const key = `${source}:${id}`
  if (!SOURCES.includes(source) || keyParts(key, true) === null) throw new TypeError("invalid_source")
  return key
}

function locationFolder(deskRoot, personPrefix) {
  const segments = personPrefix === "" ? [] : String(personPrefix).split("/")
  const clean = typeof personPrefix === "string" && segments.every((segment) => PREFIX_SEGMENT.test(segment) && segment !== "." && segment !== "..")
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot) || !clean) return null
  return path.join(deskRoot, ...segments, "_meta")
}

const cardFileName = (key) => `${keyParts(key).source}--${createHash("sha256").update(key).digest("hex").slice(0, 12)}.md`

/** `cardFile(deskRoot, personPrefix, key) -> string`: the card's absolute path; throws `invalid_location` or `invalid_source`. */
export function cardFile(deskRoot, personPrefix, key) {
  const meta = locationFolder(deskRoot, personPrefix)
  if (meta === null) throw new TypeError("invalid_location")
  if (keyParts(key) === null) throw new TypeError("invalid_source")
  return path.join(meta, "improvement", cardFileName(key))
}

function toDate(now) {
  const date = now === undefined ? new Date() : new Date(now)
  if (Number.isNaN(date.getTime())) throw new TypeError("now must be a Date or a millisecond number")
  return date
}

/** `isClaimLive(card, now) -> boolean`: the card carries a claim whose expiry is still ahead of `now` (a Date or milliseconds). */
export function isClaimLive(card, now) {
  return card.claim !== null && card.claim.expires_at !== null && Date.parse(card.claim.expires_at) > new Date(now).getTime()
}

// ---------------------------------------------------------------------------
// Field rules

const isTimestamp = (value) => typeof value === "string" && PATTERNS.timestamp.test(value) && !Number.isNaN(Date.parse(value))
const nullable = (check) => (value) => value === null || check(value)
const isCount = (value) => Number.isInteger(value) && value >= 0 && value <= 1000000
const isMachine = (value) => typeof value === "string" && MACHINE.test(value)
const oneOf = (list) => (value) => list.includes(value)

function isPointer(value, strict) {
  if (typeof value !== "string") return false
  const colon = value.indexOf(":")
  const rest = value.slice(colon + 1)
  switch (value.slice(0, colon)) {
    case "job": return PATTERNS.jobId.test(rest)
    case "fingerprint": return /^[0-9a-f]{8,64}$/u.test(rest)
    case "reconcile": return /^[a-z_]+@\d{1,6}$/u.test(rest) && (!strict || RECONCILE_REASONS.includes(rest.slice(0, rest.indexOf("@"))))
    case "issue":
    case "pr": return isRepoIssue(rest)
    default: return false
  }
}

const isEvidence = (value) => Array.isArray(value) && value.length <= MAX_EVIDENCE && value.every((pointer) => isPointer(pointer, true))
const isEvidenceShape = (value) => Array.isArray(value) && value.length <= MAX_EVIDENCE && value.every((pointer) => isPointer(pointer, false))

function isGithubUrl(kind) {
  return (value) => {
    const match = typeof value === "string" ? URL_SHAPE.exec(value) : null
    return match !== null && match[2] === kind && PATTERNS.prRepo.test(match[1])
  }
}

function isFrictionTitle(value) {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_TITLE && !CONTROL.test(value)
}
const isCleanTitle = (value) => isGeneric(value) && !ABSOLUTE_PATH.test(value)

function isClaim(value) {
  if (value === null) return true
  const keys = typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort().join() : ""
  return keys === "claim_id,claimed_at,expires_at,machine,session" && PATTERNS.sessionId.test(String(value.claim_id)) && isTimestamp(value.claimed_at) &&
    nullable(isTimestamp)(value.expires_at) && isMachine(value.machine) && nullable((id) => PATTERNS.sessionId.test(String(id)))(value.session)
}

function isClaimLogEntry(entry) {
  return entry !== null && typeof entry === "object" && Object.keys(entry).sort().join() === "at,machine" && isTimestamp(entry.at) && isMachine(entry.machine)
}

// The fields a later step may patch, each with its check and the code a refused value gets. `reopened` and
// `recurrences` are not patchable: only a counted move or `openImprovement` raises them.
const PATCHABLE = {
  state: [oneOf(STATES)],
  evidence: [isEvidence, "invalid_patch", isEvidenceShape],
  countermeasure: [nullable(isGithubUrl("pull")), "invalid_countermeasure"],
  kaizen_url: [nullable(isGithubUrl("issues")), "invalid_kaizen_url"],
  plugin: [(value) => typeof value === "string" && PATTERNS.pluginName.test(value)],
  signal: [nullable(oneOf(MEASURE_IDS)), "invalid_patch", nullable((value) => typeof value === "string" && MEASURE_SHAPE.test(value))],
  shipped_version: [nullable((value) => typeof value === "string" && PATTERNS.semver.test(value))],
  checks_run: [isCount],
  last_check_at: [nullable(isTimestamp)],
  last_check_result: [nullable(oneOf(CHECK_RESULTS)), "invalid_patch", nullable((value) => typeof value === "string" && CODE.test(value))],
  close_reason: [nullable(oneOf(CLOSE_REASONS)), "invalid_patch", nullable((value) => typeof value === "string" && CODE.test(value))],
}

// `card` is always the plain object `parse` returns.
function isCard(card) {
  if (Object.keys(card).sort().join() !== [...FIELDS].sort().join()) return false
  const parts = keyParts(card.key)
  const checks = [
    card.schema === SCHEMA,
    parts !== null && parts.source === card.source,
    isFrictionTitle(card.title) && isCleanTitle(card.title),
    isTimestamp(card.opened_at),
    isTimestamp(card.last_opened_at),
    isClaim(card.claim),
    Array.isArray(card.claim_log) && card.claim_log.length <= MAX_CLAIM_LOG && card.claim_log.every(isClaimLogEntry),
    nullable(isTimestamp)(card.closed_at),
    nullable(isTimestamp)(card.verifying_since),
    isCount(card.recurrences),
    isCount(card.reopened),
    ...Object.entries(PATCHABLE).map(([field, [strict, , shape = strict]]) => shape(card[field])),
  ]
  if (!checks.every(Boolean)) return false
  const closed = card.state.startsWith("closed_")
  return (card.state !== "claimed" || (card.claim !== null && card.claim.expires_at !== null)) &&
    (card.state !== "shipped" && card.state !== "verifying" ? true : card.countermeasure !== null) &&
    (card.state !== "verifying" || card.shipped_version !== null) &&
    closed === (card.closed_at !== null) && closed === (card.close_reason !== null)
}

// ---------------------------------------------------------------------------
// Files

function serialize(card) {
  const front = FIELDS.map((field) => `${field}: ${JSON.stringify(card[field])}`).join("\n")
  return `---\n${front}\n---\n# ${card.title}\n\nStanding improvement card. It holds pointers and counts only; read the front matter.\n`
}

function parse(text) {
  const lines = text.split("\n")
  const end = lines[0] === "---" ? lines.indexOf("---", 1) : -1
  if (end < 0) return null
  const data = {}
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z_]+): (.*)$/u.exec(line)
    if (match === null || Object.hasOwn(data, match[1])) return null
    try {
      data[match[1]] = JSON.parse(match[2])
    } catch {
      return null
    }
  }
  // A card written before the field existed reads as never having entered verification.
  if (!Object.hasOwn(data, "verifying_since")) data.verifying_since = null
  return data
}

// `{ card }` or `{ kind }`, kind being how the file failed. Reads no-follow and under the size cap.
async function inspect(file) {
  let stat
  try {
    stat = await fs.lstat(file)
  } catch {
    return { kind: "missing" }
  }
  if (stat.isSymbolicLink()) return { kind: "symlink" }
  if (!stat.isFile()) return { kind: "not_regular" }
  if (stat.size > MAX_FILE_BYTES) return { kind: "too_large" }
  let text
  try {
    text = await fs.readFile(file, { encoding: "utf8", flag: fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW })
  } catch {
    return { kind: "unreadable" }
  }
  const data = parse(text)
  if (data === null) return { kind: "unparseable" }
  return isCard(data) ? { card: data } : { kind: "invalid" }
}

// The card folder is missing (fine), a folder, or something else (unreadable).
async function folderState(folder) {
  try {
    const stat = await fs.lstat(folder)
    return stat.isDirectory() ? "directory" : "unreadable"
  } catch (error) {
    return error.code === "ENOENT" ? "missing" : "unreadable"
  }
}

// Reads the folder: the valid cards, how many of each kind were skipped, and the names of the files to set aside.
async function scan(deskRoot, personPrefix, limit) {
  const empty = { cards: [], unreadable: false, truncated: false, skipped: {}, bad: [], set_aside_total: 0, unreadable_files: 0 }
  const meta = locationFolder(deskRoot, personPrefix)
  if (meta === null) return { ...empty, unreadable: true }
  const folder = path.join(meta, "improvement")
  const state = await folderState(folder)
  if (state === "missing") return empty
  let names
  try {
    names = state === "directory" ? (await fs.readdir(folder)).filter((name) => name !== SET_ASIDE_FOLDER).sort() : null
  } catch {
    names = null
  }
  const aside = names === null ? null : await setAsideCount(folder)
  if (aside === null) return { ...empty, unreadable: true }
  const result = { ...empty, truncated: names.length > limit, set_aside_total: aside }
  const skip = (kind, name) => {
    result.skipped[kind] = (result.skipped[kind] ?? 0) + 1
    if (kind !== "foreign" && kind !== "unreadable") result.bad.push(name)
  }
  for (const name of names.slice(0, limit)) {
    if (!FILE_NAME.test(name)) {
      skip("foreign", name)
      continue
    }
    const found = await inspect(path.join(folder, name))
    if (found.card === undefined) skip(found.kind, name)
    else if (cardFileName(found.card.key) !== name) skip("misnamed", name)
    else result.cards.push(found.card)
  }
  result.unreadable_files = result.skipped.unreadable ?? 0
  return result
}

// How many files sit in `invalid/`; null when `invalid` is not a folder (or cannot be listed).
async function setAsideCount(folder) {
  const aside = path.join(folder, SET_ASIDE_FOLDER)
  const state = await folderState(aside)
  if (state === "missing") return 0
  try {
    return state === "directory" ? (await fs.readdir(aside)).length : null
  } catch {
    return null
  }
}

/**
 * `readCards({ deskRoot, personPrefix, limit = 200 }) -> { cards, unreadable, truncated, skipped, set_aside_total, unreadable_files }`. Read-only.
 * Bounded: regular files only, no-follow, at most 16 KiB each, at most `limit` files in name order
 * (`truncated` says more existed). A file that fails is counted in `skipped` by kind (`symlink`,
 * `not_regular`, `too_large`, `unreadable`, `unparseable`, `invalid`, `misnamed`, `foreign`) and never
 * returned. `set_aside_total` is how many files sit in `invalid/` (never read), and `unreadable_files` how many
 * card files could not be read and were left in place: durable state from which the measure step opens
 * `loop_alarm:cards_invalid`. An `invalid` entry that is not a folder makes the whole read `unreadable`.
 */
export async function readCards({ deskRoot, personPrefix, limit = MAX_FILES }) {
  const { cards, unreadable, truncated, skipped, set_aside_total: setAsideTotal, unreadable_files: unreadableFiles } = await scan(deskRoot, personPrefix, limit)
  return { cards, unreadable, truncated, skipped, set_aside_total: setAsideTotal, unreadable_files: unreadableFiles }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Takes the lock, a directory made with `mkdir` (atomic) that holds one empty directory named by the caller's unique token;
// `false` when it is not free within `wait` ms. Every step touches only the caller's own token path or the lock directory
// when empty, so no interleaving can remove a lock another caller holds: a caller owns the lock only if it made its token
// directory, and the creator retries when its lock directory was removed between the two `mkdir` calls. A lock whose token
// directory is older than two minutes is taken over by removing exactly that token directory (a second taker, or a
// holder releasing at the same time, finds it gone and starts again).
async function acquire(lock, token, wait, hooks) {
  const deadline = Date.now() + wait
  for (;;) {
    try {
      await fs.mkdir(lock)
      await hooks.afterLockDir?.(lock)
      await fs.mkdir(path.join(lock, token))
      return true
    } catch (error) {
      if (error.code === "ENOENT") continue
      if (error.code !== "EEXIST") throw error
    }
    const children = await fs.readdir(lock).catch(() => null)
    await hooks.afterList?.(lock)
    const stat = children === null ? null : await fs.stat(children.length === 0 ? lock : path.join(lock, children[0])).catch(() => null)
    if (stat !== null && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      await hooks.afterStale?.(lock)
      for (const child of children) await fs.rm(path.join(lock, child), { recursive: true, force: true })
      await fs.rmdir(lock).catch(() => {})
    } else if (Date.now() >= deadline) {
      return false
    } else {
      await sleep(LOCK_POLL_MS)
    }
  }
}

// Runs `work({ folder, meta, cards, truncated })` under the lock, after moving every bad card file aside. The result of
// `work` gains `set_aside` (a count) and `set_aside_files` (absolute paths, each moved file's old and new path, for the
// caller to commit) only when something was moved. Other results: `invalid_location`, `unreadable_folder`, `lock_busy`.
async function withLock({ deskRoot, personPrefix, lockWaitMs = LOCK_WAIT_MS, lockHooks = {} }, work) {
  const meta = locationFolder(deskRoot, personPrefix)
  if (meta === null) return { result: "invalid_location" }
  const folder = path.join(meta, "improvement")
  if ((await folderState(folder)) === "unreadable") return { result: "unreadable_folder" }
  await fs.mkdir(meta, { recursive: true })
  const lock = path.join(meta, LOCK_NAME)
  const token = randomBytes(8).toString("hex")
  if (!(await acquire(lock, token, lockWaitMs, lockHooks))) return { result: "lock_busy" }
  try {
    const scanned = await scan(deskRoot, personPrefix, MAX_CARD_FILES)
    if (scanned.unreadable) return { result: "unreadable_folder" }
    const files = []
    for (const name of scanned.bad) {
      const target = path.join(folder, SET_ASIDE_FOLDER, `${name}.${randomBytes(3).toString("hex")}`)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.rename(path.join(folder, name), target)
      files.push(path.join(folder, name), target)
    }
    const result = await work({ folder, meta, cards: scanned.cards, truncated: scanned.truncated })
    return files.length === 0 ? result : { ...result, set_aside: files.length / 2, set_aside_files: files }
  } finally {
    await lockHooks.beforeRelease?.(lock)
    await fs.rmdir(path.join(lock, token)).catch(() => {})
    await fs.rmdir(lock).catch(() => {})
  }
}

async function writeCard(card, folder, meta) {
  const file = path.join(folder, cardFileName(card.key))
  const temp = path.join(meta, `.improvement-${process.pid}-${randomBytes(4).toString("hex")}.tmp`)
  try {
    await fs.mkdir(folder, { recursive: true })
    await fs.writeFile(temp, serialize(card), { flag: "wx", mode: 0o600 })
    await fs.rename(temp, file)
  } catch (error) {
    await fs.rm(temp, { force: true })
    throw error
  }
  return file
}

const mergeEvidence = (old, added) => [...old, ...added.filter((pointer) => !old.includes(pointer))].slice(-MAX_EVIDENCE)
const unique = (list) => [...new Set(list)]

/**
 * `openImprovement({ deskRoot, personPrefix, key, source, title?, evidence, plugin, signal, now, lockWaitMs? })
 * -> { result: "opened" | "duplicate" | "reopened", file } | { result: <refusal code> }`.
 * The library builds the title for every source (`cardTitle`) and a caller-supplied `title` is refused. An open card with the key is a `duplicate` (no byte
 * changes); a closed card is `reopened` (recurrences + 1, `last_opened_at` moves, evidence merged, countermeasure, version,
 * `kaizen_url` and check fields cleared). Refusals: `invalid_location`, `invalid_source`, `title_not_allowed`,
 * `invalid_evidence`, `invalid_plugin`, `invalid_signal`, `unreadable_folder`, `too_many_cards` (the card's own file
 * is bad and the folder is too large to have been repaired), `lock_busy`.
 */
export async function openImprovement({ deskRoot, personPrefix, key, source, title, evidence, plugin, signal, now, lockWaitMs, lockHooks }) {
  const at = toDate(now).toISOString()
  const refuse = (result) => ({ result })
  if (locationFolder(deskRoot, personPrefix) === null) return refuse("invalid_location")
  const parts = keyParts(key, true)
  if (parts === null || parts.source !== source) return refuse("invalid_source")
  if (title !== undefined) return refuse("title_not_allowed")
  const fixed = cardTitle(source, parts.id, { plugin, signal })
  const pointers = Array.isArray(evidence) ? unique(evidence) : null
  if (pointers === null || !isEvidence(pointers)) return refuse("invalid_evidence")
  if (!PATCHABLE.plugin[0](plugin)) return refuse("invalid_plugin")
  if (!PATCHABLE.signal[0](signal)) return refuse("invalid_signal")
  return withLock({ deskRoot, personPrefix, lockWaitMs, lockHooks }, async ({ folder, meta }) => {
    const file = path.join(folder, cardFileName(key))
    const found = await inspect(file)
    if (found.kind === "missing") {
      const card = {
        schema: SCHEMA, key, source, title: fixed, evidence: pointers, opened_at: at, last_opened_at: at, state: "open", claim: null, claim_log: [],
        countermeasure: null, plugin, signal, kaizen_url: null, shipped_version: null, checks_run: 0, last_check_at: null, last_check_result: null, verifying_since: null,
        recurrences: 0, reopened: 0, closed_at: null, close_reason: null,
      }
      return { result: "opened", file: await writeCard(card, folder, meta) }
    }
    if (found.card === undefined) return refuse("too_many_cards")
    if (!found.card.state.startsWith("closed_")) return { result: "duplicate", file }
    const card = {
      ...found.card, state: "open", recurrences: found.card.recurrences + 1, last_opened_at: at, evidence: mergeEvidence(found.card.evidence, pointers),
      countermeasure: null, shipped_version: null, kaizen_url: null, checks_run: 0, last_check_at: null, last_check_result: null, verifying_since: null, closed_at: null, close_reason: null,
    }
    return { result: "reopened", file: await writeCard(card, folder, meta) }
  })
}

/**
 * `machineKey(env) -> Promise<string | null>`: this machine's stable, content-free key: 32 hex characters, a fixed hash
 * of the factory's own machine secret (the one behind the friction fingerprint, kept in the protected factory state).
 * Null when the factory state cannot be read; callers never invent a key. Tests get two machines with two state folders.
 */
export async function machineKey(env) {
  try {
    return createHash("sha256").update("desk.improvement.machine\n").update(await readMachineSecret(env)).digest("hex").slice(0, 32)
  } catch {
    return null
  }
}

const utcDay = (stamp) => stamp.slice(0, 10)

/**
 * `claimNext({ env, deskRoot, personPrefix, now, session?, lockWaitMs? })
 * -> { result: "claimed", card, claim_id, file } | { result: "claim_held", key } | { result: "cap_reached" | "none_open" | "too_many_cards" }
 * | { result: "invalid_location" | "machine_key_unavailable" | "invalid_session" | "unreadable_folder" | "lock_busy" }`.
 * The machine key is derived here from `env` by `machineKey(env)` (no caller supplies one); when the factory state cannot give it
 * the answer is `machine_key_unavailable`. Takes the
 * open card with the oldest `last_opened_at` (a claimed card whose claim expired counts as open; a card with another machine's
 * live claim is not offered). One live claim per machine (`MAX_LIVE_CLAIMS`), at most `MAX_CLAIMS_PER_DAY` claims per machine in
 * the UTC day (counted from the cards' own `claim_log`), a `CLAIM_TTL_HOURS` expiry. It reads up to `MAX_CARD_FILES` card files
 * and answers `too_many_cards`, never `none_open` or a claim, when the folder holds more.
 */
export async function claimNext({ env, deskRoot, personPrefix, now, session, lockWaitMs, lockHooks }) {
  const date = toDate(now)
  const machine = await machineKey(env)
  if (machine === null) return { result: "machine_key_unavailable" }
  if (session !== undefined && session !== null && !PATTERNS.sessionId.test(String(session))) return { result: "invalid_session" }
  return withLock({ deskRoot, personPrefix, lockWaitMs, lockHooks }, async ({ folder, meta, cards, truncated }) => {
    if (truncated) return { result: "too_many_cards" }
    const live = cards.filter((card) => isClaimLive(card, date) && card.claim.machine === machine)
    if (live.length >= MAX_LIVE_CLAIMS) return { result: "claim_held", key: live[0].key }
    const candidates = cards.filter((card) => card.state === "open" || (card.state === "claimed" && !isClaimLive(card, date)))
      .sort((a, b) => a.last_opened_at.localeCompare(b.last_opened_at) || a.key.localeCompare(b.key))
    if (candidates.length === 0) return { result: "none_open" }
    const today = cards.reduce((sum, card) => sum + card.claim_log.filter((entry) => entry.machine === machine && utcDay(entry.at) === utcDay(date.toISOString())).length, 0)
    if (today >= MAX_CLAIMS_PER_DAY) return { result: "cap_reached" }
    const claim = {
      claim_id: randomUUID(), claimed_at: date.toISOString(), expires_at: new Date(date.getTime() + CLAIM_TTL_HOURS * HOUR_MS).toISOString(), machine, session: session ?? null,
    }
    const card = { ...candidates[0], state: "claimed", claim, claim_log: [...candidates[0].claim_log, { at: claim.claimed_at, machine }].slice(-MAX_CLAIM_LOG) }
    return { result: "claimed", card, claim_id: claim.claim_id, file: await writeCard(card, folder, meta) }
  })
}

// What `updateCard` may do. `claimed` is made only by `claimNext` (it enforces the caps) and a closed
// card reopens only through `openImprovement` (it counts the recurrence).
const updateMoves = (from) => MOVES[from].filter((to) => to !== "claimed" && !from.startsWith("closed_"))

function checkPatch(patch, old) {
  if (patch === null || typeof patch !== "object" || Array.isArray(patch) || Object.keys(patch).length === 0) return { result: "invalid_patch", field: "patch" }
  for (const field of Object.keys(patch)) {
    if (IMMUTABLE.includes(field)) return { result: "immutable_field", field }
    if (!Object.hasOwn(PATCHABLE, field)) return { result: "unknown_field", field }
    const [check, code = "invalid_patch"] = PATCHABLE[field]
    if (!check(patch[field])) return code === "invalid_patch" ? { result: code, field } : { result: code }
  }
  const state = patch.state ?? old.state
  if (patch.checks_run !== undefined && (patch.checks_run !== old.checks_run + 1 || (state !== "shipped" && state !== "verifying"))) return { result: "invalid_patch", field: "checks_run" }
  return null
}

/**
 * `updateCard({ deskRoot, personPrefix, key, claim_id, patch, now, lockWaitMs? })
 * -> { result: "updated", file, card } | { result: <refusal code>, ... }`.
 * `patch` (not empty) may set `state`, `evidence` (replaces; de-duplicated; at most 10), `countermeasure`, `kaizen_url`, `plugin`,
 * `signal`, `shipped_version`, `checks_run` (only to the old value + 1, and only on a `shipped` or `verifying` card), `last_check_at`, `last_check_result` (from `CHECK_RESULTS`)
 * and `close_reason` (from `CLOSE_REASONS`, only on a closed card). `reopened` and `recurrences` cannot be patched. A card with no live
 * claim accepts system patches without a `claim_id`; a claimed card needs its own `claim_id` while the claim is live and refuses a wrong
 * one always. A move out of `claimed` ends the claim (`expires_at` null); a move to a closed state stamps `closed_at`; a move from
 * `shipped` or `verifying` to `open` adds 1 to `reopened` and clears `countermeasure`, `shipped_version`, `checks_run`, `last_check_at`
 * and `last_check_result`. Refusals: `invalid_location`, `invalid_source`, `unreadable_folder`, `lock_busy`, `not_found`, `too_many_cards`
 * (the card's own file is bad and the folder is too large to have been repaired), `not_your_claim`, `immutable_field` (+ `field`),
 * `unknown_field` (+ `field`), `invalid_countermeasure`, `invalid_kaizen_url`, `invalid_patch` (+ `field`), `invalid_move` (+ `allowed`),
 * `missing_countermeasure`, `missing_version`, `missing_close_reason`.
 */
export async function updateCard({ deskRoot, personPrefix, key, claim_id: claimId, patch, now, lockWaitMs, lockHooks }) {
  const date = toDate(now)
  if (locationFolder(deskRoot, personPrefix) === null) return { result: "invalid_location" }
  if (keyParts(key) === null) return { result: "invalid_source" }
  return withLock({ deskRoot, personPrefix, lockWaitMs, lockHooks }, async ({ folder, meta }) => {
    const found = await inspect(path.join(folder, cardFileName(key)))
    if (found.kind === "missing") return { result: "not_found" }
    if (found.card === undefined || found.card.key !== key) return { result: "too_many_cards" }
    const old = found.card
    if (claimId !== undefined && (old.state !== "claimed" || claimId !== old.claim.claim_id)) return { result: "not_your_claim" }
    if (old.state === "claimed" && claimId === undefined && isClaimLive(old, date)) return { result: "not_your_claim" }
    const refused = checkPatch(patch, old)
    if (refused !== null) return refused
    const card = { ...old, ...patch }
    if (patch.evidence !== undefined) card.evidence = unique(patch.evidence)
    if (card.state !== old.state) {
      const allowed = updateMoves(old.state)
      if (!allowed.includes(card.state)) return { result: "invalid_move", allowed }
      if (old.state === "claimed") card.claim = { ...old.claim, expires_at: null }
      if (card.state.startsWith("closed_")) card.closed_at = date.toISOString()
      if (card.state === "open" && old.state !== "claimed") {
        Object.assign(card, { reopened: old.reopened + 1, countermeasure: null, shipped_version: null, checks_run: 0, last_check_at: null, last_check_result: null, verifying_since: null })
      }
      // The time a card entered verification is the library's to stamp, and its checks start again from zero.
      if (card.state === "verifying" && old.state !== "verifying") Object.assign(card, { verifying_since: date.toISOString(), checks_run: 0 })
    }
    if ((card.state === "shipped" || card.state === "verifying") && card.countermeasure === null) return { result: "missing_countermeasure" }
    if (card.state === "verifying" && card.shipped_version === null) return { result: "missing_version" }
    const closed = card.state.startsWith("closed_")
    if (closed && card.close_reason === null) return { result: "missing_close_reason" }
    if (!closed && card.close_reason !== null) return { result: "invalid_patch", field: "close_reason" }
    return { result: "updated", file: await writeCard(card, folder, meta), card }
  })
}
