// Test-only live additional native admission. No Node-ID projection or production seam.
import { spawn as spawnChild } from "node:child_process"
import { promises as fs, readFileSync } from "node:fs"
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"

const PROGRAM = `
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$phase = 'setup'
$native = $null
$baseline = $null
$admitted = $null
$held = $null
$current = $null
$samples = @{ baseline = $null; admitted = $null; held = $null; current = $null }
$script:opened = 0
$script:closed = 0
$script:closeAttempts = 0
$script:closeFailures = 0
$script:disposals = New-Object 'System.Collections.Generic.List[System.Object]'
$script:failure = $null
$script:disposition = 'closed'
$moved = $false
$rename = @{ attempted = $false; success = $null; error = $null
  byHandle = $false; replaceIfExists = $false; rootDirectoryNull = $true; bufferValidated = $false }
function Emit($item) {
  [Console]::WriteLine(($item | ConvertTo-Json -Depth 10 -Compress))
  [Console]::Out.Flush()
}
function Error-Code($ok, [int]$last) {
  if (!$ok) { return [BitConverter]::ToUInt32([BitConverter]::GetBytes($last), 0) }
  return $null
}
function Refuse([string]$at, [string]$kind, $code) {
  if ($null -eq $script:failure) { $script:failure = @{ phase = $at; kind = $kind; code = $code } }
  $script:disposition = 'refused'
  throw 'owned_refusal'
}
function Close-Entry($entry) {
  if ($null -eq $entry -or $entry.handle -eq [IntPtr]::Zero) { return }
  $script:closeAttempts++
  try {
    $ok = $native::CloseHandle($entry.handle)
    $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $entry.sample.closeSuccess = [bool]$ok
    $entry.sample.closeError = Error-Code $ok $last
    if ($ok) { $script:closed++ } else { $script:closeFailures++ }
  } catch {
    $script:closeFailures++
    $entry.sample.closeSuccess = $null
    $entry.sample.closeError = $null
    if ($null -eq $script:failure) {
      $script:failure = @{ phase = $phase; kind = 'exception'; code = $null }
    }
  } finally {
    [void]$script:disposals.Add(@{ role = $entry.sample.role; success = $entry.sample.closeSuccess; error = $entry.sample.closeError })
    $entry.handle = [IntPtr]::Zero
  }
}
function Read-Entry([string]$file, [string]$role) {
  $access = [uint32]0
  $share = [uint32]7
  if ($role -ceq 'held') { $access = [uint32]65536; $share = [uint32]3 }
  $sample = @{ role = $role; access = $access; share = $share; flags = 35651584; creation = 3
    openSuccess = $false; openError = $null
    volumeSuccess = $false; volumeError = $null; filesystem = 'unavailable'
    idSuccess = $false; idError = $null; volumeHex = $null; fileIdHex = $null
    attributeSuccess = $false; attributeError = $null; attributes = $null; reparseTag = $null
    closeSuccess = $null; closeError = $null }
  $handle = $native::CreateFileW($file, $access, $share, [IntPtr]::Zero, [uint32]3, [uint32]35651584, [IntPtr]::Zero)
  $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $sample.openSuccess = $handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr](-1)
  $sample.openError = Error-Code $sample.openSuccess $last
  $entry = @{ handle = [IntPtr]::Zero; sample = $sample }
  if (!$sample.openSuccess) { return $entry }
  $entry.handle = $handle
  $script:opened++
  try {
    $name = New-Object Text.StringBuilder(32)
    $ok = $native::GetVolumeInformationByHandleW($handle, [IntPtr]::Zero, [uint32]0,
      [IntPtr]::Zero, [IntPtr]::Zero, [IntPtr]::Zero, $name, [uint32]32)
    $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
    $sample.volumeSuccess = [bool]$ok
    $sample.volumeError = Error-Code $ok $last
    if ($ok) {
      if ($name.ToString() -ceq 'NTFS') { $sample.filesystem = 'NTFS' } else { $sample.filesystem = 'other' }
    }
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(24)
    try {
      $ok = $native::GetFileInformationByHandleEx($handle, [int]18, $buffer, [uint32]24)
      $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $sample.idSuccess = [bool]$ok
      $sample.idError = Error-Code $ok $last
      if ($ok) {
        $bytes = New-Object byte[] 24
        [Runtime.InteropServices.Marshal]::Copy($buffer, $bytes, 0, 24)
        $sample.volumeHex = [BitConverter]::ToString($bytes, 0, 8).Replace('-', '').ToLowerInvariant()
        $sample.fileIdHex = [BitConverter]::ToString($bytes, 8, 16).Replace('-', '').ToLowerInvariant()
      }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
    $buffer = [Runtime.InteropServices.Marshal]::AllocHGlobal(8)
    try {
      $ok = $native::GetFileInformationByHandleEx($handle, [int]9, $buffer, [uint32]8)
      $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      $sample.attributeSuccess = [bool]$ok
      $sample.attributeError = Error-Code $ok $last
      if ($ok) {
        $bytes = New-Object byte[] 8
        [Runtime.InteropServices.Marshal]::Copy($buffer, $bytes, 0, 8)
        $sample.attributes = [BitConverter]::ToUInt32($bytes, 0)
        $sample.reparseTag = [BitConverter]::ToUInt32($bytes, 4)
      }
    } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer) }
  } catch { Close-Entry $entry; throw }
  return $entry
}
function Valid-Entry($sample) {
  return $null -ne $sample -and $sample.openSuccess -and $sample.volumeSuccess -and
    $sample.filesystem -ceq 'NTFS' -and $sample.idSuccess -and $sample.attributeSuccess -and
    $sample.volumeHex -cmatch '^[a-f0-9]{16}$' -and $sample.volumeHex -notmatch '^0+$' -and
    $sample.fileIdHex -cmatch '^[a-f0-9]{32}$' -and $sample.fileIdHex -notmatch '^0+$' -and
    ($sample.attributes -band 16) -ne 0 -and ($sample.attributes -band 1024) -eq 0 -and $sample.reparseTag -eq 0
}
function Same-Entry($a, $b) {
  return (Valid-Entry $a) -and (Valid-Entry $b) -and
    $a.volumeHex -ceq $b.volumeHex -and $a.fileIdHex -ceq $b.fileIdHex
}
function Define-Native([string]$name, [type]$returns, [type[]]$parameters) {
  $method = $type.DefineMethod($name, [Reflection.MethodAttributes]'Public, Static', $returns, $parameters)
  $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
  $attribute = [Reflection.Emit.CustomAttributeBuilder]::new($ctor,
    [object[]]@('kernel32.dll'), $fields, [object[]]@($name, $true, $true, $true,
      [Runtime.InteropServices.CharSet]::Unicode, [Runtime.InteropServices.CallingConvention]::Winapi))
  $method.SetCustomAttribute($attribute)
}
function Build-Layout {
  $builder = $module.DefineType('DeskArchiveRenameHeader', [Reflection.TypeAttributes]'Public, Sealed, ExplicitLayout',
    [ValueType], [Reflection.Emit.PackingSize]::Size8, 24)
  $field = $builder.DefineField('ReplaceFlags', [uint32], [Reflection.FieldAttributes]::Public)
  $field.SetOffset(0)
  $field = $builder.DefineField('RootDirectory', [IntPtr], [Reflection.FieldAttributes]::Public)
  $field.SetOffset(8)
  $field = $builder.DefineField('FileNameLength', [uint32], [Reflection.FieldAttributes]::Public)
  $field.SetOffset(16)
  $field = $builder.DefineField('FileName', [uint16], [Reflection.FieldAttributes]::Public)
  $field.SetOffset(20)
  $header = $builder.CreateType()
  $sizeOfType = [Runtime.InteropServices.Marshal].GetMethod('SizeOf', [type[]]@([type]))
  $headerBytes = $sizeOfType.Invoke($null, [object[]]@($header))
  return @{ pointerSize = [IntPtr]::Size; headerSize = $headerBytes
    replaceOffset = [Runtime.InteropServices.Marshal]::OffsetOf($header, 'ReplaceFlags').ToInt64()
    rootOffset = [Runtime.InteropServices.Marshal]::OffsetOf($header, 'RootDirectory').ToInt64()
    lengthOffset = [Runtime.InteropServices.Marshal]::OffsetOf($header, 'FileNameLength').ToInt64()
    nameOffset = [Runtime.InteropServices.Marshal]::OffsetOf($header, 'FileName').ToInt64()
    littleEndian = [BitConverter]::IsLittleEndian }
}
function Build-RenameBuffer([string]$destination) {
  $nameBytes = [Text.Encoding]::Unicode.GetBytes($destination)
  $size = 20 + $nameBytes.Length + 2
  $pointer = [Runtime.InteropServices.Marshal]::AllocHGlobal($size)
  try {
    $zeros = New-Object byte[] $size
    [Runtime.InteropServices.Marshal]::Copy($zeros, 0, $pointer, $size)
    [Runtime.InteropServices.Marshal]::WriteInt32($pointer, 16, $nameBytes.Length)
    [Runtime.InteropServices.Marshal]::Copy($nameBytes, 0, [IntPtr]::Add($pointer, 20), $nameBytes.Length)
    if ([Runtime.InteropServices.Marshal]::ReadInt32($pointer, 0) -ne 0 -or
        [Runtime.InteropServices.Marshal]::ReadIntPtr($pointer, 8) -ne [IntPtr]::Zero -or
        [Runtime.InteropServices.Marshal]::ReadInt32($pointer, 16) -ne $nameBytes.Length) { throw 'invalid_rename_buffer' }
  } catch { [Runtime.InteropServices.Marshal]::FreeHGlobal($pointer); throw }
  return @{ pointer = $pointer; bytes = $size; nameBytes = $nameBytes.Length }
}
try {
  if ([IntPtr]::Size -ne 8 -or $env:PROCESSOR_ARCHITECTURE -cne 'AMD64') { throw 'unsupported_process' }
  $assemblyName = New-Object Reflection.AssemblyName('DeskArchiveHandleExperiment')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('InMemory')
  $type = $module.DefineType('DeskArchiveNative', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@(
    [Runtime.InteropServices.DllImportAttribute].GetField('EntryPoint'),
    [Runtime.InteropServices.DllImportAttribute].GetField('PreserveSig'),
    [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
    [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'),
    [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
    [Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'))
  Define-Native 'CreateFileW' ([IntPtr]) ([type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]))
  Define-Native 'GetFileInformationByHandleEx' ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32]))
  Define-Native 'GetVolumeInformationByHandleW' ([bool]) ([type[]]@([IntPtr], [IntPtr], [uint32], [IntPtr], [IntPtr], [IntPtr], [Text.StringBuilder], [uint32]))
  Define-Native 'SetFileInformationByHandle' ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32]))
  Define-Native 'CloseHandle' ([bool]) ([type[]]@([IntPtr]))
  $native = $type.CreateType()
  $metadata = @()
  $methods = $native.GetMethods([Reflection.BindingFlags]'Public, Static, DeclaredOnly')
  if ($methods.Count -ne 5) { throw 'invalid_method_count' }
  foreach ($method in $methods) {
    $imports = @($method.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute], $false))
    if ($imports.Count -ne 1) { throw 'invalid_import_count' }
    $lastError = $imports[0].SetLastError
    $preserve = $imports[0].PreserveSig
    $exact = $imports[0].ExactSpelling
    $unicode = $imports[0].CharSet -eq [Runtime.InteropServices.CharSet]::Unicode
    $winapi = $imports[0].CallingConvention -eq [Runtime.InteropServices.CallingConvention]::Winapi
    $implementation = ($method.GetMethodImplementationFlags() -band [Reflection.MethodImplAttributes]::PreserveSig) -ne 0
    $entryMatches = $imports[0].EntryPoint -ceq $method.Name
    if ($lastError -ne $true -or $preserve -ne $true -or $exact -ne $true -or !$unicode -or !$winapi -or
        !$implementation -or !$entryMatches -or $imports[0].Value -cne 'kernel32.dll') { throw 'invalid_emitted_metadata' }
    $metadata += @{ method = $method.Name; verified = $true }
  }
  $layout = Build-Layout
  if ($layout.pointerSize -ne 8 -or $layout.headerSize -ne 24 -or $layout.replaceOffset -ne 0 -or
      $layout.rootOffset -ne 8 -or $layout.lengthOffset -ne 16 -or $layout.nameOffset -ne 20 -or !$layout.littleEndian) {
    throw 'unsupported_rename_layout'
  }
  $phase = 'capture'
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 16384) { throw 'invalid_request' }
  $request = $line | ConvertFrom-Json
  if ($request.source -isnot [string] -or !$request.source -or $request.destination -isnot [string] -or
      !$request.destination) { throw 'invalid_pair' }
  $baseline = Read-Entry $request.source 'baseline'
  $samples.baseline = $baseline.sample
  if (!$baseline.sample.openSuccess) { Refuse 'capture' 'api' $baseline.sample.openError }
  if (!(Valid-Entry $baseline.sample)) { Refuse 'capture' 'validation' $null }
  Emit @{ state = 'captured'; pid = $PID; powershell = $PSVersionTable.PSVersion.ToString()
    runtime = [Environment]::Version.ToString(); edition = [string]$PSVersionTable.PSEdition
    architecture = 'AMD64'; compiler = 'reflection_emit_in_process'; metadata = $metadata; layout = $layout
    baseline = $baseline.sample }
  $command = [Console]::ReadLine()
  if ($null -ne $command -and $command -cne 'close') {
    if ($command -cne 'admit') { throw 'invalid_command' }
    $phase = 'admit'
    $admitted = Read-Entry $request.source 'admitted'
    $samples.admitted = $admitted.sample
    $matches = Same-Entry $baseline.sample $admitted.sample
    Close-Entry $admitted
    if (!$matches) { Refuse 'admit' 'validation' $null }
    if (!$admitted.sample.closeSuccess) { Refuse 'admit' 'disposal' $admitted.sample.closeError }
    Emit @{ state = 'ready'; pid = $PID; admitted = $admitted.sample; matchesBaseline = $matches }
    $command = [Console]::ReadLine()
    if ($null -ne $command -and $command -cne 'close') {
      if ($command -cne 'move') { throw 'invalid_command' }
      $phase = 'delete_open'
      $held = Read-Entry $request.source 'held'
      $samples.held = $held.sample
      if (!$held.sample.openSuccess) { Refuse 'delete_open' 'api' $held.sample.openError }
      $phase = 'held_validate'
      if (!(Same-Entry $baseline.sample $held.sample)) { Refuse 'held_validate' 'validation' $null }
      $phase = 'current_open'
      $current = Read-Entry $request.source 'current'
      $samples.current = $current.sample
      if (!$current.sample.openSuccess) { Refuse 'current_open' 'api' $current.sample.openError }
      $phase = 'current_validate'
      $matches = (Same-Entry $baseline.sample $current.sample) -and (Same-Entry $held.sample $current.sample)
      Close-Entry $current
      if (!$matches) { Refuse 'current_validate' 'validation' $null }
      if (!$current.sample.closeSuccess) { Refuse 'current_validate' 'disposal' $current.sample.closeError }
      $phase = 'rename'
      $buffer = Build-RenameBuffer $request.destination
      try {
        $rename.bufferValidated = $true
        $rename.byHandle = $true
        $rename.attempted = $true
        $ok = $native::SetFileInformationByHandle($held.handle, [int]3, $buffer.pointer, [uint32]$buffer.bytes)
        $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        $rename.success = [bool]$ok
        $rename.error = Error-Code $ok $last
        if (!$ok) { Refuse 'rename' 'api' $rename.error }
        $moved = $true
        $script:disposition = 'moved'
      } finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer.pointer) }
    }
  }
} catch {
  if ($null -eq $script:failure) {
    $script:failure = @{ phase = $phase; kind = 'exception'; code = $null }
    $script:disposition = 'uncertain'
  }
}
finally {
  Close-Entry $current
  Close-Entry $held
  Close-Entry $admitted
  Close-Entry $baseline
  if ($script:closeFailures -gt 0) { $script:disposition = 'uncertain' }
  Emit @{ state = 'result'; disposition = $script:disposition; phase = $phase; moved = $moved
    failure = $script:failure; samples = $samples; rename = $rename
    comparisons = @{ admittedMatchesBaseline = (Same-Entry $samples.baseline $samples.admitted)
      heldMatchesBaseline = (Same-Entry $samples.baseline $samples.held)
      currentMatchesBaseline = (Same-Entry $samples.baseline $samples.current)
      currentMatchesHeld = (Same-Entry $samples.held $samples.current) }
    handles = @{ opened = $script:opened; closeAttempts = $script:closeAttempts; closed = $script:closed
      closeFailures = $script:closeFailures; disposals = @($script:disposals.ToArray()) } }
}
if ($script:disposition -ceq 'moved' -or $script:disposition -ceq 'closed') { exit 0 }
if ($script:disposition -ceq 'refused') { exit 3 }
exit 4
`

const hash = bytes => createHash("sha256").update(bytes).digest("hex")
const helperSha256 = hash(readFileSync(new URL(import.meta.url)))
const programSha256 = hash(PROGRAM)
const roles = ["baseline", "admitted", "held", "current"]
const methods = ["CreateFileW", "GetFileInformationByHandleEx", "GetVolumeInformationByHandleW", "SetFileInformationByHandle", "CloseHandle"]
const phases = ["setup", "capture", "admit", "delete_open", "held_validate", "current_open", "current_validate", "rename", "close"]
const uint = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff
const version = value => typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
const problem = message => Object.assign(new Error(`Archive handle experiment: ${message}`), { code: "ARCHIVE_HANDLE_EXPERIMENT" })
function supported(file) {
  if (typeof file !== "string" || !/^[A-Za-z]:\\/u.test(file) || file.length >= 248 ||
      /[/:<>"|?*\u0000-\u001f]/u.test(file.slice(2)) ||
      file.slice(3).split("\\").some(component => component === "." || component === ".." || /[. ]$/u.test(component) ||
        /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|CLOCK\$|COM[1-9¹²³]|LPT[1-9¹²³])(?:[ .]|$)/iu.test(component)))
    throw problem("unsupported Windows path")
}

export async function openArchiveHandleSession({ source, destination }, {
  platform = process.platform, arch = process.arch, env = process.env, realpath = fs.realpath, spawn = spawnChild,
  setTimeout: startTimer = setTimeout, clearTimeout: stopTimer = clearTimeout,
} = {}) {
  const state = { released: false, closed: false, forced: false, movement: "not_released", retirement: "unconfirmed" }
  const receipt = { scope: "test_only_native_preadmission_session", additionalNativeAdmission: true, nodeIdentityBridge: false,
    capturedValidated: false, admissionValidated: false, cleanupConfirmed: false, cleanupFailure: false, operationFailure: false,
    helperSha256, programSha256, executedProgramSha256: null, childPid: null, runtime: null, layout: null, metadata: [],
    bounds: { readinessMs: 5000, ackAndCloseMs: 5000, closeGraceMs: 2000, retirementMs: 2000,
      stdoutBytes: 16384, stderrBytes: 16384, events: 128 },
    samples: { baseline: null, admitted: null, held: null, current: null }, comparisons: {}, nativeComparisons: {},
    rename: null, handles: { confirmedDisposed: false }, archiveMove: state,
    events: [], protocolIssues: [], droppedEvents: 0, stdoutBytes: 0, stderrBytes: 0, exit: null, close: null }
  const salt = randomBytes(32)
  let mode = "opening", child, pending = "", captured, ready, result, issueError, operationError, retirePromise
  const raw = { baseline: null, admitted: null, held: null, current: null }
  let waiting, closeResolve
  const closed = new Promise(resolve => { closeResolve = resolve })
  const snapshot = () => structuredClone(receipt)
  function event(type) {
    if (receipt.events.length < 128) receipt.events.push({ type, sequence: receipt.events.length + 1,
      monotonicNs: process.hrtime.bigint().toString() })
    else { receipt.droppedEvents++; issue("events_oversized") }
  }
  function attach(error) {
    if (error !== null && (typeof error === "object" || typeof error === "function") && Object.isExtensible(error)) {
      try { error.handleReceipt = snapshot(); error.archiveMove = structuredClone(state) }
      catch { receipt.primaryErrorAttachment = "unavailable_property" }
    } else receipt.primaryErrorAttachment = "non_extensible_or_non_object"
    return error
  }
  function bounded(promise, ms, label) {
    let timer
    return Promise.race([promise, new Promise((_, reject) => {
      timer = startTimer(() => reject(problem(label)), ms)
    })]).finally(() => stopTimer(timer))
  }
  function issue(code) {
    if (!receipt.protocolIssues.includes(code) && receipt.protocolIssues.length < 16) receipt.protocolIssues.push(code)
    issueError ??= problem(code)
    waiting?.reject(issueError)
    waiting = undefined
  }
  function facts(value, role) {
    if (!value || value.role !== role || value.access !== (role === "held" ? 65536 : 0) ||
        value.share !== (role === "held" ? 3 : 7) || value.flags !== 35651584 || value.creation !== 3)
      throw problem("invalid native open contract")
    for (const prefix of ["open", "volume", "id", "attribute"]) {
      const success = value[`${prefix}Success`], code = value[`${prefix}Error`]
      if (typeof success !== "boolean" || !(code === null || uint(code)) || success && code !== null ||
          !success && (prefix === "open" || value.openSuccess) && !uint(code))
        throw problem("invalid native API result")
    }
    if (!["NTFS", "other", "unavailable"].includes(value.filesystem) ||
        ![null, true, false].includes(value.closeSuccess) || !(value.closeError === null || uint(value.closeError)) ||
        value.closeSuccess === true && value.closeError !== null ||
        value.closeSuccess === false && !uint(value.closeError)) throw problem("invalid native metadata")
    if (!value.openSuccess && (value.volumeSuccess || value.idSuccess || value.attributeSuccess ||
        value.volumeHex !== null || value.fileIdHex !== null || value.attributes !== null || value.reparseTag !== null ||
        value.filesystem !== "unavailable" || value.closeSuccess !== null))
      throw problem("metadata without an opened handle")
    const complete = typeof value.volumeHex === "string" && /^[a-f0-9]{16}$/u.test(value.volumeHex) && !/^0+$/u.test(value.volumeHex) &&
      typeof value.fileIdHex === "string" && /^[a-f0-9]{32}$/u.test(value.fileIdHex) && !/^0+$/u.test(value.fileIdHex)
    const valid = value.openSuccess && value.volumeSuccess && value.filesystem === "NTFS" && value.idSuccess &&
      value.attributeSuccess && uint(value.attributes) && uint(value.reparseTag) && (value.attributes & 16) !== 0 &&
      (value.attributes & 1024) === 0 && value.reparseTag === 0 && complete
    const key = complete ? value.volumeHex + value.fileIdHex : null
    return { key, valid, safe: { role, access: value.access, share: value.share, flags: value.flags, creation: value.creation,
      openSuccess: value.openSuccess, openError: value.openError, volumeSuccess: value.volumeSuccess, volumeError: value.volumeError,
      filesystem: value.filesystem, idSuccess: value.idSuccess, idError: value.idError,
      attributeSuccess: value.attributeSuccess, attributeError: value.attributeError,
      attributes: uint(value.attributes) ? value.attributes : null, reparseTag: uint(value.reparseTag) ? value.reparseTag : null,
      closeSuccess: value.closeSuccess, closeError: value.closeError, valid,
      identityDigest: key === null ? null : hash(Buffer.concat([salt, Buffer.from(key)])) } }
  }
  const same = (a, b) => !!(a?.valid && b?.valid && a.key === b.key)
  function response(item) {
    try {
      if (item?.state === "captured" && mode === "opening" && !captured) {
        if (!uint(child.pid) || child.pid === 0 || item.pid !== child.pid || !version(item.powershell) || !version(item.runtime) ||
            item.edition !== "Desktop" || item.architecture !== "AMD64" || item.compiler !== "reflection_emit_in_process" ||
            !Array.isArray(item.metadata) || item.metadata.length !== 5 ||
            !methods.every(method => item.metadata.filter(row => row?.method === method && row.verified === true).length === 1))
          throw problem("invalid captured runtime or metadata")
        const expected = { pointerSize: 8, headerSize: 24, replaceOffset: 0, rootOffset: 8, lengthOffset: 16, nameOffset: 20, littleEndian: true }
        if (!item.layout || !Object.entries(expected).every(([key, value]) => item.layout[key] === value))
          throw problem("invalid managed rename layout")
        raw.baseline = facts(item.baseline, "baseline")
        receipt.samples.baseline = raw.baseline.safe
        if (!raw.baseline.valid || item.baseline.closeSuccess !== null) throw problem("unsupported captured source")
        captured = true
        receipt.capturedValidated = true
        receipt.executedProgramSha256 = programSha256
        receipt.runtime = { powershell: item.powershell, runtime: item.runtime, edition: "Desktop", architecture: "AMD64",
          compiler: "reflection_emit_in_process" }
        receipt.layout = expected
        receipt.metadata = methods.map(method => ({ method, verified: true }))
        event("native_captured")
      } else if (item?.state === "ready" && mode === "admitting" && captured && !ready) {
        raw.admitted = facts(item.admitted, "admitted")
        receipt.samples.admitted = raw.admitted.safe
        if (item.pid !== child.pid || item.matchesBaseline !== true || !same(raw.baseline, raw.admitted) ||
            item.admitted.closeSuccess !== true) throw problem("additional native admission mismatch")
        ready = true
        receipt.admissionValidated = true
        event("native_ready")
      } else if (item?.state === "result" && !result) {
        if (!["moved", "closed", "refused", "uncertain"].includes(item.disposition) || !phases.includes(item.phase) ||
            typeof item.moved !== "boolean") throw problem("invalid result")
        result = item
        event("native_result")
      } else throw problem("unexpected protocol state")
      if (waiting) {
        const waiter = waiting
        waiting = undefined
        if (result && waiter.stage !== "result") waiter.reject(problem("native refused before requested stage"))
        else waiter.resolve()
      }
    } catch { issue("invalid_or_unexpected_protocol") }
  }
  function expect(stage) {
    if (waiting) throw problem("concurrent native request")
    return new Promise((resolve, reject) => { waiting = { stage, resolve, reject } })
  }
  function send(text, end = false) {
    try { if (end) child.stdin.end(text); else child.stdin.write(text) }
    catch { issue("stdin_error") }
  }
  async function validateDestinationParent(allowMissing) {
    let physical
    try { physical = await realpath(path.win32.dirname(destination)) } catch (error) {
      if (allowMissing && error.code === "ENOENT") {
        receipt.destinationParentValidation = "deferred_until_admit"
        return
      }
      throw problem("destination parent resolution unavailable")
    }
    supported(physical)
    supported(path.win32.join(physical, path.win32.basename(destination)))
    receipt.destinationParentValidation = "validated"
  }
  async function retire() {
    if (retirePromise) return retirePromise
    retirePromise = (async () => {
      let failure
      mode = "closing"
      if (!state.released && !receipt.close) { event("close_requested"); send("close\n", true) }
      if (!receipt.close) {
        try { await bounded(closed, state.released ? 5000 : 2000, "native close unconfirmed") }
        catch (error) { failure = error }
      }
      if (!receipt.close && state.released) {
        try { await bounded(closed, 2000, "native close unconfirmed") } catch { /* Direct-handle retirement below. */ }
      }
      if (!receipt.close) {
        state.forced = true
        try { child.kill() } catch { /* No name-based signal or retry. */ }
        try { await bounded(closed, 2000, "native retirement unconfirmed") } catch { /* Remains uncertain. */ }
      }
      state.closed = receipt.close !== null
      state.retirement = !receipt.close || !receipt.exit ? "unconfirmed" : state.forced ? "forced" : "confirmed"
      try {
        if (!result) throw problem("missing result ACK")
        let opened = 0, completeDisposal = true
        for (const role of roles) {
          if (!result.samples || !Object.hasOwn(result.samples, role)) throw problem("missing native sample")
          const value = result.samples[role]
          if (value === null) {
            if (raw[role] !== null) throw problem("missing live final sample")
            continue
          }
          const observed = facts(value, role)
          if (role === "baseline" && raw.baseline && observed.key !== raw.baseline.key) throw problem("baseline identity changed")
          raw[role] = observed
          receipt.samples[role] = observed.safe
          if (value.openSuccess) { opened++; if (value.closeSuccess !== true) completeDisposal = false }
        }
        const handles = result.handles
        if (!handles || !["opened", "closeAttempts", "closed", "closeFailures"].every(key =>
          Number.isInteger(handles[key]) && handles[key] >= 0 && handles[key] <= 4) ||
          !Array.isArray(handles.disposals) || handles.disposals.length !== handles.closeAttempts ||
          !handles.disposals.every(row => roles.includes(row?.role) && [true, false, null].includes(row.success) &&
            (row.success === false ? uint(row.error) : row.error === null))) throw problem("invalid handle accounting")
        const roleAccounting = roles.every(role => {
          const rows = handles.disposals.filter(row => row.role === role)
          return raw[role]?.safe.openSuccess ? rows.length === 1 &&
            rows[0].success === raw[role].safe.closeSuccess && rows[0].error === raw[role].safe.closeError : rows.length === 0
        })
        receipt.handles = { opened: handles.opened, closeAttempts: handles.closeAttempts, closed: handles.closed,
          closeFailures: handles.closeFailures,
          disposals: handles.disposals.map(row => ({ role: row.role, success: row.success, error: row.error })),
          confirmedDisposed: completeDisposal && handles.opened === opened && handles.closeAttempts === opened &&
            handles.closed === opened && handles.closeFailures === 0 && handles.disposals.every(row => row.success === true) && roleAccounting }
        const normal = state.retirement === "confirmed" && receipt.exit.signal === null && receipt.close.signal === null &&
          receipt.exit.code === receipt.close.code && receipt.events.some(item => item.type === "native_spawn")
        receipt.cleanupConfirmed = receipt.handles.confirmedDisposed && normal
        receipt.comparisons = { admittedMatchesBaseline: same(raw.baseline, raw.admitted),
          heldMatchesBaseline: same(raw.baseline, raw.held), currentMatchesBaseline: same(raw.baseline, raw.current),
          currentMatchesHeld: same(raw.held, raw.current) }
        for (const [key, value] of Object.entries(receipt.comparisons)) {
          if (typeof result.comparisons?.[key] !== "boolean" || result.comparisons[key] !== value)
            throw problem("native full-identity comparison inconsistent")
          receipt.nativeComparisons[key] = result.comparisons[key]
        }
        const rename = result.rename
        if (!rename || typeof rename.attempted !== "boolean" || ![true, false, null].includes(rename.success) ||
            !(rename.error === null || uint(rename.error)) || rename.success === true && rename.error !== null ||
            typeof rename.byHandle !== "boolean" || rename.replaceIfExists !== false || rename.rootDirectoryNull !== true ||
            typeof rename.bufferValidated !== "boolean") throw problem("invalid rename ACK")
        receipt.rename = { attempted: rename.attempted, success: rename.success, error: rename.error,
          byHandle: rename.byHandle, replaceIfExists: false, rootDirectoryNull: true, bufferValidated: rename.bufferValidated }
        if (result.failure !== null) {
          const value = result.failure
          if (!value || value.phase !== result.phase || !phases.includes(value.phase) ||
              !["validation", "api", "exception", "disposal"].includes(value.kind) ||
              !(value.code === null || uint(value.code)) || value.kind === "api" && !uint(value.code))
            throw problem("invalid failure ACK")
          receipt.failure = { phase: value.phase, kind: value.kind, code: value.code }
        }
        if (!receipt.handles.confirmedDisposed || !normal || issueError) throw problem("disposal, retirement or protocol uncertain")
        if (state.released) {
          if (result.disposition === "moved" && result.moved === true && receipt.close.code === 0 &&
              rename.attempted && rename.success === true && rename.byHandle && rename.bufferValidated &&
              Object.values(receipt.comparisons).every(Boolean) && result.failure === null) state.movement = "confirmed"
          else if (result.disposition === "refused" && result.moved === false && receipt.close.code === 3 &&
              receipt.failure && receipt.failure.kind !== "exception" && rename.success !== true) {
            state.movement = "refused"; state.refusal = receipt.failure
          } else throw problem("released outcome uncertain")
        } else if (result.moved !== false || rename.attempted || !["closed", "refused"].includes(result.disposition) ||
            ![0, 3].includes(receipt.close.code)) throw problem("pre-release outcome uncertain")
        else if (result.disposition === "refused") state.refusal = receipt.failure
      } catch (error) { failure ??= issueError || error; state.movement = "unconfirmed" }
      if (failure && receipt.cleanupConfirmed) {
        operationError ??= failure
        state.movement = state.released ? "unconfirmed" : "not_released"
        failure = undefined
        receipt.operationFailure = true
      }
      receipt.uncertain = state.movement === "unconfirmed" || state.retirement !== "confirmed" || !receipt.handles.confirmedDisposed
      receipt.settled = true
      event("session_settled")
      mode = "closed"
      if (failure) { receipt.cleanupFailure = true; throw attach(failure) }
      return state
    })()
    return retirePromise
  }
  async function finishWithPrimary(primary) {
    receipt.operationFailure = true
    try { await retire() } catch {
      if (primary && Object.isExtensible(primary)) {
        try { primary.native_close_failure = `native cleanup ${state.retirement}` }
        catch { receipt.primaryErrorAttachment = "unavailable_property" }
      }
      receipt.cleanupFailure = true
    }
    throw attach(primary)
  }
  try {
    if (platform !== "win32" || arch !== "x64") throw problem("Windows x64 only")
    supported(source); supported(destination)
    let physicalSource
    try { physicalSource = await realpath(source) }
    catch { throw problem("path resolution unavailable") }
    supported(physicalSource)
    await validateDestinationParent(true)
    const systemRoot = env.SystemRoot || env.SYSTEMROOT
    if (!systemRoot) throw problem("system runtime unavailable")
    try { child = spawn(path.win32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", PROGRAM],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env }) } catch { throw problem("spawn unavailable") }
    receipt.childPid = child.pid ?? null
    child.on("spawn", () => event("native_spawn"))
    child.on("error", () => issue("spawn_error"))
    child.stdin.on("error", () => issue("stdin_error"))
    child.stdout.on("error", () => issue("stdout_error"))
    child.stderr.on("error", () => issue("stderr_error"))
    child.stdout.on("data", chunk => {
      receipt.stdoutBytes += chunk.length
      if (receipt.stdoutBytes > 16384) { issue("stdout_oversized"); return }
      pending += chunk.toString("utf8")
      for (;;) {
        const newline = pending.indexOf("\n")
        if (newline < 0) break
        const line = pending.slice(0, newline).trim(); pending = pending.slice(newline + 1)
        let item
        try { item = JSON.parse(line) } catch { issue("malformed_json"); continue }
        response(item)
      }
    })
    child.stderr.on("data", chunk => {
      receipt.stderrBytes += chunk.length
      issue(receipt.stderrBytes > 16384 ? "stderr_oversized" : "stderr_nonempty")
    })
    child.on("exit", (code, signal) => { receipt.exit = { code, signal }; event("native_exit") })
    child.once("close", (code, signal) => {
      receipt.close = { code, signal }; event("native_close")
      if (pending.trim()) issue("unterminated_output")
      if (waiting) issue("closed_before_requested_stage")
      closeResolve()
    })
    const capture = expect("captured")
    event("capture_requested")
    send(JSON.stringify({ source, destination }) + "\n")
    await bounded(capture, 5000, "capture readiness timeout")
    if (issueError || !captured) throw issueError || problem("capture missing")
    mode = "captured"
  } catch (error) {
    if (child) return finishWithPrimary(error)
    state.retirement = "confirmed"
    throw attach(error)
  }
  return {
    get receipt() { return snapshot() },
    async admit(...args) {
      if (args.length || mode !== "captured") throw attach(problem("admit requires the unused fixed-pair session"))
      mode = "admitting"
      try {
        await validateDestinationParent(false)
        const answer = expect("ready")
        event("admission_requested"); send("admit\n")
        await bounded(answer, 5000, "additional admission readiness timeout")
        if (issueError || !ready) throw issueError || problem("additional admission missing")
        mode = "ready"
        return structuredClone(state)
      } catch (error) { return finishWithPrimary(error) }
    },
    async move(...args) {
      if (args.length !== 1 || typeof args[0] !== "function" || mode !== "ready")
        throw attach(problem("move requires one unused admitted fixed-pair callback"))
      mode = "callback"
      try {
        event("callback_started"); await args[0](); event("callback_completed")
        if (mode !== "callback" || issueError || receipt.close) throw issueError || problem("session closed before GO")
      } catch (error) { return finishWithPrimary(error) }
      state.released = true
      event("GO_attempted"); send("move\n", true)
      const settled = await retire()
      if (operationError) throw attach(operationError)
      if (settled.movement === "refused") {
        receipt.operationFailure = true
        throw attach(problem("native move refused"))
      }
      return structuredClone(settled)
    },
    async close(...args) {
      if (args.length > 1 || args.length === 1 && !(args[0] instanceof Error)) throw attach(problem("invalid close argument"))
      if (args.length) return finishWithPrimary(args[0])
      return structuredClone(await retire())
    },
  }
}
