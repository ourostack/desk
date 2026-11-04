// The text side of lesson_add: one-line checks, and (from runtime/lesson-section.js, which session start can load without
// the runtime dependencies) the `## Lessons` section edit, shared by the personal write in lesson.js and the team write in
// lesson-team.js.

import { slugify } from "../util/fm.js"

export { SECTION, lead, lessonLine, withLesson } from "../runtime/lesson-section.js"

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

