// Claude Code's `UserPromptSubmit` wiring for Desk-only enforcement (spec §5,
// controller ruling 3): the `.cjs` entry point reads the operator's prompt
// for a named denied surface and records it in the session's on-disk
// allowlist, so `host-enforcement.cjs`'s later `PreToolUse` calls can read
// it back -- never blocking or altering the prompt, and never throwing on an
// internal error, the same real-stdin/stdout contract `ask_gate.test.js`
// already covers for its own hook.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { loadSessionAllowlist } from "../../../../../plugins/desk/mcp/src/runtime/naming-allowlist.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "desk-naming.cjs")

function runHookOverStdio(input, env = process.env) {
  const result = spawnSync(process.execPath, [hook, "claude"], { input: JSON.stringify(input), env, encoding: "utf8" })
  return { result, output: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) }
}

test("naming a denied surface in the prompt records it in that session's allowlist, and never blocks the prompt", () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-naming-state-"))
  const env = { ...process.env, XDG_STATE_HOME: stateHome }
  try {
    const { result, output } = runHookOverStdio({ prompt: "go ahead and use an artifact for this", session_id: "s-named-1" }, env)
    assert.equal(result.status, 0)
    assert.deepEqual(output, {})
    assert.ok(loadSessionAllowlist({ env, sessionId: "s-named-1" }).has("artifact"))
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("a negated mention of a surface records nothing", () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-naming-state-"))
  const env = { ...process.env, XDG_STATE_HOME: stateHome }
  try {
    const { result, output } = runHookOverStdio({ prompt: "don't use an artifact for this", session_id: "s-negated" }, env)
    assert.equal(result.status, 0)
    assert.deepEqual(output, {})
    assert.equal(loadSessionAllowlist({ env, sessionId: "s-negated" }).size, 0)
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("a prompt naming nothing leaves the session's allowlist empty", () => {
  const stateHome = mkdtempSync(path.join(tmpdir(), "desk-naming-state-"))
  const env = { ...process.env, XDG_STATE_HOME: stateHome }
  try {
    const { result, output } = runHookOverStdio({ prompt: "just fix the bug please", session_id: "s-unnamed" }, env)
    assert.equal(result.status, 0)
    assert.deepEqual(output, {})
    assert.equal(loadSessionAllowlist({ env, sessionId: "s-unnamed" }).size, 0)
  } finally {
    rmSync(stateHome, { recursive: true, force: true })
  }
})

test("malformed stdin never blocks the prompt: it records nothing and still emits {}", () => {
  const result = spawnSync(process.execPath, [hook, "claude"], { input: "not json", env: process.env, encoding: "utf8" })
  assert.equal(result.status, 0)
  assert.deepEqual(JSON.parse(result.stdout), {})
})

test("a missing session_id records nothing but still emits {} with no error", () => {
  const { result, output } = runHookOverStdio({ prompt: "use plan mode for this" })
  assert.equal(result.status, 0)
  assert.deepEqual(output, {})
})
