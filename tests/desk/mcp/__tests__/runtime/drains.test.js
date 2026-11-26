// Issue drains: what the poll records, what it ignores and what it hands a runner to deliver. The GitHub side is a fake; every
// state, config and lock file lives under a temporary root.
import assert from "node:assert/strict"
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, promises as fs, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { removeTreeSync } from "../_remove_tree.js"
import {
  acquireDrainLock, moveWithoutReplace, ackWake, connectGithub, DRAIN_STATUS_MARKER, drainPaths, drainsHome, deskInUse, drainStatusLines, installLauncher, parseDrainConfig, pollDrain, pollDrains, quotaHold, quotaLines, recoverDrainTarget, startSuccessor, successorKickoff,
  readDrainConfig, readDrainStates, wakeId, wakeMessage, whyOf, withDrainLock,
} from "../../../../../plugins/desk/mcp/src/runtime/drains.js"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"

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
  ["a close and the drain's labels", [], [{ id: 1, event: "closed", created_at: T(5) }, labelEvent(T(5), "drain: triaged")]],
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

for (const [name, label, minutes, woken] of [
  ["a label applied seconds after the issue was opened", "site-alert", 0.5, 0],
  ["a label applied minutes after the issue was opened", "site-alert", 5, 1],
]) {
  test(`${name} ${woken ? "still wakes" : "folds into the new-issue wake"}`, async () => {
    const opened = Date.parse(T(0))
    const filed = { ...issue(1, T(0)), created_at: T(0) }
    const w = await world([], { events: { 1: [labelEvent(new Date(opened + minutes * 60_000).toISOString(), label)] } })
    await w.poll()
    w.issues.push(filed)
    await w.poll(NOW)
    assert.equal(w.sent.length, 1)
    assert.match(w.sent[0][1], /new issue/u)
    w.issues[0] = { ...filed, updated_at: T(5) }
    await w.poll(NOW + 1000)
    assert.equal(w.sent.length, 1 + woken)
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
  assert.match(bad.err, /owner\/name#123/u)
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
    ["an issue the drain filed with a drain: label, whose body mentions this one", crossReference(T(5), sourceIssue(958, { labels: [{ name: "Drain: In Progress" }], body: "Follow-up to #1" })), {}],
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
    ["an issue with other labels and no marker", crossReference(T(5), sourceIssue(9, { labels: [{ name: "bug" }, {}], body: "Follow-up to #1" })), {}, "acme/widgets#9"],
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
  assert.deepEqual(calls, [["acme/widgets", 1, T(0)]], "only what is newer than the last marker is asked for")
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

const daily = (id, created_at, body, login = "automation[bot]", extra = {}) => ({ id, body, created_at, updated_at: created_at, user: { login, type: "Bot" }, ...extra })
const identity = (day, run) => `Identity checks for prod failed on 2026-11-${day}T06:0${run % 10}:12Z (see https://github.com/acme/widgets/actions/runs/98765${run}/job/1). Run ID: ${run}. Took ${run + 2} min 4.5s at ${day}:30 PM.`

test("a bot comment that repeats the same bot's previous comment on the issue, apart from dates, times, durations and run links, wakes nobody; a changed text, a first comment, another author or a person still wakes", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll()
  const before = [daily(1, T(1), identity("10", 1)), daily(2, T(2), "Heads up: unrelated"), daily(3, T(3), "someone's note", "alice", { user: { login: "alice", type: "User" } })]
  const wake = async (at, fresh, expected, name) => {
    w.issues[0] = issue(1, at)
    w.comments = async () => [...before, ...fresh]
    const count = w.sent.length
    await w.poll()
    assert.equal(w.sent.length - count, expected, name)
    before.push(...fresh)
  }
  // The first comment of a bot has nothing before it.
  w.issues[0] = issue(1, T(1))
  w.comments = async () => before.slice(0, 1)
  await w.poll()
  assert.equal(w.sent.length, 1, "a first comment is news")
  before.splice(1)
  await wake(T(10), [daily(4, T(10), identity("11", 2))], 0, "the next day's run says the same")
  await wake(T(11), [daily(5, T(11), identity("12", 3).replace("prod failed", "staging failed"))], 1, "a changed text")
  await wake(T(12), [daily(6, T(12), identity("13", 4).replace("prod failed", "staging failed"), "other[bot]")], 1, "another bot has no previous comment of its own")
  await wake(T(13), [daily(7, T(13), "Identity checks for prod failed", "alice", { user: { login: "alice", type: "User" } })], 1, "a person's comment")
  await wake(T(14), [daily(8, T(14), identity("14", 5).replace("prod failed", "staging failed"))], 0, "the repeat is against that bot's latest comment")
  // An edit of a bot comment is compared with the comment before it.
  w.issues[0] = issue(1, T(15))
  w.comments = async () => [...before, { ...daily(8, T(14), identity("14", 5).replace("prod failed", "staging failed")), updated_at: T(15) }]
  const count = w.sent.length
  await w.poll()
  assert.equal(w.sent.length, count, "an edit that still repeats")
  matches(w.state().seen["1"], seenAt(T(15)))
  // A bot known only by its login, and bodies or authors that are missing, compare as what they are.
  const bare = (id, created_at, body) => ({ id, created_at, updated_at: created_at, user: { login: "plain[bot]" }, ...(body === undefined ? {} : { body }) })
  const listed = [bare(20, T(16)), { id: 21, created_at: T(16), updated_at: T(16) }]
  w.issues[0] = issue(1, T(16))
  w.comments = async () => listed
  const quiet = w.sent.length
  await w.poll()
  assert.equal(w.sent.length, quiet + 1, "a bot's first comment, and a comment with no author, are news")
  listed.push(bare(22, T(17)))
  w.issues[0] = issue(1, T(17))
  await w.poll()
  assert.equal(w.sent.length, quiet + 1, "two comments with no text repeat each other")
})

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

test("a pull request the drain's marked status comment on the issue names is the drain's own, on any branch, and one it does not name still wakes", async () => {
  const status = (body) => ({ id: 70, body: `${body}\n${DRAIN_STATUS_MARKER}`, created_at: T(1), updated_at: T(1), user: { login: "maintainer" } })
  const cases = [
    ["a bare number", crossReference(T(5), sourceIssue(50, { pull_request: {} })), "PR #50 carries the fix", false],
    ["a pull request link", crossReference(T(5), sourceIssue(50, { pull_request: {} })), "PR https://github.com/acme/widgets/pull/50", false],
    ["another repository's pull request by its full name", crossReference(T(5), { number: 3, pull_request: {}, repository_url: "https://api.github.com/repos/other/thing" }), "PR other/thing#3", false],
    ["a pull request body with the marker", crossReference(T(5), sourceIssue(50, { pull_request: {}, body: `Fix.\n${DRAIN_STATUS_MARKER}` })), "nothing yet", false],
    ["a pull request the comment does not name", crossReference(T(5), sourceIssue(50, { pull_request: {} })), "PR #5 and #500 and acme/widgets#150", true],
    ["a bare number when the pull request is in another repository", crossReference(T(5), { number: 3, pull_request: {}, repository_url: "https://api.github.com/repos/other/thing" }), "PR #3", true],
  ]
  for (const [name, event, text, wakes] of cases) {
    const w = await quiet({ timeline: async () => [event] })
    const own = status(text)
    w.comments = async (_repo, n) => (n === 1 ? [own] : [])
    w.pull = async () => ({ head: { ref: "window/typing-key-cheaper" } })
    const out = await w.poll()
    assert.equal(out.wakes.length, wakes ? 1 : 0, name)
    matches(w.state().seen["1"], seenAt(T(5)))
  }
  const w = await quiet({ timeline: async () => [crossReference(T(5), sourceIssue(50, { pull_request: {} }))] })
  w.comments = async (_repo, n) => (n === 1 ? [{ ...statusComment(70, T(1), "someone"), body: `PR #50\n${DRAIN_STATUS_MARKER}` }] : [])
  assert.equal((await w.poll()).wakes.length, 1, "a marked comment by someone else is not the drain's")
  const unread = await quiet({ timeline: async () => [crossReference(T(5), sourceIssue(50, { pull_request: {} }))] })
  unread.comments = async (_repo, n, since) => {
    if (n === 1 && since.startsWith("1970")) throw new Error("HTTP 502")
    return []
  }
  assert.equal((await unread.poll()).wakes.length, 1, "comments that cannot be read link nothing")
})

const turnAt = (iso) => Date.parse(iso)
const byDrain = (event) => ({ ...event, actor: { login: "maintainer" } })

test("a label or state change by the polling account during the drain's turn is the drain's own work, whatever the label; before the wake, after the turn or by someone else it still wakes", async () => {
  const delivered = "2026-11-13T02:00:00.000Z"
  const start = async () => {
    const w = await world([issue(1, "2026-11-13T01:00:00Z")])
    await w.poll(turnAt("2026-11-13T01:00:00Z"))
    w.issues[0] = issue(1, "2026-11-13T01:59:00Z")
    w.comments = async () => [{ id: 9, body: "please look", updated_at: "2026-11-13T01:59:00Z", user: { login: "someone" } }]
    await w.poll(turnAt(delivered))
    assert.equal(w.sent.length, 1)
    assert.deepEqual(w.state().turns, [delivered])
    w.comments = async () => []
    return w
  }
  const cases = [
    ["a label the drain's scripts apply", [byDrain(labelEvent("2026-11-13T02:04:00Z", "waiting:external")), byDrain(labelEvent("2026-11-13T02:04:00Z", "lane:window")), byDrain(labelEvent("2026-11-13T02:04:00Z", "agent:drain"))], "2026-11-13T02:04:00Z", false],
    ["a label it removes", [byDrain(labelEvent("2026-11-13T02:10:00Z", "waiting:external", "unlabeled"))], "2026-11-13T02:10:00Z", false],
    ["a reopen it does", [byDrain(lifecycle("reopened", "2026-11-13T02:20:00Z"))], "2026-11-13T02:20:00Z", false],
    ["an assignment it makes", [byDrain(lifecycle("assigned", "2026-11-13T02:04:00Z", "maintainer", { assignee: { login: "maintainer" } }))], "2026-11-13T02:04:00Z", false],
    ["a label just before the wake was acknowledged", [byDrain(labelEvent("2026-11-13T01:59:30Z", "lane:window"))], "2026-11-13T02:00:30Z", false],
    ["a label by someone else in the turn", [labelEvent("2026-11-13T02:04:00Z", "lane:window"), { ...labelEvent("2026-11-13T02:04:00Z", "lane:window"), actor: { login: "someone" } }], "2026-11-13T02:04:00Z", true],
    ["a reopen by someone else in the turn", [{ ...lifecycle("reopened", "2026-11-13T02:20:00Z"), actor: { login: "someone" } }], "2026-11-13T02:20:00Z", true],
    ["a label by the account after the turn ran out", [byDrain(labelEvent("2026-11-13T03:31:00Z", "lane:window"))], "2026-11-13T03:31:00Z", true],
  ]
  for (const [name, events, at, wakes] of cases) {
    const w = await start()
    w.issues[0] = issue(1, at)
    w.events = async () => events
    const before = w.sent.length
    await w.poll(turnAt(at) + 5000)
    assert.equal(w.sent.length - before, wakes ? 1 : 0, name)
  }
})

test("the turns are kept per drain, only the recent ones, and a wake that is refused opens none", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll(turnAt("2026-11-13T00:00:00Z"))
  for (const hour of [1, 2, 3, 4, 5, 6]) {
    w.issues[0] = issue(1, `2026-11-13T0${hour}:00:00Z`)
    w.comments = async () => [{ id: hour, body: "x", updated_at: `2026-11-13T0${hour}:00:00Z`, user: { login: "someone" } }]
    if (hour === 6) w.refuse = "app busy"
    await w.poll(turnAt(`2026-11-13T0${hour}:01:00Z`))
  }
  assert.deepEqual(w.state().turns, ["02:01", "03:01", "04:01", "05:01"].map((time) => `2026-11-13T${time}:00.000Z`), "turns older than twice the turn length are dropped, and the refused wake opened none")
  for (let i = 0; i < 60; i += 1) {
    w.issues[0] = issue(1, `2026-11-13T07:${String(i).padStart(2, "0")}:30Z`)
    w.comments = async () => [{ id: 100 + i, body: "x", updated_at: w.issues[0].updated_at, user: { login: "someone" } }]
    await w.poll(turnAt(`2026-11-13T07:${String(i).padStart(2, "0")}:40Z`))
  }
  assert.equal(w.state().turns.length, 50)
})

test("an ignoreLabels pattern skips every label whose name matches it, case-insensitively, and only those", async () => {
  const lanes = { ...DRAIN, ignoreLabels: ["^waiting:", "^lane:"] }
  const w = await world([issue(1, T(0))], { drain: lanes })
  await w.poll()
  w.issues[0] = issue(1, T(5))
  w.events = async () => [labelEvent(T(5), "Waiting:External"), labelEvent(T(5), "lane:window", "unlabeled")]
  await w.poll()
  assert.deepEqual(w.sent, [])
  w.issues[0] = issue(1, T(10))
  w.events = async () => [labelEvent(T(10), "bug"), labelEvent(T(10), "not-waiting:x")]
  await w.poll()
  assert.equal(w.sent.length, 1)
  assert.match(w.sent[0][1], /labeled bug/u)
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

test("a failure that carries a stable code keeps it beside its text, and the next good poll clears it", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  const real = w.connect
  w.connect = async () => { throw Object.assign(new Error("Sign in the GitHub CLI"), { code: "drains_sign_in_the_github_cli" }) }
  const out = await w.poll(NOW + 1000)
  assert.deepEqual(out.errors, [{ repo: DRAIN.repo, error: "Sign in the GitHub CLI", code: "drains_sign_in_the_github_cli" }])
  w.connect = async () => { throw new Error("plain") }
  await w.poll(NOW + 2000)
  assert.equal(w.state().lastErrorCode, undefined)
  w.connect = real
  await w.poll(NOW + 3000)
  assert.equal(w.state().lastError, undefined)
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

test("a failure while reading one issue's comments leaves that issue's marker where it was, tells the poll's status and lets the other issues go on", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z"), issue(2, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.splice(0, 2, issue(1, "2026-11-13T02:00:00Z"), issue(2, "2026-11-13T02:00:00Z"))
  let calls = 0
  w.comments = async () => {
    if (calls++ === 0) throw new Error("GitHub answered HTTP 403")
    return [{ id: 1, body: "me too", updated_at: "2026-11-13T02:00:00Z", user: { login: "someone" } }]
  }
  let out = await w.poll()
  assert.equal(w.sent.length, 1, "the other issue was judged and woken in the same poll")
  assert.match(w.sent[0][1], /#2 Issue 2 \(comment 1 by someone\)/u)
  assert.deepEqual(out.errors, [{ repo: DRAIN.repo, code: "drains_issues_deferred", error: "Wait for the next poll: 1 issue(s) were left for it: #1 (GitHub answered HTTP 403)" }])
  assert.equal(w.state().seen["1"].updatedAt, "2026-11-13T01:00:00Z")
  assert.equal(w.state().seen["2"].updatedAt, "2026-11-13T02:00:00Z")
  out = await w.poll()
  assert.equal(w.sent.length, 2)
  assert.match(w.sent[1][1], /#1 Issue 1/u)
  assert.deepEqual(out.errors, [])
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
  const ok = parseDrainConfig(JSON.stringify({ drains: [{ repo: "a/b", session: " s ", account: " me ", ignoredBodyTrailers: [" Active-at "], ignoredLabels: [" agent:drain "], ignoreLabels: [" ^waiting: "], ignoreComments: [{ author: " ci[bot] ", match: "^took" }, { author: "other[bot]" }] }, { repo: "c/d", session: "t" }] }), "config.json")
  assert.deepEqual(ok, [{ repo: "a/b", session: "s", account: "me", ignoredBodyTrailers: ["Active-at"], ignoredLabels: ["agent:drain"], ignoreLabels: ["^waiting:"], ignoreComments: [{ author: "ci[bot]", match: "^took" }, { author: "other[bot]" }] }, { repo: "c/d", session: "t" }])
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
    [{ repo: "a/b", session: "s", ignoreLabels: "^waiting:" }, "drains[0].ignoreLabels is not a list"],
    [{ repo: "a/b", session: "s", ignoreLabels: [" "] }, "drains[0].ignoreLabels is not a list"],
    [{ repo: "a/b", session: "s", ignoreLabels: ["("] }, "drains[0].ignoreLabels[0] is not a valid regular expression"],
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

const response = (body, { status = 200, link = null, headers = {} } = {}) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: (name) => (name === "link" ? link : headers[name] ?? null), has: (name) => name in headers } })

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
    response({ message: "forbidden" }, { status: 403, headers: { ...headers, "x-ratelimit-remaining": "4000" } }),
    response({}, { status: 429 }),
    { ...response({}, { status: 403, headers: { "x-ratelimit-remaining": "4000" } }), text: async () => { throw new Error("body lost") } },
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
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), (error) => error.rateLimited === true && error.code === "drains_rate_limited" && /rate limited until 2026-/u.test(error.message) && !/gh auth/u.test(error.message))
  assert.equal(api.quota().remaining, 0, "the quota is read from the refusal too")
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), (error) => error.code === "drains_github_refused" && /GitHub refused the request with HTTP 403 for \/repos\/o\/r\/issues/u.test(error.message) && !/gh auth/u.test(error.message))
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), /rate limited until the next window \(HTTP 429/u)
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), (error) => error.code === "drains_github_refused" && !error.rateLimited, "a refusal whose body cannot be read is not called a rate limit, nor a credential problem")
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
  await assert.rejects(ok.openIssues("o/r"), /GitHub refused the request with HTTP 403 for \/repos\/o\/r\/issues;/u)
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
  assert.equal(second.wakes[0].replaces, "New or changed issues in acme/widgets:")
  assert.ok(second.wakes[0].message.startsWith(second.wakes[0].replaces), "every message starts with the prefix it replaces")
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
  assert.equal((await cli(["--help"])).code, 0)
  assert.match((await cli(["--help"])).out, /poll +List each configured repository's open issues/u)
  const usage = await cli(["poll", "--bogus", "x"])
  assert.equal(usage.code, 2)
  assert.match(usage.err, /^drains: poll: .*--bogus.*Fix: /u)
  const nowhere = await cli(["nope"])
  assert.equal(nowhere.code, 2)
  assert.match(nowhere.err, /^drains: .*nope/u)
  assert.match((await cli(["ack", "--repo", "a/b"])).err, /--wake/u)
  for (const bad of [["why"], ["why", "a/b"], ["why", "a#1"], ["why", "a/b#x"]]) assert.match((await cli(bad)).err, /why: .*owner\/name#123/u, bad.join(" "))
  writeFileSync(config, "{")
  const bad = await cli(["poll", "--config", config, "--state", state])
  assert.equal(bad.code, 1)
  assert.match(bad.err, /^desk: drains config: .* is not valid JSON/u)
  writeFileSync(`${state}.lock`, String(process.pid))
  const busy = await cli(["status", "--config", config, "--state", state], { now: () => NOW })
  assert.equal(busy.code, 1)
  const locked = await cli(["poll", "--config", config, "--state", state])
  assert.match(locked.err, /cannot tell whether a poll still holds it/u)
  assert.match(locked.err, /desk_drains_lock_legacy/u)
  rmSync(`${state}.lock`)
  mkdirSync(`${state}.lock`)
  writeFileSync(path.join(`${state}.lock`, `owner-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}`), `${process.pid}\n`)
  assert.match((await cli(["poll", "--config", config, "--state", state])).err, /holds .* and is still working/u)
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

const ARCHIVED = "Failed to send message: invalid argument: This workspace is archived. Restore it before continuing."

test("a drain whose session is archived starts a successor and sends its wakes there, keeping the waiting events", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.push(issue(2, "2026-11-13T03:00:00Z", "New thing"))
  w.refuse = ARCHIVED
  await w.poll()
  assert.equal(w.state().pending.length, 1)
  assert.match(w.state().targetGone.error, /archived/u)
  const started = []
  const result = recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW, start: (input) => { started.push(input); return { ok: true, session: "11111111-2222-3333-4444-555555555555" } } })
  assert.equal(result.changed, true)
  assert.deepEqual(started, [{ repo: DRAIN.repo, predecessor: DRAIN.session, account: "maintainer" }])
  assert.equal(w.state().targetGone, undefined)
  const out = await w.poll()
  assert.equal(out.wakes[0].session, "11111111-2222-3333-4444-555555555555")
  assert.match(out.status.find((line) => line.startsWith("issue drain")), /-> 11111111 \(succeeds 58fbd57e\)/u)
  assert.equal(w.state().pending.length, 0)
  assert.equal(JSON.parse(readFileSync(w.paths.config, "utf8")).drains[0].session, DRAIN.session)
})

test("a failed start of a successor is retried after ten minutes, never more often, and shows in the status", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.push(issue(2, "2026-11-13T03:00:00Z"))
  w.refuse = ARCHIVED
  await w.poll()
  let tries = 0
  const fail = () => { tries += 1; return { ok: false, error: "the app is not running" } }
  assert.equal(recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW, start: fail }).ok, false)
  assert.equal(recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW + 60_000, start: fail }).changed, false)
  assert.equal(tries, 1)
  const out = await pollDrains({ paths: w.paths, connect: w.connect, now: NOW + 60_000, ackCommand: [] })
  assert.match(out.status.find((line) => line.startsWith("issue drain")), /archived or gone, starting a successor: starting its successor failed: the app is not running/u)
  recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW + 11 * 60_000, start: () => ({ ok: true, session: "22222222-2222-3333-4444-555555555555" }) })
  assert.equal(w.state().successor.to, "22222222-2222-3333-4444-555555555555")
})

test("a successor lapses when the config names a new session, and an ordinary failure never starts one", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.push(issue(2, "2026-11-13T03:00:00Z"))
  w.refuse = "the app did not answer"
  await w.poll()
  assert.equal(w.state().targetGone, undefined)
  assert.equal(recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW, start: () => assert.fail("no successor") }).changed, false)
  w.refuse = ARCHIVED
  await w.poll()
  recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW, start: () => ({ ok: true, session: "33333333-2222-3333-4444-555555555555" }) })
  writeFileSync(w.paths.config, JSON.stringify({ drains: [{ ...DRAIN, session: "44444444-2222-3333-4444-555555555555" }] }))
  assert.equal((await pollDrains({ paths: w.paths, connect: w.connect, now: NOW, ackCommand: [] })).status.some((line) => line.includes("-> 44444444: ")), true)
})

test("startSuccessor asks Shepherd to create the drain's session with a Succeeds line first, and reports why it could not", async () => {
  const seen = []
  const ok = startSuccessor({ repo: "acme/widgets", predecessor: DRAIN.session, account: "me" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn: (...call) => { seen.push(call); return { status: 0, stdout: '{"ok":true,"session_id":"abc"}' } } })
  assert.deepEqual(ok, { ok: true, session: "abc" })
  assert.equal(seen[0][0], "shep")
  const args = seen[0][1]
  assert.deepEqual(args.slice(0, 5), ["create", "--project", "acme/widgets", "--name", "Drain: acme/widgets"])
  assert.equal(args[args.indexOf("--prompt") + 1].split("\n")[0], `Succeeds: ${DRAIN.session}`)
  assert.match(args[args.indexOf("--why") + 1], /archived drain/u)
  assert.match(successorKickoff({ repo: "a/b", predecessor: "x", account: "me" }), /Work on GitHub as me/u)
  const bad = startSuccessor({ repo: "a/b", predecessor: "x" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn: () => ({ status: 1, stdout: '{"ok":false,"error":"no project \'a/b\'"}' }) })
  assert.deepEqual(bad, { ok: false, error: "no project 'a/b'" })
  assert.equal(startSuccessor({ repo: "a/b", predecessor: "x" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn: () => ({ status: 1, stdout: "", stderr: "boom\nmore" }) }).error, "boom")
  assert.equal(startSuccessor({ repo: "a/b", predecessor: "x" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn: () => ({ status: null, stdout: "", stderr: "", error: new Error("spawn shep ENOENT") }) }).error, "spawn shep ENOENT")
  assert.equal(startSuccessor({ repo: "a/b", predecessor: "x" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn: () => ({ status: 1, stdout: "", stderr: "" }) }).error, "shepherd create printed no session")
  // Without an override: the housesitter release when it is installed, else shepherd on PATH.
  const home = await mkTempRoot("desk-drains-")
  const bin = path.join(home, "Library", "Application Support", "housesitter", "releases", "shepherd", "current", "bin")
  const programs = []
  const spawn = (program, args) => { programs.push([program, args[0]]); return { status: 0, stdout: '{"ok":true,"session_id":"s"}' } }
  startSuccessor({ repo: "a/b", predecessor: "x" }, { env: {}, homeDir: home, spawn })
  mkdirSync(bin, { recursive: true })
  writeFileSync(path.join(bin, "shepherd.mjs"), "")
  startSuccessor({ repo: "a/b", predecessor: "x" }, { env: {}, homeDir: home, spawn })
  assert.deepEqual(programs, [["shepherd", "create"], [process.execPath, path.join(bin, "shepherd.mjs")]])
})

test("a token read that times out or hits a busy keyring is retried and never says to sign in", async () => {
  const tries = []
  const flaky = [{ status: null, signal: "SIGTERM", stdout: "" }, { status: 1, stdout: "", stderr: "keychain is locked\n" }, { status: 0, stdout: "tok\n" }]
  const spawn = () => { tries.push(1); return flaky[tries.length - 1] }
  const api = await connectGithub("me", { spawn, pauseMs: 1, fetchImpl: async () => response({ login: "me" }) })
  assert.equal(api.login, "me")
  assert.equal(tries.length, 3)
  const never = { spawn: () => ({ status: null, signal: "SIGTERM" }), pauseMs: 1 }
  const failure = await connectGithub("me", never).catch((error) => error)
  assert.equal(failure.code, "drains_github_cli_token_unavailable")
  assert.doesNotMatch(failure.message, /Sign in|gh auth login/u)
  const missing = []
  const signedOut = await connectGithub("me", { spawn: () => { missing.push(1); return { status: 1, stdout: "", stderr: "no oauth token found for github.com account me" } }, pauseMs: 1 }).catch((error) => error)
  assert.equal(signedOut.code, "drains_sign_in_the_github_cli")
  assert.equal(missing.length, 1, "a signed-out account is not retried")
})

test("an archived-session error for a drain no longer in the config is still recorded", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.push(issue(2, "2026-11-13T03:00:00Z", "New thing"))
  await w.poll()
  const config = JSON.parse(readFileSync(w.paths.config, "utf8"))
  writeFileSync(w.paths.config, JSON.stringify({ ...config, drains: [{ ...config.drains[0], repo: "other/repo" }] }))
  ackWake({ paths: w.paths, repo: DRAIN.repo, wake: wakeId(DRAIN.repo, w.state().pending), error: ARCHIVED, now: NOW })
  assert.match(w.state().targetGone.error, /archived/u)
})

test("startSuccessor adopts the session the app created even though it answered too late", () => {
  const recent = new Date().toISOString()
  const spawn = (_program, args) => args.includes("sessions")
    ? { status: 0, stdout: JSON.stringify({ sessions: [{ id: "old", name: "Drain: a/b", created_at: recent }, { id: "other", name: "Drain: c/d", created_at: recent }, { id: "stale", name: "Drain: a/b", created_at: "2020-01-01T00:00:00Z" }, { id: "new", name: "Drain: a/b", created_at: recent }] }) }
    : { status: 1, stdout: '{"ok":false,"error":"the app did not answer in time"}' }
  assert.deepEqual(startSuccessor({ repo: "a/b", predecessor: "old" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn }), { ok: true, session: "new" })
})

test("every kind of failed token read names what gh said, or that it stopped", async () => {
  const say = (result) => connectGithub("me", { spawn: () => result, pauseMs: 1 }).catch((error) => error.message)
  assert.match(await say({ status: null, error: new Error("spawnSync gh ETIMEDOUT") }), /ETIMEDOUT/u)
  assert.match(await say({ status: null, signal: "SIGKILL" }), /gh stopped \(SIGKILL\)/u)
  assert.match(await say({ status: null }), /gh stopped \(no status\)/u)
  assert.match(await connectGithub(undefined, { spawn: () => ({ status: null }), pauseMs: 1 }).catch((error) => error.message), /its active account/u)
  assert.match(await say({ status: 2, stderr: "", stdout: "" }), /no token for me/u)
  assert.match(await say({ status: null, error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }) }), /no token for me/u)
})

test("startSuccessor with no options uses the process environment and reports a missing shepherd", () => {
  const before = process.env.DESK_DRAINS_SHEPHERD
  process.env.DESK_DRAINS_SHEPHERD = "/no/such/shepherd-for-drains-test"
  try {
    const result = startSuccessor({ repo: "a/b", predecessor: "x" })
    assert.equal(result.ok, false)
    assert.match(result.error, /ENOENT/u)
  } finally {
    if (before === undefined) delete process.env.DESK_DRAINS_SHEPHERD
    else process.env.DESK_DRAINS_SHEPHERD = before
  }
})

test("a drain whose session lost its workspace folder starts a successor like an archived one", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.push(issue(2, "2026-11-13T03:00:00Z", "New thing"))
  w.refuse = "Failed to send message: invalid argument: this session can't receive messages because its workspace folder is missing."
  await w.poll()
  assert.match(w.state().targetGone.error, /workspace folder is missing/u)
  const started = []
  const result = recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW, start: (input) => { started.push(input); return { ok: true, session: "11111111-2222-3333-4444-555555555555" } } })
  assert.equal(result.changed, true)
  assert.equal(started.length, 1)
  assert.equal((await w.poll()).wakes[0].session, "11111111-2222-3333-4444-555555555555")
})

test("startSuccessor finds the app's project by the repository its sessions list when the repository is not a project name", () => {
  const seen = []
  const spawn = (_program, args) => {
    seen.push(args)
    if (args.includes("sessions")) return { status: 0, stdout: JSON.stringify({ sessions: [{ project_repo: "o/other", project_id: "p0" }, { project_repo: "gim/CIT", project_id: "p1" }] }) }
    return args[args.indexOf("--project") + 1] === "p1" ? { status: 0, stdout: '{"ok":true,"session_id":"new"}' } : { status: 1, stdout: '{"ok":false,"code":"no-project","error":"no project"}' }
  }
  assert.deepEqual(startSuccessor({ repo: "gim/CIT", predecessor: "old" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn }), { ok: true, session: "new" })
  assert.deepEqual(seen.map((args) => args[0]), ["create", "sessions", "create"])
  const none = startSuccessor({ repo: "x/y", predecessor: "old" }, { env: { DESK_DRAINS_SHEPHERD: "shep" }, spawn: (_p, args) => args.includes("sessions") ? { status: 0, stdout: "not json" } : { status: 1, stdout: '{"ok":false,"code":"no-project","error":"no project \'x/y\'"}' } })
  assert.deepEqual(none, { ok: false, error: "no project 'x/y'" })
})

test("a failed successor start keeps its reason when the next wake is refused as archived again", async () => {
  const w = await world([issue(1, "2026-11-13T01:00:00Z")])
  await w.poll()
  w.issues.push(issue(2, "2026-11-13T03:00:00Z", "New thing"))
  await w.poll()
  const wake = wakeId(DRAIN.repo, w.state().pending)
  ackWake({ paths: w.paths, repo: DRAIN.repo, wake, error: ARCHIVED, now: NOW })
  recoverDrainTarget({ paths: w.paths, repo: DRAIN.repo, now: NOW, start: () => ({ ok: false, error: "no project" }) })
  ackWake({ paths: w.paths, repo: DRAIN.repo, wake, error: ARCHIVED, now: NOW + 1000 })
  assert.match(w.state().targetGone.error, /starting its successor failed: no project/u)
})

// Bot body edits. The fake GitHub keeps one edit history per issue in `w.hist[number]`, answers `editPage` one page at a time in
// either order and keeps the GraphQL quota in virtual windows of an hour: nothing sleeps and no real quota is spent.
const BOT = "github-actions[bot]"
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z")
const LONG_AGO = Date.parse("2026-01-01T00:00:00Z")
const botEdit = (id, editedAt) => ({ id, editedAt, deletedAt: null, editor: { type: "Bot", login: BOT } })
const personEdit = (id, editedAt) => ({ id, editedAt, deletedAt: null, editor: { type: "User", login: "ari" } })

/** `count` old bot edits, made long before any poll and made up as they are asked for, then the `extra` edits that arrive. */
const history = (count, { order = "asc", extra = [] } = {}) => ({
  count, order, extra,
  get total() { return this.count + this.extra.length },
  at(index) { return index < this.count ? botEdit(`o${index}`, iso(LONG_AGO + index * 1000)) : this.extra[index - this.count] },
})

/** The page of up to 100 edits that follows `cursor` in a direction; a cursor is the position of the last edit of the page before it, so it stays valid as edits arrive. */
function pageOf(h, { backward, cursor }) {
  const step = (backward ? -1 : 1) * (h.order === "asc" ? 1 : -1)
  let index = cursor === null ? (step > 0 ? 0 : h.total - 1) : Number(cursor.slice(1)) + step
  const nodes = []
  let last = null
  while (nodes.length < 100 && index >= 0 && index < h.total) {
    nodes.push(h.at(index))
    last = index
    index += step
  }
  return { nodes, hasMore: index >= 0 && index < h.total, cursor: `c${last}` }
}

async function editsWorld(issues, { limit = 5000 } = {}) {
  const w = await deltaWorld(issues)
  w.delta = async () => ({ issues: w.issues, etag: '"t"' })
  w.hist = {}
  w.reads = []
  w.clock = NOW
  w.window = { limit, remaining: limit, reset: Math.floor(NOW / 1000) + 3600 }
  const refresh = () => {
    if (w.clock < w.window.reset * 1000) return
    w.window.remaining = w.window.limit
    w.window.reset = Math.floor(w.clock / 1000) + 3600
  }
  w.api.graphqlQuota = () => { refresh(); return { ...w.window, at: iso(w.clock) } }
  w.api.graphqlCost = () => 1
  w.api.editPage = async (repo, number, { backward = false, cursor = null } = {}) => {
    refresh()
    w.reads.push({ number, backward, cursor })
    if (w.window.remaining <= 0) throw Object.assign(new Error("Wait for the quota to reset: GraphQL limit used up"), { code: "drains_rate_limited" })
    w.window.remaining -= 1
    const h = w.hist[number]
    if (h instanceof Error) throw h
    const found = w.issues.find((item) => item.number === number)
    const page = h.page ? h.page({ backward, cursor }) : pageOf(h, { backward, cursor })
    return { updatedAt: h.stamp ?? found.updated_at, total: h.total, edits: page.nodes, hasMore: page.hasMore, cursor: page.cursor }
  }
  const poll = w.poll
  w.poll = async (at = NOW) => { w.clock = at; return poll(at) }
  /** The issue's body changes at `at`, with an `edit` to show for it (or none). */
  w.change = (number, at, edit) => {
    if (edit) w.hist[number].extra.push(edit)
    const index = w.issues.findIndex((item) => item.number === number)
    w.issues[index] = { ...w.issues[index], updated_at: iso(at), body: `health: ${at}` }
  }
  return w
}

const ISSUE = () => issue(1, T(0), "Health", "health: 0")

test("a history of 5,001 pages (500,100 edits) is read across quota windows from where it stopped, while a bot rewrites the body every six minutes: no restart, no wake, and the next change costs a page or two", async () => {
  for (const order of ["asc", "desc"]) {
    const w = await editsWorld([ISSUE()])
    w.hist[1] = history(500_100, { order })
    await w.poll()
    const wakes = []
    for (let k = 1; k <= 14; k++) {
      const at = NOW + k * 360_000
      w.change(1, at, botEdit(`n${k}`, iso(at)))
      wakes.push(...(await w.poll(at)).wakes)
      if (k < 10) {
        assert.ok(w.state().scans[1], `${order}: still reading at poll ${k}`)
        assert.match(w.state().lastError, /were left for it/u)
        assert.equal(w.state().lastErrorCode, "drains_rate_limited")
        assert.equal(w.state().seen[1].updatedAt, T(0), "the marker stays while the scan is open")
        assert.equal(w.state().etag, undefined, "no 304 for a list with a change still being read")
      }
      if (k === 9) {
        assert.equal(w.reads.filter((read) => !read.backward && read.cursor === null).length, 1, `${order}: the history was started once`)
        assert.ok(w.reads.length <= 5000 - 25, "the reserve of the quota is kept")
      }
    }
    assert.deepEqual(wakes, [], order)
    assert.equal(w.state().scans[1], undefined)
    assert.equal(w.state().lastError, undefined)
    assert.equal(w.state().seen[1].edits.total, 500_114)
    assert.ok(w.reads.length <= 5002 + 10 + 4 * 2 + 2, `${order}: ${w.reads.length} pages read in all, about one pass`)
  }
})

test("a person's edit among a bot's changes is not hidden by them, however long the scan takes: one wake, when the scan reaches it", async () => {
  for (const order of ["asc", "desc"]) {
    const w = await editsWorld([ISSUE()])
    w.hist[1] = history(500_100, { order })
    await w.poll()
    const wakes = []
    for (let k = 1; k <= 10; k++) {
      const at = NOW + k * 360_000
      w.change(1, at, k === 5 ? personEdit("human", iso(at)) : botEdit(`n${k}`, iso(at)))
      wakes.push(...(await w.poll(at)).wakes)
      if (k < 10) assert.deepEqual(wakes, [], `${order}: nothing woke while the scan was reading (poll ${k})`)
    }
    assert.equal(wakes.length, 1, order)
    assert.deepEqual(wakes[0].events.map((event) => event.why), ["title or body edited"])
    assert.equal(w.state().scans[1], undefined)
  }
})

test("scans that outnumber the pages the quota allows take turns, so none is starved and each finishes", async () => {
  const w = await editsWorld([issue(1, T(0), "A"), issue(2, T(0), "B"), issue(3, T(0), "C")], { limit: 25 + 1 + 450 })
  for (const n of [1, 2, 3]) w.hist[n] = history(40_000)
  await w.poll()
  for (const n of [1, 2, 3]) w.change(n, NOW + 3_600_000, botEdit(`n${n}`, iso(NOW + 3_600_000)))
  await w.poll(NOW + 3_600_000)
  const progress = [1, 2, 3].map((n) => w.state().scans[n].fwd.pages)
  assert.ok(Math.max(...progress) - Math.min(...progress) <= 1, `evenly served: ${progress}`)
  assert.equal(progress.reduce((a, b) => a + b), 450)
  await w.poll(NOW + 7_200_000)
  await w.poll(NOW + 10_800_000)
  const out = await w.poll(NOW + 14_400_000)
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(w.state().scans, {})
  for (const n of [1, 2, 3]) assert.equal(w.state().seen[n].edits.total, 40_001)
})

test("a cheap issue a person edited is woken in the first poll, whatever an expensive scan or a failing read beside it does, and a new issue is not held back", async () => {
  for (const failure of ["quota", "network"]) {
    const w = await editsWorld([issue(1, T(0), "Big"), issue(2, T(0), "Small")], { limit: failure === "quota" ? 60 : 5000 })
    w.hist[1] = failure === "quota" ? history(500_100) : Object.assign(new Error("Check gh auth status, then try again: GitHub answered HTTP 502 for /graphql"), { code: "drains_check_gh_auth_status_then" })
    w.hist[2] = history(2)
    await w.poll()
    if (failure === "network") w.hist[1] = Object.assign(new Error("Check gh auth status, then try again: GitHub answered HTTP 502 for /graphql"), { code: "drains_check_gh_auth_status_then" })
    const big = w.hist[1]
    if (failure === "quota") w.change(1, NOW + 360_000, botEdit("n1", iso(NOW + 360_000)))
    else w.issues[0] = { ...w.issues[0], updated_at: iso(NOW + 360_000), body: "health: 1" }
    w.change(2, NOW + 360_000, personEdit("human", iso(NOW + 360_000)))
    w.issues.push(issue(3, iso(NOW + 360_000), "Fresh"))
    const out = await w.poll(NOW + 360_000)
    assert.deepEqual(out.wakes[0].events.map((event) => `${event.number} ${event.why}`).sort(), ["2 title or body edited", "3 new issue"], failure)
    assert.equal(w.state().seen[1].updatedAt, T(0), "the expensive issue keeps its marker")
    assert.equal(w.state().etag, undefined)
    assert.equal(out.errors.length, 1)
    assert.match(out.errors[0].error, /1 issue\(s\) were left for it: #1/u)
    assert.equal(w.state().lastErrorCode, failure === "quota" ? "drains_rate_limited" : "drains_check_gh_auth_status_then")
    assert.deepEqual(w.state().pending, [])
    if (failure === "network") {
      w.hist[1] = history(3)
      w.change(1, NOW + 720_000, botEdit("n1", iso(NOW + 720_000)))
      const again = await w.poll(NOW + 720_000)
      assert.deepEqual(again.wakes, [], "the issue that could not be read is judged on the next poll, and a bot's edit is quiet")
      assert.deepEqual(again.errors, [])
      assert.equal(w.state().seen[1].updatedAt, iso(NOW + 720_000))
    }
    void big
  }
})

test("a failed read alone wakes nobody, and keeps the marker, and lists the issue again next poll", async () => {
  const w = await editsWorld([ISSUE()])
  w.hist[1] = history(3)
  await w.poll()
  w.hist[1] = Object.assign(new Error("Check gh auth status, then try again: GitHub answered HTTP 401 for /graphql"), { code: "drains_check_gh_auth_status_then" })
  w.issues[0] = { ...w.issues[0], updated_at: T(5), body: "health: 2" }
  const out = await w.poll(NOW + 360_000)
  assert.deepEqual(out.wakes, [])
  assert.deepEqual(out.errors, [{ repo: DRAIN.repo, code: "drains_check_gh_auth_status_then", error: "Wait for the next poll: 1 issue(s) were left for it: #1 (Check gh auth status, then try again: GitHub answered HTTP 401 for /graphql)" }])
  assert.equal(w.state().seen[1].updatedAt, T(0))
  assert.equal(w.state().cursor, T(5), "the next poll lists the issue again: the cursor is held at its change")
})

test("a history whose cursors cycle, across polls, or that stands still is refused as news, never read for ever", async () => {
  const cycling = async (cursors) => {
    const w = await editsWorld([ISSUE()], { limit: 25 + 1 + 2 })
    w.hist[1] = Object.assign(history(250), { page: ({ cursor }) => ({ nodes: Array.from({ length: 100 }, (_, i) => botEdit(`${cursor}-${i}`, iso(LONG_AGO + i * 1000))), hasMore: true, cursor: cursors(cursor) }) })
    await w.poll()
    w.change(1, NOW + 360_000, null)
    return w
  }
  const w = await cycling((cursor) => (cursor === "a" ? "b" : "a"))
  let out = await w.poll(NOW + 360_000)
  assert.deepEqual(out.wakes, [])
  assert.equal(w.state().scans[1].fwd.pages, 2, "two pages of the quota were read, the cursor is kept")
  out = await w.poll(NOW + 3_960_000)
  assert.equal(out.wakes.length, 1, "the third and fourth page went round: the scan ends, as news")
  assert.deepEqual(out.wakes[0].events.map((event) => event.why), ["title or body edited"])
  assert.equal(w.state().scans[1], undefined)
  const still = await cycling((cursor) => cursor ?? "a")
  out = await still.poll(NOW + 360_000)
  assert.equal(out.wakes.length, 1, "a cursor that does not move is news")
})

test("once an issue has a baseline, the next bot edit costs one or two pages in either order and wakes nobody", async () => {
  for (const order of ["asc", "desc"]) {
    const w = await editsWorld([ISSUE()])
    w.hist[1] = history(250, { order })
    await w.poll()
    w.change(1, NOW + 360_000, botEdit("n1", iso(NOW + 360_000)))
    assert.deepEqual((await w.poll(NOW + 360_000)).wakes, [])
    assert.deepEqual({ ...w.state().seen[1].edits, tail: undefined }, { total: 251, at: iso(NOW + 360_000), tail: undefined })
    const before = w.reads.length
    w.change(1, NOW + 720_000, botEdit("n2", iso(NOW + 720_000)))
    assert.deepEqual((await w.poll(NOW + 720_000)).wakes, [])
    assert.ok(w.reads.length - before <= 2, `${order}: ${w.reads.length - before} pages`)
    assert.equal(w.state().seen[1].edits.total, 252)
    w.change(1, NOW + 1_080_000, personEdit("human", iso(NOW + 1_080_000)))
    assert.equal((await w.poll(NOW + 1_080_000)).wakes.length, 1, `${order}: a person's edit after the baseline wakes`)
  }
})

test("a history that lags the issue is read again next poll and settles then; the issue is not woken for the lag", async () => {
  const w = await editsWorld([ISSUE()])
  w.hist[1] = history(3)
  await w.poll()
  w.change(1, NOW + 360_000, botEdit("n1", iso(NOW + 360_000)))
  w.hist[1].stamp = T(0)
  let out = await w.poll(NOW + 360_000)
  assert.deepEqual(out.wakes, [])
  assert.match(out.errors[0].error, /were left for it: #1 \(Wait for the next poll: GitHub's edit history is behind the issue/u)
  assert.equal(w.state().seen[1].updatedAt, T(0))
  w.hist[1].stamp = undefined
  out = await w.poll(NOW + 720_000)
  assert.deepEqual(out.errors, [])
  assert.equal(w.state().seen[1].updatedAt, iso(NOW + 360_000))
})

test("a change is news unless every new edit is a bot's: a person, a person before or after a bot, an unknown or deleted edit, an edit with no time or id, no new edit at all", async () => {
  const at = iso(NOW + 360_000)
  const cases = [
    ["a person", [personEdit("p", at)]],
    ["a person, then a bot", [personEdit("p", at), botEdit("b", at)]],
    ["a bot, then a person", [botEdit("b", at), personEdit("p", at)]],
    ["a person at the second of the last poll", [personEdit("p", T(0)), botEdit("b", at)]],
    ["an edit whose editor is gone", [{ id: "x", editedAt: at, deletedAt: null, editor: null }, botEdit("b", at)]],
    ["a deleted edit", [{ ...botEdit("d", at), deletedAt: at }]],
    ["an edit with no time", [botEdit("t", null)]],
    ["an edit with no id", [{ ...botEdit("i", at), id: null }]],
    ["an editor with no type or login", [{ id: "e", editedAt: at, deletedAt: null, editor: { login: null, type: null } }]],
    ["no new edit at all", []],
  ]
  for (const [name, extra] of cases) {
    const w = await editsWorld([ISSUE()])
    w.hist[1] = history(3, { extra: [] })
    await w.poll()
    w.hist[1].extra.push(...extra)
    w.change(1, NOW + 360_000, null)
    const out = await w.poll(NOW + 360_000)
    assert.equal(out.wakes.length, 1, name)
    assert.deepEqual(out.wakes[0].events.map((event) => event.why), ["title or body edited"], name)
  }
})

test("a title change is news with no history read; a record without a title is news; so is a reader that is not there", async () => {
  const w = await editsWorld([ISSUE()])
  w.hist[1] = history(3)
  await w.poll()
  w.issues[0] = issue(1, T(5), "Renamed", "health: 2")
  const out = await w.poll(NOW + 360_000)
  assert.deepEqual(out.wakes[0].events.map((event) => `${event.number} ${event.why}`), ["1 title or body edited"])
  assert.deepEqual(w.reads, [])
  const legacy = await editsWorld([ISSUE()])
  await legacy.poll()
  const stored = JSON.parse(readFileSync(legacy.paths.state, "utf8"))
  delete stored[DRAIN.repo].seen[1].title
  writeFileSync(legacy.paths.state, JSON.stringify(stored))
  legacy.hist[1] = history(3)
  legacy.change(1, NOW + 360_000, botEdit("b", iso(NOW + 360_000)))
  assert.equal((await legacy.poll(NOW + 360_000)).wakes.length, 1)
  const none = await world([ISSUE()])
  await none.poll()
  none.issues[0] = issue(1, T(5), "Health", "health: 2")
  assert.equal((await none.poll(NOW + 360_000)).wakes.length, 1)
})

test("who created the issue is no veto: on a bot-created issue a bot-only rewrite is quiet, a person's edit wakes, and so does a person's edit followed by a bot's", async () => {
  const mine = () => ({ ...ISSUE(), user: { login: BOT, type: "Bot" } })
  const setup = async () => {
    const w = await editsWorld([mine()])
    w.hist[1] = history(3)
    await w.poll()
    return w
  }
  const quiet = await setup()
  quiet.change(1, NOW + 360_000, botEdit("b1", iso(NOW + 360_000)))
  quiet.issues[0] = { ...quiet.issues[0], user: { login: BOT, type: "Bot" } }
  await quiet.poll(NOW + 360_000)
  assert.deepEqual(quiet.sent, [])
  assert.ok(quiet.reads.length > 0, "the history was read")
  const human = await setup()
  human.change(1, NOW + 360_000, personEdit("p1", iso(NOW + 360_000)))
  human.issues[0] = { ...human.issues[0], user: { login: BOT, type: "Bot" } }
  assert.equal((await human.poll(NOW + 360_000)).wakes.length, 1)
  const both = await setup()
  both.change(1, NOW + 300_000, personEdit("p1", iso(NOW + 300_000)))
  both.change(1, NOW + 360_000, botEdit("b1", iso(NOW + 360_000)))
  both.issues[0] = { ...both.issues[0], user: { login: BOT, type: "Bot" } }
  const out = await both.poll(NOW + 360_000)
  assert.deepEqual(out.wakes[0].events.map((event) => event.number), [1])
})

test("a bot's body edit does not hide the rest: a person's comment, an outside label, a reopen, a cross-reference and an assignment still wake", async () => {
  const quietEdit = async (setup) => {
    const w = await editsWorld([ISSUE()])
    w.hist[1] = history(3)
    await w.poll()
    w.change(1, NOW + 360_000, botEdit("n1", iso(NOW + 360_000)))
    setup(w)
    await w.poll(NOW + 360_000)
    return w
  }
  const quiet = await quietEdit(() => {})
  assert.deepEqual(quiet.sent, [])
  const comment = await quietEdit((w) => { w.comments = async () => [{ id: 7, body: "please look", updated_at: iso(NOW + 300_000), user: { login: "ari", type: "User" } }] })
  assert.match(comment.sent[0][1], /comment 7 by ari/u)
  const label = await quietEdit((w) => { w.events = async () => [{ ...labelEvent(iso(NOW + 300_000), "bug"), actor: { login: "ari" } }] })
  assert.match(label.sent[0][1], /labeled bug/u)
  const reopen = await quietEdit((w) => { w.events = async () => [lifecycle("reopened", iso(NOW + 300_000), "ari")] })
  assert.match(reopen.sent[0][1], /reopened/u)
  const reference = await quietEdit((w) => { w.timeline = async () => [{ event: "cross-referenced", created_at: iso(NOW + 300_000), source: { issue: { number: 9, repository_url: "https://api.github.com/repos/acme/other" } } }] })
  assert.match(reference.sent[0][1], /cross-reference from acme\/other#9/u)
  const assigned = await quietEdit((w) => { w.events = async () => [lifecycle("assigned", iso(NOW + 300_000), "ari", { assignee: { login: "dev" } })] })
  assert.match(assigned.sent[0][1], /assigned dev/u)
  const unassigned = await quietEdit((w) => { w.events = async () => [lifecycle("unassigned", iso(NOW + 300_000), "ari", { assignee: { login: "dev" } })] })
  assert.match(unassigned.sent[0][1], /unassigned dev/u)
  const nobody = await quietEdit((w) => { w.events = async () => [lifecycle("unassigned", iso(NOW + 300_000), "ari")] })
  assert.match(nobody.sent[0][1], /unassigned nobody/u)
  const opening = await quietEdit((w) => { w.issues[0] = { ...w.issues[0], created_at: iso(NOW + 299_000) }; w.events = async () => [lifecycle("assigned", iso(NOW + 300_000), "ari", { assignee: { login: "dev" } })] })
  assert.deepEqual(opening.sent, [], "an assignment made as the issue was opened is not news")
  const own = await quietEdit((w) => { w.comments = async () => [statusComment(8, iso(NOW + 300_000))] })
  assert.deepEqual(own.sent, [], "the drain's own comment still wakes nobody")
})

const editAnswer = (nodes, { total = nodes.length, next = false, prev = false, start = "s", end = "e", updatedAt = T(5), cost = 1, headers = {} } = {}) =>
  response({ data: { rateLimit: { cost }, repository: { issue: { updatedAt, userContentEdits: { totalCount: total, pageInfo: { hasNextPage: next, hasPreviousPage: prev, startCursor: start, endCursor: end }, nodes } } } } }, { headers })

test("editPage reads one page from the start or the end with the account's token, and keeps GraphQL's quota and cost apart from REST's", async () => {
  const calls = []
  const answers = [
    response([issue(1, "u1")], { headers: { "x-ratelimit-remaining": "4000", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1900000000", "x-ratelimit-resource": "core" } }),
    editAnswer([{ id: "E1", editedAt: T(5), deletedAt: null, editor: { __typename: "Bot", login: "app[bot]" } }, { id: "E2", editedAt: T(1), deletedAt: T(2), editor: null }], { total: 250, next: true, end: "after-2", cost: 2, headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-limit": "5000", "x-ratelimit-reset": "1900000100", "x-ratelimit-resource": "graphql" } }),
    editAnswer([], { total: 250, prev: true, start: "before-1" }),
  ]
  const api = await connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok\n" }), fetchImpl: async (url, init) => { calls.push([url, init]); return answers.shift() }, env: { PATH: "/bin" }, login: "maintainer" })
  await api.openIssues("o/r")
  assert.equal(api.graphqlCost(), 1, "one call until a page says otherwise")
  const first = await api.editPage("o/r", 5)
  assert.equal(api.graphqlCost(), 2, "the cost GitHub charged for the page")
  assert.equal(calls[1][0], "https://api.github.com/graphql")
  assert.equal(calls[1][1].headers.Authorization, "Bearer tok")
  assert.deepEqual(JSON.parse(calls[1][1].body).variables, { owner: "o", name: "r", number: 5, cursor: null })
  assert.match(JSON.parse(calls[1][1].body).query, /userContentEdits\(first: 100, after: \$cursor\)/u)
  assert.deepEqual(first, {
    updatedAt: T(5), total: 250, hasMore: true, cursor: "after-2",
    edits: [{ id: "E1", editedAt: T(5), deletedAt: null, editor: { type: "Bot", login: "app[bot]" } }, { id: "E2", editedAt: T(1), deletedAt: T(2), editor: null }],
  })
  const last = await api.editPage("o/r", 5, { backward: true, cursor: "x" })
  assert.match(JSON.parse(calls[2][1].body).query, /userContentEdits\(last: 100, before: \$cursor\)/u)
  assert.equal(JSON.parse(calls[2][1].body).variables.cursor, "x")
  assert.deepEqual({ hasMore: last.hasMore, cursor: last.cursor }, { hasMore: true, cursor: "before-1" })
  assert.equal(api.quota().remaining, 4000)
  assert.equal(api.graphqlQuota().remaining, 4990)
  assert.equal(api.graphqlCost(), 1)
  assert.deepEqual(api.calls(), { total: 3, notModified: 0 })
})

test("editPage: a missing issue is null and a page that is not a connection has no edits; failures say why: HTTP errors, GraphQL errors, no data, a spent quota", async () => {
  const connect = (answer) => connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: async () => answer, env: { PATH: "/bin" }, login: "maintainer" })
  assert.equal(await (await connect(response({ data: { repository: { issue: null } } }))).editPage("o/r", 1), null)
  assert.deepEqual(await (await connect(response({ data: { repository: { issue: { updatedAt: T(1), userContentEdits: {} } } } }))).editPage("o/r", 1), { edits: null })
  await assert.rejects((await connect(response({}, { status: 502 }))).editPage("o/r", 1), /HTTP 502 for \/graphql/u)
  await assert.rejects((await connect(response({ errors: [{ message: "Something went wrong" }] }))).editPage("o/r", 1), /Something went wrong/u)
  await assert.rejects((await connect(response({ data: null }))).editPage("o/r", 1), /refused or unreadable/u)
  await assert.rejects((await connect(response({ errors: [null, {}] }))).editPage("o/r", 1), /refused or unreadable \(; \)/u)
  await assert.rejects((await connect({ ...response({}), json: async () => { throw new Error("not json") } })).editPage("o/r", 1), /refused or unreadable \(no data\)/u)
  assert.deepEqual((await (await connect(editAnswer([null, { editor: { __typename: null, login: null } }], { next: true }))).editPage("o/r", 1)).edits, [
    { id: null, editedAt: null, deletedAt: null, editor: null },
    { id: null, editedAt: null, deletedAt: null, editor: { type: null, login: null } },
  ])
  const limited = response({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }, { headers: { "x-ratelimit-reset": "1900000000" } })
  await assert.rejects((await connect(limited)).editPage("o/r", 1), (error) => error.code === "drains_rate_limited" && /GraphQL limit is used up/u.test(error.message))
  await assert.rejects((await connect(response({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } }))).editPage("o/r", 1), (error) => error.rateLimited === true)
})

test("the state keeps GraphQL's quota beside REST's", async () => {
  const w = await world([issue(1, T(0))])
  const graphqlQuota = { remaining: 4990, limit: 5000, reset: Math.floor(NOW / 1000) + 600, at: new Date(NOW).toISOString() }
  w.api.graphqlQuota = () => graphqlQuota
  await w.poll()
  matches(w.state(), { graphqlQuota })
  assert.equal(w.state().quota, undefined)
})

const DEAD = 999999
const ownerFiles = (lock) => readdirSync(lock).filter((name) => name.startsWith("owner-"))
const plant = (lock, pid, content = `${pid}\n`) => {
  mkdirSync(lock)
  const name = `owner-${randomUUID()}`
  writeFileSync(path.join(lock, name), content)
  return name
}
const liveExceptDead = (pid) => pid !== DEAD

test("the lock is published whole and never taken from a live owner, however long it has held it", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  const seen = []
  assert.equal(await withDrainLock(lock, () => {
    const [name] = ownerFiles(lock)
    assert.equal(Number.parseInt(readFileSync(path.join(lock, name), "utf8"), 10), process.pid)
    return "done"
  }, { onStep: (step) => seen.push([step, existsSync(lock)]) }), "done")
  assert.deepEqual(seen, [["staging", false], ["staged", false]], "the lock does not exist until it is complete")
  assert.deepEqual(readdirSync(dir), [], "release leaves neither the lock nor a staging directory")
  const name = plant(lock, process.pid)
  for (const minutes of [16, 60, 600]) {
    const old = new Date(Date.now() - minutes * 60_000)
    utimesSync(path.join(lock, name), old, old)
    utimesSync(lock, old, old)
    await assert.rejects(withDrainLock(lock, () => "never"), (error) => /desk_drains_busy/u.test(error.message) && /process \d+ holds .* and is still working/u.test(error.message) && !/remove|delete/u.test(error.message), `${minutes} minutes`)
    assert.deepEqual(ownerFiles(lock), [name])
  }
})

test("a run releases only its own owner file: a lock that has passed to a later owner is left alone", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const slow = withDrainLock(lock, () => gate)
  const [mine] = ownerFiles(lock)
  unlinkSync(path.join(lock, mine))
  rmdirSync(lock)
  const next = plant(lock, process.pid)
  release("done")
  assert.equal(await slow, "done")
  assert.deepEqual(ownerFiles(lock), [next])
})

test("a contender that stages its lock while another publishes first gets nothing and leaves the published lock whole", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  let other
  assert.throws(() => acquireDrainLock(lock, { onStep: (step) => { if (step === "staged") other ??= acquireDrainLock(lock) } }), /desk_drains_busy/u)
  assert.equal(ownerFiles(lock).length, 1, "the published lock is exactly the other contender's")
  assert.equal(readdirSync(dir).filter((name) => name.includes(".new-")).length, 0, "the loser removed its staging directory")
  other()
  assert.deepEqual(readdirSync(dir), [])
})

test("two contenders for a dead owner's lock cannot both take it: one that holds a stale view removes nothing of the winner's", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-drains-"))
  try {
    const lock = path.join(dir, "poll.lock")
    plant(lock, DEAD)
    let winner
    assert.throws(() => acquireDrainLock(lock, {
      alive: liveExceptDead,
      onStep: (step) => { if (step === "inspected") winner ??= acquireDrainLock(lock, { alive: liveExceptDead }) },
    }), /desk_drains_busy/u)
    assert.equal(ownerFiles(lock).length, 1, "the winner's lock is intact")
    assert.equal(Number.parseInt(readFileSync(path.join(lock, ownerFiles(lock)[0]), "utf8"), 10), process.pid)
    winner()
    assert.deepEqual(readdirSync(dir), [])
    // The same dead owner, found by two contenders that both finish their takeover in turn.
    plant(lock, DEAD)
    const first = acquireDrainLock(lock, { alive: liveExceptDead })
    assert.throws(() => acquireDrainLock(lock, { alive: liveExceptDead }), /desk_drains_busy/u)
    first()
    assert.deepEqual(readdirSync(dir), [])
  } finally {
    removeTreeSync(dir)
  }
})

test("what a crash leaves is recovered without a marker: an empty lock, and staging directories of dead processes (not of live ones)", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  mkdirSync(lock)
  const noOwnerYet = path.join(dir, `poll.lock.new-${DEAD}-${randomUUID()}`)
  mkdirSync(noOwnerYet)
  const emptyOwner = path.join(dir, `poll.lock.new-${DEAD}-${randomUUID()}`)
  mkdirSync(emptyOwner)
  writeFileSync(path.join(emptyOwner, `owner-${randomUUID()}`), "")
  const livesStill = path.join(dir, `poll.lock.new-${process.pid}-${randomUUID()}`)
  mkdirSync(livesStill)
  const stranger = path.join(dir, "poll.lock.new-notmine")
  mkdirSync(stranger)
  assert.equal(await withDrainLock(lock, () => "ran", { alive: liveExceptDead }), "ran")
  assert.deepEqual(readdirSync(dir).sort(), [path.basename(livesStill), "poll.lock.new-notmine"].sort())
})

test("a lock that Desk cannot vouch for fails closed with its own error and nothing is removed", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  const refuses = async (code, pattern) => {
    await assert.rejects(withDrainLock(lock, () => "never", { alive: liveExceptDead }), (error) => error.message.includes(code) && pattern.test(error.message) && !/process \d+ holds/u.test(error.message))
  }
  for (const pid of [process.pid, DEAD]) {
    writeFileSync(lock, `${pid}`)
    await refuses("desk_drains_lock_legacy", /cannot tell whether a poll still holds it/u)
    assert.equal(readFileSync(lock, "utf8"), `${pid}`, "a legacy lock file is never replaced")
    rmSync(lock)
  }
  writeFileSync(lock, "not a pid")
  await refuses("desk_drains_lock_legacy", /cannot tell/u)
  rmSync(lock)
  const name = plant(lock, process.pid, "not a pid")
  await refuses("desk_drains_lock_unrecognized", /does not name a process/u)
  writeFileSync(path.join(lock, "stranger"), "x")
  await refuses("desk_drains_lock_unrecognized", /stranger/u)
  rmSync(path.join(lock, "stranger"))
  writeFileSync(path.join(lock, `owner-${randomUUID()}`), `${DEAD}\n`)
  await refuses("desk_drains_lock_unrecognized", /owner-/u)
  assert.equal(ownerFiles(lock).length, 2)
  assert.equal(readFileSync(path.join(lock, name), "utf8"), "not a pid")
})

test("a lock that cannot be used for another reason than an owner names the error code instead of calling it busy", async () => {
  const dir = await mkTempRoot("desk-drains-")
  await assert.rejects(withDrainLock(path.join(dir, `${"x".repeat(400)}.lock`), () => "x"), (error) => /desk_drains_lock_unavailable/u.test(error.message) && (process.platform === "win32" ? /EINVAL|ENAMETOOLONG/u : /ENAMETOOLONG/u).test(error.message) && !/still working/u.test(error.message))
  if (process.platform === "win32" || process.getuid?.() === 0) return
  const locked = path.join(dir, "readonly")
  mkdirSync(locked)
  chmodSync(locked, 0o500)
  try {
    await assert.rejects(withDrainLock(path.join(locked, "poll.lock"), () => "x"), (error) => /desk_drains_lock_unavailable/u.test(error.message) && /EACCES/u.test(error.message) && !/still working/u.test(error.message))
  } finally {
    chmodSync(locked, 0o700)
  }
})

test("a platform that reports an occupied lock with another error code (Windows: EPERM) is judged by inspecting the lock, not by the code", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-drains-"))
  try {
    const lock = path.join(dir, "poll.lock")
    // Windows semantics: a rename onto any existing target fails with EPERM (or EEXIST), whatever it holds.
    const windows = (code) => (from, to) => {
      if (existsSync(to)) throw Object.assign(new Error(`${code}: rename`), { code })
      renameSync(from, to)
    }
    const options = (code) => ({ alive: liveExceptDead, rename: windows(code) })
    for (const code of ["EPERM", "EEXIST", "EACCES"]) {
      const live = plant(lock, process.pid)
      assert.throws(() => acquireDrainLock(lock, options(code)), (error) => /desk_drains_busy/u.test(error.message) && !/unavailable/u.test(error.message), `${code} live`)
      assert.deepEqual(ownerFiles(lock), [live])
      unlinkSync(path.join(lock, live))
      rmdirSync(lock)
      plant(lock, DEAD)
      acquireDrainLock(lock, options(code))()
      assert.deepEqual(readdirSync(dir), [], `${code} dead owner recovered`)
      mkdirSync(lock)
      acquireDrainLock(lock, options(code))()
      assert.deepEqual(readdirSync(dir), [], `${code} empty lock recovered`)
      writeFileSync(lock, `${DEAD}`)
      assert.throws(() => acquireDrainLock(lock, options(code)), /desk_drains_lock_legacy/u, `${code} file`)
      assert.equal(readFileSync(lock, "utf8"), `${DEAD}`)
      rmSync(lock)
      mkdirSync(lock)
      writeFileSync(path.join(lock, "stranger"), "x")
      assert.throws(() => acquireDrainLock(lock, options(code)), /desk_drains_lock_unrecognized/u, `${code} unknown`)
      removeTreeSync(lock)
      assert.equal(readdirSync(dir).length, 0, `${code} staging removed`)
    }
    // A real permission failure has nothing in the way, so it is named, not called busy.
    const denied = () => { throw Object.assign(new Error("EPERM: rename"), { code: "EPERM" }) }
    assert.throws(() => acquireDrainLock(lock, { rename: denied }), (error) => /desk_drains_lock_unavailable/u.test(error.message) && /EPERM/u.test(error.message) && !/still working/u.test(error.message))
    assert.deepEqual(readdirSync(dir), [], "its staging is removed")
  } finally {
    removeTreeSync(dir)
  }
})

const SHELLS = ["pwsh", "powershell"].filter((shell) => !spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", "exit 0"], { timeout: 30_000 }).error)
const TARGETS = {
  absent: () => {},
  file: (to) => writeFileSync(to, "OLD-FILE-LOCK"),
  "file held open": (to) => { writeFileSync(to, "OLD-FILE-LOCK"); return openSync(to, "r+") },
  "empty directory": (to) => mkdirSync(to),
  "nonempty directory": (to) => { mkdirSync(to); writeFileSync(path.join(to, "owner-old"), "old") },
}
const readback = (target) => {
  try {
    return statSync(target).isDirectory() ? `dir[${readdirSync(target).join(",")}]` : `file[${readFileSync(target, "utf8")}]`
  } catch (error) {
    return `absent(${error.code})`
  }
}

for (const shell of SHELLS) {
  for (const [name, make] of Object.entries(TARGETS)) {
    test(`${shell} moves a prepared directory onto ${name} without replacing what is there`, async () => {
      const dir = await mkTempRoot("desk-drains-")
      const from = path.join(dir, "from")
      const to = path.join(dir, "poll.lock")
      mkdirSync(from)
      writeFileSync(path.join(from, "owner-new"), "new")
      const handle = make(to)
      const before = readback(to)
      try {
        if (name === "absent") {
          moveWithoutReplace(from, to, { shells: [shell] })
          assert.equal(readback(to), "dir[owner-new]")
          assert.equal(readback(from), "absent(ENOENT)")
        } else {
          assert.throws(() => moveWithoutReplace(from, to, { shells: [shell] }), (error) => error.code === "desk_move_refused" && /refused \w+ -?\d+ (inner \w+ -?\d+|no-inner)/u.test(error.message))
          assert.equal(readback(to), before, "the target is exactly as it was")
          assert.equal(readback(from), "dir[owner-new]", "the prepared directory is untouched")
        }
      } finally {
        if (handle !== undefined) closeSync(handle)
      }
    })
  }
}

test("the lock is retired from an empty directory and published, and a legacy file that appears just before publication is refused, through a real no-replace move", { skip: SHELLS.length === 0 && "no PowerShell here" }, async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  const move = (from, to) => moveWithoutReplace(from, to, { shells: SHELLS })
  mkdirSync(lock)
  acquireDrainLock(lock, { rename: move })()
  assert.deepEqual(readdirSync(dir), [], "an empty lock was removed, then the retry published and released")
  assert.throws(() => acquireDrainLock(lock, { rename: (from, to) => { writeFileSync(to, "OLD-FILE-LOCK"); move(from, to) } }), /desk_drains_lock_legacy/u)
  assert.equal(readFileSync(lock, "utf8"), "OLD-FILE-LOCK", "the earlier Desk's file is untouched")
  assert.deepEqual(readdirSync(dir), ["poll.lock"], "our staging was removed")
})

test("only a shell that cannot be launched hands over to the next, and a move that ran is never repeated or replaced by rename", { skip: SHELLS.length === 0 && "no PowerShell here" }, async () => {
  const dir = await mkTempRoot("desk-drains-")
  const from = path.join(dir, "from")
  mkdirSync(from)
  writeFileSync(path.join(from, "owner-new"), "new")
  const to = path.join(dir, "poll.lock")
  assert.throws(() => moveWithoutReplace(from, to, { shells: ["desk-no-such-shell"] }), { code: "desk_move_no_shell" })
  assert.throws(() => moveWithoutReplace(from, to, { shells: [SHELLS[0]], timeoutMs: 1 }), { code: "ETIMEDOUT" }, "a timeout is an error of its own")
  moveWithoutReplace(from, to, { shells: ["desk-no-such-shell", SHELLS[0]] })
  assert.equal(readback(to), "dir[owner-new]")
})

test("a publication that was cut short but happened is recognised as ours", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  const release = acquireDrainLock(lock, { rename: (from, to) => { renameSync(from, to); throw Object.assign(new Error("timed out after the move"), { code: "ETIMEDOUT" }) } })
  assert.equal(ownerFiles(lock).length, 1)
  release()
  assert.deepEqual(readdirSync(dir), [])
})

test("a cut-short publication whose target is not our own directory is never taken as ours", async () => {
  const timedOut = () => Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
  const foreign = await mkTempRoot("desk-drains-")
  const foreignLock = path.join(foreign, "poll.lock")
  const foreignOwner = path.join(foreignLock, "owner-11111111-1111-1111-1111-111111111111")
  assert.throws(() => acquireDrainLock(foreignLock, { rename: (from) => { removeTreeSync(from); mkdirSync(foreignLock); writeFileSync(foreignOwner, `${process.pid}\n`); throw timedOut() } }), /desk_drains_busy/u)
  assert.equal(readFileSync(foreignOwner, "utf8"), `${process.pid}\n`, "a live foreign owner is left untouched")
  assert.deepEqual(readdirSync(foreignLock), ["owner-11111111-1111-1111-1111-111111111111"])

  const legacy = await mkTempRoot("desk-drains-")
  const legacyLock = path.join(legacy, "poll.lock")
  assert.throws(() => acquireDrainLock(legacyLock, { rename: (from) => { removeTreeSync(from); writeFileSync(legacyLock, `${process.pid}\n`); throw timedOut() } }), /desk_drains_lock_legacy/u)
  assert.equal(readFileSync(legacyLock, "utf8"), `${process.pid}\n`, "a legacy file is left untouched")
})

test("the file system does what the lock relies on, and an earlier Desk's file-only operations fail closed on the directory", { skip: process.platform === "win32" && "the lock's behaviour on Windows is not verified" }, async () => {
  const dir = await mkTempRoot("desk-drains-")
  const made = (name, file = "x") => { mkdirSync(path.join(dir, name)); writeFileSync(path.join(dir, name, "f"), file); return path.join(dir, name) }
  const full = made("full")
  assert.throws(() => renameSync(made("staged"), full), { code: "ENOTEMPTY" }, "a staged lock cannot replace a lock that has an owner")
  mkdirSync(path.join(dir, "empty"))
  renameSync(path.join(dir, "staged"), path.join(dir, "empty"))
  writeFileSync(path.join(dir, "legacy"), "1")
  assert.throws(() => renameSync(made("staged2"), path.join(dir, "legacy")), { code: "ENOTDIR" })
  assert.throws(() => closeSync(openSync(full, "wx")), { code: "EEXIST" }, "an earlier Desk cannot create its lock over the directory")
  assert.throws(() => readFileSync(full, "utf8"), { code: "EISDIR" })
  assert.throws(() => rmSync(full, { force: true }), { code: "ERR_FS_EISDIR" }, "nor remove it")
  assert.throws(() => unlinkSync(full), (error) => ["EISDIR", "EPERM"].includes(error.code))
})

test("two consecutive crashes of lock-owning processes, in each place, are recovered by the next poll", async () => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  const module = new URL("../../../../../plugins/desk/mcp/src/runtime/drains.js", import.meta.url).href
  const child = `import { writeSync } from "node:fs"
    import { acquireDrainLock } from ${JSON.stringify(module)}
    const at = process.env.CRASH_AT
    const kill = (step) => { writeSync(1, "reached " + step); process.kill(process.pid, "SIGKILL") }
    acquireDrainLock(process.env.LOCK, { onStep: (step) => { if (step === at) kill(step) } })
    kill("held")`
  for (const cycle of [1, 2]) {
    for (const at of ["held", "staging", "staged"]) {
      const crashed = spawnSync(process.execPath, ["--input-type=module", "-e", child], { env: { ...process.env, LOCK: lock, CRASH_AT: at } })
      assert.equal(String(crashed.stdout), `reached ${at}`, `cycle ${cycle} reached ${at} before the kill`)
      // Windows reports a killed process as a nonzero exit status with no signal name.
      assert.equal(crashed.error, undefined, `cycle ${cycle} ${at} spawned`)
      assert.equal(String(crashed.stderr), "", `cycle ${cycle} ${at} threw nothing before the kill`)
      assert.ok(crashed.signal === "SIGKILL" || (process.platform === "win32" && crashed.signal === null && crashed.status !== 0 && crashed.status !== null), `cycle ${cycle} ${at} was killed (signal ${crashed.signal}, status ${crashed.status})`)
      const left = readdirSync(dir)
      assert.equal(left.length, 1, `${at} left one entry`)
      assert.equal(left[0] === "poll.lock", at === "held", at)
      assert.equal(await withDrainLock(lock, () => ownerFiles(lock).length), 1, `cycle ${cycle} recovered from ${at}`)
      assert.deepEqual(readdirSync(dir), [], `cycle ${cycle} left nothing after ${at}`)
    }
  }
})

test("an unreadable or vanished part of the lock is named, not called busy, and nothing the lock holds is taken", async (t) => {
  if (process.platform === "win32" || process.getuid?.() === 0) return t.skip("needs POSIX permissions as an ordinary user")
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  const unavailable = (what) => (error) => /desk_drains_lock_unavailable/u.test(error.message) && /EACCES|ENOENT/u.test(error.message) && !/still working/u.test(error.message) && what !== ""
  assert.throws(() => acquireDrainLock(path.join(dir, "missing", "poll.lock")), unavailable("no parent directory"))
  const unreadable = plant(lock, DEAD)
  chmodSync(path.join(lock, unreadable), 0o000)
  try {
    assert.throws(() => acquireDrainLock(lock, { alive: liveExceptDead }), unavailable("owner file cannot be read"))
  } finally {
    chmodSync(path.join(lock, unreadable), 0o600)
  }
  const vanished = path.join(lock, unreadable)
  unlinkSync(vanished)
  symlinkSync(path.join(dir, "nowhere"), vanished)
  assert.throws(() => acquireDrainLock(lock, { alive: liveExceptDead }), /desk_drains_busy/u, "an owner that vanished while being read is left to whoever is removing it, and the lock is judged busy")
  unlinkSync(vanished)
  rmdirSync(lock)
  writeFileSync(lock, `${DEAD}`)
  chmodSync(lock, 0o000)
  try {
    assert.throws(() => acquireDrainLock(lock, { alive: liveExceptDead }), /desk_drains_lock_legacy/u)
  } finally {
    chmodSync(lock, 0o600)
  }
  rmSync(lock)
  const timedOut = () => Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })
  assert.throws(() => acquireDrainLock(lock, { rename: (from) => { removeTreeSync(from); mkdirSync(lock); chmodSync(lock, 0o000); throw timedOut() } }), unavailable("our own directory cannot be inspected"))
  chmodSync(lock, 0o700)
  rmdirSync(lock)
  let staging
  assert.throws(() => acquireDrainLock(lock, { rename: (from) => { staging = from; chmodSync(from, 0o000); throw timedOut() } }), unavailable("staging cannot be cleaned"))
  chmodSync(staging, 0o700)
  removeTreeSync(staging)
  assert.throws(() => acquireDrainLock(lock, { rename: () => { chmodSync(dir, 0o000); throw timedOut() } }), unavailable("staging cannot be looked at"))
  chmodSync(dir, 0o700)
  assert.equal(readdirSync(dir).length, 1, "the unreachable staging directory is left for the next run's sweep, which removes it once its process is gone")
  assert.doesNotThrow(() => acquireDrainLock(lock, { alive: () => false })())
  assert.deepEqual(readdirSync(dir), [])
  chmodSync(dir, 0o300)
  try {
    assert.throws(() => acquireDrainLock(lock), unavailable("the directory cannot be listed"))
  } finally {
    chmodSync(dir, 0o700)
  }
})

test("the lock's remaining failure paths name what failed: an error without a code, a stranger in staging, a leftover of process 0, a refusal with no message", async (t) => {
  const dir = await mkTempRoot("desk-drains-")
  const lock = path.join(dir, "poll.lock")
  assert.throws(() => acquireDrainLock(lock, { rename: () => { throw new Error("boom") } }), (error) => /desk_drains_lock_unavailable/u.test(error.message) && /boom/u.test(error.message) && /error code unknown/u.test(error.message))
  let staging
  assert.throws(() => acquireDrainLock(lock, { rename: (from) => { staging = from; writeFileSync(path.join(from, "stranger"), "x"); throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }) } }), /desk_drains_lock_unavailable/u)
  assert.deepEqual(readdirSync(staging), ["stranger"], "a file that is not this run's owner file is not removed")
  removeTreeSync(staging)
  const orphan = path.join(dir, `poll.lock.new-0-${randomUUID()}`)
  mkdirSync(orphan)
  acquireDrainLock(lock)()
  assert.deepEqual(readdirSync(dir), [], "a staging directory of process 0 is a leftover, never a live process")
  if (process.platform === "win32") return
  const from = path.join(dir, "from")
  mkdirSync(from)
  assert.throws(() => moveWithoutReplace(from, path.join(dir, "to"), { shells: ["false"] }), (error) => error.code === "desk_move_refused" && /exit 1\): no message/u.test(error.message), "a refusal that says nothing is still reported")
  assert.equal(existsSync(from), true)
  if (process.getuid?.() === 0) return t.skip("needs POSIX permissions as an ordinary user")
  const locked = (setup, act, what) => {
    const sub = mkdtempSync(path.join(dir, "case-"))
    const target = path.join(sub, "poll.lock")
    const finish = setup(sub, target)
    try {
      assert.throws(() => act(target, sub), (error) => /desk_drains_lock_unavailable/u.test(error.message) && /EACCES/u.test(error.message) && !/still working/u.test(error.message), what)
    } finally {
      chmodSync(sub, 0o700)
      if (existsSync(target)) chmodSync(target, 0o700)
    }
    return finish
  }
  locked((sub, target) => { plant(target, DEAD); chmodSync(target, 0o500) }, (target) => acquireDrainLock(target, { alive: liveExceptDead }), "a dead owner's file that cannot be removed")
  locked((sub, target) => { mkdirSync(target); writeFileSync(path.join(target, "a"), "x"); chmodSync(target, 0o000) }, (target) => acquireDrainLock(target), "a lock directory that cannot be read")
  locked((sub, target) => mkdirSync(target), (target, sub) => acquireDrainLock(target, { rename: (staged) => { removeTreeSync(staged); chmodSync(sub, 0o500); throw Object.assign(new Error("not empty"), { code: "ENOTEMPTY" }) } }), "an empty lock that cannot be removed")
  const sub = mkdtempSync(path.join(dir, "case-"))
  const release = acquireDrainLock(path.join(sub, "poll.lock"))
  chmodSync(path.join(sub, "poll.lock"), 0o500)
  try {
    assert.throws(release, (error) => /desk_drains_lock_unavailable/u.test(error.message) && /EACCES/u.test(error.message))
  } finally {
    chmodSync(path.join(sub, "poll.lock"), 0o700)
  }
  release()
})

test("edit histories that are unusable, behind, unexplained or already at a baseline's second are judged conservatively, and a failing issue holds the cursor back", async () => {
  const BASE = iso(NOW + 60_000)
  const based = async (issues = [ISSUE()], options, baseline = true) => {
    const w = await editsWorld(issues, options)
    for (const item of issues) w.hist[item.number] = history(3)
    await w.poll()
    if (baseline) {
      w.change(1, NOW + 60_000, botEdit("n0", BASE))
      await w.poll(NOW + 60_000)
    }
    return w
  }
  const pages = (w, answer) => { w.hist[1] = { count: 0, extra: [], total: 5, page: answer } }
  const old = (index) => botEdit(`o${index}`, iso(LONG_AGO + index * 1000))
  const n0 = botEdit("n0", BASE)
  const outcome = async (name, setup, wakes) => {
    const w = await based()
    w.change(1, NOW + 360_000, null)
    setup(w)
    const out = await w.poll(NOW + 360_000)
    assert.equal(out.wakes.length, wakes, name)
    return w
  }
  await outcome("a new bot edit in the baseline's own second", (w) => pages(w, () => ({ nodes: [old(0), old(1), old(2), n0, botEdit("x", BASE)], hasMore: false, cursor: "c" })), 0)
  await outcome("more new edits than the count allows", (w) => pages(w, () => ({ nodes: [old(0), botEdit("x", iso(NOW + 120_000)), botEdit("y", iso(NOW + 120_000))], hasMore: true, cursor: "c" })), 1)
  await outcome("a count that cannot be explained", (w) => pages(w, () => ({ nodes: [old(0), old(1), old(2), n0], hasMore: false, cursor: "c" })), 1)
  await outcome("an unreadable page", (w) => pages(w, () => ({ nodes: null, hasMore: true, cursor: "c" })), 1)
  await outcome("an edit that is not an object", (w) => pages(w, () => ({ nodes: [null], hasMore: true, cursor: "c" })), 1)
  let call = 0
  await outcome("edits that arrive while the history is read, which nothing explains", (w) => {
    pages(w, function () {
      call += 1
      this.total = call === 1 ? 5 : 6
      return { nodes: call === 1 ? [old(0)] : call === 2 ? [n0] : [old(0)], hasMore: call === 1, cursor: "c" }
    })
  }, 1)
  const lagging = await based()
  lagging.change(1, NOW + 360_000, botEdit("n", iso(NOW + 360_000)))
  lagging.hist[1].stamp = T(0)
  await lagging.poll(NOW + 360_000)
  assert.equal((await lagging.poll(NOW + 720_000)).errors.length, 1, "still behind: read again next poll")
  lagging.hist[1].stamp = undefined
  lagging.hist[1].page = () => ({ nodes: null, hasMore: true, cursor: "c" })
  assert.equal((await lagging.poll(NOW + 1_080_000)).wakes.length, 1, "an unreadable page after the lag is news")
  const limited = await outcome("a quota error from the page", (w) => { w.hist[1] = Object.assign(new Error("Wait for the quota to reset: used up"), { code: "drains_rate_limited" }) }, 0)
  assert.equal(limited.state().lastErrorCode, "drains_rate_limited")
  const bare = await based([ISSUE()], { limit: 25 }, false)
  bare.change(1, NOW + 360_000, botEdit("n", iso(NOW + 360_000)))
  delete bare.api.graphqlQuota
  delete bare.api.graphqlCost
  const held = await bare.poll(NOW + 360_000)
  assert.match(held.errors[0].error, /quota/u, "a connection that reports no quota is held by the last reading")
  const gone = await based([issue(1, T(0), "A", "health: 0"), issue(2, T(0), "B")], { limit: 26 }, false)
  gone.hist[1] = history(500_100)
  gone.change(1, NOW + 360_000, botEdit("n", iso(NOW + 360_000)))
  await gone.poll(NOW + 360_000)
  assert.ok(gone.state().scans[1])
  gone.issues.splice(0, 1)
  gone.change(2, NOW + 720_000, personEdit("p", iso(NOW + 720_000)))
  await gone.poll(NOW + 720_000)
  assert.equal(gone.state().scans[1], undefined, "a scan for an issue that is no longer changed is dropped")
  const many = await based([1, 2, 3, 4, 5].map((n) => issue(n, T(0), `I${n}`, "health: 0")), undefined, false)
  for (const n of [1, 2, 3, 4, 5]) {
    many.hist[n] = Object.assign(new Error("Check gh auth status, then try again: HTTP 502"), { code: "drains_check_gh_auth_status_then" })
    many.issues[n - 1] = { ...many.issues[n - 1], updated_at: iso(NOW + n * 60_000), body: `changed ${n}` }
  }
  many.issues.push(issue(9, iso(NOW + 600_000)))
  const out = await many.poll(NOW + 600_000)
  assert.match(out.errors[0].error, /5 issue\(s\) were left for it: .*\), …/u)
  assert.equal(many.state().cursor, iso(NOW + 60_000), "the cursor stays at the earliest failure, though a later issue was read")
})

test("a GitHub 5xx is asked once more and, if it persists, worded as the server's fault with no auth advice; a 401 is not retried and still says to check auth", async () => {
  const connect = (answers) => {
    const asked = []
    const fetchImpl = async (url) => { asked.push(url); return answers.shift() ?? response({}, { status: 599 }) }
    return connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl, login: "maintainer" }).then((api) => ({ api, asked }))
  }
  for (const status of [500, 502, 503, 504]) {
    const { api, asked } = await connect([response({}, { status }), response({}, { status })])
    await assert.rejects(api.openIssues("o/r"), (error) => error.code === "drains_github_server_error" && error.status === status && new RegExp(`server answered HTTP ${status} for /repos/o/r/issues`, "u").test(error.message) && !/gh auth/u.test(error.message))
    assert.equal(asked.length, 2, `${status}: exactly one retry`)
    assert.equal(api.calls().total, 2)
  }
  const recovers = await connect([response({}, { status: 502 }), response([])])
  assert.deepEqual(await recovers.api.openIssues("o/r"), [])
  assert.equal(recovers.asked.length, 2)
  const refused = await connect([response({}, { status: 401 })])
  await assert.rejects(refused.api.openIssues("o/r"), (error) => error.code === "drains_check_gh_auth_status_then" && /Check gh auth status/u.test(error.message))
  assert.equal(refused.asked.length, 1, "a refused credential is not retried")
  const graph = await connect([response({}, { status: 503 }), response({}, { status: 503 })])
  await assert.rejects(graph.api.editPage("o/r", 1), (error) => error.code === "drains_github_server_error" && /for \/graphql/u.test(error.message))
  assert.equal(graph.asked.length, 2)
  const bad = await connect([response({}, { status: 401 })])
  await assert.rejects(bad.api.editPage("o/r", 1), (error) => error.code === "drains_check_gh_auth_status_then")
  assert.equal(bad.asked.length, 1)
})

test("a persistent 5xx is recorded as the drain's last error, wakes nobody and leaves what was seen as it was", async () => {
  const w = await world([issue(1, T(0))])
  await w.poll()
  const before = JSON.stringify(w.state().seen)
  w.api.changedIssues = async () => { throw Object.assign(new Error("Wait for the next poll: GitHub's server answered HTTP 502 for /repos/acme/widgets/issues (asked twice); this usually clears on its own and needs nothing from you"), { code: "drains_github_server_error", status: 502 }) }
  const out = await w.poll(NOW + 360_000)
  assert.deepEqual(out.wakes, [])
  assert.equal(out.errors[0].code, "drains_github_server_error")
  assert.match(out.errors[0].error, /server answered HTTP 502/u)
  assert.equal(w.state().lastErrorCode, "drains_github_server_error")
  assert.equal(JSON.stringify(w.state().seen), before)
})

test("only a 401 is worded as a credential problem; other refusals and an unreadable GraphQL answer are not, and none is retried", async () => {
  const connect = (answers) => {
    const asked = []
    const fetchImpl = async (url) => { asked.push(url); return answers.shift() ?? response({}, { status: 599 }) }
    return connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl, login: "maintainer" }).then((api) => ({ api, asked }))
  }
  for (const status of [403, 404, 422]) {
    const { api, asked } = await connect([response({}, { status }), response([])])
    await assert.rejects(api.openIssues("o/r"), (error) => error.code === "drains_github_refused" && error.status === status && !/gh auth/u.test(error.message))
    assert.equal(asked.length, 1, `${status} is not retried`)
  }
  const graph = await connect([response({ errors: [{ message: "Field 'x' doesn't exist" }] })])
  await assert.rejects(graph.api.editPage("o/r", 1), (error) => error.code === "drains_graphql_failed" && !/gh auth/u.test(error.message) && /Field 'x'/u.test(error.message))
  const forbidden = await connect([response({}, { status: 403 })])
  await assert.rejects(forbidden.api.editPage("o/r", 1), (error) => error.code === "drains_github_refused" && !/gh auth/u.test(error.message))
  assert.equal(forbidden.asked.length, 1)
  const unauthorized = await connect([response({}, { status: 401 })])
  await assert.rejects(unauthorized.api.openIssues("o/r"), (error) => error.code === "drains_check_gh_auth_status_then" && /token was refused/u.test(error.message))
})

// ── Bounded history reads (#1798): a fake GitHub over HTTP that serves oldest-first pages and counts the real requests ──

function historyGithub({ histories, issues }) {
  const log = []
  const failures = new Set()
  const page = (list, url) => {
    const number = Number(new URL(url).searchParams.get("page"))
    const last = Math.max(1, Math.ceil(list.length / 100))
    const link = [number < last ? `<https://api.github.com/x?page=${number + 1}>; rel="next"` : null, last > 1 ? `<https://api.github.com/x?per_page=100&page=${last}>; rel="last"` : null].filter(Boolean).join(", ")
    return response(list.slice((number - 1) * 100, number * 100), { link: link || null })
  }
  const fetchImpl = async (url) => {
    const { pathname, searchParams } = new URL(url)
    if (pathname === "/graphql") return response({ data: {} })
    log.push(`${pathname}?page=${searchParams.get("page")}`)
    const [, , , , , number, kind] = pathname.split("/")
    if (failures.has(`${kind}:${searchParams.get("page")}`)) return response({}, { status: 502 })
    if (pathname === "/repos/o/r/issues") {
      const since = searchParams.get("since")
      return response(issues().filter((item) => searchParams.get("state") === "all" ? !since || item.updated_at >= since : item.state === "open"))
    }
    if (kind === "comments") return page(histories[number].comments.filter((item) => item.updated_at >= (searchParams.get("since") ?? "")), url)
    return page(histories[number][kind], url)
  }
  const history = () => log.filter((line) => /\/issues\/\d+\/(events|timeline|comments)/u.test(line))
  return { fetchImpl, log, history, failures }
}

const linked = (created_at, number, repo = "other/repo") => ({ event: "cross-referenced", created_at, source: { issue: { number, repository_url: `https://api.github.com/repos/${repo}` } } })

test("history reads follow what is new, not how long the issue's history is, and a failed read keeps its wake pending", async () => {
  const at = (index) => new Date(Date.parse("2026-11-01T00:00:00Z") + index * 60_000).toISOString().replace(".000", "")
  const noise = (count) => Array.from({ length: count }, (_, index) => ({ id: index, event: "milestoned", created_at: at(index) }))
  const long = { comments: [], events: noise(450), timeline: noise(450) }
  const state = { open: [{ number: 7, title: "Long", body: "b", state: "open", updated_at: at(500) }], closed: { number: 9, title: "Done", body: "b", state: "closed", updated_at: at(500) } }
  const world = historyGithub({ histories: { 3: { comments: [] }, 7: long, 9: { comments: [], events: noise(450), timeline: noise(450) } }, issues: () => [...state.open, ...(state.closed ? [state.closed] : [])] })
  const connect = (account, { login }) => connectGithub(account, { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: world.fetchImpl, env: { PATH: "/bin" }, login })
  const states = {}
  const drain = { repo: "o/r", account: "maintainer", session: "s" }
  const poll = async (minutes) => {
    world.log.length = 0
    await pollDrain(drain, states, { connect, now: NOW + minutes * 60_000 })
    return states["o/r"]
  }
  await poll(0)
  assert.equal(states["o/r"].seeded, true)

  // The issue is closed afterwards and keeps changing: its history is never read.
  state.closed = { ...state.closed, updated_at: at(510) }
  await poll(1)
  assert.deepEqual(world.history(), [], "a closed issue's history is not read")

  // A change with nothing news in it: the newest page of the events and of the timeline is read, not all five of each.
  const since = at(500)
  long.events.push({ id: 900, event: "milestoned", created_at: at(520) })
  long.timeline.push(...[{ event: "commented", created_at: at(520) }, linked(at(521), 3)])
  state.open = [{ ...state.open[0], updated_at: at(521) }]
  world.failures.add("timeline:5")
  const failed = await poll(2)
  const failedReads = world.history()
  assert.ok(failedReads.every((line) => /page=[15]$/u.test(line)) && failedReads.some((line) => line.includes("/timeline?page=5")), `reads stay at the ends of the lists: ${failedReads}`)
  assert.equal(failed.seen[7].updatedAt, since, "the marker stays where it was, so the same change is judged again")
  assert.match(failed.lastError, /left for it/u)
  assert.equal(failed.pending.length, 0, "a read that failed is not a quiet success")

  world.failures.clear()
  const recovered = await poll(3)
  assert.equal(world.log.some((line) => line.includes("/repos/other/repo/issues/3/comments") && !line.endsWith("page=1")), false)
  const reads = world.history()
  assert.deepEqual(reads, ["comments?page=1", "events?page=1", "events?page=5", "timeline?page=1", "timeline?page=5"].map((tail) => `/repos/o/r/issues/7/${tail}`).concat(["/repos/o/r/issues/7/comments?page=1", "/repos/other/repo/issues/3/comments?page=1"]), "the first and last page of each list, never the pages between, then one page of comments to tell whose cross-reference it is")
  assert.equal(recovered.pending.length, 1)
  assert.match(recovered.pending[0].why, /cross-reference from other\/repo#3/u)
  assert.equal(recovered.seen[7].updatedAt, at(521))
  assert.equal(recovered.lastError, undefined)
})

test("recent reads stop at the first page that reaches back far enough, and read whole a list whose end GitHub does not name", async () => {
  const urls = []
  const stamped = Array.from({ length: 250 }, (_, index) => ({ id: index, created_at: new Date(Date.parse("2026-11-01T00:00:00Z") + index * 60_000).toISOString() }))
  const serve = (named) => async (url) => {
    urls.push(url)
    const number = Number(new URL(url).searchParams.get("page"))
    const link = [number < 3 ? `<https://api.github.com/x?page=${number + 1}>; rel="next"` : null, named ? '<https://api.github.com/x?per_page=100&page=3>; rel="last"' : null].filter(Boolean).join(", ")
    return response(stamped.slice((number - 1) * 100, number * 100), { link: link || null })
  }
  const connect = (named) => connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: serve(named), env: { PATH: "/bin" }, login: "maintainer" })
  const since = stamped[150].created_at
  const named = await connect(true)
  assert.equal((await named.issueEvents("o/r", 5, since)).length, 150, "pages 2 and 3 reach back to the time; page 1 is not read again")
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "3", "2"])
  urls.length = 0
  const unnamed = await connect(false)
  assert.equal((await unnamed.timeline("o/r", 5, since)).length, 250)
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "1", "2", "3"], "no `last` link: the whole list, as before")
  urls.length = 0
  assert.equal((await named.comments("o/r", 5, "1970-01-01T00:00:00Z", (page) => page.some((item) => item.id === 150))).length, 150)
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "3", "2"], "a bot comment's previous one is found without reading the oldest pages")
  urls.length = 0
  assert.equal((await named.issueEvents("o/r", 5, "1970-01-01T00:00:00Z")).length, 250, "a time older than the whole list reads all of it, page 1 from the first answer")
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "3", "2"])
})

test("a reopen by the drain's own claim is still recognised when the claim sits on the page before the last one read", async () => {
  const at = (index) => new Date(Date.parse("2026-11-01T00:00:00Z") + index * 1000).toISOString().replace(".000", "")
  const events = Array.from({ length: 201 }, (_, index) => ({ id: index, event: "milestoned", created_at: at(index) }))
  // Page 2 ends with the drain's claim; page 3 starts with an old event (the revision's second), so the last page alone reaches back to the revision.
  events[199] = { id: 199, event: "labeled", label: { name: "drain:claimed" }, actor: { login: "maintainer" }, created_at: at(199) }
  events.push({ id: 500, event: "reopened", actor: { login: "maintainer" }, created_at: at(230) })
  const world = historyGithub({ histories: { 7: { comments: [], events, timeline: [] } }, issues: () => [{ number: 7, title: "T", body: "b", state: "open", updated_at: at(231) }] })
  const connect = (account, { login }) => connectGithub(account, { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: world.fetchImpl, env: { PATH: "/bin" }, login })
  const states = { "o/r": { seeded: true, seen: { 7: { updatedAt: at(200), digest: createHash("sha1").update("T\nb").digest("hex").slice(0, 16), title: "T" } }, pending: [], turns: [] } }
  await pollDrain({ repo: "o/r", account: "maintainer", session: "s" }, states, { connect, now: Date.parse(at(240)) })
  assert.equal(states["o/r"].lastError, undefined)
  assert.deepEqual(states["o/r"].pending, [], "the claim one minute before the reopen is found on page 2, so the reopen is the drain's own")
  assert.ok(world.history().some((line) => line.endsWith("events?page=2")))
})

test("recent follows the link on the last page it was told of, so an item added to a new page after the first answer is still read", async () => {
  const urls = []
  const stamped = Array.from({ length: 350 }, (_, index) => ({ id: index, created_at: new Date(Date.parse("2026-11-01T00:00:00Z") + index * 60_000).toISOString() }))
  const fetchImpl = async (url) => {
    urls.push(url)
    const number = Number(new URL(url).searchParams.get("page"))
    // The first answer names page 3 as the last; by the time page 3 is read, page 4 exists.
    const link = [number < 4 ? `<https://api.github.com/x?page=${number + 1}>; rel="next"` : null, `<https://api.github.com/x?per_page=100&page=${number === 1 ? 3 : 4}>; rel="last"`].filter(Boolean).join(", ")
    return response(stamped.slice((number - 1) * 100, number * 100), { link })
  }
  const api = connectGithub("maintainer", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl, env: { PATH: "/bin" }, login: "maintainer" })
  const items = await (await api).timeline("o/r", 5, stamped[250].created_at)
  assert.ok(items.some((item) => item.id === 349), "the reference on page 4 is read")
  assert.deepEqual(urls.map((url) => new URL(url).searchParams.get("page")), ["1", "3", "4"], "page 3 reaches back far enough, so page 2 is not read")
})

test("a cross-reference is attributed from the end of a long comment history, and an unreadable comment page never hides it", async () => {
  const at = (index) => new Date(Date.parse("2026-11-01T00:00:00Z") + index * 1000).toISOString().replace(".000", "")
  const comments = Array.from({ length: 150 }, (_, index) => ({ id: index, user: { login: "someone" }, body: "hi", created_at: at(index), updated_at: at(index) }))
  comments[120] = { ...comments[120], user: { login: "maintainer" }, body: "<!-- ouro-drain-status --> working on #99" }
  const world = historyGithub({ histories: { 3: { comments: [] }, 7: { comments, events: [], timeline: [linked(at(300), 3)] } }, issues: () => [{ number: 7, title: "T", body: "b", state: "open", updated_at: at(301) }] })
  const connect = (account, { login }) => connectGithub(account, { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: world.fetchImpl, env: { PATH: "/bin" }, login })
  const run = async () => {
    world.log.length = 0
    const states = { "o/r": { seeded: true, seen: { 7: { updatedAt: at(200), digest: createHash("sha1").update("T\nb").digest("hex").slice(0, 16), title: "T" } }, pending: [], turns: [] } }
    await pollDrain({ repo: "o/r", account: "maintainer", session: "s" }, states, { connect, now: Date.parse(at(310)) })
    return states["o/r"]
  }
  const read = await run()
  assert.match(read.pending[0]?.why ?? "", /cross-reference from other\/repo#3/u)
  assert.ok(world.history().includes("/repos/o/r/issues/7/comments?page=2"), "the own-comment lookup starts at the last page")
  world.failures.add("comments:2")
  const failed = await run()
  assert.match(failed.pending[0]?.why ?? "", /cross-reference from other\/repo#3/u, "a comment page that cannot be read is not evidence the drain caused the reference")
})

test("a bot comment that repeats the bot's previous one is noise, found by reading the comment history from its end", async () => {
  const at = (index) => new Date(Date.parse("2026-11-01T00:00:00Z") + index * 1000).toISOString().replace(".000", "")
  const comments = Array.from({ length: 150 }, (_, index) => ({ id: index, user: { login: "ci[bot]", type: "Bot" }, body: "build passed", created_at: at(index), updated_at: at(index) }))
  const world = historyGithub({ histories: { 7: { comments, events: [], timeline: [] } }, issues: () => [{ number: 7, title: "T", body: "b", state: "open", updated_at: at(251) }] })
  const connect = (account, { login }) => connectGithub(account, { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: world.fetchImpl, env: { PATH: "/bin" }, login })
  const states = { "o/r": { seeded: true, seen: { 7: { updatedAt: at(125), digest: createHash("sha1").update("T\nb").digest("hex").slice(0, 16), title: "T" } }, pending: [], turns: [] } }
  await pollDrain({ repo: "o/r", account: "maintainer", session: "s" }, states, { connect, now: Date.parse(at(260)) })
  assert.equal(states["o/r"].lastError, undefined)
  assert.deepEqual(states["o/r"].pending, [])
  const commentReads = world.history().filter((line) => line.includes("/issues/7/comments"))
  assert.ok(commentReads.length <= 3, `the 24 repeated bot comments share one bounded lookup, not one each: ${commentReads.length} comment requests`)
})

test("repeated bot comments from two authors each find their own previous comment, reading further back when the shared tail lacks it", async () => {
  const at = (index) => new Date(Date.parse("2026-11-01T00:00:00Z") + index * 1000).toISOString().replace(".000", "")
  const run = async (newBody) => {
    const comments = Array.from({ length: 150 }, (_, index) => ({ id: index, user: { login: "ci[bot]", type: "Bot" }, body: "build passed", created_at: at(index), updated_at: at(index) }))
    // ci-two's only earlier comment (99) is on page 1, which the page-2 tail read does not reach; its new comment is the last one.
    comments[99] = { ...comments[99], user: { login: "ci-two[bot]", type: "Bot" }, body: "other" }
    comments[149] = { ...comments[149], user: { login: "ci-two[bot]", type: "Bot" }, body: newBody }
    const world = historyGithub({ histories: { 7: { comments, events: [], timeline: [] } }, issues: () => [{ number: 7, title: "T", body: "b", state: "open", updated_at: at(251) }] })
    const connect = (account, { login }) => connectGithub(account, { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: world.fetchImpl, env: { PATH: "/bin" }, login })
    const states = { "o/r": { seeded: true, seen: { 7: { updatedAt: at(125), digest: createHash("sha1").update("T\nb").digest("hex").slice(0, 16), title: "T" } }, pending: [], turns: [] } }
    await pollDrain({ repo: "o/r", account: "maintainer", session: "s" }, states, { connect, now: Date.parse(at(260)) })
    return { pending: states["o/r"].pending }
  }
  const quiet = await run("other")
  assert.deepEqual(quiet.pending, [], "repeating its own previous text is quiet, found on the older page")
  const wakes = await run("build passed")
  assert.match(wakes.pending[0]?.why ?? "", /comment 149 by ci-two\[bot\]/u, "it matches the other author's previous text, not its own")
})

test("a person's body edit leaves a baseline, so the next body change on a long history reads a page or two, not the whole history again (#1798)", async () => {
  const w = await editsWorld([ISSUE()])
  w.hist[1] = history(30_000, { order: "asc" })
  await w.poll()
  const reads = []
  const step = async (k, edit) => {
    const at = NOW + k * 360_000
    const before = w.reads.length
    w.change(1, at, edit)
    const { wakes } = await w.poll(at)
    reads.push(w.reads.length - before)
    return wakes.length
  }
  assert.deepEqual([
    await step(1, personEdit("h1", iso(NOW + 360_000))),
    await step(2, botEdit("b2", iso(NOW + 720_000))),
    await step(3, personEdit("h3", iso(NOW + 1_080_000))),
    await step(4, botEdit("b4", iso(NOW + 1_440_000))),
  ], [1, 0, 1, 0])
  assert.ok(reads.slice(1).every((count) => count <= 4), `later changes read a few pages, got ${reads}`)
  assert.equal(w.state().seen[1].edits.total, 30_004)
})

test("a newest-first history is cheap without a baseline, and still wakes for what a person edited before (#1798)", async () => {
  const w = await editsWorld([ISSUE()])
  w.hist[1] = history(30_000, { order: "desc" })
  await w.poll()
  w.change(1, NOW + 360_000, personEdit("h1", iso(NOW + 360_000)))
  assert.equal((await w.poll(NOW + 360_000)).wakes.length, 1)
  const before = w.reads.length
  w.change(1, NOW + 720_000, botEdit("b2", iso(NOW + 720_000)))
  await w.poll(NOW + 720_000)
  assert.ok(w.reads.length - before <= 4)
})

test("a person's edit found early leaves no baseline that hides one that was not read (#1798)", async () => {
  const w = await editsWorld([ISSUE()])
  const h = history(250, { order: "asc" })
  const old = h.at.bind(h)
  // The first page reaches h1, the issue's own edit; a later person's edit h2 sits unread on a middle page.
  h.at = (index) => (index === 0 ? personEdit("h1", iso(NOW + 360_000)) : index === 150 ? personEdit("h2", iso(NOW + 400_000)) : old(index))
  w.hist[1] = h
  await w.poll()
  w.change(1, NOW + 360_000, personEdit("h1", iso(NOW + 360_000)))
  assert.equal((await w.poll(NOW + 360_000)).wakes.length, 1)
  const baseline = w.state().seen[1].edits
  h.extra.push(botEdit("b4", iso(NOW + 720_000)))
  w.change(1, NOW + 720_000, null)
  // The missed news comes first: a baseline that hides h2 lets the later bot edit pass as quiet.
  assert.equal((await w.poll(NOW + 720_000)).wakes.length, 1)
  assert.equal(baseline, undefined)
})

test("a person's edit with no id or time is news and leaves no baseline (#1798)", async () => {
  const w = await editsWorld([ISSUE()])
  w.hist[1] = history(3, { extra: [{ id: null, editedAt: iso(NOW + 360_000), deletedAt: null, editor: { type: "User", login: "ari" } }] })
  await w.poll()
  w.change(1, NOW + 360_000, null)
  assert.equal((await w.poll(NOW + 360_000)).wakes.length, 1)
  assert.equal(w.state().seen[1].edits, undefined)
})

test("connectGithub names the login and token together without holding the token, and a rate limit keeps what GitHub said about coming back", async () => {
  const spawn = () => ({ status: 0, stdout: "fake-token-x\n" })
  const limited = response({}, { status: 429, headers: { "retry-after": "90", "x-ratelimit-reset": "2000" } })
  const api = await connectGithub("a", { spawn, fetchImpl: async () => limited, login: "a", env: { PATH: "/bin", MS_DESK_QUOTA: "off" } })
  assert.equal(api.credentialEpoch, createHash("sha256").update("a\0fake-token-x").digest("hex"))
  assert.ok(!api.credentialEpoch.includes("fake-token-x"))
  await assert.rejects(api.get("/repos/o/r"), (error) => error.code === "drains_rate_limited" && error.retryAfterMs === 90_000 && error.resetAt === 2_000_000)
})
