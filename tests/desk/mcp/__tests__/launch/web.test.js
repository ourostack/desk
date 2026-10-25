// Desk's browser (plugins/desk/mcp/web.cjs): fresh or mine, through the Playwright CLI.
// Most tests drive a fake CLI and a fake npm placed where the real ones go, so they run everywhere without a browser.
// With DESK_BROWSER_REAL=1 the last tests install the real playwright-core and drive a real Edge or Chrome.
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { NO_POSIX_MODES, isWindows } from "../_platform.js"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const webFile = path.join(repoRoot, "plugins", "desk", "mcp", "web.cjs")
const web = require(webFile)
const catalog = require(path.join(repoRoot, "plugins", "desk", "mcp", "web-catalog.json"))

const FAKE_CLI = `
const fs = require("fs"), path = require("path")
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify({ args, cwd: process.cwd() }) + "\\n")
const verb = args[1], mode = process.env.FAKE_CLI_MODE || ""
if (verb === "open" && mode === "open-fail") { process.stderr.write("Browser failed\\nline two\\n"); process.exit(1) }
if (verb === "snapshot") process.stdout.write("- generic [ref=e1]\\n")
if (verb === "fail-quiet") process.exit(1)
if (verb === "fail-loud") { process.stderr.write("boom\\n"); process.exit(1) }
if (verb === "sleep") setTimeout(() => {}, 10000)
`

const FAKE_NPM = `
const fs = require("fs"), path = require("path")
const mode = process.env.FAKE_NPM_MODE
const cli = (root) => { const dir = path.join(root, "node_modules", "playwright-core", "lib", "tools", "cli-client"); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, "cli.js"), fs.readFileSync(process.env.FAKE_CLI_SOURCE)) }
if (mode === "fail") { process.stderr.write("npm ERR! network\\nnpm ERR! offline\\n"); process.exit(1) }
if (mode === "fail-quiet") process.exit(1)
if (mode === "empty") process.exit(0)
if (mode === "slow") { setTimeout(() => { cli(process.cwd()) }, 300); return }
cli(process.cwd())
if (mode === "race-ok") cli(process.env.FAKE_FINAL)
if (mode === "race-broken") { fs.mkdirSync(process.env.FAKE_FINAL, { recursive: true }); fs.writeFileSync(path.join(process.env.FAKE_FINAL, "junk"), "x") }
`

const browserExe = isWindows ? "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe" : "/fake/msedge"
const onlyEdge = (file) => file === browserExe || file.endsWith(path.join("Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge")) || file === "/opt/microsoft/msedge/msedge" || /Microsoft[\\/]Edge[\\/]Application[\\/]msedge\.exe$/u.test(file)

async function setup({ cli = true, mode = "", npmMode, platform } = {}) {
  const root = await mkTempRoot("desk-web-test-")
  const state = path.join(root, "state")
  const tmp = path.join(root, "tmp")
  fs.mkdirSync(tmp)
  const cliSource = path.join(root, "fake-cli.js")
  fs.writeFileSync(cliSource, FAKE_CLI)
  const npm = path.join(root, "fake-npm.js")
  fs.writeFileSync(npm, FAKE_NPM)
  const installDir = path.join(state, `playwright-core-${web.PLAYWRIGHT_VERSION}`)
  const cliDir = path.join(installDir, "node_modules", "playwright-core", "lib", "tools", "cli-client")
  if (cli) {
    fs.mkdirSync(cliDir, { recursive: true })
    fs.copyFileSync(cliSource, path.join(cliDir, "cli.js"))
  }
  const profiles = path.join(root, "profiles")
  const env = { ...process.env, DESK_BROWSER_STATE_DIR: state, FAKE_CLI_MODE: mode, FAKE_CLI_SOURCE: cliSource, FAKE_NPM_MODE: npmMode ?? "ok", FAKE_FINAL: installDir }
  const options = {
    env, tmpDir: tmp, npmCli: npm, exists: onlyEdge, platform: platform ?? process.platform,
    profileRoots: { msedge: path.join(profiles, "edge"), chrome: path.join(profiles, "chrome") },
  }
  const calls = () => {
    const log = path.join(cliDir, "calls.log")
    return fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []
  }
  return { root, state, tmp, options, calls, installDir, cliDir, profiles }
}

function makeProfile(rootDir, { lastUsed = "Profile 1", withProfile = true } = {}) {
  fs.mkdirSync(rootDir, { recursive: true })
  fs.writeFileSync(path.join(rootDir, "Local State"), JSON.stringify({ profile: { last_used: lastUsed } }))
  if (!withProfile) return
  const profile = path.join(rootDir, lastUsed)
  fs.mkdirSync(path.join(profile, "Network"), { recursive: true })
  fs.writeFileSync(path.join(profile, "Network", "Cookies"), "cookies")
  fs.writeFileSync(path.join(profile, "Preferences"), "{}")
  for (const skipped of ["Cache", "Sessions", "Extensions"]) {
    fs.mkdirSync(path.join(profile, skipped))
    fs.writeFileSync(path.join(profile, skipped, "data"), "x")
  }
}

const text = (result) => result.content[0].text
const json = (result) => JSON.parse(text(result))

// ---- pure helpers ----

test("the catalog lists exactly the two browser tools", () => {
  assert.deepEqual(catalog.tools.map((tool) => tool.name), web.BROWSER_TOOL_NAMES)
  assert.deepEqual(catalog.tools[0].inputSchema.properties.browser.enum, ["fresh", "mine"])
})

test("profileRoot names each browser's profile folder on each platform", () => {
  assert.equal(web.profileRoot("msedge", "win32", { LOCALAPPDATA: "C:\\L" }, "C:\\H"), "C:\\L\\Microsoft\\Edge\\User Data")
  assert.equal(web.profileRoot("chrome", "win32", {}, "C:\\H"), "C:\\H\\AppData\\Local\\Google\\Chrome\\User Data")
  assert.equal(web.profileRoot("msedge", "darwin", {}, "/Users/a"), path.join("/Users/a", "Library", "Application Support", "Microsoft Edge"))
  assert.equal(web.profileRoot("chrome", "darwin", {}, "/Users/a"), path.join("/Users/a", "Library", "Application Support", "Google/Chrome"))
  assert.equal(web.profileRoot("msedge", "linux", {}, "/home/a"), path.join("/home/a", ".config", "microsoft-edge"))
  assert.equal(web.profileRoot("chrome", "linux", { XDG_CONFIG_HOME: "/x" }, "/home/a"), path.join("/x", "google-chrome"))
})

test("npmCli finds the npm beside this Node and reports none beside a missing one", () => {
  assert.ok(web.npmCli(process.execPath, process.platform, (file) => fs.existsSync(file)))
  assert.equal(web.npmCli(path.join(repoRoot, "no-such-node"), "linux", () => false), null)
  assert.equal(web.npmCli("C:\\n\\node.exe", "win32", (file) => file === "C:\\n\\node_modules\\npm\\bin\\npm-cli.js"), "C:\\n\\node_modules\\npm\\bin\\npm-cli.js")
})

test("copyProfile copies the last-used profile and Local State, skipping caches, extensions and open tabs", async () => {
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const dest = path.join(root, "dest")
  assert.equal(web.copyProfile(source, dest), "Profile 1")
  assert.ok(fs.existsSync(path.join(dest, "Local State")))
  assert.equal(fs.readFileSync(path.join(dest, "Profile 1", "Network", "Cookies"), "utf8"), "cookies")
  for (const skipped of ["Cache", "Sessions", "Extensions"]) assert.equal(fs.existsSync(path.join(dest, "Profile 1", skipped)), false, skipped)
})

test("copyProfile falls back to Default for a missing, unsafe or malformed last_used", async () => {
  const { root } = await setup()
  for (const [index, localState] of [{ profile: { last_used: "../x" } }, { profile: { last_used: ".." } }, { profile: { last_used: 5 } }, {}].entries()) {
    const source = path.join(root, `src${index}`)
    fs.mkdirSync(path.join(source, "Default"), { recursive: true })
    fs.writeFileSync(path.join(source, "Local State"), JSON.stringify(localState))
    assert.equal(web.copyProfile(source, path.join(root, `dest${index}`)), "Default")
  }
})

// ---- the controller with a fake CLI ----

test("fresh opens in a private folder, runs page commands and deletes the folder on close", async () => {
  const { options, tmp, calls, state } = await setup()
  const controller = web.createController(options)
  const opened = await controller.call("browser_context", { action: "open" })
  assert.equal(opened.isError, false, text(opened))
  const { contextId, browser, app, files } = json(opened)
  assert.equal(browser, "fresh")
  assert.equal(app, "Microsoft Edge")
  assert.equal(files, path.join(state, "output", contextId))
  const dir = path.join(tmp, `desk-browser-${contextId}`)
  if (!NO_POSIX_MODES) assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))
  assert.equal(config.browser.launchOptions.headless, true)
  assert.equal(config.browser.launchOptions.channel, "msedge")
  assert.equal(config.browser.launchOptions.ignoreDefaultArgs, undefined)
  assert.equal(config.browser.userDataDir, path.join(dir, "profile"))

  const snapshot = await controller.call("browser_command", { contextId, args: ["snapshot"] })
  assert.deepEqual([snapshot.isError, text(snapshot)], [false, "- generic [ref=e1]"])
  const literal = await controller.call("browser_command", { contextId, args: ["fill", "e1", "--", "--config"] })
  assert.equal(literal.isError, false)

  const closed = await controller.call("browser_context", { action: "close", contextId })
  assert.deepEqual(json(closed), { contextId, closed: true })
  assert.equal(fs.existsSync(dir), false)
  assert.deepEqual(calls().map((call) => call.args.slice(1)), [["open", "--config=config.json"], ["snapshot"], ["fill", "e1", "--", "--config"], ["close"]])
  assert.ok(calls().every((call) => call.args[0] === "--session=desk" && path.basename(call.cwd) === `desk-browser-${contextId}`))

  const after = await controller.call("browser_command", { contextId, args: ["snapshot"] })
  assert.equal(after.isError, true)
  assert.match(text(after), /no open browser with that contextId/u)
})

test("mine opens a private copy of the person's profile and deletes it on close", async () => {
  const { options, tmp, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const controller = web.createController(options)
  const opened = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(opened.isError, false, text(opened))
  const { contextId } = json(opened)
  const dir = path.join(tmp, `desk-browser-${contextId}`)
  assert.equal(fs.readFileSync(path.join(dir, "profile", "Profile 1", "Network", "Cookies"), "utf8"), "cookies")
  assert.equal(fs.existsSync(path.join(dir, "profile", "Profile 1", "Sessions")), false)
  const launch = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8")).browser.launchOptions
  assert.deepEqual(launch.ignoreDefaultArgs, ["--use-mock-keychain", "--password-store=basic"])
  assert.ok(launch.args.includes("--profile-directory=Profile 1"))
  assert.ok(launch.args.includes("--disable-sync"))
  assert.equal(fs.existsSync(path.join(profiles, "edge", "Profile 1", "Cache")), true, "the source profile is untouched")
  await controller.call("browser_context", { action: "close", contextId })
  assert.equal(fs.existsSync(dir), false)
})

test("mine gives a plain message when there is no profile, or it cannot be copied", async () => {
  const { options, profiles, tmp } = await setup()
  const controller = web.createController(options)
  const none = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(none.isError, true)
  assert.match(text(none), /could not find your own Edge or Chrome profile/u)
  makeProfile(path.join(profiles, "edge"), { withProfile: false })
  const busy = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(busy.isError, true)
  assert.equal(text(busy), "Desk could not copy your Edge profile, probably because Edge is using it. Close Edge, or use a fresh browser (browser: \"fresh\").")
  assert.deepEqual(fs.readdirSync(tmp), [], "the failed copy left no folder")
})

test("a missing browser, a failed start and bad input each give a plain message", async () => {
  const { options, tmp } = await setup({ mode: "open-fail" })
  const noBrowser = web.createController({ ...options, exists: () => false })
  assert.match(text(await noBrowser.call("browser_context", { action: "open" })), /needs Microsoft Edge or Google Chrome/u)
  const controller = web.createController(options)
  const failed = await controller.call("browser_context", { action: "open", browser: "fresh" })
  assert.equal(failed.isError, true)
  assert.equal(text(failed), "The browser did not start. Try again, or use a fresh browser. Details: Browser failed\nline two")
  assert.deepEqual(fs.readdirSync(tmp), [])
  assert.match(text(await controller.call("browser_context", { action: "open", browser: "other" })), /must be "fresh" or "mine"/u)
  assert.match(text(await controller.call("browser_context", { action: "reopen" })), /action must be "open" or "close"/u)
  assert.match(text(await controller.call("browser_context", { action: "close", contextId: "nope" })), /contextId must be/u)
  assert.match(text(await controller.call("browser_command", {})), /contextId must be/u)
  assert.match(text(await controller.call("browser_other")), /Unknown tool browser_other/u)
  const gone = await controller.call("browser_context", { action: "close", contextId: "00000000-0000-4000-8000-000000000000" })
  assert.deepEqual(json(gone), { contextId: "00000000-0000-4000-8000-000000000000", closed: true })
})

test("browser_command refuses lifecycle commands and browser options, and reports failures plainly", async () => {
  const { options } = await setup()
  const controller = web.createController(options)
  const { contextId } = json(await controller.call("browser_context", { action: "open" }))
  const run = async (args) => text(await controller.call("browser_command", { contextId, args }))
  for (const args of [undefined, [], [1]]) assert.match(await run(args), /args must be a list of strings/u)
  for (const verb of ["open", "close", "kill-all", "close-all", "attach", "list"]) assert.match(await run([verb]), /is not available here/u)
  for (const option of ["--session=x", "-s", "--browser=chrome", "--profile", "--config=x", "--extension"]) {
    assert.match(await run(["snapshot", option]), /is not available here; the browser is chosen/u)
  }
  assert.equal(await run(["fail-quiet"]), "The command failed.")
  assert.equal(await run(["fail-loud"]), "boom")
  const impatient = web.createController({ ...options, commandMs: 2000 })
  assert.match(text(await impatient.call("browser_command", { contextId, args: ["sleep"] })), /longer than 2 seconds/u)
  await controller.closeAll()
})

test("an unexpected error is reported as such", async () => {
  const { options, root } = await setup()
  const controller = web.createController({ ...options, tmpDir: path.join(root, "missing") })
  const result = await controller.call("browser_context", { action: "open" })
  assert.equal(result.isError, true)
  assert.match(text(result), /^Desk's browser hit an unexpected problem: /u)
})

test("closing retries a folder the browser still holds, and reports one that stays locked", async () => {
  const { options, tmp } = await setup()
  const controller = web.createController(options)
  const original = fs.rmSync
  const busy = Object.assign(new Error("busy"), { code: "EBUSY" })
  try {
    const first = json(await controller.call("browser_context", { action: "open" }))
    let refusals = 1
    fs.rmSync = (...args) => { if (refusals-- > 0) throw busy; return original(...args) }
    assert.equal((await controller.call("browser_context", { action: "close", contextId: first.contextId })).isError, false)
    assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${first.contextId}`)), false)
    const second = json(await controller.call("browser_context", { action: "open" }))
    fs.rmSync = () => { throw busy }
    const locked = await controller.call("browser_context", { action: "close", contextId: second.contextId })
    assert.equal(locked.isError, true)
    assert.match(text(locked), /unexpected problem: busy/u)
  } finally {
    fs.rmSync = original
  }
})

// ---- installing playwright-core ----

test("the first open installs playwright-core once, even when two opens race", async () => {
  const { options, calls } = await setup({ cli: false, npmMode: "slow" })
  const controller = web.createController(options)
  const [a, b] = await Promise.all([controller.call("browser_context", { action: "open" }), controller.call("browser_context", { action: "open" })])
  assert.equal(a.isError, false, text(a))
  assert.equal(b.isError, false, text(b))
  assert.equal(calls().filter((call) => call.args[1] === "open").length, 2)
  await controller.closeAll()
})

test("install failures give plain messages", async () => {
  for (const [npmMode, expected] of [["fail", /npm said: npm ERR! offline$/u], ["fail-quiet", /npm said: nothing$/u], ["empty", /npm said: nothing$/u], ["race-broken", /could not put it in place/u]]) {
    const { options } = await setup({ cli: false, npmMode })
    const result = await web.createController(options).call("browser_context", { action: "open" })
    assert.equal(result.isError, true, npmMode)
    assert.match(text(result), expected, npmMode)
  }
  const { options } = await setup({ cli: false })
  const noNpm = await web.createController({ ...options, npmCli: null }).call("browser_context", { action: "open" })
  assert.match(text(noNpm), /could not find npm next to Node/u)
})

test("an install another Desk process finished first is used", async () => {
  const { options } = await setup({ cli: false, npmMode: "race-ok" })
  const controller = web.createController(options)
  const result = await controller.call("browser_context", { action: "open" })
  assert.equal(result.isError, false, text(result))
  await controller.closeAll()
})

test("a controller with no options uses the real process settings", () => {
  const controller = web.createController()
  assert.equal(controller.settings.node, process.execPath)
  assert.equal(controller.settings.platform, process.platform)
  assert.ok(controller.settings.stateRoot.length > 0)
})

test("the state folder follows XDG_STATE_HOME, else the home folder, and mine looks in the browser's own profile folder", async () => {
  const home = path.join(repoRoot, "no-such-home")
  assert.equal(web.createController({ env: {}, homeDir: home }).settings.stateRoot, path.join(home, ".local", "state", "ouroboros-skills", "desk", "browser"))
  assert.equal(web.createController({ env: { XDG_STATE_HOME: "/x" }, homeDir: home }).settings.stateRoot, path.join("/x", "ouroboros-skills", "desk", "browser"))
  const { options } = await setup()
  const result = await web.createController({ ...options, homeDir: home, profileRoots: undefined }).call("browser_context", { action: "open", browser: "mine" })
  assert.match(text(result), /could not find your own Edge or Chrome profile/u)
})

// ---- leftovers ----

test("startup closes contexts whose Desk process is gone, and keeps the rest", async () => {
  const { options, tmp, calls } = await setup()
  const dead = spawnSync(process.execPath, ["-e", ""]).pid
  const make = (id, owner, config = true) => {
    const dir = path.join(tmp, `desk-browser-${id}`)
    fs.mkdirSync(dir)
    if (owner !== undefined) fs.writeFileSync(path.join(dir, "owner.json"), owner)
    if (config) fs.writeFileSync(path.join(dir, "config.json"), "{}")
    return dir
  }
  const stale = make("11111111-1111-4111-8111-111111111111", JSON.stringify({ pid: dead }))
  const staleNoConfig = make("44444444-4444-4444-8444-444444444444", JSON.stringify({ pid: dead }), false)
  const alive = make("22222222-2222-4222-8222-222222222222", JSON.stringify({ pid: process.pid }))
  const noOwner = make("33333333-3333-4333-8333-333333333333", undefined)
  const other = path.join(tmp, "desk-browser-not-an-id")
  fs.mkdirSync(other)
  await web.createController(options).sweep()
  assert.equal(fs.existsSync(stale), false)
  assert.equal(fs.existsSync(staleNoConfig), false)
  assert.equal(fs.existsSync(alive), true)
  assert.equal(fs.existsSync(noOwner), true)
  assert.equal(fs.existsSync(other), true)
  assert.deepEqual(calls().map((call) => call.args[1]), ["close"])

  const { options: noCli, tmp: tmp2 } = await setup({ cli: false })
  const leftover = path.join(tmp2, "desk-browser-55555555-5555-4555-8555-555555555555")
  fs.mkdirSync(leftover)
  fs.writeFileSync(path.join(leftover, "owner.json"), JSON.stringify({ pid: dead }))
  fs.writeFileSync(path.join(leftover, "config.json"), "{}")
  await web.createController(noCli).sweep()
  assert.equal(fs.existsSync(leftover), false)

  const notAFolder = path.join(tmp2, "file")
  fs.writeFileSync(notAFolder, "x")
  assert.ok(await web.createController({ ...noCli, tmpDir: notAFolder }).sweep() instanceof Error)
  await web.createController({ ...noCli, tmpDir: path.join(tmp2, "missing") }).sweep()
})

// ---- the MCP server ----

function server(options) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const signals = new EventEmitter()
  let exitCode = null
  let buffered = ""
  const waiting = new Map()
  const received = []
  stdout.setEncoding("utf8")
  stdout.on("data", (chunk) => {
    buffered += chunk
    let newline
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const message = JSON.parse(buffered.slice(0, newline))
      buffered = buffered.slice(newline + 1)
      received.push(message)
      waiting.get(message.id)?.(message)
    }
  })
  const done = web.serve({ ...options, stdin, stdout, signals, exit: (code) => { exitCode = code } })
  let next = 0
  const request = (method, params) => new Promise((resolve) => {
    const id = ++next
    waiting.set(id, resolve)
    stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
  })
  return { stdin, signals, done, request, received, exitCode: () => exitCode }
}

test("the MCP server answers the handshake, lists the tools and runs calls", async () => {
  const { options, tmp } = await setup()
  const s = server(options)
  const init = await s.request("initialize", { protocolVersion: "2025-03-26" })
  assert.equal(init.result.protocolVersion, "2025-03-26")
  assert.equal(init.result.serverInfo.name, "desk-web")
  assert.equal((await s.request("initialize")).result.protocolVersion, "2025-06-18")
  assert.deepEqual(await s.request("ping"), { jsonrpc: "2.0", id: 3, result: {} })
  assert.deepEqual((await s.request("tools/list")).result.tools, catalog.tools)
  assert.equal((await s.request("resources/list")).error.code, -32601)
  s.stdin.write("not json\n\n" + JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\nnull\n")
  const opened = await s.request("tools/call", { name: "browser_context", arguments: { action: "open" } })
  const { contextId } = JSON.parse(opened.result.content[0].text)
  assert.ok(fs.existsSync(path.join(tmp, `desk-browser-${contextId}`)))
  assert.ok(s.received.some((message) => message.id === null && message.error.code === -32700))
  s.stdin.end()
  await s.done
  assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${contextId}`)), false, "ending the server closes its browsers")
})

test("a stop signal closes the server's browsers and exits", async () => {
  const { options, tmp } = await setup()
  const s = server(options)
  const opened = await s.request("tools/call", { name: "browser_context", arguments: { action: "open" } })
  const { contextId } = JSON.parse(opened.result.content[0].text)
  s.signals.emit("SIGTERM")
  for (let tries = 0; tries < 100 && s.exitCode() === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(s.exitCode(), 0)
  assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${contextId}`)), false)
  s.stdin.end()
  await s.done
})

test("a failure while closing still lets the server finish and exit", async () => {
  const { options, tmp } = await setup()
  const s = server(options)
  const opened = await s.request("tools/call", { name: "browser_context", arguments: { action: "open" } })
  const { contextId } = JSON.parse(opened.result.content[0].text)
  const original = fs.rmSync
  fs.rmSync = () => { throw new Error("locked") }
  try {
    s.signals.emit("SIGINT")
    for (let tries = 0; tries < 100 && s.exitCode() === null; tries += 1) await new Promise((resolve) => setTimeout(resolve, 50))
    s.stdin.end()
    await s.done
  } finally {
    fs.rmSync = original
  }
  assert.equal(s.exitCode(), 0)
  fs.rmSync(path.join(tmp, `desk-browser-${contextId}`), { recursive: true, force: true })
})

// ---- real browsers ----

const real = process.env.DESK_BROWSER_REAL === "1" ? false : "set DESK_BROWSER_REAL=1 to drive a real browser"

async function realSetup() {
  const root = await mkTempRoot("desk-web-real-")
  const tmp = path.join(root, "tmp")
  fs.mkdirSync(tmp)
  const env = { ...process.env, DESK_BROWSER_STATE_DIR: path.join(root, "state") }
  const page = http.createServer((request, response) => {
    response.setHeader("content-type", "text/html")
    if (request.url === "/set") response.setHeader("set-cookie", "desk=signed-in; Max-Age=86400; Path=/")
    response.end("<title>Desk test page</title><button>Press</button>")
  })
  await new Promise((resolve) => page.listen(0, "127.0.0.1", resolve))
  return { root, tmp, env, url: `http://127.0.0.1:${page.address().port}`, page }
}

test("real: fresh opens headless, loads a page, closes and its folder is gone", { skip: real, timeout: 300000 }, async () => {
  const { tmp, env, url, page } = await realSetup()
  const controller = web.createController({ env, tmpDir: tmp })
  try {
    const opened = await controller.call("browser_context", { action: "open", browser: "fresh" })
    assert.equal(opened.isError, false, text(opened))
    const { contextId } = json(opened)
    const goto = await controller.call("browser_command", { contextId, args: ["goto", url] })
    assert.match(text(goto), /Desk test page/u)
    const snapshot = await controller.call("browser_command", { contextId, args: ["snapshot"] })
    assert.match(text(snapshot), /button "Press" \[ref=e\d+\]/u)
    await controller.call("browser_context", { action: "close", contextId })
    assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${contextId}`)), false)
  } finally {
    await controller.closeAll()
    page.closeAllConnections()
    page.close()
  }
})

test("real: mine carries the person's sign-in into a copy, leaves a running browser alone and deletes the copy", { skip: real, timeout: 300000 }, async () => {
  const { root, tmp, env: isolated, url, page } = await realSetup()
  // macOS keeps the key that protects saved sign-ins in the login keychain, which a browser finds only under the real home.
  const env = process.platform === "darwin" ? { ...isolated, HOME: os.userInfo().homedir } : isolated
  const controller = web.createController({ env, tmpDir: tmp })
  const persons = path.join(root, "person")
  let personal = null
  try {
    // Install the driver through a fresh open, then build "the person's" profile with a saved cookie.
    const warm = await controller.call("browser_context", { action: "open" })
    assert.equal(warm.isError, false, text(warm))
    await controller.call("browser_context", { action: "close", contextId: json(warm).contextId })
    const { chromium } = require(path.join(env.DESK_BROWSER_STATE_DIR, `playwright-core-${web.PLAYWRIGHT_VERSION}`, "node_modules", "playwright-core"))
    const channel = json(warm).app === "Microsoft Edge" ? "msedge" : "chrome"
    const options = { channel, headless: true, env, ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"] }
    const setupContext = await chromium.launchPersistentContext(persons, options)
    await (setupContext.pages()[0] ?? await setupContext.newPage()).goto(`${url}/set`)
    await setupContext.close()

    // "The person's browser" keeps running on its own profile while Desk opens mine.
    personal = await chromium.launch({ channel, headless: true })
    const personalPage = await personal.newPage()
    await personalPage.goto(url)

    const mine = web.createController({ env, tmpDir: tmp, profileRoots: { msedge: persons, chrome: persons } })
    const opened = await mine.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(opened.isError, false, text(opened))
    const { contextId } = json(opened)
    await mine.call("browser_command", { contextId, args: ["goto", url] })
    const cookie = await mine.call("browser_command", { contextId, args: ["eval", "() => document.cookie"] })
    assert.match(text(cookie), /desk=signed-in/u)
    await mine.call("browser_context", { action: "close", contextId })
    assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${contextId}`)), false)

    assert.equal(personal.isConnected(), true)
    assert.equal(personal.contexts()[0].pages().length, 1)
    assert.equal(await personalPage.title(), "Desk test page")
  } finally {
    await personal?.close()
    await controller.closeAll()
    page.closeAllConnections()
    page.close()
  }
})
