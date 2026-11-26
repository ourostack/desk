// Desk's browser (plugins/desk/mcp/web.cjs): fresh or mine, through the Playwright CLI.
// Most tests drive a fake CLI and a fake npm placed where the real ones go, so they run everywhere without a browser.
// With DESK_BROWSER_REAL=1 the last tests install the real playwright-core and drive a real Edge or Chrome.
import { afterEach, beforeEach, test } from "node:test"
import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { EventEmitter } from "node:events"
import crypto from "node:crypto"
import fs from "node:fs"
import http from "node:http"
import os from "node:os"
import { createRequire } from "node:module"
import * as path from "node:path"
import { PassThrough } from "node:stream"
import { fileURLToPath, pathToFileURL } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { different } from "../_file_identity.js"
import { NO_POSIX_MODES, isWindows } from "../_platform.js"
import { fakeDriver, PASSWORD } from "./_auth_fixtures.js"
import { removeTreeSync } from "../_remove_tree.js"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const webFile = path.join(repoRoot, "plugins", "desk", "mcp", "web.cjs")
const web = require(webFile)
const auth = require(path.join(repoRoot, "plugins", "desk", "mcp", "web-auth.cjs"))
const catalog = require(path.join(repoRoot, "plugins", "desk", "mcp", "web-catalog.json"))
const sourceOnly = process.env.DESK_BROWSER_SOURCE_ONLY === "1"

// Authenticated tests use a fake driver/runtime, not a credential-bearing host.
// Coverage stays loaded; only its forwarded environment is scoped out of each
// synthetic case, which explicitly supplies unqualified options when testing refusal.
let inheritedNodeOptions
beforeEach(() => {
  inheritedNodeOptions = process.env.NODE_OPTIONS
  delete process.env.NODE_OPTIONS
})
afterEach(() => {
  if (inheritedNodeOptions === undefined) delete process.env.NODE_OPTIONS
  else process.env.NODE_OPTIONS = inheritedNodeOptions
})

const FAKE_CLI = `
const fs = require("fs"), path = require("path")
const args = process.argv.slice(2)
fs.appendFileSync(path.join(__dirname, "calls.log"), JSON.stringify({ args, cwd: process.cwd() }) + "\\n")
const verb = args[1] === "eval" ? args[2] : args[1], mode = process.env.FAKE_CLI_MODE || ""
if (verb === "open" && mode === "open-fail") { process.stderr.write("Browser failed\\nline two\\n"); process.exit(1) }
if (verb === "open" && mode === "open-hang") setTimeout(() => {}, 10000)
if (verb === "open" && mode === "open-hang-loud") { process.stderr.write("Waiting for the browser\\n"); setTimeout(() => {}, 10000) }
// "open-stall-once" hangs silently on the first open only, and "open-stall-then-fail" then fails on the second, so a retry is what gets the browser, or not.
const openCalls = verb === "open" ? fs.readFileSync(path.join(__dirname, "calls.log"), "utf8").trim().split("\\n").filter((line) => JSON.parse(line).args[1] === "open").length : 0
if (verb === "open" && mode === "open-stall-once" && openCalls === 1) setTimeout(() => {}, 10000)
if (verb === "open" && mode === "open-stall-then-fail" && openCalls === 1) setTimeout(() => {}, 10000)
// "open-stall-exit-zero" is the real CLI: it traps SIGTERM while it starts its daemon, then exits 0 when stopped.
if (verb === "open" && mode === "open-stall-exit-zero" && openCalls === 1) { process.on("SIGTERM", () => process.exit(0)); setTimeout(() => {}, 10000) }
if (verb === "open" && mode === "open-stall-then-fail" && openCalls === 2) { process.stderr.write("Browser failed\\nline two\\n"); process.exit(1) }
if (verb === "snapshot" && mode === "web-option") process.stdout.write('- button "Open app" [ref=e3]\\n- link "Join from browser" [ref=e4] [cursor=pointer]:\\n')
else if (verb === "snapshot") process.stdout.write("- generic [ref=e1]\\n")
if (verb === "screenshot" && mode !== "no-picture") { fs.writeFileSync(path.join(process.cwd(), "files", "page-1.png"), "PNG"); process.stdout.write("### Result\\n- [Screenshot](files/page-1.png)\\n") }
if (verb === "fail-quiet") process.exit(1)
if (verb === "fail-loud") { process.stderr.write("boom\\n"); process.exit(1) }
if (verb === "sleep") setTimeout(() => {}, 10000)
// "daemon" modes start a detached fake daemon that starts a fake browser, as the real CLI does, and print its PID the way the real CLI does.
if (verb === "open" && mode.startsWith("daemon")) {
  const record = path.join(process.cwd(), "daemon.json")
  require("child_process").spawn(process.execPath, [process.env.FAKE_DAEMON_SOURCE, record], { detached: true, stdio: "ignore", windowsHide: true }).unref()
  for (const begun = Date.now(); !fs.existsSync(record); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)) {
    if (Date.now() - begun > 15000) { process.stderr.write("the fake daemon did not start\\n"); process.exit(1) }
  }
  const { daemon } = JSON.parse(fs.readFileSync(record, "utf8"))
  if (mode === "daemon-open-fail") { process.stderr.write("Daemon pid=" + daemon + ": Daemon process exited with code 1\\n"); process.exit(1) }
  process.stdout.write("### Browser \`desk\` opened with pid " + daemon + ".\\n")
}
// A well-behaved close stops the daemon and its browser; "daemon-leak" leaves both running, as a real browser on a copied profile did.
if (verb === "close" && mode === "daemon") {
  const { daemon, browser } = JSON.parse(fs.readFileSync(path.join(process.cwd(), "daemon.json"), "utf8"))
  for (const pid of [browser, daemon]) process.kill(pid)
  while ([browser, daemon].some((pid) => { try { process.kill(pid, 0); return true } catch { return false } })) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20)
}
// The PID of a process that is gone by the time Desk looks.
if (verb === "open" && mode === "ghost") process.stdout.write("### Browser \`desk\` opened with pid " + process.pid + ".\\n")
`

const FAKE_DAEMON = `
const fs = require("fs")
const browser = require("child_process").spawn(process.execPath, [process.env.FAKE_BROWSER_SOURCE], { stdio: "ignore", windowsHide: true })
fs.appendFileSync(process.env.FAKE_DAEMON_LOG, process.pid + " " + browser.pid + "\\n")
fs.writeFileSync(process.argv[2] + ".tmp", JSON.stringify({ daemon: process.pid, browser: browser.pid }))
fs.renameSync(process.argv[2] + ".tmp", process.argv[2])
setInterval(() => {}, 1000)
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
  const daemonSource = path.join(root, "fake-daemon.js")
  fs.writeFileSync(daemonSource, FAKE_DAEMON)
  const browserSource = path.join(root, "fake-browser.js")
  fs.writeFileSync(browserSource, "setInterval(() => {}, 1000)\n")
  const installDir = path.join(state, `playwright-core-${web.PLAYWRIGHT_VERSION}`)
  const cliDir = path.join(installDir, "node_modules", "playwright-core", "lib", "tools", "cli-client")
  if (cli) {
    fs.mkdirSync(cliDir, { recursive: true })
    fs.copyFileSync(cliSource, path.join(cliDir, "cli.js"))
  }
  const profiles = path.join(root, "profiles")
  const env = { ...process.env, DESK_BROWSER_STATE_DIR: state, FAKE_CLI_MODE: mode, FAKE_CLI_SOURCE: cliSource, FAKE_DAEMON_SOURCE: daemonSource, FAKE_BROWSER_SOURCE: browserSource, FAKE_DAEMON_LOG: path.join(root, "daemons.log"), FAKE_NPM_MODE: npmMode ?? "ok", FAKE_FINAL: installDir }
  const options = {
    env, tmpDir: tmp, npmCli: npm, exists: onlyEdge, platform: platform ?? process.platform,
    authDriver: fakeDriver().driver,
    keychainRun: () => { throw new Error("tests never read the keychain") },
    runtimeStateReader: () => ({ execArgv: [], inspectorActive: false }),
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

test("no tool text claims that eval, run-code or raw commands are refused", () => {
  const text = JSON.stringify(catalog)
  assert.doesNotMatch(text, /raw (commands?|operations?) (is|are) refused|refuses? (raw|eval|run-code)|(eval|run-code)[^.]{0,40}(refused|unavailable|not available)/iu)
  assert.match(catalog.tools[1].description, /eval and run-code return what the script returns/u)
  assert.doesNotMatch(fs.readFileSync(webFile, "utf8"), /raw commands are refused/u)
})

test("the open reply says which Desk and which plugin folder served it", async () => {
  const { options, tmp, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const pluginRoot = path.join(tmp, "plugin")
  fs.mkdirSync(pluginRoot)
  fs.writeFileSync(path.join(pluginRoot, "plugin.json"), JSON.stringify({ name: "desk", version: "7.6.5" }))
  const controller = web.createController({ ...options, pluginRoot })
  const opened = json(await controller.call("browser_context", { action: "open" }))
  try { assert.deepEqual(opened.runtime, { plugin: { name: "desk", version: "7.6.5" }, plugin_root: pluginRoot }) } finally { await controller.closeAll() }
  const bare = web.createController({ ...options, pluginRoot: path.join(tmp, "none") })
  const second = json(await bare.call("browser_context", { action: "open" }))
  try { assert.deepEqual(second.runtime, { plugin: { name: "desk", version: null }, plugin_root: path.join(tmp, "none") }) } finally { await bare.closeAll() }
  const own = web.createController(options)
  const mine = json(await own.call("browser_context", { action: "open", browser: "mine" }))
  try {
    assert.equal(mine.runtime.plugin_root, path.join(repoRoot, "plugins", "desk"))
    assert.match(mine.runtime.plugin.version, /^\d+\.\d+\.\d+/u)
  } finally { await own.closeAll() }
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
  assert.deepEqual(web.copyProfile(source, dest), { name: "Profile 1", skipped: [] })
  assert.ok(fs.existsSync(path.join(dest, "Local State")))
  assert.equal(fs.readFileSync(path.join(dest, "Profile 1", "Network", "Cookies"), "utf8"), "cookies")
  for (const skipped of ["Cache", "Sessions", "Extensions"]) assert.equal(fs.existsSync(path.join(dest, "Profile 1", skipped)), false, skipped)
})

test("copyProfile stores copied cookie values as plain values so a newer browser still reads them, and leaves the source alone", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const key = Buffer.alloc(16, 7)
  const seal = (host, value) => {
    const cipher = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
    const body = Buffer.concat([crypto.createHash("sha256").update(host).digest(), Buffer.from(value)])
    return Buffer.concat([Buffer.from("v10"), cipher.update(body), cipher.final()])
  }
  const cookies = path.join(source, "Profile 1", "Network", "Cookies")
  fs.rmSync(cookies)
  const db = new DatabaseSync(cookies)
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)")
  const insert = db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)")
  insert.run("github.com", "user_session", "", seal("github.com", "secret-session"))
  const bare = crypto.createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20))
  insert.run("old.example", "bare", "", Buffer.concat([Buffer.from("v10"), bare.update("plain-no-digest-prefix-padding-xx"), bare.final()]))
  insert.run("v11.example", "v11", "", Buffer.from("v11-something-longer-than-19"))
  insert.run("null.example", "nothing", "", null)
  insert.run("text.example", "text", "", "v10-stored-as-text-not-bytes")
  insert.run("example.com", "broken", "", Buffer.from("v10not-decryptable-bytes"))
  db.close()
  const before = fs.readFileSync(cookies)
  const dest = path.join(root, "dest")
  const copied = web.copyProfile(source, dest, "Microsoft Edge", { cookieKey: key })
  assert.deepEqual(copied.unreadableCookies, { encrypted: 5, unreadable: 3, keychain: "key read" })
  const copy = new DatabaseSync(path.join(dest, "Profile 1", "Network", "Cookies"))
  const rows = copy.prepare("SELECT name, value, length(encrypted_value) AS n FROM cookies ORDER BY name").all()
  copy.close()
  assert.deepEqual(rows.map((row) => [row.name, row.value, row.n]), [["bare", "plain-no-digest-prefix-padding-xx", 0], ["broken", "", 24], ["nothing", "", null], ["text", "", 28], ["user_session", "secret-session", 0], ["v11", "", 28]])
  assert.deepEqual(fs.readFileSync(cookies), before)
  web.copyProfile(source, path.join(root, "dest2"), "Microsoft Edge", { cookieKey: key })
  fs.writeFileSync(path.join(source, "Profile 1", "Network", "Cookies"), "not a database")
  web.copyProfile(source, path.join(root, "dest3"), "Microsoft Edge", { cookieKey: key })
  assert.equal(fs.readFileSync(path.join(root, "dest3", "Profile 1", "Network", "Cookies"), "utf8"), "not a database")
  const unknown = web.copyProfile(source, path.join(root, "dest4"), "Microsoft Edge", { cookieKey: key })
  assert.equal(unknown.uninspectedCookies, 1)
  assert.equal(unknown.unreadableCookies, undefined)
  assert.match(web.sessionWarning(undefined, 1), /^COOKIES_NOT_INSPECTED: 1 copied cookie file\(s\).*unknown\./)
})

test("copyProfile says so when encrypted cookies cannot be made readable, instead of passing off a signed-out copy as a normal one", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const cookies = path.join(source, "Profile 1", "Network", "Cookies")
  fs.rmSync(cookies)
  const db = new DatabaseSync(cookies)
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)")
  db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run("github.com", "user_session", "", Buffer.from("v10sealed-by-the-running-browser"))
  db.close()
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "darwin" })
  let copied
  try { copied = web.copyProfile(source, path.join(root, "dest"), "Microsoft Edge", { cookieKey: null }) } finally { Object.defineProperty(process, "platform", platform) }
  assert.deepEqual(copied.unreadableCookies, { encrypted: 1, unreadable: 1, keychain: "no key" })
  assert.match(web.sessionWarning(copied.unreadableCookies, copied.uninspectedCookies), /^SESSION_MAY_BE_MISSING: 1 of 1 cookies .*Safe Storage key: no key/)
  assert.equal(web.copyProfile(source, path.join(root, "dest2"), "Microsoft Edge", { cookieKey: crypto.randomBytes(16) }).unreadableCookies.keychain, "key read")
})

test("keychainCookieKey reports why the keychain gave no key, without any secret", () => {
  const why = (error) => { const report = {}; web.keychainCookieKey("Microsoft Edge", "darwin", () => { throw error }, report); return report.reason }
  assert.equal(why(Object.assign(new Error("x"), { status: 44 })), "exit 44")
  assert.equal(why(Object.assign(new Error("x"), { code: "ETIMEDOUT" })), "timeout")
  assert.equal(why(new Error("x")), "unavailable")
})

test("keychainCookieKey derives the browser's cookie key on macOS and gives none anywhere else or when the keychain refuses", () => {
  const seen = []
  const run = (command, args) => { seen.push([command, ...args]); return Buffer.from("secret\n") }
  const key = web.keychainCookieKey("Microsoft Edge", "darwin", run)
  assert.deepEqual(key, crypto.pbkdf2Sync("secret", "saltysalt", 1003, 16, "sha1"))
  assert.deepEqual(seen, [["security", "find-generic-password", "-w", "-s", "Microsoft Edge Safe Storage", "-a", "Microsoft Edge"]])
  assert.equal(web.keychainCookieKey("Microsoft Edge", "linux", run), null)
  assert.equal(web.keychainCookieKey("Other", "darwin", run), null)
  assert.equal(web.keychainCookieKey("Google Chrome", "darwin", () => { throw new Error("denied") }), null)
})

test("copyProfile falls back to Default for a missing, unsafe or malformed last_used", async () => {
  const { root } = await setup()
  for (const [index, localState] of [{ profile: { last_used: "../x" } }, { profile: { last_used: ".." } }, { profile: { last_used: 5 } }, {}].entries()) {
    const source = path.join(root, `src${index}`)
    fs.mkdirSync(path.join(source, "Default"), { recursive: true })
    fs.writeFileSync(path.join(source, "Local State"), JSON.stringify(localState))
    assert.equal(web.copyProfile(source, path.join(root, `dest${index}`)).name, "Default")
  }
})

test("copyProfile excludes saved-login stores and companions without changing cookies or encryption metadata", async () => {
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const localState = JSON.stringify({ profile: { last_used: "Profile 1" }, os_crypt: { encrypted_key: "synthetic-cookie-key" } })
  fs.writeFileSync(path.join(source, "Local State"), localState)
  const profile = path.join(source, "Profile 1")
  const passwords = [
    "Login Data", "Login Data-journal", "Login Data-wal", "Login Data-shm",
    "Login Data For Account", "Login Data For Account-journal", "Login Data For Account-wal", "Login Data For Account-shm",
    "Login Data.bak", "Login Data Backup", "login data-wal",
  ]
  for (const folder of [profile, path.join(profile, "Network")]) {
    for (const name of passwords) fs.writeFileSync(path.join(folder, name), "synthetic-saved-login")
  }
  fs.writeFileSync(path.join(profile, "Network", "Cookies-wal"), "synthetic-cookie-wal")
  fs.writeFileSync(path.join(profile, "Network", "Cookies-shm"), "synthetic-cookie-shm")
  fs.mkdirSync(path.join(profile, "Local Storage"))
  fs.writeFileSync(path.join(profile, "Local Storage", "session"), "synthetic-session")
  const dest = path.join(root, "dest")
  assert.deepEqual(web.copyProfile(source, dest), { name: "Profile 1", skipped: [] })
  assert.equal(fs.readFileSync(path.join(dest, "Local State"), "utf8"), localState)
  const copied = path.join(dest, "Profile 1")
  for (const folder of [copied, path.join(copied, "Network")]) {
    for (const name of passwords) assert.equal(fs.existsSync(path.join(folder, name)), false, name)
  }
  assert.equal(fs.readFileSync(path.join(copied, "Network", "Cookies"), "utf8"), "cookies")
  assert.equal(fs.readFileSync(path.join(copied, "Network", "Cookies-wal"), "utf8"), "synthetic-cookie-wal")
  assert.equal(fs.readFileSync(path.join(copied, "Network", "Cookies-shm"), "utf8"), "synthetic-cookie-shm")
  assert.equal(fs.readFileSync(path.join(copied, "Local Storage", "session"), "utf8"), "synthetic-session")
  for (const name of passwords) assert.equal(fs.readFileSync(path.join(profile, name), "utf8"), "synthetic-saved-login")
})

test("copyProfile does not follow aliases to saved-login stores", { skip: isWindows ? "symlink creation requires Windows privileges" : false }, async () => {
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const profile = path.join(source, "Profile 1")
  fs.writeFileSync(path.join(profile, "Login Data"), "synthetic-saved-login")
  fs.symlinkSync("Login Data", path.join(profile, "saved-login-alias"))
  const dest = path.join(root, "dest")
  assert.deepEqual(web.copyProfile(source, dest), { name: "Profile 1", skipped: ["saved-login-alias"] })
  assert.equal(fs.existsSync(path.join(dest, "Profile 1", "saved-login-alias")), false)
  assert.equal(fs.readFileSync(path.join(profile, "saved-login-alias"), "utf8"), "synthetic-saved-login")
})

test("copyProfile excludes multiply-linked aliases regardless of name order or inventory", async () => {
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const profile = path.join(source, "Profile 1")
  const store = path.join(profile, "Login Data")
  fs.writeFileSync(store, "synthetic-saved-login")
  for (const name of ["000-before", "zzz-after"]) fs.linkSync(store, path.join(profile, name))
  const outside = path.join(root, "outside-store")
  fs.writeFileSync(outside, "synthetic-outside-store")
  fs.mkdirSync(path.join(profile, "nested"))
  fs.linkSync(outside, path.join(profile, "nested", "ordinary"))
  const dest = path.join(root, "dest")
  const copied = web.copyProfile(source, dest)
  for (const name of ["000-before", "zzz-after", "nested/ordinary"]) {
    assert.equal(fs.existsSync(path.join(dest, "Profile 1", name)), false, name)
    assert.ok(copied.skipped.includes(name))
  }
  assert.equal(fs.readFileSync(path.join(dest, "Profile 1", "Network", "Cookies"), "utf8"), "cookies")
})

test("copyProfile refuses linked essential metadata or cookies without reading Local State first", async () => {
  const { root } = await setup()
  for (const [index, relative] of ["Local State", "Profile 1/Network/Cookies", "Profile 1/Network/Cookies-wal"].entries()) {
    const source = path.join(root, `src${index}`)
    makeProfile(source)
    const file = path.join(source, relative)
    if (!fs.existsSync(file)) fs.writeFileSync(file, "synthetic-cookie-companion")
    fs.linkSync(file, path.join(root, `alias${index}`))
    assert.throws(() => web.copyProfile(source, path.join(root, `dest${index}`)), /COPY_SOURCE_POLICY/u)
  }
})

test("copyProfile binds Local State to its opened identity before reading bytes", async () => {
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const originalStat = fs.fstatSync
  const originalRead = fs.readFileSync
  let reads = 0
  fs.fstatSync = (...args) => {
    const stat = originalStat(...args)
    return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: different(stat.ino) })
  }
  fs.readFileSync = (...args) => { reads++; return originalRead(...args) }
  try {
    assert.throws(() => web.copyProfile(source, path.join(root, "dest")), /COPY_SOURCE_POLICY/u)
    assert.equal(reads, 0)
  } finally {
    fs.fstatSync = originalStat
    fs.readFileSync = originalRead
  }
})

test("copyProfile refuses an essential cookie symlink rather than silently omitting session state", { skip: isWindows }, async () => {
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const cookie = path.join(source, "Profile 1", "Network", "Cookies")
  const target = path.join(root, "cookie-target")
  fs.renameSync(cookie, target)
  fs.symlinkSync(target, cookie)
  assert.throws(() => web.copyProfile(source, path.join(root, "dest")), /COPY_SOURCE_POLICY/u)
})

test("copyProfile names an operating-system read block instead of a profile policy failure", async () => {
  const { root } = await setup()
  const blocked = (code) => Object.assign(new Error(`${code}: operation not permitted`), { code })
  for (const [index, [code, target]] of [["EPERM", /Local State$/u], ["EACCES", /Local State$/u], ["EPERM", /Cookies$/u]].entries()) {
    const source = path.join(root, `perm${index}`)
    makeProfile(source)
    const original = fs.openSync
    fs.openSync = (file, ...args) => {
      if (target.test(String(file))) throw blocked(code)
      return original(file, ...args)
    }
    try {
      const dest = path.join(root, `perm${index}-copy`)
      assert.throws(() => web.copyProfile(source, dest, "Microsoft Edge", { cookieKey: null }), (error) => {
        assert.match(error.message, /^COPY_SOURCE_PERMISSION: The operating system blocked reading your Microsoft Edge profile/u)
        assert.match(error.message, /No authenticated copy was opened\.$/u)
        return true
      })
      if (index < 2) assert.equal(fs.existsSync(path.join(dest, "Local State")), false)
    } finally { fs.openSync = original }
  }
  const listed = path.join(root, "perm-list")
  makeProfile(listed)
  const originalList = fs.readdirSync
  fs.readdirSync = (dir, ...args) => {
    if (String(dir).startsWith(listed)) throw blocked("EPERM")
    return originalList(dir, ...args)
  }
  try { assert.throws(() => web.copyProfile(listed, path.join(root, "perm-list-copy")), /COPY_SOURCE_PERMISSION: .*your browser profile/u) }
  finally { fs.readdirSync = originalList }
  const other = path.join(root, "other-list")
  makeProfile(other)
  fs.readdirSync = (dir, ...args) => {
    if (String(dir).startsWith(other)) throw blocked("EIO")
    return originalList(dir, ...args)
  }
  try {
    assert.throws(() => web.copyProfile(other, path.join(root, "other-list-copy")), (error) => {
      assert.equal(error.code, "EIO")
      return true
    })
  } finally { fs.readdirSync = originalList }
})

test("copyProfile suggests permission review without claiming a cause or granting OS access", async () => {
  const { root } = await setup()
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  const original = fs.openSync
  fs.openSync = (file, ...args) => {
    if (/Local State$/u.test(String(file))) throw Object.assign(new Error("EPERM"), { code: "EPERM" })
    return original(file, ...args)
  }
  try {
    for (const [os, fix] of [["darwin", /Full Disk Access may be relevant, but is not a guaranteed fix/u], ["linux", /review the host process's profile-folder access and system policy/u]]) {
      Object.defineProperty(process, "platform", { ...platform, value: os })
      const source = path.join(root, `os-${os}`)
      makeProfile(source)
      assert.throws(() => web.copyProfile(source, path.join(root, `os-${os}-copy`), "Microsoft Edge", { cookieKey: null }), (error) => {
        assert.match(error.message, fix)
        assert.match(error.message, /does not identify the exact permission or policy/u)
        assert.match(error.message, /Desk cannot grant OS access/u)
        assert.match(error.message, /do not switch identity or transport, or control the person's browser or desktop as a fallback/u)
        return true
      })
    }
  } finally {
    Object.defineProperty(process, "platform", platform)
    fs.openSync = original
  }
})

test("copyProfile still omits a nonessential file the operating system blocks", async () => {
  const { root } = await setup()
  const source = path.join(root, "src")
  makeProfile(source)
  const original = fs.openSync
  fs.openSync = (file, ...args) => {
    if (/Preferences$/u.test(String(file))) throw Object.assign(new Error("EPERM"), { code: "EPERM" })
    return original(file, ...args)
  }
  try {
    const copied = web.copyProfile(source, path.join(root, "dest"))
    assert.ok(copied.skipped.includes("Preferences"))
  } finally { fs.openSync = original }
})

test("copyProfile rejects unknown identity and link changes after a read without writing metadata", async () => {
  const { root } = await setup()
  for (const mode of ["unknown", "changed-after-read"]) {
    const source = path.join(root, mode)
    makeProfile(source)
    const original = fs.fstatSync
    let count = 0
    fs.fstatSync = (...args) => {
      const stat = original(...args)
      count++
      const changes = mode === "unknown" ? { ino: 0n } : (count === 2 ? { nlink: 2n } : {})
      return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, changes)
    }
    try {
      const dest = path.join(root, `${mode}-copy`)
      assert.throws(() => web.copyProfile(source, dest), /COPY_SOURCE_POLICY/u)
      assert.equal(fs.existsSync(path.join(dest, "Local State")), false)
    } finally { fs.fstatSync = original }
  }
})

// ---- the controller with a fake CLI ----

test("mine uses the owned native API and never opens or closes the CLI", async () => {
  const { options, profiles, calls } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  const controller = web.createController({ ...options, authDriver: native.driver })
  const opened = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(opened.isError, false, text(opened))
  assert.equal(native.calls.filter((call) => call[0] === "launchPersistentContext").length, 1)
  assert.equal(calls().length, 0)
  await controller.closeAll()
  assert.equal(native.calls.filter((call) => call[0] === "context.close").length, 1)
  assert.equal(calls().length, 0)
})

test("mine open on macOS warns, through the supported entry, when the keychain refuses and the copy holds encrypted cookies", async () => {
  const { DatabaseSync } = await import("node:sqlite")
  const { options, profiles } = await setup()
  const edge = path.join(profiles, "edge")
  makeProfile(edge)
  const cookies = path.join(edge, "Profile 1", "Network", "Cookies")
  fs.rmSync(cookies)
  const db = new DatabaseSync(cookies)
  db.exec("CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB)")
  db.prepare("INSERT INTO cookies VALUES (?, ?, ?, ?)").run("github.com", "user_session", "", Buffer.from("v10sealed-by-the-running-browser"))
  db.close()
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  Object.defineProperty(process, "platform", { value: "darwin" })
  const keychainRun = () => { throw Object.assign(new Error("denied"), { status: 51 }) }
  try {
    const controller = web.createController({ ...options, keychainRun })
    const opened = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(opened.isError, false, text(opened))
    const reply = JSON.parse(text(opened))
    assert.match(reply.sessionWarning, /^SESSION_MAY_BE_MISSING: 1 of 1 cookies .*Safe Storage key: exit 51/)
    const again = JSON.parse(text(await controller.call("browser_context", { action: "open", browser: "mine" })))
    assert.match(again.sessionWarning, /exit 51/)
    assert.match(reply.note, /if its sign-ins carried \(see sessionWarning/)
    assert.doesNotMatch(reply.note, /GitHub shows the account that was active in the copied profile; this copy holds every/)
    await controller.closeAll()
  } finally { Object.defineProperty(process, "platform", platform) }
})

test("mine runs eval as given, and emits owned redacted text JSON and artifacts", async () => {
  const { options, profiles, calls } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  const controller = web.createController({ ...options, authDriver: native.driver })
  const opened = json(await controller.call("browser_context", { action: "open", browser: "mine" }))
  try {
    native.page.evaluateHandle = async (script) => ({ script, dispose: async () => {} })
    native.page.evaluate = async (call, [source]) => `ran ${source.script}`
    const ran = await controller.call("browser_command", { contextId: opened.contextId, args: ["eval", "() => document.querySelector('input').value"] })
    assert.equal(ran.isError, false, text(ran))
    assert.equal(json(ran).result, "ran () => document.querySelector('input').value")
    const snapshot = await controller.call("browser_command", { contextId: opened.contextId, args: ["snapshot", "--save"] })
    assert.equal(snapshot.isError, false, text(snapshot))
    assert.ok(text(snapshot).includes("[redacted]"))
    assert.equal(text(snapshot).includes(PASSWORD), false)
    const result = json(snapshot)
    assert.equal("snapshot" in result, false, "the reply carries the text, not the same tree again")
    assert.ok(result.text.includes("[redacted]"))
    assert.ok(JSON.parse(fs.readFileSync(result.artifact, "utf8")).snapshot, "the saved artifact keeps the tree")
    assert.equal(json(await controller.call("browser_command", { contextId: opened.contextId, args: ["tab-list"] })).tabs.length, 1)
    assert.equal(fs.readFileSync(result.artifact, "utf8").includes(PASSWORD), false)
    assert.ok(fs.readFileSync(result.artifact, "utf8").includes("[redacted]"))
    assert.equal(calls().length, 0)
  } finally { await controller.closeAll() }
})

test("authenticated cleanup IO errors do not expose raw error text and retain retry ownership", async () => {
  const { options, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const controller = web.createController(options)
  const opened = json(await controller.call("browser_context", { action: "open", browser: "mine" }))
  const original = fs.rmSync
  fs.rmSync = () => { throw new Error(PASSWORD) }
  try {
    const result = await controller.call("browser_context", { action: "close", contextId: opened.contextId })
    assert.equal(result.isError, true)
    assert.equal(text(result).includes(PASSWORD), false)
  } finally { fs.rmSync = original; await controller.closeAll() }
})

test("authenticated owner forgery and unowned copies never reach legacy command or cleanup", async () => {
  const { options, profiles, tmp, calls } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const controller = web.createController(options)
  const opened = json(await controller.call("browser_context", { action: "open", browser: "mine" }))
  const dir = path.join(tmp, `desk-browser-${opened.contextId}`)
  const ownerFile = path.join(dir, "owner.json")
  const original = fs.readFileSync(ownerFile, "utf8")
  try {
    const other = web.createController(options)
    assert.equal((await other.call("browser_command", { contextId: opened.contextId, args: ["eval", "() => 1"] })).isError, true)
    assert.equal((await other.call("browser_context", { action: "close", contextId: opened.contextId })).isError, true)
    fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, browser: "fresh", transport: "legacy-cli", profilePolicy: 1 }))
    assert.equal((await controller.call("browser_command", { contextId: opened.contextId, args: ["eval", "() => 1"] })).isError, true)
    assert.equal(calls().length, 0)
  } finally {
    fs.writeFileSync(ownerFile, original)
    await controller.closeAll()
  }
})

test("authenticated runtime admission rejects environment preloads and active inspection before copying", async () => {
  const { options, profiles, tmp, calls } = await setup()
  makeProfile(path.join(profiles, "edge"))
  for (const extra of [
    { env: { ...options.env, NODE_OPTIONS: "--inspect=127.0.0.1:0" } },
    { env: { ...options.env, NODE_OPTIONS: "--require fake-preload.js" } },
    { env: { ...options.env, NODE_OPTIONS: "--import fake-preload.mjs" } },
    { runtimeStateReader: () => ({ execArgv: ["--require", "fake-preload.js"], inspectorActive: false }) },
    { runtimeStateReader: () => ({ execArgv: [], inspectorActive: true }) },
  ]) {
    const native = fakeDriver()
    const controller = web.createController({ ...options, ...extra, authDriver: native.driver })
    const original = fs.openSync
    let sourceOpens = 0
    fs.openSync = (file, ...args) => {
      if (String(file).startsWith(profiles)) sourceOpens++
      return original(file, ...args)
    }
    try {
      const result = await controller.call("browser_context", { action: "open", browser: "mine" })
      assert.equal(result.isError, true)
      assert.match(text(result), /AUTH_LOGGING_REFUSED/u)
      assert.equal(sourceOpens, 0)
      assert.equal(native.calls.length, 0)
      assert.equal(calls().length, 0)
      assert.deepEqual(fs.readdirSync(tmp), [])
    } finally { fs.openSync = original; await controller.closeAll() }
  }
})

test("authenticated runtime admission allows only the launcher bootstrap Desk ships for Claude and Codex", async () => {
  const shipped = JSON.parse(fs.readFileSync(path.join(repoRoot, "plugins", "desk", ".mcp.claude-codex.json"), "utf8")).mcpServers["desk-web"].args
  const unreadableRoot = await mkTempRoot("desk-web-noconfig-")
  const cases = [
    { execArgv: shipped, refused: null },
    { execArgv: ["-e", shipped[1] + ";"], refused: /flag -e is unqualified/u },
    { execArgv: ["--require", "x.js", ...shipped], refused: /flag --require is unqualified/u },
    { execArgv: ["--no-warnings", ...shipped], refused: /flag --no-warnings is unqualified/u },
    { execArgv: shipped, pluginRoot: unreadableRoot, refused: /flag -e is unqualified/u },
    { execArgv: [7], refused: /\(not text\) is unqualified/u },
  ]
  for (const { execArgv, pluginRoot, refused } of cases) {
    const { options, profiles } = await setup()
    makeProfile(path.join(profiles, "edge"))
    const controller = web.createController({ ...options, ...(pluginRoot ? { pluginRoot } : {}), runtimeStateReader: () => ({ execArgv, inspectorActive: false }) })
    try {
      const result = await controller.call("browser_context", { action: "open", browser: "mine" })
      if (refused) assert.match(text(result), refused)
      else assert.doesNotMatch(text(result), /AUTH_LOGGING_REFUSED/u)
    } finally { await controller.closeAll() }
  }
})

test("actual process options refuse authenticated open even when the supplied environment is clean", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  const controller = web.createController({ ...options, authDriver: native.driver })
  const original = fs.openSync
  let sourceOpens = 0
  fs.openSync = (file, ...args) => {
    if (String(file).startsWith(profiles)) sourceOpens++
    return original(file, ...args)
  }
  process.env.NODE_OPTIONS = inheritedNodeOptions || "--require fake-unqualified-preload.cjs"
  try {
    const result = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(result.isError, true)
    assert.match(text(result), /AUTH_LOGGING_REFUSED/u)
    assert.equal(sourceOpens, 0)
    assert.equal(native.calls.length, 0)
    assert.deepEqual(fs.readdirSync(tmp), [])
  } finally { fs.openSync = original; await controller.closeAll() }
})

test("actual process options changed after open refuse native work but preserve owned close", async () => {
  const { options, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  const controller = web.createController({ ...options, authDriver: native.driver })
  const opened = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(opened.isError, false, text(opened))
  const { contextId } = json(opened)
  const before = native.calls.length
  process.env.NODE_OPTIONS = "--import fake-unqualified-preload.mjs"
  try {
    const result = await controller.call("browser_command", { contextId, args: ["snapshot", "--save"] })
    assert.equal(result.isError, true)
    assert.match(text(result), /AUTH_RUNTIME_POLICY_REFUSED/u)
    assert.equal(native.calls.length, before)
  } finally { await controller.closeAll() }
  assert.ok(native.calls.some(call => call[0] === "context.close"))
})

test("authenticated debug aliases malformed runtime and driver versions refuse before launch", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  for (const [key, value] of [["PWDEBUG", "1"], ["npm_config_pwdebug", "inspect"], ["npm_package_config_pwdebug", "1"]]) {
    const native = fakeDriver()
    const controller = web.createController({ ...options, env: { ...options.env, [key]: value }, authDriver: native.driver })
    const result = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.match(text(result), /AUTH_LOGGING_REFUSED/u)
    assert.equal(native.calls.length, 0)
  }
  for (const runtime of [null, { execArgv: [], inspectorActive: "unknown" }, { execArgv: [1], inspectorActive: false }]) {
    const native = fakeDriver()
    const result = await web.createController({ ...options, authDriver: native.driver, runtimeStateReader: () => runtime })
      .call("browser_context", { action: "open", browser: "mine" })
    assert.match(text(result), /AUTH_LOGGING_REFUSED/u)
    assert.equal(native.calls.length, 0)
  }
  for (const driver of [{ version: "0", chromium: {} }, { version: web.PLAYWRIGHT_VERSION }, { version: web.PLAYWRIGHT_VERSION, chromium: {} }]) {
    const result = await web.createController({ ...options, authDriver: driver })
      .call("browser_context", { action: "open", browser: "mine" })
    assert.match(text(result), /AUTH_DRIVER_REFUSED/u)
  }
  for (const disabled of ["0", "false"]) {
    const controller = web.createController({ ...options, env: { ...options.env, PWDEBUG: disabled },
      runtimeStateReader: () => ({ execArgv: ["--test", "--test-name-pattern=synthetic"], inspectorActive: false }) })
    assert.equal((await controller.call("browser_context", { action: "open", browser: "mine" })).isError, false)
    await controller.closeAll()
  }
  assert.deepEqual(fs.readdirSync(tmp), [])
})

test("the default runtime reader reports actual process settings without changing flags", async () => {
  const { options } = await setup()
  const controller = web.createController({ ...options, runtimeStateReader: undefined })
  assert.deepEqual(controller.settings.runtimeStateReader(), {
    execArgv: process.execArgv,
    inspectorActive: Boolean(require("node:inspector").url()),
  })
})

test("managed native package loading uses only an owned synthetic versioned module", async () => {
  const { options, profiles, installDir } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const moduleDir = path.join(installDir, "node_modules", "playwright-core")
  fs.writeFileSync(path.join(moduleDir, "package.json"), JSON.stringify({ version: web.PLAYWRIGHT_VERSION, main: "index.cjs" }))
  fs.writeFileSync(path.join(moduleDir, "index.cjs"), `
    module.exports = { chromium: { launchPersistentContext: async () => ({
      pages: () => [], on: () => {}, close: async () => {}
    }) } }
  `)
  const controller = web.createController({ ...options, authDriver: undefined })
  try {
    const result = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(result.isError, false, text(result))
  } finally { await controller.closeAll() }
})

test("Local State destination and descriptor-close failures refuse an authenticated copy", async () => {
  const { root } = await setup()
  const source = path.join(root, "source")
  makeProfile(source)
  const originalWrite = fs.writeFileSync
  fs.writeFileSync = (file, ...args) => {
    if (String(file) === path.join(root, "dest-write", "Local State")) throw new Error(PASSWORD)
    return originalWrite(file, ...args)
  }
  try { assert.throws(() => web.copyProfile(source, path.join(root, "dest-write")), /COPY_DESTINATION_FAILED/u) }
  finally { fs.writeFileSync = originalWrite }
  const originalClose = fs.closeSync
  for (const readable of [true, false]) {
    const originalRead = fs.readFileSync
    fs.closeSync = fd => { originalClose(fd); throw new Error(PASSWORD) }
    if (!readable) fs.readFileSync = () => { throw new Error(PASSWORD) }
    try { assert.throws(() => web.copyProfile(source, path.join(root, `dest-close-${readable}`)), /COPY_SOURCE_POLICY/u) }
    finally { fs.closeSync = originalClose; fs.readFileSync = originalRead }
  }
})

test("an unqualified Network source directory refuses instead of returning a partial copy", async () => {
  const { root } = await setup()
  const source = path.join(root, "source")
  makeProfile(source)
  const network = path.join(source, "Profile 1", "Network")
  const original = fs.lstatSync
  fs.lstatSync = (file, ...args) => {
    const stat = original(file, ...args)
    return String(file) === network ? { isDirectory: () => false } : stat
  }
  try { assert.throws(() => web.copyProfile(source, path.join(root, "dest")), /COPY_SOURCE_POLICY/u) }
  finally { fs.lstatSync = original }
})

test("owned legacy metadata cannot grant authenticated cleanup authority or erase stale copies", async () => {
  const { options, tmp } = await setup()
  const controller = web.createController(options)
  const opened = json(await controller.call("browser_context", { action: "open" }))
  const ownerFile = path.join(tmp, `desk-browser-${opened.contextId}`, "owner.json")
  const original = fs.readFileSync(ownerFile, "utf8")
  fs.writeFileSync(ownerFile, JSON.stringify({ browser: "mine", profilePolicy: 2, transport: "auth-api", pid: process.pid }))
  try {
    assert.equal((await controller.call("browser_context", { action: "close", contextId: opened.contextId })).isError, true)
  } finally { fs.writeFileSync(ownerFile, original); await controller.closeAll() }
  const missingTmp = path.join(tmp, "absent")
  assert.equal(await web.createController({ ...options, tmpDir: missingTmp }).sweep(), undefined)
})

test("opaque non-object failures are reported without exception coercion", async () => {
  const { options } = await setup()
  for (const error of ["fake-native-text", { message: PASSWORD, code: "AUTH_SNAPSHOT_INVALIDATED", authCode: "AUTH_SNAPSHOT_INVALIDATED", plain: true }]) {
    const result = await web.createController({ ...options, exists: () => { throw error } })
      .call("browser_context", { action: "open" })
    assert.equal(result.isError, true)
    assert.deepEqual(result.structuredContent, { code: "browser_internal_failure" })
    assert.equal(text(result), "Call the browser tool again: Desk's browser hit an unexpected problem: BROWSER_INTERNAL_FAILURE.")
  }
})

test("owned native failures expose the primary wire code without losing cleanup guidance", async () => {
  const { options } = await setup()
  for (const code of ["AUTH_SNAPSHOT_INVALIDATED", "AUTH_SNAPSHOT_INVALIDATED; retained cleanup uncertainty: AUTH_CLOSE_FAILED"]) {
    const error = auth.fail(code)
    const result = await web.createController({ ...options, exists: () => { throw error } })
      .call("browser_context", { action: "open" })
    assert.equal(result.isError, true)
    assert.deepEqual(result.structuredContent, { code: "auth_snapshot_invalidated" })
    assert.equal(text(result), error.message)
  }
})

test("process-table commands and parsing are qualified through an owned fake exec callback", async () => {
  const childProcess = require("node:child_process")
  const original = childProcess.execFile
  const calls = []
  let ended = 0
  let fail = false
  childProcess.execFile = (file, args, options, callback) => {
    calls.push({ file, args, options })
    queueMicrotask(() => callback(fail ? new Error(PASSWORD) : null, "42420001 1 2026-01-01\ninvalid\n42420002 42420001 2026-01-02\r\n"))
    return { stdin: { end() { ended++ } } }
  }
  try {
    for (const [platform, env] of [["linux", {}], ["win32", {}], ["win32", { windir: "C:\\Synthetic" }], ["win32", { SystemRoot: "C:\\Owned" }]]) {
      assert.deepEqual(await web.readProcessTable(platform, env), [
        { pid: 42420001, ppid: 1, start: "2026-01-01" },
        { pid: 42420002, ppid: 42420001, start: "2026-01-02" },
      ])
    }
    fail = true
    assert.equal(await web.readProcessTable("linux", {}), null)
    assert.equal(calls[0].file, "ps")
    assert.equal(calls[1].file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    assert.ok(calls[2].file.startsWith("C:\\Synthetic\\"))
    assert.ok(calls[3].file.startsWith("C:\\Owned\\"))
    assert.equal(ended, 5)
    assert.ok(calls.every(call => call.options.windowsHide === true))
    fail = false
    const { options } = await setup()
    const controller = web.createController({ ...options, processTable: undefined })
    assert.equal((await controller.settings.processTable()).length, 2)
    assert.equal(ended, 6)
  } finally { childProcess.execFile = original }
})

test("printed synthetic process identities are recorded without a daemon or host enumeration", async () => {
  for (const table of [null, [], [{ pid: 42420001, ppid: 1, start: "2026-01-01" }]]) {
    const { options, cliDir, tmp } = await setup()
    const cli = path.join(cliDir, "cli.js")
    fs.appendFileSync(cli, '\nif (verb === "open") process.stdout.write("### Browser desk opened with pid 42420001.\\n")\n')
    const controller = web.createController({ ...options, processTable: async () => table })
    try {
      const opened = json(await controller.call("browser_context", { action: "open" }))
      const file = path.join(tmp, `desk-browser-${opened.contextId}`, "owner.json")
      const owner = JSON.parse(fs.readFileSync(file, "utf8"))
      assert.deepEqual(owner.processes, table?.length ? [{ pid: 42420001, start: "2026-01-01" }] : undefined)
      owner.processes = []
      fs.writeFileSync(file, JSON.stringify(owner))
    } finally { await controller.closeAll() }
  }
})

test("legacy cleanup uses only qualified synthetic process rows and an owned fake signal function", async () => {
  const originalKill = process.kill
  const originalNow = Date.now
  const row = { pid: 42420001, ppid: 1, start: "2026-01-01" }
  const signals = []
  process.kill = (pid, signal) => {
    assert.equal(pid, row.pid)
    assert.ok(signal === "SIGTERM" || signal === "SIGKILL")
    signals.push([pid, signal])
    throw new Error(PASSWORD)
  }
  try {
    for (const mode of ["unreadable", "gone", "exits", "stays"]) {
      const { options, tmp } = await setup()
      let reads = 0
      let clock = 0
      const controller = web.createController({ ...options, exitWaitMs: 1,
        processTable: async () => {
          reads++
          if (mode === "stays") clock += 2
          return mode === "unreadable" ? null : mode === "gone" || (mode === "exits" && reads > 1) ? [] : [row]
        } })
      const opened = json(await controller.call("browser_context", { action: "open" }))
      const file = path.join(tmp, `desk-browser-${opened.contextId}`, "owner.json")
      const owner = JSON.parse(fs.readFileSync(file, "utf8"))
      owner.processes = [{ pid: row.pid, start: row.start }]
      fs.writeFileSync(file, JSON.stringify(owner))
      let result
      Date.now = () => clock
      try { result = await controller.call("browser_context", { action: "close", contextId: opened.contextId }) }
      finally { Date.now = originalNow }
      assert.equal(result.isError, false, text(result))
      assert.equal(fs.existsSync(path.dirname(file)), false)
    }
    // A browser that will not exit is asked to stop first (it then removes its own code-sign clone) and killed only if it stays.
    assert.deepEqual(signals, [[row.pid, "SIGTERM"], [row.pid, "SIGKILL"]])
  } finally { process.kill = originalKill; Date.now = originalNow }
})

for (const firstReadMs of [0, 100]) {
test(`a close answers within its own budget when the process table never answers (#763, first read at ${firstReadMs} ms)`, async () => {
  const childProcess = require("node:child_process")
  const originalExec = childProcess.execFile
  const originalKill = process.kill
  const originalNow = Date.now
  const row = { pid: 42420002, ppid: 1, start: "2026-01-01" }
  const signals = []
  process.kill = (pid, signal) => { signals.push([pid, signal]) }
  try {
    const { options, tmp } = await setup()
    let reads = 0
    // The first read lists the browser; every later read hangs, as a PowerShell process table on a starved Windows runner can.
    const controller = web.createController({ ...options, exitWaitMs: 100, closeMs: 400, recordMs: 400,
      processTable: () => (reads++ === 0 ? Promise.resolve([row]) : new Promise(() => {})) })
    const opened = json(await controller.call("browser_context", { action: "open" }))
    const file = path.join(tmp, `desk-browser-${opened.contextId}`, "owner.json")
    const owner = JSON.parse(fs.readFileSync(file, "utf8"))
    owner.processes = [{ pid: row.pid, start: row.start }]
    fs.writeFileSync(file, JSON.stringify(owner))
    reads = 0
    let clock = 0
    childProcess.execFile = (file, args, options, callback) => {
      assert.equal(args.at(-1), "close")
      queueMicrotask(() => callback(null, "", ""))
      return { kill() { assert.fail("the synthetic close must not time out") } }
    }
    controller.settings.processTable = () => {
      // Expiring the initial exit wait permits SIGTERM; hanging while it is still active goes straight to SIGKILL.
      clock = reads === 0 ? firstReadMs : 250
      return reads++ === 0 ? Promise.resolve([row]) : new Promise(() => {})
    }
    Date.now = () => clock
    const started = originalNow()
    const result = await controller.call("browser_context", { action: "close", contextId: opened.contextId })
    assert.equal(result.isError, false, text(result))
    assert.ok(originalNow() - started < 2000, `close took ${originalNow() - started} ms`)
    assert.equal(reads, 2, "the second process-table read hangs")
    assert.equal(fs.existsSync(path.dirname(file)), false)
    assert.deepEqual(signals, [
      ...(firstReadMs === 100 ? [[row.pid, "SIGTERM"]] : []),
      [row.pid, "SIGKILL"],
    ])
  } finally {
    childProcess.execFile = originalExec
    process.kill = originalKill
    Date.now = originalNow
  }
})
}

test("an open answers within its record budget when the process table never answers (#763)", async () => {
  const { options } = await setup()
  const controller = web.createController({ ...options, recordMs: 300, processTable: () => new Promise(() => {}) })
  const started = Date.now()
  const opened = await controller.call("browser_context", { action: "open" })
  assert.equal(opened.isError, false, text(opened))
  assert.ok(Date.now() - started < 3000, `open took ${Date.now() - started} ms`)
  await controller.closeAll()
  const failing = web.createController({ ...options, processTable: () => Promise.reject(new Error("table failed")) })
  const reopened = json(await failing.call("browser_context", { action: "open" }))
  const file = path.join(options.tmpDir, `desk-browser-${reopened.contextId}`, "owner.json")
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, "utf8")), processes: [{ pid: 42420003, start: "2026-01-01" }] }))
  const closed = await failing.call("browser_context", { action: "close", contextId: reopened.contextId })
  assert.equal(closed.isError, false, text(closed))
  const spent = web.createController({ ...options, closeMs: 1, processTable: () => Promise.resolve([]) })
  const late = json(await spent.call("browser_context", { action: "open" }))
  const lateFile = path.join(options.tmpDir, `desk-browser-${late.contextId}`, "owner.json")
  fs.writeFileSync(lateFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(lateFile, "utf8")), processes: [{ pid: 42420004, start: "2026-01-01" }] }))
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await spent.call("browser_context", { action: "close", contextId: late.contextId })).isError, false)
})

test("startup keeps a fresh context whose own process is still alive", async () => {
  const { options, tmp } = await setup()
  const dir = path.join(tmp, "desk-browser-11111111-1111-4111-8111-111111111111")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ browser: "fresh", pid: process.pid }))
  const controller = web.createController(options)
  await controller.sweep()
  assert.equal(fs.existsSync(dir), true)
})

test("a partial destination write fails the authenticated copy before native launch", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  const controller = web.createController({ ...options, authDriver: native.driver })
  const original = fs.writeFileSync
  fs.writeFileSync = (file, ...args) => {
    if (String(file).includes("desk-browser-") && String(file).endsWith(path.join("Profile 1", "Preferences"))) {
      original(file, PASSWORD)
      throw new Error(PASSWORD)
    }
    return original(file, ...args)
  }
  try {
    const result = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(result.isError, true)
    assert.equal(text(result).includes(PASSWORD), false)
    assert.equal(native.calls.length, 0)
    assert.deepEqual(fs.readdirSync(tmp), [])
  } finally { fs.writeFileSync = original; await controller.closeAll() }
})

test("runtime policy is enforced after successful authenticated open while owned cleanup remains available", async () => {
  const { options, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  for (const mode of ["active", "unknown", "node-options"]) {
    let changed = false
    const env = { ...options.env }
    const native = fakeDriver()
    const controller = web.createController({
      ...options, env, authDriver: native.driver,
      runtimeStateReader: () => {
        if (changed && mode === "unknown") throw new Error(PASSWORD)
        return { execArgv: [], inspectorActive: changed && mode === "active" }
      },
    })
    const opened = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(opened.isError, false, text(opened))
    const { contextId } = json(opened)
    changed = true
    if (mode === "node-options") env.NODE_OPTIONS = "--import fake-preload.mjs"
    const before = native.calls.length
    try {
      const result = await controller.call("browser_command", { contextId, args: ["snapshot", "--save"] })
      assert.equal(result.isError, true)
      assert.equal(text(result).includes(PASSWORD), false)
      assert.equal(native.calls.length, before, "policy refusal precedes native work")
    } finally { await controller.closeAll() }
    assert.ok(native.calls.some((call) => call[0] === "context.close"))
  }
})

test("runtime changes during native launch refuse open but preserve owned cleanup", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  let active = false
  const launch = native.driver.chromium.launchPersistentContext
  native.driver.chromium.launchPersistentContext = async (...args) => {
    const context = await launch(...args)
    active = true
    return context
  }
  const controller = web.createController({
    ...options, authDriver: native.driver,
    runtimeStateReader: () => ({ execArgv: [], inspectorActive: active }),
  })
  try {
    const result = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(result.isError, true)
    assert.match(text(result), /AUTH_LOGGING_REFUSED/u)
    assert.ok(native.calls.some((call) => call[0] === "context.close"))
    assert.deepEqual(fs.readdirSync(tmp), [])
  } finally { await controller.closeAll() }
})

test("launcher never trusts native plain/message prefixes or reads their getters", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  let reads = 0
  const getter = () => { reads++; throw new Error(PASSWORD) }
  for (const error of [
    { plain: true, message: "AUTH_NATIVE: " + PASSWORD },
    Object.defineProperty({}, "plain", { get: getter }),
    Object.defineProperty({ plain: true }, "message", { get: getter }),
    new Proxy({}, { get: getter }),
  ]) {
    const native = fakeDriver({ launchError: error })
    const controller = web.createController({ ...options, authDriver: native.driver })
    try {
      const result = await controller.call("browser_context", { action: "open", browser: "mine" })
      assert.equal(result.isError, true)
      assert.equal(text(result).includes(PASSWORD), false)
      assert.match(text(result), /AUTH_OPEN_FAILED/u)
      assert.deepEqual(fs.readdirSync(tmp), [])
    } finally { await controller.closeAll() }
  }
  assert.equal(reads, 0)
})

test("unbranded outer errors are formatted without arbitrary message-property reads", async () => {
  const { options } = await setup()
  let reads = 0
  const error = Object.defineProperty({}, "message", { get() { reads++; throw new Error(PASSWORD) } })
  const controller = web.createController({ ...options, exists: () => { throw error } })
  const result = await controller.call("browser_context", { action: "open" })
  assert.equal(result.isError, true)
  assert.equal(text(result).includes(PASSWORD), false)
  assert.equal(reads, 0)
})

test("failed authenticated open cleanup preserves the original safe refusal", async () => {
  const { options, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver({ closeError: new Error(PASSWORD) })
  let active = false
  const launch = native.driver.chromium.launchPersistentContext
  native.driver.chromium.launchPersistentContext = async (...args) => {
    const context = await launch(...args)
    active = true
    return context
  }
  const controller = web.createController({
    ...options, authDriver: native.driver,
    runtimeStateReader: () => ({ execArgv: [], inspectorActive: active }),
  })
  try {
    const result = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(result.isError, true)
    assert.match(text(result), /AUTH_LOGGING_REFUSED/u)
    assert.match(text(result), /AUTH_CLEANUP_FAILED/u)
    assert.equal(text(result).includes(PASSWORD), false)
    assert.equal(Object.keys(controller.settings.contexts).length, 1, "failed cleanup remains owned")
  } finally {
    native.context.close = async () => {}
    await controller.closeAll()
  }
})

test("startup retains stale authenticated copies without native CLI attachment or scrubbing", async () => {
  const { options, tmp, calls } = await setup()
  const dead = spawnSync(process.execPath, ["-e", ""]).pid
  const dir = path.join(tmp, "desk-browser-66666666-6666-4666-8666-666666666666")
  fs.mkdirSync(dir)
  fs.writeFileSync(path.join(dir, "owner.json"), JSON.stringify({ pid: dead, browser: "mine", transport: "auth-api", profilePolicy: 2 }))
  fs.writeFileSync(path.join(dir, "config.json"), "{}")
  fs.writeFileSync(path.join(dir, "fake-retained-file"), "synthetic-retained-data")
  await web.createController(options).sweep()
  assert.equal(fs.readFileSync(path.join(dir, "fake-retained-file"), "utf8"), "synthetic-retained-data")
  assert.equal(calls().length, 0)
})

test("fresh opens in a private folder, runs page commands and deletes the folder on close", async () => {
  const { options, tmp, calls, state } = await setup()
  const controller = web.createController(options)
  const opened = await controller.call("browser_context", { action: "open" })
  assert.equal(opened.isError, false, text(opened))
  const { contextId, browser, app, files } = json(opened)
  assert.equal(browser, "fresh")
  assert.equal(app, "Microsoft Edge")
  const dir = path.join(tmp, `desk-browser-${contextId}`)
  assert.equal(files, path.join(dir, "files"))
  assert.equal(fs.statSync(files).isDirectory(), true)
  if (!NO_POSIX_MODES) assert.equal(fs.statSync(dir).mode & 0o777, 0o700)
  const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"))
  assert.equal(config.browser.launchOptions.headless, true)
  assert.equal(config.browser.launchOptions.channel, "msedge")
  assert.equal(config.browser.launchOptions.ignoreDefaultArgs, undefined)
  assert.ok(config.browser.launchOptions.args.includes("--mute-audio"), "a page an agent opens never makes a sound")
  assert.equal(config.browser.userDataDir, path.join(dir, "profile"))
  assert.equal(config.outputDir, files)
  assert.equal(fs.existsSync(path.join(state, "output")), false, "nothing is written outside the private folder")

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

test("a fresh browser's screenshot is copied to the evidence folder, which close leaves alone", async () => {
  const { options, state } = await setup()
  const controller = web.createController(options)
  const opened = json(await controller.call("browser_context", { action: "open" }))
  assert.equal(opened.evidence.startsWith(path.join(state, "evidence")), true)
  assert.match(opened.note, /screenshot is also copied to the evidence folder, which stays after close/u)
  const reply = text(await controller.call("browser_command", { contextId: opened.contextId, args: ["screenshot"] }))
  const kept = /Kept after browser_context close: (.+)$/mu.exec(reply)[1]
  assert.equal(path.dirname(kept), opened.evidence)
  assert.equal(fs.readFileSync(kept, "utf8"), "PNG")
  assert.equal((await controller.call("browser_command", { contextId: opened.contextId, args: ["snapshot"] })).content[0].text.includes("Kept after"), false)
  await controller.call("browser_context", { action: "close", contextId: opened.contextId })
  assert.equal(fs.existsSync(opened.files), false)
  assert.equal(fs.readFileSync(kept, "utf8"), "PNG", "the picture outlives the context")
})

test("a fresh screenshot that wrote no picture claims nothing was kept", async () => {
  const { options } = await setup({ mode: "no-picture" })
  const controller = web.createController(options)
  const opened = json(await controller.call("browser_context", { action: "open" }))
  assert.doesNotMatch(text(await controller.call("browser_command", { contextId: opened.contextId, args: ["screenshot"] })), /Kept after/u)
  await controller.call("browser_context", { action: "close", contextId: opened.contextId })
})

test("mine opens with an evidence folder its screenshots go to, and a later start removes only old evidence folders", async () => {
  const { options, state, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const evidence = path.join(state, "evidence")
  const old = path.join(evidence, "2026-01-01T00-00-00-000Z-1")
  const recent = path.join(evidence, "2026-11-12T00-00-00-000Z-2")
  const other = path.join(evidence, "not-ours")
  for (const folder of [old, recent, other]) fs.mkdirSync(folder, { recursive: true })
  const longAgo = new Date(Date.now() - 30 * 86400000)
  fs.utimesSync(old, longAgo, longAgo)
  fs.utimesSync(other, longAgo, longAgo)
  const controller = web.createController(options)
  await controller.sweep()
  assert.deepEqual([old, recent, other].map((folder) => fs.existsSync(folder)), [false, true, true])
  const opened = json(await controller.call("browser_context", { action: "open", browser: "mine" }))
  assert.equal(path.dirname(opened.evidence), evidence)
  assert.match(opened.note, /Screenshots are saved in the evidence folder, which stays after close\./u)
  await controller.call("browser_context", { action: "close", contextId: opened.contextId })
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
  assert.ok(launch.args.includes("--mute-audio"), "the authenticated launch path is muted too")
  assert.equal(fs.existsSync(path.join(profiles, "edge", "Profile 1", "Cache")), true, "the source profile is untouched")
  await controller.call("browser_context", { action: "close", contextId })
  assert.equal(fs.existsSync(dir), false)
})

test("commands refuse generated contexts without the password-store exclusion policy and leave them untouched", async () => {
  const { options, tmp, profiles, calls } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const controller = web.createController(options)
  const { contextId } = json(await controller.call("browser_context", { action: "open", browser: "mine" }))
  const dir = path.join(tmp, `desk-browser-${contextId}`)
  const ownerFile = path.join(dir, "owner.json")
  const originalOwner = fs.readFileSync(ownerFile, "utf8")
  const before = calls().length
  const owner = JSON.parse(originalOwner)
  delete owner.profilePolicy
  fs.writeFileSync(ownerFile, JSON.stringify(owner))
  const oldStore = path.join(dir, "profile", "Profile 1", "Login Data")
  fs.writeFileSync(oldStore, "synthetic-old-store")
  for (const metadata of [JSON.stringify(owner), "{", JSON.stringify({ ...owner, profilePolicy: 999 })]) {
    fs.writeFileSync(ownerFile, metadata)
    const result = await controller.call("browser_command", { contextId, args: ["snapshot"] })
    assert.equal(result.isError, true)
    assert.match(text(result), /password-store exclusion policy/u)
    assert.equal(fs.readFileSync(ownerFile, "utf8"), metadata, "no metadata migration")
    assert.equal(fs.readFileSync(oldStore, "utf8"), "synthetic-old-store", "no old-profile scrubbing")
  }
  assert.equal(calls().length, before, "no page command reaches the old context")
  fs.writeFileSync(ownerFile, originalOwner)
  assert.equal((await controller.call("browser_command", { contextId, args: ["snapshot"] })).isError, false)
  await controller.closeAll()
})

test("mine refuses unreadable essential cookies and may omit a nonessential locked file", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  makeProfile(path.join(profiles, "chrome"))
  fs.writeFileSync(path.join(profiles, "edge", "Profile 1", "Preferences.lock"), "x")
  const original = fs.openSync
  let locked = /(?:Cookies|Preferences\.lock)$/u
  fs.openSync = (from, ...rest) => {
    if (locked.test(from)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
    return original(from, ...rest)
  }
  try {
    const edge = web.createController(options)
    const refused = await edge.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(refused.isError, true)
    assert.match(text(refused), /COPY_SOURCE_POLICY/u)
    assert.deepEqual(fs.readdirSync(tmp), [])

    locked = /Preferences\.lock$/u
    const other = web.createController(options)
    const unlocked = json(await other.call("browser_context", { action: "open", browser: "mine" }))
    assert.equal(unlocked.signIns, undefined)
    const profile = path.join(tmp, `desk-browser-${unlocked.contextId}`, "profile", "Profile 1")
    assert.equal(fs.existsSync(path.join(profile, "Preferences.lock")), false)
    assert.equal(fs.readFileSync(path.join(profile, "Network", "Cookies"), "utf8"), "cookies")
    await other.closeAll()
  } finally {
    fs.openSync = original
  }
  for (const name of fs.readdirSync(tmp)) removeTreeSync(path.join(tmp, name))
})

test("mine passes an operating-system read block through as COPY_SOURCE_PERMISSION", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  makeProfile(path.join(profiles, "chrome"))
  const original = fs.openSync
  fs.openSync = (file, ...args) => {
    if (/Local State$/u.test(String(file))) throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })
    return original(file, ...args)
  }
  try {
    const controller = web.createController(options)
    const refused = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(refused.isError, true)
    assert.match(text(refused), /COPY_SOURCE_PERMISSION: The operating system blocked reading your (?:Microsoft Edge|Google Chrome) profile/u)
    assert.doesNotMatch(text(refused), /AUTH_OPEN_FAILED|COPY_SOURCE_POLICY/u)
    assert.deepEqual(fs.readdirSync(tmp), [])
    await controller.closeAll()
  } finally { fs.openSync = original }
})

test("mine reports source access refusals without identity fallback, data leakage or partial contexts", async () => {
  const cases = [
    ["statSync", "Local State", "EPERM"],
    ["lstatSync", "Local State", "EACCES"],
    ["lstatSync", "Profile 1", "EPERM"],
    ["lstatSync", "Profile 1/Network", "EACCES"],
    ["readdirSync", "Profile 1/Network", "EPERM"],
    ["openSync", "Profile 1/Network/Cookies", "EACCES"],
  ]
  for (const [method, relative, code] of cases) {
    const { options, profiles, tmp, calls } = await setup()
    const source = path.join(profiles, "edge")
    makeProfile(source)
    makeProfile(path.join(profiles, "chrome"))
    const target = path.join(source, relative)
    const native = fakeDriver()
    const controller = web.createController({
      ...options, authDriver: native.driver,
      exists: file => onlyEdge(file) || /(?:chrome(?:\.exe)?|Google Chrome)$/u.test(file),
    })
    const original = fs[method]
    fs[method] = (file, ...args) => {
      if (String(file) === target) throw Object.assign(new Error(`${code}: ${target} ${PASSWORD}`), { code })
      return original(file, ...args)
    }
    try {
      const refused = await controller.call("browser_context", { action: "open", browser: "mine" })
      assert.equal(refused.isError, true, `${method}: ${relative}`)
      assert.match(text(refused), /^COPY_SOURCE_PERMISSION:/u)
      assert.doesNotMatch(text(refused), /AUTH_OPEN_FAILED|COPY_SOURCE_POLICY/u)
      assert.equal(text(refused).includes(source), false)
      assert.equal(text(refused).includes(PASSWORD), false)
      assert.deepEqual(native.calls, [], "no native browser launched")
      assert.deepEqual(calls(), [], "no CLI fallback")
      assert.deepEqual(fs.readdirSync(tmp), [], "partial copy removed")
      assert.deepEqual(Object.keys(controller.settings.contexts), [], "no retained context")
    } finally {
      fs[method] = original
      await controller.closeAll()
    }
  }
})

test("mine skips a profile whose Local State is not a file, rather than treating it as denied access", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  makeProfile(path.join(profiles, "chrome"))
  const state = path.join(profiles, "edge", "Local State")
  fs.unlinkSync(state)
  fs.mkdirSync(state)
  const controller = web.createController({
    ...options,
    exists: file => onlyEdge(file) || /(?:chrome(?:\.exe)?|Google Chrome)$/u.test(file),
  })
  try {
    const opened = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.equal(opened.isError, false, text(opened))
    assert.equal(json(opened).app, "Google Chrome")
    assert.equal(fs.statSync(state).isDirectory(), true, "source left untouched")
  } finally { await controller.closeAll() }
  assert.deepEqual(fs.readdirSync(tmp), [])
})

test("source descriptor access refusals close the descriptor and erase bytes read before refusal", async () => {
  for (const method of ["readFileSync", "fstatSync", "lstatSync"]) {
    const { root } = await setup()
    const source = path.join(root, "source")
    makeProfile(source)
    const original = fs[method]
    const originalRead = fs.readFileSync
    const originalOpen = fs.openSync
    let fd
    let bytes
    let checks = 0
    fs.openSync = (...args) => { fd = originalOpen(...args); return fd }
    fs.readFileSync = (...args) => { bytes = originalRead(...args); return bytes }
    const read = fs.readFileSync
    fs[method] = (...args) => {
      checks++
      if (checks === (method === "readFileSync" ? 1 : 2)) {
        throw Object.assign(new Error(`${source} ${PASSWORD}`), { code: "EACCES" })
      }
      return method === "readFileSync" ? read(...args) : original(...args)
    }
    try {
      const dest = path.join(root, "dest")
      assert.throws(() => web.copyProfile(source, dest), /^Error: COPY_SOURCE_PERMISSION:/u)
      assert.equal(fs.existsSync(dest), false)
      if (bytes) assert.ok(bytes.every(value => value === 0), "admitted bytes erased")
      assert.throws(() => fs.fstatSync(fd), { code: "EBADF" })
    } finally {
      fs[method] = original
      fs.openSync = originalOpen
      fs.readFileSync = originalRead
    }
  }
})

test("permission refusal retains ownership and a safe primary error when partial-copy cleanup fails", async () => {
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const controller = web.createController(options)
  const originalOpen = fs.openSync
  const originalRemove = fs.rmSync
  fs.openSync = (file, ...args) => {
    if (String(file).endsWith("Cookies")) throw Object.assign(new Error(PASSWORD), { code: "EPERM" })
    return originalOpen(file, ...args)
  }
  fs.rmSync = () => { throw new Error(PASSWORD) }
  try {
    const refused = await controller.call("browser_context", { action: "open", browser: "mine" })
    assert.deepEqual(refused.structuredContent, { code: "copy_source_permission" })
    assert.match(text(refused), /^COPY_SOURCE_PERMISSION:/u)
    assert.match(text(refused), /AUTH_CLEANUP_FAILED/u)
    assert.equal(text(refused).includes(PASSWORD), false)
    assert.equal(Object.keys(controller.settings.contexts).length, 1)
    assert.equal(fs.readdirSync(tmp).length, 1)
  } finally {
    fs.openSync = originalOpen
    fs.rmSync = originalRemove
    await controller.closeAll()
  }
  assert.deepEqual(fs.readdirSync(tmp), [])
})

test("mine gives a plain message when there is no profile, or it cannot be copied", async () => {
  const { options, profiles, tmp } = await setup()
  const controller = web.createController(options)
  const none = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(none.isError, true)
  assert.deepEqual(none.structuredContent, { code: "browser_failure" })
  assert.match(text(none), /could not find your own Edge or Chrome profile/u)
  makeProfile(path.join(profiles, "edge"), { withProfile: false })
  const busy = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(busy.isError, true)
  assert.deepEqual(busy.structuredContent, { code: "auth_open_failed" })
  assert.match(text(busy), /AUTH_OPEN_FAILED/u)
  assert.deepEqual(fs.readdirSync(tmp), [], "the failed copy left no folder")
})

test("a missing browser, a failed start and bad input each give a plain message", async () => {
  const { options, tmp } = await setup({ mode: "open-fail" })
  const noBrowser = web.createController({ ...options, exists: () => false })
  assert.match(text(await noBrowser.call("browser_context", { action: "open" })), /needs Microsoft Edge or Google Chrome/u)
  const controller = web.createController(options)
  const failed = await controller.call("browser_context", { action: "open", browser: "fresh" })
  assert.equal(failed.isError, true)
  assert.deepEqual(failed.structuredContent, { code: "browser_failure" })
  assert.equal(text(failed), "The browser did not start. Try again, or use a fresh browser. Details: Browser failed\nline two")
  assert.deepEqual(fs.readdirSync(tmp), [])
  assert.match(text(await controller.call("browser_context", { action: "open", browser: "other" })), /must be "fresh" or "mine"/u)
  assert.match(text(await controller.call("browser_context", { action: "reopen" })), /action must be "open" or "close"/u)
  assert.match(text(await controller.call("browser_context", { action: "close", contextId: "nope" })), /contextId must be/u)
  const badCommand = await controller.call("browser_command", {})
  assert.deepEqual(badCommand.structuredContent, { code: "browser_failure" })
  assert.match(text(badCommand), /contextId must be/u)
  const unknown = await controller.call("browser_other")
  assert.equal(unknown.isError, true)
  assert.deepEqual(unknown.structuredContent, { code: "unknown_door" })
  assert.equal(text(unknown), "unknown tool: browser_other. Desk Browser's tools: browser_context, browser_command.")
  assert.equal(text(await controller.call("browser_open")), "unknown tool: browser_open. Desk Browser's tools: browser_context, browser_command.")
  assert.equal(text(await controller.call("browser_contxt")), "unknown tool: browser_contxt. Desk Browser's tools: browser_context, browser_command. Did you mean browser_context?")
  const gone = await controller.call("browser_context", { action: "close", contextId: "00000000-0000-4000-8000-000000000000" })
  assert.deepEqual(json(gone), { contextId: "00000000-0000-4000-8000-000000000000", closed: true })
})

test("a fresh browser's reply points out a page's web option, and says nothing on a page without one", async () => {
  const { options } = await setup({ mode: "web-option" })
  const controller = web.createController(options)
  const { contextId } = json(await controller.call("browser_context", { action: "open" }))
  const withOption = text(await controller.call("browser_command", { contextId, args: ["snapshot"] }))
  assert.match(withOption, /desk-web: this page offers a web option, the link "Join from browser" \[ref=e4\]; desk-web never opens desktop apps, so click it/u)
  assert.doesNotMatch(withOption, /Open app.*\n.*offers a web option, the button/u)
})

test("browser_command runs only page commands, refuses options that switch session or browser, and reports failures plainly", async () => {
  const { options, calls } = await setup()
  const controller = web.createController(options)
  const { contextId } = json(await controller.call("browser_context", { action: "open" }))
  const run = async (args) => text(await controller.call("browser_command", { contextId, args }))
  const before = calls().length
  for (const args of [undefined, [], [1]]) assert.match(await run(args), /args must be a list of strings/u)
  // The CLI takes the first argument that is not an option as the command, so a leading option or "--" must not let these through.
  for (const args of [["open"], ["close"], ["kill-all"], ["close-all"], ["attach"], ["list"], ["--json", "kill-all"], ["--raw", "close-all"], ["--", "kill-all"], ["--raw", "list", "--all"], ["--json", "attach", "--cdp=msedge"], ["-s=other", "snapshot"]]) {
    assert.match(await run(args), /must start with a page command/u, JSON.stringify(args))
  }
  for (const args of [["snapshot", "--session=x"], ["snapshot", "--session", "x"], ["snapshot", "--no-session"], ["goto", "--browser=chrome", "u"], ["snapshot", "--profile"],
    ["snapshot", "--config=x"], ["snapshot", "--extension"], ["snapshot", "--cdp=msedge"], ["snapshot", "--help"], ["snapshot", "--all"]]) {
    assert.match(await run(args), /is not available here; the browser is chosen/u, JSON.stringify(args))
  }
  for (const args of [["goto", "-js", "other", "u"], ["snapshot", "-s"], ["snapshot", "-h"], ["snapshot", "-v"]]) {
    assert.match(await run(args), /Short options such as -\w+ are not available here/u, JSON.stringify(args))
  }
  assert.equal(calls().length, before, "nothing refused reaches the CLI")
  assert.equal(await run(["mousewheel", "0", "-100"]), "")
  assert.equal(await run(["fill", "e1", "--", "-s", "--session=x"]), "")
  assert.equal(await run(["eval", "fail-quiet"]), "The command failed.")
  assert.equal(await run(["eval", "fail-loud"]), "boom")
  const impatient = web.createController({ ...options, commandMs: 2000 })
  const impatientId = json(await impatient.call("browser_context", { action: "open" })).contextId
  assert.match(text(await impatient.call("browser_command", { contextId: impatientId, args: ["eval", "sleep"] })), /longer than 2 seconds/u)
  await impatient.closeAll()
  await controller.closeAll()
})

test("a start that hangs past its budget says it timed out", async () => {
  const loud = await setup({ mode: "open-hang-loud" })
  const talker = web.createController({ ...loud.options, openMs: 1000 })
  assert.equal(text(await talker.call("browser_context", { action: "open", browser: "fresh" })), "The browser did not start within 1 seconds and was stopped. Try again, or use a fresh browser. Details: Waiting for the browser")
  assert.deepEqual(fs.readdirSync(loud.tmp), [])
})

// Retry timings: the first try gets 0.6 s; a second try gets at least 0.5 s, the rest of the 1 s budget.
const retryOptions = (options) => ({ ...options, openMs: 1000, firstOpenMs: 600, retryMinMs: 500 })
const openCount = (calls) => calls().filter((call) => call.args[1] === "open").length

test("a fresh start that stalls is stopped, and tried once more in a new context", async () => {
  const { options, tmp, root, calls } = await setup({ mode: "open-stall-once" })
  const controller = web.createController(retryOptions(options))
  const opened = json(await controller.call("browser_context", { action: "open", browser: "fresh" }))
  assert.equal(opened.retried, true)
  const [first, second] = calls().filter((call) => call.args[1] === "open")
  assert.notEqual(path.basename(first.cwd), path.basename(second.cwd), "the second try has its own context folder")
  assert.ok(calls().some((call) => call.args[1] === "close" && path.basename(call.cwd) === path.basename(first.cwd)), "the stalled try was closed")
  assert.equal(fs.existsSync(path.join(tmp, path.basename(first.cwd))), false, "the stalled try's folder is gone")
  assert.deepEqual(fs.readdirSync(tmp), [path.basename(second.cwd)], "only the opened context's folder is left")
  assert.deepEqual(fakesRunning(root), [])
  await controller.closeAll()
  assert.deepEqual(fs.readdirSync(tmp), [])
})

test("a fresh start stopped for stalling is not taken for opened when the CLI exits 0 on the stop", async () => {
  const { options, tmp, calls } = await setup({ mode: "open-stall-exit-zero" })
  const controller = web.createController(retryOptions(options))
  const opened = json(await controller.call("browser_context", { action: "open", browser: "fresh" }))
  assert.equal(opened.retried, true, "the stopped try is tried again, not reported as the open browser")
  assert.equal(openCount(calls), 2)
  await controller.closeAll()
  assert.deepEqual(fs.readdirSync(tmp), [])
})

test("a fresh start that stalls on both tries says so, and leaves nothing behind", async () => {
  const { options, tmp, root, calls } = await setup({ mode: "open-hang" })
  const controller = web.createController(retryOptions(options))
  const stalled = await controller.call("browser_context", { action: "open", browser: "fresh" })
  assert.equal(stalled.isError, true)
  assert.equal(text(stalled), "The browser did not start: the first try did not start within 0.6 seconds and was stopped, and the second try did not start within 0.5 seconds and was stopped. Try again, or use a fresh browser.")
  assert.equal(openCount(calls), 2)
  assert.deepEqual(fs.readdirSync(tmp), [])
  assert.deepEqual(fakesRunning(root), [])
})

test("a stalled first try and a failed second try are both reported", async () => {
  const { options, tmp, calls } = await setup({ mode: "open-stall-then-fail" })
  const controller = web.createController(retryOptions(options))
  const failed = await controller.call("browser_context", { action: "open", browser: "fresh" })
  assert.equal(failed.isError, true)
  assert.equal(text(failed), "The browser did not start: the first try did not start within 0.6 seconds and was stopped, and the second try failed. Try again, or use a fresh browser. Details: Browser failed\nline two")
  assert.equal(openCount(calls), 2)
  assert.deepEqual(fs.readdirSync(tmp), [])
})

test("a fresh start that times out while printing is tried again, and one that exits with an error is not", async () => {
  // Chrome prints warnings while it hangs (D-Bus on Linux), so output is no sign of progress (#763).
  const loud = await setup({ mode: "open-hang-loud" })
  const talker = web.createController(retryOptions(loud.options))
  assert.equal(text(await talker.call("browser_context", { action: "open", browser: "fresh" })), "The browser did not start: the first try did not start within 0.6 seconds and was stopped, and the second try did not start within 0.5 seconds and was stopped. Try again, or use a fresh browser. Details: Waiting for the browser")
  assert.equal(openCount(loud.calls), 2)
  assert.deepEqual(fs.readdirSync(loud.tmp), [])
  const failing = await setup({ mode: "open-fail" })
  const failer = web.createController(retryOptions(failing.options))
  assert.equal(text(await failer.call("browser_context", { action: "open", browser: "fresh" })), "The browser did not start. Try again, or use a fresh browser. Details: Browser failed\nline two")
  assert.equal(openCount(failing.calls), 1)
  assert.deepEqual(fs.readdirSync(failing.tmp), [])
})

test("an unexpected error is reported as such", async () => {
  const { options, root } = await setup()
  const controller = web.createController({ ...options, tmpDir: path.join(root, "missing") })
  const result = await controller.call("browser_context", { action: "open" })
  assert.equal(result.isError, true)
  assert.match(text(result), /^Call the browser tool again: Desk's browser hit an unexpected problem: /u)
})

const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

// Windows reads the table in stages, each announced on stderr with its wall-clock time, so a read that does not finish
// names the stage it reached (shell start, CIM query or JSON) and how long each took. An unreadable table fails the
// test; it is never taken for an empty one.
const WINDOWS_TABLE_SCRIPT = [
  "$ErrorActionPreference='Stop'",
  "function mark($n){[Console]::Error.WriteLine('stage '+$n+' '+[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())}",
  "mark 'shell'",
  "$rows=@(Get-CimInstance Win32_Process)",
  "mark 'cim'",
  "$json=$rows | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress",
  "mark 'json'",
  "[Console]::Out.Write($json)",
].join(";")
const tableStages = (stderr, began) => (stderr.match(/^stage \w+ \d+$/gmu) ?? []).map((line) => {
  const [, name, at] = line.split(" ")
  return `${name}+${Number(at) - began}ms`
}).join(" ")
const fixtureTableCommand = () => isWindows
  ? [web.processTableCommand("win32", process.env)[0], ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_TABLE_SCRIPT]]
  : ["ps", ["-A", "-o", "pid=", "-o", "command="]]

function readFixtureTable([file, args], timeout = 20000) {
  const began = Date.now()
  const result = spawnSync(file, args, { encoding: "utf8", timeout, windowsHide: true, maxBuffer: 16 * 1024 * 1024 })
  const stages = tableStages(result.stderr ?? "", began)
  const took = Date.now() - began
  assert.equal(result.status, 0, `fixture process table failed (${result.error?.code ?? result.signal ?? "no signal"}) after ${took}ms; stages reached: ${stages || "none"}: ${result.stderr}`)
  return { stdout: result.stdout, took, stages }
}

// A first PowerShell start on a fresh Windows runner takes 1.5 to 6.3 s, 0.1 s once warm, and is the one stage that varies
// (#1848: 27 fresh runners, whole read 2.8 to 7.9 s). Read once before any test so no assertion's read is the cold one; the read
// that follows still has to succeed, and a failure here is reported by it, not hidden.
if (isWindows && !sourceOnly) {
  try {
    const warm = readFixtureTable(fixtureTableCommand(), 60000)
    console.log(`# fixture process table warm-up: ${warm.took}ms, stages ${warm.stages}`)
  } catch (error) {
    console.log(`# fixture process table warm-up did not finish: ${error.message.split("\n")[0]}`)
  }
}

function fakeProcessTable() {
  const { stdout } = readFixtureTable(fixtureTableCommand())
  if (isWindows) {
    const rows = JSON.parse(stdout)
    return (Array.isArray(rows) ? rows : [rows]).map((row) => ({ pid: row.ProcessId, command: row.CommandLine ?? "" }))
  }
  return stdout.split(/\r?\n/u).flatMap((line) => {
    const match = /^\s*(\d+)\s+(.*)$/u.exec(line)
    return match ? [{ pid: Number(match[1]), command: match[2] }] : []
  })
}

test("a fixture process table that does not finish fails and names the stage it reached", () => {
  const stalls = [process.execPath, ["-e", "console.error('stage shell ' + Date.now()); setInterval(() => {}, 1000)"]]
  assert.throws(() => readFixtureTable(stalls, 1000), /fixture process table failed \(ETIMEDOUT\) after \d+ms; stages reached: shell\+\d+ms:/u)
  assert.throws(() => readFixtureTable([process.execPath, ["-e", "process.exit(3)"]]), /fixture process table failed \(no signal\) after \d+ms; stages reached: none:/u)
})

// The log's PIDs can be reused; only this fixture's unique script paths identify its fakes.
const fakesRunning = (root, table = fakeProcessTable()) => {
  const log = path.join(root, "daemons.log")
  const pids = new Set(fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\s+/u).filter(Boolean).map(Number) : [])
  const scripts = ["fake-daemon.js", "fake-browser.js"].map((file) => path.join(root, file))
  return table.filter((row) => pids.has(row.pid) && scripts.some((script) => row.command.includes(script))).map((row) => row.pid)
}

test("a reused fixture PID does not identify another process as a fake browser", async () => {
  const root = await mkTempRoot("desk-web-reused-pid-")
  fs.writeFileSync(path.join(root, "daemons.log"), "42420003 42420004\n")
  assert.deepEqual(fakesRunning(root, [
    { pid: 42420003, command: "node unrelated.js" },
    { pid: 42420004, command: `node "${path.join(root, "fake-browser.js")}"` },
    { pid: 42420005, command: `node "${path.join(root, "fake-daemon.js")}"` },
  ]), [42420004])
})

// A test that starts fake daemons stops any that are left, so a leak fails the test instead of keeping the runner alive.
const stopFakes = (t, root) => t.after(() => {
  for (const pid of fakesRunning(root)) {
    try {
      process.kill(pid)
    } catch {
      // Already gone.
    }
  }
})

const recorded = (tmp, contextId) => JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${contextId}`, "owner.json"), "utf8")).processes ?? []

test("close ends the browser and the CLI daemon the context started, even when the CLI's close leaves them running", { timeout: 180000, skip: sourceOnly }, async (t) => {
  const { options, tmp, root } = await setup({ mode: "daemon-leak" })
  stopFakes(t, root)
  const controller = web.createController({ ...options, exitWaitMs: 500 })
  const first = json(await controller.call("browser_context", { action: "open" })).contextId
  const second = json(await controller.call("browser_context", { action: "open" })).contextId
  const { daemon, browser } = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${first}`, "daemon.json"), "utf8"))
  const others = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${second}`, "daemon.json"), "utf8"))
  // Windows adds the console host the fake browser gets, so the record holds at least these two.
  const firstPids = recorded(tmp, first).map((entry) => entry.pid)
  assert.ok(firstPids.includes(daemon) && firstPids.includes(browser), JSON.stringify(firstPids))
  assert.ok(recorded(tmp, first).every((entry) => typeof entry.start === "string" && entry.start.length > 0))

  assert.deepEqual(json(await controller.call("browser_context", { action: "close", contextId: first })), { contextId: first, closed: true })
  assert.deepEqual([running(daemon), running(browser)], [false, false])
  assert.deepEqual([running(others.daemon), running(others.browser)], [true, true], "another context's processes are left alone")

  // Server exit closes the rest the same way.
  await controller.closeAll()
  assert.deepEqual([running(others.daemon), running(others.browser)], [false, false])
  assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${second}`)), false)
  assert.deepEqual(fakesRunning(root), [])
})

test("close kills nothing when the CLI's close already ended the browser, and copes with an unreadable process table", { timeout: 180000, skip: sourceOnly }, async (t) => {
  const { options, tmp, root } = await setup({ mode: "daemon" })
  stopFakes(t, root)
  let reads = 0
  const realTable = () => web.readProcessTable(process.platform, process.env)
  const controller = web.createController({ ...options, exitWaitMs: 500, processTable: () => (reads++ === 0 ? realTable() : null) })
  const blind = json(await controller.call("browser_context", { action: "open" })).contextId
  const { daemon, browser } = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${blind}`, "daemon.json"), "utf8"))
  assert.ok(recorded(tmp, blind).length >= 2)
  assert.deepEqual(json(await controller.call("browser_context", { action: "close", contextId: blind })), { contextId: blind, closed: true })
  assert.deepEqual([running(daemon), running(browser)], [false, false])

  const seeing = web.createController({ ...options, exitWaitMs: 500 })
  const id = json(await seeing.call("browser_context", { action: "open" })).contextId
  const seen = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${id}`, "daemon.json"), "utf8"))
  await seeing.call("browser_context", { action: "close", contextId: id })
  assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${id}`)), false)
  assert.deepEqual([running(seen.daemon), running(seen.browser)], [false, false])

  const unreadable = web.createController({ ...options, processTable: () => null })
  const lost = json(await unreadable.call("browser_context", { action: "open" })).contextId
  assert.deepEqual(recorded(tmp, lost), [], "with no process table nothing is recorded")
  const pids = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${lost}`, "daemon.json"), "utf8"))
  await unreadable.call("browser_context", { action: "close", contextId: lost })
  assert.deepEqual([running(pids.daemon), running(pids.browser)], [false, false])
  assert.deepEqual(fakesRunning(root), [])
})

test("a process table that is unreadable on the first read is read again, so the daemon and browser are still recorded", { timeout: 180000, skip: sourceOnly }, async (t) => {
  const { options, tmp, root } = await setup({ mode: "daemon-leak" })
  stopFakes(t, root)
  let reads = 0
  const controller = web.createController({ ...options, exitWaitMs: 500, processTable: () => (reads++ === 0 ? null : web.readProcessTable(process.platform, process.env)) })
  const id = json(await controller.call("browser_context", { action: "open" })).contextId
  assert.ok(reads >= 2, "the table was read again")
  const { daemon, browser } = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${id}`, "daemon.json"), "utf8"))
  const pids = recorded(tmp, id).map((entry) => entry.pid)
  assert.ok(pids.includes(daemon) && pids.includes(browser), JSON.stringify(pids))
  assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${id}`, "owner.json"), "utf8")).processesUnknown, undefined)

  assert.deepEqual(json(await controller.call("browser_context", { action: "close", contextId: id })), { contextId: id, closed: true })
  assert.deepEqual([running(daemon), running(browser)], [false, false])
  assert.deepEqual(fakesRunning(root), [])
})

test("a context whose process table never lists its daemon is marked processesUnknown, and close says so", { timeout: 180000, skip: sourceOnly }, async (t) => {
  const { options, tmp, root } = await setup({ mode: "daemon" })
  stopFakes(t, root)
  const controller = web.createController({ ...options, exitWaitMs: 500, processTable: () => null })
  const id = json(await controller.call("browser_context", { action: "open" })).contextId
  const owner = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${id}`, "owner.json"), "utf8"))
  assert.equal(owner.processesUnknown, true)
  assert.deepEqual(recorded(tmp, id), [])

  const closed = json(await controller.call("browser_context", { action: "close", contextId: id }))
  assert.deepEqual(Object.keys(closed).sort(), ["closed", "contextId", "hint", "processesUnknown"])
  assert.equal(closed.processesUnknown, true)
  assert.match(closed.hint, /did not list them, so a browser it opened may still be running/u)
  assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${id}`)), false)
})

test("a daemon that failed to start is ended, and a PID that is already gone records nothing", { timeout: 180000, skip: sourceOnly }, async (t) => {
  const failed = await setup({ mode: "daemon-open-fail" })
  stopFakes(t, failed.root)
  const controller = web.createController({ ...failed.options, exitWaitMs: 500 })
  const result = await controller.call("browser_context", { action: "open" })
  assert.match(text(result), /The browser did not start.*Daemon pid=\d+/su)
  const record = fs.readdirSync(failed.tmp)
  assert.deepEqual(record, [], "the failed context's folder is gone")
  assert.deepEqual(fakesRunning(failed.root), [], "the failed context's daemon and browser are gone")
  const ghost = await setup({ mode: "ghost" })
  const opened = json(await web.createController(ghost.options).call("browser_context", { action: "open" }))
  assert.deepEqual(recorded(ghost.tmp, opened.contextId), [])
})

test("the process table is read with ps, or with PowerShell from the Windows folder, and an unreadable one is null", { timeout: 120000, skip: sourceOnly }, async (t) => {
  assert.deepEqual(web.processTableCommand("darwin", {}), ["ps", ["-A", "-o", "pid=", "-o", "ppid=", "-o", "lstart="]])
  assert.equal(web.processTableCommand("win32", { SystemRoot: "D:\\Win" })[0], "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  assert.equal(web.processTableCommand("win32", { windir: "E:\\W" })[0], "E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  assert.equal(web.processTableCommand("win32", {})[0], "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  assert.match(web.processTableCommand("win32", {})[1].at(-1), /Win32_Process.*ProcessId.*ParentProcessId.*ToFileTimeUtc/u)
  assert.deepEqual(web.parseProcessTable("  12   1 Sun Oct 25 16:28:30 2026\r\nnoise\n\n40 12 133000000000000000\n"), [
    { pid: 12, ppid: 1, start: "Sun Oct 25 16:28:30 2026" }, { pid: 40, ppid: 12, start: "133000000000000000" },
  ])
  assert.equal(await web.readProcessTable("win32", { SystemRoot: path.join(os.tmpdir(), "desk-no-windows-here") }), null)
  const begun = Date.now()
  const table = await web.readProcessTable(process.platform, process.env)
  t.diagnostic(`process table: ${table?.length} processes in ${Date.now() - begun} ms`)
  assert.ok(table.some((row) => row.pid === process.pid && row.ppid === process.ppid))
})

test("a process counts as a child only if it started no earlier than its parent, since Windows reuses a dead parent's PID", () => {
  const dates = [{ pid: 10, ppid: 1, start: "Sun Oct 25 16:00:00 2026" }, { pid: 11, ppid: 10, start: "Sun Oct 25 16:00:05 2026" },
    { pid: 12, ppid: 10, start: "Sun Oct 25 15:00:00 2026" }, { pid: 13, ppid: 11, start: "Sun Oct 25 16:01:00 2026" }]
  assert.deepEqual(web.liveTree(dates, [{ pid: 10, start: "Sun Oct 25 16:00:00 2026" }]).map((entry) => entry.pid), [10, 11, 13])
  assert.deepEqual(web.liveTree(dates, [{ pid: 10, start: "Sun Oct 25 15:59:59 2026" }]), [], "a reused PID is not the recorded process")
  const filetimes = [{ pid: 20, ppid: 4, start: "134062272000000000" }, { pid: 21, ppid: 20, start: "134062272010000000" }, { pid: 22, ppid: 20, start: "134062271990000000" }]
  assert.deepEqual(web.liveTree(filetimes, [{ pid: 20, start: "134062272000000000" }]).map((entry) => entry.pid), [20, 21])
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
    assert.match(text(locked), /BROWSER_INTERNAL_FAILURE/u)
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
    const { options, state } = await setup({ cli: false, npmMode })
    const result = await web.createController(options).call("browser_context", { action: "open" })
    assert.equal(result.isError, true, npmMode)
    assert.match(text(result), expected, npmMode)
    assert.deepEqual(fs.readdirSync(state).filter((name) => name.startsWith("install-")), [], "a failed install leaves no staging folder")
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
  const stale = make("11111111-1111-4111-8111-111111111111", JSON.stringify({ pid: dead, browser: "fresh" }))
  const staleNoConfig = make("44444444-4444-4444-8444-444444444444", JSON.stringify({ pid: dead, browser: "fresh" }), false)
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
  fs.writeFileSync(path.join(leftover, "owner.json"), JSON.stringify({ pid: dead, browser: "fresh" }))
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

test("the MCP transport preserves safe error codes and rejects spoofed exception fields", async (t) => {
  const { options } = await setup()
  let failure = auth.fail("AUTH_SNAPSHOT_INVALIDATED; retained cleanup uncertainty: AUTH_CLOSE_FAILED")
  const s = server({ ...options, exists: () => { throw failure } })
  try {
    const native = await s.request("tools/call", { name: "browser_context", arguments: { action: "open" } })
    assert.equal(native.result.isError, true)
    assert.deepEqual(native.result.structuredContent, { code: "auth_snapshot_invalidated" })
    assert.equal(native.result.content[0].text, failure.message)
    const legacy = await s.request("tools/call", { name: "browser_command", arguments: {} })
    assert.equal(legacy.result.isError, true)
    assert.deepEqual(legacy.result.structuredContent, { code: "browser_failure" })
    failure = { message: PASSWORD, code: "AUTH_SNAPSHOT_INVALIDATED", plain: true }
    const opaque = await s.request("tools/call", { name: "browser_context", arguments: { action: "open" } })
    assert.deepEqual(opaque.result.structuredContent, { code: "browser_internal_failure" })
    assert.equal(opaque.result.content[0].text.includes(PASSWORD), false)
    t.diagnostic("Synthetic-data MCP wire replies: " + JSON.stringify([native, legacy, opaque]))
  } finally {
    s.stdin.end()
    await s.done
  }
})

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
  removeTreeSync(path.join(tmp, `desk-browser-${contextId}`))
})

// ---- real browsers ----

const real = !sourceOnly && process.env.DESK_BROWSER_REAL === "1" ? false : "real browser qualification is not part of source-only tests"

// The context's recorded processes: the CLI daemon and the browser it started, at least.
async function realProcesses(tmp, contextId) {
  const processes = recorded(tmp, contextId)
  assert.ok(processes.length >= 2, `the daemon and its browser are recorded: ${JSON.stringify(processes)}`)
  return processes
}

async function stillRunning(processes) {
  const table = await web.readProcessTable(process.platform, process.env)
  return processes.filter((entry) => table.some((row) => row.pid === entry.pid && row.start === entry.start))
}

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

test("real: fresh goto opens a file: fixture and snapshot reads it", { skip: real, timeout: 300000 }, async () => {
  const { root, tmp, env, page } = await realSetup()
  const fixture = path.join(root, "fixture.html")
  fs.writeFileSync(fixture, "<title>File fixture</title><button>Local press</button>")
  const controller = web.createController({ env, tmpDir: tmp })
  try {
    const { contextId } = json(await controller.call("browser_context", { action: "open", browser: "fresh" }))
    const goto = await controller.call("browser_command", { contextId, args: ["goto", pathToFileURL(fixture).href] })
    assert.equal(goto.isError, false, text(goto))
    const snapshot = await controller.call("browser_command", { contextId, args: ["snapshot"] })
    assert.match(text(snapshot), /button "Local press" \[ref=e\d+\]/u)
    await controller.call("browser_context", { action: "close", contextId })
  } finally {
    await controller.closeAll()
    page.closeAllConnections()
    page.close()
  }
})

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
    const processes = await realProcesses(tmp, contextId)
    await controller.call("browser_context", { action: "close", contextId })
    assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${contextId}`)), false)
    assert.deepEqual(await stillRunning(processes), [], "the daemon and the browser are gone after close")

    // Server exit ends a context's processes too.
    const second = json(await controller.call("browser_context", { action: "open", browser: "fresh" })).contextId
    const secondProcesses = await realProcesses(tmp, second)
    await controller.closeAll()
    assert.deepEqual(await stillRunning(secondProcesses), [], "closeAll ends the daemon and the browser")
  } finally {
    await controller.closeAll()
    page.closeAllConnections()
    page.close()
  }
})

test("a browser nobody has used for the idle time is closed, and the next command reopens it on the page it was on", async () => {
  const { options, calls } = await setup()
  const controller = web.createController({ ...options, idleMs: 0 })
  const opened = JSON.parse(text(await controller.call("browser_context", { action: "open" })))
  const contextId = opened.contextId
  const record = controller.settings.contexts[contextId]
  controller.settings.idleMs = 60000
  await controller.releaseIdle()
  assert.ok(controller.settings.contexts[contextId], "a browser just used stays open")
  const went = await controller.call("browser_command", { contextId, args: ["goto", "https://example.test/page"] })
  assert.equal(went.isError, false, text(went))
  record.lastUsed = Date.now() - 120000
  record.busy = 1
  await controller.releaseIdle()
  assert.ok(controller.settings.contexts[contextId], "a browser with a command running stays open")
  record.busy = 0
  await controller.releaseIdle()
  assert.equal(controller.settings.contexts[contextId], undefined, "an idle browser is closed")
  const before = calls().length
  const after = await controller.call("browser_command", { contextId, args: ["snapshot"] })
  assert.equal(after.isError, false, text(after))
  assert.match(after.content.at(-1).text, /reopened this browser.*1 minutes unused.*went back to https:\/\/example\.test\/page/u)
  const reopened = calls().slice(before).map((call) => JSON.stringify(call))
  assert.ok(reopened.some((call) => call.includes("https://example.test/page")), "it went back to the last page")
  assert.equal(Object.keys(controller.settings.contexts).length, 1, "one browser is open again")
  const plain = await controller.call("browser_command", { contextId, args: ["snapshot"] })
  assert.equal(plain.content.length, 1, "the note is only on the call that reopened it")
  const closed = await controller.call("browser_context", { action: "close", contextId })
  assert.equal(closed.isError, false, text(closed))
  assert.equal(Object.keys(controller.settings.contexts).length, 0)
})

test("a browser that cannot be reopened after an idle close says why, and the next command tries again", async () => {
  const { options } = await setup()
  const controller = web.createController({ ...options, idleMs: 60000 })
  const { contextId } = JSON.parse(text(await controller.call("browser_context", { action: "open" })))
  controller.settings.contexts[contextId].lastUsed = Date.now() - 120000
  await controller.releaseIdle()
  options.env.FAKE_CLI_MODE = "open-fail"
  const failed = await controller.call("browser_command", { contextId, args: ["snapshot"] })
  assert.equal(failed.isError, true)
  options.env.FAKE_CLI_MODE = ""
  const again = await controller.call("browser_command", { contextId, args: ["snapshot"] })
  assert.equal(again.isError, false, text(again))
  assert.match(again.content.at(-1).text, /reopened this browser/u)
  await controller.closeAll()
})

test("the idle time reads DESK_WEB_IDLE_MS, and an unreadable value keeps the default", async () => {
  const { options } = await setup()
  assert.equal(web.createController({ ...options, idleMs: "abc" }).settings.idleMs, 300000)
  assert.equal(web.createController({ ...options, idleMs: "" }).settings.idleMs, 300000)
  assert.equal(web.createController({ ...options, idleMs: "0" }).settings.idleMs, 0)
})

test("commands sent together to an idle-closed browser reopen it once, and closing an idle-closed browser just forgets it", async () => {
  const { options, calls } = await setup()
  const controller = web.createController({ ...options, idleMs: 60000 })
  const { contextId } = JSON.parse(text(await controller.call("browser_context", { action: "open" })))
  controller.settings.contexts[contextId].lastUsed = Date.now() - 120000
  await controller.releaseIdle()
  const opens = () => calls().filter((call) => JSON.stringify(call).includes("open")).length
  const before = opens()
  const [one, two] = await Promise.all([1, 2].map(() => controller.call("browser_command", { contextId, args: ["snapshot"] })))
  assert.equal(one.isError, false, text(one))
  assert.equal(two.isError, false, text(two))
  assert.equal(opens() - before, 1, "one reopen served both")
  controller.settings.contexts[controller.settings.aliases[contextId]].lastUsed = Date.now() - 120000
  await controller.releaseIdle()
  const closed = await controller.call("browser_context", { action: "close", contextId })
  assert.equal(closed.isError, false, text(closed))
  assert.deepEqual(Object.keys(controller.settings.idleClosed), [], "nothing is left to reopen")
})

test("a mine browser is closed when idle, and one still opening is left alone", async () => {
  const { options, profiles } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  const controller = web.createController({ ...options, authDriver: native.driver, idleMs: 60000 })
  const { contextId } = JSON.parse(text(await controller.call("browser_context", { action: "open", browser: "mine" })))
  const record = controller.settings.contexts[contextId]
  record.lastUsed = Date.now() - 120000
  const adapter = record.adapter
  record.adapter = undefined
  await controller.releaseIdle()
  assert.ok(controller.settings.contexts[contextId], "a mine browser without its handle yet is left alone")
  record.adapter = { close: () => Promise.reject(new Error("stuck")) }
  await controller.releaseIdle()
  assert.ok(controller.settings.contexts[contextId], "a browser that will not close stays, to be tried again")
  record.adapter = adapter
  await controller.releaseIdle()
  assert.equal(controller.settings.contexts[contextId], undefined)
  assert.equal(native.calls.filter((call) => call[0] === "context.close").length, 1)
})

test("a fresh browser still being started is left alone by the idle release", async () => {
  const { options } = await setup()
  const controller = web.createController({ ...options, idleMs: 60000 })
  const { contextId } = JSON.parse(text(await controller.call("browser_context", { action: "open" })))
  const record = controller.settings.contexts[contextId]
  record.lastUsed = Date.now() - 120000
  const owner = path.join(options.tmpDir, `desk-browser-${contextId}`, "owner.json")
  fs.renameSync(owner, `${owner}.hold`)
  await controller.releaseIdle()
  assert.ok(controller.settings.contexts[contextId], "no owner file yet means it is still opening")
  fs.renameSync(`${owner}.hold`, owner)
  await controller.closeAll()
})

test("a reopened browser still answers when it cannot go back to the last page", async () => {
  const { options } = await setup()
  const controller = web.createController({ ...options, idleMs: 60000 })
  const { contextId } = JSON.parse(text(await controller.call("browser_context", { action: "open" })))
  controller.settings.contexts[contextId].lastUsed = Date.now() - 120000
  await controller.releaseIdle()
  controller.settings.idleClosed[contextId].url = "--help"
  const reply = await controller.call("browser_command", { contextId, args: ["snapshot"] })
  assert.equal(reply.isError, false, text(reply))
  await controller.closeAll()
})
