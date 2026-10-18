// Retained non-MCP profile reader APIs plus explicit-context declaration/native
// readiness preflight. No default page-MCP/token route remains. All profile and
// OS observations are owned fixtures; no test reads a real browser profile.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import vm from "node:vm"
import os from "node:os"
import {pathToFileURL} from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { mcpRoot } from "./_mcp_handshake.js"

const require = createRequire(import.meta.url)
const { loadTemplate } = require("./fixtures/native-template-loader.cjs")
const browser = require(path.join(mcpRoot, "web.cjs"))
const real = require(path.join(mcpRoot, "web-real-profile.cjs"))
const playwrightPatch = require(path.join(mcpRoot, "web-playwright-patch.cjs"))
const errorFixture = require("./fixtures/playwright-native-error-transport.cjs").read()
const stockLifecycle = readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8") + errorFixture.core
const TOKEN = "tok-9f3a-never-print-me"
const posixOnly = { skip: process.platform === "win32" ? "the fixture Node is a POSIX link" : false }

test("unbound launches clear an inherited private profile binding", posixOnly, async () => {
  const machine = await realMachine({ declare: null })
  machine.launchOptions.env.DESK_BROWSER_PROFILE_DIR = path.join(machine.root, "foreign")
  const result = await direct(machine)
  assert.equal(result.exitCode,1)
  assert.equal(result.payload.code,"browser_declaration_unavailable")
  assert.equal(existsSync(path.join(machine.state,"signed-in")),false)
})

test("profile token reads reject missing or malformed extension identities before touching the profile", async () => {
  for (const options of [
    { extensionId: "foreign" }, { extensionId: 42 }, { tokenKey: "" }, { tokenKey: "0invalid" }, { tokenKey: 42 },
  ]) {
    await assert.rejects(real.readExtensionToken("/unused/profile", options), /browser_token_identity_invalid/u)
  }
})

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

let builtinSqlite = null
try { builtinSqlite = require("node:sqlite") } catch { /* this Node has none */ }
const withSqlite = { skip: builtinSqlite ? false : "this Node has no built-in SQLite" }

/** Chromium's newer local storage: one SQLite file, `LocalStorage`, with a map per storage key. */
function sqliteStorage(profileDir, rows) {
  mkdirSync(profileDir, { recursive: true })
  const db = new builtinSqlite.DatabaseSync(path.join(profileDir, "LocalStorage"))
  db.exec("CREATE TABLE maps(row_id INTEGER PRIMARY KEY AUTOINCREMENT,storage_key BLOB NOT NULL,last_accessed INTEGER,last_modified INTEGER,total_size INTEGER); CREATE TABLE map_entries(map_id INTEGER NOT NULL,value_compression_type INTEGER NOT NULL,key BLOB NOT NULL,value BLOB NOT NULL,PRIMARY KEY(map_id, key)) WITHOUT ROWID;")
  for (const [origin, key, value, compression = 0] of rows) {
    db.prepare("INSERT OR IGNORE INTO maps(storage_key) VALUES (?)").run(Buffer.from(origin, "latin1"))
    const { row_id: id } = db.prepare("SELECT row_id FROM maps WHERE storage_key = ?").get(Buffer.from(origin, "latin1"))
    db.prepare("INSERT INTO map_entries VALUES (?, ?, ?, ?)").run(id, compression, Buffer.concat([Buffer.from([1]), Buffer.from(key, "latin1")]), value)
  }
  db.close()
}

test("a profile on Chromium's SQLite local storage gives the extension's token, read from a copy that is gone afterwards", withSqlite, async () => {
  const root = await mkTempRoot("real-sqlite-")
  const tmp = path.join(root, "tmp")
  mkdirSync(tmp)
  const profile = path.join(root, "Default")
  sqliteStorage(profile, [
    ["https://example.com/", "auth-token", latin("someone-else")],
    [`chrome-extension://${real.EXTENSION_ID}/`, "other", latin("nope")],
    [`chrome-extension://${real.EXTENSION_ID}/`, "auth-token", wide(TOKEN)],
  ])
  assert.equal(await real.readExtensionToken(profile, { level: levelStub([]), tmpdir: tmp }), TOKEN)
  assert.deepEqual(readdirSync(tmp), [])
  const none = path.join(root, "None")
  sqliteStorage(none, [["https://example.com/", "auth-token", latin(TOKEN)], [`chrome-extension://${real.EXTENSION_ID}/`, "auth-token", latin(TOKEN), 1]])
  assert.equal(await real.readExtensionToken(none, { tmpdir: tmp }), null, "another origin's key, or a compressed value, is not the token")
  assert.equal(await real.readExtensionToken(profile, { tmpdir: tmp, sqlite: null }), null, "a Node without built-in SQLite reads nothing")
  const unloadable = { tmpdir: tmp, get sqlite() { throw new Error("No such built-in module: node:sqlite") } }
  assert.equal(await real.readExtensionToken(profile, unloadable), null, "a Node whose built-in SQLite cannot load reads nothing")
  leveldb(profile)
  assert.equal(await real.readExtensionToken(profile, { level: levelStub([[tokenKey(), latin("from-leveldb")]]), tmpdir: tmp }), "from-leveldb", "LevelDB is read first")
  assert.equal(await real.readExtensionToken(profile, { level: levelStub([]), tmpdir: tmp }), TOKEN, "SQLite is read when LevelDB has no token")
  assert.deepEqual(readdirSync(tmp), [])
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

async function tickStorage(t, milliseconds) {
  for (let elapsed = 0; elapsed < milliseconds; elapsed += 100) {
    t.mock.timers.tick(Math.min(100, milliseconds - elapsed))
    await new Promise(setImmediate)
  }
}

test("a persisted credential gap reports an agent-owned boundary, not operator installation work", async (t) => {
  const root = await mkTempRoot("real-connect-")
  mkdirSync(path.join(root, "tmp"))
  const base = localState(path.join(root, "home"), { Default: "me@microsoft.com" })
  const profile = path.join(base, "Default")
  leveldb(profile)
  touch(path.join(profile, "Extensions", real.EXTENSION_ID, "0.4.0", "manifest.json"),
    JSON.stringify({ name: "Playwright Extension", version: "0.4.0", manifest_version: 3 }))
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const connecting = real.connect(connectOptions(root, {
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN },
    requireModule: () => levelStub([]),
  }))
  await new Promise(setImmediate)
  await tickStorage(t, 10000)
  const answer = await connecting
  assert.deepEqual(Object.keys(answer), ["payload"])
  assert.equal(answer.payload.code, "browser_extension_missing")
  assert.match(answer.payload.summary, /no usable persisted Playwright Extension credential/u)
  assert.match(answer.payload.summary, /profile Default/u)
  assert.doesNotMatch(answer.payload.summary, /is not installed/u)
  assert.match(answer.payload.fix, /^Stop browser calls/u)
  assert.match(answer.payload.fix, /preserve the existing browser and profile/u)
  assert.match(answer.payload.fix, /Automatic extension setup is not available through this launcher/u)
  assert.match(answer.payload.fix, /agent-owned repair/u)
  assert.match(answer.payload.fix, /not an operator setup chore/u)
  assert.ok(answer.payload.fix.includes(real.INSTALL_URL))
  assert.doesNotMatch(answer.payload.fix, /then retry|install it in that profile|click its toolbar icon/u)
  assert.doesNotMatch(JSON.stringify(answer), new RegExp(TOKEN, "u"))
  assert.deepEqual(readdirSync(path.join(root, "tmp")), [])
})

for (const initial of [null, ""]) {
  test(`connecting waits for ${initial === null ? "a missing" : "an empty"} token to persist, without launching a browser`, async (t) => {
    const root = await mkTempRoot("real-connect-")
    mkdirSync(path.join(root, "tmp"))
    const base = localState(path.join(root, "home"), { Default: "me@microsoft.com" })
    leveldb(path.join(base, "Default"))
    const entries = initial === null ? [] : [[tokenKey(), latin(initial)]]
    const seen = {}
    t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
    let settled = false
    const connecting = real.connect(connectOptions(root, {
      requireModule: () => levelStub(entries, seen),
    })).then((answer) => { settled = true; return answer })
    await new Promise(setImmediate)
    await tickStorage(t, 5100)
    assert.equal(settled, false, "a cold token can take more than five seconds to reach disk")
    entries.splice(0, entries.length, [tokenKey(), latin(TOKEN)])
    await tickStorage(t, 1000)
    assert.equal(settled, true, "the next storage poll must return the persisted token")
    const answer = await connecting
    assert.deepEqual(answer.env, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN, DESK_BROWSER_PROFILE_DIR: path.resolve(base, "Default") })
    assert.equal(answer.profile, "Default")
    assert.ok(seen.iteratorClosed && seen.dbClosed)
    assert.deepEqual(readdirSync(path.join(root, "tmp")), [])
  })
}

test("connecting bounds absent-token polling to ten seconds and releases every storage copy", async (t) => {
  const root = await mkTempRoot("real-connect-")
  mkdirSync(path.join(root, "tmp"))
  const base = localState(path.join(root, "home"), { Default: "me@microsoft.com" })
  leveldb(path.join(base, "Default"))
  let reads = 0
  const reader = levelStub([])
  const level = { ClassicLevel: class extends reader.ClassicLevel {
    constructor(...args) { super(...args); reads += 1 }
  } }
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  let settled = false
  const connecting = real.connect(connectOptions(root, { requireModule: () => level }))
    .then((answer) => { settled = true; return answer })
  await new Promise(setImmediate)
  await tickStorage(t, 9900)
  assert.equal(settled, false)
  await tickStorage(t, 100)
  assert.equal(settled, true)
  assert.equal((await connecting).payload.code, "browser_extension_missing")
  assert.ok(reads > 1 && reads <= 20, "storage polling must back off instead of busy-waiting")
  assert.deepEqual(readdirSync(path.join(root, "tmp")), [])
  const finalReads = reads
  await tickStorage(t, 1000)
  assert.equal(reads, finalReads, "no polling survives the result")
})

test("a storage error during readiness polling stops immediately instead of becoming a missing-extension timeout", async (t) => {
  const root = await mkTempRoot("real-connect-")
  mkdirSync(path.join(root, "tmp"))
  const base = localState(path.join(root, "home"), { Default: "me@microsoft.com" })
  leveldb(path.join(base, "Default"))
  const options = {}
  const level = levelStub([], {}, options)
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  let answer
  const connecting = real.connect(connectOptions(root, { requireModule: () => level }))
    .then((result) => { answer = result })
  await new Promise(setImmediate)
  await tickStorage(t, 500)
  assert.equal(answer, undefined)
  options.failRead = true
  await tickStorage(t, 1000)
  assert.equal(answer?.payload.code, "browser_token_unreadable")
  assert.match(answer.payload.summary, /corrupt table/u)
  await connecting
  assert.deepEqual(readdirSync(path.join(root, "tmp")), [])
})

test("connecting names the missing profile, unavailable credential and unreadable token, each in one line with its fix", async () => {
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
  assert.match(noExtension.payload.fix, /^Stop browser calls/u)
  assert.doesNotMatch(noExtension.payload.fix, /then retry/u)
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

test("connecting passes the user-data folder and profile in the arguments and the token only in the environment without waiting", async (t) => {
  const root = await mkTempRoot("real-connect-")
  mkdirSync(path.join(root, "tmp"))
  const base = localState(path.join(root, "home"), { Default: "me@microsoft.com" }, "Default", "chrome")
  leveldb(path.join(base, "Default"))
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 })
  const answer = await real.connect(connectOptions(root, {
    declaration: { state: "declared", channel: "chrome", domain: "microsoft.com" },
    requireModule: () => levelStub([[tokenKey(), latin(TOKEN)]]),
  }))
  assert.deepEqual(answer.args, ["--extension", "--browser", "chrome", "--user-data-dir", base, "--profile-dir-name", "Default"])
  assert.deepEqual(answer.env, { PLAYWRIGHT_MCP_EXTENSION_TOKEN: TOKEN, DESK_BROWSER_PROFILE_DIR: path.resolve(base, "Default") })
  assert.equal(answer.profile, "Default")
  assert.equal(answer.app, "Google Chrome")
  assert.doesNotMatch(answer.args.join(" "), new RegExp(TOKEN, "u"))
})

test("a browser that is not installed is one clear line before anything is read", async () => {
  const root = await mkTempRoot("real-connect-")
  const answer = await real.connect(connectOptions(root, { executable: null }))
  assert.equal(answer.payload.code, "browser_not_installed")
  assert.match(answer.payload.summary, /Microsoft Edge/u)
})


// ---- the launcher in the real profile ----

const HOST_INIT = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-host", version: "1" } }
const EDGE = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
const REAL_TABS = path.join(mcpRoot, "web-real-tabs.cjs")

/** A child process stand-in that answers the proxy's handshake and tool calls, for launches the proxy starts. */
function childStub(spawns) {
  return (file, argv, options) => {
    const child = new EventEmitter()
    child.pid = 90000 + spawns.length
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = (signal) => setImmediate(() => child.emit("exit", null, signal))
    let buffered = ""
    child.stdin.setEncoding("utf8")
    child.stdin.on("data", (chunk) => {
      buffered += chunk
      let newline
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, newline))
        buffered = buffered.slice(newline + 1)
        const reply = (result) => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`)
        if (message.method === "initialize") reply({ protocolVersion: message.params.protocolVersion, capabilities: {}, serverInfo: { name: "Playwright", version: "stub" } })
        else if (message.method === "tools/list") reply({ tools: [] })
        else if (message.method === "tools/call") reply({ content: [{ type: "text", text: `ran ${message.params.name}` }] })
      }
    })
    child.stdin.on("end", () => setImmediate(() => child.emit("exit", 0, null)))
    spawns.push({ file, argv, env: options.env, stdio: options.stdio, child })
    return child
  }
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
  touch(path.join(modules, "@playwright", "mcp", "package.json"), JSON.stringify({ name: "@playwright/mcp", version: "0.0.83", bin: { "playwright-mcp": "cli.js" } }))
  touch(path.join(modules, "@playwright", "mcp", "cli.js"), "")
  touch(path.join(modules, "playwright-core", "lib", "coreBundle.js"), stockLifecycle)
  touch(path.join(modules, "playwright-core", "lib", "tools/cli-client/session.js"), errorFixture.sessionSource)
  playwrightPatch.apply({ dir: path.join(state, id), version: "0.0.83", core: null })
  if (options.reader !== false) {
    touch(path.join(modules, "classic-level", "package.json"), JSON.stringify({ name: "classic-level" }))
    touch(path.join(modules, "ws", "package.json"), '{"version":"8.21.3"}')
  }
  touch(path.join(state, "current.json"), JSON.stringify({ version: "0.0.83", dir: id, previous: null }))
  const accounts = options.accounts ?? { Default: "me@gmail.com", "Profile 4": "me@microsoft.com" }
  const base = localState(home, accounts)
  leveldb(path.join(base, "Profile 4"))
  mkdirSync(path.join(root, "tmp"))
  const declared = options.declare === undefined ? DECLARES : options.declare
  const dirs = declared === null ? [] : [pluginDir(root, "ms-desk", declared)]
  const levelEntries = { entries: options.entries ?? [[tokenKey(), latin(TOKEN)]] }
  const spawns = []
  const launchOptions = {
    env: { PATH: "/usr/bin", HOME:home, DESK_BROWSER_STATE_DIR: state,
      DESK_PLUGIN_ROOT:dirs[0]||path.join(root,"no-declaration","desk") },
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
    spawn: childStub(spawns),
    ...options.launch,
  }
  return { root,home, state, base, spawns, launchOptions, levelEntries }
}

// Actual controller with only normal account/executable observations scoped to
// owned fixtures. It never substitutes a native client or grants readiness.
function canonicalCjs(file,context) {
  return loadTemplate(path.join(mcpRoot,file),context)
}
function nativeController(machine,resources={}) {
  const module={exports:{}},actualFs=require("fs"),observed=Object.create(actualFs)
  const executable=touch(path.join(machine.root,"observed-edge"),"Owned inert executable observation")
  observed.statSync=(file,...args)=>{
    if(resources.files?.has(String(file)))return actualFs.statSync(resources.files.get(String(file)),...args)
    if(String(file)===EDGE){
      if(machine.launchOptions.exists(EDGE))return{isFile:()=>true}
      throw Object.assign(Error("Owned browser unavailable"),{code:"ENOENT"})
    }
    return actualFs.statSync(file,...args)
  }
  observed.realpathSync=(file,...args)=>resources.files?.has(String(file))?actualFs.realpathSync(resources.files.get(String(file)),...args):
    String(file)===EDGE?executable:actualFs.realpathSync(file,...args)
  const context={module,__dirname:mcpRoot,process:{...process,platform:resources.platform||"darwin"},Buffer,
    require:name=>name==="./browser-context-common.cjs"&&resources.common?resources.common:
      name==="./web-native-messaging.cjs"&&resources.native?resources.native:
      name==="fs"?observed:name==="os"?{...os,userInfo:()=>({...os.userInfo(),homedir:machine.home})}:
      require(name.startsWith(".")?path.join(mcpRoot,name):name),
    Function:function(...args){
      if(args.length===2&&args[0]==="url"&&args[1]==="return import(url)")return resources.importModule||((url)=>import(url))
      return Function(...args)
    },
  }
  return canonicalCjs("browser-context.cjs",context)
}
function controllerOptions(machine,extra={}) {
  return {...machine.launchOptions,...extra,prepareBrowserRuntime:()=>browser.prepareBrowserRuntime({...machine.launchOptions,...extra})}
}
async function direct(machine, input={action:"create",label:"Existing profile qualification"}) {
  return nativeController(machine).context(input,controllerOptions(machine))
}

for(const invalidSid of [false,true])test("Windows controller wiring consumes actual ACL readback verification and normal redirected roots"+(invalidSid?" (invalid SID refuses)":" (resource model only)"),posixOnly,async()=>{
  const fs=require("fs"),m=await realMachine({declare:{browser:{channel:"msedge",profileAccountDomain:"example.test"}}})
  const env={...m.launchOptions.env,LOCALAPPDATA:"Z:\\Policy Redirected",ProgramFiles:"Q:\\Programs"}
  const executable=touch(path.join(m.root,"normal-browser"),"Inert owned executable observation")
  const profile=path.join(m.root,"normal-profile")
  touch(path.join(profile,"Local State"),JSON.stringify({profile:{info_cache:{"Profile 17":{user_name:"owner@example.test"}}}}))
  const discovery=require(path.join(mcpRoot,"web-browser-discovery.cjs"))
  const candidate=discovery.browserPaths("msedge","win32",env).find(file=>file.startsWith("Z:"))
  assert.ok(candidate,"actual pure selector exposes the redirected per-user executable")
  const files=new Map([[candidate,executable],[real.userDataDir("msedge","win32",env,m.home),profile]])
  const verified=await(await import(pathToFileURL(path.join(mcpRoot,"native-messaging-install.mjs")).href)).verifyNativeDistribution(path.dirname(mcpRoot))
  const ready=path.join(m.state,"native-owned/state/native-provider-"+
    require("crypto").createHash("sha256").update(executable+"\0"+path.join(profile,"Profile 17")).digest("hex")+".json")
  touch(ready,JSON.stringify({profileRoot:path.join(profile,"Profile 17"),extensionId:verified.extensionId,
    sourceDigest:verified.extensionSourceDigest,browser:{executable}}))
  fs.chmodSync(path.dirname(ready),0o700);fs.chmodSync(ready,0o600)
  const systemRoot=path.join(m.root,"owned-system"),provider=touch(path.join(systemRoot,"System32/WindowsPowerShell/v1.0/powershell.exe"),"Never executed")
  env.SystemRoot=systemRoot
  const acl=await import(pathToFileURL(path.join(mcpRoot,"src/factory/windows-acl.js")).href),batches=[]
  const resources={platform:"win32",files,
    importModule:async url=>{
      const actual=await import(url)
      if(!url.endsWith("/windows-acl.js"))return actual
      return{...actual,protectWindowsPaths:(paths,options)=>acl.protectWindowsPaths(paths,{...options,env:{SystemRoot:systemRoot},
        runner:async request=>{
          assert.equal(request.executable,provider)
          const paths=JSON.parse(request.payload).paths;batches.push(paths)
          return{code:0,stdout:JSON.stringify({status:"ok",results:paths.map(entry=>({...entry,protected:true,rule_count:1,
            owner_sid:invalidSid?"not-a-sid":"S-1-5-21-123",owner_reassigned:false}))}),stderr:""}
        }})}
    }}
  const nativeModule={exports:{}}
  vm.runInNewContext(readFileSync(path.join(mcpRoot,"web-native-messaging.cjs"),"utf8"),{module:nativeModule,__dirname:mcpRoot,Buffer,
    process:{...process,platform:"win32",env:{SystemRoot:systemRoot}},
    require:name=>name==="./web-native-private-path.cjs"?{verify:(entries,root)=>{
      assert.equal(root,systemRoot)
      for(const entry of entries){
        assert.ok(existsSync(entry.file),"readonly ACL verification only observes owned paths")
        assert.equal(fs.lstatSync(entry.file).isDirectory(),entry.directory)
      }
      return"private"
    }}:require(name.startsWith(".")?path.join(mcpRoot,name):name)})
  resources.native=nativeModule.exports
  resources.common=canonicalCjs("browser-context-common.cjs",{module:{exports:{}},__dirname:mcpRoot,process:{...process,platform:"win32"},
    Buffer,require:name=>require(name.startsWith(".")?path.join(mcpRoot,name):name)})
  const controller=nativeController(m,resources),socketRoot=path.join(m.root,"sockets")
  fs.mkdirSync(socketRoot,{mode:0o700})
  let executions=0
  const options=controllerOptions(m,{env,socketRoot,execute:async(_node,args,options)=>{
    executions++
    const request=JSON.parse(args[1]),config=JSON.parse(readFileSync(path.join(request.root,"config/browser.json")))
    assert.equal(request.selection.browserExecutable,executable)
    assert.equal(request.selection.userDataDir,profile)
    assert.equal(Object.keys(config.deskNativeContext).length,9)
    assert.equal(options.env.LOCALAPPDATA,path.join(request.root,"home/AppData/Local"))
    assert.equal(options.env.APPDATA,path.join(request.root,"home/AppData/Roaming"))
    assert.equal(options.env.ProgramFiles,undefined)
    assert.equal(options.env.SystemRoot,systemRoot)
    return{state:"running"}
  }})
  const result=await controller.context({action:"create",label:"Redirected Windows owner"},options)
  if(invalidSid){
    assert.equal(result.exitCode,1)
    assert.match(result.payload.message,/usable owner SID/)
    assert.equal(executions,0)
  }else{
    assert.equal(result.exitCode,0,JSON.stringify(result))
    const paths=batches.flat().map(entry=>entry.path)
    assert.ok(paths.some(file=>file.endsWith("home/AppData/Local")))
    assert.ok(paths.includes(path.join(result.payload.contextResources.contextDirectory,"config/browser.json")))
    const count=batches.length
    assert.equal((await controller.context({action:"keep",contextId:result.payload.contextId},options)).exitCode,0)
    assert.equal(batches.length,count,"existing contexts are verified, not re-protected")
    assert.equal(executions,2)
  }
})

/** Run the launcher against a host over streams, for the answers it serves itself. */
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
  const controller=nativeController(machine),options=controllerOptions(machine,extra)
  const running=import(pathToFileURL(path.join(mcpRoot,"src/browser/context-mcp.js")).href).then(frontend=>
    frontend.startContextMcpServer({tools:require(path.join(mcpRoot,"web-catalog.json")).tools,
      controller:{context:input=>controller.context(input,options),command:input=>controller.command(input,options)},stdin,stdout}))
  const wait = async (check, what) => {
    for (let i = 0; i < 3000; i += 1) {
      const found = check()
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    throw new Error(`timed out waiting for ${what}`)
  }
  const api = {
    stderr, exits, messages, raw,
    send: (message) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`),
    reply: (id) => wait(() => messages.find((message) => message.id === id), `the answer to ${id}`),
    async ask(id, method, params) {
      api.send({ id, method, params })
      return api.reply(id)
    },
    handshake: async () => {const result=await api.ask(1,"initialize",HOST_INIT);api.send({method:"notifications/initialized"});return result},
    call: (id, name = "browser_context",args={action:"create",label:"Existing profile qualification"}) => api.ask(id, "tools/call", { name, arguments:args }),
    close: async () => { stdin.end(); const server=await running;await server.close() },
  }
  return api
}

const textOf = (message) => message.result.content[0].text

test("without a declaration default signed-in creation refuses before allocating an owner, never falls back headless", posixOnly, async () => {
  const machine = await realMachine({ declare: null })
  const result=await direct(machine)
  assert.equal(result.exitCode,1)
  assert.equal(result.payload.code,"browser_declaration_unavailable")
  assert.equal(existsSync(path.join(machine.state,"signed-in")),false)
  assert.equal(machine.spawns.length,0)
})

test("caller connection configuration is not an implicit alternative to the explicit context contract", posixOnly, async () => {
  const machine = await realMachine()
  const result=await direct(machine,{action:"create",label:"Owned explicit task",endpoint:"http://127.0.0.1:9222"})
  assert.equal(result.payload.code,"invalid_arguments")
  assert.equal(machine.spawns.length,0)
})

test("a declared profile and legacy token do not bypass missing native readiness or start a stock MCP fallback", posixOnly, async () => {
  const machine = await realMachine()
  const result=await direct(machine)
  assert.equal(result.payload.code,"NATIVE_READY_UNAVAILABLE")
  assert.equal(machine.spawns.length,0)
  assert.equal(existsSync(path.join(machine.state,"signed-in")),false)
  assert.equal(JSON.stringify(result).includes(TOKEN),false)
})

test("a declared profile refuses competing browser paths and profiles before connecting", posixOnly, async () => {
  for (const args of [["--executable-path", "/different"], ["--profile-dir-name=Other"], ["--user-data-dir", "/different"], ["--browser=chrome"]]) {
    const machine = await realMachine()
    const host = session(machine, { args })
    await host.handshake()
    const response = await host.call(2,"browser_command",{contextId:"11111111-1111-4111-8111-111111111111",args:["snapshot",...args]})
    assert.equal(response.result.isError, true, "conflicting browser arguments must not reach a page tool")
    assert.equal(JSON.parse(textOf(response)).code, "reserved_option")
    assert.equal(machine.spawns.length, 0)
    await host.close()
  }
})

test("a browser that is not installed is one degraded line on the first call", posixOnly, async () => {
  const machine = await realMachine({ edge: false })
  const host = session(machine)
  await host.handshake()
  assert.equal(JSON.parse(textOf(await host.call(2))).code, "NATIVE_BROWSER_UNAVAILABLE")
  assert.equal(machine.spawns.length, 0)
  await host.close()
})

test("missing native readiness remains unavailable after a legacy token appears; the same SDK connection never retries a legacy route", posixOnly, async () => {
  const machine = await realMachine({ entries: [] })
  const host = session(machine)
  const handshake = await host.handshake()
  assert.equal(handshake.result.serverInfo.name, "desk-web")
  const first = await host.call(2)
  assert.equal(first.result.isError, true)
  const payload = JSON.parse(textOf(first))
  assert.equal(payload.code, "NATIVE_READY_UNAVAILABLE")
  assert.equal(machine.spawns.length, 0)
  machine.levelEntries.entries = [[tokenKey(), latin(TOKEN)]]
  assert.equal(JSON.parse(textOf(await host.call(3))).code,"NATIVE_READY_UNAVAILABLE")
  assert.equal(machine.spawns.length,0)
  await host.close()
  assert.equal(host.raw.join("").includes(TOKEN), false)
})

test("a declared profile that is not there names what was looked for", posixOnly, async () => {
  const machine = await realMachine({ accounts: { Default: "me@gmail.com" } })
  const host = session(machine)
  await host.handshake()
  const payload = JSON.parse(textOf(await host.call(2)))
  assert.equal(payload.code, "browser_profile_unavailable")
  assert.equal(existsSync(path.join(machine.state,"signed-in")),false)
  assert.equal(machine.spawns.length, 0)
  await host.close()
})

test("an invalid declaration refuses signed-in creation without changing SDK availability or allocating an owner", posixOnly, async () => {
  const machine = await realMachine({ declare: { browser: { channel: "netscape", profileAccountDomain: "microsoft.com" } } })
  const host = session(machine)
  await host.handshake()
  const payload = JSON.parse(textOf(await host.call(2)))
  assert.equal(payload.code, "browser_declaration_unavailable")
  const tools=await host.ask(3,"tools/list")
  assert.deepEqual(tools.result.tools.map(tool=>tool.name),["browser_context","browser_command"])
  await host.close()
  assert.equal(machine.spawns.length, 0)
})

/** A fake npm for installs: `install` writes Playwright MCP, and the reader and ws too unless `readerFails`; with `allFail` nothing installs. */
function installNpm(calls, options = {}) {
  return (file, argv) => {
    calls.push(Array.from(argv).slice(1))
    const child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    setImmediate(() => {
      if (argv[1] !== "install") return child.emit("close", 0)
      const withReader = argv.includes("classic-level@1.4.1")
      if (options.allFail || (withReader && options.readerFails)) {
        child.stderr.write(options.noise ?? "npm error code E404\nnpm error no prebuilt binary\n")
        return child.emit("close", 1)
      }
      const prefix = argv[argv.indexOf("--prefix") + 1]
      touch(path.join(prefix, "node_modules", "@playwright", "mcp", "package.json"), JSON.stringify({ version: "0.0.84", bin: { "playwright-mcp": "cli.js" } }))
      touch(path.join(prefix, "node_modules", "@playwright", "mcp", "cli.js"), "")
      touch(path.join(prefix, "node_modules", "playwright-core", "lib", "coreBundle.js"), stockLifecycle)
      touch(path.join(prefix, "node_modules", "playwright-core", "lib", "tools/cli-client/session.js"), errorFixture.sessionSource)
      if (withReader) touch(path.join(prefix, "node_modules", "classic-level", "package.json"), "{}")
      if (argv.includes("ws@8.21.3")) touch(path.join(prefix, "node_modules", "ws", "package.json"), '{"version":"8.21.3"}')
      child.emit("close", 0)
    })
    return child
  }
}

// Preserve the retained non-MCP reader producer's own unit contract directly.
// It is not reachable by native desk-web calls and is never used as a fallback.
async function prepareLegacyReader(machine,extra={}) {
  const module={exports:{}},errors=[]
  const scope={module,__dirname:mcpRoot,process,Buffer,setTimeout,clearTimeout,
    require:name=>require(name.startsWith(".")?path.join(mcpRoot,name):name)}
  canonicalCjs("web.cjs",scope)
  const runtime=scope.browserRuntimeTools({...machine.launchOptions,...extra},{stderr:{write:text=>errors.push(text)}})
  const result=await scope.ensureInstalled(runtime.tools,runtime.root,runtime.clock()+110000,true)
  return{...result,errors}
}

test("retained non-MCP reader preparation installs reader and ws together without starting a page-tool route", posixOnly, async () => {
  const machine = await realMachine({ reader: false })
  const calls = []
  const prepared=await prepareLegacyReader(machine,{npmSpawn:installNpm(calls)})
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(-3), ["@playwright/mcp@latest", "classic-level@1.4.1", "ws@8.21.3"])
  assert.equal(prepared.installed.reader,true)
  assert.equal(prepared.installed.ws,true)
  assert.notEqual(prepared.installed.dir,path.join(machine.state,"installs","1-1-a"))
  assert.equal(machine.spawns.length,0)
  assert.equal(JSON.stringify(calls).includes(TOKEN), false)
})

test("a legacy real-profile generation migrates safely before acquiring its missing reader", posixOnly, async () => {
  const machine = await realMachine({ reader: false })
  writeFileSync(path.join(machine.state, "installs/1-1-a/playwright-patch.json"), "null")
  const calls = []
  await prepareLegacyReader(machine,{npmSpawn:installNpm(calls)})
  const installed = browser.readInstalled(machine.state)
  assert.equal(installed.patchRevision, playwrightPatch.REVISION)
  assert.equal(installed.reader, true)
  assert.equal(installed.ws, true)
  assert.equal(calls.length, 1)
  assert.equal(readdirSync(path.join(machine.state, "installs")).length, 3)
})

test("a reader that cannot be installed leaves the browser installed and marked, and the real profile answers that the token cannot be read", posixOnly, async () => {
  const machine = await realMachine({ reader: false, launch: { requireModule: undefined } })
  const calls = []
  await prepareLegacyReader(machine,{npmSpawn:installNpm(calls,{readerFails:true})})
  assert.deepEqual(calls.map((call) => call.slice(-3).join(" ")), ["@playwright/mcp@latest classic-level@1.4.1 ws@8.21.3", "--no-save --no-package-lock @playwright/mcp@latest"])
  const installed = browser.readInstalled(machine.state)
  assert.equal(installed.reader, true, "the marked install counts as having been tried")
  assert.equal(existsSync(path.join(installed.dir, "reader-unavailable")), true)
  await prepareLegacyReader(machine,{npmSpawn:installNpm(calls,{allFail:true})})
  assert.equal(calls.length, 2, "a later launch does not install again")
  assert.equal(machine.spawns.length,0)
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
  const prepared=await prepareLegacyReader(machine,{npmSpawn:installNpm(calls)})
  assert.equal(prepared.installed.reader,true)
  assert.deepEqual(calls, [])
})

test("a marker older than a day is retried once, and the reader installs when npm works now", posixOnly, async () => {
  const machine = await markedMachine(DAY + 60 * 1000)
  const calls = []
  await prepareLegacyReader(machine,{npmSpawn:installNpm(calls)})
  assert.equal(machine.spawns.length,0)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0].slice(-3), ["@playwright/mcp@latest", "classic-level@1.4.1", "ws@8.21.3"])
  const installed = browser.readInstalled(machine.state)
  assert.equal(existsSync(path.join(installed.dir, "node_modules", "classic-level", "package.json")), true)
  assert.equal(installed.unavailableAt, undefined)
})

test("a retry that fails again writes a fresh marker, and a retry that cannot install anything keeps the working install", posixOnly, async () => {
  const machine = await markedMachine(2 * DAY)
  const calls = []
  await prepareLegacyReader(machine,{npmSpawn:installNpm(calls,{readerFails:true})})
  assert.equal(calls.length, 2)
  const installed = browser.readInstalled(machine.state)
  assert.notEqual(installed.dir, path.join(machine.state, "installs", "1-1-a"))
  assert.ok(Date.now() - statSync(path.join(installed.dir, "reader-unavailable")).mtimeMs < DAY, "the marker was rewritten")

  const down = await markedMachine(2 * DAY)
  const downCalls = []
  const offline=await prepareLegacyReader(down,{npmSpawn:installNpm(downCalls,{allFail:true})})
  assert.equal(offline.installed.dir,path.join(down.state,"installs","1-1-a"))
  assert.equal(downCalls.length, 2)
  assert.equal(browser.readInstalled(down.state).dir, path.join(down.state, "installs", "1-1-a"))
})

test("a stale marker does not make a launch wait for another session's install", posixOnly, async () => {
  const machine = await markedMachine(2 * DAY)
  touch(path.join(machine.state, "refresh.lock"), JSON.stringify({ pid: process.pid, at: Date.now() }))
  const calls = []
  const prepared=await prepareLegacyReader(machine,{npmSpawn:installNpm(calls)})
  assert.deepEqual(calls, [])
  assert.match(prepared.errors.join(""), /another Desk session is installing; keeping the install without the connection reader/u)
})

test("when the reader cannot be installed the existing install is kept and npm's reason goes to stderr without credentials", posixOnly, async () => {
  const machine = await realMachine({ reader: false })
  const noise = "npm error code E401 auth failed for https://me:hunter2@registry.example/ _authToken=abc123 Authorization: Bearer bearer111 and Basic basic222 leaked npm_abcdefghijklmnopqrstuvwxyz0123 here GET https://registry.example/x?token=query333&ok=1 and ?password=query444 end https://u:p@ss/word@registry.example/pkg\n"
  const prepared=await prepareLegacyReader(machine,{npmSpawn:installNpm([],{allFail:true,noise})})
  assert.equal(prepared.installed.dir,path.join(machine.state,"installs","1-1-a"))
  assert.equal(machine.spawns.length,0,"reader preparation never starts a browser")
  const err = prepared.errors.join("")
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
    assert.equal(calls[0].includes("ws@8.21.3"), reader)
  }
})

test("the real-profile module uses only syntax that very old Node parses", () => {
  const source = readFileSync(path.join(mcpRoot, "web-real-profile.cjs"), "utf8").split("\n").filter((line) => !line.trim().startsWith("//")).join("\n")
  assert.doesNotMatch(source, /=>|`|\?\.|\blet\s|\bconst\s|\basync\s/u)
})

test("the token is never written anywhere the launcher can print it", () => {
  const sources = ["web.cjs", "web-real-profile.cjs", "web-proxy.cjs", "web-real-tabs.cjs"].map((file) => readFileSync(path.join(mcpRoot, file), "utf8")).join("\n")
  assert.doesNotMatch(sources, /console\./u)
  const writes = sources.split("\n").filter((line) => /stderr\.write|stdout\.write/u.test(line))
  for (const line of writes) assert.doesNotMatch(line, /token/iu)
})
