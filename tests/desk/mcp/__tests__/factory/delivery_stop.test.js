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
  const args = options.args ?? { track: "portable-tools", slug: "integrity-manifests", status: "done", evidence: { kind: "commit", ref: REF } }
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
const INTAKE_PARTS = { outcome: "Inspect fixture bytes.", assumptions: "Read-only Python with no followed links.", recommended_decisions: "Sorted table and grand total; all choices settled.", completion_checks: "Runnable CLI, documentation, nested empty link and error tests." }
const INTAKE_ARGS = { track: "portable-tools", slug: "integrity-manifests", focus: true, intake_proposal: INTAKE_PARTS }
const INTAKE_RESULT = { status: "created", work_context: { status: "drafting", planning_complete: false }, alignment_packet: { kind: "intake_proposal", boundary: "awaiting_intake", authority: "unknown", task: "portable-tools/integrity-manifests", parts: INTAKE_PARTS } }
for (const host of ["copilot", "claude"]) {
  const tool = host === "copilot" ? "desk-task_create" : "mcp__desk__task_create"
  test(`${host}: exact proposal correction presents actual contents without inventing approval`, () => scratch(async ctx => {
    const result = await check(await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT }))
    assert.equal(result.status, "correction")
    for (const value of Object.values(INTAKE_PARTS)) assert.ok(result.output.reason.includes(value))
    assert.match(result.output.reason, /No tools, new questions, approval waits/iu)
    assert.doesNotMatch(result.output.reason, /wait for go|say go|no go exists|not approved/iu)
  }))
  test(`${host}: proposal headings alone fail, actual proportional contents pass`, () => scratch(async ctx => {
    for (const reply of ["Outcome\nAssumptions\nRecommended decisions\nCompletion checks", Object.values(INTAKE_PARTS).slice(0, 3).join("\n")]) {
      assert.equal((await check(await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, reply }))).status, "correction")
    }
    assert.equal((await check(await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, reply: Object.values(INTAKE_PARTS).map(x => `**${x}**`).join("\n\n") }))).status, "complete")
  }))
  test(`${host}: active correction exhausts the same intake and delivery budget`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT })
    f.payload.stop_hook_active = true
    assert.equal((await check(f)).diagnostic, "correction_exhausted")
  }))
  test(`${host}: missing proposal instrumentation is unavailable, never a correspondence pass`, () => scratch(async ctx => {
    const result = await check(await fixture(ctx, host, { tool, args: { ...INTAKE_ARGS, intake_proposal: undefined }, result: { status: "created", work_context: INTAKE_RESULT.work_context, alignment_packet_unavailable: "proposal_not_supplied" } }))
    assert.deepEqual(result, { status: "unavailable", diagnostic: "intake_packet_unavailable" })
  }))
  test(`${host}: an intake correction cannot buy a subsequent delivery correction in this turn`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, edit(lines) {
      if (host === "copilot") lines.splice(4, 0,
        { type: "hook.end", timestamp: END, data: { hookType: "agentStop", output: { decision: "block", reason: "[DESK_DELIVERY_CORRECTION] present actual proposal only" } } },
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "delivered", toolName: "desk-task_update", arguments: { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug, status: "done" } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "delivered", success: true, interactionId: "human-1", result: { content: JSON.stringify(RESULT) } } })
      else lines.splice(3, 0,
        { type: "system", sessionId: ID, timestamp: END, subtype: "stop_hook_error", content: "[DESK_DELIVERY_CORRECTION] present actual proposal only" },
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "delivered", name: "mcp__desk__task_update", input: { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug, status: "done" } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "delivered", content: JSON.stringify(RESULT) }] } })
    } })
    assert.deepEqual(await check(f), { status: "unverified", diagnostic: "correction_exhausted" })
  }))
  for (const observation of ["new processing", "new unavailable", "existing processing", "existing progress"]) {
    test(`${host}: focused ${observation} observation invalidates old intake`, () => scratch(async ctx => {
      const f = await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, edit(lines) {
        const create = observation.startsWith("new")
        const args = create ? { track: "other-tools", slug: "authorized-scope", focus: true, ...(observation === "new processing" ? { status: "processing" } : {}) } : { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug }
        const result = create ? { status: "created", work_context: { status: observation === "new processing" ? "processing" : "drafting", planning_complete: false }, ...(observation === "new unavailable" ? { alignment_packet_unavailable: "proposal_not_supplied" } : {}) } : { status: "focused", ...args, task_status: observation === "existing processing" ? "processing" : "drafting", recent_progress: observation === "existing progress" ? ["Implementation is in progress."] : [] }
        if (host === "copilot") lines.splice(4, 0,
          { type: "tool.execution_start", timestamp: END, data: { toolCallId: "context", toolName: create ? "desk-task_create" : "desk-task_focus", arguments: args } },
          { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "context", success: true, interactionId: "human-1", result: { content: JSON.stringify(result) } } })
        else lines.splice(3, 0,
          { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "context", name: create ? "mcp__desk__task_create" : "mcp__desk__task_focus", input: args }] } },
          { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "context", content: JSON.stringify(result) }] } })
      } })
      assert.equal((await check(f)).status, observation === "new unavailable" ? "unavailable" : "not_delivery")
    }))
  }
  test(`${host}: ordinary italic emphasis preserves actual intake contents`, () => scratch(async ctx => {
    for (const marker of ["*", "_"]) {
      const reply = Object.values(INTAKE_PARTS).join("\n").replace("Read-only Python", `Read-only ${marker}Python${marker}`)
      assert.equal((await check(await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, reply }))).status, "complete")
    }
  }))
  for (const identifier of ["__init__", "__main__", "_literal_", "a  b"]) {
    test(`${host}: code-span ${identifier} content cannot be normalized into different bytes`, () => scratch(async ctx => {
      const parts = { ...INTAKE_PARTS, outcome: `Implement Python \`${identifier}\` exactly; this content is functional.` }
      const args = { ...INTAKE_ARGS, intake_proposal: parts }
      const result = { ...INTAKE_RESULT, alignment_packet: { ...INTAKE_RESULT.alignment_packet, parts } }
      const exact = Object.values(parts).join("\n")
      assert.equal((await check(await fixture(ctx, host, { tool, args, result, reply: exact }))).status, "complete")
      const changed = exact.replace(`\`${identifier}\``, `\`${identifier === "a  b" ? "a b" : identifier.replaceAll("_", "")}\``)
      assert.equal((await check(await fixture(ctx, host, { tool, args, result, reply: changed }))).status, "correction")
    }))
  }
  test(`${host}: ordinary emphasis spanning literal code is presentation only`, () => scratch(async ctx => {
    const parts = { ...INTAKE_PARTS, outcome: "Implement Python `__init__` exactly; this identifier is functional." }
    const args = { ...INTAKE_ARGS, intake_proposal: parts }
    const result = { ...INTAKE_RESULT, alignment_packet: { ...INTAKE_RESULT.alignment_packet, parts } }
    const exact = Object.values(parts).join("\n")
    for (const marker of ["**", "*", "__", "_"]) {
      assert.equal((await check(await fixture(ctx, host, {
        tool, args, result, reply: exact.replace("Python `__init__`", `${marker}Python \`__init__\`${marker}`),
      }))).status, "complete")
    }
    assert.equal((await check(await fixture(ctx, host, {
      tool, args, result, reply: exact.replace("`__init__`", "\0c0\0"),
    }))).status, "correction", "literal human text cannot impersonate a code-normalization token")
  }))
  for (const packet of ["intake", "delivery"]) for (const operation of ["bash", "save", "lifecycle", "unpaired"]) {
    test(`${host}: unresolved ${operation} before ${packet} receipt still suppresses continuation`, () => scratch(async ctx => {
      const name = operation === "save" ? (host === "copilot" ? "desk-desk_save" : "mcp__desk__desk_save")
        : operation === "lifecycle" ? (host === "copilot" ? "desk-task_update" : "mcp__desk__task_update") : "bash"
      const f = await fixture(ctx, host, {
        ...(packet === "intake" ? { tool, args: INTAKE_ARGS, result: INTAKE_RESULT } : {}),
        edit(lines) {
          const args = operation === "lifecycle" ? { track: "portable-tools", slug: "other-work", status: "processing" } : {}
          if (host === "copilot") lines.splice(2, 0,
            ...(operation === "unpaired" ? [] : [{ type: "tool.execution_start", timestamp: START, data: { toolCallId: "failed", toolName: name, arguments: args } }]),
            { type: "tool.execution_complete", timestamp: START, data: { toolCallId: "failed", interactionId: "human-1", success: false } })
          else lines.splice(1, 0,
            ...(operation === "unpaired" ? [] : [{ type: "assistant", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_use", id: "failed", name, input: args }] } }]),
            { type: "user", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_result", tool_use_id: "failed", is_error: true, content: "Operation failed." }] } })
        },
      })
      assert.equal((await check(f)).status, "not_delivery")
    }))
  }
  for (const operation of ["read", "committed save"]) {
    test(`${host}: qualified ${operation} before the receipt does not invent an unresolved error`, () => scratch(async ctx => {
      const name = operation === "read" ? (host === "copilot" ? "view" : "Read")
        : (host === "copilot" ? "desk-desk_save" : "mcp__desk__desk_save")
      const f = await fixture(ctx, host, { edit(lines) {
        if (host === "copilot") lines.splice(2, 0,
          { type: "tool.execution_start", timestamp: START, data: { toolCallId: "before", toolName: name, arguments: {} } },
          { type: "tool.execution_complete", timestamp: START, data: { toolCallId: "before", interactionId: "human-1", success: false } },
          ...(operation === "read" ? [] : [
            { type: "tool.execution_start", timestamp: START, data: { toolCallId: "recovered", toolName: name, arguments: {} } },
            { type: "tool.execution_complete", timestamp: START, data: { toolCallId: "recovered", interactionId: "human-1", success: true, result: { content: '{"status":"committed"}' } } },
          ]))
        else lines.splice(1, 0,
          { type: "assistant", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_use", id: "before", name, input: {} }] } },
          { type: "user", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_result", tool_use_id: "before", is_error: true, content: "Operation failed." }] } },
          ...(operation === "read" ? [] : [
            { type: "assistant", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_use", id: "recovered", name, input: {} }] } },
            { type: "user", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_result", tool_use_id: "recovered", content: '{"status":"committed"}' }] } },
          ]))
      } })
      assert.equal((await check(f)).status, "correction")
    }))
  }
  test(`${host}: reading the same empty-progress draft does not erase its current proposal`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, edit(lines) {
      const args = { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug }
      const result = { status: "focused", ...args, task_status: "drafting", recent_progress: [] }
      if (host === "copilot") lines.splice(4, 0,
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "read", toolName: "desk-task_focus", arguments: args } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "read", success: true, interactionId: "human-1", result: { content: JSON.stringify(result) } } })
      else lines.splice(3, 0,
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "read", name: "mcp__desk__task_focus", input: args }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "read", content: JSON.stringify(result) }] } })
    } })
    assert.equal((await check(f)).status, "correction")
  }))
  for (const context of ["processing", "planning complete", "parked", "foreign", "missing part", "claimed approval"]) {
    test(`${host}: intake excludes ${context} before correction is enabled`, () => scratch(async ctx => {
      const args = { ...INTAKE_ARGS }
      const result = structuredClone(INTAKE_RESULT)
      if (context === "processing") args.status = "processing"
      if (context === "planning complete") args.planning_complete = true
      if (context === "parked") args.focus = false
      if (context === "foreign") result.alignment_packet.task = "other/task"
      if (context === "missing part") delete result.alignment_packet.parts.completion_checks
      if (context === "claimed approval") result.alignment_packet.authority = "unapproved"
      assert.equal((await check(await fixture(ctx, host, { tool, args, result }))).status, "not_delivery")
    }))
  }
  test(`${host}: prior recorded execution overrides a current drafting proposal without reading Go prose`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, edit(lines) {
      if (host === "copilot") lines.splice(2, 0,
        { type: "tool.execution_start", timestamp: START, data: { toolCallId: "authority", toolName: "desk-task_update", arguments: { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug, frontmatter: { planning_complete: true } } } },
        { type: "tool.execution_complete", timestamp: START, data: { toolCallId: "authority", interactionId: "human-1", success: true, result: { content: '{"status":"updated"}' } } },
        { type: "user.message", timestamp: START, data: { content: "Resume this authorized task.", interactionId: "human-1" } })
      else lines.splice(1, 0,
        { type: "assistant", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_use", id: "authority", name: "mcp__desk__task_update", input: { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug, frontmatter: { planning_complete: true } } }] } },
        { type: "user", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_result", tool_use_id: "authority", content: '{"status":"updated"}' }] } },
        { type: "user", sessionId: ID, timestamp: START, origin: { kind: "human" }, message: { content: "Resume this authorized task." } })
    } })
    assert.equal((await check(f)).status, "not_delivery")
  }))
  for (const boundary of ["prior turn", "progress", "child", "error", "prior correction"]) {
    test(`${host}: intake boundary ${boundary} cannot start a fresh approval/correction loop`, () => scratch(async ctx => {
      const f = await fixture(ctx, host, { tool, args: INTAKE_ARGS, result: INTAKE_RESULT, edit(lines) {
        if (host === "copilot") {
          if (boundary === "child") lines[3].data.agentId = "child"
          else if (boundary === "error") lines.splice(4, 0, { type: "session.error", timestamp: END, data: {} })
          else if (boundary === "prior turn") lines.splice(4, 0, { type: "user.message", timestamp: END, data: { content: "A new turn.", interactionId: "human-1" } })
          else if (boundary === "prior correction") lines.splice(4, 0, { type: "hook.end", timestamp: END, data: { hookType: "agentStop", output: { decision: "block", reason: "[DESK_DELIVERY_CORRECTION]" } } })
          else lines.splice(4, 0,
            { type: "tool.execution_start", timestamp: END, data: { toolCallId: "progress", toolName: "desk-task_update", arguments: { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug, status: "processing" } } },
            { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "progress", success: true, interactionId: "human-1", result: { content: JSON.stringify(boundary === "progress" ? RESULT : {}) } } })
        } else {
          if (boundary === "child") lines[2].isSidechain = true
          else if (boundary === "error") lines.splice(3, 0, { type: "system", sessionId: ID, timestamp: END, subtype: "api_error" })
          else if (boundary === "prior turn") lines.splice(3, 0, { type: "user", sessionId: ID, timestamp: END, origin: { kind: "human" }, message: { content: "A new turn." } })
          else if (boundary === "prior correction") lines.splice(3, 0, { type: "system", sessionId: ID, timestamp: END, subtype: "stop_hook_error", content: "[DESK_DELIVERY_CORRECTION]" })
          else lines.splice(3, 0,
            { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "progress", name: "mcp__desk__task_update", input: { track: INTAKE_ARGS.track, slug: INTAKE_ARGS.slug, status: "processing" } }] } },
            { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "progress", content: "{}" }] } })
        }
      } })
      assert.equal((await check(f)).status, boundary === "prior correction" ? "unverified" : "not_delivery")
    }))
  }
}
for (const replay of [false, true]) {
  test(`Copilot: primary memory rollover retains current human delivery (${replay ? "archive replay" : "done only"})`, () => scratch(async ctx => {
    const f = await fixture(ctx, "copilot", { reply: PACKET.join("\n").replace("back?", "back."), edit(lines) {
      lines[4].data.interactionId = "rollover"
      lines.splice(4, 0,
        { type: "session.context_cleared", timestamp: END, data: {} },
        { type: "user.message", timestamp: END, data: { source: "session-memory-rollover", parentAgentTaskId: "primary-task", interactionId: "rollover", content: "Continue the current approved task." } },
        ...(replay ? [
          { type: "tool.execution_start", timestamp: END, data: { toolCallId: "archive", toolName: "desk-task_archive", arguments: { track: "portable-tools", slug: "integrity-manifests" } } },
          { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "archive", success: true, interactionId: "rollover", result: { content: JSON.stringify(RESULT) } } },
        ] : []))
    } })
    assert.equal((await check(f)).status, "correction")
  }))
}
for (const held of ["corrected", "blocked", "old quoted marker", "new human", "unarmed"]) {
  test(`Copilot: memory rollover preserves boundaries (${held})`, () => scratch(async ctx => {
    const f = await fixture(ctx, "copilot", { edit(lines) {
      lines[4].data.interactionId = "rollover"
      const before = held === "corrected"
        ? [{ type: "hook.end", timestamp: END, data: { hookType: "agentStop", output: { decision: "block", reason: "[DESK_DELIVERY_CORRECTION] current correction" } } }]
        : held === "blocked" ? [
          { type: "tool.execution_start", timestamp: END, data: { toolCallId: "blocked", toolName: "desk-task_update", arguments: { track: "other", slug: "blocked", status: "blocked" } } },
          { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "blocked", success: true, interactionId: "human-1", result: { content: '{"status":"updated"}' } } },
        ] : held === "new human"
          ? [{ type: "user.message", timestamp: END, data: { content: "A different outcome.", interactionId: "new-human" } }] : []
      lines.splice(4, 0, ...before,
        ...(held === "unarmed" ? [] : [{ type: "session.context_cleared", timestamp: END, data: {} }]),
        { type: "user.message", timestamp: END, data: { source: "session-memory-rollover", interactionId: "rollover", content: held === "old quoted marker" ? "An older turn had [DESK_DELIVERY_CORRECTION]; retain current delivery." : "Continue." } })
    } })
    const result = await check(f)
    assert.equal(result.status, held === "corrected" ? "unverified" : held === "old quoted marker" ? "correction" : "not_delivery")
    if (held === "corrected") assert.equal(result.diagnostic, "correction_exhausted")
  }))
}
for (const host of ["copilot", "claude"]) {
  for (const name of ["bash", "desk-desk_save"]) {
    test(`${host}: unresolved ${name} failure remains an error exclusion`, () => scratch(async ctx => {
      const f = await fixture(ctx, host, { edit(lines) {
        if (host === "copilot") lines.splice(4, 0,
          { type: "tool.execution_start", timestamp: END, data: { toolCallId: "unresolved", toolName: name, arguments: {} } },
          { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "unresolved", success: false, interactionId: "human-1", result: { content: "failed" } } })
        else lines.splice(3, 0,
          { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "unresolved", name, input: {} }] } },
          { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "unresolved", is_error: true, content: "failed" }] } })
      } })
      assert.equal((await check(f)).status, "not_delivery")
    }))
  }
  test(`${host}: a non-lifecycle read or recovered housekeeping error cannot erase delivered proof`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { edit(lines) {
      if (host === "copilot") lines.splice(4, 0,
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "read", toolName: "view", arguments: { path: "/missing/optional-note" } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "read", success: false, interactionId: "human-1", result: { content: "Not found." } } },
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "save", toolName: "desk-desk_save", arguments: { paths: ["card.md"] } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "save", success: false, interactionId: "human-1", result: { content: "Invalid path; nothing changed." } } },
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "recovered", toolName: "desk-desk_save", arguments: { paths: ["archive/card.md"] } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "recovered", success: true, interactionId: "human-1", result: { content: '{"status":"committed"}' } } })
      else lines.splice(3, 0,
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "read", name: "Read", input: { path: "/missing/optional-note" } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "read", is_error: true, content: "Not found." }] } },
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "save", name: "mcp__desk__desk_save", input: { paths: ["card.md"] } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "save", is_error: true, content: "Invalid path; nothing changed." }] } },
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "recovered", name: "mcp__desk__desk_save", input: { paths: ["archive/card.md"] } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "recovered", content: '{"status":"committed"}' }] } })
    } })
    assert.equal((await check(f)).status, "correction")
  }))
  test(`${host}: native refusal permits a genuine re-delivery with identical evidence`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { edit(lines) {
      const target = { track: "portable-tools", slug: "integrity-manifests" }
      if (host === "copilot") lines.splice(4, 0,
        { type: "assistant.message", timestamp: END, data: { interactionId: "human-1", content: PACKET.join("\n"), toolRequests: [] } },
        { type: "user.message", timestamp: END, data: { content: "Send it back and correct the delivery.", interactionId: "human-2" } },
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "refused", toolName: "desk-task_signoff", arguments: { ...target, outcome: "refused" } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "refused", interactionId: "human-2", success: true, result: { content: '{"status":"recorded","signoff":{"state":"refused"}}' } } },
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "redelivered", toolName: "desk-task_update", arguments: { ...target, status: "done" } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "redelivered", interactionId: "human-2", success: true, result: { content: JSON.stringify(RESULT) } } })
      else lines.splice(3, 0,
        { type: "assistant", sessionId: ID, timestamp: END, message: { stop_reason: "end_turn", content: [{ type: "text", text: PACKET.join("\n") }] } },
        { type: "user", sessionId: ID, timestamp: END, origin: { kind: "human" }, message: { content: "Send it back and correct the delivery." } },
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "refused", name: "mcp__desk__task_signoff", input: { ...target, outcome: "refused" } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "refused", content: '{"status":"recorded","signoff":{"state":"refused"}}' }] } },
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "redelivered", name: "mcp__desk__task_update", input: { ...target, status: "done" } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "redelivered", content: JSON.stringify(RESULT) }] } })
      if (host === "copilot") lines[10].data.interactionId = "human-2"
    } })
    assert.equal((await check(f)).status, "correction")
  }))
}
for (const host of ["copilot", "claude"]) {
  test(`${host}: a previous human turn's already-sent packet is not raised by current archive replay`, () => scratch(async ctx => {
    const f = await fixture(ctx, host, { edit(lines) {
      if (host === "copilot") lines.splice(4, 0,
        { type: "assistant.message", timestamp: END, data: { interactionId: "human-1", content: PACKET.join("\n"), toolRequests: [] } },
        { type: "user.message", timestamp: END, data: { content: "Archive the old task.", interactionId: "human-2" } },
        { type: "tool.execution_start", timestamp: END, data: { toolCallId: "archive", toolName: "desk-task_archive", arguments: { track: "portable-tools", slug: "integrity-manifests" } } },
        { type: "tool.execution_complete", timestamp: END, data: { toolCallId: "archive", interactionId: "human-2", success: true, result: { content: JSON.stringify(RESULT) } } })
      else lines.splice(3, 0,
        { type: "assistant", sessionId: ID, timestamp: END, message: { stop_reason: "end_turn", content: [{ type: "text", text: PACKET.join("\n") }] } },
        { type: "user", sessionId: ID, timestamp: END, origin: { kind: "human" }, message: { content: "Archive the old task." } },
        { type: "assistant", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_use", id: "archive", name: "mcp__desk__task_archive", input: { track: "portable-tools", slug: "integrity-manifests" } }] } },
        { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "archive", content: JSON.stringify(RESULT) }] } })
      if (host === "copilot") lines[8].data.interactionId = "human-2"
    } })
    assert.equal((await check(f)).output, undefined)
  }))
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
  const first = await check(await fixture(ctx, "copilot"))
  for (const reason of ["[DESK_DELIVERY_CORRECTION] prior correction", first.output.reason]) {
    const f = await fixture(ctx, "copilot", { edit(lines) {
      lines.splice(4, 0, { type: "hook.end", timestamp: END, data: { hookType: "agentStop", output: { decision: "block", reason } } })
    } })
    assert.equal((await check(f)).status, "unverified")
  }
}))
test("Copilot: actual primary parentAgentTaskId is not a subagent classification", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) { lines[1].data.parentAgentTaskId = "host-primary-task" } })
  assert.equal((await check(f)).status, "correction")
}))
test("native legacy task IDs are opaque on read, never revalidated as new names", () => scratch(async ctx => {
  const f = await fixture(ctx, "copilot", { edit(lines) {
    lines[2].data.arguments.track = "Legacy Track"
    lines[2].data.arguments.slug = "old_task_été"
  } })
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
