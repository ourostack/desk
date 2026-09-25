// The real readers `bindSession` is given: a task card's frontmatter and the
// desk's Git history. Both are read-only.
//
// `readTask(track, slug)` reads `<deskRoot>/[<personPrefix>/]<track>/<slug>/
// task.md`, else `<track>/_archive/<slug>/task.md`, and returns `{ status,
// created_at, updated_at }` from its frontmatter (the YAML between the first
// two `---` lines, searched in the first 40 lines only), or `null` when
// neither card exists. Only top-level `key: value` lines are read, quotes and
// a trailing ` # comment` stripped. A status outside `ENUMS.jobStatus`, or a
// time `normalizeTimestamp` refuses (a bare date, say), is `null`, never a
// guess; an unreadable card gives all three `null`.
//
// `deskCommitsBetween(startIso, endIso)` lists the commits this clone made
// in the window: the reflog entries of `HEAD` and every local branch whose
// subject starts `commit:`, `commit (initial):`, `commit (amend):` or
// `commit (merge):` (so a desk's first commit can bind too), and
// whose reflog time (when this clone made the commit, to the second) falls
// in the window. Git is asked with both `--since` and `--until`. Fetched,
// pulled, rebased, checked-out and `git merge` entries are not commits this
// clone made, so another clone's or machine's commit never appears, and a
// commit later rebased keeps its original entry, SHA and time. Each is `{
// sha, committed_at, taskPaths }`, `committed_at` being the reflog time and
// `taskPaths` the desk-relative paths the commit changed (renames as a
// delete and an add; for a merge, only the files that differ from every
// parent, which is what the merge's author resolved). The reflog subject
// holds the commit message; it is matched in memory and never returned.
// `bindSession` decides which paths are task folders. `gitCommitTaskPaths(
// sha)` lists one commit's paths, with `exists: false` for a SHA not in the
// desk. `readDeskRemote` returns `origin`'s URL, or `null`.
//
// The desk must be a repository of its own: Git's top level for the desk
// root must be the desk root's real path (checked as an empty
// `rev-parse --show-prefix`). Otherwise (a desk inside a
// dotfiles repository at `$HOME`, say) Git would walk up and read another
// repository's history and remote, so the commit readers find nothing and
// `readDeskRemote` returns `null`.
//
// Git runs with `GIT_*` variables removed (a hook's `GIT_DIR` must not point
// it elsewhere), no prompts, and a timeout. Any failure reads as "nothing
// found", never a throw.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { spawnSync } from "node:child_process"
import { closeSync, openSync, readSync } from "node:fs"
import * as path from "node:path"

import { checkPersonPrefix, isTaskSegment } from "./binding.js"
import { ENUMS, PATTERNS } from "./schema.js"
import { normalizeTimestamp } from "./time.js"

const FRONTMATTER_LINES = 40
const READ_BYTES = 16 * 1024
const DEFAULT_TIMEOUT_MS = 20_000

function gitEnv() {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = "0"
  env.LC_ALL = "C"
  return env
}

function runGit({ git, deskRoot, timeoutMs }, args) {
  const result = spawnSync(git, ["-C", deskRoot, "-c", "core.quotePath=false", "-c", "log.showSignature=false", ...args], {
    encoding: "utf8",
    env: gitEnv(),
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  })
  return result.status === 0 ? result.stdout : null
}

// ---------------------------------------------------------------------------
// Task cards.
// ---------------------------------------------------------------------------

function readHead(file) {
  let descriptor
  try {
    descriptor = openSync(file, "r")
  } catch (error) {
    return error.code === "ENOENT" || error.code === "ENOTDIR" ? null : ""
  }
  try {
    const buffer = Buffer.alloc(READ_BYTES)
    const length = readSync(descriptor, buffer, 0, READ_BYTES, 0)
    return buffer.toString("utf8", 0, length)
  } catch {
    return ""
  } finally {
    closeSync(descriptor)
  }
}

function unquote(raw) {
  const value = raw.trim()
  const quoted = /^(["'])(.*)\1$/u.exec(value)
  if (quoted) return quoted[2]
  return value.replace(/\s+#.*$/u, "").trim()
}

function frontmatterOf(text) {
  const lines = text.split(/\r?\n/u).slice(0, FRONTMATTER_LINES)
  const fields = {}
  if (lines[0] !== "---") return fields
  const end = lines.indexOf("---", 1)
  if (end === -1) return fields
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/u.exec(line)
    if (match && !Object.hasOwn(fields, match[1])) fields[match[1]] = unquote(match[2])
  }
  return fields
}

function cardFields(text) {
  const fields = frontmatterOf(text)
  return {
    status: ENUMS.jobStatus.includes(fields.status) ? fields.status : null,
    created_at: normalizeTimestamp(fields.created),
    updated_at: normalizeTimestamp(fields.updated),
  }
}

// ---------------------------------------------------------------------------
// Git history.
// ---------------------------------------------------------------------------

const COMMIT_ENTRY = /^commit(?: \((?:initial|amend|merge)\))?: /u
const REFLOG_TIME = /@\{([^}]+)\}$/u

// `git log -g -z --name-only --format=%x1e<header>`: records split by 0x1e,
// a NUL after the header, then a newline (a NUL for a merge) and
// NUL-separated paths. The header is `sha 0x1f ref@{time} 0x1f subject`.
function parseReflog(output) {
  const entries = []
  for (const record of output.split("\x1e")) {
    const headerEnd = record.indexOf("\0")
    if (headerEnd === -1) continue
    const [sha, selector, subject] = record.slice(0, headerEnd).split("\x1f")
    const time = REFLOG_TIME.exec(selector)
    const at = time === null ? null : normalizeTimestamp(time[1])
    if (at === null || !COMMIT_ENTRY.test(subject)) continue
    const taskPaths = record.slice(headerEnd + 1).split("\0").map((entry) => entry.replace(/^\n/u, "")).filter((entry) => entry !== "")
    entries.push({ sha, committed_at: at, taskPaths })
  }
  return entries
}

// True when Git's top level for `deskRoot` is the desk root itself. Git's
// `--show-prefix` is the desk root's path below its top level, so it is
// empty exactly when the top level is the desk root's real path (it
// resolves symlinks, and letter case on a case-insensitive disk, as Git
// does).
function isOwnRepository(options) {
  const prefix = runGit(options, ["rev-parse", "--show-prefix"])
  return prefix !== null && prefix.trim() === ""
}

function isWindow(startIso, endIso) {
  return typeof startIso === "string" && typeof endIso === "string" && PATTERNS.timestamp.test(startIso) && PATTERNS.timestamp.test(endIso) && startIso <= endIso
}

/**
 * `createDeskReaders({ deskRoot, personPrefix, git, timeoutMs })` ->
 * `{ readTask, deskCommitsBetween, gitCommitTaskPaths }` for `bindSession`.
 */
export function createDeskReaders({ deskRoot, personPrefix = "", git = "git", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (typeof deskRoot !== "string" || !path.isAbsolute(deskRoot)) throw new TypeError("createDeskReaders: deskRoot must be an absolute path")
  checkPersonPrefix(personPrefix, "createDeskReaders")
  const base = path.join(deskRoot, personPrefix)
  const options = { git, deskRoot, timeoutMs }

  function readTask(track, slug) {
    if (!isTaskSegment(track) || !isTaskSegment(slug)) return null
    for (const folder of [path.join(base, track, slug), path.join(base, track, "_archive", slug)]) {
      const text = readHead(path.join(folder, "task.md"))
      if (text !== null) return cardFields(text)
    }
    return null
  }

  let ownRepository
  const deskIsOwnRepository = () => {
    if (ownRepository === undefined) ownRepository = isOwnRepository(options)
    return ownRepository
  }

  function deskCommitsBetween(startIso, endIso) {
    if (!isWindow(startIso, endIso) || !deskIsOwnRepository()) return []
    const branches = runGit(options, ["for-each-ref", "--format=%(refname)", "refs/heads"])
    if (branches === null) return []
    const output = runGit(options, [
      "log", "--walk-reflogs", "--date=iso-strict", `--since=${startIso}`, `--until=${endIso}`,
      "--no-renames", "--cc", "--name-only", "-z", "--format=%x1e%H%x1f%gd%x1f%gs",
      "HEAD", ...branches.split("\n").filter((ref) => ref.startsWith("refs/heads/")),
    ])
    if (output === null) return []
    // Git bounds the entries by reflog time; binding matches each to a call.
    // HEAD's reflog and the branch's both record one commit: keep it once.
    const seen = new Map()
    for (const entry of parseReflog(output)) {
      const key = `${entry.sha}@${entry.committed_at}`
      if (!seen.has(key)) seen.set(key, entry)
    }
    return [...seen.values()]
  }

  function gitCommitTaskPaths(sha) {
    const missing = { exists: false, taskPaths: [] }
    if (typeof sha !== "string" || !PATTERNS.commitSha.test(sha) || !deskIsOwnRepository()) return missing
    if (runGit(options, ["cat-file", "-e", `${sha}^{commit}`]) === null) return missing
    const output = runGit(options, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "-z", "--name-only", sha])
    return { exists: true, taskPaths: (output ?? "").split("\0").filter((entry) => entry !== "") }
  }

  return { readTask, deskCommitsBetween, gitCommitTaskPaths }
}

/** `readDeskRemote({ deskRoot, git })`: the desk's `origin` URL, or `null`. */
export function readDeskRemote({ deskRoot, git = "git", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const options = { git, deskRoot, timeoutMs }
  if (!isOwnRepository(options)) return null
  const output = runGit(options, ["config", "--get", "remote.origin.url"])
  const remote = output === null ? "" : output.trim()
  return remote === "" ? null : remote
}
