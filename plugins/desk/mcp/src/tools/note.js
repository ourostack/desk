// note_leave and note_ack: one Crew member's agent leaves another member a dated, attributed note, which that member's
// session start lists until they acknowledge it.
//
// note_leave writes one new file, `desks/<recipient>/_inbox/<date>-<sender>-<slug>-<unique>.md`, and nothing else. The
// sender is the session's person, never a value the caller supplies, and the recipient must be on the workspace's roster
// (`_meta/desks.md`), checked here and again on the default branch. The write goes through Crew's shared-write protocol
// (shared-write.js): a pull request the tool opens and merges at once, so it never touches another member's desk in this
// checkout. An exact duplicate of a note already in the recipient's inbox, open or acknowledged, is refused.
//
// note_ack is the recipient's own write: it marks the note acknowledged on their desk and commits it. The file stays.
// The file format and the session-start read live in runtime/inbox.js.

import { promises as fs, readdirSync, readFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { slugify } from "../util/fm.js"
import { resolveWriteTarget } from "../util/paths.js"
import { isGitRepository, hasUnstagedWork } from "../util/git-stage.js"
import { chooseAccount as chooseAccountDefault, ghRunner } from "../factory/flush.js"
import { withAmbientToken } from "../runtime/boot.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"
import { crewWorkspace, parseCrewRoster } from "../desk/crew-roster.js"
import { INBOX, acknowledgeNote, parseNote, renderNote } from "../runtime/inbox.js"
import { stageAndCommitFiles } from "./_card-commit.js"
import { Failed, githubStore, pause, runGit, sharedWrite } from "./shared-write.js"

// Every field each tool reads off `input`; __tests__/tool_schema_parity.test.js checks these against tool-schemas.js.
export const NOTE_LEAVE_FIELDS = ["to", "subject", "body", "related"]
export const NOTE_ACK_FIELDS = ["note"]

const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u
const SUBJECT_MAX = 120
const BODY_MAX = 8000
const RELATED_MAX = 10
const SCHEME = /^[a-z][a-z0-9+.-]*:/iu

/** `date` as ISO 8601 local time with its UTC offset, to the second: 2026-10-30T13:05:06-07:00. */
export function localIso(date) {
  const offset = -date.getTimezoneOffset()
  const local = new Date(date.getTime() + offset * 60_000).toISOString().slice(0, 19)
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, "0")
  const minutes = String(Math.abs(offset) % 60).padStart(2, "0")
  return `${local}${offset < 0 ? "-" : "+"}${hours}:${minutes}`
}

/** The note's file name: its date, its sender, its subject as a slug (at most 40 characters) and a unique ending. */
export function noteFileName({ date, from, subject, unique }) {
  const slug = slugify(subject).slice(0, 40).replace(/-+$/u, "")
  return `${date}-${from}-${slug === "" ? "note" : slug}-${unique}.md`
}

function workspaceOf(deskRoot, tool) {
  const workspace = crewWorkspace(deskRoot)
  if (!workspace.crew) throw new Error(`${tool}: notes are for a Crew shared workspace, and this desk is not one`)
  return workspace
}

// The session's person, who sends or receives: never a value the caller supplies.
function personOf(person, tool) {
  const alias = typeof person === "string" ? person.trim() : ""
  if (!ALIAS.test(alias)) throw new Error(`${tool}: this session has no person, so the note would have no ${tool === "note_leave" ? "sender" : "recipient"}; call desk_status to see why`)
  return alias
}

function textOf(value, name, max, rule) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`note_leave: \`${name}\` is required (string)`)
  const text = value.trim()
  if (text.length > max || (rule === "one line" && /[\r\n]/u.test(text))) throw new Error(`note_leave: \`${name}\` must be ${rule === "one line" ? "one line of " : ""}at most ${max} characters`)
  return text
}

// An https URL with no credentials in it, or a path inside the repository: never absolute, never climbing out.
function relatedEntry(entry) {
  if (typeof entry !== "string") return null
  const value = entry.trim()
  if (value === "" || /[\u0000-\u001f\u007f]/u.test(value)) return null
  if (SCHEME.test(value)) {
    let url
    try {
      url = new URL(value)
    } catch {
      return null
    }
    return url.protocol === "https:" && url.username === "" && url.password === "" ? value : null
  }
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((part) => part === ".." || part === ".")) return null
  return value
}

function relatedOf(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new Error("note_leave: `related` must be a list of links")
  if (value.length > RELATED_MAX) throw new Error(`note_leave: \`related\` takes at most ${RELATED_MAX} links`)
  return value.map((entry) => {
    const link = relatedEntry(entry)
    if (link === null) throw new Error("note_leave: each `related` entry must be an https URL or a path in this repository (relative, with no .. or .)")
    return link
  })
}

const readText = (file) => {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

const notesIn = (dir) => {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".md")).sort()
  } catch {
    return []
  }
}

/**
 * note_leave
 *
 * Input: { to, subject, body, related? }. `to` is a member's alias; `subject` one line of at most 120 characters; `body`
 * the sender agent's own explanation, at most 8000 characters; `related` up to 10 https URLs or paths in the workspace.
 * Input errors throw before any remote work.
 *
 * Returns { status: "merged" | "pr_open" | "duplicate" | "failed", to, note, repo, message, ... }: `note` is the note's
 * path (for a duplicate, the existing note's, with `note_status`); `pr`, `branch`, `commit`, `account`, `reason` and
 * `stage` as the shared write reports them. The note is left only when `status` is "merged".
 */
export async function note_leave({ deskRoot, input, person = null, spawnGit = spawnSync, gh = withAmbientToken(ghRunner(), process.env), chooseAccount = chooseAccountDefault, tmpRoot = os.tmpdir(), wait = pause, now = () => new Date() }) {
  const created = localIso(now())
  const roster = workspaceOf(deskRoot, "note_leave").roster
  const from = personOf(person, "note_leave")
  const { to: rawTo, subject: rawSubject, body: rawBody, related: rawRelated } = input
  if (typeof rawTo !== "string" || rawTo.trim() === "") throw new Error("note_leave: `to` is required: the alias of the member the note is for")
  const to = rawTo.trim()
  if (!ALIAS.test(to)) throw new Error("note_leave: `to` must be a member's alias, as in _meta/desks.md")
  if (!roster.some((row) => row.alias === to)) throw new Error(`note_leave: ${to} has not joined this workspace (no row in _meta/desks.md), so no session of theirs would see the note`)
  if (to === from) throw new Error("note_leave: `to` is you; a note to yourself belongs on your own desk (a task, or a file you save with desk_save)")
  const subject = textOf(rawSubject, "subject", SUBJECT_MAX, "one line")
  const body = textOf(rawBody, "body", BODY_MAX, "text")
  const related = relatedOf(rawRelated)
  const origin = githubStore(deskRoot, spawnGit)
  if (origin === null) throw new Error("note_leave: a note is delivered through a GitHub pull request, and this workspace's origin is not on GitHub")
  const name = noteFileName({ date: created.slice(0, 10), from, subject, unique: randomBytes(3).toString("hex") })
  const inbox = `desks/${to}/${INBOX}`
  const text = renderNote({ from, to, created, subject, related, body })
  const content = parseNote(text).content
  const result = { to, note: `${inbox}/${name}`, repo: origin }
  let existing = null
  // Runs on a fresh checkout of the default branch, holding only the roster and the recipient's inbox.
  const write = async (tree) => {
    const members = parseCrewRoster(readText(path.join(tree, "_meta", "desks.md"))) ?? []
    if (!members.some((row) => row.alias === to)) throw new Failed("member", `${to} is not on the roster in _meta/desks.md on the default branch of ${result.repo}`)
    for (const link of related) {
      if (!SCHEME.test(link) && !runGit(["cat-file", "-e", `HEAD:${link}`], { cwd: tree, spawnGit }).ok) throw new Failed("related", `${link} is not on the default branch of ${result.repo}`)
    }
    const dir = path.join(tree, ...inbox.split("/"))
    for (const each of notesIn(dir)) {
      const other = parseNote(readText(path.join(dir, each))) ?? {}
      if (other.from === from && other.subject === subject && other.content === content) {
        existing = { note: `${inbox}/${each}`, status: other.status }
        return null
      }
    }
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, name), text, "utf8")
    return true
  }
  let outcome
  try {
    outcome = await sharedWrite({
      top: deskRoot, origin, result, write, spawnGit, gh, chooseAccount, tmpRoot, wait,
      tmpPrefix: "desk-note-",
      sparse: ["/_meta/desks.md", `/${inbox}/`],
      add: [result.note],
      branch: `note/${to}-${slugify(subject).slice(0, 30)}-${Date.now().toString(36)}`,
      title: `Note for ${to}: ${subject}`,
      commitMessage: `Note for ${to}: ${subject}`,
      prBody: () => `Leaves ${to} a note from ${from}, written by Desk's note_leave: ${result.note}`,
      closeComment: `${to}'s inbox already holds this note.`,
    })
  } catch (error) {
    // Any failure once the remote work starts is reported, not thrown; anything else (a bug) is thrown.
    if (!(error instanceof Failed)) throw error
    const open = result.pr ? ` The pull request ${result.pr} is open, on branch ${result.branch}.` : ""
    return { ...result, status: "failed", stage: error.stage, reason: error.message, message: `Not left: the note stopped at ${error.stage} (${error.message}).${open}` }
  }
  if (outcome.status === "unchanged") {
    return { ...result, status: "duplicate", note: existing.note, note_status: existing.status, message: `Not left: ${to} already has this note from you (${existing.note}, ${existing.status}).` }
  }
  if (outcome.status === "pr_open") {
    return { ...result, status: "pr_open", reason: outcome.reason, message: `Not delivered yet: the pull request ${result.pr} is open on branch ${result.branch} and has not merged (${outcome.reason}). ${to} sees the note once it merges.` }
  }
  return { ...result, status: "merged", commit: outcome.commit, message: `Left for ${to}: merged in ${result.pr}. ${to}'s session start lists it until they acknowledge it with note_ack. Everyone in the workspace can read it.` }
}

/**
 * note_ack
 *
 * Input: { note }: the path session start listed (`desks/<you>/_inbox/<file>.md`) or the file name. Only a note in the
 * session person's own inbox. Marks it acknowledged, with the time, and commits it when the file held no uncommitted
 * changes; the file stays.
 *
 * Returns { status: "acknowledged" | "unchanged", note, from, subject, committed, message, commit? }: `commit` is
 * `{ status: "failed", reason }` when the commit failed. The sender sees the acknowledgement once the desk syncs.
 */
export async function note_ack({ deskRoot, input, person = null, spawnGit = spawnSync, schedulePush = schedulePushDefault, search, now = () => new Date() }) {
  const at = localIso(now())
  workspaceOf(deskRoot, "note_ack")
  const alias = personOf(person, "note_ack")
  const own = `desks/${alias}/${INBOX}`
  const { note } = input
  if (typeof note !== "string" || note.trim() === "") throw new Error("note_ack: `note` is required: the path session start listed, or the note's file name")
  const value = note.trim().replace(/\\/gu, "/")
  const name = value.includes("/") ? (path.posix.dirname(value) === own ? path.posix.basename(value) : "") : value
  if (!/^[^/.][^/]*\.md$/u.test(name)) throw new Error(`note_ack: you can acknowledge only a note in your own inbox, ${own}/: pass the path session start listed`)
  const rel = `${own}/${name}`
  const file = await resolveWriteTarget({ deskRoot, person: alias, segments: [INBOX, name], createPersonRoot: false })
  let text
  try {
    text = await fs.readFile(file, "utf8")
  } catch {
    throw new Error(`note_ack: there is no note ${rel}`)
  }
  const parsed = parseNote(text)
  const next = acknowledgeNote(text, at)
  const dir = path.dirname(file)
  const isGit = isGitRepository(dir, spawnGit)
  if (next === null) {
    if (parsed?.status !== "acknowledged") throw new Error(`note_ack: ${rel} is not a note (no open or acknowledged status in its frontmatter)`)
    return { status: "unchanged", note: rel, from: parsed.from, subject: parsed.subject, committed: isGit && !hasUnstagedWork(dir, [name], spawnGit), message: `${rel} is already acknowledged.` }
  }
  // Checked before this call's own write, so a change someone else left in the file is never committed as this call's.
  const stage = isGit && !hasUnstagedWork(dir, [name], spawnGit)
  await fs.writeFile(file, next, "utf8")
  search?.noteChange(rel)
  const commit = stage ? stageAndCommitFiles(dir, [name], `note_ack: ${name}`, spawnGit) : undefined
  const committed = stage && commit === undefined
  if (committed) schedulePush({ root: deskRoot })
  const result = { status: "acknowledged", note: rel, from: parsed.from, subject: parsed.subject, committed }
  if (commit !== undefined) result.commit = commit
  const why = !isGit ? "this desk is not a Git checkout" : commit === undefined ? "the note already held uncommitted changes, so Desk left it for you to commit" : `the commit failed: ${commit.reason}`
  result.message = committed
    ? `Acknowledged ${rel} from ${parsed.from}. It is committed, and ${parsed.from} sees it once your desk syncs.`
    : `Acknowledged ${rel} from ${parsed.from} on this machine, but not committed (${why}), so ${parsed.from} does not see it yet.`
  return result
}
