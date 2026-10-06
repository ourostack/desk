// task_update's `note` and `next_step`: the only way an agent records progress on a task card, because a direct
// edit of the card is refused by the desk repository's pre-commit hook.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { appendProgressNote, localDate, replaceNextStep } from "../../../../../plugins/desk/mcp/src/tools/task-body.js"
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

test("a marker or heading quoted inside a fenced code block is not the card's own", () => {
  const body = "```md\n**Next step:** quoted\n## Progress log\n```\n\n**Next step:** real\n\n~~~\n## Progress log\n~~~\n"
  assert.equal(replaceNextStep(body, "new"), "```md\n**Next step:** quoted\n## Progress log\n```\n\n**Next step:** new\n\n~~~\n## Progress log\n~~~\n")
  const noReal = "```\n**Next step:** quoted\n```\n"
  assert.equal(replaceNextStep(noReal, "new"), "```\n**Next step:** quoted\n```\n\n**Next step:** new\n")
  const fenced = "```\n## Progress log\n- x\n```\n"
  assert.equal(appendProgressNote(fenced, "n", "d"), "```\n## Progress log\n- x\n```\n\n## Progress log\n\n- d: n\n")
  const real = "## Progress log\n\n```\n## Other\n```\n- a\n## Next\n"
  assert.equal(appendProgressNote(real, "n", "d"), "## Progress log\n\n```\n## Other\n```\n- a\n- d: n\n## Next\n")
  const longer = "````\n```\n## Progress log\n````\n"
  assert.equal(appendProgressNote(longer, "n", "d").endsWith("## Progress log\n\n- d: n\n"), true)
})

test("the next-step paragraph ends at a blank line, a list item, a heading or a fence", () => {
  assert.equal(replaceNextStep("**Next step:** a\n- item\nmore\n", "b"), "**Next step:** b\n- item\nmore\n")
  assert.equal(replaceNextStep("**Next step:** a\n1. one\n", "b"), "**Next step:** b\n1. one\n")
  assert.equal(replaceNextStep("**Next step:** a\ncont\n```\ncode\n```\n", "b"), "**Next step:** b\n```\ncode\n```\n")
})

test("duplicate next-step markers: the first outside a fence is replaced and the later ones go", () => {
  const body = "Intro\n\n**Next step:** one\n\n**Next step:** two\nstill two\n\nTail\n\n**Next step:** three"
  assert.equal(replaceNextStep(body, "new"), "Intro\n\n**Next step:** new\n\nTail\n")
  assert.equal(replaceNextStep("**Next step:** a\n**Next step:** b\n", "n"), "**Next step:** n\n")
})

test("CRLF cards stay CRLF", () => {
  assert.equal(replaceNextStep("A\r\n\r\n**Next step:** x\r\ny\r\n\r\nB\r\n", "n"), "A\r\n\r\n**Next step:** n\r\n\r\nB\r\n")
  assert.equal(replaceNextStep("A\r\n", "n"), "A\r\n\r\n**Next step:** n\r\n")
  assert.equal(appendProgressNote("A\r\n\r\n## Progress log\r\n\r\n- a\r\n", "n", "d"), "A\r\n\r\n## Progress log\r\n\r\n- a\r\n- d: n\r\n")
  assert.equal(appendProgressNote("A\r\n", "n", "d"), "A\r\n\r\n## Progress log\r\n\r\n- d: n\r\n")
})

test("a note is dated in the operator's local time zone", () => {
  assert.equal(localDate(new Date(2026, 8, 30, 23, 30)), "2026-09-30")
  assert.equal(localDate(new Date(2026, 0, 5, 0, 5)), "2026-01-05")
  assert.match(localDate(), /^\d{4}-\d{2}-\d{2}$/u)
})
