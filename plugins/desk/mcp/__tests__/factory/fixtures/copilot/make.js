#!/usr/bin/env node
// Synthetic, structure-faithful Copilot CLI session fixtures for the Copilot
// deriver's tests. Nothing here was copied from a real session: every event
// is written by hand from the event shapes in the published Copilot SDK
// schema (`@github/copilot-sdk` `session-events.schema.json`) and the
// structure-only research notes, and every free-text value carries
// `SENTINEL` so a test can prove no content reaches the facts.
//
// Run `node make.js` to regenerate the checked-in `<sessionId>/events.jsonl`
// and `<sessionId>/workspace.yaml` files. The session database is never
// checked in: `buildSessionStore` builds a synthetic `session-store.db` with
// `node:sqlite` in the test's own temp folder, holding only `sessions` (id
// only), `assistant_usage_events` and `session_refs`. It has no `turns`
// table, because the real one holds message text.

import { closeSync, mkdirSync, openSync, writeFileSync, writeSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const require = createRequire(import.meta.url)

export const SENTINEL = "SENTINEL-7f3a"
const S = SENTINEL

export const SESSIONS = Object.freeze({
  full: "5f0e1d2c-3b4a-4c5d-8e6f-7a8b9c0d1e2f",
  noShutdown: "6a1f2e3d-4c5b-4d6e-9f70-8b9c0d1e2f30",
  noUsage: "7b203f4e-5d6c-4e7f-a081-9c0d1e2f3041",
  noEnvelope: "8c314050-6e7d-4f80-b192-0d1e2f304152",
})

export const BASE_MS = Date.parse("2026-09-25T08:00:00.000Z")

/** The ISO instant `seconds` after the fixture base. */
export function at(seconds) {
  return new Date(BASE_MS + Math.round(seconds * 1000)).toISOString()
}

/** A deterministic UUID-shaped event id. */
function eventId(n) {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
}

/**
 * A builder that stamps the common envelope (`id`, `timestamp`, `parentId`,
 * `type`, `data`) and chains `parentId` to the previous event, as the host
 * does.
 */
export function eventWriter(startId = 1) {
  let next = startId
  let previous = null
  return (type, seconds, data = {}, extra = {}) => {
    const id = eventId(next)
    next += 1
    const event = { type, data, id, timestamp: at(seconds), parentId: previous, ...extra }
    previous = id
    return event
  }
}

// ---------------------------------------------------------------------------
// Content-bearing shapes. Each carries SENTINEL in every free-text value.
// ---------------------------------------------------------------------------

function sessionStart(ev, seconds, sessionId, { copilotVersion = "1.0.88", hostType = "github" } = {}) {
  return ev("session.start", seconds, {
    sessionId,
    version: 1,
    producer: "copilot-agent",
    copilotVersion,
    startTime: at(seconds),
    selectedModel: "claude-opus-5-5",
    context: {
      cwd: `/tmp/${S}/repo`,
      gitRoot: `/tmp/${S}/repo`,
      repository: `${S}/repo`,
      ...(hostType === undefined ? {} : { hostType }),
      branch: `${S}-branch`,
      headCommit: "0123456789abcdef0123456789abcdef01234567",
    },
  })
}

function hookPair(ev, seconds, hookType, input) {
  return [
    ev("hook.start", seconds, { hookInvocationId: `hook-${seconds}`, hookType, input }),
    ev("hook.end", seconds, { hookInvocationId: `hook-${seconds}`, hookType, success: true, output: { note: S } }),
  ]
}

function userMessage(ev, seconds) {
  return ev("user.message", seconds, {
    content: `please ${S}`,
    transformedContent: `<context>${S}</context>`,
    attachments: [{ type: "file", path: `/tmp/${S}/notes.md`, displayName: S }],
    interactionId: `interaction-${seconds}`,
  })
}

function assistantMessage(ev, seconds, toolRequests = []) {
  return ev("assistant.message", seconds, {
    messageId: `msg-${seconds}`,
    model: "claude-opus-5-5",
    content: `answer ${S}`,
    reasoningText: `thinking ${S}`,
    toolRequests: toolRequests.map(([toolCallId, name]) => ({ toolCallId, name, arguments: { note: S } })),
  })
}

function toolStart(ev, seconds, toolCallId, toolName, args, extra = {}) {
  return ev("tool.execution_start", seconds, {
    toolCallId,
    toolName,
    arguments: args,
    model: "claude-opus-5-5",
    turnId: "turn",
    ...extra,
  })
}

function toolComplete(ev, seconds, toolCallId, { success = true, exitCode, errorCode, parentToolCallId } = {}) {
  return ev("tool.execution_complete", seconds, {
    toolCallId,
    success,
    model: "claude-opus-5-5",
    result: { content: `output ${S}`, detailedContent: `detail ${S}` },
    ...(success ? {} : { error: { message: `failed ${S}`, ...(errorCode === undefined ? {} : { code: errorCode }) } }),
    ...(exitCode === undefined ? {} : { shellExecution: { exitCode } }),
    ...(parentToolCallId === undefined ? {} : { parentToolCallId }),
    toolTelemetry: { note: S },
  })
}

function shutdown(ev, seconds, modelMetrics) {
  return ev("session.shutdown", seconds, {
    shutdownType: "routine",
    totalPremiumRequests: 3,
    totalNanoAiu: 1000,
    totalApiDurationMs: 5000,
    sessionStartTime: BASE_MS,
    codeChanges: { linesAdded: 10, linesRemoved: 2, filesModified: [`/tmp/${S}/changed.js`] },
    modelMetrics,
    agentMetrics: { main: { agentName: S, totalApiDurationMs: 1, totalNanoAiu: 1, modelMetrics: {} } },
    currentModel: "claude-opus-5-5",
  })
}

function metric(count, input, output, cacheRead, cacheWrite, reasoning) {
  const usage = { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }
  if (reasoning !== undefined) usage.reasoningTokens = reasoning
  return { requests: { count, cost: count }, usage, totalNanoAiu: 10 }
}

// The final (cumulative) shutdown totals of the full fixture. Tests compare
// against these, and against the different database rows, to prove the two
// usage sources are never added together.
export const FULL_FINAL_METRICS = Object.freeze({
  "claude-opus-5-5": metric(7, 7000, 700, 70000, 7700, 70),
  "claude-sonnet-5": metric(2, 2000, 200, 20000, 2200),
  "gpt-5.2": metric(1, 1000, 100, 10000, 1100, 10),
})

export const APPLY_PATCH = [
  "*** Begin Patch",
  `*** Add File: /tmp/${S}/desk/eng/m3-3/notes.md`,
  `+${S} added line`,
  `*** Update File: /tmp/${S}/desk/eng/m3-3/task.md`,
  "@@",
  `-${S} old`,
  `+${S} new`,
  `*** Delete File: /tmp/${S}/desk/eng/m3-3/old.md`,
  "*** End Patch",
].join("\n")

// ---------------------------------------------------------------------------
// Fixture sessions.
// ---------------------------------------------------------------------------

/**
 * The full session: four process lifetimes (three `session.resume` events,
 * four `session.shutdown` events with cumulative totals); root turns grouped
 * by `interactionId`, with subagent turns whose ids collide with the root's;
 * every `user.message` shape (human, inter-agent, autopilot, scheduled,
 * skill-injected); every tool outcome and a retry; human and unattended
 * permission decisions, one from a subagent; a subagent with a nested
 * subagent; Desk tool calls, an MCP tool, file writes from `create`, `edit`
 * and `apply_patch`; plugin skills; retryable and non-retryable failures
 * under both event spellings; a successful and a failed compaction; unknown
 * event types and a blank line.
 */
function fullSession() {
  const id = SESSIONS.full
  const ev = eventWriter(1)
  const sub = { agentId: `${S}-agent-a` }
  const i1 = { interactionId: `${S}-i1` }
  const lines = [
    sessionStart(ev, 0, id),
    ...hookPair(ev, 0.5, "sessionStart", { cwd: `/tmp/${S}`, initialPrompt: `do ${S}`, sessionId: id, source: "new" }),
    ev("session.info", 1, { infoType: "note", message: S }),
    userMessage(ev, 2),
    // Interaction 1 spans two model iterations (root turns "0" and "1").
    ev("assistant.turn_start", 3, { turnId: "0", ...i1 }),
    assistantMessage(ev, 4, [["c1", "bash"]]),
    // A shell call that ran but exited 1 is an error, then retried.
    toolStart(ev, 5, "c1", "bash", { command: `echo ${S}`, description: S }),
    toolComplete(ev, 7, "c1", { exitCode: 1 }),
    toolStart(ev, 8, "c2", "bash", { command: `echo ${S} again`, description: S }),
    toolComplete(ev, 9, "c2", { exitCode: 0 }),
    // Successful writes bind; a failed one does not.
    toolStart(ev, 10, "c3", "edit", { path: `/tmp/${S}/desk/eng/m3-3/task.md`, old_str: S, new_str: S }),
    toolComplete(ev, 11, "c3"),
    toolStart(ev, 12, "c4", "create", { path: `/tmp/${S}/desk/eng/m3-3/failed.md`, file_text: S }),
    toolComplete(ev, 13, "c4", { success: false, errorCode: "failure" }),
    toolStart(ev, 14, "c5", "apply_patch", { input: APPLY_PATCH }),
    toolComplete(ev, 15, "c5"),
    ev("assistant.turn_end", 15.2, { turnId: "0" }),
    ev("assistant.turn_start", 15.5, { turnId: "1", ...i1 }),
    // A human answers a permission prompt (denied), so the tool is denied.
    toolStart(ev, 16, "c6", "view", { path: `/tmp/${S}/secret` }),
    ev("permission.requested", 16, { requestId: `r1-${S}`, permissionRequest: { kind: "read", path: `/tmp/${S}/secret`, intention: S } }),
    ev("permission.completed", 20, { requestId: `r1-${S}`, toolCallId: "c6", decisionSource: "human_response", result: { kind: "denied-interactively-by-user", feedback: S } }),
    toolComplete(ev, 21, "c6", { success: false, errorCode: "denied" }),
    // An unattended fallback decision is not a human wait.
    toolStart(ev, 22, "c7", "bash", { command: `ls ${S}` }),
    ev("permission.requested", 22, { requestId: "r2", permissionRequest: { kind: "shell", fullCommandText: `ls ${S}` } }),
    ev("permission.completed", 22.5, { requestId: "r2", decisionSource: "unattended_fallback", result: { kind: "approved" } }),
    toolComplete(ev, 24, "c7", { exitCode: 0 }),
    // Desk task tools: one ok, one failed, one without a slug (not a Desk call).
    toolStart(ev, 25, "c8", "desk-task_update", { track: `${S}-track`, slug: `${S}-slug`, status: `${S}-status`, body: S }),
    toolComplete(ev, 26, "c8"),
    toolStart(ev, 27, "c9", "desk-task_create", { track: `${S}-track`, slug: `${S}-other`, person: `${S}-person`, title: S }),
    toolComplete(ev, 27.5, "c9", { success: false, errorCode: "failure" }),
    toolStart(ev, 28, "c10", "desk-task_archive", { track: `${S}-track`, note: S }),
    toolComplete(ev, 28.5, "c10"),
    toolStart(ev, 28.6, `c-${S}`, `${S}-server-tool`, { query: S }),
    toolComplete(ev, 28.8, `c-${S}`),
    ev("skill.invoked", 29, { name: S, path: `/tmp/${S}/SKILL.md`, content: S, pluginName: "desk", pluginVersion: "3.2.0-alpha.22", description: S }),
    ev("skill.invoked", 29.2, { name: S, path: `/tmp/${S}/other/SKILL.md`, content: S, pluginName: "superpowers", pluginVersion: "5.1.0", description: S }),
    ev("skill.invoked", 29.4, { name: S, path: `/tmp/${S}/local/SKILL.md`, content: S }),
    // A subagent, whose own turns, tools, permission and nested subagent are its own.
    toolStart(ev, 30, "c11", "task", { prompt: S, description: S, agent_type: "explore" }),
    ev("subagent.started", 31, { toolCallId: "c11", agentName: S, agentDisplayName: S, agentDescription: S, model: "claude-sonnet-5" }),
    ev("user.message", 31.2, { content: S, source: `agent-${S}`, isAutopilotContinuation: false }, sub),
    ev("assistant.turn_start", 31.3, { turnId: "0", interactionId: `${S}-sub` }, sub),
    ev("assistant.turn_end", 31.8, { turnId: "0" }, sub),
    ev("assistant.turn_start", 31.9, { turnId: "1", interactionId: `${S}-sub` }, sub),
    toolStart(ev, 32, "c12", "grep", { pattern: S }, { parentToolCallId: "c11" }),
    ev("permission.requested", 32.2, { requestId: "r3", permissionRequest: { kind: "read", path: S } }, sub),
    ev("permission.completed", 32.6, { requestId: "r3", toolCallId: "c12", decisionSource: "human_response", result: { kind: "approved" } }, sub),
    toolComplete(ev, 33, "c12", { parentToolCallId: "c11" }),
    ev("assistant.turn_end", 33.5, { turnId: "1" }, sub),
    toolStart(ev, 34, "c13", "task", { prompt: S, description: S }, { parentToolCallId: "c11" }),
    ev("subagent.started", 35, { toolCallId: "c13", agentName: S, agentDisplayName: S, agentDescription: S, model: "gpt-5.2" }),
    toolStart(ev, 36, "c14", "view", { path: `/tmp/${S}/x` }, { parentToolCallId: "c13" }),
    toolComplete(ev, 37, "c14", { parentToolCallId: "c13" }),
    ev("subagent.completed", 38, { toolCallId: "c13", agentName: S, agentDisplayName: S, model: "gpt-5.2", totalToolCalls: 1, totalTokens: 10, durationMs: 3000 }),
    toolComplete(ev, 39, "c13", { parentToolCallId: "c11" }),
    ev("subagent.completed", 40, { toolCallId: "c11", agentName: S, agentDisplayName: S, model: "claude-sonnet-5", totalToolCalls: 2, totalTokens: 20, durationMs: 9000, cancelled: false }),
    toolComplete(ev, 41, "c11"),
    assistantMessage(ev, 42),
    ev("assistant.turn_end", 43, { turnId: "1" }),
    // A human prompt inside the same lifetime: a human wait.
    userMessage(ev, 44),
    ev("assistant.turn_start", 45, { turnId: "2", interactionId: `${S}-i2` }),
    ev("assistant.turn_end", 46, { turnId: "2" }),
    // Messages that are not human prompts open no wait.
    ev("user.message", 46.5, { content: S, isAutopilotContinuation: true }),
    ev("assistant.turn_start", 47, { turnId: "3", interactionId: `${S}-i3` }),
    ev("assistant.turn_end", 48, { turnId: "3" }),
    ev("user.message", 48.2, { content: S, source: "schedule-1", isAutopilotContinuation: false }),
    ev("user.message", 48.4, { content: S, source: "autopilot", isAutopilotContinuation: true }),
    ev("user.message", 48.6, { content: S, source: `skill-${S}` }),
    ...hookPair(ev, 49, "sessionEnd", { cwd: `/tmp/${S}`, reason: "complete", sessionId: id }),
    shutdown(ev, 50, { "claude-opus-5-5": metric(3, 3000, 300, 30000, 3300, 30) }),
    // Lifetime 2. A wait never spans a resume.
    ev("session.resume", 55, { resumeTime: at(55), eventCount: 50, context: { cwd: `/tmp/${S}` } }),
    userMessage(ev, 60),
    ev("assistant.turn_start", 61, { turnId: "0", interactionId: `${S}-i4` }),
    ev("model.model_call_failure", 62, { statusCode: 429, errorMessage: S, source: "top_level" }),
    ev("model.turn_retry", 63, { turnId: "0", reason: S }),
    ev("model.call_failure", 64, { failureKind: "transport", errorMessage: S, source: "top_level" }),
    ev("assistant.turn_retry", 65, { turnId: "0", reason: S }),
    ev("session.error", 66, { errorType: "service", statusCode: 503, message: S, stack: S }),
    ev("model.turn_retry", 67, { turnId: "0" }),
    ev("session.error", 68, { errorType: "request", statusCode: 400, message: S }),
    ev("model.call_failure", 68.5, { statusCode: 400, failureKind: "api", errorMessage: S, source: "top_level" }),
    ev("model.turn_retry", 68.7, { turnId: "0" }),
    ev("session.compaction_start", 69, { trigger: "threshold" }),
    ev("session.compaction_complete", 72, { success: true, summaryContent: S, customInstructions: S }),
    ev("session.compaction_start", 72.2, { trigger: "manual" }),
    ev("session.compaction_complete", 72.4, { success: false, error: S }),
    ev("abort", 73, { reason: "user_initiated" }),
    ev("assistant.turn_end", 74, { turnId: "0" }),
    userMessage(ev, 75.2),
    ev("assistant.turn_start", 75.4, { turnId: "1", interactionId: `${S}-i5` }),
    ev("assistant.turn_end", 75.6, { turnId: "1" }),
    ev("session.warning", 75.8, { warningType: "note", message: S }),
    shutdown(ev, 76, { "claude-opus-5-5": metric(5, 5000, 500, 50000, 5500, 50), "claude-sonnet-5": metric(2, 2000, 200, 20000, 2200) }),
    // Lifetime 3.
    ev("session.resume", 80, { resumeTime: at(80), eventCount: 70 }),
    userMessage(ev, 90),
    ev("assistant.turn_start", 91, { turnId: "0", interactionId: `${S}-i6` }),
    ev("assistant.turn_end", 92, { turnId: "0" }),
    shutdown(ev, 93, { "claude-opus-5-5": metric(6, 6000, 600, 60000, 6600, 60), "claude-sonnet-5": metric(2, 2000, 200, 20000, 2200), "gpt-5.2": metric(1, 1000, 100, 10000, 1100, 10) }),
    // Lifetime 4.
    ev("session.resume", 94, { resumeTime: at(94), eventCount: 80 }),
    userMessage(ev, 95),
    ev("assistant.turn_start", 96, { turnId: "0", interactionId: `${S}-i7` }),
    ev("assistant.turn_end", 97, { turnId: "0" }),
    shutdown(ev, 99, FULL_FINAL_METRICS),
  ]
  // A blank line mid-file is skipped, never a parse failure.
  const text = lines.map((line) => JSON.stringify(line))
  text.splice(10, 0, "")
  return `${text.join("\n")}\n`
}

/**
 * No `session.shutdown` (the session is still open): usage must come from
 * the database. Also: an orphan tool call, an open turn, a subagent that
 * fails with an invalid model, odd line shapes, and a truncated last line.
 */
function noShutdownSession() {
  const id = SESSIONS.noShutdown
  const ev = eventWriter(1000)
  const lines = [
    sessionStart(ev, 0, id, { copilotVersion: "1.0.85", hostType: undefined }),
    userMessage(ev, 1),
    ev("assistant.turn_start", 2, { turnId: "t1" }),
    toolStart(ev, 3, "d1", "bash", { command: `run ${S}` }),
    toolComplete(ev, 4, "d1", { exitCode: 0 }),
    toolStart(ev, 5, "d2", "task", { prompt: S }),
    ev("subagent.started", 6, { toolCallId: "d2", agentName: S, agentDisplayName: S, agentDescription: S, model: `bad model ${S}` }),
    ev("subagent.failed", 8, { toolCallId: "d2", agentName: S, agentDisplayName: S, error: S }),
    toolComplete(ev, 9, "d2", { success: false, errorCode: "failure" }),
    // Started, never completed.
    toolStart(ev, 10, "d3", "web_fetch", { url: `https://example.com/${S}` }),
    ev("assistant.turn_end", 11, { turnId: "t1" }),
    userMessage(ev, 20),
    ev("assistant.turn_start", 21, { turnId: "t2" }),
  ]
  const text = lines.map((line) => JSON.stringify(line))
  // Odd but valid JSON lines are skipped without costing the session.
  text.push("42", "null", JSON.stringify({ type: "user.message", timestamp: at(22), data: null }), JSON.stringify(["not", S]))
  text.push(`{"type":"assistant.message","timestamp":"${at(23)}","data":{"content":"${S}`)
  return `${text.join("\n")}\n`
}

/** A closed session with no shutdown event and no database rows. */
function noUsageSession() {
  const id = SESSIONS.noUsage
  const ev = eventWriter(2000)
  const lines = [
    sessionStart(ev, 0, id),
    userMessage(ev, 1),
    ev("assistant.turn_start", 2, { turnId: "t1" }),
    assistantMessage(ev, 3),
    ev("assistant.turn_end", 4, { turnId: "t1" }),
  ]
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
}

/** Events but no `session.start`: no usable envelope. */
function noEnvelopeSession() {
  const ev = eventWriter(3000)
  const lines = [userMessage(ev, 1), ev("assistant.turn_start", 2, { turnId: "t1" }), ev("assistant.turn_end", 3, { turnId: "t1" })]
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`
}

export const FIXTURE_TEXT = Object.freeze({
  [SESSIONS.full]: fullSession,
  [SESSIONS.noShutdown]: noShutdownSession,
  [SESSIONS.noUsage]: noUsageSession,
  [SESSIONS.noEnvelope]: noEnvelopeSession,
})

function workspaceYaml(sessionId) {
  return [
    `id: ${sessionId}`,
    `cwd: /tmp/${S}/repo`,
    `git_root: /tmp/${S}/repo`,
    `repository: ${S}/repo`,
    "host_type: github",
    `branch: ${S}-branch`,
    `name: ${S}`,
    `summary: ${S} summary`,
    "created_at: 2026-09-25T08:00:00.000Z",
    "",
  ].join("\n")
}

// ---------------------------------------------------------------------------
// The synthetic session database.
// ---------------------------------------------------------------------------

const STORE_SCHEMA = `
CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, summary TEXT);
CREATE TABLE assistant_usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  turn_index INTEGER,
  agent_id TEXT,
  parent_tool_call_id TEXT,
  model TEXT NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reasoning_tokens INTEGER,
  total_nano_aiu INTEGER,
  request_multiplier REAL,
  duration_ms INTEGER,
  time_to_first_token_ms INTEGER,
  inter_token_latency_ms INTEGER,
  initiator TEXT,
  api_endpoint TEXT,
  reasoning_effort TEXT,
  finish_reason TEXT,
  content_filter_triggered INTEGER,
  token_details_json TEXT,
  created_at TEXT
);
CREATE TABLE session_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT,
  ref_type TEXT,
  ref_value TEXT,
  turn_index INTEGER,
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE(session_id, ref_type, ref_value)
);
`

/** One usage row with defaults; `overrides` replaces any column. */
export function usageRow(sessionId, model, overrides = {}) {
  return {
    session_id: sessionId,
    turn_index: 0,
    agent_id: null,
    parent_tool_call_id: null,
    model,
    input_tokens: 100,
    output_tokens: 10,
    cache_read_tokens: 1000,
    cache_write_tokens: 50,
    reasoning_tokens: null,
    total_nano_aiu: 5,
    request_multiplier: 1,
    duration_ms: 1200,
    initiator: "agent",
    created_at: "2026-09-25 08:00:05",
    ...overrides,
  }
}

/** The database rows every fixture session gets, plus rows of another session that must never leak in. */
/** The commits in the fixture sessions' repository, which the fake resolver finds by prefix. */
export const FIXTURE_COMMITS = Object.freeze([
  "abcdef0000000000000000000000000000000001",
  "abcdef0120000000000000000000000000000001",
  "fc6ea8a0000000000000000000000000000000aa",
])

/**
 * A fake `resolveCommits` for the deriver: in `root` it finds
 * `FIXTURE_COMMITS` by prefix and reports `origin`; anywhere else it finds
 * nothing. `calls` records every call.
 */
export function fakeCommitResolver({ root = `/tmp/${S}/repo`, origin = "https://github.com/ourostack/desk" } = {}) {
  const calls = []
  const resolveCommits = ({ gitRoot, cwd, shas }) => {
    calls.push({ gitRoot, cwd, shas: [...shas] })
    if (gitRoot !== root) return { origin: null, fulls: shas.map(() => null) }
    return { origin, fulls: shas.map((sha) => FIXTURE_COMMITS.find((full) => full.startsWith(sha.toLowerCase())) ?? null) }
  }
  return Object.assign(resolveCommits, { calls })
}

export const OTHER_SESSION = "9d425161-7f8e-4091-a2a3-1e2f30415263"

export function defaultStoreRows() {
  return {
    // The real store's shapes (controller probe, M3-5 fix round 1): a
    // session row carries its repository and working directory.
    sessions: [
      { id: SESSIONS.full, cwd: `/tmp/${S}/cwd`, repository: "ourostack/desk", summary: `${S} summary` },
      { id: SESSIONS.noShutdown, cwd: `/tmp/${S}/cwd`, repository: `${S} not a repo`, summary: S },
      { id: OTHER_SESSION, cwd: `/tmp/${S}/other`, repository: "ourostack/secret", summary: S },
    ],
    usage: [
      // The full session has a shutdown; these rows must not be added to it.
      usageRow(SESSIONS.full, "claude-opus-5-5", { input_tokens: 999999 }),
      // The open session's usage comes only from here.
      usageRow(SESSIONS.noShutdown, "claude-opus-5-5"),
      usageRow(SESSIONS.noShutdown, "claude-opus-5-5", { input_tokens: 200, reasoning_tokens: 7 }),
      usageRow(SESSIONS.noShutdown, "gpt-5.2", { reasoning_tokens: 3 }),
      usageRow(SESSIONS.noShutdown, `bad model ${S}`),
      usageRow(SESSIONS.noShutdown, "gpt-5.2", { output_tokens: -1, agent_id: S }),
      usageRow(OTHER_SESSION, "claude-opus-5-5", { input_tokens: 555555 }),
    ],
    // Real rows are bare PR numbers and 7–9 character short SHAs; the
    // `owner/repo#n`, URL and 40-hex forms are still accepted.
    refs: [
      [SESSIONS.full, "pr", "7"],
      [SESSIONS.full, "pr", "12"],
      [SESSIONS.full, "commit", "fc6ea8a"],
      [SESSIONS.full, "commit", "abcdef012"],
      [SESSIONS.full, "commit", "0badc0de"],
      [SESSIONS.full, "issue", "4"],
      [SESSIONS.noShutdown, "pr", "5"],
      [SESSIONS.noShutdown, "commit", "fc6ea8a"],
      [SESSIONS.full, "pr", "ourostack/desk#12"],
      [SESSIONS.full, "pr", "https://github.com/ourostack/factory/pull/3"],
      [SESSIONS.full, "pr", "https://github.com/ourostack/desk/pull/12/files"],
      [SESSIONS.full, "pr", "https://dev.azure.com/org/proj/_git/repo/pullrequest/5"],
      [SESSIONS.full, "pr", `${S}#nope`],
      [SESSIONS.full, "pr", "ourostack/desk#0"],
      [SESSIONS.full, "commit", "fc6ea8a0000000000000000000000000000000aa"],
      [SESSIONS.full, "commit", "ABCDEF0000000000000000000000000000000001"],
      [SESSIONS.full, "commit", `abc123 ${S}`],
      [SESSIONS.full, "issue", `${S} issue`],
      [SESSIONS.full, null, null],
      [OTHER_SESSION, "pr", "ourostack/secret#1"],
      [OTHER_SESSION, "commit", "1111111111111111111111111111111111111111"],
      [OTHER_SESSION, "pr", "99"],
    ],
  }
}

/** Build a synthetic `session-store.db` at `dbPath` holding `rows`. */
export function buildSessionStore(dbPath, rows = defaultStoreRows()) {
  const { DatabaseSync } = require("node:sqlite")
  const db = new DatabaseSync(dbPath)
  try {
    db.exec(STORE_SCHEMA)
    const insertSession = db.prepare("INSERT INTO sessions (id, cwd, repository, summary) VALUES (?, ?, ?, ?)")
    for (const session of rows.sessions ?? []) {
      const { id, cwd = null, repository = null, summary = null } = typeof session === "string" ? { id: session } : session
      insertSession.run(id, cwd, repository, summary)
    }
    const columns = Object.keys(usageRow("x", "y"))
    const insertUsage = db.prepare(
      `INSERT INTO assistant_usage_events (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
    )
    for (const row of rows.usage ?? []) insertUsage.run(...columns.map((column) => row[column]))
    const insertRef = db.prepare("INSERT INTO session_refs (session_id, ref_type, ref_value, turn_index) VALUES (?, ?, ?, 0)")
    for (const [sessionId, type, value] of rows.refs ?? []) insertRef.run(sessionId, type, value)
  } finally {
    db.close()
  }
}

// ---------------------------------------------------------------------------
// Large generated sessions for the streaming and memory test. Written in
// batches straight to disk, so the generator itself holds no more than one
// batch in memory.
// ---------------------------------------------------------------------------

/**
 * Write an events file of at least `lines` lines to `file`: a session start,
 * then repeated turns of a human prompt, eight shell tool pairs (each with
 * content-bearing arguments and results) and an assistant message.
 */
export function writeLargeEvents(file, { sessionId, lines }) {
  const fd = openSync(file, "w")
  try {
    const ev = eventWriter(1)
    let written = 0
    let batch = []
    const flush = () => {
      writeSync(fd, `${batch.join("\n")}\n`)
      written += batch.length
      batch = []
    }
    batch.push(JSON.stringify(sessionStart(ev, 0, sessionId)))
    let clock = 1
    let turn = 0
    while (written + batch.length < lines) {
      turn += 1
      batch.push(JSON.stringify(userMessage(ev, clock)))
      batch.push(JSON.stringify(ev("assistant.turn_start", clock + 0.001, { turnId: `t${turn}` })))
      for (let call = 0; call < 8; call += 1) {
        const id = `t${turn}c${call}`
        batch.push(JSON.stringify(toolStart(ev, clock + 0.002 + call * 0.002, id, "bash", { command: `echo ${S} ${turn}` })))
        batch.push(JSON.stringify(toolComplete(ev, clock + 0.003 + call * 0.002, id, { exitCode: call === 3 ? 1 : 0 })))
      }
      batch.push(JSON.stringify(assistantMessage(ev, clock + 0.02)))
      batch.push(JSON.stringify(ev("assistant.turn_end", clock + 0.021, { turnId: `t${turn}` })))
      clock += 0.05
      if (batch.length >= 20000) flush()
    }
    if (batch.length > 0) flush()
    return written
  } finally {
    closeSync(fd)
  }
}

/** A session with `count` subagents, to exercise the agent cap. */
export function manySubagentsText(sessionId, count) {
  const ev = eventWriter(1)
  const lines = [JSON.stringify(sessionStart(ev, 0, sessionId))]
  for (let index = 0; index < count; index += 1) {
    const seconds = 1 + index * 0.001
    lines.push(JSON.stringify(ev("subagent.started", seconds, { toolCallId: `s${index}`, agentName: S, agentDisplayName: S, agentDescription: S, model: "gpt-5.2" })))
  }
  // A tool inside the last (dropped) subagent falls back to agent 0.
  lines.push(JSON.stringify(toolStart(ev, 20, "last", "view", { path: S }, { parentToolCallId: `s${count - 1}` })))
  lines.push(JSON.stringify(toolComplete(ev, 21, "last", { parentToolCallId: `s${count - 1}` })))
  return `${lines.join("\n")}\n`
}

// ---------------------------------------------------------------------------
// Regenerate the checked-in fixtures.
// ---------------------------------------------------------------------------

export function writeFixtures(root = path.dirname(fileURLToPath(import.meta.url))) {
  for (const [sessionId, build] of Object.entries(FIXTURE_TEXT)) {
    const dir = path.join(root, sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "events.jsonl"), build())
    writeFileSync(path.join(dir, "workspace.yaml"), workspaceYaml(sessionId))
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) writeFixtures()
