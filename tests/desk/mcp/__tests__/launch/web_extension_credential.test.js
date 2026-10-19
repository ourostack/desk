import { test } from "node:test"
import { strict as assert } from "node:assert"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { spawnSync } from "node:child_process"
import * as path from "node:path"
import { runInNewContext } from "node:vm"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"))
const sourceCredential = require(path.join(mcpRoot, "web-extension-credential.cjs"))
const stock = readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8")
const bindingKey = "DESK_BROWSER_PROFILE_DIR"

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
  assert.equal(patch.readRevision(installed), 3)
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
  const end = stock.indexOf("\nvar import_path60, debug16, debugLogger3;", start)
  assert.throws(() => patch.patchSource(stock + stock.slice(start, end)), /unsupported/i)
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
