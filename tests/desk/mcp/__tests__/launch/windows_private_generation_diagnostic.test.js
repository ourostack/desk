// Diagnostic only: run the unchanged real private lifecycle with first-read evidence.
import "../_isolated_env.mjs"
import { test, mock, after } from "node:test"
import assert from "node:assert/strict"
import childProcess from "node:child_process"
import { syncBuiltinESMExports } from "node:module"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const command = pid => `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${pid}"; if ($p) { $p.CreationDate.ToUniversalTime().ToString("o") }`
const originalExecFile = childProcess.execFile

function own(value, key) {
  try {
    const descriptor = value && Object.getOwnPropertyDescriptor(value, key)
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch { return undefined }
}

function describeError(error) {
  if (error === null || error === undefined) return null
  const code = own(error, "code"), signal = own(error, "signal")
  return {
    code: (Number.isInteger(code) && code >= 0 && code <= 255) ||
      ["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "EIO", "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"].includes(code) ? code : "unknown",
    signal: ["SIGTERM", "SIGKILL"].includes(signal) ? signal : "unknown",
    killed: own(error, "killed") === true,
  }
}

function observe(execute, rows) {
  return function(file, argv, options, callback) {
    const text = Array.isArray(argv) ? argv[3] : null
    const match = typeof text === "string" && /ProcessId=([1-9][0-9]*)"/u.exec(text)
    const pid = match ? Number(match[1]) : null
    if (typeof file !== "string" || !Array.isArray(argv) || path.win32.basename(file).toLowerCase() !== "powershell.exe" ||
        argv[0] !== "-NoProfile" || argv[1] !== "-NonInteractive" || argv[2] !== "-Command" ||
        !Number.isSafeInteger(pid) || text !== command(pid) || own(options, "timeout") !== 5000 ||
        typeof callback !== "function") return execute.apply(this, arguments)
    const row = { pid, timeoutMs: 5000, completed: false }
    const started = performance.now()
    rows.push(row)
    return execute.call(this, file, argv, options, function(error, stdout, stderr) {
      row.completed = true
      row.elapsedMs = Math.round(performance.now() - started)
      row.error = describeError(error)
      row.outputPresent = typeof stdout === "string" && stdout.trim().length > 0
      row.outputDateParseable = typeof stdout === "string" && Number.isFinite(Date.parse(stdout.trim()))
      row.stderrPresent = typeof stderr === "string" && stderr.length > 0
      return callback.apply(this, arguments)
    })
  }
}

test("synthetic generation observer calls once and preserves callee, arguments, callback values and return identity", () => {
  const rows = [], args = ["-NoProfile", "-NonInteractive", "-Command", command(123)]
  const options = { timeout: 5000 }, receiver = {}, returned = {}, callbackReceiver = {}
  const error = Object.assign(new Error("PRIVATE_ERROR"), { code: "EACCES" })
  let calls = 0, callbacks = 0
  const execute = function(file, actualArgs, actualOptions, callback) {
    calls++
    assert.strictEqual(this, receiver)
    assert.equal(file, "powershell.exe")
    assert.strictEqual(actualArgs, args)
    assert.strictEqual(actualOptions, options)
    callback.call(callbackReceiver, error, "PRIVATE_OUTPUT", "PRIVATE_STDERR")
    return returned
  }
  const result = observe(execute, rows).call(receiver, "powershell.exe", args, options, function(...values) {
    callbacks++
    assert.strictEqual(this, callbackReceiver)
    assert.deepEqual(values, [error, "PRIVATE_OUTPUT", "PRIVATE_STDERR"])
  })
  assert.strictEqual(result, returned)
  assert.equal(calls, 1)
  assert.equal(callbacks, 1)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].error.code, "EACCES")
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE/u)
})

test("synthetic generation observer forwards other commands unchanged and never reads error getters", () => {
  let calls = 0, getters = 0
  const error = {}
  for (const key of ["code", "signal", "killed", "message", "stack"])
    Object.defineProperty(error, key, { get() { getters++; throw new Error("PRIVATE_GETTER") } })
  assert.deepEqual(describeError(error), { code: "unknown", signal: "unknown", killed: false })
  const rows = [], args = ["-NoProfile", "-NonInteractive", "-Command", command(123) + "; other"]
  const options = { timeout: 5000 }, callback = () => {}, returned = {}
  assert.strictEqual(observe(function(...seen) {
    calls++
    assert.deepEqual(seen, ["powershell.exe", args, options, callback])
    return returned
  }, rows)("powershell.exe", args, options, callback), returned)
  assert.equal(calls, 1)
  assert.equal(getters, 0)
  assert.equal(rows.length, 0)
})

test("synthetic generation observer preserves unrecognized overloads instead of inspecting missing argv", () => {
  const rows = [], options = {}, callback = () => {}
  const before = childProcess.execFile
  for (const argv of [undefined, null, options, "-other"]) {
    let calls = 0
    observe(function(...seen) {
      calls++
      assert.deepEqual(seen, ["powershell.exe", argv, options, callback])
    }, rows)("powershell.exe", argv, options, callback)
    assert.equal(calls, 1)
  }
  assert.equal(rows.length, 0)
  assert.strictEqual(childProcess.execFile, before)
})

if (process.platform === "win32") {
  const rows = []
  const evidence = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "private-generation-observation-"))
  const wrapped = mock.method(childProcess, "execFile", observe(originalExecFile, rows))
  syncBuiltinESMExports()
  process.env.DESK_PRIVATE_BROWSER_SMOKE = "1"
  process.env.DESK_PRIVATE_BROWSER_EVIDENCE = evidence
  after(() => {
    wrapped.mock.restore()
    syncBuiltinESMExports()
    assert.strictEqual(childProcess.execFile, originalExecFile)
    const receiptPath = path.join(evidence, "receipt.json")
    const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, "utf8")) : null
    console.log("DESK_PRIVATE_GENERATION_DIAGNOSTIC_V1 " + JSON.stringify({
      scope: "diagnostic_only_not_normal_qualification", nodeVersion: process.version,
      calls: rows.length, first: rows.slice(0, 2), firstError: rows.find(row => row.error) ?? null,
      firstUnparseable: rows.find(row => !row.outputDateParseable) ?? null, last: rows.slice(-1),
      fixtureReceiptPresent: receipt !== null,
      assertionsComplete: receipt?.assertionsComplete ?? null, cleanupConfirmed: receipt?.cleanupConfirmed ?? null,
    }))
    assert.ok(rows.length > 0, "the actual unchanged generation reader, not a replacement, must execute")
  })
  await import("./browser_private_package.test.js")
} else {
  test("actual Windows private generation diagnostic", { skip: "actual Windows only" }, () => {})
}
