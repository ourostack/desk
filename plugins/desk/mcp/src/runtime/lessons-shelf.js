// The lessons shelf: LESSONS.md beside a person's AGENTS.md (the desk root's on a solo desk), for the lessons that no
// longer fit in what session start prints.
//
// Session start prints AGENTS.md only up to a byte budget, shared in a Crew workspace with the team's file, so a desk
// that keeps learning outgrows it. lesson_add then keeps the newest lessons in AGENTS.md and moves the oldest to the
// shelf, never deleting one. Every shelved lesson still loads: session start lists each shelved topic, task_focus (and
// task_create with focus) returns the shelved lessons that fit, those that share the most words with the task first, and
// desk_search finds them. A lesson recorded again under the same topic comes back off the shelf.

import { readFileSync } from "node:fs"
import * as path from "node:path"
import { printedPart } from "./agents-md.js"
import { lessonEntries, withLesson, withoutLesson } from "./lesson-section.js"

export const SHELF_FILE = "LESSONS.md"
/** How many bytes of shelved lessons a focus answer carries. */
const SHELF_FOCUS_BYTES = 8 * 1024
/** How many characters of shelved topics session start lists before it says how many more there are. */
const SHELF_INDEX_CHARS = 1500
// A shelf is one line per lesson; a file past this is read only this far.
const SHELF_READ_BYTES = 1024 * 1024

export const SHELF_HEADER = [
  "# Shelved lessons",
  "",
  "Lessons that `lesson_add` moved out of AGENTS.md so the newest stay within what session start prints. Nothing here is dropped: session start lists every topic, `task_focus` returns the lessons that fit for the task you focus (those closest to it first), and recording a lesson again under its topic moves it back to AGENTS.md.",
  "",
].join("\n")

// A CRLF file cut at a line break leaves its last printed line ending in "\r", which is still that line.
const printedLines = (text, cap) => new Set(printedPart(text, cap).split(/\r?\n/u).map((entry) => entry.replace(/\r$/u, "")))
const oldestFirst = (a, b) => a.date.localeCompare(b.date) || a.order - b.order

// `text` with every lesson other than `keep` that falls past the printed part taken out, each pushed onto `moved`.
function withoutUnseen(text, keep, cap, moved) {
  let rest = text
  for (;;) {
    const printed = printedLines(rest, cap)
    const unseen = lessonEntries(rest).find((entry) => entry.line !== keep && !printed.has(entry.line))
    if (unseen === undefined) return rest
    rest = withoutLesson(rest, unseen.line)
    moved.push(unseen)
  }
}

/**
 * `shelve({ agents, shelf, line, topic, cap }) -> { agents, shelf, tier, moved, replaced }`: AGENTS.md and LESSONS.md
 * texts with the lesson `line` for `topic` recorded, judged by the first `cap` bytes session start prints.
 *
 * - Lessons already past the printed part move to the shelf, because nothing loads them where they are.
 * - If the new line falls past the printed part, the oldest lessons in AGENTS.md move to the shelf until it fits, and
 *   the topic comes off the shelf, so the newest word on it is what session start prints.
 * - If it cannot fit even with no other lesson left (the rest of AGENTS.md fills the budget), the printed lessons stay
 *   where they are, the topic leaves AGENTS.md, and the new line goes on the shelf (in its old place there, if it had one).
 *
 * `tier` is "session_start" or "shelf"; `moved` holds every other lesson that left AGENTS.md for the shelf, as
 * `{ line, topic }`.
 */
export function shelve({ agents, shelf, line, topic, cap }) {
  const shelved = lessonEntries(shelf).find((entry) => entry.topic === topic)
  const added = withLesson(agents, line, topic)
  let moved = []
  let text = withoutUnseen(added.text, line, cap, moved)
  let tier = "session_start"
  if (!printedLines(text, cap).has(line)) {
    let rotated = text
    const older = []
    for (const entry of lessonEntries(text).filter((each) => each.line !== line).sort(oldestFirst)) {
      rotated = withoutLesson(rotated, entry.line)
      older.push(entry)
      if (printedLines(rotated, cap).has(line)) break
    }
    if (printedLines(rotated, cap).has(line)) {
      text = rotated
      moved.push(...older)
    } else {
      // Judged again without the new line, which no longer pushes the others down.
      const before = lessonEntries(agents).find((entry) => entry.topic === topic)
      moved = []
      text = withoutUnseen(before === undefined ? agents : withoutLesson(agents, before.line), null, cap, moved)
      tier = "shelf"
    }
  }
  let shelfText = shelved === undefined || tier === "shelf" ? shelf : withoutLesson(shelf, shelved.line)
  if ((moved.length > 0 || tier === "shelf") && shelfText.trim() === "") shelfText = SHELF_HEADER
  // A moved lesson never replaces a shelved line that shares its topic (a hand edit or a merge can leave two); only the
  // lesson being recorded replaces its topic.
  for (const entry of moved) shelfText = withLesson(shelfText, entry.line, entry.topic, { append: true }).text
  if (tier === "shelf") shelfText = withLesson(shelfText, line, topic).text
  return { agents: text, shelf: shelfText, tier, moved: moved.map((entry) => ({ line: entry.line, topic: entry.topic })), replaced: added.replaced || shelved !== undefined }
}

/** The shelf in `dir` as `{ path, entries }` (entries as `lessonEntries` gives them), or null when it holds no lesson. */
export function readShelf(dir) {
  const file = path.join(dir, SHELF_FILE)
  let text
  try {
    text = readFileSync(file).subarray(0, SHELF_READ_BYTES).toString("utf8")
  } catch {
    return null
  }
  const entries = lessonEntries(text)
  return entries.length === 0 ? null : { path: file, entries }
}

/** What session start prints for a shelf: `{ path, count, topics }`, or null when there is none. */
export function shelfIndex(dir) {
  const shelf = readShelf(dir)
  return shelf === null ? null : { path: shelf.path, count: shelf.entries.length, topics: shelf.entries.map((entry) => entry.topic) }
}

/** The topics as one line within `max` characters, naming how many more there are when they do not all fit. */
export function topicList(topics, max = SHELF_INDEX_CHARS) {
  const shown = []
  let used = 0
  for (const topic of topics) {
    if (used + topic.length + 2 > max) break
    shown.push(topic)
    used += topic.length + 2
  }
  const more = topics.length - shown.length
  return `${shown.join("; ")}${more > 0 ? `${shown.length > 0 ? "; " : ""}and ${more} more` : ""}`
}

const STOP = new Set(["about", "after", "agent", "before", "desk", "every", "from", "have", "into", "lesson", "lessons", "never", "only", "that", "their", "them", "then", "they", "this", "what", "when", "where", "which", "with", "work", "your"])
const words = (text) => new Set((String(text).toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((word) => !STOP.has(word)))

/**
 * `shelfForTask(entries, task, cap) -> { shown, not_shown }`: the shelved lesson lines to hand a session focusing `task`
 * (any text about it: track, slug, title, next step), within `cap` bytes. Lessons sharing more words with the task come
 * first, then the newest; a lesson that does not fit is skipped for a shorter one, and `not_shown` counts the rest.
 */
export function shelfForTask(entries, task, cap = SHELF_FOCUS_BYTES) {
  const wanted = words(task)
  const score = (entry) => {
    let shared = 0
    for (const word of words(entry.line)) if (wanted.has(word)) shared += 1
    return shared
  }
  const ranked = entries.map((entry) => ({ entry, score: score(entry) })).sort((a, b) => b.score - a.score || oldestFirst(b.entry, a.entry))
  const shown = []
  let used = 0
  for (const { entry } of ranked) {
    const size = Buffer.byteLength(entry.line, "utf8") + 1
    if (used + size > cap) continue
    shown.push(entry.line)
    used += size
  }
  return { shown, not_shown: entries.length - shown.length }
}
