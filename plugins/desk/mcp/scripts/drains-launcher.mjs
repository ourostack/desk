// Runs the released Desk's `drains.js` with the arguments given. `drains.js` installs a copy of this file at
// `<state>/ouroboros-skills/desk/drains/run.mjs`, the one stable path a wake runner needs, so nothing depends on a Desk checkout or
// on Agency. Each start asks GitHub for the head of ourostack/desk's `release` branch (one cheap `git ls-remote`) and, when it moved,
// fetches it into this file's own shallow, sparse clone in `desk-release/` next to it, so a Desk release reaches the drains within a
// cycle. If GitHub cannot be reached the clone already there runs; with no clone yet, the newest `plugins/desk@release` entry in
// Agency's plugin cache (`~/.local/agency/plugins/cache/cache_index.json`) or the last path that worked runs. One line is logged
// to stderr and to resolve.log whenever the fetch or the cache resolution fails.
// This file must stay standalone: the installed copy has no neighbours to import.
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const RELEASE_URL = "https://github.com/ourostack/desk.git"
const PROBE_MS = 20_000
const FETCH_MS = 180_000
const RELEASE = /:github:ourostack\/desk:plugins\/desk@release$/u

function stateDir(env, home) {
  const configured = typeof env.XDG_STATE_HOME === "string" ? env.XDG_STATE_HOME.trim() : ""
  const stateHome = path.isAbsolute(configured) ? configured : path.join(home, ".local", "state")
  return path.join(stateHome, "ouroboros-skills", "desk", "drains")
}

function released(cache) {
  const entries = Object.values(JSON.parse(readFileSync(path.join(cache, "cache_index.json"), "utf8")).entries ?? {})
  const found = entries
    .filter((entry) => typeof entry.spec === "string" && RELEASE.test(entry.spec))
    .sort((a, b) => (b.fetched_at ?? 0) - (a.fetched_at ?? 0))
    .map((entry) => path.join(cache, "entries", entry.dir_name, "mcp", "scripts", "drains.js"))
    .find((script) => existsSync(script))
  if (!found) throw new Error("no released Desk entry with scripts/drains.js in the cache index")
  return found
}

/** Helper directories (`<prefix>/libexec/git-core`) of the gits on PATH, for a git that was relocated without GIT_EXEC_PATH. */
function execPaths(env, exists) {
  const dirs = String(env.PATH ?? env.Path ?? "").split(path.delimiter).filter(Boolean)
  return dirs.map((dir) => path.join(dir, "..", "libexec", "git-core")).filter((dir) => exists(path.join(dir, "git-remote-http")))
}

/**
 * Runs git. Some gits (the GitHub Copilot app's cached one) find their helpers only through GIT_EXEC_PATH, which the app sets and a
 * background caller may lack; others fail when an inherited GIT_EXEC_PATH names a git that is gone. Either way `git ls-remote` fails on
 * every run with "'remote-https' is not a git command", so that one failure is retried with each helper directory found next to a git on
 * PATH, then with the variable removed. A git that works as it is runs once.
 */
export const makeGit = (spawn = spawnSync, env = process.env, exists = existsSync) => (args, timeout) => {
  const attempt = (e) => spawn("git", args, { encoding: "utf8", timeout, windowsHide: true, env: { ...e, GIT_TERMINAL_PROMPT: "0" } })
  let result = attempt(env)
  if (!/is not a git command/u.test(String(result.stderr ?? ""))) return result
  const { GIT_EXEC_PATH: _stale, ...own } = env
  for (const e of [...execPaths(env, exists).map((GIT_EXEC_PATH) => ({ ...own, GIT_EXEC_PATH })), own]) {
    result = attempt(e)
    if (!/is not a git command/u.test(String(result.stderr ?? ""))) break
  }
  return result
}

const runGit = makeGit()

function gitOut(git, args, timeout) {
  const result = git(args, timeout)
  if (result.status !== 0) throw new Error(String(result.stderr ?? "").trim().split("\n")[0] || result.error?.message || "git failed")
  return String(result.stdout).trim()
}

/** The commit the own clone is at, or null when there is none or it is broken. */
function headOf(own, git) {
  try {
    return existsSync(path.join(own, ".git")) ? gitOut(git, ["-C", own, "rev-parse", "HEAD"], PROBE_MS) : null
  } catch {
    return null
  }
}

/** Brings the own clone to the head of the release branch and returns that commit. Nothing is fetched when it is already there. */
function fetchRelease({ own, url, git }) {
  const remote = gitOut(git, ["ls-remote", url, "refs/heads/release"], PROBE_MS).split(/\s/u)[0]
  if (!/^[0-9a-f]{40}$/u.test(remote)) throw new Error("the release branch was not found")
  const have = headOf(own, git)
  if (have === remote) return remote
  if (have) {
    gitOut(git, ["-C", own, "fetch", "--depth", "1", "origin", "release"], FETCH_MS)
    gitOut(git, ["-C", own, "checkout", "--quiet", "--force", "FETCH_HEAD"], FETCH_MS)
  } else {
    rmSync(own, { recursive: true, force: true })
    mkdirSync(path.dirname(own), { recursive: true })
    gitOut(git, ["clone", "--quiet", "--depth", "1", "--branch", "release", "--sparse", "--no-tags", url, own], FETCH_MS)
    gitOut(git, ["-C", own, "sparse-checkout", "set", "plugins/desk"], FETCH_MS)
  }
  return remote
}

const FRESH_MS = 60_000
const STALE_LOCK_MS = 10 * 60_000

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

/** Takes the fetch lock (an atomic mkdir holding the owner's pid) and returns a release function, or null when another live runner holds it. A lock whose owner is gone, or that is older than any fetch can last, is cleared. */
function takeLock(lock, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      mkdirSync(path.dirname(lock), { recursive: true })
      mkdirSync(lock)
      writeFileSync(path.join(lock, "pid"), String(process.pid))
      return () => rmSync(lock, { recursive: true, force: true })
    } catch (error) {
      if (error.code !== "EEXIST") return null
    }
    let age = Infinity
    let owner = NaN
    try {
      age = Math.abs(now() - statSync(lock).mtimeMs)
      owner = Number(readFileSync(path.join(lock, "pid"), "utf8"))
    } catch {}
    // An owner that has not written its pid yet is only a few milliseconds old, so it is not cleared.
    if (age < STALE_LOCK_MS && (Number.isInteger(owner) && owner > 0 ? alive(owner) : age < 5000)) return null
    rmSync(lock, { recursive: true, force: true })
  }
  return null
}

/** Single-flight fetch: skipped when the last success is under a minute old or another runner is fetching, in which case the current copy is used. */
function fetchOnce({ dir, own, url, git, now }) {
  const stamp = path.join(dir, "last-fetch")
  const fresh = () => {
    try {
      const age = now() - statSync(stamp).mtimeMs
      return age >= 0 && age < FRESH_MS && headOf(own, git) !== null
    } catch {
      return false
    }
  }
  if (fresh()) return headOf(own, git)
  const release = takeLock(path.join(dir, "fetch.lock"), now)
  if (!release) return headOf(own, git)
  try {
    if (fresh()) return headOf(own, git)
    const remote = fetchRelease({ own, url, git })
    writeFileSync(stamp, remote)
    return remote
  } finally {
    release()
  }
}

/** Resolves the script, runs it and returns its exit status. The commit it runs from, when it is the own clone, goes to it as DESK_DRAINS_RELEASE. */
export function launch({ argv, env = process.env, home = homedir(), spawn = spawnSync, git = runGit, stderr = process.stderr, execPath = process.execPath, now = () => new Date() }) {
  const dir = stateDir(env, home)
  const cache = env.AGENCY_PLUGIN_CACHE ?? path.join(home, ".local", "agency", "plugins", "cache")
  const lastGood = path.join(dir, "last-good-script")
  const own = path.join(dir, "desk-release")
  const ownScript = path.join(own, "plugins", "desk", "mcp", "scripts", "drains.js")
  const complain = (text) => {
    const line = `${now().toISOString()} ${text}`
    stderr.write(`${line}\n`)
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, "resolve.log"), `${line}\n`)
  }
  let release = null
  let fetchError = null
  try {
    release = fetchOnce({ dir, own, url: env.DESK_DRAINS_RELEASE_URL ?? RELEASE_URL, git, now })
  } catch (error) {
    fetchError = error.message
    release = headOf(own, git)
  }
  let script
  if (release && existsSync(ownScript)) {
    script = ownScript
    if (fetchError) complain(`could not fetch the released Desk (${fetchError}); using the copy from ${release.slice(0, 8)}`)
  } else {
    release = null
    try {
      script = released(cache)
      if (!existsSync(lastGood) || readFileSync(lastGood, "utf8").trim() !== script) {
        mkdirSync(dir, { recursive: true })
        writeFileSync(lastGood, `${script}\n`)
      }
    } catch (error) {
      script = existsSync(lastGood) ? readFileSync(lastGood, "utf8").trim() : null
      complain(`could not resolve the released Desk (${fetchError ? `${fetchError}; ` : ""}${error.message}); ${script ? `using the last good path ${script}` : "no last good path"}`)
      if (!script || !existsSync(script)) return 1
    }
  }
  return spawn(execPath, [script, ...argv], { stdio: "inherit", windowsHide: true, env: { ...process.env, ...(release ? { DESK_DRAINS_RELEASE: release } : {}) } }).status ?? 1
}

/* istanbul ignore next -- the entry line: tests call launch() directly and run the installed copy as a program. */
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = launch({ argv: process.argv.slice(2) })
