// Teammate notes on disk. In a Crew workspace, note_leave writes a note into the recipient's `desks/<alias>/_inbox/`
// through a pull request; session start lists the open ones; note_ack marks one acknowledged. This module holds the file
// format and the reads, with no dependency beyond Node, because session start loads it.
//
// A note is Markdown with frontmatter that note_leave writes itself, every value JSON-quoted (valid YAML):
//   from, to (aliases), created (ISO time with offset), status (open | acknowledged), subject, related (list), and
//   acknowledged (the time, once acknowledged).

import { readdirSync, readFileSync } from "node:fs"
import * as path from "node:path"

export const INBOX = "_inbox"
// How many open notes session start lists; it counts the rest.
export const NOTES_SHOWN_CAP = 5
const SUBJECT_SHOWN_CHARS = 120
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u

/** The note file's text. `related` lists links (https URLs or repository paths); the closing line says who to ask. */
export function renderNote({ from, to, created, subject, related, body }) {
  const quote = (value) => JSON.stringify(value)
  const head = ["---", `from: ${quote(from)}`, `to: ${quote(to)}`, `created: ${quote(created)}`, "status: open", `subject: ${quote(subject)}`]
  head.push(...(related.length === 0 ? ["related: []"] : ["related:", ...related.map((link) => `  - ${quote(link)}`)]), "---")
  const links = related.length === 0 ? [] : ["Related:", "", ...related.map((link) => `- ${link}`), ""]
  return [...head, "", body.trim(), "", ...links, `${from} left this note with note_leave. Ask ${from} if anything here is unclear.`, ""].join("\n")
}

function scalar(raw) {
  const value = raw.trim()
  if (!value.startsWith("\"")) return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

/** A note's fields, `related` and the text below the frontmatter (`content`), or null for text with no frontmatter. Lenient: a hand-edited note still reads. */
export function parseNote(text) {
  const head = FRONTMATTER.exec(text)
  if (head === null) return null
  const note = { related: [] }
  let inRelated = false
  for (const line of head[1].split(/\r?\n/u)) {
    const item = /^\s+-\s+(.*)$/u.exec(line)
    if (item !== null) {
      if (inRelated) note.related.push(scalar(item[1]))
      continue
    }
    const field = /^([a-z_]+):(.*)$/u.exec(line)
    if (field === null) continue
    inRelated = field[1] === "related"
    if (!inRelated) note[field[1]] = scalar(field[2])
  }
  note.content = text.slice(head[0].length)
  return note
}

/** The note's text with `status: acknowledged` and the time, or null when it is not an open note. Nothing else changes. */
export function acknowledgeNote(text, at) {
  const head = FRONTMATTER.exec(text)
  if (head === null) return null
  const eol = head[0].includes("\r\n") ? "\r\n" : "\n"
  const next = head[0].replace(/^status: open(?=\r?$)/mu, `status: acknowledged${eol}acknowledged: ${JSON.stringify(at)}`)
  return next === head[0] ? null : next + text.slice(head[0].length)
}

const shown = (value, fallback) => {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim()
  return text === "" ? fallback : text.slice(0, SUBJECT_SHOWN_CHARS)
}

/**
 * The open notes in the inbox of the person whose desk is `personPrefix` (`desks/<alias>`) under `deskRoot`, oldest
 * first: `{ path, count, notes: [{ from, created, subject, path }], more }`, at most NOTES_SHOWN_CAP notes with `more`
 * counting the rest, paths relative to the desk root. Null when there is no open note. A file that is not a note is
 * skipped.
 */
export function openNotes(deskRoot, personPrefix) {
  const rel = `${personPrefix}/${INBOX}`
  const dir = path.join(deskRoot, personPrefix, INBOX)
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return null
  }
  const open = []
  for (const name of names.filter((each) => each.endsWith(".md"))) {
    let note
    try {
      note = parseNote(readFileSync(path.join(dir, name), "utf8"))
    } catch {
      continue
    }
    if (note?.status !== "open") continue
    const at = Date.parse(note.created)
    open.push({ at: Number.isNaN(at) ? Infinity : at, note: { from: shown(note.from, "unknown"), created: shown(note.created, "unknown"), subject: shown(note.subject, "(no subject)"), path: `${rel}/${name}` } })
  }
  if (open.length === 0) return null
  open.sort((a, b) => (a.at === b.at ? a.note.path.localeCompare(b.note.path) : a.at < b.at ? -1 : 1))
  return { path: rel, count: open.length, notes: open.slice(0, NOTES_SHOWN_CAP).map((entry) => entry.note), more: Math.max(open.length - NOTES_SHOWN_CAP, 0) }
}
