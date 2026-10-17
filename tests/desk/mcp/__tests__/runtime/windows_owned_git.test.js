import test from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createHash, randomUUID } from "node:crypto"
import { EventEmitter } from "node:events"
import fs from "node:fs"
import path from "node:path"

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

test("portable manifest schema and own bytes are required", async () => {
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
  assert.throws(() => d.stagePayloadFile({ payload: payload(), payloadPath: placeholder, expectedPath: "/wrong" }))
})
