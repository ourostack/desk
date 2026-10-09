// The Lean walk's data: each job's work bursts and the gaps between them,
// its stack-up of lead time, its compact answer, and the causes of waste
// ranked by time. Every figure is a number-state envelope, `{ state, value,
// reasons }`, with `value` absent when the state is `unavailable`; a zero is
// always a measured zero, never missing data. No who: every time is on a
// job's own clock (milliseconds since its card was created), and the one date
// is each task's UTC finish day (`finished_on`), as the published facts carry
// it. Nothing here orders jobs against each other.
//
// Rules:
//   - The lead window is the span the job's lead time measures: from the
//     card's creation (0) to the lead time's end. When the lead time is
//     floored to the span of the job's recorded work
//     (`card_dates_shorter_than_work`), the window is that span instead.
//     Without a lead time there is no window, and every figure that needs
//     one is unavailable with the lead time's reasons. A lead time that is
//     partial (censored, or floored) makes every figure measured over its
//     window partial with the same reasons.
//   - Working and idle time split the lead window and add up to it.
//     Working time is the union of the job's `turn`, `tool` and `subagent`
//     intervals, less, in each session, the time that session's evaluator
//     labeled `waiting` (after the honest correction: the work was stopped,
//     and no other worker of the job was working), so one session's wait
//     never hides another's work. Time inside an ask-tool wait (a
//     `human_wait` whose `stop.end` is `ask_question` or `ask_plan`: the
//     agent asked the operator through a question or plan tool and waited
//     for the answer) is not working time either, except where another
//     worker of the job worked meanwhile; the facts' `human_wait` makes it
//     `next_prompt`. That rule lowers working time and flow efficiency for
//     tasks whose agents asked through those tools, which before it counted
//     the operator's think time inside the tool call as work. Idle time is
//     the rest of the window, and "waiting" means idle time and nothing
//     else. A job with no labels yet counts all of its recorded work as
//     working.
//   - Each idle moment has one `waited_on`, the first of `IDLE_WAITED_ON`
//     that claims it: `next_prompt` (a labeled wait on it, or the facts'
//     `human_wait`: the agent had stopped and the next prompt had not come,
//     nights included), `api_retry` (a labeled wait or the facts' retry),
//     `tool_failure` and `long_tool_call` (labeled waits only),
//     `queue_before_start` (no session of the job had started yet),
//     `no_session` (no session of the job was running), `other_task` (a
//     session credited to the job was working on another job's part of it)
//     and `unknown` (no label or evidence says). A session's part of each job
//     is its binding to that job (its `agents`, and worker 0's `segments`):
//     `other_task` is the session's active time that another job's binding
//     holds and this job's does not, and it names no job. Active time no
//     binding holds is not attributed: it stays `unknown`, and the `unknown`
//     and `other_task` figures that hold some of it are partial
//     (`session_work_unattributed`). Labeled classes and wastes describe
//     working time only: a label over an idle moment does not change its
//     cause.
//   - A work burst is a maximal run of working time inside the lead window,
//     broken by an idle gap of at least `BURST_IDLE_GAP_MS` (15 minutes) or
//     by an operator turn: a turn that arrives while work runs splits the
//     burst there, and one that arrives in a shorter gap starts the next
//     burst. The gaps are the rest of the window: the time before the first
//     burst, between bursts and after the last one. Bursts and gaps add up
//     to the lead time exactly, and each burst's `idle_ms` is the idle time
//     inside it, split by cause in `idle_by_waited_on_ms`: the gaps plus
//     every burst's idle time are the idle time. A gap's `waited_on` is the
//     cause holding most of it, ties to the first in `IDLE_WAITED_ON`, and
//     its `idle_by_waited_on_ms` splits all of it by cause, so a gap that
//     holds several causes is exact; the totals count short waits inside
//     bursts too, each with its own cause.
//   - The stack-up row splits the lead window into `working` (by class and
//     waste, where labeled stretches of concurrent sessions overlap the
//     moment goes to the first of value, support, the seven working wastes
//     in their schema order, unknown and agents working; plus
//     `agents_working_unlabeled_ms` and `not_labeled_ms`) and `idle` (by
//     `waited_on`), and the two add up to the lead time exactly. The document
//     says so in `basis: "wall_clock_in_lead_window"`: its totals are
//     wall-clock time inside the lead window, so they do not match the muda
//     rollup, which sums each session's labeled time. A session with no job
//     offset cannot be placed: its time reads as no session, and the
//     segments that depend on placement are partial
//     (`job_offsets_unavailable`).
//   - Labeled figures are measured only when every session of the job is
//     labeled; partial (`partial`: only some sessions supplied it) when
//     some are; unavailable (`not_labeled`, or `open_job` for a job that is
//     not finished) when none is. Labels that may count another job's time (`resolveLabels`'
//     `sharedLabels`) make them partial (`labels_from_shared_session`).
//     Working and idle time, and the idle causes the facts alone can name,
//     take only the reasons of labels the job has: labels move time, but
//     none is needed to read it.
//   - Every figure read from the job's intervals takes its state and
//     reasons from the formulas' `active_time_ms`, which reads the same
//     intervals with each session's completeness flags (`source_unreadable`,
//     `log_truncated`, `session_open`, ...): the walk never states those
//     intervals more whole than the formulas do. The job file says so for
//     its bursts and gaps in `bursts_state`. A task's `flow_efficiency` is
//     working time over lead time, stated as both are, so it agrees with
//     the working and idle figures. The formulas' own ratio (recorded
//     active time in the card's lead window over the lead time, none when
//     the lead time is floored to the work) is kept beside it as
//     `active_share_recorded`.
//   - Every partial figure says which way the true figure lies, in `bound`:
//     `"lower"` (the true figure is at least this) or `"upper"` (at most
//     this). Each reason pulls a kind of figure one way, or not at all
//     (`BOUND_DIRECTIONS`): a job still open (`censored`) makes every time
//     so far a lower bound; a lead time floored to the work makes the lead
//     and idle time lower bounds and leaves working time exact; intervals
//     the log lost make working time a lower bound and idle time an upper
//     one; and so on. A ratio takes its numerator's direction against its
//     lead time's. Every reason that can reach these figures is named
//     (`REASON_CHANGE`); one that is not fails closed. When there is no
//     direction, `bound` is `null` and `bound_reason` says why: the reasons
//     pull both ways (`bound_reasons_conflict`), none of them changes the
//     figure, so it is exact for the task's window as stated
//     (`bound_not_moved`), the figure is a ranking and not one quantity
//     (`bound_not_one_quantity`), or a reason's direction was never decided
//     (`bound_direction_undecided`). The key is never left out of a partial
//     figure, and a measured or unavailable one has none.
//   - A burst's counts publish as envelopes, never a zero for no data: its
//     labeled time is unavailable (`not_labeled`) when none of its sessions
//     has labels, its operator turns take the formulas' `attention` state
//     (unavailable when turns were not recorded or cannot be placed; a turn
//     whose attention cannot be estimated still counts), and its
//     pull requests are unavailable when the job's pull requests carry no
//     time and partial when only some do (`not_in_published_facts`, or
//     `job_offsets_unavailable` for a session the job clock cannot place).
//     A human turn outside the lead window is in no burst, and a tool call
//     counts in the burst where it starts.
//   - Each wait on the operator (every `human_wait` interval the job holds,
//     of any worker: the root's after-stop waits and any worker's ask-tool
//     wait) is listed in `waits` with its `worker`, the facts' record of how
//     the turn ended (`stop`, `null` before facts `/4`) and
//     `next_prompt_ms`, the idle `next_prompt` time inside the lead window
//     it holds. A moment two waits hold goes to the earlier, so the waits'
//     times plus the `next_prompt` time no wait holds (a labeled wait that
//     runs past every human wait) are the task's
//     `waiting_by_waited_on_ms.next_prompt` exactly.
//   - Each wait says why the agent stopped (`why`, `why_source`,
//     `confidence`; `stopClassifier`): by rule from its stop facts, else by
//     the evaluator's stop label for exactly that human wait, else
//     `not_known` with its reason in `reasons` (`NOT_KNOWN_REASONS`). The
//     task's next-prompt waiting is split by why (`WHY_SPLIT`) on each gap
//     and burst (`idle_by_why_ms`), on its task and stack-up rows
//     (`next_prompt_by_why_ms`, and on the task row its not-known part by
//     reason, `not_known_by_reason_ms`, where the time no wait holds is
//     `stop_not_recorded`), on its longest gap (`why`) and as sub-causes
//     of `waiting:next_prompt` in `rollups/causes.json` (`children`). The
//     parts add up to the figure they split and carry its state, reasons
//     and bound; while any of it is not known, each class is a lower bound
//     (`stop_partly_classified`). Stops are idle time: they never enter a
//     class or waste total. `waits_state` is that
//     figure's state, reasons and bound; when it is unavailable, every
//     `next_prompt_ms` is `null` with its reasons. A wait the task's
//     segments cut is listed once per part. A prompt joins the wait it ends
//     by session and `end_ms == at_ms`.
//   - `finished_on` is the task's UTC finish day from the published facts,
//     on the job file and on its `rollups/tasks.json` and
//     `rollups/stackup.json` rows: measured from a session's own transition,
//     an upper bound from the card's last update, the latest day when
//     sessions disagree (`reopened`), and unavailable with its reason
//     otherwise (`finishedOn`).
//   - `human_turns_state` and `prs_state` say how whole the job's lists of
//     operator prompts and pull requests are, so a list that was not
//     recorded never reads as empty: a partial list is a lower bound.
//   - A cause is `waiting:<waited_on>` for idle time, and for a labeled
//     waste of working time `<waste>:<detail>`: for defects, the failed tool
//     kind its evidence rests on most; otherwise `all`. `rollups/causes.json`
//     sums each finished, fully labeled job's causes in its lead window, so
//     a moment two jobs share counts for each (job-hours).
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { LABEL_WASTES, STOP_RULES, UNKNOWN_LABEL } from "../label-schema.js"
import { recordedSpans } from "./formulas.js"
import { ROLLUPS_SCHEMA, ownShare, pluginVersion } from "./rollups.js"
import { CAUSE_REFERENCES, UNLABELED_CLASS, askIdle, causeKey, compareFields, jobStretches, jobWaits, mostTime } from "./stretches.js"
import { ACTIVE_KINDS, boundIntervals, duration, intervalInSession, union } from "./timeline.js"

/** An idle gap at least this long ends a work burst: 15 minutes. */
export const BURST_IDLE_GAP_MS = 15 * 60 * 1000

/** What idle time waited on, in the order a moment two causes could claim is given to one, and a gap's tie broken (see the header). */
export const IDLE_WAITED_ON = Object.freeze(["next_prompt", "api_retry", "tool_failure", "long_tool_call", "queue_before_start", "no_session", "other_task", "unknown"])

/**
 * Why the agent stopped before a wait for the next prompt, in the order the page stacks them (the actionable classes first, then the
 * human gates): a class the evaluator decides (`stopped_short`, `decision`, `approval`, `acceptance`, `question`) or a rule decides from
 * the stop facts (`STOP_RULES`: `error_limit`, `interrupted`, an open question tool's `question`, a plan tool's `approval`).
 */
export const WHY_CLASSES = Object.freeze(["stopped_short", "question", "error_limit", "interrupted", "decision", "approval", "acceptance"])
const NOT_KNOWN = "not_known"
/** Every key of a split by why: the classes, then the time whose why is not known. */
export const WHY_SPLIT = Object.freeze([...WHY_CLASSES, NOT_KNOWN])
/**
 * Why a wait's why is not known: the evaluator has not labeled it (`not_labeled`: an open task, labels pending, or a stop label that no
 * longer matches its facts), looked and could not tell (`could_not_tell`), no recorded wait holds the time (`stop_not_recorded`), the facts
 * do not say which part of the session was the task's (`outside_own_share`), or older facts carry no stop and no label classified it
 * (`not_in_published_facts`).
 */
export const NOT_KNOWN_REASONS = Object.freeze(["not_labeled", "could_not_tell", "stop_not_recorded", "outside_own_share", "not_in_published_facts"])
// The confidence of a class a rule gives: the stop facts decide it mechanically.
const RULE_CONFIDENCE = "high"
// The evaluator's stop label for "could not tell".
const STOP_UNKNOWN = "unknown"
// A class figure while some of its next-prompt time is not classified: the class may hold some of the rest.
const PARTLY_CLASSIFIED = "stop_partly_classified"

/** The stack-up's labeled segments, in the order wall-clock time is given to them where stretches overlap. */
const STACKUP_CLASSES = Object.freeze(["value", "support"])
// Labeled waiting is idle time, so the wastes of working time are the other seven and unknown.
const WORKING_WASTES = Object.freeze([...LABEL_WASTES.filter((waste) => waste !== "waiting"), UNKNOWN_LABEL])

// What a stack-up segment measures (see the header).
const STACKUP_BASIS = "wall_clock_in_lead_window"
// What a cause's time in `rollups/causes.json` measures (see `causesRollup`).
const CAUSES_BASIS = "job_hours"
const MS_PER_HOUR = 3_600_000
const TOP_CAUSES = 3
const SHARED = "labels_from_shared_session"

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

const sortedUnique = (values) => [...new Set(values)].sort(compareText)

/**
 * A number-state envelope in the formulas' own shape: `class` (how the number was got: `inferred` for one this file derives,
 * `unavailable` for none), `state`, `reasons` and `value`, which is absent when the state is `unavailable`; a reason whenever the state
 * is not `measured`.
 */
export function figure(state, value, reasons, numberClass = "inferred") {
  const named = sortedUnique(reasons)
  if (state !== "measured" && named.length === 0) throw new Error(`a ${state} figure has no reason`)
  return state === "unavailable" ? { class: "unavailable", state, reasons: named } : { class: numberClass, state, value, reasons: state === "measured" ? [] : named }
}

// A formula result (a lead time, a status) as an envelope.
const fromResult = (result) => (result.state === "unavailable" ? figure("unavailable", null, result.reasons) : figure(result.state, result.value, result.reasons, result.class))

// A value whose inputs carry `reasons`: measured without any, partial with them.
const known = (value, reasons) => figure(reasons.length === 0 ? "measured" : "partial", value, reasons)

// A coverage is `{ unavailable: reasons }` or `{ reasons }` (none when whole).
const coverageOfResult = (result) => (result.state === "unavailable" ? { unavailable: result.reasons } : { reasons: result.state === "measured" ? [] : result.reasons })

// A value read from inputs with these coverages: unavailable with the reasons of every unavailable one, else measured or partial with
// `base` and every coverage's reasons.
function covered(value, base, ...coverages) {
  const missing = coverages.filter((coverage) => Object.hasOwn(coverage, "unavailable"))
  if (missing.length > 0) return figure("unavailable", null, missing.flatMap((coverage) => coverage.unavailable))
  return known(value, [...base, ...coverages.flatMap((coverage) => coverage.reasons)])
}

// What each reason that can reach a walk figure says about it, by the kind of change it stands for. The lead time's reasons, the labels'
// coverage, the job clock's placement, unattributed work, and every reason the formulas' interval coverage (`active_time_ms`) can carry:
// the facts' own flags (`ENUMS.unavailableReason`) and the shared and split workers. A reason not named here has no decided direction:
// its figure fails closed (`bound: null`, `bound_direction_undecided`), and a test fails when the fixtures reach one.
export const REASON_CHANGE = Object.freeze({
  censored: "open",
  open_job: "open",
  card_dates_shorter_than_work: "floor",
  labels_from_shared_session: "shared",
  partial: "part_labeled",
  job_offsets_unavailable: "unplaced",
  session_work_unattributed: "unattributed",
  worker_shared: "overcount",
  // A session the job owns only some workers of leaves that session's share out, as lost intervals do.
  worker_split: "unseen",
  host_does_not_record: "unseen",
  log_missing: "unseen",
  log_truncated: "unseen",
  session_open: "unseen",
  not_collected_in_slice_1: "unseen",
  source_unreadable: "unseen",
  // Intervals the publishing transform dropped for running outside the session clock: work the facts do not show.
  interval_outside_session_clock: "unseen",
  capped: "unseen",
  desk_public: "unseen",
  field_absent: "unseen",
  host_records_partly: "unseen",
  withheld_public: "unseen",
  // A list the facts do not carry (older facts) or cannot place on the job (no segments) leaves its entries unseen.
  not_in_published_facts: "unseen",
  no_segments: "unseen",
  // A finish day from the card's last update: the card can be edited after the task is done.
  finish_from_card_update: "card_update",
  // The latest of several finishes is the task's final finish, exact as such.
  reopened: "reopened",
  // Next-prompt time whose why is not known may belong to any class.
  [PARTLY_CLASSIFIED]: "unclassified",
})
const UNDECIDED = "undecided"
const changeOf = (reason) => REASON_CHANGE[reason] ?? UNDECIDED

/**
 * Which way each kind of change pulls each kind of figure: `lower` (the true figure is higher), `upper` (it is lower) or `both`; a change
 * a kind does not name leaves it where it is. A job still open (`open`) leaves every time so far a lower bound. A lead time floored to
 * the work (`floor`) is a lower bound and so is the idle time in it, and the work inside is whole. Unseen intervals hide work (working
 * time is at least this, idle time and `unknown` at most) and the evidence that names a wait. Some sessions unlabeled (`part_labeled`)
 * leaves their labeled waits counted as working, and their labeled time out. A session the job clock cannot place (`unplaced`) leaves
 * its work out and its span reading as no session. Unattributed session work (`unattributed`) may be another job's: `other_task` is at
 * least this and `unknown` at most. Unseen intervals may be this job's work inside `other_task` or another job's outside it, so they pull
 * it both ways, unless the span has no `unknown`, `no_session` or `queue_before_start` time for it to grow into: then it can only shrink
 * (`other_task_capped`). A worker shared with another job (`overcount`) has its time counted for each job, so working and labeled time
 * are at most this, and idle time, `unknown` and `other_task` at least. Labels from a shared session (`shared`) were judged without
 * knowing whose work a moment was, so the class or waste of a labeled moment can be off either way; they do not move working, idle or
 * a wait's cause, because the cut keeps every labeled moment inside this job's share and whether it is working or waiting does not
 * depend on whose it was.
 */
export const BOUND_DIRECTIONS = Object.freeze({
  lead: { open: "lower", floor: "lower", unseen: "lower", unplaced: "lower" },
  working: { open: "lower", unseen: "lower", part_labeled: "upper", unplaced: "lower", overcount: "upper" },
  labeled: { open: "lower", unseen: "lower", part_labeled: "lower", unplaced: "lower", overcount: "upper", shared: "both" },
  idle: { open: "lower", floor: "lower", unseen: "upper", part_labeled: "lower", unplaced: "upper", overcount: "lower" },
  unknown: { open: "lower", floor: "lower", unseen: "upper", part_labeled: "lower", unplaced: "upper", unattributed: "upper", overcount: "lower" },
  evidence: { open: "lower", floor: "lower", unseen: "lower", part_labeled: "lower", unplaced: "lower" },
  other_task: { open: "lower", floor: "lower", unseen: "both", part_labeled: "lower", unplaced: "lower", unattributed: "lower", overcount: "lower" },
  other_task_capped: { open: "lower", floor: "lower", unseen: "upper", part_labeled: "lower", unplaced: "lower", unattributed: "lower", overcount: "lower" },
  placement: { open: "lower", floor: "lower", unplaced: "upper" },
  count: { open: "lower", unseen: "both", unplaced: "both" },
  // A list of recorded entries (operator prompts, pull requests): whatever the facts did not record, could not place or withheld for
  // another job may be missing from it, so it holds at least these.
  list: { open: "lower", unseen: "lower", unplaced: "lower", overcount: "lower", unattributed: "lower" },
  // A finish day: the card's last update is on or after the day the task finished.
  finish: { card_update: "upper" },
  // A class of next-prompt waiting (the split by why): an evidence figure, which the time not yet classified can only add to.
  why: { open: "lower", floor: "lower", unseen: "lower", part_labeled: "lower", unplaced: "lower", unclassified: "lower" },
})

// The direction `reasons` give a figure of `kind`: "lower", "upper", "both", "none", or "undecided" when a reason is not named.
function directionOf(kind, reasons) {
  const changes = reasons.map(changeOf)
  if (changes.includes(UNDECIDED)) return UNDECIDED
  const pulls = new Set(changes.map((change) => BOUND_DIRECTIONS[kind][change]).filter((pull) => pull !== undefined))
  if (pulls.has("both") || pulls.size > 1) return "both"
  return pulls.size === 0 ? "none" : [...pulls][0]
}

const FLIP = Object.freeze({ lower: "upper", upper: "lower", both: "both", none: "none", [UNDECIDED]: UNDECIDED })

// Two directions of one figure's parts as one; an undecided part leaves the whole undecided.
function joined(left, right) {
  if (left === UNDECIDED || right === UNDECIDED) return UNDECIDED
  if (left === "none") return right
  if (right === "none" || left === right) return left
  return "both"
}

const BOUND_REASON = Object.freeze({ both: "bound_reasons_conflict", none: "bound_not_moved", ranking: "bound_not_one_quantity", [UNDECIDED]: "bound_direction_undecided" })

// A figure with its `bound` when partial: the direction, or `null` with the `bound_reason` that says why there is none.
function directed(number, direction) {
  if (number.state !== "partial") return number
  return direction === "lower" || direction === "upper" ? { ...number, bound: direction } : { ...number, bound: null, bound_reason: BOUND_REASON[direction] }
}

/** `bounded(figure, kind) -> figure`: a figure of `kind` (a key of `BOUND_DIRECTIONS`) with its `bound` when it is partial. */
export const bounded = (number, kind) => directed(number, directionOf(kind, number.reasons))

// A ratio over a lead time: its numerator's direction (a `working` figure with the ratio's reasons) against the lead time's.
const boundedRatio = (number, leadReasons) => directed(number, joined(directionOf("working", number.reasons), FLIP[directionOf("lead", leadReasons)]))

// A ranking has no one direction.
const ranked = (number) => directed(number, "ranking")

// Merged spans clipped to [start, end].
function clip(spans, start, end) {
  return spans.flatMap(([from, to]) => {
    const a = Math.max(from, start)
    const b = Math.min(to, end)
    return a < b ? [[a, b]] : []
  })
}

// Merged spans minus merged spans.
function subtract(spans, minus) {
  const out = []
  for (const [start, end] of spans) {
    let from = start
    for (const [a, b] of minus) {
      if (b <= from || a >= end) continue
      if (a > from) out.push([from, a])
      from = Math.max(from, b)
    }
    if (from < end) out.push([from, end])
  }
  return out
}

// Merged spans of [start_ms, end_ms] objects or [start, end] pairs.
const spansOf = (items) => union(items.map((item) => (Array.isArray(item) ? { start_ms: item[0], end_ms: item[1] } : item)))

// How much of the merged spans lies in [start, end].
const within = (spans, start, end) => duration(clip(spans, start, end))

/**
 * `leadWindow(timeline, formulas) -> { start_ms, end_ms, lead, reasons } | { lead, reasons }`: the span the lead time measures (see the
 * header), with the lead time's envelope and its reasons; no `start_ms` when there is no lead time.
 */
function leadWindow(timeline, formulas) {
  const result = formulas.lead_time_ms
  const lead = fromResult(result)
  if (result.state === "unavailable") return { lead, reasons: lead.reasons }
  const floored = result.reasons.includes("card_dates_shorter_than_work")
  const start = floored ? Math.min(...recordedSpans(timeline).map(([from]) => from)) : 0
  return { start_ms: start, end_ms: start + result.value, lead, reasons: lead.reasons }
}

// The job's sessions on the job clock, as [start, end] pairs, whether any could not be placed, and where the first starts (never, as
// `Infinity`, when none is placed).
function sessionSpans(timeline) {
  const placed = timeline.sessions.filter((session) => session.offset_ms !== null)
  return { spans: spansOf(placed.map((session) => [session.offset_ms, session.end_ms])), unplaced: placed.length < timeline.sessions.length, first: Math.min(...placed.map((session) => session.offset_ms)) }
}

// The labels' coverage of the job, as the reasons its labeled figures carry, or `null` (with the cause) when none can be given.
function labelState(timeline, labels, finished) {
  const keys = timeline.sessions.map((session) => `${timeline.job}/${session.id}`)
  const used = keys.filter((key) => labels.byJobSession.has(key))
  if (used.length === 0) return { unavailable: [finished ? "not_labeled" : "open_job"] }
  const reasons = []
  if (used.length < keys.length) reasons.push("partial")
  if (used.some((key) => labels.sharedLabels?.has(key))) reasons.push(SHARED)
  return { reasons }
}

// The bursts of active spans in the window, broken by idle gaps and operator turns (see the header).
function burstSpans(active, turns) {
  const cuts = turns.map((turn) => turn.at_ms).sort((left, right) => left - right)
  const pieces = active.flatMap(([start, end]) => {
    const inside = cuts.filter((at) => at > start && at < end)
    const points = [start, ...inside, end]
    return points.slice(1).map((to, index) => [points[index], to])
  })
  const bursts = []
  for (const [start, end] of pieces) {
    const last = bursts.at(-1)
    // An operator turn from the moment the last work stopped up to this work's start opens a new burst.
    const turnBetween = last !== undefined && cuts.some((at) => at >= last.end_ms && at <= start)
    if (last === undefined || start - last.end_ms >= BURST_IDLE_GAP_MS || turnBetween) bursts.push({ start_ms: start, end_ms: end, spans: [[start, end]] })
    else {
      last.end_ms = end
      last.spans.push([start, end])
    }
  }
  return bursts
}

// The first burst whose span holds `at`, ends included, or -1.
function burstAt(bursts, at) {
  return bursts.findIndex((burst) => burst.start_ms <= at && at <= burst.end_ms)
}

// The burst a turn belongs to: the one it falls in or the next one it comes before (a turn at a split starts the later burst); -1 after
// the last.
function burstOfTurn(bursts, at) {
  return bursts.findIndex((burst) => at < burst.end_ms)
}

// Spans of the job's corrected stretches that pass `test`, merged across sessions and clipped to the window.
function stretchSpans(stretches, test, window) {
  return clip(spansOf(stretches.filter(test)), window.start_ms, window.end_ms)
}

const isClass = (name) => (stretch) => stretch.class === name
const isWaste = (waste) => (stretch) => (waste === UNKNOWN_LABEL ? stretch.class === UNKNOWN_LABEL : stretch.class === "muda" && stretch.waste === waste)
const isWaiting = isWaste("waiting")
// The only unlabeled stretches are the parts the correction split off (`reason: "agents_working"`).
const isAgentsWorking = (stretch) => stretch.class === UNLABELED_CLASS

/**
 * The job's working time on the job clock: each session's active intervals less that session's labeled waiting (the time its evaluator
 * found the work stopped, after the honest correction) and its ask-tool waits (`askIdle`: the agent was waiting on the operator's answer),
 * merged across sessions, so one session's wait never hides another's work.
 */
function workingSpans(timeline, stretches) {
  const bySession = new Map()
  for (const interval of timeline.intervals) {
    if (!ACTIVE_KINDS.has(interval.kind)) continue
    const key = `${interval.host}/${interval.session_id}`
    bySession.set(key, [...(bySession.get(key) ?? []), interval])
  }
  const asked = askIdle(timeline)
  return spansOf([...bySession.entries()].flatMap(([key, intervals]) => subtract(spansOf(intervals), spansOf([...stretches.filter((stretch) => isWaiting(stretch) && `${stretch.host}/${stretch.session}` === key), ...(asked.get(key) ?? [])]))))
}

/**
 * What the job's sessions did for other jobs, on the job clock: `other`, the active time (turn, tool and subagent intervals) another job's
 * binding of the session holds and none of this job's does, and `unattributed`, the active time no binding of the session holds. A
 * session the job clock cannot place gives neither. Only the time is kept: no other job is named.
 */
export function sessionAttribution(timeline) {
  const other = []
  const unattributed = []
  timeline.sessions.forEach((placed, index) => {
    if (placed.offset_ms === null) return
    const source = timeline.source_sessions[index]
    const inside = { intervals: source.intervals.filter((interval) => ACTIVE_KINDS.has(interval.kind) && intervalInSession(interval.start_ms, interval.end_ms, source.session.duration_ms)) }
    const held = (bindings) => union(bindings.flatMap((binding) => boundIntervals(inside, binding)))
    const own = held(source.jobs.filter((binding) => binding.job === timeline.job))
    const others = held(source.jobs.filter((binding) => binding.job !== timeline.job))
    const shift = (spans) => spans.map(([start, end]) => [start + placed.offset_ms, end + placed.offset_ms])
    other.push(...shift(subtract(others, own)))
    unattributed.push(...shift(subtract(subtract(union(inside.intervals), own), others)))
  })
  return { other: spansOf(other), unattributed: spansOf(unattributed) }
}

/**
 * What each idle moment in [start, end] waited on, as disjoint merged spans per `IDLE_WAITED_ON` cause (see the header): before any session
 * of the job, no session running, then a labeled wait's `waited_on` or the facts' own `human_wait` (`next_prompt`) and `api_retry`
 * intervals, then a session of the job working for another job (`other_task`), each moment to the first cause in that order, and the
 * rest `unknown`. `unattributed` is the part of `unknown` during which a session of the job did work no binding holds.
 */
function idleCauses(start, end, working, sessions, stretches, intervals, attribution) {
  const idle = subtract([[start, end]], working)
  const outside = subtract(idle, sessions.spans)
  const queue = clip(outside, start, sessions.first)
  const sources = new Map([
    ["queue_before_start", queue],
    ["no_session", subtract(outside, queue)],
  ])
  const evidence = { next_prompt: "human_wait", api_retry: "api_retry" }
  for (const cause of ["next_prompt", "api_retry", "tool_failure", "long_tool_call"]) {
    const labeled = stretches.filter((stretch) => isWaiting(stretch) && stretch.waited_on === cause)
    const facts = intervals.filter((interval) => interval.kind === evidence[cause])
    sources.set(cause, spansOf([...labeled, ...facts]))
  }
  sources.set("other_task", attribution.other)
  sources.set("unknown", [[start, end]])
  let taken = []
  const out = {}
  for (const cause of IDLE_WAITED_ON) {
    const spans = subtract(clip(spansOf(sources.get(cause)), start, end).flatMap(([from, to]) => clip(idle, from, to)), taken)
    out[cause] = spans
    taken = spansOf([...taken, ...spans])
  }
  out.unattributed = attribution.unattributed.flatMap(([from, to]) => clip(out.unknown, from, to))
  return out
}

// The idle causes (and their unattributed part) inside [start, end].
const idleWithin = (idle, start, end) => Object.fromEntries(Object.entries(idle).map(([cause, spans]) => [cause, clip(spans, start, end)]))

/**
 * `jobWalk({ timeline, formulas, additions }, labels, finished) -> walk`: everything the walk derives for one job: the lead window, its
 * working and idle time, its bursts and gaps (for `jobs/<job>.json`), its stack-up row and its compact answer. `additions` is
 * `timelineAdditions`' result, `labels` is `resolveLabels`' result and `finished` the job record's own reading.
 */
export function jobWalk({ timeline, formulas, additions }, labels, finished) {
  const window = leadWindow(timeline, formulas)
  const hasWindow = Object.hasOwn(window, "start_ms")
  const stretches = jobStretches(timeline, labels)
  const sessions = sessionSpans(timeline)
  const coverage = labelState(timeline, labels, finished)
  const intervals = coverageOfResult(formulas.active_time_ms)
  // A turn outside the lead window belongs to no burst.
  const turns = hasWindow ? additions.human_turns.filter((turn) => turn.at_ms >= window.start_ms && turn.at_ms <= window.end_ms) : additions.human_turns
  const placement = sessions.unplaced ? ["job_offsets_unavailable"] : []
  const allWorking = workingSpans(timeline, stretches)
  const working = hasWindow ? clip(allWorking, window.start_ms, window.end_ms) : allWorking
  const raw = burstSpans(working, turns)
  // Without a lead window idle time is read only between the first and last burst.
  const [start, end] = hasWindow ? [window.start_ms, window.end_ms] : [raw.at(0)?.start_ms ?? 0, raw.at(-1)?.end_ms ?? 0]
  const idle = idleCauses(start, end, working, sessions, stretches, timeline.intervals, sessionAttribution(timeline))
  const walk = { job: timeline.job, window, stretches, coverage, intervals, working, idle }
  // The task's own next-prompt figure, as `waiting_by_waited_on_ms.next_prompt` states it: the waits are its parts.
  const nextPrompt = hasWindow ? idleFigures(idle, { base: window.reasons, coverage, intervals, placement }).next_prompt : figure("unavailable", null, window.reasons)
  const held = waitsHeld(jobWaits(timeline), idle.next_prompt, nextPrompt, stopClassifier(timeline, labels))
  walk.waits = held.waits
  walk.waits_state = listState(nextPrompt)
  walk.next_prompt_unheld_ms = held.unheld_ms
  // Each wait's next-prompt time by its why, and the time no wait holds, as merged spans (see `waitsHeld`).
  walk.why_parts = held.parts
  const counts = burstCounts(raw, timeline, turns, additions)
  const context = { timeline, stretches, coverage, labels, formulas, additions, idle, intervals, placement, parts: held.parts }
  walk.bursts = raw.map((burst, index) => burstEntry(burst, counts[index], context))
  walk.bursts_state = { state: Object.hasOwn(intervals, "unavailable") ? "unavailable" : intervals.reasons.length === 0 ? "measured" : "partial", reasons: sortedUnique(intervals.unavailable ?? intervals.reasons) }
  const edges = [start, ...raw.flatMap((burst) => [burst.start_ms, burst.end_ms]), end]
  walk.gaps = []
  for (let index = 0; index + 1 < edges.length; index += 2) {
    const [from, to] = [edges[index], edges[index + 1]]
    if (to <= from) continue
    const waitedOn = mostTime(IDLE_WAITED_ON, new Map(IDLE_WAITED_ON.map((cause) => [cause, within(idle[cause], from, to)])))
    // The split of the whole gap by cause, stated as the task's split is, so a gap that holds several causes is exact; its next-prompt
    // part split again by why, stated as that part is.
    const byCause = idleFigures(idleWithin(idle, from, to), { base: [], coverage, intervals, placement })
    walk.gaps.push({ start_ms: from, end_ms: to, waited_on: waitedOn, idle_by_waited_on_ms: byCause, idle_by_why_ms: whySplit(held.parts, from, to, byCause.next_prompt).by_why })
  }
  walk.finished_on = finishedOn(timeline, formulas)
  walk.human_turns_state = turnsListState(timeline, additions)
  // The formulas' coverage of the job's public pull requests, with the list's own count.
  const prs = formulas.references.parts.public_prs
  walk.prs_state = bounded(figure(prs.state, additions.prs.length, prs.reasons, "measured"), "list")
  walk.stackup = stackupRow({ timeline, formulas, window, stretches, coverage, placement, intervals, working, idle, labels, walk })
  walk.task = taskRow({ timeline, formulas, window, stretches, coverage, placement, intervals, working, idle, labels, walk })
  return walk
}

// A figure's state as a list states it (`waits_state`, like `bursts_state`): its state, reasons and, when partial, its bound.
function listState(number) {
  const out = { state: number.state, reasons: number.reasons }
  if (Object.hasOwn(number, "bound")) out.bound = number.bound
  if (Object.hasOwn(number, "bound_reason")) out.bound_reason = number.bound_reason
  return out
}

/**
 * `stopClassifier(timeline, labels) -> (wait) -> { why, why_source, confidence, reason }`: why the agent stopped before `wait` (a
 * `jobWaits` entry), first match wins:
 *   - a rule, when the wait's `stop.end` is one `STOP_RULES` decides (`why_source: "rule"`, high confidence);
 *   - not known, `outside_own_share`, when the facts do not say which part of the session was the task's (`ownShare`), so no evaluator
 *     judges the wait for it;
 *   - the evaluator's stop label whose `wait` is exactly the whole `human_wait` interval the entry is part of (`range`), from the session's
 *     used labels (`resolveLabels` leaves out a stop label that no longer matches its facts): its class and confidence, or not known,
 *     `could_not_tell`, for its `unknown`;
 *   - not known, `not_in_published_facts`, for a wait of older facts, which carry no stop;
 *   - otherwise not known, `not_labeled`.
 * `reason` is `null` for a class.
 */
function stopClassifier(timeline, labels) {
  const sessions = new Map()
  timeline.source_sessions.forEach((session) => {
    const used = labels.byJobSession.get(`${timeline.job}/${session.session.id}`)
    const stops = new Map((used?.stops ?? []).map((stop) => [`${stop.wait[0]}:${stop.wait[1]}`, stop]))
    sessions.set(`${session.session.host}/${session.session.id}`, { shareKnown: ownShare(session, timeline.job) !== null, stops })
  })
  const notKnown = (reason, source = "none", confidence = null) => ({ why: NOT_KNOWN, why_source: source, confidence, reason })
  return (wait) => {
    if (wait.stop !== null && Object.hasOwn(STOP_RULES, wait.stop.end)) return { why: STOP_RULES[wait.stop.end], why_source: "rule", confidence: RULE_CONFIDENCE, reason: null }
    const session = sessions.get(`${wait.host}/${wait.session}`)
    if (!session.shareKnown) return notKnown("outside_own_share")
    const label = session.stops.get(`${wait.range[0]}:${wait.range[1]}`)
    if (label !== undefined) return label.why === STOP_UNKNOWN ? notKnown("could_not_tell", "evaluator", label.confidence) : { why: label.why, why_source: "evaluator", confidence: label.confidence, reason: null }
    return notKnown(wait.stop === null ? "not_in_published_facts" : "not_labeled")
  }
}

// The key of a wait's next-prompt time in the split's parts: its class, or `not_known:<reason>`.
const partKey = (why, reason) => (reason === null ? why : `${NOT_KNOWN}:${reason}`)

/**
 * Each wait (`jobWaits`) as `timeline.waits` publishes it, `{ host, session, worker, start_ms, end_ms, next_prompt_ms, stop, why,
 * why_source, confidence, reasons }`, with the why `classify` gives it (`stopClassifier`) and `next_prompt_ms`, the idle `next_prompt`
 * time inside the lead window it holds. A moment two waits hold (concurrent sessions) goes to the first in start order, so the waits'
 * times plus `unheld_ms`, the `next_prompt` time no wait holds, are the task's `next_prompt` waiting exactly. Only a labeled wait that
 * runs past every human wait holds time no wait holds, since every worker's `human_wait` is listed. `reasons` holds the why's reason when
 * it is not known. When the task's figure (`number`, `waiting_by_waited_on_ms.next_prompt`) is unavailable, as it is without a lead window
 * or with unreadable intervals, no wait has a number: `next_prompt_ms` is `null` and the wait's reasons gain the figure's. A partial figure
 * keeps each wait's share; the list's `waits_state` carries its state and bound. `parts` maps each class, and each `not_known:<reason>`
 * (the time no wait holds as `not_known:stop_not_recorded`), to the merged spans of next-prompt time it holds, whatever the figure's state,
 * so each gap and burst can split its own next-prompt time.
 */
function waitsHeld(waits, nextPrompt, number, classify) {
  const unavailable = number.state === "unavailable"
  const pieces = new Map()
  const add = (key, spans) => pieces.set(key, [...(pieces.get(key) ?? []), ...spans])
  let taken = []
  const out = waits.map((wait) => {
    const mine = subtract(clip(nextPrompt, wait.start_ms, wait.end_ms), taken)
    taken = spansOf([...taken, ...mine])
    const why = classify(wait)
    add(partKey(why.why, why.reason), mine)
    const own = why.reason === null ? [] : [why.reason]
    return {
      host: wait.host,
      session: wait.session,
      worker: wait.worker,
      start_ms: wait.start_ms,
      end_ms: wait.end_ms,
      next_prompt_ms: unavailable ? null : duration(mine),
      stop: wait.stop,
      why: why.why,
      why_source: why.why_source,
      confidence: why.confidence,
      reasons: unavailable ? sortedUnique([...own, ...number.reasons]) : own,
    }
  })
  const unheld = subtract(nextPrompt, spansOf(waits))
  add(partKey(NOT_KNOWN, "stop_not_recorded"), unheld)
  const parts = new Map([...pieces.entries()].map(([key, spans]) => [key, spansOf(spans)]))
  return { waits: out, unheld_ms: unavailable ? null : duration(unheld), parts }
}

/**
 * `whySplit(parts, from, to, number) -> { by_why, by_reason }`: the next-prompt time in [from, to] by why (`WHY_SPLIT`) and its not-known
 * part by reason (`NOT_KNOWN_REASONS`), each a figure stated as `number` (that span's next-prompt figure) is, so the parts never claim more
 * than it: unavailable with its reasons when it is, else with its state, reasons and bound. While any of the time is not known, each class
 * is also partial, a lower bound (`stop_partly_classified`); the not-known figures are exact parts of `number`. The values add up to
 * `number`'s.
 */
function whySplit(parts, from, to, number) {
  if (number.state === "unavailable") {
    const none = figure("unavailable", null, number.reasons)
    return { by_why: Object.fromEntries(WHY_SPLIT.map((why) => [why, none])), by_reason: Object.fromEntries(NOT_KNOWN_REASONS.map((reason) => [reason, none])) }
  }
  const time = (key) => within(parts.get(key) ?? [], from, to)
  const reasonTimes = NOT_KNOWN_REASONS.map((reason) => [reason, time(partKey(NOT_KNOWN, reason))])
  const unknown = reasonTimes.reduce((total, [, value]) => total + value, 0)
  const part = (value) => bounded(figure(number.state, value, number.reasons), "evidence")
  const classReasons = [...number.reasons, ...(unknown > 0 ? [PARTLY_CLASSIFIED] : [])]
  const classFigure = (value) => bounded(figure(classReasons.length === 0 ? "measured" : "partial", value, classReasons), "why")
  return {
    by_why: { ...Object.fromEntries(WHY_CLASSES.map((why) => [why, classFigure(time(why))])), [NOT_KNOWN]: part(unknown) },
    by_reason: Object.fromEntries(reasonTimes.map(([reason, value]) => [reason, part(value)])),
  }
}

// The why holding most of a gap's next-prompt time, ties to the first in `WHY_SPLIT`.
function gapWhy(parts, from, to) {
  const times = new Map(WHY_CLASSES.map((why) => [why, within(parts.get(why) ?? [], from, to)]))
  times.set(NOT_KNOWN, NOT_KNOWN_REASONS.reduce((total, reason) => total + within(parts.get(partKey(NOT_KNOWN, reason)) ?? [], from, to), 0))
  return mostTime(WHY_SPLIT, times)
}

const TERMINAL = new Set(["done", "cancelled"])

/**
 * `finishedOn(timeline, formulas) -> envelope`: the UTC day the task finished, `{ class, state, value, basis, reasons }` with `bound` when
 * partial, read from each session's published `finished_on` (facts `/4`). Only a task whose status is `done` or `cancelled` has one. A day
 * from a session's own transition (`basis: "transition"`) is measured and outranks a day from the card's last update (`card_updated`),
 * which is an upper bound (`finish_from_card_update`) because a card can be edited after the task is done. When sessions moved the card to
 * its end on different days (a reopened task), the latest wins, with the reason `reopened`. Unavailable, with `basis: null`, for an open
 * task (`open_job`), a status not recorded (`status_unavailable`), a public desk (`job_offsets_withheld`), a session whose job clock
 * could not be read (`job_offsets_unavailable`), or older facts and sessions that did not see the card end, so the published facts carry
 * no day (`not_in_published_facts`).
 */
function finishedOn(timeline, formulas) {
  const none = (reasons) => ({ ...figure("unavailable", null, reasons), basis: null })
  if (formulas.status.state === "unavailable") return none(["status_unavailable"])
  if (!TERMINAL.has(formulas.status.value)) return none(["open_job"])
  const bindings = timeline.source_sessions.map((session) => ({ session, binding: session.jobs.find((candidate) => candidate.job === timeline.job) }))
  const days = bindings.filter(({ binding }) => typeof binding.finished_on === "string").map(({ binding }) => ({ day: binding.finished_on, basis: binding.finished_basis }))
  if (days.length === 0) {
    // A `/4` session that read the job clock but did not see the card end publishes no day for its own part, so it names no reason.
    const reasons = bindings.flatMap(({ session, binding }) => {
      if (session.unavailable.some((entry) => entry.field === "job_offsets" && entry.reason === "desk_public")) return ["job_offsets_withheld"]
      if (!Object.hasOwn(binding, "finished_on")) return ["not_in_published_facts"]
      if (binding.session_offset_ms === null) return ["job_offsets_unavailable"]
      return []
    })
    return none(reasons.length > 0 ? reasons : ["not_in_published_facts"])
  }
  const moved = days.filter((entry) => entry.basis === "transition")
  const chosen = moved.length > 0 ? moved : days
  const value = chosen.map((entry) => entry.day).sort(compareText).at(-1)
  const reasons = [...(moved.length === 0 ? ["finish_from_card_update"] : []), ...(new Set(moved.map((entry) => entry.day)).size > 1 ? ["reopened"] : [])]
  const basis = moved.length > 0 ? "transition" : "card_updated"
  return { ...bounded(figure(reasons.length === 0 ? "measured" : "partial", value, reasons, moved.length > 0 ? "measured" : "declared"), "finish"), basis }
}

const flagsOf = (session, field) => session.unavailable.filter((entry) => entry.field === field).map((entry) => entry.reason)

/**
 * The list state of the job's operator prompts (`human_turns_state`): how whole `human_turns` is, so a task with none recorded never reads
 * as having had none. Each session either gives its list, with the host's own flags on it (`host_records_partly`, `capped`,
 * `log_truncated`, ...), or gives none: a public desk (`desk_public`), a session the job clock cannot place (`job_offsets_unavailable`), no
 * list (the host's flag, such as `host_does_not_record`, or `not_in_published_facts` for older facts) or no segments to place the turns on
 * (`no_segments`). Unavailable when no session gives a list, partial (a lower bound) when some do not or a list is flagged.
 */
function turnsListState(timeline, additions) {
  const parts = timeline.source_sessions.map((session, index) => {
    if (session.unavailable.some((entry) => entry.field === "job_offsets" && entry.reason === "desk_public")) return { lacking: ["desk_public"] }
    if (timeline.sessions[index].offset_ms === null) return { lacking: ["job_offsets_unavailable"] }
    const flags = flagsOf(session, "human_turns")
    if (!Array.isArray(session.human_turns)) return { lacking: flags.length > 0 ? flags : ["not_in_published_facts"] }
    const binding = session.jobs.find((candidate) => candidate.job === timeline.job)
    if (!Array.isArray(binding.segments) || binding.segments.length === 0) return { lacking: ["no_segments"] }
    return { flags }
  })
  const reasons = parts.flatMap((part) => part.lacking ?? part.flags)
  if (parts.every((part) => Object.hasOwn(part, "lacking"))) return figure("unavailable", null, reasons)
  return bounded(figure(reasons.length === 0 ? "measured" : "partial", additions.human_turns.length, reasons, "measured"), "list")
}

// What each burst holds, counted once each: its sessions and workers (every interval it overlaps), its tool calls (each in the burst
// where it starts, or the first burst when it starts before them), its operator turns and its timed pull requests.
function burstCounts(raw, timeline, turns, additions) {
  const counts = raw.map(() => ({ sessions: new Set(), agents: new Set(), tools: 0, failures: 0, turns: 0, prs: 0 }))
  for (const interval of timeline.intervals) {
    if (!ACTIVE_KINDS.has(interval.kind)) continue
    raw.forEach((burst, index) => {
      if (interval.start_ms >= burst.end_ms || interval.end_ms <= burst.start_ms) return
      counts[index].sessions.add(interval.session_id)
      counts[index].agents.add(`${interval.host}/${interval.session_id}/${interval.agent}`)
      // A tool call counts in the burst where it starts; one that starts before every burst counts in the first.
      const at = Math.max(interval.start_ms, raw[0].start_ms)
      if (interval.kind !== "tool" || at < burst.start_ms) return
      counts[index].tools += 1
      if (interval.outcome !== "ok") counts[index].failures += 1
    })
  }
  for (const turn of turns) {
    const index = burstOfTurn(raw, turn.at_ms)
    if (index >= 0) counts[index].turns += 1
  }
  for (const pr of additions.prs) {
    if (!Object.hasOwn(pr, "at_ms")) continue
    const index = burstAt(raw, pr.at_ms)
    if (index >= 0) counts[index].prs += 1
  }
  return counts
}

// The labels' coverage of one burst's sessions: none labeled is unavailable (`not_labeled`), some is partial.
function burstLabels(sessions, { timeline, coverage, labels }) {
  if (Object.hasOwn(coverage, "unavailable")) return coverage
  const keys = sessions.map((session) => `${timeline.job}/${session}`)
  const used = keys.filter((key) => labels.byJobSession.has(key))
  if (used.length === 0) return { unavailable: ["not_labeled"] }
  const reasons = []
  if (used.length < keys.length) reasons.push("partial")
  if (used.some((key) => labels.sharedLabels?.has(key))) reasons.push(SHARED)
  return { reasons }
}

// The coverage of a burst's operator turn count: the formulas' `attention` state and reasons, less `turn_not_estimable`, which says a
// turn's attention could not be estimated, not that the turn is missing.
function turnCoverage(attention) {
  const reasons = attention.reasons.filter((reason) => reason !== "turn_not_estimable")
  if (attention.state === "unavailable" && reasons.length > 0) return { unavailable: reasons }
  return { reasons }
}

// The coverage of a burst's timed pull request count beyond the job's pull request list's own: none or only part when some carry no time.
function prTimes({ timeline, additions }) {
  const unplaced = new Set(timeline.sessions.filter((session) => session.offset_ms === null).map((session) => session.id))
  const untimed = additions.prs.filter((pr) => !Object.hasOwn(pr, "at_ms"))
  const why = untimed.map((pr) => (unplaced.has(pr.session) ? "job_offsets_unavailable" : "not_in_published_facts"))
  if (untimed.length > 0 && untimed.length === additions.prs.length) return { unavailable: why }
  return { reasons: why }
}

function burstEntry(burst, count, context) {
  const { stretches } = context
  const value = stretchSpans(stretches, isClass("value"), burst).flatMap(([from, to]) => clip(burst.spans, from, to))
  const defects = stretches.filter((stretch) => isWaste("defects")(stretch) && stretch.start_ms < burst.end_ms && stretch.end_ms > burst.start_ms)
  const sessions = [...count.sessions].sort(compareText)
  const labeled = burstLabels(sessions, context)
  const working = duration(burst.spans)
  // The idle time inside the burst by the same causes as the task's split, stated as the task's are.
  const idle = idleFigures(idleWithin(context.idle, burst.start_ms, burst.end_ms), { base: [], coverage: context.coverage, intervals: context.intervals, placement: context.placement })
  return {
    start_ms: burst.start_ms,
    end_ms: burst.end_ms,
    working_ms: working,
    idle_ms: burst.end_ms - burst.start_ms - working,
    idle_by_waited_on_ms: idle,
    // Its next-prompt part by why, stated as that part is.
    idle_by_why_ms: whySplit(context.parts, burst.start_ms, burst.end_ms, idle.next_prompt).by_why,
    sessions,
    agents: count.agents.size,
    tool_calls: count.tools,
    tool_failures: count.failures,
    operator_turns: covered(count.turns, [], turnCoverage(context.formulas.attention)),
    prs: covered(count.prs, [], coverageOfResult(context.formulas.references), prTimes(context)),
    value_ms: covered(duration(value), [], labeled),
    defect_ms: covered(within(spansOf(defects), burst.start_ms, burst.end_ms), [], labeled),
    defect_stretches: covered(new Set(defects.map((stretch) => stretch.source)).size, [], labeled),
  }
}

// The working time each labeled segment holds, overlaps given by precedence (see the header), and the working time no label covers.
function workingSegments(stretches, window, working) {
  const order = [
    ...STACKUP_CLASSES.map((name) => [name, isClass(name)]),
    ...WORKING_WASTES.map((waste) => [waste, isWaste(waste)]),
    ["agents_working", isAgentsWorking],
  ]
  let taken = []
  const times = {}
  const spans = {}
  for (const [name, test] of order) {
    const placed = subtract(stretchSpans(stretches, test, window), taken).flatMap(([start, end]) => clip(working, start, end))
    times[name] = duration(placed)
    spans[name] = placed
    taken = spansOf([...taken, ...placed])
  }
  return { times, spans, not_labeled: duration(working) - duration(taken) }
}

// A labels coverage that, when the job has no labels, only notes it: figures the labels refine but do not need.
const refinedBy = (coverage) => (Object.hasOwn(coverage, "unavailable") ? { reasons: [] } : coverage)

// The kind of figure each idle cause is, for its bound (`BOUND_DIRECTIONS`).
const IDLE_KIND = Object.freeze({ queue_before_start: "placement", no_session: "placement", other_task: "other_task", unknown: "unknown" })

// Each idle cause as a figure, with its bound: before and outside sessions need placement, labeled causes need the labels, another job's
// work needs placement too, and `other_task` and `unknown` are partial (`session_work_unattributed`) when some of the unknown time had a
// session of the job doing work no binding holds.
function idleFigures(idle, { base, coverage, intervals, placement }) {
  const unattributed = idle.unattributed.length > 0 ? ["session_work_unattributed"] : []
  return Object.fromEntries(IDLE_WAITED_ON.map((cause) => {
    const value = duration(idle[cause])
    // `other_task` cannot grow where nothing is left for it to take (see `BOUND_DIRECTIONS`).
    const room = duration(idle.unknown) + duration(idle.no_session) + duration(idle.queue_before_start)
    const kind = cause === "other_task" && room === 0 ? "other_task_capped" : IDLE_KIND[cause] ?? "evidence"
    if (cause === "queue_before_start" || cause === "no_session") return [cause, bounded(covered(value, [...base, ...placement], intervals), kind)]
    if (cause === "tool_failure" || cause === "long_tool_call") return [cause, bounded(covered(value, base, intervals, coverage), kind)]
    if (cause === "other_task") return [cause, bounded(covered(value, [...base, ...placement, ...unattributed], intervals, refinedBy(coverage)), kind)]
    if (cause === "unknown") return [cause, bounded(covered(value, [...base, ...unattributed], intervals, refinedBy(coverage)), kind)]
    return [cause, bounded(covered(value, base, intervals, refinedBy(coverage)), kind)]
  }))
}

function stackupRow({ timeline, formulas, window, stretches, coverage, placement, intervals, working, idle, walk }) {
  const row = { job: timeline.job, desk_version: pluginVersion(timeline.source_sessions), status: statusFigure(formulas), finished_on: walk.finished_on, lead_time_ms: bounded(window.lead, "lead") }
  if (!Object.hasOwn(window, "start_ms")) {
    const none = figure("unavailable", null, window.reasons)
    row.working_ms = none
    row.idle_ms = none
    row.working = {
      class_ms: Object.fromEntries(STACKUP_CLASSES.map((name) => [name, none])),
      waste_ms: Object.fromEntries(WORKING_WASTES.map((waste) => [waste, none])),
      agents_working_unlabeled_ms: none,
      not_labeled_ms: none,
    }
    row.idle = Object.fromEntries(IDLE_WAITED_ON.map((cause) => [cause, none]))
    row.next_prompt_by_why_ms = Object.fromEntries(WHY_SPLIT.map((why) => [why, none]))
    return row
  }
  const base = window.reasons
  const workingTime = duration(working)
  const segments = workingSegments(stretches, window, working)
  const labeledFigure = (value) => bounded(covered(value, base, coverage, intervals), "labeled")
  row.working_ms = bounded(covered(workingTime, base, intervals, refinedBy(coverage)), "working")
  row.idle_ms = bounded(covered(window.end_ms - window.start_ms - workingTime, base, intervals, refinedBy(coverage)), "idle")
  row.working = {
    class_ms: Object.fromEntries(STACKUP_CLASSES.map((name) => [name, labeledFigure(segments.times[name])])),
    waste_ms: Object.fromEntries(WORKING_WASTES.map((waste) => [waste, labeledFigure(segments.times[waste])])),
    agents_working_unlabeled_ms: labeledFigure(segments.times.agents_working),
    not_labeled_ms: bounded(covered(segments.not_labeled, base, intervals), "working"),
  }
  row.idle = idleFigures(idle, { base, coverage, intervals, placement })
  row.next_prompt_by_why_ms = whySplit(walk.why_parts, window.start_ms, window.end_ms, row.idle.next_prompt).by_why
  return row
}

// A status is not a quantity, so a partial one has no direction.
function statusFigure(formulas) {
  return ranked(fromResult(formulas.status))
}

/**
 * Each cause's time in a job's lead window, largest first, ties by key, with its spans on the job clock: every idle cause as
 * `waiting:<waited_on>`, and each labeled waste of working time as `<waste>:<detail>` (`causeKey`).
 */
function jobCauses(walk) {
  const { window, stretches, working, idle } = walk
  const byCause = new Map(IDLE_WAITED_ON.map((cause) => [`waiting:${cause}`, { waste: "waiting", spans: idle[cause] }]))
  for (const stretch of stretches) {
    if (stretch.class !== "muda" || isWaiting(stretch)) continue
    const key = causeKey(stretch, stretch.intervals)
    const entry = byCause.get(key) ?? { waste: stretch.waste, spans: [] }
    entry.spans = spansOf([...entry.spans, ...clip([[stretch.start_ms, stretch.end_ms]], window.start_ms, window.end_ms).flatMap(([from, to]) => clip(working, from, to))])
    byCause.set(key, entry)
  }
  return [...byCause.entries()]
    .map(([cause, entry]) => ({ cause, waste: entry.waste, spans: entry.spans, total_ms: duration(entry.spans) }))
    .filter((entry) => entry.total_ms > 0)
    .map((entry) => ({ ...entry, rank: -entry.total_ms }))
    .sort((left, right) => compareFields(left, right, ["rank", "cause"]))
    .map(({ rank, ...entry }) => entry)
}

// The parent cause the split by why divides, and its sub-causes' prefix.
const NEXT_PROMPT_CAUSE = "waiting:next_prompt"

/**
 * The job's next-prompt waiting in its lead window by why (`WHY_SPLIT`), as spans on the job clock: each class's, and the not-known
 * time's with the reasons that hold some of it. They add up to the job's `waiting:next_prompt` cause.
 */
function jobWhyCauses(walk) {
  const { window, why_parts: parts } = walk
  const clipped = (key) => clip(parts.get(key) ?? [], window.start_ms, window.end_ms)
  const unknown = NOT_KNOWN_REASONS.map((reason) => ({ reason, spans: clipped(partKey(NOT_KNOWN, reason)) })).filter((entry) => entry.spans.length > 0)
  return [
    ...WHY_CLASSES.map((why) => ({ why, spans: clipped(why), reasons: [] })),
    { why: NOT_KNOWN, spans: spansOf(unknown.flatMap((entry) => entry.spans)), reasons: unknown.map((entry) => entry.reason) },
  ]
}

function taskRow({ timeline, formulas, window, coverage, placement, intervals, working, idle, labels, walk }) {
  const row = {
    job: timeline.job,
    status: statusFigure(formulas),
    finished_on: walk.finished_on,
    lead_time_ms: bounded(window.lead, "lead"),
    labels_from_shared_session: timeline.sessions.some((session) => labels.sharedLabels?.has(`${timeline.job}/${session.id}`)),
    active_share_recorded: boundedRatio(fromResult(formulas.flow_efficiency), window.lead.reasons),
  }
  const keys = ["working_ms", "idle_ms", "value_in_working_ms", "flow_efficiency", "agents_working_unlabeled_ms", "top_causes", "longest_gap", "bursts"]
  if (!Object.hasOwn(window, "start_ms")) {
    const none = figure("unavailable", null, window.reasons)
    for (const key of keys) row[key] = none
    row.waiting_by_waited_on_ms = Object.fromEntries(IDLE_WAITED_ON.map((cause) => [cause, none]))
    row.next_prompt_by_why_ms = Object.fromEntries(WHY_SPLIT.map((why) => [why, none]))
    row.not_known_by_reason_ms = Object.fromEntries(NOT_KNOWN_REASONS.map((reason) => [reason, none]))
    return row
  }
  const base = window.reasons
  const workingTime = duration(working)
  const segments = workingSegments(walk.stretches, window, working)
  // Labeled figures that the intervals also shape (the split, waited_on and cause keys read them).
  const labeledFigure = (value) => bounded(covered(value, base, coverage, intervals), "labeled")
  row.working_ms = bounded(covered(workingTime, base, intervals, refinedBy(coverage)), "working")
  row.idle_ms = bounded(covered(window.end_ms - window.start_ms - workingTime, base, intervals, refinedBy(coverage)), "idle")
  row.value_in_working_ms = labeledFigure(segments.times.value)
  // Working time over lead time; `working_ms` already carries the lead time's reasons.
  const lead = window.end_ms - window.start_ms
  if (lead === 0) row.flow_efficiency = figure("unavailable", null, ["zero_lead_time"])
  else row.flow_efficiency = row.working_ms.state === "unavailable" ? row.working_ms : boundedRatio(known(row.working_ms.value / lead, row.working_ms.reasons), window.lead.reasons)
  row.waiting_by_waited_on_ms = idleFigures(idle, { base, coverage, intervals, placement })
  // The next-prompt waiting by why the agent stopped, and its not-known part by reason: they add up to it.
  const split = whySplit(walk.why_parts, window.start_ms, window.end_ms, row.waiting_by_waited_on_ms.next_prompt)
  row.next_prompt_by_why_ms = split.by_why
  row.not_known_by_reason_ms = split.by_reason
  row.agents_working_unlabeled_ms = labeledFigure(segments.times.agents_working)
  row.top_causes = ranked(covered(jobCauses(walk).slice(0, TOP_CAUSES).map(({ cause, total_ms: total }) => ({ cause, total_ms: total, hours: total / MS_PER_HOUR })), base, coverage, intervals))
  const longest = [...walk.gaps].sort((left, right) => (right.end_ms - right.start_ms) - (left.end_ms - left.start_ms) || left.start_ms - right.start_ms)[0]
  // Its bound is its length's, an idle time.
  row.longest_gap = longest === undefined ? figure("unavailable", null, ["no_wait_intervals"]) : bounded(covered({ start_ms: longest.start_ms, end_ms: longest.end_ms, duration_ms: longest.end_ms - longest.start_ms, waited_on: longest.waited_on, why: longest.waited_on === "next_prompt" ? gapWhy(walk.why_parts, longest.start_ms, longest.end_ms) : null }, base, intervals), "idle")
  row.bursts = bounded(covered(walk.bursts.length, base, intervals), "count")
  return row
}

/** `stackupRollup(walks) -> document`: `rollups/stackup.json`, one row per job, by job ID: working time by label and idle time by cause. */
export function stackupRollup(walks) {
  return {
    schema: ROLLUPS_SCHEMA,
    basis: STACKUP_BASIS,
    burst_idle_gap_ms: BURST_IDLE_GAP_MS,
    idle_waited_on: IDLE_WAITED_ON,
    classes: STACKUP_CLASSES,
    working_wastes: WORKING_WASTES,
    // The keys of `next_prompt_by_why_ms`, in the order the page stacks them.
    why: WHY_SPLIT,
    jobs: [...walks].sort((left, right) => compareText(left.job, right.job)).map((walk) => walk.stackup),
  }
}

/** `tasksRollup(walks) -> document`: `rollups/tasks.json`, each job's compact answer, by job ID. */
export function tasksRollup(walks) {
  return { schema: ROLLUPS_SCHEMA, waited_on: IDLE_WAITED_ON, why: WHY_SPLIT, not_known_reasons: NOT_KNOWN_REASONS, jobs: [...walks].sort((left, right) => compareText(left.job, right.job)).map((walk) => walk.task) }
}

/**
 * `causesRollup({ records, walks, labels }) -> document`: `rollups/causes.json`. Sums, over every finished, fully labeled job (`records`'
 * `muda_time` counted) whose intervals are readable, each job's causes in its lead window (`jobCauses`): idle time by `waited_on` and
 * the labeled wastes of working time. A moment two jobs share counts for each (job-hours). Largest first, with the jobs that add time
 * and up to `CAUSE_REFERENCES` of the largest spans, `{ job, start_ms, end_ms }` on that job's clock.
 */
export function causesRollup({ records, walks, labels }) {
  const walkOf = new Map(walks.map((walk) => [walk.job, walk]))
  const labeled = records.filter((record) => record.measures.muda_time.state === "measured")
  const counted = labeled.filter((record) => !Object.hasOwn(walkOf.get(record.job).intervals, "unavailable") && Object.hasOwn(walkOf.get(record.job).window, "start_ms")).sort((left, right) => compareText(left.job, right.job))
  const excluded = [
    ...records.filter((record) => record.measures.muda_time.state !== "measured").map((record) => record.measures.muda_time.excluded),
    ...labeled.filter((record) => !counted.includes(record)).flatMap((record) => walkOf.get(record.job).intervals.unavailable ?? walkOf.get(record.job).window.reasons),
  ]
  const partly = counted.flatMap((record) => walkOf.get(record.job).intervals.reasons)
  const causes = new Map()
  for (const record of counted) {
    for (const entry of jobCauses(walkOf.get(record.job))) {
      const row = causes.get(entry.cause) ?? { cause: entry.cause, waste: entry.waste, total_ms: 0, jobs: new Set(), parts: [] }
      row.total_ms += entry.total_ms
      row.jobs.add(record.job)
      row.parts.push(...entry.spans.map(([start, end]) => ({ job: record.job, start_ms: start, end_ms: end })))
      causes.set(entry.cause, row)
    }
  }
  // The sub-causes of waiting for the next prompt, by why: each job's own time, as its parent's is.
  const children = new Map(WHY_SPLIT.map((why) => [why, { total_ms: 0, jobs: new Set(), parts: [], reasons: new Set() }]))
  for (const record of counted) {
    for (const entry of jobWhyCauses(walkOf.get(record.job))) {
      const child = children.get(entry.why)
      const time = duration(entry.spans)
      if (time === 0) continue
      child.total_ms += time
      child.jobs.add(record.job)
      child.parts.push(...entry.spans.map(([start, end]) => ({ job: record.job, start_ms: start, end_ms: end })))
      for (const reason of entry.reasons) child.reasons.add(reason)
    }
  }
  const rows = [...causes.values()].map((entry) => ({ ...entry, rank: -entry.total_ms })).sort((left, right) => compareFields(left, right, ["rank", "cause"]))
  const total = rows.reduce((sum, row) => sum + row.total_ms, 0)
  const references = (parts) => parts.map((part) => ({ part, rank: part.start_ms - part.end_ms, job: part.job, start_ms: part.start_ms })).sort((left, right) => compareFields(left, right, ["rank", "job", "start_ms"])).slice(0, CAUSE_REFERENCES).map((entry) => entry.part)
  // The parent row lists its sub-causes, the classes first in `WHY_SPLIT` order; they are not ranked beside it, so the ranking and its
  // total are unchanged. The not-known sub-cause names the reasons that hold its time; while it has any, each class is a lower bound.
  const unclassified = children.get(NOT_KNOWN).total_ms > 0
  const childRows = () => WHY_SPLIT.filter((why) => children.get(why).total_ms > 0).map((why) => {
    const child = children.get(why)
    return {
      cause: `${NEXT_PROMPT_CAUSE}:${why}`,
      parent: NEXT_PROMPT_CAUSE,
      waste: "waiting",
      total_ms: child.total_ms,
      hours: child.total_ms / MS_PER_HOUR,
      share: child.total_ms / total,
      jobs: [...child.jobs].sort(compareText),
      spans: references(child.parts),
      // A class's job-hours are at least this while any of its parent's time is not known; the not-known row names its reasons.
      ...(why === NOT_KNOWN ? { reasons: [...child.reasons].sort(compareText) } : unclassified ? { reasons: [PARTLY_CLASSIFIED], bound: "lower" } : { reasons: [] }),
    }
  })
  let running = 0
  // A counted job whose labels may count another job's time makes the ranking partial.
  const shared = counted.some((record) => walkOf.get(record.job).task.labels_from_shared_session)
  const whole = counted.length === records.length && !shared && partly.length === 0
  const state = counted.length === 0 ? "unavailable" : whole ? "measured" : "partial"
  const reasons = state === "measured" ? [] : counted.length === 0 && excluded.length === 0 ? ["no_finished_jobs"] : sortedUnique([...excluded, ...partly, ...(shared ? [SHARED] : [])])
  return {
    schema: ROLLUPS_SCHEMA,
    // Each job's causes are summed as that job's own time, so a moment two jobs share counts once for each.
    basis: CAUSES_BASIS,
    state,
    reasons,
    // A ranking of causes has no one direction.
    ...(state === "partial" ? { bound: null, bound_reason: BOUND_REASON.ranking } : {}),
    n: counted.length,
    N: records.length,
    references_per_cause: CAUSE_REFERENCES,
    ...(state === "unavailable" ? {} : { total_ms: total }),
    causes: rows.map((row) => {
      running += row.total_ms
      return {
        cause: row.cause,
        waste: row.waste,
        total_ms: row.total_ms,
        hours: row.total_ms / MS_PER_HOUR,
        share: row.total_ms / total,
        cumulative_share: running / total,
        jobs: [...row.jobs].sort(compareText),
        spans: references(row.parts),
        ...(row.cause === NEXT_PROMPT_CAUSE ? { children: childRows() } : {}),
      }
    }),
  }
}
