import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { checkDelivery } from "../../../../../plugins/desk/hooks/lib/delivery-stop.cjs"
import { scratch, ID, START, END } from "./_session_helpers.js"

const REF = "1234567890abcdef1234567890abcdef12345678"
const PACKET = ["Asked: Portable manifests", `Delivered: ${REF}`, "Accept or send back?"]
const RESULT = { status: "updated", signoff: "delivered_unsigned", signoff_packet: PACKET }
const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/factory-end.cjs", import.meta.url))
async function fixture(ctx, host, options = {}) {
  const log = host === "copilot" ? path.join(ctx.env.COPILOT_HOME, "session-state", ID, "events.jsonl")
    : path.join(ctx.base, ".claude/projects/test", `${ID}.jsonl`)
  const payload = host === "copilot"
    ? { sessionId: ID, cwd: ctx.desk, timestamp: Date.parse(END), transcriptPath: log, stopReason: "end_turn", stop_hook_active: false }
    : { session_id: ID, cwd: ctx.desk, transcript_path: log, hook_event_name: "Stop", stop_hook_active: false, last_assistant_message: options.reply ?? "Implementation passed." }
  const delivery = options.result ?? RESULT
  const args = { track: "portable-tools", slug: "integrity-manifests", status: "done", evidence: { kind: "commit", ref: REF } }
  const name = options.tool ?? (host === "copilot" ? "desk-task_update" : "mcp__desk__task_update")
  const reply = options.reply ?? "Implementation passed."
  const lines = host === "copilot" ? [
    { type: "session.start", timestamp: START, data: { sessionId: ID, context: { cwd: ctx.desk } } },
    { type: "user.message", timestamp: START, data: { content: "Go. I am stepping away.", interactionId: "human-1" } },
    { type: "tool.execution_start", timestamp: START, data: { toolCallId: "call-1", toolName: name, arguments: args } },
    { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "call-1", success: true, interactionId: "human-1", result: { content: JSON.stringify(delivery) } } },
    { id: "reply-1", type: "assistant.message", timestamp: END, data: { content: reply, interactionId: "human-1", turnId: "final", toolRequests: [] } },
    { id: "end-1", parentId: "reply-1", type: "assistant.turn_end", timestamp: END, data: { turnId: "final" } },
    { type: "hook.start", timestamp: END, parentId: "end-1", data: { hookInvocationId: "stop-1", hookType: "agentStop", input: payload } },
  ] : [
    { type: "user", sessionId: ID, cwd: ctx.desk, timestamp: START, origin: { kind: "human" }, message: { role: "user", content: "Go. I am stepping away." } },
    { type: "assistant", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_use", id: "call-1", name, input: args }] } },
    { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "call-1", content: JSON.stringify(delivery) }] } },
    { type: "assistant", sessionId: ID, timestamp: END, message: { stop_reason: "end_turn", content: [{ type: "text", text: reply }] } },
  ]
  if (options.edit) options.edit(lines, payload)
  await fs.mkdir(path.dirname(log), { recursive: true })
  await fs.writeFile(log, lines.map(x => JSON.stringify(x)).join("\n") + "\n")
  return { host, payload, env: ctx.env, log, lines }
}
async function check(f) {
  assert.equal(typeof checkDelivery, "function", "the existing stop wrapper's bounded delivery helper must exist")
  return checkDelivery(f)
}
for (const host of ["copilot", "claude"]) {
  test(`${host}: missing evidenced delivery, including away, requests only final-reply correction`, () => scratch(async ctx => {
    const result = await check(await fixture(ctx, host))
    assert.equal(result.status, "correction")
    assert.equal(result.output.decision, "block")
    for (const line of PACKET) assert.ok(result.output.reason.includes(line))
    assert.match(result.output.reason, /Do not rerun[\s\S]+task[\s\S]+commit[\s\S]+approval/u)
  }))
  for (const reply of [PACKET.join("\n"), `Proof verified.\n\n**Asked:** Portable manifests\n\n**Delivered:** \`${REF.slice(0, 8)}\` — 79 tests\n\n**Accept or send back?**`, `__Asked:__ Portable manifests\n\n__Delivered:__ ${REF}\n\n__Accept or send back?__`]) {
    test(`${host}: already complete formatting is not blocked (${reply.startsWith("__") ? "underscore" : reply.startsWith("Proof") ? "bold/blank" : "plain"})`, () => scratch(async ctx => {
      assert.equal((await check(await fixture(ctx, host, { reply }))).status, "complete")
    }))
  }
  test(`${host}: wrong proof or trailing offer is not a complete ending`, () => scratch(async ctx => {
    for (const reply of [PACKET.join("\n").replace(REF, "ffffffff"), PACKET.join("\n") + "\nMore work available."]) {
      assert.equal((await check(await fixture(ctx, host, { reply }))).status, "correction")
    }
  }))
  test(`${host}: archive replay preserves only existing unsigned evidenced packet`, () => scratch(async ctx => {
    const tool = host === "copilot" ? "desk-task_archive" : "mcp__desk__task_archive"
    assert.equal((await check(await fixture(ctx, host, { tool, result: { ...RESULT, status: "archived" } }))).status, "correction")
    for (const result of [{ status: "updated" }, { ...RESULT, signoff: "accepted" }, { ...RESULT, signoff_packet: ["Asked: x", "Delivered: ", "Accept or send back?"] }]) {
      assert.equal((await check(await fixture(ctx, host, { tool, result }))).status, "not_delivery")
    }
  }))
  test(`${host}: guard-active is one correction, never another block`, () => scratch(async ctx => {
    const f = await fixture(ctx, host)
    f.payload.stop_hook_active = true
    const result = await check(f)
    assert.equal(result.status, "unverified")
    assert.equal(result.output, undefined)
  }))
  test(`${host}: child, error, abort, session end and headless never block`, () => scratch(async ctx => {
    for (const change of [
      f => { f.payload.agentId = "child"; f.payload.agent_id = "child" },
      f => { f.payload.stopReason = "abort"; f.payload.stop_reason = "abort" },
      f => { f.payload.error = "rate_limit" },
      f => { f.payload.reason = "user_exit"; f.payload.hook_event_name = "SessionEnd"; delete f.payload.stopReason },
      f => { f.env = { ...f.env, DESK_FACTORY_HEADLESS: "1" } },
    ]) {
      const f = await fixture(ctx, host); change(f)
      assert.equal((await check(f)).output, undefined)
    }
  }))
  test(`${host}: ordinary progress and a packet quoted by another tool never block`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { tool: "bash" })
    assert.equal((await check(f)).status, "not_delivery")
  }))
  test(`${host}: prior human turn packet is not current progress`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { edit(lines) {
      if (host === "copilot") lines.splice(4, 0, { type: "user.message", timestamp: END, data: { content: "Show progress.", interactionId: "human-2" } })
      else lines.splice(3, 0, { type: "user", sessionId: ID, timestamp: END, origin: { kind: "human" }, message: { content: "Show progress." } })
    } })
    assert.equal((await check(f)).status, "not_delivery")
  }))
  test(`${host}: already delivered earlier assistant reply is not raised on replay`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { edit(lines) {
      if (host === "copilot") lines.splice(4, 0, { type: "assistant.message", timestamp: END, data: { interactionId: "human-1", content: PACKET.join("\n"), toolRequests: [] } })
      else lines.splice(3, 0, { type: "assistant", sessionId: ID, timestamp: END, message: { stop_reason: "end_turn", content: [{ type: "text", text: PACKET.join("\n") }] } })
    } })
    assert.equal((await check(f)).status, "complete")
  }))
  test(`${host}: unavailable and foreign transcript do not masquerade as verification`, () => scratch(async ctx => {
    const f = await fixture(ctx, host)
    const missing = path.join(path.dirname(f.log), "missing.jsonl")
    f.payload.transcriptPath = missing; f.payload.transcript_path = missing
    assert.equal((await check(f)).status, "unavailable")
  }))
}
test("Copilot: sidekick and child calls cannot supply a root delivery", () => scratch(async ctx => {
  for (const mark of [e => { e.agentId = "child" }, e => { e.data.parentToolCallId = "sidekick-memory" }]) {
    const f = await fixture(ctx, "copilot", { edit(lines) { mark(lines[2]); mark(lines[3]) } })
    assert.equal((await check(f)).status, "not_delivery")
  }
}))
test("Copilot: prior block event self-limits even if native active flag is false", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) {
    lines.splice(4, 0, { type: "hook.end", timestamp: END, data: { hookType: "agentStop", output: { decision: "block", reason: "[DESK_DELIVERY_CORRECTION] prior correction" } } })
  } })
  assert.equal((await check(f)).status, "unverified")
}))
test("Copilot: actual primary parentAgentTaskId is not a subagent classification", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) { lines[1].data.parentAgentTaskId = "host-primary-task" } })
  assert.equal((await check(f)).status, "correction")
}))
test("Copilot: timestamps cannot borrow a later delivery for an earlier hook", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) { lines[3].timestamp = "2026-09-26T08:02:00.000Z" } })
  assert.equal((await check(f)).status, "not_delivery")
}))
test("Copilot: an unrelated sidekick stop cannot correct a primary final", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) { lines[6].parentId = "sidekick-end" } })
  assert.equal((await check(f)).status, "not_delivery")
}))
test("Copilot: real failure after delivery does not force a reply correction", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) {
    lines.splice(4, 0, { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "cleanup", interactionId: "human-1", success: false } })
  } })
  assert.equal((await check(f)).output, undefined)
}))
test("Copilot: a successful native blocked transition suppresses acceptance correction", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) {
    lines.splice(4, 0,
      { type: "tool.execution_start", timestamp: END, data: { toolCallId: "blocked", toolName: "desk-task_update", arguments: { track: "portable-tools", slug: "another-outcome", status: "blocked" } } },
      { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "blocked", interactionId: "human-1", success: true, result: { content: '{"status":"updated"}' } } })
  } })
  assert.equal((await check(f)).output, undefined)
}))
test("Copilot: continuation changes interaction but never permits a second block", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) {
    lines.splice(4, 0, { type: "user.message", timestamp: END, data: { source: "hook", content: "[DESK_DELIVERY_CORRECTION] correct reply", interactionId: "continuation" } })
    lines[5].data.interactionId = "continuation"
  } })
  assert.equal((await check(f)).status, "unverified")
}))
test("Claude: native text/image human prompts establish and reset the human boundary", () => scratch(async ctx => {
  const form = [{ type: "image", source: { type: "base64", data: "fixture-only" } }, { type: "text", text: "Go." }]
  const first = await fixture(ctx, "claude", { edit(lines) { lines[0].message.content = form } })
  assert.equal((await check(first)).status, "correction")
  const next = await fixture(ctx, "claude", { edit(lines) {
    lines.splice(3, 0, { type: "user", sessionId: ID, timestamp: END, origin: { kind: "human" }, message: { content: form } })
  } })
  assert.equal((await check(next)).status, "not_delivery")
}))
test("Copilot: newer non-unsigned native observation cannot borrow prior unsigned proof", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) {
    lines.splice(4, 0,
      { type: "tool.execution_start", timestamp: END, data: { toolCallId: "newer", toolName: "desk-task_archive", arguments: { track: "portable-tools", slug: "integrity-manifests" } } },
      { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "newer", interactionId: "human-1", success: true, result: { content: '{"status":"archived"}' } } })
  } })
  assert.equal((await check(f)).output, undefined)
}))
test("Copilot: MCP error is a real error even if its transport succeeded", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) {
    lines.splice(4, 0, { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "cleanup", interactionId: "human-1", success: true, result: { isError: true, content: "denied" } } })
  } })
  assert.equal((await check(f)).output, undefined)
}))
test("Claude: system/meta/compact/scheduled/headless prompt origins never establish a human turn", () => scratch(async ctx => {
  for (const fields of [
    { origin: { kind: "system" } }, { promptSource: "system" }, { promptSource: "sdk" },
    { isMeta: true }, { isCompactSummary: true }, { scheduledTaskId: "tick" }, { turnOrigin: "scheduled" },
  ]) {
    const f = await fixture(ctx, "claude", { edit(lines) { Object.assign(lines[0], fields) } })
    assert.equal((await check(f)).output, undefined)
  }
}))
test("guard diagnostics distinguish malformed/missing/foreign transcripts without blocking", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot")
  await fs.appendFile(f.log, "{broken\n")
  assert.equal((await check(f)).status, "unavailable")
  assert.equal((await check(f)).output, undefined)
  const fresh = await fixture(ctx, "copilot")
  fresh.payload.cwd = path.join(ctx.desk, "foreign")
  assert.equal((await check(fresh)).status, "unavailable")
  const missing = await fixture(ctx, "copilot")
  await fs.rename(missing.log, missing.log + ".preserved")
  assert.equal((await check(missing)).status, "unavailable")
}))
test("Claude: Stop payload's current final, not a lagging transcript reply, is checked", () => scratch(async ctx => {
  const f = await fixture(ctx, "claude")
  f.payload.last_assistant_message = PACKET.join("\n")
  assert.equal((await check(f)).status, "complete")
}))
for (const host of ["copilot", "claude"]) {
  test(`${host}: archive cannot erase another task's recorded blocker`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { edit(lines) {
      if (host === "copilot") lines.splice(4, 0,
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "blocked", toolName: "desk-task_update", arguments: { track: "portable-tools", slug: "another-outcome", status: "blocked" } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "blocked", interactionId: "human-1", success: true, result: { content: '{"status":"updated"}' } } },
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "archive", toolName: "desk-task_archive", arguments: { track: "portable-tools", slug: "integrity-manifests" } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "archive", interactionId: "human-1", success: true, result: { content: JSON.stringify(RESULT) } } })
      else lines.splice(3, 0,
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "blocked", name: "mcp__desk__task_update", input: { track: "portable-tools", slug: "another-outcome", status: "blocked" } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "blocked", content: '{"status":"updated"}' }] } },
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "archive", name: "mcp__desk__task_archive", input: { track: "portable-tools", slug: "integrity-manifests" } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "archive", content: JSON.stringify(RESULT) }] } })
    } })
    assert.equal((await check(f)).output, undefined)
  }))
}
test("existing hook command relays one decision while retaining the accounting marker", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot")
  const r = spawnSync(process.execPath, [SCRIPT, "copilot"], { env: ctx.env, input: JSON.stringify(f.payload), encoding: "utf8", timeout: 6000 })
  assert.equal(r.status, 0)
  assert.equal(JSON.parse(r.stdout).decision, "block")
  const { listMarkers } = await import("../../../../../plugins/desk/mcp/src/factory/outbox.js")
  const markers = await listMarkers(ctx.env)
  assert.equal(markers.length, 1)
  assert.ok(!JSON.stringify(markers).includes(PACKET[0]))
}))
