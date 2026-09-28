import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const source = new URL("../../../../../plugins/desk/mcp/src/runtime/ask-gate.js", import.meta.url)
const hook = path.join(plugin, "hooks", "ask-gate.cjs")
const { askGateHook } = await import(source)

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desk-ask-gate-"))
  const pluginData = path.join(root, "plugin-data")
  mkdirSync(pluginData, { recursive: true })
  return { root, pluginData, bindingPath: path.join(pluginData, "desk.activation.json") }
}

function teardown(root) {
  rmSync(root, { recursive: true, force: true })
}

const UNATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: "0" }
const ATTENDED = { CLAUDE_CODE_SESSION_ATTENDED: "1" }

function writeInput({ pluginData, cwd, toolName, toolInput }) {
  return {
    session_id: "fixture-session",
    cwd: cwd ?? pluginData,
    permission_mode: "bypassPermissions",
    hook_event_name: "PreToolUse",
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: "toolu_fixture",
  }
}

function assertDenied(result) {
  assert.equal(result.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.equal(result.hookSpecificOutput.permissionDecision, "deny")
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /nobody attending/u)
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /A3/u)
}

function assertAllowed(result) {
  assert.deepEqual(result, {})
}

test("denies a Write that would create the binding file in a confirmed-unattended Claude session", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("allows the same Write once a binding already exists (never blocks a rebind a human drives)", async () => {
  const f = fixture()
  try {
    writeFileSync(f.bindingPath, JSON.stringify({ schema_version: 1, desk: { root: "/somewhere" } }))
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("allows the write when the session reports attended", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...ATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("allows the write when attendance cannot be confirmed (variable absent, unexpected value, or empty string)", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    for (const env of [
      { CLAUDE_PLUGIN_DATA: f.pluginData },
      { CLAUDE_PLUGIN_DATA: f.pluginData, CLAUDE_CODE_SESSION_ATTENDED: "" },
      { CLAUDE_PLUGIN_DATA: f.pluginData, CLAUDE_CODE_SESSION_ATTENDED: "false" },
      { CLAUDE_PLUGIN_DATA: f.pluginData, CLAUDE_CODE_SESSION_ATTENDED: "no" },
    ]) {
      assertAllowed(await askGateHook(input, "claude", env))
    }
  } finally {
    teardown(f.root)
  }
})

test("allows the write when CLAUDE_PLUGIN_DATA is unset (cannot compute the real target: fails open)", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("ignores a host other than claude (no validated signal exists there yet)", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "copilot", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("ignores tools outside Write/Edit/Bash/PowerShell", async () => {
  const f = fixture()
  try {
    const input = writeInput({ pluginData: f.pluginData, toolName: "Read", toolInput: { file_path: f.bindingPath } })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("ignores a Write to an unrelated file", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: path.join(f.pluginData, "settings.json"), content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("resolves a relative Write file_path against the hook's cwd", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      cwd: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: "desk.activation.json", content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("denies an Edit targeting the binding path (defense in depth, even though Edit requires an existing file)", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Edit",
      toolInput: { file_path: f.bindingPath, old_string: "a", new_string: "b" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("denies a Bash command that redirects into the binding path", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Bash",
      toolInput: { command: `echo '{"schema_version":1}' > "${f.bindingPath}"` },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("allows a Bash command that only reads the binding path", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Bash",
      toolInput: { command: `cat "${f.bindingPath}"` },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("allows a Bash command that writes an unrelated file", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Bash",
      toolInput: { command: `echo hi > "${path.join(f.pluginData, "other.txt")}"` },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("denies a PowerShell command using Set-Content on the binding path", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "PowerShell",
      toolInput: { command: `Set-Content -Path "${f.bindingPath}" -Value '{}'` },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("fails open on a malformed tool_input JSON string", async () => {
  const f = fixture()
  try {
    const input = writeInput({ pluginData: f.pluginData, toolName: "Write", toolInput: undefined })
    input.tool_input = "{not json"
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("fails open when tool_input is missing entirely", async () => {
  const f = fixture()
  try {
    const input = writeInput({ pluginData: f.pluginData, toolName: "Write", toolInput: undefined })
    delete input.tool_input
    const result = await askGateHook(input, "claude", { ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("the .cjs entry point denies over real stdin/stdout and never crashes the host on error", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    const env = { ...process.env, ...UNATTENDED, CLAUDE_PLUGIN_DATA: f.pluginData }
    const result = spawnSync(process.execPath, [hook, "claude"], { input: JSON.stringify(input), env, encoding: "utf8" })
    assert.equal(result.status, 0)
    const parsed = JSON.parse(result.stdout)
    assert.equal(parsed.hookSpecificOutput.permissionDecision, "deny")

    // Malformed stdin must not exit 2 (the only PreToolUse code that blocks): it must fail open.
    const broken = spawnSync(process.execPath, [hook, "claude"], { input: "not json", env, encoding: "utf8" })
    assert.notEqual(broken.status, 2)
  } finally {
    teardown(f.root)
  }
})
