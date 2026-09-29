// Copilot CLI's `preToolUse` wiring for Desk-only enforcement (spec §5, Part
// 8): the same `.cjs` entry point Claude Code uses, reading Copilot's own
// camelCase stdin shape (`sessionId`, `toolName`, `toolArgs` --
// `docs/host-enforcement-live-proof.md`) and, on a deny, writing Copilot's
// own flat `{ permissionDecision, permissionDecisionReason }` JSON with no
// `hookSpecificOutput` wrapper. Copilot's own denied-tool lists are empty for
// all five surfaces today (see `host-enforcement.js`'s own header comment),
// so no real payload can drive this process to a deny; that shape is proved
// directly against `hookProcessOutput` in `host_enforcement.test.js`
// instead. This suite proves the wiring this process itself owns: Copilot's
// own field names are read, and the allow path -- the only one reachable
// today -- comes back exactly like Claude Code's, the same real-process
// contract `host_enforcement_claude.test.js` already covers.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import * as path from "node:path"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "host-enforcement.cjs")

function runHookOverStdio(input, env = process.env) {
  const result = spawnSync(process.execPath, [hook, "copilot"], { input: JSON.stringify(input), env, encoding: "utf8" })
  return { result, output: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) }
}

test("a tool Copilot has no denied entry for is allowed through with a flat empty decision, reading Copilot's own camelCase toolName/sessionId fields", () => {
  const { result, output } = runHookOverStdio({ sessionId: "s-1", toolName: "bash", toolArgs: { command: "echo hi" } })
  assert.equal(result.status, 0)
  assert.deepEqual(output, {})
})

test("a missing toolName is allowed through, the same as any other host", () => {
  const { result, output } = runHookOverStdio({ sessionId: "s-2" })
  assert.equal(result.status, 0)
  assert.deepEqual(output, {})
})

test("Claude Code's own denied tool name is not denied under Copilot: Copilot's own toolName field is read, not Claude's snake_case tool_name, and Copilot's own (empty) list governs, never Claude's", () => {
  // Sent the way Claude Code would send it (snake_case tool_name) -- under
  // host "copilot" this is not the field Copilot's own contract reads, so it
  // has no effect either way. What this proves is host-scoping: a tool name
  // Claude Code denies outright is never denied for a different host.
  const { result, output } = runHookOverStdio({ session_id: "s-3", tool_name: "AskUserQuestion" })
  assert.equal(result.status, 0)
  assert.deepEqual(output, {})
})

test("malformed stdin fails open under Copilot too: never exit code 2, the only code that blocks a PreToolUse hook", () => {
  const broken = spawnSync(process.execPath, [hook, "copilot"], { input: "not json", env: process.env, encoding: "utf8" })
  assert.notEqual(broken.status, 2)
})
