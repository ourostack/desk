// Issue drains: the deterministic poll behind `scripts/drains.js`. It lists each configured repository's open issues with no model
// turn and records which ones are new or changed since the last poll. It never wakes anyone: it returns the wakes, and whatever
// runs it (a launchd job, an always-on agent runtime) delivers them and reports back with `ack`. See docs/issue-drains.md.
//
// `updated_at` alone is not a revision: the drain's own label edits and status comment move it too. An issue is news only when
// something other than the drain changed it since the revision last recorded for that issue.
import { createHash, randomUUID } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as os from "node:os"
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"
import { activeLogin, ledgeredFetch, SpendHeld } from "./spend-ledger.js"

/** A drain's own status comment carries this marker, so its creation and edits do not wake the drain again. */
export const DRAIN_STATUS_MARKER = "<!-- ouro-drain-status -->"
/** The drain moves an issue through labels in this namespace (`drain: triaged`, `drain: in progress`); changing them is not news. */
const DRAIN_LABEL_PREFIX = "drain:"
const CROSS_REFERENCE_SLACK_MS = 120_000
const CLAIM_SLACK_MS = 60_000
const HISTORY = 200
/** The drain's turn: from a wake's delivery (a minute of lead, for a drain that acts before the delivery is acknowledged) to this long after. A label or state change by the polling account inside it is the drain's own work. */
const TURN_LEAD_MS = 60_000
const TURN_MS = 90 * 60_000
const TURNS_KEPT = 50
/** A closed issue's record is kept this long, so one that comes back unchanged is not mistaken for a new issue. */
const GONE_MS = 30 * 24 * 3_600_000
const MAX_TITLES = 20
const PAGE = 100
const EDIT_FIELDS = "totalCount pageInfo { hasNextPage hasPreviousPage startCursor endCursor } nodes { id editedAt deletedAt editor { __typename login } }"
const EDITS_FORWARD = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) { rateLimit { cost } repository(owner: $owner, name: $name) { issue(number: $number) { updatedAt userContentEdits(first: 100, after: $cursor) { ${EDIT_FIELDS} } } } }`
const EDITS_BACKWARD = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) { rateLimit { cost } repository(owner: $owner, name: $name) { issue(number: $number) { updatedAt userContentEdits(last: 100, before: $cursor) { ${EDIT_FIELDS} } } } }`
/** A full listing of the open issues is read again this often; between them only issues updated since the last change are read. */
const FULL_SYNC_MS = 3_600_000
/** The list is read from a little before the newest change it knew, so an update GitHub lists late is still seen. */
const DELTA_SLACK_MS = 120_000
// A poll a little early still counts as due, so a launcher that fires every minute reaches an `everySeconds` of 180 on its third run.
const POLL_SLACK_MS = 10_000
const LOGIN_MS = 24 * 3_600_000
/** At or below this many calls left in the window a drain stops polling until the window resets. */
const QUOTA_RESERVE = 25
/** Below 10% of the window or this many calls (whichever is more), a drain polls at most every `QUOTA_SLOW_MS`. */
const QUOTA_LOW = 200
const QUOTA_SLOW_MS = 15 * 60_000

/** What the app says when a wake's session is archived, has lost its workspace folder or no longer exists: waiting never fixes it, so the drain gets a successor. */
const SESSION_GONE = /archived|workspace folder\b[^.]{0,20}\bmissing|no such (?:session|workspace)|(?:session|workspace)\b[^.]{0,40}(?:not found|does not exist|no longer exists)/iu
/** A failed attempt to start a successor is tried again after this long. */
const RECOVER_RETRY_MS = 10 * 60_000
const SHEPHERD_MS = 90_000
/** `gh auth token` reads the keyring, which can be slow or busy under load: three tries, each given this long, with a pause between. */
const TOKEN_TRIES = 3
const TOKEN_MS = 20_000
const TOKEN_PAUSE_MS = 2_000
const NO_TOKEN = /no oauth token|not logged in|no accounts? |not signed in/iu

const blank = () => ({ seeded: false, seen: {}, pending: [] })

/** The session a drain's wakes go to: the successor started for it when its configured session was archived or gone, else the configured one. A new configured session retires the successor. */
const sessionOf = (drain, state) => (state?.successor && state.successor.from === drain.session ? state.successor.to : drain.session)

/** Where the drain config, state and lock live: Desk's state folder (`$XDG_STATE_HOME`, else `~/.local/state`). */
export function drainsHome({ env = process.env, homeDir = os.homedir() } = {}) {
  const configured = typeof env.XDG_STATE_HOME === "string" ? env.XDG_STATE_HOME.trim() : ""
  const stateHome = path.isAbsolute(configured) ? configured : path.join(homeDir, ".local", "state")
  return path.join(stateHome, "ouroboros-skills", "desk", "drains")
}

export function drainPaths(options = {}) {
  const home = drainsHome(options)
  return { config: path.join(home, "config.json"), state: path.join(home, "state.json"), lock: path.join(home, "poll.lock") }
}

const LAUNCHER_SOURCE = fileURLToPath(new URL("../../scripts/drains-launcher.mjs", import.meta.url))

/**
 * Keeps `run.mjs` in Desk's drains folder identical to the launcher this Desk ships, the one stable path a wake runner needs.
 * Every command refreshes it, so a new machine gets it from its first `drains.js status` and a Desk update replaces it.
 */
export function installLauncher({ env = process.env, homeDir = os.homedir(), source = LAUNCHER_SOURCE } = {}) {
  const target = path.join(drainsHome({ env, homeDir }), "run.mjs")
  const wanted = readFileSync(source)
  const sha256 = createHash("sha256").update(wanted).digest("hex")
  let current = ""
  try {
    current = createHash("sha256").update(readFileSync(target)).digest("hex")
  } catch {
    // Not installed yet.
  }
  if (current !== sha256) {
    assertNotRealStateUnderTest(path.dirname(target), { env })
    mkdirSync(path.dirname(target), { recursive: true })
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, wanted)
    renameSync(temporary, target)
  }
  return { path: target, sha256, changed: current !== sha256 }
}

/** Why wakes were made for one issue: its recorded events, newest first, the marker the poll keeps for it and whether a wake is still waiting. */
export function whyOf(states, repo, number) {
  const state = states[repo]
  const wakes = (state?.history ?? []).filter((event) => event.number === number).reverse().slice(0, 10)
  return {
    repo,
    number,
    wakes,
    waiting: Boolean(state?.pending.some((event) => event.number === number)),
    seen: state?.seen[String(number)] ?? null,
    ...(wakes.length ? {} : { note: `no wake is recorded for ${repo}#${number}; each drain keeps its last ${HISTORY} events` }),
  }
}

/**
 * The Desk a `drains.js` command runs from: its version (the plugin.json two folders above the script), the release commit the
 * launcher fetched it at (`DESK_DRAINS_RELEASE`, set only for the launcher's own copy) and the script, as one status line.
 */
export function deskInUse({ script, env = process.env }) {
  let version = "unknown"
  try {
    version = JSON.parse(readFileSync(path.join(path.dirname(script), "..", "..", "plugin.json"), "utf8")).version ?? version
  } catch {
    // A script run outside a plugin folder has no version to show.
  }
  const release = env.DESK_DRAINS_RELEASE || null
  return { version, release, script, line: `desk ${version} (${release ? `ourostack/desk@release ${release.slice(0, 8)}, the launcher's own copy` : script})` }
}

function problem(code, thing, probably, look, fix) {
  return new Error(deskFailure({ code, thing, probably, look, keepWorking: "no seen marker moved and no wake was lost", fix }))
}

// ── Config ──

const isText = (value) => typeof value === "string" && value.trim() !== ""
const textList = (value) => Array.isArray(value) && value.every(isText)

function checkIgnoreComments(rules, where, bad) {
  if (!Array.isArray(rules)) throw bad(`${where} is not a list of {"author", "match"} rules`)
  rules.forEach((rule, i) => {
    if (rule === null || typeof rule !== "object" || !isText(rule.author)) throw bad(`${where}[${i}].author is not a comment author's login such as "some-bot[bot]"`)
    if (rule.match === undefined) return
    if (!isText(rule.match)) throw bad(`${where}[${i}].match is not a regular expression`)
    try {
      new RegExp(rule.match, "u")
    } catch {
      throw bad(`${where}[${i}].match is not a valid regular expression`)
    }
  })
}

function checkIgnoreLabels(patterns, where, bad) {
  if (!textList(patterns)) throw bad(`${where} is not a list of regular expressions for label names such as "^waiting:"`)
  patterns.forEach((pattern, i) => {
    try {
      new RegExp(pattern, "iu")
    } catch {
      throw bad(`${where}[${i}] is not a valid regular expression`)
    }
  })
}

/** The drains in a config file's text, validated. A bad entry is an error, not a silent drop: a dropped drain would stop watching its repository. */
export function parseDrainConfig(raw, file) {
  const bad = (what) => problem("desk_drains_config_invalid", "drains config", `${file} ${what}, probably a hand edit`, "open the file and compare it with docs/issue-drains.md", "correct the entry and run the command again")
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw bad("is not valid JSON")
  }
  const list = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed.drains : undefined
  if (!Array.isArray(list)) throw bad('has no "drains" array')
  const seen = new Set()
  return list.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw bad(`drains[${index}] is not an object`)
    const { repo, session, account, ignoredBodyTrailers, ignoredLabels, ignoreLabels, ignoreComments, everySeconds } = entry
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw bad(`drains[${index}].repo is not "owner/name"`)
    if (!isText(session)) throw bad(`drains[${index}].session is not a session id`)
    if (account !== undefined && !isText(account)) throw bad(`drains[${index}].account is not a GitHub login`)
    if (ignoredBodyTrailers !== undefined && (!textList(ignoredBodyTrailers) || ignoredBodyTrailers.some((key) => key.includes(":")))) throw bad(`drains[${index}].ignoredBodyTrailers is not a list of trailer keys such as "Active-at"`)
    if (ignoredLabels !== undefined && !textList(ignoredLabels)) throw bad(`drains[${index}].ignoredLabels is not a list of label names such as "agent:drain"`)
    if (everySeconds !== undefined && (!Number.isInteger(everySeconds) || everySeconds < 60)) throw bad(`drains[${index}].everySeconds is not a whole number of seconds, 60 or more`)
    if (ignoreLabels !== undefined) checkIgnoreLabels(ignoreLabels, `drains[${index}].ignoreLabels`, bad)
    if (ignoreComments !== undefined) checkIgnoreComments(ignoreComments, `drains[${index}].ignoreComments`, bad)
    if (seen.has(repo)) throw bad(`drains[${index}].repo ${repo} is listed twice`)
    seen.add(repo)
    return {
      repo,
      session: session.trim(),
      ...(account === undefined ? {} : { account: account.trim() }),
      ...(ignoredBodyTrailers === undefined ? {} : { ignoredBodyTrailers: ignoredBodyTrailers.map((key) => key.trim()) }),
      ...(ignoredLabels === undefined ? {} : { ignoredLabels: ignoredLabels.map((name) => name.trim()) }),
      ...(everySeconds === undefined ? {} : { everySeconds }),
      ...(ignoreLabels === undefined ? {} : { ignoreLabels: ignoreLabels.map((pattern) => pattern.trim()) }),
      ...(ignoreComments === undefined ? {} : { ignoreComments: ignoreComments.map(({ author, match }) => ({ author: author.trim(), ...(match === undefined ? {} : { match }) })) }),
    }
  })
}

export function readDrainConfig(file) {
  let raw
  try {
    raw = readFileSync(file, "utf8")
  } catch (error) {
    if (error.code !== "ENOENT") throw problem("desk_drains_config_unreadable", "drains config", `${file} cannot be read (${error.code}), probably because its owner or permissions changed`, "check the file's permissions", "fix them and run the command again")
    return []
  }
  return parseDrainConfig(raw, file)
}

// ── State ──

const seenIssue = (entry) => (typeof entry === "string" ? { updatedAt: entry } : entry)

export function readDrainStates(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"))
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeDrainStates(file, states) {
  assertNotRealStateUnderTest(path.dirname(file))
  mkdirSync(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  writeFileSync(temporary, `${JSON.stringify(states, null, 2)}\n`)
  renameSync(temporary, file)
}

const OWNER_FILE = /^owner-[0-9a-f-]{36}$/u
const busy = (lockFile, who) => problem("desk_drains_busy", "drains lock", `${who} holds ${lockFile} and is still working`, `check that process; it releases the lock itself when it finishes, and a lock whose process has died is taken over by the next run`, "run the command again once it finishes")
const lockProblem = (code, lockFile, probably, look, fix) => problem(code, "drains lock", probably, look, fix)
const unavailable = (lockFile, error) => lockProblem("desk_drains_lock_unavailable", lockFile, `${lockFile} cannot be created or read because of ${error.code ?? error.message}`, `the permissions and free space of ${path.dirname(lockFile)}, and the error code ${error.code ?? "unknown"}`, "fix that, then run the command again")

/**
 * Takes the lock, or throws. The lock is a directory that is published whole: a sibling `<lock>.new-<pid>-<token>` is filled with
 * the one file `owner-<token>` (this process's id) and then renamed onto the lock, which succeeds only where the lock is absent or
 * an empty directory. So the lock is never visible empty or half-written, and a live owner is never taken from, however long it
 * works. A dead owner is retired by removing its own `owner-<token>` file, a name no later owner reuses, so a contender holding a
 * stale view finds nothing to remove (ENOENT) instead of a newer owner's lock; the empty directory is then removed with `rmdir`,
 * which refuses a directory that has become someone's. Nothing is aged out, renamed away or removed recursively. An earlier Desk's
 * lock is a plain file: it is never replaced, because replacing it by name cannot be made safe against that Desk's own takeover.
 * `onStep` is a test seam called at "staging" (the sibling exists, the owner file is not written), "staged" and "inspected".
 */
export function acquireDrainLock(lockFile, { alive = processAlive, onStep = () => {}, rename = publishDirectory } = {}) {
  const dir = path.dirname(lockFile)
  const base = path.basename(lockFile)
  sweepStaging(dir, base, alive)
  for (let attempt = 0; attempt < 3; attempt++) {
    const token = randomUUID()
    const staging = path.join(dir, `${base}.new-${process.pid}-${token}`)
    const owner = path.join(staging, `owner-${token}`)
    let renamed = false
    try {
      try {
        mkdirSync(staging)
        onStep("staging")
        writeFileSync(owner, `${process.pid}\n`)
        onStep("staged")
      } catch (error) {
        throw unavailable(lockFile, error)
      }
      try {
        rename(staging, lockFile)
        renamed = true
      } catch (error) {
        // Platforms name an occupied target differently (POSIX ENOTEMPTY, ENOTDIR, EEXIST; Windows EPERM), so the error code is not
        // trusted: the target itself is inspected next. Only a rename that failed with nothing in the way is a failure to use the lock.
        // A move that was cut short (Windows, a timeout) may still have happened. It is ours only if the lock is a directory holding this
        // acquisition's own `owner-<token>` (a name nothing else uses); any other target, live or legacy, is left alone.
        if (!existsAt(staging) && holdsOwner(lockFile, `owner-${token}`)) renamed = true
        else if (!existsAt(lockFile)) throw unavailable(lockFile, error)
      }
    } finally {
      if (!renamed) removeStaging(staging)
    }
    if (renamed) return () => releaseDrainLock(lockFile, `owner-${token}`)
    retireDeadOwner(lockFile, alive, onStep)
  }
  throw busy(lockFile, "another poll, which started while this one looked,")
}

/** The one step that must never replace what is at the lock: POSIX `rename` refuses all but an absent or empty directory, but Windows' replaces a plain file. */
function publishDirectory(from, to) {
  // Only Windows runs the first branch; the native Windows suite (desk-windows-suite.yml) exercises it, a Linux or macOS run cannot.
  /* istanbul ignore if */
  if (process.platform === "win32") moveWithoutReplace(from, to, { shells: ["pwsh", "powershell"] })
  else renameSync(from, to)
}

// Fixed script, paths as data (environment), never interpolated. Directory.Move ends in MoveFileExW without MOVEFILE_REPLACE_EXISTING
// (dotnet/runtime, Interop.MoveFileEx.cs and FileSystem.Windows.cs: MoveFile(..., overwrite: false)), so an existing target is refused
// by the system, not by a check made first. Windows PowerShell 5.1 runs .NET Framework, whose Directory.InternalMove makes no existence
// check either: it validates paths and the shared root, then calls Win32Native.MoveFile, i.e. MoveFileEx(src, dst, 2 /* MOVEFILE_COPY_ALLOWED */)
// or MoveFileW, neither of which replaces (microsoft/referencesource@ec9fa9ae770d, mscorlib/system/io/directory.cs InternalMove and
// mscorlib/microsoft/win32/win32native.cs MoveFile). The native per-shell target tests are evidence, not a proof of every interleaving. Exit 3 means "refused", with the outer exception, and its inner one if any, named on stderr.
const MOVE_SCRIPT = "try { [System.IO.Directory]::Move($env:DESK_MOVE_FROM, $env:DESK_MOVE_TO) } catch { $e = $_.Exception; $i = $e.InnerException; [Console]::Error.Write('refused ' + $e.GetType().Name + ' ' + $e.HResult + $(if ($i) { ' inner ' + $i.GetType().Name + ' ' + $i.HResult } else { ' no-inner' })); exit 3 }"

/**
 * Moves a directory to a path that must not exist, failing (and changing nothing) if anything is there. The next shell is tried only
 * when the first cannot be launched at all; a move that ran, was refused or timed out is never retried and never falls back to `rename`.
 */
export function moveWithoutReplace(from, to, { shells, timeoutMs = TOKEN_MS }) {
  for (const shell of shells) {
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-Command", MOVE_SCRIPT], { env: { ...process.env, DESK_MOVE_FROM: from, DESK_MOVE_TO: to }, encoding: "utf8", timeout: timeoutMs, windowsHide: true })
    if (result.error?.code === "ENOENT") continue
    if (result.error) throw Object.assign(new Error(`${shell}: ${result.error.message}`), { code: result.error.code })
    if (result.status === 0) return
    throw Object.assign(new Error(`Run the command again once what is at the lock is dealt with: ${shell} did not move it (exit ${result.status}): ${String(result.stderr).trim() || "no message"}`), { code: "desk_move_refused" })
  }
  throw Object.assign(new Error(`Install PowerShell (pwsh) or put powershell on PATH: none of ${shells.join(", ")} could be started`), { code: "desk_move_no_shell" })
}

function holdsOwner(lockFile, ownerName) {
  try {
    return lstatSync(lockFile).isDirectory() && lstatSync(path.join(lockFile, ownerName)).isFile()
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false
    throw unavailable(lockFile, error)
  }
}

function existsAt(target) {
  try {
    lstatSync(target)
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw unavailable(target, error)
  }
}

function legacyLock(lockFile) {
  let pid = "an unknown process"
  try {
    pid = `process ${Number.parseInt(readFileSync(lockFile, "utf8"), 10)}`
  } catch {
    // A file that cannot be read is named by its path alone.
  }
  return lockProblem("desk_drains_lock_legacy", lockFile, `${lockFile} is a file, the lock of an earlier Desk, and Desk cannot tell whether a poll still holds it (it names ${pid})`, `whether ${pid}, or any drains poll or ack started by an earlier Desk, is still running`, `once none is, remove ${lockFile} yourself and run the command again; Desk never replaces it, because that could take the lock from a poll that is still working`)
}

function removeStaging(staging) {
  try {
    for (const name of readdirSync(staging)) if (OWNER_FILE.test(name)) unlinkSync(path.join(staging, name))
    rmdirSync(staging)
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY"].includes(error.code)) throw unavailable(staging, error)
  }
}

/** A staging directory is never shared, so one whose creating process has died is a crash leftover and is removed by its exact name. */
function sweepStaging(dir, base, alive) {
  let names
  try {
    names = readdirSync(dir)
  } catch (error) {
    if (error.code === "ENOENT") return
    throw unavailable(path.join(dir, base), error)
  }
  for (const name of names) {
    const match = name.startsWith(`${base}.new-`) ? /^(\d+)-[0-9a-f-]{36}$/u.exec(name.slice(base.length + 5)) : null
    if (match && !alive(Number(match[1]))) removeStaging(path.join(dir, name))
  }
}

function retireDeadOwner(lockFile, alive, onStep) {
  let names = null
  try {
    if (lstatSync(lockFile).isDirectory()) names = readdirSync(lockFile)
  } catch (error) {
    // A lock that vanished since the publish failed belongs to someone who just released it: the next attempt publishes.
    /* istanbul ignore if -- a race with another process's release */
    if (error.code === "ENOENT") return
    throw unavailable(lockFile, error)
  }
  if (names === null) throw legacyLock(lockFile)
  if (names.length === 0) return removeEmptyLock(lockFile)
  if (names.length !== 1 || !OWNER_FILE.test(names[0])) {
    throw lockProblem("desk_drains_lock_unrecognized", lockFile, `${lockFile} holds ${names.slice(0, 5).join(", ")}, which is not one owner file of this Desk's lock`, `${lockFile}, and whether another tool or a newer Desk made it`, "leave it, or ask its owner; Desk removes nothing it did not make")
  }
  let pid
  try {
    pid = Number.parseInt(readFileSync(path.join(lockFile, names[0]), "utf8"), 10)
  } catch (error) {
    /* istanbul ignore if -- a race with another process's release */
    if (error.code === "ENOENT") return
    throw unavailable(lockFile, error)
  }
  if (!Number.isInteger(pid) || pid <= 0) {
    throw lockProblem("desk_drains_lock_unrecognized", lockFile, `${path.join(lockFile, names[0])} does not name a process`, `${lockFile}, and whether another tool or a newer Desk made it`, "leave it, or ask its owner; Desk removes nothing it did not make")
  }
  if (alive(pid)) throw busy(lockFile, `process ${pid}`)
  onStep("inspected")
  try {
    unlinkSync(path.join(lockFile, names[0]))
  } catch (error) {
    if (error.code !== "ENOENT") throw unavailable(lockFile, error)
  }
  removeEmptyLock(lockFile)
}

/** `rmdir` fails on a directory that has an owner, so it cannot remove a lock published after it was looked at. */
function removeEmptyLock(lockFile) {
  try {
    rmdirSync(lockFile)
  } catch (error) {
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(error.code)) throw unavailable(lockFile, error)
  }
}

/** Removes only this run's own owner file, so a lock that has since passed to another owner is left alone. */
function releaseDrainLock(lockFile, ownerName) {
  try {
    unlinkSync(path.join(lockFile, ownerName))
  } catch (error) {
    if (error.code !== "ENOENT") throw unavailable(lockFile, error)
  }
  removeEmptyLock(lockFile)
}

/** Runs `work`, which may be async, while this process holds the lock (see acquireDrainLock). Only this run's owner file is removed afterwards. */
export async function withDrainLock(lockFile, work, { alive = processAlive, onStep } = {}) {
  assertNotRealStateUnderTest(path.dirname(lockFile))
  mkdirSync(path.dirname(lockFile), { recursive: true })
  const release = acquireDrainLock(lockFile, { alive, onStep })
  try {
    return await work()
  } finally {
    release()
  }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code === "EPERM"
  }
}

// ── Polling ──

const oneLine = (text) => {
  const flat = text.replace(/\s+/gu, " ").trim()
  return flat.length > 120 ? `${flat.slice(0, 119)}…` : flat
}

/** What every wake for a repository starts with: a runner uses it to take older undelivered wakes back before it sends a newer one. */
const wakePrefix = (repo) => `New or changed issues in ${repo}:`

export function wakeMessage(repo, events) {
  const shown = events.slice(0, MAX_TITLES).map((event) => `#${event.number} ${oneLine(event.title)}${event.why ? ` (${event.why})` : ""}`)
  const more = events.length > MAX_TITLES ? `, and ${events.length - MAX_TITLES} more` : ""
  return `${wakePrefix(repo)} ${shown.join(", ")}${more}. Drain them.`
}

/** Identifies one batch of waiting events, so an `ack` for an older batch never clears a newer one. */
export const wakeId = (repo, events) => createHash("sha1").update(JSON.stringify([repo, events])).digest("hex").slice(0, 16)

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/** The body without its ignored trailer lines (`Active-at: …`), so an edit that touches only those lines leaves the digest alone. */
function bodyWithoutTrailers(body, keys) {
  if (keys.length === 0) return body
  const trailer = new RegExp(`^[ \\t]*(?:${keys.map(escapeRegExp).join("|")})[ \\t]*:.*(?:\\r?\\n|$)`, "gimu")
  return body.replace(trailer, "").trimEnd()
}

const digestOf = (issue, keys) => createHash("sha1").update(`${issue.title}\n${bodyWithoutTrailers(issue.body ?? "", keys)}`).digest("hex").slice(0, 16)

/** The drain's own status comment: the marker, written by the polling account. Its creation and every edit are skipped. */
const ownStatus = (comment, login) => comment.user?.login?.toLowerCase() === login.toLowerCase() && Boolean(comment.body?.includes(DRAIN_STATUS_MARKER))

/** A comment a drain's `ignoreComments` rule skips: written by the rule's author (case-insensitive) and, when the rule has a `match`, a body that matches it. */
const ignoredComment = (comment, rules) => rules.some((rule) => comment.user?.login?.toLowerCase() === rule.author && (rule.match === null || rule.match.test(comment.body ?? "")))

const isBot = (item) => item.user?.type === "Bot" || (item.user?.login ?? "").toLowerCase().endsWith("[bot]")
const isBotActor = (actor) => actor?.type === "Bot" || (actor?.login ?? "").toLowerCase().endsWith("[bot]")

// ── Who edited an issue's body ──
//
// An issue whose body changed is news unless every edit made since it was last recorded was a bot's. The proof reads the issue's
// edit history one GraphQL page at a time, and the progress is kept in `state.scans[number]`, so a history of any length is read
// across polls and quota windows without starting over. No order of the history is assumed. What is counted instead:
//   - `base`: how many edits were already judged when the issue was last recorded (null when that is not known: the first pass
//     then counts the edits older than `floor` as it reads forward, and knows `base` once it reaches the end);
//   - an edit is new when it is not older than `floor` and is not one of the `tail` ids already judged at that second;
//   - `total` is read from every page, so the new edits still to find are `total - base`, wherever they sit and however many more
//     arrive while the scan runs (an edit that arrives behind the cursor makes `total` grow, and the scan reads on until it has found them).
// The scan stops at once on an edit that is not a bot's (or has no editor, no id, no time, or is deleted): that is news.

const pagesFor = (total) => Math.ceil(total / PAGE) + 1
const emptySide = () => ({ cursor: null, pages: 0, done: false })

function newScan(before) {
  const edits = before.edits
  return { of: before.updatedAt, floor: edits?.at ?? before.updatedAt, base: edits ? edits.total : null, tail: edits ? [...edits.tail] : [], old: 0, found: {}, total: 0, passTotal: null, fwd: emptySide(), bwd: emptySide(), next: "fwd", stamp: null, served: 0 }
}

const restartPass = (scan) => Object.assign(scan, { fwd: emptySide(), bwd: emptySide(), passTotal: scan.total, old: 0, next: "fwd" })

const isNewEdit = (scan, edit) => !(Date.parse(edit.editedAt) < Date.parse(scan.floor)) && !scan.tail.includes(edit.id)

const botEdit = (edit) => typeof edit.id === "string" && Number.isFinite(Date.parse(edit.editedAt)) && !edit.deletedAt && Boolean(edit.editor) && isBotActor(edit.editor)

/** What a finished scan leaves on the issue's record: how many edits are now judged, when the newest was made and which ones were made then. */
function baselineOf(scan) {
  const at = Object.values(scan.found).reduce((top, editedAt) => (Date.parse(editedAt) > Date.parse(top) ? editedAt : top))
  const same = (editedAt) => Date.parse(editedAt) === Date.parse(at)
  return { total: scan.total, at, tail: [...(same(scan.floor) ? scan.tail : []), ...Object.entries(scan.found).filter(([, editedAt]) => same(editedAt)).map(([id]) => id)] }
}

const NEWS = { kind: "news" }

const validPage = (page) => Array.isArray(page.edits) && Number.isInteger(page.total) && typeof page.updatedAt === "string" && typeof page.hasMore === "boolean"

/** What the pages read so far settle: the issue's new edits are all found (a bot-only proof, once a page is as fresh as the issue), not all found yet (null), or cannot be explained (news). */
function conclude(scan, issue) {
  const found = Object.keys(scan.found).length
  const exhausted = scan.base === null ? scan.fwd.done : scan.fwd.done || scan.bwd.done
  const expected = scan.total - (scan.base ?? scan.old)
  if (found === expected && (scan.base !== null || exhausted)) {
    if (found === 0) return NEWS
    if (Date.parse(scan.stamp) < Date.parse(issue.updated_at)) {
      scan.base ??= scan.old
      scan.lag = true
      return { kind: "deferred", message: "Wait for the next poll: GitHub's edit history is behind the issue and is read again then", code: "drains_edit_history_behind" }
    }
    return { kind: "bot", baseline: baselineOf(scan) }
  }
  if (found > expected && scan.base !== null) return NEWS
  if (exhausted) {
    // Edits that arrived while the history was being read make `total` grow past the pass, and another pass finds them. When nothing new arrived the count cannot be explained.
    if (scan.total <= scan.passTotal || found + (scan.base === null ? scan.old : 0) > scan.total) return NEWS
    scan.base ??= scan.old
    restartPass(scan)
  }
  return null
}

/** Reads one page of the scan and says what it settled, or null when it is not settled yet: news, a bot-only proof with the record it leaves, or waiting for GitHub's history to catch up with the issue. */
async function advance(api, repo, issue, scan) {
  if (!Number.isFinite(Date.parse(scan.floor)) || typeof api.editPage !== "function") return NEWS
  if (scan.lag) {
    // The history was behind the issue: the first page, read again, tells whether it has caught up and whether more edits arrived.
    const page = await api.editPage(repo, issue.number, { backward: false, cursor: null })
    if (!page || !validPage(page)) return NEWS
    scan.total = page.total
    scan.stamp = page.updatedAt
    if (Date.parse(scan.stamp) < Date.parse(issue.updated_at)) return { kind: "deferred", message: "Wait for the next poll: GitHub's edit history is behind the issue and is read again then", code: "drains_edit_history_behind" }
    scan.lag = false
    return conclude(scan, issue)
  }
  let direction = scan.base !== null && scan.next === "bwd" ? "bwd" : "fwd"
  // A finished side ends the pass in `conclude`, which either settles it or restarts both sides, so this only guards a state no page can produce.
  /* istanbul ignore if */
  if (scan[direction].done) direction = direction === "fwd" ? "bwd" : "fwd"
  const side = scan[direction]
  const page = await api.editPage(repo, issue.number, { backward: direction === "bwd", cursor: side.cursor })
  if (!page || !validPage(page)) return NEWS
  scan.total = page.total
  scan.stamp = page.updatedAt
  scan.passTotal ??= page.total
  side.pages += 1
  scan.next = direction === "fwd" ? "bwd" : "fwd"
  let person = false
  for (const edit of page.edits) {
    if (!edit || typeof edit !== "object") return NEWS
    if (!isNewEdit(scan, edit)) {
      if (scan.base === null) scan.old += 1
      continue
    }
    if (!botEdit(edit)) {
      if (typeof edit.id !== "string" || !Number.isFinite(Date.parse(edit.editedAt))) return NEWS
      person = true
    }
    scan.found[edit.id] = edit.editedAt
  }
  if (person) {
    // A person's edit is news. It also leaves a baseline, so the next change is not read from the start again, but only when every edit is accounted for:
    // the whole page was judged, and the new edits found are exactly the ones the count says exist (or the side was read to its end and every edit was old or found).
    // Otherwise an unread person's edit could sit under the count and be passed over later as a bot-only change.
    const found = Object.keys(scan.found).length
    const accounted = scan.base === null ? !page.hasMore && scan.old + found === scan.total : found === scan.total - scan.base
    return accounted ? { kind: "news", baseline: baselineOf(scan) } : NEWS
  }
  if (page.hasMore) {
    // A cursor that does not move, or more pages than the history can hold, is a cycle: it would never end.
    if (typeof page.cursor !== "string" || page.cursor === side.cursor || side.pages >= pagesFor(scan.total)) return NEWS
    side.cursor = page.cursor
  } else {
    side.done = true
  }
  return conclude(scan, issue)
}

/** Whether the GraphQL quota allows another page now: the same reserve as REST's, read from the connection's own headers, else from the last poll's reading while its window is open. */
function canSpend(api, state, now) {
  const quota = api.graphqlQuota?.() ?? state.graphqlQuota
  if (!quota || now >= quota.reset * 1000) return true
  return quota.remaining - (api.graphqlCost?.() ?? 1) > QUOTA_RESERVE
}

/**
 * Settles, for the issues whose body changed, whether bots alone made the edits. Every open scan gets one page per round, the one
 * served longest ago first (`served` is kept with the scan), so scans that outnumber the pages the quota allows still take turns,
 * and an issue with a short history is settled in the first round. A scan that cannot go on keeps its progress and is deferred,
 * never settled by a guess.
 */
async function attribute(api, repo, state, needs, now) {
  const verdicts = new Map()
  const scans = state.scans ?? (state.scans = {})
  const wanted = new Set(needs.map(({ issue }) => String(issue.number)))
  for (const key of Object.keys(scans)) if (!wanted.has(key)) delete scans[key]
  const pending = new Set()
  for (const { issue, before } of needs) {
    const key = String(issue.number)
    if (scans[key]?.of !== before.updatedAt) scans[key] = newScan(before)
    pending.add({ issue, key, scan: scans[key] })
  }
  let halted = null
  while (pending.size > 0 && !halted) {
    for (const item of [...pending].sort((a, b) => a.scan.served - b.scan.served || a.issue.number - b.issue.number)) {
      if (!canSpend(api, state, now)) {
        const quota = api.graphqlQuota?.() ?? state.graphqlQuota
        halted = { message: `Wait for the quota to reset: GitHub's GraphQL limit leaves ${quota.remaining}/${quota.limit} calls until ${new Date(quota.reset * 1000).toISOString()}`, code: "drains_rate_limited" }
        break
      }
      item.scan.served = state.scanTurn = (state.scanTurn ?? 0) + 1
      try {
        const verdict = await advance(api, repo, item.issue, item.scan)
        if (!verdict) continue
        verdicts.set(item.issue.number, verdict)
        pending.delete(item)
        if (verdict.kind !== "deferred") delete scans[item.key]
      } catch (error) {
        pending.delete(item)
        verdicts.set(item.issue.number, { kind: "deferred", message: error.message, code: error.code })
        if (error.code === "drains_rate_limited") halted = { message: error.message, code: error.code }
      }
    }
  }
  for (const item of pending) verdicts.set(item.issue.number, { kind: "deferred", ...halted })
  return verdicts
}

/** A bot comment's text without what changes from run to run: run URLs and IDs, dates, times and durations. */
function repeatableText(body) {
  return String(body ?? "")
    .replace(/https?:\/\/\S*\/actions\/runs\/\d+\S*/giu, "<run>")
    .replace(/\brun[ _-]?(?:id|number)?[ :#=]*\d+/giu, "run <id>")
    .replace(/\d{4}-\d{2}-\d{2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?/gu, "<time>")
    .replace(/\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?(?:,? \d{4})?/giu, "<time>")
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?: ?[ap]m)?(?: ?(?:utc|gmt|[a-z]{2,4}t))?\b/giu, "<time>")
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|secs?|seconds?|mins?|minutes?|h|hrs?|hours?)\b/giu, "<duration>")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase()
}

/** Whether a bot's comment says what the same bot's previous comment on the issue said, apart from dates, times, durations and run links: a repeat is not news, a changed text is. */
async function repeatsPrevious(api, repo, issue, comment, tail) {
  const author = comment.user?.login?.toLowerCase()
  const earlier = (entry) => entry.user?.login?.toLowerCase() === author && entry.id !== comment.id && entry.created_at < comment.created_at
  // Read from the newest comments back, only as far as the previous one by this author: the history before it cannot change the answer. The newest part read is kept for the issue's other comments: a match inside it is newer than anything left unread.
  if (!tail.list?.some(earlier)) tail.list = await api.comments(repo, issue.number, "1970-01-01T00:00:00Z", (page) => page.some(earlier))
  const previous = tail.list.filter(earlier).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
  return previous !== undefined && repeatableText(previous.body) === repeatableText(comment.body)
}

const isDrainLabel = (event) => (event.event === "labeled" || event.event === "unlabeled") && (event.label?.name ?? "").toLowerCase().startsWith(DRAIN_LABEL_PREFIX)

/** A label or state change by the polling account while the drain was working: after a wake's delivery and before its turn ran out. The drain does its work through that account, whatever label it touches. */
const duringTurn = (event, login, turns) => {
  const at = Date.parse(event.created_at)
  return event.actor?.login?.toLowerCase() === login.toLowerCase() && turns.some((from) => at >= from - TURN_LEAD_MS && at <= from + TURN_MS)
}

/** What made a reopen or a label change news, or null: a label outside the drain's namespace, ignored list and ignored patterns, a reopen that is not the drain claiming the issue, or an assignment change (assigned or unassigned) outside the drain's turn (its own `drain:` label change within a minute). A label or assignee applied within a minute of the issue being opened was part of filing it, and the "new issue" wake shows it. A label, reopen or assignment change by the polling account during the drain's turn is its own work. Closes and mentions are not news. */
function newsEvent(event, rules, claims, login, openedAt) {
  if (event.event === "reopened") {
    const own = event.actor?.login?.toLowerCase() === login.toLowerCase() && claims.some((claim) => claim.actor?.login?.toLowerCase() === login.toLowerCase() && Math.abs(Date.parse(claim.created_at) - Date.parse(event.created_at)) <= CLAIM_SLACK_MS)
    return own || duringTurn(event, login, rules.turns) ? null : "reopened"
  }
  if (event.event === "assigned" || event.event === "unassigned") {
    if (event.event === "assigned" && Date.parse(event.created_at) <= openedAt + OPENING_LABEL_MS) return null
    return duringTurn(event, login, rules.turns) ? null : `${event.event} ${event.assignee?.login ?? "nobody"}`
  }
  if (event.event !== "labeled" && event.event !== "unlabeled") return null
  if (event.event === "labeled" && Date.parse(event.created_at) <= openedAt + OPENING_LABEL_MS) return null
  const name = (event.label?.name ?? "").toLowerCase()
  const ignored = name.startsWith(DRAIN_LABEL_PREFIX) || rules.labels.includes(name) || rules.patterns.some((pattern) => pattern.test(name))
  return ignored || duringTurn(event, login, rules.turns) ? null : `${event.event} ${name}`
}

/** An issue the drain filed or already triaged: a label in its `drain:` namespace, or its status marker in the body, is there before the poll first sees it, so it is already seen. */
const filedByDrain = (issue) => (issue.labels ?? []).some((label) => (label?.name ?? "").toLowerCase().startsWith(DRAIN_LABEL_PREFIX)) || (issue.body ?? "").includes(DRAIN_STATUS_MARKER)

/** What someone but the drain changed since `before` (a new issue, a title or body edit (an edit that only bots made to the body, such as a health table's refresh, is not news), an edit, another comment, a reopen or a label outside the drain's own), or null. The reason travels with the event. */
async function changedByOthers(api, repo, issue, before, digest, ignored, rules, edited) {
  if (!before) return filedByDrain(issue) ? null : "new issue"
  if (edited) return edited
  const since = before.updatedAt
  const comments = (await api.comments(repo, issue.number, since)).filter((comment) => comment.updated_at > since)
  const tail = {}
  for (const entry of comments) {
    if (ownStatus(entry, api.login) || ignoredComment(entry, rules.comments) || (isBot(entry) && (await repeatsPrevious(api, repo, issue, entry, tail)))) continue
    return `comment ${entry.id} by ${entry.user?.login ?? "nobody"}`
  }
  // A reopen is the drain's own when its claim (a `drain:` label event) came up to CLAIM_SLACK_MS before it, so the read reaches back that far past the revision.
  const feed = await api.issueEvents(repo, issue.number, isoSeconds(Date.parse(since) - CLAIM_SLACK_MS))
  const claims = feed.filter(isDrainLabel)
  const news = feed.filter((event) => event.created_at > since).map((event) => newsEvent(event, rules, claims, api.login, Date.parse(issue.created_at))).find(Boolean)
  return news ?? (await crossReference(api, repo, issue, since))
}

const OPENING_LABEL_MS = 60_000
const DRAIN_BRANCH_PREFIXES = ["drain-", "drain/"]
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/** Whether a cross-reference's source is the drain's own work: an issue or pull request the drain filed (a `drain:` label or the marker in its body), a pull request on a `drain-` or `drain/` branch, the drain's marked comment on this issue that names the source, or its marked comment on the source that names this issue around then. */
async function selfCaused(api, repo, issue, event) {
  const source = event.source?.issue ?? {}
  if (filedByDrain(source)) return true
  const where = source.repository_url?.replace(/^.*\/repos\//u, "") ?? repo
  if (source.pull_request) {
    const pull = await api.pull(where, source.number).catch(() => null)
    if (DRAIN_BRANCH_PREFIXES.some((prefix) => String(pull?.head?.ref ?? "").startsWith(prefix))) return true
  }
  // The drain's marked status comment on this issue names the source: the link between an issue and the pull request the drain opened for it.
  const ref = `${escapePattern(where)}(?:#|/(?:pull|issues)/)${source.number}(?!\\d)`
  const mention = new RegExp(where === repo ? `(?:^|[^\\w/])#${source.number}(?!\\d)|${ref}` : ref, "u")
  const here = await api.comments(repo, issue.number, "1970-01-01T00:00:00Z", (page) => page.some((comment) => ownStatus(comment, api.login) && mention.test(comment.body))).catch(() => [])
  if (here.some((comment) => ownStatus(comment, api.login) && mention.test(comment.body))) return true
  const names = new RegExp(`#${issue.number}(?!\\d)|/${escapePattern(repo)}/issues/${issue.number}(?!\\d)`, "u")
  const at = Date.parse(event.created_at)
  const comments = await api.comments(where, source.number, isoSeconds(at - CROSS_REFERENCE_SLACK_MS)).catch(() => [])
  return comments.some((comment) => ownStatus(comment, api.login) && names.test(comment.body) && [comment.created_at, comment.updated_at].some((time) => Math.abs(at - Date.parse(time)) <= CROSS_REFERENCE_SLACK_MS))
}

/** An issue whose `updated_at` moved with nothing else news: a cross-reference that is not the drain's own work is, and says where from. */
async function crossReference(api, repo, issue, since) {
  const events = (await api.timeline(repo, issue.number, since)).filter((event) => event.event === "cross-referenced" && event.created_at > since)
  for (const event of events) {
    if (await selfCaused(api, repo, issue, event)) continue
    const source = event.source?.issue ?? {}
    return `cross-reference from ${source.repository_url?.replace(/^.*\/repos\//u, "") ?? repo}#${source.number ?? "unknown"}`
  }
  return null
}

const isoSeconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/u, "Z")

/** The issues to look at this poll: all the open ones, or, between full syncs, only those updated since the last change (a 304 means none). */
async function listIssues(api, drain, state, now) {
  const delta = api.changedIssues && state.seeded && state.cursor && state.syncedAt && now - Date.parse(state.syncedAt) < FULL_SYNC_MS
  if (!delta) return { full: true, issues: await api.openIssues(drain.repo) }
  const since = isoSeconds(Date.parse(state.cursor) - DELTA_SLACK_MS)
  const changed = await api.changedIssues(drain.repo, since, state.etag?.since === since ? state.etag.tag : undefined)
  if (changed.notModified) return { full: false, issues: [], untouched: true }
  return { full: false, issues: changed.issues, etag: changed.etag ? { since, tag: changed.etag } : undefined, newEtag: true }
}

/** What the account's quota says to do about this drain now: null to poll, or why not (until the window resets, or for a while). */
export function quotaHold(quota, lastPollAt, now) {
  if (!quota || now >= quota.reset * 1000) return null
  const until = new Date(quota.reset * 1000).toISOString()
  if (quota.remaining <= QUOTA_RESERVE) return `${quota.remaining}/${quota.limit} calls left, paused until ${until}`
  const slow = Math.max(QUOTA_LOW, quota.limit / 10)
  if (quota.remaining <= slow && lastPollAt && now - Date.parse(lastPollAt) < QUOTA_SLOW_MS) return `${quota.remaining}/${quota.limit} calls left, polling every ${QUOTA_SLOW_MS / 60_000}m until ${until}`
  return null
}

/** Poll one drain's repository and record what changed. A failure is recorded in its state and leaves every marker where it was. */
export async function pollDrain(drain, states, { connect, now, desk }) {
  const state = states[drain.repo] ?? (states[drain.repo] = blank())
  let api = null
  let left = null
  try {
    const knownLogin = state.loginAt && now - Date.parse(state.loginAt) < LOGIN_MS ? state.login : undefined
    api = await connect(drain.account, { login: knownLogin })
    if (!knownLogin) {
      state.login = api.login
      state.loginAt = new Date(now).toISOString()
    }
    const listed = await listIssues(api, drain, state, now)
    if (!listed.untouched) {
      const { deferred } = await recordChanges(api, drain, state, listed, { now, desk })
      // The tag of the list is kept only once every change in it is recorded: a failed poll, or an issue left for the next one, asks for the same list again, never a 304 for it.
      if (deferred.length > 0) delete state.etag
      else if (listed.newEtag) state.etag = listed.etag
      if (deferred.length > 0) {
        const shown = deferred.slice(0, 3).map((item) => `#${item.number} (${item.message})`).join(", ")
        left = { message: `Wait for the next poll: ${deferred.length} issue(s) were left for it: ${shown}${deferred.length > 3 ? ", …" : ""}`, code: "drains_issues_deferred" }
        const specific = deferred.find((item) => item.code)?.code
        if (specific) left.code = specific
      }
    }
    state.lastOkAt = new Date(now).toISOString()
    delete state.lastError
    delete state.lastErrorCode
    if (left) {
      state.lastError = left.message
      state.lastErrorCode = left.code
    }
  } catch (error) {
    state.lastError = error.message
    if (typeof error.code === "string") state.lastErrorCode = error.code
    else delete state.lastErrorCode
  }
  const quota = api?.quota?.()
  if (quota) state.quota = quota
  const graphqlQuota = api?.graphqlQuota?.()
  if (graphqlQuota) state.graphqlQuota = graphqlQuota
  state.calls = api?.calls?.() ?? { total: 0, notModified: 0 }
  delete state.hold
  state.lastPollAt = new Date(now).toISOString()
}

async function recordChanges(api, drain, state, { full, issues }, { now, desk }) {
  const trailers = drain.ignoredBodyTrailers ?? []
  const ignored = trailers.join(",")
  const labels = (drain.ignoredLabels ?? []).map((name) => name.toLowerCase())
  const quiet = (drain.ignoreComments ?? []).map(({ author, match }) => ({ author: author.toLowerCase(), match: match === undefined ? null : new RegExp(match, "u") }))
  const rules = { labels, comments: quiet, patterns: (drain.ignoreLabels ?? []).map((pattern) => new RegExp(pattern, "iu")), turns: (state.turns ?? []).map((at) => Date.parse(at)).filter(Number.isFinite) }
  const seen = full ? {} : { ...state.seen }
  const recorded = []
  const closed = new Set()
  const todo = []
  const deferred = []
  let held = null
  let cursor = state.cursor ?? ""
  for (const issue of issues) {
    if (!full && issue.updated_at > cursor) cursor = issue.updated_at
    if (issue.pull_request) continue
    const key = String(issue.number)
    const before = seenIssue(state.seen[key])
    if (issue.state === "closed") {
      closed.add(issue.number)
      if (before) seen[key] = { ...before, goneAt: before.goneAt ?? now }
      continue
    }
    if (full && issue.updated_at > cursor) cursor = issue.updated_at
    const digest = digestOf(issue, trailers)
    seen[key] = { updatedAt: issue.updated_at, digest, title: issue.title, ...(ignored ? { ignored } : {}), ...(before?.edits && before.digest === digest ? { edits: before.edits } : {}) }
    if (!state.seeded || before?.updatedAt === issue.updated_at) continue
    // A body that changed is news unless bots alone edited it, whoever created the issue.
    const bodyChanged = Boolean(before?.digest) && (before.ignored ?? "") === ignored && before.digest !== digest
    // A record from before titles were kept cannot show the title is unchanged, so its first changed poll is news as it always was.
    const edited = bodyChanged && before.title !== issue.title ? "title or body edited" : null
    todo.push({ issue, key, before, digest, edited, scan: bodyChanged && !edited })
  }
  const verdicts = await attribute(api, drain.repo, state, todo.filter((item) => item.scan), now)
  for (const item of todo) {
    const { issue, key, before, digest } = item
    const verdict = verdicts.get(issue.number)
    try {
      if (verdict?.kind === "deferred") throw Object.assign(new Error(verdict.message), { code: verdict.code })
      if (verdict?.kind === "news") item.edited = "title or body edited"
      const why = await changedByOthers(api, drain.repo, issue, before, digest, ignored, rules, item.edited)
      if (verdict?.baseline) seen[key].edits = verdict.baseline
      if (why) recorded.push({ number: issue.number, title: issue.title, updatedAt: issue.updated_at, seenAt: new Date(now).toISOString(), why })
    } catch (error) {
      // This issue's marker stays where it was, so the next poll judges the same change again; the others go on.
      // Only an issue that was seen before can fail here (a new one is judged without a read), so there is always a marker to restore.
      seen[key] = before
      deferred.push({ number: issue.number, message: error.message, code: error.code })
      if (!held || issue.updated_at < held) held = issue.updated_at
    }
  }
  for (const [key, entry] of Object.entries(state.seen)) {
    const gone = seenIssue(entry)
    const goneAt = gone.goneAt ?? now
    if (full && !(key in seen) && now - goneAt < GONE_MS) seen[key] = { ...gone, goneAt }
  }
  const open = full ? new Set(issues.map((issue) => issue.number)) : null
  const numbers = new Set(recorded.map((event) => event.number))
  const stillOpen = (event) => (open ? open.has(event.number) : !closed.has(event.number))
  state.pending = [...state.pending.filter((event) => stillOpen(event) && !numbers.has(event.number)), ...recorded]
  state.history = [...(state.history ?? []), ...recorded.map((event) => (desk ? { ...event, desk } : event))].slice(-HISTORY)
  state.seen = seen
  state.seeded = true
  state.openCount = Object.values(seen).filter((entry) => !seenIssue(entry).goneAt).length
  if (held && (!cursor || held < cursor)) cursor = held
  if (cursor) state.cursor = cursor
  if (full) state.syncedAt = new Date(now).toISOString()
  return { deferred }
}

function span(ms) {
  const minutes = Math.max(0, Math.round(ms / 60_000))
  return minutes < 1 ? "under 1m" : minutes < 90 ? `${minutes}m` : `${Math.round(minutes / 60)}h`
}

function ago(iso, now) {
  const text = span(now - Date.parse(iso))
  return text === "under 1m" ? "just now" : `${text} ago`
}

/** When the last poll that read GitHub without an error finished. A state from before this was recorded counts its last poll when that had no error. */
const lastOk = (state) => state.lastOkAt ?? (state.lastError ? null : state.lastPollAt)

/** The newest quota reading among the drains that poll with `account`: the account's quota is shared by all of them. */
function freshestQuota(drains, states, account) {
  return drains
    .filter((drain) => drain.account === account)
    .map((drain) => states[drain.repo]?.quota)
    .filter(Boolean)
    .sort((a, b) => b.at.localeCompare(a.at))[0] ?? null
}

/** One line per account: the calls left in its window, when it resets, and what the last cycle spent. */
export function quotaLines(drains, states, now) {
  return [...new Set(drains.map((drain) => drain.account))].flatMap((account) => {
    const quota = freshestQuota(drains, states, account)
    if (!quota) return []
    const calls = drains.filter((drain) => drain.account === account).map((drain) => states[drain.repo]?.calls ?? { total: 0, notModified: 0 })
    const spent = calls.reduce((sum, entry) => sum + entry.total, 0)
    const free = calls.reduce((sum, entry) => sum + entry.notModified, 0)
    return [`quota ${account ?? "the active account"}: ${quota.remaining}/${quota.limit} calls left, resets ${new Date(quota.reset * 1000).toISOString()} (read ${ago(quota.at, now)}); the last cycle used ${spent} calls, ${free} of them not modified`]
  })
}

/** One line per drain: its last successful poll and how far behind that is, the last attempt, open issues, events waiting and for how long, last wake and last error. Quota lines come first. */
export function drainStatusLines(drains, states, now) {
  return [...quotaLines(drains, states, now), ...drains.map((drain) => {
    const state = states[drain.repo]
    const session = sessionOf(drain, state)
    const head = `issue drain ${drain.repo} -> ${session.slice(0, 8)}${session === drain.session ? "" : ` (succeeds ${state.successor.predecessor.slice(0, 8)})`}`
    if (!state?.lastPollAt) return `${head}: not polled yet${state?.hold ? `, held: ${state.hold}` : ""}`
    const ok = lastOk(state)
    const good = ok ? `last ok poll ${ok} (lag ${span(now - Date.parse(ok))})` : "no ok poll recorded"
    const since = state.pending.map((event) => Date.parse(event.seenAt)).filter(Number.isFinite)
    const waiting = `${state.pending.length} waiting${since.length ? ` (oldest ${span(now - Math.min(...since))})` : ""}`
    const wake = state.lastWakeAt ? `${ago(state.lastWakeAt, now)} (${state.lastWakeCount} issue${state.lastWakeCount === 1 ? "" : "s"})` : "never"
    return `${head}: ${good}, polled ${ago(state.lastPollAt, now)}, ${state.openCount ?? "?"} open, ${waiting}, last wake ${wake}${state.hold ? `, held: ${state.hold}` : ""}${state.lastError ? `, last error: ${state.lastError}` : ""}${state.targetGone ? `, session archived or gone, starting a successor: ${state.targetGone.error}` : ""}`
  })]
}

/**
 * Poll every configured drain once. The markers and events are written before this returns, so a wake that is never delivered
 * stays pending and comes back with the next poll. Repositories dropped from the config lose their state.
 * Each wake carries `done`, the command that reports its delivery: the runner appends `--error <text>` when delivery failed.
 */
export async function pollDrains({ paths, connect, now, ackCommand, ackFlags = [], desk, recover = recoverDrainTarget }) {
  const drains = readDrainConfig(paths.config)
  for (const drain of drains) if (readDrainStates(paths.state)[drain.repo]?.targetGone) recover({ paths, repo: drain.repo, now })
  const stored = readDrainStates(paths.state)
  const states = Object.fromEntries(drains.map((drain) => [drain.repo, stored[drain.repo] ?? blank()]))
  const skipped = new Set()
  for (const drain of drains) {
    const hold = quotaHold(freshestQuota(drains, states, drain.account), states[drain.repo].lastPollAt, now)
    const last = states[drain.repo].lastPollAt
    // A drain with `everySeconds` is polled no more often than that; its last answers and state stay as they were.
    if (drain.everySeconds && last && now - Date.parse(last) < drain.everySeconds * 1000 - POLL_SLACK_MS) skipped.add(drain.repo)
    else if (hold) Object.assign(states[drain.repo], { hold, calls: { total: 0, notModified: 0 } })
    else await pollDrain(drain, states, { connect, now, desk })
  }
  writeDrainStates(paths.state, states)
  const wakes = drains.filter((drain) => states[drain.repo].pending.length > 0).map((drain) => {
    const events = states[drain.repo].pending
    const id = wakeId(drain.repo, events)
    return { id, repo: drain.repo, session: sessionOf(drain, states[drain.repo]), message: wakeMessage(drain.repo, events), replaces: wakePrefix(drain.repo), events, done: [...ackCommand, "ack", "--repo", drain.repo, "--wake", id, ...ackFlags] }
  })
  const errors = drains.filter((drain) => states[drain.repo].lastError).map((drain) => ({ repo: drain.repo, error: states[drain.repo].lastError, ...(states[drain.repo].lastErrorCode ? { code: states[drain.repo].lastErrorCode } : {}) }))
  const calls = drains.reduce((sum, drain) => sum + (skipped.has(drain.repo) ? 0 : states[drain.repo].calls.total), 0)
  return { at: new Date(now).toISOString(), wakes, errors, calls, status: drainStatusLines(drains, states, now) }
}

/** Record how a wake went: delivered clears its events, failed keeps them and records why. A batch that has since changed is left alone. */
export function ackWake({ paths, repo, wake, error, now }) {
  const states = readDrainStates(paths.state)
  const state = states[repo]
  if (state && error && SESSION_GONE.test(error)) {
    const drain = readDrainConfig(paths.config).find((entry) => entry.repo === repo)
    const session = sessionOf(drain ?? {}, state)
    // A failed successor start leaves its reason on the record; the next failed wake must not replace it with the app's archived message.
    if (state.targetGone?.session === session && state.recoverAt) state.targetGone.at = new Date(now).toISOString()
    else state.targetGone = { session, at: new Date(now).toISOString(), error: error.slice(0, 200) }
    writeDrainStates(paths.state, states)
  }
  if (!state || state.pending.length === 0) return { ok: true, changed: false, reason: "nothing is waiting" }
  if (wakeId(repo, state.pending) !== wake) return { ok: true, changed: false, reason: "the waiting events changed after this wake was made, so the next poll sends them again" }
  if (error) {
    state.lastError = `the wake was not delivered: ${error}`
  } else {
    delete state.targetGone
    state.lastWakeCount = state.pending.length
    state.lastWakeAt = new Date(now).toISOString()
    state.turns = [...(state.turns ?? []), state.lastWakeAt].filter((at) => now - Date.parse(at) <= 2 * TURN_MS).slice(-TURNS_KEPT)
    state.pending = []
  }
  writeDrainStates(paths.state, states)
  return { ok: true, changed: true, reason: error ? "recorded the failed delivery; the events stay waiting" : "cleared the delivered events" }
}

// ── A drain whose session is archived or gone ──

function shepherdCommand({ env, homeDir }) {
  const installed = path.join(homeDir, "Library", "Application Support", "housesitter", "releases", "shepherd", "current", "bin", "shepherd.mjs")
  if (env.DESK_DRAINS_SHEPHERD) return [env.DESK_DRAINS_SHEPHERD]
  if (existsSync(installed)) return [process.execPath, installed]
  return ["shepherd"]
}

/** The first message of a drain's successor. Its first line is what Shepherd reads to archive the predecessor once the successor has taken over. */
export function successorKickoff({ repo, predecessor, account }) {
  return [
    `Succeeds: ${predecessor}`,
    `You are the long-running issue drain for ${repo}, taking over from session ${predecessor}, which was archived. Desk's poller delivers new and changed issues to you as wakes and keeps the ones it could not deliver, so the first wake carries what was waiting.`,
    "Load and follow the `draining-issues` skill exactly: post a visible acknowledgement on every issue, preserve other owners' claims, and close an issue only when its promise is verified.",
    "Keep exactly one of these labels on each issue you touch, creating them if missing: `drain: triaged`, `drain: in progress`, `drain: blocked`, `drain: needs ari`. Use `drain: needs ari` only for a real human decision or right, and say exactly what he must decide.",
    ...(account ? [`Work on GitHub as ${account}.`] : []),
    "Read the open issues now, then drain what is waiting. When the backlog is empty, go idle; do not poll with model turns.",
  ].join("\n\n")
}

/** Starts a session in the drain's project through Shepherd. Returns { ok, session } or { ok: false, error }. */
export function startSuccessor({ repo, predecessor, account }, { spawn = spawnSync, env = process.env, homeDir = os.homedir() } = {}) {
  const [program, ...lead] = shepherdCommand({ env, homeDir })
  const create = (project) => {
    const args = [...lead, "create", "--project", project, "--name", `Drain: ${repo}`, "--prompt", successorKickoff({ repo, predecessor, account }), "--mode", "autopilot", "--why", `Desk starts the successor of the archived drain ${predecessor} for ${repo}`, "--json"]
    const result = spawn(program, args, { encoding: "utf8", timeout: SHEPHERD_MS, env, windowsHide: true })
    let out = null
    try {
      out = JSON.parse(String(result.stdout))
    } catch {}
    return { result, out }
  }
  let { result, out } = create(repo)
  // The app names a project by its own title ("CIT shared workspace"), not by its repository, so a repository that names no project is looked up by the repository the app lists on its sessions.
  if (out?.code === "no-project") {
    const listed = spawn(program, [...lead, "sessions", "--json"], { encoding: "utf8", timeout: SHEPHERD_MS, env, windowsHide: true })
    let project = null
    try {
      project = JSON.parse(String(listed.stdout)).sessions.find((entry) => entry.project_repo === repo && entry.project_id)?.project_id
    } catch {}
    if (project) ({ result, out } = create(project))
  }
  if (out?.session_id) return { ok: true, session: String(out.session_id) }
  // On a loaded Mac the app can create the session and still answer too late, so look for it before reporting a failure that would start a second one.
  const name = `Drain: ${repo}`
  const listed = spawn(program, [...lead, "sessions", "--json"], { encoding: "utf8", timeout: SHEPHERD_MS, env, windowsHide: true })
  let found = null
  try {
    found = JSON.parse(String(listed.stdout)).sessions.find((entry) => entry.name === name && entry.id !== predecessor && Date.parse(entry.created_at) > Date.now() - RECOVER_RETRY_MS)
  } catch {}
  if (found) return { ok: true, session: String(found.id) }
  const why = out?.error || String(result.stderr ?? "").trim().split("\n")[0] || result.error?.message || "shepherd create printed no session"
  return { ok: false, error: String(why).slice(0, 200) }
}

/**
 * A drain whose wake failed because its session is archived or gone starts a successor session and sends its wakes there from then on,
 * so nothing waits for a person. The successor's first line says `Succeeds: <old id>`. The drain config stays as it is: the pointer is
 * kept in the drain's state and lapses if the configured session changes. A failed start is tried again after ten minutes.
 */
export function recoverDrainTarget({ paths, repo, now, start = startSuccessor }) {
  const drain = readDrainConfig(paths.config).find((entry) => entry.repo === repo)
  const states = readDrainStates(paths.state)
  const state = states[repo]
  if (!drain || !state?.targetGone) return { ok: true, changed: false, reason: "the drain's session is not known to be archived" }
  if (state.recoverAt && now - Date.parse(state.recoverAt) < RECOVER_RETRY_MS) return { ok: true, changed: false, reason: "a successor was tried a moment ago; trying again later" }
  const predecessor = sessionOf(drain, state)
  const started = start({ repo, predecessor, account: drain.account })
  if (started.ok) {
    state.successor = { from: drain.session, to: started.session, predecessor, at: new Date(now).toISOString() }
    delete state.targetGone
    delete state.recoverAt
    delete state.lastError
  } else {
    state.recoverAt = new Date(now).toISOString()
    state.targetGone.error = `starting its successor failed: ${started.error}`
  }
  writeDrainStates(paths.state, states)
  return { ok: started.ok, changed: started.ok, ...(started.ok ? { session: started.session, predecessor } : { error: started.error }) }
}

// ── GitHub ──

/** What a non-OK answer means: GitHub's own server failing (5xx) clears by itself; only a 401 (a refused credential) is for the person to fix; any other refusal is reported as the answer GitHub gave, with no credential diagnosis. */
function failedAnswer(status, route) {
  if (status >= 500) return Object.assign(new Error(`Wait for the next poll: GitHub's server answered HTTP ${status} for ${route} (asked twice); this usually clears on its own and needs nothing from you`), { code: "drains_github_server_error", status })
  if (status === 401) return Object.assign(new Error(`Check gh auth status, then try again: GitHub answered HTTP ${status} for ${route}, which means the token was refused`), { code: "drains_check_gh_auth_status_then", status })
  return Object.assign(new Error(`Read GitHub's answer, then fix its cause: GitHub refused the request with HTTP ${status} for ${route}; that is not by itself a credential problem`), { code: "drains_github_refused", status })
}

/** What GitHub said about when to come back: its Retry-After (seconds) and its window reset, kept as milliseconds when they are numbers, with when the answer arrived. */
function retrySignals(headers, receivedAt) {
  const after = headers.get("retry-after")
  const reset = Number(headers.get("x-ratelimit-reset"))
  return { receivedAt, exhausted: headers.get("x-ratelimit-remaining") === "0", ...(after !== null && after.trim() !== "" && Number.isFinite(Number(after)) ? { retryAfterMs: Number(after) * 1000 } : {}), ...(Number.isFinite(reset) && reset > 0 ? { resetAt: reset * 1000 } : {}) }
}

// A read held under the quota floor stops the poll the way the quota running out does, and the next poll tries again.
function heldAsRateLimit(error) {
  if (!(error instanceof SpendHeld)) throw error
  throw Object.assign(new Error(error.message), { code: "drains_rate_limited", status: 429, rateLimited: true, held: true })
}

/** The drain's GitHub access: its account's token from the `gh` CLI, then the REST API. `login` skips asking GitHub who the token is. */
/** A page of an oldest-first list reaches back to `since` when any of its dated items is not newer: nothing before it can be news. */
const reachesBack = (since) => (page) => page.some((item) => typeof item.created_at === "string" && item.created_at <= since)

export async function connectGithub(account, { spawn = spawnSync, fetchImpl: rawFetch = fetch, env = process.env, login: knownLogin, pauseMs = TOKEN_PAUSE_MS, clock = Date.now } = {}) {
  const tokenArgs = ["auth", "token", "--hostname", "github.com", ...(account ? ["--user", account] : [])]
  const cleaned = { ...env, PATH: ["/opt/homebrew/bin", "/usr/local/bin", env.PATH].filter(Boolean).join(":") }
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"]) delete cleaned[name]
  let token = ""
  let transient = ""
  for (let attempt = 1; attempt <= TOKEN_TRIES && !token; attempt++) {
    const result = spawn("gh", tokenArgs, { encoding: "utf8", timeout: TOKEN_MS, env: cleaned, windowsHide: true })
    token = result.status === 0 ? String(result.stdout ?? "").trim() : ""
    if (token) break
    const said = String(result.stderr ?? "").trim().split("\n")[0]
    // Only gh's own "no oauth token" (or a clean empty answer) means the account is not signed in; a timeout, a signal, a keyring that is busy or locked, or any other message is a read that failed and is tried again.
    transient = (result.status === null && result.error?.code !== "ENOENT") || (result.status !== 0 && said && !NO_TOKEN.test(said)) ? (said || result.error?.message || `gh stopped (${result.signal ?? "no status"})`) : ""
    if (!transient) break
    if (attempt < TOKEN_TRIES) await new Promise((resolve) => setTimeout(resolve, pauseMs * attempt))
  }
  if (!token && transient) throw Object.assign(new Error(`Wait for the next poll, which reads the token again: the GitHub CLI's token read for ${account ?? "its active account"} gave no answer, probably because the keyring was busy or slow (${transient.slice(0, 160)})`), { code: "drains_github_cli_token_unavailable", transient: true })
  if (!token) throw Object.assign(new Error(`Sign in the GitHub CLI: the GitHub CLI has no token for ${account ?? "its active account"} (run \`gh auth login --hostname github.com\`)`), { code: "drains_sign_in_the_github_cli" })
  // Every answer is also one line in the host's gh spend ledger (when it has one), and a read is held under its quota floor.
  const fetchImpl = ledgeredFetch(rawFetch, { env, login: () => account || knownLogin || activeLogin(env), label: "desk-drain" })
  // What this connection spent and what GitHub says is left in the account's window; a 304 answer costs nothing against it.
  const meter = { total: 0, notModified: 0, quota: null, graphqlQuota: null, graphqlCost: 1 }
  // A read that GitHub answers with a 5xx is asked once more, at once: its own server failing usually clears. Only reads are repeated, never a write.
  const readTwice = async (url, init) => {
    let response = await fetchImpl(url, init())
    meter.total += 1
    if (response.status >= 500) {
      response = await fetchImpl(url, init())
      meter.total += 1
    }
    return response
  }
  const get = async (route, { etag } = {}) => {
    const response = await readTwice(`https://api.github.com${route}`, () => ({
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "desk-issue-drains", ...(etag ? { "If-None-Match": etag } : {}) },
      signal: AbortSignal.timeout(30_000),
    })).catch(heldAsRateLimit)
    const remaining = response.headers.get("x-ratelimit-remaining")
    if (remaining !== null && response.headers.get("x-ratelimit-resource") !== "graphql") meter.quota = { remaining: Number(remaining), limit: Number(response.headers.get("x-ratelimit-limit")), reset: Number(response.headers.get("x-ratelimit-reset")), at: new Date().toISOString() }
    if (response.status === 304) {
      meter.notModified += 1
      return { notModified: true }
    }
    if (!response.ok) {
      // A 429, or a 403 that GitHub says is the rate limit, is the hourly quota running out, not a refused token.
      const said = response.status === 403 ? await response.text().catch(() => "") : ""
      if (response.status === 429 || (response.status === 403 && (remaining === "0" || response.headers.has("retry-after") || /rate limit/iu.test(said)))) {
        const reset = Number(response.headers.get("x-ratelimit-reset"))
        const until = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "the next window"
        const signals = retrySignals(response.headers, clock())
        const wording = signals.exhausted ? `GitHub's hourly API limit is used up, rate limited until ${until}` : Number.isFinite(signals.retryAfterMs) ? `GitHub asked to wait ${Math.ceil(signals.retryAfterMs / 1000)}s before this read is retried` : remaining === null ? `GitHub rate limited this read, rate limited until ${until}` : "GitHub rate limited this read (not the hourly pool)"
        throw Object.assign(new Error(`Wait for the quota to reset: ${wording} (HTTP ${response.status} for ${route.split("?")[0]})`), { code: "drains_rate_limited", status: response.status, rateLimited: true, ...signals })
      }
      throw failedAnswer(response.status, route.split("?")[0])
    }
    const link = response.headers.get("link") ?? ""
    const last = Number(/<[^>]*[?&]page=(\d+)[^>]*>;\s*rel="last"/u.exec(link)?.[1])
    return { body: await response.json(), next: /rel="next"/u.test(link), last: Number.isInteger(last) ? last : null, etag: response.headers.get("etag") }
  }
  const all = async (route) => {
    const items = []
    const join = route.includes("?") ? "&" : "?"
    let more = true
    for (let page = 1; more; page++) {
      const { body, next } = await get(`${route}${join}per_page=${PAGE}&page=${page}`)
      items.push(...body)
      more = next
    }
    return items
  }
  // The newest part of an oldest-first list, which GitHub cannot filter by time: the first page says where the list ends, then pages
  // are read from the end backwards until `stop(page)` says the page reaches back far enough. The cost follows what is new, not the
  // length of the history. A page that cannot be read is an error, never an empty answer; a list whose end is not known is read whole.
  const recent = async (route, stop) => {
    const join = route.includes("?") ? "&" : "?"
    const first = await get(`${route}${join}per_page=${PAGE}&page=1`)
    if (!first.next) return first.body
    if (first.last === null) return all(route)
    const pages = []
    // The list may have grown since the first answer: the named last page is read as it is now, and any page its answer links on to is followed, as `all` would.
    let top = await get(`${route}${join}per_page=${PAGE}&page=${first.last}`)
    pages.push(top.body)
    for (let page = first.last + 1; top.next; page++) {
      top = await get(`${route}${join}per_page=${PAGE}&page=${page}`)
      pages.push(top.body)
    }
    if (!stop(pages[0])) {
      for (let page = first.last - 1; page >= 1; page--) {
        const { body } = page === 1 ? first : await get(`${route}${join}per_page=${PAGE}&page=${page}`)
        pages.unshift(body)
        if (page === 1 || stop(body)) break
      }
    }
    return pages.flat()
  }
  // A write: the answer is returned, never thrown on, because a refused merge or dispatch is an outcome the caller reports.
  const send = async (method, route, payload) => {
    const response = await fetchImpl(`https://api.github.com${route}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "desk-issue-drains", ...(payload === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      signal: AbortSignal.timeout(30_000),
    })
    meter.total += 1
    return { ok: response.ok, status: response.status, body: await response.json().catch(() => ({})) }
  }
  // GraphQL has its own quota window: its headers are kept apart from the REST reading, and a failure names this API.
  const graphql = async (query, variables) => {
    const response = await readTwice("https://api.github.com/graphql", () => ({
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "desk-issue-drains", "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    }))
    const remaining = response.headers.get("x-ratelimit-remaining")
    if (remaining !== null) meter.graphqlQuota = { remaining: Number(remaining), limit: Number(response.headers.get("x-ratelimit-limit")), reset: Number(response.headers.get("x-ratelimit-reset")), at: new Date().toISOString() }
    const payload = response.ok ? await response.json().catch(() => null) : null
    const limited = response.status === 429 || (response.status === 403 && remaining === "0") || (payload?.errors ?? []).some((error) => error?.type === "RATE_LIMITED")
    if (limited) {
      const reset = Number(response.headers.get("x-ratelimit-reset"))
      const until = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : "the next window"
      throw Object.assign(new Error(`Wait for the quota to reset: GitHub's hourly GraphQL limit is used up, rate limited until ${until} (HTTP ${response.status} for /graphql)`), { code: "drains_rate_limited", status: response.status, rateLimited: true })
    }
    if (!response.ok) throw failedAnswer(response.status, "/graphql")
    if (!payload || (Array.isArray(payload.errors) && payload.errors.length > 0) || typeof payload.data !== "object" || payload.data === null) {
      const said = Array.isArray(payload?.errors) ? payload.errors.map((error) => String(error?.message ?? "")).join("; ").slice(0, 160) : "no data"
      throw Object.assign(new Error(`Read GitHub's answer, then retry on the next poll: its GraphQL answer for the issue's edit history was refused or unreadable (${said}); that is not by itself a credential problem`), { code: "drains_graphql_failed" })
    }
    return payload.data
  }
  // One page of an issue's edit history, from its start or, with `backward`, from its end, after `cursor`. `hasMore` says whether
  // more lies beyond in that direction; `total` and `updatedAt` are the issue's as this page saw them.
  const editPage = async (repo, number, { backward = false, cursor = null } = {}) => {
    const [owner, name] = repo.split("/")
    const data = await graphql(backward ? EDITS_BACKWARD : EDITS_FORWARD, { owner, name, number, cursor })
    if (Number.isFinite(data.rateLimit?.cost)) meter.graphqlCost = data.rateLimit.cost
    const found = data.repository?.issue
    if (!found) return null
    const connection = found.userContentEdits
    const info = connection?.pageInfo
    if (!Array.isArray(connection?.nodes) || typeof info?.[backward ? "hasPreviousPage" : "hasNextPage"] !== "boolean") return { edits: null }
    return {
      updatedAt: found.updatedAt,
      total: connection.totalCount,
      edits: connection.nodes.map((node) => ({ id: node?.id ?? null, editedAt: node?.editedAt ?? null, deletedAt: node?.deletedAt ?? null, editor: node?.editor ? { type: node.editor.__typename ?? null, login: node.editor.login ?? null } : null })),
      hasMore: backward ? info.hasPreviousPage : info.hasNextPage,
      cursor: backward ? info.startCursor : info.endCursor,
    }
  }
  // Who the token really is decides which comments are the drain's own, so each drain's account is resolved from the token that polls its repository.
  const login = knownLogin || (await get("/user").then(({ body }) => String(body.login ?? ""), () => "")) || account || ""
  return {
    login,
    // Names this login and token together without holding the token, so a refreshed credential for the same login is told apart.
    credentialEpoch: createHash("sha256").update(`${login}\0${token}`).digest("hex"),
    openIssues: async (repo) => (await all(`/repos/${repo}/issues?state=open&sort=updated&direction=desc`)).filter((issue) => !issue.pull_request),
    comments: (repo, issue, since, stop) => (stop ? recent : all)(`/repos/${repo}/issues/${issue}/comments?since=${encodeURIComponent(since)}`, stop),
    issueEvents: (repo, issue, since) => (since ? recent(`/repos/${repo}/issues/${issue}/events`, reachesBack(since)) : all(`/repos/${repo}/issues/${issue}/events`)),
    changedIssues: async (repo, since, etag) => {
      const route = `/repos/${repo}/issues?state=all&sort=updated&direction=desc&since=${encodeURIComponent(since)}&per_page=${PAGE}`
      const first = await get(`${route}&page=1`, { etag })
      if (first.notModified) return { notModified: true }
      const items = [...first.body]
      for (let page = 2, more = first.next; more; page++) {
        const { body, next } = await get(`${route}&page=${page}`)
        items.push(...body)
        more = next
      }
      return { issues: items, etag: first.etag }
    },
    get,
    send,
    quota: () => meter.quota,
    graphqlQuota: () => meter.graphqlQuota,
    editPage,
    graphqlCost: () => meter.graphqlCost,
    calls: () => ({ total: meter.total, notModified: meter.notModified }),
    timeline: (repo, issue, since) => (since ? recent(`/repos/${repo}/issues/${issue}/timeline`, reachesBack(since)) : all(`/repos/${repo}/issues/${issue}/timeline`)),
    pull: async (repo, number) => (await get(`/repos/${repo}/pulls/${number}`)).body,
  }
}
