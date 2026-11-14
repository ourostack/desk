// Issue drains: what the poll records, what it ignores and what it hands a runner to deliver. The GitHub side is a fake; every
// state, config and lock file lives under a temporary root.
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { promises as fs, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import {
  ackWake, connectGithub, DRAIN_STATUS_MARKER, drainPaths, drainsHome, deskInUse, drainStatusLines, installLauncher, parseDrainConfig, pollDrain, pollDrains, quotaHold, quotaLines,
  readDrainConfig, readDrainStates, wakeId, wakeMessage, whyOf, withDrainLock,
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
  w.timeline = async () => []
  w.pull = async () => ({})
  w.api = {
    login: "maintainer",
    openIssues: async () => w.issues,
    comments: async (...args) => { w.calls.comments.push(args); return w.comments(...args) },
    issueEvents: (...args) => w.events(...args),
    timeline: (...args) => w.timeline(...args),
    pull: (...args) => w.pull(...args),
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
  assert.deepEqual(w.sent, [[DRAIN.session, "New or changed issues in acme/widgets: #2 New thing (new issue). Drain them."]])
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
  assert.deepEqual(w.sent, [[DRAIN.session, "New or changed issues in acme/widgets: #1 One with lines (title or body edited), #3 Issue 3 (new issue), #4 Issue 4 (new issue). Drain them."]])
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
  assert.deepEqual(w.sent.at(-1), [DRAIN.session, "New or changed issues in acme/widgets: #2 Issue 2 (title or body edited). Drain them."])
  w.issues.length = 0
  await w.poll()
  await w.poll()
  assert.equal(w.sent.length, 2)
})

// Cross-references live in the issue timeline, not the events feed. The poll reads the timeline only when an issue's `updated_at` moved
// and nothing else was news, and only a cross-reference that is not the drain's own work wakes the drain.
const sourceIssue = (number, extra = {}) => ({ number, repository_url: "https://api.github.com/repos/acme/widgets", ...extra })
const crossReference = (created_at, issueSource, id = 1) => ({ id, event: "cross-referenced", created_at, actor: { login: "maintainer" }, source: { type: "issue", issue: issueSource } })

async function quiet(extra = {}) {
  const w = await world([issue(1, T(0)), issue(2, T(0))])
  await w.poll()
  w.issues[0] = issue(1, T(5))
  w.comments = async (repo, n) => (n === 1 || !extra.comments ? [] : extra.comments(repo, n))
  w.timeline = extra.timeline ?? (async () => [])
  w.pull = extra.pull ?? (async () => ({ head: { ref: "feature/x" } }))
  return w
}

test("the drain's marked status comment followed two seconds later by its own drain: label wakes nobody, however the polls fall around them, and the marker advances", async () => {
  const created = "2026-11-13T20:51:13Z"
  const commentAt = "2026-11-14T01:11:27Z"
  const labelAt = "2026-11-14T01:11:29Z"
  const marked = statusComment(6869126791, commentAt, "maintainer")
  const label = labelEvent(labelAt, "drain: triaged")
  const cases = [
    ["one poll after both", [], created, [marked], [label]],
    ["a poll between the comment and the label", [commentAt], commentAt, [marked], [label]],
    ["a poll that saw the comment but not yet the label event", [], labelAt, [marked], []],
    ["a poll that saw the new updated_at before either record could be listed", [], labelAt, [], []],
  ]
  for (const [name, between, updatedAt, comments, events] of cases) {
    const w = await world([issue(890, created)])
    await w.poll()
    for (const at of between) {
      w.issues[0] = issue(890, at)
      w.comments = async () => [marked]
      w.events = async () => []
      await w.poll()
      matches(w.state().seen["890"], seenAt(at))
    }
    w.issues[0] = issue(890, updatedAt)
    w.comments = async (_repo, _n, since) => comments.filter((comment) => comment.updated_at > since)
    w.events = async () => events
    const out = await w.poll()
    assert.deepEqual(out.wakes, [], name)
    assert.deepEqual(w.state().pending, [], name)
    matches(w.state().seen["890"], seenAt(updatedAt))
    // The next poll, with the label listed too and nothing newer, is quiet as well.
    w.issues[0] = issue(890, labelAt)
    w.comments = async () => [marked]
    w.events = async () => [label]
    assert.deepEqual((await w.poll()).wakes, [], name)
    matches(w.state().seen["890"], seenAt(labelAt))
  }
})

test("an issue the drain filed or already triaged is seen on arrival: a drain: label or the status marker in its body, then only the drain's own marked activity, wakes nobody", async () => {
  const filed = [
    ["a drain: label already applied", { labels: [{ name: "Drain: triaged" }, { name: "bug" }] }],
    ["the status marker in the body", { body: `Filed by the drain.\n${DRAIN_STATUS_MARKER}` }],
  ]
  for (const [name, extra] of filed) {
    const w = await world([issue(1, T(0))])
    await w.poll()
    w.issues.push({ ...issue(2, T(5)), ...extra })
    w.comments = async (_repo, n) => (n === 2 ? [statusComment(7, T(5))] : [])
    w.events = async (_repo, n) => (n === 2 ? [labelEvent(T(5), "drain: triaged")] : [])
    assert.deepEqual((await w.poll()).wakes, [], name)
    matches(w.state().seen["2"], seenAt(T(5)))
    // The drain's own status comment afterwards is quiet too; someone else's comment is news.
    w.issues[1] = { ...w.issues[1], updated_at: T(7) }
    w.comments = async (_repo, n) => (n === 2 ? [statusComment(7, T(5)), statusComment(8, T(7))] : [])
    assert.deepEqual((await w.poll()).wakes, [], name)
    w.issues[1] = { ...w.issues[1], updated_at: T(9) }
    w.comments = async (_repo, n) => (n === 2 ? [{ id: 9, body: "me too", updated_at: T(9), user: { login: "someone" } }] : [])
    const out = await w.poll()
    assert.equal(out.wakes[0].events[0].why, "comment 9 by someone", name)
  }
  // Any other new issue still wakes: no labels, a label outside the namespace, a label with no name.
  for (const extra of [{}, { labels: [{ name: "bug" }] }, { labels: [{}] }, { labels: [null] }, { body: undefined }]) {
    const w = await world([issue(1, T(0))])
    await w.poll()
    w.issues.push({ ...issue(2, T(5)), ...extra })
    assert.equal((await w.poll()).wakes[0].events[0].why, "new issue", JSON.stringify(extra))
  }
})

const S = (second, minute = 5) => `2026-11-13T01:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}Z`
const lifecycle = (event, created_at, actor = "maintainer", extra = {}) => ({ id: 1, event, created_at, ...(actor ? { actor: { login: actor } } : {}), ...extra })
const claimLabel = (created_at, actor = "maintainer") => lifecycle("labeled", created_at, actor, { label: { name: "drain: in progress" } })

test("a reopen that is the drain claiming the issue (its own drain: label change within a minute) wakes nobody; any other reopen does", async () => {
  const cases = [
    ["the claim label, then the reopen two seconds later", [claimLabel(S(22)), lifecycle("reopened", S(24))], false],
    ["the reopen, then the claim label", [lifecycle("reopened", S(22)), claimLabel(S(24))], false],
    ["a drain: label removal beside the reopen", [lifecycle("unlabeled", S(22), "maintainer", { label: { name: "drain: triaged" } }), lifecycle("reopened", S(24))], false],
    ["a reopen by someone else beside the drain's label", [claimLabel(S(22)), lifecycle("reopened", S(24), "someone")], true],
    ["a reopen by the drain beside someone else's drain: label", [claimLabel(S(22), "someone"), lifecycle("reopened", S(24))], true],
    ["a drain: label from two minutes earlier", [claimLabel(S(22, 3)), lifecycle("reopened", S(24))], true],
    ["a reopen with no actor", [claimLabel(S(22)), lifecycle("reopened", S(24), null)], true],
    ["a claim label with no actor", [claimLabel(S(22), null), lifecycle("reopened", S(24))], true],
    ["a reopen with no claim at all", [lifecycle("reopened", S(24))], true],
  ]
  for (const [name, events, wakes] of cases) {
    const w = await world([issue(1, T(0))])
    await w.poll()
    w.issues[0] = issue(1, S(24))
    w.events = async () => events
    const out = await w.poll()
    assert.equal(out.wakes.length, wakes ? 1 : 0, name)
    if (wakes) assert.equal(out.wakes[0].events[0].why, "reopened", name)
    matches(w.state().seen["1"], seenAt(S(24)))
  }
  // A poll that fell between the claim label and the reopen still sees the label.
  const w = await world([issue(1, T(0))])
  await w.poll()
  w.issues[0] = issue(1, S(23))
  w.events = async () => [claimLabel(S(22))]
  assert.deepEqual((await w.poll()).wakes, [])
  w.issues[0] = issue(1, S(24))
  w.events = async () => [claimLabel(S(22)), lifecycle("reopened", S(24))]
  assert.deepEqual((await w.poll()).wakes, [])
})

test("a commit that references the issue from a drain branch (a referenced event) wakes nobody, and the marker advances", async () => {
  const w = await world([issue(1, T(3))])
  await w.poll()
  w.issues[0] = issue(1, T(5))
  w.events = async () => [lifecycle("referenced", T(4), "maintainer", { commit_id: "6a0688fd", commit_url: "https://api.github.com/repos/acme/widgets/commits/6a0688fd" })]
  const out = await w.poll()
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(w.state().pending, [])
  matches(w.state().seen["1"], seenAt(T(5)))
  // Another commit reference, later, wakes nobody either.
  w.issues[0] = issue(1, T(8))
  w.events = async () => [lifecycle("referenced", T(7), "maintainer", { commit_id: "b8d47b8e" })]
  assert.deepEqual((await w.poll()).wakes, [])
  matches(w.state().seen["1"], seenAt(T(8)))
})

test("an edit to the drain's own marked comment, whose created_at did not change, wakes nobody, and the marker advances", async () => {
  const w = await world([issue(1, T(3))])
  await w.poll()
  w.issues[0] = issue(1, T(5))
  const edited = { id: 6869127858, body: `Status.\n${DRAIN_STATUS_MARKER}`, created_at: T(1), updated_at: T(5), user: { login: "maintainer" } }
  w.comments = async (_repo, _n, since) => [edited].filter((comment) => comment.updated_at > since)
  const out = await w.poll()
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(w.state().pending, [])
  matches(w.state().seen["1"], seenAt(T(5)))
  // Edited again later: still the drain's own.
  w.issues[0] = issue(1, T(9))
  edited.updated_at = T(9)
  assert.deepEqual((await w.poll()).wakes, [])
  matches(w.state().seen["1"], seenAt(T(9)))
})

test("state written by an earlier release is read as it is: a closed issue the drain unlabeled, and an open one it only commented on, stay quiet after the release", async () => {
  const w = await world([issue(1, T(0)), issue(2, T(0))])
  await w.poll()
  w.issues.splice(1, 1)
  await w.poll(NOW + 1000)
  // Rewrite the state the way an earlier release left it: no lastOkAt, no history, no seenAt on events.
  const states = JSON.parse(readFileSync(w.paths.state, "utf8"))
  delete states[DRAIN.repo].lastOkAt
  delete states[DRAIN.repo].history
  writeFileSync(w.paths.state, JSON.stringify(states))
  assert.equal(typeof states[DRAIN.repo].seen["2"].goneAt, "number")
  // After the release: the drain removed its label from the closed issue 2 and edited its marked comment; on the open issue 1 it commented and removed its label.
  w.issues[0] = issue(1, T(9))
  w.comments = async () => [statusComment(10, T(9))]
  w.events = async (_repo, n) => [{ id: 1, event: "closed", created_at: T(6) }, labelEvent(T(9), "drain: in progress", "unlabeled")].filter(() => n === 1 || n === 2)
  for (const step of [2, 3, 4]) assert.deepEqual((await w.poll(NOW + step * 1000)).wakes, [])
  assert.deepEqual(w.state().pending, [])
  assert.equal(typeof w.state().seen["2"].goneAt, "number", "the closed issue is still tracked as gone")
  matches(w.state().seen["1"], seenAt(T(9)))
  assert.equal(w.state().lastOkAt, new Date(NOW + 4000).toISOString())
})

test("the wake message says why each issue is news, and `why` reads the recorded reasons back, newest first, capped per drain", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll()
  w.issues[0] = issue(1, T(5), "Issue 1", "edited")
  w.issues.push(issue(2, T(5)))
  await w.poll()
  assert.equal(w.sent[0][1], "New or changed issues in acme/widgets: #1 Issue 1 (title or body edited), #2 Issue 2 (new issue). Drain them.")
  w.issues[0] = issue(1, T(9), "Issue 1", "edited again")
  await w.poll()
  const reasons = whyOf(readDrainStates(w.paths.state), DRAIN.repo, 1)
  assert.deepEqual(reasons.wakes.map((event) => event.why), ["title or body edited", "title or body edited"])
  assert.equal(reasons.waiting, false)
  matches(reasons.seen, seenAt(T(9)))
  assert.equal(reasons.note, undefined)
  // Nothing recorded for an issue that never woke, nor for a drain that does not exist.
  assert.match(whyOf(readDrainStates(w.paths.state), DRAIN.repo, 99).note, /no wake is recorded for acme\/widgets#99; each drain keeps its last 200 events/u)
  assert.deepEqual(whyOf({}, "x/y", 1), { repo: "x/y", number: 1, wakes: [], waiting: false, seen: null, note: "no wake is recorded for x/y#1; each drain keeps its last 200 events" })
  // The history keeps the newest 200 events, and an unacknowledged one shows as waiting.
  const many = await world([issue(1, T(0))])
  await many.poll()
  many.issues.push(...Array.from({ length: 205 }, (_unused, index) => issue(1000 + index, T(5))))
  many.refuse = "no answer"
  await many.poll()
  const states = readDrainStates(many.paths.state)
  assert.equal(states[DRAIN.repo].history.length, 200)
  assert.equal(whyOf(states, DRAIN.repo, 1000).wakes.length, 0)
  const last = whyOf(states, DRAIN.repo, 1204)
  assert.equal(last.waiting, true)
  assert.equal(last.wakes[0].why, "new issue")
})

test("`drains why owner/name#n` prints the recorded reasons", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const config = path.join(dir, "config.json")
  const state = path.join(dir, "state.json")
  writeFileSync(config, JSON.stringify({ drains: [DRAIN] }))
  let updated = "2026-11-13T01:00:00Z"
  const connect = async () => ({ login: "x", openIssues: async () => [issue(1, updated, "T", updated)], comments: async () => [], issueEvents: async () => [] })
  await cli(["poll", "--config", config, "--state", state], { connect, now: () => NOW })
  updated = "2026-11-13T02:00:00Z"
  await cli(["poll", "--config", config, "--state", state], { connect, now: () => NOW })
  updated = "2026-11-13T03:00:00Z"
  await cli(["poll", "--config", config, "--state", state], { connect, now: () => NOW, env: { ...process.env, DESK_DRAINS_RELEASE: "0123456789abcdef0123456789abcdef01234567" } })
  const asked = await cli(["why", "acme/widgets#1", "--state", state])
  assert.equal(asked.code, 0, asked.err)
  const printed = JSON.parse(asked.out)
  assert.equal(printed.wakes[0].why, "title or body edited")
  assert.match(printed.wakes[0].desk, /^\d+\.\d+\.\d+ 01234567$/u, "the launcher's own copy is named by its release commit")
  assert.match(printed.wakes[1].desk, /^\d+\.\d+\.\d+$/u, "the history says which Desk polled")
  assert.equal(printed.waiting, true)
  assert.equal(JSON.parse((await cli(["why", "acme/widgets#7", "--state", state])).out).wakes.length, 0)
  const bad = await cli(["why", "nonsense"])
  assert.equal(bad.code, 2)
  assert.match(bad.err, /why needs an issue such as owner\/name#123/u)
})

test("self is resolved per repository from the account that polls it: a personal and a work drain in one poll", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const paths = { config: path.join(dir, "config.json"), state: path.join(dir, "state.json"), lock: path.join(dir, "poll.lock") }
  const drains = [
    { repo: "acme/widgets", session: "58fbd57e-e371-4169-b013-2f413ab4a046", account: "personal" },
    { repo: "corp/tools", session: "48a0f0ab-56ad-406d-8831-5352815be337", account: "work-account" },
  ]
  writeFileSync(paths.config, JSON.stringify({ drains }))
  const logins = { personal: "ari", "work-account": "ari_corp" }
  const issues = { "acme/widgets": [issue(1, T(0))], "corp/tools": [issue(1, T(0))] }
  const comments = { "acme/widgets": [], "corp/tools": [] }
  const events = { "acme/widgets": [], "corp/tools": [] }
  const connect = async (account) => ({
    login: logins[account],
    openIssues: async (repo) => issues[repo],
    comments: async (repo) => comments[repo],
    issueEvents: async (repo) => events[repo],
    timeline: async () => [],
    pull: async () => ({}),
  })
  const poll = (at = NOW) => pollDrains({ paths, connect, now: at, ackCommand: ["node", "drains.js"] })
  await poll()
  // Each repo's drain writes its own marked comment and label, as its own account: neither wakes.
  const own = (id, login, at = T(5)) => ({ id, body: `Triaged.\n${DRAIN_STATUS_MARKER}`, created_at: at, updated_at: at, user: { login } })
  issues["acme/widgets"] = [issue(1, T(5))]
  issues["corp/tools"] = [issue(1, T(5))]
  comments["acme/widgets"] = [own(10, "ari")]
  comments["corp/tools"] = [own(11, "ari_corp")]
  for (const repo of Object.keys(events)) events[repo] = [labelEvent(T(5), "drain: triaged")]
  const quietRound = await poll(NOW + 1)
  assert.deepEqual(quietRound.wakes, [])
  assert.deepEqual(quietRound.errors, [])
  // The same comments under the other repository's account are someone else's: each wakes.
  issues["acme/widgets"] = [issue(1, T(9))]
  issues["corp/tools"] = [issue(1, T(9))]
  comments["acme/widgets"] = [own(12, "ari_corp", T(9))]
  comments["corp/tools"] = [own(13, "ari", T(9))]
  const loudRound = await poll(NOW + 2)
  assert.deepEqual(loudRound.wakes.map((wake) => [wake.repo, wake.events[0].why]), [["acme/widgets", "comment 12 by ari_corp"], ["corp/tools", "comment 13 by ari"]])
})

test("a cross-reference from the drain's own marked comment, marked body or drain branch wakes nobody, and the marker still advances", async () => {
  const marked = (id, created_at, body = `Filed #1 as a follow-up.\n${DRAIN_STATUS_MARKER}`) => ({ id, body, created_at, updated_at: created_at, user: { login: "maintainer" } })
  const cases = [
    ["its marked comment on another issue, which names this one", crossReference(T(5), sourceIssue(9)), { comments: async (_repo, n) => (n === 9 ? [marked(50, T(5))] : []) }],
    ["its marked comment, edited to name this one a minute later", crossReference(T(6), sourceIssue(9)), { comments: async (_repo, n) => (n === 9 ? [{ ...marked(50, T(1)), updated_at: T(6) }] : []) }],
    ["a pull request on a drain- branch", crossReference(T(5), sourceIssue(39, { pull_request: {} })), { pull: async () => ({ head: { ref: "drain-1-default-command" } }) }],
    ["a pull request on a drain/ branch", crossReference(T(5), sourceIssue(39, { pull_request: {} })), { pull: async () => ({ head: { ref: "drain/876-ask-for-go" } }) }],
    ["an issue or pull request whose body carries the marker", crossReference(T(5), sourceIssue(9, { body: `Tracking.\n${DRAIN_STATUS_MARKER}` })), {}],
  ]
  for (const [name, event, extra] of cases) {
    const w = await quiet({ ...extra, timeline: async () => [event] })
    const out = await w.poll()
    assert.deepEqual(out.wakes, [], name)
    matches(w.state().seen["1"], seenAt(T(5)))
    assert.deepEqual(w.state().pending, [], name)
  }
})

test("a real cross-reference still wakes the drain, from another issue, a pull request, another repository, or a marked comment that names a different issue or is not from then", async () => {
  const comment = (body, created_at = T(5), login = "maintainer") => ({ id: 50, body, created_at, updated_at: created_at, user: { login } })
  const cases = [
    ["an issue by someone else", crossReference(T(5), sourceIssue(7)), {}, "acme/widgets#7"],
    ["a pull request that is not a drain branch", crossReference(T(5), sourceIssue(40, { pull_request: {} })), {}, "acme/widgets#40"],
    ["a pull request on a branch that only resembles a drain's", crossReference(T(5), sourceIssue(40, { pull_request: {} })), { pull: async () => ({ head: { ref: "drainage/x" } }) }, "acme/widgets#40"],
    ["a pull request that cannot be read", crossReference(T(5), sourceIssue(40, { pull_request: {} })), { pull: async () => { throw new Error("HTTP 404") } }, "acme/widgets#40"],
    ["a pull request with no head", crossReference(T(5), sourceIssue(40, { pull_request: {} })), { pull: async () => ({}) }, "acme/widgets#40"],
    ["another repository", crossReference(T(5), { number: 3, repository_url: "https://api.github.com/repos/other/thing" }), {}, "other/thing#3"],
    ["a source with no repository", crossReference(T(5), { number: 4 }), {}, "acme/widgets#4"],
    ["a marked comment that names another issue", crossReference(T(5), sourceIssue(9)), { comments: async () => [comment(`See #2.\n${DRAIN_STATUS_MARKER}`)] }, "acme/widgets#9"],
    ["a marked comment from another time", crossReference(T(5), sourceIssue(9)), { comments: async () => [comment(`See #1.\n${DRAIN_STATUS_MARKER}`, T(40))] }, "acme/widgets#9"],
    ["an unmarked comment by the drain's account", crossReference(T(5), sourceIssue(9)), { comments: async () => [comment("See #1.")] }, "acme/widgets#9"],
    ["a marked comment by someone else", crossReference(T(5), sourceIssue(9)), { comments: async () => [comment(`See #1.\n${DRAIN_STATUS_MARKER}`, T(5), "someone")] }, "acme/widgets#9"],
    ["a cross-reference with no source", { id: 1, event: "cross-referenced", created_at: T(5) }, {}, "acme/widgets#unknown"],
    ["a source comment list that cannot be read", crossReference(T(5), sourceIssue(9)), { comments: async () => { throw new Error("HTTP 404") } }, "acme/widgets#9"],
    ["a comment with no body", crossReference(T(5), sourceIssue(9)), { comments: async () => [{ id: 50, created_at: T(5), updated_at: T(5), user: { login: "maintainer" } }] }, "acme/widgets#9"],
  ]
  for (const [name, event, extra, from] of cases) {
    const w = await quiet({ ...extra, timeline: async () => [event] })
    const out = await w.poll()
    assert.equal(out.wakes.length, 1, name)
    assert.equal(out.wakes[0].events[0].why, `cross-reference from ${from}`, name)
  }
})

test("the timeline is read only when updated_at moved with nothing else news, and only for cross-references after the last marker", async () => {
  const w = await quiet({ timeline: async () => [{ id: 2, event: "labeled", created_at: T(5) }, crossReference(T(0), sourceIssue(7)), crossReference(T(5), sourceIssue(9, { body: DRAIN_STATUS_MARKER }))] })
  const calls = []
  const timeline = w.timeline
  w.timeline = async (...args) => { calls.push(args); return timeline(...args) }
  const out = await w.poll()
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(calls, [["acme/widgets", 1]])
  // A real change is found without it.
  w.issues[0] = issue(1, T(9), "Issue 1", "edited")
  await w.poll()
  assert.equal(w.sent.length, 1)
  assert.equal(calls.length, 1)
})

test("a closed issue is not polled: a cross-reference after its close wakes nobody and nothing is left waiting", async () => {
  const w = await quiet({ timeline: async () => [crossReference(T(8), sourceIssue(7))] })
  w.issues.splice(0, 1)
  const out = await w.poll()
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(w.state().pending, [])
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
  assert.deepEqual(w.sent.at(-1), [DRAIN.session, "New or changed issues in acme/widgets: #1 Issue 1 (title or body edited). Drain them."])
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
  assert.deepEqual(w.sent, [[DRAIN.session, "New or changed issues in acme/widgets: #2 Issue 2 (reopened). Drain them."]])
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
  assert.deepEqual(w.state().pending, [{ number: 1, title: "Issue 1", updatedAt: "2026-11-13T02:00:00Z", seenAt: new Date(NOW).toISOString(), why: "title or body edited" }])
  w.issues[0] = issue(1, "2026-11-13T03:00:00Z", "Issue 1", "v3")
  w.issues.push(issue(2, "2026-11-13T03:00:00Z"))
  await w.poll()
  assert.deepEqual(w.sent.at(-1), [DRAIN.session, "New or changed issues in acme/widgets: #1 Issue 1 (title or body edited), #2 Issue 2 (new issue). Drain them."])
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

test("status lines show the last successful poll and its lag, the last attempt, open count, events waiting and for how long, last wake and last error per drain", () => {
  const drains = [DRAIN, { repo: "acme/gadgets", session: "48a0f0ab-56ad-406d-8831-5352815be337" }, { repo: "a/b", session: "12345678-0000" }, { repo: "c/d", session: "abcdefgh-1" }, { repo: "e/f", session: "fedcba98-2" }]
  const iso = (ago) => new Date(NOW - ago).toISOString()
  const states = {
    [DRAIN.repo]: { seeded: true, seen: {}, pending: [{ number: 1, title: "t", updatedAt: "u", seenAt: iso(2 * HOUR) }, { number: 2, title: "t", updatedAt: "u" }], lastPollAt: iso(20_000), lastOkAt: iso(25 * 60_000), openCount: 7, lastWakeAt: iso(12 * 60_000), lastWakeCount: 1, lastError: "GitHub answered HTTP 502" },
    "acme/gadgets": { seeded: true, seen: {}, pending: [], lastPollAt: iso(4 * HOUR), lastWakeAt: iso(3 * HOUR), lastWakeCount: 3 },
    "c/d": { seeded: true, seen: {}, pending: [], lastPollAt: iso(0), lastOkAt: iso(0), openCount: 0 },
    "e/f": { seeded: true, seen: {}, pending: [], lastPollAt: iso(0), lastError: "no token", openCount: 3 },
  }
  assert.deepEqual(drainStatusLines(drains, states, NOW), [
    `issue drain acme/widgets -> 58fbd57e: last ok poll ${iso(25 * 60_000)} (lag 25m), polled just now, 7 open, 2 waiting (oldest 2h), last wake 12m ago (1 issue), last error: GitHub answered HTTP 502`,
    `issue drain acme/gadgets -> 48a0f0ab: last ok poll ${iso(4 * HOUR)} (lag 4h), polled 4h ago, ? open, 0 waiting, last wake 3h ago (3 issues)`,
    "issue drain a/b -> 12345678: not polled yet",
    `issue drain c/d -> abcdefgh: last ok poll ${iso(0)} (lag under 1m), polled just now, 0 open, 0 waiting, last wake never`,
    "issue drain e/f -> fedcba98: no ok poll recorded, polled just now, 3 open, 0 waiting, last wake never, last error: no token",
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

const response = (body, { status = 200, link = null, headers = {} } = {}) => ({ ok: status < 400, status, json: async () => body, headers: { get: (name) => (name === "link" ? link : headers[name] ?? null) } })

test("lists open issues without pull requests across pages and reads comments since a time, with the account's token", async () => {
  const spawned = []
  const spawn = (...args) => { spawned.push(args); return { status: 0, stdout: "tok\n" } }
  const answers = [
    response({ login: "Maintainer-Real" }),
    response([issue(1, "u1"), { ...issue(2, "u2"), pull_request: {} }], { link: '<next>; rel="next"' }),
    response([issue(3, "u3")]),
    response([{ body: "c", updated_at: "u" }]),
    response([{ id: 1, event: "reopened", created_at: "u" }]),
    response([{ id: 2, event: "cross-referenced", created_at: "u" }]),
    response({ head: { ref: "drain-5-x" } }),
  ]
  const urls = []
  const headers = []
  const fetchImpl = async (url, init) => { urls.push(url); headers.push(init.headers); return answers.shift() }
  const api = await connectGithub("maintainer", { spawn, fetchImpl, env: { PATH: "/bin", GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient", GH_HOST: "x" } })
  assert.deepEqual(spawned[0].slice(0, 2), ["gh", ["auth", "token", "--hostname", "github.com", "--user", "maintainer"]])
  assert.deepEqual(Object.keys(spawned[0][2].env).filter((name) => /TOKEN|HOST/u.test(name)), [])
  assert.equal(api.login, "Maintainer-Real", "the token decides who the drain is, not the configured name")
  assert.deepEqual((await api.openIssues("o/r")).map((item) => item.number), [1, 3])
  assert.equal(urls[0], "https://api.github.com/user")
  assert.equal(urls[1], "https://api.github.com/repos/o/r/issues?state=open&sort=updated&direction=desc&per_page=100&page=1")
  assert.ok(urls[2].endsWith("&page=2"))
  assert.equal(headers[1].Authorization, "Bearer tok")
  assert.deepEqual(await api.comments("o/r", 5, "2026-11-13T01:00:00Z"), [{ body: "c", updated_at: "u" }])
  assert.equal(urls[3], "https://api.github.com/repos/o/r/issues/5/comments?since=2026-11-13T01%3A00%3A00Z&per_page=100&page=1")
  assert.deepEqual(await api.issueEvents("o/r", 5), [{ id: 1, event: "reopened", created_at: "u" }])
  assert.equal(urls[4], "https://api.github.com/repos/o/r/issues/5/events?per_page=100&page=1")
  assert.deepEqual(await api.timeline("o/r", 5), [{ id: 2, event: "cross-referenced", created_at: "u" }])
  assert.equal(urls[5], "https://api.github.com/repos/o/r/issues/5/timeline?per_page=100&page=1")
  assert.deepEqual(await api.pull("o/r", 7), { head: { ref: "drain-5-x" } })
  assert.equal(urls[6], "https://api.github.com/repos/o/r/pulls/7")
})

// A drain whose GitHub can list only what changed: the open list is read in full once an hour, and a poll in between reads the delta.
async function deltaWorld(issues) {
  const w = await world(issues)
  w.opened = 0
  w.deltaCalls = []
  w.delta = async () => ({ notModified: true })
  w.api.openIssues = async () => { w.opened += 1; return w.issues.filter((item) => item.state !== "closed") }
  w.api.changedIssues = async (...args) => { w.deltaCalls.push(args); return w.delta(...args) }
  return w
}

test("between full syncs a poll reads only what changed since the newest change it knew, and a 304 costs nothing and changes nothing", async () => {
  const w = await deltaWorld([issue(1, T(0)), issue(2, T(0))])
  await w.poll()
  assert.equal(w.opened, 1)
  matches(w.state(), { cursor: T(0), syncedAt: new Date(NOW).toISOString(), openCount: 2, login: "maintainer", loginAt: new Date(NOW).toISOString() })
  const before = JSON.stringify(w.state().seen)
  let out = await w.poll(NOW + 300_000)
  assert.equal(w.opened, 1, "no full listing")
  assert.deepEqual(w.deltaCalls, [[DRAIN.repo, "2026-11-13T00:58:00Z", undefined]], "from two minutes before the newest change")
  assert.deepEqual(out.wakes, [])
  assert.equal(JSON.stringify(w.state().seen), before)
  matches(w.state(), { lastOkAt: new Date(NOW + 300_000).toISOString(), lastPollAt: new Date(NOW + 300_000).toISOString() })
  // A change wakes, moves the newest-change time, and a new issue joins the count.
  w.delta = async () => ({ issues: [issue(1, T(5), "Issue 1", "edited"), { ...issue(9, T(0)), pull_request: {} }, issue(3, T(6)), issue(2, T(0))], etag: '"abc"' })
  out = await w.poll(NOW + 600_000)
  assert.deepEqual(out.wakes.map((wake) => wake.events.map((event) => [event.number, event.why])), [[[1, "title or body edited"], [3, "new issue"]]])
  matches(w.state(), { cursor: T(6), openCount: 3, etag: { since: "2026-11-13T00:58:00Z", tag: '"abc"' } })
  assert.equal(w.state().seen["9"], undefined, "a pull request is not an issue")
  // A new cursor means a new URL and no tag; the same URL asks again with its tag; a response without a tag keeps none.
  w.delta = async () => ({ notModified: true })
  await w.poll(NOW + 700_000)
  assert.deepEqual(w.deltaCalls.at(-1), [DRAIN.repo, "2026-11-13T01:04:00Z", undefined])
  w.delta = async () => ({ issues: [issue(3, T(6))], etag: '"def"' })
  await w.poll(NOW + 800_000)
  w.delta = async () => ({ notModified: true })
  await w.poll(NOW + 900_000)
  assert.deepEqual(w.deltaCalls.at(-1), [DRAIN.repo, "2026-11-13T01:04:00Z", '"def"'], "the same URL asks again with its tag")
  w.delta = async () => ({ issues: [issue(3, T(6))] })
  await w.poll(NOW + 1_000_000)
  assert.equal(w.state().etag, undefined)
  assert.equal(w.opened, 1)
})

test("a delta that lists an issue closed since marks it gone and drops its waiting event; a reopen is news; an hour on, the full list is read again", async () => {
  const w = await deltaWorld([issue(1, T(0)), issue(2, T(0)), issue(3, T(0))])
  await w.poll()
  w.refuse = "queued behind the app"
  w.delta = async () => ({ issues: [issue(2, T(5), "Issue 2", "edited")] })
  await w.poll(NOW + 300_000)
  assert.deepEqual(w.state().pending.map((event) => event.number), [2])
  // Issue 2 closes (a closed item is in the delta); issue 3 was never seen before and closes too.
  w.delta = async () => ({ issues: [{ ...issue(2, T(7), "Issue 2", "edited"), state: "closed" }, { ...issue(8, T(7)), state: "closed" }] })
  const out = await w.poll(NOW + 600_000)
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(w.state().pending, [])
  assert.equal(typeof w.state().seen["2"].goneAt, "number")
  assert.equal(w.state().seen["8"], undefined)
  assert.equal(w.state().openCount, 2)
  matches(w.state(), { cursor: T(7) })
  // Issue 2 comes back, reopened by someone.
  w.events = async (_repo, n) => (n === 2 ? [lifecycle("reopened", T(9), "someone")] : [])
  w.delta = async () => ({ issues: [issue(2, T(9), "Issue 2", "edited")] })
  const back = await w.poll(NOW + 900_000)
  assert.equal(back.wakes[0].events[0].why, "reopened")
  assert.equal(w.state().openCount, 3)
  // An hour after the last full listing the whole list is read again, and its newest change becomes the cursor.
  w.issues = [issue(1, T(0)), issue(2, T(9), "Issue 2", "edited")]
  await w.poll(NOW + 3_600_000 + 1000)
  assert.equal(w.opened, 2)
  matches(w.state(), { syncedAt: new Date(NOW + 3_600_000 + 1000).toISOString(), openCount: 2, cursor: T(9) })
})

test("the login is asked of GitHub once a day and the same one is reused in between", async () => {
  const w = await deltaWorld([issue(1, T(0))])
  const asked = []
  w.connect = async (account, options) => { asked.push([account, options]); return w.api }
  await w.poll()
  await w.poll(NOW + 300_000)
  await w.poll(NOW + 24 * 3_600_000 + 1000)
  assert.deepEqual(asked.map(([account, options]) => [account, options.login]), [[DRAIN.account, undefined], [DRAIN.account, "maintainer"], [DRAIN.account, undefined]])
  matches(w.state(), { login: "maintainer", loginAt: new Date(NOW + 24 * 3_600_000 + 1000).toISOString() })
})

test("the state keeps the quota the connection saw and what the poll spent, even when the poll failed", async () => {
  const w = await world([issue(1, T(0))])
  const quota = { remaining: 4001, limit: 5000, reset: Math.floor(NOW / 1000) + 1800, at: new Date(NOW).toISOString() }
  w.api.quota = () => quota
  w.api.calls = () => ({ total: 7, notModified: 3 })
  await w.poll()
  matches(w.state(), { quota, calls: { total: 7, notModified: 3 } })
  w.api.openIssues = async () => { throw new Error("GitHub answered HTTP 403 for /repos/acme/widgets/issues") }
  w.api.quota = () => ({ ...quota, remaining: 0 })
  const out = await w.poll(NOW + 1000)
  assert.equal(out.calls, 7)
  matches(w.state(), { lastError: "GitHub answered HTTP 403 for /repos/acme/widgets/issues", quota: { remaining: 0 } })
  w.connect = async () => { throw new Error("no token") }
  await w.poll(NOW + 2000)
  assert.deepEqual(w.state().calls, { total: 0, notModified: 0 })
})

test("quotaHold: nothing without a reading or after the window reset, a pause near zero, a slower pace when low, and the normal pace otherwise", () => {
  const reset = Math.floor(NOW / 1000) + 1800
  const reading = (remaining, limit = 5000) => ({ remaining, limit, reset, at: new Date(NOW).toISOString() })
  const recent = new Date(NOW - 5 * 60_000).toISOString()
  const old = new Date(NOW - 20 * 60_000).toISOString()
  assert.equal(quotaHold(null, recent, NOW), null)
  assert.equal(quotaHold(reading(0), recent, reset * 1000), null, "the window has reset")
  assert.match(quotaHold(reading(25), old, NOW), /^25\/5000 calls left, paused until 2026-11-13T06:30:00\.000Z$/u)
  assert.match(quotaHold(reading(300), recent, NOW), /^300\/5000 calls left, polling every 15m until 2026-11-13T06:30:00\.000Z$/u)
  assert.equal(quotaHold(reading(300), old, NOW), null, "a slow poll is due")
  assert.equal(quotaHold(reading(300), undefined, NOW), null, "never polled")
  assert.equal(quotaHold(reading(499), recent, NOW) === null, false, "ten percent of a 5000 window")
  assert.equal(quotaHold(reading(501), recent, NOW), null)
  assert.equal(quotaHold(reading(150, 1000), recent, NOW) === null, false, "the floor applies to a small window")
})

test("a drain whose account is low on quota is not polled, the quota is shared by the drains on that account, and another account carries on", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const paths = { config: path.join(dir, "config.json"), state: path.join(dir, "state.json"), lock: path.join(dir, "poll.lock") }
  const drains = [
    { repo: "corp/tools", session: "58fbd57e-e371-4169-b013-2f413ab4a046", account: "work" },
    { repo: "corp/apps", session: "48a0f0ab-56ad-406d-8831-5352815be337", account: "work" },
    { repo: "acme/widgets", session: "12345678-0000", account: "personal" },
  ]
  writeFileSync(paths.config, JSON.stringify({ drains }))
  const reset = Math.floor(NOW / 1000) + 1800
  const remaining = { work: 5000, personal: 5000 }
  const connected = []
  const issues = { "corp/tools": [issue(1, T(0))], "corp/apps": [issue(1, T(0))], "acme/widgets": [issue(1, T(0))] }
  const connect = async (account) => {
    connected.push(account)
    return { login: account, openIssues: async (repo) => issues[repo], comments: async () => [], issueEvents: async () => [], timeline: async () => [], quota: () => ({ remaining: remaining[account], limit: 5000, reset, at: new Date(NOW).toISOString() }), calls: () => ({ total: 2, notModified: 1 }) }
  }
  const poll = (at) => pollDrains({ paths, connect, now: at, ackCommand: ["node", "drains.js"] })
  const first = await poll(NOW)
  assert.deepEqual(connected, ["work", "work", "personal"])
  assert.equal(first.calls, 6)
  assert.match(first.status[0], /^quota work: 5000\/5000 calls left, resets 2026-11-13T06:30:00\.000Z \(read just now\); the last cycle used 4 calls, 2 of them not modified$/u)
  assert.match(first.status[1], /^quota personal: 5000\/5000 .*used 2 calls, 1 of them not modified$/u)
  // The work account runs low while the first of its drains is read: the second is held, the personal one is not.
  connected.length = 0
  remaining.work = 20
  const second = await poll(NOW + 300_000)
  assert.deepEqual(connected, ["work", "personal"], "corp/tools was read and found the account at 20; corp/apps and later cycles wait")
  assert.match(second.status[0], /^quota work: 20\/5000 calls left/u)
  assert.match(second.status.find((line) => line.startsWith("issue drain corp/apps")), /held: 20\/5000 calls left, paused until 2026-11-13T06:30:00\.000Z$/u)
  assert.equal(readDrainStates(paths.state)["corp/apps"].calls.total, 0)
  // Held drains keep their pending wakes, and the next cycle still holds them until the window resets.
  connected.length = 0
  await poll(NOW + 600_000)
  assert.deepEqual(connected, ["personal"])
  connected.length = 0
  remaining.work = 5000
  const after = await poll(reset * 1000 + 1000)
  assert.deepEqual(connected, ["work", "work", "personal"])
  assert.equal(after.status.some((line) => line.includes("held:")), false)
  assert.equal(readDrainStates(paths.state)["corp/apps"].hold, undefined)
})

test("quota lines name each account once, with the active account when none is configured, and show nothing before a reading", () => {
  const drains = [{ repo: "a/b", session: "12345678-0", account: "work" }, { repo: "c/d", session: "12345678-1" }, { repo: "e/f", session: "12345678-2", account: "work" }]
  const reading = (remaining, at) => ({ remaining, limit: 5000, reset: Math.floor(NOW / 1000) + 600, at })
  const states = {
    "a/b": { pending: [], quota: reading(10, new Date(NOW - 60_000).toISOString()), calls: { total: 3, notModified: 3 } },
    "e/f": { pending: [], quota: reading(7, new Date(NOW - 10_000).toISOString()) },
    "c/d": { pending: [], quota: reading(900, new Date(NOW - 7_200_000).toISOString()), calls: { total: 1, notModified: 0 } },
  }
  assert.deepEqual(quotaLines(drains, states, NOW), [
    "quota work: 7/5000 calls left, resets 2026-11-13T06:10:00.000Z (read just now); the last cycle used 3 calls, 3 of them not modified",
    "quota the active account: 900/5000 calls left, resets 2026-11-13T06:10:00.000Z (read 2h ago); the last cycle used 1 calls, 0 of them not modified",
  ])
  assert.deepEqual(quotaLines(drains, { "a/b": { pending: [] } }, NOW), [])
  assert.match(drainStatusLines(drains, { "a/b": { pending: [], hold: "x" }, "c/d": { pending: [], lastPollAt: new Date(NOW).toISOString(), hold: "slow" } }, NOW).join("\n"), /issue drain a\/b -> 12345678: not polled yet, held: x\nissue drain c\/d.*held: slow/u)
})

test("conditional requests: a stored tag goes out as If-None-Match, a 304 is counted as free, and every answer's quota headers are kept, errors included", async () => {
  const spawn = () => ({ status: 0, stdout: "tok" })
  const headers = { "x-ratelimit-remaining": "4990", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1794600000" }
  const sent = []
  const answers = [
    response([issue(1, "u1")], { link: '<next>; rel="next"', headers: { ...headers, etag: '"t1"' } }),
    response([issue(2, "u2")], { headers }),
    response({}, { status: 304, headers: { ...headers, "x-ratelimit-remaining": "4989" } }),
    response({}, { status: 403, headers: { ...headers, "x-ratelimit-remaining": "0" } }),
  ]
  const fetchImpl = async (url, init) => { sent.push([url, init.headers["If-None-Match"]]); return answers.shift() }
  const api = await connectGithub("work", { spawn, fetchImpl, login: "work_microsoft" })
  assert.equal(api.login, "work_microsoft")
  assert.equal(sent.length, 0, "a known login is not asked for")
  assert.equal(api.quota(), null)
  const listed = await api.changedIssues("o/r", "2026-11-13T00:58:00Z", '"old"')
  assert.deepEqual(listed.issues.map((item) => item.number), [1, 2])
  assert.equal(listed.etag, '"t1"')
  assert.deepEqual(sent, [
    ["https://api.github.com/repos/o/r/issues?state=all&sort=updated&direction=desc&since=2026-11-13T00%3A58%3A00Z&per_page=100&page=1", '"old"'],
    ["https://api.github.com/repos/o/r/issues?state=all&sort=updated&direction=desc&since=2026-11-13T00%3A58%3A00Z&per_page=100&page=2", undefined],
  ])
  assert.deepEqual(await api.changedIssues("o/r", "2026-11-13T00:58:00Z", '"t1"'), { notModified: true })
  assert.equal(sent.at(-1)[1], '"t1"')
  assert.deepEqual(api.calls(), { total: 3, notModified: 1 })
  assert.deepEqual({ remaining: api.quota().remaining, limit: api.quota().limit, reset: api.quota().reset }, { remaining: 4989, limit: 5000, reset: 1794600000 })
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), /GitHub answered HTTP 403 for \/repos\/o\/r\/issues$/u)
  assert.equal(api.quota().remaining, 0, "the quota is read from the refusal too")
})

test("asks GitHub who the active account is when none is configured", async () => {
  const spawned = []
  const spawn = (...args) => { spawned.push(args); return { status: 0, stdout: "tok" } }
  const answers = [response({ login: "ari" }), response({})]
  const fetchImpl = async () => answers.shift()
  assert.equal((await connectGithub(undefined, { spawn, fetchImpl })).login, "ari")
  assert.deepEqual(spawned[0][1], ["auth", "token", "--hostname", "github.com"])
  assert.equal((await connectGithub(undefined, { spawn, fetchImpl })).login, "")
  // When GitHub will not say, the configured account stands in; with neither the login is empty.
  const refused = async () => response({}, { status: 401 })
  assert.equal((await connectGithub("work_microsoft", { spawn, fetchImpl: refused })).login, "work_microsoft")
  assert.equal((await connectGithub(undefined, { spawn, fetchImpl: refused })).login, "")
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
  assert.deepEqual(parseDrainsArgs(["why", "a/b#12", "--state", "s.json"]), { command: "why", flags: { state: "s.json" }, repo: "a/b", number: 12 })
  for (const bad of [["why"], ["why", "a/b"], ["why", "a#1"], ["why", "a/b#x"], ["why", "--state", "s.json"]]) assert.match(parseDrainsArgs(bad).error, /why needs an issue such as owner\/name#123/u, bad.join(" "))
  assert.match(parseDrainsArgs(["why", "a/b#1", "--config", "c"]).error, /does not take "--config"/u)
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
  assert.equal(second.wakes[0].message, "New or changed issues in acme/widgets: #1 T (title or body edited). Drain them.")
  assert.deepEqual(second.wakes[0].done.slice(0, 2), [process.execPath, SCRIPT])
  assert.deepEqual(second.wakes[0].done.slice(-2), ["--state", state])
  const unflagged = JSON.parse((await cli(["poll", "--config", config], { connect, now: () => NOW })).out)
  assert.equal(unflagged.wakes.length, 0)
  const failed = await cli([...second.wakes[0].done.slice(2), "--error", "no answer"], { now: () => NOW })
  assert.equal(JSON.parse(failed.out).changed, true)
  assert.equal(readDrainStates(state)[DRAIN.repo].lastError, "the wake was not delivered: no answer")
  assert.equal(readDrainStates(state)[DRAIN.repo].pending.length, 1)
  const status = JSON.parse((await cli(["status", ...flags], { now: () => NOW })).out)
  assert.match(status.status[0], /^desk \S+ \(.*drains\.js\)$/u)
  assert.match(status.status[1], /last ok poll \S+ \(lag [^)]+\), polled .*1 waiting \(oldest [^)]+\), last wake never, last error: the wake was not delivered: no answer$/u)
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
  assert.match(usage.err, /^desk: poll does not take "--bogus": .*Fix: drop --bogus or use --config or --state\./u)
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

test("the Desk in use is named by its version, and by the release commit when the launcher's own copy runs", async () => {
  const dir = await mkTempRoot("desk-drains-")
  mkdirSync(path.join(dir, "mcp", "scripts"), { recursive: true })
  const script = path.join(dir, "mcp", "scripts", "drains.js")
  assert.deepEqual(deskInUse({ script, env: {} }), { version: "unknown", release: null, script, line: `desk unknown (${script})` })
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ name: "desk" }))
  assert.equal(deskInUse({ script, env: {} }).version, "unknown")
  writeFileSync(path.join(dir, "plugin.json"), JSON.stringify({ version: "3.2.122" }))
  const sha = "0123456789abcdef0123456789abcdef01234567"
  assert.deepEqual(deskInUse({ script, env: { DESK_DRAINS_RELEASE: sha } }), { version: "3.2.122", release: sha, script, line: "desk 3.2.122 (ourostack/desk@release 01234567, the launcher's own copy)" })
  assert.equal(deskInUse({ script, env: { DESK_DRAINS_RELEASE: "" } }).release, null)
  // Without an env argument it reads the process environment.
  assert.equal(deskInUse({ script }).release, process.env.DESK_DRAINS_RELEASE || null)
})

test("the script runs as a program and prints the poll's JSON", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const home = path.join(dir, "state")
  const run = spawnSync(process.execPath, [SCRIPT, "status"], { encoding: "utf8", env: { ...process.env, HOME: dir, XDG_STATE_HOME: home } })
  assert.equal(run.status, 0, run.stderr)
  const printed = JSON.parse(run.stdout)
  assert.deepEqual(printed.status, [`desk ${printed.desk.version} (${SCRIPT})`])
  assert.match(printed.desk.version, /^\d+\.\d+\.\d+$/u)
  assert.equal(printed.desk.release, null)
  assert.equal(printed.desk.script, SCRIPT)
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
  const printed = JSON.parse(out.join(""))
  assert.equal(printed.status.length, 1)
  assert.deepEqual(printed.launcher, { error: "ENOTDIR" })
})
