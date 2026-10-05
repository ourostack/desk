// The process-kill guard (incident 2026-10-02: `pkill -f "cat" -U $(id -u) -n` killed ~100 of the operator's processes,
// including 8 Claude Code and 2 Copilot sessions). The guard is judged as a function and as a hook on payloads; no test
// runs pkill, pgrep or killall.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { assertActionable } from "./_guard_text.js"
import { judgeCall, judgeProcessKill, judgeWindows, MESSAGES, processKillGuardHook } from "../../../../../plugins/desk/mcp/src/runtime/process-kill-guard.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "process-kill-guard.cjs")
const sh = (command) => judgeProcessKill(command)
const ps = (command) => judgeProcessKill(command, { powershell: true })

test("the incident command is denied as the BSD option trap, with $(id -u) and with 502", async () => {
  assert.equal(await sh('pkill -f "cat" -U $(id -u) -n'), MESSAGES.trap)
  assert.equal(await sh('pkill -f "cat" -U 502 -n'), MESSAGES.trap)
  assert.equal(await sh("pgrep -f cat -U $(id -u) -n"), MESSAGES.trap)
  assert.equal(await sh("pgrep -f cat -U 502 -n"), MESSAGES.trap)
  assert.equal(await sh("killall Foobarbaz -9"), MESSAGES.trap)
  assert.equal(await sh("pkill -f long-specific-pattern -9"), MESSAGES.trap)
})

test("a late option is caught whatever shape the option before it has", async () => {
  assert.equal(await sh("pkill -fU 502 long-specific-pattern -n"), MESSAGES.trap, "a cluster ending in a value option")
  assert.equal(await sh("pkill -U502 long-specific-pattern -n"), MESSAGES.trap, "an attached value")
  assert.equal(await sh("pkill --uid 502 long-specific-pattern --newest"), MESSAGES.trap, "a long option with a separate value")
  assert.equal(await sh("pkill --uid=502 long-specific-pattern --newest"), MESSAGES.trap)
  assert.equal(await sh("pkill -TERM long-specific-pattern -n"), MESSAGES.trap, "a signal name")
})

test("a short or generic pattern is denied, a long specific one is allowed", async () => {
  for (const command of ["pkill -f ''", "pkill -f cat", "pkill -f node", "pkill -f claude", "pkill -f 'python3'", "pkill -f ^bash$", "pkill -f short", "pkill -f long-specific-pattern cat", "pkill sleep", "killall node", "killall Claude Chrome.exe"]) {
    assert.equal(await sh(command), MESSAGES.broad, command)
  }
  for (const command of [
    "pkill -f long-specific-pattern", "pkill -9 -f 'my-hung-server --port 8123'", "pkill -U 502 -f long-specific-pattern", "pkill -f -- long-specific-pattern", "pgrep -f long-specific-pattern",
    "pgrep -f cat", "pgrep -U 502 -f cat", "killall Foobarbaz", "pkill", "killall", "ls -n", "pkillx -f cat -n",
  ]) {
    assert.equal(await sh(command), null, command)
  }
})

test("kill of a process group taken from a pattern is denied, a numeric pid list is allowed", async () => {
  for (const command of ["kill -9 -1", "kill 0", "kill -TERM 0", "kill -- -1", "kill -s KILL -1", "kill -9 123 -456", "kill -n 9 0", "kill -9 -- -1", "kill 123 0"]) {
    assert.equal(await sh(command), MESSAGES.group, command)
  }
  for (const command of ["kill 123", "kill 123 456 789", "kill -TERM 123", "kill -9 123", "kill -s TERM 123", "kill -l", "kill -1", "kill -L 9", "kill", "kill -- 123", "kill -9 -- 123 456"]) {
    assert.equal(await sh(command), null, command)
  }
})

test("kill fed by a pgrep that would be denied is denied, in every spelling", async () => {
  for (const command of [
    "kill $(pgrep -f cat)", "kill -9 `pgrep node`", "pgrep -f cat | xargs kill", "pgrep -f cat -U 502 | xargs kill -9", "kill -9 $(pgrep -f cat -U $(id -u) -n)", "sudo pkill -f cat", "sudo -u root pkill -f long-specific-pattern -n",
    "env X=1 pkill node", "xargs -n1 pkill cat", "/usr/bin/pkill -f cat", "command killall node", "nohup pkill claude",
  ]) {
    assert.notEqual(await sh(command), null, command)
  }
  for (const command of ["kill $(pgrep -f long-specific-pattern)", "pgrep -f long-specific-pattern | xargs kill", "sudo kill 123", "sudo ls", "env X=1 true", "xargs echo hi"]) {
    assert.equal(await sh(command), null, command)
  }
})

test("compound commands, bash -c, subshells and groups are inspected", async () => {
  for (const command of [
    'echo go && pkill -f "cat" -U 502 -n', "true; pkill -f cat", "false || killall node", 'bash -c "pkill -f cat -U 502 -n"', "sh -c 'kill -9 -1'", "(pkill -f claude)", "{ pkill -f claude; }", "if true; then pkill -f cat; fi",
    "bash -c \"bash -c 'pkill -f cat'\"", 'echo "$(pkill -f cat)"', "pkill -f cat &",
  ]) {
    assert.notEqual(await sh(command), null, command)
  }
  assert.equal(await sh('echo "pkill -f cat -n"'), null, "quoted text is data")
  assert.equal(await sh("echo go && pkill -f long-specific-pattern"), null)
  assert.equal(await sh("git status | grep pkill"), null)
})

test("PowerShell: Stop-Process, taskkill and Get-Process pipes", async () => {
  for (const command of [
    "Stop-Process -Name node", "Stop-Process -Name node,python -Force", "Stop-Process -Name 'chrome.exe'", "spps -name claude", "Stop-Process -Force -Name node", "taskkill /IM node.exe /F", "taskkill /F /im Code.exe", "taskkill.exe -IM copilot.exe",
    "Get-Process | Stop-Process", "Get-Process node* | Stop-Process", "Get-Process -Name *claude* | Stop-Process -Force", "gps node | spps", "Get-Process -Name node | Stop-Process", "Stop-Process -Name *", "Stop-Process -Name c*", "Stop-Process -Name node*", "taskkill /IM * /F",
    "Write-Host hi; Stop-Process -Name node",
  ]) {
    assert.equal(await ps(command), MESSAGES.windows, command)
  }
  for (const command of ["Stop-Process -Id 1234", "Stop-Process -Id 1234 -Force", "taskkill /PID 1234 /F", "taskkill /IM my-hung-server.exe", "Stop-Process -Name my-hung-server", "Get-Process -Id 1234 | Stop-Process", "Get-Process my-hung-server | Stop-Process", "Get-Process node", "Get-Process | Format-Table", "Write-Host kill"]) {
    assert.equal(await ps(command), null, command)
  }
  assert.equal(await sh("taskkill /IM node.exe /F"), MESSAGES.windows, "the same Windows tools from a Bash shell")
  assert.equal(judgeWindows("Stop-Process -Name node"), MESSAGES.windows)
})

test("anything the guard cannot read is allowed", async () => {
  assert.equal(await sh("pkill -f cat `"), null, "an unterminated substitution the inspector cannot read")
  assert.equal(await judgeProcessKill(undefined), null)
  assert.equal(await judgeProcessKill(42), null)
  assert.equal(judgeCall("sudo", []), null)
})

test("every denial opens with the fix in at most 120 characters", () => {
  for (const [key, text] of Object.entries(MESSAGES)) {
    assertActionable(assert, text, key)
    assert.match(text, /^Stop it by exact PID instead: find it with `/u)
  }
  assert.match(MESSAGES.trap, /BSD/u)
  assert.match(MESSAGES.broad, /operator's other Claude and Copilot sessions/u)
})

const claude = (toolName, command, extra = {}) => ({ hook_event_name: "PreToolUse", tool_name: toolName, tool_input: { command }, cwd: process.cwd(), ...extra })
const copilot = (toolName, command) => ({ sessionId: "s1", timestamp: 1790000000000, cwd: process.cwd(), toolName, toolArgs: JSON.stringify({ command }) })

test("the hook function answers in each host's shape", async () => {
  const incident = 'pkill -f "cat" -U $(id -u) -n'
  const denied = await processKillGuardHook(claude("Bash", incident), "claude")
  assert.equal(denied.hookSpecificOutput.hookEventName, "PreToolUse")
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny")
  assert.equal(denied.hookSpecificOutput.permissionDecisionReason, MESSAGES.trap)
  assert.deepEqual(await processKillGuardHook(copilot("bash", incident), "copilot"), { permissionDecision: "deny", permissionDecisionReason: MESSAGES.trap })
  assert.equal((await processKillGuardHook(claude("PowerShell", "Stop-Process -Name node"), "claude")).hookSpecificOutput.permissionDecisionReason, MESSAGES.windows)
  assert.equal((await processKillGuardHook(copilot("powershell", "taskkill /IM node.exe"), "copilot")).permissionDecision, "deny")
  assert.deepEqual(await processKillGuardHook(claude("Bash", "kill 123"), "claude"), {})
  assert.deepEqual(await processKillGuardHook(claude("Bash", "pkill -f long-specific-pattern"), "claude"), {})
  assert.deepEqual(await processKillGuardHook(copilot("bash", "kill -TERM 123"), "copilot"), {})
  assert.deepEqual(await processKillGuardHook(claude("Write", "pkill -f cat"), "claude"), {}, "a tool that is not a shell is not judged")
  assert.deepEqual(await processKillGuardHook(copilot("view", "pkill -f cat"), "copilot"), {})
  assert.deepEqual(await processKillGuardHook({ tool_name: "Bash", tool_input: { command: "pkill -f cat" } }, "claude").then((r) => Object.keys(r)), ["hookSpecificOutput"], "the folder defaults to the process's own")
  assert.deepEqual(await processKillGuardHook({}, "claude"), {})
})

const run = (host, payload, raw) => spawnSync(process.execPath, [hook, host], { input: raw ?? JSON.stringify(payload), encoding: "utf8" })

test("the hook script denies on Claude and Copilot, allows other commands, and fails open", () => {
  const claudeDeny = run("claude", claude("Bash", 'pkill -f "cat" -U 502 -n'))
  assert.equal(claudeDeny.status, 0)
  assert.equal(JSON.parse(claudeDeny.stdout).hookSpecificOutput.permissionDecision, "deny")
  const copilotDeny = run("copilot", copilot("bash", "kill -9 -1"))
  assert.equal(copilotDeny.status, 0)
  assert.deepEqual(JSON.parse(copilotDeny.stdout), { permissionDecision: "deny", permissionDecisionReason: MESSAGES.group })
  for (const host of ["claude", "copilot"]) {
    const plain = run(host, host === "claude" ? claude("Bash", "git status") : copilot("bash", "git status"))
    assert.deepEqual([plain.status, plain.stdout], [0, "{}\n"], "a command with no kill word is answered without loading the guard")
    const allowed = run(host, host === "claude" ? claude("Bash", "pkill -f long-specific-pattern") : copilot("bash", "pkill -f long-specific-pattern"))
    assert.deepEqual([allowed.status, allowed.stdout], [0, "{}\n"])
  }
  // Fail open: a payload that names a kill command but is not JSON.
  const brokenClaude = run("claude", null, "pkill not json")
  assert.equal(brokenClaude.status, 1, "Claude blocks only on exit code 2")
  assert.match(brokenClaude.stderr, /could not inspect this call, allowing it/u)
  const brokenCopilot = run("copilot", null, "pkill not json")
  assert.deepEqual([brokenCopilot.status, brokenCopilot.stdout], [0, "{}\n"])
})

test("both hook manifests wire the guard on shell tools", async () => {
  const { readFileSync } = await import("node:fs")
  const claudeHooks = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).hooks.PreToolUse
  const entry = claudeHooks.find((item) => item.hooks.some((h) => h.command.includes("process-kill-guard.cjs")))
  assert.equal(entry.matcher, "Bash|PowerShell")
  const copilotHooks = JSON.parse(readFileSync(path.join(plugin, "hooks", "copilot-hooks.json"), "utf8")).hooks.preToolUse
  assert.ok(copilotHooks.some((item) => item.bash.includes("process-kill-guard.cjs\" copilot") && item.powershell.includes("process-kill-guard.cjs\" copilot")))
})
