import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { ledgeredFetch, SpendHeld } from "../../../../../plugins/desk/mcp/src/runtime/spend-ledger.js"
import { connectGithub } from "../../../../../plugins/desk/mcp/src/runtime/drains.js"
import { prDelivery } from "../../../../../plugins/desk/mcp/src/tools/delivery-gate.js"

const NOW = 1_800_000_000
const ok = (status = 200, body = "{}") => ({ ok: status < 400, status, headers: { get: () => null, has: () => false }, text: async () => body, json: async () => JSON.parse(body) })

function ledger(t) {
  const root = mkdtempSync(path.join(tmpdir(), "spend-ledger-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, "gh-quota")
  mkdirSync(dir)
  const env = { MS_DESK_QUOTA_DIR: dir, COPILOT_AGENT_SESSION_ID: "11111111-synthetic-session" }
  const rows = () => (existsSync(path.join(dir, "calls.log")) ? readFileSync(path.join(dir, "calls.log"), "utf8").trim().split("\n").filter(Boolean).map((line) => line.split("\t")) : [])
  return { dir, env, rows, root }
}

test("each answer is one ledger row with session, kind, route without query and repository; a 304 is free; writes are marked write", async (t) => {
  const { env, rows } = ledger(t)
  const answers = [ok(), ok(304), ok(201)]
  const fetchFn = ledgeredFetch(async () => answers.shift(), { env, login: () => "ari_microsoft", now: () => NOW * 1000 })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1?x=secret", { headers: { Authorization: "Bearer tok" } })
  await fetchFn("https://api.github.com/repos/o/r/issues", {})
  await fetchFn("https://api.github.com/repos/o/r/issues", { method: "POST", body: "payload" })
  assert.deepEqual(rows(), [
    [String(NOW), "work", "api repos/o/r/pulls/1", "11111111-synthetic-session", "o/r", "apiget"],
    [String(NOW), "work", "api repos/o/r/issues", "11111111-synthetic-session", "o/r", "etag"],
    [String(NOW), "work", "api repos/o/r/issues", "11111111-synthetic-session", "o/r", "write"],
  ])
  assert.doesNotMatch(JSON.stringify(rows()), /secret|tok|payload/u)
})

test("no ledger folder, MS_DESK_QUOTA=off, other hosts and a thrown fetch leave the ledger alone", async (t) => {
  const { dir, env, rows, root } = ledger(t)
  let sent = 0
  const inner = async () => { sent += 1; return ok() }
  await ledgeredFetch(inner, { env: { MS_DESK_QUOTA_DIR: path.join(root, "absent") }, login: () => "a" })("https://api.github.com/repos/o/r")
  await ledgeredFetch(inner, { env: { ...env, MS_DESK_QUOTA: "off" }, login: () => "a" })("https://api.github.com/repos/o/r")
  await ledgeredFetch(inner, { env, login: () => "a" })("https://example.com/repos/o/r")
  await assert.rejects(ledgeredFetch(async () => { throw new Error("net") }, { env, login: () => "a" })("https://api.github.com/repos/o/r"))
  assert.equal(sent, 3)
  assert.equal(rows().length, 0)
  assert.equal(existsSync(path.join(root, "absent")), false)
  assert.ok(dir)
})

test("under the floor a read is refused before sending and logged refused; writes and merge-path reads for other sessions still run", async (t) => {
  const { dir, env, rows } = ledger(t)
  writeFileSync(path.join(dir, "personal.rate"), `300 ${NOW + 600} 5000 ${NOW}\n`)
  let sent = 0
  const fetchFn = ledgeredFetch(async () => { sent += 1; return ok() }, { env, login: () => "ari", now: () => NOW * 1000 })
  await fetchFn("https://api.github.com/repos/o/r/pulls/1") // no spend yet: not the top spender, merge path, above merge floor
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/issues"), (e) => e instanceof SpendHeld && /Wait until .*under the floor of 500/u.test(e.message))
  await fetchFn("https://api.github.com/repos/o/r/issues", { method: "PATCH" })
  await fetchFn("https://api.github.com/graphql", { method: "POST" })
  assert.equal(sent, 3)
  assert.deepEqual(rows().map((r) => r[5]), ["apiget", "refused", "write", "write"])
  // Now this session is the top spender, so even merge-path reads are held.
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r/pulls/2"), SpendHeld)
})

test("an account hold refuses reads", async (t) => {
  const { dir, env } = ledger(t)
  writeFileSync(path.join(dir, "personal.hold"), `${NOW + 600}\tsecondary limit\n`)
  const fetchFn = ledgeredFetch(async () => ok(), { env, login: () => "ari", now: () => NOW * 1000 })
  await assert.rejects(fetchFn("https://api.github.com/repos/o/r"), /on hold \(secondary limit\)/u)
})

test("the delivery gate records its authenticated reads, is not_verified under the floor, and an anonymous read is not recorded", async (t) => {
  const { dir, env, rows } = ledger(t)
  const fetchFn = async () => ok(200, JSON.stringify({ merged_at: null, state: "open", head: { sha: "a" } }))
  await prDelivery({ repo: "o/r", number: 1, env: { ...env, GH_TOKEN: "synthetic" }, fetchFn })
  assert.ok(rows().length >= 1 && rows().every((r) => r[5] === "apiget" || r[5] === "write"))
  const before = rows().length
  await prDelivery({ repo: "o/r", number: 1, env, fetchFn, ghRunner: async () => { throw new Error("signed out") } })
  assert.equal(rows().length, before, "no token, no account spend")
  writeFileSync(path.join(dir, "personal.rate"), `10 ${Math.floor(Date.now() / 1000) + 600} 5000 0\n`)
  const result = await prDelivery({ repo: "o/r", number: 2, env: { ...env, GH_TOKEN: "synthetic" }, fetchFn: async () => assert.fail("must not send") })
  assert.equal(result.status, "not_verified")
  assert.match(result.reason, /under the floor/u)
})

test("a drain's read under the floor halts the poll as rate limited, and its sends are recorded", async (t) => {
  const { dir, env, rows } = ledger(t)
  const spawn = () => ({ status: 0, stdout: "tok" })
  let sent = 0
  const api = await connectGithub("ari", { spawn, fetchImpl: async () => { sent += 1; return ok(200, "[]") }, env, login: "ari" })
  await api.changedIssues("o/r", "2026-11-13T00:58:00Z")
  assert.equal(rows().at(-1)[5], "apiget")
  assert.match(rows().at(-1)[3], /^11111111/u)
  writeFileSync(path.join(dir, "personal.rate"), `10 ${Math.floor(Date.now() / 1000) + 600} 5000 0\n`)
  await assert.rejects(api.changedIssues("o/r", "2026-11-13T00:58:00Z"), (e) => e.code === "drains_rate_limited" && e.rateLimited === true && /under the floor/u.test(e.message))
  assert.equal(sent, 1)
})
