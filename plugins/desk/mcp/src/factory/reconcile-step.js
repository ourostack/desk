// The loop's scheduled `reconcile` step. Once a day it runs the existing read-only `reconcile` over the last 7
// days for up to 3 desks (the distinct desks named by recent derivation receipts) and keeps only counts per reason
// and warning codes in `status.json.reconcile`. A run that did not happen (nothing due, failed, invalid) never
// looks like a run that found nothing: it keeps the previous counts and writes its own result code in
// `last_result`; only a completed run changes `at`, `desks` and `runs`.
//
// Summary shape (a contract read by the card-routing step and the health record; counts and codes only):
//   status.reconcile = { at: <UTC time of the last completed run> | null, window_days: 7,
//     desks_known: <desks the last completed run knew of>, desks: <desks reconciled in it>, desks_failed: <desks that failed in it>,
//     runs: { <reason code | "unknown_reason">: { consecutive, count, clear } }, warnings: [<code>], last_result: <code> }
// The unit of a streak is one desk's own daily reconcile, kept per desk (below) and changed only when that desk was
// reconciled; a desk that was skipped, over the cap or failed keeps its streaks. `runs.<reason>` is derived from the known
// desks: `count` is the sum of each desk's latest count, `consecutive` the highest per-desk run of days the reason was
// present, `clear` the lowest per-desk run of clean days among desks that ever showed it.
// The summary is rebuilt from known fields on every write, and a `runs` key is kept only for a known reason code.
// Per-desk bookkeeping is path-keyed, so it lives outside the summary, in
// `status.loop.reconcile_desks.<first 16 hex of sha256(desk root)> = { at, reasons: { <reason>: { streak, count, clear } } }`,
// and no desk path is ever written to the summary. At most 20 desks are tracked: past that, the desks reconciled longest ago
// are dropped with their streaks. A tracked desk not reconciled for more than `DESK_STALE_DAYS` (14) is dropped before the summary
// is derived (its folder is gone or its receipts were pruned), so its count and streaks cannot hold a reason open forever.

import { createHash } from "node:crypto"
import path from "node:path"

import { readStatus, updateStatus } from "./outbox.js"
import { recordStep } from "./loop-status.js"
import { reconcile } from "./reconcile.js"
import { RECONCILE_REASONS } from "./reconcile-reasons.js"

export const RECONCILE_WINDOW_DAYS = 7
export const RECONCILE_CONFIRM_RUNS = 2
export const MAX_RECONCILE_DESKS = 3

const DAY_MS = 24 * 3600 * 1000
const UNKNOWN_REASON = "unknown_reason"
const UNKNOWN_WARNING = "unknown_warning"
const WARNING_CODE = /^[a-z0-9_]{1,40}$/
const MAX_WARNINGS = 20
const MAX_CLEAR = 1000
const MAX_TRACKED_DESKS = 20
export const DESK_STALE_DAYS = 14
const KNOWN_RUN_KEYS = new Set([...RECONCILE_REASONS, UNKNOWN_REASON])

const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value)
const isCount = (value) => Number.isSafeInteger(value) && value >= 0
const reasonCode = (reason) => (RECONCILE_REASONS.includes(reason) ? reason : UNKNOWN_REASON)
const deskKey = (root) => createHash("sha256").update(root).digest("hex").slice(0, 16)

/** `summarizeReconcile(result) -> { counts: { <reason>: n }, warnings: [code] } | null`: counts per reason (a reason outside the shared list is counted under `unknown_reason`) and warning codes (a malformed one is `unknown_warning`); `null` for a result that is not a completed report. */
export function summarizeReconcile(result) {
  if (!isObject(result) || result.ok !== true || !isObject(result.counts) || !isObject(result.counts.by_reason)) return null
  if (result.warnings !== undefined && !Array.isArray(result.warnings)) return null
  const entries = Object.entries(result.counts.by_reason)
  if (!entries.every(([, count]) => isCount(count))) return null
  const counts = {}
  for (const [reason, count] of entries) if (count > 0) counts[reasonCode(reason)] = (counts[reasonCode(reason)] ?? 0) + count
  const warnings = [...new Set((result.warnings ?? []).map((code) => (typeof code === "string" && WARNING_CODE.test(code) ? code : UNKNOWN_WARNING)))].slice(0, MAX_WARNINGS)
  return { counts, warnings }
}

function desksOf(status) {
  const roots = Object.values(isObject(status.derivations) ? status.derivations : {})
    .map((receipt) => (isObject(receipt) ? receipt.desk_root : null))
    .filter((root) => typeof root === "string" && path.isAbsolute(root))
  return [...new Set(roots)]
}

/** One desk's reasons after a reconcile of it: a reason shown raises its streak, a known reason not shown starts counting clean days. */
function stepDesk(previous, counts) {
  const before = previous?.reasons ?? {}
  const reasons = {}
  for (const reason of new Set([...Object.keys(before), ...Object.keys(counts)])) {
    const old = before[reason] ?? { streak: 0, clear: 0 }
    const count = counts[reason] ?? 0
    reasons[reason] = count > 0
      ? { streak: old.streak + 1, count, clear: 0 }
      : { streak: 0, count: 0, clear: Math.min(old.clear + 1, MAX_CLEAR) }
  }
  return reasons
}

/** The summary's `runs`, derived from every tracked desk (already read through `readTracked`). */
function deriveRuns(trackedDesks) {
  const runs = {}
  for (const desk of Object.values(trackedDesks)) {
    for (const [reason, { streak, count, clear }] of Object.entries(desk.reasons)) {
      const seen = runs[reason]
      runs[reason] = seen === undefined
        ? { consecutive: streak, count, clear }
        : { consecutive: Math.max(seen.consecutive, streak), count: seen.count + count, clear: Math.min(seen.clear, clear) }
    }
  }
  return runs
}

/** The tracked desks that are readable: a valid time and only known reason codes. Anything else is dropped. */
function readTracked(stored) {
  const tracked = {}
  for (const [key, entry] of Object.entries(isObject(stored) ? stored : {})) {
    if (!/^[0-9a-f]{16}$/.test(key) || !isObject(entry) || Number.isNaN(Date.parse(entry.at))) continue
    const reasons = {}
    for (const [reason, value] of Object.entries(isObject(entry.reasons) ? entry.reasons : {})) {
      if (KNOWN_RUN_KEYS.has(reason) && isObject(value)) reasons[reason] = { streak: isCount(value.streak) ? value.streak : 0, count: isCount(value.count) ? value.count : 0, clear: isCount(value.clear) ? value.clear : 0 }
    }
    tracked[key] = { at: entry.at, reasons }
  }
  return tracked
}

function attempt(reconcileImpl, options) {
  let result
  try {
    result = reconcileImpl(options)
  } catch {
    return { code: "reconcile_failed" }
  }
  if (isObject(result) && result.ok === false) return { code: "reconcile_failed" }
  const summary = summarizeReconcile(result)
  if (summary === null) return { code: "reconcile_invalid" }
  if (summary.warnings.includes("git_log_failed")) return { code: "git_failed" }
  return { summary }
}

/** `runReconcileStep(env, { now, reconcileImpl, desks, personPrefix, updateStatusImpl, recordStepImpl }) -> { ok, result }`: one scheduled pass; `result` is the code recorded for the `reconcile` step. Never throws for a desk, Git or status problem. */
export async function runReconcileStep(env, { now, reconcileImpl = reconcile, desks = undefined, personPrefix = "", updateStatusImpl = updateStatus, recordStepImpl = recordStep }) {
  const nowMs = new Date(now).getTime()
  if (Number.isNaN(nowMs)) throw new TypeError("now: must be a valid time")
  const at = new Date(nowMs).toISOString()
  const finish = async (ok, result) => {
    try {
      await recordStepImpl(env, "reconcile", { ok, result, now: at })
    } catch {
      // the bookkeeping must never turn a finished run into a throw
    }
    return { ok, result }
  }

  let status
  try {
    status = await readStatus(env)
  } catch {
    return { ok: false, result: "status_unavailable" }
  }

  const lastOf = (root) => {
    const time = Date.parse(readTracked(status.loop?.reconcile_desks)[deskKey(root)]?.at)
    return Number.isNaN(time) ? -Infinity : time
  }
  const candidates = desks ?? desksOf(status)
  const due = candidates.filter((root) => nowMs - lastOf(root) >= DAY_MS || lastOf(root) > nowMs)
    .sort((a, b) => lastOf(a) - lastOf(b) || (a < b ? -1 : 1))
    .slice(0, MAX_RECONCILE_DESKS)

  const since = new Date(nowMs - RECONCILE_WINDOW_DAYS * DAY_MS).toISOString()
  const done = []
  const failures = []
  for (const deskRoot of due) {
    const outcome = attempt(reconcileImpl, { deskRoot, personPrefix, since, until: at, env })
    if (outcome.summary === undefined) failures.push(outcome.code)
    else done.push({ deskRoot, summary: outcome.summary })
  }

  let result
  if (due.length === 0) result = candidates.length === 0 ? "no_desks" : "nothing_due"
  else if (done.length === 0) result = failures[0]
  else result = failures.length > 0 ? "reconciled_some_failed" : "reconciled"
  const completed = done.length > 0

  try {
    await updateStatusImpl(env, (current) => {
      const tracked = readTracked(current.loop?.reconcile_desks)
      const before = isObject(current.reconcile) ? current.reconcile : {}
      const count0 = (value) => (isCount(value) ? value : 0)
      const freshDesks = () => Object.entries(tracked).filter(([, desk]) => nowMs - Date.parse(desk.at) <= DESK_STALE_DAYS * DAY_MS)
      let summary = {
        at: typeof before.at === "string" && !Number.isNaN(Date.parse(before.at)) ? before.at : null,
        desks_known: count0(before.desks_known), desks: count0(before.desks), desks_failed: count0(before.desks_failed),
        warnings: (Array.isArray(before.warnings) ? before.warnings : []).filter((code) => typeof code === "string" && WARNING_CODE.test(code)).slice(0, MAX_WARNINGS),
      }
      if (completed) {
        const warnings = new Set(failures.length > 0 ? ["desk_unreadable"] : [])
        for (const { deskRoot, summary: deskSummary } of done) {
          tracked[deskKey(deskRoot)] = { at, reasons: stepDesk(tracked[deskKey(deskRoot)], deskSummary.counts) }
          for (const code of deskSummary.warnings) warnings.add(code)
        }
        summary = { at, desks_known: new Set([...candidates.map(deskKey), ...freshDesks().map(([key]) => key)]).size, desks: done.length, desks_failed: failures.length, warnings: [...warnings].slice(0, MAX_WARNINGS) }
      }
      const newest = freshDesks().sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at) || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_TRACKED_DESKS)
      const trimmed = Object.fromEntries(newest)
      const loop = isObject(current.loop) ? current.loop : {}
      return {
        ...current,
        reconcile: { at: summary.at, window_days: RECONCILE_WINDOW_DAYS, desks_known: summary.desks_known, desks: summary.desks, desks_failed: summary.desks_failed, runs: deriveRuns(trimmed), warnings: summary.warnings, last_result: result },
        loop: { ...loop, reconcile_desks: trimmed },
      }
    })
  } catch {
    return finish(false, "status_write_failed")
  }
  return finish(completed || due.length === 0, result)
}
