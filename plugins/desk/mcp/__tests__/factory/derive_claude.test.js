// Claude Code deriver tests, run against the synthetic fixtures built by
// `fixtures/claude/make.js`. No fixture line, prompt, tool input or tool
// output was copied from a real transcript — everything here is invented,
// and every free-text field in the fixtures carries `SENTINEL` so the
// privacy test below can assert it never reaches the derived facts.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deriveClaudeSession, __internals__ } from "../../src/factory/derive-claude.js"
import { validateLocalFacts as validateFacts } from "../../src/factory/schema.js"
import {
  SENTINEL,
  COMMIT_SHA,
  SESSION_IDS,
  NON_UUID_FILE_STEM,
  FULL_TURN_1_END,
  TRUNCATED_SKEWED_RESULT_AT,
} from "./fixtures/claude/make.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, "fixtures", "claude")
const transcriptPath = (sessionId) => path.join(fixturesDir, `${sessionId}.jsonl`)

const PLUGINS = [{ name: "desk", version: "3.2.0-alpha.21" }]

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
  assert.equal(facts.schema, "desk.factory.local/1")
  assert.equal(Object.hasOwn(facts, "contributor"), false)
  assert.deepEqual(facts.refs.commits, [])
})

test("the derived facts pass validateFacts and carry no sentinel, for every fixture variant", async () => {
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
    const result = validateFacts(facts)
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
  assert.deepEqual(metaless, { n: 3, parent: 0, model: "unknown" })
})

test("odd but parseable shapes (non-object lines, non-numeric usage, missing input/usage/file_path, bad tool_use_id, untimed errors, free-text pr-link, untimed or pathless deltas) never throw or leak, and still validate", async () => {
  const { facts, events } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.oddShapes),
    plugins: PLUGINS,
    endReason: null,
  })
  assert.deepEqual(validateFacts(facts).errors, [])
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
  // Back-to-back prompts: the first turn has no activity and ends where it starts.
  const turns = findInterval(facts.intervals, (iv) => iv.kind === "turn")
  assert.equal(turns[0].start, turns[0].end)
  // "12", -3 and null usage values count as 0; the missing usage object too.
  assert.deepEqual(facts.models, [{ id: "claude-opus-5-5", requests: 3, tokens: { input: 1, output: 1, cache_read: 0, cache_write: 4, reasoning: null } }])
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

test("a subagent with no meta.json marks models unavailable (source_unreadable)", async () => {
  const { facts } = await deriveFull()
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "models"), [{ field: "models", reason: "source_unreadable" }])
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
    { n: 1, parent: 0, model: "claude-sonnet-5" },
    // agent-a2 was spawned by agent-a4's Agent call (n 4, read after it).
    { n: 2, parent: 4, model: "claude-opus-4-1" },
    // agent-a3 has no meta.json at all; agent-a4 has one, but its model
    // doesn't match the pattern and its toolUseId matches no call — both
    // fall back to "unknown"/parent 0, for different reasons, and both
    // still count.
    { n: 3, parent: 0, model: "unknown" },
    { n: 4, parent: 0, model: "unknown" },
  ])
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
    { repo: "another-org/repo", number: 3 },
    { repo: "ourostack/desk", number: 7 },
    { repo: "ourostack/desk", number: 42 },
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
  const span = (from, to, cwd) => ({ start: `2026-09-25T08:00:${from}.000Z`, end: `2026-09-25T08:00:${to}.000Z`, cwd })
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
  assert.equal(validateFacts(facts).ok, true)
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
      { field: "permission_waits", reason: "host_does_not_record" },
      { field: "ci_runs", reason: "not_collected_in_slice_1" },
      { field: "commits", reason: "host_does_not_record" },
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
  assert.equal(validateFacts(facts).ok, true)
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
    { name: "desk", version: "3.2.0-alpha.21", extra: SENTINEL },
  ])
  assert.deepEqual(messy.facts.plugins, [{ name: "desk", version: "3.2.0-alpha.21" }])
  assert.deepEqual(pluginsUnavailable(messy.facts), [{ field: "plugins", reason: "source_unreadable" }])
  assert.equal(JSON.stringify(messy.facts).includes(SENTINEL), false)
  assert.equal(validateFacts(messy.facts).ok, true)

  const missing = await derive(undefined)
  assert.deepEqual(missing.facts.plugins, [])
  assert.deepEqual(pluginsUnavailable(missing.facts), [{ field: "plugins", reason: "source_unreadable" }])

  const tooMany = await derive(Array.from({ length: 65 }, (_, index) => ({ name: `p${index}`, version: "1.0.0" })))
  assert.equal(tooMany.facts.plugins.length, 64)
  assert.deepEqual(pluginsUnavailable(tooMany.facts), [{ field: "plugins", reason: "capped" }])
  assert.equal(validateFacts(tooMany.facts).ok, true)

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
  assert.equal(validateFacts(facts).ok, true)
})

// --- Comparators, tested directly since a real session's own ordering
// can't reliably force every direction of a sort comparison ------------------

test("compareByStart orders by start time, both directions and a tie", () => {
  const { compareByStart } = __internals__
  const earlier = { start: "2026-01-01T00:00:00.000Z" }
  const later = { start: "2026-01-01T00:00:01.000Z" }
  const sameAsEarlier = { start: "2026-01-01T00:00:00.000Z" }
  assert.equal(compareByStart(earlier, later), -1)
  assert.equal(compareByStart(later, earlier), 1)
  assert.equal(compareByStart(earlier, sameAsEarlier), 0)
})

test("comparePrRefs orders by number within a repo, and by repo name across repos in both directions", () => {
  const { comparePrRefs } = __internals__
  assert.equal(comparePrRefs({ repo: "a/a", number: 1 }, { repo: "a/a", number: 2 }), -1)
  assert.equal(comparePrRefs({ repo: "a/a", number: 2 }, { repo: "a/a", number: 1 }), 1)
  assert.equal(comparePrRefs({ repo: "a/a", number: 1 }, { repo: "b/b", number: 1 }) < 0, true)
  assert.equal(comparePrRefs({ repo: "b/b", number: 1 }, { repo: "a/a", number: 1 }) > 0, true)
})

// --- applyLimits: every capped array trimmed to what validateFacts accepts ----

const at = (second) => `2026-09-25T08:00:${String(second).padStart(2, "0")}.000Z`

test("applyLimits leaves in-limit, well-ordered data untouched", () => {
  const unavailable = []
  const input = {
    agents: [{ n: 0, parent: null, model: "m" }],
    intervals: [{ kind: "turn", agent: 0, start: at(1), end: at(2) }],
    models: [{ id: "m", requests: 1 }],
    prs: [{ repo: "a/a", number: 1 }],
  }
  assert.deepEqual(__internals__.applyLimits(input, unavailable), input)
  assert.deepEqual(unavailable, [])
})

test("applyLimits drops intervals whose end precedes their start, recording the matching field once per field", () => {
  const unavailable = []
  const { intervals } = __internals__.applyLimits({
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
  const result = __internals__.applyLimits({
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
    { field: "api_retries", reason: "capped" },
    { field: "human_waits", reason: "capped" },
    { field: "models", reason: "capped" },
  ])
})
