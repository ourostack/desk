import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, promises as fs } from "node:fs"
import * as path from "node:path"
import { factoryStateRoot, listMarkers, readJobsIndex, readStatus, setConsent, writeMarker, writeStatus } from "../../src/factory/outbox.js"
import { validateLocalFacts } from "../../src/factory/schema.js"
import { deriveCopilotSession } from "../../src/factory/derive-copilot.js"
import { END, ID, SENTINEL, START, STORE, json, scratch, session } from "./_session_helpers.js"

const moduleUrl = new URL("../../src/factory/derive-run.js", import.meta.url)
async function runner() {
  assert.ok(existsSync(moduleUrl), "the detached derivation runner must exist")
  return import(moduleUrl)
}

for (const host of ["claude-code", "copilot-cli"]) {
  test(`${host} derives valid content-free local facts and skips identical evidence`, () => scratch(async (ctx) => {
    const { deriveMarker } = await runner()
    const marker = { ...await session(ctx, host), entrypoint: "launcher", end_reason: "complete", ended_at: END }
    await setConsent(ctx.env, { store: STORE, contribute: true })
    assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "written", store: STORE })
    const file = path.join(await factoryStateRoot(ctx.env), "outbox", "ourostack__factory", `${host}-${ID}.json`)
    const bytes = await fs.readFile(file, "utf8")
    const facts = JSON.parse(bytes)
    assert.equal(validateLocalFacts(facts).ok, true)
    assert.equal(bytes.includes(SENTINEL), false)
    assert.equal(Object.hasOwn(facts, "events"), false)
    assert.equal(facts.session.id, ID)
    if (host === "copilot-cli") assert.equal(facts.session.entrypoint, "launcher")
    assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "skipped", store: STORE })
  }))
}

test("derivation honors consent and holds invalid routing without reading the log", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "not_opted_in", store: STORE })
  await setConsent(ctx.env, { store: STORE, contribute: false })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "not_opted_in")
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: "invalid" })
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "held", store: null })
  assert.deepEqual(await deriveMarker(ctx.env, { ...marker, desk_root: null }), { result: "held", store: null })
  assert.deepEqual(await deriveMarker(ctx.env, { ...marker, session_id: "../escape" }), { result: "invalid", store: null })
}))

test("missing, unreadable and mismatched logs have explicit outcomes", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await fs.unlink(marker.log_path)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "log_missing")
  await fs.mkdir(marker.log_path)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "source_unreadable")
  await fs.rmdir(marker.log_path)
  await fs.writeFile(marker.log_path, "{}\n")
  assert.equal((await deriveMarker(ctx.env, marker)).result, "source_unreadable")
  await session(ctx)
  assert.equal((await deriveMarker(ctx.env, { ...marker, session_id: "4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60" })).result, "invalid")
}))

test("sweep derives quiet stale and ended markers but skips busy logs and unchanged evidence", () => scratch(async (ctx) => {
  const { sweep } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  assert.equal((await sweep(ctx.env)).skipped, 1)
  const old = new Date(Date.now() - 700000)
  await fs.utimes(marker.log_path, old, old)
  assert.equal((await sweep(ctx.env)).written, 1)
  assert.equal((await sweep(ctx.env)).skipped, 1)
  await writeMarker(ctx.env, { ...marker, ended_at: END, end_reason: "complete" })
  assert.equal((await sweep(ctx.env)).written, 1)
  await fs.appendFile(marker.log_path, `${JSON.stringify({ type: "assistant", sessionId: ID, timestamp: "2026-09-26T08:02:00.000Z", message: { content: [] } })}\n`)
  assert.equal((await sweep(ctx.env)).skipped, 1, "activity after the recorded end is a resumed, busy lifetime")
  await fs.utimes(marker.log_path, old, old)
  assert.equal((await sweep(ctx.env)).written, 1)
  assert.equal((await listMarkers(ctx.env)).length, 1)
}))

test("binding writes only hashed jobs and updates the finalize lookup", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  const card = path.join(ctx.desk, "track/task/task.md")
  await fs.mkdir(path.dirname(card), { recursive: true })
  await fs.writeFile(card, `---\nstatus: done\ncreated: ${START}\nupdated: ${END}\n---\n${SENTINEL}\n`)
  await fs.appendFile(marker.log_path, [
    { type: "assistant", sessionId: ID, timestamp: START, message: { content: [{ type: "tool_use", id: "call", name: "mcp__desk__task_update", input: { track: "track", slug: "task", frontmatter: { status: "done" } } }] } },
    { type: "user", sessionId: ID, timestamp: END, message: { content: [{ type: "tool_result", tool_use_id: "call", content: "ok" }] } },
  ].map((line) => JSON.stringify(line)).join("\n") + "\n")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  const index = await readJobsIndex(ctx.env)
  assert.equal(Object.keys(index).length, 1)
  assert.match(Object.keys(index)[0], /^[0-9a-f]{32}$/u)
  assert.deepEqual(Object.values(index)[0], [`claude-code-${ID}.json`])
  assert.equal(JSON.stringify(await readStatus(ctx.env)).includes(SENTINEL), false)
}))

test("concurrent derivation serializes one session instead of overwriting fresher facts", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const results = await Promise.all([deriveMarker(ctx.env, marker), deriveMarker(ctx.env, marker)])
  assert.deepEqual(results.map((r) => r.result).sort(), ["skipped", "written"])
}))

test("routing snapshot survives plugin cleanup, desk declaration wins, and warnings never enter facts", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = { ...await session(ctx), routing: { source: "overlay", store: "example/other", warnings: [{ code: "manifest_unreadable", manifest: path.join(ctx.base, "missing/plugin.json") }] } }
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "not_opted_in", store: "example/other" })
  assert.equal((await readStatus(ctx.env)).routing_warnings.length, 1)
  await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: STORE })
  assert.deepEqual(await deriveMarker(ctx.env, marker), { result: "written", store: STORE })
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "outbox/ourostack__factory", `${marker.host}-${ID}.json`)
  assert.equal((await fs.readFile(file, "utf8")).includes("manifest_unreadable"), false)
  await fs.unlink(file)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written", "missing facts must be repaired")
}))

test("quiet waiting sees late shutdown writes and uses refreshed markers", () => scratch(async (ctx) => {
  const { deriveFile } = await runner()
  const marker = await session(ctx, "copilot-cli")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "markers", `${marker.host}-${ID}.json`)
  const write = fs.appendFile(marker.log_path, `${JSON.stringify({ type: "session.shutdown", timestamp: END, data: { modelMetrics: { "gpt-5": { requests: { count: 3 }, usage: { inputTokens: 12, outputTokens: 34 } } } } })}\n`)
  await write
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 100, maxWaitMs: 2000 })).result, "written")
  const facts = JSON.parse(await fs.readFile(path.join(root, "outbox/ourostack__factory", `${marker.host}-${ID}.json`), "utf8"))
  assert.equal(facts.models[0].requests, 3)
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 30000, maxWaitMs: 1 })).result, "skipped")
  assert.equal((await deriveFile(ctx.env, path.join(root, "markers/no.json"))).result, "invalid")
  await fs.unlink(marker.log_path)
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 1 })).result, "log_missing")
  await fs.writeFile(file, "{")
  assert.equal((await deriveFile(ctx.env, file)).result, "source_unreadable")
}))

test("sweep reports invalid, missing and unreadable sources without losing other markers", () => scratch(async (ctx) => {
  const { sweep, deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await writeMarker(ctx.env, marker)
  await fs.unlink(marker.log_path)
  assert.equal((await sweep(ctx.env)).log_missing, 1)
  await fs.mkdir(marker.log_path)
  assert.equal((await sweep(ctx.env)).source_unreadable, 1)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  await json(file, { updated_at: marker.updated_at })
  assert.equal((await sweep(ctx.env)).invalid, 0, "protected enumeration prunes invalid records before sweep consumes them")
  assert.deepEqual(await listMarkers(ctx.env), [])
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await fs.rmdir(marker.log_path)
  await session(ctx)
  await writeStatus(ctx.env, { derivations: { [path.basename(file)]: { store: STORE, marker: "not-current", size: 1, mtime: 0 } } })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  await fs.mkdir(path.join(ctx.desk, ".git"))
  assert.equal((await deriveMarker({ ...ctx.env, XDG_STATE_HOME: ctx.desk }, marker)).result, "source_unreadable")
}))

test("derivation refuses malformed native facts and a mismatched Copilot path", () => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx, "copilot-cli")
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await deriveMarker(ctx.env, { ...marker, log_path: (await session(ctx)).log_path })).result, "invalid")
  assert.equal((await deriveMarker(ctx.env, marker, { copilot: async (options) => {
    const derived = await deriveCopilotSession(options)
    derived.facts.session.host_version = "incompatible upstream metadata"
    return derived
  } })).result, "invalid")
}))

test("revoking consent during derivation prevents the facts write", (t) => scratch(async (ctx) => {
  const { deriveMarker } = await runner()
  const marker = await session(ctx)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const consentFile = path.join(await factoryStateRoot(ctx.env), "consent.json")
  const read = fs.readFile
  let reads = 0
  t.mock.method(fs, "readFile", async (file, ...args) => {
    if (file === consentFile && ++reads === 2) {
      const value = JSON.parse(await read(file, "utf8"))
      value.stores[STORE].contribute = false
      await fs.writeFile(file, JSON.stringify(value))
    }
    return read(file, ...args)
  })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "not_opted_in")
}))

test("quiet wait refuses a marker invalidated while the detached process was waiting", (t) => scratch(async (ctx) => {
  const { deriveFile } = await runner()
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  const lstat = fs.lstat
  t.mock.method(fs, "lstat", async (target, ...args) => {
    const stat = await lstat(target, ...args)
    if (target === marker.log_path) {
      await fs.writeFile(file, "{}")
      return { ...stat, mtimeMs: Date.now(), isFile: () => true }
    }
    return stat
  })
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 10 })).result, "invalid")
}))
