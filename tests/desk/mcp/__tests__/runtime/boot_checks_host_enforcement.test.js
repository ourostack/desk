// Desk-only enforcement's 6th boot check (spec §5): confirms
// host-enforcement.cjs is actually registered in the running plugin's own
// hooks.json (Claude Code) or copilot-hooks.json (Copilot -- copilot-
// session-start.cjs runs this same registry with host: "copilot" literally,
// the same way session-start.sh runs it with host: "claude"), and surfaces a
// missing registration as a Desk problem: block rather than letting the gap
// stay silent. A no-op on every other host: Codex has no boot-check or
// session-start hook wired in Desk at all today (Part 8, docs/host-
// enforcement-live-proof.md), so its own "registered but not active" story
// is told by `desk_status`/host-enforcement-registration.js directly, not by
// this hook-driven registry.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"

const require = createRequire(import.meta.url)
const BOOT = fileURLToPath(new URL("../../../../../plugins/desk/hooks/boot-checks.cjs", import.meta.url))
const { hostEnforcementCheck, runBootChecks } = require(BOOT)

function fixturePluginRoot(hooksJson, fileName = "hooks.json") {
  const root = mkdtempSync(path.join(tmpdir(), "desk-host-enforcement-boot-"))
  mkdirSync(path.join(root, "hooks"), { recursive: true })
  if (hooksJson !== null) writeFileSync(path.join(root, "hooks", fileName), JSON.stringify(hooksJson))
  return root
}

const REGISTERED = { hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/host-enforcement.cjs\" claude" }] }] } }
const UNREGISTERED = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/protected-checkout.cjs\" claude" }] }] } }
const REGISTERED_COPILOT = { hooks: { preToolUse: [{ type: "command", bash: "node \"${PLUGIN_ROOT}/hooks/host-enforcement.cjs\" copilot" }] } }
const UNREGISTERED_COPILOT = { hooks: { preToolUse: [{ type: "command", bash: "node \"${PLUGIN_ROOT}/hooks/protected-checkout.cjs\" copilot" }] } }

test("host is neither claude nor copilot: the check is a no-op (Codex has no boot-check registry wired at all)", async () => {
  const line = await runBootChecks({ host: "codex", env: { PLUGIN_ROOT: "/does-not-matter" }, checks: [hostEnforcementCheck] })
  assert.equal(line, "")
})

test("the real registration in this checkout's own hooks.json passes with no line", async () => {
  const line = await runBootChecks({ host: "claude", env: {}, checks: [hostEnforcementCheck] })
  assert.equal(line, "")
})

test("the real registration in this checkout's own copilot-hooks.json passes with no line", async () => {
  const line = await runBootChecks({ host: "copilot", env: {}, checks: [hostEnforcementCheck] })
  assert.equal(line, "")
})

test("Copilot: a missing registration surfaces a Desk problem: host-enforcement block, never a thrown error", async () => {
  const root = fixturePluginRoot(UNREGISTERED_COPILOT, "copilot-hooks.json")
  try {
    const line = await runBootChecks({ host: "copilot", env: { PLUGIN_ROOT: root }, checks: [hostEnforcementCheck] })
    assert.match(line, /Desk problem: host-enforcement/)
    assert.match(line, /file: not filed: filer_unavailable/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("Copilot: a present registration under a fixture plugin root produces no line", async () => {
  const root = fixturePluginRoot(REGISTERED_COPILOT, "copilot-hooks.json")
  try {
    const line = await runBootChecks({ host: "copilot", env: { PLUGIN_ROOT: root }, checks: [hostEnforcementCheck] })
    assert.equal(line, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a missing registration surfaces a Desk problem: host-enforcement block, never a thrown error", async () => {
  const root = fixturePluginRoot(UNREGISTERED)
  try {
    const line = await runBootChecks({ host: "claude", env: { PLUGIN_ROOT: root }, checks: [hostEnforcementCheck] })
    assert.match(line, /Desk problem: host-enforcement/)
    assert.match(line, /file: not filed: filer_unavailable/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an unreadable hooks.json (no file at all) also surfaces the block, never throws", async () => {
  const root = fixturePluginRoot(null)
  try {
    const line = await runBootChecks({ host: "claude", env: { PLUGIN_ROOT: root }, checks: [hostEnforcementCheck] })
    assert.match(line, /Desk problem: host-enforcement/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("a present registration under a fixture plugin root produces no line", async () => {
  const root = fixturePluginRoot(REGISTERED)
  try {
    const line = await runBootChecks({ host: "claude", env: { PLUGIN_ROOT: root }, checks: [hostEnforcementCheck] })
    assert.equal(line, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
