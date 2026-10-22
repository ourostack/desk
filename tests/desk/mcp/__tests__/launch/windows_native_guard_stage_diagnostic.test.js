// Diagnostic-only source: no production change or normal Windows qualification.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import fs from "node:fs"
import childProcess from "node:child_process"
import { mkTempRoot } from "../_temp_roots.js"

const require = createRequire(import.meta.url)
const mcpRoot = fileURLToPath(new URL("../../../../../plugins/desk/mcp/", import.meta.url))
const expectedProgram = "426463dd0405f86221bd81161772f54eca4699b04a3433f3d240b3ee657e2137"
const digest = value => createHash("sha256").update(value).digest("hex")
const originalExecFileSync = childProcess.execFileSync

function capturedProgram() {
  const directory = "C:\\owned-generation", receipt = directory + "\\playwright-patch.json"
  let program
  const context = {
    module: { exports: {} }, __dirname: mcpRoot, Buffer,
    process: { platform: "win32", env: { SystemRoot: "C:\\Windows" } },
    require: name => name === "fs" ? {
      lstatSync: file => ({
        dev: 1n, ino: file === directory ? 2n : 3n, size: 10n, ctimeNs: 11n, mtimeNs: 12n, nlink: 1n,
        isSymbolicLink: () => false, isDirectory: () => file === directory, isFile: () => file === receipt,
      }),
    } : name === "child_process" ? {
      execFileSync(_file, argv, options) {
        assert.equal(options.timeout, 5000)
        program = argv.at(-1)
        return "private"
      },
    } : require(name),
  }
  require("./fixtures/native-template-loader.cjs").loadTemplate(path.join(mcpRoot, "web-extension-credential.cjs"), context)
  context.assertPrivateGeneration(directory, receipt)
  assert.equal(digest(program), expectedProgram)
  return program
}

function instrumentProgram(program) {
  assert.equal(digest(program), expectedProgram, "unrecognized verification program")
  function replace(before, after) {
    assert.equal(program.split(before).length, 2, "one exact canonical observation seam")
    program = program.replace(before, after)
  }
  replace("$ErrorActionPreference='Stop';", "$ErrorActionPreference='Stop';" +
    "$deskGuardClock=[Diagnostics.Stopwatch]::StartNew();" +
    "function Desk-GuardPhase([string]$phase){[Console]::Error.WriteLine('DESK_PRIVATE_GUARD_STAGE_V1 '+$phase+' '+$deskGuardClock.ElapsedMilliseconds)};" +
    "Desk-GuardPhase 'entered';")
  replace("$paths=[Console]::In.ReadToEnd()|ConvertFrom-Json;",
    "$deskGuardJson=[Console]::In.ReadToEnd();Desk-GuardPhase 'input_read';" +
    "$paths=$deskGuardJson|ConvertFrom-Json;Desk-GuardPhase 'json_parsed';")
  for (const [statement, phase] of [
    ["$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;", "sid_read"],
    ["$i=Get-Item -LiteralPath $p.file -Force;", "item_read"],
    ["$a=$i.GetAccessControl('Access,Owner');", "acl_read"],
    ["$r=@($a.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]));", "rules_read"],
  ]) replace(statement, statement + `Desk-GuardPhase '${phase}';`)
  return program + ";Desk-GuardPhase 'complete';"
}

function observedPhases(text) {
  if (typeof text !== "string") {
    try {
      if (!Buffer.isBuffer(text)) return []
      text = Buffer.prototype.toString.call(text, "utf8")
    } catch { return [] }
  }
  const events = []
  for (const line of text.slice(0, 16384).split(/\r?\n/u)) {
    const match = /^DESK_PRIVATE_GUARD_STAGE_V1 (entered|input_read|json_parsed|sid_read|item_read|acl_read|rules_read|complete) ([0-9]{1,5})$/u.exec(line)
    if (match && Number(match[2]) <= 60000 && events.length < 32) events.push({ stage: match[1], ms: Number(match[2]) })
  }
  return events
}

function ownData(error, key) {
  if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, key)
    return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
  } catch { return undefined }
}

function safeError(error) {
  const code = ownData(error, "code"), status = ownData(error, "status"), signal = ownData(error, "signal")
  return {
    code: ["ETIMEDOUT", "EIO", "EACCES", "EPERM", "NATIVE_CODE_CHANGED", "NATIVE_CODE_UNAVAILABLE"].includes(code) ? code : "unknown",
    status: Number.isInteger(status) && status >= 0 && status < 256 ? status : "unknown",
    signal: ["SIGTERM", "SIGKILL"].includes(signal) ? signal : "unknown",
  }
}

function observeActualProvider(t, mode, execute = childProcess.execFileSync) {
  const write = process.stderr.write, rows = []
  let active = null, operation = "setup"
  t.mock.method(process.stderr, "write", function(chunk, ...args) {
    if (active && mode === "phase") active.stages.push(...observedPhases(chunk))
    return write.call(this, chunk, ...args)
  })
  t.mock.method(childProcess, "execFileSync", function(file, argv, options, ...rest) {
    const index = Array.isArray(argv) ? argv.indexOf("-Command") : -1
    if (typeof file !== "string" || path.basename(file).toLowerCase() !== "powershell.exe" || index < 0 ||
        typeof argv[index + 1] !== "string" ||
        digest(argv[index + 1]) !== expectedProgram) return execute.call(this, file, argv, options, ...rest)
    assert.equal(options.timeout, 5000, "the real guard budget must not change")
    const args = mode === "phase" ? [...argv] : argv
    if (mode === "phase") args[index + 1] = instrumentProgram(args[index + 1])
    const row = { mode, operation, call: rows.length + 1, timeoutMs: options.timeout, stages: [] }
    const started = performance.now()
    active = row
    try {
      const result = execute.call(this, file, args, options, ...rest)
      row.privateResult = result === "private"
      return result
    } catch (error) {
      row.error = safeError(error)
      if (!row.stages.length) row.stages = observedPhases(ownData(error, "stderr") ?? "")
      throw error
    } finally {
      row.elapsedMs = Math.round(performance.now() - started)
      rows.push(row)
      active = null
    }
  })
  t.after(() => {
    const timings = rows.map(row => row.elapsedMs).sort((a, b) => a - b)
    t.diagnostic("DESK_PRIVATE_GUARD_SAMPLE_V1 " + JSON.stringify({
      scope: "diagnostic_only_not_normal_qualification", mode, calls: rows.length,
      minimumMs: timings[0] ?? null, medianMs: timings[Math.floor(timings.length / 2)] ?? null,
      maximumMs: timings.at(-1) ?? null, failed: rows.filter(row => row.error).slice(0, 2),
      last: rows.slice(-1),
    }))
  })
  return { rows, operation: value => { operation = value } }
}

async function actualGeneration() {
  const root = await mkTempRoot("native-guard-phase-")
  const input = require("./fixtures/playwright-native-error-transport.cjs").read()
  const installed = { dir: path.join(root, "generation"), version: "owned-guard-diagnostic", core: null }
  const lib = path.join(installed.dir, "node_modules/playwright-core/lib")
  fs.mkdirSync(path.join(lib, "tools/cli-client"), { recursive: true, mode: 0o700 })
  const prefix = fs.readFileSync(new URL("./fixtures/playwright-server-lifecycle.cjs", import.meta.url), "utf8")
  fs.writeFileSync(path.join(lib, "coreBundle.js"), prefix + input.core, { mode: 0o600 })
  fs.writeFileSync(path.join(lib, "tools/cli-client/session.js"), input.sessionSource, { mode: 0o600 })
  require(path.join(mcpRoot, "web-playwright-patch.cjs")).apply(installed)
  return installed
}

test("synthetic probe refuses to instrument anything except the actual canonical verification program", () => {
  const program = capturedProgram()
  assert.throws(() => instrumentProgram(program + "\n# not the admitted program"), /unrecognized verification program/u)
})

test("synthetic phase reader retains only fixed stage names and bounded clocks, never private stderr", () => {
  assert.deepEqual(observedPhases(
    "PRIVATE_ERROR_WITH_PATH\nDESK_PRIVATE_GUARD_STAGE_V1 entered 0\n" +
    "DESK_PRIVATE_GUARD_STAGE_V1 json_parsed 12\nDESK_PRIVATE_GUARD_STAGE_V1 PRIVATE_SECRET 14\n" +
    "DESK_PRIVATE_GUARD_STAGE_V1 acl_read 999999999999\n",
  ), [{ stage: "entered", ms: 0 }, { stage: "json_parsed", ms: 12 }])
})

test("synthetic observer preserves caller/result/error identity without formatting arbitrary values or retrying", t => {
  const program = capturedProgram(), options = { timeout: 5000, input: "PRIVATE_INPUT", encoding: "utf8" }
  const returned = {}
  let calls = 0, formats = 0
  Object.defineProperty(returned, "toString", { get() { formats++; throw new Error("PRIVATE_FORMATTER") } })
  const refusal = Object.assign(new Error("PRIVATE_FAILURE"), { code: "ETIMEDOUT", signal: "SIGTERM" })
  const execute = function(_file, _argv, seen) {
    assert.strictEqual(this, childProcess)
    assert.strictEqual(seen, options)
    calls++
    if (calls === 2) throw refusal
    return returned
  }
  const observed = observeActualProvider(t, "phase", execute)
  const invoke = () => childProcess.execFileSync("powershell.exe", ["-Command", program], options)
  assert.doesNotThrow(() => assert.strictEqual(invoke(), returned))
  assert.throws(invoke, error => error === refusal)
  assert.equal(calls, 2)
  assert.equal(observed.rows.length, 2, "the real observation seam, not its forwarding path, must execute")
  assert.equal(formats, 0)
  assert.doesNotMatch(JSON.stringify(observed.rows), /PRIVATE/u)
})

test("synthetic observer leaves the original child-process provider for subsequent actual controls", () => {
  assert.strictEqual(childProcess.execFileSync, originalExecFileSync)
})

const windowsOnly = process.platform !== "win32" ? "actual Windows ACL provider diagnostic only" : false
for (const mode of ["original", "phase"]) {
  test(`actual Windows ${mode} guard sample uses every original check and the unchanged five-second budget`, { skip: windowsOnly }, async t => {
    const observed = observeActualProvider(t, mode)
    const credential = require(path.join(mcpRoot, "web-extension-credential.cjs"))
    try {
      const installed = await actualGeneration()
      for (let operation = 1; operation <= 256; operation++) {
        observed.operation(`read-${operation}`)
        credential.verifyGeneration(installed, mcpRoot)
      }
    } catch (error) {
      assert.fail(JSON.stringify({ scope: "diagnostic_guard_failure_not_retried", mode,
        original: safeError(error), lastObservedCall: observed.rows.at(-1) ?? null }))
    }
    assert.ok(observed.rows.length >= 512, "both private-generation checks run for every explicit read")
    assert.ok(observed.rows.every(row => row.privateResult === true && !row.error))
    if (mode === "phase") assert.ok(observed.rows.every(row =>
      row.stages.at(-1)?.stage === "complete" && row.stages.filter(stage => stage.stage === "acl_read").length === 2),
    "each instrumented actual success must observe both ACL reads and completion")
  })

  test(`actual Windows ${mode} phase observation does not turn an inherited ACL into private success`, { skip: windowsOnly }, async t => {
    const observed = observeActualProvider(t, mode)
    const installed = await actualGeneration()
    const receipt = path.join(installed.dir, "playwright-patch.json")
    const systemRoot = Object.entries(process.env).find(([name]) => name.toLowerCase() === "systemroot")?.[1]
    assert.ok(systemRoot && path.win32.isAbsolute(systemRoot))
    childProcess.execFileSync(path.win32.join(systemRoot, "System32/icacls.exe"),
      [receipt, "/inheritance:e"], { encoding: "utf8", timeout: 5000, windowsHide: true })
    observed.operation("expected-inherited-acl-refusal")
    assert.throws(() => require(path.join(mcpRoot, "web-extension-credential.cjs")).verifyGeneration(installed, mcpRoot),
      error => ownData(error, "status") === 2, "the real unchanged guard must still refuse")
    assert.equal(observed.rows.at(-1)?.error?.status, 2)
    assert.equal(observed.rows.at(-1)?.privateResult, undefined)
  })
}
