// Boot's release alert: one line when ourostack/desk's release issue is open and the desk is working on that repo; cached, bounded, silent offline.
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { bootOnce } from "../../../../../plugins/desk/mcp/src/runtime/boot.js"
import { LABEL } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-file.js"
import { formatBootText } from "../../../../../plugins/desk/mcp/src/runtime/boot-text.js"
import {
  RELEASE_ALERT_CACHE_FILE,
  RELEASE_ALERT_TTL_MS,
  RELEASE_ISSUES_URL,
  RELEASE_ISSUE_TITLE,
  DESK_PROBLEM_LABEL,
  checkReleaseAlert as checkAll,
  deskProblemsLine,
  releaseAlertLine,
  workingOnDesk,
} from "../../../../../plugins/desk/mcp/src/runtime/release-alert.js"

const onDesk = [{ data: { status: "validating", repos: [{ name: "ourostack/desk" }] } }]
const issue = { number: 207, title: RELEASE_ISSUE_TITLE, html_url: "https://github.com/ourostack/desk/issues/207" }
const answering = (issues, calls = []) => async (url, init) => {
  calls.push({ url, init })
  return { ok: true, text: async () => JSON.stringify(issues) }
}
const checkReleaseAlert = async (args) => (await checkAll(args)).release_alert
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
  writeFileSync(file, JSON.stringify({ checked_at: "2099-01-01T00:00:00Z", alert: null, problems: [] }))
  assert.equal((await fresh()).number, 207)
  writeFileSync(file, JSON.stringify({ checked_at: "2026-10-06T12:00:00Z", alert: { number: "x" }, problems: [] }))
  assert.equal((await fresh()).number, 207)
  writeFileSync(file, JSON.stringify({ checked_at: "2026-10-06T12:00:00Z", alert: null }))
  assert.equal((await fresh()).number, 207)
  writeFileSync(file, JSON.stringify({ checked_at: "2026-10-06T12:00:00Z", alert: null, problems: [{ number: 1 }] }))
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

test("the label constant is the one Desk files its problems under", () => {
  assert.equal(DESK_PROBLEM_LABEL, LABEL)
})

// ── desk problems ───────────────────────────────────────────────────────────

const NOW = Date.parse("2026-10-06T12:00:00Z")
const problem = (number, createdAt, extra = {}) => ({ number, title: `t${number}`, html_url: `https://github.com/ourostack/desk/issues/${number}`, created_at: createdAt, labels: [{ name: DESK_PROBLEM_LABEL }], ...extra })
const problemsOf = async (issues, extra = {}) => (await checkAll({ env: {}, cards: onDesk, fetchFn: answering(issues), stateDir: await stateDir(), now: () => NOW, ...extra })).desk_problems

test("open desk-problem issues come back oldest first with their age, in the same request as the release alert", async () => {
  const calls = []
  const both = await checkAll({
    env: {}, cards: onDesk, stateDir: await stateDir(), now: () => NOW,
    fetchFn: answering([problem(138, "2026-10-01T12:00:00Z"), issue, problem(103, "2026-09-29T12:00:00Z"), problem(150, "2026-10-06T08:00:00Z")], calls),
  })
  assert.equal(calls.length, 1)
  assert.equal(both.release_alert.number, 207)
  const found = both.desk_problems
  assert.equal(found.count, 3)
  assert.equal(found.oldest_days, 7)
  assert.deepEqual(found.issues, [
    { number: 103, url: "https://github.com/ourostack/desk/issues/103", age_days: 7 },
    { number: 138, url: "https://github.com/ourostack/desk/issues/138", age_days: 5 },
    { number: 150, url: "https://github.com/ourostack/desk/issues/150", age_days: 0 },
  ])
  assert.equal(found.line, "Desk problems open on ourostack/desk: #103 (7 days), #138 (5 days), #150 (today); take the oldest through desk-problem")
})

test("the list is capped at three with the rest counted, and a one-day age is singular", async () => {
  const many = [1, 2, 3, 4, 5].map((n) => problem(n, `2026-10-0${n}T12:00:00Z`))
  const found = await problemsOf(many.reverse())
  assert.equal(found.count, 5)
  assert.deepEqual(found.issues.map((item) => item.number), [1, 2, 3])
  assert.match(found.line, /#3 \(3 days\), \+2 more; take the oldest/u)
  assert.equal(deskProblemsLine({ count: 1, issues: [{ number: 9, age_days: 1 }] }), "Desk problems open on ourostack/desk: #9 (1 day); take the oldest through desk-problem")
})

test("only open issues carrying the label count: not pull requests, other labels, string labels or undated ones", async () => {
  assert.equal(await problemsOf([problem(1, "2026-10-01T00:00:00Z", { pull_request: {} }), problem(2, "2026-10-01T00:00:00Z", { labels: [{ name: "bug" }] }), problem(3, "2026-10-01T00:00:00Z", { labels: undefined }), problem(4, "nope")]), null)
  const found = await problemsOf([problem(5, "2026-10-01T00:00:00Z", { labels: ["desk-problem"] }), problem(6, "2026-10-01T00:00:00Z", { labels: [null, { name: "desk-problem" }] }), problem(6, "2026-10-01T00:00:00Z")])
  assert.deepEqual(found.issues.map((item) => item.number), [5, 6, 6])
})

test("equal creation times sort by number, and a future-dated issue is age zero", async () => {
  const found = await problemsOf([problem(9, "2026-10-07T00:00:00Z"), problem(8, "2026-10-07T00:00:00Z")])
  assert.deepEqual(found.issues.map((item) => [item.number, item.age_days]), [[8, 0], [9, 0]])
})

test("desk problems are cached with the release alert and recomputed for age on each boot", async () => {
  const dir = await stateDir()
  let clock = NOW
  const calls = []
  const run = async () => checkAll({ env: {}, cards: onDesk, fetchFn: answering([problem(103, "2026-09-29T12:00:00Z")], calls), stateDir: dir, now: () => clock })
  assert.equal((await run()).desk_problems.oldest_days, 7)
  clock += 60 * 1000
  assert.equal((await run()).desk_problems.count, 1)
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(readFileSync(path.join(dir, RELEASE_ALERT_CACHE_FILE), "utf8")).problems[0].number, 103)
})

test("a cache written before desk problems existed is a miss, and nothing is asked of a desk that is not on ourostack/desk", async () => {
  const dir = await stateDir()
  writeFileSync(path.join(dir, RELEASE_ALERT_CACHE_FILE), JSON.stringify({ schema_version: 1, checked_at: new Date(NOW).toISOString(), alert: null }))
  assert.equal((await problemsOf([problem(103, "2026-09-29T12:00:00Z")], { stateDir: dir })).count, 1)
  assert.equal(await problemsOf([]), null)
  const calls = []
  assert.deepEqual(await checkAll({ env: {}, cards: [], fetchFn: answering([problem(1, "2026-10-01T00:00:00Z")], calls), stateDir: await stateDir() }), { release_alert: null, desk_problems: null })
  assert.equal(calls.length, 0)
})

// ── in boot// ── in boot ─────────────────────────────────────────────────────────────────

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
  const problems = { count: 2, oldest_days: 7, issues: [{ number: 103, url: "u", age_days: 7 }, { number: 138, url: "v", age_days: 5 }] }
  problems.line = deskProblemsLine(problems)
  let seen
  const result = await boot({ releaseAlertFn: async (args) => { seen = args; return { release_alert: alert, desk_problems: problems } } })
  assert.deepEqual(result.release_alert, alert)
  assert.deepEqual(result.desk_problems, problems)
  assert.ok(Array.isArray(seen.cards) && typeof seen.now === "function")
  const lines = formatBootText(result).split("\n")
  assert.match(lines[0], /^Desk boot: /u)
  assert.equal(lines[1], alert.line)
  assert.equal(lines[2], "Desk problems open on ourostack/desk: #103 (7 days), #138 (5 days); take the oldest through desk-problem")
})

test("boot adds nothing when there is no alert, and a throwing lookup never fails it", async () => {
  const quiet = await boot({ releaseAlertFn: async () => null })
  assert.equal(quiet.release_alert, null)
  assert.equal(quiet.desk_problems, null)
  assert.doesNotMatch(formatBootText(quiet), /Desk release needs attention|Desk problems open/u)
  const broken = await boot({ releaseAlertFn: async () => { throw new Error("boom") } })
  assert.equal(broken.release_alert, null)
  assert.equal(broken.desk_problems, null)
  assert.equal(broken.boot_complete, true)
})

test("a headless factory session asks nothing", async () => {
  let asked = false
  const result = await boot({ env: { DESK_FACTORY_HEADLESS: "1" }, releaseAlertFn: async () => { asked = true; return null } })
  assert.equal(asked, false)
  assert.equal(result.release_alert, null)
  assert.equal(result.desk_problems, null)
})
