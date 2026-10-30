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

test("shelve keeps a lesson that fits where it is and touches no shelf", () => {
  const result = shelve({ agents: "", shelf: "", line: entry("New", "2026-10-29"), topic: "New", cap: 1000 })
  assert.deepEqual([result.tier, result.moved, result.shelf, result.replaced], ["session_start", [], "", false])
  assert.equal(result.agents, `## Lessons\n\n${entry("New", "2026-10-29")}\n`)
})

test("shelve rotates the oldest by date, not by place, and only as many as the new lesson needs", () => {
  const agents = `## Lessons\n\n${entry("Mid", "2026-02-01")}\n${entry("Oldest", "2026-01-01")}\n${entry("Newer", "2026-03-01")}\n`
  const line = entry("New", "2026-10-29")
  const cap = Buffer.byteLength(agents) + Buffer.byteLength(line) + 1 - 10
  const result = shelve({ agents, shelf: "", line, topic: "New", cap })
  assert.equal(result.tier, "session_start")
  assert.deepEqual(result.moved.map((moved) => moved.topic), ["Oldest"])
  assert.ok(result.shelf.startsWith(SHELF_HEADER))
  assert.deepEqual(lessonEntries(result.agents).map((kept) => kept.topic), ["Mid", "Newer", "New"])
})

test("shelve rotates lessons of the same date in the order they stand", () => {
  // Equal lengths, so taking out either older lesson makes exactly enough room.
  const agents = `## Lessons\n\n${entry("Aaaa", "2026-01-01")}\n${entry("Bbbb", "2026-01-01")}\n`
  const result = shelve({ agents, shelf: "", line: entry("Cccc", "2026-10-29"), topic: "Cccc", cap: Buffer.byteLength(agents) })
  assert.equal(result.tier, "session_start")
  assert.deepEqual(result.moved.map((moved) => moved.topic), ["Aaaa"])
})

test("shelve leaves the printed lessons alone, and adds no empty section, when the new lesson cannot fit anyway", () => {
  const agents = `${"x".repeat(50)}\n`
  const result = shelve({ agents, shelf: "", line: entry("New", "2026-10-29"), topic: "New", cap: 40 })
  assert.deepEqual([result.tier, result.agents, result.moved], ["shelf", agents, []])
  assert.deepEqual(lessonEntries(result.shelf).map((kept) => kept.topic), ["New"])
  const withLessons = `## Lessons\n\n${entry("Kept", "2026-01-01")}\n\n${"x".repeat(500)}\n`
  const kept = shelve({ agents: withLessons, shelf: "", line: entry("New", "2026-10-29"), topic: "New", cap: 60 })
  assert.equal(kept.tier, "shelf")
  assert.equal(kept.agents, withLessons, "the lesson session start prints stays, since moving it would not make room")
  const replaced = shelve({ agents: `## Lessons\n\n${entry("New", "2026-01-01", "Old words.")}\n${"x".repeat(500)}\n`, shelf: "", line: entry("New", "2026-10-29"), topic: "New", cap: 5 })
  assert.equal(replaced.tier, "shelf")
  assert.equal(replaced.agents.includes("Old words"), false, "the topic's old line leaves AGENTS.md")
  assert.equal(replaced.replaced, true)
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

test("shelve never lets a moved lesson overwrite a shelved line that shares its topic", () => {
  const shelf = `${SHELF_HEADER}\n## Lessons\n\n${entry("Deploys", "2026-09-01", "Newer rule B.")}\n`
  const agents = `## Lessons\n\n${entry("Deploys", "2026-01-01", "Old rule A.")}\n${entry("Tests", "2026-01-02", "Run X.")}\n${entry("Tests", "2026-01-03", "Never Y.")}\n`
  const line = entry("New", "2026-10-29")
  const result = shelve({ agents, shelf, line, topic: "New", cap: Buffer.byteLength(`## Lessons\n\n${line}\n`) })
  assert.equal(result.tier, "session_start")
  const shelved = lessonEntries(result.shelf).map((kept) => kept.line)
  for (const kept of [entry("Deploys", "2026-09-01", "Newer rule B."), entry("Deploys", "2026-01-01", "Old rule A."), entry("Tests", "2026-01-02", "Run X."), entry("Tests", "2026-01-03", "Never Y.")]) assert.ok(shelved.includes(kept), kept)
  assert.equal(result.moved.length, 3)
})

test("shelve reads a CRLF file's last printed line as printed, so it shelves the lesson that was actually cut", () => {
  const agents = `## Lessons\r\n\r\n${entry("Seen", "2026-01-01")}\r\n${entry("Cut", "2026-01-02")}\r\n`
  const cap = Buffer.byteLength(`## Lessons\r\n\r\n${entry("Seen", "2026-01-01")}\r\n`) + 5
  const result = shelve({ agents, shelf: "", line: entry("Seen", "2026-01-01"), topic: "Seen", cap })
  assert.deepEqual(result.moved.map((moved) => moved.topic), ["Cut"])
})
