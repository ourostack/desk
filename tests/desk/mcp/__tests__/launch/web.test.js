// Desk's default browser launcher (mcp/web.cjs), which backs the `web` MCP server.
//
// Every fresh Desk install gets a browser through the `web` MCP server. The launcher starts a copy of `@playwright/mcp` installed in Desk's state folder, installs it on first use, and refreshes it from the `@latest` channel in a detached process after start. Before Playwright MCP takes over stdio, any failure here -- no compatible Node, no npm beside it, an unreachable registry, a Node that will not spawn, or anything else that throws -- is served as a degraded MCP handshake instead of a silent `exit(1)`: every browser_* tool lists as unavailable and every call answers with a status, a code and a fix, mirroring `desk`'s own bootstrap. No test reaches a registry: the chosen Node's npm is a fake (`npm-cli.js` beside a link to this Node) that installs a stub package, reports a version, fails, or hangs on request, and logs every call. In-process tests inject the platform, environment, file checks, spawn and stdio, so every branch (including the Windows layouts) is measured on any host. Spawned tests run the real Claude inline launcher, the Copilot entry point and concurrent launches against a fixture plugin.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot, pluginRoot, toolPayload } from "./_mcp_handshake.js"
import { openSession } from "./_mcp_session.js"

const require = createRequire(import.meta.url)
const browserPath = path.join(mcpRoot, "web.cjs")
const browser = require(browserPath)
const posixOnly = { skip: process.platform === "win32" ? "fixture Nodes are POSIX links and shell scripts" : false }

// ---- fixtures ----

function fakeChild() {
  const child = new EventEmitter()
  child.killed = []
  child.kill = (signal) => { child.killed.push(signal) }
  return child
}

function touch(file, contents = "") {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
  return file
}

// The browser a fake install leaves behind: a stub MCP server. It answers initialize, and answers tools/call with the options it was started with. FAKE_CLI_MODE picks a behavior: list_changed (a tools/list_changed notification, a log notification, noise and an answer to a request nobody made before each answer), rpcerror (answers a call with a JSON-RPC error), crash (exits 3 on a call), slow (never answers a call; logs a cancel to stderr), stubborn (ignores stdin closing), badinit (answers initialize with an error), dieearly (exits 4 a moment after initialize arrives), extra (lists one more tool), badlist (answers tools/list with an error), ping (pings the host before answering initialize), chunky (writes each answer in two pieces), roots (asks the host for roots before answering initialize).
const STUB_CLI = `
const args = process.argv.slice(2)
const mode = process.env.FAKE_CLI_MODE || "ok"
let buffered = ""
let chain = Promise.resolve()
function send(message) {
  const text = JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n"
  if (mode !== "chunky") { process.stdout.write(text); return }
  chain = chain.then(() => new Promise((resolve) => {
    process.stdout.write(text.slice(0, 10))
    setTimeout(() => { process.stdout.write(text.slice(10)); resolve() }, 20)
  }))
}
process.stdin.setEncoding("utf8")
process.stdin.on("data", (chunk) => {
  buffered += chunk
  let newline
  while ((newline = buffered.indexOf("\\n")) >= 0) {
    const line = buffered.slice(0, newline)
    buffered = buffered.slice(newline + 1)
    const message = JSON.parse(line)
    if (message.method === "initialize") {
      if (mode === "badinit") { send({ id: message.id, error: { code: -32000, message: "no handshake today" } }); continue }
      if (mode === "dieearly") { setTimeout(() => process.exit(4), 300); continue }
      if (mode === "roots") send({ id: 99, method: "roots/list" })
      if (mode === "ping") send({ id: 55, method: "ping" })
      send({ id: message.id, result: { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: "Playwright", version: "stub" } } })
    } else if (message.method === "tools/list") {
      if (mode === "badlist") { send({ id: message.id, error: { code: -32603, message: "no list" } }); continue }
      send({ id: message.id, result: { tools: [{ name: "stub_tool", inputSchema: { type: "object" } }].concat(mode === "extra" ? [{ name: "new_tool", inputSchema: { type: "object" } }] : []) } })
    } else if (message.method === "notifications/cancelled") {
      process.stderr.write("cancelled " + message.params.requestId + "\\n")
    } else if (message.method === "tools/call") {
      if (mode === "crash") process.exit(3)
      if (mode === "rpcerror") { send({ id: message.id, error: { code: -32602, message: "bad arguments" } }); continue }
      if (mode === "slow") { process.stderr.write("slow call " + message.id + "\\n"); continue }
      if (mode === "list_changed") {
        send({ method: "notifications/tools/list_changed" })
        send({ method: "notifications/message", params: { level: "info", data: "log line" } })
        process.stdout.write("not json at all\\n42\\n")
        send({ id: 777, result: {} })
      }
      send({ id: message.id, result: { content: [{ type: "text", text: "ran " + message.params.name + " " + JSON.stringify(message.params.arguments) + " " + JSON.stringify(args) }] } })
    } else if (message.id !== undefined && message.method === undefined) {
      process.stderr.write("host answered " + message.id + " " + JSON.stringify(message.error || message.result) + "\\n")
    }
  }
})
process.stdin.on("end", () => { if (mode !== "stubborn") process.exit(0) })
if (mode === "stubborn") setInterval(() => {}, 1000)
`

// A fake npm: `install` writes a stub @playwright/mcp (and playwright-core) into --prefix, `view` prints a version, `config get registry` prints a registry. FAKE_NPM_MODE picks a failure (grandchild starts a second process and hangs, writing its pid to FAKE_NPM_GRANDCHILD), FAKE_NPM_VERSION the version, FAKE_NPM_DELAY_MS a pause, and FAKE_NPM_LOG receives one JSON line per call.
const FAKE_NPM = `
const fs = require("fs"), path = require("path")
const args = process.argv.slice(2)
const mode = process.env.FAKE_NPM_MODE || "ok"
const version = process.env.FAKE_NPM_VERSION || "0.0.82"
if (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args, retries: process.env.npm_config_fetch_retries, timeout: process.env.npm_config_fetch_timeout, path: process.env.PATH }) + "\\n")
function main() {
  if (mode === "hang") { setInterval(() => {}, 1000); return }
  if (mode === "grandchild") {
    const grandchild = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
    fs.writeFileSync(process.env.FAKE_NPM_GRANDCHILD, String(grandchild.pid))
    setInterval(() => {}, 1000)
    return
  }
  if (mode === "failall" || (mode === "fail" && args[0] !== "config")) { process.stderr.write("npm error code ENOTCONN\\nnpm error network unreachable\\n"); process.exit(1) }
  if (args[0] === "config") { process.stdout.write("https://registry.example/\\n"); return }
  if (mode === "steal") fs.writeFileSync(path.join(process.env.DESK_BROWSER_STATE_DIR, "refresh.lock"), JSON.stringify({ pid: 1 }))
  if (args[0] === "view") { process.stdout.write(mode === "emptyview" ? "" : version + "\\n"); return }
  if (args[0] !== "install" || mode === "silent") return
  const modules = path.join(args[args.indexOf("--prefix") + 1], "node_modules")
  const pkg = path.join(modules, "@playwright", "mcp")
  fs.mkdirSync(pkg, { recursive: true })
  const bin = mode === "stringbin" ? "cli.js" : mode === "nobin" ? {} : { "playwright-mcp": "cli.js" }
  fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@playwright/mcp", version, bin }))
  if (mode !== "nocli") fs.writeFileSync(path.join(pkg, "cli.js"), ${JSON.stringify(STUB_CLI)})
  if (mode !== "nocore") {
    fs.mkdirSync(path.join(modules, "playwright-core"), { recursive: true })
    fs.writeFileSync(path.join(modules, "playwright-core", "package.json"), JSON.stringify({ version: "1.64.0-test" }))
  }
}
setTimeout(main, Number(process.env.FAKE_NPM_DELAY_MS || 0))
`

/** A POSIX Node install whose bin/node links to this Node and whose npm is the fake. */
function nodeInstall(root) {
  const node = path.join(root, "bin", "node")
  mkdirSync(path.dirname(node), { recursive: true })
  symlinkSync(process.execPath, node)
  const cli = touch(path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js"), FAKE_NPM)
  return { node, cli }
}

/** A Node install, a state folder and an npm log, with options that make that Node the only (and compatible) choice. */
async function machine(prefix, overrides = {}) {
  const root = await mkTempRoot(prefix)
  const install = nodeInstall(path.join(root, "node"))
  const state = path.join(root, "state")
  const log = path.join(root, "npm.log")
  const { env: extraEnv, ...rest } = overrides
  const options = {
    env: { PATH: "/usr/bin", DESK_BROWSER_STATE_DIR: state, FAKE_NPM_LOG: log, ...extraEnv },
    platform: "linux",
    arch: "x64",
    homeDir: path.join(root, "home"),
    systemPrefix: path.join(root, "sysroot"),
    current: { path: install.node, version: "v22.9.0", abi: "127" },
    now: () => 0,
    probe: () => null,
    exists: (file) => file === install.cli,
    startRefresh: () => { throw new Error("no refresh expected") },
    ...rest,
  }
  return { root, install, state, log, options, calls: () => npmCalls(log) }
}

function npmCalls(log) {
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []
}

/** Install a stub copy into a state folder, as a finished install would leave it. */
function preinstall(state, version = "0.0.81", id = "installs/1-1-a", cli = "process.stdout.write('ran ' + process.argv.slice(2).map((a) => '[' + a + ']').join(' ') + '\\n')\n") {
  const modules = path.join(state, id, "node_modules")
  touch(path.join(modules, "@playwright", "mcp", "package.json"), JSON.stringify({ name: "@playwright/mcp", version, bin: { "playwright-mcp": "cli.js" } }))
  touch(path.join(modules, "@playwright", "mcp", "cli.js"), cli)
  touch(path.join(state, "current.json"), JSON.stringify({ version, dir: id, previous: null }))
  return path.join(modules, "@playwright", "mcp", "cli.js")
}

/** Collects newline-delimited JSON-RPC responses written to a stream, the same helper bootstrap.test.js uses to read a degraded responder's stdout. */
function collect(output) {
  const chunks = []
  output.on("data", (chunk) => chunks.push(chunk))
  return () => Buffer.concat(chunks).toString("utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

/** Run the launcher with a fake MCP spawn; resolves once the MCP is spawned (or the launcher ended without spawning it). Stdin/stdout default to a pair of streams with stdin already closed, so a launch that degrades instead of spawning resolves at once instead of waiting on the real process's stdin; a test that wants to drive the degraded responder itself passes its own `stdin`/`stdout` and ends them when it is done. */
function launch(options = {}) {
  const errors = []
  const exits = []
  const spawns = []
  const child = fakeChild()
  const signals = new EventEmitter()
  const stdin = options.stdin || new PassThrough()
  const stdout = options.stdout || new PassThrough()
  const read = collect(stdout)
  let spawned
  const ready = new Promise((resolve) => { spawned = resolve })
  const running = browser.run({
    spawn: (file, argv, spawnOptions) => { spawns.push({ file, argv, stdio: spawnOptions.stdio, env: spawnOptions.env }); spawned(); return child },
    signals,
    kill: () => {},
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
    ...options,
    stdin,
    stdout,
  })
  if (!options.stdin) stdin.end()
  return { running, ready: Promise.race([ready, running]), errors, exits, spawns, child, signals, stdin, stdout, read }
}

/** Run the launcher against a stdin that carries the given JSON-RPC requests (if any) and then closes, for exercising the "degrade, never die" paths: no spawn is faked, so a regression that reaches the real Playwright MCP spawn fails the test instead of spawning something real. Returns the parsed responses alongside the usual stderr lines and exit calls (expected to stay empty: a degraded server answers over the protocol, it does not exit). */
async function launchDegraded(options, requests = []) {
  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const errors = []
  const exits = []
  const running = browser.run({
    stdin: input,
    stdout: output,
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
    spawn: () => { throw new Error("no spawn expected") },
    ...options,
  })
  for (const request of requests) input.write(`${JSON.stringify(request)}\n`)
  input.end()
  await running
  return { errors, exits, responses: read() }
}

/** Waits until `check()` returns something truthy, or fails after `ms`. */
async function until(check, what, ms = 15000) {
  const deadline = Date.now() + ms
  for (;;) {
    const found = check()
    if (found) return found
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A host talking to the launcher in this process over a pair of streams, with the real stub browser behind it (the fake npm installs it). Every option of the launcher can be overridden; `exits` and `kills` record how the launcher ended the process. */
function host(options) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const read = collect(stdout)
  const errors = []
  const exits = []
  const kills = []
  const signals = new EventEmitter()
  const running = browser.run({
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
    kill: (pid, signal) => kills.push(signal),
    signals,
    ...options,
    stdin,
    stdout,
  })
  const session = {
    running, errors, exits, kills, signals, stdin, stdout, read,
    send: (message) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    reply: (id) => until(() => read().find((message) => message.id === id), `the answer to ${id}`),
    async ask(id, method, params) {
      session.send({ id, method, params })
      return session.reply(id)
    },
    handshake: async () => {
      await session.ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-host", version: "1" } })
      session.send({ method: "notifications/initialized" })
    },
    call: (id, name = "browser_navigate", args = { url: "https://example.com" }) => session.ask(id, "tools/call", { name, arguments: args }),
    close: () => { stdin.end(); return running },
  }
  return session
}

// ---- the package follows its channel ----

test("the launcher installs the @playwright/mcp channel with bounded npm calls, never a pinned version", () => {
  assert.equal(browser.PACKAGE, "@playwright/mcp@latest")
  assert.doesNotMatch(readFileSync(browserPath, "utf8"), /@playwright\/mcp@\d/u)
  assert.deepEqual(browser.DEFAULT_ARGS, ["--headless", "--isolated"])
  assert.equal(browser.NPM_ENV.npm_config_fetch_retries, "0")
  assert.equal(browser.NPM_ENV.npm_config_fetch_timeout, "10000")
})

test("the launcher uses only syntax that very old Node parses", () => {
  const source = readFileSync(browserPath, "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")
  assert.doesNotMatch(source, /=>|`|\?\.|\blet\s|\bconst\s|\basync\s/u)
})

// ---- which browser, and every option Playwright MCP gets ----

test("browser locations follow Playwright's chrome and msedge channels on each platform", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" }
  assert.deepEqual(browser.browserPaths("chrome", "win32", env), [
    "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ])
  assert.deepEqual(browser.browserPaths("msedge", "win32", { PROGRAMFILES: "C:\\Program Files" }), ["C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"])
  assert.deepEqual(browser.browserPaths("chrome", "darwin", { HOME: "/Users/a" }), ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"])
  assert.deepEqual(browser.browserPaths("msedge", "darwin", {}), ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"])
  assert.deepEqual(browser.browserPaths("chrome", "linux", {}), ["/opt/google/chrome/chrome"])
  assert.deepEqual(browser.browserPaths("msedge", "linux", {}), ["/opt/microsoft/msedge/msedge"])
})

test("Windows browser locations accept the environment's original variable casing", () => {
  assert.deepEqual(browser.browserPaths("msedge", "win32", {
    LocalAppData: "C:\\Users\\a\\AppData\\Local",
    ProgramFiles: "C:\\Program Files",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
  }), [
    "C:\\Users\\a\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  ])
})

test("the launcher keeps Playwright's Chrome default, passes Chrome from ~/Applications, falls back to Edge, and never overrides the caller", () => {
  const env = { PROGRAMFILES: "C:\\Program Files" }
  const edgeOnly = (file) => file.endsWith("msedge.exe")
  assert.deepEqual(browser.browserArgs([], "win32", env, edgeOnly), ["--browser", "msedge"])
  assert.deepEqual(browser.browserArgs([], "win32", env, () => true), [])
  assert.deepEqual(browser.browserArgs([], "linux", {}, () => false), [])
  assert.deepEqual(browser.browserArgs(["--browser", "firefox"], "win32", env, edgeOnly), [])
  assert.deepEqual(browser.browserArgs(["--executable-path=/x"], "win32", env, edgeOnly), [])
  assert.deepEqual(browser.browserArgs(["--cdp-endpoint=http://127.0.0.1:9"], "win32", env, edgeOnly), [])
  assert.deepEqual(browser.browserArgs(["--caps", "vision"], "win32", env, edgeOnly), ["--browser", "msedge"])

  const home = { HOME: "/Users/a" }
  const userChrome = "/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  const userEdge = "/Users/a/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  const systemEdge = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
  assert.deepEqual(browser.browserArgs([], "darwin", home, (file) => file === userChrome || file === systemEdge), ["--executable-path", userChrome])
  assert.deepEqual(browser.browserArgs([], "darwin", home, (file) => file === systemEdge), ["--browser", "msedge"])
  assert.deepEqual(browser.browserArgs([], "darwin", home, (file) => file === userEdge), ["--browser", "msedge", "--executable-path", userEdge])
  assert.deepEqual(browser.browserArgs([], "darwin", {}, () => false), [])
})

test("Desk's defaults and output folder come first, a connecting caller gets no defaults, and a caller's output folder wins", () => {
  const none = () => false
  assert.deepEqual(browser.launchArgs(["--caps", "pdf"], "linux", {}, none, "/s"), ["--headless", "--isolated", "--output-dir", path.join("/s", "output"), "--caps", "pdf"])
  assert.deepEqual(browser.launchArgs(["--cdp-endpoint", "http://127.0.0.1:9"], "linux", {}, () => true, "/s"), ["--output-dir", path.join("/s", "output"), "--cdp-endpoint", "http://127.0.0.1:9"])
  assert.deepEqual(browser.launchArgs(["--output-dir=/o"], "linux", {}, none, "/s"), ["--headless", "--isolated", "--output-dir=/o"])
})

// ---- which npm, which Node, which folder ----

test("npm is the one that ships beside the chosen Node, found through links too", async () => {
  const root = await mkTempRoot("desk-web-npm-")
  const cli = touch(path.join(root, "real", "lib", "node_modules", "npm", "bin", "npm-cli.js"))
  const node = touch(path.join(root, "real", "bin", "node"))
  const exists = (file) => existsSync(file)
  assert.equal(browser.npmCli(node, "linux", exists), path.join(root, "real", "bin", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"))
  const linked = path.join(root, "links", "node")
  mkdirSync(path.dirname(linked), { recursive: true })
  symlinkSync(node, linked)
  assert.equal(realpathSync(browser.npmCli(linked, "darwin", exists)), realpathSync(cli))
  assert.equal(browser.npmCli(path.join(root, "missing", "bin", "node"), "linux", exists), null)
  const seen = []
  assert.equal(browser.npmCli("C:\\node\\node.exe", "win32", (file) => { seen.push(file); return file === "C:\\node\\node_modules\\npm\\bin\\npm-cli.js" }), "C:\\node\\node_modules\\npm\\bin\\npm-cli.js")
  assert.equal(seen[0], "C:\\node\\node_modules\\npm\\bin\\npm-cli.js")
})

test("npm failures are reduced to their code and first message line", () => {
  const refused = [
    "npm error code ECONNREFUSED",
    "npm error syscall connect",
    "npm error errno ECONNREFUSED",
    "npm error FetchError: request to http://127.0.0.1:9/@playwright%2fmcp failed, reason: connect ECONNREFUSED 127.0.0.1:9",
    "npm error     at ClientRequest.<anonymous> (/n/lib/node_modules/npm/node_modules/minipass-fetch/lib/index.js:130:14)",
    "npm error A complete log of this run can be found in: /h/.npm/_logs/x-debug-0.log",
  ].join("\n")
  assert.equal(browser.npmError({ stderr: refused, code: 1 }, "npm view"), "ECONNREFUSED: FetchError: request to http://127.0.0.1:9/@playwright%2fmcp failed, reason: connect ECONNREFUSED 127.0.0.1:9")
  const missing = ["npm error code E404", "npm error 404 No match found for version x", "npm error 404", "npm ERR! code E999"].join("\n")
  assert.equal(browser.npmError({ stderr: missing, code: 1 }, "npm view"), "E404: 404 No match found for version x")
  assert.equal(browser.npmError({ stderr: "npm error code EAI_AGAIN\n", code: 1 }, "npm view"), "EAI_AGAIN")
  assert.equal(browser.npmError({ stderr: "", code: 7 }, "npm install"), "npm install exited with code 7")
  assert.equal(browser.npmError({ stderr: "spawn EMFILE", code: null }, "npm install"), "spawn EMFILE")
})

test("the chosen Node's folder goes first on PATH, keeping the variable's own spelling", () => {
  assert.deepEqual(browser.withNodeFirst({ PATH: "/usr/bin", HOME: "/h" }, "/n/bin/node", "linux"), { PATH: "/n/bin:/usr/bin", HOME: "/h" })
  assert.deepEqual(browser.withNodeFirst({ Path: "C:\\Windows" }, "C:\\node\\node.exe", "win32"), { Path: "C:\\node;C:\\Windows" })
  assert.deepEqual(browser.withNodeFirst({}, "/n/bin/node", "darwin"), { PATH: "/n/bin" })
})

test("the browser's state folder is per user and never inside a project", () => {
  assert.equal(browser.stateDir({ DESK_BROWSER_STATE_DIR: "/custom" }, "/h"), "/custom")
  assert.equal(browser.stateDir({ XDG_STATE_HOME: "/xdg" }, "/h"), path.join("/xdg", "ouroboros-skills", "desk", "browser"))
  assert.equal(browser.stateDir({}, "/h"), path.join("/h", ".local", "state", "ouroboros-skills", "desk", "browser"))
})

test("only a complete install counts as installed", async () => {
  const root = await mkTempRoot("desk-web-read-")
  assert.equal(browser.readInstalled(root), null)
  touch(path.join(root, "current.json"), JSON.stringify({ version: "1" }))
  assert.equal(browser.readInstalled(root), null)
  const pkg = path.join(root, "i", "node_modules", "@playwright", "mcp")
  touch(path.join(root, "current.json"), JSON.stringify({ dir: "i" }))
  touch(path.join(pkg, "package.json"), JSON.stringify({ bin: "cli.js" }))
  assert.equal(browser.readInstalled(root), null, "no version")
  touch(path.join(pkg, "package.json"), JSON.stringify({ version: "1", bin: {} }))
  assert.equal(browser.readInstalled(root), null, "no bin")
  touch(path.join(pkg, "package.json"), JSON.stringify({ version: "1", bin: "cli.js" }))
  assert.equal(browser.readInstalled(root), null, "no entry script")
  touch(path.join(pkg, "cli.js"))
  assert.deepEqual(browser.readInstalled(root), { version: "1", core: null, cli: path.join(pkg, "cli.js"), dir: path.join(root, "i") })
  touch(path.join(root, "i", "node_modules", "playwright-core", "package.json"), JSON.stringify({ version: 2 }))
  assert.equal(browser.readInstalled(root).core, null)
})

// ---- the lock ----

test("the lock admits one owner and replaces an owner that died or went stale", async () => {
  const root = await mkTempRoot("desk-web-lock-")
  const lock = path.join(root, "refresh.lock")
  assert.equal(browser.takeLock(lock, Date.now), true)
  assert.equal(browser.takeLock(lock, Date.now), false, "held by a live process")
  writeFileSync(lock, "not json")
  assert.equal(browser.takeLock(lock, Date.now), false, "an owner still writing its record is live")
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" })
  writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout) }))
  assert.equal(browser.takeLock(lock, Date.now), true, "its owner exited")
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid)
  writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  assert.equal(browser.takeLock(lock, Date.now), false, "the recorded owner is still alive")
  assert.equal(browser.takeLock(lock, () => Date.now() + 11 * 60 * 1000), true, "older than ten minutes")
  assert.throws(() => browser.takeLock(path.join(root, "missing", "refresh.lock"), Date.now), /ENOENT/u)
})

test("the lock keeps an owner whose liveness probe is not permitted", async (t) => {
  const root = await mkTempRoot("desk-web-lock-permission-")
  const lock = path.join(root, "refresh.lock")
  writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  t.mock.method(process, "kill", (pid, signal) => {
    assert.equal(pid, process.pid)
    assert.equal(signal, 0)
    throw Object.assign(new Error("not permitted"), { code: "EPERM" })
  })
  assert.equal(browser.takeLock(lock, Date.now), false)
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid)
})

test("a lock that vanishes while it is replaced is decided by the next create", async () => {
  const root = await mkTempRoot("desk-web-lockrace-")
  const lock = path.join(root, "refresh.lock")
  writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  // Released by its owner between the failed create and the staleness check, so both the check and the unlink miss it.
  let calls = 0
  const clock = () => { calls += 1; if (calls === 1) { try { require("node:fs").unlinkSync(lock) } catch {} } return Date.now() + 11 * 60 * 1000 }
  assert.equal(browser.takeLock(lock, clock), true)
})

// ---- run: the first launch installs, later launches start at once ----

test("the first launch answers the handshake at once, installs meanwhile, then passes the first call to the installed browser under the chosen Node", posixOnly, async () => {
  const m = await machine("desk-web-first-", { env: { FAKE_NPM_VERSION: "0.0.90", FAKE_NPM_DELAY_MS: "600" } })
  const spawns = []
  const h = host({ ...m.options, args: ["--caps", "vision"], spawn: (file, argv, spawnOptions) => { spawns.push({ file, argv, stdio: spawnOptions.stdio, env: spawnOptions.env }); return spawn(file, argv, spawnOptions) } })
  const started = Date.now()
  await h.handshake()
  const list = await h.ask(2, "tools/list")
  assert.ok(Date.now() - started < 500, "the handshake and the tool list never wait for the install")
  assert.deepEqual(list.result.tools.map((tool) => tool.name), browser.BROWSER_TOOL_NAMES)
  assert.equal(spawns.length, 0, "the browser has not started while npm installs")
  const answer = await h.call(3)
  assert.ok(Date.now() - started >= 500, "the call waited for the install")
  assert.equal(answer.result.isError, undefined)
  const installed = browser.readInstalled(m.state)
  assert.equal(installed.version, "0.0.90")
  assert.deepEqual(spawns.map(({ file, argv, stdio }) => ({ file, argv, stdio })), [{
    file: m.install.node,
    argv: [installed.cli, "--headless", "--isolated", "--output-dir", path.join(m.state, "output"), "--caps", "vision"],
    stdio: ["pipe", "pipe", "pipe"],
  }])
  assert.equal(spawns[0].env.PATH, `${path.dirname(m.install.node)}:/usr/bin`)
  assert.equal(spawns[0].env.npm_config_fetch_retries, undefined, "npm settings stay out of the browser's environment")
  assert.match(answer.result.content[0].text, /^ran browser_navigate \{"url":"https:\/\/example\.com"\} \["--headless"/u)
  assert.match(h.errors.join(""), /^\[web\] @playwright\/mcp 0\.0\.90 \(playwright-core 1\.64\.0-test\) from .*installs/u)
  const [call] = m.calls()
  assert.deepEqual(call.args.slice(0, 1).concat(call.args.slice(-3)), ["install", "--no-save", "--no-package-lock", "@playwright/mcp@latest"])
  assert.equal(call.retries, "0")
  assert.equal(call.timeout, "10000")
  assert.equal(existsSync(path.join(m.state, "refresh.lock")), false, "the lock is released")
  assert.equal(h.read().filter((message) => message.method !== undefined).length, 0, "the host is never told the tool list changed")
  await h.close()
  assert.deepEqual(h.exits, [0])
})

test("a later launch starts the installed copy with no npm call, then starts the refresh", posixOnly, async () => {
  const refreshes = []
  const m = await machine("desk-web-later-", { startRefresh: (o) => refreshes.push(o), platform: "darwin" })
  const cli = preinstall(m.state)
  const l = launch({ ...m.options, args: [] })
  await l.ready
  assert.equal(l.spawns[0].argv[0], cli)
  assert.deepEqual(m.calls(), [], "session start never waits on npm")
  assert.deepEqual(refreshes, [{ node: m.install.node, npmCli: m.install.cli, env: m.options.env }])
  assert.match(l.errors.join(""), /@playwright\/mcp 0\.0\.81 from /u)
  l.child.emit("exit", null, "SIGTERM")
  await l.running
})

test("an unreachable registry fails fast with one line naming the registry, and serves the browser as degraded rather than a silent exit", posixOnly, async () => {
  for (const [mode, registry] of [["fail", "https://registry.example/"], ["failall", "the configured npm registry"]]) {
    const m = await machine("desk-web-offline-", { env: { FAKE_NPM_MODE: mode } })
    const { errors, exits, responses } = await launchDegraded(m.options, [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_navigate" } }])
    assert.deepEqual(exits, [], "never exits; the browser degrades instead")
    assert.equal(errors.join(""), `[web] Desk could not install @playwright/mcp@latest from ${registry} (ENOTCONN: network unreachable), so the browser is unavailable; serving degraded:install_failed\n`)
    const payload = toolPayload(responses[0])
    assert.equal(payload.status, "degraded")
    assert.equal(payload.state, "degraded:install_failed")
    assert.equal(payload.code, "install_failed")
    assert.match(payload.fix, /reconnect the desk-web MCP server/u)
    assert.deepEqual(readdirSync(path.join(m.state, "installs")), [])
    assert.equal(existsSync(path.join(m.state, "refresh.lock")), false)
  }
})

test("an install that npm reports as done but left incomplete is an error, not a launch", posixOnly, async () => {
  for (const mode of ["silent", "nocli", "nobin"]) {
    const m = await machine("desk-web-incomplete-", { env: { FAKE_NPM_MODE: mode } })
    const { errors, exits } = await launchDegraded(m.options)
    assert.deepEqual(exits, [])
    assert.match(errors.join(""), /\(npm install exited with code 0\)/u)
    assert.match(errors.join(""), /serving degraded:install_failed/u)
  }
  const m = await machine("desk-web-stringbin-", { env: { FAKE_NPM_MODE: "stringbin" } })
  const h = host(m.options)
  await h.handshake()
  const answer = await h.call(2)
  assert.match(answer.result.content[0].text, /^ran browser_navigate/u)
  await h.close()
})

test("a registry that hangs is cut off at the first-install time limit", posixOnly, async () => {
  const m = await machine("desk-web-hang-", { env: { FAKE_NPM_MODE: "hang" }, firstInstallMs: 100 })
  const started = Date.now()
  const { errors, exits } = await launchDegraded(m.options)
  assert.ok(Date.now() - started < 10000)
  assert.deepEqual(exits, [])
  assert.match(errors.join(""), /\(npm install timed out after 1 seconds\)/u)
})

test("an npm call that times out is ended with everything it started", posixOnly, async (t) => {
  const grandchildFile = path.join(await mkTempRoot("desk-web-timeoutgrand-"), "pid")
  const m = await machine("desk-web-timeout-", { env: { FAKE_NPM_MODE: "grandchild", FAKE_NPM_GRANDCHILD: grandchildFile }, firstInstallMs: 300 })
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  let helper = null
  t.after(() => { if (helper !== null && alive(helper)) process.kill(helper, "SIGKILL") })
  const { errors } = await launchDegraded(m.options)
  assert.match(errors.join(""), /timed out/u)
  helper = Number(readFileSync(grandchildFile, "utf8"))
  await until(() => !alive(helper), "the helper npm started to end")
})

test("a POSIX tree stop falls back to the npm process when its process group is gone", posixOnly, () => {
  const killed = []
  browser.stopTree({ platform: "linux", children: [] }, { pid: 2147483646, kill: (signal) => killed.push(signal) }, "SIGKILL")
  assert.deepEqual(killed, ["SIGKILL"])
})

test("a Windows tree stop runs taskkill from SystemRoot and falls back to the npm process when taskkill cannot end it", () => {
  assert.equal(browser.taskkillPath({ SystemRoot: "D:\\Win" }), "D:\\Win\\System32\\taskkill.exe")
  assert.equal(browser.taskkillPath({ SYSTEMROOT: "relative", windir: "E:\\W" }), "E:\\W\\System32\\taskkill.exe")
  assert.equal(browser.taskkillPath({ PATH: "x" }), "C:\\Windows\\System32\\taskkill.exe")
  const run = (spawnKiller) => {
    const calls = []
    const killed = []
    const child = { pid: 42, kill: (signal) => killed.push(signal) }
    browser.stopTree({ platform: "win32", env: { SystemRoot: "D:\\Win" }, spawn: (...argv) => { calls.push(argv); return spawnKiller() } }, child, "SIGKILL")
    return { calls, killed }
  }
  const ended = run(() => { const killer = new EventEmitter(); setImmediate(() => killer.emit("exit", 0)); return killer })
  assert.deepEqual(ended.calls, [["D:\\Win\\System32\\taskkill.exe", ["/PID", "42", "/T", "/F"], { stdio: "ignore", windowsHide: true }]])
  const failed = new EventEmitter()
  const failedRun = run(() => failed)
  failed.emit("exit", 128)
  assert.deepEqual(failedRun.killed, ["SIGKILL"])
  const missing = new EventEmitter()
  const missingRun = run(() => missing)
  missing.emit("error", new Error("spawn ENOENT"))
  assert.deepEqual(missingRun.killed, ["SIGKILL"])
  assert.deepEqual(run(() => { throw new Error("spawn EMFILE") }).killed, ["SIGKILL"])
  const done = new EventEmitter()
  const doneRun = run(() => done)
  done.emit("exit", 0)
  assert.deepEqual(doneRun.killed, [])
})

test("npm that cannot be spawned, or fails to start, is reported like any other install failure", posixOnly, async () => {
  const m = await machine("desk-web-npmspawn-", { npmSpawn: () => { throw new Error("spawn EMFILE") } })
  const { errors } = await launchDegraded(m.options)
  assert.match(errors.join(""), /from the configured npm registry \(spawn EMFILE\)/u)

  const n = await machine("desk-web-npmerror-", {
    npmSpawn: () => {
      const child = fakeChild()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      setImmediate(() => { child.emit("error", new Error("spawn ENOENT")); child.emit("close", 1) })
      return child
    },
  })
  const { errors: errorsK } = await launchDegraded(n.options)
  assert.match(errorsK.join(""), /\(spawn ENOENT\)/u)
})

test("a launch that finds another session installing waits for it, holds the first call, then starts that copy", posixOnly, async () => {
  const refreshes = []
  const m = await machine("desk-web-wait-", { startRefresh: (o) => refreshes.push(o) })
  mkdirSync(m.state, { recursive: true })
  writeFileSync(path.join(m.state, "refresh.lock"), JSON.stringify({ pid: process.pid }))
  setTimeout(() => { preinstall(m.state, "0.0.85", "installs/1-1-a", STUB_CLI); require("node:fs").unlinkSync(path.join(m.state, "refresh.lock")) }, 300)
  const h = host(m.options)
  await h.handshake()
  const answer = await h.call(2)
  assert.match(answer.result.content[0].text, /^ran browser_navigate/u)
  assert.match(h.errors.join(""), /@playwright\/mcp 0\.0\.85/u)
  assert.deepEqual(m.calls(), [])
  assert.equal(refreshes.length, 1)
  await h.close()
})

test("a launch gives up when another session's install outlasts the time limit", posixOnly, async () => {
  const m = await machine("desk-web-waitlong-", { firstInstallMs: 0 })
  mkdirSync(m.state, { recursive: true })
  writeFileSync(path.join(m.state, "refresh.lock"), JSON.stringify({ pid: process.pid }))
  const { errors } = await launchDegraded(m.options)
  assert.match(errors.join(""), /\(another Desk session was still installing it\)/u)
})

test("a state folder that cannot hold an install fails the launch and releases the lock", posixOnly, async () => {
  const m = await machine("desk-web-badstate-")
  touch(path.join(m.state, "installs"), "a file where a folder belongs")
  const { errors, exits } = await launchDegraded(m.options)
  assert.deepEqual(exits, [])
  assert.match(errors.join(""), /could not start the browser: ENOTDIR.*serving degraded:launch_failed/u)
  assert.equal(existsSync(path.join(m.state, "refresh.lock")), false)
})

// ---- the refresh ----

async function refreshMachine(prefix, env = {}) {
  const m = await machine(prefix, { env })
  return { ...m, refresh: (extra = {}) => browser.refresh({ env: m.options.env, platform: "linux", node: m.install.node, npmCli: m.install.cli, ...extra }) }
}

test("a refresh that finds the channel unchanged installs nothing", posixOnly, async () => {
  const m = await refreshMachine("desk-web-same-", { FAKE_NPM_VERSION: "0.0.81" })
  preinstall(m.state, "0.0.81")
  assert.deepEqual(await m.refresh(), { ok: true, version: "0.0.81", changed: false })
  assert.deepEqual(m.calls().map((call) => call.args[0]), ["view"])
  assert.deepEqual(JSON.parse(readFileSync(path.join(m.state, "last-refresh.json"), "utf8")).result, { ok: true, version: "0.0.81", changed: false })
  assert.equal(existsSync(path.join(m.state, "refresh.lock")), false)
})

test("a refresh that finds a new release installs it beside the old one and switches the pointer", posixOnly, async () => {
  const m = await refreshMachine("desk-web-new-", { FAKE_NPM_VERSION: "0.0.83" })
  preinstall(m.state, "0.0.81")
  assert.deepEqual(await m.refresh(), { ok: true, version: "0.0.83", changed: true })
  const pointer = JSON.parse(readFileSync(path.join(m.state, "current.json"), "utf8"))
  assert.equal(pointer.version, "0.0.83")
  assert.equal(pointer.previous, "installs/1-1-a")
  assert.equal(browser.readInstalled(m.state).version, "0.0.83")
  assert.equal(readdirSync(path.join(m.state, "installs")).length, 2, "the previous copy stays for sessions still running it")
  assert.deepEqual(readdirSync(m.state).filter((name) => name.endsWith(".tmp")), [])
})

test("a refresh prunes installs older than a week, except the current and previous ones", posixOnly, async () => {
  const m = await refreshMachine("desk-web-prune-", { FAKE_NPM_VERSION: "0.0.84" })
  preinstall(m.state, "0.0.80", "installs/0-old")
  preinstall(m.state, "0.0.81", "installs/1-young")
  preinstall(m.state, "0.0.82", "installs/2-previous")
  const stuck = path.join(m.state, "installs", "3-stuck")
  touch(path.join(stuck, "locked", "file"))
  chmodSync(path.join(stuck, "locked"), 0o500)
  const week = 8 * 24 * 60 * 60 * 1000
  for (const id of ["0-old", "2-previous", "3-stuck"]) utimesSync(path.join(m.state, "installs", id), new Date(Date.now() - week), new Date(Date.now() - week))
  try {
    assert.equal((await m.refresh()).changed, true)
  } finally {
    chmodSync(path.join(stuck, "locked"), 0o700)
  }
  const left = readdirSync(path.join(m.state, "installs"))
  assert.equal(left.length, 4)
  for (const id of ["1-young", "2-previous", "3-stuck"]) assert.ok(left.includes(id), id)
  assert.ok(!left.includes("0-old"))
})

test("a refresh records a registry failure, an empty answer and a failed install without touching the installed copy", posixOnly, async () => {
  for (const [mode, error] of [["fail", "ENOTCONN: network unreachable"], ["emptyview", "npm view exited with code 0"]]) {
    const m = await refreshMachine("desk-web-refail-", { FAKE_NPM_MODE: mode })
    preinstall(m.state, "0.0.81")
    assert.deepEqual(await m.refresh(), { ok: false, error })
    assert.equal(browser.readInstalled(m.state).version, "0.0.81")
  }
  const m = await refreshMachine("desk-web-refail2-", { FAKE_NPM_MODE: "silent", FAKE_NPM_VERSION: "0.0.99" })
  assert.deepEqual(await m.refresh(), { ok: false, error: "npm install exited with code 0" })
  assert.equal(browser.readInstalled(m.state), null)
})

test("a refresh skips while another session holds the lock, and survives a state folder it cannot write", posixOnly, async () => {
  const m = await refreshMachine("desk-web-busy-")
  mkdirSync(m.state, { recursive: true })
  writeFileSync(path.join(m.state, "refresh.lock"), JSON.stringify({ pid: process.pid }))
  assert.deepEqual(await m.refresh(), { ok: true, skipped: "another Desk session holds the refresh lock" })
  assert.deepEqual(m.calls(), [])

  const n = await refreshMachine("desk-web-norecord-", { FAKE_NPM_VERSION: "0.0.81" })
  preinstall(n.state, "0.0.81")
  mkdirSync(path.join(n.state, "last-refresh.json", "x"), { recursive: true })
  assert.deepEqual(await n.refresh(), { ok: true, version: "0.0.81", changed: false })
  assert.equal(existsSync(path.join(n.state, "refresh.lock")), false, "a lost record never keeps the lock")

  const root = await mkTempRoot("desk-web-nostate-")
  touch(path.join(root, "file"))
  const result = await browser.refresh({ env: { DESK_BROWSER_STATE_DIR: path.join(root, "file", "state") }, npmCli: n.install.cli })
  assert.equal(result.ok, false)
  assert.match(result.error, /EEXIST|ENOTDIR/u)
})

test("a refresh never removes a lock that another session took over", posixOnly, async () => {
  const m = await refreshMachine("desk-web-steal-", { FAKE_NPM_MODE: "steal", FAKE_NPM_VERSION: "0.0.81" })
  preinstall(m.state, "0.0.81")
  assert.deepEqual(await m.refresh(), { ok: true, version: "0.0.81", changed: false })
  assert.equal(JSON.parse(readFileSync(path.join(m.state, "refresh.lock"), "utf8")).pid, 1)
})

test("a refresh that cannot start is ignored, never a crash in the launch", async () => {
  const child = browser.startRefresh({ node: path.join(await mkTempRoot("desk-web-nonode-refresh-"), "missing-node"), npmCli: "npm-cli.js", env: {} })
  await new Promise((resolve) => child.on("error", resolve))
})

test("a refresh fills its options from the real process", posixOnly, async () => {
  const root = await mkTempRoot("desk-web-refdefaults-")
  const install = nodeInstall(path.join(root, "node"))
  const state = path.join(root, "state")
  const saved = { ...process.env }
  Object.assign(process.env, { DESK_BROWSER_STATE_DIR: state, FAKE_NPM_VERSION: "0.0.86" })
  try {
    assert.deepEqual(await browser.refresh({ npmCli: install.cli }), { ok: true, version: "0.0.86", changed: true })
  } finally {
    for (const key of ["DESK_BROWSER_STATE_DIR", "FAKE_NPM_VERSION"]) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]
  }
})

test("the launch starts the real refresh detached, and it brings the copy up to the channel", posixOnly, async () => {
  const m = await machine("desk-web-detached-", { env: { FAKE_NPM_VERSION: "0.0.87" }, startRefresh: undefined })
  preinstall(m.state, "0.0.81")
  const l = launch(m.options)
  await l.ready
  assert.match(l.errors.join(""), /0\.0\.81/u, "this session starts the copy it found")
  const record = path.join(m.state, "last-refresh.json")
  for (let tries = 0; tries < 100 && !existsSync(record); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100))
  assert.deepEqual(JSON.parse(readFileSync(record, "utf8")).result, { ok: true, version: "0.0.87", changed: true })
  assert.equal(browser.readInstalled(m.state).version, "0.0.87", "the next session starts the new release")
  l.child.emit("exit", 0, null)
})

// ---- run: failures before any install ----

test("with no compatible Node the launcher names the fix and serves the browser as degraded, never a silent exit", async () => {
  const m = await machine("desk-web-nonode-")
  const old = path.join(m.root, "old", "node")
  const { errors, exits, responses } = await launchDegraded(
    { ...m.options, current: { path: old, version: "v16.20.2", abi: "93" } },
    [{ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "browser_navigate" } }],
  )
  assert.deepEqual(exits, [])
  assert.match(errors.join(""), /Desk needs Node\.js >=20\.0\.0 to start the browser; this one is v16\.20\.2.*serving degraded:node_missing/u)
  const payload = toolPayload(responses[0])
  assert.equal(payload.code, "node_missing")
  assert.match(payload.fix, /Install Node >=20\.0\.0, then reconnect the desk-web MCP server/u)
})

test("a Node with no npm beside it is named and served as degraded, never a silent exit", async () => {
  const root = await mkTempRoot("desk-web-nonpm-")
  const node = touch(path.join(root, "bin", "node"))
  const { errors, exits } = await launchDegraded({
    env: { PATH: "/usr/bin" }, platform: "linux", arch: "x64", homeDir: root, systemPrefix: root,
    current: { path: node, version: "v22.9.0", abi: "127" }, now: () => 0, probe: () => null,
  })
  assert.deepEqual(exits, [])
  assert.match(errors.join(""), /has no npm beside it.*serving degraded:npm_missing/u)
})

test("a Node that cannot be spawned is named and served as degraded, never a silent exit", posixOnly, async () => {
  const m = await machine("desk-web-spawnfail-", { startRefresh: () => {} })
  preinstall(m.state)
  const l = launch(m.options)
  await l.ready
  l.child.emit("error", new Error("spawn EACCES"))
  await l.running
  assert.deepEqual(l.exits, [])
  assert.match(l.errors.join(""), /could not start it: spawn EACCES.*serving degraded:node_spawn_failed/u)
})

test("the degraded responder completes a full JSON-RPC handshake: initialize with and without a protocol version, ping, tools/list, an unknown method, and a line that is not JSON", async () => {
  const m = await machine("desk-web-nonode-handshake-")
  const old = path.join(m.root, "old", "node")
  const { responses } = await launchDegraded(
    { ...m.options, current: { path: old, version: "v16.20.2", abi: "93" } },
    [
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26" } },
      { jsonrpc: "2.0", id: 1, method: "initialize" },
      { jsonrpc: "2.0", id: 2, method: "ping" },
      { jsonrpc: "2.0", id: 3, method: "tools/list" },
      { jsonrpc: "2.0", id: 4, method: "prompts/list" },
    ],
  )
  const [withVersion, bare, ping, list, unknown] = responses
  assert.equal(withVersion.id, 0)
  assert.equal(withVersion.result.protocolVersion, "2025-03-26")
  assert.deepEqual(withVersion.result.capabilities, { tools: { listChanged: true } })
  assert.match(withVersion.result.instructions, /reconnect the desk-web MCP server/u)
  assert.equal(bare.id, 1)
  assert.equal(bare.result.protocolVersion, "2025-06-18")
  assert.deepEqual(ping.result, {})
  assert.deepEqual(list.result.tools.map((tool) => tool.name), browser.BROWSER_TOOL_NAMES)
  assert.equal(unknown.error.code, -32601)
  assert.match(unknown.error.message, /prompts\/list/u)

  const input = new PassThrough()
  const output = new PassThrough()
  const read = collect(output)
  const running = browser.run({ ...m.options, current: { path: old, version: "v16.20.2", abi: "93" }, stdin: input, stdout: output, stderr: { write: () => {} } })
  input.end("not json\n")
  await running
  assert.equal(read()[0].error.code, -32700)
})

test("the degraded responder never crashes on a line that is valid JSON but not a request object: null, a boolean, a number, an array, a bare string", async () => {
  const m = await machine("desk-web-nonobject-")
  const old = path.join(m.root, "old", "node")
  const { responses } = await launchDegraded(
    { ...m.options, current: { path: old, version: "v16.20.2", abi: "93" } },
    [null, true, 42, [], "hi"],
  )
  assert.equal(responses.length, 5)
  for (const response of responses) {
    assert.deepEqual(response, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } })
  }
})

test("the degraded responder tolerates a stdin double with no resume method", async () => {
  const output = new PassThrough()
  const handlers = {}
  const stdin = {
    setEncoding: () => {},
    on: (event, handler) => { handlers[event] = handler },
    removeListener: () => {},
  }
  const running = browser.serveDegraded({ stdin, stdout: output, payload: { status: "degraded", state: "degraded:x", code: "x", fix: "f" } })
  handlers.end()
  await running
})

test("anything that throws while starting is one stderr line and a degraded launch_failed, never a crash or a silent exit", async () => {
  for (const [thrown, expected] of [
    [new Error("disk gone"), /could not start the browser: disk gone.*serving degraded:launch_failed/u],
    ["plain text", /could not start the browser: plain text.*serving degraded:launch_failed/u],
  ]) {
    const m = await machine("desk-web-throw-", { exists: () => { throw thrown } })
    const { errors, exits } = await launchDegraded(m.options)
    assert.deepEqual(exits, [])
    assert.match(errors.join(""), expected)
  }
})

test("run fills every other option from the real process", async () => {
  const state = await mkTempRoot("desk-web-defaults-")
  const cli = preinstall(state)
  const refreshes = []
  const spawns = []
  const child = fakeChild()
  const running = browser.run({
    env: { PATH: path.dirname(process.execPath), HOME: "/nonexistent", DESK_NODE_SYSTEM_PREFIX: "/nonexistent-prefix", DESK_BROWSER_STATE_DIR: state },
    spawn: (file, argv) => { spawns.push([file, argv]); setImmediate(() => child.emit("exit", 0, null)); return child },
    startRefresh: (o) => refreshes.push(o),
    exit: () => {},
    stderr: { write: () => {} },
  })
  await running
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0][0], process.execPath)
  assert.equal(spawns[0][1][0], cli)
  assert.match(refreshes[0].npmCli, /npm-cli\.js$/u)
  const callerArgs = process.argv.slice(2)
  assert.deepEqual(spawns[0][1].slice(spawns[0][1].length - callerArgs.length), callerArgs)
})

test("run finds HOME through USERPROFILE and the running system's home", async () => {
  for (const env of [{ PATH: "", USERPROFILE: "/nonexistent-profile" }, { PATH: "" }]) {
    const { errors, exits } = await launchDegraded({ env, platform: "linux", current: { path: "/nonexistent/node", version: "v16.20.2", abi: "93" }, now: () => 0, probe: () => null })
    assert.deepEqual(exits, [])
    assert.match(errors.join(""), /serving degraded:node_missing/u)
  }
})

// ---- the host configs ----

test("the Claude and Copilot configs declare the web server beside Desk, never a bare playwright name", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(claude), ["desk", "desk-web"])
  const server = claude["desk-web"]
  assert.deepEqual(Object.keys(server), ["type", "command", "args", "cwd", "env"])
  assert.equal(server.type, "stdio")
  assert.equal(server.command, "node")
  assert.equal(server.args[0], "-e")
  assert.doesNotMatch(server.args[1], /\$\{|=>|`|\?\.|\blet\s|\bconst\s/u)
  assert.match(server.args[1], /require\(path\.join\(root, 'mcp', 'web\.cjs'\)\)\.run\(\{ args: \[\] \}\)/u)
  assert.equal(server.cwd, ".")
  assert.deepEqual(server.env, { DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" })
  const copilot = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.copilot.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(copilot), ["desk", "desk-web"])
  assert.deepEqual(copilot["desk-web"], { type: "stdio", command: "node", args: ["${COPILOT_PLUGIN_ROOT}/mcp/web.cjs"], env: {} })
})

// ---- the tool catalog never changes under the host ----

test("the inline launcher's degraded tool names, the degraded catalog and the first-use catalog all list the browser's tools in one order", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers["desk-web"]
  const inline = /var names = (\[[^\]]*\]);/u.exec(claude.args[1])
  assert.ok(inline, "the inline launcher declares its own list of browser tool names")
  assert.deepEqual(JSON.parse(inline[1].replace(/'/gu, '"')), browser.BROWSER_TOOL_NAMES)
  const snapshot = JSON.parse(readFileSync(path.join(mcpRoot, "web-catalog.json"), "utf8")).tools
  assert.deepEqual(snapshot.map((tool) => tool.name), browser.BROWSER_TOOL_NAMES)
  for (const tool of snapshot) {
    assert.equal(typeof tool.description, "string", tool.name)
    assert.equal(tool.inputSchema.type, "object", tool.name)
  }
})

test("a first launch answers tools/list with the same snapshot every time, and with the degraded list when no usable snapshot exists", posixOnly, async () => {
  const m = await machine("desk-web-catalog-", { env: { FAKE_NPM_MODE: "fail" } })
  const h = host(m.options)
  await h.handshake()
  const first = await h.ask(2, "tools/list")
  const second = await h.ask(3, "tools/list")
  assert.deepEqual(first.result, second.result)
  assert.deepEqual(first.result.tools, JSON.parse(readFileSync(path.join(mcpRoot, "web-catalog.json"), "utf8")).tools)
  assert.ok(first.result.tools.some((tool) => tool.name === "browser_navigate" && tool.inputSchema.properties.url), "real input schemas, not placeholders")
  await h.close()

  const dir = await mkTempRoot("desk-web-nocatalog-")
  for (const [name, text] of [["missing.json", null], ["empty.json", JSON.stringify({ tools: [] })], ["junk.json", "not json"]]) {
    if (text !== null) writeFileSync(path.join(dir, name), text)
    const n = await machine("desk-web-nocatalog-", { env: { FAKE_NPM_MODE: "fail" }, catalogFile: path.join(dir, name) })
    const g = host(n.options)
    await g.handshake()
    const list = await g.ask(2, "tools/list")
    assert.deepEqual(list.result.tools.map((tool) => tool.name), browser.BROWSER_TOOL_NAMES)
    assert.deepEqual(list.result.tools[0].inputSchema, { type: "object", properties: {}, additionalProperties: true })
    await g.close()
  }
})

test("a host that calls the browser while the install still runs gets the answer, never an error and never a list_changed", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-web-hostflow-")
  const session = await openSession({ command: process.execPath, args: [path.join(fixture.plugin, "mcp", "web.cjs")], cwd: fixture.root, env: { ...fixture.env, FAKE_NPM_DELAY_MS: "1500" } })
  assert.doesNotMatch(session.stderr(), /@playwright\/mcp 0/u, "the install is still running when the host sends the call")
  const sent = Date.now()
  const answer = await session.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, { timeout: 30000 })
  assert.ok(Date.now() - sent > 500, "the call waited for the install")
  assert.equal(answer.error, undefined)
  assert.equal(answer.result.isError, undefined)
  assert.match(answer.result.content[0].text, /^ran browser_navigate/u)
  assert.deepEqual(session.notifications, [])
  await session.close()
})

test("an install that fails answers held and later calls with the code and the fix, and keeps the tool list", posixOnly, async () => {
  const m = await machine("desk-web-installfail-", { env: { FAKE_NPM_MODE: "fail" } })
  const h = host(m.options)
  await h.handshake()
  const held = await h.call(2)
  assert.equal(held.result.isError, true)
  assert.equal(toolPayload(held).state, "degraded:install_failed")
  assert.match(toolPayload(held).fix, /reconnect the desk-web MCP server/u)
  const later = await h.call(3)
  assert.equal(toolPayload(later).code, "install_failed")
  assert.equal((await h.ask(4, "tools/list")).result.tools.length, browser.BROWSER_TOOL_NAMES.length)
  await h.close()
})

test("a call that waits longer than the hold limit is answered with a retry hint, and the next call gets the browser the install finished", posixOnly, async () => {
  const m = await machine("desk-web-holdlimit-", { env: { FAKE_NPM_DELAY_MS: "1200" }, holdMs: 100 })
  const h = host(m.options)
  await h.handshake()
  const early = await h.call(2)
  assert.equal(toolPayload(early).code, "browser_not_ready")
  assert.equal(early.result.isError, true)
  assert.match(toolPayload(early).fix, /again in a minute/u)
  await until(() => /@playwright\/mcp 0/u.test(h.errors.join("")), "the install to finish")
  assert.match((await h.call(3)).result.content[0].text, /^ran browser_navigate/u)
  await h.close()
})

test("the first-use server answers the protocol itself: ping, initialize with and without a version, unknown methods, bad lines", posixOnly, async () => {
  const m = await machine("desk-web-protocol-", { env: { FAKE_NPM_MODE: "fail" } })
  const h = host(m.options)
  const init = await h.ask(1, "initialize", { protocolVersion: "2025-03-26" })
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: false } })
  assert.equal(init.result.protocolVersion, "2025-03-26")
  assert.equal((await h.ask(2, "initialize")).result.protocolVersion, "2025-06-18")
  assert.deepEqual((await h.ask(3, "ping")).result, {})
  assert.equal((await h.ask(4, "prompts/list")).error.code, -32601)
  h.stdin.write("\n   \nnot json\n[1]\nnull\n7\n")
  await until(() => h.read().filter((message) => message.id === null).length === 4, "four error answers")
  assert.deepEqual(h.read().filter((message) => message.id === null).map((message) => message.error.code), [-32700, -32600, -32600, -32600])
  h.send({ method: "notifications/unknown" })
  h.send({ method: "notifications/cancelled", params: { requestId: "nothing" } })
  assert.equal((await h.ask(5, "ping")).id, 5)
  // A request whose params are not a call still reaches the held-call path with a name.
  await h.close()
})

test("a held call can be cancelled by the host: it is dropped and never answered", posixOnly, async () => {
  const m = await machine("desk-web-cancelheld-", { env: { FAKE_NPM_MODE: "fail", FAKE_NPM_DELAY_MS: "300" } })
  const h = host(m.options)
  await h.handshake()
  h.send({ id: 7, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  h.send({ method: "notifications/cancelled", params: { requestId: 7 } })
  h.send({ id: 8, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  assert.equal(toolPayload(await h.reply(8)).code, "install_failed")
  assert.equal(h.read().some((message) => message.id === 7), false)
  await h.close()
})

test("a running call can be cancelled: the browser hears the cancel under its own request id", posixOnly, async () => {
  const m = await machine("desk-web-cancelrun-", { env: { FAKE_CLI_MODE: "slow" } })
  const h = host(m.options)
  await h.handshake()
  h.send({ id: 9, method: "tools/call", params: { name: "browser_wait_for", arguments: {} } })
  await until(() => /slow call 1/u.test(h.errors.join("")), "the browser to take the call")
  h.send({ method: "notifications/cancelled", params: { requestId: 9, reason: "user" } })
  h.send({ method: "notifications/cancelled", params: { requestId: 123 } })
  await until(() => /cancelled 1/u.test(h.errors.join("")), "the browser to hear the cancel")
  await h.close()
})

test("the browser's own notices pass through, but its tools/list_changed never reaches the host and its requests are refused", posixOnly, async () => {
  const m = await machine("desk-web-notices-", { env: { FAKE_CLI_MODE: "list_changed" } })
  const h = host(m.options)
  await h.handshake()
  const answer = await h.call(2)
  assert.equal(answer.result.isError, undefined)
  const notices = h.read().filter((message) => message.id === undefined)
  assert.deepEqual(notices.map((message) => message.method), ["notifications/message"])
  assert.equal(notices[0].params.data, "log line")
  await h.close()

  const n = await machine("desk-web-roots-", { env: { FAKE_CLI_MODE: "roots" } })
  const g = host(n.options)
  await g.handshake()
  await g.call(2)
  await until(() => /host answered 99 .*Method not found: roots\/list/u.test(g.errors.join("")), "the refusal of the browser's request")
  await g.close()
})

test("an error the browser gives for a call reaches the host unchanged", posixOnly, async () => {
  const m = await machine("desk-web-rpcerror-", { env: { FAKE_CLI_MODE: "rpcerror" } })
  const h = host(m.options)
  await h.handshake()
  const answer = await h.call(2)
  assert.deepEqual(answer.error, { code: -32602, message: "bad arguments" })
  await h.close()
})

test("a browser that ends during a call answers it with the reason, then ends the launcher with the same exit code or signal", posixOnly, async () => {
  const m = await machine("desk-web-crash-", { env: { FAKE_CLI_MODE: "crash" } })
  const h = host(m.options)
  await h.handshake()
  const answer = await h.call(2)
  assert.equal(toolPayload(answer).code, "browser_exited")
  assert.match(toolPayload(answer).summary, /exit code 3/u)
  await h.running
  assert.deepEqual(h.exits, [3])

  const n = await machine("desk-web-sig-", {})
  const children = []
  const g = host({ ...n.options, spawn: (...argv) => { const child = spawn(...argv); children.push(child); return child } })
  await g.handshake()
  await g.call(2)
  g.signals.emit("SIGTERM")
  await g.running
  assert.deepEqual(g.kills, ["SIGTERM"])
  assert.deepEqual(g.exits, [])
})

test("a browser that cannot start answers calls with the reason instead of failing the server", posixOnly, async () => {
  const missing = await machine("desk-web-nostart-", { spawn: () => { throw new Error("spawn EAGAIN") } })
  const h = host(missing.options)
  await h.handshake()
  const answer = await h.call(2)
  assert.equal(toolPayload(answer).code, "node_spawn_failed")
  assert.match(toolPayload(answer).summary, /spawn EAGAIN/u)
  assert.equal(toolPayload(await h.call(3)).code, "node_spawn_failed")
  await h.close()

  const gone = await machine("desk-web-enoent-", { spawn: (file, argv, options) => spawn(path.join(path.dirname(file), "no-such-node"), argv, options) })
  const g = host(gone.options)
  await g.handshake()
  assert.equal(toolPayload(await g.call(2)).code, "node_spawn_failed")
  await g.close()

  const refused = await machine("desk-web-badinit-", { env: { FAKE_CLI_MODE: "badinit" } })
  const r = host(refused.options)
  await r.handshake()
  const refusal = await r.call(2)
  assert.equal(toolPayload(refusal).code, "node_spawn_failed")
  assert.match(toolPayload(refusal).summary, /no handshake today/u)
  await r.close()
})

test("an error on a running browser is noted on stderr and does not fail its calls", posixOnly, async () => {
  const m = await machine("desk-web-childerror-")
  const children = []
  const h = host({ ...m.options, spawn: (...argv) => { const child = spawn(...argv); children.push(child); return child } })
  await h.handshake()
  await h.call(2)
  children[0].emit("error", new Error("kill failed"))
  assert.match(h.errors.join(""), /\[web\] kill failed/u)
  assert.equal((await h.call(3)).result.isError, undefined)
  await h.close()
})

test("a host that goes away before the install finishes starts no browser, and one that goes away later stops it, by force if it ignores that", posixOnly, async () => {
  const m = await machine("desk-web-hostgone-", { env: { FAKE_NPM_DELAY_MS: "300" } })
  const spawns = []
  const early = host({ ...m.options, spawn: (...argv) => { spawns.push(argv); return spawn(...argv) } })
  await early.handshake()
  early.send({ id: 5, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await early.close()
  assert.equal(spawns.length, 0)
  assert.equal(browser.readInstalled(m.state).version, "0.0.82", "the install still finishes, so the next launch has its browser")

  const failed = await machine("desk-web-hostgone-fail-", { env: { FAKE_NPM_MODE: "fail" } })
  const gone = host(failed.options)
  gone.stdin.end()
  await gone.running

  const stubborn = await machine("desk-web-stubborn-", { env: { FAKE_CLI_MODE: "stubborn" }, closeMs: 100 })
  const h = host(stubborn.options)
  await h.handshake()
  await h.call(2)
  await h.close()
  assert.deepEqual(h.kills, ["SIGTERM"], "the browser was ended by signal because it ignored its closed stdin")
})

/** A child that never started: no pid, and streams a launcher can write to. */
function unstartedChild() {
  const child = fakeChild()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  return child
}

test("a browser that ends before it takes any call answers the held call with the reason and keeps serving", posixOnly, async () => {
  const m = await machine("desk-web-dieearly-")
  const fake = unstartedChild()
  const h = host({ ...m.options, spawn: () => fake })
  await h.handshake()
  h.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await until(() => fake.stdin.readableLength > 0, "the handshake to reach the browser")
  fake.emit("exit", 4, null)
  const answer = await h.reply(2)
  assert.equal(toolPayload(answer).code, "browser_exited")
  assert.match(toolPayload(answer).summary, /exit code 4/u)
  assert.equal(toolPayload(await h.call(3)).code, "browser_exited")
  assert.deepEqual(h.exits, [])
  await h.close()
})

test("a browser that fails while the host is already gone ends the launcher quietly", posixOnly, async () => {
  const early = await machine("desk-web-gonedie-", { env: { FAKE_CLI_MODE: "dieearly" } })
  const spawned = []
  const h = host({ ...early.options, spawn: (...argv) => { const child = spawn(...argv); spawned.push(child); return child } })
  await h.handshake()
  h.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await until(() => spawned.length > 0, "the browser to start")
  h.stdin.end()
  await h.running
  assert.equal(toolPayload(await h.reply(2)).code, "browser_exited")

  const noExit = await machine("desk-web-gonenoexit-")
  const fake = unstartedChild()
  const g = host({ ...noExit.options, spawn: () => fake })
  await g.handshake()
  g.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await until(() => fake.stdin.readableLength > 0, "the handshake to reach the browser")
  g.stdin.end()
  await new Promise((resolve) => setTimeout(resolve, 30))
  fake.stdin.emit("error", new Error("EPIPE"))
  fake.emit("exit", 4, null)
  await g.running

  const noStart = await machine("desk-web-gonenostart-")
  const never = unstartedChild()
  const k = host({ ...noStart.options, spawn: () => never })
  await k.handshake()
  k.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await until(() => never.stdin.readableLength > 0, "the handshake to reach the browser")
  k.stdin.end()
  await new Promise((resolve) => setTimeout(resolve, 30))
  never.emit("error", new Error("spawn ENOENT"))
  await k.running
  assert.equal(toolPayload(await k.reply(2)).code, "node_spawn_failed")
})

// ---- the snapshot is checked against the installed browser ----

async function snapshotFile(tools, version = "9.9.9") {
  const dir = await mkTempRoot("desk-web-snapshot-")
  const file = path.join(dir, "web-catalog.json")
  writeFileSync(file, JSON.stringify({ playwrightMcpVersion: version, tools }))
  return file
}

test("the snapshot records the Playwright MCP release it came from", () => {
  const snapshot = JSON.parse(readFileSync(path.join(mcpRoot, "web-catalog.json"), "utf8"))
  assert.match(snapshot.playwrightMcpVersion, /^\d+\.\d+\.\d+/u)
})

test("when the installed browser lists different tools, one stderr line names what was added, removed and changed, and the snapshot is still served", posixOnly, async () => {
  const catalogFile = await snapshotFile([{ name: "stub_tool", description: "older text", inputSchema: { type: "object" } }, { name: "old_tool", inputSchema: { type: "object" } }])
  const m = await machine("desk-web-drift-", { env: { FAKE_CLI_MODE: "extra" }, catalogFile })
  const h = host(m.options)
  await h.handshake()
  await h.call(2)
  await until(() => /differs from the snapshot/u.test(h.errors.join("")), "the comparison")
  assert.match(h.errors.join(""), /\[web\] the installed browser's tool list differs from the snapshot \(Playwright MCP 9\.9\.9\) this session keeps serving: added new_tool; removed old_tool; changed stub_tool\n/u)
  assert.deepEqual((await h.ask(3, "tools/list")).result.tools.map((tool) => tool.name), ["stub_tool", "old_tool"])
  assert.equal(h.read().filter((message) => message.method === "notifications/tools/list_changed").length, 0)
  await h.close()
})

test("an installed browser whose tools match the snapshot, whatever the key order, or that cannot list them, produces no comparison line", posixOnly, async () => {
  for (const [mode, tools] of [["ok", [{ inputSchema: { type: "object" }, name: "stub_tool" }]], ["badlist", [{ name: "other" }]]]) {
    const catalogFile = await snapshotFile(tools)
    const m = await machine("desk-web-nodrift-", { env: { FAKE_CLI_MODE: mode }, catalogFile })
    const h = host(m.options)
    await h.handshake()
    await h.call(2)
    await new Promise((resolve) => setTimeout(resolve, 200))
    assert.doesNotMatch(h.errors.join(""), /differs from the snapshot/u)
    await h.close()
  }
})

// ---- the hold keeps the host waiting, and recovers ----

test("a held call with a progress token gets progress notices while it waits, and none once it is answered", posixOnly, async () => {
  const m = await machine("desk-web-progress-", { env: { FAKE_NPM_DELAY_MS: "700" }, progressMs: 100 })
  const h = host(m.options)
  await h.handshake()
  h.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {}, _meta: { progressToken: 0 } } })
  h.send({ id: 3, method: "tools/call", params: { name: "browser_snapshot", arguments: {} } })
  const answer = await h.reply(2)
  await h.reply(3)
  assert.equal(answer.result.isError, undefined)
  const notices = h.read().filter((message) => message.method === "notifications/progress")
  assert.ok(notices.length >= 2, `${notices.length} progress notices`)
  assert.deepEqual(notices.map((message) => message.params.progressToken), notices.map(() => 0))
  assert.deepEqual(notices.map((message) => message.params.progress), notices.map((_, index) => index + 1))
  const count = notices.length
  await new Promise((resolve) => setTimeout(resolve, 300))
  assert.equal(h.read().filter((message) => message.method === "notifications/progress").length, count)
  await h.close()
})

test("a call cancelled or timed out while held stops its progress notices", posixOnly, async () => {
  const m = await machine("desk-web-progressstop-", { env: { FAKE_NPM_DELAY_MS: "900" }, progressMs: 50, holdMs: 200 })
  const h = host(m.options)
  await h.handshake()
  h.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {}, _meta: { progressToken: "a" } } })
  h.send({ method: "notifications/cancelled", params: { requestId: 2 } })
  h.send({ id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: {}, _meta: { progressToken: "b" } } })
  assert.equal(toolPayload(await h.reply(3)).code, "browser_not_ready")
  const seen = h.read().filter((message) => message.method === "notifications/progress")
  assert.deepEqual([...new Set(seen.map((message) => message.params.progressToken))], ["b"])
  const count = seen.length
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(h.read().filter((message) => message.method === "notifications/progress").length, count)
  await h.close()
})

test("a call that follows a lock-wait timeout starts the install again, so it succeeds once the other session is done", posixOnly, async () => {
  const m = await machine("desk-web-retry-", { firstInstallMs: 0, startRefresh: () => {} })
  mkdirSync(m.state, { recursive: true })
  const lock = path.join(m.state, "refresh.lock")
  writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  const h = host(m.options)
  await h.handshake()
  const first = await h.call(2)
  assert.equal(toolPayload(first).code, "install_failed")
  assert.match(toolPayload(first).summary, /another Desk session was still installing it/u)
  preinstall(m.state, "0.0.88", "installs/1-1-a", STUB_CLI)
  require("node:fs").unlinkSync(lock)
  const second = await h.call(3)
  assert.equal(second.result.isError, undefined)
  assert.match(second.result.content[0].text, /^ran browser_navigate/u)
  await h.close()
})

test("a real install error stays the answer for every later call, with no second install", posixOnly, async () => {
  const m = await machine("desk-web-sticky-", { env: { FAKE_NPM_MODE: "fail" } })
  const h = host(m.options)
  await h.handshake()
  assert.equal(toolPayload(await h.call(2)).code, "install_failed")
  assert.equal(toolPayload(await h.call(3)).code, "install_failed")
  assert.equal(m.calls().filter((call) => call.args[0] === "install").length, 1)
  await h.close()
})

// ---- stop signals end the install ----

test("a stop signal during the first install ends npm and everything it started, then ends the launcher with that signal", posixOnly, async () => {
  const grandchildFile = path.join(await mkTempRoot("desk-web-grand-"), "pid")
  const m = await machine("desk-web-signal-", { env: { FAKE_NPM_MODE: "grandchild", FAKE_NPM_GRANDCHILD: grandchildFile } })
  const npms = []
  const h = host({ ...m.options, npmSpawn: (...argv) => { const child = spawn(...argv); npms.push(child); return child } })
  await h.handshake()
  const grandchild = Number(await until(() => (existsSync(grandchildFile) ? readFileSync(grandchildFile, "utf8") : ""), "the install to start its helper"))
  const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
  assert.equal(alive(grandchild), true)
  h.signals.emit("SIGHUP")
  await h.running
  assert.deepEqual(h.kills, ["SIGHUP"])
  await until(() => npms[0].exitCode !== null || npms[0].signalCode !== null, "npm to end")
  await until(() => !alive(grandchild), "the helper to end")
  assert.equal(h.signals.listenerCount("SIGHUP"), 0, "the handlers are removed")
})

test("stopping installs falls back to the npm process when it has no process group, and on Windows", () => {
  const killed = []
  const child = { pid: undefined, kill: (signal) => killed.push(signal) }
  browser.stopInstalls({ platform: "linux", children: [child] })
  browser.stopInstalls({ platform: "win32", children: [child] })
  assert.deepEqual(killed, ["SIGTERM", "SIGTERM"])
})

// ---- small protocol details ----

test("a ping from the browser is answered, and lines that arrive in pieces are put together on both sides", posixOnly, async () => {
  const m = await machine("desk-web-pieces-", { env: { FAKE_CLI_MODE: "ping" } })
  const h = host(m.options)
  await h.handshake()
  await h.call(2)
  await until(() => /host answered 55 \{\}/u.test(h.errors.join("")), "the answer to the browser's ping")
  await h.close()

  const n = await machine("desk-web-chunky-", { env: { FAKE_CLI_MODE: "chunky" } })
  const g = host(n.options)
  const line = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })
  g.stdin.write(line.slice(0, 12))
  await new Promise((resolve) => setTimeout(resolve, 20))
  g.stdin.write(line.slice(12, 30))
  g.stdin.write(`${line.slice(30)}\n`)
  await g.reply(1)
  const call = await g.call(2)
  assert.match(call.result.content[0].text, /^ran browser_navigate/u)
  await g.close()
})

// ---- the refresh script ----

test("the catalog script installs the latest release, lists its tools, and rewrites or checks the snapshot", posixOnly, async () => {
  const { run } = await import("../../../../../plugins/desk/mcp/scripts/refresh-web-catalog.mjs")
  const m = await machine("desk-web-script-", { env: { FAKE_NPM_VERSION: "0.0.90" } })
  const catalogFile = await snapshotFile([{ name: "stub_tool", inputSchema: { type: "object" } }, { name: "gone_tool", inputSchema: { type: "object" } }], "0.0.80")
  const output = []
  const io = { out: (text) => output.push(text), err: (text) => output.push(`ERR ${text}`) }
  const args = ["--file", catalogFile, "--npm-cli", m.install.cli]
  const saved = { ...process.env }
  Object.assign(process.env, m.options.env)
  try {
    assert.equal(await run([...args, "--check"], io), 1)
    assert.match(output.join(""), /@playwright\/mcp 0\.0\.90 lists tools that differ from the snapshot \(0\.0\.80\): removed gone_tool/u)
    assert.equal(JSON.parse(readFileSync(catalogFile, "utf8")).playwrightMcpVersion, "0.0.80", "check never writes")
    assert.equal(await run(args, io), 0)
    assert.deepEqual(JSON.parse(readFileSync(catalogFile, "utf8")), { playwrightMcpVersion: "0.0.90", tools: [{ name: "stub_tool", inputSchema: { type: "object" } }] })
    assert.equal(await run([...args, "--check"], io), 0)
    assert.match(output.join(""), /lists the same tools as the snapshot \(0\.0\.90\)/u)
    writeFileSync(catalogFile, JSON.stringify({ playwrightMcpVersion: "0.0.1", tools: [{ name: "stub_tool", inputSchema: { type: "object" } }] }))
    assert.equal(await run([...args, "--check"], io), 0, "a new version with the same tools passes the check")
    assert.equal(await run(args, io), 0)
    assert.equal(JSON.parse(readFileSync(catalogFile, "utf8")).playwrightMcpVersion, "0.0.90", "a rewrite records the new version")
    process.env.FAKE_NPM_MODE = "fail"
    output.length = 0
    assert.equal(await run([...args, "--check"], io), 2)
    assert.match(output.join(""), /ERR npm install @playwright\/mcp@latest failed/u)
    process.env.FAKE_NPM_MODE = "ok"
    process.env.FAKE_CLI_MODE = "badlist"
    output.length = 0
    assert.equal(await run([...args, "--check"], io), 2)
    assert.match(output.join(""), /ERR tools\/list failed: no list/u)
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
    Object.assign(process.env, saved)
  }
})

test("the snapshot workflow runs daily and reports a difference as one issue", () => {
  const workflow = readFileSync(path.join(pluginRoot, "..", "..", ".github", "workflows", "web-catalog-check.yml"), "utf8")
  assert.match(workflow, /^name: Browser catalog snapshot check$/mu)
  assert.match(workflow, /cron: "52 6 \* \* \*"/u)
  assert.match(workflow, /refresh-web-catalog\.mjs --check/u)
  assert.match(workflow, /issues: write/u)
  assert.doesNotMatch(workflow, /pull-requests: write|contents: write/u)
})

// ---- spawned: the real entry points against a fixture plugin ----

/** A fixture plugin with the real launcher files, whose only compatible Node is a wrapper that answers the version probe and otherwise runs this Node, with the fake npm beside it. */
async function fixturePlugin(prefix) {
  const root = await mkTempRoot(prefix)
  const plugin = path.join(root, "plugin")
  mkdirSync(path.join(plugin, "mcp"), { recursive: true })
  copyFileSync(browserPath, path.join(plugin, "mcp", "web.cjs"))
  for (const file of ["bootstrap.cjs", "web-proxy.cjs", "web-catalog.json"]) copyFileSync(path.join(mcpRoot, file), path.join(plugin, "mcp", file))
  // A version folder with a known major needs no probe, so a busy machine cannot run the selection out of time; no real Node is this new.
  writeFileSync(path.join(plugin, "mcp", "package.json"), JSON.stringify({ version: "0.0.0", engines: { node: ">=24.999.0" } }))
  const nodeDir = path.join(root, "home", ".nvm", "versions", "node", "v24.999.0")
  const node = touch(path.join(nodeDir, "bin", "node"), [
    "#!/bin/sh",
    `exec "${process.execPath}" "$@"`,
    "",
  ].join("\n"))
  chmodSync(node, 0o755)
  touch(path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npm-cli.js"), FAKE_NPM)
  const state = path.join(root, "state")
  const log = path.join(root, "npm.log")
  const env = { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin", DESK_NODE_SYSTEM_PREFIX: path.join(root, "none"), NODE_OPTIONS: "", DESK_BROWSER_STATE_DIR: state, FAKE_NPM_LOG: log }
  return { root, plugin, state, log, env }
}

/** Drive a spawned launcher the way a host does (initialize, initialized, tools/list) and send the first browser call at once, while the install is still running. */
async function firstCall({ command = process.execPath, args, env, cwd }) {
  const session = await openSession({ command, args, env, cwd })
  const first = await session.request("tools/call", { name: "browser_navigate", arguments: { url: "https://example.com" } }, { timeout: 8000 }).catch((error) => { throw new Error(error.message + "\n" + session.stderr()) })
  return { session, first }
}

test("the Claude inline launcher finds the plugin through DESK_PLUGIN_ROOT or the working directory, and the first call after a slow install succeeds", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-web-claude-")
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers["desk-web"]
  const { session, first } = await firstCall({ args: claude.args, cwd: fixture.root, env: { ...fixture.env, DESK_PLUGIN_ROOT: fixture.plugin, FAKE_NPM_DELAY_MS: "1500" } })
  assert.ok(session.handshakeMs < 1200, `the handshake took ${session.handshakeMs} ms, so it waited for the install`)
  assert.equal(first.error, undefined)
  assert.equal(first.result.isError, undefined)
  assert.match(first.result.content[0].text, /^ran browser_navigate \{"url":"https:\/\/example\.com"\} \["--headless","--isolated"(,"--browser","msedge"|,"--executable-path","[^"]+")?,"--output-dir","[^"]+state\/output"\]$/u)
  assert.deepEqual(session.notifications, [], "the host never hears that the tool list changed")
  assert.deepEqual((await session.request("tools/list")).result.tools, session.tools.result.tools, "the tool list is the same after the browser took over")
  assert.match(session.stderr(), /\[web\] @playwright\/mcp 0\.0\.82 \(playwright-core 1\.64\.0-test\) from /u)
  await session.close()
  const viaCwd = await openSession({ command: process.execPath, args: claude.args, cwd: fixture.plugin, env: { ...fixture.env, DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" } })
  assert.match((await viaCwd.request("tools/call", { name: "browser_snapshot", arguments: {} })).result.content[0].text, /^ran browser_snapshot/u)
  await viaCwd.close()
})

test("the Claude inline launcher still completes a handshake on this Node when it cannot find the plugin", async () => {
  const cwd = await mkTempRoot("desk-web-noplugin-")
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers["desk-web"]
  const result = spawnSync(process.execPath, claude.args, {
    cwd,
    encoding: "utf8",
    env: { PATH: "/usr/bin:/bin", DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}", NODE_OPTIONS: "" },
    input: [
      { jsonrpc: "2.0", id: 0, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 1, method: "ping" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
      { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_navigate", arguments: {} } },
      { jsonrpc: "2.0", id: "u", method: "prompts/list" },
      { jsonrpc: "2.0", id: 4, method: "initialize" },
    ].map((message) => JSON.stringify(message)).join("\n") + "\nnot json\n",
  })
  assert.equal(result.status, 0, result.stderr)
  const [init, ping, list, status, unknown, bare] = result.stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line))
  assert.equal(init.id, 0)
  assert.equal(init.result.protocolVersion, "2025-03-26")
  assert.deepEqual(init.result.capabilities, { tools: { listChanged: true } })
  assert.deepEqual(ping.result, {})
  assert.deepEqual(list.result.tools.map((tool) => tool.name), browser.BROWSER_TOOL_NAMES)
  assert.equal(toolPayload(status).state, "degraded:plugin_root_missing")
  assert.match(toolPayload(status).fix, /reconnect the desk-web MCP server/u)
  assert.equal(status.result.isError, true)
  assert.equal(unknown.error.code, -32601)
  assert.equal(bare.result.protocolVersion, "2025-06-18")
})

test("the Copilot entry point runs the launcher with its own arguments, and its first call waits for the install instead of failing", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-web-copilot-")
  const { session, first } = await firstCall({ args: [path.join(fixture.plugin, "mcp", "web.cjs"), "--caps", "pdf"], cwd: fixture.root, env: { ...fixture.env, FAKE_NPM_DELAY_MS: "1200" } })
  assert.equal(first.result.isError, undefined)
  assert.match(first.result.content[0].text, /--output-dir","[^"]+","--caps","pdf"\]$/u)
  assert.deepEqual(session.notifications, [])
  assert.deepEqual(session.tools.result.tools.map((tool) => tool.name), browser.BROWSER_TOOL_NAMES)
  await session.close()
  // With the copy installed, the next launch lets the browser answer the handshake itself.
  const later = await openSession({ command: process.execPath, args: [path.join(fixture.plugin, "mcp", "web.cjs")], cwd: fixture.root, env: fixture.env })
  assert.equal(later.initialize.result.serverInfo.name, "Playwright")
  await later.close()
})

test("sessions that start together install once and every one gets its first call answered", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-web-concurrent-")
  const env = { ...fixture.env, FAKE_NPM_DELAY_MS: "400" }
  const runs = await Promise.all(Array.from({ length: 5 }, async () => {
    const { session, first } = await firstCall({ args: [path.join(fixture.plugin, "mcp", "web.cjs")], cwd: fixture.root, env })
    await session.close()
    return first
  }))
  for (const answer of runs) assert.match(answer.result.content[0].text, /^ran browser_navigate/u)
  assert.equal(npmCalls(fixture.log).filter((call) => call.args[0] === "install").length, 1)
  assert.equal(readdirSync(path.join(fixture.state, "installs")).length, 1)
})
