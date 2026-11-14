// A controlled proof session's copies are moved out of the outbox and never publish, and `factory.js proof` marks an existing local session
// only when this machine's own marker shows a desk recorded it. Each case runs the real flush against the in-memory GitHub model in
// `_fake_github.js`, with synthetic sessions and temporary state only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { markProofSession } from "../../../../../plugins/desk/mcp/src/factory/proof-session.js"
import { factoryStateRoot, markSessionProof, pendingFiles, pendingLabels, setConsent, settledProofChecks, settleProofChecks, writeLocalFacts, writeLocalLabels, writeMarker, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { main } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, recent, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
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

async function deskFor(base, name, store = STORE) {
  const desk = path.join(base, name)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  await fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
  return desk
}

// A session's marker as its end hook writes it: `desk` is the desk root it ran in (`null` for a session no desk recorded).
async function marker(env, base, n, desk, host = "claude-code") {
  const log = path.join(base, `log-${host}-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host, session_id: sessionId(n), log_path: log, cwd: base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: recent() })
}

// Session 9 is routed here and new, so a flush goes online for a reason of its own.
async function another(ctx) {
  await marker(ctx.env, ctx.base, 9, await deskFor(ctx.base, "desk-9"))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(9))).written, true)
}

// Session 1: an ordinary, queued session of a desk that declares the store, with its facts and labels in the outbox.
async function queuedSession(ctx) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1")
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(1) })).written, true)
  return desk
}

const stateRoot = (ctx) => factoryStateRoot(ctx.env)
const outboxHas = async (ctx, name) => fs.stat(path.join(await stateRoot(ctx), "outbox", SLUG, name)).then(() => true, () => false)
const labelsHas = async (ctx) => fs.stat(path.join(await stateRoot(ctx), "labels", SLUG, LABELS.job, `${sessionId(1)}.json`)).then(() => true, () => false)
const heldHas = async (ctx, name) => fs.stat(path.join(await stateRoot(ctx), "proof-held", SLUG, name)).then(() => true, () => false)
const auditText = async (ctx) => fs.readFile(path.join(await stateRoot(ctx), "proof-audit.json"), "utf8")
const auditEntries = async (ctx) => JSON.parse(await auditText(ctx)).entries
const markerOf = async (ctx, n, host = "claude-code") => JSON.parse(await fs.readFile(path.join(await stateRoot(ctx), "markers", `${host}-${sessionId(n)}.json`), "utf8"))
const mark = (ctx, n, desk) => markProofSession(ctx.env, { sessionId: sessionId(n), desk: desk ?? null })

test("an owned queued proof copy is moved out of the outbox, kept, and never published", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  assert.deepEqual(await mark(ctx, 1), { result: "marked" })
  await another(ctx)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal(github.mainFiles().has(`facts/${nameOf(1)}`), false)
  assert.equal(github.mainFiles().has(`facts/${nameOf(9)}`), true)
  assert.equal(await outboxHas(ctx, nameOf(1)), false)
  assert.equal(await heldHas(ctx, nameOf(1)), true)
  const entries = await auditEntries(ctx)
  assert.deepEqual(entries.map(({ action, outcome, state_before }) => [action, outcome, state_before]), [["mark", "ok", "ordinary"], ["moved_to_held", "ok", "outbox"], ["moved_to_held", "ok", "outbox"]])
}))

test("a proof session's queued labels are moved out of the outbox and never published", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  assert.deepEqual(await mark(ctx, 1), { result: "marked" })
  await another(ctx)
  const github = fakeGitHub()
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.equal([...github.mainFiles().keys()].some((name) => name.startsWith("labels/")), false)
  assert.equal(await labelsHas(ctx), false)
  assert.equal(await heldHas(ctx, `labels/${LABELS.job}/${sessionId(1)}.json`), true)
}))

test("pendingFiles and pendingLabels skip a proof-marked session even without a precomputed set", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  await mark(ctx, 1)
  await another(ctx)
  const pending = await pendingFiles(ctx.env, STORE, { publishedBytesFor: (facts) => Buffer.from(JSON.stringify(facts)) })
  assert.deepEqual(pending.map(({ name }) => name), [nameOf(9)])
  assert.deepEqual(await pendingLabels(ctx.env, STORE, { publishedBytesFor: (labels) => Buffer.from(JSON.stringify(labels)) }), [])
}))

test("marking twice is idempotent and audited as already marked", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  assert.deepEqual(await mark(ctx, 1), { result: "marked" })
  assert.deepEqual(await mark(ctx, 1), { result: "already_proof" })
  const last = (await auditEntries(ctx)).at(-1)
  assert.deepEqual([last.action, last.outcome], ["none", "already"])
  assert.equal((await markerOf(ctx, 1)).proof, true)
}))

test("an unknown session id is refused and nothing is changed", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  assert.deepEqual(await mark(ctx, 42), { result: "refused", reason: "unknown" })
  assert.equal((await auditEntries(ctx))[0].outcome, "refused_unknown")
  assert.equal(await fs.stat(path.join(await stateRoot(ctx), "markers", nameOf(42))).then(() => true, () => false), false)
}))

test("a session another desk recorded is refused as foreign, and the one pinned desk accepts it", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const owner = await deskFor(ctx.base, "desk-owner")
  const other = await deskFor(ctx.base, "desk-other")
  await marker(ctx.env, ctx.base, 3, owner)
  assert.deepEqual(await mark(ctx, 3, other), { result: "refused", reason: "foreign" })
  assert.equal((await markerOf(ctx, 3)).proof, undefined)
  assert.deepEqual(await mark(ctx, 3, owner), { result: "marked" })
}))

test("a session no desk recorded is refused as foreign", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await marker(ctx.env, ctx.base, 4, null)
  assert.deepEqual(await mark(ctx, 4), { result: "refused", reason: "foreign" })
}))

test("a session recorded by two hosts is refused as ambiguous, and neither host is marked", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-5")
  await marker(ctx.env, ctx.base, 5, desk, "claude-code")
  await marker(ctx.env, ctx.base, 5, desk, "copilot-cli")
  assert.deepEqual(await mark(ctx, 5), { result: "refused", reason: "ambiguous" })
  assert.equal((await markerOf(ctx, 5)).proof, undefined)
  assert.equal((await markerOf(ctx, 5, "copilot-cli")).proof, undefined)
}))

test("a session only the derivation ledger knows is refused, because its marker is gone", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await another(ctx)
  await writeStatus(ctx.env, { derivations: { [nameOf(6)]: { desk_root: ctx.desk }, [nameOf(7)]: { desk_root: ctx.desk } } })
  assert.deepEqual(await mark(ctx, 6), { result: "refused", reason: "no_marker" })
}))

test("a malformed id is refused without an audit entry or a state folder, and so is any id on a machine with no state", () => scratch(async (ctx) => {
  assert.deepEqual(await markProofSession(ctx.env, { sessionId: "not-a-session" }), { result: "refused", reason: "invalid_id" })
  assert.deepEqual(await mark(ctx, 1), { result: "refused", reason: "unknown" })
  assert.equal(await fs.stat(path.join(ctx.base, "state")).then(() => true, () => false), false)
}))

test("a move the disk refuses is audited as failed, and the next flush completes it", { skip: process.platform === "win32" && "POSIX directory modes" }, () => scratch(async (ctx) => {
  await queuedSession(ctx)
  await mark(ctx, 1)
  await another(ctx)
  const outbox = path.join(await stateRoot(ctx), "outbox", SLUG)
  await fs.chmod(outbox, 0o555)
  const github = fakeGitHub()
  try {
    await run(ctx.env, github)
  } finally {
    await fs.chmod(outbox, 0o755)
  }
  assert.equal((await auditEntries(ctx)).some(({ outcome }) => outcome === "failed"), true)
  assert.equal(await outboxHas(ctx, nameOf(1)), true)
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.equal((await auditEntries(ctx)).at(-1).outcome, "ok")
  assert.equal(await outboxHas(ctx, nameOf(1)), false)
  assert.equal(github.mainFiles().has(`facts/${nameOf(1)}`), false)
}))

test("the audit and the command's output hold no session id, path or account", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  await mark(ctx, 1)
  await another(ctx)
  await run(ctx.env, fakeGitHub())
  await mark(ctx, 42)
  const out = []
  const err = []
  const code = await main({ argv: ["proof", sessionId(1), "--desk", path.join(ctx.base, "desk-1")], env: ctx.env, write: (text) => out.push(text), logError: (text) => err.push(text) })
  const everything = [await auditText(ctx), out.join(""), err.join("")].join("\n")
  for (const secret of [sessionId(1), sessionId(42), ctx.base, "contributor", "desk-1"]) assert.equal(everything.includes(secret), false, `${secret} leaked`)
  assert.equal(code, 0)
  assert.deepEqual(JSON.parse(out.join("")), { result: "already_proof" })
}))

test("the proof command exits 1 for a refused id and names the reason in its JSON only", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  const out = []
  const code = await main({ argv: ["proof", sessionId(77)], env: ctx.env, write: (text) => out.push(text), logError: () => {} })
  assert.equal(code, 1)
  assert.deepEqual(JSON.parse(out.join("")), { result: "refused", reason: "unknown" })
}))

test("a session whose desk folder is gone is refused as foreign", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const gone = await deskFor(ctx.base, "desk-gone")
  await marker(ctx.env, ctx.base, 10, gone)
  await fs.rm(gone, { recursive: true, force: true })
  assert.deepEqual(await mark(ctx, 10), { result: "refused", reason: "foreign" })
}))

test("a failed write is read back before it is reported: landed, not landed, gone, or unreadable", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  const refused = async () => {
    throw new Error("write refused")
  }
  const readsProof = async () => [{ host: "claude-code", marker: { proof: true } }]
  const readsOrdinary = async () => [{ host: "claude-code", marker: { proof: false } }]
  const readsNothing = async () => []
  const unreadable = async () => {
    throw new Error("unreadable")
  }
  const attempt = (readBack) => markProofSession(ctx.env, { sessionId: sessionId(1), write: refused, readBack })
  assert.deepEqual(await attempt(readsProof), { result: "marked" })
  assert.deepEqual(await attempt(readsOrdinary), { result: "failed" })
  assert.deepEqual(await attempt(readsNothing), { result: "failed" })
  assert.deepEqual(await attempt(unreadable), { result: "uncertain" })
  assert.deepEqual((await auditEntries(ctx)).slice(-4).map(({ action, outcome }) => [action, outcome]), [["mark", "ok"], ["mark", "failed"], ["mark", "failed"], ["mark", "uncertain"]])
}))

test("a write that finds the mark already set is reported as already marked", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  assert.deepEqual(await markProofSession(ctx.env, { sessionId: sessionId(1), write: async () => "already" }), { result: "already_proof" })
  assert.equal((await auditEntries(ctx)).at(-1).action, "none")
}))

test("the proof command rejects a missing id, a relative desk root or an unknown option with a usage line", () => scratch(async (ctx) => {
  for (const argv of [["proof"], ["proof", "--desk", ctx.base], ["proof", sessionId(1), "--desk"], ["proof", sessionId(1), "--desk", "relative/desk"], ["proof", sessionId(1), "--mode", "x"]]) {
    const err = []
    assert.equal(await main({ argv, env: ctx.env, write: () => {}, logError: (text) => err.push(text) }), 1)
    assert.match(err.join(""), /Usage: factory\.js proof <session id>/)
  }
}))

test("a proof session's copy the store already holds is moved out of the outbox and is never republished", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  const published = github.mainFiles().get(`facts/${nameOf(1)}`)
  assert.ok(published)
  assert.deepEqual(await mark(ctx, 1), { result: "marked" })
  const changed = localFacts(1)
  changed.counts.tool_calls.shell = 999
  assert.equal((await writeLocalFacts(ctx.env, STORE, changed)).written, true)
  await another(ctx)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal(github.mainFiles().get(`facts/${nameOf(1)}`), published)
  assert.equal(await outboxHas(ctx, nameOf(1)), false)
  assert.equal(await heldHas(ctx, nameOf(1)), true)
}))

test("markSessionProof writes the mark once, reports an existing mark, and refuses a marker it cannot read", () => scratch(async (ctx) => {
  await queuedSession(ctx)
  const target = { host: "claude-code", session_id: sessionId(1) }
  assert.equal(await markSessionProof(ctx.env, target), "marked")
  assert.equal(await markSessionProof(ctx.env, target), "already")
  await fs.writeFile(path.join(await stateRoot(ctx), "markers", nameOf(1)), "{}")
  await assert.rejects(markSessionProof(ctx.env, target))
  assert.deepEqual(await mark(ctx, 1), { result: "refused", reason: "unknown" })
}))

test("the settled proof checks are remembered per store, each name once, and an empty settle writes nothing", () => scratch(async (ctx) => {
  const other = "someone/else"
  assert.deepEqual([...await settledProofChecks(ctx.env, STORE)], [])
  await settleProofChecks(ctx.env, STORE, [])
  await settleProofChecks(ctx.env, STORE, ["facts-a.json"])
  await settleProofChecks(ctx.env, STORE, ["facts-a.json", "facts-b.json"])
  await settleProofChecks(ctx.env, other, ["facts-c.json"])
  assert.deepEqual([...await settledProofChecks(ctx.env, STORE)], ["facts-a.json", "facts-b.json"])
  assert.deepEqual([...await settledProofChecks(ctx.env, other)], ["facts-c.json"])
}))
