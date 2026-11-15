// `task_update`'s `log`: a dated entry appended to `log.md` beside the task card, the cheap way to keep a long record of
// rulings, decisions and evidence pointers in Git. The entry is in the file when the call returns; its commit is shared with
// the entries that follow it (`runtime/append-lane.js`), so ten rapid entries are one commit and one push, and a call never
// waits on a publication that is still running.

import { existsSync, appendFileSync, readFileSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { assertCleanContentTarget } from "../desk/content-home.js"
import { pendingDigest, queueAppend } from "../runtime/append-lane.js"
import { deskRelativePath, resolveWriteTarget } from "../util/paths.js"
import { pathExists } from "../util/fm.js"
import { scratchPathWarning } from "../desk/scratch-paths.js"

const LOG_FILE = "log.md"

const pad = (value) => String(value).padStart(2, "0")
const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`

/**
 * Appends `text` to the task's log and queues its commit. Returns the answer fields: the log's path, how many files wait for
 * the shared commit, and the note that says no git is needed. Throws before writing anything when the task does not exist or
 * the purpose policy refuses; `admission` is the receipt `admitContent` gave this call, which has checked the base.
 */
export async function appendCardLog({ deskRoot, person, track, slug, text, admission, search, lane, now = new Date() }) {
  const card = await resolveWriteTarget({ deskRoot, person, segments: [track, slug, "task.md"] })
  if (!(await pathExists(card))) {
    throw Object.assign(new Error(`task_update: Check the track and slug, then try again: task does not exist at ${deskRelativePath(deskRoot, card)}`), { code: "task_update_task_does_not_exist_at" })
  }
  const file = path.join(path.dirname(card), LOG_FILE)
  const rel = deskRelativePath(deskRoot, file)
  assertCleanContentTarget(deskRoot, rel, admission, "task_update", pendingDigest(deskRoot, rel))
  const entry = `\n## ${stamp(now)}\n\n${text.trim()}\n`
  if (existsSync(file)) appendFileSync(file, entry)
  else writeFileSync(file, `# Log: ${track}/${slug}\n\nAppend-only record for this task, oldest first: rulings, decisions and where the evidence is. Write entries with task_update's \`log\`.\n${entry}`)
  const waiting = queueAppend({ root: deskRoot, rels: [rel], admission, ...lane })
  search?.noteChange(rel)
  const scratch = scratchPathWarning(text, "This entry")
  return {
    ...(scratch === undefined ? {} : { scratch_paths: scratch }),
    status: "logged",
    path: rel,
    commit: "queued",
    waiting_files: waiting,
    desk_note: "Desk wrote the entry to the log and commits it with the entries that follow within a few seconds as one commit, then pushes once, so run no git for it. Say 'logged', not 'pushed'.",
  }
}

const ENTRY = /^## (\d{4}-\d\d-\d\d \d\d:\d\d)\s*$/u
const LATEST_CHARS = 240

/**
 * What a successor reads first about a task's log: where it is, how many entries it holds and the newest one's start, or
 * undefined when the task has no log. `card` is the card's file.
 */
export function logSummary(deskRoot, card) {
  const file = path.join(path.dirname(card), LOG_FILE)
  let lines
  try {
    lines = readFileSync(file, "utf8").split(/\r?\n/u)
  } catch {
    return undefined
  }
  const at = lines.flatMap((line, index) => (ENTRY.test(line) ? [index] : []))
  const last = at.at(-1)
  const body = last === undefined ? "" : lines.slice(last + 1).join(" ").replace(/\s+/gu, " ").trim()
  const text = body.length > LATEST_CHARS ? `${body.slice(0, LATEST_CHARS).trimEnd()} ...` : body
  return {
    path: deskRelativePath(deskRoot, file),
    entries: at.length,
    ...(last === undefined ? {} : { latest: `${ENTRY.exec(lines[last])[1]}: ${text}` }),
    note: "Read this log before asking the operator for a ruling or redoing work; it is the record a successor resumes from, not a host checkpoint.",
  }
}
