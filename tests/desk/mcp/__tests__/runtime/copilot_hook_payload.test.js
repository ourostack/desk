// Copilot CLI's hook payloads (live-checked on 1.0.89), read as the Claude-shaped calls Desk's guards already judge.
// preToolUse: { sessionId, timestamp, cwd, toolName, toolArgs }. `toolArgs` is an object for `bash`, `create` and `edit`, and the raw patch text for `apply_patch`.
// postToolUse adds `toolResult: { resultType, textResultForLlm }`. agentStop: { sessionId, transcriptPath, stopReason, stop_hook_active }.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

import {
  claudeShapedPayload,
  copilotDeny,
  copilotFinalReply,
  readTranscriptTail,
  copilotToolCalls,
  finalReplyFromEvents,
  isTaskToolName,
  mcpToolName,
  patchCalls,
} from "../../../../../plugins/desk/mcp/src/runtime/copilot-hook-payload.js"

const call = (toolName, toolArgs) => copilotToolCalls({ sessionId: "s", cwd: "/w", toolName, toolArgs })

test("the shell tools are the Bash and PowerShell calls the guards read", () => {
  assert.deepEqual(call("bash", { command: "echo hi", description: "x" }), [{ toolName: "Bash", args: { command: "echo hi", description: "x" } }])
  assert.deepEqual(call("powershell", { command: "Get-Date" }), [{ toolName: "PowerShell", args: { command: "Get-Date" } }])
  // Arguments that arrive as JSON text are read as the object they are.
  assert.deepEqual(call("bash", JSON.stringify({ command: "ls" })), [{ toolName: "Bash", args: { command: "ls" } }])
  // A shell call with no readable arguments is nothing to judge.
  assert.deepEqual(call("bash", undefined), [])
  assert.deepEqual(call("bash", "not json"), [])
  assert.deepEqual(call("bash", null), [])
})

test("create is a Write and edit is an Edit, with the path and text fields Claude's tools use", () => {
  assert.deepEqual(call("create", { path: "/d/t/task.md", file_text: "hello" }), [{ toolName: "Write", args: { file_path: "/d/t/task.md", content: "hello" } }])
  assert.deepEqual(call("create", { path: "/d/t/task.md" }), [{ toolName: "Write", args: { file_path: "/d/t/task.md", content: "" } }])
  assert.deepEqual(call("edit", { path: "/d/t/task.md", old_str: "a", new_str: "b" }), [{ toolName: "Edit", args: { file_path: "/d/t/task.md", old_string: "a", new_string: "b" } }])
  assert.deepEqual(call("edit", { path: "/d/t/task.md", new_str: "b" }), [{ toolName: "Edit", args: { file_path: "/d/t/task.md", old_string: "", new_string: "b" } }], "an insert has no old text")
  assert.deepEqual(call("edit", { path: "/d/t/task.md" }), [{ toolName: "Edit", args: { file_path: "/d/t/task.md", old_string: "", new_string: "" } }])
})

test("the editor tools some Copilot builds expose map by their command", () => {
  for (const name of ["str_replace_editor", "str_replace_based_edit_tool"]) {
    assert.deepEqual(call(name, { command: "str_replace", path: "/p", old_str: "a", new_str: "b" }), [{ toolName: "Edit", args: { file_path: "/p", old_string: "a", new_string: "b" } }])
    assert.deepEqual(call(name, { command: "create", path: "/p", file_text: "t" }), [{ toolName: "Write", args: { file_path: "/p", content: "t" } }])
    assert.deepEqual(call(name, { command: "view", path: "/p" }), [], "viewing writes nothing")
  }
})

test("a tool that writes nothing, or that Desk does not know, is nothing to judge", () => {
  for (const name of ["view", "grep", "glob", "read_file", "read_bash", "ls", "list_dir", "web_fetch", undefined, 7]) assert.deepEqual(call(name, { path: "/p" }), [], String(name))
  for (const name of ["task", "report_intent", "skill", "desk-task_update"]) assert.deepEqual(call(name, { description: "no file" }), [], String(name))
  assert.deepEqual(copilotToolCalls(undefined), [])
  assert.deepEqual(copilotToolCalls({}), [])
  assert.deepEqual(copilotToolCalls({ toolName: "edit" }), [], "no arguments")
  assert.deepEqual(call("edit", "text"), [], "arguments that are not an object")
})

test("apply_patch is one Write or Edit per file section, hunk by hunk", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: new/task.md",
    "+---",
    "+status: done",
    "+---",
    "*** Update File: a/task.md",
    "@@",
    " context",
    "-status: processing",
    "+status: done",
    "@@ later",
    "-old tail",
    "+new tail",
    "*** Delete File: gone.txt",
    "*** End Patch",
    "",
  ].join("\n")
  assert.deepEqual(call("apply_patch", patch), [
    { toolName: "Write", args: { file_path: "new/task.md", content: "---\nstatus: done\n---" } },
    { toolName: "Edit", args: { file_path: "a/task.md", old_string: "context\nstatus: processing", new_string: "context\nstatus: done" } },
    { toolName: "Edit", args: { file_path: "a/task.md", old_string: "old tail", new_string: "new tail" } },
    { toolName: "Edit", args: { file_path: "gone.txt", old_string: "", new_string: "" } },
  ])
  // The patch text may arrive inside an object, whatever the key, and a CRLF patch reads the same.
  for (const key of ["input", "patch", "text"]) assert.equal(call("apply_patch", { [key]: patch }).length, 4, key)
  assert.equal(call("apply_patch", patch.replaceAll("\n", "\r\n")).length, 4)
  assert.deepEqual(call("apply_patch", { other: patch }), [])
  assert.deepEqual(call("apply_patch", undefined), [])
})

test("a patch that renames a file is a change to the source and a write of the destination", () => {
  const patch = "*** Begin Patch\n*** Update File: a/task.md\n*** Move to: b/task.md\n@@\n-x\n+y\n*** End Patch\n"
  assert.deepEqual(patchCalls(patch), [
    { toolName: "Edit", args: { file_path: "a/task.md", old_string: "x", new_string: "y" } },
    { toolName: "Write", args: { file_path: "b/task.md", content: "y" } },
  ])
  // A rename with no hunks still touches both paths.
  assert.deepEqual(patchCalls("*** Begin Patch\n*** Update File: a/task.md\n*** Move to: b/task.md\n*** End Patch\n"), [
    { toolName: "Edit", args: { file_path: "a/task.md", old_string: "", new_string: "" } },
    { toolName: "Write", args: { file_path: "b/task.md", content: "" } },
  ])
  assert.deepEqual(patchCalls("no patch here"), [])
  assert.deepEqual(patchCalls("*** Begin Patch\nstray line\n*** End Patch\n"), [])
})

test("a Desk task tool is named the way Claude and Codex name an MCP tool, whatever the server is called", () => {
  assert.equal(mcpToolName("desk-task_update"), "mcp__desk__task_update")
  assert.equal(mcpToolName("plugin_desk_desk-task_create"), "mcp__plugin_desk_desk__task_create")
  assert.equal(mcpToolName("desk-task_move"), "mcp__desk__task_move")
  assert.equal(mcpToolName("desk-task_archive"), "mcp__desk__task_archive")
  assert.equal(mcpToolName("desk-task_signoff"), "mcp__desk__task_signoff")
  assert.equal(mcpToolName("bash"), "bash")
  assert.equal(mcpToolName("desk-desk_status"), "desk-desk_status")
  assert.equal(mcpToolName(undefined), "")
})

test("a Copilot payload becomes the Claude-shaped payload the done-claim gate reads", () => {
  const shaped = claudeShapedPayload({
    sessionId: "s1", cwd: "/w", toolName: "desk-task_update", toolArgs: { track: "t", slug: "x" },
    toolResult: { resultType: "success", textResultForLlm: "{\"status\":\"updated\"}" },
    transcriptPath: "/events.jsonl", stop_hook_active: true,
  })
  assert.deepEqual(shaped, { session_id: "s1", cwd: "/w", tool_name: "mcp__desk__task_update", tool_input: { track: "t", slug: "x" }, tool_response: "{\"status\":\"updated\"}", transcript_path: "/events.jsonl", stop_hook_active: true })
  assert.equal(claudeShapedPayload({ sessionId: "s", stopHookActive: true }).stop_hook_active, true, "the SDK spells the flag in camelCase")
  assert.equal(claudeShapedPayload({ sessionId: "s" }).stop_hook_active, undefined)
  assert.equal(claudeShapedPayload(undefined).session_id, undefined)
  assert.equal(claudeShapedPayload({ toolArgs: "{\"slug\":\"x\"}" }).tool_input.slug, "x")
})

test("a deny from a shared guard is written the way Copilot reads it: flat, with no wrapper", () => {
  const reason = "Desk denies a direct edit of an existing task card"
  assert.deepEqual(copilotDeny({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }), { permissionDecision: "deny", permissionDecisionReason: reason })
  assert.deepEqual(copilotDeny({ permissionDecision: "deny", permissionDecisionReason: reason }), { permissionDecision: "deny", permissionDecisionReason: reason }, "already flat")
  assert.deepEqual(copilotDeny({}), {})
  assert.deepEqual(copilotDeny(undefined), {})
  assert.deepEqual(copilotDeny({ hookSpecificOutput: { permissionDecision: "allow" } }), {})
})

// ---- the final reply in Copilot's session transcript (events.jsonl) ----

const event = (type, data = {}) => JSON.stringify({ type, data })
const message = (content, toolRequests = []) => event("assistant.message", { content, toolRequests })
const transcriptOf = (...lines) => `${lines.join("\n")}\n`

test("the final reply is the last assistant message with no tool request, after the last user message", () => {
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), message("narration", [{}]), event("tool.execution_complete"), message("All done."))), "All done.")
  // A reply from before the latest prompt is not this turn's.
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), message("Old reply."), event("user.message"), event("assistant.turn_start"))), null)
  // The turn is still calling tools: no final reply yet.
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), message("calling", [{}]))), null)
  // A hook-injected follow-up is a user message too, so the reply to it is the one judged.
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), message("First."), event("user.message"), message("Second."))), "Second.")
  assert.equal(finalReplyFromEvents(transcriptOf(message("No user message at all."))), "No user message at all.")
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), message(""))), null, "an empty message is no reply")
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), message("   "))), null)
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), event("assistant.message", { toolRequests: [] }))), null, "no content field")
  assert.equal(finalReplyFromEvents(transcriptOf(event("user.message"), event("assistant.message", { content: "no list of requests" }))), "no list of requests")
})

test("a line that is not JSON, or not an event, is skipped", () => {
  assert.equal(finalReplyFromEvents(transcriptOf("{broken", "[]", "null", event("user.message"), message("Fine."), "also broken")), "Fine.")
  assert.equal(finalReplyFromEvents(""), null)
})

test("the reader waits briefly for the reply Copilot writes just after the stop hook starts, and gives up quietly", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "copilot-transcript-"))
  try {
    const file = path.join(dir, "events.jsonl")
    writeFileSync(file, transcriptOf(event("user.message"), message("calling", [{}])))
    const sleeps = []
    // The reply lands after two polls.
    const reply = await copilotFinalReply(file, {
      waitMs: 1000, stepMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms)
        if (sleeps.length === 2) writeFileSync(file, transcriptOf(event("user.message"), message("calling", [{}]), message("Done.")))
      },
    })
    assert.equal(reply, "Done.")
    assert.deepEqual(sleeps, [100, 100])
    // It never writes: a reply that never lands is null after the wait.
    writeFileSync(file, transcriptOf(event("user.message")))
    const slept = []
    assert.equal(await copilotFinalReply(file, { waitMs: 300, stepMs: 100, sleep: async (ms) => { slept.push(ms) } }), null)
    assert.deepEqual(slept, [100, 100, 100])
    // The real clock is used when no sleep is given.
    writeFileSync(file, transcriptOf(event("user.message")))
    assert.equal(await copilotFinalReply(file, { waitMs: 60, stepMs: 30 }), null)
    // A reply that is already there needs no wait.
    writeFileSync(file, transcriptOf(event("user.message"), message("Ready.")))
    assert.equal(await copilotFinalReply(file, { waitMs: 100 }), "Ready.")
    // An empty message is final: waiting will not fill it.
    writeFileSync(file, transcriptOf(event("user.message"), message("")))
    assert.equal(await copilotFinalReply(file, { waitMs: 100, sleep: async () => assert.fail("must not wait") }), null)
    // A missing or unreadable transcript, or none at all, is no reply.
    assert.equal(await copilotFinalReply(path.join(dir, "absent.jsonl"), { waitMs: 100, stepMs: 50, sleep: async () => {} }), null)
    assert.equal(await copilotFinalReply(undefined), null)
    assert.equal(await copilotFinalReply(""), null)
    // A transcript over the limit is read from its tail, so a long session is still gated.
    const counted = []
    const filler = `${JSON.stringify(event("user.message"))}\n`.repeat(50)
    writeFileSync(file, `${filler}${transcriptOf(event("user.message"), message("Done. All of it."))}`)
    assert.equal(await copilotFinalReply(file, { maxBytes: 3, tailBytes: 300, record: (kind) => counted.push(kind) }), "Done. All of it.")
    assert.deepEqual(counted, [], "a reply found in the tail is not a failure")
    // A tail with no reply, or an empty one, is counted for desk_doctor and still passes.
    writeFileSync(file, `${filler}${transcriptOf(event("user.message"))}`)
    assert.equal(await copilotFinalReply(file, { maxBytes: 3, tailBytes: 300, waitMs: 60, stepMs: 30, record: (kind) => counted.push(kind) }), null)
    writeFileSync(file, `${filler}${transcriptOf(event("user.message"), message(""))}`)
    assert.equal(await copilotFinalReply(file, { maxBytes: 3, tailBytes: 300, record: (kind) => counted.push(kind) }), null)
    assert.deepEqual(counted, ["reply_unread", "reply_unread"])
    // A small file under the limit never counts, and a tail longer than the file reads all of it.
    assert.equal(await copilotFinalReply(file, { waitMs: 0, record: () => assert.fail("not oversized") }), null)
    assert.equal(readTranscriptTail(file, statSync(file).size, 10 ** 6), readFileSync(file, "utf8"))
    // The real counter is the default: an oversized transcript with no reply counts in the isolated state folder.
    assert.equal(await copilotFinalReply(file, { maxBytes: 3, tailBytes: 300, waitMs: 0 }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test("odd inputs are nothing to judge: a create with no arguments object, a non-string tool name, a patch with a no-newline marker", () => {
  assert.deepEqual(call("create", "not an object"), [])
  assert.equal(isTaskToolName(undefined), false)
  assert.equal(isTaskToolName("desk-task_update"), true)
  assert.equal(isTaskToolName("desk-task_signoff"), true)
  const calls = patchCalls("*** Begin Patch\n*** Update File: /w/x.md\n@@\n-a\n+b\n\\ No newline at end of file\n*** End Patch\n")
  assert.equal(calls.length, 1)
})

test("any tool that is not read-only and aims a path or file_path at a file is an Edit: the guard denies by default", () => {
  for (const name of ["str_replace", "write", "multi_edit", "insert", "write_file", "some-future-tool"]) {
    const [shaped, ...rest] = call(name, { path: "/d/t/s/task.md", old_str: "a", new_str: "b" })
    assert.equal(rest.length, 0, name)
    assert.equal(shaped.toolName, "Edit", name)
    assert.deepEqual(shaped.args, { file_path: "/d/t/s/task.md", old_string: "a", new_string: "b" }, name)
  }
  assert.deepEqual(call("edit", { file_path: "/d/t/s/task.md", old_str: "a", new_str: "b" }), [{ toolName: "Edit", args: { file_path: "/d/t/s/task.md", old_string: "a", new_string: "b" } }], "edit with file_path")
  assert.deepEqual(call("create", { file_path: "/d/t/s/task.md", file_text: "x" }), [{ toolName: "Write", args: { file_path: "/d/t/s/task.md", content: "x" } }], "create with file_path")
  assert.deepEqual(call("write", { file_path: "/d/x.md", new_string: "n", old_string: "o" })[0].args, { file_path: "/d/x.md", old_string: "o", new_string: "n" }, "Claude-style field names")
  assert.deepEqual(call("write", { file_path: "/d/x.md", content: "whole" })[0].args.new_string, "whole", "a whole-file body counts as the new text")
  // Read-only tools, a view command, and calls with no path stay allowed.
  assert.deepEqual(call("view", { path: "/d/t/s/task.md" }), [])
  assert.deepEqual(call("read_file", { file_path: "/d/t/s/task.md" }), [])
  assert.deepEqual(call("str_replace", { command: "view", path: "/d/t/s/task.md" }), [])
  assert.deepEqual(call("write", { text: "no path" }), [])
  assert.deepEqual(call("write", { path: 7 }), [])
  assert.deepEqual(call("write", "text"), [])
})
