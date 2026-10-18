import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createHash, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { NATIVE_TEST_NAME } from "../../../../../.github/scripts/owned-git-product-io.mjs"

const require = createRequire(import.meta.url)
const core = () => require("../../../../../plugins/desk/mcp/scripts/owned-git-child.cjs")
const verifier = () => import("../../../../../plugins/desk/mcp/scripts/verify-owned-git.js")
const driver = () => require("./fixtures/windows_owned_git_driver.cjs")
const H = "a".repeat(64), P = "b".repeat(64), Q = "c".repeat(64), nonce = "d".repeat(64)
const binding = { generation: H, preparationDigest: P, payloadDigest: null }
const frame = (role, type, extra = {}, digest = null) => ({
  protocol: "desk.owned-git/1", role, type, ...binding, payloadDigest: digest, ...extra,
})
const hash = (v) => createHash("sha256").update(v).digest("hex")
const input = (patch = {}) => ({ state: "complete", expectedBytes: 0, submittedBytes: 0, errorCode: null, ...patch })
const result = () => ({ command: { state: "exited", code: 0, signal: null }, input: input() })
const b64 = (v) => Buffer.from(JSON.stringify(v)).toString("base64")
const certificate = (patch = {}) => ({ protocol: "desk.owned-git/1", purpose: "triage-private-git",
  ...binding, sealed: true, exactJobZero: true, rootRetired: true, startIssued: false,
  commandState: "not_started", resultB64: null, ...patch })
function payload(patch = {}) {
  return { executable: "git", args: ["status", "--porcelain"], cwd: "/workspace", env: { PATH: "/bin" }, stdin: null, ...patch }
}
function nativeState(patch = {}) {
  return { schema: "desk.owned-git-fixture-event/1", type: "STATE", phase: "FINAL", mode: "O02",
    ownerCaptured: true, created: true, assigned: false, resumed: false, startIssued: false,
    rootRetiredReported: true, privateZeroReported: true, rootLiveActual: false, anyJobMemberActual: true,
    assignmentModeled: true, resumeModeled: false, membershipModeled: false, queryModeled: false,
    rootWaitModeled: false, clockModeled: false, authMutated: false, ioRouteInstrumented: false,
    pendingRead: false, pendingWrite: false, cancelReadRequested: true, cancelWriteRequested: false,
    readReaped: true, writeReaped: false, storageRetained: true, rootEOFAtNs: null,
    extraHandlesPeak: 3, deadlineNs: "1000", telemetryGap: false, ...patch }
}
if (driver().nativeRegistrationAllowed({ platform:process.platform,native:process.env.DESK_TEST_OWNED_GIT_NATIVE,
  event:process.env.GITHUB_EVENT_NAME,mode:process.env.DESK_TEST_SUITE_MODE,sha:process.env.GITHUB_SHA,
  Hns:process.env.DESK_TEST_OWNED_GIT_H,execArgv:process.execArgv })) {
  test(NATIVE_TEST_NAME, { timeout:Math.max(1,Math.min(120000,
    Number((BigInt(process.env.DESK_TEST_OWNED_GIT_H)-process.hrtime.bigint())/1000000n))) }, async () => {
    try {
      const result = await driver().runNativeOuter()
      assert.equal(result.completeArtifact,true)
    } catch { throw new Error("owned_git_native_incomplete") }
  })
}
function prepared(c) {
  const token = "1".repeat(32)
  return c.createPreparationBinding({
    generation: H, recordId: Q, token, deskRoot: "/desk",
    candidatePath: `/desk/.git/desk-triage/${token}/wt`, ref: `desk-triage/${token}`,
    commandRole: "commit", sequence: 1, privateRealmRoot: "/private", privateRoot: "/private/generation",
  }, { publicMcpRoot: "/public/mcp", nodeExecutable: "/public/node", nodeSha256: H, ownerSha256: P, shimSha256: Q },
  { clock: "win-qpc-ns/1", expiresNs: 10000000000n })
}
function authenticate(c) {
  const state = c.createRootState(binding, nonce, Q)
  state.hello()
  assert.equal(state.accept(frame("owner", "AUTH", { clientNonce: nonce, capability: Q })), "send_ack")
  return state
}
function componentSession(onFrame = () => {}) {
  const c = core(), d = driver(), stream = new EventEmitter(), frames = [], errors = [], writes = []
  const currentBinding = { ...binding }, deadline = c.captureDeadline(1000)
  const observations = d.createObservations(currentBinding, 0)
  stream.write = (bytes, callback) => { writes.push(Buffer.from(bytes)); callback() }
  stream.end = () => {}
  const wire = d.createWire({ stream, binding: currentBinding, deadline,
    onFrame(value) {
      if (["RESULT", "CONTROL_COMPLETE", "TERMINAL"].includes(value.type)) observations.owner(value)
      frames.push(value)
      onFrame(value, wire)
    }, onError: (error) => errors.push(error.message) })
  const receive = (value) => stream.emit("data", c.encodeFrame(value))
  const clock = { clock: deadline.clock, deadlineNs: deadline.expiresNs.toString() }
  const clockReady = () => receive(frame("owner", "CLOCK_READY", { ...clock,
    qpcTicks: "10000000", qpcFrequency: "10000000", nowNs: "1000000000" }))
  const acceptClock = () => wire.send(frame("parent", "CLOCK_ACCEPT", clock))
  const ready = () => receive(frame("owner", "READY", { payloadPath: "/payload" }))
  return { wire, receive, stream, frames, errors, writes, observations, clockReady, acceptClock, ready,
    configure() {
      clockReady(); acceptClock(); ready()
      wire.send(frame("parent", "CONFIG", { path: "/payload" }, Q))
      receive(frame("owner", "CONFIGURED", {}, Q))
    } }
}

// Each test's assertions name an observable break, not a source-text spelling.
test("portable codec rejects foreign replay and encoded bounds", () => {
  const c = core(), value = frame("owner", "READY", { payloadPath: "/private/payload.json" })
  const dec = c.createFrameDecoder({ role: "owner", binding, phase: "clock_accepted" })
  const bytes = c.encodeFrame(value)
  assert.deepEqual(dec.push(bytes.subarray(0, 3)), [])
  assert.deepEqual(dec.push(bytes.subarray(3)), [value])
  assert.throws(() => dec.push(bytes))
  assert.throws(() => c.encodeFrame({ ...value, unexpected: true }))
  const fresh = () => c.createFrameDecoder({ role: "owner", binding, phase: "clock_accepted" })
  assert.throws(() => fresh().push(c.encodeFrame({ ...value, generation: Q })))
  const max = frame("parent", "CONFIG", { path: "/" }, Q)
  max.path += "x".repeat(16380 - Buffer.byteLength(JSON.stringify(max)))
  assert.equal(c.encodeFrame(max).length, 16384)
  assert.throws(() => c.encodeFrame({ ...max, path: `${max.path}x` }))
  const truncated = fresh(); truncated.push(bytes.subarray(0, -1)); assert.throws(() => truncated.end())
  const duplicate = Buffer.from(JSON.stringify(value).replace('"role":"owner"', '"role":"owner","role":"owner"'))
  const wire = Buffer.alloc(duplicate.length + 4); wire.writeUInt32LE(duplicate.length); duplicate.copy(wire, 4)
  assert.throws(() => fresh().push(wire))
  const together = Buffer.concat([bytes, c.encodeFrame(frame("owner", "TERMINAL",
    { certificate: certificate(), resultB64: null, failureCode: "none" }))])
  assert.equal(fresh().push(together).length, 2)
  assert.throws(() => fresh().push(c.encodeFrame(frame("owner", "TERMINAL",
    { certificate: certificate(), resultB64: null, failureCode: "none" }, Q))))
  const poisoned = Buffer.from([1, 0, 0, 0, 255])
  assert.throws(() => fresh().push(poisoned))
  const noClockAccept = c.createFrameDecoder({ role: "owner", binding, phase: "clock_ready" })
  assert.throws(() => noClockAccept.push(bytes), { code: "protocol" })
  assert.throws(() => noClockAccept.push(Buffer.alloc(0)), { code: "protocol" })
  const noStart = c.createFrameDecoder({ role: "owner", binding: { ...binding, payloadDigest: Q }, phase: "configured" })
  assert.throws(() => noStart.push(c.encodeFrame(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))), { code: "protocol" })
})

test("portable preparation binding canonical tuple", () => {
  const c = core(), { preparation: p, preparationDigest: digest } = prepared(c)
  const tuple = ["desk.owned-git/1", "triage-private-git", H, Q, "1".repeat(32), "/desk",
    `/desk/.git/desk-triage/${"1".repeat(32)}/wt`, `desk-triage/${"1".repeat(32)}`, "commit", 1,
    "/private", "/private/generation", "/public/mcp", "/public/node", H, P, Q, "win-qpc-ns/1", "10000000000"]
  assert.equal(digest, hash(JSON.stringify(tuple)))
  const inputKeys = ["generation", "recordId", "token", "deskRoot", "candidatePath", "ref", "commandRole", "sequence", "privateRealmRoot", "privateRoot"]
  const assetKeys = ["publicMcpRoot", "nodeExecutable", "nodeSha256", "ownerSha256", "shimSha256"]
  const raw = Object.fromEntries(inputKeys.map((k) => [k, p[k]]))
  const assets = Object.fromEntries(assetKeys.map((k) => [k, p[k]]))
  const deadline = { clock: p.clock, expiresNs: 10000000000n }
  for (const [key, value] of [["generation", Q], ["recordId", H], ["commandRole", "stage"], ["sequence", 2],
    ["privateRoot", "/private/next"], ["privateRealmRoot", "/realm"]]) {
    assert.notEqual(c.createPreparationBinding({ ...raw, [key]: value }, assets, deadline).preparationDigest, digest)
  }
  for (const key of assetKeys) assert.notEqual(c.createPreparationBinding(raw,
    { ...assets, [key]: key.endsWith("Sha256") ? nonce : `/different/${key}` }, deadline).preparationDigest, digest)
  assert.notEqual(c.createPreparationBinding(raw, assets, { ...deadline, expiresNs: 9999999999n }).preparationDigest, digest)
  assert.throws(() => c.createPreparationBinding(raw, assets, { ...deadline, clock: "UTC" }))
  assert.throws(() => c.createPreparationBinding({ ...raw, token: H }, assets, deadline))
  assert.throws(() => c.createPreparationBinding({ ...raw, token: [raw.token] }, assets, deadline), { code: "protocol" })
  assert.throws(() => c.createPreparationBinding({ ...raw, phase: "ready" }, assets, deadline))
  assert.throws(() => c.createPreparationBinding(p, assets, deadline))
  const d = c.captureDeadline(2000, { clock: p.clock, expiresNs: 10000000000n })
  assert.equal(d.expiresNs, 10000000000n) // A past parent is never renewed.
  assert.equal(c.remainingNanoseconds(d, 9000000000n), 1000000000n)
  assert.equal(c.remainingNanoseconds(d, 11000000000n), 0n)
  assert.throws(() => c.captureDeadline(10001))
  assert.equal(c.mirrorWindowsHrtime("10000000", "10000000"), 1000000000n)
  assert.throws(() => c.mirrorWindowsHrtime("01", "100"))
  assert.throws(() => c.mirrorWindowsHrtime("1", "0"))
  const before = process.hrtime.bigint(), filter = c.captureDeadline(2000), after = process.hrtime.bigint()
  assert.ok(filter.expiresNs >= before + 2000000000n && filter.expiresNs <= after + 2000000000n)
})

test("portable root authenticates nonce and capability before config", () => {
  const c = core(), state = c.createRootState(binding, nonce, Q)
  assert.equal("capability" in state.hello(), false)
  assert.throws(() => state.accept(frame("owner", "AUTH", { clientNonce: H, capability: Q })))
  for (const patch of [{ capability: H }, { generation: Q }, { role: "parent" }]) {
    const s = c.createRootState(binding, nonce, Q); s.hello()
    assert.throws(() => s.accept({ ...frame("owner", "AUTH", { clientNonce: nonce, capability: Q }), ...patch }))
  }
  const early = c.createRootState(binding, nonce, Q); early.hello()
  assert.throws(() => early.accept(frame("owner", "CONFIG", { path: "/payload" }, Q)))
  assert.throws(() => c.createRootState({ ...binding, payloadDigest: Q }, nonce, Q))
  const good = authenticate(c)
  assert.throws(() => good.accept(frame("owner", "AUTH", { clientNonce: nonce, capability: Q })))
  assert.throws(() => state.accept(frame("owner", "AUTH", { clientNonce: nonce, capability: Q })))
})

test("portable resumed ready root is not START", () => {
  const c = core(), state = authenticate(c)
  assert.equal(state.started, false)
  assert.equal(state.accept(frame("owner", "CONFIG", { path: "/payload" }, Q)), "read_payload")
  assert.equal(state.configured(), "configured")
  assert.equal(state.started, false)
  assert.equal(state.accept(frame("owner", "START", {}, Q)), "start")
  assert.equal(state.started, true)
  assert.throws(() => state.accept(frame("owner", "START", {}, Q)))
})

test("portable payload bytes retain exact command and privacy boundaries", () => {
  const c = core()
  const original = payload({ args: ["-c", 'x="é"', ""], env: {
    NODE_OPTIONS: "--require hook.cjs", NODE_PATH: "/hooks", PATH: "/chosen",
    DESK_OWNED_GIT_CAPABILITY: Q, NODE_CHANNEL_FD: "3", NODE_CHANNEL_SERIALIZATION_MODE: "advanced",
  }, stdin: Buffer.from([0, 255, 13, 10]) })
  const encoded = c.encodePayload(original), parsed = c.parsePayloadBytes(encoded.bytes, encoded.payloadDigest)
  assert.deepEqual(parsed.args, original.args)
  assert.deepEqual(parsed.stdin, original.stdin)
  assert.deepEqual(parsed.env, { NODE_OPTIONS: "--require hook.cjs", NODE_PATH: "/hooks", PATH: "/chosen" })
  assert.throws(() => c.parsePayloadBytes(encoded.bytes, H))
  assert.throws(() => c.parsePayloadBytes(Buffer.alloc(1048577), H))
  const bad = Buffer.from(JSON.stringify({ ...payload(), stdin: "AB==" }))
  assert.throws(() => c.parsePayloadBytes(bad, hash(bad)))
  assert.throws(() => c.encodePayload(payload({ env: { "A=B": "x" } })))
  assert.throws(() => c.encodePayload(payload({ executable: "git\0evil" })))
  const duplicate = Buffer.from(JSON.stringify(payload()).replace('"stdin":null', '"stdin":null,"stdin":null'))
  assert.throws(() => c.parsePayloadBytes(duplicate, hash(duplicate)))
  const atLimit = payload({ env: { PAD: "" } })
  atLimit.env.PAD = "x".repeat(1048576 - Buffer.byteLength(JSON.stringify(atLimit)))
  assert.equal(c.encodePayload(atLimit).bytes.length, 1048576)
  const accepted = c.encodePayload(atLimit)
  assert.equal(c.parsePayloadBytes(accepted.bytes, accepted.payloadDigest).env.PAD.length, atLimit.env.PAD.length)
  atLimit.env.PAD += "x"; assert.throws(() => c.encodePayload(atLimit))
})

test("portable result normalization retains failure and signal", () => {
  const c = core()
  assert.deepEqual(c.normalizeResult({ code: null, signal: "SIGTERM", input: input() }).command,
    { state: "exited", code: null, signal: "SIGTERM" })
  assert.equal(c.normalizeResult({ code: 9, signal: null, input: input() }).command.code, 9)
  assert.equal(c.normalizeResult({ spawnError: { code: "ENOENT" }, input: input() }).command.state, "spawn_failed")
  assert.equal(c.normalizeResult({ spawnError: { code: 123 }, input: input() }).command.code, "UNKNOWN")
  assert.equal(c.normalizeResult({ input: input() }).command.state, "unknown")
  const max = { command: { state: "spawn_failed", code: "X".repeat(80) },
    input: input({ state: "unknown", expectedBytes: Number.MAX_SAFE_INTEGER, submittedBytes: Number.MAX_SAFE_INTEGER, errorCode: "Y".repeat(80) }) }
  assert.equal(Buffer.byteLength(JSON.stringify(max)), 316)
  const encoded = b64(max), cert = certificate({ payloadDigest: Q, startIssued: true, commandState: "reported", resultB64: encoded })
  const terminal = frame("owner", "TERMINAL", { certificate: cert, resultB64: encoded, failureCode: "retirement" }, Q)
  assert.ok(c.encodeFrame(terminal).length < 4100)
  assert.throws(() => c.encodeFrame({ ...terminal, resultB64: b64(result()) }))
  assert.throws(() => c.encodeFrame({ ...terminal, certificate: null, payloadDigest: null }))
  for (const text of [JSON.stringify(max) + " ", " ".repeat(513), '{"input":{},"command":{}}']) {
    assert.throws(() => c.encodeFrame(frame("root", "RESULT", { resultB64: Buffer.from(text).toString("base64") }, Q)))
  }
})

test("portable input requires finish close and no late error", () => {
  const root = require("./fixtures/windows_owned_git_fault_root.cjs")
  const fixtureInput = new EventEmitter(); fixtureInput.destroy = () => {}
  const final = []
  const pipeline = root.createFixtureResultPipeline({ core: core(), stream: fixtureInput, expectedBytes: 4,
    deadline: core().captureDeadline(1000), emit: (v) => final.push(v) })
  pipeline.commandClosed({ code: 0, signal: null })
  pipeline.recordSubmitted(4)
  fixtureInput.emit("finish")
  assert.equal(final.length, 0)
  fixtureInput.emit("error", { code: "EPIPE" }); fixtureInput.emit("close")
  assert.equal(final.length, 1)
  assert.equal(final[0].input.state, "failed")
  const ignored = []
  const noInput = root.createFixtureResultPipeline({ core: core(), stream: null, expectedBytes: 0,
    deadline: core().captureDeadline(1000), emit: (v) => ignored.push(v) })
  noInput.commandClosed({ code: 0, signal: null })
  assert.equal(ignored.length, 1)
  assert.deepEqual(ignored[0], result())
  let released = 0
  const release = root.createPostResultGate({ core: core(), deadline: core().captureDeadline(1000),
    fault: () => released++ })
  assert.equal(release.result(result()), b64(result()))
  release.writeCompleted()
  assert.equal(released, 0) // Local write completion is not parent admission.
  release.cue(Buffer.from("REL")); release.cue(Buffer.from("EASE\n"))
  assert.equal(released, 0) // Complete cue still needs actual separate-channel EOF.
  release.cueEnd(); assert.equal(released, 1)
  assert.throws(() => release.cue(Buffer.from("RELEASE\n")))
  const early = root.createPostResultGate({ core: core(), deadline: core().captureDeadline(1000), fault: () => released++ })
  assert.throws(() => early.cue(Buffer.from("RELEASE\n")))
  const bad = root.createPostResultGate({ core: core(), deadline: core().captureDeadline(1000), fault: () => released++ })
  bad.result(result()); bad.writeCompleted()
  assert.throws(() => bad.cue(Buffer.from("RELEASE\nx")))
  assert.equal(released, 1)
  const duplicateEOF = root.createPostResultGate({ core: core(), deadline: core().captureDeadline(1000), fault: () => released++ })
  duplicateEOF.result(result()); duplicateEOF.cue(Buffer.from("RELEASE\n")); duplicateEOF.cueEnd()
  assert.throws(() => duplicateEOF.cueEnd())
  const clock = root.createClockCompanion({ core: core(), deadline: { clock: "win-qpc-ns/1", expiresNs: 1000n },
    now: (() => { const times = [9n, 11n]; return () => times.shift() })() })
  const companionSchema = "desk.owned-git-clock-companion/1"
  assert.equal(clock.accept({ schema: companionSchema, type: "BEGIN", index: 0 }).beforeNs, "9")
  const row = clock.accept({ schema: companionSchema, type: "SAMPLE_VALUE", index: 0,
    q: "10", f: "1000000000", converted: "10", edge: "11" })
  assert.equal(row.accepted, true); assert.equal(row.origin, "root-companion")
  assert.equal(row.afterNs, "11")
  assert.throws(() => clock.accept({ schema: companionSchema, type: "SAMPLE_VALUE", index: 0,
    q: "10", f: "1000000000", converted: "10", edge: "11" }))
  const vectorEvent = { schema: "desk.owned-git-fixture-event/1", type: "VECTORS",
    bits: [true,true,false,false,false], checksPassed: 5, kernelCredit: false }
  assert.deepEqual(root.validateFixtureEvent(vectorEvent), vectorEvent)
  assert.throws(() => root.validateFixtureEvent({ ...vectorEvent, checksPassed: 4 }))
  assert.throws(() => root.validateFixtureEvent({ ...vectorEvent, kernelCredit: true }))
  assert.throws(() => root.validateFixtureEvent({ ...vectorEvent, raw: "not allowed" }))
  const peer = new EventEmitter(); peer.write = (_bytes, callback) => { callback(); return true }
  const bridgeFrames = []
  const bridge = driver().createFixtureBridgeObserver({ stream: peer, deadline: core().captureDeadline(1000),
    onFrame: (value) => bridgeFrames.push(value) })
  const encodedVector = Buffer.from(JSON.stringify(vectorEvent)), framedVector = Buffer.alloc(encodedVector.length + 4)
  framedVector.writeUInt32LE(encodedVector.length); encodedVector.copy(framedVector, 4)
  for (const byte of framedVector) peer.emit("data", Buffer.from([byte]))
  peer.emit("end"); peer.emit("close")
  assert.deepEqual(bridgeFrames, [vectorEvent])
  assert.equal(bridge.snapshot().footer, null) // Real end/close never invents C telemetry/footer.
  assert.equal(bridge.snapshot().failed, false)
  const badPeer = new EventEmitter(); badPeer.write = (_bytes, callback) => { callback(); return true }
  const badBridge = driver().createFixtureBridgeObserver({ stream: badPeer, deadline: core().captureDeadline(1000) })
  const badFooter = Buffer.from(JSON.stringify({ schema: vectorEvent.schema, type: "CLOSED",
    requests: 0, creationCalls: 0, ownerFreed: false, telemetryGap: false, deadlineNs: "0" }))
  const badFooterFrame = Buffer.alloc(badFooter.length + 4)
  badFooterFrame.writeUInt32LE(badFooter.length); badFooter.copy(badFooterFrame, 4)
  badPeer.emit("data", badFooterFrame)
  assert.equal(badBridge.snapshot().failed, true)
  assert.equal(badBridge.snapshot().footer, null)
  const latePeer = new EventEmitter(); latePeer.write = (_bytes, callback) => { callback(); return true }
  const lateBridge = driver().createFixtureBridgeObserver({ stream: latePeer,
    deadline: { clock: "win-qpc-ns/1", expiresNs: 0n }, observationEnd: process.hrtime.bigint() + 1000000000n })
  latePeer.emit("data", badFooterFrame)
  assert.equal(lateBridge.snapshot().footer?.creationCalls, 0)
  assert.equal(lateBridge.snapshot().footerLate, true)
  const c = core(), stream = new EventEmitter(); stream.destroy = () => {}
  let observed
  const t = c.createFinalInputTracker({ stream, expectedBytes: 4,
    deadline: { clock: "win-qpc-ns/1", expiresNs: process.hrtime.bigint() + 1000000000n }, onSettled: (v) => { observed = v } })
  t.recordSubmitted(4); stream.emit("finish"); assert.equal(t.result(), null)
  stream.emit("error", { code: "EPIPE" }); stream.emit("close")
  assert.equal(observed.state, "failed"); assert.equal(observed.submittedBytes, 4)
  const no = c.createFinalInputTracker({ stream: null, expectedBytes: 0, deadline: c.captureDeadline(1000), onSettled() {} })
  assert.deepEqual(no.result(), input())
  let destroyed = false
  const outstanding = new EventEmitter(); outstanding.destroy = () => { destroyed = true }
  const pending = c.createFinalInputTracker({ stream: outstanding, expectedBytes: 1, deadline: c.captureDeadline(1000), onSettled() {} })
  pending.onCommandExit(); assert.equal(destroyed, true); assert.equal(pending.result(), null)
  outstanding.emit("close"); assert.equal(pending.result().state, "failed")
  const expired = c.createFinalInputTracker({ stream: outstanding, expectedBytes: 1,
    deadline: { clock: "win-qpc-ns/1", expiresNs: 0n }, onSettled() {} })
  assert.equal(expired.result().state, "unknown")
  const unavailable = c.createFinalInputTracker({ stream: null, expectedBytes: 4, deadline: c.captureDeadline(1000), onSettled() {} })
  assert.equal(unavailable.result().state, "failed")
  const positive = new EventEmitter(); positive.destroy = () => {}
  const good = c.createFinalInputTracker({ stream: positive, expectedBytes: 3, deadline: c.captureDeadline(1000), onSettled() {} })
  good.recordSubmitted(1); good.recordSubmitted(2)
  positive.emit("finish"); assert.equal(good.result(), null)
  positive.emit("close"); assert.equal(good.result().state, "complete")
})

test("portable actual root result waits for final input", () => {
  const c = core(), sent = [], s = new EventEmitter(); s.destroy = () => {}
  let gate
  const tracker = c.createFinalInputTracker({ stream: s, expectedBytes: 2, deadline: c.captureDeadline(1000),
    onSettled: (v) => gate.inputSettled(v) })
  gate = c.createResultGate({ sendResult: (v) => sent.push(v), inputTracker: tracker })
  gate.commandClosed({ code: 0, signal: null }); assert.equal(sent.length, 0)
  tracker.recordSubmitted(1); s.emit("finish"); assert.equal(sent.length, 0)
  s.emit("close"); assert.equal(sent.length, 1); assert.equal(sent[0].input.state, "failed")
  gate.commandClosed({ code: 0, signal: null }); assert.equal(sent.length, 1)
})

test("portable root result and actual EOF remain distinct", () => {
  const c = core(), sent = [], stream = new EventEmitter(); let callback, ended = false
  stream.write = (bytes, cb) => { sent.push(bytes); callback = cb }
  stream.end = () => { ended = true }
  const out = c.createFrameWriter(stream)
  out.send(frame("root", "RESULT", { resultB64: b64(result()) }, Q)); out.finish()
  assert.equal(ended, false); callback(); assert.equal(ended, true)
  assert.throws(() => out.send(frame("root", "RESULT", { resultB64: b64(result()) }, Q)))
  const observation = driver().createObservations({ ...binding, payloadDigest: Q }, 0)
  observation.owner(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))
  assert.equal(observation.snapshot().controlComplete, false)
  observation.controlEOF(); assert.equal(observation.snapshot().certificate, null)
  assert.throws(() => observation.owner(frame("owner", "TERMINAL", { certificate: null,
    resultB64: b64({ command: { state: "exited", code: 5, signal: null }, input: input() }), failureCode: "none" }, Q)))
  let writes = 0
  const pressured = { write() { writes++ }, end() {} }
  const bounded = c.createFrameWriter(pressured)
  bounded.send(frame("root", "RESULT", { resultB64: b64(result()) }, Q))
  bounded.send(frame("root", "RESULT", { resultB64: b64(result()) }, Q))
  assert.throws(() => bounded.send(frame("root", "RESULT", { resultB64: b64(result()) }, Q)))
  assert.equal(writes, 1)
  const original = b64(result()), acceptedBinding = { ...binding, payloadDigest: Q }
  const terminal = (cert, resultB64) => frame("owner", "TERMINAL", { certificate: cert, resultB64, failureCode: "none" }, Q)
  const unknown = certificate({ payloadDigest: Q, startIssued: true, commandState: "unknown" })
  const reported = certificate({ payloadDigest: Q, startIssued: true, commandState: "reported", resultB64: original })
  for (const missing of [terminal(unknown, null), terminal(null, null)]) {
    const observed = driver().createObservations(acceptedBinding, 0)
    observed.owner(frame("owner", "RESULT", { resultB64: original }, Q))
    assert.throws(() => observed.owner(missing), /component_protocol/u)
    assert.deepEqual(observed.snapshot().result, result())
    assert.equal(observed.snapshot().certificate, null)
    assert.throws(() => observed.owner(terminal(reported, original)), /component_protocol/u)
    const decoder = c.createFrameDecoder({ role: "owner", binding: acceptedBinding, phase: "running" })
    decoder.push(c.encodeFrame(frame("owner", "RESULT", { resultB64: original }, Q)))
    assert.throws(() => decoder.push(c.encodeFrame(missing)), { code: "protocol" })
  }
  for (const cert of [reported, null]) {
    const valid = driver().createObservations(acceptedBinding, 0)
    valid.owner(frame("owner", "RESULT", { resultB64: original }, Q))
    valid.owner(frame("owner", "CONTROL_COMPLETE", {}, Q))
    valid.owner(terminal(cert, original))
    assert.deepEqual(valid.snapshot().result, result())
    assert.deepEqual(valid.snapshot().certificate, cert)
  }
})

async function fixture() {
  const v = await verifier()
  const root = path.join(process.env.DESK_TEST_RUN_DIR, `nc3-assets-${randomUUID()}`)
  const pub = path.join(root, "public"), realm = path.join(root, "private"), target = path.join(pub, "artifacts/owned-git/win32-x64")
  fs.mkdirSync(target, { recursive: true }); fs.mkdirSync(realm)
  fs.writeFileSync(path.join(root, "node"), "synthetic interpreter; NEVER execute")
  fs.writeFileSync(path.join(target, "desk-owned-git.exe"), "synthetic owner; NEVER execute")
  fs.writeFileSync(path.join(target, "owned-git-child.cjs"), "synthetic shim; NEVER execute")
  const sourceNames = ["native/windows-owned-git.c", "scripts/owned-git-child.cjs", "scripts/build-owned-git.ps1", "scripts/verify-owned-git.js"]
  const manifest = { schema: "desk.owned-git-assets/1", protocol: "desk.owned-git/1", target: "win32-x64", variant: "production",
    sourceRevision: "1".repeat(40), sources: sourceNames.map((name) => ({ path: name, sha256: H })),
    toolchain: { compiler: "clang-cl", version: "MODEL", sdkVersion: "MODEL",
      flags: ["/W4", "/WX", "/MT", "/O2", "/fp:precise", "kernel32.lib", "advapi32.lib"] },
    files: { owner: { path: "desk-owned-git.exe", sha256: hash("synthetic owner; NEVER execute") },
      shim: { path: "owned-git-child.cjs", sha256: hash("synthetic shim; NEVER execute") } } }
  for (const source of manifest.sources) {
    fs.mkdirSync(path.dirname(path.join(pub, source.path)), { recursive: true })
    fs.writeFileSync(path.join(pub, source.path), "synthetic source")
    source.sha256 = hash("synthetic source")
  }

  const write = () => fs.writeFileSync(path.join(target, "manifest.json"), JSON.stringify(manifest))
  write()
  return { v, root, pub, realm, target, manifest, write,
    options: { publicMcpRoot: pub, privateRealmRoot: realm, nodeExecutable: path.join(root, "node") } }
}

async function publicBundleFixture() {
    const r = require("./fixtures/windows_owned_git_retention.cjs")
    const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
    const root = path.join(process.env.DESK_TEST_RUN_DIR, `na1-public-model-${randomUUID()}`)
    const pub = path.join(root, "public"), mcp = path.join(pub, "mcp"), fixtures = path.join(pub, "fixtures")
    const write = (name, bytes) => {
      const file = path.join(root, name)
      fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, bytes)
      return file
    }
    const sourceBytes = r.SOURCE_PATHS.map((name) => fs.readFileSync(path.join(repo, name)))
    const sources = r.SOURCE_PATHS.map((name, i) => ({ key: `S${String(i + 1).padStart(2, "0")}`,
      repositoryPath: name, sha256: hash(sourceBytes[i]), bytes: sourceBytes[i].length, hashOrigin: "ci_host_rehashed" }))
    const exeBytes = r.binaryKeys.map((name) => Buffer.from(`synthetic ${name}; NEVER EXECUTE`))
    const supportBytes = Buffer.from("MODEL support object; NEVER COMPILE OR EXECUTE")
    const indexedBytes = Buffer.from("MODEL indexed baseline; NOT A PROFILE")
    const profiles = ["production", "production-coverage", "fault", "fault-coverage", "supervisor"]
    const binaries = r.binaryKeys.map((name, i) => ({ key: name, sha256: hash(exeBytes[i]), bytes: exeBytes[i].length,
      sourceKey: ["S01", "S01", "S12", "S12", "S13"][i], variant: profiles[i], hashOrigin: "ci_host_rehashed",
      profileSupportSha256: [1, 3].includes(i) ? hash(supportBytes) : null }))
    const compiler = { name: "clang-cl", version: "clang version 19.0.0", sdkVersion: "10.0.0.0",
      imageSha256: H, llvmProfdataSha256: P, llvmCovSha256: Q, pwshVersion: "7.4.0", pwshImageSha256: nonce,
      interop: "in-process-fixed-source", flagsProfiles: [...profiles, "profile-support"],
      coverageMode: "synthetic-indexed-zero-v1", runtimeProfilePolicy: "support-symbol-no-file-init-v1",
      pathMappingApplied: true, privatePathScanPassed: true }
    const expectedSource = { sourceRevision: "1".repeat(40), sourceTree: "2".repeat(40) }
    const production = { schema: "desk.owned-git-assets/1", protocol: "desk.owned-git/1", target: "win32-x64",
      variant: "production", sourceRevision: expectedSource.sourceRevision,
      sources: sources.slice(0, 4).map((s) => ({ path: s.repositoryPath.slice("plugins/desk/mcp/".length), sha256: s.sha256 })),
      toolchain: { compiler: "clang-cl", version: compiler.version, sdkVersion: compiler.sdkVersion,
        flags: ["/W4", "/WX", "/MT", "/O2", "/fp:precise", "kernel32.lib", "advapi32.lib"] },
      files: { owner: { path: "desk-owned-git.exe", sha256: binaries[0].sha256 },
        shim: { path: "owned-git-child.cjs", sha256: sources[1].sha256 } } }
    const source = { schema: "desk.owned-git-sources/1", ...expectedSource, productContentBase: r.PRODUCT_BASE,
      allocationSha256: r.ALLOCATION_SHA, sources }
    const encoded = (value) => Buffer.from(JSON.stringify(value) + "\n")
    const variants = r.variants.map((basename) => ({ basename, sourceKey: "S11", sha256: sources[10].sha256, production: false }))
    const fixtureManifest = { schema: "desk.owned-git-fixtures/1", ...expectedSource,
      allocationSha256: r.ALLOCATION_SHA, compiler, binaries, roots: variants,
      profileSupport: { sourceKey: "S12", basename: "na1-profile-support.obj", sha256: hash(supportBytes),
        bytes: supportBytes.length, compileProfile: "profile-support", definition: "DESK_NA1_PROFILE_SUPPORT=1", instrumented: false },
      syntheticBaseline: { kind: "fe-synthetic-zero-v1",
        textSha256: "662970fac258865cfe4002ed63efa04be7a132f9319451a70ffd15233a55eb1f", textBytes: 32,
        indexedSha256: hash(indexedBytes), indexedBytes: indexedBytes.length, producerSha256: P, roundTripObserved: true },
      productionManifestSha256: hash(encoded(production)), sourceManifestSha256: hash(encoded(source)) }
    for (let i = 0; i < 17; i++) write(r.PUBLIC_LEAVES[i], sourceBytes[i])
    for (let i = 0; i < 4; i++) write(`public/mcp/${production.sources[i].path}`, sourceBytes[i])
    for (let i = 0; i < 5; i++) { write(r.PUBLIC_LEAVES[17 + i], exeBytes[i]); write(`public/fixtures/${r.binaryKeys[i]}`, exeBytes[i]) }
    write("public/mcp/artifacts/owned-git/win32-x64/desk-owned-git.exe", exeBytes[0])
    write("public/mcp/artifacts/owned-git/win32-x64/owned-git-child.cjs", sourceBytes[1])
    write("public/mcp/artifacts/owned-git/win32-x64/manifest.json", encoded(production))
    write(r.PUBLIC_LEAVES[22], sourceBytes[1])
    for (const v of variants) write(`public/test-roots/${v.basename}`, sourceBytes[10])
    write("public/fixtures/windows_owned_git_workload.cjs", sourceBytes[14])
    write("public/fixtures/windows_owned_git_preload.cjs", sourceBytes[15])
    write("public/fixtures/hooks/pre-commit", sourceBytes[14])
    write("public/fixtures/source-assets.json", encoded(source))
    write("public/fixtures/fixture-assets.json", encoded(fixtureManifest))
    write("public/fixtures/na1-known-scratch/zero.txt", Buffer.from(":fe\n!na1.synthetic.zero!\n0\n1\n0\n\n"))
    write("public/fixtures/na1-known-scratch/zero.profdata", indexedBytes)
    write("public/fixtures/na1-known-scratch/na1-profile-support.obj", supportBytes)
    write(r.PUBLIC_LEAVES[23], encoded(production)); write(r.PUBLIC_LEAVES[24], encoded(fixtureManifest)); write(r.PUBLIC_LEAVES[25], encoded(source))
    const node = write("public/model-node", "synthetic interpreter; NEVER EXECUTE")
    const realm = path.join(root, "model-private"); fs.mkdirSync(realm)
    const v = await verifier()
    const productionAssets = await v.verifyOwnedGitAssets({ publicMcpRoot: mcp, privateRealmRoot: realm, nodeExecutable: node })
    return { r, root, mcp, fixtures, expectedSource, source, production, fixtureManifest, productionAssets, write }
}

test("portable manifest schema and own bytes are required", async () => {
  const retention = require("./fixtures/windows_owned_git_retention.cjs")
  const gitLayout = retention.gitExecutionLayout?.({ fixtureRoot: "C:\\owned\\public\\fixtures",
    nodeExecutable: "C:\\nodes\\24\\node.exe", gitExecutable: "C:\\Program Files\\Git\\mingw64\\bin\\git.exe",
    shellExecutable: "C:\\Program Files\\Git\\usr\\bin\\sh.exe", systemRoot: "C:\\Windows" })
  assert.deepEqual(gitLayout?.effectivePath, ["C:\\owned\\public\\fixtures\\na1-exec-empty",
    "C:\\nodes\\24", "C:\\Program Files\\Git\\usr\\bin", "C:\\Program Files\\Git\\mingw64\\bin", "C:\\Windows\\System32"])
  assert.deepEqual(retention.gitArguments?.(gitLayout, ["init","--quiet"]),
    ["--exec-path=C:\\owned\\public\\fixtures\\na1-exec-empty","init","--quiet"])
  assert.deepEqual(retention.gitArguments(gitLayout, ["rev-parse","HEAD"],"C:\\source root"),
    ["--exec-path=C:\\owned\\public\\fixtures\\na1-exec-empty","-c","safe.directory=C:\\source root","rev-parse","HEAD"])
  for (const root of ["*", "C:\\source\\*", "C:\\source\\..\\other"]) {
    assert.throws(()=>retention.gitArguments(gitLayout,["rev-parse","HEAD"],root),{code:"guard_failed"})
  }
  assert.equal(retention.gitMountConfig?.(null)?.drivePrefix, "/cygdrive")
  assert.equal(retention.gitMountConfig?.(Buffer.from("# public\r\nnone / cygdrive binary,posix=0,noacl,user 0 0\r\n"))?.drivePrefix, "/")
  for (const value of [Buffer.from("none /other cygdrive binary 0 0\n"), Buffer.from("# bad\r"), Buffer.alloc(4097)]) {
    assert.throws(() => retention.gitMountConfig(value), { code: "guard_failed" })
  }
  assert.equal(retention.gitMsysPath?.("C:\\nodes\\24",gitLayout,"/"),"/c/nodes/24")
  assert.equal(retention.gitMsysPath?.("C:\\Program Files\\Git\\usr\\bin",gitLayout,"/cygdrive"),"/bin")
  assert.equal(retention.gitLookupCandidates?.(gitLayout)?.length,105)
  const gitFiles = new Map(), gitDirectories = new Map()
  let gitInode = 0
  const gitStat = (directory, bytes = 0) => ({ dev:1n,ino:BigInt(++gitInode),size:BigInt(bytes),mtimeNs:1n,
    isDirectory:()=>directory,isFile:()=>!directory,isSymbolicLink:()=>false })
  for (const dir of gitLayout.effectivePath) gitDirectories.set(dir,gitStat(true))
  for (const file of [gitLayout.gitExecutable,gitLayout.shellExecutable,gitLayout.envExecutable,gitLayout.nodeExecutable])
    gitFiles.set(file,gitStat(false,10))
  const gitEdges = { lstatSync:(file) => {
    const st=gitFiles.get(file)||gitDirectories.get(file)
    if (!st) throw Object.assign(new Error("missing"),{code:"ENOENT"})
    return st
  }, opendirSync:()=>({readSync:()=>null,closeSync:()=>{}}) }
  const inspect = () => retention.inspectGitExecution?.(gitLayout,{mountConfigSha256:null,live:()=>{},
    io:gitEdges,physical:()=>{},read:()=>assert.fail("no absent config read")})
  assert.equal(typeof inspect(),"string")
  gitFiles.set("C:\\nodes\\24\\git-owned.lnk",gitStat(false,3))
  assert.throws(inspect,{code:"guard_failed"})
  gitFiles.delete("C:\\nodes\\24\\git-owned.lnk")
  gitFiles.set("C:\\nodes\\24\\sh.exe",gitStat(false,3))
  assert.throws(inspect,{code:"guard_failed"})
  gitFiles.delete("C:\\nodes\\24\\sh.exe")
  gitFiles.set("C:\\Windows\\System32\\busybox.exe",gitStat(false,3))
  assert.throws(inspect,{code:"guard_failed"})
  gitFiles.delete("C:\\Windows\\System32\\busybox.exe")
  const mountBytes=Buffer.from("# fixed public\nnone / cygdrive binary,posix=0,noacl,user 0 0\n")
  const mountFile="C:\\Program Files\\Git\\etc\\fstab"
  gitFiles.set(mountFile,gitStat(false,mountBytes.length))
  const mounted=retention.inspectGitExecution(gitLayout,{mountConfigSha256:hash(mountBytes),live:()=>{},
    io:gitEdges,physical:()=>{},read:(file)=>{assert.equal(file,mountFile);return mountBytes}})
  assert.equal(JSON.parse(mounted).mount.drivePrefix,"/")
  assert.throws(()=>retention.inspectGitExecution(gitLayout,{mountConfigSha256:null,live:()=>{},
    io:gitEdges,physical:()=>{},read:()=>mountBytes}),{code:"source_mismatch"})
  gitFiles.delete(mountFile)
  assert.throws(()=>retention.inspectGitExecution(gitLayout,{mountConfigSha256:null,live:()=>{},
    io:{...gitEdges,lstatSync:()=>{throw Object.assign(new Error("denied"),{code:"EACCES"})}},
    physical:()=>{}}),{code:"EACCES"})
  assert.throws(()=>retention.inspectGitExecution(gitLayout,{mountConfigSha256:null,
    live:()=>{throw Object.assign(new Error("expired"),{code:"deadline"})},io:gitEdges,physical:()=>{}}),
  {code:"deadline"})
  assert.deepEqual(retention.syntheticBaselineRecipe?.()?.text,
    Buffer.from(":fe\n!na1.synthetic.zero!\n0\n1\n0\n\n"))
  assert.equal(retention.syntheticBaselineRecipe().textSha256,
    "662970fac258865cfe4002ed63efa04be7a132f9319451a70ffd15233a55eb1f")
  const recipe = retention.syntheticBaselineRecipe()
  const toolBinding = { executable: "/installed/git.exe", sha256: H, shellExecutable: "/installed/usr/bin/sh.exe",
    shellSha256: H, envSha256: H, msysRuntimeSha256: H }
  assert.equal(retention.externalGitComponents?.(toolBinding, "/owned")?.length, 4)
  assert.throws(() => retention.externalGitComponents({ ...toolBinding, shellExecutable: "/owned/private/sh.exe" }, "/owned"),
    { code: "guard_failed" })
  const gitV2 = { schema:"desk.owned-git-fixture-git/2",sourceRevision:"1".repeat(40),sourceTree:"2".repeat(40),
    executable:"/installed/mingw64/bin/git.exe",sha256:H,version:"git version 2.50.0.windows.1",
    shellExecutable:"/installed/usr/bin/sh.exe",shellSha256:H,envSha256:H,msysRuntimeSha256:H,
    imagePolicy:"direct-mingw64-empty-exec-v1",execPath:"/owned/public/fixtures/na1-exec-empty",mountConfigSha256:null }
  const gitExpected={sourceRevision:gitV2.sourceRevision,sourceTree:gitV2.sourceTree,fixtureRoot:"/owned/public/fixtures"}
  assert.deepEqual(retention.projectGitBinding?.(gitV2,gitExpected),gitV2)
  for (const bad of [{...gitV2,schema:"desk.owned-git-fixture-git/1"},
    {...gitV2,execPath:"/owned/private/exec"},{...gitV2,fresh:true},
    {...gitV2,executable:"/installed/cmd/git.exe"}]) {
    assert.throws(()=>retention.projectGitBinding(bad,gitExpected))
  }
  assert.equal(retention.validateSyntheticInput?.(recipe.text)?.publicScratchBytes, 9248)
  for (const bytes of [Buffer.from(":fe\n!na1.synthetic.zero!\n0\n1\n0\n0\n"),
    recipe.text.subarray(0, 31), Buffer.concat([recipe.text, Buffer.from("\n")])]) {
    assert.throws(() => retention.validateSyntheticInput(bytes), { code: "source_mismatch" })
  }
  const bundle = await publicBundleFixture()
  const selected = driver().resolveFixtureAssets({ productionAssets: bundle.productionAssets,
    fixtureManifest: bundle.fixtureManifest, variant: "malformed" })
  assert.equal(selected.shim, path.join(bundle.root, "public/test-roots/malformed.cjs"))
  assert.equal(selected.owner, bundle.productionAssets.owner)
  assert.equal(selected.evidenceClass, "B")
  const variants = ["wrong-pid-delay","malformed","replay-result","trailing","partial-header",
    "partial-body","oversized","eof-before-result","pressure","normal"]
  for (let i = 0; i < 10; i++) {
    const chosen = driver().resolveRegistryFixture({ productionAssets: bundle.productionAssets,
      fixtureManifest: bundle.fixtureManifest, caseId: `B${String(i + 1).padStart(2,"0")}-P24-R24`,
      parent: "24", root: "24" })
    assert.equal(chosen.owner, bundle.productionAssets.owner)
    assert.equal(chosen.shim, path.join(bundle.root, `public/test-roots/${variants[i]}.cjs`))
  }
  const fault = driver().resolveFixtureAssets({ productionAssets: bundle.productionAssets,
    fixtureManifest: bundle.fixtureManifest, variant: "fault" })
  assert.equal(fault.owner, path.join(bundle.fixtures, "fault-owner.exe"))
  assert.equal(fault.shim, bundle.productionAssets.shim)
  assert.equal(fault.evidenceClass, "C")
  for (const role of ["20", "22", "24"]) for (const prefix of ["O02","O03","O05","O06","O07"]) {
    const resolved = driver().resolveRegistryFixture({ productionAssets: bundle.productionAssets,
      fixtureManifest: bundle.fixtureManifest, caseId: `${prefix}-P${role}-R${role}`, parent: role, root: role })
    assert.equal(resolved.owner, path.join(bundle.fixtures, "fault-owner.exe"))
    assert.equal(resolved.fixtureTuple.parent.role, role)
    assert.equal(resolved.fixtureTuple.root.role, role)
  }
  assert.throws(() => driver().resolveRegistryFixture({ productionAssets: bundle.productionAssets,
    fixtureManifest: bundle.fixtureManifest, caseId: "O02-P20-R20", parent: "24", root: "20" }))
  assert.throws(() => driver().resolveRegistryFixture({ productionAssets: bundle.productionAssets,
    fixtureManifest: bundle.fixtureManifest, caseId: "B02-P24-R24", parent: "20", root: "24" }))
  const validated = retention.verifyPublicBundle({ publicMcpRoot: bundle.mcp, expectedSource: bundle.expectedSource })
  assert.equal(validated.fixture.profileSupport.sha256, bundle.fixtureManifest.binaries[1].profileSupportSha256)
  assert.throws(() => retention.projectFixtureManifest({ ...bundle.fixtureManifest,
    syntheticBaseline: { ...bundle.fixtureManifest.syntheticBaseline, roundTripObserved: false } }, bundle.expectedSource))
  assert.throws(() => retention.projectFixtureManifest({ ...bundle.fixtureManifest,
    binaries: bundle.fixtureManifest.binaries.map((b, i) => i === 3 ? { ...b, profileSupportSha256: Q } : b) }, bundle.expectedSource))
  assert.equal(validated.rows.length, 26)
  assert.equal(validated.rows[24].sha256, hash(fs.readFileSync(path.join(bundle.root, retention.PUBLIC_LEAVES[24]))))
  assert.throws(() => retention.projectPublicManifests({ production: bundle.production,
    fixture: { ...bundle.fixtureManifest, fixtureRoot: "/forged" }, source: bundle.source }, bundle.expectedSource))
  assert.throws(() => retention.projectPublicManifests({ production: bundle.production,
    fixture: { ...bundle.fixtureManifest, sourceManifestSha256: H }, source: bundle.source }, bundle.expectedSource))
  fs.appendFileSync(path.join(bundle.root, retention.PUBLIC_LEAVES[17]), "changed")
  assert.throws(() => retention.verifyPublicBundle({ publicMcpRoot: bundle.mcp, expectedSource: bundle.expectedSource }))
  const rows = retention.PUBLIC_LEAVES.slice(0, 33).map((name, i) => ({
    id: i + 1, path: name, presence: "present", bytes: 1, sha256: H,
    origin: "ci_host_rehashed", mandatory: true, gap: "none",
  }))
  const canonical = Buffer.from(JSON.stringify(rows))
  assert.deepEqual(retention.canonicalLeafMetadata(rows), canonical)
  assert.equal(retention.computeLeafSetSha256(rows), hash(canonical))
  const reportBytes = Buffer.from('{"status":"complete-observation"}\n')
  rows[26] = { ...rows[26], bytes: reportBytes.length, sha256: hash(reportBytes) }
  const digest = retention.computeLeafSetSha256(rows)
  assert.notEqual(digest, hash(canonical))
  const changedReport = Buffer.concat([reportBytes, Buffer.from("\n")])
  assert.notEqual(digest, retention.computeLeafSetSha256(rows.map((r) => r.id === 27
    ? { ...r, bytes: changedReport.length, sha256: hash(changedReport) } : r)))
  assert.throws(() => retention.canonicalLeafMetadata([...rows, { ...rows[0], id: 34 }]))
  assert.throws(() => retention.canonicalLeafMetadata(rows.map((r) => ({ ...r, extra: true }))))
  assert.throws(() => retention.canonicalLeafMetadata([...rows].reverse()))
  const manifest = { leaves: [...rows, retention.MANIFEST_SELF_ROW], privateRoles: [],
    exclusions: retention.EXCLUSIONS, privateOriginalRehashedByOuter: false,
    publicOriginalRehashedByOuter: false, gaps: [], leafSetSha256: digest }
  assert.equal(retention.projectManifest(manifest).leafSetSha256, digest)
  assert.throws(() => retention.projectManifest({ ...manifest, leafSetSha256: null }))
  assert.throws(() => retention.projectManifest({ ...manifest, leafSetSha256: Q }))
  assert.throws(() => retention.projectManifest({ ...manifest, gaps: ["artifact_missing"] }))
  const stopped = { ...manifest, gaps: ["artifact_missing"], leafSetSha256: null,
    leaves: manifest.leaves.map((r) => r.id === 1 ? { ...r, presence: "missing", bytes: null,
      sha256: null, origin: "unobserved", gap: "artifact_missing" } : r) }
  assert.equal(retention.projectManifest(stopped).leafSetSha256, null)
  assert.throws(() => retention.projectManifest({ ...stopped, leafSetSha256: digest }))
  assert.throws(() => retention.projectManifest({ ...manifest,
    leaves: manifest.leaves.map((r) => r.id === 34 ? { ...r, sha256: H } : r) }))
  assert.deepEqual(reportBytes, Buffer.from('{"status":"complete-observation"}\n'))
  const model = retention.createModelContext({ H: 1000n })
  for (const emit of [
    () => retention.emitNativeHeader(model, "desk.owned-git-native-report/1"),
    () => retention.emitNativeLeaf(model, "desk.owned-git-native-report/1", {}),
    () => retention.emitManifest(model, manifest),
    () => retention.exportSafeEvidence(model),
  ]) assert.throws(emit, { code: "model_origin" })
  await assert.rejects(retention.buildPublicFixtures(model), { code: "model_origin" })
  await assert.rejects(retention.runRetentionControls(model, {}), { code: "model_origin" })
  await assert.rejects(retention.launchCoverageTools(model, {}, {}), { code: "model_origin" })
  assert.throws(() => retention.emitNativeHeader({ execution: "native-windows", nativeOrigin: "real-supervisor" },
    "desk.owned-git-native-report/1"), { code: "not_admitted" })
  assert.deepEqual(retention.modelAudit(model), { nativeHeaders: 0, nativeWrites: 0, privateReads: 0 })
  assert.equal(retention.mapPlanningProducer("fault-owner-model"), "fault-model")
  assert.equal(retention.mapPlanningProducer("real-supervisor"), "real-supervisor")
  assert.equal(retention.runtimeIdentity("24").expectedExeSha256,
    "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de")
  assert.throws(() => retention.runtimeIdentity("18"))
  assert.throws(() => retention.mapPlanningProducer("fault-model"))
  assert.throws(() => retention.projectReport({ leafSetSha256: H }))
  const denominator = { source: "05a68645f6b744ea6f76b685f973e1e0b727453ea23c7255fad9a23c1cf85122",
    regions: 2, branches: 3, functions: 4, lines: 5, origin: "public-instrumented-mapping-synthetic-indexed-zero" }
  const coverage = { production: denominator, fault: { ...denominator }, equal: true,
    scope: "identical-production-file-only", exact100: false,
    executionCounts: "synthetic-zero", runtimeProfile: "not-collected", baselineSha256: Q }
  assert.deepEqual(retention.projectCoverage(coverage), coverage)
  assert.throws(() => retention.projectCoverage({ ...coverage, fault: { ...denominator, lines: 6 } }))
  assert.throws(() => retention.projectCoverage({ ...coverage, exact100: true }))
  const expectedCounts = { componentCases: 80, retentionControls: 7, generations: 75, parentSTART: 40,
    nativeSTART: 39, genuineRESULT: 26, eligibleNativeCertificates: 55, certificateNotStarted: 27,
    certificateReported: 23, certificateUnknown: 5, rootCreations: 70, ownerFullClose: 73,
    ownerFullCloseMissing: 2, utilityProcesses: 10, modelRoots: 1, modelRootsRetiredReal: 1,
    receiptAbsent: 18, receiptWithheld: 2 }
  const reportPayload = { status: "complete-observation", gap: "none", expected: expectedCounts, observed: expectedCounts,
    casesMatched: 80, retentionMatched: 7, bootstrapEligible: true, privateExportComplete: true,
    clockQualifiedObservation: true, denominatorCompared: true, producerFailed: false,
    claims: { nativeQualified: false, exact100Qualified: false, original38Qualified: false,
      full49Qualified: false, recordsQualified: false, integrationQualified: false, releaseQualified: false } }
  const finalized = retention.finalizeManifestPayload({ rows33: rows, report: reportPayload, privateRoles: [], gaps: [] })
  assert.equal(finalized.leafSetSha256, digest)
  const lateError = retention.finalizeManifestPayload({ rows33: rows, report: reportPayload,
    privateRoles: [], gaps: ["artifact_missing"] })
  assert.equal(lateError.leafSetSha256, null)
  assert.deepEqual(reportBytes, Buffer.from('{"status":"complete-observation"}\n'))
  assert.equal(retention.finalizeManifestPayload({ rows33: rows, report: null, privateRoles: [], gaps: [] }).leafSetSha256, null)
  const f = await fixture(), v = f.v
  assert.equal((await v.verifyOwnedGitAssets(f.options)).owner, path.join(f.target, "desk-owned-git.exe"))
  for (const patch of [{ variant: "fault" }, { target: "win32-arm64" }, { protocol: "other" }, { extra: 1 },
    { sources: [...f.manifest.sources, f.manifest.sources[0]] }, { files: { ...f.manifest.files, extra: {} } }]) {
    assert.throws(() => v.validateOwnedGitManifest({ ...f.manifest, ...patch }))
  }
  assert.throws(() => v.validateOwnedGitManifest({ ...f.manifest,
    files: { ...f.manifest.files, owner: { ...f.manifest.files.owner, sha256: [f.manifest.files.owner.sha256] } } }))
  fs.appendFileSync(path.join(f.target, "desk-owned-git.exe"), "changed")
  await assert.rejects(v.verifyOwnedGitAssets(f.options))
  const second = await fixture()
  const manifestPath = path.join(second.target, "manifest.json")
  fs.writeFileSync(manifestPath, JSON.stringify(second.manifest).replace('"variant":"production"', '"variant":"production","variant":"production"'))
  await assert.rejects(v.verifyOwnedGitAssets(second.options))
})

test("portable public root domains reject private mirror fallback", async () => {
  const r = require("./fixtures/windows_owned_git_retention.cjs")
  let reads = 0
  const fixtureBinding = { nonce: H, sourceRevision: "1".repeat(40), sourceTree: "2".repeat(40),
    allocationSha256: "e46fbabf1bc604b2531d3c3e573ea2110cbfb2282e3717ca72d68766ce6acee4",
    fixtureManifestSha256: P, Hns: "1000", controllerPid: 123 }
  const bootstrap = { schema: "desk.owned-git-real-retention/1", ...fixtureBinding,
    controllerRetired: true, unassignedRetired: true, jobSealed: true, activeProcesses: 0,
    queryOrigin: "real-win32", controlReaped: true, criticalHandlesClosed: true, complete: true }
  const model = r.createModelContext({ H: 1000n, binding: fixtureBinding, read: () => { reads++; return Buffer.from(JSON.stringify(bootstrap)) } })
  const observation = { origin: "fault-model", exitObserved: true, closeObserved: true,
    stdoutEOF: true, stdoutClosed: true, stderrEOF: true, stderrClosed: true,
    code: null, signal: "SIGTERM", closedAtNs: "900" }
  assert.throws(() => r.admitBootstrap(model, observation), { code: "model_origin" })
  assert.equal(reads, 0)
  const permit = r.modelBootstrapDecision(model, observation)
  assert.equal(reads, 1)
  assert.equal(permit.primaryFailurePreserved, true) // RET-S1, not native RET01 authority.
  assert.throws(() => r.collectPrivateRoles(model, permit, []), { code: "model_origin" })
  assert.throws(() => r.emitManifest(model, permit), { code: "model_origin" })
  for (const patch of [{ activeProcesses: 1 }, { nonce: Q }, { controllerPid: 124 },
    { Hns: "1001" }, { extra: true }]) assert.throws(() => r.validateBootstrap({ ...bootstrap, ...patch }, fixtureBinding))
  const before = reads
  const unjoined = r.createModelContext({ H: 1000n, binding: fixtureBinding, read: () => { reads++; return Buffer.alloc(0) } })
  assert.throws(() => r.modelBootstrapDecision(unjoined, { ...observation, stdoutEOF: false }))
  assert.equal(reads, before)
  assert.throws(() => r.modelBootstrapDecision(unjoined, observation)) // failed attempt is frozen.
  const late = r.createModelContext({ H: 1000n, deadlineNs: "800", binding: fixtureBinding,
    read: () => { reads++; return Buffer.from(JSON.stringify(bootstrap)) } })
  assert.throws(() => r.modelBootstrapDecision(late, observation))
  assert.equal(reads, before)
  const actualRoles = [{ role: "native-receipt", case: "O09-P20-R20", slot: 0, producer: "main",
    presence: "expected_absent", bytes: null, sha256: null, origin: "unobserved", gap: "none" }]
  assert.equal(r.projectObservedCounts([], [], [], actualRoles).receiptAbsent, 1)
  assert.equal(r.projectObservedCounts([], [], [], []).receiptAbsent, 0)
  assert.equal(r.projectObservedCounts([], [{ matched: false }], [], []).retentionControls, 1)
  assert.throws(() => r.validateBootstrap({ ...bootstrap, controllerPid: 0 }, { ...fixtureBinding, controllerPid: 0 }))
  const roleContext = r.createModelContext({ H: 1000n, binding: fixtureBinding,
    read: (key, operation) => {
      if (key === "unexpected-bootstrap-marker") { assert.equal(operation, "lookup"); return null }
      assert.equal(key, "bootstrap")
      return Buffer.from(JSON.stringify(bootstrap))
    } })
  const modelPermit = r.modelBootstrapDecision(roleContext, observation)
  const emptyCases = driver().getNativeCaseRegistry().map((plan) => ({ ...plan, actual: null, gap: "not_admitted" }))
  if (process.env.DESK_TEST_RUN_DIR) fs.writeFileSync(path.join(process.env.DESK_TEST_RUN_DIR, "na1-registry.json"),
    JSON.stringify(driver().getNativeCaseRegistry(), null, 2) + "\n", { flag: "wx" })
  const classified = r.modelCollectPrivateRoles(roleContext, modelPermit, { cases: emptyCases, utilities: [] })
  assert.equal(r.getPrivateRoleRegistry().length, 99)
  assert.equal(r.getPrivateRoleRegistry().filter((row) => row.role === "preload-marker").length, 12)
  assert.equal(classified.roles.filter((row) => row.role === "native-receipt").length, 75)
  assert.equal(classified.roles.filter((row) => row.role === "native-receipt" && row.presence === "withheld").length, 2)
  assert.equal(classified.roles.filter((row) => row.role === "native-receipt" && row.presence === "not_attempted").length, 73)
  assert.equal(r.modelAudit(roleContext).privateReads, 1)
  assert.throws(() => r.collectPrivateRoles(roleContext, modelPermit, driver().getNativeCaseRegistry()), { code: "model_origin" })
  const ownerJoins = { ...Object.fromEntries(["ownerExitObserved", "ownerCloseObserved", "stdoutEOF", "stdoutClosed",
    "stderrEOF", "stderrClosed", "controlEOF", "controlClosed"].map((k) => [k, true])), origin: "producer_reported" }
  const pending = { slot: 0, generation: H, preparationDigest: P, proposedPayloadDigest: Q, acceptedPayloadDigest: Q,
    recordIdShape: "independent-H-fixture", tokenShape: "T32-fixture", durableOperationRecord: false,
    phase: { clockReady: true, clockAccepted: true, ready: true, configured: true, parentSTARTSent: true,
      nativeSTARTIssued: true, resultReceived: false, controlComplete: false, sealSent: false, cancelSent: true },
    resultB64: null, result: null, certificate: null, certificateOrigin: "none", terminalFailure: "io", invocation: "HOLD",
    joins: ownerJoins, resources: { rootCreated: 1, assigned: 1, resumed: 1, rootLiveAfterResult: null,
      privateRootRetirement: "unproved", broaderRetirement: "unproved", modelStrandedRoot: 0,
      assignmentModeled: false, membershipModeled: false, queryModeled: false, rootWaitModeled: false,
      ioRouteInstrumented: false, pendingReads: null, pendingWrites: null, cancelRequests: null,
      reapedReads: null, reapedWrites: null, registryPeak: null, origin: "producer_reported" },
    data: { stdinExpectedBytes: 0, stdoutBytes: 0, stderrBytes: 0, combinedOverflow: false, dataComplete: true,
      controlBytesRead: 0, controlBytesWritten: 0, decoderPushes: 0, decoderProcessingNs: "0", resultAtNs: null,
      inputSettledAtNs: null, actualEOFAtNs: null, controlCompleteAtNs: null, sealAtNs: null, terminalAtNs: null,
      ownerCloseAtNs: "800", origin: "producer_reported" }, clockRow: null, deadlineNs: "1000",
    finishedNs: "800", bindingOrigin: "producer_reported" }
  const maxResult = { command: { state: "spawn_failed", code: "X".repeat(80) },
    input: input({ state: "unknown", expectedBytes: 524288, submittedBytes: 524288, errorCode: "Y".repeat(80) }) }
  const maxB64 = b64(maxResult)
  const maxCaseD = "18446744073709551615"
  const generation = { ...pending, deadlineNs: maxCaseD, finishedNs: "18446744073709551614",
    phase: { ...pending.phase, resultReceived: true },
    result: maxResult, resultB64: maxB64, certificate: certificate({ payloadDigest: Q, startIssued: true,
      commandState: "reported", resultB64: maxB64 }), certificateOrigin: "live-control", invocation: "failed-proved",
    resources: { ...pending.resources, pendingReads: 4294967295, pendingWrites: 4294967295,
      cancelRequests: 4294967295, reapedReads: 4294967295, reapedWrites: 4294967295, registryPeak: 64 },
    data: { ...pending.data, stdinExpectedBytes: 524288, stdoutBytes: 4194304, stderrBytes: 4194304,
      controlBytesRead: Number.MAX_SAFE_INTEGER, controlBytesWritten: Number.MAX_SAFE_INTEGER,
      decoderPushes: Number.MAX_SAFE_INTEGER, decoderProcessingNs: maxCaseD,
      ...Object.fromEntries(["resultAtNs","inputSettledAtNs","actualEOFAtNs","controlCompleteAtNs",
        "sealAtNs","terminalAtNs","ownerCloseAtNs"].map((key) => [key, "18446744073709551614"])) } }
  const generation2 = { ...generation, slot: 1, generation: Q,
    certificate: { ...generation.certificate, generation: Q } }
  const twoPlan = driver().getNativeCaseRegistry().find((p) => p.id === "A11-P24-R24")
  const twoCase = { ...twoPlan, actual: { matched: true, disposition: "failed-proved",
    generations: [generation,generation2], utilityId: null, sourceOrigin: "producer_reported",
    caseDeadlineNs: maxCaseD, finishedNs: "18446744073709551614" }, gap: "none" }
  const deathPlan=driver().getNativeCaseRegistry().find((p) => p.id==="A25-P24-R24")
  const predeath={...deathPlan,actual:{matched:false,disposition:"HOLD",generations:[{...pending,
    certificateOrigin:"withheld-owner-close",terminalFailure:null,
    joins:{...Object.fromEntries(Object.keys(ownerJoins).map((k) => [k,k==="origin"?"producer_reported":false]))},
    data:{...pending.data,dataComplete:false,ownerCloseAtNs:null}}],
    utilityId:null,sourceOrigin:"producer_reported",caseDeadlineNs:"1000",finishedNs:"800"},gap:"none"}
  const handoff={kind:"parent-death",generation:H,deadlineNs:"1000",observedAtNs:"800",
    workStarted:true,rootLiveActual:null,ownerExitObserved:false,ownerCloseObserved:false}
  assert.equal(driver().validateSpecialHandoff(handoff,predeath).kind,"parent-death")
  assert.throws(() => driver().validateSpecialHandoff({...handoff,workerDied:true},predeath))
  assert.throws(() => driver().validateSpecialHandoff({...handoff,workStarted:false},predeath))
  assert.throws(() => driver().validateSpecialHandoff(handoff,{...predeath,gap:"case_mismatch"}))
  const internalHandoff={schema:"desk.owned-git-case-worker/1",id:deathPlan.id,type:"HANDOFF",value:handoff}
  const handoffBytes=driver().encodeWorkerFrame(internalHandoff)
  assert.ok(handoffBytes.readUInt32LE(0)<=4096)
  assert.throws(() => driver().encodeWorkerFrame({...internalHandoff,value:{...handoff,workerDied:true}}))
  const physicalDeath={started:true,case:predeath,handoff,gap:"none",deathRequested:true,exitObserved:true,closeObserved:true,
    stdoutEOF:true,stdoutClosed:true,stderrEOF:true,stderrClosed:true,controlEOF:true,controlClosed:true,
    code:null,signal:"SIGTERM",closedAtNs:"900"}
  const dead=driver().deriveParentDeathCase(physicalDeath)
  assert.equal(dead.actual.matched,true)
  assert.equal(dead.actual.generations[0].joins.ownerExitObserved,false)
  assert.equal(dead.actual.generations[0].certificate,null)
  assert.equal(dead.actual.finishedNs,"900")
  assert.throws(() => driver().deriveParentDeathCase({...physicalDeath,exitObserved:false}))
  const quarantinePlan=driver().getNativeCaseRegistry().find((p) => p.id==="C15-P24-R24")
  const quarantinedCase={...quarantinePlan,actual:{...predeath.actual,matched:true,generations:[{
    ...predeath.actual.generations[0],certificateOrigin:"withheld-model",
    joins:{...predeath.actual.generations[0].joins,ownerExitObserved:true},
    resources:{...pending.resources,modelStrandedRoot:1,assignmentModeled:true,membershipModeled:true,
      queryModeled:true,rootWaitModeled:true}}]},gap:"none"}
  const quarantinedRecord={started:true,quarantined:true,id:quarantinePlan.id,case:quarantinedCase,
    handoff:{...handoff,kind:"quarantine",ownerExitObserved:true,rootLiveActual:true},
    exitObserved:false,closeObserved:false,gap:"none",clock:[],deadlineNs:"1000",workCutoffNs:"10000000000"}
  assert.deepEqual(driver().deriveQuarantineFacts([quarantinedRecord]),
    {caseWorkers:1,modelRoots:1,authority:"retained-real-broader-job"})
  assert.throws(() => driver().deriveQuarantineFacts([{...quarantinedRecord,closeObserved:true}]))
  const quarantineFold=driver().assembleUtilityWorkerFacts([quarantinedRecord])
  assert.equal(quarantineFold.cases.find((c) => c.id===quarantinePlan.id).actual.matched,true)
  const quarantineGap=driver().assembleUtilityWorkerFacts([{...quarantinedRecord,gap:"quota"}])
  assert.equal(quarantineGap.cases.find((c) => c.id===quarantinePlan.id).actual.matched,false)
  const unrefs=[]
  const unrefRecord={...quarantinedRecord,reportClosed:true,deadlineTimer:{unref:() => unrefs.push("timer")},
    child:{stdout:{unref:() => unrefs.push("stdout")},stderr:{unref:() => unrefs.push("stderr")},
      stdio:[null,null,null,{unref:() => unrefs.push("control")}],unref:() => unrefs.push("child")}}
  assert.throws(() => driver().unrefQuarantinedWorker({...unrefRecord,reportClosed:false}))
  assert.deepEqual(unrefs,[])
  driver().unrefQuarantinedWorker(unrefRecord)
  assert.deepEqual(unrefs.sort(),["child","control","stderr","stdout","timer"])
  assert.equal(unrefRecord.closeObserved,false)
  const matchedNegatives={cases:driver().getNativeCaseRegistry().map((p) => ({...p,
    actual:{matched:true,disposition:"HOLD"},gap:"none"})),
    utilities:Array.from({length:6},() => ({gap:"none"}))}
  assert.equal(driver().aggregateControllerGap(matchedNegatives),"none")
  assert.equal(driver().aggregateControllerGap({...matchedNegatives,cases:matchedNegatives.cases.map((c,i) =>
    i?c:{...c,gap:"quota"})}),"quota")
  assert.equal(driver().aggregateControllerGap({...matchedNegatives,utilities:[{gap:"clock_mismatch"},
    ...matchedNegatives.utilities.slice(1)]}),"clock_mismatch")
  assert.equal(driver().aggregateControllerGap({...matchedNegatives,cases:matchedNegatives.cases.map((c,i) =>
    i?c:{...c,actual:null,gap:"not_admitted"})}),"not_admitted")
  const primaryInput={id:"C04-P24-R24",primary:"protocol",primaryOrigin:"observed",primaryAtNs:"999",
    deadlineNs:"1000",cleanupOnly:true,zeroCreation:false,controlLost:false}
  assert.equal(driver().primaryFailureExpected(primaryInput),false)
  assert.equal(driver().primaryFailureExpected({...primaryInput,primaryAtNs:"1000"}),true)
  assert.equal(driver().primaryFailureExpected({...primaryInput,id:"C06-P24-R24",primary:"io",
    controlLost:true,primaryOrigin:"intentional-control-loss"}),true)
  assert.equal(driver().primaryFailureExpected({...primaryInput,id:"C06-P24-R24",primary:"io",controlLost:true}),false)
  assert.equal(driver().primaryFailureExpected({...primaryInput,id:"C14-P24-R24",primaryAtNs:"1000"}),false)
  assert.equal(driver().caseDisposition([],1),"HOLD")
  assert.equal(driver().caseDisposition([{invocation:"success"}],2),"HOLD")
  assert.equal(driver().caseDisposition([{invocation:"success"}],1),"success")
  assert.equal(driver().caseDisposition([{invocation:"failed-proved"}],1),"failed-proved")
  const deferredSeed={id:"C19-P24-Rnone",processes:2,fullcloseObserved:2,checksExpected:4,
    checksPassed:0,denominator:null,gap:"denominator_missing"}
  const deferredFacts={...matchedNegatives,utilities:[...matchedNegatives.utilities.slice(0,5),deferredSeed],
    cases:matchedNegatives.cases.map((c) => c.id===deferredSeed.id ?
      {...c,actual:{matched:true,disposition:"utility-only",utilityId:c.id,generations:[]}}:c)}
  assert.equal(driver().aggregateControllerGap(deferredFacts),"none")
  assert.notEqual(driver().aggregateControllerGap({...deferredFacts,utilities:[
    ...matchedNegatives.utilities.slice(0,5),{...deferredSeed,fullcloseObserved:1}]}),"none")
  const pendingControls=[],startedControls=[]
  const group=r.runRetentionControlGroup((id) => {
    startedControls.push(id)
    return new Promise((resolve) => pendingControls.push(() => resolve(id)))
  })
  assert.deepEqual(startedControls,["RET01","RET02","RET03","RET04","RET05","RET06","RET07"])
  for (const resolve of pendingControls.reverse()) resolve()
  assert.deepEqual(await group,startedControls)
  const controlReadsA={},controlReadsB={}
  r.recordPrivateReadDelta(controlReadsA,4,5)
  r.recordPrivateReadDelta(controlReadsB,5,7)
  r.recordPrivateReadDelta(controlReadsA,7,7)
  assert.equal(controlReadsA.privateReadFiles,1)
  assert.equal(controlReadsB.privateReadFiles,2)
  assert.throws(() => r.recordPrivateReadDelta(controlReadsA,9,8))
  const filterPlan=driver().getNativeCaseRegistry().find((p) => p.id==="A22-P24-R24")
  const filterResult=result(),filterB64=b64(filterResult)
  const filterGeneration={...pending,invocation:"success",terminalFailure:"none",result:filterResult,resultB64:filterB64,
    phase:{...pending.phase,resultReceived:true,controlComplete:true,sealSent:true,cancelSent:false},
    certificate:certificate({payloadDigest:Q,startIssued:true,commandState:"reported",resultB64:filterB64}),
    certificateOrigin:"live-control",data:{...pending.data,resultAtNs:"700",controlCompleteAtNs:"710",
      sealAtNs:"720",terminalAtNs:"730",ownerCloseAtNs:"740"}}
  assert.equal(driver().matchClassACase(filterPlan,[filterGeneration],{}),true)
  assert.equal(driver().matchClassACase(filterPlan,[{...filterGeneration,data:{...filterGeneration.data,
    controlCompleteAtNs:"1000"}}],{}),false)
  assert.equal(driver().utilityFooterComplete("clock-samples",{telemetryGap:false,creationCalls:0,
    ownerFreed:true,requests:73}),true)
  assert.equal(driver().utilityFooterComplete("clock-samples",{telemetryGap:false,creationCalls:0,
    ownerFreed:false,requests:73}),false)
  let resumedBlockedPeer=false,blockedCallback=null
  const blockedPeer=driver().runBadParentPeer({stream:{pause(){},resume(){resumedBlockedPeer=true},
    write(_bytes,callback){blockedCallback=callback}},deadline:{clock:"win-qpc-ns/1",
      expiresNs:process.hrtime.bigint()+10000000n}})
  const boundedPeer=await Promise.race([blockedPeer,new Promise((resolve) => setTimeout(() => resolve(null),80))])
  assert.notEqual(boundedPeer,null)
  assert.equal(boundedPeer.writeFailed,true)
  assert.equal(resumedBlockedPeer,true)
  blockedCallback(new Error("late-error"))
  const mainCompletion={...Object.fromEntries(["exitObserved","closeObserved","stdoutEOF","stdoutClosed","stderrEOF","stderrClosed"]
    .map((k) => [k,true])),code:0,signal:null,closedAtNs:"800",deadlineNs:"1000"}
  assert.equal(r.mainProducerGap(mainCompletion),"none")
  assert.equal(r.mainProducerGap({...mainCompletion,code:1}),"case_mismatch")
  assert.equal(r.mainProducerGap({...mainCompletion,signal:"SIGTERM"}),"signal_failure")
  assert.equal(r.mainProducerGap({...mainCompletion,closeObserved:false}),"producer_unjoined")
  const sections = [generation,generation2].flatMap((g) => driver().encodeGenerationFrames(twoPlan.id,g))
  const summary = driver().encodeCaseSummary(twoCase)
  const frameBytes = [...sections,summary].map((f) => driver().encodeWorkerFrame(f))
  assert.throws(() => driver().encodeWorkerFrame({ schema: "desk.owned-git-case-worker/1",
    id: twoPlan.id, type: "ERROR", value: "none" }))
  assert.equal(Math.max(...frameBytes.map((b) => b.length - 4)) <= 4096, true)
  fs.writeFileSync(path.join(process.env.DESK_TEST_RUN_DIR, "na1-generation-frame-measurements.json"),
    JSON.stringify(frameBytes.map((b, i) => ({ type: [...sections,summary][i].type, bodyBytes: b.length - 4 }))))
  for (const chunks of [[Buffer.concat(frameBytes)], [...Buffer.concat(frameBytes)].map((v) => Buffer.from([v]))]) {
    const assembly = driver().createGenerationAssembly({ id: twoPlan.id, deadlineNs: maxCaseD,
      budget: driver().createGenerationStagingBudget() })
    const decode = require("./fixtures/windows_owned_git_fault_root.cjs").createFixtureControlDecoder({
      core: core(), onFrame: (v) => assembly.accept(v) })
    for (const chunk of chunks) decode.push(chunk)
    decode.end()
    assert.deepEqual(assembly.end(), twoCase)
  }
  for (const badSections of [
    [sections[1]], [sections[0],sections[0]], [...sections.slice(0,-1),summary],
    sections.map((f, i) => i === 2 ? { ...f, value: { ...f.value, slot: 1 } } : f),
    [{ ...sections[0], id: "A12-P24-R24" }], [summary],
  ]) {
    const bad = driver().createGenerationAssembly({ id: twoPlan.id, deadlineNs: maxCaseD,
      budget: driver().createGenerationStagingBudget() })
    assert.throws(() => { badSections.forEach((f) => bad.accept(f)); bad.end() })
  }
  const staging = driver().createGenerationStagingBudget()
  let ordinal = 0
  for (const p of driver().getNativeCaseRegistry()) for (let slot = 0; slot < p.expected.generations; slot++)
    staging.reserve(p.id, slot, (++ordinal).toString(16).padStart(64, "0"))
  assert.equal(staging.snapshot().generationRecords, 75)
  staging.add(1048576); assert.throws(() => staging.add(1))
  assert.throws(() => staging.reserve(twoPlan.id, 0, H))
  const git7Result = { command: { state: "exited", code: 7, signal: null }, input: input() }
  const git7 = { ...pending, phase: { ...pending.phase, resultReceived: true, controlComplete: true,
    sealSent: true, cancelSent: false }, result: git7Result, resultB64: b64(git7Result),
    certificate: certificate({ payloadDigest: Q, startIssued: true, commandState: "reported", resultB64: b64(git7Result) }),
    certificateOrigin: "live-control", invocation: "failed-proved", terminalFailure: "none" }
  const git7Plan = driver().getNativeCaseRegistry().find((p) => p.id === "A12-P24-R24")
  assert.equal(driver().matchClassACase(git7Plan, [git7], {}), true)
  assert.equal(driver().matchClassACase(git7Plan, [{ ...git7, data: { ...git7.data, dataComplete: false } }], {}), false)
  assert.equal(driver().matchClassACase(git7Plan, [{ ...git7, result: result() }], {}), false)
  const fixturePlan = driver().getNativeCaseRegistry().find((p) => p.id === "B02-P24-R24")
  const genuine = b64(result()), faultResult = { ...git7, phase: { ...git7.phase, controlComplete: false, sealSent: false },
    result: result(), resultB64: genuine, terminalFailure: "protocol",
    certificate: certificate({ payloadDigest: Q, startIssued: true, commandState: "reported", resultB64: genuine }) }
  const copies = { originalResultB64: genuine, terminalResultB64: genuine, released: true }
  assert.equal(driver().matchFixtureCase(fixturePlan, faultResult, copies), true)
  assert.equal(driver().matchFixtureCase(fixturePlan, faultResult, { ...copies, released: false }), false)
  assert.equal(driver().matchFixtureCase(fixturePlan, faultResult, { ...copies, originalResultB64: b64(git7Result) }), false)
  assert.equal(driver().matchFixtureCase(fixturePlan, { ...faultResult, phase: { ...faultResult.phase, controlComplete: true } }, copies), false)
  const neverStarted = { ...pending, proposedPayloadDigest: null, acceptedPayloadDigest: null,
    phase: { ...pending.phase, ready: false, configured: false, parentSTARTSent: false, nativeSTARTIssued: false, cancelSent: false },
    certificate: certificate(), certificateOrigin: "live-control", terminalFailure: "protocol", invocation: "failed-proved" }
  for (const p of driver().getNativeCaseRegistry().filter((p) => p.evidenceClass === "B")) {
    const index = Number(p.id.slice(1,3))
    const modeled = index >= 2 && index <= 7 ? faultResult : index === 8 ? {
      ...neverStarted, phase: { ...neverStarted.phase, ready: true, configured: true, parentSTARTSent: true, nativeSTARTIssued: true },
      proposedPayloadDigest: Q, acceptedPayloadDigest: Q, certificate: certificate({ payloadDigest: Q,
        startIssued: true, commandState: "unknown" }) } : index === 10 ?
          { ...neverStarted, phase: { ...neverStarted.phase, ready: true } } : neverStarted
    const observed = index === 1 ? { peer: { rootLive: true, connected: true, closed: true, receivedBytes: 0 } } :
      index >= 2 && index <= 7 ? copies : index === 9 ? { pressure: { kernelCredit: false, submittedBytes: 16384,
        bufferedBytes: 16384, needDrain: true } } : { badPeer: { submittedBytes: 65536, paused: true, resumed: true } }
    assert.equal(driver().matchFixtureCase(p, modeled, observed), true, p.id)
    assert.equal(driver().matchFixtureCase(p, { ...modeled, terminalFailure: "none" }, observed), false, p.id)
  }
  for (const prefix of ["C03","C04","C05","C06","C07"]) {
    const p=driver().getNativeCaseRegistry().find((row) => row.id===`${prefix}-P24-R24`)
    const state=nativeState({mode:prefix,phase:"TEARDOWN",created:prefix!=="C03",
      assigned:prefix!=="C03",resumed:!["C03","C04"].includes(prefix),startIssued:prefix==="C07",
      assignmentModeled:false,rootRetiredReported:false,privateZeroReported:false,
      ioRouteInstrumented:prefix==="C07",cancelWriteRequested:prefix==="C07",pendingWrite:prefix==="C07"})
    const phases=prefix==="C04"?["ASSIGNED_SUSPENDED"]:prefix==="C05"?["BEFORE_NATIVE_START"]:
      prefix==="C06"?["OBSERVER_PENDING"]:[]
    const native={state,phases,entry:{creationCalls:prefix==="C03"?0:1,ownerFreed:prefix==="C03",
      expiredBeforeEntry:prefix==="C03"},footer:{requests:0},zeroCreation:prefix==="C03",cleanupOnly:true}
    const model={...pending,finishedNs:"1200",terminalFailure:null,
      phase:{...pending.phase,clockReady:prefix!=="C03",parentSTARTSent:["C05","C07"].includes(prefix),
        nativeSTARTIssued:prefix==="C07"},resources:{...pending.resources,rootCreated:prefix==="C03"?0:1,
          assigned:prefix==="C03"?0:1,resumed:state.resumed?1:0,ioRouteInstrumented:prefix==="C07"},
      data:{...pending.data,ownerCloseAtNs:"1200"}}
    const observed={native,controlRequests:0,controlLost:prefix==="C06",decision:{barrier:prefix==="C06"}}
    assert.equal(driver().matchFixtureCase(p,model,observed),true,prefix)
    assert.equal(driver().matchFixtureCase(p,{...model,invocation:"success"},observed),false,prefix)
    assert.equal(driver().matchFixtureCase(p,model,{...observed,native:{...native,cleanupOnly:false}}),false,prefix)
    if (prefix==="C07") assert.equal(driver().matchFixtureCase(p,model,
      {...observed,native:{...native,state:{...state,ioRouteInstrumented:false}}}),false)
    if (prefix==="C07") assert.equal(driver().matchFixtureCase(p,model,
      {...observed,native:{...native,state:{...state,pendingWrite:false,writeReaped:false}}}),false)
    const record={...p,actual:{matched:true,disposition:"HOLD",generations:[model],utilityId:null,
      sourceOrigin:"producer_reported",caseDeadlineNs:"1000",finishedNs:"1200"},gap:"none"}
    assert.equal(driver().assembleUtilityWorkerFacts([{id:p.id,started:true,done:true,code:0,signal:null,
      ...Object.fromEntries(["exitObserved","closeObserved","stdoutEOF","stdoutClosed","stderrEOF","stderrClosed","controlEOF","controlClosed"]
        .map((k) => [k,true])),gap:"none",clock:[],case:record,deadlineNs:"1000",workCutoffNs:"10000000000"}])
      .cases.find((c) => c.id===p.id).actual.matched,true,prefix)
  }
  const serverPlan=driver().getNativeCaseRegistry().find((p) => p.id==="C14-P24-R24")
  const serverGeneration={...neverStarted,terminalFailure:"io"}
  const serverFacts={controlRequests:1,native:{state:nativeState({mode:"C14",assigned:true,resumed:true,
    assignmentModeled:false}),entry:{creationCalls:1},footer:{requests:1},phases:["SERVER_CLOSED"]},
    decision:{barrier:true,continued:true,replacement:true},replacementUnexpectedClient:false}
  assert.equal(driver().matchFixtureCase(serverPlan,serverGeneration,serverFacts),true)
  assert.equal(driver().matchFixtureCase(serverPlan,serverGeneration,{...serverFacts,replacementUnexpectedClient:true}),false)
  assert.equal(driver().matchFixtureCase(serverPlan,serverGeneration,{...serverFacts,
    decision:{...serverFacts.decision,continued:false}}),false)
  const sourceModes = [
    ["O02", false, false, true, false, false, false], ["O03", true, false, false, true, false, false],
    ["O05", true, true, false, false, true, false], ["O06", true, false, false, true, false, false],
    ["O07", false, false, true, false, false, false],
    ...["C09","C10","C11","C12","C13"].map((id) => [id,true,true,false,false,false,true]),
    ...["C16","C17","C18"].map((id) => [id,false,false,false,false,false,false]),
  ]
  for (const p of driver().getNativeCaseRegistry().filter((p) => p.evidenceClass === "C" && p.expected.generations &&
    sourceModes.some((row) => row[0] === p.id.split("-")[0]))) {
    const [prefix, assigned, resumed, assignmentModeled, resumeModeled, queryModeled, authMutated] =
      sourceModes.find((row) => row[0] === p.id.split("-")[0])
    const clock = ["C16","C17","C18"].includes(prefix), query = prefix === "O05", barrier = ["O02","O03"].includes(prefix)
    const event = nativeState({ mode: prefix, created: !clock, assigned, resumed, assignmentModeled, resumeModeled,
      queryModeled, authMutated, clockModeled: clock && prefix !== "C17", startIssued: query,
      rootRetiredReported: !clock, privateZeroReported: !clock && !query })
    const observed = driver().createFixtureCaseEvidence({ id: p.id, deadlineNs: "1000" })
    if (prefix !== "C17") observed.observe(event)
    observed.observe({ schema: "desk.owned-git-fixture-event/1", type: "ENTRY_RESULT", creationCalls: clock ? 0 : 1,
      ownerFreed: true, expiredBeforeEntry: false, deadlineInputModeled: prefix === "C17",
      clockModeled: clock && prefix !== "C17", deadlineNs: "1000" })
    observed.observe({ schema: "desk.owned-git-fixture-event/1", type: "CLOSED", requests: barrier ? 1 : 0,
      creationCalls: clock ? 0 : 1, ownerFreed: true, telemetryGap: false, deadlineNs: "1000" })
    const complete = observed.complete({ ownerFullclose: true, controlEOF: true, controlClosed: true, withinDeadline: true })
    const model = query ? { ...faultResult, certificate: null, certificateOrigin: "none", invocation: "HOLD",
      terminalFailure: "retirement", phase: { ...faultResult.phase, controlComplete: true, sealSent: true },
      resources: { ...faultResult.resources, queryModeled: true },
      data: { ...faultResult.data, resultAtNs: "700", controlCompleteAtNs: "710", sealAtNs: "720" } } :
      { ...neverStarted, certificate: clock ? null : neverStarted.certificate, certificateOrigin: clock ? "none" : "live-control",
        invocation: clock ? "HOLD" : "failed-proved", terminalFailure: clock ? null : authMutated ? "protocol" : "prepare",
        phase: { ...neverStarted.phase, cancelSent: barrier }, resources: { ...neverStarted.resources, rootCreated: clock ? 0 : 1 } }
    const facts = { native: complete, controlRequests: barrier ? 1 : 0, decision: { barrier, continued: barrier } }
    assert.equal(driver().matchFixtureCase(p, model, facts), true, p.id)
    assert.equal(driver().matchFixtureCase(p, model, { ...facts, native: null }), false, p.id)
    if (prefix === "O05") {
      const cleaned = { ...model, finishedNs: "1100", terminalFailure: null }
      assert.equal(driver().matchFixtureCase(p, cleaned,
        { ...facts, native: { ...complete, cleanupOnly: true } }), true)
      const lateCase = { ...p, actual: { matched: true, disposition: "HOLD", generations: [cleaned], utilityId: null,
        sourceOrigin: "producer_reported", caseDeadlineNs: "1000", finishedNs: "1200" }, gap: "none" }
      const folded = driver().assembleUtilityWorkerFacts([{ id: p.id, started: true, done: true, code: 0, signal: null,
        deadlineNs: "1000", workCutoffNs: "3000", case: lateCase, clock: [], utility: null, gap: "none",
        exitObserved: true, closeObserved: true, stdoutEOF: true, stdoutClosed: true, stderrEOF: true,
        stderrClosed: true, controlEOF: true, controlClosed: true }]).cases.find((v) => v.id === p.id)
      assert.equal(folded.actual.matched, true)
      assert.equal(folded.actual.generations[0].invocation, "HOLD")
    }
  }
  const expiryPlan = driver().getNativeCaseRegistry().find((p) => p.id === "A18-P24-R24")
  const expiredGeneration = { ...pending, phase: { ...pending.phase, parentSTARTSent: false,
    nativeSTARTIssued: false }, data: { ...pending.data, ownerCloseAtNs: "1100" }, finishedNs: "1100" }
  const expiryRecord = { ...expiryPlan, actual: { matched: true, disposition: "HOLD",
    generations: [expiredGeneration], utilityId: null, sourceOrigin: "producer_reported",
    caseDeadlineNs: "1000", finishedNs: "1100" }, gap: "none" }
  const expiredObserved = driver().assembleUtilityWorkerFacts([{ id: expiryPlan.id, started: true, done: true,
    deadlineNs: "1000", workCutoffNs: "2000", clock: [], utility: null, case: expiryRecord,
    exitObserved: true, closeObserved: true, stdoutEOF: true, stdoutClosed: true, stderrEOF: true,
    stderrClosed: true, controlEOF: true, controlClosed: true, code: 0, signal: null, gap: "none" }])
  assert.equal(expiredObserved.cases.find((v) => v.id === expiryPlan.id).actual.matched, true)
  assert.equal(expiredObserved.cases.find((v) => v.id === expiryPlan.id).actual.generations[0].invocation, "HOLD")
  const receiptKey = "receipt:O08-P20-R20:0", contentKeys = []
  const unknownCert = certificate({ payloadDigest: Q, startIssued: true, commandState: "unknown" })
  const receiptContext = r.createModelContext({ H: 1000n, binding: fixtureBinding, read(key, operation) {
    if (operation === "lookup") return null
    if (key === "bootstrap") return Buffer.from(JSON.stringify(bootstrap))
    contentKeys.push(key); assert.equal(key, receiptKey)
    return Buffer.from(JSON.stringify(unknownCert))
  } })
  const receiptPermit = r.modelBootstrapDecision(receiptContext, observation)
  const oneCase = (g) => emptyCases.map((row) => row.id !== "O08-P20-R20" ? row : { ...row,
    actual: { matched: true, disposition: "HOLD", generations: [g], utilityId: null, sourceOrigin: "producer_reported",
      caseDeadlineNs: "1000", finishedNs: "800" }, gap: "none" })
  const pendingCases = oneCase(pending), beforeFold = JSON.stringify(pendingCases)
  const privateRoles = r.modelCollectPrivateRoles(receiptContext, receiptPermit, { cases: pendingCases, utilities: [] })
  const folded = r.foldReceiptFacts(pendingCases, privateRoles.receipts, true).find((row) => row.id === "O08-P20-R20")
  assert.equal(folded.actual.generations[0].certificateOrigin, "receipt-after-gate")
  assert.equal(folded.actual.generations[0].invocation, "failed-proved")
  assert.equal(folded.actual.generations[0].resources.broaderRetirement, "real-sealed-zero")
  assert.equal(folded.actual.matched, true)
  assert.equal(JSON.stringify(pendingCases), beforeFold)
  const liveButUnjoined = { ...pending, certificate: unknownCert, certificateOrigin: "live-control",
    joins: { ...ownerJoins, stderrClosed: false } }
  const unjoinedCounts = r.projectObservedCounts(oneCase(liveButUnjoined), [], [])
  assert.equal(unjoinedCounts.eligibleNativeCertificates, 0)
  assert.equal(unjoinedCounts.ownerFullClose, 0)
  assert.equal(unjoinedCounts.ownerFullCloseMissing, 1)
  contentKeys.length = 0
  const unjoinedReceipt = { ...pending, joins: { ...ownerJoins, controlClosed: false } }
  const quarantined = r.modelCollectPrivateRoles(receiptContext, receiptPermit, { cases: oneCase(unjoinedReceipt), utilities: [] })
  assert.deepEqual(contentKeys, [])
  assert.equal(quarantined.roles.find((row) => row.case === "O08-P20-R20").gap, "owner_join_missing")
  assert.equal(r.foldReceiptFacts(oneCase(unjoinedReceipt), quarantined.receipts, true)
    .find((row) => row.id === "O08-P20-R20").actual.generations[0].certificate, null)
  assert.throws(() => r.foldReceiptFacts(pendingCases,
    [{ case: "O08-P20-R20", slot: 0, value: { ...unknownCert, generation: Q } }], true))
  const created = { schema: "desk.owned-git-supervisor-event/1", type: "CONTROLLER_CREATED", nonce: H,
    controllerPid: 123, assigned: true }
  const typedFrame = (value) => { const bytes = Buffer.from(JSON.stringify(value)), frame = Buffer.alloc(bytes.length + 4)
    frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4); return frame }
  const events = [], eventReader = r.createSupervisorEventReader({ nonce: H, producer: "main", onEvent: (e) => events.push(e) })
  eventReader.configSent()
  for (const byte of typedFrame(created)) eventReader.push(Buffer.from([byte]))
  eventReader.end()
  assert.equal(eventReader.snapshot().controllerPid, 123)
  assert.deepEqual(events, [created])
  const driftReader = r.createSupervisorEventReader({ nonce: H, producer: "RET07" })
  driftReader.configSent(); driftReader.push(typedFrame(created))
  driftReader.push(typedFrame({ schema: created.schema, type: "TARGET_IDENTITY", nonce: H,
    volume: 3, indexHigh: 1, indexLow: 2, bytes: 17, replacementDistinct: true }))
  driftReader.end()
  assert.deepEqual(driftReader.snapshot().targetIdentity,
    { dev: 3n, ino: 4294967298n, size: 17, type: "file", reparse: false })
  for (const patch of [{ controllerPid: 0 }, { nonce: P }, { extra: true }]) {
    const bad = r.createSupervisorEventReader({ nonce: H, producer: "main" })
    bad.configSent(); assert.throws(() => bad.push(typedFrame({ ...created, ...patch })))
  }
  const duplicate = r.createSupervisorEventReader({ nonce: H, producer: "main" })
  duplicate.configSent(); duplicate.push(typedFrame(created))
  assert.throws(() => duplicate.push(typedFrame(created)))
  const tracker = r.createProducerTracker({ id: "main", origin: "real-supervisor", imageSha256: H,
    observedPid: 12, deadlineNs: "1000" })
  tracker.spawned(12)
  tracker.exit(null, "SIGTERM")
  tracker.end("stdout"); tracker.close("stdout")
  tracker.end("stderr")
  assert.equal(tracker.snapshot().eligible, false)
  tracker.close("stderr"); tracker.processClose("900")
  const sourceLikePayload = tracker.snapshot()
  assert.equal(sourceLikePayload.eligible, true)
  assert.equal(sourceLikePayload.code, null)
  assert.equal(sourceLikePayload.signal, "SIGTERM")
  assert.throws(() => r.admitBootstrap(roleContext, sourceLikePayload), { code: "model_origin" })
  const identity = { dev: 1, ino: 2, size: 2, type: "file", reparse: false }
  let contentReads = 0
  assert.throws(() => r.guardedRoleRead({ before: () => ({ ...identity, reparse: true }),
    after: () => identity, read: () => { contentReads++; return Buffer.from("{}") } }, 10))
  assert.equal(contentReads, 0)
  assert.throws(() => r.guardedRoleRead({ before: () => identity,
    after: () => ({ ...identity, ino: 3 }), read: () => { contentReads++; return Buffer.from("{}") } }, 10))
  assert.equal(contentReads, 1)
  assert.throws(() => r.guardedRoleRead({ expected: identity, before: () => ({ ...identity, ino: 4 }),
    after: () => identity, read: () => { contentReads++; return Buffer.from("{}") } }, 10))
  assert.equal(contentReads, 1) // Known identity drift must refuse before opening content.
  const f = await fixture()
  assert.equal((await f.v.resolveOwnedGitTarget(f.options)).targetDir, f.target)
  await assert.rejects(f.v.resolveOwnedGitTarget({ publicMcpRoot: f.realm, privateRealmRoot: f.realm }))
  await assert.rejects(f.v.verifyOwnedGitAssets({ ...f.options, publicMcpRoot: f.target }))
  fs.symlinkSync(f.realm, path.join(f.root, "mirror"), "dir")
  await assert.rejects(f.v.resolveOwnedGitTarget({ publicMcpRoot: path.join(f.root, "mirror"), privateRealmRoot: f.realm }))
})

test("portable output Infinity remains parent only", () => {
  const c = core()
  assert.equal(c.normalizeOutputLimit(), Infinity)
  assert.equal(c.normalizeOutputLimit(Infinity), Infinity)
  for (const value of [-1, NaN, null, 1.5]) assert.throws(() => c.normalizeOutputLimit(value))
  assert.equal(c.normalizeOutputLimit(0), 0)
  assert.throws(() => c.encodePayload(payload({ outputLimit: Infinity })))
  assert.equal("outputLimit" in JSON.parse(c.encodePayload(payload()).bytes), false)
  assert.equal(driver().createDriverPolicy({ outputLimit: Infinity }).outputLimit, Infinity)
})

test("portable native state and proof validation MODEL", () => {
  const c = core()
  const retention = require("./fixtures/windows_owned_git_retention.cjs"), samples = []
  const clockUtilities = ["20", "22", "24"].map((role) => {
    const id = `C02-P${role}-R${role}`, clockRows = []
    for (const [origin, count] of [["parent-companion", 64], ["root-companion", 64], ["fixed-vector", 8]]) {
      for (let i = 0; i < count; i++) {
        clockRows.push(samples.length)
        const modeled = origin === "fixed-vector"
        samples.push({ case: id, generationSlot: null, role, origin, index: i, q: "10", f: "1000000000",
          converted: modeled ? null : "10", edge: null, beforeNs: modeled ? null : "9",
          afterNs: modeled ? null : "11", deadlineNs: "1000", accepted: !modeled, modeled })
      }
    }
    return { id, processes: 2, fullcloseObserved: 2, companionFullcloseObserved: true, checksExpected: 136,
      checksPassed: 136, kernelCredit: false, resultVectorBits: null, io: null, clockRows, denominator: null, gap: "none" }
  })
  assert.equal(retention.clockObservationComplete([], retention.projectClock({ samples, gaps: [] }).samples, clockUtilities), true)
  assert.equal(retention.clockObservationComplete([], samples.map((row) => row.case === "C02-P20-R20"
    ? { ...row, role: "24" } : row), clockUtilities), false)
  assert.equal(c.validateCertificate(certificate(), binding).commandState, "not_started")
  assert.equal(c.validateCertificate(certificate({ payloadDigest: Q, startIssued: true, commandState: "unknown" }),
    { ...binding, payloadDigest: Q }).commandState, "unknown")
  for (const patch of [{ exactJobZero: false }, { rootRetired: false }, { sealed: false }, { startIssued: true },
    { generation: Q }, { exactJobZero: undefined }]) assert.throws(() => c.validateCertificate(certificate(patch), binding))
  const d = driver(), deadline = { clock: "win-qpc-ns/1", expiresNs: 2000000000n }
  const ready = frame("owner", "CLOCK_READY", { clock: deadline.clock, deadlineNs: "2000000000",
    qpcTicks: "10000000", qpcFrequency: "10000000", nowNs: "1000000000" })
  assert.equal(d.validateClockReady(ready, deadline, 999999900n, 1000000100n), true)
  assert.throws(() => d.validateClockReady({ ...ready, nowNs: "1" }, deadline, 999999900n, 1000000100n))
  assert.throws(() => d.validateClockReady(ready, deadline, 2000000000n, 2000000001n))
  assert.equal(c.remainingNanoseconds(deadline, 3000000000n), 0n)
  const pressured = new EventEmitter(); pressured.write = () => {}
  const expiredWire = d.createWire({ stream: pressured, binding, deadline: { clock: deadline.clock, expiresNs: 0n } })
  assert.throws(() => expiredWire.send(frame("parent", "CANCEL")))
  const wrongClock = componentSession()
  wrongClock.clockReady()
  assert.throws(() => wrongClock.wire.send(frame("parent", "CLOCK_ACCEPT", { clock: "win-qpc-ns/1", deadlineNs: "1" })))
  wrongClock.ready()
  assert.deepEqual(wrongClock.errors, ["component_protocol"])
  assert.deepEqual(wrongClock.frames.map((value) => value.type), ["CLOCK_READY"])
})

test("portable raw component driver uses product wire without adapter", async () => {
  const io = await import("../../../../../.github/scripts/owned-git-product-io.mjs")
  const b2 = driver().getNativeCaseRegistry().filter((p) => driver().generationCaseAvailable(p.id) &&
    p.evidenceClass !== "A" && p.expected.generations && !["C03","C04","C05","C06","C07","C14","C15"].includes(p.id.split("-")[0]))
  assert.equal(b2.length, 33)
  assert.equal(driver().generationCaseAvailable("C15-P24-R24"), true)
  assert.equal(driver().getNativeCaseRegistry().filter((p) => p.expected.generations &&
    driver().generationCaseAvailable(p.id)).length, 74)
  const liveLedger = driver().createNativeWorkerLedger({ H: 120000000000n })
  liveLedger.admit("C15-P24-R24", 1n)
  liveLedger.quarantine("C15-P24-R24")
  const otherIds = driver().getNativeCaseRegistry().filter((p) => p.id !== "C15-P24-R24").slice(0,12).map((p) => p.id)
  for (const id of otherIds.slice(0,11)) liveLedger.admit(id, 1n)
  assert.equal(liveLedger.snapshot().activeReservations, 12)
  assert.throws(() => liveLedger.admit(otherIds[11], 1n))
  const withheld = driver().createObservations({ ...binding }, 0, { withholdCertificate: true })
  withheld.owner(frame("owner", "TERMINAL", { certificate: certificate(), resultB64: null, failureCode: "none" }))
  assert.equal(withheld.snapshot().certificate, null)
  const pendingPolicy=driver().createFixtureDecisions({id:"C06-P24-R24",slot:0})
  pendingPolicy.frame("CLOCK_READY"); pendingPolicy.sent("CLOCK_ACCEPT")
  const pendingState=nativeState({mode:"C06",phase:"OBSERVER_PENDING",assignmentModeled:false,
    assigned:true,resumed:true,pendingRead:true,rootLiveActual:true})
  assert.deepEqual(pendingPolicy.native(pendingState),["LOSE_CONTROL"])
  assert.throws(() => pendingPolicy.native(pendingState))
  const reorderedPending=driver().createFixtureDecisions({id:"C06-P24-R24",slot:0})
  reorderedPending.frame("CLOCK_READY"); reorderedPending.sent("CLOCK_ACCEPT")
  assert.deepEqual(reorderedPending.frame("READY"),[])
  assert.deepEqual(reorderedPending.native(pendingState),["LOSE_CONTROL"])
  const serverPolicy=driver().createFixtureDecisions({id:"C14-P24-R24",slot:0})
  serverPolicy.frame("CLOCK_READY"); serverPolicy.sent("CLOCK_ACCEPT")
  assert.deepEqual(serverPolicy.native(nativeState({mode:"C14",phase:"SERVER_CLOSED",
    assignmentModeled:false,assigned:true,resumed:true,rootLiveActual:true})),["REPLACE_SERVER"])
  assert.throws(() => serverPolicy.sent("RESUME_SERVER"))
  assert.deepEqual(serverPolicy.replacementReady(),["RESUME_SERVER"])
  serverPolicy.sent("RESUME_SERVER")
  assert.throws(() => serverPolicy.replacementReady())
  const strandedPolicy=driver().createFixtureDecisions({id:"C15-P24-R24",slot:0})
  strandedPolicy.frame("CLOCK_READY"); strandedPolicy.sent("CLOCK_ACCEPT")
  assert.deepEqual(strandedPolicy.frame("READY"),["CONFIG"])
  strandedPolicy.sent("CONFIG"); strandedPolicy.frame("CONFIGURED"); strandedPolicy.sent("START")
  assert.deepEqual(strandedPolicy.witness("WORKLOAD_STARTED"),[])
  assert.deepEqual(strandedPolicy.native(nativeState({mode:"C15",phase:"ROOT_LIVE",
    assigned:true,resumed:true,startIssued:true,rootLiveActual:true,rootRetiredReported:false,
    privateZeroReported:false})),["CANCEL"])
  const deathPolicy=driver().createClassADecisions({id:"A25-P24-R24",slot:0})
  deathPolicy.frame("CLOCK_READY"); deathPolicy.sent("CLOCK_ACCEPT")
  deathPolicy.frame("READY"); deathPolicy.sent("CONFIG"); deathPolicy.frame("CONFIGURED"); deathPolicy.sent("START")
  assert.deepEqual(deathPolicy.witness("WORKLOAD_STARTED"),["PREDEATH"])
  for (const prefix of ["C03","C04","C05","C06","C07"]) {
    const ev=driver().createFixtureCaseEvidence({id:`${prefix}-P24-R24`,deadlineNs:"1000",Hns:"30000000000"})
    if (prefix!=="C03") ev.observe(nativeState({mode:prefix,phase:"TEARDOWN",assignmentModeled:false,
      assigned:true,resumed:prefix!=="C04",startIssued:prefix==="C07"}))
    const transport={schema:"desk.owned-git-fixture-event/1",creationCalls:prefix==="C03"?0:1,
      ownerFreed:prefix==="C03",deadlineNs:"1000"}
    ev.observe({...transport,type:"ENTRY_RESULT",expiredBeforeEntry:prefix==="C03",
      deadlineInputModeled:false,clockModeled:false})
    ev.observe({...transport,type:"CLOSED",requests:0,telemetryGap:false})
    assert.equal(ev.complete({ownerFullclose:true,controlEOF:true,controlClosed:true,controlFailed:false,
      withinDeadline:false,closedAtNs:"1200"})?.cleanupOnly,true,prefix)
    assert.equal(ev.complete({ownerFullclose:true,controlEOF:true,controlClosed:true,controlFailed:false,
      withinDeadline:false,closedAtNs:"10000000000"}),null,prefix)
  }
  function c15Evidence(creations) {
    const ev=driver().createFixtureCaseEvidence({id:"C15-P24-R24",deadlineNs:"1000"})
    ev.observe(nativeState({mode:"C15",phase:"ROOT_LIVE",assigned:true,resumed:true,startIssued:true,
      rootLiveActual:true,rootRetiredReported:false,privateZeroReported:false}))
    ev.observe(nativeState({mode:"C15",assigned:true,resumed:true,startIssued:true,rootLiveActual:true,
      membershipModeled:true,queryModeled:true,rootWaitModeled:true}))
    ev.observe({schema:"desk.owned-git-fixture-event/1",type:"ENTRY_RESULT",creationCalls:creations,
      ownerFreed:true,expiredBeforeEntry:false,deadlineInputModeled:false,clockModeled:false,deadlineNs:"1000"})
    ev.observe({schema:"desk.owned-git-fixture-event/1",type:"CLOSED",requests:0,creationCalls:creations,
      ownerFreed:true,telemetryGap:false,deadlineNs:"1000"})
    return ev
  }
  const strandedJoins={ownerFullclose:false,ownerExitObserved:true,controlEOF:true,controlClosed:true,
    controlFailed:false,withinDeadline:true}
  assert.equal(c15Evidence(1).complete(strandedJoins).quarantineReady,true)
  assert.equal(c15Evidence(1).complete({...strandedJoins,ownerExitObserved:false}),null)
  assert.equal(c15Evidence(1).complete({...strandedJoins,ownerFullclose:true}),null)
  assert.equal(c15Evidence(0).complete(strandedJoins),null)
  const barrier = driver().createFixtureDecisions({ id: "O02-P20-R20", slot: 0 })
  barrier.frame("CLOCK_READY"); barrier.sent("CLOCK_ACCEPT")
  const suspended = nativeState({ phase: "CREATED_SUSPENDED", rootLiveActual: true,
    rootRetiredReported: false, privateZeroReported: false })
  assert.deepEqual(barrier.native(suspended), ["CANCEL","CONTINUE"])
  assert.throws(() => barrier.sent("CONTINUE"))
  barrier.sent("CANCEL"); barrier.sent("CONTINUE")
  assert.throws(() => barrier.native(suspended))
  const bResult = driver().createFixtureDecisions({ id: "B02-P24-R24", slot: 0 })
  bResult.frame("CLOCK_READY"); bResult.sent("CLOCK_ACCEPT"); bResult.frame("READY")
  bResult.sent("CONFIG"); bResult.frame("CONFIGURED"); bResult.sent("START")
  assert.deepEqual(bResult.frame("RESULT"), ["RELEASE_RESULT"])
  assert.throws(() => bResult.frame("CONTROL_COMPLETE"))
  const nativeEvidence = driver().createFixtureCaseEvidence({ id: "O02-P20-R20", deadlineNs: "1000" })
  const actualJoins = { ownerFullclose: true, controlEOF: true, controlClosed: true, withinDeadline: true }
  assert.equal(nativeEvidence.complete(actualJoins), null)
  nativeEvidence.observe(suspended)
  nativeEvidence.observe(nativeState())
  nativeEvidence.observe({ schema: "desk.owned-git-fixture-event/1", type: "ENTRY_RESULT",
    creationCalls: 1, ownerFreed: true, expiredBeforeEntry: false, deadlineInputModeled: false,
    clockModeled: false, deadlineNs: "1000" })
  nativeEvidence.observe({ schema: "desk.owned-git-fixture-event/1", type: "CLOSED",
    requests: 1, creationCalls: 1, ownerFreed: true, telemetryGap: false, deadlineNs: "1000" })
  assert.equal(nativeEvidence.complete(actualJoins).state.created, true)
  assert.equal(nativeEvidence.complete({ ...actualJoins, controlClosed: false }), null)
  assert.equal(nativeEvidence.complete({ ...actualJoins, controlFailed: true }), null)
  assert.throws(() => nativeEvidence.observe(nativeState()))
  assert.equal(nativeEvidence.complete(actualJoins), null)
  const missingEntry = driver().createFixtureCaseEvidence({ id: "C17-P24-R24", deadlineNs: "1000" })
  assert.equal(missingEntry.complete(actualJoins), null)
  const livePeer = { schema: "desk.owned-git-test-peer/1", type: "ROOT_LIVE", generation: H, preparationDigest: P }
  const fixtureModule = require("./fixtures/windows_owned_git_fault_root.cjs")
  assert.deepEqual(fixtureModule.validatePeerObservation(livePeer), livePeer)
  assert.throws(() => fixtureModule.validatePeerObservation({ ...livePeer, controllerPid: 123 }))
  const pressureEdges = new EventEmitter(), pressureOrder = [], pressureMetrics = []
  pressureEdges.writableLength = 0; pressureEdges.writableNeedDrain = false
  pressureEdges.cork = () => pressureOrder.push("cork")
  pressureEdges.uncork = () => pressureOrder.push("uncork")
  pressureEdges.write = (b) => { pressureEdges.writableLength += b.length; pressureEdges.writableNeedDrain = true; return false }
  const pressurePump = fixtureModule.createNodePressurePump({ stream: pressureEdges, deadline: core().captureDeadline(1000),
    report(value) { pressureMetrics.push(value); pressureOrder.push("metrics") }, onError() {} })
  pressurePump.start()
  assert.deepEqual(pressureOrder, ["cork","metrics"])
  assert.equal(pressureMetrics[0].bufferedBytes, 16384)
  assert.equal(pressureMetrics[0].kernelCredit, false)
  pressurePump.release()
  assert.deepEqual(pressureOrder, ["cork","metrics","uncork"])
  assert.throws(() => pressurePump.release())
  const invalidCreated = driver().createFixtureCaseEvidence({ id: "C17-P24-R24", deadlineNs: "1000" })
  const entry0 = { schema: "desk.owned-git-fixture-event/1", type: "ENTRY_RESULT", creationCalls: 0,
    ownerFreed: true, expiredBeforeEntry: false, deadlineInputModeled: true, clockModeled: false, deadlineNs: "1000" }
  const closed0 = { schema: "desk.owned-git-fixture-event/1", type: "CLOSED", requests: 0,
    creationCalls: 0, ownerFreed: true, telemetryGap: false, deadlineNs: "1000" }
  invalidCreated.observe(entry0); invalidCreated.observe(closed0)
  assert.equal(invalidCreated.complete(actualJoins).zeroCreation, true)
  assert.equal(invalidCreated.complete(actualJoins).classification, "invalid-deadline-input")
  const unknownCreated = driver().createFixtureCaseEvidence({ id: "C17-P24-R24", deadlineNs: "1000" })
  unknownCreated.observe({ ...entry0, creationCalls: 1 }); unknownCreated.observe({ ...closed0, creationCalls: 1 })
  assert.equal(unknownCreated.complete(actualJoins), null)
  const queryExit = driver().createFixtureCaseEvidence({ id: "O05-P24-R24", deadlineNs: "1000", Hns: "20000003000" })
  queryExit.observe(nativeState({ phase: "TEARDOWN", mode: "O05", assigned: true, resumed: true, startIssued: true,
    assignmentModeled: false, queryModeled: true, privateZeroReported: false }))
  queryExit.observe({ ...entry0, creationCalls: 1, ownerFreed: false, deadlineInputModeled: false })
  queryExit.observe({ ...closed0, creationCalls: 1, ownerFreed: false })
  const queryCleanup = queryExit.complete({ ...actualJoins, withinDeadline: false, closedAtNs: "1100" })
  assert.equal(queryCleanup.cleanupOnly, true)
  assert.equal(queryCleanup.entry.ownerFreed, false)
  assert.equal(queryExit.complete({ ...actualJoins, withinDeadline: false, closedAtNs: "3000" }), null)
  const preReadyD = core().captureDeadline(1000), fd4 = new EventEmitter(), trace = []
  const preReady = driver().createFixtureDecisions({ id: "O03-P22-R22", slot: 0 })
  preReady.frame("CLOCK_READY"); preReady.sent("CLOCK_ACCEPT")
  fd4.write = (bytes, cb) => { trace.push(core().parseJSON(bytes.subarray(4), 4096).type); cb() }
  const observer = driver().createFixtureBridgeObserver({ stream: fd4, deadline: preReadyD, mode: "O03",
    onFrame(value) {
      for (const action of preReady.native(value)) {
        if (action === "CANCEL") { trace.push("CANCEL_QUEUED"); preReady.sent("CANCEL") }
        else { observer.request(action); preReady.sent(action) }
      }
    } })
  const barrierBody = Buffer.from(JSON.stringify(nativeState({ mode: "O03", phase: "ASSIGNED_SUSPENDED", assigned: true,
    assignmentModeled: false, resumeModeled: true, rootLiveActual: true, rootRetiredReported: false,
    privateZeroReported: false, deadlineNs: preReadyD.expiresNs.toString() })))
  const barrierFrame = Buffer.alloc(barrierBody.length + 4); barrierFrame.writeUInt32LE(barrierBody.length); barrierBody.copy(barrierFrame,4)
  fd4.emit("data", barrierFrame.subarray(0,3)); fd4.emit("data", barrierFrame.subarray(3))
  assert.deepEqual(trace, ["CANCEL_QUEUED","CONTINUE"])
  assert.equal(preReady.snapshot().phase.ready, false)
  const malformedChunks = [], badEdges = { pause() {}, resume() {},
    write(bytes, cb) { malformedChunks.push(Buffer.from(bytes)); cb(malformedChunks.length === 2 ? new Error("peer_refused") : null) } }
  const badPeer = await driver().runBadParentPeer({ stream: badEdges, deadline: core().captureDeadline(1000) })
  assert.equal(malformedChunks[0].readUInt32LE(), 16381)
  assert.equal(badPeer.submittedBytes, 131072)
  assert.equal(badPeer.completedBytes, 65536)
  assert.equal(badPeer.paused && badPeer.resumed && badPeer.writeFailed, true)
  assert.equal(badPeer.kernelCredit, false)
  const expiredEdges = new EventEmitter(), expiredFrames = [], expiredErrors = []
  expiredEdges.write = (_b, cb) => cb()
  driver().createWire({ stream: expiredEdges, binding: { ...binding },
    deadline: { clock: "win-qpc-ns/1", expiresNs: process.hrtime.bigint() - 1n },
    onFrame: (v) => expiredFrames.push(v), onError: (e) => expiredErrors.push(e) })
  expiredEdges.emit("data", core().encodeFrame(frame("owner", "CLOCK_READY", {
    clock: "win-qpc-ns/1", deadlineNs: "1", qpcTicks: "1", qpcFrequency: "1000000000", nowNs: "1" })))
  assert.equal(expiredFrames.length, 0)
  assert.equal(expiredErrors.length, 1)
  const configuredCancel = driver().createClassADecisions({ id: "A10-P24-R24", slot: 0 })
  assert.deepEqual(configuredCancel.frame("CLOCK_READY"), ["CLOCK_ACCEPT"])
  configuredCancel.sent("CLOCK_ACCEPT")
  assert.deepEqual(configuredCancel.frame("READY"), ["CONFIG"])
  configuredCancel.sent("CONFIG")
  assert.deepEqual(configuredCancel.frame("CONFIGURED"), ["CANCEL"])
  assert.throws(() => configuredCancel.frame("CONFIGURED"))
  const sibling = driver().createClassADecisions({ id: "A11-P24-R24", slot: 1 })
  sibling.frame("CLOCK_READY"); sibling.sent("CLOCK_ACCEPT")
  assert.deepEqual(sibling.frame("READY"), [])
  assert.throws(() => sibling.releaseUnused(result()))
  assert.deepEqual(sibling.releaseUnused({ command: { state: "exited", code: 7, signal: null }, input: input() }), ["CANCEL"])
  const aliveGate = driver().createClassADecisions({ id: "O01-P20-R20", slot: 0 })
  assert.throws(() => aliveGate.witness("ALIVE"))
  aliveGate.frame("CLOCK_READY"); aliveGate.sent("CLOCK_ACCEPT"); aliveGate.frame("READY")
  aliveGate.sent("CONFIG"); aliveGate.frame("CONFIGURED"); aliveGate.sent("START")
  assert.deepEqual(aliveGate.frame("RESULT"), ["ALIVE"])
  assert.deepEqual(aliveGate.frame("CONTROL_COMPLETE"), [])
  assert.deepEqual(aliveGate.witness("ALIVE"), ["SEAL"])
  aliveGate.sent("SEAL")
  assert.throws(() => aliveGate.witness("ALIVE"))
  const w = require("./fixtures/windows_owned_git_workload.cjs")
  assert.equal(w.fixedAlias("/public/node", "/public/workload.cjs", "G_EXIT7", "A11-P24-R24"),
    "!exit 7")
  assert.equal(w.fixedAlias("/public/node", "/public/workload.cjs", "G_BASELINE", "A11-P24-R24"),
    '!exec "/public/node" "/public/workload.cjs" G_BASELINE A11-P24-R24')
  const config = driver().syntheticGitConfiguration?.()
  assert.equal(config?.length, 658)
  assert.equal(hash(config), "72427377f73fb4c02c37b86c95177d769c91cd60293e967f605ab40e78efc6dc")
  const gitEnv = driver().buildGitEnvironment?.({ privateRoot: "/private", fixtureRoot: "/owned/public/fixtures", nodeExecutable: "/nodes/24/node.exe",
    gitExecutable: "/git/mingw64/bin/git.exe", shellExecutable: "/git/usr/bin/sh.exe",
    ambient: { SystemRoot: "/windows", PATH: "ambient", BASH_ENV: "ambient", LLVM_PROFILE_FILE: "ambient", CL: "ambient" } })
  assert.equal(gitEnv?.PATH, "/nodes/24;/git/usr/bin;/git/mingw64/bin;/windows/System32")
  assert.equal(gitEnv.GIT_EXEC_PATH,"/owned/public/fixtures/na1-exec-empty")
  assert.equal(gitEnv.MSYSTEM,"MINGW64")
  assert.equal(gitEnv.MSYS2_ENV_CONV_EXCL,"GIT_EXEC_PATH=")
  assert.equal(gitEnv.GIT_CONFIG_GLOBAL, "/private/git-global-empty.cfg")
  assert.equal(gitEnv.GIT_AUTHOR_DATE, "2000-01-01T00:00:00Z")
  assert.equal(gitEnv.TMP, "/private/runtime-scratch")
  for (const key of ["BASH_ENV", "LLVM_PROFILE_FILE", "CL"]) assert.equal(Object.hasOwn(gitEnv, key), false)
  const files = new Map(), handles = new Map(), directories = new Set()
  let nextFd = 0
  const stagedGit = driver().stageSyntheticGitFiles?.({ privateRoot: "/private", live: () => {},
    io: { mkdirSync: (name) => { assert.equal(directories.has(name), false); directories.add(name) },
      openSync: (name, flags) => { assert.equal(flags, "wx"); assert.equal(files.has(name), false);
        files.set(name, Buffer.alloc(0)); handles.set(++nextFd, name); return nextFd },
      writeSync: (fd, bytes, at, length) => { const name = handles.get(fd);
        files.set(name, Buffer.concat([files.get(name), bytes.subarray(at, at + length)])); return length },
      fsyncSync: (fd) => assert.equal(handles.has(fd), true), closeSync: (fd) => handles.delete(fd) } })
  assert.equal(stagedGit?.repository, "/private/synthetic-repository")
  assert.equal(hash(files.get("/private/synthetic-repository/.git/config")),
    "72427377f73fb4c02c37b86c95177d769c91cd60293e967f605ab40e78efc6dc")
  assert.equal(files.get("/private/git-global-empty.cfg").length, 0)
  assert.equal(handles.size, 0)
  const c19 = { id: "C19-P24-Rnone", gap: "none", actual: { matched: true, disposition: "utility-only",
    utilityId: "C19-P24-Rnone", generations: [] } }
  const seeds = { id: c19.id, processes: 2, fullcloseObserved: 2, checksExpected: 4, checksPassed: 0,
    denominator: null, gap: "denominator_missing" }
  const retentionGate = require("./fixtures/windows_owned_git_retention.cjs")
  assert.equal(retentionGate.coverageSeedsComplete?.({ cases: [c19], utilities: [seeds] }), true)
  for (const bad of [{ ...seeds, fullcloseObserved: 1 }, { ...seeds, gap: "producer_unjoined" }]) {
    assert.equal(retentionGate.coverageSeedsComplete({ cases: [c19], utilities: [bad] }), false)
  }
  assert.equal(retentionGate.coverageSeedsComplete({ cases: [{ ...c19, actual: null }], utilities: [seeds] }), false)
  const commitPlan = driver().getNativeCaseRegistry().find((p) => p.id === "A24-P24-R24")
  assert.throws(() => driver().classAPayload({ plan: commitPlan, slot: 0,
    scope: { fixtureRoot: "/public=assignment/fixtures", privateRealmRoot: "/private" },
    root: { path: "/nodes/24/node.exe" }, git: { executable: "/git/mingw64/bin/git.exe", shellExecutable: "/git/usr/bin/sh.exe" },
    ambient: { SystemRoot: "/windows" }, deadline: { expiresNs: 10000n }, witness: { endpoint: "model", nonce: H } }),
  { code: "guard_failed" })
  const peerClose = driver().createDescendantObservations()
  peerClose.event("READY"); peerClose.event("ALIVE"); peerClose.event("CLOSE")
  assert.equal(peerClose.snapshot().fullcloseObserved, false)
  const peerRetired = driver().createDescendantObservations()
  for (const event of ["READY","ALIVE","EOF","CLOSE"]) peerRetired.event(event)
  assert.equal(peerRetired.snapshot().fullcloseObserved, true)
  const localStop = driver().createDescendantObservations()
  for (const event of ["READY","ALIVE","ABORT","EOF","CLOSE"]) localStop.event(event)
  assert.equal(localStop.snapshot().fullcloseObserved, false)
  const ordinaryA = driver().getNativeCaseRegistry().filter((p) => p.evidenceClass === "A" && !p.id.startsWith("A25-"))
  assert.equal(ordinaryA.length, 33)
  assert.equal(ordinaryA.reduce((n, p) => n + p.expected.generations, 0), 34)
  for (const p of ordinaryA) {
    const value = driver().classAPayload({ plan: p, slot: 0,
      scope: { fixtureRoot: "/public/fixtures", privateRealmRoot: "/private" },
      root: { path: `/public/node${p.root}/node.exe` }, git: { executable: "/installed/mingw64/bin/git.exe", shellExecutable: "/installed/usr/bin/sh.exe" },
      ambient: { SystemRoot: "/windows" },
      deadline: { expiresNs: 10000n }, witness: { endpoint: "model-endpoint", nonce: H } })
    const encoded = core().encodePayload(value), decoded = core().parsePayloadBytes(encoded.bytes, encoded.payloadDigest)
    assert.equal(decoded.cwd, "/private/synthetic-repository")
    assert.equal(decoded.env.DESK_TEST_OWNED_GIT_D, "10000")
    assert.equal(decoded.env.DESK_TEST_OWNED_GIT_CASE, p.id)
    assert.equal(Object.hasOwn(decoded.env, "DESK_TEST_OWNED_GIT_FAULT_CASE"), false)
    if (p.profile === "G_BASELINE") assert.equal(value.stdin.length, 4096)
    if (["G_STDIN512K","G_EPIPE"].includes(p.profile)) assert.equal(value.stdin.length, 524288)
    assert.equal(value.args[0],"--exec-path=/public/fixtures/na1-exec-empty")
    assert.equal(value.args.some((arg)=>arg.startsWith("safe.directory=")),false)
    if (p.profile === "G_COMMIT") assert.deepEqual(value.args.slice(1), ["-c","user.name=NC31","-c","user.email=nc31@example.invalid",
      "-c","core.hooksPath=/public/fixtures/hooks","commit","--allow-empty","-m","NC31"])
    if (p.profile === "MISSING_GIT") assert.equal(value.executable, "/public/fixtures/na1-missing-git.exe")
    if (p.id.startsWith("X01-")) assert.equal(value.args[2].includes(`"/public/node${p.root}/node.exe"`), true)
  }
  const fragmented = new EventEmitter(), pieces = [], cancelFrame = frame("parent", "CANCEL")
  const whole = core().encodeFrame(cancelFrame)
  let completeFragmented
  const fragmentedDone = new Promise((resolve) => { completeFragmented = resolve })
  fragmented.write = (bytes, callback) => {
    pieces.push(Buffer.from(bytes)); callback()
    if (pieces.length === whole.length) completeFragmented()
  }
  const fragmentedWire = driver().createWire({ stream: fragmented, binding: { ...binding },
    deadline: core().captureDeadline(1000), fragment: true })
  fragmentedWire.send(cancelFrame); await fragmentedDone
  assert.deepEqual(Buffer.concat(pieces), whole)
  assert.equal(pieces.every((p) => p.length === 1), true)
  assert.equal(fragmentedWire.snapshot().bytesWritten, whole.length)
  assert.deepEqual(driver().getUtilityInvocation("io-helpers").argv, ["--real-io-helpers"])
  assert.deepEqual(driver().getUtilityInvocation("production-seed").argv, ["--owned-git"])
  const admissionInput = { platform: "win32", native: "1", event: "workflow_dispatch", mode: "standard",
    sha: "1".repeat(40), Hns: "120000000000", execArgv: [`--test-name-pattern=^${io.NATIVE_TEST_NAME}$`] }
  assert.equal(driver().nativeRegistrationAllowed(admissionInput), true)
  assert.equal(process.execArgv.some((arg) => arg.startsWith("--test-name-pattern")), true)
  for (const patch of [{ platform: "darwin" }, { native: "0" }, { event: "push" }, { mode: "elevated" },
    { sha: "" }, { execArgv: ["--test-name-pattern=^portable "] }]) {
    assert.equal(driver().nativeRegistrationAllowed({ ...admissionInput, ...patch }), false)
  }
  const workerLedger = driver().createNativeWorkerLedger({ H: 120000000000n })
  const workerIds = driver().getNativeCaseRegistry().slice(0, 13).map((row) => row.id)
  for (const id of workerIds.slice(0,12)) workerLedger.admit(id, 1n)
  const deadlineLedger = driver().createNativeWorkerLedger({ H: 120000000000n })
  assert.equal(deadlineLedger.admit("C01-P24-Rnone", 1n).deadlineNs, "10000000001")
  const classALedger = driver().createNativeWorkerLedger({ H: 120000000000n })
  assert.equal(classALedger.admit("A11-P24-R24", 9n).deadlineNs, "10000000009")
  assert.equal(classALedger.admit("A17-P24-R24", 9n).deadlineNs, "1000000009")
  assert.equal(classALedger.admit("A22-P24-R24", 9n).deadlineNs, "2000000009")
  const cliH = io.captureProductEnvelope(100n)
  assert.equal(cliH.Hns, 120000000100n)
  assert.equal(io.productEnvelopeRemaining(cliH, 1000000100n), 119000)
  assert.equal(io.productEnvelopeRemaining(cliH, 120000000100n), 0)
  assert.throws(() => workerLedger.admit(workerIds[12], 1n))
  const workerJoin = { exitObserved: true, closeObserved: true, stdoutEOF: true, stdoutClosed: true,
    stderrEOF: true, stderrClosed: true, controlEOF: true, controlClosed: true, code: 1, signal: null }
  assert.equal(workerLedger.finish(workerIds[0], workerJoin).fullclose, true)
  workerLedger.admit(workerIds[12], 2n)
  assert.throws(() => workerLedger.admit(workerIds[0], 3n))
  const lateLedger = driver().createNativeWorkerLedger({ H: 120000000000n })
  assert.throws(() => lateLedger.admit(workerIds[0], 90000000000n))
  assert.equal(driver().utilityObservationComplete(workerJoin, 1), true)
  assert.equal(driver().utilityObservationComplete({ ...workerJoin, stderrEOF: false }, 1), false)
  assert.equal(driver().utilityObservationComplete(workerJoin, 0), false)
  assert.equal(driver().generationInvocation({ success: false, certificate: {}, fullclose: true, timely: false }), "HOLD")
  assert.equal(driver().generationInvocation({ success: true, certificate: {}, fullclose: false, timely: true }), "HOLD")
  assert.equal(driver().generationInvocation({ success: false, certificate: {}, fullclose: true, timely: true }), "failed-proved")
  assert.equal(driver().generationInvocation({ success: true, certificate: {}, fullclose: true, timely: true }), "success")
  assert.deepEqual(driver().observeUtilityJoins([workerJoin, { ...workerJoin, signal: "SIGTERM" }],
    { ...workerJoin, stderrEOF: false }), { fullcloseObserved: 2, companionFullcloseObserved: false })
  const utilityPlan = driver().getNativeCaseRegistry().find((p) => p.id === "C01-P24-Rnone")
  const measuredFailure = { ...utilityPlan, actual: { matched: false, disposition: "utility-only", generations: [],
    utilityId: utilityPlan.id, sourceOrigin: "producer_reported", caseDeadlineNs: "1000", finishedNs: "900" }, gap: "case_mismatch" }
  const partialFacts = driver().assembleUtilityWorkerFacts([{ ...workerJoin, id: utilityPlan.id, started: true,
    done: true, gap: "case_mismatch", case: measuredFailure, clock: [], utility: {
      id: utilityPlan.id, processes: 1, fullcloseObserved: 1, companionFullcloseObserved: null, checksExpected: 5,
      checksPassed: 4, kernelCredit: false, resultVectorBits: [true,true,false,false,true], io: null,
      clockRows: [], denominator: null, gap: "case_mismatch" } }])
  assert.equal(partialFacts.cases.find((row) => row.id === utilityPlan.id).actual?.matched, false)
  assert.equal(partialFacts.utilities[0]?.checksPassed, 4)
  const lateFacts = driver().assembleUtilityWorkerFacts([{ ...workerJoin, code: 0, id: utilityPlan.id,
    started: true, done: true, gap: "none", clock: [], utility: null,
    case: { ...measuredFailure, gap: "none", actual: { ...measuredFailure.actual, matched: true, finishedNs: "1000" } } }])
  const lateCase = lateFacts.cases.find((row) => row.id === utilityPlan.id)
  assert.equal(lateCase.actual.matched, false)
  assert.equal(lateCase.gap, "deadline")
  const completedWorker = { ...workerJoin, code: 0, id: utilityPlan.id, deadlineNs: "1000",
    started: true, done: true, gap: "none", clock: [], utility: null,
    case: { ...measuredFailure, gap: "none", actual: { ...measuredFailure.actual, matched: true } } }
  assert.equal(driver().assembleUtilityWorkerFacts([completedWorker]).cases.find((row) =>
    row.id === utilityPlan.id).actual.matched, true)
  const renewedWorker = { ...completedWorker, case: { ...completedWorker.case, actual: {
    ...completedWorker.case.actual, caseDeadlineNs: "2000" } } }
  const renewedCase = driver().assembleUtilityWorkerFacts([renewedWorker]).cases.find((row) => row.id === utilityPlan.id)
  assert.equal(renewedCase.actual.matched, false)
  assert.equal(renewedCase.gap, "deadline")
  const nativeSample = { q: "10", f: "1000000000", converted: "10", edge: "11" }
  assert.equal(driver().validateUtilityClockSample(nativeSample, 9n, 11n,
    { clock: "win-qpc-ns/1", expiresNs: 1000n }), true)
  assert.throws(() => driver().validateUtilityClockSample({ ...nativeSample, converted: "9" }, 9n, 11n,
    { clock: "win-qpc-ns/1", expiresNs: 1000n }))
  assert.equal(io.isOwnedGitProductSelection("^runtime/windows_owned_git\\.test\\.js$", "standard"), true)
  for (const only of ["", "windows_owned_git", "^runtime/windows_owned_git_probe\\.test\\.js$"]) {
    assert.equal(io.isOwnedGitProductSelection(only, "standard"), false)
  }
  assert.equal(io.isOwnedGitProductSelection("^runtime/windows_owned_git\\.test\\.js$", "elevated"), false)
  const tap = "TAP version 13\n# secret C:\\private\\capability\n" +
    "ok 1 - native Windows owned-Git product admission\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n"
  for (const chunks of [[Buffer.from(tap)], [...Buffer.from(tap)].map((v) => Buffer.from([v]))]) {
    const counter = io.createProductTapCounter()
    for (const chunk of chunks) counter.push(chunk, "stdout")
    const counts = counter.end()
    assert.equal(counts.valid, true)
    assert.deepEqual([counts.pass, counts.fail, counts.skipped], [1, 0, 0])
    const row = io.makeProductResult({ counts, exitCode: 0, timedOut: false,
      bytes: { stdout: Buffer.byteLength(tap), stderr: 0 }, ms: 10, code: "none" })
    assert.equal(row.exitCode, 0)
    assert.deepEqual([row.tail, row.outputTail, row.firstFailures, row.stuck], ["", "", "", ""])
    assert.equal(JSON.stringify(row).includes("private"), false)
  }
  for (const bad of [
    tap.replace("ok 1 -", "not ok 1 -"), tap.replace("admission\n", "admission # SKIP\n"),
    tap.replace("1..1", "ok 2 - native Windows owned-Git product admission\n1..1"),
    tap.replace("# pass 1\n", ""), tap.replace("ok 1 - native Windows owned-Git product admission\n", ""),
    "x".repeat(257) + "\n" + tap, "x".repeat(1048577),
  ]) {
    const counter = io.createProductTapCounter(); counter.push(Buffer.from(bad), "stdout")
    const counts = counter.end()
    assert.equal(counts.valid, false)
    assert.equal(io.makeProductResult({ counts, exitCode: 0, timedOut: false,
      bytes: { stdout: Buffer.byteLength(bad), stderr: 0 }, ms: 1, code: "none" }).exitCode, 1)
  }
  const plans = driver().getNativeCaseRegistry()
  assert.equal(plans.length, 80)
  assert.equal(new Set(plans.map((p) => p.id)).size, 80)
  for (const [kind, want] of [["A", 34], ["B", 10], ["C", 36]]) assert.equal(plans.filter((p) => p.evidenceClass === kind).length, want)
  assert.deepEqual(plans.filter((p) => p.evidenceClass === "B").map((p) => p.profile),
    ["NONE", "G_EXIT0", "G_EXIT0", "G_EXIT0", "G_EXIT0", "G_EXIT0", "G_EXIT0", "NONE", "NONE", "NONE"])
  for (const [field, want] of [["generations", 75], ["parentSTART", 40], ["nativeSTART", 39],
    ["genuineRESULT", 26], ["eligibleNativeCertificates", 55], ["ownerFullClose", 73], ["rootCreations", 70],
    ["utilityProcesses", 10], ["modelStrandedRoots", 1]]) {
    assert.equal(plans.reduce((sum, p) => sum + p.expected[field], 0), want)
  }
  assert.throws(() => { plans[0].expected.generations = 2 })
  const productionAssets = { owner: "/public/owner.exe", shim: "/public/owned-git-child.cjs",
    manifest: { files: { owner: { sha256: H }, shim: { sha256: P } } } }
  assert.throws(() => driver().resolveFixtureAssets({ productionAssets, fixtureManifest: {}, variant: "malformed" }))
  assert.throws(() => driver().resolveFixtureAssets({ productionAssets, fixtureManifest: null, variant: "production" }))
  const d = driver(), edges = new EventEmitter(), writes = []
  edges.write = (v, cb) => { writes.push(v); cb() }
  edges.end = () => {}
  const wire = d.createWire({ stream: edges, binding, deadline: core().captureDeadline(1000) })
  wire.send(frame("parent", "CANCEL")); assert.equal(writes.length, 1)
  const observed = d.createObservations(binding, 0)
  observed.ownerExit(0); observed.controlEOF()
  assert.deepEqual(observed.snapshot(), { ownerExited: true, ownerClosed: false, controlEOF: true,
    controlComplete: false, result: null, certificate: null })
  observed.ownerClose(); assert.equal(observed.snapshot().ownerClosed, true)
  assert.throws(() => observed.owner(frame("owner", "TERMINAL", { certificate: certificate({ exactJobZero: false }), resultB64: null, failureCode: "none" })))
  assert.throws(() => wire.send(frame("parent", "CANCEL", {}, Q)))
  const noClock = componentSession(), noStart = componentSession()
  noClock.clockReady(); noClock.ready()
  noStart.configure()
  noStart.receive(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))
  assert.deepEqual([noClock.errors, noStart.errors], [["component_protocol"], ["component_protocol"]])
  assert.deepEqual(noClock.frames.map((value) => value.type), ["CLOCK_READY"])
  assert.equal(noStart.observations.snapshot().result, null)
  assert.throws(() => noClock.acceptClock())
  noClock.ready(); noStart.receive(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))
  assert.deepEqual([noClock.errors, noStart.errors], [["component_protocol"], ["component_protocol"]])
  const legal = componentSession()
  legal.configure(); legal.wire.send(frame("parent", "START", {}, Q))
  legal.receive(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))
  legal.receive(frame("owner", "CONTROL_COMPLETE", {}, Q))
  legal.wire.send(frame("parent", "SEAL", {}, Q))
  legal.receive(frame("owner", "TERMINAL", { certificate: certificate({ payloadDigest: Q, startIssued: true,
    commandState: "reported", resultB64: b64(result()) }), resultB64: b64(result()), failureCode: "none" }, Q))
  assert.deepEqual(legal.errors, [])
  assert.deepEqual(legal.observations.snapshot().result, result())
  assert.equal(legal.observations.snapshot().certificate.commandState, "reported")
  assert.deepEqual(legal.frames.map((value) => value.type), ["CLOCK_READY", "READY", "CONFIGURED", "RESULT", "CONTROL_COMPLETE", "TERMINAL"])
  assert.equal(JSON.parse(legal.writes[0].subarray(4)).type, "CLOCK_ACCEPT")
  const cancel = componentSession()
  cancel.configure(); cancel.wire.send(frame("parent", "CANCEL", {}, Q))
  cancel.receive(frame("owner", "TERMINAL", { certificate: certificate({ payloadDigest: Q }),
    resultB64: null, failureCode: "none" }, Q))
  assert.deepEqual(cancel.errors, [])
  assert.equal(cancel.observations.snapshot().certificate.startIssued, false)
  assert.throws(() => cancel.wire.send(frame("parent", "START", {}, Q)))
  const earlyCancel = componentSession()
  earlyCancel.wire.send(frame("parent", "CANCEL"))
  earlyCancel.clockReady()
  earlyCancel.receive(frame("owner", "TERMINAL", { certificate: null, resultB64: null, failureCode: "none" }))
  assert.deepEqual(earlyCancel.errors, [])
  assert.equal(earlyCancel.observations.snapshot().certificate, null)
  const pendingCancel = componentSession()
  pendingCancel.clockReady(); pendingCancel.acceptClock(); pendingCancel.ready()
  pendingCancel.wire.send(frame("parent", "CONFIG", { path: "/payload" }, Q))
  pendingCancel.wire.send(frame("parent", "CANCEL", {}, Q))
  pendingCancel.receive(frame("owner", "TERMINAL", { certificate: certificate({ payloadDigest: Q }),
    resultB64: null, failureCode: "none" }, Q))
  assert.deepEqual(pendingCancel.errors, [])
  assert.equal(pendingCancel.observations.snapshot().certificate.payloadDigest, Q)
  const runningCancel = componentSession()
  runningCancel.configure(); runningCancel.wire.send(frame("parent", "START", {}, Q))
  runningCancel.wire.send(frame("parent", "CANCEL", {}, Q))
  runningCancel.receive(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))
  runningCancel.receive(frame("owner", "TERMINAL", { certificate: certificate({ payloadDigest: Q, startIssued: true,
    commandState: "reported", resultB64: b64(result()) }), resultB64: b64(result()), failureCode: "none" }, Q))
  assert.deepEqual(runningCancel.errors, [])
  assert.deepEqual(runningCancel.observations.snapshot().result, result())
  const unknown = componentSession()
  unknown.configure(); unknown.wire.send(frame("parent", "START", {}, Q))
  unknown.receive(frame("owner", "TERMINAL", { certificate: certificate({ payloadDigest: Q, startIssued: true,
    commandState: "unknown" }), resultB64: null, failureCode: "retirement" }, Q))
  assert.deepEqual(unknown.errors, [])
  assert.equal(unknown.observations.snapshot().result, null)
  assert.equal(unknown.observations.snapshot().certificate.commandState, "unknown")
  const dropped = componentSession()
  dropped.configure(); dropped.wire.send(frame("parent", "START", {}, Q))
  dropped.receive(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))
  const lostResult = frame("owner", "TERMINAL", { certificate: certificate({ payloadDigest: Q, startIssued: true,
    commandState: "unknown" }), resultB64: null, failureCode: "none" }, Q)
  dropped.receive(lostResult); dropped.receive(lostResult)
  assert.deepEqual(dropped.errors, ["component_protocol"])
  assert.deepEqual(dropped.observations.snapshot().result, result())
  assert.equal(dropped.observations.snapshot().certificate, null)
  const encodedConfigured = core().encodeFrame(frame("owner", "CONFIGURED", {}, Q))
  const noStartCertificate = certificate({ payloadDigest: Q })
  const failedTerminal = frame("owner", "TERMINAL", { certificate: noStartCertificate,
    resultB64: null, failureCode: "io" }, Q)
  const encodedTerminal = core().encodeFrame(failedTerminal)
  function chunksFor(values) {
    const bytes = Buffer.concat(values)
    const split = values[0].length
    const cuts = [1, 3, 4, split - 1, split + 1, split + 3, bytes.length - 1]
    const fragmented = []
    let start = 0
    for (const end of cuts) { if (end > start && end < bytes.length) { fragmented.push(bytes.subarray(start, end)); start = end } }
    fragmented.push(bytes.subarray(start))
    return [values, [bytes], fragmented]
  }
  for (const action of ["START", "CANCEL"]) for (const chunks of chunksFor([encodedConfigured, encodedTerminal])) {
    const raced = componentSession((value, activeWire) => {
      if (value.type === "CONFIGURED") activeWire.send(frame("parent", action, {}, Q))
    })
    raced.clockReady(); raced.acceptClock(); raced.ready()
    raced.wire.send(frame("parent", "CONFIG", { path: "/payload" }, Q))
    for (const chunk of chunks) raced.stream.emit("data", chunk)
    assert.deepEqual(raced.errors, [])
    assert.deepEqual(raced.frames.map((value) => value.type), ["CLOCK_READY", "READY", "CONFIGURED", "TERMINAL"])
    assert.deepEqual(raced.observations.snapshot().certificate, noStartCertificate)
    assert.equal(raced.observations.snapshot().result, null)
    assert.equal(raced.frames.at(-1).failureCode, "io")
    assert.equal(raced.frames.at(-1).resultB64, null)
    assert.deepEqual(raced.writes.map((bytes) => JSON.parse(bytes.subarray(4)).type), ["CLOCK_ACCEPT", "CONFIG", action])
  }
  const readyBytes = core().encodeFrame(frame("owner", "READY", { payloadPath: "/payload" }))
  const unconfiguredTerminal = frame("owner", "TERMINAL", { certificate: certificate(),
    resultB64: null, failureCode: "io" })
  for (const chunks of chunksFor([readyBytes, core().encodeFrame(unconfiguredTerminal)])) {
    const raced = componentSession((value, activeWire) => {
      if (value.type === "READY") activeWire.send(frame("parent", "CONFIG", { path: "/payload" }, Q))
    })
    raced.clockReady(); raced.acceptClock()
    for (const chunk of chunks) raced.stream.emit("data", chunk)
    assert.deepEqual(raced.errors, [])
    assert.deepEqual(raced.observations.snapshot().certificate, certificate())
    assert.equal(raced.frames.at(-1).failureCode, "io")
    assert.deepEqual(raced.writes.map((bytes) => JSON.parse(bytes.subarray(4)).type), ["CLOCK_ACCEPT", "CONFIG"])
  }
  const resultBytes = core().encodeFrame(frame("owner", "RESULT", { resultB64: b64(result()) }, Q))
  const reportedCertificate = certificate({ payloadDigest: Q, startIssued: true,
    commandState: "reported", resultB64: b64(result()) })
  const completionBytes = core().encodeFrame(frame("owner", "CONTROL_COMPLETE", {}, Q))
  const reportedTerminal = frame("owner", "TERMINAL", { certificate: reportedCertificate,
    resultB64: b64(result()), failureCode: "io" }, Q)
  for (const chunks of chunksFor([resultBytes, completionBytes, core().encodeFrame(reportedTerminal)])) {
    const raced = componentSession((value, activeWire) => {
      if (value.type === "CONTROL_COMPLETE") activeWire.send(frame("parent", "SEAL", {}, Q))
    })
    raced.configure(); raced.wire.send(frame("parent", "START", {}, Q))
    for (const chunk of chunks) raced.stream.emit("data", chunk)
    assert.deepEqual(raced.errors, [])
    assert.deepEqual(raced.observations.snapshot().certificate, reportedCertificate)
    assert.deepEqual(raced.observations.snapshot().result, result())
    assert.equal(raced.frames.at(-1).failureCode, "io")
    assert.deepEqual(raced.writes.map((bytes) => JSON.parse(bytes.subarray(4)).type), ["CLOCK_ACCEPT", "CONFIG", "START", "SEAL"])
  }
  for (const chunks of chunksFor([resultBytes, core().encodeFrame(lostResult)])) {
    const raced = componentSession()
    raced.configure(); raced.wire.send(frame("parent", "START", {}, Q))
    for (const chunk of chunks) raced.stream.emit("data", chunk)
    assert.deepEqual(raced.errors, ["component_protocol"])
    assert.deepEqual(raced.observations.snapshot().result, result())
    assert.equal(raced.observations.snapshot().certificate, null)
  }
  const capture = d.createDataObservations({ outputLimit: 3 })
  capture.chunk("stdout", Buffer.from("é")); capture.chunk("stderr", Buffer.from("ab"))
  assert.equal(capture.snapshot().bytes, 4)
  assert.equal(capture.snapshot().overflowed, true)
  capture.end("stdout"); assert.equal(capture.snapshot().dataComplete, false)
  capture.end("stderr"); capture.close("stdout"); assert.equal(capture.snapshot().dataComplete, false)
  capture.close("stderr"); assert.equal(capture.snapshot().dataComplete, true)
  capture.error("stderr"); assert.equal(capture.snapshot().dataComplete, false)
  const f = await fixture(), placeholder = path.join(f.realm, "payload.json")
  fs.writeFileSync(placeholder, "")
  const staged = d.stagePayloadFile({ payload: payload({ stdin: Buffer.from("input") }), payloadPath: placeholder, expectedPath: placeholder })
  assert.equal(staged.expectedBytes, 5)
  assert.deepEqual(core().parsePayloadBytes(fs.readFileSync(placeholder), staged.payloadDigest).stdin, Buffer.from("input"))
  const stagedBeforeExpiry = fs.readFileSync(placeholder)
  assert.throws(() => d.stagePayloadFile({ payload: payload(), payloadPath: placeholder, expectedPath: placeholder,
    deadline: { clock: "win-qpc-ns/1", expiresNs: process.hrtime.bigint() - 1n } }))
  assert.deepEqual(fs.readFileSync(placeholder), stagedBeforeExpiry)
  assert.throws(() => d.stagePayloadFile({ payload: payload(), payloadPath: placeholder, expectedPath: "/wrong" }))
})
