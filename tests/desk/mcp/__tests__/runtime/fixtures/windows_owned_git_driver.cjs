"use strict"
// Pre-adapter component harness. No operation records, lease facade or restoration.
const core = require("../../../../../../plugins/desk/mcp/scripts/owned-git-child.cjs")
const { pathToFileURL } = require("node:url")
const path = require("node:path")
const { spawn } = require("node:child_process")
const crypto = require("node:crypto")
const fs = require("node:fs")
const net = require("node:net")
const fixtureProtocol = require("./windows_owned_git_fault_root.cjs")

function fail() { throw new Error("component_protocol") }
function validateClockReady(frame, deadline, beforeNs, afterNs) {
  core.encodeFrame(frame)
  if (frame.type !== "CLOCK_READY" || frame.clock !== deadline.clock ||
    frame.deadlineNs !== deadline.expiresNs.toString() || beforeNs > afterNs ||
    !core.remainingNanoseconds(deadline, afterNs)) fail()
  const q = BigInt(frame.qpcTicks)
  if (q === 0n || q >= 18446744073709551615n ||
    core.mirrorWindowsHrtime(frame.qpcTicks, frame.qpcFrequency).toString() !== frame.nowNs) fail()
  const low = core.mirrorWindowsHrtime((q - 1n).toString(), frame.qpcFrequency)
  const high = core.mirrorWindowsHrtime((q + 1n).toString(), frame.qpcFrequency)
  if (low > afterNs || high < beforeNs || high >= deadline.expiresNs) fail()
  return true
}
function createDriverPolicy({ outputLimit } = {}) { return Object.freeze({ outputLimit: core.normalizeOutputLimit(outputLimit) }) }
function createDataObservations({ outputLimit } = {}) {
  const policy = createDriverPolicy({ outputLimit })
  const streams = { stdout: { ended: false, closed: false, failed: false }, stderr: { ended: false, closed: false, failed: false } }
  let bytes = 0, overflowed = false
  const counts = { stdout: 0, stderr: 0 }
  const edge = (name) => { if (!Object.hasOwn(streams, name)) fail(); return streams[name] }
  return {
    chunk(name, chunk) {
      const state = edge(name)
      if (!Buffer.isBuffer(chunk) || state.ended || state.closed || bytes + chunk.length > Number.MAX_SAFE_INTEGER) fail()
      bytes += chunk.length
      counts[name] += chunk.length
      overflowed ||= bytes > policy.outputLimit
    },
    end(name) { edge(name).ended = true },
    close(name) { edge(name).closed = true },
    error(name) { edge(name).failed = true },
    snapshot() { return { bytes, overflowed,
      dataComplete: Object.values(streams).every((v) => v.ended && v.closed && !v.failed) } },
    details: () => ({ ...counts }),
  }
}
function createObservations(binding, expectedBytes, { withholdCertificate = false } = {}) {
  const value = { ownerExited: false, ownerClosed: false, controlEOF: false, controlComplete: false, result: null, certificate: null }
  let ended = false, rejected = false, resultB64 = null
  return {
    owner(frame) {
      try {
        if (ended || rejected) fail()
        core.encodeFrame(frame)
        if (frame.role !== "owner" || frame.generation !== binding.generation || frame.preparationDigest !== binding.preparationDigest) fail()
        const pendingTerminal = frame.type === "TERMINAL" && binding.payloadDigest === null &&
          (frame.payloadDigest === null || frame.payloadDigest === binding.proposedPayloadDigest)
        if (!pendingTerminal && frame.payloadDigest !== binding.payloadDigest) fail()
        if (frame.type === "RESULT") {
          if (value.result) fail()
          const result = core.decodeResult(frame.resultB64)
          if (result.input.expectedBytes !== expectedBytes) fail()
          value.result = result; resultB64 = frame.resultB64
        } else if (frame.type === "CONTROL_COMPLETE") {
          if (!value.result || value.controlComplete) fail()
          value.controlComplete = true
        } else if (frame.type === "TERMINAL") {
          if (resultB64 !== null && frame.resultB64 !== resultB64) fail()
          const certificate = withholdCertificate || frame.certificate === null ? null : core.validateCertificate(frame.certificate,
            { ...binding, payloadDigest: frame.payloadDigest })
          let result = value.result
          if (frame.resultB64 !== null) {
            result = core.decodeResult(frame.resultB64)
            if (result.input.expectedBytes !== expectedBytes) fail()
          }
          value.result = result; value.certificate = certificate; resultB64 = frame.resultB64; ended = true
        } else fail()
      } catch { rejected = true; fail() }
    },
    expectInput(bytes) {
      if (value.result || !Number.isSafeInteger(bytes) || bytes < 0) fail()
      expectedBytes = bytes
    },
    controlEOF() { value.controlEOF = true },
    ownerExit() { value.ownerExited = true },
    ownerClose() { value.ownerClosed = true },
    snapshot: () => structuredClone(value),
  }
}
function createWire({ stream, binding, deadline, fragment = false, onFrame = () => {}, onError = () => {} }) {
  const phase = { current: "preparing" }
  const decoder = core.createFrameDecoder({ role: "owner", binding, phase })
  let closed = false, stopped = false, failed = false
  let bytesRead = 0, bytesWritten = 0, pushes = 0, processingNs = 0n
  const sent = new Set()
  const reject = () => {
    if (failed) return
    failed = true; stopped = true
    onError(new Error("component_protocol"))
  }
  const writer = core.createFrameWriter({ write(buffer, callback) {
    let at = 0
    const write = () => {
      if (failed || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) { reject(); callback(new Error("deadline")); return }
      const chunk = fragment ? buffer.subarray(at, at+1) : buffer
      stream.write(chunk, (error) => {
        if (error) { callback(error); return }
        bytesWritten += chunk.length; at += chunk.length
        if (at===buffer.length) callback()
        else queueMicrotask(write)
      })
    }
    write()
  } }, reject)
  stream.on("data", (bytes) => {
    bytesRead += bytes.length
    if (failed || closed) return
    const started = process.hrtime.bigint()
    try {
      if (!Buffer.isBuffer(bytes) || bytesRead>1048576) fail()
      // Deliver each completed frame before parsing later authority. Byte views
      // use the existing decoder without adding a second frame-length parser.
      for (let at = 0; at < bytes.length && !failed; at++) {
        if (!core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
        pushes++
        for (const value of decoder.push(bytes.subarray(at, at + 1))) {
          if (value.type === "CONFIGURED") binding.payloadDigest = value.payloadDigest
          else if (value.type === "TERMINAL") stopped = true
          onFrame(value)
        }
      }
    } catch { reject() } finally { processingNs += process.hrtime.bigint()-started }
  })
  stream.on("end", () => { closed = true; if (!failed) { try { decoder.end() } catch { reject() } } })
  stream.on("error", reject)
  return {
    send(value) {
      try {
        if (closed || stopped || failed || !core.remainingNanoseconds(deadline, process.hrtime.bigint()) ||
          value.role !== "parent" || value.generation !== binding.generation ||
          value.preparationDigest !== binding.preparationDigest) fail()
        core.encodeFrame(value)
        if (value.type === "CONFIG") {
          if (phase.current !== "ready" || binding.proposedPayloadDigest) fail()
          binding.proposedPayloadDigest = value.payloadDigest; phase.current = "configuring"
        } else if (value.type === "CANCEL") {
          if (value.payloadDigest !== (binding.proposedPayloadDigest ?? binding.payloadDigest)) fail()
          stopped = true
        } else {
          if (value.payloadDigest !== binding.payloadDigest) fail()
          if (value.type === "START") { if (phase.current !== "configured") fail(); phase.current = "running" }
          else if (value.type === "CLOCK_ACCEPT") {
            if (phase.current !== "clock_ready" || value.clock !== deadline.clock ||
              value.deadlineNs !== deadline.expiresNs.toString()) fail()
            phase.current = "clock_accepted"
          } else if (value.type === "SEAL") { if (phase.current !== "complete") fail(); stopped = true }
          else if (value.type !== "PREPARE" || phase.current !== "preparing") fail()
        }
        writer.send(value)
        if (failed) fail()
        sent.add(value.type)
      } catch { reject(); fail() }
    },
    expire: reject,
    snapshot: () => ({ bytesRead, bytesWritten, pushes, processingNs:processingNs.toString(), sent:[...sent], failed }),
  }
}
function stagePayloadFile({ payload, payloadPath, expectedPath, deadline = null }) {
  const live = () => { if (deadline && !core.remainingNanoseconds(deadline,process.hrtime.bigint())) fail() }
  live()
  if (payloadPath !== expectedPath) fail()
  const encoded = core.encodePayload(payload)
  live()
  try {
    const fd = fs.openSync(payloadPath, "r+")
    try {
      if (!fs.fstatSync(fd).isFile()) fail()
      fs.ftruncateSync(fd, 0)
      let offset = 0
      while (offset < encoded.bytes.length) {
        live()
        const count = fs.writeSync(fd, encoded.bytes, offset, Math.min(65536,encoded.bytes.length - offset))
        if (!count) fail()
        offset += count
      }
    } finally { fs.closeSync(fd) }
  } catch { throw new Error("component_payload") }
  live()
  return { payloadDigest: encoded.payloadDigest, expectedBytes: payload.stdin?.length ?? 0 }
}
async function launchComponent({ publicMcpRoot, privateRealmRoot, nodeExecutable, prepareBinding, deadline, outputLimit,
  fragment = false, pipeSuffix = null, isCancelled = () => false, onLaunched = () => {}, onFrame, onError = () => {} }) {
  // Source-only now: actual invocation requires a separately admitted native gate.
  if (process.platform !== "win32" || privateRealmRoot !== prepareBinding.privateRealmRoot) fail()
  const verify = await import(pathToFileURL(path.resolve(__dirname, "../../../../../../plugins/desk/mcp/scripts/verify-owned-git.js")).href)
  const assets = await verify.verifyOwnedGitAssets({ publicMcpRoot, privateRealmRoot, nodeExecutable })
  if (isCancelled()) nativeFailure("producer_unjoined")
  return launchWithAssets({ assets, prepareBinding, deadline, outputLimit, fragment, pipeSuffix, onLaunched, onFrame, onError })
}
async function launchWithAssets({ assets, prepareBinding, deadline, outputLimit, onFrame, onError, faultCase = null,
  fixtureH = null, postResultFault = false, pressurePeer = false, onFixtureFrame = () => {},
  fragment = false, pipeSuffix = null, onLaunched = () => {}, preauthPeer = false, onPeerLive = () => {} }) {
  const bound = core.createPreparationBinding(prepareBinding, { publicMcpRoot: assets.publicMcpRoot,
    nodeExecutable: assets.nodeExecutable, nodeSha256: assets.nodeSha256,
    ownerSha256: assets.ownerSha256 || assets.manifest.files.owner.sha256,
    shimSha256: assets.shimSha256 || assets.manifest.files.shim.sha256 }, deadline)
  if (!core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
  const env = {}
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.DESK_OWNED_GIT_CLOCK = deadline.clock
  env.DESK_OWNED_GIT_DEADLINE_NS = deadline.expiresNs.toString()
  if (faultCase !== null) Object.assign(env, { DESK_TEST_OWNED_GIT_FAULT_CASE: faultCase,
    DESK_TEST_OWNED_GIT_D: deadline.expiresNs.toString(), DESK_TEST_OWNED_GIT_H: fixtureH.toString() })
  const release = postResultFault || pressurePeer || preauthPeer ? await createPostResultRelease({
    generation: bound.preparation.generation, preparationDigest:bound.preparationDigest, deadline,
    pressure: pressurePeer, preauth:preauthPeer, onPeerLive }) : null
  if (!core.remainingNanoseconds(deadline, process.hrtime.bigint())) { release?.stop(); fail() }
  if (pipeSuffix!==null && !/^[a-f0-9]{64}$/.test(pipeSuffix)) fail()
  let child
  try { child = spawn(assets.owner, ["--owned-git"], { env, cwd: assets.publicMcpRoot,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "overlapped", ...(faultCase === null ? [] : ["overlapped"])] }) }
  catch (error) { release?.stop(); throw error }
  const binding = { generation: bound.preparation.generation, preparationDigest: bound.preparationDigest, payloadDigest: null }
  const policy = createDriverPolicy({ outputLimit })
  const observations = createObservations(binding, 0, { withholdCertificate: faultCase?.startsWith("C15-")===true })
  const data = createDataObservations(policy)
  const fixtureBridge = faultCase === null ? null : createFixtureBridgeObserver({ stream: child.stdio[4], deadline, onFrame: onFixtureFrame,
    mode: faultCase.slice(0,3), observationEnd: fixtureH - 20000000000n, onError: () => onError(new Error("fixture_control")) })
  let beforeNs, payloadPath, payloadStaged = false, overflowCancelled = false
  const wire = createWire({ stream: child.stdio[3], binding, deadline, fragment, onFrame: (value) => {
    if (value.type === "CLOCK_READY") validateClockReady(value, deadline, beforeNs, process.hrtime.bigint())
    if (value.type === "READY") {
      if (value.payloadPath !== path.join(prepareBinding.privateRoot, "payload.json")) fail()
      payloadPath = value.payloadPath
    }
    if (["RESULT", "CONTROL_COMPLETE", "TERMINAL"].includes(value.type)) observations.owner(value)
    if (value.type === "RESULT" && postResultFault) release?.admit(value.resultB64)
    onFrame?.(value)
  }, onError: () => onError(new Error("component_io")) })
  child.on("error", () => onError(new Error("component_launch")))
  child.on("exit", () => observations.ownerExit())
  child.on("close", () => observations.ownerClose())
  child.once("close", () => { if (!pressurePeer) release?.stop() })
  child.stdio[3].on("end", () => observations.controlEOF())
  for (const name of ["stdout", "stderr"]) {
    child[name].on("data", (chunk) => {
      try {
        data.chunk(name, chunk)
        if (data.snapshot().overflowed && !overflowCancelled) {
          overflowCancelled = true
          child.stdout.pause(); child.stderr.pause()
          try { wire.send({ protocol: "desk.owned-git/1", role: "parent", type: "CANCEL", generation: binding.generation,
            preparationDigest: binding.preparationDigest, payloadDigest: binding.proposedPayloadDigest ?? binding.payloadDigest }) }
          finally { queueMicrotask(() => { child.stdout.resume(); child.stderr.resume() }) }
        }
      } catch { onError(new Error("component_data")) }
    })
    child[name].on("end", () => data.end(name))
    child[name].on("close", () => data.close(name))
    child[name].on("error", () => { data.error(name); onError(new Error("component_data")) })
  }
  const suffix = pipeSuffix || crypto.randomBytes(32).toString("hex")
  let replacement
  let wrongPeerStarted=false
  const actor = { child, wire, binding, assets, preparation: bound, observations, policy, data,
    clockBefore: () => beforeNs,
    testControl: faultCase === null ? null : child.stdio[4],
    certificatePolicy: faultCase?.startsWith("C15-") ? "permanently-withheld-model" : "source-bound-native",
    fixtureBridge, releasePostResultFault: () => { if (!release) fail(); release.release() },
    releaseClosed: release?.closed || Promise.resolve(),
    closeFixturePeer:() => release?.stop(),
    nodePressure: () => release?.metrics() || null,
    wrongPidPeer() {
      if (!preauthPeer || !release?.rootLive() || wrongPeerStarted) fail()
      wrongPeerStarted=true
      return startWrongPidPeer({endpoint:`\\\\.\\pipe\\desk-owned-git-${suffix}`,binding,deadline})
    },
    async listenReplacementServer() {
      if (!faultCase?.startsWith("C14-") || replacement ||
        fixtureBridge.snapshot().lastState?.phase !== "SERVER_CLOSED" ||
        !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
      let connected = false
      replacement = net.createServer((socket) => { connected = true; socket.destroy() })
      replacement.maxConnections = 1
      const closed = new Promise((resolve) => replacement.once("close", resolve))
      let closing=false, rejectListening=null
      const closeReplacement=() => {
        if (closing) return
        rejectListening?.(new Error("fixture_control"))
        closing=true
        replacement.close((error) => { if (error) onError(new Error("fixture_control")) })
      }
      const timer = setTimeout(() => {
        rejectListening?.(new Error("deadline")); closeReplacement()
      }, Number(core.remainingNanoseconds(deadline, process.hrtime.bigint()) / 1000000n))
      replacement.once("close", () => clearTimeout(timer))
      replacement.on("error", () => onError(new Error("fixture_control")))
      child.once("close", closeReplacement)
      await new Promise((resolve, reject) => {
        rejectListening=reject; replacement.once("error", reject)
        replacement.listen(`\\\\.\\pipe\\desk-owned-git-${suffix}`, () => {
          replacement.off("error", reject); rejectListening=null
          if (closing || !core.remainingNanoseconds(deadline,process.hrtime.bigint())) reject(new Error("deadline"))
          else resolve()
        })
      })
      return { closed, snapshot: () => ({ unexpectedClient: connected }) }
    },
    stagePayload(payload) {
      if (!payloadPath || payloadStaged || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
      payloadStaged = true
      const staged = stagePayloadFile({ payload, payloadPath, expectedPath: path.join(prepareBinding.privateRoot, "payload.json"), deadline })
      observations.expectInput(staged.expectedBytes)
      wire.send({ protocol: "desk.owned-git/1", role: "parent", type: "CONFIG", generation: binding.generation,
        preparationDigest: binding.preparationDigest, payloadDigest: staged.payloadDigest, path: payloadPath })
      return staged
    } }
  onLaunched(actor)
  beforeNs = process.hrtime.bigint()
  wire.send({ protocol: "desk.owned-git/1", role: "parent", type: "PREPARE", ...binding,
    nodeExecutable: assets.nodeExecutable, rootScript: assets.shim, neutralCwd: assets.publicMcpRoot,
    privateRoot: prepareBinding.privateRoot, pipeSuffix: suffix,
    capability: crypto.randomBytes(32).toString("hex"), clock: deadline.clock, deadlineNs: deadline.expiresNs.toString() })
  actor.beforeNs=beforeNs
  return actor
}
function startWrongPidPeer({endpoint,binding,deadline}) {
  if (!core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")
  const socket=new net.Socket(), value={rootLive:true,connected:false,closed:false,receivedBytes:0}
  let cancelled=false
  const cancel=() => { cancelled=true; socket.destroy() }
  const timer=setTimeout(cancel,Math.max(0,Number((deadline.expiresNs-process.hrtime.bigint())/1000000n)))
  socket.on("connect",() => {
    value.connected=true
    const hello={protocol:"desk.owned-git/1",role:"root",type:"HELLO",generation:binding.generation,
      preparationDigest:binding.preparationDigest,payloadDigest:null,clientNonce:crypto.randomBytes(32).toString("hex")}
    socket.write(core.encodeFrame(hello),(error) => { if (error && !value.connected) cancel() })
  })
  socket.on("data",(bytes) => { value.receivedBytes+=bytes.length; if (value.receivedBytes>16384) cancel() })
  socket.on("error",() => { /* A connected peer can be refused/reset before any AUTH byte. */ })
  const observed=new Promise((resolve) => socket.once("close",() => {
    clearTimeout(timer); value.closed=!cancelled; resolve(Object.freeze({...value}))
  }))
  socket.connect({path:endpoint})
  return {socket,observed,cancel}
}
async function runBadParentPeer({stream,deadline}) {
  const value={submittedBytes:0,completedBytes:0,paused:false,resumed:false,writeFailed:false,kernelCredit:false}
  const bytes=Buffer.alloc(65536,120); bytes.writeUInt32LE(16381)
  stream.pause(); value.paused=true
  try {
    while (value.submittedBytes<1048576 && core.remainingNanoseconds(deadline,process.hrtime.bigint())) {
      await new Promise((resolve,reject) => {
        let settled=false
        const complete=(error) => {
          if (settled) return
          settled=true; clearTimeout(timer)
          if (error || !core.remainingNanoseconds(deadline,process.hrtime.bigint())) reject(error||new Error("deadline"))
          else { value.completedBytes+=bytes.length; resolve() }
        }
        const timer=setTimeout(() => complete(new Error("deadline")),
          Number((core.remainingNanoseconds(deadline,process.hrtime.bigint())+999999n)/1000000n))
        try { stream.write(bytes,complete) } catch (error) { complete(error) }
        value.submittedBytes+=bytes.length
      })
    }
  } catch { value.writeFailed=true }
  finally { stream.resume(); value.resumed=true }
  return Object.freeze(value)
}
async function createPostResultRelease({ generation, preparationDigest, deadline, pressure = false, preauth = false, onPeerLive = () => {} }) {
  if (!/^[0-9a-f]{64}$/.test(generation)) fail()
  let peer, admitted = null, released = false, stopped = false, settle, metrics = null, used = 0, rootLive=false
  const body = Buffer.alloc(4096)
  const closed = new Promise((resolve) => { settle = resolve })
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    if (peer || stopped) { socket.destroy(); return }
    peer = socket
    socket.on("data", (bytes) => {
      if ((!pressure && !preauth) || used + bytes.length > 4096) return stop()
      bytes.copy(body, used); used += bytes.length
    })
    server.maxConnections = 1
    socket.on("end", () => {
      if (!pressure && !preauth) return
      try {
        const v = fixtureProtocol.validatePeerObservation(core.parseJSON(body.subarray(0, used), 4096))
        if (preauth) {
          if (v.type!=="ROOT_LIVE" || v.generation!==generation || v.preparationDigest!==preparationDigest) fail()
          rootLive=true; onPeerLive()
        } else { if (v.type!=="NODE_PRESSURE") fail(); metrics=Object.freeze(v) }
        socket.end(); server.close()
      } catch { stop() }
    })
    socket.on("error", () => stop())
    socket.on("close", () => { if (released) server.close() })
    flush()
  })
  function flush() {
    if (!released || !peer || stopped) return
    if (!admitted || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) return stop()
    peer.end("RELEASE\n")
  }
  function stop() {
    if (stopped) return
    stopped = true; clearTimeout(timer); peer?.destroy()
    try { server.close() } catch { /* Never substitute this for owner close. */ }
  }
  const timer = setTimeout(stop, Number(core.remainingNanoseconds(deadline, process.hrtime.bigint()) / 1000000n))
  server.once("close", () => { clearTimeout(timer); settle() })
  server.on("error", stop)
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(`\\\\.\\pipe\\desk-owned-git-fixture-${generation}`, () => { server.off("error", reject); resolve() })
  })
  return { closed, stop, admit(value) {
    if (admitted || stopped) fail()
    const result = core.decodeResult(value)
    if (result.command.state !== "exited" || result.command.code !== 0 || result.input.state !== "complete") fail()
    admitted = value
  }, release() {
    if (pressure || !admitted || released || stopped) fail()
    released = true; flush()
  }, metrics: () => metrics && { ...metrics }, rootLive:() => rootLive }
}
function createFixtureBridgeObserver({ stream, deadline, mode = null, observationEnd = deadline.expiresNs,
  onFrame = () => {}, onError = () => {} }) {
  let lastState = null, footer = null, eof = false, closed = false, failed = false, writing = false, bytes = 0
  let footerLate = false, lastStateLate = false
  const reject = () => { if (!failed) { failed = true; onError(new Error("fixture_control")) } }
  const decoder = fixtureProtocol.createFixtureControlDecoder({ core, onFrame(value) {
    const event = fixtureProtocol.validateFixtureEvent(value)
    const now = process.hrtime.bigint(), late = now >= deadline.expiresNs
    if (footer || now >= observationEnd || (late && !["STATE","ENTRY_RESULT","CLOSED"].includes(event.type))) fail()
    if ((Object.hasOwn(event, "deadlineNs") && event.deadlineNs !== deadline.expiresNs.toString()) ||
      (mode !== null && event.type === "STATE" && event.mode !== mode)) fail()
    if (event.type === "STATE") { lastState = event; lastStateLate = late }
    if (event.type === "CLOSED") { footer = event; footerLate = late }
    onFrame(event)
  } })
  stream.on("data", (chunk) => { try {
    bytes += chunk.length
    if (bytes > 1048576) fail()
    decoder.push(chunk)
  } catch { reject() } })
  stream.on("end", () => { try { decoder.end(); eof = true } catch { reject() } })
  stream.on("close", () => { closed = true })
  stream.on("error", reject)
  return { request(type) {
    if (!["CONTINUE","RESUME_SERVER","SNAPSHOT","SAMPLE","FINISH",...Array.from({ length: 8 }, (_, i) => `VECTOR${i}`)].includes(type) ||
      failed || footer || eof || writing || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
    const text = JSON.stringify({ schema: "desk.owned-git-fixture-control/1", type }), n = Buffer.byteLength(text)
    const frame = Buffer.alloc(n + 4); frame.writeUInt32LE(n); frame.write(text, 4); writing = true
    return new Promise((resolve, rejectWrite) => stream.write(frame, (error) => {
      writing = false; if (error) { reject(); rejectWrite(new Error("fixture_control")) } else resolve()
    }))
  }, snapshot: () => structuredClone({ lastState, lastStateLate, footer, footerLate, eof, closed, failed, bytes }) }
}
async function launchFixtureUtility({ construction, kind, role, nodeExecutable, deadline, origin = "parent",
  onFrame = () => {}, isCancelled = () => false }) {
  const scope = fixtureConstructions.get(construction)
  const kinds = ["result-vectors", "clock-samples", "io-helpers", "production-seed", "fault-seed", "clock-companion"]
  const remaining = core.remainingNanoseconds(deadline, process.hrtime.bigint())
  if (process.platform !== "win32" || !scope || !kinds.includes(kind) || !["parent","companion"].includes(origin) ||
    !remaining || remaining > (kind === "clock-samples" || kind === "clock-companion" ? 1000000000n :
      kind==="io-helpers" ? 2000000000n : 10000000000n) ||
    deadline.expiresNs > scope.H - 20000000000n) fail()
  const retention = require("./windows_owned_git_retention.cjs"), identity = retention.runtimeIdentity(role)
  if ((!kind.startsWith("clock-") && role !== "24") ||
    (origin === "companion" && kind !== "clock-samples") ||
    (kind === "clock-samples" && origin === "parent" &&
      (process.versions.node !== identity.version || nodeExecutable !== process.execPath))) fail()
  const verify = await import(pathToFileURL(path.resolve(__dirname, "../../../../../../plugins/desk/mcp/scripts/verify-owned-git.js")).href)
  const assets = await verify.verifyOwnedGitAssets({ publicMcpRoot: scope.publicMcpRoot,
    privateRealmRoot: scope.privateRealmRoot, nodeExecutable })
  if (assets.nodeSha256 !== identity.expectedExeSha256) fail()
  const bundle = retention.verifyPublicBundle({ publicMcpRoot: scope.publicMcpRoot, expectedSource: scope.expectedSource })
  if (bundle.fixtureManifestSha256 !== scope.fixtureManifestSha256) fail()
  scope.utilityUses ||= new Set()
  const key = `${kind}:${role}:${origin}`
  if (scope.utilityUses.has(key)) fail()
  scope.utilityUses.add(key)
  const layout = bundle.layout
  const invocation = getUtilityInvocation(kind)
  let image = path.join(layout.fixtureRoot, invocation.image), argv = [...invocation.argv]
  const env = {}
  for (const name of ["SystemRoot","WINDIR","SystemDrive","COMSPEC","PATH","TEMP","TMP","PATHEXT"]) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  Object.assign(env, { DESK_TEST_OWNED_GIT_H: scope.H.toString(), DESK_TEST_OWNED_GIT_D: deadline.expiresNs.toString() })
  const companion = kind === "clock-companion"
  if (companion) { image = assets.nodeExecutable; argv = [path.join(layout.testRoot, "clock-companion.cjs")] }
  if (isCancelled() || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
  const child = spawn(image, argv, { env, cwd: layout.publicMcpRoot, windowsHide: true,
    stdio: companion ? ["ignore","overlapped","overlapped","overlapped"] : ["ignore","overlapped","overlapped","ignore","overlapped"] })
  let failed = false, exited = false, code = null, signal = null, total = 0, pending = false
  const streams = { stdout: { end: false, close: false }, stderr: { end: false, close: false } }
  const control = companion ? child.stdio[3] : child.stdio[4]
  let controlEOF = false, controlClosed = false
  const cancel = () => { failed = true; try { child.kill("SIGTERM") } catch { /* Original actor only; no fake close. */ } }
  const bridge = companion ? null : createFixtureBridgeObserver({ stream: control, deadline, onFrame,
    mode: kind === "io-helpers" ? "C08" : null, onError: cancel })
  const decoder = companion ? fixtureProtocol.createFixtureControlDecoder({ core, onFrame(value) {
    if (value?.schema !== "desk.owned-git-clock-companion/1" ||
      !["SAMPLE_READY","CLOCK_ROW","FINISHED"].includes(value.type)) fail()
    if (value.type === "FINISHED") {
      if (Object.keys(value).sort().join(",") !== "samples,schema,type" || value.samples !== 64) fail()
      control.end()
    }
    onFrame(value)
  } }) : null
  if (companion) {
    control.on("data", (bytes) => { try { decoder.push(bytes) } catch { cancel() } })
    control.on("end", () => { try { decoder.end(); controlEOF = true } catch { cancel() } })
    control.on("close", () => { controlClosed = true })
    control.on("error", cancel)
  }
  for (const name of ["stdout","stderr"]) {
    child[name].on("data", (bytes) => { total += bytes.length; if (total > 1048576) cancel() })
    child[name].on("end", () => { streams[name].end = true })
    child[name].on("close", () => { streams[name].close = true })
    child[name].on("error", cancel)
  }
  child.on("error", cancel)
  child.once("exit", (c, s) => { exited = true; code = c; signal = s })
  const timer = setTimeout(cancel, Math.max(0, Number((core.remainingNanoseconds(deadline, process.hrtime.bigint()) + 999999n) / 1000000n)))
  const observed = new Promise((resolve) => child.once("close", () => {
    clearTimeout(timer)
    const at = process.hrtime.bigint(), b = bridge?.snapshot()
    resolve(Object.freeze({ exitObserved: exited, closeObserved: true, code, signal, closedAtNs: at.toString(),
      stdoutEOF: streams.stdout.end, stdoutClosed: streams.stdout.close, stderrEOF: streams.stderr.end,
      stderrClosed: streams.stderr.close, controlEOF: companion ? controlEOF : b.eof,
      controlClosed: companion ? controlClosed : b.closed, failed: failed || b?.failed === true,
      withinDeadline: at < deadline.expiresNs, telemetryBytes: total, footer: b?.footer || null }))
  }))
  return { child, observed, bridge, cancel, requestCompanion(value) {
    if (!companion || pending || failed || controlEOF || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
    const text = JSON.stringify(value), size = Buffer.byteLength(text)
    if (size > 4096) fail()
    const frame = Buffer.alloc(size + 4); frame.writeUInt32LE(size); frame.write(text, 4); pending = true
    return new Promise((resolve, reject) => control.write(frame, (error) => { pending = false
      if (error) { cancel(); reject(new Error("fixture_control")) } else resolve() }))
  } }
}
function freeze(value) {
  for (const item of Object.values(value)) if (item && typeof item === "object") freeze(item)
  return Object.freeze(value)
}
// Closed source registry; no runtime dependency on a private planning file.
function plan(prefix, evidenceClass, parent, root, profile, numbers, receiptPolicy = "required") {
  const [generations, parentSTART, nativeSTART, genuineRESULT, eligibleNativeCertificates,
    rootCreations, ownerFullClose, utilityProcesses, modelStrandedRoots] = numbers
  return freeze({ id: `${prefix}-P${parent}-R${root ?? "none"}`, evidenceClass, parent, root, profile,
    expected: { generations, parentSTART, nativeSTART, genuineRESULT, eligibleNativeCertificates,
      rootCreations, ownerFullClose, utilityProcesses, modelStrandedRoots,
      HOLD: generations > 0 && eligibleNativeCertificates === 0 }, receiptPolicy })
}
const DIAGONAL = [
  ["O01", "A", "G_BASELINE", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["O02", "C", "NONE", [1, 0, 0, 0, 1, 1, 1, 0, 0]],
  ["O03", "C", "NONE", [1, 0, 0, 0, 1, 1, 1, 0, 0]],
  ["O04", "A", "NONE", [1, 0, 0, 0, 1, 1, 1, 0, 0]],
  ["O05", "C", "G_EXIT0", [1, 1, 1, 1, 0, 1, 1, 0, 0], "expected_absent"],
  ["O06", "C", "NONE", [1, 0, 0, 0, 1, 1, 1, 0, 0]],
  ["O07", "C", "NONE", [1, 0, 0, 0, 1, 1, 1, 0, 0]],
  ["O08", "A", "G_BLOCK", [1, 1, 1, 0, 1, 1, 1, 0, 0], "required_file_only"],
  ["O09", "A", "G_BLOCK", [1, 1, 1, 0, 0, 1, 1, 0, 0], "expected_absent"],
]
const SUPPLEMENTAL = [
  ["A10", "NONE", [1, 0, 0, 0, 1, 1, 1, 0, 0]],
  ["A11", "G_EXIT7", [2, 1, 1, 1, 2, 2, 2, 0, 0]],
  ["A12", "G_EXIT7", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["A13", "MISSING_GIT", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["A14", "G_STDIN512K", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["A15", "G_EPIPE", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["A16", "G_DATA_PRESSURE", [1, 1, 1, 0, 1, 1, 1, 0, 0]],
  ["A17", "G_BLOCK", [1, 1, 1, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["A18", "NONE", [1, 0, 0, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["A19", "G_BLOCK", [1, 1, 1, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["A20", "NONE", [1, 0, 0, 0, 1, 0, 1, 0, 0]],
  ["A21", "NONE", [1, 0, 0, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["A22", "G_DELAY1500", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["A23", "G_BASELINE", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["A24", "G_COMMIT", [1, 1, 1, 1, 1, 1, 1, 0, 0]],
  ["A25", "G_BLOCK", [1, 1, 1, 0, 0, 1, 0, 0, 0], "withheld_owner_close"],
]
const CLASS_B_VARIANTS = Object.freeze(["wrong-pid-delay", "malformed", "replay-result", "trailing",
  "partial-header", "partial-body", "oversized", "eof-before-result", "pressure", "normal"])
const CLASS_C = [
  ["C01", null, "RESULT_VECTORS", [0, 0, 0, 0, 0, 0, 0, 1, 0], "none"],
  ["C03", "24", "NONE", [1, 0, 0, 0, 0, 0, 1, 0, 0], "expected_absent"],
  ["C04", "24", "NONE", [1, 0, 0, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["C05", "24", "NONE", [1, 1, 0, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["C06", "24", "NONE", [1, 0, 0, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["C07", "24", "G_BLOCK", [1, 1, 1, 0, 0, 1, 1, 0, 0], "expected_absent"],
  ["C08", null, "REAL_IO_HELPERS", [0, 0, 0, 0, 0, 0, 0, 1, 0], "none"],
  ...["C09", "C10", "C11", "C12", "C13", "C14"].map((id) => [id, "24", "NONE", [1, 0, 0, 0, 1, 1, 1, 0, 0], "required"]),
  ["C15", "24", "G_BLOCK", [1, 1, 1, 0, 0, 1, 0, 0, 1], "withheld_model"],
  ...["C16", "C17", "C18"].map((id) => [id, "24", "NONE", [1, 0, 0, 0, 0, 0, 1, 0, 0], "expected_absent"]),
  ["C19", null, "DENOMINATOR_SEEDS", [0, 0, 0, 0, 0, 0, 0, 2, 0], "none"],
]
const NATIVE_REGISTRY = freeze([
  ...["20", "22", "24"].flatMap((r) => DIAGONAL.map(([id, kind, profile, counts, policy]) => plan(id, kind, r, r, profile, counts, policy))),
  ...[["20", "22"], ["20", "24"], ["22", "20"], ["22", "24"], ["24", "20"], ["24", "22"]]
    .map(([p, r]) => plan("X01", "A", p, r, "G_BASELINE", [1, 1, 1, 1, 1, 1, 1, 0, 0])),
  ...SUPPLEMENTAL.map(([id, profile, counts, policy]) => plan(id, "A", "24", "24", profile, counts, policy)),
  ...CLASS_B_VARIANTS.map((variant, i) => {
    const starts = i >= 1 && i <= 7 ? 1 : 0, results = i >= 1 && i <= 6 ? 1 : 0
    return plan(`B${String(i + 1).padStart(2, "0")}`, "B", "24", "24", results ? "G_EXIT0" : "NONE",
      [1, starts, starts, results, 1, 1, 1, 0, 0])
  }),
  CLASS_C.slice(0, 1).map(([id, r, profile, counts, policy]) => plan(id, "C", "24", r, profile, counts, policy))[0],
  ...["20", "22", "24"].map((r) => plan("C02", "C", r, r, "CLOCK_SAMPLES", [0, 0, 0, 0, 0, 0, 0, 2, 0], "none")),
  ...CLASS_C.slice(1).map(([id, r, profile, counts, policy]) => plan(id, "C", "24", r, profile, counts, policy)),
])
const getNativeCaseRegistry = () => NATIVE_REGISTRY
const fixtureConstructions = new WeakMap()
function createFixtureConstruction() {
  if (process.platform !== "win32" || process.env.DESK_TEST_OWNED_GIT_NATIVE !== "1") fail()
  const env = process.env, repository = path.resolve(__dirname, "../../../../../../")
  if (!/^[0-9a-f]{40}$/.test(env.DESK_TEST_OWNED_GIT_SOURCE_REVISION || "") ||
    !/^[0-9a-f]{40}$/.test(env.DESK_TEST_OWNED_GIT_SOURCE_TREE || "") ||
    !/^[0-9a-f]{64}$/.test(env.DESK_TEST_OWNED_GIT_NONCE || "") ||
    !/^[0-9a-f]{64}$/.test(env.DESK_TEST_OWNED_GIT_FIXTURE_SHA || "") ||
    !/^[1-9][0-9]{0,19}$/.test(env.DESK_TEST_OWNED_GIT_H || "")) fail()
  const H = BigInt(env.DESK_TEST_OWNED_GIT_H), root = path.join(repository, "owned-git-product-output")
  if (H > 18446744073709551615n || process.hrtime.bigint() >= H ||
    env.DESK_TEST_OWNED_GIT_PRIVATE !== path.join(root, "private")) fail()
  const retention = require("./windows_owned_git_retention.cjs")
  const publicMcpRoot = path.join(root, "public", "mcp"), expectedSource = {
    sourceRevision: env.DESK_TEST_OWNED_GIT_SOURCE_REVISION, sourceTree: env.DESK_TEST_OWNED_GIT_SOURCE_TREE }
  const bundle = retention.verifyPublicBundle({ publicMcpRoot, expectedSource })
  if (bundle.fixtureManifestSha256 !== env.DESK_TEST_OWNED_GIT_FIXTURE_SHA || process.hrtime.bigint() >= H) fail()
  const token = Object.freeze({})
  fixtureConstructions.set(token, { publicMcpRoot, privateRealmRoot: env.DESK_TEST_OWNED_GIT_PRIVATE,
    fixtureRoot:bundle.layout.fixtureRoot, expectedSource: Object.freeze(expectedSource), fixtureManifestSha256: bundle.fixtureManifestSha256,
    namespaceNonce:env.DESK_TEST_OWNED_GIT_NONCE,H })
  // This is only a local asset binding. It conveys no native observer/header,
  // real-supervisor origin or bootstrap admission in S14.
  return token
}
function resolveFixtureAssets({ productionAssets, fixtureManifest, variant }) {
  if (!["fault", ...CLASS_B_VARIANTS].includes(variant)) fail()
  const retention = require("./windows_owned_git_retention.cjs")
  const fx = retention.projectFixtureManifest(fixtureManifest, { sourceRevision: productionAssets.manifest.sourceRevision })
  const layout = retention.fixtureLayout(productionAssets.publicMcpRoot)
  if (fx.binaries[0].sha256 !== productionAssets.manifest.files.owner.sha256) fail()
  if (variant === "fault") {
    const owner = fx.binaries[2]
    return { ...productionAssets, owner: path.join(layout.fixtureRoot, owner.key),
      ownerSha256: owner.sha256, shimSha256: productionAssets.manifest.files.shim.sha256,
      evidenceClass: "C" }
  }
  const root = fx.roots.find((r) => r.basename === `${variant}.cjs`)
  if (!root || root.production !== false || root.sourceKey !== "S11" || !/^[0-9a-f]{64}$/.test(root.sha256)) fail()
  return { ...productionAssets, shim: path.join(layout.testRoot, root.basename),
    ownerSha256: productionAssets.manifest.files.owner.sha256, shimSha256: root.sha256, evidenceClass: "B" }
}
function getUtilityInvocation(kind) {
  const choices = {
    "result-vectors": ["fault-owner.exe", "--result-vectors"],
    "clock-samples": ["fault-owner.exe", "--clock-samples"],
    "io-helpers": ["fault-owner.exe", "--real-io-helpers"],
    "production-seed": ["production-owner-instrumented.exe", "--owned-git"],
    "fault-seed": ["fault-owner-instrumented.exe", "--result-vectors"],
    "clock-companion": ["node.exe", "clock-companion.cjs"],
  }
  if (!Object.hasOwn(choices, kind)) fail()
  const [image, arg] = choices[kind]
  return Object.freeze({ image, argv: Object.freeze([arg]) })
}
function resolveRegistryFixture({ productionAssets, fixtureManifest, caseId, parent, root }) {
  const plan = NATIVE_REGISTRY.find((row) => row.id === caseId)
  if (!plan || !["B", "C"].includes(plan.evidenceClass) || !plan.expected.generations ||
    plan.parent !== parent || plan.root !== root) fail()
  const retention = require("./windows_owned_git_retention.cjs")
  const variant = plan.evidenceClass === "C" ? "fault" : CLASS_B_VARIANTS[Number(plan.id.slice(1,3))-1]
  const selected = resolveFixtureAssets({ productionAssets, fixtureManifest, variant })
  return { ...selected, fixtureTuple: Object.freeze({ id: plan.id,
    parent: retention.runtimeIdentity(plan.parent), root: retention.runtimeIdentity(plan.root) }) }
}
async function launchFixtureComponent(options) {
  const { publicMcpRoot, privateRealmRoot, nodeExecutable, prepareBinding, caseId, deadline } = options
  const construction = fixtureConstructions.get(options.construction)
  if (process.platform !== "win32" || process.env.DESK_TEST_OWNED_GIT_NATIVE !== "1" ||
    !construction || publicMcpRoot !== construction.publicMcpRoot || privateRealmRoot !== construction.privateRealmRoot ||
    deadline.expiresNs > construction.H - 20000000000n || privateRealmRoot !== prepareBinding.privateRealmRoot ||
    !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
  const plan = NATIVE_REGISTRY.find((row) => row.id === caseId)
  if (!plan || !["B", "C"].includes(plan.evidenceClass) || !plan.expected.generations) fail()
  const verify = await import(pathToFileURL(path.resolve(__dirname, "../../../../../../plugins/desk/mcp/scripts/verify-owned-git.js")).href)
  const productionAssets = await verify.verifyOwnedGitAssets({ publicMcpRoot, privateRealmRoot, nodeExecutable })
  const retention = require("./windows_owned_git_retention.cjs")
  const bundle = retention.verifyPublicBundle({ publicMcpRoot,
    expectedSource: construction.expectedSource })
  if (bundle.fixtureManifestSha256 !== construction.fixtureManifestSha256) fail()
  const assets = resolveRegistryFixture({ productionAssets, fixtureManifest: bundle.fixture, caseId,
    parent: plan.parent, root: plan.root })
  if (process.versions.node !== assets.fixtureTuple.parent.version ||
    productionAssets.nodeExecutable !== process.execPath ||
    productionAssets.nodeSha256 !== assets.fixtureTuple.parent.expectedExeSha256 ||
    productionAssets.nodeSha256 !== assets.fixtureTuple.root.expectedExeSha256) fail()
  if (!core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
  if (options.isCancelled?.()) nativeFailure("producer_unjoined")
  return launchWithAssets({ assets, prepareBinding, deadline, outputLimit: options.outputLimit,
    onFrame: options.onFrame, onError: options.onError || (() => {}), faultCase: plan.evidenceClass === "C" ? plan.id : null,
    fixtureH: construction.H, postResultFault: plan.evidenceClass === "B" && Number(plan.id.slice(1,3)) >= 2 &&
      Number(plan.id.slice(1,3)) <= 7, pressurePeer: plan.id === "B09-P24-R24", onFixtureFrame: options.onFixtureFrame,
    onLaunched:options.onLaunched,preauthPeer:plan.id==="B01-P24-R24",onPeerLive:options.onPeerLive })
}
function originalWorkerFullclose(value) {
  return ["exitObserved","closeObserved","stdoutEOF","stdoutClosed","stderrEOF","stderrClosed","controlEOF","controlClosed"]
    .every((key) => value?.[key] === true)
}
function utilityObservationComplete(value, expectedCode) {
  return originalWorkerFullclose(value) && value.signal === null && value.code === expectedCode && value.failed !== true
}
function utilityFooterComplete(kind,footer,origin="parent") {
  if (!footer || footer.telemetryGap || footer.creationCalls!==0) return false
  if (kind==="clock-samples") return footer.ownerFreed===true && footer.requests===(origin==="companion"?65:73)
  if (kind==="io-helpers") return footer.ownerFreed===true && footer.requests===0
  return ["result-vectors","fault-seed"].includes(kind) && footer.ownerFreed===false && footer.requests===0
}
function observeUtilityJoins(observations, companion = null) {
  return { fullcloseObserved: observations.filter(originalWorkerFullclose).length,
    companionFullcloseObserved: companion === null ? null : originalWorkerFullclose(companion) }
}
function caseFinishedWithinDeadline(actual) {
  return actual !== null && BigInt(actual.finishedNs) < BigInt(actual.caseDeadlineNs)
}
function createNativeWorkerLedger({ H }) {
  if (typeof H !== "bigint" || H <= 30000000000n) fail()
  const records = new Map()
  let active = 0
  return {
    admit(id, now) {
      const plan = NATIVE_REGISTRY.find((row) => row.id === id)
      if (!plan || typeof now !== "bigint" || now < 0n || now >= H - 30000000000n || records.has(id) || active === 12) fail()
      const prefix = plan.id.split("-")[0]
      const duration = ["A17","A18","C02","C03","C04","C05","C06","C07","C16","C17","C18"].includes(prefix)
        ? 1000000000n : ["A19","A22","C08"].includes(prefix) ? 2000000000n : 10000000000n
      const end = now+duration < H-20000000000n ? now+duration : H-20000000000n
      records.set(id, { id, admittedAtNs: now.toString(), deadlineNs:end.toString(), state: "reserved", fullclose: false }); active++
      return Object.freeze({ id, parent: plan.parent, deadlineNs:end.toString(), workCutoffNs: (H - 20000000000n).toString() })
    },
    finish(id, value) {
      const record = records.get(id)
      if (!record || !["reserved","quarantined"].includes(record.state) || value?.closeObserved !== true) fail()
      record.state = "closed"; record.fullclose = originalWorkerFullclose(value); active--
      return Object.freeze({ ...record })
    },
    quarantine(id) {
      const record=records.get(id)
      if (id!=="C15-P24-R24" || !record || record.state!=="reserved") fail()
      record.state="quarantined"
    },
    refusedBeforeSpawn(id) {
      const record = records.get(id)
      if (!record || record.state !== "reserved") fail()
      record.state = "not-created"; active--
    },
    snapshot: () => ({ activeReservations: active, rows: [...records.values()].map((r) => ({ ...r })) }),
  }
}
function validateUtilityClockSample(value, before, after, deadline) {
  const decimal = (s) => {
    if (typeof s !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(s) || BigInt(s) > 18446744073709551615n) fail()
    return BigInt(s)
  }
  const q = decimal(value.q), f = decimal(value.f)
  decimal(value.converted); decimal(value.edge)
  if (!q || !f || typeof before !== "bigint" || typeof after !== "bigint" || before > after ||
    after >= deadline.expiresNs || core.mirrorWindowsHrtime(value.q,value.f).toString() !== value.converted ||
    core.mirrorWindowsHrtime((q+1n).toString(),value.f).toString() !== value.edge ||
    core.mirrorWindowsHrtime((q-1n).toString(),value.f) > after || BigInt(value.edge) < before ||
    BigInt(value.edge) >= deadline.expiresNs) fail()
  return true
}
function safeNativeGap(error) {
  const codes = require("./windows_owned_git_retention.cjs").GAPS
  return codes.includes(error?.code) && error.code !== "none" ? error.code : "case_mismatch"
}
function nativeFailure(code) { throw Object.assign(new Error("owned_git_native_incomplete"), { code }) }
async function getFixtureRuntime(construction, role) {
  const scope = fixtureConstructions.get(construction)
  if (!scope) fail()
  const retention = require("./windows_owned_git_retention.cjs"), wanted = retention.runtimeIdentity(role)
  const repo = path.resolve(__dirname, "../../../../../../"), filename = path.join(repo, "owned-git-product-interpreters.json")
  const st = fs.lstatSync(filename)
  if (!st.isFile() || st.isSymbolicLink() || st.size > 16384) fail()
  const values = core.parseJSON(fs.readFileSync(filename), 16384)
  if (!Array.isArray(values) || values.length !== 3) fail()
  for (let i=0;i<3;i++) {
    const v = values[i], identity = retention.runtimeIdentity(["20","22","24"][i])
    if (!v || Object.keys(v).sort().join(",") !== "path,sha256,version" ||
      v.version !== `v${identity.version}` || typeof v.path !== "string" || !path.isAbsolute(v.path) ||
      typeof v.sha256 !== "string" || v.sha256.toLowerCase() !== identity.expectedExeSha256) fail()
  }
  const value = values[["20","22","24"].indexOf(role)]
  const relative = path.relative(scope.privateRealmRoot, value.path)
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) fail()
  const verify = await import(pathToFileURL(path.resolve(__dirname, "../../../../../../plugins/desk/mcp/scripts/verify-owned-git.js")).href)
  const actual = await verify.verifyOwnedGitAssets({ publicMcpRoot: scope.publicMcpRoot,
    privateRealmRoot: scope.privateRealmRoot, nodeExecutable: value.path })
  if (actual.nodeSha256 !== wanted.expectedExeSha256) nativeFailure("runtime_mismatch")
  const binding = Object.freeze({ ...wanted, path: actual.nodeExecutable })
  return binding
}
function createUtilityInbox(deadline) {
  const queued = []
  let waiter = null, failure = null
  function reject(code = "case_mismatch") {
    failure ||= Object.assign(new Error("owned_git_native_incomplete"), { code })
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(failure); waiter = null }
  }
  return {
    push(value) {
      if (failure) return
      if (waiter) {
        const current = waiter; waiter = null; clearTimeout(current.timer)
        if (value.type !== current.type) { reject(); current.reject(failure) } else current.resolve(value)
      } else if (queued.length < 2) queued.push(value)
      else reject("quota")
    },
    next(type) {
      if (failure) return Promise.reject(failure)
      if (waiter || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) {
        reject("deadline"); return Promise.reject(failure)
      }
      if (queued.length) {
        const value = queued.shift()
        if (value.type !== type) { reject(); return Promise.reject(failure) }
        return Promise.resolve(value)
      }
      return new Promise((resolve,rejectWait) => {
        waiter = { type, resolve, reject: rejectWait, timer: setTimeout(() => reject("deadline"),
          Number(core.remainingNanoseconds(deadline,process.hrtime.bigint())/1000000n)) }
      })
    },
    fail: reject,
  }
}
const SCALAR_CASES = Object.freeze([
  ["10000000","10000000","1000000000"],["1","10000000","100"],["0","1000000000","0"],
  ["9007199254740993","1000000000","9007199254740992"],["18446744073709551615","1000000000",null],
  ["1","0",null],["1","3","333333333"],["18446744073709551615","1",null],
])
async function runNativeUtilityCase({ construction, plan, deadline, emitClock = async () => {}, registerActor = () => {},
  isCancelled = () => false }) {
  const retention = require("./windows_owned_git_retention.cjs")
  if (plan.expected.generations || !plan.expected.utilityProcesses) nativeFailure("not_admitted")
  const actors = [], clocks = []
  let checksPassed = 0, io = null, bits = null, gap = "none", seedMatched = false
  const runtime = await getFixtureRuntime(construction, plan.parent)
  const launch = async (kind, origin = "parent") => {
    if (isCancelled()) nativeFailure("producer_unjoined")
    const inbox = createUtilityInbox(deadline)
    const actor = await launchFixtureUtility({ construction, kind, role: plan.parent, nodeExecutable: runtime.path,
      deadline, origin, onFrame: (value) => inbox.push(value), isCancelled })
    actor.inbox = inbox; actor.kind = kind; actor.origin=origin; actors.push(actor); registerActor(actor)
    if (isCancelled()) actor.cancel()
    actor.observed.then(() => { /* A missing response is unknown, never a manufactured result. */
      if (!actor.bridge?.snapshot().footer && kind !== "production-seed" && kind !== "clock-companion") inbox.fail("producer_unjoined")
    })
    return actor
  }
  const finish = async (actor, expectedCode, footerRequired = true) => {
    const observation = await actor.observed
    if (!utilityObservationComplete(observation,expectedCode) || !observation.withinDeadline ||
      (footerRequired && !utilityFooterComplete(actor.kind,observation.footer,actor.origin))) nativeFailure("producer_unjoined")
    return observation
  }
  const addClock = async (packet, before, after, origin, index, modeled = false) => {
    const row = retention.projectClock({ samples: [{ case: plan.id, generationSlot: null, role: plan.parent,
      origin, index, q: packet.q, f: packet.f, converted: packet.converted, edge: modeled ? null : packet.edge,
      beforeNs: modeled ? null : before.toString(), afterNs: modeled ? null : after.toString(),
      deadlineNs: deadline.expiresNs.toString(), accepted: packet.accepted, modeled }], gaps: [] }).samples[0]
    clocks.push(row); await emitClock(row)
  }
  try {
    if (plan.id === "C01-P24-Rnone") {
      const actor = await launch("result-vectors"), result = await actor.inbox.next("VECTORS")
      bits = result.bits; checksPassed = result.checksPassed
      await finish(actor,0)
    } else if (plan.id === "C08-P24-Rnone") {
      const actor = await launch("io-helpers"), result = await actor.inbox.next("IO")
      const names = ["realPendingRead","realPendingWrite","cancelReadRequested","cancelWriteRequested",
        "readReaped","writeReaped","storageRetainedUntilReap"]
      io = Object.fromEntries(names.map((name,i) => [name,result.checks[i]]))
      io.syntheticEOF = result.syntheticEOF; checksPassed = result.checksPassed
      await finish(actor,0)
    } else if (plan.id === "C19-P24-Rnone") {
      const production = await launch("production-seed"); await finish(production,1,false)
      const fault = await launch("fault-seed"), vector = await fault.inbox.next("VECTORS")
      if (vector.checksPassed !== 5) nativeFailure("case_mismatch")
      await finish(fault,0)
      // These are real seed process observations, not LLVM denominator comparisons.
      seedMatched = true; gap = "denominator_missing"
    } else if (plan.id.startsWith("C02-")) {
      const parent = await launch("clock-samples")
      for (let index=0;index<64;index++) {
        const before = process.hrtime.bigint()
        await parent.bridge.request("SAMPLE")
        const value = await parent.inbox.next("CLOCK"), after = process.hrtime.bigint()
        if (value.index !== index) nativeFailure("clock_mismatch")
        validateUtilityClockSample(value,before,after,deadline); checksPassed++
        await addClock(value,before,after,"parent-companion",index)
      }
      for (let index=0;index<8;index++) {
        await parent.bridge.request(`VECTOR${index}`)
        const value = await parent.inbox.next("SCALAR"), [q,f,want] = SCALAR_CASES[index]
        if (value.index !== index || value.q !== q || value.f !== f || value.converted !== want ||
          value.accepted !== (want !== null)) nativeFailure("clock_mismatch")
        // Both actual C and shared actual JS conversion are checked, not copied math.
        let mirror = null
        try { mirror = core.mirrorWindowsHrtime(q,f).toString() } catch { /* Expected rejected scalar only. */ }
        if (mirror !== want) nativeFailure("clock_mismatch")
        checksPassed++; await addClock(value,null,null,"fixed-vector",index,true)
      }
      await parent.bridge.request("FINISH"); await finish(parent,0)
      const nativeCompanion = await launch("clock-samples","companion"), nodeCompanion = await launch("clock-companion")
      const schema = "desk.owned-git-clock-companion/1"
      for (let index=0;index<64;index++) {
        await nodeCompanion.requestCompanion({ schema,type:"BEGIN",index })
        const ready = await nodeCompanion.inbox.next("SAMPLE_READY")
        if (ready.index !== index) nativeFailure("clock_mismatch")
        await nativeCompanion.bridge.request("SAMPLE")
        const value = await nativeCompanion.inbox.next("CLOCK")
        if (value.index !== index) nativeFailure("clock_mismatch")
        await nodeCompanion.requestCompanion({ schema,type:"SAMPLE_VALUE",index,
          q:value.q,f:value.f,converted:value.converted,edge:value.edge })
        const row = await nodeCompanion.inbox.next("CLOCK_ROW")
        if (row.index !== index || !row.accepted || row.q !== value.q || row.f !== value.f ||
          row.deadlineNs !== deadline.expiresNs.toString()) nativeFailure("clock_mismatch")
        validateUtilityClockSample(row,BigInt(row.beforeNs),BigInt(row.afterNs),deadline)
        checksPassed++; await addClock(row,BigInt(row.beforeNs),BigInt(row.afterNs),"root-companion",index)
      }
      await nativeCompanion.bridge.request("FINISH"); await finish(nativeCompanion,0)
      await nodeCompanion.requestCompanion({ schema,type:"FINISH" })
      await nodeCompanion.inbox.next("FINISHED"); await finish(nodeCompanion,0,false)
    } else nativeFailure("not_admitted")
  } catch (error) {
    gap = safeNativeGap(error)
    for (const actor of actors) actor.cancel()
  }
  // Original observations are retained even on failure; no kill/exit is a proof.
  await Promise.all(actors.map((actor) => actor.observed))
  const nativeActors = actors.filter((actor) => actor.kind !== "clock-companion" && Number.isInteger(actor.child.pid) && actor.child.pid > 0)
  const observations = await Promise.all(nativeActors.map((actor) => actor.observed))
  const nodeActor = actors.find((actor) => actor.kind === "clock-companion")
  const joins = observeUtilityJoins(observations,nodeActor ? await nodeActor.observed : null)
  const { fullcloseObserved } = joins
  if (!nativeActors.length) nativeFailure(gap === "none" ? "not_admitted" : gap)
  const checksExpected = plan.id.startsWith("C02-") ? 136 : plan.id.startsWith("C01-") ? 5 : plan.id.startsWith("C08-") ? 8 : 4
  const finishedNs = process.hrtime.bigint().toString()
  if (!caseFinishedWithinDeadline({ finishedNs,caseDeadlineNs:deadline.expiresNs.toString() }) &&
    (gap === "none" || gap === "denominator_missing")) gap = "deadline"
  const utility = retention.projectUtility({ id:plan.id,processes:nativeActors.length,fullcloseObserved,
    companionFullcloseObserved:plan.id.startsWith("C02-") ? joins.companionFullcloseObserved === true : null,
    checksExpected,checksPassed,kernelCredit:false,resultVectorBits:bits,io,
    clockRows:clocks.map((_,i) => i),denominator:null,gap })
  const matched = gap === "none" && fullcloseObserved === nativeActors.length && checksPassed === checksExpected ||
    seedMatched && fullcloseObserved === 2 && gap === "denominator_missing"
  const record = retention.projectCase({ ...plan, actual:{ matched,disposition:"utility-only",generations:[],
    utilityId:plan.id,sourceOrigin:"producer_reported",caseDeadlineNs:deadline.expiresNs.toString(),finishedNs },gap:matched?"none":gap })
  return { record,utility,clock:clocks }
}
const NATIVE_SUBJECT = "native Windows owned-Git product admission"
const GENERATION_SECTIONS = Object.freeze([
  ["GEN_HEAD", ["slot","generation","preparationDigest","proposedPayloadDigest","acceptedPayloadDigest",
    "recordIdShape","tokenShape","durableOperationRecord","clockRow","deadlineNs","finishedNs","bindingOrigin"]],
  ["GEN_PHASE", ["phase"]], ["GEN_RESULT", ["resultB64","result","certificate","certificateOrigin","terminalFailure","invocation"]],
  ["GEN_JOINS", ["joins"]], ["GEN_RESOURCES", ["resources"]], ["GEN_DATA", ["data"]],
])
function internalFrame(id,type,value) { return { schema:"desk.owned-git-case-worker/1",type,id,value } }
function encodeGenerationFrames(id, input) {
  const plan=NATIVE_REGISTRY.find((p) => p.id===id), r=require("./windows_owned_git_retention.cjs")
  const g=r.projectGeneration(input)
  if (!plan || g.slot>=plan.expected.generations) nativeFailure("schema")
  return GENERATION_SECTIONS.map(([type,keys]) => internalFrame(id,type,{
    slot:g.slot,section:Object.fromEntries(keys.map((key) => [key,g[key]])) }))
}
function encodeCaseSummary(input) {
  const r=require("./windows_owned_git_retention.cjs"), record=r.projectCase(input)
  if (!record.actual) nativeFailure("schema")
  const { generations,...actual }=record.actual
  return internalFrame(record.id,"CASE_SUMMARY",{ generationCount:generations.length,record:{...record,actual} })
}
function encodeWorkerFrame(input) {
  validateWorkerFrame(input,input.id)
  const text=JSON.stringify(input), size=Buffer.byteLength(text)
  if (!size || size>4096) nativeFailure("quota")
  const buffer=Buffer.alloc(size+4); buffer.writeUInt32LE(size); buffer.write(text,4)
  return buffer
}
function createGenerationStagingBudget() {
  let bytes=0
  const ids=new Set(), identities=new Set()
  return {
    reserve(id,slot,generation) {
      const p=NATIVE_REGISTRY.find((v) => v.id===id), key=`${id}:${slot}`
      if (!p || !Number.isInteger(slot) || slot<0 || slot>=p.expected.generations ||
        ids.has(key) || identities.has(generation) || ids.size===75 || !/^[a-f0-9]{64}$/.test(generation)) nativeFailure("schema")
      ids.add(key); identities.add(generation)
    },
    add(n) { if (!Number.isSafeInteger(n) || n<0 || bytes+n>1048576) nativeFailure("quota"); bytes+=n },
    snapshot:() => ({ generationRecords:ids.size,bytes }),
  }
}
function createGenerationAssembly({ id,deadlineNs,budget }) {
  const p=NATIVE_REGISTRY.find((v) => v.id===id), r=require("./windows_owned_git_retention.cjs")
  if (!p || !p.expected.generations || !budget) nativeFailure("schema")
  const generations=[]
  let part=0, current={}, currentBytes=0, result=null, failed=false
  return {
    accept(frame) {
      try {
        if (failed || result) nativeFailure("schema")
        validateWorkerFrame(frame,id); budget.add(Buffer.byteLength(JSON.stringify(frame)))
        if (frame.type==="CASE_SUMMARY") {
          const { generationCount,record }=frame.value
          if (part || generationCount!==p.expected.generations || generations.length!==generationCount ||
            record.id!==id || Object.hasOwn(record.actual||{},"generations") ||
            record.actual?.caseDeadlineNs!==deadlineNs) nativeFailure("schema")
          result=r.projectCase({ ...record,actual:{...record.actual,generations} }); return result
        }
        const [type,keys]=GENERATION_SECTIONS[part]
        if (frame.type!==type || frame.value.slot!==generations.length ||
          Object.keys(frame.value.section).sort().join(",")!==[...keys].sort().join(",")) nativeFailure("schema")
        if (!part) {
          if (frame.value.section.slot!==frame.value.slot || frame.value.section.deadlineNs!==deadlineNs) nativeFailure("deadline")
          budget.reserve(id,frame.value.slot,frame.value.section.generation)
        }
        currentBytes+=Buffer.byteLength(JSON.stringify(frame.value.section))
        if (currentBytes>8192) nativeFailure("quota")
        Object.assign(current,frame.value.section)
        if (++part===GENERATION_SECTIONS.length) {
          generations.push(r.projectGeneration(current)); current={}; currentBytes=0; part=0
        }
        return null
      } catch (error) { failed=true; throw error }
    },
    end() { if (failed || !result || part) nativeFailure("schema"); return result },
  }
}
function classAPlan(id) {
  const p=NATIVE_REGISTRY.find((v) => v.id===id)
  if (!p || p.evidenceClass!=="A") nativeFailure("not_admitted")
  return p
}
function generationCaseAvailable(id) {
  const p=NATIVE_REGISTRY.find((v) => v.id===id)
  if (!p?.expected.generations) return false
  return ["A","B","C"].includes(p.evidenceClass)
}
function generationCasePlan(id) {
  if (!generationCaseAvailable(id)) nativeFailure("not_admitted")
  return NATIVE_REGISTRY.find((v) => v.id===id)
}
function createFixtureDecisions({id,slot}) {
  const p=generationCasePlan(id), prefix=id.split("-")[0], b=p.evidenceClass==="B"?Number(prefix.slice(1)):0
  if (p.evidenceClass==="A" || slot!==0) nativeFailure("schema")
  const phase=Object.fromEntries(["clockReady","clockAccepted","ready","configured","parentSTARTSent",
    "resultReceived","controlComplete","sealSent","cancelSent"].map((k) => [k,false]))
  let configured=false, barrier=false, continued=false, terminal=false, work=false, rootLive=false, replacement=false
  const cancelStranded=() => work&&rootLive&&!phase.cancelSent ? ["CANCEL"] : []
  return {
    frame(type) {
      if (terminal) nativeFailure("schema")
      if (type==="CLOCK_READY") {
        if (phase.clockReady || ["C03","C16","C17","C18"].includes(prefix)) nativeFailure("schema")
        phase.clockReady=true; return ["CLOCK_ACCEPT"]
      }
      if (type==="READY") {
        if (!phase.clockAccepted || phase.ready) nativeFailure("schema")
        phase.ready=true
        if (b>=2 && b<=8 || ["O05","C05","C07","C15"].includes(prefix)) return ["CONFIG"]
        if (b===10) return ["BAD_PARENT"]
        if (b===9 || ["C06","C09","C10","C11","C12","C13"].includes(prefix)) return []
        nativeFailure("case_mismatch")
      }
      if (type==="CONFIGURED") {
        if (!configured || phase.configured) nativeFailure("schema")
        phase.configured=true; return ["START"]
      }
      if (type==="RESULT") {
        if (!phase.parentSTARTSent || phase.resultReceived || (b && !(b>=2&&b<=7))) nativeFailure("case_mismatch")
        phase.resultReceived=true; return b?["RELEASE_RESULT"]:[]
      }
      if (type==="CONTROL_COMPLETE") {
        phase.controlComplete=true
        if (prefix!=="O05" || !phase.resultReceived) nativeFailure("case_mismatch")
        return ["SEAL"]
      }
      if (type==="TERMINAL") { terminal=true; return [] }
      nativeFailure("schema")
    },
    sent(type) {
      if (type==="CLOCK_ACCEPT") { if (!phase.clockReady || phase.clockAccepted) nativeFailure("schema"); phase.clockAccepted=true }
      else if (type==="CONFIG") { if (!phase.ready || configured) nativeFailure("schema"); configured=true }
      else if (type==="START") { if (!phase.configured || phase.parentSTARTSent) nativeFailure("schema"); phase.parentSTARTSent=true }
      else if (type==="CANCEL") { if (phase.cancelSent) nativeFailure("schema"); phase.cancelSent=true }
      else if (type==="SEAL") { if (!phase.controlComplete || phase.sealSent) nativeFailure("schema"); phase.sealSent=true }
      else if (type==="CONTINUE") { if (!barrier || !phase.cancelSent || continued) nativeFailure("schema"); continued=true }
      else if (type==="RESUME_SERVER") { if (prefix!=="C14" || !barrier || !replacement || continued) nativeFailure("schema"); continued=true }
      else nativeFailure("schema")
    },
    native(value) {
      const event=fixtureProtocol.validateFixtureEvent(value)
      if (event.type==="STATE" && event.mode!==prefix) nativeFailure("case_mismatch")
      if (event.type==="STATE" && prefix==="C06" && event.phase==="OBSERVER_PENDING") {
        if (barrier || !phase.clockAccepted || !event.ownerCaptured ||
          !event.created || !event.assigned || !event.resumed || !event.pendingRead || event.startIssued)
          nativeFailure("case_mismatch")
        barrier=true; return ["LOSE_CONTROL"]
      }
      if (event.type==="STATE" && prefix==="C14" && event.phase==="SERVER_CLOSED") {
        if (barrier || phase.ready || !phase.clockAccepted || !event.ownerCaptured || !event.created ||
          !event.assigned || !event.resumed || !event.rootLiveActual || event.startIssued) nativeFailure("case_mismatch")
        barrier=true; return ["REPLACE_SERVER"]
      }
      if (event.type==="STATE" && prefix==="C15" && event.phase==="ROOT_LIVE") {
        if (rootLive || !phase.parentSTARTSent || !event.ownerCaptured || !event.created || !event.assigned ||
          !event.resumed || !event.startIssued || !event.rootLiveActual || !event.anyJobMemberActual ||
          !event.assignmentModeled) nativeFailure("case_mismatch")
        rootLive=true; return cancelStranded()
      }
      const wanted=prefix==="O02"?"CREATED_SUSPENDED":prefix==="O03"?"ASSIGNED_SUSPENDED":null
      if (event.type!=="STATE" || event.phase!==wanted) return []
      if (event.mode!==prefix || barrier || phase.ready || !phase.clockAccepted || !event.ownerCaptured ||
        !event.created || event.resumed || event.rootLiveActual!==true ||
        event.assigned!==(prefix==="O03")) nativeFailure("case_mismatch")
      barrier=true; return ["CANCEL","CONTINUE"]
    },
    witness(type) {
      if (!["C07","C15"].includes(prefix) || type!=="WORKLOAD_STARTED" || work || !phase.parentSTARTSent) nativeFailure("schema")
      work=true; return prefix==="C15"?cancelStranded():[]
    },
    replacementReady() {
      if (prefix!=="C14" || !barrier || replacement || continued) nativeFailure("schema")
      replacement=true; return ["RESUME_SERVER"]
    },
    snapshot:() => ({phase:{...phase},work,rootLive,alive:false,hook:false,barrier,continued,replacement,
      classification:["C16","C18"].includes(prefix)?"modeled-clock-refusal":prefix==="C17"?"invalid-deadline-input":
        p.evidenceClass==="B"?"test-root":"source-api-fault"}),
  }
}
function createFixtureCaseEvidence({id,deadlineNs,Hns=null}) {
  const p=generationCasePlan(id), prefix=id.split("-")[0]
  if (p.evidenceClass!=="C") nativeFailure("schema")
  let entry=null, footer=null, state=null, count=0, failed=false
  const phases=new Set()
  return {
    observe(input) {
      try {
      const value=fixtureProtocol.validateFixtureEvent(input)
      if (failed || footer || ++count>32 || (Object.hasOwn(value,"deadlineNs") && value.deadlineNs!==deadlineNs)) nativeFailure("schema")
      if (value.type==="STATE") {
        if (entry || value.mode!==prefix || value.telemetryGap || !value.ownerCaptured) nativeFailure("schema")
        phases.add(value.phase); state=value
      } else if (value.type==="ENTRY_RESULT") {
        if (entry) nativeFailure("schema")
        entry=value
      } else if (value.type==="CLOSED") footer=value
      else nativeFailure("schema")
      } catch (error) { failed=true; throw error }
    },
    complete({ownerFullclose,ownerExitObserved=false,controlEOF,controlClosed,controlFailed,withinDeadline,closedAtNs=null}) {
      const cleanupBoundary=!withinDeadline && typeof Hns==="string" && typeof closedAtNs==="string" &&
        BigInt(Hns)>20000000000n && BigInt(closedAtNs)>=BigInt(deadlineNs) &&
        BigInt(closedAtNs)<BigInt(Hns)-20000000000n
      const cleanupOnly=cleanupBoundary && (prefix==="C03" ?
        entry?.creationCalls===0 && entry.expiredBeforeEntry && entry.ownerFreed && footer?.ownerFreed :
        entry?.ownerFreed===false && footer?.ownerFreed===false && state?.phase==="TEARDOWN" &&
        (prefix==="O05" ? state.queryModeled && state.rootRetiredReported && !state.privateZeroReported :
          ["C04","C05","C06","C07"].includes(prefix) && state.assigned &&
          !state.assignmentModeled && !state.membershipModeled && !state.rootWaitModeled))
      const quarantineReady=prefix==="C15" && withinDeadline && ownerExitObserved && !ownerFullclose &&
        entry?.ownerFreed===true && footer?.ownerFreed===true && state?.phase==="FINAL" &&
        state.created && state.assigned && state.resumed && state.startIssued && state.rootLiveActual===true &&
        state.anyJobMemberActual===true && state.assignmentModeled && state.membershipModeled &&
        state.queryModeled && state.rootWaitModeled && phases.has("ROOT_LIVE")
      if (failed || controlFailed===true || !entry || !footer || (!ownerFullclose && !quarantineReady) || !controlEOF || !controlClosed ||
        (!withinDeadline && !cleanupOnly) || ((!entry.ownerFreed || !footer.ownerFreed) && !cleanupOnly) || footer.telemetryGap ||
        entry.creationCalls!==footer.creationCalls) return null
      const zeroCreation=entry.creationCalls===0
      if (state?.created && entry.creationCalls!==1) return null
      if (!state && !(zeroCreation && (prefix==="C17" && entry.deadlineInputModeled || prefix==="C03" && entry.expiredBeforeEntry))) return null
      if (state && (state.membershipModeled || state.rootWaitModeled) && !quarantineReady) return null
      return structuredClone({entry,footer,state,phases:[...phases],zeroCreation,cleanupOnly,quarantineReady,
        classification:prefix==="C17"?"invalid-deadline-input":["C16","C18"].includes(prefix)?"modeled-clock-refusal":"source-api-fault"})
    },
  }
}
function matchFixtureCase(plan,g,facts) {
  const prefix=plan.id.split("-")[0], b=plan.evidenceClass==="B"?Number(prefix.slice(1)):0
  if (prefix==="C15") return !!(g && facts.native?.quarantineReady && facts.decision?.work && facts.decision.rootLive &&
    facts.native.footer.requests===facts.controlRequests && g.invocation==="HOLD" && g.certificate===null &&
    g.certificateOrigin==="withheld-model" && g.phase.nativeSTARTIssued===true && g.phase.cancelSent &&
    g.joins.ownerExitObserved && !g.joins.ownerCloseObserved && !g.data.dataComplete &&
    g.resources.modelStrandedRoot===1 && BigInt(g.finishedNs)<BigInt(g.deadlineNs))
  const cleanup=["O05","C03","C04","C05","C06","C07"].includes(prefix) &&
    facts.native?.cleanupOnly===true && g?.invocation==="HOLD" && g.certificate===null
  if (!g || !g.data.dataComplete || !Object.entries(g.joins).every(([k,v]) => k==="origin" || v===true) ||
    (BigInt(g.finishedNs)>=BigInt(g.deadlineNs) && !cleanup) || g.invocation==="success") return false
  const cert=g.certificate, s=facts.native?.state, e=facts.native?.entry, footer=facts.native?.footer
  const notStarted=cert?.commandState==="not_started" && !g.phase.parentSTARTSent && cert.startIssued===false &&
    g.invocation==="failed-proved"
  const realResult=g.result?.command.state==="exited" && g.result.command.code===0 && g.result.command.signal===null &&
    g.result.input.state==="complete"
  if (b) {
    if (g.resources.rootCreated!==1 || !cert || g.terminalFailure!=="protocol" ||
      g.phase.controlComplete || g.phase.sealSent) return false
    if (b===1) return notStarted && !g.phase.ready && facts.peer?.rootLive===true &&
      facts.peer.connected===true && facts.peer.closed===true && facts.peer.receivedBytes===0
    if (b>=2 && b<=7) return realResult && cert.commandState==="reported" && cert.startIssued &&
      g.phase.resultReceived && g.terminalFailure==="protocol" && g.invocation==="failed-proved" &&
      typeof facts.originalResultB64==="string" && g.resultB64===facts.originalResultB64 &&
      cert.resultB64===facts.originalResultB64 && facts.terminalResultB64===facts.originalResultB64 &&
      facts.released===true
    if (b===8) return cert.commandState==="unknown" && cert.startIssued && g.phase.parentSTARTSent &&
      !g.phase.resultReceived && g.result===null && g.resultB64===null && g.invocation==="failed-proved"
    if (b===9) return notStarted && facts.pressure?.kernelCredit===false && facts.pressure.bufferedBytes>0 &&
      facts.pressure.bufferedBytes<=1048576 && facts.pressure.submittedBytes>0 &&
      facts.pressure.submittedBytes<=1048576 && typeof facts.pressure.needDrain==="boolean"
    return notStarted && g.phase.ready && facts.badPeer?.submittedBytes>0 && facts.badPeer.submittedBytes<=1048576 &&
      facts.badPeer.paused===true && facts.badPeer.resumed===true
  }
  if (!facts.native || !e || !footer || footer.requests!==facts.controlRequests) return false
  if (prefix==="C03") return cleanup && facts.native.zeroCreation && e.expiredBeforeEntry && e.ownerFreed &&
    g.resources.rootCreated===0 && !g.phase.clockReady && !g.phase.parentSTARTSent &&
    g.phase.nativeSTARTIssued===false
  if (["C04","C05","C06","C07"].includes(prefix)) {
    if (!cleanup || !s || !s.created || !s.assigned || s.assignmentModeled || s.membershipModeled ||
      s.queryModeled || s.rootWaitModeled || e.ownerFreed || s.phase!=="TEARDOWN" ||
      g.phase.nativeSTARTIssued!==s.startIssued) return false
    if (prefix==="C04") return !s.resumed && !s.startIssued && !g.phase.parentSTARTSent &&
      facts.native.phases.includes("ASSIGNED_SUSPENDED")
    if (prefix==="C05") return s.resumed && !s.startIssued && g.phase.parentSTARTSent &&
      facts.native.phases.includes("BEFORE_NATIVE_START")
    if (prefix==="C06") return s.resumed && !s.startIssued && !g.phase.parentSTARTSent &&
      facts.controlLost && facts.decision?.barrier && facts.native.phases.includes("OBSERVER_PENDING")
    return s.resumed && s.startIssued && s.ioRouteInstrumented && s.cancelWriteRequested && (s.pendingWrite || s.writeReaped) &&
      s.storageRetained && g.phase.parentSTARTSent
  }
  if (["C16","C17","C18"].includes(prefix)) return facts.native.zeroCreation &&
    !g.phase.parentSTARTSent && !g.phase.ready && g.resources.rootCreated===0 &&
    cert===null && g.invocation==="HOLD" && (prefix==="C17" ? e.deadlineInputModeled && !e.clockModeled :
      e.clockModeled && s?.clockModeled===true)
  if (!s || !s.created || !s.rootRetiredReported || s.startIssued!==g.phase.nativeSTARTIssued) return false
  if (prefix==="O05") return (cleanup?g.terminalFailure===null:g.terminalFailure==="retirement") &&
    s.queryModeled && !s.privateZeroReported && realResult && g.phase.controlComplete && g.phase.sealSent &&
    [g.data.resultAtNs,g.data.controlCompleteAtNs,g.data.sealAtNs].every((n) => n!==null && BigInt(n)<BigInt(g.deadlineNs)) &&
    cert===null && g.invocation==="HOLD"
  if (prefix==="C14") return notStarted && facts.decision?.barrier && facts.decision.continued &&
    facts.decision.replacement && facts.replacementUnexpectedClient===false &&
    facts.native.phases.includes("SERVER_CLOSED") && s.assigned && s.resumed &&
    !s.assignmentModeled && !s.membershipModeled && !s.queryModeled && !s.rootWaitModeled &&
    g.terminalFailure==="io" && s.privateZeroReported && !s.startIssued
  if (!notStarted || !s.privateZeroReported || s.startIssued || s.queryModeled) return false
  if (["O02","O03"].includes(prefix)) return g.terminalFailure==="prepare" && facts.decision?.barrier===true && facts.decision.continued &&
    g.phase.cancelSent && !s.resumed && (prefix==="O02" ? s.assignmentModeled && !s.assigned :
      s.resumeModeled && s.assigned)
  if (prefix==="O06") return g.terminalFailure==="prepare" && s.resumeModeled && s.assigned && !s.resumed
  if (prefix==="O07") return g.terminalFailure==="prepare" && s.assignmentModeled && !s.assigned && !s.resumed
  return ["C09","C10","C11","C12","C13"].includes(prefix) && g.terminalFailure==="protocol" && s.authMutated && s.assigned && s.resumed
}
function createClassADecisions({ id,slot }) {
  const p=classAPlan(id), prefix=id.split("-")[0]
  if (!Number.isInteger(slot) || slot<0 || slot>=p.expected.generations) nativeFailure("schema")
  const phase=Object.fromEntries(["clockReady","clockAccepted","ready","configured","parentSTARTSent",
    "resultReceived","controlComplete","sealSent","cancelSent"].map((k) => [k,false]))
  let configSent=false, terminal=false, work=false, alive=false, hook=false
  return {
    frame(type) {
      if (terminal) nativeFailure("schema")
      if (type==="CLOCK_READY") {
        if (phase.clockReady) nativeFailure("schema")
        phase.clockReady=true; return ["CLOCK_ACCEPT"]
      }
      if (type==="READY") {
        if (!phase.clockAccepted || phase.ready) nativeFailure("schema")
        phase.ready=true
        return prefix==="O04" ? ["CANCEL"] : prefix==="A21" ? ["LOSE_OWNER"] :
          prefix==="A11" && slot===1 ? [] : ["CONFIG"]
      }
      if (type==="CONFIGURED") {
        if (!configSent || phase.configured) nativeFailure("schema")
        phase.configured=true
        return prefix==="A10" ? ["CANCEL"] : prefix==="A18" ? [] : ["START"]
      }
      if (type==="RESULT") {
        if (!phase.parentSTARTSent || phase.resultReceived) nativeFailure("schema")
        phase.resultReceived=true; return p.profile==="G_BASELINE" || prefix==="A14" ? ["ALIVE"] : []
      }
      if (type==="CONTROL_COMPLETE") {
        if (!phase.resultReceived || phase.controlComplete) nativeFailure("schema")
        phase.controlComplete=true
        return p.profile==="G_BASELINE" || prefix==="A14" ? alive?["SEAL"]:[] : ["SEAL"]
      }
      if (type==="TERMINAL") { terminal=true; return [] }
      nativeFailure("schema")
    },
    sent(type) {
      if (type==="CLOCK_ACCEPT") { if (!phase.clockReady || phase.clockAccepted) nativeFailure("schema"); phase.clockAccepted=true }
      else if (type==="CONFIG") { if (!phase.ready || configSent) nativeFailure("schema"); configSent=true }
      else if (type==="START") { if (!phase.configured || phase.parentSTARTSent) nativeFailure("schema"); phase.parentSTARTSent=true }
      else if (type==="CANCEL") { if (phase.cancelSent) nativeFailure("schema"); phase.cancelSent=true }
      else if (type==="SEAL") {
        if (!phase.controlComplete || phase.sealSent ||
          ((p.profile==="G_BASELINE" || prefix==="A14") && !alive)) nativeFailure("schema")
        phase.sealSent=true
      } else nativeFailure("schema")
    },
    witness(type) {
      if (type==="WORKLOAD_STARTED") {
        if (!phase.parentSTARTSent || work) nativeFailure("schema")
        work=true
        return prefix==="O08" ? ["LOSE_CONTROL"] : prefix==="O09" ? ["LOSE_OWNER"] :
          prefix==="A17" ? ["PAUSE_CONTROL"] : prefix==="A25" ? ["PREDEATH"] : []
      }
      if (type==="HOOK_RAN") { if (prefix!=="A24" || hook || !phase.parentSTARTSent) nativeFailure("schema"); hook=true; return [] }
      if (type==="ALIVE") {
        if (!phase.resultReceived || phase.sealSent || alive) nativeFailure("schema")
        alive=true; return phase.controlComplete?["SEAL"]:[]
      }
      nativeFailure("schema")
    },
    releaseUnused(result) {
      if (prefix!=="A11" || slot!==1 || !phase.ready || phase.parentSTARTSent || phase.cancelSent ||
        result?.command.state!=="exited" || result.command.code!==7 || result.command.signal!==null) nativeFailure("case_mismatch")
      return ["CANCEL"]
    },
    snapshot:() => ({ phase:{...phase},work,alive,hook }),
  }
}
function matchClassACase(plan, generations, facts) {
  const prefix=plan.id.split("-")[0], allJoined=(g) => Object.entries(g.joins).every(([k,v]) => k==="origin" || v===true)
  if (generations.length!==plan.expected.generations || !generations.every((g) => allJoined(g) && g.data.dataComplete)) return false
  const g=generations[0], result=g.result, command=result?.command
  const proved=(x) => x.certificate!==null && x.invocation==="failed-proved"
  const notStarted=(x) => proved(x) && x.certificate.commandState==="not_started" && !x.phase.parentSTARTSent
  const reported=(x) => proved(x) && x.certificate.commandState==="reported" && x.phase.controlComplete && x.phase.sealSent
  if (["O01","X01","A14","A23"].includes(prefix)) return g.invocation==="success" && g.resources.rootLiveAfterResult===true
  if (prefix==="O04" || prefix==="A10") return notStarted(g) && (prefix==="O04" ? g.phase.ready : g.phase.configured)
  if (prefix==="A11") return reported(g) && command?.code===7 && notStarted(generations[1])
  if (prefix==="A12") return reported(g) && command?.state==="exited" && command.code===7 && command.signal===null
  if (prefix==="A13") return reported(g) && command?.state==="spawn_failed" && command.code==="ENOENT"
  if (prefix==="A15") return reported(g) && command?.code===9 && result.input.state==="failed" && result.input.errorCode==="EPIPE"
  if (prefix==="A16") return proved(g) && g.certificate.commandState==="unknown" && g.phase.cancelSent &&
    g.data.combinedOverflow && !g.phase.resultReceived
  if (prefix==="A20") return notStarted(g) && g.resources.rootCreated===0 && facts.collision===true
  if (prefix==="A24") return g.invocation==="success" && facts.hook===true
  if (prefix==="A22") {
    const times=["resultAtNs","controlCompleteAtNs","sealAtNs","terminalAtNs","ownerCloseAtNs"].map((k) => g.data[k])
    return g.invocation==="success" && times.every((n,i) => n!==null && BigInt(n)<BigInt(g.deadlineNs) &&
      (i===0 || BigInt(n)>=BigInt(times[i-1])))
  }
  if (["A17","A18","A19"].includes(prefix)) return g.invocation==="HOLD" && g.certificate===null &&
    BigInt(g.finishedNs)>=BigInt(g.deadlineNs) && (prefix==="A18" ? g.phase.configured && !g.phase.parentSTARTSent :
      g.phase.parentSTARTSent && facts.work && (prefix!=="A17" || facts.paused))
  if (prefix==="O08") return g.invocation==="HOLD" && g.certificate===null && facts.work && facts.controlLost &&
    BigInt(g.finishedNs)<BigInt(g.deadlineNs)
  if (prefix==="O09" || prefix==="A21") return g.invocation==="HOLD" && g.certificate===null && facts.ownerLost &&
    (prefix==="O09" ? facts.work : g.phase.ready && !g.phase.parentSTARTSent)
  return false
}
function generationInvocation({success,certificate,fullclose,timely}) {
  if (certificate===null || !fullclose || !timely) return "HOLD"
  return success ? "success" : "failed-proved"
}
function primaryFailureExpected({id,primary,primaryOrigin,primaryAtNs,deadlineNs,cleanupOnly,zeroCreation,controlLost}) {
  const prefix=id.split("-")[0]
  if (primary===null) return true
  if (["O08","O09","A21"].includes(prefix) && primary==="io") return true
  if (["A17","A18","A19"].includes(prefix) && primary==="deadline") return true
  if (prefix==="O05" && primary==="deadline" && cleanupOnly) return true
  if (["C03","C04","C05","C06","C07"].includes(prefix) && cleanupOnly) {
    if (prefix==="C06" && primary==="io" && primaryOrigin==="intentional-control-loss" && controlLost) return true
    return ["deadline","io","protocol"].includes(primary) && primaryAtNs!==null &&
      BigInt(primaryAtNs)>=BigInt(deadlineNs)
  }
  return ["C16","C17","C18"].includes(prefix) && zeroCreation && ["protocol","io"].includes(primary)
}
function caseDisposition(generations,expected) {
  if (![1,2].includes(expected) || generations.length>expected) nativeFailure("schema")
  if (generations.length!==expected || generations.some((g) => g.invocation==="HOLD")) return "HOLD"
  return generations.every((g) => g.invocation==="success")?"success":"failed-proved"
}
function readBoundPublicFile(file,limit) {
  const before=fs.lstatSync(file)
  if (!before.isFile() || before.isSymbolicLink() || before.size>limit) nativeFailure("guard_failed")
  const bytes=fs.readFileSync(file), after=fs.lstatSync(file)
  if (before.dev!==after.dev || before.ino!==after.ino || before.size!==bytes.length ||
    before.size!==after.size || before.mtimeMs!==after.mtimeMs || after.isSymbolicLink()) nativeFailure("identity_changed")
  return bytes
}
function fixtureGit(construction,deadline) {
  const scope=fixtureConstructions.get(construction)
  if (!scope || !core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")
  const git=require("./windows_owned_git_retention.cjs").projectGitBinding(
    core.parseJSON(readBoundPublicFile(path.join(scope.fixtureRoot,"git-binding.json"),4096),4096),
    {...scope.expectedSource,fixtureRoot:scope.fixtureRoot})
  for (const [file, digest] of require("./windows_owned_git_retention.cjs").externalGitComponents(git,path.dirname(scope.privateRealmRoot))) {
    if (crypto.createHash("sha256").update(readBoundPublicFile(file,33554432)).digest("hex")!==digest ||
      !core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("runtime_mismatch")
  }
  return Object.freeze(git)
}
function fixtureEnvironment() {
  const env={}
  for (const name of ["SystemRoot","WINDIR","SystemDrive","COMSPEC","PATH","TEMP","TMP","PATHEXT"])
    if (process.env[name]!==undefined) env[name]=process.env[name]
  return { ...env,GIT_CONFIG_NOSYSTEM:"1",GIT_CONFIG_GLOBAL:"NUL",GIT_TERMINAL_PROMPT:"0",GCM_INTERACTIVE:"never" }
}
function syntheticGitConfiguration() {
  const sections = [
    ["core", ["repositoryformatversion = 0", "bare = false", "logallrefupdates = false", "symlinks = false",
      "fsmonitor = false", "untrackedcache = false", "preloadindex = false", "splitindex = false",
      "sparsecheckout = false", "hookspath = ../../public/fixtures/hooks", "compression = 0",
      "loosecompression = 0", "fsync = none", "fsyncmethod = fsync"]],
    ["gc", ["auto = 0", "autodetach = false"]], ["maintenance", ["auto = false"]],
    ["commit", ["gpgsign = false", "status = false", "cleanup = verbatim"]], ["rerere", ["enabled = false"]],
    ["index", ["version = 2", "threads = 1", "recordendofindexentries = false", "recordoffsettable = false", "sparse = false"]],
    ["feature", ["manyfiles = false", "experimental = false"]], ["init", ["defaultbranch = na1"]],
  ]
  const bytes = Buffer.from(sections.map(([name, values]) => `[${name}]\n${values.map((v) => `\t${v}\n`).join("")}`).join(""), "ascii")
  if (bytes.length !== 658 || crypto.createHash("sha256").update(bytes).digest("hex") !==
    "72427377f73fb4c02c37b86c95177d769c91cd60293e967f605ab40e78efc6dc") nativeFailure("source_mismatch")
  return bytes
}
function buildGitEnvironment({ privateRoot, fixtureRoot, nodeExecutable, gitExecutable, shellExecutable, ambient = process.env }) {
  const layout=require("./windows_owned_git_retention.cjs").gitExecutionLayout({
    fixtureRoot,nodeExecutable,gitExecutable,shellExecutable,systemRoot:ambient.SystemRoot})
  for (const file of [privateRoot, nodeExecutable, gitExecutable, shellExecutable, ambient.SystemRoot]) {
    if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n;]/.test(file)) nativeFailure("guard_failed")
  }
  const env = {}
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATHEXT"]) {
    if (ambient[key] !== undefined) env[key] = ambient[key]
  }
  const scratch = path.join(privateRoot, "runtime-scratch")
  return { ...env, PATH: layout.basePath.join(";"), GIT_EXEC_PATH:layout.execPath,
  MSYSTEM:"MINGW64",MSYS2_ENV_CONV_EXCL:"GIT_EXEC_PATH=",
  GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(privateRoot, "git-global-empty.cfg"),
  GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  LANG: "C", LC_ALL: "C", LANGUAGE: "C", HOME: scratch, USERPROFILE: scratch, TEMP: scratch, TMP: scratch, TMPDIR: scratch }
}
function verifyFixtureGitExecution(scope,git,node,deadline) {
  const r=require("./windows_owned_git_retention.cjs")
  const layout=r.gitExecutionLayout({fixtureRoot:scope.fixtureRoot,nodeExecutable:node,
    gitExecutable:git.executable,shellExecutable:git.shellExecutable,systemRoot:process.env.SystemRoot})
  if (layout.execPath!==git.execPath) nativeFailure("source_mismatch")
  const snapshot=r.inspectGitExecution(layout,{mountConfigSha256:git.mountConfigSha256,
    live:() => {if (!core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")}})
  scope.gitSnapshots ||= new Map()
  if (scope.gitSnapshots.has(node) && scope.gitSnapshots.get(node)!==snapshot) nativeFailure("identity_changed")
  scope.gitSnapshots.set(node,snapshot)
  return layout
}
function stageSyntheticGitFiles({ privateRoot, live, io = fs }) {
  if (typeof privateRoot !== "string" || !path.isAbsolute(privateRoot) || typeof live !== "function") nativeFailure("guard_failed")
  const bytes = syntheticGitConfiguration()
  if (bytes.length > 1024) nativeFailure("quota")
  const repository = path.join(privateRoot, "synthetic-repository")
  for (const directory of [repository, path.join(repository, ".git"), path.join(privateRoot, "runtime-scratch")]) {
    live(); io.mkdirSync(directory)
  }
  for (const [file, data] of [[path.join(repository, ".git", "config"), bytes],
    [path.join(privateRoot, "git-global-empty.cfg"), Buffer.alloc(0)]]) {
    live()
    const fd = io.openSync(file, "wx", 0o600)
    try {
      let at = 0
      while (at < data.length) {
        live()
        const n = io.writeSync(fd, data, at, data.length - at)
        if (!n) nativeFailure("guard_failed")
        at += n
      }
      io.fsyncSync(fd)
    } finally { io.closeSync(fd) }
  }
  live()
  return Object.freeze({ repository })
}
async function initializeSyntheticRepository(construction) {
  const scope=fixtureConstructions.get(construction), now=process.hrtime.bigint()
  if (!scope || scope.repositoryAttempted || now>=scope.H-30000000000n) nativeFailure("not_admitted")
  scope.repositoryAttempted=true
  const deadline={clock:"win-qpc-ns/1",expiresNs:now+10000000000n<scope.H-30000000000n ? now+10000000000n : scope.H-30000000000n}
  const git=fixtureGit(construction,deadline), node=await getFixtureRuntime(construction,"24")
  const live = () => { if (!core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline") }
  const layout=verifyFixtureGitExecution(scope,git,node.path,deadline)
  const {repository:repo}=stageSyntheticGitFiles({privateRoot:scope.privateRealmRoot,live})
  const env=buildGitEnvironment({privateRoot:scope.privateRealmRoot,fixtureRoot:scope.fixtureRoot,nodeExecutable:node.path,
    gitExecutable:git.executable,shellExecutable:git.shellExecutable})
  if (!core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")
  const child=spawn(git.executable,require("./windows_owned_git_retention.cjs").gitArguments(layout,
    ["init","--quiet","--template=","--initial-branch=na1","--object-format=sha1","--ref-format=files",repo]),{
    cwd:scope.publicMcpRoot,env,windowsHide:true,stdio:["ignore","overlapped","overlapped"] })
  const states={stdout:{end:false,close:false},stderr:{end:false,close:false}}
  let bytes=0,failed=false,exit=false,code=null,signal=null
  const stop=() => { failed=true; try { child.kill("SIGTERM") } catch { /* Original setup actor only. */ } }
  const timer=setTimeout(stop,Math.max(0,Number((deadline.expiresNs-process.hrtime.bigint())/1000000n)))
  for (const name of ["stdout","stderr"]) {
    child[name].on("data",(chunk) => { bytes+=chunk.length; if (bytes>65536) stop() })
    child[name].on("end",() => { states[name].end=true })
    child[name].on("close",() => { states[name].close=true })
    child[name].on("error",stop)
  }
  child.once("error",stop); child.once("exit",(c,s) => { exit=true; code=c; signal=s })
  await new Promise((resolve) => child.once("close",resolve)); clearTimeout(timer)
  if (failed || !exit || code!==0 || signal!==null || Object.values(states).some((s) => !s.end||!s.close) ||
    !core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("producer_unjoined")
  verifyFixtureGitExecution(scope,git,node.path,deadline)
  scope.repositoryReady=true
}
function createDescendantObservations() {
  const seen=new Set()
  return {
    event(type) {
      if (!["READY","ALIVE","EOF","CLOSE","ABORT"].includes(type) || seen.has(type)) nativeFailure("schema")
      if (type==="ALIVE" && !seen.has("READY")) nativeFailure("schema")
      seen.add(type)
    },
    snapshot:() => ({ fullcloseObserved:["READY","ALIVE","EOF","CLOSE"].every((k) => seen.has(k)) && !seen.has("ABORT") }),
  }
}
async function createGenerationWitness(deadline,onCue,onFailure) {
  const nonce=crypto.randomBytes(32).toString("hex"), endpoint=`\\\\.\\pipe\\desk-owned-git-witness-${crypto.randomBytes(32).toString("hex")}`
  const sockets=new Set(), seen=new Set()
  const observation=createDescendantObservations()
  let descendant=null, probing=false, probeResolve=null, probeReject=null, stopped=false, accepted=0, retireResolve=null, retireReject=null
  function joined() {
    if (observation.snapshot().fullcloseObserved && core.remainingNanoseconds(deadline,process.hrtime.bigint())) retireResolve?.()
  }
  const server=net.createServer({allowHalfOpen:true},(socket) => {
    if (stopped || ++accepted>3) { socket.destroy(); onFailure("quota"); stop(); return }
    sockets.add(socket); let text="", kind=null
    socket.on("data",(bytes) => {
      try {
        if (!core.remainingNanoseconds(deadline,process.hrtime.bigint()) || text.length+bytes.length>128 ||
          bytes.some((b) => b>127)) nativeFailure("deadline")
        text+=bytes.toString("ascii")
        if (!text.endsWith("\n")) return
        if (kind==="descendant") {
          if (text!=="ALIVE\n" || !probing) nativeFailure("schema")
          text=""; probing=false; observation.event("ALIVE"); probeResolve?.(); probeResolve=null; probeReject=null
        } else if (text===`WITNESS_READY ${nonce}\n`) {
          if (descendant) nativeFailure("schema")
          descendant=socket; kind="descendant"; observation.event("READY"); text=""; if (probeResolve) sendProbe()
        } else {
          const cue=text===`WORKLOAD_STARTED ${nonce}\n` ? "WORKLOAD_STARTED" : text===`HOOK_RAN ${nonce}\n` ? "HOOK_RAN" : null
          if (!cue || seen.has(cue)) nativeFailure("schema")
          seen.add(cue); kind="cue"; text=""; onCue(cue); socket.end()
        }
      } catch { onFailure("protocol"); socket.destroy(); probeReject?.(new Error("witness")) }
    })
    socket.on("end",() => { if (socket===descendant && !stopped) { observation.event("EOF"); socket.end(); joined() } })
    socket.on("error",() => { if (!stopped) { onFailure("io"); probeReject?.(new Error("witness")) } })
    socket.on("close",() => { sockets.delete(socket)
      if (socket===descendant && !stopped) { observation.event("CLOSE"); joined()
        if (probeResolve) probeReject?.(new Error("witness")) }
    })
  })
  server.maxConnections=3
  function sendProbe() {
    if (probing || !descendant || !probeResolve) return
    if (!core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")
    probing=true
    descendant.write("ALIVE\n",(error) => { if (error) probeReject?.(error) })
  }
  const closed=new Promise((resolve) => server.once("close",resolve))
  function stop() {
    if (stopped) return
    stopped=true; clearTimeout(timer)
    if (!observation.snapshot().fullcloseObserved) observation.event("ABORT")
    probeReject?.(new Error("witness")); probeResolve=null; probeReject=null; retireReject?.(new Error("witness"))
    for (const socket of sockets) socket.destroy()
    try { server.close() } catch { /* Never substitute for owner/data closure. */ }
  }
  const timer=setTimeout(() => { onFailure("deadline"); stop() },Math.max(0,Number((deadline.expiresNs-process.hrtime.bigint())/1000000n)))
  server.on("error",() => { onFailure("io"); stop() })
  await new Promise((resolve,reject) => { server.once("error",reject); server.listen(endpoint,resolve) })
  return { endpoint,nonce,closed,stop,probe() {
    if (stopped || probeResolve) nativeFailure("schema")
    return new Promise((resolve,reject) => { probeResolve=resolve; probeReject=reject; try { sendProbe() } catch (e) { reject(e) } })
  }, retired() {
    if (stopped || !core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")
    if (observation.snapshot().fullcloseObserved) return Promise.resolve()
    return new Promise((resolve,reject) => { retireResolve=resolve; retireReject=reject })
  } }
}
function classAPayload({ plan,slot,scope,root,git,deadline,witness,ambient=process.env }) {
  const w=require("./windows_owned_git_workload.cjs"), prefix=plan.id.split("-")[0]
  const profile=plan.profile==="NONE" ? "G_EXIT0" : plan.profile
  if (profile==="G_COMMIT" && (!path.isAbsolute(scope.fixtureRoot) || scope.fixtureRoot.includes("="))) nativeFailure("guard_failed")
  const repo=path.join(scope.privateRealmRoot,"synthetic-repository")
  const layout=require("./windows_owned_git_retention.cjs").gitExecutionLayout({fixtureRoot:scope.fixtureRoot,
    nodeExecutable:root.path,gitExecutable:git.executable,shellExecutable:git.shellExecutable,systemRoot:ambient.SystemRoot})
  const env={...buildGitEnvironment({privateRoot:scope.privateRealmRoot,fixtureRoot:scope.fixtureRoot,nodeExecutable:root.path,
    gitExecutable:git.executable,shellExecutable:git.shellExecutable,ambient}),
    DESK_TEST_OWNED_GIT_CASE:plan.id,DESK_TEST_OWNED_GIT_D:deadline.expiresNs.toString(),
    DESK_TEST_OWNED_GIT_PUBLIC_FIXTURES:scope.fixtureRoot,DESK_TEST_OWNED_GIT_WITNESS:witness.endpoint,
    DESK_TEST_OWNED_GIT_WITNESS_NONCE:witness.nonce}
  if (profile==="G_BASELINE" || prefix==="A14" || prefix==="A24") {
    env.NODE_OPTIONS=`--require "${path.join(scope.fixtureRoot,"windows_owned_git_preload.cjs")}"`
    env.NODE_PATH=scope.fixtureRoot; env.DESK_TEST_OWNED_GIT_MARKER=path.join(scope.privateRealmRoot,"markers",`${plan.id}.json`)
  }
  const args=profile==="G_COMMIT" ? ["-c","user.name=NC31","-c","user.email=nc31@example.invalid",
    "-c",`core.hooksPath=${path.join(scope.fixtureRoot,"hooks")}`,"commit","--allow-empty","-m","NC31"] :
    profile==="MISSING_GIT" ? ["status","--porcelain"] :
    plan.evidenceClass==="B" ? ["-c","alias.owned=!exit 0","owned"] :
    ["-c",`alias.owned=${w.fixedAlias(root.path,path.join(scope.fixtureRoot,"windows_owned_git_workload.cjs"),profile,plan.id)}`,"owned"]
  return { executable:profile==="MISSING_GIT" ? path.join(scope.fixtureRoot,"na1-missing-git.exe") : git.executable,
    args:require("./windows_owned_git_retention.cjs").gitArguments(layout,args),cwd:repo,env,stdin:profile==="G_BASELINE" ? w.binaryInput(4096) :
      ["G_STDIN512K","G_EPIPE"].includes(profile) ? w.binaryInput(524288) : null }
}
async function runGenerationCase({ construction,plan,deadline,emitClock,registerActor,isCancelled }) {
  generationCasePlan(plan.id)
  const fixtureCase=plan.evidenceClass!=="A", nativeCase=plan.evidenceClass==="C"
  const r=require("./windows_owned_git_retention.cjs"), scope=fixtureConstructions.get(construction)
  if (!scope || isCancelled() || !core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")
  const parent=await getFixtureRuntime(construction,plan.parent), root=await getFixtureRuntime(construction,plan.root)
  if (process.execPath!==parent.path || process.versions.node!==parent.version) nativeFailure("runtime_mismatch")
  const git=fixtureGit(construction,deadline), repo=path.join(scope.privateRealmRoot,"synthetic-repository")
  if (!fs.lstatSync(path.join(repo,".git","HEAD")).isFile()) nativeFailure("not_admitted")
  const actors=[], clocks=[], clockSends=[], facts={work:false,paused:false,ownerLost:false,controlLost:false,hook:false,collision:false,
    controlRequests:0,originalResultB64:null,terminalResultB64:null,released:false}
  let discovery=null, sibling=null, caseGap="none", caseSpecial=null
  async function generation(slot) {
    const decision=fixtureCase?createFixtureDecisions({id:plan.id,slot}):createClassADecisions({id:plan.id,slot})
    const evidence=nativeCase?createFixtureCaseEvidence({id:plan.id,deadlineNs:deadline.expiresNs.toString(),Hns:scope.H.toString()}):null
    const auxiliary=[]
    const token=crypto.randomBytes(16).toString("hex")
    const privateRoot=path.join(scope.privateRealmRoot,"generations",plan.id,String(slot))
    fs.mkdirSync(path.dirname(privateRoot),{recursive:true})
    fs.mkdirSync(path.join(scope.privateRealmRoot,"markers"),{recursive:true})
    const prepareBinding={generation:crypto.randomBytes(32).toString("hex"),recordId:crypto.randomBytes(32).toString("hex"),
      token,deskRoot:repo,candidatePath:path.join(repo,".git","desk-triage",token,"wt"),ref:`desk-triage/${token}`,
      commandRole:plan.id.startsWith("A19-") || plan.id.startsWith("A22-") ? "filter" : slot===0&&plan.id.startsWith("A11-") ? "discovery" : "validation",
      sequence:slot,privateRealmRoot:scope.privateRealmRoot,privateRoot}
    let actor=null, primary=null, primaryAtNs=null, primaryOrigin=null, terminalFailure=null, closedAt=null, rootClock=null, inputBytes=0, liveAfterResult=null, witnessJoined=false
    let resultAt=null, completeAt=null, sealAt=null, terminalAt=null, ownerCode=null, ownerSignal=null
    let specialAt=null, specialKind=null, resolveSpecial
    const specialReady=new Promise((resolve) => { resolveSpecial=resolve })
    const joins={ownerExitObserved:false,ownerCloseObserved:false,stdoutEOF:false,stdoutClosed:false,
      stderrEOF:false,stderrClosed:false,controlEOF:false,controlClosed:false,origin:"producer_reported"}
    const latch=(code,origin="observed") => {
      if (primary===null) { primary=code; primaryAtNs=process.hrtime.bigint().toString(); primaryOrigin=origin }
    }
    function maybeSpecial(kind=null) {
      if (!actor || specialAt!==null || isCancelled() || process.hrtime.bigint()>=deadline.expiresNs) return
      if (plan.id==="A25-P24-R24" && kind==="parent-death" && facts.work &&
        !joins.ownerExitObserved && !joins.ownerCloseObserved) specialKind=kind
      if (plan.id==="C15-P24-R24" && facts.work && decision.snapshot().rootLive &&
        joins.ownerExitObserved && !joins.ownerCloseObserved) {
        const b=actor.fixtureBridge.snapshot()
        const e=evidence.complete({ownerFullclose:false,ownerExitObserved:true,controlEOF:b.eof,
          controlClosed:b.closed,controlFailed:b.failed,withinDeadline:true})
        if (e?.quarantineReady) { facts.native=e; specialKind="quarantine" }
      }
      if (specialKind) { specialAt=process.hrtime.bigint().toString(); resolveSpecial() }
    }
    const witness=await createGenerationWitness(deadline,(cue) => {
      try { if (cue==="WORKLOAD_STARTED") facts.work=true; if (cue==="HOOK_RAN") facts.hook=true
        act(decision.witness(cue)) } catch { latch("protocol") }
    },latch)
    let payload
    let collision=null, collisionClosed=Promise.resolve(), pipeSuffix=null
    try {
      payload=classAPayload({plan,slot,scope,root,git,deadline,witness})
      verifyFixtureGitExecution(scope,git,root.path,deadline)
      if (plan.id.startsWith("A20-")) {
        pipeSuffix=crypto.randomBytes(32).toString("hex")
        collision=net.createServer((socket) => { socket.destroy(); latch("protocol") })
        collisionClosed=new Promise((resolve) => collision.once("close",resolve))
        collision.on("error",() => latch("io"))
        await new Promise((resolve,reject) => { collision.once("error",reject)
          collision.listen(`\\\\.\\pipe\\desk-owned-git-${pipeSuffix}`,resolve) })
        facts.collision=true
      }
    } catch (error) {
      witness.stop(); await witness.closed
      if (collision?.listening) { collision.close(); await collisionClosed }
      throw error
    }
    let resolveOwner
    const observed=new Promise((resolve) => { resolveOwner=resolve })
    function send(type) {
      const digest=actor.binding.proposedPayloadDigest??actor.binding.payloadDigest
      actor.wire.send({protocol:"desk.owned-git/1",role:"parent",type,generation:actor.binding.generation,
        preparationDigest:actor.binding.preparationDigest,payloadDigest:digest,
        ...(type==="CLOCK_ACCEPT" ? {clock:deadline.clock,deadlineNs:deadline.expiresNs.toString()} : {})})
      decision.sent(type)
      if (type==="SEAL") sealAt=process.hrtime.bigint().toString()
    }
    function act(actions) {
      if (isCancelled()) nativeFailure("producer_unjoined")
      for (const action of actions) {
        if (action==="CONFIG") { inputBytes=payload.stdin?.length||0; decision.sent("CONFIG"); actor.stagePayload(payload) }
        else if (action==="ALIVE") {
          witness.probe().then(() => { try { liveAfterResult=true; act(decision.witness("ALIVE")) }
            catch { latch("protocol") } },() => latch("io"))
        } else if (action==="LOSE_OWNER") { facts.ownerLost=true; latch("io"); actor.child.kill("SIGTERM") }
        else if (action==="LOSE_CONTROL") { facts.controlLost=true; latch("io","intentional-control-loss"); actor.child.stdio[3].end() }
        else if (action==="PAUSE_CONTROL") { facts.paused=true; actor.child.stdio[3].pause() }
        else if (action==="CONTINUE") {
          const pending=actor.fixtureBridge.request("CONTINUE")
          decision.sent("CONTINUE"); facts.controlRequests++
          pending.catch(() => latch("io")); auxiliary.push(pending)
        } else if (action==="REPLACE_SERVER") {
          const pending=actor.listenReplacementServer().then((server) => {
            facts.replacement=server
            act(decision.replacementReady())
          })
          pending.catch(() => latch("io")); auxiliary.push(pending)
        } else if (action==="RESUME_SERVER") {
          const pending=actor.fixtureBridge.request("RESUME_SERVER")
          decision.sent("RESUME_SERVER"); facts.controlRequests++
          pending.catch(() => latch("io")); auxiliary.push(pending)
        } else if (action==="PREDEATH") {
          maybeSpecial("parent-death")
        } else if (action==="RELEASE_RESULT") {
          actor.releasePostResultFault(); facts.released=true
        } else if (action==="WRONG_PID") {
          const peer=actor.wrongPidPeer(); registerActor(peer)
          const pending=peer.observed.then((value) => { facts.peer=value })
          pending.catch(() => latch("io")); auxiliary.push(pending)
        } else if (action==="BAD_PARENT") {
          const pending=runBadParentPeer({stream:actor.child.stdio[3],deadline}).then((value) => { facts.badPeer=value })
          pending.catch(() => latch("io")); auxiliary.push(pending)
        }
        else send(action)
      }
    }
    const timer=setTimeout(() => {
      latch("deadline"); actor?.wire.expire(); actor?.child.stdio[3].resume(); witness.stop()
    },Math.max(0,Number((deadline.expiresNs-process.hrtime.bigint())/1000000n)))
    const hardTimer=setTimeout(() => { latch("deadline"); try { actor?.child.kill("SIGTERM") } catch {} },
      Math.max(0,Number((scope.H-20000000000n-process.hrtime.bigint())/1000000n)))
    try {
      const launch=fixtureCase?launchFixtureComponent:launchComponent
      await launch({publicMcpRoot:scope.publicMcpRoot,privateRealmRoot:scope.privateRealmRoot,
        construction,caseId:plan.id,
        nodeExecutable:root.path,prepareBinding,deadline,outputLimit:plan.id.startsWith("A16-")?65536:Infinity,
        fragment:plan.id.startsWith("A23-"),pipeSuffix,isCancelled,
        onLaunched(value) {
          actor=value; const retained={child:actor.child,observed,cancel() { latch("io"); try { actor.child.kill("SIGTERM") } catch {} }}
          actors.push(retained); registerActor(retained)
          actor.child.once("exit",(code,signal) => { joins.ownerExitObserved=true; ownerCode=code; ownerSignal=signal; maybeSpecial() })
          actor.child.once("close",() => { joins.ownerCloseObserved=true; closedAt=process.hrtime.bigint().toString(); resolveOwner() })
          for (const name of ["stdout","stderr"]) {
            actor.child[name].on("end",() => { joins[`${name}EOF`]=true })
            actor.child[name].on("close",() => { joins[`${name}Closed`]=true })
            actor.child[name].on("error",() => latch("io"))
          }
          actor.child.stdio[3].on("end",() => { joins.controlEOF=true })
          actor.child.stdio[3].on("close",() => { joins.controlClosed=true })
          // Deliberate local destruction is observed separately from peer EOF.
          actor.child.stdio[3].on("error",() => latch("io"))
          if (plan.id==="C15-P24-R24") for (const type of ["end","close"])
            actor.child.stdio[4].on(type,() => queueMicrotask(maybeSpecial))
          if (isCancelled()) retained.cancel()
        },
        onError:() => latch(process.hrtime.bigint()>=deadline.expiresNs ? "deadline" : "protocol"),
        onPeerLive:() => { try { act(["WRONG_PID"]) } catch { latch("protocol") } },
        onFixtureFrame(value) {
          try { evidence.observe(value); act(decision.native(value)); maybeSpecial() } catch { latch("protocol") }
        },
        onFrame(value) {
          try {
            if (value.type==="CLOCK_READY") {
              const after=process.hrtime.bigint(), q=BigInt(value.qpcTicks)
              rootClock=clocks.length
              const row=r.projectClock({samples:[{case:plan.id,generationSlot:slot,role:plan.parent,origin:"owner",index:slot,
                q:value.qpcTicks,f:value.qpcFrequency,converted:value.nowNs,
                edge:core.mirrorWindowsHrtime((q+1n).toString(),value.qpcFrequency).toString(),
                beforeNs:actor.clockBefore().toString(),afterNs:after.toString(),deadlineNs:deadline.expiresNs.toString(),
                accepted:true,modeled:false}],gaps:[]}).samples[0]
              clocks.push(row); const sending=emitClock(row); sending.catch(() => latch("io")); clockSends.push(sending)
            }
            const actions=decision.frame(value.type)
            if (value.type==="RESULT") {
              if (facts.originalResultB64!==null && facts.originalResultB64!==value.resultB64) nativeFailure("case_mismatch")
              facts.originalResultB64=value.resultB64
              resultAt=process.hrtime.bigint().toString()
              if (plan.id.startsWith("A11-") && slot===0) {
                discovery=core.decodeResult(value.resultB64)
                if (sibling?.decision.snapshot().phase.ready) sibling.release()
              }
            }
            if (value.type==="CONTROL_COMPLETE") completeAt=process.hrtime.bigint().toString()
            if (value.type==="TERMINAL") {
              facts.terminalResultB64=value.resultB64
              terminalAt=process.hrtime.bigint().toString(); terminalFailure=value.failureCode
            }
            if (slot===1 && plan.id.startsWith("A11-") && value.type==="READY" && discovery)
              act(decision.releaseUnused(discovery))
            act(actions)
          } catch { latch("protocol") }
        } })
      if (slot===1 && plan.id.startsWith("A11-")) {
        sibling={decision,release:() => act(decision.releaseUnused(discovery))}
        if (discovery && decision.snapshot().phase.ready && !decision.snapshot().phase.cancelSent) sibling.release()
      }
      await Promise.race([observed,specialReady])
      await Promise.allSettled(auxiliary)
      if (facts.replacement) {
        await facts.replacement.closed
        facts.replacementUnexpectedClient=facts.replacement.snapshot().unexpectedClient
      }
      if (plan.id==="B09-P24-R24") {
        await actor.releaseClosed
        facts.pressure=actor.nodePressure()
      }
      if (plan.profile==="G_BASELINE" || plan.id.startsWith("A14-")) {
        try { await witness.retired(); witnessJoined=true } catch { latch("io") }
      }
    } catch (error) {
      latch("internal")
      if (actor) { try { actor.child.kill("SIGTERM") } catch {} await observed }
      else throw error
    } finally {
      clearTimeout(timer); clearTimeout(hardTimer); witness.stop()
      actor?.closeFixturePeer()
      if (collision) { try { collision.close() } catch {} }
      await witness.closed; await collisionClosed
    }
    const state=decision.snapshot(), obs=actor.observations.snapshot(), wm=actor.wire.snapshot(), data=actor.data.snapshot(), counts=actor.data.details()
    const prefix=plan.id.split("-")[0]
    const bridge=actor.fixtureBridge?.snapshot()
    const finishedAt=specialAt??closedAt
    if (finishedAt===null) nativeFailure("producer_unjoined")
    const fullOwner=Object.entries(joins).every(([k,v]) => k==="origin" || v===true)
    if (fullOwner && core.remainingNanoseconds(deadline,process.hrtime.bigint()))
      verifyFixtureGitExecution(scope,git,root.path,deadline)
    if (nativeCase) facts.native=evidence.complete({ownerFullclose:fullOwner,ownerExitObserved:joins.ownerExitObserved,controlEOF:bridge?.eof===true,
      controlClosed:bridge?.closed===true,controlFailed:bridge?.failed!==false,
      withinDeadline:BigInt(finishedAt)<deadline.expiresNs,closedAtNs:finishedAt})
    facts.decision=decision.snapshot()
    const expectedPrimary=primaryFailureExpected({id:plan.id,primary,primaryOrigin,primaryAtNs,
      deadlineNs:deadline.expiresNs.toString(),cleanupOnly:facts.native?.cleanupOnly===true,
      zeroCreation:facts.native?.zeroCreation===true,controlLost:facts.controlLost})
    if (!expectedPrimary) caseGap=primary==="deadline"?"deadline":"case_mismatch"
    if (wm.sent.includes("CANCEL") && !state.phase.cancelSent) state.phase.cancelSent=true
    const receiptOnly=plan.id.startsWith("O08-"), permanentlyWithheld=["A25","C15"].includes(prefix)
    // Snapshot missing original-owner joins once; later physical cleanup cannot
    // repair a failed invocation or the permanently withheld certificate.
    const gjoins={...joins}
    const cert=receiptOnly || permanentlyWithheld ? null : obs.certificate
    if (!state.phase.resultReceived && obs.result!==null) nativeFailure("case_mismatch")
    const result=obs.result, resultB64=result===null?null:Buffer.from(JSON.stringify(result),"ascii").toString("base64")
    const timely=BigInt(finishedAt)<deadline.expiresNs
    const full=Object.entries(gjoins).every(([k,v]) => k==="origin" || v===true)
    const success=primary===null && timely && ownerCode===0 && ownerSignal===null && cert!==null &&
      state.phase.controlComplete && state.phase.sealSent && data.dataComplete && !data.overflowed &&
      result?.command.state==="exited" && result.command.code===0 && result.command.signal===null &&
      result.input.state==="complete" && terminalFailure==="none" && full &&
      (!(plan.profile==="G_BASELINE" || plan.id.startsWith("A14-")) || (liveAfterResult===true && witnessJoined))
    if (nativeCase && !facts.native) nativeFailure("producer_unjoined")
    const sourceState=facts.native?.state
    const created=nativeCase ? (sourceState?Number(sourceState.created):facts.native.zeroCreation?0:null) :
      state.phase.ready || facts.peer?.rootLive || facts.pressure!==null && facts.pressure!==undefined ? 1 :
        facts.collision&&cert?.commandState==="not_started"?0:null
    if (created===null) nativeFailure("case_mismatch")
    if (specialKind) caseSpecial={kind:specialKind,generation:actor.binding.generation,deadlineNs:deadline.expiresNs.toString(),
      observedAtNs:finishedAt,workStarted:facts.work,rootLiveActual:specialKind==="quarantine"?facts.native.state.rootLiveActual:null,
      ownerExitObserved:gjoins.ownerExitObserved,ownerCloseObserved:gjoins.ownerCloseObserved}
    return r.projectGeneration({slot,generation:actor.binding.generation,preparationDigest:actor.binding.preparationDigest,
      proposedPayloadDigest:actor.binding.proposedPayloadDigest??null,acceptedPayloadDigest:actor.binding.payloadDigest,
      recordIdShape:"independent-H-fixture",tokenShape:"T32-fixture",durableOperationRecord:false,
      phase:{...state.phase,nativeSTARTIssued:sourceState?sourceState.startIssued:cert?cert.startIssued:
        facts.native?.zeroCreation?false:state.work?true:state.phase.parentSTARTSent?null:false},
      resultB64,result,certificate:cert,certificateOrigin:prefix==="C15"?"withheld-model":prefix==="A25"?"withheld-owner-close":cert?"live-control":"none",terminalFailure,
      invocation:generationInvocation({success,certificate:cert,fullclose:full,timely}),joins:gjoins,
      resources:{rootCreated:created,assigned:sourceState?Number(sourceState.assigned):created,
        resumed:sourceState?Number(sourceState.resumed):created,rootLiveAfterResult:liveAfterResult,
        privateRootRetirement:cert?"real-certificate":"unproved",broaderRetirement:"unproved",
        modelStrandedRoot:facts.native?.quarantineReady && facts.work ? 1 : 0,
        assignmentModeled:sourceState?.assignmentModeled??false,membershipModeled:sourceState?.membershipModeled??false,
        queryModeled:sourceState?.queryModeled??false,rootWaitModeled:sourceState?.rootWaitModeled??false,
        ioRouteInstrumented:sourceState?.ioRouteInstrumented??false,
        pendingReads:null,pendingWrites:null,cancelRequests:null,reapedReads:null,reapedWrites:null,
        registryPeak:sourceState?.extraHandlesPeak??null,origin:"producer_reported"},
      data:{stdinExpectedBytes:inputBytes,stdoutBytes:counts.stdout,stderrBytes:counts.stderr,combinedOverflow:data.overflowed,
        dataComplete:data.dataComplete,controlBytesRead:wm.bytesRead,controlBytesWritten:wm.bytesWritten+(facts.badPeer?.completedBytes||0),decoderPushes:wm.pushes,
        decoderProcessingNs:wm.processingNs,resultAtNs:resultAt,inputSettledAtNs:null,actualEOFAtNs:sourceState?.rootEOFAtNs??null,
        controlCompleteAtNs:completeAt,sealAtNs:sealAt,terminalAtNs:terminalAt,ownerCloseAtNs:closedAt,origin:"producer_reported"},
      clockRow:rootClock,deadlineNs:deadline.expiresNs.toString(),finishedNs:finishedAt,bindingOrigin:"producer_reported"})
  }
  const pending=Array.from({length:plan.expected.generations},(_,slot) => generation(slot))
  const settled=await Promise.allSettled(pending)
  await Promise.all(clockSends)
  const generations=settled.filter((v) => v.status==="fulfilled").map((v) => v.value)
  if (generations.length!==plan.expected.generations) caseGap="case_mismatch"
  const matched=caseGap==="none" && (fixtureCase?generations.length===1&&matchFixtureCase(plan,generations[0],facts):matchClassACase(plan,generations,facts))
  const disposition=caseDisposition(generations,plan.expected.generations)
  const record=r.projectCase({...plan,actual:{matched,disposition,generations,utilityId:null,sourceOrigin:"producer_reported",
    caseDeadlineNs:deadline.expiresNs.toString(),finishedNs:process.hrtime.bigint().toString()},
    gap:matched || caseSpecial?.kind==="parent-death" && caseGap==="none" ? "none":caseGap==="none"?"case_mismatch":caseGap})
  return {record,clock:clocks,handoff:caseSpecial ? validateSpecialHandoff(caseSpecial,record) : null}
}
function nativeRegistrationAllowed(input) {
  if (!input || input.platform !== "win32" || input.native !== "1" || input.event !== "workflow_dispatch" ||
    input.mode !== "standard" || !/^[0-9a-f]{40}$/.test(input.sha || "") ||
    !/^[1-9][0-9]{0,19}$/.test(input.Hns || "") || BigInt(input.Hns) > 18446744073709551615n ||
    !Array.isArray(input.execArgv)) return false
  const patterns = []
  for (let i=0;i<input.execArgv.length;i++) {
    const arg = input.execArgv[i]
    if (arg === "--test-name-pattern") patterns.push(input.execArgv[++i])
    else if (typeof arg === "string" && arg.startsWith("--test-name-pattern=")) patterns.push(arg.slice(20))
  }
  return patterns.length === 1 && patterns[0] === `^${NATIVE_SUBJECT}$`
}
function validateHandoffShape(value,id) {
  if (!value || Object.keys(value).sort().join(",")!==
    "deadlineNs,generation,kind,observedAtNs,ownerCloseObserved,ownerExitObserved,rootLiveActual,workStarted" ||
    !["A25-P24-R24","C15-P24-R24"].includes(id) || !/^[a-f0-9]{64}$/.test(value.generation) ||
    !["deadlineNs","observedAtNs"].every((k) => /^[1-9][0-9]{0,19}$/.test(value[k]) &&
      BigInt(value[k])<=18446744073709551615n) || value.workStarted!==true || value.ownerCloseObserved!==false ||
    (id==="A25-P24-R24" ? value.kind!=="parent-death" || value.rootLiveActual!==null || value.ownerExitObserved!==false :
      value.kind!=="quarantine" || value.rootLiveActual!==true || value.ownerExitObserved!==true)) nativeFailure("schema")
}
function validateSpecialHandoff(value, inputCase) {
  const record=require("./windows_owned_git_retention.cjs").projectCase(inputCase), g=record.actual?.generations[0]
  validateHandoffShape(value,record.id)
  if (!g || record.gap!=="none" || record.actual.disposition!=="HOLD" || record.actual.generations.length!==1 ||
    value.generation!==g.generation || value.deadlineNs!==g.deadlineNs ||
    value.observedAtNs!==g.finishedNs || BigInt(g.finishedNs)>=BigInt(g.deadlineNs) ||
    !value.workStarted || value.workStarted!==true || value.ownerCloseObserved!==false ||
    g.certificate!==null || g.joins.ownerCloseObserved || g.invocation!=="HOLD" || g.data.dataComplete ||
    !g.phase.parentSTARTSent || g.phase.nativeSTARTIssued!==true || g.resources.rootCreated!==1 ||
    g.resources.assigned!==1 || g.resources.resumed!==1) nativeFailure("case_mismatch")
  if (record.id==="A25-P24-R24") {
    if (value.kind!=="parent-death" || value.rootLiveActual!==null || value.ownerExitObserved!==false ||
      g.joins.ownerExitObserved || g.certificateOrigin!=="withheld-owner-close" ||
      g.resources.modelStrandedRoot!==0) nativeFailure("case_mismatch")
  } else if (value.kind!=="quarantine" || value.rootLiveActual!==true || value.ownerExitObserved!==true ||
    !g.joins.ownerExitObserved || g.certificateOrigin!=="withheld-model" || g.resources.modelStrandedRoot!==1 ||
    !["assignmentModeled","membershipModeled","queryModeled","rootWaitModeled"].every((k) => g.resources[k]===true))
    nativeFailure("case_mismatch")
  return Object.freeze({...value})
}
function deriveParentDeathCase(record) {
  validateSpecialHandoff(record.handoff,record.case)
  if (record.handoff.kind!=="parent-death" || !record.started || record.gap!=="none" ||
    !record.deathRequested || !originalWorkerFullclose(record) ||
    record.signal===null && (!Number.isInteger(record.code) || record.code===0) ||
    typeof record.closedAtNs!=="string" || BigInt(record.closedAtNs)>=BigInt(record.handoff.deadlineNs))
    nativeFailure("producer_unjoined")
  return require("./windows_owned_git_retention.cjs").projectCase({...record.case,
    actual:{...record.case.actual,matched:true,finishedNs:record.closedAtNs},gap:"none"})
}
function quarantineObservationComplete(record) {
  try {
    if (!record?.started || !record.quarantined || record.exitObserved || record.closeObserved ||
      record.gap!=="none" || !record.case?.actual?.matched) return false
    return validateSpecialHandoff(record.handoff,record.case).kind==="quarantine"
  } catch { return false }
}
function deriveQuarantineFacts(records) {
  const workers=records.filter(quarantineObservationComplete)
  const modelRoots=workers.reduce((n,row) => n+row.case.actual.generations.reduce((m,g) => m+g.resources.modelStrandedRoot,0),0)
  if (workers.length!==1 || modelRoots!==1) nativeFailure("producer_unjoined")
  return {caseWorkers:workers.length,modelRoots,authority:"retained-real-broader-job"}
}
function unrefQuarantinedWorker(record) {
  if (!record.reportClosed || !quarantineObservationComplete(record)) nativeFailure("producer_unjoined")
  record.deadlineTimer.unref()
  for (const stream of [record.child.stdout,record.child.stderr,record.child.stdio[3]]) stream.unref()
  record.child.unref()
}
function aggregateControllerGap(facts) {
  if (facts.cases.length!==80 || facts.utilities.length!==6) return "not_admitted"
  const utilityGap=facts.utilities.find((u) => {
    if (u.gap==="none") return false
    const c=facts.cases.find((c) => c.id===u.id)
    return !(u.id==="C19-P24-Rnone" && u.gap==="denominator_missing" &&
      u.processes===2 && u.fullcloseObserved===2 && u.checksExpected===4 && u.checksPassed===0 &&
      u.denominator===null && c?.gap==="none" && c.actual?.matched &&
      c.actual.disposition==="utility-only" && c.actual.utilityId===u.id && c.actual.generations.length===0)
  })
  return facts.cases.find((c) => c.gap!=="none")?.gap ||
    (facts.cases.some((c) => !c.actual?.matched) ? "case_mismatch" : utilityGap?.gap || "none")
}
function validateWorkerFrame(value, id) {
  const retention = require("./windows_owned_git_retention.cjs")
  if (!value || Object.keys(value).sort().join(",") !== "id,schema,type,value" ||
    value.schema !== "desk.owned-git-case-worker/1" || value.id !== id ||
    !NATIVE_REGISTRY.some((p) => p.id === id)) nativeFailure("schema")
  if (GENERATION_SECTIONS.some(([type]) => type===value.type)) {
    if (!value.value || Object.keys(value.value).sort().join(",")!=="section,slot" ||
      !Number.isInteger(value.value.slot) || value.value.slot<0 || value.value.slot>1 ||
      !value.value.section || Object.getPrototypeOf(value.value.section)!==Object.prototype) nativeFailure("schema")
  } else if (value.type==="CASE_SUMMARY") {
    if (!value.value || Object.keys(value.value).sort().join(",")!=="generationCount,record" ||
      !Number.isInteger(value.value.generationCount) || value.value.generationCount<1 ||
      value.value.generationCount>2 || !value.value.record) nativeFailure("schema")
  } else if (value.type === "CLOCK") {
    const row = retention.projectClock({ samples:[value.value],gaps:[] }).samples[0]
    if (row.case !== id) nativeFailure("case_mismatch")
  } else if (value.type === "UTILITY") {
    if (retention.projectUtility(value.value).id !== id) nativeFailure("case_mismatch")
  } else if (value.type === "CASE") {
    if (retention.projectCase(value.value).id !== id) nativeFailure("case_mismatch")
  } else if (value.type === "HANDOFF") {
    validateHandoffShape(value.value,id)
  } else if (value.type === "ERROR" || value.type === "DONE") {
    if (typeof value.value !== "string" || !retention.GAPS.includes(value.value) ||
      (value.type==="ERROR" && value.value==="none")) nativeFailure("schema")
  } else nativeFailure("schema")
  return value
}
function sourceWorkerEnvironment() {
  const env = {}
  for (const name of ["SystemRoot","WINDIR","SystemDrive","COMSPEC","PATH","TEMP","TMP","PATHEXT",
    "DESK_TEST_OWNED_GIT_H","DESK_TEST_OWNED_GIT_D","DESK_TEST_OWNED_GIT_PRIVATE","DESK_TEST_OWNED_GIT_NATIVE",
    "DESK_TEST_OWNED_GIT_NONCE","DESK_TEST_OWNED_GIT_SOURCE_REVISION","DESK_TEST_OWNED_GIT_SOURCE_TREE",
    "DESK_TEST_OWNED_GIT_FIXTURE_SHA"]) if (process.env[name] !== undefined) env[name] = process.env[name]
  return env
}
async function nativeCaseWorkerEntry(id) {
  const plan = NATIVE_REGISTRY.find((p) => p.id === id)
  if (process.platform !== "win32" || process.env.DESK_TEST_OWNED_GIT_NATIVE !== "1" || !plan) nativeFailure("not_admitted")
  const H = BigInt(process.env.DESK_TEST_OWNED_GIT_H)
  // Admission captured D before executable verification/worker startup; never renew it here.
  const inputD=process.env.DESK_TEST_OWNED_GIT_CASE_D
  if (!/^[1-9][0-9]{0,19}$/.test(inputD||"") || BigInt(inputD)>H-20000000000n) nativeFailure("deadline")
  const deadline = Object.freeze({ clock:"win-qpc-ns/1",expiresNs:BigInt(inputD) })
  const channel = new net.Socket({ fd:3,readable:true,writable:true })
  const actors = [], outgoing=[]; let finalized = false, writing = false, gap = "none", transportFailed = false
  const cancel = () => { if (!finalized) { transportFailed = true; for (const actor of actors) actor.cancel() } }
  channel.on("data",cancel); channel.on("error",cancel); channel.on("end",cancel)
  const pump = () => {
    if (writing || !outgoing.length) return
    const item=outgoing[0]
    if (transportFailed || process.hrtime.bigint()>=H-20000000000n) {
      cancel()
      while (outgoing.length) outgoing.shift().reject(Object.assign(new Error("owned_git_native_incomplete"),{code:"deadline"}))
      return
    }
    writing=true
    channel.write(item.buffer,(error) => {
      writing=false; outgoing.shift()
      if (error) { cancel(); item.reject(Object.assign(new Error("owned_git_native_incomplete"),{code:"producer_unjoined"})) }
      else item.resolve()
      pump()
    })
  }
  const send = (type,value) => {
    if (outgoing.length===2 || transportFailed || process.hrtime.bigint() >= H-20000000000n) nativeFailure("deadline")
    const buffer=encodeWorkerFrame(internalFrame(id,type,value))
    return new Promise((resolve,reject) => { outgoing.push({buffer,resolve,reject}); pump() })
  }
  try {
    if (plan.expected.generations) generationCasePlan(id)
    if (!core.remainingNanoseconds(deadline,process.hrtime.bigint())) nativeFailure("deadline")
    const construction = createFixtureConstruction(), runtime = await getFixtureRuntime(construction,plan.parent)
    if (process.execPath !== runtime.path || process.versions.node !== runtime.version) nativeFailure("runtime_mismatch")
    const options={ construction,plan,deadline,
      registerActor:(actor) => { actors.push(actor); if (transportFailed) actor.cancel() },
      isCancelled:() => transportFailed,emitClock:(row) => send("CLOCK",row) }
    const result=plan.expected.generations ? await runGenerationCase(options) : await runNativeUtilityCase(options)
    if (plan.expected.generations) {
      if (result.record.actual.generations.length!==plan.expected.generations) nativeFailure("case_mismatch")
      for (const g of result.record.actual.generations) for (const f of encodeGenerationFrames(id,g)) await send(f.type,f.value)
      const summary=encodeCaseSummary(result.record); await send(summary.type,summary.value)
    } else { await send("UTILITY",result.utility); await send("CASE",result.record) }
    if (result.handoff) {
      await send("HANDOFF",validateSpecialHandoff(result.handoff,result.record))
      finalized=true
      // No self-observed future death/fullclose and no synthetic DONE. Preserve
      // the original children/streams until the controller or real broader job
      // retires this worker; the original H is the final local retention bound.
      setTimeout(() => { for (const actor of actors) void actor.child; process.exit(1) },
        Math.max(0,Number((H-20000000000n-process.hrtime.bigint())/1000000n)))
      return
    }
    if (!result.record.actual?.matched) gap = result.record.gap === "none" ? "case_mismatch" : result.record.gap
  } catch (error) {
    gap = safeNativeGap(error)
    for (const actor of actors) actor.cancel()
    await Promise.all(actors.map((actor) => actor.observed))
    if (!transportFailed) { try { await send("ERROR",gap) } catch { transportFailed = true } }
  }
  if (!transportFailed) {
    await send("DONE",gap); finalized = true; channel.end()
  } else channel.destroy()
  if (gap !== "none" || transportFailed) process.exitCode = 1
}
const caseWorkerOrigins=new WeakMap()
async function launchBoundCaseWorker(construction, plan, H, admission, stagingBudget) {
  const runtime = await getFixtureRuntime(construction,plan.parent)
  if (process.hrtime.bigint() >= H-30000000000n ||
    process.hrtime.bigint() >= BigInt(admission.deadlineNs)) nativeFailure("deadline")
  // Only this fixed verified script and finite registry ID are executable input.
  const env=sourceWorkerEnvironment(); env.DESK_TEST_OWNED_GIT_CASE_D=admission.deadlineNs
  const assembly=plan.expected.generations ? createGenerationAssembly({id:plan.id,deadlineNs:admission.deadlineNs,budget:stagingBudget}) : null
  const child = spawn(runtime.path,[__filename,"--native-case-worker",plan.id], {
    cwd:path.resolve(__dirname,"../../../../../../"),env,windowsHide:true,
    stdio:["ignore","overlapped","overlapped","overlapped"],
  })
  const record = { id:plan.id,deadlineNs:admission.deadlineNs,workCutoffNs:admission.workCutoffNs,child,started:false,clock:[],utility:null,case:null,done:false,gap:"none",
    exitObserved:false,closeObserved:false,stdoutEOF:false,stdoutClosed:false,stderrEOF:false,stderrClosed:false,
    controlEOF:false,controlClosed:false,code:null,signal:null,bytes:0,closedAtNs:null }
  caseWorkerOrigins.set(child,{construction,record})
  let resolveReport
  record.reportReady=new Promise((resolve) => { resolveReport=resolve })
  const stop = (code) => { if (record.gap === "none") record.gap=code
    try { child.kill("SIGTERM") } catch { /* Keep original child until actual close. */ } }
  let generationPhase=false, errorSeen=false
  const decoder = fixtureProtocol.createFixtureControlDecoder({ core,onFrame(value) {
    if (!record.started || record.done || record.handoff) nativeFailure("producer_unjoined")
    validateWorkerFrame(value,plan.id)
    if (value.type === "CLOCK") {
      if (generationPhase || record.utility || record.case || errorSeen) nativeFailure("schema")
      if (record.clock.length === 136) nativeFailure("quota")
      record.clock.push(value.value)
    } else if (value.type === "UTILITY") {
      if (assembly || record.utility || errorSeen) nativeFailure("schema"); record.utility=value.value
    } else if (value.type.startsWith("GEN_") || value.type==="CASE_SUMMARY") {
      if (!assembly || errorSeen) nativeFailure("schema")
      generationPhase=true
      const result=assembly.accept(value); if (result) record.case=result
    } else if (value.type === "CASE") {
      if (assembly) nativeFailure("schema")
      if (record.case) nativeFailure("schema"); record.case=value.value
    } else if (value.type === "HANDOFF") {
      stagingBudget.add(Buffer.byteLength(JSON.stringify(value)))
      if (!assembly || !record.case || errorSeen || record.gap!=="none" ||
        process.hrtime.bigint()>=BigInt(admission.deadlineNs)) nativeFailure("producer_unjoined")
      record.case=assembly.end()
      record.handoff=validateSpecialHandoff(value.value,record.case)
      if (record.handoff.kind==="parent-death") {
        // Authority is this original spawned object, never its numeric PID.
        record.deathRequested=child.kill("SIGTERM")
        if (!record.deathRequested) nativeFailure("producer_unjoined")
      } else {
        if (!record.case.actual.matched || record.exitObserved || record.closeObserved) nativeFailure("producer_unjoined")
        record.quarantined=true; resolveReport(record)
      }
    } else if (value.type === "ERROR") {
      if (errorSeen) nativeFailure("schema")
      errorSeen=true
      if (record.gap==="none") record.gap=value.value
    }
    else {
      if (assembly && value.value==="none") record.case=assembly.end()
      record.done=true
      if (value.value !== "none" && record.gap==="none") record.gap=value.value
      child.stdio[3].end()
    }
  } })
  child.once("spawn",() => { record.started=Number.isInteger(child.pid)&&child.pid>0; if (!record.started) stop("producer_unjoined") })
  child.stdio[3].on("data",(bytes) => {
    try { record.bytes+=bytes.length; if (record.bytes>1048576) nativeFailure("quota"); decoder.push(bytes) }
    catch (error) { stop(safeNativeGap(error)) }
  })
  child.stdio[3].on("end",() => { try { decoder.end(); record.controlEOF=true } catch { stop("schema") } })
  child.stdio[3].on("close",() => { record.controlClosed=true })
  child.stdio[3].on("error",() => stop("producer_unjoined"))
  for (const name of ["stdout","stderr"]) {
    child[name].on("data",(bytes) => { record.bytes+=bytes.length; if (record.bytes>1048576) stop("quota") })
    child[name].on("end",() => { record[`${name}EOF`]=true })
    child[name].on("close",() => { record[`${name}Closed`]=true })
    child[name].on("error",() => stop("producer_unjoined"))
  }
  child.on("error",() => stop("producer_unjoined"))
  child.once("exit",(code,signal) => { record.exitObserved=true; record.code=code; record.signal=signal })
  const timer = setTimeout(() => stop("deadline"),Math.max(0,Number((H-20000000000n-process.hrtime.bigint())/1000000n)))
  record.deadlineTimer=timer
  record.observed = new Promise((resolve) => child.once("close",() => {
    clearTimeout(timer); record.closeObserved=true; record.closedAtNs=process.hrtime.bigint().toString()
    if (record.handoff?.kind==="parent-death") {
      try { record.case=deriveParentDeathCase(record); record.done=true }
      catch (error) { if (record.gap==="none") record.gap=safeNativeGap(error) }
    }
    if (!record.done || !originalWorkerFullclose(record)) record.gap=record.gap==="none"?"producer_unjoined":record.gap
    resolve(record); resolveReport(record)
  }))
  return record
}
function assembleUtilityWorkerFacts(records) {
  const retention = require("./windows_owned_git_retention.cjs"), clock=[],utilities=[],cases=[]
  for (const plan of NATIVE_REGISTRY) {
    const record = records.find((row) => row.id === plan.id)
    if (!record?.started) {
      cases.push({ ...plan,actual:null,gap:record?.gap && record.gap!=="none" ? record.gap : "not_admitted" })
      continue
    }
    const offset=clock.length
    for (const row of record.clock) clock.push(row)
    if (record.utility) {
      const utility=retention.projectUtility({ ...record.utility,clockRows:record.utility.clockRows.map((i) => {
        if (!Number.isSafeInteger(i) || i<0 || i>=record.clock.length) nativeFailure("clock_mismatch")
        return offset+i
      }) })
      utilities.push(utility)
    }
    const deathComplete=record.handoff?.kind==="parent-death" && record.done && record.case?.actual?.matched &&
      record.deathRequested && originalWorkerFullclose(record)
    const gap=record.gap!=="none" ? record.gap :
      quarantineObservationComplete(record) || deathComplete || record.done&&utilityObservationComplete(record,0) ? "none" : "producer_unjoined"
    if (!record.case) cases.push({ ...plan,actual:null,gap:gap==="none"?"not_admitted":gap })
    else {
      const original=retention.projectCase(record.case)
      const actual=original.actual
      const prefix=plan.id.split("-")[0]
      const expectedExpiry=actual && ["A17","A18","A19","O05","C03","C04","C05","C06","C07"].includes(prefix) &&
        actual.disposition==="HOLD" && actual.generations.length===1 &&
        actual.generations.every((g) => g.invocation==="HOLD" && g.certificate===null) &&
        (prefix!=="O05" || actual.generations.every((g) => g.resources.queryModeled && g.phase.resultReceived &&
          g.phase.controlComplete && g.phase.sealSent && g.terminalFailure===null &&
          [g.data.resultAtNs,g.data.controlCompleteAtNs,g.data.sealAtNs].every((n) => n!==null && BigInt(n)<BigInt(g.deadlineNs)))) &&
        typeof record.workCutoffNs==="string" && BigInt(actual.finishedNs)<BigInt(record.workCutoffNs)
      const caseGap=gap!=="none" ? gap : original.gap!=="none" ? original.gap :
        original.actual && (original.actual.caseDeadlineNs!==record.deadlineNs ||
          (!caseFinishedWithinDeadline(original.actual) && !expectedExpiry)) ? "deadline" : "none"
      cases.push(retention.projectCase({ ...original,gap:caseGap,
        actual:actual && { ...actual,matched:actual.matched&&caseGap==="none",
          generations:actual.generations.map((g) => ({...g,clockRow:g.clockRow===null ? null : (() => {
            if (g.clockRow<0 || g.clockRow>=record.clock.length) nativeFailure("clock_mismatch")
            return offset+g.clockRow
          })()})) } }))
    }
  }
  return { cases,utilities,clock }
}
async function nativeControllerEntry() {
  if (process.platform !== "win32" || process.env.DESK_TEST_OWNED_GIT_NATIVE !== "1") nativeFailure("not_admitted")
  const H=BigInt(process.env.DESK_TEST_OWNED_GIT_H), construction=createFixtureConstruction()
  await initializeSyntheticRepository(construction)
  const ledger=createNativeWorkerLedger({H}), records=[],active=new Map(), waiting=[...NATIVE_REGISTRY], stagingBudget=createGenerationStagingBudget()
  while (waiting.length || active.size) {
    while (waiting.length && ledger.snapshot().activeReservations<12 && process.hrtime.bigint()<H-30000000000n) {
      const plan=waiting.shift()
      const admission=ledger.admit(plan.id,process.hrtime.bigint())
      const task=(async () => {
        let record
        try {
          record=await launchBoundCaseWorker(construction,plan,H,admission,stagingBudget)
          record.observed.then(() => { ledger.finish(plan.id,record) })
          await record.reportReady
          if (quarantineObservationComplete(record)) ledger.quarantine(plan.id)
          records.push(record)
        } catch (error) {
          if (!record) {
            ledger.refusedBeforeSpawn(plan.id)
            records.push({ id:plan.id,started:false,gap:safeNativeGap(error) })
          } else {
            if (record.gap==="none") record.gap=safeNativeGap(error)
            records.push(record)
          }
        }
      })()
      active.set(plan.id,task)
      task.then(() => active.delete(plan.id),() => active.delete(plan.id))
    }
    if (!active.size) break
    await Promise.race(active.values())
  }
  const facts=assembleUtilityWorkerFacts(records)
  const retention=require("./windows_owned_git_retention.cjs"), scope=fixtureConstructions.get(construction)
  const quarantine=deriveQuarantineFacts(records)
  for (const record of records) if (record.child && (caseWorkerOrigins.get(record.child)?.construction!==construction ||
    caseWorkerOrigins.get(record.child)?.record!==record)) nativeFailure("producer_unjoined")
  if (facts.utilities.length!==6 || process.hrtime.bigint()>=H-20000000000n) nativeFailure("not_admitted")
  const gap=aggregateControllerGap(facts)
  const report=retention.projectControllerFacts({schema:"desk.owned-git-case-facts/1",
    sourceRevision:scope.expectedSource.sourceRevision,allocationSha256:retention.ALLOCATION_SHA,
    namespaceNonce:scope.namespaceNonce,cases:facts.cases,utilities:facts.utilities,clock:facts.clock,
    markersExpected:retention.getPrivateRoleRegistry().filter((d) => d.role==="preload-marker").length,quarantine,gap},
    {sourceRevision:scope.expectedSource.sourceRevision,namespaceNonce:scope.namespaceNonce,Hns:H.toString()})
  freeze(report)
  const bytes=Buffer.from(JSON.stringify(report),"utf8")
  if (bytes.length>1048576) nativeFailure("quota")
  let fd
  try {
    fd=fs.openSync(path.join(scope.privateRealmRoot,"controller-report.json"),"wx",0o600)
    let at=0
    while (at<bytes.length) {
      if (process.hrtime.bigint()>=H-20000000000n) nativeFailure("deadline")
      const n=fs.writeSync(fd,bytes,at,Math.min(65536,bytes.length-at))
      if (!n) nativeFailure("guard_failed")
      at+=n
    }
  } finally { if (fd!==undefined) fs.closeSync(fd) }
  if (process.hrtime.bigint()>=H-20000000000n) nativeFailure("deadline")
  // Report closure precedes controller exit/S13 sealing. Unref is not close or
  // join: the original quarantined worker remains in our real broader job.
  for (const record of records.filter(quarantineObservationComplete)) {
    record.reportClosed=true; unrefQuarantinedWorker(record)
  }
  if (gap!=="none") process.exitCode=1
}
async function runNativeOuter() {
  const retention = require("./windows_owned_git_retention.cjs")
  const H=BigInt(process.env.DESK_TEST_OWNED_GIT_H), workspace=path.resolve(__dirname,"../../../../../../")
  const context=retention.createRetentionContext({ workspace,expectedRun:{},
    expectedSource:{sourceRevision:process.env.GITHUB_SHA},allocation:retention.ALLOCATION_SHA,H })
  await retention.buildPublicFixtures(context)
  const child=retention.launchProducer(context,"main"), observation=await retention.observeProducer(context,child,"main")
  let admission=null,facts=null,controls=null,incomplete=false
  try { admission=retention.admitBootstrap(context,observation) } catch { incomplete=true }
  if (admission) {
    try { facts=retention.collectPrivateRoles(context,admission,NATIVE_REGISTRY) } catch { incomplete=true }
    try { controls=await retention.runRetentionControls(context,admission) } catch { incomplete=true }
    if (facts) { try { await retention.launchCoverageTools(context,admission,facts) } catch { incomplete=true } }
  }
  const exported=retention.exportSafeEvidence(context,{admission,facts,controls})
  if (incomplete || !exported.completeArtifact) nativeFailure("not_admitted")
  return exported
}
module.exports = { validateClockReady, createDriverPolicy, createDataObservations, createObservations, createWire, stagePayloadFile,
  syntheticGitConfiguration, buildGitEnvironment, stageSyntheticGitFiles,
  launchComponent, createFixtureConstruction, launchFixtureComponent, launchFixtureUtility, createFixtureBridgeObserver,
  getNativeCaseRegistry, resolveFixtureAssets, resolveRegistryFixture, getUtilityInvocation, createNativeWorkerLedger,
  utilityObservationComplete, observeUtilityJoins, validateUtilityClockSample, runNativeUtilityCase, getFixtureRuntime,
  nativeRegistrationAllowed, runNativeOuter, assembleUtilityWorkerFacts, encodeGenerationFrames, encodeCaseSummary,
  encodeWorkerFrame, createGenerationStagingBudget, createGenerationAssembly, createClassADecisions, matchClassACase,
  classAPayload, generationInvocation, createDescendantObservations, generationCaseAvailable, createFixtureDecisions,
  createFixtureCaseEvidence, matchFixtureCase, runBadParentPeer, validateSpecialHandoff, deriveParentDeathCase,
  deriveQuarantineFacts, unrefQuarantinedWorker, aggregateControllerGap, primaryFailureExpected, caseDisposition,
  utilityFooterComplete }
if (require.main === module) {
  const args=process.argv.slice(2)
  const entry=args.length===1&&args[0]==="--native-controller" ? () => nativeControllerEntry() :
    args.length===2&&args[0]==="--native-case-worker"&&NATIVE_REGISTRY.some((p) => p.id===args[1])
      ? () => nativeCaseWorkerEntry(args[1]) : null
  if (!entry) process.exitCode=1
  else entry().catch(() => { process.exitCode=1; process.stderr.write("owned_git_native_incomplete\n") })
}
