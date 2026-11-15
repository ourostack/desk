// The session-history reader behind the stalled-card nudges: it reads hundreds of MB backwards, so the cases that matter are the line
// and chunk boundaries and a last line still being written. Every history lives under a temporary root.
import assert from "node:assert/strict"
import { writeFileSync } from "node:fs"
import path from "node:path"
import { test } from "node:test"
import { mkTempRoot } from "../_temp_roots.js"
import { copilotHome, endsWithFinalReport, findFocus, lastActivity, openWork, readWorkspaceFile, sessionStateDir } from "../../../../../plugins/desk/mcp/src/runtime/session-activity.js"

const T0 = Date.parse("2026-11-15T10:00:00Z")
let counter = 0
const event = (type, data, minutes, agentId) => JSON.stringify({ type, data, ...(agentId === undefined ? {} : { agentId }), id: `e${(counter += 1)}`, timestamp: new Date(T0 + minutes * 60_000).toISOString(), parentId: "p" })
const start = (id, toolName, args, minutes, agentId) => event("tool.execution_start", { toolCallId: id, toolName, arguments: args }, minutes, agentId)
const finish = (id, minutes, content = "ok", agentId) => event("tool.execution_complete", { toolCallId: id, success: true, result: { content } }, minutes, agentId)

async function history(lines, { tail = "" } = {}) {
  const file = path.join(await mkTempRoot("desk-activity-"), "events.jsonl")
  writeFileSync(file, `${lines.join("\n")}\n${tail}`)
  return file
}

test("the last meaningful event is the main agent's, whatever noise and subagent traffic follow it", async () => {
  const file = await history([
    event("assistant.turn_end", { turnId: "0" }, 5),
    event("hook.end", {}, 6),
    event("assistant.turn_start", { turnId: "9" }, 7, "agent-1"),
    event("session.usage_record", {}, 8),
    event("subagent.completed", { toolCallId: "s1" }, 9, "agent-1"),
  ], { tail: '{"type":"assistant.turn_start","data":{"turnId":"3"}' })
  assert.deepEqual(await lastActivity(file), { type: "subagent.completed", at: new Date(T0 + 9 * 60_000).toISOString(), ms: T0 + 9 * 60_000, ended: false, stoppedByPerson: false, closed: false })
  const quiet = await history([event("assistant.turn_end", {}, 5), event("hook.start", {}, 6), event("assistant.turn_start", {}, 7, "agent-1")])
  assert.equal((await lastActivity(quiet)).ended, true)
  const aborted = await history([event("abort", { reason: "user_initiated" }, 5), event("abort", { reason: "subagent_cancelled" }, 6, "agent-2")])
  assert.equal((await lastActivity(aborted)).stoppedByPerson, true)
  const idle = await history([event("hook.start", {}, 1), event("session.shutdown", {}, 2)])
  assert.equal((await lastActivity(idle)).closed, true)
  assert.equal(await lastActivity(await history([event("hook.start", {}, 1)])), null)
})

test("open work is what started after the last session boundary and never finished", async () => {
  const file = await history([
    event("session.resume", {}, 0),
    event("subagent.started", { toolCallId: "s-open" }, 1, "agent-open"),
    event("subagent.started", { toolCallId: "s-done" }, 1, "agent-done"),
    event("subagent.completed", { toolCallId: "s-done" }, 2, "agent-done"),
    event("subagent.started", { toolCallId: "s-failed" }, 1, "agent-failed"),
    event("subagent.failed", { toolCallId: "s-failed" }, 2, "agent-failed"),
    event("subagent.started", { toolCallId: "s-cancelled" }, 1, "agent-cancelled"),
    event("abort", { reason: "subagent_cancelled" }, 2, "agent-cancelled"),
    event("abort", { reason: "user_initiated" }, 2),
    start("b-open", "bash", { mode: "async" }, 3),
    finish("b-open", 3, "<command started in background with shellId: 10>"),
    start("b-slow", "bash", { mode: "sync" }, 3),
    finish("b-slow", 3, "<command with shellId: 11 is still running after 30 seconds. Use read_bash>"),
    start("b-done", "bash", {}, 3),
    finish("b-done", 3, "<command started in background with shellId: 12>"),
    event("system.notification", { kind: { type: "shell_completed", shellId: "12" } }, 4),
    start("b-stopped", "bash", {}, 3),
    finish("b-stopped", 3, "<command started in background with shellId: 13>"),
    start("stop-1", "stop_bash", { shellId: "13" }, 4),
    event("system.notification", { kind: { type: "other" } }, 4),
    start("b-sub", "bash", {}, 3, "agent-open"),
    finish("b-sub", 3, "<command started in background with shellId: 14>", "agent-open"),
    start("stop-sub", "stop_bash", { shellId: "10" }, 4, "agent-open"),
    start("q-open", "ask_user", { question: "?" }, 5),
    start("q-answered", "ask_user", { question: "?" }, 5),
    finish("q-answered", 6),
    start("p-open", "exit_plan_mode", {}, 5),
    start("plain", "view", {}, 5),
    event("permission.requested", { requestId: "r1", permissionRequest: { toolCallId: "perm-open" } }, 7),
    event("permission.requested", { requestId: "r2", permissionRequest: { toolCallId: "perm-done" } }, 7),
    event("permission.completed", { requestId: "r2", toolCallId: "perm-done" }, 8),
    event("assistant.turn_end", {}, 9),
  ])
  const work = await openWork(await history([event("subagent.started", { toolCallId: "before-resume" }, 0, "agent-old"), event("session.resume", {}, 1), event("assistant.turn_end", {}, 2)]))
  assert.deepEqual(work, { subagents: 0, shells: 0, waiting: [] })
  assert.deepEqual(await openWork(file), { subagents: 1, shells: 2, waiting: ["a permission prompt", "a plan waiting for approval", "a question for a person"] })
})

test("the last focus declaration counts, and the history is read across chunk boundaries and a partly written last line", async () => {
  const filler = event("assistant.message", { content: "x".repeat(900_000) }, 3)
  const file = await history([
    start("f0", "task_create", { track: "t", slug: "no-focus", title: "x" }, 0),
    start("f1", "desk-task_focus", { track: "tooling", slug: "ship-it" }, 1),
    finish("f1", 1),
    filler, filler, filler,
    start("f2", "task_focus", { track: "tooling", slug: "missing" }, 4),
    event("tool.execution_complete", { toolCallId: "f2", success: false }, 4),
    start("f3", "task_create", { track: "tooling", slug: "made", title: "y" }, 5),
    start("f4", "desk-task_focus", { track: "tooling", slug: "sub" }, 6, "agent-1"),
    start("other", "bash", { command: "task_focus" }, 6),
  ], { tail: '{"type":"tool.execution_start","data":{"toolCallId":"f5","toolName":"desk-task_focus","arguments":{"track":"tooling","slu' })
  const found = await findFocus(file)
  assert.deepEqual({ focus: found.focus, fresh: found.fresh }, { focus: { track: "tooling", slug: "ship-it" }, fresh: true })
  assert.deepEqual(await findFocus(file, { cached: found }), { focus: found.focus, size: found.size, fresh: false })
  const none = await history([start("f0", "task_create", { track: "t", slug: "s" }, 0)])
  const first = await findFocus(none)
  assert.deepEqual({ focus: first.focus, fresh: first.fresh }, { focus: null, fresh: false })
  writeFileSync(none, `${event("hook.end", {}, 2)}\n`, { flag: "a" })
  const next = await findFocus(none, { cached: first })
  assert.deepEqual({ focus: next.focus, fresh: next.fresh }, { focus: null, fresh: false })
})

test("a final report is the last message with text, and an unfinished line or empty message is skipped", async () => {
  const report = "Done.\n\nAsked: ship it.\nDelivered: PR merged.\nAccept or send back?"
  assert.equal(await endsWithFinalReport(await history([event("assistant.message", { content: report }, 1)])), true)
  assert.equal(await endsWithFinalReport(await history([event("assistant.message", { content: report }, 1), event("assistant.message", { content: "Working." }, 2)])), false)
  const skipped = await history([event("assistant.message", { content: report }, 1), event("assistant.message", { content: "Sub." }, 2, "agent-1"), event("assistant.message", { content: "  " }, 3), event("assistant.message", { toolRequests: [] }, 4)], { tail: '{"type":"assistant.message","data":{"content":"cut' })
  assert.equal(await endsWithFinalReport(skipped), true)
  assert.equal(await endsWithFinalReport(await history([event("hook.end", {}, 1)])), false)
})

test("the app's folders and a session's workspace file", async () => {
  assert.equal(copilotHome({ COPILOT_HOME: "/x/copilot" }), "/x/copilot")
  assert.match(copilotHome({}), /\.copilot$/u)
  assert.equal(sessionStateDir({ COPILOT_HOME: "/x/copilot" }), path.join("/x/copilot", "session-state"))
  const dir = await mkTempRoot("desk-workspace-")
  writeFileSync(path.join(dir, "workspace.yaml"), "id: 1\ncwd: /work/desk\ngit_root: /work\nname: Tooling lane\n")
  assert.deepEqual(readWorkspaceFile(path.join(dir, "workspace.yaml")), { cwd: "/work/desk", gitRoot: "/work", name: "Tooling lane" })
  writeFileSync(path.join(dir, "block.yaml"), "name: |-\n  a long prompt\n")
  assert.deepEqual(readWorkspaceFile(path.join(dir, "block.yaml")), { cwd: null, gitRoot: null, name: null })
  assert.deepEqual(readWorkspaceFile(path.join(dir, "missing.yaml")), { cwd: null, gitRoot: null, name: null })
})
