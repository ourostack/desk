import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { writeFileSync, existsSync } from "node:fs"
import * as path from "node:path"
import { runControllerChild } from "../../src/readiness/controller-child.js"
import { mkTempRoot } from "../_temp_roots.js"

const flush = () => new Promise((resolve) => setImmediate(resolve))
function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function childHost(load) {
  const proc = new EventEmitter()
  const messages = []
  const exits = []
  const logs = []
  Object.assign(proc, {
    connected: true,
    stderr: { write: (text) => logs.push(text) },
    send(message, callback) { messages.push(message); callback?.() },
    exit(code) { exits.push(code); proc.emit("exit") },
  })
  runControllerChild(proc, load)
  return { proc, messages, exits, logs }
}

async function options() {
  const stateDir = await mkTempRoot("desk-child-host-")
  return { stateDir, endpoint: path.join(stateDir, "controller.sock"), supervisor: {} }
}

test("the child ignores unrelated or duplicate starts, publishes readiness, and closes once on its control message", async () => {
  const input = await options()
  const owner = { pid: process.pid, token: "owned", process_start: "start" }
  let closes = 0
  let starts = 0
  const host = childHost(async () => ({
    async startControllerRuntime() { starts += 1; return { owner, socket: null, close: async () => { closes += 1 } } },
  }))
  host.proc.emit("message", { type: "other" })
  host.proc.emit("message", { type: "start", options: input })
  await flush()
  host.proc.emit("message", { type: "start", options: input })
  assert.equal(starts, 1)
  assert.deepEqual(host.messages, [{ type: "ready", owner }])
  writeFileSync(path.join(input.stateDir, "owner.json"), JSON.stringify({ owner }))
  host.proc.emit("message", { type: "close" })
  await flush()
  host.proc.emit("message", { type: "close" })
  assert.equal(closes, 1)
  assert.deepEqual(host.exits, [0])
  assert.equal(existsSync(path.join(input.stateDir, "owner.json")), false)
})

test("IPC disconnect before startup exits without loading a runtime", async () => {
  const host = childHost(async () => { throw new Error("runtime must not load") })
  host.proc.emit("exit")
  host.proc.emit("disconnect")
  await flush()
  assert.deepEqual(host.exits, [0])
  assert.deepEqual(host.messages, [])
})

test("IPC disconnect after startup closes the controller and its supervisor", async () => {
  const input = await options()
  let closes = 0
  const host = childHost(async () => ({
    startControllerRuntime: async () => ({ owner: {}, socket: null, close: async () => { closes += 1 } }),
  }))
  host.proc.emit("message", { type: "start", options: input })
  await flush()
  host.proc.emit("disconnect")
  await flush()
  assert.equal(closes, 1)
  assert.deepEqual(host.exits, [0])
})

for (const connected of [true, false]) {
  test(`runtime import failure exits the child and reports only over connected IPC (${connected})`, async () => {
    const host = childHost(async () => { throw Object.assign(new Error("runtime unavailable"), { code: "MISSING" }) })
    host.proc.connected = connected
    host.proc.emit("message", { type: "start", options: await options() })
    await flush()
    assert.deepEqual(host.exits, [1])
    assert.equal(host.messages.length, connected ? 1 : 0)
    if (connected) assert.deepEqual(host.messages[0], { type: "error", message: "runtime unavailable", code: "MISSING" })
    assert.match(host.logs.join(""), /controller child failed: runtime unavailable/u)
  })
}

for (const closeEarly of [true, false]) {
  test(`a controller completing after its parent stopped is closed, never advertised (${closeEarly})`, async () => {
    const pending = deferred()
    let closes = 0
    const host = childHost(() => pending.promise)
    host.proc.emit("message", { type: "start", options: await options() })
    if (closeEarly) host.proc.emit("message", { type: "close" })
    else host.proc.connected = false
    await flush()
    pending.resolve({ startControllerRuntime: async () => ({ owner: {}, socket: null, close: async () => { closes += 1 } }) })
    await flush()
    assert.equal(closes, 1)
    assert.equal(host.messages.length, 0)
    assert.equal(host.exits.at(-1), 0)
  })
}

for (const signal of ["SIGTERM", "SIGINT"]) {
  test(`the child owns ${signal} termination even when a controller close fails`, async () => {
    const host = childHost(async () => ({
      startControllerRuntime: async () => ({ owner: {}, socket: null, close: async () => { throw new Error("close failed") } }),
    }))
    host.proc.emit("message", { type: "start", options: await options() })
    await flush()
    host.proc.emit(signal)
    await flush()
    assert.deepEqual(host.exits, [1])
    assert.match(host.logs.join(""), /controller child cleanup failed: close failed/u)
  })
}

test("a child close blocked by an open connection has a bounded exit deadline", async () => {
  const exited = deferred()
  const host = childHost(async () => ({
    startControllerRuntime: async () => ({ owner: {}, socket: null, close: () => new Promise(() => {}) }),
  }))
  host.proc.on("exit", () => exited.resolve())
  host.proc.emit("message", { type: "start", options: await options() })
  await flush()
  host.proc.emit("message", { type: "close" })
  await exited.promise
  assert.deepEqual(host.exits, [1])
})

test("importing the child module without a CLI entry does not start a controller", async () => {
  const entry = new URL("../../src/readiness/controller-child.js", import.meta.url).href
  const child = spawn(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(entry)}); console.log("imported")`], { stdio: ["ignore", "pipe", "pipe"] })
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  const code = await new Promise((resolve) => child.once("exit", resolve))
  assert.equal(code, 0)
  assert.equal(output.trim(), "imported")
})
