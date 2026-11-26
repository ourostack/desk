// The idle proxy (mcp/idle-proxy.cjs): the process a host talks to. It starts the real server as a child, passes the MCP stream through, ends the child when nothing has crossed for the idle time, and starts a new one (replaying the handshake) when the host speaks again.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import { PassThrough } from "node:stream"
import * as path from "node:path"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { removeTreeSync } from "../_remove_tree.js"
import { tmpdir } from "node:os"
import { bootstrapPath } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const bootstrap = require(bootstrapPath)
const { createIdleProxy, DEFAULT_IDLE_MS, idleMs, runIdleProxy } = require(bootstrapPath.replace("bootstrap.cjs", "idle-proxy.cjs"))

const IDLE = 1000
const GRACE = 5000
const HOUR = 3600000

function harness({ idleMs: idle = IDLE, failSpawnAt = [], watchesParent = true, ipc = false } = {}) {
  const clock = { now: 0 }
  const timers = new Map()
  let nextTimer = 1
  const stdin = new PassThrough()
  const sent = []
  const stderr = []
  const exits = []
  const kills = []
  const compacted = []
  const signals = new EventEmitter()
  const children = []
  const cleared = []
  const stdout = Object.assign(new EventEmitter(), { write: (text) => sent.push(text) })
  let parentGone = null
  let spawns = 0

  const launchTokens = []
  function launchChild(token) {
    launchTokens.push(token)
    spawns += 1
    if (failSpawnAt.includes(spawns)) throw new Error(`spawn ${spawns} failed`)
    const child = new EventEmitter()
    child.written = []
    child.ended = false
    child.killed = []
    child.stdin = Object.assign(new EventEmitter(), {
      write: (text) => child.written.push(...text.split("\n").filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return line } })),
      end: () => { child.ended = true },
    })
    child.stdout = new PassThrough()
    child.kill = (signal) => child.killed.push(signal)
    if (typeof ipc === "function" ? ipc(spawns) : ipc) {
      child.token = token
      child.ipcSent = []
      child.sendFails = false
      child.sendThrows = false
      child.deferred = null
      child.send = (message, callback) => {
        if (child.sendThrows) throw new Error("channel closed")
        if (child.deferred) {
          child.ipcSent.push(message)
          child.deferred.push(callback)
          return true
        }
        if (child.sendFails) {
          if (callback) callback(new Error("ipc closed"))
          return false
        }
        child.ipcSent.push(message)
        if (callback) callback(null)
        return true
      }
      child.ipc = (op, fields = {}, as = token) => child.emit("message", { desk: "focus-handoff", v: 1, token: as, op, ...fields })
      child.hello = () => child.ipc("hello")
    }
    child.say = (message) => child.stdout.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`)
    child.leave = (code = 0, signal = null) => child.emit("exit", code, signal)
    children.push(child)
    return child
  }

  const proxy = createIdleProxy({
    launchChild,
    stdin,
    stdout,
    watchParent: watchesParent ? (gone) => { parentGone = gone } : undefined,
    stderr: { write: (text) => stderr.push(text) },
    idleMs: idle,
    now: () => clock.now,
    setTimer: (fn, ms) => { timers.set(nextTimer, { fn, at: clock.now + ms }); return nextTimer++ },
    clearTimer: (id) => { if (timers.has(id)) cleared.push(timers.get(id).fn); timers.delete(id) },
    exit: (code) => exits.push(code),
    signals,
    kill: (pid, signal) => kills.push(signal),
    compact: () => compacted.push(clock.now),
    makeToken: () => `token-${launchTokens.length + 1}`,
  })

  const tick = () => new Promise((resolve) => setImmediate(resolve))
  return {
    proxy, stdin, stdout, launchTokens, parentGone: () => parentGone(), sent, stderr, exits, kills, compacted, signals, children, timers, cleared,
    last: () => children.at(-1),
    host: async (message) => { stdin.write(`${typeof message === "string" ? message : JSON.stringify(message)}\n`); await tick() },
    sees: () => sent.filter(Boolean).map((line) => JSON.parse(line.trim())),
    flush: tick,
    advance: async (ms) => {
      clock.now += ms
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= clock.now).sort((a, b) => a[1].at - b[1].at)[0]
        if (due === undefined) break
        timers.delete(due[0])
        due[1].fn()
      }
      await tick()
    },
  }
}

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } }
const INITIALIZED = { jsonrpc: "2.0", method: "notifications/initialized" }
const CALL = (id) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "desk_status" } })

async function handshaken(h) {
  assert.equal(h.proxy.begin(), null)
  await h.host(INIT)
  h.last().say({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "desk" } } })
  await h.host(INITIALIZED)
  await h.flush()
}

test("DESK_MCP_IDLE_MS is a whole number of milliseconds, 0 for never, and 3 minutes when unset or unreadable", () => {
  assert.equal(DEFAULT_IDLE_MS, 180000)
  assert.equal(idleMs({}), DEFAULT_IDLE_MS)
  assert.equal(idleMs({ DESK_MCP_IDLE_MS: "  " }), DEFAULT_IDLE_MS)
  assert.equal(idleMs({ DESK_MCP_IDLE_MS: "soon" }), DEFAULT_IDLE_MS)
  assert.equal(idleMs({ DESK_MCP_IDLE_MS: "-5" }), DEFAULT_IDLE_MS)
  assert.equal(idleMs({ DESK_MCP_IDLE_MS: "0" }), 0)
  assert.equal(idleMs({ DESK_MCP_IDLE_MS: "1500.9" }), 1500)
})

test("the stream passes through both ways; blank lines are dropped and a line that is not a message is passed on as it is", async () => {
  const h = harness({ watchesParent: false })
  await handshaken(h)
  await h.host("")
  await h.host("not json")
  await h.host("[1]")
  await h.host(CALL(2))
  assert.equal(h.last().written.length, 5, "every non-blank line reached the server")
  assert.deepEqual(h.last().written.slice(2, 4), ["not json", [1]])
  h.last().say({ jsonrpc: "2.0", id: 2, result: { ok: true } })
  h.last().say("")
  h.last().say("server noise")
  h.last().say({ jsonrpc: "2.0", id: null, result: 1 })
  await h.flush()
  assert.deepEqual(h.sent.filter(Boolean).map((line) => line.trim()).slice(-3), [JSON.stringify({ jsonrpc: "2.0", id: 2, result: { ok: true } }), "server noise", JSON.stringify({ jsonrpc: "2.0", id: null, result: 1 })])
})

test("after the idle time the server is ended by closing its stdin, and the host's next message starts a new one that replays the handshake before delivering it", async () => {
  const h = harness()
  await handshaken(h)
  await h.host({ jsonrpc: "2.0", method: "logging/setLevel", params: { level: "warning" }, id: 7 })
  h.last().say({ jsonrpc: "2.0", id: 7, result: {} })
  await h.advance(IDLE)
  const first = h.last()
  assert.equal(first.ended, true, "the server's stdin was closed")
  assert.equal(h.proxy.running(), true, "until it has left")
  // Said while the old server is leaving: held until the new one is up.
  await h.host(CALL(3))
  assert.equal(h.children.length, 1)
  first.leave(0)
  await h.flush()
  assert.equal(h.children.length, 2, "a new server started for the waiting message")
  const second = h.last()
  assert.deepEqual(second.written.map((message) => [message.method, message.id]), [["initialize", "desk-idle-proxy-resume"]])
  assert.deepEqual(second.written[0].params, INIT.params, "the handshake the host sent is replayed")
  second.say({ jsonrpc: "2.0", id: "desk-idle-proxy-resume", result: { serverInfo: { name: "desk" } } })
  await h.flush()
  assert.deepEqual(second.written.map((message) => message.method), ["initialize", "notifications/initialized", "logging/setLevel", "tools/call"])
  assert.equal(h.sees().some((message) => message.id === "desk-idle-proxy-resume"), false, "the host never sees a second handshake answer")
  second.say({ jsonrpc: "2.0", id: 3, result: { ok: true } })
  await h.flush()
  assert.deepEqual(h.sees().at(-1), { jsonrpc: "2.0", id: 3, result: { ok: true } })
})

test("a message that arrives while a resumed server is still answering the replay waits for it, and a replay with nothing to replay delivers at once", async () => {
  const h = harness()
  h.proxy.begin()
  await h.advance(IDLE)
  h.last().leave(0)
  await h.host(CALL(1))
  assert.equal(h.last().written.length, 1, "no handshake was ever sent, so the first message goes straight through")
  await h.host(INIT)
  const second = h.last()
  second.say({ jsonrpc: "2.0", id: 1, result: {} })
  await h.advance(IDLE)
  second.leave(0)
  await h.host(CALL(8))
  const third = h.last()
  assert.equal(third.written[0].id, "desk-idle-proxy-resume")
  await h.host(CALL(9))
  assert.equal(third.written.length, 1, "held until the replay is answered")
  third.say({ jsonrpc: "2.0", id: "desk-idle-proxy-resume", result: {} })
  await h.flush()
  assert.deepEqual(third.written.map((message) => message.method), ["initialize", "tools/call", "tools/call"])
  // Its own id is the host's when no replay is running.
  third.say({ jsonrpc: "2.0", id: "desk-idle-proxy-resume", result: {} })
  await h.flush()
  assert.equal(h.sees().at(-1).id, "desk-idle-proxy-resume")
})

test("a call waiting for its answer, or a request from the server waiting for the host's, keeps the server up; a cancelled call, or one stale for an hour, does not", async () => {
  const h = harness()
  await handshaken(h)
  await h.host(CALL(2))
  await h.advance(IDLE * 3)
  assert.equal(h.last().ended, false, "a call is waiting")
  h.last().say({ jsonrpc: "2.0", id: 2, result: {} })
  h.last().say({ jsonrpc: "2.0", id: "s1", method: "roots/list" })
  await h.advance(IDLE * 3)
  assert.equal(h.last().ended, false, "the server is waiting for the host")
  await h.host({ jsonrpc: "2.0", id: "s1", result: { roots: [] } })
  await h.host(CALL(3))
  await h.host({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } })
  await h.host({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} })
  await h.host({ jsonrpc: "2.0", method: "notifications/cancelled" })
  await h.advance(IDLE)
  assert.equal(h.last().ended, true, "nothing is waiting")

  const stale = harness()
  await handshaken(stale)
  await stale.host(CALL(4))
  await stale.advance(HOUR)
  assert.equal(stale.last().ended, true, "a call nobody answered or cancelled for an hour does not hold the server up")
})

test("traffic from the server alone also counts, so the idle time runs from the last message either way", async () => {
  const h = harness()
  await handshaken(h)
  await h.advance(IDLE - 100)
  h.last().say({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })
  await h.flush()
  await h.advance(100)
  assert.equal(h.last().ended, false, "the timer fired but the last message was recent")
  await h.advance(IDLE)
  assert.equal(h.last().ended, true)
})

test("a server that does not leave after its stdin closes is killed", async () => {
  const h = harness()
  await handshaken(h)
  const server = h.last()
  await h.advance(IDLE)
  await h.advance(GRACE)
  assert.deepEqual(server.killed, ["SIGKILL"])
  server.leave(null, "SIGKILL")
  await h.flush()
  assert.equal(h.compacted.length, 1, "the proxy collects its garbage once the server has gone")
  assert.equal(h.proxy.running(), false)
  assert.deepEqual(h.exits, [], "the proxy lives on")
  // A server that leaves in time is not killed afterwards.
  const quick = harness()
  await handshaken(quick)
  await quick.advance(IDLE)
  quick.last().leave(0)
  await quick.advance(GRACE)
  assert.deepEqual(quick.children[0].killed, [])
  // A closed stdin that throws still ends the server.
  const broken = harness()
  await handshaken(broken)
  broken.last().stdin.end = () => { throw new Error("EPIPE") }
  await broken.advance(IDLE)
  broken.last().leave(0)
  await broken.flush()
  assert.equal(broken.proxy.running(), false)
})

test("a server that crashes keeps the host's tools: calls it never answered get a retryable error, and the next message starts a new server that replays the handshake", async () => {
  for (const [code, signal, said] of [[3, null, /exited with code 3/u], [null, "SIGKILL", /ended on SIGKILL/u]]) {
    const h = harness()
    await handshaken(h)
    await h.host(CALL(7))
    const crashed = h.last()
    crashed.leave(code, signal)
    await h.flush()
    assert.deepEqual(h.exits, [])
    assert.equal(h.proxy.running(), false)
    assert.match(h.stderr.join(""), said)
    const failed = h.sees().find((message) => message.id === 7)
    assert.equal(failed.error.code, -32603)
    assert.match(failed.error.message, /retry this call.*friction_add/su)
    // A second exit event from the dead server changes nothing.
    crashed.leave(9)
    await h.host(CALL(8))
    assert.equal(h.children.length, 2)
    assert.equal(h.last().written[0].method, "initialize")
    h.last().say({ jsonrpc: "2.0", id: "desk-idle-proxy-resume", result: {} })
    await h.flush()
    assert.deepEqual(h.last().written.map((message) => message.id ?? message.method), ["desk-idle-proxy-resume", "notifications/initialized", 8])
    assert.deepEqual(h.exits, [])
  }
})

test("a server that crashes again and again right after it starts ends the proxy with its exit code (1 when it gave none), as a server that never runs would", async () => {
  for (const [code, expected] of [[3, 3], [null, 1]]) {
    const h = harness()
    await handshaken(h)
    h.last().leave(code)
    await h.host(CALL(2))
    h.last().leave(code)
    await h.host(CALL(3))
    assert.deepEqual(h.exits, [])
    h.last().leave(code)
    await h.flush()
    assert.deepEqual(h.exits, [expected])
    assert.match(h.stderr.join(""), /3 times in a row; not restarting/u)
  }
})

test("a crash after a long run starts the count again, and a crash after the host has gone ends the proxy with the server's code", async () => {
  const h = harness()
  await handshaken(h)
  for (let round = 0; round < 4; round += 1) {
    await h.advance(60000)
    h.last().leave(1)
    await h.host(CALL(10 + round))
  }
  assert.deepEqual(h.exits, [])

  h.stdin.end()
  await h.flush()
  h.last().leave(4)
  await h.flush()
  assert.deepEqual(h.exits, [4])
})

test("a server that ends after the proxy was sent a signal ends the proxy and is not restarted", async () => {
  const h = harness()
  await handshaken(h)
  h.signals.emit("SIGTERM")
  h.last().leave(null)
  await h.flush()
  assert.deepEqual(h.exits, [1])
})

test("a stale exit from a server that was already replaced is ignored", async () => {
  const h = harness()
  await handshaken(h)
  const old = h.last()
  await h.advance(IDLE)
  old.leave(0)
  await h.flush()
  await h.host(CALL(5))
  old.leave(7)
  await h.flush()
  assert.deepEqual(h.exits, [])
})

test("when the host closes its stream the server is ended and the proxy leaves with the server's exit code; with no server running it leaves at once", async () => {
  const h = harness()
  await handshaken(h)
  h.stdin.write(JSON.stringify(CALL(2)))
  h.stdin.end()
  await h.flush()
  assert.equal(h.last().ended, true)
  assert.deepEqual(h.last().written.at(-1), CALL(2), "an unfinished last line is still delivered")
  h.last().leave(2)
  await h.flush()
  assert.deepEqual(h.exits, [2])
  assert.equal(h.timers.size, 0)

  const silent = harness()
  await handshaken(silent)
  await silent.advance(IDLE)
  silent.last().leave(0)
  await silent.flush()
  silent.stdin.end()
  await silent.flush()
  assert.deepEqual(silent.exits, [0])

  const failing = harness()
  await handshaken(failing)
  failing.stdin.destroy(new Error("EIO"))
  await failing.flush()
  assert.equal(failing.last().ended, true)
  failing.last().stdout.end()
  await failing.advance(GRACE)
  failing.last().leave(null, "SIGKILL")
  await failing.flush()
  assert.deepEqual(failing.exits, [0])
})

test("a host that is gone ends the server and the proxy: its output failing, or its process ending with its stdin still open", async () => {
  for (const goneHost of [(h) => h.stdout.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })), (h) => h.parentGone()]) {
    const h = harness()
    await handshaken(h)
    goneHost(h)
    assert.equal(h.last().ended, true)
    h.last().leave(0)
    assert.deepEqual(h.exits, [0])
  }
})

test("the host closing its stream while the server is being ended, ends the proxy once", async () => {
  const stopping = harness()
  await handshaken(stopping)
  await stopping.advance(IDLE)
  stopping.stdin.end()
  await stopping.flush()
  stopping.last().leave(0)
  await stopping.flush()
  stopping.stdin.emit("end")
  await stopping.flush()
  assert.deepEqual(stopping.exits, [0])
  assert.equal(stopping.timers.size, 0)
})

test("the idle time running out while a resumed server has not answered the replay yet does not end it", async () => {
  const h = harness()
  await handshaken(h)
  await h.advance(IDLE)
  h.last().leave(0)
  await h.host(CALL(5))
  await h.advance(IDLE)
  assert.equal(h.last().ended, false)
})

test("a server that cannot be started: the first failure is returned to bootstrap, a later one ends the proxy", async () => {
  const first = harness({ failSpawnAt: [1] })
  assert.match(first.proxy.begin().message, /spawn 1 failed/u)

  const later = harness({ failSpawnAt: [2] })
  await handshaken(later)
  await later.advance(IDLE)
  later.last().leave(0)
  await later.flush()
  await later.host(CALL(2))
  assert.match(later.stderr.join(""), /could not start the server: Error: spawn 2 failed/u)
  assert.deepEqual(later.exits, [1])

  const odd = harness({ failSpawnAt: [2] })
  await handshaken(odd)
  await odd.advance(IDLE)
  odd.last().leave(0)
  await odd.flush()
  await odd.host(CALL(2))
  assert.deepEqual(odd.exits, [1])
})

test("an error from the server's process or its stdin is reported, never thrown", async () => {
  const h = harness()
  await handshaken(h)
  h.last().emit("error", new Error("kill failed"))
  h.last().emit("error", "plain")
  h.last().stdin.emit("error", new Error("EPIPE"))
  assert.match(h.stderr.join(""), /idle proxy: Error: kill failed/u)
  assert.match(h.stderr.join(""), /idle proxy: plain/u)
  assert.deepEqual(h.exits, [])
})

test("SIGINT, SIGTERM and SIGHUP go to the running server; with none running the proxy takes the signal itself", async () => {
  const h = harness()
  await handshaken(h)
  h.signals.emit("SIGTERM")
  assert.deepEqual(h.last().killed, ["SIGTERM"])
  await h.advance(IDLE)
  h.last().leave(0)
  await h.flush()
  h.signals.emit("SIGHUP")
  assert.deepEqual(h.kills, ["SIGHUP"])
})

// The proxy re-raises a signal it takes itself so that the signal's default action ends it. While its own listener was
// still on the signal, the re-raised signal came straight back to that listener, which raised it again, forever: on
// 2026-11-24 six proxies whose servers had failed to start spun at ~70% of a core each for almost 4 hours after their
// host's SIGTERM, and never ended. The proxy stops listening before it re-raises.
test("a proxy with no server stops listening for signals before it takes one itself, so the signal ends it", async () => {
  const h = harness()
  await handshaken(h)
  await h.advance(IDLE)
  h.last().leave(0)
  await h.flush()
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(h.signals.listenerCount(signal), 1)
  h.signals.emit("SIGTERM")
  assert.deepEqual(h.kills, ["SIGTERM"])
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) assert.equal(h.signals.listenerCount(signal), 0, signal)
})

test("a proxy whose server is running keeps listening, so the next signal still reaches the server", async () => {
  const h = harness()
  await handshaken(h)
  h.signals.emit("SIGINT")
  assert.deepEqual(h.kills, [])
  assert.equal(h.signals.listenerCount("SIGTERM"), 1)
})

test("with the idle time 0 the server is never ended", async () => {
  const h = harness({ idleMs: 0 })
  await handshaken(h)
  await h.advance(HOUR * 5)
  assert.equal(h.last().ended, false)
  assert.equal(h.timers.size, 0)
})

test("a message with no id, or an initialize with none, does not count as a call", async () => {
  const h = harness()
  h.proxy.begin()
  await h.host({ jsonrpc: "2.0", id: null, method: "ping" })
  await h.host({ jsonrpc: "2.0", method: "initialize" })
  await h.advance(IDLE)
  assert.equal(h.last().ended, true)
})

test("runIdleProxy starts index.js under the chosen Node with the host's own pid for the session boot, and returns what stopped it from starting", async () => {
  const calls = []
  const stdin = new PassThrough()
  const common = (extra) => ({
    node: "/node", indexFile: "/mcp/index.js", args: ["--root", "/d"], idleMs: IDLE, stdin, stdout: { write() {} }, stderr: { write() {} },
    exit() {}, signals: new EventEmitter(), kill() {}, setTimer: () => 1, clearTimer() {},
    spawn: (...call) => { calls.push(call); return extra?.child ?? Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new PassThrough(), kill() {} }) },
    ...extra,
  })
  const started = runIdleProxy({ ...common(), env: { A: "1" } })
  assert.equal(started.error, null)
  assert.equal(started.proxy.running(), true)
  assert.deepEqual(calls[0].slice(0, 2), ["/node", ["/mcp/index.js", "--root", "/d"]])
  assert.deepEqual(calls[0][2].stdio, ["pipe", "pipe", "inherit", "ipc"])
  assert.match(calls[0][2].env.DESK_FOCUS_HANDOFF_TOKEN, /^[0-9a-f]{32}$/u)
  runIdleProxy({ ...common(), env: { DESK_FOCUS_HANDOFF_TOKEN: "inherited" } })
  assert.notEqual(calls[1][2].env.DESK_FOCUS_HANDOFF_TOKEN, "inherited")
  assert.notEqual(calls[1][2].env.DESK_FOCUS_HANDOFF_TOKEN, calls[0][2].env.DESK_FOCUS_HANDOFF_TOKEN)
  calls.pop()
  assert.equal(calls[0][2].env.A, "1")
  assert.equal(calls[0][2].env.DESK_SESSION_HOST_PID, String(process.ppid))
  runIdleProxy({ ...common(), env: { DESK_SESSION_HOST_PID: "42" }, now: undefined })
  assert.equal(calls[1][2].env.DESK_SESSION_HOST_PID, "42")
  const failed = runIdleProxy({ ...common({ spawn: () => { throw new Error("nope") } }), env: {} })
  assert.equal(failed.error.message, "nope")
})

test("bootstrap.cjs runs the proxy when its own Node is the right one, index.js in this process when the idle time is 0 or importIndex is given", async () => {
  // This process's own Node: a made-up one is not found on Windows, where the selection then picks the real installed Node and starts a real server nothing stops.
  const current = { path: process.execPath, version: process.version, abi: process.versions.modules }
  const base = { env: { PATH: "", HOME: "/nonexistent", DESK_NODE_SYSTEM_PREFIX: "/nonexistent-prefix" }, args: ["--root", "/d"], current, mcpRoot: path.dirname(bootstrapPath) }
  const spawns = []
  const stdin = new PassThrough()
  const proxied = bootstrap.run({
    ...base, stdin, stdout: new PassThrough(), stderr: { write() {} }, signals: new EventEmitter(),
    setTimer: () => 1, clearTimer() {}, exit() {}, kill() {},
    spawn: (...call) => { spawns.push(call); return Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new PassThrough(), kill() {} }) },
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0][1], [path.join(path.dirname(bootstrapPath), "index.js"), "--root", "/d"])
  void proxied

  const inProcess = []
  await bootstrap.run({ ...base, env: { ...base.env, DESK_MCP_IDLE_MS: "0" }, importIndex: (file) => { inProcess.push(file) } })
  await bootstrap.run({ ...base, importIndex: (file) => { inProcess.push(file) } })
  assert.equal(inProcess.length, 2)

  const errors = []
  const out = new PassThrough()
  const failingInput = new PassThrough()
  bootstrap.run({
    ...base, stdin: failingInput, stdout: out, stderr: { write: (text) => errors.push(text) },
    signals: new EventEmitter(), exit() {}, kill() {}, setTimer: () => 1, clearTimer() {},
    spawn: () => { throw new Error("EACCES") },
  })
  await new Promise((resolve) => setImmediate(resolve))
  failingInput.end()
  await new Promise((resolve) => setImmediate(resolve))
  assert.match(errors.join(""), /could not start .*EACCES/u)
})

// ---- following the newest installed Desk ----

const NODE = { version: "22.12.0", abi: "127" }
const BASE_PACKAGE = { name: "@ourostack/desk-mcp", version: "1.4.0-alpha.6", toolProtocol: 1, engines: { node: ">=20" } }

function sessions(copies) {
  const scanRoot = mkdtempSync(path.join(tmpdir(), "desk-newest-"))
  for (const [id, copy] of Object.entries(copies)) {
    const pluginRoot = path.join(scanRoot, id, "root-5", "desk")
    mkdirSync(path.join(pluginRoot, "mcp"), { recursive: true })
    writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "desk", repository: "https://github.com/ourostack/desk", version: copy.version, ...copy.plugin }))
    if (copy.package !== null) writeFileSync(path.join(pluginRoot, "mcp", "package.json"), JSON.stringify({ ...BASE_PACKAGE, ...copy.package }))
    if (copy.index !== false) writeFileSync(path.join(pluginRoot, "mcp", "index.js"), "")
    if (copy.abis) {
      const dir = path.join(pluginRoot, "mcp", "artifacts", "runtime-deps", BASE_PACKAGE.version)
      mkdirSync(dir, { recursive: true })
      writeFileSync(path.join(dir, "support-matrix.json"), JSON.stringify({ targets: copy.abis.map((abi) => ({ platform: process.platform, arch: process.arch, node_abi: abi })) }))
    }
  }
  return { scanRoot, mcp: (id) => path.join(scanRoot, id, "root-5", "desk", "mcp") }
}

const newest = (s, own = "own") => bootstrap.newestDesk({ mcpRoot: s.mcp(own), current: NODE, platform: process.platform, arch: process.arch, scanRoot: s.scanRoot })

test("a new server runs the newest installed Desk that has the same tool protocol", () => {
  const s = sessions({ own: { version: "3.2.280" }, old: { version: "3.2.270" }, mid: { version: "3.2.281" }, top: { version: "3.2.283" } })
  const chosen = newest(s)
  assert.equal(chosen.version, "3.2.283")
  assert.equal(chosen.indexFile, path.join(s.mcp("top"), "index.js"))
  assert.equal(chosen.pluginRoot, path.dirname(s.mcp("top")))
})

test("a newer Desk is passed over when its tool protocol differs or is absent, it is another plugin, its index.js is missing, or its engines or runtime pack refuse this Node", () => {
  const s = sessions({
    own: { version: "3.2.280", abis: ["127"] },
    protocol: { version: "3.2.290", package: { toolProtocol: 2 } },
    undeclared: { version: "3.2.291", package: { toolProtocol: undefined } },
    nopackage: { version: "3.2.292", package: null },
    other: { version: "3.2.293", plugin: { repository: "https://example.com/fork" } },
    noindex: { version: "3.2.294", index: false },
    engines: { version: "3.2.295", package: { engines: { node: ">=24" } } },
    pack: { version: "3.2.296", abis: ["115"] },
    ok: { version: "3.2.281", abis: ["127"], package: { engines: undefined } },
    unreadable: { version: "3.2.282", plugin: { version: "not a version" } },
  })
  writeFileSync(path.join(s.scanRoot, "a-file"), "")
  mkdirSync(path.join(s.scanRoot, "own", "not-a-root", "desk"), { recursive: true })
  assert.equal(newest(s).version, "3.2.281")
  assert.equal(newest(sessions({ own: { version: "3.2.280", plugin: { name: "other" } } }), "missing"), null, "a copy with no manifest of its own")
  assert.equal(newest(sessions({ own: { version: "3.2.280" }, same: { version: "3.2.280" }, older: { version: "3.2.200" } })), null, "nothing newer keeps this copy")
})

test("this copy keeps running when it cannot tell: no protocol of its own, not in a sessions layout, or an unreadable scan folder", () => {
  const s = sessions({ own: { version: "3.2.280", package: { toolProtocol: undefined } }, top: { version: "3.2.299" } })
  assert.equal(newest(s), null)
  const t = sessions({ own: { version: "3.2.280" }, top: { version: "3.2.299" } })
  assert.equal(bootstrap.newestDesk({ mcpRoot: t.mcp("own"), current: NODE, platform: process.platform, arch: process.arch }), null, "default scan needs <sessions>/<session>/root-N/desk")
  assert.equal(bootstrap.newestDesk({ mcpRoot: t.mcp("own"), current: NODE, platform: process.platform, arch: process.arch, scanRoot: path.join(t.scanRoot, "missing") }), null)
})

test("without a scan folder, a copy that sits in <sessions>/<session>/root-N/desk scans its sibling sessions", () => {
  const root = mkdtempSync(path.join(tmpdir(), "desk-layout-"))
  const s = sessions({ own: { version: "3.2.280" }, top: { version: "3.2.284" } })
  const sessionsDir = path.join(root, "sessions")
  renameSync(s.scanRoot, sessionsDir)
  const found = bootstrap.newestDesk({ mcpRoot: path.join(sessionsDir, "own", "root-5", "desk", "mcp"), current: NODE, platform: process.platform, arch: process.arch })
  assert.equal(found.version, "3.2.284")
})

test("the idle proxy starts each new server from the chosen Desk, keeps a plugin root the host set, and falls back to its own copy when there is no choice or the choice throws", () => {
  const calls = []
  const logs = []
  const stdin = new PassThrough()
  let choice = { indexFile: "/new/mcp/index.js", pluginRoot: "/new", version: "3.2.290" }
  const run = (env) => runIdleProxy({
    node: "/node", indexFile: "/own/mcp/index.js", args: ["--root", "/d"], idleMs: IDLE, stdin, stdout: { write() {} }, stderr: { write: (t) => logs.push(t) },
    exit() {}, signals: new EventEmitter(), kill() {}, setTimer: () => 1, clearTimer() {}, env,
    exists: () => true, chooseIndex: () => { if (choice instanceof Error) throw choice; return choice },
    spawn: (...call) => { calls.push(call); return Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new PassThrough(), kill() {} }) },
  })
  run({})
  assert.deepEqual(calls[0][1], ["/new/mcp/index.js", "--root", "/d"])
  assert.equal(calls[0][2].env.DESK_PLUGIN_ROOT, "/new")
  assert.match(logs.join(""), /running Desk 3\.2\.290 from \/new/u)
  run({ DESK_PLUGIN_ROOT: "/own" })
  assert.equal(calls[1][2].env.DESK_PLUGIN_ROOT, "/new", "the root this copy would have used moves with it")
  run({ DESK_PLUGIN_ROOT: "/pinned" })
  assert.equal(calls[2][2].env.DESK_PLUGIN_ROOT, "/pinned", "a root the host set that exists stays")
  choice = null
  run({})
  assert.equal(calls[3][1][0], "/own/mcp/index.js")
  choice = new Error("scan failed")
  run({})
  assert.equal(calls[4][1][0], "/own/mcp/index.js")
})

test("a session whose own Desk folder was removed keeps working: the next server runs the newest installed copy of the same Desk", () => {
  const s = sessions({ own: { version: "3.2.390", abis: ["127"] }, a: { version: "3.2.480", abis: ["127"] }, b: { version: "3.2.495", abis: ["127"] }, other: { version: "3.2.499", plugin: { repository: "https://example.com/fork" } } })
  const own = bootstrap.readOwn(s.mcp("own"), process.platform, process.arch)
  removeTreeSync(path.dirname(s.mcp("own")))
  const ask = (extra) => bootstrap.newestDesk({ mcpRoot: s.mcp("own"), current: NODE, platform: process.platform, arch: process.arch, scanRoot: s.scanRoot, ...extra })
  assert.equal(ask({}), null, "with no record of what it was, it cannot tell which Desk to follow")
  assert.equal(ask({ own }).version, "3.2.495")
  removeTreeSync(path.dirname(s.mcp("b")))
  removeTreeSync(path.dirname(s.mcp("a")))
  assert.equal(ask({ own }), null, "nothing installed is left to follow")
})

test("a copy in a <plugin>/<version> folder, as a host's plugin cache keeps them, follows its sibling versions after its own is pruned", () => {
  const cache = mkdtempSync(path.join(tmpdir(), "desk-cache-"))
  const install = (version) => {
    const root = path.join(cache, version)
    mkdirSync(path.join(root, "mcp"), { recursive: true })
    writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "desk", repository: "https://github.com/ourostack/desk", version }))
    writeFileSync(path.join(root, "mcp", "package.json"), JSON.stringify(BASE_PACKAGE))
    writeFileSync(path.join(root, "mcp", "index.js"), "")
    return path.join(root, "mcp")
  }
  const old = install("3.2.390")
  install("3.2.480")
  install("3.2.495")
  mkdirSync(path.join(cache, "not-a-version"))
  const ask = (extra) => bootstrap.newestDesk({ mcpRoot: old, current: NODE, platform: process.platform, arch: process.arch, ...extra })
  assert.equal(ask({}).version, "3.2.495", "a live copy follows the newest sibling too")
  const own = bootstrap.readOwn(old, process.platform, process.arch)
  removeTreeSync(path.dirname(old))
  assert.equal(ask({ own }).pluginRoot, path.join(cache, "3.2.495"))
  assert.equal(bootstrap.newestDesk({ mcpRoot: path.join(cache, "plain", "mcp"), current: NODE, platform: process.platform, arch: process.arch, own }), null, "a folder that is neither layout is left alone")
})

test("the idle proxy replaces a plugin root the host set when that folder no longer exists", () => {
  const calls = []
  runIdleProxy({
    node: "/node", indexFile: "/own/mcp/index.js", args: [], idleMs: IDLE, stdin: new PassThrough(), stdout: { write() {} }, stderr: { write() {} },
    exit() {}, signals: new EventEmitter(), kill() {}, setTimer: () => 1, clearTimer() {}, env: { DESK_PLUGIN_ROOT: "/gone" }, exists: () => false,
    chooseIndex: () => ({ indexFile: "/new/mcp/index.js", pluginRoot: "/new", version: "3.2.495" }),
    spawn: (...call) => { calls.push(call); return Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new PassThrough(), kill() {} }) },
  })
  assert.equal(calls[0][2].env.DESK_PLUGIN_ROOT, "/new")
})

test("tool protocol 1 promises every tool the host may have cached: removing or renaming one needs a new protocol number in mcp/package.json", async () => {
  const { TOOL_NAMES } = await import("../../../../../plugins/desk/mcp/src/tool-names.js")
  const pkg = JSON.parse(readFileSync(path.join(path.dirname(bootstrapPath), "package.json"), "utf8"))
  const protocol1 = ["task_create", "task_update", "task_archive", "task_focus", "task_signoff", "track_create", "track_update", "friction_add", "lesson_add", "desk_save", "note", "desk_search", "desk_recall", "desk_status", "desk_doctor", "desk_skill", "improvement_open", "improvement_next", "improvement_update"]
  if (pkg.toolProtocol === 1) for (const name of protocol1) assert.ok(TOOL_NAMES.includes(name), `${name} is gone but toolProtocol is still 1`)
  assert.equal(typeof pkg.toolProtocol, "number")
})

// Focus handoff: the proxy keeps the server's focus in its own memory across an idle stop and gives it back to the next server over a private IPC channel, never over the host's stdio.
const RESUME = "desk-idle-proxy-resume"
const WINDOW = 2000
const TOTAL = 5000
const SNAPSHOT = { declared: true, task: { track: "t", slug: "s" }, scope: "scope-a" }
const PING = { jsonrpc: "2.0", method: "notifications/ping" }
const ipcOps = (child, op) => child.ipcSent.filter((message) => message.op === op)
const answer = (child, id) => child.say({ jsonrpc: "2.0", id, result: { ok: true } })

// A handshaken server that has served a call, is idle, snapshots `snapshot` and leaves. Returns the stopped server.
async function idleWithFocus(h, snapshot = SNAPSHOT) {
  await handshaken(h)
  const first = h.last()
  first.hello()
  await h.host(CALL(2))
  answer(first, 2)
  await h.flush()
  await h.advance(IDLE)
  const asked = ipcOps(first, "snapshot")
  assert.equal(asked.length, 1, "an idle stop asks a supporting server for its focus")
  if (snapshot !== null) first.ipc("snapshot-result", { id: asked[0].id, snapshot })
  await h.flush()
  return first
}

// The next server after an idle stop, once the host speaks and the server has answered the replayed initialize.
async function resumedAfter(h, first, message = PING) {
  first.leave(0)
  await h.flush()
  await h.host(message)
  const next = h.last()
  assert.notEqual(next, first)
  assert.equal(next.written[0].id, RESUME)
  next.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  await h.flush()
  return next
}

const delivered = (child, message) => child.written.filter((line) => JSON.stringify(line) === JSON.stringify(message)).length

test("each server gets its own private token, and nothing of the handoff reaches the host's stream", async () => {
  const h = harness({ ipc: true })
  const first = await idleWithFocus(h)
  const next = await resumedAfter(h, first)
  next.hello()
  await h.flush()
  assert.equal(new Set(h.launchTokens).size, 2)
  assert.ok(h.launchTokens.every((token) => typeof token === "string" && token.length > 0))
  assert.equal(h.sent.filter((line) => /focus-handoff|snapshot/u.test(line)).length, 0)
  assert.ok(![...first.written, ...next.written].some((line) => /focus-handoff/u.test(JSON.stringify(line))), "stdio to the server carries no handoff")
})

test("an idle stop keeps the server's stdin open until its focus arrives, then ends it; a server that never answers is ended at 2000 ms and killed at the one 5000 ms deadline", async () => {
  const answered = harness({ ipc: true })
  await handshaken(answered)
  answered.last().hello()
  await answered.host(CALL(2))
  answer(answered.last(), 2)
  await answered.flush()
  await answered.advance(IDLE)
  assert.equal(answered.last().ended, false, "waits for the snapshot")
  const asked = ipcOps(answered.last(), "snapshot")[0]
  answered.last().ipc("snapshot-result", { id: asked.id + 99, snapshot: SNAPSHOT })
  answered.last().ipc("snapshot-result", { id: asked.id, snapshot: SNAPSHOT }, "wrong-token")
  assert.equal(answered.last().ended, false, "another id or token is ignored")
  answered.last().ipc("snapshot-result", { id: asked.id, snapshot: SNAPSHOT })
  assert.equal(answered.last().ended, true)

  const silent = harness({ ipc: true })
  await handshaken(silent)
  silent.last().hello()
  await silent.host(CALL(2))
  answer(silent.last(), 2)
  await silent.flush()
  await silent.advance(IDLE)
  await silent.advance(WINDOW - 1)
  assert.equal(silent.last().ended, false)
  await silent.advance(1)
  assert.equal(silent.last().ended, true, "ended at 2000 ms")
  await silent.advance(TOTAL - WINDOW - 1)
  assert.deepEqual(silent.last().killed, [])
  await silent.advance(1)
  assert.deepEqual(silent.last().killed, ["SIGKILL"], "killed 5000 ms after the stop began, not 5000 ms after the stdin closed")
})

test("a supporting server's idle stop taken after the host's stream ended, or from a server with no private channel, keeps nothing and waits for nothing", async () => {
  const ended = harness({ ipc: true })
  await handshaken(ended)
  ended.last().hello()
  await ended.host(CALL(2))
  answer(ended.last(), 2)
  ended.stdin.emit("end")
  await ended.flush()
  assert.equal(ipcOps(ended.last(), "snapshot").length, 0)
  assert.equal(ended.last().ended, true)

  const plain = harness()
  await handshaken(plain)
  await plain.host(CALL(2))
  answer(plain.last(), 2)
  await plain.advance(IDLE)
  plain.last().leave(0)
  await plain.host(PING)
  plain.last().say({ jsonrpc: "2.0", id: RESUME, result: {} })
  assert.equal(delivered(plain.last(), PING), 1, "no retained focus: delivered at once")
})

test("no retained focus means no wait: a server that never had a task declared, or never used, resumes at once", async () => {
  const h = harness({ ipc: true })
  const first = await idleWithFocus(h, { declared: false })
  const next = await resumedAfter(h, first)
  assert.equal(delivered(next, PING), 1)
  assert.equal(ipcOps(next, "restore").length, 0)
})

test("a hello that arrives after the stdout reply still restores the focus; it is never taken as an unsupported server", async () => {
  const h = harness({ ipc: true })
  const first = await idleWithFocus(h)
  const next = await resumedAfter(h, first)
  assert.equal(delivered(next, PING), 0, "held while support is awaited")
  await h.advance(900)
  next.hello()
  await h.flush()
  const restore = ipcOps(next, "restore")
  assert.equal(restore.length, 1)
  assert.deepEqual(restore[0].snapshot, SNAPSHOT)
  assert.equal(restore[0].budgetMs, WINDOW - 900, "the restore gets only what is left of the one window")
  assert.equal(delivered(next, PING), 0, "held until the restore is answered")
  next.ipc("restore-result", { id: restore[0].id + 1, outcome: "restored" })
  assert.equal(delivered(next, PING), 0, "another id is ignored")
  next.ipc("restore-result", { id: restore[0].id, outcome: "restored" })
  assert.equal(delivered(next, PING), 1)
  assert.match(h.stderr.join(""), /focus handoff restored/u)
})

test("a server that never says hello is released at 2000 ms from the replay reply, not before; a late hello then only notes that the focus is unknown", async () => {
  const h = harness({ ipc: true })
  const first = await idleWithFocus(h)
  const next = await resumedAfter(h, first)
  await h.advance(WINDOW - 1)
  assert.equal(delivered(next, PING), 0)
  await h.advance(1)
  assert.equal(delivered(next, PING), 1)
  assert.equal(next.ended, false, "nothing commit-capable was sent, so nothing is retired")
  assert.equal(ipcOps(next, "restore").length, 0)
  next.hello()
  await h.flush()
  const late = ipcOps(next, "restore")
  assert.equal(late.length, 1)
  assert.equal(late[0].unknown, "hello_late")
  assert.equal(late[0].snapshot, undefined, "a late hello never carries a focus value")
  assert.match(h.stderr.join(""), /focus handoff support_unconfirmed/u)
})

test("a restore answered at 1999 ms releases the host's messages; one not answered at 2000 ms retires the server and holds them until it is gone", async () => {
  const quick = harness({ ipc: true })
  const first = await idleWithFocus(quick)
  const next = await resumedAfter(quick, first)
  next.hello()
  await quick.advance(WINDOW - 1)
  next.ipc("restore-result", { id: ipcOps(next, "restore")[0].id, outcome: "restored" })
  assert.equal(delivered(next, PING), 1)

  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const retiring = await resumedAfter(h, old)
  retiring.hello()
  await h.advance(WINDOW - 1)
  assert.equal(retiring.ended, false)
  await h.advance(1)
  assert.equal(retiring.ended, true, "retired at 2000 ms")
  assert.equal(ipcOps(retiring, "abort").length, 1, "and told to stop")
  assert.equal(delivered(retiring, PING), 0)
  await h.advance(TOTAL - WINDOW - 1)
  assert.deepEqual(retiring.killed, [])
  await h.advance(1)
  assert.deepEqual(retiring.killed, ["SIGKILL"], "killed at 5000 ms from the replay reply: one deadline, no second 5 s")
  assert.equal(h.children.length, 2, "no replacement while the retired server is still there")
  retiring.ipc("restore-result", { id: ipcOps(retiring, "restore")[0].id, outcome: "restored" })
  assert.equal(h.children.length, 2, "a late answer from the retired server is dropped")
  retiring.leave(null, "SIGKILL")
  await h.flush()
  const replacement = h.last()
  assert.equal(h.children.length, 3)
  assert.equal(delivered(retiring, PING), 0, "never delivered to the retired server")
  replacement.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  replacement.hello()
  await h.flush()
  const note = ipcOps(replacement, "restore")[0]
  assert.equal(note.unknown, "restore_timeout")
  assert.equal(note.snapshot, undefined)
  assert.equal(delivered(replacement, PING), 0)
  replacement.ipc("restore-result", { id: note.id, outcome: "unknown" })
  assert.equal(delivered(replacement, PING), 1, "delivered once, to the replacement")
  assert.equal(delivered(retiring, PING), 0)
})

test("a retired server that leaves on its own after its stdin closes releases the held messages to a replacement before the kill", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const retiring = await resumedAfter(h, old, CALL(9))
  retiring.hello()
  await h.advance(WINDOW)
  assert.equal(retiring.ended, true)
  retiring.leave(0)
  await h.flush()
  const replacement = h.last()
  assert.notEqual(replacement, retiring)
  assert.equal(delivered(retiring, CALL(9)), 0)
  assert.equal(h.sent.filter(Boolean).some((line) => /"id":9/u.test(line)), false, "a queued call gets no ended error")
  replacement.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  replacement.hello()
  await h.flush()
  replacement.ipc("restore-result", { id: ipcOps(replacement, "restore")[0].id, outcome: "unknown" })
  assert.equal(delivered(replacement, CALL(9)), 1)
  assert.deepEqual(h.killed ?? [], [])
})

test("a failed or closed private channel after a restore was sent retires the server at once; before one was sent it only ends the wait", async () => {
  const sendFails = harness({ ipc: true })
  const first = await idleWithFocus(sendFails)
  const next = await resumedAfter(sendFails, first)
  next.sendFails = true
  next.hello()
  await sendFails.flush()
  assert.equal(next.ended, true, "a restore that could not be sent leaves the server unproven")
  assert.equal(delivered(next, PING), 0)

  const closed = harness({ ipc: true })
  const old = await idleWithFocus(closed)
  const second = await resumedAfter(closed, old)
  second.hello()
  second.emit("disconnect")
  await closed.flush()
  assert.equal(second.ended, true)

  const early = harness({ ipc: true })
  const before = await idleWithFocus(early)
  const third = await resumedAfter(early, before)
  third.emit("disconnect")
  await early.flush()
  assert.equal(third.ended, false)
  assert.equal(delivered(third, PING), 1, "no hello can come any more: released, not retired")
})

test("a queued call is delivered once, in order, after a crash during the hold; a forwarded call is answered with one error and never sent again", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const held = await resumedAfter(h, old, CALL(5))
  held.hello()
  await h.host(CALL(6))
  await h.host({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 6 } })
  held.leave(1)
  await h.flush()
  assert.equal(h.sent.filter(Boolean).some((line) => /"id":(5|6)\b/u.test(line)), false, "queued calls get no error")
  const crashed = h.last()
  assert.notEqual(crashed, held)
  crashed.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  crashed.hello()
  await h.flush()
  const request = ipcOps(crashed, "restore")[0]
  assert.equal(request.snapshot, undefined, "the snapshot was consumed by the restore that was sent")
  assert.equal(request.unknown, "server_crashed")
  crashed.ipc("restore-result", { id: request.id, outcome: "unknown" })
  assert.deepEqual(crashed.written.slice(2).map((line) => line.id ?? line.method), [5, 6, "notifications/cancelled"], "original order, once each")
  assert.equal(delivered(held, CALL(5)), 0)
  answer(crashed, 5)
  await h.flush()
  // 7 is forwarded; the server then crashes: it is answered once and never resent.
  await h.host(CALL(7))
  crashed.leave(1)
  await h.flush()
  const errors = h.sees().filter((message) => message.id === 7 && message.error)
  assert.equal(errors.length, 1)
  await h.host(PING)
  const third = h.last()
  assert.notEqual(third, crashed)
  assert.equal(delivered(third, CALL(7)), 0, "a forwarded call is never sent again")
})

test("a restore that was never sent keeps the focus for the server that follows a crash", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const crashing = await resumedAfter(h, old)
  crashing.leave(1)
  await h.flush()
  const next = h.last()
  next.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  next.hello()
  await h.flush()
  const request = ipcOps(next, "restore")[0]
  assert.deepEqual(request.snapshot, SNAPSHOT)
})

test("a crash after a call keeps nothing but the fact that the focus is unknown, and a server that crashes before any call keeps nothing", async () => {
  const h = harness({ ipc: true })
  await handshaken(h)
  h.last().hello()
  await h.host(CALL(2))
  const crashing = h.last()
  crashing.leave(1)
  await h.flush()
  await h.host(PING)
  h.last().say({ jsonrpc: "2.0", id: RESUME, result: {} })
  h.last().hello()
  await h.flush()
  assert.equal(ipcOps(h.last(), "restore")[0].unknown, "server_crashed")

  const none = harness({ ipc: true })
  await handshaken(none)
  none.last().leave(1)
  await none.flush()
  await none.host(PING)
  none.last().say({ jsonrpc: "2.0", id: RESUME, result: {} })
  assert.equal(delivered(none.last(), PING), 1, "nothing to hand over: no wait")
})

test("the host's reply to a request the server made is delivered during the hold, and never to a replacement or a retired server", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const held = await resumedAfter(h, old)
  held.say({ jsonrpc: "2.0", id: "s1", method: "roots/list" })
  held.say({ jsonrpc: "2.0", id: "s2", method: "roots/list" })
  await h.flush()
  held.hello()
  await h.flush()
  await h.host({ jsonrpc: "2.0", id: "s1", result: { roots: [] } })
  assert.equal(delivered(held, { jsonrpc: "2.0", id: "s1", result: { roots: [] } }), 1, "not stranded behind the hold")
  await h.advance(WINDOW)
  assert.equal(held.ended, true)
  held.leave(0)
  await h.flush()
  await h.host({ jsonrpc: "2.0", id: "s2", result: { roots: [] } })
  const replacement = h.last()
  assert.equal(delivered(replacement, { jsonrpc: "2.0", id: "s2", result: { roots: [] } }), 0, "a reply for a retired server is not sent to its replacement")
  replacement.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  replacement.hello()
  await h.flush()
  replacement.ipc("restore-result", { id: ipcOps(replacement, "restore")[0].id, outcome: "unknown" })
  assert.equal(delivered(replacement, { jsonrpc: "2.0", id: "s2", result: { roots: [] } }), 0)
})

test("the idle check that ran out during the hold is armed again when the hold ends, so the server is not kept for ever", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const next = await resumedAfter(h, old)
  next.hello()
  await h.advance(IDLE + 500)
  assert.equal(delivered(next, PING), 0, "still held when the idle time ran out")
  next.ipc("restore-result", { id: ipcOps(next, "restore")[0].id, outcome: "restored" })
  assert.equal(delivered(next, PING), 1)
  assert.equal(next.ended, false, "the idle time ran out during the hold, which does not end a server")
  assert.equal(ipcOps(next, "snapshot").length, 0)
  await h.advance(IDLE)
  assert.equal(ipcOps(next, "snapshot").length, 1, "idle checking resumed after the hold")
})

test("a restore that cannot commit anything, or an answer with an outcome it does not know, never retires the server", async () => {
  const h = harness({ ipc: true })
  await handshaken(h)
  h.last().hello()
  await h.host(CALL(2))
  h.last().leave(1)
  await h.flush()
  await h.host(PING)
  const next = h.last()
  next.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  next.hello()
  await h.advance(WINDOW)
  assert.equal(next.ended, false)
  assert.equal(delivered(next, PING), 1, "a note-only restore is released at its window")
  next.ipc("restore-result", { id: ipcOps(next, "restore")[0].id, outcome: "elsewhere" })
  assert.doesNotMatch(h.stderr.join(""), /elsewhere/u)
})

test("an idle stop where the focus is unknown to the server itself keeps that fact for the next server", async () => {
  const h = harness({ ipc: true })
  const first = await idleWithFocus(h, { declared: false, unknownPrior: true })
  const next = await resumedAfter(h, first)
  next.hello()
  await h.flush()
  assert.equal(ipcOps(next, "restore")[0].unknown, "prior_unknown")
})

test("the host's stream ending during the hold, or a signal, ends the server without waiting for the handoff", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const held = await resumedAfter(h, old)
  h.stdin.emit("end")
  await h.flush()
  assert.equal(held.ended, true)
  held.leave(0)
  await h.flush()
  assert.deepEqual(h.exits, [0])
  assert.equal(h.timers.size, 0)
})

// A generation that cannot hand its focus over still served calls: a capable successor learns the prior focus is unknown, never that there was none.
async function serveAndIdle(h, child) {
  await h.host(CALL(7))
  answer(child, 7)
  await h.flush()
  await h.advance(IDLE)
}

test("a server without the private channel that served a call leaves an unknown focus for a capable replacement", async () => {
  const h = harness({ ipc: (spawn) => spawn > 1 })
  await handshaken(h)
  const old = h.last()
  await serveAndIdle(h, old)
  assert.equal(old.ended, true)
  const next = await resumedAfter(h, old)
  next.hello()
  await h.flush()
  const restore = ipcOps(next, "restore")
  assert.equal(restore.length, 1)
  assert.equal(restore[0].unknown, "child_unsupported")
  assert.equal(restore[0].snapshot, undefined)
})

test("a focus carried across a generation that could not take it is unknown after that generation served calls, and unchanged when it served none", async () => {
  const served = harness({ ipc: (spawn) => spawn !== 2 })
  const first = await idleWithFocus(served)
  const second = await resumedAfter(served, first)
  assert.equal(delivered(second, PING), 1, "an unsupporting server is not waited for")
  await serveAndIdle(served, second)
  const third = await resumedAfter(served, second)
  third.hello()
  await served.flush()
  assert.equal(ipcOps(third, "restore")[0].unknown, "child_unsupported")
  assert.equal(ipcOps(third, "restore")[0].snapshot, undefined)

  const idle = harness({ ipc: (spawn) => spawn !== 2 })
  const one = await idleWithFocus(idle)
  const two = await resumedAfter(idle, one)
  await idle.advance(IDLE)
  const three = await resumedAfter(idle, two)
  three.hello()
  await idle.flush()
  assert.deepEqual(ipcOps(three, "restore")[0].snapshot, SNAPSHOT)
})

test("a server that never said hello leaves the focus unknown, not forgotten, for the next one", async () => {
  const h = harness({ ipc: true })
  const first = await idleWithFocus(h)
  const second = await resumedAfter(h, first)
  await h.advance(WINDOW)
  assert.equal(delivered(second, PING), 1)
  await h.advance(IDLE)
  const third = await resumedAfter(h, second)
  third.hello()
  await h.flush()
  const restore = ipcOps(third, "restore")
  assert.equal(restore[0].unknown, "support_unconfirmed")
  assert.equal(restore[0].snapshot, undefined)
})

test("a snapshot that cannot be asked for or read leaves the focus unknown after served calls, and nothing for a server that served none", async () => {
  for (const fail of ["sendFails", "sendThrows", "disconnect", "malformed"]) {
    const h = harness({ ipc: true })
    await handshaken(h)
    const first = h.last()
    first.hello()
    await h.host(CALL(2))
    answer(first, 2)
    await h.flush()
    if (fail === "sendFails" || fail === "sendThrows") first[fail] = true
    await h.advance(IDLE)
    if (fail === "disconnect") first.emit("disconnect")
    if (fail === "malformed") first.ipc("snapshot-result", { id: ipcOps(first, "snapshot")[0].id, snapshot: {} })
    await h.flush()
    const next = await resumedAfter(h, first)
    next.hello()
    await h.flush()
    assert.equal(ipcOps(next, "restore")[0].unknown, "snapshot_unavailable", fail)
  }
  const h = harness({ ipc: true })
  await handshaken(h)
  const idle = h.last()
  idle.hello()
  await h.advance(IDLE)
  idle.ipc("snapshot-result", { id: ipcOps(idle, "snapshot")[0].id, snapshot: null })
  const next = await resumedAfter(h, idle)
  next.hello()
  await h.flush()
  assert.equal(ipcOps(next, "restore").length, 0)
})

test("a restore request that fails after the hold ended, a timer that fires late, and a disconnect from a replaced server change nothing", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const next = await resumedAfter(h, old)
  next.deferred = []
  next.hello()
  await h.flush()
  const before = h.cleared.length
  next.ipc("restore-result", { id: ipcOps(next, "restore")[0].id, outcome: "weather" })
  assert.equal(delivered(next, PING), 1)
  h.cleared.slice(before).forEach((fn) => fn())
  next.deferred[0](new Error("late"))
  old.emit("disconnect")
  await h.flush()
  assert.equal(next.ended, false)
  assert.equal(delivered(next, PING), 1)
})

test("a late window timer or an answer for an id nobody asked about is dealt with without error", async () => {
  const h = harness({ ipc: true })
  await handshaken(h)
  h.last().hello()
  await h.host({ jsonrpc: "2.0", id: "nobody-asked", result: {} })
  assert.equal(delivered(h.last(), { jsonrpc: "2.0", id: "nobody-asked", result: {} }), 1)
})

test("the record of retired server requests is cleared once it grows past a thousand", async () => {
  const h = harness({ ipc: true })
  const old = await idleWithFocus(h)
  const held = await resumedAfter(h, old)
  for (let i = 0; i < 1001; i += 1) held.say({ jsonrpc: "2.0", id: `r${i}`, method: "roots/list" })
  await h.flush()
  held.hello()
  await h.flush()
  await h.advance(WINDOW)
  held.leave(0)
  await h.flush()
  const second = h.last()
  second.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  second.hello()
  second.say({ jsonrpc: "2.0", id: "x1", method: "roots/list" })
  await h.flush()
  await h.advance(WINDOW)
  second.leave(0)
  await h.flush()
  await h.host({ jsonrpc: "2.0", id: "r5", result: {} })
  const third = h.last()
  third.say({ jsonrpc: "2.0", id: RESUME, result: {} })
  await h.flush()
  await h.advance(WINDOW)
  assert.equal(delivered(third, { jsonrpc: "2.0", id: "r5", result: {} }), 1)
})

test("a snapshot that never arrives times out, a late send failure after the answer changes nothing, and a declared-nothing focus is handed over", async () => {
  const silent = harness({ ipc: true })
  await handshaken(silent)
  const quiet = silent.last()
  quiet.hello()
  await silent.host(CALL(2))
  answer(quiet, 2)
  await silent.flush()
  await silent.advance(IDLE)
  await silent.advance(WINDOW)
  const afterTimeout = await resumedAfter(silent, quiet)
  afterTimeout.hello()
  await silent.flush()
  assert.equal(ipcOps(afterTimeout, "restore")[0].unknown, "snapshot_unavailable")

  const h = harness({ ipc: true })
  await handshaken(h)
  const first = h.last()
  first.hello()
  first.deferred = []
  await h.host(CALL(2))
  answer(first, 2)
  await h.flush()
  await h.advance(IDLE)
  first.ipc("snapshot-result", { id: ipcOps(first, "snapshot")[0].id, snapshot: { declared: true, task: null, scope: "scope-a" } })
  first.deferred.forEach((callback) => callback(new Error("late")))
  const next = await resumedAfter(h, first)
  next.hello()
  await h.flush()
  assert.deepEqual(ipcOps(next, "restore")[0].snapshot, { declared: true, task: null, scope: "scope-a" })
})
