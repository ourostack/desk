// Desk's browser (plugins/desk/mcp/web.cjs): fresh or mine, through the Playwright CLI.
// Most tests drive a fake CLI and a fake npm placed where the real ones go, so they run everywhere without a browser.
// With DESK_BROWSER_REAL=1 the last tests install the real playwright-core and drive a real Edge or Chrome.
import { afterEach, beforeEach, test } from "node:test"
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
import { different } from "../_file_identity.js"
import { NO_POSIX_MODES, isWindows } from "../_platform.js"
import { fakeDriver, PASSWORD } from "./_auth_fixtures.js"

const require = createRequire(import.meta.url)
const repoRoot = path.resolve(fileURLToPath(new URL("../../../../..", import.meta.url)))
const webFile = path.join(repoRoot, "plugins", "desk", "mcp", "web.cjs")
const web = require(webFile)
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
if (verb === "snapshot") process.stdout.write("- generic [ref=e1]\\n")
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
const browser = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true })
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
  const installDir = path.join(state, `playwright-core-${web.PLAYWRIGHT_VERSION}`)
  const cliDir = path.join(installDir, "node_modules", "playwright-core", "lib", "tools", "cli-client")
  if (cli) {
    fs.mkdirSync(cliDir, { recursive: true })
    fs.copyFileSync(cliSource, path.join(cliDir, "cli.js"))
  }
  const profiles = path.join(root, "profiles")
  const env = { ...process.env, DESK_BROWSER_STATE_DIR: state, FAKE_CLI_MODE: mode, FAKE_CLI_SOURCE: cliSource, FAKE_DAEMON_SOURCE: daemonSource, FAKE_DAEMON_LOG: path.join(root, "daemons.log"), FAKE_NPM_MODE: npmMode ?? "ok", FAKE_FINAL: installDir }
  const options = {
    env, tmpDir: tmp, npmCli: npm, exists: onlyEdge, platform: platform ?? process.platform,
    authDriver: fakeDriver().driver,
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
      assert.throws(() => web.copyProfile(source, dest, "Microsoft Edge"), (error) => {
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

test("copyProfile names Full Disk Access on macOS and folder permission elsewhere", async () => {
  const { root } = await setup()
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  const original = fs.openSync
  fs.openSync = (file, ...args) => {
    if (/Local State$/u.test(String(file))) throw Object.assign(new Error("EPERM"), { code: "EPERM" })
    return original(file, ...args)
  }
  try {
    for (const [os, fix] of [["darwin", /\(macOS privacy protection\)\. Give the app running this agent Full Disk Access/u], ["linux", /profile\. Give the app running this agent permission to read that profile folder/u]]) {
      Object.defineProperty(process, "platform", { ...platform, value: os })
      const source = path.join(root, `os-${os}`)
      makeProfile(source)
      assert.throws(() => web.copyProfile(source, path.join(root, `os-${os}-copy`), "Microsoft Edge"), fix)
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

test("mine refuses arbitrary eval and emits owned redacted text JSON and artifacts", async () => {
  const { options, profiles, calls } = await setup()
  makeProfile(path.join(profiles, "edge"))
  const native = fakeDriver()
  const controller = web.createController({ ...options, authDriver: native.driver })
  const opened = json(await controller.call("browser_context", { action: "open", browser: "mine" }))
  try {
    const denied = await controller.call("browser_command", { contextId: opened.contextId, args: ["eval", "() => document.querySelector('input').value"] })
    assert.equal(denied.isError, true)
    const snapshot = await controller.call("browser_command", { contextId: opened.contextId, args: ["snapshot", "--save"] })
    assert.equal(snapshot.isError, false, text(snapshot))
    assert.ok(text(snapshot).includes("[redacted]"))
    assert.equal(text(snapshot).includes(PASSWORD), false)
    const result = json(snapshot)
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
      pages: () => [], close: async () => {}
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
  const result = await web.createController({ ...options, exists: () => { throw "fake-native-text" } })
    .call("browser_context", { action: "open" })
  assert.match(text(result), /BROWSER_INTERNAL_FAILURE/u)
  assert.equal(text(result).includes("fake-native-text"), false)
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
    assert.equal(signal, "SIGKILL")
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
          if (mode === "stays") clock = 2
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
    assert.deepEqual(signals, [[row.pid, "SIGKILL"]])
  } finally { process.kill = originalKill; Date.now = originalNow }
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
  for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true })
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

test("mine gives a plain message when there is no profile, or it cannot be copied", async () => {
  const { options, profiles, tmp } = await setup()
  const controller = web.createController(options)
  const none = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(none.isError, true)
  assert.match(text(none), /could not find your own Edge or Chrome profile/u)
  makeProfile(path.join(profiles, "edge"), { withProfile: false })
  const busy = await controller.call("browser_context", { action: "open", browser: "mine" })
  assert.equal(busy.isError, true)
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

test("browser_command runs only page commands, refuses options that switch session or browser, and reports failures plainly", async () => {
  const { options, calls } = await setup()
  const controller = web.createController(options)
  const { contextId } = json(await controller.call("browser_context", { action: "open" }))
  const run = async (args) => text(await controller.call("browser_command", { contextId, args }))
  const before = calls().length
  for (const args of [undefined, [], [1]]) assert.match(await run(args), /args must be a list of strings/u)
  // The CLI takes the first argument that is not an option as the command, so a leading option or "--" must not let these through.
  for (const args of [["open"], ["close"], ["kill-all"], ["close-all"], ["attach"], ["list"], ["run-code", "async page => 1"], ["state-save"], ["cookie-list"],
    ["--json", "kill-all"], ["--raw", "close-all"], ["--", "kill-all"], ["--raw", "list", "--all"], ["--json", "attach", "--cdp=msedge"], ["-s=other", "snapshot"]]) {
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

test("an unexpected error is reported as such", async () => {
  const { options, root } = await setup()
  const controller = web.createController({ ...options, tmpDir: path.join(root, "missing") })
  const result = await controller.call("browser_context", { action: "open" })
  assert.equal(result.isError, true)
  assert.match(text(result), /^Desk's browser hit an unexpected problem: /u)
})

const running = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error.code !== "ESRCH"
  }
}

// Every fake daemon and browser a setup started that is still running.
const fakesRunning = (root) => {
  const log = path.join(root, "daemons.log")
  return (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split(/\s+/u).filter(Boolean).map(Number) : []).filter(running)
}

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
