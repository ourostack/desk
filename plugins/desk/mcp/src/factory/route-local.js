// The loop's local half of the `route` step. Four things the machine already knows about itself open improvement
// cards, with no one reading a report: a reconcile mismatch class that persisted over runs, a delivery fault the
// last flush met on two route runs in a row, evaluation requests that expired or were given up, and quarantined
// evaluation labels. Everything read is a count or a code from `status.json` (and the labels count from the boot
// check); nothing written holds a path, a store name, an account or a login, and a card holds only fixed codes and
// pointers.
//
// A source that could not be read is never observed: a failed look is not a clear look. After each successful look
// the step records which ids of the source hold now (`observeConditions`), and the verify step closes cards from
// that record. Two exceptions: `reconcile_class` is never observed here, because the verify step closes those cards
// from the reconcile summary's own `clear` streaks; and `loop_alarm` is observed by the measure step, which owns every
// name of that source, so this step never observes it. It hands the one name it owns, `labels_quarantined`, to the
// measure step as `status.loop.labels_quarantined = { count, at }` (a count and a UTC time); the measure step
// includes `labels_quarantined` in its `present` list when `count > 0` and observes the whole source itself.
//
// Counters. `status.loop.route_seen = { flush: { <code>: { runs, seen_at } }, expired_total?: <baseline>, expired_seen?: true }`. A flush
// health code counts one run per call that is at least `MIN_RUN_GAP_HOURS` after the last counted look (the loop
// worker spaces calls by 6 hours, but the step does not rely on that); a code absent from a look is removed, so
// "2 consecutive runs" cannot span a recovery. `expired_total` is a running total, so the condition is "it rose since
// the baseline" (or, when no baseline was ever recorded, "it is above zero"). The baseline moves, in a second small write
// that also sets `expired_seen`, only after the card for the rise was written, so a failed write is seen again. A baseline
// missing or damaged after `expired_seen` was set is not a first look: the total is recorded and nothing opens
// (`expired_baseline_reset`).
//
// This step does not call `recordStep`; the loop worker records `route` once for both route collectors.
// `runRouteLocalStep(env, { deskRoot, personPrefix, now, ...seams }) -> { ok, result, opened, counts }`.
// `result`: `routed`, `card_write_failed` (ok false: a card could not be written), `status_unavailable` (ok false,
// nothing read, written or opened), `status_write_failed` (ok false: the counters could not be saved, so no
// counter-based card was opened), `headless_session` (ok false, nothing written). `counts` is a count per code:
// `opened`, `duplicate`, `reopened`, `no_reconcile_summary`, `no_last_flush`, `no_evaluator_data`, `labels_unreadable`,
// `observe_failed`, `baseline_write_failed`, `expired_baseline_reset`, `card_write_failed`, and a card commit code other than `committed` (for example `not_git`).

import { readdirSync } from "node:fs"
import * as path from "node:path"

import { EVALUATOR_NAMES, FLUSH_HEALTH_CODES, RECONCILE_REASONS, cardKey, openImprovement } from "../desk/improvement-cards.js"
import { cardCommitMessage, writeCardCommitted as writeCardCommittedDefault } from "../tools/_card-commit.js"
import { factoryStateDir, labelsBootCheck } from "./boot-check.js"
import { isHeadlessFactorySession } from "./headless-flag.js"
import { observeConditions } from "./loop-conditions.js"
import { readStatus, updateStatus } from "./outbox.js"
import { RECONCILE_CONFIRM_RUNS } from "./reconcile-step.js"
import { PATTERNS } from "./schema.js"

/** The shortest time between two looks that both count as a route run for the flush health counter, in hours. */
export const MIN_RUN_GAP_HOURS = 6
/** The runs in a row a delivery fault must be seen before it opens a card. */
export const FLUSH_CONFIRM_RUNS = 2

const HOUR_MS = 3600 * 1000
const FLUSH_RESULT_CODES = ["no_account", "auth_failed", "gh_missing", "account_cannot_deliver", "route_unknown"]
// A count field of the last flush entry that stands for a flush health code. `held_elsewhere` is the markers held back
// from this store; `retraction_stalled` is the sessions frozen because a retraction cannot finish.
const FLUSH_COUNT_CODES = { held_elsewhere: "held_markers", retraction_stalled: "frozen", route_unknown: "route_unknown" }
const MAX_POINTER_COUNT = 999999

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const timeOf = (value) => (typeof value === "string" && PATTERNS.timestamp.test(value) ? Date.parse(value) : Number.NaN)

/** The flush health codes that hold now, over every store in `lastFlush`; null when there is no store entry to read. */
function flushCodes(lastFlush) {
  if (!isObject(lastFlush)) return null
  const entries = Object.values(lastFlush).filter(isObject)
  if (entries.length === 0) return null
  const present = new Set()
  for (const entry of entries) {
    if (FLUSH_RESULT_CODES.includes(entry.result)) present.add(entry.result)
    for (const [field, code] of Object.entries(FLUSH_COUNT_CODES)) if (isCount(entry[field]) && entry[field] > 0) present.add(code)
  }
  return present
}

/** True when the folders the labels check counts can be listed or are absent; a folder that exists and cannot be listed is not readable. */
function labelsFoldersReadable(env) {
  const dir = factoryStateDir(env)
  for (const name of ["evaluate-requests", "quarantine"]) {
    try {
      readdirSync(path.join(dir, name))
    } catch (error) {
      if (error?.code !== "ENOENT") return false
    }
  }
  return true
}

/** The next `route_seen` from the previous one and what holds now: counts a flush code once per gap, drops a code that is gone. */
function nextRouteSeen(previous, present, nowMs) {
  const flush = {}
  const before = isObject(previous) && isObject(previous.flush) ? previous.flush : {}
  for (const code of FLUSH_HEALTH_CODES) {
    if (!present.has(code)) continue
    const seen = before[code]
    const seenMs = isObject(seen) ? timeOf(seen.seen_at) : Number.NaN
    if (!isObject(seen) || !isCount(seen.runs) || Number.isNaN(seenMs)) {
      flush[code] = { runs: 1, seen_at: new Date(nowMs).toISOString() }
    } else if (seenMs > nowMs) {
      // A clock that moved backwards does not count a run; the look is pulled back to now so it blocks for one gap.
      flush[code] = { runs: seen.runs, seen_at: new Date(nowMs).toISOString() }
    } else if (nowMs - seenMs >= MIN_RUN_GAP_HOURS * HOUR_MS) {
      flush[code] = { runs: Math.min(seen.runs + 1, 1000), seen_at: new Date(nowMs).toISOString() }
    } else {
      flush[code] = { runs: seen.runs, seen_at: seen.seen_at }
    }
  }
  return { ...expiredFields(previous), flush }
}

/** The baseline fields of `route_seen`, kept as they are: this look moves them only after its card is written. */
function expiredFields(previous) {
  if (!isObject(previous)) return {}
  return { ...(isCount(previous.expired_total) ? { expired_total: previous.expired_total } : {}), ...(previous.expired_seen === true ? { expired_seen: true } : {}) }
}

export async function runRouteLocalStep(env, {
  deskRoot, personPrefix = "", now = new Date(),
  writeCardCommitted = writeCardCommittedDefault, labelsCheck = labelsBootCheck, labelsReadable = labelsFoldersReadable, observe = observeConditions,
  readStatusImpl = readStatus, updateStatusImpl = updateStatus,
}) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("deskRoot: must be an absolute path")
  const nowMs = new Date(now).getTime()
  if (Number.isNaN(nowMs)) throw new TypeError("now: must be a valid time")
  const opened = []
  const counts = {}
  const count = (code, n = 1) => { counts[code] = (counts[code] ?? 0) + n }
  if (isHeadlessFactorySession(env)) return { ok: false, result: "headless_session", opened, counts }

  let status
  try {
    status = await readStatusImpl(env)
  } catch {
    return { ok: false, result: "status_unavailable", opened, counts }
  }
  if (!isObject(status)) return { ok: false, result: "status_unavailable", opened, counts }

  const date = new Date(nowMs)
  let writeFailed = false
  const openCard = async (source, id, evidence) => {
    const key = cardKey(source, id)
    try {
      const { result, commit } = await writeCardCommitted({
        deskRoot, personPrefix,
        write: () => openImprovement({ deskRoot, personPrefix, key, source, evidence, plugin: "desk", signal: null, now: date }),
        message: (written) => cardCommitMessage("route", written.file_name ?? "set_aside"),
      })
      if (result.result === "opened" || result.result === "reopened") {
        opened.push(key)
        count(result.result === "opened" ? "opened" : "reopened")
      } else if (result.result === "duplicate") count("duplicate")
      else { writeFailed = true; count("card_write_failed") }
      if (commit !== "committed" && commit !== "no_change" && commit !== "no_files") count(commit)
    } catch {
      writeFailed = true
      count("card_write_failed")
    }
  }
  const observeSource = async (source, present) => {
    try {
      const seen = await observe(env, { source, present: [...present], now: date })
      if (!seen?.ok) count("observe_failed")
    } catch {
      count("observe_failed")
    }
  }

  // The evaluator summary: both fields must be counts for the source to count as read.
  const evaluator = isObject(status.evaluator) ? status.evaluator : null
  const expiredTotal = evaluator !== null && isCount(evaluator.expired_total) ? evaluator.expired_total : null
  const gaveUp = evaluator !== null && isCount(evaluator.gave_up) ? evaluator.gave_up : null

  // The labels count, handed to the measure step; a boot check that fails records nothing.
  let labels = null
  try {
    // The boot check turns a folder it cannot list into zero, so a look that could not be made is ruled out first.
    const checked = labelsReadable(env) ? labelsCheck({ env, now: nowMs }) : null
    if (isCount(checked?.quarantined)) labels = checked.quarantined
    else count("labels_unreadable")
  } catch {
    count("labels_unreadable")
  }

  // The flush health look and the counters, saved in one write so no look is counted without being kept.
  const flushNow = flushCodes(status.last_flush)
  if (flushNow === null) count("no_last_flush")
  let seenNow = null
  let baseline = null
  let baselineSeen = false
  try {
    await updateStatusImpl(env, (current) => {
      const present = flushCodes(current.last_flush)
      const before = isObject(current.loop) ? current.loop : {}
      baseline = isObject(before.route_seen) && isCount(before.route_seen.expired_total) ? before.route_seen.expired_total : null
      baselineSeen = isObject(before.route_seen) && before.route_seen.expired_seen === true
      // With no store entry there is no look at the flush: its counters are kept as they are.
      const kept = isObject(before.route_seen) && isObject(before.route_seen.flush) ? before.route_seen.flush : {}
      const routeSeen = present === null
        ? { ...expiredFields(before.route_seen), flush: kept }
        : nextRouteSeen(before.route_seen, present, nowMs)
      seenNow = routeSeen
      const loop = { ...before, route_seen: routeSeen }
      if (labels !== null) loop.labels_quarantined = { count: labels, at: date.toISOString() }
      return { ...current, loop }
    })
  } catch {
    count("status_write_failed")
    return { ok: false, result: "status_write_failed", opened, counts }
  }

  // Reconcile classes: from a completed run's summary; a reason absent from `runs` is no data, not clean.
  const summary = isObject(status.reconcile) && isObject(status.reconcile.runs) && typeof status.reconcile.at === "string" ? status.reconcile : null
  if (summary === null) count("no_reconcile_summary")
  else {
    for (const reason of RECONCILE_REASONS) {
      const run = summary.runs[reason]
      if (!isObject(run) || !isCount(run.count) || !isCount(run.consecutive)) continue
      if (run.consecutive >= RECONCILE_CONFIRM_RUNS && run.count > 0) await openCard("reconcile_class", reason, [`reconcile:${reason}@${Math.min(run.count, MAX_POINTER_COUNT)}`])
    }
  }

  // Flush health: a code opens its card on the second counted run in a row.
  if (flushNow !== null && seenNow !== null) {
    for (const code of FLUSH_HEALTH_CODES) if (flushNow.has(code) && seenNow.flush[code]?.runs >= FLUSH_CONFIRM_RUNS) await openCard("flush_health", code, [])
    await observeSource("flush_health", flushNow)
  }

  // Evaluator: expired requests are a running total, so only a rise since the last look is a condition.
  if (evaluator === null) count("no_evaluator_data")
  // A baseline lost after one was written is not a first look: the total is recorded and nothing opens.
  const baselineLost = baseline === null && baselineSeen
  if (baselineLost) count("expired_baseline_reset")
  const expiredPresent = expiredTotal !== null && !baselineLost && (baseline === null ? expiredTotal > 0 : expiredTotal > baseline)
  const expiredFailedBefore = writeFailed
  writeFailed = false
  if (expiredPresent) await openCard("evaluator", "expired_requests", [])
  const expiredWritten = !writeFailed
  writeFailed ||= expiredFailedBefore
  if (gaveUp !== null && gaveUp > 0) await openCard("evaluator", "gave_up", [])
  // The baseline moves only after the card for the rise was written, so a failed write is seen again.
  if (expiredTotal !== null && expiredWritten) {
    try {
      await updateStatusImpl(env, (current) => {
        // The first write made `loop.route_seen`; if another writer removed it, this throws and is counted.
        const { loop } = current
        return { ...current, loop: { ...loop, route_seen: { ...loop.route_seen, expired_total: expiredTotal, expired_seen: true } } }
      })
    } catch {
      count("baseline_write_failed")
    }
  }
  if (expiredTotal !== null && gaveUp !== null && !baselineLost) {
    const present = []
    if (expiredPresent) present.push("expired_requests")
    if (gaveUp > 0) present.push("gave_up")
    await observeSource("evaluator", present.filter((name) => EVALUATOR_NAMES.includes(name)))
  } else if (evaluator !== null) count("no_evaluator_data")

  // Quarantined labels open their card here; the measure step observes the loop alarm names.
  if (labels !== null && labels > 0) await openCard("loop_alarm", "labels_quarantined", [])

  return { ok: !writeFailed, result: writeFailed ? "card_write_failed" : "routed", opened, counts }
}
