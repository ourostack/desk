import { test } from "node:test"
import { strict as assert } from "node:assert"
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import { Writable } from "node:stream"
import * as path from "node:path"
import { runInNewContext } from "node:vm"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"))
const sourceCredential = require(path.join(mcpRoot, "web-extension-credential.cjs"))
const stock = readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8")
const bindingKey = "DESK_BROWSER_PROFILE_DIR"

test("native binding uses a strict presence gate before loading a client/helper", () => {
  for (const record of [null, false, undefined, [], {}])
    assert.throws(() => sourceCredential.validateNativeBinding(record, {}), { code: "NATIVE_CONFIG_INVALID" })
})

test("public ten-module closure permits ordinary code modes but refuses an outside dependency", async () => {
  const root = await mkTempRoot("native-E-public-closure-")
  for (const { path: name } of sourceCredential.nativeInventory(realpathSync(mcpRoot))) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true, mode: 0o755 })
    copyFileSync(path.join(mcpRoot, name), path.join(root, name))
  }
  assert.equal(sourceCredential.nativeInventory(root).length, 10)
  const file = path.join(root, "src/util/broker-error.mjs")
  writeFileSync(file, readFileSync(file, "utf8") + '\nimport "../outside-closure.mjs";\n')
  assert.throws(() => sourceCredential.nativeInventory(root), { code: "NATIVE_CODE_UNAVAILABLE" })
})

test("partial revision-three stock initializer deletion is rejected, never silently repaired", () => {
  const patched = patch.patchSource(stock)
  const partial = patched.replace('  await require("./desk-extension-credential.cjs").initialize(customUserDataDir, profileDirectory);\n', "")
  assert.notEqual(partial, patched)
  assert.throws(() => patch.patchSource(partial), { code: "PLAYWRIGHT_PATCH_UNSUPPORTED" })
})

test("real staged revision three binds the exact normal root closure and source changes invalidate it", async () => {
  const { installed, lib } = await staged()
  assert.equal(patch.readRevision(installed), 3)
  const receipt = JSON.parse(readFileSync(path.join(installed.dir, "playwright-patch.json")))
  assert.equal(receipt.nativeRuntime.mcpRoot, realpathSync(mcpRoot))
  assert.equal(receipt.nativeRuntime.modules.length, 10)
  assert.equal(receipt.nativeRuntime.discoveryInputs.version, 1)
  assert.ok(existsSync(path.join(lib, "desk-native-relay.cjs")))
  const changed = path.join(lib, "desk-native-relay.cjs")
  writeFileSync(changed, readFileSync(changed, "utf8") + "\n// drift\n")
  assert.equal(patch.readRevision(installed), 0)
})

test("stream protection masks every UTF8 byte split and one-byte write with acceptance callbacks", async () => {
  const secret = 'http://127.0.0.1:9/extension/owned-π-"nonce"'
  for (const form of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) {
    const bytes = Buffer.from(form)
    for (let split = 1; split < bytes.length; split++) {
      const chunks = []
      const sink = new Writable({ write(data, _encoding, done) { chunks.push(Buffer.from(data)); done() } })
      const proc = { stdout: sink, stderr: sink }
      sourceCredential.protect(proc, secret)
      await new Promise((resolve, reject) => sink.write(bytes.subarray(0, split), error => error ? reject(error) : resolve()))
      await new Promise((resolve, reject) => sink.write(bytes.subarray(split), error => error ? reject(error) : resolve()))
      await sourceCredential.flushProtection(proc, { final: true })
      assert.equal(Buffer.concat(chunks).toString(), "<token>")
    }
  }
  const chunks = [], sink = new Writable({ write(data, _encoding, done) { chunks.push(Buffer.from(data)); done() } })
  const proc = { stdout: sink, stderr: sink }
  sourceCredential.protect(proc, secret)
  for (const byte of Buffer.from(secret))
    await new Promise((resolve, reject) => sink.write(Buffer.from([byte]), error => error ? reject(error) : resolve()))
  await sourceCredential.flushProtection(proc, { final: true })
  assert.equal(Buffer.concat(chunks).toString(), "<token>")
})

test("held prefix never creates false backpressure or callback-waits-next-fragment deadlock", async () => {
  const output = [], sink = new Writable({ highWaterMark: 1, write(data, _enc, done) { output.push(Buffer.from(data)); setImmediate(done) } })
  const proc = { stdout: sink, stderr: sink }
  sourceCredential.protect(proc, "abcdef")
  let callbacks = 0
  for (const chunk of ["abc", "def", " safe"]) {
    await new Promise((resolve, reject) => {
      let accepted = false, drained = false
      const finish = () => { if (accepted && drained) resolve() }
      const result = sink.write(chunk, error => { callbacks++; if (error) reject(error); else { accepted = true; finish() } })
      if (result) drained = true
      else sink.once("drain", () => { drained = true; finish() })
      finish()
    })
  }
  await sourceCredential.flushProtection(proc, { final: true })
  assert.equal(callbacks, 3)
  assert.equal(Buffer.concat(output).toString(), "<token> safe")
  assert.equal(sink.destroyed, false)
})

test("flush masks ambiguous prefix and quarantines its late continuation, including after final flush", async () => {
  const { proc, output } = fixtureProcess()
  sourceCredential.protect(proc, "secret-value")
  proc.stdout.write("sec")
  await sourceCredential.flushProtection(proc)
  proc.stdout.write("ret-value")
  await sourceCredential.flushProtection(proc, { final: true })
  proc.stdout.write("secret-value")
  await sourceCredential.flushProtection(proc, { final: true })
  assert.equal(output.stdout.join(""), "<token><token>")
  assert.equal(typeof proc.stdout.write, "function")
})

test("same actual stream shared by staged/normal aliases gets one decorator and ordered callbacks", async () => {
  const { proc, output } = fixtureProcess()
  const stagedModule = { exports: {} }
  runInNewContext(readFileSync(path.join(mcpRoot, "web-extension-credential.cjs"), "utf8"), {
    require, module: stagedModule, Buffer, process, __dirname: mcpRoot, setTimeout, clearTimeout,
  })
  sourceCredential.protect(proc, "alpha")
  const original = proc.stderr.write
  stagedModule.exports.protect({ stdout: proc.stderr, stderr: proc.stderr }, "bravo")
  assert.equal(proc.stderr.write, original)
  const calls = []
  proc.stderr.write("alp", () => calls.push(1))
  proc.stderr.write("ha bravo", () => calls.push(2))
  await new Promise(resolve => setImmediate(resolve))
  await sourceCredential.flushProtection(proc, { final: true })
  assert.deepEqual(calls, [1, 2])
  assert.equal(output.stderr.join(""), "<token> <token>")
})

test("encoded strings and byte-array views never bypass the actual Writable protection", async () => {
  const output = [], sink = new Writable({ write(bytes, _encoding, done) { output.push(Buffer.from(bytes)); done() } })
  const proc = { stdout: sink, stderr: sink }, secret = "owned-π-capability"
  sourceCredential.protect(proc, secret)
  for (const encoding of ["hex", "base64", "latin1"]) {
    const bytes = Buffer.from(secret)
    sink.write(bytes.toString(encoding), encoding)
  }
  const bytes = Buffer.from("xx" + secret + "yy")
  sink.write(new Uint8Array(bytes.buffer, bytes.byteOffset + 2, bytes.length - 4))
  await sourceCredential.flushProtection(proc)
  assert.equal(Buffer.concat(output).toString(), "<token>".repeat(4))
})

test("flush reports a throwing sink as bounded rejection, never a synchronous escape", async () => {
  const sink = { write() { throw new Error("owned sink exception") } }
  const proc = { stdout: sink, stderr: sink }
  sourceCredential.protect(proc, "secret-value")
  sink.write("sec")
  let pending
  assert.doesNotThrow(() => { pending = sourceCredential.flushProtection(proc) })
  await assert.rejects(pending, { code: "TEXT_PROTECTION_SINK_ERROR" })
})

test("actual sink false/drain/error is separate from ordered acceptance callbacks", async () => {
  const output = [], completions = []
  const sink = new Writable({ highWaterMark: 1, write(bytes, _encoding, done) { output.push(Buffer.from(bytes)); completions.push(done) } })
  const proc = { stdout: sink, stderr: sink }, calls = []
  sourceCredential.protect(proc, "secret")
  assert.equal(sink.write("secret", error => calls.push(error?.code || "accepted")), false)
  assert.equal(sink.write("not accepted", error => calls.push(error?.code || "accepted")), false)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ["accepted", "TEXT_PROTECTION_BACKPRESSURE"])
  completions.shift()()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(sink.write("secret", error => calls.push(error?.code || "accepted")), false)
  completions.shift()(new Error("owned sink failure"))
  await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(sourceCredential.flushProtection(proc), { code: "TEXT_PROTECTION_SINK_ERROR" })
  assert.deepEqual(calls, ["accepted", "TEXT_PROTECTION_BACKPRESSURE", "accepted"])
  assert.equal(Buffer.concat(output).toString(), "<token><token>")
})

test("5000ms flush deadline refuses unconfirmed delivery without closing sink or releasing raw tail", async () => {
  let deadline, milliseconds
  const module = { exports: {} }, output = [], completions = []
  runInNewContext(readFileSync(path.join(mcpRoot, "web-extension-credential.cjs"), "utf8"), {
    require, module, Buffer, process, __dirname: mcpRoot,
    setTimeout(fn, ms) { deadline = fn; milliseconds = ms; return 1 },
    clearTimeout() {},
  })
  const hook = module.exports
  const sink = new Writable({ highWaterMark: 1, write(bytes, _encoding, done) { output.push(Buffer.from(bytes)); completions.push(done) } })
  const proc = { stdout: sink, stderr: sink }
  hook.protect(proc, "secret-value")
  assert.equal(sink.write("sec"), true)
  const pending = hook.flushProtection(proc, { final: true })
  assert.equal(milliseconds, 5000)
  deadline()
  await assert.rejects(pending, { code: "TEXT_PROTECTION_FLUSH_UNCONFIRMED" })
  assert.equal(sink.destroyed, false)
  assert.equal(Buffer.concat(output).toString(), "<token>")
  completions.shift()()
  await new Promise(resolve => setImmediate(resolve))
  sink.write("ret-value")
  await hook.flushProtection(proc)
  assert.equal(Buffer.concat(output).toString(), "<token>", "late suffix remains quarantined")
})

test("maximum-size retained prefix is bounded and final masking retains late-write protection", async () => {
  const { proc, output } = fixtureProcess(), secret = "x".repeat(65535) + "!"
  sourceCredential.protect(proc, secret)
  for (let index = 0; index < 65535; index += 257) {
    proc.stdout.write(Buffer.from(secret.slice(index, Math.min(65535, index + 257))))
    assert.ok(proc.stdout.__desk_text_protection_v3__.tail.length <= 65535)
  }
  assert.equal(proc.stdout.__desk_text_protection_v3__.tail.length, 65535)
  await sourceCredential.flushProtection(proc, { final: true })
  proc.stdout.write("!")
  proc.stdout.write(secret)
  await sourceCredential.flushProtection(proc)
  assert.equal(output.stdout.join(""), "<token><token>")
})

test("protection refuses overlong forms before output and sanitizes structured resource values", () => {
  const { proc, output } = fixtureProcess()
  assert.throws(() => sourceCredential.protect(proc, "x".repeat(65537)), { code: "TEXT_PROTECTION_FORM_TOO_LARGE" })
  sourceCredential.protect(proc, "owned-secret")
  const value = sourceCredential.redactProtected(proc, { code: "NATIVE_UNKNOWN", resources: {
    contextId: "3e785968-5657-478e-bd7c-be761f7ad281", disposition: "unknown", endpoint: "owned-secret",
  } })
  assert.equal(value.resources.endpoint, "<token>")
  assert.equal(value.resources.contextId, "3e785968-5657-478e-bd7c-be761f7ad281")
  assert.equal(value.resources.disposition, "unknown")
  assert.deepEqual(output, { stdout: [], stderr: [] })
})

function acquisition(initialize) {
  const tokens = []
  const proc = { env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: "startup" } }
  class Relay {
    constructor() { tokens.push(proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN) }
    async start() {}
    extensionEndpoint() { return "owned-fixture" }
    async establishExtensionConnection() {}
    cdpEndpoint() { return "owned-fixture" }
    stop() {}
  }
  const create = runInNewContext(`${patch.patchSource(stock)}\ncreateExtensionBrowser`, {
    process: proc,
    require: (name) => {
      assert.equal(name, "./desk-extension-credential.cjs")
      return { initialize: (...args) => initialize(proc, ...args) }
    },
    CDPRelayServer: Relay,
    debugLogger3() {},
    playwright: { chromium: { connectOverCDP: async () => ({ on() {} }) } },
  })
  return { tokens, call: () => create("msedge", "/owned-browser", "/owned-data", "Profile 4", "owned-client") }
}

test("every extension acquisition refreshes before the relay captures its token", async () => {
  let persisted = "rotated-before-first"
  const session = acquisition(async (proc, data, profile) => {
    assert.equal(data, "/owned-data")
    assert.equal(profile, "Profile 4")
    proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN = persisted
  })
  await session.call()
  persisted = "rotated-after-close"
  await session.call()
  assert.deepEqual(session.tokens, ["rotated-before-first", "rotated-after-close"])
})

test("credential initialization failure prevents relay construction and browser launch", async () => {
  const session = acquisition(async () => { throw new Error("browser_token_unavailable") })
  await assert.rejects(session.call(), /browser_token_unavailable/)
  assert.deepEqual(session.tokens, [])
})

async function staged() {
  const root = path.join(await mkTempRoot("extension-credential-"), "generation")
  const installed = { dir: root, version: "fixture", core: null }
  const lib = path.join(root, "node_modules", "playwright-core", "lib")
  mkdirSync(lib, { recursive: true })
  writeFileSync(path.join(lib, "coreBundle.js"), stock)
  patch.apply(installed)
  const file = path.join(lib, "desk-extension-credential.cjs")
  assert.equal(existsSync(file), true, "verified generation must contain its credential reader")
  return { root, lib, file, installed }
}

function credentialFor(proc, level) {
  return {
    protect: sourceCredential.protect,
    initialize: (data, profile) => sourceCredential.initialize(data, profile, { process: proc, level }),
  }
}

function fixtureProcess(profile, startup = "startup") {
  const output = { stdout: [], stderr: [] }
  const proc = {
    env: { [bindingKey]: profile, PLAYWRIGHT_MCP_EXTENSION_TOKEN: startup },
    stdout: { write: (value) => { output.stdout.push(String(value)); return true } },
    stderr: { write: (value) => { output.stderr.push(String(value)); return true } },
  }
  return { proc, output }
}

function levelFixture(state) {
  return { ClassicLevel: class {
    constructor() { if (state.error) throw new Error("fixture read failure") }
    iterator() {
      let read = false
      return {
        next: async () => {
          if (read || state.token === null) return undefined
          read = true
          return [
            Buffer.from("_chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm\u0000\u0001auth-token", "latin1"),
            Buffer.concat([Buffer.from([1]), Buffer.from(state.token, "latin1")]),
          ]
        },
        close: async () => {},
      }
    }
    async close() {}
  } }
}

test("same-generation reader rotates redaction on both streams without changing the parent environment", async () => {
  const { root } = await staged()
  const profile = path.join(root, "profile")
  mkdirSync(path.join(profile, "Local Storage", "leveldb"), { recursive: true })
  const { proc, output } = fixtureProcess(profile)
  const state = { token: 'new token"one' }
  const credential = credentialFor(proc, levelFixture(state))
  const parent = { ...process.env }
  credential.protect(proc, "startup")
  await credential.initialize(root, "profile")
  assert.equal(proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, 'new token"one')
  state.token = "next/token"
  await credential.initialize(root, "profile")
  assert.equal(proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, "next/token")
  for (const stream of [proc.stdout, proc.stderr]) {
    stream.write('startup new token"one new%20token%22one new token\\"one next/token next%2Ftoken')
  }
  assert.deepEqual(output, { stdout: ["<token> <token> <token> <token> <token> <token>"], stderr: ["<token> <token> <token> <token> <token> <token>"] })
  assert.equal(JSON.stringify({ ...process.env }) === JSON.stringify(parent), true, "the parent environment must remain unchanged")
})

test("an unbound direct caller leaves its credential and streams unchanged", async () => {
  await staged()
  const { proc } = fixtureProcess(undefined)
  delete proc.env[bindingKey]
  const write = proc.stdout.write
  const credential = credentialFor(proc, {})
  const inherited = process.env[bindingKey]
  delete process.env[bindingKey]
  try {
    await sourceCredential.initialize(undefined, undefined)
  } finally {
    if (inherited !== undefined) process.env[bindingKey] = inherited
  }
  assert.equal(proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, "startup")
  assert.equal(proc.stdout.write, write)
  await credential.initialize(undefined, undefined)
})

test("independent bindings read only their own profile and keep separate in-memory credentials", async () => {
  const { root } = await staged()
  const sessions = []
  for (const [profileName, token] of [["first", "first-current"], ["second", "second-current"]]) {
    const profile = path.join(root, profileName)
    mkdirSync(path.join(profile, "Local Storage", "leveldb"), { recursive: true })
    const session = fixtureProcess(profile, profileName === "first" ? "" : "startup")
    const credential = credentialFor(session.proc, levelFixture({ token }))
    sessions.push({ ...session, credential, profileName, token })
  }
  await Promise.all(sessions.map(({ credential, profileName }) => credential.initialize(root, profileName)))
  for (const session of sessions) {
    assert.equal(session.proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, session.token)
    session.proc.stdout.write(session.token)
    assert.deepEqual(session.output.stdout, ["<token>"])
    const other = sessions.find(candidate => candidate !== session)
    await assert.rejects(session.credential.initialize(root, other.profileName), /browser_profile_binding_mismatch/)
    assert.equal(session.proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, session.token)
  }
})

test("wrong binding rejects before profile access and equivalent normalized paths are accepted", async () => {
  const { root } = await staged()
  const { proc } = fixtureProcess(path.join(root, "profile"))
  const credential = credentialFor(proc, {})
  await assert.rejects(credential.initialize(root, "foreign"), /browser_profile_binding_mismatch/)
  assert.equal(proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, "startup")
  await assert.rejects(credential.initialize(root, "./profile"), /browser_token_unavailable/)
})

test("invalid bindings and incomplete selections reject before reading a profile", async () => {
  for (const [binding, data, profile] of [
    [null, "/owned", "profile"], ["relative", "/owned", "profile"],
    ["/owned/profile", undefined, "profile"], ["/owned/profile", "/owned", undefined],
  ]) {
    const { proc } = fixtureProcess(binding)
    await assert.rejects(sourceCredential.initialize(data, profile, { process: proc, level: {} }), /browser_profile_binding_mismatch/)
  }
})

test("absent, empty and unreadable credentials fail closed without retaining the startup token", async () => {
  const { root } = await staged()
  const profile = path.join(root, "profile")
  mkdirSync(path.join(profile, "Local Storage", "leveldb"), { recursive: true })
  for (const state of [{ token: null }, { token: "" }, { error: true }, undefined]) {
    const { proc } = fixtureProcess(profile)
    const credential = credentialFor(proc, state === undefined ? undefined : levelFixture(state))
    await assert.rejects(credential.initialize(root, "profile"), /browser_token_(unavailable|unreadable)/)
    assert.equal(proc.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined)
  }
})

test("helper corruption and a helper from an older release invalidate the generation receipt", async () => {
  const { file, installed } = await staged()
  assert.equal(patch.readRevision(installed), patch.REVISION)
  writeFileSync(file, readFileSync(file, "utf8") + "\n// stale helper\n")
  assert.equal(patch.readRevision(installed), 0)
  const receiptFile = path.join(installed.dir, "playwright-patch.json")
  const receipt = JSON.parse(readFileSync(receiptFile, "utf8"))
  receipt.credentialSha256 = require("node:crypto").createHash("sha256").update(readFileSync(file)).digest("hex")
  writeFileSync(receiptFile, JSON.stringify(receipt))
  assert.equal(patch.readRevision(installed), 0, "a self-consistent stale receipt must not qualify against the current release")
})

test("the acquisition patch rejects changed or duplicated initializer sites", () => {
  assert.throws(() => patch.patchSource(stock.replace("  await relay.start();", "  await relay.start(1);")), /unsupported/i)
  const start = stock.indexOf("async function createExtensionBrowser(")
  assert.throws(() => patch.patchSource(stock + stock.slice(start)), /unsupported/i)
})

test("the runner and initializer share one generation-local redactor and reader", async () => {
  const { root, lib } = await staged()
  const modules = path.join(root, "node_modules")
  const cliDir = path.join(modules, "@playwright", "mcp")
  const profile = path.join(root, "profile")
  mkdirSync(path.join(profile, "Local Storage", "leveldb"), { recursive: true })
  mkdirSync(cliDir, { recursive: true })
  writeFileSync(path.join(lib, "..", "package.json"), '{"name":"playwright-core","main":"index.js"}')
  const localLevel = path.join(modules, "classic-level")
  mkdirSync(localLevel)
  writeFileSync(path.join(localLevel, "index.js"), `exports.ClassicLevel = class {
    iterator() { let read = false; return {
      next: async () => read ? undefined : (read = true, [
        Buffer.from("_chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm\\0\\x01auth-token", "latin1"),
        Buffer.concat([Buffer.from([1]), Buffer.from("generation-local")])
      ]), close: async () => {}
    } }
    async close() {}
  }`)
  const parentLevel = path.join(path.dirname(root), "node_modules", "classic-level")
  mkdirSync(parentLevel, { recursive: true })
  writeFileSync(path.join(parentLevel, "index.js"), 'throw new Error("wrong-generation-reader")')
  const cli = path.join(cliDir, "cli.js")
  writeFileSync(cli, `
    const credential = require("../../playwright-core/lib/desk-extension-credential.cjs");
    const initialWrite = process.stdout.write;
    process.stdout.write("startup\\n");
    credential.initialize(${JSON.stringify(root)}, "profile").then(() => {
      process.stdout.write(JSON.stringify({ sameWrapper: process.stdout.write === initialWrite }) + "\\n");
      process.stdout.write(process.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN + "\\n");
      process.stderr.write("startup generation-local\\n");
    });
  `)
  const child = spawnSync(process.execPath, [path.join(mcpRoot, "web-real-tabs.cjs"), cli], {
    env: { PATH: path.dirname(process.execPath), [bindingKey]: profile, PLAYWRIGHT_MCP_EXTENSION_TOKEN: "startup" },
    encoding: "utf8",
  })
  assert.equal(child.status, 0, child.stderr)
  assert.equal(child.stdout, '<token>\n{"sameWrapper":true}\n<token>\n')
  assert.equal(child.stderr, "<token> <token>\n")
})
