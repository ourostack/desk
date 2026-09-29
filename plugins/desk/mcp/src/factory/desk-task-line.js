// Reads the `Desk-Task: <track>/<slug>` line a controller puts in a worker's
// spawn prompt, so a worker can be bound to its own task. Only the validated
// track and slug leave this function; the rest of the prompt never does.

import { isTaskSegment } from "./binding.js"

const DESK_TASK_LINE = /^Desk-Task: ([^/\s]+)\/([^/\s]+)\s*$/u

/**
 * The `{ track, slug }` named by the one `Desk-Task:` line in `text`, or
 * `null`: no such line, more than one (even a malformed one), or a segment
 * that is not a task folder name (`..`, `_meta`, `.hidden`). Never throws.
 */
export function parseDeskTaskLine(text) {
  if (typeof text !== "string") return null
  let found = null
  for (const line of text.split("\n")) {
    const match = DESK_TASK_LINE.exec(line.endsWith("\r") ? line.slice(0, -1) : line)
    if (match === null) continue
    if (found !== null) return null
    found = match
  }
  if (found === null || !isTaskSegment(found[1]) || !isTaskSegment(found[2])) return null
  return { track: found[1], slug: found[2] }
}
