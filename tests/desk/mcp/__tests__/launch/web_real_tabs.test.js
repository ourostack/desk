// The real-browser tab cleanup (mcp/web-real-tabs.cjs): stock Playwright MCP runs in extension mode, the stock extension groups a connection's tabs but leaves them open when the connection ends, and the watchdog closes them. These tests never start a browser: the extension and Playwright's relay are WebSocket stand-ins, and the "browser" is a recorder (in process) or a script that records its arguments (end to end).

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const tabs = require(path.join(mcpRoot, "web-real-tabs.cjs"))
const RUNNER = path.join(mcpRoot, "web-real-tabs.cjs")
const CONNECT_PAGE = "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/connect.html"
const TOKEN = "tok-9f3a-never-print-me"
// The broker's own dependency, installed in CI before this suite runs; Desk installs the same package beside Playwright MCP.
const WS_DIR = path.join(mcpRoot, "..", "browser-context-broker", "node_modules", "ws")
const WebSocket = existsSync(WS_DIR) ? require(WS_DIR) : null
const withWs = { skip: WebSocket ? false : "ws is not installed" }
const posixWithWs = { skip: process.platform === "win32" ? "the stand-in browser is a POSIX script" : withWs.skip }

const wait = async (check, what, ms = 10000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const found = check()
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`timed out waiting for ${what}`)
}

const connectPage = (relay) => `${CONNECT_PAGE}?mcpRelayUrl=${encodeURIComponent(relay)}&client=%7B%7D&protocolVersion=2&token=${TOKEN}`

// ---- the runner ----

function fakeProcess(env) {
  const out = []
  const stream = () => ({ write: (chunk) => { out.push(chunk); return true } })
  return { out, proc: { argv: ["/node", "/runner"], env, execPath: "/node", stdout: stream(), stderr: stream() } }
}

test("the runner routes only the connect-page launch through the watchdog, passes the rest on, and starts Playwright MCP with its own arguments", () => {
  const spawns = []
  const cp = { spawn: function (file, args, options) { spawns.push({ self: this, file, args, options }); return "child" } }
  const { proc, out } = fakeProcess({ PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN })
  const loaded = []
  tabs.run(["pw/cli.js", "--extension", "--browser", "msedge"], { process: proc, childProcess: cp, load: (cli) => {
    loaded.push(cli)
    assert.equal(cp.spawn("/edge", ["--profile-directory=Default", connectPage("ws://127.0.0.1:1/extension/a")], { detached: true }), "child")
    cp.spawn("/other", ["https://example.com"], { stdio: "ignore" })
    cp.spawn("/other", [])
    proc.stdout.write(`Page URL: ${connectPage("ws://x")}\n`)
    proc.stderr.write(Buffer.from(`token ${TOKEN}\n`))
    proc.stdout.write(new Uint8Array([65]))
  } })
  const cli = path.resolve("pw/cli.js")
  assert.deepEqual(loaded, [cli])
  assert.deepEqual(proc.argv, ["/node", cli, "--extension", "--browser", "msedge"])
  assert.deepEqual(spawns.map(({ file, args, options }) => ({ file, args, options })), [
    { file: "/node", args: [RUNNER, "--watch", cli, "/edge", "--profile-directory=Default", connectPage("ws://127.0.0.1:1/extension/a")], options: { detached: true } },
    { file: "/other", args: ["https://example.com"], options: { stdio: "ignore" } },
    { file: "/other", args: [], options: undefined },
  ])
  assert.ok(spawns.every((call) => call.self === cp))
  assert.equal(out[0], `Page URL: ${connectPage("ws://x").replace(TOKEN, "<token>")}\n`)
  assert.equal(out[1], "token <token>\n")
  assert.deepEqual(out[2], new Uint8Array([65]))
})

test("without a token the runner leaves the output streams alone", () => {
  const { proc } = fakeProcess({})
  const write = proc.stdout.write
  tabs.run(["cli.js"], { process: proc, childProcess: { spawn() {} }, load: () => {} })
  assert.equal(proc.stdout.write, write)
})

// ---- the watchdog, in process ----

/** Playwright's relay stand-in. `delayMs` holds each upgrade, so the watchdog's link to it is still connecting for a while. */
async function relay(delayMs = 0) {
  const server = new WebSocket.Server({ host: "127.0.0.1", port: 0, path: "/extension/abc", verifyClient: (info, done) => setTimeout(() => done(true), delayMs) })
  await new Promise((resolve) => server.on("listening", resolve))
  const state = { socket: null, received: [], closed: false }
  server.on("connection", (socket) => {
    state.socket = socket
    socket.on("message", (data) => state.received.push(String(data)))
    socket.on("close", () => { state.closed = true })
  })
  return { server, state, url: `ws://127.0.0.1:${server.address().port}/extension/abc` }
}

/** Start the watchdog in this process, with a recording browser launch and exit. */
function watchdog(upstreamUrl, o = {}) {
  const launches = []
  const exits = []
  let now = 0
  tabs.watch("/no/cli.js", "/browser", ["--profile-directory=Default", connectPage(upstreamUrl)], {
    WebSocket, launch: (file, args) => launches.push({ file, args }), exit: (code) => exits.push(code), clock: () => now, ...o,
  })
  return { launches, exits, advance: (ms) => { now += ms } }
}

/** The extension stand-in: connects where the browser was told to, records what it is sent, and answers attaches and removals. */
async function extensionFor(w, answer = { attach: (tabId) => tabId !== 12, remove: true }) {
  const launched = await wait(() => w.launches[0], "the browser launch")
  const page = new URL(launched.args.at(-1))
  const socket = new WebSocket(page.searchParams.get("mcpRelayUrl"))
  const sent = []
  let closed = false
  socket.on("message", (data) => {
    let message
    try { message = JSON.parse(String(data)) } catch { message = { text: String(data) } }
    sent.push(message)
    if (message.method === "chrome.debugger.attach") socket.send(JSON.stringify(answer.attach(message.params[0].tabId) ? { id: message.id, result: {} } : { id: message.id, error: "Cannot attach" }))
    if (message.method === "chrome.tabs.remove" && answer.remove) {
      socket.send(JSON.stringify({ method: "chrome.tabs.onRemoved", params: [message.params[0]] }))
      socket.send(JSON.stringify({ id: message.id, result: {} }))
    }
  })
  socket.on("close", () => { closed = true })
  await new Promise((resolve) => socket.on("open", resolve))
  return { socket, sent, page, isClosed: () => closed, send: (message) => socket.send(typeof message === "string" ? message : JSON.stringify(message)) }
}

const removals = (extension) => extension.sent.filter((message) => message.method === "chrome.tabs.remove").map((message) => message.params[0]).sort()

test("the watchdog relays every message both ways and, when Playwright's side drops, closes the tabs Playwright attached and nothing else", withWs, async () => {
  const up = await relay(150)
  try {
    const w = watchdog(up.url)
    const extension = await extensionFor(w)
    assert.match(extension.page.searchParams.get("mcpRelayUrl"), /^ws:\/\/127\.0\.0\.1:\d+\/extension$/u)
    assert.equal(extension.page.searchParams.get("token"), TOKEN)
    assert.equal(w.launches[0].file, "/browser")
    assert.equal(w.launches[0].args[0], "--profile-directory=Default")
    extension.send({ method: "chrome.tabs.onCreated", params: [{ id: 11 }] })
    extension.send("not json from the extension")
    await wait(() => up.state.socket, "the watchdog to reach Playwright")
    await wait(() => up.state.received.length === 2, "messages sent while the link was still connecting")
    assert.deepEqual(up.state.received, [JSON.stringify({ method: "chrome.tabs.onCreated", params: [{ id: 11 }] }), "not json from the extension"])
    up.state.socket.send("not json from Playwright")
    for (const [id, tabId] of [[1, 11], [2, 12], [3, 13], [4, 14], [5, 15]]) up.state.socket.send(JSON.stringify({ id, method: "chrome.debugger.attach", params: [{ tabId }, "1.3"] }))
    up.state.socket.send(JSON.stringify({ id: 6, method: "chrome.debugger.sendCommand", params: [{ tabId: 11 }, "Page.navigate", {}] }))
    await wait(() => extension.sent.length === 7, "Playwright's requests to reach the extension")
    await wait(() => up.state.received.length === 7, "the extension's answers to reach Playwright")
    extension.send({ method: "chrome.tabs.onRemoved", params: [13] })
    extension.send({ method: "chrome.debugger.onDetach", params: [{ tabId: 15 }, "target_closed"] })
    extension.send({ method: "chrome.debugger.onDetach", params: [{ tabId: 99 }, "target_closed"] })
    await wait(() => up.state.received.length === 10, "the extension's events to reach Playwright")
    w.advance(6000)
    extension.send({ method: "chrome.debugger.onDetach", params: [{ tabId: 14 }, "target_closed"] })
    await wait(() => up.state.received.length === 11, "the last detach to reach Playwright")
    assert.deepEqual(removals(extension), [], "nothing is closed while Playwright is connected")
    up.state.socket.terminate()
    await wait(() => extension.isClosed(), "the watchdog to let the extension go")
    // 12 never attached, 13 closed, 15 left the group long ago; 14 detached a moment ago and may be re-attaching.
    assert.deepEqual(removals(extension), [11, 14])
    await wait(() => w.exits.length, "the watchdog to exit")
    assert.deepEqual(w.exits, [0])
    assert.equal(up.state.received.length, 11, "nothing reaches Playwright after it is gone")
  } finally {
    up.server.close()
  }
})

test("a tab detached and attached again is the session's again", withWs, async () => {
  const up = await relay()
  try {
    const w = watchdog(up.url)
    const extension = await extensionFor(w)
    await wait(() => up.state.socket, "the watchdog to reach Playwright")
    up.state.socket.send(JSON.stringify({ id: 1, method: "chrome.debugger.attach", params: [{ tabId: 21 }, "1.3"] }))
    await wait(() => up.state.received.length === 1, "the attach answer")
    extension.send({ method: "chrome.debugger.onDetach", params: [{ tabId: 21 }, "target_closed"] })
    up.state.socket.send(JSON.stringify({ id: 2, method: "chrome.debugger.attach", params: [{ tabId: 21 }, "1.3"] }))
    await wait(() => up.state.received.length === 3, "the second attach answer")
    w.advance(60000)
    up.state.socket.close()
    await wait(() => extension.isClosed(), "the watchdog to let the extension go")
    assert.deepEqual(removals(extension), [21])
  } finally {
    up.server.close()
  }
})

test("when the extension goes first, the watchdog closes Playwright's side, closes no tabs and exits", withWs, async () => {
  const up = await relay()
  try {
    const w = watchdog(up.url)
    const extension = await extensionFor(w)
    await wait(() => up.state.socket, "the watchdog to reach Playwright")
    up.state.socket.send(JSON.stringify({ id: 1, method: "chrome.debugger.attach", params: [{ tabId: 31 }, "1.3"] }))
    await wait(() => up.state.received.length === 1, "the attach answer")
    extension.socket.close()
    await wait(() => up.state.closed, "Playwright's side to be closed")
    await wait(() => w.exits.length >= 1, "the watchdog to exit")
    assert.deepEqual(removals(extension), [])
  } finally {
    up.server.close()
  }
})

test("a session with no tabs, or a relay that cannot be reached, ends at once without closing anything", withWs, async () => {
  const up = await relay()
  try {
    const w = watchdog(up.url)
    const extension = await extensionFor(w)
    await wait(() => up.state.socket, "the watchdog to reach Playwright")
    up.state.socket.close()
    await wait(() => extension.isClosed(), "the watchdog to let the extension go")
    assert.deepEqual(removals(extension), [])
  } finally {
    up.server.close()
  }
  const gone = watchdog("ws://127.0.0.1:9/extension/abc")
  const extension = await extensionFor(gone)
  await wait(() => extension.isClosed(), "the watchdog to give up on a relay it cannot reach")
  await wait(() => gone.exits.length, "the watchdog to exit")
})

test("an extension that never confirms the removals is let go after the time limit", withWs, async () => {
  const up = await relay()
  try {
    const w = watchdog(up.url, { closeMs: 100 })
    const extension = await extensionFor(w, { attach: () => true, remove: false })
    await wait(() => up.state.socket, "the watchdog to reach Playwright")
    up.state.socket.send(JSON.stringify({ id: 1, method: "chrome.debugger.attach", params: [{ tabId: 41 }, "1.3"] }))
    await wait(() => up.state.received.length === 1, "the attach answer")
    up.state.socket.terminate()
    await wait(() => extension.isClosed(), "the watchdog to give up waiting")
    assert.deepEqual(removals(extension), [41])
  } finally {
    up.server.close()
  }
})

test("a watchdog the extension never reaches gives up, and one that finds ws beside Playwright MCP uses it", withWs, async () => {
  const root = await mkTempRoot("real-tabs-")
  mkdirSync(path.join(root, "pw", "node_modules"), { recursive: true })
  symlinkSync(WS_DIR, path.join(root, "pw", "node_modules", "ws"), "junction")
  const launches = []
  const exits = []
  tabs.watch(path.join(root, "pw", "cli.js"), "/browser", [connectPage("ws://127.0.0.1:9/extension/abc")], {
    launch: (file, args) => launches.push(args), exit: (code) => exits.push(code), connectMs: 100,
  })
  await wait(() => exits.length, "the watchdog to give up")
  assert.equal(launches.length, 1)
  assert.notEqual(new URL(launches[0][0]).searchParams.get("mcpRelayUrl"), "ws://127.0.0.1:9/extension/abc")
})

test("without ws, or when its relay cannot listen, the watchdog opens the original connect page so the browser still works", async () => {
  const original = ["--profile-directory=Default", connectPage("ws://127.0.0.1:9/extension/abc")]
  const launches = []
  tabs.watch("/nowhere/cli.js", "/browser", original, { launch: (file, args) => launches.push({ file, args }) })
  assert.deepEqual(launches, [{ file: "/browser", args: original }])

  class FailingServer extends EventEmitter {
    constructor() { super(); setImmediate(() => this.emit("error", new Error("EADDRINUSE"))) }
  }
  const exits = []
  tabs.watch("/nowhere/cli.js", "/browser", original, { WebSocket: { Server: FailingServer }, launch: (file, args) => launches.push({ file, args }), exit: (code) => exits.push(code) })
  await wait(() => exits.length, "the watchdog to give up")
  assert.deepEqual(launches[1], { file: "/browser", args: original })
})

test("the default browser launch is detached and survives a browser that cannot start", async () => {
  tabs.watch("/nowhere/cli.js", path.join(mcpRoot, "no-such-browser"), [connectPage("ws://127.0.0.1:9/x")], {})
  await new Promise((resolve) => setTimeout(resolve, 100))
})

// ---- end to end, with real processes ----

/** A Playwright MCP stand-in that opens the connect page the way Playwright does, and a browser stand-in that records what it was opened with. */
async function machine() {
  const root = await mkTempRoot("real-tabs-")
  const pw = path.join(root, "pw")
  mkdirSync(path.join(pw, "node_modules"), { recursive: true })
  symlinkSync(WS_DIR, path.join(pw, "node_modules", "ws"), "junction")
  writeFileSync(path.join(pw, "cli.js"), `
const { spawn } = require("child_process")
const page = "${CONNECT_PAGE}?mcpRelayUrl=" + encodeURIComponent(process.env.UPSTREAM) + "&client=%7B%7D&protocolVersion=2&token=" + process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
spawn(process.env.FAKE_BROWSER, ["--user-data-dir=/tmp/profile", "--profile-directory=Default", page], { windowsHide: true, detached: true, shell: false, stdio: "ignore" })
process.stdout.write("Page URL: " + page + "\\n")
process.stdout.write(Buffer.from("argv " + process.argv.slice(2).join(" ") + "\\n"))
`)
  const browserLog = path.join(root, "browser.log")
  const fakeBrowser = path.join(root, "browser.sh")
  writeFileSync(fakeBrowser, `#!/bin/sh\nfor arg in "$@"; do printf '%s\\n' "$arg"; done > "${browserLog}.tmp" && mv "${browserLog}.tmp" "${browserLog}"\n`)
  chmodSync(fakeBrowser, 0o755)
  return { cli: path.join(pw, "cli.js"), fakeBrowser, browserLog }
}

test("end to end: the runner and its detached watchdog close the session's tabs after Playwright MCP is killed", posixWithWs, async () => {
  const m = await machine()
  const up = await relay()
  const out = []
  const runner = spawn(process.execPath, [RUNNER, m.cli, "--extension", "--browser", "msedge"], {
    env: { ...process.env, PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN, UPSTREAM: up.url, FAKE_BROWSER: m.fakeBrowser },
    stdio: ["ignore", "pipe", "pipe"],
  })
  runner.stdout.on("data", (chunk) => out.push(String(chunk)))
  try {
    await wait(() => existsSync(m.browserLog) && out.join("").includes("argv "), "the browser to be opened")
    const browserArgs = readFileSync(m.browserLog, "utf8").trim().split("\n")
    assert.deepEqual(browserArgs.slice(0, 2), ["--user-data-dir=/tmp/profile", "--profile-directory=Default"])
    const page = new URL(browserArgs.at(-1))
    assert.notEqual(page.searchParams.get("mcpRelayUrl"), up.url)
    assert.equal(page.searchParams.get("token"), TOKEN)
    assert.match(out.join(""), /argv --extension --browser msedge/u)
    assert.match(out.join(""), /token=<token>/u)
    assert.equal(out.join("").includes(TOKEN), false)
    const extension = await extensionFor({ launches: [{ args: [page.toString()] }] })
    await wait(() => up.state.socket, "the watchdog to reach Playwright")
    up.state.socket.send(JSON.stringify({ id: 1, method: "chrome.debugger.attach", params: [{ tabId: 51 }, "1.3"] }))
    await wait(() => up.state.received.length === 1, "the attach answer")
    // Playwright MCP is killed: its relay connection drops without a goodbye.
    runner.kill("SIGKILL")
    up.state.socket.terminate()
    await wait(() => extension.isClosed(), "the watchdog to let the extension go")
    assert.deepEqual(removals(extension), [51])
  } finally {
    runner.kill("SIGKILL")
    up.server.close()
  }
})
