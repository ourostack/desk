// The Claude-Code-only PR (ourostack/desk#Part 7) wires this into hooks.json's
// PreToolUse matcher; this file tests only the host-agnostic deny decision
// Part 8's Codex/Copilot wrappers will call too.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { DENIED_SURFACES, evaluateDeniedTool } from "../../../../../plugins/desk/mcp/src/runtime/host-enforcement.js"

test("evaluateDeniedTool denies AskUserQuestion naming interaction-style, allows it once named this session, and never denies TodoWrite", () => {
  const out = evaluateDeniedTool({ toolName: "AskUserQuestion", allowedThisSession: new Set() })
  assert.equal(out.permissionDecision, "deny")
  assert.match(out.permissionDecisionReason, /interaction-style/)

  const allowed = evaluateDeniedTool({ toolName: "AskUserQuestion", allowedThisSession: new Set(["ask-user"]) })
  assert.deepEqual(allowed, {})

  const todo = evaluateDeniedTool({ toolName: "TodoWrite", allowedThisSession: new Set() })
  assert.deepEqual(todo, {})
})

test("denies plan mode tools (EnterPlanMode/ExitPlanMode) naming the desk's own planning docs", () => {
  for (const toolName of ["EnterPlanMode", "ExitPlanMode"]) {
    const out = evaluateDeniedTool({ toolName, allowedThisSession: new Set() })
    assert.equal(out.permissionDecision, "deny")
    assert.match(out.permissionDecisionReason, /planning docs/)
  }
})

test("denies a persistent host task tool (TaskCreate) naming task_create/task_update", () => {
  const out = evaluateDeniedTool({ toolName: "TaskCreate", allowedThisSession: new Set() })
  assert.equal(out.permissionDecision, "deny")
  assert.match(out.permissionDecisionReason, /task_create/)
})

test("denies the Artifact family and every mcp__claude_ai_Claude_Docs__* tool naming desk_save", () => {
  for (const toolName of ["Artifact", "ArtifactComments", "ArtifactData", "ArtifactCheck", "mcp__claude_ai_Claude_Docs__batch", "mcp__claude_ai_Claude_Docs__read"]) {
    const out = evaluateDeniedTool({ toolName, allowedThisSession: new Set() })
    assert.equal(out.permissionDecision, "deny")
    assert.match(out.permissionDecisionReason, /desk_save/)
  }
})

test("host memory has a Desk-equivalent reason entry even though Claude Code exposes no denyable tool for it", () => {
  assert.ok(DENIED_SURFACES["host-memory"])
  assert.match(DENIED_SURFACES["host-memory"].reason, /desk/i)
})

test("an unrecognized tool name is never denied", () => {
  const out = evaluateDeniedTool({ toolName: "Read", allowedThisSession: new Set() })
  assert.deepEqual(out, {})
})

test("a missing/undefined toolName never denies", () => {
  assert.deepEqual(evaluateDeniedTool({ toolName: undefined, allowedThisSession: new Set() }), {})
})
