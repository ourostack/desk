// The two body edits `task_update` makes for the agent, so a task card's progress is only ever written through
// Desk's tools: `note` appends a dated line to the card's `## Progress log`, and `next_step` replaces the card's
// recorded `**Next step:**` paragraph. A PreToolUse guard denies direct Write/Edit/MultiEdit on an existing
// card (runtime/task-status-guard.js) because an agent that could edit the card freely wrote "Push routing
// confirmed ... scenario is handled" into it with no PR and no check (boot acceptance round A).

const PROGRESS_HEADING = "## Progress log"
const NEXT_STEP_MARKER = "**Next step:**"

/** One logical line: a note or next step never carries the line breaks that would split a bullet or paragraph. */
function oneLine(text) {
  return text.trim().replace(/\s*\r?\n\s*/gu, " ")
}

/**
 * The body with its `**Next step:**` paragraph (the marker line and the non-blank lines that follow it) replaced by
 * `text`; appended as a new paragraph when the card has none yet.
 */
export function replaceNextStep(body, text) {
  const paragraph = `${NEXT_STEP_MARKER} ${oneLine(text)}`
  const lines = body.split("\n")
  const start = lines.findIndex((line) => line.startsWith(NEXT_STEP_MARKER))
  if (start === -1) {
    const trimmed = body.replace(/\s+$/u, "")
    return `${trimmed === "" ? "" : `${trimmed}\n\n`}${paragraph}\n`
  }
  let end = start + 1
  while (end < lines.length && lines[end].trim() !== "" && !lines[end].startsWith("#")) end += 1
  return [...lines.slice(0, start), paragraph, ...lines.slice(end)].join("\n")
}

/**
 * The body with `- <date>: <note>` added at the end of its `## Progress log` section; the section is created at
 * the end of the card when it is missing.
 */
export function appendProgressNote(body, text, date) {
  const bullet = `- ${date}: ${oneLine(text)}`
  const lines = body.split("\n")
  const heading = lines.findIndex((line) => line.trim() === PROGRESS_HEADING)
  if (heading === -1) {
    const trimmed = body.replace(/\s+$/u, "")
    return `${trimmed === "" ? "" : `${trimmed}\n\n`}${PROGRESS_HEADING}\n\n${bullet}\n`
  }
  let end = heading + 1
  while (end < lines.length && !/^## /u.test(lines[end])) end += 1
  let last = end - 1
  while (last > heading && lines[last].trim() === "") last -= 1
  const spacer = last === heading ? [""] : []
  return [...lines.slice(0, last + 1), ...spacer, bullet, ...lines.slice(last + 1)].join("\n")
}
