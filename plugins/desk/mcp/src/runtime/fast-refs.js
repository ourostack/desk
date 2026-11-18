// Reads a checkout's branch, upstream and the commits both point at straight from `.git`, without starting Git. Each Git
// process costs tens of milliseconds on a quiet machine and seconds when the machine is loaded, so the pull path asks Git
// only what it cannot read from a file. Anything unusual (a detached HEAD, a branch with no upstream, an unreadable file)
// answers null and the caller asks Git instead.

import { readFileSync, statSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

const SHA = /^[0-9a-f]{40,64}$/u

function readText(file) {
  try {
    return readFileSync(file, "utf8")
  } catch {
    return ""
  }
}

// The directory holding this checkout's HEAD, and the one holding refs and config (the same unless this is a linked worktree).
function gitDirs(root) {
  const dot = path.join(root, ".git")
  const stats = statSync(dot, { throwIfNoEntry: false })
  if (stats === undefined) return null
  if (stats.isDirectory()) return { gitDir: dot, commonDir: dot }
  const pointer = /^gitdir:\s*(.+?)\s*$/mu.exec(readText(dot))
  if (pointer === null) return null
  const gitDir = path.resolve(root, pointer[1])
  const common = readText(path.join(gitDir, "commondir")).trim()
  return { gitDir, commonDir: common ? path.resolve(gitDir, common) : gitDir }
}

function branchSettings(config, branch) {
  const header = `[branch "${branch}"]`
  const settings = {}
  let inside = false
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.startsWith("[")) inside = line.toLowerCase() === header.toLowerCase()
    else if (inside) {
      const match = /^(remote|merge)\s*=\s*(.+)$/iu.exec(line)
      if (match !== null) settings[match[1].toLowerCase()] = match[2].trim()
    }
  }
  return settings
}

function refValue(commonDir, ref) {
  const loose = readText(path.join(commonDir, ref)).trim()
  if (SHA.test(loose)) return loose
  for (const line of (readText(path.join(commonDir, "packed-refs"))).split(/\r?\n/u)) {
    const [sha, name] = line.split(" ")
    if (name === ref && SHA.test(sha)) return sha
  }
  return null
}

/**
 * `{ branch, remote, merge, tracking, head, target }` for the checked-out branch and the remote-tracking ref it follows, or
 * null when this is not a plain branch with a plain upstream Git can be left out of.
 */
export function readUpstreamRefs(root) {
  const dirs = gitDirs(root)
  if (dirs === null) return null
  const branch = /^ref: refs\/heads\/(.+?)\s*$/u.exec(readText(path.join(dirs.gitDir, "HEAD")))?.[1]
  const config = readText(path.join(dirs.commonDir, "config"))
  if (branch === undefined || config === "") return null
  const { remote, merge } = branchSettings(config, branch)
  if (remote === undefined || remote === "." || merge === undefined || !merge.startsWith("refs/heads/")) return null
  const tracking = `refs/remotes/${remote}/${merge.slice("refs/heads/".length)}`
  const head = refValue(dirs.commonDir, `refs/heads/${branch}`)
  const target = refValue(dirs.commonDir, tracking)
  return head === null || target === null ? null : { branch, remote, merge, tracking, head, target }
}

// A checkout Git can be left out of: a plain `.git` folder in `root` (so `root` is the top of the work tree), the files
// backend for refs, and no environment variable that points Git somewhere else.
function plainCheckout(root) {
  if (process.env.GIT_DIR || process.env.GIT_COMMON_DIR || process.env.GIT_WORK_TREE) return null
  const dirs = gitDirs(root)
  if (dirs === null) return null
  if (statSync(path.join(dirs.commonDir, "reftable"), { throwIfNoEntry: false }) !== undefined) return null
  return dirs
}

const answer = (stdout) => ({ status: 0, signal: null, error: undefined, stdout: `${stdout}\n`, stderr: "" })
const same = (args, ...wanted) => args.length === wanted.length && args.every((arg, i) => arg === wanted[i])

// A git-path that always lives in the shared git folder or in the checkout's own one, as Git itself decides.
const SHARED_PATHS = /^(?:config|packed-refs|objects|refs|hooks|info|lfs|modules)(?:\/|$)/u

function gitPath(dirs, name) {
  return path.join(SHARED_PATHS.test(name) ? dirs.commonDir : dirs.gitDir, name)
}

function sectionValue(config, header, name) {
  let inside = false
  let value
  for (const raw of config.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line.startsWith("[")) inside = line === header
    else if (inside) {
      const match = /^([A-Za-z]+)\s*=\s*(.*)$/u.exec(line)
      if (match !== null && match[1].toLowerCase() === name) value = match[2].trim()
    }
  }
  return value === "" ? undefined : value
}

/**
 * What `git -C root <args>` would print, for the few read-only questions the save and pull paths ask over and over, read
 * from `.git` files instead of a process. A `spawnSync`-shaped answer, or null when Git must be asked (any other command, a
 * detached HEAD, a ref or setting the files do not plainly hold, a folder below the top of its work tree).
 */
// A config file's text with every file it includes (whatever the include's condition) appended; null past a few levels.
function withIncludes(file, depth = 0) {
  const text = readText(file)
  if (!/^\s*\[\s*include/imu.test(text)) return text
  if (depth > 3) return null
  const home = process.env.HOME || os.homedir()
  const parts = [text]
  for (const [, target] of text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gimu)) {
    const inner = withIncludes(path.resolve(path.dirname(file), target.replace(/^~(?=\/)/u, home)), depth + 1)
    if (inner === null) return null
    parts.push(inner)
  }
  return parts.join("\n")
}

// Every config file and environment setting Git reads outside the repository, as one text; null when it cannot all be read.
function outerConfig() {
  const home = process.env.HOME || os.homedir()
  const files = [process.env.GIT_CONFIG_GLOBAL, home && path.join(home, ".gitconfig"), process.env.XDG_CONFIG_HOME ? path.join(process.env.XDG_CONFIG_HOME, "git", "config") : home && path.join(home, ".config", "git", "config"), process.env.GIT_CONFIG_SYSTEM ?? "/etc/gitconfig"]
  const env = Object.entries(process.env).filter(([key]) => key.startsWith("GIT_CONFIG_") && !["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CONFIG_COUNT"].includes(key)).map(([, value]) => value)
  const texts = files.filter(Boolean).map((file) => withIncludes(file))
  return texts.includes(null) ? null : [...texts, ...env].join("\n")
}

/** True when no configuration anywhere (this repository's, the user's, the machine's, the environment's) mentions `key`. */
function configSilentOn(dirs, key) {
  const outer = outerConfig()
  const local = withIncludes(path.join(dirs.commonDir, "config"))
  if (outer === null || local === null) return false
  return !new RegExp(key, "iu").test(`${outer}\n${local}\n${readText(path.join(dirs.gitDir, "config.worktree"))}`)
}

/** What `git stripspace` writes for `text`: trailing blanks cut, runs of empty lines made one, the edges trimmed. */
export function stripspace(text) {
  const out = []
  for (const raw of text.split("\n")) {
    const line = raw.replace(/[ \t\r\f\v]+$/u, "")
    if (line === "" && (out.length === 0 || out[out.length - 1] === "")) continue
    out.push(line)
  }
  while (out.length > 0 && out[out.length - 1] === "") out.pop()
  return out.length === 0 ? "" : `${out.join("\n")}\n`
}

export function fastGitAnswer(root, args, input) {
  try {
    const dirs = plainCheckout(root)
    if (dirs === null) return null
    const head = readText(path.join(dirs.gitDir, "HEAD"))
    const branch = /^ref: refs\/heads\/(.+?)\s*$/u.exec(head)?.[1]
    if (same(args, "symbolic-ref", "--short", "-q", "HEAD") || same(args, "symbolic-ref", "--quiet", "--short", "HEAD")) return branch === undefined ? null : answer(branch)
    if (same(args, "rev-parse", "--verify", "-q", "HEAD") || same(args, "rev-parse", "HEAD")) {
      const sha = branch === undefined ? null : refValue(dirs.commonDir, `refs/heads/${branch}`)
      return sha === null ? null : answer(sha)
    }
    if (same(args, "rev-parse", "--verify", "HEAD^{commit}")) {
      const sha = branch === undefined ? null : refValue(dirs.commonDir, `refs/heads/${branch}`)
      return sha === null ? null : answer(sha)
    }
    if (same(args, "stripspace") && typeof input === "string") return { ...answer(""), stdout: stripspace(input) }
    if (same(args, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")) {
      const target = /^ref: refs\/remotes\/(origin\/.+?)\s*$/u.exec(readText(path.join(dirs.commonDir, "refs/remotes/origin/HEAD")))?.[1]
      return target === undefined ? null : answer(target)
    }
    if (same(args, "config", "--type=bool", "--get", "commit.gpgSign")) return configSilentOn(dirs, "gpgsign") ? { ...answer(""), status: 1, stdout: "" } : null
    if (args[0] === "hook" && args[1] === "run" && args[2] === "--ignore-missing" && /^[a-z-]+$/u.test(args[3] ?? "")) {
      const present = statSync(path.join(dirs.commonDir, "hooks", args[3]), { throwIfNoEntry: false }) !== undefined
      return present || !configSilentOn(dirs, "hookspath") ? null : { ...answer(""), stdout: "", skipped: true }
    }
    if (same(args, "rev-parse", "--is-inside-work-tree")) return answer("true")
    if (same(args, "rev-parse", "--show-toplevel")) return answer(root.replaceAll("\\", "/"))
    if (same(args, "rev-parse", "--show-prefix")) return { ...answer(""), stdout: "\n" }
    if (args[0] === "rev-parse" && args[1] === "--git-path" && args.length === 3) return answer(gitPath(dirs, args[2]))
    if (args[0] === "rev-parse" && args[1] === "--path-format=absolute" && args.length > 2 && args.slice(2).every((arg, i) => i % 2 === 0 ? arg === "--git-path" : !arg.startsWith("-")))
      return answer(args.slice(2).filter((_, i) => i % 2 === 1).map((name) => gitPath(dirs, name)).join("\n"))
    if (same(args, "symbolic-ref", "refs/remotes/origin/HEAD")) {
      const target = /^ref: (refs\/remotes\/origin\/.+?)\s*$/u.exec(readText(path.join(dirs.commonDir, "refs/remotes/origin/HEAD")))?.[1]
      return target === undefined ? null : answer(target)
    }
    const key = args.length === 3 && args[0] === "config" && args[1] === "--get" ? /^(remote|branch)\.([A-Za-z0-9_-]+)\.(url|pushurl|remote)$/u.exec(args[2]) : null
    if (key !== null) {
      const config = readText(path.join(dirs.commonDir, "config"))
      if (/^\s*\[\s*(?:include|url)/imu.test(config)) return null
      const value = sectionValue(config, `[${key[1]} "${key[2]}"]`, key[3])
      return value === undefined || value.includes('"') || value.includes("\\") ? null : answer(value)
    }
  } catch {
    // Anything unexpected is Git's to answer.
  }
  return null
}
