// desk_status reports whether Claude Code's Desk-only enforcement hook is
// actually registered (spec §5's "closed instead by desk_status and the boot
// checks verifying ... and reporting a missing registration through the
// failure contract as a Desk problem: block").
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { desk_status } from "../../../../../plugins/desk/mcp/src/tools/status.js"

function fixturePluginRoot(hooksJson) {
  const root = mkdtempSync(path.join(realpathSync(tmpdir()), "status-host-enforcement-"))
  mkdirSync(path.join(root, "hooks"), { recursive: true })
  if (hooksJson !== null) writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify(hooksJson))
  return root
}

const REGISTERED = { hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/host-enforcement.cjs\" claude" }] }] } }
const UNREGISTERED = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/protected-checkout.cjs\" claude" }] }] } }

function makeDeskRoot() {
  return mkdtempSync(path.join(realpathSync(tmpdir()), "desk-status-host-enforcement-"))
}

test("desk_status reports host_enforcement.registered true when the hook is wired in", async (t) => {
  const deskRoot = makeDeskRoot()
  const pluginRoot = fixturePluginRoot(REGISTERED)
  t.after(() => { rmSync(deskRoot, { recursive: true, force: true }); rmSync(pluginRoot, { recursive: true, force: true }) })
  const body = await desk_status({ deskRoot, env: { CLAUDE_PLUGIN_ROOT: pluginRoot, DESK_PLUGIN_ROOT: pluginRoot } })
  assert.deepEqual(body.host_enforcement, { registered: true })
})

test("desk_status reports host_enforcement.registered false with a Desk problem: block when the hook is missing, and never makes a real network call filing it", async (t) => {
  const deskRoot = makeDeskRoot()
  const pluginRoot = fixturePluginRoot(UNREGISTERED)
  t.after(() => { rmSync(deskRoot, { recursive: true, force: true }); rmSync(pluginRoot, { recursive: true, force: true }) })
  // PATH: "" makes the real filer's real gh runner fail instantly with "no gh binary found" (ENOENT), the same
  // technique the filer's own tests use, so this never reaches the network even though a real env is passed.
  const body = await desk_status({ deskRoot, env: { CLAUDE_PLUGIN_ROOT: pluginRoot, DESK_PLUGIN_ROOT: pluginRoot, PATH: "" } })
  assert.equal(body.host_enforcement.registered, false)
  assert.match(body.host_enforcement.desk_problem, /^Desk problem: host-enforcement — /)
  assert.match(body.host_enforcement.desk_problem, /file: not filed: no_suitable_account/)
})

test("desk_status reports host_enforcement: null for a host this check does not cover (no CLAUDE_PLUGIN_ROOT set)", async (t) => {
  const deskRoot = makeDeskRoot()
  t.after(() => rmSync(deskRoot, { recursive: true, force: true }))
  const body = await desk_status({ deskRoot, env: {} })
  assert.equal(body.host_enforcement, null)
})
