// Declared and inferred focus: how one session's controller time is cut into
// stretches and given to tasks. `focus.js` is pure, so every input here is an
// invented list of normalized events (times in epoch milliseconds, tasks as
// `track/slug` keys); no desk, transcript or clock is touched.

import { test } from "node:test"
import assert from "node:assert/strict"

import { DISAGREE_EVENTS, FOCUS_RULES, capSegments, compareKeys, controllerTimeline, declaredStretches, inferFocus } from "../../../../../plugins/desk/mcp/src/factory/focus.js"

const MIN = 60000
const HOUR = 60 * MIN
const T0 = Date.UTC(2026, 8, 25, 8, 0, 0)
const at = (minutes) => T0 + minutes * MIN
const X = "t/x"
const Y = "t/y"
const Z = "t/z"

const write = (minutes, key, kind = "write") => ({ at: minutes === null ? null : at(minutes), key, kind })
const focus = (minutes, key, agent = 0) => (key === null ? { agent, at: at(minutes), clear: true } : { agent, at: at(minutes), key })
const seg = (key, start, end) => ({ key, start: at(start), end: at(end) })
const infer = (events, { start = 0, end = 600, neverDeclares = true, cards = new Map() } = {}) => inferFocus({ events, startMs: at(start), endMs: at(end), neverDeclares, cards })
const timeline = (focusCalls, evidence, { start = 0, end = 600, cards = new Map() } = {}) => controllerTimeline({ events: { focusCalls, evidence }, startMs: at(start), endMs: at(end), cards })
// A deterministic shuffle, so a failure reproduces.
function shuffled(list, seed) {
  const copy = [...list]
  let state = seed
  for (let index = copy.length - 1; index > 0; index -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648
    const other = state % (index + 1)
    ;[copy[index], copy[other]] = [copy[other], copy[index]]
  }
  return copy
}

test("the thresholds live in one frozen constant", () => {
  assert.deepEqual(FOCUS_RULES, { candidateEvents: 3, significantEvents: 3, significantSpanMs: 600000, episodeGapMs: 1800000 })
  assert.ok(Object.isFrozen(FOCUS_RULES))
  assert.equal(DISAGREE_EVENTS, 10)
})

test("keys compare in byte order, not UTF-16 order", () => {
  assert.equal(compareKeys("a/b", "a/b"), 0)
  assert.ok(compareKeys("a/b", "a/c") < 0)
  assert.ok(compareKeys("a/c", "a/b") > 0)
  // U+FF5E sorts after U+1F600 in UTF-16 code units and before it in UTF-8 bytes.
  assert.ok(compareKeys("t/～", "t/\u{1f600}") < 0)
})

// --- declaredStretches ---------------------------------------------------------

test("declared stretches partition the session", () => {
  const stretches = declaredStretches({ focusCalls: [focus(200, Y), focus(50, X), focus(400, null)], startMs: at(0), endMs: at(600) })
  assert.deepEqual(stretches, [
    { start: at(0), end: at(50), key: undefined },
    { start: at(50), end: at(200), key: X },
    { start: at(200), end: at(400), key: Y },
    { start: at(400), end: at(600), key: null },
  ])
  // No gap, no overlap, the whole session.
  stretches.forEach((stretch, index) => assert.equal(stretch.start, index === 0 ? at(0) : stretches[index - 1].end))
  assert.equal(stretches.at(-1).end, at(600))
  // No call: one undeclared stretch. A zero-length session: none.
  assert.deepEqual(declaredStretches({ focusCalls: [], startMs: at(0), endMs: at(600) }), [{ start: at(0), end: at(600), key: undefined }])
  assert.deepEqual(declaredStretches({ focusCalls: [focus(0, X)], startMs: at(0), endMs: at(0) }), [])
})

test("declared stretches clamp calls to the session, drop unreadable ones and zero-length stretches", () => {
  const stretches = declaredStretches({
    focusCalls: [focus(-5, X), focus(700, Y), { agent: 0, at: null, key: Z }, { agent: 0, at: at(10) }, { agent: 0, at: at(20), key: 7 }, focus(300, Z), focus(300, Y), focus(300, null)],
    startMs: at(0),
    endMs: at(600),
  })
  // X starts at the session's start, so there is no undeclared prefix. Three calls at one instant: the
  // cleared one sorts first and the larger key last, so the larger key holds the time. Y at 700 clamps to the end.
  assert.deepEqual(stretches, [{ start: at(0), end: at(300), key: X }, { start: at(300), end: at(600), key: Z }])
})

test("subagent focus call ignored", () => {
  const calls = [focus(50, X), focus(100, Y, 1), focus(150, null, 2)]
  assert.deepEqual(declaredStretches({ focusCalls: calls, startMs: at(0), endMs: at(600) }), [
    { start: at(0), end: at(50), key: undefined },
    { start: at(50), end: at(600), key: X },
  ])
  // A session whose only calls come from subagents never declares.
  const result = timeline([focus(100, Y, 1)], [write(10, X), write(20, X), write(40, X)])
  assert.deepEqual(result.segments, [seg(X, 0, 600)])
  assert.deepEqual([...result.boundBy], [[X, "inferred"]])
})

// --- inferFocus ------------------------------------------------------------------

test("no candidate: the stretch binds nothing, and the counts are still reported", () => {
  const result = infer([write(10, X), write(20, X), write(30, Y)])
  assert.deepEqual(result.segments, [])
  assert.equal(result.main, null)
  assert.deepEqual([...result.counts], [[X, 2], [Y, 1]])
  assert.deepEqual(infer([]), { segments: [], main: null, counts: new Map() })
})

test("one-event candidate only when never declared and not task_update-only", () => {
  // One task, one write: a candidate, and the whole stretch is its.
  assert.deepEqual(infer([write(10, X)]).segments, [seg(X, 0, 600)])
  for (const kind of ["commit", "spawn"]) assert.equal(infer([write(10, X, kind)]).main, X, kind)
  // A desk tool call alone is not enough, however many times under three.
  assert.equal(infer([write(10, X, "tool"), write(20, X, "tool")]).main, null)
  assert.equal(infer([write(10, X, "tool"), write(20, X)]).main, X)
  // Two tasks with events: no exception.
  assert.equal(infer([write(10, X), write(20, Y)]).main, null)
  // A session that declares somewhere: no exception.
  assert.equal(infer([write(10, X)], { neverDeclares: false }).main, null)
  assert.equal(infer([write(10, X), write(11, X), write(12, X)], { neverDeclares: false }).main, X)
})

test("short burst does not capture idle hours", () => {
  const events = [write(0, Y), write(1, Y), write(2, Y), ...Array.from({ length: 10 }, (_, index) => write(362 + index * 5, X))]
  const result = infer(events, { end: 420 })
  // Y is a candidate with no significant episode, so it owns no time; X is the main task and takes the gap.
  assert.deepEqual(result.segments, [seg(X, 0, 420)])
  assert.equal(result.main, X)
  assert.deepEqual([...result.counts], [[X, 10], [Y, 3]])
})

test("interleaved episodes stay intact", () => {
  // X: 40 events over three hours from an implementer. Y: a note every 20 minutes through the same hours.
  const xs = Array.from({ length: 40 }, (_, index) => write(60 + index * 4.5, X))
  const ys = Array.from({ length: 9 }, (_, index) => write(70 + index * 20, Y))
  const result = infer([...xs, ...ys], { end: 300 })
  assert.deepEqual(result.segments, [seg(X, 0, 300)], "X keeps its episode and, as the main task, the time around it")
  assert.equal(result.main, X)
})

test("an episode breaks at a gap over 30 minutes, needs 3 events and 10 minutes, and uncovered time goes to the main task", () => {
  const events = [
    // X: the main task by count, one significant episode [100, 130].
    ...[100, 110, 120, 130].map((minute) => write(minute, X)),
    // Y: [200, 215] is significant; 246 is 31 minutes later, a new episode of one event.
    ...[200, 210, 215, 246].map((minute) => write(minute, Y)),
  ]
  const result = infer(events, { end: 400 })
  assert.equal(result.main, X)
  assert.deepEqual(result.segments, [seg(X, 0, 200), seg(Y, 200, 215), seg(X, 215, 400)])
  // Exactly 30 minutes apart is still one episode; three events inside 9 minutes own nothing.
  assert.deepEqual(infer([write(0, X), write(1, X), write(2, X), write(3, X), write(200, Y), write(230, Y), write(260, Y)], { end: 400 }).segments, [seg(X, 0, 200), seg(Y, 200, 260), seg(X, 260, 400)])
  assert.deepEqual(infer([write(0, X), write(1, X), write(2, X), write(3, X), write(200, Y), write(204, Y), write(209, Y)], { end: 400 }).segments, [seg(X, 0, 400)])
})

test("overlapping episodes: the overlap goes to the task with more events inside it, then the main task, then key order", () => {
  const xs = [100, 110, 120, 140, 170, 200].map((minute) => write(minute, X))
  // X [100,200] and Y [150,250], six events each, so X (the earlier first event) is the main task.
  // Inside [150,200]: X has 2 (170, 200), Y has 4 (150, 160, 170, 200).
  const more = infer([...xs, ...[150, 160, 170, 200, 225, 250].map((minute) => write(minute, Y))], { end: 300 })
  assert.equal(more.main, X)
  assert.deepEqual(more.segments, [seg(X, 0, 150), seg(Y, 150, 250), seg(X, 250, 300)])
  // A tie inside the overlap goes to the main task: X has 2 (170, 200), Y has 2 (150, 180).
  const tie = infer([...xs, ...[150, 180, 210, 240, 250].map((minute) => write(minute, Y))], { end: 300 })
  assert.equal(tie.main, X)
  assert.deepEqual(tie.segments, [seg(X, 0, 200), seg(Y, 200, 250), seg(X, 250, 300)])
  // A tie between two tasks that are not the main one goes to key order. Z is the main task: most events, no episode.
  const zs = Array.from({ length: 9 }, (_, index) => write(index / 10, Z))
  const keyed = infer([...zs, ...[100, 130, 160, 180, 200].map((minute) => write(minute, Y)), ...[150, 175, 200, 225, 250].map((minute) => write(minute, X))], { end: 300 })
  assert.equal(keyed.main, Z)
  // Inside [150,200] both have 3; X sorts before Y.
  assert.deepEqual(keyed.segments, [seg(Z, 0, 100), seg(Y, 100, 150), seg(X, 150, 250), seg(Z, 250, 300)])
})

test("the main task is the candidate with most events, then the earliest first event, then key order", () => {
  const three = (key, start) => [write(start, key), write(start + 1, key), write(start + 2, key)]
  assert.equal(infer([...three(Y, 10), ...three(X, 20), write(30, X)]).main, X, "more events")
  assert.equal(infer([...three(Y, 10), ...three(X, 20)]).main, Y, "the earlier first event")
  assert.equal(infer([...three(Y, 10), ...three(X, 10)]).main, X, "key order")
  // Untimed events count toward candidacy and the main task, own no time, and never count as the earliest.
  const untimed = infer([write(null, Y), write(null, Y), write(null, Y), write(null, Y), ...three(X, 10)])
  assert.equal(untimed.main, Y)
  assert.deepEqual(untimed.segments, [seg(Y, 0, 600)])
  assert.equal(infer([write(null, Y), write(null, Y), write(null, Y), ...three(X, 10)]).main, X, "a timed first event is earlier than none")
  assert.equal(infer([write(null, Y), write(null, Y), write(null, Y), write(null, X), write(null, X), write(null, X)]).main, X)
})

test("events outside the stretch are clamped to it", () => {
  const result = infer([write(-30, X), write(5, X), write(700, X)], { end: 600 })
  // Clamped to 0 and 600: one episode would need gaps of at most 30 minutes, so none is significant; X is still the main task.
  assert.deepEqual(result.segments, [seg(X, 0, 600)])
})

test("repo evidence counts only for the one listing card", () => {
  const repo = (minutes, name) => ({ at: at(minutes), repo: name, kind: "repo" })
  const cards = new Map([[X, { repos: ["Owner/Code"] }], [Y, { repos: ["owner/code"] }], [Z, { repos: [] }]])
  const prs = [repo(100, "owner/code"), repo(110, "OWNER/code"), repo(120, "owner/code")]
  // X lists the repository and has one event of its own: the three PRs count for it.
  const one = infer([write(10, X, "tool"), ...prs, write(20, Z)], { cards })
  assert.deepEqual([...one.counts], [[X, 4], [Z, 1]])
  assert.equal(one.main, X)
  assert.deepEqual(one.segments, [seg(X, 0, 600)])
  // Two cards list it and both have an event: it counts for neither.
  assert.deepEqual([...infer([write(10, X), write(15, Y), ...prs], { cards }).counts], [[X, 1], [Y, 1]])
  // The card that lists it has no other event: it counts for nothing, and never for a card that does not list it.
  assert.deepEqual([...infer([write(20, Z), ...prs], { cards }).counts], [[Z, 1]])
  assert.deepEqual([...infer(prs, { cards }).counts], [])
  // A card missing from `cards` lists nothing.
  assert.deepEqual([...infer([write(10, X), ...prs], { cards: new Map() }).counts], [[X, 1]])
  // Repository events alone never make the one-event exception: the task's own event must be a write, commit or spawn.
  assert.equal(infer([write(10, X, "tool"), repo(100, "owner/code")], { cards }).main, null)
})

test("a card's bare repository name matches by name, and never when two owners share that name", () => {
  const repo = (minutes, name) => ({ at: at(minutes), repo: name, kind: "repo" })
  const cards = new Map([[X, { repos: ["code"] }], [Y, { repos: ["other/thing"] }]])
  assert.deepEqual([...infer([write(10, X), repo(20, "owner/code"), repo(30, "Owner/Code")], { cards }).counts], [[X, 3]])
  assert.deepEqual([...infer([write(10, X), repo(20, "code")], { cards }).counts], [[X, 2]], "a bare event name matches a bare card name")
  // Two different owners with that name in one session: the bare name matches neither.
  assert.deepEqual([...infer([write(10, X), repo(20, "owner/code"), repo(30, "else/code")], { cards }).counts], [[X, 1]])
  // An owner/name on the card never matches a bare or differently owned event.
  assert.deepEqual([...infer([write(10, Y), repo(20, "thing"), repo(30, "elsewhere/thing")], { cards }).counts], [[Y, 1]])
})

test("ties broken deterministically", () => {
  const events = [
    ...[100, 110, 120, 130, 160, 200].map((m) => write(m, X)),
    ...[150, 170, 240, 250, 100, 200].map((m) => write(m, Y)),
    ...[150, 160, 300, 310, 320, 330].map((m) => write(m, Z)),
    write(null, Z), { at: at(5), repo: "o/r", kind: "repo" }, { at: at(6), repo: "p/r", kind: "repo" },
  ]
  const calls = [focus(400, Y), focus(400, X), focus(400, null), focus(500, null), focus(500, Z), focus(450, Z, 3)]
  const cards = new Map([[X, { repos: ["r"] }], [Y, { repos: ["o/r"] }], [Z, { repos: [] }]])
  const plain = (result) => JSON.stringify({ segments: result.segments, boundBy: [...result.boundBy], disagrees: [...result.disagrees], main: result.main })
  const expectedInfer = JSON.stringify(infer(events, { cards }).segments)
  const expectedCounts = JSON.stringify([...infer(events, { cards }).counts])
  const expectedTimeline = plain(timeline(calls, events, { cards }))
  for (let seed = 1; seed <= 25; seed += 1) {
    const mixed = shuffled(events, seed)
    const result = infer(mixed, { cards: new Map(shuffled([...cards], seed)) })
    assert.equal(JSON.stringify(result.segments), expectedInfer, `seed ${seed}`)
    assert.equal(JSON.stringify([...result.counts]), expectedCounts, `seed ${seed}`)
    assert.equal(plain(timeline(shuffled(calls, seed), mixed, { cards })), expectedTimeline, `seed ${seed}`)
  }
})

// --- controllerTimeline ----------------------------------------------------------

test("undeclared prefix inferred, else first declared", () => {
  // Inference picks Y in the prefix: the prefix is Y's, inferred.
  const inferred = timeline([focus(200, X)], [write(10, Y), write(30, Y), write(50, Y), write(300, X)])
  assert.deepEqual(inferred.segments, [seg(Y, 0, 200), seg(X, 200, 600)])
  assert.deepEqual([...inferred.boundBy], [[Y, "inferred"], [X, "focus"]])
  assert.equal(inferred.main, Y)
  // Inference picks nothing (one event, and the session declares): the prefix goes to the first declared task.
  const fallback = timeline([focus(200, X), focus(400, Y)], [write(10, Y)])
  assert.deepEqual(fallback.segments, [seg(X, 0, 400), seg(Y, 400, 600)])
  assert.deepEqual([...fallback.boundBy], [[X, "focus"], [Y, "focus"]])
  assert.equal(fallback.main, null)
  // The first declaration is a clear: the prefix goes to the first declared task, and the cleared stretch stays unbound.
  assert.deepEqual(timeline([focus(100, null), focus(300, X)], []).segments, [seg(X, 0, 100), seg(X, 300, 600)])
  // Only a clear is ever declared: nothing to give the prefix to.
  assert.deepEqual(timeline([focus(100, null)], [write(10, X)]).segments, [])
  // A task inferred in the prefix and declared later is bound by focus.
  const both = timeline([focus(200, X)], [write(10, X), write(30, X), write(50, X)])
  assert.deepEqual(both.segments, [seg(X, 0, 600)])
  assert.deepEqual([...both.boundBy], [[X, "focus"]])
  // Events after the declaration never reach the prefix's inference.
  assert.deepEqual(timeline([focus(200, X)], [write(210, Y), write(230, Y), write(250, Y)]).segments, [seg(X, 0, 600)])
})

test("clear stretch binds nothing", () => {
  const result = timeline([focus(0, X), focus(100, null), focus(300, X)], [write(150, Y), write(170, Y), write(190, Y)])
  assert.deepEqual(result.segments, [seg(X, 0, 100), seg(X, 300, 600)])
  assert.deepEqual([...result.boundBy], [[X, "focus"]])
})

test("a session that never declares is inferred whole, untimed events included", () => {
  const result = timeline([], [write(null, X), write(null, X), write(null, X)])
  assert.deepEqual(result.segments, [seg(X, 0, 600)])
  assert.deepEqual([...result.boundBy], [[X, "inferred"]])
  assert.equal(result.main, X)
  assert.deepEqual([...result.disagrees], [])
  // In a session that declares, an untimed event belongs to no stretch.
  assert.deepEqual(timeline([focus(200, X)], [write(null, Y), write(null, Y), write(null, Y)]).segments, [seg(X, 0, 600)])
  // Nothing at all.
  assert.deepEqual(timeline([], []), { segments: [], boundBy: new Map(), disagrees: new Set(), main: null })
  // A zero-length session has no stretches.
  assert.deepEqual(timeline([focus(0, X)], [write(0, X)], { end: 0 }).segments, [])
})

test("focus disagrees when a declared stretch has none of its own events and at least 10 on another task", () => {
  const ys = (count, from = 110) => Array.from({ length: count }, (_, index) => write(from + index, Y))
  assert.deepEqual([...timeline([focus(100, X)], ys(10)).disagrees], [X])
  assert.deepEqual([...timeline([focus(100, X)], ys(9)).disagrees], [], "nine is not enough")
  assert.deepEqual([...timeline([focus(100, X)], [...ys(10), write(300, X)]).disagrees], [], "one event of its own")
  // Events in another stretch do not count: Y's ten sit in the prefix, and an event at the session's end is in the last stretch.
  assert.deepEqual([...timeline([focus(100, X)], [...ys(10, 0), write(600, X)]).disagrees], [])
  assert.deepEqual([...timeline([focus(100, X), focus(300, Z)], [...ys(10), write(300, Z)]).disagrees], [X])
  // The declaration still wins the time.
  assert.deepEqual(timeline([focus(100, X)], ys(10)).segments, [seg(X, 0, 600)])
  // A cleared stretch never disagrees.
  assert.deepEqual([...timeline([focus(100, null)], ys(10)).disagrees], [])
})

// --- capSegments -------------------------------------------------------------------

test("segment cap reassigns shortest to main", () => {
  const segments = [seg(X, 0, 10), seg(Y, 10, 12), seg(X, 12, 20), seg(Y, 20, 21), seg(X, 21, 30), seg(Y, 30, 40), seg(Z, 40, 50), seg(Y, 50, 53)]
  // Y holds four segments; with a cap of two, its two shortest go to the main task and merge into its neighbours.
  assert.deepEqual(capSegments({ segments, main: X, cap: 2 }), [seg(X, 0, 30), seg(Y, 30, 40), seg(Z, 40, 50), seg(Y, 50, 53)])
  // With a cap of three only the shortest moves, here to a main task that is not a neighbour.
  assert.deepEqual(capSegments({ segments, main: Z, cap: 3 }), [seg(X, 0, 10), seg(Y, 10, 12), seg(X, 12, 20), seg(Z, 20, 21), seg(X, 21, 30), seg(Y, 30, 40), seg(Z, 40, 50), seg(Y, 50, 53)])
  // Under the cap: unchanged, and the input is never modified.
  const before = JSON.stringify(segments)
  assert.deepEqual(capSegments({ segments, main: X, cap: 4 }), segments)
  assert.equal(JSON.stringify(segments), before)
  // Segments never overlap afterwards.
  const capped = capSegments({ segments, main: X, cap: 1 })
  capped.forEach((segment, index) => assert.ok(index === 0 || segment.start >= capped[index - 1].end))
})

test("the segment cap drops the shortest segments of the main task itself, or of any task when there is no main task", () => {
  const segments = [seg(X, 0, 10), seg(Y, 10, 12), seg(X, 12, 13), seg(Y, 20, 21), seg(X, 21, 30)]
  // X is the main task and over the cap: its shortest segment binds nothing.
  assert.deepEqual(capSegments({ segments, main: X, cap: 2 }), [seg(X, 0, 10), seg(Y, 10, 12), seg(Y, 20, 21), seg(X, 21, 30)])
  // A declared timeline has no main task: equal lengths drop the earliest first.
  assert.deepEqual(capSegments({ segments: [seg(X, 0, 5), seg(Y, 5, 10), seg(X, 10, 15), seg(Y, 15, 20)], main: null, cap: 1 }), [seg(X, 10, 15), seg(Y, 15, 20)])
})
