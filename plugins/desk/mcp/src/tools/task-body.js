// The two body edits `task_update` makes for the agent, so a task card's progress is only ever written through
// Desk's tools: `note` appends a dated line to the card's `## Progress log`, and `next_step` replaces the card's
// recorded `**Next step:**` paragraph. A PreToolUse guard denies direct Write/Edit/MultiEdit on a live card
// (runtime/task-status-guard.js) because an agent that could edit the card freely wrote "Push routing
// confirmed ... scenario is handled" into it with no PR and no check (boot acceptance round A).
//
// Both edits read the body line by line and ignore fenced code blocks, so a marker or heading quoted inside a
// fence is never mistaken for the card's own. Line endings are kept: a card written with CRLF stays CRLF.

const PROGRESS_HEADING = "## Progress log"
const NEXT_STEP_MARKER = "**Next step:**"
const FENCE = /^\s{0,3}(`{3,}|~{3,})/u
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/u
const HEADING = /^#{1,6}\s/u

/** One logical line: a note or next step never carries the line breaks that would split a bullet or paragraph. */
function oneLine(text) {
  return text.trim().replace(/\s*\r?\n\s*/gu, " ")
}

/** The body's lines, its line ending, and which lines sit inside a fenced code block (fence lines included). */
function scan(body) {
  const eol = body.includes("\r\n") ? "\r\n" : "\n"
  const lines = body.split(/\r?\n/u)
  const fenced = []
  let open = null
  for (const line of lines) {
    const match = FENCE.exec(line)
    if (open === null) {
      fenced.push(match !== null)
      if (match !== null) open = match[1]
    } else {
      fenced.push(true)
      if (match !== null && match[1][0] === open[0] && match[1].length >= open.length && line.trim() === match[1]) open = null
    }
  }
  return { eol, lines, fenced }
}

function appendParagraph(body, paragraph, eol) {
  const trimmed = body.replace(/\s+$/u, "")
  return `${trimmed === "" ? "" : `${trimmed}${eol}${eol}`}${paragraph}${eol}`
}

/** Where the paragraph that starts at `start` ends: at a blank line, a list item, a heading or a fence. */
function paragraphEnd(lines, fenced, start) {
  let end = start + 1
  while (end < lines.length && lines[end].trim() !== "" && !LIST_ITEM.test(lines[end]) && !HEADING.test(lines[end]) && !fenced[end]) end += 1
  return end
}

/**
 * The body with its `**Next step:**` paragraph replaced by `text`: the first marker outside a fenced code block is
 * replaced and any later ones are dropped. A card with none gets the paragraph appended.
 */
export function replaceNextStep(body, text) {
  const { eol, lines, fenced } = scan(body)
  const paragraph = `${NEXT_STEP_MARKER} ${oneLine(text)}`
  const out = []
  let replaced = false
  for (let index = 0; index < lines.length;) {
    if (fenced[index] || !lines[index].startsWith(NEXT_STEP_MARKER)) {
      out.push(lines[index])
      index += 1
      continue
    }
    const end = paragraphEnd(lines, fenced, index)
    if (!replaced) {
      out.push(paragraph)
      replaced = true
      index = end
    } else {
      // A duplicate goes, with the blank line that separated it.
      index = end < lines.length && lines[end].trim() === "" ? end + 1 : end
    }
  }
  return replaced ? out.join(eol) : appendParagraph(body, paragraph, eol)
}

/**
 * The body with `- <date>: <note>` added at the end of its `## Progress log` section (the first such heading outside
 * a fenced code block); the section is created at the end of the card when it is missing.
 */
export function appendProgressNote(body, text, date) {
  const { eol, lines, fenced } = scan(body)
  const bullet = `- ${date}: ${oneLine(text)}`
  const heading = lines.findIndex((line, index) => !fenced[index] && line.trim() === PROGRESS_HEADING)
  if (heading === -1) return appendParagraph(body, `${PROGRESS_HEADING}${eol}${eol}${bullet}`, eol)
  let end = heading + 1
  while (end < lines.length && (fenced[end] || !/^## /u.test(lines[end]))) end += 1
  let last = end - 1
  while (last > heading && lines[last].trim() === "") last -= 1
  const spacer = last === heading ? [""] : []
  return [...lines.slice(0, last + 1), ...spacer, bullet, ...lines.slice(last + 1)].join(eol)
}

/** Today's date in the operator's own time zone, `YYYY-MM-DD`. */
export function localDate(now = new Date()) {
  const two = (value) => String(value).padStart(2, "0")
  return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`
}

/**
 * The last `count` entries of the card's `## Progress log` section (the first such heading outside a fenced code
 * block), oldest first: each list item is one entry, trimmed of its bullet and cut to `cap` characters with an
 * ellipsis. A card with no such section has no entries.
 */
export function recentProgress(body, count, cap) {
  const { lines, fenced } = scan(body)
  const heading = lines.findIndex((line, index) => !fenced[index] && line.trim() === PROGRESS_HEADING)
  if (heading === -1) return []
  const entries = []
  for (let index = heading + 1; index < lines.length && (fenced[index] || !/^## /u.test(lines[index])); index += 1) {
    if (fenced[index] || !LIST_ITEM.test(lines[index])) continue
    const entry = lines[index].replace(/^\s*(?:[-*+]|\d+[.)])\s+/u, "").trim()
    if (entry !== "") entries.push(entry.length > cap ? `${entry.slice(0, cap - 1)}…` : entry)
  }
  return entries.slice(-count)
}
