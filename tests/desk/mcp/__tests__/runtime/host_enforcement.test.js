// The Claude-Code-only PR (ourostack/desk#Part 7) wires this into hooks.json's
// PreToolUse matcher; this file tests only the host-agnostic deny decision
// Part 8's Codex/Copilot wrappers will call too.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import {
  DENIED_SURFACES,
  evaluateDeniedTool,
  formatHookOutput,
  hookProcessOutput,
  sessionIdFromPayload,
  surfaceForToolName,
  toolNameFromPayload,
} from "../../../../../plugins/desk/mcp/src/runtime/host-enforcement.js"

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

test("toolNameFromPayload reads Copilot's camelCase toolName, and Claude/Codex's shared snake_case tool_name", () => {
  assert.equal(toolNameFromPayload("copilot", { toolName: "bash" }), "bash")
  assert.equal(toolNameFromPayload("claude", { tool_name: "Read" }), "Read")
  assert.equal(toolNameFromPayload("codex", { tool_name: "Bash" }), "Bash")
})

test("toolNameFromPayload returns undefined for a missing or non-string field, on every host", () => {
  assert.equal(toolNameFromPayload("copilot", {}), undefined)
  assert.equal(toolNameFromPayload("copilot", { toolName: 12 }), undefined)
  assert.equal(toolNameFromPayload("claude", {}), undefined)
  assert.equal(toolNameFromPayload("claude", { tool_name: 12 }), undefined)
})

test("sessionIdFromPayload reads Copilot's camelCase sessionId, and Claude/Codex's shared snake_case session_id", () => {
  assert.equal(sessionIdFromPayload("copilot", { sessionId: "s-1" }), "s-1")
  assert.equal(sessionIdFromPayload("claude", { session_id: "s-2" }), "s-2")
  assert.equal(sessionIdFromPayload("codex", { session_id: "s-3" }), "s-3")
  assert.equal(sessionIdFromPayload("copilot", {}), undefined)
})

test("formatHookOutput wraps a deny in Claude's hookSpecificOutput shape, but leaves Copilot's flat, and allows through as {} on both", () => {
  const deny = { permissionDecision: "deny", permissionDecisionReason: "because" }
  assert.deepEqual(formatHookOutput("claude", deny), { hookSpecificOutput: { hookEventName: "PreToolUse", ...deny } })
  assert.deepEqual(formatHookOutput("copilot", deny), deny)
  assert.deepEqual(formatHookOutput("claude", {}), {})
  assert.deepEqual(formatHookOutput("copilot", {}), {})
})

test("hookProcessOutput on Codex: a deny writes the reason to stderr and exits 2, with nothing on stdout", () => {
  const result = hookProcessOutput("codex", { permissionDecision: "deny", permissionDecisionReason: "because" })
  assert.deepEqual(result, { stdout: "", stderr: "because\n", exitCode: 2 })
})

test("hookProcessOutput on Codex: an allow writes nothing at all and exits 0 -- Codex has no JSON PreToolUse convention", () => {
  const result = hookProcessOutput("codex", {})
  assert.deepEqual(result, { stdout: "", stderr: "", exitCode: 0 })
})

test("hookProcessOutput on Claude and Copilot: the JSON decision goes to stdout, exit 0, nothing on stderr", () => {
  const deny = { permissionDecision: "deny", permissionDecisionReason: "because" }
  assert.deepEqual(hookProcessOutput("claude", deny), {
    stdout: `${JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", ...deny } })}\n`,
    stderr: "",
    exitCode: 0,
  })
  assert.deepEqual(hookProcessOutput("copilot", {}), { stdout: "{}\n", stderr: "", exitCode: 0 })
})
