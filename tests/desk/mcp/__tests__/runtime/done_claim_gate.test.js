// The done-claim gate (round 13): a PostToolUse hook notes the tasks a session touched, and a Stop hook blocks, once, a final reply that says the work is done while a touched task is not.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  doneClaimStopHook,
  doneClaims,
  lastAssistantText,
  recordTouchedTask,
  sessionFile,
  statesStatus,
  touchedTask,
} from "../../../../../plugins/desk/mcp/src/runtime/done-claim-gate.js"

const plugin = fileURLToPath(new URL("../../../../../plugins/desk/", import.meta.url))
const hook = path.join(plugin, "hooks", "done-claim-gate.cjs")
const ROOT = mkdtempSync(path.join(tmpdir(), "done-gate-"))
test.after(() => rmSync(ROOT, { recursive: true, force: true }))
let counter = 0
const freshState = () => path.join(ROOT, `state-${(counter += 1)}`)

const REPORT = "Task watering-schedule-api is at processing (not done): Open a pull request"
const updated = (extra = {}) => JSON.stringify({ status: "updated", path: "greenhouse-ops/watering-schedule-api/task.md", report_as: REPORT, ...extra })
const post = (toolName, input, response, session = "s1") => ({ hook_event_name: "PostToolUse", session_id: session, tool_name: toolName, tool_input: input, tool_response: response })
const UPDATE = "mcp__plugin_desk_desk__task_update"

function transcript(...entries) {
  const file = path.join(ROOT, `t-${(counter += 1)}.jsonl`)
  writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n")
  return file
}
const say = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } })
const asked = { type: "user", message: { role: "user", content: "resume it" } }
const toolUse = { type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "x", name: "Bash", input: {} }] } }
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } }

/** A state dir where session s1 touched the watering task and left it at `status`. */
function touched(status = "processing", reportAs = REPORT) {
  const stateDir = freshState()
  const response = status === "processing" ? updated() : JSON.stringify({ status: "updated", path: "greenhouse-ops/watering-schedule-api/task.md", report_as: reportAs })
  recordTouchedTask(post(UPDATE, { track: "greenhouse-ops", slug: "watering-schedule-api", note: "x" }, response), { stateDir })
  return stateDir
}
const stop = (stateDir, reply, extra = {}) => doneClaimStopHook({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcript(asked, say(reply)), ...extra }, { stateDir })
const blocks = (result) => result.decision === "block"

// ---- tracking ----

test("a task_update response is read for the task and the status it left (report_as), whatever shape the response has", () => {
  const expected = { key: "greenhouse-ops/watering-schedule-api", slug: "watering-schedule-api", status: "processing", reportAs: REPORT }
  const input = { track: "greenhouse-ops", slug: "watering-schedule-api" }
  assert.deepEqual(touchedTask(UPDATE, input, updated()), expected)
  assert.deepEqual(touchedTask(UPDATE, input, [{ type: "text", text: updated() }]), expected)
  assert.deepEqual(touchedTask(UPDATE, input, { content: [{ type: "text", text: updated() }] }), expected)
  assert.deepEqual(touchedTask(UPDATE, input, { structuredContent: JSON.parse(updated()) }), expected)
  assert.deepEqual(touchedTask("mcp__desk__task_update", input, ["", updated()]), expected)
})

test("the task comes from the result path when the call used a handle, and a response with no task or a failure records nothing", () => {
  assert.equal(touchedTask(UPDATE, { handle: "abc" }, updated()).key, "greenhouse-ops/watering-schedule-api")
  assert.equal(touchedTask(UPDATE, { handle: "abc" }, JSON.stringify({ status: "updated", report_as: REPORT })), null, "no slug anywhere")
  assert.equal(touchedTask(UPDATE, { slug: "x" }, "not json"), null)
  assert.equal(touchedTask(UPDATE, { slug: "x" }, "[1]"), null)
  assert.equal(touchedTask(UPDATE, { slug: "x" }, JSON.stringify({ status: "failed" })), null)
  assert.equal(touchedTask(UPDATE, { slug: "x" }, JSON.stringify({ error: "nope" })), null)
  assert.equal(touchedTask(UPDATE, { slug: "x" }, 42), null)
  assert.equal(touchedTask(UPDATE, { slug: "x" }, { isError: false }), null)
  assert.equal(touchedTask(UPDATE, { slug: "x" }, null), null)
  assert.equal(touchedTask("Bash", { slug: "x" }, updated()), null)
  assert.equal(touchedTask(undefined, undefined, undefined), null)
})

test("each task tool leaves the status it implies: create (given or drafting), update, archive, move", () => {
  const created = JSON.stringify({ status: "created", path: "greenhouse-ops/new-job/task.md" })
  assert.equal(touchedTask("mcp__plugin_desk_desk__task_create", { track: "greenhouse-ops", slug: "new-job" }, created).status, "drafting")
  assert.equal(touchedTask("mcp__plugin_desk_desk__task_create", { track: "greenhouse-ops", slug: "new-job", status: "processing" }, created).status, "processing")
  assert.equal(touchedTask("mcp__plugin_desk_desk__task_create", { slug: "new-job", status: "" }, JSON.stringify({ status: "created" })).key, "/new-job", "no track anywhere keeps the slug")
  assert.equal(touchedTask(UPDATE, { slug: "j", status: "done" }, JSON.stringify({ status: "updated", path: "t/j/task.md" })).status, "done")
  assert.equal(touchedTask(UPDATE, { slug: "j", frontmatter: { status: "validating" } }, JSON.stringify({ status: "updated", path: "t/j/task.md" })).status, "validating")
  assert.equal(touchedTask(UPDATE, { slug: "j", note: "n" }, JSON.stringify({ status: "updated", path: "t/j/task.md" })).status, null)
  const archived = JSON.stringify({ status: "archived", path: "t/_archive/j/task.md" })
  assert.equal(touchedTask("mcp__plugin_desk_desk__task_archive", { track: "t", slug: "j" }, archived).status, "done")
  assert.equal(touchedTask("mcp__plugin_desk_desk__task_archive", { track: "t", slug: "j", outcome: "cancelled" }, archived).status, "cancelled")
  assert.equal(touchedTask("mcp__plugin_desk_desk__task_move", { track: "t", slug: "j" }, JSON.stringify({ status: "moved", path: "u/j/task.md" })).status, null)
})

test("recording writes one session-scoped file, keeps the last known status through a move, and ignores calls it cannot place", () => {
  const stateDir = freshState()
  const input = { track: "greenhouse-ops", slug: "watering-schedule-api" }
  assert.deepEqual(recordTouchedTask(post(UPDATE, input, updated()), { stateDir }), {})
  const file = sessionFile(stateDir, "s1")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tasks["greenhouse-ops/watering-schedule-api"], { slug: "watering-schedule-api", status: "processing", report_as: REPORT })
  recordTouchedTask(post("mcp__plugin_desk_desk__task_move", input, JSON.stringify({ status: "moved", path: "greenhouse-ops/watering-schedule-api/task.md" })), { stateDir })
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tasks["greenhouse-ops/watering-schedule-api"], { slug: "watering-schedule-api", status: "processing", report_as: REPORT })
  recordTouchedTask(post(UPDATE, input, JSON.stringify({ status: "updated", path: "greenhouse-ops/watering-schedule-api/task.md" }), "s2"), { stateDir })
  assert.equal(readdirSync(path.join(stateDir, "done-gate")).length, 2, "one file per session")
  assert.notEqual(sessionFile(stateDir, "s1"), sessionFile(stateDir, "../s1"))
  assert.equal(path.dirname(sessionFile(stateDir, "../../x")), path.join(stateDir, "done-gate"))
  // No session id, or no task: nothing is written.
  const quiet = freshState()
  recordTouchedTask(post(UPDATE, input, updated(), ""), { stateDir: quiet })
  recordTouchedTask({ ...post(UPDATE, input, updated()), session_id: undefined }, { stateDir: quiet })
  recordTouchedTask(post("Bash", input, updated()), { stateDir: quiet })
  recordTouchedTask(undefined, { stateDir: quiet })
  assert.equal(existsSync(path.join(quiet, "done-gate")), false)
})

test("recording fails open: an unreadable state file is started over and an unwritable state folder is swallowed", () => {
  const stateDir = freshState()
  const file = sessionFile(stateDir, "s1")
  mkdirSync(path.dirname(file), { recursive: true })
  for (const bad of ["not json", "null", '{"tasks":[]}', '{"tasks":null}']) {
    writeFileSync(file, bad)
    recordTouchedTask(post(UPDATE, { slug: "watering-schedule-api" }, updated()), { stateDir })
    assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks["greenhouse-ops/watering-schedule-api"].status, "processing")
  }
  const blocked = path.join(ROOT, "a-file")
  writeFileSync(blocked, "")
  assert.deepEqual(recordTouchedTask(post(UPDATE, { slug: "x" }, updated()), { stateDir: path.join(blocked, "inside") }), {})
})

test("recording removes a session file older than a week", () => {
  const stateDir = freshState()
  recordTouchedTask(post(UPDATE, { slug: "watering-schedule-api" }, updated(), "old"), { stateDir })
  const oldFile = sessionFile(stateDir, "old")
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  utimesSync(oldFile, longAgo, longAgo)
  recordTouchedTask(post(UPDATE, { slug: "watering-schedule-api" }, updated(), "new"), { stateDir })
  assert.equal(existsSync(oldFile), false)
  assert.equal(existsSync(sessionFile(stateDir, "new")), true)
})

// ---- what counts as a done claim ----

test("done claims: the openers and statements agents used over cards at processing or validating", () => {
  for (const reply of [
    "Done. The RainDelayPolicy implementation is complete with all tests passing.",
    "**Done.** Implemented the check.",
    "✓ **Done:** wired the check",
    "Completed. Tests pass.",
    "All done.",
    "Work complete.",
    "Work is complete and committed.",
    "The work is now done.",
    "All the work is finished.",
    "I finished all of the work.",
    "The task is complete.",
    "This task has been completed.",
    "I completed the task and pushed.",
    "Task done.",
    "The implementation is complete.",
    "Successfully completed the change.",
    "Everything is done here.",
    "**Completed work:**\n- wired the check",
  ]) assert.ok(doneClaims(reply).length > 0, reply)
})

test("not done claims: a step finished, a pause, a negation, a promise, and replies that state the status", () => {
  for (const reply of [
    "Done reading the card; the task is at validating.",
    "I'm done for now.",
    "Done with step 2, next is the push.",
    "The task is not done yet.",
    "The task isn’t complete until it is pushed.",
    "I will finish the task once the review lands.",
    "The task is complete once the PR merges.",
    "Status: validating.",
    "status: validating",
    "I moved it to validating.",
    "Transitioned the task to `processing`.",
    "Committed abc123; task is at validating; next: open the PR.",
    "",
  ]) assert.deepEqual(doneClaims(reply), [], reply)
  // An explicit status clause does not hide a real claim in the rest of the sentence.
  assert.ok(doneClaims("The task is complete at validating (not done).").length > 0)
  assert.ok(doneClaims("The task is complete. Status: processing.").length > 0)
})

test("a status is stated when the reply names it as a word, anywhere", () => {
  assert.equal(statesStatus("task is at validating.", "validating"), true)
  assert.equal(statesStatus("Status: **Processing**", "processing"), true)
  assert.equal(statesStatus("preprocessing the data", "processing"), false)
  assert.equal(statesStatus("Done.", "processing"), false)
  assert.equal(statesStatus("a.b", "a.b"), true)
})

// ---- the transcript ----

test("the last assistant message is every text block after the last user entry", () => {
  const lines = (...entries) => entries.map((entry) => JSON.stringify(entry)).join("\n")
  assert.equal(lastAssistantText(lines(asked, say("first"), toolUse, toolResult, say("Final reply"))), "Final reply")
  assert.equal(lastAssistantText(lines(asked, say("part one"), say("part two"))), "part one\npart two")
  assert.equal(lastAssistantText(lines({ type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "tool_use" }, { type: "text", text: "b" }] } })), "a\nb")
  assert.equal(lastAssistantText(`${lines(asked, say("kept"))}\nnot json\n\n`), "kept")
  assert.equal(lastAssistantText(lines(asked, toolUse)), null)
  assert.equal(lastAssistantText(lines({ type: "system" }, { type: "assistant", message: { content: "plain" } })), null)
  assert.equal(lastAssistantText(""), null)
})

// ---- the Stop hook ----

test("blocks a reply that says Done over a task at processing, naming the task, its status and report_as", () => {
  const result = stop(touched(), "Done. The RainDelayPolicy implementation is complete.")
  assert.equal(result.decision, "block")
  assert.match(result.reason, /Your reply says the work is done, but task watering-schedule-api is at processing\./)
  assert.match(result.reason, /Restate the reply with the task's real status/)
  assert.ok(result.reason.includes(`task_update returned report_as: ${JSON.stringify(REPORT)}`))
})

test("blocks when the status was recorded without a report_as, and names no report_as then", () => {
  const stateDir = freshState()
  recordTouchedTask(post("mcp__plugin_desk_desk__task_create", { track: "g", slug: "new-job" }, JSON.stringify({ status: "created", path: "g/new-job/task.md" })), { stateDir })
  const result = stop(stateDir, "Work complete.")
  assert.equal(result.reason, "Your reply says the work is done, but task new-job is at drafting. Restate the reply with the task's real status.")
})

test("the false positives pass: a step finished, a pause, a stated status, the status in a heading's reply", () => {
  const stateDir = touched()
  for (const reply of [
    "Done reading the card; the task is at validating, I have not touched processing.",
    "Done reading the card; the task is at processing.",
    "I'm done for now. Picking this up tomorrow.",
    "Done. The task is at processing; next: open the PR.",
    "Done.\n\nstatus: processing",
    "**Completed work:**\n- wired the check\n\n**Current status:** Processing",
    "All the tests pass and the branch is committed.",
  ]) assert.deepEqual(stop(stateDir, reply), {}, reply)
})

test("the reply comes from last_assistant_message when the payload has one, even while the transcript does not hold it yet (round 13 live run)", () => {
  const stateDir = touched()
  const stale = transcript(asked) // the user's prompt is written; the final reply is not
  const base = { hook_event_name: "Stop", session_id: "s1", transcript_path: stale }
  assert.equal(doneClaimStopHook({ ...base, last_assistant_message: "Done." }, { stateDir }).decision, "block")
  assert.deepEqual(doneClaimStopHook({ ...base, last_assistant_message: "Done. The task is at processing." }, { stateDir }), {})
  assert.deepEqual(doneClaimStopHook({ ...base, last_assistant_message: "I'm done for now." }, { stateDir }), {})
  // No transcript at all is fine when the message is there; an empty message falls back to the transcript.
  assert.equal(doneClaimStopHook({ hook_event_name: "Stop", session_id: "s1", last_assistant_message: "Work complete." }, { stateDir }).decision, "block")
  assert.equal(doneClaimStopHook({ ...base, last_assistant_message: "  ", transcript_path: transcript(asked, say("Done.")) }, { stateDir }).decision, "block")
  assert.deepEqual(doneClaimStopHook({ ...base, last_assistant_message: 7 }, { stateDir }), {})
})

test("a done claim passes when the task is done, the session touched nothing, or the status is unknown", () => {
  const stateDir = freshState()
  assert.deepEqual(stop(stateDir, "Done."), {}, "no state file")
  recordTouchedTask(post(UPDATE, { slug: "j", status: "done" }, JSON.stringify({ status: "updated", path: "t/j/task.md" })), { stateDir })
  assert.deepEqual(stop(stateDir, "Done."), {}, "done is not an open task")
  recordTouchedTask(post(UPDATE, { slug: "k", status: "cancelled" }, JSON.stringify({ status: "updated", path: "t/k/task.md" })), { stateDir })
  recordTouchedTask(post(UPDATE, { slug: "m", note: "n" }, JSON.stringify({ status: "updated", path: "t/m/task.md" })), { stateDir })
  assert.deepEqual(stop(stateDir, "Done."), {}, "cancelled and unknown statuses are not open")
  assert.deepEqual(stop(touched(), "Done.", { session_id: "another-session" }), {}, "another session's tasks are not this session's")
})

test("blocks at most once: stop_hook_active ends the loop, and a child agent's stop is never gated", () => {
  const stateDir = touched()
  assert.equal(blocks(stop(stateDir, "Done.")), true)
  assert.deepEqual(stop(stateDir, "Done.", { stop_hook_active: true }), {})
  assert.deepEqual(stop(stateDir, "Done.", { hook_event_name: "SubagentStop" }), {})
  assert.deepEqual(stop(stateDir, "Done.", { agent_id: "agent-1" }), {})
})

test("fails open: no transcript, an unreadable or oversized one, no reply, no session id, a bad payload", () => {
  const stateDir = touched()
  const ok = { hook_event_name: "Stop", session_id: "s1" }
  assert.deepEqual(doneClaimStopHook({ ...ok }, { stateDir }), {}, "no transcript_path")
  assert.deepEqual(doneClaimStopHook({ ...ok, transcript_path: path.join(ROOT, "missing.jsonl") }, { stateDir }), {})
  assert.deepEqual(doneClaimStopHook({ ...ok, transcript_path: transcript(asked, toolUse) }, { stateDir }), {}, "no assistant text")
  assert.deepEqual(doneClaimStopHook({ ...ok, transcript_path: transcript(asked, say("Done.")), session_id: "" }, { stateDir }), {})
  assert.deepEqual(doneClaimStopHook({ transcript_path: transcript(asked, say("Done.")) }, { stateDir }), {})
  const big = path.join(ROOT, "big.jsonl")
  writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20))
  assert.deepEqual(doneClaimStopHook({ ...ok, transcript_path: big }, { stateDir }), {})
  writeFileSync(sessionFile(stateDir, "s1"), "{{{")
  assert.deepEqual(stop(stateDir, "Done."), {}, "a malformed state file means no open task")
  assert.deepEqual(doneClaimStopHook(null, { stateDir }), {})
  assert.deepEqual(doneClaimStopHook(undefined), {})
})

test("a task with a malformed entry in the state file is skipped", () => {
  const stateDir = freshState()
  const file = sessionFile(stateDir, "s1")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ tasks: { a: null, b: { slug: "b", status: "" }, c: { status: "processing" }, d: { slug: "d", status: "validating", report_as: "" } } }))
  const result = stop(stateDir, "Done.")
  assert.equal(result.reason, "Your reply says the work is done, but task d is at validating. Restate the reply with the task's real status.")
})

test("with two open tasks the reply must state each one's status", () => {
  const stateDir = touched()
  recordTouchedTask(post(UPDATE, { track: "greenhouse-ops", slug: "soil-sensor" }, JSON.stringify({ status: "updated", path: "greenhouse-ops/soil-sensor/task.md", report_as: "Task soil-sensor is at validating (not done): x" })), { stateDir })
  assert.match(stop(stateDir, "Done. watering is processing.").reason, /task soil-sensor is at validating/)
  assert.deepEqual(stop(stateDir, "Done. watering is processing and soil-sensor is validating."), {})
})

// ---- the entry point ----

function runHook(mode, input, env) {
  const result = spawnSync(process.execPath, [hook, "claude", mode], { input, env: { ...process.env, ...env }, encoding: "utf8" })
  return { result, output: result.stdout.trim() === "" ? {} : JSON.parse(result.stdout) }
}

test("the .cjs entry point records over stdin, blocks over stdout, and fails open on a broken call", () => {
  const home = freshState()
  const env = { XDG_STATE_HOME: home, HOME: home }
  const tracked = runHook("track", JSON.stringify(post(UPDATE, { track: "greenhouse-ops", slug: "watering-schedule-api" }, updated(), "cjs-session")), env)
  assert.equal(tracked.result.status, 0)
  assert.deepEqual(tracked.output, {})
  const blocked = runHook("stop", JSON.stringify({ hook_event_name: "Stop", session_id: "cjs-session", transcript_path: transcript(asked, say("Done.")) }), env)
  assert.equal(blocked.result.status, 0)
  assert.equal(blocked.output.decision, "block")
  const once = runHook("stop", JSON.stringify({ hook_event_name: "Stop", session_id: "cjs-session", stop_hook_active: true, transcript_path: transcript(asked, say("Done.")) }), env)
  assert.deepEqual(once.output, {})
  const broken = runHook("stop", "not json", env)
  assert.equal(broken.result.status, 0)
  assert.deepEqual(broken.output, {})
})

test("hooks.json wires the Stop gate beside the factory hook and the tracker on the four task tools", () => {
  const hooks = JSON.parse(readFileSync(path.join(plugin, "hooks", "hooks.json"), "utf8")).hooks
  assert.ok(hooks.Stop.some((group) => group.hooks.some((entry) => /done-claim-gate\.cjs" claude stop$/u.test(entry.command))))
  assert.ok(hooks.Stop.some((group) => group.hooks.some((entry) => /factory-end\.cjs/u.test(entry.command))))
  const track = hooks.PostToolUse.find((group) => group.hooks.some((entry) => /done-claim-gate\.cjs" claude track$/u.test(entry.command)))
  const matcher = new RegExp(`^(?:${track.matcher})$`, "u")
  for (const tool of ["task_update", "task_create", "task_move", "task_archive"]) {
    assert.ok(matcher.test(`mcp__plugin_desk_desk__${tool}`), tool)
    assert.ok(matcher.test(`mcp__desk__${tool}`), tool)
  }
  assert.equal(matcher.test("mcp__plugin_desk_desk__desk_status"), false)
  assert.equal(matcher.test("Bash"), false)
})
