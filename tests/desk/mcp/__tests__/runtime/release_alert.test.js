// Boot's release alert: one line when ourostack/desk's release issue is open and the desk is working on that repo; cached, bounded, silent offline.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import {
  RELEASE_ALERT_CACHE_FILE,
  RELEASE_ALERT_TTL_MS,
  RELEASE_ISSUES_URL,
  RELEASE_ISSUE_TITLE,
  checkReleaseAlert,
  releaseAlertLine,
  workingOnDesk,
} from "../../../../../plugins/desk/mcp/src/runtime/release-alert.js"

const onDesk = [{ data: { status: "validating", repos: [{ name: "ourostack/desk" }] } }]
const issue = { number: 207, title: RELEASE_ISSUE_TITLE, html_url: "https://github.com/ourostack/desk/issues/207" }
const answering = (issues, calls = []) => async (url, init) => {
  calls.push({ url, init })
  return { ok: true, text: async () => JSON.stringify(issues) }
}
const stateDir = () => mkTempRoot("desk-release-alert-")

test("only an open task that names ourostack/desk counts as working on it", () => {
  assert.equal(workingOnDesk(onDesk), true)
  assert.equal(workingOnDesk([{ data: { status: "done", repos: ["ourostack/desk"] } }]), false)
  assert.equal(workingOnDesk([{ data: { status: "cancelled", repos: ["ourostack/desk"] } }]), false)
  assert.equal(workingOnDesk([{ data: { status: "processing", repos: ["ourostack/desk"] } }]), true)
  assert.equal(workingOnDesk([{ data: { repos: [{ name: "desk", url: "git@github.com:ourostack/desk.git" }] } }]), true)
  assert.equal(workingOnDesk([{ data: { repos: [{ url: "https://github.com/ourostack/desk" }] } }]), true)
  assert.equal(workingOnDesk([{ data: { repos: ["ourostack/desk-extras", "ourostack/other", { name: 4 }, null, { name: "x/desk" }] } }]), false)
  assert.equal(workingOnDesk([{ data: { repos: "ourostack/desk" } }, { data: {} }, {}, null]), false)
  assert.equal(workingOnDesk([]), false)
})

test("an open release issue gives the line, the URL and the number", async () => {
  const calls = []
  const found = await checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering([{ number: 3, title: "other", html_url: "x" }, issue], calls), stateDir: await stateDir() })
  assert.deepEqual(found, { number: 207, url: issue.html_url, line: releaseAlertLine({ number: 207, url: issue.html_url }) })
  assert.match(found.line, /^Desk release needs attention: ourostack\/desk#207 is open \(https:\/\/github\.com\/ourostack\/desk\/issues\/207\)\./u)
  assert.equal(calls[0].url, RELEASE_ISSUES_URL)
  assert.equal(calls[0].init.headers.Authorization, undefined, "no credential rides along")
  assert.equal(calls[0].init.credentials, "omit")
})

test("no open release issue, a pull request with that title and malformed answers all give no alert", async () => {
  const none = async (answer) => checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering(answer), stateDir: await stateDir() })
  assert.equal(await none([]), null)
  assert.equal(await none([{ ...issue, pull_request: {} }]), null)
  assert.equal(await none([{ ...issue, number: "7" }]), null)
  assert.equal(await none([{ ...issue, html_url: 4 }]), null)
  assert.equal(await none([null]), null)
  assert.equal(await none({ message: "rate limited" }), null)
})

test("a desk not working on ourostack/desk, the off switch and a bare node:test run make no request", async () => {
  const calls = []
  const fetchFn = answering([issue], calls)
  assert.equal(await checkReleaseAlert({ env: {}, cards: [], fetchFn, stateDir: await stateDir() }), null)
  assert.equal(await checkReleaseAlert({ env: { DESK_BOOT_RELEASE_CHECK: " 0 " }, cards: onDesk, fetchFn, stateDir: await stateDir() }), null)
  assert.equal(await checkReleaseAlert({ env: { NODE_TEST_CONTEXT: "child" }, cards: onDesk }), null)
  assert.equal(calls.length, 0)
})

test("the answer is cached for ten minutes, failures included", async () => {
  const dir = await stateDir()
  let clock = Date.parse("2026-10-06T12:00:00Z")
  const now = () => clock
  const calls = []
  const first = await checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering([issue], calls), stateDir: dir, now })
  assert.equal(first.number, 207)
  assert.equal(JSON.parse(readFileSync(path.join(dir, RELEASE_ALERT_CACHE_FILE), "utf8")).alert.number, 207)
  clock += RELEASE_ALERT_TTL_MS - 1
  assert.equal((await checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering([], calls), stateDir: dir, now })).number, 207)
  assert.equal(calls.length, 1)
  clock += 2
  assert.equal(await checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering([], calls), stateDir: dir, now }), null)
  assert.equal(calls.length, 2)
  // An offline lookup is remembered as quiet for the same time.
  clock += RELEASE_ALERT_TTL_MS + 1
  const offline = async () => { throw new Error("ENOTFOUND") }
  assert.equal(await checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: offline, stateDir: dir, now }), null)
  assert.equal(JSON.parse(readFileSync(path.join(dir, RELEASE_ALERT_CACHE_FILE), "utf8")).alert, null)
  assert.equal(await checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering([issue]), stateDir: dir, now }), null)
})

test("a damaged or future-dated cache is ignored", async () => {
  const dir = await stateDir()
  const file = path.join(dir, RELEASE_ALERT_CACHE_FILE)
  const fresh = async () => checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering([issue]), stateDir: dir, now: () => Date.parse("2026-10-06T12:00:00Z") })
  writeFileSync(file, "not json")
  assert.equal((await fresh()).number, 207)
  writeFileSync(file, JSON.stringify({ checked_at: "2099-01-01T00:00:00Z", alert: null }))
  assert.equal((await fresh()).number, 207)
  writeFileSync(file, JSON.stringify({ checked_at: "2026-10-06T12:00:00Z", alert: { number: "x" } }))
  assert.equal((await fresh()).number, 207)
})

test("a failed response, an oversized one and a hung one end quietly within the budget", async () => {
  const run = async (fetchFn, budgetMs = 50) => checkReleaseAlert({ env: {}, cards: onDesk, fetchFn, budgetMs, stateDir: await stateDir() })
  assert.equal(await run(async () => ({ ok: false })), null)
  assert.equal(await run(async () => ({ ok: true, text: async () => "x".repeat(600 * 1024) })), null)
  const started = Date.now()
  assert.equal(await run(() => new Promise(() => {}), 30), null)
  assert.ok(Date.now() - started < 1000)
})

test("a state folder that cannot be written only costs the cache", async () => {
  const dir = path.join(await stateDir(), "blocked")
  writeFileSync(dir, "a file where the folder should be")
  assert.equal((await checkReleaseAlert({ env: {}, cards: onDesk, fetchFn: answering([issue]), stateDir: dir })).number, 207)
  assert.equal(existsSync(path.join(dir, RELEASE_ALERT_CACHE_FILE)), false)
})

test("the default state folder comes from the environment", async () => {
  const home = await stateDir()
  const found = await checkReleaseAlert({ env: { HOME: home, XDG_STATE_HOME: path.join(home, "state") }, cards: onDesk, fetchFn: answering([issue]) })
  assert.equal(found.number, 207)
})

// ── in boot ─────────────────────────────────────────────────────────────────

const gh = async (args) => {
  if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
  if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: "github.com\n  \u2713 Logged in to github.com account ari (keyring)\n  - Active account: ari\n", stderr: "" }
  return { code: 1, stdout: "", stderr: "unexpected call" }
}
const jq = async () => ({ code: 0, stdout: "jq-1.7\n", stderr: "" })
const boot = async ({ env = {}, ...extra } = {}) => {
  const root = await mkTempRoot("desk-release-boot-")
  await mkdir(path.join(root, "_meta"), { recursive: true })
  await mkdir(path.join(root, "_archive"), { recursive: true })
  return bootOnce({
    env: { DESK: root, ...env }, cwd: root, homeDir: root, gh, jq,
    syncFn: async () => ({ state: "synced" }),
    factoryStatusFn: () => ({ store: null, source: "no_remote", consent: "held", stores: [], warnings: [] }),
    repoFn: () => ({ states: [], pending: [] }),
    staleDeskFn: async () => null,
    ...extra,
  })
}

test("boot prints the alert line under the status line and fills release_alert", async () => {
  const alert = { number: 207, url: issue.html_url, line: releaseAlertLine({ number: 207, url: issue.html_url }) }
  let seen
  const result = await boot({ releaseAlertFn: async (args) => { seen = args; return alert } })
  assert.deepEqual(result.release_alert, alert)
  assert.ok(Array.isArray(seen.cards) && typeof seen.now === "function")
  const lines = formatBootText(result).split("\n")
  assert.match(lines[0], /^Desk boot: /u)
  assert.equal(lines[1], alert.line)
})

test("boot adds nothing when there is no alert, and a throwing lookup never fails it", async () => {
  const quiet = await boot({ releaseAlertFn: async () => null })
  assert.equal(quiet.release_alert, null)
  assert.doesNotMatch(formatBootText(quiet), /Desk release needs attention/u)
  const broken = await boot({ releaseAlertFn: async () => { throw new Error("boom") } })
  assert.equal(broken.release_alert, null)
  assert.equal(broken.boot_complete, true)
})

test("a headless factory session asks nothing", async () => {
  let asked = false
  const result = await boot({ env: { DESK_FACTORY_HEADLESS: "1" }, releaseAlertFn: async () => { asked = true; return null } })
  assert.equal(asked, false)
  assert.equal(result.release_alert, null)
})
