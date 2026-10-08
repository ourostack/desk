// Stop facts on human waits (`intervals[kind=human_wait].stop`, facts /4) and the PR `created` flag, from the Claude Code and Copilot CLI
// derivers. Every line here is synthetic. Each free-text value is one of the SAMPLE_SENTENCES, and the privacy tests grep the derived
// facts for every one of them, and for the ask tools' names, which never leave the deriver either.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { deriveClaudeSession } from "../../../../../plugins/desk/mcp/src/factory/derive-claude.js"
import { deriveCopilotSession } from "../../../../../plugins/desk/mcp/src/factory/derive-copilot.js"
import { dedupePrRefs } from "../../../../../plugins/desk/mcp/src/factory/derive-common.js"
import { validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import { serializePublished, toPublished } from "../../../../../plugins/desk/mcp/src/factory/publish.js"
import { validatePublishedBytes } from "../../../../../plugins/desk/mcp/src/factory/published-schema.js"

const SAMPLE_SENTENCES = Object.freeze([
  "Shall I also rename the billing tables while I am here?",
  "Please go ahead and ship the walrus migration tonight.",
  "Which colour should the onboarding banner use?",
  "Here is my plan for the lighthouse refactor.",
  "The deploy finished and every check is green.",
  "Use teal, and keep the old banner behind a flag.",
])
const [ASK_REPLY, PROMPT, QUESTION, PLAN, DONE_REPLY, ANSWER] = SAMPLE_SENTENCES
const ASK_TOOLS = ["AskUserQuestion", "ExitPlanMode"]

// Neither the local facts nor the bytes a store would receive hold any sample sentence or ask tool name, and those bytes pass the gate.
function assertNoText(facts) {
  const { published } = toPublished(facts, { visibility: () => "public", deskVisibility: "private" })
  const bytes = serializePublished(published)
  assert.deepEqual(validatePublishedBytes(bytes).errors, [])
  for (const text of [JSON.stringify(facts), bytes]) {
    for (const sentence of SAMPLE_SENTENCES) assert.equal(text.includes(sentence), false, sentence)
    for (const name of ASK_TOOLS) assert.equal(text.includes(name), false, name)
  }
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

const SESSION = "3c4d5e6f-7a8b-4c9d-8e0f-1a2b3c4d5e6f"
const PLUGINS = [{ name: "desk", version: "3.2.0-alpha.21", source: "ourostack/desk" }]
const ts = (second) => new Date(Date.parse("2026-09-25T11:00:00.000Z") + second * 1000).toISOString()
const base = (second) => ({ sessionId: SESSION, version: "2.1.282", timestamp: ts(second) })
const HUMAN = { promptSource: "typed", origin: { kind: "human" }, turnOrigin: "human" }
const prompt = (second, text = PROMPT) => ({ ...base(second), type: "user", message: { role: "user", content: text }, ...HUMAN })
const reply = (second, text, stopReason = "end_turn", extra = {}) => ({ ...base(second), type: "assistant", message: { id: `m-${second}`, model: "claude-opus-5-5", stop_reason: stopReason, usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "text", text }] }, ...extra })
const apiError = (second, status, error) => ({ ...base(second), type: "assistant", isApiErrorMessage: true, ...(status === undefined ? {} : { apiErrorStatus: status }), error, message: { id: `e-${second}`, model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: DONE_REPLY }] } })
const turnDuration = (second, count) => ({ ...base(second), type: "system", subtype: "turn_duration", durationMs: 1000, messageCount: 2, isMeta: false, ...(count === undefined ? {} : { pendingBackgroundAgentCount: count }) })
const interrupt = (second, forTool = false) => ({ ...base(second), type: "user", message: { role: "user", content: [{ type: "text", text: forTool ? "[Request interrupted by user for tool use]" : "[Request interrupted by user]" }] } })
const toolUse = (second, id, name, input, extra = {}) => ({ ...base(second), type: "assistant", message: { id: `m-${second}`, model: "claude-opus-5-5", stop_reason: "tool_use", usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: "tool_use", id, name, input }] }, ...extra })
const toolResult = (second, id, text, extra = {}) => ({ ...base(second), type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text }] }, ...extra })

async function deriveClaude(lines, subagents = []) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-stop-facts-"))
  try {
    const transcript = path.join(dir, `${SESSION}.jsonl`)
    writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
    for (const { stem, lines: subLines, meta } of subagents) {
      const sub = path.join(dir, SESSION, "subagents")
      mkdirSync(sub, { recursive: true })
      writeFileSync(path.join(sub, `${stem}.jsonl`), `${subLines.map((line) => JSON.stringify(line)).join("\n")}\n`)
      writeFileSync(path.join(sub, `${stem}.meta.json`), JSON.stringify(meta ?? { agentType: "general-purpose" }))
    }
    const result = await deriveClaudeSession({ transcriptPath: transcript, plugins: PLUGINS, endReason: "prompt_input_exit" })
    assert.deepEqual(validateLocalFacts(result.facts).errors, [])
    assertNoText(result.facts)
    return result.facts
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const waits = (facts) => facts.intervals.filter((interval) => interval.kind === "human_wait")

test("Claude Code: a wait after a normal end carries end_turn, whether the reply ended in a question mark, and the pending background agents", async () => {
  const facts = await deriveClaude([
    prompt(0), reply(2, ASK_REPLY), turnDuration(3, 2),
    prompt(10), reply(12, `${DONE_REPLY}  \n`), turnDuration(13, 0),
    prompt(20), reply(22, `${ASK_REPLY}\n\n`), turnDuration(23),
    prompt(30), reply(32, DONE_REPLY),
    prompt(40), reply(42, DONE_REPLY), { ...turnDuration(43), pendingBackgroundAgentCount: "2" },
    prompt(50),
  ])
  assert.deepEqual(waits(facts), [
    { kind: "human_wait", agent: 0, start: ts(2), end: ts(10), stop: { end: "end_turn", asks: true, pending_agents: true } },
    { kind: "human_wait", agent: 0, start: ts(12), end: ts(20), stop: { end: "end_turn", asks: false, pending_agents: false } },
    // The host writes the count only when it is above zero, so a turn_duration line without it means none were running.
    { kind: "human_wait", agent: 0, start: ts(22), end: ts(30), stop: { end: "end_turn", asks: true, pending_agents: false } },
    // No turn_duration line at all does not say either.
    { kind: "human_wait", agent: 0, start: ts(32), end: ts(40), stop: { end: "end_turn", asks: false, pending_agents: null } },
    // A count that is no whole number does not say.
    { kind: "human_wait", agent: 0, start: ts(42), end: ts(50), stop: { end: "end_turn", asks: false, pending_agents: null } },
  ])
})

test("Claude Code: the last reply's stop reason decides the end; a stop sequence is a normal end and anything else is not recorded", async () => {
  const facts = await deriveClaude([
    prompt(0), reply(1, DONE_REPLY, "max_tokens"),
    prompt(10), reply(11, DONE_REPLY, "refusal"),
    prompt(20), reply(21, DONE_REPLY, "stop_sequence"),
    prompt(30), reply(31, DONE_REPLY, "tool_use"),
    prompt(40), reply(41, DONE_REPLY, null),
    prompt(50), reply(51, DONE_REPLY, "pause_turn"),
    // An earlier reply's reason does not decide: the last one does.
    prompt(60), reply(61, DONE_REPLY, "max_tokens"), reply(62, ASK_REPLY, "end_turn"),
    prompt(70),
  ])
  assert.deepEqual(waits(facts).map((wait) => wait.stop), [
    { end: "max_tokens", asks: false, pending_agents: null },
    { end: "refusal", asks: false, pending_agents: null },
    { end: "end_turn", asks: false, pending_agents: null },
    { end: "not_recorded", asks: false, pending_agents: null },
    { end: "not_recorded", asks: false, pending_agents: null },
    { end: "not_recorded", asks: false, pending_agents: null },
    { end: "end_turn", asks: true, pending_agents: null },
  ])
})

test("Claude Code: a turn that ends on an API error is rate_limit for a 429 or a rate_limit error, else api_error; the error's own text is no reply", async () => {
  const facts = await deriveClaude([
    prompt(0), reply(1, ASK_REPLY, "tool_use"), apiError(2, 429, "rate_limit"),
    prompt(10), apiError(11, undefined, "rate_limit"),
    prompt(20), apiError(21, undefined, "server_error"),
    prompt(30), apiError(31, 400, "unknown"),
    prompt(40), apiError(41, undefined, "authentication_failed"),
    // A retry that succeeded: the last reply decides.
    prompt(50), apiError(51, 529, "overloaded"), reply(52, DONE_REPLY),
    prompt(60),
  ])
  assert.deepEqual(waits(facts).map((wait) => wait.stop), [
    { end: "rate_limit", asks: true, pending_agents: null },
    { end: "rate_limit", asks: null, pending_agents: null },
    { end: "api_error", asks: null, pending_agents: null },
    { end: "api_error", asks: null, pending_agents: null },
    { end: "api_error", asks: null, pending_agents: null },
    { end: "end_turn", asks: false, pending_agents: null },
  ])
})

test("Claude Code: a turn with no reply text says nothing about a question mark, and a synthetic reply is not the agent's", async () => {
  const synthetic = { ...reply(12, ASK_REPLY), message: { id: "m-s", model: "<synthetic>", stop_reason: "stop_sequence", content: [{ type: "text", text: ASK_REPLY }] } }
  const thinking = { ...base(22), type: "assistant", message: { id: "m-t", model: "claude-opus-5-5", stop_reason: null, content: [{ type: "thinking", thinking: PLAN }] } }
  const facts = await deriveClaude([
    prompt(0), toolUse(1, "t1", "Read", { file_path: "/tmp/a" }), toolResult(2, "t1", PLAN),
    prompt(10), reply(11, DONE_REPLY), synthetic,
    prompt(20), reply(21, ASK_REPLY), thinking,
    prompt(30),
  ])
  assert.deepEqual(waits(facts).map((wait) => wait.stop), [
    { end: "not_recorded", asks: null, pending_agents: null },
    { end: "end_turn", asks: false, pending_agents: null },
    // A thinking-only line ends the message with no stop reason, so the end is not recorded; the last text still ended in a question mark.
    { end: "not_recorded", asks: true, pending_agents: null },
  ])
})

test("Claude Code: the operator's interrupt makes both the wait it ends and the wait it starts interrupted", async () => {
  const facts = await deriveClaude([
    prompt(0), toolUse(1, "t1", "Bash", { command: "sleep 100" }), toolResult(5, "t1", DONE_REPLY), interrupt(6, true),
    prompt(20), reply(21, DONE_REPLY), interrupt(22),
    prompt(30), reply(31, ASK_REPLY),
    prompt(40),
  ])
  assert.deepEqual(waits(facts), [
    { kind: "human_wait", agent: 0, start: ts(5), end: ts(6), stop: { end: "interrupted", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: ts(6), end: ts(20), stop: { end: "interrupted", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: ts(21), end: ts(22), stop: { end: "interrupted", asks: false, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: ts(22), end: ts(30), stop: { end: "interrupted", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: ts(31), end: ts(40), stop: { end: "end_turn", asks: true, pending_agents: null } },
  ])
})

test("Claude Code: the agent working again after an interrupt ends the interrupted run", async () => {
  const facts = await deriveClaude([
    prompt(0), reply(1, DONE_REPLY), interrupt(2), reply(3, ASK_REPLY),
    prompt(10),
  ])
  assert.deepEqual(waits(facts).map((wait) => wait.stop), [
    { end: "interrupted", asks: false, pending_agents: null },
    { end: "end_turn", asks: true, pending_agents: null },
  ])
})

test("Claude Code: an open AskUserQuestion or ExitPlanMode call is a human wait spanning the call, with no text and no tool name", async () => {
  const facts = await deriveClaude([
    prompt(0),
    toolUse(1, "q1", "AskUserQuestion", { questions: [{ question: QUESTION, options: [{ label: ANSWER }] }] }),
    toolResult(40, "q1", ANSWER, { toolUseResult: { answers: { [QUESTION]: ANSWER } } }),
    toolUse(41, "p1", "ExitPlanMode", { plan: PLAN }),
    { ...toolResult(90, "p1", ANSWER), message: { role: "user", content: [{ type: "tool_result", tool_use_id: "p1", is_error: true, content: ANSWER }] } },
    reply(91, DONE_REPLY),
    prompt(100),
  ])
  assert.deepEqual(waits(facts), [
    { kind: "human_wait", agent: 0, start: ts(1), end: ts(40), stop: { end: "ask_question", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: ts(41), end: ts(90), stop: { end: "ask_plan", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: ts(91), end: ts(100), stop: { end: "end_turn", asks: false, pending_agents: null } },
  ])
  // The calls stay tool intervals too: the reports decide how the time counts.
  assert.deepEqual(facts.intervals.filter((interval) => interval.kind === "tool").map(({ tool, outcome }) => ({ tool, outcome })), [
    { tool: "other", outcome: "ok" },
    { tool: "plan", outcome: "error" },
  ])
})

test("Claude Code: an ask call with no answer, or one a subagent made, is no human wait", async () => {
  const facts = await deriveClaude(
    [prompt(0), toolUse(1, "q1", "AskUserQuestion", { questions: [{ question: QUESTION }] })],
    [{ stem: "agent-1", lines: [
      { ...base(2), type: "user", message: { role: "user", content: PROMPT } },
      toolUse(3, "q2", "AskUserQuestion", { questions: [{ question: QUESTION }] }),
      toolResult(9, "q2", ANSWER),
    ] }],
  )
  assert.deepEqual(waits(facts), [])
})

test("Claude Code: a session's own creating call marks its PR created; a PR seen only through a pr-link is not", async () => {
  const pr = (second, repo, number) => ({ ...base(second), type: "pr-link", prRepository: repo, prNumber: number, prUrl: `https://github.com/${repo}/pull/${number}` })
  const facts = await deriveClaude([
    prompt(0),
    toolUse(1, "c1", "Bash", { command: "gh pr create" }),
    toolResult(2, "c1", DONE_REPLY, { toolUseResult: { stdout: DONE_REPLY, gitOperation: { pr: { number: 7, url: "https://github.com/o/r/pull/7", action: "created" } } } }),
    pr(3, "o/r", 7),
    toolUse(4, "c2", "Bash", { command: "gh pr merge 8" }),
    toolResult(5, "c2", DONE_REPLY, { toolUseResult: { stdout: DONE_REPLY, gitOperation: { pr: { number: 8, url: "https://github.com/o/r/pull/8", action: "merged" } } } }),
    pr(6, "o/r", 9),
  ])
  assert.deepEqual(facts.refs.prs, [
    { repo: "o/r", number: 7, agent: 0, at_ms: 2000, created: true },
    { repo: "o/r", number: 8, agent: 0, at_ms: 5000, created: false },
    { repo: "o/r", number: 9, agent: 0, at_ms: 6000, created: false },
  ])
})

test("dedupePrRefs keeps created as a plain boolean, true only when a creating ref exists", () => {
  const ref = (agent, created) => ({ repo: "o/r", number: 1, agent, ...(created === undefined ? {} : { created }) })
  assert.deepEqual(dedupePrRefs([ref(0, false), ref(2, true)]), [{ repo: "o/r", number: 1, agent: 2, created: true }])
  assert.deepEqual(dedupePrRefs([ref(0, false)]), [{ repo: "o/r", number: 1, agent: 0, created: false }])
  assert.deepEqual(dedupePrRefs([ref(0)]), [{ repo: "o/r", number: 1, agent: 0, created: false }])
})

// ---------------------------------------------------------------------------
// Copilot CLI
// ---------------------------------------------------------------------------

const COPILOT_SESSION = "4d5e6f70-8b9c-4dae-9f10-2b3c4d5e6f70"
const cts = (second) => new Date(Date.parse("2026-09-25T08:00:00.000Z") + second * 1000).toISOString()

function copilotEvents() {
  let n = 0
  return (type, second, data = {}, extra = {}) => ({ type, data, id: `00000000-0000-4000-8000-${(n += 1).toString(16).padStart(12, "0")}`, timestamp: cts(second), parentId: null, ...extra })
}

async function deriveCopilot(events) {
  const home = mkdtempSync(path.join(os.tmpdir(), "desk-stop-facts-copilot-"))
  try {
    const dir = path.join(home, "session-state", COPILOT_SESSION)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`)
    const result = await deriveCopilotSession({ sessionId: COPILOT_SESSION, copilotHome: home, resolveCommits: () => ({ origin: null, fulls: [] }), plugins: PLUGINS, endReason: "complete" })
    assert.deepEqual(validateLocalFacts(result.facts).errors, [])
    assertNoText(result.facts)
    return result.facts
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}

test("Copilot CLI: a wait carries end_turn, or interrupted after the operator's abort, whether the last reply asked, and no pending-agent fact", async () => {
  const ev = copilotEvents()
  const turn = (start, end, id, text, tools = false) => [
    ev("assistant.turn_start", start, { turnId: id, interactionId: `i-${id}` }),
    ev("assistant.message", start + 1, { messageId: `m-${id}`, content: text }),
    ...(tools ? [ev("assistant.message", start + 2, { messageId: `t-${id}`, toolRequests: [{ toolCallId: "x" }] })] : []),
    ev("assistant.turn_end", end, { turnId: id }),
  ]
  const facts = await deriveCopilot([
    ev("session.start", 0, { sessionId: COPILOT_SESSION, copilotVersion: "1.0.88", context: { cwd: "/tmp/w" } }),
    ev("user.message", 1, { content: PROMPT }),
    ...turn(2, 5, "1", `${ASK_REPLY}\n`, true),
    ev("user.message", 10, { content: ANSWER }),
    ...turn(11, 14, "2", DONE_REPLY),
    ev("abort", 15, { reason: "user_abort" }),
    ev("user.message", 20, { content: PROMPT }),
    ev("assistant.turn_start", 21, { turnId: "3", interactionId: "i-3" }),
    ev("assistant.turn_end", 22, { turnId: "3" }),
    ev("user.message", 30, { content: PROMPT }),
    // A subagent's abort is not the operator's interrupt of the root.
    ...turn(31, 34, "4", ASK_REPLY),
    ev("abort", 35, { reason: "user_abort" }, { agentId: "sub-1" }),
    ev("user.message", 40, { content: PROMPT }),
  ])
  assert.deepEqual(facts.intervals.filter((interval) => interval.kind === "human_wait"), [
    { kind: "human_wait", agent: 0, start: cts(5), end: cts(10), stop: { end: "end_turn", asks: true, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: cts(14), end: cts(20), stop: { end: "interrupted", asks: false, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: cts(22), end: cts(30), stop: { end: "end_turn", asks: null, pending_agents: null } },
    { kind: "human_wait", agent: 0, start: cts(34), end: cts(40), stop: { end: "end_turn", asks: true, pending_agents: null } },
  ])
})
