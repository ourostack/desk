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

// ---- the controller with a fake CLI ----

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

test("mine skips files the running browser holds locked, and says when the cookies stayed behind", async () => {
  const chromeExe = isWindows ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" : "/opt/google/chrome/chrome"
  const onlyChrome = (file) => file === chromeExe || file.endsWith(path.join("Google Chrome.app", "Contents", "MacOS", "Google Chrome")) || /Google[\\/]Chrome[\\/]Application[\\/]chrome\.exe$/u.test(file)
  const { options, profiles, tmp } = await setup()
  makeProfile(path.join(profiles, "edge"))
  makeProfile(path.join(profiles, "chrome"))
  fs.writeFileSync(path.join(profiles, "edge", "Profile 1", "Preferences.lock"), "x")
  const original = fs.copyFileSync
  let locked = /(?:Cookies|Preferences\.lock)$/u
  fs.copyFileSync = (from, ...rest) => {
    if (locked.test(from)) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" })
    return original(from, ...rest)
  }
  try {
    const edge = web.createController(options)
    const opened = json(await edge.call("browser_context", { action: "open", browser: "mine" }))
    assert.equal(opened.signIns, "Edge is open, so only your Microsoft work sign-in carries over; close Edge to use all your sign-ins.")
    const profile = path.join(tmp, `desk-browser-${opened.contextId}`, "profile", "Profile 1")
    assert.equal(fs.existsSync(path.join(profile, "Network", "Cookies")), false)
    assert.equal(fs.existsSync(path.join(profile, "Preferences")), true)
    await edge.closeAll()

    const chrome = json(await web.createController({ ...options, exists: onlyChrome }).call("browser_context", { action: "open", browser: "mine" }))
    assert.equal(chrome.app, "Google Chrome")
    assert.equal(chrome.signIns, "Chrome is open, so some of your sign-ins did not carry over; close Chrome to use all your sign-ins.")

    locked = /Preferences\.lock$/u
    const other = web.createController(options)
    const unlocked = json(await other.call("browser_context", { action: "open", browser: "mine" }))
    assert.equal(unlocked.signIns, undefined, "only a missing cookie file changes the result")
    await other.closeAll()
  } finally {
    fs.copyFileSync = original
  }
  for (const name of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, name), { recursive: true, force: true })
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
  assert.match(text(await impatient.call("browser_command", { contextId, args: ["eval", "sleep"] })), /longer than 2 seconds/u)
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

test("close ends the browser and the CLI daemon the context started, even when the CLI's close leaves them running", { timeout: 180000 }, async (t) => {
  const { options, tmp, root } = await setup({ mode: "daemon-leak" })
  stopFakes(t, root)
  const controller = web.createController({ ...options, exitWaitMs: 500 })
  const first = json(await controller.call("browser_context", { action: "open" })).contextId
  const second = json(await controller.call("browser_context", { action: "open" })).contextId
  const { daemon, browser } = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${first}`, "daemon.json"), "utf8"))
  const others = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${second}`, "daemon.json"), "utf8"))
  assert.deepEqual(recorded(tmp, first).map((entry) => entry.pid).sort(), [daemon, browser].sort())
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

test("close kills nothing when the CLI's close already ended the browser, and copes with an unreadable process table", { timeout: 180000 }, async (t) => {
  const { options, tmp, root } = await setup({ mode: "daemon" })
  stopFakes(t, root)
  let reads = 0
  const realTable = () => web.readProcessTable(process.platform, process.env)
  const controller = web.createController({ ...options, exitWaitMs: 500, processTable: () => (reads++ === 0 ? realTable() : null) })
  const blind = json(await controller.call("browser_context", { action: "open" })).contextId
  const { daemon, browser } = JSON.parse(fs.readFileSync(path.join(tmp, `desk-browser-${blind}`, "daemon.json"), "utf8"))
  assert.equal(recorded(tmp, blind).length, 2)
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

test("a daemon that failed to start is ended, and a PID that is already gone records nothing", { timeout: 180000 }, async (t) => {
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

test("the process table is read with ps, or with PowerShell from the Windows folder, and an unreadable one is null", { timeout: 120000 }, async (t) => {
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
    const processes = await realProcesses(tmp, contextId)
    await mine.call("browser_context", { action: "close", contextId })
    assert.equal(fs.existsSync(path.join(tmp, `desk-browser-${contextId}`)), false)
    assert.deepEqual(await stillRunning(processes), [], "the daemon and the browser on the copied profile are gone after close")

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
// TEMPORARY diagnostic for a Windows CI run that does not exit after the last test: what keeps this process alive, and which processes started recently.
test("zz diagnostic: report live handles a little after the last test", () => {
  const report = (label) => {
    const handles = process._getActiveHandles().map((h) => `${h.constructor?.name}${h.pid ? ` pid=${h.pid}` : ""}${h.spawnfile ? ` ${h.spawnfile}` : ""}${h.spawnargs ? ` ${JSON.stringify(h.spawnargs).slice(0, 300)}` : ""}`)
    process.stderr.write(`[web.test diagnostic ${label}] pid ${process.pid} resources ${JSON.stringify(process.getActiveResourcesInfo())} handles ${JSON.stringify(handles)}\n`)
    if (process.platform === "win32") {
      const listed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -like 'msedge*' -or $_.Name -like 'chrome*' } | ForEach-Object { '{0} {1} {2} {3}' -f $_.ProcessId, $_.ParentProcessId, $_.Name, $_.CommandLine }"], { encoding: "utf8", input: "", timeout: 60000 })
      process.stderr.write(`[web.test diagnostic ${label}] recent processes:\n${listed.stdout}\n${listed.stderr}\n`)
    }
  }
  setTimeout(() => report("5s"), 5000).unref()
  setTimeout(() => report("30s"), 30000).unref()
})
