import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, promises as fs, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { FRICTION_CLASSES, MAX_CARDS_PER_DAY, PUBLIC_PLUGINS, cardBlock, fileKaizenCard, normalizeTitle, privateCard, publicCard } from "../../src/factory/kaizen-file.js"
import { readStatus, setConsent, updateJobsIndex, writeMarker, writeStatus } from "../../src/factory/outbox.js"
import { parseCard } from "../../src/factory/pipeline/kaizen.js"

const TOKEN = "ghs_SENTINEL"
const JOB = "9f2c4b1a7d3e5f60718293a4b5c6d7e8"
const LOCAL_JOB = "0123456789abcdef0123456789abcdef"
const STORE = "ourostack/factory"
const WORK_STORE = "example/internal-factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`

async function scratch(run) {
  const base = await fs.realpath(mkdtempSync(path.join(os.tmpdir(), "desk-kaizen-file-")))
  const env = { HOME: base, XDG_STATE_HOME: path.join(base, "state") }
  const deskRoot = path.join(base, "desk")
  mkdirSync(path.join(deskRoot, "_meta"), { recursive: true })
  try {
    return await run({ env, deskRoot, base })
  } finally {
    rmSync(base, { recursive: true, force: true })
  }
}

// A desk that declares its own store, the simplest resolved route.
function declare(deskRoot, store = STORE) {
  writeFileSync(path.join(deskRoot, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
}

async function marker(env, { n = 1, deskRoot, routing, updatedAt = new Date().toISOString() }) {
  const log = path.join(env.HOME, `${n}.jsonl`)
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: env.HOME, desk_root: deskRoot, end_reason: null, ended_at: null, plugins: [], updated_at: updatedAt, ...(routing === undefined ? {} : { routing }) })
}

// A fake gh: `auth token`, `GET repos/<store>` (visibility), the open kaizen issue list and issue creation.
function fakeGh({ auth = { code: 0, stdout: `${TOKEN}\n`, stderr: "" }, repo = { private: false }, issues = [], create = { number: 7, html_url: "https://github.com/ourostack/factory/issues/7" }, fail = {} } = {}) {
  const calls = []
  const answer = (value) => ({ code: 0, stdout: JSON.stringify(value), stderr: "" })
  const runner = async (args, options = {}) => {
    calls.push({ args, token: options.token, input: options.input })
    if (args[0] === "auth") return auth
    const route = args[7]
    const method = args[2]
    const kind = method === "POST" ? "create" : route.includes("/issues?") ? "list" : "repo"
    if (fail[kind] !== undefined) return fail[kind]
    if (kind === "repo") return answer(repo)
    if (kind === "list") return answer(issues)
    return answer(create)
  }
  const created = () => calls.filter((call) => call.args[2] === "POST").map((call) => JSON.parse(call.input))
  return { calls, runner, created }
}

const clock = (iso) => () => Date.parse(iso)

test("cardBlock is a card the kaizen check parses, with the caller's plugin and the signal as the hypothesis when known", () => {
  assert.deepEqual(parseCard(cardBlock({ plugin: "superpowers", signal: "tool_failures", evidenceJobs: [JOB] })), {
    ok: true,
    card: { kaizen: 1, signal: "tool_failures", job_class: "any", evidence_jobs: [JOB], countermeasure: null, plugin: "superpowers", version: null, hypothesis: { measure: "tool_failures", direction: "down" } },
  })
  assert.equal(parseCard(cardBlock({ plugin: "desk", signal: "flow_efficiency", evidenceJobs: [] })).card.hypothesis.direction, "up")
  // Without a signal the card is a draft the kaizen worker completes: the check lists what is missing.
  assert.deepEqual(parseCard(cardBlock({ plugin: "desk", signal: null, evidenceJobs: [] })).errors, [{ code: "missing_key", field: "signal" }, { code: "missing_key", field: "hypothesis" }])
})

test("a public card is built from structured fields only; a private card keeps the caller's text", () => {
  const open = publicCard({ plugin: "desk", frictionClass: "mcp_tool", signal: "tool_retries", evidenceJobs: [JOB], fingerprint: "ab".repeat(16) })
  assert.equal(open.title, "Kaizen: desk mcp_tool friction, tool_retries")
  assert.match(open.body, /- Plugin: `desk`\n- Friction class: `mcp_tool`\n- Measure: `tool_retries`/u)
  assert.ok(open.body.includes(`<!-- desk-kaizen-fingerprint: ${"ab".repeat(16)} -->`))
  assert.equal(parseCard(open.body).card.plugin, "desk")
  const draft = publicCard({ plugin: "crew", frictionClass: "other", signal: null, evidenceJobs: [], fingerprint: "cd".repeat(16) })
  assert.equal(draft.title, "Kaizen: crew other friction")
  assert.match(draft.body, /- Measure: not chosen yet/u)
  const closed = privateCard({ title: "  Shell calls fail  ", body: "Most failures are shell calls.\n\n", plugin: "ms-tools", signal: "tool_failures", evidenceJobs: [], fingerprint: "ef".repeat(16) })
  assert.equal(closed.title, "Shell calls fail")
  assert.ok(closed.body.startsWith("Most failures are shell calls.\n\n<!-- desk-kaizen-fingerprint: "))
  assert.equal(parseCard(closed.body).card.plugin, "ms-tools")
  assert.equal(normalizeTitle("  Shell-calls   FAIL, often! "), "shell calls fail often")
  assert.ok(FRICTION_CLASSES.includes("other") && PUBLIC_PLUGINS.includes("desk") && MAX_CARDS_PER_DAY === 5)
})

test("to a public store the card carries no free text, and the caller's text never leaves the machine", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const { calls, runner, created } = fakeGh()
  const secretText = "Repo acme/internal-billing broke on 2026-09-01 for @someone"
  const result = await fileKaizenCard(env, { deskRoot, title: "Internal billing shell calls fail", body: secretText, plugin: "desk", frictionClass: "mcp_tool", signal: "tool_retries", evidenceJobs: [JOB], runner, now: clock("2026-09-27T10:00:00Z") })
  assert.deepEqual(result, { result: "filed", store: STORE, url: "https://github.com/ourostack/factory/issues/7", visibility: "public" })
  assert.deepEqual(calls[0].args, ["auth", "token", "--user", "contributor"])
  const [sent] = created()
  assert.equal(sent.title, "Kaizen: desk mcp_tool friction, tool_retries")
  assert.deepEqual(sent.labels, ["kaizen"])
  assert.ok(!JSON.stringify(calls).includes("billing") && !JSON.stringify(calls).includes("someone"))
  for (const call of calls) assert.ok(!call.args.includes(TOKEN))
  assert.ok(calls.slice(1).every((call) => call.token === TOKEN))
  assert.deepEqual((await readStatus(env)).kaizen_filed, { [STORE]: ["2026-09-27T10:00:00.000Z"] })
}))

test("a store GitHub does not report as private is treated as public", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot, WORK_STORE)
  await setConsent(env, { store: WORK_STORE, contribute: true, account: "worker" })
  const { runner, created } = fakeGh({ repo: {} })
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "A title", body: "Private words.", runner })).visibility, "unknown")
  assert.equal(created()[0].title, "Kaizen: desk other friction")
}))

test("to a private store the card keeps the free text and may name any plugin", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot, WORK_STORE)
  await setConsent(env, { store: WORK_STORE, contribute: true, account: "worker" })
  const { runner, created } = fakeGh({ repo: { private: true }, create: { number: 1, html_url: "https://github.com/example/internal-factory/issues/1" } })
  await updateJobsIndex(env, LOCAL_JOB, "claude-code-x.json")
  const result = await fileKaizenCard(env, { deskRoot, title: "Work overlay loses the MCP", body: "The overlay drops the MCP.", plugin: "ms-tools", frictionClass: "hook", signal: "tool_failures", evidenceJobs: [LOCAL_JOB], runner })
  assert.deepEqual(result, { result: "filed", store: WORK_STORE, url: "https://github.com/example/internal-factory/issues/1", visibility: "private" })
  const [sent] = created()
  assert.equal(sent.title, "Work overlay loses the MCP")
  assert.ok(sent.body.startsWith("The overlay drops the MCP.\n\n"))
  assert.deepEqual(parseCard(sent.body).card.evidence_jobs, [LOCAL_JOB])
}))

test("a public store refuses a plugin outside the public list and this machine's plain local job IDs", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await updateJobsIndex(env, LOCAL_JOB, "claude-code-x.json")
  const { runner, created } = fakeGh()
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "A title", body: "b", plugin: "ms-tools", runner }), { result: "plugin_not_public", store: STORE })
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "A title", body: "b", evidenceJobs: [JOB, LOCAL_JOB], runner }), { result: "evidence_jobs_local", store: STORE })
  assert.equal(created().length, 0)
}))

test("the route is the facts route: the desk's declaration, else the session's recorded routing, else nothing is filed", () => scratch(async ({ env, deskRoot, base }) => {
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(env, { store: WORK_STORE, contribute: true, account: "worker" })
  const { runner, created } = fakeGh({ repo: { private: true } })
  // No desk file and no recorded session: the overlay's declaration cannot be read here, so nothing is filed anywhere.
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "A title", body: "b", runner }), { result: "route_unknown" })
  // A marker for another desk, or one without routing, does not count.
  await marker(env, { n: 1, deskRoot: path.join(base, "other"), routing: { source: "overlay", store: STORE, warnings: [] } })
  await marker(env, { n: 2, deskRoot })
  await marker(env, { n: 3, deskRoot: null })
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "A title", body: "b", runner }), { result: "route_unknown" })
  // An overlay declaration recorded at session start wins over the public default, and the newest session decides.
  await marker(env, { n: 4, deskRoot, routing: { source: "default", store: STORE, warnings: [] }, updatedAt: "2026-09-26T10:00:00.000Z" })
  await marker(env, { n: 5, deskRoot, routing: { source: "overlay", store: WORK_STORE, warnings: [] }, updatedAt: new Date().toISOString() })
  await marker(env, { n: 6, deskRoot, routing: { source: "default", store: STORE, warnings: [] }, updatedAt: "2026-09-26T10:00:00.000Z" })
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "A title", body: "b", runner })).store, WORK_STORE)
  // A session whose scan could not read every manifest recorded no store: fail closed.
  await marker(env, { n: 7, deskRoot, routing: { source: "invalid_declaration", store: null, warnings: [] }, updatedAt: new Date(Date.now() + 1000).toISOString() })
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "B title", body: "b", runner }), { result: "store_invalid" })
  // The desk's own declaration decides over any recorded routing; an unreadable one files nothing.
  declare(deskRoot, STORE)
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "C title", body: "b", runner })).store, STORE)
  writeFileSync(path.join(deskRoot, "_meta", "factory.json"), "{ not json")
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "D title", body: "b", runner }), { result: "store_invalid" })
  assert.equal(created().length, 2)
}))

test("a retry finds the open card by its fingerprint and files nothing again", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  const first = fakeGh()
  await fileKaizenCard(env, { deskRoot, title: "Shell calls fail often", body: "b", frictionClass: "mcp_tool", runner: first.runner })
  const body = first.created()[0].body
  const existing = { number: 7, html_url: "https://github.com/ourostack/factory/issues/7", title: "t", body, labels: [{ name: "kaizen" }], state: "open", user: { login: "contributor" } }
  // The same friction in other words normalizes to the same fingerprint.
  const retry = fakeGh({ issues: [existing] })
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "shell calls: FAIL often!", body: "other words", frictionClass: "mcp_tool", runner: retry.runner }), { result: "duplicate", store: STORE, url: existing.html_url, visibility: "public" })
  assert.equal(retry.created().length, 0)
  // Another author's issue, a pull request or another class is not this card.
  const others = fakeGh({ issues: [{ ...existing, user: { login: "someone-else" } }, { ...existing, pull_request: {} }] })
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "Shell calls fail often", body: "b", frictionClass: "mcp_tool", runner: others.runner })).result, "filed")
  const otherClass = fakeGh({ issues: [existing] })
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "Shell calls fail often", body: "b", frictionClass: "hook", runner: otherClass.runner })).result, "filed")
}))

test("at most five cards go to one store in any 24 hours", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  await writeStatus(env, { kaizen_filed: { [STORE]: ["2026-09-26T09:00:00.000Z", 5, "2026-09-26T11:00:00.000Z", "2026-09-26T12:00:00.000Z", "2026-09-26T13:00:00.000Z"], [WORK_STORE]: "not a list" } })
  const { runner, created } = fakeGh()
  const at = clock("2026-09-27T10:00:00Z")
  // The 09:00 filing is more than 24 hours old and the malformed entry is ignored: three count.
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "One", body: "b", runner, now: at })).result, "filed")
  assert.equal((await fileKaizenCard(env, { deskRoot, title: "Two", body: "b", runner, now: at })).result, "filed")
  assert.deepEqual(await fileKaizenCard(env, { deskRoot, title: "Three", body: "b", runner, now: at }), { result: "held_cap", store: STORE })
  assert.equal(created().length, 2)
  assert.equal((await readStatus(env)).kaizen_filed[STORE].length, 5)
  assert.equal((await readStatus(env)).kaizen_filed[WORK_STORE], "not a list")
}))

test("nothing is filed without consent, an account or a token, and GitHub failures come back as codes", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot)
  const { calls, runner } = fakeGh()
  const input = { deskRoot, title: "A generic title", body: "Body.", runner }
  assert.deepEqual(await fileKaizenCard(env, input), { result: "not_opted_in", store: STORE })
  await setConsent(env, { store: STORE, contribute: false, account: "contributor" })
  assert.deepEqual(await fileKaizenCard(env, input), { result: "not_opted_in", store: STORE })
  await setConsent(env, { store: STORE, contribute: true })
  assert.deepEqual(await fileKaizenCard(env, input), { result: "no_account", store: STORE })
  assert.equal(calls.length, 0)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: 1, stdout: "", stderr: "no" } }).runner }), { result: "auth_failed", store: STORE })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: 0, stdout: " \n", stderr: "" } }).runner }), { result: "auth_failed", store: STORE })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: 0 } }).runner }), { result: "auth_failed", store: STORE })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ auth: { code: null, spawnError: "ENOENT" } }).runner }), { result: "gh_missing", store: STORE })
  const forbidden = { code: 1, stdout: "", stderr: "gh: Forbidden (HTTP 403)" }
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ fail: { repo: forbidden } }).runner }), { result: "http_403", store: STORE })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ fail: { list: forbidden } }).runner }), { result: "http_403", store: STORE })
  assert.deepEqual(await fileKaizenCard(env, { ...input, runner: fakeGh({ fail: { create: forbidden } }).runner }), { result: "http_403", store: STORE })
  // A failed create records no filing.
  assert.equal((await readStatus(env)).kaizen_filed, undefined)
  await assert.rejects(fileKaizenCard(env, { ...input, runner: async () => { throw new Error("boom") } }), /boom/u)
  const failAfterAuth = async (args) => { if (args[0] === "auth") return { code: 0, stdout: TOKEN }; throw new Error("api boom") }
  await assert.rejects(fileKaizenCard(env, { ...input, runner: failAfterAuth }), /api boom/u)
}))

test("malformed input is refused before any network call, and text that looks private is refused before it is sent", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot, WORK_STORE)
  await setConsent(env, { store: WORK_STORE, contribute: true, account: "worker" })
  const { calls, runner, created } = fakeGh({ repo: { private: true } })
  const refuse = async (overrides) => (await fileKaizenCard(env, { deskRoot, title: "A generic title", body: "Body.", runner, ...overrides })).result
  assert.equal(await refuse({ title: "" }), "invalid_title")
  assert.equal(await refuse({ title: 5 }), "invalid_title")
  assert.equal(await refuse({ title: "two\nlines" }), "invalid_title")
  assert.equal(await refuse({ title: "x".repeat(121) }), "invalid_title")
  assert.equal(await refuse({ body: 5 }), "invalid_body")
  assert.equal(await refuse({ body: "x".repeat(8001) }), "invalid_body")
  assert.equal(await refuse({ body: "a ```yaml block of its own" }), "invalid_body")
  assert.equal(await refuse({ plugin: "Not A Plugin" }), "invalid_plugin")
  assert.equal(await refuse({ plugin: 5 }), "invalid_plugin")
  assert.equal(await refuse({ frictionClass: "vibes" }), "invalid_friction_class")
  assert.equal(await refuse({ signal: "happiness" }), "invalid_signal")
  assert.equal(await refuse({ evidenceJobs: ["nope"] }), "invalid_evidence_jobs")
  assert.equal(await refuse({ evidenceJobs: "nope" }), "invalid_evidence_jobs")
  assert.equal(await refuse({ evidenceJobs: Array(101).fill(JOB) }), "invalid_evidence_jobs")
  assert.equal(calls.length, 0)
  await assert.rejects(fileKaizenCard(env, { deskRoot: "relative", title: "t", body: "b", runner }), /deskRoot/u)
  // Defence in depth on what would be sent, even to a private store.
  assert.equal(await refuse({ body: "token ghp_abcdefghijklmnop1234" }), "not_generic")
  assert.equal(await refuse({ body: "see /Users/someone/code/app" }), "not_generic")
  assert.equal(await refuse({ body: "see C:\\Users\\someone\\app" }), "not_generic")
  assert.equal(await refuse({ body: "see ~/code/app" }), "not_generic")
  assert.equal(await refuse({ title: "ping someone@example.com" }), "not_generic")
  assert.equal(await refuse({ title: "ghp_abcdefghijklmnop1234" }), "not_generic")
  assert.equal(created().length, 0)
}))

test("the real gh runner is used when none is injected", () => scratch(async ({ env, deskRoot }) => {
  declare(deskRoot)
  await setConsent(env, { store: STORE, contribute: true, account: "contributor" })
  assert.deepEqual(await fileKaizenCard({ ...env, PATH: "" }, { deskRoot, title: "A generic title", body: "Body." }), { result: "gh_missing", store: STORE })
}))
