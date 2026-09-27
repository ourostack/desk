// Desk's default browser launcher (mcp/browser.cjs).
//
// Every fresh Desk install gets a browser through the `desk-browser` MCP server. The launcher starts a copy of `@playwright/mcp` installed in Desk's state folder, installs it on first use, and refreshes it from the `@latest` channel in a detached process after start. No test reaches a registry: the chosen Node's npm is a fake (`npm-cli.js` beside a link to this Node) that installs a stub package, reports a version, fails, or hangs on request, and logs every call. In-process tests inject the platform, environment, file checks, spawn and exit, so every branch (including the Windows layouts) is measured on any host. Spawned tests run the real Claude inline launcher, the Copilot entry point and concurrent launches against a fixture plugin.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawn, spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot, pluginRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const browserPath = path.join(mcpRoot, "browser.cjs")
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

// A fake npm: `install` writes a stub @playwright/mcp (and playwright-core) into --prefix, `view` prints a version, `config get registry` prints a registry. FAKE_NPM_MODE picks a failure, FAKE_NPM_VERSION the version, FAKE_NPM_DELAY_MS a pause, and FAKE_NPM_LOG receives one JSON line per call.
const FAKE_NPM = `
const fs = require("fs"), path = require("path")
const args = process.argv.slice(2)
const mode = process.env.FAKE_NPM_MODE || "ok"
const version = process.env.FAKE_NPM_VERSION || "0.0.82"
if (process.env.FAKE_NPM_LOG) fs.appendFileSync(process.env.FAKE_NPM_LOG, JSON.stringify({ args, retries: process.env.npm_config_fetch_retries, timeout: process.env.npm_config_fetch_timeout, path: process.env.PATH }) + "\\n")
function main() {
  if (mode === "hang") { setInterval(() => {}, 1000); return }
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
  if (mode !== "nocli") fs.writeFileSync(path.join(pkg, "cli.js"), "process.stdout.write('ran ' + process.argv.slice(2).map((a) => '[' + a + ']').join(' ') + '\\\\n')\\n")
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
function preinstall(state, version = "0.0.81", id = "installs/1-1-a") {
  const modules = path.join(state, id, "node_modules")
  touch(path.join(modules, "@playwright", "mcp", "package.json"), JSON.stringify({ name: "@playwright/mcp", version, bin: { "playwright-mcp": "cli.js" } }))
  touch(path.join(modules, "@playwright", "mcp", "cli.js"), "process.stdout.write('ran ' + process.argv.slice(2).map((a) => '[' + a + ']').join(' ') + '\\n')\n")
  touch(path.join(state, "current.json"), JSON.stringify({ version, dir: id, previous: null }))
  return path.join(modules, "@playwright", "mcp", "cli.js")
}

/** Run the launcher with a fake MCP spawn; resolves once the MCP is spawned (or the launcher ended without spawning it). */
function launch(options) {
  const errors = []
  const exits = []
  const spawns = []
  const child = fakeChild()
  const signals = new EventEmitter()
  let spawned
  const ready = new Promise((resolve) => { spawned = resolve })
  const running = browser.run({
    spawn: (file, argv, spawnOptions) => { spawns.push({ file, argv, stdio: spawnOptions.stdio, env: spawnOptions.env }); spawned(); return child },
    signals,
    kill: () => {},
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
    ...options,
  })
  return { running, ready: Promise.race([ready, running]), errors, exits, spawns, child, signals }
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
  const root = await mkTempRoot("desk-browser-npm-")
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
  const root = await mkTempRoot("desk-browser-read-")
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
  const root = await mkTempRoot("desk-browser-lock-")
  const lock = path.join(root, "refresh.lock")
  assert.equal(browser.takeLock(lock, Date.now), true)
  assert.equal(browser.takeLock(lock, Date.now), false, "held by a live process")
  writeFileSync(lock, "not json")
  assert.equal(browser.takeLock(lock, Date.now), false, "an owner still writing its record is live")
  const dead = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" })
  writeFileSync(lock, JSON.stringify({ pid: Number(dead.stdout) }))
  assert.equal(browser.takeLock(lock, Date.now), true, "its owner exited")
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).pid, process.pid)
  writeFileSync(lock, JSON.stringify({ pid: 1 }))
  assert.equal(browser.takeLock(lock, Date.now), false, "pid 1 is alive, even when signalling it is not permitted")
  assert.equal(browser.takeLock(lock, () => Date.now() + 11 * 60 * 1000), true, "older than ten minutes")
  assert.throws(() => browser.takeLock(path.join(root, "missing", "refresh.lock"), Date.now), /ENOENT/u)
})

test("a lock that vanishes while it is replaced is decided by the next create", async () => {
  const root = await mkTempRoot("desk-browser-lockrace-")
  const lock = path.join(root, "refresh.lock")
  writeFileSync(lock, JSON.stringify({ pid: process.pid }))
  // Released by its owner between the failed create and the staleness check, so both the check and the unlink miss it.
  let calls = 0
  const clock = () => { calls += 1; if (calls === 1) { try { require("node:fs").unlinkSync(lock) } catch {} } return Date.now() + 11 * 60 * 1000 }
  assert.equal(browser.takeLock(lock, clock), true)
})

// ---- run: the first launch installs, later launches start at once ----

test("the first launch installs the channel in the foreground, names the version and starts it under the chosen Node", posixOnly, async () => {
  const m = await machine("desk-browser-first-", { env: { FAKE_NPM_VERSION: "0.0.90" } })
  const l = launch({ ...m.options, args: ["--caps", "vision"] })
  await l.ready
  const installed = browser.readInstalled(m.state)
  assert.equal(installed.version, "0.0.90")
  assert.deepEqual(l.spawns.map(({ file, argv, stdio }) => ({ file, argv, stdio })), [{
    file: m.install.node,
    argv: [installed.cli, "--headless", "--isolated", "--output-dir", path.join(m.state, "output"), "--caps", "vision"],
    stdio: "inherit",
  }])
  assert.equal(l.spawns[0].env.PATH, `${path.dirname(m.install.node)}:/usr/bin`)
  assert.equal(l.spawns[0].env.npm_config_fetch_retries, undefined, "npm settings stay out of the browser's environment")
  assert.match(l.errors.join(""), /^\[desk-browser\] @playwright\/mcp 0\.0\.90 \(playwright-core 1\.64\.0-test\) from .*installs/u)
  const [call] = m.calls()
  assert.deepEqual(call.args.slice(0, 1).concat(call.args.slice(-3)), ["install", "--no-save", "--no-package-lock", "@playwright/mcp@latest"])
  assert.equal(call.retries, "0")
  assert.equal(call.timeout, "10000")
  assert.equal(existsSync(path.join(m.state, "refresh.lock")), false, "the lock is released")
  l.signals.emit("SIGTERM")
  assert.deepEqual(l.child.killed, ["SIGTERM"])
  l.child.emit("exit", 0, null)
  await l.running
  assert.deepEqual(l.exits, [0])
})

test("a later launch starts the installed copy with no npm call, then starts the refresh", posixOnly, async () => {
  const refreshes = []
  const m = await machine("desk-browser-later-", { startRefresh: (o) => refreshes.push(o), platform: "darwin" })
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

test("an unreachable registry fails fast with one line naming the registry, and leaves nothing half-installed", posixOnly, async () => {
  for (const [mode, registry] of [["fail", "https://registry.example/"], ["failall", "the configured npm registry"]]) {
    const m = await machine("desk-browser-offline-", { env: { FAKE_NPM_MODE: mode } })
    const l = launch(m.options)
    await l.running
    assert.deepEqual(l.exits, [1])
    assert.equal(l.spawns.length, 0)
    assert.equal(l.errors.join(""), `[desk-browser] could not install @playwright/mcp@latest from ${registry} (ENOTCONN: network unreachable). Check that this machine can reach that registry, or point npm at one it can reach (npm config set registry <url>), then reconnect the desk-browser MCP server.\n`)
    assert.deepEqual(readdirSync(path.join(m.state, "installs")), [])
    assert.equal(existsSync(path.join(m.state, "refresh.lock")), false)
  }
})

test("an install that npm reports as done but left incomplete is an error, not a launch", posixOnly, async () => {
  for (const mode of ["silent", "nocli", "nobin"]) {
    const m = await machine("desk-browser-incomplete-", { env: { FAKE_NPM_MODE: mode } })
    const l = launch(m.options)
    await l.running
    assert.deepEqual(l.exits, [1])
    assert.match(l.errors.join(""), /\(npm install exited with code 0\)/u)
  }
  const m = await machine("desk-browser-stringbin-", { env: { FAKE_NPM_MODE: "stringbin" } })
  const l = launch(m.options)
  await l.ready
  assert.equal(l.spawns.length, 1)
  l.child.emit("exit", 0, null)
})

test("a registry that hangs is cut off at the first-install time limit", posixOnly, async () => {
  const m = await machine("desk-browser-hang-", { env: { FAKE_NPM_MODE: "hang" }, firstInstallMs: 100 })
  const started = Date.now()
  const l = launch(m.options)
  await l.running
  assert.ok(Date.now() - started < 10000)
  assert.deepEqual(l.exits, [1])
  assert.match(l.errors.join(""), /\(npm install timed out after 1 seconds\)/u)
})

test("npm that cannot be spawned, or fails to start, is reported like any other install failure", posixOnly, async () => {
  const m = await machine("desk-browser-npmspawn-", { npmSpawn: () => { throw new Error("spawn EMFILE") } })
  const l = launch(m.options)
  await l.running
  assert.match(l.errors.join(""), /from the configured npm registry \(spawn EMFILE\)/u)

  const n = await machine("desk-browser-npmerror-", {
    npmSpawn: () => {
      const child = fakeChild()
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      setImmediate(() => { child.emit("error", new Error("spawn ENOENT")); child.emit("close", 1) })
      return child
    },
  })
  const k = launch(n.options)
  await k.running
  assert.match(k.errors.join(""), /\(spawn ENOENT\)/u)
})

test("a launch that finds another session installing waits for it, then starts that copy", posixOnly, async () => {
  const refreshes = []
  const m = await machine("desk-browser-wait-", { startRefresh: (o) => refreshes.push(o) })
  mkdirSync(m.state, { recursive: true })
  writeFileSync(path.join(m.state, "refresh.lock"), JSON.stringify({ pid: process.pid }))
  setTimeout(() => { preinstall(m.state, "0.0.85"); require("node:fs").unlinkSync(path.join(m.state, "refresh.lock")) }, 300)
  const l = launch(m.options)
  await l.ready
  assert.match(l.errors.join(""), /@playwright\/mcp 0\.0\.85/u)
  assert.deepEqual(m.calls(), [])
  assert.equal(refreshes.length, 1)
  l.child.emit("exit", 0, null)
})

test("a launch gives up when another session's install outlasts the time limit", posixOnly, async () => {
  const m = await machine("desk-browser-waitlong-", { firstInstallMs: 0 })
  mkdirSync(m.state, { recursive: true })
  writeFileSync(path.join(m.state, "refresh.lock"), JSON.stringify({ pid: process.pid }))
  const l = launch(m.options)
  await l.running
  assert.match(l.errors.join(""), /\(another Desk session was still installing it\)/u)
})

test("a state folder that cannot hold an install fails the launch and releases the lock", posixOnly, async () => {
  const m = await machine("desk-browser-badstate-")
  touch(path.join(m.state, "installs"), "a file where a folder belongs")
  const l = launch(m.options)
  await l.running
  assert.deepEqual(l.exits, [1])
  assert.match(l.errors.join(""), /could not start the browser: ENOTDIR/u)
  assert.equal(existsSync(path.join(m.state, "refresh.lock")), false)
})

// ---- the refresh ----

async function refreshMachine(prefix, env = {}) {
  const m = await machine(prefix, { env })
  return { ...m, refresh: (extra = {}) => browser.refresh({ env: m.options.env, platform: "linux", node: m.install.node, npmCli: m.install.cli, ...extra }) }
}

test("a refresh that finds the channel unchanged installs nothing", posixOnly, async () => {
  const m = await refreshMachine("desk-browser-same-", { FAKE_NPM_VERSION: "0.0.81" })
  preinstall(m.state, "0.0.81")
  assert.deepEqual(await m.refresh(), { ok: true, version: "0.0.81", changed: false })
  assert.deepEqual(m.calls().map((call) => call.args[0]), ["view"])
  assert.deepEqual(JSON.parse(readFileSync(path.join(m.state, "last-refresh.json"), "utf8")).result, { ok: true, version: "0.0.81", changed: false })
  assert.equal(existsSync(path.join(m.state, "refresh.lock")), false)
})

test("a refresh that finds a new release installs it beside the old one and switches the pointer", posixOnly, async () => {
  const m = await refreshMachine("desk-browser-new-", { FAKE_NPM_VERSION: "0.0.83" })
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
  const m = await refreshMachine("desk-browser-prune-", { FAKE_NPM_VERSION: "0.0.84" })
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
    const m = await refreshMachine("desk-browser-refail-", { FAKE_NPM_MODE: mode })
    preinstall(m.state, "0.0.81")
    assert.deepEqual(await m.refresh(), { ok: false, error })
    assert.equal(browser.readInstalled(m.state).version, "0.0.81")
  }
  const m = await refreshMachine("desk-browser-refail2-", { FAKE_NPM_MODE: "silent", FAKE_NPM_VERSION: "0.0.99" })
  assert.deepEqual(await m.refresh(), { ok: false, error: "npm install exited with code 0" })
  assert.equal(browser.readInstalled(m.state), null)
})

test("a refresh skips while another session holds the lock, and survives a state folder it cannot write", posixOnly, async () => {
  const m = await refreshMachine("desk-browser-busy-")
  mkdirSync(m.state, { recursive: true })
  writeFileSync(path.join(m.state, "refresh.lock"), JSON.stringify({ pid: process.pid }))
  assert.deepEqual(await m.refresh(), { ok: true, skipped: "another Desk session holds the refresh lock" })
  assert.deepEqual(m.calls(), [])

  const n = await refreshMachine("desk-browser-norecord-", { FAKE_NPM_VERSION: "0.0.81" })
  preinstall(n.state, "0.0.81")
  mkdirSync(path.join(n.state, "last-refresh.json", "x"), { recursive: true })
  assert.deepEqual(await n.refresh(), { ok: true, version: "0.0.81", changed: false })
  assert.equal(existsSync(path.join(n.state, "refresh.lock")), false, "a lost record never keeps the lock")

  const root = await mkTempRoot("desk-browser-nostate-")
  touch(path.join(root, "file"))
  const result = await browser.refresh({ env: { DESK_BROWSER_STATE_DIR: path.join(root, "file", "state") }, npmCli: n.install.cli })
  assert.equal(result.ok, false)
  assert.match(result.error, /EEXIST|ENOTDIR/u)
})

test("a refresh never removes a lock that another session took over", posixOnly, async () => {
  const m = await refreshMachine("desk-browser-steal-", { FAKE_NPM_MODE: "steal", FAKE_NPM_VERSION: "0.0.81" })
  preinstall(m.state, "0.0.81")
  assert.deepEqual(await m.refresh(), { ok: true, version: "0.0.81", changed: false })
  assert.equal(JSON.parse(readFileSync(path.join(m.state, "refresh.lock"), "utf8")).pid, 1)
})

test("a refresh that cannot start is ignored, never a crash in the launch", async () => {
  const child = browser.startRefresh({ node: path.join(await mkTempRoot("desk-browser-nonode-refresh-"), "missing-node"), npmCli: "npm-cli.js", env: {} })
  await new Promise((resolve) => child.on("error", resolve))
})

test("a refresh fills its options from the real process", posixOnly, async () => {
  const root = await mkTempRoot("desk-browser-refdefaults-")
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
  const m = await machine("desk-browser-detached-", { env: { FAKE_NPM_VERSION: "0.0.87" }, startRefresh: undefined })
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

test("with no compatible Node the launcher names the fix and exits 1", async () => {
  const m = await machine("desk-browser-nonode-")
  const old = path.join(m.root, "old", "node")
  const l = launch({ ...m.options, current: { path: old, version: "v16.20.2", abi: "93" } })
  await l.running
  assert.deepEqual(l.exits, [1])
  assert.match(l.errors.join(""), /no Node satisfies >=20\.0\.0 \(this one is v16\.20\.2\).*reconnect the desk-browser MCP server/u)
})

test("a Node with no npm beside it is named and exits 1", async () => {
  const root = await mkTempRoot("desk-browser-nonpm-")
  const node = touch(path.join(root, "bin", "node"))
  const l = launch({
    env: { PATH: "/usr/bin" }, platform: "linux", arch: "x64", homeDir: root, systemPrefix: root,
    current: { path: node, version: "v22.9.0", abi: "127" }, now: () => 0, probe: () => null,
  })
  await l.running
  assert.deepEqual(l.exits, [1])
  assert.match(l.errors.join(""), /has no npm beside it/u)
})

test("a Node that cannot be spawned is named and exits 1", posixOnly, async () => {
  const m = await machine("desk-browser-spawnfail-", { startRefresh: () => {} })
  preinstall(m.state)
  const l = launch(m.options)
  await l.ready
  l.child.emit("error", new Error("spawn EACCES"))
  await l.running
  assert.deepEqual(l.exits, [1])
  assert.match(l.errors.join(""), /could not start Node .*: spawn EACCES/u)
})

test("anything that throws while starting is one stderr line and exit 1, never a crash", async () => {
  for (const [thrown, expected] of [[new Error("disk gone"), /could not start the browser: disk gone/u], ["plain text", /could not start the browser: plain text/u]]) {
    const m = await machine("desk-browser-throw-", { exists: () => { throw thrown } })
    const l = launch(m.options)
    await l.running
    assert.deepEqual(l.exits, [1])
    assert.match(l.errors.join(""), expected)
  }
})

test("run fills every other option from the real process", async () => {
  const state = await mkTempRoot("desk-browser-defaults-")
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
    const l = launch({ env, platform: "linux", current: { path: "/nonexistent/node", version: "v16.20.2", abi: "93" }, now: () => 0, probe: () => null })
    await l.running
    assert.deepEqual(l.exits, [1])
  }
})

// ---- the host configs ----

test("the Claude and Copilot configs declare the desk-browser server beside Desk, never a bare playwright name", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(claude), ["desk", "desk-browser"])
  const server = claude["desk-browser"]
  assert.deepEqual(Object.keys(server), ["type", "command", "args", "cwd", "env"])
  assert.equal(server.type, "stdio")
  assert.equal(server.command, "node")
  assert.equal(server.args[0], "-e")
  assert.doesNotMatch(server.args[1], /\$\{|=>|`|\?\.|\blet\s|\bconst\s/u)
  assert.match(server.args[1], /require\(path\.join\(root,'mcp','browser\.cjs'\)\)\.run\(\{args:\[\]\}\)/u)
  assert.equal(server.cwd, ".")
  assert.deepEqual(server.env, { DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" })
  const copilot = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.copilot.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(copilot), ["desk", "desk-browser"])
  assert.deepEqual(copilot["desk-browser"], { type: "stdio", command: "node", args: ["${COPILOT_PLUGIN_ROOT}/mcp/browser.cjs"], env: {} })
})

// ---- spawned: the real entry points against a fixture plugin ----

/** A fixture plugin with the real launcher files, whose only compatible Node is a wrapper that answers the version probe and otherwise runs this Node, with the fake npm beside it. */
async function fixturePlugin(prefix) {
  const root = await mkTempRoot(prefix)
  const plugin = path.join(root, "plugin")
  mkdirSync(path.join(plugin, "mcp"), { recursive: true })
  copyFileSync(browserPath, path.join(plugin, "mcp", "browser.cjs"))
  copyFileSync(path.join(mcpRoot, "bootstrap.cjs"), path.join(plugin, "mcp", "bootstrap.cjs"))
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

test("the Claude inline launcher finds the plugin through DESK_PLUGIN_ROOT or the working directory", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-browser-claude-")
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers["desk-browser"]
  const viaEnv = spawnSync(process.execPath, claude.args, { cwd: fixture.root, encoding: "utf8", env: { ...fixture.env, DESK_PLUGIN_ROOT: fixture.plugin } })
  assert.match(viaEnv.stdout, /^ran \[--headless\] \[--isolated\]( \[--browser\] \[msedge\]| \[--executable-path\] \[[^\]]+\])? \[--output-dir\] \[[^\]]+state\/output\]\n$/u, viaEnv.stderr)
  assert.match(viaEnv.stderr, /\[desk-browser\] @playwright\/mcp 0\.0\.82 \(playwright-core 1\.64\.0-test\) from /u)
  const viaCwd = spawnSync(process.execPath, claude.args, { cwd: fixture.plugin, encoding: "utf8", env: { ...fixture.env, DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" } })
  assert.match(viaCwd.stdout, /^ran \[--headless\] \[--isolated\]/u, viaCwd.stderr)
})

test("the Claude inline launcher names the fix when it cannot find the plugin", async () => {
  const cwd = await mkTempRoot("desk-browser-noplugin-")
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers["desk-browser"]
  const result = spawnSync(process.execPath, claude.args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}", NODE_OPTIONS: "" } })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /Desk could not find its plugin files.*reconnect the desk-browser MCP server/u)
})

test("the Copilot entry point runs the launcher with its own arguments", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-browser-copilot-")
  const result = spawnSync(process.execPath, [path.join(fixture.plugin, "mcp", "browser.cjs"), "--caps", "pdf"], { cwd: fixture.root, encoding: "utf8", env: fixture.env })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /^ran \[--headless\] \[--isolated\].*\[--output-dir\] \[[^\]]+\] \[--caps\] \[pdf\]\n$/u)
})

test("sessions that start together install once and every one gets its browser", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-browser-concurrent-")
  const env = { ...fixture.env, FAKE_NPM_DELAY_MS: "400" }
  const runs = await Promise.all(Array.from({ length: 5 }, () => new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(fixture.plugin, "mcp", "browser.cjs")], { cwd: fixture.root, env })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => { stdout += chunk })
    child.stderr.on("data", (chunk) => { stderr += chunk })
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  })))
  for (const run of runs) {
    assert.equal(run.code, 0, run.stderr)
    assert.match(run.stdout, /^ran \[--headless\]/u)
  }
  assert.equal(npmCalls(fixture.log).filter((call) => call.args[0] === "install").length, 1)
  assert.equal(readdirSync(path.join(fixture.state, "installs")).length, 1)
})
