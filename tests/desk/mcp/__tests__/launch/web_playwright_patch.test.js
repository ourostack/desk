import { test } from "node:test"
import { strict as assert } from "node:assert"
import { EventEmitter } from "node:events"
import { existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import * as path from "node:path"
import { runInNewContext } from "node:vm"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const patchPath = path.join(mcpRoot, "web-playwright-patch.cjs")
const stock = readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8")
const { apply, copyPackages, patchSource, readRevision } = require(patchPath)

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
    writeFileSync(receipt, contents)
    assert.equal(readRevision(installed), 0)
  }
  const unreadable = path.join(root, "unreadable")
  mkdirSync(path.join(unreadable, "playwright-patch.json"), { recursive: true })
  assert.throws(() => readRevision({ ...installed, dir: unreadable }), { code: "EISDIR" })
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
