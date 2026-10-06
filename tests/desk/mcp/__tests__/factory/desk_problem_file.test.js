// The Desk-problem filer never makes a real network call in tests: every
// runner here is an in-memory model (spec.md §7).
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, promises as fs, readFileSync, rmSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deskProblemFingerprint, normalizeErrorSignature } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-fingerprint.js"
import { FINGERPRINT_PREFIX } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-template.js"
import { LABEL, MAX_PROBLEMS_PER_DAY, STORE, fileDeskProblem, runFileDeskProblemCli } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-file.js"
import { DROPPED_KEY, KNOWN_KEY, PENDING_KEY, knownHitsSince } from "../../../../../plugins/desk/mcp/src/factory/desk-problem-known.js"
import { readStatus, setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { LAUNCH_STAMP_DIR, MAX_LAUNCH_STAMPS, endLaunch, launchStampKey, pendingLaunchTimes } from "../../../../../plugins/desk/mcp/src/factory/filer-launch.js"
import { shouldLaunchFiler } from "../../../../../plugins/desk/mcp/src/runtime/filer-throttle.js"
import { REPEAT_TIMEOUT_THRESHOLD } from "../../../../../plugins/desk/mcp/src/runtime/protected-checkout-repeat.js"

const SCRIPT = fileURLToPath(new URL("../../../../../plugins/desk/mcp/scripts/file-desk-problem.js", import.meta.url))

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

const KNOWN_ISSUES = (fingerprint) => [{
  number: 5, html_url: `https://github.com/${STORE}/issues/5`, title: "t", body: `${FINGERPRINT_PREFIX}${fingerprint} -->`, labels: [{ name: LABEL }], state: "closed", pull_request: null,
}]
const RUNNING = JSON.parse(readFileSync(new URL("../../../../../plugins/desk/plugin.json", import.meta.url), "utf8")).version

test("a 'known' result records the hit with the running Desk version; a second hit makes count 2 and moves last_at", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ ...ONE_ACCOUNT, issues: KNOWN_ISSUES(fingerprintOf("desk-sync", "x")) })
  const first = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner, now: clock("2026-10-01T00:00:00Z") })
  assert.deepEqual(first, { result: "known", url: `https://github.com/${STORE}/issues/5` })
  assert.deepEqual((await readStatus(env))[KNOWN_KEY], { 5: { count: 1, last_at: "2026-10-01T00:00:00.000Z", last_version: RUNNING } })
  await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner, now: clock("2026-10-02T00:00:00Z") })
  assert.deepEqual((await readStatus(env))[KNOWN_KEY][5], { count: 2, last_at: "2026-10-02T00:00:00.000Z", last_version: RUNNING })
}))

test("a 'filed' result records no known hit", () => scratch(async ({ env }) => {
  const { runner } = fakeGh(ONE_ACCOUNT)
  assert.equal((await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "y", runner })).result, "filed")
  assert.equal((await readStatus(env))[KNOWN_KEY], undefined)
}))

test("a failed status write leaves the 'known' result unchanged and logs one stable code", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ ...ONE_ACCOUNT, issues: KNOWN_ISSUES(fingerprintOf("desk-sync", "x")) })
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  try {
    const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner, recordKnown: async () => ({ recorded: false, code: "status_write_failed" }) })
    assert.deepEqual(result, { result: "known", url: `https://github.com/${STORE}/issues/5` })
  } finally {
    process.stderr.write = original
  }
  assert.deepEqual(lines, ["desk-problem: known_hit_not_recorded status_write_failed\n"])
}))

test("a recorder that throws or rejects never changes or breaks the 'known' result", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ ...ONE_ACCOUNT, issues: KNOWN_ISSUES(fingerprintOf("desk-sync", "x")) })
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  try {
    for (const recordKnown of [async () => { throw new Error("boom") }, () => { throw new Error("boom") }]) {
      assert.deepEqual(await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner, recordKnown }), { result: "known", url: `https://github.com/${STORE}/issues/5` })
    }
  } finally {
    process.stderr.write = original
  }
  assert.deepEqual(lines, Array(2).fill("desk-problem: known_hit_not_recorded record_failed\n"))
}))

test("a headless factory session records no known hit", () => scratch(async ({ env }) => {
  const { runner } = fakeGh({ ...ONE_ACCOUNT, issues: KNOWN_ISSUES(fingerprintOf("desk-sync", "x")) })
  const result = await fileDeskProblem({ ...env, DESK_FACTORY_HEADLESS: "1" }, { mechanism: "desk-sync", rawText: "x", runner })
  assert.equal(result.result, "known")
  assert.equal((await readStatus(env))[KNOWN_KEY], undefined)
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

test("every attempt that may have lost a recurrence counts a drop, so the verify step reads not_recorded, never a measured no hit", () => scratch(async ({ env }) => {
  const dropped = async () => (await readStatus(env))[DROPPED_KEY]?.count ?? 0
  const known = KNOWN_ISSUES(fingerprintOf("desk-sync", "x"))
  // Filed new, recorded known, held at the cap and a headless session lose nothing.
  assert.equal((await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "y", runner: fakeGh(ONE_ACCOUNT).runner })).result, "filed")
  assert.equal((await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner: fakeGh({ ...ONE_ACCOUNT, issues: known }).runner })).result, "known")
  assert.equal((await fileDeskProblem({ ...env, DESK_FACTORY_HEADLESS: "1" }, { mechanism: "desk-sync", rawText: "z", runner: fakeGh({ accounts: [], repos: {} }).runner })).result, "not_filed")
  assert.equal(await dropped(), 0)
  // No suitable account, a failed listing and a known hit whose write failed each count one.
  assert.equal((await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner: fakeGh({ accounts: [], repos: {} }).runner })).reason, "no_suitable_account")
  assert.equal(await dropped(), 1)
  assert.equal((await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner: fakeGh({ ...ONE_ACCOUNT, fail: { list: { code: 1, stdout: "", stderr: "gh: Internal Server Error (HTTP 500)\n" } } }).runner })).reason, "http_500")
  assert.equal(await dropped(), 2)
  const original = process.stderr.write
  process.stderr.write = () => true
  try {
    assert.deepEqual(await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner: fakeGh({ ...ONE_ACCOUNT, issues: known }).runner, recordKnown: async () => ({ recorded: false, code: "status_write_failed" }) }), { result: "known", url: `https://github.com/${STORE}/issues/5` })
  } finally {
    process.stderr.write = original
  }
  assert.equal(await dropped(), 3)
  const status = await readStatus(env)
  assert.deepEqual(knownHitsSince(status, 5, "0.0.1", { since: status.desk_problem_known_since }).state, "measured", "the issue whose hit was recorded still answers")
  assert.deepEqual(knownHitsSince(status, 6, "0.0.1", { since: status.desk_problem_known_since }), { state: "unavailable", reason: "not_recorded" })
}))

test("a drop that cannot be recorded either leaves one stable code, and a thrown failure still counts its drop", () => scratch(async ({ env }) => {
  const lines = []
  const original = process.stderr.write
  process.stderr.write = (chunk) => { lines.push(String(chunk)); return true }
  try {
    const none = fakeGh({ accounts: [], repos: {} }).runner
    await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner: none, recordLost: async () => ({ recorded: false, code: "status_write_failed" }) })
    await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner: none, recordLost: () => { throw new Error("boom") } })
    await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner: none, recordLost: async () => ({ recorded: false, code: "headless_session" }) })
  } finally {
    process.stderr.write = original
  }
  assert.deepEqual(lines, ["desk-problem: lost_hit_not_recorded status_write_failed\n", "desk-problem: lost_hit_not_recorded record_failed\n"])
  const { runner: base } = fakeGh(ONE_ACCOUNT)
  const runner = async (args, options) => {
    if (args[0] === "api" && String(args[7]).startsWith(`repos/${STORE}/issues`)) throw new Error("boom")
    return base(args, options)
  }
  await assert.rejects(fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner }), /boom/u)
  assert.equal((await readStatus(env))[DROPPED_KEY].count, 1)
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

// ── deadlineMs (ruling 3): the whole attempt is bounded, not just the account lookup ──────────────

test("a runner that never resolves still returns not_filed: deadline within the given bound, rather than hanging", () => scratch(async ({ env }) => {
  const hang = () => new Promise(() => {})
  const startedAt = Date.now()
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner: hang, deadlineMs: 20 })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "deadline")
  assert.match(result.body, /desk-problem-fingerprint/u)
  assert.ok(Date.now() - startedAt < 2000, "must resolve near its own bound, never hang")
}))

test("a deadline that is already spent by the time the account is chosen is also reported as not_filed: deadline", () => scratch(async ({ env }) => {
  const { runner } = fakeGh(ONE_ACCOUNT)
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner, deadlineMs: 0 })
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "deadline")
}))

test("a deadline spent entirely by a successful account selection is caught by fileDeskProblem's own post-selection check, not just chooseAccount's", () => scratch(async ({ env }) => {
  // chooseAccount can spend a whole deadline choosing an account and still succeed (its own internal
  // races only stop it when time runs out *during* a gh call, never merely because none is left over
  // afterward). fileDeskProblem's own `if (remaining() <= 0)` right after selection exists for exactly
  // that gap. The fake clock is told who is reading it, not how many reads came before: every read reports time 0, except the
  // one `fileDeskProblem` makes through its own `remaining()` right after selection succeeds, which finds the deadline spent.
  // `remaining()` is also read once before selection, to size its budget, so that read is the first and is within time. The
  // test asserts it reached the second, so a read added anywhere else cannot make it stop testing this check.
  let remainingReads = 0
  const now = () => {
    const caller = (new Error().stack.split("\n")[2] ?? "").trim()
    if (!caller.startsWith("at remaining ")) return 0
    remainingReads += 1
    return remainingReads === 1 ? 0 : 1_000
  }
  const { runner } = fakeGh(ONE_ACCOUNT)
  const result = await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "push rejected", runner, now, deadlineMs: 10 })
  assert.equal(remainingReads, 2, "the check right after account selection is the one that found the deadline spent")
  assert.equal(result.result, "not_filed")
  assert.equal(result.reason, "deadline")
  assert.match(result.body, /desk-problem-fingerprint/u)
}))

// ── the dedup/cap/create critical section is locked (ruling 2): two sessions racing the same broken
//    mechanism at once must not both file ──────────────────────────────────────────────────────────

test("two concurrent filings for the same new fingerprint create only one issue; the other finds it known", () => scratch(async ({ env }) => {
  const issues = []
  let createCalls = 0
  const fingerprint = fingerprintOf("desk-sync", "concurrent failure")
  const runner = async (args, options = {}) => {
    if (args[0] === "--version") return { code: 0, stdout: VERSION, stderr: "" }
    if (args[0] === "auth" && args[1] === "status") return { code: 0, stdout: authStatus(ONE_ACCOUNT.accounts), stderr: "" }
    if (args[0] === "auth" && args[1] === "token") return { code: 0, stdout: "token-contributor\n", stderr: "" }
    if (args[0] === "api") {
      const method = args[2]
      const route = args[7]
      if (route === `repos/${STORE}`) return { code: 0, stdout: JSON.stringify(PUSH), stderr: "" }
      if (route.startsWith(`repos/${STORE}/issues?`)) return { code: 0, stdout: JSON.stringify(issues), stderr: "" }
      if (method === "POST" && route === `repos/${STORE}/issues`) {
        createCalls += 1
        // A slow create widens the check-then-act window a missing lock would let a second racer slip through.
        await new Promise((resolve) => setTimeout(resolve, 20))
        const number = issues.length + 1
        const html_url = `https://github.com/${STORE}/issues/${number}`
        issues.push({ number, html_url, title: "t", body: `${FINGERPRINT_PREFIX}${fingerprint} -->`, labels: [{ name: LABEL }], state: "open", pull_request: null })
        return { code: 0, stdout: JSON.stringify({ number, html_url }), stderr: "" }
      }
    }
    return { code: 1, stdout: "", stderr: "unexpected call\n" }
  }
  const [a, b] = await Promise.all([
    fileDeskProblem(env, { mechanism: "desk-sync", rawText: "concurrent failure", runner }),
    fileDeskProblem(env, { mechanism: "desk-sync", rawText: "concurrent failure", runner }),
  ])
  assert.equal(createCalls, 1, "the lock must keep a second racer out of the dedup/cap/create section entirely")
  assert.deepEqual([a.result, b.result].sort(), ["filed", "known"])
}))

// ── runFileDeskProblemCli: the detached filer's whole CLI surface, unit-tested directly ───────────

test("runFileDeskProblemCli requires --mechanism, and refuses an empty one", () => scratch(async ({ env }) => {
  await assert.rejects(runFileDeskProblemCli({ argv: [], env }), /--mechanism <name> is required/u)
  await assert.rejects(runFileDeskProblemCli({ argv: ["--mechanism", ""], env }), /--mechanism <name> is required/u)
}))

test("runFileDeskProblemCli refuses an argument that isn't a --flag", () => scratch(async ({ env }) => {
  await assert.rejects(runFileDeskProblemCli({ argv: ["oops"], env }), /unexpected argument "oops"/u)
}))

test("runFileDeskProblemCli refuses a non-string argument too, naming it safely rather than throwing on the name itself", () => scratch(async ({ env }) => {
  await assert.rejects(runFileDeskProblemCli({ argv: [null], env }), /unexpected argument ""/u)
}))

test("runFileDeskProblemCli resolves 0 and never throws once --mechanism is given, whether or not the optional flags are, and even when nothing can file", () => scratch(async ({ env }) => {
  const withAll = await runFileDeskProblemCli({
    argv: ["--mechanism", "desk-sync", "--reason", "push rejected", "--host", "claude", "--fix-attempt", "retry"],
    env: { ...env, PATH: "" },
  })
  assert.equal(withAll, 0)
  const mechanismOnly = await runFileDeskProblemCli({ argv: ["--mechanism", "desk-sync"], env: { ...env, PATH: "" } })
  assert.equal(mechanismOnly, 0)
}))

// ── scripts/file-desk-problem.js: the one-line CLI entry point itself, run for real as a subprocess
//    (the coverage runner instruments child node processes through the parent's own environment,
//    the same pattern scripts/tidy-status.js's own test uses) ──────────────────────────────────────

test("scripts/file-desk-problem.js runs the real CLI end to end, filing nothing when it cannot reach gh", () => scratch(async ({ env, base }) => {
  const childEnv = { ...process.env, HOME: env.HOME, XDG_STATE_HOME: env.XDG_STATE_HOME, PATH: "" }
  const result = spawnSync(process.execPath, [SCRIPT, "--mechanism", "desk-sync", "--reason", "subprocess failure", "--host", "claude"], { env: childEnv, encoding: "utf8", cwd: base })
  assert.equal(result.status, 0, result.stderr)
}))

test("scripts/file-desk-problem.js exits non-zero on a usage error (no --mechanism)", () => scratch(async ({ env, base }) => {
  const childEnv = { ...process.env, HOME: env.HOME, XDG_STATE_HOME: env.XDG_STATE_HOME, PATH: "" }
  const result = spawnSync(process.execPath, [SCRIPT], { env: childEnv, encoding: "utf8", cwd: base })
  assert.notEqual(result.status, 0)
}))

test("review finding 11: the filer records its attempt before the network step and clears it once the outcome is recorded, a throw included", () => scratch(async ({ env }) => {
  const seen = []
  const { runner: base } = fakeGh({ accounts: [], repos: {} })
  const runner = async (args, options) => {
    seen.push(Object.keys((await readStatus(env))[PENDING_KEY] ?? {}).length)
    return base(args, options)
  }
  await fileDeskProblem(env, { mechanism: "desk-sync", rawText: "x", runner })
  assert.ok(seen.length > 0 && seen.every((count) => count === 1), "pending while the filer works")
  assert.deepEqual((await readStatus(env))[PENDING_KEY], {})
  // An attempt that throws (here, reading its own options) is still cleared, and counted as a drop.
  const throwing = { rawText: "x", runner, get mechanism() { throw new Error("boom") } }
  await assert.rejects(fileDeskProblem(env, throwing), /boom/u)
  assert.deepEqual((await readStatus(env))[PENDING_KEY], {})
}))

// ── Fix round 2, finding 11: a filer that never starts ─────────────────────────────────────────────

test("finding 11: a launch whose filer never starts stays pending and reads as a drop; the filer clears it once it records an outcome", () => scratch(async ({ env }) => {
  const armed = { last_flush: {}, desk_problem_known_since: "2026-09-01T00:00:00.000Z" }
  const since = "2026-09-29T00:00:00.000Z"
  assert.deepEqual(pendingLaunchTimes(env), [], "no stamps folder is no launch")
  assert.equal(shouldLaunchFiler({ env, mechanism: "desk-sync", signature: "push rejected", now: () => Date.parse("2026-10-01T00:00:00.000Z") }), true)
  // The spawn failed: nothing ever ran the filer. Verification must not read a measured "no hit".
  const launches = pendingLaunchTimes(env)
  assert.deepEqual(launches, [Date.parse("2026-10-01T00:00:00.000Z")])
  assert.deepEqual(knownHitsSince(armed, 123, "3.2.0", { since, launches }), { state: "unavailable", reason: "not_recorded" })
  assert.deepEqual(knownHitsSince(armed, 123, "3.2.0", { since: "2026-10-02T00:00:00.000Z", launches }), { state: "measured", hit: false }, "a launch before the window is not in it")
  // The filer runs (it cannot file here) and records its outcome: the stamp is no longer pending, and the throttle keeps its time.
  assert.equal(await runFileDeskProblemCli({ argv: ["--mechanism", "desk-sync", "--reason", "push rejected"], env: { ...env, PATH: "" } }), 0)
  assert.deepEqual(pendingLaunchTimes(env), [])
  assert.equal(shouldLaunchFiler({ env, mechanism: "desk-sync", signature: "push rejected", now: () => Date.parse("2026-10-01T00:10:00.000Z") }), false)
  // A launcher with no reason passes `unknown` to the filer and an empty signature to the throttle: both are cleared.
  assert.equal(shouldLaunchFiler({ env, mechanism: "index-drift", signature: "" }), true)
  assert.equal(pendingLaunchTimes(env).length, 1)
  endLaunch(env, { mechanism: "index-drift", signature: "unknown" })
  assert.deepEqual(pendingLaunchTimes(env), [])
}))

test("finding 11: a stamp that cannot be read is a pending launch as of its time, and a stamps folder that cannot be listed or is too full reads as a launch now", { skip: process.getuid?.() === 0 || process.platform === "win32" }, () => scratch(async ({ env }) => {
  const dir = path.join(env.XDG_STATE_HOME, "ouroboros-skills", "desk", LAUNCH_STAMP_DIR)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, "broken.json"), "{ not json")
  await fs.mkdir(path.join(dir, "folder.json"))
  await fs.writeFile(path.join(dir, "old.json"), JSON.stringify({ at: 5 }))
  await fs.writeFile(path.join(dir, "notes.txt"), "ignored")
  await fs.writeFile(path.join(dir, "big.json"), " ".repeat(2048))
  await fs.writeFile(path.join(dir, "timeless.json"), JSON.stringify({ pending: true }))
  const times = pendingLaunchTimes(env)
  assert.equal(times.length, 4)
  assert.ok(times.every((at) => Number.isFinite(at) && at > 1e12), "an unreadable stamp counts from its modification time")
  // A stamp written before launches were marked pending is not pending; clearing a stamp that is not pending, or absent, changes nothing.
  endLaunch(env, { mechanism: "never", signature: "launched" })
  const done = path.join(dir, `${launchStampKey("done", "x")}.json`)
  await fs.writeFile(done, JSON.stringify({ at: 7, pending: false }))
  endLaunch(env, { mechanism: "done", signature: "x" })
  assert.deepEqual(JSON.parse(await fs.readFile(done, "utf8")), { at: 7, pending: false })
  for (const name of ["broken.json", "big.json", "timeless.json"]) await fs.rm(path.join(dir, name))
  await fs.rm(path.join(dir, "folder.json"), { recursive: true })
  assert.deepEqual(pendingLaunchTimes(env), [])
  for (let index = 0; index < MAX_LAUNCH_STAMPS + 1; index += 1) await fs.writeFile(path.join(dir, `${index}.json`), "{}")
  assert.deepEqual(pendingLaunchTimes(env, { now: () => 42 }), [42])
  await fs.rm(dir, { recursive: true })
  await fs.writeFile(dir, "not a folder")
  assert.deepEqual(pendingLaunchTimes(env, { now: () => 43 }), [43])
}))

test("review round 2, M4: protected-checkout's stamp is keyed by the command, and the filer clears that same stamp once it records an outcome", () => scratch(async ({ env }) => {
  const { createRequire } = await import("node:module")
  const { deadlineDecision } = createRequire(import.meta.url)("../../../../../plugins/desk/hooks/protected-checkout.cjs")
  const rawInput = JSON.stringify({ tool_name: "Bash", tool_input: { command: "git checkout topic" } })
  const calls = []
  for (let count = 0; count < REPEAT_TIMEOUT_THRESHOLD; count += 1) await deadlineDecision({ rawInput, host: "claude", deadlineMs: 9000, env, spawnFiler: (args) => calls.push(args) })
  assert.equal(calls.length, 1)
  assert.equal(pendingLaunchTimes(env).length, 1, "the launch is pending until the filer records an outcome")
  // The filer is given a reason that differs from the stamp's key, as the hook's own spawn passes it, plus the stamp's signature.
  const { reason, launchSignature } = calls[0]
  assert.match(reason, /repeated timeout/u)
  assert.equal(await runFileDeskProblemCli({ argv: ["--mechanism", "protected-checkout", "--reason", reason, "--host", "claude", "--launch-signature", launchSignature], env: { ...env, PATH: "" } }), 0)
  assert.deepEqual(pendingLaunchTimes(env), [], "the stamp the launch wrote is cleared")
}))
