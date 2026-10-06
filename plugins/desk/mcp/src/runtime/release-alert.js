// The release alert for boot: when the bound desk is working on ourostack/desk and that repo's release workflow has an open
// "Desk release needs attention" issue, boot says so in one line (jidoka: a failed release stops the line where the agent
// can see it, instead of waiting for someone to look at GitHub). A merged Desk pull request is delivered only when a release
// carries it, and an open issue means the last release did not publish.
//
// Scope: only a desk with an open task card that names ourostack/desk is asked, because only that repo's workflow opens
// this issue; other repos declare their delivery in `.desk/delivery.json` (see `tools/release-gate.js`) and have no alert yet.
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
export const RELEASE_ISSUES_URL = `https://api.github.com/repos/${RELEASE_REPO}/issues?state=open&per_page=50`
export const RELEASE_ALERT_BUDGET_MS = 1500
export const RELEASE_ALERT_TTL_MS = 10 * 60 * 1000
export const RELEASE_ALERT_CACHE_FILE = "release-alert.json"
export const RELEASE_ALERT_SWITCH = "DESK_BOOT_RELEASE_CHECK"
export const MAX_RESPONSE_BYTES = 512 * 1024

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

function readCache(file, now) {
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"))
    const age = now() - Date.parse(cached.checked_at)
    if (!(age >= 0 && age < RELEASE_ALERT_TTL_MS)) return undefined
    if (cached.alert === null) return null
    return Number.isSafeInteger(cached.alert?.number) && typeof cached.alert.url === "string" ? cached.alert : undefined
  } catch {
    return undefined
  }
}

function writeCache(stateDir, file, alert, now, env) {
  try {
    assertNotRealStateUnderTest(stateDir, { env })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ schema_version: 1, checked_at: new Date(now()).toISOString(), alert })}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // A cache that cannot be written only costs a second lookup.
  }
}

// One anonymous request (no credential can ride along) with a hard abort at the budget. Null on any failure, `{ none: true }` for no open issue.
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
    const issue = issues.find((item) => item?.title === RELEASE_ISSUE_TITLE && item.pull_request === undefined && Number.isSafeInteger(item.number) && typeof item.html_url === "string")
    return issue === undefined ? { none: true } : { number: issue.number, url: issue.html_url }
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * `{ number, url, line }` for the open release issue, or null. Never rejects and never takes longer than `budgetMs` (a cached answer takes no time).
 * `cards` are boot's task cards; a desk with no open task on ourostack/desk makes no request. `fetchFn` is for tests; passing one also lifts the node:test off switch.
 */
export async function checkReleaseAlert({ env, cards, now = Date.now, fetchFn, budgetMs = RELEASE_ALERT_BUDGET_MS, stateDir }) {
  if (String(env[RELEASE_ALERT_SWITCH] ?? "").trim() === "0") return null
  if (fetchFn === undefined && looksLikeNodeTestRunner(env)) return null
  if (!workingOnDesk(cards)) return null
  const dir = stateDir ?? resolveDeskStateDir({ env })
  const file = path.join(dir, RELEASE_ALERT_CACHE_FILE)
  let alert = readCache(file, now)
  if (alert === undefined) {
    let timer
    const hard = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs + 100)
    })
    // istanbul ignore next -- outside a node:test run the real fetch is used; every test hands its own.
    const doFetch = fetchFn ?? globalThis.fetch
    const found = await Promise.race([fetchAlert(doFetch, budgetMs), hard]).finally(() => clearTimeout(timer))
    // A failed lookup is remembered as "no alert" for the same ten minutes, so an offline boot stays quiet and cheap.
    alert = found === null || found.none === true ? null : found
    writeCache(dir, file, alert, now, env)
  }
  return alert === null ? null : { ...alert, line: releaseAlertLine(alert) }
}
