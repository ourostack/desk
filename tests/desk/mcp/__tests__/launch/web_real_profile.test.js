// Desk's browser in the operator's real profile (mcp/web-real-profile.cjs and its use in mcp/web.cjs).
//
// When a plugin declares `desk.browser`, `desk-web` attaches to the operator's own signed-in browser profile through the Playwright Extension, in a window of its own that it closes when it is done. These tests never run AppleScript, never start a browser and never read a real profile: osascript, the filesystem (temporary folders), the LevelDB reader and the child processes are all injected. The token is a made-up string, and every test that could leak it checks the command lines and stderr for it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const browser = require(path.join(mcpRoot, "web.cjs"))
const real = require(path.join(mcpRoot, "web-real-profile.cjs"))
const TOKEN = "tok-9f3a-never-print-me"

// ---- fixtures ----

function touch(file, contents = "") {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, contents)
  return file
}

const unavailable = (code, summary, fix) => ({ code, summary, fix })
const fixAfter = (action) => `${action}, then retry.`

/** A browser user-data folder under a home, with a Local State that lists the given profiles ({ dir: account }). */
function localState(home, accounts, lastUsed, channel = "msedge", platform = "darwin") {
  const base = real.userDataDir(channel, platform, {}, home)
  const info_cache = {}
  for (const [dir, user_name] of Object.entries(accounts)) info_cache[dir] = { name: dir, user_name }
  touch(path.join(base, "Local State"), JSON.stringify({ profile: { info_cache, ...(lastUsed ? { last_used: lastUsed } : {}) } }))
  return base
}

/** A profile's LevelDB folder with a few files and a LOCK. */
function leveldb(profileDir) {
  const dir = path.join(profileDir, "Local Storage", "leveldb")
  for (const name of ["000003.log", "CURRENT", "LOCK", "MANIFEST-000001"]) touch(path.join(dir, name), name)
  return dir
}

const latin = (text) => Buffer.concat([Buffer.from([1]), Buffer.from(text, "latin1")])
const wide = (text) => Buffer.concat([Buffer.from([0]), Buffer.from(text, "utf16le")])
const tokenKey = () => Buffer.from(`_chrome-extension://${real.EXTENSION_ID}\u0000\u0001auth-token`, "latin1")

/** A stand-in for the classic-level module: it lists what its folder holds when opened, iterates the given entries and records what was closed. */
function levelStub(entries, seen = {}, options = {}) {
  class ClassicLevel {
    constructor(dir, config) {
      seen.dir = dir
      seen.config = config
      seen.files = readdirSync(dir).sort()
      if (options.failOpen) throw new Error("cannot open the database")
    }
    iterator() {
      let index = 0
      return {
        next: async () => {
          if (options.failRead) throw new Error("corrupt table")
          return entries[index++]
        },
        close: async () => { seen.iteratorClosed = true },
      }
    }
    async close() { seen.dbClosed = true }
  }
  return { ClassicLevel }
}

// ---- the declaration ----

function pluginDir(root, name, desk, manifest = "plugin.json") {
  return touch(path.join(root, name, manifest), JSON.stringify({ name, desk })) && path.join(root, name)
}

test("no plugin declares a browser: the browser stays headless and isolated", async () => {
  const root = await mkTempRoot("real-decl-")
  const dirs = [pluginDir(root, "a", { factory: { store: "o/r" } }), path.join(root, "missing"), touch(path.join(root, "bad", "plugin.json"), "{not json") && path.join(root, "bad")]
  assert.deepEqual(real.readDeclaration({ pluginDirs: () => dirs }), { state: "none" })
  assert.deepEqual(real.readDeclaration({ pluginDirs: () => [] }), { state: "none" })
  touch(path.join(root, "list", "plugin.json"), "[1]")
  assert.deepEqual(real.readDeclaration({ pluginDirs: () => [path.join(root, "list")] }), { state: "none" })
  touch(path.join(root, "huge", "plugin.json"), JSON.stringify({ desk: { browser: { channel: "msedge", profileAccountDomain: "x.com" } }, pad: "x".repeat(1024 * 1024) }))
  assert.deepEqual(real.readDeclaration({ pluginDirs: () => [path.join(root, "huge")] }), { state: "none" })
})

test("a plugin's desk.browser names the channel and the account domain; the last plugin listed wins", async () => {
  const root = await mkTempRoot("real-decl-")
  const first = pluginDir(root, "desk", { browser: { channel: "chrome", profileAccountDomain: "example.org" } })
  const second = pluginDir(root, "overlay", { browser: { channel: "msedge", profileAccountDomain: "Microsoft.com" } }, path.join(".claude-plugin", "plugin.json"))
  assert.deepEqual(real.readDeclaration({ pluginDirs: () => [first] }), { state: "declared", channel: "chrome", domain: "example.org" })
  assert.deepEqual(real.readDeclaration({ pluginDirs: () => [first, second] }), { state: "declared", channel: "msedge", domain: "microsoft.com" })
  const third = pluginDir(root, "codex", { browser: { channel: "chrome", profileAccountDomain: "a.io" } }, path.join(".codex-plugin", "plugin.json"))
  assert.equal(real.readDeclaration({ pluginDirs: () => [first, second, third] }).domain, "a.io")
})

test("a desk.browser that cannot be used is reported, never ignored", async () => {
  const root = await mkTempRoot("real-decl-")
  const bad = [
    { browser: "msedge" },
    { browser: [] },
    { browser: { channel: "firefox", profileAccountDomain: "microsoft.com" } },
    { browser: { channel: "msedge" } },
    { browser: { channel: "msedge", profileAccountDomain: 5 } },
    { browser: { channel: "msedge", profileAccountDomain: "microsoft.com\"; do shell script" } },
    { browser: { channel: "msedge", profileAccountDomain: "" } },
    { browser: { channel: "toString", profileAccountDomain: "microsoft.com" } },
  ]
  for (const desk of bad) {
    const dir = pluginDir(root, `bad${bad.indexOf(desk)}`, desk)
    const answer = real.readDeclaration({ pluginDirs: () => [dir] })
    assert.equal(answer.state, "invalid")
    assert.match(answer.summary, /desk\.browser/u)
    assert.ok(answer.summary.includes(path.join(dir, "plugin.json")))
  }
})

test("the installed plugin folders come from the host's own plugin list", async () => {
  const root = await mkTempRoot("real-dirs-")
  const home = path.join(root, "home")
  const claude = path.join(root, "claude")
  const desk = path.join(claude, "cache", "desk")
  const overlay = path.join(claude, "cache", "overlay")
  touch(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "desk@ourostack": [{ scope: "user", installPath: desk, version: "3.2.0-alpha.1" }],
    "overlay@internal": [{ scope: "user", installPath: overlay, version: "2.0.0" }],
  } }))
  assert.deepEqual(real.pluginDirs({ env: { DESK_PLUGIN_ROOT: desk }, homeDir: home }), [desk, overlay])
  assert.deepEqual(real.pluginDirs({ env: { DESK_PLUGIN_ROOT: desk, CLAUDE_CONFIG_DIR: path.join(root, "none") }, homeDir: home }), [])
  const copilot = path.join(root, "copilot", "installed")
  mkdirSync(path.join(copilot, "desk"), { recursive: true })
  mkdirSync(path.join(copilot, "ms-desk"), { recursive: true })
  assert.deepEqual(real.pluginDirs({ env: { COPILOT_PLUGIN_ROOT: path.join(copilot, "desk") }, homeDir: home }).sort(), [path.join(copilot, "desk"), path.join(copilot, "ms-desk")])
  assert.deepEqual(real.pluginDirs({ env: { COPILOT_PLUGIN_ROOT: path.join(root, "nowhere", "desk") }, homeDir: home }), [])
  assert.deepEqual(real.pluginDirs({ env: {}, homeDir: path.join(root, "empty-home") }), [])
})

// ---- the profile ----

test("each browser keeps its Local State in its own user-data folder on each platform", () => {
  assert.equal(real.userDataDir("msedge", "darwin", {}, "/Users/a"), path.join("/Users/a", "Library", "Application Support", "Microsoft Edge"))
  assert.equal(real.userDataDir("chrome", "darwin", {}, "/Users/a"), path.join("/Users/a", "Library", "Application Support", "Google", "Chrome"))
  assert.equal(real.userDataDir("msedge", "win32", { LOCALAPPDATA: "C:\\L" }, "C:\\U"), "C:\\L\\Microsoft\\Edge\\User Data")
  assert.equal(real.userDataDir("chrome", "win32", {}, "C:\\U"), "C:\\U\\AppData\\Local\\Google\\Chrome\\User Data")
  assert.equal(real.userDataDir("msedge", "linux", { XDG_CONFIG_HOME: "/x" }, "/home/a"), path.join("/x", "microsoft-edge"))
  assert.equal(real.userDataDir("chrome", "linux", {}, "/home/a"), path.join("/home/a", ".config", "google-chrome"))
})

test("the profile is the one whose account ends in the declared domain", async () => {
  const root = await mkTempRoot("real-profile-")
  const find = (accounts, domain = "microsoft.com", lastUsed) => {
    const base = localState(root, accounts, lastUsed)
    return real.findProfileDir(path.join(base, "Local State"), domain)
  }
  assert.equal(find({ Default: "me@gmail.com", "Profile 1": "Me@Microsoft.com" }), "Profile 1")
  assert.equal(find({ Default: "me@microsoft.com", "Profile 2": "me2@microsoft.com" }), "Default")
  assert.equal(find({ Default: "me@microsoft.com", "Profile 2": "me2@microsoft.com" }, "microsoft.com", "Profile 2"), "Profile 2")
  assert.equal(find({ Default: "me@microsoft.com", "Profile 2": "me2@x.com" }, "microsoft.com", "Profile 2"), "Default")
  assert.equal(find({ Default: "me@evilmicrosoft.com", "Profile 1": "me@microsoft.com.evil.net", "Profile 3": "" }), null)
  assert.equal(find({}), null)
  const base = real.userDataDir("msedge", "darwin", {}, root)
  touch(path.join(base, "Local State"), JSON.stringify({ profile: { info_cache: { Default: "text", Other: { user_name: 7 } } } }))
  assert.equal(real.findProfileDir(path.join(base, "Local State"), "microsoft.com"), null)
  touch(path.join(base, "Local State"), JSON.stringify({ profile: { info_cache: [] } }))
  assert.equal(real.findProfileDir(path.join(base, "Local State"), "microsoft.com"), null)
  touch(path.join(base, "Local State"), JSON.stringify({ profile: "x" }))
  assert.equal(real.findProfileDir(path.join(base, "Local State"), "microsoft.com"), null)
  touch(path.join(base, "Local State"), "[]")
  assert.equal(real.findProfileDir(path.join(base, "Local State"), "microsoft.com"), null)
  touch(path.join(base, "Local State"), "{broken")
  assert.equal(real.findProfileDir(path.join(base, "Local State"), "microsoft.com"), null)
  assert.equal(real.findProfileDir(path.join(root, "absent", "Local State"), "microsoft.com"), null)
})

// ---- the token ----

test("the token is read from a copy without the lock file, and the copy is gone afterwards", async () => {
  const root = await mkTempRoot("real-token-")
  const scratch = path.join(root, "tmp")
  mkdirSync(scratch)
  const source = leveldb(path.join(root, "Default"))
  const before = readdirSync(source).sort()
  for (const value of [latin(TOKEN), wide(TOKEN)]) {
    const seen = {}
    const level = levelStub([[Buffer.from("other"), latin("x")], [tokenKey(), value]], seen)
    assert.equal(await real.readExtensionToken(path.join(root, "Default"), { level, tmpdir: scratch }), TOKEN)
    assert.deepEqual(seen.files, ["000003.log", "CURRENT", "MANIFEST-000001"])
    assert.notEqual(seen.dir, source)
    assert.equal(seen.config.createIfMissing, false)
    assert.equal(seen.config.keyEncoding, "buffer")
    assert.ok(seen.iteratorClosed && seen.dbClosed)
    assert.deepEqual(readdirSync(scratch), [])
  }
  assert.deepEqual(readdirSync(source).sort(), before)
})

test("a profile without the extension's key or without local storage has no token", async () => {
  const root = await mkTempRoot("real-token-")
  const scratch = path.join(root, "tmp")
  mkdirSync(scratch)
  leveldb(path.join(root, "Default"))
  assert.equal(await real.readExtensionToken(path.join(root, "Default"), { level: levelStub([[Buffer.from("other"), latin("x")]]), tmpdir: scratch }), null)
  assert.equal(await real.readExtensionToken(path.join(root, "Default"), { level: levelStub([]), tmpdir: scratch }), null)
  assert.equal(await real.readExtensionToken(path.join(root, "Profile 9"), { level: levelStub([]), tmpdir: scratch }), null)
  assert.deepEqual(readdirSync(scratch), [])
})

test("a database that fails to open or read still leaves no copy behind", async () => {
  const root = await mkTempRoot("real-token-")
  const scratch = path.join(root, "tmp")
  mkdirSync(scratch)
  leveldb(path.join(root, "Default"))
  const opened = {}
  await assert.rejects(real.readExtensionToken(path.join(root, "Default"), { level: levelStub([], opened, { failOpen: true }), tmpdir: scratch }), /cannot open the database/u)
  const read = {}
  await assert.rejects(real.readExtensionToken(path.join(root, "Default"), { level: levelStub([], read, { failRead: true }), tmpdir: scratch }), /corrupt table/u)
  assert.ok(read.iteratorClosed && read.dbClosed)
  assert.deepEqual(readdirSync(scratch), [])
})

// ---- connecting ----

function connectOptions(root, overrides = {}) {
  const installed = { dir: path.join(root, "install") }
  return { declaration: { state: "declared", channel: "msedge", domain: "microsoft.com" }, installed, platform: "darwin", env: {}, homeDir: path.join(root, "home"), unavailable, reconnectFix: fixAfter, tmpdir: path.join(root, "tmp"), ...overrides }
}

test("connecting names the missing profile, the missing extension and an unreadable token, each in one line with its fix", async () => {
  const root = await mkTempRoot("real-connect-")
  mkdirSync(path.join(root, "tmp"))
  const home = path.join(root, "home")
  const noProfile = await real.connect(connectOptions(root))
  assert.equal(noProfile.payload.code, "browser_profile_not_found")
  assert.match(noProfile.payload.summary, /Microsoft Edge profile signed in to an @microsoft\.com account/u)

  const base = localState(home, { Default: "me@gmail.com", "Profile 3": "me@microsoft.com" })
  leveldb(path.join(base, "Profile 3"))
  const modules = (entries, options) => () => levelStub(entries, {}, options)
  const noExtension = await real.connect(connectOptions(root, { requireModule: modules([]) }))
  assert.equal(noExtension.payload.code, "browser_extension_missing")
  assert.ok(noExtension.payload.fix.includes(real.INSTALL_URL))
  assert.match(noExtension.payload.summary, /profile Profile 3/u)
  assert.equal((await real.connect(connectOptions(root, { requireModule: modules([[tokenKey(), latin("")]]) }))).payload.code, "browser_extension_missing")

  const unreadable = await real.connect(connectOptions(root, { requireModule: modules([], { failRead: true }) }))
  assert.equal(unreadable.payload.code, "browser_token_unreadable")
  assert.match(unreadable.payload.summary, /corrupt table/u)

  const noReader = await real.connect(connectOptions(root, { requireModule: () => { throw new Error("Cannot find module 'classic-level'") } }))
  assert.equal(noReader.payload.code, "browser_token_unreadable")
  assert.match(noReader.payload.fix, /Delete .*install/u)
  const noReaderDefault = await real.connect(connectOptions(root))
  assert.equal(noReaderDefault.payload.code, "browser_token_unreadable")
  for (const answer of [noProfile, noExtension, unreadable, noReader]) assert.doesNotMatch(JSON.stringify(answer), new RegExp(TOKEN, "u"))
})

test("connecting passes the profile in the arguments and the token only in the environment", async () => {
  const root = await mkTempRoot("real-connect-")
  mkdirSync(path.join(root, "tmp"))
  const base = localState(path.join(root, "home"), { Default: "me@microsoft.com" }, "Default", "chrome")
  leveldb(path.join(base, "Default"))
  const answer = await real.connect(connectOptions(root, {
    declaration: { state: "declared", channel: "chrome", domain: "microsoft.com" },
    requireModule: () => levelStub([[tokenKey(), latin(TOKEN)]]),
  }))
  assert.deepEqual(answer.args, ["--extension", "--browser", "chrome", "--profile-dir-name", "Default"])
  assert.deepEqual(answer.env, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN })
  assert.doesNotMatch(answer.args.join(" "), new RegExp(TOKEN, "u"))
})

// ---- the agent's own window ----

function osaFake(events, options = {}) {
  let next = options.firstId ?? 4200
  return async (script) => {
    if (script.includes("make new window")) {
      events.push("osascript:open")
      if (options.failOpen) throw new Error("Application isn't running")
      if (options.openAnswer !== undefined) return options.openAnswer
      if (options.delay) await new Promise((resolve) => setTimeout(resolve, options.delay))
      return String(next++)
    }
    const id = /whose id is (\d+)/u.exec(script)[1]
    events.push(`osascript:close ${id}`)
    if (options.failClose) throw new Error("not authorised")
    return ""
  }
}

function windowsFor(events, options = {}) {
  const lines = []
  return { own: real.windows({ channel: options.channel ?? "msedge", platform: options.platform ?? "darwin", stderr: { write: (text) => lines.push(text) }, unavailable, reconnectFix: fixAfter, osascript: options.osascript ?? osaFake(events, options) }), lines }
}

test("the window scripts open a labelled window in front and close only a window that still exists in a running browser", () => {
  const open = real.openScript("Microsoft Edge")
  assert.match(open, /^tell application "Microsoft Edge"\nset w to make new window\nset URL of active tab of w to "data:text\/html,[^"\\]*"\nset index of w to 1\nreturn id of w\nend tell$/u)
  assert.match(decodeURIComponent(open), /Desk agent window/u)
  const close = real.closeScript("Google Chrome", "77")
  assert.match(close, /^if application "Google Chrome" is running then\ntell application "Google Chrome"\nif exists \(first window whose id is 77\) then close \(first window whose id is 77\)\nend tell\nend if$/u)
  assert.doesNotMatch(close, /quit/u)
})

test("osascript runs through /usr/bin/osascript with a time limit and answers its trimmed output", async () => {
  const calls = []
  const ok = real.osascript((file, args, options, done) => { calls.push({ file, args, options }); done(null, " 55\n") })
  assert.equal(await ok("return 55"), "55")
  assert.deepEqual(calls[0].file, "/usr/bin/osascript")
  assert.deepEqual(calls[0].args, ["-e", "return 55"])
  assert.ok(calls[0].options.timeout > 0)
  const broken = real.osascript((file, args, options, done) => done(new Error("exit 1")))
  await assert.rejects(broken("x"), /exit 1/u)
  assert.equal(typeof real.osascript(), "function")
})

test("the window opens once however many calls arrive together, and closes by its recorded id", async () => {
  const events = []
  const { own } = windowsFor(events, { delay: 20 })
  const [a, b] = await Promise.all([own.ensure(), own.ensure()])
  assert.deepEqual([a, b], [null, null])
  assert.equal(await own.ensure(), null)
  assert.deepEqual(events, ["osascript:open"])
  await Promise.all([own.release(), own.release()])
  await own.release()
  assert.deepEqual(events, ["osascript:open", "osascript:close 4200"])
  assert.equal(await own.ensure(), null)
  assert.deepEqual(events.slice(2), ["osascript:open"])
})

test("releasing a window that was never opened does nothing, and releasing waits for a window still opening", async () => {
  const events = []
  const idle = windowsFor(events).own
  await idle.release()
  assert.deepEqual(events, [])
  const racing = windowsFor(events, { delay: 30 }).own
  const opened = racing.ensure()
  await racing.release()
  await opened
  assert.deepEqual(events, ["osascript:open", "osascript:close 4200"])
})

test("a window that will not open answers the call with one line, touches nothing else and is tried again on the next call", async () => {
  const events = []
  const failing = windowsFor(events, { failOpen: true }).own
  const first = await failing.ensure()
  assert.equal(first.payload.code, "browser_window_failed")
  assert.match(first.payload.summary, /Microsoft Edge window.*isn't running.*no other window was touched/u)
  assert.equal((await failing.ensure()).payload.code, "browser_window_failed")
  assert.deepEqual(events, ["osascript:open", "osascript:open"])
  await failing.release()
  assert.deepEqual(events, ["osascript:open", "osascript:open"])
  const odd = windowsFor([], { openAnswer: "missing value" }).own
  assert.match((await odd.ensure()).payload.summary, /instead of a window id/u)
})

test("a close that fails is reported on stderr and never throws", async () => {
  const events = []
  const { own, lines } = windowsFor(events, { failClose: true, channel: "chrome" })
  await own.ensure()
  await own.release()
  assert.deepEqual(events, ["osascript:open", "osascript:close 4200"])
  assert.match(lines.join(""), /could not close the Google Chrome window 4200: not authorised/u)
})

test("an osascript failure that is not an Error object is still reported by its text", async () => {
  const { own, lines } = windowsFor([], { osascript: async (script) => { throw script.includes("make new window") ? "plain text refusal" : "second refusal" } })
  assert.match((await own.ensure()).payload.summary, /plain text refusal/u)
  const closer = windowsFor([], { osascript: async (script) => { if (script.includes("make new window")) return "9"; throw "second refusal" } })
  await closer.own.ensure()
  await closer.own.release()
  assert.match(closer.lines.join(""), /second refusal/u)
  assert.deepEqual(lines, [])
})

test("off macOS there is no window to open, and the launcher says so once", async () => {
  const events = []
  const { own, lines } = windowsFor(events, { platform: "linux" })
  assert.equal(await own.ensure(), null)
  assert.equal(await own.ensure(), null)
  await own.release()
  assert.deepEqual(events, [])
  assert.equal(lines.length, 1)
  assert.match(lines[0], /macOS only/u)
})

// ---- the launcher in the real profile ----

const HOST_INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-host", version: "1" } }

/** Stubs for the browser Playwright MCP would be: a spawn that records its command and answers the proxy's messages in order, logging each one to `events`. */
function browserStub(events, options = {}) {
  const spawns = []
  const spawn = (file, argv, spawnOptions) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 90000 + spawns.length
    child.killed = []
    child.kill = (signal) => {
      child.killed.push(signal)
      setImmediate(() => child.emit("exit", null, signal))
    }
    child.stdin.setEncoding("utf8")
    let buffered = ""
    child.stdin.on("data", (chunk) => {
      buffered += chunk
      let newline
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        events.push(`child:${message.method}${message.params?.name ? ` ${message.params.name}` : ""}`)
        const reply = (result) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)
        if (message.method === "initialize") reply({ protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "Playwright", version: "stub" } })
        else if (message.method === "tools/list") reply({ tools: [] })
        else if (message.method === "tools/call" && !options.silent) reply({ content: [{ type: "text", text: `ran ${message.params.name}` }] })
      }
    })
    child.stdin.on("end", () => setImmediate(() => child.emit("exit", 0, null)))
    spawns.push({ file, argv, env: spawnOptions.env, stdio: spawnOptions.stdio, child })
    return child
  }
  return { spawn, spawns }
}

/** A preinstalled Playwright MCP (with or without the token reader), a fake Node install and the plugin that declares the browser. */
async function realMachine(options = {}) {
  const root = await mkTempRoot("real-launch-")
  const home = path.join(root, "home")
  const state = path.join(root, "state")
  const node = path.join(root, "node", "bin", "node")
  mkdirSync(path.dirname(node), { recursive: true })
  symlinkSync(process.execPath, node)
  const npmCli = touch(path.join(root, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"), "")
  const id = "installs/1-1-a"
  const modules = path.join(state, id, "node_modules")
  touch(path.join(modules, "@playwright", "mcp", "package.json"), JSON.stringify({ name: "@playwright/mcp", version: "0.0.81", bin: { "playwright-mcp": "cli.js" } }))
  touch(path.join(modules, "@playwright", "mcp", "cli.js"), "")
  if (options.reader !== false) touch(path.join(modules, "classic-level", "package.json"), JSON.stringify({ name: "classic-level" }))
  touch(path.join(state, "current.json"), JSON.stringify({ version: "0.0.81", dir: id, previous: null }))
  const accounts = options.accounts ?? { Default: "me@gmail.com", "Profile 4": "me@microsoft.com" }
  const base = localState(home, accounts)
  if (options.profileData !== false) leveldb(path.join(base, "Profile 4"))
  mkdirSync(path.join(root, "tmp"))
  const declared = options.declare === undefined ? { browser: { channel: "msedge", profileAccountDomain: "microsoft.com" } } : options.declare
  const dirs = declared === null ? [] : [pluginDir(root, "ms-desk", declared)]
  const events = options.events ?? []
  const osascript = options.osascript ?? osaFake(events, options)
  const stub = browserStub(events, options)
  const levelEntries = { entries: options.entries ?? [[tokenKey(), latin(TOKEN)]] }
  const launchOptions = {
    env: { PATH: "/usr/bin", DESK_BROWSER_STATE_DIR: state },
    platform: "darwin",
    arch: "arm64",
    homeDir: home,
    systemPrefix: path.join(root, "sysroot"),
    current: { path: node, version: "v22.9.0", abi: "127" },
    now: () => 0,
    probe: () => null,
    exists: (file) => file === npmCli,
    startRefresh: () => {},
    pluginDirs: () => dirs,
    requireModule: () => levelStub(levelEntries.entries),
    tmpdir: path.join(root, "tmp"),
    osascript,
    spawn: stub.spawn,
    ...options.launch,
  }
  return { root, state, events, stub, launchOptions, levelEntries, dirs }
}

/** Run the launcher against a host over streams, recording stderr, exits and kills. */
function session(machine, extra = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const messages = []
  stdout.on("data", (chunk) => {
    for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(JSON.parse(line))
  })
  const stderr = []
  const exits = []
  const kills = []
  const signals = new EventEmitter()
  const running = browser.run({
    ...machine.launchOptions,
    stderr: { write: (text) => stderr.push(text) },
    exit: (code) => exits.push(code),
    kill: (pid, signal) => { kills.push(signal); machine.events.push(`kill:${signal}`) },
    signals,
    ...extra,
    stdin,
    stdout,
  })
  const wait = async (check, what) => {
    for (let i = 0; i < 1500; i += 1) {
      const found = check()
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const api = {
    running, stderr, exits, kills, signals, stdin, messages,
    send: (message) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    reply: (id) => wait(() => messages.find((message) => message.id === id), `the answer to ${id}`),
    async ask(id, method, params) {
      api.send({ id, method, params })
      return api.reply(id)
    },
    handshake: () => api.ask(1, "initialize", HOST_INIT),
    call: (id, name = "browser_navigate") => api.ask(id, "tools/call", { name, arguments: {} }),
    wait,
    close: () => { stdin.end(); return running },
  }
  return api
}

const textOf = (message) => message.result.content[0].text

/** The launcher with a browser that ends at once, for the launches that hand stdio straight to Playwright MCP. */
async function direct(machine, extra = {}) {
  const spawns = []
  const running = browser.run({
    ...machine.launchOptions,
    spawn: (file, argv, options) => {
      const child = new EventEmitter()
      spawns.push({ file, argv, options })
      setImmediate(() => child.emit("exit", 0, null))
      return child
    },
    signals: new EventEmitter(),
    kill: () => {},
    stderr: { write: () => {} },
    exit: () => {},
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    ...extra,
  })
  await running
  return spawns
}

test("with no declaration the browser is exactly what it was: headless, isolated, no window and no token", async () => {
  const machine = await realMachine({ declare: null })
  const [spawned] = await direct(machine)
  assert.deepEqual(spawned.argv.slice(1, 3), ["--headless", "--isolated"])
  assert.equal(spawned.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
  assert.equal(spawned.options.stdio, "inherit")
  assert.equal(machine.events.some((event) => event.startsWith("osascript")), false)
})

test("a caller's own connection option keeps the browser as the caller asked, without reading any declaration", async () => {
  const machine = await realMachine()
  const [spawned] = await direct(machine, { args: ["--cdp-endpoint", "http://127.0.0.1:9222"], pluginDirs: () => { throw new Error("must not look") } })
  assert.deepEqual(spawned.argv.slice(1, 3), ["--output-dir", path.join(machine.state, "output")])
  assert.ok(spawned.argv.includes("--cdp-endpoint"))
  assert.equal(spawned.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
})

test("a declaration attaches to the declared profile with the token in the environment only", async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  assert.equal(textOf(await host.call(2)), "ran browser_navigate")
  await host.close()
  const [spawned] = machine.stub.spawns
  assert.deepEqual(spawned.argv.slice(3), ["--extension", "--browser", "msedge", "--profile-dir-name", "Profile 4"])
  assert.deepEqual(spawned.argv.slice(1, 3), ["--output-dir", path.join(machine.state, "output")])
  assert.equal(spawned.argv.includes("--headless"), false)
  assert.equal(spawned.argv.includes("--isolated"), false)
  assert.equal(spawned.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, TOKEN)
  assert.deepEqual(spawned.stdio, ["pipe", "pipe", "pipe"])
  assert.equal(JSON.stringify([spawned.file, spawned.argv]).includes(TOKEN), false)
  assert.equal(host.stderr.join("").includes(TOKEN), false)
  assert.match(host.stderr.join(""), /driving the Microsoft Edge profile Profile 4 through the Playwright Extension/u)
  assert.equal(JSON.stringify(host.messages).includes(TOKEN), false)
  assert.deepEqual(readdirSync(path.join(machine.root, "tmp")), [])
})

test("the window opens once, after the handshake and before the first call reaches the browser", async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  await host.ask(2, "tools/list", {})
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(machine.events.includes("osascript:open"), false)
  await host.call(3)
  await host.call(4, "browser_snapshot")
  await host.close()
  const open = machine.events.indexOf("osascript:open")
  assert.ok(open > machine.events.indexOf("child:initialize"))
  assert.ok(open < machine.events.indexOf("child:tools/call browser_navigate"))
  assert.equal(machine.events.filter((event) => event === "osascript:open").length, 1)
})

test("browser_close closes exactly the recorded window, and the next call opens a fresh one", async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  await host.call(3, "browser_close")
  await host.wait(() => machine.events.includes("osascript:close 4200"), "the window to close")
  await host.call(4)
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.deepEqual(machine.events.filter((event) => event.startsWith("osascript")), ["osascript:open", "osascript:close 4200", "osascript:open", "osascript:close 4201"])
  assert.ok(machine.events.indexOf("osascript:close 4200") > machine.events.indexOf("child:tools/call browser_close"))
})

test("a call that fails in the browser still leaves the window for the agent to close", async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.deepEqual(host.exits, [0])
  assert.deepEqual(machine.events.filter((event) => event.startsWith("osascript")), ["osascript:open", "osascript:close 4200"])
})

test("when the host closes stdin the window closes before the launcher exits", async () => {
  const machine = await realMachine()
  const exitsAt = []
  const host = session(machine, { exit: (code) => { exitsAt.push(machine.events.filter((event) => event.startsWith("osascript")).length); host.exits.push(code) } })
  await host.handshake()
  await host.call(2)
  host.stdin.end()
  await host.wait(() => host.exits.length === 1, "the launcher to exit")
  assert.deepEqual(exitsAt, [2])
  assert.ok(machine.events.includes("osascript:close 4200"))
})

test("a stop signal closes the window, then ends the launcher the way the host asked", async () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    const machine = await realMachine()
    const host = session(machine)
    await host.handshake()
    await host.call(2)
    host.signals.emit(signal)
    await host.wait(() => host.kills.length === 1, "the launcher to pass the signal on")
    assert.deepEqual(host.kills, [signal])
    assert.ok(machine.events.indexOf("osascript:close 4200") < machine.events.indexOf(`kill:${signal}`))
    assert.deepEqual(machine.events.filter((event) => event.startsWith("osascript")), ["osascript:open", "osascript:close 4200"])
  }
})

test("a stop signal before any call closes nothing", async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  host.signals.emit("SIGTERM")
  await host.wait(() => host.kills.length === 1, "the launcher to pass the signal on")
  assert.equal(machine.events.some((event) => event.startsWith("osascript")), false)
})

test("two sessions at once each open and close only their own window", async () => {
  const events = []
  const ids = osaFake(events)
  const [a, b] = await Promise.all([realMachine({ events, osascript: ids }), realMachine({ events, osascript: ids })])
  const first = session(a)
  const second = session(b)
  await Promise.all([first.handshake(), second.handshake()])
  await first.call(2)
  await second.call(2)
  await first.call(3, "browser_close")
  await first.wait(() => events.includes("osascript:close 4200"), "the first window to close")
  assert.equal(events.includes("osascript:close 4201"), false)
  await first.close()
  await second.close()
  await second.wait(() => second.exits.length === 1, "the second launcher to end")
  assert.deepEqual(events.filter((event) => event.startsWith("osascript:close")).sort(), ["osascript:close 4200", "osascript:close 4201"])
})

test("a browser process that ends takes its window with it, and nothing else", async () => {
  const machine = await realMachine({ silent: true })
  const host = session(machine)
  await host.handshake()
  host.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await host.wait(() => machine.events.includes("child:tools/call browser_navigate"), "the call to reach the browser")
  machine.stub.spawns[0].child.emit("exit", 3, null)
  const answer = await host.reply(2)
  assert.match(textOf(answer), /browser_exited/u)
  await host.wait(() => host.exits.length === 1, "the launcher to exit")
  assert.deepEqual(host.exits, [3])
  assert.deepEqual(machine.events.filter((event) => event.startsWith("osascript")), ["osascript:open", "osascript:close 4200"])
})

test("a window that will not open answers the call, never reaches the browser, and the next call tries again", async () => {
  const machine = await realMachine({ failOpen: true })
  const host = session(machine)
  await host.handshake()
  const answer = await host.call(2)
  assert.equal(answer.result.isError, true)
  assert.equal(JSON.parse(textOf(answer)).code, "browser_window_failed")
  await host.call(3)
  assert.equal(machine.events.some((event) => event.startsWith("child:tools/call")), false)
  assert.equal(machine.events.filter((event) => event === "osascript:open").length, 2)
  await host.close()
})

test("off macOS the browser connects without a window and says so once", async () => {
  const machine = await realMachine({ launch: { platform: "linux" } })
  const base = localState(machine.launchOptions.homeDir, { "Profile 4": "me@microsoft.com" }, undefined, "msedge", "linux")
  leveldb(path.join(base, "Profile 4"))
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  await host.call(3)
  await host.close()
  assert.equal(machine.events.some((event) => event.startsWith("osascript")), false)
  assert.equal(host.stderr.filter((line) => line.includes("macOS only")).length, 1)
})

test("a missing extension is one clear line on the first call, then works once it is installed, with no picker and no fallback", async () => {
  const machine = await realMachine({ entries: [] })
  const host = session(machine)
  const handshake = await host.handshake()
  assert.equal(handshake.result.serverInfo.name, "desk-web")
  const first = await host.call(2)
  assert.equal(first.result.isError, true)
  const payload = JSON.parse(textOf(first))
  assert.equal(payload.code, "browser_extension_missing")
  assert.ok(payload.fix.includes(real.INSTALL_URL))
  assert.equal(machine.stub.spawns.length, 0)
  assert.equal(machine.events.some((event) => event.startsWith("osascript")), false)
  assert.equal(host.stderr.filter((line) => line.includes("browser_extension_missing")).length, 1)
  machine.levelEntries.entries = [[tokenKey(), latin(TOKEN)]]
  assert.equal(textOf(await host.call(3)), "ran browser_navigate")
  assert.equal(machine.stub.spawns.length, 1)
  await host.close()
})

test("a declared profile that is not there names what was looked for", async () => {
  const machine = await realMachine({ accounts: { Default: "me@gmail.com" } })
  const host = session(machine)
  await host.handshake()
  const payload = JSON.parse(textOf(await host.call(2)))
  assert.equal(payload.code, "browser_profile_not_found")
  assert.match(payload.summary, /@microsoft\.com/u)
  assert.equal(machine.stub.spawns.length, 0)
  await host.close()
})

test("a declaration that cannot be used degrades the whole server with a code that names the manifest", async () => {
  const machine = await realMachine({ declare: { browser: { channel: "netscape", profileAccountDomain: "microsoft.com" } } })
  const host = session(machine)
  await host.handshake()
  const payload = JSON.parse(textOf(await host.call(2)))
  assert.equal(payload.code, "browser_declaration_invalid")
  assert.match(payload.summary, /plugin\.json/u)
  await host.close()
  assert.equal(machine.stub.spawns.length, 0)
})

test("a Playwright MCP install without the token reader is installed again with it, and the reader is installed beside Playwright MCP in one npm call", async () => {
  const machine = await realMachine({ reader: false })
  const calls = []
  const npmSpawn = (file, argv) => {
    calls.push(argv.slice(1))
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setImmediate(() => {
      if (argv[1] === "install") {
        const prefix = argv[argv.indexOf("--prefix") + 1]
        touch(path.join(prefix, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ version: "0.0.82", bin: { "playwright-mcp": "cli.js" } }))
        touch(path.join(prefix, "node_modules", "@playwright", "mcp", "cli.js"), "")
        touch(path.join(prefix, "node_modules", "classic-level", "package.json"), "{}")
      }
      child.emit("close", 0)
    })
    return child
  }
  const host = session(machine, { npmSpawn })
  await host.handshake()
  assert.equal(textOf(await host.call(2)), "ran browser_navigate")
  await host.close()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(-2), ["@playwright/mcp@latest", "classic-level@1.4.1"])
  assert.match(machine.stub.spawns[0].argv[0], /installs\/.*\/node_modules\/@playwright\/mcp\/cli\.js$/u)
  assert.equal(JSON.stringify(calls).includes(TOKEN), false)
})

test("the real-profile module uses only syntax that very old Node parses", () => {
  const source = readFileSync(path.join(mcpRoot, "web-real-profile.cjs"), "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")
  assert.doesNotMatch(source, /=>|`|\?\.|\blet\s|\bconst\s|\basync\s/u)
})

test("the token is never written anywhere the launcher can print it", () => {
  const sources = ["web.cjs", "web-real-profile.cjs", "web-proxy.cjs"].map((file) => readFileSync(path.join(mcpRoot, file), "utf8")).join("\n")
  assert.doesNotMatch(sources, /console\./u)
  const writes = sources.split("\n").filter((line) => /stderr\.write|stdout\.write/u.test(line))
  for (const line of writes) assert.doesNotMatch(line, /token/iu)
})
