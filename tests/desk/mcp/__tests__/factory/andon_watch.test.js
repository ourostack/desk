// Andon at session start: the start-time refresh records the open andon
// issues of each consented store for the boot check. GitHub is simulated.

import { test } from "node:test"
import assert from "node:assert/strict"

import { MAX_RECORDED, refreshAndon } from "../../../../../plugins/desk/mcp/src/factory/andon-watch.js"
import { readStatus, setConsent, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { STORE, scratch } from "./_session_helpers.js"

const TOKEN = "ghs_SENTINEL"
const BOT = "github-actions[bot]"
const NOW = () => Date.parse("2026-09-27T12:00:00.000Z")
const answer = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" })
const content = (value) => answer({ encoding: "base64", content: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64") })
const issue = (number, { title = "Andon: desk 3.4.0 tool_failures other", labels = ["andon"], author = BOT, pr = false } = {}) => ({ number, title, body: "", labels: labels.map((name) => ({ name })), state: "open", user: { login: author }, ...(pr ? { pull_request: {} } : {}) })

function fakeGh({ auth = { code: 0, stdout: `${TOKEN}\n` }, config = content({ andon: { plugins: ["desk", "crew"] } }), issues = [] } = {}) {
  const calls = []
  const runner = async (args, options = {}) => {
    calls.push({ args, token: options.token })
    if (args[0] === "auth") return auth
    const route = args[7]
    if (route.includes("/contents/")) return typeof config === "function" ? config() : config
    return typeof issues === "function" ? issues() : answer(issues)
  }
  return { calls, runner }
}

test("the refresh records the store's open andon issues for tracked plugins that no one dismissed", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await writeStatus(env, { andon: { "acme/work": { checked_at: "2026-09-26T00:00:00.000Z", issues: [] } } })
  const { calls, runner } = fakeGh({
    issues: [
      issue(15),
      issue(12, { title: "Andon: crew 0.2.3 tool_retries other" }),
      issue(13, { title: "Andon: private-tool 1.0.0 tool_failures other" }),
      issue(14, { labels: ["andon", "andon-dismissed"] }),
      issue(16, { author: "someone" }),
      issue(17, { pr: true }),
      issue(18, { title: "Andon: something else" }),
    ],
  })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner, now: NOW }), { result: "recorded", count: 2 })
  assert.deepEqual(calls[0].args, ["auth", "token", "--user", "contributor"])
  assert.ok(calls.slice(1).every((call) => call.token === TOKEN && !call.args.includes(TOKEN)))
  assert.equal(calls[1].args[7], `repos/${STORE}/contents/factory.json`)
  const { andon } = await readStatus(env)
  assert.deepEqual(andon[STORE], { checked_at: "2026-09-27T12:00:00.000Z", issues: [{ number: 12, title: "Andon: crew 0.2.3 tool_retries other" }, { number: 15, title: "Andon: desk 3.4.0 tool_failures other" }] })
  assert.deepEqual(andon["acme/work"], { checked_at: "2026-09-26T00:00:00.000Z", issues: [] }, "another store's record stays")
}))

test("a store without factory.json is config_missing and records nothing, never an empty list; a present empty config is a real look; the record is capped", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const missing = fakeGh({ config: { code: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" }, issues: [issue(1)] })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: missing.runner, now: NOW }), { result: "config_missing" })
  assert.deepEqual((await readStatus(env)).andon, { [STORE]: { failure: "config_missing", failed_at: "2026-09-27T12:00:00.000Z" } }, "no issue list that reads as no open andon, and the failure recorded")
  const empty = fakeGh({ config: content({ andon: { plugins: [] } }), issues: [issue(1)] })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: empty.runner, now: NOW }), { result: "recorded", count: 0 })
  assert.deepEqual((await readStatus(env)).andon[STORE].issues, [])
  const many = fakeGh({ issues: Array.from({ length: MAX_RECORDED + 5 }, (_, index) => issue(index + 1)) })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: many.runner, now: NOW }), { result: "recorded", count: MAX_RECORDED })
  // A misshapen andon record in status is replaced, not merged.
  await writeStatus(env, { andon: [] })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: many.runner, now: NOW }), { result: "recorded", count: MAX_RECORDED })
  assert.deepEqual(Object.keys((await readStatus(env)).andon), [STORE])
}))

test("the refresh records no list without consent, an account, gh, a token, a valid factory.json or GitHub, and records each failure", () => scratch(async ({ env }) => {
  const { calls, runner } = fakeGh()
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner }), { result: "not_opted_in" })
  await setConsent(env, { store: STORE, contribute: false, account: "contributor" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner }), { result: "not_opted_in" })
  await setConsent(env, { store: STORE, contribute: true })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner }), { result: "no_account" })
  assert.equal(calls.length, 0)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ auth: { code: null, spawnError: "ENOENT" } }).runner }), { result: "gh_missing" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ auth: { code: 1, stdout: "", stderr: "no" } }).runner }), { result: "auth_failed" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ auth: { code: 0 } }).runner }), { result: "auth_failed" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ config: content("{ not json") }).runner }), { result: "invalid_config" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ config: content({ andon: {} }) }).runner }), { result: "invalid_config" })
  const forbidden = { code: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)" }
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ config: forbidden }).runner }), { result: "http_403" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ issues: () => forbidden }).runner }), { result: "http_403" })
  // Each failure is recorded beside the last good list, for the boot line; consent problems before any look record nothing of their own.
  assert.equal((await readStatus(env)).andon[STORE].failure, "http_403")
  assert.equal((await readStatus(env)).andon[STORE].issues, undefined)
  const failAfterAuth = async (args) => { if (args[0] === "auth") return { code: 0, stdout: TOKEN }; throw new Error("api boom") }
  await assert.rejects(refreshAndon(env, { store: STORE, runner: failAfterAuth }), /api boom/u)
}))

test("the refresh uses the real clock when none is given", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const before = Date.now()
  await refreshAndon(env, { store: STORE, runner: fakeGh().runner })
  assert.ok(Date.parse((await readStatus(env)).andon[STORE].checked_at) >= before - 1000)
}))

test("a failed refresh keeps the last good list and records its failure beside it; a later success clears it", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ issues: [issue(41)] }).runner, now: NOW }), { result: "recorded", count: 1 })
  const later = () => Date.parse("2026-09-28T12:00:00.000Z")
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh({ auth: { code: 1, stdout: "" } }).runner, now: later }), { result: "auth_failed" })
  assert.deepEqual((await readStatus(env)).andon[STORE], { checked_at: "2026-09-27T12:00:00.000Z", issues: [{ number: 41, title: "Andon: desk 3.4.0 tool_failures other" }], failure: "auth_failed", failed_at: "2026-09-28T12:00:00.000Z" })
  await setConsent(env, { store: STORE, contribute: true })
  assert.deepEqual(await refreshAndon(env, { store: STORE, runner: fakeGh().runner, now: later }), { result: "no_account" })
  assert.equal((await readStatus(env)).andon[STORE].failure, "no_account")
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await refreshAndon(env, { store: STORE, runner: fakeGh().runner, now: later })
  assert.deepEqual((await readStatus(env)).andon[STORE], { checked_at: "2026-09-28T12:00:00.000Z", issues: [] })
  // A misshapen record is replaced by the failure alone.
  await writeStatus(env, { andon: { [STORE]: [] } })
  await refreshAndon(env, { store: STORE, runner: fakeGh({ auth: { code: 1, stdout: "" } }).runner, now: later })
  assert.deepEqual((await readStatus(env)).andon[STORE], { failure: "auth_failed", failed_at: "2026-09-28T12:00:00.000Z" })
}))
