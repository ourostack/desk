import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { runInNewContext } from "node:vm"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const { loadTemplate } = require("./fixtures/native-template-loader.cjs")
const patchPath = path.join(mcpRoot, "web-playwright-patch.cjs")
const stock = readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8")
const { apply, copyPackages, patchSource, readRevision } = require(patchPath)

function priorE3(source) {
  // Mechanical inverse of only this fix, recording the exact complete
  // 76396fb8 candidate; not arbitrary block stripping or an alternate engine.
  return source.replace("await acquisition.start(relay);", "await relay.start();")
    .replace('await acquisition.waitFor(relay.establishExtensionConnection(clientName), "extension.handshake");', "await relay.establishExtensionConnection(clientName);")
    .replace('await acquisition.waitFor(playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: remaining, noDefaults: true }), "cdp.connect");',
      "await playwright.chromium.connectOverCDP(relay.cdpEndpoint(), { isLocal: true, timeout: remaining, noDefaults: true });")
    .replace('browser.on("disconnected", () => { acquisition.retire(); });', 'browser.on("disconnected", () => { acquisition.retire(); relay.stop(); });')
    .replace("      acquisition.retire();\n      throw acquisition.failure(error);", "      acquisition.retire();\n      relay?.stop();\n      throw acquisition.failure(error);")
    .replace('    const bindOperation = browser.bind(bindOptions.title, { workspaceDir: bindOptions.workspaceDir });\n    const { endpoint } = await (deskNativeBinding ? deskNativeBinding.waitFor(bindOperation, "browser.bind") : bindOperation);',
      "    const { endpoint } = await browser.bind(bindOptions.title, { workspaceDir: bindOptions.workspaceDir });")
    .replace('    const closeOperation = browser.close();\n    await (deskNativeBinding ? deskNativeBinding.waitFor(closeOperation, "browser.close") : closeOperation).catch(() => {\n    });',
      "    await browser.close().catch(() => {\n    });")
}

test("complete prior E3 upgrades exactly; partial native/await edits and duplicated legacy idle guards refuse", () => {
  const current = patchSource(stock), prior = priorE3(current)
  assert.notEqual(prior, current)
  assert.equal(patchSource(prior), current)
  assert.equal(patchSource(current), current)
  for (const [before, after] of [
    ['    const { endpoint } = await (deskNativeBinding ? deskNativeBinding.waitFor(bindOperation, "browser.bind") : bindOperation);', "    const { endpoint } = await bindOperation;"],
    ['this._nativeAcquisition = deskNativeAcquisition;', ""],
    ['    CDPRelayServer = class {', '    CDPRelayServer = class { /* drift */'],
  ]) assert.throws(() => patchSource(current.replace(before, after)), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  const start = current.indexOf('      if (!backendPromise && request2.params.name === "browser_close") {')
  const end = current.indexOf("      if (!backendPromise) {", start)
  const idle = current.slice(start, end)
  const onlyIdle = stock.replace("    try {\n", "    try {\n" + idle + idle)
  assert.throws(() => patchSource(onlyIdle), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  const begin = "async function createBrowser(config,", finish = "\nasync function connectToBrowserEndpoint("
  const currentStart = current.indexOf(begin), currentEnd = current.indexOf(finish, currentStart), stockStart = stock.indexOf(begin)
  const mixed = current.slice(0, currentStart) + stock.slice(stockStart, stock.indexOf(finish, stockStart)) + current.slice(currentEnd)
  assert.throws(() => patchSource(mixed), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  assert.throws(() => patchSource(current.replace("async function createBrowser(config,", "async function createBrowser2(config,")), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
})

test("stale fully-qualified prior E3 stays unqualified and a staged write race cannot publish qualification", async () => {
  const root = await mkTempRoot("patch-prior-e3-"), lib = path.join(root, "node_modules/playwright-core/lib")
  mkdirSync(lib, { recursive: true })
  const core = path.join(lib, "coreBundle.js"), receipt = path.join(root, "playwright-patch.json"), installed = { dir: root, version: "owned", core: null }
  writeFileSync(core, stock); apply(installed)
  const stale = priorE3(readFileSync(core, "utf8")), data = JSON.parse(readFileSync(receipt))
  const sha = value => require("node:crypto").createHash("sha256").update(value).digest("hex")
  writeFileSync(core, stale); data.bundleSha256 = sha(stale)
  const regions = [
    ["function createServer(", "\nfunction addServerListener("],
    ["async function createExtensionBrowser(", "\nvar import_path60, debug16, debugLogger3;"],
    ["async function createBrowser(config,", "\nasync function connectToBrowserEndpoint("],
    ["    CDPRelayServer = class {", "\n    ExtensionConnection = class {"],
  ]
  for (let i = 0; i < regions.length; i++) {
    const [begin, end] = regions[i], start = stale.indexOf(begin)
    data.guardedRegionProofs[i].patched = sha(stale.slice(start, stale.indexOf(end, start)))
  }
  writeFileSync(receipt, JSON.stringify(data))
  assert.equal(readRevision(installed), 0)
  writeFileSync(core, stock)
  const observed = Object.create(require("node:fs"))
  observed.writeFileSync = function (file, ...args) {
    require("node:fs").writeFileSync(file, ...args)
    if (file === receipt) require("node:fs").appendFileSync(core, "\n// owned staged replacement\n")
  }
  const module = { exports: {} }
  loadTemplate(patchPath, { module, __dirname: mcpRoot, process,
    require(name) { return name === "fs" ? observed : name === "./web-extension-credential.cjs" ? require(path.join(mcpRoot, name)) : require(name) },
  })
  assert.throws(() => module.exports.apply(installed), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  const failure = new Error("owned ACL inspection process terminated without a code"), credentialModule = { exports: {} }
  loadTemplate(path.join(mcpRoot, "web-extension-credential.cjs"), {
    module: credentialModule, __dirname: lib, process, Buffer, setTimeout, clearTimeout,
    require(name) { return name === "child_process" ? { execFileSync() { throw failure } } : require(name) },
  })
  const failedRead = { exports: {} }
  loadTemplate(patchPath, { module: failedRead, __dirname: mcpRoot, process,
    require(name) { return name === "./web-extension-credential.cjs" ? credentialModule.exports : require(name) },
  })
  assert.throws(() => failedRead.exports.readRevision(installed), error => error === failure)
})

test("revision three guards the complete browser routing and actual relay class regions", () => {
  for (const [before, after] of [
    ['let ownership = "own";', 'let ownership = "changed";'],
    ['this._protocolVersion = parseInt(', 'this._protocolVersion = Number.parseInt('],
    ['const uuid = crypto.randomUUID();', 'const uuid = crypto.randomUUID() + "drift";'],
  ]) {
    assert.ok(stock.includes(before))
    assert.throws(() => patchSource(stock.replace(before, after)), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  }
  const start = stock.indexOf("async function createBrowser(config,")
  const end = stock.indexOf("\nasync function connectToBrowserEndpoint(", start)
  assert.throws(() => patchSource(stock + "\n" + stock.slice(start, end)), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  assert.equal(require(patchPath).REVISION, 3)
  for (const [begin, finish] of [
    ["function createServer(", "\nfunction addServerListener("],
    ["async function createBrowser(config,", "\nasync function connectToBrowserEndpoint("],
    ["async function createExtensionBrowser(", "\nvar import_path60, debug16, debugLogger3;"],
    ["    CDPRelayServer = class {", "\n    ExtensionConnection = class {"],
  ]) {
    const start = stock.indexOf(begin), end = stock.indexOf(finish, start)
    assert.ok(start >= 0 && end > start)
    assert.throws(() => patchSource(stock + "\n" + stock.slice(start, end)), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
    assert.throws(() => patchSource(stock.slice(0, start + begin.length) + " " + stock.slice(start + begin.length)),
      { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  }
})

test("native discovery capture preserves redirected Windows roots and normal first-case semantics", () => {
  const capture = require(patchPath).captureNativeDiscoveryInputs
  assert.equal(typeof capture, "function")
  const env = { LocalAppData: "Z:\\Redirected\\Local", LOCALAPPDATA: "C:\\wrong",
    ProgramFiles: "Q:\\Apps", "PROGRAMFILES(X86)": "R:\\Apps32", HOME: "/private", TOKEN: "must-not-copy" }
  const got = capture("win32", env, "C:\\Users\\native")
  assert.deepEqual(got, { version: 1, platform: "win32", nativeHome: "C:\\Users\\native",
    browserEnv: { LOCALAPPDATA: "Z:\\Redirected\\Local", PROGRAMFILES: "Q:\\Apps", "PROGRAMFILES(X86)": "R:\\Apps32" } })
  assert.ok(Object.isFrozen(got) && Object.isFrozen(got.browserEnv))
  assert.deepEqual(capture("win32", {}, "C:\\Users\\native").browserEnv, {})
  assert.throws(() => capture("win32", { LOCALAPPDATA: "relative" }, "C:\\Users\\native"))
  for (const invalid of [null, undefined, [], false])
    assert.throws(() => capture("win32", invalid, "C:\\Users\\native"), { code: "NATIVE_DISCOVERY_INPUTS_UNAVAILABLE" })
  const discovery = require(path.join(mcpRoot, "web-browser-discovery.cjs"))
  for (const channel of ["chrome", "msedge"]) {
    const suffix = channel === "chrome" ? "\\Google\\Chrome\\Application\\chrome.exe" : "\\Microsoft\\Edge\\Application\\msedge.exe"
    for (const available of [0, 1, 2]) {
      const candidates = ["Z:\\Redirected\\Local", "Q:\\Apps", "R:\\Apps32"].map(root => root + suffix)
      const seen = []
      const selected = discovery.channelBrowserSelection(channel, "win32", got.browserEnv,
        file => { seen.push(file); return file === candidates[available] }, { nativeHome: got.nativeHome })
      assert.equal(selected.executablePath, candidates[available])
      assert.deepEqual(seen, candidates.slice(0, available + 1))
    }
    const absent = capture("win32", {}, "C:\\Users\\native")
    const seen = []
    assert.equal(discovery.channelBrowserSelection(channel, "win32", absent.browserEnv,
      file => { seen.push(file); return true }, { nativeHome: absent.nativeHome }).executablePath, null)
    assert.deepEqual(seen, [], "absent captured roots are not guessed from nativeHome")
  }
})

test("one-argument apply captures its normal parent, never the facade/npm-child environment", async () => {
  const root = await mkTempRoot("playwright-parent-capture-"), module = { exports: {} }
  const lib = path.join(root, "node_modules/playwright-core/lib")
  mkdirSync(lib, { recursive: true })
  writeFileSync(path.join(lib, "coreBundle.js"), stock)
  const normal = { LocalAppData: "Z:\\Redirected\\Local", ProgramFiles: "Q:\\Programs",
    "ProgramFiles(x86)": "R:\\Programs32", HOME: "/not-native-home" }
  loadTemplate(patchPath, {
    module, __dirname: mcpRoot, process: { platform: "win32", env: normal },
    require(name) {
      if (name === "./web-extension-credential.cjs") return require(path.join(mcpRoot, name))
      if (name === "os") return { userInfo: () => ({ homedir: "C:\\Users\\native" }) }
      return require(name)
    },
  })
  const installed = { dir: root, version: "owned", core: null, env: { LOCALAPPDATA: "C:\\isolated" } }
  module.exports.apply(installed)
  assert.equal(module.exports.readRevision(installed), 3)
  const capture = JSON.parse(readFileSync(path.join(root, "playwright-patch.json"))).nativeRuntime.discoveryInputs
  assert.deepEqual(capture, { version: 1, platform: "win32", nativeHome: "C:\\Users\\native",
    browserEnv: { LOCALAPPDATA: "Z:\\Redirected\\Local", PROGRAMFILES: "Q:\\Programs", "PROGRAMFILES(X86)": "R:\\Programs32" } })
  normal.LocalAppData = "C:\\later-isolated"
  assert.equal(JSON.parse(readFileSync(path.join(root, "playwright-patch.json"))).nativeRuntime.discoveryInputs.browserEnv.LOCALAPPDATA,
    "Z:\\Redirected\\Local")
})

test("private receipt and generation exposures remain unqualified without chmod repair on read", {
  skip: process.platform === "win32" ? "POSIX exposure seam; native Windows ACL acceptance remains separate" : false,
}, async () => {
  const root = await mkTempRoot("playwright-private-receipt-")
  mkdirSync(path.join(root, "node_modules/playwright-core/lib"), { recursive: true })
  writeFileSync(path.join(root, "node_modules/playwright-core/lib/coreBundle.js"), stock)
  const installed = { dir: root, version: "owned", core: null }
  apply(installed)
  const receipt = path.join(root, "playwright-patch.json")
  chmodSync(receipt, 0o644)
  assert.equal(readRevision(installed), 0)
  chmodSync(receipt, 0o600)
  assert.equal(readRevision(installed), 3)
  chmodSync(root, 0o755)
  assert.equal(readRevision(installed), 0)
})

function lifecycle({ acquire = async () => { throw new Error("owned browser acquisition blocked") } } = {}) {
  let acquisitions = 0
  const handlers = new Map()
  class Server {
    setRequestHandler(schema, handler) { handlers.set(schema, handler) }
  }
  class InvalidArguments extends Error {}
  const create = runInNewContext(`${patchSource(stock)}\ncreateServer`, {
    Server,
    ListToolsRequestSchema: "list",
    CallToolRequestSchema: "call",
    serverDebug() {},
    serverDebugResponse() {},
    addServerListener() {},
    mergeTextParts: (result) => result,
    initializeServer: async (_server, factory) => factory.create(),
    zod: { ZodError: InvalidArguments, prettifyError: () => "Expected an object" },
  })
  const closeSchema = {
    name: "browser_close",
    inputSchema: { parse(args) {
      if (args === null || typeof args !== "object" || Array.isArray(args)) throw new InvalidArguments("Expected an object")
      return {}
    } },
  }
  create("owned-lifecycle", "test", {
    toolSchemas: [closeSchema],
    create: async () => { acquisitions++; return acquire() },
  }, Promise.resolve(), false)
  return {
    call: (name, args = {}) => handlers.get("call")({ params: { name, arguments: args } }, { signal: new AbortController().signal }),
    acquisitions: () => acquisitions,
  }
}

test("close after failed acquisition never acquires another browser", async () => {
  const session = lifecycle()
  const navigation = await session.call("browser_navigate", { url: "https://example.invalid" })
  assert.equal(navigation.isError, true)
  assert.equal(session.acquisitions(), 1)
  const close = await session.call("browser_close")
  assert.equal(session.acquisitions(), 1, "closing a nonexistent session must not acquire again")
  assert.notEqual(close.isError, true)
})

test("idle close and repeated idle close do not acquire a browser", async () => {
  const session = lifecycle()
  for (let index = 0; index < 2; index++) {
    const result = await session.call("browser_close")
    assert.equal(session.acquisitions(), 0)
    assert.notEqual(result.isError, true)
    assert.match(result.content[0].text, /no browser session is open/i)
  }
})

test("navigation after idle close still performs a real acquisition", async () => {
  const session = lifecycle()
  await session.call("browser_close")
  await session.call("browser_navigate")
  assert.equal(session.acquisitions(), 1)
})

test("close while acquisition is pending shares the failing acquisition", async () => {
  let reject
  const pending = new Promise((_resolve, fail) => { reject = fail })
  const session = lifecycle({ acquire: () => pending })
  const navigation = session.call("browser_navigate")
  await Promise.resolve()
  const close = session.call("browser_close")
  reject(new Error("owned pending acquisition blocked"))
  assert.equal((await navigation).isError, true)
  assert.equal((await close).isError, true)
  assert.equal(session.acquisitions(), 1)
  assert.notEqual((await session.call("browser_close")).isError, true)
  assert.equal(session.acquisitions(), 1)
})

test("healthy close keeps backend disposal and tool arguments unchanged", async () => {
  const backend = new EventEmitter()
  let disposals = 0
  backend.dispose = async () => { disposals++ }
  backend.callTool = async (name, args, signal) => {
    assert.equal(signal.aborted, false)
    if (name === "browser_close") {
      assert.equal(args.extra, "kept")
      backend.emit("disconnected")
    }
    return { content: [{ type: "text", text: name }] }
  }
  const session = lifecycle({ acquire: async () => backend })
  await session.call("browser_navigate")
  const close = await session.call("browser_close", { extra: "kept" })
  assert.equal(close.content[0].text, "browser_close")
  assert.equal(session.acquisitions(), 1)
  assert.equal(disposals, 1)
  await session.call("browser_close")
  assert.equal(session.acquisitions(), 1)
})

test("idle close rejects invalid arguments without acquisition", async () => {
  const session = lifecycle()
  const result = await session.call("browser_close", [])
  assert.equal(result.isError, true)
  assert.match(result.content[0].text, /Invalid arguments for tool "browser_close"/)
  assert.equal(session.acquisitions(), 0)
})

test("idle-close schema errors retain JSON intent for direct handler callers", async () => {
  const session = lifecycle()
  const args = []
  args._meta = { json: true }
  const result = await session.call("browser_close", args)
  assert.equal(result.isError, true)
  assert.deepEqual(JSON.parse(result.content[0].text), {
    isError: true, error: 'Invalid arguments for tool "browser_close":\nExpected an object',
  })
  assert.equal(session.acquisitions(), 0)
})

test("JSON idle close returns honest machine-readable state", async () => {
  const session = lifecycle()
  const result = await session.call("browser_close", { _meta: { json: true } })
  assert.equal(session.acquisitions(), 0)
  assert.deepEqual(JSON.parse(result.content[0].text), { result: "No browser session is open." })
})

test("raw idle close omits markdown headings and invented page-close code", async () => {
  const session = lifecycle()
  const result = await session.call("browser_close", { _meta: { raw: true } })
  assert.equal(session.acquisitions(), 0)
  assert.equal(result.content[0].text, "No browser session is open.")
})

test("same-tick idle close then navigate returns idle before acquiring", async () => {
  const session = lifecycle()
  const close = session.call("browser_close")
  assert.equal(session.acquisitions(), 0)
  const navigation = session.call("browser_navigate")
  assert.notEqual((await close).isError, true)
  assert.equal((await navigation).isError, true)
  assert.equal(session.acquisitions(), 1)
})

test("same-tick navigate then close shares exactly one failed acquisition", async () => {
  const session = lifecycle()
  const navigation = session.call("browser_navigate")
  const close = session.call("browser_close")
  assert.equal((await navigation).isError, true)
  assert.equal((await close).isError, true)
  assert.equal(session.acquisitions(), 1)
})

test("unknown tool does not receive idle-close success", async () => {
  const session = lifecycle()
  const result = await session.call("browser_not_a_tool")
  assert.equal(result.isError, true)
  assert.equal(session.acquisitions(), 1)
})

test("patch rejects changed upstream lifecycle instead of silently weakening cleanup", () => {
  assert.throws(() => patchSource(stock.replace("let backendPromise;", "let backendPromise = factory.promise;")), /unsupported/i)
})

test("patch rejects duplicate lifecycle definitions", () => {
  assert.throws(() => patchSource(stock + stock), /unsupported/i)
})

test("patch is idempotent without adding another idle-close handler", async () => {
  const patched = patchSource(stock)
  assert.equal(patchSource(patched), patched)
})

test("exact historical revision two migrates, but a credential-only partial transform refuses", () => {
  const revised = patchSource(stock), start = stock.indexOf("function createServer("), end = stock.indexOf("\nfunction addServerListener(", start)
  const revisedStart = revised.indexOf("function createServer("), revisedEnd = revised.indexOf("\nfunction addServerListener(", revisedStart)
  const initialize = '  await require("./desk-extension-credential.cjs").initialize(customUserDataDir, profileDirectory);\n'
  const partial = stock.replace("  const relay = new CDPRelayServer(", initialize + "  const relay = new CDPRelayServer(")
  const revisionTwo = partial.slice(0, start) + revised.slice(revisedStart, revisedEnd) + partial.slice(end)
  assert.equal(patchSource(revisionTwo), revised)
  assert.throws(() => patchSource(partial), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
})

test("a duplicated applied guard is rejected rather than accepted as an idempotent patch", () => {
  const patched = patchSource(stock)
  const start = patched.indexOf('      if (!backendPromise && request2.params.name === "browser_close") {')
  const end = patched.indexOf("      if (!backendPromise) {", start)
  const duplicate = patched.slice(0, start) + patched.slice(start, end) + patched.slice(start)
  assert.throws(() => patchSource(duplicate), /unsupported/i)
})

test("missing package code is unsupported while real filesystem failures remain visible", async () => {
  const root = await mkTempRoot("playwright-patch-read-failure-")
  const installed = { dir: root, version: "fixture", core: null }
  assert.throws(() => apply(installed), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
  mkdirSync(path.join(root, "node_modules", "playwright-core", "lib", "coreBundle.js"), { recursive: true })
  assert.throws(() => apply(installed), { code: "EISDIR" })
})

test("invalid receipts are unqualified but filesystem failures are not silently ignored", async () => {
  const root = await mkTempRoot("playwright-patch-receipt-errors-")
  const installed = { dir: root, version: "fixture", core: null }
  const receipt = path.join(root, "playwright-patch.json")
  for (const contents of ["null", '{"revision":0}', "{broken"]) {
    writeFileSync(receipt, contents, { mode: 0o600 })
    assert.equal(readRevision(installed), 0)
  }
  const unreadable = path.join(root, "unreadable")
  mkdirSync(path.join(unreadable, "playwright-patch.json"), { recursive: true })
  assert.throws(() => readRevision({ ...installed, dir: unreadable }), { code: "EISDIR" })
})

test("copy refuses a package link to its parent rather than traversing another tree", async () => {
  const root = await mkTempRoot("patch-outside-link-"), from = path.join(root, "from")
  mkdirSync(from)
  symlinkSync(root, path.join(from, "outside"), process.platform === "win32" ? "junction" : "dir")
  await assert.rejects(copyPackages(from, path.join(root, "to")), /outside its installed package tree/)
})

test("absolute package symlinks are rebased onto the new generation", { skip: process.platform === "win32" ? "POSIX symbolic-link fixture" : false }, async () => {
  const root = await mkTempRoot("playwright-patch-absolute-link-")
  const source = path.join(root, "source")
  const target = path.join(root, "target")
  mkdirSync(source)
  writeFileSync(path.join(source, "file"), "owned package content")
  symlinkSync(path.join(source, "file"), path.join(source, "link"))
  await copyPackages(source, target)
  assert.equal(realpathSync(path.join(target, "link")), path.join(target, "file"))
  assert.equal(readFileSync(path.join(target, "link"), "utf8"), "owned package content")
})

test("directory package links retain the platform's unprivileged link type", { skip: process.platform === "win32" ? "emulated POSIX fixture for both link types" : false }, async (t) => {
  const root = await mkTempRoot("playwright-patch-directory-link-")
  const source = path.join(root, "source")
  mkdirSync(path.join(source, "dir"), { recursive: true })
  writeFileSync(path.join(source, "dir", "file"), "owned directory")
  symlinkSync("dir", path.join(source, "link"), "dir")
  const fs = require("node:fs")
  const symlink = fs.promises.symlink
  const types = []
  t.mock.method(fs.promises, "symlink", async (from, to, type) => {
    types.push(type)
    return symlink(from, to, type)
  })
  await copyPackages(source, path.join(root, "posix"))
  const platform = Object.getOwnPropertyDescriptor(process, "platform")
  try {
    Object.defineProperty(process, "platform", { value: "win32" })
    await copyPackages(source, path.join(root, "windows"))
  } finally {
    Object.defineProperty(process, "platform", platform)
  }
  assert.deepEqual(types, ["dir", "junction"])
  assert.equal(readFileSync(path.join(root, "windows", "link", "file"), "utf8"), "owned directory")
})

test("non-file package entries are rejected before a target file can be created", async (t) => {
  const root = await mkTempRoot("playwright-patch-non-file-")
  const source = path.join(root, "source")
  mkdirSync(source)
  writeFileSync(path.join(source, "entry"), "owned fixture")
  const fs = require("node:fs")
  const lstat = fs.promises.lstat
  t.mock.method(fs.promises, "lstat", async (file) => {
    if (file === path.join(source, "entry")) return { isDirectory: () => false, isSymbolicLink: () => false, isFile: () => false }
    return lstat(file)
  })
  await assert.rejects(copyPackages(source, path.join(root, "target")), /non-file entry/i)
  assert.equal(existsSync(path.join(root, "target", "entry")), false)
})
