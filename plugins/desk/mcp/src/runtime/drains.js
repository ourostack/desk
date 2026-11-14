// Issue drains: the deterministic poll behind `scripts/drains.js`. It lists each configured repository's open issues with no model
// turn and records which ones are new or changed since the last poll. It never wakes anyone: it returns the wakes, and whatever
// runs it (a launchd job, an always-on agent runtime) delivers them and reports back with `ack`. See docs/issue-drains.md.
//
// `updated_at` alone is not a revision: the drain's own label edits and status comment move it too. An issue is news only when
// something other than the drain changed it since the revision last recorded for that issue.
import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import * as os from "node:os"
import * as path from "node:path"
import { deskFailure } from "./desk-failure.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"

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
const LOCK_STALE_MS = 15 * 60_000
const MAX_TITLES = 20
const PAGE = 100
/** A full listing of the open issues is read again this often; between them only issues updated since the last change are read. */
const FULL_SYNC_MS = 3_600_000
/** The list is read from a little before the newest change it knew, so an update GitHub lists late is still seen. */
const DELTA_SLACK_MS = 120_000
const LOGIN_MS = 24 * 3_600_000
/** At or below this many calls left in the window a drain stops polling until the window resets. */
const QUOTA_RESERVE = 25
/** Below 10% of the window or this many calls (whichever is more), a drain polls at most every `QUOTA_SLOW_MS`. */
const QUOTA_LOW = 200
const QUOTA_SLOW_MS = 15 * 60_000

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
    const { repo, session, account, ignoredBodyTrailers, ignoredLabels, ignoreLabels, ignoreComments } = entry
    if (typeof repo !== "string" || !/^[\w.-]+\/[\w.-]+$/u.test(repo)) throw bad(`drains[${index}].repo is not "owner/name"`)
    if (!isText(session)) throw bad(`drains[${index}].session is not a session id`)
    if (account !== undefined && !isText(account)) throw bad(`drains[${index}].account is not a GitHub login`)
    if (ignoredBodyTrailers !== undefined && (!textList(ignoredBodyTrailers) || ignoredBodyTrailers.some((key) => key.includes(":")))) throw bad(`drains[${index}].ignoredBodyTrailers is not a list of trailer keys such as "Active-at"`)
    if (ignoredLabels !== undefined && !textList(ignoredLabels)) throw bad(`drains[${index}].ignoredLabels is not a list of label names such as "agent:drain"`)
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
  const shown = events.slice(0, MAX_TITLES).map((event) => `#${event.number} ${oneLine(event.title)}${event.why ? ` (${event.why})` : ""}`)
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

/** A comment a drain's `ignoreComments` rule skips: written by the rule's author (case-insensitive) and, when the rule has a `match`, a body that matches it. */
const ignoredComment = (comment, rules) => rules.some((rule) => comment.user?.login?.toLowerCase() === rule.author && (rule.match === null || rule.match.test(comment.body ?? "")))

const isBot = (comment) => comment.user?.type === "Bot" || (comment.user?.login ?? "").toLowerCase().endsWith("[bot]")

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
async function repeatsPrevious(api, repo, issue, comment, all) {
  const everything = (all.list ??= await api.comments(repo, issue.number, "1970-01-01T00:00:00Z"))
  const author = comment.user?.login?.toLowerCase()
  const previous = everything.filter((entry) => entry.user?.login?.toLowerCase() === author && entry.id !== comment.id && entry.created_at < comment.created_at).sort((a, b) => a.created_at.localeCompare(b.created_at)).at(-1)
  return previous !== undefined && repeatableText(previous.body) === repeatableText(comment.body)
}

const isDrainLabel = (event) => (event.event === "labeled" || event.event === "unlabeled") && (event.label?.name ?? "").toLowerCase().startsWith(DRAIN_LABEL_PREFIX)

/** A label or state change by the polling account while the drain was working: after a wake's delivery and before its turn ran out. The drain does its work through that account, whatever label it touches. */
const duringTurn = (event, login, turns) => {
  const at = Date.parse(event.created_at)
  return event.actor?.login?.toLowerCase() === login.toLowerCase() && turns.some((from) => at >= from - TURN_LEAD_MS && at <= from + TURN_MS)
}

/** What made a reopen or a label change news, or null: a label outside the drain's namespace, ignored list and ignored patterns, or a reopen that is not the drain claiming the issue (its own `drain:` label change within a minute). A label or reopen by the polling account during the drain's turn is its own work. Closes, assignments and mentions are not news. */
function newsEvent(event, rules, claims, login) {
  if (event.event === "reopened") {
    const own = event.actor?.login?.toLowerCase() === login.toLowerCase() && claims.some((claim) => claim.actor?.login?.toLowerCase() === login.toLowerCase() && Math.abs(Date.parse(claim.created_at) - Date.parse(event.created_at)) <= CLAIM_SLACK_MS)
    return own || duringTurn(event, login, rules.turns) ? null : "reopened"
  }
  if (event.event !== "labeled" && event.event !== "unlabeled") return null
  const name = (event.label?.name ?? "").toLowerCase()
  const ignored = name.startsWith(DRAIN_LABEL_PREFIX) || rules.labels.includes(name) || rules.patterns.some((pattern) => pattern.test(name))
  return ignored || duringTurn(event, login, rules.turns) ? null : `${event.event} ${name}`
}

/** An issue the drain filed or already triaged: a label in its `drain:` namespace, or its status marker in the body, is there before the poll first sees it, so it is already seen. */
const filedByDrain = (issue) => (issue.labels ?? []).some((label) => (label?.name ?? "").toLowerCase().startsWith(DRAIN_LABEL_PREFIX)) || (issue.body ?? "").includes(DRAIN_STATUS_MARKER)

/** What someone but the drain changed since `before` (a new issue, an edit, another comment, a reopen or a label outside the drain's own), or null. The reason travels with the event. */
async function changedByOthers(api, repo, issue, before, digest, ignored, rules) {
  if (!before) return filedByDrain(issue) ? null : "new issue"
  if (before.digest && (before.ignored ?? "") === ignored && before.digest !== digest) return "title or body edited"
  const since = before.updatedAt
  const comments = (await api.comments(repo, issue.number, since)).filter((comment) => comment.updated_at > since)
  const all = {}
  for (const entry of comments) {
    if (ownStatus(entry, api.login) || ignoredComment(entry, rules.comments) || (isBot(entry) && (await repeatsPrevious(api, repo, issue, entry, all)))) continue
    return `comment ${entry.id} by ${entry.user?.login ?? "nobody"}`
  }
  const feed = await api.issueEvents(repo, issue.number)
  const claims = feed.filter(isDrainLabel)
  const news = feed.filter((event) => event.created_at > since).map((event) => newsEvent(event, rules, claims, api.login)).find(Boolean)
  return news ?? (await crossReference(api, repo, issue, since))
}

const DRAIN_BRANCH_PREFIXES = ["drain-", "drain/"]
const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")

/** Whether a cross-reference's source is the drain's own work: a marked body, a pull request on a `drain-` or `drain/` branch, the drain's marked comment on this issue that names the source, or its marked comment on the source that names this issue around then. */
async function selfCaused(api, repo, issue, event) {
  const source = event.source?.issue ?? {}
  if ((source.body ?? "").includes(DRAIN_STATUS_MARKER)) return true
  const where = source.repository_url?.replace(/^.*\/repos\//u, "") ?? repo
  if (source.pull_request) {
    const pull = await api.pull(where, source.number).catch(() => null)
    if (DRAIN_BRANCH_PREFIXES.some((prefix) => String(pull?.head?.ref ?? "").startsWith(prefix))) return true
  }
  // The drain's marked status comment on this issue names the source: the link between an issue and the pull request the drain opened for it.
  const ref = `${escapePattern(where)}(?:#|/(?:pull|issues)/)${source.number}(?!\\d)`
  const mention = new RegExp(where === repo ? `(?:^|[^\\w/])#${source.number}(?!\\d)|${ref}` : ref, "u")
  const here = await api.comments(repo, issue.number, "1970-01-01T00:00:00Z").catch(() => [])
  if (here.some((comment) => ownStatus(comment, api.login) && mention.test(comment.body))) return true
  const names = new RegExp(`#${issue.number}(?!\\d)|/${escapePattern(repo)}/issues/${issue.number}(?!\\d)`, "u")
  const at = Date.parse(event.created_at)
  const comments = await api.comments(where, source.number, "1970-01-01T00:00:00Z").catch(() => [])
  return comments.some((comment) => ownStatus(comment, api.login) && names.test(comment.body) && [comment.created_at, comment.updated_at].some((time) => Math.abs(at - Date.parse(time)) <= CROSS_REFERENCE_SLACK_MS))
}

/** An issue whose `updated_at` moved with nothing else news: a cross-reference that is not the drain's own work is, and says where from. */
async function crossReference(api, repo, issue, since) {
  const events = (await api.timeline(repo, issue.number)).filter((event) => event.event === "cross-referenced" && event.created_at > since)
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
  state.etag = changed.etag ? { since, tag: changed.etag } : undefined
  return { full: false, issues: changed.issues }
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
  try {
    const knownLogin = state.loginAt && now - Date.parse(state.loginAt) < LOGIN_MS ? state.login : undefined
    api = await connect(drain.account, { login: knownLogin })
    if (!knownLogin) {
      state.login = api.login
      state.loginAt = new Date(now).toISOString()
    }
    const listed = await listIssues(api, drain, state, now)
    if (!listed.untouched) await recordChanges(api, drain, state, listed, { now, desk })
    state.lastOkAt = new Date(now).toISOString()
    delete state.lastError
  } catch (error) {
    state.lastError = error.message
  }
  const quota = api?.quota?.()
  if (quota) state.quota = quota
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
    seen[key] = { updatedAt: issue.updated_at, digest, ...(ignored ? { ignored } : {}) }
    if (!state.seeded || before?.updatedAt === issue.updated_at) continue
    const why = await changedByOthers(api, drain.repo, issue, before, digest, ignored, rules)
    if (why) recorded.push({ number: issue.number, title: issue.title, updatedAt: issue.updated_at, seenAt: new Date(now).toISOString(), why })
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
  if (cursor) state.cursor = cursor
  if (full) state.syncedAt = new Date(now).toISOString()
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
    const head = `issue drain ${drain.repo} -> ${drain.session.slice(0, 8)}`
    if (!state?.lastPollAt) return `${head}: not polled yet${state?.hold ? `, held: ${state.hold}` : ""}`
    const ok = lastOk(state)
    const good = ok ? `last ok poll ${ok} (lag ${span(now - Date.parse(ok))})` : "no ok poll recorded"
    const since = state.pending.map((event) => Date.parse(event.seenAt)).filter(Number.isFinite)
    const waiting = `${state.pending.length} waiting${since.length ? ` (oldest ${span(now - Math.min(...since))})` : ""}`
    const wake = state.lastWakeAt ? `${ago(state.lastWakeAt, now)} (${state.lastWakeCount} issue${state.lastWakeCount === 1 ? "" : "s"})` : "never"
    return `${head}: ${good}, polled ${ago(state.lastPollAt, now)}, ${state.openCount ?? "?"} open, ${waiting}, last wake ${wake}${state.hold ? `, held: ${state.hold}` : ""}${state.lastError ? `, last error: ${state.lastError}` : ""}`
  })]
}

/**
 * Poll every configured drain once. The markers and events are written before this returns, so a wake that is never delivered
 * stays pending and comes back with the next poll. Repositories dropped from the config lose their state.
 * Each wake carries `done`, the command that reports its delivery: the runner appends `--error <text>` when delivery failed.
 */
export async function pollDrains({ paths, connect, now, ackCommand, ackFlags = [], desk }) {
  const drains = readDrainConfig(paths.config)
  const stored = readDrainStates(paths.state)
  const states = Object.fromEntries(drains.map((drain) => [drain.repo, stored[drain.repo] ?? blank()]))
  for (const drain of drains) {
    const hold = quotaHold(freshestQuota(drains, states, drain.account), states[drain.repo].lastPollAt, now)
    if (hold) Object.assign(states[drain.repo], { hold, calls: { total: 0, notModified: 0 } })
    else await pollDrain(drain, states, { connect, now, desk })
  }
  writeDrainStates(paths.state, states)
  const wakes = drains.filter((drain) => states[drain.repo].pending.length > 0).map((drain) => {
    const events = states[drain.repo].pending
    const id = wakeId(drain.repo, events)
    return { id, repo: drain.repo, session: drain.session, message: wakeMessage(drain.repo, events), events, done: [...ackCommand, "ack", "--repo", drain.repo, "--wake", id, ...ackFlags] }
  })
  const errors = drains.filter((drain) => states[drain.repo].lastError).map((drain) => ({ repo: drain.repo, error: states[drain.repo].lastError }))
  const calls = drains.reduce((sum, drain) => sum + states[drain.repo].calls.total, 0)
  return { at: new Date(now).toISOString(), wakes, errors, calls, status: drainStatusLines(drains, states, now) }
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
    state.turns = [...(state.turns ?? []), state.lastWakeAt].filter((at) => now - Date.parse(at) <= 2 * TURN_MS).slice(-TURNS_KEPT)
    state.pending = []
  }
  writeDrainStates(paths.state, states)
  return { ok: true, changed: true, reason: error ? "recorded the failed delivery; the events stay waiting" : "cleared the delivered events" }
}

// ── GitHub ──

/** The drain's GitHub access: its account's token from the `gh` CLI, then the REST API. `login` skips asking GitHub who the token is. */
export async function connectGithub(account, { spawn = spawnSync, fetchImpl = fetch, env = process.env, login: knownLogin } = {}) {
  const tokenArgs = ["auth", "token", "--hostname", "github.com", ...(account ? ["--user", account] : [])]
  const cleaned = { ...env, PATH: ["/opt/homebrew/bin", "/usr/local/bin", env.PATH].filter(Boolean).join(":") }
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GH_HOST"]) delete cleaned[name]
  const result = spawn("gh", tokenArgs, { encoding: "utf8", timeout: 10_000, env: cleaned, windowsHide: true })
  const token = result.status === 0 ? String(result.stdout ?? "").trim() : ""
  if (!token) throw Object.assign(new Error(`Sign in the GitHub CLI: the GitHub CLI has no token for ${account ?? "its active account"} (run \`gh auth login --hostname github.com\`)`), { code: "drains_sign_in_the_github_cli" })
  // What this connection spent and what GitHub says is left in the account's window; a 304 answer costs nothing against it.
  const meter = { total: 0, notModified: 0, quota: null }
  const get = async (route, { etag } = {}) => {
    const response = await fetchImpl(`https://api.github.com${route}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "desk-issue-drains", ...(etag ? { "If-None-Match": etag } : {}) },
      signal: AbortSignal.timeout(30_000),
    })
    meter.total += 1
    const remaining = response.headers.get("x-ratelimit-remaining")
    if (remaining !== null) meter.quota = { remaining: Number(remaining), limit: Number(response.headers.get("x-ratelimit-limit")), reset: Number(response.headers.get("x-ratelimit-reset")), at: new Date().toISOString() }
    if (response.status === 304) {
      meter.notModified += 1
      return { notModified: true }
    }
    if (!response.ok) throw Object.assign(new Error(`Check gh auth status, then try again: GitHub answered HTTP ${response.status} for ${route.split("?")[0]}`), { code: "drains_check_gh_auth_status_then" })
    return { body: await response.json(), next: /rel="next"/u.test(response.headers.get("link") ?? ""), etag: response.headers.get("etag") }
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
  // Who the token really is decides which comments are the drain's own, so each drain's account is resolved from the token that polls its repository.
  const login = knownLogin || (await get("/user").then(({ body }) => String(body.login ?? ""), () => "")) || account || ""
  return {
    login,
    openIssues: async (repo) => (await all(`/repos/${repo}/issues?state=open&sort=updated&direction=desc`)).filter((issue) => !issue.pull_request),
    comments: (repo, issue, since) => all(`/repos/${repo}/issues/${issue}/comments?since=${encodeURIComponent(since)}`),
    issueEvents: (repo, issue) => all(`/repos/${repo}/issues/${issue}/events`),
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
    quota: () => meter.quota,
    calls: () => ({ total: meter.total, notModified: meter.notModified }),
    timeline: (repo, issue) => all(`/repos/${repo}/issues/${issue}/timeline`),
    pull: async (repo, number) => (await get(`/repos/${repo}/pulls/${number}`)).body,
  }
}
