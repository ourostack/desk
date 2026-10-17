"use strict"
// Pre-adapter component harness. No operation records, lease facade or restoration.
const core = require("../../../../../../plugins/desk/mcp/scripts/owned-git-child.cjs")
const { pathToFileURL } = require("node:url")
const path = require("node:path")
const { spawn } = require("node:child_process")
const crypto = require("node:crypto")
const fs = require("node:fs")

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
  const edge = (name) => { if (!Object.hasOwn(streams, name)) fail(); return streams[name] }
  return {
    chunk(name, chunk) {
      const state = edge(name)
      if (!Buffer.isBuffer(chunk) || state.ended || state.closed || bytes + chunk.length > Number.MAX_SAFE_INTEGER) fail()
      bytes += chunk.length
      overflowed ||= bytes > policy.outputLimit
    },
    end(name) { edge(name).ended = true },
    close(name) { edge(name).closed = true },
    error(name) { edge(name).failed = true },
    snapshot() { return { bytes, overflowed,
      dataComplete: Object.values(streams).every((v) => v.ended && v.closed && !v.failed) } },
  }
}
function createObservations(binding, expectedBytes) {
  const value = { ownerExited: false, ownerClosed: false, controlEOF: false, controlComplete: false, result: null, certificate: null }
  let ended = false
  return {
    owner(frame) {
      if (ended) fail()
      core.encodeFrame(frame)
      if (frame.role !== "owner" || frame.generation !== binding.generation || frame.preparationDigest !== binding.preparationDigest) fail()
      const pendingTerminal = frame.type === "TERMINAL" && binding.payloadDigest === null &&
        (frame.payloadDigest === null || frame.payloadDigest === binding.proposedPayloadDigest)
      if (!pendingTerminal && frame.payloadDigest !== binding.payloadDigest) fail()
      if (frame.type === "RESULT") {
        if (value.result) fail()
        value.result = core.decodeResult(frame.resultB64)
        if (value.result.input.expectedBytes !== expectedBytes) fail()
      } else if (frame.type === "CONTROL_COMPLETE") {
        if (!value.result || value.controlComplete) fail()
        value.controlComplete = true
      } else if (frame.type === "TERMINAL") {
        ended = true
        if (frame.certificate !== null) value.certificate = core.validateCertificate(frame.certificate,
          { ...binding, payloadDigest: frame.payloadDigest })
        if (frame.resultB64 !== null) {
          const result = core.decodeResult(frame.resultB64)
          if (result.input.expectedBytes !== expectedBytes ||
            (value.result && JSON.stringify(value.result) !== JSON.stringify(result))) fail()
        }
      } else fail()
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
function createWire({ stream, binding, deadline, onFrame = () => {}, onError = () => {} }) {
  const decoder = core.createFrameDecoder({ role: "owner", binding, phase: "preparing" })
  const writer = core.createFrameWriter(stream, onError)
  let closed = false, stopped = false, phase = "preparing"
  stream.on("data", (bytes) => {
    try {
      for (const value of decoder.push(bytes)) {
        if (value.type === "CLOCK_READY") phase = "clock_ready"
        else if (value.type === "READY") phase = "ready"
        else if (value.type === "CONFIGURED") { binding.payloadDigest = value.payloadDigest; phase = "configured" }
        else if (value.type === "CONTROL_COMPLETE") phase = "complete"
        else if (value.type === "TERMINAL") stopped = true
        onFrame(value)
      }
    } catch (error) { stopped = true; onError(error) }
  })
  stream.on("end", () => { try { decoder.end(); closed = true } catch (error) { onError(error) } })
  stream.on("error", onError)
  return {
    send(value) {
      if (closed || stopped || !core.remainingNanoseconds(deadline, process.hrtime.bigint()) ||
        value.role !== "parent" || value.generation !== binding.generation ||
        value.preparationDigest !== binding.preparationDigest) fail()
      core.encodeFrame(value)
      if (value.type === "CONFIG") {
        if (phase !== "ready" || binding.proposedPayloadDigest) fail()
        binding.proposedPayloadDigest = value.payloadDigest; phase = "configuring"
      } else if (value.type === "CANCEL") {
        if (value.payloadDigest !== (binding.proposedPayloadDigest ?? binding.payloadDigest)) fail()
        stopped = true
      } else {
        if (value.payloadDigest !== binding.payloadDigest) fail()
        if (value.type === "START") { if (phase !== "configured") fail(); phase = "running" }
        else if (value.type === "CLOCK_ACCEPT") { if (phase !== "clock_ready") fail(); phase = "clock_accepted" }
        else if (value.type === "SEAL") { if (phase !== "complete") fail(); stopped = true }
        else if (value.type !== "PREPARE" || phase !== "preparing") fail()
      }
      writer.send(value)
    },
  }
}
function stagePayloadFile({ payload, payloadPath, expectedPath }) {
  if (payloadPath !== expectedPath) fail()
  const encoded = core.encodePayload(payload)
  try {
    const fd = fs.openSync(payloadPath, "r+")
    try {
      if (!fs.fstatSync(fd).isFile()) fail()
      fs.ftruncateSync(fd, 0)
      let offset = 0
      while (offset < encoded.bytes.length) {
        const count = fs.writeSync(fd, encoded.bytes, offset, encoded.bytes.length - offset)
        if (!count) fail()
        offset += count
      }
    } finally { fs.closeSync(fd) }
  } catch { throw new Error("component_payload") }
  return { payloadDigest: encoded.payloadDigest, expectedBytes: payload.stdin?.length ?? 0 }
}
async function launchComponent({ publicMcpRoot, privateRealmRoot, nodeExecutable, prepareBinding, deadline, outputLimit, onFrame, onError = () => {} }) {
  // Source-only now: actual invocation requires a separately admitted native gate.
  if (process.platform !== "win32" || privateRealmRoot !== prepareBinding.privateRealmRoot) fail()
  const verify = await import(pathToFileURL(path.resolve(__dirname, "../../../../../../plugins/desk/mcp/scripts/verify-owned-git.js")).href)
  const assets = await verify.verifyOwnedGitAssets({ publicMcpRoot, privateRealmRoot, nodeExecutable })
  const bound = core.createPreparationBinding(prepareBinding, { publicMcpRoot: assets.publicMcpRoot,
    nodeExecutable: assets.nodeExecutable, nodeSha256: assets.nodeSha256,
    ownerSha256: assets.manifest.files.owner.sha256, shimSha256: assets.manifest.files.shim.sha256 }, deadline)
  if (!core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
  const env = {}
  for (const key of ["SystemRoot", "WINDIR", "SystemDrive", "COMSPEC", "PATH", "TEMP", "TMP", "PATHEXT", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  env.DESK_OWNED_GIT_CLOCK = deadline.clock
  env.DESK_OWNED_GIT_DEADLINE_NS = deadline.expiresNs.toString()
  const child = spawn(assets.owner, ["--owned-git"], { env, cwd: assets.publicMcpRoot,
    windowsHide: true, stdio: ["ignore", "pipe", "pipe", "overlapped"] })
  const binding = { generation: bound.preparation.generation, preparationDigest: bound.preparationDigest, payloadDigest: null }
  const policy = createDriverPolicy({ outputLimit })
  const observations = createObservations(binding, 0)
  const data = createDataObservations(policy)
  let beforeNs, payloadPath, payloadStaged = false, overflowCancelled = false
  const wire = createWire({ stream: child.stdio[3], binding, deadline, onFrame: (value) => {
    if (value.type === "CLOCK_READY") validateClockReady(value, deadline, beforeNs, process.hrtime.bigint())
    if (value.type === "READY") {
      if (value.payloadPath !== path.join(prepareBinding.privateRoot, "payload.json")) fail()
      payloadPath = value.payloadPath
    }
    if (["RESULT", "CONTROL_COMPLETE", "TERMINAL"].includes(value.type)) observations.owner(value)
    onFrame?.(value)
  }, onError: () => onError(new Error("component_io")) })
  child.on("error", () => onError(new Error("component_launch")))
  child.on("exit", () => observations.ownerExit())
  child.on("close", () => observations.ownerClose())
  child.stdio[3].on("end", () => observations.controlEOF())
  for (const name of ["stdout", "stderr"]) {
    child[name].on("data", (chunk) => {
      try {
        data.chunk(name, chunk)
        if (data.snapshot().overflowed && !overflowCancelled) {
          overflowCancelled = true
          wire.send({ protocol: "desk.owned-git/1", role: "parent", type: "CANCEL", generation: binding.generation,
            preparationDigest: binding.preparationDigest, payloadDigest: binding.proposedPayloadDigest ?? binding.payloadDigest })
        }
      } catch { onError(new Error("component_data")) }
    })
    child[name].on("end", () => data.end(name))
    child[name].on("close", () => data.close(name))
    child[name].on("error", () => { data.error(name); onError(new Error("component_data")) })
  }
  beforeNs = process.hrtime.bigint()
  wire.send({ protocol: "desk.owned-git/1", role: "parent", type: "PREPARE", ...binding,
    nodeExecutable: assets.nodeExecutable, rootScript: assets.shim, neutralCwd: assets.publicMcpRoot,
    privateRoot: prepareBinding.privateRoot, pipeSuffix: crypto.randomBytes(32).toString("hex"),
    capability: crypto.randomBytes(32).toString("hex"), clock: deadline.clock, deadlineNs: deadline.expiresNs.toString() })
  return { child, wire, binding, beforeNs, assets, preparation: bound, observations, policy, data,
    stagePayload(payload) {
      if (!payloadPath || payloadStaged || !core.remainingNanoseconds(deadline, process.hrtime.bigint())) fail()
      payloadStaged = true
      const staged = stagePayloadFile({ payload, payloadPath, expectedPath: path.join(prepareBinding.privateRoot, "payload.json") })
      observations.expectInput(staged.expectedBytes)
      wire.send({ protocol: "desk.owned-git/1", role: "parent", type: "CONFIG", generation: binding.generation,
        preparationDigest: binding.preparationDigest, payloadDigest: staged.payloadDigest, path: payloadPath })
      return staged
    } }
}
module.exports = { validateClockReady, createDriverPolicy, createDataObservations, createObservations, createWire, stagePayloadFile, launchComponent }
