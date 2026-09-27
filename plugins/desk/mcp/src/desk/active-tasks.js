// activeTasks — the read-only active-task listing desk:session-start renders
// in its status block (Step 3 and Step 5), with every name redacted.
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
// at most 64 KiB, and parsed with the dependency-free frontmatter reader, so
// the script runs straight from the installed plugin.

import { closeSync, openSync, readdirSync, readSync } from "node:fs"
import * as path from "node:path"
import { parseFrontmatterLite } from "./frontmatter-lite.js"
import { redactName, redactTitle, REDACTED_SEGMENT, REDACTED_TITLE } from "../util/redact.js"

const TERMINAL_STATUSES = new Set(["done", "cancelled"])
const MAX_CARD_BYTES = 64 * 1024

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

// null when the card is missing or unreadable; `{}` data when its frontmatter is malformed.
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
      return parseFrontmatterLite(buffer.toString("utf8", 0, bytesRead)).data
    } catch {
      return {}
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

function scanDesk(scanRoot, desk, counts) {
  const tracks = []
  for (const trackName of listDirs(scanRoot)) {
    if (desk === null && trackName === "desks") continue
    const tasks = []
    for (const taskName of listDirs(path.join(scanRoot, trackName))) {
      const data = readCardData(path.join(scanRoot, trackName, taskName, "task.md"))
      if (data === null) continue
      const status = asText(data.status)
      if (TERMINAL_STATUSES.has(status)) continue
      const slug = redactName(taskName)
      const title = asText(data.title)
      const shownTitle = title === null ? null : redactTitle(title)
      if (slug === REDACTED_SEGMENT) counts.names += 1
      if (shownTitle === REDACTED_TITLE) counts.titles += 1
      tasks.push({ ...(desk === null ? {} : { desk }), slug, title: shownTitle, status: status === null ? null : redactName(status), updated: asText(data.updated) })
    }
    if (tasks.length === 0) continue
    tasks.sort(byUpdatedDesc)
    const track = redactName(trackName)
    if (track === REDACTED_SEGMENT) counts.names += 1
    tracks.push({ ...(desk === null ? {} : { desk }), track, tasks })
  }
  return tracks
}

/**
 * activeTasks(deskRoot) -> { tracks, task_count, track_count, redacted }
 *
 * `tracks`: `[{ desk?, track, tasks: [{ desk?, slug, title, status, updated }] }]`.
 * `redacted`: `{ names, titles }`, how many names and titles were hidden.
 */
export function activeTasks(deskRoot) {
  const counts = { names: 0, titles: 0 }
  const tracks = scanDesk(deskRoot, null, counts)
  for (const alias of listDirs(path.join(deskRoot, "desks"))) {
    const desk = redactName(alias)
    if (desk === REDACTED_SEGMENT) counts.names += 1
    tracks.push(...scanDesk(path.join(deskRoot, "desks", alias), desk, counts))
  }
  tracks.sort((a, b) => byUpdatedDesc(a.tasks[0], b.tasks[0]))
  return {
    tracks,
    task_count: tracks.reduce((sum, track) => sum + track.tasks.length, 0),
    track_count: tracks.length,
    redacted: counts,
  }
}

/**
 * The `scripts/active-tasks.js` command line: `--root <path>` (the root
 * desk_status reports) prints the listing as JSON and exits 0; a missing or
 * unknown argument exits 2.
 */
export function runActiveTasksCli({ argv = process.argv.slice(2), io = process } = {}) {
  if (argv.length !== 2 || argv[0] !== "--root" || !argv[1]) {
    io.stderr.write("usage: active-tasks.js --root <desk root from desk_status>\n")
    return 2
  }
  io.stdout.write(`${JSON.stringify(activeTasks(path.resolve(argv[1])), null, 2)}\n`)
  return 0
}
