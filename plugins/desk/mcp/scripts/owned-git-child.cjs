"use strict"

const crypto = require("node:crypto")
const path = require("node:path")
const fs = require("node:fs")
const net = require("node:net")
const { spawn } = require("node:child_process")

const PROTOCOL = "desk.owned-git/1"
const CLOCK = "win-qpc-ns/1"
const HEX = /^[0-9a-f]{64}$/
const ERR = /^[A-Z0-9_]{1,80}$/
const SIG = /^SIG[A-Z0-9]{1,20}$/
const U64 = 18446744073709551615n
const common = ["protocol", "role", "type", "generation", "preparationDigest", "payloadDigest"]
function refuse(code = "protocol") { const error = new Error(code); error.code = code; throw error }
function object(v) { return v !== null && typeof v === "object" && !Array.isArray(v) && !Buffer.isBuffer(v) }
function closed(v, keys) {
  if (!object(v) || Object.keys(v).length !== keys.length || keys.some((k) => !Object.hasOwn(v, k))) refuse()
}
function text(v, nonempty = false) {
  if (typeof v !== "string" || (nonempty && !v) || v.includes("\0") || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v)) refuse()
  return v
}
function absolute(v) {
  text(v, true)
  if (!path.isAbsolute(v) && !path.win32.isAbsolute(v)) refuse()
  return v
}
function hex(v) { if (typeof v !== "string" || !HEX.test(v)) refuse(); return v }
const safeErrorCode = (error) => typeof error?.code === "string" && ERR.test(error.code) ? error.code : "UNKNOWN"
function decimal(v) {
  if (typeof v !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(v) || BigInt(v) > U64) refuse("clock")
  return BigInt(v)
}
function deadlineValue(v) {
  closed(v, ["clock", "expiresNs"])
  if (v.clock !== CLOCK || typeof v.expiresNs !== "bigint" || v.expiresNs < 0n || v.expiresNs > U64) refuse("clock")
  return v.expiresNs
}
function captureDeadline(budgetMs, parentDeadline) {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 0 || budgetMs > 10000) refuse("clock")
  let expiresNs = process.hrtime.bigint() + BigInt(budgetMs) * 1000000n
  if (parentDeadline && deadlineValue(parentDeadline) < expiresNs) expiresNs = parentDeadline.expiresNs
  return Object.freeze({ clock: CLOCK, expiresNs })
}
function remainingNanoseconds(deadline, nowNs) {
  const end = deadlineValue(deadline)
  if (typeof nowNs !== "bigint" || nowNs < 0n) refuse("clock")
  return nowNs >= end ? 0n : end - nowNs
}
function mirrorWindowsHrtime(ticks, frequency) {
  const q = decimal(ticks), f = decimal(frequency)
  if (!f) refuse("clock")
  const scale = Number(f) / 1000000000
  const n = Number(q) / scale
  if (!Number.isFinite(n) || n < 0 || n >= 18446744073709551616) refuse("clock")
  return BigInt(Math.trunc(n))
}

// Scan structure before JSON.parse: duplicate keys must not be silently collapsed.
function parseJSON(bytes, max) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > max) refuse()
  let source
  try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes) } catch { refuse() }
  if (source.includes("\0")) refuse()
  let i = 0
  const ws = () => { while (/\s/u.test(source[i] ?? "") && i < source.length) i++ }
  function string() {
    const start = i++
    while (i < source.length) {
      const c = source[i++]
      if (c === "\\") i++
      else if (c === '"') {
        let value
        try { value = JSON.parse(source.slice(start, i)) } catch { refuse() }
        return text(value)
      }
    }
    refuse()
  }
  function value(depth) {
    if (depth > 16) refuse()
    ws()
    if (source[i] === '"') { string(); return }
    if (source[i] === "{" || source[i] === "[") {
      const isObject = source[i++] === "{", end = isObject ? "}" : "]", keys = new Set()
      ws(); if (source[i] === end) { i++; return }
      for (;;) {
        if (isObject) {
          ws(); if (source[i] !== '"') refuse()
          const key = string(); if (keys.has(key)) refuse(); keys.add(key)
          ws(); if (source[i++] !== ":") refuse()
        }
        value(depth + 1); ws()
        if (source[i] === end) { i++; return }
        if (source[i++] !== ",") refuse()
      }
    }
    const match = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(source.slice(i))
    if (!match) refuse()
    i += match[0].length
  }
  value(0); ws(); if (i !== source.length) refuse()
  try { return JSON.parse(source) } catch { refuse() }
}
function canonicalBase64(v, max = Infinity) {
  text(v)
  if (v.length > Math.ceil(max / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(v)) refuse()
  const bytes = Buffer.from(v, "base64")
  if (bytes.length > max || bytes.toString("base64") !== v) refuse()
  return bytes
}
function validateInput(v) {
  closed(v, ["state", "expectedBytes", "submittedBytes", "errorCode"])
  if (!["complete", "failed", "unknown"].includes(v.state) ||
      !Number.isSafeInteger(v.expectedBytes) || !Number.isSafeInteger(v.submittedBytes) ||
      v.submittedBytes < 0 || v.expectedBytes < v.submittedBytes ||
      !(v.errorCode === null || (typeof v.errorCode === "string" && ERR.test(v.errorCode))) ||
      (v.state === "complete" && (v.errorCode !== null || v.submittedBytes !== v.expectedBytes))) refuse()
  return { state: v.state, expectedBytes: v.expectedBytes, submittedBytes: v.submittedBytes, errorCode: v.errorCode }
}
function canonicalResult(v, rootOnly = true) {
  closed(v, ["command", "input"])
  const x = v.command
  let command
  if (x?.state === "exited") {
    closed(x, ["state", "code", "signal"])
    if (!((x.code === null && typeof x.signal === "string" && SIG.test(x.signal)) ||
      (Number.isInteger(x.code) && x.code >= -2147483648 && x.code <= 4294967295 && x.signal === null))) refuse()
    command = { state: x.state, code: x.code, signal: x.signal }
  } else if (x?.state === "spawn_failed") {
    closed(x, ["state", "code"]); if (typeof x.code !== "string" || !ERR.test(x.code)) refuse()
    command = { state: x.state, code: x.code }
  } else if (!rootOnly && x?.state === "unknown") {
    closed(x, ["state"]); command = { state: "unknown" }
  } else refuse()
  return { command, input: validateInput(v.input) }
}
function decodeResult(v) {
  const bytes = canonicalBase64(v, 512)
  const value = canonicalResult(parseJSON(bytes, 512))
  if (!bytes.equals(Buffer.from(JSON.stringify(value), "ascii"))) refuse()
  return value
}
function normalizeResult({ code, signal, spawnError, input }) {
  let command
  if (spawnError != null) command = { state: "spawn_failed", code: safeErrorCode(spawnError) }
  else if ((Number.isInteger(code) && signal === null) || (code === null && SIG.test(signal))) command = { state: "exited", code, signal }
  else command = { state: "unknown" }
  return canonicalResult({ command, input }, false)
}
function validateCertificate(v, expected) {
  closed(v, ["protocol", "purpose", "generation", "preparationDigest", "payloadDigest", "sealed", "exactJobZero",
    "rootRetired", "startIssued", "commandState", "resultB64"])
  if (v.protocol !== PROTOCOL || v.purpose !== "triage-private-git" ||
    hex(v.generation) !== expected.generation || hex(v.preparationDigest) !== expected.preparationDigest ||
    !(v.payloadDigest === null || (typeof v.payloadDigest === "string" && HEX.test(v.payloadDigest))) ||
    v.payloadDigest !== expected.payloadDigest || v.sealed !== true || v.exactJobZero !== true ||
    v.rootRetired !== true || typeof v.startIssued !== "boolean") refuse()
  if (v.resultB64 !== null) decodeResult(v.resultB64)
  const state = !v.startIssued ? "not_started" : v.resultB64 === null ? "unknown" : "reported"
  if (v.commandState !== state || (!v.startIssued && v.resultB64 !== null) ||
    (v.startIssued && v.payloadDigest === null)) refuse()
  return structuredClone(v)
}
const extraFields = {
  parent: { PREPARE: ["nodeExecutable", "rootScript", "neutralCwd", "privateRoot", "pipeSuffix", "capability", "clock", "deadlineNs"],
    CLOCK_ACCEPT: ["clock", "deadlineNs"], CONFIG: ["path"], START: [], CANCEL: [], SEAL: [] },
  owner: { CLOCK_READY: ["clock", "deadlineNs", "qpcTicks", "qpcFrequency", "nowNs"], READY: ["payloadPath"],
    AUTH: ["clientNonce", "capability"], CONFIG: ["path"], START: [], CONFIGURED: [], RESULT: ["resultB64"],
    CONTROL_COMPLETE: [], TERMINAL: ["certificate", "resultB64", "failureCode"] },
  root: { HELLO: ["clientNonce"], ACK: ["clientNonce"], CONFIGURED: [], RESULT: ["resultB64"] },
}
function validateFrame(v) {
  const extras = extraFields[v?.role]?.[v?.type]
  if (!extras || v.protocol !== PROTOCOL) refuse()
  closed(v, [...common, ...extras]); hex(v.generation); hex(v.preparationDigest)
  if (v.payloadDigest !== null) hex(v.payloadDigest)
  for (const key of ["path", "payloadPath", "nodeExecutable", "rootScript", "neutralCwd", "privateRoot"]) if (key in v) absolute(v[key])
  for (const key of ["pipeSuffix", "capability", "clientNonce"]) if (key in v) hex(v[key])
  if ("clock" in v && v.clock !== CLOCK) refuse("clock")
  for (const key of ["deadlineNs", "qpcTicks", "qpcFrequency", "nowNs"]) if (key in v) decimal(v[key])
  if (["PREPARE", "CLOCK_READY", "CLOCK_ACCEPT", "HELLO", "AUTH", "ACK", "READY"].includes(v.type) && v.payloadDigest !== null) refuse()
  if (["CONFIG", "CONFIGURED", "START", "RESULT", "CONTROL_COMPLETE", "SEAL"].includes(v.type) && v.payloadDigest === null) refuse()
  if (v.type === "RESULT") decodeResult(v.resultB64)
  if (v.type === "TERMINAL") {
    if (!["none", "prepare", "configure", "start", "protocol", "io", "deadline", "retirement", "clock", "internal"].includes(v.failureCode)) refuse()
    if (v.resultB64 !== null) decodeResult(v.resultB64)
    if (v.resultB64 !== null && v.payloadDigest === null) refuse()
    if (v.certificate !== null) {
      validateCertificate(v.certificate, v)
      if (v.certificate.resultB64 !== v.resultB64) refuse()
    }
  }
  return v
}
function encodeFrame(v) {
  validateFrame(v)
  const bytes = Buffer.from(JSON.stringify(v))
  if (!bytes.length || bytes.length > 16380) refuse()
  const wire = Buffer.alloc(bytes.length + 4); wire.writeUInt32LE(bytes.length); bytes.copy(wire, 4)
  return wire
}
function createFrameDecoder({ role, binding, phase }) {
  let used = 0, target = 4, ended = false, failed = false, digest = binding.payloadDigest, resultB64 = null
  // The parent driver shares its send/receive phase; Root needs only a private cursor.
  const cursor = typeof phase === "string" ? { current: phase } : phase
  closed(cursor, ["current"])
  const buffer = Buffer.alloc(16384)
  const transitions = {
    preparing: { CLOCK_READY: "clock_ready", HELLO: "hello" }, clock_accepted: { READY: "ready" },
    configuring: { CONFIGURED: "configured" },
    running: { RESULT: "result" }, result: { CONTROL_COMPLETE: "complete" },
    hello: { AUTH: "authenticated" }, authenticated: { CONFIG: "configured_root" },
    configured_root: { START: "running" },
  }
  return {
    push(chunk) {
      try {
        if (failed || ended || !Buffer.isBuffer(chunk)) refuse()
        const values = []
        for (let at = 0; at < chunk.length;) {
          const n = Math.min(target - used, chunk.length - at)
          chunk.copy(buffer, used, at, at + n); used += n; at += n
          if (used !== target) continue
          if (target === 4) {
            const length = buffer.readUInt32LE()
            if (!length || length > 16380) refuse()
            target += length; continue
          }
          const value = validateFrame(parseJSON(buffer.subarray(4, target), 16380))
          const current = cursor.current
          if (value.role !== role || value.generation !== binding.generation ||
            value.preparationDigest !== binding.preparationDigest) refuse()
          if (value.type === "CONFIG" && role === "owner" && current === "authenticated") digest = value.payloadDigest
          else if (value.type === "CONFIGURED" && role === "owner" && current === "configuring") {
            if (!binding.proposedPayloadDigest || value.payloadDigest !== binding.proposedPayloadDigest) refuse()
            digest = value.payloadDigest
          } else if (value.type === "TERMINAL" && role === "owner" && digest === null) {
            if (value.payloadDigest !== null && value.payloadDigest !== binding.proposedPayloadDigest) refuse()
          } else if (value.payloadDigest !== digest) refuse()
          if (value.type === "TERMINAL" && role === "owner" && current !== "terminal") {
            if ((value.resultB64 !== null || value.certificate?.startIssued === true) &&
              !["running", "result", "complete"].includes(current)) refuse()
            if (resultB64 !== null && value.resultB64 !== resultB64) refuse()
            cursor.current = "terminal"
          } else {
            const next = transitions[current]?.[value.type]
            if (!next) refuse()
            cursor.current = next
          }
          if (value.type === "RESULT") resultB64 = value.resultB64
          values.push(value); used = 0; target = 4
        }
        return values
      } catch (error) { failed = true; throw error }
    },
    end() { if (failed || ended || used) { failed = true; refuse() } ended = true },
  }
}
function createFrameWriter(stream, onError = () => {}) {
  const queue = []; let inflight = false, final = false, failed = false
  function pump() {
    if (failed || inflight) return
    if (!queue.length) { if (final) stream.end(); return }
    inflight = true
    try {
      stream.write(queue[0], (error) => {
        inflight = false
        if (error) { failed = true; onError(error); return }
        queue.shift(); pump()
      })
    } catch (error) { failed = true; onError(error) }
  }
  return {
    send(value) {
      if (final || failed || queue.length >= 2) refuse("io")
      queue.push(encodeFrame(value)); pump()
    },
    finish() { if (final || failed) refuse("io"); final = true; pump() },
  }
}
function createPreparationBinding(input, assets, deadline) {
  const keys = ["generation", "recordId", "token", "deskRoot", "candidatePath", "ref", "commandRole",
    "sequence", "privateRealmRoot", "privateRoot"]
  const assetKeys = ["publicMcpRoot", "nodeExecutable", "nodeSha256", "ownerSha256", "shimSha256"]
  closed(input, keys)
  closed(assets, assetKeys)
  const p = { ...input, ...assets, protocol: PROTOCOL, purpose: "triage-private-git", clock: CLOCK, deadlineNs: deadlineValue(deadline).toString() }
  if (deadline.clock !== CLOCK) refuse("clock")
  for (const k of ["generation", "recordId", "nodeSha256", "ownerSha256", "shimSha256"]) hex(p[k])
  if (typeof p.token !== "string" || !/^[0-9a-f]{32}$/.test(p.token) || p.ref !== `desk-triage/${p.token}` ||
    !["preflight", "discovery", "worktree", "stage", "commit", "validation", "push", "cleanup", "filter", "recovery"].includes(p.commandRole) ||
    !Number.isInteger(p.sequence) || p.sequence < 0 || p.sequence > 4294967295) refuse()
  for (const k of ["deskRoot", "candidatePath", "privateRealmRoot", "privateRoot", "publicMcpRoot", "nodeExecutable"]) absolute(p[k])
  const paths = /^(?:[A-Za-z]:[\\/]|\\\\)/u.test(p.deskRoot) ? path.win32 : path.posix
  if (p.candidatePath !== paths.join(p.deskRoot, ".git", "desk-triage", p.token, "wt")) refuse()
  const tuple = [p.protocol, p.purpose, ...keys.map((k) => p[k]), ...assetKeys.map((k) => p[k]), p.clock, p.deadlineNs]
  return { preparation: Object.freeze(p), preparationDigest: crypto.createHash("sha256").update(JSON.stringify(tuple)).digest("hex") }
}
function normalizeOutputLimit(value = Infinity) {
  if (value !== Infinity && (!Number.isSafeInteger(value) || value < 0)) refuse()
  return value
}
function validatePayload(v) {
  closed(v, ["executable", "args", "cwd", "env", "stdin"])
  text(v.executable, true); absolute(v.cwd)
  if (!Array.isArray(v.args)) refuse()
  v.args.forEach((a) => text(a))
  if (!object(v.env)) refuse()
  const env = Object.create(null)
  for (const [key, value] of Object.entries(v.env)) {
    text(key, true); text(value)
    if (key.includes("=")) refuse()
    if (!/^(?:DESK_OWNED_GIT_|NODE_CHANNEL_FD$|NODE_CHANNEL_SERIALIZATION_MODE$|NODE_UNIQUE_ID$)/iu.test(key)) env[key] = value
  }
  const stdin = v.stdin === null ? null : canonicalBase64(v.stdin)
  return { executable: v.executable, args: [...v.args], cwd: v.cwd, env: { ...env }, stdin }
}
function encodePayload(v) {
  closed(v, ["executable", "args", "cwd", "env", "stdin"])
  if (v.stdin !== null && !Buffer.isBuffer(v.stdin)) refuse()
  const wire = { ...v, stdin: v.stdin === null ? null : v.stdin.toString("base64") }
  validatePayload(wire)
  const bytes = Buffer.from(JSON.stringify(wire))
  if (!bytes.length || bytes.length > 1048576) refuse()
  return { bytes, payloadDigest: crypto.createHash("sha256").update(bytes).digest("hex") }
}
function parsePayloadBytes(bytes, expectedDigest) {
  hex(expectedDigest)
  if (!Buffer.isBuffer(bytes) || bytes.length > 1048576 ||
    crypto.createHash("sha256").update(bytes).digest("hex") !== expectedDigest) refuse("configure")
  return validatePayload(parseJSON(bytes, 1048576))
}
function createRootState(binding, clientNonce, capability) {
  closed(binding, ["generation", "preparationDigest", "payloadDigest"])
  if (binding.payloadDigest !== null) refuse()
  hex(binding.generation); hex(binding.preparationDigest); hex(clientNonce); hex(capability)
  const expectedCapability = Buffer.from(capability, "hex")
  capability = undefined
  let phase = "new", digest = null
  const base = (type, extra = {}) => ({ protocol: PROTOCOL, role: "root", type, ...binding, payloadDigest: digest, ...extra })
  return {
    get started() { return phase === "running" },
    hello() { if (phase !== "new") refuse(); phase = "hello"; return base("HELLO", { clientNonce }) },
    accept(value) {
      try {
        validateFrame(value)
        if (value.role !== "owner" || value.generation !== binding.generation || value.preparationDigest !== binding.preparationDigest) refuse()
        if (phase === "hello" && value.type === "AUTH" && value.clientNonce === clientNonce) {
          const presented = Buffer.from(value.capability, "hex")
          let matches
          try { matches = crypto.timingSafeEqual(presented, expectedCapability) } finally { presented.fill(0) }
          if (!matches) refuse()
          expectedCapability.fill(0); phase = "authenticated"; return "send_ack"
        }
        if (phase === "authenticated" && value.type === "CONFIG") { digest = value.payloadDigest; phase = "reading"; return "read_payload" }
        if (phase === "configured" && value.type === "START" && value.payloadDigest === digest) { phase = "running"; return "start" }
        refuse()
      } catch (error) { phase = "refused"; expectedCapability.fill(0); throw error }
    },
    configured() { if (phase !== "reading") refuse(); phase = "configured"; return "configured" },
    close() { phase = "closed"; expectedCapability.fill(0) },
  }
}
function createFinalInputTracker({ stream, expectedBytes, deadline, onSettled }) {
  if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) refuse()
  let submittedBytes = 0, finished = false, closedStream = false, errorCode = null, settled = null, timer
  function settle(state) {
    if (settled) return
    clearTimeout(timer)
    settled = validateInput({ state, expectedBytes, submittedBytes, errorCode })
    onSettled({ ...settled })
  }
  const tracker = {
    result: () => settled && { ...settled },
    recordSubmitted(bytes, error) {
      if (settled) return
      if (!Number.isSafeInteger(bytes) || bytes < 0 || submittedBytes + bytes > expectedBytes) refuse()
      if (error) errorCode = safeErrorCode(error)
      else submittedBytes += bytes
    },
    onCommandExit() {
      if (!settled && stream && !closedStream) {
        if (!finished || submittedBytes !== expectedBytes) {
          errorCode ??= "COMMAND_EXIT"; stream.destroy()
        }
      }
    },
  }
  const remaining = remainingNanoseconds(deadline, process.hrtime.bigint())
  if (!remaining) { errorCode = "DEADLINE"; settle("unknown"); return tracker }
  if (stream === null) {
    if (expectedBytes !== 0) { errorCode = "STDIN_UNAVAILABLE"; settle("failed") }
    else settle("complete")
    return tracker
  }
  stream.on("error", (error) => { if (!settled) errorCode = safeErrorCode(error) })
  stream.once("finish", () => { finished = true })
  stream.once("close", () => {
    closedStream = true
    settle(finished && !errorCode && submittedBytes === expectedBytes ? "complete" : "failed")
  })
  timer = setTimeout(() => { errorCode ??= "DEADLINE"; settle("unknown"); stream.destroy() }, Number(remaining / 1000000n))
  timer.unref()
  return tracker
}
function createResultGate({ sendResult, inputTracker }) {
  let command, input, sent = false
  function final() {
    input ??= inputTracker?.result()
    if (sent || !command || !input) return
    const value = normalizeResult({ ...command, input })
    if (value.command.state === "unknown") return
    sent = true; sendResult(value)
  }
  return {
    commandClosed(value) { if (!command) command = value; final() },
    inputSettled(value) { input = value; final() },
  }
}

function readPayloadFile(filename, digest) {
  const fd = fs.openSync(filename, "r")
  try {
    const size = fs.fstatSync(fd).size
    if (!size || size > 1048576) refuse("configure")
    const bytes = Buffer.alloc(size + 1)
    let used = 0, n
    while (used < bytes.length && (n = fs.readSync(fd, bytes, used, bytes.length - used, null))) used += n
    if (used !== size) refuse("configure")
    return parsePayloadBytes(bytes.subarray(0, used), digest)
  } finally { fs.closeSync(fd) }
}
function runRoot() {
  if (process.platform !== "win32" || process.argv.length !== 3 || process.argv[2] !== "--owned-root") refuse("prepare")
  const env = process.env
  let endpoint = env.DESK_OWNED_GIT_ENDPOINT, capability = env.DESK_OWNED_GIT_CAPABILITY
  const binding = { generation: env.DESK_OWNED_GIT_GENERATION, preparationDigest: env.DESK_OWNED_GIT_PREPARATION_DIGEST, payloadDigest: null }
  const deadline = { clock: env.DESK_OWNED_GIT_CLOCK, expiresNs: decimal(env.DESK_OWNED_GIT_DEADLINE_NS) }
  if (!/^\\\\\.\\pipe\\desk-owned-git-[0-9a-f]{64}$/.test(endpoint) || !remainingNanoseconds(deadline, process.hrtime.bigint())) refuse("prepare")
  const clientNonce = crypto.randomBytes(32).toString("hex")
  const state = createRootState(binding, clientNonce, capability)
  // The sole application-level client construction. Never supplied to spawn.
  const socket = net.createConnection({ path: endpoint })
  endpoint = capability = undefined
  for (const key of Object.keys(env)) if (/^DESK_OWNED_GIT_/iu.test(key)) delete env[key]
  let failed = false, configured, digest = null, resultSent = false, tracker, gate, spawnError
  const fail = () => { if (failed) return; failed = true; state.close(); socket.destroy(); process.exitCode = 1 }
  const writer = createFrameWriter(socket, fail)
  const send = (type, extra = {}) => writer.send({ protocol: PROTOCOL, role: "root", type, ...binding, payloadDigest: digest, ...extra })
  const timer = setTimeout(() => {
    // Do not destroy libuv's possibly still-busy connect/name from a JS timer.
    // Native independently expires the same D and owns actual Root retirement.
    failed = true; state.close(); process.exitCode = 1
  }, Number(remainingNanoseconds(deadline, process.hrtime.bigint()) / 1000000n))
  function execute() {
    if (!remainingNanoseconds(deadline, process.hrtime.bigint())) { fail(); return }
    const value = configured; configured = undefined
    let child
    gate = createResultGate({ sendResult: (final) => {
      if (failed || resultSent) return
      resultSent = true
      send("RESULT", { resultB64: Buffer.from(JSON.stringify(final), "ascii").toString("base64") })
      writer.finish()
    }, inputTracker: null })
    try {
      child = spawn(value.executable, value.args, { cwd: value.cwd, env: value.env, windowsHide: true,
        stdio: [value.stdin === null ? "ignore" : "pipe", "inherit", "inherit"] })
    } catch (error) {
      gate.inputSettled({ state: value.stdin === null ? "complete" : "failed", expectedBytes: value.stdin?.length ?? 0, submittedBytes: 0, errorCode: value.stdin === null ? null : "SPAWN_FAILED" })
      gate.commandClosed({ spawnError: error }); return
    }
    tracker = createFinalInputTracker({ stream: child.stdin, expectedBytes: value.stdin?.length ?? 0, deadline,
      onSettled: (final) => gate.inputSettled(final) })
    child.on("error", (error) => { spawnError = error })
    child.once("exit", () => tracker.onCommandExit())
    child.once("close", (code, signal) => { tracker.onCommandExit(); gate.commandClosed({ code, signal, spawnError }) })
    if (child.stdin) {
      child.stdin.write(value.stdin, (error) => tracker.recordSubmitted(value.stdin.length, error))
      child.stdin.end()
    }
  }
  const decoder = createFrameDecoder({ role: "owner", binding, phase: "hello" })
  socket.once("connect", () => { try { writer.send(state.hello()) } catch { fail() } })
  socket.on("data", (bytes) => {
    try {
      for (const value of decoder.push(bytes)) {
        if (failed || !remainingNanoseconds(deadline, process.hrtime.bigint())) refuse("deadline")
        const action = state.accept(value)
        if (action === "send_ack") send("ACK", { clientNonce })
        else if (action === "read_payload") {
          configured = readPayloadFile(value.path, value.payloadDigest)
          if (!remainingNanoseconds(deadline, process.hrtime.bigint())) refuse("deadline")
          digest = value.payloadDigest; state.configured(); send("CONFIGURED")
        } else if (action === "start") execute()
      }
    } catch { fail() }
  })
  socket.on("error", fail)
  socket.on("end", () => { try { decoder.end(); if (!resultSent) fail() } catch { fail() } })
  socket.on("close", () => { clearTimeout(timer); state.close(); if (!resultSent) fail() })
}

module.exports = { encodeFrame, createFrameDecoder, createFrameWriter, createPreparationBinding, createRootState,
  parsePayloadBytes, encodePayload, normalizeResult, createFinalInputTracker, createResultGate,
  validateCertificate, normalizeOutputLimit, captureDeadline, remainingNanoseconds, mirrorWindowsHrtime, decodeResult, parseJSON }
if (require.main === module) {
  try { runRoot() } catch { process.exitCode = 1 }
}
