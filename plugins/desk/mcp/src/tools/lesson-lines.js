// The text side of lesson_add: one-line checks, and (from runtime/lesson-section.js, which session start can load without
// the runtime dependencies) the `## Lessons` section edit, shared by the personal write in lesson.js and the team write in
// lesson-team.js.

import { slugify } from "../util/fm.js"

export { SECTION, lead, lessonLine, withLesson } from "../runtime/lesson-section.js"

export function oneLine(value, name) {
  if (typeof value !== "string" || value.trim() === "") throw Object.assign(new Error(`lesson_add: Pass the missing argument as a string: \`${name}\` is required (string)`), { code: "lesson_add_is_required_string" })
  const trimmed = value.trim()
  if (/[\r\n]/u.test(trimmed)) throw Object.assign(new Error(`lesson_add: Pass \`${name}\` on one line: \`${name}\` must be one line: a lesson is one rule`), { code: "lesson_add_must_be_one_line_a" })
  return trimmed
}

/** The topic as the line's bold lead, without the full stop the line adds. */
export function topicOf(value) {
  const topic = oneLine(value, "topic").replace(/[.\s]+$/u, "")
  if (topic === "" || !slugify(topic)) throw Object.assign(new Error("lesson_add: Pass `topic` as a string that holds a word: `topic` is required (string) and must hold a word"), { code: "lesson_add_topic_is_required_string_and" })
  return topic
}

