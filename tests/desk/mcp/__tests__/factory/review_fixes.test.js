import { test } from "node:test"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { runHook } from "../../../../../plugins/desk/hooks/lib/factory-end.cjs"
import { resolveHookDeskRoot } from "../../../../../plugins/desk/mcp/scripts/resolve-desk-root.js"
import { factoryStateRoot, listMarkers, readMarker, requestFinalize, setConsent, writeMarker } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { deriveFile, deriveMarker, sweep } from "../../../../../plugins/desk/mcp/src/factory/derive-run.js"
import { deriveCopilotSession } from "../../../../../plugins/desk/mcp/src/factory/derive-copilot.js"
import { task_create, task_update } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { runStatusCommand } from "../../../../../plugins/desk/mcp/scripts/factory.js"
import { END, ID, STORE, json, recent, scratch, session } from "./_session_helpers.js"

test("I1 direct, sweep and status refuse an external marker directory without reading or pruning its files", () => scratch(async (ctx) => {
  const marker = { ...await session(ctx), ended_at: END, end_reason: "complete" }
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const root = await factoryStateRoot(ctx.env)
  const external = path.join(ctx.base, "external")
  const name = `${marker.host}-${ID}.json`
  await json(path.join(external, name), marker)
  const stale = path.join(external, "copilot-cli-4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60.json")
  await fs.writeFile(stale, "{")
  await fs.symlink(external, path.join(root, "markers"), process.platform === "win32" ? "junction" : "dir")
  for (const run of [
    () => readMarker(ctx.env, path.join(root, "markers", name)),
    () => sweep(ctx.env),
    () => runStatusCommand({ env: ctx.env, argv: [] }),
  ]) await assert.rejects(run, /symlink/u)
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(external, name), "utf8")), marker)
  assert.equal(await fs.readFile(stale, "utf8"), "{")
  await assert.rejects(fs.stat(path.join(root, "outbox")), { code: "ENOENT" })
}))

test("I1 marker enumeration refuses .git and repairs owned directory/file protection", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const root = await factoryStateRoot(ctx.env)
  const dir = path.join(root, "markers")
  const file = path.join(dir, `${marker.host}-${ID}.json`)
  await fs.mkdir(path.join(dir, ".git"))
  await assert.rejects(listMarkers(ctx.env), /Git checkout/u)
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), marker)
  await fs.rmdir(path.join(dir, ".git"))
  if (process.platform !== "win32") {
    await fs.chmod(dir, 0o755)
    await fs.chmod(file, 0o644)
    assert.deepEqual(await listMarkers(ctx.env), [marker])
    assert.equal((await fs.stat(dir)).mode & 0o777, 0o700)
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600)
  }
}))

test("I1 enumeration never returns oversized, mismatched or externally linked markers", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const root = await factoryStateRoot(ctx.env)
  const file = path.join(root, "markers", `${marker.host}-${ID}.json`)
  await fs.appendFile(file, " ".repeat(72000))
  await assert.rejects(readMarker(ctx.env, file), /metadata_unreadable/u)
  assert.deepEqual(await listMarkers(ctx.env), [])
  await json(file, { ...marker, host: "copilot-cli" })
  assert.equal(await readMarker(ctx.env, file), null)
  assert.deepEqual(await listMarkers(ctx.env), [])
  await json(file, marker)
  const outside = path.join(ctx.base, "outside-marker.json")
  await fs.link(file, outside)
  assert.deepEqual(await listMarkers(ctx.env), [])
  assert.deepEqual(JSON.parse(await fs.readFile(outside, "utf8")), marker)
}))

for (const shape of ["one-key", "aggregate"]) {
  test(`I2 Claude ${shape} truncation holds routing unless the desk declares its store`, () => scratch(async (ctx) => {
    const marker = await session(ctx)
    const records = []
    for (let n = 0; n < 65; n++) {
      const installPath = path.join(ctx.base, "installed", `plugin-${n}`)
      await json(path.join(installPath, "plugin.json"), n === 64 ? { desk: { factory: { store: "example/private-factory" } } } : { name: "fixture", version: "1.0.0" })
      records.push({ version: "1.0.0", installPath })
    }

    const plugins = shape === "one-key" ? { "fixture@local": records } : { "first@local": records.slice(0, 32), "second@local": records.slice(32) }
    await json(path.join(ctx.base, ".claude/plugins/installed_plugins.json"), { version: 2, plugins })
    const options = { host: "claude", env: ctx.env, payload: { session_id: ID, cwd: ctx.desk, transcript_path: marker.log_path, hook_event_name: "Stop" } }
    assert.equal(await runHook(options), "written")
    assert.equal((await listMarkers(ctx.env))[0].routing.store, null)
    await json(path.join(ctx.desk, "_meta/factory.json"), { schema_version: 1, store: "example/declared" })
    assert.equal(await runHook(options), "written")
    assert.equal((await listMarkers(ctx.env))[0].routing.store, "example/declared")
  }))
}

for (const alias of ["none", "state", "desk", "equal"]) {
  test(`I3 ${alias} alias cannot place factory state at or below an unversioned bound desk`, (t) => scratch(async (ctx) => {
    let desk = ctx.desk
    let state = ctx.desk
    const link = path.join(ctx.base, "desk-alias")
    if (alias === "state" || alias === "desk") await fs.symlink(desk, link, process.platform === "win32" ? "junction" : "dir")
    if (alias === "state") state = link
    if (alias === "desk") desk = link
    if (alias === "equal") {
      state = path.join(ctx.base, "new-state")
      desk = path.join(state, "ouroboros-skills/desk/factory")
      await fs.mkdir(path.join(desk, "_meta"), { recursive: true })
      await fs.mkdir(path.join(desk, "_archive"))
    }
    const env = { ...ctx.env, DESK: desk, XDG_STATE_HOME: state }
    const marker = { ...await session(ctx), desk_root: desk, cwd: desk }
    const root = path.join(state, "ouroboros-skills/desk/factory")
    await assert.rejects(writeMarker(env, marker), /bound desk/u)
    await assert.rejects(requestFinalize(env, { job: "1".repeat(32), deskRoot: desk }), /bound desk/u)
    assert.equal((await deriveMarker(env, marker)).result, "source_unreadable")
    assert.equal(await runHook({ host: "claude", env, payload: { session_id: ID, cwd: desk, transcript_path: marker.log_path, hook_event_name: "Stop" } }), "unavailable")
    await assert.rejects(fs.stat(path.join(root, "markers")), { code: "ENOENT" })
    await assert.rejects(fs.stat(path.join(root, "deriving")), { code: "ENOENT" })
    await assert.rejects(fs.stat(path.join(root, "finalize")), { code: "ENOENT" })
    // Simulate a legacy root already present; lifecycle success must survive its refusal.
    await fs.mkdir(root, { recursive: true })
    await task_create({ deskRoot: desk, input: { track: "track", slug: "completed-work", title: "fixture" } })
    const messages = []
    t.mock.method(console, "error", (message) => messages.push(message))
    // task_update's evidence gate (the invented-completion finding) only fires on
    // the transition into `done`; this fixture carries it so the call still
    // exercises the legacy-root-survival path it's actually testing.
    assert.equal((await task_update({ deskRoot: desk, env, input: { track: "track", slug: "completed-work", frontmatter: { status: "done" }, evidence: { kind: "pr", ref: "https://github.com/example-org/example-repo/pull/1" } } })).status, "updated")
    assert.deepEqual(messages, ["desk_factory: finalize_request_deferred", "desk_factory: evaluation_request_deferred"])
    await assert.rejects(fs.stat(path.join(root, "finalize")), { code: "ENOENT" })
  }))
}

test("I4 an actual activation FIFO cannot hold the end hook past its deadline", { skip: process.platform === "win32" }, () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const fifo = path.join(ctx.base, "activation-fifo")
  assert.equal(spawnSync("/usr/bin/mkfifo", [fifo]).status, 0)
  const start = performance.now()
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../../../plugins/desk/hooks/factory-end.cjs", import.meta.url)), "claude"], {
    env: { ...ctx.env, DESK_ACTIVATION_CONFIG: fifo, NODE_OPTIONS: "" }, timeout: 2500, encoding: "utf8",
    input: JSON.stringify({ session_id: ID, cwd: ctx.desk, transcript_path: marker.log_path, hook_event_name: "Stop" }),
  })
  assert.equal(result.status, 0, String(result.error))
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  assert.ok(performance.now() - start < 2000)
}))

test("I4 canonical hook resolution refuses linked, nonregular and oversized activation metadata", () => scratch(async (ctx) => {
  const config = path.join(ctx.base, "activation.json")
  await json(config, { schema_version: 1, desk: { root: ctx.desk } })
  const bound = (file) => resolveHookDeskRoot({ env: { ...ctx.env, DESK_ACTIVATION_CONFIG: file } })
  assert.equal(bound(config).root, ctx.desk)
  const link = path.join(ctx.base, "linked-config")
  await fs.symlink(config, link)
  assert.equal(bound(link).root, null)
  const hard = path.join(ctx.base, "hard-config")
  await fs.link(config, hard)
  assert.equal(bound(config).root, null)
  await fs.unlink(hard)
  assert.equal(bound(ctx.base).root, null)
  await json(config, { schema_version: 1, desk: { root: ctx.desk }, padding: "x".repeat(65536) })
  assert.equal(bound(config).root, null)
}))

test("I4 the hook terminates and reaps its exact worker even when that worker blocks synchronously", () => scratch(async (ctx) => {
  const marker = await session(ctx)
  const preload = path.join(ctx.base, "block-worker.mjs")
  const receipt = path.join(ctx.base, "blocked-worker.pid")
  await fs.writeFile(preload, `import fs from "node:fs"; if (process.argv.includes("--factory-worker")) { fs.writeFileSync(${JSON.stringify(receipt)}, String(process.pid)); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10000); }\n`)
  const start = performance.now()
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../../../../../plugins/desk/hooks/factory-end.cjs", import.meta.url)), "claude"], {
    env: { ...ctx.env, NODE_OPTIONS: `--import=${preload}` }, encoding: "utf8", timeout: 2500,
    input: JSON.stringify({ session_id: ID, cwd: ctx.desk, transcript_path: marker.log_path, hook_event_name: "Stop" }),
  })
  assert.equal(result.status, 0)
  assert.equal(result.stdout, "")
  assert.equal(result.stderr, "")
  const pid = Number(await fs.readFile(receipt, "utf8"))
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" })
  assert.ok(performance.now() - start < 2000)
}))

const RESUME = "2026-09-26T09:00:00.000Z"
const CURRENT_END = "2026-09-26T09:02:00.000Z"
async function resumeOpen(marker) {
  await fs.appendFile(marker.log_path, [
    { type: "session.shutdown", timestamp: END, data: {} },
    { type: "session.resume", timestamp: RESUME, data: {} },
    { type: "assistant.turn_start", timestamp: "2026-09-26T09:00:01.000Z", data: { turnId: "open", interactionId: "resumed" } },
  ].map((event) => JSON.stringify(event)).join("\n") + "\n")
}
async function localFacts(ctx, host = "copilot-cli") {
  return JSON.parse(await fs.readFile(path.join(await factoryStateRoot(ctx.env), "outbox/ourostack__factory", `${host}-${ID}.json`), "utf8"))
}

test("I5 stale end then resume/open turn respects quietness and derives an open lifetime", () => scratch(async (ctx) => {
  const marker = { ...await session(ctx, "copilot-cli"), ended_at: END, end_reason: "complete", updated_at: recent() }
  await writeMarker(ctx.env, marker)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  await resumeOpen(marker)
  assert.equal((await sweep(ctx.env)).skipped, 1)
  await assert.rejects(localFacts(ctx), { code: "ENOENT" })
  const old = new Date(Date.now() - 700000)
  await fs.utimes(marker.log_path, old, old)
  assert.equal((await sweep(ctx.env)).written, 1)
  const facts = await localFacts(ctx)
  assert.equal(facts.session.ended_at, null)
  assert.equal(facts.session.end_reason, null)
  assert.ok(facts.unavailable.some((u) => u.field === "turns" && u.reason === "session_open"))
  assert.equal(facts.unavailable.some((u) => u.field === "turns" && u.reason === "log_truncated"), false)
  await writeMarker(ctx.env, { ...marker, ended_at: CURRENT_END, updated_at: recent(1000) })
  await fs.utimes(marker.log_path, new Date(), new Date())
  assert.equal((await sweep(ctx.env)).written, 1)
  assert.equal((await localFacts(ctx)).session.end_reason, "complete")
}))

test("I5 a concurrent stale derivation cannot publish closure across a native resume", () => scratch(async (ctx) => {
  const stale = { ...await session(ctx, "copilot-cli"), ended_at: END, end_reason: "complete", updated_at: recent() }
  await writeMarker(ctx.env, stale)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  let entered, release
  const reading = new Promise((resolve) => { entered = resolve })
  const wait = new Promise((resolve) => { release = resolve })
  const previous = deriveMarker(ctx.env, stale, { copilot: async (options) => { entered(); await wait; return deriveCopilotSession(options) } })
  await reading
  await resumeOpen(stale)
  const current = { ...stale, ended_at: null, end_reason: null, updated_at: RESUME }
  await writeMarker(ctx.env, current)
  const next = deriveMarker(ctx.env, current)
  release()
  assert.equal((await previous).result, "skipped")
  assert.equal((await next).result, "written")
  assert.equal((await localFacts(ctx)).session.end_reason, null)
}))

test("I5 stale queued marker input uses a newer protected end marker for the same session", () => scratch(async (ctx) => {
  const stale = { ...await session(ctx, "copilot-cli"), ended_at: END, end_reason: "complete", updated_at: recent() }
  await resumeOpen(stale)
  const current = { ...stale, ended_at: CURRENT_END, updated_at: recent(1000) }
  await writeMarker(ctx.env, current)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const results = await Promise.all([deriveMarker(ctx.env, stale), deriveMarker(ctx.env, current)])
  assert.deepEqual(results.map((r) => r.result).sort(), ["skipped", "written"])
  assert.equal((await localFacts(ctx)).session.end_reason, "complete")
}))

test("I5 Claude activity after an end marker reopens that lifetime rather than inventing another end", () => scratch(async (ctx) => {
  const marker = { ...await session(ctx), ended_at: END, end_reason: "prompt_input_exit" }
  await fs.appendFile(marker.log_path, `${JSON.stringify({ type: "user", sessionId: ID, timestamp: RESUME, message: { content: "synthetic resumed input" } })}\n`)
  await writeMarker(ctx.env, marker)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  assert.equal((await sweep(ctx.env)).skipped, 1)
  assert.equal((await deriveMarker(ctx.env, marker)).result, "written")
  assert.equal((await localFacts(ctx, "claude-code")).session.ended_at, null)
}))

test("I5 current marker corruption or loss of binding cannot be bypassed with stale input", () => scratch(async (ctx) => {
  const marker = { ...await session(ctx), updated_at: recent() }
  await writeMarker(ctx.env, marker)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  await json(file, {})
  assert.equal((await deriveMarker(ctx.env, marker)).result, "source_unreadable")
  await writeMarker(ctx.env, { ...marker, desk_root: null, updated_at: recent(1000) })
  assert.equal((await deriveMarker(ctx.env, marker)).result, "held")
}))

test("I5 a resume arriving during lifetime inspection is retried without invoking the native deriver", (t) => scratch(async (ctx) => {
  const marker = { ...await session(ctx, "copilot-cli"), ended_at: END, end_reason: "complete", updated_at: recent() }
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const lstat = fs.lstat
  let stamps = 0
  t.mock.method(fs, "lstat", async (file, ...args) => {
    if (file === marker.log_path && ++stamps === 2) await resumeOpen(marker)
    return lstat(file, ...args)
  })
  assert.equal((await deriveMarker(ctx.env, marker, { copilot: () => assert.fail("changed snapshot must not be derived") })).result, "skipped")
}))

test("quiet waiting reloads a still-valid protected marker before deriving", (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  await setConsent(ctx.env, { store: STORE, contribute: true })
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  const lstat = fs.lstat
  let first = true
  t.mock.method(fs, "lstat", async (target, ...args) => {
    const stat = await lstat(target, ...args)
    if (target === marker.log_path && first) {
      first = false
      return { ...stat, isFile: () => true, mtimeMs: Date.now() }
    }
    return stat
  })
  assert.equal((await deriveFile(ctx.env, file, { quietMs: 20 })).result, "written")
}))

test("I1 pruning refuses to unlink a replaced leaf and propagates protection failures", (t) => scratch(async (ctx) => {
  const marker = await session(ctx)
  await writeMarker(ctx.env, marker)
  const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
  await fs.writeFile(file, "{")
  const lstat = fs.lstat
  let checks = 0
  const race = t.mock.method(fs, "lstat", async (target, ...args) => {
    if (target === file && ++checks === 4) {
      await fs.rename(file, path.join(ctx.base, "old-marker"))
      await json(file, marker)
    }
    return lstat(target, ...args)
  })
  assert.deepEqual(await listMarkers(ctx.env), [])
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), marker)
  race.mock.restore()
  await fs.chmod(file, 0o644)
  const chmod = fs.chmod
  t.mock.method(fs, "chmod", (target, ...args) => {
    if (target === file) throw Object.assign(new Error("protection refused"), { code: "EACCES" })
    return chmod(target, ...args)
  })
  if (process.platform !== "win32") await assert.rejects(listMarkers(ctx.env), /protection refused/u)
}))

for (const activity of ["resume", "late-shutdown"]) {
  test(`I5 detached quietness is rechecked under the lock after ${activity} wins the race`, (t) => scratch(async (ctx) => {
    const marker = { ...await session(ctx, "copilot-cli"), ended_at: END, end_reason: "complete", updated_at: recent() }
    const old = new Date(Date.now() - 60000)
    await fs.utimes(marker.log_path, old, old)
    await writeMarker(ctx.env, marker)
    await setConsent(ctx.env, { store: STORE, contribute: true })
    const file = path.join(await factoryStateRoot(ctx.env), "markers", `${marker.host}-${ID}.json`)
    const lstat = fs.lstat
    let calls = 0
    t.mock.method(fs, "lstat", async (target, ...args) => {
      if (target === marker.log_path && ++calls === 2) {
        if (activity === "resume") await resumeOpen(marker)
        else await fs.appendFile(marker.log_path, `${JSON.stringify({ type: "session.shutdown", timestamp: CURRENT_END, data: {} })}\n`)
      }
      return lstat(target, ...args)
    })
    assert.equal((await deriveFile(ctx.env, file, { quietMs: 30000 })).result, "skipped")
    await assert.rejects(localFacts(ctx), { code: "ENOENT" })
  }))
}
