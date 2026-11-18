// The lessons shelf: LESSONS.md beside a person's AGENTS.md (the desk root's on a solo desk), for the lessons that no
// longer fit in what session start prints.
//
// AGENTS.md is always on: every session prints it, up to a byte budget, so a desk that keeps learning outgrows it.
// lesson_add therefore writes every lesson to the shelf and never appends to AGENTS.md. Every shelved lesson loads: session start lists each shelved topic, task_focus (and
// task_create with focus) returns the shelved lessons that fit, those that share the most words with the task first, and
// desk_search finds them. A lesson recorded again under a topic replaces the earlier one.

import { readFileSync } from "node:fs"
import * as path from "node:path"
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
  "Lessons that `lesson_add` records, kept out of AGENTS.md so that file stays small. Nothing here is dropped: session start lists every topic, and `task_focus` returns the lessons that fit for the task you focus (those closest to it first). Recording a lesson again under its topic replaces it.",
  "",
].join("\n")

const oldestFirst = (a, b) => a.date.localeCompare(b.date) || a.order - b.order

/**
 * `shelve({ agents, shelf, line, topic }) -> { agents, shelf, replaced }`: AGENTS.md and LESSONS.md texts with the lesson
 * `line` for `topic` recorded on the shelf. A lesson never goes into AGENTS.md, which every session prints in full and
 * which a write from a stale copy could regrow. A line already under `topic` in AGENTS.md (an older Desk wrote there)
 * leaves it, so the newest word on the topic is the only one loaded.
 */
export function shelve({ agents, shelf, line, topic }) {
  const old = lessonEntries(agents).find((entry) => entry.topic === topic)
  const base = shelf.trim() === "" ? SHELF_HEADER : shelf
  const recorded = withLesson(base, line, topic)
  return { agents: old === undefined ? agents : withoutLesson(agents, old.line), shelf: recorded.text, replaced: recorded.replaced || old !== undefined }
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
