// The `## Steps` table on a task card: an outcome that takes several pieces of work keeps them as rows of one table on
// one card, and Desk reads which are ready from it.
//
// Columns `Step | Depends on | Repo | State | Evidence`, in any order, with any extra columns left alone. The heading is
// `## Steps`; Desk puts it right after `## Outcome` (or at the top of the body) and ignores a copy inside a code fence.
// Cells are trimmed, states are case-insensitive, and `—`, `-` and an empty cell mean none. Step names are short
// kebab-case and never renamed. A table Desk cannot read (a missing column, a bad name, a cycle ...) is left as prose:
// `readSteps` says why, and `applyStep` refuses to write to it, so nothing else about the card is blocked.
//
// Only task_update and task_create write the table (tools/task.js); boot and desk_status read it
// (desk/active-tasks.js). Callers set `pending`, `in progress`, `blocked` and `dropped`; Desk alone sets `in review`, `merged`
// and `delivered`, from the step's PR or delegated card (desk/step-delivery.js), and `setDerived` writes those cells.

import { scan } from "../tools/task-body.js"
import { isDerivable } from "./step-delivery.js"

export const STEP_STATES = ["pending", "in progress", "blocked", "in review", "merged", "delivered", "dropped"]
export const DERIVED_STATES = ["in review", "merged", "delivered"]
export const STEP_FIELDS = ["id", "state", "depends_on", "repo", "evidence", "reason", "expect", "dependents_ok"]
const NEEDS_REASON = ["blocked", "dropped"]
export const SETTLED = ["delivered", "dropped"]
const HEADING = "## Steps"
const COLUMNS = ["Step", "Depends on", "Repo", "State", "Evidence"]
const ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u
const ID_LIMIT = 40
const NONE = /^(?:—|-)?$/u
export const SEPARATOR = /^\|?[\s:|-]*-[\s:|-]*$/u

export const splitCells = (line) =>
  line.trim().replace(/^\|/u, "").replace(/(?<!\\)\|$/u, "").split(/(?<!\\)\|/u).map((cell) => cell.replace(/\\\|/gu, "|").trim())
const oneLine = (value) => value.replace(/\s*\r?\n\s*/gu, " ").trim()
const orNone = (value) => (value === "" || value === null ? "—" : value)

function checkRows(rows) {
  const byId = new Map()
  for (const [index, row] of rows.entries()) {
    const name = row.id === "" ? `row ${index + 1}` : `step ${JSON.stringify(row.id)}`
    if (!ID.test(row.id) || row.id.length > ID_LIMIT) return `${name} needs a short kebab-case name (lowercase words joined by hyphens, at most ${ID_LIMIT} characters)`
    if (byId.has(row.id)) return `${name} appears twice`
    if (!STEP_STATES.includes(row.state)) return `${name} has state ${JSON.stringify(row.state)}; it must be one of ${STEP_STATES.join(", ")}`
    byId.set(row.id, row)
  }
  for (const row of rows) {
    const unknown = row.depends_on.find((id) => !byId.has(id))
    if (unknown !== undefined) return `step ${JSON.stringify(row.id)} depends on ${JSON.stringify(unknown)}, which is not a step`
  }
  const done = new Set()
  const walk = (row, path) => {
    if (path.includes(row.id)) return [...path.slice(path.indexOf(row.id)), row.id]
    if (done.has(row.id)) return null
    for (const id of row.depends_on) {
      const cycle = walk(byId.get(id), [...path, row.id])
      if (cycle !== null) return cycle
    }
    done.add(row.id)
    return null
  }
  for (const row of rows) {
    const cycle = walk(row, [])
    if (cycle !== null) return `steps depend on each other in a circle: ${cycle.join(" -> ")}`
  }
  return null
}

/**
 * The card body's steps table: `{ found: false }` when there is none, `{ found: true, reason }` when there is one Desk
 * cannot read (`reason` says why; the table stays prose), or `{ found: true, rows, table }` where each row is
 * `{ id, depends_on, repo, state, evidence, line }` and `table` locates it for a write. `truncated` says the body is only the start of the card (boot's bounded read): a table that runs to its end may be missing rows, so it is not read.
 */
export function readSteps(body, { truncated = false } = {}) {
  const { eol, lines, fenced } = scan(body)
  const heading = lines.findIndex((line, index) => !fenced[index] && line.trim() === HEADING)
  if (heading === -1) return { found: false, lines, eol, fenced }
  let end = heading + 1
  while (end < lines.length && (fenced[end] || !/^## /u.test(lines[end]))) end += 1
  const unreadable = (reason) => ({ found: true, reason, lines, eol, fenced })
  const head = lines.findIndex((line, index) => index > heading && index < end && !fenced[index] && line.trim().startsWith("|"))
  if (head === -1) return unreadable("there is no table under the heading")
  const names = splitCells(lines[head]).map((cell) => cell.toLowerCase())
  const col = Object.fromEntries(COLUMNS.map((name) => [name, names.indexOf(name.toLowerCase())]))
  const missing = COLUMNS.filter((name) => col[name] === -1)
  if (missing.length > 0) return unreadable(`the table has no ${missing.join(", ")} column`)
  if (head + 1 >= end || !SEPARATOR.test(lines[head + 1].trim())) return unreadable("the table has no separator row under its header")
  const rows = []
  let line = head + 2
  for (; line < end && !fenced[line] && lines[line].trim().startsWith("|"); line += 1) {
    const cells = splitCells(lines[line])
    const cell = (name) => cells[col[name]] ?? ""
    const depends = cell("Depends on")
    rows.push({
      id: cell("Step"),
      depends_on: NONE.test(depends) ? [] : depends.split(",").map((id) => id.trim()),
      repo: NONE.test(cell("Repo")) ? null : cell("Repo"),
      state: cell("State").toLowerCase(),
      evidence: NONE.test(cell("Evidence")) ? "" : cell("Evidence"),
      line,
    })
  }
  if (truncated && lines.slice(line).every((text) => text.trim() === "")) return unreadable("the card was cut at the read limit inside the table")
  const reason = checkRows(rows)
  return reason === null ? { found: true, rows, table: { head, end: line, col, width: names.length }, lines, eol, fenced } : unreadable(reason)
}

const byId = (rows) => new Map(rows.map((row) => [row.id, row]))

/** The ids of the pending steps whose every dependency is delivered or dropped. */
export function readyOf(rows) {
  const known = byId(rows)
  return rows.filter((row) => row.state === "pending" && row.depends_on.every((id) => SETTLED.includes(known.get(id).state))).map((row) => row.id)
}

/** A compact summary for boot and desk_status: the steps that count (not dropped), how many are delivered, what is ready, how many are moving (in progress, in review or merged), what is blocked and why. */
export function summarizeSteps(rows) {
  const counted = rows.filter((row) => row.state !== "dropped")
  return {
    total: counted.length,
    delivered: counted.filter((row) => row.state === "delivered").length,
    ready: readyOf(rows),
    moving: rows.filter((row) => ["in progress", "in review", "merged"].includes(row.state)).length,
    blocked: rows.filter((row) => row.state === "blocked").map((row) => ({ id: row.id, reason: row.evidence })),
  }
}

const describeRow = (row) => `${row.id}: state ${row.state}, depends on ${row.depends_on.join(", ") || "nothing"}, repo ${row.repo ?? "none"}, evidence ${row.evidence || "none"}`

// A row as one table line. `cells` are the line's own cells (as read, unescaped), kept as they are, including any past the header's width; a `|` in any cell is escaped on the way out.
const rowLine = (row, cells, col, width) => {
  const out = Array.from({ length: Math.max(width, cells.length) }, (_, index) => cells[index] ?? "")
  out[col.Step] = row.id
  out[col["Depends on"]] = orNone(oneLine(row.depends_on.join(", ")))
  out[col.Repo] = orNone(row.repo === null ? null : oneLine(row.repo))
  out[col.State] = row.state
  out[col.Evidence] = orNone(oneLine(row.evidence))
  return `| ${out.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`
}

// A reason is written after the evidence the step already had, so a PR link survives a step being blocked or dropped: `reason (was: <evidence>)`.
const TASK_REF = /^task:\S+$/u
const WAS = /\(was: (.*)\)$/u
const withReason = (reason, evidence) => (evidence === "" ? reason : `${reason} (was: ${evidence})`)
// The evidence a step had before a reason was put in front of it: what follows `(was: ...)`, or nothing when the cell was only a reason.
// A delegated step Desk derived as blocked keeps its `task:` reference as it is: that is evidence, not a reason.
const evidenceBehind = (row) => (row === undefined ? "" : NEEDS_REASON.includes(row.state) ? (WAS.exec(row.evidence)?.[1] ?? (TASK_REF.test(row.evidence) ? row.evidence : "")) : row.evidence)

function newTable(rows) {
  const head = `| ${COLUMNS.join(" | ")} |`
  const col = Object.fromEntries(COLUMNS.map((name, index) => [name, index]))
  return [HEADING, "", head, `|${COLUMNS.map(() => "---").join("|")}|`, ...rows.map((row) => rowLine(row, [], col, COLUMNS.length))]
}

// A new table goes right after the `## Outcome` section, or at the top of the body when the card has none.
function withNewTable({ lines, fenced }, rows) {
  const outcome = lines.findIndex((line, index) => !fenced[index] && /^##\s+outcome\s*$/iu.test(line.trim()))
  let at = lines.length
  if (outcome === -1) at = 0
  else for (let index = outcome + 1; index < lines.length; index += 1) if (!fenced[index] && /^## /u.test(lines[index])) { at = index; break }
  const before = lines.slice(0, at)
  while (before.length > 0 && before.at(-1).trim() === "") before.pop()
  const after = lines.slice(at)
  while (after.length > 0 && after[0].trim() === "") after.shift()
  return [...before, ...(before.length > 0 ? [""] : []), ...newTable(rows), ...(after.length > 0 ? ["", ...after] : [""])]
}

/**
 * The body with one step row added or changed, and what it said: `{ body, row, blocked, ready, declared }`, where `declared` says the state was set by the caller on evidence Desk cannot read, and `blocked` lists the
 * dependents a drop blocked and `ready` the steps this change made ready. `repos` is the card's repo names. Refuses, naming the row
 * and changing nothing, for a step Desk cannot place (see the task_update schema for the rules).
 */
export function applyStep(body, input, tool, repos) {
  const refuse = (message) => { throw new Error(`${tool}: ${message}; no step was changed.`) }
  const names = (value, field) => {
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) refuse(`step ${JSON.stringify(input.id)}: \`${field}\` must be a list of step names`)
    return value.map((item) => item.trim())
  }
  const unknown = Object.keys(input).filter((key) => !STEP_FIELDS.includes(key))
  if (unknown.length > 0) refuse(`step has unknown field${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `\`${key}\``).join(", ")}; it takes ${STEP_FIELDS.map((key) => `\`${key}\``).join(", ")}`)
  const id = typeof input.id === "string" ? input.id.trim() : ""
  const named = `step ${JSON.stringify(id)}`
  const read = readSteps(body)
  if (read.found && read.rows === undefined) refuse(`the \`## Steps\` table on this card is left as prose because ${read.reason}, so ${named} cannot be written there. Fix the table by hand or leave steps out of this card`)
  const rows = read.rows ?? []
  const existing = rows.find((row) => row.id === id)
  if (input.expect !== undefined && (existing === undefined || existing.state !== String(input.expect).trim().toLowerCase())) {
    refuse(`${named} is not as you last saw it (expect ${JSON.stringify(input.expect)}); now ${existing === undefined ? "there is no such step" : describeRow(existing)}`)
  }
  if (existing === undefined && (input.repo === undefined || input.depends_on === undefined)) refuse(`${named} is new, so it needs \`repo\` (a repo of the card, or "—") and \`depends_on\` (a list of step names, empty for none)`)
  const state = input.state === undefined ? (existing?.state ?? "pending") : String(input.state).trim().toLowerCase()
  const changed = existing === undefined || state !== existing.state
  if (existing !== undefined && existing.state !== "pending" && (input.depends_on !== undefined || input.repo !== undefined)) refuse(`${named} is ${existing.state}; its \`depends_on\` and \`repo\` change only while it is pending (set it to pending in one call, then rewire it in the next)`)
  if (existing !== undefined && SETTLED.includes(existing.state) && changed && input.expect === undefined) refuse(`${named} is ${existing.state}; moving it out of ${existing.state} needs \`expect: "${existing.state}"\`, so a step another session settled is not reopened by accident`)
  const reason = typeof input.reason === "string" ? input.reason.trim() : ""
  if (NEEDS_REASON.includes(state) && changed && reason === "") refuse(`${named} cannot become ${state} without a \`reason\``)
  const proof = reason === "" ? (typeof input.evidence === "string" ? input.evidence : "") : reason
  // Desk derives in review, merged and delivered where it can read them (a GitHub pull request, a delegated card); elsewhere (an Azure DevOps pull request, a commit) the agent declares them, with evidence.
  let declared = false
  if (input.state !== undefined && DERIVED_STATES.includes(state) && changed) {
    const shown = proof !== "" ? proof : evidenceBehind(existing)
    if (isDerivable(shown)) refuse(`${named} cannot be set to ${state}: Desk sets in review, merged and delivered from the step's GitHub PR or delegated card, and its evidence has one. Leave the state to Desk`)
    if (shown === "") refuse(`${named} cannot be set to ${state} without evidence: Desk derives the state from a GitHub PR URL (or \`task:<track>/<slug>\`) in \`evidence\`; for a PR or commit elsewhere, put it in \`evidence\` and the state is yours to declare`)
    declared = true
  }
  const depends = input.depends_on === undefined ? existing.depends_on : names(input.depends_on, "depends_on")
  let repo = existing?.repo ?? null
  if (input.repo !== undefined) repo = NONE.test(String(input.repo).trim()) ? null : String(input.repo).trim()
  if (repo !== null && !repos.includes(repo)) refuse(`${named} names repo ${JSON.stringify(repo)}, which is not one of the card's repos (${repos.join(", ") || "none"})`)
  // Evidence is kept unless the call gives new text; a blocked or dropped step keeps what it had behind its reason.
  const evidence = NEEDS_REASON.includes(state) ? (proof === "" ? existing.evidence : withReason(proof, evidenceBehind(existing))) : proof !== "" ? proof : evidenceBehind(existing)
  const row = { line: existing?.line, id, depends_on: depends, repo, state, evidence }
  const next = existing === undefined ? [...rows, row] : rows.map((item) => (item === existing ? row : item))
  // Dropping a step blocks the live steps that depend on it, unless the call says they are still valid.
  const blocked = []
  if (state === "dropped" && changed && existing !== undefined) {
    const stillValid = input.dependents_ok === undefined ? [] : names(input.dependents_ok, "dependents_ok")
    for (const [index, item] of next.entries()) {
      if (!item.depends_on.includes(id) || !["pending", "in progress"].includes(item.state) || stillValid.includes(item.id)) continue
      next[index] = { ...item, state: "blocked", evidence: withReason(`depends on ${id}, which was dropped`, evidenceBehind(item)) }
      blocked.push(item.id)
    }
  }
  const invalid = checkRows(next)
  if (invalid !== null) refuse(invalid)
  const lines = read.found ? [...read.lines] : null
  let out
  if (lines === null) out = withNewTable(read, next)
  else {
    const { col, width, end } = read.table
    const touched = next.filter((item, index) => item.line !== undefined && item !== rows[index])
    for (const item of touched) lines[item.line] = rowLine(item, splitCells(lines[item.line]), col, width)
    if (existing === undefined) lines.splice(end, 0, rowLine(row, [], col, width))
    out = lines
  }
  const before = readyOf(rows)
  return { body: out.join(read.eol), row, blocked, declared, ready: readyOf(next).filter((item) => !before.includes(item)) }
}

/**
 * The body with derived states written: `changes` maps a step name to `{ state, evidence }`, the evidence the state was derived from.
 * A row whose evidence is no longer that, or whose state is already the derived one, is left as it is. Returns `{ body, written }`
 * (the names changed); a table Desk cannot read is returned untouched.
 */
export function setDerived(body, changes) {
  const read = readSteps(body)
  if (read.rows === undefined) return { body, written: [] }
  const lines = [...read.lines]
  const written = []
  for (const row of read.rows) {
    const change = changes.get(row.id)
    if (change === undefined || change.evidence !== row.evidence || change.state === row.state) continue
    lines[row.line] = rowLine({ ...row, state: change.state }, splitCells(lines[row.line]), read.table.col, read.table.width)
    written.push(row.id)
  }
  return { body: lines.join(read.eol), written }
}
