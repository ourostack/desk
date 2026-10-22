// Boot and the task tools say only what helps: a next step past the first 64 KB is found, an oversized card is named,
// pending repo checks collapse, session_label is left out when no label was proposed, and replace_section slims a card.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { mkdirSync, writeFileSync, statSync } from "node:fs"
import * as path from "node:path"
import { promises as fs } from "node:fs"
import { activeTasks } from "../../../../../plugins/desk/mcp/src/desk/active-tasks.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { replaceSection } from "../../../../../plugins/desk/mcp/src/tools/task-body.js"
import { mkTempDeskRoot } from "./_helpers.js"

async function bigCard(body) {
  const root = await mkTempDeskRoot()
  const dir = path.join(root, "t", "big")
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, "task.md"), `---\ntitle: Big\nstatus: processing\nupdated: "2026-10-01T00:00:00Z"\n---\n${body}`)
  return root
}

const filler = (kb) => `${"history line with some words in it\n".repeat(Math.ceil((kb * 1024) / 35))}\n`

test("boot finds the next step past the first 64 KB", async () => {
  const root = await bigCard(`${filler(100)}**Next step:** open the PR\nand wait é for checks.\n\n## Progress log\n`)
  const { tracks } = await activeTasks(root)
  assert.equal(tracks[0].tasks[0].next_step, "open the PR and wait é for checks.")
})

test("the tail scan ignores a marker inside a fence and finds the real one", async () => {
  const root = await bigCard(`${filler(70)}\`\`\`\n**Next step:** quoted\n\`\`\`\n\n${filler(70)}**Next step:** real one\n`)
  const { tracks } = await activeTasks(root)
  assert.equal(tracks[0].tasks[0].next_step, "real one")
})

test("a big card with no next step is named, never reported as having none", async () => {
  const root = await bigCard(filler(100))
  const { tracks, task_count } = await activeTasks(root)
  assert.equal(task_count, 1)
  assert.equal(tracks[0].tasks[0].next_step, null)
  assert.ok(tracks[0].tasks[0].card_kb >= 100)
  const text = formatBootText({ status: "ok", tasks: undefined, active_tasks: { tracks, task_count, track_count: 1 }, instructions: [] })
  assert.match(text, /card is \d+ KB; move history into its iteration folder/u)
  assert.doesNotMatch(text, /no next step recorded/u)
})

test("a small card has no size hint", async () => {
  const root = await bigCard("**Next step:** x\n")
  const { tracks } = await activeTasks(root)
  assert.equal(tracks[0].tasks[0].card_kb, undefined)
})

test("pending repo checks collapse to one line per kind with a count", () => {
  const pending = [
    ...Array.from({ length: 62 }, (_, i) => `repo state for repo${i} (t/task${i % 3}): boot_budget_exceeded`),
    "repo state for repo0 (t/other): boot_budget_exceeded",
    "open pull requests for a/b: boot_budget_exceeded",
    "open pull requests for a/c: boot_budget_exceeded",
    "improvement: boot_budget_exceeded",
  ]
  const text = formatBootText({ status: "ok", pending, instructions: [] })
  assert.equal(text.match(/Repo state not checked/gu).length, 1)
  assert.match(text, /Repo state not checked for 62 repos \(boot ran out of time\); check a repo with git when you work in it\./u)
  assert.match(text, /Open pull requests not checked for 2 repos/u)
  assert.match(text, /pending \(not finished in time, carry it\): improvement: boot_budget_exceeded/u)
  assert.doesNotMatch(text, /repo state for repo/u)
})

test("a next step on the last line with no trailing newline is found; one inside an unclosed fence is not", async () => {
  const found = await activeTasks(await bigCard(`${filler(100)}**Next step:** last line`))
  assert.equal(found.tracks[0].tasks[0].next_step, "last line")
  const fenced = await activeTasks(await bigCard(`${filler(100)}\`\`\`\n**Next step:** inside`))
  assert.equal(fenced.tracks[0].tasks[0].next_step, null)
})

test("a single pending repo is counted in the singular, and push-account lines collapse too", () => {
  const text = formatBootText({ status: "ok", instructions: [], pending: [
    "repo state for only (t/x): boot_budget_exceeded",
    "open pull requests for a/b: boot_budget_exceeded",
    ...Array.from({ length: 80 }, (_, i) => `push account for o/r${i % 40} (t/task${i}): boot_budget_exceeded`),
  ] })
  assert.match(text, /Repo state not checked for 1 repo \(/u)
  assert.match(text, /Open pull requests not checked for 1 repo \(/u)
  assert.match(text, /Push route not checked for 40 repos \(boot ran out of time\); run gh auth status before you push\./u)
  assert.doesNotMatch(text, /push account for/u)
  const one = formatBootText({ status: "ok", instructions: [], pending: ["push account for o/r (t/x): boot_budget_exceeded"] })
  assert.match(one, /Push route not checked for 1 repo \(/u)
})

test("task tools omit session_label when no label was proposed and keep it when one was", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "a-task", title: "T", body: "x" } })
  const plain = await task_update({ deskRoot: root, input: { track: "t", slug: "a-task", note: "hi" } })
  assert.equal(Object.hasOwn(plain, "session_label"), false)
  const labelled = await task_update({ deskRoot: root, input: { track: "t", slug: "a-task", note: "hi", display_label: "Plain label" } })
  assert.ok(labelled.session_label)
})

test("replaceSection replaces one named section, appends a missing one and respects fences", () => {
  const body = "Intro\n\n## Progress log\n\n- old\n\n```\n## Not a heading\n```\n\n## Ruling\n\nUse 30%.\n"
  assert.equal(replaceSection(body, "Progress log", "- new"), "Intro\n\n## Progress log\n\n- new\n\n## Ruling\n\nUse 30%.\n")
  assert.equal(replaceSection("Intro\n", "Notes", "text"), "Intro\n\n## Notes\n\ntext\n")
  assert.equal(replaceSection("## A\n\nx\n\n```\n## Notes\n```\n", "Notes", "t"), "## A\n\nx\n\n```\n## Notes\n```\n\n## Notes\n\nt\n")
  assert.throws(() => replaceSection(body, "Ruling", "## Other\nx"), /own `## ` heading/u)
  assert.throws(() => replaceSection(body, "", "x"), /heading/u)
  assert.throws(() => replaceSection(body, 5, "x"), /heading/u)
  assert.throws(() => replaceSection(body, "Steps", "x"), /`step` field/u)
  assert.throws(() => replaceSection(body, "## resources", "x"), /`resource` field/u)
  assert.throws(() => replaceSection(body, "Ruling", "```\nunclosed code"), /close the code fence/u)
  assert.equal(replaceSection("## A\n\nx\n", "A", "```\ncode\n```"), "## A\n\n```\ncode\n```\n")
  assert.throws(() => replaceSection(body, "Ruling", "  "), /not empty/u)
})

test("task_update replace_section replaces one section and leaves the frontmatter alone", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "a-task", title: "T", body: "## Ruling\n\nold text\n\n## Other\n\nkeep\n" } })
  const result = await task_update({ deskRoot: root, input: { track: "t", slug: "a-task", replace_section: { heading: "Ruling", markdown: "new text" } } })
  assert.equal(result.status, "updated")
  const raw = await fs.readFile(path.join(root, "t", "a-task", "task.md"), "utf8")
  assert.match(raw, /## Ruling\n\nnew text\n\n## Other\n\nkeep/u)
  assert.match(raw, /^---\n(?:.*\n)*?title: T\n(?:.*\n)*?---\n/u)
  await assert.rejects(task_update({ deskRoot: root, input: { track: "t", slug: "a-task", replace_section: { heading: "Ruling" } } }), /replace_section/u)
})

test("task_update warns when the card exceeds 64 KB, and not otherwise", async () => {
  const root = await mkTempDeskRoot()
  await task_create({ deskRoot: root, input: { track: "t", slug: "a-task", title: "T", body: "x" } })
  const small = await task_update({ deskRoot: root, input: { track: "t", slug: "a-task", note: "hi" } })
  assert.equal(small.card_size_warning, undefined)
  const big = await task_update({ deskRoot: root, input: { track: "t", slug: "a-task", body_append: filler(70) } })
  assert.match(big.card_size_warning, /card is \d+ KB.*iteration folder/u)
  assert.ok(statSync(path.join(root, "t", "a-task", "task.md")).size > 64 * 1024)
})
