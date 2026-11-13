// Issue drains: the deterministic poll behind `scripts/drains.js`. It lists each configured repository's open issues with no model
// turn and records which ones are new or changed since the last poll. It never wakes anyone: it returns the wakes, and whatever
// runs it (a launchd job, an always-on agent runtime) delivers them and reports back with `ack`. See docs/issue-drains.md.
//
// `updated_at` alone is not a revision: the drain's own label edits and status comment move it too. An issue is news only when
// something other than the drain changed it since the revision last recorded for that issue.
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

/** A drain's own status comment carries this marker, so its creation and edits do not wake the drain again. */
export const DRAIN_STATUS_MARKER = "<!-- ouro-drain-status -->"
/** The drain moves an issue through labels in this namespace (`drain: triaged`, `drain: in progress`); changing them is not news. */
const DRAIN_LABEL_PREFIX = "drain:"
/** A closed issue's record is kept this long, so one that comes back unchanged is not mistaken for a new issue. */
const GONE_MS = 30 * 24 * 3_600_000
const LOCK_STALE_MS = 15 * 60_000
const MAX_TITLES = 20
const PAGE = 100

const blank = () => ({ seeded: false, seen: {}, pending: [] })

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

function problem(code, thing, probably, look, fix) {
  return new Error(deskFailure({ code, thing, probably, look, keepWorking: "no seen marker moved and no wake was lost", fix }))
}

// ── Config ──

const isText = (value) => typeof value === "string" && value.trim() !== ""
const textList = (value) => Array.isArray(value) && value.every(isText)

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
    const { repo, session, account, ignoredBodyTrailers, ignoredLabels } = entry
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw bad(`drains[${index}].repo is not "owner/name"`)
    if (!isText(session)) throw bad(`drains[${index}].session is not a session id`)
    if (account !== undefined && !isText(account)) throw bad(`drains[${index}].account is not a GitHub login`)
    if (ignoredBodyTrailers !== undefined && (!textList(ignoredBodyTrailers) || ignoredBodyTrailers.some((key) => key.includes(":")))) throw bad(`drains[${index}].ignoredBodyTrailers is not a list of trailer keys such as "Active-at"`)
    if (ignoredLabels !== undefined && !textList(ignoredLabels)) throw bad(`drains[${index}].ignoredLabels is not a list of label names such as "agent:drain"`)
    if (seen.has(repo)) throw bad(`drains[${index}].repo ${repo} is listed twice`)
    seen.add(repo)
    return {
      repo,
      session: session.trim(),
      ...(account === undefined ? {} : { account: account.trim() }),
      ...(ignoredBodyTrailers === undefined ? {} : { ignoredBodyTrailers: ignoredBodyTrailers.map((key) => key.trim()) }),
      ...(ignoredLabels === undefined ? {} : { ignoredLabels: ignoredLabels.map((name) => name.trim()) }),
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

function create(lockFile) {
  closeSync(openSync(lockFile, "wx"))
  writeFileSync(lockFile, String(process.pid))
}

function lockOwner(lockFile, now) {
  try {
    return { pid: Number.parseInt(readFileSync(lockFile, "utf8"), 10), ageMs: now - statSync(lockFile).mtimeMs }
  } catch {
    return null
  }
}

/** Runs `work`, which may be async, while this process owns the lock file. A live owner means another poll or ack is mid-write, so this one stops instead of racing it. */
export async function withDrainLock(lockFile, work, { now = Date.now(), alive = processAlive } = {}) {
  assertNotRealStateUnderTest(path.dirname(lockFile))
  mkdirSync(path.dirname(lockFile), { recursive: true })
  try {
    create(lockFile)
  } catch (error) {
    if (error.code !== "EEXIST") throw error
    const owner = lockOwner(lockFile, now)
    if (owner && owner.ageMs <= LOCK_STALE_MS && alive(owner.pid)) {
      throw problem("desk_drains_busy", "drains lock", `process ${owner.pid} holds ${lockFile} and is still working`, `check that process, then look at ${lockFile}`, "run the command again once it finishes")
    }
    rmSync(lockFile, { force: true })
    create(lockFile)
  }
  try {
    return await work()
  } finally {
    rmSync(lockFile, { force: true })
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

export function wakeMessage(repo, events) {
  const shown = events.slice(0, MAX_TITLES).map((event) => `#${event.number} ${oneLine(event.title)}`)
  const more = events.length > MAX_TITLES ? `, and ${events.length - MAX_TITLES} more` : ""
  return `New or changed issues in ${repo}: ${shown.join(", ")}${more}. Drain them.`
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

/** A reopen, or a change to a label that is neither in the drain's namespace nor on its ignored list. Closes, assignments and mentions are not news. */
function newsEvent(event, ignoredLabels) {
  if (event.event === "reopened") return true
  if (event.event !== "labeled" && event.event !== "unlabeled") return false
  const name = (event.label?.name ?? "").toLowerCase()
  return !name.startsWith(DRAIN_LABEL_PREFIX) && !ignoredLabels.includes(name)
}

/** Whether anyone but the drain changed the issue since `before`: a new issue, an edit, another comment, a reopen or a label outside the drain's own. */
async function changedByOthers(api, repo, issue, before, digest, ignored, ignoredLabels) {
  if (!before) return true
  if (before.digest && (before.ignored ?? "") === ignored && before.digest !== digest) return true
  const since = before.updatedAt
  const comments = (await api.comments(repo, issue.number, since)).filter((comment) => comment.updated_at > since)
  if (comments.some((comment) => !ownStatus(comment, api.login))) return true
  const events = (await api.issueEvents(repo, issue.number)).filter((event) => event.created_at > since)
  return events.some((event) => newsEvent(event, ignoredLabels))
}

/** Poll one drain's repository and record what changed. A failure is recorded in its state and leaves every marker where it was. */
export async function pollDrain(drain, states, { connect, now }) {
  const state = states[drain.repo] ?? (states[drain.repo] = blank())
  try {
    const api = await connect(drain.account)
    const issues = await api.openIssues(drain.repo)
    const trailers = drain.ignoredBodyTrailers ?? []
    const ignored = trailers.join(",")
    const labels = (drain.ignoredLabels ?? []).map((name) => name.toLowerCase())
    const seen = {}
    const recorded = []
    for (const issue of issues) {
      const key = String(issue.number)
      const before = seenIssue(state.seen[key])
      const digest = digestOf(issue, trailers)
      seen[key] = { updatedAt: issue.updated_at, digest, ...(ignored ? { ignored } : {}) }
      if (!state.seeded || before?.updatedAt === issue.updated_at) continue
      if (await changedByOthers(api, drain.repo, issue, before, digest, ignored, labels)) recorded.push({ number: issue.number, title: issue.title, updatedAt: issue.updated_at })
    }
    for (const [key, entry] of Object.entries(state.seen)) {
      const gone = seenIssue(entry)
      const goneAt = gone.goneAt ?? now
      if (!(key in seen) && now - goneAt < GONE_MS) seen[key] = { ...gone, goneAt }
    }
    const open = new Set(issues.map((issue) => issue.number))
    const numbers = new Set(recorded.map((event) => event.number))
    state.pending = [...state.pending.filter((event) => open.has(event.number) && !numbers.has(event.number)), ...recorded]
    state.seen = seen
    state.seeded = true
    state.openCount = issues.length
    delete state.lastError
  } catch (error) {
    state.lastError = error.message
  }
  state.lastPollAt = new Date(now).toISOString()
}

function ago(iso, now) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000))
  return minutes < 1 ? "just now" : minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

/** One line per drain: its last poll, open issues, events waiting, last wake and last error. */
export function drainStatusLines(drains, states, now) {
  return drains.map((drain) => {
    const state = states[drain.repo]
    const head = `issue drain ${drain.repo} -> ${drain.session.slice(0, 8)}`
    if (!state?.lastPollAt) return `${head}: not polled yet`
    const wake = state.lastWakeAt ? `${ago(state.lastWakeAt, now)} (${state.lastWakeCount} issue${state.lastWakeCount === 1 ? "" : "s"})` : "never"
    return `${head}: polled ${ago(state.lastPollAt, now)}, ${state.openCount ?? "?"} open, ${state.pending.length} waiting, last wake ${wake}${state.lastError ? `, last error: ${state.lastError}` : ""}`
  })
}

/**
 * Poll every configured drain once. The markers and events are written before this returns, so a wake that is never delivered
 * stays pending and comes back with the next poll. Repositories dropped from the config lose their state.
 * Each wake carries `done`, the command that reports its delivery: the runner appends `--error <text>` when delivery failed.
 */
export async function pollDrains({ paths, connect, now, ackCommand, ackFlags = [] }) {
  const drains = readDrainConfig(paths.config)
  const stored = readDrainStates(paths.state)
  const states = Object.fromEntries(drains.map((drain) => [drain.repo, stored[drain.repo] ?? blank()]))
  for (const drain of drains) await pollDrain(drain, states, { connect, now })
  writeDrainStates(paths.state, states)
  const wakes = drains.filter((drain) => states[drain.repo].pending.length > 0).map((drain) => {
    const events = states[drain.repo].pending
    const id = wakeId(drain.repo, events)
    return { id, repo: drain.repo, session: drain.session, message: wakeMessage(drain.repo, events), events, done: [...ackCommand, "ack", "--repo", drain.repo, "--wake", id, ...ackFlags] }
  })
  const errors = drains.filter((drain) => states[drain.repo].lastError).map((drain) => ({ repo: drain.repo, error: states[drain.repo].lastError }))
  return { at: new Date(now).toISOString(), wakes, errors, status: drainStatusLines(drains, states, now) }
}

/** Record how a wake went: delivered clears its events, failed keeps them and records why. A batch that has since changed is left alone. */
export function ackWake({ paths, repo, wake, error, now }) {
  const states = readDrainStates(paths.state)
  const state = states[repo]
  if (!state || state.pending.length === 0) return { ok: true, changed: false, reason: "nothing is waiting" }
  if (wakeId(repo, state.pending) !== wake) return { ok: true, changed: false, reason: "the waiting events changed after this wake was made, so the next poll sends them again" }
  if (error) {
    state.lastError = `the wake was not delivered: ${error}`
  } else {
    state.lastWakeCount = state.pending.length
    state.lastWakeAt = new Date(now).toISOString()
    state.pending = []
  }
  writeDrainStates(paths.state, states)
  return { ok: true, changed: true, reason: error ? "recorded the failed delivery; the events stay waiting" : "cleared the delivered events" }
}

// ── GitHub ──

/** The drain's GitHub access: its account's token from the `gh` CLI, then the REST API. */
export async function connectGithub(account, { spawn = spawnSync, fetchImpl = fetch, env = process.env } = {}) {
  const tokenArgs = ["auth", "token", "--hostname", "github.com", ...(account ? ["--user", account] : [])]
  const cleaned = { ...env, PATH: ["/opt/homebrew/bin", "/usr/local/bin", env.PATH].filter(Boolean).join(":") }
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"]) delete cleaned[name]
  const result = spawn("gh", tokenArgs, { encoding: "utf8", timeout: 10_000, env: cleaned })
  const token = result.status === 0 ? String(result.stdout ?? "").trim() : ""
  if (!token) throw new Error(`the GitHub CLI has no token for ${account ?? "its active account"} (run \`gh auth login --hostname github.com\`)`)
  const get = async (route) => {
    const response = await fetchImpl(`https://api.github.com${route}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "desk-issue-drains" },
      signal: AbortSignal.timeout(30_000),
    })
    if (!response.ok) throw new Error(`GitHub answered HTTP ${response.status} for ${route.split("?")[0]}`)
    return { body: await response.json(), next: /rel="next"/u.test(response.headers.get("link") ?? "") }
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
  const login = account ?? String((await get("/user")).body.login ?? "")
  return {
    login,
    openIssues: async (repo) => (await all(`/repos/${repo}/issues?state=open&sort=updated&direction=desc`)).filter((issue) => !issue.pull_request),
    comments: (repo, issue, since) => all(`/repos/${repo}/issues/${issue}/comments?since=${encodeURIComponent(since)}`),
    issueEvents: (repo, issue) => all(`/repos/${repo}/issues/${issue}/events`),
  }
}
