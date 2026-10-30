// The `## Lessons` section of an AGENTS.md or a lessons shelf: find, add, replace and remove one-line lessons. Plain
// string work with no imports, so session start can use it before the runtime dependencies are restored.

export const SECTION = "## Lessons"

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
  const section = sectionOf(lines)
  if (section === null) {
    const head = lines.length === 0 ? [] : [...lines, ""]
    return { text: join([...head, SECTION, "", line]), replaced: false }
  }
  const { start, end } = section
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

// The `## Lessons` section's bounds in `lines`: { start, end } with `end` the next heading of the same or a higher level, or null.
function sectionOf(lines) {
  const start = lines.findIndex((entry) => entry.trimEnd() === SECTION)
  if (start === -1) return null
  let end = lines.length
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^#{1,2} /u.test(lines[index])) {
      end = index
      break
    }
  }
  return { start, end }
}

const LEAD = /^- \*\*(.+?)\.\*\*(?: |$)/u
const DATE = /(\d{4}-\d{2}-\d{2})(?!.*\d{4}-\d{2}-\d{2})/u

/**
 * The lesson lines of `text`'s `## Lessons` section, in file order, as `{ line, topic, date, order }`: a lesson line starts
 * with the bold lead `lesson_add` writes, `date` is the last YYYY-MM-DD on it (or "" when it has none) and `order` is its
 * place in the section.
 */
export function lessonEntries(text) {
  const lines = text.split(/\r?\n/u)
  const section = sectionOf(lines)
  if (section === null) return []
  const found = []
  for (let index = section.start + 1; index < section.end; index += 1) {
    const lead = LEAD.exec(lines[index])
    if (lead) found.push({ line: lines[index], topic: lead[1], date: DATE.exec(lines[index])?.[1] ?? "", order: found.length })
  }
  return found
}

/**
 * `withoutLesson(text, line) -> text`: `text` with the exact `line` taken out of its `## Lessons` section, or `text` itself
 * when the section does not hold it. A blank line left doubled by the removal is folded, and the file keeps its line ending.
 */
export function withoutLesson(text, line) {
  const eol = /\r\n/u.test(text) ? "\r\n" : "\n"
  const lines = text.replace(/(?:\r?\n)+$/u, "").split(/\r?\n/u)
  const section = sectionOf(lines)
  if (section === null) return text
  const index = lines.findIndex((entry, at) => at > section.start && at < section.end && entry === line)
  if (index === -1) return text
  lines.splice(index, 1)
  if (index > 0 && index < lines.length && lines[index - 1].trim() === "" && lines[index].trim() === "") lines.splice(index, 1)
  return `${lines.join(eol)}${eol}`
}
