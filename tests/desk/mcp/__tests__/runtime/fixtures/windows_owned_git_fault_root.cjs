"use strict"
// Class B only: explicit test Root, never an installed production shim.
// A real retained-root assignment/authentication is required before the fault.
const crypto = require("node:crypto")
const net = require("node:net")
const fs = require("node:fs")
const path = require("node:path")

function fixtureError() { throw new Error("fixture_control") }
function exact(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== names.length || names.some((n) => !Object.hasOwn(value, n))) fixtureError()
}
function decimal64(value) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > 18446744073709551615n) fixtureError()
  return BigInt(value)
}
function validatePeerObservation(value) {
  if (value?.schema!=="desk.owned-git-test-peer/1") fixtureError()
  if (value.type==="ROOT_LIVE") {
    exact(value,["schema","type","generation","preparationDigest"])
    if (![value.generation,value.preparationDigest].every((v) => typeof v==="string" && /^[a-f0-9]{64}$/.test(v))) fixtureError()
  } else if (value.type==="NODE_PRESSURE") {
    exact(value,["schema","type","submittedBytes","bufferedBytes","needDrain","kernelCredit"])
    if (value.kernelCredit!==false || typeof value.needDrain!=="boolean" ||
      ![value.submittedBytes,value.bufferedBytes].every((v) => Number.isSafeInteger(v)&&v>=0&&v<=1048576)) fixtureError()
  } else fixtureError()
  return structuredClone(value)
}
function createNodePressurePump({stream,deadline,report,onError}) {
  const block=Buffer.alloc(16384,120)
  let left=1048576, started=false, released=false, reported=false, failed=false
  function live() { if (failed || process.hrtime.bigint()>=deadline.expiresNs) fixtureError() }
  function metrics() {
    if (reported) return
    reported=true
    report(validatePeerObservation({schema:"desk.owned-git-test-peer/1",type:"NODE_PRESSURE",
      submittedBytes:1048576-left,bufferedBytes:stream.writableLength,needDrain:stream.writableNeedDrain,kernelCredit:false}))
  }
  function pump() {
    try {
      while (left>0) {
        live(); left-=block.length
        if (!stream.write(block)) { metrics(); stream.once("drain",pump); return }
      }
      metrics()
    } catch { failed=true; onError() }
  }
  return {
    start() { live(); if (started) fixtureError(); started=true; stream.cork(); pump() },
    release() { live(); if (!started || !reported || released) fixtureError(); released=true; stream.uncork() },
  }
}
function createPostResultGate({ core, deadline, fault }) {
  let final = false, written = false, eof = false, stopped = false, cue = ""
  function live() {
    if (stopped || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) { stopped = true; fixtureError() }
  }
  function maybe() { if (final && written && eof) { stopped = true; fault() } }
  return {
    result(value) {
      live()
      if (final) fixtureError()
      const encoded = Buffer.from(JSON.stringify(value), "ascii").toString("base64")
      const checked = core.decodeResult(encoded)
      if (checked.command.state !== "exited" || checked.command.code !== 0 || checked.command.signal !== null ||
        checked.input.state !== "complete") fixtureError()
      final = true; return encoded
    },
    writeCompleted(error) { live(); if (!final || written || error) { stopped = true; fixtureError() }; written = true; maybe() },
    cue(bytes) {
      live()
      if (!final || eof || !Buffer.isBuffer(bytes) || cue.length + bytes.length > 8) { stopped = true; fixtureError() }
      cue += bytes.toString("ascii")
      if (!"RELEASE\n".startsWith(cue)) { stopped = true; fixtureError() }
    },
    cueEnd() { live(); if (eof || cue !== "RELEASE\n") { stopped = true; fixtureError() }; eof = true; maybe() },
  }
}
function createClockCompanion({ core, deadline, now = process.hrtime.bigint }) {
  let index = 0, before = null, stopped = false
  const schema = "desk.owned-git-clock-companion/1"
  return { accept(value) {
    if (stopped || now === null) fixtureError()
    try {
      if (value.type === "FINISH") {
        exact(value, ["schema", "type"])
        if (value.schema !== schema || index !== 64 || before !== null || !core.remainingNanoseconds(deadline, now())) fixtureError()
        stopped = true; return { schema, type: "FINISHED", samples: index }
      }
      if (value.type === "BEGIN") {
        exact(value, ["schema", "type", "index"])
        if (value.schema !== schema || before !== null || value.index !== index || index >= 64) fixtureError()
        before = now()
        if (!core.remainingNanoseconds(deadline, before)) fixtureError()
        return { schema, type: "SAMPLE_READY", index, beforeNs: before.toString() }
      }
      exact(value, ["schema", "type", "index", "q", "f", "converted", "edge"])
      if (value.schema !== schema || value.type !== "SAMPLE_VALUE" || before === null || value.index !== index) fixtureError()
      const after = now(), q = decimal64(value.q), f = decimal64(value.f)
      decimal64(value.converted); decimal64(value.edge)
      if (!q || !f || after < before || !core.remainingNanoseconds(deadline, after)) fixtureError()
      const accepted = core.mirrorWindowsHrtime(value.q, value.f).toString() === value.converted &&
        core.mirrorWindowsHrtime((q + 1n).toString(), value.f).toString() === value.edge &&
        core.mirrorWindowsHrtime((q - 1n).toString(), value.f) <= after &&
        BigInt(value.edge) >= before && BigInt(value.edge) < deadline.expiresNs
      const row = { schema, type: "CLOCK_ROW", index: index++, q: value.q, f: value.f,
        converted: value.converted, edge: value.edge, beforeNs: before.toString(), afterNs: after.toString(),
        deadlineNs: deadline.expiresNs.toString(), accepted, modeled: false, origin: "root-companion" }
      before = null; return row
    } catch (error) { stopped = true; throw error }
  } }
}
function validateFixtureEvent(value) {
  const bool = (v) => { if (typeof v !== "boolean") fixtureError() }
  const number = (v, max) => { if (!Number.isSafeInteger(v) || v < 0 || v > max) fixtureError() }
  if (value?.schema !== "desk.owned-git-fixture-event/1") fixtureError()
  const common = ["schema", "type"]
  if (value.type === "ENTRY_RESULT") {
    exact(value, [...common, "creationCalls", "ownerFreed", "expiredBeforeEntry", "deadlineInputModeled", "clockModeled", "deadlineNs"])
    number(value.creationCalls, 1); decimal64(value.deadlineNs)
    for (const key of ["ownerFreed", "expiredBeforeEntry", "deadlineInputModeled", "clockModeled"]) bool(value[key])
  } else if (value.type === "CLOSED") {
    exact(value, [...common, "requests", "creationCalls", "ownerFreed", "telemetryGap", "deadlineNs"])
    number(value.requests, 128); number(value.creationCalls, 1)
    bool(value.ownerFreed); bool(value.telemetryGap); decimal64(value.deadlineNs)
  } else if (value.type === "CLOCK" || value.type === "SCALAR") {
    exact(value, [...common, "index", "q", "f", "converted", ...(value.type === "CLOCK" ? ["edge"] : []), "accepted", "modeled"])
    number(value.index, value.type === "CLOCK" ? 63 : 7); decimal64(value.q); decimal64(value.f)
    bool(value.accepted); bool(value.modeled)
    if (value.modeled !== (value.type === "SCALAR")) fixtureError()
    if (value.converted !== null) decimal64(value.converted)
    if (value.accepted !== (value.converted !== null)) fixtureError()
    if (value.type === "CLOCK") {
      if (!value.accepted || value.q === "0" || value.f === "0") fixtureError()
      decimal64(value.edge)
    }
  } else if (value.type === "VECTORS" || value.type === "IO") {
    const io = value.type === "IO"
    exact(value, [...common, io ? "checks" : "bits", "checksPassed", ...(io ? ["syntheticEOF"] : []), "kernelCredit"])
    const bits = io ? value.checks : value.bits
    if (!Array.isArray(bits) || bits.length !== (io ? 8 : 5) || value.kernelCredit !== false ||
      (io && value.syntheticEOF !== false)) fixtureError()
    bits.forEach(bool); number(value.checksPassed, bits.length)
    const expected = io ? [true,true,true,true,true,true,true,true] : [true,true,false,false,false]
    if (bits.filter((bit, i) => bit === expected[i]).length !== value.checksPassed) fixtureError()
  } else if (value.type === "STATE") {
    const flags = ["ownerCaptured", "created", "assigned", "resumed", "startIssued", "rootRetiredReported",
      "privateZeroReported", "assignmentModeled", "resumeModeled", "membershipModeled", "queryModeled",
      "rootWaitModeled", "clockModeled", "authMutated", "ioRouteInstrumented", "pendingRead", "pendingWrite",
      "cancelReadRequested", "cancelWriteRequested", "readReaped", "writeReaped", "storageRetained", "telemetryGap"]
    exact(value, [...common, "phase", "mode", ...flags, "rootLiveActual", "anyJobMemberActual", "rootEOFAtNs", "extraHandlesPeak", "deadlineNs"])
    if (!["FINAL","TEARDOWN","CREATED_SUSPENDED","ASSIGNED_SUSPENDED","SERVER_CLOSED","ROOT_LIVE",
      "CLOCK_REFUSAL","OBSERVER_PENDING","BEFORE_NATIVE_START","OBSERVE"].includes(value.phase) ||
      !["O02","O03","O05","O06","O07","C03","C04","C05","C06","C07","C08","C09","C10","C11",
        "C12","C13","C14","C15","C16","C17","C18"].includes(value.mode)) fixtureError()
    flags.forEach((key) => bool(value[key]))
    for (const key of ["rootLiveActual", "anyJobMemberActual"]) if (value[key] !== null) bool(value[key])
    if (value.rootEOFAtNs !== null) decimal64(value.rootEOFAtNs)
    number(value.extraHandlesPeak, 64); decimal64(value.deadlineNs)
  } else fixtureError()
  return structuredClone(value)
}
function createFixtureControlDecoder({ core, onFrame }) {
  const storage = Buffer.alloc(4100)
  let used = 0, target = 4, stopped = false, count = 0
  return {
    push(bytes) {
      if (stopped || !Buffer.isBuffer(bytes) || bytes.length > 1048576) fixtureError()
      let at = 0
      try {
        while (at < bytes.length) {
          const n = Math.min(target - used, bytes.length - at)
          bytes.copy(storage, used, at, at + n); used += n; at += n
          if (used !== target) continue
          if (target === 4) {
            const length = storage.readUInt32LE()
            if (!length || length > 4096) fixtureError()
            target = length + 4
          } else {
            if (++count > 256) fixtureError()
            onFrame(core.parseJSON(storage.subarray(4, target), 4096)); used = 0; target = 4
          }
        }
      } catch (error) { stopped = true; throw error }
    },
    end() { if (stopped || used) fixtureError(); stopped = true },
  }
}
function createFixtureResultPipeline({ core, stream, expectedBytes, deadline, emit }) {
  const gate = core.createResultGate({ sendResult: emit, inputTracker: null })
  const tracker = core.createFinalInputTracker({ stream, expectedBytes, deadline,
    onSettled: (value) => gate.inputSettled(value) })
  return {
    commandClosed: (v) => gate.commandClosed(v),
    recordSubmitted: (n, error) => tracker.recordSubmitted(n, error),
    commandExit: () => tracker.onCommandExit(),
    input: () => tracker.result(),
  }
}
function runFixtureCommand({ payload, deadline, core, spawnGit, send }) {
  let child, spawnError
  try {
    child = spawnGit(payload.executable, payload.args, { cwd: payload.cwd, env: payload.env, windowsHide: true,
      stdio: [payload.stdin === null ? "ignore" : "pipe", "inherit", "inherit"] })
  } catch (error) {
    const gate = core.createResultGate({ sendResult: send, inputTracker: null })
    gate.inputSettled({
      state: payload.stdin === null ? "complete" : "failed", expectedBytes: payload.stdin?.length ?? 0,
      submittedBytes: 0, errorCode: payload.stdin === null ? null : "SPAWN_FAILED",
    })
    gate.commandClosed({ spawnError: error })
    return null
  }
  const pipeline = createFixtureResultPipeline({ core, stream: child.stdin,
    expectedBytes: payload.stdin?.length ?? 0, deadline, emit: send })
  child.on("error", (error) => { spawnError = error })
  child.once("exit", pipeline.commandExit)
  child.once("close", (code, signal) => { pipeline.commandExit(); pipeline.commandClosed({ code, signal, spawnError }) })
  if (child.stdin) {
    child.stdin.write(payload.stdin, (error) => pipeline.recordSubmitted(payload.stdin.length, error))
    child.stdin.end()
  }
  return child
}

function startFaultRoot() {
  if (process.platform !== "win32") throw new Error("fault_fixture_bootstrap")
  // Only the CLI loads the constructor-declared staged Core, never a payload module.
  const core = require(path.join(__dirname, "../mcp/scripts/owned-git-child.cjs"))
  const variant = path.basename(__filename, ".cjs")
  if (variant === "clock-companion") return runClockCompanion(core)
  const modes = ["wrong-pid-delay", "malformed", "replay-result", "trailing", "partial-header",
    "partial-body", "oversized", "eof-before-result", "pressure", "normal"]
  if (!modes.includes(variant) || process.argv.length !== 3 || process.argv[2] !== "--owned-root") throw new Error("fault_fixture_bootstrap")
  const binding = { generation: process.env.DESK_OWNED_GIT_GENERATION,
    preparationDigest: process.env.DESK_OWNED_GIT_PREPARATION_DIGEST, payloadDigest: null }
  const deadline = { clock: process.env.DESK_OWNED_GIT_CLOCK, expiresNs: BigInt(process.env.DESK_OWNED_GIT_DEADLINE_NS) }
  const nonce = crypto.randomBytes(32).toString("hex")
  const state = core.createRootState(binding, nonce, process.env.DESK_OWNED_GIT_CAPABILITY)
  const endpoint = process.env.DESK_OWNED_GIT_ENDPOINT
  if (!/^\\\\\.\\pipe\\desk-owned-git-[0-9a-f]{64}$/.test(endpoint)) throw new Error("fault_fixture_bootstrap")
  const socket = new net.Socket()
  for (const name of Object.keys(process.env)) if (/^DESK_OWNED_GIT_/i.test(name)) delete process.env[name]
  const writer = core.createFrameWriter(socket, () => socket.destroy())
  const decoder = core.createFrameDecoder({ role: "owner", binding, phase: "hello" })
  const send = (type, extra = {}) => writer.send({ protocol: "desk.owned-git/1", role: "root", type, ...binding, ...extra })
  let configured, resultB64, resultWritten = false, release, failed = false, releaseGate
  const stop = () => { failed = true; socket.destroy(); release?.destroy(); process.exitCode = 1 }
  function faultAfterObservedResult() {
    if (failed || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) return stop()
    if (variant === "normal") return writer.finish()
    // Parent writes RELEASE only after the actual owner RESULT observation.
    release = net.createConnection({ path: `\\\\.\\pipe\\desk-owned-git-fixture-${binding.generation}` })
    release.on("error", stop)
    release.on("data", (chunk) => {
      try { releaseGate.cue(chunk) } catch { stop() }
    })
    release.on("end", () => { try { releaseGate.cueEnd(); release.end() } catch { stop() } })
  }
  function injectFault() {
      if (variant === "replay-result") return socket.end(core.encodeFrame({
        protocol: "desk.owned-git/1", role: "root", type: "RESULT", ...binding, resultB64,
      }))
      const bytes = variant === "malformed" ? Buffer.from([1, 0, 0, 0, 123])
        : variant === "trailing" ? Buffer.from([1])
        : variant === "partial-header" ? Buffer.from([8, 0])
        : variant === "partial-body" ? Buffer.from([8, 0, 0, 0, 123])
        : variant === "oversized" ? Buffer.from([253, 63, 0, 0, 123]) : null
      if (!bytes) return stop()
      socket.end(bytes)
  }
  const timer = setTimeout(stop, Number(core.remainingNanoseconds(deadline, process.hrtime.bigint()) / 1000000n))
  socket.once("close", () => { clearTimeout(timer); release?.destroy(); state.close() })
  socket.once("connect", () => writer.send(state.hello()))
  socket.on("error", () => { process.exitCode = 1 })
  socket.on("data", (bytes) => {
    try {
      for (const value of decoder.push(bytes)) {
        const action = state.accept(value)
        if (action === "send_ack") {
          send("ACK", { clientNonce: nonce })
          if (variant === "pressure") {
            const pressure=createNodePressurePump({stream:socket,deadline,onError:stop,report(metrics) {
              release = net.createConnection({ path: `\\\\.\\pipe\\desk-owned-git-fixture-${binding.generation}` })
              release.on("error", stop)
              release.once("connect", () => release.end(JSON.stringify(metrics)))
              release.once("end",() => { try { pressure.release() } catch { stop() } })
            }})
            pressure.start()
          }
        }
        else if (action === "read_payload") {
          const size = fs.statSync(value.path).size
          if (size <= 0 || size > 1048576) throw new Error("fault_fixture_payload")
          configured = core.parsePayloadBytes(fs.readFileSync(value.path), value.payloadDigest)
          binding.payloadDigest = value.payloadDigest; state.configured(); send("CONFIGURED")
        } else if (action === "start") {
          if (variant === "eof-before-result") { socket.end(); continue }
          runFixtureCommand({ payload: configured, deadline, core, spawnGit: require("node:child_process").spawn,
            send(final) {
              if (failed || resultWritten) return stop()
              resultWritten = true
              releaseGate = createPostResultGate({ core, deadline, fault: injectFault })
              resultB64 = releaseGate.result(final)
              // Retain genuine bytes; the injected suffix cannot replace RESULT.
              const encoded = core.encodeFrame({ protocol: "desk.owned-git/1", role: "root", type: "RESULT", ...binding, resultB64 })
              socket.write(encoded, (error) => {
                try {
                  releaseGate.writeCompleted(error)
                  if (variant === "normal") writer.finish()
                  else faultAfterObservedResult()
                } catch { stop() }
              })
            } })
        }
      }
    } catch { socket.destroy(); process.exitCode = 1 }
  })
  socket.on("end", () => { try { decoder.end() } catch { process.exitCode = 1 } })
  if (variant === "wrong-pid-delay") {
    release=net.createConnection({path:`\\\\.\\pipe\\desk-owned-git-fixture-${binding.generation}`})
    release.on("error",stop)
    release.once("connect",() => release.end(JSON.stringify(validatePeerObservation({
      schema:"desk.owned-git-test-peer/1",type:"ROOT_LIVE",generation:binding.generation,preparationDigest:binding.preparationDigest }))))
    release.once("close",() => {
      if (!failed && core.remainingNanoseconds(deadline,process.hrtime.bigint()))
        setTimeout(() => { if (!failed && core.remainingNanoseconds(deadline,process.hrtime.bigint())) socket.connect({path:endpoint}) },100)
    })
  }
  else socket.connect({ path: endpoint })
}
function runClockCompanion(core) {
  const deadline = { clock: "win-qpc-ns/1", expiresNs: BigInt(process.env.DESK_TEST_OWNED_GIT_D) }
  if (process.argv.length !== 2 || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fixtureError()
  const socket = new net.Socket({ fd: 3, readable: true, writable: true }), protocol = createClockCompanion({ core, deadline })
  let pending = false, finished = false
  const stop = () => { process.exitCode = 1; socket.destroy() }
  const decoder = createFixtureControlDecoder({ core, onFrame(value) {
    if (pending || finished) return stop()
    try {
      const response = protocol.accept(value), text = JSON.stringify(response), size = Buffer.byteLength(text)
      if (size > 4096) return stop()
      const buffer = Buffer.alloc(size + 4); buffer.writeUInt32LE(size); buffer.write(text, 4)
      pending = true; finished = response.type === "FINISHED"
      socket.write(buffer, (error) => { pending = false; if (error) stop(); else if (finished) socket.end() })
    } catch { stop() }
  } })
  const timer = setTimeout(stop, Math.max(0, Number(core.remainingNanoseconds(deadline, process.hrtime.bigint()) / 1000000n)))
  socket.on("data", (bytes) => { try { decoder.push(bytes) } catch { stop() } })
  socket.on("error", stop)
  socket.on("end", () => { try { decoder.end(); if (!finished) stop() } catch { stop() } })
  socket.on("close", () => clearTimeout(timer))
}
module.exports = { createFixtureResultPipeline, runFixtureCommand, createPostResultGate, createClockCompanion,
  createFixtureControlDecoder, validateFixtureEvent, validatePeerObservation, createNodePressurePump }
if (require.main === module) {
  try { startFaultRoot() } catch { process.exitCode = 1 }
}
