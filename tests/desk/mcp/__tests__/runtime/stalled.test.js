// Stalled-card nudges: a session whose last turn ended with its focused task card unfinished and nothing running is nudged once per idle
// stretch. Every session history, desk and state file lives under a temporary root; the app's database is a seam.
import assert from "node:assert/strict"
import { mkdirSync, writeFileSync, appendFileSync, utimesSync } from "node:fs"
import { DatabaseSync } from "node:sqlite"
import path from "node:path"
import { test } from "node:test"
import { mkTempRoot } from "../_temp_roots.js"
import { ackStalled, assessSessions, pollStalled, readStalledConfig, stalledPaths, stalledStatus } from "../../../../../plugins/desk/mcp/src/runtime/stalled.js"
import { findFocus } from "../../../../../plugins/desk/mcp/src/runtime/session-activity.js"
import { NUDGE_PREFIX, cardBases, cardRestReason, findFocusedCard, namesHumanGate, staleCardLead } from "../../../../../plugins/desk/mcp/src/runtime/focused-card.js"
import { createStaleCardLead, withStaleCardLead } from "../../../../../plugins/desk/mcp/src/runtime/stale-card-lead.js"
import { createFocusHolder } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { runDrainsCli } from "../../../../../plugins/desk/mcp/src/runtime/drains-cli.js"

const SESSION = "11111111-aaaa-4bbb-8ccc-222222222222"
const MIN = 60_000
const T0 = Date.parse("2026-11-15T10:00:00Z")
const NOW = T0 + 60 * MIN

const iso = (ms) => new Date(ms).toISOString()
let counter = 0
// The key order of a real history line: data, then the subagent's own id when it has one, then id and timestamp.
const event = (type, data, at, agentId) => JSON.stringify({ type, data, ...(agentId === undefined ? {} : { agentId }), id: `e${(counter += 1)}`, timestamp: iso(at), parentId: "p" })
const call = (id, toolName, args, at) => event("tool.execution_start", { toolCallId: id, toolName, arguments: args }, at)
const done = (id, at, content = "ok", success = true) => event("tool.execution_complete", { toolCallId: id, success, result: { content } }, at)

/** A history that focuses a card and ends its turn at `endedAt`, plus the lines each test appends or inserts. */
function history({ endedAt = T0 + 10 * MIN, before = [], after = [], message = "Still working through the plan." } = {}) {
  return [
    event("session.start", {}, T0),
    event("user.message", { content: "go" }, T0 + MIN),
    event("assistant.turn_start", { turnId: "0" }, T0 + 2 * MIN),
    call("f1", "desk-task_focus", { track: "tooling", slug: "ship-it" }, T0 + 3 * MIN),
    done("f1", T0 + 3 * MIN),
    ...before,
    event("assistant.message", { content: message }, endedAt - 1000),
    event("assistant.turn_end", { turnId: "0" }, endedAt),
    ...after,
  ]
}

async function world({ lines = history(), card = { status: "processing" }, body = "## Outcome\n\nShip it.\n", database = null, drains = [], realDatabase = false } = {}) {
  const root = await mkTempRoot("desk-stalled-")
  const copilot = path.join(root, "copilot")
  const state = path.join(root, "state")
  const home = path.join(root, "home")
  const desk = path.join(home, "my-desk")
  const env = { COPILOT_HOME: copilot, XDG_STATE_HOME: state }
  const dir = path.join(copilot, "session-state", SESSION)
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "events.jsonl"), `${lines.join("\n")}\n`)
  writeFileSync(path.join(dir, "workspace.yaml"), `id: ${SESSION}\ncwd: ${desk}\ngit_root: ${desk}\nname: Tooling lane\n`)
  mkdirSync(path.join(desk, "_meta"), { recursive: true })
  mkdirSync(path.join(desk, "_archive"), { recursive: true })
  mkdirSync(path.join(desk, "tooling", "ship-it"), { recursive: true })
  const front = Object.entries({ title: "Ship it", ...card }).map(([key, value]) => `${key}: ${value}`).join("\n")
  writeFileSync(path.join(desk, "tooling", "ship-it", "task.md"), `---\n${front}\n---\n\n${body}`)
  const paths = stalledPaths({ env })
  mkdirSync(path.dirname(paths.config), { recursive: true })
  if (drains.length > 0) writeFileSync(path.join(path.dirname(paths.config), "config.json"), JSON.stringify({ drains }))
  const seam = realDatabase ? undefined : database
  const poll = (at = NOW) => pollStalled({ paths, now: at, ackCommand: ["node", "drains.js"], ackFlags: [], env, homeDir: home, database: seam })
  const status = (at = NOW) => stalledStatus({ paths, now: at, env, homeDir: home, database: seam })
  return { root, dir, desk, env, paths, home, poll, status, events: path.join(dir, "events.jsonl") }
}

const nudged = (out) => out.wakes.map((wake) => wake.session)

test("an idle session with an unfinished focused card is nudged once, until it works again", async () => {
  const w = await world()
  const first = await w.poll()
  assert.deepEqual(nudged(first), [SESSION])
  const [wake] = first.wakes
  assert.ok(wake.message.startsWith(NUDGE_PREFIX))
  assert.match(wake.message, /Asked \/ Delivered \/ Accept or send back\?/u)
  assert.equal(wake.replaces, NUDGE_PREFIX)
  assert.deepEqual(wake.done.slice(0, 5), ["node", "drains.js", "stalled", "ack", "--session"])
  assert.deepEqual(nudged(await w.poll(NOW + 5 * MIN)), [SESSION], "a wake the runner has not delivered is offered again with the same id")
  assert.equal((await w.poll(NOW + 6 * MIN)).wakes[0].id, wake.id)
  assert.equal(ackStalled({ paths: w.paths, session: SESSION, wake: wake.id, now: NOW }).changed, true)
  assert.deepEqual((await w.poll(NOW + 30 * MIN)).wakes, [], "the idle stretch is nudged only once")
  appendFileSync(w.events, `${[event("user.message", { content: "carry on" }, NOW + 40 * MIN), event("assistant.turn_start", {}, NOW + 40 * MIN), event("assistant.turn_end", {}, NOW + 41 * MIN)].join("\n")}\n`)
  assert.deepEqual((await w.poll(NOW + 70 * MIN)).wakes.length, 1, "a new idle stretch is a new nudge")
})

test("a failed delivery keeps the nudge offered and a wake that is not the offered one is ignored", async () => {
  const w = await world()
  const [wake] = (await w.poll()).wakes
  assert.equal(ackStalled({ paths: w.paths, session: SESSION, wake: "stale", now: NOW }).changed, false)
  ackStalled({ paths: w.paths, session: SESSION, wake: wake.id, error: "held: the last wake has not arrived", now: NOW })
  const again = await w.poll(NOW + MIN)
  assert.equal(again.wakes[0].id, wake.id)
  assert.match(again.errors[0].error, /was not delivered: held/u)
})

test("a session with a running subagent, shell job or coordinated session is not nudged", async () => {
  const subagent = await world({ lines: history({ before: [event("subagent.started", { toolCallId: "s1", agentName: "general-purpose" }, T0 + 4 * MIN, "agent-1")] }) })
  assert.match((await subagent.status()).checked[0].reason, /running subagents: 1/u)
  assert.deepEqual((await subagent.poll()).wakes, [])
  const finished = await world({ lines: history({ before: [event("subagent.started", { toolCallId: "s1" }, T0 + 4 * MIN, "agent-1"), event("subagent.completed", { toolCallId: "s1" }, T0 + 5 * MIN, "agent-1")] }) })
  assert.equal((await finished.poll()).wakes.length, 1)
  const cancelled = await world({ lines: history({ before: [event("subagent.started", { toolCallId: "s1" }, T0 + 4 * MIN, "agent-1"), event("abort", { reason: "subagent_cancelled" }, T0 + 5 * MIN, "agent-1")] }) })
  assert.equal((await cancelled.poll()).wakes.length, 1, "a cancelled subagent no longer runs")
  const shell = await world({ lines: history({ before: [call("b1", "bash", { command: "sleep 600", mode: "async" }, T0 + 4 * MIN), done("b1", T0 + 4 * MIN, "<command started in background with shellId: 41>")] }) })
  assert.match((await shell.status()).checked[0].reason, /running background shell jobs: 1/u)
  const ended = await world({ lines: history({ before: [call("b1", "bash", {}, T0 + 4 * MIN), done("b1", T0 + 4 * MIN, "<command started in background with shellId: 41>"), event("system.notification", { kind: { type: "shell_completed", shellId: "41", exitCode: 0 } }, T0 + 6 * MIN)] }) })
  assert.equal((await ended.poll()).wakes.length, 1)
  const lane = "22222222-aaaa-4bbb-8ccc-333333333333"
  const coordinated = await world({ database: { sessions: new Map(), childrenOf: (id) => (id === SESSION ? [lane] : []) } })
  const childDir = path.join(coordinated.env.COPILOT_HOME, "session-state", lane)
  mkdirSync(childDir, { recursive: true })
  writeFileSync(path.join(childDir, "events.jsonl"), `${[event("session.start", {}, T0), event("assistant.turn_start", {}, NOW - 2 * MIN)].join("\n")}\n`)
  assert.match((await coordinated.status()).checked[0].reason, /running sessions it coordinates: 1/u)
  writeFileSync(path.join(childDir, "events.jsonl"), `${[event("session.start", {}, T0), event("assistant.turn_end", {}, NOW - 40 * MIN)].join("\n")}\n`)
  assert.equal((await coordinated.poll()).wakes.length, 1, "an idle lane does not excuse its coordinator")
  const vanished = await world({ database: { sessions: new Map(), childrenOf: () => ["44444444-aaaa-4bbb-8ccc-555555555555"] } })
  assert.equal((await vanished.poll()).wakes.length, 1, "a lane whose history is gone is not running")
  const running = await world({ database: { sessions: new Map([[SESSION, { title: "Tooling lane", running: true, archived: false }]]), childrenOf: () => [] } })
  assert.match((await running.status()).checked[0].reason, /the app says it is running/u)
})

test("a session waiting on a person is not nudged", async () => {
  const question = await world({ lines: history({ before: [call("q1", "ask_user", { question: "Ship it?" }, T0 + 4 * MIN)] }) })
  assert.match((await question.status()).checked[0].reason, /waits on a person: a question/u)
  const answered = await world({ lines: history({ before: [call("q1", "ask_user", { question: "Ship it?" }, T0 + 4 * MIN), done("q1", T0 + 5 * MIN)] }) })
  assert.equal((await answered.poll()).wakes.length, 1)
  const gate = await world({ body: "## Blocker\n\nWaiting on Ari's approval of the design, expected 2099-12-31.\n" })
  assert.match((await gate.status()).checked[0].reason, /blocker names a person's decision and a date/u)
  const overdue = await world({ body: "## Blocker\n\nWaiting on Ari's approval, expected 2026-11-01.\n" })
  assert.equal((await overdue.poll()).wakes.length, 1, "an overdue gate is not a reason to rest")
  const undated = await world({ body: "Blocker: waiting on the build.\n" })
  assert.equal((await undated.poll()).wakes.length, 1)
  const approval = await world({ card: { status: "collaborating" } })
  assert.match((await approval.status()).checked[0].reason, /collaborating/u)
  assert.equal(namesHumanGate("Waiting on a reviewer's decision by Friday"), true)
})

test("a finished card, an opt-out, a final report, a drain and a short idle are not nudged", async () => {
  for (const card of [{ status: "done" }, { status: "cancelled" }, { status: "processing", nudge: "false" }]) assert.deepEqual((await (await world({ card })).poll()).wakes, [], JSON.stringify(card))
  const reported = await world({ lines: history({ message: "Shipped.\n\nAsked: ship it.\nDelivered: PR 12 merged.\nAccept or send back?" }) })
  assert.match((await reported.status()).checked[0].reason, /final report/u)
  const drain = await world({ drains: [{ repo: "o/r", session: SESSION }] })
  assert.match((await drain.status()).checked[0].reason, /drain/u)
  const recent = await world({ lines: history({ endedAt: NOW - 5 * MIN }) })
  assert.deepEqual((await recent.poll()).wakes, [])
  const closed = await world({ lines: history({ after: [event("session.shutdown", {}, NOW - MIN)] }) })
  assert.deepEqual((await closed.poll()).wakes, [])
  const unfocused = await world({ lines: history().filter((line) => !line.includes("task_focus")) })
  assert.deepEqual((await unfocused.poll()).wakes, [])
})

test("the dry run lists what would be nudged and records nothing", async () => {
  const w = await world()
  const out = await w.status()
  assert.match(out.status.join("\n"), /would nudge Tooling lane \(11111111\) -> tooling\/ship-it \[processing\], idle 50m/u)
  const stalled = await assessSessions({ now: NOW, config: readStalledConfig(w.paths.config), env: w.env, states: { sessions: {} }, homeDir: w.home, drainSessions: new Set(), database: null })
  assert.equal(stalled.results[0].verdict, "nudge")
  await assert.rejects(import("node:fs/promises").then((fs) => fs.access(w.paths.state)))
})

test("the last focus declaration wins, a failed or cleared one counts for nothing, and a cached read only reads new history", async () => {
  const w = await world({ lines: history({ before: [call("f2", "desk-task_focus", { track: "tooling", slug: "other" }, T0 + 4 * MIN), done("f2", T0 + 4 * MIN, "card not found", false)] }) })
  assert.deepEqual((await findFocus(w.events)).focus, { track: "tooling", slug: "ship-it" })
  const first = await findFocus(w.events)
  appendFileSync(w.events, `${[call("f3", "task_focus", { clear: true }, T0 + 20 * MIN), done("f3", T0 + 20 * MIN)].join("\n")}\n`)
  const next = await findFocus(w.events, { cached: { size: first.size, focus: first.focus } })
  assert.equal(next.focus, null)
  assert.equal((await findFocus(w.events, { cached: { size: next.size, focus: next.focus } })).fresh, false)
})

test("the in-session fallback leads with the nudge for a quiet, unfinished card only", async () => {
  const w = await world({ card: { status: "processing", updated: "'2026-11-15T10:00:00Z'" } })
  const bases = [path.join(w.desk)]
  const focus = { track: "tooling", slug: "ship-it" }
  assert.match(staleCardLead({ bases, focus, now: NOW }), /^Your focused card tooling\/ship-it \(processing\) isn't done and hasn't moved in 60m: walk its definition of done/u)
  assert.equal(staleCardLead({ bases, focus, now: T0 + 5 * MIN }), null, "a card updated minutes ago has not gone quiet")
  const finished = await world({ card: { status: "done", updated: "'2026-11-15T10:00:00Z'" } })
  assert.equal(staleCardLead({ bases: [finished.desk], focus, now: NOW }), null)
})

test("desk_status leads with the nudge once, from the focus the session declared or its history shows", async () => {
  const w = await world({ card: { status: "processing", updated: "'2026-11-15T10:00:00Z'" } })
  const wait = async (lead) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const text = lead.lead()
      if (text !== null) return text
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return null
  }
  const resumed = createStaleCardLead({ env: { ...w.env, COPILOT_AGENT_SESSION_ID: SESSION }, focus: createFocusHolder(), root: () => w.desk, person: () => null, now: () => NOW })
  assert.equal(resumed.lead(), null, "the first call starts the check and does not wait for it")
  assert.match(await wait(resumed), /^Your focused card tooling\/ship-it/u)
  assert.equal(resumed.lead(), null, "once per session")
  const holder = createFocusHolder()
  holder.set({ track: "tooling", slug: "ship-it" })
  const declared = createStaleCardLead({ env: {}, focus: holder, root: () => w.desk, person: () => null, now: () => NOW })
  declared.lead()
  assert.match(await wait(declared), /isn't done and hasn't moved in 60m/u)
  const cleared = createFocusHolder()
  cleared.set(null)
  const none = createStaleCardLead({ env: { ...w.env, COPILOT_AGENT_SESSION_ID: SESSION }, focus: cleared, root: () => w.desk, person: () => null, now: () => NOW })
  none.lead()
  assert.equal(await wait(none), null)
  const nobody = createStaleCardLead({ env: {}, focus: createFocusHolder(), root: () => w.desk, person: () => null, now: () => NOW })
  nobody.lead()
  assert.equal(await wait(nobody), null, "a session with no id and no declared focus has no card to check")
  const broken = createStaleCardLead({ env: {}, focus: holder, root: () => { throw new Error("the desk moved") }, person: () => null, now: () => NOW })
  broken.lead()
  assert.equal(await wait(broken), null, "a check that fails never fails desk_status")
})

test("a session that is working, was stopped by a person, is archived or quiet for days is not nudged", async () => {
  const working = await world({ lines: history({ after: [event("assistant.turn_start", { turnId: "1" }, NOW - MIN)] }) })
  assert.deepEqual((await working.poll()).wakes, [])
  const stopped = await world({ lines: history({ after: [event("abort", { reason: "user_initiated" }, NOW - 20 * MIN)] }) })
  assert.deepEqual((await stopped.poll()).wakes, [])
  const archived = await world({ database: { sessions: new Map([[SESSION, { title: "Lane", running: false, archived: true }]]), childrenOf: () => [] } })
  assert.match((await archived.status()).checked[0].reason, /archived/u)
  const old = await world()
  utimesSync(old.events, new Date(NOW - 30 * 60 * MIN), new Date(NOW - 30 * 60 * MIN))
  assert.deepEqual((await old.poll()).wakes, [])
  const bare = await world({ lines: [event("hook.start", {}, 1)] })
  assert.deepEqual((await bare.poll()).wakes, [], "a history with no meaningful event is left alone")
})

test("a card that cannot be found, or a session with no history folder, is left alone", async () => {
  const missing = await world({ lines: history().map((line) => line.replace("ship-it", "gone")) })
  assert.match((await missing.status()).checked[0].reason, /its card tooling\/gone was not found/u)
  const empty = await world()
  mkdirSync(path.join(empty.env.COPILOT_HOME, "session-state", "33333333-aaaa-4bbb-8ccc-444444444444"), { recursive: true })
  assert.equal((await empty.poll()).wakes.length, 1)
  const noFolder = await mkTempRoot("desk-stalled-none-")
  const none = await assessSessions({ now: NOW, config: readStalledConfig(path.join(noFolder, "none.json")), env: { COPILOT_HOME: noFolder }, states: { sessions: {} }, homeDir: noFolder, drainSessions: new Set(), database: null })
  assert.deepEqual(none.results, [])
})

test("an invalid drain config never hides a stalled card", async () => {
  const w = await world()
  writeFileSync(path.join(path.dirname(w.paths.config), "config.json"), "not json")
  assert.equal((await w.poll()).wakes.length, 1)
})

test("the app's database tells which sessions run and which a coordinator still coordinates", async () => {
  const w = await world({ realDatabase: true })
  const db = new DatabaseSync(path.join(w.env.COPILOT_HOME, "data.db"))
  db.exec("CREATE TABLE sessions (id TEXT, title TEXT, is_running INTEGER, archived_at TEXT); CREATE TABLE workspaces (session_id TEXT, coordinating_creator_session_id TEXT, archived_at TEXT)")
  const lane = "22222222-aaaa-4bbb-8ccc-333333333333"
  const gone = "22222222-aaaa-4bbb-8ccc-444444444444"
  db.exec(`INSERT INTO sessions VALUES ('${SESSION}', NULL, 0, NULL), ('${lane}', 'Lane', 1, NULL);
    INSERT INTO workspaces VALUES ('${lane}', '${SESSION}', NULL), ('${gone}', '${SESSION}', '2026-11-15T09:00:00Z'), (NULL, '${SESSION}', NULL)`)
  db.close()
  assert.match((await w.status()).checked[0].reason, /running sessions it coordinates: 1/u)
  const missing = await world({ realDatabase: true })
  assert.match((await missing.status()).status.join("\n"), /the app's database could not be read/u)
  const alone = await world({ realDatabase: true })
  const empty = new DatabaseSync(path.join(alone.env.COPILOT_HOME, "data.db"))
  empty.exec("CREATE TABLE sessions (id TEXT, title TEXT, is_running INTEGER, archived_at TEXT); CREATE TABLE workspaces (session_id TEXT, coordinating_creator_session_id TEXT, archived_at TEXT)")
  empty.close()
  assert.equal((await alone.poll()).wakes.length, 1, "a coordinator with no sessions of its own is judged by its card")
})

test("the config reads defaults, a home-relative desk, and refuses a bad entry with the reason", async () => {
  const dir = await mkTempRoot("desk-stalled-config-")
  const file = path.join(dir, "stalled.json")
  assert.deepEqual(readStalledConfig(file), { idleMinutes: 15, maxIdleHours: 24, desks: [] })
  writeFileSync(file, JSON.stringify({ idleMinutes: 30, maxIdleHours: 6, desks: ["~/my-desk", "/abs/desk"] }))
  const config = readStalledConfig(file)
  assert.deepEqual([config.idleMinutes, config.maxIdleHours, config.desks[1]], [30, 6, "/abs/desk"])
  assert.match(config.desks[0], /my-desk$/u)
  for (const [text, reason] of [["nope", /not valid JSON/u], ["[]", /is not an object/u], ['{"idleMinutes":0}', /idleMinutes/u], ['{"maxIdleHours":1.5}', /maxIdleHours/u], ['{"desks":["a",""]}', /desks/u]]) {
    writeFileSync(file, text)
    assert.throws(() => readStalledConfig(file), reason)
  }
  assert.throws(() => readStalledConfig(dir), /cannot be read/u)
})

test("a state file of the wrong shape starts over", async () => {
  const w = await world()
  writeFileSync(w.paths.state, "[]")
  assert.equal((await w.poll()).wakes.length, 1)
})

test("cards are found in the session's desk, a Crew member's desk or the archive, and read for what excuses them", async () => {
  const root = await mkTempRoot("desk-stalled-cards-")
  const crew = path.join(root, "crew")
  const solo = path.join(root, "solo")
  for (const dir of [path.join(crew, "_meta"), path.join(crew, "desks", "ari", "tooling", "ship-it"), path.join(crew, "desks", "ari", "tooling", "_archive", "old"), path.join(solo, "_meta"), path.join(solo, "_archive"), path.join(root, "plain")]) mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(crew, "desks", "ari", "tooling", "ship-it", "task.md"), "---\nstatus: blocked\nupdated: 2026-11-15T10:00:00Z\n---\n\n- **Blocker:** the review from Ari, due 2099-01-01\n")
  writeFileSync(path.join(crew, "desks", "ari", "tooling", "_archive", "old", "task.md"), "---\nstatus: done\n---\n")
  writeFileSync(path.join(crew, "desks", "plain.md"), "a file, not a desk")
  writeFileSync(path.join(solo, "bare.md"), "")
  mkdirSync(path.join(solo, "tooling", "bare"), { recursive: true })
  writeFileSync(path.join(solo, "tooling", "bare", "task.md"), "no frontmatter at all\n\n## Waiting on\n\n- none\n")
  const bases = cardBases({ cwd: crew, gitRoot: null, extra: [solo], homeDir: root })
  assert.deepEqual(bases, [crew, path.join(crew, "desks", "ari"), solo])
  const blocked = findFocusedCard(bases, { track: "tooling", slug: "ship-it" })
  assert.match(cardRestReason(blocked, NOW), /names a person's decision and a date/u)
  const archived = findFocusedCard(bases, { track: "tooling", slug: "old" })
  assert.equal(archived.archived, true)
  assert.match(cardRestReason(archived, NOW), /the card is archived/u)
  const bare = findFocusedCard(bases, { track: "tooling", slug: "bare" })
  assert.deepEqual(bare.data, {})
  assert.equal(cardRestReason(bare, NOW), null)
  assert.equal(staleCardLead({ bases, focus: { track: "tooling", slug: "bare" }, now: NOW }), null, "a card with no updated stamp is not known to be quiet")
  assert.equal(findFocusedCard(bases, { track: "tooling", slug: "nope" }), null)
  assert.equal(staleCardLead({ bases, focus: { track: "tooling", slug: "nope" }, now: NOW }), null)
})

test("the status answer leads with the nudge when there is one", () => {
  assert.deepEqual(Object.keys(withStaleCardLead({ status: "ok" }, "Your focused card")), ["nudge", "status"])
  assert.deepEqual(withStaleCardLead({ status: "ok" }, null), { status: "ok" })
})

test("drains.js stalled takes poll, status and ack, and refuses the rest", async () => {
  const w = await world()
  const run = async (argv) => {
    let out = ""
    let err = ""
    const code = await runDrainsCli({ argv, script: "drains.js", env: w.env, io: { stdout: { write: (text) => (out += text) }, stderr: { write: (text) => (err += text) } }, now: () => NOW })
    return { code, out, err }
  }
  assert.equal((await run(["stalled", "bogus"])).code, 2)
  assert.equal((await run(["stalled", "ack", "--wake", "x"])).code, 2)
  assert.equal((await run(["stalled", "ack", "--session", SESSION, "--wake", "x"])).code, 0)
  const status = await run(["stalled", "status"])
  assert.equal(status.code, 0, status.err)
  assert.equal(JSON.parse(status.out).checked[0].verdict, "nudge")
  const poll = await run(["stalled", "poll", "--state", path.join(w.root, "elsewhere.json")])
  assert.equal(JSON.parse(poll.out).wakes.length, 1)
  const broken = await run(["stalled", "poll", "--config", w.root])
  assert.equal(broken.code, 1)
})
