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
import { pendingLaunchTimes } from "../../../../../plugins/desk/mcp/src/factory/filer-launch.js"
import { runFileDeskProblemCli } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-file.js"
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

test("Copilot: a present registration under a fixture plugin root produces no line", async () => {
  const root = fixturePluginRoot(REGISTERED_COPILOT, "copilot-hooks.json")
  try {
    const line = await runBootChecks({ host: "copilot", env: { PLUGIN_ROOT: root, HOME: root }, checks: [hostEnforcementCheck] })
    assert.equal(line, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

for (const [host, unregistered, fileName] of [["claude", UNREGISTERED, "hooks.json"], ["copilot", UNREGISTERED_COPILOT, "copilot-hooks.json"]]) {
  test(`${host}: a missing registration surfaces a Desk problem: host-enforcement block, queues the detached filer, never a thrown error`, async () => {
    const root = fixturePluginRoot(unregistered, fileName)
    const launched = []
    try {
      // launchRepair is the same test seam every other check's detached repair already uses: no real
      // process is spawned here, so this stays fast and deterministic regardless of gh, the network or
      // this check's own 20 ms budget -- the point of queuing a repair instead of filing inline.
      const line = await runBootChecks({
        host, env: { PLUGIN_ROOT: root, HOME: root }, checks: [hostEnforcementCheck],
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
      assert.ok(launched[0].command.includes(host))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
}

test("an unreadable hooks.json (no file at all) also surfaces the block, never throws", async () => {
  const root = fixturePluginRoot(null)
  try {
    const line = await runBootChecks({
      host: "claude", env: { PLUGIN_ROOT: root, HOME: root }, checks: [hostEnforcementCheck],
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
    const { line, repair } = await hostEnforcementCheck.run({ host: "claude", env: { PLUGIN_ROOT: root, HOME: root } })
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
    const line = await runBootChecks({ host: "claude", env: { PLUGIN_ROOT: root, HOME: root }, checks: [hostEnforcementCheck] })
    assert.equal(line, "")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("review round 2, M5: a launch writes a pending stamp first, so a filer that never starts reads as a drop; the next boot within the hour does not launch again; the filer clears it", async () => {
  const root = fixturePluginRoot(UNREGISTERED)
  const env = { PLUGIN_ROOT: root, HOME: root }
  try {
    const first = await hostEnforcementCheck.run({ host: "claude", env })
    assert.ok(Array.isArray(first.repair.command))
    // The repair was never launched: the stamp written before it stays pending.
    assert.equal(pendingLaunchTimes(env).length, 1)
    const again = await hostEnforcementCheck.run({ host: "claude", env })
    assert.equal(again.repair, undefined)
    assert.match(again.line, /file: filing already queued \(within the last hour\)/)
    // The filer runs with the arguments the repair carries (it cannot file here) and clears the stamp.
    const argv = first.repair.command.slice(first.repair.command.indexOf("--mechanism"))
    assert.equal(await runFileDeskProblemCli({ argv, env: { ...env, PATH: "" } }), 0)
    assert.deepEqual(pendingLaunchTimes(env), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
