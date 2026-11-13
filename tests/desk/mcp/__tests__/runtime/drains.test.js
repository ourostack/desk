// Issue drains: what the poll records, what it ignores and what it hands a runner to deliver. The GitHub side is a fake; every
// state, config and lock file lives under a temporary root.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { promises as fs, readFileSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import {
  ackWake, connectGithub, DRAIN_STATUS_MARKER, drainPaths, drainsHome, drainStatusLines, installLauncher, parseDrainConfig, pollDrain, pollDrains,
  readDrainConfig, readDrainStates, wakeId, wakeMessage, withDrainLock,
} from "../../../../../plugins/desk/mcp/src/runtime/drains.js"
import { parseDrainsArgs, runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/drains.js", import.meta.url))
const DRAIN = { repo: "acme/widgets", session: "58fbd57e-e371-4169-b013-2f413ab4a046", account: "maintainer" }
const NOW = Date.parse("2026-11-13T06:00:00Z")
const HOUR = 3_600_000

const issue = (number, updated_at, title = `Issue ${number}`, body = "body") => ({ number, title, updated_at, body })
const T = (minute) => `2026-11-13T01:${String(minute).padStart(2, "0")}:00Z`
const seenAt = (updatedAt) => ({ updatedAt, digest: /^[0-9a-f]{16}$/u })
const statusComment = (id, updated_at, login = "maintainer") => ({ id, body: `Triaged.\n${DRAIN_STATUS_MARKER}`, updated_at, user: { login } })
const labelEvent = (created_at, label, event = "labeled") => ({ id: 1, event, created_at, label: { name: label } })

function matches(actual, expected) {
  for (const [key, want] of Object.entries(expected)) {
    if (want instanceof RegExp) assert.match(actual[key], want)
    else if (want !== null && typeof want === "object") matches(actual[key], want)
    else assert.equal(actual[key], want, key)
  }
}

// One drain, a fake GitHub and a runner that delivers every wake the poll prints and reports back with its `done` command.
async function world(issues, { comments = {}, events = {}, drain = DRAIN } = {}) {
  const dir = await mkTempRoot("desk-drains-")
  const paths = { config: path.join(dir, "config.json"), state: path.join(dir, "state.json"), lock: path.join(dir, "poll.lock") }
  const w = { issues, paths, sent: [], refuse: null, calls: { comments: [] } }
  w.comments = async (_repo, n) => comments[n] ?? []
  w.events = async (_repo, n) => events[n] ?? []
  w.api = {
    login: "maintainer",
    openIssues: async () => w.issues,
    comments: async (...args) => { w.calls.comments.push(args); return w.comments(...args) },
    issueEvents: (...args) => w.events(...args),
  }
  w.connect = async () => w.api
  writeFileSync(paths.config, JSON.stringify({ drains: [drain] }))
  w.state = () => readDrainStates(paths.state)[drain.repo]
  w.poll = async (at = NOW) => {
    const out = await pollDrains({ paths, connect: (...args) => w.connect(...args), now: at, ackCommand: ["node", "drains.js"] })
    for (const wake of out.wakes) {
      w.sent.push([wake.session, wake.message])
      const refused = w.refuse
      w.refuse = null
      ackWake({ paths, repo: wake.repo, wake: wake.id, error: refused ?? undefined, now: at })
    }
    return out
  }
  return w
}

test("records what is already open on the first poll without waking anyone", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z"), issue(2, "2026-11-13T02:00:00Z")])
  const out = await w.poll()
  assert.deepEqual(out.wakes, [])
  matches(w.state(), { seeded: true, openCount: 2, pending: [], seen: { 1: seenAt("2026-11-13T01:00:00Z"), 2: seenAt("2026-11-13T02:00:00Z") } })
})

test("wakes once per new or changed issue revision and never again for the same one", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.push(issue(2, "2026-11-13T03:00:00Z", "New thing"))
  await w.poll()
  assert.deepEqual(w.sent, [[DRAIN.session, "New or changed issues in acme/widgets: #2 New thing. Drain them."]])
  await w.poll()
  assert.equal(w.sent.length, 1)
  w.issues[0] = issue(1, "2026-11-13T04:00:00Z", "Issue 1", "edited")
  await w.poll()
  assert.equal(w.sent.length, 2)
  matches(w.state(), { lastWakeCount: 1, lastWakeAt: new Date(NOW).toISOString() })
  assert.deepEqual(w.state().pending, [])
})

test("batches every change from one poll into a single message, and keeps a closed issue's marker, flagged gone", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z"), issue(9, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.splice(0, 2, issue(1, "2026-11-13T05:00:00Z", "One\nwith\nlines"), issue(3, "2026-11-13T05:01:00Z"), issue(4, "2026-11-13T05:02:00Z"))
  await w.poll()
  assert.deepEqual(w.sent, [[DRAIN.session, "New or changed issues in acme/widgets: #1 One with lines, #3 Issue 3, #4 Issue 4. Drain them."]])
  assert.deepEqual(Object.keys(w.state().seen), ["1", "3", "4", "9"])
  matches(w.state().seen["9"], { updatedAt: "2026-11-13T01:00:00Z", goneAt: NOW })
})

test("does not wake for the drain's own status comment, matched by marker, author and revision", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll()
  w.issues[0] = issue(1, T(5))
  w.comments = async () => [statusComment(10, T(5), "MaintAiner")]
  await w.poll()
  assert.deepEqual(w.sent, [])
  assert.deepEqual(w.calls.comments.at(-1), [DRAIN.repo, 1, T(0)])
  matches(w.state().seen["1"], seenAt(T(5)))
})

test("does not wake when the drain's label changes land after its status comment, nor when it edits that comment again", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll()
  w.issues[0] = issue(1, T(7))
  w.comments = async () => [statusComment(10, T(5))]
  w.events = async () => [labelEvent(T(6), "drain: in progress"), labelEvent(T(7), "drain: triaged", "unlabeled")]
  await w.poll()
  w.issues[0] = issue(1, T(9))
  w.comments = async () => [statusComment(10, T(9))]
  w.events = async () => []
  await w.poll()
  w.issues[0] = issue(1, T(12))
  w.comments = async () => []
  w.events = async () => [labelEvent(T(12), "drain: triaged")]
  await w.poll()
  assert.deepEqual(w.sent, [])
  matches(w.state().seen["1"], seenAt(T(12)))
})

test("wakes once for someone else's comment next to the drain's own, and not again on the next poll", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll()
  w.issues[0] = issue(1, T(8))
  w.comments = async () => [statusComment(10, T(8)), { id: 11, body: "me too", updated_at: T(8), user: { login: "someone" } }]
  await w.poll()
  assert.equal(w.sent.length, 1)
  await w.poll()
  await w.poll()
  assert.equal(w.sent.length, 1)
})

for (const [name, comments] of [
  ["a comment by the same account without the marker", [{ id: 1, body: "Ari says hi", updated_at: T(5), user: { login: "maintainer" } }]],
  ["a marked comment by someone else", [{ id: 1, body: DRAIN_STATUS_MARKER, updated_at: T(5), user: { login: "someone" } }]],
  ["a comment with no author", [{ id: 1, body: DRAIN_STATUS_MARKER, updated_at: T(5) }]],
  ["an external comment beside the status comment", [{ id: 1, body: "me too", updated_at: T(3), user: { login: "someone" } }, statusComment(2, T(5))]],
]) {
  test(`still wakes for ${name}`, async () => {
    const w = await world([issue(1, T(0))])
    await w.poll()
    w.issues[0] = issue(1, T(5))
    w.comments = async () => comments
    await w.poll()
    assert.equal(w.sent.length, 1)
  })
}

for (const [name, changed, events] of [
  ["a title edit", issue(1, T(5), "Renamed"), []],
  ["a body edit", issue(1, T(5), "Issue 1", "new body"), []],
  ["a reopen", issue(1, T(5)), [{ id: 1, event: "reopened", created_at: T(5) }]],
  ["a label outside the drain's own", issue(1, T(5)), [labelEvent(T(5), "bug")]],
  ["a label removed outside the drain's own", issue(1, T(5)), [labelEvent(T(5), "wontfix", "unlabeled")]],
]) {
  test(`still wakes for ${name}, once`, async () => {
    const w = await world([issue(1, T(0))], { events: { 1: events } })
    await w.poll()
    w.issues[0] = changed
    await w.poll()
    assert.equal(w.sent.length, 1)
    await w.poll()
    assert.equal(w.sent.length, 1)
  })
}

for (const [name, comments, events] of [
  ["a status comment older than the issue's last change", [statusComment(10, T(3))], []],
  ["a comment from before the recorded revision", [statusComment(10, T(0))], []],
  ["a close, an assignment and the drain's labels", [], [{ id: 1, event: "closed", created_at: T(5) }, { id: 2, event: "assigned", created_at: T(5) }, labelEvent(T(5), "drain: triaged")]],
  ["events from before the recorded revision", [], [{ id: 1, event: "reopened", created_at: T(0) }, labelEvent(T(0), "bug")]],
  ["a change with no comment and no event", [], []],
]) {
  test(`does not wake for ${name}`, async () => {
    const w = await world([issue(1, T(0))], { comments: { 1: comments }, events: { 1: events } })
    await w.poll()
    w.issues[0] = issue(1, T(5))
    await w.poll()
    assert.deepEqual(w.sent, [])
  })
}

test("never wakes for a closed issue the drain handled, and drops its waiting event", async () => {
  const w = await world([issue(1, T(0)), issue(2, T(0))])
  await w.poll()
  w.issues.splice(0, 2, issue(1, T(5), "Issue 1", "edited"), issue(2, T(5), "Issue 2", "edited"))
  w.refuse = "queued behind the app"
  await w.poll()
  assert.deepEqual(w.state().pending.map((event) => event.number), [1, 2])
  w.issues.splice(0, 1)
  await w.poll()
  assert.deepEqual(w.sent.at(-1), [DRAIN.session, "New or changed issues in acme/widgets: #2 Issue 2. Drain them."])
  w.issues.length = 0
  await w.poll()
  await w.poll()
  assert.equal(w.sent.length, 2)
})

test("a cross-reference never wakes the drain, whoever made it, including the one the drain's own marked comment on another issue creates", async () => {
  const w = await world([issue(1, T(0)), issue(2, T(0))])
  await w.poll()
  const crossReference = (id, created_at, source) => ({ id, event: "cross-referenced", created_at, source: { type: "issue", issue: { number: source } } })
  w.issues[0] = issue(1, T(5))
  w.issues[1] = issue(2, T(6))
  w.comments = async () => []
  w.events = async (_repo, n) => (n === 1 ? [crossReference(10, T(5), 3)] : [crossReference(11, T(6), 4), { ...crossReference(12, T(6), 4), actor: { login: "someone" } }])
  await w.poll()
  assert.deepEqual(w.sent, [])
  matches(w.state().seen["1"], seenAt(T(5)))
  matches(w.state().seen["2"], seenAt(T(6)))
  // The next real change still wakes.
  w.issues[0] = issue(1, T(9), "Issue 1", "edited")
  await w.poll()
  assert.equal(w.sent.length, 1)
})

test("a closed issue whose only later changes are the drain's own label edits never wakes the drain, even when a wake for it was waiting", async () => {
  const w = await world([issue(1, T(0)), issue(2, T(0))])
  await w.poll()
  w.issues[0] = issue(1, T(5), "Issue 1", "edited")
  w.issues[1] = issue(2, T(5), "Issue 2", "edited")
  w.refuse = "queued behind the app"
  await w.poll()
  assert.deepEqual(w.state().pending.map((event) => event.number), [1, 2])
  // Issue 2 closes; the drain later unlabels it. Neither a close nor a label edit on a closed issue is news.
  w.issues.splice(1, 1)
  w.events = async () => [{ id: 1, event: "closed", created_at: T(6) }, labelEvent(T(40), "drain: in progress", "unlabeled")]
  await w.poll(NOW + 1000)
  assert.deepEqual(w.sent.at(-1), [DRAIN.session, "New or changed issues in acme/widgets: #1 Issue 1. Drain them."])
  await w.poll(NOW + 2000)
  await w.poll(NOW + 3000)
  assert.equal(w.sent.length, 2)
  assert.deepEqual(w.state().pending, [])
})

test("treats a closed issue that returns unchanged as seen, and one that is reopened as news", async () => {
  const w = await world([issue(1, T(0)), issue(2, T(0))], { events: { 2: [{ id: 1, event: "closed", created_at: T(5) }, { id: 2, event: "reopened", created_at: T(9) }] } })
  await w.poll()
  const [one, two] = w.issues
  w.issues.length = 0
  await w.poll()
  w.issues.push(one)
  await w.poll()
  assert.deepEqual(w.sent, [])
  assert.equal("goneAt" in w.state().seen["1"], false)
  w.issues.push(issue(2, T(10), two.title))
  await w.poll()
  assert.deepEqual(w.sent, [[DRAIN.session, "New or changed issues in acme/widgets: #2 Issue 2. Drain them."]])
})

test("forgets a closed issue's marker after a month", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll()
  w.issues.length = 0
  await w.poll()
  assert.ok(w.state().seen["1"])
  await w.poll(NOW + 31 * 24 * HOUR)
  assert.deepEqual(w.state().seen, {})
})

const budget = (id, updated_at, body = "CI's critical path took 14 min", login = "automation[bot]") => ({ id, body, updated_at, user: { login } })

test("a comment by an ignored author that matches the rule's pattern wakes nobody, new or edited, while any other comment by that author still does", async () => {
  const quiet = { ...DRAIN, ignoreComments: [{ author: "Automation[bot]", match: "^CI's critical path took" }] }
  const w = await world([issue(1, T(0))], { drain: quiet })
  await w.poll()
  w.issues[0] = issue(1, T(5))
  w.comments = async () => [budget(10, T(5))]
  await w.poll()
  w.issues[0] = issue(1, T(10))
  w.comments = async () => [budget(10, T(10), "CI's critical path took 31 min"), budget(11, T(9))]
  await w.poll()
  assert.deepEqual(w.sent, [])
  matches(w.state().seen["1"], seenAt(T(10)))
  w.issues[0] = issue(1, T(15))
  w.comments = async () => [budget(12, T(15), "Heads up: the release job is red")]
  await w.poll()
  assert.equal(w.sent.length, 1)
})

test("an ignore rule skips only its author and its pattern: the same text from someone else, and a body or author that does not fit, still wake", async () => {
  const quiet = { ...DRAIN, ignoreComments: [{ author: "automation[bot]", match: "^CI's critical path took" }, { author: "chatty[bot]" }] }
  for (const [name, comment] of [
    ["the pattern's text from a person", budget(1, T(5), "CI's critical path took 14 min", "someone")],
    ["the pattern's text from a comment with no author", { id: 1, body: "CI's critical path took 14 min", updated_at: T(5) }],
    ["a body that merely contains the pattern's text", budget(1, T(5), "Re: CI's critical path took 14 min")],
    ["a comment with no body from the pattern's author", { id: 1, updated_at: T(5), user: { login: "automation[bot]" } }],
  ]) {
    const w = await world([issue(1, T(0))], { drain: quiet })
    await w.poll()
    w.issues[0] = issue(1, T(5))
    w.comments = async () => [comment]
    await w.poll()
    assert.equal(w.sent.length, 1, name)
  }
  const w = await world([issue(1, T(0))], { drain: quiet })
  await w.poll()
  w.issues[0] = issue(1, T(5))
  w.comments = async () => [budget(1, T(5), "anything at all", "Chatty[bot]"), { id: 2, updated_at: T(5), user: { login: "chatty[bot]" } }]
  await w.poll()
  assert.deepEqual(w.sent, [], "a rule with no pattern skips every comment by its author")
})

test("an ignored label, and the drain: prefix beside it, wake nobody; any other label still does", async () => {
  const lanes = { ...DRAIN, ignoredLabels: ["agent:drain"] }
  const w = await world([issue(1, T(0))], { drain: lanes })
  await w.poll()
  w.issues[0] = issue(1, T(5))
  w.events = async () => [labelEvent(T(5), "agent:drain"), labelEvent(T(5), "drain: in progress")]
  await w.poll()
  w.issues[0] = issue(1, T(10))
  w.events = async () => [labelEvent(T(10), "Agent:Drain", "unlabeled"), labelEvent(T(10), "drain: triaged", "unlabeled")]
  await w.poll()
  assert.deepEqual(w.sent, [])
  for (const other of ["bug", "agent:drain-extra"]) {
    const next = await world([issue(1, T(0))], { drain: lanes })
    await next.poll()
    next.issues[0] = issue(1, T(5))
    next.events = async () => [labelEvent(T(5), "agent:drain"), labelEvent(T(5), other)]
    await next.poll()
    assert.equal(next.sent.length, 1, other)
  }
})

test("a label event that names no label is news, and so is a configured label in a repository that does not configure it", async () => {
  const lanes = await world([issue(1, T(0))], { drain: { ...DRAIN, ignoredLabels: ["agent:drain"] } })
  await lanes.poll()
  lanes.issues[0] = issue(1, T(5))
  lanes.events = async () => [{ id: 1, event: "labeled", created_at: T(5) }]
  await lanes.poll()
  assert.equal(lanes.sent.length, 1)
  const plain = await world([issue(1, T(0))])
  await plain.poll()
  plain.issues[0] = issue(1, T(5))
  plain.events = async () => [labelEvent(T(5), "agent:drain")]
  await plain.poll()
  assert.equal(plain.sent.length, 1)
})

const plan = { ...DRAIN, ignoredBodyTrailers: ["Active-at", "Waiting-for", "Waiting-until"] }
const spec = "Fix the thing.\n\n- step one\n- step two"
const beat = (at, extra = "") => `${spec}${extra}\n\nActive-at: ${at}`

test("an edit that changed only ignored trailer lines wakes nobody, however they came or went", async () => {
  const w = await world([issue(1, T(0), "Issue 1", spec)], { drain: plan })
  await w.poll()
  const bodies = [
    beat(T(5)),
    beat(T(10)),
    `${beat(T(15))}\nWaiting-for: review of #3\nWaiting-until: 2026-11-14`,
    `${spec}\nwaiting-for:   a different reason\n\n  ACTIVE-AT: ${T(20)}\r\n`,
    spec,
  ]
  for (const [i, body] of bodies.entries()) {
    w.issues[0] = issue(1, T(5 + i * 5), "Issue 1", body)
    await w.poll()
  }
  assert.deepEqual(w.sent, [])
  matches(w.state().seen["1"], { updatedAt: T(25), ignored: "Active-at,Waiting-for,Waiting-until" })
})

test("a real edit made alongside a trailer edit wakes once, and only lines that start with a listed key are dropped", async () => {
  const w = await world([issue(1, T(0), "Issue 1", beat(T(0)))], { drain: plan })
  await w.poll()
  w.issues[0] = issue(1, T(5), "Issue 1", beat(T(5), "\n- step three"))
  await w.poll()
  assert.equal(w.sent.length, 1)
  w.issues[0] = issue(1, T(10), "Issue 1", beat(T(10), "\n- step three"))
  await w.poll()
  assert.equal(w.sent.length, 1)
  const prose = await world([issue(1, T(0), "Issue 1", "We set Active-at: now in prose.")], { drain: plan })
  await prose.poll()
  prose.issues[0] = issue(1, T(5), "Issue 1", "We set Active-at: later in prose.")
  await prose.poll()
  assert.equal(prose.sent.length, 1)
})

test("the same trailer edit wakes a repository with no such config; adding the keys later is honoured without a false wake", async () => {
  const w = await world([issue(1, T(0), "Issue 1", beat(T(0)))])
  await w.poll()
  w.issues[0] = issue(1, T(5), "Issue 1", beat(T(5)))
  await w.poll()
  assert.equal(w.sent.length, 1)
  assert.equal("ignored" in w.state().seen["1"], false)
  writeFileSync(w.paths.config, JSON.stringify({ drains: [plan] }))
  w.issues[0] = issue(1, T(10), "Issue 1", beat(T(10)))
  await w.poll()
  w.issues[0] = issue(1, T(15), "Issue 1", beat(T(15)))
  await w.poll()
  assert.equal(w.sent.length, 1)
  w.issues[0] = issue(1, T(20), "Issue 1", beat(T(20), "\n- step three"))
  await w.poll()
  assert.equal(w.sent.length, 2)
})

test("reads the plain updated_at an older version stored, and records the full revision from then on, for an issue with no body", async () => {
  const w = await world([{ number: 1, title: "Issue 1", updated_at: T(0), body: null }])
  writeFileSync(w.paths.state, JSON.stringify({ [DRAIN.repo]: { seeded: true, seen: { 1: T(0) }, pending: [] } }))
  await w.poll()
  assert.deepEqual(w.sent, [])
  matches(w.state().seen["1"], seenAt(T(0)))
})

test("an authentication or network failure wakes no one, leaves every marker and pending event alone and shows in the poll's errors", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues[0] = issue(1, "2026-11-13T02:00:00Z", "Issue 1", "edited")
  const before = structuredClone(w.state())
  const real = w.connect
  w.connect = async () => { throw new Error("the GitHub CLI has no token for maintainer") }
  const out = await w.poll(NOW + 1000)
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(out.errors, [{ repo: DRAIN.repo, error: "the GitHub CLI has no token for maintainer" }])
  assert.deepEqual(w.state(), { ...before, lastPollAt: new Date(NOW + 1000).toISOString(), lastError: "the GitHub CLI has no token for maintainer" })
  w.connect = real
  const api = w.api.openIssues
  w.api.openIssues = async () => { throw new Error("GitHub answered HTTP 502") }
  await w.poll(NOW + 2000)
  assert.deepEqual(w.sent, [])
  matches(w.state(), { lastError: "GitHub answered HTTP 502" })
  assert.deepEqual(w.state().seen, before.seen)
  w.api.openIssues = api
  await w.poll(NOW + 3000)
  assert.equal(w.sent.length, 1)
  assert.equal(w.state().lastError, undefined)
})

test("a failure on the very first poll leaves the drain unseeded, so the next good poll still records without waking", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  const real = w.connect
  w.connect = async () => { throw new Error("GitHub answered HTTP 401 for /user") }
  await w.poll()
  matches(w.state(), { seeded: false, lastError: "GitHub answered HTTP 401 for /user" })
  assert.deepEqual(w.state().seen, {})
  assert.equal(w.state().openCount, undefined)
  w.connect = real
  await w.poll()
  assert.deepEqual(w.sent, [])
  matches(w.state(), { seeded: true, openCount: 1 })
})

test("a failure while reading comments leaves the markers where they were", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z"), issue(2, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.splice(0, 2, issue(1, "2026-11-13T02:00:00Z"), issue(2, "2026-11-13T02:00:00Z"))
  let calls = 0
  w.comments = async () => {
    if (calls++ === 0) throw new Error("GitHub answered HTTP 403")
    return [{ id: 1, body: "me too", updated_at: "2026-11-13T02:00:00Z", user: { login: "someone" } }]
  }
  await w.poll()
  assert.deepEqual(w.sent, [])
  assert.deepEqual(w.state().seen, { 1: { updatedAt: "2026-11-13T01:00:00Z", digest: w.state().seen["1"].digest }, 2: { updatedAt: "2026-11-13T01:00:00Z", digest: w.state().seen["2"].digest } })
  await w.poll()
  assert.equal(w.sent.length, 1)
})

test("keeps recorded events when the wake is refused, then sends them with the next poll's changes in one message", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues[0] = issue(1, "2026-11-13T02:00:00Z", "Issue 1", "v2")
  w.refuse = "the app did not answer in time"
  await w.poll()
  matches(w.state(), { lastError: "the wake was not delivered: the app did not answer in time" })
  assert.deepEqual(w.state().pending, [{ number: 1, title: "Issue 1", updatedAt: "2026-11-13T02:00:00Z" }])
  w.issues[0] = issue(1, "2026-11-13T03:00:00Z", "Issue 1", "v3")
  w.issues.push(issue(2, "2026-11-13T03:00:00Z"))
  await w.poll()
  assert.deepEqual(w.sent.at(-1), [DRAIN.session, "New or changed issues in acme/widgets: #1 Issue 1, #2 Issue 2. Drain them."])
  matches(w.state(), { lastWakeCount: 2 })
  assert.deepEqual(w.state().pending, [])
})

test("a wake that is never acknowledged comes back with every poll until it is, and a restart loses nothing", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues[0] = issue(1, "2026-11-13T02:00:00Z", "Issue 1", "v2")
  const first = await pollDrains({ paths: w.paths, connect: w.connect, now: NOW, ackCommand: ["node", "drains.js"] })
  const second = await pollDrains({ paths: w.paths, connect: w.connect, now: NOW + 1000, ackCommand: ["node", "drains.js"] })
  assert.equal(first.wakes.length, 1)
  assert.deepEqual(second.wakes, first.wakes)
  assert.equal(first.wakes[0].id, wakeId(DRAIN.repo, first.wakes[0].events))
  assert.deepEqual(first.wakes[0].done, ["node", "drains.js", "ack", "--repo", DRAIN.repo, "--wake", first.wakes[0].id])
})

test("saves the seen revision and the event before it hands out the wake", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues[0] = issue(1, "2026-11-13T02:00:00Z", "Issue 1", "v2")
  const out = await pollDrains({ paths: w.paths, connect: w.connect, now: NOW, ackCommand: ["node", "drains.js"] })
  const onDisk = readDrainStates(w.paths.state)[DRAIN.repo]
  matches(onDisk.seen["1"], seenAt("2026-11-13T02:00:00Z"))
  assert.deepEqual(onDisk.pending, out.wakes[0].events)
})

test("an ack for an older batch does not clear a newer one, and an ack with nothing waiting changes nothing", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues[0] = issue(1, "2026-11-13T02:00:00Z", "Issue 1", "v2")
  const first = await pollDrains({ paths: w.paths, connect: w.connect, now: NOW, ackCommand: [] })
  w.issues[0] = issue(1, "2026-11-13T03:00:00Z", "Issue 1", "v3")
  await pollDrains({ paths: w.paths, connect: w.connect, now: NOW, ackCommand: [] })
  const stale = ackWake({ paths: w.paths, repo: DRAIN.repo, wake: first.wakes[0].id, now: NOW })
  assert.equal(stale.changed, false)
  assert.match(stale.reason, /changed after this wake was made/u)
  assert.equal(w.state().pending.length, 1)
  const current = ackWake({ paths: w.paths, repo: DRAIN.repo, wake: wakeId(DRAIN.repo, w.state().pending), now: NOW })
  assert.equal(current.changed, true)
  assert.deepEqual(ackWake({ paths: w.paths, repo: DRAIN.repo, wake: "x", now: NOW }), { ok: true, changed: false, reason: "nothing is waiting" })
  assert.deepEqual(ackWake({ paths: w.paths, repo: "other/repo", wake: "x", now: NOW }), { ok: true, changed: false, reason: "nothing is waiting" })
})

test("a refusal with no reason is still recorded as a failed wake", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues[0] = issue(1, "2026-11-13T02:00:00Z", "Issue 1", "v2")
  w.refuse = "the app refused the message"
  await w.poll()
  assert.equal(w.state().lastError, "the wake was not delivered: the app refused the message")
  assert.equal(w.state().pending.length, 1)
})

test("polls every drain once, one wake per repository, and forgets repositories no longer configured", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const paths = { config: path.join(dir, "config.json"), state: path.join(dir, "state.json"), lock: path.join(dir, "poll.lock") }
  const other = { repo: "acme/gadgets", session: "9fd90fff-2ae7-4f49-8356-bd8c0b66d6db" }
  writeFileSync(paths.config, JSON.stringify({ drains: [DRAIN, other] }))
  let updated = "2026-11-13T01:00:00Z"
  let title = "before"
  const connect = async () => ({ login: "x", openIssues: async (repo) => [issue(repo === DRAIN.repo ? 1 : 7, updated, title)], comments: async () => [], issueEvents: async () => [] })
  const run = (at) => pollDrains({ paths, connect, now: at, ackCommand: [] })
  assert.deepEqual((await run(NOW)).wakes, [])
  updated = "2026-11-13T02:00:00Z"
  title = "after"
  const out = await run(NOW)
  assert.deepEqual(out.wakes.map((wake) => wake.session), [DRAIN.session, other.session])
  writeFileSync(paths.config, JSON.stringify({ drains: [DRAIN] }))
  await run(NOW)
  assert.deepEqual(Object.keys(readDrainStates(paths.state)), [DRAIN.repo])
  assert.deepEqual(readDrainStates(path.join(dir, "missing.json")), {})
})

test("wakeMessage shortens long titles and long lists", () => {
  const events = Array.from({ length: 22 }, (_, i) => ({ number: i + 1, title: i === 0 ? "x".repeat(200) : "t", updatedAt: "u" }))
  const text = wakeMessage("a/b", events)
  assert.ok(text.includes(`#1 ${"x".repeat(119)}…, #2 t`))
  assert.match(text, /#20 t, and 2 more\. Drain them\.$/u)
})

test("status lines show last poll, open count, events waiting, last wake and last error per drain", () => {
  const drains = [DRAIN, { repo: "acme/gadgets", session: "48a0f0ab-56ad-406d-8831-5352815be337" }, { repo: "a/b", session: "12345678-0000" }, { repo: "c/d", session: "abcdefgh-1" }]
  const states = {
    [DRAIN.repo]: { seeded: true, seen: {}, pending: [{ number: 1, title: "t", updatedAt: "u" }], lastPollAt: new Date(NOW - 20_000).toISOString(), openCount: 7, lastWakeAt: new Date(NOW - 12 * 60_000).toISOString(), lastWakeCount: 1, lastError: "GitHub answered HTTP 502" },
    "acme/gadgets": { seeded: true, seen: {}, pending: [], lastPollAt: new Date(NOW - 4 * HOUR).toISOString(), lastWakeAt: new Date(NOW - 3 * HOUR).toISOString(), lastWakeCount: 3 },
    "c/d": { seeded: true, seen: {}, pending: [], lastPollAt: new Date(NOW).toISOString(), openCount: 0 },
  }
  assert.deepEqual(drainStatusLines(drains, states, NOW), [
    "issue drain acme/widgets -> 58fbd57e: polled just now, 7 open, 1 waiting, last wake 12m ago (1 issue), last error: GitHub answered HTTP 502",
    "issue drain acme/gadgets -> 48a0f0ab: polled 4h ago, ? open, 0 waiting, last wake 3h ago (3 issues)",
    "issue drain a/b -> 12345678: not polled yet",
    "issue drain c/d -> abcdefgh: polled just now, 0 open, 0 waiting, last wake never",
  ])
})

test("the config is validated, never silently trimmed to fewer drains", () => {
  const ok = parseDrainConfig(JSON.stringify({ drains: [{ repo: "a/b", session: " s ", account: " me ", ignoredBodyTrailers: [" Active-at "], ignoredLabels: [" agent:drain "], ignoreComments: [{ author: " ci[bot] ", match: "^took" }, { author: "other[bot]" }] }, { repo: "c/d", session: "t" }] }), "config.json")
  assert.deepEqual(ok, [{ repo: "a/b", session: "s", account: "me", ignoredBodyTrailers: ["Active-at"], ignoredLabels: ["agent:drain"], ignoreComments: [{ author: "ci[bot]", match: "^took" }, { author: "other[bot]" }] }, { repo: "c/d", session: "t" }])
  for (const [entry, message] of [
    [null, "drains[0] is not an object"],
    [{ repo: "no-slash", session: "s" }, "drains[0].repo"],
    [{ repo: "a/b", session: " " }, "drains[0].session"],
    [{ repo: "a/b", session: "s", account: 3 }, "drains[0].account"],
    [{ repo: "a/b", session: "s", ignoredBodyTrailers: "Active-at" }, "drains[0].ignoredBodyTrailers"],
    [{ repo: "a/b", session: "s", ignoredBodyTrailers: ["Active-at:"] }, "drains[0].ignoredBodyTrailers"],
    [{ repo: "a/b", session: "s", ignoredBodyTrailers: [3] }, "drains[0].ignoredBodyTrailers"],
    [{ repo: "a/b", session: "s", ignoredLabels: "agent:drain" }, "drains[0].ignoredLabels"],
    [{ repo: "a/b", session: "s", ignoredLabels: [" "] }, "drains[0].ignoredLabels"],
    [{ repo: "a/b", session: "s", ignoreComments: "ci[bot]" }, "drains[0].ignoreComments is not a list"],
    [{ repo: "a/b", session: "s", ignoreComments: [null] }, "drains[0].ignoreComments[0].author"],
    [{ repo: "a/b", session: "s", ignoreComments: [{ author: " " }] }, "drains[0].ignoreComments[0].author"],
    [{ repo: "a/b", session: "s", ignoreComments: [{ author: "ci[bot]", match: 3 }] }, "drains[0].ignoreComments[0].match is not a regular expression"],
    [{ repo: "a/b", session: "s", ignoreComments: [{ author: "ci[bot]", match: "(" }] }, "drains[0].ignoreComments[0].match is not a valid regular expression"],
  ]) assert.throws(() => parseDrainConfig(JSON.stringify({ drains: [entry] }), "config.json"), (error) => error.message.includes(message), message)
  assert.throws(() => parseDrainConfig(JSON.stringify({ drains: [{ repo: "a/b", session: "s" }, { repo: "a/b", session: "t" }] }), "config.json"), /listed twice/u)
  assert.throws(() => parseDrainConfig("{", "config.json"), /not valid JSON/u)
  assert.throws(() => parseDrainConfig("[]", "config.json"), /no "drains" array/u)
  assert.throws(() => parseDrainConfig('{"drains":{}}', "config.json"), /no "drains" array/u)
})

test("a missing config is no drains; an unreadable one is a failure that says why", async () => {
  const dir = await mkTempRoot("desk-drains-")
  assert.deepEqual(readDrainConfig(path.join(dir, "none.json")), [])
  assert.throws(() => readDrainConfig(dir), /cannot be read \(EISDIR\)/u)
})

test("state and config live in Desk's state folder, from XDG_STATE_HOME or the home folder", () => {
  assert.equal(drainsHome({ env: { XDG_STATE_HOME: "/x/state" }, homeDir: "/h" }), path.join("/x/state", "ouroboros-skills", "desk", "drains"))
  assert.equal(drainsHome({ env: { XDG_STATE_HOME: "relative" }, homeDir: "/h" }), path.join("/h", ".local", "state", "ouroboros-skills", "desk", "drains"))
  assert.equal(drainsHome({ env: {}, homeDir: "/h" }), path.join("/h", ".local", "state", "ouroboros-skills", "desk", "drains"))
  assert.ok(drainsHome().endsWith(path.join("ouroboros-skills", "desk", "drains")))
  assert.equal(drainPaths().config, path.join(drainsHome(), "config.json"))
  assert.deepEqual(drainPaths({ env: { XDG_STATE_HOME: "/x" } }), { config: path.join("/x", "ouroboros-skills", "desk", "drains", "config.json"), state: path.join("/x", "ouroboros-skills", "desk", "drains", "state.json"), lock: path.join("/x", "ouroboros-skills", "desk", "drains", "poll.lock") })
})

test("the lock refuses a second live owner, takes over an abandoned or stale one and is released afterwards", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  assert.equal(await withDrainLock(lock, async () => "done"), "done")
  assert.throws(() => readFileSync(lock), { code: "ENOENT" })
  await assert.rejects(withDrainLock(lock, () => withDrainLock(lock, () => "inner")), /process \d+ holds .* and is still working/u)
  assert.throws(() => readFileSync(lock), { code: "ENOENT" })
  writeFileSync(lock, "999999")
  assert.equal(await withDrainLock(lock, () => "took over", { alive: () => false }), "took over")
  writeFileSync(lock, String(spawnSync(process.execPath, ["-e", ""]).pid))
  assert.equal(await withDrainLock(lock, () => "dead owner"), "dead owner")
  writeFileSync(lock, String(process.pid))
  const old = new Date(Date.now() - 3_600_000)
  utimesSync(lock, old, old)
  assert.equal(await withDrainLock(lock, () => "stale", { now: Date.now() }), "stale")
  writeFileSync(lock, "not a pid")
  assert.equal(await withDrainLock(lock, () => "garbage"), "garbage")
  await assert.rejects(withDrainLock(lock, () => { throw new Error("work failed") }), /work failed/u)
  await fs.mkdir(path.join(dir, "dir.lock"))
  await assert.rejects(withDrainLock(path.join(dir, "dir.lock"), () => "never"))
  assert.throws(() => readFileSync(lock), { code: "ENOENT" })
  writeFileSync(lock, "999999")
  await assert.rejects(withDrainLock(lock, () => "never", { alive: () => true }), /holds .* and is still working/u)
  await fs.rm(lock)
})

test("a lock that cannot be created for another reason than an existing owner is reported as it is", async () => {
  const dir = await mkTempRoot("desk-drains-")
  await assert.rejects(withDrainLock(path.join(dir, `${"x".repeat(400)}.lock`), () => "x"), (error) => error.code !== "EEXIST")
})

const response = (body, { status = 200, link = null } = {}) => ({ ok: status < 400, status, json: async () => body, headers: { get: () => link } })

test("lists open issues without pull requests across pages and reads comments since a time, with the account's token", async () => {
  const spawned = []
  const spawn = (...args) => { spawned.push(args); return { status: 0, stdout: "tok\n" } }
  const answers = [
    response([issue(1, "u1"), { ...issue(2, "u2"), pull_request: {} }], { link: '<next>; rel="next"' }),
    response([issue(3, "u3")]),
    response([{ body: "c", updated_at: "u" }]),
    response([{ id: 1, event: "reopened", created_at: "u" }]),
  ]
  const urls = []
  const headers = []
  const fetchImpl = async (url, init) => { urls.push(url); headers.push(init.headers); return answers.shift() }
  const api = await connectGithub("maintainer", { spawn, fetchImpl, env: { PATH: "/bin", GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient", GH_HOST: "x" } })
  assert.deepEqual(spawned[0].slice(0, 2), ["gh", ["auth", "token", "--hostname", "github.com", "--user", "maintainer"]])
  assert.deepEqual(Object.keys(spawned[0][2].env).filter((name) => /TOKEN|HOST/u.test(name)), [])
  assert.equal(api.login, "maintainer")
  assert.deepEqual((await api.openIssues("o/r")).map((item) => item.number), [1, 3])
  assert.equal(urls[0], "https://api.github.com/repos/o/r/issues?state=open&sort=updated&direction=desc&per_page=100&page=1")
  assert.ok(urls[1].endsWith("&page=2"))
  assert.equal(headers[0].Authorization, "Bearer tok")
  assert.deepEqual(await api.comments("o/r", 5, "2026-11-13T01:00:00Z"), [{ body: "c", updated_at: "u" }])
  assert.equal(urls[2], "https://api.github.com/repos/o/r/issues/5/comments?since=2026-11-13T01%3A00%3A00Z&per_page=100&page=1")
  assert.deepEqual(await api.issueEvents("o/r", 5), [{ id: 1, event: "reopened", created_at: "u" }])
  assert.equal(urls[3], "https://api.github.com/repos/o/r/issues/5/events?per_page=100&page=1")
})

test("asks GitHub who the active account is when none is configured", async () => {
  const spawned = []
  const spawn = (...args) => { spawned.push(args); return { status: 0, stdout: "tok" } }
  const answers = [response({ login: "ari" }), response({})]
  const fetchImpl = async () => answers.shift()
  assert.equal((await connectGithub(undefined, { spawn, fetchImpl })).login, "ari")
  assert.deepEqual(spawned[0][1], ["auth", "token", "--hostname", "github.com"])
  assert.equal((await connectGithub(undefined, { spawn, fetchImpl })).login, "")
})

test("fails with a fix when the CLI has no token, and names the HTTP status without the query when GitHub refuses", async () => {
  const none = { spawn: () => ({ status: 1, stdout: "" }) }
  await assert.rejects(connectGithub("nobody", none), /no token for nobody \(run `gh auth login --hostname github\.com`\)/u)
  await assert.rejects(connectGithub(undefined, none), /its active account/u)
  await assert.rejects(connectGithub("nobody", { spawn: () => ({ status: 0 }) }), /no token/u)
  const answers = [response({ login: "x" })]
  const fetchImpl = async () => answers.shift() ?? response({}, { status: 403 })
  const ok = await connectGithub(undefined, { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl })
  await assert.rejects(ok.openIssues("o/r"), /GitHub answered HTTP 403 for \/repos\/o\/r\/issues$/u)
})

test("a CLI with no token for the account is a failure that says what to run, with the real defaults", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const isolated = { HOME: dir, USERPROFILE: dir, XDG_STATE_HOME: dir, XDG_CONFIG_HOME: dir, GH_CONFIG_DIR: dir, PATH: "/nonexistent" }
  await assert.rejects(connectGithub("no-such-account-for-drains-test", { env: isolated }), /no token for no-such-account-for-drains-test/u)
  await assert.rejects(connectGithub("no-such-account-for-drains-test", { spawn: () => ({ status: 1 }) }), /no token/u)
  await assert.rejects(connectGithub("no-such-account-for-drains-test"), /no token/u)
})

test("a state file that is not an object reads as no state", async () => {
  const dir = await mkTempRoot("desk-drains-")
  for (const text of ["[]", "null", "{", "7"]) {
    writeFileSync(path.join(dir, "s.json"), text)
    assert.deepEqual(readDrainStates(path.join(dir, "s.json")), {})
  }
})

test("pollDrain records a drain that has no state yet", async () => {
  const states = {}
  await pollDrain(DRAIN, states, { connect: async () => ({ login: "x", openIssues: async () => [], comments: async () => [], issueEvents: async () => [] }), now: NOW })
  matches(states[DRAIN.repo], { seeded: true, openCount: 0, lastPollAt: new Date(NOW).toISOString() })
})

test("the command line parses its commands and refuses what it does not know", () => {
  assert.deepEqual(parseDrainsArgs([]), { help: true })
  assert.deepEqual(parseDrainsArgs(["-h"]), { help: true })
  assert.deepEqual(parseDrainsArgs(["poll", "--state", "s.json"]), { command: "poll", flags: { state: "s.json" } })
  assert.match(parseDrainsArgs(["nope"]).error, /unknown command "nope"/u)
  assert.match(parseDrainsArgs(["poll", "--repo", "a/b"]).error, /does not take "--repo"/u)
  assert.match(parseDrainsArgs(["poll", "--state"]).error, /--state needs a value/u)
  assert.match(parseDrainsArgs(["poll", "--state", "--config"]).error, /--state needs a value/u)
  assert.match(parseDrainsArgs(["ack", "--repo", "a/b"]).error, /ack needs --repo and --wake/u)
})

function cli(argv, extra = {}) {
  const out = []
  const err = []
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } }
  return runDrainsCli({ argv, script: SCRIPT, io, ...extra }).then((code) => ({ code, out: out.join(""), err: err.join("") }))
}

test("poll, ack and status run end to end through the command line, with the state and config passed as flags", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const config = path.join(dir, "config.json")
  const state = path.join(dir, "state.json")
  writeFileSync(config, JSON.stringify({ drains: [DRAIN] }))
  let updated = "2026-11-13T01:00:00Z"
  const connect = async () => ({ login: "x", openIssues: async () => [issue(1, updated, "T", updated)], comments: async () => [], issueEvents: async () => [] })
  const flags = ["--config", config, "--state", state]
  const first = await cli(["poll", ...flags], { connect, now: () => NOW })
  assert.equal(first.code, 0)
  assert.deepEqual(JSON.parse(first.out).wakes, [])
  updated = "2026-11-13T02:00:00Z"
  const second = JSON.parse((await cli(["poll", ...flags], { connect, now: () => NOW })).out)
  assert.equal(second.wakes.length, 1)
  assert.equal(second.wakes[0].message, "New or changed issues in acme/widgets: #1 T. Drain them.")
  assert.deepEqual(second.wakes[0].done.slice(0, 2), [process.execPath, SCRIPT])
  assert.deepEqual(second.wakes[0].done.slice(-2), ["--state", state])
  const unflagged = JSON.parse((await cli(["poll", "--config", config], { connect, now: () => NOW })).out)
  assert.equal(unflagged.wakes.length, 0)
  const failed = await cli([...second.wakes[0].done.slice(2), "--error", "no answer"], { now: () => NOW })
  assert.equal(JSON.parse(failed.out).changed, true)
  assert.equal(readDrainStates(state)[DRAIN.repo].lastError, "the wake was not delivered: no answer")
  assert.equal(readDrainStates(state)[DRAIN.repo].pending.length, 1)
  const status = JSON.parse((await cli(["status", ...flags], { now: () => NOW })).out)
  assert.match(status.status[0], /1 waiting, last wake never, last error: the wake was not delivered: no answer$/u)
  const delivered = await cli(second.wakes[0].done.slice(2), { now: () => NOW })
  assert.equal(JSON.parse(delivered.out).changed, true)
  assert.deepEqual(readDrainStates(state)[DRAIN.repo].pending, [])
})

test("the command line says what is wrong: usage, a busy lock and a bad config", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const config = path.join(dir, "config.json")
  const state = path.join(dir, "state.json")
  assert.equal((await cli([])).code, 0)
  assert.match((await cli(["--help"])).out, /^Usage: drains\.js poll/u)
  const usage = await cli(["poll", "--bogus", "x"])
  assert.equal(usage.code, 2)
  assert.match(usage.err, /^drains: poll does not take "--bogus"/u)
  writeFileSync(config, "{")
  const bad = await cli(["poll", "--config", config, "--state", state])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /^desk: drains config: .* is not valid JSON/u)
  writeFileSync(`${state}.lock`, String(process.pid))
  const busy = await cli(["status", "--config", config, "--state", state], { now: () => NOW })
  assert.equal(busy.code, 1)
  const locked = await cli(["poll", "--config", config, "--state", state])
  assert.match(locked.err, /holds .* and is still working/u)
})

test("the script runs as a program and prints the poll's JSON", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const home = path.join(dir, "state")
  const run = spawnSync(process.execPath, [SCRIPT, "status"], { encoding: "utf8", env: { ...process.env, HOME: dir, XDG_STATE_HOME: home } })
  assert.equal(run.status, 0, run.stderr)
  const printed = JSON.parse(run.stdout)
  assert.deepEqual(printed.status, [])
  assert.equal(printed.launcher.path, path.join(home, "ouroboros-skills", "desk", "drains", "run.mjs"))
  assert.equal(printed.launcher.sha256, sha256Of(LAUNCHER))
  assert.equal(sha256Of(printed.launcher.path), sha256Of(LAUNCHER))
})

const LAUNCHER = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/drains-launcher.mjs", import.meta.url))
const sha256Of = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")

test("the launcher is installed at the stable path, kept identical to the shipped source and restored when it drifts", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const env = { XDG_STATE_HOME: dir }
  const first = installLauncher({ env })
  assert.equal(first.path, path.join(dir, "ouroboros-skills", "desk", "drains", "run.mjs"))
  assert.equal(first.changed, true)
  assert.equal(first.sha256, sha256Of(LAUNCHER))
  assert.equal(sha256Of(first.path), first.sha256)
  assert.equal(installLauncher({ env }).changed, false)
  writeFileSync(first.path, "// edited by hand\n")
  assert.equal(installLauncher({ env }).changed, true)
  assert.equal(sha256Of(first.path), first.sha256)
  const other = path.join(dir, "other-launcher.mjs")
  writeFileSync(other, "// a newer launcher\n")
  const updated = installLauncher({ env, source: other })
  assert.equal(updated.sha256, sha256Of(other))
  assert.equal(sha256Of(first.path), sha256Of(other))
  assert.equal(installLauncher({ env: {}, homeDir: dir, source: other }).path, path.join(dir, ".local", "state", "ouroboros-skills", "desk", "drains", "run.mjs"))
  assert.equal(installLauncher().sha256, first.sha256)
})

test("a launcher that cannot be refreshed never stops a command, and the output says why", async () => {
  const dir = await mkTempRoot("desk-drains-")
  writeFileSync(path.join(dir, "blocker"), "x")
  const out = []
  const io = { stdout: { write: (text) => out.push(text) }, stderr: { write: () => {} } }
  const config = path.join(dir, "config.json")
  const state = path.join(dir, "state.json")
  writeFileSync(config, JSON.stringify({ drains: [] }))
  const code = await runDrainsCli({ argv: ["status", "--config", config, "--state", state], script: SCRIPT, io, env: { XDG_STATE_HOME: path.join(dir, "blocker") }, now: () => NOW })
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join("")), { status: [], launcher: { error: "ENOTDIR" } })
})
