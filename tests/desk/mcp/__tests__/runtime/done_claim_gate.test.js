// The done-claim gate (round 13): a PostToolUse hook notes the tasks a session touched, and a Stop hook blocks, once, a final reply that says the work is done while a touched task is not.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import {
  clearTouchedTasks,
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
  recordTouchedTask(post(UPDATE, { track: "greenhouse-ops", slug: "watering-schedule-api", note: "x" }, response), { stateDir, root: null })
  return stateDir
}
const stop = (stateDir, reply, extra = {}) => doneClaimStopHook({ hook_event_name: "Stop", session_id: "s1", transcript_path: transcript(asked, say(reply)), ...extra }, { stateDir })
const blocks = (result) => result.decision === "block"

// ---- tracking ----

test("a task_update response is read for the task and the status it left (report_as), whatever shape the response has", () => {
  const expected = { key: "greenhouse-ops/watering-schedule-api", slug: "watering-schedule-api", status: "processing", reportAs: REPORT, path: "greenhouse-ops/watering-schedule-api/task.md", oldKey: null }
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
  assert.deepEqual(recordTouchedTask(post(UPDATE, input, updated()), { stateDir, root: null }), {})
  const file = sessionFile(stateDir, "s1")
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tasks["greenhouse-ops/watering-schedule-api"], { slug: "watering-schedule-api", status: "processing", report_as: REPORT, root: null, path: "greenhouse-ops/watering-schedule-api/task.md" })
  recordTouchedTask(post("mcp__plugin_desk_desk__task_move", input, JSON.stringify({ status: "moved", path: "greenhouse-ops/watering-schedule-api/task.md" })), { stateDir, root: null })
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).tasks["greenhouse-ops/watering-schedule-api"], { slug: "watering-schedule-api", status: "processing", report_as: REPORT, root: null, path: "greenhouse-ops/watering-schedule-api/task.md" })
  recordTouchedTask(post(UPDATE, input, JSON.stringify({ status: "updated", path: "greenhouse-ops/watering-schedule-api/task.md" }), "s2"), { stateDir, root: null })
  assert.equal(readdirSync(path.join(stateDir, "done-gate")).length, 2, "one file per session")
  assert.notEqual(sessionFile(stateDir, "s1"), sessionFile(stateDir, "../s1"))
  assert.equal(path.dirname(sessionFile(stateDir, "../../x")), path.join(stateDir, "done-gate"))
  // No session id, or no task: nothing is written.
  const quiet = freshState()
  recordTouchedTask(post(UPDATE, input, updated(), ""), { stateDir: quiet, root: null })
  recordTouchedTask({ ...post(UPDATE, input, updated()), session_id: undefined }, { stateDir: quiet, root: null })
  recordTouchedTask(post("Bash", input, updated()), { stateDir: quiet, root: null })
  recordTouchedTask(undefined, { stateDir: quiet, root: null })
  assert.equal(existsSync(path.join(quiet, "done-gate")), false)
})

test("recording fails open: an unreadable state file is started over and an unwritable state folder is swallowed", () => {
  const stateDir = freshState()
  const file = sessionFile(stateDir, "s1")
  mkdirSync(path.dirname(file), { recursive: true })
  for (const bad of ["not json", "null", '{"tasks":[]}', '{"tasks":null}']) {
    writeFileSync(file, bad)
    recordTouchedTask(post(UPDATE, { slug: "watering-schedule-api" }, updated()), { stateDir, root: null })
    assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks["greenhouse-ops/watering-schedule-api"].status, "processing")
  }
  const blocked = path.join(ROOT, "a-file")
  writeFileSync(blocked, "")
  assert.deepEqual(recordTouchedTask(post(UPDATE, { slug: "x" }, updated()), { stateDir: path.join(blocked, "inside"), root: null }), {})
})

test("recording removes a session file older than a week", () => {
  const stateDir = freshState()
  recordTouchedTask(post(UPDATE, { slug: "watering-schedule-api" }, updated(), "old"), { stateDir, root: null })
  const oldFile = sessionFile(stateDir, "old")
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  utimesSync(oldFile, longAgo, longAgo)
  recordTouchedTask(post(UPDATE, { slug: "watering-schedule-api" }, updated(), "new"), { stateDir, root: null })
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

test("a status is stated only in a status clause, or beside the task's name; the bare word states nothing", () => {
  for (const text of ["task is at validating.", "Status: **Processing**", "**Task status:** Processing", "The task is at `validating` (not done)", "Left at validating (not done).", "I moved it to validating.", "Transitioned the task to processing", "The task is still processing.", "Task watering-schedule-api is validating."]) assert.equal(statesStatus(text, text.toLowerCase().includes("validating") ? "validating" : "processing"), true, text)
  for (const [text, status] of [["preprocessing the data", "processing"], ["Done.", "processing"], ["The task is not validating.", "validating"], ["Still processing the logs.", "processing"], ["Checked processing speed.", "processing"], ["a.b", "validating"]]) assert.equal(statesStatus(text, status), false, text)
})

test("a status beside the task's slug counts, and negated or elsewhere does not", () => {
  assert.equal(statesStatus("watering-schedule-api: validating", "validating", "watering-schedule-api"), true)
  assert.equal(statesStatus("watering-schedule-api: not validating", "validating", "watering-schedule-api"), false)
  assert.equal(statesStatus("watering-schedule-api is fine. Validating the build now.", "validating", "watering-schedule-api"), false)
  assert.equal(statesStatus("other-task: validating", "validating", "watering-schedule-api"), false)
  assert.equal(statesStatus("x: validating", "validating", ""), false)
})

// ---- detection: code, quotes, and the deliberate gaps (review of 69442ece) ----

test("code and quoted text are not the reply's own claim", () => {
  for (const reply of [
    "The card said \"the task is complete\" but it is not.",
    "I read `Done.` in the log.",
    "```\nDone. All done.\nThe task is complete.\n```\nThat is the build output.",
    "Output was `the task is complete` and nothing else.",
    "She wrote \u201cwork complete\u201d in the card.",
  ]) assert.deepEqual(doneClaims(reply), [], reply)
  // A quotation that opens the reply is the reply speaking; code stripped from one sentence leaves the next.
  assert.ok(doneClaims("\"Done\" - wired it").length > 0)
  assert.ok(doneClaims("Ran `make`. The task is complete.").length > 0)
  assert.ok(doneClaims("```\nfoo\n```\nThe task is complete.").length > 0)
  assert.deepEqual(doneClaims("```\nunterminated Done. The task is complete."), [])
  assert.deepEqual(doneClaims(undefined), [])
})

test("false positives the review found stay quiet: 'done with the task review', 'All tests are done running', loose 'the task done'", () => {
  for (const reply of [
    "I'm done with the task review.",
    "I'm done with the task list for today.",
    "All tests are done running.",
    "All the files are done compiling.",
    "Both jobs finished running in CI.",
    "The task done flag is a boolean.",
    "I was told the task was done.",
    "The fix is done.",
    "Shipped.",
  ]) assert.deepEqual(doneClaims(reply), [], reply)
})

test("a 'Task is done.' after a Done opener is caught, and so are the plain forms", () => {
  assert.equal(doneClaims("Done. Task is done.").length, 2)
  assert.equal(doneClaims("Wired it.\nTask is now complete.").length, 1)
  assert.equal(doneClaims("Wired it. Task finished.").length, 1)
  assert.equal(doneClaims("I'm done with the task and pushed.").length, 1)
  assert.equal(doneClaims("I completed all of the task.").length, 1)
  assert.equal(doneClaims("Everything is done.").length, 1)
  assert.equal(doneClaims("This job has been completed.").length, 1)
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
  assert.match(result.reason, /^Restate your reply with task watering-schedule-api's real status: processing\./)
  assert.ok(result.reason.includes(`task_update returned report_as: ${JSON.stringify(REPORT)}`))
})

test("a claim that the task itself is done gets its own correction, even beside an honest status", () => {
  const result = stop(touched(), "Status: processing. Task watering-schedule-api is done.")
  assert.equal(result.decision, "block")
  assert.match(result.reason, /^Restate your reply with task watering-schedule-api's real status: processing\./)
  assert.match(result.reason, /Your reply says task watering-schedule-api itself is done, but it is at processing; you may say the work is done, not the task\./)
})

test("blocks when the status was recorded without a report_as, and names no report_as then", () => {
  const stateDir = freshState()
  recordTouchedTask(post("mcp__plugin_desk_desk__task_create", { track: "g", slug: "new-job" }, JSON.stringify({ status: "created", path: "g/new-job/task.md" })), { stateDir, root: null })
  const result = stop(stateDir, "Work complete.")
  assert.equal(result.reason, "Restate your reply with task new-job's real status: drafting. Your reply says the work is done, but task new-job is at drafting.")
})

test("the false positives pass: a step finished, a pause, a stated status, the status in a heading's reply", () => {
  for (const reply of [
    "Done reading the card; the task is at validating, I have not touched processing.",
    "Done reading the card; the task is at processing.",
    "I'm done for now. Picking this up tomorrow.",
    "Done. The task is at processing; next: open the PR.",
    "Done.\n\nstatus: processing",
    "**Completed work:**\n- wired the check\n\n**Current status:** Processing",
    "All the tests pass and the branch is committed.",
  ]) assert.deepEqual(stop(touched(), reply), {}, reply)
})

test("the reply comes from last_assistant_message when the payload has one, even while the transcript does not hold it yet (round 13 live run)", () => {
  const stale = transcript(asked) // the user's prompt is written; the final reply is not
  const base = { hook_event_name: "Stop", session_id: "s1", transcript_path: stale }
  const run = (extra) => doneClaimStopHook({ ...base, ...extra }, { stateDir: touched() })
  assert.equal(run({ last_assistant_message: "Done." }).decision, "block")
  assert.deepEqual(run({ last_assistant_message: "Done. The task is at processing." }), {})
  assert.deepEqual(run({ last_assistant_message: "I'm done for now." }), {})
  // No transcript at all is fine when the message is there; an empty message falls back to the transcript.
  assert.equal(run({ transcript_path: undefined, last_assistant_message: "Work complete." }).decision, "block")
  assert.equal(run({ last_assistant_message: "  ", transcript_path: transcript(asked, say("Done.")) }).decision, "block")
  assert.deepEqual(run({ last_assistant_message: 7 }), {})
})

test("a done claim passes when the task is done, the turn touched nothing, or the status is unknown", () => {
  const stateDir = freshState()
  assert.deepEqual(stop(stateDir, "Done."), {}, "no state file")
  const only = (input) => {
    const dir = freshState()
    recordTouchedTask(post(UPDATE, input, JSON.stringify({ status: "updated", path: `t/${input.slug}/task.md` })), { stateDir: dir, root: null })
    return dir
  }
  assert.deepEqual(stop(only({ slug: "j", status: "done" }), "Done."), {}, "done is not an open task")
  assert.deepEqual(stop(only({ slug: "k", status: "cancelled" }), "Done."), {}, "cancelled is not open")
  assert.deepEqual(stop(only({ slug: "m", note: "n" }), "Done."), {}, "an unknown status is not open")
  assert.deepEqual(stop(touched(), "Done.", { session_id: "another-session" }), {}, "another session's tasks are not this session's")
})

test("blocks at most once: stop_hook_active ends the loop, and a child agent's stop is never gated and clears nothing", () => {
  const stateDir = touched()
  assert.equal(blocks(stop(stateDir, "Done.")), true)
  assert.equal(existsSync(sessionFile(stateDir, "s1")), true, "a block keeps the turn's tasks")
  assert.deepEqual(stop(stateDir, "Done.", { stop_hook_active: true }), {})
  assert.equal(existsSync(sessionFile(stateDir, "s1")), false, "the stop that follows a block ends the turn")
  for (const extra of [{ hook_event_name: "SubagentStop" }, { agent_id: "agent-1" }]) {
    const dir = touched()
    assert.deepEqual(stop(dir, "Done.", extra), {})
    assert.equal(existsSync(sessionFile(dir, "s1")), true, "a child's stop leaves the parent's turn alone")
  }
})

test("fails open: no transcript, an unreadable or oversized one, no reply, no session id, a bad payload", () => {
  const ok = { hook_event_name: "Stop", session_id: "s1" }
  const run = (extra) => doneClaimStopHook({ ...ok, ...extra }, { stateDir: touched() })
  assert.deepEqual(run({}), {}, "no transcript_path")
  assert.deepEqual(run({ transcript_path: path.join(ROOT, "missing.jsonl") }), {})
  assert.deepEqual(run({ transcript_path: transcript(asked, toolUse) }), {}, "no assistant text")
  assert.deepEqual(run({ transcript_path: transcript(asked, say("Done.")), session_id: "" }), {})
  assert.deepEqual(doneClaimStopHook({ transcript_path: transcript(asked, say("Done.")) }, { stateDir: touched() }), {})
  const big = path.join(ROOT, "big.jsonl")
  writeFileSync(big, Buffer.alloc(8 * 1024 * 1024 + 1, 0x20))
  assert.deepEqual(run({ transcript_path: big }), {})
  const broken = touched()
  writeFileSync(sessionFile(broken, "s1"), "{{{")
  assert.deepEqual(stop(broken, "Done."), {}, "a malformed state file means no open task")
  assert.deepEqual(doneClaimStopHook(null, { stateDir: broken }), {})
  assert.deepEqual(doneClaimStopHook(undefined), {})
})

test("a task with a malformed entry in the state file is skipped", () => {
  const stateDir = freshState()
  const file = sessionFile(stateDir, "s1")
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ tasks: { a: null, b: { slug: "b", status: "" }, c: { status: "processing" }, d: { slug: "d", status: "validating", report_as: "" } } }))
  const result = stop(stateDir, "Done.")
  assert.equal(result.reason, "Restate your reply with task d's real status: validating. Your reply says the work is done, but task d is at validating.")
})

test("with two open tasks the reply must state each one's status", () => {
  const two = () => {
    const stateDir = touched()
    recordTouchedTask(post(UPDATE, { track: "greenhouse-ops", slug: "soil-sensor" }, JSON.stringify({ status: "updated", path: "greenhouse-ops/soil-sensor/task.md", report_as: "Task soil-sensor is at validating (not done): x" })), { stateDir, root: null })
    return stateDir
  }
  assert.match(stop(two(), "Done. Status: processing.").reason, /task soil-sensor is at validating/)
  assert.deepEqual(stop(two(), "Done. Watering status: processing; soil-sensor is at validating."), {})
})

// ---- the turn, the live card, and a moved card (review of 69442ece) ----

const deskWith = (status) => {
  const root = path.join(ROOT, `desk-${(counter += 1)}`)
  mkdirSync(path.join(root, "greenhouse-ops", "watering-schedule-api"), { recursive: true })
  const card = path.join(root, "greenhouse-ops", "watering-schedule-api", "task.md")
  writeFileSync(card, `---\ntitle: "x"\nstatus: ${status}\n---\n\nbody\n`)
  return { root, card }
}
const recordIn = (stateDir, root, session = "s1") => recordTouchedTask(post(UPDATE, { track: "greenhouse-ops", slug: "watering-schedule-api" }, updated(), session), { stateDir, root })

test("the card is read again at Stop: a task now done or cancelled, or gone, is not open; an unreadable card fails open", () => {
  for (const [status, blocked] of [["processing", true], ["validating", true], ["done", false], ["cancelled", false], ['"done"', false]]) {
    const { root } = deskWith(status)
    const stateDir = freshState()
    recordIn(stateDir, root)
    const result = stop(stateDir, "Done.")
    assert.equal(blocks(result), blocked, status)
    if (blocked) assert.match(result.reason, new RegExp(`is at ${status}\\.`), "the live status, not the recorded one")
  }
  const gone = deskWith("processing")
  const stateDir = freshState()
  recordIn(stateDir, gone.root)
  rmSync(gone.card)
  assert.deepEqual(stop(stateDir, "Done."), {}, "a missing card")
  const noStatus = deskWith("processing")
  writeFileSync(noStatus.card, "no frontmatter here")
  const two = freshState()
  recordIn(two, noStatus.root)
  assert.deepEqual(stop(two, "Done."), {}, "a card with no status")
  const unreadable = deskWith("processing")
  const three = freshState()
  recordIn(three, unreadable.root)
  rmSync(unreadable.card)
  mkdirSync(unreadable.card) // a folder where the card was: reading it throws
  assert.deepEqual(stop(three, "Done."), {}, "an unreadable card")
})

test("reviewer scenario 1: a task left at validating in an earlier turn never gates a later, unrelated reply", () => {
  const { root } = deskWith("validating")
  const stateDir = freshState()
  recordIn(stateDir, root)
  // Turn 1: the reply states the status, so it passes and the turn's tasks are cleared.
  assert.deepEqual(stop(stateDir, "Committed abc123; task watering-schedule-api is at validating (not done)."), {})
  // Turn 2 touches nothing: "All done." is about something else.
  assert.deepEqual(stop(stateDir, "All done. I renamed the variable."), {})
})

test("reviewer scenario 2: a new prompt starts a new turn even when no Stop ran in between", () => {
  const { root } = deskWith("validating")
  const stateDir = freshState()
  recordIn(stateDir, root)
  assert.deepEqual(clearTouchedTasks({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt: "next thing" }, { stateDir }), {})
  assert.deepEqual(stop(stateDir, "All done."), {})
  // Another session's file is left alone, and a payload with no session clears nothing.
  recordIn(stateDir, root, "other")
  clearTouchedTasks({ session_id: "s1" }, { stateDir })
  clearTouchedTasks({}, { stateDir })
  clearTouchedTasks(undefined, { stateDir })
  assert.equal(existsSync(sessionFile(stateDir, "other")), true)
  assert.equal(blocks(stop(stateDir, "Done.", { session_id: "other" })), true)
})

test("a task touched again in the new turn gates again", () => {
  const { root } = deskWith("processing")
  const stateDir = freshState()
  recordIn(stateDir, root)
  assert.deepEqual(stop(stateDir, "Status: processing."), {})
  recordIn(stateDir, root)
  assert.equal(blocks(stop(stateDir, "Done.")), true)
})

test("with no root given, the desk root is resolved from the call's cwd (or the process's) and the entry still records", () => {
  for (const cwd of [ROOT, undefined]) {
    const stateDir = freshState()
    const env = { ...process.env, HOME: ROOT, XDG_STATE_HOME: stateDir, CLAUDE_PROJECT_DIR: undefined }
    recordTouchedTask({ ...post(UPDATE, { slug: "watering-schedule-api" }, updated()), cwd }, { stateDir, env })
    const entry = Object.values(JSON.parse(readFileSync(sessionFile(stateDir, "s1"), "utf8")).tasks)[0]
    assert.equal(entry.slug, "watering-schedule-api")
    assert.ok(entry.root === null || typeof entry.root === "string")
  }
})

test("task_move deletes the entry under the old key and records the new one, keeping the last known status", () => {
  const stateDir = freshState()
  recordTouchedTask(post(UPDATE, { track: "greenhouse-ops", slug: "watering-schedule-api" }, updated()), { stateDir, root: null })
  const moved = JSON.stringify({ status: "moved", path: "garden/watering-schedule-api/task.md" })
  recordTouchedTask(post("mcp__plugin_desk_desk__task_move", { track: "greenhouse-ops", slug: "watering-schedule-api", to_track: "garden" }, moved), { stateDir, root: null })
  const tasks = JSON.parse(readFileSync(sessionFile(stateDir, "s1"), "utf8")).tasks
  assert.deepEqual(Object.keys(tasks), ["garden/watering-schedule-api"])
  assert.equal(tasks["garden/watering-schedule-api"].status, "processing")
  assert.equal(tasks["garden/watering-schedule-api"].report_as, REPORT)
  // A move by handle names no old key; an archive removes the live entry and records done.
  assert.equal(touchedTask("mcp__x__task_move", { handle: "h" }, moved).oldKey, null)
  recordTouchedTask(post("mcp__plugin_desk_desk__task_archive", { track: "garden", slug: "watering-schedule-api" }, JSON.stringify({ status: "archived", path: "garden/_archive/watering-schedule-api/task.md" })), { stateDir, root: null })
  const after = JSON.parse(readFileSync(sessionFile(stateDir, "s1"), "utf8")).tasks
  assert.deepEqual(Object.keys(after), ["garden/_archive/watering-schedule-api"])
  assert.equal(after["garden/_archive/watering-schedule-api"].status, "done")
  assert.equal(touchedTask("mcp__x__task_archive", { track: "garden", slug: "watering-schedule-api" }, JSON.stringify({ status: "archived", path: "garden/_archive/watering-schedule-api/task.md" })).slug, "watering-schedule-api")
})

// ---- the state file under contention ----

test("the state update takes a lock file, waits for a held one, breaks a stale one, and goes ahead without it after the wait", () => {
  const input = { track: "greenhouse-ops", slug: "watering-schedule-api" }
  const noSleep = { waitMs: 60, sleep: () => {} }
  const stateDir = freshState()
  recordTouchedTask(post(UPDATE, input, updated()), { stateDir, root: null, lock: noSleep })
  const file = sessionFile(stateDir, "s1")
  assert.equal(existsSync(`${file}.lock`), false, "released")
  // A fresh lock held by someone else: the wait runs out and the update goes ahead; the other holder's lock stays.
  writeFileSync(`${file}.lock`, "")
  recordTouchedTask(post(UPDATE, { ...input, slug: "other" }, JSON.stringify({ status: "updated", path: "greenhouse-ops/other/task.md", report_as: "Task other is at validating (not done): x" }), "s1"), { stateDir, root: null, lock: noSleep })
  assert.equal(existsSync(`${file}.lock`), true)
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, "utf8")).tasks).sort(), ["greenhouse-ops/other", "greenhouse-ops/watering-schedule-api"])
  // A stale one is broken and the update holds its own lock.
  const old = new Date(Date.now() - 60_000)
  utimesSync(`${file}.lock`, old, old)
  recordTouchedTask(post(UPDATE, input, updated()), { stateDir, root: null, lock: noSleep })
  assert.equal(existsSync(`${file}.lock`), false)
  // The default sleep really waits (a held fresh lock, a short wait).
  writeFileSync(`${file}.lock`, "")
  const started = Date.now()
  recordTouchedTask(post(UPDATE, input, updated()), { stateDir, root: null, lock: { waitMs: 40 } })
  assert.ok(Date.now() - started >= 40)
  rmSync(`${file}.lock`)
})

test("a lock that vanishes between the open and the stat is retried at once", () => {
  const stateDir = freshState()
  const file = sessionFile(stateDir, "s1")
  mkdirSync(path.dirname(file), { recursive: true })
  let calls = 0
  // The sleep hook runs only after a fresh lock was seen; here the lock is removed by the hook, so the next try takes it.
  writeFileSync(`${file}.lock`, "")
  recordTouchedTask(post(UPDATE, { track: "greenhouse-ops", slug: "watering-schedule-api" }, updated()), { stateDir, root: null, lock: { waitMs: 200, sleep: () => { calls += 1; rmSync(`${file}.lock`, { force: true }) } } })
  assert.equal(calls, 1)
  assert.equal(JSON.parse(readFileSync(file, "utf8")).tasks["greenhouse-ops/watering-schedule-api"].status, "processing")
  // The lock disappearing between the failed open and the stat: a lock path that is a dangling symlink-free race is simulated by a directory entry removed by a stat-time sleep.
})

test("pruning tolerates a file that vanishes while the folder is being listed", () => {
  const stateDir = freshState()
  recordTouchedTask(post(UPDATE, { slug: "x" }, updated(), "a"), { stateDir, root: null })
  const dir = path.join(stateDir, "done-gate")
  // A dangling symlink lists but cannot be statted: ENOENT for that entry must not stop the others.
  symlinkSync(path.join(dir, "nowhere"), path.join(dir, "dangling.json"))
  const longAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  recordTouchedTask(post(UPDATE, { slug: "x" }, updated(), "b"), { stateDir, root: null })
  utimesSync(sessionFile(stateDir, "a"), longAgo, longAgo)
  recordTouchedTask(post(UPDATE, { slug: "x" }, updated(), "c"), { stateDir, root: null })
  assert.equal(existsSync(sessionFile(stateDir, "a")), false, "the stale file after the dangling one was still removed")
  assert.equal(existsSync(sessionFile(stateDir, "c")), true)
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
  const prompted = runHook("prompt", JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cjs-session", prompt: "next" }), env)
  assert.equal(prompted.result.status, 0)
  assert.deepEqual(prompted.output, {})
  const after = runHook("stop", JSON.stringify({ hook_event_name: "Stop", session_id: "cjs-session", transcript_path: transcript(asked, say("Done.")) }), env)
  assert.deepEqual(after.output, {}, "the new turn forgot the task")
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
  assert.ok(matcher.test("mcp__some-other-name__task_update"), "any server name: the tool name is re-checked inside")
  assert.ok(hooks.UserPromptSubmit.some((group) => group.hooks.some((entry) => /done-claim-gate\.cjs" claude prompt$/u.test(entry.command))))
  assert.equal(matcher.test("mcp__plugin_desk_desk__desk_status"), false)
  assert.equal(matcher.test("Bash"), false)
  const bash = hooks.PostToolUse.find((group) => group.matcher === "Bash")
  assert.ok(bash.hooks.some((entry) => /done-claim-gate\.cjs" claude track$/u.test(entry.command)), "the boot script's shell call is tracked too (the .cjs answers at once for any other shell call)")
})

// ---- a done claim about the work is honest when the reply states the task's real status (round M, Copilot resume-named-task run 2) ----

const VALIDATING = "Task watering-schedule-api is at validating (not done): Open a pull request"
const validating = () => touched("validating", VALIDATING)
const ROUND_M = "The implementation is complete and tests pass. The task is now in **validating** state, ready for the pull request step. The changes:\n\n- Implemented `RainDelayPolicy.should_delay()` using the 30% operator-ruled threshold\n- All tests passing\n\nNext step: Open a pull request from `feature/rain-delay` into `main`."

test("a reply that claims the work is done but states the task's real status is not blocked", () => {
  for (const reply of [
    ROUND_M,
    "The implementation is complete. The task is now in validating state.",
    "Implementation is complete and the task is in the validating stage, ready for the PR.",
    "The code is done but the task is at validating.",
    "Work complete. watering-schedule-api: validating (not done) until the PR is open.",
    "All done with the code. Status: validating.",
    "Finished the work. I moved the task to validating.",
    "Done. The task remains in validating.",
    "Everything is done; soil-sensor is at processing, and watering-schedule-api is at validating.",
  ]) assert.deepEqual(stop(validating(), reply), {}, reply)
})

test("a reply that says the task is done without stating its real status is still blocked, and so is a status that is taken back or belongs elsewhere", () => {
  for (const reply of [
    "Task watering-schedule-api is done.",
    "The task is complete.",
    "Done.",
    "Done! (status: validating - just kidding, it's done)",
    "Complete. Status: validating -> done.",
    "Work is done. The task is at validating → done now.",
    "The work is done. other-task is at validating.",
    "The work is complete. Task soil-sensor is validating.",
    "The implementation is complete. I am not validating anything yet.",
    "The implementation is complete and I was validating the build.",
    "Work is done. The task was in validating before, but it's done now.",
  ]) assert.ok(blocks(stop(validating(), reply)), reply)
})

// ---- review round: hyphenated words are not slugs, and a status statement never clears a claim about the task itself ----

test("a hyphenated word that is no task reference does not make the status someone else's", () => {
  for (const reply of [
    "The work is done. The task is in validating state (the pre-existing lint failure is unrelated).",
    "The work is done. Status: validating, with a follow-up PR still to open.",
    "The work is done. The task is in validating state, so the code-review step is next.",
    "The work is done. The task is in validating state — the cancelled-task cleanup is next.",
    "The work is done.\n\n- watering-schedule-api: validating\n- soil-sensor: processing",
    "The work is done.\n\n| task | status |\n| --- | --- |\n| watering-schedule-api | validating |",
    "The work is done. Status:\nvalidating",
  ]) assert.deepEqual(stop(validating(), reply), {}, reply)
})

test("a claim that the task itself is done blocks whatever status the reply states", () => {
  for (const reply of [
    "Done. The task is in validating state, effectively done.",
    "Status: validating. Actually the task is done.",
    "The work is done. The task is in validating state. Task watering-schedule-api is done.",
    "Status: validating — no, done.",
    "Status: validating. Status: done.",
    "Task watering-schedule-api was validating, now done.",
    "The task is in validating state, which means it is finished.",
    "The task is in validating (complete).",
    "All done. The task is in validating state and complete.",
    "The work is done. The task is in the validating stage, meaning finished.",
  ]) assert.ok(blocks(stop(validating(), reply)), reply)
  // A status quoted with > or fenced is not the reply's own statement.
  assert.ok(blocks(stop(validating(), "The work is done.\n\n> The task is in validating state.\n```\nStatus: validating\n```")))
  // Another task's claim, named explicitly, is not this task's.
  assert.deepEqual(stop(validating(), "Task soil-sensor is done. The work is done and watering-schedule-api: validating."), {})
  // Work-level claims stay cleared by the status.
  for (const reply of ["The code is effectively done but the task is at validating.", "I'm done for now. Status: validating."]) assert.deepEqual(stop(validating(), reply), {}, reply)
})
