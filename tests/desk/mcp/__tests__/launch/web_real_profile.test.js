// Desk's browser in the operator's real profile (mcp/web-real-profile.cjs and its use in mcp/web.cjs).
//
// When a plugin declares `desk.browser`, `desk-web` attaches to the operator's own signed-in browser profile through the Playwright Extension, in a window of its own whose tabs it closes when it is done. These tests never script a browser, never start one and never read a real profile: the filesystem (temporary folders), the LevelDB reader and the child processes are all injected, and the browser is a stub that keeps a list of tabs. The token is a made-up string, and every test that could leak it checks the command lines, the host's output and stderr for it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const browser = require(path.join(mcpRoot, "web.cjs"))
const real = require(path.join(mcpRoot, "web-real-profile.cjs"))
const TOKEN = "tok-9f3a-never-print-me"
const posixOnly = { skip: process.platform === "win32" ? "the fixture Node is a POSIX link" : false }

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
  return { declaration: { state: "declared", channel: "msedge", domain: "microsoft.com" }, installed, executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", launcherDir: path.join(root, "launchers"), platform: "darwin", env: {}, homeDir: path.join(root, "home"), unavailable, reconnectFix: fixAfter, tmpdir: path.join(root, "tmp"), ...overrides }
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
  const plain = await real.connect(connectOptions(root, { requireModule: () => { throw "plain refusal" } }))
  assert.match(plain.payload.summary, /plain refusal/u)
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
  assert.deepEqual(answer.args, ["--extension", "--browser", "chrome", "--profile-dir-name", "Default", "--executable-path", path.join(root, "launchers", "chrome-new-window.sh")])
  assert.deepEqual(answer.env, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN })
  assert.deepEqual(answer.secrets, [TOKEN])
  assert.doesNotMatch(answer.args.join(" "), new RegExp(TOKEN, "u"))
  assert.match(readFileSync(answer.args.at(-1), "utf8"), /--new-window/u)
})

test("a browser that is not installed is one clear line before anything is read", async () => {
  const root = await mkTempRoot("real-connect-")
  const answer = await real.connect(connectOptions(root, { executable: null }))
  assert.equal(answer.payload.code, "browser_not_installed")
  assert.match(answer.payload.summary, /Microsoft Edge/u)
})

// ---- the agent's own window ----

test("the wrapper starts the real browser with --new-window first, quoting any path", () => {
  assert.equal(real.launcherScript("darwin", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"), "#!/bin/sh\nexec '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge' --new-window \"$@\"\n")
  assert.equal(real.launcherScript("linux", "/opt/it's/edge"), "#!/bin/sh\nexec '/opt/it'\\''s/edge' --new-window \"$@\"\n")
  assert.equal(real.launcherScript("win32", "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"), "@echo off\r\n\"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe\" --new-window %*\r\n")
  assert.match(real.launcherScript("win32", "C:\\100%\\edge.exe"), /100%%/u)
})

test("the wrapper is written once, runnable, and only rewritten when the browser's path changes", async () => {
  const root = await mkTempRoot("real-wrapper-")
  const dir = path.join(root, "launchers")
  const file = real.writeLauncher(dir, "darwin", "msedge", "/Applications/Edge")
  assert.equal(file, path.join(dir, "msedge-new-window.sh"))
  assert.equal(readFileSync(file, "utf8"), real.launcherScript("darwin", "/Applications/Edge"))
  if (process.platform !== "win32") assert.ok((statSync(file).mode & 0o111) !== 0, "the wrapper can be run")
  const stamp = statSync(file).mtimeMs
  assert.equal(real.writeLauncher(dir, "darwin", "msedge", "/Applications/Edge"), file)
  assert.equal(statSync(file).mtimeMs, stamp)
  real.writeLauncher(dir, "darwin", "msedge", "/Applications/Other")
  assert.match(readFileSync(file, "utf8"), /Other/u)
  assert.deepEqual(readdirSync(dir), ["msedge-new-window.sh"])
  assert.equal(real.writeLauncher(dir, "win32", "chrome", "C:\\chrome.exe"), path.join(dir, "chrome-new-window.cmd"))
})

// ---- the agent's own tabs ----

const tabsText = (count) => ({ content: [{ type: "text", text: count === 0 ? "### Open tabs\nNo open tabs." : `### Open tabs\n${Array.from({ length: count }, (_, index) => `- ${index}: ${index === 0 ? "(current) " : ""}[Page ${index}](https://example.com/${index})`).join("\n")}` }] })

test("tabs are counted from the lines that start with an index", () => {
  assert.equal(real.countTabs(tabsText(0)), 0)
  assert.equal(real.countTabs(tabsText(3)), 3)
  assert.equal(real.countTabs({ content: [{ type: "image" }, { type: "text", text: "- 4: x" }] }), 1)
  assert.equal(real.countTabs({ content: "x" }), 0)
  assert.equal(real.countTabs(undefined), 0)
})

test("the agent's tabs are closed from the first until none is left, and nothing else is called", async () => {
  const calls = []
  let open = 3
  await real.closeOwnTabs(async (name, args, ms) => {
    calls.push([name, args, ms])
    if (args.action === "close") open -= 1
    return tabsText(open)
  })
  assert.deepEqual(calls.map(([, args]) => args), [{ action: "list" }, { action: "close", index: 0 }, { action: "close", index: 0 }, { action: "close", index: 0 }], "one list, then one close per tab, and no list afterwards")
  assert.ok(calls.every(([name, , ms]) => name === "browser_tabs" && ms > 0))
  assert.equal(calls[0][2], 2500)
  const timed = []
  await real.closeOwnTabs(async (name, args, ms) => { timed.push(ms); return tabsText(0) }, 40)
  assert.deepEqual(timed, [40])
})

test("closing tabs stops at an error, a failed close or the limit, and never throws", async () => {
  const errors = []
  await real.closeOwnTabs(async (name, args) => { errors.push(args.action); return { isError: true, content: [] } })
  assert.deepEqual(errors, ["list"])
  const failed = []
  await real.closeOwnTabs(async (name, args) => { failed.push(args.action); return args.action === "list" ? tabsText(2) : { isError: true, content: [] } })
  assert.deepEqual(failed, ["list", "close"])
  let closes = 0
  await real.closeOwnTabs(async (name, args) => { if (args.action === "close") closes += 1; return tabsText(500) })
  assert.equal(closes, 50)
  await real.closeOwnTabs(async () => { throw new Error("the browser ended") })
  await real.closeOwnTabs(async (name, args) => { if (args.action === "close") throw new Error("timed out"); return tabsText(1) })
})

test("the tabs hooks answer browser_close themselves, close tabs only for a used connection, and do nothing at the end after a close", posixOnly, async () => {
  const calls = []
  const api = { callTool: async (name, args) => { calls.push(args.action); return tabsText(0) } }
  const tabs = real.ownTabs()
  await tabs.cleanup(api)
  assert.deepEqual(calls, [], "a session that never called the browser has no tabs to close")
  const unused = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.match(unused.content[0].text, /is closed/u, "browser_close is answered here, not passed on")
  assert.deepEqual(calls, [])
  assert.equal(await tabs.beforeCall({ name: "browser_navigate" }, api), null)
  assert.deepEqual(calls, [])
  const closed = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.equal(closed, unused)
  assert.deepEqual(calls, ["list"], "browser_close closes the tabs first")
  await tabs.cleanup(api)
  assert.deepEqual(calls, ["list"], "the end of the session after a close does nothing more")
  assert.equal(await tabs.beforeCall({ name: "browser_snapshot" }, api), null)
  await tabs.cleanup(api)
  assert.deepEqual(calls, ["list", "list"], "a call after a close starts a new connection that is cleaned up again")
})

// ---- the launcher in the real profile ----

const HOST_INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-host", version: "1" } }
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"

/** Stubs for the browser Playwright MCP would be: a spawn that records its command and answers the proxy's messages in order, logging each one to `events`. It keeps a list of open tabs: a `browser_tabs` list names them and a close removes the first. `options.tabs` is how many are open at the start (0 until a page tool runs), `options.mode` picks a misbehavior: silent (never answers a tool call), silenttabs (never answers browser_tabs), exittabs (exits when asked for its tabs), errortabs (answers browser_tabs with an error), or leak (puts the token in an answer, an error and a notification, and writes it to stderr in two pieces). */
function browserStub(events, options = {}) {
  const spawns = []
  const spawn = (file, argv, spawnOptions) => {
    const child = new EventEmitter()
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.pid = 90000 + spawns.length
    child.killed = []
    child.tabs = 0
    child.kill = (signal) => {
      child.killed.push(signal)
      events.push(`child:killed ${signal}`)
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
        const call = message.params?.name ? ` ${message.params.name}${message.params.arguments?.action ? ` ${message.params.arguments.action}` : ""}` : ""
        events.push(`child:${message.method}${call}`)
        const send = (body) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, ...body })}\n`)
        const reply = (result) => send({ result })
        if (message.method === "initialize") reply({ protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "Playwright", version: "stub" } })
        else if (message.method === "tools/list") reply({ tools: [] })
        else if (message.method === "tools/call") answerCall(message, reply, send)
      }
    })
    const answerCall = (message, reply, send) => {
      const { name, arguments: args } = message.params
      if (options.mode === "silent") return
      if (name === "browser_tabs") {
        if (options.mode === "silenttabs") return
        if (options.mode === "exittabs") { setImmediate(() => child.emit("exit", 9, null)); return }
        if (options.mode === "errortabs") { send({ error: { code: -32000, message: "tabs are unavailable" } }); return }
        if (args.action === "close") child.tabs -= 1
        reply({ content: [{ type: "text", text: child.tabs === 0 ? "### Open tabs\nNo open tabs." : `### Open tabs\n${Array.from({ length: child.tabs }, (_, index) => `- ${index}: [Page](https://example.com/${index})`).join("\n")}` }] })
        return
      }
      if (name !== "browser_close") child.tabs = Math.max(child.tabs, options.tabs ?? 1)
      if (options.mode === "leak") {
        const token = spawnOptions.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN
        child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { data: `connect?token=${encodeURIComponent(token)}` } })}\n`)
        child.stderr.write(`opening http://x/connect?client=a&token=${token.slice(0, 8)}`)
        child.stderr.write(`${token.slice(8)}&more\nnext line\n`)
        child.stderr.write(`tail without newline ${token}`)
        reply({ content: [{ type: "text", text: `opened chrome-extension://id/connect.html?token=${token} for ${name}` }] })
        return
      }
      reply({ content: [{ type: "text", text: `ran ${name}` }] })
    }
    child.stdin.on("end", () => setImmediate(() => { events.push("child:stdin closed"); child.emit("exit", 0, null) }))
    spawns.push({ file, argv, env: spawnOptions.env, stdio: spawnOptions.stdio, child })
    return child
  }
  return { spawn, spawns }
}

/** A preinstalled Playwright MCP (with or without the token reader), a fake Node install, a fake Edge executable and the plugin that declares the browser. */
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
    exists: (file) => file === npmCli || (options.edge !== false && file === EDGE),
    startRefresh: () => {},
    pluginDirs: () => dirs,
    requireModule: () => levelStub(levelEntries.entries),
    tmpdir: path.join(root, "tmp"),
    spawn: stub.spawn,
    tabCallMs: 200,
    cleanupMs: 2000,
    ...options.launch,
  }
  return { root, state, events, stub, launchOptions, levelEntries, dirs }
}

/** Run the launcher against a host over streams, recording stderr, exits and kills. */
function session(machine, extra = {}) {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  const messages = []
  const raw = []
  stdout.on("data", (chunk) => {
    raw.push(String(chunk))
    for (const line of String(chunk).split("\n").filter(Boolean)) messages.push(JSON.parse(line))
  })
  const stderr = []
  const exits = []
  const kills = []
  const signals = new EventEmitter()
  const running = browser.run({
    ...machine.launchOptions,
    stderr: { write: (text) => stderr.push(String(text)) },
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
    running, stderr, exits, kills, signals, stdin, messages, raw,
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
const tabEvents = (machine) => machine.events.filter((event) => event.startsWith("child:tools/call browser_tabs") || event.startsWith("child:tools/call browser_close") || event.startsWith("child:stdin") || event.startsWith("child:killed") || event.startsWith("kill:"))

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

test("with no declaration the browser is exactly what it was: headless, isolated, no wrapper and no token", posixOnly, async () => {
  const machine = await realMachine({ declare: null })
  const [spawned] = await direct(machine)
  assert.deepEqual(spawned.argv.slice(1, 3), ["--headless", "--isolated"])
  assert.equal(spawned.argv.includes("--executable-path"), false)
  assert.equal(spawned.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
  assert.equal(spawned.options.stdio, "inherit")
  assert.equal(existsSync(path.join(machine.state, "launchers")), false)
})

test("a caller's own connection option keeps the browser as the caller asked, without reading any declaration", posixOnly, async () => {
  const machine = await realMachine()
  const [spawned] = await direct(machine, { args: ["--cdp-endpoint", "http://127.0.0.1:9222"], pluginDirs: () => { throw new Error("must not look") } })
  assert.deepEqual(spawned.argv.slice(1, 3), ["--output-dir", path.join(machine.state, "output")])
  assert.ok(spawned.argv.includes("--cdp-endpoint"))
  assert.equal(spawned.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
})

test("a declaration attaches to the declared profile through the new-window wrapper, with the token in the environment only", posixOnly, async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  assert.equal(textOf(await host.call(2)), "ran browser_navigate")
  await host.close()
  const [spawned] = machine.stub.spawns
  const wrapper = path.join(machine.state, "launchers", "msedge-new-window.sh")
  assert.deepEqual(spawned.argv.slice(3), ["--extension", "--browser", "msedge", "--profile-dir-name", "Profile 4", "--executable-path", wrapper])
  assert.deepEqual(spawned.argv.slice(1, 3), ["--output-dir", path.join(machine.state, "output")])
  assert.equal(readFileSync(wrapper, "utf8"), real.launcherScript("darwin", EDGE))
  assert.equal(spawned.argv.includes("--headless"), false)
  assert.equal(spawned.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, TOKEN)
  assert.deepEqual(spawned.stdio, ["pipe", "pipe", "pipe"])
  assert.equal(JSON.stringify([spawned.file, spawned.argv]).includes(TOKEN), false)
  assert.equal(host.stderr.join("").includes(TOKEN), false)
  assert.match(host.stderr.join(""), /driving the Microsoft Edge profile Profile 4 through the Playwright Extension/u)
  assert.equal(JSON.stringify(host.messages).includes(TOKEN), false)
  assert.deepEqual(readdirSync(path.join(machine.root, "tmp")), [])
})

test("a browser that is not installed is one degraded line on the first call", posixOnly, async () => {
  const machine = await realMachine({ edge: false })
  const host = session(machine)
  await host.handshake()
  assert.equal(JSON.parse(textOf(await host.call(2))).code, "browser_not_installed")
  assert.equal(machine.stub.spawns.length, 0)
  await host.close()
})

test("the token is replaced wherever the browser's output would carry it to the host", posixOnly, async () => {
  const machine = await realMachine({ mode: "leak" })
  const host = session(machine)
  await host.handshake()
  const answer = await host.call(2)
  assert.equal(textOf(answer), "opened chrome-extension://id/connect.html?token=<redacted> for browser_navigate")
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.equal(host.raw.join("").includes(TOKEN), false)
  assert.equal(host.raw.join("").includes(encodeURIComponent(TOKEN)), false)
  assert.ok(host.messages.some((message) => message.method === "notifications/message" && message.params.data === "connect?token=<redacted>"))
  assert.equal(host.stderr.join("").includes(TOKEN), false)
  assert.match(host.stderr.join(""), /connect\?client=a&token=<redacted>&more\n/u)
  assert.match(host.stderr.join(""), /next line\n/u)
  assert.match(host.stderr.join(""), /tail without newline <redacted>/u)
  assert.equal(host.stderr.join("").includes(TOKEN.slice(0, 8) + TOKEN.slice(8)), false)
})

test("the token is replaced in a JSON-escaped form too", posixOnly, async () => {
  const odd = 'to"k\\en/+'
  const machine = await realMachine({ entries: [[tokenKey(), latin(odd)]], mode: "leak" })
  const host = session(machine)
  await host.handshake()
  const answer = await host.call(2)
  assert.match(textOf(answer), /token=<redacted> for/u)
  await host.close()
  assert.equal(host.raw.join("").includes(JSON.stringify(odd).slice(1, -1)), false)
  assert.equal(host.raw.join("").includes(odd), false)
})

test("browser_close closes every tab of the agent and is answered without reaching the browser", posixOnly, async () => {
  const machine = await realMachine({ tabs: 2 })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  const answer = await host.call(3, "browser_close")
  assert.match(textOf(answer), /is closed/u)
  assert.deepEqual(tabEvents(machine), [
    "child:tools/call browser_tabs list",
    "child:tools/call browser_tabs close",
    "child:tools/call browser_tabs close",
  ])
  assert.equal(machine.stub.spawns[0].child.tabs, 0)
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.deepEqual(tabEvents(machine), [
    "child:tools/call browser_tabs list",
    "child:tools/call browser_tabs close",
    "child:tools/call browser_tabs close",
    "child:stdin closed",
  ], "ending after browser_close does nothing more to the browser, so no second connect page opens")
  assert.equal(host.messages.filter((message) => message.id === 3).length, 1)
})

test("a browser call after browser_close connects again and its tabs are closed at the end", posixOnly, async () => {
  const machine = await realMachine({ tabs: 1 })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  await host.call(3, "browser_close")
  assert.equal(textOf(await host.call(4)), "ran browser_navigate")
  host.stdin.end()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.equal(machine.events.filter((event) => event === "child:tools/call browser_navigate").length, 2)
  assert.equal(machine.events.filter((event) => event === "child:tools/call browser_close").length, 0)
  assert.equal(machine.stub.spawns[0].child.tabs, 0)
})

test("the host closing stdin closes the agent's tabs before the browser is told to stop", posixOnly, async () => {
  const machine = await realMachine({ tabs: 1 })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  host.stdin.end()
  await host.wait(() => host.exits.length === 1, "the launcher to exit")
  assert.deepEqual(tabEvents(machine), [
    "child:tools/call browser_tabs list",
    "child:tools/call browser_tabs close",
    "child:stdin closed",
  ])
  assert.deepEqual(host.exits, [0])
})

test("a stop signal closes the tabs, then stops the browser and ends the launcher the way the host asked", posixOnly, async () => {
  for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"]) {
    const machine = await realMachine({ tabs: 1 })
    const host = session(machine)
    await host.handshake()
    await host.call(2)
    host.signals.emit(signal)
    await host.wait(() => host.kills.length === 1, "the launcher to pass the signal on")
    assert.deepEqual(host.kills, [signal])
    assert.deepEqual(tabEvents(machine), [
      "child:tools/call browser_tabs list",
      "child:tools/call browser_tabs close",
      `child:killed ${signal}`,
      `kill:${signal}`,
    ])
  }
})

test("a session that never called the browser has no tabs and touches none", posixOnly, async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.deepEqual(tabEvents(machine), ["child:stdin closed"])
  const signalled = await realMachine()
  const other = session(signalled)
  await other.handshake()
  other.signals.emit("SIGTERM")
  await other.wait(() => other.kills.length === 1, "the signal to be passed on")
  assert.equal(signalled.events.some((event) => event.startsWith("child:tools/call")), false)
})

test("two sessions at once each close only their own tabs", posixOnly, async () => {
  const events = []
  const [a, b] = await Promise.all([realMachine({ events, tabs: 1 }), realMachine({ events, tabs: 3 })])
  const first = session(a)
  const second = session(b)
  await Promise.all([first.handshake(), second.handshake()])
  await first.call(2)
  await second.call(2)
  await first.call(3, "browser_close")
  assert.equal(a.stub.spawns[0].child.tabs, 0)
  assert.equal(b.stub.spawns[0].child.tabs, 3)
  await first.close()
  await second.close()
  await second.wait(() => second.exits.length === 1, "the second launcher to end")
  assert.equal(b.stub.spawns[0].child.tabs, 0)
})

test("cleanup is cut off when the browser stops answering, and the launcher still ends", posixOnly, async () => {
  for (const mode of ["silenttabs", "errortabs", "exittabs"]) {
    const machine = await realMachine({ mode, launch: { tabCallMs: 30, cleanupMs: 400 } })
    const host = session(machine)
    await host.handshake()
    await host.call(2)
    host.stdin.end()
    await host.wait(() => host.exits.length > 0, `the launcher to end in mode ${mode}`)
  }
  const stuck = await realMachine({ mode: "silenttabs", launch: { tabCallMs: 5000, cleanupMs: 60 } })
  const host = session(stuck)
  await host.handshake()
  await host.call(2)
  host.stdin.end()
  await host.wait(() => host.exits.length === 1, "the launcher to end although a call is still waiting")
})

test("a repeated stop does not run the cleanup twice at once", posixOnly, async () => {
  const machine = await realMachine({ tabs: 1 })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  host.signals.emit("SIGTERM")
  host.signals.emit("SIGHUP")
  await host.wait(() => host.kills.length === 2, "both signals to be passed on")
  assert.equal(machine.events.filter((event) => event === "child:tools/call browser_tabs close").length, 1)
})

test("a browser process that ends takes its tabs with it, and the launcher ends with its code", posixOnly, async () => {
  const machine = await realMachine({ mode: "silent" })
  const host = session(machine)
  await host.handshake()
  host.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await host.wait(() => machine.events.includes("child:tools/call browser_navigate"), "the call to reach the browser")
  machine.stub.spawns[0].child.emit("exit", 3, null)
  const answer = await host.reply(2)
  assert.match(textOf(answer), /browser_exited/u)
  await host.wait(() => host.exits.length === 1, "the launcher to exit")
  assert.deepEqual(host.exits, [3])
})

test("a missing extension is one clear line on the first call, then works once it is installed, with no picker and no fallback", posixOnly, async () => {
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
  assert.equal(host.stderr.filter((line) => line.includes("browser_extension_missing")).length, 1)
  machine.levelEntries.entries = [[tokenKey(), latin(TOKEN)]]
  assert.equal(textOf(await host.call(3)), "ran browser_navigate")
  assert.equal(machine.stub.spawns.length, 1)
  await host.close()
})

test("a declared profile that is not there names what was looked for", posixOnly, async () => {
  const machine = await realMachine({ accounts: { Default: "me@gmail.com" } })
  const host = session(machine)
  await host.handshake()
  const payload = JSON.parse(textOf(await host.call(2)))
  assert.equal(payload.code, "browser_profile_not_found")
  assert.match(payload.summary, /@microsoft\.com/u)
  assert.equal(machine.stub.spawns.length, 0)
  await host.close()
})

test("a declaration that cannot be used degrades the whole server with a code that names the manifest", posixOnly, async () => {
  const machine = await realMachine({ declare: { browser: { channel: "netscape", profileAccountDomain: "microsoft.com" } } })
  const host = session(machine)
  await host.handshake()
  const payload = JSON.parse(textOf(await host.call(2)))
  assert.equal(payload.code, "browser_declaration_invalid")
  assert.match(payload.summary, /plugin\.json/u)
  await host.close()
  assert.equal(machine.stub.spawns.length, 0)
})

test("a Playwright MCP install without the token reader is installed again with it, and the reader is installed beside Playwright MCP in one npm call", posixOnly, async () => {
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
