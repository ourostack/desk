// Claude Code deriver tests, run against the synthetic fixtures built by
// `fixtures/claude/make.js`. No fixture line, prompt, tool input or tool
// output was copied from a real transcript — everything here is invented,
// and every free-text field in the fixtures carries `SENTINEL` so the
// privacy test below can assert it never reaches the derived facts.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deriveClaudeSession } from "../../../../../plugins/desk/mcp/src/factory/derive-claude.js"
import { hostFlagsFor } from "../../../../../plugins/desk/mcp/src/factory/host-flags.js"
import * as common from "../../../../../plugins/desk/mcp/src/factory/derive-common.js"
import { validateLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/schema.js"
import {
  SENTINEL,
  SPAWN_DESK_TASK_LINE,
  COMMIT_SHA,
  SESSION_IDS,
  NON_UUID_FILE_STEM,
  FULL_TURN_1_END,
  TRUNCATED_SKEWED_RESULT_AT,
} from "./fixtures/claude/make.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, "fixtures", "claude")
const transcriptPath = (sessionId) => path.join(fixturesDir, `${sessionId}.jsonl`)

const PLUGINS = [{ name: "desk", version: "3.2.0-alpha.21", source: "ourostack/desk" }]

function deriveFull(overrides = {}) {
  return deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.full),
    plugins: PLUGINS,
    endReason: "prompt_input_exit",
    ...overrides,
  })
}

function findInterval(intervals, predicate) {
  return intervals.filter(predicate)
}

// --- Missing transcript / unusable envelope ---------------------------------

test("a missing transcript returns facts: null, events: null, reason: log_missing", async () => {
  const result = await deriveClaudeSession({
    transcriptPath: path.join(fixturesDir, "does-not-exist.jsonl"),
    plugins: PLUGINS,
    endReason: null,
  })
  assert.deepEqual(result, { facts: null, events: null, reason: "log_missing" })
})

test("a transcript with no root line yielding both a valid timestamp and a valid version returns source_unreadable", async () => {
  const result = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.noEnvelope),
    plugins: PLUGINS,
    endReason: null,
  })
  assert.deepEqual(result, { facts: null, events: null, reason: "source_unreadable" })
})

test("a transcript whose file name is not a session UUID returns source_unreadable, never an invalid session.id", async () => {
  const result = await deriveClaudeSession({
    transcriptPath: path.join(fixturesDir, `${NON_UUID_FILE_STEM}.jsonl`),
    plugins: PLUGINS,
    endReason: "clear",
  })
  assert.deepEqual(result, { facts: null, events: null, reason: "source_unreadable" })
})

// --- Privacy: no raw content reaches facts ----------------------------------

test("no sentinel from the fixture's messages, prompts, thinking, tool input, tool output, cwd, gitBranch, hook name, queued command or agentType reaches the serialized facts", async () => {
  const { facts, events } = await deriveFull()
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
  // The sentinel is expected to survive into the in-memory binding events
  // (track/slug/file paths never leave the machine) — confirms the fixture
  // actually planted it somewhere the facts assertion above would have caught.
  assert.equal(JSON.stringify(events).includes(SENTINEL), true)
})

test("the deriver writes local facts: the local schema value, no contributor, no commit refs", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.schema, "desk.factory.local/2")
  assert.equal(Object.hasOwn(facts, "contributor"), false)
  assert.deepEqual(facts.refs.commits, [])
})

test("the derived facts pass validateLocalFacts and carry no sentinel, for every fixture variant", async () => {
  const variants = [
    { transcriptPath: transcriptPath(SESSION_IDS.full), endReason: "prompt_input_exit" },
    { transcriptPath: transcriptPath(SESSION_IDS.full), endReason: null },
    { transcriptPath: transcriptPath(SESSION_IDS.truncated), endReason: "clear" },
    { transcriptPath: transcriptPath(SESSION_IDS.truncated), endReason: null },
    { transcriptPath: transcriptPath(SESSION_IDS.unreadable), endReason: null },
    { transcriptPath: transcriptPath(SESSION_IDS.unreadable), endReason: "complete" },
    { transcriptPath: transcriptPath(SESSION_IDS.oddShapes), endReason: null },
    { transcriptPath: transcriptPath(SESSION_IDS.oddShapes), endReason: "error" },
  ]
  for (const variant of variants) {
    const { facts } = await deriveClaudeSession({ plugins: PLUGINS, ...variant })
    const result = validateLocalFacts(facts)
    assert.deepEqual(result.errors, [], variant.transcriptPath)
    assert.equal(result.ok, true, variant.transcriptPath)
    assert.equal(JSON.stringify(facts).includes(SENTINEL), false, variant.transcriptPath)
  }
})

// --- Critical 1: unexpected line shapes must not throw or lose the session --

test("string message content, a missing message field, a non-GitHub PR URL and a subagent with no meta.json are all handled without crashing", async () => {
  // The whole derivation for the "full" fixture already exercises every one
  // of these lines (a string-content typed prompt, a bare `{type:"user"}`
  // line with no `message` at all, an Azure DevOps gitOperation.pr.url, and
  // agent-a3 with no agent-a3.meta.json) — reaching this line at all proves
  // none of them threw. The non-GitHub PR must not appear as a ref, and the
  // metaless subagent must still be counted as an agent.
  const { facts } = await deriveFull()
  assert.equal(facts.refs.prs.some((ref) => ref.number === 99), false)
  const metaless = facts.agents.find((agent) => agent.n === 3)
  assert.deepEqual(metaless, { n: 3, parent: 0, model: "claude-sonnet-5" })
})

test("odd but parseable shapes (non-object lines, non-numeric usage, missing input/usage/file_path, bad tool_use_id, untimed errors, free-text pr-link, untimed or pathless deltas) never throw or leak, and still validate", async () => {
  const { facts, events } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.oddShapes),
    plugins: PLUGINS,
    endReason: null,
  })
  assert.deepEqual(validateLocalFacts(facts).errors, [])
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
  // Back-to-back prompts: the first turn has no activity and ends where it starts.
  const turns = findInterval(facts.intervals, (iv) => iv.kind === "turn")
  assert.equal(turns[0].start, turns[0].end)
  // A missing usage object is unknown, not 0, so the cache totals are unknown too; "12" and -3 are no counts, so the input and output totals are unknown.
  assert.deepEqual(facts.models, [{ id: "claude-opus-5-5", requests: 3, tokens: { input: null, output: null, cache_read: null, cache_write: null, reasoning: null } }])
  assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "field_absent"))
  assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "source_unreadable"))
  // Both retryable errors count; neither can form an interval.
  assert.equal(facts.counts.api_retries, 2)
  assert.deepEqual(findInterval(facts.intervals, (iv) => iv.kind === "api_retry"), [])
  // The input-less Bash and path-less Write still pair and count.
  assert.deepEqual(facts.counts.tool_calls, { shell: 1, edit: 1 })
  assert.deepEqual(facts.refs.prs, [])
  assert.deepEqual(events.fileWrites, [])
  // The orphan call, the invalid model and the truncated last line live only
  // in the subagent, whose meta.json is valid JSON but not an object.
  assert.deepEqual(facts.agents, [{ n: 0, parent: null, model: "claude-opus-5-5" }, { n: 1, parent: 0, model: "unknown" }])
  assert.ok(facts.unavailable.some((entry) => entry.field === "models" && entry.reason === "source_unreadable"))
  assert.ok(facts.unavailable.some((entry) => entry.field === "tool_durations" && entry.reason === "session_open"))
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "turns"), [{ field: "turns", reason: "log_truncated" }])
})

// --- Important 1: transcript values are validated before use ---------------

test("isApiErrorMessage lines and the <synthetic> model are excluded from usage, requests and root-model choice, but still counted in api_retries", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.models.some((model) => model.id === "<synthetic>"), false)
  assert.equal(facts.agents[0].model, "claude-opus-5-5")
  assert.equal(facts.counts.api_retries, 1)
})

test("a subagent whose model resolves from its own lines does not mark models unavailable, even with no meta.json", async () => {
  const { line, assistant } = workerLines()
  const { facts } = await deriveWithSubagents(
    [line({ type: "user", message: { role: "user", content: "go" } }), assistant("r1", "claude-opus-5-5")],
    [{ stem: "agent-1", lines: [assistant("s1", "claude-sonnet-5", [{ type: "text", text: "hi" }])] }],
  )
  assert.equal(facts.agents[1].model, "claude-sonnet-5")
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "models"), [])
})

test("a subagent meta model of `inherit` is no request and no fallback model", async () => {
  const { line, assistant } = workerLines()
  const root = [line({ type: "user", message: { role: "user", content: "go" } }), assistant("r1", "claude-opus-5-5")]
  const own = await deriveWithSubagents(root, [{ stem: "agent-1", meta: { agentType: "fork", model: "inherit" }, lines: [assistant("s1", "claude-sonnet-5", [{ type: "text", text: "hi" }])] }])
  assert.deepEqual(own.facts.agents[1], { n: 1, parent: 0, model: "claude-sonnet-5", agent_type: "fork" })
  const bare = await deriveWithSubagents(root, [{ stem: "agent-1", meta: { agentType: "fork", model: "inherit" }, lines: [line({ type: "user", message: { role: "user", content: "hi" } })] }])
  assert.deepEqual(bare.facts.agents[1], { n: 1, parent: 0, model: "unknown", agent_type: "fork" })
})

test("a subagent whose model resolves nowhere still marks models unavailable (source_unreadable)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-claude-unresolved-"))
  try {
    const root = path.join(dir, `${SUB_SESSION_ID}.jsonl`)
    const base = { sessionId: SUB_SESSION_ID, version: "2.1.282", timestamp: "2026-09-25T08:00:00.000Z" }
    writeFileSync(root, `${JSON.stringify({ ...base, type: "user", message: { role: "user", content: "go" } })}\n`)
    mkdirSync(path.join(dir, SUB_SESSION_ID, "subagents"), { recursive: true })
    writeFileSync(path.join(dir, SUB_SESSION_ID, "subagents", "agent-1.jsonl"), `${JSON.stringify({ ...base, type: "user", message: { role: "user", content: "hi" } })}\n`)
    const { facts } = await deriveClaudeSession({ transcriptPath: root, plugins: PLUGINS, endReason: "prompt_input_exit" })
    assert.equal(facts.agents[1].model, "unknown")
    assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "models"), [{ field: "models", reason: "source_unreadable" }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a real (non-synthetic) model that fails the model-id pattern is dropped, not put through invalid", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.models.some((model) => model.id === "not a valid model id!"), false)
  const opus = facts.models.find((model) => model.id === "claude-opus-5-5")
  // msg-bad-model's usage (9, 9, 0, 0) must not have been folded in.
  assert.equal(opus.requests, 16)
})

test("a tool_result with an unparseable timestamp drops the call entirely: no interval, no count, no crash", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.counts.tool_calls.search, undefined)
  assert.equal(findInterval(facts.intervals, (iv) => iv.kind === "tool" && iv.tool === "search").length, 0)
})

// --- Important 2: streaming, not buffering ----------------------------------
// See the dedicated memory-probe test file (`derive_claude_memory.test.js`):
// it spawns a child process with `--expose-gc` against a large generated
// transcript and asserts heap growth stays under 64 MiB.

// --- Important 3: an unusable envelope is source_unreadable, not invented --

test("a zero-usable-envelope transcript never invents a host version, start time or end time", async () => {
  const result = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.noEnvelope),
    plugins: PLUGINS,
    endReason: "clear",
  })
  assert.equal(result.facts, null)
  assert.equal(result.events, null)
  assert.equal(result.reason, "source_unreadable")
})

// --- Important 4: the human-prompt ruling -----------------------------------

test("a typed human prompt (string content, promptSource sdk, origin.kind human) starts turn 1, which ends at the last assistant line before the next human prompt", async () => {
  const { facts } = await deriveFull()
  const turns = findInterval(facts.intervals, (iv) => iv.kind === "turn" && iv.agent === 0)
  assert.equal(turns[0].start, "2026-09-25T08:00:00.000Z")
  // The 400 API-error line, written with a `+00:00` offset and normalized
  // back to the strict shape; the injected task-notification line after it
  // is not activity and must not extend the turn.
  assert.equal(turns[0].end, FULL_TURN_1_END)
})

test("a subagent's task prompt and its SendMessage resume make two subagent turns but no human_wait (Minor 9)", async () => {
  const { facts } = await deriveFull()
  const agent1Turns = findInterval(facts.intervals, (iv) => iv.kind === "turn" && iv.agent === 1)
  assert.deepEqual(agent1Turns.map((iv) => [iv.start, iv.end]), [
    ["2026-09-25T08:00:12.500Z", "2026-09-25T08:00:16.500Z"],
    ["2026-09-25T08:00:17.500Z", "2026-09-25T08:00:18.500Z"],
  ])
  assert.deepEqual(findInterval(facts.intervals, (iv) => iv.kind === "human_wait" && iv.agent !== 0), [])
})

test("isMeta, isCompactSummary, promptSource:system/origin:task-notification, and a non-human origin.kind are all excluded from turns", async () => {
  const { facts } = await deriveFull()
  const turns = findInterval(facts.intervals, (iv) => iv.kind === "turn" && iv.agent === 0)
  const waits = findInterval(facts.intervals, (iv) => iv.kind === "human_wait")
  // Exactly 3 real human prompts in the fixture (turn 1, turn 2, and the
  // degenerate turn 3) despite 5 more user lines shaped like a prompt that
  // must each be excluded by one of the ruling's conditions.
  assert.equal(turns.length, 3)
  assert.equal(waits.length, 2)
  assert.equal(waits[0].start, turns[0].end)
  assert.equal(turns[1].start, waits[0].end)
  assert.equal(waits[1].start, turns[1].end)
  assert.equal(turns[2].start, waits[1].end)
  // Turn 3's prompt has nothing after it at all: a degenerate turn whose end
  // equals its own start, since there is no later activity to bound it.
  assert.equal(turns[2].start, turns[2].end)
})

// --- Usage dedup and max-merge (Minor 8) ------------------------------------

test("usage duplicated across three streamed lines of one message id takes the MAX of each field, not the first or the last", async () => {
  const { facts } = await deriveFull()
  // msg-1a's three lines carry (30,10,5,2), (70,25,10,3), (100,40,8,2) for
  // (input, output, cache_read, cache_write) — the true per-field max is
  // (100, 40, 10, 3), which is neither the first nor the last line's values.
  const haiku = facts.models.find((model) => model.id === "claude-haiku-5")
  assert.equal(haiku.requests, 1)
  assert.equal(haiku.tokens.input, 100)
  assert.equal(haiku.tokens.output, 40)
  assert.equal(haiku.tokens.cache_read, 10)
  assert.equal(haiku.tokens.cache_write, 3)
  assert.equal(haiku.tokens.reasoning, null)
})

// --- Minor 4: root model picked by distinct message, not by line -----------

test("root model selection counts distinct messages, and a first-seen minority model must be genuinely overtaken by the majority", async () => {
  const { facts } = await deriveFull()
  // claude-haiku-5 is seen first (3 lines, 1 message); claude-opus-5-5 is
  // the majority across many distinct messages. Root must pick opus.
  assert.equal(facts.agents[0].model, "claude-opus-5-5")
  const opus = facts.models.find((model) => model.id === "claude-opus-5-5")
  assert.equal(opus.requests, 16)
})

// --- Tool outcomes, including the timedOutAfterMs: null regression ---------

test("interrupted, timeout, error and ok outcomes are reported on the right tool intervals; timedOutAfterMs: null is not a timeout", async () => {
  const { facts } = await deriveFull()
  const toolIntervals = findInterval(facts.intervals, (iv) => iv.kind === "tool" && iv.agent === 0)
  const byOutcome = (outcome) => toolIntervals.filter((iv) => iv.outcome === outcome)
  assert.equal(byOutcome("interrupted").length, 1)
  assert.equal(byOutcome("interrupted")[0].tool, "read")
  assert.equal(byOutcome("timeout").length, 1)
  assert.equal(byOutcome("timeout")[0].tool, "shell")
  // error: the first Bash call and the failed Edit.
  assert.equal(byOutcome("error").length, 2)
  // The timedOutAfterMs: null Bash call (tool-bash-4) must show up as "ok".
  const okShellCalls = byOutcome("ok").filter((iv) => iv.tool === "shell")
  // (Agent 0 only: agent 3's own Bash calls are asserted by the retry test.)
  assert.equal(okShellCalls.length, 3) // bash-2 (retry), bash-4 (null timeout), bash-5 (non-GitHub PR)
})

// --- Minor 7: tool_failures counts every non-ok outcome, Agent/Task calls
// count in tool_calls.agent, and the new "later call, same kind, starts
// after the failure ended" retry rule ---------------------------------------

test("tool_failures counts every outcome other than ok, and Agent calls count in tool_calls.agent", async () => {
  const { facts } = await deriveFull()
  // shell: 5 root + 5 in agent 3; read: root, agents 2, 3 and 4 (agent 1's
  // unresolved Read and agent 3's timeless Read are dropped); edit: Write,
  // failed Edit, NotebookEdit, agent 1's Edit; agent: Agent, SendMessage and
  // Task at the root, plus agent 4's nested Agent.
  assert.deepEqual(facts.counts.tool_calls, { shell: 10, read: 4, desk: 2, edit: 4, agent: 4 })
  // shell: root bash-1 (error) + bash-3 (timeout), agent 3's two errors;
  // read: read-1 (interrupted); edit: the failed Edit; agent: the failed Task.
  assert.deepEqual(facts.counts.tool_failures, { shell: 4, read: 1, edit: 1, agent: 1 })
})

test("a retry is a later same-kind call that starts after a failed call ended, even with a different kind in between", async () => {
  const { facts } = await deriveFull()
  // shell: bash-1(error) -> read-1(interrupted, different kind) -> bash-2(ok) is a retry;
  //        bash-3(timeout) -> bash-4(ok) is a retry (timeout counts as a failure now, not just error);
  //        bash-4(ok) -> bash-5(ok) is not (bash-4 succeeded).
  // edit: write-1(ok) -> edit-fail(error) -> notebook-1(ok) is a retry.
  // agent 3: a Bash call starting at the very instant a failed one ended is
  //          not a retry; two parallel Bash calls after the next failure
  //          count one retry, not two.
  assert.equal(facts.counts.tool_retries, 4)
})

test("every Agent/Task call becomes a subagent interval, not a tool interval, at every nesting depth and even with no transcript; SendMessage stays a tool interval", async () => {
  const { facts } = await deriveFull()
  const subagentIntervals = findInterval(facts.intervals, (iv) => iv.kind === "subagent")
  // In start order: agent 4's nested Agent (spawned agent-a2), the root
  // Agent (spawned agent-a1), and the root Task (failed, no transcript).
  assert.equal(subagentIntervals.length, 3)
  assert.deepEqual(subagentIntervals.map((iv) => iv.agent), [4, 0, 0])
  for (const interval of subagentIntervals) {
    assert.equal("tool" in interval, false)
    assert.equal("outcome" in interval, false)
  }
  const agentToolIntervals = findInterval(facts.intervals, (iv) => iv.kind === "tool" && iv.tool === "agent")
  assert.deepEqual(agentToolIntervals.map((iv) => [iv.agent, iv.outcome]), [[0, "ok"]])
})

// --- Minor 2: subagent nesting -----------------------------------------------

test("a depth-2 subagent gets the agent that spawned it as parent, even when its file sorts before the parent's", async () => {
  const { facts } = await deriveFull()
  assert.deepEqual(facts.agents, [
    { n: 0, parent: null, model: "claude-opus-5-5" },
    // The resolved model is what the worker's own lines used; the requested one is the meta's alias.
    { n: 1, parent: 0, model: "claude-sonnet-5", agent_type: "Explore", requested_model: "sonnet" },
    // agent-a2 was spawned by agent-a4's Agent call (n 4, read after it).
    // A subagent's model is what its own assistant lines used, before its meta.
    { n: 2, parent: 4, model: "claude-opus-5-5", agent_type: "general-purpose", requested_model: "claude-opus-4-1" },
    // agent-a3 has no meta.json at all; agent-a4 has one, but its toolUseId
    // matches no call — both fall back to parent 0, for different reasons,
    // and both still count. agent-a4's meta values fail the local patterns, so neither key is stored.
    { n: 3, parent: 0, model: "claude-sonnet-5" },
    { n: 4, parent: 0, model: "claude-sonnet-5" },
  ])
})

test("the root worker has no agent_type and no requested_model, and the facts validate", async () => {
  const { facts } = await deriveFull()
  assert.equal(Object.hasOwn(facts.agents[0], "agent_type"), false)
  assert.equal(Object.hasOwn(facts.agents[0], "requested_model"), false)
  assert.deepEqual(validateLocalFacts(facts).errors, [])
})

test("a subagent meta value that fails its local pattern is left out, and a worker with no meta has neither key; descriptions never enter facts", async () => {
  const { facts } = await deriveFull()
  assert.equal(Object.hasOwn(facts.agents[3], "agent_type"), false)
  assert.equal(Object.hasOwn(facts.agents[3], "requested_model"), false)
  assert.equal(Object.hasOwn(facts.agents[4], "agent_type"), false)
  assert.equal(Object.hasOwn(facts.agents[4], "requested_model"), false)
  assert.equal(JSON.stringify(facts).includes("investigate something"), false)
  assert.equal(JSON.stringify(facts).includes("nested investigation"), false)
})

test("a tool_use with no matching tool_result anywhere is dropped from intervals and counts, not fabricated", async () => {
  const { facts } = await deriveFull()
  // agent 1 (agent-a1) issued a Read that never resolved: only its Edit
  // call (and the nested Agent spawn) become intervals.
  const agent1Tools = findInterval(facts.intervals, (iv) => iv.kind === "tool" && iv.agent === 1)
  assert.equal(agent1Tools.length, 1)
  assert.equal(agent1Tools[0].tool, "edit")
})

test("unavailable gets tool_durations when an orphan tool_use exists, keyed to whether the session has ended", async () => {
  const { facts } = await deriveFull()
  assert.deepEqual(
    facts.unavailable.filter((entry) => entry.field === "tool_durations"),
    [{ field: "tool_durations", reason: "log_truncated" }],
  )
})

// --- Refs --------------------------------------------------------------------

test("pr-link and gitOperation.pr refs are deduplicated and sorted by repo then number; a non-GitHub URL is dropped", async () => {
  const { facts } = await deriveFull()
  assert.deepEqual(facts.refs.prs, [
    { repo: "another-org/repo", number: 3, agent: 0, at_ms: 37000 },
    { repo: "ourostack/desk", number: 7, agent: 0, at_ms: 36000 },
    { repo: "ourostack/desk", number: 42, agent: 0, at_ms: 18000 },
  ])
  assert.deepEqual(facts.refs.commits, [])
})

// --- Compactions ---------------------------------------------------------------

test("a compact_boundary system line counts one compaction; a different subtype does not", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.counts.compactions, 1)
})

// --- Binding events (never written, only ever in memory) ---------------------

test("Desk task_update and task_create tool calls become binding events, not facts", async () => {
  const { events } = await deriveFull()
  assert.equal(events.deskToolCalls.length, 2)
  const update = events.deskToolCalls.find((call) => call.name === "mcp__plugin_desk_desk__task_update")
  assert.equal(update.track, `${SENTINEL}-track`)
  assert.equal(update.slug, `${SENTINEL}-slug`)
  assert.equal(update.person, null)
  assert.equal(update.status, "processing")
  assert.equal(update.ok, true)

  const create = events.deskToolCalls.find((call) => call.name === "mcp__plugin_desk_desk__task_create")
  assert.equal(create.track, `${SENTINEL}-track2`)
  assert.equal(create.slug, `${SENTINEL}-slug2`)
  assert.equal(create.person, null)
  assert.equal(create.status, null)
  assert.equal(create.ok, true)
})

test("Minor 6: only writes whose paired result succeeded become fileWrites; NotebookEdit uses notebook_path", async () => {
  const { events } = await deriveFull()
  assert.equal(events.fileWrites.length, 4)
  assert.ok(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-path/file.txt`))
  assert.ok(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-notebook.ipynb`))
  assert.ok(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-tracked/path.txt`))
  assert.ok(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-sub-edit-path`))
  // The failed Edit must not have bound a write.
  assert.equal(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-failed-edit-path`), false)
})

test("a 40-hex token in a Bash result's stdout becomes a commitShas event, deduplicated", async () => {
  const { events } = await deriveFull()
  assert.deepEqual(events.commitShas, [COMMIT_SHA])
})

// --- Shell git commit calls (matched to the desk's own commits by time) ------

// The commit message and every other argument carry this; only directories
// may come back, and never into facts.
const COMMIT_MESSAGE_SENTINEL = "COMMIT-MESSAGE-SENTINEL-9b1e"
const SUB_SESSION_ID = "2a3b4c5d-6e7f-4809-9a0b-1c2d3e4f5a6b"
const GIT_SESSION_ID = "1f2e3d4c-5b6a-4798-8a9b-0c1d2e3f4a5b"

async function deriveLines(lines, endReason = "prompt_input_exit") {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-claude-shell-git-"))
  try {
    const transcript = path.join(dir, `${GIT_SESSION_ID}.jsonl`)
    writeFileSync(transcript, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
    return await deriveClaudeSession({ transcriptPath: transcript, plugins: PLUGINS, endReason })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function shellGitSession() {
  let second = 0
  const line = (extra) => ({ sessionId: GIT_SESSION_ID, version: "2.1.282", cwd: `/tmp/${SENTINEL}-cwd`, timestamp: `2026-09-25T08:00:${String(second++).padStart(2, "0")}.000Z`, ...extra })
  const bash = (id, command, extra = {}) => line({ type: "assistant", message: { id: `m-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Bash", input: { command, description: COMMIT_MESSAGE_SENTINEL } }] }, ...extra })
  const result = (id, isError = false, extra = {}) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: `[main 1a2b3c4] ${COMMIT_MESSAGE_SENTINEL}` }] }, toolUseResult: { stdout: COMMIT_MESSAGE_SENTINEL, stderr: "" }, ...extra })
  const m = COMMIT_MESSAGE_SENTINEL
  const answered = (id, content, extra = {}) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: false, content }] }, ...extra })
  return [
    line({ type: "user", message: { role: "user", content: `commit it ${SENTINEL}` } }),
    bash("b1", `git add -A && git commit -q -m "${m}"`), // 01
    result("b1"), // 02
    bash("b2", `git -C /tmp/${SENTINEL}-desk commit -q -m "${m}"`), // 03
    result("b2"), // 04
    bash("b3", `cd /tmp/${SENTINEL}-other && git -c user.name="${m}" commit -m '${m}'`, { cwd: undefined }), // 05
    result("b3"), // 06
    bash("b4", `git status ${m}`), // 07
    result("b4"), // 08
    bash("b5", `git commit -m "${m}"`, { cwd: 7 }), // 09
    result("b5"), // 10
    line({ type: "assistant", message: { id: "m-b6", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "b6", name: "Bash", input: { command: 42 } }] } }), // 11
    result("b6"), // 12
    line({ type: "assistant", message: { id: "m-b7", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "b7", name: "Write", input: { file_path: `/tmp/${SENTINEL}-x`, content: `git commit -m ${m}` } }] } }), // 13
    result("b7"), // 14
    bash("b8", `git commit -m "${m}"`, { timestamp: "not a time" }), // 15: no readable start
    result("b8"), // 16
    bash("b9", `git commit -m "${m}"`), // 17
    result("b9", false, { timestamp: "not a time" }), // 18: no readable end
    bash("b11", `git commit -m "${m}"`), // 19
    result("b11", true), // 20: a failed call
    bash("b12", `git commit -m "${m}"`), // 21
    answered("b12", `Exit code 1\nnothing to commit, working tree clean ${m}`), // 22: a no-op commit
    bash("b13", `git commit -m "${m}"`), // 23
    answered("b13", [{ type: "text", text: `Exit code 0 ${m}` }]), // 24
    bash("b14", `git commit -m "${m}"`), // 25
    answered("b14", [{ type: "image" }]), // 26
    bash("b15", `git commit -m "${m}"`), // 27
    answered("b15", [{ type: "text", text: 5 }]), // 28
    bash("b16", `git commit -m "${m}"`), // 29
    answered("b16", m, { toolUseResult: { interrupted: true } }), // 30: interrupted
    bash("b10", `git commit -m "${m}"`), // 31: never answered
  ]
}

test("only a successful Bash git commit call becomes a shellGitCommits event, with its start, end and directory", async () => {
  const { facts, events } = await deriveLines(shellGitSession())
  const base = `/tmp/${SENTINEL}-cwd`
  const span = (from, to, cwd) => ({ start: `2026-09-25T08:00:${from}.000Z`, end: `2026-09-25T08:00:${to}.000Z`, cwd, paths: [], agent: 0 })
  assert.deepEqual(events.shellGitCommits, [
    span("01", "02", base),
    span("03", "04", `/tmp/${SENTINEL}-desk`),
    span("05", "06", `/tmp/${SENTINEL}-other`),
    span("09", "10", null),
    span("23", "24", base),
    span("25", "26", base),
    span("27", "28", base),
  ], "a failed, no-op or interrupted call gives none")
  assert.deepEqual(events.nativeCommitShas, [], "Claude Code records no native commit refs")
  assert.equal(validateLocalFacts(facts).ok, true)
})

test("sentinel: a git commit command's text (message, options, other arguments) never reaches facts or events", async () => {
  const { facts, events } = await deriveLines(shellGitSession())
  assert.equal(JSON.stringify(facts).includes(COMMIT_MESSAGE_SENTINEL), false)
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
  assert.equal(JSON.stringify(events.shellGitCommits).includes(COMMIT_MESSAGE_SENTINEL), false)
  assert.equal(JSON.stringify(events).includes("git"), false, "not even the command name is kept")
})

test("the full fixture's Bash calls hold no git commit, so its shellGitCommits is empty", async () => {
  const { events } = await deriveFull()
  assert.deepEqual(events.shellGitCommits, [])
})

// --- session envelope ---------------------------------------------------------

test("session id, host_version and entrypoint come from the transcript; ended_at is set when endReason is given", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.session.host, "claude-code")
  assert.equal(facts.session.id, SESSION_IDS.full)
  assert.equal(facts.session.host_version, "2.1.282")
  assert.equal(facts.session.entrypoint, "desktop")
  assert.equal(facts.session.end_reason, "prompt_input_exit")
  assert.equal(facts.session.ended_at, facts.session.derived_through)
  assert.equal(facts.unavailable.some((entry) => entry.field === "ended_at"), false)
})

test("entrypoint cli and sdk-* both map correctly", async () => {
  const truncated = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.truncated),
    plugins: PLUGINS,
    endReason: "clear",
  })
  assert.equal(truncated.facts.session.entrypoint, "cli")

  const unreadable = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.unreadable),
    plugins: PLUGINS,
    endReason: null,
  })
  assert.equal(unreadable.facts.session.entrypoint, "sdk")
})

test("an invalid endReason input is treated as null, per ENUMS.endReason", async () => {
  const result = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.truncated),
    plugins: PLUGINS,
    endReason: "not-a-real-reason",
  })
  assert.equal(result.facts.session.end_reason, null)
  assert.equal(result.facts.session.ended_at, null)
  assert.deepEqual(result.facts.unavailable.filter((entry) => entry.field === "ended_at"), [{ field: "ended_at", reason: "session_open" }])
})

// --- unavailable: unconditional entries -----------------------------------------

test("unavailable always covers permission_waits, ci_runs and commits", async () => {
  const { facts } = await deriveFull()
  assert.deepEqual(
    facts.unavailable.filter((entry) => ["permission_waits", "ci_runs", "commits"].includes(entry.field)),
    [
      // The host table now supplies commits and permission_waits first, so ci_runs follows them; each appears once.
      { field: "commits", reason: "host_does_not_record" },
      { field: "permission_waits", reason: "host_does_not_record" },
      { field: "ci_runs", reason: "not_collected_in_slice_1" },
    ],
  )
})

// --- Minor 5: truncation, ignoring blank lines, reported for any agent's file --

test("a truncated last line (ignoring a blank line in between) is reported as turns/log_truncated; a retryable 5xx with no later assistant line counts in api_retries but adds no interval", async () => {
  const { facts } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.truncated),
    plugins: PLUGINS,
    endReason: "clear",
  })
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "turns"), [{ field: "turns", reason: "log_truncated" }])
  assert.equal(facts.counts.api_retries, 1)
  assert.deepEqual(findInterval(facts.intervals, (iv) => iv.kind === "api_retry"), [])
  assert.equal(validateLocalFacts(facts).ok, true)
})

test("a tool result stamped before its own tool_use drops that interval with tool_durations/source_unreadable, and started_at is the earliest timestamp", async () => {
  const { facts } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.truncated),
    plugins: PLUGINS,
    endReason: "clear",
  })
  assert.equal(facts.session.started_at, TRUNCATED_SKEWED_RESULT_AT)
  assert.equal(facts.session.derived_through, "2026-09-25T09:00:03.000Z")
  assert.deepEqual(findInterval(facts.intervals, (iv) => iv.kind === "tool"), [])
  assert.deepEqual(facts.counts.tool_calls, { shell: 1 })
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "tool_durations"), [{ field: "tool_durations", reason: "source_unreadable" }])
  for (const interval of facts.intervals) assert.ok(interval.end >= interval.start)
})

// --- Caller-supplied plugins ----------------------------------------------------

test("plugin entries that fail the schema are dropped with plugins/source_unreadable; valid ones pass through unchanged", async () => {
  const derive = (plugins) => deriveClaudeSession({ transcriptPath: transcriptPath(SESSION_IDS.truncated), plugins, endReason: "clear" })
  const pluginsUnavailable = (facts) => facts.unavailable.filter((entry) => entry.field === "plugins")

  const clean = await derive(PLUGINS)
  assert.deepEqual(clean.facts.plugins, PLUGINS)
  assert.deepEqual(pluginsUnavailable(clean.facts), [])

  const messy = await derive([
    null,
    { name: `${SENTINEL} Bad Name`, version: "1.0.0" },
    { name: "desk", version: ["1.0.0"] },
    { name: "desk", version: `${SENTINEL}` },
    { name: "desk", version: "3.2.0-alpha.21", source: `${SENTINEL} not a repo` },
    { name: "desk", version: "3.2.0-alpha.21", extra: SENTINEL },
  ])
  assert.deepEqual(messy.facts.plugins, [{ name: "desk", version: "3.2.0-alpha.21", source: null }], "an unknown key is dropped; an invalid source drops the entry")
  assert.deepEqual(pluginsUnavailable(messy.facts), [{ field: "plugins", reason: "source_unreadable" }])
  assert.equal(JSON.stringify(messy.facts).includes(SENTINEL), false)
  assert.equal(validateLocalFacts(messy.facts).ok, true)

  // A marker written before sources were recorded carries none; its plugins read as having no known source.
  const old = await derive([{ name: "desk", version: "3.2.0-alpha.21" }, { name: "notes", version: "1.0.0", source: null }])
  assert.deepEqual(old.facts.plugins, [{ name: "desk", version: "3.2.0-alpha.21", source: null }, { name: "notes", version: "1.0.0", source: null }])
  assert.deepEqual(pluginsUnavailable(old.facts), [])
  assert.equal(validateLocalFacts(old.facts).ok, true)

  const missing = await derive(undefined)
  assert.deepEqual(missing.facts.plugins, [])
  assert.deepEqual(pluginsUnavailable(missing.facts), [{ field: "plugins", reason: "source_unreadable" }])

  const tooMany = await derive(Array.from({ length: 65 }, (_, index) => ({ name: `p${index}`, version: "1.0.0" })))
  assert.equal(tooMany.facts.plugins.length, 64)
  assert.deepEqual(pluginsUnavailable(tooMany.facts), [{ field: "plugins", reason: "capped" }])
  assert.equal(validateLocalFacts(tooMany.facts).ok, true)

  const tooManyAndBad = await derive([null, ...Array.from({ length: 65 }, (_, index) => ({ name: `p${index}`, version: "1.0.0" }))])
  assert.equal(tooManyAndBad.facts.plugins.length, 64)
  assert.deepEqual(pluginsUnavailable(tooManyAndBad.facts), [{ field: "plugins", reason: "source_unreadable" }, { field: "plugins", reason: "capped" }])
})

// --- No assistant lines / unreadable -------------------------------------------

test("a non-final malformed line with no assistant lines yields models: [] and models/source_unreadable, not log_truncated", async () => {
  const { facts } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.unreadable),
    plugins: PLUGINS,
    endReason: null,
  })
  assert.deepEqual(facts.models, [])
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "models"), [{ field: "models", reason: "source_unreadable" }])
  assert.equal(facts.unavailable.some((entry) => entry.field === "turns"), false)
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "ended_at"), [{ field: "ended_at", reason: "session_open" }])
  assert.equal(facts.session.ended_at, null)
  assert.equal(facts.counts.compactions, 1)
  // A tool_result for a tool_use id never seen is dropped, not crashed on.
  assert.deepEqual(facts.counts.tool_calls, {})
  assert.equal(validateLocalFacts(facts).ok, true)
})

// --- Comparators, tested directly since a real session's own ordering
// can't reliably force every direction of a sort comparison ------------------

test("compareByStart orders by start time, both directions and a tie", () => {
  const { compareByStart } = common
  const earlier = { start: "2026-01-01T00:00:00.000Z" }
  const later = { start: "2026-01-01T00:00:01.000Z" }
  const sameAsEarlier = { start: "2026-01-01T00:00:00.000Z" }
  assert.equal(compareByStart(earlier, later), -1)
  assert.equal(compareByStart(later, earlier), 1)
  assert.equal(compareByStart(earlier, sameAsEarlier), 0)
})

test("comparePrRefs orders by number within a repo, and by repo name across repos in both directions", () => {
  const { comparePrRefs } = common
  assert.equal(comparePrRefs({ repo: "a/a", number: 1 }, { repo: "a/a", number: 2 }), -1)
  assert.equal(comparePrRefs({ repo: "a/a", number: 2 }, { repo: "a/a", number: 1 }), 1)
  assert.equal(comparePrRefs({ repo: "a/a", number: 1 }, { repo: "b/b", number: 1 }) < 0, true)
  assert.equal(comparePrRefs({ repo: "b/b", number: 1 }, { repo: "a/a", number: 1 }) > 0, true)
})

// --- applyLimits: every capped array trimmed to what validateLocalFacts accepts ----

const at = (second) => `2026-09-25T08:00:${String(second).padStart(2, "0")}.000Z`

test("applyLimits leaves in-limit, well-ordered data untouched", () => {
  const unavailable = []
  const input = {
    agents: [{ n: 0, parent: null, model: "m" }],
    intervals: [{ kind: "turn", agent: 0, start: at(1), end: at(2) }],
    models: [{ id: "m", requests: 1 }],
    prs: [{ repo: "a/a", number: 1 }],
  }
  assert.deepEqual(common.applyLimits(input, unavailable), input)
  assert.deepEqual(unavailable, [])
})

test("applyLimits drops intervals whose end precedes their start, recording the matching field once per field", () => {
  const unavailable = []
  const { intervals } = common.applyLimits({
    agents: [{ n: 0, parent: null, model: "m" }],
    intervals: [
      { kind: "turn", agent: 0, start: at(5), end: at(4) },
      { kind: "human_wait", agent: 0, start: at(5), end: at(4) },
      { kind: "tool", agent: 0, tool: "shell", outcome: "ok", start: at(5), end: at(4) },
      { kind: "subagent", agent: 0, start: at(5), end: at(4) },
      { kind: "api_retry", agent: 0, start: at(5), end: at(4) },
      { kind: "turn", agent: 0, start: at(3), end: at(3) },
    ],
    models: [],
    prs: [],
  }, unavailable)
  assert.deepEqual(intervals, [{ kind: "turn", agent: 0, start: at(3), end: at(3) }])
  assert.deepEqual(unavailable, [
    { field: "turns", reason: "source_unreadable" },
    { field: "human_waits", reason: "source_unreadable" },
    { field: "tool_durations", reason: "source_unreadable" },
    { field: "api_retries", reason: "source_unreadable" },
  ])
})

test("applyLimits trims over-cap agents (with their intervals), intervals, models and PR refs", () => {
  const unavailable = []
  const limits = { agents: 2, intervals: 2, models: 1, prs: 1 }
  const result = common.applyLimits({
    agents: [{ n: 0, parent: null, model: "m" }, { n: 1, parent: 0, model: "m" }, { n: 2, parent: 0, model: "m" }],
    intervals: [
      { kind: "turn", agent: 2, start: at(0), end: at(1) },
      { kind: "human_wait", agent: 0, start: at(9), end: at(9) },
      { kind: "turn", agent: 0, start: at(1), end: at(2) },
      { kind: "turn", agent: 1, start: at(3), end: at(4) },
      { kind: "api_retry", agent: 1, start: at(8), end: at(8) },
    ],
    models: [{ id: "a", requests: 1 }, { id: "b", requests: 5 }],
    prs: [{ repo: "a/a", number: 1 }, { repo: "a/a", number: 2 }],
  }, unavailable, limits)
  assert.deepEqual(result.agents.map((agent) => agent.n), [0, 1])
  assert.deepEqual(result.intervals, [
    { kind: "turn", agent: 0, start: at(1), end: at(2) },
    { kind: "turn", agent: 1, start: at(3), end: at(4) },
  ])
  assert.deepEqual(result.models, [{ id: "b", requests: 5 }])
  assert.deepEqual(result.prs, [{ repo: "a/a", number: 1 }])
  assert.deepEqual(unavailable, [
    { field: "turns", reason: "capped" },
    { field: "tool_durations", reason: "capped" },
    { field: "agents", reason: "capped" },
    { field: "api_retries", reason: "capped" },
    { field: "human_waits", reason: "capped" },
    { field: "models", reason: "capped" },
    { field: "prs", reason: "capped" },
  ])
})


// --- Worker-tagged events and Desk-Task lines (milestone 2) --------------------

test("every binding event carries the worker that produced it", async () => {
  const { events } = await deriveFull()
  for (const list of [events.deskToolCalls, events.fileWrites, events.shellGitCommits]) {
    for (const entry of list) assert.ok(Number.isInteger(entry.agent), JSON.stringify(entry))
  }
  assert.ok(events.deskToolCalls.every((call) => call.agent === 0))
  assert.equal(events.fileWrites.find((entry) => entry.path === `${SENTINEL}-sub-edit-path`).agent, 1)
  assert.equal(events.fileWrites.find((entry) => entry.path === `${SENTINEL}-tracked/path.txt`).agent, 0)
})

test("a spawn prompt's Desk-Task line becomes events.spawnTasks for the spawned child, and nothing else of the prompt leaves", async () => {
  const { facts, events } = await deriveFull()
  assert.equal(SPAWN_DESK_TASK_LINE, "Desk-Task: desk-plugin/some-task")
  // Timed by the root's spawning call.
  assert.deepEqual(events.spawnTasks, [{ agent: 1, track: "desk-plugin", slug: "some-task", start: "2026-09-25T08:00:52.000Z", end: "2026-09-25T08:00:53.000Z" }])
  assert.equal(JSON.stringify(events.spawnTasks).includes(SENTINEL), false)
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
  assert.equal("spawnTasks" in facts, false)
})


// A session on disk: root lines plus subagent files ({ stem, lines, meta }).
async function deriveWithSubagents(rootLines, subagents) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-claude-workers-"))
  try {
    writeFileSync(path.join(dir, `${SUB_SESSION_ID}.jsonl`), `${rootLines.map((line) => JSON.stringify(line)).join("\n")}\n`)
    mkdirSync(path.join(dir, SUB_SESSION_ID, "subagents"), { recursive: true })
    for (const { stem, lines, meta } of subagents) {
      const base = path.join(dir, SUB_SESSION_ID, "subagents", stem)
      writeFileSync(`${base}.jsonl`, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`)
      if (meta !== undefined) writeFileSync(`${base}.meta.json`, JSON.stringify(meta))
    }
    return await deriveClaudeSession({ transcriptPath: path.join(dir, `${SUB_SESSION_ID}.jsonl`), plugins: PLUGINS, endReason: "prompt_input_exit" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function workerLines() {
  let second = 0
  const line = (extra) => ({ sessionId: SUB_SESSION_ID, version: "2.1.282", timestamp: `2026-09-25T08:00:${String(second++).padStart(2, "0")}.000Z`, ...extra })
  const spawn = (id, prompt) => line({ type: "assistant", message: { id: `m-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name: "Agent", input: prompt === undefined ? {} : { prompt } }] } })
  const prompt = (text) => line({ type: "user", message: { role: "user", content: text } })
  const assistant = (id, model, content = []) => line({ type: "assistant", message: { id, model, content } })
  return { line, spawn, prompt, assistant }
}

test("the child's first user line is the fallback source of Desk-Task, and the spawn prompt wins when both carry one", async () => {
  const { line, spawn, prompt } = workerLines()
  const { events } = await deriveWithSubagents(
    [
      line({ type: "user", message: { role: "user", content: "go" } }),
      spawn("spawn-a", "no task line here"),
      spawn("spawn-b", "Desk-Task: track-one/task-one"),
      spawn("spawn-c", "Desk-Task: bad/one\nDesk-Task: bad/two"),
      spawn("spawn-d"),
    ],
    [
      // agent 1: prompt has no line, so the child's own first line is used.
      { stem: "agent-1", meta: { toolUseId: "spawn-a" }, lines: [prompt("Desk-Task: track-two/task-two\nbody")] },
      // agent 2: both carry one; the spawn prompt wins.
      { stem: "agent-2", meta: { toolUseId: "spawn-b" }, lines: [prompt("Desk-Task: track-two/other")] },
      // agent 3: an ambiguous prompt binds nothing, and the child's line does not rescue it when it is ambiguous too.
      { stem: "agent-3", meta: { toolUseId: "spawn-c" }, lines: [prompt("Desk-Task: bad/one\nDesk-Task: bad/two")] },
      // agent 4: no meta at all; its first line still counts, and only the first.
      { stem: "agent-4", lines: [prompt("Desk-Task: track-three/task-three"), prompt("Desk-Task: track-four/task-four")] },
      // agent 5: a malformed line and a spawn with no prompt at all.
      { stem: "agent-5", meta: { toolUseId: "spawn-d" }, lines: [prompt("Desk-Task: ../x")] },
      // agent 6: only tool results, so no first user line.
      { stem: "agent-6", lines: [{ sessionId: SUB_SESSION_ID, type: "user", timestamp: "2026-09-25T08:01:00.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x" }] } }] },
    ],
  )
  assert.deepEqual(events.spawnTasks, [
    { agent: 1, track: "track-two", slug: "task-two" },
    { agent: 2, track: "track-one", slug: "task-one" },
    { agent: 4, track: "track-three", slug: "task-three" },
  ])
})

test("a first user line given as text blocks is read too", async () => {
  const { line } = workerLines()
  const { events } = await deriveWithSubagents(
    [line({ type: "user", message: { role: "user", content: "go" } })],
    [{ stem: "agent-1", lines: [line({ type: "user", message: { role: "user", content: [{ type: "text", text: "intro" }, { type: "text", text: "Desk-Task: a/b" }, { type: "image" }] } })] }],
  )
  assert.deepEqual(events.spawnTasks, [{ agent: 1, track: "a", slug: "b" }])
})

// Claude Code writes every `pr-link` line into the ROOT transcript, including
// for the PRs a subagent created; the creating call is in the subagent's own
// transcript as `gitOperation.pr`.
function createdPr(line, id, repo, number, action = "created") {
  return [
    line({ type: "assistant", message: { id: `m-${id}`, model: "claude-sonnet-5", content: [{ type: "tool_use", id, name: "Bash", input: { command: "gh pr create" } }] } }),
    line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: { stdout: "ok", gitOperation: { pr: { number, url: `https://github.com/${repo}/pull/${number}`, action } } } }),
  ]
}

test("a PR is credited to the worker whose call created it, not to the root that only holds its pr-link", async () => {
  const { line, assistant } = workerLines()
  const pr = (repo, number) => line({ type: "pr-link", prRepository: repo, prNumber: number })
  const { facts } = await deriveWithSubagents(
    [line({ type: "user", message: { role: "user", content: "go" } }), pr("o/r", 1), pr("o/r", 2), pr("o/r", 3), pr("o/r", 4)],
    [
      { stem: "agent-1", lines: [assistant("s1", "claude-sonnet-5"), ...createdPr(line, "c1", "o/r", 1), ...createdPr(line, "c2", "o/r", 2)] },
      { stem: "agent-2", lines: [assistant("s2", "claude-sonnet-5"), ...createdPr(line, "c3", "o/r", 2), ...createdPr(line, "c4", "o/r", 3)] },
    ],
  )
  assert.deepEqual(facts.refs.prs, [
    { repo: "o/r", number: 1, agent: 1 },
    { repo: "o/r", number: 2, agent: 1 },
    { repo: "o/r", number: 3, agent: 2 },
    // The root's pr-link is timed; the children's creations come after the root's last line, past the session, so they carry no time.
    { repo: "o/r", number: 4, agent: 0, at_ms: 4000 },
  ])
  assert.equal(validateLocalFacts(facts).ok, true)
})

test("a merge or any other action on a PR does not take the credit from the worker that created it", async () => {
  const { line, assistant } = workerLines()
  const { facts } = await deriveWithSubagents(
    [line({ type: "user", message: { role: "user", content: "go" } }), ...createdPr(line, "m1", "o/r", 1, "merged"), ...createdPr(line, "m2", "o/r", 2, null)],
    [{ stem: "agent-1", lines: [assistant("s1", "claude-sonnet-5"), ...createdPr(line, "c1", "o/r", 1), ...createdPr(line, "c2", "o/r", 2)] }],
  )
  assert.deepEqual(facts.refs.prs, [{ repo: "o/r", number: 1, agent: 1 }, { repo: "o/r", number: 2, agent: 1 }])
})

test("dedupePrRefs: a creating ref outranks a link whatever the worker, and the lowest worker wins among the same kind", () => {
  const ref = (agent, created) => ({ repo: "o/r", number: 1, agent, created })
  const dedupe = (...refs) => common.dedupePrRefs(refs)
  assert.deepEqual(dedupe(ref(0, false), ref(2, true)), [{ repo: "o/r", number: 1, agent: 2 }])
  assert.deepEqual(dedupe(ref(2, true), ref(0, false)), [{ repo: "o/r", number: 1, agent: 2 }])
  assert.deepEqual(dedupe(ref(3, true), ref(1, true), ref(2, true)), [{ repo: "o/r", number: 1, agent: 1 }])
  assert.deepEqual(dedupe(ref(3, false), ref(1, false), ref(2, false)), [{ repo: "o/r", number: 1, agent: 1 }])
})

test("a subagent's model is its own assistant model, else a valid meta model, else unknown", async () => {
  const { line, assistant } = workerLines()
  const { facts } = await deriveWithSubagents(
    [line({ type: "user", message: { role: "user", content: "go" } })],
    [
      { stem: "agent-1", meta: { model: "sonnet" }, lines: [assistant("s1", "claude-sonnet-5")] },
      { stem: "agent-2", meta: { model: "claude-haiku-5" }, lines: [assistant("s2", "<synthetic>")] },
      { stem: "agent-3", lines: [assistant("s3", "<synthetic>")] },
    ],
  )
  assert.deepEqual(facts.agents.slice(1).map((agent) => agent.model), ["claude-sonnet-5", "claude-haiku-5", "unknown"])
})

test("applyLimits drops a PR's worker when that worker was capped away", () => {
  const result = common.applyLimits({
    agents: [{ n: 0, parent: null, model: "m" }, { n: 1, parent: 0, model: "m" }],
    intervals: [],
    models: [],
    prs: [{ repo: "a/a", number: 1, agent: 0 }, { repo: "a/a", number: 2, agent: 1 }],
  }, [], { agents: 1, intervals: 10, models: 10, prs: 10 })
  assert.deepEqual(result.prs, [{ repo: "a/a", number: 1, agent: 0 }, { repo: "a/a", number: 2 }])
})

// --- Unsafe token counts become unknown, never an invalid file ---------------

async function deriveInline(lines) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-claude-tokens-"))
  try {
    const file = path.join(dir, "9b5a6c7d-1e2f-4a3b-8c4d-5e6f70819203.jsonl")
    const envelope = { sessionId: "9b5a6c7d-1e2f-4a3b-8c4d-5e6f70819203", version: "2.1.282", entrypoint: "cli" }
    writeFileSync(file, lines.map((line, index) => JSON.stringify({ ...envelope, timestamp: `2026-09-25T13:00:${String(index).padStart(2, "0")}.000Z`, ...line })).join("\n") + "\n")
    return await deriveClaudeSession({ transcriptPath: file, plugins: PLUGINS, endReason: "prompt_input_exit" })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const assistant = (id, usage, model = "claude-opus-5-5") => ({ type: "assistant", message: { id, model, usage, content: "x" } })

test("a fractional or unsafe token count is unknown with a tokens entry, and the facts stay valid", async () => {
  for (const bad of [1.5, 2 ** 53 + 2, -1]) {
    const { facts } = await deriveInline([assistant("a", { input_tokens: bad, output_tokens: 7 })])
    assert.deepEqual(facts.models[0].tokens, { input: null, output: 7, cache_read: null, cache_write: null, reasoning: null }, String(bad))
    assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "source_unreadable"))
    assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
  }
})

test("a count that stays unknown across repeats of a message keeps the stronger reason: unreadable beats absent, and two absences stay absent", async () => {
  const rest = { output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  const reasons = (facts) => facts.unavailable.filter((entry) => entry.field === "tokens").map((entry) => entry.reason).sort()
  // Unreadable first, then absent: the count is still unreadable, so no "absent" reason is reported.
  const unreadableThenAbsent = await deriveInline([assistant("a", { input_tokens: 1.5, ...rest }), assistant("a", rest)])
  assert.equal(unreadableThenAbsent.facts.models[0].tokens.input, null)
  assert.deepEqual(reasons(unreadableThenAbsent.facts), ["source_unreadable"])
  // Absent first, then unreadable: the same result in the other order.
  const absentThenUnreadable = await deriveInline([assistant("a", rest), assistant("a", { input_tokens: 1.5, ...rest })])
  assert.equal(absentThenUnreadable.facts.models[0].tokens.input, null)
  assert.deepEqual(reasons(absentThenUnreadable.facts), ["source_unreadable"])
  // Absent both times: the count is absent, and only the "absent" reason is reported.
  const absentTwice = await deriveInline([assistant("a", rest), assistant("a", rest)])
  assert.equal(absentTwice.facts.models[0].tokens.input, null)
  assert.deepEqual(reasons(absentTwice.facts), ["field_absent"])
})

test("a good repeat of a message recovers an unreadable count, and a malformed repeat never erases a good one", async () => {
  const { facts } = await deriveInline([
    assistant("a", { input_tokens: 1.5, output_tokens: 7 }),
    assistant("a", { input_tokens: 4, output_tokens: 9 }),
    assistant("b", { input_tokens: 4, output_tokens: 1 }),
  ])
  assert.deepEqual(facts.models[0].tokens, { input: 8, output: 10, cache_read: null, cache_write: null, reasoning: null })
  assert.ok(facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "source_unreadable"))
  assert.equal(facts.models[0].requests, 2)
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
  // A malformed repeat of a message keeps the earlier good value and is flagged; a good repeat recovers an earlier bad one.
  const kept = await deriveInline([assistant("a", { input_tokens: 4, output_tokens: 7 }), assistant("a", { input_tokens: 1.5, output_tokens: 9 })])
  assert.deepEqual(kept.facts.models[0].tokens, { input: 4, output: 9, cache_read: null, cache_write: null, reasoning: null })
  assert.ok(kept.facts.unavailable.some((entry) => entry.field === "tokens" && entry.reason === "source_unreadable"))
  const recovered = await deriveInline([assistant("a", { input_tokens: 1.5 }), assistant("a", { input_tokens: 6 })])
  assert.equal(recovered.facts.models[0].tokens.input, 6)
  // Sums past the safe range are unknown, not an invalid file.
  const huge = await deriveInline([assistant("a", { input_tokens: Number.MAX_SAFE_INTEGER }), assistant("b", { input_tokens: 5 })])
  assert.equal(huge.facts.models[0].tokens.input, null)
  assert.ok(huge.facts.unavailable.some((entry) => entry.field === "tokens"))
  assert.deepEqual(validateLocalFacts(huge.facts), { ok: true, errors: [] })
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
})

test("a subagent whose meta model equals the model it ran on has no requested_model", async () => {
  const { facts } = await deriveFull()
  for (const agent of facts.agents) assert.notEqual(agent.requested_model, agent.model)
})

// --- The shared helpers ------------------------------------------------------

test("countOrNull keeps safe non-negative integers only", () => {
  assert.deepEqual([0, 5, 1.5, -1, 2 ** 53, "3", null, undefined, NaN].map(common.countOrNull), [0, 5, null, null, null, null, null, null, null])
})

test("addNullable sums known counts and is null for an unknown or an unsafe sum", () => {
  assert.equal(common.addNullable(2, 3), 5)
  assert.equal(common.addNullable(null, 3), null)
  assert.equal(common.addNullable(3, null), null)
  assert.equal(common.addNullable(Number.MAX_SAFE_INTEGER, 1), null)
})

test("withRequestedModel sets the key only for a valid id that differs from the model", () => {
  assert.deepEqual(common.withRequestedModel({ n: 1, model: "a" }, "b"), { n: 1, model: "a", requested_model: "b" })
  assert.deepEqual(common.withRequestedModel({ n: 1, model: "a" }, "a"), { n: 1, model: "a" })
  assert.deepEqual(common.withRequestedModel({ n: 1, model: "a" }, "bad model!"), { n: 1, model: "a" })
  assert.deepEqual(common.withRequestedModel({ n: 1, model: "a" }, undefined), { n: 1, model: "a" })
  assert.deepEqual(common.withRequestedModel({ n: 1, model: "a" }, 5), { n: 1, model: "a" })
})

// --- Declared focus: focus calls, spawns, own-commit paths, shell writes, PRs, status ---

function focusSession() {
  let second = 0
  const line = (extra) => ({ sessionId: GIT_SESSION_ID, version: "2.1.282", cwd: "/w", timestamp: `2026-09-25T08:00:${String(second++).padStart(2, "0")}.000Z`, ...extra })
  const call = (id, name, input, extra = {}) => line({ type: "assistant", message: { id: `m-${id}`, model: "claude-opus-5-5", content: [{ type: "tool_use", id, name, input }] }, ...extra })
  const result = (id, isError = false, extra = {}) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, is_error: isError, content: `done ${SENTINEL}` }] }, toolUseResult: { stdout: "", stderr: "" }, ...extra })
  return { line, call, result }
}

const FOCUS_TOOL = "mcp__plugin_desk_desk__task_focus"
const UPDATE_TOOL = "mcp__plugin_desk_desk__task_update"
const SAVE_TOOL = "mcp__plugin_desk_desk__desk_save"

test("a successful task_focus call becomes a focusCall with its time, and a failed one yields nothing", async () => {
  const { line, call, result } = focusSession()
  const { events, facts } = await deriveLines([
    line({ type: "user", message: { role: "user", content: `go ${SENTINEL}` } }),
    call("f1", FOCUS_TOOL, { track: "desk-plugin", slug: "some-task" }), // 01
    result("f1"), // 02
    call("f2", FOCUS_TOOL, { track: "other", slug: "failed" }),
    result("f2", true),
    call("f3", FOCUS_TOOL, { clear: true }), // 05
    result("f3"),
    call("f4", FOCUS_TOOL, { track: "..", slug: "bad" }),
    result("f4"),
    call("f5", FOCUS_TOOL, {}),
    result("f5"),
    call("f6", FOCUS_TOOL, { track: 4, slug: "x" }),
    result("f6"),
  ])
  assert.deepEqual(events.focusCalls, [
    { agent: 0, at: "2026-09-25T08:00:01.000Z", track: "desk-plugin", slug: "some-task" },
    { agent: 0, at: "2026-09-25T08:00:05.000Z", clear: true },
  ])
  assert.deepEqual(events.deskToolCalls, [], "task_focus is not a deskToolCall")
  assert.equal(JSON.stringify(facts).includes("some-task"), false)
  assert.equal(validateLocalFacts(facts).ok, true)
})

test("a spawn call on a line with no readable time is still parsed, and records no spawn time", async () => {
  const { line, call, result } = focusSession()
  const { events, facts } = await deriveLines([
    line({ type: "user", message: { role: "user", content: `go ${SENTINEL}` } }),
    call("s1", "Agent", { prompt: `Desk-Task: a/b\n${SENTINEL}` }, { timestamp: "not a time" }),
    result("s1"),
  ])
  assert.deepEqual(events.spawns, [], "no subagent transcript, so no spawn to report")
  assert.equal(JSON.stringify(events).includes(SENTINEL), false)
  assert.equal(validateLocalFacts(facts).ok, true)
})

test("task_create with focus: true is a focusCall as well as a deskToolCall; focus: false, a truthy non-boolean, a failed call and an invalid track or slug declare nothing", async () => {
  const { line, call, result } = focusSession()
  const CREATE_TOOL = "mcp__plugin_desk_desk__task_create"
  const { events, facts } = await deriveLines([
    line({ type: "user", message: { role: "user", content: `go ${SENTINEL}` } }),
    call("c1", CREATE_TOOL, { track: "desk-plugin", slug: "new-task", focus: true, title: SENTINEL }), // 01
    result("c1"),
    call("c2", CREATE_TOOL, { track: "desk-plugin", slug: "parked", focus: false }),
    result("c2"),
    call("c3", CREATE_TOOL, { track: "desk-plugin", slug: "truthy", focus: "true" }),
    result("c3"),
    call("c4", CREATE_TOOL, { track: "desk-plugin", slug: "failed", focus: true }),
    result("c4", true),
    call("c5", CREATE_TOOL, { track: "..", slug: "bad", focus: true }),
    result("c5"),
    call("c6", CREATE_TOOL, { track: "desk-plugin", focus: true }),
    result("c6"),
    call("c7", CREATE_TOOL, { track: "desk-plugin", slug: "plain" }),
    result("c7"),
    call("c8", UPDATE_TOOL, { track: "desk-plugin", slug: "updated", focus: true }),
    result("c8"),
  ])
  assert.deepEqual(events.focusCalls, [{ agent: 0, at: "2026-09-25T08:00:01.000Z", track: "desk-plugin", slug: "new-task" }])
  assert.deepEqual(events.deskToolCalls.map((entry) => [entry.slug, entry.ok]), [["new-task", true], ["parked", true], ["truthy", true], ["failed", false], ["bad", true], [undefined, true], ["plain", true], ["updated", true]])
  assert.equal(JSON.stringify(events.focusCalls).includes(SENTINEL), false)
  assert.equal(JSON.stringify(facts).includes("new-task"), false)
  assert.equal(validateLocalFacts(facts).ok, true)
})

test("task_update status comes from top-level status, frontmatter.status as an object, or frontmatter as a JSON string, and statusOnly follows ruling P1", async () => {
  const { line, call, result } = focusSession()
  const inputs = [
    { track: "a", slug: "b", frontmatter: "{\"status\": \"done\"}" },
    { track: "a", slug: "b", frontmatter: { status: "done" }, progress: "x" },
    { track: "a", slug: "b", person: "p", frontmatter: { status: "doing" } },
    { track: "a", slug: "b", status: "blocked" },
    { track: "a", slug: "b", frontmatter: { status: "done", title: "t" } },
    { track: "a", slug: "b", frontmatter: "not json" },
    { track: "a", slug: "b", frontmatter: "[1]" },
    { track: "a", slug: "b", frontmatter: 7 },
    { track: "a", slug: "b", frontmatter: { status: 4 } },
    { track: "a", slug: "b", frontmatter: {} },
    { track: "a", slug: "b" },
  ]
  const lines = [line({ type: "user", message: { role: "user", content: "go" } })]
  inputs.forEach((input, index) => lines.push(call(`u${index}`, UPDATE_TOOL, input), result(`u${index}`)))
  const { events } = await deriveLines(lines)
  assert.deepEqual(events.deskToolCalls.map(({ status, statusOnly }) => ({ status, statusOnly })), [
    { status: "done", statusOnly: true },
    { status: "done", statusOnly: false },
    { status: "doing", statusOnly: true },
    { status: "blocked", statusOnly: false },
    { status: "done", statusOnly: false },
    { status: null, statusOnly: false },
    { status: null, statusOnly: false },
    { status: null, statusOnly: false },
    { status: null, statusOnly: false },
    { status: null, statusOnly: false },
    { status: null, statusOnly: false },
  ])
})

test("every subagent appears in spawns with its parent, its spawn call's time and its task; a meta with no toolUseId uses its first timestamp", async () => {
  const { line, spawn, prompt, assistant } = workerLines()
  const { events } = await deriveWithSubagents(
    [
      line({ type: "user", message: { role: "user", content: "go" } }), // 00
      spawn("spawn-a", "Desk-Task: track-one/task-one"), // 01
      spawn("spawn-b", "no line"), // 02
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "spawn-a" }] } }),
    ],
    [
      { stem: "agent-1", meta: { toolUseId: "spawn-a" }, lines: [assistant("s1", "claude-sonnet-5")] },
      { stem: "agent-2", meta: { toolUseId: "spawn-b" }, lines: [prompt("hello")] },
      { stem: "agent-3", meta: {}, lines: [{ sessionId: SUB_SESSION_ID, type: "user", timestamp: "2026-09-25T09:00:00.000Z", message: { role: "user", content: "Desk-Task: x/y" } }] },
      { stem: "agent-4", lines: [{ sessionId: SUB_SESSION_ID, type: "system" }] },
    ],
  )
  assert.deepEqual(events.spawns.map((spawnEvent) => spawnEvent.agent), [1, 2, 3, 4])
  assert.deepEqual(events.spawns[0], { agent: 1, parent: 0, at: "2026-09-25T08:00:01.000Z", task: { track: "track-one", slug: "task-one" } })
  assert.equal(events.spawns[1].at, "2026-09-25T08:00:02.000Z")
  assert.equal(events.spawns[1].task, null)
  assert.deepEqual(events.spawns[2], { agent: 3, parent: 0, at: "2026-09-25T09:00:00.000Z", task: { track: "x", slug: "y" } })
  assert.deepEqual(events.spawns[3], { agent: 4, parent: 0, at: null, task: null })
})

test("an unanswered spawn call still times its subagent", async () => {
  const { line, spawn, assistant } = workerLines()
  const { events } = await deriveWithSubagents(
    [line({ type: "user", message: { role: "user", content: "go" } }), spawn("spawn-a")],
    [{ stem: "agent-1", meta: { toolUseId: "spawn-a" }, lines: [assistant("s1", "claude-sonnet-5")] }],
  )
  assert.equal(events.spawns[0].at, "2026-09-25T08:00:01.000Z")
})

test("a Bash git add and commit gives shellGitCommits paths, and a Bash redirect gives fileWrites, only when the call succeeded", async () => {
  const { line, call, result } = focusSession()
  const { events, facts } = await deriveLines([
    line({ type: "user", message: { role: "user", content: "go" } }),
    call("g1", "Bash", { command: "git add t/s/task.md && git commit -qm x" }), // 01
    result("g1"),
    call("g2", "Bash", { command: "echo hi > out.txt" }), // 03
    result("g2"),
    call("g3", "Bash", { command: "echo no > failed.txt && git add f.md && git commit -m x" }),
    result("g3", true),
    call("g4", "Bash", { command: "git commit -m x" }),
    result("g4"),
  ])
  assert.deepEqual(events.shellGitCommits.map(({ cwd, paths }) => ({ cwd, paths })), [
    { cwd: "/w", paths: ["/w/t/s/task.md"] },
    { cwd: "/w", paths: [] },
  ])
  assert.deepEqual(events.fileWrites.map(({ at, path: written, agent }) => ({ at, path: written, agent })), [
    { at: "2026-09-25T08:00:03.000Z", path: "/w/out.txt", agent: 0 },
  ])
  assert.equal(JSON.stringify(facts).includes("task.md"), false)
})

test("desk_save paths become fileWrites when the call succeeded, and a failed or pathless call gives none", async () => {
  const { line, call, result } = focusSession()
  const { events } = await deriveLines([
    line({ type: "user", message: { role: "user", content: "go" } }),
    call("d1", SAVE_TOOL, { paths: ["notes/a.md", "notes/b.md", 5] }), // 01
    result("d1"),
    call("d2", SAVE_TOOL, { paths: ["failed.md"] }),
    result("d2", true),
    call("d3", SAVE_TOOL, { content: "x" }),
    result("d3"),
  ])
  assert.deepEqual(events.fileWrites.map(({ at, path: written, agent }) => ({ at, path: written, agent })), [
    { at: "2026-09-25T08:00:01.000Z", path: "notes/a.md", agent: 0 },
    { at: "2026-09-25T08:00:01.000Z", path: "notes/b.md", agent: 0 },
  ])
})

test("a gh pr create result becomes a prRefs event with created true; a link or other action has created false", async () => {
  const { line, call } = focusSession()
  const pr = (id, number, action) => line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, toolUseResult: { stdout: "ok", gitOperation: { pr: { number, url: `https://github.com/o/r/pull/${number}`, action } } } })
  const { events, facts } = await deriveLines([
    line({ type: "user", message: { role: "user", content: "go" } }),
    call("p1", "Bash", { command: "gh pr create" }), // 01
    pr("p1", 1, "created"), // 02
    call("p2", "Bash", { command: "gh pr merge 2" }),
    pr("p2", 2, "merged"),
    line({ type: "pr-link", prRepository: "o/r", prNumber: 3 }),
  ])
  assert.deepEqual(events.prRefs, [
    { agent: 0, at: "2026-09-25T08:00:02.000Z", repo: "o/r", created: true },
    { agent: 0, at: "2026-09-25T08:00:04.000Z", repo: "o/r", created: false },
    { agent: 0, at: "2026-09-25T08:00:05.000Z", repo: "o/r", created: false },
  ])
  assert.equal("prRefs" in facts, false)
})

test("sentinel: the focus, spawn, path, write and PR events never carry prompt, command or content text, and facts stay clean", async () => {
  const { line, call, result } = focusSession()
  const { events, facts } = await deriveLines([
    line({ type: "user", message: { role: "user", content: `go ${SENTINEL}` } }),
    call("s1", FOCUS_TOOL, { track: "a", slug: "b", note: SENTINEL }),
    result("s1"),
    call("s2", "Bash", { command: `echo ${SENTINEL} > out.txt && git add x.md && git commit -m ${SENTINEL}` }),
    result("s2"),
    call("s3", SAVE_TOOL, { paths: ["p.md"], content: SENTINEL }),
    result("s3"),
    call("s4", undefined, { paths: ["nameless.md"] }),
    result("s4"),
  ])
  for (const key of ["focusCalls", "spawns", "shellGitCommits", "fileWrites", "prRefs"]) assert.equal(JSON.stringify(events[key]).includes(SENTINEL), false, key)
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
})

test("two commits in one directory give one shellGitCommits entry with every path they and their adds name, and a second directory its own", async () => {
  const { line, call, result } = focusSession()
  const { events } = await deriveLines([
    line({ type: "user", message: { role: "user", content: "go" } }),
    call("m1", "Bash", { command: "git add a.md && git commit -qm x && git add b.md a.md && git commit -qm y && git -C /elsewhere commit -qm z" }),
    result("m1"),
  ])
  assert.deepEqual(events.shellGitCommits.map(({ cwd, paths }) => ({ cwd, paths })), [
    { cwd: "/w", paths: ["/w/a.md", "/w/b.md"] },
    { cwd: "/elsewhere", paths: [] },
  ])
})


// --- Number states: what the host does not record and what the log left out ---

const hasFlag = (facts, field, reason) => facts.unavailable.some((entry) => entry.field === field && entry.reason === reason)

test("a Claude session carries compaction_waits and reasoning_tokens as not recorded by the host", async () => {
  const { facts } = await deriveFull()
  assert.ok(hasFlag(facts, "compaction_waits", "host_does_not_record"))
  assert.ok(hasFlag(facts, "reasoning_tokens", "host_does_not_record"))
})

test("a Claude session carries prs as recorded only partly", async () => {
  const { facts } = await deriveFull()
  assert.ok(hasFlag(facts, "prs", "host_records_partly"))
})

test("the facts carry every flag the host table returns for Claude Code, api_retries included", async () => {
  const { facts } = await deriveFull()
  const flags = hostFlagsFor("claude-code")
  assert.ok(flags.some((flag) => flag.field === "api_retries" && flag.reason === "host_records_partly"))
  for (const flag of flags) assert.ok(hasFlag(facts, flag.field, flag.reason), `${flag.field}/${flag.reason}`)
})

test("an assistant message with no usage object gives null counters and tokens field_absent, not zeros", async () => {
  const { facts } = await deriveInline([assistant("a", undefined), assistant("b", { input_tokens: 3, output_tokens: 4 })])
  assert.deepEqual(facts.models[0].tokens, { input: null, output: null, cache_read: null, cache_write: null, reasoning: null })
  assert.equal(facts.models[0].requests, 2)
  assert.ok(hasFlag(facts, "tokens", "field_absent"))
  assert.equal(hasFlag(facts, "tokens", "source_unreadable"), false)
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
})

test("a measured zero stays zero with no tokens flag", async () => {
  const { facts } = await deriveInline([assistant("a", { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })])
  assert.deepEqual(facts.models[0].tokens, { input: 0, output: 0, cache_read: 0, cache_write: 0, reasoning: null })
  assert.equal(facts.unavailable.some((entry) => entry.field === "tokens"), false)
})

test("a good repeat of an absent-usage message recovers the counters with no tokens flag", async () => {
  const { facts } = await deriveInline([assistant("a", undefined), assistant("a", { input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 })])
  assert.deepEqual(facts.models[0].tokens, { input: 1, output: 2, cache_read: 3, cache_write: 4, reasoning: null })
  assert.equal(facts.unavailable.some((entry) => entry.field === "tokens"), false)
})

test("an assistant message with a malformed counter still flags tokens source_unreadable", async () => {
  const { facts } = await deriveInline([assistant("a", { input_tokens: "7", output_tokens: 4, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })])
  assert.equal(facts.models[0].tokens.input, null)
  assert.ok(hasFlag(facts, "tokens", "source_unreadable"))
  assert.equal(hasFlag(facts, "tokens", "field_absent"), false)
})

test("a session with no assistant usage flags models, tokens and requests field_absent", async () => {
  const { facts } = await deriveInline([{ type: "user", message: { role: "user", content: "hi" } }])
  assert.deepEqual(facts.models, [])
  for (const field of ["models", "tokens", "requests"]) assert.ok(hasFlag(facts, field, "field_absent"), field)
  assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
})

test("an unreadable subagents folder flags agents source_unreadable, and a missing folder does not", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "desk-claude-nosub-"))
  try {
    const root = path.join(dir, `${SUB_SESSION_ID}.jsonl`)
    writeFileSync(root, `${JSON.stringify({ sessionId: SUB_SESSION_ID, version: "2.1.282", timestamp: "2026-09-25T08:00:00.000Z", type: "user", message: { role: "user", content: "go" } })}\n`)
    const none = await deriveClaudeSession({ transcriptPath: root, plugins: PLUGINS, endReason: null })
    assert.equal(hasFlag(none.facts, "agents", "source_unreadable"), false)
    writeFileSync(path.join(dir, SUB_SESSION_ID), "not a folder")
    const broken = await deriveClaudeSession({ transcriptPath: root, plugins: PLUGINS, endReason: null })
    assert.ok(hasFlag(broken.facts, "agents", "source_unreadable"))
    assert.deepEqual(validateLocalFacts(broken.facts), { ok: true, errors: [] })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("a missing subagent meta file flags agents source_unreadable, and a readable one does not", async () => {
  const { line, assistant: worker } = workerLines()
  const root = [line({ type: "user", message: { role: "user", content: "go" } }), worker("r1", "claude-opus-5-5")]
  const child = [worker("s1", "claude-sonnet-5", [{ type: "text", text: "hi" }])]
  const missing = await deriveWithSubagents(root, [{ stem: "agent-1", lines: child }])
  assert.ok(hasFlag(missing.facts, "agents", "source_unreadable"))
  const present = await deriveWithSubagents(root, [{ stem: "agent-1", meta: { agentType: "fork" }, lines: child }])
  assert.equal(hasFlag(present.facts, "agents", "source_unreadable"), false)
})

test("more PRs than the cap flags prs capped", async () => {
  const lines = [{ type: "user", message: { role: "user", content: "go" } }]
  for (let number = 1; number <= 501; number += 1) lines.push({ type: "pr-link", prRepository: "a/b", prNumber: number })
  const { facts } = await deriveInline(lines)
  assert.equal(facts.refs.prs.length, 500)
  assert.ok(hasFlag(facts, "prs", "capped"))
  assert.ok(hasFlag(facts, "prs", "host_records_partly"))
})

test("a sentinel in a prompt, command and file path reaches neither facts nor flags", async () => {
  const { facts } = await deriveInline([
    { type: "user", message: { role: "user", content: `go ${SENTINEL}` } },
    { type: "assistant", message: { id: "a", model: "claude-opus-5-5", content: [{ type: "tool_use", id: "t", name: "Bash", input: { command: `echo ${SENTINEL}`, file_path: `/tmp/${SENTINEL}` } }] } },
  ])
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
  assert.equal(JSON.stringify(facts.unavailable).includes(SENTINEL), false)
})

test("facts written by the Claude deriver validate as /2", async () => {
  for (const { facts } of [await deriveFull(), await deriveInline([assistant("a", undefined)])]) {
    assert.equal(facts.schema, "desk.factory.local/2")
    assert.deepEqual(validateLocalFacts(facts), { ok: true, errors: [] })
  }
})
