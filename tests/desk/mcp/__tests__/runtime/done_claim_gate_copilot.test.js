// The done-claim gate on Copilot CLI: postToolUse tracks the task tools, userPromptSubmitted starts a turn, and agentStop (main agent only, `{ decision: "block", reason }`) judges the reply, which is read from the session transcript.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { copilotStopHook, recordTouchedTask, sessionFile } from "../../../../../plugins/desk/mcp/src/runtime/done-claim-gate.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "done-claim-gate.cjs")
const ROOT = mkdtempSync(path.join(tmpdir(), "done-gate-copilot-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const fresh = (name) => path.join(ROOT, `${name}-${(counter += 1)}`)

const REPORT = "Task watering-schedule-api is at processing (not done): Open a pull request"
const RESULT = JSON.stringify({ status: "updated", path: "greenhouse-ops/watering-schedule-api/task.md", report_as: REPORT })
const event = (type, data = {}) => JSON.stringify({ type, data })
const reply = (content, toolRequests = []) => event("assistant.message", { content, toolRequests })
function transcript(...lines) {
  const file = fresh("events") + ".jsonl"
  writeFileSync(file, `${lines.join("\n")}\n`)
  return file
}
function touched() {
  const stateDir = fresh("state")
  recordTouchedTask({ session_id: "s1", tool_name: "mcp__desk__task_update", tool_input: { track: "greenhouse-ops", slug: "watering-schedule-api" }, tool_response: RESULT }, { stateDir, root: null })
  return stateDir
}
const stop = (stateDir, file, extra = {}) => copilotStopHook({ sessionId: "s1", transcriptPath: file, stopReason: "end_turn", stop_hook_active: false, ...extra }, { stateDir, waitMs: 0 })

test("a reply that says done over a task left at processing is blocked, with a reason Copilot feeds back", async () => {
  const stateDir = touched()
  const result = await stop(stateDir, transcript(event("user.message"), reply("Done. The work is complete.")))
  assert.equal(result.decision, "block")
  assert.match(result.reason, /task watering-schedule-api is at processing/u)
  assert.match(result.reason, /report_as/u)
})

test("a reply that states the real status, or claims nothing, is let through and the turn is forgotten", async () => {
  for (const text of ["Moved watering-schedule-api to processing; a pull request is next.", "Here is what I found."]) {
    const stateDir = touched()
    assert.deepEqual(await stop(stateDir, transcript(event("user.message"), reply(text))), {})
    assert.equal(existsSync(sessionFile(stateDir, "s1")), false)
  }
})

test("a session that touched no task is answered at once, without reading or waiting for the transcript", async () => {
  const stateDir = fresh("empty-state")
  assert.deepEqual(await copilotStopHook({ sessionId: "s1", transcriptPath: "/nowhere/events.jsonl" }, { stateDir, sleep: async () => assert.fail("must not wait") }), {})
  assert.deepEqual(await copilotStopHook({ transcriptPath: "/x" }, { stateDir }), {})
  assert.deepEqual(await copilotStopHook({ sessionId: "" }, { stateDir }), {})
  assert.deepEqual(await copilotStopHook(undefined, { stateDir }), {})
})

test("the reply Copilot writes just after the hook starts is waited for", async () => {
  const stateDir = touched()
  const file = transcript(event("user.message"), reply("calling", [{}]))
  const result = await copilotStopHook({ sessionId: "s1", transcriptPath: file }, {
    stateDir, waitMs: 500, stepMs: 50,
    sleep: async () => { writeFileSync(file, `${[event("user.message"), reply("calling", [{}]), reply("All done.")].join("\n")}\n`) },
  })
  assert.equal(result.decision, "block")
})

test("a stop the gate already blocked once ends the loop and forgets the turn; no reply at all lets the turn end", async () => {
  const stateDir = touched()
  const file = transcript(event("user.message"), reply("Done."))
  assert.deepEqual(await stop(stateDir, file, { stop_hook_active: true }), {})
  assert.equal(existsSync(sessionFile(stateDir, "s1")), false)
  const again = touched()
  assert.deepEqual(await stop(again, transcript(event("user.message"))), {})
  assert.deepEqual(await stop(again, "/nowhere/events.jsonl"), {})
})

test("a failure inside the gate lets the turn end", async () => {
  const hostile = { get sessionId() { throw new Error("boom") } }
  assert.deepEqual(await copilotStopHook(hostile, { stateDir: fresh("state") }), {})
})

function run(mode, input, env) {
  const result = spawnSync(process.execPath, [hook, "copilot", mode], { input: typeof input === "string" ? input : JSON.stringify(input), env, encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test("the entry point tracks task tools, forgets on a prompt, blocks at agentStop, and answers {} for anything else", () => {
  const home = fresh("home")
  mkdirSync(home, { recursive: true })
  const env = { HOME: home, XDG_STATE_HOME: path.join(home, "state"), PATH: process.env.PATH }
  const stateDir = path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk")
  const post = (toolName) => ({ sessionId: "s9", cwd: ROOT, toolName, toolArgs: { track: "greenhouse-ops", slug: "watering-schedule-api" }, toolResult: { resultType: "success", textResultForLlm: RESULT } })
  assert.deepEqual(run("track", post("view"), env), {})
  assert.equal(existsSync(sessionFile(stateDir, "s9")), false, "a tool that is not a task tool records nothing")
  assert.deepEqual(run("track", post("desk-task_update"), env), {})
  assert.equal(existsSync(sessionFile(stateDir, "s9")), true)
  const file = transcript(event("user.message"), reply("Done."))
  const blocked = run("stop", { sessionId: "s9", cwd: ROOT, transcriptPath: file, stop_hook_active: false }, env)
  assert.equal(blocked.decision, "block")
  run("track", post("desk-task_update"), env)
  assert.deepEqual(run("prompt", { sessionId: "s9", cwd: ROOT, prompt: "next" }, env), {})
  assert.equal(existsSync(sessionFile(stateDir, "s9")), false)
  assert.deepEqual(run("stop", { sessionId: "s9", transcriptPath: file }, env), {})
  // Claude's own spelling still works through the same entry point.
  assert.deepEqual(run("prompt", { session_id: "c1" }, env), {})
  // A broken payload fails open, quietly.
  assert.deepEqual(run("stop", "not json", env), {})
})

test("with no options the stop hook reads the process environment and a session that touched no task is answered at once", async () => {
  assert.deepEqual(await copilotStopHook({ sessionId: "no-such-session-default-env", transcriptPath: "/nonexistent/events.jsonl" }), {})
})
