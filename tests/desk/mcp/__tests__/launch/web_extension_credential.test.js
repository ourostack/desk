import { test } from "node:test"
import { strict as assert } from "node:assert"
import fs, { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { execFileSync, spawnSync } from "node:child_process"
import { Writable } from "node:stream"
import * as path from "node:path"
import { runInNewContext } from "node:vm"
import { mcpRoot } from "./_mcp_handshake.js"
import { mkTempRoot } from "../_temp_roots.js"
import { different } from "../_file_identity.js"

const require = createRequire(import.meta.url)
const { loadTemplate } = require("./fixtures/native-template-loader.cjs")
const patch = require(path.join(mcpRoot, "web-playwright-patch.cjs"))
const sourceCredential = require(path.join(mcpRoot, "web-extension-credential.cjs"))
const errorFixture = require("./fixtures/playwright-native-error-transport.cjs").read()
const stock = readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8") + errorFixture.core
const bindingKey = "DESK_BROWSER_PROFILE_DIR"

function templateCredential(overrides = {}, directory = mcpRoot, proc = process, timers = {}) {
  return loadTemplate(path.join(mcpRoot, "web-extension-credential.cjs"), {
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : require(name),
    module: { exports: {} }, __dirname: directory, process: proc, Buffer,
    setTimeout, clearTimeout, ...timers,
  })
}

test("native ready output requires its exact protected writer and a complete byte frame", () => {
  for (const invalid of ["unprotected","writer","sequence","text","delimiter"]) {
    const { proc } = fixtureProcess()
    if (invalid !== "unprotected") sourceCredential.protect(proc)
    if (invalid === "writer") proc.stdout.write = () => true
    if (invalid === "sequence") proc.stdout.__desk_text_protection_v3__.writeSequence = NaN
    const bytes = invalid === "text" ? "ready\n" : Buffer.from(invalid === "delimiter" ? "ready" : "ready\n")
    assert.throws(() => sourceCredential.writeNativeReady(proc,bytes,assert.fail), { code:"TEXT_PROTECTION_FRAME_CHANGED" })
  }
})

test("native ready completion rejects stream, writer, counter and intervening-write changes", async () => {
  for (const changed of ["stream","writer","sequence","write"]) {
    const { proc } = fixtureProcess()
    sourceCredential.protect(proc)
    const state = proc.stdout.__desk_text_protection_v3__
    await new Promise((resolve,reject) => {
      sourceCredential.writeNativeReady(proc,Buffer.from("ready\n"),(error,flush) => {
        try {
          assert.ifError(error)
          if (changed === "stream") proc.stdout = { write:() => true }
          if (changed === "writer") proc.stdout.write = () => true
          if (changed === "sequence") state.writeSequence = NaN
          if (changed === "write") proc.stdout.write("")
          assert.rejects(flush(),{ code:"TEXT_PROTECTION_FRAME_CHANGED" }).then(resolve,reject)
        } catch (error) { reject(error) }
      })
    })
  }
})

test("native ready write failure provides no releasable flush", async () => {
  const sink = new Writable({ write(_bytes,_encoding,done) { done() } })
  const proc = { stdout:sink,stderr:sink }
  sourceCredential.protect(proc)
  sink.emit("error",new Error("owned sink failure"))
  await new Promise((resolve,reject) => {
    sourceCredential.writeNativeReady(proc,Buffer.from("ready\n"),(error,flush) => {
      try { assert.equal(error.code,"TEXT_PROTECTION_SINK_ERROR"); assert.equal(flush,undefined); resolve() }
      catch (error) { reject(error) }
    })
  })
  sink.destroy()
})

test("native ready release cannot unmask stderr or a non-delimiter retained byte", async () => {
  for (const changedTail of [false,true]) {
    const { proc,output } = fixtureProcess()
    sourceCredential.protect(proc,"0a112233-4455-4677-8899-aabbccddeeff")
    sourceCredential.protect(proc,"xy")
    proc.stderr.write("\n")
    await new Promise((resolve,reject) => {
      sourceCredential.writeNativeReady(proc,Buffer.from("ready\n"),(error,flush) => {
        try {
          assert.ifError(error)
          if (changedTail) proc.stdout.__desk_text_protection_v3__.tail = Buffer.from("x")
          flush().then(resolve,reject)
        } catch (error) { reject(error) }
      })
    })
    assert.equal(output.stdout.join(""),changedTail ? "ready<token>" : "ready\n")
    assert.equal(output.stderr.join(""),"<token>")
  }
})

test("stream rejection and graceful drain expose actual errors without releasing quarantine or accepting invalid chunks", async () => {
  const chunks = [], completions = []
  const sink = new Writable({ write(bytes, _encoding, done) { chunks.push(Buffer.from(bytes)); completions.push(done) } })
  const proc = { stdout: sink, stderr: sink }
  sourceCredential.protect(proc, "secret-value")
  assert.throws(() => sink.write({ unsupported: true }), { code: "ERR_INVALID_ARG_TYPE" })
  sink.write("safe")
  const waiting = sourceCredential.flushProtection(proc)
  completions.shift()(new Error("owned sink failure"))
  await assert.rejects(waiting, { code: "TEXT_PROTECTION_SINK_ERROR" })
  await new Promise(resolve => sink.write("secret-value", error => { assert.equal(error.code, "TEXT_PROTECTION_SINK_ERROR"); resolve() }))
  assert.equal(Buffer.concat(chunks).toString(), "safe")
  const f = fixtureProcess()
  sourceCredential.protect(f.proc, "secret-value")
  f.proc.stdout.write("sec")
  await sourceCredential.flushProtection(f.proc)
  f.proc.stdout.write("unrelated")
  await sourceCredential.flushProtection(f.proc)
  assert.equal(f.output.stdout.join(""), "<token>unrelated")
  const error = new Error("secret-value")
  error.code = "OWNED"; error.resources = { contextId: "kept" }
  assert.deepEqual(sourceCredential.redactProtected(proc, error), { code: "OWNED", message: "<token>", resources: { contextId: "kept" } })
})

test("actual reader handles SQLite fallback, absent/unavailable drivers, UTF16 and filtered LevelDB copies", async () => {
  const root = await mkTempRoot("credential-reader-boundaries-"), profile = path.join(root, "profile")
  mkdirSync(profile)
  writeFileSync(path.join(profile, "LocalStorage"), "owned synthetic driver input")
  let closed = 0, row = { value: Buffer.concat([Buffer.from([0]), Buffer.from("utf16-value", "utf16le")]), compression: 0 }
  class DatabaseSync {
    prepare(sql) {
      assert.match(sql, /JOIN maps/)
      return { get(storage, key) { assert.equal(storage.toString(), "chrome-extension://mmlmfjhmonkocbjadbfplnigmagldckm/"); assert.equal(key.subarray(1).toString(), "auth-token"); return row } }
    }
    close() { closed++ }
  }
  const deps = { tmpdir: root, sqlite: { DatabaseSync } }
  assert.equal(await sourceCredential.readExtensionToken(profile, deps), "utf16-value")
  writeFileSync(path.join(profile, "LocalStorage-wal"), "owned synthetic WAL")
  row = { value: Buffer.from([1, 65]), compression: 0 }
  assert.equal(await sourceCredential.readExtensionToken(profile, deps), "A")
  row = undefined
  assert.equal(await sourceCredential.readExtensionToken(profile, deps), null)
  row = { compression: 1 }
  assert.equal(await sourceCredential.readExtensionToken(profile, deps), null)
  assert.equal(closed, 4)
  assert.equal(await sourceCredential.readExtensionToken(profile, { tmpdir: root, sqlite: null }), null)
  const unavailable = templateCredential({ "node:sqlite": null })
  assert.equal(await unavailable.readExtensionToken(profile, { tmpdir: root }), null)
  const noDriver = templateCredential({}, mcpRoot)
  // Actual Node SQLite import; empty synthetic DB is legitimate, no production
  // profile is consulted. Missing schema throws after closing its owned copy.
  fs.unlinkSync(path.join(profile, "LocalStorage-wal"))
  fs.truncateSync(path.join(profile, "LocalStorage"), 0)
  await assert.rejects(noDriver.readExtensionToken(profile, { tmpdir: root }))
  const missingModule = loadTemplate(path.join(mcpRoot, "web-extension-credential.cjs"), {
    module: { exports: {} }, __dirname: mcpRoot, process, Buffer, setTimeout, clearTimeout,
    require(name) { if (name === "node:sqlite") throw Error("owned unavailable driver"); return require(name) },
  })
  assert.equal(await missingModule.readExtensionToken(profile, { tmpdir: root }), null)
  for (const invalid of [{ extensionId: 1 }, { extensionId: "bad" }, { tokenKey: false }, { tokenKey: "bad key" }])
    await assert.rejects(sourceCredential.readExtensionToken(profile, { ...deps, ...invalid }), /browser_token_identity_invalid/)
  const levelPath = path.join(profile, "Local Storage/leveldb")
  mkdirSync(levelPath, { recursive: true })
  writeFileSync(path.join(levelPath, "LOCK"), "never copied")
  writeFileSync(path.join(levelPath, "000001.log"), "owned storage observation")
  let iterations = 0
  class ClassicLevel {
    constructor(copy) {
      assert.equal(existsSync(path.join(copy, "LOCK")), false)
      assert.equal(readFileSync(path.join(copy, "000001.log"), "utf8"), "owned storage observation")
    }
    iterator() {
      return {
        async next() {
          return ++iterations === 1 ? [Buffer.from("unrelated"), Buffer.from([1, 88])] :
            [Buffer.from("_chrome-extension://" + "a".repeat(32) + "\u0000\u0001custom-key", "latin1"), Buffer.concat([Buffer.from([0]), Buffer.from("selected", "utf16le")])]
        }, async close() {},
      }
    }
    async close() {}
  }
  assert.equal(await sourceCredential.readExtensionToken(profile, { tmpdir: root, level: { ClassicLevel }, extensionId: "a".repeat(32), tokenKey: "custom-key" }), "selected")
  assert.equal(iterations, 2)
  assert.deepEqual(fs.readdirSync(root), ["profile"], "all temporary storage copies closed/removed")
})

test("public code rejects noncanonical roots, invalid relative paths, size and identity races", async () => {
  const root = await mkTempRoot("credential-public-fences-"), file = path.join(root, "module.cjs")
  writeFileSync(file, "module.exports = 1")
  for (const relative of ["", ".", "../module.cjs", "./module.cjs"])
    assert.throws(() => sourceCredential.publicCode(root, relative), { code: "NATIVE_CODE_UNAVAILABLE" })
  assert.throws(() => sourceCredential.publicCode(root + "/.", "module.cjs"), { code: "NATIVE_CODE_UNAVAILABLE" })
  assert.throws(() => sourceCredential.publicCode(file, "module.cjs"), { code: "NATIVE_CODE_UNAVAILABLE" })
  for (const mutation of ["size", "identity"]) {
    let calls = 0
    const observed = Object.create(fs)
    observed.lstatSync = function (name, options) {
      const stat = fs.lstatSync(name, options)
      if (name === file && options?.bigint) {
        calls++
        if (mutation === "size") return { ...stat, size: 4194305n }
        if (calls === 2) return { ...stat, ino: different(stat.ino) }
      }
      return stat
    }
    const helper = templateCredential({ fs: observed })
    assert.throws(() => helper.publicCode(root, "module.cjs"), { code: mutation === "size" ? "NATIVE_CODE_UNAVAILABLE" : "NATIVE_CODE_CHANGED" })
  }
})

test("Windows private-generation and receipt verdicts use the genuine SID/DACL command boundary", async () => {
  const { installed, lib } = await staged(), executions = []
  const proc = { platform: "win32", env: { irrelevant: "x", SystemRoot: "C:\\Windows" }, stdout: { write() {} }, stderr: { write() {} } }
  let verdict = "private"
  const child = { execFileSync(file, args, options) {
    assert.equal(file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
    assert.ok(args.includes("-NonInteractive"))
    assert.match(args.at(-1), /SecurityIdentifier|WindowsIdentity/)
    executions.push(JSON.parse(options.input))
    return args.at(-1).includes("SetAccessRuleProtection") ? "" : verdict
  } }
  const helper = templateCredential({ child_process: child }, lib, proc)
  helper.privateGeneration(installed.dir)
  helper.privateGeneration(installed.dir, path.join(installed.dir, "playwright-patch.json"))
  assert.equal(helper.verifyGeneration(installed, mcpRoot).receipt.revision, patch.REVISION)
  verdict = "exposed"
  assert.throws(() => helper.verifyGeneration(installed, mcpRoot), { code: "NATIVE_PRIVATE_PATH_INVALID" })
  for (const env of [{}, { SYSTEMROOT: "relative" }]) {
    const invalid = templateCredential({ child_process: child }, lib, { ...proc, env })
    assert.throws(() => invalid.privateGeneration(installed.dir), { code: "NATIVE_PRIVATE_PATH_INVALID" })
    assert.throws(() => invalid.verifyGeneration(installed), { code: "NATIVE_PRIVATE_PATH_INVALID" })
  }
  assert.deepEqual(executions[0], [installed.dir])
  assert.equal(executions[1].length, 2)
  assert.throws(() => helper.privateGeneration(path.join(lib, "coreBundle.js")), { code: "NATIVE_PRIVATE_PATH_INVALID" })
  const posixFs = Object.create(fs)
  posixFs.lstatSync = (...args) => {
    const stat = fs.lstatSync(...args), permissions = stat.isDirectory() ? 0o700 : 0o600
    const mode = typeof stat.mode === "bigint" ? (stat.mode & ~0o777n) | BigInt(permissions) : (stat.mode & ~0o777) | permissions
    return Object.assign(Object.create(stat), { mode })
  }
  const wrongOwner = templateCredential({ fs: posixFs }, lib, { ...process, platform: "linux", getuid: () => fs.lstatSync(installed.dir).uid + 1 })
  assert.throws(() => wrongOwner.privateGeneration(installed.dir), { code: "NATIVE_PRIVATE_PATH_INVALID" })
  assert.throws(() => wrongOwner.verifyGeneration(installed), { code: "NATIVE_PRIVATE_PATH_INVALID" })
  const wrongWindowsOwner = templateCredential({ fs: posixFs, child_process: child }, lib,
    { ...proc, getuid: () => fs.lstatSync(installed.dir).uid + 1 })
  assert.throws(() => wrongWindowsOwner.verifyGeneration(installed), { code: "NATIVE_PRIVATE_PATH_INVALID" })
  let macChecks = 0
  const macACL = templateCredential({ fs: posixFs, child_process: { execFileSync() { macChecks++; return " 0: user:other allow read" } } }, lib, { ...process, platform: "darwin" })
  assert.throws(() => macACL.verifyGeneration(installed), { code: "NATIVE_PRIVATE_PATH_INVALID" })
  assert.equal(macChecks, 1, "the modeled POSIX metadata must reach the actual macOS ACL branch")
})

test("normal code import closure retains builtin capability fallback and rejects external imports", async () => {
  const api = require("node:module")
  assert.equal(api.isBuiltin("node:sqlite"), true, "this admitted Node supports the optional stock reader builtin")
  // Node omits prefix-only builtins from builtinModules; the boundary models a
  // complete older enumeration API for the same real host capabilities.
  assert.equal(templateCredential({ module: { builtinModules: [...api.builtinModules, "sqlite"] } }).nativeInventory(realpathSync(mcpRoot)).length, 13)
  assert.throws(() => templateCredential({ module: {} }).nativeInventory(realpathSync(mcpRoot)), { code: "NATIVE_CODE_UNAVAILABLE" })
  const root = path.join(await mkTempRoot("credential-external-import-"), "mcp")
  for (const item of sourceCredential.nativeInventory(realpathSync(mcpRoot))) {
    mkdirSync(path.dirname(path.join(root, item.path)), { recursive: true })
    copyFileSync(path.join(mcpRoot, item.path), path.join(root, item.path))
  }
  fs.appendFileSync(path.join(root, "src/util/broker-error.mjs"), '\nimport "not-a-builtin";\n')
  assert.throws(() => sourceCredential.nativeInventory(root), { code: "NATIVE_CODE_UNAVAILABLE" })
})

test("Windows generation ACL pairs retain identity fences around each single provider request", async () => {
  const { installed, lib } = await staged(), receiptFile = path.join(installed.dir, "playwright-patch.json")
  const proc = { platform: "win32", env: { SystemRoot: "C:\\Windows" } }
  const expected = [{ file: installed.dir, directory: true }, { file: receiptFile, directory: false }]
  let calls = 0, mutation
  const child = { execFileSync(_file, args, options) {
    calls++
    assert.deepEqual(JSON.parse(options.input), expected)
    assert.match(args.at(-1), /foreach/)
    assert.match(args.at(-1), /PSIsContainer/)
    assert.match(args.at(-1), /AreAccessRulesProtected/)
    assert.match(args.at(-1), /GetAccessRules\(\$true,\$true/)
    if (mutation?.failure && calls === mutation.batch) throw Error("owned ACL refusal")
    return "private"
  } }
  const observed = Object.create(fs)
  observed.lstatSync = (file, options) => {
    const stat = fs.lstatSync(file, options)
    if (mutation && options?.bigint && file === mutation.file && calls === mutation.batch)
      return { ...stat, [mutation.key]: different(stat[mutation.key]) }
    return stat
  }
  const helper = templateCredential({ fs: observed, child_process: child }, lib, proc)
  assert.equal(helper.verifyGeneration(installed, mcpRoot).receipt.revision, patch.REVISION)
  assert.equal(calls, 2, "each complete verification retains its before/after pair but starts only two providers")
  for (const batch of [1, 2]) {
    for (const file of [installed.dir, receiptFile]) {
      for (const key of ["dev", "ino", "size", "ctimeNs", "mtimeNs"]) {
        calls = 0; mutation = { file, batch, key }
        assert.throws(() => helper.verifyGeneration(installed, mcpRoot), { code: "NATIVE_CODE_CHANGED" }, `${batch}:${file}:${key}`)
        assert.equal(calls, batch)
      }
    }
    calls = 0; mutation = { failure: true, batch }
    assert.throws(() => helper.verifyGeneration(installed, mcpRoot), /owned ACL refusal/)
    assert.equal(calls, batch, "a failed whole batch must not yield a partial qualification")
  }
  for (const file of [installed.dir, receiptFile]) {
    calls = 0; mutation = null
    observed.lstatSync = (name, options) => {
      const stat = fs.lstatSync(name, options)
      return name === file ? Object.assign(Object.create(stat), { isSymbolicLink: () => true }) : stat
    }
    assert.throws(() => helper.verifyGeneration(installed, mcpRoot), { code: "NATIVE_PRIVATE_PATH_INVALID" })
    assert.equal(calls, 0, "both Node kind checks must precede the provider")
  }
})

test("real OS private-generation qualification rejects exposure of either member", async t => {
  const { installed, lib } = await staged(), receiptFile = path.join(installed.dir, "playwright-patch.json")
  const requests = []
  const helper = templateCredential({ child_process: { execFileSync(...args) {
    const start = performance.now()
    try { return execFileSync(...args) }
    finally { requests.push(performance.now() - start) }
  } } }, lib)
  assert.equal(helper.verifyGeneration(installed, mcpRoot).receipt.revision, patch.REVISION)
  const expectedRequests = process.platform === "win32" ? 2 : process.platform === "darwin" ? 4 : 0
  assert.equal(requests.length, expectedRequests)
  t.diagnostic(JSON.stringify({ platform: process.platform, qualificationProviderRequests: requests.length,
    providerMilliseconds: requests.map(value => Math.round(value)) }))
  for (const file of [installed.dir, receiptFile]) {
    if (process.platform === "win32") {
      const key = Object.keys(process.env).find(name => name.toLowerCase() === "systemroot")
      const script = "$ErrorActionPreference='Stop';$p=[Console]::In.ReadToEnd()|ConvertFrom-Json;" +
        "$i=Get-Item -LiteralPath $p -Force;$a=$i.GetAccessControl('Access');" +
        "$a.SetAccessRuleProtection($false,$true);$i.SetAccessControl($a)";
      execFileSync(path.win32.join(process.env[key], "System32/WindowsPowerShell/v1.0/powershell.exe"),
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { input: JSON.stringify(file), encoding: "utf8", timeout: 5000, windowsHide: true })
    } else fs.chmodSync(file, file === installed.dir ? 0o755 : 0o644)
    assert.throws(() => helper.verifyGeneration(installed, mcpRoot), undefined, file)
    sourceCredential.privateGeneration(installed.dir, receiptFile)
    assert.equal(helper.verifyGeneration(installed, mcpRoot).receipt.revision, patch.REVISION)
  }
})

test("private receipt refuses schema/capture/proof changes and observed identity replacements", async () => {
  const { installed, lib } = await staged(), receiptFile = path.join(installed.dir, "playwright-patch.json")
  const coreFile = path.join(lib, "coreBundle.js"), receiptBytes = readFileSync(receiptFile), coreBytes = readFileSync(coreFile)
  const sha = bytes => require("node:crypto").createHash("sha256").update(bytes).digest("hex")
  for (const mutation of ["large", "null", "version", "core", "mcp", "capture-array", "capture-root", "capture-order", "proof", "error-proof",
    "missing-region", "missing-end", "duplicate-region"]) {
    const receipt = JSON.parse(receiptBytes)
    let bytes = coreBytes
    if (mutation === "version") receipt.revision = 2
    if (mutation === "core") receipt.coreVersion = "wrong"
    if (mutation === "mcp") receipt.mcpVersion = "wrong"
    if (mutation === "capture-array") receipt.nativeRuntime.discoveryInputs.browserEnv = []
    if (mutation === "capture-root") receipt.nativeRuntime.discoveryInputs.browserEnv = { INVALID: "x" }
    if (mutation === "capture-order") receipt.nativeRuntime.discoveryInputs = Object.fromEntries(Object.entries(receipt.nativeRuntime.discoveryInputs).reverse())
    if (mutation === "proof") receipt.guardedRegionProofs[0].patched = "0".repeat(64)
    if (mutation === "error-proof") receipt.errorRegionProofs.core[0].patched = "0".repeat(64)
    if (mutation === "missing-region") bytes = Buffer.from(coreBytes.toString().replace("async function createBrowser(config,", "async function notCreateBrowser(config,"))
    if (mutation === "missing-end") bytes = Buffer.from(coreBytes.toString().replace("\nasync function connectToBrowserEndpoint(", "\nasync function notConnectToBrowserEndpoint("))
    if (mutation === "duplicate-region") bytes = Buffer.concat([coreBytes, Buffer.from("\nasync function createBrowser(config,")])
    receipt.bundleSha256 = sha(bytes)
    writeFileSync(coreFile, bytes)
    writeFileSync(receiptFile, mutation === "large" ? "x".repeat(65537) : mutation === "null" ? "null" : JSON.stringify(receipt))
    assert.throws(() => sourceCredential.verifyGeneration(installed, mcpRoot),
      { code: mutation.startsWith("capture") ? "NATIVE_DISCOVERY_INPUTS_UNAVAILABLE" : "NATIVE_CODE_UNAVAILABLE" }, mutation)
    writeFileSync(coreFile, coreBytes); writeFileSync(receiptFile, receiptBytes)
  }
  for (const mutation of ["receipt-read", "receipt-final", "directory", "lib"]) {
    let receiptObservations = 0, directoryObservations = 0
    const observed = Object.create(fs)
    observed.lstatSync = (file, options) => {
      const stat = fs.lstatSync(file, options)
      if (options?.bigint && file === receiptFile && ++receiptObservations === (mutation === "receipt-read" ? 2 : 3) && mutation.startsWith("receipt"))
        return { ...stat, ino: different(stat.ino) }
      if (options?.bigint && file === installed.dir && ++directoryObservations === 2 && mutation === "directory")
        return { ...stat, ino: different(stat.ino) }
      return stat
    }
    observed.realpathSync = file => file === lib && mutation === "lib" ? path.join(lib, "replacement") : fs.realpathSync(file)
    assert.throws(() => templateCredential({ fs: observed }, lib).verifyGeneration(installed),
      { code: mutation === "lib" ? "NATIVE_CODE_UNAVAILABLE" : "NATIVE_CODE_CHANGED" })
  }
  assert.equal(sourceCredential.verifyGeneration(installed, mcpRoot).receipt.revision, patch.REVISION)
})

test("native binding uses a strict presence gate before loading a client/helper", () => {
  for (const record of [null, false, undefined, [], {}])
    assert.throws(() => sourceCredential.validateNativeBinding(record, {}), { code: "NATIVE_CONFIG_INVALID" })
})

test("public thirteen-module closure permits ordinary code modes but refuses an outside dependency", async () => {
  const root = path.join(await mkTempRoot("native-E-public-closure-"), "mcp")
  for (const { path: name } of sourceCredential.nativeInventory(realpathSync(mcpRoot))) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true, mode: 0o755 })
    copyFileSync(path.join(mcpRoot, name), path.join(root, name))
  }
  assert.equal(sourceCredential.nativeInventory(root).length, 13)
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

test("real staged current revision binds the exact normal root closure and source changes invalidate it", async () => {
  const { installed, lib } = await staged()
  assert.equal(patch.readRevision(installed), patch.REVISION)
  const receipt = JSON.parse(readFileSync(path.join(installed.dir, "playwright-patch.json")))
  assert.equal(receipt.nativeRuntime.mcpRoot, realpathSync(mcpRoot))
  assert.equal(receipt.nativeRuntime.modules.length, 13)
  assert.deepEqual(receipt.nativeRuntime.modules.filter(item => item.path.startsWith("../")).map(item => item.path), [
    "../browser-context-broker/src/primitives/broker-error.mjs",
    "../browser-context-broker/src/primitives/private-state.mjs",
  ])
  assert.equal(receipt.nativeRuntime.discoveryInputs.version, 1)
  assert.ok(existsSync(path.join(lib, "desk-native-relay.cjs")))
  const changed = path.join(lib, "desk-native-relay.cjs")
  writeFileSync(changed, readFileSync(changed, "utf8") + "\n// drift\n")
  assert.equal(patch.readRevision(installed), 0)
})

test("installed receipt refuses a missing, linked or tampered readonly worker before native use", async () => {
  const { installed, lib } = await staged()
  const worker = path.join(realpathSync(mcpRoot), "web-native-private-path.cjs")
  const receipt = sourceCredential.verifyGeneration(installed, mcpRoot).receipt
  assert.ok(receipt.nativeRuntime.modules.some(item => item.path === "web-native-private-path.cjs"))
  for (const mode of ["missing", "linked", "tampered"]) {
    const observed = Object.create(fs)
    observed.lstatSync = function (name, options) {
      if (name === worker && mode === "missing") throw Object.assign(Error("owned missing worker"), { code: "ENOENT" })
      const stat = fs.lstatSync(name, options)
      return name === worker && mode === "linked" ? Object.assign(Object.create(stat), { isSymbolicLink: () => true }) : stat
    }
    observed.readFileSync = function (name, options) {
      const bytes = fs.readFileSync(name, options)
      return name === worker && mode === "tampered" ? Buffer.concat([bytes, Buffer.from("\n// owned worker drift\n")]) : bytes
    }
    assert.throws(() => templateCredential({ fs: observed }, lib).verifyGeneration(installed, mcpRoot),
      mode === "missing" ? { code: "ENOENT" } : { code: "NATIVE_CODE_UNAVAILABLE" })
  }
  assert.equal(sourceCredential.verifyGeneration(installed, mcpRoot).receipt.revision, patch.REVISION)
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
  loadTemplate(path.join(mcpRoot, "web-extension-credential.cjs"), {
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

test("legacy encoded writes and all UTF16 odd splits protect actual bytes without changing unrelated output", async () => {
  const secret = "owned-π-credential", encodings = ["", null, undefined, false, 0, "utf8", "utf-8", "utf16le", "utf-16le", "ucs2", "ucs-2", "latin1", "binary", "ascii", "hex", "base64", "base64url"]
  for (const encoding of encodings) {
    const plain = [], control = new Writable({ write(data, _enc, done) { plain.push(Buffer.from(data)); done() } })
    control.write(secret, encoding)
    assert.deepEqual(Buffer.concat(plain), Buffer.from(secret, encoding), "genuine Node encoding/default control")
    const bytes = Buffer.from(secret, encoding)
    for (let split = 0; split < Math.max(1, bytes.length); split++) {
      const output = [], calls = [], sink = new Writable({ write(data, _enc, done) { output.push(Buffer.from(data)); done() } })
      const proc = { stdout: sink, stderr: sink }
      sourceCredential.protect(proc, secret)
      sink.write("before ", encoding, error => calls.push(error || 1))
      if (split === 0) sink.write(secret, encoding, error => calls.push(error || 2))
      else {
        sink.write(bytes.subarray(0, split), error => calls.push(error || 2))
        sink.write(new Uint8Array(bytes.buffer, bytes.byteOffset + split, bytes.length - split), error => calls.push(error || 3))
      }
      sink.write(" after", encoding, error => calls.push(error || 4))
      await sourceCredential.flushProtection(proc)
      await new Promise(resolve => setImmediate(resolve))
      assert.deepEqual(Buffer.concat(output), Buffer.concat([
        Buffer.from("before ", encoding), Buffer.from("<token>", encoding), Buffer.from(" after", encoding),
      ]), `${encoding} split ${split}`)
      assert.deepEqual(calls, split === 0 ? [1, 2, 4] : [1, 2, 3, 4])
    }
  }
  for (const encoding of ["utf16le", "ucs2"]) {
    const output = [], sink = new Writable({ write(bytes, _encoding, done) { output.push(Buffer.from(bytes)); done() } })
    const proc = { stdout: sink, stderr: sink }
    sourceCredential.protect(proc, secret)
    for (const byte of Buffer.from(secret, encoding))
      await new Promise(resolve => proc.stdout.write(Buffer.from([byte]), resolve))
    await sourceCredential.flushProtection(proc)
    assert.deepEqual(Buffer.concat(output), Buffer.from("<token>", encoding))
  }
})

test("UTF16 URI/JSON forms survive every odd boundary and flush quarantines incomplete encoded continuations", async () => {
  const secret = 'ws://127.0.0.1:9/extension/owned-π-"capability"'
  for (const form of [secret, encodeURIComponent(secret), encodeURI(secret), JSON.stringify(secret).slice(1, -1),
    JSON.stringify(secret).slice(1, -1).replaceAll("/", "\\/")]) {
    const bytes = Buffer.from(form, "utf16le")
    for (let split = 1; split < bytes.length; split += 2) {
      const output = [], sink = new Writable({ highWaterMark: 1, write(data, _enc, done) { output.push(Buffer.from(data)); setImmediate(done) } })
      const proc = { stdout: sink, stderr: sink }
      sourceCredential.protect(proc, secret)
      assert.equal(sink.write(bytes.subarray(0, split)), true, "held odd prefix creates no false backpressure")
      await new Promise(resolve => sink.write(bytes.subarray(split), resolve))
      await sourceCredential.flushProtection(proc)
      assert.deepEqual(Buffer.concat(output), Buffer.from("<token>", "utf16le"))
      assert.equal(sink.destroyed, false)
    }
  }
  const output = [], sink = new Writable({ write(data, _enc, done) { output.push(Buffer.from(data)); done() } })
  const proc = { stdout: sink, stderr: sink }, bytes = Buffer.from(secret, "ucs2")
  sourceCredential.protect(proc, secret)
  sink.write(bytes.subarray(0, 9))
  await sourceCredential.flushProtection(proc, { final: false })
  for (const byte of bytes.subarray(9)) await new Promise(resolve => sink.write(Buffer.from([byte]), resolve))
  await sourceCredential.flushProtection(proc, { final: true })
  sink.write(secret, "ucs-2")
  await sourceCredential.flushProtection(proc)
  assert.deepEqual(Buffer.concat(output), Buffer.concat([Buffer.from("<token>"), Buffer.from("<token>", "utf16le")]))
})

test("unsupported encoding refuses before output and encoded-form bounds include UTF16 and URI/JSON forms", async () => {
  const { proc, output } = fixtureProcess()
  sourceCredential.protect(proc, "owned-secret")
  for (const input of ["owned-secret", Buffer.from("safe")]) {
    let callback
    assert.equal(proc.stdout.write(input, "not-an-encoding", error => { callback = error }), false)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(callback.code, "TEXT_PROTECTION_ENCODING_UNSUPPORTED")
  }
  assert.equal(output.stdout.join(""), "")
  assert.throws(() => sourceCredential.protect(proc, "x".repeat(32769)), { code: "TEXT_PROTECTION_FORM_TOO_LARGE" })
  assert.throws(() => sourceCredential.protect(proc, "/".repeat(11000)), { code: "TEXT_PROTECTION_FORM_TOO_LARGE" })
  assert.throws(() => sourceCredential.protect(proc, '"'.repeat(17000)), { code: "TEXT_PROTECTION_FORM_TOO_LARGE" })
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
  loadTemplate(path.join(mcpRoot, "web-extension-credential.cjs"), {
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
  const output = [], sink = new Writable({ write(bytes, _encoding, done) { output.push(Buffer.from(bytes)); done() } })
  const proc = { stdout: sink, stderr: sink }, secret = "x".repeat(32767) + "!", bytes = Buffer.from(secret, "utf16le")
  sourceCredential.protect(proc, secret)
  for (let index = 0; index < 65535; index += 257) {
    proc.stdout.write(bytes.subarray(index, Math.min(65535, index + 257)))
    assert.ok(proc.stdout.__desk_text_protection_v3__.tail.length <= 65535)
  }
  assert.equal(proc.stdout.__desk_text_protection_v3__.tail.length, 65535)
  await sourceCredential.flushProtection(proc, { final: true })
  proc.stdout.write(bytes.subarray(65535))
  proc.stdout.write(bytes)
  await sourceCredential.flushProtection(proc)
  assert.deepEqual(Buffer.concat(output), Buffer.concat([Buffer.from("<token>"), Buffer.from("<token>", "utf16le")]))
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
  mkdirSync(path.join(lib, "tools/cli-client"), { recursive: true })
  writeFileSync(path.join(lib, "tools/cli-client/session.js"), errorFixture.sessionSource)
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
