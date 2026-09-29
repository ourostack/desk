// The Desk-problem filer never makes a real network call in tests: every
// runner here is an in-memory model (spec.md §7).
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, promises as fs, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { deskProblemFingerprint, normalizeErrorSignature } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-fingerprint.js"
import { FINGERPRINT_PREFIX } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-template.js"
import { LABEL, MAX_PROBLEMS_PER_DAY, STORE, fileDeskProblem } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-file.js"
import { readStatus, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"

const VERSION = "gh version 2.54.0 (2024-07-31)\n"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-problem-file-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  try {
    return await run({ env, base })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

/** gh's `auth status` text for `accounts` ({ login, active }). */
function authStatus(accounts) {
  const block = ({ login, active }) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${active}\n  - Git operations protocol: https\n`
  return `github.com\n${accounts.map(block).join("\n")}`
}

/**
 * A gh model: `accounts` signed in, `repos[login]` the answer to `GET repos/<store>` for that account's
 * token, `issues` the answer to the desk-problem label search, `create` the answer to issue creation.
 */
function fakeGh({ accounts, repos, tokens = {}, issues = [], create = { number: 42, html_url: `https://github.com/${STORE}/issues/42` }, fail = {} } = {}) {
  const calls = []
  const runner = async (args, options = {}) => {
    calls.push({ args, token: options.token, input: options.input })
    if (args[0] === "--version") return { code: 0, stdout: VERSION, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: authStatus(accounts), stderr: "" }
    if (args[0] === "auth" && args[1] === "token") {
      const login = args[3]
      const value = Object.hasOwn(tokens, login) ? tokens[login] : `token-${login}`
      return value === "" ? { code: 1, stdout: "", stderr: "no token\n" } : { code: 0, stdout: `${value}\n`, stderr: "" }
    }
    if (args[0] === "api") {
      const method = args[2]
      const route = args[7]
      if (route === `repos/${STORE}`) {
        const login = typeof options.token === "string" ? options.token.replace(/^token-/u, "") : null
        const answer = repos[login]
        if (typeof answer === "number") return { code: 1, stdout: "{}", stderr: `gh: Not Found (HTTP ${answer})\n` }
        return { code: 0, stdout: JSON.stringify(answer ?? {}), stderr: "" }
      }
      if (route.startsWith(`repos/${STORE}/issues?`)) {
        if (fail.list) return fail.list
        return { code: 0, stdout: JSON.stringify(issues), stderr: "" }
      }
      if (method === "POST" && route === `repos/${STORE}/issues`) {
        if (fail.create) return fail.create
        return { code: 0, stdout: JSON.stringify(create), stderr: "" }
      }
    }
    return { code: 1, stdout: "", stderr: "unexpected call\n" }
  }
  return { runner, calls }
}

const PUSH = { full_name: STORE, private: false, allow_forking: true, default_branch: "main", permissions: { push: true, pull: true } }
const FORK_ONLY = { ...PUSH, permissions: { push: false, pull: true } }
const ONE_ACCOUNT = { accounts: [{ login: "contributor", active: true }], repos: { contributor: PUSH } }

const clock = (iso) => () => Date.parse(iso)
const fingerprintOf = (mechanism, rawText) => deskProblemFingerprint(mechanism, normalizeErrorSignature(rawText))

test("a matching fingerprint in an open-or-closed issue returns 'known' and files nothing new, via listIssues({ state: 'all' })", () => scratch(async ({ env }) => {
  const fingerprint = fingerprintOf("desk-sync", "push rejected twice")
  const { runner, calls } = fakeGh({
    ...ONE_ACCOUNT,
    issues: [{
      number: 5,
      html_url: `https://github.com/${STORE}/issues/5`,
      title: "desk sync push rejected",
      body: `closed as wontfix\n\n${FINGERPRINT_PREFIX}${fingerprint} -->`,
      labels: [{ name: LABEL }],
      state: "closed",
      pull_request: null,
    }],
  })
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected twice", runner })
  assert.deepEqual(result, { result: "known", url: `https://github.com/${STORE}/issues/5` })
  assert.equal(calls.some((call) => call.args[2] === "POST"), false, "a known fingerprint files nothing new")
}))

test("no existing fingerprint match files a new issue labeled desk-problem and bug", () => scratch(async ({ env }) => {
  const { runner, calls } = fakeGh(ONE_ACCOUNT)
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "conflict in clippy/notes.md", fixAttempt: "retried once", host: "claude", runner })
  assert.deepEqual(result, { result: "filed", url: `https://github.com/${STORE}/issues/42` })
  const created = calls.find((call) => call.args[2] === "POST")
  const sent = JSON.parse(created.input)
  assert.deepEqual(sent.labels, [LABEL, "bug"])
  assert.doesNotMatch(sent.body, /clippy\/notes/u)
  const filed = (await readStatus(env)).desk_problem_filed
  assert.equal(filed[STORE].length, 1)
}))

test("filing records the timestamp under desk_problem_filed, and five filings in 24h holds the sixth as held_cap", () => scratch(async ({ env }) => {
  const now = clock("2026-09-28T10:00:00Z")
  for (let i = 0; i < MAX_PROBLEMS_PER_DAY; i += 1) {
    // A distinct rawText each time gives a distinct fingerprint, so each is genuinely new rather than "known".
    const { runner } = fakeGh(ONE_ACCOUNT)
    const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: `distinct failure number ${i}`, runner, now })
    assert.equal(result.result, "filed")
  }
  assert.equal((await readStatus(env)).desk_problem_filed[STORE].length, MAX_PROBLEMS_PER_DAY)
  const { runner: sixthRunner } = fakeGh(ONE_ACCOUNT)
  const sixth = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: `distinct failure number ${MAX_PROBLEMS_PER_DAY}`, runner: sixthRunner, now })
  assert.deepEqual(sixth, { result: "held_cap" })
}))

test("a managed-account-only signed-in user yields not_filed: no_suitable_account with a prefilled body attached", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ accounts: [{ login: "work_corp", active: true }], repos: { work_corp: FORK_ONLY } })
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "no_suitable_account")
  assert.match(result.body, /desk sync/u)
  assert.match(result.body, /desk-problem-fingerprint/u)
}))

test("no signed-in account at all yields not_filed: no_suitable_account, never a thrown error", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ accounts: [], repos: {} })
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "no_suitable_account")
  assert.match(result.body, /desk-problem-fingerprint/u)
}))

test("the desk's own recorded consent account is preferred over chooseAccount's own default pick, when it too can deliver", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "second-account" })
  const { runner, calls } = fakeGh({
    accounts: [{ login: "first-account", active: true }, { login: "second-account", active: false }],
    repos: { "first-account": PUSH, "second-account": PUSH },
  })
  await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  const created = calls.find((call) => call.args[2] === "POST")
  assert.equal(created.token, "token-second-account")
}))

test("when the recorded consent account cannot itself deliver, chooseAccount's own pick is used instead", () => scratch(async ({ env }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "managed_account" })
  const { runner, calls } = fakeGh({
    accounts: [{ login: "managed_account", active: false }, { login: "personal", active: true }],
    repos: { managed_account: FORK_ONLY, personal: PUSH },
  })
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  assert.equal(result.result, "filed")
  const created = calls.find((call) => call.args[2] === "POST")
  assert.equal(created.token, "token-personal")
}))

test("a token fetch that succeeds while choosing the account but fails moments later is not_filed: no_suitable_account, never thrown", () => scratch(async ({ env }) => {
  const { runner: base } = fakeGh(ONE_ACCOUNT)
  let authTokenCalls = 0
  const runner = async (args, options) => {
    if (args[0] === "auth" && args[1] === "token") {
      authTokenCalls += 1
      // chooseAccount's own permission check spends the first call; the filer's own token fetch, moments later, is the second.
      if (authTokenCalls > 1) return { code: 1, stdout: "", stderr: "token expired\n" }
    }
    return base(args, options)
  }
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "no_suitable_account")
}))

test("a token response with no stdout field at all is treated as no token, never thrown", () => scratch(async ({ env }) => {
  const { runner: base } = fakeGh(ONE_ACCOUNT)
  let authTokenCalls = 0
  const runner = async (args, options) => {
    if (args[0] === "auth" && args[1] === "token") {
      authTokenCalls += 1
      if (authTokenCalls > 1) return { code: 0 }
    }
    return base(args, options)
  }
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "no_suitable_account")
}))

test("a listIssues failure is reported as not_filed with that reason, never thrown", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ ...ONE_ACCOUNT, fail: { list: { code: 1, stdout: "", stderr: "gh: Internal Server Error (HTTP 500)\n" } } })
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "http_500")
}))

test("an unexpected failure with no gh-shaped code (a bug, not a gh error) is rethrown rather than swallowed as not_filed", () => scratch(async ({ env }) => {
  const { runner: base } = fakeGh(ONE_ACCOUNT)
  const runner = async (args, options) => {
    if (args[0] === "api" && String(args[7]).startsWith(`repos/${STORE}/issues`)) throw new Error("boom")
    return base(args, options)
  }
  await assert.rejects(fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner }), /boom/u)
}))

test("a token is never printed as a bare call argument, whichever account files", () => scratch(async ({ env }) => {
  const { runner, calls } = fakeGh(ONE_ACCOUNT)
  await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner })
  for (const call of calls) assert.ok(!call.args.some((arg) => typeof arg === "string" && arg.startsWith("token-")))
}))

test("the real gh runner is used when none is injected, and a missing gh binary is reported as not_filed, never thrown", () => scratch(async ({ env }) => {
  const result = await fileDeskProblem({ ...env, PATH: "" }, { mechanism: "desk-sync", rawText: "push rejected" })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "no_suitable_account")
}))

test("fileDeskProblem never throws when called with no options at all, and makes no real network call", () => scratch(async ({ env }) => {
  const result = await fileDeskProblem({ ...env, PATH: "" })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "no_suitable_account")
}))
