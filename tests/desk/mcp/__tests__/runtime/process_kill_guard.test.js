// The process-kill guard (incident 2026-10-02: `pkill -f "cat" -U $(id -u) -n` killed ~100 of the operator's processes,
// including 8 Claude Code and 2 Copilot sessions). The guard is judged as a function and as a hook on payloads; no test
// runs pkill, pgrep or killall.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { assertActionable } from "./_guard_text.js"
import { judgeCall, judgeProcessKill, MESSAGES, processKillGuardHook } from "../../../../../plugins/desk/mcp/src/runtime/process-kill-guard.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "process-kill-guard.cjs")
const sh = (command) => judgeProcessKill(command)
const ps = (command) => judgeProcessKill(command)
const SPECIFIC = "/Users/x/code/project/server.js"

test("the incident command is denied as the BSD option trap, with $(id -u) and with 502", async () => {
  assert.equal(await sh('pkill -f "cat" -U $(id -u) -n'), MESSAGES.trap)
  assert.equal(await sh('pkill -f "cat" -U 502 -n'), MESSAGES.trap)
  assert.equal(await sh("pgrep -f cat -U $(id -u) -n"), MESSAGES.trap)
  assert.equal(await sh("pgrep -f cat -U 502 -n"), MESSAGES.trap)
  assert.equal(await sh(`pkill -f ${SPECIFIC} -9`), MESSAGES.trap)
})

test("a late option is caught whatever shape the option before it has", async () => {
  assert.equal(await sh(`pkill -fU 502 ${SPECIFIC} -n`), MESSAGES.trap, "a cluster ending in a value option")
  assert.equal(await sh(`pkill -U502 ${SPECIFIC} -n`), MESSAGES.trap, "an attached value")
  assert.equal(await sh(`pkill --uid 502 ${SPECIFIC} --newest`), MESSAGES.trap, "a long option with a separate value")
  assert.equal(await sh(`pkill --uid=502 ${SPECIFIC} --newest`), MESSAGES.trap)
  assert.equal(await sh(`pkill -TERM ${SPECIFIC} -n`), MESSAGES.trap, "a signal name")
})

test("every reviewed bypass is denied", async () => {
  const denied = {
    broad: ["kill $(pgrep -f cat)", "kill -9 `pgrep node`", "kill $(pgrep -f /Users/x/a/b.js; pgrep -f cat)", "kill -9 $(pgrep -u 502)", "pkill -u 502", "pkill -U 502", "pkill -g 20", "pkill -t ttys001 x", "pkill -s 1", "pkill --uid 502", "pkill", "pkill -f 'claude.*'", 'pkill -f "Claude Helper"', 'pkill -f "node server"', "pkill -f cat", "pkill -f ''", "pkill -f /usr/bin/node", "pkill -f /usr/bin/", "pkill -f /Users/x/.*", 'pkill -f "cat foo"', `pkill -f ${SPECIFIC} second`, "pkill -P abc", "pkill -P 12 extra", "sudo pkill -f cat", "env X=1 pkill node", "/usr/bin/pkill -f cat", "nohup pkill claude", "xargs -n1 pkill cat", "pgrep -f cat | xargs kill", "pgrep -u 502 | xargs kill -9"],
    killall: ["killall node", "killall -u microsoft", "killall -m '.*'", 'killall "Microsoft Edge"', "killall5", "killall Finder", "killall Foobarbaz", "command killall node", "killall"],
    source: ["$(which pkill) -f cat", "`which pkill` -f cat", "kill -9 $(ps aux | grep claude | awk '{print $2}')", "ps aux | xargs kill -9", "pgrep -f /Users/x/a/b.js | grep x | xargs kill", "kill foo", "kill $(ps -ax)", "ps aux | awk '{print $2}' | xargs kill"],
    group: ["kill -9 -1", "kill 0", "kill -TERM 0", "kill -- -1", "kill -s KILL -1", "kill -9 123 -456", "kill -n 9 0", "kill -9 -- -1", "kill 123 0", "kill -- -$$", "kill -9 -$(echo 1)", "kill -9 -$X"],
    script: ['python3 -c "import os,signal; os.kill(-1, 9)"', 'node -e "process.kill(-1)"', 'node -e "process.kill(0)"', 'python3 -c "import os; os.killpg(1, 9)"'],
    quit: ["osascript -e 'quit app \"cmux\"'", "osascript -e 'tell application \"Finder\" to quit'"],
    windows: ["Stop-Process -Name node", "Stop-Process -ProcessName node", "Stop-Process -Name node,python -Force", "spps -name claude", "Stop-Process -Force -Name node", "Stop-Process", "Stop-Process -InputObject $p", "Stop-Process -Id $x",
      "taskkill /IM node.exe /F", "taskkill /F /FI \"USERNAME eq ari\"", "taskkill.exe -IM copilot.exe", "taskkill /PID abc", "taskkill /PID", "taskkill", "taskkill /F", "cmd /c taskkill /IM node.exe",
      "Get-Process | Stop-Process", "Get-Process node* | Stop-Process", "Get-Process | Where-Object { $_.CPU -gt 1 } | Stop-Process", "(Get-Process node) | Stop-Process", "gps node | spps", "Get-Process node | ForEach-Object { $_.Kill() }", "Get-Process | kill",
      "wmic process where name='node.exe' delete", "wmic process where name='node.exe' call terminate", "Get-CimInstance Win32_Process | Invoke-CimMethod -MethodName Terminate", "Write-Host hi; Stop-Process -Name node", "if ($x) { Stop-Process -Name node }"],
  }
  for (const [kind, commands] of Object.entries(denied)) {
    for (const command of commands) assert.equal(await sh(command), MESSAGES[kind], `${kind}: ${command}`)
  }
})

test("the safe shapes are allowed", async () => {
  for (const command of [
    "kill 123", "kill 123 456 789", "kill -9 123 456", "kill -TERM 123", "kill -s TERM 123", "kill -n 9 123", "kill -- 123", "kill -9 -- 123 456", "kill %1", "kill -9 %2", "kill -l", "kill -L 9", "kill", "kill -1", "sleep 5 & kill $!", "sudo kill 123", "sudo ls", "env X=1 true", "xargs echo hi",
    `pkill -f ${SPECIFIC}`, `pkill -9 -f ${SPECIFIC}`, `pkill -f -- ${SPECIFIC}`, `pkill -f "node ${SPECIFIC}"`, `pkill -x -f ${SPECIFIC}`, "pkill -P 123", "pkill -9 -P 123", "pkill -P123", "pkill -f ~/code/app/server.js", "pkill -f ./bin/my-server",
    `pgrep -f ${SPECIFIC} | xargs kill`, `kill $(pgrep -f ${SPECIFIC})`, `kill -9 $(pgrep -f ${SPECIFIC})`,
    "lsof -t -i :3000 | xargs kill", "kill $(lsof -t -i :3000)", "kill -9 $(lsof -ti:8080)", "lsof -ti tcp:3000 | xargs kill -9",
    "pgrep -f cat", "pgrep -U 502 -f cat", "pgrep -fl node", "ps aux", "ps -axo pid,command | grep server", "lsof -i :3000", "lsof -t -i :3000", "pgrep node | head",
    "grep -n pkill README.md", 'echo "don\'t run pkill"', 'git commit -m "fix pkill guard"', "man pkill", "man killall", "man taskkill", "which pkill", "echo kill", "$(date) ; kill 123", "echo $(date) && kill 5", "git status",
    "Stop-Process -Id 123", "Stop-Process -Id 123,456 -Force", "Stop-Process 123", "spps -Id 5 -Confirm:$false", "taskkill /PID 123", "taskkill /PID 123 /F", "taskkill /F /T /PID 123 /PID 456", "Get-Process node", "Get-Process | Format-Table", "Write-Host kill", "Stop-Process -Id 5 | Out-Null",
  ]) {
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
  assert.equal(await sh(`echo go && pkill -f ${SPECIFIC}`), null)
  assert.equal(await sh("git status | grep pkill"), null)
  assert.equal(await sh(`bash -c "pkill -f ${SPECIFIC}"`), null)
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
  assert.deepEqual(await processKillGuardHook(claude("Bash", `pkill -f ${SPECIFIC}`), "claude"), {})
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
    const allowed = run(host, host === "claude" ? claude("Bash", `pkill -f ${SPECIFIC}`) : copilot("bash", `pkill -f ${SPECIFIC}`))
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
