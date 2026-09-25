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
// `deskCommitsBetween(startIso, endIso)` lists the desk's non-merge commits
// on local and remote-tracking branches whose committer or author time falls
// in the window (Git keeps whole seconds). Author time is kept through a
// rebase, which re-stamps the committer time when a session pulls before it
// pushes. Each is `{ sha, committed_at, authored_at, taskPaths }`, where
// `taskPaths` are the desk-relative paths the commit changed (renames as a
// delete and an add); `bindSession` decides which of them are task folders.
// `gitCommitTaskPaths(sha)` answers the same for one commit, with `exists:
// false` for a SHA not in the desk. `readDeskRemote` returns `origin`'s URL,
// or `null`.
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

function isoFromSeconds(seconds) {
  return new Date(Number(seconds) * 1000).toISOString()
}

// `git log -z --name-only --format=%x1e<header>`: records split by 0x1e, a
// NUL after the header, then a newline and NUL-separated paths.
function parseLog(output) {
  const commits = []
  for (const record of output.split("\x1e")) {
    const headerEnd = record.indexOf("\0")
    if (headerEnd === -1) continue
    const [sha, committed, authored] = record.slice(0, headerEnd).split("\x1f")
    const taskPaths = record.slice(headerEnd + 1).replace(/^\n/u, "").split("\0").filter((entry) => entry !== "")
    commits.push({ sha, committed: Number(committed), authored: Number(authored), taskPaths })
  }
  return commits
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

  function deskCommitsBetween(startIso, endIso) {
    if (!isWindow(startIso, endIso)) return []
    const output = runGit(options, [
      "log", "--branches", "--remotes", "--no-merges", "--no-renames", `--since=${startIso}`,
      "--format=%x1e%H%x1f%ct%x1f%at", "--name-only", "-z",
    ])
    if (output === null) return []
    const start = Date.parse(startIso)
    const end = Date.parse(endIso)
    const within = (seconds) => seconds * 1000 >= start && seconds * 1000 <= end
    return parseLog(output)
      .filter((commit) => within(commit.committed) || within(commit.authored))
      .map((commit) => ({
        sha: commit.sha,
        committed_at: isoFromSeconds(commit.committed),
        authored_at: isoFromSeconds(commit.authored),
        taskPaths: commit.taskPaths,
      }))
  }

  function gitCommitTaskPaths(sha) {
    const missing = { exists: false, taskPaths: [] }
    if (typeof sha !== "string" || !PATTERNS.commitSha.test(sha)) return missing
    if (runGit(options, ["cat-file", "-e", `${sha}^{commit}`]) === null) return missing
    const output = runGit(options, ["diff-tree", "--root", "--no-commit-id", "--no-renames", "-r", "-z", "--name-only", sha])
    return { exists: true, taskPaths: (output ?? "").split("\0").filter((entry) => entry !== "") }
  }

  return { readTask, deskCommitsBetween, gitCommitTaskPaths }
}

/** `readDeskRemote({ deskRoot, git })`: the desk's `origin` URL, or `null`. */
export function readDeskRemote({ deskRoot, git = "git", timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const output = runGit({ git, deskRoot, timeoutMs }, ["config", "--get", "remote.origin.url"])
  const remote = output === null ? "" : output.trim()
  return remote === "" ? null : remote
}
