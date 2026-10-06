// What the store knows about each job's outcome: the human's answer to a delivery (sign-off), whether the job passed first time, and what was sent back. The facts carry one `outcomes` entry per job per session (`publish.js`); the entry with the highest `rev` is the job's current record. Everything here is pure and reads only the published entry: a return's `counts` flag is decided where the card is read (`outcome.js` `returnCounts`) and is never recomputed from the reasons.
//
// This module imports neither `formulas.js`, `timeline.js` nor `rollups.js`, because each of them imports it.

import { CATCH_POINTS, REFUSAL_REASONS, RETURN_REASONS, WAIT_CLASSES, reasonsAgree } from "../outcome.js"
import { stated } from "./number-states.js"
import { stableStringify } from "./normalize.js"
import { attentionRollups } from "./attention-rollup.js"

// The same string as `ROLLUPS_SCHEMA` in `rollups.js`; a test compares them.
export const OUTCOMES_SCHEMA = "desk.factory.rollups/1"

const WAIT_RANK = Object.fromEntries(WAIT_CLASSES.map((waitClass, index) => [waitClass, index + 1]))

const compareText = (left, right) => Number(left > right) - Number(left < right)

// A null wait is the shortest.
const waitRank = (entry) => (entry.wait === null ? 0 : WAIT_RANK[entry.wait.class])

// Whether `entry` is the current record rather than `held`: the higher `rev`, then the longer wait class, then (so that the answer never depends on the order the sessions come in) the entry whose canonical text sorts later.
function outranks(entry, held) {
  if (entry.rev !== held.rev) return entry.rev > held.rev
  if (waitRank(entry) !== waitRank(held)) return waitRank(entry) > waitRank(held)
  return stableStringify(entry) > stableStringify(held)
}

/**
 * `collectOutcomes(sessions) -> Map<job, outcome>`: per job the current entry across every session, in job order.
 */
export function collectOutcomes(sessions) {
  const current = new Map()
  for (const session of sessions) {
    for (const entry of session.outcomes ?? []) {
      const held = current.get(entry.job)
      if (held === undefined || outranks(entry, held)) current.set(entry.job, entry)
    }
  }
  return new Map([...current].sort(([left], [right]) => compareText(left, right)))
}

// Per-job results follow the numbers package's convention (see `stated` in number-states.js): a measured result has a `value`, a partial one also carries `partial: true` and `partial_reasons` equal to its reasons, and an unavailable one carries `value: null` beside `reason` and `reasons`. (`rollups/outcomes.json` keeps omitting `value` when unavailable, as every rollup figure does.)
const measuredResult = (value, extra) => stated({ class: "declared", state: "measured", value, reasons: [], ...extra })
const partialResult = (value, reasons, extra) => stated({ class: "declared", state: "partial", value, reasons, partial: true, partial_reasons: reasons, ...extra })
// `reason` is the older single-code key the report code reads.
const missing = (reason) => stated({ class: "unavailable", state: "unavailable", value: null, reasons: [reason], reason })

/**
 * `signoffFormula(outcome) -> result`: the human's answer to the job's delivery, as the card holds it. No entry is `not_recorded`; a delivery from before the record existed is `signoff_not_recorded`.
 */
export function signoffFormula(outcome) {
  if (!outcome) return missing("not_recorded")
  if (outcome.state === "not_recorded") return missing("signoff_not_recorded")
  return measuredResult(outcome.state, { verified: outcome.verified, reason: outcome.reason, wait: outcome.wait })
}

// The reason that decides a return: the human's for a witnessed refusal, else the agent's (as `returnCounts` decides it).
const decidedReason = (entry) => (entry.refusal !== null && entry.refusal_verified === true ? entry.refusal : entry.reason)
const isChangedAsk = (entry) => decidedReason(entry) === "changed_ask"
const recordedInFull = (outcome) => !(outcome.returns_unreadable > 0) && outcome.returns_truncated !== true

/**
 * `firstPassFormula(outcome) -> result`: whether the job's delivery passed first time, from the returns the card recorded. 0 when any return counts. Otherwise 1, measured once the human's yes is recorded by the agent on the operator's word, and partial (an upper bound) while the answer is pending.
 */
export function firstPassFormula(outcome) {
  if (!outcome) return missing("not_recorded")
  // A record from creation always lists its returns; without the list there is no history, never zero returns.
  if (outcome.since !== "created" || !Object.hasOwn(outcome, "returns")) return missing("history_not_recorded")
  if (outcome.deliveries === 0) return missing("not_delivered")
  const { returns } = outcome
  const counting = returns.filter((entry) => entry.counts === true).length
  const changedAsk = returns.filter(isChangedAsk).length
  const extra = { returns: { counting, changed_ask: changedAsk }, changed_ask_only: counting === 0 && changedAsk > 0 }
  if (counting > 0) return measuredResult(0, extra)
  if (!recordedInFull(outcome)) return missing("returns_not_fully_recorded")
  if (outcome.state === "accepted") return measuredResult(1, extra)
  if (outcome.state === "delivered_unsigned" || outcome.state === "refused") return partialResult(1, ["awaiting_signoff"], extra)
  if (outcome.state === "not_recorded") return missing("not_recorded")
  // Only a card whose record is inconsistent can reach this: a delivery taken back has a return line and a card delivered again is `delivered_unsigned`. Such a card reads as passing so far.
  if (outcome.state === "reopened" && outcome.deliveries > returns.length) return partialResult(1, ["awaiting_signoff"], extra)
  return missing("not_delivered")
}

// The three-class comparison over refusals only. `other` is not compared.
function reasonCheckOf(returns) {
  let compared = 0
  let disagree = 0
  let comparedVerified = 0
  for (const entry of returns) {
    if (entry.refusal === null) continue
    const agree = reasonsAgree(entry.refusal, entry.reason)
    if (agree === null) continue
    compared += 1
    if (!agree) disagree += 1
    if (entry.refusal_verified === true) comparedVerified += 1
  }
  return { compared, disagree, compared_verified: comparedVerified }
}

/**
 * `reworkFormula(outcome) -> result`: how many times the job's work was sent back, by catch point, and how often the agent's reason and the human's differ on the refusals. A card with no recorded history has no figure, never zero.
 */
export function reworkFormula(outcome) {
  if (!outcome) return missing("not_recorded")
  if (!Object.hasOwn(outcome, "returns")) return missing("history_not_recorded")
  const value = Object.fromEntries(CATCH_POINTS.map((point) => [point, outcome.returns.filter((entry) => entry.caught === point).length]))
  const extra = { reason_check: reasonCheckOf(outcome.returns) }
  return recordedInFull(outcome) ? measuredResult(value, extra) : partialResult(value, ["returns_not_fully_recorded"], extra)
}

const countBy = (keys, items, keyOf) => Object.fromEntries(keys.map((key) => [key, items.filter((item) => keyOf(item) === key).length]))
const sortedUnique = (reasons) => [...new Set(reasons)].sort(compareText)

// The one definition of an accepted outcome: the human's yes, recorded by the agent on the operator's word (a `verified` flag on the record, old or new, plays no part). The sign-off count and the attention headline's denominator both use it, so they cannot disagree.
const isAccepted = (entry) => entry.state === "accepted"

function signoffCounts(outcomes, timelineJobs) {
  const entries = [...outcomes.values()]
  const inState = (state) => entries.filter((entry) => entry.state === state)
  const waitCounts = (list) => countBy(WAIT_CLASSES, list.filter((entry) => entry.wait !== null), (entry) => entry.wait.class)
  return {
    recorded: true,
    jobs: entries.length,
    accepted: entries.filter(isAccepted).length,
    // Kept at 0 so a reader of the older shape still finds it: an acceptance is no longer split into verified and unverified.
    accepted_unverified: 0,
    delivered_unsigned: inState("delivered_unsigned").length,
    refused: inState("refused").length,
    refused_unverified: inState("refused").filter((entry) => entry.verified !== true).length,
    reopened: inState("reopened").length,
    not_recorded: inState("not_recorded").length,
    not_delivered: inState("not_delivered").length,
    no_record: [...timelineJobs].filter((job) => !outcomes.has(job)).length,
    jobs_without_work_record: entries.filter((entry) => !timelineJobs.has(entry.job)).length,
    refusal_reasons: countBy(REFUSAL_REASONS, inState("refused"), (entry) => entry.reason),
    waits: {
      signed: waitCounts([...inState("accepted"), ...inState("refused")]),
      unsigned: waitCounts(inState("delivered_unsigned")),
    },
  }
}

function yieldRollup(verdicts) {
  const counted = verdicts.filter((verdict) => verdict.state !== "unavailable")
  const excluded = new Map()
  for (const verdict of verdicts.filter((entry) => entry.state === "unavailable")) excluded.set(verdict.reason, (excluded.get(verdict.reason) ?? 0) + 1)
  const passed = counted.filter((verdict) => verdict.value === 1).length
  const partial = counted.filter((verdict) => verdict.state === "partial")
  const rollup = {
    n: passed,
    N: counted.length,
    passed,
    returned: counted.length - passed,
    awaiting_signoff: partial.filter((verdict) => verdict.reasons.includes("awaiting_signoff")).length,
    changed_ask_only: counted.filter((verdict) => verdict.changed_ask_only === true).length,
    excluded: [...excluded].sort(([left], [right]) => compareText(left, right)).map(([reason, jobs]) => ({ reason, jobs })),
  }
  if (counted.length === 0) return { state: "unavailable", reasons: ["no_delivered_jobs"], ...rollup }
  return {
    state: partial.length > 0 ? "partial" : "measured",
    value: passed / counted.length,
    reasons: sortedUnique(partial.flatMap((verdict) => verdict.reasons)),
    ...rollup,
  }
}

function reworkRollup(entries) {
  const formulas = entries.map(reworkFormula)
  const counted = entries.filter((_, index) => formulas[index].state !== "unavailable")
  const reasons = sortedUnique(formulas.flatMap((formula) => (formula.state === "measured" ? [] : formula.reasons)))
  if (counted.length === 0) {
    return {
      state: "unavailable",
      reasons: reasons.length === 0 ? ["not_recorded"] : reasons,
      n: 0,
      N: entries.length,
      reason_check: { state: "unavailable", reasons: ["not_recorded"] },
    }
  }
  const returns = counted.flatMap((entry) => entry.returns)
  const check = reasonCheckOf(returns)
  const state = reasons.length === 0 ? "measured" : "partial"
  return {
    state,
    reasons,
    n: counted.length,
    N: entries.length,
    returns: Object.fromEntries(CATCH_POINTS.map((point) => [point, countBy(RETURN_REASONS, returns.filter((entry) => entry.caught === point), (entry) => entry.reason)])),
    changed_ask: returns.filter(isChangedAsk).length,
    reason_check: check.compared > 0 ? { state, ...check, reasons } : { state: "unavailable", reasons: ["no_refusals"] },
  }
}

// The time in `defects` stretches by where the defect was caught. A stretch with no `caught` is not placed.
function defectTime(stretches) {
  const time = { in_task: 0, at_review: 0, after_delivery: 0, not_placed: 0 }
  for (const stretch of stretches) {
    if (stretch.waste === "defects") time[stretch.caught ?? "not_placed"] += stretch.end_ms - stretch.start_ms
  }
  return time
}

// Inside-task rework: the time in `defects` stretches over active time, across finished jobs whose sessions are all labeled (a record's `muda_sessions` is not null). `n` is the jobs counted and `N` the finished jobs. A job whose active time is unknown is left out, as is one with some sessions unlabeled; either makes the figure partial. Time in a stretch with no recorded catch point is `not_placed_ms` and also makes it partial. No numbers are given when no job is counted: a store with no labels is `no_labels`, never zero.
function defectsRollup(records, labels) {
  const finished = records.filter((record) => record.finished)
  const labeled = finished.filter((record) => record.muda_sessions !== null)
  const counted = labeled.filter((record) => "value" in record.measures.active_time)
  const base = { n: counted.length, N: finished.length }
  const reasons = []
  const someLabels = labeled.length > 0 || finished.some((record) => record.measures.muda_time.excluded === "partial")
  if (labeled.length < finished.length) reasons.push(someLabels ? "not_all_labeled" : "no_labels")
  if (counted.length < labeled.length) reasons.push("active_time_unavailable")
  if (finished.length === 0) return { state: "unavailable", reasons: ["no_finished_jobs"], ...base }
  if (counted.length === 0) return { state: "unavailable", reasons: sortedUnique(reasons), ...base }
  const time = defectTime(counted.flatMap((record) => record.sessions.flatMap((id) => labels.byJobSession.get(`${record.job}/${id}`).stretches)))
  if (time.not_placed > 0) reasons.push("catch_point_not_recorded")
  return {
    state: reasons.length === 0 ? "measured" : "partial",
    reasons: sortedUnique(reasons),
    ...base,
    active_ms: counted.reduce((total, record) => total + record.measures.active_time.value, 0),
    in_task_ms: time.in_task,
    at_review_ms: time.at_review,
    after_delivery_ms: time.after_delivery,
    not_placed_ms: time.not_placed,
  }
}

const versionOfJob = (records) => {
  const versions = new Map(records.map((record) => [record.job, record.plugin_version]))
  return (job) => versions.get(job) ?? "unknown"
}

// Each plugin version group's figures, from the jobs whose version key is that group (the key the job rollups use, `mixed` included). Every job is in exactly one group, so the counts add up to the overall ones.
function groupFigures({ sessions, outcomes, timelineJobs, jobs, groupOfJob, attention }) {
  const recorded = sessions.some((session) => Object.hasOwn(session, "outcomes"))
  const keys = [...new Set([...jobs.map(groupOfJob), ...attention.groups.keys()])].sort(compareText)
  return Object.fromEntries(keys.map((key) => {
    const own = jobs.filter((job) => groupOfJob(job) === key)
    const held = new Map([...outcomes].filter(([job]) => groupOfJob(job) === key))
    return [key, {
      signoff: recorded ? signoffCounts(held, new Set(own.filter((job) => timelineJobs.has(job)))) : { recorded: false },
      first_pass_yield: yieldRollup(own.map((job) => firstPassFormula(outcomes.get(job) ?? null))),
      attention: attention.groups.get(key),
    }]
  }))
}

/**
 * `computeOutcomeRollups({ sessions, reports, records, labels }) -> { schema, signoff, first_pass_yield, rework, attention, groupings }`: the figures across jobs, from the entries of `collectOutcomes` and the jobs that have a work record (`reports`: `{ timeline }` each). `records` (`jobRecord`'s results) and `labels` (`resolveLabels`' result) feed `rework.defects`; without them it reads `no_finished_jobs`. `signoff` says `recorded: false` and nothing else when no session carries an `outcomes` key, so an empty store never reads as zero accepted.
 *
 * `attention` is the headline: estimated human attention over every session in the period (`attention-rollup.js`), per accepted outcome (the same count as `signoff.accepted`), with its companions. `groupings.plugin_version` repeats `signoff`, `first_pass_yield` and the attention figures per version group, where a job's group is the `plugin_version` of its job record (a job with no record is `unknown`).
 */
export function computeOutcomeRollups({ sessions, reports, records = [], labels = { byJobSession: new Map() } }) {
  const outcomes = collectOutcomes(sessions)
  const timelineJobs = new Set(reports.map((report) => report.timeline.job))
  const jobs = [...new Set([...outcomes.keys(), ...timelineJobs])].sort(compareText)
  const entries = jobs.map((job) => outcomes.get(job) ?? null)
  const groupOfJob = versionOfJob(records)
  const acceptedByGroup = new Map()
  for (const entry of outcomes.values()) {
    if (isAccepted(entry)) acceptedByGroup.set(groupOfJob(entry.job), (acceptedByGroup.get(groupOfJob(entry.job)) ?? 0) + 1)
  }
  const accepted = [...outcomes.values()].filter(isAccepted).length
  const attention = attentionRollups({ sessions, groupOfJob, groupKeys: jobs.map(groupOfJob), acceptedByGroup, accepted })
  return {
    schema: OUTCOMES_SCHEMA,
    signoff: sessions.some((session) => Object.hasOwn(session, "outcomes")) ? signoffCounts(outcomes, timelineJobs) : { recorded: false },
    first_pass_yield: yieldRollup(entries.map(firstPassFormula)),
    rework: { ...reworkRollup(entries), defects: defectsRollup(records, labels) },
    attention: attention.attention,
    groupings: { plugin_version: groupFigures({ sessions, outcomes, timelineJobs, jobs, groupOfJob, attention }) },
  }
}
