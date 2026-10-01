// Choosing the GitHub account that delivers to a factory store (review M3-11 D3).
// The account is never assumed from gh's active account: each signed-in
// account is asked about the store with its own token, and an account that
// cannot open pull requests there (an Enterprise Managed User outside its
// enterprise, a store that disallows forks, a store it cannot see) is never
// chosen. Every account, token and store here is synthetic; the runner is an
// in-memory model and nothing reaches the network.

import { test } from "node:test"
import assert from "node:assert/strict"

import { main as factoryCli } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { chooseAccount, deliveryRoute, flush, signedInAccounts } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { setConsent, writeLocalFacts } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, routeTo, scratch } from "./_session_helpers.js"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const VERSION = "gh version 2.54.0 (2024-07-31)\n"

/** gh's `auth status` text for `accounts` ({ login, active }), with another host's account mixed in. */
function authStatus(accounts) {
  const block = ({ login, active }) => `  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: ${active}\n  - Git operations protocol: https\n  - Token: gho_************************************\n`
  return `github.com\n${accounts.map(block).join("\n")}\nexample.ghe.com\n  ✓ Logged in to example.ghe.com account enterprise-user (keyring)\n  - Active account: true\n`
}

/** A gh model: `accounts` signed in, `repos[login]` the answer to GET repos/<store> for that account's token. */
function fakeGh({ accounts, repos, tokens = {} }) {
  const calls = []
  const runner = async (args, { token } = {}) => {
    calls.push({ args, token })
    if (args[0] === "--version") return { code: 0, stdout: VERSION, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: authStatus(accounts), stderr: "" }
    if (args[0] === "auth" && args[1] === "token") {
      const login = args[3]
      const value = Object.hasOwn(tokens, login) ? tokens[login] : `token-${login}`
      return value === "" ? { code: 1, stdout: "", stderr: "no token\n" } : { code: 0, stdout: `${value}\n`, stderr: "" }
    }
    if (args[0] === "api") {
      const login = typeof token === "string" ? token.replace(/^token-/u, "") : null
      const answer = repos[login]
      if (typeof answer === "number") return { code: 1, stdout: "{}", stderr: `gh: Not Found (HTTP ${answer})\n` }
      return { code: 0, stdout: JSON.stringify(answer), stderr: "" }
    }
    return { code: 1, stdout: "", stderr: "unexpected call\n" }
  }
  return { runner, calls }
}

const PUBLIC_READ = { full_name: STORE, private: false, allow_forking: true, default_branch: "main", permissions: { push: false, pull: true } }
const PUBLIC_PUSH = { ...PUBLIC_READ, permissions: { push: true, pull: true } }

test("gh auth status gives every github.com login, the active one first, and no other host's", () => {
  assert.deepEqual(signedInAccounts(authStatus([{ login: "work_corp", active: false }, { login: "personal", active: true }])), ["personal", "work_corp"])
  assert.deepEqual(signedInAccounts(""), [])
  // gh lists a login once per stored credential; a repeated login is one account.
  assert.deepEqual(signedInAccounts(authStatus([{ login: "personal", active: false }, { login: "personal", active: true }])), ["personal"])
})

test("a store's delivery route: push, then a fork, never a managed account or a store that disallows forks", () => {
  assert.equal(deliveryRoute("work_corp", PUBLIC_PUSH), "direct", "push permission needs no fork, whatever the account")
  assert.equal(deliveryRoute("personal", PUBLIC_READ), "fork")
  assert.equal(deliveryRoute("work_corp", PUBLIC_READ), "managed_account")
  assert.equal(deliveryRoute("personal", { ...PUBLIC_READ, allow_forking: false }), "forking_disabled")
})

test("the active EMU work account is passed over for the signed-in personal account that can reach the store", async () => {
  const gh = fakeGh({ accounts: [{ login: "worker_corp", active: true }, { login: "personal", active: false }], repos: { worker_corp: PUBLIC_READ, personal: PUBLIC_PUSH } })
  assert.deepEqual(await chooseAccount({ store: STORE, runner: gh.runner }), {
    result: "account_found",
    account: "personal",
    route: "direct",
    accounts: [{ account: "worker_corp", reason: "managed_account" }, { account: "personal", route: "direct" }],
  })
  const statusCall = gh.calls.find((call) => call.args[0] === "auth" && call.args[1] === "status")
  assert.equal(statusCall.token, undefined, "the account list is read without any token, so gh lists every signed-in account")
  for (const call of gh.calls.filter((entry) => entry.args[0] === "api")) {
    assert.equal(call.args.some((arg) => arg.startsWith("token-")), false, "a token is never an argument")
  }
})

test("push beats a fork, and the active account wins among equals", async () => {
  let gh = fakeGh({ accounts: [{ login: "first", active: true }, { login: "second", active: false }], repos: { first: PUBLIC_READ, second: PUBLIC_PUSH } })
  assert.equal((await chooseAccount({ store: STORE, runner: gh.runner })).account, "second")
  gh = fakeGh({ accounts: [{ login: "other", active: false }, { login: "active", active: true }], repos: { other: PUBLIC_READ, active: PUBLIC_READ } })
  assert.deepEqual((await chooseAccount({ store: STORE, runner: gh.runner })).account, "active")
})

test("when no signed-in account can deliver, the result names each account's reason", async () => {
  const gh = fakeGh({
    accounts: [{ login: "worker_corp", active: true }, { login: "hidden", active: false }, { login: "expired", active: false }],
    repos: { worker_corp: PUBLIC_READ, hidden: 404 },
    tokens: { expired: "" },
  })
  assert.deepEqual(await chooseAccount({ store: STORE, runner: gh.runner }), {
    result: "no_account_can_deliver",
    accounts: [{ account: "worker_corp", reason: "managed_account" }, { account: "hidden", reason: "store_not_visible" }, { account: "expired", reason: "auth_failed" }],
  })
  assert.deepEqual(await chooseAccount({ store: STORE, runner: fakeGh({ accounts: [], repos: {} }).runner }), { result: "no_account_can_deliver", accounts: [] })
  assert.deepEqual(await chooseAccount({ store: STORE, runner: async () => ({ code: null, spawnError: "ENOENT", stdout: "", stderr: "" }) }), { result: "gh_missing" })
})

async function cli(env, runner, ...argv) {
  let out = ""
  const code = await factoryCli({ argv, env, runner, write: (text) => { out += text }, logError: () => {} })
  return { code, json: JSON.parse(out) }
}

test("factory.js account names the account, or exits 1 with each account's reason", () => scratch(async ({ env }) => {
  const good = fakeGh({ accounts: [{ login: "worker_corp", active: true }, { login: "personal", active: false }], repos: { worker_corp: PUBLIC_READ, personal: PUBLIC_READ } })
  const named = await cli(env, good.runner, "account", "--store", STORE)
  assert.equal(named.code, 0)
  assert.equal(named.json.account, "personal")
  const none = fakeGh({ accounts: [{ login: "worker_corp", active: true }], repos: { worker_corp: PUBLIC_READ } })
  const refused = await cli(env, none.runner, "account", "--store", STORE)
  assert.equal(refused.code, 1)
  assert.deepEqual(refused.json, { result: "no_account_can_deliver", accounts: [{ account: "worker_corp", reason: "managed_account" }] })
}))

test("a flush whose recorded account cannot fork the store stops with account_cannot_deliver instead of waiting on a fork", () => scratch(async ({ env }) => {
  const golden = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
  golden.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  const forks = (github) => github.calls.filter((call) => call.args[0] === "api" && call.args.some((arg) => /\/forks$/u.test(arg))).length

  // A managed (EMU) login may be recorded, because a work store needs one, but it cannot fork a public store outside its enterprise.
  await setConsent(env, { store: STORE, contribute: true, account: "worker_corp" })
  await routeTo(env, golden.session.id)
  assert.equal((await writeLocalFacts(env, STORE, golden)).written, true)
  let github = fakeGitHub({ push: false, account: "worker_corp" })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "account_cannot_deliver" })
  assert.equal(forks(github), 0, "no fork is attempted")

  // A store that disallows forks stops a personal account without push permission the same way.
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const noForks = { code: 0, stdout: JSON.stringify({ ...PUBLIC_READ, allow_forking: false }), stderr: "" }
  github = fakeGitHub({ push: false, intercept: (call) => (call.args[0] === "api" && call.args.at(-1) === `repos/${STORE}` ? noForks : undefined) })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup }), { result: "account_cannot_deliver" })
  assert.equal(forks(github), 0, "no fork is attempted")
}))

test("gh failures while choosing are one stable result each", async () => {
  const base = fakeGh({ accounts: [{ login: "personal", active: true }], repos: { personal: PUBLIC_READ } })
  const failing = (override) => async (args, options) => override(args) ?? base.runner(args, options)
  assert.deepEqual(await chooseAccount({ store: STORE, runner: failing((args) => (args[0] === "api" ? { code: 1, stdout: "", stderr: "gh: Server Error (HTTP 500)\n" } : undefined)) }), { result: "unexpected" })
  assert.deepEqual(await chooseAccount({ store: STORE, runner: failing((args) => (args[0] === "--version" ? { code: 0, stdout: "gh version 2.20.0 (2022-11-01)\n", stderr: "" } : undefined)) }), { result: "gh_too_old" })
  assert.deepEqual(await chooseAccount({ store: STORE, runner: failing((args) => (args[1] === "status" ? { code: 0, stdout: Symbol("not text"), stderr: "" } : undefined)) }), { result: "unexpected" })
  assert.deepEqual(await chooseAccount({ store: STORE, runner: failing((args) => (args[1] === "status" ? { code: 0 } : undefined)) }), { result: "no_account_can_deliver", accounts: [] })
  await assert.rejects(chooseAccount({ store: "not a store", runner: base.runner }), /store must be/u)
})

test("factory.js account refuses a malformed store and, with the real runner and no gh on PATH, reports gh_missing", () => scratch(async ({ env, base }) => {
  let error = ""
  assert.equal(await factoryCli({ argv: ["account", "--store", "nope"], env, write: () => {}, logError: (text) => { error += text } }), 1)
  assert.match(error, /Usage: factory\.js account --store/u)
  for (const argv of [["account"], ["account", "--store"], ["account", "--repo", STORE], ["account", "--store", STORE, "--extra", "x"]]) {
    error = ""
    assert.equal(await factoryCli({ argv, env, write: () => {}, logError: (text) => { error += text } }), 1)
    assert.match(error, /Usage: factory\.js account --store/u, argv.join(" "))
  }
  let out = ""
  const code = await factoryCli({ argv: ["account", "--store", STORE], env: { ...env, PATH: base }, write: (text) => { out += text }, logError: () => {} })
  assert.equal(code, 1)
  assert.deepEqual(JSON.parse(out), { result: "gh_missing" })
}))
