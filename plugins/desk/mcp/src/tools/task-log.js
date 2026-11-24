// `task_update`'s `log`: a dated entry appended to `log.md` beside the task card, the cheap way to keep a long record of
// rulings, decisions and evidence pointers in Git. The entry is in the file when the call returns; the detached push worker
// commits it with the entries that follow it (`runtime/append-lane.js`), so ten rapid entries are one commit and one push,
// a call never waits on a publication that is still running, and the server ending does not lose the commit.

import { existsSync, appendFileSync, readFileSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"
import { assertCleanContentTarget } from "../desk/content-home.js"
import { deskRelativePath, resolveWriteTarget } from "../util/paths.js"
import { pathExists } from "../util/fm.js"
import { scratchPathWarning } from "../desk/scratch-paths.js"

const LOG_FILE = "log.md"
// What this process last wrote to each log: a log holding exactly those bytes is Desk's own entry waiting for its commit, not a held draft.
const written = new Map()
const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex")

const pad = (value) => String(value).padStart(2, "0")
const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`

/**
 * Appends `text` to the task's log and schedules the push worker that commits it. Returns the answer fields: the log's path
 * and the note that says no git is needed. Throws before writing anything when the task does not exist or the purpose policy
 * refuses; `admission` is the receipt `admitContent` gave this call, which has checked the base.
 */
export async function appendCardLog({ deskRoot, person, track, slug, text, childSession, admission, search, schedulePush, now = new Date() }) {
  if (childSession !== undefined && !(typeof childSession === "string" && /^[\w.:-]{4,128}$/u.test(childSession))) {
    throw Object.assign(new Error("task_update: Pass `child_session` as the child's session id, 4 to 128 letters, digits, dots, colons, dashes or underscores: that is not a session id; nothing was changed"), { code: "task_update_child_session_is_not_a_session_id" })
  }
  const card = await resolveWriteTarget({ deskRoot, person, segments: [track, slug, "task.md"] })
  if (!(await pathExists(card))) {
    throw Object.assign(new Error(`task_update: Check the track and slug, then try again: task does not exist at ${deskRelativePath(deskRoot, card)}`), { code: "task_update_task_does_not_exist_at" })
  }
  const file = path.join(path.dirname(card), LOG_FILE)
  const rel = deskRelativePath(deskRoot, file)
  assertCleanContentTarget(deskRoot, rel, admission, "task_update", written.get(file))
  const owner = childSession === undefined ? "" : `Child session: ${childSession}\n\n`
  const entry = `\n## ${stamp(now)}\n\n${owner}${text.trim()}\n`
  if (existsSync(file)) appendFileSync(file, entry)
  else writeFileSync(file, `# Log: ${track}/${slug}\n\nAppend-only record for this task, oldest first: rulings, decisions and where the evidence is. Write entries with task_update's \`log\`.\n${entry}`)
  written.set(file, digest(file))
  schedulePush({ root: deskRoot, logs: true })
  search?.noteChange(rel)
  const scratch = scratchPathWarning(text, "This entry")
  return {
    ...(scratch === undefined ? {} : { scratch_paths: scratch }),
    status: "logged",
    path: rel,
    commit: "queued",
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
