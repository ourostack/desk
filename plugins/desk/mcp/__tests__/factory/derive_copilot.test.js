// The Copilot CLI deriver, against synthetic fixtures only. No test reads
// anything under the real `~/.copilot`: each builds its own Copilot home in
// a temp folder, copies in the checked-in `events.jsonl` fixtures and builds
// a synthetic `session-store.db` there with `node:sqlite`.

import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import v8 from "node:v8"
import vm from "node:vm"

import { deriveCopilotSession, __internals__ } from "../../src/factory/derive-copilot.js"
import { normalizeRow, readSessionRefs, readSessionRows, __internals__ as usageInternals } from "../../src/factory/copilot-usage.js"
import { spawnSync } from "node:child_process"
import { validateLocalFacts as validateFacts, validateLocalFactsBytes as validateFactsBytes } from "../../src/factory/schema.js"
import {
  SENTINEL,
  SESSIONS,
  FULL_FINAL_METRICS,
  OTHER_SESSION,
  at,
  buildSessionStore,
  defaultStoreRows,
  eventWriter,
  manySubagentsText,
  usageRow,
  writeLargeEvents,
} from "./fixtures/copilot/make.js"

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "copilot")
const PLUGINS = [{ name: "desk", version: "3.2.0-alpha.22" }]

/** A fresh Copilot home holding the named fixture sessions and, unless `store` is null, a synthetic database. */
function makeHome({ sessions = Object.values(SESSIONS), store = defaultStoreRows(), texts = {} } = {}) {
  const home = mkdtempSync(path.join(os.tmpdir(), "desk-copilot-home-"))
  for (const id of sessions) {
    const dir = path.join(home, "session-state", id)
    mkdirSync(dir, { recursive: true })
    cpSync(path.join(FIXTURES, id, "events.jsonl"), path.join(dir, "events.jsonl"))
    cpSync(path.join(FIXTURES, id, "workspace.yaml"), path.join(dir, "workspace.yaml"))
  }
  for (const [id, text] of Object.entries(texts)) {
    const dir = path.join(home, "session-state", id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "events.jsonl"), text)
  }
  if (store !== null) buildSessionStore(path.join(home, "session-store.db"), store)
  return home
}

function derive(home, sessionId, overrides = {}) {
  return deriveCopilotSession({
    sessionId,
    copilotHome: home,
    plugins: PLUGINS,
    endReason: "complete",
    ...overrides,
  })
}

function assertValid(facts) {
  const result = validateFacts(facts)
  assert.deepEqual(result.errors, [], "facts must always pass validateFacts")
  assert.equal(validateFactsBytes(JSON.stringify(facts)).ok, true, "the canonical bytes must pass too")
}

function intervalsOf(facts, kind) {
  return facts.intervals.filter((interval) => interval.kind === kind)
}

function span(start, end) {
  return { start: at(start), end: at(end) }
}

// ---------------------------------------------------------------------------
// Missing and unusable sources.
// ---------------------------------------------------------------------------

test("a missing events log returns log_missing", async () => {
  const home = makeHome({ sessions: [], store: null })
  try {
    assert.deepEqual(await derive(home, SESSIONS.full), { facts: null, events: null, reason: "log_missing" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("an events log with no session.start envelope is source_unreadable, never invented", async () => {
  const home = makeHome({ sessions: [SESSIONS.noEnvelope], store: null })
  try {
    assert.deepEqual(await derive(home, SESSIONS.noEnvelope), { facts: null, events: null, reason: "source_unreadable" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The full session.
// ---------------------------------------------------------------------------

test("the full session derives one valid session across three resumes and four shutdowns", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    assertValid(facts)
    assert.deepEqual(facts.session, {
      host: "copilot-cli",
      id: SESSIONS.full,
      host_version: "1.0.88",
      entrypoint: "cli",
      started_at: at(0),
      ended_at: at(99),
      end_reason: "complete",
      derived_through: at(99),
    })
    assert.equal(facts.schema, "desk.factory.local/1")
    assert.equal(Object.hasOwn(facts, "contributor"), false, "local facts carry no contributor")
    assert.deepEqual(facts.jobs, [])
    assert.deepEqual(intervalsOf(facts, "turn").map(({ start, end }) => ({ start, end })), [span(3, 43), span(45, 46), span(47, 48), span(61, 74), span(75.4, 75.6), span(91, 92), span(96, 97)])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("usage comes from the last shutdown when one exists, never added to the database rows", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    const expected = Object.keys(FULL_FINAL_METRICS).sort().map((id) => {
      const metric = FULL_FINAL_METRICS[id]
      return {
        id,
        requests: metric.requests.count,
        tokens: {
          input: metric.usage.inputTokens,
          output: metric.usage.outputTokens,
          cache_read: metric.usage.cacheReadTokens,
          cache_write: metric.usage.cacheWriteTokens,
          reasoning: metric.usage.reasoningTokens ?? null,
        },
      }
    })
    assert.deepEqual(facts.models, expected)
    assert.ok(!JSON.stringify(facts).includes("999999"), "the database row of this session was not added")
    assert.equal(facts.unavailable.some((entry) => entry.field === "tokens"), false)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("usage comes from the database rows of this session only when there is no shutdown", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.noShutdown, { endReason: null })
    assertValid(facts)
    assert.deepEqual(facts.models, [
      { id: "claude-opus-5-5", requests: 2, tokens: { input: 300, output: 20, cache_read: 2000, cache_write: 100, reasoning: null } },
      { id: "gpt-5.2", requests: 1, tokens: { input: 100, output: 10, cache_read: 1000, cache_write: 50, reasoning: 3 } },
    ])
    assert.ok(!JSON.stringify(facts).includes("555555"), "another session's rows never leak in")
    assert.deepEqual(
      facts.unavailable.filter((entry) => entry.field === "tokens" || entry.field === "models"),
      [{ field: "models", reason: "source_unreadable" }, { field: "tokens", reason: "source_unreadable" }],
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("with neither a shutdown nor database rows, tokens are unavailable, not zero", async () => {
  const home = makeHome({ store: null })
  try {
    const { facts } = await derive(home, SESSIONS.noUsage)
    assertValid(facts)
    assert.deepEqual(facts.models, [])
    assert.deepEqual(facts.agents, [{ n: 0, parent: null, model: "unknown" }])
    assert.deepEqual(facts.unavailable, [
      { field: "tokens", reason: "session_open" },
      { field: "commits", reason: "log_missing" },
      { field: "ci_runs", reason: "not_collected_in_slice_1" },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("tool outcomes: exit code 1 is an error, a failure is an error, a denial is denied", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    const tools = intervalsOf(facts, "tool").map(({ agent, tool, outcome, start, end }) => ({ agent, tool, outcome, start, end }))
    assert.deepEqual(tools, [
      { agent: 0, tool: "shell", outcome: "error", ...span(5, 7) },
      { agent: 0, tool: "shell", outcome: "ok", ...span(8, 9) },
      { agent: 0, tool: "edit", outcome: "ok", ...span(10, 11) },
      { agent: 0, tool: "edit", outcome: "error", ...span(12, 13) },
      { agent: 0, tool: "edit", outcome: "ok", ...span(14, 15) },
      { agent: 0, tool: "read", outcome: "denied", ...span(16, 21) },
      { agent: 0, tool: "shell", outcome: "ok", ...span(22, 24) },
      { agent: 0, tool: "desk", outcome: "ok", ...span(25, 26) },
      { agent: 0, tool: "desk", outcome: "error", ...span(27, 27.5) },
      { agent: 0, tool: "desk", outcome: "ok", ...span(28, 28.5) },
      { agent: 0, tool: "mcp", outcome: "ok", ...span(28.6, 28.8) },
      { agent: 1, tool: "search", outcome: "ok", ...span(32, 33) },
      { agent: 2, tool: "read", outcome: "ok", ...span(36, 37) },
    ])
    assert.deepEqual(facts.counts, {
      tool_calls: { shell: 3, edit: 3, read: 2, desk: 3, mcp: 1, agent: 2, search: 1 },
      tool_failures: { shell: 1, edit: 1, read: 1, desk: 1 },
      tool_retries: 3,
      api_retries: 4,
      compactions: 1,
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("a permission answered by a human is a wait on the asking agent; an unattended fallback is not", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    assert.deepEqual(intervalsOf(facts, "permission_wait"), [
      { kind: "permission_wait", agent: 0, ...span(16, 20) },
      { kind: "permission_wait", agent: 1, ...span(32.2, 32.6) },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("human waits run from an interaction's end to the next human prompt, never across a resume", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    // Not after the inter-agent (31.2), autopilot (46.5, 48.4), scheduled
    // (48.2) or skill-injected (48.6) messages, and not across the resumes
    // at 55, 80 and 94.
    assert.deepEqual(intervalsOf(facts, "human_wait"), [
      { kind: "human_wait", agent: 0, ...span(43, 44) },
      { kind: "human_wait", agent: 0, ...span(74, 75.2) },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("subagents get the next agent numbers, their own tools, their model and their parent", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    assert.deepEqual(facts.agents, [
      { n: 0, parent: null, model: "claude-opus-5-5" },
      { n: 1, parent: 0, model: "claude-sonnet-5" },
      { n: 2, parent: 1, model: "gpt-5.2" },
    ])
    assert.deepEqual(intervalsOf(facts, "subagent"), [
      { kind: "subagent", agent: 0, ...span(31, 40) },
      { kind: "subagent", agent: 1, ...span(35, 38) },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("API retries under both event spellings, and compactions", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    assert.deepEqual(intervalsOf(facts, "api_retry"), [
      { kind: "api_retry", agent: 0, ...span(62, 63) },
      { kind: "api_retry", agent: 0, ...span(64, 65) },
      { kind: "api_retry", agent: 0, ...span(66, 67) },
    ])
    assert.deepEqual(intervalsOf(facts, "compaction"), [{ kind: "compaction", agent: 0, ...span(69, 72) }])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("plugins merge the marker's list with skill.invoked plugin versions", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.full)
    assert.deepEqual(facts.plugins, [
      { name: "desk", version: "3.2.0-alpha.22" },
      { name: "superpowers", version: "5.1.0" },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("refs come from this session's session_refs rows, validated", async () => {
  const home = makeHome()
  try {
    const { facts, events } = await derive(home, SESSIONS.full)
    assert.deepEqual(facts.refs, {
      prs: [
        { repo: "ourostack/desk", number: 12 },
        { repo: "ourostack/factory", number: 3 },
      ],
      commits: [
        { repo: "ourostack/desk", sha: "abcdef0000000000000000000000000000000001" },
        { repo: "ourostack/desk", sha: "fc6ea8a0000000000000000000000000000000aa" },
      ],
    })
    assert.deepEqual(events.commitShas, ["abcdef0000000000000000000000000000000001", "fc6ea8a0000000000000000000000000000000aa"])
    assert.ok(!JSON.stringify(facts).includes(OTHER_SESSION))
    assert.ok(!JSON.stringify(facts).includes("ourostack/secret"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("binding events: Desk task tools with track and slug, and only successful file writes", async () => {
  const home = makeHome()
  try {
    const { events } = await derive(home, SESSIONS.full)
    assert.deepEqual(events.deskToolCalls, [
      { at: at(25), name: "desk-task_update", track: `${SENTINEL}-track`, slug: `${SENTINEL}-slug`, person: null, status: `${SENTINEL}-status`, ok: true },
      { at: at(27), name: "desk-task_create", track: `${SENTINEL}-track`, slug: `${SENTINEL}-other`, person: `${SENTINEL}-person`, status: null, ok: false },
    ])
    assert.deepEqual(events.fileWrites, [
      { at: at(10), path: `/tmp/${SENTINEL}/desk/eng/m3-3/task.md` },
      { at: at(14), path: `/tmp/${SENTINEL}/desk/eng/m3-3/notes.md` },
      { at: at(14), path: `/tmp/${SENTINEL}/desk/eng/m3-3/task.md` },
      { at: at(14), path: `/tmp/${SENTINEL}/desk/eng/m3-3/old.md` },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("no content from any fixture field ever reaches the facts", async () => {
  const home = makeHome()
  try {
    for (const [sessionId, endReason] of [[SESSIONS.full, "complete"], [SESSIONS.noShutdown, null], [SESSIONS.noUsage, "user_exit"]]) {
      const { facts, events } = await derive(home, sessionId, { endReason })
      assertValid(facts)
      assert.ok(!JSON.stringify(facts).includes(SENTINEL), `${sessionId}: the sentinel leaked into facts`)
      if (sessionId === SESSIONS.full) assert.ok(JSON.stringify(events).includes(SENTINEL), "the fixture really planted the sentinel")
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// The open session.
// ---------------------------------------------------------------------------

test("an open session: open turn, orphan tool, failed subagent, truncated last line", async () => {
  const home = makeHome()
  try {
    const { facts } = await derive(home, SESSIONS.noShutdown, { endReason: null, entrypoint: "launcher" })
    assertValid(facts)
    assert.equal(facts.session.entrypoint, "launcher")
    assert.equal(facts.session.host_version, "1.0.85")
    assert.equal(facts.session.ended_at, null)
    assert.equal(facts.session.end_reason, null)
    assert.equal(facts.session.derived_through, at(22))
    assert.deepEqual(facts.agents, [{ n: 0, parent: null, model: "claude-opus-5-5" }, { n: 1, parent: 0, model: "unknown" }])
    assert.deepEqual(intervalsOf(facts, "subagent"), [{ kind: "subagent", agent: 0, ...span(6, 8) }])
    assert.deepEqual(intervalsOf(facts, "turn"), [{ kind: "turn", agent: 0, ...span(2, 11) }])
    assert.deepEqual(intervalsOf(facts, "human_wait"), [{ kind: "human_wait", agent: 0, ...span(11, 20) }])
    assert.deepEqual(facts.counts.tool_calls, { shell: 1, agent: 1 })
    assert.deepEqual(facts.counts.tool_failures, { agent: 1 })
    assert.deepEqual(facts.unavailable, [
      { field: "models", reason: "source_unreadable" },
      { field: "tokens", reason: "source_unreadable" },
      { field: "ended_at", reason: "session_open" },
      { field: "turns", reason: "log_truncated" },
      { field: "tool_durations", reason: "session_open" },
      { field: "turns", reason: "session_open" },
      { field: "ci_runs", reason: "not_collected_in_slice_1" },
    ])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Streaming and memory.
// ---------------------------------------------------------------------------

test("a 1,000,000-line events log derives in a single pass with bounded memory", { timeout: 600_000 }, async (t) => {
  const home = mkdtempSync(path.join(os.tmpdir(), "desk-copilot-large-"))
  try {
    const sessionId = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d"
    const dir = path.join(home, "session-state", sessionId)
    mkdirSync(dir, { recursive: true })
    const written = writeLargeEvents(path.join(dir, "events.jsonl"), { sessionId, lines: 1_000_000 })
    assert.ok(written >= 1_000_000)

    // Live heap, not garbage: a full collection runs before every sample, so
    // the bound measures what the deriver holds rather than when V8 happened
    // to collect the lines it already let go of.
    v8.setFlagsFromString("--expose-gc")
    const gc = vm.runInNewContext("gc")
    gc()
    const baseline = process.memoryUsage().heapUsed
    let peak = baseline
    const sample = () => {
      gc()
      peak = Math.max(peak, process.memoryUsage().heapUsed)
    }
    const sampler = setInterval(sample, 100)
    const started = Date.now()
    let result
    try {
      result = await derive(home, sessionId)
    } finally {
      clearInterval(sampler)
    }
    sample()
    const growth = peak - baseline
    t.diagnostic(`live heap growth ${(growth / 1024 / 1024).toFixed(1)} MiB over ${written} lines in ${Date.now() - started} ms`)
    assert.ok(growth < 64 * 1024 * 1024, `heap grew ${Math.round(growth / 1024 / 1024)} MiB`)

    const { facts } = result
    assertValid(facts)
    assert.equal(facts.intervals.length, 100000, "intervals are capped at the schema limit")
    assert.ok(facts.unavailable.some((entry) => entry.field === "tool_durations" && entry.reason === "capped"))
    assert.ok(facts.counts.tool_calls.shell >= 399000, "every call is still counted past the interval cap")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Unexpected shapes. None may throw or produce facts that fail validation.
// ---------------------------------------------------------------------------

const EDGE = "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e"

function textOf(events) {
  return `${events.map((event) => (typeof event === "string" ? event : JSON.stringify(event))).join("\n")}\n`
}

function start(ev, seconds = 0, copilotVersion = "1.0.88") {
  return ev("session.start", seconds, { sessionId: EDGE, copilotVersion, producer: "copilot-agent", context: { cwd: `/tmp/${SENTINEL}` } })
}

async function deriveText(events, { store = null, ...overrides } = {}) {
  const home = makeHome({ sessions: [], store, texts: { [EDGE]: textOf(events) } })
  try {
    const result = await derive(home, EDGE, overrides)
    if (result.facts !== null) {
      assertValid(result.facts)
      assert.ok(!JSON.stringify(result.facts).includes(SENTINEL))
    }
    return result
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("a session id that is not a UUID is refused before any path is built", async () => {
  for (const sessionId of ["../../etc", 42, undefined]) {
    assert.deepEqual(await derive("/nonexistent", sessionId), { facts: null, events: null, reason: "source_unreadable" })
  }
})

test("the Copilot home defaults to COPILOT_HOME, then to ~/.copilot", async () => {
  const home = makeHome({ sessions: [SESSIONS.noUsage], store: null })
  const saved = { COPILOT_HOME: process.env.COPILOT_HOME, HOME: process.env.HOME }
  try {
    process.env.COPILOT_HOME = home
    assert.equal((await derive(undefined, SESSIONS.noUsage)).facts.session.id, SESSIONS.noUsage)
    delete process.env.COPILOT_HOME
    // `os.homedir()` follows HOME, so the default resolves inside a temp folder, never the real one.
    const fakeHome = mkdtempSync(path.join(os.tmpdir(), "desk-copilot-user-"))
    process.env.HOME = fakeHome
    mkdirSync(path.join(fakeHome, ".copilot", "session-state", SESSIONS.noUsage), { recursive: true })
    cpSync(path.join(FIXTURES, SESSIONS.noUsage, "events.jsonl"), path.join(fakeHome, ".copilot", "session-state", SESSIONS.noUsage, "events.jsonl"))
    assert.equal((await derive(undefined, SESSIONS.noUsage)).facts.session.id, SESSIONS.noUsage)
    rmSync(fakeHome, { recursive: true, force: true })
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(home, { recursive: true, force: true })
  }
})

test("an events path that cannot be read as a file is source_unreadable", async () => {
  const home = makeHome({ sessions: [], store: null })
  try {
    mkdirSync(path.join(home, "session-state", EDGE, "events.jsonl"), { recursive: true })
    assert.deepEqual(await derive(home, EDGE), { facts: null, events: null, reason: "source_unreadable" })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("envelope edge cases: a bad timestamp, a bad version, a second start", async () => {
  const ev = eventWriter()
  const badTime = start(ev, 0)
  badTime.timestamp = `yesterday ${SENTINEL}`
  const { facts } = await deriveText([badTime, start(ev, 1, `1.0-${SENTINEL} x`), start(ev, 2, "1.0.90"), start(ev, 3, "1.0.91")])
  assert.equal(facts.session.host_version, "1.0.90")
  assert.equal(facts.session.started_at, at(1))
})

test("odd turn, tool, permission, subagent and compaction shapes are skipped or flagged, never thrown", async () => {
  const ev = eventWriter()
  const badStart = ev("assistant.turn_start", 5, { turnId: "bad" })
  badStart.timestamp = SENTINEL
  const badEditStart = ev("tool.execution_start", 60, { toolCallId: "e-bad", toolName: "edit", arguments: { path: `/tmp/${SENTINEL}` } })
  badEditStart.timestamp = null
  const lines = [
    start(ev),
    ev("assistant.turn_start", 1, {}),
    ev("assistant.turn_end", 2, {}),
    ev("assistant.turn_end", 3, { turnId: "never-started" }),
    badStart,
    ev("assistant.turn_end", 6, { turnId: "bad" }),
    ev("tool.execution_start", 10, { toolName: "bash" }),
    ev("tool.execution_complete", 11, { success: true }),
    ev("tool.execution_complete", 12, { toolCallId: "unknown", success: true }),
    // Completes before it started: dropped as unreadable, still counted.
    ev("tool.execution_start", 20, { toolCallId: "backwards", toolName: "view", arguments: { path: SENTINEL } }),
    ev("tool.execution_complete", 19, { toolCallId: "backwards", success: true }),
    ev("tool.execution_start", 21, { toolCallId: "orphan-parent", toolName: "view", parentToolCallId: "no-such-subagent" }),
    ev("tool.execution_complete", 22, { toolCallId: "orphan-parent", success: true }),
    // File-write shapes that yield no path.
    ev("tool.execution_start", 30, { toolCallId: "w1", toolName: "create", arguments: { file_text: SENTINEL } }),
    ev("tool.execution_complete", 31, { toolCallId: "w1", success: true }),
    ev("tool.execution_start", 32, { toolCallId: "w2", toolName: "edit", arguments: `path ${SENTINEL}` }),
    ev("tool.execution_complete", 33, { toolCallId: "w2", success: true }),
    ev("tool.execution_start", 34, { toolCallId: "w3", toolName: "apply_patch", arguments: `*** Begin Patch\n*** Update File: /tmp/${SENTINEL}/raw.md\r\n*** End Patch` }),
    ev("tool.execution_complete", 35, { toolCallId: "w3", success: true }),
    ev("tool.execution_start", 36, { toolCallId: "w4", toolName: "apply_patch", arguments: { input: `no headers ${SENTINEL}` } }),
    ev("tool.execution_complete", 37, { toolCallId: "w4", success: true }),
    ev("tool.execution_start", 38, { toolCallId: "w5", toolName: "apply_patch", arguments: [SENTINEL] }),
    ev("tool.execution_complete", 39, { toolCallId: "w5", success: true }),
    ev("tool.execution_start", 40, { toolCallId: "w6", toolName: "desk-task_update", arguments: `track ${SENTINEL}` }),
    ev("tool.execution_complete", 41, { toolCallId: "w6", success: true }),
    ev("tool.execution_start", 42, { toolCallId: "w7", arguments: { track: "eng", slug: "x" } }),
    ev("tool.execution_complete", 43, { toolCallId: "w7", success: true }),
    badEditStart,
    ev("tool.execution_complete", 61, { toolCallId: "e-bad", success: true }),
    ev("permission.requested", 50, {}),
    ev("permission.completed", 51, { decisionSource: "human_response" }),
    ev("permission.completed", 52, { requestId: "never", decisionSource: "human_response" }),
    ev("subagent.started", 70, {}),
    ev("subagent.started", 71, { toolCallId: "sa" }),
    ev("subagent.started", 72, { toolCallId: "sa", model: "gpt-5.2" }),
    ev("subagent.completed", 73, {}),
    ev("subagent.completed", 74, { toolCallId: "never" }),
    ev("subagent.completed", 75, { toolCallId: "sa" }),
    ev("session.compaction_complete", 80, { success: true, summaryContent: SENTINEL }),
    ev("session.error", 81, { statusCode: "503", message: SENTINEL }),
    ev("model.turn_retry", 82, { turnId: "x", reason: SENTINEL }),
    ev("model.call_failure", 82.5, { statusCode: 400, errorMessage: SENTINEL }),
    ev("model.call_failure", 83, { failureKind: "transport", errorMessage: SENTINEL }),
    ev("model.model_call_failure", 84, { statusCode: 502, errorMessage: SENTINEL }),
    ev("model.turn_retry", 85, { turnId: "x" }),
    ev("skill.invoked", 86, { name: SENTINEL, pluginName: `Bad ${SENTINEL}`, pluginVersion: "1.0.0" }),
    ev("skill.invoked", 87, { name: SENTINEL, pluginName: "extra", pluginVersion: "1.0.0" }),
    ev("skill.invoked", 88, { name: SENTINEL, pluginName: "extra", pluginVersion: "1.0.0" }),
    ev("skill.invoked", 88.5, { name: SENTINEL, pluginName: "extra" }),
    ev(`custom.${SENTINEL}`, 89, { note: SENTINEL }),
    { type: "tool.execution_start", timestamp: at(90), data: SENTINEL },
    { type: "constructor", timestamp: at(91), data: {} },
    `{"broken ${SENTINEL}`,
    ev("user.message", 92, { content: SENTINEL }),
  ]
  const { facts, events } = await deriveText(lines)
  assert.deepEqual(facts.agents, [{ n: 0, parent: null, model: "unknown" }, { n: 1, parent: 0, model: "unknown" }])
  assert.deepEqual(intervalsOf(facts, "subagent"), [{ kind: "subagent", agent: 0, ...span(71, 75) }])
  assert.deepEqual(intervalsOf(facts, "tool").map(({ agent, tool }) => ({ agent, tool })), [
    { agent: 0, tool: "read" },
    { agent: 0, tool: "edit" },
    { agent: 0, tool: "edit" },
    { agent: 0, tool: "edit" },
    { agent: 0, tool: "edit" },
    { agent: 0, tool: "edit" },
    { agent: 0, tool: "desk" },
    { agent: 0, tool: "other" },
  ])
  assert.equal(intervalsOf(facts, "compaction").length, 0)
  assert.equal(facts.counts.compactions, 1)
  assert.equal(facts.counts.api_retries, 2)
  assert.deepEqual(intervalsOf(facts, "api_retry"), [{ kind: "api_retry", agent: 0, ...span(83, 85) }])
  assert.equal(intervalsOf(facts, "permission_wait").length, 0)
  assert.deepEqual(facts.plugins, [...PLUGINS, { name: "extra", version: "1.0.0" }])
  assert.deepEqual(events.fileWrites, [{ at: at(34), path: `/tmp/${SENTINEL}/raw.md` }])
  assert.deepEqual(events.deskToolCalls, [])
  assert.deepEqual(facts.unavailable, [
    { field: "tool_durations", reason: "source_unreadable" },
    { field: "plugins", reason: "source_unreadable" },
    { field: "turns", reason: "source_unreadable" },
    { field: "tokens", reason: "session_open" },
    { field: "commits", reason: "log_missing" },
    { field: "ci_runs", reason: "not_collected_in_slice_1" },
  ])
})

test("shutdown metrics of odd shapes: a non-object, a bad model key, missing counts", async () => {
  const ev = eventWriter()
  const metrics = {
    [`bad model ${SENTINEL}`]: { requests: { count: 1 }, usage: {} },
    "model-a": "not an object",
    "model-b": { requests: { count: -1 }, usage: { inputTokens: 1.5, outputTokens: 2 } },
    "model-c": { usage: "nope" },
  }
  let { facts } = await deriveText([start(ev), ev("session.shutdown", 1, { modelMetrics: metrics, codeChanges: { filesModified: [SENTINEL] } })])
  const nullTokens = { input: null, output: null, cache_read: null, cache_write: null, reasoning: null }
  assert.deepEqual(facts.models, [
    { id: "model-a", requests: null, tokens: nullTokens },
    { id: "model-b", requests: null, tokens: { ...nullTokens, output: 2 } },
    { id: "model-c", requests: null, tokens: nullTokens },
  ])
  assert.equal(facts.agents[0].model, "model-a")
  assert.ok(facts.unavailable.some((entry) => entry.field === "models" && entry.reason === "source_unreadable"))

  ;({ facts } = await deriveText([start(ev), ev("session.shutdown", 1, { modelMetrics: SENTINEL })]))
  assert.deepEqual(facts.models, [])
  assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "source_unreadable"))
})

test("more than 32 models, 64 plugins or 2000 commits are trimmed with capped", async () => {
  const ev = eventWriter()
  const metrics = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`model-${String(index).padStart(2, "0")}`, { requests: { count: index }, usage: {} }]))
  const plugins = Array.from({ length: 65 }, (_, index) => ({ name: `plugin-${index}`, version: "1.0.0" }))
  const commits = Array.from({ length: 2001 }, (_, index) => [EDGE, "commit", index.toString(16).padStart(40, "0")])
  const { facts } = await deriveText([start(ev), ev("session.shutdown", 1, { modelMetrics: metrics })], {
    plugins,
    store: { sessions: [EDGE], usage: [], refs: commits },
  })
  assert.equal(facts.models.length, 32)
  assert.equal(facts.plugins.length, 64)
  assert.equal(facts.refs.commits.length, 2000)
  for (const field of ["models", "plugins", "commits"]) {
    assert.ok(facts.unavailable.some((entry) => entry.field === field && entry.reason === "capped"), field)
    assert.equal(facts.unavailable.some((entry) => entry.field === field && entry.reason === "log_truncated"), false, field)
  }
})

test("invalid marker plugins are dropped; a non-array marker list is empty", async () => {
  const ev = eventWriter()
  let { facts } = await deriveText([start(ev)], { plugins: [{ name: SENTINEL, version: "1.0.0" }, null, { name: "ok", version: SENTINEL }, { name: "ok", version: "1.0.0" }] })
  assert.deepEqual(facts.plugins, [{ name: "ok", version: "1.0.0" }])
  assert.ok(facts.unavailable.some((entry) => entry.field === "plugins" && entry.reason === "source_unreadable"))
  ;({ facts } = await deriveText([start(ev)], { plugins: SENTINEL }))
  assert.deepEqual(facts.plugins, [])
})

test("an unreadable session database flags tokens and commits as source_unreadable", async () => {
  const home = makeHome({ sessions: [SESSIONS.noShutdown], store: null })
  try {
    writeFileSync(path.join(home, "session-store.db"), `not a database ${SENTINEL}\n`)
    const { facts } = await derive(home, SESSIONS.noShutdown, { endReason: null })
    assertValid(facts)
    assert.deepEqual(facts.models, [])
    assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "source_unreadable"))
    assert.ok(facts.unavailable.some((entry) => entry.field === "commits" && entry.reason === "source_unreadable"))
    assert.ok(!facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "session_open"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("database token sums that would exceed a safe integer become null, not wrong", async () => {
  const ev = eventWriter()
  const big = 2 ** 52
  const { facts } = await deriveText([start(ev)], {
    store: { sessions: [EDGE], usage: [usageRow(EDGE, "gpt-5.2", { input_tokens: big }), usageRow(EDGE, "gpt-5.2", { input_tokens: big })], refs: [[EDGE, "pr", null], [EDGE, "pr", "ourostack/desk#99999999999999999999"]] },
  })
  assert.deepEqual(facts.models, [{ id: "gpt-5.2", requests: 2, tokens: { input: null, output: 20, cache_read: 2000, cache_write: 100, reasoning: null } }])
  assert.deepEqual(facts.refs.prs, [])
})

test("the agent cap: past 9999 subagents, later ones are dropped and their tools fall back to agent 0", async () => {
  const home = makeHome({ sessions: [], store: null, texts: { [EDGE]: manySubagentsText(EDGE, 10000) } })
  try {
    const { facts } = await derive(home, EDGE)
    assertValid(facts)
    assert.equal(facts.agents.length, 10000)
    assert.deepEqual(intervalsOf(facts, "tool").map(({ agent }) => agent), [0])
    assert.ok(facts.unavailable.some((entry) => entry.field === "turns" && entry.reason === "capped"))
    assert.ok(facts.unavailable.some((entry) => entry.field === "tool_durations" && entry.reason === "log_truncated"))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the sort comparators order every direction", () => {
  const { compareByStart, compareModels, comparePrs } = __internals__
  assert.equal(compareByStart({ start: at(1) }, { start: at(2) }), -1)
  assert.equal(compareByStart({ start: at(2) }, { start: at(1) }), 1)
  assert.equal(compareByStart({ start: at(1) }, { start: at(1) }), 0)
  assert.equal(compareModels({ id: "a" }, { id: "b" }), -1)
  assert.equal(compareModels({ id: "b" }, { id: "a" }), 1)
  assert.equal(comparePrs({ repo: "a/x", number: 2 }, { repo: "b/x", number: 1 }), -1)
  assert.equal(comparePrs({ repo: "b/x", number: 1 }, { repo: "a/x", number: 2 }), 1)
  assert.equal(comparePrs({ repo: "a/x", number: 1 }, { repo: "a/x", number: 2 }), -1)
})

test("readSessionRefs reads the ambient COPILOT_HOME when no environment is passed", () => {
  const home = makeHome({ sessions: [] })
  const saved = process.env.COPILOT_HOME
  try {
    process.env.COPILOT_HOME = home
    assert.deepEqual(readSessionRefs({ sessionId: OTHER_SESSION }).rows.map((row) => row.ref_type), ["pr", "commit"])
  } finally {
    if (saved === undefined) delete process.env.COPILOT_HOME
    else process.env.COPILOT_HOME = saved
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Fix round 1: resumes, stale shutdowns, attribution and the factory reader.
// ---------------------------------------------------------------------------

test("a resume drops what the dead lifetime left open, so later waits still count and none spans the resume", async () => {
  const ev = eventWriter()
  const lines = [
    start(ev),
    ev("user.message", 1, { content: SENTINEL }),
    ev("assistant.turn_start", 2, { turnId: "5", interactionId: `${SENTINEL}-a` }),
    ev("tool.execution_start", 3, { toolCallId: "lost", toolName: "bash", arguments: { command: SENTINEL } }),
    ev("permission.requested", 4, { requestId: "p-lost" }),
    ev("model.call_failure", 5, { statusCode: 500, errorMessage: SENTINEL }),
    ev("session.compaction_start", 6, {}),
    ev("session.resume", 50, { resumeTime: at(50), eventCount: 7 }),
    ev("permission.completed", 51, { requestId: "p-lost", decisionSource: "human_response" }),
    ev("model.turn_retry", 51.5, { turnId: "0" }),
    ev("session.compaction_complete", 51.8, { success: true }),
    ev("user.message", 52, { content: SENTINEL }),
    ev("assistant.turn_start", 53, { turnId: "0", interactionId: `${SENTINEL}-b` }),
    ev("permission.requested", 54, { requestId: "p1" }),
    ev("permission.completed", 55, { requestId: "p1", decisionSource: "human_response" }),
    ev("permission.requested", 56, { requestId: "p2" }),
    ev("permission.completed", 57, { requestId: "p2", toolCallId: "gone", decisionSource: "human_response" }),
    ev("assistant.turn_end", 60, { turnId: "0" }),
    ev("user.message", 70, { content: SENTINEL }),
    ev("assistant.turn_start", 71, { turnId: "1", interactionId: `${SENTINEL}-c` }),
    ev("assistant.turn_end", 80, { turnId: "1" }),
    ev("user.message", 90, { content: SENTINEL }),
    ev("assistant.turn_start", 91, { turnId: "2" }),
    ev("assistant.turn_end", 95, { turnId: "2" }),
  ]
  const { facts } = await deriveText(lines)
  assert.deepEqual(intervalsOf(facts, "turn").map(({ start: s, end }) => ({ start: s, end })), [span(53, 60), span(71, 80), span(91, 95)])
  assert.deepEqual(intervalsOf(facts, "human_wait").map(({ start: s, end }) => ({ start: s, end })), [span(60, 70), span(80, 90)])
  assert.deepEqual(intervalsOf(facts, "permission_wait"), [
    { kind: "permission_wait", agent: 0, ...span(54, 55) },
    { kind: "permission_wait", agent: 0, ...span(56, 57) },
  ])
  assert.deepEqual(intervalsOf(facts, "api_retry"), [])
  assert.deepEqual(intervalsOf(facts, "compaction"), [])
  assert.equal(facts.counts.api_retries, 1)
  assert.equal(facts.counts.compactions, 1)
  assert.equal(facts.counts.tool_calls.shell, undefined, "the lost call never completed")
  for (const field of ["turns", "tool_durations"]) {
    assert.ok(facts.unavailable.some((entry) => entry.field === field && entry.reason === "log_truncated"), field)
  }
})

const STALE_METRICS = { "claude-opus-5-5": { requests: { count: 5 }, usage: { inputTokens: 50, outputTokens: 5, cacheReadTokens: 500, cacheWriteTokens: 55 } } }
const STALE_MODELS = [{ id: "claude-opus-5-5", requests: 5, tokens: { input: 50, output: 5, cache_read: 500, cache_write: 55, reasoning: null } }]

test("a shutdown followed by a resume is stale: the database rows are used alone when any exist", async () => {
  const ev = eventWriter()
  const { facts } = await deriveText([start(ev), ev("session.shutdown", 10, { modelMetrics: STALE_METRICS }), ev("session.resume", 20, {})], {
    store: { sessions: [EDGE], usage: [usageRow(EDGE, "gpt-5.2"), usageRow(EDGE, "gpt-5.2")], refs: [] },
  })
  assert.deepEqual(facts.models, [{ id: "gpt-5.2", requests: 2, tokens: { input: 200, output: 20, cache_read: 2000, cache_write: 100, reasoning: null } }])
  assert.equal(facts.unavailable.some((entry) => entry.field === "tokens"), false)
})

test("a stale shutdown with no database rows keeps its totals and says they are incomplete", async () => {
  const ev = eventWriter()
  const lines = [start(ev), ev("session.shutdown", 10, { modelMetrics: STALE_METRICS }), ev("assistant.turn_start", 22, { turnId: "0" }), ev("assistant.turn_end", 40, { turnId: "0" })]
  let { facts } = await deriveText(lines, { endReason: null })
  assert.deepEqual(facts.models, STALE_MODELS)
  assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "session_open"))
  ;({ facts } = await deriveText([start(ev), ev("session.shutdown", 10, { modelMetrics: STALE_METRICS }), ev("session.resume", 20, {})], { endReason: "complete" }))
  assert.deepEqual(facts.models, STALE_MODELS)
  assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "log_truncated"))
})

test("an unreadable subagent interval is flagged under tool_durations, a compaction's under turns", async () => {
  const ev = eventWriter()
  const badSubagent = ev("subagent.started", 2, { toolCallId: "s1", model: "gpt-5.2" })
  badSubagent.timestamp = SENTINEL
  const badCompaction = ev("session.compaction_start", 4, {})
  badCompaction.timestamp = SENTINEL
  const { facts } = await deriveText([start(ev), badSubagent, ev("subagent.completed", 3, { toolCallId: "s1" }), badCompaction, ev("session.compaction_complete", 5, { success: true })])
  assert.deepEqual(facts.unavailable.slice(0, 2), [
    { field: "tool_durations", reason: "source_unreadable" },
    { field: "turns", reason: "source_unreadable" },
  ])
})

test("the factory reader reports a missing, an unreadable or a driverless database without throwing", () => {
  const home = makeHome({ sessions: [] })
  const env = { COPILOT_HOME: home }
  try {
    assert.equal(readSessionRows({ sessionId: OTHER_SESSION, env }).status, "ok")
    assert.deepEqual(readSessionRows({ sessionId: OTHER_SESSION, env: { COPILOT_HOME: path.join(home, "none") } }), { status: "missing", rows: [] })
    const noDriver = () => {
      throw Object.assign(new Error("No such built-in module: node:sqlite"), { code: "ERR_UNKNOWN_BUILTIN_MODULE" })
    }
    assert.deepEqual(readSessionRows({ sessionId: OTHER_SESSION, env, load: noDriver }), { status: "unreadable", rows: [] })
    assert.equal(usageInternals.loadSqlite(noDriver), null)
    rmSync(path.join(home, "session-store.db"))
    mkdirSync(path.join(home, "session-store.db"))
    assert.deepEqual(readSessionRefs({ sessionId: OTHER_SESSION, env }), { status: "unreadable", rows: [] })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("the factory reader's first load of node:sqlite prints nothing", () => {
  const home = makeHome({ sessions: [] })
  try {
    const moduleUrl = new URL("../../src/factory/copilot-usage.js", import.meta.url).href
    const script = `const m = await import(${JSON.stringify(moduleUrl)}); const r = m.readSessionRows({ sessionId: ${JSON.stringify(OTHER_SESSION)}, env: { COPILOT_HOME: ${JSON.stringify(home)} } }); await new Promise((resolve) => setTimeout(resolve, 20)); process.stdout.write(r.status + ":" + r.rows.length)`
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" })
    assert.equal(child.stdout, "ok:1")
    assert.equal(child.stderr, "")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("normalizeRow keeps a missing counter null and refuses rows that are not data", () => {
  const good = { id: 1, model: "gpt-5.2", input_tokens: 1, output_tokens: null, cache_read_tokens: 0, cache_write_tokens: 2, created_at: "2026-09-25 08:00:05" }
  assert.deepEqual(normalizeRow(good), {
    fact: { model: "gpt-5.2", input_tokens: 1, output_tokens: null, cache_read_tokens: 0, cache_write_tokens: 2, reasoning_tokens: null, created_at: "2026-09-25T08:00:05.000Z" },
  })
  assert.deepEqual(normalizeRow({ ...good, id: 2 ** 53 }), { malformed: "unsafe_integer_id" })
  assert.deepEqual(normalizeRow({ ...good, input_tokens: -1 }), { malformed: "invalid_counter" })
  assert.deepEqual(normalizeRow({ ...good, input_tokens: 1.5 }), { malformed: "invalid_counter" })
  assert.deepEqual(normalizeRow({ ...good, created_at: SENTINEL }), { malformed: "invalid_timestamp" })
})

test("with no COPILOT_HOME the factory reader looks under the user's home directory", () => {
  const saved = process.env.HOME
  const fakeHome = mkdtempSync(path.join(os.tmpdir(), "desk-copilot-user-"))
  try {
    // `os.homedir()` follows HOME, so this never looks at the real `~/.copilot`.
    process.env.HOME = fakeHome
    assert.deepEqual(readSessionRows({ sessionId: OTHER_SESSION, env: {} }), { status: "missing", rows: [] })
    mkdirSync(path.join(fakeHome, ".copilot"))
    buildSessionStore(path.join(fakeHome, ".copilot", "session-store.db"))
    assert.equal(readSessionRows({ sessionId: OTHER_SESSION, env: {} }).status, "ok")
  } finally {
    process.env.HOME = saved
    rmSync(fakeHome, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Shell git commit calls (matched to the desk's own commits by time).
// ---------------------------------------------------------------------------

const COMMIT_MESSAGE_SENTINEL = "COMMIT-MESSAGE-SENTINEL-9b1e"

test("only a successful bash or powershell git commit call becomes a shellGitCommits event, with its start, end and the session's directory", async () => {
  const ev = eventWriter()
  const m = COMMIT_MESSAGE_SENTINEL
  const call = (id, seconds, toolName, command) => ev("tool.execution_start", seconds, { toolCallId: id, toolName, arguments: { command, description: m } })
  const done = (id, seconds, data = {}) => ev("tool.execution_complete", seconds, { toolCallId: id, success: true, result: { content: m }, ...data })
  const lines = [
    start(ev),
    call("g1", 1, "bash", `git add -A && git commit -q -m "${m}"`),
    done("g1", 2),
    call("g2", 3, "bash", `git -C /tmp/${SENTINEL}/desk commit -m '${m}'`),
    done("g2", 4, { shellExecution: { exitCode: 0 } }),
    call("g3", 5, "powershell", `Set-Location C:\\${SENTINEL}; git commit -m "${m}"`),
    done("g3", 6),
    call("g4", 7, "bash", `git status ${m}`),
    done("g4", 8),
    call("g5", 9, "read_bash", `git commit -m "${m}"`),
    done("g5", 10),
    call("g6", 11, "bash", `git commit -m "${m}"`),
    // g6 never completes before the resume, which moves the directory.
    ev("session.resume", 12, { context: { cwd: `/tmp/${SENTINEL}/resumed` } }),
    done("g6", 13),
    call("g7", 14, "bash", `git commit -m "${m}"`),
    done("g7", 15),
    ev("session.resume", 16, { context: `not an object ${SENTINEL}` }),
    call("g8", 17, "bash", `git commit -m "${m}"`),
    done("g8", 18),
    ev("session.resume", 19, { context: { cwd: 42 } }),
    call("g9", 20, "bash", { command: `git commit -m "${m}"` }),
    done("g9", 21),
    call("g10", 22, "bash", `git commit -m "${m}"`),
    done("g10", 23),
    call("g11", 24, "bash", `git commit -m "${m}"`),
  ]
  const badTime = call("g12", 25, "bash", `git commit -m "${m}"`)
  badTime.timestamp = `later ${SENTINEL}`
  lines.push(
    badTime,
    done("g12", 26),
    // A failed call, a no-op commit (exit code 1), and a completion with no success flag give none.
    call("g13", 27, "bash", `git commit -m "${m}"`),
    done("g13", 28, { success: false, shellExecution: { exitCode: 1 } }),
    call("g14", 29, "bash", `git commit -m "${m}"`),
    done("g14", 30, { success: true, shellExecution: { exitCode: 1 } }),
    call("g15", 31, "bash", `git commit -m "${m}"`),
    done("g15", 32, { success: undefined }),
  )
  const { facts, events } = await deriveText(lines)
  assert.deepEqual(events.shellGitCommits, [
    { start: at(1), end: at(2), cwd: `/tmp/${SENTINEL}` },
    { start: at(3), end: at(4), cwd: `/tmp/${SENTINEL}/desk` },
    { start: at(5), end: at(6), cwd: `C:\\${SENTINEL}` },
    { start: at(14), end: at(15), cwd: `/tmp/${SENTINEL}/resumed` },
    { start: at(17), end: at(18), cwd: null },
    { start: at(22), end: at(23), cwd: null },
  ])
  assert.ok(!JSON.stringify(facts).includes(COMMIT_MESSAGE_SENTINEL))
  assert.ok(!JSON.stringify(facts).includes(SENTINEL), "the planted directories never reach facts")
  assert.ok(!JSON.stringify(events).includes(COMMIT_MESSAGE_SENTINEL))
  assert.ok(!JSON.stringify(events).includes("git"), "not even the command name is kept")
})

test("a session.start with no readable context leaves the directory unknown", async () => {
  const ev = eventWriter()
  const lines = [
    ev("session.start", 0, { sessionId: EDGE, copilotVersion: "1.0.88", producer: "copilot-agent" }),
    ev("tool.execution_start", 1, { toolCallId: "g1", toolName: "bash", arguments: { command: "git commit -q" } }),
    ev("tool.execution_complete", 2, { toolCallId: "g1", success: true }),
    ev("tool.execution_start", 3, { toolCallId: "g2", toolName: "bash", arguments: { command: "git -C /abs commit -q" } }),
    ev("tool.execution_complete", 4, { toolCallId: "g2", success: true }),
  ]
  const { events } = await deriveText(lines)
  assert.deepEqual(events.shellGitCommits, [{ start: at(1), end: at(2), cwd: null }, { start: at(3), end: at(4), cwd: "/abs" }])
})

test("nativeCommitShas carries this session's session_refs commits, which bind directly", async () => {
  const home = makeHome()
  try {
    const { events } = await derive(home, SESSIONS.full)
    assert.deepEqual(events.nativeCommitShas, ["abcdef0000000000000000000000000000000001", "fc6ea8a0000000000000000000000000000000aa"])
    assert.deepEqual(events.shellGitCommits, [], "the fixture's bash calls hold no git commit")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Commit refs: the session's repository, when there is exactly one.
// ---------------------------------------------------------------------------

const SHA_ONE = "1".repeat(40)

async function commitRepoOf(contexts) {
  const ev = eventWriter()
  const lines = [ev("session.start", 0, { sessionId: EDGE, copilotVersion: "1.0.88", producer: "copilot-agent", context: contexts[0] })]
  contexts.slice(1).forEach((context, index) => lines.push(ev("session.resume", 10 + index, context === undefined ? {} : { context })))
  const { facts } = await deriveText(lines, { store: { sessions: [EDGE], usage: [], refs: [[EDGE, "commit", SHA_ONE]] } })
  assert.equal(facts.refs.commits.length, 1)
  assert.equal(facts.refs.commits[0].sha, SHA_ONE)
  return facts.refs.commits[0].repo
}

test("a session's own commits carry its GitHub repository when the session names exactly one", async () => {
  const github = (repository) => ({ cwd: `/tmp/${SENTINEL}`, repository, hostType: "github" })
  assert.equal(await commitRepoOf([github("octo-org/widgets")]), "octo-org/widgets")
  assert.equal(await commitRepoOf([github("octo-org/widgets"), github("octo-org/widgets"), undefined, { cwd: `/tmp/${SENTINEL}` }]), "octo-org/widgets")
  assert.equal(await commitRepoOf([{ cwd: `/tmp/${SENTINEL}` }, github("octo-org/widgets")]), "octo-org/widgets")
})

test("a commit's repository stays null when the session names none, several, a non-GitHub host or an invalid name", async () => {
  const github = (repository) => ({ cwd: `/tmp/${SENTINEL}`, repository, hostType: "github" })
  assert.equal(await commitRepoOf([{ cwd: `/tmp/${SENTINEL}` }]), null)
  assert.equal(await commitRepoOf([github("octo-org/widgets"), github("octo-org/gadgets")]), null)
  assert.equal(await commitRepoOf([{ cwd: `/tmp/${SENTINEL}`, repository: "octo-org/widgets", hostType: "ado" }]), null)
  assert.equal(await commitRepoOf([{ cwd: `/tmp/${SENTINEL}`, repository: "octo-org/widgets" }]), null)
  assert.equal(await commitRepoOf([github(`${SENTINEL} free text/x`)]), null)
  assert.equal(await commitRepoOf([github(42)]), null)
  assert.equal(await commitRepoOf([github("octo-org/widgets"), github(`${SENTINEL} free text/x`)]), null)
  assert.equal(await commitRepoOf([`${SENTINEL} context`]), null)
})
