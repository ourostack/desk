// Test-only read-only observer. No rename primitive or admission authority.
import { spawn as spawnChild } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"

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
function Close-Owned([IntPtr]$handle) {
  $script:closeAttempts++
  $ok = $native::CloseHandle($handle)
  $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  if ($ok) { $script:closed++ } else { $script:closeFailures++ }
  $result = @{ phase = $phase; success = [bool]$ok; error = (Error-Code $ok $last) }
  [void]$script:disposals.Add($result)
  return $result
}
function Read-Entry([string]$file) {
  $sample = @{
    openSuccess = $false; openError = $null
    volumeSuccess = $false; volumeError = $null; filesystem = 'unavailable'
    idSuccess = $false; idError = $null; volumeHex = $null; fileIdHex = $null
    attributeSuccess = $false; attributeError = $null; attributes = $null; reparseTag = $null
    closeAttempted = $false; closeSuccess = $null; closeError = $null
  }
  $handle = $native::CreateFileW($file, $access, $share, [IntPtr]::Zero, $disposition, $flags, [IntPtr]::Zero)
  $last = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $sample.openSuccess = $handle -ne [IntPtr]::Zero -and $handle -ne [IntPtr](-1)
  $sample.openError = Error-Code $sample.openSuccess $last
  if (!$sample.openSuccess) { return @{ handle = [IntPtr]::Zero; sample = $sample } }
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
  } catch {
    $disposal = Close-Owned $handle
    throw
  }
  return @{ handle = $handle; sample = $sample }
}
try {
  $assemblyName = New-Object Reflection.AssemblyName('DeskIdentityObservation')
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
  $module = $assembly.DefineDynamicModule('InMemory')
  $type = $module.DefineType('DeskIdentityNative', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
  $ctor = [Runtime.InteropServices.DllImportAttribute].GetConstructor([type[]]@([string]))
  $fields = [Reflection.FieldInfo[]]@(
    [Runtime.InteropServices.DllImportAttribute].GetField('SetLastError'),
    [Runtime.InteropServices.DllImportAttribute].GetField('ExactSpelling'),
    [Runtime.InteropServices.DllImportAttribute].GetField('CharSet'),
    [Runtime.InteropServices.DllImportAttribute].GetField('CallingConvention'))
  function Define-Native([string]$name, [type]$returns, [type[]]$parameters) {
    $method = $type.DefinePInvokeMethod($name, 'kernel32.dll', $name,
      [Reflection.MethodAttributes]'Public, Static, PinvokeImpl', [Reflection.CallingConventions]::Standard,
      $returns, $parameters, [Runtime.InteropServices.CallingConvention]::Winapi,
      [Runtime.InteropServices.CharSet]::Unicode)
    $method.SetImplementationFlags($method.GetMethodImplementationFlags() -bor [Reflection.MethodImplAttributes]::PreserveSig)
    $attribute = [Reflection.Emit.CustomAttributeBuilder]::new($ctor,
      [object[]]@('kernel32.dll'), $fields, [object[]]@($true, $true,
        [Runtime.InteropServices.CharSet]::Unicode, [Runtime.InteropServices.CallingConvention]::Winapi))
    $method.SetCustomAttribute($attribute)
  }
  Define-Native 'CreateFileW' ([IntPtr]) ([type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]))
  Define-Native 'GetFileInformationByHandleEx' ([bool]) ([type[]]@([IntPtr], [int], [IntPtr], [uint32]))
  Define-Native 'GetVolumeInformationByHandleW' ([bool]) ([type[]]@([IntPtr], [IntPtr], [uint32], [IntPtr], [IntPtr], [IntPtr], [Text.StringBuilder], [uint32]))
  Define-Native 'CloseHandle' ([bool]) ([type[]]@([IntPtr]))
  $native = $type.CreateType()
  $methods = $native.GetMethods([Reflection.BindingFlags]'Public, Static, DeclaredOnly')
  if ($methods.Count -ne 4) { throw 'invalid_emitted_metadata' }
  foreach ($method in $methods) {
    $imports = $method.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute], $false)
    if ($imports.Count -ne 1 -or !$imports[0].SetLastError -or !$imports[0].ExactSpelling -or
        $imports[0].CharSet -ne [Runtime.InteropServices.CharSet]::Unicode -or
        $imports[0].CallingConvention -ne [Runtime.InteropServices.CallingConvention]::Winapi -or
        ($method.GetMethodImplementationFlags() -band [Reflection.MethodImplAttributes]::PreserveSig) -eq 0) {
      throw 'invalid_emitted_metadata'
    }
  }
  $phase = 'request'
  $line = [Console]::ReadLine()
  if ($null -eq $line -or $line.Length -gt 16384) { throw 'invalid_request' }
  $request = $line | ConvertFrom-Json
  if ($request.source -isnot [string] -or !$request.source) { throw 'invalid_request' }
  $phase = 'baseline'
  $baseline = Read-Entry $request.source
  $baselineHandle = $baseline.handle
  Emit @{ state = 'ready'; pid = $PID; powershell = $PSVersionTable.PSVersion.ToString()
    runtime = [Environment]::Version.ToString(); edition = [string]$PSVersionTable.PSEdition
    compiler = 'reflection_emit_in_process'; metadataVerified = $true
    openContract = @{ access = $access; share = $share; disposition = $disposition; flags = $flags }
    baseline = $baseline.sample }
  $phase = 'observe'
  $count = 0
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
    Emit @{ state = 'observation'; sequence = $count; sample = $sample }
  }
  $phase = 'finish'
} catch { $programError = $phase }
finally {
  if ($baselineHandle -ne [IntPtr]::Zero -and $null -ne $native) {
    $disposal = Close-Owned $baselineHandle
  }
  Emit @{ state = 'finished'; opened = $script:opened; closeAttempts = $script:closeAttempts
    closed = $script:closed; closeFailures = $script:closeFailures; programError = $programError
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
