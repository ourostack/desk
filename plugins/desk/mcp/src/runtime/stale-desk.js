// A stale-Desk warning for boot. Hosts cache plugin downloads (Agency keeps them for 24 hours), so a session can run a Desk
// that is many releases behind the one on `main` and a fixed bug still looks unfixed. Boot compares the running plugin's
// version with the one on `main` and, only when it is behind, prints one line and fills one JSON field.
//
// It must never slow or break boot: the lookup starts in parallel with the rest of boot, gets a hard budget, caches the
// answer in Desk's state directory for an hour, sends no credentials and says nothing on any error, timeout or offline
// machine. It stays off in a node:test run (unless a test hands it its own fetch) and when DESK_BOOT_VERSION_CHECK is 0.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest, looksLikeNodeTestRunner } from "./test-state-guard.js"

export const LATEST_PLUGIN_URL = "https://raw.githubusercontent.com/ourostack/desk/main/plugins/desk/plugin.json"
const VERSION_FETCH_BUDGET_MS = 1500
export const VERSION_CACHE_TTL_MS = 60 * 60 * 1000
// A failed lookup is remembered briefly, so an offline machine does not retry on every boot.
export const VERSION_FAILURE_TTL_MS = 10 * 60 * 1000
export const VERSION_CACHE_FILE = "latest-version.json"
const VERSION_CHECK_SWITCH = "DESK_BOOT_VERSION_CHECK"

export const AGENCY_CACHE_COMMAND = 'agency plugin cache remove "copilot:github:ourostack/desk:plugins/desk@main"'

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/u

const MAX_VERSION_LENGTH = 64
const MAX_RESPONSE_BYTES = 4096

const isNumeric = (id) => /^\d+$/u.test(id)

/** `{ core: [major, minor, patch], pre: [identifiers] }` for a semver string of at most 64 characters whose numbers all fit a safe integer, or null. */
export function parseVersion(text) {
  const match = typeof text === "string" && text.length <= MAX_VERSION_LENGTH ? SEMVER.exec(text.trim()) : null
  if (match === null) return null
  const core = [Number(match[1]), Number(match[2]), Number(match[3])]
  const pre = match[4] === undefined ? [] : match[4].split(".")
  if (core.some((n) => n > Number.MAX_SAFE_INTEGER) || pre.some((id) => isNumeric(id) && Number(id) > Number.MAX_SAFE_INTEGER)) return null
  return { core, pre }
}

/** Semver precedence: negative when `a` is older than `b`, 0 when equal, positive when newer; null when either is not semver. */
export function compareVersions(a, b) {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (left === null || right === null) return null
  for (let i = 0; i < 3; i += 1) if (left.core[i] !== right.core[i]) return left.core[i] < right.core[i] ? -1 : 1
  // A release outranks any prerelease of the same core.
  if (left.pre.length === 0 || right.pre.length === 0) return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i += 1) {
    const x = left.pre[i]
    const y = right.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    if (x === y) continue
    if (isNumeric(x) && isNumeric(y)) return Number(x) < Number(y) ? -1 : 1
    if (isNumeric(x)) return -1
    if (isNumeric(y)) return 1
    return x < y ? -1 : 1
  }
  return 0
}

/**
 * How many releases `running` is behind `latest`, only when that is reliable: the same major.minor.patch and the same
 * single-word prerelease line with a numeric counter (`3.2.0-alpha.153` to `3.2.0-alpha.172` is 19; each release bumps
 * the counter by one). Anything else is null, and the line says only "behind".
 */
export function releasesBehind(running, latest) {
  const a = parseVersion(running)
  const b = parseVersion(latest)
  if (a === null || b === null || a.core.join(".") !== b.core.join(".")) return null
  if (a.pre.length !== 2 || b.pre.length !== 2 || a.pre[0] !== b.pre[0] || !isNumeric(a.pre[1]) || !isNumeric(b.pre[1])) return null
  const gap = Number(b.pre[1]) - Number(a.pre[1])
  return gap > 0 ? gap : null
}

/** What to do about it on each host. Agency is not detected: a Copilot session may run directly or through Agency, so both are named. */
export function refreshStep(agentHost) {
  if (agentHost === "claude") return "update it with /plugin, then start a new session"
  if (agentHost === "copilot") return `run copilot plugin update desk, or, if Agency launched this session, run ${AGENCY_CACHE_COMMAND}; then start a new session`
  return "update the Desk plugin in this host, then start a new session"
}

/** "19 releases behind" when the count is reliable, otherwise "behind". */
export function behindText(behind) {
  return behind === null ? "behind" : `${behind} release${behind === 1 ? "" : "s"} behind`
}

/** The warning as `{ running, latest, behind, channel, refresh, auto_refresh, line }`, or null when `running` is not behind `latest`. */
export function staleDeskFinding({ running, latest, agentHost }) {
  const order = compareVersions(running, latest)
  if (order === null || order >= 0) return null
  const behind = releasesBehind(running, latest)
  const refresh = refreshStep(agentHost)
  return {
    running,
    latest,
    behind,
    channel: "main",
    refresh,
    auto_refresh: null,
    line: `Desk ${running} is ${behindText(behind)} main (${latest}); ${refresh}.`,
  }
}

function readRunningVersion(pluginRoot) {
  try {
    const version = JSON.parse(readFileSync(path.join(pluginRoot, "plugin.json"), "utf8")).version
    return parseVersion(version) === null ? null : version
  } catch {
    return null
  }
}

function readCache(file, now) {
  try {
    const cached = JSON.parse(readFileSync(file, "utf8"))
    const age = now() - Date.parse(cached.checked_at)
    if (!(age >= 0)) return undefined
    if (cached.latest === null) return age < VERSION_FAILURE_TTL_MS ? null : undefined
    return typeof cached.latest === "string" && parseVersion(cached.latest) !== null && age < VERSION_CACHE_TTL_MS ? cached.latest : undefined
  } catch {
    return undefined
  }
}

function writeCache(stateDir, file, latest, now, env) {
  try {
    assertNotRealStateUnderTest(stateDir, { env })
    mkdirSync(stateDir, { recursive: true, mode: 0o700 })
    const temp = `${file}.${process.pid}.tmp`
    writeFileSync(temp, `${JSON.stringify({ schema_version: 1, checked_at: new Date(now()).toISOString(), latest })}\n`, { mode: 0o600 })
    renameSync(temp, file)
  } catch {
    // A cache that cannot be written only costs a second lookup.
  }
}

// The one request: no headers beyond the default, so no credential can ride along, and a hard abort at the budget.
async function fetchLatest(fetchFn, budgetMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), budgetMs)
  try {
    const response = await fetchFn(LATEST_PLUGIN_URL, { signal: controller.signal, redirect: "follow", credentials: "omit" })
    if (!response.ok) return null
    const body = await response.text()
    if (body.length > MAX_RESPONSE_BYTES) return null
    const version = JSON.parse(body).version
    return parseVersion(version) === null ? null : version
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The stale-Desk finding for this boot, or null. Never rejects (every step handles its own errors) and never takes longer than `budgetMs` (a cached answer
 * takes no time). `fetchFn` is for tests; passing one also lifts the node:test off switch.
 */
export async function checkStaleDesk({ env, pluginRoot, agentHost, now = Date.now, fetchFn, budgetMs = VERSION_FETCH_BUDGET_MS, stateDir }) {
  if (String(env[VERSION_CHECK_SWITCH] ?? "").trim() === "0") return null
  if (fetchFn === undefined && looksLikeNodeTestRunner(env)) return null
  const running = readRunningVersion(pluginRoot)
  if (running === null) return null
  const dir = stateDir ?? resolveDeskStateDir({ env })
  const file = path.join(dir, VERSION_CACHE_FILE)
  let latest = readCache(file, now)
  if (latest === undefined) {
    // The race is a second guard: a fetch that ignores the abort signal still cannot hold boot past the budget.
    let timer
    const hard = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), budgetMs + 100)
    })
    // istanbul ignore next -- outside a node:test run the real fetch is used; every test hands its own.
    const doFetch = fetchFn ?? globalThis.fetch
    latest = await Promise.race([fetchLatest(doFetch, budgetMs), hard]).finally(() => clearTimeout(timer))
    writeCache(dir, file, latest, now, env)
  }
  return latest === null ? null : staleDeskFinding({ running, latest, agentHost })
}
