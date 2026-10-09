// The detached launcher for the loop worker (hooks/loop-start.cjs) and the session-start hook that starts it.
// Every process is fake: a fake spawn, fake timers, and a fake exit; nothing starts a real worker, and no process is signalled
// except the one fake child handle the launcher itself holds.

import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { loopWorkerLine } from "../../../../../plugins/desk/mcp/src/factory/boot-check.js"
import { assembleLoop, withLoopSwitch } from "../../../../../plugins/desk/mcp/src/factory/loop-health.js"
import { recordWorker } from "../../../../../plugins/desk/mcp/src/factory/loop-worker-state.js"
import { promises as fs } from "node:fs"
import { factoryStateRoot, readStatus, updateStatus } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { setConsent } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { STORE, scratch } from "./_session_helpers.js"
import { main as loopMain, HARD_STOP_MS as loopHardStopMs, MAX_EXTENSION_MS } from "../../../../../plugins/desk/hooks/loop-start.cjs"
import { MAX_SCAN_ALLOWANCE_MS } from "../../../../../plugins/desk/mcp/src/factory/loop-worker.js"

const require = createRequire(import.meta.url)
const HOOKS = fileURLToPath(new URL("../../../../../plugins/desk/hooks/", import.meta.url))
const LAUNCHER = path.join(HOOKS, "loop-start.cjs")
const BOOT = path.join(HOOKS, "boot-checks.cjs")
const BOOT_LIB = path.join(HOOKS, "lib", "boot-checks.cjs")
const FACTORY_START = path.join(HOOKS, "factory-start.cjs")
const FACTORY_CLI = path.join(path.dirname(HOOKS), "mcp", "scripts", "factory.js")
const launcher = () => ({ main: loopMain, HARD_STOP_MS: loopHardStopMs })

function fakeChild() {
  const child = new EventEmitter()
  child.killed = []
  child.kill = (...args) => { child.killed.push(args); return true }
  child.unref = () => {}
  return child
}

// Fake timers: one pending hard stop that the test fires by hand.
function fakeTimers() {
  const timers = { pending: [], cleared: [] }
  timers.set = (fn, ms) => { const handle = { fn, ms }; timers.pending.push(handle); return handle }
  timers.clear = (handle) => timers.cleared.push(handle)
  return timers
}

const found = (root = "/desk-root", prefix = "") => ({ resolveRoot: async () => root, resolvePerson: async () => ({ status: "ok", personPrefix: prefix }) })
const interactive = (extra = {}) => ({ HOME: "/h", ...extra })

test("the launcher starts nothing in a headless factory session, before it resolves anything or spawns", async () => {
  const { main } = launcher()
  const calls = []
  for (const value of ["1", "yes", "true"]) {
    const outcome = await main({
      env: interactive({ DESK_FACTORY_HEADLESS: value }),
      spawnImpl: () => { calls.push("spawn"); return fakeChild() },
      resolveRoot: async () => { calls.push("root"); return "/d" },
      resolvePerson: async () => { calls.push("person"); return { status: "ok", personPrefix: "" } },
    })
    assert.deepEqual(outcome, { started: false, reason: "headless_session" })
  }
  assert.deepEqual(calls, [])
})

test("the launcher starts nothing when the loop is switched off, when no desk is bound, or when the person is not known", async () => {
  const { main } = launcher()
  const spawned = []
  const spawnImpl = (...args) => { spawned.push(args); return fakeChild() }
  assert.deepEqual(await main({ env: interactive({ DESK_FACTORY_LOOP: "off" }), spawnImpl, ...found() }), { started: false, reason: "disabled" })
  assert.deepEqual(await main({ env: interactive(), spawnImpl, resolveRoot: async () => null, resolvePerson: async () => ({ status: "ok", personPrefix: "" }) }), { started: false, reason: "no_desk" })
  assert.deepEqual(await main({ env: interactive(), spawnImpl, resolveRoot: async () => { throw new Error("x") }, resolvePerson: async () => ({ status: "ok", personPrefix: "" }) }), { started: false, reason: "no_desk" })
  assert.deepEqual(await main({ env: interactive(), spawnImpl, resolveRoot: async () => "/d", resolvePerson: async () => ({ status: "unresolved", reason: "login_not_cached" }) }), { started: false, reason: "person_unresolved" })
  assert.deepEqual(await main({ env: interactive(), spawnImpl, resolveRoot: async () => "/d", resolvePerson: async () => { throw new Error("x") } }), { started: false, reason: "person_unresolved" })
  assert.deepEqual(spawned, [])
})

test("the launcher runs the loop command for the bound desk and person in its own Node, with ignored stdio and a message channel, and returns when the worker exits", async () => {
  const { main } = launcher()
  const spawned = []
  const child = fakeChild()
  const timers = fakeTimers()
  const env = interactive({ DESK_PERSON: "ari" })
  const done = main({ env, spawnImpl: (...args) => { spawned.push(args); return child }, ...found("/the/desk", "desks/ari"), setTimer: timers.set, clearTimer: timers.clear })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawned.length, 1)
  const [command, args, options] = spawned[0]
  assert.equal(command, process.execPath)
  assert.deepEqual(args, [FACTORY_CLI, "loop", "--desk", "/the/desk", "--person-prefix", "desks/ari"])
  assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"], "no output, and one channel the worker uses to move the hard stop")
  assert.equal(options.env, env)
  assert.equal(options.windowsHide, true)
  assert.equal(timers.pending.length, 1)
  child.emit("exit", 0)
  assert.deepEqual(await done, { started: true, stopped: false })
  assert.deepEqual(timers.cleared, timers.pending, "the hard stop is cancelled when the worker ends by itself")
  assert.deepEqual(child.killed, [])
})

test("a solo desk passes no person prefix", async () => {
  const { main } = launcher()
  const spawned = []
  const child = fakeChild()
  const done = main({ env: interactive(), spawnImpl: (...args) => { spawned.push(args); return child }, ...found("/d", ""), setTimer: fakeTimers().set, clearTimer: () => {} })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(spawned[0][1], [FACTORY_CLI, "loop", "--desk", "/d"])
  child.emit("exit", 1)
  assert.equal((await done).started, true)
})

test("the hard stop fires after the budget plus a short grace, ends only the child the launcher started, by its handle, and the launcher still finishes", async () => {
  const { main, HARD_STOP_MS } = launcher()
  const child = fakeChild()
  const timers = fakeTimers()
  const signalled = []
  const kill = process.kill
  process.kill = (...args) => { signalled.push(args); return true }
  try {
    const done = main({ env: interactive(), spawnImpl: () => child, ...found(), setTimer: timers.set, clearTimer: timers.clear })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(timers.pending[0].ms, HARD_STOP_MS)
    assert.ok(HARD_STOP_MS > 20 * 60 * 1000 && HARD_STOP_MS <= 25 * 60 * 1000, "just past the worker's own 20-minute budget")
    timers.pending[0].fn()
    assert.deepEqual(await done, { started: true, stopped: true })
  } finally {
    process.kill = kill
  }
  assert.deepEqual(child.killed, [[]], "one stop, on the handle, no process-id lookup")
  assert.deepEqual(signalled, [], "nothing is signalled by id or by name")
})

test("the worker's notice moves the hard stop by the time its facts scan took, up to the cap, and never earlier", async () => {
  const { main, HARD_STOP_MS } = launcher()
  const child = fakeChild()
  const timers = fakeTimers()
  let now = 1_000_000
  const done = main({ env: interactive(), spawnImpl: () => child, ...found(), setTimer: timers.set, clearTimer: timers.clear, clock: () => now })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(timers.pending.length, 1)
  now += 131000
  child.emit("message", { desk_loop_extend_ms: 131000 })
  assert.deepEqual(timers.cleared, [timers.pending[0]], "the first hard stop is cancelled")
  assert.equal(timers.pending.length, 2)
  assert.equal(timers.pending[1].ms, HARD_STOP_MS, "re-armed for the original stop plus the scan, counted from the start")
  for (const junk of [{ desk_loop_extend_ms: -1 }, { desk_loop_extend_ms: "x" }, { desk_loop_extend_ms: 1.5 }, { other: 1 }, null, "text", { desk_loop_extend_ms: 1000 }]) child.emit("message", junk)
  assert.equal(timers.pending.length, 2, "a malformed notice, or one that would bring the stop earlier, changes nothing")
  child.emit("message", { desk_loop_extend_ms: 100 * 60 * 60 * 1000 })
  assert.equal(timers.pending.length, 3)
  assert.equal(timers.pending[2].ms, HARD_STOP_MS + MAX_EXTENSION_MS - 131000, "capped at the worker's own scan allowance")
  assert.equal(MAX_EXTENSION_MS, MAX_SCAN_ALLOWANCE_MS, "the launcher and the worker agree on the cap")
  timers.pending[2].fn()
  assert.deepEqual(await done, { started: true, stopped: true })
  assert.deepEqual(child.killed, [[]])
})

test("a child that cannot start, or a handle that cannot be stopped, still ends the launcher quietly", async () => {
  const { main } = launcher()
  const failing = fakeChild()
  const done = main({ env: interactive(), spawnImpl: () => failing, ...found(), setTimer: fakeTimers().set, clearTimer: () => {} })
  await new Promise((resolve) => setImmediate(resolve))
  failing.emit("error", new Error("spawn failed"))
  assert.deepEqual(await done, { started: false, reason: "spawn_failed" })
  assert.deepEqual(await main({ env: interactive(), spawnImpl: () => { throw new Error("sync failure") }, ...found() }), { started: false, reason: "spawn_failed" })
  const stubborn = fakeChild()
  stubborn.kill = () => { throw new Error("already gone") }
  const timers = fakeTimers()
  const stopped = main({ env: interactive(), spawnImpl: () => stubborn, ...found(), setTimer: timers.set, clearTimer: timers.clear })
  await new Promise((resolve) => setImmediate(resolve))
  timers.pending[0].fn()
  assert.deepEqual(await stopped, { started: true, stopped: true })
})

test("session start launches the loop launcher through the compatible-Node launcher right after the delivery worker, only with a consenting store", () => scratch(async ({ env }) => {
  const { startFactory, compatibleCommand } = require(BOOT_LIB)
  const launched = []
  const launch = async (command, childEnv) => launched.push({ command, childEnv })
  const clean = { ...env }
  for (const name of ["CI", "GITHUB_ACTIONS", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "DESK_FACTORY_HEADLESS"]) delete clean[name]
  assert.equal(await startFactory({ env: clean, launch }), false)
  assert.deepEqual(launched, [], "no consenting store, nothing is launched")
  await setConsent(clean, { store: STORE, contribute: true, account: "contributor" })
  assert.equal(await startFactory({ env: clean, launch }), true)
  assert.deepEqual(launched.map((entry) => entry.command), [compatibleCommand(FACTORY_START), compatibleCommand(LAUNCHER)])
  assert.deepEqual(compatibleCommand(LAUNCHER), [process.execPath, BOOT, "--compatible", LAUNCHER])
  assert.ok(launched.every((entry) => entry.childEnv === clean))
  launched.length = 0
  assert.equal(await startFactory({ env: { ...clean, DESK_FACTORY_HEADLESS: "1" }, launch }), false)
  assert.deepEqual(launched, [], "a headless factory session starts neither")
}))

test("a loop launcher that cannot start does not stop delivery, and a delivery that cannot start does not stop the loop", () => scratch(async ({ env }) => {
  const { startFactory } = require(BOOT_LIB)
  const clean = { ...env }
  for (const name of ["CI", "GITHUB_ACTIONS", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "DESK_FACTORY_HEADLESS"]) delete clean[name]
  await setConsent(clean, { store: STORE, contribute: true, account: "contributor" })
  const attempts = []
  const failLoop = async (command) => { attempts.push(command[3]); if (command[3] === LAUNCHER) throw new Error("spawn failed") }
  assert.equal(await startFactory({ env: clean, launch: failLoop }), true)
  assert.deepEqual(attempts, [FACTORY_START, LAUNCHER])
  attempts.length = 0
  const failDelivery = async (command) => { attempts.push(command[3]); if (command[3] === FACTORY_START) throw new Error("spawn failed") }
  assert.equal(await startFactory({ env: clean, launch: failDelivery }), false)
  assert.deepEqual(attempts, [FACTORY_START, LAUNCHER])
}))

const clean = (env, extra = {}) => {
  const copy = { ...env, ...extra }
  for (const name of ["CI", "GITHUB_ACTIONS", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION_ATTENDED", "DESK_FACTORY_HEADLESS"]) delete copy[name]
  return copy
}

test("with the loop switched off, session start launches delivery and not the loop launcher", () => scratch(async ({ env }) => {
  const { startFactory } = require(BOOT_LIB)
  const base = clean(env)
  await setConsent(base, { store: STORE, contribute: true, account: "contributor" })
  const launched = []
  const launch = async (command) => launched.push(command[3])
  for (const value of ["off", "0", ""]) {
    launched.length = 0
    assert.equal(await startFactory({ env: { ...base, DESK_FACTORY_LOOP: value }, launch }), true)
    assert.deepEqual(launched, [FACTORY_START], `DESK_FACTORY_LOOP=${JSON.stringify(value)}`)
  }
  launched.length = 0
  await startFactory({ env: { ...base, DESK_FACTORY_LOOP: "yes" }, launch })
  assert.deepEqual(launched, [FACTORY_START, LAUNCHER])
}))

test("with the loop off, startFactory launches no loop and touches no state: no folder, no file, no lock", () => scratch(async ({ env }) => {
  const { startFactory } = require(BOOT_LIB)
  const base = clean(env, { DESK_FACTORY_LOOP: "off" })
  await setConsent(base, { store: STORE, contribute: true, account: "contributor" })
  const root = await factoryStateRoot(base)
  const tree = async (dir) => {
    const found = []
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name)
      found.push(`${file}:${entry.isDirectory() ? "dir" : (await fs.stat(file)).mtimeMs}`)
      if (entry.isDirectory()) found.push(...await tree(file))
    }
    return found.sort()
  }
  const before = await tree(path.join(base.HOME, "state"))
  const launched = []
  assert.equal(await startFactory({ env: base, launch: async (command) => launched.push(command[3]) }), true)
  assert.deepEqual(launched, [FACTORY_START], "only delivery starts")
  assert.deepEqual(await tree(path.join(base.HOME, "state")), before, "nothing was created or changed")
  assert.equal((await readStatus(base)).loop, undefined)
  assert.deepEqual((await fs.readdir(root)).filter((name) => name.includes("lock")), [])
}))

test("withLoopSwitch says disabled for an off loop whatever the stored record holds, and leaves everything else and a missing record alone", () => {
  const record = { schema: "desk.factory.loop/1", written_at: "2026-10-05T11:00:00.000Z", worker: { last_result: "completed", last_ran_at: "2026-10-05T11:00:00.000Z" } }
  const off = { DESK_FACTORY_LOOP: "off" }
  assert.deepEqual(withLoopSwitch(record, off), { ...record, worker: { last_result: "disabled", last_ran_at: "2026-10-05T11:00:00.000Z" } })
  assert.equal(record.worker.last_result, "completed", "the stored record is not changed in place")
  assert.deepEqual(withLoopSwitch({ schema: "x" }, { DESK_FACTORY_LOOP: "0" }), { schema: "x", worker: { last_ran_at: null, last_result: "disabled" } })
  assert.equal(withLoopSwitch(record, { DESK_FACTORY_LOOP: "yes" }), record)
  assert.equal(withLoopSwitch(record, {}), record)
  assert.equal(withLoopSwitch(null, off), null)
  assert.equal(withLoopSwitch(undefined, off), undefined)
})

test("the session-start line reads the off switch itself, so it is said even before any record exists and whatever the record says", () => scratch(async ({ env }) => {
  const base = clean(env, { DESK_FACTORY_LOOP: "no" })
  assert.match(loopWorkerLine({ env: base }), /^Factory loop: switched off on this machine/)
  await updateStatus(base, (current) => ({ ...current, loop: { worker: { at: new Date().toISOString(), result: "completed", since: new Date().toISOString() } } }))
  assert.match(loopWorkerLine({ env: base }), /switched off/)
  assert.equal(loopWorkerLine({ env: clean(env, { DESK_FACTORY_LOOP: "1" }) }), "")
}))

test("the session-start line says when the loop did not run normally, in a code-only status line with no card", () => scratch(async ({ env }) => {
  const base = clean(env)
  const root = await factoryStateRoot(base)
  const NOW = Date.parse("2026-10-05T12:00:00.000Z")
  const at = (hoursAgo) => new Date(NOW - hoursAgo * 3600 * 1000).toISOString()
  assert.equal(loopWorkerLine({ env: base, now: NOW }), "", "nothing recorded, nothing said")
  const record = async (result, since) => {
    await updateStatus(base, (current) => ({ ...current, loop: { worker: { at: at(0), result, since } } }))
    return loopWorkerLine({ env: base, now: NOW })
  }
  assert.equal(await record("completed", at(1)), "")
  assert.equal(await record("no_desk", at(1)), "")
  assert.equal(await record("disabled", at(1)), "", "a record of an off switch that is on again says nothing")
  assert.equal(await record("busy", at(7)), "Factory loop: has not run for 7 hours because another worker holds the lock")
  assert.match(await record("status_reset", at(0)), /status file was damaged and was set aside/)
  assert.match(await record("status_unavailable", at(0)), /status file was damaged and was set aside/)
  assert.match(await record("budget_spent", at(0)), /whole time budget/)
  await updateStatus(base, (current) => ({ ...current, loop: { worker: { at: at(0), result: "busy", since: at(0) } } }))
  assert.match(loopWorkerLine({ env: base, now: NOW - 3600 * 1000 }), /for 0 hours/, "a clock that is behind never gives a negative age")
  // The same line reaches the session start through the labels check, even when no label waits.
  await recordWorker(base, root, "status_reset", new Date(NOW + 60000).toISOString(), async () => { throw new Error("status not writable") })
  const { labelsCheck } = require(BOOT_LIB)
  const spoken = await labelsCheck.run({ env: base, shared: {}, deadline: Infinity, host: "claude" })
  assert.match(spoken.line, /status file was damaged/)
  assert.match((await labelsCheck.run({ env: { ...base, DESK_FACTORY_LOOP: "off" }, shared: {}, deadline: Infinity, host: "claude" })).line, /switched off on this machine/, "the off switch is read from the environment")
  assert.equal(await labelsCheck.run({ env: { ...base, CI: "1" }, shared: {}, deadline: Infinity, host: "claude" }).then((r) => JSON.stringify(r)), "{}", "a noninteractive session hears nothing")
}))

test("the health record carries the worker's last result and time, and nothing else about it", () => {
  const worker = { at: "2026-10-05T11:00:00.000Z", result: "disabled", since: "2026-10-04T11:00:00.000Z" }
  const make = (loop) => assembleLoop({ status: { last_flush: {}, loop }, read: null, nowMs: Date.parse("2026-10-05T12:00:00.000Z"), version: "9.9.9" }).loop.worker
  assert.deepEqual(make({ worker }), { last_result: "disabled", last_ran_at: "2026-10-05T11:00:00.000Z" })
  assert.deepEqual(make({}), { last_result: "never_ran", last_ran_at: null })
  assert.deepEqual(make({ worker: { at: "bad", result: "x/y" } }), { last_result: "never_ran", last_ran_at: null })
})
