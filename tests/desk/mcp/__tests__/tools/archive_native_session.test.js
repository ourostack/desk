// Production module transport/managed controls; synthetic transport is not Windows proof.
import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import path from "node:path"
import { openArchiveHandleSession } from "../../../../../plugins/desk/mcp/src/tools/archive-native-session.js"
import { openArchiveMoveSession } from "../../../../../plugins/desk/mcp/src/tools/archive-move.js"

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
          metadata: methods.map(method => ({ method, verified: true })), layout: { ...layout }, baseline: samples.baseline }
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

test("production native defaults reject this unsupported host without spawning or leaking paths", async () => {
  if (process.platform !== "win32") await assert.rejects(openArchiveHandleSession(pair), /Windows x64 only/u)
})

for (const transport of ["error", "stdin", "stdout", "stderr", "stderr_small", "stderr_large", "stdout_large", "partial", "event_bound"]) {
  test(`production transport synthetic: bounded/private ${transport} capture failure`, async () => {
    const f = fakeNative({ capture({ packet, emit, close, child }) {
      if (transport === "event_bound") {
        emit(packet)
        for (let index = 0; index < 130; index++) child.emit("spawn")
      } else if (transport === "partial") {
        emit("PRIVATE_NATIVE_FRAGMENT"); close(4)
      } else if (transport === "stdout_large") emit("PRIVATE_NATIVE_OUTPUT".repeat(1000))
      else if (transport.startsWith("stderr_")) child.stderr.emit("data",
        Buffer.alloc(transport === "stderr_large" ? 16385 : 1, 65))
      else if (transport === "error") child.emit("error", new Error("PRIVATE_NATIVE_PATH"))
      else child[transport].emit("error", new Error("PRIVATE_NATIVE_PATH"))
    } })
    await assert.rejects(openArchiveHandleSession(pair, f.dependencies), error => {
      assert.equal(JSON.stringify(error.handleReceipt).includes("PRIVATE_NATIVE"), false)
      assert.ok(error.handleReceipt.events.length <= 128)
      return true
    })
  })
}

for (const change of [
  packet => { packet.pid = 99 },
  packet => { packet.layout.nameOffset = 22 },
  packet => { packet.baseline.share = 3 },
  packet => { packet.baseline.idError = 5 },
  packet => { packet.baseline.closeError = 5 },
  packet => { packet.baseline.closeSuccess = false },
  packet => { packet.baseline.openSuccess = false; packet.baseline.openError = 5 },
]) test("production transport synthetic: malformed captured ABI/API/handle contract cannot admit", async () => {
  const f = fakeNative({ capture({ packet, emit }) { change(packet); emit(packet) } })
  await assert.rejects(openArchiveHandleSession(pair, f.dependencies))
  assert.equal(f.writes.includes("move\n"), false)
})

test("production transport synthetic: invalid ready cannot grant admission despite a complete capture", async () => {
  const f = fakeNative({ admit({ emit, samples }) {
    emit({ state: "ready", pid: 99, admitted: samples.admitted, matchesBaseline: true })
  } })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await assert.rejects(session.admit())
  assert.equal(f.writes.includes("move\n"), false)
})

for (const corrupt of [
  packet => { packet.disposition = "PRIVATE_DISPOSITION" },
  packet => { packet.rename.replaceIfExists = true },
  packet => { packet.failure = { phase: "PRIVATE_PHASE", kind: "api", code: 5 } },
  packet => { packet.samples.current = { ...packet.samples.current, closeSuccess: false, closeError: null } },
  packet => { packet.samples.baseline.fileIdHex = "08070605040302011120304050607080" },
]) test("production transport synthetic: malformed result never becomes publication permission", async () => {
  const f = fakeNative({ finish({ packet, emit, close }) { corrupt(packet); emit(packet); close() } })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => {}))
  assert.notEqual(session.receipt.archiveMove.movement, "confirmed")
  assert.equal(JSON.stringify(session.receipt).includes("PRIVATE_"), false)
})

test("production transport synthetic: EOF refusal, source/path resolution and system-runtime errors stay explicit", async () => {
  for (const override of [
    { env: {} },
    { realpath() { throw new Error("PRIVATE_PATH") } },
    { realpath: async value => value === pair.source ? "C:\\physical.\\source" : value },
    { spawn() { throw new Error("PRIVATE_EXECUTABLE") } },
  ]) await assert.rejects(openArchiveHandleSession(pair, { ...fakeNative().dependencies, ...override }),
    error => !error.message.includes("PRIVATE_"))
  const f = fakeNative()
  f.dependencies.env = { SYSTEMROOT: "C:\\Windows" }
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.close()
})

test("production transport synthetic: a still-missing destination parent refuses at admission, not after GO", async () => {
  const f = fakeNative()
  f.dependencies.realpath = async value => {
    if (value !== pair.source) throw Object.assign(new Error("controlled missing"), { code: "ENOENT" })
    return value
  }
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await assert.rejects(session.admit(), /destination parent resolution/u)
  await session.close()
})

for (const missing of ["capture", "admit"]) test(`production transport synthetic: missing ${missing} response is bounded`, async () => {
  const f = fakeNative({ [missing]: () => {} })
  if (missing === "capture") await assert.rejects(openArchiveHandleSession(pair, f.dependencies), /readiness timeout/u)
  else {
    const session = await openArchiveHandleSession(pair, f.dependencies)
    await assert.rejects(session.admit(), /readiness timeout/u)
    await session.close()
  }
})

test("production transport synthetic: synchronous stdin/termination failures preserve safe disposition", async () => {
  for (const closeInput of [false, true]) {
    const f = fakeNative(), write = f.child.stdin.write, end = f.child.stdin.end
    f.child.stdin.write = text => { if (!closeInput) throw new Error("PRIVATE_WRITE"); return write(text) }
    f.child.stdin.end = text => { if (closeInput) throw new Error("PRIVATE_END"); return end(text) }
    if (!closeInput) await assert.rejects(openArchiveHandleSession(pair, f.dependencies))
    else {
      const session = await openArchiveHandleSession(pair, f.dependencies)
      await assert.rejects(session.close())
    }
  }
  const f = fakeNative({ holdKill: true, finish() {} })
  f.child.kill = () => { throw new Error("PRIVATE_KILL") }
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await assert.rejects(session.close())
})

test("production transport synthetic: concurrent misuse or a native failure during freshness never sends GO", async () => {
  for (const close of [true, false]) {
    const f = fakeNative(), session = await openArchiveHandleSession(pair, f.dependencies)
    await session.admit()
    await assert.rejects(session.move(async () => {
      if (close) await session.close()
      else f.child.stdout.emit("data", Buffer.from('{"state":"unexpected"}\n'))
    }))
    assert.equal(f.writes.includes("move\n"), false)
  }
})

test("production transport synthetic: callable/falsy/read-only original errors remain first", async () => {
  for (const primary of [function original() {}, 0, Object.defineProperty(new Error("read-only receipt"), "handleReceipt", { value: null })]) {
    const f = fakeNative(), session = await openArchiveHandleSession(pair, f.dependencies)
    await session.admit()
    await assert.rejects(session.move(async () => { throw primary }), error => error === primary)
    await session.close()
  }
  const primary = Object.defineProperty(new Error("read-only cleanup"), "native_close_failure", { value: "original" })
  const f = fakeNative({ holdKill: true, finish() {} }), session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => { throw primary }), error => error === primary)
  assert.equal(primary.native_close_failure, "original")
  await assert.rejects(session.close("not-an-error"), /invalid close argument/u)
})

test("production transport synthetic: close reports a newly discovered operation anomaly once, not as cleanup uncertainty", async () => {
  const f = fakeNative({ finish({ packet, emit, close }) {
    packet.moved = true
    packet.disposition = "moved"
    emit(packet); close()
  } })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await assert.rejects(session.close(), error => {
    assert.equal(error.handleReceipt.cleanupConfirmed, true)
    return true
  })
  await session.close()
})

for (const corrupt of [
  packet => { delete packet.samples.current },
  packet => { packet.handles.opened = 5 },
  packet => { packet.disposition = "uncertain" },
]) test("production transport synthetic: incomplete samples/accounting or unresolved result cannot settle a move", async () => {
  const f = fakeNative({ finish({ packet, emit, close }) { corrupt(packet); emit(packet); close() } })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await session.admit()
  await assert.rejects(session.move(async () => {}))
  assert.equal(session.receipt.archiveMove.movement, "unconfirmed")
})

test("production transport synthetic: absent child identity and post-ready protocol errors never release GO", async () => {
  const closedBeforeCapture = fakeNative({ capture({ close }) { close(4) } })
  await assert.rejects(openArchiveHandleSession(pair, closedBeforeCapture.dependencies),
    error => error.handleReceipt.protocolIssues.includes("closed_before_requested_stage"))
  const absent = fakeNative()
  absent.child.pid = undefined
  await assert.rejects(openArchiveHandleSession(pair, absent.dependencies), error => {
    assert.equal(error.handleReceipt.childPid, null)
    return true
  })
  const capture = fakeNative({ capture({ packet, emit }) { emit(packet); emit({ state: "unexpected" }) } })
  await assert.rejects(openArchiveHandleSession(pair, capture.dependencies))
  const f = fakeNative({ admit({ samples, emit }) {
    emit({ state: "ready", pid: 42, admitted: samples.admitted, matchesBaseline: true })
    emit({ state: "unexpected" })
  } })
  const session = await openArchiveHandleSession(pair, f.dependencies)
  await assert.rejects(session.admit())
  assert.equal(f.writes.includes("move\n"), false)
  await session.close()
})

test("production factory with synthetic transport selects the actual native source module and qualified program", async () => {
  const f = fakeNative(), session = await openArchiveMoveSession(pair, f.dependencies)
  await session.admit()
  await session.move(async () => {})
  await session.close()
  assert.equal(session.receipt.scope, "archive_native_preadmission_session")
  assert.equal(session.receipt.programSha256, "dda35c5729626c8499a568e9945ce3c4f8b2d0e80a43b2c9e04e521d746bc160")
  assert.equal(session.receipt.capturedValidated, true)
  assert.equal(session.receipt.admissionValidated, true)
  assert.equal(session.receipt.archiveMove.movement, "confirmed")
})

const parserExecutable = () => process.platform === "win32" ?
  path.win32.join(process.env.SystemRoot || process.env.SYSTEMROOT || "", "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "pwsh"

function correlateMetadataClock(times, clocks) {
  const unavailable = reason => ({ kind: "utc_correlated_estimate", state: "unavailable", reason,
    offsetsMs: times.map(() => null), clockAlignmentProven: false })
  if (!Number.isSafeInteger(clocks.wallStart) || !Number.isSafeInteger(clocks.wallEnd) ||
      !Number.isFinite(clocks.monotonicMs) || clocks.monotonicMs < 0) return unavailable("parent_clock_unavailable")
  const wallDuration = clocks.wallEnd - clocks.wallStart
  if (wallDuration < 0 || Math.abs(wallDuration - clocks.monotonicMs) > 100) return unavailable("parent_clock_inconsistent")
  if (times.length === 0) return unavailable("no_stages")
  if (times.some(time => !Number.isSafeInteger(time))) return unavailable("child_clock_unavailable")
  const offsetsMs = times.map(time => time - clocks.wallStart)
  if (offsetsMs.some(offset => offset < 0)) return unavailable("negative_offset")
  if (offsetsMs.some(offset => offset > wallDuration)) return unavailable("outside_parent_window")
  if (offsetsMs.some((offset, index) => index > 0 && offset < offsetsMs[index - 1])) return unavailable("out_of_order")
  return { kind: "utc_correlated_estimate", state: "checks_passed_not_alignment_proven", reason: null,
    offsetsMs, clockAlignmentProven: false }
}

function observeMetadataStages(stderr, clocks) {
  const stages = [], times = []
  let unrecognizedLines = 0
  let powershell = null, runtimeRows = 0
  for (const line of stderr.split(/\r?\n/u).filter(Boolean)) {
    if (line.startsWith("DESK_METADATA_RUNTIME:")) {
      const match = /^DESK_METADATA_RUNTIME:(Desktop|Core):(\d{1,4}\.\d{1,4}\.\d{1,6}(?:\.\d{1,6})?)(?:-[0-9A-Za-z.-]{1,40})?$/u.exec(line)
      runtimeRows++
      powershell = runtimeRows === 1 && match ? { version: match[2].split(".").map(Number), edition: match[1] } : null
      continue
    }
    const [stage, stamp, ...extra] = line.startsWith("DESK_METADATA_STAGE:") ?
      line.slice("DESK_METADATA_STAGE:".length).split(":") : []
    if (["command_started", "input_read", "parsed", "helpers_checked", "report_written"].includes(stage) &&
        stages.length < 16 && extra.length === 0) {
      stages.push(stage)
      times.push(typeof stamp === "string" && /^\d{1,16}$/u.test(stamp) && Number.isSafeInteger(Number(stamp)) ? Number(stamp) : null)
    }
    else unrecognizedLines++
  }
  return { stages, unrecognizedLines,
    ...(clocks ? { clockEstimate: correlateMetadataClock(times, clocks), powershell } : {}) }
}

test("metadata phase observations retain only stage enums and account for unexpected stderr", () => {
  assert.deepEqual(observeMetadataStages([
    "DESK_METADATA_STAGE:command_started", "PRIVATE_FIXTURE",
    "DESK_METADATA_STAGE:input_read", "DESK_METADATA_STAGE:PRIVATE_FIXTURE", "",
  ].join("\n")), { stages: ["command_started", "input_read"], unrecognizedLines: 2 })
})

test("metadata clock observations retain qualified offsets and numeric runtime components, never raw epochs", () => {
  const observed = observeMetadataStages([
    "DESK_METADATA_STAGE:command_started:1700000001100",
    "DESK_METADATA_RUNTIME:Core:7.5.2",
    "DESK_METADATA_STAGE:report_written:1700000001200",
  ].join("\n"), { wallStart: 1700000001000, wallEnd: 1700000001500, monotonicMs: 500 })
  assert.deepEqual(observed, {
    stages: ["command_started", "report_written"], unrecognizedLines: 0,
    clockEstimate: { kind: "utc_correlated_estimate", state: "checks_passed_not_alignment_proven",
      reason: null, offsetsMs: [100, 200], clockAlignmentProven: false },
    powershell: { version: [7, 5, 2], edition: "Core" },
  })
  assert.equal(JSON.stringify(observed).includes("1700000001"), false)
})

test("metadata clock observations report invalid or ambiguous timing instead of clamping it", () => {
  const clocks = { wallStart: 1000, wallEnd: 1500, monotonicMs: 500 }
  const cases = [
    { times: [999], clocks, reason: "negative_offset" },
    { times: [1200, 1100], clocks, reason: "out_of_order" },
    { times: [1501], clocks, reason: "outside_parent_window" },
    { times: [null], clocks, reason: "child_clock_unavailable" },
    { times: [1100], clocks: { ...clocks, monotonicMs: 2000 }, reason: "parent_clock_inconsistent" },
    { times: [1100], clocks: { ...clocks, wallEnd: 900 }, reason: "parent_clock_inconsistent" },
    { times: [1100], clocks: { ...clocks, monotonicMs: Infinity }, reason: "parent_clock_unavailable" },
    { times: [], clocks, reason: "no_stages" },
  ]
  for (const row of cases) {
    assert.deepEqual(correlateMetadataClock(row.times, row.clocks), {
      kind: "utc_correlated_estimate", state: "unavailable", reason: row.reason,
      offsetsMs: row.times.map(() => null), clockAlignmentProven: false,
    })
  }
  const unknown = observeMetadataStages(
    "DESK_METADATA_STAGE:command_started:unavailable\nDESK_METADATA_RUNTIME:PRIVATE_FIXTURE\n", clocks)
  assert.equal(unknown.clockEstimate.reason, "child_clock_unavailable")
  assert.equal(unknown.powershell, null)
  assert.equal(JSON.stringify(unknown).includes("PRIVATE_FIXTURE"), false)
})

test("managed-only: actual captured PowerShell parses and defines its helpers before the native setup body", async t => {
  const script = `
$ErrorActionPreference = 'Stop'
function Write-MetadataStage($name) {
  try { $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() } catch { $stamp = 'unavailable' }
  [Console]::Error.WriteLine(('DESK_METADATA_STAGE:{0}:{1}' -f $name, $stamp))
}
Write-MetadataStage 'command_started'
try {
  [Console]::Error.WriteLine(('DESK_METADATA_RUNTIME:{0}:{1}' -f $PSVersionTable.PSEdition, $PSVersionTable.PSVersion.ToString()))
} catch { [Console]::Error.WriteLine('DESK_METADATA_RUNTIME:unavailable') }
$tokens = $null; $errors = $null
$program = [Console]::In.ReadToEnd()
Write-MetadataStage 'input_read'
$ast = [Management.Automation.Language.Parser]::ParseInput($program, [ref]$tokens, [ref]$errors)
Write-MetadataStage 'parsed'
$setup = @($ast.EndBlock.Statements | Where-Object { $_ -is [Management.Automation.Language.TryStatementAst] })
$rows = @()
foreach ($name in @('Define-Native', 'Build-Layout', 'Build-RenameBuffer', 'Refuse', 'Close-Entry', 'Read-Entry', 'Valid-Entry', 'Same-Entry')) {
  $definitions = @($ast.EndBlock.Statements | Where-Object {
    $_ -is [Management.Automation.Language.FunctionDefinitionAst] -and $_.Name -ceq $name })
  $rows += @{ name = $name; scriptScoped = $definitions.Count -eq 1
    beforeSetup = $definitions.Count -eq 1 -and $setup.Count -eq 1 -and $definitions[0].Extent.EndOffset -lt $setup[0].Extent.StartOffset }
}
Write-MetadataStage 'helpers_checked'
[Console]::WriteLine((@{ parseErrors = $errors.Count; helpers = $rows } | ConvertTo-Json -Depth 5 -Compress))
Write-MetadataStage 'report_written'
`
  const program = await capturedProgram(), wallStart = Date.now(), started = performance.now()
  const parsed = spawnSync(parserExecutable(), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
    { input: program, encoding: "utf8", env: process.env, timeout: 5000 })
  const monotonicMs = performance.now() - started, wallEnd = Date.now()
  if (process.platform !== "win32" && parsed.error?.code === "ENOENT") return t.skip("PowerShell parser unavailable; not native Windows proof")
  const phases = observeMetadataStages(parsed.stderr ?? "", { wallStart, wallEnd, monotonicMs })
  const diagnostic = {
    scope: "managed_metadata_only_not_native_performance_or_Windows_ABI",
    programSha256: createHash("sha256").update(program).digest("hex"),
    wrapperSha256: createHash("sha256").update(script).digest("hex"),
    timeoutMs: 5000, elapsedMs: Math.round(monotonicMs),
    error: parsed.error?.code ?? null, status: parsed.status, signal: parsed.signal,
    pid: Number.isSafeInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
    stdoutBytes: Buffer.byteLength(parsed.stdout ?? ""), stderrBytes: Buffer.byteLength(parsed.stderr ?? ""), ...phases,
  }
  const failureMessage = "PowerShell metadata control failed: " + JSON.stringify(diagnostic)
  if (parsed.status !== 0 || parsed.error) t.diagnostic(JSON.stringify(diagnostic))
  assert.equal(parsed.status, 0, failureMessage)
  assert.equal(parsed.error?.code, undefined, failureMessage)
  assert.equal(phases.unrecognizedLines, 0, "metadata parser emitted unexpected stderr")
  assert.deepEqual(phases.stages, ["command_started", "input_read", "parsed", "helpers_checked", "report_written"])
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
