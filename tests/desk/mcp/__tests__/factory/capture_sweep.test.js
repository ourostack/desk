// The sweep's capture coverage: what it writes to status.json, and what it must never write there.
// Every transcript carries SENTINEL; the coverage object must never hold it, nor a path or a session id.
import assert from "node:assert/strict"
import { mkdirSync, rmSync } from "node:fs"
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import * as path from "node:path"
import test from "node:test"
import { COVERAGE_FAILED, coverageNow, placesFor, recordCoverage } from "../../../../../plugins/desk/mcp/src/factory/capture-sweep.js"
import { BINDING_VERSION, sweep } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { factoryStateRoot, readStatus, setConsent, writeMarker, writeStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { ID, SENTINEL, STORE, json, recent, scratch, session } from "./_session_helpers.js"

const ids = Array.from({ length: 40 }, (_, index) => `${String(index).padStart(8, "0")}-8a1d-4c2e-9f3a-1b2c3d4e5f60`)
const options = { bindingVersion: BINDING_VERSION }
const transcript = `${JSON.stringify({ type: "user", message: { content: SENTINEL } })}\n`

const claudeFile = (ctx, folder, id) => path.join(ctx.base, ".claude", "projects", folder, `${id}.jsonl`)
async function put(file, text = transcript) {
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}
const statusFile = async (ctx) => path.join(await factoryStateRoot(ctx.env), "status.json")
const statusOf = async (ctx) => JSON.parse(await readFile(await statusFile(ctx), "utf8"))
const sum = (host) => host.derived + host.held + host.frozen + host.pending + host.not_seen + (host.not_in_a_desk ?? 0)
const ownerKeys = (hosts) => new Set(Object.values(hosts).flatMap((host) => Object.keys(host.by_owner ?? {})))

test("a sweep writes coverage with one entry per host and the buckets sum to on_disk", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, { ...marker, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  await put(claudeFile(ctx, "stray", ids[0]))
  const summary = await sweep(ctx.env, { quietMs: 0 })
  assert.equal(summary.coverage, "written")
  const { coverage, coverage_failed: failed } = await statusOf(ctx)
  assert.equal(failed, undefined)
  assert.equal(coverage.method, 1)
  assert.equal(Number.isNaN(Date.parse(coverage.ran_at)), false)
  assert.deepEqual(Object.keys(coverage.hosts).sort(), ["claude-code", "codex-cli", "copilot-cli"])
  const claude = coverage.hosts["claude-code"]
  assert.equal(claude.state, "counted")
  assert.equal(claude.on_disk, 2)
  assert.equal(sum(claude), claude.on_disk)
  // The marked session is derived; the stray transcript sits in no known desk's folder.
  assert.deepEqual([claude.derived, claude.not_in_a_desk], [1, 1])
  assert.deepEqual(coverage.hosts["copilot-cli"], { state: "absent", unverified: true })
  assert.deepEqual(coverage.hosts["codex-cli"], { state: "absent", unverified: true })
}))

test("the real-shaped scratch home reproduces the counts of its folders", () => scratch(async (ctx) => {
  // Scaled down from a real machine: many root Claude files, more nested ones, Copilot folders with and without events, no Codex folder.
  for (let index = 0; index < 28; index += 1) await put(claudeFile(ctx, index % 2 === 0 ? "-Users-someone-work" : "-Users-someone-other", ids[index]))
  for (let index = 0; index < 120; index += 1) await put(path.join(ctx.base, ".claude", "projects", "-Users-someone-work", ids[index % 28], "subagents", `agent-${index}.jsonl`))
  for (let index = 0; index < 19; index += 1) await put(path.join(ctx.env.COPILOT_HOME, "session-state", ids[index], "events.jsonl"))
  for (let index = 19; index < 22; index += 1) await mkdir(path.join(ctx.env.COPILOT_HOME, "session-state", ids[index]), { recursive: true })
  await sweep(ctx.env, { quietMs: 0 })
  const { hosts } = (await statusOf(ctx)).coverage
  assert.equal(hosts["claude-code"].on_disk, 28)
  assert.equal(hosts["claude-code"].not_in_a_desk, 28)
  assert.equal(hosts["copilot-cli"].on_disk, 19)
  assert.equal(hosts["copilot-cli"].not_seen, 19)
  assert.equal(hosts["copilot-cli"].not_in_a_desk, null)
  assert.deepEqual(hosts["codex-cli"], { state: "absent", unverified: true })
  for (const host of ["claude-code", "copilot-cli"]) assert.equal(sum(hosts[host]), hosts[host].on_disk)
}))

test("coverage is rewritten each sweep and never grows the status file", { timeout: 300000 }, () => scratch(async (ctx) => {
  for (let index = 0; index < 6; index += 1) await put(claudeFile(ctx, "-Users-someone-work", ids[index]))
  await sweep(ctx.env, { quietMs: 0 })
  await sweep(ctx.env, { quietMs: 0 })
  const settled = (await stat(await statusFile(ctx))).size
  let last = null
  for (let sweeps = 0; sweeps < 12; sweeps += 1) {
    await sweep(ctx.env, { quietMs: 0 })
    const status = await statusOf(ctx)
    assert.notEqual(status.coverage.ran_at, last, "each sweep writes a new run time")
    last = status.coverage.ran_at
  }
  assert.equal((await stat(await statusFile(ctx))).size, settled)
}))

test("a coverage failure is recorded as a fixed code and the sweep still derives", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const claude = await session(ctx)
  await writeMarker(ctx.env, { ...claude, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  assert.equal((await sweep(ctx.env, { quietMs: 0 })).coverage, "written")
  const before = (await statusOf(ctx)).coverage
  // A file where the quarantine folders belong: listing them fails, and the previous coverage stays.
  const quarantine = path.join(await factoryStateRoot(ctx.env), "quarantine")
  await rm(quarantine, { recursive: true, force: true })
  await writeFile(quarantine, "not a folder")
  const copilot = await session(ctx, "copilot-cli")
  await writeMarker(ctx.env, { ...copilot, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  const summary = await sweep(ctx.env, { quietMs: 0 })
  assert.equal(summary.coverage, "failed")
  assert.equal(summary.written, 1, "the sweep still derived the new session")
  const status = await statusOf(ctx)
  assert.equal(status.coverage_failed, "state_unreadable")
  assert.deepEqual(status.coverage, before)
  assert.equal(COVERAGE_FAILED.includes(status.coverage_failed), true)
  await rm(quarantine)
  assert.equal((await sweep(ctx.env, { quietMs: 0 })).coverage, "written")
  const healed = await statusOf(ctx)
  assert.equal(Object.hasOwn(healed, "coverage_failed"), false)
  assert.equal(healed.coverage.hosts["copilot-cli"].derived, 1)
}))

test("each stage of a failed pass has its own fixed code and no message", () => scratch(async (ctx) => {
  const throwing = () => { throw new Error(`${SENTINEL} ${ctx.base}`) }
  assert.deepEqual(await coverageNow(ctx.env, { ...options, now: throwing }), { ok: false, code: "count_failed" })
  assert.deepEqual(await coverageNow(ctx.env, { ...options, markers: 5 }), { ok: false, code: "classify_failed" })
  await writeFile(await statusFile(ctx), "{}").catch(() => {})
  await rm(path.join(await factoryStateRoot(ctx.env), "outbox"), { recursive: true, force: true })
  await writeFile(path.join(await factoryStateRoot(ctx.env), "outbox"), "x")
  assert.deepEqual(await coverageNow(ctx.env, options), { ok: false, code: "state_unreadable" })
}))

test("a status file that cannot be written reports failed and the sweep goes on", () => scratch(async (ctx) => {
  const file = await statusFile(ctx)
  await writeStatus(ctx.env, { coverage: { kept: true } })
  // The first reading of the clock, after the state was read, turns the status file into a folder, so the write fails.
  let sabotaged = false
  const now = () => {
    if (!sabotaged) {
      sabotaged = true
      rmSync(file)
      mkdirSync(file)
    }
    return Date.now()
  }
  assert.equal(await recordCoverage(ctx.env, { ...options, markers: [], now }), "failed")
  rmSync(file, { recursive: true })
}))

test("coverage never contains a path, a session id or SENTINEL outside by_owner store names", () => scratch(async (ctx) => {
  const desk = path.join(ctx.base, `desk ${SENTINEL}`)
  await mkdir(path.join(desk, "_meta"), { recursive: true })
  await mkdir(path.join(desk, "_archive"))
  await json(path.join(desk, "_meta/factory.json"), { schema_version: 1, store: STORE })
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const marker = { ...await session(ctx), desk_root: desk, cwd: desk }
  await writeMarker(ctx.env, { ...marker, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  const folder = desk.replace(/[^A-Za-z0-9]/gu, "-")
  await put(claudeFile(ctx, folder, ids[1]))
  await put(claudeFile(ctx, `-Users-${SENTINEL.replace(/\W/gu, "-")}`, ids[2]))
  await put(path.join(ctx.env.COPILOT_HOME, "session-state", ids[3], "events.jsonl"))
  await writeStatus(ctx.env, { derivations: { [`claude-code-${SENTINEL}.json`]: { store: STORE, desk_root: path.join(desk, "elsewhere"), route: STORE } } })
  await sweep(ctx.env, { quietMs: 0 })
  const { coverage } = await statusOf(ctx)
  const stripped = JSON.parse(JSON.stringify(coverage))
  for (const host of Object.values(stripped.hosts)) delete host.by_owner
  const text = JSON.stringify(stripped)
  for (const secret of [SENTINEL, "PRIVATE", ctx.base, ctx.desk, desk, folder, ID, ...ids.slice(0, 5)]) assert.equal(text.includes(secret), false, secret)
  assert.equal(text.includes("/"), false)
  assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}/u.test(text), false)
  // Inside by_owner only store names and the two fixed owner marks appear.
  for (const owner of ownerKeys(coverage.hosts)) assert.match(owner, /^(?:-|\?|[a-z0-9._-]+\/[a-z0-9._-]+)$/u)
  assert.equal(JSON.stringify(coverage).includes(SENTINEL), false)
  assert.equal(JSON.stringify(coverage).includes(ctx.base), false)
}))

test("a host folder that disappears between sweeps becomes absent, not zero", () => scratch(async (ctx) => {
  await put(claudeFile(ctx, "-Users-someone-work", ids[0]))
  await put(path.join(ctx.env.COPILOT_HOME, "session-state", ids[1], "events.jsonl"))
  await sweep(ctx.env, { quietMs: 0 })
  assert.equal((await statusOf(ctx)).coverage.hosts["claude-code"].on_disk, 1)
  await rm(path.join(ctx.base, ".claude"), { recursive: true })
  await rm(ctx.env.COPILOT_HOME, { recursive: true })
  await sweep(ctx.env, { quietMs: 0 })
  const { hosts } = (await statusOf(ctx)).coverage
  assert.deepEqual(hosts["claude-code"], { state: "absent", unverified: true })
  assert.deepEqual(hosts["copilot-cli"], { state: "absent", unverified: true })
}))

test("the sweep stays inside its time budget on a folder with 25,000 files", { timeout: 120000 }, () => scratch(async (ctx) => {
  const folder = path.join(ctx.base, ".claude", "projects", "-Users-someone-big")
  await mkdir(folder, { recursive: true })
  for (let start = 0; start < 25000; start += 500) {
    await Promise.all(Array.from({ length: 500 }, (_, offset) => writeFile(path.join(folder, `${String(start + offset).padStart(8, "0")}-8a1d-4c2e-9f3a-1b2c3d4e5f60.jsonl`), "")))
  }
  const started = Date.now()
  const summary = await sweep(ctx.env, { quietMs: 0 })
  const elapsed = Date.now() - started
  assert.equal(summary.coverage, "written")
  assert.deepEqual((await statusOf(ctx)).coverage.hosts["claude-code"], { state: "capped", unverified: true })
  assert.ok(elapsed < 15000, `the sweep took ${elapsed} ms`)
}))

// The Codex cache: rollout names stay in status.coverage_cache and appear nowhere else.
const CODEX_ID = "7b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f70"
const codexFile = (ctx, id) => path.join(ctx.base, ".codex", "sessions", "2026", "09", "25", `rollout-2026-09-25T08-00-00-${id}.jsonl`)
const codexMeta = (id, extra = {}) => `${JSON.stringify({ type: "session_meta", payload: { id, cwd: SENTINEL, ...extra } })}\n`
async function files(dir) {
  const found = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) found.push(...await files(path.join(dir, entry.name)))
    else found.push(path.join(dir, entry.name))
  }
  return found
}

test("the Codex cache lives in status.json only, and an unreadable first line leaves the host unverified", () => scratch(async (ctx) => {
  ctx.env.CODEX_HOME = path.join(ctx.base, ".codex")
  await put(codexFile(ctx, CODEX_ID), codexMeta(CODEX_ID))
  const summary = await sweep(ctx.env, { quietMs: 0 })
  const status = await statusOf(ctx)
  assert.deepEqual(Object.keys(status.coverage_cache).length, 1)
  assert.match(Object.keys(status.coverage_cache)[0], /rollout-2026-09-25T08-00-00-/u)
  const codex = status.coverage.hosts["codex-cli"]
  assert.deepEqual([codex.state, codex.on_disk, codex.not_seen, codex.unverified], ["counted", 1, 1, true])
  assert.equal(JSON.stringify(status.coverage).includes("rollout"), false)
  assert.equal(JSON.stringify(summary).includes("rollout"), false)
  const root = await factoryStateRoot(ctx.env)
  for (const file of await files(root)) {
    if (file === path.join(root, "status.json")) continue
    assert.equal((await readFile(file, "utf8")).includes("rollout-"), false, file)
  }
  // A rollout whose first line cannot be read is counted as undetermined, and the host stays unverified.
  await put(codexFile(ctx, "8b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f71"), "not json\n")
  await sweep(ctx.env, { quietMs: 0 })
  const next = (await statusOf(ctx)).coverage.hosts["codex-cli"]
  assert.deepEqual([next.on_disk, next.undetermined, next.unverified], [1, 1, true])
}))

// Store names: case does not matter to GitHub, so consent, copies, receipts and markers are compared in lower case.
test("store names that differ only in case are one owner, and consent in any case counts", () => scratch(async (ctx) => {
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: "OuroStack/Factory" })
  await setConsent(ctx.env, { store: "ourostack/factory", contribute: true })
  const marker = await session(ctx)
  await writeMarker(ctx.env, { ...marker, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  const result = await coverageNow(ctx.env, options)
  const claude = result.coverage.hosts["claude-code"]
  assert.deepEqual([claude.pending, claude.held], [1, 0])
  assert.deepEqual(Object.keys(claude.by_owner), ["ourostack/factory"])
  // Two spellings of one store merge to a yes only when both say yes.
  await setConsent(ctx.env, { store: "OuroStack/Factory", contribute: false })
  const held = (await coverageNow(ctx.env, options)).coverage.hosts["claude-code"]
  assert.deepEqual([held.pending, held.held], [0, 1])
}))

test("a copy in a differently spelled store folder, and one in the retracted copies, count under the lower-case owner", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await put(claudeFile(ctx, "-Users-someone-work", ID))
  await put(claudeFile(ctx, "-Users-someone-work", ids[1]))
  await put(path.join(root, "outbox", "OuroStack__Factory", `claude-code-${ID}.json`), "{}")
  await put(path.join(root, "retracted-copies", "ourostack__factory", `claude-code-${ids[1]}.json`), "{}")
  await writeStatus(ctx.env, { derivations: { [`claude-code-${ID}.json`]: { store: "OuroStack/Factory", binding_version: BINDING_VERSION }, [`claude-code-${ids[1]}.json`]: { store: "OuroStack/Factory", binding_version: BINDING_VERSION } } })
  const claude = (await coverageNow(ctx.env, options)).coverage.hosts["claude-code"]
  assert.deepEqual(Object.keys(claude.by_owner), ["ourostack/factory"])
  // The first is placed here and derived; the second has a done retraction tombstone, so it is away and frozen... as the flush reads it.
  assert.equal(claude.on_disk, 2)
  assert.equal(claude.derived + claude.frozen, 2)
}))

test("quarantined, delivered and retracting state decide the bucket", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  for (const id of ids.slice(0, 4)) await put(claudeFile(ctx, "-Users-someone-work", id))
  const name = (id) => `claude-code-${id}.json`
  const current = { binding_version: BINDING_VERSION, store: STORE }
  await writeStatus(ctx.env, { derivations: Object.fromEntries(ids.slice(0, 4).map((id) => [name(id), current])) })
  await put(path.join(root, "outbox", "ourostack__factory", name(ids[0])), "{}")
  await put(path.join(root, "quarantine", "ourostack__factory", name(ids[0])), "{}")
  // Delivered, with no copy left in the outbox: still a facts copy.
  await json(path.join(root, "delivered", "ourostack__factory.json"), { [name(ids[1])]: "a".repeat(40), [`labels/job/${ids[1]}.json`]: "b".repeat(40), "junk": "c" })
  // An open retraction record: the place is stalled, so frozen.
  await put(path.join(root, "outbox", "ourostack__factory", name(ids[2])), "{}")
  await json(path.join(root, "retracting", "ourostack__factory.json"), { [name(ids[2])]: { path: "facts/x.json", blob: "d".repeat(40) } })
  const claude = (await coverageNow(ctx.env, options)).coverage.hosts["claude-code"]
  assert.deepEqual([claude.held, claude.derived, claude.frozen, claude.not_in_a_desk], [1, 1, 1, 1])
}))

test("the orphan record is passed as given, and a failed or absent record freezes the not-current orphans", () => scratch(async (ctx) => {
  const root = await factoryStateRoot(ctx.env)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  for (const id of ids.slice(0, 3)) {
    await put(claudeFile(ctx, "-Users-someone-work", id))
    await put(path.join(root, "outbox", "ourostack__factory", `claude-code-${id}.json`), "{}")
  }
  await writeStatus(ctx.env, { derivations: Object.fromEntries(ids.slice(0, 3).map((id) => [`claude-code-${id}.json`, { store: STORE, binding_version: 1 }])) })
  const given = { ran_at: "x", rebuilt: 0, current: 0, pending: 1, frozen: { route_unknown: 2, brand_new_reason: 1, no_facts: 4, no_transcript: 1 }, cursor: "somewhere", oldest_pending_ms: 5 }
  const claude = (await coverageNow(ctx.env, { ...options, orphans: given })).coverage.hosts["claude-code"]
  assert.deepEqual([claude.pending, claude.frozen], [0, 3])
  assert.deepEqual(claude.frozen_by_reason, { orphan_unsplit: 3 })
  const failed = (await coverageNow(ctx.env, { ...options, orphans: { ran_at: "x", failed: "pass_failed" } })).coverage.hosts["claude-code"]
  assert.deepEqual([failed.pending, failed.frozen, failed.frozen_by_reason], [0, 3, { orphan_pass_unavailable: 3 }])
  // With no `orphans` option the record is read from status.json, as the sweep wrote it.
  await writeStatus(ctx.env, { orphans: given })
  assert.deepEqual((await coverageNow(ctx.env, options)).coverage.hosts["claude-code"].frozen_by_reason, { orphan_unsplit: 3 })
  await writeStatus(ctx.env, { orphans: undefined })
  assert.deepEqual((await coverageNow(ctx.env, options)).coverage.hosts["claude-code"].frozen_by_reason, { orphan_pass_unavailable: 3 })
}))

test("a marker with no desk is explicit, and a Codex default route nothing proves is held", () => scratch(async (ctx) => {
  ctx.env.CODEX_HOME = path.join(ctx.base, ".codex")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const none = { ...await session(ctx), desk_root: null }
  await writeMarker(ctx.env, { ...none, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000) })
  await put(codexFile(ctx, CODEX_ID), codexMeta(CODEX_ID))
  const codex = { schema_version: 1, host: "codex-cli", session_id: CODEX_ID, log_path: codexFile(ctx, CODEX_ID), cwd: ctx.desk, desk_root: ctx.desk, end_reason: "complete", ended_at: recent(-3600000), plugins: [], updated_at: recent(-3600000) }
  await writeMarker(ctx.env, codex)
  const result = await coverageNow(ctx.env, options)
  assert.equal(result.ok, true, result.code)
  const { hosts } = result.coverage
  assert.equal(hosts["claude-code"].not_in_a_desk, 1)
  assert.equal(hosts["codex-cli"].held, 1)
}))

test("placesFor says unknown when no store is known and reads the session's own retracting records", () => {
  const places = placesFor({ markers: [], receipts: {}, retracting: new Map() })
  assert.equal(places(`claude-code-${ID}.json`, null), "unknown")
  assert.equal(places(`claude-code-${ID}.json`, STORE), "here")
  const done = new Map([[STORE, { [`claude-code-${ID}.json`]: { path: "p", blob: "b", done: true }, [`claude-code-${ids[0]}.json`]: { done: false } }]])
  assert.equal(placesFor({ markers: [], receipts: {}, retracting: done })(`claude-code-${ID}.json`, STORE), "away")
})

test("placesFor asks the sibling markers to prove a Codex default route", () => scratch(async (ctx) => {
  const codex = { schema_version: 1, host: "codex-cli", session_id: CODEX_ID, log_path: "/x", cwd: ctx.desk, desk_root: ctx.desk, end_reason: "complete", ended_at: recent(), plugins: [], updated_at: recent() }
  const places = placesFor({ markers: [codex], receipts: { junk: "not a receipt" }, retracting: new Map() })
  assert.equal(places(`codex-cli-${CODEX_ID}.json`, STORE), "here")
  // A receipt that is not an object passes through the lower-casing untouched.
  await writeStatus(ctx.env, { derivations: { junk: "not a receipt" } })
  assert.equal((await coverageNow(ctx.env, options)).ok, true)
}))

test("recordCoverage returns written and reads the stored status back whole", () => scratch(async (ctx) => {
  assert.equal(await recordCoverage(ctx.env, { ...options, markers: [] }), "written")
  const status = await readStatus(ctx.env)
  assert.equal(status.coverage.method, 1)
  assert.deepEqual(status.coverage_cache, {})
}))

const folderOf = (desk) => desk.replace(/[^A-Za-z0-9]/gu, "-")
async function desk(ctx, name, store) {
  const root = path.join(ctx.base, name)
  await mkdir(path.join(root, "_meta"), { recursive: true })
  await mkdir(path.join(root, "_archive"))
  if (store !== null) await json(path.join(root, "_meta/factory.json"), { schema_version: 1, store })
  return root
}
// A marker for a session of `root`; the helper's own transcript is removed so only the test's transcripts are on disk.
async function mark(ctx, root, id, extra = {}) {
  const base = await session(ctx)
  await rm(base.log_path)
  await writeMarker(ctx.env, { ...base, session_id: id, desk_root: root, cwd: root, end_reason: "complete", ended_at: recent(-3600000), updated_at: recent(-3600000), ...extra })
}

test("a marker whose route is unknown is held and never owned by the default store", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const gone = await desk(ctx, "gone", null)
  const broken = await desk(ctx, "broken", "invalid")
  const routing = { source: "default", store: STORE, warnings: [] }
  await mark(ctx, gone, ids[0], { routing })
  await rm(gone, { recursive: true })
  await writeStatus(ctx.env, { derivations: { [`claude-code-${ids[0]}.json`]: { desk_root: broken, binding_version: BINDING_VERSION } } })
  await put(claudeFile(ctx, folderOf(gone), ids[0]))
  const claude = (await coverageNow(ctx.env, options)).coverage.hosts["claude-code"]
  assert.deepEqual([claude.held, claude.pending], [1, 0])
  assert.deepEqual(Object.keys(claude.by_owner), ["?"])
}))

test("a marker with a derived route and no desk folder left is held, not owned by the default store", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const gone = await desk(ctx, "gone", null)
  await mark(ctx, gone, ids[0])
  await rm(gone, { recursive: true })
  await put(claudeFile(ctx, folderOf(gone), ids[0]))
  const claude = (await coverageNow(ctx.env, options)).coverage.hosts["claude-code"]
  assert.deepEqual([claude.held, claude.pending], [1, 0])
  assert.deepEqual(Object.keys(claude.by_owner), ["?"])
}))

test("a private desk and a public desk each own their own sessions", () => scratch(async (ctx) => {
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await setConsent(ctx.env, { store: "someone/private", contribute: true })
  const open = await desk(ctx, "open", STORE)
  const closed = await desk(ctx, "closed", "someone/private")
  await mark(ctx, open, ids[0])
  await mark(ctx, closed, ids[1])
  await put(claudeFile(ctx, folderOf(open), ids[0]))
  await put(claudeFile(ctx, folderOf(closed), ids[1]))
  // An unmarked session in the private desk's folder belongs to the private store; one in no desk has two possible owners, so it is withheld.
  await put(claudeFile(ctx, folderOf(closed), ids[2]))
  await put(claudeFile(ctx, "-Users-someone-else", ids[3]))
  const claude = (await coverageNow(ctx.env, options)).coverage.hosts["claude-code"]
  assert.deepEqual(claude.by_owner, {
    [STORE]: { derived: 0, held: 0, frozen: 0, pending: 1, not_seen: 0, not_in_a_desk: 0 },
    "someone/private": { derived: 0, held: 0, frozen: 0, pending: 1, not_seen: 1, not_in_a_desk: 0 },
    "?": { derived: 0, held: 0, frozen: 0, pending: 0, not_seen: 0, not_in_a_desk: 1 },
  })
}))
