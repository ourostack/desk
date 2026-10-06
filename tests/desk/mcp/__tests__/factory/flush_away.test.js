// "Away" fails closed. A session whose desk routes it away from a store keeps the store it left from ever receiving it again, even when every
// record that says "away" except the place its copies sit is lost: the marker pruned, `status.json` lost, corrupt or stale, the retracting file
// unreadable. The flush moves the copies of every session that is not `here` out of the outbox into `retracted-copies/` (where an older Desk's
// flush never looks, and where a copy without a positive route here stays frozen), and the sweep does the same for a store whose own flush does
// not run. Each case runs the real flush against the in-memory GitHub model in `_fake_github.js`, with synthetic fixtures only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs, readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { flush } from "../../../../../plugins/desk/mcp/src/factory/flush.js"
import { sweep } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import {
  factoryStateRoot, gitBlobSha, keptSessions, quarantine, readConsent, readDelivered, readStatus, setConsent, writeLocalFacts, writeLocalLabels, writeMarker, writeStatus,
} from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { fakeGitHub } from "./_fake_github.js"
import { STORE, json, scratch } from "./_session_helpers.js"

const GOLDEN = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/local-golden.json", import.meta.url)), "utf8"))
const LABELS = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/labels-golden.json", import.meta.url)), "utf8"))
const OTHER = "shared-internal-tools/ms-desk-factory"
const SLUG = "ourostack__factory"
const sessionId = (n) => `${n.toString(16).padStart(8, "0")}-0000-4000-8000-${n.toString(16).padStart(12, "0")}`
const nameOf = (n, host = "claude-code") => `${host}-${sessionId(n)}.json`

// Session `n`'s local facts; `version` changes what it publishes, as a later derive of a longer session does.
function localFacts(n, version = 1) {
  const value = structuredClone(GOLDEN)
  value.session.id = sessionId(n)
  value.refs = { prs: [], commits: [], unresolved: { prs: 0, commits: 0 } }
  value.counts.tool_calls.shell = 120 + version
  return value
}

const run = (env, github, store = STORE) => flush(env, { store, runner: github.runner, anonymousLookup: github.anonymousLookup })

async function deskFor(base, name, store) {
  const desk = path.join(base, name)
  await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
  if (store !== null) await fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))
  return desk
}
const reroute = (desk, store) => fs.writeFile(path.join(desk, "_meta", "factory.json"), JSON.stringify({ schema_version: 1, store }))

async function marker(env, base, n, desk, extra = {}) {
  const log = path.join(base, `log-${n}.jsonl`)
  await fs.writeFile(log, "{}\n")
  await writeMarker(env, { schema_version: 1, host: "claude-code", session_id: sessionId(n), log_path: log, cwd: base, desk_root: desk, end_reason: null, ended_at: null, plugins: [{ name: "desk", version: "1.0.0" }], updated_at: new Date().toISOString(), ...extra })
}

// Session 9, routed to the store, so a flush goes online for a reason of its own.
async function another(ctx, n = 9) {
  await marker(ctx.env, ctx.base, n, await deskFor(ctx.base, `desk-${n}`, STORE))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
}

// Session 1 delivered and merged, from a desk that declares the store, with labels.
async function delivered(ctx) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(1) })).written, true)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.equal((await run(ctx.env, github)).result, "nothing_pending")
  return { github, desk }
}

const root = (ctx) => factoryStateRoot(ctx.env)
const loseMarker = async (ctx, n = 1) => fs.rm(path.join(await root(ctx), "markers", nameOf(n)))
const loseStatus = async (ctx) => fs.rm(path.join(await root(ctx), "status.json"), { force: true })
const mainBlob = (github, n) => github.mainFiles().get(`facts/${nameOf(n)}`)
const outboxHas = async (ctx, n, slug = SLUG) => fs.stat(path.join(await root(ctx), "outbox", slug, nameOf(n))).then(() => true, () => false)
const keptHas = async (ctx, n, slug = SLUG) => fs.stat(path.join(await root(ctx), "retracted-copies", slug, nameOf(n))).then(() => true, () => false)

// One more flush that goes online (session 9 is new), then the merge: what the store's main holds after it.
async function onlineAgain(ctx, github, n = 9) {
  await another(ctx, n)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
}

// ---------------------------------------------------------------------------
// The two reproduced cases and the hardening case.
// ---------------------------------------------------------------------------

test("case 1: a held session that routes away is never released to the store it left, even once its marker is pruned and status.json is lost", () => scratch(async (ctx) => {
  const { github, desk } = await delivered(ctx)
  const before = mainBlob(github, 1)
  // A later derive (v2) is refused by the store and held; then the desk routes elsewhere. The held session is frozen, never deleted.
  await fs.writeFile(path.join(await root(ctx), "outbox", SLUG, nameOf(1)), JSON.stringify(localFacts(1, 2)))
  await quarantine(ctx.env, STORE, nameOf(1), "invalid", { blob: "e".repeat(40) })
  await reroute(desk, OTHER)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal((await readStatus(ctx.env)).last_flush[STORE].held_elsewhere, 2, "its facts and labels")
  await loseMarker(ctx)
  await loseStatus(ctx)
  await onlineAgain(ctx, github)
  assert.equal(mainBlob(github, 1), before, "the store still holds v1: v2 was never released to it")
  assert.equal((await readDelivered(ctx.env, STORE)).quarantined.has(nameOf(1)), true)
  // "Away" is durable outside status.json: the copies left the outbox.
  assert.equal(await outboxHas(ctx, 1), false)
  assert.equal(await keptHas(ctx, 1), true)
}))

test("case 2: an undelivered copy whose desk rerouted before delivery is never published to the old store once its marker is pruned and status.json is lost", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await reroute(desk, OTHER)
  const github = fakeGitHub()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(github.calls.length, 0, "an away session costs no network call")
  await loseMarker(ctx)
  await loseStatus(ctx)
  await onlineAgain(ctx, github)
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
  assert.equal(await keptHas(ctx, 1), true)
}))

test("hardening: a retracted session whose only copy is held, with the retracting file and status.json both unreadable, is never published again", () => scratch(async (ctx) => {
  const { github, desk } = await delivered(ctx)
  await reroute(desk, OTHER)
  await run(ctx.env, github)
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  // The kept copy put back in the outbox by hand and held, the only copy left; the retracting file and status.json corrupt.
  const state = await root(ctx)
  await fs.rename(path.join(state, "retracted-copies", SLUG, nameOf(1)), path.join(state, "outbox", SLUG, nameOf(1)))
  await fs.rm(path.join(state, "retracted-copies"), { recursive: true })
  await quarantine(ctx.env, STORE, nameOf(1), "invalid", { blob: "e".repeat(40) })
  await fs.writeFile(path.join(state, "retracting", `${SLUG}.json`), "{not json")
  await loseMarker(ctx)
  await fs.writeFile(path.join(state, "status.json"), "{not json")
  await onlineAgain(ctx, github)
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
}))

// ---------------------------------------------------------------------------
// No over-blocking: a positive route back restores and publishes.
// ---------------------------------------------------------------------------

test("a positive route back restores what was kept: the held copy is released and the undelivered copy published, with status.json lost", () => scratch(async (ctx) => {
  const { github, desk } = await delivered(ctx)
  await fs.writeFile(path.join(await root(ctx), "outbox", SLUG, nameOf(1)), JSON.stringify(localFacts(1, 2)))
  await quarantine(ctx.env, STORE, nameOf(1), "invalid", { blob: "e".repeat(40) })
  const late = await deskFor(ctx.base, "desk-2", STORE)
  await marker(ctx.env, ctx.base, 2, late)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(2))).written, true)
  await reroute(desk, OTHER)
  await reroute(late, OTHER)
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await keptSessions(ctx.env, STORE), [sessionId(1), sessionId(2)])
  await loseStatus(ctx)
  await reroute(desk, STORE)
  await reroute(late, STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await keptSessions(ctx.env, STORE), [])
  assert.notEqual(mainBlob(github, 1), undefined)
  assert.notEqual(mainBlob(github, 2), undefined)
  assert.equal((await readDelivered(ctx.env, STORE)).quarantined.has(nameOf(1)), false, "v2 publishes differently from what was refused, so it is released")
}))

test("away and back with a newer derive already in the outbox: the newer copy publishes and the kept one is retired, so the session no longer reads as kept", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await reroute(desk, OTHER)
  const github = fakeGitHub()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  // The desk routes back and the sweep derives the longer session into the outbox before the next flush.
  await reroute(desk, STORE)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1, 2))).written, true)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.deepEqual(await keptSessions(ctx.env, STORE), [])
  // What was delivered is the newer copy the outbox holds.
  const live = await fs.readFile(path.join(await root(ctx), "outbox", SLUG, nameOf(1)))
  assert.equal(JSON.parse(live.toString("utf8")).counts.tool_calls.shell, 122)
  assert.equal((await readDelivered(ctx.env, STORE)).paths[nameOf(1)].local, gitBlobSha(live))
}))

test("a held session with no receipt is released on a positive route here", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await marker(ctx.env, ctx.base, 1, await deskFor(ctx.base, "desk-1", STORE))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await quarantine(ctx.env, STORE, nameOf(1), "invalid", { blob: "e".repeat(40) })
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.notEqual(mainBlob(github, 1), undefined)
}))

test("an older Desk's private_plugins_missing refusal is lifted only for a session that is here", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const away = await deskFor(ctx.base, "desk-1", OTHER)
  await marker(ctx.env, ctx.base, 1, away)
  await marker(ctx.env, ctx.base, 2, await deskFor(ctx.base, "desk-2", STORE))
  for (const n of [1, 2]) {
    assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
    await quarantine(ctx.env, STORE, nameOf(n), "private_plugins_missing")
  }
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(2)}`])
  assert.deepEqual([...(await readDelivered(ctx.env, STORE)).quarantined], [nameOf(1)])
}))

// ---------------------------------------------------------------------------
// The sweep: "away" is made durable even for a store whose own flush never runs.
// ---------------------------------------------------------------------------

test("the sweep keeps the copies a positive route left behind, so a store whose consent was off while the desk moved never publishes them", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await setConsent(ctx.env, { store: OTHER, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(1) })).written, true)
  // Session 2 routes here and stays; session 3's copy sits in the other store's outbox, its marker routing here.
  await marker(ctx.env, ctx.base, 2, await deskFor(ctx.base, "desk-2", STORE))
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(2))).written, true)
  await marker(ctx.env, ctx.base, 3, await deskFor(ctx.base, "desk-3", STORE.toUpperCase()))
  assert.equal((await writeLocalFacts(ctx.env, OTHER, localFacts(3))).written, true)
  // Contribution to the store is switched off, and the desk moves: the store's flush never runs to see it.
  await setConsent(ctx.env, { store: STORE, contribute: false })
  await reroute(desk, OTHER)
  // A folder that names no store is left alone.
  await fs.mkdir(path.join(await root(ctx), "outbox", "not-a-store"), { recursive: true })
  await fs.mkdir(path.join(await root(ctx), "labels", SLUG, "not-a-job"), { recursive: true })
  const summary = await sweep(ctx.env, { quietMs: 600000 })
  assert.equal(summary.kept_elsewhere, 3, "session 1's facts and labels here, session 3's facts in the other store")
  assert.equal(await keptHas(ctx, 1), true)
  assert.equal(await outboxHas(ctx, 2), true)
  assert.equal(await keptHas(ctx, 3, "shared-internal-tools__ms-desk-factory"), true)
  await loseMarker(ctx)
  await loseStatus(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(2)}`])
}))

test("a sweep whose keeping step fails records no count and still finishes", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", OTHER)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  // The kept folder is a symlink: the move refuses it.
  const state = await root(ctx)
  await fs.mkdir(path.join(ctx.base, "elsewhere"))
  await fs.symlink(path.join(ctx.base, "elsewhere"), path.join(state, "retracted-copies"))
  const summary = await sweep(ctx.env, { quietMs: 600000 })
  assert.equal(summary.kept_elsewhere, null)
  assert.notEqual((await readStatus(ctx.env)).retention, undefined, "the rest of the sweep ran")
  assert.equal(await outboxHas(ctx, 1), true)
}))

// ---------------------------------------------------------------------------
// Variants: each one attacks the fix with a different way to lose or confuse "away".
// ---------------------------------------------------------------------------

// Session 1 derived for the store and never delivered, then its desk moves to `to`; one flush, then `lose` takes something away.
async function undeliveredAway(ctx, { to = OTHER, lose }) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, desk_root: desk } } })
  const stale = await fs.readFile(path.join(await root(ctx), "status.json"))
  await reroute(desk, to)
  const github = fakeGitHub()
  await run(ctx.env, github)
  await lose({ desk, stale })
  await onlineAgain(ctx, github)
  return github
}

const variants = {
  "status.json corrupt": async () => {},
  "a stale status.json restored from before the move, and the desk folder moved": async ({ desk, stale }) => {
    await fs.rename(desk, `${desk}-moved`)
    return stale
  },
  "a stale status.json restored, the desk folder still declaring the other store": async ({ stale }) => stale,
  "the store renamed: the desk now declares a store that did not exist before": async () => {},
  "clock skew: the marker's time is ten years ahead, so it is never pruned": async () => {},
  "partial copies: the kept facts truncated and only the labels left whole": async () => {},
}

for (const [name, lose] of Object.entries(variants)) {
  test(`variant, ${name}: the session is never published to the store it left`, () => scratch(async (ctx) => {
    const to = name.startsWith("the store renamed") ? "ourostack/factory-next" : OTHER
    const github = await undeliveredAway(ctx, {
      to,
      lose: async (state) => {
        if (name.startsWith("clock skew")) await marker(ctx.env, ctx.base, 1, state.desk, { updated_at: new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000).toISOString() })
        else await loseMarker(ctx)
        if (name.startsWith("partial")) {
          await fs.writeFile(path.join(await root(ctx), "retracted-copies", SLUG, nameOf(1)), "{\"sch")
          assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(1) })).written, true)
        }
        const restored = await lose(state)
        await fs.writeFile(path.join(await root(ctx), "status.json"), restored ?? "{ not json")
      },
    })
    assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
    assert.deepEqual(await keptSessions(ctx.env, STORE), [sessionId(1)])
  }))
}

test("variant, a store name that differs only in case is the same store: the session stays here and publishes", () => scratch(async (ctx) => {
  const github = await undeliveredAway(ctx, { to: STORE.toUpperCase(), lose: async () => {} })
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(1)}`, `facts/${nameOf(9)}`])
  assert.deepEqual(await keptSessions(ctx.env, STORE), [])
}))

test("variant, an invalid declaration (unknown) keeps the copies too, and they stay frozen once the marker and status.json are gone", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await fs.writeFile(path.join(desk, "_meta", "factory.json"), "{ not json")
  const github = fakeGitHub()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" })
  assert.equal(await keptHas(ctx, 1), true)
  await loseMarker(ctx)
  await loseStatus(ctx)
  await onlineAgain(ctx, github)
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
}))

// ---------------------------------------------------------------------------
// Review round 1: a sweep routes copies with no marker too; a gone desk folder is not here; a labels-only quarantine holds nothing.
// ---------------------------------------------------------------------------

// Session 1 derived into the store's outbox with a receipt naming its desk; then consent goes off, `before` runs, and the desk moves.
async function movedWithoutMarker(ctx, before) {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, desk_root: desk } } })
  await setConsent(ctx.env, { store: STORE, contribute: false })
  await before(desk)
  await reroute(desk, OTHER)
  return desk
}

for (const [name, old] of Object.entries({ "its marker already deleted (P1)": false, "its marker reading 40 days old after a clock skew (P7)": true })) {
  test(`a desk that moves with ${name}, while the old store's consent is off: the sweep keeps the copy by the desk its receipt recorded, so the old store never publishes it`, () => scratch(async (ctx) => {
    await movedWithoutMarker(ctx, async (desk) => {
      if (old) await marker(ctx.env, ctx.base, 1, desk, { updated_at: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString() })
      else await loseMarker(ctx)
    })
    const summary = await sweep(ctx.env, { quietMs: 600000 })
    assert.equal(summary.kept_elsewhere, 1)
    assert.equal(await keptHas(ctx, 1), true)
    await loseStatus(ctx)
    await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
    const github = fakeGitHub()
    await onlineAgain(ctx, github)
    assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
  }))
}

// A Claude Code transcript for session `n` whose first line names `cwd`, under the scratch home's projects folder.
async function transcript(ctx, n, cwd) {
  const dir = path.join(ctx.base, ".claude", "projects", "p")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${sessionId(n)}.jsonl`), `${JSON.stringify({ type: "user", sessionId: sessionId(n), cwd })}\n`)
}
const realDesk = async (ctx, name, store) => {
  const desk = await deskFor(ctx.base, name, store)
  await fs.mkdir(path.join(desk, "_archive"), { recursive: true })
  return desk
}

test("with no marker and no receipt (status.json lost), the sweep routes a copy by its transcript's desk, and keeps a copy with no route at all", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  for (const n of [1, 2, 3, 4]) assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(n))).written, true)
  // 1: its transcript names a desk declaring this store, so it stays for the orphan pass. 2: a desk declaring the other store. 3: no transcript.
  // 4: a desk that routes by default: nothing new is known, so it stays.
  await transcript(ctx, 1, await realDesk(ctx, "desk-1", STORE))
  await transcript(ctx, 2, await realDesk(ctx, "desk-2", OTHER))
  await transcript(ctx, 4, await realDesk(ctx, "desk-4", null))
  // Session 2 has a copy in the other store too, routed once for both; it stays there.
  await setConsent(ctx.env, { store: OTHER, contribute: true, account: "contributor" })
  assert.equal((await writeLocalFacts(ctx.env, OTHER, localFacts(2))).written, true)
  // 6: a Codex marker on a default route nothing proves: nothing new is known, its desk folder is there, so it stays.
  const codexDesk = await realDesk(ctx, "desk-6", null)
  await writeMarker(ctx.env, { schema_version: 1, host: "codex-cli", session_id: sessionId(6), log_path: path.join(ctx.base, "log-6.jsonl"), cwd: codexDesk, desk_root: codexDesk, end_reason: null, ended_at: null, plugins: [], updated_at: new Date().toISOString(), routing: { store: STORE, source: "default", warnings: [] } })
  const codex = localFacts(6)
  codex.session.host = "codex-cli"
  assert.equal((await writeLocalFacts(ctx.env, STORE, codex)).written, true)
  // 7: no marker, and its receipt names a desk folder that is gone: no route, so it is kept.
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(7))).written, true)
  await writeStatus(ctx.env, { derivations: { [nameOf(7)]: { store: STORE, desk_root: path.join(ctx.base, "desk-gone") } } })
  // 8: its transcript names a desk whose declaration cannot be read (an unknown route): kept.
  const broken = await realDesk(ctx, "desk-8", STORE)
  await fs.writeFile(path.join(broken, "_meta", "factory.json"), "{ not json")
  await transcript(ctx, 8, broken)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(8))).written, true)
  // A transcript that cannot be read is no route either.
  await transcript(ctx, 5, ctx.base)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(5))).written, true)
  await fs.chmod(path.join(ctx.base, ".claude", "projects", "p", `${sessionId(5)}.jsonl`), 0)
  try {
    await sweep(ctx.env, { quietMs: 600000 })
  } finally {
    await fs.chmod(path.join(ctx.base, ".claude", "projects", "p", `${sessionId(5)}.jsonl`), 0o600)
  }
  assert.deepEqual(await keptSessions(ctx.env, STORE), [sessionId(2), sessionId(3), sessionId(5), sessionId(7), sessionId(8)])
  assert.equal(await outboxHas(ctx, 1), true)
  assert.equal(await outboxHas(ctx, 4), true)
  assert.equal(await outboxHas(ctx, 2, "shared-internal-tools__ms-desk-factory"), true)
  assert.equal(await fs.stat(path.join(await root(ctx), "outbox", SLUG, nameOf(6, "codex-cli"))).then(() => true, () => false), true)
}))

test("a kept copy is not derived again: a sweep with an unchanged transcript leaves it kept and writes no outbox copy", () => scratch(async (ctx) => {
  const { deriveMarker } = await import("../../../../../plugins/desk/mcp/src/factory/derive-run.js")
  const helpers = await import("./_session_helpers.js")
  const marker = await helpers.session(ctx)
  await json(path.join(ctx.desk, "_meta", "factory.json"), { schema_version: 1, store: STORE })
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const state = await root(ctx)
  const name = `claude-code-${helpers.ID}.json`
  await fs.mkdir(path.join(state, "retracted-copies", SLUG), { recursive: true })
  await fs.rename(path.join(state, "outbox", SLUG, name), path.join(state, "retracted-copies", SLUG, name))
  assert.equal((await deriveMarker(ctx.env, marker)).result, "skipped")
  assert.equal(await fs.stat(path.join(state, "outbox", SLUG, name)).then(() => true, () => false), false)
}))

test("a desk folder renamed as it reroutes (P2): with its marker fresh and every record intact, the session is frozen, never published to the old store", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, desk_root: desk } } })
  await reroute(desk, OTHER)
  await fs.rename(desk, `${desk}-renamed`)
  const github = fakeGitHub()
  await onlineAgain(ctx, github)
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
  assert.equal(await keptHas(ctx, 1), true)
  // The folder comes back: a positive route here restores and publishes it.
  await fs.rename(`${desk}-renamed`, desk)
  await reroute(desk, STORE)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.notEqual(mainBlob(github, 1), undefined)
}))

test("a labels-only quarantine holds nothing (P8): a session that still routes here publishes its facts after its marker is lost", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  assert.equal((await writeLocalLabels(ctx.env, STORE, { ...structuredClone(LABELS), session: sessionId(1) })).written, true)
  await quarantine(ctx.env, STORE, `labels/${LABELS.job}/${sessionId(1)}.json`, "too_large")
  // The receipt this Desk's derive wrote on the session's positive route. (With status.json lost too, the copy is frozen: no checked route.)
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, checked_route: STORE, desk_root: desk } } })
  await loseMarker(ctx)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.notEqual(mainBlob(github, 1), undefined)
  assert.deepEqual(await keptSessions(ctx.env, STORE), [])
}))

// ---------------------------------------------------------------------------
// A session with no marker is here only on a route this Desk checked (#193 fix round 1, finding 1).
// ---------------------------------------------------------------------------

const DEFAULT_ROUTING = { store: STORE, source: "default", warnings: [] }
const DESK_PLUGIN = [{ name: "desk", version: "3.2.0" }]
const receipt = (ctx, desk, extra = {}) => writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, desk_root: desk, ...extra } } })

test("upgrade after 30 days: a copy an older Desk derived, whose marker was pruned before this Desk ever read it, is never published from the receipt alone", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  // A desk that declares nothing; the session ran beside an overlay the older hook could not read, and its marker (which named it) is gone.
  const desk = await deskFor(ctx.base, "desk-1", null)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  // The older Desk's receipt: its sweep's `store`, and the `route` its flush recorded from the default route it wrongly trusted.
  await receipt(ctx, desk, { route: STORE })
  const github = fakeGitHub()
  await onlineAgain(ctx, github)
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`], "only the session with a positive route is published")
  assert.equal(await keptHas(ctx, 1), true, "frozen: kept out of the outbox, never published, never deleted")
  // The sweep agrees: it never records the receipt's store as checked.
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal((await readStatus(ctx.env)).derivations[nameOf(1)].checked_route, undefined)
}))

test("the same with status.json lost: no receipt is no checked route, so the copy is frozen", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  await deskFor(ctx.base, "desk-1", null)
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  const github = fakeGitHub()
  await onlineAgain(ctx, github)
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
}))

test("no over-blocking: a session whose route this Desk checked is published once its marker is pruned", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", null)
  await marker(ctx.env, ctx.base, 1, desk, { routing: DEFAULT_ROUTING, plugins: DESK_PLUGIN })
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  // A flush that is offline still places the session and records its checked route before it goes online.
  const down = fakeGitHub({ intercept: (call) => (call.args[0] === "api" ? { code: 1, stdout: "", stderr: "error connecting to api.github.com\n" } : undefined) })
  assert.deepEqual(await run(ctx.env, down), { result: "offline" })
  assert.equal((await readStatus(ctx.env)).derivations[nameOf(1)].checked_route, STORE)
  await loseMarker(ctx)
  const github = fakeGitHub()
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  github.mergeOpenPr()
  assert.notEqual(mainBlob(github, 1), undefined)
}))

test("a desk folder missing during one sweep, then back: the kept copy of a default-route session returns and is published (#176 re-review N1)", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", null)
  await marker(ctx.env, ctx.base, 1, desk, { routing: DEFAULT_ROUTING, plugins: DESK_PLUGIN })
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  // The sweep sees the positive route and records it as checked in the session's receipt.
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, desk_root: desk } } })
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal((await readStatus(ctx.env)).derivations[nameOf(1)].checked_route, STORE)
  await loseMarker(ctx)
  // The volume is unmounted for one sweep: the copy is kept, frozen.
  await fs.rename(desk, `${desk}-away`)
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal(await keptHas(ctx, 1), true)
  const github = fakeGitHub()
  assert.deepEqual(await run(ctx.env, github), { result: "nothing_pending" }, "frozen while the folder is gone")
  // Back: the checked route places it here again, the copy comes home and is published.
  await fs.rename(`${desk}-away`, desk)
  assert.equal((await run(ctx.env, github)).result, "delivered_pr_open")
  assert.equal(await keptHas(ctx, 1), false)
  github.mergeOpenPr()
  assert.notEqual(mainBlob(github, 1), undefined)
}))

test("a session that left this store has another checked route: its kept copy never comes back on the store it left", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true, account: "contributor" })
  const desk = await deskFor(ctx.base, "desk-1", STORE)
  await marker(ctx.env, ctx.base, 1, desk, { routing: DEFAULT_ROUTING, plugins: DESK_PLUGIN })
  assert.equal((await writeLocalFacts(ctx.env, STORE, localFacts(1))).written, true)
  await writeStatus(ctx.env, { derivations: { [nameOf(1)]: { store: STORE, desk_root: desk, checked_route: STORE } } })
  // The desk moves to another store whose consent is off: only the sweep sees it, and it records the new checked route.
  await reroute(desk, OTHER)
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal(await keptHas(ctx, 1), true)
  assert.equal((await readStatus(ctx.env)).derivations[nameOf(1)].checked_route, OTHER)
  // The marker is pruned and the desk drops its declaration: no positive route, and the last checked one is elsewhere.
  await loseMarker(ctx)
  await fs.rm(path.join(desk, "_meta", "factory.json"))
  const github = fakeGitHub()
  await onlineAgain(ctx, github)
  assert.deepEqual([...github.mainFiles().keys()], [`facts/${nameOf(9)}`])
  assert.equal(await keptHas(ctx, 1), true)
}))
