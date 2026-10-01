// Generator for the synthetic Codex CLI rollout fixtures the Codex deriver is
// tested against. No Codex session exists on any of our machines, so every
// record here is written by hand from the Codex source, as read and cited in
// `FORMAT.md` (commit 60947e234156ac12bdb7fba2477d3965f166bd34), never from a
// real rollout. Codex support is unproven until a real session reaches the
// store. Run `node make.js` from this directory to regenerate the checked-in
// `sessions/YYYY/MM/DD/rollout-*.jsonl` tree; the output is deterministic.
//
// `SENTINEL` is planted in every free-text field a real rollout carries
// (cwd, instructions, prompts, assistant text, reasoning, tool arguments and
// output, patch text, git branch and URL, agent nicknames) so the privacy test
// can assert it never reaches the derived facts. Fields the deriver is meant
// to read as enums or identifiers (record types, `agent_role`, model names,
// tool names) carry real-looking values instead.

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))

export const SENTINEL = "SENTINEL-7f3a"
const S = SENTINEL

// A spawn prompt carries this line; only its validated track/slug may reach events.
export const SPAWN_DESK_TASK_LINE = "Desk-Task: desk-plugin/some-task"
export const COMMIT_SHA = "ab34cd56".repeat(5)
export const PR_URL = "https://github.com/example-org/example-repo/pull/42"
export const CLI_VERSION = "0.142.0"
export const ROOT_MODEL = "gpt-5.5"
export const CHILD_MODEL = "gpt-5.5-mini"
export const CODEX_SOURCE_COMMIT = "60947e234156ac12bdb7fba2477d3965f166bd34"

/** Thread (and session) ids. `root` is the session id; the rest are threads. */
export const THREAD_IDS = Object.freeze({
  root: "0199a1b0-0000-7000-8000-000000000001",
  childExplorer: "0199a1b0-0000-7000-8000-000000000002",
  childWorker: "0199a1b0-0000-7000-8000-000000000003",
  grandchild: "0199a1b0-0000-7000-8000-000000000004",
  truncated: "0199a1b0-0000-7000-8000-000000000005",
  noMeta: "0199a1b0-0000-7000-8000-000000000006",
  // Started the same minute as `root`, in the same folder, unrelated to it.
  unrelated: "0199a1b0-0000-7000-8000-000000000007",
  unrelatedChild: "0199a1b0-0000-7000-8000-000000000008",
})

export const SESSION_ID = THREAD_IDS.root

/** Start instants (UTC, equal to local time in these fixtures). */
export const STARTS = Object.freeze({
  root: "2026-09-25T08:00:00.000Z",
  childExplorer: "2026-09-25T08:01:10.000Z",
  childWorker: "2026-09-25T08:02:20.000Z",
  // The grandchild starts after midnight: R5 scans the day after the root's last record.
  grandchild: "2026-09-26T00:00:30.000Z",
  truncated: "2026-09-25T09:30:00.000Z",
  noMeta: "2026-09-25T10:30:00.000Z",
  unrelated: "2026-09-25T08:00:40.000Z",
  unrelatedChild: "2026-09-25T08:01:50.000Z",
})

const BASE_INSTRUCTIONS = { text: `base instructions ${S}` }

/** `rollout-YYYY-MM-DDThh-mm-ss-<thread>.jsonl` under `sessions/YYYY/MM/DD`. */
export function rolloutRelPath(startIso, threadId) {
  const [date, time] = startIso.slice(0, 19).split("T")
  const [y, m, d] = date.split("-")
  return path.join("sessions", y, m, d, `rollout-${date}T${time.replaceAll(":", "-")}-${threadId}.jsonl`)
}

function addMs(iso, ms) {
  return new Date(Date.parse(iso) + ms).toISOString()
}

/** A rollout builder: each record gets `{timestamp, type, payload}`, in order. */
function rollout(startIso) {
  const lines = []
  let cursor = 0
  const api = {
    lines,
    at(seconds) {
      cursor = seconds
      return api
    },
    /** Append a record `seconds` after the start (keeps the previous time when omitted). */
    rec(type, payload, seconds = cursor) {
      cursor = seconds
      lines.push({ timestamp: addMs(startIso, Math.round(seconds * 1000)), type, payload })
      return api
    },
  }
  return api
}

function sessionMeta({ id, startIso, source = "cli", parentThreadId, agentRole, agentNickname, depth, cwd = `/tmp/${S}/repo`, git = true }) {
  const subSource = parentThreadId
    ? {
        subagent: {
          thread_spawn: {
            parent_thread_id: parentThreadId,
            depth,
            agent_path: null,
            agent_nickname: agentNickname,
            agent_role: agentRole,
          },
        },
      }
    : source
  return {
    session_id: THREAD_IDS.root,
    id,
    ...(parentThreadId ? { parent_thread_id: parentThreadId } : {}),
    timestamp: startIso,
    cwd,
    originator: "codex_cli_rs",
    cli_version: CLI_VERSION,
    source: subSource,
    ...(parentThreadId ? { thread_source: "subagent", agent_nickname: agentNickname, agent_role: agentRole } : {}),
    model_provider: "openai",
    history_mode: "legacy",
    base_instructions: BASE_INSTRUCTIONS,
    ...(git
      ? { git: { commit_hash: "0123456789abcdef0123456789abcdef01234567", branch: `${S}-branch`, repository_url: `https://github.com/${S}/repo.git` } }
      : {}),
  }
}

function turnContext(turnId, { model = ROOT_MODEL, cwd = `/tmp/${S}/repo`, effort = "medium", rootTurnId } = {}) {
  return {
    turn_id: turnId,
    ...(rootTurnId ? { root_turn_id: rootTurnId } : {}),
    cwd,
    current_date: "2026-09-25",
    timezone: "UTC",
    approval_policy: "on-request",
    sandbox_policy: { type: "workspace-write" },
    model,
    personality: "friendly",
    effort,
    summary: "auto",
  }
}

const userMessage = (text) => ({ type: "message", role: "user", content: [{ type: "input_text", text }] })
const assistantMessage = (text) => ({ type: "message", role: "assistant", content: [{ type: "output_text", text }], phase: "final_answer" })
const reasoning = (text) => ({ type: "reasoning", summary: [{ type: "summary_text", text }], content: null, encrypted_content: `${S}-encrypted` })
const functionCall = (callId, name, args, namespace) => ({
  type: "function_call",
  ...(namespace ? { namespace } : {}),
  name,
  arguments: JSON.stringify(args),
  call_id: callId,
})
const functionOutput = (callId, output) => ({ type: "function_call_output", call_id: callId, output })
const tokenUsage = (input, cached, output, reasoningOut) => ({
  input_tokens: input,
  cached_input_tokens: cached,
  cache_write_input_tokens: 0,
  output_tokens: output,
  reasoning_output_tokens: reasoningOut,
  total_tokens: input + output,
})

function tokenCount(total, last, window = 272000) {
  return { type: "token_count", info: { total_token_usage: total, last_token_usage: last, model_context_window: window }, rate_limits: null }
}

function turnStarted(turnId, startedAtSec, rootTurnId) {
  return { type: "task_started", turn_id: turnId, ...(rootTurnId ? { root_turn_id: rootTurnId } : {}), started_at: startedAtSec, model_context_window: 272000, collaboration_mode_kind: "default" }
}

const epoch = (iso) => Math.floor(Date.parse(iso) / 1000)

// ---------------------------------------------------------------------------
// Scenarios. Each returns { threadId, startIso, lines }.
// ---------------------------------------------------------------------------

const ROOT_TURN_1 = "0199a1b0-1111-7000-8000-000000000001"

const DESK_TASK_PATH = `/tmp/${S}/personal-desk/desk-plugin/some-task/task.md`

function rootThread() {
  const t = rollout(STARTS.root)
  const turn1 = ROOT_TURN_1
  const turn2 = "0199a1b0-1111-7000-8000-000000000002"
  t.rec("session_meta", sessionMeta({ id: THREAD_IDS.root, startIso: STARTS.root }), 0)
  // Turn 1: a prompt, a shell git commit, a PR, an apply_patch on a task card, two spawns.
  t.rec("event_msg", turnStarted(turn1, epoch(STARTS.root) + 1), 1)
  t.rec("turn_context", turnContext(turn1), 1.1)
  t.rec("response_item", userMessage(`do the thing ${S}`), 1.2)
  t.rec("response_item", reasoning(`pondering ${S}`), 3)
  t.rec("response_item", functionCall("call_git", "exec_command", { cmd: `git commit -m "fix ${S}"`, workdir: `/tmp/${S}/repo` }), 4)
  t.rec("response_item", functionOutput("call_git", `[main ${COMMIT_SHA.slice(0, 7)}] fix ${S}\n 1 file changed ${COMMIT_SHA} ${S}`), 5)
  t.rec("response_item", functionCall("call_pr", "exec_command", { cmd: `gh pr create --title "t ${S}" --body "b ${S}"`, workdir: `/tmp/${S}/repo` }), 6)
  t.rec("response_item", functionOutput("call_pr", `Process exited with code 0\nOutput:\n${PR_URL}\n${S}`), 9)
  t.rec("response_item", {
    type: "custom_tool_call",
    status: "completed",
    call_id: "call_patch",
    name: "apply_patch",
    input: `*** Begin Patch\n*** Update File: ${DESK_TASK_PATH}\n@@\n-old ${S}\n+new ${S}\n*** End Patch`,
  }, 10)
  t.rec("response_item", { type: "custom_tool_call_output", call_id: "call_patch", output: `Success. Updated ${DESK_TASK_PATH} ${S}` }, 11)
  t.rec("response_item", { type: "local_shell_call", call_id: "call_local", status: "completed", action: { type: "exec", command: ["git", "status", S], timeout_ms: null, working_directory: `/tmp/${S}/repo`, env: null, user: null } }, 12)
  t.rec("response_item", functionOutput("call_local", `On branch ${S}`), 12.5)
  t.rec("response_item", { type: "web_search_call", status: "completed", action: { type: "search", query: `query ${S}` } }, 13)
  t.rec("response_item", functionCall("call_mcp", "desk_status", { arg: S }, "mcp__desk__"), 14)
  t.rec("response_item", functionOutput("call_mcp", `mcp output ${S}`), 15)
  t.rec("response_item", functionCall("call_spawn1", "spawn_agent", { message: `${SPAWN_DESK_TASK_LINE}\nlook at ${S}`, agent_type: "explorer", model: CHILD_MODEL, reasoning_effort: "low" }, "multi_agent_v1"), 60)
  t.rec("response_item", functionOutput("call_spawn1", JSON.stringify({ agent_id: THREAD_IDS.childExplorer, nickname: `${S}-nick-1` })), 61)
  t.rec("response_item", functionCall("call_spawn2", "spawn_agent", { message: `build it ${S}`, agent_type: "worker" }, "multi_agent_v1"), 120)
  t.rec("response_item", functionOutput("call_spawn2", JSON.stringify({ agent_id: THREAD_IDS.childWorker, nickname: `${S}-nick-2` })), 121)
  t.rec("response_item", functionCall("call_wait", "wait_agent", { targets: [THREAD_IDS.childExplorer, THREAD_IDS.childWorker], timeout_ms: 30000 }, "multi_agent_v1"), 130)
  t.rec("response_item", functionOutput("call_wait", JSON.stringify({ status: {}, timed_out: true })), 160)
  // A record type no deriver version knows about, with a payload that must never be read.
  t.rec("future_record_kind", { secret: `unknown ${S}` }, 161)
  t.rec("event_msg", tokenCount(tokenUsage(1000, 400, 200, 50), tokenUsage(1000, 400, 200, 50)), 162)
  t.rec("response_item", assistantMessage(`done ${S}`), 163)
  t.rec("event_msg", { type: "task_complete", turn_id: turn1, last_agent_message: `final ${S}`, started_at: epoch(STARTS.root) + 1, completed_at: epoch(STARTS.root) + 164, duration_ms: 163000, time_to_first_token_ms: 900 }, 164)
  // Turn 2: a second turn, then an interrupt.
  t.rec("event_msg", turnStarted(turn2, epoch(STARTS.root) + 200), 200)
  t.rec("turn_context", turnContext(turn2, { effort: "high" }), 200.1)
  t.rec("response_item", userMessage(`again ${S}`), 200.2)
  t.rec("event_msg", tokenCount(tokenUsage(2600, 1400, 500, 120), tokenUsage(1600, 1000, 300, 70)), 210)
  t.rec("event_msg", { type: "turn_aborted", turn_id: turn2, reason: "interrupted", started_at: epoch(STARTS.root) + 200, completed_at: epoch(STARTS.root) + 215, duration_ms: 15000 }, 215)
  return { threadId: THREAD_IDS.root, startIso: STARTS.root, lines: t.lines }
}

function childThread({ id, startIso, parent, role, depth, nickname, model, prompt, effort }) {
  const t = rollout(startIso)
  const turn = `0199a1b0-2222-7000-8000-${id.slice(-12)}`
  t.rec("session_meta", sessionMeta({ id, startIso, parentThreadId: parent, agentRole: role, agentNickname: nickname, depth }), 0)
  t.rec("event_msg", turnStarted(turn, epoch(startIso), ROOT_TURN_1), 0.5)
  t.rec("turn_context", turnContext(turn, { model, effort, rootTurnId: ROOT_TURN_1 }), 0.6)
  t.rec("response_item", userMessage(prompt), 0.7)
  t.rec("response_item", assistantMessage(`child answer ${S}`), 20)
  t.rec("event_msg", tokenCount(tokenUsage(500, 100, 80, 10), tokenUsage(500, 100, 80, 10)), 21)
  t.rec("event_msg", { type: "task_complete", turn_id: turn, last_agent_message: `child final ${S}`, started_at: epoch(startIso), completed_at: epoch(startIso) + 22, duration_ms: 22000, time_to_first_token_ms: 500 }, 22)
  return t
}

function explorerThread() {
  const t = childThread({ id: THREAD_IDS.childExplorer, startIso: STARTS.childExplorer, parent: THREAD_IDS.root, role: "explorer", depth: 1, nickname: `${S}-nick-1`, model: CHILD_MODEL, effort: "low", prompt: `${SPAWN_DESK_TASK_LINE}\nlook at ${S}` })
  return { threadId: THREAD_IDS.childExplorer, startIso: STARTS.childExplorer, lines: t.lines }
}

function workerThread() {
  const t = childThread({ id: THREAD_IDS.childWorker, startIso: STARTS.childWorker, parent: THREAD_IDS.root, role: "worker", depth: 1, nickname: `${S}-nick-2`, model: ROOT_MODEL, effort: "medium", prompt: `build it ${S}` })
  // The worker spawns the grandchild.
  t.rec("response_item", functionCall("call_spawn_gc", "spawn_agent", { message: `grandchild task ${S}`, agent_type: "explorer" }, "multi_agent_v1"), 23)
  t.rec("response_item", functionOutput("call_spawn_gc", JSON.stringify({ agent_id: THREAD_IDS.grandchild, nickname: `${S}-nick-3` })), 24)
  return { threadId: THREAD_IDS.childWorker, startIso: STARTS.childWorker, lines: t.lines }
}

function grandchildThread() {
  const t = childThread({ id: THREAD_IDS.grandchild, startIso: STARTS.grandchild, parent: THREAD_IDS.childWorker, role: "explorer", depth: 2, nickname: `${S}-nick-3`, model: CHILD_MODEL, effort: "low", prompt: `grandchild task ${S}` })
  return { threadId: THREAD_IDS.grandchild, startIso: STARTS.grandchild, lines: t.lines }
}

function unrelatedThread() {
  const t = rollout(STARTS.unrelated)
  const turn = "0199a1b0-3333-7000-8000-000000000001"
  t.rec("session_meta", { ...sessionMeta({ id: THREAD_IDS.unrelated, startIso: STARTS.unrelated }), session_id: THREAD_IDS.unrelated }, 0)
  t.rec("event_msg", turnStarted(turn, epoch(STARTS.unrelated)), 0.5)
  t.rec("turn_context", turnContext(turn), 0.6)
  t.rec("response_item", userMessage(`unrelated work ${S}`), 0.7)
  t.rec("response_item", assistantMessage(`unrelated answer ${S}`), 5)
  return { threadId: THREAD_IDS.unrelated, startIso: STARTS.unrelated, lines: t.lines }
}

function unrelatedChildThread() {
  // A child of the unrelated thread, started while the root session was still running.
  const t = childThread({ id: THREAD_IDS.unrelatedChild, startIso: STARTS.unrelatedChild, parent: THREAD_IDS.unrelated, role: "worker", depth: 1, nickname: `${S}-nick-x`, model: CHILD_MODEL, effort: "low", prompt: `unrelated child ${S}` })
  t.lines[0].payload.session_id = THREAD_IDS.unrelated
  return { threadId: THREAD_IDS.unrelatedChild, startIso: STARTS.unrelatedChild, lines: t.lines }
}

function noMetaThread() {
  const t = rollout(STARTS.noMeta)
  const turn = "0199a1b0-4444-7000-8000-000000000001"
  t.rec("event_msg", turnStarted(turn, epoch(STARTS.noMeta)), 0.5)
  t.rec("turn_context", turnContext(turn), 0.6)
  t.rec("response_item", userMessage(`no meta ${S}`), 0.7)
  t.rec("response_item", assistantMessage(`no meta answer ${S}`), 5)
  return { threadId: THREAD_IDS.noMeta, startIso: STARTS.noMeta, lines: t.lines }
}

function truncatedThread() {
  const t = rollout(STARTS.truncated)
  const turn = "0199a1b0-5555-7000-8000-000000000001"
  t.rec("session_meta", sessionMeta({ id: THREAD_IDS.truncated, startIso: STARTS.truncated }), 0)
  t.rec("event_msg", turnStarted(turn, epoch(STARTS.truncated)), 0.5)
  t.rec("turn_context", turnContext(turn), 0.6)
  t.rec("response_item", userMessage(`truncated ${S}`), 0.7)
  t.rec("response_item", functionCall("call_cut", "exec_command", { cmd: `echo ${S}` }), 4)
  return { threadId: THREAD_IDS.truncated, startIso: STARTS.truncated, lines: t.lines, truncate: true }
}

/** Every scenario, keyed by a short name. */
export const SCENARIOS = Object.freeze({
  root: rootThread,
  childExplorer: explorerThread,
  childWorker: workerThread,
  grandchild: grandchildThread,
  unrelated: unrelatedThread,
  unrelatedChild: unrelatedChildThread,
  noMeta: noMetaThread,
  truncated: truncatedThread,
})

/** The rollout file text. A truncated rollout ends mid-line with no newline. */
export function rolloutText({ lines, truncate = false }) {
  const serialized = lines.map((line) => JSON.stringify(line))
  if (!truncate) return `${serialized.join("\n")}\n`
  const last = serialized.pop()
  return `${serialized.join("\n")}\n${last.slice(0, Math.floor(last.length / 2))}`
}

export function generate({ outDir = here } = {}) {
  rmSync(path.join(outDir, "sessions"), { recursive: true, force: true })
  const written = []
  for (const build of Object.values(SCENARIOS)) {
    const scenario = build()
    const file = path.join(outDir, rolloutRelPath(scenario.startIso, scenario.threadId))
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, rolloutText(scenario))
    written.push(file)
  }
  return written
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  generate()
}
