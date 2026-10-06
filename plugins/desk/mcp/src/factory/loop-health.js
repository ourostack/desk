// The loop's health record and its own alarms: the `measure` step.
//
// `buildLoopHealth` reads the improvement cards and the numbers the other steps left in `status.json` and builds
// the `desk.factory.loop/1` record (the shape the store's site reads): counts, ages, the last result of each step
// and the headless evaluator's state. Every number is a Count in the number-states shape every published factory number
// uses, `{ state: "measured", value, reasons: [] }` or `{ state: "unavailable", value: null, reasons: [reason] }`, so a
// number that could not be read never shows as 0. The record holds codes,
// counts and two kinds of timestamp only: no path, card title, job id or store name, and nothing is copied from
// `status.loop` wholesale (it holds per-job attempt records and condition keys), only field by field.
//
// `runMeasureStep` writes the record to `status.json` under `loop.health`, opens one `loop_alarm:<name>` card for
// every alarm that holds (the card library builds the fixed title; a card already open is not written again), and
// then states the complete list of alarms that hold to the conditions record so the verify step can close an alarm
// card when its condition has cleared. An alarm whose input could not be read is kept in that list if it is
// recorded as present: a failed look never reads as "cleared". The ages never count `loop_alarm` cards, so an
// alarm never raises the very age that opened it.

import { createRequire } from "node:module"
import { validWorker } from "./loop-worker-state.js"
import { promises as fs } from "node:fs"
import * as path from "node:path"

import { MAX_CARD_FILES, SOURCES, cardKey, isClaimLive, openImprovement, readCards as readCardsDefault } from "../desk/improvement-cards.js"
import { cardCommitMessage, writeCardCommitted as writeCardCommittedDefault } from "../tools/_card-commit.js"
import { pluginRootFor } from "./end-hook.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { MAX_HEADLESS_JOBS_PER_DAY } from "./headless.js"
import { conditionOf, observeConditions } from "./loop-conditions.js"
import { MIN_GAP_HOURS, STEPS, recordStep, staleSteps } from "./loop-status.js"
import { readStatus, updateStatus } from "./outbox.js"
import { RECONCILE_REASONS } from "./reconcile-reasons.js"
import { PATTERNS } from "./schema.js"

export const AGE_ALARM_DAYS = 7
export const STUCK_ALARM_DAYS = 21
export const STALE_AFTER_HOURS = 72
/** A stored time this far ahead of the clock is clock skew, not a fresh reading. */
export const FUTURE_ALLOWANCE_MINUTES = 5
export const RECORD_SCHEMA = "desk.factory.loop/1"

/** Every state code the evaluator step writes; a stored state outside the list reads `unavailable` in the record. */
export const HEADLESS_STATES = Object.freeze(["idle", "ran", "no_agent_cli", "no_credentials", "disabled_would_bill", "sign_in_unknown", "budget_exhausted", "disabled", "unsupported_host"])
/** The states an agent can fix; only these open `loop_alarm:headless_blocked` (a spent cap, a switch and per-token billing are shown, never carded). */
export const BLOCKING_STATES = Object.freeze(["no_agent_cli", "no_credentials", "unsupported_host", "sign_in_unknown"])
export const BLOCKED_DAYS_FOR_ALARM = 2

const HOUR_MS = 3600 * 1000
const DAY_MS = 24 * HOUR_MS
const WINDOW_DAYS = 30
const RECONCILE_WINDOW_DAYS = 7
const REASON = /^[a-z][a-z_]{0,39}$/u
const RESULT_CODE = /^[a-z0-9][a-z0-9_:-]{0,63}$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/u
const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/u

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const isInteger = (value) => Number.isSafeInteger(value) && value >= 0
const timeOf = (value) => (typeof value === "string" && PATTERNS.timestamp.test(value) ? Date.parse(value) : Number.NaN)
const isoOrNull = (value) => (Number.isNaN(timeOf(value)) ? null : value)

/** `count(value, reason = "not_recorded") -> Count`: a non-negative integer is measured; anything else is unavailable with `reason`. */
export function count(value, reason = "not_recorded") {
  return isInteger(value) ? measured(value) : unavailable(reason)
}

const measured = (value) => ({ state: "measured", value, reasons: [] })
const unavailable = (reason) => ({ state: "unavailable", value: null, reasons: [reason] })

/** A stored Count (as the sign-off package writes it) read back, or null when it is not one. */
function storedCount(value) {
  if (!isObject(value)) return null
  const keys = Object.keys(value).length
  if (value.state === "measured" && isInteger(value.value) && (keys === 2 || (keys === 3 && Array.isArray(value.reasons) && value.reasons.length === 0))) return measured(value.value)
  if (value.state !== "unavailable") return null
  // The older two-key spelling `{ state, reason }` and the contract's `{ state, value: null, reasons: [reason] }` both read back.
  const reason = keys === 2 ? value.reason : keys === 3 && value.value === null && Array.isArray(value.reasons) && value.reasons.length === 1 ? value.reasons[0] : null
  return typeof reason === "string" && REASON.test(reason) ? unavailable(reason) : null
}

async function pluginVersion(env) {
  try {
    const version = JSON.parse(await fs.readFile(path.join(pluginRootFor(env), "plugin.json"), "utf8")).version
    return typeof version === "string" && VERSION.test(version) ? version : "unknown"
  } catch {
    return "unknown"
  }
}

// ---------------------------------------------------------------------------
// Improvement cards

const SOURCE_COUNTS = Object.fromEntries(SOURCES.map((source) => [source, 0]))

function cardSection(read, nowMs) {
  let reason = null
  if (!isObject(read) || read.unreadable === true || !Array.isArray(read.cards)) reason = "unreadable"
  else if (read.truncated === true) reason = "too_many_cards"
  if (reason !== null) {
    return {
      cards: null,
      improvement: {
        open: unavailable(reason), claimed: unavailable(reason), claim_expired: unavailable(reason), shipped: unavailable(reason), verifying: unavailable(reason),
        oldest_open_age_days: unavailable(reason), oldest_in_verification_age_days: unavailable(reason),
        closed_confirmed_30d: unavailable(reason), closed_unverified_30d: unavailable(reason), reopened_30d: unavailable(reason), reopened_from_verification: unavailable(reason),
        by_source: Object.fromEntries(SOURCES.map((source) => [source, unavailable(reason)])),
      },
      loopAlarmsOpen: unavailable(reason),
    }
  }
  const cards = read.cards
  const inState = (...states) => cards.filter((card) => states.includes(card.state))
  const live = (card) => isClaimLive(card, nowMs)
  const since = nowMs - WINDOW_DAYS * DAY_MS
  const closedWithin = (state) => cards.filter((card) => card.state === state && Date.parse(card.closed_at) >= since).length
  const oldest = (list, none) => {
    const times = list.filter((card) => card.source !== "loop_alarm").map((card) => Date.parse(card.last_opened_at))
    return times.length === 0 ? unavailable(none) : measured(Math.max(0, Math.floor((nowMs - Math.min(...times)) / DAY_MS)))
  }
  const bySource = { ...SOURCE_COUNTS }
  for (const card of inState("open")) bySource[card.source] += 1
  return {
    cards,
    improvement: {
      open: count(inState("open").length),
      claimed: count(inState("claimed").filter(live).length),
      claim_expired: count(inState("claimed").filter((card) => !live(card)).length),
      shipped: count(inState("shipped").length),
      verifying: count(inState("verifying").length),
      oldest_open_age_days: oldest(inState("open", "claimed"), "none_open"),
      oldest_in_verification_age_days: oldest(inState("shipped", "verifying"), "none_in_verification"),
      closed_confirmed_30d: count(closedWithin("closed_confirmed")),
      closed_unverified_30d: count(closedWithin("closed_unverified")),
      // Two numbers, neither claiming to be the other. `reopened_30d` counts only what can be dated: a finding that came back after its card closed
      // (`openImprovement` moves `last_opened_at`). A move from shipped or verifying back to open is counted on the card but carries no date, so
      // `reopened_from_verification` is the sum of those counts over the cards still not closed. Neither counts `loop_alarm` cards (flapping alarms).
      reopened_30d: count(cards.filter((card) => card.source !== "loop_alarm" && card.recurrences > 0 && Date.parse(card.last_opened_at) >= since).length),
      reopened_from_verification: count(cards.filter((card) => card.source !== "loop_alarm" && !card.state.startsWith("closed_")).reduce((sum, card) => sum + card.reopened, 0)),
      by_source: Object.fromEntries(Object.entries(bySource).map(([source, n]) => [source, count(n)])),
    },
    loopAlarmsOpen: count(cards.filter((card) => card.source === "loop_alarm" && !card.state.startsWith("closed_")).length),
  }
}

// ---------------------------------------------------------------------------
// The other inputs

/** A value recorded at `at` is usable when `at` reads as a time at most `STALE_AFTER_HOURS` old (a time more than `FUTURE_ALLOWANCE_MINUTES` ahead of the clock is stale too). */
function freshness(holder, nowMs) {
  if (!isObject(holder) || holder.at === undefined) return "not_recorded"
  const at = timeOf(holder.at)
  return Number.isNaN(at) || nowMs - at > STALE_AFTER_HOURS * HOUR_MS || at - nowMs > FUTURE_ALLOWANCE_MINUTES * 60 * 1000 ? "stale" : "fresh"
}

function recordedCount(holder, field, nowMs) {
  const fresh = freshness(holder, nowMs)
  if (fresh !== "fresh") return unavailable(fresh)
  return count(holder[field])
}

function unsignedSection(signoff) {
  const read = (name) => (isObject(signoff) ? storedCount(signoff[name]) : null) ?? unavailable("not_recorded")
  return { count: read("unsigned"), oldest_age_days: read("oldest_unsigned_age_days") }
}

function headlessSection(stored, today) {
  const hl = isObject(stored) && isObject(stored.headless) ? stored.headless : null
  // A stored day earlier than today means no run today: a measured 0. A day that is today's keeps its numbers; an unreadable or future day says nothing.
  const day = hl !== null && typeof hl.day === "string" && UTC_DAY.test(hl.day) ? hl.day : null
  const phase = day === null ? "unknown" : day === today ? "today" : day < today ? "earlier" : "unknown"
  // Only a state recorded on today's day is today's state; yesterday's `ran` or `no_agent_cli` is not.
  const state = phase === "today" && HEADLESS_STATES.includes(hl.state) ? hl.state : "unavailable"
  const todays = (field) => (phase === "earlier" ? count(0) : phase === "today" ? count(hl[field]) : unavailable("not_recorded"))
  let cost = unavailable("not_recorded")
  if (phase === "earlier") cost = measured(0)
  else if (phase === "today" && hl.cost_unreported_runs === 0) {
    if (typeof hl.cost_usd === "number" && Number.isFinite(hl.cost_usd) && hl.cost_usd >= 0) cost = measured(hl.cost_usd)
    else if (hl.cost_usd === null && hl.jobs === 0) cost = measured(0)
  }
  return {
    state,
    jobs_today: todays("jobs"),
    cap_per_day: count(MAX_HEADLESS_JOBS_PER_DAY),
    accepted_today: todays("accepted"),
    rejected_today: todays("rejected"),
    cost_usd_today: cost,
  }
}

function reconcileSection(summary) {
  const last = isObject(summary) ? isoOrNull(summary.at) : null
  const mismatches = {}
  if (last !== null && isObject(summary.runs)) {
    for (const reason of [...RECONCILE_REASONS, "unknown_reason"]) {
      const entry = summary.runs[reason]
      if (isObject(entry) && isInteger(entry.count) && entry.count > 0) mismatches[reason] = count(entry.count)
    }
  }
  return { last_ran_at: last, window_days: RECONCILE_WINDOW_DAYS, desks: last === null ? unavailable("not_recorded") : !isObject(summary.runs) ? unavailable("runs_damaged") : count(summary.desks), mismatches }
}

/** How often each step is expected to run: its minimum gap, and daily for the steps that run whenever the worker does. */
const expectedInterval = (name) => (MIN_GAP_HOURS[name] > 0 ? MIN_GAP_HOURS[name] : 24)

function stepsSection(status, nowMs) {
  const stored = isObject(status.loop) && isObject(status.loop.steps) ? status.loop.steps : {}
  const recorded = STEPS.filter((name) => isObject(stored[name]))
  const stale = new Set(staleSteps(status, nowMs, recorded))
  return Object.fromEntries(STEPS.map((name) => {
    const record = isObject(stored[name]) ? stored[name] : null
    return [name, {
      last_ran_at: record === null ? null : isoOrNull(record.last_ran_at),
      last_ok_at: record === null ? null : isoOrNull(record.last_ok_at),
      last_result: record === null ? "never_ran" : typeof record.last_result === "string" && RESULT_CODE.test(record.last_result) ? record.last_result : "unknown",
      // A step with no record has run 0 times; a record whose counter is damaged says nothing.
      runs: record === null ? count(0) : count(record.runs),
      failures: record === null ? count(0) : count(record.failures),
      expected_interval_hours: expectedInterval(name),
      stale: stale.has(name),
    }]
  }))
}

// The loop worker's last outcome: a code and a time, nothing else (`loop-worker-state.js`).
function workerSection(stored) {
  const worker = validWorker(stored)
  return { last_result: worker === null ? "never_ran" : worker.result, last_ran_at: worker === null ? null : worker.at }
}

const { isLoopEnabled } = createRequire(import.meta.url)("./loop-switch.cjs")

/**
 * `withLoopSwitch(record, env) -> record`: the stored health record as this machine's reader should show it. With the loop switched off in `env`
 * (`DESK_FACTORY_LOOP`, the shared rule in `loop-switch.cjs`), `worker.last_result` is `disabled` whatever the stored record holds, because a loop that is
 * off never runs the measure step and so never rewrites the record. Everything else is unchanged; a missing record stays missing. Every place that shows
 * or sends the stored record applies it where the record is read, not where it is built.
 */
export function withLoopSwitch(record, env) {
  if (!isObject(record) || isLoopEnabled(env)) return record
  return { ...record, worker: { last_ran_at: null, ...(isObject(record.worker) ? record.worker : {}), last_result: "disabled" } }
}

// ---------------------------------------------------------------------------
// Assembly

/**
 * `assembleLoop({ status, read, nowMs, version }) -> { loop, signals }`: the pure part. `signals` holds what the alarms need and the record
 * does not carry: `blocked_days` (consecutive blocked days, or null), `cards_invalid` (count of set-aside and unreadable card files, or null).
 */
export function assembleLoop({ status, read, nowMs, version }) {
  const cards = cardSection(read, nowMs)
  const stored = status
  const loopStatus = isObject(stored.loop) ? stored.loop : {}
  const evaluator = isObject(stored.evaluator) ? stored.evaluator : null
  const today = new Date(nowMs).toISOString().slice(0, 10)
  const field = (name) => (evaluator === null ? unavailable("not_recorded") : count(evaluator[name]))
  const routeIssues = loopStatus.route_issues
  const invalid = cards.cards === null || !isInteger(read.set_aside_total) || !isInteger(read.unreadable_files) ? null : read.set_aside_total + read.unreadable_files
  const loop = {
    schema: RECORD_SCHEMA,
    written_at: new Date(nowMs).toISOString(),
    desk_version: version,
    improvement: { ...cards.improvement, age_alarm_days: AGE_ALARM_DAYS, stuck_alarm_days: STUCK_ALARM_DAYS },
    unsigned_deliveries: unsignedSection(stored.signoff),
    alarms: {
      andon_open: recordedCount(routeIssues, "andon_open", nowMs),
      store_build_failing: recordedCount(routeIssues, "store_build_failing", nowMs),
      desk_problems_open: recordedCount(routeIssues, "desk_problems_open", nowMs),
      loop_alarms_open: cards.loopAlarmsOpen,
    },
    evaluator: {
      waiting: field("waiting"),
      oldest_wait_days: unavailable("not_recorded"),
      expired_total: field("expired_total"),
      labels_quarantined: recordedCount(loopStatus.labels_quarantined, "count", nowMs),
      gave_up: field("gave_up"),
      headless: headlessSection(evaluator, today),
    },
    reconcile: reconcileSection(stored.reconcile),
    steps: stepsSection(stored, nowMs),
    worker: workerSection(loopStatus.worker),
  }
  const blocked = evaluator !== null && isObject(evaluator.headless) && isInteger(evaluator.headless.blocked_days) ? evaluator.headless.blocked_days : null
  return { loop, signals: { blocked_days: blocked, cards_invalid: invalid }, cards: cards.cards }
}

function toMillis(now) {
  const time = now === null ? Number.NaN : new Date(now).getTime()
  if (Number.isNaN(time)) throw new TypeError("now: must be a valid time")
  return time
}

async function gather({ env, deskRoot, personPrefix = "", now = new Date(), readStatusImpl = readStatus, readCardsImpl = readCardsDefault, pluginVersion: given }) {
  const nowMs = toMillis(now)
  let status = null
  try {
    status = await readStatusImpl(env)
  } catch {
    status = null
  }
  let read = null
  try {
    read = await readCardsImpl({ deskRoot, personPrefix, limit: MAX_CARD_FILES })
  } catch {
    read = null
  }
  const version = given === undefined ? await pluginVersion(env) : typeof given === "string" && VERSION.test(given) ? given : "unknown"
  return { ...assembleLoop({ status: isObject(status) ? status : {}, read, nowMs, version }), status }
}

/** `buildLoopHealth({ env, deskRoot, personPrefix, now, readStatusImpl?, readCardsImpl?, pluginVersion? }) -> Loop`: the record (see the header). An unreadable input makes its numbers unavailable, never 0. */
export async function buildLoopHealth(input) {
  return (await gather(input)).loop
}

// ---------------------------------------------------------------------------
// Alarms

const measuredAbove = (value, threshold) => value.state === "measured" && value.value > threshold

/**
 * `loopAlarms(loop, { attempted?, blocked_days?, cards_invalid? }) -> [{ name, evidence }]`: the alarms that hold now, in a fixed order. `evidence`
 * is a small object of counts for the caller's logs; a card carries no evidence pointer. `attempted` names the steps the worker ran this
 * run: a step that was not attempted never raises `step_stale`.
 */
export function loopAlarms(loop, signals = {}) {
  const alarms = []
  const { improvement, unsigned_deliveries: unsigned, evaluator, steps } = loop
  if (measuredAbove(improvement.oldest_open_age_days, AGE_ALARM_DAYS)) alarms.push({ name: "improvement_age", evidence: { age_days: improvement.oldest_open_age_days.value } })
  if (measuredAbove(improvement.oldest_in_verification_age_days, STUCK_ALARM_DAYS)) alarms.push({ name: "improvement_stuck", evidence: { age_days: improvement.oldest_in_verification_age_days.value } })
  if (measuredAbove(unsigned.oldest_age_days, AGE_ALARM_DAYS)) alarms.push({ name: "unsigned_age", evidence: { age_days: unsigned.oldest_age_days.value } })
  if (BLOCKING_STATES.includes(evaluator.headless.state) && isInteger(signals.blocked_days) && signals.blocked_days >= BLOCKED_DAYS_FOR_ALARM) alarms.push({ name: "headless_blocked", evidence: { blocked_days: signals.blocked_days } })
  if (isInteger(signals.cards_invalid) && signals.cards_invalid > 0) alarms.push({ name: "cards_invalid", evidence: { files: signals.cards_invalid } })
  if (measuredAbove(evaluator.labels_quarantined, 0)) alarms.push({ name: "labels_quarantined", evidence: { count: evaluator.labels_quarantined.value } })
  for (const step of signals.attempted ?? []) if (STEPS.includes(step) && steps[step].stale) alarms.push({ name: `step_stale:${step}`, evidence: { failures: steps[step].failures.value } })
  return alarms
}

/** `unreadAlarms(loop, signals) -> [name]`: the alarms whose input could not be read this run. They are neither raised nor cleared by it. */
export function unreadAlarms(loop, signals = {}) {
  const unread = []
  const { improvement, unsigned_deliveries: unsigned, evaluator } = loop
  const blind = (value, none) => value.state === "unavailable" && value.reasons[0] !== none
  if (blind(improvement.oldest_open_age_days, "none_open")) unread.push("improvement_age")
  if (blind(improvement.oldest_in_verification_age_days, "none_in_verification")) unread.push("improvement_stuck")
  // A measured 0 unsigned reads clear whatever the age says; a count that is above 0 with no age, or no count, cannot be read.
  if (unsigned.count.state === "unavailable" || (unsigned.count.value > 0 && unsigned.oldest_age_days.state === "unavailable")) unread.push("unsigned_age")
  if (evaluator.headless.state === "unavailable" || !isInteger(signals.blocked_days)) unread.push("headless_blocked")
  if (!isInteger(signals.cards_invalid)) unread.push("cards_invalid")
  if (evaluator.labels_quarantined.state === "unavailable") unread.push("labels_quarantined")
  const attempted = signals.attempted ?? []
  for (const step of STEPS) if (!attempted.includes(step)) unread.push(`step_stale:${step}`)
  return unread
}

// ---------------------------------------------------------------------------
// The step

/**
 * `runMeasureStep(env, { deskRoot, personPrefix = "", now, attempted = [], ...seams }) -> { ok, result, counts }`. `attempted` names the steps the
 * worker ran in this run. Results: `measured` (ok); `headless_session` (nothing written, nothing recorded); `status_unavailable` and `status_write_failed` (nothing
 * recorded); `alarm_write_failed`, `observe_failed` and `step_not_recorded` (not ok; the record was written). Seams, for tests: `writeCardCommitted`,
 * `observe`, `readStatusImpl`, `updateStatusImpl`, `readCardsImpl`, `recordStepImpl`, `pluginVersion`. It throws only for an invalid `deskRoot` or `now`.
 */
export async function runMeasureStep(env, {
  deskRoot, personPrefix = "", now = new Date(), attempted = [],
  writeCardCommitted = writeCardCommittedDefault, observe = observeConditions, readStatusImpl = readStatus, updateStatusImpl = updateStatus,
  readCardsImpl = readCardsDefault, recordStepImpl = recordStep, pluginVersion: version,
} = {}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("deskRoot: must be an absolute path")
  const nowMs = toMillis(now)
  const counts = {}
  const tally = (code) => { counts[code] = (counts[code] ?? 0) + 1 }
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session", counts }
  const date = new Date(nowMs)

  let status
  try {
    status = await readStatusImpl(env)
  } catch {
    status = null
  }
  if (!isObject(status)) return { ok: false, result: "status_unavailable", counts }

  const built = await gather({ env, deskRoot, personPrefix, now: date, readStatusImpl: async () => status, readCardsImpl, pluginVersion: version })
  try {
    await updateStatusImpl(env, (current) => ({ ...current, loop: { ...(isObject(current.loop) ? current.loop : {}), health: built.loop } }))
  } catch {
    return { ok: false, result: "status_write_failed", counts }
  }

  const signals = { ...built.signals, attempted: attempted.filter((name) => STEPS.includes(name)) }
  const holding = loopAlarms(built.loop, signals)
  const open = new Set((built.cards ?? []).filter((card) => card.source === "loop_alarm" && !card.state.startsWith("closed_")).map((card) => card.key))
  let writeFailed = false
  for (const { name } of holding) {
    const key = cardKey("loop_alarm", name)
    if (open.has(key)) continue
    try {
      const { result, commit } = await writeCardCommitted({
        deskRoot, personPrefix,
        write: () => openImprovement({ deskRoot, personPrefix, key, source: "loop_alarm", evidence: [], plugin: "desk", signal: null, now: date }),
        message: (written) => cardCommitMessage("measure", written.file_name ?? "set_aside"),
      })
      if (result.result === "opened" || result.result === "reopened") tally(result.result)
      else if (result.result === "duplicate") tally("duplicate")
      else { writeFailed = true; tally("card_write_failed") }
      if (commit !== "committed" && commit !== "no_change" && commit !== "no_files") tally(commit)
    } catch {
      writeFailed = true
      tally("card_write_failed")
    }
  }

  // The complete list of alarms that hold. An alarm whose input could not be read stays in it when it is recorded present.
  const present = new Set(holding.map((alarm) => alarm.name))
  for (const name of unreadAlarms(built.loop, signals)) {
    if (!present.has(name) && conditionOf(status, `loop_alarm:${name}`).present === true) present.add(name)
  }
  let observeFailed = false
  try {
    const seen = await observe(env, { source: "loop_alarm", present: [...present], now: date })
    if (!seen?.ok) observeFailed = true
  } catch {
    observeFailed = true
  }
  if (observeFailed) tally("observe_failed")

  const result = writeFailed ? "alarm_write_failed" : observeFailed ? "observe_failed" : "measured"
  const ok = result === "measured"
  try {
    await recordStepImpl(env, "measure", { ok, result, now: date })
  } catch {
    return { ok: false, result: "step_not_recorded", counts }
  }
  return { ok, result, counts }
}
