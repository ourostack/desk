// Synthetic protocol and managed-only controls, not Windows rename evidence.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { openArchiveHandleSession } from "./_windows_archive_handle.mjs"

const pair = { source: "C:\\owned\\PRIVATE_SOURCE", destination: "C:\\owned\\archive\\PRIVATE_SOURCE" }
const volumeHex = "8877665544332211", fileIdHex = "08070605040302011020304050607080"
const methods = ["CreateFileW", "GetFileInformationByHandleEx", "GetVolumeInformationByHandleW", "SetFileInformationByHandle", "CloseHandle"]
const layout = { pointerSize: 8, headerSize: 24, replaceOffset: 0, rootOffset: 8, lengthOffset: 16, nameOffset: 20, littleEndian: true }
function sample(role, extra = {}) {
  return { role, access: role === "held" ? 65536 : 0, share: role === "held" ? 3 : 7, flags: 35651584, creation: 3,
    openSuccess: true, openError: null, volumeSuccess: true, volumeError: null, filesystem: "NTFS",
    idSuccess: true, idError: null, volumeHex, fileIdHex,
    attributeSuccess: true, attributeError: null, attributes: 16, reparseTag: 0,
    closeSuccess: ["admitted", "current"].includes(role) ? true : null, closeError: null, ...extra }
}
function fakeNative(options = {}) {
  const child = new EventEmitter()
  child.pid = 42
  child.stdin = new EventEmitter()
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  const writes = [], stages = []
  const samples = { baseline: sample("baseline", options.baseline), admitted: null, held: null, current: null }
  let released = false, finished = false, args
  const emit = item => child.stdout.emit("data", Buffer.from(typeof item === "string" ? item : JSON.stringify(item) + "\n"))
  const close = (code = 0, signal = null) => { child.emit("exit", code, signal); child.emit("close", code, signal) }
  const finish = (disposition = released ? "moved" : "closed", phase = released ? "rename" : "close", failure = null) => {
    if (finished) return
    finished = true
    const opened = Object.values(samples).filter(value => value?.openSuccess).length
    for (const value of Object.values(samples)) if (value?.openSuccess) value.closeSuccess = true
    const same = (a, b) => !!(a?.openSuccess && b?.openSuccess && (a.attributes & 1024) === 0 &&
      (b.attributes & 1024) === 0 && a.fileIdHex === b.fileIdHex && a.volumeHex === b.volumeHex)
    const packet = { state: "result", disposition, phase, moved: disposition === "moved", failure, samples,
      comparisons: { admittedMatchesBaseline: same(samples.admitted, samples.baseline),
        heldMatchesBaseline: same(samples.held, samples.baseline),
        currentMatchesBaseline: same(samples.current, samples.baseline), currentMatchesHeld: same(samples.current, samples.held) },
      rename: { attempted: phase === "rename", success: phase === "rename" ? disposition === "moved" : null,
        error: phase === "rename" && disposition !== "moved" ? failure?.code : null,
        byHandle: phase === "rename", replaceIfExists: false, rootDirectoryNull: true, bufferValidated: phase === "rename" },
      handles: { opened, closeAttempts: opened, closed: opened, closeFailures: 0,
        disposals: Object.keys(samples).filter(role => samples[role]?.openSuccess)
          .map(role => ({ role, success: true, error: null })) } }
    if (options.finish) return options.finish({ packet, emit, close, child })
    emit(packet)
    close(disposition === "refused" ? 3 : 0)
  }
  child.stdin.write = text => {
    writes.push(text)
    queueMicrotask(() => {
      if (text.startsWith("{")) {
        stages.push("captured")
        const packet = { state: "captured", pid: child.pid, powershell: "5.1.26100.33438", runtime: "4.0.30319.42000",
          edition: "Desktop", architecture: "AMD64", compiler: "reflection_emit_in_process",
          metadata: methods.map(method => ({ method, verified: true })), layout, baseline: samples.baseline }
        if (options.capture) options.capture({ packet, emit, close, finish, samples, child })
        else emit(packet)
      } else if (text === "admit\n") {
        stages.push("admit")
        samples.admitted = sample("admitted", options.admitted)
        if (options.admit) return options.admit({ emit, close, finish, samples })
        if (samples.admitted.fileIdHex !== fileIdHex || samples.admitted.volumeHex !== volumeHex ||
            (samples.admitted.attributes & 1024) !== 0)
          return finish("refused", "admit", { phase: "admit", kind: "validation", code: null })
        emit({ state: "ready", pid: child.pid, admitted: samples.admitted, matchesBaseline: true })
      } else assert.fail("unexpected write")
    })
    return false
  }
  child.stdin.end = text => {
    if (text) writes.push(text)
    queueMicrotask(() => {
      if (text === "move\n") {
        released = true
        stages.push("GO")
        samples.held = sample("held", options.held)
        if (options.go) return options.go({ samples, emit, close, finish, child })
        samples.current = sample("current", options.current)
        finish()
      } else finish()
    })
    return child.stdin
  }
  child.kill = () => { if (!options.holdKill) close(null, "SIGTERM") }
  return { child, writes, stages, samples, args: () => args,
    dependencies: { platform: "win32", arch: "x64", env: { SystemRoot: "C:\\Windows" }, realpath: async value => value,
      spawn(executable, argv, settings) { args = { executable, argv, settings }; queueMicrotask(() => child.emit("spawn")); return child },
      setTimeout: (callback, ms) => setTimeout(callback, ms / 1000), clearTimeout } }
}

test("synthetic: live capture precedes preparation, additional admission precedes callback/barrier/GO", async () => {
  const f = fakeNative(), session = await openArchiveHandleSession(pair, f.dependencies)
  assert.deepEqual(f.stages, ["captured"])
  f.stages.push("actual-preparation-start", "actual-preparation-return")
  await session.admit()
  await session.move(async () => { f.stages.push("prepared.atUse", "original-barrier") })
  assert.deepEqual(f.stages, ["captured", "actual-preparation-start", "actual-preparation-return",
    "admit", "prepared.atUse", "original-barrier", "GO"])
  assert.equal(session.receipt.archiveMove.movement, "confirmed")
  assert.equal(session.receipt.archiveMove.retirement, "confirmed")
  assert.equal(session.receipt.handles.confirmedDisposed, true)
  assert.equal(session.receipt.additionalNativeAdmission, true)
  assert.equal(session.receipt.nodeIdentityBridge, false)
  await session.close()
  assert.deepEqual(f.writes.map(value => value.startsWith("{") ? "pair" : value), ["pair", "admit\n", "move\n"])
  assert.equal(createHash("sha256").update(f.args().argv[4]).digest("hex"), session.receipt.programSha256)
  assert.equal(f.args().argv[4].includes(pair.source), false)
  for (const secret of [pair.source, pair.destination, volumeHex, fileIdHex])
    assert.equal(JSON.stringify(session.receipt).includes(secret), false)
})

for (const baseline of [
  { openSuccess: false, openError: 5 }, { filesystem: "other" }, { volumeHex: "0000000000000000" },
  { fileIdHex: "00".repeat(16) }, { fileIdHex: "malformed" }, { attributes: 1040, reparseTag: 0xa0000003 },
]) test(`synthetic: unsupported captured source refuses without preparing or acquiring DELETE (${JSON.stringify(baseline)})`, async () => {
  const f = fakeNative({ baseline })
  await assert.rejects(openArchiveHandleSession(pair, f.dependencies), error => {
    assert.equal(error.archiveMove.released, false)
    assert.equal(error.handleReceipt.rename?.attempted ?? false, false)
    return true
  })
  assert.equal(f.writes.includes("move\n"), false)
})

for (const admitted of [
  { fileIdHex: "08070605040302011120304050607080" },
  { volumeHex: "8877665545332211" }, { attributes: 1040, reparseTag: 0xa0000003 },
]) test("synthetic: replacement before preparation or before admit cannot replace complete live admission", async () => {
  const f = fakeNative({ admitted }), session = await openArchiveHandleSession(pair, f.dependencies)
  await assert.rejects(session.admit())
  assert.equal(session.receipt.archiveMove.released, false)
  assert.equal(session.receipt.archiveMove.movement, "not_released")
  assert.equal(session.receipt.archiveMove.closed, true)
  assert.equal(session.receipt.archiveMove.retirement, "confirmed")
  assert.equal(f.writes.includes("move\n"), false)
  await session.close()
})

for (const [role, changes] of [
  ["held", { fileIdHex: "08070605040302011120304050607080" }],
  ["held", { volumeHex: "8877665545332211" }],
  ["held", { attributes: 1040, reparseTag: 0xa0000003 }],
  ["current", { fileIdHex: "08070605040302011120304050607080" }],
]) test(`synthetic: late ${role} mismatch/reparse refuses even when low ID parts match`, async () => {
  const f = fakeNative({
    go({ samples, finish }) {
      samples.held = sample("held", role === "held" ? changes : {})
      samples.current = role === "current" ? sample("current", changes) : null
      finish("refused", role === "held" ? "held_validate" : "current_validate",
        { phase: role === "held" ? "held_validate" : "current_validate", kind: "validation", code: null })
    },
  })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => {}), error => {
    assert.equal(error.archiveMove.movement, "refused")
    assert.equal(error.handleReceipt.rename.attempted, false)
    return true
  })
  await session.close()
})

for (const [phase, code] of [["delete_open", 32], ["rename", 183], ["rename", 5]]) {
  test(`synthetic: actual ${phase} return failure ${code} is refusal only after disposal and normal close`, async () => {
    const f = fakeNative({ go({ samples, finish }) {
      if (phase === "delete_open") samples.held = sample("held", { openSuccess: false, openError: code,
        volumeSuccess: false, volumeError: null, filesystem: "unavailable", idSuccess: false, idError: null,
        volumeHex: null, fileIdHex: null, attributeSuccess: false, attributeError: null, attributes: null, reparseTag: null })
      else samples.current = sample("current")
      finish("refused", phase, { phase, kind: "api", code })
    } })
    const session = await openArchiveHandleSession(pair, f.dependencies)
    await session.admit()
    await assert.rejects(session.move(async () => {}), error => {
      assert.equal(error.archiveMove.movement, "refused")
      assert.equal(error.archiveMove.refusal.code, code)
      assert.equal(error.handleReceipt.handles.confirmedDisposed, true)
      return true
    })
    await session.close()
  })
}

test("synthetic: callback/preparation errors remain exact primary errors; no GO or DELETE is sent", async () => {
  for (const point of ["preparation", "callback"]) {
    const f = fakeNative(), session = await openArchiveHandleSession(pair, f.dependencies)
    const primary = new Error("controlled original failure")
    if (point === "preparation") {
      await assert.rejects(session.close(primary), error => error === primary)
    } else {
      await session.admit()
      await assert.rejects(session.move(async () => { throw primary }), error => error === primary)
    }
    assert.equal(f.writes.includes("move\n"), false)
    assert.equal(session.receipt.archiveMove.released, false)
    assert.equal(session.receipt.handles.confirmedDisposed, true)
    await session.close()
  }
})

test("synthetic: early close is idempotent, pair fixed, and admit/move/retry/reuse forbidden", async () => {
  const mutable = { ...pair }, f = fakeNative()
  const session = await openArchiveHandleSession(mutable, f.dependencies)
  mutable.destination = "C:\\different"
  assert.deepEqual(JSON.parse(f.writes[0]), pair)
  await session.close()
  await session.close()
  assert.equal(f.writes.filter(value => value === "close\n").length, 1)
  await assert.rejects(session.admit())
  await assert.rejects(session.move(async () => {}))
  const second = fakeNative(), s = await openArchiveHandleSession(pair, second.dependencies)
  await assert.rejects(s.admit({ source: "C:\\wrong", destination: pair.destination }))
  await s.close()
  const third = fakeNative(), t = await openArchiveHandleSession(pair, third.dependencies)
  await t.admit()
  await t.move(async () => {})
  await assert.rejects(t.move(async () => {}))
  await assert.rejects(t.admit())
  await t.close()
})

for (const kind of ["missing_ack", "disposal_failed", "no_close", "no_exit", "unretired", "duplicate", "malformed"]) {
  test(`synthetic: released ${kind} is uncertainty, never refusal or success`, async () => {
    const f = fakeNative({ holdKill: kind === "unretired", finish({ packet, emit, close, child }) {
      if (kind === "missing_ack") return close()
      if (kind === "malformed") { emit("PRIVATE_NATIVE_STDOUT\n"); return close() }
      if (kind === "disposal_failed") {
        packet.handles.closed--
        packet.handles.closeFailures = 1
        packet.handles.disposals[0] = { role: "baseline", success: false, error: 6 }
      }
      emit(packet)
      if (kind === "duplicate") emit(packet)
      if (kind === "no_exit") return child.emit("close", 0, null)
      if (!["no_close", "unretired"].includes(kind)) close()
    } })
    const session = await openArchiveHandleSession(pair, f.dependencies)
    await session.admit()
    await assert.rejects(session.move(async () => {}), error => {
      assert.equal(error.archiveMove.movement, "unconfirmed")
      assert.equal(error.archiveMove.released, true)
      assert.equal(JSON.stringify(error.handleReceipt).includes("PRIVATE_NATIVE_STDOUT"), false)
      return true
    })
    if (kind === "duplicate") await session.close()
    else await assert.rejects(session.close())
  })
}

test("synthetic: cleanup cannot replace callback error, partial receipt survives unretired native handle", async () => {
  const f = fakeNative({ holdKill: true, finish() {} }), primary = new Error("original precondition")
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => { throw primary }), error => {
    assert.equal(error, primary)
    assert.equal(error.archiveMove.released, false)
    assert.equal(error.archiveMove.retirement, "unconfirmed")
    assert.equal(typeof error.native_close_failure, "string")
    assert.ok(error.handleReceipt.events.length > 0)
    return true
  })
  await assert.rejects(session.close())
})

for (const bad of ["C:\\source.", "C:\\source ", "\\\\?\\C:\\source", "\\\\server\\share\\source",
  "C:\\NUL", "C:\\a:stream", "C:\\" + "x".repeat(245)]) {
  test("synthetic: unsupported spelling refuses before native capture", async () => {
    let spawned = false
    const f = fakeNative()
    await assert.rejects(openArchiveHandleSession({ source: bad, destination: pair.destination },
      { ...f.dependencies, spawn() { spawned = true; throw new Error("not reached") } }))
    assert.equal(spawned, false)
  })
}

test("synthetic: Unicode/apostrophes/metacharacters remain JSON data, never command source", async () => {
  const data = { source: "C:\\身份's & $(data)\\source", destination: "C:\\身份's & $(data)\\archive" }
  const f = fakeNative(), session = await openArchiveHandleSession(data, f.dependencies)
  await session.admit()
  await session.move(async () => {})
  assert.deepEqual(JSON.parse(f.writes[0]), data)
  assert.equal(f.args().argv[4].includes(data.source), false)
  await session.close()
})

test("synthetic: capture can precede archive-parent creation, but admit must validate its resolved spelling", async () => {
  const f = fakeNative()
  let parentExists = false
  f.dependencies.realpath = async value => {
    if (value === path.win32.dirname(pair.destination) && !parentExists)
      throw Object.assign(new Error("controlled missing parent"), { code: "ENOENT" })
    return value
  }
  const session = await openArchiveHandleSession(pair, f.dependencies)
  assert.equal(session.receipt.destinationParentValidation, "deferred_until_admit")
  parentExists = true // The real task's withCreatedDirs runs before its injected move.
  await session.admit()
  assert.equal(session.receipt.destinationParentValidation, "validated")
  await session.move(async () => {})
  await session.close()
})

test("synthetic: frozen callback error stays exact even when later cleanup is uncertain", async () => {
  const f = fakeNative({ holdKill: true, finish() {} }), primary = Object.freeze(new Error("frozen original"))
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => { throw primary }), error => error === primary)
  assert.equal(session.receipt.cleanupFailure, true)
  assert.equal(session.receipt.archiveMove.retirement, "unconfirmed")
  await assert.rejects(session.close())
})

for (const corruption of ["missing_live_baseline", "duplicate_disposal_role", "contradictory_native_comparison"]) {
  test(`synthetic: ${corruption} cannot falsely confirm native retirement or a move`, async () => {
    const f = fakeNative({ finish({ packet, emit, close }) {
      if (corruption === "missing_live_baseline") {
        packet.samples.baseline = null
        packet.handles = { opened: 0, closeAttempts: 0, closed: 0, closeFailures: 0, disposals: [] }
      } else if (corruption === "duplicate_disposal_role") {
        packet.handles.disposals = packet.handles.disposals.map(row => ({ ...row, role: "baseline" }))
      } else packet.comparisons.heldMatchesBaseline = false
      emit(packet); close()
    } })
    const session = await openArchiveHandleSession(pair, f.dependencies)
    if (corruption !== "missing_live_baseline") await session.admit()
    await assert.rejects(corruption === "missing_live_baseline" ? session.close() : session.move(async () => {}),
      error => {
        assert.equal(error.archiveMove.movement, "unconfirmed")
        return true
      })
    if (corruption === "contradictory_native_comparison") await session.close()
  })
}

test("synthetic: late positive ACK is an operation timeout, but independently confirmed cleanup remains quiet", async () => {
  const f = fakeNative({ finish({ packet, emit, close }) {
    setTimeout(() => { emit(packet); close() }, 6)
  } })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => {}), error => {
    assert.equal(error.archiveMove.movement, "unconfirmed")
    assert.equal(error.archiveMove.retirement, "confirmed")
    assert.equal(error.handleReceipt.cleanupConfirmed, true)
    return true
  })
  await session.close()
})

test("synthetic: caller-owned receipt data cannot grant GO or suppress retirement of the live baseline", async () => {
  const f = fakeNative(), session = await openArchiveHandleSession(pair, f.dependencies)
  const observed = session.receipt
  observed.archiveMove.released = true
  observed.admissionValidated = true
  await assert.rejects(session.move(async () => {}))
  await session.close()
  assert.equal(f.writes.includes("move\n"), false)
  assert.equal(f.writes.includes("close\n"), true)
  assert.equal(session.receipt.archiveMove.released, false)
  assert.equal(session.receipt.handles.confirmedDisposed, true)
})

test("synthetic: an unavailable CloseHandle return retains explicit partial accounting, never invents a Win32 error", async () => {
  const f = fakeNative({ finish({ packet, emit, close }) {
    packet.handles.closed--
    packet.handles.closeFailures = 1
    packet.samples.baseline.closeSuccess = null
    packet.handles.disposals[0] = { role: "baseline", success: null, error: null }
    emit(packet); close(4)
  } })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => {}), error => {
    assert.equal(error.archiveMove.movement, "unconfirmed")
    assert.equal(error.handleReceipt.handles.closeFailures, 1)
    assert.equal(error.handleReceipt.handles.disposals[0].success, null)
    assert.equal(error.handleReceipt.handles.disposals[0].error, null)
    return true
  })
})

async function capturedProgram() {
  const f = fakeNative(), session = await openArchiveHandleSession(pair, f.dependencies)
  await session.close()
  return f.args().argv[4]
}
const parserExecutable = () => process.platform === "win32" ?
  path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "pwsh"

test("managed-only: actual captured PowerShell parses and defines its helpers before the native setup body", async t => {
  const script = `
$ErrorActionPreference = 'Stop'
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors)
$setup = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
$rows = @()
foreach ($name in @('Define-Native', 'Build-Layout', 'Build-RenameBuffer', 'Refuse', 'Close-Entry', 'Read-Entry', 'Valid-Entry', 'Same-Entry')) {
  $definitions = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name })
  $rows += @{ name = $name; scriptScoped = $definitions.Count -eq 1
    beforeSetup = $definitions.Count -eq 1 -and $setup.Count -eq 1 -and $definitions[0].Extent.EndOffset -lt $setup[0].Extent.StartOffset }
}
[Console]::WriteLine((@{ parseErrors = $errors.Count; helpers = $rows } | ConvertTo-Json -Depth 5 -Compress))
`
  const parsed = spawnSync(parserExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { input: await capturedProgram(), encoding: "utf8", env: process.env, timeout: 5000 })
  if (process.platform !== "win32" && parsed.error?.code === "ENOENT") return t.skip("PowerShell parser unavailable; not native Windows proof")
  assert.equal(parsed.status, 0, parsed.error?.code ?? "PowerShell AST-only parse failed")
  const report = JSON.parse(parsed.stdout)
  assert.equal(report.parseErrors, 0)
  assert.deepEqual(report.helpers, ["Define-Native", "Build-Layout", "Build-RenameBuffer", "Refuse", "Close-Entry",
    "Read-Entry", "Valid-Entry", "Same-Entry"].map(name => ({ name, scriptScoped: true, beforeSetup: true })))
})

test("managed-only: captured emitter/layout/UTF16 buffer execute without invoking ANY emitted PInvoke", async t => {
  const script = `
$ErrorActionPreference = 'Stop'
$stage = 'parse'
try {
$tokens = $null; $errors = $null
$ast = [Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$tokens, [ref]$errors)
if ($errors.Count -ne 0) { throw 'parse_failed' }
$setup = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
if ($setup.Count -ne 1) { throw 'setup_missing' }
$context = @{}
$stage = 'contexts'
foreach ($key in @('ctor', 'fields')) {
  $assignments = @($setup[0].Body.Statements | Where-Object {
    $_ -is [Management.Automation.Language.AssignmentStatementAst] -and
    $_.Left -is [Management.Automation.Language.VariableExpressionAst] -and $_.Left.VariablePath.UserPath -ceq $key })
  if ($assignments.Count -ne 1) { throw 'context_missing' }
  $right = $assignments[0].Right
  $statements = New-Object 'System.Collections.Generic.List[System.Management.Automation.Language.StatementAst]'
  $statements.Add($right.Copy())
  $block = [Management.Automation.Language.StatementBlockAst]::new($right.Extent, $statements,
    [Management.Automation.Language.TrapStatementAst[]]@())
  $expression = [Management.Automation.Language.ScriptBlockAst]::new($right.Extent, $null, $block, $false)
  $context[$key] = $expression.GetScriptBlock().InvokeReturnAsIs()
}
$assemblyName = New-Object Reflection.AssemblyName('DeskHandleManagedQualification')
$stage = 'assembly'
if ($PSVersionTable.PSEdition -ceq 'Desktop') {
  $assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
} else {
  $assembly = [Reflection.Emit.AssemblyBuilder]::DefineDynamicAssembly($assemblyName, [Reflection.Emit.AssemblyBuilderAccess]::Run)
}
$module = $assembly.DefineDynamicModule('InMemory')
$type = $module.DefineType('DeskCapturedHandleMetadata', [Reflection.TypeAttributes]'Public, Abstract, Sealed')
$definitions = @{}
foreach ($name in @('Define-Native', 'Build-Layout', 'Build-RenameBuffer')) {
  $matches = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name })
  if ($matches.Count -ne 1) { throw 'definition_missing' }
  $definitions[$name] = $matches[0].Body.GetScriptBlock()
}
$specs = @(
  @{ name = 'CreateFileW'; returns = [IntPtr]; parameters = [type[]]@([string], [uint32], [uint32], [IntPtr], [uint32], [uint32], [IntPtr]) },
  @{ name = 'GetFileInformationByHandleEx'; returns = [bool]; parameters = [type[]]@([IntPtr], [int], [IntPtr], [uint32]) },
  @{ name = 'GetVolumeInformationByHandleW'; returns = [bool]; parameters = [type[]]@([IntPtr], [IntPtr], [uint32], [IntPtr], [IntPtr], [IntPtr], [Text.StringBuilder], [uint32]) },
  @{ name = 'SetFileInformationByHandle'; returns = [bool]; parameters = [type[]]@([IntPtr], [int], [IntPtr], [uint32]) },
  @{ name = 'CloseHandle'; returns = [bool]; parameters = [type[]]@([IntPtr]) })
$stage = 'emit'
foreach ($spec in $specs) {
  $variables = New-Object 'System.Collections.Generic.List[System.Management.Automation.PSVariable]'
  foreach ($key in @('name', 'returns', 'parameters')) { $variables.Add([Management.Automation.PSVariable]::new($key, $spec[$key])) }
  $variables.Add([Management.Automation.PSVariable]::new('type', $type))
  $variables.Add([Management.Automation.PSVariable]::new('ctor', $context.ctor))
  $variables.Add([Management.Automation.PSVariable]::new('fields', [Reflection.FieldInfo[]]@($context.fields)))
  [void]$definitions['Define-Native'].InvokeWithContext($null, $variables, @())
}
$native = $type.CreateType()
$stage = 'reflect'
$rows = @()
foreach ($spec in $specs) {
  $method = $native.GetMethod($spec.name)
  $imports = @($method.GetCustomAttributes([Runtime.InteropServices.DllImportAttribute], $false))
  if ($imports.Count -ne 1) { throw 'import_count' }
  $import = $imports[0]
  $parameters = @($method.GetParameters() | ForEach-Object { $_.ParameterType })
  $signature = $method.ReturnType -eq $spec.returns -and $parameters.Count -eq $spec.parameters.Count
  for ($index = 0; $index -lt $parameters.Count -and $signature; $index++) {
    $signature = $parameters[$index] -eq $spec.parameters[$index]
  }
  $rows += @{ method = $spec.name; signature = $signature; publicStatic = $method.IsPublic -and $method.IsStatic
    entryPoint = $import.EntryPoint -ceq $spec.name; import = $import.Value -ceq 'kernel32.dll'
    setLastError = $import.SetLastError; exactSpelling = $import.ExactSpelling; preserveSig = $import.PreserveSig
    unicode = $import.CharSet -eq [Runtime.InteropServices.CharSet]::Unicode
    winapi = $import.CallingConvention -eq [Runtime.InteropServices.CallingConvention]::Winapi
    implementationPreserveSig = ($method.GetMethodImplementationFlags() -band [Reflection.MethodImplAttributes]::PreserveSig) -ne 0 }
}
$variables = New-Object 'System.Collections.Generic.List[System.Management.Automation.PSVariable]'
$variables.Add([Management.Automation.PSVariable]::new('module', $module))
$stage = 'layout'
$layoutOutput = @($definitions['Build-Layout'].InvokeWithContext($null, $variables, @()))
if ($layoutOutput.Count -ne 1) { throw 'layout_result_count' }
$layout = $layoutOutput[0]
$destination = 'C:\\owned\\身份''s & $(data)'
$variables = New-Object 'System.Collections.Generic.List[System.Management.Automation.PSVariable]'
$variables.Add([Management.Automation.PSVariable]::new('destination', $destination))
$stage = 'buffer'
$bufferOutput = @($definitions['Build-RenameBuffer'].InvokeWithContext($null, $variables, @()))
if ($bufferOutput.Count -ne 1) { throw 'buffer_result_count' }
$buffer = $bufferOutput[0]
try {
  $nameBytes = New-Object byte[] $buffer.nameBytes
  [Runtime.InteropServices.Marshal]::Copy([IntPtr]::Add($buffer.pointer, 20), $nameBytes, 0, $nameBytes.Length)
  $bufferFacts = @{
    replaceFalse = [Runtime.InteropServices.Marshal]::ReadInt32($buffer.pointer, 0) -eq 0
    rootNull = [Runtime.InteropServices.Marshal]::ReadIntPtr($buffer.pointer, 8) -eq [IntPtr]::Zero
    lengthIsUtf16Bytes = [Runtime.InteropServices.Marshal]::ReadInt32($buffer.pointer, 16) -eq [Text.Encoding]::Unicode.GetByteCount($destination)
    exactName = [Text.Encoding]::Unicode.GetString($nameBytes) -ceq $destination
    optionalNull = [Runtime.InteropServices.Marshal]::ReadInt16($buffer.pointer, 20 + $buffer.nameBytes) -eq 0
  }
} finally { [Runtime.InteropServices.Marshal]::FreeHGlobal($buffer.pointer) }
[Console]::WriteLine((@{ scope = 'managed_metadata_and_memory_only_no_emitted_PInvoke_not_Windows_ABI'
  runtime = [Environment]::Version.ToString(); methods = $rows; layout = $layout; buffer = $bufferFacts } | ConvertTo-Json -Depth 7 -Compress))
} catch {
  $failure = $_.Exception.GetBaseException()
  $exception = $failure.GetType().FullName
  if (@('System.ArgumentException', 'System.InvalidOperationException', 'System.TypeLoadException',
    'System.MissingMethodException', 'System.Reflection.AmbiguousMatchException',
    'System.Management.Automation.RuntimeException', 'System.Management.Automation.MethodException',
    'System.Management.Automation.MethodInvocationException') -notcontains $exception) { $exception = 'other' }
  [Console]::WriteLine((@{ scope = 'managed_library_failure'; stage = $stage; exception = $exception
    hresult = $failure.HResult } | ConvertTo-Json -Compress))
  exit 4
}
`
  const checked = spawnSync(parserExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { input: await capturedProgram(), encoding: "utf8", env: process.env, timeout: 5000 })
  if (process.platform !== "win32" && checked.error?.code === "ENOENT") return t.skip("PowerShell managed library unavailable; Windows ABI unqualified")
  if (checked.status !== 0 && checked.stdout.trim()) {
    const failure = JSON.parse(checked.stdout)
    t.diagnostic(JSON.stringify({ scope: failure.scope, stage: failure.stage, exception: failure.exception, hresult: failure.hresult }))
  }
  assert.equal(checked.status, 0, checked.error?.code ?? "managed-only emitter/layout control failed")
  const report = JSON.parse(checked.stdout)
  assert.equal(report.scope, "managed_metadata_and_memory_only_no_emitted_PInvoke_not_Windows_ABI")
  t.diagnostic(JSON.stringify({ scope: report.scope, runtime: report.runtime }))
  assert.deepEqual(report.layout, layout)
  assert.deepEqual(report.buffer, { replaceFalse: true, rootNull: true, lengthIsUtf16Bytes: true, exactName: true, optionalNull: true })
  assert.deepEqual(report.methods, methods.map(method => ({ method, signature: true, publicStatic: true, entryPoint: true,
    import: true, setLastError: true, exactSpelling: true, preserveSig: true, unicode: true, winapi: true,
    implementationPreserveSig: true })))
})
