// task_update's `note` and `next_step`: the only way an agent records progress on a task card, because a direct
// edit of the card is denied (runtime/task-status-guard.js).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { appendProgressNote, replaceNextStep } from "../../../../../plugins/desk/mcp/src/tools/task-body.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"
import { mkTempDeskRoot } from "./_helpers.js"

test("replaceNextStep replaces the whole paragraph and nothing around it", () => {
  const body = "## Current work\n\nDoing it.\n\n**Next step:** wire the check into\nthe policy and add a test.\nStill the same paragraph.\n\n## Ruling\n\nUse 30%.\n"
  assert.equal(
    replaceNextStep(body, "open the PR\nand wait for checks"),
    "## Current work\n\nDoing it.\n\n**Next step:** open the PR and wait for checks\n\n## Ruling\n\nUse 30%.\n",
  )
  assert.equal(replaceNextStep("**Next step:** a\n## H\n", "b"), "**Next step:** b\n## H\n")
  assert.equal(replaceNextStep("**Next step:** a", "b"), "**Next step:** b")
})

test("replaceNextStep adds the paragraph when the card has none", () => {
  assert.equal(replaceNextStep("Hello\n\n", "go"), "Hello\n\n**Next step:** go\n")
  assert.equal(replaceNextStep("", "go"), "**Next step:** go\n")
})

test("appendProgressNote adds a dated bullet to the end of the Progress log section", () => {
  const body = "Intro\n\n## Progress log\n\n- 2026-09-01: first\n\n## Ruling\n\nUse 30%.\n"
  assert.equal(
    appendProgressNote(body, "second\nline", "2026-09-30"),
    "Intro\n\n## Progress log\n\n- 2026-09-01: first\n- 2026-09-30: second line\n\n## Ruling\n\nUse 30%.\n",
  )
  assert.equal(appendProgressNote("## Progress log", "x", "2026-09-30"), "## Progress log\n\n- 2026-09-30: x")
  assert.equal(appendProgressNote("## Progress log\n\n- a\n", "x", "d"), "## Progress log\n\n- a\n- d: x\n")
})

test("appendProgressNote creates the section at the end of a card that has none", () => {
  assert.equal(appendProgressNote("Intro\n", "x", "2026-09-30"), "Intro\n\n## Progress log\n\n- 2026-09-30: x\n")
  assert.equal(appendProgressNote("", "x", "2026-09-30"), "## Progress log\n\n- 2026-09-30: x\n")
})

test("task_update records a note and a next step on the card, in the body, with the card's own frontmatter intact", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T", body: "**Next step:** old one." } })
  const filePath = path.join(root, "t", "book-flights", "task.md")
  const result = await task_update({
    deskRoot: root,
    input: { track: "t", slug: "book-flights", note: "opened the branch", next_step: "open the PR", body_append: "Extra." },
  })
  assert.equal(result.status, "updated")
  const text = await fs.readFile(filePath, "utf8")
  assert.match(text, /\*\*Next step:\*\* open the PR\n/u)
  assert.doesNotMatch(text, /old one/u)
  assert.match(text, /## Progress log\n\n- \d{4}-\d{2}-\d{2}: opened the branch\n/u)
  assert.match(text, /Extra\.\n?$/u)
  assert.match(text, /^status: /mu)
})

test("task_update refuses an empty or non-string note or next_step before writing anything", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "book-flights", title: "T", body: "Hello" } })
  const filePath = path.join(root, "t", "book-flights", "task.md")
  const before = await fs.readFile(filePath, "utf8")
  for (const input of [{ note: "  " }, { note: 5 }, { next_step: "" }, { next_step: null }]) {
    await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "book-flights", ...input } }), /must be a non-empty string/u)
  }
  assert.equal(await fs.readFile(filePath, "utf8"), before)
})

test("the task_update schema declares note and next_step", () => {
  const properties = TOOL_INPUT_SCHEMAS.task_update.properties
  assert.match(properties.note.description, /Progress log/u)
  assert.match(properties.next_step.description, /Next step/u)
})
