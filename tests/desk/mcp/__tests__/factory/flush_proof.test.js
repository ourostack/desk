// A proof-marked session whose record the store holds is withdrawn through the existing retraction path, whatever its route says, and is tombstoned
// once the store no longer holds it. Each case runs the real flush against the in-memory GitHub model in `_fake_github.js`, with synthetic sessions
// and temporary state only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { markProofSession } from "../../../../../plugins/desk/mcp/src/factory/proof-session.js"
import { factoryStateRoot, readDelivered, setConsent, writeLocalFacts, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, recent, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const SLUG = "ourostack__factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n, host = "claude-code") => `${host}-${sessionId(n)}.json`

function localFacts(n) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  return value
}

const run = (env, github) => flush(env, { store: STORE, runner: github.runner, anonymousLookup: github.anonymousLookup })

async function deskFor(base, name) {
  const desk = path.join(base, name)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store: STORE }))
  return desk
}

async function marker(env, base, n, desk, host = "claude-code") {
  const log = path.join(base, `log-${host}-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host, session_id: sessionId(n), log_path: log, cwd: base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: recent() })
}

// Session `n` is ordinary, routed here, and published: its facts are on the store's default branch, merged.
async function published(ctx, n) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await marker(ctx.env, ctx.base, n, await deskFor(ctx.base, `desk-${n}`))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  // The flush that sees the merged file on the default branch is the one that records its delivery.
  await run(ctx.env, github)
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).blobs, nameOf(n)))
  assert.ok(github.mainFiles().has(`facts/${nameOf(n)}`))
  return github
}

const root = (ctx) => factoryStateRoot(ctx.env)
const auditEntries = async (ctx) => JSON.parse(await fs.readFile(path.join(await root(ctx), "proof-audit.json"), "utf8")).entries
const mark = (ctx, n) => markProofSession(ctx.env, { sessionId: sessionId(n) })

test("a proof session the store holds is withdrawn while its route still resolves here, and is tombstoned once merged", () => scratch(async (ctx) => {
  const github = await published(ctx, 1)
  assert.deepEqual(await mark(ctx, 1), { result: "marked" })
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.ok(github.mainFiles().has(`facts/${nameOf(1)}`), "the delete waits for its pull request to merge")
  github.mergeOpenPr()
  assert.equal(github.mainFiles().has(`facts/${nameOf(1)}`), false)
  await run(ctx.env, github)
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracted, nameOf(1)))
  const outcomes = (await auditEntries(ctx)).filter(({ reason }) => reason === "proof").map(({ action, state_before, outcome }) => [action, state_before, outcome])
  assert.deepEqual(outcomes, [["withdraw", "published", "pushed"], ["withdraw", "retracting", "withdrawn"]])
  await another(ctx, github, 9)
  assert.equal(github.mainFiles().has(`facts/${nameOf(1)}`), false, "a withdrawn session is never re-added")
}))

test("a withdrawal already in an open pull request is read back and not pushed again", () => scratch(async (ctx) => {
  const github = await published(ctx, 2)
  await mark(ctx, 2)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  const pulls = github.pullCount()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(github.pullCount(), pulls)
  assert.ok(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracting, nameOf(2)))
}))

test("an unmarked session, and a session two hosts record, are left on the store", () => scratch(async (ctx) => {
  const github = await published(ctx, 3)
  await marker(ctx.env, ctx.base, 4, await deskFor(ctx.base, "desk-4"), "copilot-cli")
  await marker(ctx.env, ctx.base, 4, await deskFor(ctx.base, "desk-4-claude"), "claude-code")
  assert.deepEqual(await mark(ctx, 4), { result: "refused", reason: "ambiguous" })
  await another(ctx, github, 9)
  assert.ok(github.mainFiles().has(`facts/${nameOf(3)}`))
  assert.equal(github.mainFiles().has(`facts/${nameOf(4)}`), false)
  assert.equal(Object.hasOwn((await readDelivered(ctx.env, STORE)).retracting, nameOf(3)), false)
}))

// Publishes session `n` as an ordinary session of its own desk, so a flush goes online for a reason of its own.
async function another(ctx, github, n) {
  await marker(ctx.env, ctx.base, n, await deskFor(ctx.base, `desk-${n}`))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
}
