import test from "node:test"
import assert from "node:assert/strict"
import { PassThrough } from "node:stream"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import path from "node:path"
import { mcpRoot } from "./_mcp_handshake.js"
const require = createRequire(import.meta.url)
const proxy = require(path.join(mcpRoot, "web-proxy.cjs"))

async function controlledProxy(t, options = {}) {
  const stdin = new PassThrough(), stdout = new PassThrough()
  const children = [], messages = [], errors = [], kills = []
  let api, nextId = 2
  const launch = { node: process.execPath, indexFile: "/fixture", args: [], env: {}, secrets: [] }
  stdout.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(JSON.parse(line))
  })
  const running = proxy.serve({
    stdin, stdout, stderr: { write: text => errors.push(text) }, signals: new EventEmitter(), catalog: [],
    closeMs: 20, holdMs: 100, cleanupMs: 50, exit: () => {}, kill: (pid, signal) => kills.push({ pid, signal }),
    ready: Promise.resolve({ launch }), spawnPayload: error => ({ code: error.message }), exitPayload: () => ({ code: "fixture-exited" }),
    ...options,
    beforeCall: (params, current, operation) => {
      api = current
      return options.beforeCall ? options.beforeCall(params, current, operation) : Promise.resolve(null)
    },
    spawn: () => {
      if (options.spawnError && children.length) throw new Error("fixture-spawn-refused")
      const child = new EventEmitter()
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
      child.pid = 90000 + children.length; child.operations = []; child.received = []
      child.stdin.on("data", chunk => {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const message = JSON.parse(line)
          child.received.push(message)
          if (message.method === "tools/call") child.operations.push(message)
          if (message.id === undefined || (options.silentReplacement && children.length > 1) ||
              (options.holdTools && message.method === "tools/call")) continue
          const result = message.method === "initialize" ? { capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
            : message.method === "tools/list" ? { tools: [] } : { content: [] }
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
        }
      })
      child.stdin.on("end", () => {
        if (!options.holdExit) setImmediate(() => child.emit("exit", 0, null))
      })
      child.kill = signal => { child.killed = signal; child.emit("exit", 0, signal) }
      children.push(child)
      return child
    },
  })
  async function wait(predicate) {
    for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    throw new Error("controlled proxy wait timed out")
  }
  function send(id, method, params) { stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n") }
  send(1, "initialize", {})
  await wait(() => children.length && children[0].operations.length === 0)
  send(nextId++, "tools/call", { name: "browser_snapshot", arguments: {} })
  await wait(() => api)
  t.after(async () => {
    stdin.end()
    for (const child of children) child.emit("exit", 0, null)
    await running
  })
  return { stdin, children, messages, errors, kills, launch, wait, send, api: () => api, running }
}

test("pending native calls time out conservatively and block MCP replacement", async t => {
  const fixture = await controlledProxy(t, { holdTools: true })
  await fixture.wait(() => fixture.children[0].operations.length)
  fixture.send(3, "tools/call", { name: "browser_snapshot", arguments: {} })
  await fixture.wait(() => fixture.children[0].operations.length === 2)
  await assert.rejects(fixture.api().waitForPendingCalls(10), error => error.code === "browser_operations_pending")
  await assert.rejects(fixture.api().restartChild(fixture.launch), /browser_operations_pending/u)
  const own = fixture.api().callTool("browser_snapshot", {}, 10)
  await assert.rejects(own, /timed out/u)
})

test("MCP replacement failure never declares an unconfirmed detach or handshake ready", async t => {
  const fixture = await controlledProxy(t, { holdExit: true })
  await fixture.wait(() => fixture.messages.some(message => message.id === 2))
  const replacing = fixture.api().restartChild(fixture.launch)
  assert.equal(fixture.api().restartChild(fixture.launch), replacing)
  await assert.rejects(replacing, /browser_client_detach_unconfirmed/u)
  assert.equal(fixture.children[0].killed, "SIGTERM")
})

test("silent replacement handshake and spawn refusal are explicit failures", async t => {
  const silent = await controlledProxy(t, { silentReplacement: true })
  await silent.wait(() => silent.messages.some(message => message.id === 2))
  await assert.rejects(silent.api().restartChild(silent.launch), /browser_client_handshake_unconfirmed/u)
  const spawning = await controlledProxy(t, { spawnError: true })
  await spawning.wait(() => spawning.messages.some(message => message.id === 2))
  await assert.rejects(spawning.api().restartChild(spawning.launch), /fixture-spawn-refused/u)
})

test("replacement child exit before handshake reports uncertainty without replay", async t => {
  const fixture = await controlledProxy(t, { silentReplacement: true })
  await fixture.wait(() => fixture.messages.some(message => message.id === 2))
  const replacing = fixture.api().restartChild(fixture.launch)
  await fixture.wait(() => fixture.children.length === 2)
  fixture.children[1].emit("exit", 1, null)
  await assert.rejects(replacing, /browser_client_exited/u)
  assert.equal(fixture.children[1].operations.length, 0)
})

test("native cleanup rejection is surfaced even when no MCP child can start", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(), errors = []
  stdout.resume()
  const running = proxy.serve({
    stdin, stdout, stderr: { write: text => errors.push(text) }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fixture", args: [], env: {} } }),
    onInitialize: async () => { throw new Error("acquisition-refused") },
    cleanupBeforeReady: true,
    cleanup: async () => { throw new Error("cleanup-refused") },
    spawnPayload: error => ({ code: error.message }),
    spawn: () => assert.fail("refused owner acquisition cannot launch"),
  })
  stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 10))
  stdin.end()
  await running
  assert.ok(errors.join("").includes("browser_cleanup_incomplete"))
})

test("rejected owner initialization still runs exact pre-child cleanup when shutdown began first", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(), errors = []
  stdout.resume()
  let reject, cleanups = 0
  const pending = new Promise((resolve, refusal) => { reject = refusal })
  const running = proxy.serve({
    stdin, stdout, stderr: { write: text => errors.push(text) }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fixture", args: [], env: {} } }),
    onInitialize: () => pending,
    cleanupBeforeReady: true, cleanup: async () => { cleanups++ },
    spawnPayload: error => ({ code: error.message }),
    spawn: () => assert.fail("closed owner initialization cannot launch"),
  })
  stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 10))
  stdin.end()
  reject(new Error("late-acquisition-refused"))
  await running
  assert.equal(cleanups, 1)
})

test("replacement handshake refusal and runtime child errors remain observable", async t => {
  const fixture = await controlledProxy(t, { silentReplacement: true })
  await fixture.wait(() => fixture.messages.some(message => message.id === 2))
  fixture.children[0].emit("error", new Error("known-running-child-error"))
  assert.ok(fixture.errors.join("").includes("known-running-child-error"))
  const replacing = fixture.api().restartChild(fixture.launch)
  await fixture.wait(() => fixture.children.length === 2)
  const child = fixture.children[1]
  const handshake = child.received.find(message => message.method === "initialize")
  child.stdout.write(JSON.stringify({ id: handshake.id, error: { message: "replacement-handshake-refused" } }) + "\n")
  child.emit("error", new Error("replacement-running-error"))
  await assert.rejects(replacing, /replacement-handshake-refused/u)
  assert.ok(fixture.errors.join("").includes("replacement-running-error"))
})

test("a child that never obtained a PID triggers exact cleanup rather than being treated as running", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough()
  stdout.resume()
  const child = new EventEmitter()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  let cleanups = 0
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fixture", args: [], env: {} } }),
    cleanupBeforeReady: true, cleanup: async () => { cleanups++ },
    spawnPayload: error => ({ code: error.message }),
    spawn: () => { setImmediate(() => child.emit("error", new Error("spawn-no-pid"))); return child },
  })
  stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 10))
  stdin.end()
  await running
  assert.ok(cleanups >= 1)
})

  test("prepared work waits for the replacement handshake rather than dispatching to a detached child", async t => {
    let finish
    const fixture = await controlledProxy(t, {
      silentReplacement: true,
      beforeCall: () => new Promise(resolve => { finish = resolve }),
    })
    const replacing = fixture.api().restartChild(fixture.launch)
    await fixture.wait(() => fixture.children.length === 2)
    finish(null)
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(fixture.children[1].operations.length, 0)
    const child = fixture.children[1]
    const handshake = child.received.find(message => message.method === "initialize")
    child.stdout.write(JSON.stringify({ id: handshake.id, result: { capabilities: {}, serverInfo: { name: "replacement", version: "1" } } }) + "\n")
    await replacing
    await fixture.wait(() => child.operations.length === 1)
    assert.equal(child.operations[0].params.name, "browser_snapshot")
  })

  test("native cleanup runs after an initial synchronous spawn failure and stop cancels prepared work", async t => {
    let cleanups = 0, finish
    const fixture = await controlledProxy(t, {
      beforeCall: () => new Promise(resolve => { finish = resolve }),
      afterCall: (params, failed) => { assert.equal(failed, true); cleanups++ },
    })
    fixture.stdin.end()
    await new Promise(setImmediate)
    finish(null)
    await fixture.running
    assert.equal(cleanups, 1)
    let failCleanups = 0
    const stdin = new PassThrough(), stdout = new PassThrough()
    stdout.resume()
    const running = proxy.serve({
      stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
      ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fixture", args: [], env: {} } }),
      spawn: () => { throw new Error("cold-spawn-refused") },
      spawnPayload: error => ({ code: error.message }),
      cleanupBeforeReady: true, cleanup: async () => { failCleanups++ },
    })
    stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n")
    await new Promise(resolve => setTimeout(resolve, 10))
    stdin.end(); await running
    assert.ok(failCleanups > 0)
  })

  test("known-child cleanup error and invalid catalog results cannot become silent success", async t => {
    const fixture = await controlledProxy(t, {
      cleanup: async () => { throw new Error("exact-cleanup-failed") },
      afterCall: (params, failed) => assert.equal(failed, false),
    })
    await fixture.wait(() => fixture.messages.some(message => message.id === 2))
    const list = fixture.children[0].received.find(message => message.method === "tools/list")
    fixture.children[0].stdout.write(JSON.stringify({ id: list.id, result: {} }) + "\n")
    fixture.stdin.end()
    await fixture.running
    assert.ok(fixture.errors.join("").includes("browser_cleanup_incomplete"))
  })
test("async native owner initialization must finish before MCP child spawn", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  let finish
  const initialized = new Promise(resolve => { finish = resolve })
  let spawns = 0
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    onInitialize: async launch => {
      await initialized
      launch.args.push("--cdp-endpoint", "private-ready")
    },
    spawn: (_file, args) => {
      spawns++
      assert.ok(args.includes("private-ready"))
      throw new Error("test child launch refused")
    },
    spawnPayload: () => ({ code: "test-refused" }),
  })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "owner" } } }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawns, 0, "native acquisition may not race MCP attachment")
  finish()
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(spawns, 1)
  stdin.end()
  await running
})

test("native shutdown during initialization waits for exact pre-child cleanup", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  let finish
  const initialized = new Promise(resolve => { finish = resolve })
  let cleanups = 0
  let finished = false
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    onInitialize: () => initialized,
    cleanupBeforeReady: true,
    cleanup: async () => { cleanups++ },
    spawn: () => { throw new Error("closed initialization must never spawn") },
    spawnPayload: () => ({ code: "test-refused" }),
  }).then(() => { finished = true })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", clientInfo: { name: "owner" } } }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 10))
  stdin.end()
  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(finished, false)
  finish()
  await running
  assert.equal(cleanups, 1)
})

test("native close waits for the exact forwarded operation before clearing owned targets", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 90000
  let pending
  let received
  const inFlight = new Promise(resolve => { received = resolve })
  let cleared = 0
  let closedReply
  const replied = new Promise(resolve => { closedReply = resolve })
  child.stdin.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) {
      const message = JSON.parse(line)
      if (message.method === "initialize") child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { capabilities: {}, serverInfo: { name: "fixture", version: "1" } } }) + "\n")
      else if (message.method === "tools/call") { pending = message; received() }
    }
  })
  stdout.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) if (JSON.parse(line).id === 3) closedReply()
  })
  child.stdin.on("end", () => child.emit("exit", 0, null))
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    spawn: () => child, exit: () => {}, kill: () => {},
    spawnPayload: () => ({ code: "test-refused" }), exitPayload: () => ({ code: "fixture-exited" }),
    beforeCall: (params, api) => params.name !== "browser_close" ? Promise.resolve(null) :
      api.waitForPendingCalls(1000).then(() => {
        cleared++
        return { content: [{ type: "text", text: "closed" }] }
      }),
  })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n")
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } }) + "\n")
  await inFlight
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_close", arguments: {} } }) + "\n")
  await new Promise(setImmediate)
  assert.equal(cleared, 0)
  child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: pending.id, result: { content: [] } }) + "\n")
  await replied
  assert.equal(cleared, 1)
  stdin.end()
  await running
})

test("a native MCP child that exits before handshake still cleans its acquired backend", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  stdout.resume()
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.pid = 90000
  let cleanups = 0
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fake", args: [], env: {}, secrets: [] } }),
    cleanupBeforeReady: true,
    cleanup: async api => { assert.equal(api.childReady(), false); cleanups++ },
    spawn: () => { setImmediate(() => child.emit("exit", 1, null)); return child },
    exitPayload: () => ({ code: "fixture-exited" }), spawnPayload: () => ({ code: "test-refused" }),
  })
  stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(cleanups, 1)
  stdin.end()
  await running
})

test("native transport replacement reinitializes only the MCP child before the next new call", async () => {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const messages = []
  const launches = []
  const userCalls = []
  let cleanupCount = 0
  stdout.on("data", chunk => {
    for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(JSON.parse(line))
  })
  const initial = { node: process.execPath, indexFile: "/fixture", args: ["original-endpoint"], env: {}, secrets: [] }
  const replacement = { ...initial, args: ["restored-endpoint"] }
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: initial }),
    closeMs: 100, holdMs: 1000, exit: () => {}, kill: () => {},
    cleanup: async () => { cleanupCount++ },
    spawnPayload: error => ({ code: error.code ?? "fixture-failed" }), exitPayload: () => ({ code: "fixture-ended" }),
    beforeCall: async (params, api) => {
      if (params.name === "browser_snapshot") await api.restartChild(replacement)
      return null
    },
    spawn: (_file, args) => {
      const child = new EventEmitter()
      child.stdin = new PassThrough()
      child.stdout = new PassThrough()
      child.stderr = new PassThrough()
      child.pid = 90000 + launches.length
      const generation = launches.length
      launches.push(args)
      child.stdin.on("data", chunk => {
        for (const line of String(chunk).split("\n").filter(Boolean)) {
          const message = JSON.parse(line)
          if (!message.id) continue
          let result
          if (message.method === "initialize") result = { capabilities: {}, serverInfo: { name: "fixture", version: "1" } }
          else if (message.method === "tools/list") result = { tools: [] }
          else {
            userCalls.push({ generation, name: message.params.name })
            result = { content: [{ type: "text", text: "owned result" }] }
          }
          child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n")
        }
      })
      child.stdin.on("end", () => setImmediate(() => child.emit("exit", 0, null)))
      child.kill = () => child.emit("exit", 0, null)
      return child
    },
  })
  async function ask(id, name) {
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: {} } }) + "\n")
    for (let attempt = 0; attempt < 100; attempt++) {
      const response = messages.find(message => message.id === id)
      if (response) return response
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    throw new Error("fixture response timed out")
  }
  try {
    assert.equal((await ask(2, "browser_navigate")).result.isError, undefined)
    assert.equal((await ask(3, "browser_snapshot")).result.isError, undefined)
    assert.deepEqual(userCalls, [{ generation: 0, name: "browser_navigate" }, { generation: 1, name: "browser_snapshot" }])
    assert.equal(launches.length, 2)
    assert.ok(launches[1].includes("restored-endpoint"))
    assert.equal(cleanupCount, 0, "transport replacement must not release browser-side ownership")
  } finally {
    stdin.end()
    await running
  }
  assert.equal(cleanupCount, 1)
})

test("mapped native replies preserve errors and pending internal calls fail when their exact child exits", async t => {
  const fixture = await controlledProxy(t, {
    mapResult: () => ({ content: [{ type: "text", text: "mapped exact result" }], isError: true }),
    afterCall: (params, failed) => assert.equal(failed, true),
  })
  await fixture.wait(() => fixture.messages.some(message => message.id === 2))
  assert.equal(fixture.messages.find(message => message.id === 2).result.content[0].text, "mapped exact result")
  const child = fixture.children[0]
  child.stdin.removeAllListeners("data")
  const pending = fixture.api().callTool("browser_snapshot", {}, 100)
  child.emit("exit", 1, null)
  await assert.rejects(pending, /the browser ended/u)
})

test("shutdown during MCP replacement refuses a new child after the old child exits", async t => {
  const fixture = await controlledProxy(t, { holdExit: true })
  await fixture.wait(() => fixture.messages.some(message => message.id === 2))
  const replacing = fixture.api().restartChild(fixture.launch)
  fixture.stdin.end()
  await new Promise(setImmediate)
  fixture.children[0].emit("exit", 0, null)
  await assert.rejects(replacing, /browser_session_closed/u)
  assert.equal(fixture.children.length, 1)
})

test("cancellation of held startup work removes it before browser preparation", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(), messages = []
  let ready
  stdout.on("data", bytes => messages.push(String(bytes)))
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: new Promise(resolve => { ready = resolve }), holdMs: 50,
    timeoutPayload: { code: "startup-timeout" }, spawn: () => assert.fail("closed cancelled startup cannot spawn"),
  })
  stdin.write(JSON.stringify({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } }) + "\n")
  stdin.write(JSON.stringify({ method: "notifications/cancelled", params: { requestId: 2 } }) + "\n")
  stdin.end()
  ready({ payload: { code: "closed-startup" } })
  await running
  assert.equal(messages.some(text => text.includes('"id":2')), false)
})

test("a no-PID child error after host shutdown settles without requiring an unavailable cleanup hook", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(), child = new EventEmitter()
  stdout.resume()
  child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough()
  const running = proxy.serve({
    stdin, stdout, stderr: { write() {} }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "/fixture", args: [], env: {} } }),
    spawnPayload: error => ({ code: error.message }), spawn: () => child,
  })
  stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 5))
  stdin.end()
  await new Promise(setImmediate)
  child.emit("error", new Error("no-pid-after-close"))
  await running
})

test("MCP replacement cannot create a new client after the original spawn failed", async () => {
  const stdin = new PassThrough(), stdout = new PassThrough(), errors = []
  stdout.resume()
  let spawns = 0
  const launch = { node: process.execPath, indexFile: "/fixture", args: [], env: {} }
  const running = proxy.serve({
    stdin, stdout, stderr: { write: value => errors.push(value) }, signals: new EventEmitter(), catalog: [],
    ready: Promise.resolve({ launch }), cleanupBeforeReady: true,
    spawn: () => { spawns++; throw new Error("original-spawn-failed") },
    spawnPayload: error => ({ code: error.message }),
    cleanup: async api => {
      await assert.rejects(api.restartChild(launch), /browser_operations_pending/u)
    },
  })
  stdin.write(JSON.stringify({ id: 1, method: "initialize", params: {} }) + "\n")
  await new Promise(resolve => setTimeout(resolve, 20))
  stdin.end(); await running
  assert.equal(spawns, 1, "transport replacement must not become an implicit initial-launch retry")
  assert.equal(errors.some(value => value.includes("browser_cleanup_incomplete")), false)
})
