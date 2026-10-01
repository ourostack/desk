// The one edit `task_update` makes to a track card: when a task's status changes, that task's row in the track's Tasks
// table gets its new `State`. The documented table (`track-card-format`) is
//
//   | Slug | State | Repos | Tracker link | Doing doc |
//   |------|-------|-------|--------------|-----------|
//   | `api-validation-layer` | drafting | ... | ... | ... |
//
// so the row is found by a header that names the `Slug` and `State` columns and a first cell that is the task's slug
// (backticks optional), and only the `State` cell is rewritten, byte for byte elsewhere, line endings kept. A card with
// no such table, or no such row, is left alone: the edit never invents a table, a row or a column.

function cells(line) {
  const trimmed = line.trim()
  if (!trimmed.startsWith("|")) return null
  return trimmed.replace(/^\|/u, "").replace(/\|$/u, "").split("|")
}

const SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/u

/**
 * `trackText` with the `State` cell of `slug`'s row set to `status`, or null when nothing changed (no documented table,
 * no row for the slug, or the cell already says it).
 */
export function setTaskState(trackText, slug, status) {
  const eol = trackText.includes("\r\n") ? "\r\n" : "\n"
  const lines = trackText.split(/\r?\n/u)
  let slugColumn = -1
  let stateColumn = -1
  let fenced = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (/^\s{0,3}(```|~~~)/u.test(line)) fenced = !fenced
    const row = fenced ? null : cells(line)
    if (row === null) {
      slugColumn = -1
      stateColumn = -1
      continue
    }
    const names = row.map((cell) => cell.trim().toLowerCase())
    if (slugColumn === -1 && names.includes("slug") && names.includes("state") && SEPARATOR.test(lines[index + 1] ?? "")) {
      slugColumn = names.indexOf("slug")
      stateColumn = names.indexOf("state")
      index += 1
      continue
    }
    if (slugColumn === -1 || SEPARATOR.test(line) || row.length <= Math.max(slugColumn, stateColumn)) continue
    if (row[slugColumn].trim().replace(/^`+|`+$/gu, "") !== slug) continue
    if (row[stateColumn].trim() === status) return null
    const lead = line.match(/^\s*/u)[0]
    row[stateColumn] = ` ${status} `
    lines[index] = `${lead}|${row.join("|")}${line.trimEnd().endsWith("|") ? "|" : ""}`
    return lines.join(eol)
  }
  return null
}
