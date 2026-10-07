// The evaluator's stretches as the Lean walk reads them: what each waiting
// stretch waited on, the honest split of waiting time during which the job's
// own workers were working, and each job's stretches, workers, human turns
// and pull requests on the job clock.
//
// Rules:
//   - A stretch's evidence ranges resolve to the session's fact intervals
//     with exactly that `[start_ms, end_ms]` (the store checks that every
//     range is one); a range two intervals share resolves to both.
//   - `waited_on`, for a `waiting` stretch, comes from its evidence. Each
//     evidence interval names at most one cause: a `human_wait` is
//     `next_prompt` (the time from the agent stopping to the next prompt,
//     nights included), an `api_retry` is `api_retry`, a tool call with any
//     outcome other than `ok` (an error, a timeout, a denial or an
//     interruption) is `tool_failure`, and a successful tool call of five
//     minutes or more is `long_tool_call`. Any other interval names none.
//     When the evidence names several causes, the cause whose intervals add
//     up to the most time wins (each interval's whole length, counted once);
//     a tie goes to the cause listed first in `WAITED_ON`. Evidence that
//     names no cause is `unknown`.
//   - Honest correction: a stretch where any worker of the job is doing work
//     is not waiting. The part of a `waiting` stretch during which a worker
//     of the job (the binding's workers, the controller cut to the job's
//     segments) has a `turn` or `tool` interval is split off as its own
//     stretch with `class: "unlabeled"`, `waste: null` and
//     `reason: "agents_working"`; the rest stays `waiting`. The workers the
//     stretch's own evidence shows waiting (the workers of its cause-naming
//     intervals) are left out of that test: the tool call a worker is
//     blocked on, and the turn around it, are the wait itself, not other
//     work. So are their ancestors' intervals that hold a cause-naming
//     interval (a parent's turn around the subagent it waits on), and a
//     parent's `subagent` interval never counts: the subagent's own
//     intervals carry its work. The split reads one session's own workers: a concurrent session
//     of the same job does not split another session's wait (the stack-up
//     counts such moments once, by precedence). Existing totals keep reading
//     the labels as written; the corrected figures have their own keys.
//   - Nothing here adds a time the facts do not carry: a session without a
//     job offset (a public desk, or a card with no readable creation time)
//     places nothing on the job clock, and a pull request without `at_ms`
//     is listed with no time.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { ownerOf } from "./attention.js"
import { jobOwnsPullRequest } from "./formulas.js"
import { stableStringify } from "./normalize.js"
import { boundIntervals, union } from "./timeline.js"

/** What a `waiting` stretch waited on, in tie-break order. */
export const WAITED_ON = Object.freeze(["next_prompt", "api_retry", "tool_failure", "long_tool_call", "unknown"])

/** A successful tool call at least this long is a wait on the call (`long_tool_call`): five minutes. */
export const LONG_TOOL_CALL_MS = 5 * 60 * 1000

/** The class and reason of the part of a waiting stretch split off because a worker of the job was working. */
export const UNLABELED_CLASS = "unlabeled"
export const AGENTS_WORKING = "agents_working"

/** The finest bin a swimlane file's intervals are merged at when the file would pass its size budget; it doubles until the file fits. */
const FIRST_BIN_MS = 1000

/** Why a swimlane file is larger than its budget: binning merged every run, and the intervals its stretches cite still do not fit. */
const OVER_BUDGET = "over_budget_after_binning"

/** How many stretch references each cause in `rollups/causes.json` lists, largest first. */
export const CAUSE_REFERENCES = 10

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

/** Orders two entries by the named fields in turn, each compared as a number or as text. */
export function compareFields(left, right, fields) {
  for (const field of fields) {
    const order = compareText(left[field], right[field])
    if (order !== 0) return order
  }
  return 0
}

function bindingOf(session, job) {
  return session.jobs.find((binding) => binding.job === job)
}

/** `evidenceIntervals(session, ranges)`: the fact intervals each `[start_ms, end_ms]` range names, in the session's interval order, each once. */
export function evidenceIntervals(session, ranges) {
  const byRange = rangeIndex(session)
  const wanted = new Set(ranges.map(([start, end]) => `${start}:${end}`))
  return [...wanted].flatMap((key) => byRange.get(key) ?? []).sort((left, right) => left.position - right.position).map((entry) => entry.interval)
}

// Each session's intervals by `start:end`, with their positions, built once per session object.
const RANGE_INDEX = new WeakMap()
function rangeIndex(session) {
  let index = RANGE_INDEX.get(session)
  if (index === undefined) {
    index = new Map()
    session.intervals.forEach((interval, position) => {
      const key = `${interval.start_ms}:${interval.end_ms}`
      index.set(key, [...(index.get(key) ?? []), { interval, position }])
    })
    RANGE_INDEX.set(session, index)
  }
  return index
}

/** The cause one evidence interval names, or `null` when it names none. */
function waitCauseOf(interval) {
  if (interval.kind === "human_wait") return "next_prompt"
  if (interval.kind === "api_retry") return "api_retry"
  if (interval.kind !== "tool") return null
  if (interval.outcome !== "ok") return "tool_failure"
  return interval.end_ms - interval.start_ms >= LONG_TOOL_CALL_MS ? "long_tool_call" : null
}

/**
 * `waitedOn(intervals) -> cause`: the cause whose evidence intervals add up to the most time; a tie goes to the cause listed first in
 * `WAITED_ON`, and evidence that names no cause is `unknown`.
 */
export function waitedOn(intervals) {
  const time = new Map()
  for (const interval of intervals) {
    const cause = waitCauseOf(interval)
    if (cause !== null) time.set(cause, (time.get(cause) ?? 0) + interval.end_ms - interval.start_ms)
  }
  return mostTime(WAITED_ON, time)
}

/** The first of `order` with the most time in `time` (a `Map`), or `unknown` when none has any. */
export function mostTime(order, time) {
  let best = "unknown"
  let most = 0
  for (const cause of order) {
    if (time.get(cause) > most) {
      best = cause
      most = time.get(cause)
    }
  }
  return best
}

/** The failed tool kind a `defects` stretch rests on most (by time, then by name), or `all` when its evidence holds no failed tool call. */
function failingToolOf(intervals) {
  const time = new Map()
  for (const interval of intervals) {
    if (interval.kind === "tool" && interval.outcome !== "ok") time.set(interval.tool, (time.get(interval.tool) ?? 0) + interval.end_ms - interval.start_ms)
  }
  const ranked = [...time.entries()].map(([tool, ms]) => ({ tool, rank: -ms })).sort((left, right) => compareFields(left, right, ["rank", "tool"]))
  return ranked.length === 0 ? "all" : ranked[0].tool
}

/** A corrected muda stretch's cause key, `<waste>:<waited_on, failing tool kind or "all">`, from its resolved evidence. */
export function causeKey(stretch, intervals) {
  if (stretch.waste === "waiting") return `waiting:${stretch.waited_on}`
  if (stretch.waste === "defects") return `defects:${failingToolOf(intervals)}`
  return `${stretch.waste}:all`
}

// The parts of [start, end) inside and outside the merged spans (each of which overlaps it), as [start, end] pairs in order.
function splitBySpans(start, end, spans) {
  const inside = []
  const outside = []
  let from = start
  for (const [spanStart, spanEnd] of spans) {
    if (spanStart > from) outside.push([from, spanStart])
    const to = Math.min(spanEnd, end)
    inside.push([Math.max(spanStart, from), to])
    from = to
  }
  if (from < end) outside.push([from, end])
  return { inside, outside }
}

// What counts as a worker doing work in the split: its own turns and tool calls. A parent's `subagent` interval only stands for the
// subagent's work, which the subagent's own intervals carry.
const WORK_KINDS = new Set(["turn", "tool"])

// Whether worker `ancestor` is a parent, grandparent or further up of worker `worker` (`parentOf` maps a worker to its parent).
function ancestorOf(parentOf, ancestor, worker) {
  const seen = new Set()
  for (let at = parentOf.get(worker); at !== null && at !== undefined && !seen.has(at); at = parentOf.get(at)) {
    if (at === ancestor) return true
    seen.add(at)
  }
  return false
}

// Keeps the stretch's original label on a part, for counting stretches and flags once each (not enumerable, so it is never written out).
function piece(stretch, fields, source) {
  const part = { ...stretch, ...fields }
  Object.defineProperty(part, "source", { value: source, enumerable: false })
  return part
}

/**
 * `correctStretches(stretches, session, binding) -> stretches`: the job's stretches of one session (on the session clock, already cut to
 * the job's share) with every `waiting` stretch given its `waited_on` and split where a worker of the job was working (see the header).
 * Every other stretch is returned as it is. Each returned part keeps the label it came from as a non-enumerable `source`.
 */
export function correctStretches(stretches, session, binding) {
  const bound = boundIntervals(session, binding).filter((interval) => WORK_KINDS.has(interval.kind))
  const parentOf = new Map(session.agents.map((agent) => [agent.n, agent.parent]))
  return stretches.flatMap((stretch) => {
    if (stretch.class !== "muda" || stretch.waste !== "waiting") return [piece(stretch, {}, stretch)]
    const evidence = evidenceIntervals(session, stretch.evidence)
    const cause = waitedOn(evidence)
    // The workers the evidence shows waiting do not count as working against their own wait. The turn that holds a long or failing
    // tool call spans the whole wait, so counting it would split away every `long_tool_call` and `tool_failure` stretch. Their
    // ancestors' turns around a cause-naming interval are the same wait one level up (a parent's turn holds the subagent it waits
    // on), so they do not count either. Only the other workers' own turns and tool calls, such as a sibling subagent running while
    // one waits, make part of a wait agent work.
    const causes = evidence.filter((interval) => waitCauseOf(interval) !== null)
    const waiting = new Set(causes.map((interval) => interval.agent))
    const enclosing = (interval) => causes.some((cause) => ancestorOf(parentOf, interval.agent, cause.agent) && interval.start_ms <= cause.start_ms && interval.end_ms >= cause.end_ms)
    const work = union(bound.filter((interval) => !waiting.has(interval.agent) && !enclosing(interval) && interval.start_ms < stretch.end_ms && interval.end_ms > stretch.start_ms))
    const { inside, outside } = splitBySpans(stretch.start_ms, stretch.end_ms, work)
    return [
      ...outside.map(([start, end]) => piece(stretch, { start_ms: start, end_ms: end, waited_on: cause }, stretch)),
      ...inside.map(([start, end]) => piece(stretch, { start_ms: start, end_ms: end, class: UNLABELED_CLASS, waste: null, reason: AGENTS_WORKING }, stretch)),
    ].sort((left, right) => left.start_ms - right.start_ms)
  })
}

// An interval as a detail file lists it, on the job clock.
function laneInterval(interval, offset) {
  const entry = { kind: interval.kind, worker: interval.agent, start_ms: offset + interval.start_ms, end_ms: offset + interval.end_ms }
  if (interval.kind === "tool") {
    entry.tool = interval.tool
    entry.outcome = interval.outcome
  }
  return entry
}

const intervalKey = (interval) => [interval.start_ms, interval.end_ms, interval.kind, interval.worker, interval.tool ?? "", interval.outcome ?? ""].join(":")

// Only tool intervals carry a tool and an outcome, and the kind is compared first, so those two are compared only between tool calls.
const LANE_ORDER = Object.freeze(["start_ms", "end_ms", "kind", "worker", "tool", "outcome"])

/**
 * `jobStretches(timeline, labels) -> stretches`: every placed session's corrected stretches (`resolveLabels`' `corrected`) on the job
 * clock, each with its `host` and `session`, in start order. Each also carries, not enumerable, its resolved `intervals` (on the
 * session clock) for cause keys. A session without a job offset places nothing.
 */
export function jobStretches(timeline, labels) {
  const out = []
  timeline.source_sessions.forEach((session, index) => {
    const offset = timeline.sessions[index].offset_ms
    const entry = labels.byJobSession.get(`${timeline.job}/${session.session.id}`)
    if (offset === null || entry === undefined) return
    for (const stretch of entry.corrected) {
      const placed = { ...stretch, host: session.session.host, session: session.session.id, start_ms: offset + stretch.start_ms, end_ms: offset + stretch.end_ms }
      Object.defineProperty(placed, "intervals", { value: evidenceIntervals(session, stretch.evidence), enumerable: false })
      Object.defineProperty(placed, "source", { value: stretch.source, enumerable: false })
      out.push(placed)
    }
  })
  return out.sort(byStart)
}

/**
 * `sessionDetail(timeline, index, labels) -> document | null`: the swimlane file of the job's `index`-th session,
 * `jobs/<job>/<session id>.json`, or `null` when the session has no job offset (nothing can be placed). Every time is on the job clock.
 *   - `intervals`: the job's lane intervals of the session (its workers, the controller cut to the job's segments, as in the job's
 *     timeline), then every interval a stretch cites that is not among them, whole and marked `evidence_only: true`, all in time order.
 *   - `stretches`: the corrected stretches (`correctStretches`), each with `evidence` as indices into `intervals`, `waited_on` on waiting
 *     stretches and `reason: "agents_working"` on the parts split off them. `labeled` says whether the session has used labels at all.
 *   - `labels_from_shared_session`: whether these labels may count another job's time (`resolveLabels`' `sharedLabels`).
 *   - When the file would be larger than `budgetBytes`, its intervals are binned: each run of a worker's intervals of one kind whose gaps
 *     are under the bin is merged into one entry `{ kind, worker, start_ms, end_ms, binned: <count> }` (no tool or outcome), the bin
 *     starting at `FIRST_BIN_MS` and doubling until the file fits or every run is merged. An interval a stretch cites is never merged, so
 *     evidence still names it exactly. A binned file says `intervals_binned: true` and `bin_resolution_ms`; one still over budget once
 *     every run is merged also says `over_budget: true` with `reasons: ["over_budget_after_binning"]`.
 */
export function sessionDetail(timeline, index, labels, budgetBytes = Infinity) {
  const session = timeline.source_sessions[index]
  const placedSession = timeline.sessions[index]
  const offset = placedSession.offset_ms
  if (offset === null) return null
  const host = session.session.host
  const id = session.session.id
  const key = `${timeline.job}/${id}`
  const entry = labels.byJobSession.get(key)
  const lane = timeline.intervals.filter((interval) => interval.host === host && interval.session_id === id).map((interval) => {
    const item = { kind: interval.kind, worker: interval.agent, start_ms: interval.start_ms, end_ms: interval.end_ms }
    if (interval.kind === "tool") {
      item.tool = interval.tool
      item.outcome = interval.outcome
    }
    return item
  })
  const known = new Set(lane.map(intervalKey))
  const cited = new Set()
  const corrected = entry === undefined ? [] : entry.corrected
  for (const stretch of corrected) {
    for (const interval of evidenceIntervals(session, stretch.evidence)) {
      const item = laneInterval(interval, offset)
      const itemKey = intervalKey(item)
      cited.add(itemKey)
      if (known.has(itemKey)) continue
      known.add(itemKey)
      lane.push({ ...item, evidence_only: true })
    }
  }
  // An evidence-only interval is never the same as a lane interval, so the order is total.
  lane.sort((left, right) => compareFields(left, right, LANE_ORDER))
  const document = (intervals) => {
    // Two identical lane intervals are one for evidence: either index names the same interval.
    const position = new Map(intervals.map((item, at) => [intervalKey(item), at]))
    return {
      job: timeline.job,
      host,
      session: id,
      offset_ms: offset,
      end_ms: placedSession.end_ms,
      labeled: entry !== undefined,
      labels_from_shared_session: labels.sharedLabels?.has(key) === true,
      intervals,
      stretches: detailStretches(corrected, { session, offset, entry, position }),
    }
  }
  const whole = document(lane)
  if (sizeOf(whole) <= budgetBytes) return whole
  let resolution = FIRST_BIN_MS
  let binned = binLane(lane, cited, resolution)
  const span = placedSession.end_ms - offset
  while (sizeOf(document(binned)) > budgetBytes && resolution <= span) {
    resolution *= 2
    binned = binLane(lane, cited, resolution)
  }
  const result = { ...document(binned), intervals_binned: true, bin_resolution_ms: resolution }
  // Cited intervals are never merged, so a file can stay over budget with every run merged: it says so rather than pass silently.
  return sizeOf(result) <= budgetBytes ? result : { ...result, over_budget: true, reasons: [OVER_BUDGET] }
}

// The bytes a document takes as a file.
const sizeOf = (value) => Buffer.byteLength(`${stableStringify(value)}\n`)

// The lane with each run of a worker's same-kind intervals whose gaps are under `resolution` merged into one `binned` entry; an interval
// in `cited` stays as it is and ends a run.
function binLane(lane, cited, resolution) {
  const groups = new Map()
  const out = []
  for (const item of lane) {
    if (cited.has(intervalKey(item))) {
      out.push(item)
      continue
    }
    const group = `${item.kind}/${item.worker}`
    const run = groups.get(group)
    if (run !== undefined && item.start_ms - run.end_ms < resolution) {
      run.end_ms = Math.max(run.end_ms, item.end_ms)
      run.items.push(item)
      continue
    }
    const next = { start_ms: item.start_ms, end_ms: item.end_ms, items: [item] }
    groups.set(group, next)
    out.push(next)
  }
  return out
    .map((entry) => {
      if (!Object.hasOwn(entry, "items")) return entry
      if (entry.items.length === 1) return entry.items[0]
      return { kind: entry.items[0].kind, worker: entry.items[0].worker, start_ms: entry.start_ms, end_ms: entry.end_ms, binned: entry.items.length }
    })
    .sort((left, right) => compareFields(left, right, LANE_ORDER))
}

// The corrected stretches as a swimlane file lists them, evidence as indices into its intervals.
function detailStretches(corrected, { session, offset, entry, position }) {
  return corrected.map((stretch) => {
    const placed = {
      start_ms: offset + stretch.start_ms,
      end_ms: offset + stretch.end_ms,
      class: stretch.class,
      waste: stretch.waste,
      confidence: stretch.confidence ?? null,
      evaluator_version: stretch.evaluator_version ?? entry.evaluator.plugin_version,
      mura: stretch.mura,
      muri: stretch.muri,
      evidence: evidenceIntervals(session, stretch.evidence).map((interval) => position.get(intervalKey(laneInterval(interval, offset)))),
    }
    if (Object.hasOwn(stretch, "waited_on")) placed.waited_on = stretch.waited_on
    if (Object.hasOwn(stretch, "reason")) placed.reason = stretch.reason
    if (Object.hasOwn(stretch, "caught")) placed.caught = stretch.caught
    return placed
  })
}

// Each pull request once: the earliest timed mention when any session times it, else the first by host and session. Timed entries come
// first, earliest first; untimed ones after, by repository and number.
function firstOfEachPr(prs) {
  const seen = new Set()
  const key = (pr) => ({ ...pr, untimed: Number(!Object.hasOwn(pr, "at_ms")), time: pr.at_ms ?? 0 })
  const order = ["untimed", "time", "repo", "number", "host", "session"]
  return [...prs].sort((left, right) => compareFields(key(left), key(right), order)).filter((pr) => {
    const key = `${pr.repo}#${pr.number}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const byStart = (left, right) => compareFields(left, right, ["start_ms", "end_ms", "host", "session"])

/**
 * `timelineAdditions(timeline) -> { agents, human_turns, prs }`: what the job's timeline adds for the Lean walk, every time on the job
 * clock. A session without a job offset places nothing; its workers and untimed pull requests are still listed.
 *   - `agents`: each session's workers the job holds, `{ host, session, n, parent }`. The worker's model and agent type stay in the
 *     session's published facts: the reports carry no token a facts file names (a model ID is one), only the facts do.
 *   - `human_turns`: the human turns whose time falls in the job's own segments (the attention formula's rule), with their basis, window
 *     and size classes.
 *   - `prs`: the job's pull requests (the formulas' ownership rule), each once, with the worker that opened it and `at_ms` only when the
 *     facts carry them (a public desk's facts withhold both).
 */
export function timelineAdditions(timeline) {
  const agents = []
  const humanTurns = []
  const prs = []
  timeline.source_sessions.forEach((session, index) => {
    const binding = bindingOf(session, timeline.job)
    const host = session.session.host
    const id = session.session.id
    const offset = timeline.sessions[index].offset_ms
    for (const agent of session.agents) {
      if (Object.hasOwn(binding, "agents") && !binding.agents.includes(agent.n)) continue
      agents.push({ host, session: id, n: agent.n, parent: agent.parent })
    }
    for (const pr of session.refs.prs) {
      if (!jobOwnsPullRequest(session, binding, pr)) continue
      const entry = { host, session: id, repo: pr.repo, number: pr.number }
      if (Object.hasOwn(pr, "agent")) entry.worker = pr.agent
      if (Object.hasOwn(pr, "at_ms") && offset !== null) entry.at_ms = offset + pr.at_ms
      prs.push(entry)
    }
    if (offset === null) return
    const segmented = session.jobs.filter((candidate) => Array.isArray(candidate.segments) && candidate.segments.length > 0)
    if (Array.isArray(session.human_turns) && segmented.length > 0) {
      for (const turn of session.human_turns) {
        if (ownerOf(segmented, turn.at_ms) !== timeline.job) continue
        humanTurns.push({ host, session: id, at_ms: offset + turn.at_ms, basis: turn.basis, window_ms: turn.window_ms, prompt_class: turn.prompt_class, output_class: turn.output_class })
      }
    }
  })
  agents.sort((left, right) => compareFields(left, right, ["host", "session", "n"]))
  humanTurns.sort((left, right) => compareFields(left, right, ["at_ms", "host", "session"]))
  return { agents, human_turns: humanTurns, prs: firstOfEachPr(prs) }
}
