// The task-status guard (the invented-completion finding): a Claude Code
// `PreToolUse` hook on `Write`/`Edit` that denies a direct edit setting a
// task card's `status:` frontmatter line to `done`, pointing the agent at
// `task_update` instead -- the tool that now enforces `assertDoneEvidence`
// (see tools/task.js and task_update.test.js's own "Evidence gate on
// `done`" section). This file tests the pure decision
// (`taskStatusGuardHook` and its two helpers) directly, plus one real
// stdin/stdout pass through the `.cjs` entry point mirroring
// host_enforcement_claude.test.js's own `runHookOverStdio` pattern, to
// prove the wrapper's wiring and its fail-open behavior on a broken call.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  isTaskCardPath,
  setsStatusToDone,
  taskStatusGuardHook,
} from "../../../../../plugins/desk/mcp/src/runtime/task-status-guard.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "task-status-guard.cjs")

function writeInput({ toolName, toolInput }) {
  return { hook_event_name: "PreToolUse", tool_name: toolName, tool_input: toolInput, session_id: "fixture-session" }
}

function assertDenied(result) {
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny")
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /task_update/)
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /evidence/)
}

function assertAllowed(result) {
  assert.deepEqual(result, {})
}

test("isTaskCardPath matches only a file_path whose final segment is exactly task.md", () => {
  assert.equal(isTaskCardPath("task.md"), true)
  assert.equal(isTaskCardPath("/repo/track/my-task/task.md"), true)
  assert.equal(isTaskCardPath("track\\my-task\\task.md"), true, "backslash-separated (Windows-shaped) paths still match")
  assert.equal(isTaskCardPath("/repo/track/my-task/nottask.md"), false)
  assert.equal(isTaskCardPath("/repo/track/my-task/task.md.bak"), false)
  assert.equal(isTaskCardPath("/repo/track.md/other.md"), false)
  assert.equal(isTaskCardPath(""), false)
  assert.equal(isTaskCardPath(undefined), false)
  assert.equal(isTaskCardPath(42), false)
})

test("setsStatusToDone reads Write's content and Edit's new_string, in several quote and spacing styles, and ignores everything else", () => {
  for (const body of ["status: done", "status: \"done\"", "status: 'done'", "status:done", "status:   done  "]) {
    assert.equal(setsStatusToDone("Write", { content: `---\n${body}\n---\n` }), true, body)
    assert.equal(setsStatusToDone("Edit", { new_string: body }), true, body)
  }
  assert.equal(setsStatusToDone("Write", { content: "status: processing" }), false)
  assert.equal(setsStatusToDone("Write", { content: "status: doneish" }), false, "a status value that merely starts with done must not match")
  assert.equal(setsStatusToDone("Write", { content: "status: not_done" }), false)
  assert.equal(setsStatusToDone("Write", {}), false, "missing content")
  assert.equal(setsStatusToDone("Edit", {}), false, "missing new_string")
  assert.equal(setsStatusToDone("Read", { content: "status: done" }), false, "a tool this guard does not cover")
})

test("denies a Claude Code Write that would create a task card with status: done", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/task.md", content: "---\nstatus: done\n---\n" } }),
    "claude",
  )
  assertDenied(result)
})

test("denies a Claude Code Edit whose new_string sets status: done", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Edit", toolInput: { file_path: "/repo/track/my-task/task.md", old_string: "status: processing", new_string: "status: done" } }),
    "claude",
  )
  assertDenied(result)
})

test("allows an Edit to a task card that changes status to anything other than done", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Edit", toolInput: { file_path: "/repo/track/my-task/task.md", old_string: "status: drafting", new_string: "status: processing" } }),
    "claude",
  )
  assertAllowed(result)
})

test("allows a Write/Edit to a task card that touches a different field, leaving status alone", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Edit", toolInput: { file_path: "/repo/track/my-task/task.md", old_string: "old next step", new_string: "new next step" } }),
    "claude",
  )
  assertAllowed(result)
})

test("allows a status: done write to a file that is not a task card", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/notes.md", content: "status: done" } }),
    "claude",
  )
  assertAllowed(result)
})

test("allows a status: done write for a tool this guard does not cover", () => {
  const result = taskStatusGuardHook(
    writeInput({ toolName: "Bash", toolInput: { command: "echo 'status: done' >> task.md" } }),
    "claude",
  )
  assertAllowed(result)
})

test("tolerates a JSON-string-encoded tool_input the same way, and allows through malformed JSON rather than throwing", () => {
  const encoded = writeInput({ toolName: "Write", toolInput: JSON.stringify({ file_path: "/repo/track/my-task/task.md", content: "status: done" }) })
  assertDenied(taskStatusGuardHook(encoded, "claude"))

  const broken = writeInput({ toolName: "Write", toolInput: "not json" })
  assertAllowed(taskStatusGuardHook(broken, "claude"))
})

test("allows through a call whose tool_input is missing, null, or not an object at all", () => {
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: undefined }), "claude"))
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: null }), "claude"))
  assertAllowed(taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: 42 }), "claude"))
})

test("allows through a call with neither tool_name nor toolName at all", () => {
  const result = taskStatusGuardHook({ hook_event_name: "PreToolUse", session_id: "fixture-session" }, "claude")
  assertAllowed(result)
})

test("allows through a call missing file_path entirely", () => {
  const result = taskStatusGuardHook(writeInput({ toolName: "Write", toolInput: { content: "status: done" } }), "claude")
  assertAllowed(result)
})

test("recognizes toolName/toolArgs as well as tool_name/tool_input, the same alias pair ask-gate.js reads", () => {
  const result = taskStatusGuardHook(
    { hook_event_name: "PreToolUse", toolName: "Write", toolArgs: { file_path: "/repo/track/my-task/task.md", content: "status: done" } },
    "claude",
  )
  assertDenied(result)
})

test("allows every call for any host but claude, even one that would otherwise be denied", () => {
  for (const host of [undefined, "copilot", "codex", "some-future-host"]) {
    const result = taskStatusGuardHook(
      writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/task.md", content: "status: done" } }),
      host,
    )
    assertAllowed(result)
  }
})

function runHookOverStdio(input, env = process.env) {
  const result = spawnSync(process.execPath, [hook, "claude"], { input: JSON.stringify(input), env, encoding: "utf8" })
  return { result, output: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) }
}

test("the .cjs entry point wraps the deny decision in Claude's hookSpecificOutput shape over real stdin/stdout, and fails open on malformed input", () => {
  const { result, output } = runHookOverStdio(
    writeInput({ toolName: "Write", toolInput: { file_path: "/repo/track/my-task/task.md", content: "status: done" } }),
  )
  assert.equal(result.status, 0)
  assertDenied(output)

  const allowed = runHookOverStdio(writeInput({ toolName: "Read", toolInput: {} }))
  assert.equal(allowed.result.status, 0)
  assert.deepEqual(allowed.output, {})

  // Malformed stdin must not exit 2 (the only PreToolUse code that blocks): it must fail open.
  const broken = spawnSync(process.execPath, [hook, "claude"], { input: "not json", env: process.env, encoding: "utf8" })
  assert.notEqual(broken.status, 2)
})
