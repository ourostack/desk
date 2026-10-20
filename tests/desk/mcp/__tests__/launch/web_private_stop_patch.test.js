import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import path from "node:path"
import { runInNewContext } from "node:vm"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const { patchSource } = require(path.join(mcpRoot, "web-playwright-patch.cjs"))
const maintainedFixture = require("./fixtures/playwright-native-error-transport.cjs")
const input = maintainedFixture.read()
const maintained = readFileSync(path.resolve(maintainedFixture.cliDirectory(), "../../coreBundle.js"), "utf8")
const stock = readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8") + input.core
const graceful = region(maintained, "async function gracefullyCloseAll(", "\nfunction exitHandler(").trimEnd()
const sha = text => createHash("sha256").update(text).digest("hex")
const flush = () => new Promise(resolve => setImmediate(resolve))
assert.equal(sha(maintained), input.coreSha256, "cleanup helpers come from the same hash-qualified maintained input")

function region(source, start, end) {
  const first = source.indexOf(start)
  assert.notEqual(first, -1)
  assert.equal(source.indexOf(start, first + start.length), -1)
  const last = end ? source.indexOf(end, first) : source.length
  assert.notEqual(last, -1)
  return source.slice(first, last)
}

test("stop scheduling fixture retains the audited daemon, monitor and exit implementations", () => {
  assert.equal(sha(region(stock, "async function monitorSocketPath(", "\nasync function startCliDaemonServer(")),
    "4825ab691d6a37ee02320a678aa16dd443eca90bffbca6184ecb2b98f4664507")
  assert.equal(sha(region(stock, "async function startCliDaemonServer(", "\nasync function saveSessionFile(")),
    "b4b6608dc24505cc41c1ede77e96ae00426cd5ed52dc85652f0b933a399b4543")
  assert.equal(sha(graceful),
    "37aaa3ea12b6b1a1344cc9d7dd68b7e2d019c2e9f9fe0388cba4619ea548cf1d")
})

for (const [name, source] of [
  ["missing monitor", stock.replace("async function monitorSocketPath(", "async function unexpectedMonitor(")],
  ["missing daemon", stock.replace("async function startCliDaemonServer(", "async function unexpectedDaemon(")],
  ["missing daemon boundary", stock.replace("async function saveSessionFile(", "async function unexpectedSave(")],
  ["changed monitor", stock.replace("!currentStat.isSocket()", "!currentStat.isSocket")],
  ["changed daemon", stock.replace("  return socketPath;", "  return null;")],
  ["duplicate monitor", stock + region(stock, "async function monitorSocketPath(", "\nasync function startCliDaemonServer(")],
  ["duplicate daemon", stock + region(stock, "async function startCliDaemonServer(", "\nasync function saveSessionFile(")],
  ["partial stop guard", stock.replace('        if (method === "stop") {',
    '        if (method === "stop") {\n          deskStopInProgress = !!options?.exitOnClose;')],
]) {
  test("unsupported stop custody rejects " + name + " before publishing a generation", () => {
    assert.throws(() => patchSource(source), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  })
}

test("the complete stop repair is idempotent but partial or duplicated guards remain unsupported", () => {
  const patched = patchSource(stock)
  assert.equal(patchSource(patched), patched)
  const monitorStart = "async function monitorSocketPath(", daemonStart = "async function startCliDaemonServer("
  const monitor = region(patched, monitorStart, "\n" + daemonStart)
  const daemon = region(patched, daemonStart, "\nasync function saveSessionFile(")
  for (const source of [
    stock.replace(region(stock, monitorStart, "\n" + daemonStart), monitor),
    stock.replace(region(stock, daemonStart, "\nasync function saveSessionFile("), daemon),
    patched.replace("  let deskStopInProgress = false;", "  let deskStopInProgress = false;\n  let deskStopInProgress = false;"),
    patched.replace("    if (deskStopping?.()) return;", "    if (deskStopping?.()) return;\n    if (deskStopping?.()) return;"),
    patched.replace("  await monitorSocketPath(socketPath, () => deskStopInProgress);",
      "  await monitorSocketPath(socketPath, () => deskStopInProgress);\n  await monitorSocketPath(socketPath, () => deskStopInProgress);"),
    patched.replace("!currentStat.isSocket()", "!currentStat.isSocket"),
  ]) assert.throws(() => patchSource(source), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
})

async function daemon(exitOnClose = true) {
  const events = [], timers = [], context = new EventEmitter(), closes = new Set()
  context.isClosed = () => false
  let accept, connection, socketPresent = false, release
  const cleanup = new Promise(resolve => { release = resolve })
  const close = async () => { events.push("close-start"); await cleanup; events.push("close-end") }
  closes.add(close)
  const promises = {
    async stat() {
      if (!socketPresent) throw Object.assign(new Error("owned socket absent"), { code: "ENOENT" })
      return { dev: 1, ino: 1, isSocket: () => true }
    },
    async unlink() { socketPresent = false },
    async rm() {},
    async mkdir() {},
    async writeFile() {},
  }
  // Qualify the complete composed V4 source first, then execute its exact
  // custody regions at the same controlled resource boundary as the old test.
  // The maintained error fixture deliberately nests these declarations; do not
  // invoke its unrelated backend/program initializers to expose the daemon.
  const patched = patchSource(stock)
  const custody = [
    region(patched, "async function monitorSocketPath(", "\nasync function startCliDaemonServer("),
    region(patched, "async function startCliDaemonServer(", "\nasync function saveSessionFile("),
    region(maintained, "async function saveSessionFile(", "\nfunction formatResult("),
    graceful,
  ].join("\n")
  const api = runInNewContext(`${custody}\n({ startCliDaemonServer })`, {
    process: { platform: "linux", env: {}, exit(code) { events.push("exit:" + code) } },
    setTimeout(callback, delay) {
      const timer = { callback, delay, unref() {} }
      timers.push(timer)
      return timer
    },
    gracefullyCloseSet: closes,
    import_fs67: { default: { promises } },
    import_path63: { default: path },
    import_net10: { default: { createServer(callback) {
      accept = callback
      const server = new EventEmitter()
      server.listen = (_socket, ready) => { socketPresent = true; ready() }
      return server
    } } },
    createSessionConfig: () => ({ name: "owned", socketPath: "owned.sock", cli: { persistent: false } }),
    socketExists: async () => false,
    BrowserBackend: class { async initialize() {} },
    browserTools: [],
    SocketConnection: class {
      constructor() { connection = this }
      async send(message) {
        assert.equal(message.id, 41)
        assert.equal(message.result, "ok")
        events.push("ack-callback")
      }
    },
    AbortController,
    decorateServer() {},
  })
  await api.startCliDaemonServer("owned", context, {}, {}, { daemonProfilesDir: "owned" }, {}, { exitOnClose })
  accept({})
  return {
    events, release,
    stop: () => connection.onmessage({ id: 41, method: "stop", params: {} }),
    retireBrowserProcess() { closes.delete(close) },
    contextClosed() { context.emit("close") },
    loseSocket() { socketPresent = false },
    monitorSocket() { timers.find(timer => timer.delay === 1000).callback() },
  }
}

for (const competitor of ["context-close", "socket-monitor", "both"]) {
  test("explicit stop retains ACK callback custody against " + competitor, async () => {
    const session = await daemon()
    try {
      await session.stop()
      // The maintained launcher removes its close entry on process exit before
      // asynchronous cleanup finishes. A second exit path can now settle first.
      session.retireBrowserProcess()
      if (competitor !== "socket-monitor") session.contextClosed()
      if (competitor !== "context-close") session.monitorSocket()
      await flush()
      assert.deepEqual([...session.events], ["close-start"], "a competing exit must not outrun the stop owner")
      session.release()
      await flush()
      assert.deepEqual(session.events, ["close-start", "close-end", "ack-callback", "exit:0"])
    } finally {
      session.release()
      await flush()
    }
  })
}

test("unsolicited context closure retains its normal exit without a fabricated ACK", async () => {
  const session = await daemon()
  session.retireBrowserProcess()
  session.contextClosed()
  await flush()
  assert.deepEqual(session.events, ["exit:0"])
  session.release()
})

test("an unsolicited lost socket retains its normal exit without a fabricated ACK", async () => {
  const session = await daemon()
  session.retireBrowserProcess()
  session.loseSocket()
  session.monitorSocket()
  await flush()
  assert.ok(session.events.includes("exit:0"))
  assert.equal(session.events.includes("ack-callback"), false)
  session.release()
})

test("non-exiting stop preserves its direct ACK and does not begin process shutdown", async () => {
  const session = await daemon(false)
  await session.stop()
  await flush()
  assert.deepEqual(session.events, ["ack-callback"])
  session.release()
})
