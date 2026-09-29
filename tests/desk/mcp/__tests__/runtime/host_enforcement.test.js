// The Claude-Code-only PR (ourostack/desk#Part 7) wires this into hooks.json's
// PreToolUse matcher; this file tests only the host-agnostic deny decision
// Part 8's Codex/Copilot wrappers will call too.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { DENIED_SURFACES, evaluateDeniedTool, surfaceForToolName } from "../../../../../plugins/desk/mcp/src/runtime/host-enforcement.js"

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

test("denies every persistent host task tool (TaskCreate/TaskGet/TaskList/TaskUpdate) naming task_create/task_update, and never denies TaskStop/TaskOutput, which manage an already-running background shell or subagent", () => {
  for (const toolName of ["TaskCreate", "TaskGet", "TaskList", "TaskUpdate"]) {
    const out = evaluateDeniedTool({ toolName, allowedThisSession: new Set() })
    assert.equal(out.permissionDecision, "deny", `${toolName} must be denied`)
    assert.match(out.permissionDecisionReason, /task_create/)
  }
  for (const toolName of ["TaskStop", "TaskOutput"]) {
    assert.deepEqual(evaluateDeniedTool({ toolName, allowedThisSession: new Set() }), {}, `${toolName} must not be denied`)
  }
})

test("never denies TodoWrite, Agent or SendMessage -- an in-session checklist and the agent-to-agent tools carry no durable state of their own", () => {
  for (const toolName of ["TodoWrite", "Agent", "SendMessage"]) {
    assert.deepEqual(evaluateDeniedTool({ toolName, allowedThisSession: new Set() }), {}, `${toolName} must not be denied`)
  }
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

test("host defaults to claude when the caller omits it", () => {
  const out = evaluateDeniedTool({ toolName: "AskUserQuestion", allowedThisSession: new Set() })
  assert.equal(out.permissionDecision, "deny")
})

test("an unrecognized host denies nothing, even for a tool name Claude Code itself denies", () => {
  const out = evaluateDeniedTool({ host: "some-future-host", toolName: "AskUserQuestion", allowedThisSession: new Set() })
  assert.deepEqual(out, {})
  assert.equal(surfaceForToolName("some-future-host", "AskUserQuestion"), null)
})

test("surfaceForToolName's own guards: a non-string or empty host, or a non-string or empty toolName, never denies", () => {
  assert.equal(surfaceForToolName("", "AskUserQuestion"), null)
  assert.equal(surfaceForToolName(null, "AskUserQuestion"), null)
  assert.equal(surfaceForToolName("claude", ""), null)
  assert.equal(surfaceForToolName("claude", undefined), null)
})

test("surfaceForToolName recognizes the same surface under Copilot's own MCP naming (server-tool), once a Copilot tool list exists for it", () => {
  const surfaces = {
    artifact: {
      reason: "Desk denies Artifacts and Claude Docs: use desk_save, or the task's own doc files, unless specifically asked for.",
      tools: { claude: [], copilot: ["claude_ai_Claude_Docs-create", "claude_ai_Claude_Docs-*"], codex: [] },
    },
  }
  // An exact Copilot-form tool name.
  assert.equal(surfaceForToolName("copilot", "claude_ai_Claude_Docs-create", surfaces), "artifact")
  // A different tool from the same Copilot MCP server, matched by the wildcard entry.
  assert.equal(surfaceForToolName("copilot", "claude_ai_Claude_Docs-read", surfaces), "artifact")
  // The same tool name under a host this fixture gives no list for.
  assert.equal(surfaceForToolName("codex", "claude_ai_Claude_Docs-create", surfaces), null)
})
