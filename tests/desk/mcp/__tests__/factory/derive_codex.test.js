// Codex CLI deriver tests. The fixtures are the synthetic rollouts built by
// `fixtures/codex/make.js` from the Codex source (see `fixtures/codex/FORMAT.md`);
// no real Codex session exists, so nothing here was checked against one. Every
// free-text field in the fixtures carries `SENTINEL`, and the privacy test asserts
// it never reaches the derived facts. Edge cases the fixtures do not cover are
// built in a temporary `CODEX_HOME` by the small writers below.

import "../_isolated_env.mjs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deriveCodexSession } from "../../../../../plugins/desk/mcp/src/factory/derive-codex.js"
import { deriveMarker } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { publishedAgentType } from "../../../../../plugins/desk/mcp/src/factory/agent-types.js"
import { reconcileMarker } from "../../../../../plugins/desk/mcp/src/factory/session-lifetime.js"
import { factoryStateRoot, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { END, SENTINEL as RUN_SENTINEL, START, STORE, scratch } from "./_session_helpers.js"
import {
  CHILD_MODEL,
  CLI_VERSION,
  PR_URL,
  ROOT_MODEL,
  SENTINEL,
  SESSION_ID,
  STARTS,
  THREAD_IDS,
  generate,
  rolloutRelPath,
} from "./fixtures/codex/make.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtureHome = path.join(here, "fixtures", "codex")
const fixtureRollout = (threadId, startIso) => path.join(fixtureHome, rolloutRelPath(startIso, threadId))
const PLUGINS = [{ name: "desk", version: "3.2.0-alpha.21", source: "ourostack/desk" }]

function deriveFixtureRoot(overrides = {}) {
  return deriveCodexSession({ rolloutPath: fixtureRollout(THREAD_IDS.root, STARTS.root), codexHome: fixtureHome, plugins: PLUGINS, endReason: "complete", ...overrides })
}

// --- Synthetic rollouts ------------------------------------------------------

const T0 = "2026-09-25T08:00:00.000Z"
const at = (seconds, base = T0) => new Date(Date.parse(base) + seconds * 1000).toISOString()
const uuid = (n) => `0199a1b0-aaaa-7000-8000-${String(n).padStart(12, "0")}`
const ROOT = uuid(1)
const rec = (seconds, type, payload, base = T0) => ({ timestamp: at(seconds, base), type, payload })

function metaPayload({ id, parent, startIso = T0, extra = {} }) {
  return {
    session_id: ROOT,
    id,
    timestamp: startIso,
    cwd: "/work/repo",
    originator: "codex_cli_rs",
    cli_version: CLI_VERSION,
    source: parent ? { subagent: { thread_spawn: { parent_thread_id: parent } } } : "cli",
    ...(parent ? { parent_thread_id: parent } : {}),
    ...extra,
  }
}
const meta = ({ id = ROOT, parent, startIso = T0, extra } = {}) => rec(0, "session_meta", metaPayload({ id, parent, startIso, extra }), startIso)
const event = (seconds, payload, base = T0) => rec(seconds, "event_msg", payload, base)
const turnContext = (seconds, model, extra = {}, base = T0) => rec(seconds, "turn_context", { turn_id: "t", model, ...extra }, base)
const item = (seconds, payload, base = T0) => rec(seconds, "response_item", payload, base)
const call = (seconds, callId, name, args, namespace) => item(seconds, { type: "function_call", ...(namespace ? { namespace } : {}), name, arguments: JSON.stringify(args), call_id: callId })
const output = (seconds, callId, text) => item(seconds, { type: "function_call_output", call_id: callId, output: text })
const user = (seconds, content) => item(seconds, { type: "message", role: "user", content })
const tokens = (seconds, total) => event(seconds, { type: "token_count", info: { total_token_usage: total }, rate_limits: null })

async function withHome(run) {
  const home = mkdtempSync(path.join(os.tmpdir(), "desk-codex-home-"))
  try {
    return await run(home)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

/** Write one rollout; a line is an object (serialized) or a raw string. */
function put(home, id, startIso, lines, { newline = true, name } = {}) {
  const file = path.join(home, name ?? rolloutRelPath(startIso, id))
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, lines.map((line) => (typeof line === "string" ? line : JSON.stringify(line))).join("\n") + (newline ? "\n" : ""))
  return file
}

async function deriveRoot(home, lines, overrides = {}) {
  const rolloutPath = put(home, ROOT, T0, lines)
  return deriveCodexSession({ rolloutPath, codexHome: home, plugins: [], endReason: "complete", ...overrides })
}

const agentOf = (facts, n) => facts.agents.find((agent) => agent.n === n)
const unavailable = (facts, field, reason) => facts.unavailable.some((entry) => entry.field === field && entry.reason === reason)
const withEnv = async (values, run) => {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  try {
    return await run()
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// --- The fixtures ------------------------------------------------------------

test("the checked-in fixtures are exactly what make.js generates", () => withHome((home) => {
  generate({ outDir: home })
  const list = (dir) => readdirSync(path.join(dir, "sessions"), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => path.join(entry.parentPath, entry.name).replace(dir, ""))
  assert.deepEqual(list(home).sort(), list(fixtureHome).sort())
  for (const file of list(home)) assert.equal(readFileSync(path.join(home, file), "utf8"), readFileSync(path.join(fixtureHome, file), "utf8"))
}))

test("the thread tree is rebuilt from child session_meta parents, including a next-day grandchild", async () => {
  const { facts } = await deriveFixtureRoot()
  assert.equal(facts.session.id, SESSION_ID)
  assert.deepEqual(facts.agents, [
    { n: 0, parent: null, model: ROOT_MODEL },
    { n: 1, parent: 0, model: CHILD_MODEL, agent_type: "explorer" },
    { n: 2, parent: 0, model: ROOT_MODEL, agent_type: "worker" },
    { n: 3, parent: 2, model: CHILD_MODEL, agent_type: "explorer" },
  ])
})

test("an unrelated thread started in the same minute and folder, and its own child, never join", async () => {
  const { facts } = await deriveFixtureRoot()
  assert.equal(facts.agents.length, 4)
  const unrelated = await deriveCodexSession({ rolloutPath: fixtureRollout(THREAD_IDS.unrelated, STARTS.unrelated), codexHome: fixtureHome, plugins: [], endReason: "complete" })
  assert.deepEqual(unrelated.facts.agents.map((agent) => agent.n), [0, 1], "it keeps its own child")
  assert.notEqual(unrelated.facts.session.id, SESSION_ID)
})

test("session facts: host, version, entrypoint, times and an ended session", async () => {
  const { facts } = await deriveFixtureRoot()
  assert.equal(facts.session.host, "codex-cli")
  assert.equal(facts.session.host_version, CLI_VERSION)
  assert.equal(facts.session.entrypoint, "cli")
  assert.equal(facts.session.started_at, STARTS.root)
  assert.equal(facts.session.ended_at, facts.session.derived_through)
  assert.equal(facts.session.end_reason, "complete")
  assert.deepEqual(facts.plugins, PLUGINS)
  assert.deepEqual(facts.jobs, [])
})

test("models come from turn_context, with requested_model left out when it equals the resolved model", async () => {
  const { facts } = await deriveFixtureRoot()
  assert.deepEqual(facts.models.map((model) => model.id), [CHILD_MODEL, ROOT_MODEL].sort())
  for (const agent of facts.agents) assert.equal(Object.hasOwn(agent, "requested_model"), false)
  const root = facts.models.find((model) => model.id === ROOT_MODEL)
  assert.deepEqual(root, { id: ROOT_MODEL, requests: 3, tokens: { input: 1600, output: 450, cache_read: 1500, cache_write: 0, reasoning: 130 } })
})

test("tool kinds, counts and intervals follow the Codex tool names", async () => {
  const { facts } = await deriveFixtureRoot()
  assert.deepEqual(facts.counts.tool_calls, { shell: 3, edit: 1, desk: 1, agent: 3, other: 1 })
  assert.deepEqual(facts.counts.tool_failures, {})
  const tools = facts.intervals.filter((interval) => interval.kind === "tool").map((interval) => interval.tool).sort()
  assert.deepEqual(tools, ["desk", "edit", "other", "shell", "shell", "shell"], "spawn_agent has no tool interval")
  assert.equal(facts.intervals.filter((interval) => interval.kind === "subagent").length, 3)
  assert.deepEqual(facts.intervals.filter((interval) => interval.kind === "subagent" && interval.agent === 2).map((interval) => interval.start), [STARTS.grandchild])
  assert.equal(facts.intervals.filter((interval) => interval.kind === "human_wait").length, 1)
  assert.equal(facts.intervals.filter((interval) => interval.kind === "turn" && interval.agent === 0).length, 2)
})

test("binding events: file write, shell commit, spawn task and the PR worker", async () => {
  const { facts, events } = await deriveFixtureRoot()
  assert.deepEqual(events.fileWrites.map(({ path: file, agent }) => ({ file, agent })), [{ file: `/tmp/${SENTINEL}/personal-desk/desk-plugin/some-task/task.md`, agent: 0 }])
  assert.deepEqual(events.shellGitCommits.map(({ cwd, agent }) => ({ cwd, agent })), [{ cwd: `/tmp/${SENTINEL}/repo`, agent: 0 }])
  assert.deepEqual(events.spawnTasks, [{ agent: 1, track: "desk-plugin", slug: "some-task" }])
  assert.deepEqual(events.deskToolCalls, [])
  assert.deepEqual(events.commitShas, [])
  assert.deepEqual(events.nativeCommitShas, [])
  assert.deepEqual(facts.refs.prs, [{ repo: "example-org/example-repo", number: 42, agent: 0 }])
  assert.ok(PR_URL.includes("/pull/42"))
})

test("no prompt, output, path or other free text reaches the facts; the facts validate", async () => {
  for (const [threadId, start] of Object.entries(STARTS).map(([name, startIso]) => [THREAD_IDS[name], startIso])) {
    const result = await deriveCodexSession({ rolloutPath: fixtureRollout(threadId, start), codexHome: fixtureHome, plugins: PLUGINS, endReason: "complete" })
    if (result.facts === null) continue
    assert.equal(JSON.stringify(result.facts).includes(SENTINEL), false)
    assert.deepEqual(validateLocalFacts(result.facts), { ok: true, errors: [] })
  }
  const { events } = await deriveFixtureRoot()
  assert.equal(JSON.stringify(events).includes(SENTINEL), true, "the sentinel survives in the in-memory events only, as the path it sits in")
})

test("agent types published from Codex facts are the built-in roles only", async () => {
  const { facts } = await deriveFixtureRoot()
  for (const agent of facts.agents.filter((entry) => entry.n > 0)) assert.equal(publishedAgentType("codex-cli", agent.agent_type, []), agent.agent_type)
  assert.equal(publishedAgentType("codex-cli", "my-private-role", []), "custom")
})

test("a file that ends mid-line keeps what parsed and says the log was truncated", async () => {
  const { facts } = await deriveCodexSession({ rolloutPath: fixtureRollout(THREAD_IDS.truncated, STARTS.truncated), codexHome: fixtureHome, plugins: [], endReason: "complete" })
  assert.equal(facts.session.id, THREAD_IDS.truncated)
  assert.ok(unavailable(facts, "turns", "log_truncated"))
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
})

test("a rollout with no session_meta first record is source_unreadable", async () => {
  const result = await deriveCodexSession({ rolloutPath: fixtureRollout(THREAD_IDS.noMeta, STARTS.noMeta), codexHome: fixtureHome, plugins: [], endReason: null })
  assert.deepEqual(result, { facts: null, events: null, reason: "source_unreadable" })
})

test("a missing, non-string or unreadable input never throws", async () => {
  assert.deepEqual(await deriveCodexSession({ rolloutPath: path.join(fixtureHome, "nope.jsonl") }), { facts: null, events: null, reason: "log_missing" })
  assert.deepEqual(await deriveCodexSession({ rolloutPath: 7 }), { facts: null, events: null, reason: "log_missing" })
  assert.deepEqual(await deriveCodexSession({ rolloutPath: fixtureHome }), { facts: null, events: null, reason: "source_unreadable" })
  assert.deepEqual(await deriveCodexSession(undefined), { facts: null, events: null, reason: "source_unreadable" })
})

test("an open session (no end reason) and an unknown end reason both read as open", async () => {
  for (const endReason of [null, "not-a-reason"]) {
    const { facts } = await deriveFixtureRoot({ endReason })
    assert.equal(facts.session.ended_at, null)
    assert.equal(facts.session.end_reason, null)
    assert.ok(unavailable(facts, "ended_at", "session_open"))
  }
})

test("an unknown record type in the rollout is skipped: the same facts come back without it", () => withHome(async (home) => {
  const lines = [meta(), turnContext(1, ROOT_MODEL), user(2, "hello")]
  const plain = await deriveRoot(home, lines)
  const withUnknown = await deriveRoot(home, [...lines.slice(0, 2), rec(1.5, "future_record_kind", { secret: SENTINEL }), ...lines.slice(2)])
  assert.deepEqual(withUnknown.facts, plain.facts)
}))

// --- CODEX_HOME resolution ---------------------------------------------------

test("CODEX_HOME resolves from the codexHome argument, then $CODEX_HOME, then ~/.codex", () => withHome(async (home) => {
  const rolloutPath = fixtureRollout(THREAD_IDS.root, STARTS.root)
  const count = async (options) => (await deriveCodexSession({ rolloutPath, plugins: [], endReason: "complete", ...options })).facts.agents.length
  await withEnv({ CODEX_HOME: fixtureHome }, async () => {
    assert.equal(await count({}), 4, "from $CODEX_HOME")
    assert.equal(await count({ codexHome: path.join(home, "elsewhere") }), 1, "the argument wins")
    assert.equal(await count({ codexHome: "" }), 4, "an empty argument falls through")
  })
  const dot = path.join(home, ".codex")
  generate({ outDir: dot })
  await withEnv({ CODEX_HOME: undefined, HOME: home, USERPROFILE: home }, async () => {
    assert.equal(await count({}), 4, "from ~/.codex")
  })
  await withEnv({ CODEX_HOME: undefined, HOME: path.join(home, "empty"), USERPROFILE: path.join(home, "empty") }, async () => {
    assert.equal(await count({}), 1, "a home with no sessions has only the root")
  })
}))

// --- Finding children (R5) ---------------------------------------------------

test("scan range: a day before the start through a day after the last record joins; further folders do not", () => withHome(async (home) => {
  const before = "2026-09-24T23:30:00.000Z"
  const after = "2026-09-26T03:00:00.000Z"
  const far = "2026-09-27T03:00:00.000Z"
  const tooEarly = "2026-09-23T23:30:00.000Z"
  for (const [n, startIso] of [[2, before], [3, after], [4, far], [5, tooEarly]]) put(home, uuid(n), startIso, [meta({ id: uuid(n), parent: ROOT, startIso })])
  const { facts } = await deriveRoot(home, [meta(), turnContext(1, ROOT_MODEL)])
  assert.deepEqual(facts.agents.map((agent) => agent.n), [0, 1, 2])
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
}))

test("only an exact parent id match joins; grandchildren join by repeated passes; numbering is by start time", () => withHome(async (home) => {
  const day24 = "2026-09-24T12:00:00.000Z"
  const at0 = (seconds) => at(seconds)
  const A = uuid(2), E = uuid(3), D = uuid(4), C = uuid(5), X = uuid(6), Y = uuid(7), Z = uuid(8)
  // A (day 24 folder) and D (day 24 folder, child of E, which only joins on the second pass), E and X/Y in day 25, C in day 26.
  put(home, A, day24, [meta({ id: A, parent: ROOT, startIso: day24 }), turnContext(1, CHILD_MODEL, {}, day24)])
  put(home, D, day24, [meta({ id: D, parent: E, startIso: at0(30) }), turnContext(1, CHILD_MODEL, {}, at0(30))], { name: rolloutRelPath("2026-09-24T12:00:01.000Z", D) })
  put(home, E, at0(20), [meta({ id: E, parent: ROOT, startIso: at0(20) })])
  put(home, C, "2026-09-26T01:00:00.000Z", [meta({ id: C, parent: A, startIso: at0(5) })])
  put(home, X, at0(40), [meta({ id: X, parent: uuid(99), startIso: at0(40), extra: { session_id: ROOT } })])
  put(home, Y, at0(41), [meta({ id: Y, parent: Y, startIso: at0(41) })])
  // The same thread id in a second file never adds a second worker.
  put(home, A, at0(60), [meta({ id: A, parent: ROOT, startIso: at0(60) })])
  // A parentless thread is never a candidate.
  put(home, Z, at0(42), [meta({ id: Z, startIso: at0(42) })])
  const { facts } = await deriveRoot(home, [meta(), turnContext(1, ROOT_MODEL)])
  // Start-time order: A (day 24), C (+5s), E (+20s), D (+30s).
  assert.deepEqual(facts.agents.map((agent) => [agent.n, agent.parent]), [[0, null], [1, 0], [2, 1], [3, 0], [4, 3]])
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
}))

test("candidates with no usable first record are skipped, and a first record alone is enough to join", () => withHome(async (home) => {
  const child = uuid(2)
  const folder = path.join(home, "sessions", "2026", "09", "25")
  mkdirSync(path.join(folder, "rollout-a-directory.jsonl"), { recursive: true })
  const bad = [
    ["rollout-empty.jsonl", ""],
    ["rollout-garbage.jsonl", "not json\n"],
    ["rollout-null.jsonl", "null\n"],
    ["rollout-notmeta.jsonl", `${JSON.stringify(rec(0, "turn_context", { model: "m" }))}\n`],
    ["rollout-noid.jsonl", `${JSON.stringify(rec(0, "session_meta", { id: "nope", parent_thread_id: ROOT }))}\n`],
    ["rollout-payload.jsonl", `${JSON.stringify(rec(0, "session_meta", "text"))}\n`],
    ["rollout-notime.jsonl", `${JSON.stringify({ type: "session_meta", payload: metaPayload({ id: uuid(9), parent: ROOT }) })}\n`],
    ["notes.txt", "ignored"],
  ]
  for (const [name, text] of bad) writeFileSync(path.join(folder, name), text)
  // A one-line file with no trailing newline, and a broken second line: only the first record is read to join.
  put(home, child, at(10), [meta({ id: child, parent: ROOT, startIso: at(10) }), "{broken"], { newline: false })
  // A rollout of one line with no newline at all is read whole.
  const lone = uuid(3)
  put(home, lone, at(11), [meta({ id: lone, parent: ROOT, startIso: at(11) })], { newline: false })
  const { facts } = await deriveRoot(home, [meta()])
  assert.deepEqual(facts.agents.map((agent) => agent.n), [0, 1, 2])
}))

test("the thread cap stops the search and says so", () => withHome(async (home) => {
  for (const n of [2, 3, 4]) put(home, uuid(n), at(n), [meta({ id: uuid(n), parent: ROOT, startIso: at(n) })])
  const { facts } = await deriveRoot(home, [meta()], { maxThreads: 2 })
  assert.deepEqual(facts.agents.map((agent) => agent.n), [0, 1])
  assert.ok(unavailable(facts, "turns", "capped"))
}))

// --- Spawn linking, agent types and models -----------------------------------

test("spawn calls and child metas give parents, agent types, requested models and Desk tasks", () => withHome(async (home) => {
  const [V1, V2, V3, V4] = [uuid(2), uuid(3), uuid(4), uuid(5)]
  const rootLines = [
    meta(),
    turnContext(1, ROOT_MODEL),
    call(10, "s1", "spawn_agent", { message: "Desk-Task: trk/slug-a\nbrief", agent_type: "worker" }, "multi_agent_v1"),
    output(11, "s1", JSON.stringify({ agent_id: V1, nickname: "n" })),
    call(12, "s2", "spawn_agent", { message: "x", task_name: "t", agent_type: "Bad Type!" }),
    output(13, "s2", JSON.stringify({ task_name: "t", nickname: "n" })),
    call(14, "s3", "spawn_agent", { agent_type: "worker" }, "multi_agent_v1"),
    output(15, "s3", "oops not json"),
    call(16, "s4", "spawn_agent", { message: "y" }, "multi_agent_v1"),
    output(17, "s4", JSON.stringify({ agent_id: "not-a-uuid" })),
  ]
  put(home, V1, at(20), [meta({ id: V1, parent: ROOT, startIso: at(20) }), turnContext(1, CHILD_MODEL, {}, at(20)), user(2, "no task line", at(20))])
  put(home, V2, at(21), [meta({ id: V2, parent: ROOT, startIso: at(21), extra: { agent_type: "explorer" } }), user(1, [{ type: "input_text", text: "Desk-Task: trk/slug-b" }, 7], at(21))])
  put(home, V3, at(22), [
    meta({ id: V3, parent: ROOT, startIso: at(22), extra: { parent_thread_id: undefined, source: { subagent: { thread_spawn: { parent_thread_id: ROOT, agent_role: "custom-role" } } } } }),
    item(1, { type: "message", role: "assistant", content: "hello" }, at(22)),
    user(2, "hello", at(22)),
    user(3, "Desk-Task: trk/second-message-ignored", at(22)),
  ])
  put(home, V4, at(23), [
    meta({ id: V4, parent: ROOT, startIso: at(23), extra: { agent_role: "bad role!", agent_type: 5 } }),
    turnContext(1, CHILD_MODEL, {}, at(23)),
    turnContext(2, ROOT_MODEL, {}, at(23)),
    turnContext(3, ROOT_MODEL, {}, at(23)),
    user(4, { not: "content" }, at(23)),
  ])
  const { facts, events } = await deriveRoot(home, rootLines)
  assert.deepEqual(agentOf(facts, 1), { n: 1, parent: 0, model: CHILD_MODEL, agent_type: "worker" }, "the agent type falls back to the spawn call's")
  assert.deepEqual(agentOf(facts, 2), { n: 2, parent: 0, model: "unknown", agent_type: "explorer" }, "the agent_type alias, and no model with no turn_context")
  assert.deepEqual(agentOf(facts, 3), { n: 3, parent: 0, model: "unknown", agent_type: "custom-role" }, "the role named inside source.subagent.thread_spawn")
  assert.deepEqual(agentOf(facts, 4), { n: 4, parent: 0, model: ROOT_MODEL, requested_model: CHILD_MODEL }, "no invalid agent type; the first turn model is the request")
  assert.deepEqual(events.spawnTasks, [{ agent: 1, track: "trk", slug: "slug-a" }, { agent: 2, track: "trk", slug: "slug-b" }])
  assert.equal(facts.counts.tool_calls.agent, 4)
  assert.equal(facts.intervals.some((interval) => interval.kind === "tool" && interval.tool === "agent"), false)
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
}))

test("a child's records below its subagent_history_start_ordinal are inherited context and not counted", () => withHome(async (home) => {
  const child = uuid(2)
  put(home, child, at(20), [
    meta({ id: child, parent: ROOT, startIso: at(20), extra: { subagent_history_start_ordinal: 5 } }),
    { ...call(1, "old", "exec_command", { cmd: "git commit -m inherited" }), ordinal: 3 },
    { ...output(2, "old", "Process exited with code 0"), ordinal: 4 },
    { ...call(3, "new", "exec_command", { cmd: "git commit -m own" }), ordinal: 7 },
    { ...output(4, "new", "Process exited with code 0"), ordinal: 8 },
    { ...call(5, "free", "exec_command", { cmd: "echo hi" }), ordinal: "later" },
    output(6, "free", "ok"),
  ])
  const { facts, events } = await deriveRoot(home, [meta({ extra: { subagent_history_start_ordinal: 5 } }), { ...call(1, "own-root", "exec_command", { cmd: "echo" }), ordinal: 1 }, { ...output(2, "own-root", "x"), ordinal: 2 }])
  assert.equal(events.shellGitCommits.length, 1)
  assert.equal(events.shellGitCommits[0].agent, 1)
  assert.equal(facts.counts.tool_calls.shell, 3, "the root keeps its own low ordinals")
}))

// --- Tools, outcomes and binding events --------------------------------------

test("shell outcomes, retries, commits, MCP names, patches and PRs", () => withHome(async (home) => {
  const patch = (...lines) => `*** Begin Patch\n${lines.join("\n")}\n*** End Patch`
  const lines = [
    meta(),
    event(1, { type: "task_started", turn_id: "t" }),
    turnContext(1.1, ROOT_MODEL, { cwd: "/work/repo" }),
    // Commits: success in a named directory, a non-zero exit, a JSON-metadata success in the turn's directory.
    call(2, "c1", "exec_command", { cmd: "git commit -m x", workdir: "/work/other" }),
    output(3, "c1", "Chunk ID: 1\nProcess exited with code 0\nOutput:\nok"),
    call(4, "c2", "exec_command", { cmd: "git commit -m y" }),
    output(5, "c2", "Process exited with code 1\nOutput:\nfailed"),
    call(6, "c3", "exec_command", { cmd: "git commit -m z" }),
    output(7, "c3", JSON.stringify({ output: "x", metadata: { exit_code: 0 } })),
    call(8, "c4", "exec_command", { command: "git status" }),
    output(9, "c4", "{not json"),
    call(10, "c5", "exec_command", { cmd: "false" }),
    item(11, { type: "function_call_output", call_id: "c5", output: [{ type: "output_text", text: "Process exited with code 2" }, null, 5] }),
    call(12, "c6", "exec_command", { cmd: "echo" }),
    item(13, { type: "function_call_output", call_id: "c6", output: { unexpected: true } }),
    // Patches: relative, absolute and moved paths, the function-call form, the shell form and a failed one.
    item(14, { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: patch("*** Add File: rel/new.md", "*** Move to: /abs/moved.md", "*** Delete File: gone.md") }),
    item(15, { type: "custom_tool_call_output", call_id: "p1", output: "Success" }),
    call(16, "p2", "apply_patch", { input: patch("*** Update File: a.md") }),
    output(17, "p2", "Success"),
    call(18, "p3", "exec_command", { cmd: `apply_patch <<'EOF'\n${patch("*** Update File: /abs/shell.md")}\nEOF` }),
    output(19, "p3", "Success"),
    item(20, { type: "custom_tool_call", call_id: "p4", name: "apply_patch", input: patch("*** Update File: /abs/failed.md") }),
    item(21, { type: "custom_tool_call_output", call_id: "p4", output: "Process exited with code 1" }),
    item(22, { type: "custom_tool_call", call_id: "p5", name: 5, input: "x" }),
    item(23, { type: "custom_tool_call_output", call_id: "p5", output: "done" }),
    // Local shell calls: argv through bash -lc, plain argv, a non-array command, no action, no call id.
    item(24, { type: "local_shell_call", call_id: "l1", status: "completed", action: { type: "exec", command: ["bash", "-lc", "git commit -m q"], working_directory: "/work/lsh" } }),
    output(25, "l1", "ok"),
    item(26, { type: "local_shell_call", call_id: "l2", action: { type: "exec", command: ["git", "status"] } }),
    output(27, "l2", "ok"),
    item(28, { type: "local_shell_call", call_id: "l3", action: { type: "exec", command: "git commit" } }),
    output(29, "l3", "ok"),
    item(30, { type: "local_shell_call", call_id: "l4" }),
    output(31, "l4", "ok"),
    item(32, { type: "local_shell_call", action: { type: "exec", command: ["ls"] } }),
    // MCP names: split with and without a trailing delimiter, joined, other servers, other tools, bad shapes.
    call(33, "d1", "task_create", { track: "trk", slug: "one", status: "drafting", person: "pat" }, "mcp__desk__"),
    output(34, "d1", "created"),
    call(35, "d2", "mcp__desk__task_update", { track: "trk", slug: "two" }),
    output(36, "d2", "Process exited with code 1"),
    call(37, "d3", "task_archive", { track: "trk", slug: "three" }, "mcp__desk"),
    output(38, "d3", "archived"),
    call(39, "d4", "thing", {}, "mcp__other__"),
    output(40, "d4", "x"),
    call(41, "d5", "wait_agent", {}, "multi_agent_v1"),
    output(42, "d5", "x"),
    call(43, "d6", "mcp__x__y", {}, "mcp__x__"),
    output(44, "d6", "x"),
    item(45, { type: "function_call", call_id: "d7", arguments: "{oops" }),
    output(46, "d7", "x"),
    item(46.5, { type: "function_call", call_id: "d9", name: "exec_command", arguments: "[1, 2]" }),
    output(46.6, "d9", "x"),
    call(47, "d8", "desk_status", {}, "mcp__desk__"),
    output(48, "d8", "x"),
    // Outputs with no call, or no usable id, are ignored.
    output(49, "never-called", "x"),
    item(50, { type: "function_call_output", call_id: 7, output: "x" }),
    // PRs: created, created again (same PR), no URL, a bad repo, number zero, failed, not a create.
    call(51, "r1", "exec_command", { cmd: "gh pr create --fill" }),
    output(52, "r1", "https://github.com/acme/widgets.git/pull/7\n"),
    call(53, "r2", "exec_command", { cmd: "gh  pr  create" }),
    output(54, "r2", "https://github.com/acme/widgets/pull/7"),
    call(55, "r3", "exec_command", { cmd: "gh pr create" }),
    output(56, "r3", "no url here"),
    call(57, "r4", "exec_command", { cmd: "gh pr create" }),
    output(58, "r4", "https://github.com/ac!me/widgets/pull/9"),
    call(59, "r5", "exec_command", { cmd: "gh pr create" }),
    output(60, "r5", "https://github.com/acme/widgets/pull/0"),
    call(61, "r6", "exec_command", { cmd: "gh pr create" }),
    output(62, "r6", "Process exited with code 1\nhttps://github.com/acme/widgets/pull/11"),
    call(63, "r7", "exec_command", { cmd: "gh pr view 12" }),
    output(64, "r7", "https://github.com/acme/widgets/pull/12"),
    event(70, { type: "task_complete", turn_id: "t" }),
  ]
  const { facts, events } = await deriveRoot(home, lines)
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
  assert.deepEqual(events.shellGitCommits.map(({ cwd }) => cwd), ["/work/other", "/work/repo", "/work/lsh"])
  assert.equal(facts.counts.tool_retries, 4, "a later same-kind call after a failed one is one retry per failure: c3, c6, r7 and d3")
  assert.deepEqual(facts.counts.tool_failures, { shell: 3, edit: 1, desk: 1 }, "c2, c5 and r6; the failed patch; the failed desk call")
  assert.deepEqual(events.fileWrites.map(({ path: file }) => file), ["/work/repo/rel/new.md", "/abs/moved.md", "/work/repo/a.md", "/abs/shell.md"])
  assert.deepEqual(events.deskToolCalls, [
    { at: at(33), name: "mcp__desk__task_create", track: "trk", slug: "one", person: "pat", status: "drafting", agent: 0, ok: true },
    { at: at(35), name: "mcp__desk__task_update", track: "trk", slug: "two", person: null, status: null, agent: 0, ok: false },
    { at: at(37), name: "mcp__desk__task_archive", track: "trk", slug: "three", person: null, status: null, agent: 0, ok: true },
  ])
  assert.deepEqual(facts.refs.prs, [{ repo: "acme/widgets", number: 7, agent: 0 }])
  assert.equal(facts.counts.tool_calls.desk, 4)
  assert.equal(facts.counts.tool_calls.mcp, 2)
  assert.ok(unavailable(facts, "tool_durations", "log_truncated"), "the call with no id can never finish")
}))

test("an unfinished call flags tool durations, as log_truncated when ended and session_open when open", () => withHome(async (home) => {
  const lines = [meta(), turnContext(1, ROOT_MODEL), call(2, "c1", "exec_command", { cmd: "sleep 100" })]
  assert.ok(unavailable((await deriveRoot(home, lines)).facts, "tool_durations", "log_truncated"))
  assert.ok(unavailable((await deriveRoot(home, lines, { endReason: null })).facts, "tool_durations", "session_open"))
}))

// --- Turns, tokens and other records -----------------------------------------

test("turns, aliases, an unfinished turn and human waits", () => withHome(async (home) => {
  const lines = [
    meta(),
    turnContext(1, ROOT_MODEL),
    event(1, { type: "task_started", turn_id: "a" }),
    event(2, { type: "task_started", turn_id: "b" }),
    event(3, { type: "task_complete", turn_id: "b" }),
    event(4, { type: "turn_complete", turn_id: "x" }),
    event(10, { type: "turn_started", turn_id: "c" }),
    event(12, { type: "turn_aborted", turn_id: "c", reason: "interrupted" }),
    event(13, { type: "user_message", message: SENTINEL }),
    event(20, { type: "task_started", turn_id: "d" }),
  ]
  const { facts } = await deriveRoot(home, lines)
  const kinds = (kind) => facts.intervals.filter((interval) => interval.kind === kind).map((interval) => [interval.start, interval.end])
  assert.deepEqual(kinds("turn"), [[at(2), at(3)], [at(10), at(12)]])
  assert.deepEqual(kinds("human_wait"), [[at(4), at(10)], [at(12), at(20)]])
  assert.ok(unavailable(facts, "turns", "log_truncated"), "an interrupted or unfinished turn is flagged")
  assert.ok(unavailable((await deriveRoot(home, lines, { endReason: null })).facts, "turns", "session_open"))
}))

test("token totals are cumulative: each increase is a request, a lower total is a new baseline", () => withHome(async (home) => {
  const total = (input, cached, output, reasoning, write = 0) => ({ input_tokens: input, cached_input_tokens: cached, cache_write_input_tokens: write, output_tokens: output, reasoning_output_tokens: reasoning })
  const lines = [
    meta(),
    turnContext(1, ROOT_MODEL),
    event(2, { type: "token_count", info: null }),
    event(3, { type: "token_count", info: { total_token_usage: "x" } }),
    tokens(4, total(100, 40, 50, 10, 5)),
    tokens(5, total(100, 40, 50, 10, 5)),
    tokens(6, total(300, 100, 80, 20, 5)),
    tokens(7, total(50, 0, 10, 0)),
    tokens(8, { input_tokens: -5, output_tokens: "x" }),
  ]
  const { facts } = await deriveRoot(home, lines)
  assert.deepEqual(facts.models, [{ id: ROOT_MODEL, requests: 3, tokens: { input: 250, output: 70, cache_read: 100, cache_write: 5, reasoning: 20 } }])
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
}))

test("tokens with no known model, a bad model, or no usage at all are flagged, not invented", () => withHome(async (home) => {
  const noModel = await deriveRoot(home, [meta(), tokens(2, { input_tokens: 10, output_tokens: 5 })])
  assert.deepEqual(noModel.facts.models, [])
  assert.ok(unavailable(noModel.facts, "models", "source_unreadable"))
  const badModel = await deriveRoot(home, [meta(), turnContext(1, "bad model!"), turnContext(2, 5)])
  assert.equal(agentOf(badModel.facts, 0).model, "unknown")
  assert.ok(unavailable(badModel.facts, "models", "source_unreadable"))
  const noUsage = await deriveRoot(home, [meta(), turnContext(1, ROOT_MODEL)])
  assert.ok(unavailable(noUsage.facts, "tokens", "source_unreadable"))
  assert.ok(unavailable(noUsage.facts, "models", "source_unreadable"))
}))

test("the most-used model wins, and ties keep the first seen", () => withHome(async (home) => {
  const { facts } = await deriveRoot(home, [meta(), turnContext(1, "model-a"), turnContext(2, "model-b"), turnContext(3, "model-b"), turnContext(4, "model-a")])
  assert.deepEqual(agentOf(facts, 0), { n: 0, parent: null, model: "model-a" })
  const second = await deriveRoot(home, [meta(), turnContext(1, "model-a"), turnContext(2, "model-b"), turnContext(3, "model-b")])
  assert.deepEqual(agentOf(second.facts, 0), { n: 0, parent: null, model: "model-b", requested_model: "model-a" })
}))

test("unreadable lines are skipped and flagged; blank, non-object and odd-payload lines are harmless", () => withHome(async (home) => {
  const lines = [
    meta(),
    "",
    "[1, 2]",
    "42",
    { timestamp: "yesterday", type: "turn_context", payload: { model: ROOT_MODEL } },
    { type: "response_item", payload: { type: "function_call" } },
    { timestamp: at(1), type: "event_msg", payload: "text" },
    { timestamp: at(2), type: "response_item" },
    rec(3, "compacted", { message: SENTINEL }),
    rec(4, "compacted", {}),
  ]
  const { facts } = await deriveRoot(home, lines)
  assert.equal(facts.counts.compactions, 2)
  assert.ok(unavailable(facts, "turns", "source_unreadable"))
  assert.ok(unavailable(facts, "tool_durations", "source_unreadable"))
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
}))

test("the root's own subagent_history_start_ordinal never hides its records", () => withHome(async (home) => {
  const { facts } = await deriveRoot(home, [meta({ extra: { subagent_history_start_ordinal: 100 } }), { ...turnContext(1, ROOT_MODEL), ordinal: 1 }])
  assert.equal(agentOf(facts, 0).model, ROOT_MODEL)
}))

test("a patch path that cannot be made absolute is dropped, not guessed", () => withHome(async (home) => {
  const patch = "*** Begin Patch\n*** Update File: rel/file.md\n*** End Patch"
  const { events } = await deriveRoot(home, [
    meta({ extra: { cwd: undefined } }),
    item(1, { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: patch }),
    item(2, { type: "custom_tool_call_output", call_id: "p1", output: "ok" }),
    call(3, "p2", "exec_command", { cmd: `apply_patch <<'EOF'\n${patch}\nEOF`, workdir: "relative/dir" }),
    output(4, "p2", "ok"),
  ])
  assert.deepEqual(events.fileWrites, [])
}))

// --- Identity edge cases -----------------------------------------------------

test("a first record that is not a usable session_meta, or a missing cli_version, is source_unreadable", () => withHome(async (home) => {
  const unreadable = { facts: null, events: null, reason: "source_unreadable" }
  assert.deepEqual(await deriveRoot(home, [meta({ extra: { cli_version: "latest" } })]), unreadable)
  assert.deepEqual(await deriveRoot(home, [meta({ extra: { cli_version: undefined } })]), unreadable)
  assert.deepEqual(await deriveRoot(home, [meta({ id: "not-a-uuid" })]), unreadable)
  assert.deepEqual(await deriveRoot(home, ["{cut off"]), unreadable)
  assert.deepEqual(await deriveRoot(home, [turnContext(0, ROOT_MODEL), meta()]), unreadable)
  assert.deepEqual(await deriveRoot(home, [{ type: "session_meta", payload: metaPayload({ id: ROOT }) }]), unreadable)
  assert.deepEqual(await deriveRoot(home, [rec(0, "session_meta", [])]), unreadable)
  assert.deepEqual(await deriveRoot(home, ["null"]), unreadable)
}))

test("entrypoint reads the source string; anything else is unknown", () => withHome(async (home) => {
  const entrypoint = async (source) => (await deriveRoot(home, [meta({ extra: { source } })])).facts.session.entrypoint
  assert.equal(await entrypoint("cli"), "cli")
  assert.equal(await entrypoint("exec"), "cli")
  assert.equal(await entrypoint("vscode"), "unknown")
  assert.equal(await entrypoint({ custom: "x" }), "unknown")
  assert.equal(await entrypoint("toString"), "unknown")
}))

test("caller plugins are checked against the schema before they are kept", () => withHome(async (home) => {
  const { facts } = await deriveRoot(home, [meta()], { plugins: [...PLUGINS, { name: "Bad Name", version: "1" }] })
  assert.deepEqual(facts.plugins, PLUGINS)
  assert.ok(unavailable(facts, "plugins", "source_unreadable"))
}))

// --- Dispatch and lifetime ---------------------------------------------------

function codexMarker(ctx, overrides = {}) {
  const sessionsDir = path.join(ctx.base, ".codex", "sessions", "2026", "09", "26")
  const id = "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
  const logPath = path.join(sessionsDir, `rollout-2026-09-26T08-00-00-${id}.jsonl`)
  mkdirSync(sessionsDir, { recursive: true })
  writeFileSync(logPath, [
    { timestamp: START, type: "session_meta", payload: metaPayload({ id, startIso: START }) },
    { timestamp: START, type: "turn_context", payload: { model: ROOT_MODEL, cwd: ctx.desk } },
    { timestamp: END, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: RUN_SENTINEL }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n")
  return {
    schema_version: 1, host: "codex-cli", session_id: id, log_path: logPath, cwd: ctx.desk, desk_root: ctx.desk,
    end_reason: "complete", ended_at: END, plugins: [], updated_at: new Date().toISOString(), ...overrides,
  }
}

test("derive-run sends codex-cli markers to the Codex deriver, with the home found from the rollout's folder", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = codexMarker(ctx)
  const seen = []
  const spy = async (input) => {
    seen.push(input)
    return deriveCodexSession(input)
  }
  const claude = async () => assert.fail("claude must not derive a codex marker")
  const copilot = async () => assert.fail("copilot must not derive a codex marker")
  assert.deepEqual(await deriveMarker(ctx.env, marker, { codex: spy, claude, copilot }), { result: "written", store: STORE })
  assert.deepEqual(seen.map((input) => [input.rolloutPath, input.codexHome, input.endReason]), [[marker.log_path, path.join(ctx.base, ".codex"), "complete"]])
  const file = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `codex-cli-${marker.session_id}.json`)
  const bytes = readFileSync(file, "utf8")
  assert.equal(validateLocalFacts(JSON.parse(bytes)).ok, true)
  assert.equal(bytes.includes(RUN_SENTINEL), false)
  assert.equal(JSON.parse(bytes).session.host, "codex-cli")
}))

test("derive-run lets the deriver resolve the home when the rollout is not under a sessions folder", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = codexMarker(ctx)
  const moved = path.join(ctx.base, "elsewhere", "rollout.jsonl")
  mkdirSync(path.dirname(moved), { recursive: true })
  writeFileSync(moved, readFileSync(marker.log_path))
  const seen = []
  const spy = async (input) => {
    seen.push(input.codexHome)
    return deriveCodexSession(input)
  }
  assert.equal((await deriveMarker(ctx.env, { ...marker, log_path: moved }, { codex: spy })).result, "written")
  assert.deepEqual(seen, [undefined])
}))

test("a codex marker's end stands until a later model or tool record, then the session reads as still open", () => scratch(async (ctx) => {
  const marker = codexMarker(ctx)
  assert.equal((await reconcileMarker(marker)).ended_at, END)
  const later = new Date(Date.parse(END) + 60000).toISOString()
  writeFileSync(marker.log_path, `${readFileSync(marker.log_path, "utf8")}${JSON.stringify({ timestamp: later, type: "turn_context", payload: { model: ROOT_MODEL } })}\n`)
  assert.equal((await reconcileMarker(marker)).ended_at, null)
  const quiet = codexMarker(ctx)
  writeFileSync(quiet.log_path, `${readFileSync(quiet.log_path, "utf8")}${JSON.stringify({ timestamp: later, type: "event_msg", payload: { type: "token_count" } })}\n`)
  assert.equal((await reconcileMarker(quiet)).ended_at, END, "a token count after the end is not activity")
}))
