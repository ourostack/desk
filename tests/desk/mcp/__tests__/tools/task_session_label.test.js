import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { taskFocus } from "../../../../../plugins/desk/mcp/src/tools/task-focus.js"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { createFocusHolder } from "../../../../../plugins/desk/mcp/src/runtime/desk-session.js"
import { mkTempDeskRoot, readFront } from "./_helpers.js"

const target = { track: "engineering", slug: "workflow-review" }
const label = "Workflow promotion review"
const expected = {
  proposal: { version: 1, task: target, text: label, phase: "unknown", origin: "automatic" },
}
const context = () => ({ focus: createFocusHolder() })

async function create(deskRoot, input = {}, statusContext = context()) {
  return task_create({
    deskRoot,
    input: { ...target, title: "A card title is not a safe display label", status: "processing", ...input },
    statusContext,
  })
}

test("successful focus returns an authored proposal without writing the card", async () => {
  const deskRoot = await mkTempDeskRoot()
  await create(deskRoot)
  const file = path.join(deskRoot, target.track, target.slug, "task.md")
  const before = await fs.readFile(file)
  const identity = await fs.stat(file, { bigint: true })
  const result = await taskFocus({ deskRoot, input: { ...target, display_label: label }, statusContext: context() })
  assert.equal(result.status, "focused")
  assert.deepEqual(result.session_label, expected)
  assert.deepEqual(await fs.readFile(file), before)
  const after = await fs.stat(file, { bigint: true })
  for (const field of ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) assert.equal(after[field], identity[field], field)
})

test("focused create returns a transient proposal, not a card field or a native-name claim", async () => {
  const deskRoot = await mkTempDeskRoot()
  const result = await create(deskRoot, { focus: true, display_label: label })
  assert.equal(result.focused, true)
  assert.deepEqual(result.session_label, expected)
  const card = await readFront(path.join(deskRoot, target.track, target.slug, "task.md"))
  assert.equal(Object.hasOwn(card.data, "display_label"), false)
  assert.equal(Object.hasOwn(card.data, "session_label"), false)
  assert.equal(card.content.includes(label), false)
})

test("only the actual focused target can propose from an update", async () => {
  const deskRoot = await mkTempDeskRoot()
  const statusContext = context()
  await create(deskRoot, { focus: true }, statusContext)
  const updated = await task_update({
    deskRoot, input: { ...target, note: "Reviewed the boundary", display_label: label }, statusContext,
  })
  assert.equal(updated.status, "updated")
  assert.deepEqual(updated.session_label, expected)
  const card = await readFront(path.join(deskRoot, target.track, target.slug, "task.md"))
  assert.equal(Object.hasOwn(card.data, "display_label"), false)
  assert.equal(card.content.includes(label), false)

  const other = { track: target.track, slug: "browser-qualification" }
  await create(deskRoot, other, statusContext)
  const unfocused = await task_update({ deskRoot, input: { ...other, display_label: label }, statusContext })
  assert.deepEqual(unfocused.session_label, { state: "unavailable", code: "awaiting_focus" })
  assert.deepEqual(statusContext.focus.get(), target)
})

test("unsafe and omitted labels do not break the successful focus observation", async () => {
  const deskRoot = await mkTempDeskRoot()
  const statusContext = context()
  const created = await create(deskRoot, { focus: true, display_label: "/private/example" }, statusContext)
  assert.equal(created.status, "created")
  assert.deepEqual(created.session_label, { state: "unavailable", code: "unsafe_label" })
  const focused = await taskFocus({ deskRoot, input: target, statusContext })
  assert.equal(focused.status, "focused")
  assert.deepEqual(focused.session_label, { state: "unavailable", code: "missing_safe_label" })
  const updated = await task_update({ deskRoot, input: { ...target, note: "Continuing" }, statusContext })
  assert.deepEqual(updated.session_label, { state: "unavailable", code: "missing_safe_label" })
})

test("a parked create cannot change the current task's display proposal", async () => {
  const deskRoot = await mkTempDeskRoot()
  const statusContext = context()
  await create(deskRoot, { focus: true }, statusContext)
  const parked = await create(deskRoot, { slug: "parked-followup", display_label: label }, statusContext)
  assert.deepEqual(parked.session_label, { state: "unavailable", code: "awaiting_focus" })
  assert.deepEqual(statusContext.focus.get(), target)
  const withoutLabel = await create(deskRoot, { slug: "another-followup" }, statusContext)
  assert.equal(Object.hasOwn(withoutLabel, "session_label"), false)
})

test("clearing is unchanged and cannot be combined with a display label", async () => {
  const deskRoot = await mkTempDeskRoot()
  const statusContext = context()
  await create(deskRoot, { focus: true }, statusContext)
  await assert.rejects(taskFocus({ deskRoot, input: { clear: true, display_label: label }, statusContext }), /clear.*display_label/u)
  assert.deepEqual(statusContext.focus.get(), target)
  assert.deepEqual(await taskFocus({ deskRoot, input: { clear: true }, statusContext }), { status: "cleared" })
  const updated = await task_update({ deskRoot, input: { ...target, display_label: label }, statusContext })
  assert.deepEqual(updated.session_label, { state: "unavailable", code: "awaiting_focus" })
})

test("failed operations leave the current focus and do not produce a label", async () => {
  const deskRoot = await mkTempDeskRoot()
  const statusContext = context()
  await create(deskRoot, { focus: true }, statusContext)
  await assert.rejects(taskFocus({ deskRoot, input: { ...target, slug: "missing-task", display_label: label }, statusContext }), /card not found/u)
  await assert.rejects(create(deskRoot, { focus: true, display_label: label }, statusContext), /already exists/u)
  await assert.rejects(task_update({ deskRoot, input: { ...target, status: "done", display_label: label }, statusContext }), /needs evidence/u)
  assert.deepEqual(statusContext.focus.get(), target)
})

test("a create without the session focus holder cannot claim a focused label", async () => {
  const deskRoot = await mkTempDeskRoot()
  const result = await create(deskRoot, { focus: true, display_label: label }, {})
  assert.equal(result.focused, undefined)
  assert.deepEqual(result.session_label, { state: "unavailable", code: "awaiting_focus" })
})

test("punctuation-prefixed credentials never return in a focused proposal", async () => {
  const deskRoot = await mkTempDeskRoot()
  await create(deskRoot)
  for (const separator of ["-", ".", "_"]) {
    const display_label = `Review prod${separator}ghp_${"Gz".repeat(18)}`
    const result = await taskFocus({ deskRoot, input: { ...target, display_label }, statusContext: context() })
    assert.equal(result.status, "focused")
    assert.deepEqual(result.session_label, { state: "unavailable", code: "unsafe_label" })
    assert.equal(JSON.stringify(result).includes(display_label), false)
  }
})
