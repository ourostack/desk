import { test } from "node:test"
import assert from "node:assert/strict"
import { fork } from "node:child_process"
import { EventEmitter } from "node:events"
import { pathToFileURL } from "node:url"
import { writeFileSync } from "node:fs"
import * as path from "node:path"
import { createStatusInspection, waitForStatusInspection } from "../../../../../plugins/desk/mcp/src/runtime/status-inspection.js"
import { mkTempRoot } from "../_temp_roots.js"

async function responsiveReader(t, { stopped = false } = {}) {
  const root = await mkTempRoot("status-stop-")
  const preload = path.join(root, "held-reader.mjs")
  writeFileSync(preload, `
    setInterval(() => {}, 1000);
    process.on("SIGTERM", () => {});
  `)
  let child
  const controller = new AbortController()
  const reader = createStatusInspection(root, {
    signal: controller.signal,
    spawn: (file, args, options) => {
      child = fork(file, args, { ...options, execArgv: ["--import", pathToFileURL(preload).href] })
      return child
    },
  })
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL")
    await exited
  })
  assert.equal((await reader.inspect("local")).local_db.state, "missing")
  if (stopped) assert.equal(child.kill("SIGSTOP"), true)
  return { reader, child, controller, exited }
}

test("ordinary reader close exits despite retained timers and signal handlers", async (t) => {
  const { reader, child, exited } = await responsiveReader(t)
  const started = Date.now()
  const outcome = await Promise.race([
    reader.close().then(() => ({ closed: true })),
    new Promise((resolve) => setTimeout(() => resolve({ closed: false }), 1500)),
  ])
  assert.equal(outcome.closed, true, "reader close must not wait forever on retained child handles")
  assert.ok(Date.now() - started < 1500)
  await exited
  assert.ok(child.exitCode !== null || child.signalCode !== null, "actual process exit must precede close success")
})

test("cancelling an unresponsive owned reader escalates and verifies actual exit", {
  skip: process.platform === "win32" ? "SIGSTOP is Unix-only; portable retained-handler termination runs on Windows." : false,
}, async (t) => {
  const { reader, child, controller, exited } = await responsiveReader(t, { stopped: true })
  const pending = reader.inspect("index")
  const rejection = assert.rejects(pending, /cancelled/u)
  controller.abort(new Error("cancelled"))
  const outcome = await Promise.race([
    reader.close().then(() => ({ closed: true }), (error) => ({ closed: true, error })),
    new Promise((resolve) => setTimeout(() => resolve({ closed: false }), 1500)),
  ])
  assert.equal(outcome.closed, true, "SIGTERM alone cannot stop a SIGSTOPped reader")
  await rejection
  const observed = await exited
  assert.equal(observed.signal, "SIGKILL")
  assert.equal(child.signalCode, "SIGKILL")
  await waitForStatusInspection(controller.signal)
})

test("portable cancellation terminates a reader retaining a SIGTERM handler", async (t) => {
  const { reader, child, controller, exited } = await responsiveReader(t)
  const started = Date.now()
  controller.abort(new Error("portable cancellation"))
  await assert.rejects(reader.close(), /portable cancellation/u)
  await exited
  assert.ok(Date.now() - started < 1500)
  assert.ok(child.exitCode !== null || child.signalCode !== null)
})

test("failed termination reports nonexit and retains the exact owned resource for later exit", async () => {
  const child = new EventEmitter()
  child.pid = 12345
  child.connected = true
  const signals = []
  child.send = (_, callback) => callback(null)
  child.disconnect = () => {}
  child.kill = (signal) => { signals.push(signal); return false }
  const controller = new AbortController()
  const reader = createStatusInspection("root", {
    signal: controller.signal, spawn: () => child,
    closeGraceMs: 5, terminateGraceMs: 5, killGraceMs: 5,
  })
  const pending = reader.inspect("local")
  const rejected = assert.rejects(pending, (error) => error.code === "status_reader_not_exited" && error.pid === child.pid)
  const closed = reader.close()
  await assert.rejects(closed, (error) => error.code === "status_reader_not_exited" && error.pid === child.pid)
  await rejected
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"])
  await assert.rejects(waitForStatusInspection(controller.signal), { code: "status_reader_not_exited" })
  assert.equal(reader.resource.exited, false)
  child.emit("exit", null, "SIGKILL")
  assert.equal(reader.resource.exited, true)
  await waitForStatusInspection(controller.signal)
})

test("a throwing owned-child kill reports a bounded nonexit resource rather than success", async () => {
  const child = new EventEmitter()
  child.pid = 42
  child.send = (_, callback) => callback(null)
  child.disconnect = () => { throw new Error("IPC disconnect refused") }
  child.kill = () => { throw new Error("termination refused") }
  const controller = new AbortController()
  const reader = createStatusInspection("root", {
    signal: controller.signal, spawn: () => child,
    closeGraceMs: 1, terminateGraceMs: 1, killGraceMs: 1,
  })
  const pending = reader.inspect("local")
  const rejected = assert.rejects(pending, { code: "status_reader_not_exited" })
  await assert.rejects(reader.close(), (error) => error.code === "status_reader_not_exited" &&
    error.failures.every((message) => message.includes("termination refused")))
  await rejected
  assert.equal(reader.resource.exited, false)
  child.emit("exit", 0)
  await waitForStatusInspection(controller.signal)
})

test("a child that ignores disconnect is stopped by the bounded parent even if it exits synchronously", async () => {
  const child = new EventEmitter()
  child.send = (_, callback) => callback(null)
  child.disconnect = () => {}
  child.kill = (signal) => { child.emit("exit", null, signal); return true }
  const reader = createStatusInspection("root", { spawn: () => child, closeGraceMs: 1 })
  await reader.close()
  assert.deepEqual(reader.resource.signals, ["SIGTERM"])
  assert.equal(reader.resource.exited, true)
})

test("unsuccessful ordinary child exit and errors after exit remain diagnosed without restarting termination", async () => {
  const child = new EventEmitter()
  child.send = (_, callback) => callback(null)
  child.disconnect = () => { child.emit("exit", 1) }
  child.kill = () => assert.fail("an exited process must never be signaled")
  const reader = createStatusInspection("root", { spawn: () => child })
  await assert.rejects(reader.close(), /exited before completing/u)
  child.emit("error", new Error("late IPC error"))
  assert.equal(reader.resource.exited, true)
})

test("a failed soft kill remains explicit even when escalation verifies exit", async () => {
  const child = new EventEmitter()
  child.pid = 43
  child.send = (_, callback) => callback(null)
  child.disconnect = () => {}
  child.kill = (signal) => {
    if (signal === "SIGTERM") return false
    child.emit("exit", null, signal)
    return true
  }
  const reader = createStatusInspection("root", {
    spawn: () => child, closeGraceMs: 1, terminateGraceMs: 1,
  })
  await assert.rejects(reader.close(), { code: "status_reader_termination_failed", pid: 43, signal: "SIGTERM" })
  assert.equal(reader.resource.exited, true)
  assert.deepEqual(reader.resource.failures, ["SIGTERM: child.kill returned false"])
})

test("closing during an unanswered request rejects the request explicitly even when child exit is clean", async () => {
  const child = new EventEmitter()
  child.send = (_, callback) => callback(null)
  child.disconnect = () => child.emit("exit", 0)
  const reader = createStatusInspection("root", { spawn: () => child })
  const pending = reader.inspect("local")
  const rejected = assert.rejects(pending, /before completing its request/u)
  await assert.rejects(reader.close(), /before completing its request/u)
  await rejected
  assert.equal(reader.resource.exited, true)
})
