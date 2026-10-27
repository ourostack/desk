// The team's roster: one Markdown file of everyone the team works with, teammates and contacts, and what is worth
// knowing about them. Where it lives is `people` in `_meta/crew.json` (by default `_shared/landscape/roster.md`); its
// shape is the team's own. Crew starts a team with the starter below, and reads only two things from any roster: the
// interview questions under `## What we ask new teammates`, and whether a member's alias or identity appears in it.
// The agent writes each entry in the file's own format; this module lands it, merging it three ways with what
// teammates changed meanwhile: a Markdown table row by row, everything else line by line.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { spawnSync } from "node:child_process"

export { DEFAULT_PEOPLE } from "../desk/crew-config.js"

export const DEFAULT_QUESTIONS = Object.freeze([
  "What name do you go by (and your full name, if different)?",
  "Your pronouns, if you'd like to share them.",
  "Your role, and what you're working on these days.",
  "What should teammates come to you for?",
  "How do you like to be reached, and what's your time zone or usual hours?",
  "Anything else the team should know?",
])

const QUESTIONS_HEADING = "What we ask new teammates"

/** Crew's starter roster, for a team that has none yet. */
export function starterRoster() {
  return [
    "# Roster",
    "",
    "Everyone this team works with, teammates and the people we work with outside the team, and what is worth knowing about them. Every teammate and every teammate's agent reads it. Crew's `crew:roster` skill keeps it.",
    "",
    "## How to write in it",
    "",
    "- Say where each fact came from and when.",
    "- A role is what we have seen someone do, not a formal charter.",
    "- Record other spellings of a name: transcripts mangle them.",
    "- Never guess pronouns: write \"not shared\" until the person tells us.",
    "- Say who to go to for what.",
    "- Keep anything private or sensitive out.",
    "",
    "Each person gets one section, `### Name (alias)`, with short labeled lines: Role, Works on, Go to them for, Pronouns, Reach them, Notes, Source. Leave out a line we know nothing about.",
    "",
    `## ${QUESTIONS_HEADING}`,
    "",
    "When someone joins, their agent asks these in one message, and any of them can be skipped. Change this list to change what we ask.",
    "",
    ...DEFAULT_QUESTIONS.map((question, index) => `${index + 1}. ${question}`),
    "",
    "## Teammates",
    "",
    "One section per teammate, newest last.",
    "",
    "## Contacts",
    "",
    "People we work with outside the team: partners, customers, other teams. One section per person.",
    "",
  ].join("\n")
}

export const toLf = (text) => String(text).replace(/\r\n/gu, "\n")

/**
 * peopleQuestions(text) -> { questions, from: "roster" | "crew" }
 *
 * The list items under the roster's `What we ask new teammates` heading (any heading level, any letter case), or
 * Crew's defaults when the file is missing, has no such heading, or lists nothing under it.
 */
export function peopleQuestions(text) {
  const lines = toLf(text ?? "").split("\n")
  const start = lines.findIndex((line) => new RegExp(`^#{1,6}\\s+${QUESTIONS_HEADING}\\s*#*\\s*$`, "iu").test(line.trim()))
  const questions = []
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (/^#{1,6}\s/u.test(line.trim())) break
    const item = /^\s*(?:\d+[.)]|[-*+])\s+(\S.*?)\s*$/u.exec(line)
    if (item !== null) questions.push(item[1])
  }
  return questions.length > 0 ? { questions, from: "roster" } : { questions: [...DEFAULT_QUESTIONS], from: "crew" }
}

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/** Whether any of `names` appears in `text` as a whole word, ignoring case; letters, digits, `_` and `-` join words. */
export function listedIn(text, names) {
  return names
    .filter((name) => typeof name === "string" && name.trim() !== "")
    .some((name) => new RegExp(`(?<![\\p{L}\\p{N}_-])${escaped(name.trim())}(?![\\p{L}\\p{N}_-])`, "iu").test(String(text)))
}

const MARKER = 31
const OURS = `${"<".repeat(MARKER)} ours`
const BASE = `${"|".repeat(MARKER)} base`
const SPLIT = "=".repeat(MARKER)
const THEIRS = `${">".repeat(MARKER)} theirs`
const ended = (text) => (text.endsWith("\n") || text === "" ? text : `${text}\n`)

// Each conflict in `git merge-file --diff3` output where both sides only added lines at the same place takes the
// teammate's lines first, then ours. A conflict over lines that were already there stays a conflict: null.
function unionOfAdditions(output) {
  const out = []
  let part = null
  const block = { ours: [], base: [], theirs: [] }
  for (const line of output.split("\n")) {
    if (part === null && line === OURS) part = "ours"
    else if (part === "ours" && line === BASE) part = "base"
    else if (part === "base" && line === SPLIT) part = "theirs"
    else if (part === "theirs" && line === THEIRS) {
      if (block.base.length > 0) return null
      out.push(...block.theirs, ...block.ours)
      Object.assign(block, { ours: [], base: [], theirs: [] })
      part = null
    } else if (part === null) out.push(line)
    else block[part].push(line)
  }
  return out.join("\n")
}

// Git's line merge of three LF texts: `{ text }`, `{ conflict: true }` or `{ error }`. The temporary folder is removed
// afterwards; a folder that cannot be removed (a virus scanner holding a file on Windows) is left for the system.
function mergeLines([base, ours, theirs], spawnGit, remove) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "crew-roster-"))
  try {
    const files = { ours, base, theirs }
    for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, name), text)
    const merged = spawnGit("git", ["merge-file", "-p", "--diff3", `--marker-size=${MARKER}`, "-L", "ours", "-L", "base", "-L", "theirs", ...Object.keys(files).map((name) => path.join(dir, name))], { windowsHide: true, encoding: "utf8" })
    const output = String(merged.stdout ?? "")
    if (merged.status === 0) return { text: output }
    if (!(merged.status > 0 && merged.status < 128)) return { error: String(merged.stderr ?? "").trim().split("\n")[0] || "git merge-file did not run" }
    const union = unionOfAdditions(output)
    return union === null ? { conflict: true } : { text: union }
  } finally {
    try {
      remove(dir, { recursive: true, force: true, maxRetries: 3 })
    } catch {
      // Left in the system's temporary folder.
    }
  }
}

// ── Tables, merged row by row ───────────────────────────────────────────────────────────────────────────────────

// Stands in for a table's rows while the rest of the file is merged line by line.
const ROWS = "crew-roster-table-rows"
const tableLine = (line) => line.trimStart().startsWith("|")
const SEPARATOR = /^\s*\|(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/u
const cells = (line) => line.trim().slice(1).replace(/(?<!\\)\|$/u, "").split(/(?<!\\)\|/u).map((cell) => cell.trim())

// A row's identity: its alias when the table has an Alias column and the row fills it, otherwise the whole row.
function keyer(header) {
  const at = cells(header).findIndex((cell) => cell.toLowerCase() === "alias")
  const keyOf = (row) => {
    const alias = at === -1 ? "" : (cells(row)[at] ?? "").toLowerCase()
    return alias === "" ? `row ${row.trim()}` : `alias ${alias}`
  }
  return { keyOf, whole: at === -1 }
}

// The tables in `lines` a row merge can take, by header (compared by its cells, ignoring case): those whose header
// appears once in the file and whose rows each have their own identity.
function tablesOf(lines) {
  const found = new Map()
  const repeated = new Set()
  for (let at = 0; at + 1 < lines.length; at += 1) {
    if (!tableLine(lines[at]) || !SEPARATOR.test(lines[at + 1])) continue
    let end = at + 2
    while (end < lines.length && tableLine(lines[end])) end += 1
    const id = cells(lines[at]).join("|").toLowerCase()
    const { keyOf, whole } = keyer(lines[at])
    const rows = lines.slice(at + 2, end)
    if (found.has(id) || new Set(rows.map(keyOf)).size !== rows.length) repeated.add(id)
    found.set(id, { start: at + 2, end, rows, keyOf, whole })
    at = end - 1
  }
  for (const id of repeated) found.delete(id)
  return found
}

/**
 * The rows of one table merged three ways, keyed on each row's identity: a row changed on one side takes that side's
 * version, a row added on either side is kept, a row removed on one side and unchanged on the other goes. The rows
 * keep the teammate's order; a row only we added follows the row it followed in ours, after any rows the teammate
 * added at that place. Null when one row changed differently on both sides; for a table keyed on whole rows (no
 * Alias column), when both sides replaced the same row.
 */
function mergeRows([base, ours, theirs]) {
  const keyOf = theirs.keyOf
  const byKey = (side) => new Map(side.rows.map((row) => [keyOf(row), row]))
  const [b, o, t] = [byKey(base), byKey(ours), byKey(theirs)]
  if (theirs.whole) {
    const added = (side, other) => [...side.keys()].some((key) => !b.has(key) && !other.has(key))
    if ([...b.keys()].some((key) => !o.has(key) && !t.has(key)) && added(o, t) && added(t, o)) return null
  }
  const merged = new Map()
  for (const key of new Set([...b.keys(), ...o.keys(), ...t.keys()])) {
    const [was, mine, yours] = [b.get(key), o.get(key), t.get(key)]
    const row = mine === yours || mine === was ? yours : yours === was ? mine : null
    if (row === null) return null
    if (row !== undefined) merged.set(key, row)
  }
  const order = [...t.keys()].filter((key) => merged.has(key))
  const oursKeys = [...o.keys()]
  oursKeys.forEach((key, index) => {
    if (order.includes(key) || !merged.has(key)) return
    const previous = oursKeys.slice(0, index).reverse().find((other) => order.includes(other))
    let at = previous === undefined ? 0 : order.indexOf(previous) + 1
    while (at < order.length && !b.has(order[at]) && !o.has(order[at])) at += 1
    order.splice(at, 0, key)
  })
  return order.map((key) => merged.get(key))
}

/**
 * mergePeople({ base, ours, theirs, spawnGit?, remove? }) -> { text } | { conflict: true } | { error }
 *
 * The roster merged three ways: `base` is the file the member's agent edited, `ours` the edited file, `theirs` the
 * file on the default branch now. All three are compared with LF line endings, each ending with a newline. A Markdown
 * table found once in all three is merged row by row (`mergeRows`), so two people changing neighbouring rows both
 * land. Everything else is Git's line merge, where lines both sides added at the same place are kept, the teammate's
 * first, and a change next to or over a teammate's change is a conflict.
 */
export function mergePeople({ base, ours, theirs, spawnGit = spawnSync, remove = rmSync }) {
  const texts = [base, ours, theirs].map((text) => normalized(text))
  const lines = texts.map((text) => text.split("\n"))
  const found = lines.map((side) => tablesOf(side))
  const shared = texts.some((text) => text.includes(ROWS)) ? [] : [...found[2].keys()].filter((id) => found[0].has(id) && found[1].has(id))
  const skeletons = lines.map((side, index) => {
    const out = [...side]
    const at = shared.map((id, n) => [found[index].get(id), n]).sort(([a], [b]) => b.start - a.start)
    for (const [table, n] of at) out.splice(table.start, table.end - table.start, `${ROWS} ${n}`)
    return out.join("\n")
  })
  const merged = mergeLines(skeletons, spawnGit, remove)
  if (merged.text === undefined) return merged
  const out = []
  for (const line of merged.text.split("\n")) {
    const n = line.startsWith(`${ROWS} `) ? Number(line.slice(ROWS.length + 1)) : -1
    if (n === -1) {
      out.push(line)
      continue
    }
    const rows = mergeRows(found.map((side) => side.get(shared[n])))
    if (rows === null) return { conflict: true }
    out.push(...rows)
  }
  return { text: out.join("\n") }
}

/** `text` with LF line endings, ending with a newline: how the roster is compared and merged. */
export function normalized(text) {
  return ended(toLf(text))
}
