import { withState } from "./number-states.js"
import { ATTENTION_METHOD } from "./attention.js"

const LABELS = Object.freeze({
  active_in_lead_ms: "Active time inside the lead-time window",
  queue_before_start_ms: "Queue before start",
  human_wait_ms: "Human wait",
  permission_wait_ms: "Permission wait",
  api_retry_ms: "API retry wait",
  compaction_ms: "Compaction wait time",
})

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

// The plain words for every reason a page can print. A reason with no entry
// here stops the build (`reasonText` throws), and a test walks the facts
// enums, the lists below and every reason in the built output, so a new
// reason cannot ship as a raw identifier.
const FACT_REASON_TEXT = {
  host_does_not_record: "the host does not record it",
  log_missing: "the session log was missing",
  log_truncated: "the session log ended mid-record",
  session_open: "the session was still open",
  not_collected_in_slice_1: "it is not collected yet",
  source_unreadable: "the source could not be read",
  capped: "it was cut to a size limit",
  desk_public: "the desk is public, so job timing is withheld",
  field_absent: "the host's record did not include it",
  host_records_partly: "the host records only some of it, so this is a lower bound",
  withheld_public: "it is withheld because the store is public",
}

// Reasons only the report and the rollups name; the facts enums do not.
const REPORT_REASON_TEXT = {
  worker_split: "the job owns only some workers of a session, and that session is not counted",
  worker_shared: "the session's work was shared with another job",
  censored: "the job was still open when this was measured",
  mixed: "several different causes",
  no_sessions: "no session has reported yet",
  partial: "only some sessions supplied it",
  open_job: "the job is not finished",
  not_labeled: "the independent evaluator has not labeled it",
  cancelled: "the job was cancelled",
  status_unavailable: "the job's status was not recorded",
  wait_fields_unavailable: "the wait records were not available",
  job_offsets_unavailable: "the job clock could not be read",
  zero_lead_time: "the job's lead time is zero",
  over_budget_after_binning: "the swimlane file is still larger than its size budget after every run of intervals was merged, because the intervals its stretches cite do not fit",
  labels_from_shared_session: "the labels come from a session several jobs share, so they may count another job's time",
  card_dates_shorter_than_work: "the task card's dates are shorter than the work its sessions recorded, so the lead time is at least that recorded span",
  session_work_unattributed: "a session of this task did work that no task's binding claims, so that time stays under cause not recorded and some of it may have been another task's",
  // Why a partial figure's `bound` is null: no direction is known.
  bound_reasons_conflict: "its reasons pull it both ways, so the true figure may be higher or lower",
  bound_not_moved: "its reasons do not change this figure, so it is exact for the task's window as stated",
  bound_direction_undecided: "one of its reasons has no decided direction yet, so the true figure may be higher or lower",
  bound_not_one_quantity: "it is a ranking or a status, not one quantity, so it has no single direction",
  no_wait_intervals: "no wait was recorded",
  no_active_intervals: "no active time was recorded",
  not_reported_to_store: "the store only receives published facts, so it cannot count sessions that never published any",
  not_in_published_facts: "published facts do not carry it",
  facts_missing: "the session's facts are missing",
  no_facts: "no facts file matches the labels",
  facts_ambiguous: "more than one facts file matches the labels",
  // A task's finish day.
  finish_from_card_update: "the day comes from the task card's last update, so the task finished on or before it",
  reopened: "the task was finished more than once, so this is the day it last finished",
  job_offsets_withheld: "the desk withholds this task's timing because its remote is public",
}

// What the independent evaluator's labels file can declare unreadable, and the codes of the check of labels against facts.
const LABEL_REASON_TEXT = {
  session_log_missing: "the session log was missing",
  session_mismatch: "the labels name a different session",
  job_unbound: "the session is not bound to the job",
  range: "a labeled stretch runs past the session",
  evidence_unmatched: "the labeled evidence no longer matches the facts",
  inconsistent: "a labeled stop contradicts how the facts say the wait ended",
  share_unknown: "the facts do not record which part of the session was the job's",
  outside_share: "the labels cover none of the job's own part of the session",
}

// Reasons the outcome figures (sign-off, first-pass yield, rework) carry, in words for the operator who reads the page.
const OUTCOME_REASON_TEXT = {
  not_recorded: "no outcome record is available",
  signoff_not_recorded: "the job was delivered before sign-offs were recorded",
  history_not_recorded: "the task card does not record what was sent back",
  not_delivered: "the job has no standing delivery yet",
  returns_not_fully_recorded: "some of what was sent back was not recorded",
  awaiting_signoff: "the human has not yet accepted the delivery",
  no_delivered_jobs: "no delivered job has a first-pass result yet",
  no_refusals: "no refusal could be compared with the agent's reason",
  no_labels: "the independent evaluator has not labeled any job",
  no_finished_jobs: "no job has finished yet",
  not_all_labeled: "some finished jobs are not labeled yet",
  active_time_unavailable: "the active time of some jobs was not recorded",
  catch_point_not_recorded: "some defect time has no recorded place where it was caught",
}

// Reasons the attention figure (human attention on a job) carries, in words for the operator. `not_recorded` already means "no outcome record" for the outcome figures, and the shared table holds one text per code, so its attention words are kept here and not in the shared table; `desk_public` has its words in the facts table.
export const ATTENTION_REASON_TEXT = Object.freeze({
  not_recorded: "no session of the job recorded the human's turns",
  desk_public: "the desk is public, so job timing is withheld",
  no_segments: "the job's time inside its sessions was not recorded, so the turns cannot be placed on it",
  turns_not_recorded: "some sessions did not record all of the human's turns, so this is a lower bound",
  turns_capped: "a session's list of human turns was cut to a size limit, so this is a lower bound",
  turn_not_estimable: "some turns could not be estimated, so this is a lower bound",
})
// Reasons only the store-wide attention figures carry (`attention-rollup.js`). Their words are in the shared table too, so the reasons in the built files all have text.
const ATTENTION_ROLLUP_REASON_TEXT = {
  no_accepted_outcomes: "no job has an accepted outcome yet",
  no_turn_records: "no session in the store records the human's turns",
  decision_not_estimable: "some permission decisions could not be estimated, so this is a lower bound",
}

// On an attention line a host's own flag says which host it is, so the operator can see why the figure is a lower bound. `desk_public` and the rest keep the words of the tables above.
const ATTENTION_PAGE_REASON_TEXT = Object.freeze({
  ...ATTENTION_REASON_TEXT,
  ...ATTENTION_ROLLUP_REASON_TEXT,
  host_does_not_record: "a host does not record the human's turns, so this is a lower bound",
  host_records_partly: "a host records the human's turns only in part, so this is a lower bound",
})
const ATTENTION_SHARED_TEXT = Object.fromEntries(Object.entries(ATTENTION_REASON_TEXT).filter(([code]) => code !== "not_recorded" && code !== "desk_public"))

/** The reasons only the store-wide attention figures carry. */
export const ATTENTION_ROLLUP_REASONS = Object.freeze(Object.keys(ATTENTION_ROLLUP_REASON_TEXT))

/** The reasons the report and rollups name that are not in the facts enums. */
export const REPORT_ONLY_REASONS = Object.freeze(Object.keys(REPORT_REASON_TEXT))

/** The reasons the outcome figures carry. */
export const OUTCOME_REASONS = Object.freeze(Object.keys(OUTCOME_REASON_TEXT))

/** The reason codes of the labels files: what a label can declare unreadable and why one is left unused. */
export const LABEL_REASONS = Object.freeze(Object.keys(LABEL_REASON_TEXT))

export const REASON_TEXT = Object.freeze({ ...FACT_REASON_TEXT, ...REPORT_REASON_TEXT, ...OUTCOME_REASON_TEXT, ...LABEL_REASON_TEXT, ...ATTENTION_SHARED_TEXT, ...ATTENTION_ROLLUP_REASON_TEXT })

/** `reasonText(id) -> string`: the plain words for a reason. An id with no words is a defect and stops the build. */
export function reasonText(id) {
  if (!Object.hasOwn(REASON_TEXT, id)) throw new Error(`no plain text for the reason ${String(id)}`)
  return REASON_TEXT[id]
}

export const FIELD_TEXT = Object.freeze({
  tokens: "Tokens",
  requests: "Model requests",
  models: "Models",
  turns: "Turns",
  tool_durations: "Tool durations",
  permission_waits: "Permission waits",
  human_waits: "Human waits",
  api_retries: "API retries",
  commits: "Commits",
  ci_runs: "CI runs",
  plugins: "Plugins",
  ended_at: "Session end time",
  compaction_waits: "Compaction wait time",
  agents: "Subagents",
  prs: "Pull requests",
  reasoning_tokens: "Reasoning tokens",
  entrypoint: "Entrypoint",
  tool_outcomes: "Tool outcomes",
  job_segments: "Job time segments",
  job_offsets: "Job clock offsets",
  human_turns: "Human turns",
  outcomes: "Task outcomes",
})

function fieldText(field) {
  if (!Object.hasOwn(FIELD_TEXT, field)) throw new Error(`no plain name for the field ${String(field)}`)
  return FIELD_TEXT[field]
}

const DEFINITIONS = "API retry counts are the errors the host surfaced: Claude surfaces only some of them, so its count is a lower bound, and Codex does not record them. Human wait is the gaps between prompts inside a session. Tool failure and retry definitions differ by host: Codex reads an output layout it does not recognise as ok, and Copilot adds denied. The number of compactions is recorded on every host; compaction wait time is recorded only where the host records it. Cost in money is not measured in v0."

const FOOTNOTE = `How to read these numbers: measured means every session that should supply a number did; partial means the number is a lower bound or covers only some sessions, and the reason follows; not recorded means there is no number, which is never zero. ${DEFINITIONS}`

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function reasonsPhrase(value) {
  return value.reasons.map(reasonText).join(" and ")
}

// The state a number carries, in words. A result with no known state is a
// defect upstream and stops the page; it is never read as measured.
function stateText(value, evidence = true) {
  if (!["measured", "partial", "unavailable"].includes(value.state)) throw new Error(`a number has no known state: ${String(value.state)}`)
  if (value.state === "unavailable") return `not recorded (${reasonsPhrase(value)})`
  const note = evidence && value.class !== "measured" ? [`${value.class} evidence`] : []
  if (value.state === "measured") return ["measured", ...note].join(", ")
  const uncovered = value.partial === true && value.uncovered_sessions > 0 ? [`${plural(value.uncovered_sessions, "session")} uncovered`] : []
  return `partial: ${[reasonsPhrase(value), ...uncovered, ...note].join("; ")}`
}

// A value followed by its state, or the state alone when nothing was recorded.
function labelled(text, value, evidence = true) {
  return value.state === "unavailable" ? stateText(value) : `${text} (${stateText(value, evidence)})`
}

function metric(value, suffix = " ms") {
  return labelled(`${value.value}${suffix}`, value)
}

function percentage(value) {
  return `${(value * 100).toFixed(2)}%`
}

function flowText(value) {
  return labelled(percentage(value.value), value)
}

function concurrencyText(value) {
  return labelled(value.state === "unavailable" ? "" : `maximum ${value.value.maximum}, average ${value.value.average.toFixed(2)}`, value)
}

function signalText(value, singular, pluralForm) {
  return value.state === "unavailable" ? `${pluralForm} ${stateText(value)}` : `${plural(value.value, singular, pluralForm)} (${stateText(value, false)})`
}

const SETTLED_WAIT = Object.freeze({ lt_1h: "under 1 hour", lt_1d: "under 1 day", lt_7d: "under 7 days", ge_7d: "7 days or more" })
// An unfinished wait reads as its lower edge: it has lasted at least this long.
const OPEN_WAIT = Object.freeze({ lt_1h: "under 1 hour so far", lt_1d: "at least 1 hour", lt_7d: "at least 1 day", ge_7d: "at least 7 days" })

function waitedText(wait) {
  return wait === null ? "" : `, waited ${SETTLED_WAIT[wait.class]}`
}

// The job page's sign-off line: what the human said about the delivery, how sure the record is, and how long it waited.
function signoffText(formula) {
  if (formula.class === "unavailable") return formula.reason === "signoff_not_recorded" ? "delivered, sign-off not recorded" : "not recorded"
  if (formula.value === "accepted") return `accepted${waitedText(formula.wait)}`
  if (formula.value === "refused") return `refused, reason ${formula.reason}${waitedText(formula.wait)}`
  if (formula.value === "delivered_unsigned") {
    if (formula.wait === null) return "delivered, waiting for sign-off"
    return formula.wait.class === "lt_1h" ? "delivered, waiting, under 1 hour so far" : `delivered, waiting ${OPEN_WAIT[formula.wait.class]}`
  }
  return formula.value === "reopened" ? "reopened after delivery" : "not delivered yet"
}

// Attention reasons are printed through the attention words, never through the shared table's `not_recorded` ("no outcome record is available"). A code the attention words do not hold (a host's own flag, `desk_public`) falls back to the shared words.
function attentionReasonsPhrase(reasons, table = ATTENTION_REASON_TEXT) {
  return reasons.map((reason) => (Object.hasOwn(table, reason) ? table[reason] : reasonText(reason))).join(" and ")
}

// A duration the operator can read: seconds under a minute, minutes under an hour, hours above.
function durationText(ms) {
  if (ms < 1000) return `${ms} ms`
  const trim = (value) => String(Number(value.toFixed(1)))
  if (ms < 60_000) return `${trim(ms / 1000)} ${ms === 1000 ? "second" : "seconds"}`
  if (ms < 3_600_000) return `${trim(ms / 60_000)} ${ms === 60_000 ? "minute" : "minutes"}`
  return `${trim(ms / 3_600_000)} ${ms === 3_600_000 ? "hour" : "hours"}`
}

// The job page's attention line: the estimate first, what it is, then its state.
function attentionText(formula) {
  if (formula.state === "unavailable") return `not recorded (${attentionReasonsPhrase(formula.reasons)})`
  const state = formula.state === "measured" ? "measured" : `partial: ${attentionReasonsPhrase(formula.reasons)}`
  return `about ${durationText(formula.value)} over ${plural(formula.turns, "human turn")} (an estimate, method version ${formula.method}; ${state})`
}

const PARTIAL_YIELD = Object.freeze({ awaiting_signoff: "waiting for sign-off" })

// The job page's first-pass line: 1 when the delivery has no return that counts, 0 when it has. A 1 with the human's answer still missing is an upper bound.
function firstPassText(formula) {
  const only = formula.changed_ask_only ? "; only changed asks came back" : ""
  if (formula.value === 0) return `0, sent back after review (${plural(formula.returns.counting, "return")} counted)${only}`
  if (formula.state === "partial") return `1, upper bound (passed so far, ${formula.reasons.map((reason) => PARTIAL_YIELD[reason]).join(", ")})${only}`
  return `1, passed first time${only}`
}

function reworkText(formula) {
  const { in_task: inTask, at_review: atReview, after_delivery: afterDelivery } = formula.value
  const check = formula.reason_check
  const bound = check.compared > 0 ? " (a lower bound)" : ""
  const partial = formula.state === "partial" ? ` (partial: ${reasonsPhrase(formula)})` : ""
  return `returned in the task ${inTask}, at review ${atReview}, after delivery ${afterDelivery}; reason check on refusals: compared ${check.compared}, disagree ${check.disagree}${bound}${partial}`
}

function countsText(counts, labels) {
  const entries = Object.keys(labels).filter((key) => counts[key] > 0).map((key) => `${labels[key]} ${counts[key]}`)
  return entries.length === 0 ? "none" : entries.join(", ")
}

function signoffSection(signoff) {
  if (!signoff.recorded) return ["## Sign-off", "", "Sign-off: not recorded in any session of this store.", ""]
  const reasons = Object.fromEntries(Object.keys(signoff.refusal_reasons).map((key) => [key, key]))
  return [
    "## Sign-off",
    "",
    `- Jobs with a sign-off record: ${signoff.jobs}; with no work record: ${signoff.jobs_without_work_record}. Jobs with a work record and no sign-off record: ${signoff.no_record}.`,
    `- Accepted (recorded by the agent on the operator's word): ${signoff.accepted}.`,
    `- Delivered, waiting for sign-off: ${signoff.delivered_unsigned}. Refused: ${signoff.refused}. Reopened: ${signoff.reopened}.`,
    `- Delivered before sign-off was recorded: ${signoff.not_recorded}. Not delivered yet: ${signoff.not_delivered}.`,
    `- Refusal reasons: ${countsText(signoff.refusal_reasons, reasons)}.`,
    `- Waits that ended in an answer: ${countsText(signoff.waits.signed, SETTLED_WAIT)}.`,
    `- Waits still open (at least this long): ${countsText(signoff.waits.unsigned, OPEN_WAIT)}.`,
    "",
  ]
}

function yieldSection(result) {
  const left = result.excluded.length === 0 ? "none" : result.excluded.map((entry) => `${plural(entry.jobs, "job")} (${reasonText(entry.reason)})`).join(", ")
  const counted = result.state === "unavailable"
    ? [`- First-pass yield: not recorded (${reasonsPhrase(result)}).`]
    : [yieldText(result), `- Sent back: ${result.returned}. Only changed asks came back: ${result.changed_ask_only}.`]
  return ["## First-pass yield", "", ...counted, `- Left out of the count: ${left}.`, ""]
}

// `n of N`, and an upper bound while the human's answer is still missing for any counted job.
function yieldText(result) {
  if (result.state === "measured") return `- First-pass yield: ${result.n} of ${result.N} delivered jobs passed first time (${percentage(result.value)}).`
  // A yield is partial only while a delivered job awaits its sign-off.
  return `- First-pass yield: at most ${result.n} of ${result.N} delivered jobs passed first time (upper bound ${percentage(result.value)}; ${result.awaiting_signoff} waiting for sign-off).`
}

function reworkSection(rework) {
  if (rework.state === "unavailable") return ["## Rework", "", `- Rework: not recorded (${reasonsPhrase(rework)}).`, ""]
  const caught = (point) => countsText(rework.returns[point], Object.fromEntries(Object.keys(rework.returns[point]).map((key) => [key, key])))
  const check = rework.reason_check
  const bound = check.state === "unavailable"
    ? `not recorded (${reasonsPhrase(check)})`
    : `compared ${check.compared}, disagree ${check.disagree}. This is a lower bound on disagreement`
  return [
    "## Rework",
    "",
    `- Jobs with returns recorded: ${rework.n} of ${rework.N}${rework.state === "partial" ? ` (partial: ${reasonsPhrase(rework)})` : ""}.`,
    `- Returns caught in the task: ${caught("in_task")}. At review: ${caught("at_review")}. After delivery: ${caught("after_delivery")}.`,
    `- Returns that were changed asks: ${rework.changed_ask}.`,
    `- Reason check on refusals: ${bound}.`,
    "",
  ]
}

// The headline first: the number and what it is (an estimate, with its method version), then its state. With no accepted outcome there is no number, and the page says so in those words and gives the attention so far, as "at least" when it is a lower bound. When nothing was recorded, no time is given at all.
function attentionHeadline(attention) {
  const { headline, est_ms: placed, human_turns: turns } = attention
  const method = attention.method.version
  const why = headline.reasons.filter((reason) => reason !== "no_accepted_outcomes")
  const phrase = attentionReasonsPhrase(why, ATTENTION_PAGE_REASON_TEXT)
  if (headline.state === "unavailable" && headline.reasons.includes("no_accepted_outcomes")) {
    if (headline.numerator_ms === undefined) return `- Human attention per accepted outcome: no accepted outcomes yet, and no human attention is recorded in the period (${phrase}).`
    const bound = why.length > 0 ? "at least " : ""
    const total = placed.attributed + placed.unattributed + placed.unplaced
    return `- Human attention per accepted outcome: no accepted outcomes yet. The estimated attention so far, with nothing to divide it by, is ${bound}${durationText(total)} over ${bound}${plural(turns, "human turn")}${why.length > 0 ? ` (${phrase})` : ""}.`
  }
  if (headline.state === "unavailable") return `- Human attention per accepted outcome: not available (${phrase}).`
  const state = headline.state === "measured" ? "measured" : `partial, so a lower bound: ${phrase}`
  return `- Human attention per accepted outcome: about ${durationText(headline.value)} (an estimate, method version ${method}; ${state}). That is ${durationText(headline.numerator_ms)} of estimated attention over ${plural(headline.accepted_outcomes, "accepted outcome")}.`
}

function attentionTurnsLine(attention) {
  const { turns_per_accepted: figure, human_turns: turns } = attention
  if (figure.state === "unavailable") {
    return figure.reasons.includes("no_accepted_outcomes") ? "- Human turns per accepted outcome: no accepted outcomes yet." : `- Human turns per accepted outcome: not available (${attentionReasonsPhrase(figure.reasons, ATTENTION_PAGE_REASON_TEXT)}).`
  }
  const bound = figure.state === "partial" ? "at least " : ""
  return `- Human turns per accepted outcome: ${bound}${Number(figure.value.toFixed(2))} (${plural(turns, "human turn")} over ${plural(figure.N, "accepted outcome")}).`
}

function attentionPermissionLine(permission) {
  const lead = "- Permission decisions, reported beside the headline and not in it: "
  if (permission.state === "unavailable") return `${lead}not recorded (${permission.reasons.map(reasonText).join(" and ")}).`
  const bound = permission.state === "partial" ? ` (partial: ${permission.reasons.map((reason) => (Object.hasOwn(ATTENTION_ROLLUP_REASON_TEXT, reason) ? ATTENTION_ROLLUP_REASON_TEXT[reason] : reasonText(reason))).join(" and ")})` : ""
  return `${lead}${permission.decisions}, estimated at ${durationText(permission.est_ms)}${bound}.`
}

function attentionSection(attention) {
  const { est_ms: placed, sessions, method } = attention
  const hostReasons = attention.headline.reasons.some((reason) => reason === "host_does_not_record" || reason === "host_records_partly")
  const hostNote = hostReasons ? " A host that does not record the human's turns (such as Codex) or records them only in part (such as Copilot, or Claude Code when only some prompts carry an origin) makes the figure a lower bound." : ""
  const constants = (table) => Object.entries(table).map(([size, ms]) => `${size} ${durationText(ms)}`).join(", ")
  return [
    "## Human attention",
    "",
    attentionHeadline(attention),
    attentionTurnsLine(attention),
    ...(placed === undefined ? [] : [`- Where the estimate went: ${durationText(placed.attributed)} on jobs, ${durationText(placed.unattributed)} on sessions that were not on any job, ${durationText(placed.unplaced)} on sessions that could not be placed on a job. All of it is in the headline, including time on refused, unsigned and undelivered work.`]),
    `- Sessions in the period: ${sessions.in_period}, of which ${sessions.complete} record the human's turns completely. Sessions from before turns were recorded are not in the period.${hostNote}`,
    attentionPermissionLine(attention.permission),
    `- Method: version ${method.version}. An estimate of the time the human spent reading the reply and writing the prompt, never longer than the gap before the prompt, and at least ${durationText(method.floor_ms)} per turn. Reading a reply by size: ${constants(method.read_ms)}. Writing a prompt by size: ${constants(method.type_ms)}. A permission decision counts at most ${durationText(method.permission_ms)}.`,
    "",
  ]
}

/**
 * `outcomeSections(outcomes) -> lines`: the sign-off, first-pass yield and rework sections of the rollups page, then the human attention section when the rollups carry one. `undefined` (a caller with no outcome rollups) adds nothing.
 */
export function outcomeSections(outcomes) {
  if (outcomes === undefined) return []
  return [...signoffSection(outcomes.signoff), ...yieldSection(outcomes.first_pass_yield), ...reworkSection(outcomes.rework), ...(outcomes.attention === undefined ? [] : attentionSection(outcomes.attention))]
}

function listedCounts(value, order = Object.keys(value).sort()) {
  const entries = order.filter((key) => value[key] !== undefined).map((key) => `${key} ${value[key]}`)
  return entries.length === 0 ? "none" : entries.join(", ")
}

function unavailableLines(formulas) {
  const lines = formulas.unavailable.value.map((entry) =>
    `- ${fieldText(entry.field)}: ${reasonText(entry.reason)} (${plural(entry.count, "session")}).`)
  for (const [label, formula] of [["First-pass yield", formulas.first_pass_yield], ["Rework", formulas.rework]]) {
    if (formula.state === "unavailable") lines.push(`- ${label}: ${stateText(formula)}.`)
  }
  return lines
}

function contributorLines(formulas) {
  const contributors = formulas.lead_contributors
  if (contributors.state === "unavailable") return [`- Lead-time contributors: ${stateText(contributors)}.`]
  const lines = contributors.value.slice(0, 2).map((entry) => {
    const source = formulas.waits[entry.key] ?? formulas[entry.key]
    const result = withState({ class: contributors.class, partial: source.partial, uncovered_sessions: source.uncovered_sessions, partial_reasons: source.partial_reasons, censored: contributors.censored })
    return `- ${LABELS[entry.key]}: ${entry.value_ms} ms, ${percentage(entry.share)} of lead time (${stateText(result)}).`
  })
  if (contributors.state === "partial") lines.push(`- Lead-time contributors are partial: ${reasonsPhrase(contributors)}.`)
  return lines
}

function waitsText(waits) {
  return `human ${metric(waits.human_wait_ms)}, permission ${metric(waits.permission_wait_ms)}, API retry ${metric(waits.api_retry_ms)}, compaction wait time ${metric(waits.compaction_ms)}`
}

const TOKEN_NAMES = Object.freeze([["total", "total"], ["input", "input"], ["output", "output"], ["cache_read", "cache read"], ["cache_write", "cache write"], ["reasoning", "reasoning"]])

// Types that share one state and reason are said once: "input, output not recorded (...)".
function tokensText(tokens) {
  const groups = []
  for (const [key, name] of TOKEN_NAMES) {
    const state = stateText(tokens[key], false)
    const same = tokens[key].state === "unavailable" ? groups.find((group) => group.state === state) : undefined
    if (same === undefined) groups.push({ state, entries: [[name, tokens[key]]] })
    else same.entries.push([name, tokens[key]])
  }
  return groups.map((group) => group.entries[0][1].state === "unavailable"
    ? `${group.entries.map(([name]) => name).join(", ")} ${group.state}`
    : `${group.entries[0][0]} ${labelled(`${group.entries[0][1].value}`, group.entries[0][1], false)}`).join(", ")
}

function referencesText(references) {
  const parts = references.parts
  const pullRequests = references.value.public_pull_requests.length === 0 ? "none" : references.value.public_pull_requests.map((entry) => `${entry.repo}#${entry.number}`).join(", ")
  const count = (part) => labelled(`${part.value}`, part, false)
  return `Public pull requests: ${labelled(pullRequests, parts.public_prs, false)}; public commits: ${count(parts.public_commits)}; private pull requests counted: ${count(parts.private_prs)}; private commits counted: ${count(parts.private_commits)}`
}

function transitionText(entry) {
  return entry.offset_ms === null ? `${entry.to} at an unknown offset` : `${entry.to} at ${entry.offset_ms} ms`
}

// The evaluator's labels for this job's sessions, or "not classified yet"
// when none of them has accepted labels. Labels come from the store's
// `labels/` entries that passed the build's checks against the facts.
function wasteLines(timeline, labelsByJobSession) {
  const total = timeline.sessions.length
  const labeled = timeline.sessions.flatMap((session) => {
    const entry = labelsByJobSession.get(`${timeline.job}/${session.id}`)
    return entry === undefined ? [] : [entry]
  })
  if (labeled.length === 0) return ["Not classified yet: no session of this job has labels from the independent evaluator."]
  const byClass = { value: 0, support: 0, muda: 0, unknown: 0 }
  const byWaste = new Map()
  let mura = 0
  let muri = 0
  for (const stretch of labeled.flatMap((entry) => entry.stretches)) {
    const duration = stretch.end_ms - stretch.start_ms
    byClass[stretch.class] += duration
    if (stretch.class === "muda") {
      const current = byWaste.get(stretch.waste) ?? { ms: 0, stretches: 0 }
      byWaste.set(stretch.waste, { ms: current.ms + duration, stretches: current.stretches + 1 })
    }
    if (stretch.mura) mura += 1
    if (stretch.muri) muri += 1
  }
  const classified = byClass.value + byClass.support + byClass.muda + byClass.unknown
  // Every line below covers only the labeled sessions, so its state is the labeled share of the job's sessions.
  const state = labeled.length === total ? "measured" : `partial: ${reasonText("not_labeled")}; ${plural(total - labeled.length, "session")} uncovered`
  const coverage = labeled.length === total
    ? `Classified by the independent evaluator: ${plural(total, "session")} labeled (${state}).`
    : `Classified by the independent evaluator: ${labeled.length} of ${plural(total, "session")} labeled (${state}).`
  const wastes = [...byWaste.entries()]
    .sort((left, right) => right[1].ms - left[1].ms || compareText(left[0], right[0]))
    .map(([waste, entry]) => `${waste} ${entry.ms} ms in ${plural(entry.stretches, "stretch", "stretches")}`)
  const share = classified === 0 ? "" : `, ${percentage(byClass.muda / classified)} of labeled time`
  const lines = [
    `- ${coverage}`,
    wastes.length === 0 ? `- Muda: none in the labeled stretches (${state}).` : `- Muda: ${byClass.muda} ms${share}, by type: ${wastes.join(", ")} (${state}).`,
    `- Value ${byClass.value} ms; support ${byClass.support} ms (${state}).`,
    ...(byClass.unknown === 0 ? [] : [`- Unknown (the evaluator could not tell, not counted as muda): ${byClass.unknown} ms (${state}).`]),
    `- Mura (unevenness) flagged on ${plural(mura, "stretch", "stretches")}; muri (overburden) on ${plural(muri, "stretch", "stretches")} (${state}).`,
  ]
  const unreadable = new Map()
  for (const code of labeled.flatMap((entry) => entry.unavailable)) unreadable.set(code, (unreadable.get(code) ?? 0) + 1)
  if (unreadable.size > 0) {
    lines.push(`- The evaluator could not read: ${[...unreadable.entries()].sort((left, right) => compareText(left[0], right[0])).map(([code, count]) => `${reasonText(code)} in ${plural(count, "session")}`).join(", ")} (measured).`)
  }
  return lines
}

export function renderJobMarkdown({ timeline, formulas, labels = new Map() }) {
  const hostCounts = formulas.sessions_by_host.value
  const sessions = formulas.sessions.value
  const transitions = timeline.transitions.length === 0 ? "none" : timeline.transitions.map(transitionText).join(", ")
  const transitionState = timeline.transitions.some((entry) => entry.offset_ms === null) ? `partial: ${reasonText("job_offsets_unavailable")}` : "measured"
  const longest = formulas.longest_wait.state === "unavailable"
    ? `- Longest single wait: ${stateText(formulas.longest_wait)}.`
    : `- Longest single wait: ${LABELS[`${formulas.longest_wait.value.kind}_ms`].toLowerCase()}, ${formulas.longest_wait.value.duration_ms} ms (${stateText(formulas.longest_wait)}).`
  const signals = formulas.rework_signals

  return [
    `# Job ${timeline.job}`,
    "",
    "## What happened",
    "",
    `- Status: ${labelled(`${formulas.status.value}`, formulas.status)}.`,
    `- Sessions: ${sessions.bound} bound, ${sessions.timeline} on the job clock (${stateText(formulas.sessions)}); by host: ${listedCounts(hostCounts)} (${stateText(formulas.sessions_by_host)}).`,
    `- Shared work: ${plural(sessions.shared, "session")} shared with ${plural(sessions.shared_with_jobs, "other job")} (${stateText(formulas.sessions)}).`,
    `- Lead time: ${metric(formulas.lead_time_ms)}.`,
    `- Queue before start: ${metric(formulas.queue_before_start_ms)}.`,
    `- Active time: ${metric(formulas.active_time_ms)} in total; inside the lead-time window: ${metric(formulas.active_in_lead_ms)}.`,
    `- Active before card (work before the task card existed, outside lead time): ${metric(formulas.active_before_card_ms)}.`,
    `- Busy time: ${metric(formulas.busy_time_ms)}; parallelism: ${metric({ ...formulas.parallelism, value: formulas.parallelism.value === null ? null : Number(formulas.parallelism.value.toFixed(2)) }, "")}.`,
    `- Flow efficiency: ${flowText(formulas.flow_efficiency)}.`,
    `- Concurrent sessions: ${concurrencyText(formulas.concurrent_sessions)}.`,
    `- Concurrent agents: ${concurrencyText(formulas.concurrent_agents)}.`,
    `- Waits: ${waitsText(formulas.waits)}.`,
    `- Tool calls: ${labelled(listedCounts(formulas.tool_calls_by_kind.value ?? {}), formulas.tool_calls_by_kind)}.`,
    `- ${referencesText(formulas.references)}.`,
    `- Tokens: ${tokensText(formulas.tokens_total)}.`,
    `- Status transitions: ${transitions} (${transitionState}).`,
    `- Sign-off: ${signoffText(formulas.signoff)}.`,
    ...(formulas.first_pass_yield.state === "unavailable" ? [] : [`- First-pass yield: ${firstPassText(formulas.first_pass_yield)}.`]),
    ...(formulas.rework.state === "unavailable" ? [] : [`- Rework: ${reworkText(formulas.rework)}.`]),
    `- Human attention: ${attentionText(formulas.attention)}.`,
    "",
    "## What mattered",
    "",
    ...contributorLines(formulas),
    longest,
    "",
    "## What was waste",
    "",
    ...wasteLines(timeline, labels),
    `- Candidate signals only (inferred): ${signalText(signals.tool_failures, "tool failure", "tool failures")}, ${signalText(signals.tool_retries, "tool retry", "tool retries")}, ${signalText(signals.api_retries, "API retry", "API retries")}, ${signalText(signals.session_retouches, "session re-touch", "session re-touches")}.`,
    `- Wait signals: ${waitsText(formulas.waits)}.`,
    "",
    "## What we could not see",
    "",
    ...unavailableLines(formulas),
    "",
    FOOTNOTE,
    "",
  ].join("\n")
}

export function buildCoverage(sessions) {
  const hostCounts = new Map()
  const unavailableCounts = new Map()
  const pluginCounts = new Map()
  let bound = 0
  for (const session of sessions) {
    if (session.jobs.length > 0) bound += 1
    hostCounts.set(session.session.host, (hostCounts.get(session.session.host) ?? 0) + 1)
    for (const entry of session.unavailable) {
      const key = `${entry.field}\n${entry.reason}`
      unavailableCounts.set(key, (unavailableCounts.get(key) ?? 0) + 1)
    }
    for (const plugin of new Set(session.plugins.map((entry) => `${entry.name}\n${entry.version}`))) {
      pluginCounts.set(plugin, (pluginCounts.get(plugin) ?? 0) + 1)
    }
  }
  const total = sessions.length
  return {
    // The store only receives published facts, so it cannot count sessions
    // that never published any.
    sessions_seen: { class: "unavailable", value: null, reason: "not_reported_to_store" },
    sessions_with_facts: total,
    bound_sessions: bound,
    unattributed_sessions: total - bound,
    hosts: [...hostCounts.entries()].map(([host, count]) => ({ host, sessions: count })).sort((left, right) => compareText(left.host, right.host)),
    unavailable: [...unavailableCounts.entries()].map(([key, count]) => {
      const [field, reason] = key.split("\n")
      return { field, reason, sessions: count, rate: count / total }
    }).sort((left, right) => compareText(left.field, right.field) || compareText(left.reason, right.reason)),
    plugins: [...pluginCounts.entries()].map(([key, count]) => {
      const [name, version] = key.split("\n")
      return { name, version, sessions: count }
    }).sort((left, right) => compareText(left.name, right.name) || compareText(left.version, right.version)),
  }
}

export function renderIndexMarkdown(reports, coverage) {
  const sorted = [...reports].sort((left, right) => compareText(left.timeline.job, right.timeline.job))
  const jobs = sorted.length === 0
    ? ["No job has published facts yet."]
    : [
        "| Job | Lead time | Active time | Active before card | Flow efficiency |",
        "| --- | ---: | ---: | ---: | ---: |",
        ...sorted.map(({ timeline, formulas }) => `| ${timeline.job} | ${metric(formulas.lead_time_ms)} | ${metric(formulas.active_time_ms)} | ${metric(formulas.active_before_card_ms)} | ${flowText(formulas.flow_efficiency)} |`),
      ]
  // One line per field; each reason it carries follows with how many sessions it covers.
  const byField = new Map()
  for (const entry of coverage.unavailable) byField.set(entry.field, [...(byField.get(entry.field) ?? []), entry])
  const unavailableEntries = [...byField.entries()].map(([field, entries]) =>
    `- ${fieldText(field)}: ${entries.map((entry) => `${reasonText(entry.reason)} (${entry.sessions} of ${coverage.sessions_with_facts} sessions, ${percentage(entry.rate)})`).join("; ")}.`)
  const pluginEntries = coverage.plugins.map((entry) => `- ${entry.name} ${entry.version}: ${plural(entry.sessions, "session")} (measured).`)
  return [
    "# Factory report index",
    "",
    "## Jobs",
    "",
    ...jobs,
    "",
    "Flow efficiency divides active time inside the lead-time window by lead time. Active before card is work before the task card existed; it is outside lead time. Each number carries its state: measured, partial with its reason, or not recorded.",
    "",
    "Totals and distributions across jobs, including which waste costs the most, are in `rollups/index.md`.",
    "",
    "## Coverage",
    "",
    `- Sessions seen: not recorded (${reasonText(coverage.sessions_seen.reason)}).`,
    `- Sessions with facts: ${coverage.sessions_with_facts} (measured).`,
    `- Bound sessions: ${coverage.bound_sessions} (measured).`,
    `- Unattributed sessions: ${coverage.unattributed_sessions} (measured).`,
    ...coverage.hosts.map((entry) => `- Host ${entry.host}: ${plural(entry.sessions, "session")} (measured).`),
    "",
    "### Unavailable evidence",
    "",
    ...(unavailableEntries.length === 0 ? ["- None."] : unavailableEntries),
    "",
    "### Plugin versions",
    "",
    ...(pluginEntries.length === 0 ? ["- None."] : pluginEntries),
    "",
  ].join("\n")
}

export function renderReadme() {
  return [
    "# Factory reports",
    "",
    "These files are generated deterministically from validated published session facts.",
    "",
    "- `index.md` lists job reports and coverage.",
    "- `jobs/<job>.md` answers the four factory questions.",
    "- `jobs/<job>.json` carries the normalized timeline and classed formulas.",
    "- `rollups/index.md` shows which waste costs the most across jobs and the measure catalog per plugin version, host and job class; `rollups/measures.json`, `rollups/muda.json`, `rollups/tool-kinds.json`, `rollups/coverage.json` and `rollups/totals.json` carry the same numbers.",
    "- `rollups/totals.json` holds fact-level totals per host and overall (sessions, tool calls, tool failures, model requests, tokens by type and subagent dispatches), each with its state, its value, n and N.",
    "",
    "Published facts contain durations and offsets only. Every number carries one of three states: measured, partial or not recorded. Not recorded means there is no number, with the reason; it is never printed as zero, and a zero is printed only when a zero was measured. Partial means the number covers only part of what it should, and its reason and the count of uncovered sessions follow it. A total or a median over several sessions or jobs reads n of N: n counted a measured value, of N in all.",
    "",
    "The reason `the host records only some of it` marks a lower bound: the host surfaced some of the records, so the real number is at least what is printed. Claude API retry counts are such a lower bound.",
    "",
    DEFINITIONS,
    "",
    "## Human attention",
    "",
    `Human attention per accepted outcome is an estimate, not a measurement. It is made with method version ${ATTENTION_METHOD}, and the method version is printed beside the attention figures. Desk changes the method version whenever it changes a constant, and the reports are rebuilt from the same facts, so a figure is only compared with figures of its own method version.`,
    "",
    "No host records how long a person spent reading a reply or writing a prompt. The estimate adds two parts for each human turn, reading the reply and writing the prompt, each taken from the size class of its character count. It is never more than the gap the host shows, when there is one, and never less than one second. The person may have read while the agent was still writing, and no host records that, so a figure is closer to a floor than to a ceiling.",
    "",
    "The headline counts every human turn of every session in the period, including turns on jobs that were refused, are unsigned or were never delivered, and the total is divided by the jobs accepted (recorded by the agent on the operator's word). A turn that falls in no job's time is shown apart as unattributed, and a turn in a session whose jobs publish no time is shown as unplaced; both stay in the headline. The same page also gives human turns per accepted outcome, a plain count over the same jobs.",
    "",
    "The headline has three states. It is measured when every session in the period has a complete list of human turns. It is partial, a lower bound, when some session in the period flags the field: Codex records no human turns, Copilot records them only in part because a prompt there cannot be told from a hook's follow-up with certainty, and a Claude Code session whose host wrote no origin on its prompts, a session cut at 1,000 turns and a log cut short flag it too. The reasons are printed. It is unavailable, with no value and no total, when no session in the period kept a list (the reason reads no human-turn records when no session is in the period, and turns not recorded, with the host's own reason, when sessions are, for example when all are Codex). It is also unavailable, with no total, when every turn is unreadable. A turn the estimator cannot read is counted, adds no time and gives the reason that a turn could not be estimated. With no accepted outcome the headline is unavailable and reads no accepted outcomes yet; the total so far is still shown, as \"at least\" when it is partial, only when a list exists and a turn could be estimated, and the headline is never zero. Sessions in the old format (`/1`) are outside the period.",
    "",
    "Permission decisions are shown beside the headline, not in it. Only Copilot records them, and each is taken as at most five seconds.",
    "",
  ].join("\n")
}
