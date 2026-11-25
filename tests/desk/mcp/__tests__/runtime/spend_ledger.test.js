import test from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { removeTreeSync } from "../_remove_tree.js"
import { activeLogin, ledgerDir, ledgeredFetch, SpendHeld, unattributedSends, unrecordedSends } from "../../../../../plugins/desk/mcp/src/runtime/spend-ledger.js"
import { connectGithub } from "../../../../../plugins/desk/mcp/src/runtime/drains.js"
import { prDelivery } from "../../../../../plugins/desk/mcp/src/tools/delivery-gate.js"

const NOW = 1_800_000_000
const RESET = NOW + 1800
const SESSION = "11111111-synthetic-session"
const answer = (status = 200, body = {}, headers = {}) => ({ ok: status < 400, status, headers: { get: (name) => headers[name] ?? null, has: (name) => name in headers }, text: async () => JSON.stringify(body), json: async () => body })
const quota = (remaining, extra = {}) => ({ "x-ratelimit-remaining": String(remaining), "x-ratelimit-limit": "5000", "x-ratelimit-reset": String(RESET), "x-ratelimit-resource": "core", ...extra })
const auth = (token = "tok-A") => ({ headers: { Authorization: `Bearer ${token}` } })

function ledger(t) {
  const root = mkdtempSync(path.join(tmpdir(), "spend-ledger-"))
  t.after(() => { try { chmodSync(path.join(root, "gh-quota"), 0o700) } catch {} removeTreeSync(root) })
  const dir = path.join(root, "gh-quota")
  mkdirSync(dir)
  const env = { MS_DESK_QUOTA_DIR: dir, COPILOT_AGENT_SESSION_ID: SESSION }
  const rows = () => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("\t")) : [])
  const rate = (kind) => readFileSync(path.join(dir, `${kind}.rate`), "utf8").trim().split(" ").map(Number)
  return { dir, env, rows, rate, root }
}

const clockNow = () => NOW * 1000

test("each send is one ledger row with session, kind, route without query and repository; a 304 is free; writes are marked write", async (t) => {
  const { dir, env, rows } = ledger(t)
  writeFileSync(path.join(dir, "work.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  const answers = [answer(), answer(304), answer(201)]
  const fetchFn = ledgeredFetch(async () => answers.shift(), { env, login: () => "ari_microsoft", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1?x=secret", auth("tok-secret"))
  await fetchFn("https://api.github.com/repos/o/r/issues", auth("tok-secret"))
  await fetchFn("https://api.github.com/repos/o/r/issues", { method: "POST", body: "payload", ...auth("tok-secret") })
  assert.deepEqual(rows(), [
    [String(NOW), "work", "api repos/o/r/pulls/1", SESSION, "o/r", "apiget"],
    [String(NOW), "work", "api repos/o/r/issues", SESSION, "o/r", "etag"],
    [String(NOW), "work", "api repos/o/r/issues", SESSION, "o/r", "write"],
  ])
  assert.doesNotMatch(JSON.stringify(rows()), /secret|payload/u)
})

test("the account is the token's, never the repository owner's: an env token is asked once, a work login is work for a personal-looking repo, an unknown one is unresolved", async (t) => {
  const { env, rows } = ledger(t)
  let users = 0
  const inner = async (url, init) => {
    if (url.endsWith("/user")) {
      users += 1
      return init.headers.Authorization.includes("work") ? answer(200, { login: "ari_microsoft" }) : init.headers.Authorization.includes("mystery") ? answer(401) : answer(200, { login: "ari" })
    }
    if (url.endsWith("/rate_limit")) return answer(200, { resources: { core: { remaining: 4000, reset: RESET, limit: 5000 } } })
    return answer(200, {}, quota(4000))
  }
  const fetchFn = ledgeredFetch(inner, { env, now: clockNow })
  await fetchFn("https://api.github.com/repos/ourostack/desk/pulls/1", auth("tok-work"))
  await fetchFn("https://api.github.com/repos/ourostack/desk/pulls/2", auth("tok-work"))
  await fetchFn("https://api.github.com/repos/microsoft/x/pulls/1", auth("tok-personal"))
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth("tok-mystery"))
  assert.equal(users, 3, "one lookup per token")
  assert.deepEqual(rows().map((r) => [r[1], r[2], r[5]]), [
    ["work", "api user", "apiget"], ["work", "api repos/ourostack/desk/pulls/1", "apiget"], ["work", "api repos/ourostack/desk/pulls/2", "apiget"],
    ["personal", "api user", "apiget"], ["personal", "api repos/microsoft/x/pulls/1", "apiget"],
    ["unresolved", "api user", "apiget"], ["unresolved", "api repos/o/r/pulls/1", "apiget"],
  ])
})

test("a lookup that gets no answer is recorded unknown and asked again, not kept as unresolved for the process", async (t) => {
  const { env, rows } = ledger(t)
  let users = 0
  const inner = async (url) => {
    if (url.endsWith("/user")) {
      users += 1
      if (users === 1) throw new Error("socket hang up")
      if (users === 2) return answer(502)
      return answer(200, { login: "ari_microsoft" })
    }
    if (url.endsWith("/rate_limit")) return answer(200, { resources: { core: { remaining: 4000, reset: RESET, limit: 5000 } } })
    return answer(200, {}, quota(4000))
  }
  const fetchFn = ledgeredFetch(inner, { env, now: clockNow })
  const url = "https://api.github.com/repos/o/r/pulls/1"
  await assert.rejects(fetchFn(url, auth("tok")), SpendHeld)
  await assert.rejects(fetchFn(url, auth("tok")), SpendHeld)
  await fetchFn(url, auth("tok"))
  assert.equal(users, 3)
  const seen = rows().map((r) => [r[1], r[2], r[5]]).filter((r) => r[1] === "api user")
  assert.deepEqual(seen, [["unresolved", "api user", "unknown"], ["unresolved", "api user", "unknown"], ["work", "api user", "apiget"]])
})

test("no ledger folder, MS_DESK_QUOTA=off, other hosts and anonymous requests leave the ledger alone", async (t) => {
  const { env, rows, root } = ledger(t)
  let sent = 0
  const inner = async () => { sent += 1; return answer() }
  const login = () => "a"
  await ledgeredFetch(inner, { env: { MS_DESK_QUOTA_DIR: path.join(root, "absent") }, login })("https://api.github.com/repos/o/r", auth())
  await ledgeredFetch(inner, { env: { ...env, MS_DESK_QUOTA: "off" }, login })("https://api.github.com/repos/o/r", auth())
  await ledgeredFetch(inner, { env, login })("https://example.com/repos/o/r", auth())
  await ledgeredFetch(inner, { env, login })("https://api.github.com/repos/o/r", { headers: { Accept: "x" } })
  assert.equal(sent, 4)
  assert.equal(rows().length, 0)
  assert.equal(existsSync(path.join(root, "absent")), false)
})

test("sequential exhaustion: answers' quota headers move the floor, so reads are refused before the minute-old snapshot would say so", async (t) => {
  const { dir, env, rows, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `700 ${RESET} 5000 ${NOW}\n`)
  const left = [650, 520, 499]
  let sent = 0
  const fetchFn = ledgeredFetch(async () => { sent += 1; return answer(200, {}, quota(left.shift())) }, { env, login: () => "ari", now: clockNow })
  for (const n of [1, 2, 3]) await fetchFn(`https://api.github.com/repos/o/r/issues/${n}`, auth())
  assert.deepEqual(rate("personal").slice(0, 2), [499, RESET])
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/issues/4", auth()), (e) => e instanceof SpendHeld && /499 of 5000 REST calls left, under the floor of 500/u.test(e.message))
  assert.equal(sent, 3)
  assert.deepEqual(rows().map((r) => r[5]), ["apiget", "apiget", "apiget", "refused"])
})

test("a missing snapshot is refreshed from the free rate_limit read, and headers from the GraphQL pool never touch the REST numbers", async (t) => {
  const { env, rate } = ledger(t)
  const urls = []
  const fetchFn = ledgeredFetch(async (url) => {
    urls.push(url)
    if (url.endsWith("/rate_limit")) return answer(200, { resources: { core: { remaining: 120, reset: RESET, limit: 5000 } } })
    return answer(200, {}, quota(4999, { "x-ratelimit-resource": "graphql" }))
  }, { env, login: () => "ari", now: clockNow })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/issues", auth()), SpendHeld)
  assert.deepEqual(urls, ["https://api.github.com/rate_limit"])
  assert.deepEqual(rate("personal"), [120, RESET, 5000, NOW])
  await fetchFn("https://api.github.com/graphql", { method: "POST", ...auth() })
  assert.equal(rate("personal")[0], 120, "GraphQL headers are another pool")
})

test("concurrent reads cannot raise the remaining count: the lowest answer in a window wins whatever order they land", async (t) => {
  const { dir, env, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `900 ${RESET} 5000 ${NOW}\n`)
  const left = [880, 870, 860]
  const releases = []
  const fetchFn = ledgeredFetch(async () => {
    const mine = left.shift()
    await new Promise((resolve) => releases.push(resolve))
    return answer(200, {}, quota(mine))
  }, { env, login: () => "ari", now: clockNow })
  const all = [1, 2, 3].map((n) => fetchFn(`https://api.github.com/repos/o/r/issues/${n}`, auth()))
  await new Promise((resolve) => setTimeout(resolve, 20))
  releases.reverse().forEach((release) => release())
  await Promise.all(all)
  assert.equal(rate("personal")[0], 860)
})

test("GraphQL and REST are separate pools: GraphQL rows are not REST spend, so they do not make a session the top spender", async (t) => {
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `300 ${RESET} 5000 ${NOW}\n`)
  writeFileSync(path.join(dir, "calls.log"), Array.from({ length: 50 }, () => `${NOW - 5}\tpersonal\tapi graphql\t${SESSION}\t\twrite\n`).join("") + `${NOW - 5}\tpersonal\tapi repos/o/r/pulls/9\tother-session\to/r\tapiget\n`)
  const fetchFn = ledgeredFetch(async () => answer(200, {}, quota(300)), { env, login: () => "ari", now: clockNow })
  // Merge-path read above the merge floor runs because this session's REST spend is 0, not 50.
  assert.equal((await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())).status, 200)
})

test("under the floor a read is refused before sending and logged refused; writes and GraphQL still run; the top REST spender loses merge-path reads too", async (t) => {
  const { dir, env, rows } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `300 ${RESET} 5000 ${NOW}\n`)
  let sent = 0
  const fetchFn = ledgeredFetch(async () => { sent += 1; return answer() }, { env, login: () => "ari", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/issues", auth()), (e) => /Wait until .*under the floor of 500/u.test(e.message))
  await fetchFn("https://api.github.com/repos/o/r/issues", { method: "PATCH", ...auth() })
  await fetchFn("https://api.github.com/graphql", { method: "POST", ...auth() })
  assert.equal(sent, 3)
  assert.deepEqual(rows().map((r) => r[5]), ["apiget", "refused", "write", "write"])
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/pulls/2", auth()), SpendHeld)
})

test("an account hold refuses reads", async (t) => {
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  writeFileSync(path.join(dir, "personal.hold"), `${NOW + 600}\tsecondary limit\n`)
  const fetchFn = ledgeredFetch(async () => answer(), { env, login: () => "ari", now: clockNow })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r", auth()), /on hold \(secondary limit\)/u)
})

test("a send that gets no answer is kept as unknown, not as a confirmed read, and the error still reaches the caller", async (t) => {
  const { env, rows, dir } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  const fetchFn = ledgeredFetch(async () => { throw Object.assign(new Error("aborted"), { name: "AbortError" }) }, { env, login: () => "ari", now: clockNow })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/pulls/1", auth()), /aborted/u)
  assert.deepEqual(rows().map((r) => [r[2], r[5]]), [["api repos/o/r/pulls/1", "unknown"]])
})

test("an unwritable ledger does not stop the call, but is raised as a process warning and counted, never reported as recorded", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") return t.skip("this host can write anywhere or ignores modes")
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  chmodSync(dir, 0o500)
  const warnings = []
  const onWarning = (warning) => warnings.push(warning)
  process.on("warning", onWarning)
  t.after(() => process.off("warning", onWarning))
  const before = unrecordedSends()
  const fetchFn = ledgeredFetch(async () => answer(200), { env, login: () => "ari", now: clockNow })
  assert.equal((await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())).status, 200)
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(unrecordedSends() > before)
  assert.ok(warnings.some((w) => w.code === "DESK_SPEND_UNRECORDED" && /Fix the permissions of the gh spend ledger folder/u.test(w.message)))
})

test("the delivery gate accounts an env GH_TOKEN to the token's account, is not_verified under the floor, and an anonymous read is not recorded", async (t) => {
  const { dir, env, rows } = ledger(t)
  const body = { merged_at: null, state: "open", head: { sha: "a" } }
  const reset = Math.floor(Date.now() / 1000) + 600
  const fetchFn = async (url) => (url.endsWith("/user") ? answer(200, { login: "ari_microsoft" }) : url.endsWith("/rate_limit") ? answer(200, { resources: { core: { remaining: 4000, reset, limit: 5000 } } }) : answer(200, body, quota(4000, { "x-ratelimit-reset": String(reset) })))
  await prDelivery({ repo: "ourostack/desk", number: 1, env: { ...env, GH_TOKEN: "synthetic-work" }, fetchFn })
  assert.ok(rows().length >= 2 && rows().every((r) => r[1] === "work"), JSON.stringify(rows()))
  const before = rows().length
  await prDelivery({ repo: "o/r", number: 1, env, fetchFn, ghRunner: async () => { throw new Error("signed out") } })
  assert.equal(rows().length, before, "no token, no account spend")
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(path.join(dir, "work.rate"), `10 ${now + 600} 5000 ${now}\n`)
  const result = await prDelivery({ repo: "o/r", number: 2, env: { ...env, GH_TOKEN: "synthetic-work" }, fetchFn: async (url) => (url.endsWith("/user") ? answer(200, { login: "ari_microsoft" }) : assert.fail("must not send")) })
  assert.equal(result.status, "not_verified")
  assert.match(result.reason, /under the floor/u)
})

test("a drain's read under the floor halts the poll as rate limited, and its sends are recorded", async (t) => {
  const { dir, env, rows } = ledger(t)
  const spawn = () => ({ status: 0, stdout: "tok" })
  let sent = 0
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${now + 600} 5000 ${now}\n`)
  const api = await connectGithub("ari", { spawn, fetchImpl: async () => { sent += 1; return answer(200, [], quota(4000, { "x-ratelimit-reset": String(now + 600) })) }, env, login: "ari" })
  await api.changedIssues("o/r", "2026-11-13T00:58:00Z")
  assert.equal(rows().at(-1)[5], "apiget")
  assert.match(rows().at(-1)[3], /^11111111/u)
  writeFileSync(path.join(dir, "personal.rate"), `10 ${now + 600} 5000 ${now}\n`)
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), (e) => e.code === "drains_rate_limited" && e.rateLimited === true && /under the floor/u.test(e.message))
  assert.equal(sent, 1)
})

test("the signed-in account is read from gh's hosts.yml for a drain with no account, and a gate token from gh", async (t) => {
  const { dir, env, rows, root } = ledger(t)
  const config = path.join(root, "gh")
  mkdirSync(config)
  writeFileSync(path.join(config, "hosts.yml"), "github.com:\n    users:\n        a:\n    user: ari_microsoft\n")
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(path.join(dir, "work.rate"), `4000 ${now + 600} 5000 ${now}\n`)
  const withConfig = { ...env, GH_CONFIG_DIR: config }
  const api = await connectGithub(undefined, { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: async () => answer(200, [], quota(4000, { "x-ratelimit-reset": String(now + 600) })), env: withConfig })
  await api.changedIssues("o/r", "2026-11-13T00:58:00Z")
  assert.equal(rows().at(-1)[1], "work")
  await prDelivery({ repo: "o/r", number: 1, env: withConfig, ghRunner: async () => ({ status: 0, stdout: "tok" }), fetchFn: async () => answer(200, { merged_at: null, state: "open" }, quota(4000, { "x-ratelimit-reset": String(now + 600) })) })
  assert.ok(rows().filter((r) => r[1] === "work").length >= 2)
  for (const home of [{ XDG_CONFIG_HOME: path.join(root, "x") }, { HOME: root }, {}]) assert.equal(activeLogin(home), "")
  assert.equal(activeLogin({ XDG_CONFIG_HOME: path.dirname(config) }), "ari_microsoft")
  assert.equal(activeLogin({ HOME: path.join(root, "nothing") }), "")
})

test("an error that is not a hold keeps its own shape for a drain and for the delivery gate", async (t) => {
  const { dir, env } = ledger(t)
  const now = Math.floor(Date.now() / 1000)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${now + 600} 5000 ${now}\n`)
  const api = await connectGithub("ari", { spawn: () => ({ status: 0, stdout: "tok" }), fetchImpl: async () => { throw new Error("socket closed") }, env, login: "ari" })
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), /socket closed/u)
  await assert.rejects(prDelivery({ repo: "o/r", number: 1, env: null }), TypeError)
})

test("quota numbers that cannot be stored never stop a call", async (t) => {
  if (process.getuid?.() === 0 || process.platform === "win32") return t.skip("this host can write anywhere or ignores modes")
  const { dir, env } = ledger(t)
  chmodSync(dir, 0o500)
  const fetchFn = ledgeredFetch(async (url) => (url.endsWith("/rate_limit") ? answer(200, { resources: { core: { remaining: 4000, reset: RESET, limit: 5000 } } }) : answer(200, {}, quota(4000))), { env, login: () => "ari", now: clockNow })
  assert.equal((await fetchFn("https://api.github.com/repos/o/r", auth())).status, 200)
})

test("the ledger folder is found from the state folder or home, and is left alone when it is missing, not a folder or unknown", (t) => {
  const { root, dir } = ledger(t)
  const state = path.join(root, "state")
  mkdirSync(path.join(state, "ms-desk", "gh-quota"), { recursive: true })
  const home = path.join(root, "home")
  mkdirSync(path.join(home, ".local", "state", "ms-desk", "gh-quota"), { recursive: true })
  writeFileSync(path.join(root, "afile"), "")
  assert.equal(ledgerDir({ XDG_STATE_HOME: state }, false), path.join(state, "ms-desk", "gh-quota"))
  assert.equal(ledgerDir({ HOME: home }, false), path.join(home, ".local", "state", "ms-desk", "gh-quota"))
  assert.equal(ledgerDir({ MS_DESK_QUOTA_DIR: dir }, true), dir, "an explicit folder is used even in a test run")
  assert.equal(ledgerDir({ HOME: home }, true), null, "a test run never touches the real state folder")
  for (const env of [{}, { MS_DESK_QUOTA_DIR: path.join(root, "missing") }, { MS_DESK_QUOTA_DIR: path.join(root, "afile") }, { MS_DESK_QUOTA: "off", MS_DESK_QUOTA_DIR: dir }]) assert.equal(ledgerDir(env, false), null)
})

test("odd ledger files are read for what they hold: a hold with no reason, a short rate file, a garbled one, poller rows and a log longer than the tail", async (t) => {
  const { dir, env } = ledger(t)
  const now = Math.floor(Date.now() / 1000)
  const send = (name) => ledgeredFetch(async (url) => (url.endsWith("/rate_limit") ? answer(500) : answer(200)), { env: { ...env, COPILOT_AGENT_SESSION_ID: name }, login: () => "ari" })("https://api.github.com/repos/o/r/pulls/1", auth())
  writeFileSync(path.join(dir, "personal.hold"), `${now + 600}\n`)
  await assert.rejects(send("s"), /no reason given/u)
  unlinkSync(path.join(dir, "personal.hold"))
  writeFileSync(path.join(dir, "personal.rate"), `10 ${now + 600}\n`)
  const filler = `${now}\tpersonal\tapi repos/o/r\tother\to/r\tapiget\n`
  writeFileSync(path.join(dir, "calls.log"), `${filler.repeat(Math.ceil((2 * 1024 * 1024) / filler.length) + 2)}${now}\tpersonal\tapi x\tother\to/r\tpollcalls\t7\n`)
  await assert.rejects(send("s"), /10 of \? REST calls left/u)
  writeFileSync(path.join(dir, "personal.rate"), "garbled\n")
  assert.equal((await send("s")).status, 200, "a garbled rate file is no floor, and a refresh that fails leaves it so")
})

test("answers about another API resource or an older window do not change the stored numbers", async (t) => {
  const { dir, env, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  const answers = [answer(200, {}, quota(100, { "x-ratelimit-resource": "search" })), answer(200, {}, quota(100, { "x-ratelimit-reset": String(RESET - 100) }))]
  const fetchFn = ledgeredFetch(async () => answers.shift(), { env, login: () => "ari", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r", auth())
  await fetchFn("https://api.github.com/repos/o/r", auth())
  assert.deepEqual(rate("personal").slice(0, 3), [4000, RESET, 5000])
})

test("a hosts.yml with no signed-in user gives no account", (t) => {
  const { root } = ledger(t)
  writeFileSync(path.join(root, "hosts.yml"), "github.com:\n    git_protocol: https\n")
  assert.equal(activeLogin({ GH_CONFIG_DIR: root }), "")
})

test("an expired hold is no hold, and reads that start together share one rate_limit lookup", async (t) => {
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.hold"), `${NOW - 10}\told reason\n`)
  let lookups = 0
  const inner = async (url) => {
    if (url.endsWith("/rate_limit")) {
      lookups += 1
      await new Promise((resolve) => setTimeout(resolve, 20))
      return answer(200, { resources: { core: { remaining: 4000, reset: RESET, limit: 5000 } } })
    }
    return answer(200)
  }
  const fetchFn = ledgeredFetch(inner, { env, login: () => "ari", now: clockNow })
  const results = await Promise.all([fetchFn("https://api.github.com/repos/o/r/pulls/1", auth()), fetchFn("https://api.github.com/repos/o/r/pulls/2", auth())])
  assert.deepEqual(results.map((r) => r.status), [200, 200])
  assert.equal(lookups, 1)
})

test("racing processes never leave a higher remaining than the lowest any of them saw", async (t) => {
  const { dir, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  const child = fileURLToPath(new URL("./_spend_ledger_child.mjs", import.meta.url))
  const starts = [3900, 3800, 3700, 3600, 3500, 3400]
  await Promise.all(starts.map((first) => new Promise((resolve, reject) => {
    const run = spawn(process.execPath, [child, dir, String(RESET), String(first), "150"], { stdio: "ignore" })
    run.on("error", reject)
    run.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`child exited ${code}`))))
  })))
  assert.equal(rate("personal")[0], 3400 - 149)
})

test("same-window numbers only ever tighten: a rate_limit answer cannot raise what a header already showed, and a later window replaces it", async (t) => {
  const { dir, env, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW - 120}\n`)
  const sends = [answer(200, {}, quota(3000))]
  const inner = async (url) => (url.endsWith("/rate_limit") ? answer(200, { resources: { core: { remaining: 3900, reset: RESET, limit: 5000 } } }) : sends.shift())
  const fetchFn = ledgeredFetch(inner, { env, login: () => "ari", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())
  assert.equal(rate("personal")[0], 3000)
  writeFileSync(path.join(dir, "personal.rate"), `3000 ${RESET} 5000 ${NOW - 120}\n`)
  await fetchFn("https://api.github.com/repos/o/r/pulls/2", auth()).catch(() => {})
  assert.equal(rate("personal")[0], 3000, "the refresh's 3900 is higher in the same window")
  sends.push(answer(200, {}, quota(4900, { "x-ratelimit-reset": String(RESET + 3600) })))
  await fetchFn("https://api.github.com/repos/o/r/pulls/3", auth())
  assert.deepEqual(rate("personal").slice(0, 2), [4900, RESET + 3600], "an older window is replaced")
  sends.push(answer(200, {}, quota(100)))
  await fetchFn("https://api.github.com/repos/o/r/pulls/4", auth())
  assert.deepEqual(rate("personal").slice(0, 2), [4900, RESET + 3600], "an answer from the earlier window is ignored")
})

test("two ceilings for one window keep the lower remaining and the ceiling of the answer that gave it, without treating the pools as one", async (t) => {
  const { dir, env, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4400 ${RESET} 5000 ${NOW}\n`)
  const answers = [answer(200, {}, quota(14400, { "x-ratelimit-limit": "15000" })), answer(200, {}, quota(3900, { "x-ratelimit-limit": "15000" }))]
  const fetchFn = ledgeredFetch(async () => answers.shift(), { env, login: () => "ari", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())
  assert.deepEqual(rate("personal").slice(0, 3), [4400, RESET, 5000])
  await fetchFn("https://api.github.com/repos/o/r/pulls/2", auth())
  assert.deepEqual(rate("personal").slice(0, 3), [3900, RESET, 15000])
})

test("a token whose account cannot be told is never read past the floor: a failed lookup holds the read, and nothing is sent", async (t) => {
  const { env, rows } = ledger(t)
  const sent = []
  const inner = async (url) => { sent.push(url); throw new Error("socket hang up") }
  const fetchFn = ledgeredFetch(inner, { env, now: clockNow })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/pulls/1", auth()), (error) => error.code === "spend_held" && /which account/u.test(error.message))
  assert.deepEqual(sent, ["https://api.github.com/user"])
  assert.deepEqual(rows().map((r) => [r[1], r[2], r[5]]), [["unresolved", "api user", "unknown"], ["unresolved", "api repos/o/r/pulls/1", "refused"]])
  assert.ok(unattributedSends() >= 2)
})

test("a token that is refused by /user is held to the floor of its own pool, read from the answers it gets", async (t) => {
  const { env, rows } = ledger(t)
  let remaining = 450
  const inner = async (url) => {
    if (url.endsWith("/user")) return answer(403, {}, quota(remaining))
    if (url.endsWith("/rate_limit")) return answer(200, { resources: { core: { remaining, reset: RESET, limit: 5000 } } })
    return answer(200, {}, quota(remaining))
  }
  const fetchFn = ledgeredFetch(inner, { env, now: clockNow })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/pulls/1", auth("installation-token")), /under the floor/u)
  assert.ok(rows().every((r) => r[1] === "unresolved"))
})

test("parallel first use of one token sends one /user lookup", async (t) => {
  const { env } = ledger(t)
  let users = 0
  const inner = async (url) => {
    if (url.endsWith("/user")) { users += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return answer(200, { login: "ari" }) }
    if (url.endsWith("/rate_limit")) return answer(200, { resources: { core: { remaining: 4000, reset: RESET, limit: 5000 } } })
    return answer(200, {}, quota(4000))
  }
  const fetchFn = ledgeredFetch(inner, { env, now: clockNow })
  await Promise.all([1, 2, 3].map((n) => fetchFn(`https://api.github.com/repos/o/r/pulls/${n}`, auth("tok-parallel"))))
  assert.equal(users, 1)
})

test("a higher number written over the file by a slower writer is corrected from the observation log, and a leftover lock file is ignored", async (t) => {
  const { dir, env, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  writeFileSync(path.join(dir, "personal.rate.lock"), "")
  const answers = [answer(200, {}, quota(3000)), answer(200, {}, quota(3500))]
  const fetchFn = ledgeredFetch(async () => answers.shift(), { env, login: () => "ari", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  await fetchFn("https://api.github.com/repos/o/r/pulls/2", auth())
  assert.equal(rate("personal")[0], 3000)
})

test("an observation log that cannot be written leaves the stored numbers alone and the send unharmed", async (t) => {
  const { dir, env, rate } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW}\n`)
  mkdirSync(path.join(dir, `personal.rate.obs.${RESET}`))
  const fetchFn = ledgeredFetch(async () => answer(200, {}, quota(3000)), { env, login: () => "ari", now: clockNow })
  assert.equal((await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())).status, 200)
  assert.equal(rate("personal")[0], 4000)
})

test("a rate-limited or synchronously failing /user lookup is held and asked again, never kept as no account", async (t) => {
  const { env } = ledger(t)
  let users = 0
  const inner = (url) => {
    if (url.endsWith("/user")) {
      users += 1
      if (users === 1) throw new Error("sync failure")
      if (users === 2) return Promise.resolve(answer(403, {}, { "x-ratelimit-remaining": "0" }))
      return Promise.resolve(answer(200, { login: "ari" }))
    }
    if (url.endsWith("/rate_limit")) return Promise.resolve(answer(200, { resources: { core: { remaining: 4000, reset: RESET, limit: 5000 } } }))
    return Promise.resolve(answer(200, {}, quota(4000)))
  }
  const fetchFn = ledgeredFetch(inner, { env, now: clockNow })
  const url = "https://api.github.com/repos/o/r/pulls/1"
  await assert.rejects(fetchFn(url, auth("tok-sync")), SpendHeld)
  await assert.rejects(fetchFn(url, auth("tok-sync")), SpendHeld)
  assert.equal((await fetchFn(url, auth("tok-sync"))).status, 200)
  assert.equal(users, 3)
})

test("the lowest remaining of a window is read from the whole window's log however long it is, earlier windows' logs go, and header answers leave the fetched time alone", async (t) => {
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `4000 ${RESET} 5000 ${NOW - 30}\n`)
  writeFileSync(path.join(dir, `personal.rate.obs.${RESET}`), `3 ${RESET} 500\n` + `4000 ${RESET} 5000\n`.repeat(5000))
  writeFileSync(path.join(dir, "personal.rate.obs.100"), "1 100 5000\n")
  mkdirSync(path.join(dir, "personal.rate.obs.99"))
  writeFileSync(path.join(dir, "personal.rate.obs.99", "keep"), "")
  const fetchFn = ledgeredFetch(async () => answer(200, {}, quota(3900)), { env, login: () => "ari", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/issues/1/comments", { ...auth(), method: "POST" })
  const [remaining, , limit, fetched] = readFileSync(path.join(dir, "personal.rate"), "utf8").trim().split(" ").map(Number)
  assert.deepEqual([remaining, limit, fetched], [3, 500, NOW - 30], "the 3 written first in the window beats 5000 later lines and carries its own ceiling")
  assert.equal(existsSync(path.join(dir, "personal.rate.obs.100")), false)
})

test("a writer whose rename lands after another's lower write is corrected before it returns, and a raised cache never lets a read through", async (t) => {
  const { dir, env, rate } = ledger(t)
  const file = path.join(dir, "personal.rate")
  writeFileSync(file, `4000 ${RESET} 5000 ${NOW}\n`)
  env.MS_DESK_GH_FLOOR = "3200"
  let raced = false
  const seen = []
  const settleHooks = {
    beforeWrite: () => {
      if (raced) return
      raced = true
      appendFileSync(`${file}.obs.${RESET}`, `3000 ${RESET} 5000\n`)
      writeFileSync(file, `3000 ${RESET} 5000 ${NOW}\n`)
    },
    afterWrite: () => seen.push(readFileSync(file, "utf8").split(" ")[0]),
  }
  let sent = 0
  const fetchFn = ledgeredFetch(async () => { sent += 1; return answer(200, {}, quota(3500)) }, { env, login: () => "ari", now: clockNow, settleHooks })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())
  assert.deepEqual(seen, ["3500", "3000"], "the last finisher first leaves 3500 over the 3000, then rewrites it before returning")
  assert.equal(rate("personal")[0], 3000)
  writeFileSync(file, `3500 ${RESET} 5000 ${NOW}\n`)
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/issues/1", auth()), SpendHeld)
  assert.equal(sent, 1, "the cache says 3500, above the floor; the observations say 3000, so the second read is held")
})

test("a quota file that another program keeps rewriting ends the settling with a warning, not silently", async (t) => {
  const { dir, env } = ledger(t)
  const file = path.join(dir, "personal.rate")
  writeFileSync(file, `4000 ${RESET} 5000 ${NOW}\n`)
  const warnings = []
  const onWarning = (warning) => warnings.push(warning.code)
  process.on("warning", onWarning)
  t.after(() => process.off("warning", onWarning))
  const settleHooks = { afterWrite: () => writeFileSync(file, `4999 ${RESET} 5000 ${NOW}\n`) }
  const fetchFn = ledgeredFetch(async () => answer(200, {}, quota(3000)), { env, login: () => "ari", now: clockNow, settleHooks })
  assert.equal((await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth())).status, 200)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(warnings, ["DESK_SPEND_QUOTA_UNSETTLED"])
})

test("a log that cannot be read is skipped, so a read still decides from the stored numbers", async (t) => {
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `100 ${RESET} 5000 ${NOW}\n`)
  mkdirSync(path.join(dir, `personal.rate.obs.${RESET}`))
  const fetchFn = ledgeredFetch(async () => answer(200, {}, quota(100)), { env, login: () => "ari", now: clockNow })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/issues/1", auth()), SpendHeld)
})

test("the first numbers ever seen for an account, from a write's headers, are stored as fetched now", async (t) => {
  const { dir, env, rate } = ledger(t)
  const fetchFn = ledgeredFetch(async () => answer(200, {}, quota(4321)), { env, login: () => "ari", now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/issues/1/comments", { ...auth(), method: "POST" })
  assert.deepEqual(rate("personal").slice(0, 2), [4321, RESET])
  assert.equal(Number(readFileSync(path.join(dir, "personal.rate"), "utf8").trim().split(" ")[3]), clockNow() / 1000)
})

test("a ledger folder that cannot be listed still decides reads from the stored numbers and keeps the writer's own observation", async (t) => {
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `100 ${RESET} 5000 ${NOW}\n`)
  chmodSync(dir, 0o300)
  const fetchFn = ledgeredFetch(async () => answer(200, {}, quota(90)), { env, login: () => "ari", now: clockNow })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/issues/1", auth()), SpendHeld)
  assert.equal((await fetchFn("https://api.github.com/repos/o/r/issues/1/comments", { ...auth(), method: "POST" })).status, 200)
  chmodSync(dir, 0o700)
  assert.equal(readFileSync(path.join(dir, "personal.rate"), "utf8").split(" ")[0], "90")
})

test("a /user answer whose login is not text leaves the token unresolved", async (t) => {
  const { env, rows } = ledger(t)
  const inner = async (url) => (url.endsWith("/user") ? answer(200, { login: 5 }) : answer(200, {}, quota(4000)))
  const fetchFn = ledgeredFetch(inner, { env, now: clockNow })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1", auth("tok-odd"))
  assert.deepEqual(rows().map((r) => [r[1], r[2]]), [["unresolved", "api user"], ["unresolved", "api repos/o/r/pulls/1"]])
})
