import { test } from "node:test"
import { strict as assert } from "node:assert"

import { toolKind } from "../../src/factory/tool-kinds.js"
import { ENUMS } from "../../src/factory/schema.js"

const CLAUDE_CASES = [
  ["Bash", "shell"], ["BashOutput", "shell"], ["KillShell", "shell"],
  ["Read", "read"], ["NotebookRead", "read"],
  ["Write", "edit"], ["Edit", "edit"], ["MultiEdit", "edit"], ["NotebookEdit", "edit"],
  ["Grep", "search"], ["Glob", "search"], ["ToolSearch", "search"],
  ["WebFetch", "web"], ["WebSearch", "web"],
  ["mcp__Claude_Browser__navigate", "web"], ["mcp__claude-in-chrome__computer", "web"],
  ["Agent", "agent"], ["Task", "agent"], ["SendMessage", "agent"],
  // All 5 verbs the desk regex recognizes (task|track|friction|lesson|desk), one per test.
  ["mcp__plugin_desk_desk__task_create", "desk"],
  ["mcp__plugin_desk_desk__track_update", "desk"],
  ["mcp__plugin_desk_desk__friction_add", "desk"],
  ["mcp__plugin_desk_desk__lesson_add", "desk"],
  ["mcp__plugin_desk_desk__desk_status", "desk"],
  // A desk-named MCP server tool that isn't one of those 5 verbs stays a generic mcp tool.
  ["mcp__plugin_desk_desk__search", "mcp"],
  ["Skill", "skill"],
  ["TodoWrite", "plan"], ["ExitPlanMode", "plan"],
  ["mcp__some_server__other_tool", "mcp"],
  ["SomeUnknownTool", "other"],
]

for (const [name, expected] of CLAUDE_CASES) {
  test(`claude-code toolKind(${name}) -> ${expected}`, () => {
    assert.equal(toolKind({ host: "claude-code", name }), expected)
  })
}

const COPILOT_CASES = [
  ["bash", "shell"], ["powershell", "shell"], ["read_bash", "shell"], ["write_bash", "shell"], ["stop_bash", "shell"],
  ["view", "read"],
  ["apply_patch", "edit"], ["create", "edit"], ["edit", "edit"],
  ["grep", "search"], ["glob", "search"],
  ["web_fetch", "web"],
  ["task", "agent"],
  // All 10 desk suffixes the brief lists, one per test.
  ["desk-task_create", "desk"], ["desk-task_update", "desk"], ["desk-task_archive", "desk"],
  ["desk-track_create", "desk"], ["desk-track_update", "desk"],
  ["desk-friction_add", "desk"], ["desk-lesson_add", "desk"],
  ["desk-desk_status", "desk"], ["desk-desk_search", "desk"], ["desk-desk_recall", "desk"],
  ["skill", "skill"],
  ["some-server-tool", "mcp"],
  ["randomtool", "other"],
]

for (const [name, expected] of COPILOT_CASES) {
  test(`copilot-cli toolKind(${name}) -> ${expected}`, () => {
    assert.equal(toolKind({ host: "copilot-cli", name }), expected)
  })
}

test("every mapped bucket is a member of ENUMS.toolKind", () => {
  const all = [...CLAUDE_CASES, ...COPILOT_CASES].map(([, kind]) => kind)
  for (const kind of all) assert.ok(ENUMS.toolKind.includes(kind), kind)
})

// Minor ruling M6: toolKind never throws on input it cannot fully trust —
// an unrecognized host or a non-string name resolves to "other" instead.
test("an unrecognized host resolves to other rather than throwing", () => {
  assert.equal(toolKind({ host: "some-future-host", name: "Bash" }), "other")
})

test("a non-string name resolves to other rather than throwing, for either host", () => {
  assert.equal(toolKind({ host: "claude-code", name: 42 }), "other")
  assert.equal(toolKind({ host: "claude-code", name: undefined }), "other")
  assert.equal(toolKind({ host: "copilot-cli", name: null }), "other")
})
