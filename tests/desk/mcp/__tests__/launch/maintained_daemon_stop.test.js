import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { createHash } from "node:crypto"
import { EventEmitter } from "node:events"
import { createRequire } from "node:module"
import vm from "node:vm"
import net from "node:net"
import { once } from "node:events"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const input = require("./fixtures/playwright-native-error-transport.cjs")
const cli = input.cliDirectory()
const original = fs.readFileSync(path.resolve(cli, "../../coreBundle.js"), "utf8")
assert.equal(createHash("sha256").update(original).digest("hex"), input.read().coreSha256)
const patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"))
const { SocketConnection } = require(path.resolve(cli, "../utils/socketConnection.js"))

function region(source, begin, end) {
  const start = source.indexOf(begin), finish = source.indexOf(end, start)
  assert.ok(start >= 0 && finish > start && source.indexOf(begin, start + begin.length) === -1)
  return source.slice(start, finish)
}
const graceful = region(original, "function gracefullyProcessExitDoNotHang(", "\nfunction exitHandler(")
assert.equal(createHash("sha256").update(graceful).digest("hex"),
  "208938d7e18dde63b36ad57ae50a44b4017d948e5ff3f0f47a627a840d834065")

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve))
}

async function daemon(source, { cause, exitOnClose = true, stalledWrite = false, pendingStat = false } = {}) {
  const monitor = region(source, "async function monitorSocketPath(", "\nasync function startCliDaemonServer(")
  const start = region(source, "async function startCliDaemonServer(", "\nasync function saveSessionFile(")
  const context = new EventEmitter(), server = new EventEmitter(), socket = new EventEmitter()
  const monitorTimers = [], exitTimers = [], acknowledgements = [], exits = []
  let accept, releaseCleanup, releaseStat, pendingWrite, closeCalls = 0, statReads = 0, present = true, exited = false
  const cleanup = new Promise(resolve => { releaseCleanup = resolve })
  const observedStat = new Promise(resolve => { releaseStat = resolve })
  const socketStat = { dev: 1n, ino: 2n, isSocket: () => true }
  context.isClosed = () => false
  server.listen = (_path, ready) => ready()
  socket.write = (bytes, callback) => {
    if (exited) callback(new Error("owned process already exited"))
    else if (stalledWrite) pendingWrite = callback
    else { acknowledgements.push(JSON.parse(String(bytes))); callback() }
    return true
  }
  const startDaemon = vm.runInNewContext(monitor + "\n" + graceful + "\n" + start + "\nstartCliDaemonServer", {
    process: { platform: "linux", exit(code) { if (!exited) exits.push(code); exited = true } },
    AbortController, SocketConnection,
    BrowserBackend: class { async initialize() {} },
    browserTools: [],
    createSessionConfig: () => ({ socketPath: "/owned-daemon.sock" }),
    socketExists: async () => false,
    import_net10: { default: { createServer(callback) { accept = callback; return server } } },
    import_fs67: { default: { promises: { async stat() {
      if (++statReads === 2 && pendingStat) return observedStat
      if (!present) throw Object.assign(new Error("owned socket absent"), { code: "ENOENT" })
      return socketStat
    } } } },
    decorateServer() {},
    saveSessionFile: async () => {},
    deleteSessionFile: async () => { present = false },
    gracefullyCloseAll() {
      closeCalls++
      if (closeCalls === 1) {
        if (cause === "context-close") context.emit("close")
        return cleanup
      }
      return Promise.resolve()
    },
    setTimeout(callback, milliseconds) {
      assert.ok(milliseconds === 1000 || milliseconds === 30000, "only the two unchanged maintained timers")
      const timer = { callback, unref() {} }
      ;(milliseconds === 1000 ? monitorTimers : exitTimers).push(timer)
      return timer
    },
  })
  await startDaemon("owned", context, {}, {}, {}, {}, { exitOnClose })
  accept(socket)
  return {
    acknowledgements, exits, monitorTimers, exitTimers,
    async stop() {
      socket.emit("data", Buffer.from(JSON.stringify({ id: 17, method: "stop", params: {} }) + "\n"))
      await flush()
    },
    async monitor() {
      assert.ok(monitorTimers.length, "actual maintained monitor scheduled a check")
      monitorTimers.shift().callback()
      await flush()
    },
    async contextClosed() { context.emit("close"); await flush() },
    removeSocket() { present = false },
    async release() { releaseCleanup(); await flush() },
    async releaseStat() { releaseStat(undefined); await flush() },
    async peerClosed() {
      assert.equal(typeof pendingWrite, "function", "the actual SocketConnection is waiting for its write callback")
      pendingWrite(new Error("owned peer closed during write"))
      socket.emit("close")
      await flush()
    },
    close() {
      releaseCleanup()
      releaseStat(undefined)
      socket.removeAllListeners()
      context.removeAllListeners()
      server.removeAllListeners()
      monitorTimers.length = 0
      exitTimers.length = 0
    },
  }
}

for (const cause of ["context-close", "socket-monitor"]) {
  test(`unpatched maintained ${cause} can exit before the stop acknowledgement`, async t => {
    const f = await daemon(original, { cause })
    t.after(() => f.close())
    await f.stop()
    if (cause === "socket-monitor") await f.monitor()
    assert.deepEqual(f.exits, [0])
    assert.deepEqual(f.acknowledgements, [])
    await f.release()
    assert.deepEqual(f.acknowledgements, [], "a dead daemon cannot deliver its later callback")
  })

  test(`qualified maintained stop owns the acknowledgement across ${cause}`, async t => {
    const f = await daemon(patch.patchSource(original), { cause })
    t.after(() => f.close())
    await f.stop()
    if (cause === "socket-monitor") await f.monitor()
    assert.deepEqual(f.exits, [], "no competing exit before the explicit stop finishes cleanup")
    assert.deepEqual(f.acknowledgements, [])
    await f.release()
    assert.deepEqual(f.acknowledgements, [{ id: 17, result: "ok" }])
    assert.deepEqual(f.exits, [0])
  })
}

test("a monitor already awaiting its socket observation rechecks explicit stop before exiting", async t => {
  const f = await daemon(patch.patchSource(original), { pendingStat: true })
  t.after(() => f.close())
  await f.monitor()
  await f.stop()
  await f.releaseStat()
  assert.deepEqual(f.exits, [], "an observation begun before stop must not authorize an exit after stop")
  await f.release()
  assert.deepEqual(f.acknowledgements, [{ id: 17, result: "ok" }])
  assert.deepEqual(f.exits, [0])
})

test("natural context close retains the maintained exit without inventing a stop acknowledgement", async t => {
  const f = await daemon(patch.patchSource(original))
  t.after(() => f.close())
  await f.contextClosed()
  await f.release()
  assert.deepEqual(f.exits, [0])
  assert.deepEqual(f.acknowledgements, [])
})

test("natural socket loss retains the maintained exit without an explicit stop", async t => {
  const f = await daemon(patch.patchSource(original))
  t.after(() => f.close())
  f.removeSocket()
  await f.monitor()
  await f.release()
  assert.deepEqual(f.exits, [0])
  assert.deepEqual(f.acknowledgements, [])
})

test("embedded stop retains its immediate acknowledgement and ordinary socket-loss monitor", async t => {
  const f = await daemon(patch.patchSource(original), { exitOnClose: false })
  t.after(() => f.close())
  await f.stop()
  assert.deepEqual(f.acknowledgements, [{ id: 17, result: "ok" }])
  assert.deepEqual(f.exits, [])
  await f.monitor()
  await f.release()
  assert.deepEqual(f.exits, [0])
})

test("a stalled stop write exits after the bounded caller closes its peer, never fabricating an acknowledgement", async t => {
  const f = await daemon(patch.patchSource(original), { stalledWrite: true })
  t.after(() => f.close())
  await f.stop()
  await f.release()
  assert.deepEqual(f.exits, [])
  assert.deepEqual(f.acknowledgements, [])
  await f.peerClosed()
  assert.deepEqual(f.exits, [0])
  assert.deepEqual(f.acknowledgements, [])
})

test("actual maintained SocketConnection settles a backpressured write when its real loopback peer closes", {
  timeout: 10000,
}, async t => {
  let accepted, peer, socket, connection
  const ready = new Promise(resolve => { accepted = resolve })
  const server = net.createServer(value => { socket = value; accepted(value) })
  t.after(async () => {
    connection?.close()
    socket?.destroy()
    peer?.destroy()
    if (server.listening) await new Promise(resolve => server.close(resolve))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")
  peer = net.createConnection(server.address().port, "127.0.0.1")
  peer.on("error", () => {})
  await once(peer, "connect")
  peer.pause()
  await ready
  socket.on("error", () => {})
  connection = new SocketConnection(socket)
  const filler = Buffer.alloc(8 * 1024 * 1024)
  assert.equal(socket.write(filler, () => {}), false, "bounded owned bytes create actual transport backpressure")
  let settled = false
  const outcome = connection.send({ id: 17, result: "ok" }).then(
    () => { settled = true; return { success: true } },
    error => { settled = true; return { error } },
  )
  await flush()
  assert.equal(settled, false, "the actual ACK write is pending while the owned peer does not read")
  peer.destroy()
  const result = await outcome
  assert.ok(result.error instanceof Error, "peer close settles the actual pending write as failure, never a receipt")
})

test("stop qualification rejects partial suppression and arbitrary monitor or daemon changes", () => {
  const current = patch.patchSource(original)
  assert.equal(patch.patchSource(current), current)
  for (const [before, after] of [
    ["async function monitorSocketPath(socketPath, deskStopping) {", "async function monitorSocketPath(socketPath) {"],
    ["    if (deskStopping?.()) return;\n", ""],
    ["  let deskStopInProgress = false;\n", ""],
    ["          deskStopInProgress = !!options?.exitOnClose;\n", ""],
    ["    if (options?.exitOnClose && !deskStopInProgress)\n", "    if (options?.exitOnClose)\n"],
    ["  await monitorSocketPath(socketPath, () => deskStopInProgress);", "  await monitorSocketPath(socketPath);"],
    ["    if (deskStopping?.()) return;", "    if (deskStopping) return;"],
    ["          deskStopInProgress = !!options?.exitOnClose;", "          deskStopInProgress = true;"],
  ]) {
    const changed = current.replace(before, after)
    assert.notEqual(changed, current, before)
    assert.throws(() => patch.patchSource(changed), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  }
})
