// The worktrees and branches a task's agents create, recorded as rows of the card's `## Resources` table, and the
// reminder that a row is due for cleanup. Desk only records and reminds: it never removes, deletes or checks the
// state of anything on the agent's behalf, and it makes no network call.
//
// The table is the six-column contract in the task-lifecycle skill (ms-desk's recovery guard parses its columns, so
// their names and order are never changed here). This slice writes it on task.md; an iteration's doing.md is not written.
// A row is keyed by its identity, `worktree:<absolute path>` or `branch:<owner/repo>#<name>`; a row with any other
// identity (a host resource, a process) is left exactly as it is and never reminded about.
//
// Due: a row whose terminal-disposition cell is empty is due when the step that owns it (`step <id>` in the owning
// column) is delivered or dropped, or when the card is done or cancelled. Desk's step states carry no pull request
// state yet, so "its pull request closed unmerged" is reached through the step being dropped, not read here.
// A due worktree whose path is gone from this machine is a `stale row`: its action is to record it removed. (A card is
// shared across machines, so the path may only be missing here; the answer says so.)

import { existsSync } from "node:fs"
import * as path from "node:path"
import { scan } from "../tools/task-body.js"
import { TERMINAL_STATES } from "./lifecycle.js"
import { readSteps, SETTLED, SEPARATOR, splitCells } from "./steps.js"

export const RESOURCE_FIELDS = ["identity", "step", "intended", "disposition", "details"]
export const DISPOSITIONS = ["removed-and-absent", "named transfer", "retained-with-trigger"]
const HEADING = "## Resources"
// The contract's columns, in its order.
const COLUMNS = [
  "Exact resource / generation identity",
  "Owning task / attempt / generation",
  "Active writers / consumers",
  "Intended disposition",
  "Evidence pointer",
  "Terminal disposition details",
]
const [IDENTITY, OWNER, WRITERS, INTENDED, POINTER, TERMINAL] = COLUMNS.map((_, index) => index)
const BRANCH = /^branch:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\S+)$/u
const EMPTY = /^(?:—|-)?$/u
const STEP_OWNER = /^step ([a-z0-9]+(?:-[a-z0-9]+)*)$/u
const oneLine = (value) => value.replace(/\s*\r?\n\s*/gu, " ").trim()

/** The identity as Desk keeps it, or null when it is neither typed form: a worktree's absolute path (trailing separators dropped) or a branch of `owner/repo`. */
export function canonicalIdentity(identity) {
  if (typeof identity !== "string") return null
  const text = identity.trim()
  if (text.startsWith("worktree:")) {
    const where = text.slice("worktree:".length).replace(/[\\/]+$/u, "")
    return where !== "" && (path.isAbsolute(where) || path.win32.isAbsolute(where)) ? `worktree:${where}` : null
  }
  return BRANCH.test(text) ? text : null
}

/**
 * The card body's resources table: `{ found: false }` when there is none, `{ found: true, reason }` when there is one
 * Desk cannot read, or `{ found: true, rows, table }` where each row is `{ identity, owner, intended, terminal, line }`
 * (cells trimmed and unescaped). `truncated` says the body is only the start of the card (boot's bounded read).
 */
export function readResources(body, { truncated = false } = {}) {
  const { eol, lines, fenced } = scan(body)
  const heading = lines.findIndex((line, index) => !fenced[index] && line.trim() === HEADING)
  if (heading === -1) return { found: false, lines, eol, fenced }
  let end = heading + 1
  while (end < lines.length && (fenced[end] || !/^## /u.test(lines[end]))) end += 1
  const unreadable = (reason) => ({ found: true, reason, lines, eol, fenced })
  const head = lines.findIndex((line, index) => index > heading && index < end && !fenced[index] && line.trim().startsWith("|"))
  if (head === -1) return unreadable("there is no table under the heading")
  const names = splitCells(lines[head]).map((cell) => cell.toLowerCase())
  const col = COLUMNS.map((name) => names.indexOf(name.toLowerCase()))
  const missing = COLUMNS.filter((_, index) => col[index] === -1)
  if (missing.length > 0) return unreadable(`the table has no ${missing.map((name) => JSON.stringify(name)).join(", ")} column`)
  if (head + 1 >= end || !SEPARATOR.test(lines[head + 1].trim())) return unreadable("the table has no separator row under its header")
  const rows = []
  let line = head + 2
  for (; line < end && !fenced[line] && lines[line].trim().startsWith("|"); line += 1) {
    const cells = splitCells(lines[line])
    const cell = (index) => cells[col[index]] ?? ""
    rows.push({ identity: cell(IDENTITY), owner: cell(OWNER), intended: cell(INTENDED), terminal: cell(TERMINAL), line })
  }
  if (truncated && lines.slice(line).every((text) => text.trim() === "")) return unreadable("the card was cut at the read limit inside the table")
  return { found: true, rows, table: { end: line, col, width: names.length }, lines, eol, fenced }
}

// A row as one table line: its own cells are kept (including any past the header's width), and a `|` in any cell is escaped on the way out.
const rowLine = (set, cells, col, width) => {
  const out = Array.from({ length: Math.max(width, cells.length) }, (_, index) => cells[index] ?? "")
  for (const [index, value] of set) out[col[index]] = value
  return `| ${out.map((cell) => cell.replaceAll("|", "\\|")).join(" | ")} |`
}

// The index just past the section that starts at the first heading `match` accepts, or -1 when the card has none.
function afterSection({ lines, fenced }, match) {
  const start = lines.findIndex((line, index) => !fenced[index] && match(line.trim()))
  if (start === -1) return -1
  let at = start + 1
  while (at < lines.length && (fenced[at] || !/^## /u.test(lines[at]))) at += 1
  return at
}

// A new section goes right after `## Steps`, else after `## Outcome`, else at the end of the body.
function withNewSection(read, rowText) {
  const { lines } = read
  const at = [afterSection(read, (line) => line === "## Steps"), afterSection(read, (line) => /^##\s+outcome\s*$/iu.test(line))].find((index) => index !== -1) ?? lines.length
  const before = lines.slice(0, at)
  while (before.length > 0 && before.at(-1).trim() === "") before.pop()
  const after = lines.slice(at)
  const table = [HEADING, "", `| ${COLUMNS.join(" | ")} |`, `|${COLUMNS.map(() => "---").join("|")}|`, rowText]
  return [...before, ...(before.length > 0 ? [""] : []), ...table, ...(after.length > 0 ? ["", ...after] : [""])]
}

/**
 * The body with one resource row added or updated, and what it now says: `{ body, row }`. `taskRef` (`<track>/<slug>`) names
 * the owner of a new row that has no `step`. Refuses, changing nothing, for an identity that is not typed, a step that is not on
 * the card, a disposition without details, or a table Desk cannot read.
 */
export function applyResource(body, input, tool, taskRef) {
  const refuse = (message) => { throw new Error(`${tool}: ${message}; no resource was changed.`) }
  const unknown = Object.keys(input).filter((key) => !RESOURCE_FIELDS.includes(key))
  if (unknown.length > 0) refuse(`resource has unknown field${unknown.length === 1 ? "" : "s"} ${unknown.map((key) => `\`${key}\``).join(", ")}; it takes ${RESOURCE_FIELDS.map((key) => `\`${key}\``).join(", ")}`)
  const identity = canonicalIdentity(input.identity)
  if (identity === null) refuse("resource `identity` must be `worktree:<absolute path>` or `branch:<owner/repo>#<name>` (Desk records worktrees and branches only)")
  const text = (field) => (input[field] === undefined ? undefined : typeof input[field] === "string" ? oneLine(input[field]) : refuse(`resource \`${field}\` must be text`))
  const [step, intended, disposition, details] = ["step", "intended", "disposition", "details"].map(text)
  if (disposition !== undefined && !DISPOSITIONS.includes(disposition)) refuse(`resource \`disposition\` must be one of ${DISPOSITIONS.join(", ")}`)
  if ((disposition === undefined) !== (details === undefined)) refuse("resource `disposition` and `details` go together: the details are the absence readback, the named transferee and their acknowledgement, or the reason, owner and cleanup trigger")
  if (disposition !== undefined && details === "") refuse("resource `details` cannot be empty")
  if (step !== undefined && !(readSteps(body).rows ?? []).some((row) => row.id === step)) refuse(`resource \`step\` ${JSON.stringify(step)} is not a step of this card's \`## Steps\` table`)
  const read = readResources(body)
  if (read.found && read.rows === undefined) refuse(`the \`## Resources\` table on this card is left as prose because ${read.reason}, so ${identity} cannot be written there. Fix the table by hand or leave this resource out`)
  const existing = (read.rows ?? []).find((row) => row.identity === identity)
  const set = [[IDENTITY, identity]]
  if (step !== undefined) set.push([OWNER, `step ${step}`])
  else if (existing === undefined) set.push([OWNER, `task ${taskRef}`])
  if (existing === undefined) set.push([WRITERS, "—"], [POINTER, "—"])
  if (intended !== undefined) set.push([INTENDED, intended])
  else if (existing === undefined) set.push([INTENDED, "—"])
  if (disposition !== undefined) set.push([TERMINAL, `${disposition}: ${details}`])
  const lines = read.found ? [...read.lines] : null
  let out
  if (lines === null) out = withNewSection(read, rowLine(set, [], Object.fromEntries(COLUMNS.map((_, index) => [index, index])), COLUMNS.length))
  else {
    const { col, width, end } = read.table
    if (existing === undefined) lines.splice(end, 0, rowLine(set, [], col, width))
    else lines[existing.line] = rowLine(set, splitCells(lines[existing.line]), col, width)
    out = lines
  }
  const now = readResources(out.join(read.eol)).rows.find((row) => row.identity === identity)
  return { body: out.join(read.eol), row: { identity, owner: now.owner, intended: now.intended, disposition: EMPTY.test(now.terminal) ? "" : now.terminal }, created: existing === undefined }
}

const ACTIONS = {
  worktree: (where) => `if it holds no uncommitted or unpushed work and nothing is running in it, remove it with \`git worktree remove ${where}\` from its repository; then record resource disposition removed-and-absent with the readback as details. If it must stay, record named transfer or retained-with-trigger instead`,
  branch: (name) => `if its pull request is merged (\`gh pr view\` says MERGED), delete the local branch (\`git branch -d ${name}\`) and the remote branch, then record resource disposition removed-and-absent with the readback as details. If it must stay, record named transfer or retained-with-trigger instead`,
}
const STALE = (where) => `stale row: ${where} is not on this machine (it may exist on another); if you removed it, record resource disposition removed-and-absent with how you checked as details`

/**
 * The card's resource rows that are due, `[{ identity, why, action, stale }]`: terminal column empty, and the step that owns the
 * row delivered or dropped, or the card `status` done or cancelled. A worktree whose path is gone is `stale` and its action is to
 * record it removed. Reads only the body and the file system; `exists` is for tests.
 */
export function dueResources(body, { status, truncated = false, exists = existsSync }) {
  const read = readResources(body, { truncated })
  if (read.rows === undefined) return []
  const steps = readSteps(body, { truncated }).rows ?? []
  const ended = TERMINAL_STATES.includes(status)
  const due = []
  for (const row of read.rows) {
    const identity = canonicalIdentity(row.identity)
    if (identity !== row.identity || !EMPTY.test(row.terminal)) continue
    const step = steps.find((item) => item.id === STEP_OWNER.exec(row.owner)?.[1])
    const why = [...(step !== undefined && SETTLED.includes(step.state) ? [`step ${step.id} is ${step.state}`] : []), ...(ended ? [`the task is ${status}`] : [])]
    if (why.length === 0) continue
    const branch = BRANCH.exec(identity)
    const where = branch === null ? identity.slice("worktree:".length) : branch[2]
    const stale = branch === null && !exists(where)
    due.push({ identity, why: why.join(" and "), action: stale ? STALE(where) : ACTIONS[branch === null ? "worktree" : "branch"](where), stale })
  }
  return due
}
