// The release alert for boot: when the bound desk is working on ourostack/desk and that repo's release workflow has an open
// "Desk release needs attention" issue, boot says so in one line (jidoka: a failed release stops the line where the agent
// can see it, instead of waiting for someone to look at GitHub). A merged Desk pull request is delivered only when a release
// carries it, and an open issue means the last release did not publish.
//
// The same one request also finds the open issues Desk filed about its own failures (label `desk-problem`, see the
// `desk-problem` skill), so the problem an agent never looked at reaches an agent: one line, oldest first, capped.
//
// Scope: only a desk with an open task card that names ourostack/desk is asked, because only that repo's workflow opens
// this issue; other repos declare their delivery in `.desk/delivery.json` (see `tools/delivery-gate.js`) and have no alert yet.
//
// It must never slow or break boot, the same contract as `stale-desk.js`: the lookup starts in parallel with the rest of boot,
// has a hard budget, caches its answer in Desk's state directory for ten minutes (an offline machine does not retry on every
// boot), sends no credentials and says nothing on any error, timeout or offline machine. It stays off in a node:test run
// (unless a test hands it its own fetch) and when DESK_BOOT_RELEASE_CHECK is 0.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest, looksLikeNodeTestRunner } from "./test-state-guard.js"

export const RELEASE_REPO = "ourostack/desk"
export const RELEASE_ISSUE_TITLE = "Desk release needs attention"
export const RELEASE_ISSUES_URL = `https://api.github.com/repos/${RELEASE_REPO}/issues?state=open&per_page=100`
export const RELEASE_ALERT_BUDGET_MS = 1500
export const RELEASE_ALERT_TTL_MS = 10 * 60 * 1000
export const RELEASE_ALERT_CACHE_FILE = "release-alert.json"
export const RELEASE_ALERT_SWITCH = "DESK_BOOT_RELEASE_CHECK"
export const MAX_RESPONSE_BYTES = 512 * 1024
// The label Desk files its own failures under (`LABEL` in `factory/desk-problem-file.js`, which a test keeps equal; not imported so boot stays light).
export const DESK_PROBLEM_LABEL = "desk-problem"
export const MAX_LISTED_PROBLEMS = 3
const DAY_MS = 24 * 60 * 60 * 1000

const TERMINAL = new Set(["done", "cancelled"])
const DESK_REPO = /(?:^|[/:])ourostack\/desk(?:\.git)?(?:[/?#].*)?$/iu

const namesDesk = (entry) =>
  typeof entry === "string" ? DESK_REPO.test(entry.trim()) : entry !== null && typeof entry === "object" && [entry.name, entry.url].some((value) => typeof value === "string" && DESK_REPO.test(value.trim()))

/** True when some open task card (any status but done or cancelled) records ourostack/desk among its repos, by name or url. */
export function workingOnDesk(cards) {
  return cards.some((card) => !TERMINAL.has(card?.data?.status) && Array.isArray(card?.data?.repos) && card.data.repos.some(namesDesk))
}

/** The line for an open issue: what it means for the work in hand and where to read it. */
export function releaseAlertLine({ number, url }) {
  return `Desk release needs attention: ${RELEASE_REPO}#${number} is open (${url}). The last Desk release did not publish, so merged Desk pull requests are not delivered until it clears; read it before saying a Desk change has shipped.`
}

const days = (count) => (count === 0 ? "today" : `${count} ${count === 1 ? "day" : "days"}`)

/** The line for the open `desk-problem` issues (oldest first, at most MAX_LISTED_PROBLEMS named, the rest counted). */
export function deskProblemsLine({ count, issues }) {
  const named = issues.map((issue) => `#${issue.number} (${days(issue.age_days)})`).join(", ")
  const more = count > issues.length ? `, +${count - issues.length} more` : ""
  return `Desk problems open on ${RELEASE_REPO}: ${named}${more}; take the oldest through desk-problem`
}

// `{ count, oldest_days, issues:[{number,url,age_days}], line }` from the cached open problems (oldest first), or null when there are none.
function describeProblems(problems, now) {
  if (problems.length === 0) return null
  const issues = problems.slice(0, MAX_LISTED_PROBLEMS).map(({ number, url, created_at }) => ({ number, url, age_days: Math.max(0, Math.floor((now() - Date.parse(created_at)) / DAY_MS)) }))
  const summary = { count: problems.length, oldest_days: issues[0].age_days, issues }
  return { ...summary, line: deskProblemsLine(summary) }
}

const validProblem = (item) => Number.isSafeInteger(item?.number) && typeof item.url === "string" && Number.isFinite(Date.parse(item.created_at))

function readCache(file, now) {
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"))
    const age = now() - Date.parse(cached.checked_at)
    if (!(age >= 0 && age < RELEASE_ALERT_TTL_MS)) return undefined
    if (!Array.isArray(cached.problems) || !cached.problems.every(validProblem)) return undefined
    if (cached.alert === null) return { alert: null, problems: cached.problems }
    return Number.isSafeInteger(cached.alert?.number) && typeof cached.alert.url === "string" ? { alert: cached.alert, problems: cached.problems } : undefined
  } catch {
    return undefined
  }
}

function writeCache(stateDir, file, found, now, env) {
  try {
    assertNotRealStateUnderTest(stateDir, { env })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ schema_version: 2, checked_at: new Date(now()).toISOString(), alert: found.alert, problems: found.problems })}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // A cache that cannot be written only costs a second lookup.
  }
}

// One anonymous request (no credential can ride along) with a hard abort at the budget. Null on any failure; otherwise the release issue (or null) and the open `desk-problem` issues, oldest first.
async function fetchAlert(fetchFn, budgetMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    const response = await fetchFn(RELEASE_ISSUES_URL, { signal: controller.signal, redirect: "follow", credentials: "omit", headers: { Accept: "application/vnd.github+json", "User-Agent": "desk-boot" } })
    if (!response.ok) return null
    const body = await response.text()
    if (body.length > MAX_RESPONSE_BYTES) return null
    const issues = JSON.parse(body)
    if (!Array.isArray(issues)) return null
    const real = issues.filter((item) => item?.pull_request === undefined && Number.isSafeInteger(item?.number) && typeof item.html_url === "string")
    const release = real.find((item) => item.title === RELEASE_ISSUE_TITLE)
    const problems = real
      .filter((item) => Array.isArray(item.labels) && item.labels.some((label) => (label?.name ?? label) === DESK_PROBLEM_LABEL) && Number.isFinite(Date.parse(item.created_at)))
      .map((item) => ({ number: item.number, url: item.html_url, created_at: item.created_at }))
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at) || a.number - b.number)
    return { alert: release === undefined ? null : { number: release.number, url: release.html_url }, problems }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `{ release_alert, desk_problems }`: `release_alert` is `{ number, url, line }` for the open release issue, `desk_problems` is
 * `{ count, oldest_days, issues, line }` for the open `desk-problem` issues; each is null when there is nothing to say. Never rejects and never
 * takes longer than `budgetMs` (a cached answer takes no time). `cards` are boot's task cards; a desk with no open task on ourostack/desk makes
 * no request. `fetchFn` is for tests; passing one also lifts the node:test off switch.
 */
export async function checkReleaseAlert({ env, cards, now = Date.now, fetchFn, budgetMs = RELEASE_ALERT_BUDGET_MS, stateDir }) {
  const quiet = { release_alert: null, desk_problems: null }
  if (String(env[RELEASE_ALERT_SWITCH] ?? "").trim() === "0") return quiet
  if (fetchFn === undefined && looksLikeNodeTestRunner(env)) return quiet
  if (!workingOnDesk(cards)) return quiet
  const dir = stateDir ?? resolveDeskStateDir({ env })
  const file = path.join(dir, RELEASE_ALERT_CACHE_FILE)
  let found = readCache(file, now)
  if (found === undefined) {
    let timer
    const hard = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs + 100)
    })
    // istanbul ignore next -- outside a node:test run the real fetch is used; every test hands its own.
    const doFetch = fetchFn ?? globalThis.fetch
    const fetched = await Promise.race([fetchAlert(doFetch, budgetMs), hard]).finally(() => clearTimeout(timer))
    // A failed lookup is remembered as "nothing to say" for the same ten minutes, so an offline boot stays quiet and cheap.
    found = fetched ?? { alert: null, problems: [] }
    writeCache(dir, file, found, now, env)
  }
  return { release_alert: found.alert === null ? null : { ...found.alert, line: releaseAlertLine(found.alert) }, desk_problems: describeProblems(found.problems, now) }
}
