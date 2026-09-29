// Desk-only enforcement's 6th boot check (spec §5): confirms
// host-enforcement.cjs is actually registered in the running plugin's own
// hooks.json, and surfaces a missing registration as a Desk problem: block
// rather than letting the gap stay silent. A no-op on every host but claude.
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

function fixturePluginRoot(hooksJson) {
  const root = mkdtempSync(path.join(tmpdir(), "desk-host-enforcement-boot-"))
  mkdirSync(path.join(root, "hooks"), { recursive: true })
  if (hooksJson !== null) writeFileSync(path.join(root, "hooks", "hooks.json"), JSON.stringify(hooksJson))
  return root
}

const REGISTERED = { hooks: { PreToolUse: [{ matcher: "AskUserQuestion", hooks: [{ command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/host-enforcement.cjs\" claude" }] }] } }
const UNREGISTERED = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "node \"${CLAUDE_PLUGIN_ROOT}/hooks/protected-checkout.cjs\" claude" }] }] } }

test("host !== claude: the check is a no-op", async () => {
  const line = await runBootChecks({ host: "copilot", env: { PLUGIN_ROOT: "/does-not-matter" }, checks: [hostEnforcementCheck] })
  assert.equal(line, "")
})

test("the real registration in this checkout's own hooks.json passes with no line", async () => {
  const line = await runBootChecks({ host: "claude", env: {}, checks: [hostEnforcementCheck] })
  assert.equal(line, "")
})

test("a missing registration surfaces a Desk problem: host-enforcement block, queues the detached filer, never a thrown error", async () => {
  const root = fixturePluginRoot(UNREGISTERED)
  const launched = []
  try {
    // launchRepair is the same test seam every other check's detached repair already uses: no real
    // process is spawned here, so this stays fast and deterministic regardless of gh, the network or
    // this check's own 20 ms budget -- the point of queuing a repair instead of filing inline.
    const line = await runBootChecks({
      host: "claude", env: { PLUGIN_ROOT: root }, checks: [hostEnforcementCheck],
      launchRepair: async (command, env) => { launched.push({ command, env }) },
    })
    assert.match(line, /Desk problem: host-enforcement/)
    assert.match(line, /file: filing in background/)
    assert.equal(launched.length, 1)
    assert.ok(launched[0].command.some((part) => part.endsWith("file-desk-problem.js")))
    assert.ok(launched[0].command.includes("--mechanism"))
    assert.ok(launched[0].command.includes("host-enforcement"))
    assert.ok(launched[0].command.includes("--reason"))
    assert.ok(launched[0].command.includes("--host"))
    assert.ok(launched[0].command.includes("claude"))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an unreadable hooks.json (no file at all) also surfaces the block, never throws", async () => {
  const root = fixturePluginRoot(null)
  try {
    const line = await runBootChecks({
      host: "claude", env: { PLUGIN_ROOT: root }, checks: [hostEnforcementCheck],
      launchRepair: async () => {},
    })
    assert.match(line, /Desk problem: host-enforcement/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("the check's own run() never launches or awaits the filer itself: it only hands back a repair command, well inside its 20 ms budget", async () => {
  const root = fixturePluginRoot(UNREGISTERED)
  try {
    // run() never invokes any launcher at all -- runBootChecks's own registry loop does that afterward,
    // from the `repair` field run() returns. So even a launcher that would hang forever cannot affect
    // run()'s own timing, proven here by calling it directly with none supplied.
    const startedAt = performance.now()
    const { line, repair } = await hostEnforcementCheck.run({ host: "claude", env: { PLUGIN_ROOT: root } })
    assert.ok(performance.now() - startedAt < 500, "hostEnforcementCheck.run() must resolve on its own, with no launcher involved")
    assert.match(line, /Desk problem: host-enforcement/)
    assert.match(line, /file: filing in background/)
    assert.ok(Array.isArray(repair.command))
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
