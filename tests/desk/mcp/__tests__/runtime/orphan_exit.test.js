// A Desk server with no host left exits and does no work: a closed stdin, a failed write to the host and an ended parent each close it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { execFileSync, spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import * as path from "node:path"
import { indexPath, isolatedEnv, makeIsolatedHome } from "../launch/_mcp_handshake.js"
import { installCrashHandlers, isPeerGoneError, watchParent } from "../../../../../plugins/desk/mcp/index.js"

const posix = process.platform !== "win32"

function started(env) {
  const child = spawn(process.execPath, [indexPath], { env, stdio: ["pipe", "pipe", "pipe"] })
  const lines = []
  child.stdout.on("data", (chunk) => lines.push(chunk.toString("utf8")))
  child.stderr.resume()
  const send = (message) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`)
  const handshake = new Promise((resolve) => {
    child.stdout.on("data", () => { if (lines.join("").includes('"id":2')) resolve() })
  })
  send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })
  send({ method: "notifications/initialized" })
  send({ id: 2, method: "tools/list" })
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })))
  return { child, handshake, exited, send }
}

const within = (promise, ms, what) => Promise.race([
  promise,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not happen within ${ms} ms`)), ms).unref()),
])

function cpuSeconds(pid) {
  const text = execFileSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).trim()
  const parts = text.split(":").map(Number)
  return parts.reduce((total, part) => total * 60 + part, 0)
}

test("only a failed connection to the host counts as the host being gone", () => {
  for (const code of ["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"]) assert.equal(isPeerGoneError(Object.assign(new Error("x"), { code })), true)
  assert.equal(isPeerGoneError(new Error("boom")), false)
  assert.equal(isPeerGoneError(Object.assign(new Error("x"), { code: "ENOENT" })), false)
  assert.equal(isPeerGoneError(null), false)
})

test("a write to a host that is gone closes the session instead of degrading it", () => {
  const target = new EventEmitter()
  const recorded = []
  const gone = []
  installCrashHandlers({ session: { recordException: (kind) => recorded.push(kind) }, stderr: { write() {} }, target, onPeerGone: () => gone.push(true) })
  target.emit("uncaughtException", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
  target.emit("unhandledRejection", Object.assign(new Error("reset"), { code: "ECONNRESET" }))
  assert.equal(gone.length, 2)
  assert.deepEqual(recorded, [])
  target.emit("uncaughtException", new Error("other"))
  assert.deepEqual(recorded, ["uncaught_exception"])
})

test("the parent watch fires once when the parent's pid changes or the parent is gone, and never keeps the process alive", () => {
  const run = ({ ppid, alive }) => {
    let tick
    let fired = 0
    let cleared = 0
    const timer = { unref() { timer.unrefed = true } }
    watchParent({
      onGone: () => { fired += 1 },
      initialPpid: 4242,
      getPpid: () => ppid.value,
      isAlive: () => alive.value,
      setTimer: (callback) => { tick = callback; return timer },
      clearTimer: () => { cleared += 1 },
    })
    return { tick: () => tick(), fired: () => fired, cleared: () => cleared, timer }
  }
  const ppid = { value: 4242 }
  const alive = { value: true }
  const watch = run({ ppid, alive })
  assert.equal(watch.timer.unrefed, true)
  watch.tick()
  assert.equal(watch.fired(), 0)
  ppid.value = 1
  watch.tick()
  assert.equal(watch.fired(), 1)
  assert.equal(watch.cleared(), 1)
  const gone = run({ ppid: { value: 4242 }, alive: { value: false } })
  gone.tick()
  assert.equal(gone.fired(), 1)
  let armed = false
  watchParent({ onGone() {}, initialPpid: 1, setTimer: () => { armed = true } })
  assert.equal(armed, false, "a process started by init has no parent to wait for")
})

test("watchParent's default liveness check treats a missing parent as gone and a protected one as alive", () => {
  const realKill = process.kill
  const outcomes = []
  try {
    for (const code of ["ESRCH", "EPERM", null]) {
      process.kill = () => { if (code) throw Object.assign(new Error(code), { code }) ; return true }
      let tick
      let fired = 0
      watchParent({ onGone: () => { fired += 1 }, initialPpid: 4242, getPpid: () => 4242, setTimer: (callback) => { tick = callback; return { unref() {} } }, clearTimer() {} })
      tick()
      outcomes.push(fired)
    }
  } finally {
    process.kill = realKill
  }
  assert.deepEqual(outcomes, [1, 0, 0])
})

test("main closes the session when the host's output fails", async () => {
  const { main } = await import("../../../../../plugins/desk/mcp/index.js")
  const { PassThrough } = await import("node:stream")
  const { mkTempRoot } = await import("../_temp_roots.js")
  const { idleSearchEngine } = await import("./_in_process_desk.js")
  const root = await mkTempRoot("desk-main-output-gone-")
  const input = new PassThrough()
  const output = new PassThrough()
  const writes = []
  const closedWith = []
  const handle = await main({
    argv: ["--root", root], env: {}, cwd: root, homeDir: root, stateHome: path.join(root, "state"),
    input, output, stderr: { write(text) { writes.push(text); return true } }, admissionKickoffMs: 0,
    runtimeInspector: null, runtimeImporter: async () => ({ createSearchEngine: () => idleSearchEngine() }),
    crashHandlers: true, onClosed: (code) => closedWith.push(code),
  })
  output.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" }))
  assert.deepEqual(closedWith, [0])
  input.end()
  await within(handle.closed, 5000, "the close")
  assert.match(writes.join(""), /the host's output is gone/u)
})

test("a server whose host closes stdin exits within seconds", { skip: !posix, timeout: 60000 }, async () => {
  const home = await makeIsolatedHome("desk-orphan-stdin-")
  const server = started(isolatedEnv(home, { DESK_MCP_IDLE_MS: "0" }))
  await within(server.handshake, 30000, "the handshake")
  server.child.stdin.end()
  const result = await within(server.exited, 5000, "the exit")
  assert.equal(result.code, 0)
})

test("a server whose host stops reading exits instead of degrading", { skip: !posix, timeout: 60000 }, async () => {
  const home = await makeIsolatedHome("desk-orphan-stdout-")
  const server = started(isolatedEnv(home, { DESK_MCP_IDLE_MS: "0" }))
  await within(server.handshake, 30000, "the handshake")
  server.child.stdout.destroy()
  server.send({ id: 3, method: "ping" })
  server.send({ id: 4, method: "ping" })
  await within(server.exited, 5000, "the exit")
})

test("a server whose parent is killed exits even though its stdin never ends", { skip: !posix, timeout: 90000 }, async () => {
  const home = await makeIsolatedHome("desk-orphan-parent-")
  const fifo = path.join(home.root, "stdin.fifo")
  execFileSync("mkfifo", [fifo])
  // The test holds the fifo open both ways, so the server's stdin never ends when its parent dies.
  const hold = openSync(fifo, "r+")
  const parentScript = `
    const { spawn } = require("node:child_process")
    const child = spawn(process.execPath, [${JSON.stringify(indexPath)}], { stdio: ["inherit", "pipe", "ignore"], env: process.env })
    child.stdout.on("data", () => {})
    console.log(child.pid)
    setInterval(() => {}, 1000)
  `
  const parent = spawn(process.execPath, ["-e", parentScript], { env: isolatedEnv(home, { DESK_MCP_IDLE_MS: "0" }), stdio: [hold, "pipe", "inherit"] })
  try {
    const pid = Number(await within(new Promise((resolve) => parent.stdout.once("data", (chunk) => resolve(String(chunk).trim()))), 10000, "the server's start"))
    const gone = () => { try { process.kill(pid, 0); return false } catch { return true } }
    await new Promise((resolve) => setTimeout(resolve, 3000))
    assert.equal(gone(), false, "the server is running while its parent is")
    parent.kill("SIGKILL")
    const deadline = Date.now() + 20000
    while (!gone() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 250))
    assert.equal(gone(), true, "the server exits after its parent is gone")
  } finally {
    parent.kill("SIGKILL")
    closeSync(hold)
  }
})

test("a server with a host that says nothing uses next to no CPU", { skip: !posix, timeout: 90000 }, async () => {
  const home = await makeIsolatedHome("desk-orphan-cpu-")
  const server = started(isolatedEnv(home, { DESK_MCP_IDLE_MS: "0" }))
  try {
    await within(server.handshake, 30000, "the handshake")
    // Admission and the first search index take their CPU in the first seconds.
    await new Promise((resolve) => setTimeout(resolve, 8000))
    const before = cpuSeconds(server.child.pid)
    await new Promise((resolve) => setTimeout(resolve, 10000))
    const used = cpuSeconds(server.child.pid) - before
    assert.ok(used <= 1, `the idle server used ${used} s of CPU in 10 s`)
  } finally {
    server.child.stdin.end()
    await within(server.exited, 10000, "the exit")
  }
})
