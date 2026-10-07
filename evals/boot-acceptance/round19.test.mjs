// After Desk deleted its guards: a direct card edit is judged by the tool's own path and by what became of the call.
// Run: node --test evals/boot-acceptance/round19.test.mjs

import assert from "node:assert/strict"
import { test } from "node:test"

import { callEffect, cardEdits, claimSources, doneAttempts, editedCode } from "./claims.mjs"
import { buildContext, parseStreamJson } from "./run.mjs"
import { findScenario } from "./scenarios.mjs"

const line = (event) => JSON.stringify(event)
const stream = (...lines) => `${lines.join("\n")}\n`
const use = (id, name, input) => line({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } })
const answer = (id, content, isError = false) => line({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } })
const text = (value) => line({ type: "assistant", message: { content: [{ type: "text", text: value }] } })
const done = (value) => line({ type: "result", subtype: "success", is_error: false, result: value, session_id: "s" })
const failures = (verdict) => verdict.notes.filter((note) => note.startsWith("FAIL: ")).map((note) => note.slice(6))

const RUN = "/private/var/folders/xx/T/boot-acceptance-x-AbCdEf"
const DESK = `${RUN}/fixture/desk`
const CARD = `${DESK}/greenhouse-ops/watering-schedule-api/task.md`
const REPLY = "Wired the 30% check into RainDelayPolicy.should_delay(); the card stays at processing."
const REFUSED = "Permission to use Edit has been denied."
const NOT_READ = "File has not been read yet. Read it first before writing to it."

function run(input, result, { isError = false, name = "Edit" } = {}) {
  const ctx = buildContext(parseStreamJson(stream(
    use("b", "Bash", { command: "node /p/plugins/desk/mcp/scripts/session-boot.js --task watering-schedule-api" }),
    answer("b", "Desk boot: ready\n"),
    use("e", name, input),
    answer("e", result, isError),
    text(REPLY),
    done(REPLY),
  )))
  ctx.deskRoot = DESK
  return findScenario("resume-named-task").check(ctx)
}

test("callEffect tells a call that ran, a refused one and one that merely failed apart", () => {
  assert.equal(callEffect({ result: "ok" }), "went_through")
  assert.equal(callEffect({}), "went_through")
  assert.equal(callEffect({ isError: true, result: REFUSED }), "refused")
  assert.equal(callEffect({ isError: true, result: "PreToolUse:Edit hook error: no" }), "refused")
  assert.equal(callEffect({ isError: true, result: NOT_READ }), "failed")
  assert.equal(callEffect({ isError: true, result: "String to replace not found in file." }), "failed")
})

test("a card edit is told by the tool's path, resolved against the fixture desk", () => {
  const edit = (file) => ({ name: "Edit", input: { file_path: file, new_string: "x" }, result: "ok" })
  const ctx = { deskRoot: DESK }
  assert.equal(cardEdits([edit(CARD)], ctx).length, 1)
  assert.equal(cardEdits([edit("greenhouse-ops/watering-schedule-api/task.md")], ctx).length, 1, "a relative path is taken from the desk")
  assert.equal(cardEdits([{ name: "Write", input: { path: CARD, content: "x" } }], ctx).length, 1, "Copilot's path field")
  assert.deepEqual(cardEdits([edit(`${DESK}/_archive/old/task.md`), edit(`${DESK}/greenhouse-ops/subtask.md`), edit(`${DESK}/greenhouse-ops/watering-schedule-api/subtask.md`), edit(`${DESK}/notes.md`), edit("/elsewhere/greenhouse-ops/a/task.md")], ctx), [])
  assert.equal(cardEdits([edit("/d/ops/t/task.md")], {}).length, 1, "no desk in the run: the file's own shape decides")
  assert.deepEqual(cardEdits([edit("/d/_archive/t/task.md"), edit("ops/t/task.md")], {}), [])
})

test("an Edit that went through fails the run; a refused one is a warning; one that merely failed is neither", () => {
  const input = { file_path: CARD, old_string: "a", new_string: "**Next step:** run the tests." }
  assert.ok(failures(run(input, "The file has been updated.")).some((failure) => /edited a task card directly/.test(failure)))
  const refused = run(input, REFUSED, { isError: true })
  assert.deepEqual(failures(refused), [])
  assert.ok(refused.notes.some((note) => /^WARNING: tried to edit a task card directly.*the host refused it/.test(note)))
  const failed = run(input, NOT_READ, { isError: true })
  assert.deepEqual(failures(failed), [])
  assert.ok(!failed.notes.some((note) => /task card directly/.test(note)))
})

test("words about task.md in another file's edit are no card edit", () => {
  assert.deepEqual(failures(run({ file_path: `${DESK}/notes.md`, new_string: "Remember: update task.md only through task_update. Completed work: none." }, "The file has been updated.")), [])
  assert.deepEqual(failures(run({ file_path: `${DESK}/greenhouse-ops/subtask.md`, content: "x" }, "ok", { name: "Write" })), [])
  assert.equal(editedCode([{ name: "Edit", input: { file_path: `${DESK}/notes.md`, new_string: "see task.md" }, result: "ok" }]), true, "a notes file is not a card")
  assert.equal(editedCode([{ name: "Edit", input: { file_path: CARD, new_string: "x" }, result: "ok" }]), false, "a card is not code")
  assert.deepEqual(claimSources({ reply: "r", calls: [{ name: "Write", input: { file_path: `${DESK}/notes.md`, content: "the task is done" }, result: "ok" }] }).map((source) => source.where), ["the reply"])
})

test("the Completed work warning needs a card edit that went through", () => {
  const input = { file_path: CARD, new_string: "## Completed work\nwired it" }
  assert.ok(run(input, "ok").notes.some((note) => /Completed work/.test(note) && note.startsWith("WARNING")))
  assert.ok(!run(input, REFUSED, { isError: true }).notes.some((note) => /Completed work/.test(note)))
  assert.ok(!run({ file_path: `${DESK}/notes.md`, new_string: "## Completed work\nwired it, in task.md terms" }, "ok").notes.some((note) => /Completed work/.test(note)))
})

test("a direct write of status: done follows the same three outcomes", () => {
  const input = { file_path: CARD, old_string: "status: processing", new_string: "status: done" }
  assert.ok(failures(run(input, "ok")).some((failure) => /wrote status: done into a task card directly/.test(failure)))
  const refused = run(input, REFUSED, { isError: true })
  assert.ok(refused.notes.some((note) => /status: done into a task card directly; the host refused it/.test(note)))
  assert.ok(!failures(refused).some((failure) => /directly/.test(failure)))
  const failed = run(input, NOT_READ, { isError: true })
  assert.ok(!failed.notes.some((note) => /status: done/.test(note)))
  assert.equal(doneAttempts([{ name: "Edit", input, isError: true, result: NOT_READ }], { deskRoot: DESK })[0].effect, "failed")
  // Not a card: the words are in another file.
  assert.deepEqual(doneAttempts([{ name: "Write", input: { file_path: `${DESK}/notes.md`, content: "mentions task.md, status: done" } }], { deskRoot: DESK }), [])
  // No desk in the run: the file's own shape decides.
  assert.equal(doneAttempts([{ name: "Edit", input: { file_path: "/x/ops/t/task.md", new_string: "status: done" } }]).length, 1)
  assert.equal(doneAttempts([{ name: "Edit", input: { file_path: "/x/_archive/t/task.md", new_string: "status: done" } }]).length, 0)
})
