// The one commit path for desk card files: the friction log's staging and commit helpers (moved here unchanged in
// behaviour) and `writeCardCommitted`, which every improvement card write in the package goes through, whether the
// caller is an MCP tool or a detached loop worker with no server and no readiness object.
//
// `spawnGit` (over `spawnSync`) and `schedulePush` are test seams; real callers never pass them.

import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { isGitRepository, hasUnstagedWork, stagePaths, commitPaths } from "../util/git-stage.js"
import { schedulePush as schedulePushDefault } from "../runtime/sync-worker.js"

const GIT_TIMEOUT_MS = 10_000
const CARD_FOLDER = "improvement"
const VERB = /^[a-z][a-z_]{0,23}$/u

/** What `writeCardCommitted` reports as `commit`: one stable code, never text from Git. */
export const COMMIT_CODES = Object.freeze(["committed", "no_files", "unsafe_path", "not_git", "no_change", "stage_failed", "commit_failed"])

/**
 * On a Git desk, a friction file is staged only when it held no unstaged changes before the write, so a dirty or
 * untracked file left by another session is never adopted as this call's own work — mirrors track.js/task.js.
 */
export function stagingAllowed(filePath, spawnGit) {
  const dir = path.dirname(filePath)
  return isGitRepository(dir, spawnGit) && !hasUnstagedWork(dir, [path.basename(filePath)], spawnGit)
}

/**
 * Stages and commits exactly the one file. A stage failure leaves nothing to commit, and neither it nor a commit
 * failure ever throws away the write: it comes back as the return value, which the caller attaches to its result
 * under `commit` only on failure. Undefined on success.
 */
export function stageAndCommitFile(filePath, message, spawnGit) {
  const dir = path.dirname(filePath)
  const basename = path.basename(filePath)
  const staged = stagePaths(dir, [basename], spawnGit)
  if (!staged.ok) return { status: "failed", reason: staged.stderr }
  const committed = commitPaths(dir, [basename], message, spawnGit)
  return committed.ok ? undefined : { status: "failed", reason: committed.stderr }
}

/** The fixed commit message for a card: `improvement: <verb> <card file name>`; never any title text. `verb` is a short lowercase word. */
export function cardCommitMessage(verb, fileName) {
  if (typeof verb !== "string" || !VERB.test(verb)) throw new TypeError("invalid_verb")
  return `improvement: ${verb} ${path.basename(String(fileName))}`
}

const posix = (rel) => rel.split(path.sep).join("/")
const CARD_NAME = /^[a-z_]+--[0-9a-f]{12}\.md$/u
const SET_ASIDE_NAME = /^[^/]+\.[0-9a-f]{6}$/u

function git(spawnGit, root, args) {
  return spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS })
}

// The files under `folder` that hold unstaged or staged changes or are untracked; null when Git cannot say.
function dirtyUnder(spawnGit, root, folder) {
  const found = []
  for (const args of [["diff", "--name-only", "-z", "--relative", "--", folder], ["diff", "--cached", "--name-only", "-z", "--relative", "--", folder], ["ls-files", "--others", "--exclude-standard", "-z", "--", folder]]) {
    const run = git(spawnGit, root, args)
    if (run.status !== 0) return null
    for (const name of run.stdout.split("\0")) if (name !== "" && !found.includes(name)) found.push(name)
  }
  return found
}

// A card file directly in the folder, a moved-aside file directly in its `invalid/` folder, or a path the write just reported (a moved-aside file's old name can be anything): the card library's own output.
function isCardOutput(folder, rel, reported) {
  if (reported.includes(rel)) return true
  const inside = rel.slice(folder.length + 1)
  if (rel.split("/").some((segment) => segment.startsWith(".improvement"))) return false
  if (inside.startsWith("invalid/")) return SET_ASIDE_NAME.test(inside.slice("invalid/".length))
  return CARD_NAME.test(inside)
}

// Everything the write reported, as paths relative to the desk root, or null when any is not an ordinary card path.
function reportedPaths(deskRoot, folder, result) {
  const files = typeof result.file === "string" ? [result.file] : []
  const moved = Array.isArray(result.set_aside_files) ? result.set_aside_files : []
  const rels = []
  for (const file of [...files, ...moved]) {
    const rel = typeof file === "string" && path.isAbsolute(file) ? path.relative(deskRoot, file) : null
    if (rel === null || rel === "" || !posix(rel).startsWith(`${folder}/`)) return null
    if (rel.split(path.sep).some((segment) => segment.startsWith(".improvement"))) return null
    rels.push(posix(rel))
  }
  return rels
}

/**
 * Runs `write` (an async function that calls one improvement-card library writer and returns its result), then commits
 * what the card folder holds uncommitted: the card the write reported, the `set_aside_files` moves, and any card file
 * or set-aside file an earlier write left uncommitted (the folder is written only by the card library, so those are the
 * loop's own earlier writes and heal here without a person). The commit uses `message` (a string, or a function of the
 * returned `result`, so a message can name the card file) and the push is scheduled.
 *
 * Input: { deskRoot (absolute), personPrefix ("" or "desks/<alias>"), write, message, spawnGit?, schedulePush? }.
 * Returns { result, commit, left_alone }: `result` is the writer's result without `file` and `set_aside_files` (it has
 * `file_name` instead, and `set_aside` stays as a count); `commit` is one of COMMIT_CODES; `left_alone` counts files in
 * the card folder that are neither a card file nor a set-aside file (never staged, never touched). No absolute path is
 * ever returned, and no text from Git.
 *
 * Only paths inside `<personPrefix>/_meta/improvement/` are staged, by exact path (never `-a`), and never a name that
 * starts with `.improvement` (the lock and temp files): a reported path outside the folder or relative gives
 * `unsafe_path` and nothing is staged. A desk that is not a Git repository gives `not_git`: the card file stays on
 * disk, uncommitted, and no push is scheduled. A Git failure gives `stage_failed` or `commit_failed` and never loses the
 * card; the next write commits it.
 */
export async function writeCardCommitted({ deskRoot, personPrefix = "", write, message, spawnGit = spawnSync, schedulePush = schedulePushDefault }) {
  const folder = posix(path.join(personPrefix, "_meta", CARD_FOLDER))
  const written = await write()
  const { file, set_aside_files: moved, ...rest } = written
  const result = typeof file === "string" ? { ...rest, file_name: path.basename(file) } : rest
  const reported = path.isAbsolute(deskRoot) ? reportedPaths(deskRoot, folder, written) : null
  if (reported === null) return { result, commit: "unsafe_path", left_alone: 0 }
  if (!isGitRepository(deskRoot, spawnGit)) return { result, commit: reported.length === 0 ? "no_files" : "not_git", left_alone: 0 }
  const dirty = dirtyUnder(spawnGit, deskRoot, folder)
  if (dirty === null) return { result, commit: "stage_failed", left_alone: 0 }
  const stage = dirty.filter((rel) => isCardOutput(folder, rel, reported))
  const leftAlone = dirty.length - stage.length
  if (stage.length === 0) return { result, commit: reported.length === 0 ? "no_files" : "no_change", left_alone: leftAlone }
  if (!stagePaths(deskRoot, stage, spawnGit).ok) return { result, commit: "stage_failed", left_alone: leftAlone }
  if (!commitPaths(deskRoot, stage, typeof message === "function" ? message(result) : message, spawnGit).ok) return { result, commit: "commit_failed", left_alone: leftAlone }
  schedulePush({ root: deskRoot })
  return { result, commit: "committed", left_alone: leftAlone }
}
