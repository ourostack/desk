import "../_isolated_env.mjs"
import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs/promises"
import { createRequire } from "node:module"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { fileURLToPath } from "node:url"
const require = createRequire(import.meta.url), run = promisify(execFile)
const observer = require("./fixtures/native-provider-startup-observer.cjs")
const canonical = new URL("../../../../../plugins/desk/mcp/src/browser/native-provider.mjs", import.meta.url)

test("startup observation refuses unknown source and never reads getters or private error projections", async () => {
  const source = await fs.readFile(canonical, "utf8")
  const transformed = observer.instrument(source)
  assert.notEqual(transformed, source)
  assert.match(transformed, /__deskStartupPhase = 'reserve-ready'/u)
  assert.throws(() => observer.instrument(source + "\n"), /refuse unknown provider source/u)
  let getters = 0
  const error = {}
  for (const key of ["code", "status", "signal", "message", "stack", "constructor", "toString"])
    Object.defineProperty(error, key, { get() { getters++; throw Error("PRIVATE_GETTER") } })
  const row = observer.metadata("PRIVATE_PHASE", error, 3)
  assert.equal(getters, 0)
  assert.equal(row.originalCode, "unknown")
  assert.equal(row.phase, "unknown")
  assert.doesNotMatch(JSON.stringify(row), /PRIVATE/u)
})

test("startup catch observation preserves original cleanup, outgoing error identity and sink failure neutrality", async t => {
  const original = Object.getOwnPropertyDescriptor(globalThis, observer.KEY)
  t.after(() => {
    if (original) Object.defineProperty(globalThis, observer.KEY, original)
    else delete globalThis[observer.KEY]
  })
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
  for (const catchSource of [observer.CATCH, observer.OBSERVED_CATCH]) {
    for (const innerCode of ["EIO", "NATIVE_STATE_CHANGED"]) {
    for (const closeFails of [false, true]) {
      let calls = 0
      const inner = Object.assign(new Error("PRIVATE_INNER"), { code: innerCode }), outgoing = new Error("wrapped")
      const closeError = new Error("PRIVATE_CLOSE")
      Object.defineProperty(globalThis, observer.KEY, { configurable: true, value() { throw Error("PRIVATE_SINK") } })
      const execute = new AsyncFunction("close", "fail", "inner",
        "const __deskStartupPhase='reserve-ready',__deskStartupAt=performance.now();try { throw inner; " + catchSource)
      await assert.rejects(execute(async () => { calls++; if (closeFails) throw closeError },
        code => { assert.equal(code, innerCode === "NATIVE_STATE_CHANGED" ? innerCode : "NATIVE_PROVIDER_START_FAILED"); return outgoing }, inner),
      error => error === (closeFails ? closeError : outgoing))
      assert.equal(calls, 1)
    }
    }
  }
})

test("actual supported loader observes canonical provider URL without replacing its dependency resolution", async () => {
  const preload = fileURLToPath(new URL("./fixtures/native-provider-startup-observer.cjs", import.meta.url))
  const env = { ...process.env, DESK_TEST_NATIVE_STARTUP_OBSERVATION: "1" }
  delete env.NODE_TEST_CONTEXT
  const result = await run(process.execPath, [...process.execArgv, "--require", preload, "--input-type=module",
    "--eval", `const value=await import(${JSON.stringify(canonical.href)});if(typeof value.startNativeProvider!=='function')throw Error('PROVIDER_EXPORT_MISSING');console.log('ACTUAL_PROVIDER_MODULE_LOADED')`],
  { env, timeout: 10000, maxBuffer: 65536 })
  assert.match(result.stdout, /DESK_NATIVE_PROVIDER_STARTUP_SOURCE_V1/u)
  assert.match(result.stdout, /ACTUAL_PROVIDER_MODULE_LOADED/u)
})

test("actual Windows provider startup observes the original prefix and three failed cases without relaxing admission", {
  skip: process.platform !== "win32", timeout: 600000,
}, async t => {
  const target = fileURLToPath(new URL("./browser_context_runtime.test.js", import.meta.url))
  const preload = fileURLToPath(new URL("./fixtures/native-provider-startup-observer.cjs", import.meta.url))
  const names = "^(?:fresh worker refuses unknown modes before loading CLI modules|" +
    "actual maintained daemon options can reach native acquisition using the strict owner config alone|" +
    "initial signed worker (?:codec-binding|initial-daemon) reports safe refusal at verification [12]|" +
    "signed worker keeps actual privately generated persistent metadata without replacement|" +
    "signed worker inventory retains the normal-parent socket root after owner environment isolation|" +
    "signed page command honors real minimist inner delimiter and current help schema)$"
  const env = { ...process.env, DESK_TEST_NATIVE_STARTUP_OBSERVATION: "1" }
  delete env.NODE_TEST_CONTEXT // Fresh controller; every original isolation preload/location is retained.
  let result
  try {
    const completed = await run(process.execPath, [...process.execArgv, "--require", preload,
      "--test", "--test-reporter=tap", "--test-name-pattern=" + names, target],
    { env, windowsHide: true, timeout: 540000, maxBuffer: 2 * 1024 * 1024 })
    result = { code: 0, signal: null, ...completed }
  } catch (error) {
    if (!Number.isInteger(error.code) && error.killed !== true) throw error
    result = { code: error.code ?? null, signal: error.signal ?? null, stdout: error.stdout, stderr: error.stderr }
  }
  const marker = "DESK_NATIVE_PROVIDER_STARTUP_DIAGNOSTIC_V1 "
  const rows = result.stdout.split("\n").filter(line => line.includes(marker))
    .map(line => JSON.parse(line.split(marker)[1]))
  if (result.code !== 0) {
    t.diagnostic("Original selected prefix stdout:\n" + result.stdout.slice(-12000))
    t.diagnostic("Original selected prefix stderr:\n" + result.stderr.slice(-2000))
  }
  t.diagnostic("DESK_NATIVE_STARTUP_PACKET_V1 " + JSON.stringify({ nodeVersion: process.version,
    grade: "diagnostic_transform_only_not_normal_qualification", originalPrefixExit: result.code,
    originalPrefixSignal: result.signal, startupObservations: rows }))
  assert.match(result.stdout, /DESK_NATIVE_PROVIDER_STARTUP_SOURCE_V1/u)
  assert.ok(rows.length >= 3, "all three actual signed fixture startups must be observed")
  assert.equal(result.code, 0, "original startup/admission assertions remain authoritative")
})
