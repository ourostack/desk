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
import { observeIdentity, decodeFileIdInfo, identityArtifactPath } from "./_windows_archive_identity.mjs"

const source = "C:\\owned\\PRIVATE_SOURCE"
const volumeHex = "8877665544332211"
const fileIdHex = "08070605040302011020304050607080"
const nodeStat = { dev: 0x55667788n, ino: 0x0102030405060708n, mode: 0o40755n }
const admittedIdentity = `${nodeStat.dev}:${nodeStat.ino}:16384`
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

async function fixture(record) {
  record.fixtureStage = "runtime_check"
  assert.equal(process.versions.node, "24.18.0", "finite source-contract fixture requires Node 24.18.0")
  record.fixtureStage = "temp_root"
  const base = await mkTempRoot("desk-identity-observation-"), root = path.join(base, "身份's & $(data)")
  record.fixtureStage = "root_mkdir"
  await fs.mkdir(root)
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
  const reference = await fs.open(path.join(src, "task.md"), "r")
  const referenceMatches = async () => {
    const buffer = Buffer.alloc(32)
    const result = await reference.read(buffer, 0, buffer.length, 0)
    return result.bytesRead === 32 && buffer.equals(marker)
  }
  return { root, src, marker, reference, referenceMatches, prepared,
    admission: prepared.snapshot.get("").identity, node }
}
function actualCell(name, body) {
  test(`actual Windows: ${name}`, { skip: process.platform !== "win32", timeout: 20000 }, async () => {
    const record = { name, platform: process.platform, node: process.versions.node,
      replacementPhaseBegunAtBaseline: false, receipt: null,
      fixtureFacts: { nodeReferenceAcquired: false, nodeReferenceClosed: null },
      casePersistenceAttempted: false, casePersistenceCompleted: false, outcome: "incomplete" }
    actual.push(record)
    let f, failure
    try {
      f = await fixture(record)
      record.fixtureFacts.nodeReferenceAcquired = true
      await body(f, record)
    } catch (error) {
      record.receipt ??= error.identityReceipt ?? null
      record.outcome = "failed"
      record.errorPhase = error.identityReceipt ? "native_session" : "fixture"
      record.firstFailureStage = record.fixtureStage
      record.errorCode = ["ENOENT", "EPERM", "EACCES", "ERR_ASSERTION", "IDENTITY_OBSERVATION"].includes(error.code) ? error.code : "unavailable"
      failure = new Error(`Identity observation fixture failed (${record.errorCode}); partial safe receipt retained`)
    } finally {
      if (f) {
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
      record.fixtureFacts.originalReferenceMatchesMarker = await f.referenceMatches()
      assert.equal(record.fixtureFacts.originalReferenceMatchesMarker, true)
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
  const alias = path.join(f.root, "root-alias")
  // A sibling alias avoids recursively aliasing its own parent.
  const physical = path.join(f.root, "physical")
  record.fixtureStage = "alias_physical_mkdir"
  await fs.mkdir(physical)
  record.fixtureStage = "alias_source_rename"
  await fs.rename(f.src, path.join(physical, "source"))
  record.fixtureStage = "alias_junction_create"
  await fs.symlink(physical, alias, "junction")
  const logicalSource = path.join(alias, "source"), physicalSource = path.join(physical, "source")
  record.fixtureStage = "alias_archive_mkdir"
  await fs.mkdir(path.join(physical, "_archive"))
  record.fixtureStage = "alias_prepare"
  const prepared = await prepareArchiveState({ effectiveRoot: alias, srcDir: logicalSource,
    archiveDir: path.join(alias, "_archive", "source"), srcFile: path.join(logicalSource, "task.md"), spawnGit: spawnSync })
  const admission = prepared.snapshot.get("").identity
  record.fixtureStage = "alias_lstat"
  record.fixtureFacts.aliasConstructed = (await fs.lstat(alias)).isSymbolicLink()
  assert.equal(record.fixtureFacts.aliasConstructed, true)
  record.fixtureStage = "native_observation"
  record.receipt = await observeIdentity({ source: logicalSource,
    nodeBaseline: await fs.lstat(logicalSource, { bigint: true }), admittedIdentity: admission }, async session => {
    await prepared.atUse()
    assert.equal(await f.referenceMatches(), true)
    const a = await session.observe(physicalSource, "physical", await fs.lstat(physicalSource, { bigint: true }), admission)
    const b = await session.observe(logicalSource, "alias", await fs.lstat(logicalSource, { bigint: true }), admission)
    assert.equal(a.sameAsBaseline, true)
    assert.equal(b.sameAsBaseline, true)
    assert.equal(a.reparse, false)
    assert.equal(b.reparse, false)
    assert.equal(a.nodeTupleMatchesAdmission, true)
    assert.equal(b.nodeTupleMatchesAdmission, true)
    record.fixtureFacts.originalReferenceMatchesMarker = true
  })
})

actualCell("sequential rename preserves held native baseline while the old name disappears", async (f, record) => {
  await observeActual(f, record, async session => {
    const moved = path.join(f.root, "renamed-original")
    await fs.rename(f.src, moved)
    await assert.rejects(fs.lstat(f.src), { code: "ENOENT" })
    const absent = await session.observe(f.src, "old_name", null)
    assert.equal(absent.openSuccess, false)
    assert.ok([2, 3].includes(absent.openError))
    const found = await session.observe(moved, "new_name", await fs.lstat(moved, { bigint: true }), f.admission)
    assert.equal(found.sameAsBaseline, true)
    record.fixtureFacts.originalReferenceSurvivesRename = await f.referenceMatches()
    assert.equal(record.fixtureFacts.originalReferenceSurvivesRename, true)
  })
})

actualCell("replacement is distinct from the retained original and rejected by real admission", async (f, record) => {
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
    await assert.rejects(f.prepared.atUse())
    record.fixtureFacts.realAdmissionRejectedReplacement = true
    record.fixtureFacts.originalReferenceSurvivesReplacement = await f.referenceMatches()
    record.fixtureFacts.oldNameContainsIndependentReplacement = (await fs.readFile(path.join(f.src, "task.md"))).equals(replacement)
    assert.equal(record.fixtureFacts.originalReferenceSurvivesReplacement, true)
    assert.equal(record.fixtureFacts.oldNameContainsIndependentReplacement, true)
  })
})

actualCell("final-component reparse is observed without following it to its target", async (f, record) => {
  const link = path.join(f.root, "source-link")
  await fs.symlink(f.src, link, "junction")
  assert.equal((await fs.lstat(link)).isSymbolicLink(), true)
  record.fixtureFacts.reparseConstructed = true
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
