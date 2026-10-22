// Observation-only prerequisite. Synthetic protocol controls are not Windows evidence.
import "../_isolated_env.mjs"
import { test, after } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { fileURLToPath } from "node:url"
import { mkTempRoot } from "../_temp_roots.js"
import { prepareArchiveState } from "../../../../../plugins/desk/mcp/src/tools/archive-state.js"
import { moveArchive } from "./_legacy_directory_move.mjs"
import { nativeMoveObserver } from "./archive_handoff_qualification_child.mjs"
import { observeIdentity, decodeFileIdInfo, identityArtifactPath } from "./_windows_archive_identity.mjs"

const source = "C:\\owned\\PRIVATE_SOURCE"
const volumeHex = "8877665544332211"
const fileIdHex = "08070605040302011020304050607080"
const nodeStat = { dev: 0x55667788n, ino: 0x0102030405060708n, mode: 0o40755n }
const admittedIdentity = `${nodeStat.dev}:${nodeStat.ino}:16384`
const nativeMethodNames = ["CreateFileW", "GetFileInformationByHandleEx", "GetVolumeInformationByHandleW", "CloseHandle"]
function metadataFacts() {
  return { methodCount: 4, methodCountStatus: "observed", failedCheck: null,
    methods: nativeMethodNames.map(method => ({ method, status: "observed", importCount: 1, importCountStatus: "observed",
      setLastError: true, exactSpelling: true, unicode: true, winapi: true, methodImplementationPreserveSig: true })) }
}
function snapshot(extra = {}) {
  return {
    openSuccess: true, openError: null,
    volumeSuccess: true, volumeError: null, filesystem: "NTFS",
    idSuccess: true, idError: null, volumeHex, fileIdHex,
    attributeSuccess: true, attributeError: null, attributes: 16, reparseTag: 0,
    closeAttempted: false, closeSuccess: null, closeError: null, ...extra,
  }
}
function readyMessage(extra = {}) {
  return { state: "ready", pid: 42, powershell: "5.1.26100.33438", runtime: "4.0.30319.42000",
    edition: "Desktop", compiler: "reflection_emit_in_process", metadataVerified: true,
    openContract: { access: 0, share: 7, disposition: 3, flags: 35651584 }, baseline: snapshot(), ...extra }
}
function fakeNative(options = {}) {
  const child = new EventEmitter()
  child.pid = 42
  child.stdin = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  let observations = 0, ended = false
  const requests = []
  const emit = item => child.stdout.emit("data", Buffer.from(typeof item === "string" ? item : JSON.stringify(item) + "\n"))
  const close = (code = 0, signal = null) => { child.emit("exit", code, signal); child.emit("close", code, signal) }
  const finish = () => {
    if (ended) return
    ended = true
    if (options.finish) return options.finish({ emit, close, observations })
    emit({ state: "finished", opened: observations + 1, closeAttempts: observations + 1,
      closed: observations + 1, closeFailures: 0, programError: null,
      metadataFacts: metadataFacts(),
      disposals: [...Array.from({ length: observations }, () => ({ phase: "observe", success: true, error: null })),
        { phase: "finish", success: true, error: null }] })
    close()
  }
  child.stdin.write = line => {
    const request = JSON.parse(line)
    requests.push(request)
    queueMicrotask(() => {
      if (request.source) {
        if (options.start) return options.start({ emit, close, child })
        emit(readyMessage({ baseline: snapshot(options.baseline) }))
      } else {
        observations++
        if (options.observe) return options.observe({ emit, close, child, request })
        emit({ state: "observation", sequence: request.sequence,
          sample: snapshot({ closeAttempted: true, closeSuccess: true }) })
      }
    })
    return false
  }
  child.stdin.end = line => {
    if (line) requests.push(JSON.parse(line))
    queueMicrotask(finish)
    return child.stdin
  }
  child.kill = () => {
    if (options.kill) return options.kill({ close })
    close(null, "SIGTERM")
  }
  let args
  const dependencies = {
    platform: "win32", env: { SystemRoot: "C:\\Windows" },
    spawn(executable, argv, settings) {
      args = { executable, argv, settings }
      queueMicrotask(() => child.emit("spawn"))
      return child
    },
    setTimeout: (callback, ms) => setTimeout(callback, ms / 1000), clearTimeout,
  }
  return { child, requests, dependencies, args: () => args }
}
const input = { source, nodeBaseline: nodeStat, admittedIdentity }
// These two controls parse/reflect only; production native archive deadlines are unchanged.
// PowerShell cold start on a busy CI runner can exceed several seconds.
const metadataOnlyTimeoutMs = 60_000

test("synthetic: PowerShell AST keeps metadata helpers script-scoped before use", async t => {
  const f = fakeNative()
  await observeIdentity(input, async () => {}, f.dependencies)
  const parser = process.platform === "win32" ?
    path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "pwsh"
  const script = `
$ErrorActionPreference = 'Stop'
$program = [Console]::In.ReadToEnd()
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput($program, [ref]$tokens, [ref]$parseErrors)
$setup = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
$helpers = @()
foreach ($name in @('Fail-Metadata', 'Require-Metadata')) {
  $top = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name
  })
  $beforeUse = $false
  if ($top.Count -eq 1 -and $setup.Count -eq 1) {
    $beforeUse = $top[0].Extent.EndOffset -lt $setup[0].Extent.StartOffset
  }
  $helpers += @{ name = $name; definitions = $top.Count; scriptScoped = $top.Count -eq 1; beforeUse = $beforeUse }
}
[Console]::WriteLine((@{ parseErrors = $parseErrors.Count; helpers = $helpers } | ConvertTo-Json -Depth 4 -Compress))
`
  const parsed = spawnSync(parser, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: f.args().argv[4], encoding: "utf8", env: process.env, timeout: metadataOnlyTimeoutMs,
  })
  if (process.platform !== "win32" && parsed.error?.code === "ENOENT") {
    t.skip("PowerShell AST parser unavailable on this non-Windows host; native execution remains unqualified")
    return
  }
  assert.equal(parsed.status, 0, parsed.error?.code ?? "PowerShell AST-only parser failed")
  assert.deepEqual(JSON.parse(parsed.stdout), { parseErrors: 0, helpers: [
    { name: "Fail-Metadata", definitions: 1, scriptScoped: true, beforeUse: true },
    { name: "Require-Metadata", definitions: 1, scriptScoped: true, beforeUse: true },
  ] })
})

test("synthetic: captured emitter produces complete managed metadata without invoking PInvoke", async t => {
  const f = fakeNative()
  await observeIdentity(input, async () => {}, f.dependencies)
  const parser = process.platform === "win32" ?
    path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "pwsh"
  const script = `
$ErrorActionPreference = 'Stop'
function Library-Stage([string]$stage) {
  [Console]::WriteLine('LIBRARY_STAGE:' + $stage)
  [Console]::Out.Flush()
}
Library-Stage 'read'
$tokens = $null
$parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$parseErrors)
Library-Stage 'parse'
if ($parseErrors.Count -ne 0) { throw 'captured_emitter_parse_failed' }
$setup = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if ($setup.Count -ne 1) { throw 'captured_setup_missing' }
$definitions = @($setup[0].Body.Statements | Where-Object {
  $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq 'Define-Native'
})
if ($definitions.Count -ne 1) { throw 'captured_emitter_missing' }
$definition = $definitions[0]
if (($definition.Parameters | ForEach-Object { $_.Name.VariablePath.UserPath }) -join ',' -cne 'name,returns,parameters') {
  throw 'captured_emitter_parameters_changed'
}
$context = @{}
foreach ($key in @('ctor', 'fields')) {
  $assignments = @($setup[0].Body.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
      $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and $_.Left.VariablePath.UserPath -ceq $key
  })
  if ($assignments.Count -ne 1) { throw 'captured_metadata_context_missing' }
  $right = $assignments[0].Right
  $statements = New-Object 'System.Collections.Generic.List[System.Management.Automation.Language.StatementAst]'
  $statements.Add($right.Copy())
  $block = [Management.Automation.Language.StatementBlockAst]::new($right.Extent, $statements,
    [Management.Automation.Language.TrapStatementAst[]]@())
  $expression = [Management.Automation.Language.ScriptBlockAst]::new($right.Extent, $null, $block, $false)
  $context[$key] = $expression.GetScriptBlock().InvokeReturnAsIs()
}
Library-Stage 'contexts'
$name = New-Object Reflection.AssemblyName('DeskMetadataLibraryControl')
$route = 'unselected'
$factoryStage = 'select_factory'
try {
  if ($PSVersionTable.PSEdition -ceq 'Desktop' -and [Environment]::Version.Major -eq 4) {
    $route = 'AppDomain_DefineDynamicAssembly_Framework_metadata_only'
    $factoryStage = 'construct_framework_assembly'
    $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  } elseif ($PSVersionTable.PSEdition -ceq 'Core' -and [Environment]::Version.Major -ge 6) {
    $route = 'AssemblyBuilder_DefineDynamicAssembly_Core_metadata_only'
    $factoryStage = 'construct_core_assembly'
    $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($name, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  } else { throw 'unknown_metadata_library_host' }
  $factoryStage = 'construct_module'
  $module = $assembly.DefineDynamicModule('InMemory')
  $factoryStage = 'construct_type'
  $builder = $module.DefineType('DeskCapturedMetadata', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
} catch {
  $failure = $_.Exception.GetBaseException()
  $exception = $failure.GetType().FullName
  if (@('System.ArgumentException', 'System.InvalidOperationException', 'System.MissingMethodException',
    'System.Reflection.AmbiguousMatchException', 'System.Management.Automation.RuntimeException',
    'System.Management.Automation.MethodException', 'System.Management.Automation.MethodInvocationException') -notcontains $exception) {
    $exception = 'other'
  }
  [Console]::WriteLine('LIBRARY_FACTORY_FAILURE:' + (@{ stage = $factoryStage; route = $route
    edition = [string]$PSVersionTable.PSEdition; runtime = [Environment]::Version.ToString()
    exception = $exception; hresult = $failure.HResult } | ConvertTo-Json -Compress))
  exit 4
}
Library-Stage 'assembly'
$specifications = @(
  @{ name = 'CreateFileW'; returns = [IntPtr]; parameters = [type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]) },
  @{ name = 'GetFileInformationByHandleEx'; returns = [bool]; parameters = [type[]]@([IntPtr], [int], [IntPtr], [uint32]) },
  @{ name = 'GetVolumeInformationByHandleW'; returns = [bool]; parameters = [type[]]@([IntPtr], [IntPtr], [uint32], [IntPtr], [IntPtr], [IntPtr], [Text.StringBuilder], [uint32]) },
  @{ name = 'CloseHandle'; returns = [bool]; parameters = [type[]]@([IntPtr]) })
$body = $definition.Body.GetScriptBlock()
foreach ($specification in $specifications) {
  Library-Stage ('emit_' + $specification.name)
  $variables = New-Object 'System.Collections.Generic.List[System.Management.Automation.PSVariable]'
  foreach ($key in @('name', 'returns', 'parameters')) {
    $variables.Add([Management.Automation.PSVariable]::new($key, $specification[$key]))
  }
  $variables.Add([Management.Automation.PSVariable]::new('type', $builder))
  $variables.Add([Management.Automation.PSVariable]::new('ctor', $context.ctor))
  $variables.Add([Management.Automation.PSVariable]::new('fields', [Reflection.FieldInfo[]]@($context.fields)))
  [void]$body.InvokeWithContext($null, $variables, @())
}
Library-Stage 'create_type'
$native = $builder.CreateType()
Library-Stage 'reflect'
$rows = @()
foreach ($specification in $specifications) {
  $method = $native.GetMethod($specification.name)
  $imports = @($method.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute], $false))
  if ($imports.Count -ne 1) { throw 'captured_import_count_invalid' }
  $import = $imports[0]
  $actualParameters = @($method.GetParameters() | ForEach-Object { $_.ParameterType })
  $signature = $method.ReturnType -eq $specification.returns -and $actualParameters.Count -eq $specification.parameters.Count
  for ($index = 0; $index -lt $actualParameters.Count -and $signature; $index++) {
    $signature = $actualParameters[$index] -eq $specification.parameters[$index]
  }
  $rows += @{ method = $specification.name; signatureMatches = $signature
    publicStatic = $method.IsPublic -and $method.IsStatic
    managedCallingConventionStandard = $method.CallingConvention -eq [Reflection.CallingConventions]::Standard
    pinvokeImplementation = ($method.Attributes -band [Reflection.MethodAttributes]::PinvokeImpl) -ne 0
    importMatches = $import.Value -ceq 'kernel32.dll'; entryPointMatches = $import.EntryPoint -ceq $specification.name
    setLastError = $import.SetLastError; exactSpelling = $import.ExactSpelling
    unicode = $import.CharSet -eq [Runtime.InteropServices.CharSet]::Unicode
    winapi = $import.CallingConvention -eq [Runtime.InteropServices.CallingConvention]::Winapi
    methodImplementationPreserveSig = ($method.GetMethodImplementationFlags() -band [Reflection.MethodImplAttributes]::PreserveSig) -ne 0 }
}
Library-Stage 'done'
[Console]::WriteLine((@{ scope = 'managed_metadata_library_only_not_file_API_or_Windows_ABI'
  runtime = [Environment]::Version.ToString(); powershell = $PSVersionTable.PSVersion.ToString()
  edition = [string]$PSVersionTable.PSEdition; assemblyRoute = $route; methods = $rows } | ConvertTo-Json -Depth 5 -Compress))
`
  const observed = spawnSync(parser, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    input: f.args().argv[4], encoding: "utf8", env: process.env, timeout: metadataOnlyTimeoutMs,
  })
  if (process.platform !== "win32" && observed.error?.code === "ENOENT") {
    t.skip("PowerShell metadata library unavailable on this non-Windows host; Windows ABI remains unqualified")
    return
  }
  if (observed.status !== 0) {
    const lines = String(observed.stdout).split(/\r?\n/u)
    const factoryLine = lines.find(line => line.startsWith("LIBRARY_FACTORY_FAILURE:"))
    const factory = factoryLine ? JSON.parse(factoryLine.slice("LIBRARY_FACTORY_FAILURE:".length)) : null
    t.diagnostic(JSON.stringify({ metadataLibraryStages: lines
      .filter(line => /^LIBRARY_STAGE:(?:read|parse|contexts|assembly|emit_(?:CreateFileW|GetFileInformationByHandleEx|GetVolumeInformationByHandleW|CloseHandle)|create_type|reflect|done)$/u.test(line)),
    factoryFailure: factory }))
  }
  assert.equal(observed.status, 0, observed.error?.code ?? "captured emitter metadata-only characterization failed")
  const report = JSON.parse(observed.stdout.trim().split(/\r?\n/u).at(-1))
  t.diagnostic(JSON.stringify({ scope: report.scope, runtime: report.runtime, powershell: report.powershell,
    edition: report.edition, assemblyRoute: report.assemblyRoute }))
  assert.equal(report.scope, "managed_metadata_library_only_not_file_API_or_Windows_ABI")
  assert.ok(["AppDomain_DefineDynamicAssembly_Framework_metadata_only",
    "AssemblyBuilder_DefineDynamicAssembly_Core_metadata_only"].includes(report.assemblyRoute))
  assert.equal(report.edition, process.platform === "win32" ? "Desktop" : "Core")
  assert.deepEqual(report.methods, nativeMethodNames.map(method => ({ method, signatureMatches: true,
    publicStatic: true, managedCallingConventionStandard: true, pinvokeImplementation: true,
    importMatches: true, entryPointMatches: true, setLastError: true, exactSpelling: true,
    unicode: true, winapi: true, methodImplementationPreserveSig: true })))
})

test("synthetic: persistence resolver targets the checkout root from the actual runner working directory", () => {
  const execArgv = process.execArgv.filter(arg => arg !== "--test" && !arg.startsWith("--test-"))
  const result = spawnSync(process.execPath, [...execArgv, "--input-type=module", "-e",
    `import { identityArtifactPath } from ${JSON.stringify(new URL("./_windows_archive_identity.mjs", import.meta.url).href)}; process.stdout.write(identityArtifactPath())`], {
    cwd: fileURLToPath(new URL("../../../../../plugins/desk/mcp/", import.meta.url)), encoding: "utf8", env: process.env,
  })
  assert.equal(result.status, 0, result.error?.code ?? "isolated resolver child failed")
  assert.equal(result.stdout, path.join(fileURLToPath(new URL("../../../../../", import.meta.url)), "windows-archive-race-observations.json"))
})

function failedBeforeReady(fields = {}, stderr = null) {
  return fakeNative({
    start: ({ child }) => { if (stderr !== null) child.stderr.emit("data", Buffer.from(stderr)) },
    finish: ({ emit, close }) => {
      emit({ state: "finished", opened: 0, closeAttempts: 0, closed: 0, closeFailures: 0,
        programError: "setup", disposals: [], ...fields })
      close(4)
    },
  })
}

test("synthetic: first native failure is distinct from final disposal and exports only closed metadata", async () => {
  const f = failedBeforeReady({
    firstFailure: { operation: "verify_metadata", kind: "exception", exception: "System.InvalidOperationException",
      hresult: -2146233079, nativeError: null, message: "PRIVATE_NATIVE_PATH" },
    finalOperation: "dispose_handle",
  }, "unrecognized private stderr PRIVATE_NATIVE_PATH")
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.deepEqual(error.identityReceipt.handles.firstFailure, { operation: "verify_metadata", kind: "exception",
      exception: "System.InvalidOperationException", hresult: -2146233079, nativeError: null })
    assert.equal(error.identityReceipt.handles.finalOperation, "dispose_handle")
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_NATIVE_PATH"), false)
    return true
  })
})

test("synthetic: metadata facts distinguish measured false, unavailable and not reached", async () => {
  const facts = metadataFacts()
  facts.failedCheck = { check: "set_last_error", method: "CreateFileW" }
  facts.methods[0] = { ...facts.methods[0], setLastError: false, exactSpelling: "unavailable", unicode: "not_reached" }
  const f = failedBeforeReady({ metadataFacts: facts }, "unrecognized private stderr")
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    const actual = error.identityReceipt.handles.metadataFacts
    assert.equal(actual.methodCount, 4)
    assert.equal(actual.methods[0].setLastError, false)
    assert.equal(actual.methods[0].exactSpelling, "unavailable")
    assert.equal(actual.methods[0].unicode, "not_reached")
    assert.equal(actual.factSources.methodImplementationPreserveSig, "MethodInfo.GetMethodImplementationFlags")
    assert.deepEqual(actual.failedCheck, facts.failedCheck)
    return true
  })
})

test("synthetic: metadata facts never export arbitrary method names, checks or flag strings", async () => {
  const f = failedBeforeReady({ metadataFacts: {
    methodCount: "PRIVATE_NATIVE_PATH", methodCountStatus: "PRIVATE_NATIVE_PATH",
    failedCheck: { check: "PRIVATE_NATIVE_PATH", method: "PRIVATE_NATIVE_PATH" },
    methods: [{ method: "PRIVATE_NATIVE_PATH", status: "PRIVATE_NATIVE_PATH", setLastError: "PRIVATE_NATIVE_PATH" }],
  } }, "unrecognized private stderr")
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    const actual = error.identityReceipt.handles.metadataFacts
    assert.equal(actual.methodCount, null)
    assert.equal(actual.methodCountStatus, "unavailable")
    assert.equal(actual.unknownMethodsObserved, true)
    assert.deepEqual(actual.failedCheck, { check: "unknown", method: "unknown" })
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_NATIVE_PATH"), false)
    return true
  })
})

test("synthetic: valid READY cannot override contradictory finished metadata", async () => {
  const facts = metadataFacts()
  facts.methods[0].setLastError = false
  const f = fakeNative({ finish: ({ emit, close }) => {
    emit({ state: "finished", opened: 1, closeAttempts: 1, closed: 1, closeFailures: 0, programError: null,
      metadataFacts: facts, disposals: [{ phase: "finish", success: true, error: null }] })
    close()
  } })
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.ok(error.identityReceipt.protocolIssues.includes("metadata_confirmation_failed"))
    return true
  })
})

test("synthetic: unknown failure annotations remain explicit unknowns without leaking arbitrary strings", async () => {
  const f = failedBeforeReady({
    firstFailure: { operation: "PRIVATE_NATIVE_PATH", kind: "other", exception: "PRIVATE_NATIVE_PATH",
      hresult: Number.MAX_SAFE_INTEGER, nativeError: "PRIVATE_NATIVE_PATH" },
    finalOperation: "PRIVATE_NATIVE_PATH",
  }, "unrecognized private stderr")
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.deepEqual(error.identityReceipt.handles.firstFailure, { operation: "unknown", kind: "unknown",
      exception: "other", hresult: null, nativeError: null })
    assert.equal(error.identityReceipt.handles.finalOperation, "unknown")
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_NATIVE_PATH"), false)
    return true
  })
})

for (const [name, stderr, expected] of [
  ["recognized", "At line:1 char:1\nCategoryInfo : ParserError: (:) [], ParentContainsErrorRecordException\nFullyQualifiedErrorId : UnexpectedToken\nPRIVATE_NATIVE_PATH", {
    status: "recognized", line: 1, character: 1, category: "ParserError", errorId: "UnexpectedToken",
  }],
  ["ambiguous", "At line:1 char:1\nAt line:2 char:1\nFullyQualifiedErrorId : UnexpectedToken", {
    status: "ambiguous", line: null, character: null, category: "unknown", errorId: "UnexpectedToken",
  }],
  ["out-of-bounds", "At line:999999 char:999999\nFullyQualifiedErrorId : PRIVATE_NATIVE_PATH", {
    status: "unrecognized", line: null, character: null, category: "unknown", errorId: "unknown",
  }],
]) test(`synthetic: ${name} stderr annotations stay passive, bounded and private`, async () => {
  const f = failedBeforeReady({}, stderr)
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.deepEqual(error.identityReceipt.stderrObservation, { ...expected, bytes: Buffer.byteLength(stderr), truncated: false })
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_NATIVE_PATH"), false)
    return true
  })
})

test("synthetic: truncated stderr annotations never inspect beyond the byte bound", async () => {
  const prefix = "At line:1 char:1\nCategoryInfo : ParserError\nFullyQualifiedErrorId : UnexpectedToken\n"
  const stderr = prefix + "PRIVATE_NATIVE_PATH".repeat(1000) + "\nFullyQualifiedErrorId : MissingEndCurlyBrace"
  const f = failedBeforeReady({}, stderr)
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    const observation = error.identityReceipt.stderrObservation
    assert.equal(observation.bytes, Buffer.byteLength(stderr))
    assert.equal(observation.truncated, true)
    assert.equal(observation.status, "partial")
    assert.equal(observation.errorId, "UnexpectedToken")
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_NATIVE_PATH"), false)
    return true
  })
})

test("synthetic: complete FileIdInfo is decoded unsigned little-endian without losing upper bits", () => {
  const id = decodeFileIdInfo(Buffer.from(volumeHex + fileIdHex, "hex"))
  assert.equal(id.volume, 0x1122334455667788n)
  assert.equal(id.fileIdLow64, 0x0102030405060708n)
  assert.equal(id.fileIdHigh64, 0x8070605040302010n)
  assert.equal(id.fileId128, 0x80706050403020100102030405060708n)
  const high = decodeFileIdInfo(Buffer.from("ff".repeat(24), "hex"))
  assert.equal(high.volume, 18446744073709551615n)
  assert.equal(high.fileId128, 340282366920938463463374607431768211455n)
  for (const invalid of [Buffer.alloc(23), Buffer.alloc(25), Buffer.alloc(24),
    Buffer.from("0000000000000000" + fileIdHex, "hex"), Buffer.from(volumeHex + "00".repeat(16), "hex")])
    assert.throws(() => decodeFileIdInfo(invalid), /unsupported FileIdInfo/)
})

test("synthetic: observer exposes finite relationships, not raw identities, paths or identity authority", async () => {
  const f = fakeNative()
  const receipt = await observeIdentity(input, async session => {
    const sample = await session.observe(source, "baseline_current", nodeStat, admittedIdentity)
    assert.equal(sample.sameAsBaseline, true)
    assert.equal(sample.nodeInodeEqualsNativeLow64, true)
    assert.equal(sample.nativeUpper64Zero, false)
    assert.equal(sample.nodeDevEqualsNativeVolumeLow32, true)
    assert.equal(sample.nodeDevEqualsNativeVolume64, false)
    assert.equal(sample.nodeTupleMatchesAdmission, true)
  }, f.dependencies)
  assert.equal(receipt.observationKind, "finite_ntfs_identity_bridge_only")
  assert.equal(receipt.identityAuthority, false)
  assert.equal(receipt.baseline.replacementPhaseBegun, false)
  assert.equal(receipt.handles.confirmedDisposed, true)
  assert.deepEqual(receipt.close, { code: 0, signal: null })
  assert.deepEqual(receipt.protocolIssues, [])
  assert.deepEqual(receipt.missingStages, [])
  const exported = JSON.stringify(receipt)
  for (const secret of [source, volumeHex, fileIdHex, String(nodeStat.ino), String(nodeStat.dev)])
    assert.equal(exported.includes(secret), false)
  assert.deepEqual(f.requests.map(request => Object.keys(request).sort()), [
    ["source"], ["command", "path", "sequence"], ["command"],
  ])
  assert.deepEqual(f.args().argv.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])
  assert.equal(f.args().argv[4].includes(source), false)
  assert.equal(f.args().executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
  assert.equal(f.args().settings.env, f.dependencies.env)
  assert.match(receipt.programSha256, /^[a-f0-9]{64}$/)
  assert.equal(receipt.executedProgramSha256, receipt.programSha256)
  assert.equal(createHash("sha256").update(f.args().argv[4]).digest("hex"), receipt.programSha256)
  assert.match(receipt.helperSha256, /^[a-f0-9]{64}$/)
  assert.equal(createHash("sha256").update(await fs.readFile(new URL("./_windows_archive_identity.mjs", import.meta.url))).digest("hex"),
    receipt.helperSha256)
})

test("synthetic: full upper ID and full volume changes remain distinct despite identical low parts", async () => {
  for (const change of [
    { fileIdHex: "08070605040302011120304050607080" },
    { volumeHex: "8877665545332211" },
  ]) {
    const f = fakeNative({ observe: ({ emit, request }) => emit({ state: "observation", sequence: request.sequence,
      sample: snapshot({ ...change, closeAttempted: true, closeSuccess: true }) }) })
    const receipt = await observeIdentity(input, session => session.observe(source, "replacement", nodeStat, "wrong"), f.dependencies)
    assert.equal(receipt.observations[0].sameAsBaseline, false)
    assert.equal(receipt.observations[0].nodeInodeEqualsNativeLow64, true)
    assert.equal(receipt.observations[0].nodeTupleMatchesAdmission, false)
  }
})

for (const [name, start, issue] of [
  ["malformed", ({ emit }) => emit("PRIVATE_NATIVE_OUTPUT\n"), "malformed_json"],
  ["oversized", ({ emit }) => emit("PRIVATE_NATIVE_OUTPUT".repeat(1000)), "stdout_oversized"],
  ["wrong PID", ({ emit }) => emit({ state: "ready", pid: 99 }), "invalid_ready"],
  ["unknown", ({ emit }) => emit({ state: "unknown", private: "PRIVATE_NATIVE_OUTPUT" }), "unexpected_state"],
  ["missing READY", ({ close }) => close(4), "missing_ready"],
]) test(`synthetic: ${name} remains explicit and never leaks raw native output`, async () => {
  const f = fakeNative({ start })
  await assert.rejects(observeIdentity(input, () => assert.fail("invalid READY accepted"), f.dependencies), error => {
    assert.ok(error.identityReceipt.protocolIssues.includes(issue))
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_NATIVE_OUTPUT"), false)
    assert.equal(error.message.includes("PRIVATE_NATIVE_OUTPUT"), false)
    return true
  })
})

for (const [name, finish] of [
  ["missing final ACK", ({ close }) => close()],
  ["unconfirmed disposal", ({ emit, close, observations }) => {
    emit({ state: "finished", opened: observations + 1, closeAttempts: observations + 1,
      closed: observations, closeFailures: 1, programError: null,
      disposals: [...Array.from({ length: observations }, () => ({ phase: "observe", success: true, error: null })),
        { phase: "finish", success: false, error: 6 }] })
    close(5)
  }],
  ["normal ACK without native closure", ({ emit, observations }) => emit({ state: "finished",
    opened: observations + 1, closeAttempts: observations + 1, closed: observations + 1, closeFailures: 0, programError: null,
    disposals: Array.from({ length: observations + 1 }, () => ({ phase: "finish", success: true, error: null })) })],
  ["unretired", () => {}],
]) test(`synthetic: ${name} cannot become a qualified observation`, async () => {
  const f = fakeNative({ finish, kill: name === "unretired" ? () => {} : undefined })
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.equal(error.identityReceipt.uncertain, true)
    assert.notEqual(error.identityReceipt.outcome, "observed")
    return true
  })
})

test("synthetic: callback error stays primary and receives separate unconfirmed closure disposition", async () => {
  const f = fakeNative({ finish: () => {}, kill: () => {} }), primary = new Error("controlled callback failure")
  await assert.rejects(observeIdentity(input, async () => { throw primary }, f.dependencies), error => {
    assert.equal(error, primary)
    assert.equal(error.identityReceipt.uncertain, true)
    assert.equal(error.native_close_failure, "native retirement unconfirmed")
    return true
  })
})

test("synthetic: non-NTFS and unsupported full identity are refused, never downgraded to legacy IDs", async () => {
  for (const baseline of [{ filesystem: "other" }, { fileIdHex: "00".repeat(16) }, { volumeHex: null },
    { attributeSuccess: false, attributeError: 50, attributes: null, reparseTag: null }]) {
    const f = fakeNative({ baseline })
    await assert.rejects(observeIdentity(input, () => assert.fail("unsupported baseline entered fixture"), f.dependencies), error => {
      assert.equal(error.identityReceipt.outcome, "unsupported")
      assert.equal(error.identityReceipt.handles.confirmedDisposed, true)
      return true
    })
  }
})

test("synthetic: duplicate and malformed observations remain explicit even after a valid sample", async () => {
  const f = fakeNative({ observe: ({ emit, request }) => {
    const item = { state: "observation", sequence: request.sequence,
      sample: snapshot({ closeAttempted: true, closeSuccess: true }) }
    emit(item)
    emit(item)
  } })
  await assert.rejects(observeIdentity(input, session => session.observe(source, "baseline_current", nodeStat), f.dependencies), error => {
    assert.ok(error.identityReceipt.protocolIssues.includes("unexpected_observation"))
    return true
  })
})

test("synthetic: READY copies only validated open flags and cannot export arbitrary native properties", async () => {
  const f = fakeNative({ start: ({ emit }) => emit(readyMessage({
    openContract: { access: 0, share: 7, disposition: 3, flags: 35651584, private: "PRIVATE_NATIVE_PATH" },
  })) })
  const receipt = await observeIdentity(input, async () => {}, f.dependencies)
  assert.deepEqual(receipt.openContract, { access: 0, share: 7, disposition: 3, flags: 35651584 })
  assert.equal(JSON.stringify(receipt).includes("PRIVATE_NATIVE_PATH"), false)
})

for (const [name, value] of [
  ["DELETE desired access", { access: 65536, share: 7, disposition: 3, flags: 35651584 }],
  ["DELETE denied sharing", { access: 0, share: 3, disposition: 3, flags: 35651584 }],
  ["reparse following", { access: 0, share: 7, disposition: 3, flags: 33554432 }],
]) test(`synthetic: native ${name} cannot enter the observation fixture`, async () => {
  const f = fakeNative({ start: ({ emit }) => emit(readyMessage({ openContract: value })) })
  await assert.rejects(observeIdentity(input, () => assert.fail("wrong handle contract accepted"), f.dependencies), error => {
    assert.ok(error.identityReceipt.protocolIssues.includes("invalid_ready"))
    return true
  })
})

test("synthetic: an API success cannot promote a stale last-error value into failure evidence", async () => {
  const f = fakeNative({ baseline: { idError: 5 } })
  await assert.rejects(observeIdentity(input, () => assert.fail("inconsistent native result accepted"), f.dependencies),
    /invalid API result/)
})

test("synthetic: partial setup failure retains disposal counters without inventing READY", async () => {
  const f = fakeNative({ start: ({ emit, close }) => {
    emit({ state: "finished", opened: 0, closeAttempts: 0, closed: 0, closeFailures: 0, programError: "setup", disposals: [] })
    close(4)
  } })
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.equal(error.identityReceipt.handles.programError, "setup")
    assert.equal(error.identityReceipt.handles.confirmedDisposed, true)
    assert.ok(error.identityReceipt.missingStages.includes("native_ready"))
    return true
  })
})

test("synthetic: reported current-handle close failure cannot be erased by contradictory final counts", async () => {
  const f = fakeNative({ observe: ({ emit, request }) => emit({ state: "observation", sequence: request.sequence,
    sample: snapshot({ closeAttempted: true, closeSuccess: false, closeError: 6 }) }) })
  await assert.rejects(observeIdentity(input, session => session.observe(source, "baseline_current", nodeStat), f.dependencies), error => {
    assert.equal(error.identityReceipt.handles.confirmedDisposed, false)
    assert.equal(error.identityReceipt.uncertain, true)
    return true
  })
})

test("synthetic: a filesystem label without successful native volume query is not identified NTFS", async () => {
  const f = fakeNative({ baseline: { volumeSuccess: false, volumeError: 50 } })
  await assert.rejects(observeIdentity(input, () => assert.fail("failed volume query accepted"), f.dependencies), error => {
    assert.equal(error.identityReceipt.outcome, "unsupported")
    return true
  })
})

test("synthetic: every native CloseHandle result is retained safely, including unsigned failure codes", async () => {
  const f = fakeNative({ finish: ({ emit, close }) => {
    emit({ state: "finished", opened: 1, closeAttempts: 1, closed: 0, closeFailures: 1, programError: null,
      disposals: [{ phase: "finish", success: false, error: 0xffffffff, private: "PRIVATE_NATIVE_OUTPUT" }] })
    close(5)
  } })
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.deepEqual(error.identityReceipt.handles.disposals, [{ phase: "finish", success: false, error: 4294967295 }])
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_NATIVE_OUTPUT"), false)
    assert.equal(error.identityReceipt.uncertain, true)
    return true
  })
})

test("synthetic: missing child PID cannot be treated as a matching READY PID", async () => {
  const f = fakeNative({ start: ({ emit }) => emit(readyMessage({ pid: undefined })) })
  f.child.pid = undefined
  await assert.rejects(observeIdentity(input, () => assert.fail("missing PID accepted"), f.dependencies), error => {
    assert.equal(error.identityReceipt.readyPidMatchesChild, false)
    assert.equal(error.identityReceipt.executedProgramSha256, null)
    return true
  })
})

test("synthetic: a partial successful observation survives the exact later callback failure", async () => {
  const f = fakeNative(), primary = new Error("controlled later failure")
  await assert.rejects(observeIdentity(input, async session => {
    await session.observe(source, "baseline_current", nodeStat, admittedIdentity)
    throw primary
  }, f.dependencies), error => {
    assert.equal(error, primary)
    assert.equal(error.identityReceipt.observations.length, 1)
    assert.equal(error.identityReceipt.observations[0].sameAsBaseline, true)
    assert.equal(error.identityReceipt.handles.confirmedDisposed, true)
    assert.equal(error.identityReceipt.outcome, "failed")
    assert.equal(error.identityReceipt.uncertain, false)
    return true
  })
})

for (const [name, options, expected] of [
  ["readiness timeout", { start: () => {} }, "readiness timeout"],
  ["observation ACK timeout", { observe: () => {} }, "observation ACK timeout"],
  ["oversized stderr", { start: ({ child }) => child.stderr.emit("data", Buffer.alloc(16385, 65)) }, "stderr_oversized"],
  ["native stdin error", { start: ({ child }) => child.stdin.emit("error", new Error("PRIVATE_PIPE_PATH")) }, "stdin_error"],
]) test(`synthetic: ${name} keeps bounded partial receipts`, async () => {
  const f = fakeNative(options)
  await assert.rejects(observeIdentity(input, session => session.observe(source, "baseline_current", nodeStat), f.dependencies), error => {
    assert.match(error.message, new RegExp(expected))
    assert.equal(JSON.stringify(error.identityReceipt).includes("PRIVATE_PIPE_PATH"), false)
    assert.notEqual(error.identityReceipt.outcome, "observed")
    assert.ok(error.identityReceipt.events.length <= 128)
    return true
  })
})

test("synthetic: unavailable runtime and spawn failure are explicit without native path disclosure", async () => {
  for (const override of [{ env: {} }, { spawn() { throw new Error("PRIVATE_EXECUTABLE_PATH") } }]) {
    const f = fakeNative()
    await assert.rejects(observeIdentity(input, async () => {}, { ...f.dependencies, ...override }), error => {
      assert.equal(error.identityReceipt.executedProgramSha256, null)
      assert.equal(error.message.includes("PRIVATE_EXECUTABLE_PATH"), false)
      return true
    })
  }
})

test("synthetic: signed Node values are observed as mismatches, never reshaped to unsigned matches", async () => {
  const f = fakeNative()
  const receipt = await observeIdentity({ ...input, nodeBaseline: { ...nodeStat, ino: -1n } }, async () => {}, f.dependencies)
  assert.equal(receipt.baseline.nodeInodeEqualsNativeLow64, false)
  assert.equal(receipt.baseline.nodeTupleMatchesAdmission, false)
  const number = fakeNative()
  await assert.rejects(observeIdentity({ ...input, nodeBaseline: { ...nodeStat, ino: Number(nodeStat.ino) } },
    async () => {}, number.dependencies), /requires BigInt lstat/)
})

test("synthetic: close without an observed native exit is not normally qualified retirement", async () => {
  const f = fakeNative({ finish: ({ emit }) => {
    emit({ state: "finished", opened: 1, closeAttempts: 1, closed: 1, closeFailures: 0, programError: null,
      disposals: [{ phase: "finish", success: true, error: null }] })
    f.child.emit("close", 0, null)
  } })
  await assert.rejects(observeIdentity(input, async () => {}, f.dependencies), error => {
    assert.ok(error.identityReceipt.missingStages.includes("native_exit"))
    assert.equal(error.identityReceipt.retirement, "unconfirmed")
    assert.equal(error.identityReceipt.uncertain, true)
    return true
  })
})

test("synthetic: a stale successful CloseHandle error cannot be retained as a meaningful API failure", async () => {
  const f = fakeNative({ observe: ({ emit, request }) => emit({ state: "observation", sequence: request.sequence,
    sample: snapshot({ closeAttempted: true, closeSuccess: true, closeError: 5 }) }) })
  await assert.rejects(observeIdentity(input, session => session.observe(source, "baseline_current", nodeStat), f.dependencies),
    /invalid disposal result/)
})

test("synthetic: an idle Node observation phase is bounded and still disposes the native baseline", async () => {
  const f = fakeNative()
  let timer
  const late = new Promise(resolve => { timer = setTimeout(resolve, 30) })
  try {
    await assert.rejects(observeIdentity(input, () => late, f.dependencies), error => {
      assert.match(error.message, /Node observation phase timeout/)
      assert.equal(error.identityReceipt.handles.confirmedDisposed, true)
      assert.equal(error.identityReceipt.retirement, "confirmed")
      return true
    })
  } finally { clearTimeout(timer) }
})

test("synthetic: unsupported current full identity is retained and refused without a low-64 fallback", async () => {
  const f = fakeNative({ observe: ({ emit, request }) => emit({ state: "observation", sequence: request.sequence,
    sample: snapshot({ idSuccess: false, idError: 50, closeAttempted: true, closeSuccess: true }) }) })
  await assert.rejects(observeIdentity(input, session => session.observe(source, "baseline_current", nodeStat), f.dependencies), error => {
    assert.equal(error.identityReceipt.outcome, "unsupported")
    assert.equal(error.identityReceipt.observations[0].status, "unsupported")
    assert.equal(error.identityReceipt.observations[0].nodeInodeEqualsNativeLow64, null)
    assert.equal(error.identityReceipt.handles.confirmedDisposed, true)
    return true
  })
})

test("synthetic: rename discriminator records one Node call and a closed refusal without private errors", async () => {
  const record = { requestedRoute: "node_fs_rename" }
  let calls = 0
  await observeRenameAttempt(source, "C:\\owned\\destination", record, {
    rename: async () => {
      calls++
      throw Object.assign(new Error("PRIVATE_RENAME_PATH"), { code: "EPERM", syscall: "rename", errno: -4048 })
    },
  })
  assert.equal(calls, 1)
  assert.deepEqual(record.renameAttempt, { requestedRoute: "node_fs_rename", actualInvocation: "node_fs_rename",
    outcome: "refused", error: { code: "EPERM", syscall: "rename", errno: -4048 }, nativeMove: null })
  assert.equal(JSON.stringify(record).includes("PRIVATE_RENAME_PATH"), false)
})

test("synthetic: rename discriminator preserves unknown Node failures instead of reporting an observed refusal", async () => {
  const record = { requestedRoute: "node_fs_rename" }
  const primary = Object.assign(new Error("PRIVATE_RENAME_PATH"), { code: "PRIVATE_CODE", syscall: "PRIVATE_SYSCALL" })
  await assert.rejects(observeRenameAttempt(source, "C:\\owned\\destination", record, {
    rename: async () => { throw primary },
  }), error => error === primary)
  assert.equal(record.renameAttempt.outcome, "unqualified")
  assert.deepEqual(record.renameAttempt.error, { code: "unavailable", syscall: null, errno: null })
  assert.equal(JSON.stringify(record).includes("PRIVATE_"), false)
})

test("synthetic: rename discriminator does not relabel an unretired native operation as a refusal", async () => {
  const record = { requestedRoute: "native_Directory_Move" }
  const primary = new Error("PRIVATE_NATIVE_ERROR")
  const observation = {
    receipt: { spawnReached: true, executableMatches: true, programHash: "a".repeat(64), childPid: 42,
      ready: { valid: true, pidMatchesChild: true }, ack: { valid: true, moved: false }, events: [],
      protocolIssues: [], droppedEvents: 0, exit: null, close: null },
    before: async () => {}, after: async () => {}, returned() {}, threw() {},
  }
  await assert.rejects(observeRenameAttempt(source, "C:\\owned\\destination", record, {
    nativeMove: async () => { throw primary }, makeObserver: () => observation,
  }), error => error === primary)
  assert.equal(record.renameAttempt.outcome, "unqualified")
  assert.equal(record.renameAttempt.nativeMove.close, null)
  assert.equal(JSON.stringify(record).includes("PRIVATE_"), false)
})

for (const moved of [false, true]) {
  test(`synthetic: rename discriminator retains a fully closed native ${moved ? "move" : "refusal"} without fallback`, async () => {
    const record = { requestedRoute: "native_Directory_Move" }
    const state = { released: true, closed: true, forced: false, retirement: "confirmed",
      movement: moved ? "confirmed" : "refused" }
    const primary = new Error("PRIVATE_NATIVE_REFUSAL")
    const receipt = { spawnReached: true, executableMatches: true, programHash: "a".repeat(64), childPid: 42,
      ready: { valid: true, pidMatchesChild: true }, ack: { valid: true, moved },
      events: [{ type: "native-request-attempted", sourceMatches: true, destinationMatches: true },
        { type: "native-release-attempted", literalMatches: true }],
      protocolIssues: [], missingNativeStages: [], droppedEvents: 0,
      exit: { code: moved ? 0 : 3, signal: null }, close: { code: moved ? 0 : 3, signal: null } }
    let calls = 0, before = 0, after = 0
    const observer = { receipt, before: async () => { before++ }, after: async () => { after++ },
      returned: () => { receipt.helper = { state } }, threw: () => { receipt.helper = { state } } }
    await observeRenameAttempt(source, "C:\\owned\\destination", record, {
      makeObserver: () => observer,
      rename: () => assert.fail("native comparison fell back to Node"),
      nativeMove: async (src, dst, atUse) => {
        calls++
        assert.equal(src, source)
        assert.equal(dst, "C:\\owned\\destination")
        await atUse()
        if (!moved) throw primary
        return state
      },
    })
    assert.equal(calls, 1)
    assert.equal(before, 1)
    assert.equal(after, 1)
    assert.equal(record.renameAttempt.outcome, moved ? "moved" : "refused")
    assert.equal(record.renameAttempt.actualInvocation, "native_Directory_Move")
    assert.equal(record.renameAttempt.nativeMove.helper.state.retirement, "confirmed")
    assert.equal(JSON.stringify(record).includes("PRIVATE_"), false)
  })
}

test("synthetic: rename discriminator keeps its first operation error when observation cleanup also fails", async () => {
  const record = { requestedRoute: "native_Directory_Move" }
  const primary = new Error("PRIVATE_PRIMARY")
  const cleanup = new Error("PRIVATE_CLEANUP")
  const observer = { receipt: {}, before: async () => {}, after: async () => { throw cleanup }, threw() {} }
  await assert.rejects(observeRenameAttempt(source, "C:\\owned\\destination", record, {
    makeObserver: () => observer, nativeMove: async () => { throw primary },
  }), error => error === primary)
  assert.equal(record.renameAttempt.outcome, "unqualified")
  assert.equal(record.renameAttempt.observationFailure, true)
  assert.equal(JSON.stringify(record).includes("PRIVATE_"), false)
})

const renameCodes = new Set(["ENOENT", "EPERM", "EACCES", "EBUSY", "EEXIST", "ENOTEMPTY", "ENOTDIR", "EXDEV"])
async function observeRenameAttempt(source, destination, record, {
  rename = fs.rename, nativeMove = moveArchive, makeObserver = nativeMoveObserver,
} = {}) {
  const attempt = record.renameAttempt = { requestedRoute: record.requestedRoute, actualInvocation: null,
    outcome: "unqualified", error: null, nativeMove: null }
  if (record.requestedRoute === "node_fs_rename") {
    attempt.actualInvocation = "node_fs_rename"
    try {
      await rename(source, destination)
      attempt.outcome = "moved"
    } catch (error) {
      attempt.error = { code: renameCodes.has(error.code) ? error.code : "unavailable",
        syscall: error.syscall === "rename" ? "rename" : null,
        errno: Number.isInteger(error.errno) && error.errno >= -2147483648 && error.errno <= 2147483647 ? error.errno : null }
      if (!renameCodes.has(error.code)) throw error
      attempt.outcome = "refused"
    }
    return
  }
  assert.equal(record.requestedRoute, "native_Directory_Move")
  const observer = makeObserver({ source, destination, fixture: { src: source, dst: destination } })
  let failure, observationFailure
  try {
    const state = await nativeMove(source, destination, async () => {
      await observer.before()
      attempt.actualInvocation = "native_Directory_Move"
    }, { spawn: observer.spawn })
    observer.returned(state)
  } catch (error) { failure = error; observer.threw(error) }
  finally {
    try { await observer.after() } catch (error) {
      observationFailure = true
      failure ??= error
    }
    attempt.nativeMove = Object.fromEntries(["spawnReached", "executableMatches", "programHash", "childPid", "ready", "ack",
      "exit", "close", "helper", "events", "protocolIssues", "droppedEvents", "missingNativeStages"]
      .map(key => [key, observer.receipt[key] ?? null]))
    if (observationFailure) attempt.observationFailure = true
  }
  const r = attempt.nativeMove, state = r.helper?.state, moved = r.ack?.moved
  const qualified = !observationFailure && r.spawnReached && r.executableMatches && r.ready?.valid &&
    r.ready.pidMatchesChild && r.ack?.valid && r.protocolIssues?.length === 0 && r.droppedEvents === 0 &&
    r.missingNativeStages?.length === 0 && r.events.some(event => event.type === "native-request-attempted" &&
      event.sourceMatches && event.destinationMatches) &&
    r.events.some(event => event.type === "native-release-attempted" && event.literalMatches) &&
    r.exit?.code === (moved ? 0 : 3) && r.exit.signal === null &&
    r.close?.code === r.exit.code && r.close.signal === null && state?.closed && !state.forced &&
    state.retirement === "confirmed" && state.movement === (moved ? "confirmed" : "refused")
  if (!qualified || moved !== !failure) throw failure ?? new Error("Native rename discriminator receipt unqualified")
  attempt.outcome = moved ? "moved" : "refused"
}

const actual = []
async function persistActual() {
  if (actual.length === 0) return
  await fs.writeFile(identityArtifactPath(), JSON.stringify({
    schema: 1, scope: "observation_only", observationKind: "finite_ntfs_identity_bridge_only",
    actualRace: false, renameCandidate: false, identityAuthority: false, cases: actual,
    limits: ["finite_controlled_fixture_only", "Node_does_not_expose_complete_native_identity",
      "low_part_matches_do_not_reconstruct_missing_bits", "not_general_NTFS_identity_authority",
      "original_Windows_archive_counterexample_unwaived"],
  }, null, 2) + "\n")
}
after(persistActual)

async function fixture(record, { rootAlias = false, nodeReference = true } = {}) {
  record.fixtureStage = "runtime_check"
  assert.equal(process.versions.node, "24.18.0", "finite source-contract fixture requires Node 24.18.0")
  record.fixtureStage = "temp_root"
  const base = await mkTempRoot("desk-identity-observation-"), container = path.join(base, "身份's & $(data)")
  let root = container, physicalRoot = container
  record.fixtureStage = "root_mkdir"
  await fs.mkdir(container)
  if (rootAlias) {
    physicalRoot = path.join(container, "physical")
    record.fixtureStage = "alias_physical_mkdir"
    await fs.mkdir(physicalRoot)
    root = path.join(container, "root-alias")
    record.fixtureStage = "alias_junction_create"
    await fs.symlink(physicalRoot, root, "junction")
    record.fixtureStage = "alias_lstat"
    record.fixtureFacts.aliasConstructed = (await fs.lstat(root)).isSymbolicLink()
    assert.equal(record.fixtureFacts.aliasConstructed, true)
  }
  const src = path.join(root, "source")
  record.fixtureStage = "source_mkdir"
  await fs.mkdir(src)
  record.fixtureStage = "archive_mkdir"
  await fs.mkdir(path.join(root, "_archive"))
  const marker = randomBytes(32)
  record.fixtureStage = "marker_write"
  await fs.writeFile(path.join(src, "task.md"), marker)
  record.fixtureStage = "prepare"
  const prepared = await prepareArchiveState({ effectiveRoot: root, srcDir: src,
    archiveDir: path.join(root, "_archive", "source"), srcFile: path.join(src, "task.md"), spawnGit: spawnSync })
  record.fixtureStage = "source_lstat"
  const node = await fs.lstat(src, { bigint: true })
  record.fixtureStage = "reference_open"
  const reference = nodeReference ? await fs.open(path.join(src, "task.md"), "r") : null
  const referenceMatches = async () => {
    assert.ok(reference, "independent marker reference was not requested")
    const buffer = Buffer.alloc(32)
    const result = await reference.read(buffer, 0, buffer.length, 0)
    return result.bytesRead === 32 && buffer.equals(marker)
  }
  return { root, src, physicalSource: path.join(physicalRoot, "source"), marker, reference, referenceMatches, prepared,
    admission: prepared.snapshot.get("").identity, node }
}
function actualCell(name, body, options = {}) {
  test(`actual Windows: ${name}`, { skip: process.platform !== "win32", timeout: 20000 }, async () => {
    const record = { name, platform: process.platform, node: process.versions.node,
      caseKind: options.diagnostic ? "rename_handle_route_discriminator" : "identity_relationship_acceptance",
      replacementPhaseBegunAtBaseline: false, receipt: null,
      fixtureFacts: { nodeReferenceAcquired: false, nodeReferenceClosed: null },
      casePersistenceAttempted: false, casePersistenceCompleted: false, outcome: "incomplete" }
    actual.push(record)
    let f, failure
    try {
      f = await fixture(record, options)
      record.fixtureFacts.nodeReferenceAcquired = f.reference !== null
      await body(f, record)
    } catch (error) {
      record.receipt ??= error.identityReceipt ?? null
      record.outcome = "failed"
      record.errorPhase = error.identityReceipt ? "native_session" : "fixture"
      record.firstFailureStage = record.fixtureStage
      record.errorCode = ["ENOENT", "EPERM", "EACCES", "ERR_ASSERTION", "IDENTITY_OBSERVATION"].includes(error.code) ? error.code : "unavailable"
      failure = new Error(`Identity observation fixture failed (${record.errorCode}); partial safe receipt retained`)
    } finally {
      if (f?.reference) {
        try {
          record.fixtureStage = "reference_close"
          await f.reference.close()
          record.fixtureFacts.nodeReferenceClosed = true
        } catch {
          record.fixtureFacts.nodeReferenceClosed = false
          record.nodeReferenceClosureFailure = true
          record.outcome = "failed"
          record.errorPhase ??= "node_reference_close"
          record.firstFailureStage ??= record.fixtureStage
          failure ??= new Error("Identity fixture Node reference closure unconfirmed; safe receipt retained")
        }
      }
    }
    // Persist before file-level fixture cleanup, including an unsettled native
    // session or failed Node-reference close. Neither failure erases its receipt.
    if (!failure) record.outcome = "observed"
    try {
      record.casePersistenceAttempted = true
      await persistActual()
      record.casePersistenceCompleted = true
    } catch (error) {
      const code = ["EIO", "EACCES", "EPERM", "ENOSPC"].includes(error.code) ? error.code : "unavailable"
      console.error("Identity observation persistence failed:", code)
      record.outcome = "failed"
      record.errorPhase ??= "persistence"
      failure ??= new Error("Identity observation persistence unavailable")
    }
    if (failure) throw failure
  })
}
const observeActual = async (f, record, work, sourcePath = f.src, admission = f.admission) => {
  try {
    record.fixtureStage = "native_observation"
    record.receipt = await observeIdentity({ source: sourcePath, nodeBaseline: await fs.lstat(sourcePath, { bigint: true }),
      admittedIdentity: admission }, async session => {
      await f.prepared.atUse()
      record.fixtureFacts.realSnapshotRecheckedBeforeObservation = true
      if (f.reference) {
        record.fixtureFacts.originalReferenceMatchesMarker = await f.referenceMatches()
        assert.equal(record.fixtureFacts.originalReferenceMatchesMarker, true)
      } else {
        record.fixtureFacts.payloadBeforeMatchesMarker = (await fs.readFile(path.join(f.src, "task.md"))).equals(f.marker)
        assert.equal(record.fixtureFacts.payloadBeforeMatchesMarker, true)
      }
      await work(session)
    })
  } catch (error) { record.receipt = error.identityReceipt ?? null; throw error }
}

actualCell("ordinary source observes real prepared snapshot without claiming a bridge", async (f, record) => {
  await observeActual(f, record, async session => {
    const sample = await session.observe(f.src, "baseline_current", await fs.lstat(f.src, { bigint: true }), f.admission)
    assert.equal(sample.sameAsBaseline, true)
    assert.equal(sample.nodeTupleMatchesAdmission, true)
    assert.equal(sample.reparse, false)
  })
})

actualCell("owned root alias observes the same full native object", async (f, record) => {
  assert.equal(record.fixtureFacts.aliasConstructed, true)
  record.fixtureStage = "native_observation"
  record.receipt = await observeIdentity({ source: f.src,
    nodeBaseline: await fs.lstat(f.src, { bigint: true }), admittedIdentity: f.admission }, async session => {
    await f.prepared.atUse()
    assert.equal(await f.referenceMatches(), true)
    const a = await session.observe(f.physicalSource, "physical", await fs.lstat(f.physicalSource, { bigint: true }), f.admission)
    const b = await session.observe(f.src, "alias", await fs.lstat(f.src, { bigint: true }), f.admission)
    assert.equal(a.sameAsBaseline, true)
    assert.equal(b.sameAsBaseline, true)
    assert.equal(a.reparse, false)
    assert.equal(b.reparse, false)
    assert.equal(a.nodeTupleMatchesAdmission, true)
    assert.equal(b.nodeTupleMatchesAdmission, true)
    record.fixtureFacts.originalReferenceMatchesMarker = true
  })
}, { rootAlias: true })

actualCell("native-anchored sequential rename preserves full identity while the old name disappears", async (f, record) => {
  record.anchorKind = "native_full_identity_handle"
  record.nodeMarkerReferenceHeld = false
  record.markerVerification = "completed_reads"
  await observeActual(f, record, async session => {
    const moved = path.join(f.root, "renamed-original")
    await fs.rename(f.src, moved)
    await assert.rejects(fs.lstat(f.src), { code: "ENOENT" })
    const absent = await session.observe(f.src, "old_name", null)
    assert.equal(absent.openSuccess, false)
    assert.ok([2, 3].includes(absent.openError))
    const found = await session.observe(moved, "new_name", await fs.lstat(moved, { bigint: true }), f.admission)
    assert.equal(found.sameAsBaseline, true)
    record.fixtureFacts.nativeIdentityPersistsAcrossRename = found.sameAsBaseline
    record.fixtureFacts.originalPayloadMatchesMarkerAfterRename = (await fs.readFile(path.join(moved, "task.md"))).equals(f.marker)
    assert.equal(record.fixtureFacts.originalPayloadMatchesMarkerAfterRename, true)
  })
}, { nodeReference: false })

actualCell("native-anchored replacement differs from the retained original and is rejected by real admission", async (f, record) => {
  record.anchorKind = "native_full_identity_handle"
  record.nodeMarkerReferenceHeld = false
  record.markerVerification = "completed_reads"
  await observeActual(f, record, async session => {
    const retained = path.join(f.root, "retained-original")
    await fs.rename(f.src, retained)
    await fs.mkdir(f.src)
    const replacement = randomBytes(32)
    await fs.writeFile(path.join(f.src, "task.md"), replacement)
    record.fixtureFacts.replacementConstructedAfterBaseline = true
    const changed = await session.observe(f.src, "replacement", await fs.lstat(f.src, { bigint: true }), f.admission)
    const original = await session.observe(retained, "retained_original", await fs.lstat(retained, { bigint: true }), f.admission)
    assert.equal(changed.sameAsBaseline, false)
    record.fixtureFacts.replacementNodeTupleMatchesOriginalAdmission = changed.nodeTupleMatchesAdmission
    assert.equal(original.sameAsBaseline, true)
    record.fixtureFacts.retainedOriginalNativeIdentityMatchesBaseline = original.sameAsBaseline
    record.fixtureFacts.replacementNativeIdentityMatchesBaseline = changed.sameAsBaseline
    await assert.rejects(f.prepared.atUse())
    record.fixtureFacts.realAdmissionRejectedReplacement = true
    record.fixtureFacts.originalPayloadMatchesMarkerAfterReplacement = (await fs.readFile(path.join(retained, "task.md"))).equals(f.marker)
    record.fixtureFacts.oldNameContainsIndependentReplacement = (await fs.readFile(path.join(f.src, "task.md"))).equals(replacement)
    assert.equal(record.fixtureFacts.originalPayloadMatchesMarkerAfterReplacement, true)
    assert.equal(record.fixtureFacts.oldNameContainsIndependentReplacement, true)
  })
}, { nodeReference: false })

actualCell("final-component reparse is observed without following it to its target", async (f, record) => {
  const link = path.join(f.root, "source-link")
  await fs.symlink(f.src, link, "junction")
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
  record.fixtureFacts.reparseConstructed = true
  record.fixtureStage = "native_observation"
  record.receipt = await observeIdentity({ source: link, nodeBaseline: await fs.lstat(link, { bigint: true }) }, async session => {
    const entry = await session.observe(link, "reparse_entry", await fs.lstat(link, { bigint: true }))
    const target = await session.observe(f.src, "target", await fs.lstat(f.src, { bigint: true }), f.admission)
    assert.equal(entry.reparse, true)
    assert.equal(entry.sameAsBaseline, true)
    assert.equal(target.reparse, false)
    assert.equal(target.sameAsBaseline, false)
    record.fixtureFacts.originalReferenceMatchesMarker = await f.referenceMatches()
    assert.equal(record.fixtureFacts.originalReferenceMatchesMarker, true)
  })
})

for (const nodeReference of [false, true]) for (const nativeBaseline of [false, true]) {
  for (const route of ["node_fs_rename", "native_Directory_Move"]) {
    actualCell(`diagnostic only: marker=${nodeReference}, baseline=${nativeBaseline}, route=${route}`, async (f, record) => {
      record.requestedRoute = route
      record.diagnosticFactors = { nodeMarkerReferenceHeld: nodeReference, nativeMetadataBaselineHeld: nativeBaseline }
      record.controlKind = nodeReference ? "finite_Node_marker_held_refusal" : "finite_route_discriminator"
      record.causalConclusion = "not_established"
      const moved = path.join(f.root, "renamed-original")
      const present = async file => {
        try { return (await fs.lstat(file)).isDirectory() }
        catch (error) { if (error.code === "ENOENT") return false; throw error }
      }
      const work = async session => {
        record.fixtureStage = "diagnostic_admission"
        await f.prepared.atUse()
        record.fixtureFacts.realSnapshotRecheckedBeforeObservation = true
        record.fixtureFacts.payloadBeforeMatchesMarker = (await fs.readFile(path.join(f.src, "task.md"))).equals(f.marker)
        assert.equal(record.fixtureFacts.payloadBeforeMatchesMarker, true)
        if (nodeReference) {
          record.fixtureFacts.originalReferenceMatchesMarker = await f.referenceMatches()
          assert.equal(record.fixtureFacts.originalReferenceMatchesMarker, true)
        }
        record.fixtureStage = "diagnostic_rename_attempt"
        await observeRenameAttempt(f.src, moved, record)
        if (nodeReference) assert.equal(record.renameAttempt.outcome, "refused")
        record.fixtureStage = "diagnostic_placement"
        record.placement = { sourcePresent: await present(f.src), destinationPresent: await present(moved) }
        const renamed = record.renameAttempt.outcome === "moved"
        assert.deepEqual(record.placement, { sourcePresent: !renamed, destinationPresent: renamed })
        const location = renamed ? moved : f.src
        record.fixtureFacts.payloadAfterMatchesMarker = (await fs.readFile(path.join(location, "task.md"))).equals(f.marker)
        assert.equal(record.fixtureFacts.payloadAfterMatchesMarker, true)
        if (nodeReference) {
          record.fixtureFacts.originalReferenceSurvivesAttempt = await f.referenceMatches()
          assert.equal(record.fixtureFacts.originalReferenceSurvivesAttempt, true)
        }
        if (session) {
          record.fixtureStage = "diagnostic_current_identity"
          const sample = await session.observe(location, renamed ? "new_name" : "baseline_current",
            await fs.lstat(location, { bigint: true }), f.admission)
          assert.equal(sample.sameAsBaseline, true)
          assert.equal(sample.reparse, false)
        }
      }
      if (!nativeBaseline) {
        record.nativeBaseline = "not_requested"
        await work(null)
        return
      }
      let phase, failure
      try {
        record.fixtureStage = "diagnostic_native_baseline"
        record.receipt = await observeIdentity({ source: f.src, nodeBaseline: f.node, admittedIdentity: f.admission },
          session => { phase = work(session); return phase })
      } catch (error) { record.receipt = error.identityReceipt ?? null; failure = error }
      finally {
        // A timed-out observation does not cancel its callback. Drain the bounded
        // route before closing the marker reference or persisting this failed cell.
        if (phase) {
          try { await phase } catch (error) { failure ??= error }
        }
      }
      if (failure) throw failure
    }, { nodeReference, diagnostic: true })
  }
}
