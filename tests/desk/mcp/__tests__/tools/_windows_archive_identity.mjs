// Test-only read-only observer. No rename primitive or admission authority.
import { spawn as spawnChild } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const PROGRAM = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:opened = 0
$script:closeAttempts = 0
$script:closed = 0
$script:closeFailures = 0
$script:disposals = New-Object 'System.Collections.Generic.List[System.Object]'
$baselineHandle = [IntPtr]::Zero
$native = $null
$phase = 'setup'
$programError = $null
$script:operation = 'setup'
$script:firstFailure = $null
$script:metadataMethodCount = $null
$script:metadataMethodCountStatus = 'not_reached'
$script:metadataFailedCheck = $null
$script:metadataCurrentMethod = $null
$script:metadataRows = New-Object 'System.Collections.Generic.List[System.Object]'
$script:metadataByName = @{}
foreach ($fixedName in @('CreateFileW', 'GetFileInformationByHandleEx', 'GetVolumeInformationByHandleW', 'CloseHandle')) {
  $row = @{ method = $fixedName; status = 'not_reached'; importCount = $null; importCountStatus = 'not_reached'
    setLastError = 'not_reached'; exactSpelling = 'not_reached'; unicode = 'not_reached'
    winapi = 'not_reached'; methodImplementationPreserveSig = 'not_reached' }
  [void]$script:metadataRows.Add($row)
  $script:metadataByName.Add($fixedName, $row)
}
$access = [uint32]0
$share = [uint32]7
$disposition = [uint32]3
$flags = [uint32]35651584
function Emit($value) {
  [Console]::WriteLine(($value | ConvertTo-Json -Depth 8 -Compress))
  [Console]::Out.Flush()
}
function Error-Code($ok, [int]$last) {
  if (!$ok) { return [BitConverter]::ToUInt32([BitConverter]::GetBytes($last), 0) }
  return $null
}
function Remember-ApiFailure([int]$last) {
  if ($null -eq $script:firstFailure) {
    $script:firstFailure = @{ operation = $script:operation; kind = 'api_return'
      exception = $null; hresult = $null; nativeError = (Error-Code $false $last) }
  }
}
function Remember-Exception($exception) {
  if ($null -eq $script:firstFailure) {
    $failure = $exception.GetBaseException()
    $name = $failure.GetType().FullName
    if (@('System.InvalidOperationException', 'System.ArgumentException', 'System.TypeLoadException',
      'System.MissingMethodException', 'System.EntryPointNotFoundException', 'System.DllNotFoundException',
      'System.Runtime.InteropServices.MarshalDirectiveException', 'System.Reflection.AmbiguousMatchException',
      'System.Management.Automation.RuntimeException', 'System.Management.Automation.MethodException',
      'System.Management.Automation.MethodInvocationException', 'System.Management.Automation.ParameterBindingException') -notcontains $name) {
      $name = 'other'
    }
    function Fail-Metadata([string]$check, $methodName) {
      if ($null -eq $script:metadataFailedCheck) {
        $script:metadataFailedCheck = @{ check = $check; method = $methodName }
      }
      throw 'invalid_emitted_metadata'
    }
    function Require-Metadata($row, [string]$key, $value, [string]$check) {
      $row[$key] = if ($null -eq $value) { 'unavailable' } else { $value }
      if ($value -ne $true) { Fail-Metadata $check $row.method }
    }
    $script:firstFailure = @{ operation = $script:operation; kind = 'exception'
      exception = $name; hresult = $failure.HResult; nativeError = $null }
  }
}
function Close-Owned([IntPtr]$handle) {
  $script:closeAttempts++
  $script:operation = 'dispose_handle'
  $ok = $native::CloseHandle($handle)
  $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if (!$ok) { Remember-ApiFailure $last }
  if ($ok) { $script:closed++ } else { $script:closeFailures++ }
  $result = @{ phase = $phase; success = [bool]$ok; error = (Error-Code $ok $last) }
  [void]$script:disposals.Add($result)
  return $result
}
function Read-Entry([string]$file) {
  $prefix = if ($phase -eq 'baseline') { 'baseline' } else { 'current' }
  $sample = @{
    openSuccess = $false; openError = $null
    volumeSuccess = $false; volumeError = $null; filesystem = 'unavailable'
    idSuccess = $false; idError = $null; volumeHex = $null; fileIdHex = $null
    attributeSuccess = $false; attributeError = $null; attributes = $null; reparseTag = $null
    closeAttempted = $false; closeSuccess = $null; closeError = $null
  }
  $script:operation = $prefix + '_open'
  $handle = $native::CreateFileW($file, $access, $share, [IntPtr]::Zero, $disposition, $flags, [IntPtr]::Zero)
  $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $sample.openSuccess = $handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr](-1)
  $sample.openError = Error-Code $sample.openSuccess $last
  if (!$sample.openSuccess) { Remember-ApiFailure $last; return @{ handle = [IntPtr]::Zero; sample = $sample } }
  $script:opened++
  try {
    $name = New-Object Text.StringBuilder(32)
    $script:operation = $prefix + '_volume'
    $ok = $native::GetVolumeInformationByHandleW($handle, [IntPtr]::Zero, [uint32]0,
      [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, $name, [uint32]32)
    $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $sample.volumeSuccess = [bool]$ok
    $sample.volumeError = Error-Code $ok $last
    if (!$ok) { Remember-ApiFailure $last }
    if ($ok) {
      if ($name.ToString() -ceq 'NTFS') { $sample.filesystem = 'NTFS' } else { $sample.filesystem = 'other' }
    }
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    try {
      $script:operation = $prefix + '_id'
      $ok = $native::GetFileInformationByHandleEx($handle, [int]18, $buffer, [uint32]24)
      $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $sample.idSuccess = [bool]$ok
      $sample.idError = Error-Code $ok $last
      if (!$ok) { Remember-ApiFailure $last }
      if ($ok) {
        $bytes = New-Object byte[] 24
        [Runtime.InteropServices.Marshal]::Copy($buffer, $bytes, 0, 24)
        $sample.volumeHex = [BitConverter]::ToString($bytes, 0, 8).Replace('-', '').ToLowerInvariant()
        $sample.fileIdHex = [BitConverter]::ToString($bytes, 8, 16).Replace('-', '').ToLowerInvariant()
      }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
    try {
      $script:operation = $prefix + '_attributes'
      $ok = $native::GetFileInformationByHandleEx($handle, [int]9, $buffer, [uint32]8)
      $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $sample.attributeSuccess = [bool]$ok
      $sample.attributeError = Error-Code $ok $last
      if (!$ok) { Remember-ApiFailure $last }
      if ($ok) {
        $bytes = New-Object byte[] 8
        [Runtime.InteropServices.Marshal]::Copy($buffer, $bytes, 0, 8)
        $sample.attributes = [BitConverter]::ToUInt32($bytes, 0)
        $sample.reparseTag = [BitConverter]::ToUInt32($bytes, 4)
      }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
  } catch {
    Remember-Exception $_.Exception
    $disposal = Close-Owned $handle
    throw
  }
  return @{ handle = $handle; sample = $sample }
}
try {
  $script:operation = 'emit_assembly'
  $assemblyName = New-Object Reflection.AssemblyName('DeskIdentityObservation')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $script:operation = 'emit_module'
  $module = $assembly.DefineDynamicModule('InMemory')
  $script:operation = 'emit_type'
  $type = $module.DefineType('DeskIdentityNative', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $script:operation = 'emit_import_metadata'
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@(
    [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
    [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'),
    [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
    [Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'))
  function Define-Native([string]$name, [type]$returns, [type[]]$parameters) {
    $script:operation = 'emit_method'
    $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', $name,
      [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
      $returns, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi,
      [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
    $attribute = [Reflection.Emit.CustomAttributeBuilder]::new($ctor,
      [object[]]@('kernel32.dll'), $fields, [object[]]@($true, $true,
        [Runtime.InteropServices.CharSet]::Unicode, [Runtime.InteropServices.CallingConvention]::Winapi))
    $script:operation = 'emit_method_metadata'
    $method.SetCustomAttribute($attribute)
  }
  Define-Native 'CreateFileW' ([IntPtr]) ([type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]))
  Define-Native 'GetFileInformationByHandleEx' ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32]))
  Define-Native 'GetVolumeInformationByHandleW' ([bool]) ([type[]]@([IntPtr], [IntPtr], [uint32], [IntPtr], [IntPtr], [IntPtr], [Text.StringBuilder], [uint32]))
  Define-Native 'CloseHandle' ([bool]) ([type[]]@([IntPtr]))
  $script:operation = 'create_type'
  $native = $type.CreateType()
  $script:operation = 'verify_metadata'
  try {
    $methods = $native.GetMethods([Reflection.BindingFlags]'Public, Static, DeclaredOnly')
    $script:metadataMethodCount = $methods.Count
    $script:metadataMethodCountStatus = 'observed'
    if ($methods.Count -ne 4) { Fail-Metadata 'method_count' $null }
    foreach ($method in $methods) {
      $script:metadataCurrentMethod = $null
      if (!$script:metadataByName.ContainsKey($method.Name)) { Fail-Metadata 'metadata_read' $null }
      $script:metadataCurrentMethod = $method.Name
      $row = $script:metadataByName[$method.Name]
      $row.status = 'observed'
      $imports = $method.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute], $false)
      $row.importCount = $imports.Count
      $row.importCountStatus = 'observed'
      if ($imports.Count -ne 1) { Fail-Metadata 'import_count' $method.Name }
      $lastError = $imports[0].SetLastError
      Require-Metadata $row 'setLastError' $lastError 'set_last_error'
      $exact = $imports[0].ExactSpelling
      Require-Metadata $row 'exactSpelling' $exact 'exact_spelling'
      $charset = $imports[0].CharSet
      $unicode = if ($null -eq $charset) { $null } else { $charset -eq [Runtime.InteropServices.CharSet]::Unicode }
      Require-Metadata $row 'unicode' $unicode 'charset'
      $convention = $imports[0].CallingConvention
      $winapi = if ($null -eq $convention) { $null } else { $convention -eq [Runtime.InteropServices.CallingConvention]::Winapi }
      Require-Metadata $row 'winapi' $winapi 'calling_convention'
      $implementation = $method.GetMethodImplementationFlags()
      $preserve = if ($null -eq $implementation) { $null } else {
        ($implementation -band [Reflection.MethodImplAttributes]::PreserveSig) -ne 0
      }
      Require-Metadata $row 'methodImplementationPreserveSig' $preserve 'preserve_sig'
    }
  } catch {
    if ($null -eq $script:metadataFailedCheck) {
      $script:metadataFailedCheck = @{ check = 'metadata_read'; method = $script:metadataCurrentMethod }
    }
    throw
  }
  $phase = 'request'
  $script:operation = 'read_request'
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 16384) { throw 'invalid_request' }
  $request = $line | ConvertFrom-Json
  if ($request.source -isnot [string] -or !$request.source) { throw 'invalid_request' }
  $phase = 'baseline'
  $baseline = Read-Entry $request.source
  $baselineHandle = $baseline.handle
  $script:operation = 'emit_ready'
  Emit @{ state = 'ready'; pid = $PID; powershell = $PSVersionTable.PSVersion.ToString()
    runtime = [Environment]::Version.ToString(); edition = [string]$PSVersionTable.PSEdition
    compiler = 'reflection_emit_in_process'; metadataVerified = $true
    openContract = @{ access = $access; share = $share; disposition = $disposition; flags = $flags }
    baseline = $baseline.sample }
  $phase = 'observe'
  $count = 0
  $script:operation = 'read_command'
  while ($null -ne ($line = [Console]::ReadLine())) {
    if ($line.Length -gt 16384) { throw 'invalid_request' }
    $command = $line | ConvertFrom-Json
    if ($command.command -ceq 'finish') { break }
    if ($command.command -cne 'observe' -or $command.path -isnot [string] -or !$command.path -or
        ($command.sequence -isnot [int] -and $command.sequence -isnot [long]) -or
        $command.sequence -ne ($count + 1) -or $count -ge 16) {
      throw 'invalid_request'
    }
    $count++
    $current = Read-Entry $command.path
    try { $sample = $current.sample }
    finally {
      if ($current.handle -ne [IntPtr]::Zero) {
        $sample.closeAttempted = $true
        $disposal = Close-Owned $current.handle
        $sample.closeSuccess = $disposal.success
        $sample.closeError = $disposal.error
      }
    }
    $script:operation = 'emit_observation'
    Emit @{ state = 'observation'; sequence = $count; sample = $sample }
    $script:operation = 'read_command'
  }
  $phase = 'finish'
} catch { Remember-Exception $_.Exception; $programError = $phase }
finally {
  if ($baselineHandle -ne [IntPtr]::Zero -and $null -ne $native) {
    $disposal = Close-Owned $baselineHandle
  }
  Emit @{ state = 'finished'; opened = $script:opened; closeAttempts = $script:closeAttempts
    closed = $script:closed; closeFailures = $script:closeFailures; programError = $programError
    firstFailure = $script:firstFailure; finalOperation = $script:operation
    metadataFacts = @{ methodCount = $script:metadataMethodCount; methodCountStatus = $script:metadataMethodCountStatus
      methods = @($script:metadataRows.ToArray()); failedCheck = $script:metadataFailedCheck }
    disposals = @($script:disposals.ToArray()) }
}
if ($null -ne $programError) { exit 4 }
if ($script:closeFailures -gt 0) { exit 5 }
exit 0
`

const digest = bytes => createHash("sha256").update(bytes).digest("hex")
const programSha256 = digest(PROGRAM)
const helperSha256 = digest(readFileSync(new URL(import.meta.url)))
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
const version = value => typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
const phases = new Set(["baseline_current", "physical", "alias", "old_name", "new_name", "replacement",
  "retained_original", "reparse_entry", "target"])
const stages = ["native_spawn", "native_ready", "native_finished", "native_exit", "native_close"]
const error = message => Object.assign(new Error(`Identity observation: ${message}`), { code: "IDENTITY_OBSERVATION" })
const operations = new Set(["setup", "emit_assembly", "emit_module", "emit_type", "emit_import_metadata",
  "emit_method", "emit_method_metadata", "create_type", "verify_metadata", "read_request", "read_command",
  "baseline_open", "baseline_volume", "baseline_id", "baseline_attributes", "current_open", "current_volume",
  "current_id", "current_attributes", "dispose_handle", "emit_ready", "emit_observation"])
const exceptionClasses = new Set(["System.InvalidOperationException", "System.ArgumentException", "System.TypeLoadException",
  "System.MissingMethodException", "System.EntryPointNotFoundException", "System.DllNotFoundException",
  "System.Runtime.InteropServices.MarshalDirectiveException", "System.Reflection.AmbiguousMatchException",
  "System.Management.Automation.RuntimeException", "System.Management.Automation.MethodException",
  "System.Management.Automation.MethodInvocationException", "System.Management.Automation.ParameterBindingException"])
const signedInt = value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647
const safeFailure = value => value == null ? null : {
  operation: operations.has(value.operation) ? value.operation : "unknown",
  kind: ["exception", "api_return"].includes(value.kind) ? value.kind : "unknown",
  exception: value.exception === null ? null : exceptionClasses.has(value.exception) ? value.exception : "other",
  hresult: signedInt(value.hresult) ? value.hresult : null,
  nativeError: uint(value.nativeError) ? value.nativeError : null,
}
const nativeMethods = ["CreateFileW", "GetFileInformationByHandleEx", "GetVolumeInformationByHandleW", "CloseHandle"]
const metadataChecks = new Set(["method_count", "import_count", "set_last_error", "exact_spelling",
  "charset", "calling_convention", "preserve_sig", "metadata_read"])
const metadataFlags = ["setLastError", "exactSpelling", "unicode", "winapi", "methodImplementationPreserveSig"]
const factStatus = value => ["observed", "unavailable", "not_reached"].includes(value) ? value : "unavailable"
function safeMetadata(value) {
  const rows = Array.isArray(value?.methods) ? value.methods.slice(0, 16) : []
  return {
    methodCount: uint(value?.methodCount) && value.methodCount <= 16 ? value.methodCount : null,
    methodCountStatus: value == null ? "not_reached" : factStatus(value.methodCountStatus),
    unknownMethodsObserved: rows.some(row => !nativeMethods.includes(row?.method)),
    duplicateMethodsObserved: nativeMethods.some(name => rows.filter(row => row?.method === name).length > 1),
    methodsTruncated: Array.isArray(value?.methods) && value.methods.length > 16,
    factSources: { methodCount: "Type.GetMethods_Public_Static_DeclaredOnly",
      importCount: "MethodInfo.GetCustomAttributes_DllImportAttribute",
      attributeFlags: "DllImportAttribute_fields",
      methodImplementationPreserveSig: "MethodInfo.GetMethodImplementationFlags" },
    methods: nativeMethods.map(method => {
      const row = rows.find(item => item?.method === method)
      return { method, status: row ? factStatus(row.status) : "not_reached",
        importCount: uint(row?.importCount) && row.importCount <= 16 ? row.importCount : null,
        importCountStatus: row ? factStatus(row.importCountStatus) : "not_reached",
        ...Object.fromEntries(metadataFlags.map(key => [key, !row ? "not_reached" : typeof row[key] === "boolean" ? row[key] :
          ["unavailable", "not_reached"].includes(row[key]) ? row[key] : "unavailable"])) }
    }),
    failedCheck: value?.failedCheck == null ? null : {
      check: metadataChecks.has(value.failedCheck.check) ? value.failedCheck.check : "unknown",
      method: value.failedCheck.method === null ? null : nativeMethods.includes(value.failedCheck.method) ? value.failedCheck.method : "unknown",
    },
  }
}
const metadataConfirmed = value => value?.methodCount === 4 && value.methodCountStatus === "observed" &&
  !value.unknownMethodsObserved && !value.duplicateMethodsObserved && !value.methodsTruncated && value.failedCheck === null &&
  value.methods.every(row => row.status === "observed" && row.importCount === 1 && row.importCountStatus === "observed" &&
    metadataFlags.every(key => row[key] === true))

function stderrFacts(memory, totalBytes) {
  const text = memory.toString("utf8"), lines = PROGRAM.split("\n")
  const positions = [...new Set([...text.matchAll(/\bAt line:(\d{1,6}) char:(\d{1,6})\b/gu)]
    .map(match => `${match[1]}:${match[2]}`))]
  let line = null, character = null
  if (positions.length === 1) {
    const [l, c] = positions[0].split(":").map(Number)
    if (l > 0 && l <= lines.length && c > 0 && c <= lines[l - 1].length + 1) { line = l; character = c }
  }
  const ids = [...new Set([...text.matchAll(/\bFullyQualifiedErrorId\s*:\s*([A-Za-z][A-Za-z0-9_]{0,80})\b/gu)]
    .map(match => match[1]))]
  const allowed = new Set(["UnexpectedToken", "MissingEndCurlyBrace", "MissingExpressionAfterToken",
    "MissingEndParenthesisInExpression", "MissingArgument", "MissingPropertyName", "ExpectedValueExpression",
    "TerminatorExpectedAtEndOfString", "InvalidLeftHandSide", "ParserError"])
  const errorId = ids.length === 1 && allowed.has(ids[0]) ? ids[0] : "unknown"
  const category = /\bCategoryInfo\s*:\s*ParserError\b/u.test(text) ? "ParserError" : "unknown"
  let status = totalBytes === 0 ? "missing" : "unrecognized"
  if (positions.length > 1 || ids.length > 1) status = "ambiguous"
  else if (line !== null && category === "ParserError" && errorId !== "unknown") status = "recognized"
  else if (line !== null || category !== "unknown" || errorId !== "unknown") status = "partial"
  const truncated = totalBytes > memory.length
  if (truncated && status === "recognized") status = "partial"
  return { status, line, character, category, errorId, bytes: totalBytes, truncated }
}

export function identityArtifactPath() {
  return fileURLToPath(new URL("../../../../../windows-archive-race-observations.json", import.meta.url))
}

export function decodeFileIdInfo(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== 24) throw error("unsupported FileIdInfo layout")
  const volume = bytes.readBigUInt64LE(0), fileIdLow64 = bytes.readBigUInt64LE(8), fileIdHigh64 = bytes.readBigUInt64LE(16)
  const fileId128 = fileIdLow64 | (fileIdHigh64 << 64n)
  if (volume === 0n || fileId128 === 0n) throw error("unsupported FileIdInfo zero identity")
  return { volume, fileIdLow64, fileIdHigh64, fileId128 }
}

export async function observeIdentity({ source, nodeBaseline, admittedIdentity }, work, {
  platform = process.platform, env = process.env, spawn = spawnChild,
  setTimeout: startTimer = setTimeout, clearTimeout: stopTimer = clearTimeout,
} = {}) {
  const receipt = {
    scope: "observation_only", observationKind: "finite_ntfs_identity_bridge_only", identityAuthority: false,
    helperSha256, programSha256, executedProgramSha256: null, node: process.versions.node, platform,
    compilerStrategy: "reflection_emit_in_process", externalCompilerRequested: false,
    compilerRetirement: "not_applicable_to_in_process_emit",
    byteOrder: "little_endian", conversion: "unsigned_64_and_128_bit_BigInt_no_Number",
    layout: { fileIdInfoBytes: 24, volumeOffset: 0, fileIdOffset: 8, fileIdBytes: 16, attributeTagInfoBytes: 8 },
    apis: { open: "CreateFileW", volume: "GetVolumeInformationByHandleW",
      identity: "GetFileInformationByHandleEx_FileIdInfo", attributes: "GetFileInformationByHandleEx_FileAttributeTagInfo",
      close: "CloseHandle" },
    win32ErrorSemantics: "cached_immediately_after_call_failure_only_success_error_null",
    bounds: { readinessMs: 5000, ackMs: 5000, observationPhaseMs: 5000, retirementMs: 2000,
      closeMs: 2000, stdoutBytes: 16384, stderrBytes: 16384, events: 128, commands: 16 },
    nodeSourceContract: "Node24.18.0_uv_dev_VolumeSerial_LowPart_ino_FileId_QuadPart",
    outcome: "incomplete", uncertain: false, childPid: null, readyPidMatchesChild: false,
    events: [], droppedEvents: 0, protocolIssues: [], missingStages: [], baseline: null, observations: [],
    handles: { confirmedDisposed: false }, exit: null, close: null, forced: false,
    stdoutBytes: 0, stderrBytes: 0,
  }
  const salt = randomBytes(32)
  const scoped = (domain, value) => digest(Buffer.concat([salt, Buffer.from(domain + ":" + value)]))
  function issue(code) {
    if (!receipt.protocolIssues.includes(code) && receipt.protocolIssues.length < 16) receipt.protocolIssues.push(code)
  }
  function event(type) {
    if (receipt.events.length < 128) receipt.events.push({ type, sequence: receipt.events.length + 1,
      monotonicNs: process.hrtime.bigint().toString() })
    else { receipt.droppedEvents++; issue("events_oversized") }
  }
  function bounded(promise, ms, label) {
    let timer
    return Promise.race([promise, new Promise((_, reject) => {
      timer = startTimer(() => reject(error(label)), ms)
    })]).finally(() => stopTimer(timer))
  }
  let rawBaseline, baselineKey, expectedOpened = 0, currentCloseUnconfirmed = false
  function facts(raw, node, admission) {
    if (!raw || typeof raw.openSuccess !== "boolean" || !["NTFS", "other", "unavailable"].includes(raw.filesystem))
      throw error("invalid sample")
    for (const prefix of ["open", "volume", "id", "attribute"]) {
      if (typeof raw[`${prefix}Success`] !== "boolean" ||
          !(raw[`${prefix}Error`] === null || uint(raw[`${prefix}Error`])) ||
          raw[`${prefix}Success`] && raw[`${prefix}Error`] !== null ||
          !raw[`${prefix}Success`] && (prefix === "open" || raw.openSuccess) &&
          !uint(raw[`${prefix}Error`])) throw error("invalid API result")
    }
    if (typeof raw.closeAttempted !== "boolean" || ![true, false, null].includes(raw.closeSuccess) ||
        !(raw.closeError === null || uint(raw.closeError)) ||
        raw.closeSuccess === true && raw.closeError !== null ||
        raw.closeSuccess === false && !uint(raw.closeError) ||
        !raw.closeAttempted && (raw.closeSuccess !== null || raw.closeError !== null)) throw error("invalid disposal result")
    if (raw.openSuccess) expectedOpened++
    const answer = {
      openSuccess: raw.openSuccess, openError: raw.openError, volumeSuccess: raw.volumeSuccess,
      volumeError: raw.volumeError, filesystem: raw.filesystem, idSuccess: raw.idSuccess, idError: raw.idError,
      attributeSuccess: raw.attributeSuccess, attributeError: raw.attributeError,
      attributes: uint(raw.attributes) ? raw.attributes : null, reparseTag: uint(raw.reparseTag) ? raw.reparseTag : null,
      closeAttempted: raw.closeAttempted, closeSuccess: raw.closeSuccess, closeError: raw.closeError,
      status: raw.openSuccess ? "unsupported" : "open_refused",
      directory: raw.attributeSuccess && uint(raw.attributes) ? (raw.attributes & 16) !== 0 : null,
      reparse: raw.attributeSuccess && uint(raw.attributes) ? (raw.attributes & 1024) !== 0 : null,
      identityAvailable: false, sameAsBaseline: null, nativeIdentityDigest: null,
      nodeInodeEqualsNativeLow64: null, nativeUpper64Zero: null, nodeDevEqualsNativeVolumeLow32: null,
      nodeDevEqualsNativeVolumeHigh32: null, nodeDevEqualsNativeVolume64: null, nativeVolumeUpper32Zero: null,
      nodeTupleMatchesAdmission: null, nodeTupleDigest: null,
    }
    let decoded
    if (raw.idSuccess && /^[a-f0-9]{16}$/u.test(raw.volumeHex) && /^[a-f0-9]{32}$/u.test(raw.fileIdHex)) {
      try { decoded = decodeFileIdInfo(Buffer.from(raw.volumeHex + raw.fileIdHex, "hex")) } catch { /* Explicitly unavailable; no legacy fallback. */ }
    }
    if (!decoded || !raw.volumeSuccess || raw.filesystem !== "NTFS" ||
        !raw.attributeSuccess || !uint(raw.attributes) || !uint(raw.reparseTag)) return answer
    const key = raw.volumeHex + raw.fileIdHex
    answer.status = "observed"
    answer.identityAvailable = true
    answer.nativeIdentityDigest = scoped("native_full_24_bytes", key)
    answer.sameAsBaseline = baselineKey === undefined ? null : key === baselineKey
    answer.nativeUpper64Zero = decoded.fileIdHigh64 === 0n
    answer.nativeVolumeUpper32Zero = (decoded.volume >> 32n) === 0n
    if (node !== null && node !== undefined) {
      if (typeof node.dev !== "bigint" || typeof node.ino !== "bigint" || typeof node.mode !== "bigint")
        throw error("Node observation requires BigInt lstat")
      answer.nodeInodeEqualsNativeLow64 = node.ino === decoded.fileIdLow64
      answer.nodeDevEqualsNativeVolumeLow32 = node.dev === (decoded.volume & 0xffffffffn)
      answer.nodeDevEqualsNativeVolumeHigh32 = node.dev === (decoded.volume >> 32n)
      answer.nodeDevEqualsNativeVolume64 = node.dev === decoded.volume
      const tuple = `${node.dev}:${node.ino}:${node.mode & 0o170000n}`
      answer.nodeTupleDigest = scoped("node_admission_tuple", tuple)
      answer.nodeTupleMatchesAdmission = admission === undefined ? null : tuple === admission
    }
    return answer
  }
  let child, primary, problem, pending = "", rawReady, finalAck, sequence = 0, waiting
  let stderrMemory = Buffer.alloc(0)
  let readyResolve, readyReject, closeResolve, finishRequested = false
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const closed = new Promise(resolve => { closeResolve = resolve })
  function fail(code) {
    issue(code)
    problem ??= error(code)
    readyReject(problem)
    waiting?.reject(problem)
    waiting = undefined
  }
  function response(item) {
    if (item?.state === "ready") {
      const contract = item.openContract
      if (rawReady || !uint(child.pid) || child.pid === 0 || item.pid !== child.pid || !version(item.powershell) || !version(item.runtime) ||
          item.edition !== "Desktop" || item.compiler !== "reflection_emit_in_process" || item.metadataVerified !== true ||
          contract?.access !== 0 || contract?.share !== 7 || contract?.disposition !== 3 || contract?.flags !== 35651584)
        return fail(rawReady ? "duplicate_ready" : "invalid_ready")
      rawReady = item
      rawBaseline = item.baseline
      receipt.readyPidMatchesChild = true
      receipt.executedProgramSha256 = receipt.requestedProgramSha256
      receipt.runtime = { powershell: item.powershell, runtime: item.runtime, edition: "Desktop" }
      receipt.emittedMetadataVerified = true
      receipt.openContract = { access: contract.access, share: contract.share, disposition: contract.disposition, flags: contract.flags }
      event("native_ready")
      readyResolve()
    } else if (item?.state === "observation") {
      if (!waiting || item.sequence !== sequence) return fail("unexpected_observation")
      const current = waiting
      waiting = undefined
      current.resolve(item.sample)
      event("native_observation")
    } else if (item?.state === "finished") {
      if (finalAck || !finishRequested && rawReady) return fail("unexpected_finished")
      if (!["opened", "closeAttempts", "closed", "closeFailures"].every(key =>
        Number.isInteger(item[key]) && item[key] >= 0 && item[key] <= 17) ||
        ![null, "setup", "request", "baseline", "observe", "finish"].includes(item.programError) ||
        !Array.isArray(item.disposals) || item.disposals.length !== item.closeAttempts ||
        !item.disposals.every(disposal => ["baseline", "observe", "finish"].includes(disposal?.phase) &&
          typeof disposal.success === "boolean" && (disposal.success ? disposal.error === null : uint(disposal.error))))
        return fail("invalid_finished")
      finalAck = { opened: item.opened, closeAttempts: item.closeAttempts, closed: item.closed,
        closeFailures: item.closeFailures, programError: item.programError,
        firstFailure: safeFailure(item.firstFailure),
        finalOperation: item.finalOperation == null ? null : operations.has(item.finalOperation) ? item.finalOperation : "unknown",
        metadataFacts: safeMetadata(item.metadataFacts),
        disposals: item.disposals.map(disposal => ({ phase: disposal.phase, success: disposal.success, error: disposal.error })) }
      event("native_finished")
      if (!rawReady) fail("native_error_before_ready")
    } else fail("unexpected_state")
  }
  try {
    if (platform !== "win32") throw error("Windows-only native observer")
    const initial = JSON.stringify({ source }) + "\n"
    if (typeof source !== "string" || !source || Buffer.byteLength(initial) > 16384) throw error("invalid owned source")
    const systemRoot = env.SystemRoot || env.SYSTEMROOT
    if (!systemRoot) throw error("system runtime unavailable")
    const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROGRAM]
    receipt.requestedProgramSha256 = digest(args[4])
    receipt.executable = "system_WindowsPowerShell_v1.0_powershell.exe"
    try {
      child = spawn(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
    } catch { throw error("spawn unavailable") }
    receipt.childPid = child.pid ?? null
    child.on("spawn", () => event("native_spawn"))
    child.on("error", () => fail("spawn_error"))
    child.stdin.on("error", () => fail("stdin_error"))
    child.stdout.on("error", () => fail("stdout_error"))
    child.stderr.on("error", () => fail("stderr_error"))
    child.stdout.on("data", chunk => {
      receipt.stdoutBytes += chunk.length
      if (receipt.stdoutBytes > 16384) { fail("stdout_oversized"); return }
      pending += chunk.toString("utf8")
      for (;;) {
        const newline = pending.indexOf("\n")
        if (newline < 0) break
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        let item
        try { item = JSON.parse(line) } catch { fail("malformed_json"); continue }
        response(item)
      }
    })
    child.stderr.on("data", chunk => {
      receipt.stderrBytes += chunk.length
      stderrMemory = Buffer.concat([stderrMemory, Buffer.from(chunk).subarray(0, 16384 - stderrMemory.length)])
      fail(receipt.stderrBytes > 16384 ? "stderr_oversized" : "stderr_nonempty")
    })
    child.on("exit", (code, signal) => { receipt.exit = { code, signal }; event("native_exit") })
    child.once("close", (code, signal) => {
      receipt.close = { code, signal }
      event("native_close")
      if (pending.trim()) fail("unterminated_output")
      if (!rawReady) fail("missing_ready")
      if (waiting) fail("missing_observation")
      closeResolve()
    })
    try { child.stdin.write(initial) } catch { fail("stdin_error") }
    await bounded(ready, 5000, "readiness timeout")
    receipt.baseline = { ...facts(rawBaseline, nodeBaseline, admittedIdentity), replacementPhaseBegun: false }
    if (rawBaseline?.filesystem !== "NTFS" || !receipt.baseline.identityAvailable || receipt.baseline.directory !== true) {
      receipt.outcome = "unsupported"
      throw error("baseline is not identified supported NTFS")
    }
    baselineKey = rawBaseline.volumeHex + rawBaseline.fileIdHex
    if (problem || receipt.close) throw problem || error("closed before observation")
    await bounded(work({
      async observe(file, phase, node, admission) {
        if (!phases.has(phase) || typeof file !== "string" || !file || waiting || sequence >= 16 ||
            finishRequested || receipt.close || problem) throw error("invalid observation request")
        sequence++
        const request = JSON.stringify({ command: "observe", sequence, path: file }) + "\n"
        if (Buffer.byteLength(request) > 16384) throw error("observation input exceeds bound")
        const answer = new Promise((resolve, reject) => { waiting = { resolve, reject } })
        try { child.stdin.write(request) } catch { fail("stdin_error") }
        const raw = await bounded(answer, 5000, "observation ACK timeout")
        const sample = { phase, ...facts(raw, node, admission) }
        if (sample.openSuccess && (sample.closeAttempted !== true || sample.closeSuccess !== true))
          currentCloseUnconfirmed = true
        receipt.observations.push(sample)
        if (sample.openSuccess && (!sample.identityAvailable || sample.directory !== true)) {
          sample.status = "unsupported"
          receipt.outcome = "unsupported"
          throw error("current full directory identity unsupported")
        }
        return sample
      },
    }), 5000, "Node observation phase timeout")
    if (problem) throw problem
  } catch (failure) { primary = failure }
  finally {
    let closureFailure
    if (child) {
      try {
        if (!receipt.close) {
          finishRequested = true
          try { child.stdin.end('{"command":"finish"}\n') } catch { throw error("native input closure failed") }
          if (!primary) await bounded(closed, 5000, "native close unconfirmed")
        }
      } catch (failure) { closureFailure = failure }
      if (!receipt.close) {
        try { child.stdin.end() } catch { /* Preserve the first error. */ }
        try { await bounded(closed, 2000, "native close unconfirmed") } catch {
          receipt.forced = true
          try { child.kill() } catch { /* Only the directly owned handle is signalled. */ }
          try { await bounded(closed, 2000, "native retirement unconfirmed") } catch { /* Disposition below remains unconfirmed. */ }
        }
      }
      if (finalAck) receipt.handles = { ...finalAck, confirmedDisposed: finalAck.opened === expectedOpened &&
        finalAck.closeAttempts === finalAck.opened && finalAck.closed === finalAck.opened && finalAck.closeFailures === 0 &&
        finalAck.disposals.every(disposal => disposal.success) &&
        !currentCloseUnconfirmed }
      if (!finalAck) issue("missing_finished")
      if (rawReady && !metadataConfirmed(finalAck?.metadataFacts)) {
        issue("metadata_confirmation_failed")
        problem ??= error("emitted metadata confirmation incomplete")
      }
      receipt.stderrObservation = stderrFacts(stderrMemory, receipt.stderrBytes)
      receipt.missingStages = stages.filter(type => !receipt.events.some(item => item.type === type))
      if (receipt.missingStages.length) {
        issue("missing_native_stage")
        problem ??= error("native lifecycle incomplete")
      }
      receipt.retirement = !receipt.close || !receipt.exit ? "unconfirmed" : receipt.forced ? "forced" : "confirmed"
      receipt.uncertain = !receipt.handles.confirmedDisposed || receipt.retirement !== "confirmed"
      if (receipt.uncertain || receipt.close?.code !== 0 || receipt.close?.signal !== null ||
          receipt.exit?.code !== 0 || receipt.exit?.signal !== null ||
          finalAck?.programError || problem) closureFailure ??= error("native observation retirement or protocol incomplete")
      if (closureFailure) {
        receipt.closureFailure = { retirement: receipt.retirement, handlesConfirmed: receipt.handles.confirmedDisposed,
          normalExit: receipt.close?.code === 0 && receipt.close?.signal === null,
          protocolIssues: receipt.protocolIssues.length > 0 }
        if (primary) primary.native_close_failure = receipt.retirement === "unconfirmed" ? "native retirement unconfirmed"
          : `native disposal or protocol unconfirmed; retirement ${receipt.retirement}`
        else primary = closureFailure
      }
    }
    receipt.missingStages = stages.filter(type => !receipt.events.some(item => item.type === type))
    receipt.dispositionEventSequence = receipt.events.length
    if (primary) {
      if (receipt.uncertain) receipt.outcome = "uncertain"
      else if (receipt.outcome !== "unsupported") receipt.outcome = "failed"
      primary.identityReceipt = receipt
    } else receipt.outcome = "observed"
  }
  if (primary) throw primary
  return receipt
}
