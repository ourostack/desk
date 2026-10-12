// The shared launch ledger: one crash-safe count of the headless agent launches this machine starts on its own, waste
// evaluation and improvement triage together, inside the existing ceiling of `MAX_HEADLESS_JOBS_PER_DAY` (30) a UTC day.
//
// Quota. Each UTC day has four six-hour windows. Each window holds one triage opportunity that evaluation cannot take
// while the window is unused and has not ended: an evaluation is allowed only while `spent + 1 <= 30 - protected`,
// where `protected` counts the unused windows that end later than now. Triage needs an unused current window, six hours
// since its last actual launch (`last_triage_at`, kept across days) and `spent < 30`, and uses that window. An unused
// window returns to evaluation only when it ends. There is no separate triage allowance. A triage qualification reserves
// its two model sessions as one triage opportunity (`launches: 2`), which needs `spent + 2 <= 30`.
//
// Three witnesses, each persisted on its own:
//
//   - `agent-launch-ledger.json`, the full record (`desk.factory.agent-launch-ledger/1`);
//   - `agent-launch-guard.json`, its launch fields and the ledger's SHA-256 (`desk.factory.agent-launch-guard/1`);
//   - `status.json` `loop.agent_launch_highwater`, the high-water mark (`desk.factory.agent-launch-highwater/1`),
//     written and read back through the protected status file.
//
// Every change (a reservation, an outcome, a continuation token issued or consumed, a migration or a recovery) is one
// transaction under the ledger lock: the high-water mark is written as `pending` with the target's maxima and hash and
// read back, then the guard and then the ledger are renamed into place, fsynced and read back, then the mark becomes
// `acknowledged`. Before a launch is allowed, all three are read again and must agree. A crash leaves a state the next
// call recognizes from the table below; no branch refunds a launch or reissues a consumed token.
//
//   pending mark, pair at the last acknowledged revision (guard maybe ahead)   seal the witnessed day as spent (30)
//                                                                                or, on a strictly later UTC day, start
//                                                                                that day with old tokens cancelled
//   pending mark, guard and ledger both at the target                           mark acknowledged, then go on
//   acknowledged mark that matches the pair                                     normal
//   missing or damaged mark beside a ledger and guard that agree                write all three again from the pair, the
//                                                                                reset's UTC day sealed as spent (30)
//   pair older than the mark, pair newer than the mark, another epoch, a
//   ledger and guard that disagree, a clock earlier than the mark, a missing
//   or damaged mark beside a missing or damaged pair file, a status file set
//   aside today                                                                 launch nothing (no regeneration)
//
// Limit: the checks detect a restored ledger and guard while the status mark survives, and a restored status while a
// newer pair survives. Restoring all three witnesses together (with the evaluator's attempt state) is outside what
// this machine can detect without an outside authority, and v1.2 does not claim it.
//
// Migration. With none of the three present, the first transaction starts the ledger from the evaluator's own day
// count (`status.evaluator.headless`): today's runs count as spent, an earlier day as none, and a later day blocks.
// A missing or damaged legacy record starts today as spent (30) unless `status.json` itself does not exist yet and was
// never set aside, the one case where nothing on this machine can have launched.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { createHash, randomBytes } from "node:crypto"
import { promises as fsp } from "node:fs"
import * as path from "node:path"

import { MAX_HEADLESS_JOBS_PER_DAY } from "./headless.js"
import { listStatusAside, statusResetDay } from "./loop-worker-state.js"
import { lstatIfPresent, protectLeafFile } from "./os-protect.js"
import { factoryStateRoot, readStatus, updateStatus, withNamedLock } from "./outbox.js"

export const LEDGER_FILE = "agent-launch-ledger.json"
export const GUARD_FILE = "agent-launch-guard.json"
const LEDGER_LOCK = "agent-launch-ledger"
const LEDGER_SCHEMA = "desk.factory.agent-launch-ledger/1"
const GUARD_SCHEMA = "desk.factory.agent-launch-guard/1"
const WITNESS_SCHEMA = "desk.factory.agent-launch-highwater/1"
const DAILY_LAUNCHES = MAX_HEADLESS_JOBS_PER_DAY
const WINDOW_MS = 6 * 60 * 60 * 1000
const WINDOWS_PER_DAY = 4
const TRIAGE_GAP_MS = 6 * 60 * 60 * 1000
/** How far the clock may read behind the witnessed clock without blocking: the ledger then keeps using the witnessed clock, never an earlier one. */
const CLOCK_SKEW_MS = 5 * 60 * 1000
/** Where a test can stop a transaction (`createHeadlessLedger({ fault })`), in the order a transaction passes them. */
export const FAULT_POINTS = Object.freeze([
  "before_witness_pending",
  "after_witness_pending",
  "guard_temp_written",
  "guard_renamed",
  "guard_synced",
  "ledger_temp_written",
  "ledger_renamed",
  "ledger_synced",
  "before_witness_acknowledged",
  "after_witness_acknowledged",
])

const KINDS = new Set(["evaluate", "triage"])
const OUTCOMES = new Set(["ran", "failed", "not_started"])
const NAMING = { label: "desk_factory", subject: "factory launch ledger" }
const DAY_TEXT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/u
const EPOCH = /^[0-9a-f]{32}$/u
const SHA = /^[0-9a-f]{64}$/u
const GENERATION = /^[A-Za-z0-9._:-]{1,128}$/u
const RENAME_BUSY_MS = 2000
const RENAME_RETRY_MS = 25
const LEDGER_KEYS = ["schema", "epoch", "revision", "day", "last_clock_ms", "spent", "evaluate", "triage", "windows", "last_triage_at", "issued_serial", "consumed_through", "continuations"]
const GUARD_KEYS = ["schema", "epoch", "revision", "day", "last_clock_ms", "spent", "windows", "last_triage_at", "issued_serial", "consumed_through", "ledger_sha256"]
const WITNESS_KEYS = ["schema", "epoch", "max_revision", "max_acknowledged_revision", "max_day", "spent_at_max_day", "max_clock_ms", "windows", "last_triage_at", "max_issued_serial", "consumed_through", "target_sha256", "phase"]
const KIND_KEYS = ["launched", "ran", "failed", "not_started", "finished_revision"]
const TOKEN_KEYS = ["epoch", "serial", "generation", "expected_evaluation"]
const BASIS_KEYS = ["last_ran_at", "last_result", "ready_now", "ready_later", "headless_day", "accepted_last_step"]

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const hasExactly = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
const isDay = (value) => typeof value === "string" && DAY_TEXT.test(value) && new Date(Date.parse(`${value}T00:00:00.000Z`) || 0).toISOString().startsWith(value)
const isInstant = (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value
const isWindows = (value) => Array.isArray(value) && value.length === WINDOWS_PER_DAY && value.every((used) => used === 0 || used === 1)
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex")
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10)
const dayStart = (day) => Date.parse(`${day}T00:00:00.000Z`)
const windowOf = (ms) => Math.floor((ms - dayStart(dayOf(ms))) / WINDOW_MS)
const encode = (value) => `${JSON.stringify(value)}\n`
const sum = (values) => values.reduce((total, value) => total + value, 0)
const instantMs = (value) => Date.parse(value)

// A stable text form, keys sorted, so two readings of the same value compare equal whatever order a writer used.
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (isObject(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
  return JSON.stringify(value)
}
const same = (left, right) => canonical(left) === canonical(right)

function toMs(value, name) {
  const ms = value instanceof Date || typeof value === "string" || typeof value === "number" ? new Date(value).getTime() : Number.NaN
  if (Number.isNaN(ms)) throw new TypeError(`${name}: must be a valid time`)
  return ms
}

function requireGeneration(value) {
  if (value !== null && value !== undefined && (typeof value !== "string" || !GENERATION.test(value))) throw new TypeError("generation: must be a short code or null")
  return value ?? null
}

// ---------------------------------------------------------------------------
// Shapes. Each validator answers whether the value is exactly the documented shape with sound numbers.
// ---------------------------------------------------------------------------

function validKind(value) {
  return hasExactly(value, KIND_KEYS) && KIND_KEYS.every((key) => isCount(value[key])) && value.ran + value.failed + value.not_started <= value.launched
}

function validToken(value, epoch, consumedThrough, issuedSerial) {
  return hasExactly(value, TOKEN_KEYS) && value.epoch === epoch && Number.isSafeInteger(value.serial) && value.serial > consumedThrough && value.serial <= issuedSerial && typeof value.generation === "string" && GENERATION.test(value.generation) && typeof value.expected_evaluation === "string" && SHA.test(value.expected_evaluation)
}

// The launch fields the ledger, the guard and the mark share.
function validLaunchFields(value) {
  return EPOCH.test(value.epoch) && isDay(value.day) && isCount(value.last_clock_ms) && dayOf(value.last_clock_ms) <= value.day && isCount(value.spent) && value.spent <= DAILY_LAUNCHES && isWindows(value.windows) && sum(value.windows) <= value.spent && (value.last_triage_at === null || (isInstant(value.last_triage_at) && instantMs(value.last_triage_at) <= value.last_clock_ms)) && isCount(value.issued_serial) && isCount(value.consumed_through) && value.consumed_through <= value.issued_serial
}

export function validLedger(value) {
  return hasExactly(value, LEDGER_KEYS) && value.schema === LEDGER_SCHEMA && Number.isSafeInteger(value.revision) && value.revision >= 1 && validLaunchFields(value) && validKind(value.evaluate) && validKind(value.triage) && value.evaluate.launched + value.triage.launched <= value.spent && Array.isArray(value.continuations) && value.continuations.length <= 1 && value.continuations.every((token) => validToken(token, value.epoch, value.consumed_through, value.issued_serial))
}

export function validGuard(value) {
  return hasExactly(value, GUARD_KEYS) && value.schema === GUARD_SCHEMA && Number.isSafeInteger(value.revision) && value.revision >= 1 && validLaunchFields(value) && typeof value.ledger_sha256 === "string" && SHA.test(value.ledger_sha256)
}

export function validWitness(value) {
  if (!hasExactly(value, WITNESS_KEYS) || value.schema !== WITNESS_SCHEMA || !EPOCH.test(value.epoch)) return false
  if (!Number.isSafeInteger(value.max_revision) || value.max_revision < 1 || !isCount(value.max_acknowledged_revision) || value.max_acknowledged_revision > value.max_revision) return false
  if (value.phase === "acknowledged" ? value.max_acknowledged_revision !== value.max_revision : value.phase !== "pending" || value.max_acknowledged_revision === value.max_revision) return false
  const fields = { epoch: value.epoch, day: value.max_day, last_clock_ms: value.max_clock_ms, spent: value.spent_at_max_day, windows: value.windows, last_triage_at: value.last_triage_at, issued_serial: value.max_issued_serial, consumed_through: value.consumed_through }
  return validLaunchFields(fields) && typeof value.target_sha256 === "string" && SHA.test(value.target_sha256)
}

// ---------------------------------------------------------------------------
// Building records.
// ---------------------------------------------------------------------------

const emptyKind = (finishedRevision = 0) => ({ launched: 0, ran: 0, failed: 0, not_started: 0, finished_revision: finishedRevision })

function ledgerRecord(fields) {
  return Object.fromEntries(LEDGER_KEYS.map((key) => [key, key === "schema" ? LEDGER_SCHEMA : fields[key]]))
}

function guardFor(ledger, ledgerSha) {
  return Object.fromEntries(GUARD_KEYS.map((key) => [key, key === "schema" ? GUARD_SCHEMA : key === "ledger_sha256" ? ledgerSha : ledger[key]]))
}

function witnessFor(ledger, ledgerSha, acknowledgedRevision, phase) {
  return {
    schema: WITNESS_SCHEMA,
    epoch: ledger.epoch,
    max_revision: ledger.revision,
    max_acknowledged_revision: acknowledgedRevision,
    max_day: ledger.day,
    spent_at_max_day: ledger.spent,
    max_clock_ms: ledger.last_clock_ms,
    windows: [...ledger.windows],
    last_triage_at: ledger.last_triage_at,
    max_issued_serial: ledger.issued_serial,
    consumed_through: ledger.consumed_through,
    target_sha256: ledgerSha,
    phase,
  }
}

// The launch fields of `pair` agree with `ledger` (a guard, or a mark read as launch fields).
function guardAgrees(guard, ledger) {
  return ["epoch", "revision", "day", "last_clock_ms", "spent", "last_triage_at", "issued_serial", "consumed_through"].every((key) => guard[key] === ledger[key]) && same(guard.windows, ledger.windows)
}

function witnessAgrees(witness, ledger) {
  return witness.epoch === ledger.epoch && witness.max_day === ledger.day && witness.spent_at_max_day === ledger.spent && witness.max_clock_ms === ledger.last_clock_ms && same(witness.windows, ledger.windows) && witness.last_triage_at === ledger.last_triage_at && witness.max_issued_serial === ledger.issued_serial && witness.consumed_through === ledger.consumed_through
}

// A guard written ahead of its ledger by a transaction that did not finish: within what the pending mark already witnessed.
function guardWithin(guard, witness) {
  return guard.revision <= witness.max_revision && guard.day <= witness.max_day && guard.last_clock_ms <= witness.max_clock_ms && guard.issued_serial <= witness.max_issued_serial && guard.consumed_through <= witness.consumed_through && (guard.last_triage_at === null || (witness.last_triage_at !== null && instantMs(guard.last_triage_at) <= instantMs(witness.last_triage_at))) && (guard.day < witness.max_day || (guard.spent <= witness.spent_at_max_day && guard.windows.every((used, index) => used <= witness.windows[index])))
}

// The ledger as of `nowMs`: a later UTC day starts its count, windows and per-kind counts again.
function rollover(ledger, nowMs) {
  const today = dayOf(nowMs)
  if (today <= ledger.day) return ledger
  return { ...ledger, day: today, spent: 0, windows: [0, 0, 0, 0], evaluate: emptyKind(ledger.evaluate.finished_revision), triage: emptyKind(ledger.triage.finished_revision) }
}

function protectedWindows(ledger, nowMs) {
  return ledger.windows.filter((used, index) => used === 0 && dayStart(ledger.day) + (index + 1) * WINDOW_MS > nowMs).length
}

/**
 * `quotaFor(ledger, kind, nowMs) -> { state, remaining }`: whether one more launch of `kind` fits in `ledger` (already rolled to `nowMs`'s day).
 * `state` is `ok`, `quota_exhausted`, `window_protected` (evaluation only), `window_used` or `triage_cooldown` (triage only).
 */
export function quotaFor(ledger, kind, nowMs, launches = 1) {
  if (kind === "evaluate") {
    const ceiling = DAILY_LAUNCHES - protectedWindows(ledger, nowMs)
    if (ledger.spent >= DAILY_LAUNCHES) return { state: "quota_exhausted", remaining: 0 }
    if (ledger.spent + 1 > ceiling) return { state: "window_protected", remaining: 0 }
    return { state: "ok", remaining: ceiling - ledger.spent - 1 }
  }
  if (ledger.spent + launches > DAILY_LAUNCHES) return { state: "quota_exhausted", remaining: 0 }
  if (ledger.windows[windowOf(nowMs)] !== 0) return { state: "window_used", remaining: 0 }
  if (ledger.last_triage_at !== null && nowMs - instantMs(ledger.last_triage_at) < TRIAGE_GAP_MS) return { state: "triage_cooldown", remaining: 0 }
  return { state: "ok", remaining: DAILY_LAUNCHES - ledger.spent - launches }
}

/**
 * `witnessedEvaluationQuota(status, now) -> state`: what the high-water mark in `status` (`status.loop.agent_launch_highwater`) says about one
 * more evaluation at `now`, without the ledger lock: `ok`, `unwitnessed` (no mark yet: the reservation migrates or refuses), `witness_invalid`,
 * `clock_regressed` (a mark dated after `now`), `quota_exhausted` or `window_protected`. Only a reservation is authoritative.
 */
export function witnessedEvaluationQuota(status, now) {
  const witness = isObject(status?.loop) ? status.loop.agent_launch_highwater : undefined
  if (witness === undefined) return "unwitnessed"
  const nowMs = toMs(now, "now")
  if (!validWitness(witness)) return "witness_invalid"
  if (witness.max_clock_ms > nowMs + CLOCK_SKEW_MS || witness.max_day > dayOf(nowMs + CLOCK_SKEW_MS)) return "clock_regressed"
  const effective = Math.max(nowMs, witness.max_clock_ms)
  const ledger = rollover({ day: witness.max_day, spent: witness.spent_at_max_day, windows: witness.windows, evaluate: emptyKind(), triage: emptyKind() }, effective)
  return quotaFor(ledger, "evaluate", effective).state
}

/**
 * `evaluationQuotaOpen(status, now) -> boolean`: whether `witnessedEvaluationQuota` leaves room for one more evaluation: false only for
 * `quota_exhausted`, `window_protected` and `clock_regressed`. A missing or damaged mark is left to the reservation, which writes it again
 * from a surviving ledger and guard (sealing that day) or blocks.
 */
export function evaluationQuotaOpen(status, now) {
  return !["quota_exhausted", "window_protected", "clock_regressed"].includes(witnessedEvaluationQuota(status, now))
}

/**
 * `evaluationContinuationBasis(status) -> object`: what an evaluation continuation is minted against and consumed against: the evaluator
 * step's last run and result, its ready counts, the day of its counts and its last accepted count. A continuation whose basis changed (a
 * genuine run, failure or newly attempted job since) is refused.
 */
export function evaluationContinuationBasis(status) {
  const evaluator = isObject(status?.evaluator) ? status.evaluator : {}
  const record = isObject(status?.loop?.steps?.evaluate) ? status.loop.steps.evaluate : {}
  const headless = isObject(evaluator.headless) ? evaluator.headless : {}
  const count = (value) => (isCount(value) ? value : 0)
  return {
    last_ran_at: typeof record.last_ran_at === "string" ? record.last_ran_at : null,
    last_result: typeof record.last_result === "string" ? record.last_result : null,
    ready_now: count(evaluator.ready_now),
    ready_later: count(evaluator.ready_later),
    headless_day: typeof headless.day === "string" ? headless.day : null,
    accepted_last_step: count(evaluator.accepted_last_step),
  }
}

function validBasis(value) {
  return hasExactly(value, BASIS_KEYS) && (value.last_ran_at === null || typeof value.last_ran_at === "string") && (value.last_result === null || typeof value.last_result === "string") && isCount(value.ready_now) && isCount(value.ready_later) && (value.headless_day === null || typeof value.headless_day === "string") && isCount(value.accepted_last_step)
}

// ---------------------------------------------------------------------------
// Files.
// ---------------------------------------------------------------------------

async function renameRetry(io, from, to) {
  const deadline = Date.now() + RENAME_BUSY_MS
  while (true) {
    try {
      return await io.rename(from, to)
    } catch (error) {
      // Windows refuses a rename over a file another process has open for a moment; anything else, or a wait that runs out, fails.
      if (io.platform !== "win32" || !["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_MS))
    }
  }
}

// Flushes the folder entry of a rename. Windows cannot open a folder for flushing; its rename is already durable through NTFS's journal.
async function syncFolder(io, dir) {
  if (io.platform === "win32") return
  const handle = await fsp.open(dir, "r")
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeAtomic(io, root, name, bytes, label) {
  const file = path.join(root, name)
  const tmp = path.join(root, `.tmp-${name}-${process.pid}-${randomBytes(4).toString("hex")}`)
  const handle = await fsp.open(tmp, "wx", 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await io.fault(`${label}_temp_written`)
  try {
    await renameRetry(io, tmp, file)
  } catch (error) {
    await fsp.rm(tmp, { force: true })
    throw error
  }
  await io.fault(`${label}_renamed`)
  await syncFolder(io, root)
  await io.fault(`${label}_synced`)
  await protectLeafFile(file, io.platform, NAMING)
  if ((await fsp.readFile(file, "utf8")) !== bytes) throw new Error(`${label}_readback_mismatch`)
}

// One of the two files: `missing`, `invalid` (unreadable, not the shape, a symlink or hard link) or `ok` with its value, bytes and hash.
async function readRecord(io, root, name, valid) {
  const file = path.join(root, name)
  try {
    if ((await lstatIfPresent(file, NAMING)) === null) return { state: "missing" }
    await protectLeafFile(file, io.platform, NAMING)
    const bytes = await fsp.readFile(file, "utf8")
    const value = JSON.parse(bytes)
    return valid(value) ? { state: "ok", value, sha: sha256(bytes) } : { state: "invalid" }
  } catch {
    return { state: "invalid" }
  }
}

// ---------------------------------------------------------------------------
// Reading the three witnesses and deciding what they allow.
// ---------------------------------------------------------------------------

async function readAll(io, env, root) {
  const status = await io.readStatus(env)
  const loop = isObject(status.loop) ? status.loop : {}
  const raw = loop.agent_launch_highwater
  return {
    status,
    witness: raw === undefined ? { state: "missing" } : validWitness(raw) ? { state: "ok", value: raw } : { state: "invalid", raw },
    ledger: await readRecord(io, root, LEDGER_FILE, validLedger),
    guard: await readRecord(io, root, GUARD_FILE, validGuard),
  }
}

const block = (state) => ({ kind: "block", state })

/**
 * Classifies what the three witnesses allow at `nowMs`: `migrate` (none exists), `ok` (they agree), `acknowledge` (a transaction reached its
 * ledger and only the mark's acknowledgement is missing), `recover` (a transaction stopped before its ledger) or `block` with a state code.
 */
function assess({ witness, ledger, guard }, nowMs) {
  // A missing or damaged mark beside a ledger or guard was handled by `resealFromPair` before this.
  if (witness.state === "missing") return { kind: "migrate" }
  if (witness.state === "invalid") return block("witness_invalid")
  const mark = witness.value
  if (ledger.state === "invalid" || guard.state === "invalid") return block("ledger_unreadable")
  const L = ledger.value
  const G = guard.value
  if ((L !== undefined && L.epoch !== mark.epoch) || (G !== undefined && G.epoch !== mark.epoch)) return block("epoch_mismatch")
  if ((L !== undefined && L.revision > mark.max_revision) || (G !== undefined && G.revision > mark.max_revision)) return block("status_rollback")
  const floor = nowMs + CLOCK_SKEW_MS
  if (floor < mark.max_clock_ms || mark.max_day > dayOf(floor) || (L !== undefined && floor < L.last_clock_ms) || (G !== undefined && floor < G.last_clock_ms)) return block("clock_regressed")
  if (mark.max_acknowledged_revision > 0 && (L === undefined || G === undefined)) return block("ledger_missing")
  if (L !== undefined && L.revision < mark.max_acknowledged_revision) return block("rollback_detected")
  const pairMatches = L !== undefined && G !== undefined && G.revision === L.revision && G.ledger_sha256 === ledger.sha && guardAgrees(G, L)
  const atTarget = pairMatches && L.revision === mark.max_revision && ledger.sha === mark.target_sha256 && witnessAgrees(mark, L)
  if (mark.phase === "acknowledged") return atTarget ? { kind: "ok", ledger: L } : block(G !== undefined && G.revision < mark.max_acknowledged_revision ? "rollback_detected" : "inconsistent")
  if (atTarget) return { kind: "acknowledge", ledger: L }
  // The pending transaction stopped before its ledger: the ledger is the last acknowledged one (or none before the first), the guard the same
  // or ahead within what the mark witnessed.
  const priorLedger = L === undefined ? mark.max_acknowledged_revision === 0 : L.revision === mark.max_acknowledged_revision
  const guardSound = G === undefined || pairMatches || (G.revision > (L?.revision ?? 0) && guardWithin(G, mark))
  return priorLedger && guardSound ? { kind: "recover", ledger: L ?? null } : block("inconsistent")
}

// The state a recovery writes: the mark's maxima, with the witnessed day sealed as spent, or on a strictly later UTC day a fresh day with
// every older token burned. Never a refund, never a lower clock.
function recoveredLedger(mark, prior, readMs) {
  const nowMs = Math.max(mark.max_clock_ms, readMs)
  const base = {
    epoch: mark.epoch,
    revision: mark.max_revision + 1,
    last_clock_ms: nowMs,
    last_triage_at: mark.last_triage_at,
    issued_serial: mark.max_issued_serial,
    consumed_through: mark.max_issued_serial,
    continuations: [],
  }
  const evaluate = prior !== null && prior.day === mark.max_day ? prior.evaluate : emptyKind(prior?.evaluate.finished_revision ?? 0)
  const triage = prior !== null && prior.day === mark.max_day ? prior.triage : emptyKind(prior?.triage.finished_revision ?? 0)
  if (dayOf(nowMs) > mark.max_day) return ledgerRecord({ ...base, day: dayOf(nowMs), spent: 0, windows: [0, 0, 0, 0], evaluate: emptyKind(evaluate.finished_revision), triage: emptyKind(triage.finished_revision) })
  return ledgerRecord({ ...base, day: mark.max_day, spent: DAILY_LAUNCHES, windows: [...mark.windows], evaluate, triage })
}

function legacySpent(legacyEvaluator, today) {
  if (legacyEvaluator === undefined || legacyEvaluator === null) return { state: "absent" }
  if (!isObject(legacyEvaluator)) return { state: "damaged" }
  const headless = legacyEvaluator.headless
  if (headless === undefined) return { state: "absent" }
  if (!isObject(headless) || !isDay(headless.day)) return { state: "damaged" }
  if (headless.day > today) return { state: "future" }
  // A record of an earlier day says nothing ran today, whatever its counts; today's needs a sound count.
  if (headless.day < today) return { state: "valid", spent: 0 }
  return isCount(headless.jobs) ? { state: "valid", spent: Math.min(headless.jobs, DAILY_LAUNCHES) } : { state: "damaged" }
}

// A status file reset or edited after the ledger exists loses the high-water mark. The surviving pair, when it agrees, is the greatest evidence left: all
// three witnesses are written again from it, with the day of the reset sealed as spent (30) and every older token burned. When the reset
// happened on an earlier UTC day than today (the set-aside file's day), that day is already over and today starts normally; a mark that is
// simply gone, with no set-aside file of its own, seals today. Nothing is refunded: the reset costs the rest of its day. Answers null
// when this is not that case, `{ state }` when the day is sealed or the pair cannot be trusted, or `{ ledger }` to go on.
async function resealFromPair(io, env, root, { witness, ledger, guard }, nowMs) {
  if (witness.state === "ok" || (ledger.state === "missing" && guard.state === "missing")) return null
  if (ledger.state !== "ok" || guard.state !== "ok") return { state: ledger.state === "missing" || guard.state === "missing" ? witness.state === "missing" ? "witness_missing" : "witness_invalid" : "ledger_unreadable" }
  const L = ledger.value
  const G = guard.value
  if (L.epoch !== G.epoch) return { state: "epoch_mismatch" }
  // Only a pair that agrees (as `assess` requires) is trusted as the high-water: one file restored or left mid-transaction blocks.
  if (G.revision !== L.revision || G.ledger_sha256 !== ledger.sha || !guardAgrees(G, L)) return { state: "inconsistent" }
  if (nowMs + CLOCK_SKEW_MS < L.last_clock_ms) return { state: "clock_regressed" }
  const effective = Math.max(nowMs, L.last_clock_ms)
  const today = dayOf(effective)
  const resetDay = statusResetDay(root)
  const sealedDay = resetDay !== null && resetDay >= L.day && resetDay < today ? resetDay : today
  const issued = L.issued_serial
  const target = ledgerRecord({
    epoch: L.epoch,
    revision: L.revision + 1,
    day: today,
    last_clock_ms: effective,
    spent: sealedDay === today ? DAILY_LAUNCHES : 0,
    evaluate: emptyKind(L.evaluate.finished_revision),
    triage: emptyKind(L.triage.finished_revision),
    windows: [0, 0, 0, 0],
    last_triage_at: L.last_triage_at,
    issued_serial: issued,
    consumed_through: issued,
    continuations: [],
  })
  const mark = await commit(io, env, root, target, witness.state === "missing" ? null : witness.raw, target.revision - 1)
  return sealedDay === today ? { state: "witness_reset_sealed" } : { ledger: target, mark }
}

// ---------------------------------------------------------------------------
// The transaction.
// ---------------------------------------------------------------------------

async function writeWitness(io, env, expected, next) {
  await io.updateStatus(env, (current) => {
    const loop = isObject(current.loop) ? current.loop : {}
    if (!same(loop.agent_launch_highwater ?? null, expected)) throw new Error("witness_changed")
    return { ...current, loop: { ...loop, agent_launch_highwater: next } }
  })
  const readBack = await io.readStatus(env)
  if (!same(isObject(readBack.loop) ? readBack.loop.agent_launch_highwater ?? null : null, next)) throw new Error("witness_readback_mismatch")
}

// Writes `target` through all three witnesses and answers the acknowledged mark it wrote. `previous` is the mark the caller settled on
// (null before the first): the status write compares against it, so a writer that got in after a broken lock fails this one rather than
// being overwritten. Throws on any failure: the caller launches nothing, and the next call reads whatever the disk holds.
async function commit(io, env, root, target, previous, acknowledged = previous?.max_acknowledged_revision ?? 0) {
  const bytes = encode(target)
  const ledgerSha = sha256(bytes)
  const pending = witnessFor(target, ledgerSha, acknowledged, "pending")
  await io.fault("before_witness_pending")
  await writeWitness(io, env, previous, pending)
  await io.fault("after_witness_pending")
  await writeAtomic(io, root, GUARD_FILE, encode(guardFor(target, ledgerSha)), "guard")
  await writeAtomic(io, root, LEDGER_FILE, bytes, "ledger")
  await io.fault("before_witness_acknowledged")
  const acknowledgedMark = { ...pending, max_acknowledged_revision: target.revision, phase: "acknowledged" }
  await writeWitness(io, env, pending, acknowledgedMark)
  await io.fault("after_witness_acknowledged")
  return acknowledgedMark
}

// Brings the three witnesses to an agreed state under the lock: migrates, acknowledges or recovers as `assess` says. Answers
// `{ ledger, mark }` (the agreed ledger and the mark settled on) or `{ state }` when nothing may launch.
async function settle(io, env, root, { nowMs, legacyEvaluator }) {
  // Read first: the status reader itself sets a damaged file aside, and that is the reset this checks for.
  const read = await readAll(io, env, root)
  const resealed = await resealFromPair(io, env, root, read, nowMs)
  if (resealed !== null) return resealed
  if ((statusResetDay(root) ?? "") >= dayOf(nowMs)) return { state: "status_reset" }
  const verdict = assess(read, nowMs)
  if (verdict.kind === "block") return { state: verdict.state }
  const mark = read.witness.value
  if (verdict.kind === "ok") return { ledger: verdict.ledger, mark }
  if (verdict.kind === "acknowledge") {
    const acknowledged = { ...mark, max_acknowledged_revision: mark.max_revision, phase: "acknowledged" }
    await writeWitness(io, env, mark, acknowledged)
    return { ledger: verdict.ledger, mark: acknowledged }
  }
  if (verdict.kind === "recover") {
    const target = recoveredLedger(mark, verdict.ledger, nowMs)
    return { ledger: target, mark: await commit(io, env, root, target, mark) }
  }
  const today = dayOf(nowMs)
  const legacy = legacySpent(legacyEvaluator, today)
  if (legacy.state === "future") return { state: "legacy_future_dated" }
  // Without a sound legacy count only a status file that does not exist at all, and was never set aside, shows a machine that never launched.
  const fresh = legacy.state === "absent" && listStatusAside(root).length === 0 && (await lstatIfPresent(path.join(root, "status.json"), NAMING)) === null
  const spent = legacy.state === "valid" ? legacy.spent : fresh ? 0 : DAILY_LAUNCHES
  const target = ledgerRecord({
    epoch: randomBytes(16).toString("hex"),
    revision: 1,
    day: today,
    last_clock_ms: nowMs,
    spent,
    evaluate: { ...emptyKind(), launched: legacy.state === "valid" ? legacy.spent : 0 },
    triage: emptyKind(),
    windows: [0, 0, 0, 0],
    last_triage_at: null,
    issued_serial: 0,
    consumed_through: 0,
    continuations: [],
  })
  return { ledger: target, mark: await commit(io, env, root, target, null) }
}

// Runs `body(ledger, nowMs)` with the witnesses settled, under the ledger lock. `body` answers `{ result, target? }`: a `target` is
// committed as the next revision and everything is read back before `result` is answered. Any failure answers `write_failed`.
async function transact(io, env, { nowMs, legacyEvaluator }, body) {
  const root = await factoryStateRoot(env)
  return withNamedLock(env, LEDGER_LOCK, async () => {
    let settled
    try {
      settled = await settle(io, env, root, { nowMs, legacyEvaluator })
    } catch {
      return { state: "write_failed" }
    }
    if (settled.state !== undefined) return { state: settled.state }
    // A clock a little behind the witnessed one (within `CLOCK_SKEW_MS`) is read as the witnessed one: the ledger's clock never moves back.
    const decided = body(settled.ledger, Math.max(nowMs, settled.ledger.last_clock_ms))
    if (decided.target === undefined) return decided.result
    const target = ledgerRecord({ ...decided.target, revision: settled.ledger.revision + 1 })
    try {
      await commit(io, env, root, target, settled.mark)
      // Read all three again right before the caller acts: they must agree on exactly this revision.
      const again = assess(await readAll(io, env, root), nowMs)
      if (again.kind !== "ok" || !same(again.ledger, target) || (statusResetDay(root) ?? "") >= dayOf(nowMs)) return { state: "readback_mismatch" }
    } catch {
      return { state: "write_failed" }
    }
    return decided.result
  })
}

// ---------------------------------------------------------------------------
// The interfaces.
// ---------------------------------------------------------------------------

const DEFAULT_IO = { readStatus, updateStatus, rename: (from, to) => fsp.rename(from, to), fault: async () => {}, platform: process.platform }

/**
 * `createHeadlessLedger(seams) -> { reserveAgentLaunch, finishAgentLaunch, createEvaluationContinuation, consumeEvaluationContinuation }`:
 * the same four functions over injected `readStatus`, `updateStatus`, `rename`, `platform` and `fault(point)` (called at each of
 * `FAULT_POINTS`; a throw there stops the transaction as a crash would). The module's own exports use the real ones.
 */
export function createHeadlessLedger(seams = {}) {
  const io = { ...DEFAULT_IO, ...seams }

  /**
   * `reserveAgentLaunch(env, { kind, generation, now, legacyEvaluator, launches }) -> { state, token?, day?, remaining? }`: spends one launch of
   * `kind` (`evaluate` or `triage`) before the caller starts it, or two (`launches: 2`, triage only) for a triage qualification, which
   * starts two model sessions in one window; the token then carries `launches: 2` and is finished once for both. `state` is `reserved` (with the token `finishAgentLaunch` takes, the
   * ledger's UTC day and the launches of that kind still allowed now), a quota refusal (`quota_exhausted`, `window_protected`,
   * `window_used`, `triage_cooldown`) or a state that blocks every launch (see the header). `legacyEvaluator` is the stored
   * `status.evaluator`, read only by the first migration. A reservation is never given back.
   */
  async function reserveAgentLaunch(env, { kind, generation = null, now, legacyEvaluator, launches = 1 } = {}) {
    if (!KINDS.has(kind)) throw new TypeError("kind: must be evaluate or triage")
    if (launches !== 1 && (launches !== 2 || kind !== "triage")) throw new TypeError("launches: must be 1, or 2 for a triage qualification")
    requireGeneration(generation)
    const readMs = toMs(now, "now")
    return transact(io, env, { nowMs: readMs, legacyEvaluator }, (current, nowMs) => {
      const ledger = rollover(current, nowMs)
      const quota = quotaFor(ledger, kind, nowMs, launches)
      if (quota.state !== "ok") return { result: { state: quota.state, day: ledger.day, remaining: 0 } }
      const target = { ...ledger, last_clock_ms: nowMs, spent: ledger.spent + launches, [kind]: { ...ledger[kind], launched: ledger[kind].launched + launches } }
      if (kind === "triage") {
        target.windows = ledger.windows.map((used, index) => (index === windowOf(nowMs) ? 1 : used))
        target.last_triage_at = new Date(nowMs).toISOString()
      }
      return { target, result: { state: "reserved", token: { epoch: ledger.epoch, revision: current.revision + 1, kind, day: ledger.day, ...(launches === 1 ? {} : { launches }) }, day: ledger.day, remaining: quota.remaining } }
    })
  }

  /**
   * `finishAgentLaunch(env, { token, state, now }) -> { state }`: adds a reserved launch's outcome (`ran`, `failed` or `not_started`) to
   * its kind's counts. It changes nothing else: the launch stays spent. `state` is `recorded`, `stale_token` (another epoch, a revision
   * not reserved, or one already finished), `day_closed` (the launch's day has ended) or a blocking state.
   */
  async function finishAgentLaunch(env, { token, state, now } = {}) {
    if (!OUTCOMES.has(state)) throw new TypeError("state: must be ran, failed or not_started")
    if (!isObject(token) || !KINDS.has(token.kind) || !Number.isSafeInteger(token.revision) || typeof token.epoch !== "string" || typeof token.day !== "string" || ![undefined, 2].includes(token.launches)) throw new TypeError("token: must be a reservation token")
    const readMs = toMs(now, "now")
    return transact(io, env, { nowMs: readMs }, (settled, nowMs) => {
      // Every write carries the current clock, so the record moves to today's UTC day first; a launch from an earlier day is closed.
      const current = rollover(settled, nowMs)
      const counts = current[token.kind]
      if (token.epoch !== current.epoch || token.revision > settled.revision || token.revision <= counts.finished_revision) return { result: { state: "stale_token" } }
      if (token.day !== current.day) return { result: { state: "day_closed" } }
      const launches = token.launches ?? 1
      if (counts.ran + counts.failed + counts.not_started + launches > counts.launched) return { result: { state: "stale_token" } }
      const target = { ...current, last_clock_ms: nowMs, [token.kind]: { ...counts, [state]: counts[state] + launches, finished_revision: token.revision } }
      return { target, result: { state: "recorded" } }
    })
  }

  /**
   * `createEvaluationContinuation(env, { generation, expectedEvaluation, now }) -> { state, token? }`: persists the one continuation token
   * of a generation in which triage took the agent slot from a runnable evaluation. `expectedEvaluation` is
   * `evaluationContinuationBasis(status)` as it stood before triage. `state` is `issued`, `exists` (this generation already has its
   * token, answered again), `not_runnable` (no evaluation was waiting) or a blocking state. A new token replaces an older one.
   */
  async function createEvaluationContinuation(env, { generation, expectedEvaluation, now } = {}) {
    if (typeof generation !== "string" || !GENERATION.test(generation)) throw new TypeError("generation: must be a short code")
    if (!validBasis(expectedEvaluation)) throw new TypeError("expectedEvaluation: must be an evaluation continuation basis")
    const readMs = toMs(now, "now")
    if (expectedEvaluation.ready_now + expectedEvaluation.ready_later === 0) return { state: "not_runnable" }
    return transact(io, env, { nowMs: readMs }, (settled, nowMs) => {
      const current = rollover(settled, nowMs)
      const existing = current.continuations.find((token) => token.generation === generation)
      if (existing !== undefined) return { result: { state: "exists", token: existing } }
      const token = { epoch: current.epoch, serial: current.issued_serial + 1, generation, expected_evaluation: sha256(canonical(expectedEvaluation)) }
      const target = { ...current, last_clock_ms: nowMs, issued_serial: token.serial, continuations: [token] }
      return { target, result: { state: "issued", token } }
    })
  }

  /**
   * `consumeEvaluationContinuation(env, { token, now, status }) -> { state }`: uses a continuation token once, before the evaluation it
   * allows. It refuses another epoch (`wrong_epoch`), a serial never issued or no longer pending (`unknown_token`), a serial at or below the
   * consumed mark (`already_consumed`) and a changed evaluation basis in `status` (`eligibility_changed`, which cancels the token). It
   * answers `consumed` only after the consumed mark is written to all three witnesses. It allows nothing beyond skipping the gap that the
   * triage slot imposed: the shared quota, attempt limits, the lock and every other gate still apply.
   */
  async function consumeEvaluationContinuation(env, { token, now, status } = {}) {
    if (!isObject(token) || !Number.isSafeInteger(token.serial) || typeof token.epoch !== "string") throw new TypeError("token: must be a continuation token")
    const readMs = toMs(now, "now")
    const basis = sha256(canonical(evaluationContinuationBasis(status)))
    return transact(io, env, { nowMs: readMs }, (settled, nowMs) => {
      const current = rollover(settled, nowMs)
      if (token.epoch !== current.epoch) return { result: { state: "wrong_epoch" } }
      if (token.serial <= current.consumed_through) return { result: { state: "already_consumed" } }
      if (!current.continuations.some((pending) => same(pending, token))) return { result: { state: "unknown_token" } }
      const target = { ...current, last_clock_ms: nowMs, consumed_through: token.serial, continuations: [] }
      return { target, result: { state: token.expected_evaluation === basis ? "consumed" : "eligibility_changed" } }
    })
  }

  return { reserveAgentLaunch, finishAgentLaunch, createEvaluationContinuation, consumeEvaluationContinuation }
}

const DEFAULT_LEDGER = createHeadlessLedger()
export const { reserveAgentLaunch, finishAgentLaunch, createEvaluationContinuation, consumeEvaluationContinuation } = DEFAULT_LEDGER
