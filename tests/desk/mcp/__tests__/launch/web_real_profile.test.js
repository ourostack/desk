// Desk's browser in the operator's real profile (mcp/web-real-profile.cjs and its use in mcp/web.cjs).
//
// When a plugin declares `desk.browser`, `desk-web` attaches to the operator's own signed-in browser profile through the Playwright Extension, in a window of its own whose tabs it closes when it is done. These tests never script a browser, never start one and never read a real profile: the filesystem (temporary folders), the LevelDB reader and the child processes are all injected, and the browser is a stub that keeps a list of tabs. The token is a made-up string, and every test that could leak it checks the command lines, the host's output and stderr for it.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
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
  assert.deepEqual(real.pluginDirs({ env: { DESK_PLUGIN_ROOT: desk, CLAUDE_PLUGIN_ROOT: desk }, homeDir: home }), [desk, overlay])
  assert.deepEqual(real.pluginDirs({ env: { DESK_PLUGIN_ROOT: desk, CLAUDE_PLUGIN_ROOT: desk, CLAUDE_CONFIG_DIR: path.join(root, "none") }, homeDir: home }), [])
  const copilot = path.join(root, "copilot", "installed")
  mkdirSync(path.join(copilot, "desk"), { recursive: true })
  mkdirSync(path.join(copilot, "ms-desk"), { recursive: true })
  assert.deepEqual(real.pluginDirs({ env: { COPILOT_PLUGIN_ROOT: path.join(copilot, "desk") }, homeDir: home }).sort(), [path.join(copilot, "desk"), path.join(copilot, "ms-desk")])
  assert.deepEqual(real.pluginDirs({ env: { COPILOT_PLUGIN_ROOT: path.join(root, "nowhere", "desk") }, homeDir: home }), [])
  // With no variable at all, Desk's root is this checkout's own folder and the host is Copilot's: the folders beside it are listed, with no Claude registry read.
  assert.ok(real.pluginDirs({ env: {}, homeDir: path.join(root, "empty-home") }).includes(path.resolve(mcpRoot, "..")))
})

const DECLARES = { browser: { channel: "msedge", profileAccountDomain: "microsoft.com" } }

/** An Agency or Copilot session folder with `desk` and `ms-desk` side by side; ms-desk declares the browser when `declares` is true. */
function sessionLayout(root, declares = true) {
  const session = path.join(root, "session")
  mkdirSync(path.join(session, "desk"), { recursive: true })
  pluginDir(session, "ms-desk", declares ? DECLARES : {})
  return session
}

test("a Copilot or Agency session finds the declaration with neither host variable set", async () => {
  const root = await mkTempRoot("real-host-")
  const home = path.join(root, "home")
  const session = sessionLayout(root)
  const declared = { state: "declared", channel: "msedge", domain: "microsoft.com" }
  // Agency: no COPILOT_PLUGIN_ROOT, no CLAUDE_PLUGIN_ROOT; Desk's root comes from DESK_PLUGIN_ROOT, which the launcher sets.
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: path.join(session, "desk") }, homeDir: home }), declared)
  // Plain Copilot: the same layout, with COPILOT_PLUGIN_ROOT set.
  assert.deepEqual(real.readDeclaration({ env: { COPILOT_PLUGIN_ROOT: path.join(session, "desk") }, homeDir: home }), declared)
  // A blank variable counts as unset.
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: path.join(session, "desk"), CLAUDE_PLUGIN_ROOT: "  " }, homeDir: home }), declared)
})

test("a Claude Code session reads the plugin registry", async () => {
  const root = await mkTempRoot("real-host-claude-")
  const home = path.join(root, "home")
  const cache = path.join(home, ".claude", "plugins", "cache")
  const desk = path.join(cache, "desk")
  const overlay = pluginDir(cache, "overlay", DECLARES)
  mkdirSync(desk, { recursive: true })
  touch(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: {
    "desk@ourostack": [{ scope: "user", installPath: desk, version: "3.2.0-alpha.1" }],
    "overlay@internal": [{ scope: "user", installPath: overlay, version: "2.0.0" }],
  } }))
  const declared = { state: "declared", channel: "msedge", domain: "microsoft.com" }
  // With CLAUDE_PLUGIN_ROOT set, as Claude Code sets it.
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: desk, CLAUDE_PLUGIN_ROOT: desk }, homeDir: home }), declared)
  // Without it, Desk's place in Claude's plugin store still says Claude.
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: desk }, homeDir: home }), declared)
  // A relocated Claude config folder is Claude's store too.
  const config = path.join(root, "config")
  touch(path.join(config, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "overlay@internal": [{ scope: "user", installPath: overlay, version: "2.0.0" }] } }))
  const elsewhere = path.join(config, "plugins", "cache", "desk")
  mkdirSync(elsewhere, { recursive: true })
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: elsewhere, CLAUDE_CONFIG_DIR: config }, homeDir: home }), declared)
})

test("with no declaring plugin anywhere, every host gives none", async () => {
  const root = await mkTempRoot("real-host-none-")
  const home = path.join(root, "home")
  const session = sessionLayout(root, false)
  const desk = path.join(home, ".claude", "plugins", "cache", "desk")
  mkdirSync(desk, { recursive: true })
  touch(path.join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "desk@ourostack": [{ scope: "user", installPath: desk, version: "3.2.0-alpha.1" }] } }))
  const none = { state: "none" }
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: path.join(session, "desk") }, homeDir: home }), none)
  assert.deepEqual(real.readDeclaration({ env: { COPILOT_PLUGIN_ROOT: path.join(session, "desk") }, homeDir: home }), none)
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: desk, CLAUDE_PLUGIN_ROOT: desk }, homeDir: home }), none)
  assert.deepEqual(real.readDeclaration({ env: { DESK_PLUGIN_ROOT: desk }, homeDir: home }), none)
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
  return { declaration: { state: "declared", channel: "msedge", domain: "microsoft.com" }, installed, executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", platform: "darwin", env: {}, homeDir: path.join(root, "home"), unavailable, reconnectFix: fixAfter, tmpdir: path.join(root, "tmp"), ...overrides }
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
  assert.match(noExtension.payload.fix, /if it is already installed, click its toolbar icon once to open its page, then retry\.$/u)
  assert.match(noExtension.payload.summary, /profile Profile 3/u)
  assert.equal((await real.connect(connectOptions(root, { requireModule: modules([[tokenKey(), latin("")]]) }))).payload.code, "browser_extension_missing")

  const unreadable = await real.connect(connectOptions(root, { requireModule: modules([], { failRead: true }) }))
  assert.equal(unreadable.payload.code, "browser_token_unreadable")
  assert.match(unreadable.payload.summary, /corrupt table/u)

  const noReader = await real.connect(connectOptions(root, { requireModule: () => { throw new Error("Cannot find module 'classic-level'") } }))
  assert.equal(noReader.payload.code, "browser_token_unreadable")
  assert.match(noReader.payload.fix, /^Check that this machine can reach the npm registry, then retry\. If the problem persists after npm works, delete .*install .* installs the browser again\.$/u)
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
  assert.deepEqual(answer.args, ["--extension", "--browser", "chrome", "--profile-dir-name", "Default"])
  assert.deepEqual(answer.env, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN })
  assert.deepEqual(answer.secrets, [TOKEN])
  assert.equal(answer.executable, "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
  assert.equal(answer.profile, "Default")
  assert.doesNotMatch(answer.args.join(" "), new RegExp(TOKEN, "u"))
})

test("a browser that is not installed is one clear line before anything is read", async () => {
  const root = await mkTempRoot("real-connect-")
  const answer = await real.connect(connectOptions(root, { executable: null }))
  assert.equal(answer.payload.code, "browser_not_installed")
  assert.match(answer.payload.summary, /Microsoft Edge/u)
})

// ---- the agent's own window ----

function fakeBrowserProcess(events = []) {
  const child = new EventEmitter()
  child.unref = () => events.push("unref")
  return child
}

// ---- the agent's own tabs ----

const tabsText = (count) => ({ content: [{ type: "text", text: count === 0 ? "### Open tabs\nNo open tabs." : `### Open tabs\n${Array.from({ length: count }, (_, index) => `- ${index}: ${index === 0 ? "(current) " : ""}[Page ${index}](https://example.com/${index})`).join("\n")}` }] })

test("cleanup closes later task and control tabs before the oldest connection tab", async () => {
  const indexes = []
  let tabs = 3
  const response = await real.closeOwnTabs(async (name, args) => {
    if (args.action === "list") return tabsText(tabs)
    indexes.push(args.index)
    assert.equal(args.index, tabs - 1)
    tabs -= 1
    return tabsText(tabs)
  }, 100)
  assert.deepEqual(indexes, [2, 1, 0])
  assert.equal(response.isError, undefined)
})

test("cleanup cannot confirm closure while the first dispatched operation is unresolved", async () => {
  const tabs = real.ownTabs(async () => {}, 100)
  const operation = {}
  const params = { name: "browser_navigate" }
  const api = { callTool: async (name, args) => tabsText(args.action === "list" ? 1 : 0) }
  assert.equal(await tabs.beforeCall(params, api, operation), null)
  let finished = false
  const closing = tabs.beforeCall({ name: "browser_close" }, api).then(result => { finished = true; return result })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(finished, false, "an unresolved first operation owns the cleanup interval")
  tabs.afterCall(params, false, operation)
  assert.equal((await closing).isError, undefined)
})

test("a timed-out wait for pending operations retains the connection and never reports closed", async () => {
  let opens = 0
  let cleanupCalls = 0
  const tabs = real.ownTabs(async () => { opens += 1 }, 15)
  const operation = {}
  const params = { name: "browser_navigate" }
  const api = { callTool: async (name, args) => { cleanupCalls += 1; return tabsText(args.action === "list" ? 1 : 0) } }
  await tabs.beforeCall(params, api, operation)
  const incomplete = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.equal(incomplete.isError, true)
  assert.equal(JSON.parse(incomplete.content[0].text).code, "browser_cleanup_incomplete")
  assert.equal(cleanupCalls, 0, "cleanup never starts a replacement while an operation is pending")
  assert.equal(opens, 1)
  tabs.afterCall(params, false, operation)
  assert.equal((await tabs.beforeCall({ name: "browser_close" }, api)).isError, undefined)
  assert.equal(opens, 1)
})

test("cleanup waits for every concurrent operation, not just the first response", async () => {
  const tabs = real.ownTabs(async () => {}, 100)
  const a = {}, b = {}
  const params = { name: "browser_navigate" }
  const api = { callTool: async (name, args) => tabsText(args.action === "list" ? 1 : 0) }
  await Promise.all([tabs.beforeCall(params, api, a), tabs.beforeCall(params, api, b)])
  let complete = false
  const closing = tabs.beforeCall({ name: "browser_close" }, api).then(result => { complete = true; return result })
  tabs.afterCall(params, false, a)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(complete, false)
  tabs.afterCall(params, false, b)
  assert.equal((await closing).isError, undefined)
})

test("a failed pending operation leaves no browser for cleanup to create", async () => {
  const tabs = real.ownTabs(async () => {}, 100)
  const operation = {}
  const params = { name: "browser_navigate" }
  const api = { callTool: async () => { assert.fail("cleanup must not initiate a connection"); } }
  await tabs.beforeCall(params, api, operation)
  const closing = tabs.beforeCall({ name: "browser_close" }, api)
  tabs.afterCall(params, true, operation)
  assert.equal((await closing).isError, undefined)
})

test("cancellation while waiting behind cleanup never registers a phantom operation or prepares again", async () => {
  let opens = 0
  let completeCleanup
  const tabs = real.ownTabs(async () => { opens += 1 }, 20)
  const params = { name: "browser_navigate" }
  const first = {}
  const api = { callTool: () => new Promise(resolve => { completeCleanup = resolve }) }
  await tabs.beforeCall(params, api, first)
  tabs.afterCall(params, false, first)
  const closing = tabs.beforeCall({ name: "browser_close" }, api)
  await Promise.resolve()
  const cancelled = {}
  const queued = tabs.beforeCall(params, api, cancelled)
  cancelled.cancelled = true
  tabs.afterCall(params, true, cancelled)
  completeCleanup(tabsText(0))
  await Promise.all([closing, queued])
  const next = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.equal(next.isError, undefined, "cancelled work cannot survive as a pending operation")
  assert.equal(opens, 1, "cancellation cannot clear the receipt through another preparation")
})

test("real-profile tab selection refuses before window preparation and explains honest action-scoped alternatives", posixOnly, async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  const response = await host.ask(2, "tools/call", { name: "browser_tabs", arguments: { action: "select", index: 0 } })
  assert.equal(response.result.isError, true)
  const payload = JSON.parse(textOf(response))
  assert.equal(payload.code, "browser_focus_activation_refused")
  assert.match(payload.fix, /existing current tab/u)
  assert.match(payload.fix, /browser_run_code_unsafe/u)
  assert.equal(machine.opens.length, 0)
  assert.equal(machine.events.some(event => event === "child:tools/call browser_tabs select"), false)
  await host.close()
})

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
  assert.deepEqual(calls.map(([, args]) => args), [{ action: "list" }, { action: "close", index: 2 }, { action: "close", index: 1 }, { action: "close", index: 0 }], "one list, then one close per tab, and no list afterwards")
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
  const early = []
  await real.closeOwnTabs(async (name, args) => { early.push(args.action); return args.action === "list" ? tabsText(3) : tabsText(0) })
  assert.deepEqual(early, ["list", "close"], "a close that says no tab is open ends the cleanup")
  await real.closeOwnTabs(async () => { throw new Error("the browser ended") })
  await real.closeOwnTabs(async (name, args) => { if (args.action === "close") throw new Error("timed out"); return tabsText(1) })
})

test("cleanup reports partial or unknown effects instead of claiming that the window closed", async () => {
  for (const behavior of ["list-error", "close-error", "timeout", "malformed", "limit"]) {
    let closed = 0
    const result = await real.closeOwnTabs(async (name, args) => {
      if (behavior === "timeout") throw new Error("remote endpoint with private details")
      if (behavior === "malformed") return { content: [] }
      if (behavior === "list-error") return { isError: true, content: [] }
      if (behavior === "limit") return tabsText(100)
      if (args.action === "list") return tabsText(2)
      if (++closed === 1) return tabsText(1)
      return { isError: true, content: [] }
    })
    assert.equal(result.isError, true, behavior)
    const payload = JSON.parse(result.content[0].text)
    assert.equal(payload.code, "browser_cleanup_incomplete")
    assert.doesNotMatch(payload.summary, /window.*is closed|private details/u)
    assert.match(payload.fix, /Do not close another.*window/u)
    assert.equal(payload.closed, behavior === "limit" ? 50 : behavior === "close-error" ? 1 : 0)
  }
})

test("cleanup succeeds only after the connection explicitly reports no remaining tabs", async () => {
  const empty = await real.closeOwnTabs(async () => tabsText(0))
  assert.equal(empty.isError, undefined)
  assert.match(empty.content[0].text, /is closed/u)
  let calls = 0
  const residual = await real.closeOwnTabs(async () => ++calls === 1 ? tabsText(1) : tabsText(2))
  assert.equal(residual.isError, true)
  assert.equal(JSON.parse(residual.content[0].text).remaining, 2)
  assert.equal(calls, 2, "no extra list that could create a new tab")
})

test("a tab title containing No open tabs never produces a false empty-connection receipt", async () => {
  for (const stage of ["list", "close"]) {
    let calls = 0
    const answer = await real.closeOwnTabs(async () => {
      calls += 1
      if (stage === "list") return calls === 1 ? {
        content: [{ type: "text", text: "### Open tabs\n- 0: (current) [No open tabs](https://example.com/)" }],
      } : tabsText(0)
      if (calls === 1) return tabsText(2)
      return calls === 2 ? {
        content: [{ type: "text", text: "### Open tabs\n- 0: [A title\nNo open tabs.\nstill in the title](https://example.com/)" }],
      } : tabsText(0)
    })
    assert.equal(calls, stage === "list" ? 2 : 3, "all indexed tabs must be closed")
    assert.match(answer.content[0].text, /is closed/u)
  }
})

test("empty or missing cleanup responses cannot prove that a close succeeded", async () => {
  for (const result of [undefined, null, {}, { content: [] }, { content: [{ type: "image" }] }]) {
    let calls = 0
    const answer = await real.closeOwnTabs(async () => ++calls === 1 ? tabsText(1) : result)
    assert.equal(answer.isError, true)
    const payload = JSON.parse(answer.content[0].text)
    assert.equal(payload.remaining, null)
    assert.equal(payload.closed, 0, "malformed responses do not verify a closed tab")
  }
  const answer = await real.closeOwnTabs(async () => undefined)
  assert.equal(answer.isError, true)
})

test("failed cleanup retains the same connection for exact retry instead of opening another window", async () => {
  let opens = 0
  let broken = true
  const actions = []
  const tabs = real.ownTabs(async () => { opens += 1 })
  const api = { callTool: async (name, args) => {
    actions.push(args.action)
    return broken ? { isError: true, content: [] } : tabsText(0)
  } }
  await tabs.beforeCall({ name: "browser_navigate" }, api)
  tabs.afterCall({ name: "browser_navigate" }, false)
  const failed = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.equal(failed.isError, true)
  await tabs.beforeCall({ name: "browser_snapshot" }, api)
  assert.equal(opens, 1, "cleanup failure must not forget the existing window")
  broken = false
  const retried = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.match(retried.content[0].text, /is closed/u)
  assert.deepEqual(actions, ["list", "list"], "retry remains scoped to the same connection")
  await tabs.beforeCall({ name: "browser_snapshot" }, api)
  assert.equal(opens, 2, "only successful cleanup allows a new holding window")
})

test("concurrent cleanup requests share one closing attempt", async () => {
  let finish
  let lists = 0
  const tabs = real.ownTabs(async () => {})
  const api = { callTool: () => {
    lists += 1
    return new Promise((resolve) => { finish = resolve })
  } }
  await tabs.beforeCall({ name: "browser_navigate" }, api)
  tabs.afterCall({ name: "browser_navigate" }, false)
  const first = tabs.beforeCall({ name: "browser_close" }, api)
  let answered = false
  const second = tabs.beforeCall({ name: "browser_close" }, api).then((result) => {
    answered = true
    return result
  })
  await Promise.resolve()
  assert.equal(lists, 1)
  assert.equal(answered, false, "no closed receipt before the shared cleanup finishes")
  finish(tabsText(0))
  assert.equal(await first, await second)
})

test("browser operations arriving during cleanup wait for its receipt before using or replacing the connection", async () => {
  for (const failed of [false, true]) {
    let finish
    let opens = 0
    const tabs = real.ownTabs(async () => { opens += 1 })
    const api = { callTool: () => new Promise((resolve) => { finish = resolve }) }
    await tabs.beforeCall({ name: "browser_navigate" }, api)
    tabs.afterCall({ name: "browser_navigate" }, false)
    const closing = tabs.beforeCall({ name: "browser_close" }, api)
    let answered = false
    const next = tabs.beforeCall({ name: "browser_snapshot" }, api).then((result) => {
      answered = true
      return result
    })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(answered, false, "do not forward into a connection being closed")
    finish(failed ? { isError: true, content: [] } : tabsText(0))
    await closing
    const result = await next
    assert.equal(result === null, !failed)
    assert.equal(opens, failed ? 1 : 2, "replace only after verified cleanup")
  }
})

test("the tabs hooks open the window once per connection, answer browser_close themselves, and mark a connection used only after a success", posixOnly, async () => {
  const calls = []
  let opens = 0
  const api = { callTool: async (name, args) => { calls.push(args.action); return tabsText(0) } }
  const tabs = real.ownTabs(async () => { opens += 1 })
  await tabs.cleanup(api)
  assert.deepEqual(calls, [], "a session that never called the browser has no tabs to close")
  const unused = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.match(unused.content[0].text, /is closed/u, "browser_close is answered here, not passed on")
  assert.deepEqual([calls, opens], [[], 0], "closing an unused connection opens nothing and closes nothing")
  assert.equal(await tabs.beforeCall({ name: "browser_navigate" }, api), null)
  assert.equal(await tabs.beforeCall({ name: "browser_snapshot" }, api), null)
  assert.equal(opens, 1)
  tabs.afterCall({ name: "browser_navigate" }, true)
  await tabs.cleanup(api)
  assert.deepEqual(calls, [], "a failed call does not make cleanup start a connection")
  tabs.afterCall({ name: "browser_close" }, false)
  await tabs.cleanup(api)
  assert.deepEqual(calls, [])
  tabs.afterCall({ name: "browser_navigate" }, false)
  const closed = await tabs.beforeCall({ name: "browser_close" }, api)
  assert.equal(closed, unused)
  assert.deepEqual(calls, ["list"], "browser_close closes the tabs")
  await tabs.cleanup(api)
  assert.deepEqual(calls, ["list"], "the end of the session after a close does nothing more")
  assert.equal(await tabs.beforeCall({ name: "browser_snapshot" }, api), null)
  assert.equal(opens, 2, "a call after a close opens a new window")
  tabs.afterCall({ name: "browser_snapshot" }, false)
  await tabs.cleanup(api)
  assert.deepEqual(calls, ["list", "list"])
})

test("a failed window attempt answers locally, performs no cleanup, and can be retried", async () => {
  const failed = { isError: true, content: [{ type: "text", text: "window unavailable" }] }
  let opens = 0
  const calls = []
  const tabs = real.ownTabs(async () => ++opens === 1 ? failed : undefined)
  const api = { callTool: async (...args) => { calls.push(args); return tabsText(0) } }
  assert.equal(await tabs.beforeCall({ name: "browser_navigate" }, api), failed)
  await tabs.cleanup(api)
  assert.deepEqual(calls, [], "failure never makes cleanup start a browser connection")
  assert.equal(await tabs.beforeCall({ name: "browser_snapshot" }, api), null)
  assert.equal(opens, 2, "the next call makes one new opening attempt")
})

test("an old failed opening does not clear a newer attempt after browser_close", async () => {
  const failed = { isError: true, content: [{ type: "text", text: "window unavailable" }] }
  const complete = []
  let opens = 0
  const tabs = real.ownTabs(() => {
    opens += 1
    return new Promise((resolve) => complete.push(resolve))
  })
  const api = { callTool: async () => tabsText(0) }
  const old = tabs.beforeCall({ name: "browser_navigate" }, api)
  await tabs.beforeCall({ name: "browser_close" }, api)
  const current = tabs.beforeCall({ name: "browser_snapshot" }, api)
  complete[0](failed)
  assert.equal(await old, failed)
  const joined = tabs.beforeCall({ name: "browser_navigate" }, api)
  assert.equal(opens, 2, "the current attempt is still shared after the old failure")
  complete[1]()
  assert.equal(await current, null)
  assert.equal(await joined, null)
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
    child.recreated = 0
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
        if (message.method === "initialize") {
          child.clientInfo = message.params.clientInfo
          reply({ protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "Playwright", version: "stub" } })
        }
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
        if (options.mode === "holdcleanup" && args.action === "list" && child.completeCleanup === undefined) {
          child.completeCleanup = () => { child.tabs = 0; reply({ content: [{ type: "text", text: "### Open tabs\nNo open tabs." }] }) }
          return
        }
        if (args.action === "close" && child.tabs === 0) { reply({ content: [{ type: "text", text: "### Open tabs\nNo open tabs." }] }); return }
        if (args.action === "close") child.tabs -= 1
        if (args.action === "list" && child.tabs === 0) { child.tabs = 1; child.recreated += 1 }
        reply({ content: [{ type: "text", text: child.tabs === 0 ? "### Open tabs\nNo open tabs." : `### Open tabs\n${Array.from({ length: child.tabs }, (_, index) => `- ${index}: [Page](https://example.com/${index})`).join("\n")}` }] })
        return
      }
      if (options.mode === "failcall") { reply({ isError: true, content: [{ type: "text", text: "navigation failed" }] }); return }
      if (options.mode === "rpcerror") { send({ error: { code: -32603, message: "owned protocol failure" } }); return }
      if (options.mode === "emptyresult") { reply(null); return }
      child.tabs = Math.max(child.tabs, options.tabs ?? 1)
      if (options.mode === "heldfirst" && child.completeFirst === undefined) {
        child.completeFirst = () => reply({ content: [{ type: "text", text: `ran ${name}` }] })
        return
      }
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
  const opens = []
  const openSpawn = (file, argv, spawnOptions) => {
    opens.push({ file, argv, options: spawnOptions })
    events.push("open:window")
    return fakeBrowserProcess()
  }
  const nativeLaunch = (settings) => ({
    file: path.join(root, "desk-browser-launch"),
    owner: settings.owner,
    env: { DESK_BROWSER_EXECUTABLE: settings.executable, DESK_BROWSER_OWNER: settings.owner },
    before: () => {
      const child = (options.launch?.openSpawn ?? openSpawn)(settings.executable, ["--check"], { env: {} })
      assert.ok(child)
      return null
    },
    read: () => options.mode === "failcall" ? null : ({ version: 1, status: "spawned", pid: 90001 }),
    dispose: () => {},
  })
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
    openSpawn,
    nativeLaunch,
    openWaitMs: 5,
    tabCallMs: 200,
    cleanupMs: 2000,
    ...options.launch,
  }
  return { root, state, events, stub, opens, launchOptions, levelEntries, dirs }
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
  const running = (extra.run ?? browser.run)({
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

test("a window launch error never forwards the operation and a later call retries", posixOnly, async () => {
  let opens = 0
  const machine = await realMachine({
    launch: {
      openSpawn: () => {
        opens += 1
        if (opens === 1) throw new Error("EACCES")
        return fakeBrowserProcess()
      },
    },
  })
  const host = session(machine)
  try {
    await host.handshake()
    const failed = await host.call(10)
    assert.equal(failed.result.isError, true)
    const payload = JSON.parse(textOf(failed))
    assert.equal(payload.code, "browser_window_unavailable")
    assert.match(payload.summary, /EACCES/u)
    assert.match(payload.fix, /Do not use another window/u)
    assert.equal(machine.events.includes("child:tools/call browser_navigate"), false)
    assert.deepEqual(tabEvents(machine), [])
    const retried = await host.call(11)
    assert.equal(retried.result.isError, undefined)
    assert.equal(opens, 2)
    assert.equal(machine.events.filter((event) => event === "child:tools/call browser_navigate").length, 1)
  } finally {
    await host.close()
  }
})

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

test("with no declaration the browser is exactly what it was: headless, isolated, no window and no token", posixOnly, async () => {
  const machine = await realMachine({ declare: null })
  const [spawned] = await direct(machine)
  assert.deepEqual(spawned.argv.slice(1, 3), ["--headless", "--isolated"])
  assert.equal(spawned.argv.includes("--executable-path"), false)
  assert.equal(spawned.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
  assert.equal(spawned.options.stdio, "inherit")
  assert.equal(machine.opens.length, 0)
})

test("a caller's own connection option keeps the browser as the caller asked, without reading any declaration", posixOnly, async () => {
  const machine = await realMachine()
  const [spawned] = await direct(machine, { args: ["--cdp-endpoint", "http://127.0.0.1:9222"], pluginDirs: () => { throw new Error("must not look") } })
  assert.deepEqual(spawned.argv.slice(1, 3), ["--output-dir", path.join(machine.state, "output")])
  assert.ok(spawned.argv.includes("--cdp-endpoint"))
  assert.equal(spawned.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
})

test("a declaration routes the official connect launch directly to a new window, with a distinct owner and no holding page", posixOnly, async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  await host.ask(5, "tools/list", {})
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(machine.opens.length, 0, "nothing opens before a browser call")
  assert.equal(textOf(await host.call(2)), "ran browser_navigate")
  await host.call(3, "browser_snapshot")
  await host.close()
  assert.equal(machine.opens.length, 1, "one window per connection")
  const [opened] = machine.opens
  assert.equal(opened.file, EDGE)
  assert.deepEqual(opened.argv, ["--check"], "the parent preflights but does not launch a holding page")
  assert.equal(JSON.stringify(opened).includes(TOKEN), false, "the token never reaches the window's browser start")
  assert.equal(opened.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
  assert.ok(machine.events.indexOf("open:window") > machine.events.indexOf("child:initialize"))
  assert.ok(machine.events.indexOf("open:window") < machine.events.indexOf("child:tools/call browser_navigate"))
  const [spawned] = machine.stub.spawns
  assert.deepEqual(spawned.argv.slice(3, 8), ["--extension", "--browser", "msedge", "--profile-dir-name", "Profile 4"])
  assert.deepEqual(spawned.argv.slice(1, 3), ["--output-dir", path.join(machine.state, "output")])
  assert.equal(spawned.argv.includes("--headless"), false)
  assert.equal(spawned.argv[8], "--executable-path")
  assert.equal(spawned.argv[9], path.join(machine.root, "desk-browser-launch"))
  assert.equal(spawned.argv[10], "--init-page")
  assert.equal(spawned.argv[11], path.join(mcpRoot, "scripts", "real-profile-page.cjs"))
  assert.equal(spawned.env.DESK_BROWSER_EXECUTABLE, EDGE)
  assert.match(spawned.env.DESK_BROWSER_OWNER, /^Desk /u)
  assert.match(spawned.env.DESK_BROWSER_OWNER, /test-host/u)
  assert.equal(spawned.child.clientInfo.name, spawned.env.DESK_BROWSER_OWNER)
  assert.equal(spawned.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, TOKEN)
  assert.deepEqual(spawned.stdio, ["pipe", "pipe", "pipe"])
  assert.equal(JSON.stringify([spawned.file, spawned.argv]).includes(TOKEN), false)
  assert.equal(host.stderr.join("").includes(TOKEN), false)
  assert.match(host.stderr.join(""), /driving the Microsoft Edge profile Profile 4 through the Playwright Extension/u)
  assert.equal(JSON.stringify(host.messages).includes(TOKEN), false)
  assert.deepEqual(readdirSync(path.join(machine.root, "tmp")), [])
})

test("a native launch refusal is returned without exposing receipt data or replaying the operation", posixOnly, async () => {
  const machine = await realMachine({ launch: { nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: {},
    before: () => null, read: () => ({ status: "refused", code: "browser_spawn_failed" }), dispose: () => {},
  }) } })
  const host = session(machine)
  try {
    await host.handshake()
    const response = await host.call(2)
    assert.equal(response.result.isError, true)
    assert.equal(JSON.parse(textOf(response)).code, "browser_window_unavailable")
    assert.equal(machine.events.filter(e => e === "child:tools/call browser_navigate").length, 1)
  } finally {
    await host.close()
  }
})

test("a missing or invalid native receipt preserves the actual result and forbids replay", posixOnly, async () => {
  for (const read of [() => null, () => { throw new Error("browser_native_launch_receipt_invalid") }]) {
    const machine = await realMachine({ launch: { nativeLaunch: settings => ({
      file: "/fixture/native-launch", owner: settings.owner, env: {},
      before: () => null, read, dispose: () => {},
    }) } })
    const host = session(machine)
    try {
      await host.handshake()
      const response = await host.call(2)
      assert.equal(response.result.isError, true)
      assert.equal(response.result.content[0].text, "ran browser_navigate")
      const payload = JSON.parse(response.result.content[1].text)
      assert.equal(payload.code, "browser_native_launch_unverified")
      assert.match(payload.fix, /Do not replay/u)
      assert.equal(machine.events.filter(e => e === "child:tools/call browser_navigate").length, 1)
    } finally {
      await host.close()
    }
  }
})

test("native asset preparation failure refuses before creating an extension client", posixOnly, async () => {
  const machine = await realMachine({ launch: { nativeLaunch: () => { throw new Error("browser_native_launch_integrity") } } })
  const host = session(machine)
  try {
    await host.handshake()
    const response = await host.call(2)
    assert.equal(response.result.isError, true)
    assert.equal(JSON.parse(textOf(response)).code, "browser_native_launch_unavailable")
    assert.equal(machine.stub.spawns.length, 0)
  } finally {
    await host.close()
  }
})

test("a real-profile child waits for the host's identity even when preparation completes first", posixOnly, async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.wait(() => host.stderr.join("").includes("driving the Microsoft Edge"), "profile preparation")
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(machine.stub.spawns.length, 0)
  await host.handshake()
  await host.call(2)
  assert.match(machine.stub.spawns[0].child.clientInfo.name, /test-host/u)
  await host.close()
})

test("a host without client metadata still gets a distinct declared agent label", posixOnly, async () => {
  const machine = await realMachine()
  machine.launchOptions.env.DESK_AGENT_NAME = "fixture agent"
  const host = session(machine)
  await host.ask(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })
  await host.call(2)
  assert.match(machine.stub.spawns[0].child.clientInfo.name, /fixture agent/u)
  await host.close()
})

test("generic proxy hooks can be cancelled or stopped without an afterCall callback", posixOnly, async () => {
  const { serve } = require(path.join(mcpRoot, "web-proxy.cjs"))
  for (const stopping of [false, true]) {
    let complete
    const machine = await realMachine()
    const host = session(machine, { run: o => serve({
      stdin: o.stdin, stdout: o.stdout, stderr: o.stderr,
      spawn: o.spawn, signals: o.signals, kill: o.kill, exit: o.exit,
      catalog: [], catalogVersion: "fixture",
      ready: Promise.resolve({ launch: { node: process.execPath, indexFile: "fixture", args: [], env: {} } }),
      beforeCall: () => new Promise(resolve => { complete = resolve }),
      abort() {}, retry: () => Promise.resolve({ payload: { code: "fixture" } }),
      timeoutPayload: { code: "fixture" }, spawnPayload: () => ({ code: "fixture" }), exitPayload: () => ({ code: "fixture" }),
    }) })
    await host.handshake()
    host.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
    await host.wait(() => complete, "the generic asynchronous hook")
    if (stopping) await host.close()
    else host.send({ method: "notifications/cancelled", params: { requestId: 2 } })
    complete(null)
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(machine.events.some(event => event === "child:tools/call browser_navigate"), false)
    if (!stopping) await host.close()
  }
})

test("unknown cancellation IDs cannot mutate inherited objects or cancel future operations", posixOnly, async () => {
  let launched = false
  const machine = await realMachine({ launch: { nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: {},
    before: () => { launched = true; return null },
    read: () => launched ? { status: "spawned", pid: 42 } : null,
    dispose: () => {},
  }) } })
  const host = session(machine)
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, "cancelled")
  try {
    await host.handshake()
    await host.wait(() => machine.stub.spawns.length === 1, "the prepared child")
    host.send({ method: "notifications/cancelled", params: { requestId: "__proto__" } })
    assert.deepEqual(Object.getOwnPropertyDescriptor(Object.prototype, "cancelled"), previous)
    assert.equal((await host.call(2)).result.isError, undefined)
  } finally {
    if (previous) Object.defineProperty(Object.prototype, "cancelled", previous)
    else delete Object.prototype.cancelled
    await host.close()
  }
})

test("closing a prepared real-profile connection without host initialize opens no browser", posixOnly, async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.wait(() => host.stderr.join("").includes("driving the Microsoft Edge"), "profile preparation")
  await new Promise(resolve => setTimeout(resolve, 20))
  await host.close()
  assert.equal(machine.stub.spawns.length, 0)
  assert.equal(machine.opens.length, 0)
})

test("an empty browser result with no receipt is retained as an unverified outcome", posixOnly, async () => {
  const machine = await realMachine({ mode: "emptyresult", launch: { nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: {},
    before: () => null, read: () => null, dispose: () => {},
  }) } })
  const host = session(machine)
  await host.handshake()
  const response = await host.call(2)
  assert.equal(response.result.isError, true)
  assert.equal(JSON.parse(textOf(response)).code, "browser_native_launch_unverified")
  await host.close()
})

test("simultaneous real-profile sessions advertise distinct browser owners", posixOnly, async () => {
  const a = await realMachine()
  const b = await realMachine()
  const ha = session(a)
  const hb = session(b)
  try {
    await Promise.all([ha.handshake(), hb.handshake()])
    await Promise.all([ha.call(2), hb.call(2)])
    assert.notEqual(a.stub.spawns[0].env.DESK_BROWSER_OWNER, b.stub.spawns[0].env.DESK_BROWSER_OWNER)
    assert.match(ha.stderr.join(""), /browser owner: Desk /u)
  } finally {
    await Promise.all([ha.close(), hb.close()])
  }
})

test("a declared profile refuses competing browser paths and profiles before connecting", posixOnly, async () => {
  for (const args of [["--executable-path", "/different"], ["--profile-dir-name=Other"], ["--user-data-dir", "/different"], ["--browser=chrome"]]) {
    const machine = await realMachine()
    const host = session(machine, { args })
    try {
      await host.handshake()
      const response = await host.call(2)
      assert.equal(response.result.isError, true, "conflicting browser arguments must not reach a page tool")
      assert.equal(JSON.parse(textOf(response)).code, "browser_configuration_conflict")
      assert.equal(machine.stub.spawns.length, 0)
      assert.equal(machine.opens.length, 0)
    } finally {
      await host.close()
    }
  }
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

test("browser_close closes the agent's tabs with one list, is answered without reaching the browser, and ending afterwards does nothing more", posixOnly, async () => {
  const machine = await realMachine({ tabs: 2 })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  const answer = await host.call(3, "browser_close")
  assert.match(textOf(answer), /is closed/u)
  const expected = ["child:tools/call browser_tabs list", "child:tools/call browser_tabs close", "child:tools/call browser_tabs close"]
  assert.deepEqual(tabEvents(machine), expected)
  const child = machine.stub.spawns[0].child
  assert.equal(child.tabs, 0)
  assert.equal(child.recreated, 0, "no list after the last close, so the browser never creates a tab to list")
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.deepEqual(tabEvents(machine), [...expected, "child:stdin closed"], "no second connect page can open")
  assert.equal(child.recreated, 0)
  assert.equal(host.messages.filter((message) => message.id === 3).length, 1)
})

test("the real launcher returns an incomplete cleanup error rather than a false closed-window receipt", posixOnly, async () => {
  const machine = await realMachine({ mode: "errortabs" })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  const answer = await host.call(3, "browser_close")
  assert.equal(answer.result.isError, true)
  assert.equal(JSON.parse(textOf(answer)).code, "browser_cleanup_incomplete")
  assert.equal(machine.opens.length, 1)
  assert.equal(textOf(await host.call(4)), "ran browser_navigate")
  assert.equal(machine.opens.length, 1, "the failed close retains ownership of the original connection")
  await host.close()
})

test("a browser call after browser_close opens a new window and connects again, and its tabs are closed at the end", posixOnly, async () => {
  const machine = await realMachine({ tabs: 1 })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  await host.call(3, "browser_close")
  assert.equal(machine.opens.length, 1)
  assert.equal(textOf(await host.call(4)), "ran browser_navigate")
  assert.equal(machine.opens.length, 2)
  host.stdin.end()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.equal(machine.events.filter((event) => event === "child:tools/call browser_navigate").length, 2)
  assert.equal(machine.events.filter((event) => event === "child:tools/call browser_close").length, 0)
  assert.equal(machine.stub.spawns[0].child.tabs, 0)
})

test("browser_close in a session that never used the browser opens and closes nothing", posixOnly, async () => {
  const machine = await realMachine()
  const host = session(machine)
  await host.handshake()
  assert.match(textOf(await host.call(2, "browser_close")), /is closed/u)
  assert.equal(machine.opens.length, 0)
  assert.equal(machine.events.some((event) => event.startsWith("child:tools/call")), false)
  await host.close()
})

test("a first call that fails leaves nothing for the cleanup to connect to", posixOnly, async () => {
  const machine = await realMachine({ mode: "failcall" })
  const host = session(machine)
  await host.handshake()
  const answer = await host.call(2)
  assert.equal(answer.result.isError, true)
  host.stdin.end()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.deepEqual(tabEvents(machine), ["child:stdin closed"])
})

test("a protocol error after native launch still cleans up that owned connection", posixOnly, async () => {
  const machine = await realMachine({ mode: "rpcerror" })
  const host = session(machine)
  await host.handshake()
  const result = await host.call(2)
  assert.equal(result.error.code, -32603)
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.equal(tabEvents(machine).includes("child:tools/call browser_tabs list"), true)
})

test("a protocol error with an invalid launch receipt retains uncertainty and cleanup ownership", posixOnly, async () => {
  const machine = await realMachine({ mode: "rpcerror", launch: { nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: {},
    before: () => null, read: () => { throw new Error("browser_native_launch_receipt_invalid") }, dispose: () => {},
  }) } })
  const host = session(machine)
  await host.handshake()
  const result = await host.call(2)
  assert.equal(result.error.code, -32603)
  assert.match(host.stderr.join(""), /ownership remains uncertain/u)
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.equal(tabEvents(machine).includes("child:tools/call browser_tabs list"), true)
})

test("the actual proxy waits for a first in-flight response before confirming cleanup or permitting a new attempt", posixOnly, async () => {
  const machine = await realMachine({ mode: "heldfirst" })
  const host = session(machine)
  await host.handshake()
  const first = host.call(2)
  await host.wait(() => machine.stub.spawns[0]?.child.completeFirst, "the first dispatched operation")
  let closed = false
  const closing = host.call(3, "browser_close").then(result => { closed = true; return result })
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(closed, false)
  assert.equal(tabEvents(machine).length, 0)
  assert.equal(machine.opens.length, 1)
  machine.stub.spawns[0].child.completeFirst()
  await first
  assert.equal((await closing).result.isError, undefined)
  await host.call(4)
  assert.equal(machine.opens.length, 2)
  await host.close()
})

test("a cancelled preparation is never dispatched after its asynchronous hook resolves", posixOnly, async () => {
  let complete
  const machine = await realMachine({ launch: { nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: {},
    before: () => new Promise(resolve => { complete = resolve }),
    read: () => null, dispose: () => {},
  }) } })
  const host = session(machine)
  await host.handshake()
  host.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await host.wait(() => complete, "the asynchronous preparation hook")
  host.send({ method: "notifications/cancelled", params: { requestId: 2 } })
  complete()
  const closing = await host.call(3, "browser_close")
  assert.equal(closing.result.isError, undefined)
  assert.equal(machine.events.some(event => event === "child:tools/call browser_navigate"), false)
  assert.equal(host.messages.some(message => message.id === 2), false)
  await host.close()
})

test("session end cancels a still-preparing operation instead of launching it after shutdown", posixOnly, async () => {
  let complete
  const machine = await realMachine({ launch: { nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: {},
    before: () => new Promise(resolve => { complete = resolve }),
    read: () => null, dispose: () => {},
  }) } })
  const host = session(machine)
  await host.handshake()
  host.send({ id: 2, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  await host.wait(() => complete, "the asynchronous preparation hook")
  await host.close()
  assert.equal(host.stderr.join("").includes("browser_cleanup_incomplete"), false, "a never-dispatched cancelled preparation owns no browser window")
  complete()
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(machine.events.some(event => event === "child:tools/call browser_navigate"), false)
})

test("a verified unused native attempt is disposed before the launcher exits", posixOnly, async () => {
  const events = []
  const machine = await realMachine({ events, launch: { nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: {},
    before: () => null, read: () => null, dispose: () => events.push("native:disposed"),
  }) } })
  const host = session(machine, { exit: code => events.push(`exit:${code}`) })
  await host.handshake()
  await host.close()
  assert.equal(events.includes("native:disposed"), true)
  assert.ok(events.indexOf("native:disposed") < events.indexOf("exit:0"), "process.exit must not run before owned attempt disposal")
})

test("the proxy cancels work queued behind cleanup without poisoning a later browser_close", posixOnly, async () => {
  const machine = await realMachine({ mode: "holdcleanup" })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  const firstClose = host.call(3, "browser_close")
  await host.wait(() => machine.stub.spawns[0].child.completeCleanup, "the paused cleanup list")
  host.send({ id: 4, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  host.send({ method: "notifications/cancelled", params: { requestId: 4 } })
  machine.stub.spawns[0].child.completeCleanup()
  await firstClose
  assert.equal((await host.call(5, "browser_close")).result.isError, undefined)
  assert.equal(machine.opens.length, 1)
  await host.close()
})

test("shutdown cancels work queued behind cleanup without restarting preparation", posixOnly, async () => {
  const machine = await realMachine({ mode: "holdcleanup" })
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  host.send({ id: 3, method: "tools/call", params: { name: "browser_close", arguments: {} } })
  await host.wait(() => machine.stub.spawns[0].child.completeCleanup, "the paused cleanup list")
  host.send({ id: 4, method: "tools/call", params: { name: "browser_navigate", arguments: {} } })
  const ended = new Promise(resolve => host.stdin.once("end", resolve))
  const closing = host.close()
  await ended
  machine.stub.spawns[0].child.completeCleanup()
  await closing
  assert.equal(machine.opens.length, 1)
  assert.equal(host.stderr.join("").includes("browser_cleanup_incomplete"), false)
})

test("completed cleanup still resets ownership when its response was cancelled", posixOnly, async () => {
  const options = { mode: "holdcleanup" }
  const machine = await realMachine(options)
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  host.send({ id: 3, method: "tools/call", params: { name: "browser_close", arguments: {} } })
  await host.wait(() => machine.stub.spawns[0].child.completeCleanup, "the paused cleanup list")
  host.send({ method: "notifications/cancelled", params: { requestId: 3 } })
  machine.stub.spawns[0].child.completeCleanup()
  await new Promise(resolve => setTimeout(resolve, 5))
  options.mode = "failcall"
  assert.equal((await host.call(4)).result.isError, true)
  await host.call(5, "browser_close")
  assert.equal(machine.stub.spawns[0].child.recreated, 0, "a failed fresh operation cannot retain the already-closed old owner")
  await host.close()
})

test("native attempt disposal failure is reported once without stalling session shutdown", posixOnly, async () => {
  let disposals = 0
  const machine = await realMachine({ launch: { cleanupMs: 20, nativeLaunch: settings => ({
    file: "/fixture/native-launch", owner: settings.owner, env: { DESK_BROWSER_RECEIPT: "/fixture/owned-attempt" },
    before: () => null, read: () => null, dispose: () => { disposals += 1; throw new Error("EACCES") },
  }) } })
  const host = session(machine)
  await host.handshake()
  host.stdin.end()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.match(host.stderr.join(""), /browser_launch_attempt_cleanup_incomplete/u)
  assert.equal(disposals, 1)
  await host.running
})

test("a failed operation after confirmed cleanup cannot reopen a connection during shutdown", posixOnly, async () => {
  const options = {}
  const machine = await realMachine(options)
  const host = session(machine)
  await host.handshake()
  await host.call(2)
  await host.call(3, "browser_close")
  options.mode = "failcall"
  assert.equal((await host.call(4)).result.isError, true)
  const before = tabEvents(machine)
  await host.close()
  await host.wait(() => host.exits.length === 1, "the launcher to end")
  assert.deepEqual(tabEvents(machine), [...before, "child:stdin closed"])
  assert.equal(machine.stub.spawns[0].child.recreated, 0)
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
    assert.match(host.stderr.join(""), /browser_cleanup_incomplete/u, "shutdown must surface unverified cleanup")
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

/** A fake npm for installs: `install` writes Playwright MCP, and the reader too unless `readerFails`; with `allFail` nothing installs. */
function installNpm(calls, options = {}) {
  return (file, argv) => {
    calls.push(argv.slice(1))
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setImmediate(() => {
      if (argv[1] !== "install") return child.emit("close", 0)
      const withReader = argv.includes("classic-level@1.4.1")
      if (options.allFail || (withReader && options.readerFails)) {
        child.stderr.write("npm error code E404\nnpm error no prebuilt binary\n")
        return child.emit("close", 1)
      }
      const prefix = argv[argv.indexOf("--prefix") + 1]
      touch(path.join(prefix, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ version: "0.0.82", bin: { "playwright-mcp": "cli.js" } }))
      touch(path.join(prefix, "node_modules", "@playwright", "mcp", "cli.js"), "")
      if (withReader) touch(path.join(prefix, "node_modules", "classic-level", "package.json"), "{}")
      child.emit("close", 0)
    })
    return child
  }
}

test("a declaration installs the token reader in the same npm call as Playwright MCP, replacing an install without it", posixOnly, async () => {
  const machine = await realMachine({ reader: false })
  const calls = []
  const host = session(machine, { npmSpawn: installNpm(calls) })
  await host.handshake()
  assert.equal(textOf(await host.call(2)), "ran browser_navigate")
  await host.close()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(-2), ["@playwright/mcp@latest", "classic-level@1.4.1"])
  assert.match(machine.stub.spawns[0].argv[0], /installs\/.*\/node_modules\/@playwright\/mcp\/cli\.js$/u)
  assert.equal(JSON.stringify(calls).includes(TOKEN), false)
})

test("a reader that cannot be installed leaves the browser installed, marked, and the real-profile mode answers that the token cannot be read", posixOnly, async () => {
  const machine = await realMachine({ reader: false, launch: { requireModule: undefined } })
  const calls = []
  const host = session(machine, { npmSpawn: installNpm(calls, { readerFails: true }) })
  await host.handshake()
  const payload = JSON.parse(textOf(await host.call(2)))
  assert.equal(payload.code, "browser_token_unreadable")
  assert.deepEqual(calls.map((call) => call.slice(-2).join(" ")), ["@playwright/mcp@latest classic-level@1.4.1", "--no-package-lock @playwright/mcp@latest"])
  assert.equal(machine.opens.length, 0, "no window opens for a connection that cannot be made")
  const installed = browser.readInstalled(machine.state)
  assert.equal(installed.reader, true, "the marked install counts as having been tried")
  assert.equal(existsSync(path.join(installed.dir, "reader-unavailable")), true)
  await host.close()
  const again = session(machine, { npmSpawn: installNpm(calls, { allFail: true }) })
  await again.handshake()
  assert.equal(JSON.parse(textOf(await again.call(2))).code, "browser_token_unreadable")
  assert.equal(calls.length, 2, "a later launch does not install again")
  await again.close()
})

/** A machine whose install has the reader marked unavailable, `ageMs` ago. */
async function markedMachine(ageMs) {
  const machine = await realMachine({ reader: false, launch: { requireModule: undefined } })
  const marker = path.join(machine.state, "installs", "1-1-a", "reader-unavailable")
  touch(marker)
  const then = new Date(Date.now() - ageMs)
  utimesSync(marker, then, then)
  return machine
}

const DAY = 24 * 60 * 60 * 1000

test("a marker younger than a day is not retried", posixOnly, async () => {
  const machine = await markedMachine(DAY - 60 * 60 * 1000)
  const calls = []
  const host = session(machine, { npmSpawn: installNpm(calls) })
  await host.handshake()
  assert.equal(JSON.parse(textOf(await host.call(2))).code, "browser_token_unreadable")
  assert.deepEqual(calls, [])
  await host.close()
})

test("a marker older than a day is retried once, and the reader installs when npm works now", posixOnly, async () => {
  const machine = await markedMachine(DAY + 60 * 1000)
  const calls = []
  const host = session(machine, { npmSpawn: installNpm(calls), requireModule: () => levelStub([[tokenKey(), latin(TOKEN)]]) })
  await host.handshake()
  assert.equal(textOf(await host.call(2)), "ran browser_navigate")
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(-2), ["@playwright/mcp@latest", "classic-level@1.4.1"])
  const installed = browser.readInstalled(machine.state)
  assert.equal(existsSync(path.join(installed.dir, "node_modules", "classic-level", "package.json")), true)
  assert.equal(installed.unavailableAt, undefined)
  await host.close()
})

test("a retry that fails again writes a fresh marker, and a retry that cannot install anything keeps the working install", posixOnly, async () => {
  const machine = await markedMachine(2 * DAY)
  const calls = []
  const host = session(machine, { npmSpawn: installNpm(calls, { readerFails: true }) })
  await host.handshake()
  assert.equal(JSON.parse(textOf(await host.call(2))).code, "browser_token_unreadable")
  assert.equal(calls.length, 2)
  const installed = browser.readInstalled(machine.state)
  assert.notEqual(installed.dir, path.join(machine.state, "installs", "1-1-a"))
  assert.ok(Date.now() - statSync(path.join(installed.dir, "reader-unavailable")).mtimeMs < DAY, "the marker was rewritten")
  await host.close()

  const down = await markedMachine(2 * DAY)
  const downCalls = []
  const offline = session(down, { npmSpawn: installNpm(downCalls, { allFail: true }) })
  await offline.handshake()
  assert.equal(JSON.parse(textOf(await offline.call(2))).code, "browser_token_unreadable", "the old install still starts")
  assert.equal(downCalls.length, 2)
  assert.equal(browser.readInstalled(down.state).dir, path.join(down.state, "installs", "1-1-a"))
  await offline.close()
})

test("a stale marker does not make a launch wait for another session's install", posixOnly, async () => {
  const machine = await markedMachine(2 * DAY)
  touch(path.join(machine.state, "refresh.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }))
  const calls = []
  const host = session(machine, { npmSpawn: installNpm(calls) })
  await host.handshake()
  assert.equal(JSON.parse(textOf(await host.call(2))).code, "browser_token_unreadable")
  assert.deepEqual(calls, [])
  assert.match(host.stderr.join(""), /another Desk session is installing; keeping the install without the connection reader/u)
  await host.close()
})

test("when the reader cannot be installed the existing install is kept and npm's reason goes to stderr without credentials", posixOnly, async () => {
  const machine = await realMachine({ reader: false })
  const npmSpawn = installNpm([], { allFail: true })
  const noisy = (file, argv) => {
    const child = npmSpawn(file, argv)
    child.stderr.write("npm error code E401 auth failed for https://me:hunter2@registry.example/ _authToken=abc123 Authorization: Bearer bearer111 and Basic basic222 leaked npm_abcdefghijklmnopqrstuvwxyz0123 here GET https://registry.example/x?token=query333&ok=1 and ?password=query444 end https://u:p@ss/word@registry.example/pkg\n")
    return child
  }
  const host = session(machine, { npmSpawn: noisy })
  await host.handshake()
  assert.equal(textOf(await host.call(2)), "ran browser_navigate", "the stubbed reader stands in; only the kept install is under test")
  await host.close()
  const err = host.stderr.join("")
  assert.match(err, /could not install the connection reader \(.*\); keeping the install without it/u)
  assert.equal(/hunter2|abc123|me:|bearer111|basic222|npm_abcdef|query333|query444|p@ss|ss\/word/u.test(err), false)
  assert.match(err, /ok=1/u)
  assert.match(err, /<redacted>/u)
})

test("a refresh keeps the token reader on an install that has one, and leaves it off otherwise", posixOnly, async () => {
  for (const reader of [true, false]) {
    const machine = await realMachine({ reader })
    const calls = []
    const result = await browser.refresh({ env: machine.launchOptions.env, platform: "linux", homeDir: machine.launchOptions.homeDir, node: machine.launchOptions.current.path, npmCli: path.join(machine.root, "node", "lib", "node_modules", "npm", "bin", "npm-cli.js"), spawn: (file, argv) => {
      if (argv[1] === "view") {
        const child = new EventEmitter()
        child.stdout = new PassThrough()
        child.stderr = new PassThrough()
        setImmediate(() => { child.stdout.write("0.0.99\n"); child.emit("close", 0) })
        return child
      }
      return installNpm(calls)(file, argv)
    } })
    assert.equal(result.changed, true)
    assert.equal(calls[0].includes("classic-level@1.4.1"), reader)
  }
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
