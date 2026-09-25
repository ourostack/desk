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
  ["mcp__plugin_desk_desk__task_create", "desk"], ["mcp__plugin_desk_desk__desk_status", "desk"],
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
  ["desk-task_create", "desk"], ["desk-desk_status", "desk"],
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
