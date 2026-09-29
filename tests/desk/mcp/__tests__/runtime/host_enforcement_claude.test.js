// Claude Code's `PreToolUse` wiring for Desk-only enforcement (spec §5): the
// `.cjs` entry point composes `runtime/host-enforcement.js`'s deny decision
// with `runtime/naming-allowlist.js`'s same-session exception, wraps a deny
// in Claude's `hookSpecificOutput` shape, and fails open on internal error --
// the same real-stdin/stdout contract `ask_gate.test.js` already covers for
// its own hook.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { saveSessionAllowlist } from "../../../../../plugins/desk/mcp/src/runtime/naming-allowlist.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "host-enforcement.cjs")

function runHookOverStdio(input, env = process.env) {
  const result = spawnSync(process.execPath, [hook, "claude"], { input: JSON.stringify(input), env, encoding: "utf8" })
  return { result, output: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) }
}

test("the .cjs entry point wraps the deny decision in Claude's hookSpecificOutput shape, and an internal error allows the call through", () => {
  const { result, output } = runHookOverStdio({ hook_event_name: "PreToolUse", tool_name: "EnterPlanMode", session_id: "s-1" })
  assert.equal(result.status, 0)
  assert.equal(output.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny")
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /planning docs/)

  // Malformed stdin must not exit 2 (the only PreToolUse code that blocks): it must fail open.
  const broken = spawnSync(process.execPath, [hook, "claude"], { input: "not json", env: process.env, encoding: "utf8" })
  assert.notEqual(broken.status, 2)
})

test("a tool this hook does not cover is allowed through with an empty decision", () => {
  const { result, output } = runHookOverStdio({ hook_event_name: "PreToolUse", tool_name: "Read", session_id: "s-2" })
  assert.equal(result.status, 0)
  assert.deepEqual(output, {})
})

test("a surface the naming hook already recorded for this session is allowed through this hook too", () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-host-enforcement-state-"))
  const env = { ...process.env, XDG_STATE_HOME: stateHome }
  try {
    saveSessionAllowlist({ env, sessionId: "s-named", sessionState: new Set(["plan-mode"]) })
    const { result, output } = runHookOverStdio({ hook_event_name: "PreToolUse", tool_name: "EnterPlanMode", session_id: "s-named" }, env)
    assert.equal(result.status, 0)
    assert.deepEqual(output, {})
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("a full mcp__claude_ai_Claude_Docs__* tool name is denied naming desk_save", () => {
  const { output } = runHookOverStdio({ hook_event_name: "PreToolUse", tool_name: "mcp__claude_ai_Claude_Docs__create", session_id: "s-3" })
  assert.equal(output.hookSpecificOutput.permissionDecision, "deny")
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /desk_save/)
})

test("TaskUpdate is denied through the real process, with the host threaded from argv[2]; TaskStop and TaskOutput are allowed", () => {
  const denied = runHookOverStdio({ hook_event_name: "PreToolUse", tool_name: "TaskUpdate", session_id: "s-4" })
  assert.equal(denied.output.hookSpecificOutput.permissionDecision, "deny")
  assert.match(denied.output.hookSpecificOutput.permissionDecisionReason, /task_create/)

  for (const toolName of ["TaskStop", "TaskOutput"]) {
    const { output } = runHookOverStdio({ hook_event_name: "PreToolUse", tool_name: toolName, session_id: "s-4" })
    assert.deepEqual(output, {})
  }
})
