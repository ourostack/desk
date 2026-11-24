// Runs the released Desk's `drains.js` with the arguments given. `drains.js` installs a copy of this file at
// `<state>/ouroboros-skills/desk/drains/run.mjs`, the one stable path a wake runner needs, so nothing depends on a Desk checkout or
// on Agency. Each start asks GitHub for the head of ourostack/desk's `release` branch (one cheap `git ls-remote`) and, when it moved,
// fetches it into this file's own shallow, sparse Git cache in `desk-release/` next to it. Runners use immutable plugin copies in
// `releases/<commit>/`, never the checkout another runner may be updating. If GitHub cannot be reached the last published copy runs;
// with no copy yet, the newest `plugins/desk@release` entry in
// Agency's plugin cache (`~/.local/agency/plugins/cache/cache_index.json`) or the last path that worked runs. One line is logged
// to stderr and to resolve.log whenever the fetch or the cache resolution fails, as `<time> <code>: <sentence>` with the code
// `fetch-failed` or `release-unresolved`; with nothing to run it then exits 1.
// This file must stay standalone: the installed copy has no neighbours to import.
import { spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const RELEASE_URL = "https://github.com/ourostack/desk.git"
const PROBE_MS = 20_000
const FETCH_MS = 180_000
const RELEASE = /:github:ourostack\/desk:plugins\/desk@release$/u
const COMMIT = /^[0-9a-f]{40}$/u

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
  const checkedOut = gitOut(git, ["-C", own, "rev-parse", "HEAD"], PROBE_MS)
  if (!COMMIT.test(checkedOut)) throw new Error("the fetched release has no valid commit")
  return checkedOut
}

const FRESH_MS = 60_000
const LOCK_OWNER = /^owner-([1-9][0-9]*)-[0-9a-f-]{36}$/u

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

function snapshot(dir, release) {
  const root = path.join(dir, "releases", release)
  return { release, root, script: path.join(root, "plugins", "desk", "mcp", "scripts", "drains.js") }
}

function currentCopy(dir) {
  try {
    const release = readFileSync(path.join(dir, "last-fetch"), "utf8").trim()
    if (!COMMIT.test(release)) return null
    const copy = snapshot(dir, release)
    return existsSync(copy.root) ? copy : null
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

/** Called under the fetch lock. Readers never run from the Git checkout, including during checkout's unlink/write gap. */
function publishCopy(dir, own, release) {
  const copy = snapshot(dir, release)
  if (!existsSync(copy.root)) {
    const staging = `${copy.root}.${process.pid}.tmp`
    try {
      mkdirSync(path.dirname(copy.root), { recursive: true })
      cpSync(path.join(own, "plugins", "desk"), path.join(staging, "plugins", "desk"), { recursive: true })
      renameSync(staging, copy.root)
    } finally {
      rmSync(staging, { recursive: true, force: true })
    }
  }
  const stamp = path.join(dir, "last-fetch")
  const pending = `${stamp}.${process.pid}.tmp`
  try {
    writeFileSync(pending, release)
    renameSync(pending, stamp)
  } finally {
    rmSync(pending, { force: true })
  }
  return copy
}

/** Publish current before checking leases: any reader that saw an older pointer registered itself before this scan. */
function pruneCopies(dir, current, runner) {
  let busy = false
  for (const name of readdirSync(path.join(dir, "runners"))) {
    if (name === runner) continue
    if (!/^[1-9][0-9]*-[0-9a-f-]{36}$/u.test(name)) {
      busy = true
      continue
    }
    const pid = Number(name.split("-")[0])
    if (alive(pid)) busy = true
    else rmSync(path.join(dir, "runners", name), { force: true })
  }
  if (busy) return
  for (const name of readdirSync(path.join(dir, "releases"))) {
    if (COMMIT.test(name) && name !== current) rmSync(path.join(dir, "releases", name), { recursive: true, force: true })
  }
}

function lockPid(lock) {
  try {
    return Number(readFileSync(path.join(lock, "pid"), "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return NaN
    throw error
  }
}

function clearLockOwner(lock, marker, pid) {
  if (marker) rmSync(path.join(lock, marker), { force: true })
  if (lockPid(lock) === pid) rmSync(path.join(lock, "pid"), { force: true })
  try {
    // Never rename or recursively remove this shared name: an earlier stale observation may now refer to a new owner.
    rmdirSync(lock)
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw error
  }
}

/** Reclaim only uniquely named dead owners. A replacement's marker prevents removal of its directory. */
function takeLock(lock, now) {
  for (let attempt = 0; attempt < 2; attempt++) {
    let created = false
    try {
      mkdirSync(path.dirname(lock), { recursive: true })
      mkdirSync(lock)
      created = true
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    if (created) {
      const marker = `owner-${process.pid}-${randomUUID()}`
      try {
        writeFileSync(path.join(lock, marker), "")
        // A reaper may have removed the still-empty directory between mkdir and this write.
        if (readdirSync(lock).some((name) => name !== marker)) {
          rmSync(path.join(lock, marker), { force: true })
          return null
        }
        writeFileSync(path.join(lock, "pid"), String(process.pid))
        return () => clearLockOwner(lock, marker, process.pid)
      } catch (error) {
        rmSync(path.join(lock, marker), { force: true })
        if (error.code === "ENOENT") return null
        throw error
      }
    }
    try {
      const names = readdirSync(lock)
      const owner = lockPid(lock)
      const age = Math.abs(now() - statSync(lock).mtimeMs)
      const markers = names.filter((name) => LOCK_OWNER.test(name))
      if (names.some((name) => name !== "pid" && !LOCK_OWNER.test(name))) return null
      if (markers.some((name) => alive(Number(LOCK_OWNER.exec(name)[1])))) return null
      if (Number.isInteger(owner) && owner > 0 ? alive(owner) : !markers.length && age < 5000) return null
      for (const marker of markers) rmSync(path.join(lock, marker), { force: true })
      clearLockOwner(lock, null, owner)
    } catch (error) {
      if (error.code !== "ENOENT") throw error
    }
  }
  return null
}

/** Single-flight fetch: a recent publication or a busy fetch uses the last complete snapshot without reading the Git checkout. */
function fetchOnce({ dir, own, url, git, now, runner }) {
  const stamp = path.join(dir, "last-fetch")
  const fresh = () => {
    try {
      const age = now() - statSync(stamp).mtimeMs
      return age >= 0 && age < FRESH_MS && currentCopy(dir) !== null
    } catch {
      return false
    }
  }
  if (fresh()) return currentCopy(dir)
  const release = takeLock(path.join(dir, "fetch.lock"), now)
  if (!release) return currentCopy(dir)
  try {
    if (fresh()) return currentCopy(dir)
    let remote
    let fetchError
    try {
      remote = fetchRelease({ own, url, git })
    } catch (error) {
      const current = currentCopy(dir)
      if (current) return { ...current, fetchError: error.message }
      remote = headOf(own, git)
      if (!remote) throw error
      fetchError = error.message
    }
    const copy = publishCopy(dir, own, remote)
    pruneCopies(dir, remote, runner)
    return { ...copy, fetchError }
  } finally {
    release()
  }
}

/** Resolves the script, pins its snapshot until the child exits, and passes its commit as DESK_DRAINS_RELEASE. */
export function launch({ argv, env = process.env, home = homedir(), spawn = spawnSync, git = runGit, stderr = process.stderr, execPath = process.execPath, now = () => new Date() }) {
  const dir = stateDir(env, home)
  const runner = `${process.pid}-${randomUUID()}`
  const leases = path.join(dir, "runners")
  mkdirSync(leases, { recursive: true })
  writeFileSync(path.join(leases, runner), "")
  try {
    return launchWithLease({ argv, env, home, spawn, git, stderr, execPath, now, dir, runner })
  } finally {
    rmSync(path.join(leases, runner), { force: true })
  }
}

function launchWithLease({ argv, env, home, spawn, git, stderr, execPath, now, dir, runner }) {
  const cache = env.AGENCY_PLUGIN_CACHE ?? path.join(home, ".local", "agency", "plugins", "cache")
  const lastGood = path.join(dir, "last-good-script")
  const own = path.join(dir, "desk-release")
  const complain = (code, text) => {
    const line = `${now().toISOString()} ${code}: ${text}`
    stderr.write(`${line}\n`)
    mkdirSync(dir, { recursive: true })
    appendFileSync(path.join(dir, "resolve.log"), `${line}\n`)
  }
  let copy = null
  let fetchError = null
  try {
    copy = fetchOnce({ dir, own, url: env.DESK_DRAINS_RELEASE_URL ?? RELEASE_URL, git, now, runner })
    fetchError = copy?.fetchError
  } catch (error) {
    fetchError = error.message
    copy = currentCopy(dir)
  }
  let release = copy?.release
  let script
  if (copy && existsSync(copy.script)) {
    script = copy.script
    if (fetchError) complain("fetch-failed", `could not fetch the released Desk (${fetchError}); using the copy from ${release.slice(0, 8)}`)
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
      complain("release-unresolved", `could not resolve the released Desk (${fetchError ? `${fetchError}; ` : ""}${error.message}); ${script ? `using the last good path ${script}` : "no last good path"}`)
      if (!script || !existsSync(script)) return 1
    }
  }
  return spawn(execPath, [script, ...argv], { stdio: "inherit", windowsHide: true, env: { ...process.env, ...(release ? { DESK_DRAINS_RELEASE: release } : {}) } }).status ?? 1
}

/* istanbul ignore next -- the entry line: tests call launch() directly and run the installed copy as a program. */
if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) process.exitCode = launch({ argv: process.argv.slice(2) })
