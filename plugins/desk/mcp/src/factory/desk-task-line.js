// Reads the `Desk-Task: <track>/<slug>` line a controller puts in a worker's
// spawn prompt, so a worker can be bound to its own task. Only the validated
// track and slug leave this function; the rest of the prompt never does.

import { isTaskSegment } from "./binding.js"

// Controllers restyle briefs, so one list marker (`- `, `* `) or blockquote
// marker (`> `) and surrounding whitespace are allowed around the line.
const DESK_TASK_LINE = /^\s*(?:[-*>]\s+)?Desk-Task:[ \t]+([^/\s]+)\/([^/\s]+)\s*$/u

/**
 * The `{ track, slug }` named by the one `Desk-Task:` line in `text`, or
 * `null`: no such line, lines naming different tasks (even a malformed one),
 * or a segment that is not a task folder name (`..`, `_meta`, `.hidden`).
 * Repeated lines naming the same task count as one. Never throws.
 */
export function parseDeskTaskLine(text) {
  if (typeof text !== "string") return null
  let found = null
  for (const line of text.split("\n")) {
    const match = DESK_TASK_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line)
    if (match === null) continue
    if (found !== null && (found[1] !== match[1] || found[2] !== match[2])) return null
    found = match
  }
  if (found === null || !isTaskSegment(found[1]) || !isTaskSegment(found[2])) return null
  return { track: found[1], slug: found[2] }
}
