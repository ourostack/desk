// The operator's factory answer recorded through the tool (`desk_doctor`'s `factory_consent` and `factory_told`): the account is resolved by Desk,
// the file written is the one `factory.js consent` writes, and a recorded decision is never overwritten. Accounts and tokens here are synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import * as path from "node:path"

import { answerFactoryConsent } from "../../../../../plugins/desk/mcp/src/factory/consent-answer.js"
import { runConsentCommand } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { consentMentioned } from "../../../../../plugins/desk/mcp/src/runtime/consent-mentioned.js"
import { resolveDeskStateDir } from "../../../../../plugins/desk/mcp/src/runtime/last-start.js"
import { setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { factoryStatus } from "../../../../../plugins/desk/mcp/src/tools/factory-context.js"
import { STORE, json, scratch } from "./_session_helpers.js"

const PUBLIC_PUSH = { visibility: "public", private: false, allow_forking: true, permissions: { push: true } }

// A gh model with `login` signed in and able to push to the store.
function fakeGh(login) {
  const calls = []
  const runner = async (args, { token } = {}) => {
    calls.push(args)
    if (args[0] === "--version") return { code: 0, stdout: "gh version 2.54.0 (2024-07-31)\n", stderr: "" }
    if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: `github.com\n  ✓ Logged in to github.com account ${login} (keyring)\n  - Active account: true\n`, stderr: "" }
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: `token-${login}\n`, stderr: "" }
    if (args[0] === "api") return token === `token-${login}` ? { code: 0, stdout: JSON.stringify(PUBLIC_PUSH), stderr: "" } : { code: 1, stdout: "{}", stderr: "gh: Not Found (HTTP 404)\n" }
    return { code: 1, stdout: "", stderr: "unexpected call\n" }
  }
  return { runner, calls }
}

const declared = (desk) => json(path.join(desk, "_meta", "factory.json"), { schema_version: 1, store: STORE })

test("yes records the account Desk finds, in the consent file factory.js writes", () => scratch(async ({ desk, env }) => {
  await declared(desk)
  const result = await answerFactoryConsent({ env, deskRoot: desk, answer: "yes", runner: fakeGh("example-user").runner })
  assert.deepEqual(result, { status: "recorded", store: STORE, contribute: true, account: "example-user" })
  const status = factoryStatus({ env, deskRoot: desk, signoff: false })
  assert.equal(status.consent, "yes")
  const again = await runConsentCommand({ argv: ["--store", STORE, "--contribute", "yes", "--account", "example-user"], env })
  assert.equal(again.account, "example-user", "the CLI reads and writes the same store")
}))

test("no records a decision without asking GitHub", () => scratch(async ({ desk, env }) => {
  await declared(desk)
  const gh = fakeGh("example-user")
  assert.deepEqual(await answerFactoryConsent({ env, deskRoot: desk, answer: "no", runner: gh.runner }), { status: "recorded", store: STORE, contribute: false })
  assert.equal(gh.calls.length, 0)
  assert.equal(factoryStatus({ env, deskRoot: desk, signoff: false }).consent, "no")
}))

test("a yes with no account that can deliver records nothing and says why", () => scratch(async ({ desk, env }) => {
  await declared(desk)
  const signedOut = async (args) => (args[0] === "--version" ? { code: 0, stdout: "gh version 2.54.0\n", stderr: "" } : { code: 0, stdout: "github.com\n", stderr: "" })
  const result = await answerFactoryConsent({ env, deskRoot: desk, answer: "yes", runner: signedOut })
  assert.equal(result.status, "not_recorded")
  assert.equal(result.result, "no_account_can_deliver")
  assert.match(result.fix, /Do not record it/u)
  assert.equal(factoryStatus({ env, deskRoot: desk, signoff: false }).consent, "undecided")
}))

test("factory_told records that the operator was told, and nothing else", () => scratch(async ({ desk, env }) => {
  await declared(desk)
  assert.deepEqual(await answerFactoryConsent({ env, deskRoot: desk, told: true }), { status: "recorded", store: STORE, told: true })
  assert.equal(consentMentioned(resolveDeskStateDir({ env }), STORE), true)
  assert.equal(factoryStatus({ env, deskRoot: desk, signoff: false }).consent, "undecided")
}))

test("a recorded decision is never overwritten, and no store means nothing to answer", () => scratch(async ({ desk, env }) => {
  await declared(desk)
  await setConsent(env, { store: STORE, contribute: false })
  const refused = await answerFactoryConsent({ env, deskRoot: desk, answer: "yes", runner: fakeGh("example-user").runner })
  assert.deepEqual([refused.status, refused.code, refused.consent], ["refused", "factory_already_decided", "no"])
  assert.equal((await answerFactoryConsent({ env, deskRoot: null, answer: "no" })).code, "factory_no_store")
  assert.equal((await answerFactoryConsent({ env, deskRoot: desk, answer: "maybe" })).code, "factory_consent_not_yes_or_no")
  assert.equal((await answerFactoryConsent({ env, deskRoot: desk, answer: "no", told: true })).code, "factory_consent_one_answer_per_call")
}))
