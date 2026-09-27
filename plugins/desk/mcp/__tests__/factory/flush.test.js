// Delivery: the flush that turns the local outbox into one intake pull request
// per machine per store. Every GitHub interaction goes through an injected
// runner backed by an in-memory model (`_fake_github.js`); nothing here reaches
// the network or a real account, and every fixture is synthetic.

import { test } from "node:test"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHmac } from "node:crypto"
import { existsSync, promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  factoryStateRoot, gitBlobSha, readConsent, readMachineSecret, readStatus, readVisibilityCache, setConsent, writeLocalFacts, writeMarker, writeStatus,
} from "../../src/factory/outbox.js"
import { serializePublished, toPublished } from "../../src/factory/publish.js"
import { validatePublishedBytes } from "../../src/factory/published-schema.js"
import { jobId } from "../../src/factory/binding.js"
import { BOT, TOKEN, fakeGitHub, httpError } from "./_fake_github.js"
import { STORE, scratch } from "./_session_helpers.js"

const moduleUrl = new URL("../../src/factory/flush.js", import.meta.url)
async function load() {
  assert.ok(existsSync(moduleUrl), "the flush module must exist")
  return import(moduleUrl)
}

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const ACCOUNT = "contributor"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n) => `claude-code-${sessionId(n)}.json`
const DAY = 24 * 60 * 60 * 1000

function localFacts(n, patch = {}) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  return { ...value, ...patch }
}

async function optIn(env, account = ACCOUNT) {
  return setConsent(env, { store: STORE, contribute: true, account })
}

async function intakeBranch(env) {
  return `intake/${(await readConsent(env)).stores[STORE].intake_id}`
}

async function put(env, facts) {
  const written = await writeLocalFacts(env, STORE, facts)
  assert.equal(written.written, true, JSON.stringify(written))
  return written.name
}

async function allFiles(dir) {
  const out = []
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...await allFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

const apiCalls = (github, method, pattern) => github.calls.filter((call) => call.args[0] === "api" && call.args[call.args.indexOf("--method") + 1] === method && pattern.test(call.args.find((arg) => /^repos\//u.test(arg)) ?? ""))

async function publishedFor(env, facts, { deskVisibility = "unknown", visibility = () => "unknown" } = {}) {
  const { published } = toPublished(facts, { visibility, deskVisibility, machineSecret: await readMachineSecret(env) })
  return serializePublished(published)
}

// ---------------------------------------------------------------------------
// Consent, account and an empty outbox never reach the network.
// ---------------------------------------------------------------------------

test("flush without consent, with a declined store or without an account records a stable code and never runs gh", () => scratch(async ({ env }) => {
  const { flush, FLUSH_CODES } = await load()
  assert.deepEqual([...FLUSH_CODES].sort(), ["account_cannot_deliver", "auth_failed", "deadline", "delivered_pr_open", "fork_pending", "gh_missing", "gh_too_old", "intake_stale_retried", "locked", "no_account", "not_opted_in", "nothing_pending", "offline", "rate_limited", "store_missing", "unexpected"])
  const github = fakeGitHub()
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "not_opted_in" })
  assert.equal(existsSync(path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", "factory")), false, "flushing never creates factory state")
  await setConsent(env, { store: STORE, contribute: false, account: ACCOUNT })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "not_opted_in" })
  await setConsent(env, { store: STORE, contribute: true, account: null })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "no_account" })
  await optIn(env)
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "nothing_pending" })
  assert.equal(github.calls.length, 0)
  const status = await readStatus(env)
  assert.equal(status.last_flush[STORE].result, "nothing_pending")
  assert.deepEqual(Object.keys(status.last_flush[STORE]).sort(), ["at", "result"])
  assert.deepEqual(await flush(env, { store: "not a store", runner: github.runner }), { result: "unexpected" })
}))

// ---------------------------------------------------------------------------
// The direct push path, PR reuse, exact-head updates and delivery.
// ---------------------------------------------------------------------------

test("with push permission one tree, one commit and one intake branch become one Factory intake PR whose body is the file count", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const first = await put(env, localFacts(1))
  const second = await put(env, localFacts(2))
  const github = fakeGitHub()
  const result = await flush(env, { store: STORE, runner: github.runner })
  assert.deepEqual(result, { result: "delivered_pr_open", pr: { number: 101, url: `https://github.com/${STORE}/pull/101` } })
  const branch = await intakeBranch(env)
  assert.match(branch, /^intake\/[0-9a-f]{16}$/u)
  const [pr] = github.pulls
  assert.equal(pr.title, "Factory intake")
  assert.equal(pr.body, "2")
  assert.equal(pr.head.label, `ourostack:${branch}`)
  assert.equal(pr.base.ref, "main")
  const head = github.headFacts(STORE, branch)
  for (const [n, name] of [[1, first], [2, second]]) {
    const bytes = await publishedFor(env, localFacts(n))
    assert.equal(head.get(name).sha, gitBlobSha(Buffer.from(bytes)))
    assert.deepEqual(validatePublishedBytes(Buffer.from(github.blobs.get(head.get(name).sha))), { ok: true, errors: [] })
    assert.doesNotMatch(github.blobs.get(head.get(name).sha), /\d{4}-\d{2}-\d{2}/u)
  }
  const commit = github.commit(github.ref(STORE, branch))
  assert.equal(commit.message, "Factory intake")
  assert.deepEqual(commit.parents, [github.storeMain()])
  assert.equal(apiCalls(github, "POST", /\/git\/trees$/u).length, 1)
  assert.equal(apiCalls(github, "POST", /\/git\/commits$/u).length, 1)
  assert.equal(apiCalls(github, "POST", /\/git\/refs$/u).length, 1)
  assert.equal(apiCalls(github, "POST", /\/forks$/u).length, 0)
  // Nothing about the work appears in titles, bodies, branch names or commit messages.
  for (const call of github.calls) for (const text of [call.input ?? "", ...call.args]) assert.doesNotMatch(text, /eng-workflow|task|track|slug/iu)
  const status = await readStatus(env)
  assert.equal(status.last_flush[STORE].result, "delivered_pr_open")
  assert.equal(status.last_flush[STORE].pr, 101)
}))

test("an unchanged second flush reuses the open PR and leaves the intake branch exactly where it was", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub()
  await flush(env, { store: STORE, runner: github.runner })
  const branch = await intakeBranch(env)
  const head = github.ref(STORE, branch)
  const before = github.calls.length
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  const later = github.calls.slice(before)
  assert.equal(github.pulls.length, 1)
  assert.equal(github.ref(STORE, branch), head)
  assert.equal(later.filter((call) => /\/git\/(commits|refs)(\/|$)/u.test(call.args.join(" ")) && call.args.includes("POST")).length, 0)
  assert.equal(later.filter((call) => call.args.includes("PATCH")).length, 0)
}))

test("a changed file force-updates only the task-owned intake branch to the exact new commit and refreshes the PR body", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub()
  await flush(env, { store: STORE, runner: github.runner })
  const branch = await intakeBranch(env)
  const old = github.ref(STORE, branch)
  await put(env, localFacts(2))
  const result = await flush(env, { store: STORE, runner: github.runner })
  assert.equal(result.result, "delivered_pr_open")
  assert.equal(result.pr.number, 101)
  const updated = github.ref(STORE, branch)
  assert.notEqual(updated, old)
  const patches = apiCalls(github, "PATCH", /\/git\/refs\//u)
  assert.equal(patches.length, 1)
  assert.ok(patches[0].args.includes(`repos/${STORE}/git/refs/heads/${branch}`))
  assert.deepEqual(JSON.parse(patches[0].input), { sha: updated, force: true })
  assert.equal(github.pulls[0].body, "2")
  assert.equal(github.ref(STORE, "main"), github.storeMain())
}))

test("a ref update that does not land on the exact new commit is unexpected", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub({
    intercept: (call) => (call.args.includes("POST") && call.args.some((arg) => /\/git\/refs$/u.test(arg))
      ? { code: 0, stdout: JSON.stringify({ object: { sha: "f".repeat(40) } }), stderr: "" } : undefined),
  })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "unexpected" })
  assert.equal(github.pulls.length, 0)
}))

test("files already on the store's main with the exact published blob are marked delivered and never re-sent", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  const github = fakeGitHub()
  await flush(env, { store: STORE, runner: github.runner })
  github.mergeOpenPr()
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "nothing_pending" })
  const root = await factoryStateRoot(env)
  const delivered = JSON.parse(await fs.readFile(path.join(root, "delivered", "ourostack__factory.json"), "utf8"))
  assert.equal(delivered[name], gitBlobSha(Buffer.from(await publishedFor(env, localFacts(1)))))
  const before = github.calls.length
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "nothing_pending" })
  assert.equal(github.calls.length, before, "a delivered, unchanged outbox needs no network at all")
}))

test("a file whose bytes on main differ from this transform is sent again", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  const github = fakeGitHub({ mainFacts: { [name]: "{\"older\":true}\n" } })
  const result = await flush(env, { store: STORE, runner: github.runner })
  assert.equal(result.result, "delivered_pr_open")
  assert.equal(github.pulls[0].body, "1")
}))

test("a batch never exceeds the file or byte cap; the rest waits for the next flush", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  for (const n of [1, 2, 3]) await put(env, localFacts(n))
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, maxFiles: 2 })).result, "delivered_pr_open")
  assert.equal(github.pulls[0].body, "2")
  assert.equal(github.headFacts(STORE, await intakeBranch(env)).size, 2)
  const bytes = Buffer.byteLength(await publishedFor(env, localFacts(1)))
  const small = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: small.runner, maxBytes: bytes + 1 })).result, "delivered_pr_open")
  assert.equal(small.pulls[0].body, "1")
}))

// ---------------------------------------------------------------------------
// The fork path.
// ---------------------------------------------------------------------------

test("without push permission the flush creates a default-branch-only fork and reports fork_pending until it is ready", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub({ push: false })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "fork_pending" })
  const forks = apiCalls(github, "POST", /\/forks$/u)
  assert.equal(forks.length, 1)
  assert.deepEqual(JSON.parse(forks[0].input), { default_branch_only: true })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "fork_pending" })
  assert.equal(apiCalls(github, "POST", /\/forks$/u).length, 1, "an existing fork is found, not created again")
  github.setForkReady()
  const result = await flush(env, { store: STORE, runner: github.runner })
  assert.equal(result.result, "delivered_pr_open")
  const branch = await intakeBranch(env)
  assert.equal(apiCalls(github, "POST", /\/merge-upstream$/u).length, 1)
  assert.equal(github.pulls[0].head.label, `${ACCOUNT}:${branch}`)
  assert.equal(github.headFacts(github.forkName, branch).size, 1)
  assert.equal(github.ref(STORE, branch), null, "nothing is pushed to the store itself")
  assert.equal((await readStatus(env)).last_flush[STORE].result, "delivered_pr_open")
}))

test("a fork that is ready at creation is used in the same flush, and a same-named non-fork is never used", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub({ push: false, forkReadyOnCreate: true, visibility: { [`${ACCOUNT}/factory`]: "public" } })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.equal(apiCalls(github, "POST", /\/forks$/u).length, 1)
}))

test("a fork answer that is not a repository name, or a failed upstream merge, is unexpected", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const odd = fakeGitHub({ push: false, intercept: (call) => (call.args.some((arg) => /\/forks$/u.test(arg)) ? { code: 0, stdout: JSON.stringify({ full_name: "../../x" }), stderr: "" } : undefined) })
  assert.deepEqual(await flush(env, { store: STORE, runner: odd.runner }), { result: "unexpected" })
  const conflict = fakeGitHub({ push: false, fork: "ready", intercept: (call) => (call.args.some((arg) => /merge-upstream$/u.test(arg)) ? httpError(409, "Conflict") : undefined) })
  assert.deepEqual(await flush(env, { store: STORE, runner: conflict.runner }), { result: "unexpected" })
  const forbidden = fakeGitHub({ push: false, visibility: { [`${ACCOUNT}/factory`]: 403 } })
  assert.deepEqual(await flush(env, { store: STORE, runner: forbidden.runner }), { result: "unexpected" })
}))

// ---------------------------------------------------------------------------
// Visibility, private references and the desk's own visibility.
// ---------------------------------------------------------------------------

test("visibility is resolved with the account token, cached for seven days, and only public references are published", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const refs = {
    prs: [{ repo: "acme/open", number: 1 }, { repo: "acme/secret", number: 2 }, { repo: "acme/gone", number: 3 }, { repo: "acme/hidden", number: 4 }],
    commits: [{ repo: "acme/open", sha: "a".repeat(40) }, { repo: "acme/secret", sha: "b".repeat(40) }],
    unresolved: { prs: 0, commits: 0 },
  }
  const name = await put(env, localFacts(1, { refs }))
  let clock = Date.parse("2026-09-27T10:00:00.000Z")
  const now = () => clock
  const github = fakeGitHub({ visibility: { "acme/open": "public", "acme/secret": "private", "acme/hidden": 403 } })
  assert.equal((await flush(env, { store: STORE, runner: github.runner, now })).result, "delivered_pr_open")
  const lookups = apiCalls(github, "GET", /^repos\/acme\/[a-z]+$/u)
  assert.deepEqual(lookups.map((call) => call.args.at(-1)).sort(), ["repos/acme/gone", "repos/acme/hidden", "repos/acme/open", "repos/acme/secret"])
  assert.ok(lookups.every((call) => call.token === TOKEN))
  const published = JSON.parse(github.blobs.get(github.headFacts(STORE, await intakeBranch(env)).get(name).sha))
  assert.deepEqual(published.refs.prs, [{ repo: "acme/open", number: 1 }])
  assert.deepEqual(published.refs.commits, [{ repo: "acme/open", sha: "a".repeat(40) }])
  assert.deepEqual(published.refs.private, { prs: 3, commits: 1 })
  assert.doesNotMatch(JSON.stringify(published), /secret|hidden|gone/u)
  const cache = await readVisibilityCache(env, { now: () => new Date(clock).toISOString() })
  assert.deepEqual(Object.fromEntries(Object.entries(cache).map(([key, value]) => [key, value.visibility])), { "acme/gone": "unknown", "acme/hidden": "unknown", "acme/open": "public", "acme/secret": "private" })
  const before = github.calls.length
  clock += 6 * DAY
  await flush(env, { store: STORE, runner: github.runner, now })
  assert.equal(apiCalls({ calls: github.calls.slice(before) }, "GET", /^repos\/acme\//u).length, 0, "a fresh cache needs no lookup")
  const after = github.calls.length
  clock += 2 * DAY
  await flush(env, { store: STORE, runner: github.runner, now })
  assert.equal(apiCalls({ calls: github.calls.slice(after) }, "GET", /^repos\/acme\//u).length, 4, "an expired entry is looked up again")
}))

async function deskRepository(base, remote) {
  const desk = path.join(base, `desk-${Math.random().toString(16).slice(2)}`)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  execFileSync("git", ["init", "-q", desk])
  if (remote) execFileSync("git", ["-C", desk, "remote", "add", "origin", remote])
  return fs.realpath(desk)
}

async function markerFor(env, desk, n) {
  const log = path.join(desk, "..", `log-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: desk, desk_root: desk, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
}

test("a public or unknown desk publishes machine-keyed job IDs without timing; a private desk keeps its job clock", () => scratch(async ({ base, env }) => {
  const { flush } = await load()
  await optIn(env)
  const publicDesk = await deskRepository(base, "git@github.com:Acme/Public-Desk.git")
  const privateDesk = await deskRepository(base, "https://github.com/acme/private-desk.git")
  const unknownDesk = await deskRepository(base, "https://example.invalid/acme/desk.git")
  const noOrigin = await deskRepository(base, null)
  await markerFor(env, publicDesk, 1)
  await markerFor(env, privateDesk, 2)
  await markerFor(env, unknownDesk, 3)
  await markerFor(env, noOrigin, 5)
  await markerFor(env, publicDesk, 6)
  const unbound = path.join(base, "log-7.jsonl")
  await fs.writeFile(unbound, "{}\n")
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(7), log_path: unbound, cwd: base, desk_root: null, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString() })
  const withNullRepo = localFacts(4, { refs: { prs: [], commits: [{ repo: null, sha: "c".repeat(40) }], unresolved: { prs: 0, commits: 0 } } })
  const names = [await put(env, localFacts(1)), await put(env, localFacts(2)), await put(env, localFacts(3)), await put(env, withNullRepo), await put(env, localFacts(5)), await put(env, localFacts(6))]
  const github = fakeGitHub({ visibility: { "acme/public-desk": "public", "acme/private-desk": "private" } })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.equal(apiCalls(github, "GET", /example\.invalid/u).length, 0, "only GitHub remotes are looked up")
  const head = github.headFacts(STORE, await intakeBranch(env))
  const read = (name) => JSON.parse(github.blobs.get(head.get(name).sha))
  const secret = await readMachineSecret(env)
  const keyed = (job) => createHmac("sha256", secret).update(job).digest("hex").slice(0, 32)
  const plain = GOLDEN.jobs.map((job) => job.job)
  for (const name of [names[0], names[2], names[3], names[4], names[5]]) {
    const published = read(name)
    assert.deepEqual(published.jobs.map((job) => job.job).sort(), plain.map(keyed).sort())
    assert.ok(published.jobs.every((job) => job.session_offset_ms === null))
    assert.ok(published.unavailable.some((entry) => entry.field === "job_offsets" && entry.reason === "desk_public"))
  }
  const privatePublished = read(names[1])
  assert.deepEqual(privatePublished.jobs.map((job) => job.job), plain)
  assert.equal(privatePublished.jobs[0].session_offset_ms, 86400000)
}))

// ---------------------------------------------------------------------------
// Quarantine: transform refusals, schema failures and store rejections.
// ---------------------------------------------------------------------------

test("sessions the transform refuses or the published gate rejects are quarantined with stable codes and never sent", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const early = localFacts(1)
  early.session.started_at = "2020-01-01T00:00:00.000Z"
  early.intervals = []
  const refusedEarly = await put(env, early)
  const notV4 = localFacts(2)
  notV4.session.id = "3b0c1f5e-8a1d-1c2e-9f3a-1b2c3d4e5f60"
  const refusedId = await put(env, notV4)
  const good = await put(env, localFacts(3))
  const dated = await put(env, localFacts(4))
  const root = await factoryStateRoot(env)
  const invalid = "claude-code-00000005-0000-4000-8000-000000000005.json"
  await fs.writeFile(path.join(root, "outbox", "ourostack__factory", invalid), `${JSON.stringify({ schema: "desk.factory.facts/1" })}\n`, { mode: 0o600 })
  const mismatch = "claude-code-00000006-0000-4000-8000-000000000006.json"
  await fs.writeFile(path.join(root, "outbox", "ourostack__factory", mismatch), `${JSON.stringify(localFacts(7))}\n`, { mode: 0o600 })
  const brokenName = "claude-code-00000008-0000-4000-8000-000000000008.json"
  const broken = localFacts(8)
  broken.schema = "desk.factory.facts/1"
  await fs.writeFile(path.join(root, "outbox", "ourostack__factory", brokenName), `${JSON.stringify(broken)}\n`, { mode: 0o600 })
  const transform = (local, options) => {
    assert.equal(options.visibility("Never/Seen"), "unknown")
    const out = toPublished(local, options)
    if (local.session.id === sessionId(4)) out.published.models[0].id = "model-2026-09-27"
    return out
  }
  const github = fakeGitHub()
  assert.equal((await flush(env, { store: STORE, runner: github.runner, transform })).result, "delivered_pr_open")
  const reasons = {}
  for (const name of await fs.readdir(path.join(root, "quarantine", "ourostack__factory"))) {
    reasons[name] = JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", name), "utf8")).reason
  }
  assert.deepEqual(reasons, { [refusedEarly]: "implausible_session_span", [refusedId]: "session_id_not_v4", [dated]: "date", [invalid]: "invalid", [mismatch]: "invalid", [brokenName]: "invalid" })
  const head = github.headFacts(STORE, await intakeBranch(env))
  assert.deepEqual([...head.keys()], [good])
  assert.equal(github.pulls[0].body, "1")
}))

test("a closed intake PR rejected by the store's automation quarantines exactly its files with the posted code", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const first = await put(env, localFacts(1))
  const github = fakeGitHub()
  await flush(env, { store: STORE, runner: github.runner })
  github.rejectOpenPr("factory-rejected: date\nfactory-rejected: pattern")
  const second = await put(env, localFacts(2))
  const result = await flush(env, { store: STORE, runner: github.runner })
  assert.equal(result.result, "delivered_pr_open")
  const root = await factoryStateRoot(env)
  const record = JSON.parse(await fs.readFile(path.join(root, "quarantine", "ourostack__factory", first), "utf8"))
  assert.equal(record.reason, "date")
  const open = github.pulls.find((pr) => pr.state === "open")
  assert.equal(open.body, "1")
  assert.deepEqual([...github.headFacts(STORE, await intakeBranch(env)).keys()], [second])
  const status = await readStatus(env)
  assert.equal(status.last_flush[STORE].rejections_through, 101)
  const before = github.calls.length
  await flush(env, { store: STORE, runner: github.runner })
  assert.equal(apiCalls({ calls: github.calls.slice(before) }, "GET", /\/issues\/\d+\/comments$/u).length, 0, "a PR already read is not read again")
}))

test("rejection reading ignores other authors, merged PRs, other heads and codes not on the first line", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  const branch = await intakeBranch(env)
  const github = fakeGitHub()
  github.addClosedPr({ comment: "factory-rejected: date", commentBy: "someone", fileNames: [name], headLabel: `ourostack:${branch}` })
  github.addClosedPr({ comment: "summary\nfactory-rejected: date", fileNames: [name], headLabel: `ourostack:${branch}` })
  github.addClosedPr({ comment: "factory-rejected: date", fileNames: [name], merged: true, headLabel: `ourostack:${branch}` })
  github.addClosedPr({ comment: "factory-rejected: Bad Code", fileNames: [name], headLabel: `ourostack:${branch}` })
  github.addClosedPr({ comment: "factory-rejected: date", fileNames: [name], headLabel: "ourostack:intake/ffffffffffffffff" })
  github.addClosedPr({ comment: "factory-rejected: pattern", fileNames: ["../../outside.json", "README.md", "facts/nested/x.json"], headLabel: `ourostack:${branch}` })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.equal(existsSync(path.join(await factoryStateRoot(env), "quarantine")), false)
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_through, 106)
}))

// ---------------------------------------------------------------------------
// Candidate-controlled store data is read as data only.
// ---------------------------------------------------------------------------

test("store trees are data: odd names, non-blob entries and hostile paths neither run anything nor mark anything delivered", () => scratch(async ({ base, env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  const sha = gitBlobSha(Buffer.from(await publishedFor(env, localFacts(1))))
  const github = fakeGitHub({
    extraMainEntries: [
      [name, { type: "commit", sha }],
      ["../../escape.json", { type: "blob", sha }],
      ["package.json", { type: "blob", sha: "c".repeat(40) }],
      [".github", { type: "tree", sha: "d".repeat(40) }],
    ],
  })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.ok(github.calls.every((call) => ["api", "auth", "--version"].includes(call.args[0])))
  assert.equal(existsSync(path.join(await factoryStateRoot(env), "delivered")), false)
  assert.equal(existsSync(path.join(base, "escape.json")), false)
}))

test("a store whose main has no facts folder, or a facts entry that is not a tree, delivers everything as new", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  let replaced = false
  const github = fakeGitHub({
    intercept: (call) => {
      const route = call.args.find((arg) => /^repos\//u.test(arg)) ?? ""
      if (call.args.includes("GET") && /\/git\/trees\//u.test(route) && !replaced) {
        replaced = true
        return { code: 0, stdout: JSON.stringify({ sha: route.split("/").at(-1), truncated: false, tree: [{ path: "facts", type: "blob", sha: "e".repeat(40) }, "junk", null] }), stderr: "" }
      }
      return undefined
    },
  })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
}))

// ---------------------------------------------------------------------------
// Every failure code.
// ---------------------------------------------------------------------------

const FAILURES = [
  ["gh_missing", { intercept: (call) => (call.args[0] === "--version" ? { code: null, stdout: "", stderr: "", spawnError: "ENOENT" } : undefined) }],
  ["gh_missing", { intercept: (call) => (call.args[0] === "--version" ? { code: 127, stdout: "", stderr: "" } : undefined) }],
  ["gh_too_old", { version: "gh version 2.39.9 (2023-11-01)\n" }],
  ["gh_too_old", { version: "not a version\n" }],
  ["auth_failed", { account: "someone-else" }],
  ["auth_failed", { intercept: (call) => (call.args[0] === "auth" ? { code: 0, stdout: "\n", stderr: "" } : undefined) }],
  ["auth_failed", { intercept: (call) => (call.args[0] === "api" ? httpError(401, "Bad credentials") : undefined) }],
  ["store_missing", { intercept: (call) => (call.args.at(-1) === `repos/${STORE}` ? httpError(404, "Not Found") : undefined) }],
  ["rate_limited", { intercept: (call) => (call.args[0] === "api" ? { code: 1, stdout: "{}", stderr: `gh: API rate limit exceeded for user ID 1. ${TOKEN} (HTTP 403)\n` } : undefined) }],
  ["rate_limited", { intercept: (call) => (call.args[0] === "api" ? httpError(429, "Too Many Requests") : undefined) }],
  ["offline", { intercept: (call) => (call.args[0] === "api" ? { code: 1, stdout: "", stderr: `error connecting to api.github.com ${TOKEN}\n` } : undefined) }],
  ["offline", { intercept: (call) => (call.args[0] === "api" ? { code: null, stdout: "", stderr: "", timedOut: true, spawnError: null } : undefined) }],
  ["unexpected", { intercept: (call) => (call.args[0] === "api" ? { code: 0, stdout: `not json ${TOKEN}`, stderr: "" } : undefined) }],
  ["unexpected", { intercept: (call) => (call.args[0] === "api" ? { code: 1, stdout: "", stderr: `gh: something else ${TOKEN}\n` } : undefined) }],
  ["unexpected", { intercept: (call) => (call.args[0] === "api" ? httpError(500, "Server Error") : undefined) }],
  ["unexpected", { intercept: (call) => (call.args[0] === "api" && call.args.some((arg) => /\/branches\//u.test(arg)) ? { code: 0, stdout: JSON.stringify({ commit: {} }), stderr: "" } : undefined) }],
  ["unexpected", { intercept: (call) => (call.args[0] === "api" && call.args.at(-1) === `repos/${STORE}` ? { code: 0, stdout: "null", stderr: "" } : undefined) }],
  ["unexpected", { intercept: () => { throw new Error(`runner exploded ${TOKEN}`) } }],
  ["unexpected", { intercept: (call) => (call.args[0] === "api" && call.args.some((arg) => /\/git\/trees$/u.test(arg)) ? { code: 0, stdout: JSON.stringify({ sha: "1".repeat(40), tree: [{ path: "facts", type: "tree", sha: "2".repeat(40) }] }), stderr: "" } : undefined) }],
]

for (const [index, [code, options]] of FAILURES.entries()) {
  test(`flush reports ${code} (case ${index + 1}) as a stable code and never leaks the token`, () => scratch(async ({ env }) => {
    const { flush } = await load()
    await optIn(env)
    await put(env, localFacts(1, { refs: { prs: [{ repo: "acme/open", number: 1 }], commits: [], unresolved: { prs: 0, commits: 0 } } }))
    const github = fakeGitHub({ ...options, visibility: { "acme/open": "public" } })
    const result = await flush(env, { store: STORE, runner: github.runner })
    assert.deepEqual(result, { result: code })
    assert.equal((await readStatus(env)).last_flush[STORE].result, code)
    for (const file of await allFiles(await factoryStateRoot(env))) assert.equal(readFileSync(file).includes(TOKEN), false, file)
    assert.equal(JSON.stringify(result).includes(TOKEN), false)
    for (const call of github.calls) assert.equal(call.args.join(" ").includes(TOKEN), false)
  }))
}

test("the token is used only as the runner's token option: never an argument, result, status, error or file", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1, { refs: { prs: [{ repo: "acme/open", number: 1 }], commits: [], unresolved: { prs: 0, commits: 0 } } }))
  const github = fakeGitHub({ push: false, fork: "ready", visibility: { "acme/open": "public" } })
  const result = await flush(env, { store: STORE, runner: github.runner })
  assert.equal(result.result, "delivered_pr_open")
  const auth = github.calls.filter((call) => call.args[0] === "auth")
  assert.deepEqual(auth.map((call) => call.args), [["auth", "token", "--user", ACCOUNT]])
  assert.equal(auth[0].token, undefined)
  for (const call of github.calls) {
    assert.equal(call.args.join(" ").includes(TOKEN), false)
    assert.equal((call.input ?? "").includes(TOKEN), false)
    if (call.args[0] === "api") assert.equal(call.token, TOKEN)
  }
  assert.equal(JSON.stringify(result).includes(TOKEN), false)
  for (const file of await allFiles(await factoryStateRoot(env))) assert.equal(readFileSync(file).includes(TOKEN), false, file)
}))

// ---------------------------------------------------------------------------
// The lock and the deadline.
// ---------------------------------------------------------------------------

test("a live flush.lock makes a second flush return locked without touching status; a ten-minute-old lock is recovered", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const root = await factoryStateRoot(env)
  await writeStatus(env, { last_flush: { [STORE]: { at: "2026-09-27T00:00:00.000Z", result: "offline" } } })
  const lock = path.join(root, "flush.lock")
  await fs.writeFile(lock, JSON.stringify({ pid: 1, started_at: "x" }), { mode: 0o600 })
  const github = fakeGitHub()
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "locked" })
  assert.equal(github.calls.length, 0)
  assert.equal((await readStatus(env)).last_flush[STORE].result, "offline")
  const old = new Date(Date.now() - 11 * 60 * 1000)
  await fs.utimes(lock, old, old)
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.equal(existsSync(lock), false, "the flush removes its own lock")
}))

test("concurrent flushes: exactly one delivers and the other is locked", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const github = fakeGitHub()
  const slow = async (args, options) => {
    if (args[0] === "--version") await gate
    return github.runner(args, options)
  }
  const first = flush(env, { store: STORE, runner: slow })
  await new Promise((resolve) => setTimeout(resolve, 50))
  const second = await flush(env, { store: STORE, runner: github.runner })
  release()
  assert.deepEqual(second, { result: "locked" })
  assert.equal((await first).result, "delivered_pr_open")
}))

test("a lock replaced by another owner during a flush is left in place", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const root = await factoryStateRoot(env)
  const lock = path.join(root, "flush.lock")
  const github = fakeGitHub()
  const runner = async (args, options) => {
    if (args[0] === "--version") await fs.writeFile(lock, JSON.stringify({ token: "another-owner" }))
    return github.runner(args, options)
  }
  await flush(env, { store: STORE, runner })
  assert.equal(JSON.parse(await fs.readFile(lock, "utf8")).token, "another-owner")
}))

test("the deadline is enforced at every runner boundary", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1, { refs: { prs: [{ repo: "acme/open", number: 1 }], commits: [], unresolved: { prs: 0, commits: 0 } } }))
  const probe = fakeGitHub({ push: false, fork: "ready", visibility: { "acme/open": "public" } })
  assert.equal((await flush(env, { store: STORE, runner: probe.runner })).result, "delivered_pr_open")
  const total = probe.calls.length
  assert.ok(total >= 15, `the full path has many boundaries (${total})`)
  for (let boundary = 0; boundary < total; boundary += 1) {
    await scratch(async ({ env: fresh }) => {
      await optIn(fresh)
      await put(fresh, localFacts(1, { refs: { prs: [{ repo: "acme/open", number: 1 }], commits: [], unresolved: { prs: 0, commits: 0 } } }))
      let clock = 1_000_000
      const github = fakeGitHub({ push: false, fork: "ready", visibility: { "acme/open": "public" }, intercept: (call, index) => { if (index === boundary) clock += 200_000 } })
      const result = await flush(fresh, { store: STORE, runner: github.runner, now: () => clock, deadlineMs: 120_000 })
      assert.deepEqual(result, { result: "deadline" }, `boundary ${boundary}`)
      assert.equal(github.calls.length, boundary + 1, `no call after the deadline at boundary ${boundary}`)
      assert.equal((await readStatus(fresh)).last_flush[STORE].result, "deadline")
    })
  }
}))

test("a deadline already spent before a gh call makes no call at all", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub()
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, now: () => 5, deadlineMs: 0 }), { result: "deadline" })
  assert.equal(github.calls.length, 0)
}))

test("a runner that never answers is cut off at the deadline", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const started = performance.now()
  const result = await flush(env, { store: STORE, runner: () => new Promise(() => {}), deadlineMs: 80 })
  assert.deepEqual(result, { result: "deadline" })
  // Generous: local work before the first call can be slow on a loaded host; the point is that the flush returns at all.
  assert.ok(performance.now() - started < 30000)
}))

// ---------------------------------------------------------------------------
// The real runner.
// ---------------------------------------------------------------------------

test("the real runner passes the token only through GH_TOKEN with prompts and update checks off", async () => {
  const { ghRunner } = await load()
  const spawned = []
  const spawn = (command, args, options) => {
    spawned.push({ command, args, options })
    const listeners = {}
    const stream = () => ({ on: (event, fn) => { listeners[`${event}`] = listeners[`${event}`] ?? []; listeners[`${event}`].push(fn) }, setEncoding() {} })
    const child = {
      stdout: { on: (event, fn) => { if (event === "data") setImmediate(() => fn(Buffer.from("out"))) } },
      stderr: { on: (event, fn) => { if (event === "data") setImmediate(() => fn(Buffer.from("err"))) } },
      stdin: { end: (input) => { child.input = input }, on() {} },
      on: (event, fn) => { if (event === "close") setImmediate(() => setImmediate(() => fn(0))) },
      once: (event, fn) => child.on(event, fn),
      kill() {},
    }
    stream()
    return child
  }
  const run = ghRunner({ spawn, env: { PATH: "/bin", GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient2", GH_ENTERPRISE_TOKEN: "ambient3" } })
  const result = await run(["api", "user"], { token: TOKEN, input: "{}", timeoutMs: 1000 })
  assert.deepEqual(result, { code: 0, stdout: "out", stderr: "err" })
  assert.equal(spawned[0].command, "gh")
  assert.deepEqual(spawned[0].args, ["api", "user"])
  const childEnv = spawned[0].options.env
  assert.equal(childEnv.GH_TOKEN, TOKEN)
  assert.equal(childEnv.GITHUB_TOKEN, undefined)
  assert.equal(childEnv.GH_ENTERPRISE_TOKEN, undefined)
  assert.equal(childEnv.GH_PROMPT_DISABLED, "1")
  assert.equal(childEnv.GH_NO_UPDATE_NOTIFIER, "1")
  assert.equal(childEnv.GIT_TERMINAL_PROMPT, "0")
  await run(["auth", "token", "--user", ACCOUNT])
  assert.equal(spawned[1].options.env.GH_TOKEN, undefined, "no ambient token reaches gh auth token")
})

test("the real runner reports a missing gh, a failed spawn and a timeout without throwing", async () => {
  const { ghRunner } = await load()
  const missing = ghRunner({ env: { PATH: "/nonexistent-bin" } })
  const result = await missing(["--version"], { timeoutMs: 5000 })
  assert.equal(result.code, null)
  assert.equal(result.spawnError, "ENOENT")
  const node = process.execPath
  const bin = path.join(await fs.mkdtemp(path.join((await import("node:os")).tmpdir(), "desk-gh-")), "gh")
  await fs.writeFile(bin, `#!${node}\nconst [,, mode] = process.argv; if (mode === "sleep") setTimeout(() => {}, 10000); else { let input = ""; process.stdin.on("data", (c) => input += c); process.stdin.on("end", () => { process.stdout.write(input + ":" + (process.env.GH_TOKEN ? "token" : "none")); process.stderr.write("e"); process.exit(3) }) }\n`, { mode: 0o755 })
  const fake = ghRunner({ env: { PATH: `${path.dirname(bin)}${path.delimiter}${process.env.PATH}` } })
  assert.deepEqual(await fake(["echo"], { token: TOKEN, input: "hello", timeoutMs: 5000 }), { code: 3, stdout: "hello:token", stderr: "e" })
  const slow = await fake(["sleep"], { timeoutMs: 100 })
  assert.equal(slow.timedOut, true)
  assert.equal(slow.code, null)
  await fs.rm(path.dirname(bin), { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Start-time delivery across consented stores.
// ---------------------------------------------------------------------------

test("start-time delivery sweeps once and flushes every consented store within one deadline, and never throws", () => scratch(async ({ env }) => {
  const { flushConsented } = await load()
  assert.deepEqual(await flushConsented(env, { runner: () => assert.fail("no state, no gh") }), { stores: {} })
  await setConsent(env, { store: "acme/declined", contribute: false, account: ACCOUNT })
  const swept = []
  assert.deepEqual(await flushConsented(env, { runner: () => assert.fail("nothing consented"), sweep: async () => swept.push(1) }), { stores: {} })
  assert.equal(swept.length, 0)
  await optIn(env)
  await setConsent(env, { store: "acme/second", contribute: true, account: ACCOUNT })
  const flushed = []
  const summary = await flushConsented(env, {
    runner: () => assert.fail("injected flush"),
    sweep: async () => { swept.push(1); return { written: 0 } },
    flush: async (_env, options) => { flushed.push(options.store); assert.ok(options.deadlineMs <= 120000); return { result: "nothing_pending" } },
  })
  assert.deepEqual(summary, { swept: { written: 0 }, stores: { "acme/second": { result: "nothing_pending" }, [STORE]: { result: "nothing_pending" } } })
  assert.deepEqual(flushed, ["acme/second", STORE])
  let clock = 0
  const late = await flushConsented(env, { now: () => clock, deadlineMs: 10, sweep: async () => { clock = 50; throw new Error("sweep failed") }, flush: async () => assert.fail("past the deadline") })
  assert.deepEqual(late, { swept: null, stores: { "acme/second": { result: "deadline" }, [STORE]: { result: "deadline" } } })
  const broken = await flushConsented(env, { sweep: async () => ({}), flush: async () => { throw new Error("boom") } })
  assert.deepEqual(broken.stores[STORE], { result: "unexpected" })
}))

// ---------------------------------------------------------------------------
// Malformed answers, odd inputs and defaults.
// ---------------------------------------------------------------------------

const routeOf = (call) => call.args.find((arg) => /^repos\//u.test(arg)) ?? ""
const isApi = (call, method, pattern) => call.args[0] === "api" && call.args.includes(method) && pattern.test(routeOf(call))
const answer = (json) => ({ code: 0, stdout: json === undefined ? "" : JSON.stringify(json), stderr: "" })

const MALFORMED = [
  ["the runner answers something that is not a result", {}, (call) => (call.args[0] === "--version" ? null : undefined)],
  ["gh --version fails", {}, (call) => (call.args[0] === "--version" ? { code: 1, stdout: "", stderr: "" } : undefined)],
  ["an api failure carries no output at all", {}, (call) => (call.args[0] === "api" ? { code: 1 } : undefined), "unexpected"],
  ["gh disappears between calls", {}, (call) => (call.args[0] === "api" ? { code: null, spawnError: "ENOENT" } : undefined), "gh_missing"],
  ["the store answers 403 without a rate limit", {}, (call) => (isApi(call, "GET", /^repos\/ourostack\/factory$/u) ? httpError(403, "Forbidden") : undefined)],
  ["the store has no default branch", {}, (call) => (isApi(call, "GET", /^repos\/ourostack\/factory$/u) ? answer({ permissions: { push: true } }) : undefined)],
  ["the fork answers empty", { push: false }, (call) => (isApi(call, "POST", /\/forks$/u) ? answer(undefined) : undefined)],
  ["the fork's branch cannot be read", { push: false, fork: "ready" }, (call) => (isApi(call, "GET", /\/git\/ref\/heads\/main$/u) ? httpError(500, "Server Error") : undefined)],
  ["the new tree has no SHA", {}, (call) => (isApi(call, "POST", /\/git\/trees$/u) ? answer({}) : undefined)],
  ["the intake branch cannot be read", {}, (call) => (isApi(call, "GET", /\/git\/ref\/heads\/intake\//u) ? httpError(500, "Server Error") : undefined)],
  ["the intake branch points at something that is not a SHA", {}, (call) => (isApi(call, "GET", /\/git\/ref\/heads\/intake\//u) ? answer({ object: { sha: "../x" } }) : undefined)],
  ["the new commit has no SHA", {}, (call) => (isApi(call, "POST", /\/git\/commits$/u) ? answer({}) : undefined)],
  ["the new PR has no number", {}, (call) => (isApi(call, "POST", /\/pulls$/u) ? answer({ number: "7", html_url: "u" }) : undefined)],
  ["the new PR has no link", {}, (call) => (isApi(call, "POST", /\/pulls$/u) ? answer({ number: 7 }) : undefined)],
]

for (const [label, options, intercept, code = "unexpected"] of MALFORMED) {
  test(`flush stops with ${code} when ${label}`, () => scratch(async ({ env }) => {
    const { flush } = await load()
    await optIn(env)
    await put(env, localFacts(1))
    const github = fakeGitHub({ ...options, intercept })
    assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: code })
  }))
}

test("a tree whose checked blobs did not land exactly is never committed", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  let trees = 0
  const github = fakeGitHub({
    intercept: (call) => {
      if (!isApi(call, "GET", /\/git\/trees\//u)) return undefined
      trees += 1
      return trees === 4 ? answer({ tree: [{ path: name, type: "blob", sha: "0".repeat(40) }] }) : undefined
    },
  })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "unexpected" })
  assert.equal(apiCalls(github, "POST", /\/git\/commits$/u).length, 0)
}))

test("answers that are not lists read as empty, and a head commit without parents is replaced", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub()
  await flush(env, { store: STORE, runner: github.runner })
  github.rejectOpenPr("factory-rejected: date")
  await put(env, localFacts(2))
  const odd = fakeGitHub({
    intercept: (call) => {
      if (isApi(call, "GET", /\/pulls$/u) && routeOf(call).includes("state=closed")) return answer({ not: "a list" })
      if (isApi(call, "GET", /\/pulls$/u)) return answer("nope")
      if (isApi(call, "GET", /\/git\/commits\//u)) return answer({ tree: { sha: "1".repeat(40) } })
      return github.runner(call.args, { token: call.token, input: call.input })
    },
  })
  const result = await flush(env, { store: STORE, runner: odd.runner, now: Date.now })
  assert.equal(result.result, "delivered_pr_open")
  const oddComments = fakeGitHub({ intercept: (call) => (isApi(call, "GET", /\/(comments|files)$/u) ? answer({}) : github.runner(call.args, { token: call.token, input: call.input })) })
  await writeStatus(env, { last_flush: { [STORE]: { at: "x", result: "offline" } } })
  assert.equal((await flush(env, { store: STORE, runner: oddComments.runner })).result, "delivered_pr_open")
}))

test("gh 2.40.0 is new enough, and a store main without a facts folder takes everything as new", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub({ version: "gh version 2.40.0 (2023-12-07)\n" })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
}))

test("a missing intake ID, an unusable lock and a failing clock are unexpected, never a throw", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1, { refs: { prs: [{ repo: "acme/open", number: 1 }], commits: [], unresolved: { prs: 0, commits: 0 } } }))
  const github = fakeGitHub({ visibility: { "acme/open": "public" } })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, now: () => Number.NaN }), { result: "unexpected" })
  const root = await factoryStateRoot(env)
  const consent = JSON.parse(await fs.readFile(path.join(root, "consent.json"), "utf8"))
  delete consent.stores[STORE].intake_id
  await fs.writeFile(path.join(root, "consent.json"), JSON.stringify(consent), { mode: 0o600 })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "unexpected" })
}))

test("lock edge cases: an open failure is unexpected, a lock that vanishes is taken, a lock that cannot be removed stays locked", (t) => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const root = await factoryStateRoot(env)
  const lock = path.join(root, "flush.lock")
  const open = fs.open
  const denied = t.mock.method(fs, "open", (file, ...rest) => (file === lock ? Promise.reject(Object.assign(new Error("denied"), { code: "EACCES" })) : open(file, ...rest)))
  assert.deepEqual(await flush(env, { store: STORE, runner: fakeGitHub().runner }), { result: "unexpected" })
  denied.mock.restore()
  await fs.writeFile(lock, "{}", { mode: 0o600 })
  const stat = fs.stat
  const vanished = t.mock.method(fs, "stat", (file, ...rest) => (file === lock ? Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" })) : stat(file, ...rest)))
  assert.equal((await flush(env, { store: STORE, runner: fakeGitHub().runner })).result, "delivered_pr_open")
  vanished.mock.restore()
  await fs.mkdir(lock)
  const old = new Date(Date.now() - 11 * 60 * 1000)
  await fs.utimes(lock, old, old)
  assert.deepEqual(await flush(env, { store: STORE, runner: fakeGitHub().runner }), { result: "locked" })
  await fs.rmdir(lock)
}))

test("defaults: no options is unexpected, and no runner is needed until the network is", () => scratch(async ({ env }) => {
  const { flush, flushConsented } = await load()
  assert.deepEqual(await flush(env), { result: "unexpected" })
  assert.deepEqual(await flush(env, { store: STORE }), { result: "not_opted_in" })
  assert.deepEqual(await flushConsented(env), { stores: {} })
}))

test("start-time delivery never throws, even when the state folder is unsafe", () => scratch(async ({ base, env }) => {
  const { flushConsented } = await load()
  const repo = path.join(base, "checkout")
  execFileSync("git", ["init", "-q", repo])
  const unsafe = { ...env, XDG_STATE_HOME: path.join(repo, "state") }
  await fs.mkdir(path.join(repo, "state", "ouroboros-skills", "desk", "factory"), { recursive: true })
  assert.deepEqual(await flushConsented(unsafe, { runner: () => assert.fail("never"), sweep: async () => assert.fail("never") }), { stores: {} })
}))

test("the real runner keeps output bounded and names a spawn failure without a code", async () => {
  const { ghRunner } = await load()
  const child = (script) => (command, args, options) => {
    const handlers = {}
    const streams = { stdout: [], stderr: [] }
    const stream = (name) => ({ on: (event, fn) => { if (event === "data") streams[name].push(fn) } })
    const fake = {
      stdout: stream("stdout"), stderr: stream("stderr"),
      stdin: { on: (event, fn) => { if (event === "error") fn(new Error("EPIPE")) }, end() { setImmediate(() => script({ handlers, streams })) } },
      on: (event, fn) => { handlers[event] = fn },
      kill() {},
    }
    return fake
  }
  const big = ghRunner({ maxOutput: 4, spawn: child(({ handlers, streams }) => { streams.stdout.forEach((fn) => { fn(Buffer.from("abc")); fn(Buffer.from("defgh")) }); handlers.close(0) }) })
  assert.deepEqual(await big(["x"]), { code: 0, stdout: "abc", stderr: "" })
  const broken = ghRunner({ spawn: child(({ handlers }) => handlers.error(new Error("no code"))) })
  assert.deepEqual(await broken(["x"]), { code: null, stdout: "", stderr: "", spawnError: "spawn_failed" })
})

// ---------------------------------------------------------------------------
// Fix round 1: paging, stale-lock takeover and deadlines outside gh.
// ---------------------------------------------------------------------------

const manyNames = (count, from = 1000) => Array.from({ length: count }, (_, index) => nameOf(from + index))

test("every page of a rejected PR's files is read: all 500 files of a full batch are quarantined", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  const branch = await intakeBranch(env)
  const github = fakeGitHub()
  const names = [...manyNames(499), name]
  github.addClosedPr({ comment: "factory-rejected: date", fileNames: names, headLabel: `ourostack:${branch}` })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "nothing_pending" })
  const quarantined = await fs.readdir(path.join(await factoryStateRoot(env), "quarantine", "ourostack__factory"))
  assert.equal(quarantined.length, 500)
  assert.ok(quarantined.includes(names[100]) && quarantined.includes(names[499]), "files 101 to 500 are quarantined")
  const pages = apiCalls(github, "GET", /\/files\?/u).map((call) => new URLSearchParams(routeOf(call).split("?")[1]).get("page"))
  assert.deepEqual(pages, ["1", "2", "3", "4", "5"])
}))

test("a page that fails leaves the read marker where it was, so the PR is read again", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const branch = await intakeBranch(env)
  let failing = true
  const github = fakeGitHub({ intercept: (call) => (failing && isApi(call, "GET", /\/files\?/u) && routeOf(call).includes("page=2") ? httpError(502, "Bad Gateway") : undefined) })
  github.addClosedPr({ comment: "factory-rejected: date", fileNames: manyNames(150), headLabel: `ourostack:${branch}` })
  await writeStatus(env, { last_flush: { [STORE]: { at: "x", result: "offline", rejections_through: 7 } } })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "unexpected" })
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_through, 7)
  failing = false
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.equal((await fs.readdir(path.join(await factoryStateRoot(env), "quarantine", "ourostack__factory"))).length, 150)
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_through, 101)
}))

test("closed PRs are read newest first across pages and stop at the last PR already read", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const branch = await intakeBranch(env)
  const github = fakeGitHub()
  for (let n = 0; n < 45; n += 1) github.addClosedPr({ merged: true, headLabel: `ourostack:${branch}` })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_through, 145)
  const listed = apiCalls(github, "GET", /\/pulls\?state=closed/u)
  assert.equal(listed.length, 2, "45 closed PRs take two pages of 30")
  github.addClosedPr({ comment: "factory-rejected: date", fileNames: [nameOf(1)], headLabel: `ourostack:${branch}` })
  const before = github.calls.length
  await flush(env, { store: STORE, runner: github.runner })
  const later = github.calls.slice(before)
  assert.equal(later.filter((call) => isApi(call, "GET", /\/pulls\?state=closed/u)).length, 1, "the listing stops at the first PR already read")
  assert.equal(later.filter((call) => isApi(call, "GET", /\/comments\?/u)).length, 1)
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_through, 147)
}))

test("a stale lock replaced by another flush between its two reads is left to that flush", (t) => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const lock = path.join(await factoryStateRoot(env), "flush.lock")
  await fs.writeFile(lock, "{}", { mode: 0o600 })
  const old = new Date(Date.now() - 11 * 60 * 1000)
  await fs.utimes(lock, old, old)
  const stat = fs.stat
  let reads = 0
  t.mock.method(fs, "stat", async (file, ...rest) => {
    const value = await stat(file, ...rest)
    if (file === lock && ++reads === 2) return { ...value, ino: value.ino + 1, mtimeMs: Date.now() }
    return value
  })
  assert.deepEqual(await flush(env, { store: STORE, runner: fakeGitHub().runner }), { result: "locked" })
  assert.equal(existsSync(lock), true, "the replacement lock is not removed")
}))

test("reading the desk's remote counts against the flush deadline", () => scratch(async ({ base, env }) => {
  const { flush } = await load()
  await optIn(env)
  const desk = await deskRepository(base, "https://github.com/acme/desk.git")
  await markerFor(env, desk, 1)
  await put(env, localFacts(1))
  let calls = 0
  const now = () => (++calls === 1 ? 0 : 10_000_000)
  const github = fakeGitHub()
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner, now }), { result: "deadline" })
  assert.equal(github.calls.length, 0)
}))

test("closed-PR entries that are not PRs of this machine's intake branch are skipped as data", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  await put(env, localFacts(1))
  const github = fakeGitHub({ intercept: (call) => (isApi(call, "GET", /\/pulls\?state=closed/u) ? answer(["junk", { number: "7" }, { number: 300, head: { ref: "intake/0000000000000000" } }]) : undefined) })
  assert.equal((await flush(env, { store: STORE, runner: github.runner })).result, "delivered_pr_open")
  assert.equal(apiCalls(github, "GET", /\/comments\?/u).length, 0)
  assert.equal((await readStatus(env)).last_flush[STORE].rejections_through, 0)
}))

for (const code of ["merge_conflict", "unexpected_merge"]) {
  test(`a PR closed with ${code} is stale, not bad: nothing is quarantined and the files go out again rebuilt on the current main`, () => scratch(async ({ env }) => {
    const { flush } = await load()
    await optIn(env)
    const name = await put(env, localFacts(1))
    const github = fakeGitHub()
    await flush(env, { store: STORE, runner: github.runner })
    const branch = await intakeBranch(env)
    const staleHead = github.ref(STORE, branch)
    github.rejectOpenPr(`factory-rejected: ${code}`)
    github.advanceMain()
    const result = await flush(env, { store: STORE, runner: github.runner })
    assert.deepEqual(result, { result: "intake_stale_retried", pr: { number: 102, url: `https://github.com/${STORE}/pull/102` }, stale_retries: 1 }, "a new PR is opened and the retry is reported as one")
    const recorded = (await readStatus(env)).last_flush[STORE]
    assert.equal(recorded.result, "intake_stale_retried")
    assert.equal(recorded.stale_retries, 1)
    assert.equal(existsSync(path.join(await factoryStateRoot(env), "quarantine")), false)
    const head = github.ref(STORE, branch)
    assert.notEqual(head, staleHead)
    assert.deepEqual(github.commit(head).parents, [github.storeMain()], "the branch is rebuilt on the store's current main")
    assert.deepEqual([...github.headFacts(STORE, branch).keys()], [name])
    assert.equal((await readStatus(env)).last_flush[STORE].rejections_through, 101)
  }))
}

test("a comment that mixes a stale code with a data code is a data rejection: the files are quarantined with the data code", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  const github = fakeGitHub()
  await flush(env, { store: STORE, runner: github.runner })
  github.rejectOpenPr("factory-rejected: merge_conflict\nfactory-rejected: path\nnot a code line\nfactory-rejected: date")
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "nothing_pending" })
  const record = JSON.parse(await fs.readFile(path.join(await factoryStateRoot(env), "quarantine", "ourostack__factory", name), "utf8"))
  assert.equal(record.reason, "path")
  assert.equal((await readStatus(env)).last_flush[STORE].stale_retries, undefined)
}))

test("two stale-refused PRs read in one flush are counted, and a stale PR whose files are all on main reports nothing pending", () => scratch(async ({ env }) => {
  const { flush } = await load()
  await optIn(env)
  const name = await put(env, localFacts(1))
  const branch = await intakeBranch(env)
  const github = fakeGitHub()
  github.addClosedPr({ comment: "factory-rejected: merge_conflict", fileNames: [name], headLabel: `ourostack:${branch}` })
  github.addClosedPr({ comment: "factory-rejected: unexpected_merge\nfactory-rejected: merge_conflict", fileNames: [name], headLabel: `ourostack:${branch}` })
  const result = await flush(env, { store: STORE, runner: github.runner })
  assert.equal(result.result, "intake_stale_retried")
  assert.equal(result.stale_retries, 2)
  github.mergeOpenPr()
  github.addClosedPr({ comment: "factory-rejected: merge_conflict", fileNames: [name], headLabel: `ourostack:${branch}` })
  assert.deepEqual(await flush(env, { store: STORE, runner: github.runner }), { result: "nothing_pending" })
}))
