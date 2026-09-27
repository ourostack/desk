import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { cardBody, fileKaizenCard } from "../../src/factory/kaizen-file.js"
import { setConsent } from "../../src/factory/outbox.js"
import { parseCard } from "../../src/factory/pipeline/kaizen.js"

const TOKEN = "ghs_SENTINEL"
const JOB = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-kaizen-file-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  const deskRoot = path.join(base, "desk")
  mkdirSync(path.join(deskRoot, "_meta"), { recursive: true })
  try {
    return await run({ env, deskRoot })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

function fakeGh({ auth = { code: 0, stdout: `${TOKEN}\n`, stderr: "" }, create = { code: 0, stdout: JSON.stringify({ number: 7, html_url: "https://github.com/ourostack/factory/issues/7" }), stderr: "" } } = {}) {
  const calls = []
  const runner = async (args, options = {}) => {
    calls.push({ args, token: options.token, input: options.input })
    if (args[0] === "auth") return auth
    return create
  }
  return { calls, runner }
}

test("cardBody appends a card block the kaizen check parses, with the signal as the hypothesis when known", () => {
  const withSignal = cardBody({ body: "Shell calls fail often.", signal: "tool_failures", evidenceJobs: [JOB] })
  assert.ok(withSignal.startsWith("Shell calls fail often.\n\n```yaml\n"))
  assert.deepEqual(parseCard(withSignal), {
    ok: true,
    card: { kaizen: 1, signal: "tool_failures", job_class: "any", evidence_jobs: [JOB], countermeasure: null, plugin: "desk", version: null, hypothesis: { measure: "tool_failures", direction: "down" } },
  })
  assert.equal(parseCard(cardBody({ body: "x", signal: "flow_efficiency", evidenceJobs: [] })).card.hypothesis.direction, "up")
  // Without a signal the card is a draft the kaizen worker completes: the check lists what is missing.
  assert.deepEqual(parseCard(cardBody({ body: "x", signal: null, evidenceJobs: [] })).errors, [{ code: "missing_key", field: "signal" }, { code: "missing_key", field: "hypothesis" }])
})

test("fileKaizenCard opens a kaizen issue in the desk's store with the consented account's token", () => scratch(async ({ env, deskRoot }) => {
  await setConsent(env, { store: "ourostack/factory", contribute: true, account: "contributor" })
  const { calls, runner } = fakeGh()
  const result = await fileKaizenCard(env, { deskRoot, title: "Shell tool calls fail often", body: "Most tool failures are shell calls.", signal: "tool_retries", evidenceJobs: [JOB], runner })
  assert.deepEqual(result, { result: "filed", store: "ourostack/factory", url: "https://github.com/ourostack/factory/issues/7" })
  assert.deepEqual(calls[0].args, ["auth", "token", "--user", "contributor"])
  const create = calls[1]
  assert.equal(create.token, TOKEN)
  assert.ok(!create.args.includes(TOKEN))
  assert.ok(create.args.includes("repos/ourostack/factory/issues"))
  const sent = JSON.parse(create.input)
  assert.equal(sent.title, "Shell tool calls fail often")
  assert.deepEqual(sent.labels, ["kaizen"])
  assert.equal(parseCard(sent.body).card.signal, "tool_retries")
}))

test("fileKaizenCard follows the desk's own store declaration", () => scratch(async ({ env, deskRoot }) => {
  writeFileSync(path.join(deskRoot, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store: "example/internal-factory" }))
  await setConsent(env, { store: "example/internal-factory", contribute: true, account: "worker" })
  const { calls, runner } = fakeGh({ create: { code: 0, stdout: JSON.stringify({ number: 1, html_url: "https://github.com/example/internal-factory/issues/1" }), stderr: "" } })
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "A generic title", body: "Body.", runner })).store, "example/internal-factory")
  assert.ok(calls[1].args.includes("repos/example/internal-factory/issues"))
  writeFileSync(path.join(deskRoot, "_meta", "factory.json"), "{ not json")
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "A generic title", body: "Body.", runner }), { result: "store_invalid" })
}))

test("fileKaizenCard files nothing without consent, an account or a token, and reports GitHub failures as codes", () => scratch(async ({ env, deskRoot }) => {
  const { calls, runner } = fakeGh()
  const input = { deskRoot, title: "A generic title", body: "Body.", runner }
  assert.deepEqual(await fileKaizenCard(env, input), { result: "not_opted_in", store: "ourostack/factory" })
  await setConsent(env, { store: "ourostack/factory", contribute: false, account: "contributor" })
  assert.deepEqual(await fileKaizenCard(env, input), { result: "not_opted_in", store: "ourostack/factory" })
  await setConsent(env, { store: "ourostack/factory", contribute: true })
  assert.deepEqual(await fileKaizenCard(env, input), { result: "no_account", store: "ourostack/factory" })
  assert.equal(calls.length, 0)
  await setConsent(env, { store: "ourostack/factory", contribute: true, account: "contributor" })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: 1, stdout: "", stderr: "no" } }).runner }), { result: "auth_failed", store: "ourostack/factory" })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: 0, stdout: " \n", stderr: "" } }).runner }), { result: "auth_failed", store: "ourostack/factory" })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: null, spawnError: "ENOENT" } }).runner }), { result: "gh_missing", store: "ourostack/factory" })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ create: { code: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)" } }).runner }), { result: "http_403", store: "ourostack/factory" })
  await assert.rejects(fileKaizenCard(env, { ...input, runner: async () => { throw new Error("boom") } }), /boom/u)
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: 0 } }).runner }), { result: "auth_failed", store: "ourostack/factory" })
  const failOnCreate = async (args) => { if (args[0] === "auth") return { code: 0, stdout: TOKEN }; throw new Error("create boom") }
  await assert.rejects(fileKaizenCard(env, { ...input, runner: failOnCreate }), /create boom/u)
}))

test("fileKaizenCard refuses a card that is not generic or not well formed, before any network call", () => scratch(async ({ env, deskRoot }) => {
  await setConsent(env, { store: "ourostack/factory", contribute: true, account: "contributor" })
  const { calls, runner } = fakeGh()
  const refuse = async (overrides) => (await fileKaizenCard(env, { deskRoot, title: "A generic title", body: "Body.", runner, ...overrides })).result
  assert.equal(await refuse({ body: "token ghp_abcdefghijklmnop1234" }), "not_generic")
  assert.equal(await refuse({ body: "see /Users/someone/code/app" }), "not_generic")
  assert.equal(await refuse({ body: "see C:\\Users\\someone\\app" }), "not_generic")
  assert.equal(await refuse({ body: "see ~/code/app" }), "not_generic")
  assert.equal(await refuse({ title: "ping someone@example.com" }), "not_generic")
  assert.equal(await refuse({ title: "" }), "invalid_title")
  assert.equal(await refuse({ title: "two\nlines" }), "invalid_title")
  assert.equal(await refuse({ title: "x".repeat(121) }), "invalid_title")
  assert.equal(await refuse({ body: 5 }), "invalid_body")
  assert.equal(await refuse({ body: "x".repeat(8001) }), "invalid_body")
  assert.equal(await refuse({ body: "a ```yaml block of its own" }), "invalid_body")
  assert.equal(await refuse({ signal: "happiness" }), "invalid_signal")
  assert.equal(await refuse({ evidenceJobs: ["nope"] }), "invalid_evidence_jobs")
  assert.equal(await refuse({ evidenceJobs: "nope" }), "invalid_evidence_jobs")
  assert.equal(calls.length, 0)
  await assert.rejects(fileKaizenCard(env, { deskRoot: "relative", title: "t", body: "b", runner }), /deskRoot/u)
}))

test("fileKaizenCard uses the real gh runner when none is injected", () => scratch(async ({ env, deskRoot }) => {
  await setConsent(env, { store: "ourostack/factory", contribute: true, account: "contributor" })
  assert.deepEqual(await fileKaizenCard({ ...env, PATH: "" }, { deskRoot, title: "A generic title", body: "Body." }), { result: "gh_missing", store: "ourostack/factory" })
}))
