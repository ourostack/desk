// The gate report: which Desk hooks fired in a run, on either host. No model calls.
// Run: node --test evals/boot-acceptance/gates.test.mjs

import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { test } from "node:test"

import { parseArgs } from "./run.mjs"
import { claudeGates, copilotGates, discountCancelledStart, copilotGatesUnavailable, gateReport, parseEventLines, readCopilotSessionEvents, reduceCopilotEvents } from "./gates.mjs"

const GH = ["gho", "_", "Zz9Yy8Xx7Ww6Vv5Uu4Tt3Ss2Rr1Qq0Pp9Oo8"].join("")
const POINTER = "Desk boot is pending for this session: run `node /x/session-boot.js` first (one quick call), then answer this message."

const line = (type, data, timestamp = "2026-10-01T19:00:00.000Z") => JSON.stringify({ type, data, timestamp })
const start = (id, hookType, input = {}) => line("hook.start", { hookInvocationId: id, hookType, input })
const end = (id, hookType, output, success = true) => line("hook.end", { hookInvocationId: id, hookType, success, ...(output === undefined ? {} : { output }) })
const log = (...lines) => `${lines.join("\n")}\n`

// A new Copilot session as 1.0.89 writes it: the prompt hook first (it has no recorded session yet), then the user message, then sessionStart.
const newSessionBeforeFix = () => log(
  line("session.start", { selectedModel: "claude-haiku-4.5", copilotVersion: "1.0.89", context: { cwd: "/a" }, ignored: true }),
  start("p1", "userPromptSubmitted", { sessionId: "s", prompt: "hi", cwd: "/a" }),
  end("p1", "userPromptSubmitted", undefined),
  line("user.message", { content: "hi", transformedContent: "<current_datetime>t</current_datetime>\n\nhi", messageId: "m1" }),
  start("s1", "sessionStart", { source: "new", initialPrompt: "hi" }),
  end("s1", "sessionStart", { additionalContext: "foundation ".repeat(100) }),
  start("t1", "preToolUse", { toolCalls: [{ id: "c", name: "bash", args: { command: "git stash", description: "d" } }] }),
  end("t1", "preToolUse", { permissionDecision: "deny", permissionDecisionReason: "Commit only your own paths with git commit <paths>. Desk protects this checkout: /desk" }),
  start("t2", "preToolUse", { toolCalls: [{ id: "c2", name: "view", args: { path: "/a" } }] }),
  end("t2", "preToolUse", {}),
  start("a1", "agentStop", { stopReason: "end_turn", stop_hook_active: false, transcriptPath: "/long/path" }),
  end("a1", "agentStop", { decision: "block", reason: "restate" }),
  start("a2", "agentStop", { stopReason: "end_turn", stop_hook_active: true }),
  end("a2", "agentStop", {}),
)

test("a Copilot log from before the fix: no pointer on the first prompt, sessionStart ran after it, one denial and one stop block", () => {
  const gates = copilotGates(parseEventLines(newSessionBeforeFix()))
  assert.equal(gates.events_saved, true)
  assert.equal(gates.session_start.fired, 1)
  assert.equal(gates.session_start.injected, true)
  assert.equal(gates.session_start.context_chars, "foundation ".repeat(100).length)
  assert.equal(gates.session_start.after_first_prompt_hook, true)
  assert.deepEqual(gates.first_prompt_pointer, { prompts: 1, injected_on_first_prompt: false, reached_model: false, injected_count: 0 })
  assert.equal(gates.pre_tool_use_denials, 1)
  assert.equal(gates.agent_stop_blocks, 1)
  assert.equal(gates.hook_failures, 0)
  assert.deepEqual(gates.hook_order, ["userPromptSubmitted", "sessionStart", "preToolUse", "agentStop"])
})

// Copilot 1.0.x logs a denied preToolUse call as `{ "<tool call id>": "Denied by preToolUse hook: <reason>" }` in the hook's output (round I, resume-named-task runs 1 and 2),
// not as `permissionDecision`. An agentStop block is logged as `{ decision: "block", reason }` (probe session 2c7404f2), which the counter already reads.
test("a Copilot denial logged as a tool-call-id map counts as a preToolUse denial, alongside the permissionDecision shape", () => {
  const text = log(
    start("t1", "preToolUse", { toolCalls: [{ name: "bash", command: "node - << 'EOF'" }] }),
    end("t1", "preToolUse", { toolu_01C1r4tsLkj5V2uN27B2YwM8: "Denied by preToolUse hook: Desk denies a shell command that writes an existing task card" }),
    start("t2", "preToolUse", { toolCalls: [{ name: "desk-task_update" }] }),
    end("t2", "preToolUse", {}),
    start("t3", "preToolUse", { toolCalls: [{ name: "edit" }] }),
    end("t3", "preToolUse", { toolu_01846KpY6suzkZLXUv4YWy7r: "Denied by preToolUse hook: Desk denies a direct edit of an existing task card" }),
    start("t4", "preToolUse", { toolCalls: [{ name: "bash" }] }),
    end("t4", "preToolUse", { permissionDecision: "deny", permissionDecisionReason: "x" }),
    start("t5", "preToolUse", { toolCalls: [{ name: "view" }] }),
    end("t5", "preToolUse", { toolu_x: "Allowed" }),
    start("a1", "agentStop", { stopReason: "end_turn", stop_hook_active: false }),
    end("a1", "agentStop", { decision: "block", reason: "PROBE-CONTINUE" }),
    start("a2", "agentStop", { stopReason: "end_turn", stop_hook_active: true }),
    end("a2", "agentStop", {}),
  )
  const gates = copilotGates(parseEventLines(text))
  assert.equal(gates.pre_tool_use_denials, 3)
  assert.equal(gates.agent_stop_blocks, 1)
})

test("a preToolUse hook.end whose output is null, a string or absent is not a denial and does not throw", () => {
  const text = log(
    start("t1", "preToolUse", {}),
    line("hook.end", { hookInvocationId: "t1", hookType: "preToolUse", success: true, output: null }),
    start("t2", "preToolUse", {}),
    line("hook.end", { hookInvocationId: "t2", hookType: "preToolUse", success: true, output: "ok" }),
    start("t3", "preToolUse", {}),
    end("t3", "preToolUse", { permissionDecision: "deny" }),
  )
  assert.equal(copilotGates(parseEventLines(text)).pre_tool_use_denials, 1)
})

test("a Copilot log with the pointer on the first prompt records that it was injected and that it reached the model", () => {
  const text = log(
    start("p1", "userPromptSubmitted", { prompt: "hi" }),
    end("p1", "userPromptSubmitted", { additionalContext: POINTER }),
    line("user.message", { content: "hi", transformedContent: `hi\n\n<system_reminder>\n${POINTER}\n</system_reminder>` }),
    start("p2", "userPromptSubmitted", { prompt: "again" }),
    end("p2", "userPromptSubmitted", {}),
  )
  const gates = copilotGates(parseEventLines(text))
  assert.deepEqual(gates.first_prompt_pointer, { prompts: 2, injected_on_first_prompt: true, reached_model: true, injected_count: 1 })
  assert.equal(gates.session_start.fired, 0)
  assert.equal(gates.session_start.injected, false)
  assert.equal(gates.session_start.context_chars, 0)
  assert.equal(gates.session_start.after_first_prompt_hook, null)
})

test("a pointer the hook returned but the model's message does not carry is told apart from one that reached it", () => {
  const text = log(
    start("p1", "userPromptSubmitted", {}),
    end("p1", "userPromptSubmitted", { additionalContext: POINTER }),
    line("user.message", { content: "hi", transformedContent: "hi" }),
  )
  assert.deepEqual(copilotGates(parseEventLines(text)).first_prompt_pointer, { prompts: 1, injected_on_first_prompt: true, reached_model: false, injected_count: 1 })
})

test("an empty log, failed hooks, an unmatched hook and a log with no user message are all counted without throwing", () => {
  const empty = copilotGates([])
  assert.equal(empty.first_prompt_pointer.prompts, 0)
  assert.equal(empty.first_prompt_pointer.injected_on_first_prompt, false)
  assert.equal(empty.first_prompt_pointer.reached_model, false)
  assert.deepEqual(empty.hook_order, [])
  const text = log(start("x", "preToolUse", {}), end("x", "preToolUse", undefined, false), start("y", "sessionStart", {}))
  const gates = copilotGates(parseEventLines(text))
  assert.equal(gates.hook_failures, 1)
  assert.equal(gates.session_start.fired, 1)
  assert.equal(gates.session_start.injected, false)
  assert.equal(gates.pre_tool_use_denials, 0)
})

test("the hook order collapses repeats and stops at twelve entries", () => {
  const lines = []
  for (let i = 0; i < 30; i++) lines.push(start(`h${i}`, i % 2 === 0 ? "preToolUse" : "postToolUse", {}))
  const order = copilotGates(parseEventLines(log(...lines))).hook_order
  assert.equal(order.length, 12)
  assert.deepEqual(order.slice(0, 3), ["preToolUse", "postToolUse", "preToolUse"])
})

test("the reduced log keeps session, hook and user-message events only, cuts hook inputs down and redacts secrets", () => {
  const raw = log(
    line("session.start", { selectedModel: "claude-haiku-4.5", copilotVersion: "1.0.89", context: { cwd: "/secret/path" } }),
    line("session.resume", { whatever: 1 }),
    line("system.message", { content: "huge system prompt" }),
    start("p1", "userPromptSubmitted", { sessionId: "s", prompt: "p".repeat(500), cwd: "/a", timestamp: 1 }),
    end("p1", "userPromptSubmitted", { additionalContext: `${POINTER} ${GH}` }),
    start("t1", "postToolUse", { toolName: "bash", toolArgs: { command: "x" }, toolResult: { textResultForLlm: "BIG" } }),
    start("t2", "preToolUse", { toolCalls: [{ id: "c", name: "bash", args: { command: "c".repeat(500), description: "d" } }] }),
    start("t3", "preToolUse", "not an object"),
    start("t4", "sessionStart", { source: "new", initialPrompt: "ip", sessionId: "s" }),
    line("assistant.message", { content: "x" }),
    "this line is not json",
    line("user.message", { content: "c".repeat(3000), transformedContent: "t" }),
    end("e1", "preToolUse", "a string output"),
  )
  const reduced = reduceCopilotEvents(raw, { secrets: ["session-secret-value"] })
  const events = parseEventLines(reduced)
  assert.deepEqual(events.map((e) => e.type), ["session.start", "session.resume", "hook.start", "hook.end", "hook.start", "hook.start", "hook.start", "hook.start", "user.message", "hook.end"])
  assert.deepEqual(events[0].data, { selectedModel: "claude-haiku-4.5", copilotVersion: "1.0.89" })
  assert.equal(events[2].data.input.prompt.length, 300 + "...[cut]".length)
  assert.equal(events[2].data.input.cwd, undefined)
  assert.equal(events[4].data.input.toolName, "bash")
  assert.equal(events[4].data.input.toolArgs, undefined)
  assert.equal(events[5].data.input.toolCalls[0].command.length, 300 + "...[cut]".length)
  assert.deepEqual(events[6].data.input, {})
  assert.deepEqual(events[7].data.input, { source: "new", initialPrompt: "ip" })
  assert.equal(events[8].data.content.length, 2000 + "...[cut]".length)
  assert.equal(events[9].data.output, "a string output")
  assert.ok(!reduced.includes(GH))
  assert.match(events[3].data.output.additionalContext, /\[REDACTED/u)
  // The reduced log reads back to the same gates as the full one.
  assert.deepEqual(copilotGates(parseEventLines(reduceCopilotEvents(newSessionBeforeFix()))), copilotGates(parseEventLines(newSessionBeforeFix())))
})

test("a log with none of the kept events reduces to nothing, and an exact secret value is redacted wherever it sits", () => {
  assert.equal(reduceCopilotEvents(log(line("assistant.message", { content: "x" }))), "")
  assert.equal(reduceCopilotEvents(""), "")
  const reduced = reduceCopilotEvents(log(line("user.message", { content: "token is session-secret-value", transformedContent: "t" })), { secrets: ["session-secret-value"] })
  assert.ok(!reduced.includes("session-secret-value"))
})

test("the session log is read from the profile: every session folder's events, oldest first, or null when there is none", () => {
  const home = mkdtempSync(path.join(os.tmpdir(), "gates-"))
  try {
    assert.equal(readCopilotSessionEvents(home), null)
    mkdirSync(path.join(home, "session-state", "empty"), { recursive: true })
    assert.equal(readCopilotSessionEvents(home), null)
    mkdirSync(path.join(home, "session-state", "a"), { recursive: true })
    writeFileSync(path.join(home, "session-state", "a", "events.jsonl"), "A\n")
    assert.equal(readCopilotSessionEvents(home), "A\n")
    const files = { [path.join(home, "session-state", "a", "events.jsonl")]: 2, [path.join(home, "session-state", "b", "events.jsonl")]: 1 }
    const text = readCopilotSessionEvents(home, { exists: () => true, list: () => ["a", "b"], read: (f) => path.basename(path.dirname(f)), mtime: (f) => files[f] })
    assert.equal(text, "b\na")
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

const hook = (hookEvent, output) => ({ type: "system", subtype: "hook_response", hook_event: hookEvent, output })
const user = (...content) => ({ type: "user", message: { content } })

test("Claude gates count Stop-hook feedback, Desk PreToolUse denials and SessionStart context", () => {
  const events = [
    { type: "system", subtype: "init" },
    hook("SessionStart", JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "foundation" } })),
    hook("SessionStart", "{}"),
    hook("Stop", "{}"),
    { type: "assistant", message: { content: [{ type: "text", text: "Stop hook feedback:\nnot from the user" }, { type: "tool_use", id: "a", name: "Bash", input: {} }] } },
    user({ type: "tool_result", tool_use_id: "a", is_error: true, content: "PreToolUse:Bash hook error: Commit only your own paths with git commit <paths>. Desk protects this checkout: /desk" }),
    user({ type: "tool_result", tool_use_id: "b", is_error: true, content: [{ type: "text", text: "PreToolUse:Edit hook error: card writes go through task_update" }] }),
    user({ type: "tool_result", tool_use_id: "c", is_error: true, content: "Permission to use Bash has been denied." }),
    user({ type: "tool_result", tool_use_id: "d", is_error: false, content: "PreToolUse:Bash hook error: quoted in a successful result" }),
    user({ type: "text", text: "Stop hook feedback:\nYour reply says the work is done" }),
    user({ type: "text", text: "an ordinary message" }),
    { type: "user", message: { content: "a bare string message" } },
    { type: "result" },
  ]
  assert.deepEqual(claudeGates(events), { events_saved: true, session_start: { fired: 2, injected: true, cancelled: 0, desk_delivered: false }, stop_hook_feedback: 1, pre_tool_use_denials: 2 })
  assert.deepEqual(claudeGates([]), { events_saved: true, session_start: { fired: 0, injected: false, cancelled: 0, desk_delivered: false }, stop_hook_feedback: 0, pre_tool_use_denials: 0 })
})

test("gateReport picks the host's counter and says so when a Copilot run has no log", () => {
  assert.deepEqual(gateReport({ host: "claude", claudeEvents: [] }), claudeGates([]))
  assert.deepEqual(gateReport({ host: "claude" }), claudeGates([]))
  assert.equal(gateReport({ host: "copilot", copilotEventsText: newSessionBeforeFix() }).agent_stop_blocks, 1)
  const missing = gateReport({ host: "copilot", copilotEventsText: null })
  assert.deepEqual(missing, copilotGatesUnavailable)
  assert.equal(missing.events_saved, false)
  assert.notEqual(missing, copilotGatesUnavailable)
})

test("Desk registers two userPromptSubmitted hooks: a prompt is the group of hook runs before its message, and either hook may carry the pointer", () => {
  const twoHooks = (n, pointerOnSecond) => [
    start(`g${n}`, "userPromptSubmitted", { prompt: "p" }),
    end(`g${n}`, "userPromptSubmitted", {}),
    start(`b${n}`, "userPromptSubmitted", { prompt: "p" }),
    end(`b${n}`, "userPromptSubmitted", pointerOnSecond ? { additionalContext: POINTER } : {}),
  ]
  // The pointer comes from the second hook of the first prompt: the first prompt was directed (the first hook's empty answer is not the prompt's).
  const first = log(...twoHooks(1, true), line("user.message", { content: "hi", transformedContent: `hi ${POINTER}` }), ...twoHooks(2, false), line("user.message", { content: "again", transformedContent: "again" }))
  assert.deepEqual(copilotGates(parseEventLines(first)).first_prompt_pointer, { prompts: 2, injected_on_first_prompt: true, reached_model: true, injected_count: 1 })
  // The pointer only on a later prompt is not credited to the first.
  const later = log(...twoHooks(1, false), line("user.message", { content: "hi", transformedContent: "hi" }), ...twoHooks(2, true), line("user.message", { content: "again", transformedContent: `again ${POINTER}` }))
  assert.deepEqual(copilotGates(parseEventLines(later)).first_prompt_pointer, { prompts: 2, injected_on_first_prompt: false, reached_model: false, injected_count: 1 })
})

test("the pointer is found in a message longer than the saved copy keeps, and a secret across a cut point is redacted before the cut", () => {
  const long = `${"x".repeat(70000)} ${POINTER}`
  const raw = log(
    start("p1", "userPromptSubmitted", {}),
    end("p1", "userPromptSubmitted", {}),
    line("user.message", { content: "hi", transformedContent: long }),
  )
  const reduced = reduceCopilotEvents(raw)
  const [message] = parseEventLines(reduced).filter((e) => e.type === "user.message")
  assert.equal(message.data.transformedContent.endsWith("...[cut]"), true)
  assert.equal(message.data.pointer_present, true)
  assert.equal(copilotGates(parseEventLines(reduced)).first_prompt_pointer.reached_model, true)
  // A token that starts just inside the cut would be saved as a truncated, no-longer-recognizable fragment if the cut came first.
  const straddling = log(line("user.message", { content: `${"a".repeat(1990)}${GH}`, transformedContent: "t" }))
  const saved = reduceCopilotEvents(straddling)
  assert.ok(!saved.includes(GH.slice(0, 12)), "no token fragment survives")
  assert.match(saved, /\[REDACTED/u)
})

test("--outside-desk is a harness flag and is off by default", () => {
  const out = path.join(os.tmpdir(), "gates-outside-desk-out")
  assert.equal(parseArgs(["--out-dir", out]).outsideDesk, false)
  assert.equal(parseArgs(["--out-dir", out, "--outside-desk"]).outsideDesk, true)
})

// The real events of round AA, `slow-or-failing-status` run 1: three SessionStart hooks, one cancelled with no output at all, and none of the two that answered is Desk's.
const hookEvent = (outcome, output) => ({ type: "system", subtype: "hook_response", hook_name: "SessionStart:startup", hook_event: "SessionStart", output, stdout: output, stderr: "", exit_code: outcome === "cancelled" ? 1 : 0, outcome })
const PLAIN = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"[PLAIN_LANGUAGE_CONTRACT]"}}'
const SUPERPOWERS = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<EXTREMELY_IMPORTANT>You have superpowers."}}'
const DESK = '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"---\\nname: using-desk\\n---"}}'

test("a cancelled SessionStart hook with Desk's context missing is counted (round AA events)", () => {
  assert.deepEqual(claudeGates([hookEvent("cancelled", ""), hookEvent("success", PLAIN), hookEvent("success", SUPERPOWERS)]).session_start, { fired: 3, injected: true, cancelled: 1, desk_delivered: false })
  assert.deepEqual(claudeGates([hookEvent("success", DESK), hookEvent("success", PLAIN), hookEvent("success", SUPERPOWERS)]).session_start, { fired: 3, injected: true, cancelled: 0, desk_delivered: true })
  assert.equal(claudeGates([hookEvent("success", "desk worker boot: could not read the foundation")]).session_start.desk_delivered, true)
  // Another plugin's hook being cancelled while Desk's answered does not discount anything.
  assert.deepEqual(claudeGates([hookEvent("cancelled", ""), hookEvent("success", DESK)]).session_start, { fired: 2, injected: true, cancelled: 1, desk_delivered: true })
})

test("discountCancelledStart sets aside only the boot-dependent failures, and only when Desk's hook did not deliver", () => {
  const lost = claudeGates([hookEvent("cancelled", ""), hookEvent("success", PLAIN), hookEvent("success", SUPERPOWERS)])
  const bootOnly = { outcome: "fail", notes: ["did not raise factory consent", "FAIL: never ran session-boot.js", "FAIL: did not tell the operator the desk could not sync with its remote"] }
  const discounted = discountCancelledStart(bootOnly, lost)
  assert.equal(discounted.outcome, "unknown")
  assert.equal(discounted.discounted, 2)
  assert.equal(discounted.notes.filter((note) => note.startsWith("DISCOUNTED: ")).length, 2)
  assert.ok(discounted.notes.some((note) => note.startsWith("DISCOUNTED: never ran session-boot.js (Desk's SessionStart hook was cancelled")))
  assert.equal(discounted.notes.some((note) => note.startsWith("FAIL: ")), false)
  // A real failure beside them keeps the run a failure, and the real failure is untouched.
  const mixed = discountCancelledStart({ outcome: "fail", notes: ["FAIL: never ran session-boot.js", "FAIL: wrote repo files for a clone that does not exist"] }, lost)
  assert.equal(mixed.outcome, "fail")
  assert.equal(mixed.discounted, 1)
  assert.ok(mixed.notes.includes("FAIL: wrote repo files for a clone that does not exist"))
  assert.match(discountCancelledStart({ outcome: "fail", notes: ["FAIL: did not tell the operator which account and route (for example a fork) would deliver to the task's repo"] }, lost).notes[0], /^DISCOUNTED: did not tell the operator which account/u)
  // Nothing boot-dependent to set aside, a pass, Desk's hook delivered, no cancelled hook, or no gates: unchanged.
  const real = { outcome: "fail", notes: ["FAIL: wrote repo files for a clone that does not exist"] }
  assert.equal(discountCancelledStart(real, lost), real)
  const passed = { outcome: "pass", notes: [] }
  assert.equal(discountCancelledStart(passed, lost), passed)
  assert.equal(discountCancelledStart(bootOnly, claudeGates([hookEvent("cancelled", ""), hookEvent("success", DESK)])), bootOnly)
  assert.equal(discountCancelledStart(bootOnly, claudeGates([])), bootOnly)
  assert.equal(discountCancelledStart(bootOnly, { events_saved: false }), bootOnly)
})
