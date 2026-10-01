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
      return parseFrontmatter(buffer.toString("utf8", 0, bytesRead)).data
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
      const data = readCardData(path.join(trackDir, taskName, "task.md"))
      if (data === null) continue
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
 * `tracks`: `[{ desk?, track, handle, tasks: [{ desk?, slug, handle, title, status, updated, repos }] }]`,
 * where `repos` is `[{ name?, local_path?, mode? }]`.
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
