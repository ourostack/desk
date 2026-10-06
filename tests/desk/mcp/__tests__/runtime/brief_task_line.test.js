// The brief task line (Package H): a subagent brief carries `Desk-Task: <track>/<slug>`, added by the hook from the main agent's focus or asked for once by a denial.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  BRIEF_FOCUS_DIR,
  NO_RECORD_REASON,
  NO_TASK_REASON,
  SUBAGENT_REASON,
  UNREADABLE_REASON,
  UNREAD_FOCUS_REASON,
  UNUSABLE_FOCUS_REASON,
  briefDecision,
  briefHookOutput,
  declaredFocus,
  focusFile,
  recordBriefFocus,
} from "../../../../../plugins/desk/mcp/src/runtime/brief-task-line.js"
import { parseDeskTaskLine } from "../../../../../plugins/desk/mcp/src/factory/desk-task-line.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "brief-task-line.cjs")
const ROOT = mkdtempSync(path.join(tmpdir(), "brief-line-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = () => path.join(ROOT, `state-${(counter += 1)}`)
const DESK = path.join(ROOT, "desk")

const FOCUS = "mcp__plugin_desk_desk__task_focus"
const CREATE = "mcp__plugin_desk_desk__task_create"
const json = (value) => [{ type: "text", text: JSON.stringify(value) }]
const focused = (track = "greenhouse-ops", slug = "rain-delay") => ({ hook_event_name: "PostToolUse", session_id: "s1", tool_name: FOCUS, tool_input: { track, slug }, tool_response: json({ status: "focused", track, slug, task_status: "processing", recent_progress: [] }) })
const spawn = (prompt, extra = {}) => ({ hook_event_name: "PreToolUse", session_id: "s1", tool_name: "Agent", tool_input: { description: "x", prompt, subagent_type: "general-purpose" }, ...extra })

test("declaredFocus reads a successful task_focus or a focusing task_create on any host's Desk server name, and nothing else", () => {
  assert.deepEqual(declaredFocus(FOCUS, { track: "a", slug: "b" }, json({ status: "focused" })), { track: "a", slug: "b" })
  assert.deepEqual(declaredFocus("desk-task_focus", { clear: true }, JSON.stringify({ status: "cleared" })), { clear: true }, "Copilot's name, a plain string result")
  assert.deepEqual(declaredFocus(CREATE, { track: "a", slug: "b", focus: true }, { content: json({ path: "a/b/task.md" }) }), { track: "a", slug: "b" })
  assert.equal(declaredFocus(CREATE, { track: "a", slug: "b" }, json({ path: "a/b/task.md" })), null, "a task_create without focus: true declares nothing")
  assert.equal(declaredFocus("mcp__github__task_focus", { track: "a", slug: "b" }, json({ status: "focused" })), null, "another server's tool")
  assert.equal(declaredFocus("Bash", { track: "a", slug: "b" }, json({ status: "focused" })), null)
  assert.equal(declaredFocus(undefined, { track: "a", slug: "b" }, json({ status: "focused" })), null)
  assert.equal(declaredFocus(FOCUS, null, json({ status: "focused" })), null)
  assert.equal(declaredFocus(FOCUS, { track: "a", slug: "b" }, "task_focus: card not found: a/b"), null, "an error text is no result")
  assert.equal(declaredFocus(FOCUS, { track: "a", slug: "b" }, json([1, 2])), null, "an array is no result")
  assert.equal(declaredFocus(FOCUS, { track: "a", slug: "b" }, json({ status: "focused", error: "x" })), null)
  assert.equal(declaredFocus(CREATE, { track: "a", slug: "b", focus: true }, json({ status: "failed" })), null)
  assert.equal(declaredFocus(FOCUS, { track: "a", slug: "b" }, json({ status: "odd" })), null)
  assert.equal(declaredFocus(FOCUS, { track: "_meta", slug: "b" }, json({ status: "focused" })), null, "a segment that is no task folder")
  assert.equal(declaredFocus(FOCUS, { track: "a", slug: "b" }, 42), null, "a response of no known shape")
  assert.equal(declaredFocus(FOCUS, { track: "a", slug: "b" }, { other: 1 }), null)
  assert.deepEqual(declaredFocus(FOCUS, { track: "a", slug: "b" }, { text: JSON.stringify({ status: "focused" }) }), { track: "a", slug: "b" })
})

test("recordBriefFocus keeps the main agent's last focus per session and ignores a subagent's call, a call it cannot place, and a failure", () => {
  const stateDir = fresh()
  assert.deepEqual(recordBriefFocus("claude", focused(), { stateDir }), {})
  assert.deepEqual(JSON.parse(readFileSync(focusFile(stateDir, "s1"), "utf8")), { task: { track: "greenhouse-ops", slug: "rain-delay" } })
  recordBriefFocus("claude", { ...focused("other", "task"), agent_id: "a1" }, { stateDir })
  assert.deepEqual(JSON.parse(readFileSync(focusFile(stateDir, "s1"), "utf8")).task.slug, "rain-delay", "a subagent's focus is not the session's")
  recordBriefFocus("claude", { ...focused(), session_id: "" }, { stateDir })
  recordBriefFocus("claude", { ...focused(), tool_name: "Bash" }, { stateDir })
  recordBriefFocus("claude", { session_id: "s1", tool_name: FOCUS, tool_input: { clear: true }, tool_response: json({ status: "cleared" }) }, { stateDir })
  assert.deepEqual(JSON.parse(readFileSync(focusFile(stateDir, "s1"), "utf8")), { task: null })
  recordBriefFocus("claude", { ...focused(), tool_input: "not an object" }, { stateDir })
  assert.deepEqual(JSON.parse(readFileSync(focusFile(stateDir, "s1"), "utf8")), { task: null })
  // A state folder that is a file: the write fails and is swallowed.
  const blocked = path.join(ROOT, `file-${(counter += 1)}`)
  writeFileSync(blocked, "x")
  assert.deepEqual(recordBriefFocus("claude", focused(), { stateDir: blocked }), {})
  assert.deepEqual(recordBriefFocus("claude", focused()), {}, "no state folder given: nothing kept, nothing thrown")
})

test("recordBriefFocus reads Copilot's payload: toolArgs as an object or JSON text, and only a successful result", () => {
  const stateDir = fresh()
  const copilot = (toolArgs, resultType = "success") => ({ sessionId: "c1", toolName: "desk-task_focus", toolArgs, toolResult: { resultType, textResultForLlm: JSON.stringify({ status: "focused" }) } })
  recordBriefFocus("copilot", copilot(JSON.stringify({ track: "a", slug: "b" })), { stateDir })
  assert.deepEqual(JSON.parse(readFileSync(focusFile(stateDir, "c1"), "utf8")), { task: { track: "a", slug: "b" } })
  recordBriefFocus("copilot", copilot({ track: "c", slug: "d" }, "failure"), { stateDir })
  recordBriefFocus("copilot", copilot("{not json"), { stateDir })
  recordBriefFocus("copilot", copilot(7), { stateDir })
  recordBriefFocus("copilot", { sessionId: "c1", toolName: "desk-task_focus", toolArgs: { track: "c", slug: "d" } }, { stateDir })
  assert.deepEqual(JSON.parse(readFileSync(focusFile(stateDir, "c1"), "utf8")), { task: { track: "a", slug: "b" } }, "none of those replaced the focus")
  recordBriefFocus("copilot", copilot({ track: "c", slug: "d" }), { stateDir })
  assert.deepEqual(JSON.parse(readFileSync(focusFile(stateDir, "c1"), "utf8")), { task: { track: "c", slug: "d" } })
})

test("recording prunes session files older than a week and tolerates one it cannot remove", () => {
  const stateDir = fresh()
  const dir = path.join(stateDir, BRIEF_FOCUS_DIR)
  mkdirSync(path.join(dir, "stuck"), { recursive: true })
  writeFileSync(path.join(dir, "old.json"), "{}")
  const old = new Date(Date.now() - 8 * 86_400_000)
  utimesSync(path.join(dir, "old.json"), old, old)
  utimesSync(path.join(dir, "stuck"), old, old)
  recordBriefFocus("claude", focused(), { stateDir })
  const left = readdirSync(dir)
  assert.ok(!left.includes("old.json"))
  assert.ok(left.includes("stuck"), "a folder cannot be unlinked; it is skipped")
})

test("a brief with one valid Desk-Task line, or Desk-Task: none, passes untouched", () => {
  const stateDir = fresh()
  for (const prompt of ["Do x.\n\nDesk-Task: greenhouse-ops/rain-delay", "- Desk-Task: a/b\nmore", "Desk-Task: none", "Brief.\n> Desk-Task: NONE"]) {
    assert.deepEqual(briefDecision("claude", spawn(prompt), { stateDir, deskRoot: DESK }), { action: "pass" }, prompt)
  }
})

test("a brief with no line is given the main agent's held task on Claude Code, and the added line is one the binder reads", () => {
  const stateDir = fresh()
  recordBriefFocus("claude", focused(), { stateDir })
  const decision = briefDecision("claude", spawn("Investigate the flaky test.  \n\n"), { stateDir, deskRoot: DESK })
  assert.equal(decision.action, "add")
  assert.equal(decision.input.prompt, "Investigate the flaky test.\n\nDesk-Task: greenhouse-ops/rain-delay\n")
  assert.equal(decision.input.subagent_type, "general-purpose", "the rest of the input is kept")
  assert.deepEqual(parseDeskTaskLine(decision.input.prompt), { track: "greenhouse-ops", slug: "rain-delay" })
  // The hook tags the brief; it grants nothing. No permission decision, so the host's normal permission check runs on the changed input.
  assert.deepEqual(briefHookOutput("claude", decision), { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: decision.input, additionalContext: "Desk added the line `Desk-Task: greenhouse-ops/rain-delay` to this subagent's brief, the task this session holds." } })
})

test("with no task held the brief is denied once with the line to add; a subagent's own brief and a malformed line are denied with their own reasons", () => {
  const stateDir = fresh()
  const none = briefDecision("claude", spawn("Look up x."), { stateDir, deskRoot: DESK })
  assert.deepEqual(none, { action: "deny", reason: NO_RECORD_REASON }, "no focus record: Desk says it has no record, not that no task is held")
  for (const reason of [NO_TASK_REASON, NO_RECORD_REASON, UNREAD_FOCUS_REASON, UNUSABLE_FOCUS_REASON]) assert.match(reason, /^Add a `Desk-Task: <track>\/<slug>` line to this brief, or `Desk-Task: none`/u)
  assert.deepEqual(briefHookOutput("claude", none), { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: NO_RECORD_REASON } })
  recordBriefFocus("claude", focused(), { stateDir })
  assert.deepEqual(briefDecision("claude", spawn("Look up x.", { agent_id: "a1" }), { stateDir, deskRoot: DESK }), { action: "deny", reason: SUBAGENT_REASON }, "a subagent copies its own brief's line")
  assert.deepEqual(briefDecision("claude", spawn("Desk-Task: a/b\nDesk-Task: c/d"), { stateDir, deskRoot: DESK }), { action: "deny", reason: UNREADABLE_REASON })
  assert.deepEqual(briefDecision("claude", spawn("Desk-Task: just-a-slug"), { stateDir, deskRoot: DESK }), { action: "deny", reason: UNREADABLE_REASON })
  recordBriefFocus("claude", { session_id: "s1", tool_name: FOCUS, tool_input: { clear: true }, tool_response: json({ status: "cleared" }) }, { stateDir })
  const reasonFor = (extra) => briefDecision("claude", spawn("Look up x.", extra), { stateDir, deskRoot: DESK }).reason
  assert.equal(reasonFor(), NO_TASK_REASON, "a cleared focus holds no task")
  assert.match(NO_TASK_REASON, /task focus was cleared/u)
  for (const [record, why] of [["{not json", "a corrupt record"], [JSON.stringify(["x"]), "a record that is not an object"], [JSON.stringify({}), "a record with no task"], [JSON.stringify({ task: "a/b" }), "a task that is not an object"], [JSON.stringify({ task: { track: "a" } }), "a task with no slug"]]) {
    writeFileSync(focusFile(stateDir, "s1"), record)
    assert.equal(reasonFor(), UNREAD_FOCUS_REASON, why)
  }
  assert.match(UNREAD_FOCUS_REASON, /could not read the task this session holds/u)
  assert.equal(reasonFor({ session_id: undefined }), UNREAD_FOCUS_REASON, "no session id: the record cannot be found")
  const blocked = fresh()
  mkdirSync(focusFile(blocked, "s1"), { recursive: true })
  assert.equal(briefDecision("claude", spawn("Look up x."), { stateDir: blocked, deskRoot: DESK }).reason, UNREAD_FOCUS_REASON, "a record that cannot be read (not missing)")
  // A held task whose names the binder's parser would not read back is never written into a brief.
  for (const task of [{ track: "_meta", slug: "x" }, { track: "green house", slug: "x" }, { track: "a", slug: "b\nDesk-Task: c/d" }, { track: "a", slug: "b c" }]) {
    writeFileSync(focusFile(stateDir, "s1"), JSON.stringify({ task }))
    assert.equal(reasonFor(), UNUSABLE_FOCUS_REASON, JSON.stringify(task))
  }
})

test("Copilot: a held focus passes (the spawn-time rule credits it), no focus denies in Copilot's flat shape", () => {
  const stateDir = fresh()
  const call = { sessionId: "c1", toolName: "task", toolArgs: { prompt: "Review the diff.", agent_type: "code-review" } }
  const denied = briefDecision("copilot", call, { stateDir, deskRoot: DESK })
  assert.deepEqual(briefHookOutput("copilot", denied), { permissionDecision: "deny", permissionDecisionReason: NO_RECORD_REASON })
  recordBriefFocus("copilot", { sessionId: "c1", toolName: "desk-task_focus", toolArgs: { track: "a", slug: "b" }, toolResult: { resultType: "success", textResultForLlm: JSON.stringify({ status: "focused" }) } }, { stateDir })
  assert.deepEqual(briefDecision("copilot", call, { stateDir, deskRoot: DESK }), { action: "pass" })
  assert.deepEqual(briefHookOutput("copilot", { action: "pass" }), {})
})

test("the check passes what is not its business: another tool, another host, a prompt that is not text, no desk", () => {
  const stateDir = fresh()
  assert.deepEqual(briefDecision("claude", { ...spawn("x"), tool_name: "Bash" }, { stateDir, deskRoot: DESK }), { action: "pass" })
  assert.deepEqual(briefDecision("codex", spawn("x"), { stateDir, deskRoot: DESK }), { action: "pass" })
  assert.deepEqual(briefDecision("claude", { ...spawn("x"), tool_input: { prompt: 7 } }, { stateDir, deskRoot: DESK }), { action: "pass" })
  assert.deepEqual(briefDecision("claude", spawn("x"), { stateDir, deskRoot: null }), { action: "pass" })
  assert.deepEqual(briefDecision("claude", { ...spawn("x"), tool_name: "Task" }, { stateDir, deskRoot: DESK }).action, "deny", "Task is the older name of the subagent tool")
})

// ---- the hook script ----

const hookEnv = (home) => ({ PATH: process.env.PATH, HOME: home, XDG_STATE_HOME: path.join(home, "state"), DESK, DESK_TEST_RUN_DIR: process.env.DESK_TEST_RUN_DIR ?? "" })
const run = (args, payload, env) => spawnSync(process.execPath, [hook, ...args], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env, encoding: "utf8", timeout: 20_000 })

test("the .cjs entry point records a focus, adds the line, denies with none held, answers {} at once for other tools, and fails open", () => {
  const home = path.join(ROOT, `home-${(counter += 1)}`)
  mkdirSync(path.join(DESK, "greenhouse-ops", "rain-delay"), { recursive: true })
  const env = hookEnv(home)
  const deny = run(["claude", "check"], spawn("Look up x."), env)
  assert.equal(deny.status, 0)
  assert.equal(JSON.parse(deny.stdout).hookSpecificOutput.permissionDecision, "deny")
  assert.equal(run(["claude", "record"], focused(), env).stdout, "{}\n")
  assert.ok(existsSync(path.join(home, "state", "ouroboros-skills", "desk", BRIEF_FOCUS_DIR)))
  const added = JSON.parse(run(["claude", "check"], spawn("Look up x."), env).stdout)
  assert.match(added.hookSpecificOutput.updatedInput.prompt, /\nDesk-Task: greenhouse-ops\/rain-delay\n$/u)
  assert.equal(Object.hasOwn(added.hookSpecificOutput, "permissionDecision"), false, "the process output grants nothing either")
  assert.equal(run(["claude", "check"], { ...spawn("x"), tool_name: "Read" }, env).stdout, "{}\n")
  assert.equal(run(["claude", "record"], { ...focused(), tool_name: "Bash" }, env).stdout, "{}\n")
  assert.equal(run(["copilot", "check"], { sessionId: "c9", toolName: "task", toolArgs: { prompt: "x" } }, env).stdout.trim().startsWith('{"permissionDecision":"deny"'), true)
  assert.equal(run(["claude", "check"], "not json", env).stdout, "{}\n")
})

test("hooks.json and copilot-hooks.json register the check on the subagent tool and the record on task_focus and task_create", () => {
  const claude = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).hooks
  const check = claude.PreToolUse.find((group) => group.hooks.some((entry) => /brief-task-line\.cjs" claude check$/u.test(entry.command)))
  const checkMatcher = new RegExp(`^(?:${check.matcher})$`, "u")
  assert.ok(checkMatcher.test("Agent") && checkMatcher.test("Task"))
  const record = claude.PostToolUse.find((group) => group.hooks.some((entry) => /brief-task-line\.cjs" claude record$/u.test(entry.command)))
  const recordMatcher = new RegExp(`^(?:${record.matcher})$`, "u")
  assert.ok(recordMatcher.test(FOCUS) && recordMatcher.test(CREATE))
  assert.equal(recordMatcher.test("mcp__plugin_desk_desk__task_update"), false)
  const copilot = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json"), "utf8")).hooks
  assert.ok(copilot.preToolUse.some((entry) => /brief-task-line\.cjs" copilot check$/u.test(entry.bash)))
  assert.ok(copilot.postToolUse.some((entry) => /brief-task-line\.cjs" copilot record$/u.test(entry.bash)))
})
