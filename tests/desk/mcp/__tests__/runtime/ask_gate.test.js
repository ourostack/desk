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

// The real shape any Claude config dir gives a plugin's activation file:
// `.../plugins/data/<plugin-id>/desk.activation.json`. Matching is purely
// structural now (no CLAUDE_PLUGIN_DATA/env lookup at all for Write/Edit),
// so every fixture builds this real shape rather than a shortcut directory.
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "desk-ask-gate-"))
  const pluginData = path.join(root, "plugins", "data", "desk-ourostack")
  mkdirSync(pluginData, { recursive: true })
  return { root, pluginData, bindingPath: path.join(pluginData, "desk.activation.json") }
}

// A second, unrelated Claude config dir's plugin-data folder within the same
// fixture root -- `<root>/other-config/plugins/data/desk-ourostack/
// desk.activation.json` -- to prove matching is not tied to any single
// directory: any structurally-shaped path is caught, not just `fixture()`'s
// own `pluginData`.
function otherConfigDirFixture(root) {
  const otherPluginData = path.join(root, "other-config", "plugins", "data", "desk-ourostack")
  mkdirSync(otherPluginData, { recursive: true })
  return { otherPluginData, otherBindingPath: path.join(otherPluginData, "desk.activation.json") }
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

// Review finding (2026-09-28, PR #73): once the session is confirmed
// unattended, an existing target cannot mean a human is driving a rebind --
// a real interactive rebind never reaches this branch (attendance already
// let it through), and an external driver writes from its own shell,
// outside the model. The prior "already bound" exemption allowed exactly
// this shape of write and directly caused this change's own live-proof
// incident. There is no allow path left for an unattended write to a
// structurally-matching file, existing or not.
test("denies the same Write even once a binding already exists (no session can be driving a legitimate rebind while unattended)", async () => {
  const f = fixture()
  try {
    writeFileSync(f.bindingPath, JSON.stringify({ schema_version: 1, desk: { root: "/somewhere" } }))
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: f.bindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
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
    const result = await askGateHook(input, "claude", { ...ATTENDED })
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
      {},
      { CLAUDE_CODE_SESSION_ATTENDED: "" },
      { CLAUDE_CODE_SESSION_ATTENDED: "false" },
      { CLAUDE_CODE_SESSION_ATTENDED: "no" },
    ]) {
      assertAllowed(await askGateHook(input, "claude", env))
    }
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
    const result = await askGateHook(input, "copilot", { ...UNATTENDED })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("ignores tools outside Write/Edit/Bash/PowerShell", async () => {
  const f = fixture()
  try {
    const input = writeInput({ pluginData: f.pluginData, toolName: "Read", toolInput: { file_path: f.bindingPath } })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("denies using the camelCase toolName/toolArgs shape as well as tool_name/tool_input", async () => {
  const f = fixture()
  try {
    const input = {
      session_id: "fixture-session",
      cwd: f.pluginData,
      toolName: "Write",
      toolArgs: { file_path: f.bindingPath, content: "{}" },
    }
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("ignores a call that names no tool at all", async () => {
  const f = fixture()
  try {
    const input = { session_id: "fixture-session", cwd: f.pluginData }
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("resolves an absolute Write file_path even when the hook input carries no cwd at all", async () => {
  const f = fixture()
  try {
    const input = {
      session_id: "fixture-session",
      tool_name: "Write",
      tool_input: { file_path: f.bindingPath, content: "{}" },
    }
    // No `cwd` key at all: writeTargetPath must fall back to process.cwd() internally
    // and still resolve correctly, since file_path itself is already absolute.
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("denies a Write to a different Claude config dir's activation file, structurally shaped like the first but not the same path", async () => {
  const f = fixture()
  try {
    const other = otherConfigDirFixture(f.root)
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: other.otherBindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

// Review finding (2026-09-28, PR #73), repro case 1: a synthetic stdin call
// showed an unattended Write to a different, already-bound activation file
// with a new root was allowed by the prior "already bound" exemption. This
// is exactly the shape of the branch's own live-proof incident. Denied now,
// existing content or not.
test("denies a Write to a different Claude config dir's activation file even when that file already holds a binding", async () => {
  const f = fixture()
  try {
    const other = otherConfigDirFixture(f.root)
    writeFileSync(other.otherBindingPath, JSON.stringify({ schema_version: 1, desk: { root: "/elsewhere" } }))
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: other.otherBindingPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("allows a Write/Edit call whose tool_input carries no usable file_path (cannot resolve a target: fails open)", async () => {
  const f = fixture()
  try {
    const input = writeInput({ pluginData: f.pluginData, toolName: "Write", toolInput: { content: "{}" } })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("ignores a desk.activation.json-named file outside the plugins/data shape (precision: no false positive)", async () => {
  const f = fixture()
  try {
    const strayPath = path.join(f.root, "desk.activation.json")
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Write",
      toolInput: { file_path: strayPath, content: "{}" },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertAllowed(result)
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

// Review finding (2026-09-28, PR #73), repro case 2: a synthetic stdin call
// showed an unattended Bash redirect into a *different* config dir's unbound
// activation file was allowed, because the prior check looked at whether
// this session's own binding existed rather than the command's actual
// target. The gate no longer checks any binding's existence for Bash at
// all -- only the command's own text.
test("denies a Bash command that redirects into a different, unbound config dir's activation file", async () => {
  const f = fixture()
  try {
    const other = otherConfigDirFixture(f.root)
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Bash",
      toolInput: { command: `echo '{"schema_version":1}' > "${other.otherBindingPath}"` },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("allows a chained read-only Bash pipeline over the binding path", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "Bash",
      toolInput: { command: `cat "${f.bindingPath}" | grep root; ls -la "${f.pluginData}"` },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

test("allows a Bash command with no command text at all (cannot inspect: fails open)", async () => {
  const f = fixture()
  try {
    const input = writeInput({ pluginData: f.pluginData, toolName: "Bash", toolInput: {} })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertDenied(result)
  } finally {
    teardown(f.root)
  }
})

test("allows a PowerShell command that only reads the binding path", async () => {
  const f = fixture()
  try {
    const input = writeInput({
      pluginData: f.pluginData,
      toolName: "PowerShell",
      toolInput: { command: `Get-Content -Path "${f.bindingPath}"` },
    })
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
    assertAllowed(result)
  } finally {
    teardown(f.root)
  }
})

// Review finding (2026-09-28, PR #73), item 3: the prior shell pattern let
// several common write-shaped commands past it entirely. Each bypass the
// reviewer named now gets its own regression test.
const shellBypasses = [
  ["sed -i", (target) => `sed -i 's/root/other/' "${target}"`],
  ["perl -i", (target) => `perl -i -pe 's/root/other/' "${target}"`],
  ["python -c", (target) => `python -c "open('${target}','w').write('{}')"`],
  ["node -e", (target) => `node -e "require('fs').writeFileSync('${target}','{}')"`],
  ["rsync", (target) => `rsync -a /tmp/src "${target}"`],
  ["install", (target) => `install -m 644 /tmp/src "${target}"`],
  ["cp", (target) => `cp /tmp/src "${target}"`],
  ["mv", (target) => `mv /tmp/src "${target}"`],
  ["dd if=X of=Y", (target) => `dd if=/tmp/src of="${target}" bs=1`],
]

for (const [name, buildCommand] of shellBypasses) {
  test(`denies a Bash command using ${name} against the binding path`, async () => {
    const f = fixture()
    try {
      const input = writeInput({
        pluginData: f.pluginData,
        toolName: "Bash",
        toolInput: { command: buildCommand(f.bindingPath) },
      })
      const result = await askGateHook(input, "claude", { ...UNATTENDED })
      assertDenied(result)
    } finally {
      teardown(f.root)
    }
  })
}

test("fails open on a malformed tool_input JSON string", async () => {
  const f = fixture()
  try {
    const input = writeInput({ pluginData: f.pluginData, toolName: "Write", toolInput: undefined })
    input.tool_input = "{not json"
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const result = await askGateHook(input, "claude", { ...UNATTENDED })
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
    const env = { ...process.env, ...UNATTENDED }
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
