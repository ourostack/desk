// Desk's default browser launcher (mcp/browser.cjs).
//
// Every fresh Desk install gets a browser through the `playwright` MCP server, which this launcher starts from the `@playwright/mcp` npm channel under the compatible Node that Desk's bootstrap picks. In-process tests inject the platform, environment, file checks, spawn and exit, so every branch (including the Windows layouts) is measured on any host. Spawned tests run the real Claude inline launcher and the Copilot entry point against a fixture plugin whose Node and npx are fakes, so no test downloads the package.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import { chmodSync, copyFileSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot, pluginRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const browserPath = path.join(mcpRoot, "browser.cjs")
const browser = require(browserPath)

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

/** A POSIX Node install layout: bin/node plus the npx that npm ships beside it. */
function nodeInstall(root) {
  const node = touch(path.join(root, "bin", "node"))
  const cli = touch(path.join(root, "lib", "node_modules", "npm", "bin", "npx-cli.js"))
  return { node, cli }
}

/** Options that make the running Node the only (and compatible) choice, with nothing from this host visible. */
function machine(root, node, overrides = {}) {
  return {
    env: { PATH: "/usr/bin" },
    platform: "linux",
    arch: "x64",
    homeDir: path.join(root, "home"),
    systemPrefix: path.join(root, "sysroot"),
    current: { path: node, version: "v22.9.0", abi: "127" },
    now: () => 0,
    probe: () => null,
    exists: () => false,
    ...overrides,
  }
}

// ---- the package follows its channel ----

test("the launcher asks npx for the @playwright/mcp channel, never a pinned version", () => {
  assert.equal(browser.PACKAGE, "@playwright/mcp@latest")
  const source = readFileSync(browserPath, "utf8")
  assert.doesNotMatch(source, /@playwright\/mcp@\d/u)
  assert.deepEqual(browser.DEFAULT_ARGS, ["--headless", "--isolated"])
})

test("the launcher uses only syntax that very old Node parses", () => {
  const source = readFileSync(browserPath, "utf8").split("\n").filter((line) => !line.startsWith("//")).join("\n")
  assert.doesNotMatch(source, /=>|`|\?\.|\blet\s|\bconst\s|\basync\s/u)
})

// ---- which browser ----

test("browser locations follow Playwright's chrome and msedge channels on each platform", () => {
  const env = { LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local", PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" }
  assert.deepEqual(browser.browserPaths("chrome", "win32", env), [
    "C:\\Users\\a\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  ])
  assert.deepEqual(browser.browserPaths("msedge", "win32", { PROGRAMFILES: "C:\\Program Files" }), [
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ])
  assert.deepEqual(browser.browserPaths("chrome", "darwin", { HOME: "/Users/a" }), [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Users/a/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ])
  assert.deepEqual(browser.browserPaths("msedge", "darwin", {}), [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    path.join("Applications", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
  ])
  assert.deepEqual(browser.browserPaths("chrome", "linux", {}), ["/opt/google/chrome/chrome"])
  assert.deepEqual(browser.browserPaths("msedge", "linux", {}), ["/opt/microsoft/msedge/msedge"])
})

test("the launcher keeps Playwright's Chrome default, falls back to Edge, and never overrides the caller's choice", () => {
  const edgeOnly = (file) => file.endsWith("msedge.exe")
  const env = { PROGRAMFILES: "C:\\Program Files" }
  assert.deepEqual(browser.browserArgs([], "win32", env, edgeOnly), ["--browser", "msedge"])
  assert.deepEqual(browser.browserArgs([], "win32", env, () => true), [])
  assert.deepEqual(browser.browserArgs([], "linux", {}, () => false), [])
  assert.deepEqual(browser.browserArgs(["--browser", "firefox"], "win32", env, edgeOnly), [])
  assert.deepEqual(browser.browserArgs(["--cdp-endpoint=http://127.0.0.1:9"], "win32", env, edgeOnly), [])
  assert.deepEqual(browser.browserArgs(["--caps", "vision"], "win32", env, edgeOnly), ["--browser", "msedge"])
})

// ---- which npx and which Node ----

test("npx is the one npm ships beside the chosen Node, found through links too", async () => {
  const root = await mkTempRoot("desk-browser-npx-")
  const install = nodeInstall(path.join(root, "real"))
  const exists = (file) => { try { return readFileSync(file) !== null } catch { return false } }
  assert.equal(browser.npxCli(install.node, "linux", exists), install.cli)

  const linked = path.join(root, "links", "node")
  mkdirSync(path.dirname(linked), { recursive: true })
  symlinkSync(install.node, linked)
  assert.equal(browser.npxCli(linked, "darwin", exists), realpathSync(install.cli))

  assert.equal(browser.npxCli(path.join(root, "missing", "bin", "node"), "linux", exists), null)
  const seen = []
  assert.equal(browser.npxCli("C:\\node\\node.exe", "win32", (file) => { seen.push(file); return file === "C:\\node\\node_modules\\npm\\bin\\npx-cli.js" }), "C:\\node\\node_modules\\npm\\bin\\npx-cli.js")
  assert.equal(seen[0], "C:\\node\\node_modules\\npm\\bin\\npx-cli.js")
})

test("the chosen Node's folder goes first on PATH, keeping the variable's own spelling", () => {
  assert.deepEqual(browser.withNodeFirst({ PATH: "/usr/bin", HOME: "/h" }, "/n/bin/node", "linux"), { PATH: "/n/bin:/usr/bin", HOME: "/h" })
  assert.deepEqual(browser.withNodeFirst({ Path: "C:\\Windows" }, "C:\\node\\node.exe", "win32"), { Path: "C:\\node;C:\\Windows" })
  assert.deepEqual(browser.withNodeFirst({}, "/n/bin/node", "darwin"), { PATH: "/n/bin" })
})

// ---- run ----

test("run starts npx under the chosen Node with the channel package, defaults, browser choice and caller options", async () => {
  const root = await mkTempRoot("desk-browser-run-")
  const install = nodeInstall(path.join(root, "node"))
  const signals = new EventEmitter()
  const spawns = []
  const exits = []
  const child = fakeChild()
  browser.run({
    ...machine(root, install.node, {
      exists: (file) => file === install.cli || file === "/opt/microsoft/msedge/msedge",
    }),
    args: ["--caps", "vision"],
    spawn: (file, argv, options) => { spawns.push({ file, argv, stdio: options.stdio, path: options.env.PATH }); return child },
    signals,
    exit: (code) => exits.push(code),
    kill: () => {},
  })
  assert.deepEqual(spawns, [{
    file: install.node,
    argv: [install.cli, "-y", "@playwright/mcp@latest", "--headless", "--isolated", "--browser", "msedge", "--caps", "vision"],
    stdio: "inherit",
    path: `${path.dirname(install.node)}:/usr/bin`,
  }])
  signals.emit("SIGTERM")
  assert.deepEqual(child.killed, ["SIGTERM"])
  child.emit("exit", 0, null)
  assert.deepEqual(exits, [0])
})

test("with no compatible Node the launcher names the fix and exits 1", async () => {
  const root = await mkTempRoot("desk-browser-nonode-")
  const errors = []
  const exits = []
  await browser.run({
    ...machine(root, path.join(root, "old", "node"), { current: { path: path.join(root, "old", "node"), version: "v16.20.2", abi: "93" } }),
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
  })
  assert.deepEqual(exits, [1])
  assert.match(errors.join(""), /no Node satisfies >=20\.0\.0 \(this one is v16\.20\.2\).*reconnect the playwright MCP server/u)
})

test("a Node with no npx beside it is named and exits 1", async () => {
  const root = await mkTempRoot("desk-browser-nonpx-")
  const node = touch(path.join(root, "bin", "node"))
  const errors = []
  const exits = []
  await browser.run({
    // The real file check, on a Node whose npx is missing.
    ...machine(root, node, { exists: undefined }),
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
  })
  assert.deepEqual(exits, [1])
  assert.match(errors.join(""), /has no npx beside it/u)
})

test("a Node that cannot be spawned is named and exits 1", async () => {
  const root = await mkTempRoot("desk-browser-spawnfail-")
  const install = nodeInstall(root)
  const child = fakeChild()
  const errors = []
  const exits = []
  const running = browser.run({
    ...machine(root, install.node, { exists: (file) => file === install.cli }),
    args: [],
    spawn: () => child,
    signals: new EventEmitter(),
    stderr: { write: (text) => errors.push(text) },
    exit: (code) => exits.push(code),
  })
  child.emit("error", new Error("spawn EACCES"))
  await running
  assert.deepEqual(exits, [1])
  assert.match(errors.join(""), /could not start Node .*: spawn EACCES/u)
})

test("anything that throws while starting is one stderr line and exit 1, never a crash", async () => {
  for (const [thrown, expected] of [[new Error("disk gone"), /could not start the browser: disk gone/u], ["plain text", /could not start the browser: plain text/u]]) {
    const root = await mkTempRoot("desk-browser-throw-")
    const install = nodeInstall(root)
    const errors = []
    const exits = []
    await browser.run({
      ...machine(root, install.node, { exists: () => { throw thrown } }),
      stderr: { write: (text) => errors.push(text) },
      exit: (code) => exits.push(code),
    })
    assert.deepEqual(exits, [1])
    assert.match(errors.join(""), expected)
  }
})

test("run fills every other option from the real process", async () => {
  const spawns = []
  const child = fakeChild()
  browser.run({
    env: { PATH: path.dirname(process.execPath), HOME: "/nonexistent", DESK_NODE_SYSTEM_PREFIX: "/nonexistent-prefix" },
    spawn: (file, argv) => { spawns.push([file, argv]); return child },
    exit: () => {},
  })
  assert.equal(spawns.length, 1)
  assert.equal(spawns[0][0], process.execPath)
  assert.match(spawns[0][1][0], /npx-cli\.js$/u)
  assert.deepEqual(spawns[0][1].slice(1, 5), ["-y", "@playwright/mcp@latest", "--headless", "--isolated"])
  const callerArgs = process.argv.slice(2)
  assert.deepEqual(spawns[0][1].slice(spawns[0][1].length - callerArgs.length), callerArgs)
  child.emit("exit", 0, null)
})

test("run finds HOME through USERPROFILE and the running system's home", async () => {
  for (const env of [{ PATH: "", USERPROFILE: "/nonexistent-profile" }, { PATH: "" }]) {
    const errors = []
    const exits = []
    await browser.run({
      env,
      platform: "linux",
      current: { path: "/nonexistent/node", version: "v16.20.2", abi: "93" },
      now: () => 0,
      probe: () => null,
      spawn: () => fakeChild(),
      signals: new EventEmitter(),
      stderr: { write: (text) => errors.push(text) },
      exit: (code) => exits.push(code),
    })
    assert.deepEqual(exits, [1])
  }
})

// ---- the host configs ----

test("the Claude and Copilot configs declare the playwright browser server beside Desk", () => {
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(claude), ["desk", "playwright"])
  assert.deepEqual(Object.keys(claude.playwright), ["type", "command", "args", "cwd", "env"])
  assert.equal(claude.playwright.type, "stdio")
  assert.equal(claude.playwright.command, "node")
  assert.equal(claude.playwright.args[0], "-e")
  assert.doesNotMatch(claude.playwright.args[1], /\$\{|=>|`|\?\.|\blet\s|\bconst\s/u)
  assert.match(claude.playwright.args[1], /require\(path\.join\(root,'mcp','browser\.cjs'\)\)\.run\(\{args:\[\]\}\)/u)
  assert.equal(claude.playwright.cwd, ".")
  assert.deepEqual(claude.playwright.env, { DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" })
  const copilot = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.copilot.json"), "utf8")).mcpServers
  assert.deepEqual(Object.keys(copilot), ["desk", "playwright"])
  assert.deepEqual(copilot.playwright, { type: "stdio", command: "node", args: ["${COPILOT_PLUGIN_ROOT}/mcp/browser.cjs"], env: {} })
})

// ---- spawned: the real entry points against a fixture plugin ----

/** A fixture plugin with the real launcher files, whose only compatible Node is a fake that prints what it was asked to run. */
async function fixturePlugin(prefix) {
  const root = await mkTempRoot(prefix)
  const plugin = path.join(root, "plugin")
  mkdirSync(path.join(plugin, "mcp"), { recursive: true })
  copyFileSync(browserPath, path.join(plugin, "mcp", "browser.cjs"))
  copyFileSync(path.join(mcpRoot, "bootstrap.cjs"), path.join(plugin, "mcp", "bootstrap.cjs"))
  writeFileSync(path.join(plugin, "mcp", "package.json"), JSON.stringify({ version: "0.0.0", engines: { node: ">=30" } }))
  const nodeDir = path.join(root, "home", ".nvm", "versions", "node", "v30.1.0")
  const node = touch(path.join(nodeDir, "bin", "node"), [
    "#!/bin/sh",
    "if [ \"$1\" = \"-e\" ]; then printf 'v30.1.0 999'; exit 0; fi",
    "printf 'ran'",
    "for arg in \"$@\"; do printf ' [%s]' \"$arg\"; done",
    "printf '\\n'",
    "",
  ].join("\n"))
  chmodSync(node, 0o755)
  const cli = touch(path.join(nodeDir, "lib", "node_modules", "npm", "bin", "npx-cli.js"))
  const env = { HOME: path.join(root, "home"), PATH: "/usr/bin:/bin", DESK_NODE_SYSTEM_PREFIX: path.join(root, "none"), NODE_OPTIONS: "" }
  return { root, plugin, cli, env }
}

const posixOnly = { skip: process.platform === "win32" ? "fake nodes are POSIX shell scripts" : false }

test("the Claude inline launcher finds the plugin through DESK_PLUGIN_ROOT or the working directory", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-browser-claude-")
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.playwright
  const expected = (cli) => new RegExp(`^ran \\[${cli.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\] \\[-y\\] \\[@playwright/mcp@latest\\] \\[--headless\\] \\[--isolated\\]`, "u")
  const viaEnv = spawnSync(process.execPath, claude.args, { cwd: fixture.root, encoding: "utf8", env: { ...fixture.env, DESK_PLUGIN_ROOT: fixture.plugin } })
  assert.match(viaEnv.stdout, expected(fixture.cli), viaEnv.stderr)
  assert.match(viaEnv.stdout, /\[--isolated\]( \[--browser\] \[msedge\])?\n$/u)
  const viaCwd = spawnSync(process.execPath, claude.args, { cwd: fixture.plugin, encoding: "utf8", env: { ...fixture.env, DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}" } })
  assert.match(viaCwd.stdout.replace(realpathSync(fixture.root), fixture.root), expected(fixture.cli), viaCwd.stderr)
})

test("the Claude inline launcher names the fix when it cannot find the plugin", async () => {
  const cwd = await mkTempRoot("desk-browser-noplugin-")
  const claude = JSON.parse(readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")).mcpServers.playwright
  const result = spawnSync(process.execPath, claude.args, { cwd, encoding: "utf8", env: { PATH: "/usr/bin:/bin", DESK_PLUGIN_ROOT: "${CLAUDE_PLUGIN_ROOT}", NODE_OPTIONS: "" } })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, "")
  assert.match(result.stderr, /Desk could not find its plugin files.*reconnect the playwright MCP server/u)
})

test("the Copilot entry point runs the launcher with its own arguments", posixOnly, async () => {
  const fixture = await fixturePlugin("desk-browser-copilot-")
  const result = spawnSync(process.execPath, [path.join(fixture.plugin, "mcp", "browser.cjs"), "--caps", "pdf"], { cwd: fixture.root, encoding: "utf8", env: fixture.env })
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /\[@playwright\/mcp@latest\] \[--headless\] \[--isolated\].*\[--caps\] \[pdf\]\n$/u)
})
