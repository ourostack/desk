// Focus: which task the controller (worker 0) of one session was working on,
// moment by moment. A task is declared with `task_focus`, or, for a stretch
// with no declaration, inferred from what the session tree did. `binding.js`
// reduces the derivers' events to the small shapes below and turns the
// timeline this file returns into each job's `segments`.
//
// Pure: no I/O, no clock, no randomness, and the same answer for any order of
// the same input. Every time is epoch milliseconds, every task a `track/slug`
// key, and a segment or stretch is half-open, `[start, end)`.
//
// Input shapes.
//   - A focus call: `{ agent, at, key }`, or `{ agent, at, clear: true }` for
//     "no task". Only worker 0's calls count; a subagent's is ignored.
//   - An evidence event: `{ at, key, kind }` with `kind` one of `write` (a file
//     written under the task's folder), `tool` (a Desk task tool call naming
//     the task, other than `task_create` and a status-only `task_update`),
//     `spawn` (a brief carrying the task's `Desk-Task:` line) and `commit` (a
//     commit naming a path at or under the folder); or `{ at, repo, kind:
//     "repo" }` for work in a code repository. `at` is `null` for evidence with
//     no time: it counts toward candidacy, and toward nothing else.
//
// Declared stretches. Worker 0's calls cut the session into stretches. One
// that names a task is that task's, one that clears is no task's, and the
// stretch before the first call (or the whole of a session with no call) is
// undeclared and is inferred. Where inference picks nothing before the first
// declaration, that stretch goes to the first declared task.
//
// Inference, for one stretch, from the events inside it.
//   - A repository event counts for a card only when that card lists the
//     repository and is the only card listing it that has an event of its own.
//     A card's `owner/name` matches an event's `owner/name` exactly, ignoring
//     case. A card's bare name matches by the name part, and matches nothing
//     when the stretch holds two differently owned repositories of that name.
//   - A task is a candidate at `candidateEvents` events. In a session that
//     never declares, the only task with any events is also a candidate when
//     one of them is a write, commit or spawn.
//   - A task's episode is a maximal run of its events at most `episodeGapMs`
//     apart. It is significant at `significantEvents` events spanning
//     `significantSpanMs`, and then covers `[first, last]`.
//   - The main task is the candidate with most events that have a time, then
//     the earliest first event, then the key in byte order. Evidence with no
//     time (a native commit reference) counts toward candidacy only: it never
//     ranks a task above another and never starts, ends or extends an episode.
//   - Where significant episodes of different tasks overlap, the overlap goes
//     to the task with more events inside it, then the main task, then key
//     order. Time no significant episode covers goes to the main task.
//     Adjacent segments of one task merge.
//   - An inferred segment shorter than `minSegmentMs` then joins the longer of
//     the inferred segments beside it in the same stretch (the earlier of two
//     equals), the shortest and earliest such segment first, until none is
//     short or one segment is left. A declared stretch never takes one and is
//     never taken, whatever its length.
//   - No candidate: the stretch binds nothing.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

/** The inference thresholds, in one place so a replay can rule on them. */
export const FOCUS_RULES = Object.freeze({ candidateEvents: 3, significantEvents: 3, significantSpanMs: 600000, episodeGapMs: 1800000, minSegmentMs: 60000 })

/** A declared stretch disagrees with the evidence at this many events on another task and none on its own. */
export const DISAGREE_EVENTS = 10

// The kinds that make the only task with events a candidate on their own.
const OWN_WORK = new Set(["write", "commit", "spawn"])

/** Orders two `track/slug` keys by their UTF-8 bytes. */
export function compareKeys(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b))
}

const clampTo = (startMs, endMs) => (at) => Math.min(endMs, Math.max(startMs, at))

// Adds a segment to an ordered list, joining it to the last one when they touch and share a task.
function pushSegment(list, key, start, end) {
  const last = list.at(-1)
  if (last !== undefined && last.key === key && last.end === start) last.end = end
  else list.push({ key, start, end })
}

const lengthOf = (segment) => segment.end - segment.start

// The index of the shortest segment that passes `eligible`, the earliest among equals, or -1.
function shortestIndex(list, eligible) {
  let pick = -1
  list.forEach((segment, index) => {
    if (eligible(segment, index) && (pick === -1 || lengthOf(segment) < lengthOf(list[pick]))) pick = index
  })
  return pick
}

// The index of the longer segment touching `list[index]`, the earlier of two equals, or -1 when none touches.
function longerNeighbour(list, index) {
  const before = index > 0 && list[index - 1].end === list[index].start ? index - 1 : -1
  const after = index + 1 < list.length && list[index + 1].start === list[index].end ? index + 1 : -1
  if (before === -1 || after === -1) return Math.max(before, after)
  return lengthOf(list[after]) > lengthOf(list[before]) ? after : before
}

// A new list in which `list[index]` belongs to `key`, with adjacent segments of one task joined.
function rekeyed(list, index, key) {
  const merged = []
  list.forEach((segment, at) => pushSegment(merged, at === index ? key : segment.key, segment.start, segment.end))
  return merged
}

// One stretch's inferred segments (they tile it) with every segment under `minSegmentMs` joined to its longer neighbour.
function withoutShortSegments(segments) {
  let list = segments
  for (;;) {
    const pick = list.length < 2 ? -1 : shortestIndex(list, (segment) => lengthOf(segment) < FOCUS_RULES.minSegmentMs)
    if (pick === -1) return list
    list = rekeyed(list, pick, list[longerNeighbour(list, pick)].key)
  }
}

// Worker 0's readable focus calls, clamped to the session and in a fixed order. At one instant a
// clear sorts first and the larger key last, and the last call at an instant holds the time after it.
function controllerCalls(focusCalls, startMs, endMs) {
  const clamp = clampTo(startMs, endMs)
  return focusCalls
    .filter((call) => call.agent === 0 && Number.isFinite(call.at) && (call.clear === true || typeof call.key === "string"))
    .map((call) => ({ at: clamp(call.at), key: call.clear === true ? null : call.key }))
    .sort((a, b) => a.at - b.at || (a.key === null ? -1 : b.key === null ? 1 : compareKeys(a.key, b.key)))
}

/**
 * `declaredStretches({ focusCalls, startMs, endMs }) -> [{ start, end, key }]`:
 * the session cut at worker 0's focus calls, in order, with no gap and no
 * overlap. `key` is the declared task, `null` for a cleared stretch and
 * `undefined` for an undeclared one. Zero-length stretches are left out.
 */
export function declaredStretches({ focusCalls, startMs, endMs }) {
  const calls = controllerCalls(focusCalls, startMs, endMs)
  const cuts = [{ at: startMs, key: undefined }, ...calls]
  const stretches = []
  cuts.forEach((cut, index) => {
    const end = index + 1 < cuts.length ? cuts[index + 1].at : endMs
    if (end > cut.at) stretches.push({ start: cut.at, end, key: cut.key })
  })
  return stretches
}

// The stretch's events as task events `{ key, at, kind }`, repository events resolved to the one card they count for or left out.
function taskEvents(events, clamp, cards) {
  const own = []
  const repos = []
  for (const event of events) {
    const at = Number.isFinite(event.at) ? clamp(event.at) : null
    if (event.kind === "repo") repos.push({ repo: event.repo.toLowerCase(), at })
    else own.push({ key: event.key, at, kind: event.kind })
  }
  const names = [...new Set(repos.map((event) => event.repo))]
  const nameOf = (repo) => repo.slice(repo.lastIndexOf("/") + 1)
  const lists = (listed, repo) => {
    const entry = listed.toLowerCase()
    if (entry.includes("/")) return entry === repo
    return nameOf(repo) === entry && names.filter((name) => nameOf(name) === entry).length === 1
  }
  const keys = [...new Set(own.map((event) => event.key))]
  const owner = new Map()
  for (const repo of names) {
    const listing = keys.filter((key) => (cards.get(key)?.repos ?? []).some((listed) => lists(listed, repo)))
    if (listing.length === 1) owner.set(repo, listing[0])
  }
  return [...own, ...repos.filter((event) => owner.has(event.repo)).map((event) => ({ key: owner.get(event.repo), at: event.at, kind: "repo" }))]
}

// Events per task, in key order.
function countEvents(events) {
  const counts = new Map()
  for (const key of [...new Set(events.map((event) => event.key))].sort(compareKeys)) counts.set(key, events.filter((event) => event.key === key).length)
  return counts
}

// One task's significant episodes, as `{ key, start, end, times }`.
function significantEpisodes(key, times) {
  const episodes = []
  let run = []
  const close = () => {
    if (run.length >= FOCUS_RULES.significantEvents && run.at(-1) - run[0] >= FOCUS_RULES.significantSpanMs) episodes.push({ key, start: run[0], end: run.at(-1), times: run })
  }
  for (const time of times) {
    if (run.length > 0 && time - run.at(-1) > FOCUS_RULES.episodeGapMs) {
      close()
      run = []
    }
    run.push(time)
  }
  close()
  return episodes
}

/**
 * `inferFocus({ events, startMs, endMs, neverDeclares, cards }) -> { segments,
 * main, counts }`: the inference rule over one stretch. `events` are the
 * evidence events of that stretch (times outside it are clamped to it),
 * `neverDeclares` says whether the session has no declaration at all, and
 * `cards` maps a task key to `{ repos }`. `segments` is `[{ key, start, end }]`
 * in order, `main` the main task or `null` when nothing is a candidate, and
 * `counts` each task's events, in key order.
 */
export function inferFocus({ events, startMs, endMs, neverDeclares, cards }) {
  const own = taskEvents(events, clampTo(startMs, endMs), cards)
  const counts = countEvents(own)
  const keys = [...counts.keys()]
  let candidates = keys.filter((key) => counts.get(key) >= FOCUS_RULES.candidateEvents)
  if (neverDeclares && keys.length === 1 && own.some((event) => OWN_WORK.has(event.kind))) candidates = keys
  if (candidates.length === 0) return { segments: [], main: null, counts }

  const timesOf = new Map(candidates.map((key) => [key, own.filter((event) => event.key === key && event.at !== null).map((event) => event.at).sort((a, b) => a - b)]))
  const firstOf = (key) => timesOf.get(key)[0] ?? Infinity
  // Only events with a time rank the main task: evidence with no time makes a candidate and never earns time over another.
  // Infinity - Infinity is NaN, which `||` passes over like a tie.
  const main = [...candidates].sort((a, b) => timesOf.get(b).length - timesOf.get(a).length || firstOf(a) - firstOf(b) || compareKeys(a, b))[0]
  const episodes = candidates.flatMap((key) => significantEpisodes(key, timesOf.get(key)))

  const bounds = [...new Set([startMs, endMs, ...episodes.flatMap((episode) => [episode.start, episode.end])])].sort((a, b) => a - b)
  const segments = []
  for (let index = 0; index < bounds.length - 1; index += 1) {
    const start = bounds[index]
    const end = bounds[index + 1]
    const covering = episodes.filter((episode) => episode.start <= start && end <= episode.end)
    let key = main
    if (covering.length > 0) {
      // The overlap is what every covering episode shares; each is scored by its events inside it.
      const from = Math.max(...covering.map((episode) => episode.start))
      const to = Math.min(...covering.map((episode) => episode.end))
      const inside = (episode) => episode.times.filter((time) => time >= from && time <= to).length
      key = [...covering].sort((a, b) => inside(b) - inside(a) || (b.key === main) - (a.key === main) || compareKeys(a.key, b.key))[0].key
    }
    pushSegment(segments, key, start, end)
  }
  return { segments: withoutShortSegments(segments), main, counts }
}

/**
 * `controllerTimeline({ events, startMs, endMs, cards }) -> { segments,
 * boundBy, disagrees, main }`: worker 0's session as `[{ key, start, end }]`,
 * from `events.focusCalls` and `events.evidence`. A declared stretch keeps
 * its task, a cleared one is left out, and the undeclared one is inferred
 * from the evidence inside it (evidence with no time counts only in a
 * session that never declares), or goes to the first declared task when
 * inference picks nothing. `boundBy` says how each task got its time (`focus`
 * wins over `inferred`), `disagrees` holds the declared tasks with a stretch
 * that has none of their own events and `DISAGREE_EVENTS` on another task,
 * and `main` is the undeclared stretch's main task, or `null`.
 */
export function controllerTimeline({ events, startMs, endMs, cards }) {
  const stretches = declaredStretches({ focusCalls: events.focusCalls, startMs, endMs })
  const neverDeclares = controllerCalls(events.focusCalls, startMs, endMs).length === 0
  const firstDeclared = stretches.find((stretch) => typeof stretch.key === "string")?.key
  const clamp = clampTo(startMs, endMs)
  const eventsIn = (stretch, isLast) => events.evidence.filter((event) => {
    if (!Number.isFinite(event.at)) return neverDeclares
    const time = clamp(event.at)
    return time >= stretch.start && (time < stretch.end || isLast)
  })

  const segments = []
  const boundBy = new Map()
  const disagrees = new Set()
  let main = null
  const give = (key, start, end, how) => {
    pushSegment(segments, key, start, end)
    if (boundBy.get(key) !== "focus") boundBy.set(key, how)
  }
  stretches.forEach((stretch, index) => {
    if (stretch.key === null) return
    const inside = eventsIn(stretch, index === stretches.length - 1)
    if (stretch.key === undefined) {
      const inferred = inferFocus({ events: inside, startMs: stretch.start, endMs: stretch.end, neverDeclares, cards })
      main = inferred.main
      for (const segment of inferred.segments) give(segment.key, segment.start, segment.end, "inferred")
      if (inferred.main === null && firstDeclared !== undefined) give(firstDeclared, stretch.start, stretch.end, "focus")
      return
    }
    give(stretch.key, stretch.start, stretch.end, "focus")
    const counts = countEvents(taskEvents(inside, clamp, cards))
    if (!counts.has(stretch.key) && [...counts.values()].some((count) => count >= DISAGREE_EVENTS)) disagrees.add(stretch.key)
  })
  return { segments, boundBy, disagrees, main }
}

/**
 * `capSegments({ segments, main, cap }) -> { segments, droppedMs }`: no task
 * keeps more than `cap` segments, and no time is lost except `droppedMs`,
 * which is exactly the time of the segments dropped by the one case below
 * (0 when none was; time handed to a neighbour is kept, never counted). A task over the cap gives its shortest
 * segment (the earliest among equals) to the main task, where it joins the
 * main task's neighbours. When there is no main task, or the main task is
 * the one over the cap, the task's shortest segment that touches another
 * joins the longer of the segments it touches (the earlier of two equals),
 * whatever their task. Either way adjacent segments of one task then join,
 * and this repeats until every task is at the cap. One case cannot keep its
 * time: a task over the cap none of whose segments touches another (each
 * stands alone between cleared stretches) loses its shortest segment, because
 * joining across the gap would bind time the controller cleared. Segments
 * never overlap before or after. Returns a new list.
 */
export function capSegments({ segments, main, cap }) {
  let list = segments.map((segment) => ({ ...segment }))
  let droppedMs = 0
  for (;;) {
    // Another task's segments go first: moving one to the main task can join two of the main task's own.
    const crowded = [...new Set(list.map((segment) => segment.key))].sort(compareKeys).filter((key) => list.filter((segment) => segment.key === key).length > cap)
    if (crowded.length === 0) return { segments: list, droppedMs }
    const over = crowded.find((key) => key !== main) ?? main
    if (main !== null && main !== over) {
      list = rekeyed(list, shortestIndex(list, (segment) => segment.key === over), main)
      continue
    }
    const pick = shortestIndex(list, (segment, index) => segment.key === over && longerNeighbour(list, index) !== -1)
    if (pick === -1) {
      const [lost] = list.splice(shortestIndex(list, (segment) => segment.key === over), 1)
      droppedMs += lost.end - lost.start
    } else list = rekeyed(list, pick, list[longerNeighbour(list, pick)].key)
  }
}
