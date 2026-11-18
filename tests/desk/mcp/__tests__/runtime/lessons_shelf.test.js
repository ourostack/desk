// The lessons shelf (LESSONS.md) and the `## Lessons` section edits it and lesson_add share. lesson_add.test.js covers the
// tool's writes end to end; these cover the pure functions' edges.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { SHELF_HEADER, readShelf, shelfForTask, shelfIndex, shelve, topicList } from "../../../../../plugins/desk/mcp/src/runtime/lessons-shelf.js"
import { lessonEntries, withoutLesson } from "../../../../../plugins/desk/mcp/src/runtime/lesson-section.js"

const entry = (topic, date, words = "Rule.") => `- **${topic}.** ${words} (${date})`

test("lessonEntries reads only the Lessons section's lesson lines, with each one's last date and place", () => {
  const text = `# A\n\n- **Outside.** Not a lesson here. (2026-01-01)\n\n## Lessons\n\nIntro prose.\n${entry("One", "2026-01-02")}\n- **Two.** Team rule (ari, 2026-01-03; decision.md)\n- **Undated.** Hand-written.\n\n## Next\n\n${entry("After", "2026-01-04")}\n`
  assert.deepEqual(lessonEntries(text).map(({ topic, date, order }) => [topic, date, order]), [["One", "2026-01-02", 0], ["Two", "2026-01-03", 1], ["Undated", "", 2]])
  assert.deepEqual(lessonEntries("# No section\n"), [])
})

test("withoutLesson removes one exact line from the section, folds the blank line it leaves, and keeps CRLF", () => {
  assert.equal(withoutLesson("## Lessons\n\n- **A.** a\n\n## Next\n", "- **A.** a"), "## Lessons\n\n## Next\n")
  assert.equal(withoutLesson("## Lessons\r\n\r\n- **A.** a\r\n- **B.** b\r\n", "- **A.** a"), "## Lessons\r\n\r\n- **B.** b\r\n")
  assert.equal(withoutLesson("## Lessons\n\n- **A.** a\n", "- **Z.** z"), "## Lessons\n\n- **A.** a\n")
  assert.equal(withoutLesson("- **A.** a\n", "- **A.** a"), "- **A.** a\n", "a line outside any Lessons section is left alone")
})

test("shelve records the lesson on the shelf and leaves AGENTS.md as it is", () => {
  const agents = "# Desk\n\nRules.\n"
  const result = shelve({ agents, shelf: "", line: entry("New", "2026-10-29"), topic: "New" })
  assert.equal(result.agents, agents)
  assert.ok(result.shelf.startsWith(SHELF_HEADER))
  assert.deepEqual(lessonEntries(result.shelf).map((each) => each.line), [entry("New", "2026-10-29")])
  assert.equal(result.replaced, false)
})

test("shelve replaces a shelved line on the same topic, and takes an older AGENTS.md line on it off", () => {
  const agents = `# Desk\n\n## Lessons\n\n${entry("Same", "2026-01-01", "Old.")}\n${entry("Other", "2026-01-02")}\n`
  const shelf = `${SHELF_HEADER}\n## Lessons\n\n${entry("Same", "2026-01-03", "Shelved.")}\n`
  const result = shelve({ agents, shelf, line: entry("Same", "2026-10-29", "New."), topic: "Same" })
  assert.deepEqual(lessonEntries(result.agents).map((each) => each.topic), ["Other"])
  assert.deepEqual(lessonEntries(result.shelf).map((each) => each.line), [entry("Same", "2026-10-29", "New.")])
  assert.equal(result.replaced, true)
})

test("readShelf and shelfIndex read a shelf's lessons, and give null for none", async () => {
  const dir = await mkTempRoot("lessons-shelf-")
  assert.equal(readShelf(dir), null)
  await fs.writeFile(path.join(dir, "LESSONS.md"), SHELF_HEADER)
  assert.equal(shelfIndex(dir), null)
  await fs.writeFile(path.join(dir, "LESSONS.md"), `${SHELF_HEADER}\n## Lessons\n\n${entry("One", "2026-01-01")}\n`)
  assert.deepEqual(shelfIndex(dir), { path: path.join(dir, "LESSONS.md"), count: 1, topics: ["One"] })
})

test("topicList names topics within its bound and counts the rest", () => {
  assert.equal(topicList(["a", "b"]), "a; b")
  assert.equal(topicList(["alpha", "beta", "gamma"], 15), "alpha; beta; and 1 more")
  assert.equal(topicList(["a long topic"], 3), "and 1 more")
  assert.equal(topicList([]), "")
})

test("shelfForTask puts the lessons sharing words with the task first, then the newest, and counts what does not fit", () => {
  const entries = lessonEntries(`## Lessons\n\n${entry("Old valves", "2026-01-01", "Bleed the flash valves first.")}\n${entry("Newest", "2026-03-01")}\n${entry("Middle", "2026-02-01")}\n`)
  assert.deepEqual(shelfForTask(entries, "ops flash-valves Restart the flash valves").shown.map((line) => /\*\*(.+?)\.\*\*/u.exec(line)[1]), ["Old valves", "Newest", "Middle"])
  const one = Buffer.byteLength(entries[1].line) + 1
  assert.deepEqual(shelfForTask(entries, "", one), { shown: [entries[1].line], not_shown: 2 })
  assert.deepEqual(shelfForTask(entries, "with that this every", 1_000_000).shown[0], entries[1].line, "common words do not count as shared")
})
