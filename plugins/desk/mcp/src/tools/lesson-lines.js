// The text side of lesson_add: one-line checks and the `## Lessons` section edit, shared by the personal write in
// lesson.js and the team write in lesson-team.js.

import { slugify } from "../util/fm.js"
import { AGENTS_MD_CAP_BYTES } from "../runtime/agents-md.js"

export const SECTION = "## Lessons"
const CAP_WORDS = `${AGENTS_MD_CAP_BYTES / 1024} KB`

export function oneLine(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`lesson_add: \`${name}\` is required (string)`)
  const trimmed = value.trim()
  if (/[\r\n]/u.test(trimmed)) throw new Error(`lesson_add: \`${name}\` must be one line: a lesson is one rule`)
  return trimmed
}

/** The topic as the line's bold lead, without the full stop the line adds. */
export function topicOf(value) {
  const topic = oneLine(value, "topic").replace(/[.\s]+$/u, "")
  if (topic === "" || !slugify(topic)) throw new Error("lesson_add: `topic` is required (string) and must hold a word")
  return topic
}

export const lead = (topic) => `- **${topic}.**`

/** The line in `text` that holds the lesson for `topic`, or undefined. */
export function lessonLine(text, topic) {
  return text.split(/\r?\n/u).find((entry) => entry.startsWith(`${lead(topic)} `))
}

/**
 * `withLesson(text, line, topic) -> { text, replaced }`: the AGENTS.md text with `line` in its `## Lessons` section. A
 * line for the same topic is replaced in place; otherwise the line goes after the section's last line, before the next
 * heading of the same or a higher level, and a file with no section gets one at the end. The file keeps its own line
 * ending: a file checked out on Windows with CRLF stays CRLF, and its section is still found.
 */
export function withLesson(text, line, topic) {
  const eol = /\r\n/u.test(text) ? "\r\n" : "\n"
  const lines = text === "" ? [] : text.replace(/(?:\r?\n)+$/u, "").split(/\r?\n/u)
  const join = (list) => `${list.join(eol)}${eol}`
  const start = lines.findIndex((entry) => entry.trimEnd() === SECTION)
  if (start === -1) {
    const head = lines.length === 0 ? [] : [...lines, ""]
    return { text: join([...head, SECTION, "", line]), replaced: false }
  }
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2} /u.test(lines[index])) {
      end = index
      break
    }
  }
  const prefix = `${lead(topic)} `
  const same = lines.findIndex((entry, index) => index > start && index < end && entry.startsWith(prefix))
  if (same !== -1) {
    lines[same] = line
    return { text: join(lines), replaced: true }
  }
  let last = end - 1
  while (last > start && lines[last].trim() === "") last -= 1
  const insert = last === start ? [lines.slice(0, start + 1), [""], [line]] : [lines.slice(0, last + 1), [line]]
  const rest = lines.slice(last + 1)
  const after = rest.length > 0 && rest[0].trim() !== "" ? ["", ...rest] : rest
  return { text: join([...insert.flat(), ...after]), replaced: false }
}

export const byteSize = (text) => Buffer.byteLength(text, "utf8")

export function refuseOverCap(bytes, what) {
  if (bytes > AGENTS_MD_CAP_BYTES) {
    throw new Error(`lesson_add: ${what} would pass the ${CAP_WORDS} of AGENTS.md that session start prints, so nothing would load this lesson; shorten that file first`)
  }
}
