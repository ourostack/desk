// The loop's route step for issues: andon alarms, red store builds and Desk problems each open one card.
// Every test uses a throwaway desk and state folder, the real card library and conditions record, a fake gh
// runner and a fake commit function; nothing touches Git, GitHub, a real desk or the real factory state.

import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { osEnv } from "../_os_env.js"

import { claimNext, readCards, updateCard, cardKey } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import { conditionOf } from "../../../../../plugins/desk/mcp/src/factory/loop-conditions.js"
import { readStatus, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { MAX_ISSUES_PER_KIND, runRouteIssuesStep } from "../../../../../plugins/desk/mcp/src/factory/route-issues.js"

const NOW = new Date("2026-10-05T12:00:00Z")
const BOT = "github-actions[bot]"
const STORE = "ourostack/factory"
const OTHER = "acme/work"
const DESK = "ourostack/desk"
const SECRET = "SENTINEL-TITLE-AND-BODY-TEXT"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-route-issues-")))
  const deskRoot = path.join(base, "desk")
  await fs.mkdir(deskRoot, { recursive: true })
  const env = osEnv({ HOME: base, XDG_STATE_HOME: path.join(base, "state") })
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  try {
    return await run({ env, deskRoot, personPrefix: "", base })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

const answer = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" })
const content = (value) => answer({ encoding: "base64", content: Buffer.from(JSON.stringify(value)).toString("base64") })
const httpFail = (status) => ({ code: 1, stdout: "", stderr: `gh: Oops (HTTP ${status})` })
const raw = (number, { title = "Andon: desk 3.4.0 tool_failures other", labels = ["andon"], author = BOT, pr = false } = {}) => ({ number, title, body: SECRET, labels: labels.map((name) => ({ name })), state: "open", user: { login: author }, ...(pr ? { pull_request: {} } : {}) })
const andon = (number, extra) => raw(number, extra)
const build = (number, extra = {}) => raw(number, { title: SECRET, labels: ["build-failing"], ...extra })
const problem = (number, extra = {}) => raw(number, { title: SECRET, labels: ["desk-problem"], author: "contributor", ...extra })

// repos: { "<owner/repo>": { config, andon: [], build: [], problem: [], fail: { andon: result, ... } } }
function fakeGh({ repos = {}, tokens = {} } = {}) {
  const calls = []
  const runner = async (args, options = {}) => {
    calls.push({ args, token: options.token })
    if (args[0] === "auth") {
      const account = args[3]
      const token = tokens[account] ?? `tok-${account}`
      return typeof token === "object" ? token : { code: 0, stdout: `${token}\n`, stderr: "" }
    }
    const route = args[7]
    const repo = /^repos\/([^/]+\/[^/]+)\//u.exec(route)[1]
    const model = repos[repo] ?? {}
    if (route.includes("/contents/")) return model.fail?.config ?? (model.config === undefined ? content({ andon: { plugins: ["desk"] } }) : model.config)
    const label = /labels=([^&]+)/u.exec(route)[1]
    const kind = label === "andon" ? "andon" : label === "build-failing" ? "build" : "problem"
    if (model.fail?.[kind] !== undefined) return model.fail[kind]
    const page = Number(/[&?]page=(\d+)/u.exec(route)[1])
    return answer(page === 1 ? model[kind] ?? [] : [])
  }
  return { calls, runner }
}

const commits = []
const commit = async ({ write, message }) => {
  const written = await write()
  const { file, ...rest } = written
  const result = typeof file === "string" ? { ...rest, file_name: path.basename(file) } : rest
  commits.push(typeof message === "function" ? message(result) : message)
  return { result, commit: "committed", left_alone: 0 }
}
const run = (ctx, seams = {}) => runRouteIssuesStep(ctx.env, { deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix, now: NOW, writeCardCommitted: commit, ...seams })
const cards = async (ctx) => (await readCards({ deskRoot: ctx.deskRoot, personPrefix: ctx.personPrefix })).cards
const byKey = async (ctx, key) => (await cards(ctx)).find((card) => card.key === key)

test("two andon issues and one red build open three cards with generated titles and pointer evidence; a second run opens none", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(3), andon(1)], build: [build(7)] } } })
  const first = await run(ctx, { runner })
  assert.equal(first.ok, true)
  assert.equal(first.result, "routed")
  assert.deepEqual(first.opened, [cardKey("andon", `${STORE}#1`), cardKey("andon", `${STORE}#3`), cardKey("store_build", `${STORE}#7`)])
  assert.equal(first.counts.opened, 3)
  assert.deepEqual(first.counts.open_now, { andon_open: 2, store_build_failing: 1, desk_problems_open: 0 })
  const list = await cards(ctx)
  assert.deepEqual(list.map((card) => [card.title, card.plugin, card.evidence, card.source]).sort(), [
    ["Store build andon is open", "desk", [`issue:${STORE}#1`], "andon"],
    ["Store build andon is open", "desk", [`issue:${STORE}#3`], "andon"],
    ["Store build is failing", "desk", [`issue:${STORE}#7`], "store_build"],
  ])
  const second = await run(ctx, { runner })
  assert.deepEqual(second.opened, [])
  assert.equal(second.counts.duplicate, 3)
  assert.equal(second.counts.opened ?? 0, 0)
  assert.equal((await cards(ctx)).length, 3)
  assert.ok(commits.length >= 3)
}))

test("a Desk problem by a consenting account opens one card; read once even with two consenting stores", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: OTHER, contribute: true, account: "second" })
  const { runner, calls } = fakeGh({ repos: { [DESK]: { problem: [problem(5), problem(6, { author: "Second" })] } } })
  const result = await run(ctx, { runner })
  assert.deepEqual(result.opened, [cardKey("desk_problem", `${DESK}#5`), cardKey("desk_problem", `${DESK}#6`)])
  const card = await byKey(ctx, cardKey("desk_problem", `${DESK}#5`))
  assert.equal(card.title, "Desk problem filed as a GitHub issue")
  assert.deepEqual(card.evidence, [`issue:${DESK}#5`])
  assert.equal(calls.filter((call) => call.args[7]?.startsWith(`repos/${DESK}/issues`)).length, 1)
}))

test("someone else's issue, an unknown account's Desk problem, a dismissed andon issue, a pull request and an untracked plugin open no card", () => scratch(async (ctx) => {
  const { runner } = fakeGh({
    repos: {
      [STORE]: {
        andon: [andon(1, { author: "someone" }), andon(2, { labels: ["andon", "andon-dismissed"] }), andon(3, { pr: true }), andon(4, { title: "Andon: private-tool 1.0.0 tool_failures other" })],
        build: [build(5, { pr: true })],
      },
      [DESK]: { problem: [problem(6, { author: "stranger" }), problem(7, { pr: true })] },
    },
  })
  const result = await run(ctx, { runner })
  assert.equal(result.ok, true)
  assert.deepEqual(result.opened, [])
  assert.deepEqual(await cards(ctx), [])
  assert.deepEqual(result.counts.open_now, { andon_open: 0, store_build_failing: 0, desk_problems_open: 0 })
}))

test("a closed card whose issue reopened is reopened with one recurrence", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(1)] } } })
  await run(ctx, { runner })
  const key = cardKey("andon", `${STORE}#1`)
  const claimed = await claimNext({ env: ctx.env, deskRoot: ctx.deskRoot, personPrefix: "", now: NOW })
  assert.equal(claimed.result, "claimed")
  const closed = await updateCard({ deskRoot: ctx.deskRoot, personPrefix: "", key, claim_id: claimed.claim_id, patch: { state: "closed_unverified", close_reason: "wont_fix" }, now: NOW })
  assert.equal(closed.result, "updated")
  const again = await run(ctx, { runner })
  assert.deepEqual(again.opened, [key])
  assert.equal(again.counts.reopened, 1)
  const card = await byKey(ctx, key)
  assert.equal(card.state, "open")
  assert.equal(card.recurrences, 1)
}))

test("gh_missing, auth_failed and an HTTP error each fail the step with their stable code and open no card", () => scratch(async (ctx) => {
  const enoent = { code: 1, stdout: "", stderr: "", spawnError: "ENOENT" }
  const missing = await run(ctx, { runner: fakeGh({ tokens: { contributor: enoent } }).runner })
  assert.deepEqual([missing.ok, missing.result], [false, "gh_missing"])
  const noAuth = await run(ctx, { runner: fakeGh({ tokens: { contributor: { code: 1, stdout: "", stderr: "no" } } }).runner })
  assert.deepEqual([noAuth.ok, noAuth.result], [false, "auth_failed"])
  const http = await run(ctx, { runner: fakeGh({ repos: { [STORE]: { fail: { andon: httpFail(500), build: httpFail(500) } }, [DESK]: { fail: { problem: httpFail(500) } } } }).runner })
  assert.deepEqual([http.ok, http.result], [false, "http_500"])
  assert.deepEqual(http.counts.failed, { andon: "http_500", store_build: "http_500", desk_problem: "http_500" })
  assert.deepEqual(http.counts.kinds_read, [])
  assert.equal(http.counts.open_now.andon_open, undefined)
  assert.deepEqual(await cards(ctx), [])
  const mixed = await run(ctx, { runner: fakeGh({ repos: { [STORE]: { fail: { andon: httpFail(500), build: httpFail(404) } }, [DESK]: { fail: { problem: httpFail(403) } } } }).runner })
  assert.deepEqual([mixed.ok, mixed.result], [false, "unreadable"])
}))

test("one failing source does not stop the others, and the failed kind is not observed", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(1)], build: [build(7)], fail: { andon: httpFail(502) } }, [DESK]: { problem: [problem(5)] } } })
  const result = await run(ctx, { runner })
  assert.deepEqual([result.ok, result.result], [false, "partly_read"])
  assert.deepEqual(result.counts.kinds_read, ["store_build", "desk_problem"])
  assert.deepEqual(result.counts.failed, { andon: "http_502" })
  assert.deepEqual(result.opened, [cardKey("store_build", `${STORE}#7`), cardKey("desk_problem", `${DESK}#5`)])
  const status = await readStatus(ctx.env)
  assert.equal(conditionOf(status, cardKey("store_build", `${STORE}#7`)).present, true)
  assert.equal(conditionOf(status, cardKey("desk_problem", `${DESK}#5`)).present, true)
  assert.deepEqual(Object.keys(status.loop.route_issues).sort(), ["at", "desk_problems_open", "store_build_failing"])
  assert.equal(status.loop.route_issues.store_build_failing, 1)
  // A later failed andon read does not clear a recorded andon condition.
  const ok = fakeGh({ repos: { [STORE]: { andon: [andon(1)] } } }).runner
  await run(ctx, { runner: ok })
  const later = new Date(NOW.getTime() + 7 * 3600 * 1000)
  await run(ctx, { runner, now: later })
  assert.equal(conditionOf(await readStatus(ctx.env), cardKey("andon", `${STORE}#1`)).present, true)
}))

test("each successful read observes the complete list; an issue that went away reads as clear", () => scratch(async (ctx) => {
  const first = fakeGh({ repos: { [STORE]: { andon: [andon(1), andon(2)], build: [build(7)] } } })
  await run(ctx, { runner: first.runner })
  let status = await readStatus(ctx.env)
  assert.deepEqual(status.loop.route_issues, { at: NOW.toISOString(), andon_open: 2, store_build_failing: 1, desk_problems_open: 0 })
  assert.equal(conditionOf(status, cardKey("andon", `${STORE}#2`)).present, true)
  const later = new Date(NOW.getTime() + 7 * 3600 * 1000)
  await run(ctx, { runner: fakeGh({ repos: { [STORE]: { andon: [andon(1)] } } }).runner, now: later })
  status = await readStatus(ctx.env)
  assert.deepEqual(conditionOf(status, cardKey("andon", `${STORE}#2`)), { state: "measured", present: false, clear_runs: 1, observed_at: later.toISOString() })
  assert.equal(conditionOf(status, cardKey("store_build", `${STORE}#7`)).present, false)
  assert.equal(status.loop.route_issues.andon_open, 1)
}))

test("a store whose build has no failing-build label simply has none; a store without factory.json tracks no andon issue", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { config: { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }, andon: [andon(1)] } } })
  const result = await run(ctx, { runner })
  assert.deepEqual([result.ok, result.result], [true, "routed"])
  assert.deepEqual(result.counts.open_now, { andon_open: 0, store_build_failing: 0, desk_problems_open: 0 })
  const invalid = await run(ctx, { runner: fakeGh({ repos: { [STORE]: { config: content({ bogus: true }) } } }).runner })
  assert.deepEqual(invalid.counts.failed, { andon: "invalid_config" })
  assert.deepEqual(invalid.counts.kinds_read, ["store_build", "desk_problem"])
}))

test("a token problem on one account fails only that account's stores; the healthy store still opens its cards", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: OTHER, contribute: true, account: "second" })
  const { runner } = fakeGh({ tokens: { contributor: { code: 1, stdout: "", stderr: "" } }, repos: { [OTHER]: { andon: [andon(4)] }, [DESK]: { problem: [problem(9, { author: "second" })] } } })
  const result = await run(ctx, { runner })
  assert.deepEqual(result.counts.failed, { andon: "auth_failed", store_build: "auth_failed" })
  assert.deepEqual(result.counts.kinds_read, ["desk_problem"])
  assert.deepEqual(result.opened, [cardKey("andon", `${OTHER}#4`), cardKey("desk_problem", `${DESK}#9`)])
  assert.equal(conditionOf(await readStatus(ctx.env), cardKey("andon", `${OTHER}#4`)).state, "unavailable", "a kind not read in every store is not observed")
}))

test("a failed store in a kind does not withhold the healthy store's cards, and opens none of its own", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: OTHER, contribute: true, account: "contributor" })
  const { runner } = fakeGh({ repos: { [STORE]: { fail: { andon: httpFail(500) } }, [OTHER]: { andon: [andon(4)], build: [build(2)] } } })
  const result = await run(ctx, { runner })
  assert.equal(result.result, "partly_read")
  assert.deepEqual(result.opened, [cardKey("andon", `${OTHER}#4`), cardKey("store_build", `${OTHER}#2`)])
  assert.equal(result.counts.open_now.andon_open, undefined)
  assert.equal(result.counts.open_now.store_build_failing, 1)
}))

test("a red build counts only when the build bot or a consenting account filed it", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { build: [build(1), build(2, { author: "Contributor" }), build(3, { author: "someone" }), build(4, { author: null })] } } })
  const result = await run(ctx, { runner })
  assert.deepEqual(result.opened, [cardKey("store_build", `${STORE}#1`), cardKey("store_build", `${STORE}#2`)])
  assert.equal(result.counts.open_now.store_build_failing, 2)
}))

test("a store that stopped consenting keeps its recorded present ids when another store is observed", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: OTHER, contribute: true, account: "contributor" })
  const both = fakeGh({ repos: { [STORE]: { andon: [andon(1)] }, [OTHER]: { andon: [andon(4)], build: [build(2)] } } })
  await run(ctx, { runner: both.runner })
  await setConsent(ctx.env, { store: OTHER, contribute: false, account: "contributor" })
  const later = new Date(NOW.getTime() + 7 * 3600 * 1000)
  await run(ctx, { runner: fakeGh({ repos: { [STORE]: {} } }).runner, now: later })
  const status = await readStatus(ctx.env)
  assert.equal(conditionOf(status, cardKey("andon", `${OTHER}#4`)).present, true)
  assert.equal(conditionOf(status, cardKey("store_build", `${OTHER}#2`)).present, true)
  assert.equal(conditionOf(status, cardKey("andon", `${STORE}#1`)).present, false, "a read store's vanished issue is clear")
}))

test("a Desk problem still open whose author left consent stays present, opens no card and is not counted", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: OTHER, contribute: true, account: "second" })
  await run(ctx, { runner: fakeGh({ repos: { [DESK]: { problem: [problem(5, { author: "second" }), problem(6)] } } }).runner })
  await setConsent(ctx.env, { store: OTHER, contribute: false, account: "second" })
  const later = new Date(NOW.getTime() + 7 * 3600 * 1000)
  const result = await run(ctx, { runner: fakeGh({ repos: { [DESK]: { problem: [problem(5, { author: "second" }), problem(6), problem(7, { author: "second" }), problem(8, { author: "second", pr: true })] } } }).runner, now: later })
  assert.deepEqual(result.opened, [])
  assert.equal(result.counts.open_now.desk_problems_open, 1)
  const status = await readStatus(ctx.env)
  assert.equal(conditionOf(status, cardKey("desk_problem", `${DESK}#5`)).present, true, "still open, excluded only by the author filter")
  assert.equal(conditionOf(status, cardKey("desk_problem", `${DESK}#7`)).state, "unavailable", "never recorded, so nothing to keep")
  assert.equal(conditionOf(status, cardKey("desk_problem", `${DESK}#8`)).state, "unavailable")
  // Once the issue closes it reads as clear.
  await run(ctx, { runner: fakeGh({ repos: { [DESK]: { problem: [problem(6)] } } }).runner, now: new Date(later.getTime() + 7 * 3600 * 1000) })
  assert.equal(conditionOf(await readStatus(ctx.env), cardKey("desk_problem", `${DESK}#5`)).present, false)
}))

test("an unreadable status leaves the kind unobserved", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(1)] } } })
  const result = await run(ctx, { runner, readStatusImpl: async () => { throw new Error("x") } })
  assert.equal(result.counts.observe_failed, 3)
  assert.equal(conditionOf(await readStatus(ctx.env), cardKey("andon", `${STORE}#1`)).state, "unavailable")
}))

test("a run that reads nothing leaves a health record with a time and no numbers", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(1)] } } })
  await run(ctx, { runner })
  assert.equal((await readStatus(ctx.env)).loop.route_issues.andon_open, 1)
  const later = new Date(NOW.getTime() + 3600 * 1000)
  await setConsent(ctx.env, { store: STORE, contribute: false, account: "contributor" })
  assert.equal((await run(ctx, { runner, now: later })).result, "no_stores")
  assert.deepEqual((await readStatus(ctx.env)).loop.route_issues, { at: later.toISOString() })
  const boom = async () => { throw new Error("x") }
  const last = new Date(NOW.getTime() + 2 * 3600 * 1000)
  assert.equal((await run(ctx, { runner, now: last, readConsentImpl: boom })).result, "consent_unreadable")
  assert.deepEqual((await readStatus(ctx.env)).loop.route_issues, { at: last.toISOString() })
  assert.equal((await run(ctx, { runner, readConsentImpl: boom, updateStatusImpl: boom })).counts.status_unwritable, 1)
}))

test("no account or token for any consenting account fails the Desk problem read; stores without consent or account are not read", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: OTHER, contribute: true })
  await setConsent(ctx.env, { store: "acme/off", contribute: false, account: "x" })
  const { runner, calls } = fakeGh({ tokens: { contributor: { code: 1, stdout: "", stderr: "" } } })
  const result = await run(ctx, { runner })
  assert.equal(result.counts.failed.desk_problem, "auth_failed")
  assert.ok(calls.every((call) => call.args[0] === "auth"))
}))

test("nothing is read when no store consents", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: false, account: "contributor" })
  const { runner, calls } = fakeGh()
  const result = await run(ctx, { runner })
  assert.deepEqual([result.ok, result.result, calls.length], [true, "no_stores", 0])
}))

test("past the per-kind bound only the lowest numbers open cards, the count is the true total, and the source is not observed", () => scratch(async (ctx) => {
  const many = Array.from({ length: MAX_ISSUES_PER_KIND + 3 }, (_, index) => build(index + 1))
  const { runner } = fakeGh({ repos: { [STORE]: { build: many } } })
  const result = await run(ctx, { runner })
  assert.equal(result.opened.length, MAX_ISSUES_PER_KIND)
  assert.equal(result.counts.open_now.store_build_failing, MAX_ISSUES_PER_KIND + 3)
  assert.deepEqual(result.counts.capped, ["store_build"])
  assert.equal(result.result, "routed")
  const status = await readStatus(ctx.env)
  assert.equal(conditionOf(status, cardKey("store_build", `${STORE}#1`)).state, "unavailable")
  assert.equal(status.loop.route_issues.store_build_failing, MAX_ISSUES_PER_KIND + 3)
}))

test("a card write that throws or is refused is counted and the step goes on", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(1), andon(2)] } } })
  let calls = 0
  const flaky = async (input) => {
    calls += 1
    if (calls === 1) throw new Error("disk")
    return commit(input)
  }
  const result = await run(ctx, { runner, writeCardCommitted: flaky })
  assert.equal(result.counts.card_write_failed, 1)
  assert.deepEqual(result.opened, [cardKey("andon", `${STORE}#2`)])
  const refused = await run(ctx, { runner, writeCardCommitted: async () => ({ result: { result: "lock_busy" }, commit: "committed" }) })
  assert.equal(refused.counts.lock_busy, 2)
  const named = []
  await run(ctx, { runner, writeCardCommitted: async ({ message }) => { named.push(message({})); return { result: { result: "duplicate" }, commit: "no_change" } } })
  assert.deepEqual(named.slice(0, 1), ["improvement: route card"])
  const weird = await run(ctx, { runner, writeCardCommitted: async () => ({ result: {}, commit: "committed" }) })
  assert.equal(weird.counts.card_write_failed, 2)
}))

test("a failed status write or condition record is counted and never throws", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(1)] } } })
  const result = await run(ctx, { runner, updateStatusImpl: async () => { throw new Error("nope") }, observeImpl: async () => ({ ok: false, result: "status_unwritable" }) })
  assert.equal(result.counts.status_unwritable, 1)
  assert.equal(result.counts.observe_failed, 3)
  const thrown = await run(ctx, { runner, observeImpl: async () => { throw new Error("x") } })
  assert.equal(thrown.counts.observe_failed, 3)
  assert.equal(result.ok, true)
}))

test("a runner or consent read that throws is a stable code, not a throw", () => scratch(async (ctx) => {
  const boom = async () => { throw new Error("boom") }
  const thrown = await run(ctx, { runner: boom })
  assert.deepEqual([thrown.ok, thrown.result], [false, "unexpected_error"])
  const late = await run(ctx, { runner: async (args) => { if (args[0] === "auth") return { code: 0, stdout: "t\n", stderr: "" }; throw new Error("boom") } })
  assert.deepEqual([late.ok, late.result], [false, "unexpected_error"])
  const consent = await run(ctx, { runner: fakeGh().runner, readConsentImpl: boom })
  assert.deepEqual([consent.ok, consent.result], [false, "consent_unreadable"])
}))

test("a headless factory session runs nothing and writes nothing", () => scratch(async (ctx) => {
  const { runner, calls } = fakeGh({ repos: { [STORE]: { andon: [andon(1)] } } })
  const result = await runRouteIssuesStep({ ...ctx.env, DESK_FACTORY_HEADLESS: "1" }, { deskRoot: ctx.deskRoot, personPrefix: "", now: NOW, runner, writeCardCommitted: commit })
  assert.deepEqual([result.ok, result.result, result.opened], [false, "headless_session", []])
  assert.equal(calls.length, 0)
  assert.deepEqual(await cards(ctx), [])
}))

test("bad arguments throw a TypeError", () => scratch(async (ctx) => {
  await assert.rejects(runRouteIssuesStep(ctx.env, { deskRoot: "relative", now: NOW }), TypeError)
  await assert.rejects(run(ctx, { now: "never" }), TypeError)
}))

test("no issue title, body or author text reaches a card, the status file or the result", () => scratch(async (ctx) => {
  const { runner } = fakeGh({ repos: { [STORE]: { andon: [andon(1)], build: [build(7)] }, [DESK]: { problem: [problem(5)] } } })
  const result = await run(ctx, { runner })
  const files = await fs.readdir(path.join(ctx.deskRoot, "_meta", "improvement"))
  const texts = await Promise.all(files.map((file) => fs.readFile(path.join(ctx.deskRoot, "_meta", "improvement", file), "utf8")))
  const everything = JSON.stringify([result, texts, await readStatus(ctx.env), commits])
  for (const needle of [SECRET, "contributor", "Andon:", "tool_failures", ctx.base]) assert.equal(everything.includes(needle), false, needle)
}))
