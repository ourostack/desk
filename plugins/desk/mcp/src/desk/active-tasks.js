// activeTasks — the read-only active-task listing desk_status serves as
// `active_tasks`, which desk:session-start and desk:status render in their
// status blocks, with every name redacted.
//
// Why it exists: the session-start scan used to glob task cards by hand and
// echo each folder name, and a folder named after a prompt that held a
// password put that password in the chat and the transcript (M4-7-F4,
// 2026-09-27). This listing redacts a track, task or desk name that carries a
// secret's value to `<redacted segment>`, and a title that does to
// `<redacted title>` (src/util/redact.js), so the status block never has to
// judge a name itself. It counts what it redacted so the agent can say so.
//
// Layout (directory-structure): `<track>/<task>/task.md`, skipping `_` and `.`
// folders (so `_archive/` and `_planning/` are never read). In a crew
// workspace, each `desks/<alias>/` subtree is listed the same way and each
// task carries its `desk`. A task is active when its status is not `done` or
// `cancelled`; within a track, tasks sort by `updated`, newest first, and
// tracks by their newest task. Each card is read through one bounded read of
// at most 64 KiB, and parsed with the doctor's frontmatter parser, so the
// listing adds little to desk_status's time budget. It is served from the
// Desk MCP server rather than a script so hosts that gate shell commands do
// not prompt for it at every session start.

import { closeSync, openSync, readdirSync, readSync } from "node:fs"
import * as path from "node:path"
import { loadFrontmatterParser } from "./organization.js"
import { redactCredentialLikeText, redactName, redactTitle, REDACTED_SEGMENT, REDACTED_TITLE } from "../util/redact.js"
import { folderHandle } from "./handles.js"
import { TERMINAL_STATES } from "./lifecycle.js"
import { readSteps, summarizeSteps } from "./steps.js"

const TERMINAL_STATUSES = new Set(TERMINAL_STATES)
const MAX_CARD_BYTES = 64 * 1024
// gray-matter in the server, so nested fields such as `repos` are read.
const parseFrontmatter = loadFrontmatterParser()

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_") && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

// The card's text with fenced code blocks blanked, so a marker quoted inside a fence is never mistaken for the card's own.
function withoutFences(content) {
  let open = null
  return content
    .split(/\r?\n/u)
    .map((line) => {
      const fence = /^\s{0,3}(`{3,}|~{3,})/u.exec(line)
      if (open === null) {
        if (fence === null) return line
        open = fence[1]
        return ""
      }
      if (fence !== null && fence[1][0] === open[0] && fence[1].length >= open.length && line.trim() === fence[1]) open = null
      return ""
    })
    .join("\n")
}

// A line that starts a new labelled field (`**Label:** ...`) ends the paragraph before it.
const LABEL_LINE = /^\s*(?:>\s*)?(?:[-*+]\s+)?\*\*[^*\n]+:\*\*/u

// The card's `**Next step:**` paragraph (task-body.js writes it), one line, redacted like any other text, or null.
export function nextStepOf(content) {
  const match = /^\*\*Next step:\*\*[ \t]*(.*(?:\n(?![ \t]*\n|[ \t]*(?:[-*+]|\d+[.)])\s|#{1,6}\s|\*\*[^*\n]+:\*\*).+)*)/mu.exec(withoutFences(content))
  if (match === null) return null
  const line = redactCredentialLikeText(match[1].replace(/\s+/gu, " ").trim())
  return line === "" ? null : line
}

const BLOCKER_LABELS = "(?:blockers?|waiting on|blocked on|blocked by)"
const BLOCKER_LINE = new RegExp(`^(?:\\*\\*${BLOCKER_LABELS}:?\\*\\*:?|${BLOCKER_LABELS}:)[ \\t]*(.*)$`, "iu")
const BLOCKER_HEADING = new RegExp(`^#{1,6}[ \\t]+${BLOCKER_LABELS}[ \\t]*:?[ \\t]*$`, "iu")
const LIST_MARKER = /^(?:[-*+]|\d+[.)])\s+/u
const NOTHING = /^(?:none|n\/a|na|nil|no blockers?|nothing|-|—)\.?$/iu

// A card line without its blockquote and list markers.
const bare = (line) => line.trim().replace(/^>\s*/u, "").replace(LIST_MARKER, "")

const nonBlank = (lines, start) => {
  let index = start
  while (index < lines.length && lines[index].trim() === "") index += 1
  return index
}

// The lines from `start` that continue one paragraph: it ends at a blank line, a heading, a list item or the next `**Label:**` line.
function paragraphFrom(lines, start) {
  const out = []
  for (let index = start; index < lines.length; index += 1) {
    const raw = lines[index]
    const line = raw.trim().replace(/^>\s*/u, "")
    if (line === "" || /^#{1,6}\s/u.test(line) || LIST_MARKER.test(line) || LABEL_LINE.test(raw)) break
    out.push(line)
  }
  return out.join(" ")
}

// The text of a `## Blockers` section: its list items joined with "; ", or its first paragraph when it has no list.
function sectionText(lines, start) {
  let end = start
  while (end < lines.length && !/^#{1,6}\s/u.test(lines[end])) end += 1
  const body = lines.slice(start, end)
  const items = []
  for (let index = 0; index < body.length; index += 1) {
    const line = body[index].trim().replace(/^>\s*/u, "")
    if (!LIST_MARKER.test(line)) continue
    const item = [line.replace(LIST_MARKER, "")]
    while (index + 1 < body.length && body[index + 1].trim() !== "" && !LIST_MARKER.test(body[index + 1].trim().replace(/^>\s*/u, ""))) {
      index += 1
      item.push(body[index].trim().replace(/^>\s*/u, ""))
    }
    items.push(item.join(" "))
  }
  if (items.length > 0) return items.map((item) => item.trim()).filter((item) => !NOTHING.test(item.replace(/\s+/gu, " ").trim()) && item.trim() !== "").join("; ")
  return paragraphFrom(body, nonBlank(body, 0))
}

// Why the card says the task is blocked, one line, redacted like any other text, or null. Cards record it as a
// `## Blocker`, `## Blockers` (a list) or `## Waiting on` section, or as a `**Blocker:**` / `Waiting on:` line, which may
// sit in a list item or a blockquote (task-lifecycle: the transition to `blocked` writes a "Blocker" / "Waiting on" line with
// the specific reason). "None" and "n/a" mean no blocker. Fenced code is skipped.
function blockerOf(content) {
  const lines = withoutFences(content).split(/\r?\n/u)
  for (let index = 0; index < lines.length; index += 1) {
    const line = bare(lines[index])
    let text = null
    if (BLOCKER_HEADING.test(lines[index].trim())) {
      text = sectionText(lines, index + 1)
    } else {
      const inline = BLOCKER_LINE.exec(line)
      // The reason is on the label's line (a wrapped reason continues below it) or, when the line holds only the label, below it.
      if (inline !== null) text = [inline[1], paragraphFrom(lines, inline[1] === "" ? nonBlank(lines, index + 1) : index + 1)].join(" ")
    }
    const clean = text === null ? "" : redactCredentialLikeText(text.replace(/\s+/gu, " ").trim())
    if (clean !== "" && !NOTHING.test(clean)) return clean
  }
  return null
}

// The card's `## Steps` table as a compact summary (steps.js), or nothing when it has none, has no rows or is left as prose.
// The table sits right after `## Outcome`, so it is inside the bounded read of a card that is long below it.
function stepsOf(content, truncated) {
  const { rows } = readSteps(content, { truncated })
  if (rows === undefined || rows.length === 0) return {}
  const summary = summarizeSteps(rows)
  return { steps: { ...summary, blocked: summary.blocked.map(({ id, reason }) => ({ id, reason: redactCredentialLikeText(reason) })) } }
}

// null when the card is missing or unreadable; `{ data: {}, content: "" }` when its frontmatter is malformed.
function readCardData(filePath) {
  let fd
  try {
    fd = openSync(filePath, "r")
  } catch {
    return null
  }
  try {
    const buffer = Buffer.alloc(MAX_CARD_BYTES)
    const bytesRead = readSync(fd, buffer, 0, MAX_CARD_BYTES, 0)
    try {
      const parsed = parseFrontmatter(buffer.toString("utf8", 0, bytesRead))
      return { data: parsed.data, content: parsed.content, truncated: bytesRead === MAX_CARD_BYTES }
    } catch {
      return { data: {}, content: "" }
    }
  } finally {
    closeSync(fd)
  }
}

function asText(value) {
  if (value instanceof Date) return value.toISOString()
  return typeof value === "string" ? value : null
}

// Newest `updated` first; a task with no `updated` sorts last.
function byUpdatedDesc(a, b) {
  return updatedKey(b).localeCompare(updatedKey(a))
}

function updatedKey(task) {
  return task.updated ?? ""
}

// The card's code repositories, so session start and status need not open the
// card: each entry's name, local path and mode, redacted like any other text.
function shownRepos(repos) {
  if (!Array.isArray(repos)) return []
  return repos
    .filter((repo) => repo !== null && typeof repo === "object")
    .map((repo) => {
      const shown = {}
      for (const field of ["name", "local_path", "mode"]) {
        if (typeof repo[field] === "string") shown[field] = redactCredentialLikeText(repo[field])
      }
      return shown
    })
}

function scanDesk(deskRoot, scanRoot, desk, counts) {
  const tracks = []
  for (const trackName of listDirs(scanRoot)) {
    if (desk === null && trackName === "desks") continue
    const trackDir = path.join(scanRoot, trackName)
    const tasks = []
    for (const taskName of listDirs(trackDir)) {
      const card = readCardData(path.join(trackDir, taskName, "task.md"))
      if (card === null) continue
      const { data, content, truncated } = card
      const status = asText(data.status)
      if (TERMINAL_STATUSES.has(status)) continue
      const slug = redactName(taskName)
      const title = asText(data.title)
      const shownTitle = title === null ? null : redactTitle(title)
      if (slug === REDACTED_SEGMENT) counts.names += 1
      if (shownTitle === REDACTED_TITLE) counts.titles += 1
      tasks.push({
        ...(desk === null ? {} : { desk }),
        slug,
        handle: folderHandle("task", deskRoot, path.join(trackDir, taskName)),
        title: shownTitle,
        status: status === null ? null : redactName(status),
        updated: asText(data.updated),
        repos: shownRepos(data.repos),
        next_step: nextStepOf(content),
        blocker: blockerOf(content),
        ...stepsOf(content, truncated),
      })
    }
    if (tasks.length === 0) continue
    tasks.sort(byUpdatedDesc)
    const track = redactName(trackName)
    if (track === REDACTED_SEGMENT) counts.names += 1
    tracks.push({ ...(desk === null ? {} : { desk }), track, handle: folderHandle("track", deskRoot, trackDir), tasks })
  }
  return tracks
}

/**
 * activeTasks(deskRoot) -> { tracks, task_count, track_count, redacted }
 *
 * `tracks`: `[{ desk?, track, handle, tasks: [{ desk?, slug, handle, title, status, updated, repos, next_step }] }]`,
 * where `next_step` is the card's `**Next step:**` paragraph on one line, in full, or null, `blocker` is why the card says the task is blocked (a `## Blocker` section or a `Blocker:` line) on one line, or null,
 * where `repos` is `[{ name?, local_path?, mode? }]`, and `steps` (only on a card with a readable `## Steps` table) is `{ total, delivered, ready: [id], blocked: [{ id, reason }] }`, dropped steps not counted.
 * `handle`: the folder's stable handle (./handles.js), which task_move and
 * track_rename take in place of a name, so a redacted folder can be renamed.
 * `redacted`: `{ names, titles }`, how many names and titles were hidden.
 */
export function activeTasks(deskRoot) {
  const counts = { names: 0, titles: 0 }
  const tracks = scanDesk(deskRoot, deskRoot, null, counts)
  for (const alias of listDirs(path.join(deskRoot, "desks"))) {
    const desk = redactName(alias)
    if (desk === REDACTED_SEGMENT) counts.names += 1
    tracks.push(...scanDesk(deskRoot, path.join(deskRoot, "desks", alias), desk, counts))
  }
  tracks.sort((a, b) => byUpdatedDesc(a.tasks[0], b.tasks[0]))
  return {
    tracks,
    task_count: tracks.reduce((sum, track) => sum + track.tasks.length, 0),
    track_count: tracks.length,
    redacted: counts,
  }
}
