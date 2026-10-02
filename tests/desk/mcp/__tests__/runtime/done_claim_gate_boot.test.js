// The done-claim gate watches the task boot resolved from the operator's name: a PostToolUse hook on the shell call that ran `session-boot.js --task` records it as touched
// in the same session file `task_update` uses, so a reply that claims done over it is blocked even when task_update was never called (round S, Claude stress resume-named-task run 2).
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import { bootNamedTask, doneClaimStopHook, recordTouchedTask, sessionFile, touchedTask } from "../../../../../plugins/desk/mcp/src/runtime/done-claim-gate.js"

const hook = path.join(fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url)), "hooks", "done-claim-gate.cjs")
const ROOT = mkdtempSync(path.join(tmpdir(), "done-gate-boot-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = () => path.join(ROOT, `s-${(counter += 1)}`)

const COMMAND = "node /p/plugins/desk/mcp/scripts/session-boot.js --task watering-schedule-api"
const BOOT_TEXT = "Desk boot: ready | desk /d | host h / u / claude | Desk synced with origin\n\nNamed task: greenhouse-ops/watering-schedule-api (processing), card greenhouse-ops/watering-schedule-api/task.md\n\nActive tasks (1):\n"
const BOOT_JSON = JSON.stringify({ status: "ready", task: { status: "resolved", task: { track: "greenhouse-ops", slug: "watering-schedule-api", status: "processing", card: "greenhouse-ops/watering-schedule-api/task.md" } } })
const post = (toolName, command, response, session = "s1") => ({ hook_event_name: "PostToolUse", session_id: session, tool_name: toolName, tool_input: { command }, tool_response: response })
const ROUND_S_REPLY = "## Implementation Complete\n\nI've successfully completed the watering-schedule-api task implementation:\n\n**What's done:**\n- Wired the moisture-sensor threshold check into `RainDelayPolicy.shouldDelay()`\n- All tests pass"
const HONEST = "The watering-schedule-api task is at processing, not done. I wired in the threshold check and its tests pass; the card was not updated because task_update was not called."

function transcript(text) {
  const file = `${fresh()}.jsonl`
  writeFileSync(file, `${JSON.stringify({ type: "user", message: { role: "user", content: "resume watering-schedule-api" } })}\n${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`)
  return file
}
const stop = (stateDir, text) => doneClaimStopHook({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcript(text) }, { stateDir })

test("a boot run that named a task, in text or --json, reads as that task touched at the status the boot printed; anything else reads as nothing", () => {
  const expected = { key: "greenhouse-ops/watering-schedule-api", slug: "watering-schedule-api", status: "processing", reportAs: null, path: "greenhouse-ops/watering-schedule-api/task.md", oldKey: null }
  assert.deepEqual(bootNamedTask("Bash", { command: COMMAND }, BOOT_TEXT), expected)
  assert.deepEqual(bootNamedTask("Bash", { command: `${COMMAND} --json` }, BOOT_JSON), expected)
  assert.deepEqual(touchedTask("bash", { command: COMMAND }, { content: [{ type: "text", text: BOOT_TEXT }] }), expected, "Copilot's shell name and a content-block response")
  assert.equal(bootNamedTask("PowerShell", { command: COMMAND }, BOOT_TEXT).slug, "watering-schedule-api")
  assert.equal(bootNamedTask("Bash", { command: COMMAND }, BOOT_TEXT.replace("(processing)", "(null)")).status, null)
  const none = [
    ["Bash", "node /p/plugins/desk/mcp/scripts/session-boot.js", BOOT_TEXT.replace("Named task: greenhouse-ops/watering-schedule-api (processing), card greenhouse-ops/watering-schedule-api/task.md\n", "")],
    ["Bash", "node /p/plugins/desk/mcp/scripts/session-boot.js", BOOT_TEXT],
    ["Bash", COMMAND, "Named task: matches no open task"],
    ["Bash", COMMAND, "Named task: ambiguous, matches a/b, a/c"],
    ["Bash", COMMAND, JSON.stringify({ task: { status: "not_found" } })],
    ["Bash", COMMAND, "Named task: x/y (processing), card x/y/notes.md"],
    ["Bash", "cat greenhouse-ops/watering-schedule-api/task.md", BOOT_TEXT],
    ["Read", COMMAND, BOOT_TEXT],
    ["Bash", COMMAND, "Named task: x/y (processing), card /task.md"],
    [undefined, undefined, undefined],
  ]
  assert.equal(bootNamedTask("Bash", undefined, BOOT_TEXT), null, "no input at all")
  for (const [name, command, response] of none) assert.equal(bootNamedTask(name, { command }, response), null, `${name} ${command}`)
})

test("the round S reply 'I've successfully completed the watering-schedule-api task implementation' is blocked when the named task is not done, though task_update was never called", () => {
  const stateDir = fresh()
  recordTouchedTask(post("Bash", COMMAND, BOOT_TEXT), { stateDir, root: null })
  const blocked = stop(stateDir, ROUND_S_REPLY)
  assert.equal(blocked.decision, "block")
  assert.match(blocked.reason, /watering-schedule-api/u)
  assert.match(blocked.reason, /processing/u)
})

test("an honest reply that states the real status passes, and the turn is forgotten", () => {
  const stateDir = fresh()
  recordTouchedTask(post("Bash", COMMAND, BOOT_TEXT), { stateDir, root: null })
  assert.deepEqual(stop(stateDir, HONEST), {})
  assert.equal(existsSync(sessionFile(stateDir, "s1")), false)
})

test("when no task was named, or the boot matched none, nothing is recorded and the reply is not gated", () => {
  const stateDir = fresh()
  recordTouchedTask(post("Bash", "node /p/plugins/desk/mcp/scripts/session-boot.js", BOOT_TEXT.replace(/Named task:.*\n/u, "")), { stateDir, root: null })
  recordTouchedTask(post("Bash", COMMAND, "Desk boot: ready\n\nNamed task: matches no open task\n"), { stateDir, root: null })
  recordTouchedTask(post("Bash", "ls", "Named task: a/b (processing), card a/b/task.md"), { stateDir, root: null })
  assert.equal(existsSync(sessionFile(stateDir, "s1")), false)
  assert.deepEqual(stop(stateDir, ROUND_S_REPLY), {})
})

test("a named task that is already done on its card does not gate a reply that says it is done", () => {
  const stateDir = fresh()
  const desk = fresh()
  mkdirSync(path.join(desk, "greenhouse-ops", "watering-schedule-api"), { recursive: true })
  writeFileSync(path.join(desk, "greenhouse-ops", "watering-schedule-api", "task.md"), "---\nstatus: done\n---\n")
  recordTouchedTask(post("Bash", COMMAND, BOOT_TEXT), { stateDir, root: desk })
  assert.deepEqual(stop(stateDir, ROUND_S_REPLY), {})
})

test("the entry points record the boot's named task on Claude (the Bash matcher) and on Copilot (the shell tool), and skip every other shell call", () => {
  const home = fresh()
  mkdirSync(home, { recursive: true })
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: process.env.PATH }
  const stateDir = path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk")
  const run = (host, mode, input) => {
    const result = spawnSync(process.execPath, [hook, host, mode], { input: JSON.stringify(input), env, encoding: "utf8" })
    assert.equal(result.status, 0, result.stderr)
    return JSON.parse(result.stdout)
  }
  assert.deepEqual(run("claude", "track", post("Bash", "ls -la", "x", "c1")), {})
  assert.equal(existsSync(sessionFile(stateDir, "c1")), false, "Claude: another shell call records nothing")
  assert.deepEqual(run("claude", "track", { ...post("Bash", COMMAND, BOOT_TEXT, "c1"), cwd: ROOT }), {})
  assert.equal(existsSync(sessionFile(stateDir, "c1")), true, "Claude: the boot run records the named task")
  const copilot = (toolName, command, session) => ({ sessionId: session, cwd: ROOT, toolName, toolArgs: { command }, toolResult: { resultType: "success", textResultForLlm: BOOT_TEXT } })
  assert.deepEqual(run("copilot", "track", copilot("bash", "ls -la", "p1")), {})
  assert.equal(existsSync(sessionFile(stateDir, "p1")), false, "Copilot: another shell call records nothing")
  assert.deepEqual(run("copilot", "track", copilot("bash", COMMAND, "p1")), {})
  assert.equal(existsSync(sessionFile(stateDir, "p1")), true, "Copilot: the boot run records the named task")
})

test("Claude Code's real Bash tool_response, an object with stdout, stderr and interrupted, is read: the boot's named task is recorded", () => {
  const response = { stdout: BOOT_TEXT, stderr: "", interrupted: false, isImage: false, noOutputExpected: false }
  const expected = { key: "greenhouse-ops/watering-schedule-api", slug: "watering-schedule-api", status: "processing", reportAs: null, path: "greenhouse-ops/watering-schedule-api/task.md", oldKey: null }
  assert.deepEqual(bootNamedTask("Bash", { command: COMMAND }, response), expected)
  assert.deepEqual(bootNamedTask("Bash", { command: "node s/session-boot.js --task foo" }, { stdout: "Named task: trk/x (processing), card trk/x/task.md" }).slug, "x")
  assert.equal(bootNamedTask("Bash", { command: COMMAND }, { output: BOOT_TEXT }).slug, "watering-schedule-api", "a host that names the text `output`")
  assert.equal(bootNamedTask("PowerShell", { command: COMMAND }, response).slug, "watering-schedule-api")
  assert.equal(bootNamedTask("Bash", { command: COMMAND }, { stdout: "", stderr: BOOT_TEXT }), null, "stderr is not the boot's answer")
  const stateDir = fresh()
  recordTouchedTask(post("Bash", COMMAND, response), { stateDir, root: null })
  assert.equal(stop(stateDir, ROUND_S_REPLY).decision, "block")
})

test("the command must actually run session-boot.js with --task: node or the script itself in the program position, in any part of a compound command", () => {
  const yes = [
    "node /p/mcp/scripts/session-boot.js --task x",
    "node \"/p/mcp/scripts/session-boot.js\" --task \"resume x\"",
    "cd /d && node /p/session-boot.js --task x",
    "DESK=/d node --no-warnings /p/session-boot.js --task x | head -80",
    "/usr/local/bin/node /p/session-boot.js --task x",
    "/p/mcp/scripts/session-boot.js --task x",
    "echo hi\nnode /p/session-boot.js --task x",
  ]
  const no = [
    "cat /p/mcp/scripts/session-boot.js --task x",
    "echo session-boot.js --task x",
    "grep -n task session-boot.js",
    "node /p/other.js session-boot.js --task x",
    "node /p/session-boot.js",
    "node /p/session-boot.js --json",
    "ls session-boot.js; echo --task",
  ]
  for (const command of yes) assert.equal(bootNamedTask("Bash", { command }, BOOT_TEXT)?.slug, "watering-schedule-api", command)
  for (const command of no) assert.equal(bootNamedTask("Bash", { command }, BOOT_TEXT), null, command)
})

test("hooks.json watches the PowerShell tool too, and the .cjs answers at once for a PowerShell call that is not the boot", () => {
  const hooks = JSON.parse(readFileSync(path.join(path.dirname(hook), "hooks.json"), "utf8")).hooks
  const group = hooks.PostToolUse.find((entry) => entry.hooks.some((item) => /done-claim-gate\.cjs" claude track$/u.test(item.command)) && !/task_/u.test(entry.matcher))
  const matcher = new RegExp(`^(?:${group.matcher})$`, "u")
  assert.ok(matcher.test("Bash") && matcher.test("PowerShell"))
  assert.equal(matcher.test("Read"), false)
  const home = fresh()
  mkdirSync(home, { recursive: true })
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: process.env.PATH }
  const stateDir = path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk")
  const run = (input) => JSON.parse(spawnSync(process.execPath, [hook, "claude", "track"], { input: JSON.stringify(input), env, encoding: "utf8" }).stdout)
  assert.deepEqual(run({ ...post("PowerShell", "Get-ChildItem", "x", "w1"), cwd: ROOT }), {})
  assert.equal(existsSync(sessionFile(stateDir, "w1")), false)
  assert.deepEqual(run({ ...post("PowerShell", COMMAND, { stdout: BOOT_TEXT, stderr: "", interrupted: false }, "w1"), cwd: ROOT }), {})
  assert.equal(existsSync(sessionFile(stateDir, "w1")), true)
})
