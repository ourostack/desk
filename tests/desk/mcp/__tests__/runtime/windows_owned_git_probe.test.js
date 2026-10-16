import test from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"

// Disposable Task 1 transport only; no production modules (including SQLite).
const frame = (value) => {
  const body = Buffer.from(JSON.stringify(value))
  if (body.length > 16380) throw new Error("encoded frame exceeds 16384 bytes")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length)
  return Buffer.concat([header, body])
}
const decoder = (role) => {
  let pending = Buffer.alloc(0)
  return { push(chunk) {
    pending = Buffer.concat([pending, chunk])
    const values = []
    while (pending.length >= 4) {
      const n = pending.readUInt32LE()
      if (n > 16380) throw new Error("encoded frame exceeds 16384 bytes")
      if (pending.length < n + 4) break
      const value = JSON.parse(pending.subarray(4, n + 4).toString("utf8"))
      if (role && value.role !== role) throw new Error("wrong channel role")
      values.push(value)
      pending = pending.subarray(n + 4)
    }
    return values
  } }
}

export function classifyObservation(expected, returned, error) {
  if (expected === "SAME" && returned === true) return "SAME"
  if (expected === "DIFFERENT" && returned === false && error === 1656) return "DIFFERENT"
  return "UNKNOWN"
}
export function observationOptions(filename, resolve = path.resolve) {
  if (filename.includes('"')) throw new Error("literal quote refused")
  return '--require "' + resolve(filename).replaceAll("\\", "/") + '"'
}
test("calibration portable classifier never treats unknown as absence", () => {
  assert.equal(classifyObservation("SAME", true, 50), "SAME")
  assert.equal(classifyObservation("DIFFERENT", false, 1656), "DIFFERENT")
  for (const [expected, returned, error] of [
    ["SAME", false, 50], ["DIFFERENT", false, 50], ["DIFFERENT", false, 0],
    ["SAME", false, 1656], ["DIFFERENT", true, 0], ["MODEL", false, 6],
  ]) assert.equal(classifyObservation(expected, returned, error), "UNKNOWN")
})

// NC1 constructed-channel portable contracts; old transport definitions remain frozen.
const portableBinding = {
  protocol: "desk.owned-git-channel-probe/1",
  generation: "1".repeat(64), preparationDigest: "2".repeat(64), payloadDigest: "",
}
const portableNonce = "3".repeat(64), portableCapability = "4".repeat(64)
const channelPortable = () => channelCore({ createHash, timingSafeEqual: portableTimingSafeEqual })
import { timingSafeEqual as portableTimingSafeEqual } from "node:crypto"

test("channel portable fragmented/coalesced frames retain one bounded parser", () => {
  const core = channelPortable(), values = []
  assert.equal(typeof core.parser, "function")
  const parse = core.parser((value) => values.push(value))
  const bytes = Buffer.concat([frame({ type: "HELLO" }), frame({ type: "ACK" })])
  for (const byte of bytes) parse.push(Buffer.from([byte]))
  parse.end()
  assert.deepEqual(values, [{ type: "HELLO" }, { type: "ACK" }])
  assert.ok(parse.highWater() <= 16384)
})
test("channel portable body16381 and invalid UTF8/NUL/partial EOF refuse", () => {
  const core = channelPortable()
  assert.equal(typeof core.parser, "function")
  for (const body of [Buffer.from([0xff]), Buffer.from([0]), Buffer.from('{"a":1,"a":2}')]) {
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length)
    assert.throws(() => core.parser(() => {}).push(Buffer.concat([head, body])))
  }
  const large = Buffer.alloc(4); large.writeUInt32LE(16381)
  assert.throws(() => core.parser(() => {}).push(large), /frame/)
  const partial = core.parser(() => {}); partial.push(Buffer.from([1]))
  assert.throws(() => partial.end(), /partial/)
})
test("channel portable AUTH generation nonce capability and role mismatch refuse", () => {
  const core = channelPortable()
  assert.equal(typeof core.rootState, "function")
  for (const patch of [
    { generation: "5".repeat(64) }, { preparationDigest: "5".repeat(64) },
    { nonce: "5".repeat(64) }, { capability: "5".repeat(64) },
    { capability: "short" }, { type: "START" }, { type: "ACK" },
  ]) {
    const root = core.rootState(portableBinding, portableNonce, portableCapability)
    assert.throws(() => root.accept({ ...portableBinding, type: "AUTH",
      nonce: portableNonce, capability: portableCapability, ...patch }))
    assert.equal(root.phase(), "FAILED")
  }
})
test("channel portable no START before authenticated CONFIG and no replay", () => {
  const core = channelPortable()
  assert.equal(typeof core.rootState, "function")
  const message = (type, extra = {}) => ({ ...portableBinding, type, ...extra })
  for (const types of [["START"], ["CONFIG"], ["AUTH", "START"], ["AUTH", "AUTH"]]) {
    const root = core.rootState(portableBinding, portableNonce, portableCapability)
    for (let i = 0; i < types.length; i++) {
      const m = message(types[i], { nonce: portableNonce, capability: portableCapability })
      if (i === types.length - 1) assert.throws(() => root.accept(m))
      else root.accept(m)
    }
  }
  const root = core.rootState(portableBinding, portableNonce, portableCapability)
  root.accept(message("AUTH", { nonce: portableNonce, capability: portableCapability }))
  const digest = "6".repeat(64)
  root.accept(message("CONFIG", { payloadDigest: digest, path: "payload.json" }))
  assert.equal(root.accept(message("START", { payloadDigest: digest })), "START")
  assert.throws(() => root.accept(message("START", { payloadDigest: digest })))
})
test("channel portable result requires actual frame-boundary EOF before SEAL", () => {
  const core = channelPortable()
  assert.equal(typeof core.resultBoundary, "function")
  const boundary = core.resultBoundary()
  assert.throws(() => boundary.seal(), /EOF/)
  boundary.result()
  assert.throws(() => boundary.seal(), /EOF/)
  boundary.eof(0)
  assert.equal(boundary.seal(), true)
  for (const trailing of ["partial", "extra", "early"]) {
    const b = core.resultBoundary()
    if (trailing !== "early") b.result()
    assert.throws(() => trailing === "extra" ? b.result() : b.eof(trailing === "partial" ? 1 : 0))
  }
})
test("channel portable full outbound queue refuses without leaking queued AUTH", () => {
  const core = channelPortable(), completions = [], events = []
  assert.equal(typeof core.writer, "function")
  const writer = core.writer({ write: (_bytes, callback) => completions.push(callback),
    end: () => events.push({ type: "END" }) })
  writer.send({ ...portableBinding, type: "AUTH", capability: portableCapability, nonce: portableNonce })
  writer.send({ ...portableBinding, type: "ACK" })
  assert.throws(() => writer.send({ type: "OVERFLOW" }), /queue/)
  const receipt = writer.diagnostic()
  assert.equal(receipt.frames, 2)
  assert.ok(receipt.bytes <= 32768)
  assert.doesNotMatch(JSON.stringify(receipt), new RegExp(portableCapability + "|" + portableNonce + "|AUTH"))
  completions.shift()(); completions.shift()()
  assert.equal(writer.diagnostic().frames, 0)
})
test("channel portable close is terminal and has no reconnect or late writes", () => {
  const core = channelPortable()
  assert.equal(typeof core.rootState, "function")
  const root = core.rootState(portableBinding, portableNonce, portableCapability)
  root.close()
  assert.equal(root.phase(), "CLOSED")
  assert.throws(() => root.accept({ ...portableBinding, type: "AUTH",
    nonce: portableNonce, capability: portableCapability }))
})
test("channel portable downstream preserves original NODE_OPTIONS but strips authority", () => {
  const core = channelPortable()
  assert.equal(typeof core.downstreamEnvironment, "function")
  assert.deepEqual(core.downstreamEnvironment({
    NODE_OPTIONS: "--require public-preload.cjs", NODE_PATH: "public",
    Path: "original", DESK_CHANNEL_CAPABILITY: portableCapability,
    desk_channel_endpoint: "not-for-git", NODE_CHANNEL_FD: "3", NODE_CHANNEL_SERIALIZATION_MODE: "json",
  }), { NODE_OPTIONS: "--require public-preload.cjs", NODE_PATH: "public", Path: "original" })
})
test("channel portable fragmented outbound frame retains its slot through both completions", () => {
  const core = channelPortable(), chunks = [], callbacks = []
  let ended = false
  const out = core.writer({ write: (bytes, callback) => { chunks.push(bytes.toString("hex")); callbacks.push(callback) },
    end: () => { ended = true } }, () => {}, 2)
  out.send({ a: 1 }); out.finish()
  assert.deepEqual(chunks, ["0700"])
  assert.equal(out.diagnostic().frames, 1); assert.equal(ended, false)
  callbacks.shift()()
  assert.deepEqual(chunks, ["0700", "00007b2261223a317d"])
  assert.equal(out.diagnostic().frames, 1)
  callbacks.shift()()
  assert.equal(out.diagnostic().frames, 0); assert.equal(ended, true)
})
test("channel portable environment refuses NUL before reserved-name filtering", () => {
  assert.throws(() => channelPortable().downstreamEnvironment({ DESK_CHANNEL_CAPABILITY: "bad\0value" }), /environment/)
})
test("channel portable environment preserves legal prototype-named original variables", () => {
  const env = channelPortable().downstreamEnvironment(JSON.parse('{"__proto__":"original","constructor":"supported"}'))
  assert.equal(Object.hasOwn(env, "__proto__"), true)
  assert.equal(env.__proto__, "original"); assert.equal(env.constructor, "supported")
})
test("channel portable reviewed-source gate refuses changed or missing fixed material", () => {
  assert.equal(assertChannelCandidateSources(), true)
  assert.throws(() => assertChannelCandidateSources({
    ...channelProbeMaterial, "probe-shim.cjs": channelProbeMaterial["probe-shim.cjs"] + "\n",
  }), /source mismatch/)
  const missing = { ...channelProbeMaterial }; delete missing["probe-owner.c"]
  assert.throws(() => assertChannelCandidateSources(missing), /source mismatch/)
})
test("channel portable stderr tail keeps exactly the last65536 bytes of an oversized chunk", () => {
  const core = channelPortable()
  assert.equal(typeof core.tail, "function")
  const bytes = Buffer.alloc(70000, 97); bytes.write("END", 69997)
  const value = core.tail(Buffer.from("old"), bytes)
  assert.equal(value.length, 65536); assert.equal(value[0], 97)
  assert.equal(value.subarray(-3).toString(), "END"); assert.equal(value.includes(Buffer.from("old")), false)
  assert.equal(core.tail(Buffer.from("abc"), Buffer.from("def")).toString(), "abcdef")
})
test("channel portable ROOT fault bytes remain bounded and force real parser refusal", () => {
  const core = channelPortable()
  for (const [kind, hex] of [["partial-header", "0800"], ["partial-body", "080000007b"],
    ["trailing-byte", "ff"], ["malformed", "010000007b"], ["oversized", "fd3f0000"]]) {
    const bytes = [], callbacks = []
    const out = core.writer({ write: (b, cb) => { bytes.push(Buffer.from(b)); callbacks.push(cb) }, end: () => {} })
    assert.equal(typeof out.fault, "function")
    out.fault(kind)
    assert.equal(Buffer.concat(bytes).toString("hex"), hex)
    assert.equal(out.diagnostic().frames, 1)
    out.send({ type: "bounded-second" })
    assert.throws(() => out.fault(kind), /queue/)
    const parse = core.parser(() => {})
    assert.throws(() => { parse.push(bytes[0]); parse.end() })
    callbacks.shift()(); callbacks.shift()()
    assert.equal(out.diagnostic().frames, 0)
  }
})
test("channel portable private evidence gate rejects foreign or incomplete native preparation", () => {
  const core = channelPortable()
  assert.equal(typeof core.artifactGate, "function")
  const gate = core.artifactGate(portableBinding)
  assert.throws(() => gate.requireReady(), /private/)
  for (const patch of [{ generation: "0".repeat(64) }, { privateRootProtected: false },
    { payloadPlaceholderProtected: false }, { stage: "ready" }]) {
    assert.equal(gate.observe({ ...portableBinding, role: "owner", stage: "private-root-protected",
      privateRootProtected: true, payloadPlaceholderProtected: true, ...patch }), false)
    assert.throws(() => gate.requireReady(), /private/)
  }
  assert.equal(gate.observe({ ...portableBinding, role: "owner", stage: "private-root-protected",
    privateRootProtected: true, payloadPlaceholderProtected: true }), true)
  gate.requireReady()
})
test("channel portable launch writer cannot create files or write before native protection", () => {
  const core = channelPortable()
  assert.equal(typeof core.preparedFileWrite, "function")
  const files = new Map([["reserved", Buffer.alloc(0)]])
  let open = false
  const io = {
    openSync(name, flags) { assert.equal(flags, "r+"); if (!files.has(name)) throw Error("ENOENT"); open = name; return 1 },
    fstatSync() { return { isFile: () => true, size: files.get(open).length } },
    writeFileSync(_fd, bytes) { files.set(open, Buffer.from(bytes)) },
    fsyncSync() {}, closeSync() { open = false },
  }
  const gate = core.artifactGate(portableBinding)
  assert.throws(() => core.preparedFileWrite(io, "reserved", Buffer.from("abc"), gate), /private/)
  assert.equal(open, false); assert.equal(files.get("reserved").length, 0)
  gate.observe({ ...portableBinding, role: "owner", stage: "private-root-protected",
    privateRootProtected: true, payloadPlaceholderProtected: true })
  core.preparedFileWrite(io, "reserved", Buffer.from("abc"), gate)
  assert.equal(files.get("reserved").toString(), "abc"); assert.equal(open, false)
  assert.throws(() => core.preparedFileWrite(io, "missing", Buffer.from("abc"), gate), /ENOENT/)
  assert.equal(files.has("missing"), false)
})

function channelCore({ timingSafeEqual }) {
  const protocol = "desk.owned-git-channel-probe/1"
  const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
  function encode(value) {
    const body = Buffer.from(JSON.stringify(value))
    if (!body.length || body.length > 16380) throw Error("frame bound")
    const head = Buffer.alloc(4); head.writeUInt32LE(body.length)
    return Buffer.concat([head, body])
  }
  function parser(accept) {
    const buffer = Buffer.alloc(16384)
    let used = 0, target = 4, high = 0, ended = false
    return {
      push(chunk) {
        if (ended) throw Error("closed parser")
        let at = 0
        while (at < chunk.length) {
          const n = Math.min(target - used, chunk.length - at)
          chunk.copy(buffer, used, at, at + n); at += n; used += n; high = Math.max(high, used)
          if (used !== target) continue
          if (target === 4) {
            const size = buffer.readUInt32LE()
            if (!size || size > 16380) throw Error("frame bound")
            target = 4 + size
          } else {
            const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(4, target))
            if (text.includes("\0")) throw Error("NUL frame")
            const value = JSON.parse(text)
            if (!value || Array.isArray(value) || typeof value !== "object" || JSON.stringify(value) !== text)
              throw Error("noncanonical frame")
            buffer.fill(0, 0, target); used = 0; target = 4
            accept(value)
          }
        }
      },
      end() { ended = true; if (used) throw Error("partial frame EOF") },
      pending: () => used, highWater: () => high,
    }
  }
  function writer(socket, fail = () => {}, split = 0) {
    const queue = []
    let bytes = 0, offset = 0, busy = false, finishing = false, ended = false
    function pump() {
      if (busy || ended) return
      if (!queue.length) {
        if (finishing) { ended = true; socket.end(() => socket.destroy?.()) }
        return
      }
      busy = true
      const end = split && offset === 0 ? Math.min(split, queue[0].length) : queue[0].length
      socket.write(queue[0].subarray(offset, end), (error) => {
        busy = false
        if (error) { ended = true; for (const b of queue) b.fill(0); queue.length = 0; bytes = 0; fail("write"); return }
        offset = end
        if (offset === queue[0].length) {
          const done = queue.shift(); bytes -= done.length; done.fill(0); offset = 0
        }
        pump()
      })
    }
    function enqueue(buffer) {
      if (finishing || ended) { buffer.fill(0); throw Error("closed writer") }
      if (queue.length >= 2) { buffer.fill(0); throw Error("outbound queue full") }
      if (bytes + buffer.length > 32768) { buffer.fill(0); throw Error("outbound queue byte bound") }
      queue.push(buffer); bytes += buffer.length; pump()
    }
    function available() {
      if (finishing || ended) throw Error("closed writer")
      if (queue.length >= 2) throw Error("outbound queue full")
    }
    return {
      send(value) { available(); enqueue(encode(value)) },
      fault(kind) {
        available()
        const hex = { "partial-header": "0800", "partial-body": "080000007b",
          "trailing-byte": "ff", malformed: "010000007b", oversized: "fd3f0000" }[kind]
        if (!hex) throw Error("unknown diagnostic wire fault")
        enqueue(Buffer.from(hex, "hex"))
      },
      finish() { if (finishing || ended) throw Error("closed writer"); finishing = true; pump() },
      diagnostic: () => ({ frames: queue.length, bytes, busy, finishing, ended }),
    }
  }
  function rootState(binding, nonce, capability) {
    if (binding.protocol !== protocol || !hex(binding.generation) ||
        !hex(binding.preparationDigest) || binding.payloadDigest !== "" || !hex(nonce) || !hex(capability))
      throw Error("bootstrap binding")
    let phase = "HELLO", digest = ""
    const secret = Buffer.from(capability, "hex")
    const fail = () => { phase = "FAILED"; secret.fill(0); throw Error("channel state refusal") }
    return {
      accept(value) {
        if (["FAILED", "CLOSED", "STARTED"].includes(phase)) return fail()
        const allowed = ["protocol", "generation", "preparationDigest", "payloadDigest", "type",
          ...(value.type === "AUTH" ? ["nonce", "capability"] : value.type === "CONFIG" ? ["path"] : [])]
        if (Object.keys(value).length !== allowed.length || Object.keys(value).some((key) => !allowed.includes(key)))
          return fail()
        if (value.protocol !== protocol || value.generation !== binding.generation ||
            value.preparationDigest !== binding.preparationDigest) return fail()
        if (phase === "HELLO" && value.type === "AUTH" && value.payloadDigest === "" &&
            value.nonce === nonce && hex(value.capability)) {
          const received = Buffer.from(value.capability, "hex")
          const equal = timingSafeEqual(secret, received)
          secret.fill(0); received.fill(0)
          if (!equal) return fail()
          phase = "AUTHENTICATED"; return "ACK"
        }
        if (phase === "AUTHENTICATED" && value.type === "CONFIG" &&
            hex(value.payloadDigest) && typeof value.path === "string" && value.path && !value.path.includes("\0")) {
          digest = value.payloadDigest; phase = "CONFIGURED"; return "CONFIG"
        }
        if (phase === "CONFIGURED" && value.type === "START" && value.payloadDigest === digest) {
          phase = "STARTED"; return "START"
        }
        return fail()
      },
      close() { secret.fill(0); phase = "CLOSED" },
      phase: () => phase,
    }
  }
  function resultBoundary() {
    let result = false, eof = false
    return {
      result() { if (result || eof) throw Error("extra result"); result = true },
      eof(pending) { if (!result || pending || eof) throw Error("invalid result EOF"); eof = true },
      seal() { if (!result || !eof) throw Error("result requires EOF"); return true },
    }
  }
  function downstreamEnvironment(original) {
    const env = {}
    for (const [key, value] of Object.entries(original)) {
      if (typeof value !== "string" || key.includes("\0") || value.includes("\0")) throw Error("environment bound")
      if (/^DESK_CHANNEL_/i.test(key) || /^NODE_CHANNEL_(FD|SERIALIZATION_MODE)$/i.test(key)) continue
      Object.defineProperty(env, key, { value, enumerable: true, writable: true, configurable: true })
    }
    return env
  }
  function tail(previous, chunk) {
    const latest = chunk.subarray(-65536), take = Math.min(previous.length, 65536 - latest.length)
    return Buffer.concat([previous.subarray(previous.length - take), latest], take + latest.length)
  }
  function artifactGate(binding) {
    let ready = false
    return {
      observe(event) {
        if (event.protocol !== binding.protocol || event.generation !== binding.generation ||
            event.preparationDigest !== binding.preparationDigest || event.role !== "owner" ||
            event.stage !== "private-root-protected" || event.privateRootProtected !== true ||
            event.payloadPlaceholderProtected !== true) return false
        ready = true; return true
      },
      requireReady() { if (!ready) throw Error("private native preparation not confirmed") },
    }
  }
  function preparedFileWrite(io, filename, bytes, gate) {
    gate.requireReady()
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 1048576) throw Error("payload bound")
    const fd = io.openSync(filename, "r+")
    try {
      const stat = io.fstatSync(fd)
      if (!stat.isFile() || stat.size !== 0) throw Error("reserved payload changed")
      io.writeFileSync(fd, bytes); io.fsyncSync(fd)
    } finally { io.closeSync(fd) }
  }
  return { encode, parser, writer, rootState, resultBoundary, downstreamEnvironment, tail,
    artifactGate, preparedFileWrite }
}
test("calibration portable preload options pin exact quoted forward-slash bytes", () => {
  const options = observationOptions('D:\\Probe Public\\observation preload.cjs', path.win32.resolve)
  assert.equal(options, '--require "D:/Probe Public/observation preload.cjs"')
  assert.equal(Buffer.from(options).toString("hex"), "2d2d726571756972652022443a2f50726f6265205075626c69632f6f62736572766174696f6e207072656c6f61642e636a7322")
  assert.throws(() => observationOptions('D:\\Bad"Path\\observation preload.cjs', path.win32.resolve), /quote/)
})

test("fragmented control frames reconstruct without consuming the next frame", () => {
  const bytes = Buffer.concat([frame({ role: "owner" }), frame({ role: "shim" })])
  const parse = decoder()
  assert.deepEqual(parse.push(bytes.subarray(0, 2)), [])
  assert.deepEqual(parse.push(bytes.subarray(2, 7)), [])
  assert.deepEqual(parse.push(bytes.subarray(7)), [{ role: "owner" }, { role: "shim" }])
})

test("encoded bound includes the four-byte header, including refusal of body 16381", () => {
  assert.equal(frame("x".repeat(16378)).length, 16384)
  for (const length of [16381, 16385]) {
    const header = Buffer.alloc(4)
    header.writeUInt32LE(length)
    assert.throws(() => decoder().push(header), /16384/)
  }
})

test("result-channel provenance never accepts a control role", () => {
  assert.throws(() => decoder("shim").push(frame({ role: "owner" })), /role/)
})

test("real shim stays ready without starting a command before explicit start", { timeout: 5000 }, async () => {
  const root = process.platform === "win32"
    ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../../owned-git-probe-output/fixture")
    : "/Users/microsoft/.copilot/session-state/8f8c7288-cd47-4544-8dcf-0ad9bbadfeb5/files/owned-git-probe/fixture"
  fs.mkdirSync(root, { recursive: true })
  const source = path.join(root, "probe-shim.cjs")
  const marker = path.join(root, "ready-" + process.pid + "-" + Date.now())
  fs.writeFileSync(source, shimSource)
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith("NODE_")) delete env[key]
  const child = spawn(process.execPath, [source, "shim", "fixture", marker], {
    cwd: root, env, stdio: ["pipe", "pipe", "pipe", "pipe"],
  })
  const closed = new Promise((resolve) => child.on("close", resolve))
  child.stdio[3].on("error", () => {})
  let output = ""
  child.stdout.on("data", (chunk) => { output += chunk })
  child.stderr.on("data", (chunk) => { output += chunk })
  try {
    await new Promise((resolve, reject) => {
      const parse = decoder("shim")
      const timer = setTimeout(() => reject(new Error("shim ready deadline: " + output)), 2000)
      child.on("error", (error) => { clearTimeout(timer); reject(error) })
      child.stdio[3].on("data", (chunk) => {
        try {
          if (parse.push(chunk).some((value) => value.stage === "ready")) { clearTimeout(timer); resolve() }
        } catch (error) { clearTimeout(timer); reject(error) }
      })
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(fs.existsSync(marker), true)
    assert.equal(fs.existsSync(marker + ".command"), false)
    assert.equal(fs.existsSync(marker + ".survivors"), false)
    assert.equal(output, "")
  } finally {
    child.stdin.end()
    child.kill()
    await closed
  }
})

const ownerSource = String.raw`
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <io.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <stdarg.h>
#include <wchar.h>
#include <string.h>

/* Task 1 disposable probe: private job authority never travels over stdout. */
static HANDLE control = INVALID_HANDLE_VALUE;
typedef BOOL (WINAPI *COMPARE_OBJECT_HANDLES_FN)(HANDLE, HANDLE);
static COMPARE_OBJECT_HANDLES_FN comparison_api = NULL;
static int binding_stop(const char *stage, DWORD error) {
  fprintf(stderr, "BINDING STOP api=CompareObjectHandles stage=%s error=%lu\n", stage, error);
  return 0;
}
static int initialize_comparison_api(void) {
  wchar_t expected[32768], actual[32768], export_path[32768];
  HMODULE module = NULL, export_module = NULL;
  FARPROC address; LPCWSTR export_address = NULL; uintptr_t address_bits = 0;
  UINT length; DWORD found_length, error; BOOL found;
  length = GetSystemDirectoryW(expected, 32768);
  if (!length || length >= 32768) return binding_stop("system-directory", GetLastError());
  if (wcscat_s(expected, 32768, L"\\KernelBase.dll") != 0) return binding_stop("system-path-bound", ERROR_INSUFFICIENT_BUFFER);
  SetLastError(0);
  found = GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN, expected, &module);
  error = GetLastError();
  fprintf(stderr, "BINDING module expected=%ls loadedOnly=true pinned=%s found=%s error=%lu\n",
    expected, found ? "true" : "false", found ? "true" : "false", error);
  if (!found) return binding_stop("loaded-system-module", error);
  SetLastError(0);
  found_length = GetModuleFileNameW(module, actual, 32768);
  if (!found_length || found_length >= 32768) return binding_stop("module-path", GetLastError());
  fprintf(stderr, "BINDING module actual=%ls handle=%llu\n", actual, (unsigned long long)(uintptr_t)module);
  if (_wcsicmp(expected, actual) != 0) return binding_stop("module-provenance", ERROR_BAD_PATHNAME);
  SetLastError(0);
  address = GetProcAddress(module, "CompareObjectHandles"); error = GetLastError();
  _Static_assert(sizeof(address_bits) == sizeof(address), "Windows x64 export address width");
  memcpy(&address_bits, &address, sizeof(address_bits));
  fprintf(stderr, "BINDING export name=CompareObjectHandles resolved=%s address=0x%llx error=%lu\n",
    address ? "true" : "false", (unsigned long long)address_bits, error);
  if (!address) return binding_stop("export", error);
  _Static_assert(sizeof(export_address) == sizeof(address), "Windows module-address ABI width");
  memcpy(&export_address, &address, sizeof(export_address));
  SetLastError(0);
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
      export_address, &export_module)) return binding_stop("export-module-pin", GetLastError());
  found_length = GetModuleFileNameW(export_module, export_path, 32768);
  if (!found_length || found_length >= 32768) return binding_stop("export-module-path", GetLastError());
  fprintf(stderr, "BINDING export actualModule=%ls handle=%llu pinned=true\n", export_path, (unsigned long long)(uintptr_t)export_module);
  if (_wcsicmp(expected, export_path) != 0) return binding_stop("export-provenance", ERROR_BAD_PATHNAME);
  _Static_assert(sizeof(comparison_api) == sizeof(address), "Windows same-API function-pointer ABI width");
  memcpy(&comparison_api, &address, sizeof(comparison_api));
  if (!comparison_api) return binding_stop("typed-pointer", ERROR_PROC_NOT_FOUND);
  fprintf(stderr, "BINDING READY api=CompareObjectHandles abi=BOOL-WINAPI-HANDLE-HANDLE provenance=system-module-and-export lifetime=process-pinned\n");
  return 1;
}
static BOOL checked_compare_objects(HANDLE left, HANDLE right) {
  if (!comparison_api) {
    (void)binding_stop("uninitialized-call", ERROR_PROC_NOT_FOUND);
    ExitProcess(96);
  }
  return comparison_api(left, right);
}
static int wire(HANDLE h, const char *text) {
  DWORD done = 0, size = (DWORD)strlen(text);
  if (size > 16380) return 0;
  if (!WriteFile(h, &size, 4, &done, NULL) || done != 4) return 0;
  return WriteFile(h, text, size, &done, NULL) && done == size;
}
static int emit(const char *format, ...) {
  char text[16381]; int n; va_list args;
  va_start(args, format); n = vsnprintf(text, sizeof(text), format, args); va_end(args);
  if (n < 0 || n > 16380) return 0;
  return wire(control, text);
}
static int exact(HANDLE h, void *buffer, DWORD count, ULONGLONG deadline) {
  DWORD available = 0, done = 0, n;
  while (done < count && GetTickCount64() < deadline) {
    if (!PeekNamedPipe(h, NULL, 0, NULL, &available, NULL)) return -1;
    if (!available) { Sleep(2); continue; }
    n = count - done; if (n > available) n = available;
    if (!ReadFile(h, (char *)buffer + done, n, &n, NULL) || !n) return -1;
    done += n;
  }
  return done == count ? 1 : 0;
}
static int receive(HANDLE h, char *text) {
  DWORD size = 0; int rc; ULONGLONG end = GetTickCount64() + 2000;
  rc = exact(h, &size, 4, end); if (rc != 1) return rc;
  if (size > 16380) { SetLastError(ERROR_BUFFER_OVERFLOW); return -1; }
  rc = exact(h, text, size, end); if (rc == 1) text[size] = 0;
  return rc;
}
static int command(const char *cmd) {
  char text[16381], expected[80];
  snprintf(expected, sizeof(expected), "\"cmd\":\"%s\"", cmd);
  return receive(control, text) == 1 && strstr(text, expected) != NULL;
}
static DWORD active(HANDLE job, BOOL *ok) {
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  *ok = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL);
  return *ok ? accounting.ActiveProcesses : MAXDWORD;
}
typedef struct { DWORD assigned; DWORD count; ULONG_PTR pids[64]; } CENSUS;
static int census(HANDLE job, CENSUS *list) {
  ZeroMemory(list, sizeof(*list));
  return QueryInformationJobObject(job, JobObjectBasicProcessIdList, list, sizeof(*list), NULL) && list->count <= 64;
}
static int members(HANDLE job) {
  CENSUS list; char text[4096]; size_t used; DWORD i; int n;
  if (!census(job, &list)) return 0;
  n = snprintf(text, sizeof(text), "{\"role\":\"owner\",\"stage\":\"job-members\",\"pids\":[");
  if (n < 0) return 0; used = (size_t)n;
  for (i = 0; i < list.count; i++) {
    n = snprintf(text + used, sizeof(text) - used, "%s%llu", i ? "," : "", (unsigned long long)list.pids[i]);
    if (n < 0 || (size_t)n >= sizeof(text) - used) return 0; used += (size_t)n;
  }
  if (used + 3 >= sizeof(text)) return 0;
  memcpy(text + used, "]}", 3); return wire(control, text);
}
static int standard_token(void) {
  HANDLE token = NULL; TOKEN_ELEVATION elevation; DWORD size; BOOL admin = TRUE;
  SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY; PSID sid = NULL; int good = 0;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return 0;
  if (GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size) &&
      AllocateAndInitializeSid(&nt, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0,0,0,0,0,0, &sid) &&
      CheckTokenMembership(NULL, sid, &admin)) good = !admin && !elevation.TokenIsElevated;
  if (sid) FreeSid(sid); CloseHandle(token); return good;
}
static int zero(HANDLE job) {
  ULONGLONG end = GetTickCount64() + 2000; BOOL ok;
  do { DWORD n = active(job, &ok); if (!ok) return 0; if (!n) return 1; Sleep(5); } while (GetTickCount64() < end);
  return 0;
}
static HANDLE newjob(void) {
  HANDLE job = CreateJobObjectW(NULL, NULL);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    if (job) CloseHandle(job); return NULL;
  }
  return job;
}
static HANDLE inherited(HANDLE source) {
  HANDLE copy = NULL;
  if (!DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &copy, 0, TRUE, DUPLICATE_SAME_ACCESS)) return NULL;
  return copy;
}
static int launch(wchar_t *line, HANDLE *handles, DWORD count, PROCESS_INFORMATION *pi, LPWCH environment) {
  STARTUPINFOEXW si; SIZE_T bytes = 0;
  unsigned char crt[4 + 4 + 4 * sizeof(intptr_t)];
  int n = (int)count; DWORD i; int rc;
  ZeroMemory(&si, sizeof(si)); si.StartupInfo.cb = sizeof(si);
  InitializeProcThreadAttributeList(NULL, 1, 0, &bytes);
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes);
  if (!si.lpAttributeList) return 0;
  if (!InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes)) { HeapFree(GetProcessHeap(), 0, si.lpAttributeList); return 0; }
  rc = UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST,
    handles, count * sizeof(HANDLE), NULL, NULL);
  ZeroMemory(crt, sizeof(crt)); memcpy(crt, &n, 4);
  for (i = 0; i < count; i++) {
    intptr_t value = (intptr_t)handles[i];
    crt[4 + i] = 1 | 8;
    memcpy(crt + 4 + count + i * sizeof(intptr_t), &value, sizeof(value));
  }
  si.StartupInfo.cbReserved2 = (WORD)(4 + count + count * sizeof(intptr_t));
  si.StartupInfo.lpReserved2 = crt;
  si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = handles[0]; si.StartupInfo.hStdOutput = handles[1]; si.StartupInfo.hStdError = handles[2];
  if (rc) rc = CreateProcessW(NULL, line, NULL, NULL, TRUE,
    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
    environment, NULL, &si.StartupInfo, pi);
  DeleteProcThreadAttributeList(si.lpAttributeList); HeapFree(GetProcessHeap(), 0, si.lpAttributeList);
  return rc;
}
static LPWCH cleanenv(void) {
  LPWCH original = GetEnvironmentStringsW(), p, clean, out;
  size_t capacity = 2, length;
  if (!original) return NULL;
  for (p = original; *p; p += wcslen(p) + 1) capacity += wcslen(p) + 1;
  clean = (LPWCH)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, capacity * sizeof(wchar_t));
  if (!clean) { FreeEnvironmentStringsW(original); return NULL; }
  out = clean;
  for (p = original; *p; p += length) {
    length = wcslen(p) + 1;
    if (_wcsnicmp(p, L"NODE_", 5) != 0) { memcpy(out, p, length * sizeof(wchar_t)); out += length; }
  }
  *out = 0; FreeEnvironmentStringsW(original); return clean;
}
static void receipt(const wchar_t *name, const char *stage, int sealed, int drained, DWORD error) {
  FILE *f = NULL;
  if (_wfopen_s(&f, name, L"wb") == 0 && f) {
    fprintf(f, "{\"stage\":\"%s\",\"sealed\":%s,\"exactJobZero\":%s,\"error\":%lu}\n",
      stage, sealed ? "true" : "false", drained ? "true" : "false", error);
    fclose(f);
  }
}
typedef struct { HANDLE from; HANDLE to; } PUMP;
static DWORD WINAPI pump(LPVOID parameter) {
  PUMP *p = (PUMP *)parameter; char buffer[4096]; DWORD n, written;
  while (ReadFile(p->from, buffer, sizeof(buffer), &n, NULL) && n) {
    if (!WriteFile(p->to, buffer, n, &written, NULL) || written != n) break;
  }
  CloseHandle(p->to); p->to = NULL; return 0;
}
static int audit(DWORD pid, HANDLE job, HANDLE *sensitive, DWORD count) {
  /* OpenProcess is ONLY a peer handle-inheritance measurement, never a drain/ownership receipt. */
  HANDLE process = OpenProcess(PROCESS_DUP_HANDLE | PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  BOOL member = FALSE; DWORD i; int good = 1;
  if (!process || !IsProcessInJob(process, job, &member) || !member) { if (process) CloseHandle(process); return 0; }
  for (i = 0; i < count; i++) {
    HANDLE candidate = NULL; BOOL same = FALSE; DWORD error;
    SetLastError(0);
    if (DuplicateHandle(process, sensitive[i], GetCurrentProcess(), &candidate, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
      same = checked_compare_objects(sensitive[i], candidate); CloseHandle(candidate);
    }
    error = GetLastError();
    emit("{\"role\":\"owner\",\"stage\":\"peer-handle\",\"index\":%lu,\"sameObject\":%s,\"error\":%lu}", i, same ? "true" : "false", error);
    if (same) good = 0;
  }
  CloseHandle(process); return good;
}
static int supervise(int argc, wchar_t **argv) {
  HANDLE job = NULL, handles[3] = {NULL,NULL,NULL};
  PROCESS_INFORMATION pi; wchar_t line[32768]; DWORD i, code = 1, before = MAXDWORD; BOOL ok = FALSE;
  int rc = 1, assigned = 0, drained = 0;
  CENSUS list; ZeroMemory(&list, sizeof(list));
  ZeroMemory(&pi, sizeof(pi));
  if (argc != 6) return 91;
  job = newjob(); if (!job) goto done;
  for (i = 0; i < 3; i++) { handles[i] = inherited(GetStdHandle(i == 0 ? STD_INPUT_HANDLE : i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE)); if (!handles[i]) goto done; }
  if (swprintf_s(line, 32768, L"\"%s\" \"%s\" \"%s\"", argv[2], argv[3], argv[4]) < 0) goto done;
  if (!launch(line, handles, 3, &pi, NULL)) goto done;
  if (!AssignProcessToJobObject(job, pi.hProcess)) goto done;
  assigned = 1; if (ResumeThread(pi.hThread) == MAXDWORD) goto done;
  if (WaitForSingleObject(pi.hProcess, 120000) != WAIT_OBJECT_0) goto done;
  if (!GetExitCodeProcess(pi.hProcess, &code)) goto done;
  before = active(job, &ok); if (!ok) goto done;
  rc = (int)code;
done:
  if (job && !census(job, &list)) rc = 95;
  if (pi.hProcess && !assigned) { TerminateProcess(pi.hProcess, 92); WaitForSingleObject(pi.hProcess, 2000); }
  if (job) {
    BOOL sealed = TerminateJobObject(job, 93);
    drained = sealed && zero(job);
    FILE *f = NULL;
    if (_wfopen_s(&f, argv[5], L"wb") == 0 && f) {
      fprintf(f, "{\"stage\":\"broader-test-owner\",\"sealed\":%s,\"exactJobZero\":%s,\"retiredPids\":[", sealed ? "true" : "false", drained ? "true" : "false");
      for (i = 0; i < list.count; i++) fprintf(f, "%s%llu", i ? "," : "", (unsigned long long)list.pids[i]);
      fprintf(f, "],\"activeBefore\":%lu,\"workerCode\":%lu}\n", before, code); fclose(f);
    }
    fprintf(stderr, "broader-test-owner final active-before=%lu exact-job-zero=%d\n", before, drained);
    CloseHandle(job);
  }
  if (pi.hThread) CloseHandle(pi.hThread); if (pi.hProcess) CloseHandle(pi.hProcess);
  for (i = 0; i < 3; i++) if (handles[i]) CloseHandle(handles[i]);
  return drained ? rc : 94;
}

/* Separate pairwise calibration/positive-observation paths; never call audit(). */
typedef struct { HANDLE handle; char name[80]; } CAL_OWNED;
typedef struct {
  FILE *log; CAL_OWNED owned[64]; DWORD count, closed, sequence, compared, models;
  int failed, log_failed, wire_failed, sealed, drained;
} CAL_STATE;
static void cal_record(CAL_STATE *s, const char *text) {
  if (fprintf(s->log, "%s\n", text) < 0 || fflush(s->log) != 0) s->log_failed = 1;
  if (!wire(control, text)) s->wire_failed = 1;
}
static void cal_api(CAL_STATE *s, const char *api, const char *name, BOOL ok, DWORD error, HANDLE handle, unsigned long long value) {
  char text[1024];
  snprintf(text, sizeof(text), "{\"role\":\"owner\",\"stage\":\"cal-api\",\"seq\":%lu,\"api\":\"%s\",\"resource\":\"%s\",\"ok\":%s,\"error\":%lu,\"handle\":%llu,\"value\":%llu,\"successErrorIsStale\":true}",
    ++s->sequence, api, name, ok ? "true" : "false", error, (unsigned long long)(uintptr_t)handle, value);
  cal_record(s, text);
}
static int cal_adopt(CAL_STATE *s, HANDLE h, const char *name) {
  DWORD index = s->count++;
  if (index >= 64) { fprintf(stderr, "STOP calibration owned registry bound\n"); ExitProcess(97); }
  s->owned[index].handle = h;
  snprintf(s->owned[index].name, sizeof(s->owned[index].name), "%s", name);
  return (int)index;
}
static int cal_close_index(CAL_STATE *s, DWORD index) {
  BOOL ok; DWORD error;
  SetLastError(0); ok = CloseHandle(s->owned[index].handle); error = GetLastError();
  cal_api(s, "CloseHandle", s->owned[index].name, ok, error, s->owned[index].handle, 0);
  if (!ok) { s->failed = 1; return 0; }
  s->owned[index].handle = NULL; s->closed++; return 1;
}
static int cal_close_handle(CAL_STATE *s, HANDLE h) {
  DWORD i;
  for (i = 0; i < s->count; i++) if (s->owned[i].handle == h) return cal_close_index(s, i);
  fprintf(stderr, "STOP attempted close of unowned calibration handle\n"); s->failed = 1; return 0;
}
static int cal_flags(CAL_STATE *s, HANDLE h, const char *name, int clear) {
  DWORD before = 0, after = 0, error; BOOL ok;
  SetLastError(0); ok = GetHandleInformation(h, &before); error = GetLastError();
  cal_api(s, "GetHandleInformation-before", name, ok, error, h, before); if (!ok) return 0;
  if (!clear) return 1;
  SetLastError(0); ok = SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0); error = GetLastError();
  cal_api(s, "SetHandleInformation-clear", name, ok, error, h, 0); if (!ok) return 0;
  SetLastError(0); ok = GetHandleInformation(h, &after); error = GetLastError();
  cal_api(s, "GetHandleInformation-after-fresh", name, ok, error, h, after);
  return ok && !(after & HANDLE_FLAG_INHERIT);
}
static int cal_dup(CAL_STATE *s, HANDLE source, HANDLE *target, const char *name, BOOL inherit) {
  BOOL ok; DWORD error;
  SetLastError(0); ok = DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), target, 0, inherit, DUPLICATE_SAME_ACCESS); error = GetLastError();
  cal_api(s, "DuplicateHandle", name, ok, error, source, (unsigned long long)(uintptr_t)*target);
  if (ok) cal_adopt(s, *target, name);
  return ok;
}
static int cal_pipe(CAL_STATE *s, HANDLE *read_end, HANDLE *write_end, const char *name, BOOL inherit) {
  SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, inherit}; BOOL ok; DWORD error; char label[80];
  SetLastError(0); ok = CreatePipe(read_end, write_end, &sa, 0); error = GetLastError();
  cal_api(s, "CreatePipe", name, ok, error, *read_end, (unsigned long long)(uintptr_t)*write_end);
  if (!ok) return 0;
  snprintf(label, sizeof(label), "%s-read", name); cal_adopt(s, *read_end, label);
  snprintf(label, sizeof(label), "%s-write", name); cal_adopt(s, *write_end, label); return 1;
}
static int cal_job(CAL_STATE *s, HANDLE *job, const char *name) {
  DWORD error; BOOL ok; JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  SetLastError(0); *job = CreateJobObjectW(NULL, NULL); error = GetLastError();
  cal_api(s, "CreateJobObject-unnamed", name, *job != NULL, error, *job, 0);
  if (!*job) return 0; cal_adopt(s, *job, name);
  ZeroMemory(&limits, sizeof(limits)); limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetLastError(0); ok = SetInformationJobObject(*job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)); error = GetLastError();
  cal_api(s, "SetInformationJobObject-kill-on-close", name, ok, error, *job, 0); return ok;
}
static int cal_token(CAL_STATE *s) {
  HANDLE token = NULL; DWORD error, size; BOOL ok, admin = TRUE; int good = 0;
  TOKEN_ELEVATION elevation; SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY; PSID sid = NULL;
  SetLastError(0); ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token); error = GetLastError();
  cal_api(s, "OpenProcessToken", "preflight-token", ok, error, token, 0); if (!ok) return 0;
  cal_adopt(s, token, "preflight-token");
  SetLastError(0); ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size); error = GetLastError();
  cal_api(s, "GetTokenInformation", "preflight-token", ok, error, token, ok ? elevation.TokenIsElevated : 0);
  if (ok && !elevation.TokenIsElevated) {
    SetLastError(0); ok = AllocateAndInitializeSid(&nt, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS, 0,0,0,0,0,0, &sid); error = GetLastError();
    cal_api(s, "AllocateAndInitializeSid", "admin-sid", ok, error, NULL, 0);
    if (ok) {
      SetLastError(0); ok = CheckTokenMembership(NULL, sid, &admin); error = GetLastError();
      cal_api(s, "CheckTokenMembership", "admin-sid", ok, error, NULL, admin); good = ok && !admin;
    }
  }
  if (sid) {
    PVOID result; SetLastError(0); result = FreeSid(sid); error = GetLastError();
    cal_api(s, "FreeSid", "admin-sid", result == NULL, error, NULL, 0); if (result) good = 0;
  }
  return cal_close_handle(s, token) && good;
}
static int cal_launch(CAL_STATE *s, wchar_t *line, HANDLE *handles, PROCESS_INFORMATION *pi, LPWCH environment) {
  STARTUPINFOEXW si; SIZE_T bytes = 0; unsigned char crt[4 + 4 + 4 * sizeof(intptr_t)];
  int count = 4; DWORD i, error; BOOL ok; int result = 0;
  ZeroMemory(&si, sizeof(si)); si.StartupInfo.cb = sizeof(si);
  SetLastError(0); ok = InitializeProcThreadAttributeList(NULL, 1, 0, &bytes); error = GetLastError();
  cal_api(s, "InitializeAttributeList-size", "root-startup", ok, error, NULL, (unsigned long long)bytes);
  if (ok || error != ERROR_INSUFFICIENT_BUFFER || !bytes) return 0;
  SetLastError(0); si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes); error = GetLastError();
  cal_api(s, "HeapAlloc-attribute-list", "root-startup", si.lpAttributeList != NULL, error, NULL, (unsigned long long)bytes);
  if (!si.lpAttributeList) return 0;
  SetLastError(0); ok = InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes); error = GetLastError();
  cal_api(s, "InitializeAttributeList", "root-startup", ok, error, NULL, 0);
  if (ok) {
    SetLastError(0); ok = UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, 4 * sizeof(HANDLE), NULL, NULL); error = GetLastError();
    cal_api(s, "UpdateAttributeList-handle-allowlist", "root-startup", ok, error, NULL, 4);
    ZeroMemory(crt, sizeof(crt)); memcpy(crt, &count, 4);
    for (i = 0; i < 4; i++) { intptr_t value = (intptr_t)handles[i]; crt[4 + i] = 1 | 8; memcpy(crt + 8 + i * sizeof(intptr_t), &value, sizeof(value)); }
    si.StartupInfo.cbReserved2 = sizeof(crt); si.StartupInfo.lpReserved2 = crt;
    si.StartupInfo.dwFlags = STARTF_USESTDHANDLES; si.StartupInfo.hStdInput = handles[0]; si.StartupInfo.hStdOutput = handles[1]; si.StartupInfo.hStdError = handles[2];
    if (ok) {
      SetLastError(0); ok = CreateProcessW(NULL, line, NULL, NULL, TRUE, CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, environment, NULL, &si.StartupInfo, pi); error = GetLastError();
      cal_api(s, "CreateProcess-suspended", "root-process", ok, error, pi->hProcess, pi->dwProcessId);
      cal_api(s, "CreateProcess-primary-thread-result", "root-thread", ok, error, pi->hThread, pi->dwThreadId);
      if (ok) { cal_adopt(s, pi->hProcess, "root-process"); cal_adopt(s, pi->hThread, "root-thread"); result = 1; }
    }
    DeleteProcThreadAttributeList(si.lpAttributeList);
  }
  SetLastError(0); ok = HeapFree(GetProcessHeap(), 0, si.lpAttributeList); error = GetLastError();
  cal_api(s, "HeapFree-attribute-list", "root-startup", ok, error, NULL, 0); return result && ok;
}
static const char *cal_classify(int expected, BOOL returned, DWORD error) {
  if (expected == 1 && returned) return "SAME";
  if (expected == 2 && !returned && error == ERROR_NOT_SAME_OBJECT) return "DIFFERENT";
  return "UNKNOWN";
}
static int cal_compare(CAL_STATE *s, DWORD index, const char *name, HANDLE left, HANDLE right, int expected, int modeled) {
  BOOL returned; DWORD error; const char *classification; char text[1024];
  SetLastError(0); returned = checked_compare_objects(left, right); error = GetLastError();
  classification = cal_classify(expected, returned, error);
  if (modeled) s->models++; else s->compared++;
  snprintf(text, sizeof(text), "{\"role\":\"owner\",\"stage\":\"cal-comparison\",\"api\":\"CompareObjectHandles\",\"index\":%lu,\"resource\":\"%s\",\"expected\":\"%s\",\"modeled\":%s,\"left\":%llu,\"right\":%llu,\"returned\":%s,\"error\":%lu,\"classification\":\"%s\"}",
    index, name, expected == 1 ? "SAME" : expected == 2 ? "DIFFERENT" : "MODEL", modeled ? "true" : "false",
    (unsigned long long)(uintptr_t)left, (unsigned long long)(uintptr_t)right, returned ? "true" : "false", error, classification);
  cal_record(s, text);
  if (modeled) return !returned && strcmp(classification, "UNKNOWN") == 0;
  return strcmp(classification, expected == 1 ? "SAME" : "DIFFERENT") == 0;
}
static int cal_zero(CAL_STATE *s, HANDLE job, const char *name) {
  ULONGLONG end = GetTickCount64() + 2000; JOBOBJECT_BASIC_ACCOUNTING_INFORMATION info; BOOL ok; DWORD error;
  do {
    SetLastError(0); ok = QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &info, sizeof(info), NULL); error = GetLastError();
    cal_api(s, "QueryJob-active", name, ok, error, job, ok ? info.ActiveProcesses : MAXDWORD);
    if (!ok) return 0; if (!info.ActiveProcesses) return 1; Sleep(5);
  } while (GetTickCount64() < end);
  return 0;
}
static int cal_input(CAL_STATE *s, HANDLE from, HANDLE to) {
  char bytes[6]; DWORD available = 0, count = 0, written = 0, error; BOOL ok; ULONGLONG end = GetTickCount64() + 2000;
  while (count < 6 && GetTickCount64() < end) {
    SetLastError(0); ok = PeekNamedPipe(from, NULL, 0, NULL, &available, NULL); error = GetLastError();
    cal_api(s, "PeekNamedPipe-input", "owner-stdin-read", ok, error, from, available); if (!ok) return 0;
    if (!available) { Sleep(2); continue; }
    if (available > 6 - count) available = 6 - count;
    SetLastError(0); ok = ReadFile(from, bytes + count, available, &written, NULL); error = GetLastError();
    cal_api(s, "ReadFile-input", "owner-stdin-read", ok, error, from, written); if (!ok || !written) return 0; count += written;
  }
  if (count != 6 || memcmp(bytes, "hello\n", 6) != 0) return 0;
  SetLastError(0); ok = WriteFile(to, bytes, 6, &written, NULL); error = GetLastError();
  cal_api(s, "WriteFile-final-input", "shim-stdin-write", ok, error, to, written);
  return ok && written == 6 && cal_close_handle(s, to);
}
static int run_calibration_path(int argc, wchar_t **argv, int calibrate) {
  CAL_STATE s; HANDLE refs[13], same[13], different[13], inputR = NULL, inputW = NULL, resultR = NULL, resultW = NULL;
  HANDLE job = NULL, otherJob = NULL, handles[4]; PROCESS_INFORMATION pi; LPWCH environment = NULL;
  wchar_t line[32768], logfile[32768]; char text[16381]; DWORD i, error = 0, value; BOOL ok, member = FALSE;
  int rc = 1, assigned = 0, usable = 0, log_closed = 0, receipt_ok = 0, cleanup_ok = 1; const char *stage = "initial";
  static const char *names[13] = {"control-duplex","owner-stdin-read","owner-stdout-write","owner-stderr-write","shim-stdin-read","shim-stdin-write","shim-result-read","shim-result-write","shim-stdout-write-duplicate","shim-stderr-write-duplicate","owned-job","root-process","root-thread"};
  static const int write_side[10] = {0,0,1,1,0,1,0,1,1,1};
  ZeroMemory(&s, sizeof(s)); ZeroMemory(refs, sizeof(refs)); ZeroMemory(same, sizeof(same)); ZeroMemory(different, sizeof(different)); ZeroMemory(&pi, sizeof(pi));
  if (argc != 6) return 98;
  if (swprintf_s(logfile, 32768, L"%s.api.jsonl", argv[5]) < 0 || _wfopen_s(&s.log, logfile, L"wb") != 0) { fprintf(stderr, "STOP calibration API log open\n"); return 98; }
  control = (HANDLE)_get_osfhandle(3); refs[0] = control;
#define CAL_REQUIRE(condition, label) do { stage = label; if (!(condition)) { s.failed = 1; fprintf(stderr, "STOP %s\n", stage); goto cal_done; } } while (0)
  CAL_REQUIRE(cal_flags(&s, control, names[0], 1), "control-fresh-cleared-flags");
  CAL_REQUIRE(cal_token(&s), "standard-user-token");
  CAL_REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"diagnostic-hello\",\"mode\":\"%s\",\"ownerPid\":%lu,\"administrator\":false,\"elevated\":false}", calibrate ? "calibration" : "preload-observation", GetCurrentProcessId()), "diagnostic-hello");
  CAL_REQUIRE(command("prepare"), "diagnostic-prepare");
  for (i = 1; i < 4; i++) {
    SetLastError(0); refs[i] = GetStdHandle(i == 1 ? STD_INPUT_HANDLE : i == 2 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE); error = GetLastError();
    cal_api(&s, "GetStdHandle-borrowed", names[i], refs[i] != NULL && refs[i] != INVALID_HANDLE_VALUE, error, refs[i], 0);
    CAL_REQUIRE(refs[i] != NULL && refs[i] != INVALID_HANDLE_VALUE, "borrowed-stdio");
  }
  CAL_REQUIRE(cal_job(&s, &job, names[10]), "retained-private-job"); refs[10] = job;
  CAL_REQUIRE(cal_pipe(&s, &inputR, &inputW, "shim-stdin", TRUE), "actual-shim-stdin"); refs[4] = inputR; refs[5] = inputW;
  CAL_REQUIRE(cal_flags(&s, inputW, names[5], 1), "stdin-write-fresh-cleared-flags");
  CAL_REQUIRE(cal_pipe(&s, &resultR, &resultW, "shim-result", TRUE), "actual-shim-result"); refs[6] = resultR; refs[7] = resultW;
  CAL_REQUIRE(cal_flags(&s, resultR, names[6], 1), "result-read-fresh-cleared-flags");
  CAL_REQUIRE(cal_dup(&s, refs[2], &refs[8], names[8], TRUE), "actual-shim-stdout");
  CAL_REQUIRE(cal_dup(&s, refs[3], &refs[9], names[9], TRUE), "actual-shim-stderr");
  environment = cleanenv(); CAL_REQUIRE(environment, "clean-authority-environment");
  handles[0] = inputR; handles[1] = refs[8]; handles[2] = refs[9]; handles[3] = resultW;
  CAL_REQUIRE(swprintf_s(line, 32768, L"\"%s\" \"%s\" %s diagnostic \"%s\"", argv[2], argv[3], calibrate ? L"calibration-root" : L"observation-shim", argv[4]) >= 0, "diagnostic-command");
  CAL_REQUIRE(cal_launch(&s, line, handles, &pi, environment), "diagnostic-create-suspended");
  refs[11] = pi.hProcess; refs[12] = pi.hThread;
  CAL_REQUIRE(cal_flags(&s, resultW, names[7], 1), "result-write-fresh-cleared-flags");
  SetLastError(0); ok = AssignProcessToJobObject(job, pi.hProcess); error = GetLastError();
  cal_api(&s, "AssignProcessToJobObject", names[11], ok, error, pi.hProcess, pi.dwProcessId);
  CAL_REQUIRE(ok, "diagnostic-assign"); assigned = 1;
  SetLastError(0); ok = IsProcessInJob(pi.hProcess, job, &member); error = GetLastError();
  cal_api(&s, "IsProcessInJob", names[11], ok, error, pi.hProcess, member);
  CAL_REQUIRE(ok && member, "diagnostic-membership");
  for (i = 0; i < 13; i++) {
    CAL_REQUIRE(cal_flags(&s, refs[i], names[i], 0), "live-resource-flags");
    if (i < 10) {
      SetLastError(0); value = GetFileType(refs[i]); error = GetLastError();
      cal_api(&s, "GetFileType", names[i], value == FILE_TYPE_PIPE, error, refs[i], value);
      CAL_REQUIRE(value == FILE_TYPE_PIPE, "actual-required-pipe-endpoint");
    }
    CAL_REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"cal-resource\",\"index\":%lu,\"name\":\"%s\",\"handle\":%llu,\"owned\":%s,\"rootPid\":%lu,\"rootThreadId\":%lu}", i, names[i], (unsigned long long)(uintptr_t)refs[i], i < 4 ? "false" : "true", pi.dwProcessId, pi.dwThreadId), "resource-inventory");
  }
  CAL_REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"diagnostic-assigned-suspended\",\"pid\":%lu,\"resourceCount\":13}", pi.dwProcessId), "assigned-suspended-receipt");
  if (calibrate) {
    HANDLE invalid = NULL;
    SetLastError(0); ok = DuplicateHandle(GetCurrentProcess(), NULL, GetCurrentProcess(), &invalid, 0, FALSE, DUPLICATE_SAME_ACCESS); error = GetLastError();
    cal_api(&s, "DuplicateHandle-MODEL-invalid", "MODEL-invalid-duplicate", ok, error, NULL, 0);
    if (ok) cal_adopt(&s, invalid, "unexpected-model-duplicate");
    CAL_REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"cal-model\",\"api\":\"DuplicateHandle\",\"modeled\":true,\"name\":\"invalid-duplicate\",\"returned\":%s,\"error\":%lu,\"classification\":\"UNKNOWN\"}", ok ? "true" : "false", error), "model-duplicate-record");
    s.models++; CAL_REQUIRE(!ok, "model-invalid-duplicate-must-be-unknown");
    CAL_REQUIRE(cal_compare(&s, 0, "MODEL-invalid-compare", NULL, NULL, 0, 1), "model-invalid-comparison-must-be-unknown");
    CAL_REQUIRE(cal_job(&s, &otherJob, "different-empty-job"), "different-job"); different[10] = otherJob;
    CAL_REQUIRE(cal_dup(&s, GetCurrentProcess(), &different[11], "different-real-self-process", FALSE), "different-self-process");
    CAL_REQUIRE(cal_dup(&s, GetCurrentThread(), &different[12], "different-real-self-thread", FALSE), "different-self-thread");
    for (i = 0; i < 10; i++) {
      HANDLE read_end = NULL, write_end = NULL; char label[80];
      snprintf(label, sizeof(label), "different-pipe-%lu", i);
      CAL_REQUIRE(cal_pipe(&s, &read_end, &write_end, label, FALSE), "constructed-different-pipe");
      different[i] = write_side[i] ? write_end : read_end;
    }
    for (i = 0; i < 13; i++) {
      char label[80]; snprintf(label, sizeof(label), "same-duplicate-%lu", i);
      CAL_REQUIRE(cal_dup(&s, refs[i], &same[i], label, FALSE), "known-same-duplicate");
    }
    SetLastError(0); value = WaitForSingleObject(pi.hProcess, 0); error = GetLastError();
    cal_api(&s, "Wait-root-still-live-suspended", names[11], value == WAIT_TIMEOUT, error, pi.hProcess, value);
    CAL_REQUIRE(value == WAIT_TIMEOUT, "calibration-root-not-live");
    SetLastError(0); value = GetFileAttributesW(argv[4]); error = GetLastError();
    cal_api(&s, "GetFileAttributes-no-first-marker", "suspended-root-marker", value == INVALID_FILE_ATTRIBUTES && error == ERROR_FILE_NOT_FOUND, error, NULL, value);
    CAL_REQUIRE(value == INVALID_FILE_ATTRIBUTES && error == ERROR_FILE_NOT_FOUND, "suspended-calibration-root-executed");
    for (i = 0; i < 13; i++) {
      CAL_REQUIRE(cal_compare(&s, i, names[i], refs[i], same[i], 1, 0), "required-class-SAME-UNKNOWN");
      CAL_REQUIRE(cal_compare(&s, i, names[i], refs[i], different[i], 2, 0), "required-class-DIFFERENT-UNKNOWN");
    }
    usable = 1;
  } else {
    CAL_REQUIRE(command("resume"), "observation-resume-authorized");
    SetLastError(0); value = ResumeThread(pi.hThread); error = GetLastError();
    cal_api(&s, "ResumeThread", names[12], value != MAXDWORD, error, pi.hThread, value); CAL_REQUIRE(value == 1, "observation-resume");
    CAL_REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"observation-ready\""), "observation-ready-role");
    CAL_REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"observation-ready\",\"shim\":%s}", text), "observation-ready-forward");
    CAL_REQUIRE(command("start"), "observation-explicit-start");
    SetLastError(0); ok = WriteFile(inputW, "START\n", 6, &value, NULL); error = GetLastError();
    cal_api(&s, "WriteFile-start", names[5], ok, error, inputW, value); CAL_REQUIRE(ok && value == 6, "observation-start-delivery");
    CAL_REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"observation-command-started\""), "observation-command-role");
    CAL_REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"observation-command-started\",\"shim\":%s}", text), "observation-command-forward");
    CAL_REQUIRE(cal_input(&s, refs[1], inputW), "observation-final-input");
    CAL_REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"observation-result\""), "observation-result-role");
    CAL_REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"observation-result\",\"shim\":%s}", text), "observation-result-forward");
    CAL_REQUIRE(members(job), "observation-job-members");
    CAL_REQUIRE(command("cancel"), "observation-retirement-authorized"); usable = 1;
  }
cal_done:
  if (pi.hProcess && !assigned) {
    SetLastError(0); ok = TerminateProcess(pi.hProcess, 74); error = GetLastError();
    cal_api(&s, "TerminateProcess-unassigned-root", "root-process", ok, error, pi.hProcess, 0); if (!ok) { s.failed = 1; cleanup_ok = 0; }
    SetLastError(0); value = WaitForSingleObject(pi.hProcess, 2000); error = GetLastError();
    cal_api(&s, "Wait-unassigned-root", "root-process", value == WAIT_OBJECT_0, error, pi.hProcess, value); if (value != WAIT_OBJECT_0) { s.failed = 1; cleanup_ok = 0; }
  }
  if (job) {
    SetLastError(0); ok = TerminateJobObject(job, 75); error = GetLastError();
    cal_api(&s, "TerminateJobObject", "owned-job", ok, error, job, 0);
    s.sealed = ok; s.drained = ok && cal_zero(&s, job, "owned-job"); if (!s.drained) { s.failed = 1; cleanup_ok = 0; }
  }
  if (otherJob) {
    SetLastError(0); ok = TerminateJobObject(otherJob, 76); error = GetLastError();
    cal_api(&s, "TerminateJobObject", "different-empty-job", ok, error, otherJob, 0);
    if (!ok || !cal_zero(&s, otherJob, "different-empty-job")) { s.failed = 1; cleanup_ok = 0; }
  }
  for (i = s.count; i > 0; i--) if (s.owned[i - 1].handle) (void)cal_close_index(&s, i - 1);
  if (environment) {
    SetLastError(0); ok = HeapFree(GetProcessHeap(), 0, environment); error = GetLastError();
    cal_api(&s, "HeapFree-clean-environment", "root-environment", ok, error, NULL, 0); if (!ok) { s.failed = 1; cleanup_ok = 0; }
  }
  log_closed = fclose(s.log) == 0;
  if (!log_closed || s.log_failed || s.wire_failed || s.closed != s.count) s.failed = 1;
  {
    FILE *f = NULL;
    if (_wfopen_s(&f, argv[5], L"wb") == 0 && f) {
      int printed = fprintf(f, "{\"mode\":\"%s\",\"stage\":\"%s\",\"usable\":%s,\"sealed\":%s,\"exactJobZero\":%s,\"ownedCreated\":%lu,\"ownedClosed\":%lu,\"compared\":%lu,\"models\":%lu,\"apiLogClosed\":%s,\"cleanupComplete\":%s}\n",
        calibrate ? "calibration" : "preload-observation", stage, usable ? "true" : "false", s.sealed ? "true" : "false", s.drained ? "true" : "false", s.count, s.closed, s.compared, s.models, log_closed ? "true" : "false", cleanup_ok && s.drained && s.closed == s.count && log_closed && !s.log_failed ? "true" : "false");
      int closed = fclose(f); receipt_ok = printed > 0 && closed == 0;
    }
  }
  rc = usable && !s.failed && receipt_ok ? 0 : 1;
  if (!emit("{\"role\":\"owner\",\"stage\":\"%s\",\"usable\":%s,\"sealed\":%s,\"exactJobZero\":%s,\"ownedCreated\":%lu,\"ownedClosed\":%lu,\"compared\":%lu,\"models\":%lu,\"receiptWritten\":%s}",
      rc == 0 ? (calibrate ? "calibration-complete" : "observation-retired") : "diagnostic-stop",
      usable ? "true" : "false", s.sealed ? "true" : "false", s.drained ? "true" : "false", s.count, s.closed, s.compared, s.models, receipt_ok ? "true" : "false")) rc = 1;
  return rc;
}
static int native_calibration(int argc, wchar_t **argv) { return run_calibration_path(argc, argv, 1); }
static int native_preload_observation(int argc, wchar_t **argv) { return run_calibration_path(argc, argv, 0); }
int wmain(int argc, wchar_t **argv) {
  HANDLE job = NULL, inputR = NULL, inputW = NULL, resultR = NULL, resultW = NULL, thread = NULL;
  HANDLE handles[4] = {NULL,NULL,NULL,NULL}, sensitive[7];
  PROCESS_INFORMATION pi; SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, TRUE};
  LPWCH environment = NULL; wchar_t line[32768]; char text[16381]; DWORD flags = 0, error = 0;
  BOOL ok = FALSE; int rc = 1, assigned = 0, sealed = 0, drained = 0, stranded = 0;
  const char *stage = "initial"; PUMP transfer;
  if (!initialize_comparison_api()) return 96;
  ZeroMemory(&pi, sizeof(pi)); ZeroMemory(&transfer, sizeof(transfer));
  if (argc > 1 && wcscmp(argv[1], L"--supervise") == 0) return supervise(argc, argv);
  if (argc > 1 && wcscmp(argv[1], L"--calibrate") == 0) return native_calibration(argc, argv);
  if (argc > 1 && wcscmp(argv[1], L"--preload-observation") == 0) return native_preload_observation(argc, argv);
  if (argc != 7) return 90;
  control = (HANDLE)_get_osfhandle(3);
#define REQUIRE(condition, label) do { stage = label; if (!(condition)) { error = GetLastError(); fprintf(stderr, "STOP %s win32=%lu crt-fd3=%llu\n", stage, error, (unsigned long long)(uintptr_t)control); goto done; } } while (0)
  REQUIRE(control != INVALID_HANDLE_VALUE && GetHandleInformation(control, &flags), "parent-owner-fd3");
  REQUIRE(standard_token(), "standard-user-token");
  REQUIRE(GetFileType(control) == FILE_TYPE_PIPE, "control-pipe-type");
  REQUIRE(SetHandleInformation(control, HANDLE_FLAG_INHERIT, 0), "control-no-inherit");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"hello\",\"handle\":%llu,\"flags\":%lu,\"type\":%lu,\"administrator\":false,\"elevated\":false}", (unsigned long long)(uintptr_t)control, flags, GetFileType(control)), "control-write");
  REQUIRE(command("prepare"), "control-read");
  job = newjob(); REQUIRE(job, "create-retained-job");
  REQUIRE(CreatePipe(&inputR, &inputW, &sa, 0), "stdin-pipe");
  REQUIRE(SetHandleInformation(inputW, HANDLE_FLAG_INHERIT, 0), "stdin-write-private");
  REQUIRE(CreatePipe(&resultR, &resultW, &sa, 0), "result-pipe");
  REQUIRE(!checked_compare_objects(control, resultR) && !checked_compare_objects(control, resultW), "distinct-control-result-objects");
  REQUIRE(SetHandleInformation(resultR, HANDLE_FLAG_INHERIT, 0), "result-read-private");
  handles[0] = inputR; handles[1] = inherited(GetStdHandle(STD_OUTPUT_HANDLE));
  handles[2] = inherited(GetStdHandle(STD_ERROR_HANDLE)); handles[3] = resultW;
  REQUIRE(handles[1] && handles[2], "stdio-duplicates");
  environment = cleanenv(); REQUIRE(environment, "clean-bootstrap-environment");
  REQUIRE(swprintf_s(line, 32768, L"\"%s\" \"%s\" shim \"%s\" \"%s\"", argv[2], argv[3], argv[4], argv[5]) >= 0, "shim-command");
  REQUIRE(launch(line, handles, 4, &pi, environment), "create-suspended-shim");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"resources\",\"job\":%llu,\"rootProcess\":%llu,\"rootThread\":%llu,\"resultRead\":%llu,\"resultWrite\":%llu,\"shimStdinWrite\":%llu}",
    (unsigned long long)(uintptr_t)job, (unsigned long long)(uintptr_t)pi.hProcess, (unsigned long long)(uintptr_t)pi.hThread,
    (unsigned long long)(uintptr_t)resultR, (unsigned long long)(uintptr_t)resultW, (unsigned long long)(uintptr_t)inputW), "resource-receipt");
  CloseHandle(inputR); inputR = NULL;
  REQUIRE(SetHandleInformation(resultW, HANDLE_FLAG_INHERIT, 0), "result-write-private-copy");
  CloseHandle(handles[1]); handles[1] = NULL; CloseHandle(handles[2]); handles[2] = NULL;
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"created\",\"pid\":%lu,\"thread\":%lu}", pi.dwProcessId, pi.dwThreadId), "created-receipt");
  if (wcscmp(argv[4], L"cancel-created") == 0) { REQUIRE(command("cancel"), "cancel-created"); goto retire; }
  if (wcscmp(argv[4], L"model-assignment") == 0) {
    SetLastError(0); ok = AssignProcessToJobObject(NULL, pi.hProcess); error = GetLastError();
    REQUIRE(!ok && error != 0, "model-assignment-refusal");
    stranded = 1; emit("{\"role\":\"owner\",\"stage\":\"modeled-assignment-refusal\",\"error\":%lu,\"strandedSuspendedPid\":%lu}", error, pi.dwProcessId);
    rc = 0; goto done;
  }
  REQUIRE(command("assign"), "assign-authorization");
  REQUIRE(AssignProcessToJobObject(job, pi.hProcess), "real-assignment");
  assigned = 1;
  REQUIRE(IsProcessInJob(pi.hProcess, job, &ok) && ok, "root-job-membership");
  Sleep(100);
  REQUIRE(PeekNamedPipe(resultR, NULL, 0, NULL, &flags, NULL) && flags == 0 && GetFileAttributesW(argv[5]) == INVALID_FILE_ATTRIBUTES, "no-first-marker-before-resume");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"assigned-suspended\",\"active\":%lu}", active(job, &ok)) && ok, "assignment-receipt");
  if (wcscmp(argv[4], L"cancel-assigned") == 0) { REQUIRE(command("cancel"), "cancel-assigned"); goto retire; }
  if (wcscmp(argv[4], L"model-resume") == 0) {
    SetLastError(0); flags = ResumeThread(NULL); error = GetLastError();
    REQUIRE(flags == MAXDWORD && error != 0, "model-resume-refusal");
    emit("{\"role\":\"owner\",\"stage\":\"modeled-resume-refusal\",\"error\":%lu}", error); goto retire;
  }
  REQUIRE(command("resume"), "resume-authorization");
  REQUIRE(ResumeThread(pi.hThread) == 1, "real-resume");
  REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"ready\""), "shim-crt-fd3-ready");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"ready\",\"shim\":%s}", text), "ready-receipt");
  if (wcscmp(argv[4], L"ready-abort") == 0) { REQUIRE(command("cancel"), "ready-abort"); goto retire; }
  REQUIRE(command("start"), "explicit-start");
  REQUIRE(WriteFile(inputW, "START\n", 6, &flags, NULL) && flags == 6, "start-delivery");
  transfer.from = GetStdHandle(STD_INPUT_HANDLE); transfer.to = inputW;
  thread = CreateThread(NULL, 0, pump, &transfer, 0, NULL); REQUIRE(thread, "stdin-pump");
  inputW = NULL;
  REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"git-started\""), "git-start-receipt");
  {
    char *pid = strstr(text, "\"pid\":"); DWORD gitPid;
    REQUIRE(pid, "git-pid-provenance"); gitPid = (DWORD)strtoul(pid + 6, NULL, 10);
    sensitive[0] = control; sensitive[1] = resultR; sensitive[2] = resultW;
    sensitive[3] = job; sensitive[4] = pi.hProcess; sensitive[5] = pi.hThread; sensitive[6] = transfer.to;
    REQUIRE(audit(gitPid, job, sensitive, 7), "git-sensitive-handle-exclusion");
  }
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"git-audit\"}"), "git-audit-receipt");
  REQUIRE(receive(resultR, text) == 1 && strstr(text, "\"role\":\"shim\"") && strstr(text, "\"stage\":\"result\""), "genuine-command-result");
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"result\",\"shim\":%s,\"active\":%lu}", text, active(job, &ok)) && ok, "result-forward");
  REQUIRE(members(job), "retained-job-descendant-census");
  if (wcscmp(argv[4], L"model-query") == 0) {
    (void)active(NULL, &ok); error = GetLastError(); REQUIRE(!ok, "modeled-query-refusal");
    emit("{\"role\":\"owner\",\"stage\":\"modeled-query-refusal\",\"error\":%lu}", error);
  }
  REQUIRE(command("cancel"), "post-result-seal-authorization");
retire:
  if (!assigned && pi.hProcess) {
    REQUIRE(TerminateProcess(pi.hProcess, 70), "unassigned-root-test-owner-terminate");
    REQUIRE(WaitForSingleObject(pi.hProcess, 2000) == WAIT_OBJECT_0, "unassigned-root-retired");
  }
  REQUIRE(TerminateJobObject(job, 71), "seal-job"); sealed = 1;
  REQUIRE(zero(job), "retained-sealed-job-zero"); drained = 1;
  REQUIRE(emit("{\"role\":\"owner\",\"stage\":\"sealed-zero\",\"active\":0,\"assigned\":%s}", assigned ? "true" : "false"), "zero-receipt");
  rc = 0;
done:
  if (rc && pi.hProcess && !assigned && !stranded) { TerminateProcess(pi.hProcess, 72); WaitForSingleObject(pi.hProcess, 2000); }
  if (job && !stranded && !sealed) { sealed = TerminateJobObject(job, 73); drained = sealed && zero(job); }
  if (thread) {
    CancelSynchronousIo(thread);
    if (WaitForSingleObject(thread, 2000) != WAIT_OBJECT_0) { stage = "stdin-pump-retirement"; error = GetLastError(); rc = 1; }
    CloseHandle(thread);
  }
  receipt(argv[6], stage, sealed, drained, error);
  if (pi.hThread) CloseHandle(pi.hThread); if (pi.hProcess) CloseHandle(pi.hProcess);
  if (inputR) CloseHandle(inputR); if (inputW) CloseHandle(inputW);
  if (resultR) CloseHandle(resultR); if (resultW) CloseHandle(resultW);
  if (handles[1]) CloseHandle(handles[1]); if (handles[2]) CloseHandle(handles[2]);
  if (job) CloseHandle(job); if (environment) HeapFree(GetProcessHeap(), 0, environment);
  return rc;
}
`

const shimSource = String.raw`
const fs = require("node:fs");
const { spawn, spawnSync } = require("node:child_process");
const [role, mode, marker] = process.argv.slice(2);
const send = (value) => {
  const body = Buffer.from(JSON.stringify({ role: "shim", ...value }));
  if (body.length > 16380) throw Error("frame bound");
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length);
  fs.writeSync(3, Buffer.concat([head, body]));
};
if (role === "calibration-root") {
  fs.writeFileSync(marker, "UNEXPECTED calibration root execution");
  throw Error("calibration root must remain suspended");
} else if (role === "observation-hook") {
  const git = spawn("git", ["hash-object", "--stdin"], { stdio: ["pipe", "inherit", "inherit"] });
  process.stdin.pipe(git.stdin);
  git.on("exit", (code) => { process.exitCode = code === null ? 1 : code; });
} else if (role === "observation-shim") {
  fs.writeFileSync(marker, "observation first instruction");
  send({ stage: "observation-ready", node: process.version, execPath: process.execPath,
    bootstrapNodeOptions: process.env.NODE_OPTIONS ?? null, bootstrapNodePath: process.env.NODE_PATH ?? null });
  let pending = Buffer.alloc(0);
  process.stdin.on("data", function startInput(chunk) {
    pending = Buffer.concat([pending, chunk]); const end = pending.indexOf(10);
    if (end < 0) return;
    if (pending.subarray(0, end).toString() !== "START") throw Error("observation explicit start");
    process.stdin.pause(); process.stdin.removeListener("data", startInput);
    fs.writeFileSync(marker + ".command", "observation explicit start");
    const survivor = spawn(process.execPath, [__filename, "survivor", "nested", marker], { detached: true, stdio: "ignore" });
    fs.appendFileSync(marker + ".survivors", survivor.pid + "\n"); survivor.unref();
    const waiting = Date.now();
    const launchObservation = () => {
      if (fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n").length !== 2) {
        if (Date.now() - waiting >= 2000) throw Error("observation nested ready deadline");
        setTimeout(launchObservation, 5); return;
      }
      const env = { ...process.env, NODE_OPTIONS: process.env.OWNED_PROBE_PRELOAD,
        NODE_PATH: process.env.OWNED_PROBE_NODE_PATH, OWNED_PROBE_ROLE: "downstream" };
      const alias = '!"' + process.execPath.replaceAll("\\", "/") + '" "' + __filename.replaceAll("\\", "/") + '" observation-hook';
      const git = spawn("git", ["-c", "alias.probe=" + alias, "probe"], { env, stdio: ["pipe", "pipe", "pipe"] });
      let data = "", error = "", inputComplete = false;
      git.stdout.on("data", (chunk) => { data += chunk; process.stdout.write(chunk); });
      git.stderr.on("data", (chunk) => { error += chunk; process.stderr.write(chunk); });
      git.on("error", (error) => { throw error; });
      send({ stage: "observation-command-started", pid: git.pid });
      git.stdin.write(pending.subarray(end + 1)); pending = null;
      process.stdin.on("data", (chunk) => git.stdin.write(chunk));
      process.stdin.on("end", () => git.stdin.end(() => { inputComplete = true; }));
      process.stdin.resume();
      git.on("close", (code, signal) => {
        send({ stage: "observation-result", code, signal, inputComplete, data, error });
        process.stdout.write("OBSERVATION_AFTER_RESULT\n"); setInterval(() => {}, 1000);
      });
    };
    launchObservation();
  });
} else if (role === "survivor") {
  if (mode === "nested") {
    const leaf = spawn(process.execPath, [__filename, "survivor", "leaf", marker], { detached: true, stdio: "ignore" });
    fs.appendFileSync(marker + ".survivors", leaf.pid + "\n"); leaf.unref();
  }
  setInterval(() => {}, 1000);
} else if (role === "hook") {
  const git = spawn("git", ["hash-object", "--stdin"], { stdio: ["pipe", "inherit", "inherit"] });
  process.stdin.pipe(git.stdin);
  git.on("exit", (code) => { process.exitCode = code === null ? 1 : code; });
} else {
  fs.writeFileSync(marker, "first-instruction");
  send({ stage: "ready", node: process.version, execPath: process.execPath,
    bootstrapNodeOptions: process.env.NODE_OPTIONS ?? null, bootstrapNodePath: process.env.NODE_PATH ?? null });
  let pending = Buffer.alloc(0), started = false;
  process.stdin.on("data", function input(chunk) {
    pending = Buffer.concat([pending, chunk]);
    const end = pending.indexOf(10);
    if (end < 0) return;
    if (started || pending.subarray(0, end).toString() !== "START") throw Error("start gate");
    started = true; process.stdin.pause(); process.stdin.removeListener("data", input);
    fs.writeFileSync(marker + ".command", "explicit-start");
    const survivor = spawn(process.execPath, [__filename, "survivor", "nested", marker], { detached: true, stdio: "ignore" });
    fs.appendFileSync(marker + ".survivors", survivor.pid + "\n"); survivor.unref();
    const launchGit = () => {
    if ((fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n")).length !== 2) {
      if (Date.now() - waiting >= 2000) throw Error("nested descendant ready deadline");
      setTimeout(launchGit, 5); return;
    }
    const env = { ...process.env, NODE_OPTIONS: process.env.OWNED_PROBE_PRELOAD,
      NODE_PATH: process.env.OWNED_PROBE_NODE_PATH, OWNED_PROBE_ROLE: "downstream" };
    const alias = '!"' + process.execPath.replaceAll("\\", "/") + '" "' + __filename.replaceAll("\\", "/") + '" hook';
    const git = spawn("git", ["-c", "alias.probe=" + alias, "probe"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let data = "", error = "", inputComplete = false;
    git.stdout.on("data", (chunk) => { data += chunk; process.stdout.write(chunk); });
    git.stderr.on("data", (chunk) => { error += chunk; process.stderr.write(chunk); });
    git.on("error", (error) => { throw error; });
    send({ stage: "git-started", pid: git.pid });
    git.stdin.write(pending.subarray(end + 1)); pending = null;
    process.stdin.on("data", (chunk) => git.stdin.write(chunk));
    process.stdin.on("end", () => git.stdin.end(() => { inputComplete = true; }));
    process.stdin.resume();
    git.on("close", (code, signal) => {
      send({ stage: "result", code, signal, inputComplete, data, error });
      process.stdout.write("AFTER_RESULT\n");
      setInterval(() => {}, 1000);
    });
    };
    const waiting = Date.now(); launchGit();
  });
}
`

const buildSource = String.raw`
param([Parameter(Mandatory=$true)][string]$Root)
$ErrorActionPreference = 'Stop'
$vswhere = Join-Path ([Environment]::GetEnvironmentVariable('ProgramFiles(x86)')) 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path $vswhere)) { throw 'STOP missing installed vswhere' }
$installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$installation) { throw 'STOP missing installed VC toolchain' }
$devcmd = Join-Path $installation 'Common7\Tools\VsDevCmd.bat'
$compiler = Join-Path $installation 'VC\Tools\Llvm\x64\bin\clang-cl.exe'
if (!(Test-Path $compiler)) { throw 'STOP missing installed clang-cl' }
$out = Join-Path $Root 'probe-owner.exe'
$source = Join-Path $Root 'probe-owner.c'
$identity = Join-Path $Root 'toolchain.txt'
$cmd = 'call "' + $devcmd + '" -arch=x64 -host_arch=x64 >nul && "' + $compiler + '" --version && set WindowsSDK && "' + $compiler + '" /nologo /W4 /WX /MT /O2 "' + $source + '" /Fe:"' + $out + '" /Fo:"' + (Join-Path $Root 'probe-owner.obj') + '" /link kernel32.lib advapi32.lib && dumpbin /dependents "' + $out + '"'
& $env:ComSpec /d /s /c $cmd 2>&1 | Tee-Object -FilePath $identity
if ($LASTEXITCODE -ne 0) { throw "STOP compiler exit $LASTEXITCODE" }
`

const driverSource = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const report = { status: "RUNNING", pure: true, sqliteLoaded: false, cases: [], stranded: [],
  driver: { version: process.version, execPath: process.execPath, cwd: process.cwd() },
  wire: { header: 4, body: 16380, total: 16384, rejectedBodies: [16381,16385] } };
const save = () => fs.writeFileSync(config.report, JSON.stringify(report, null, 2));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function encode(value) {
  const body = Buffer.from(JSON.stringify(value)); assert.ok(body.length <= 16380);
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length); return Buffer.concat([head, body]);
}
function session(node, mode, marker, receipt) {
  const log = marker + ".jsonl";
  const child = spawn(config.owner, ["owner", node, config.shim, mode, marker, receipt], {
    cwd: config.neutral, stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: '--require="' + config.preload + '"',
      NODE_PATH: config.publicRoot, OWNED_PROBE_ROLE: "shim", OWNED_PROBE_MARKER: marker,
      OWNED_PROBE_PRELOAD: '--require="' + config.preload + '"', OWNED_PROBE_NODE_PATH: config.publicRoot }
  });
  const events = [], backlog = [];
  let pending = Buffer.alloc(0), failure, stdout = "", stderr = "", eof = false;
  const append = (value) => { fs.appendFileSync(log, JSON.stringify({ time: Date.now(), ...value }) + "\n"); };
  const closed = new Promise((resolve) => child.on("close", (code, signal) => {
    append({ closed: true, code, signal }); resolve({ code, signal });
  }));
  child.on("error", (error) => { failure = error; append({ error: error.stack }); });
  child.stdout.on("data", (chunk) => { stdout += chunk; append({ stdout: chunk.toString("utf8") }); });
  child.stdout.on("end", () => { eof = true; append({ stdoutEOF: true }); });
  child.stderr.on("data", (chunk) => { stderr += chunk; append({ stderr: chunk.toString("utf8") }); });
  child.stdio[3].on("error", (error) => { append({ controlError: error.message }); });
  child.stdin.on("error", (error) => { append({ inputError: error.message }); });
  child.stdio[3].on("data", (chunk) => {
    try {
      append({ controlBytes: chunk.toString("hex") });
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 4) {
        const n = pending.readUInt32LE(); assert.ok(n <= 16380, "encoded frame bound");
        if (pending.length < n + 4) break;
        const event = JSON.parse(pending.subarray(4, n + 4).toString("utf8"));
        assert.equal(event.role, "owner", "control provenance");
        append({ control: event }); events.push(event); backlog.push(event);
        pending = pending.subarray(n + 4);
      }
    } catch (error) { failure = error; append({ parserError: error.stack }); }
  });
  return {
    child, events, closed, send: (cmd) => { append({ sent: cmd }); child.stdio[3].write(encode({ cmd })); },
    stdout: () => stdout, stderr: () => stderr, eof: () => eof,
    async take(stage) {
      const end = Date.now() + 2000;
      while (Date.now() < end) {
        if (failure) throw failure;
        const i = backlog.findIndex((value) => value.stage === stage);
        if (i >= 0) return backlog.splice(i, 1)[0];
        if (child.exitCode !== null) throw Error("owner exited waiting " + stage + ": " + stderr);
        await delay(5);
      }
      throw Error("2000ms waiting " + stage + ": " + stderr);
    }
  };
}
async function one(identity, mode) {
  const marker = path.join(config.evidence, identity.version + "-" + mode);
  const receipt = marker + ".receipt.json";
  const record = { node: identity, mode, kind: mode.startsWith("model-") ? "modeled fault with real retirement" : "real kernel", marker, receipt };
  report.cases.push(record); save();
  const s = session(identity.path, mode, marker, receipt);
  record.pid = s.child.pid;
  try {
    const hello = await s.take("hello");
    assert.equal(hello.administrator, false); assert.equal(hello.elevated, false);
    s.send("prepare"); const created = await s.take("created"); record.rootPid = created.pid;
    assert.equal(fs.existsSync(marker), false, "suspended root executed before assignment");
    if (mode === "model-assignment") {
      const fault = await s.take("modeled-assignment-refusal");
      assert.notEqual(fault.error, 0); report.stranded.push(fault.strandedSuspendedPid);
      assert.equal(fs.existsSync(marker), false); assert.equal((await s.closed).code, 0);
      record.ownership = "intentionally stranded suspended root; broader synthetic owner must retire"; return;
    }
    if (mode === "cancel-created") s.send("cancel");
    else {
      s.send("assign"); const assigned = await s.take("assigned-suspended");
      assert.equal(assigned.active, 1); assert.equal(fs.existsSync(marker), false);
      if (mode === "cancel-assigned") s.send("cancel");
      else if (mode === "model-resume") {
        assert.notEqual((await s.take("modeled-resume-refusal")).error, 0);
      } else {
        s.send("resume"); const ready = await s.take("ready");
        assert.equal(ready.shim.role, "shim"); assert.equal(ready.shim.node, identity.version);
        assert.equal(path.resolve(ready.shim.execPath).toLowerCase(), path.resolve(identity.path).toLowerCase());
        assert.equal(ready.shim.bootstrapNodeOptions, null); assert.equal(ready.shim.bootstrapNodePath, null);
        await delay(100);
        assert.equal(fs.existsSync(marker + ".command"), false, "command started before explicit start");
        assert.equal(fs.existsSync(marker + ".preload-shim"), false, "caller preload ran inside authority shim");
        if (mode === "ready-abort") s.send("cancel");
        else if (mode === "parent-loss") {
          s.child.stdin.end(); s.child.stdio[3].destroy();
          assert.equal((await s.closed).code, 1);
          record.loss = JSON.parse(fs.readFileSync(receipt, "utf8"));
          assert.equal(record.loss.sealed, true); assert.equal(record.loss.exactJobZero, true);
          assert.equal(fs.existsSync(marker + ".command"), false);
          return;
        } else {
          s.send("start"); await s.take("git-audit");
          const audits = s.events.filter((e) => e.stage === "peer-handle");
          assert.equal(audits.length, 7); assert.ok(audits.every((e) => !e.sameObject));
          s.child.stdin.end("hello\n");
          const result = await s.take("result");
          assert.equal(result.shim.role, "shim");
          assert.equal(result.shim.code, 0); assert.equal(result.shim.signal, null);
          assert.equal(result.shim.inputComplete, true, "actual final input delivery required before termination");
          assert.equal(result.shim.data.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
          assert.equal(s.eof(), false, "result must precede data EOF");
          const census = await s.take("job-members");
          const survivors = fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n").map(Number);
          assert.equal(survivors.length, 2); assert.ok(survivors.every((pid) => census.pids.includes(pid)));
          assert.ok(census.pids.includes(created.pid)); assert.ok(result.active >= 3);
          assert.equal(s.events.some((e) => e.stage === "sealed-zero"), false, "survivor cannot produce zero certificate");
          const preload = JSON.parse(fs.readFileSync(marker + ".preload-downstream", "utf8"));
          assert.equal(preload.role, "downstream"); assert.equal(preload.nodePath, config.publicRoot);
          assert.equal(fs.existsSync(marker + ".preload-shim"), false);
          record.survivors = survivors; record.result = result; record.resultBeforeEOF = true;
          if (mode === "helper-loss") {
            assert.equal(s.child.kill(), true); await s.closed;
            assert.equal(s.events.some((e) => e.stage === "sealed-zero"), false);
            record.ownership = "helper killed; no private job certificate; broader owner must account real remaining resources";
            return;
          }
          if (mode === "model-query") assert.notEqual((await s.take("modeled-query-refusal")).error, 0);
          s.send("cancel");
        }
      }
    }
    const cert = await s.take("sealed-zero");
    assert.equal(cert.active, 0);
    s.child.stdin.end();
    assert.equal((await s.closed).code, 0);
    const retired = JSON.parse(fs.readFileSync(receipt, "utf8"));
    assert.equal(retired.sealed, true); assert.equal(retired.exactJobZero, true);
    if (["cancel-created", "cancel-assigned", "model-resume", "ready-abort"].includes(mode)) {
      assert.equal(fs.existsSync(marker + ".command"), false);
    }
    record.retirement = retired;
  } catch (error) {
    record.failure = error.stack; throw error;
  } finally {
    record.events = s.events; record.stdout = s.stdout(); record.stderr = s.stderr();
    record.status = record.failure ? "FAIL" : "PASS";
    save();
    /* No scan/taskkill fallback: the native broader owner retains the exact test job. */
    if (record.failure) { s.child.stdin.end(); s.child.stdio[3].destroy(); }
  }
}
function classifyObservation(expected, returned, error) {
  if (expected === "SAME" && returned === true) return "SAME";
  if (expected === "DIFFERENT" && returned === false && error === 1656) return "DIFFERENT";
  return "UNKNOWN";
}
function observationOptions(filename, resolve = path.resolve) {
  if (filename.includes('"')) throw new Error("literal quote refused");
  return '--require "' + resolve(filename).replaceAll("\\", "/") + '"';
}
function diagnosticSession(identity, nativeMode, marker, receipt, options) {
  const child = spawn(config.owner, [nativeMode, identity.path, config.shim, marker, receipt], {
    cwd: config.neutral, stdio: ["pipe", "pipe", "pipe", "pipe"],
    env: { ...process.env, NODE_OPTIONS: options, NODE_PATH: config.publicRoot,
      OWNED_PROBE_PRELOAD: options, OWNED_PROBE_NODE_PATH: config.publicRoot,
      OWNED_PROBE_ROLE: "shim", OWNED_PROBE_MARKER: marker },
  });
  let bytes = Buffer.alloc(0), stdout = "", stderr = "", failure, closed = false, eof = false;
  const events = [], queue = [];
  const append = (value) => fs.appendFileSync(marker + ".jsonl", JSON.stringify({ time: Date.now(), ...value }) + "\n");
  const complete = new Promise((resolve) => child.on("close", (code, signal) => { closed = true; append({ closed: true, code, signal }); resolve({ code, signal }); }));
  child.on("error", (error) => { failure = error; append({ error: error.stack }); });
  child.stdin.on("error", (error) => append({ inputError: error.message }));
  child.stdio[3].on("error", (error) => append({ controlError: error.message }));
  child.stdout.on("data", (chunk) => { stdout += chunk; append({ stdout: chunk.toString() }); });
  child.stdout.on("end", () => { eof = true; append({ stdoutEOF: true }); });
  child.stderr.on("data", (chunk) => { stderr += chunk; append({ stderr: chunk.toString() }); });
  child.stdio[3].on("data", (chunk) => {
    try {
      append({ controlBytes: chunk.toString("hex") }); bytes = Buffer.concat([bytes, chunk]);
      while (bytes.length >= 4) {
        const n = bytes.readUInt32LE(); assert.ok(n <= 16380);
        if (bytes.length < n + 4) break;
        const event = JSON.parse(bytes.subarray(4, n + 4).toString("utf8"));
        assert.equal(event.role, "owner"); events.push(event); queue.push(event); append({ control: event });
        bytes = bytes.subarray(n + 4);
      }
    } catch (error) { failure = error; append({ parserFailure: error.stack }); }
  });
  return { child, events, complete, stdout: () => stdout, stderr: () => stderr, eof: () => eof,
    send(cmd) { append({ sent: cmd }); child.stdio[3].write(encode({ cmd })); },
    async take(stages) {
      const names = [].concat(stages), end = Date.now() + 2000;
      while (Date.now() < end) {
        if (failure) throw failure;
        const i = queue.findIndex((e) => names.includes(e.stage));
        if (i >= 0) return queue.splice(i, 1)[0];
        if (closed) throw Error("diagnostic owner closed awaiting " + names + ": " + stderr);
        await delay(5);
      }
      throw Error("2000ms diagnostic deadline " + names + ": " + stderr);
    }
  };
}
function verifyDiagnosticRetirement(record, receipt, expectedOwned) {
  assert.equal(receipt.sealed, true); assert.equal(receipt.exactJobZero, true);
  assert.equal(receipt.cleanupComplete, true); assert.equal(receipt.apiLogClosed, true);
  assert.equal(receipt.ownedCreated, expectedOwned); assert.equal(receipt.ownedClosed, expectedOwned);
  const api = fs.readFileSync(record.receipt + ".api.jsonl", "utf8").trim().split("\n").map(JSON.parse);
  record.apiCount = api.length;
  const closes = api.filter((e) => e.api === "CloseHandle");
  assert.equal(closes.length, expectedOwned); assert.ok(closes.every((e) => e.ok));
  const clearNames = ["control-duplex", "shim-stdin-write", "shim-result-read", "shim-result-write"];
  for (const name of clearNames) {
    const after = api.find((e) => e.api === "GetHandleInformation-after-fresh" && e.resource === name);
    assert.ok(after && after.ok); assert.equal(after.value & 1, 0);
  }
  assert.equal(record.events.some((e) => e.stage === "peer-handle" || e.stage === "git-audit"), false);
  record.retirement = receipt;
}
async function knownOwnerCalibration(identity, options) {
  const marker = path.join(config.evidence, "known-owner-calibration");
  const receipt = marker + ".receipt.json";
  const record = { name: "known-owner-calibration", identity, marker, receipt, status: "RUNNING" };
  report.calibration.push(record); save();
  const s = diagnosticSession(identity, "--calibrate", marker, receipt, options);
  try {
    const hello = await s.take("diagnostic-hello");
    assert.equal(hello.mode, "calibration"); assert.equal(hello.administrator, false); assert.equal(hello.elevated, false);
    record.ownerPid = hello.ownerPid; s.send("prepare");
    const terminal = await s.take(["calibration-complete", "diagnostic-stop"]);
    s.child.stdin.end();
    record.exit = await s.complete; record.events = s.events;
    const retirement = JSON.parse(fs.readFileSync(receipt, "utf8"));
    verifyDiagnosticRetirement(record, retirement, 46);
    const resources = s.events.filter((e) => e.stage === "cal-resource");
    assert.deepEqual(resources.map((e) => e.name), config.calibrationResources);
    assert.equal(fs.existsSync(marker), false, "suspended calibration root ran");
    assert.equal(s.events.some((e) => e.api === "ResumeThread"), false);
    record.comparisons = s.events.filter((e) => e.stage === "cal-comparison" && !e.modeled);
    record.models = s.events.filter((e) => e.stage === "cal-model" || (e.stage === "cal-comparison" && e.modeled));
    report.models = record.models; assert.equal(record.models.length, 2);
    assert.ok(record.models.every((e) => e.classification === "UNKNOWN" && e.returned === false));
    for (const e of record.comparisons) assert.equal(e.classification, classifyObservation(e.expected, e.returned, e.error));
    const unknown = record.comparisons.find((e) => e.classification === "UNKNOWN");
    if (unknown) {
      record.firstUnknown = unknown;
      throw Error("required calibration UNKNOWN: " + unknown.resource + " expected=" + unknown.expected + " error=" + unknown.error);
    }
    assert.equal(terminal.stage, "calibration-complete"); assert.equal(record.exit.code, 0);
    assert.equal(record.comparisons.length, 26);
    assert.equal(record.comparisons.filter((e) => e.classification === "SAME").length, 13);
    assert.equal(record.comparisons.filter((e) => e.classification === "DIFFERENT").length, 13);
    assert.equal(retirement.models, 2); record.status = "USABLE_FOR_PAIRWISE_CALIBRATION_ONLY";
  } catch (error) { record.status = "STOP"; record.failure = error.stack; throw error; }
  finally {
    record.events = s.events; record.stdout = s.stdout(); record.stderr = s.stderr(); save();
    if (record.status === "STOP") { s.child.stdin.end(); s.child.stdio[3].destroy(); }
  }
}
async function positivePreloadObservation(identity, options) {
  const marker = path.join(config.evidence, identity.version + "-preload-observation"), receipt = marker + ".receipt.json";
  const record = { name: "positive-preload-observation", identity, marker, receipt, status: "RUNNING" };
  report.preloadObservations.push(record); save();
  const s = diagnosticSession(identity, "--preload-observation", marker, receipt, options);
  try {
    const hello = await s.take("diagnostic-hello"); assert.equal(hello.mode, "preload-observation");
    assert.equal(hello.administrator, false); assert.equal(hello.elevated, false);
    record.ownerPid = hello.ownerPid; s.send("prepare");
    const assigned = await s.take("diagnostic-assigned-suspended");
    record.rootPid = assigned.pid; assert.equal(fs.existsSync(marker), false); s.send("resume");
    const ready = await s.take("observation-ready");
    assert.equal(ready.shim.role, "shim"); assert.equal(ready.shim.node, identity.version);
    assert.equal(path.resolve(ready.shim.execPath).toLowerCase(), path.resolve(identity.path).toLowerCase());
    assert.equal(ready.shim.bootstrapNodeOptions, null); assert.equal(ready.shim.bootstrapNodePath, null);
    await delay(100); assert.equal(fs.existsSync(marker + ".command"), false);
    assert.equal(fs.existsSync(marker + ".preload-shim"), false); s.send("start");
    const command = await s.take("observation-command-started"); record.gitPid = command.shim.pid;
    await new Promise((resolve) => s.child.stdin.end("hello\n", resolve)); record.parentFinalInputWriteComplete = true;
    const result = await s.take("observation-result");
    assert.equal(result.shim.code, 0); assert.equal(result.shim.signal, null); assert.equal(result.shim.inputComplete, true);
    assert.equal(result.shim.data.trim(), "ce013625030ba8dba906f756967f9e9ca394464a");
    assert.equal(s.eof(), false); record.resultBeforeDataEOF = true; record.result = result;
    const preload = JSON.parse(fs.readFileSync(marker + ".preload-downstream", "utf8"));
    assert.equal(preload.role, "downstream"); assert.equal(preload.options, options);
    assert.equal(preload.version, identity.version); assert.equal(preload.nodePath, config.publicRoot);
    assert.ok(Number.isInteger(preload.pid) && preload.pid > 0); record.downstream = preload;
    assert.equal(fs.existsSync(marker + ".preload-shim"), false);
    const members = await s.take("job-members");
    const survivors = fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n").map(Number);
    assert.equal(survivors.length, 2); assert.ok(survivors.every((pid) => members.pids.includes(pid)));
    assert.ok(members.pids.includes(record.rootPid)); record.survivors = survivors;
    s.send("cancel"); const retired = await s.take(["observation-retired", "diagnostic-stop"]);
    assert.equal(retired.stage, "observation-retired");
    record.exit = await s.complete; assert.equal(record.exit.code, 0);
    record.events = s.events;
    verifyDiagnosticRetirement(record, JSON.parse(fs.readFileSync(receipt, "utf8")), 10);
    assert.equal(record.events.some((e) => e.stage === "cal-comparison"), false);
    record.status = "POSITIVE_PRELOAD_OBSERVED_ONLY";
  } catch (error) { record.status = "STOP"; record.failure = error.stack; throw error; }
  finally {
    record.events = s.events; record.stdout = s.stdout(); record.stderr = s.stderr(); save();
    if (record.status === "STOP") { s.child.stdin.end(); s.child.stdio[3].destroy(); }
  }
}
async function calibrationExperiment() {
  report.experiment = "known-owner-calibration-only"; report.originalMatrixExecuted = 0;
  report.calibration = []; report.preloadObservations = []; report.models = [];
  report.exclusionQualified = false; report.PR1 = "OPEN"; report.PR2 = "OPEN"; save();
  assert.equal(process.cwd(), config.neutral);
  for (const entry of config.manifest) assert.equal(createHash("sha256").update(fs.readFileSync(entry.path)).digest("hex"), entry.sha256);
  for (const identity of config.nodes) {
    const value = require("node:child_process").spawnSync(identity.path, ["--version"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    assert.equal(value.status, 0); assert.equal(value.stdout.trim(), identity.version);
    assert.equal(createHash("sha256").update(fs.readFileSync(identity.path)).digest("hex"), identity.sha256);
  }
  assert.ok(path.basename(config.preload).includes(" "));
  const options = observationOptions(config.preload);
  report.preloadRepresentation = { filename: config.preload, options, utf8Hex: Buffer.from(options).toString("hex"),
    sourceSha256: createHash("sha256").update(fs.readFileSync(config.preload)).digest("hex") }; save();
  await knownOwnerCalibration(config.nodes[2], options);
  for (const identity of config.nodes) await positivePreloadObservation(identity, options);
  assert.equal(report.cases.length, 0); assert.equal(report.originalMatrixExecuted, 0);
  assert.equal(Object.keys(require.cache).some((name) => /sqlite/i.test(name)), false);
  report.status = "CALIBRATION_COMPLETE — NATIVE_FEASIBILITY_NOT_QUALIFIED"; save();
}
(async () => {
  if (config.experiment === "known-owner-calibration-only") { await calibrationExperiment(); return; }
  assert.notEqual(process.cwd(), config.sourceRoot);
  assert.equal(process.cwd(), config.neutral);
  for (const entry of config.manifest) {
    assert.equal(createHash("sha256").update(fs.readFileSync(entry.path)).digest("hex"), entry.sha256, "public asset changed");
    assert.ok(path.resolve(entry.path).startsWith(path.resolve(config.publicRoot) + path.sep));
  }
  for (const identity of config.nodes) {
    const value = require("node:child_process").spawnSync(identity.path, ["--version"], { encoding: "utf8", env: { ...process.env, NODE_OPTIONS: "" } });
    assert.equal(value.status, 0); assert.equal(value.stdout.trim(), identity.version);
    assert.equal(createHash("sha256").update(fs.readFileSync(identity.path)).digest("hex"), identity.sha256);
    for (const mode of ["normal", "cancel-created", "cancel-assigned", "ready-abort", "model-query", "model-resume", "model-assignment", "parent-loss", "helper-loss"]) {
      await one(identity, mode);
    }
  }
  assert.equal(Object.keys(require.cache).some((name) => /sqlite/i.test(name)), false);
  report.status = "PASS"; save();
})().catch((error) => { report.status = "STOP"; report.failure = error.stack; save(); console.error(error); process.exitCode = 1; });
`

const preloadSource = String.raw`
const fs = require("node:fs");
fs.writeFileSync(process.env.OWNED_PROBE_MARKER + ".preload-" + process.env.OWNED_PROBE_ROLE,
  JSON.stringify({ role: process.env.OWNED_PROBE_ROLE, nodePath: process.env.NODE_PATH, version: process.version,
    pid: process.pid, options: process.env.NODE_OPTIONS }));
`

export const probeMaterial = {
  "probe-owner.c": ownerSource,
  "probe-shim.cjs": shimSource,
  "probe.test.cjs": driverSource,
  "build.ps1": buildSource,
  "preload.cjs": preloadSource,
}

const namedChannelShimSource = `
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const { spawn } = require("node:child_process");
const core = (${channelCore.toString().replace(/\r\n?/g, "\n")})(crypto);
` + String.raw`
let endpoint = process.env.DESK_CHANNEL_ENDPOINT;
let expected = process.env.DESK_CHANNEL_CAPABILITY;
const binding = { protocol: "desk.owned-git-channel-probe/1",
  generation: process.env.DESK_CHANNEL_GENERATION,
  preparationDigest: process.env.DESK_CHANNEL_PREPARATION, payloadDigest: "" };
const nonce = crypto.randomBytes(32).toString("hex");
const state = core.rootState(binding, nonce, expected);
const marker = process.env.DESK_CHANNEL_MARKER, diagnosticMode = process.env.DESK_CHANNEL_MODE;
fs.writeFileSync(marker, "first instruction");
if (!/^\\\\\.\\pipe\\desk-owned-git-[0-9a-f]{64}$/.test(endpoint)) throw Error("channel bootstrap refused");
// One plain byte client, constructed only here. It is never a spawn input.
const socket = net.createConnection({ path: endpoint });
endpoint = undefined; expected = undefined;
for (const key of Object.keys(process.env)) if (/^DESK_CHANNEL_/i.test(key)) delete process.env[key];
let configured, digest = "", resultSent = false, failed = false, inputFinal;
let keepalive;
function refuse() {
  if (failed) return;
  failed = true; state.close(); socket.destroy();
  process.exitCode = 1;
  // Keep owned work tracked until the native deadline retires this root.
  if (!keepalive) keepalive = setInterval(() => {}, 1000);
}
const out = core.writer(socket, refuse);
const send = (type, extra = {}) => out.send({ ...binding, payloadDigest: digest, type, ...extra });
function pressureRootQueue() {
  const value = { ...binding, type: "PRESSURE", padding: "" };
  value.padding = "x".repeat(16384 - core.encode(value).length);
  function pump() {
    try { out.send(value); setImmediate(pump) } catch (error) {
      if (error.message !== "outbound queue full") { refuse(); return }
      try {
        fs.writeFileSync(marker + ".root-queue", JSON.stringify({ ...out.diagnostic(),
          writableLength: socket.writableLength }));
        if (!keepalive) keepalive = setInterval(() => {}, 1000);
      } catch { refuse() }
    }
  }
  function waitForAck() { if (out.diagnostic().frames) setImmediate(waitForAck); else pump() }
  setImmediate(waitForAck);
}
function readPayload(filename, wanted) {
  const fd = fs.openSync(filename, "r");
  let data;
  try {
    const size = fs.fstatSync(fd).size;
    if (!size || size > 1048576) throw Error("payload bound");
    const bytes = Buffer.alloc(size + 1);
    let used = 0, n;
    while ((n = fs.readSync(fd, bytes, used, bytes.length - used, null)) > 0) {
      used += n; if (used > size) throw Error("payload changed");
    }
    if (used !== size) throw Error("payload changed");
    data = bytes.subarray(0, size);
    if (crypto.createHash("sha256").update(data).digest("hex") !== wanted) throw Error("payload binding");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(data);
    if (text.includes("\0")) throw Error("payload NUL");
    const value = JSON.parse(text);
    if (!value || typeof value.executable !== "string" || !value.executable ||
        Object.keys(value).some((key) => !["executable", "args", "cwd", "env", "input", "keepalive"].includes(key)) ||
        (value.keepalive !== undefined && typeof value.keepalive !== "boolean") ||
        typeof value.cwd !== "string" || !value.cwd || !Array.isArray(value.args) ||
        value.args.some((x) => typeof x !== "string" || x.includes("\0")) ||
        !value.env || Array.isArray(value.env) || typeof value.env !== "object" ||
        ![null, "string"].includes(value.input === null ? null : typeof value.input) ||
        value.executable.includes("\0") || value.cwd.includes("\0")) throw Error("payload schema");
    value.env = core.downstreamEnvironment(value.env);
    if (value.input !== null) {
      const input = Buffer.from(value.input, "base64");
      if (input.toString("base64") !== value.input) throw Error("payload input");
      value.input = input;
    }
    return value;
  } finally { fs.closeSync(fd) }
}
function execute() {
  const value = configured; configured = undefined;
  let spawnError = null, bytes = 0, finished = value.input === null, inputClosed = value.input === null;
  let inputError = null, outcome, childClosed = false;
  const safeCode = (error) => /^[A-Z0-9_]{1,80}$/.test(error?.code) ? error.code : "UNKNOWN";
  function final() {
    if (failed || resultSent || !childClosed || !inputClosed) return;
    resultSent = true;
    inputFinal = { state: value.input === null ? "none" : finished && !inputError ? "complete" : "failed",
      length: value.input === null ? 0 : value.input.length, written: bytes, error: inputError };
    const detail = { command: { state: spawnError ? "spawn_error" : "exited", ...outcome, spawnError }, input: inputFinal,
      runtime: { version: process.version, execPath: process.execPath } };
    const encoded = Buffer.from(JSON.stringify(detail)).toString("base64");
    send("RESULT", { detail: encoded });
    if (diagnosticMode === "root-extra-result-after-result") send("RESULT", { detail: encoded });
    const fault = { "root-malformed-after-result": "malformed", "root-trailing-byte-after-result": "trailing-byte",
      "root-partial-header-after-result": "partial-header", "root-partial-body-after-result": "partial-body" }[diagnosticMode];
    if (fault) out.fault(fault);
    out.finish(); // Only named negative fixtures append faults; normal RESULT remains final.
    if (value.keepalive === true && !keepalive) keepalive = setInterval(() => {}, 1000);
  }
  let child;
  try {
    child = spawn(value.executable, value.args, { cwd: value.cwd, env: value.env,
      windowsHide: true, stdio: [value.input === null ? "ignore" : "pipe", "inherit", "inherit"] });
  } catch (error) {
    spawnError = safeCode(error); inputError = spawnError; inputClosed = childClosed = true;
    outcome = { code: null, signal: null }; final(); return;
  }
  if (!child.stdin && value.input !== null) { inputClosed = true; inputError = "STDIN_UNAVAILABLE" }
  child.on("error", (error) => {
    spawnError = safeCode(error);
    if (!child.stdin && value.input !== null) inputError = spawnError;
  });
  child.on("close", (code, signal) => { childClosed = true; outcome = { code, signal }; final() });
  if (child.stdin) {
    child.stdin.on("error", (error) => { inputError = safeCode(error) });
    child.stdin.on("finish", () => { finished = true; bytes = value.input.length });
    child.stdin.on("close", () => { inputClosed = true; final() });
    child.stdin.end(value.input);
  }
  if (diagnosticMode === "root-eof-before-result") out.finish();
}
const parse = core.parser((value) => {
  const action = state.accept(value);
  if (action === "ACK") {
    send("ACK", { nonce, detail: Buffer.from(JSON.stringify({
      version: process.version, execPath: process.execPath,
      bootstrapNodeOptions: process.env.NODE_OPTIONS ?? null, bootstrapNodePath: process.env.NODE_PATH ?? null,
    })).toString("base64") });
    if (diagnosticMode === "root-write-pressure") pressureRootQueue();
  }
  else if (action === "CONFIG") {
    configured = readPayload(value.path, value.payloadDigest);
    digest = value.payloadDigest; send("CONFIGURED");
  } else if (action === "START") execute();
});
socket.on("connect", () => {
  try { fs.appendFileSync(marker + ".channel-open", "open\n"); send("HELLO", { nonce }) } catch { refuse() }
});
socket.on("data", (chunk) => { try { parse.push(chunk) } catch { refuse() } });
socket.on("error", refuse);
socket.on("end", () => { try { parse.end(); if (!resultSent) refuse() } catch { refuse() } });
socket.on("close", () => {
  state.close();
  try { fs.writeFileSync(marker + ".channel-closed", "closed without reconnect") } catch { refuse() }
  if (!resultSent) refuse();
});
`

const namedChannelNativeBody = String.raw`
/* NC1 disposable constructed channel. All I/O below is overlapped, no workers. */
#include <errno.h>
#include <aclapi.h>
#include <fcntl.h>
#define NC_BODY 16380
#define NC_FRAME 16384
typedef struct {
  HANDLE handle; const char *role; int closed;
} NC_RESOURCE;
typedef struct {
  HANDLE h; OVERLAPPED read, write;
  unsigned char input[NC_FRAME], output[2][NC_FRAME];
  DWORD used, target, lengths[2], offset, queued, read_count, write_count;
  DWORD max_queued, pending_reads, pending_writes, partial_reads;
  int reading, writing, eof, stop, cancelling;
} NC_IO;
typedef struct {
  char type[40], protocol[80], generation[65], preparation[65], payload[65];
  char nonce[65], capability[65], name[65], remaining[16], mode[40];
  char path[NC_BODY + 1], detail[NC_BODY + 1], receipt[NC_BODY + 1];
  unsigned fields;
} NC_MESSAGE;
typedef struct {
  NC_IO parent, root; OVERLAPPED connect; int connecting, connected;
  NC_RESOURCE owned[24]; DWORD created, closed;
  HANDLE job; PROCESS_INFORMATION pi; int assigned, resumed, start_issued;
  int prepared, authenticated, configuring, configured, result_seen, control_complete;
  int retiring, terminated, sealed, zero, root_retired, certificate, failed, model_stranded, auxiliary_unproved, allow_peer_hello, root_hold;
  int private_ready, server_close_requested, server_closed;
  BYTE private_sid[SECURITY_MAX_SID_SIZE]; DWORD private_sid_length;
  HANDLE private_directory, payload_file;
  wchar_t private_root[32768];
  char payload_path[NC_BODY + 1];
  char generation[65], preparation[65], payload[65], pending_payload[65], nonce[65], capability[65], suffix[65], mode[40];
  char result[NC_BODY + 1], receipt[NC_BODY + 1], marker[NC_BODY + 1], trace[11000], reason[64];
  size_t trace_used; DWORD trace_count;
  ULONGLONG deadline; wchar_t *node, *shim;
} NC_STATE;
static void nc_fail(NC_STATE *s, const char *reason) {
  if (!s->failed) { s->failed = 1; strcpy_s(s->reason, sizeof(s->reason), reason); }
  s->retiring = 1;
}
static int nc_trace(NC_STATE *s, const char *api, const char *role, BOOL ok, DWORD error, unsigned long long value) {
  int n = snprintf(s->trace + s->trace_used, sizeof(s->trace) - s->trace_used,
    "%s{\"api\":\"%s\",\"resource\":\"%s\",\"ok\":%s,\"error\":%lu,\"value\":%llu}",
    s->trace_count ? "," : "", api, role, ok ? "true" : "false", error, value);
  if (n < 0 || (size_t)n >= sizeof(s->trace) - s->trace_used) { nc_fail(s, "api-trace-full"); return 0; }
  s->trace_used += (size_t)n; s->trace_count++; return 1;
}
static int nc_adopt(NC_STATE *s, HANDLE h, const char *role) {
  if (!h || h == INVALID_HANDLE_VALUE || s->created >= 24) { nc_fail(s, "resource-bound"); return 0; }
  s->owned[s->created].handle = h; s->owned[s->created].role = role; s->created++;
  return nc_trace(s, "Adopt-owned-handle", role, TRUE, 0, (unsigned long long)(uintptr_t)h);
}
static int nc_close(NC_STATE *s, HANDLE h) {
  DWORD i, error; BOOL ok;
  for (i = 0; i < s->created; i++) if (s->owned[i].handle == h && !s->owned[i].closed) {
    SetLastError(0); ok = CloseHandle(h); error = GetLastError();
    nc_trace(s, "CloseHandle", s->owned[i].role, ok, error, (unsigned long long)(uintptr_t)h);
    if (!ok) { nc_fail(s, "close-failed"); return 0; }
    s->owned[i].closed = 1; s->closed++; return 1;
  }
  nc_fail(s, "unowned-close"); return 0;
}
static int nc_flags(NC_STATE *s, HANDLE h, const char *role, int inheritable) {
  BOOL ok; DWORD flags = 0, error;
  SetLastError(0); ok = GetHandleInformation(h, &flags); error = GetLastError();
  nc_trace(s, "GetHandleInformation-fresh", role, ok, error, flags);
  return ok && !!(flags & HANDLE_FLAG_INHERIT) == !!inheritable;
}
static int nc_private(NC_STATE *s, HANDLE h, const char *role) {
  BOOL ok; DWORD error;
  SetLastError(0); ok = SetHandleInformation(h, HANDLE_FLAG_INHERIT, 0); error = GetLastError();
  nc_trace(s, "SetHandleInformation-clear", role, ok, error, 0);
  return ok && nc_flags(s, h, role, 0);
}
static int nc_event(NC_STATE *s, OVERLAPPED *ov, const char *role) {
  ZeroMemory(ov, sizeof(*ov)); SetLastError(0);
  ov->hEvent = CreateEventW(NULL, TRUE, FALSE, NULL);
  nc_trace(s, "CreateEventW", role, ov->hEvent != NULL, GetLastError(), (unsigned long long)(uintptr_t)ov->hEvent);
  return nc_adopt(s, ov->hEvent, role) && nc_flags(s, ov->hEvent, role, 0);
}
static int nc_queue(NC_STATE *s, NC_IO *io, const char *text) {
  size_t n = strlen(text);
  if (!n || n > NC_BODY || io->queued >= 2 || io->stop || io->eof) {
    nc_fail(s, "outbound-queue-full-or-closed"); return 0;
  }
  io->lengths[io->queued] = (DWORD)n + 4;
  { DWORD length = (DWORD)n; memcpy(io->output[io->queued], &length, 4); }
  memcpy(io->output[io->queued] + 4, text, n); io->queued++;
  if (io->queued > io->max_queued) io->max_queued = io->queued;
  return 1;
}
static int nc_parent(NC_STATE *s, const char *stage, const char *extra) {
  char text[NC_BODY + 1]; int n;
  n = snprintf(text, sizeof(text),
    "{\"protocol\":\"desk.owned-git-channel-probe/1\",\"generation\":\"%s\",\"preparationDigest\":\"%s\","
    "\"payloadDigest\":%s%s%s,\"role\":\"owner\",\"stage\":\"%s\","
    "\"ownedCreated\":%lu,\"ownedClosed\":%lu,\"apis\":[%s]%s%s}",
    s->generation, s->preparation, s->payload[0] ? "\"" : "", s->payload[0] ? s->payload : "null",
    s->payload[0] ? "\"" : "", stage, s->created, s->closed, s->trace,
    extra && *extra ? "," : "", extra ? extra : "");
  if (n < 0 || n > NC_BODY) { nc_fail(s, "parent-frame-bound"); return 0; }
  if (!nc_queue(s, &s->parent, text)) return 0;
  SecureZeroMemory(s->trace, sizeof(s->trace)); s->trace_used = 0; s->trace_count = 0; return 1;
}
static int nc_hex(const char *p) {
  size_t i; if (strlen(p) != 64) return 0;
  for (i = 0; i < 64; i++) if (!((p[i] >= '0' && p[i] <= '9') || (p[i] >= 'a' && p[i] <= 'f'))) return 0;
  return 1;
}
static int nc_base64(const char *p) {
  size_t i;
  if (!*p) return 0;
  for (i = 0; p[i]; i++) if (!((p[i] >= 'A' && p[i] <= 'Z') ||
      (p[i] >= 'a' && p[i] <= 'z') || (p[i] >= '0' && p[i] <= '9') ||
      p[i] == '+' || p[i] == '/' || p[i] == '=')) return 0;
  return 1;
}
static int nc_string(const char **cursor, char *out, size_t cap) {
  const unsigned char *p = (const unsigned char *)*cursor; size_t n = 0; unsigned char c;
  if (*p++ != '"') return 0;
  while (*p && *p != '"') {
    c = *p++;
    if (c < 32) return 0;
    if (c == '\\') {
      c = *p++;
      if (c != '"' && c != '\\' && c != '/') return 0;
    }
    if (n + 1 >= cap) return 0; out[n++] = (char)c;
  }
  if (*p++ != '"') return 0;
  out[n] = 0; *cursor = (const char *)p; return 1;
}
/* Flat, typed string envelopes. No substring authority checks or JSON libraries. */
static int nc_parse(const char *text, NC_MESSAGE *m) {
  const char *p = text; char key[40]; char *out; size_t cap; unsigned bit;
  ZeroMemory(m, sizeof(*m));
  if (*p++ != '{') return 0;
  for (;;) {
    if (!nc_string(&p, key, sizeof(key)) || *p++ != ':') return 0;
    out = NULL; cap = 0; bit = 0;
#define NC_FIELD(k, member, b) if (strcmp(key, k) == 0) { out = m->member; cap = sizeof(m->member); bit = 1u << b; }
    NC_FIELD("type", type, 0) NC_FIELD("protocol", protocol, 1)
    NC_FIELD("generation", generation, 2) NC_FIELD("preparationDigest", preparation, 3)
    NC_FIELD("payloadDigest", payload, 4) NC_FIELD("nonce", nonce, 5)
    NC_FIELD("capability", capability, 6) NC_FIELD("name", name, 7)
    NC_FIELD("remaining", remaining, 8) NC_FIELD("mode", mode, 9)
    NC_FIELD("path", path, 10) NC_FIELD("detail", detail, 11) NC_FIELD("receipt", receipt, 12)
#undef NC_FIELD
    if (!out || (m->fields & bit) || !nc_string(&p, out, cap)) return 0;
    m->fields |= bit;
    if (*p == '}') { p++; break; }
    if (*p++ != ',') return 0;
  }
  return *p == 0 && (m->fields & 31) == 31;
}
static int nc_bound(NC_STATE *s, NC_MESSAGE *m, const char *payload) {
  return strcmp(m->protocol, "desk.owned-git-channel-probe/1") == 0 &&
    strcmp(m->generation, s->generation) == 0 && strcmp(m->preparation, s->preparation) == 0 &&
    strcmp(m->payload, payload) == 0;
}
static int nc_root_frame(NC_STATE *s, const char *type, const char *extra) {
  char text[NC_BODY + 1]; int n = snprintf(text, sizeof(text),
    "{\"protocol\":\"desk.owned-git-channel-probe/1\",\"generation\":\"%s\",\"preparationDigest\":\"%s\","
    "\"payloadDigest\":\"%s\",\"type\":\"%s\"%s%s}", s->generation, s->preparation, s->payload,
    type, extra && *extra ? "," : "", extra ? extra : "");
  int ok = n > 0 && n <= NC_BODY && nc_queue(s, &s->root, text);
  SecureZeroMemory(text, sizeof(text)); return ok;
}
typedef struct {
  BYTE bytes[sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) + SECURITY_MAX_SID_SIZE];
  SECURITY_DESCRIPTOR descriptor; SECURITY_ATTRIBUTES attributes;
} NC_FILE_SECURITY;
static int nc_copy_private_sid(NC_STATE *s, PSID sid) {
  DWORD length, error; BOOL ok;
  if (!IsValidSid(sid)) return 0;
  length = GetLengthSid(sid); if (!length || length > sizeof(s->private_sid)) return 0;
  if (s->private_sid_length) return EqualSid(s->private_sid, sid);
  SetLastError(0); ok = CopySid(sizeof(s->private_sid), s->private_sid, sid); error = GetLastError();
  nc_trace(s, "CopySid-TokenUser-only", "private-file-SID", ok, error, length);
  if (ok) s->private_sid_length = length;
  return ok;
}
static int nc_file_security(NC_STATE *s, NC_FILE_SECURITY *security, DWORD mask, BYTE flags) {
  PACL acl = (PACL)security->bytes; PACL checked = NULL; ACCESS_ALLOWED_ACE *ace = NULL;
  DWORD size, revision, error; SECURITY_DESCRIPTOR_CONTROL control_bits; ACL_SIZE_INFORMATION info;
  BOOL ok, present = FALSE, defaulted = TRUE;
  if (!s->private_sid_length || !IsValidSid(s->private_sid)) return 0;
  ZeroMemory(security, sizeof(*security));
  size = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + s->private_sid_length);
#define NC_FILE_SD(call, label) do { SetLastError(0); ok = (call); error = GetLastError(); nc_trace(s, label, "private-file-DACL", ok, error, mask); if (!ok) return 0; } while (0)
  NC_FILE_SD(InitializeAcl(acl, size, ACL_REVISION), "InitializeAcl-private");
  NC_FILE_SD(AddAccessAllowedAceEx(acl, ACL_REVISION, flags, mask, s->private_sid), "AddAccessAllowedAceEx-private");
  NC_FILE_SD(InitializeSecurityDescriptor(&security->descriptor, SECURITY_DESCRIPTOR_REVISION), "InitializeSecurityDescriptor-private");
  NC_FILE_SD(SetSecurityDescriptorOwner(&security->descriptor, s->private_sid, FALSE), "SetSecurityDescriptorOwner-TokenUser");
  NC_FILE_SD(SetSecurityDescriptorDacl(&security->descriptor, TRUE, acl, FALSE), "SetSecurityDescriptorDacl-private");
  NC_FILE_SD(SetSecurityDescriptorControl(&security->descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED), "SetSecurityDescriptorControl-private");
  NC_FILE_SD(IsValidAcl(acl), "IsValidAcl-private");
  NC_FILE_SD(IsValidSecurityDescriptor(&security->descriptor), "IsValidSecurityDescriptor-private");
  NC_FILE_SD(GetSecurityDescriptorDacl(&security->descriptor, &present, &checked, &defaulted), "GetSecurityDescriptorDacl-private");
  NC_FILE_SD(GetSecurityDescriptorControl(&security->descriptor, &control_bits, &revision), "GetSecurityDescriptorControl-private");
  NC_FILE_SD(GetAclInformation(acl, &info, sizeof(info), AclSizeInformation), "GetAclInformation-private");
  NC_FILE_SD(GetAce(acl, 0, (LPVOID *)&ace), "GetAce-private");
#undef NC_FILE_SD
  if (!present || defaulted || checked != acl || !(control_bits & SE_DACL_PROTECTED) ||
      info.AceCount != 1 || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
      ace->Header.AceFlags != flags || ace->Mask != mask ||
      !IsValidSid(&ace->SidStart) || !EqualSid(&ace->SidStart, s->private_sid)) return 0;
  security->attributes.nLength = sizeof(security->attributes);
  security->attributes.bInheritHandle = FALSE;
  security->attributes.lpSecurityDescriptor = &security->descriptor;
  return 1;
}
static int nc_check_file_security(NC_STATE *s, HANDLE handle, DWORD mask, BYTE flags) {
  PSECURITY_DESCRIPTOR descriptor = NULL; PSID owner = NULL; PACL acl = NULL;
  ACCESS_ALLOWED_ACE *ace = NULL; ACL_SIZE_INFORMATION info; SECURITY_DESCRIPTOR_CONTROL bits;
  DWORD error, revision; BOOL good = FALSE, ok;
  error = GetSecurityInfo(handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, NULL, &acl, NULL, &descriptor);
  nc_trace(s, "GetSecurityInfo-private", "private-file-DACL", error == ERROR_SUCCESS, error, mask);
  if (error != ERROR_SUCCESS || !descriptor || !acl) goto done;
  SetLastError(0); ok = GetSecurityDescriptorControl(descriptor, &bits, &revision); error = GetLastError();
  nc_trace(s, "GetSecurityDescriptorControl-readback", "private-file-DACL", ok, error, ok ? bits : 0);
  if (!ok || !(bits & SE_DACL_PROTECTED) || !IsValidSecurityDescriptor(descriptor) ||
      !IsValidAcl(acl) || !IsValidSid(owner) || !EqualSid(owner, s->private_sid)) goto done;
  SetLastError(0); ok = GetAclInformation(acl, &info, sizeof(info), AclSizeInformation); error = GetLastError();
  nc_trace(s, "GetAclInformation-readback", "private-file-DACL", ok, error, ok ? info.AceCount : 0);
  if (!ok || info.AceCount != 1) goto done;
  SetLastError(0); ok = GetAce(acl, 0, (LPVOID *)&ace); error = GetLastError();
  nc_trace(s, "GetAce-readback", "private-file-DACL", ok, error, ok ? ace->Mask : 0);
  good = ok && ace->Header.AceType == ACCESS_ALLOWED_ACE_TYPE && ace->Header.AceFlags == flags &&
    ace->Mask == mask && IsValidSid(&ace->SidStart) && EqualSid(&ace->SidStart, s->private_sid);
done:
  if (descriptor) {
    SetLastError(0); ok = LocalFree(descriptor) == NULL; error = GetLastError();
    nc_trace(s, "LocalFree-security-readback", "private-file-DACL", ok, error, 0); if (!ok) good = FALSE;
  }
  return good;
}
static int nc_private_directory(NC_STATE *s, const wchar_t *root) {
  NC_FILE_SECURITY security; BY_HANDLE_FILE_INFORMATION info; DWORD error; BOOL ok;
  if (!nc_file_security(s, &security, FILE_ALL_ACCESS, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) return 0;
  SetLastError(0); ok = CreateDirectoryW(root, &security.attributes); error = GetLastError();
  nc_trace(s, "CreateDirectoryW-protected-atomic", "private-evidence-root", ok, error, 0);
  if (!ok && error != ERROR_ALREADY_EXISTS) return 0;
  SetLastError(0);
  s->private_directory = CreateFileW(root, FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | READ_CONTROL,
    FILE_SHARE_READ | FILE_SHARE_WRITE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  error = GetLastError();
  nc_trace(s, "CreateFileW-directory-no-delete-share", "private-evidence-root", s->private_directory != INVALID_HANDLE_VALUE, error, 0);
  if (!nc_adopt(s, s->private_directory, "private-evidence-root") ||
      !nc_flags(s, s->private_directory, "private-evidence-root", 0)) return 0;
  SetLastError(0); ok = GetFileInformationByHandle(s->private_directory, &info); error = GetLastError();
  nc_trace(s, "GetFileInformationByHandle-directory", "private-evidence-root", ok, error, ok ? info.dwFileAttributes : 0);
  if (!ok || !(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) ||
      !nc_check_file_security(s, s->private_directory, FILE_ALL_ACCESS, OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE)) return 0;
  return wcscpy_s(s->private_root, 32768, root) == 0;
}
static int nc_private_leaf(NC_STATE *s, const wchar_t *filename) {
  size_t n = wcslen(s->private_root); const wchar_t *leaf;
  if (!n || _wcsnicmp(filename, s->private_root, n) || filename[n] != L'\\') return 0;
  leaf = filename + n + 1;
  return *leaf && !wcschr(leaf, L'\\') && !wcschr(leaf, L'/') && !wcschr(leaf, L':') &&
    wcscmp(leaf, L".") && wcscmp(leaf, L"..");
}
static HANDLE nc_new_private_file(NC_STATE *s, const wchar_t *filename, const char *role) {
  NC_FILE_SECURITY security; HANDLE handle; DWORD error;
  if (!nc_private_leaf(s, filename) || !nc_file_security(s, &security, FILE_ALL_ACCESS, 0)) return INVALID_HANDLE_VALUE;
  SetLastError(0);
  handle = CreateFileW(filename, GENERIC_READ | GENERIC_WRITE, FILE_SHARE_READ,
    &security.attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  error = GetLastError();
  nc_trace(s, "CreateFileW-private-CREATE_NEW", role, handle != INVALID_HANDLE_VALUE, error, (unsigned long long)(uintptr_t)handle);
  if (handle == INVALID_HANDLE_VALUE) return handle;
  if (!nc_flags(s, handle, role, 0) || !nc_check_file_security(s, handle, FILE_ALL_ACCESS, 0)) {
    SetLastError(0); { BOOL ok = CloseHandle(handle); error = GetLastError(); nc_trace(s, "CloseHandle-private-create-failure", role, ok, error, 0); }
    return INVALID_HANDLE_VALUE;
  }
  return handle;
}
static int nc_prepare_private_files(NC_STATE *s, PSID sid) {
  wchar_t root[32768], payload[32768]; wchar_t *slash; HANDLE file;
  if (s->private_ready) return EqualSid(s->private_sid, sid);
  if (!nc_copy_private_sid(s, sid) ||
      !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s->receipt, -1, root, 32768)) return 0;
  slash = wcsrchr(root, L'\\'); if (!slash) return 0; *slash = 0;
  if (!nc_private_directory(s, root)) return 0;
  if (snprintf(s->payload_path, sizeof(s->payload_path), "%s.payload.json", s->marker) < 0 ||
      strlen(s->marker) + strlen(".payload.json") >= sizeof(s->payload_path) ||
      !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s->payload_path, -1, payload, 32768)) return 0;
  file = nc_new_private_file(s, payload, "reserved-payload");
  if (!nc_adopt(s, file, "reserved-payload") || !nc_close(s, file)) return 0;
  s->private_ready = 1;
  return nc_parent(s, "private-root-protected", "\"privateRootProtected\":true,\"payloadPlaceholderProtected\":true");
}
static int nc_lock_payload(NC_STATE *s, const char *filename) {
  wchar_t path[32768]; BY_HANDLE_FILE_INFORMATION info; LARGE_INTEGER size; BOOL ok; DWORD error;
  if (!s->private_ready || strcmp(filename, s->payload_path) ||
      !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, filename, -1, path, 32768) ||
      !nc_private_leaf(s, path)) return 0;
  SetLastError(0);
  s->payload_file = CreateFileW(path, GENERIC_READ | READ_CONTROL, FILE_SHARE_READ, NULL,
    OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL); error = GetLastError();
  nc_trace(s, "CreateFileW-lock-reserved-payload", "configured-payload", s->payload_file != INVALID_HANDLE_VALUE, error, 0);
  if (!nc_adopt(s, s->payload_file, "configured-payload") || !nc_flags(s, s->payload_file, "configured-payload", 0)) return 0;
  SetLastError(0); ok = GetFileInformationByHandle(s->payload_file, &info); error = GetLastError();
  nc_trace(s, "GetFileInformationByHandle-payload", "configured-payload", ok, error, ok ? info.dwFileAttributes : 0);
  if (!ok || (info.dwFileAttributes & (FILE_ATTRIBUTE_REPARSE_POINT | FILE_ATTRIBUTE_DIRECTORY)) ||
      !nc_check_file_security(s, s->payload_file, FILE_ALL_ACCESS, 0)) return 0;
  SetLastError(0); ok = GetFileSizeEx(s->payload_file, &size); error = GetLastError();
  nc_trace(s, "GetFileSizeEx-payload", "configured-payload", ok, error, ok ? (unsigned long long)size.QuadPart : 0);
  return ok && size.QuadPart > 0 && size.QuadPart <= 1048576;
}
static int nc_server(NC_STATE *s, const char *suffix) {
  HANDLE token = NULL; TOKEN_USER *user = NULL; DWORD needed = 0, error, acl_size;
  PACL acl = NULL, checked = NULL; SECURITY_DESCRIPTOR descriptor; SECURITY_DESCRIPTOR_CONTROL bits;
  SECURITY_ATTRIBUTES sa; ACL_SIZE_INFORMATION info; ACCESS_ALLOWED_ACE *ace = NULL;
  BOOL ok, present = FALSE, defaulted = TRUE; DWORD revision; wchar_t name[128];
  int good = 0; const DWORD mask = FILE_GENERIC_READ | FILE_GENERIC_WRITE | SYNCHRONIZE;
  TOKEN_ELEVATION elevation;
  SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY; PSID administrators = NULL; BOOL admin = TRUE;
  SetLastError(0); ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token); error = GetLastError();
  nc_trace(s, "OpenProcessToken", "token-user", ok, error, 0); if (!ok) goto done;
  if (!nc_adopt(s, token, "token-user") || !nc_flags(s, token, "token-user", 0)) goto done;
  SetLastError(0); ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &needed); error = GetLastError();
  nc_trace(s, "GetTokenInformation-elevation", "token-user", ok, error, ok ? elevation.TokenIsElevated : 0);
  if (!ok || elevation.TokenIsElevated) goto done;
  SetLastError(0); ok = AllocateAndInitializeSid(&nt, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS,
    0,0,0,0,0,0, &administrators); error = GetLastError();
  nc_trace(s, "AllocateAndInitializeSid-admin-check-only", "admin-membership-SID", ok, error, 0); if (!ok) goto done;
  SetLastError(0); ok = CheckTokenMembership(NULL, administrators, &admin); error = GetLastError();
  nc_trace(s, "CheckTokenMembership", "admin-membership-SID", ok, error, admin);
  if (!ok || admin) goto done;
  SetLastError(0); ok = GetTokenInformation(token, TokenUser, NULL, 0, &needed); error = GetLastError();
  nc_trace(s, "GetTokenInformation-size", "token-user", ok, error, needed);
  if (ok || error != ERROR_INSUFFICIENT_BUFFER || needed < sizeof(TOKEN_USER) || needed > 65536) goto done;
  user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, needed); if (!user) goto done;
  SetLastError(0); ok = GetTokenInformation(token, TokenUser, user, needed, &needed); error = GetLastError();
  nc_trace(s, "GetTokenInformation-TokenUser", "token-user", ok, error, needed);
  if (!ok || !IsValidSid(user->User.Sid)) goto done;
  if (!nc_prepare_private_files(s, user->User.Sid)) goto done;
  acl_size = (DWORD)(sizeof(ACL) + sizeof(ACCESS_ALLOWED_ACE) - sizeof(DWORD) + GetLengthSid(user->User.Sid));
  acl = (PACL)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, acl_size); if (!acl) goto done;
#define NC_ACL(call, label) do { SetLastError(0); ok = (call); error = GetLastError(); nc_trace(s, label, "server-DACL", ok, error, 0); if (!ok) goto done; } while (0)
  NC_ACL(InitializeAcl(acl, acl_size, ACL_REVISION), "InitializeAcl");
  NC_ACL(AddAccessAllowedAceEx(acl, ACL_REVISION, 0, mask, user->User.Sid), "AddAccessAllowedAceEx");
  NC_ACL(InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION), "InitializeSecurityDescriptor");
  NC_ACL(SetSecurityDescriptorDacl(&descriptor, TRUE, acl, FALSE), "SetSecurityDescriptorDacl");
  NC_ACL(SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED), "SetSecurityDescriptorControl");
  NC_ACL(IsValidAcl(acl), "IsValidAcl");
  NC_ACL(IsValidSecurityDescriptor(&descriptor), "IsValidSecurityDescriptor");
  NC_ACL(GetSecurityDescriptorDacl(&descriptor, &present, &checked, &defaulted), "GetSecurityDescriptorDacl");
  NC_ACL(GetSecurityDescriptorControl(&descriptor, &bits, &revision), "GetSecurityDescriptorControl");
  NC_ACL(GetAclInformation(acl, &info, sizeof(info), AclSizeInformation), "GetAclInformation");
  NC_ACL(GetAce(acl, 0, (LPVOID *)&ace), "GetAce");
  if (!present || defaulted || checked != acl || !(bits & SE_DACL_PROTECTED) ||
      info.AceCount != 1 || ace->Header.AceType != ACCESS_ALLOWED_ACE_TYPE ||
      ace->Header.AceFlags != 0 || ace->Mask != mask ||
      !IsValidSid(&ace->SidStart) || !EqualSid(&ace->SidStart, user->User.Sid)) goto done;
  if (swprintf_s(name, 128, L"\\\\.\\pipe\\desk-owned-git-%hs", suffix) < 0) goto done;
  sa.nLength = sizeof(sa); sa.lpSecurityDescriptor = &descriptor; sa.bInheritHandle = FALSE;
  SetLastError(0);
  s->root.h = CreateNamedPipeW(name,
    (!strcmp(s->mode, "server-read-only") ? PIPE_ACCESS_INBOUND :
     !strcmp(s->mode, "server-write-only") ? PIPE_ACCESS_OUTBOUND : PIPE_ACCESS_DUPLEX) |
    FILE_FLAG_OVERLAPPED | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 16384, 16384, 0, &sa);
  error = GetLastError(); SecureZeroMemory(name, sizeof(name));
  nc_trace(s, "CreateNamedPipeW", "local-server", s->root.h != INVALID_HANDLE_VALUE, error, 1);
  if (s->root.h != INVALID_HANDLE_VALUE)
    good = nc_adopt(s, s->root.h, "local-server") && nc_flags(s, s->root.h, "local-server", 0);
done:
  if (administrators) {
    SetLastError(0); ok = FreeSid(administrators) == NULL; error = GetLastError();
    nc_trace(s, "FreeSid", "admin-membership-SID", ok, error, 0); if (!ok) good = 0;
  }
  if (acl && !HeapFree(GetProcessHeap(), 0, acl)) good = 0;
  if (user && !HeapFree(GetProcessHeap(), 0, user)) good = 0;
  if (token && !nc_close(s, token)) good = 0;
  return good;
#undef NC_ACL
}
static LPWCH nc_environment(NC_STATE *s, const char *suffix) {
  static const wchar_t *keys[] = { L"SystemRoot", L"WINDIR", L"SystemDrive", L"COMSPEC", L"PATH", L"TEMP", L"TMP", L"PATHEXT", L"LANG", L"LC_ALL" };
  LPWCH env = (LPWCH)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536 * sizeof(wchar_t));
  size_t used = 0, i; DWORD n;
  if (!env) return NULL;
  for (i = 0; i < sizeof(keys) / sizeof(keys[0]); i++) {
    wchar_t value[32768]; int count;
    n = GetEnvironmentVariableW(keys[i], value, 32768);
    if (!n) continue;
    if (n >= 32768) goto bad;
    count = swprintf_s(env + used, 65536 - used, L"%ls=%ls", keys[i], value);
    if (count < 0) goto bad; used += (size_t)count + 1;
  }
  {
    int count = swprintf_s(env + used, 65536 - used, L"DESK_CHANNEL_ENDPOINT=\\\\.\\pipe\\desk-owned-git-%hs", suffix);
    if (count < 0) goto bad; used += (size_t)count + 1;
#define NC_ENV(key, val) do { count = swprintf_s(env + used, 65536 - used, L##key L"=%hs", val); if (count < 0) goto bad; used += (size_t)count + 1; } while (0)
    NC_ENV("DESK_CHANNEL_CAPABILITY", s->capability);
    NC_ENV("DESK_CHANNEL_GENERATION", s->generation);
    NC_ENV("DESK_CHANNEL_PREPARATION", s->preparation);
    NC_ENV("DESK_CHANNEL_MODE", s->mode);
#undef NC_ENV
    {
      wchar_t marker[32768];
      if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s->marker, -1, marker, 32768)) goto bad;
      count = swprintf_s(env + used, 65536 - used, L"DESK_CHANNEL_MARKER=%ls", marker);
      if (count < 0) goto bad; used += (size_t)count + 1;
    }
  }
  if (used >= 65535) goto bad;
  env[used] = 0;
  {
    wchar_t *entries[20], *p, *key; size_t count = 0, at, j, out = 0;
    LPWCH sorted = (LPWCH)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, 65536 * sizeof(wchar_t));
    if (!sorted) goto bad;
    for (p = env; *p; p += wcslen(p) + 1) {
      if (count >= 20) { HeapFree(GetProcessHeap(), 0, sorted); goto bad; }
      entries[count++] = p;
    }
    for (at = 1; at < count; at++) {
      key = entries[at]; j = at;
      while (j && _wcsicmp(entries[j - 1], key) > 0) { entries[j] = entries[j - 1]; j--; }
      entries[j] = key;
    }
    for (at = 0; at < count; at++) {
      size_t length = wcslen(entries[at]) + 1;
      memcpy(sorted + out, entries[at], length * sizeof(wchar_t)); out += length;
    }
    SecureZeroMemory(env, 65536 * sizeof(wchar_t));
    memcpy(env, sorted, (out + 1) * sizeof(wchar_t)); SecureZeroMemory(sorted, 65536 * sizeof(wchar_t));
    if (!HeapFree(GetProcessHeap(), 0, sorted)) goto bad;
  }
  return env;
bad:
  SecureZeroMemory(env, 65536 * sizeof(wchar_t)); HeapFree(GetProcessHeap(), 0, env); return NULL;
}
static int nc_launch(NC_STATE *s, const char *suffix) {
  STARTUPINFOEXW si; SIZE_T bytes = 0; BOOL ok; DWORD error, i;
  HANDLE stdio[3] = {NULL,NULL,NULL}, nul = NULL; LPWCH env = NULL; wchar_t line[32768];
  SECURITY_ATTRIBUTES sa = { sizeof(sa), NULL, FALSE };
  unsigned char crt[4 + 3 + 3 * sizeof(intptr_t)]; int count = 3, good = 0;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  ZeroMemory(&si, sizeof(si)); ZeroMemory(&limits, sizeof(limits));
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  SetLastError(0); s->job = CreateJobObjectW(NULL, NULL); error = GetLastError();
  nc_trace(s, "CreateJobObjectW", "retained-job", s->job != NULL, error, 0);
  if (!nc_adopt(s, s->job, "retained-job") || !nc_flags(s, s->job, "retained-job", 0)) goto done;
  SetLastError(0); ok = SetInformationJobObject(s->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)); error = GetLastError();
  nc_trace(s, "SetInformationJobObject", "retained-job", ok, error, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE); if (!ok) goto done;
  if (!nc_server(s, suffix)) goto done;
  if (!strcmp(s->mode, "first-instance-collision")) {
    HANDLE retained = s->root.h;
    int unexpected = nc_server(s, suffix);
    s->root.h = retained;
    if (unexpected) nc_fail(s, "collision-unexpectedly-created");
    else nc_fail(s, "first-instance-collision-refused");
    goto done;
  }
  SetLastError(0); ok = ConnectNamedPipe(s->root.h, &s->connect); error = GetLastError();
  nc_trace(s, "ConnectNamedPipe", "local-server", ok, error, 0);
  if (ok || error == ERROR_PIPE_CONNECTED) s->connected = 1;
  else if (error == ERROR_IO_PENDING) s->connecting = 1;
  else goto done;
  SetLastError(0); nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL); error = GetLastError();
  nc_trace(s, "CreateFileW-NUL", "root-stdin-NUL", nul != INVALID_HANDLE_VALUE, error, 0);
  if (!nc_adopt(s, nul, "root-stdin-NUL") || !nc_flags(s, nul, "root-stdin-NUL", 0)) goto done;
  for (i = 0; i < 3; i++) {
    HANDLE source = i == 0 ? nul : GetStdHandle(i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
    const char *role = i == 0 ? "root-stdin-data-duplicate" : i == 1 ? "root-stdout-data-duplicate" : "root-stderr-data-duplicate";
    SetLastError(0); ok = DuplicateHandle(GetCurrentProcess(), source, GetCurrentProcess(), &stdio[i], 0, TRUE, DUPLICATE_SAME_ACCESS); error = GetLastError();
    nc_trace(s, "DuplicateHandle-data-only", role, ok, error, (unsigned long long)(uintptr_t)stdio[i]);
    if (!ok || !nc_adopt(s, stdio[i], role) || !nc_flags(s, stdio[i], role, 1)) goto done;
  }
  SetLastError(0); ok = InitializeProcThreadAttributeList(NULL, 1, 0, &bytes); error = GetLastError();
  nc_trace(s, "InitializeProcThreadAttributeList-size", "root-allowlist", ok, error, bytes);
  if (ok || error != ERROR_INSUFFICIENT_BUFFER || !bytes) goto done;
  si.lpAttributeList = (LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(), 0, bytes); if (!si.lpAttributeList) goto done;
  SetLastError(0); ok = InitializeProcThreadAttributeList(si.lpAttributeList, 1, 0, &bytes); error = GetLastError();
  nc_trace(s, "InitializeProcThreadAttributeList", "root-allowlist", ok, error, bytes);
  if (!ok) { HeapFree(GetProcessHeap(), 0, si.lpAttributeList); si.lpAttributeList = NULL; goto done; }
  SetLastError(0); ok = UpdateProcThreadAttribute(si.lpAttributeList, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, stdio, sizeof(stdio), NULL, NULL); error = GetLastError();
  nc_trace(s, "UpdateProcThreadAttribute-three-data", "root-allowlist", ok, error, 3); if (!ok) goto done;
  env = nc_environment(s, suffix); if (!env) goto done;
  if (wcschr(s->node, L'"') || wcschr(s->shim, L'"') ||
      swprintf_s(line, 32768, L"\"%ls\" \"%ls\"", s->node, s->shim) < 0) goto done;
  si.StartupInfo.cb = sizeof(si); si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  si.StartupInfo.hStdInput = stdio[0]; si.StartupInfo.hStdOutput = stdio[1]; si.StartupInfo.hStdError = stdio[2];
  ZeroMemory(crt, sizeof(crt)); memcpy(crt, &count, 4);
  for (i = 0; i < 3; i++) {
    intptr_t h = (intptr_t)stdio[i]; crt[4 + i] = (unsigned char)(i == 0 ? 1 | 64 : 1 | 8);
    memcpy(crt + 4 + 3 + i * sizeof(h), &h, sizeof(h));
  }
  si.StartupInfo.cbReserved2 = sizeof(crt); si.StartupInfo.lpReserved2 = crt;
  SetLastError(0); ok = CreateProcessW(s->node, line, &sa, &sa, TRUE,
    CREATE_SUSPENDED | EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
    env, NULL, &si.StartupInfo, &s->pi); error = GetLastError();
  nc_trace(s, "CreateProcessW-suspended-three-stdio", "root-process", ok, error, ok ? s->pi.dwProcessId : 0);
  if (!ok) goto done;
  if (!nc_adopt(s, s->pi.hProcess, "root-process") || !nc_adopt(s, s->pi.hThread, "root-thread") ||
      !nc_flags(s, s->pi.hProcess, "root-process", 0) || !nc_flags(s, s->pi.hThread, "root-thread", 0)) goto done;
  good = 1;
done:
  if (si.lpAttributeList) { DeleteProcThreadAttributeList(si.lpAttributeList); if (!HeapFree(GetProcessHeap(), 0, si.lpAttributeList)) good = 0; }
  if (env) { SecureZeroMemory(env, 65536 * sizeof(wchar_t)); if (!HeapFree(GetProcessHeap(), 0, env)) good = 0; }
  for (i = 0; i < 3; i++) if (stdio[i]) {
    if (!nc_private(s, stdio[i], "data-duplicate-after-create") || !nc_close(s, stdio[i])) good = 0;
  }
  if (nul && nul != INVALID_HANDLE_VALUE && !nc_close(s, nul)) good = 0;
  return good;
}
static int nc_wrong_peer(NC_STATE *s) {
  HANDLE nul = NULL, data[3] = {NULL,NULL,NULL}; PROCESS_INFORMATION peer;
  SECURITY_ATTRIBUTES sa = {sizeof(sa), NULL, FALSE};
  wchar_t line[32768]; char saved_capability[65], saved_marker[NC_BODY + 1];
  LPWCH env = NULL; BOOL ok = FALSE; DWORD i, error, value; int good = 0;
  ZeroMemory(&peer, sizeof(peer));
  SetLastError(0); nul = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &sa, OPEN_EXISTING, 0, NULL); error = GetLastError();
  nc_trace(s, "CreateFileW-NUL-peer", "peer-stdin-NUL", nul != INVALID_HANDLE_VALUE, error, 0);
  if (!nc_adopt(s, nul, "peer-stdin-NUL") || !nc_flags(s, nul, "peer-stdin-NUL", 0)) goto done;
  for (i = 0; i < 3; i++) {
    HANDLE from = i == 0 ? nul : GetStdHandle(i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE);
    SetLastError(0); ok = DuplicateHandle(GetCurrentProcess(), from, GetCurrentProcess(), &data[i], 0, TRUE, DUPLICATE_SAME_ACCESS); error = GetLastError();
    nc_trace(s, "DuplicateHandle-peer-data-only", "peer-data-duplicate", ok, error, (unsigned long long)(uintptr_t)data[i]);
    if (!ok || !nc_adopt(s, data[i], "peer-data-duplicate") || !nc_flags(s, data[i], "peer-data-duplicate", 1)) goto done;
  }
  strcpy_s(saved_capability, sizeof(saved_capability), s->capability);
  strcpy_s(saved_marker, sizeof(saved_marker), s->marker);
  memset(s->capability, '0', 64); s->capability[64] = 0;
  if (strcat_s(s->marker, sizeof(s->marker), ".peer") != 0) goto restore;
  /* Recover only our random suffix from the retained preparation environment. */
  env = nc_environment(s, s->suffix);
restore:
  strcpy_s(s->capability, sizeof(s->capability), saved_capability);
  strcpy_s(s->marker, sizeof(s->marker), saved_marker);
  SecureZeroMemory(saved_capability, sizeof(saved_capability));
  if (!env || swprintf_s(line, 32768, L"\"%ls\" \"%ls\"", s->node, s->shim) < 0) goto done;
  SetLastError(0); ok = launch(line, data, 3, &peer, env); error = GetLastError();
  nc_trace(s, "CreateProcessW-peer-three-data-suspended", "wrong-peer-process", ok, error, ok ? peer.dwProcessId : 0);
  if (!ok) goto done;
  s->auxiliary_unproved = 1;
  if (!nc_adopt(s, peer.hProcess, "wrong-peer-process") || !nc_adopt(s, peer.hThread, "wrong-peer-thread") ||
      !nc_flags(s, peer.hProcess, "wrong-peer-process", 0) || !nc_flags(s, peer.hThread, "wrong-peer-thread", 0)) goto done;
  SetLastError(0); ok = AssignProcessToJobObject(s->job, peer.hProcess); error = GetLastError();
  nc_trace(s, "AssignProcessToJobObject-wrong-peer", "wrong-peer-process", ok, error, peer.dwProcessId);
  if (!ok) {
    SetLastError(0); ok = TerminateProcess(peer.hProcess, 76); error = GetLastError();
    nc_trace(s, "TerminateProcess-unassigned-peer", "wrong-peer-process", ok, error, 0);
    /* A failed peer assignment is HOLD: broader owner reconciles inert work. */
    goto done;
  }
  s->auxiliary_unproved = 0;
  SetLastError(0); value = ResumeThread(peer.hThread); error = GetLastError();
  nc_trace(s, "ResumeThread-wrong-peer", "wrong-peer-thread", value != MAXDWORD, error, value);
  good = value == 1;
done:
  for (i = 0; i < 3; i++) if (data[i]) {
    if (!nc_private(s, data[i], "peer-data-after-create") || !nc_close(s, data[i])) good = 0;
  }
  if (nul && nul != INVALID_HANDLE_VALUE && !nc_close(s, nul)) good = 0;
  if (env) { SecureZeroMemory(env, 65536 * sizeof(wchar_t)); if (!HeapFree(GetProcessHeap(), 0, env)) good = 0; }
  return good;
}
static void nc_cancel(NC_STATE *s, NC_IO *io) {
  BOOL ok; DWORD error;
  if (io->cancelling) return;
  io->stop = 1; io->cancelling = 1;
  if (io->reading) {
    SetLastError(0); ok = CancelIoEx(io->h, &io->read); error = GetLastError();
    nc_trace(s, "CancelIoEx-read", io == &s->root ? "root-channel" : "parent-control", ok, error, 0);
    if (!ok && error != ERROR_NOT_FOUND) nc_fail(s, "cancel-read");
  }
  if (io->writing) {
    SetLastError(0); ok = CancelIoEx(io->h, &io->write); error = GetLastError();
    nc_trace(s, "CancelIoEx-write", io == &s->root ? "root-channel" : "parent-control", ok, error, 0);
    if (!ok && error != ERROR_NOT_FOUND) nc_fail(s, "cancel-write");
  }
}
static int nc_members(NC_STATE *s, char *text, size_t cap) {
  CENSUS list; BOOL ok; DWORD error, i; size_t used = 0; int n;
  SetLastError(0); ok = census(s->job, &list); error = GetLastError();
  nc_trace(s, "QueryInformationJobObject-members", "retained-job", ok, error, ok ? list.count : MAXDWORD);
  if (!ok) return 0;
  n = snprintf(text, cap, "\"pids\":["); if (n < 0) return 0; used = (size_t)n;
  for (i = 0; i < list.count; i++) {
    n = snprintf(text + used, cap - used, "%s%llu", i ? "," : "", (unsigned long long)list.pids[i]);
    if (n < 0 || (size_t)n >= cap - used) return 0; used += (size_t)n;
  }
  if (used + 2 > cap) return 0; text[used] = ']'; text[used + 1] = 0; return 1;
}
static void nc_message(NC_STATE *s, NC_IO *io, const char *raw) {
  NC_MESSAGE *m = (NC_MESSAGE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*m));
  BOOL ok, member = FALSE; DWORD error, value, pid = 0;
  if (!m) { nc_fail(s, "message-allocation"); return; }
  if (!nc_parse(raw, m)) { nc_fail(s, "malformed-envelope"); goto done; }
  if (io == &s->parent) {
    if (!s->prepared) {
      char *end = NULL; unsigned long remaining;
      if (strcmp(m->type, "PREPARE") || strcmp(m->protocol, "desk.owned-git-channel-probe/1") ||
          !nc_hex(m->generation) || !nc_hex(m->preparation) || !nc_hex(m->capability) ||
          !nc_hex(m->name) || m->payload[0] || !m->receipt[0] || !m->path[0] ||
          m->fields != (31u | (1u << 6) | (1u << 7) | (1u << 8) | (1u << 9) | (1u << 10) | (1u << 12))) {
        nc_fail(s, "prepare-schema"); goto done;
      }
      remaining = strtoul(m->remaining, &end, 10);
      if (!end || *end || !remaining || remaining > 10000) { nc_fail(s, "original-deadline"); goto done; }
      { ULONGLONG end = GetTickCount64() + remaining; if (end < s->deadline) s->deadline = end; }
      strcpy_s(s->generation, sizeof(s->generation), m->generation); strcpy_s(s->preparation, sizeof(s->preparation), m->preparation);
      strcpy_s(s->capability, sizeof(s->capability), m->capability); strcpy_s(s->mode, sizeof(s->mode), m->mode);
      strcpy_s(s->receipt, sizeof(s->receipt), m->receipt); s->prepared = 1;
      strcpy_s(s->marker, sizeof(s->marker), m->path);
      strcpy_s(s->suffix, sizeof(s->suffix), m->name);
      if (!nc_launch(s, m->name)) { nc_fail(s, "prepare-resources"); goto done; }
      { char extra[128]; snprintf(extra, sizeof(extra), "\"pid\":%lu,\"administrator\":false,\"elevated\":false", s->pi.dwProcessId);
        nc_parent(s, "created", extra); }
      goto done;
    }
    if (!nc_bound(s, m, !strcmp(m->type, "CONFIG") && !s->configured && !s->configuring ? m->payload : s->payload) ||
        s->retiring) { nc_fail(s, "parent-binding-state"); goto done; }
    if (!strcmp(m->type, "CANCEL") && m->fields == 31) { s->retiring = 1; goto done; }
    if (!strcmp(m->type, "ASSIGN") && m->fields == 31 && !s->assigned && !s->resumed) {
      if (!strcmp(s->mode, "model-assignment")) {
        SetLastError(0); ok = AssignProcessToJobObject(NULL, s->pi.hProcess); error = GetLastError();
        nc_trace(s, "AssignProcessToJobObject-MODEL-invalid", "root-process", ok, error, s->pi.dwProcessId);
        if (ok || !error) { nc_fail(s, "model-assignment-not-refused"); goto done; }
        s->model_stranded = 1; nc_parent(s, "modeled-assignment-refusal", "\"privateCertificate\":false"); goto done;
      }
      SetLastError(0); ok = AssignProcessToJobObject(s->job, s->pi.hProcess); error = GetLastError();
      nc_trace(s, "AssignProcessToJobObject", "root-process", ok, error, s->pi.dwProcessId);
      if (!ok) { nc_fail(s, "assignment"); goto done; }
      s->assigned = 1;
      SetLastError(0); ok = IsProcessInJob(s->pi.hProcess, s->job, &member); error = GetLastError();
      nc_trace(s, "IsProcessInJob", "root-process", ok, error, member);
      if (!ok || !member) { nc_fail(s, "assignment-membership"); goto done; }
      SetLastError(0); value = active(s->job, &ok); error = GetLastError();
      nc_trace(s, "QueryInformationJobObject-assigned", "retained-job", ok, error, value);
      if (!ok || value != 1) { nc_fail(s, "assigned-root-accounting"); goto done; }
      SetLastError(0); value = WaitForSingleObject(s->pi.hProcess, 0); error = GetLastError();
      nc_trace(s, "WaitForSingleObject-assigned-live", "root-process", value == WAIT_TIMEOUT, error, value);
      if (value != WAIT_TIMEOUT) { nc_fail(s, "assigned-root-not-live"); goto done; }
      nc_parent(s, "assigned-suspended", "\"active\":1"); goto done;
    }
    if (!strcmp(m->type, "RESUME") && m->fields == 31 && s->assigned && !s->resumed && !s->allow_peer_hello) {
      if (!strcmp(s->mode, "wrong-same-job-peer")) {
        if (!nc_wrong_peer(s)) nc_fail(s, "wrong-peer-setup");
        else s->allow_peer_hello = 1;
        goto done;
      }
      if (!strcmp(s->mode, "model-resume")) {
        SetLastError(0); value = ResumeThread(NULL); error = GetLastError();
        nc_trace(s, "ResumeThread-MODEL-invalid", "root-thread", value != MAXDWORD, error, value);
        if (value != MAXDWORD || !error) nc_fail(s, "model-resume-not-refused");
        else { nc_parent(s, "modeled-resume-refusal", NULL); s->retiring = 1; }
        goto done;
      }
      SetLastError(0); value = ResumeThread(s->pi.hThread); error = GetLastError();
      nc_trace(s, "ResumeThread", "root-thread", value != MAXDWORD, error, value);
      if (value != 1) { nc_fail(s, "resume"); goto done; }
      s->resumed = 1; goto done;
    }
    if (!strcmp(m->type, "CONFIG") && s->authenticated && !s->configuring && !s->configured &&
        m->fields == (31u | (1u << 10)) && nc_hex(m->payload) && m->path[0]) {
      if (!nc_lock_payload(s, m->path)) { nc_fail(s, "payload-protection-or-lock"); goto done; }
      /* CONFIG changes the accepted digest only upon root CONFIGURED. */
      strcpy_s(s->pending_payload, sizeof(s->pending_payload), m->payload); s->configuring = 1;
      if (!nc_queue(s, &s->root, raw)) nc_fail(s, "config-delivery"); goto done;
    }
    if (!strcmp(m->type, "START") && m->fields == 31 && s->configured && !s->start_issued) {
      s->start_issued = 1; if (!nc_root_frame(s, "START", NULL)) nc_fail(s, "start-delivery"); goto done;
    }
    if (!strcmp(m->type, "SEAL") && m->fields == 31 && s->control_complete) {
      if (!strcmp(s->mode, "model-query")) {
        JOBOBJECT_BASIC_ACCOUNTING_INFORMATION a;
        SetLastError(0); ok = QueryInformationJobObject(NULL, JobObjectBasicAccountingInformation, &a, sizeof(a), NULL); error = GetLastError();
        nc_trace(s, "QueryInformationJobObject-MODEL-invalid", "MODEL-null-job", ok, error, 0);
        if (ok || !error) { nc_fail(s, "model-query-not-refused"); goto done; }
      }
      s->retiring = 1; goto done;
    }
    nc_fail(s, "parent-role-replay");
  } else {
    if (!nc_bound(s, m, s->configuring ? s->pending_payload : s->payload) || s->retiring) { nc_fail(s, "root-binding-state"); goto done; }
    if (!strcmp(m->type, "HELLO") && m->fields == (31u | (1u << 5)) &&
        (s->resumed || s->allow_peer_hello) && !s->nonce[0] && nc_hex(m->nonce)) {
      SetLastError(0); ok = GetNamedPipeClientProcessId(s->root.h, &pid); error = GetLastError();
      nc_trace(s, "GetNamedPipeClientProcessId", "local-server", ok, error, pid); if (!ok) goto peer_bad;
      SetLastError(0); value = GetProcessId(s->pi.hProcess); error = GetLastError();
      nc_trace(s, "GetProcessId-retained", "root-process", value != 0, error, value); if (!value || pid != value) goto peer_bad;
      SetLastError(0); value = WaitForSingleObject(s->pi.hProcess, 0); error = GetLastError();
      nc_trace(s, "WaitForSingleObject-live-root", "root-process", value == WAIT_TIMEOUT, error, value); if (value != WAIT_TIMEOUT) goto peer_bad;
      SetLastError(0); ok = IsProcessInJob(s->pi.hProcess, s->job, &member); error = GetLastError();
      nc_trace(s, "IsProcessInJob-auth", "root-process", ok, error, member); if (!ok || !member) goto peer_bad;
      strcpy_s(s->nonce, sizeof(s->nonce), m->nonce);
      {
        char extra[180], auth_nonce[65], auth_capability[65], saved_generation = s->generation[0];
        const char *type = !strcmp(s->mode, "auth-wrong-role") ? "CONFIG" : "AUTH";
        strcpy_s(auth_nonce, sizeof(auth_nonce), s->nonce); strcpy_s(auth_capability, sizeof(auth_capability), s->capability);
        if (!strcmp(s->mode, "auth-wrong-nonce")) auth_nonce[0] = auth_nonce[0] == '0' ? '1' : '0';
        if (!strcmp(s->mode, "auth-wrong-capability")) auth_capability[0] = auth_capability[0] == '0' ? '1' : '0';
        if (!strcmp(s->mode, "auth-wrong-generation")) s->generation[0] = saved_generation == '0' ? '1' : '0';
        snprintf(extra, sizeof(extra), "\"nonce\":\"%s\",\"capability\":\"%s\"", auth_nonce, auth_capability);
        if (!nc_root_frame(s, type, extra)) nc_fail(s, "auth-delivery");
        if (!strcmp(s->mode, "auth-replay") && !nc_root_frame(s, type, extra)) nc_fail(s, "auth-replay-delivery");
        s->generation[0] = saved_generation;
        SecureZeroMemory(extra, sizeof(extra)); SecureZeroMemory(auth_nonce, sizeof(auth_nonce)); SecureZeroMemory(auth_capability, sizeof(auth_capability));
      }
      goto done;
peer_bad:
      nc_fail(s, "wrong-or-dead-retained-root-peer"); goto done;
    }
    if (!strcmp(m->type, "ACK") && m->fields == (31u | (1u << 5) | (1u << 11)) && s->nonce[0] &&
        !s->authenticated && !strcmp(m->nonce, s->nonce) && nc_base64(m->detail)) {
      s->authenticated = 1; SecureZeroMemory(s->capability, sizeof(s->capability));
      if (!strcmp(s->mode, "root-write-pressure")) s->root_hold = 1;
      if (!strcmp(s->mode, "server-loss-name-reuse")) s->server_close_requested = 1;
      { char extra[NC_BODY + 1]; int n = snprintf(extra, sizeof(extra), "\"detail\":\"%s\"", m->detail);
        if (n < 0 || n > NC_BODY || !nc_parent(s, "ready", extra)) nc_fail(s, "ready-forward"); }
      goto done;
    }
    if (!strcmp(m->type, "CONFIGURED") && m->fields == 31 && s->configuring && !s->configured) {
      strcpy_s(s->payload, sizeof(s->payload), s->pending_payload);
      SecureZeroMemory(s->pending_payload, sizeof(s->pending_payload));
      s->configured = 1; s->configuring = 0;
      if (!nc_close(s, s->payload_file)) { nc_fail(s, "payload-unlock"); goto done; }
      s->payload_file = NULL;
      nc_parent(s, "configured", "\"payloadProtected\":true,\"payloadLockedDuringRootRead\":true"); goto done;
    }
    if (!strcmp(m->type, "RESULT") && m->fields == (31u | (1u << 11)) &&
        s->start_issued && !s->result_seen && m->detail[0]) {
      if (!nc_base64(m->detail)) { nc_fail(s, "result-encoding"); goto done; }
      strcpy_s(s->result, sizeof(s->result), m->detail); s->result_seen = 1;
      { char extra[NC_BODY + 1]; int n = snprintf(extra, sizeof(extra), "\"detail\":\"%s\"", s->result);
        if (n < 0 || n > NC_BODY || !nc_parent(s, "root-result-observed", extra)) nc_fail(s, "result-observation"); }
      goto done;
    }
    nc_fail(s, "root-role-replay");
  }
done:
  SecureZeroMemory(m, sizeof(*m)); if (!HeapFree(GetProcessHeap(), 0, m)) nc_fail(s, "message-free");
}
static void nc_eof(NC_STATE *s, NC_IO *io) {
  io->eof = 1;
  if (io->stop) return;
  if (io == &s->parent) { nc_fail(s, "parent-control-loss"); return; }
  if (io->used || !s->result_seen || s->control_complete) { nc_fail(s, "root-EOF-without-final-boundary"); return; }
  s->control_complete = 1;
  {
    char members_text[4096], extra[NC_BODY + 1]; int n;
    if (!nc_members(s, members_text, sizeof(members_text))) { nc_fail(s, "pre-seal-members"); return; }
    n = snprintf(extra, sizeof(extra), "\"detail\":\"%s\",\"controlEOF\":true,%s", s->result, members_text);
    if (n < 0 || n > NC_BODY || !nc_parent(s, "root-control-complete", extra)) nc_fail(s, "result-forward");
  }
}
static void nc_read_done(NC_STATE *s, NC_IO *io, BOOL ok, DWORD error, DWORD n) {
  io->reading = 0;
  if (!ok) {
    if (io->stop && error == ERROR_OPERATION_ABORTED) return;
    if (error == ERROR_BROKEN_PIPE || error == ERROR_PIPE_NOT_CONNECTED || error == ERROR_NO_DATA) { nc_eof(s, io); return; }
    nc_fail(s, "read-completion"); return;
  }
  if (!n) { nc_eof(s, io); return; }
  if (io->stop) return;
  if (n < io->target - io->used) io->partial_reads++;
  io->used += n;
  if (io->used != io->target) return;
  if (io->target == 4) {
    DWORD length; memcpy(&length, io->input, 4);
    if (!length || length > NC_BODY) { nc_fail(s, "frame-body-bound"); return; }
    io->target = length + 4; return;
  }
  {
    char text[NC_BODY + 1]; int length = (int)io->target - 4;
    memcpy(text, io->input + 4, (size_t)length); text[length] = 0;
    if ((int)strlen(text) != length || !MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, length, NULL, 0))
      nc_fail(s, "frame-encoding");
    else nc_message(s, io, text);
    SecureZeroMemory(text, sizeof(text)); SecureZeroMemory(io->input, sizeof(io->input));
    io->used = 0; io->target = 4;
  }
}
static void nc_write_done(NC_STATE *s, NC_IO *io, BOOL ok, DWORD error, DWORD n) {
  io->writing = 0;
  if (!ok) {
    if (io->stop && error == ERROR_OPERATION_ABORTED) return;
    nc_fail(s, "write-completion"); return;
  }
  if (!n) { nc_fail(s, "zero-write"); return; }
  io->offset += n;
  if (io->offset == io->lengths[0]) {
    SecureZeroMemory(io->output[0], NC_FRAME); io->queued--; io->offset = 0;
    if (io->queued) { memcpy(io->output[0], io->output[1], NC_FRAME); io->lengths[0] = io->lengths[1]; SecureZeroMemory(io->output[1], NC_FRAME); }
  }
}
static void nc_poll(NC_STATE *s, NC_IO *io) {
  BOOL ok; DWORD n = 0, error;
  if (io->reading) {
    SetLastError(0); ok = GetOverlappedResult(io->h, &io->read, &n, FALSE); error = GetLastError();
    if (ok || error != ERROR_IO_INCOMPLETE) {
      nc_trace(s, "GetOverlappedResult-read", io == &s->root ? "root-channel" : "parent-control", ok, error, n);
      nc_read_done(s, io, ok, error, n);
    }
  }
  if (io->writing) {
    SetLastError(0); ok = GetOverlappedResult(io->h, &io->write, &n, FALSE); error = GetLastError();
    if (ok || error != ERROR_IO_INCOMPLETE) {
      nc_trace(s, "GetOverlappedResult-write", io == &s->root ? "root-channel" : "parent-control", ok, error, n);
      nc_write_done(s, io, ok, error, n);
    }
  }
}
static void nc_submit(NC_STATE *s, NC_IO *io) {
  BOOL ok; DWORD n = 0, error;
  if (io->h == INVALID_HANDLE_VALUE || io->stop || io->eof) return;
  if (!io->reading) {
    HANDLE event = io->read.hEvent; ZeroMemory(&io->read, sizeof(io->read)); io->read.hEvent = event;
    if (!ResetEvent(io->read.hEvent)) { nc_fail(s, "read-event-reset"); return; }
    SetLastError(0); ok = ReadFile(io->h, io->input + io->used, io->target - io->used, &n, &io->read); error = GetLastError();
    io->read_count++;
    nc_trace(s, "ReadFile-overlapped", io == &s->root ? "root-channel" : "parent-control", ok, error, n);
    if (!ok && error == ERROR_IO_PENDING) { io->reading = 1; io->pending_reads++; }
    else nc_read_done(s, io, ok, error, n);
  }
  if (!io->writing && io->queued && !io->stop && !io->eof) {
    HANDLE event = io->write.hEvent; ZeroMemory(&io->write, sizeof(io->write)); io->write.hEvent = event;
    if (!ResetEvent(io->write.hEvent)) { nc_fail(s, "write-event-reset"); return; }
    SetLastError(0); ok = WriteFile(io->h, io->output[0] + io->offset, io->lengths[0] - io->offset, &n, &io->write); error = GetLastError();
    io->write_count++;
    nc_trace(s, "WriteFile-overlapped", io == &s->root ? "root-channel" : "parent-control", ok, error, n);
    if (!ok && error == ERROR_IO_PENDING) { io->writing = 1; io->pending_writes++; }
    else nc_write_done(s, io, ok, error, n);
  }
}
static void nc_connect_poll(NC_STATE *s) {
  BOOL ok; DWORD n = 0, error;
  if (!s->connecting) return;
  SetLastError(0); ok = GetOverlappedResult(s->root.h, &s->connect, &n, FALSE); error = GetLastError();
  if (!ok && error == ERROR_IO_INCOMPLETE) return;
  s->connecting = 0;
  nc_trace(s, "GetOverlappedResult-connect", "local-server", ok, error, n);
  if (ok) s->connected = 1;
  else if (!(s->retiring && error == ERROR_OPERATION_ABORTED)) nc_fail(s, "connect-completion");
}
static void nc_retire(NC_STATE *s) {
  BOOL ok; DWORD error, n; JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  if (!s->terminated) {
    s->terminated = 1; nc_cancel(s, &s->root);
    if (s->connecting) {
      SetLastError(0); ok = CancelIoEx(s->root.h, &s->connect); error = GetLastError();
      nc_trace(s, "CancelIoEx-connect", "local-server", ok, error, 0);
      if (!ok && error != ERROR_NOT_FOUND) nc_fail(s, "cancel-connect");
    }
    if (s->pi.hProcess && !s->assigned && !s->model_stranded) {
      SetLastError(0); ok = TerminateProcess(s->pi.hProcess, 74); error = GetLastError();
      nc_trace(s, "TerminateProcess-unassigned", "root-process", ok, error, 0);
      if (!ok) nc_fail(s, "unassigned-retirement");
    }
    if (s->job) {
      SetLastError(0); ok = TerminateJobObject(s->job, 75); error = GetLastError();
      nc_trace(s, "TerminateJobObject", "retained-job", ok, error, 0); s->sealed = ok;
      if (!ok) nc_fail(s, "job-seal");
    }
  }
  if (s->job && s->sealed && !s->zero) {
    SetLastError(0); ok = QueryInformationJobObject(s->job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL); error = GetLastError();
    if (!ok) { nc_trace(s, "QueryInformationJobObject-zero", "retained-job", ok, error, MAXDWORD); nc_fail(s, "job-zero-query"); }
    else if (!accounting.ActiveProcesses) { s->zero = 1; nc_trace(s, "QueryInformationJobObject-zero", "retained-job", TRUE, error, 0); }
  }
  if (s->pi.hProcess && !s->root_retired && !s->model_stranded) {
    SetLastError(0); n = WaitForSingleObject(s->pi.hProcess, 0); error = GetLastError();
    if (n == WAIT_OBJECT_0) { s->root_retired = 1; nc_trace(s, "WaitForSingleObject-root-retired", "root-process", TRUE, error, n); }
    else if (n != WAIT_TIMEOUT) { nc_trace(s, "WaitForSingleObject-root-retired", "root-process", FALSE, error, n); nc_fail(s, "root-wait"); }
  } else if (!s->pi.hProcess) s->root_retired = 1;
}
static FILE *nc_receipt_stream(NC_STATE *s, int closure) {
  wchar_t filename[32768]; HANDLE handle; FILE *file; int n, fd;
  if (!s->private_ready) return NULL;
  n = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, s->receipt, -1, filename, 32768);
  if (!n || (closure && wcscat_s(filename, 32768, L".owner-close.json") != 0)) return NULL;
  handle = nc_new_private_file(s, filename, closure ? "owner-close-file" : "kernel-receipt-file");
  if (handle == INVALID_HANDLE_VALUE) return NULL;
  fd = _open_osfhandle((intptr_t)handle, _O_BINARY | _O_RDWR);
  if (fd < 0) { CloseHandle(handle); return NULL; }
  file = _fdopen(fd, "wb");
  if (!file) { _close(fd); return NULL; }
  return file;
}
static int nc_receipt(NC_STATE *s, const char *text) {
  FILE *file = nc_receipt_stream(s, 0); int printed, closed;
  if (!file) return 0;
  printed = fprintf(file, "%s\n", text); closed = fclose(file); return printed > 0 && closed == 0;
}
static int nc_protected_supervise(int argc, wchar_t **argv) {
  NC_STATE *s; HANDLE token = NULL, file = INVALID_HANDLE_VALUE; TOKEN_USER *user = NULL;
  DWORD size = 0, error, i, n; BOOL ok; wchar_t root[32768]; int result = 1;
  TOKEN_ELEVATION elevation; SID_IDENTIFIER_AUTHORITY nt = SECURITY_NT_AUTHORITY;
  PSID administrators = NULL; BOOL admin = TRUE;
  if (argc != 6) return 90;
  s = (NC_STATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*s)); if (!s) return 91;
  s->parent.h = s->root.h = INVALID_HANDLE_VALUE;
  n = GetEnvironmentVariableW(L"DESK_CHANNEL_EVIDENCE_ROOT", root, 32768);
  if (!n || n >= 32768 || !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, argv[5], -1, s->receipt, sizeof(s->receipt), NULL, NULL)) goto done;
  SetLastError(0); ok = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token); error = GetLastError();
  nc_trace(s, "OpenProcessToken", "supervisor-TokenUser", ok, error, 0);
  if (!ok || !nc_adopt(s, token, "supervisor-TokenUser") || !nc_flags(s, token, "supervisor-TokenUser", 0)) goto done;
  SetLastError(0); ok = GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &size); error = GetLastError();
  nc_trace(s, "GetTokenInformation-elevation", "supervisor-TokenUser", ok, error, ok ? elevation.TokenIsElevated : 0);
  if (!ok || elevation.TokenIsElevated) goto done;
  SetLastError(0); ok = AllocateAndInitializeSid(&nt, 2, SECURITY_BUILTIN_DOMAIN_RID, DOMAIN_ALIAS_RID_ADMINS,
    0,0,0,0,0,0, &administrators); error = GetLastError();
  nc_trace(s, "AllocateAndInitializeSid-admin-check-only", "supervisor-standard-token", ok, error, 0);
  if (!ok) goto done;
  SetLastError(0); ok = CheckTokenMembership(NULL, administrators, &admin); error = GetLastError();
  nc_trace(s, "CheckTokenMembership", "supervisor-standard-token", ok, error, admin);
  if (!ok || admin) goto done;
  size = 0;
  SetLastError(0); ok = GetTokenInformation(token, TokenUser, NULL, 0, &size); error = GetLastError();
  if (ok || error != ERROR_INSUFFICIENT_BUFFER || size < sizeof(TOKEN_USER) || size > 65536) goto done;
  user = (TOKEN_USER *)HeapAlloc(GetProcessHeap(), 0, size); if (!user) goto done;
  SetLastError(0); ok = GetTokenInformation(token, TokenUser, user, size, &size); error = GetLastError();
  nc_trace(s, "GetTokenInformation-TokenUser", "supervisor-TokenUser", ok, error, size);
  if (!ok || !nc_copy_private_sid(s, user->User.Sid) || !nc_close(s, token)) goto done;
  token = NULL;
  if (!nc_private_directory(s, root)) goto done;
  s->private_ready = 1;
  file = nc_new_private_file(s, argv[5], "reserved-broader-receipt");
  if (!nc_adopt(s, file, "reserved-broader-receipt") || !nc_close(s, file)) goto done;
  file = INVALID_HANDLE_VALUE;
  if (!SetEnvironmentVariableW(L"DESK_CHANNEL_PRIVATE_READY", L"1")) goto done;
  /* The frozen supervisor keeps its same job, children, wait bound and real zero query. */
  result = supervise(argc, argv);
done:
  for (i = s->created; i > 0; i--) if (!s->owned[i - 1].closed && !nc_close(s, s->owned[i - 1].handle)) result = 1;
  if (administrators && FreeSid(administrators) != NULL) result = 1;
  if (user && !HeapFree(GetProcessHeap(), 0, user)) result = 1;
  SecureZeroMemory(s, sizeof(*s)); if (!HeapFree(GetProcessHeap(), 0, s)) result = 1;
  return result;
}
static int nc_main(int argc, wchar_t **argv) {
  NC_STATE *s; DWORD i, error, waited, type; int result = 1, crt_rc, crt_error; ULONGLONG original_end;
  if (argc != 4) return 90;
  s = (NC_STATE *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, sizeof(*s)); if (!s) return 91;
  s->parent.h = (HANDLE)_get_osfhandle(3); s->root.h = INVALID_HANDLE_VALUE;
  s->parent.target = s->root.target = 4; s->deadline = GetTickCount64() + 10000;
  s->node = argv[2]; s->shim = argv[3];
  nc_trace(s, "CRT-fd3-borrowed", "parent-fd3", s->parent.h != INVALID_HANDLE_VALUE && s->parent.h != NULL,
    0, (unsigned long long)(uintptr_t)s->parent.h);
  SetLastError(0); type = GetFileType(s->parent.h); error = GetLastError();
  nc_trace(s, "GetFileType", "parent-fd3", type == FILE_TYPE_PIPE, error, type);
  for (i = 0; i < 3; i++) {
    DWORD flags = 0; BOOL ok; HANDLE h;
    const char *role = i == 0 ? "borrowed-owner-stdin" : i == 1 ? "borrowed-owner-stdout" : "borrowed-owner-stderr";
    SetLastError(0); h = GetStdHandle(i == 0 ? STD_INPUT_HANDLE : i == 1 ? STD_OUTPUT_HANDLE : STD_ERROR_HANDLE); error = GetLastError();
    nc_trace(s, "GetStdHandle-borrowed", role, h && h != INVALID_HANDLE_VALUE, error, (unsigned long long)(uintptr_t)h);
    SetLastError(0); ok = GetHandleInformation(h, &flags); error = GetLastError();
    nc_trace(s, "GetHandleInformation-borrowed", role, ok, error, flags);
    if (!ok) nc_fail(s, "borrowed-stdio");
  }
  if (s->parent.h == INVALID_HANDLE_VALUE || !s->parent.h || type != FILE_TYPE_PIPE ||
      !nc_private(s, s->parent.h, "parent-fd3") ||
      !nc_event(s, &s->parent.read, "parent-read-event") || !nc_event(s, &s->parent.write, "parent-write-event") ||
      !nc_event(s, &s->root.read, "root-read-event") || !nc_event(s, &s->root.write, "root-write-event") ||
      !nc_event(s, &s->connect, "connect-event")) nc_fail(s, "initial-handles");
  for (;;) {
    HANDLE waits[6]; DWORD count = 0, timeout; ULONGLONG now;
    nc_poll(s, &s->parent); if (s->root.h != INVALID_HANDLE_VALUE) nc_poll(s, &s->root); nc_connect_poll(s);
    if (s->server_close_requested && !s->server_closed && !s->retiring) {
      nc_cancel(s, &s->root); nc_poll(s, &s->root);
      if (!s->root.reading && !s->root.writing && !s->connecting) {
        DWORD live; char extra[256];
        if (!nc_close(s, s->root.h)) nc_fail(s, "server-loss-close");
        else {
          s->root.h = INVALID_HANDLE_VALUE; s->connected = 0; s->server_closed = 1;
          s->failed = 1; strcpy_s(s->reason, sizeof(s->reason), "diagnostic-server-loss");
          live = WaitForSingleObject(s->pi.hProcess, 0);
          snprintf(extra, sizeof(extra), "\"nativeOwnerPid\":%lu,\"ownerAlive\":true,\"rootAlive\":%s,\"controlComplete\":false",
            GetCurrentProcessId(), live == WAIT_TIMEOUT ? "true" : "false");
          nc_parent(s, "server-closed-owner-live", extra);
        }
      }
    }
    if (s->model_stranded) {
      /* Deliberately suspended in broader supervisor job; no private zero claim. */
      s->retiring = 1; nc_retire(s);
      if (!s->parent.queued && !s->parent.writing && !s->connecting && !s->root.reading && !s->root.writing) {
        nc_cancel(s, &s->parent); nc_poll(s, &s->parent);
        if (!s->parent.reading && !s->parent.writing) { result = s->failed ? 1 : 0; break; }
      }
    }
    now = GetTickCount64();
    if (now >= s->deadline) {
      nc_fail(s, "original-deadline"); nc_retire(s); nc_cancel(s, &s->parent);
      /* No new grace and no freed pending buffer: process teardown is HOLD. */
      ExitProcess(1);
    }
    if (s->pi.hProcess && !s->retiring && s->resumed) {
      SetLastError(0); waited = WaitForSingleObject(s->pi.hProcess, 0); error = GetLastError();
      if (waited != WAIT_TIMEOUT && !s->control_complete) {
        if (waited != WAIT_OBJECT_0) nc_trace(s, "WaitForSingleObject-root", "root-process", FALSE, error, waited);
        /* Read queued result/EOF before deciding that root exit lost control. */
        if (s->root.eof) nc_fail(s, "root-exit-without-control");
      }
    }
    if (s->retiring) {
      nc_retire(s);
      if (s->zero && s->root_retired && !s->auxiliary_unproved && !s->connecting && !s->root.reading && !s->root.writing && !s->certificate) {
        char cert[4096]; int n;
        /* Retain parent control/events until final proof is delivered and joined. */
        for (i = s->created; i > 0; i--) {
          HANDLE h = s->owned[i - 1].handle;
          if (!s->owned[i - 1].closed && h != s->parent.read.hEvent && h != s->parent.write.hEvent &&
              h != s->private_directory) nc_close(s, h);
        }
        n = snprintf(cert, sizeof(cert),
          "{\"protocol\":\"desk.owned-git-channel-probe/1\",\"purpose\":\"probe\",\"generation\":\"%s\","
          "\"preparationDigest\":\"%s\",\"payloadDigest\":%s%s%s,\"sealed\":true,\"exactJobZero\":true,"
          "\"rootRetired\":true,\"startIssued\":%s,\"commandState\":\"%s\",\"controlComplete\":%s,\"failure\":%s,"
          "\"parentMaxQueued\":%lu,\"parentPendingReads\":%lu,\"parentPendingWrites\":%lu,"
          "\"rootMaxQueued\":%lu,\"rootPendingReads\":%lu,\"rootPendingWrites\":%lu,\"parentPartialReads\":%lu,"
          "\"rootBytesAtEOF\":%lu,\"privateRootProtected\":%s}",
          s->generation, s->preparation, s->payload[0] ? "\"" : "", s->payload[0] ? s->payload : "null", s->payload[0] ? "\"" : "",
          s->start_issued ? "true" : "false", !s->start_issued ? "not_started" : s->result_seen ? "reported" : "unknown",
          s->control_complete ? "true" : "false", s->failed ? "true" : "false",
          s->parent.max_queued, s->parent.pending_reads, s->parent.pending_writes,
          s->root.max_queued, s->root.pending_reads, s->root.pending_writes, s->parent.partial_reads,
          s->root.eof ? s->root.used : 0, s->private_ready ? "true" : "false");
        if (n < 0 || n >= (int)sizeof(cert) || !nc_receipt(s, cert)) nc_fail(s, "proof-file-delivery");
        s->certificate = 1;
        { char extra[4300]; snprintf(extra, sizeof(extra), "\"certificate\":%s,\"reason\":\"%s\"", cert, s->reason);
          if (!s->parent.eof) nc_parent(s, "sealed-zero", extra); }
      }
      if (s->certificate && !s->parent.queued && !s->parent.writing) {
        nc_cancel(s, &s->parent); nc_poll(s, &s->parent);
        if (!s->parent.reading && !s->parent.writing) { result = s->failed ? 1 : 0; break; }
      }
    }
    if (!strcmp(s->mode, "parent-control-pressure") && s->authenticated && !s->retiring) {
      char extra[8100]; size_t prefix;
      strcpy_s(extra, sizeof(extra), "\"padding\":\""); prefix = strlen(extra);
      memset(extra + prefix, 'x', 8000); extra[prefix + 8000] = '"'; extra[prefix + 8001] = 0;
      nc_parent(s, "pressure-frame", extra);
    }
    nc_submit(s, &s->parent);
    if (s->connected && !s->retiring && !s->root_hold) nc_submit(s, &s->root);
    if (s->parent.reading) waits[count++] = s->parent.read.hEvent;
    if (s->parent.writing) waits[count++] = s->parent.write.hEvent;
    if (s->root.reading) waits[count++] = s->root.read.hEvent;
    if (s->root.writing) waits[count++] = s->root.write.hEvent;
    if (s->connecting) waits[count++] = s->connect.hEvent;
    /* Root handle is polled above; do not spin a signalled exited-root wait. */
    now = GetTickCount64(); timeout = now >= s->deadline ? 0 : (DWORD)(s->deadline - now);
    if (timeout > 10) timeout = 10;
    if (s->pi.hProcess && !s->root_retired && !s->model_stranded &&
        WaitForSingleObject(s->pi.hProcess, 0) == WAIT_TIMEOUT) waits[count++] = s->pi.hProcess;
    if (!count) { Sleep(timeout); continue; }
    waited = WaitForMultipleObjects(count, waits, FALSE, timeout);
    if (waited == WAIT_FAILED) nc_fail(s, "wait-loop");
  }
  if (s->parent.reading || s->parent.writing || s->root.reading || s->root.writing || s->connecting) ExitProcess(1);
  /* Open the protected final stream while the no-delete-share directory lock is live. */
  {
  FILE *close_file = nc_receipt_stream(s, 1);
  for (i = s->created; i > 0; i--) if (!s->owned[i - 1].closed && !nc_close(s, s->owned[i - 1].handle)) result = 1;
  if (s->closed != s->created || !close_file) result = 1;
  errno = 0; crt_rc = _close(3); crt_error = errno;
  nc_trace(s, "CRT-_close3-errno", "parent-fd3", crt_rc == 0, (DWORD)crt_error, crt_rc == 0);
  if (crt_rc != 0) result = 1;
  if (GetTickCount64() >= s->deadline) { nc_fail(s, "original-deadline-close"); result = 1; }
  {
    char text[NC_BODY + 1]; int n = snprintf(text, sizeof(text),
      "{\"kind\":\"owner-close-diagnostic\",\"protocol\":\"desk.owned-git-channel-probe/1\","
      "\"generation\":\"%s\",\"preparationDigest\":\"%s\",\"ownedCreated\":%lu,\"ownedClosed\":%lu,"
      "\"ownedHandlesClosed\":%s,\"crtControlClosed\":%s,\"kernelCertificateIssued\":%s,"
      "\"modelStranded\":%s,\"apis\":[%s]}",
      s->generation, s->preparation, s->created, s->closed, s->created == s->closed ? "true" : "false",
      crt_rc == 0 ? "true" : "false", s->certificate ? "true" : "false", s->model_stranded ? "true" : "false", s->trace);
    if (close_file) {
      int printed = n > 0 && n <= NC_BODY ? fprintf(close_file, "%s\n", text) : -1;
      int closed = fclose(close_file); if (printed <= 0 || closed != 0) result = 1;
    }
  }
  }
  original_end = s->deadline;
  SecureZeroMemory(s, sizeof(*s)); if (!HeapFree(GetProcessHeap(), 0, s)) result = 1;
  if (GetTickCount64() >= original_end) result = 1;
  return result;
}
`

const namedChannelOwnerSource = ownerSource
  .replace("int wmain(int argc, wchar_t **argv) {", namedChannelNativeBody + "\nint wmain(int argc, wchar_t **argv) {")
  .replace('  if (argc > 1 && wcscmp(argv[1], L"--supervise") == 0)',
    '  if (argc > 1 && wcscmp(argv[1], L"--named-channel") == 0) return nc_main(argc, argv);\n  if (argc > 1 && wcscmp(argv[1], L"--protected-supervise") == 0) return nc_protected_supervise(argc, argv);\n  if (argc > 1 && wcscmp(argv[1], L"--supervise") == 0)')

const namedChannelWorkloadSource = String.raw`
"use strict";
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [role, marker] = process.argv.slice(2);
if (role === "nested" || role === "leaf") {
  fs.appendFileSync(marker + ".survivors", process.pid + "\n");
  if (role === "nested") {
    const leaf = spawn(process.execPath, [__filename, "leaf", marker], { detached: true, stdio: "ignore" });
    leaf.unref();
  }
  setInterval(() => {}, 1000);
} else if (role === "pressure") {
  fs.writeFileSync(marker + ".command", "real pressured Git alias");
  fs.writeFileSync(marker + ".write-entry", "actual data write entered");
  process.stdout.write(Buffer.alloc(262144, 120), () => {
    fs.writeFileSync(marker + ".write-complete", "actual data write callback");
  });
  process.stdin.resume(); setInterval(() => {}, 1000);
} else if (role === "hook") {
  fs.writeFileSync(marker + ".command", "real downstream hook");
  const nested = spawn(process.execPath, [__filename, "nested", marker], { detached: true, stdio: "ignore" });
  nested.unref();
  process.stdin.pause();
  const until = Date.now() + 2000;
  function hashWhenDescendantsReady() {
    if (!fs.existsSync(marker + ".survivors") ||
        fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n").length !== 2) {
      if (Date.now() >= until) { process.exitCode = 1; return; }
      setTimeout(hashWhenDescendantsReady, 5); return;
    }
    const git = spawn("git", ["hash-object", "--stdin"], { stdio: ["pipe", "inherit", "inherit"] });
    process.stdin.pipe(git.stdin); process.stdin.resume();
    git.on("error", () => { process.exitCode = 1 });
    git.on("close", (code) => { process.exitCode = code === null ? 1 : code });
  }
  hashWhenDescendantsReady();
} else throw Error("fixed workload role");
`

const namedChannelDriverSource = `
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn, spawnSync } = require("node:child_process");
const core = (${channelCore.toString().replace(/\r\n?/g, "\n")})(crypto);
` + String.raw`
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const index = process.argv[3] === undefined ? null : Number(process.argv[3]);
const sha = (data) => crypto.createHash("sha256").update(data).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cleanEnvironment = () => Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  /^(SystemRoot|WINDIR|SystemDrive|COMSPEC|PATH|TEMP|TMP|PATHEXT|LANG|LC_ALL)$/i.test(key)));
const original = ["normal", "cancel-created", "cancel-assigned", "ready-abort", "model-query",
  "model-resume", "model-assignment", "parent-loss", "helper-loss"];
const authentication = ["auth-wrong-capability", "auth-wrong-nonce", "auth-wrong-generation",
  "auth-wrong-role", "auth-replay"];
const rootFraming = ["root-malformed-after-result", "root-trailing-byte-after-result",
  "root-partial-header-after-result", "root-partial-body-after-result",
  "root-extra-result-after-result", "root-eof-before-result"];
const supplemental24 = ["first-instance-collision", "wrong-same-job-peer", "configured-cancel",
  "immediate-seal", "failed-git", "parent-control-pressure", "server-read-only", "server-write-only",
  "owner-loss-before-start", "pending-connect-cancel", "root-write-pressure", "full-data-pressure",
  "parent-overlapped-fragment", "ready-peer-failure", "server-loss-name-reuse", "owner-loss-name-reuse"];
const report = { status: "RUNNING", cases: [], stranded: [], nativeQualified: false,
  driver: { version: process.version, execPath: process.execPath }, originalHistorical27Qualified: false };
const reportPath = index === null ? config.report : config.report + "." + index;
const requireProtectedSupervisor = () => {
  if (process.env.DESK_CHANNEL_PRIVATE_READY !== "1" ||
      process.env.DESK_CHANNEL_EVIDENCE_ROOT !== config.evidence) throw Error("protected native supervisor required");
};
const save = () => { requireProtectedSupervisor(); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)) };
function verify() {
  assert.equal(process.cwd(), config.neutral);
  for (const item of config.manifest) assert.equal(sha(fs.readFileSync(item.path)), item.sha256);
  assert.deepEqual(config.nodes.map((n) => n.version), ["v20.0.0", "v22.23.3", "v24.18.0"]);
  for (const identity of config.nodes) {
    assert.equal(sha(fs.readFileSync(identity.path)), identity.sha256.toLowerCase());
    const actual = spawnSync(identity.path, ["--version"], {
      encoding: "utf8", env: cleanEnvironment(), maxBuffer: 1024, timeout: 2000 });
    assert.equal(actual.status, 0); assert.equal(actual.stdout.trim(), identity.version);
  }
}
function session(identity, mode, tag, sharedDeadline = Date.now() + 10000) {
  const deadline = sharedDeadline;
  const generation = crypto.randomBytes(32).toString("hex"), capability = crypto.randomBytes(32).toString("hex");
  const name = crypto.randomBytes(32).toString("hex");
  const preparationDigest = sha(Buffer.from(JSON.stringify({ protocol: "desk.owned-git-channel-probe/1",
    purpose: "probe", generation, role: mode, sequence: tag })));
  const base = { protocol: "desk.owned-git-channel-probe/1", generation, preparationDigest, payloadDigest: "" };
  const receipt = path.join(config.evidence, tag + ".receipt.json");
  const child = spawn(config.owner, ["--named-channel", identity.path, config.shim], {
    cwd: config.neutral, env: cleanEnvironment(), stdio: ["ignore", "pipe", "pipe", "overlapped"],
  });
  const events = [], backlog = [], data = [];
  const privateGate = core.artifactGate(base), deferred = [];
  let stderrTail = Buffer.alloc(0);
  let payloadDigest = "", failure, stdoutBytes = 0, stderrBytes = 0, eof = false, stderrEOF = false, controlEOF = false;
  const log = path.join(config.evidence, tag + ".jsonl");
  const append = (value) => {
    const text = JSON.stringify(value);
    assert.ok(!text.includes(capability) && !text.includes(name), "secret diagnostic refusal");
    if (!privateGateReady) {
      if (deferred.length >= 64) throw Error("private diagnostic queue full");
      deferred.push(text); return;
    }
    fs.appendFileSync(log, text + "\n");
  };
  let privateGateReady = false;
  const closed = new Promise((resolve) => child.on("close", (code, signal) => {
    clearTimeout(timer); append({ ownerClose: { code, signal } }); resolve({ code, signal });
  }));
  const refuse = () => { failure = Error("bounded transport failure"); };
  child.on("error", refuse); child.stdio[3].on("error", refuse);
  child.stdout.on("error", refuse); child.stderr.on("error", refuse);
  child.stdout.on("data", (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > 1048576) { refuse(); return; }
    data.push(chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderrBytes += chunk.length; stderrTail = core.tail(stderrTail, chunk);
    if (stdoutBytes + stderrBytes > 1048576) refuse();
  });
  child.stdout.on("end", () => { eof = true; append({ dataEOF: true }) });
  child.stderr.on("end", () => { stderrEOF = true; append({ stderrEOF: true }) });
  child.stdout.on("close", () => { if (!eof) refuse() });
  child.stderr.on("close", () => { if (!stderrEOF) refuse() });
  const sealBoundary = core.resultBoundary();
  const parser = core.parser((value) => {
    if (value.role !== "owner" || value.protocol !== base.protocol || value.generation !== generation ||
        value.preparationDigest !== preparationDigest || value.payloadDigest !== (payloadDigest || null)) { refuse(); return; }
    if (events.length >= 64) { refuse(); return; }
    if (privateGate.observe(value)) {
      requireProtectedSupervisor(); privateGateReady = true;
      for (const text of deferred) fs.appendFileSync(log, text + "\n");
      deferred.length = 0;
    }
    if (value.stage === "root-control-complete") {
      if (value.controlEOF !== true) { refuse(); return; }
      sealBoundary.result(); sealBoundary.eof(0);
    }
    append({ event: value }); events.push(value); backlog.push(value);
    if (mode === "immediate-seal" && value.stage === "root-control-complete") send("SEAL");
  });
  child.stdio[3].on("data", (bytes) => { try { parser.push(bytes) } catch { refuse() } });
  child.stdio[3].on("end", () => { try { parser.end(); controlEOF = true } catch { refuse() } });
  const out = core.writer(child.stdio[3], refuse, mode === "parent-overlapped-fragment" ? 2 : 0);
  const send = (type, extra = {}) => {
    if (type === "SEAL") sealBoundary.seal();
    out.send({ ...base, payloadDigest, type, ...extra });
  };
  const timer = setTimeout(() => { refuse(); try { send("CANCEL") } catch {} }, Math.max(0, deadline - Date.now()));
  send("PREPARE", { capability, name, remaining: String(Math.max(1, deadline - Date.now())), mode, receipt,
    path: path.join(config.evidence, tag) });
  return {
    child, closed, events, base, receipt, send, deadline, mode,
    get configuredPayload() { return payloadDigest !== "" },
    writePayload: (filename, bytes) => core.preparedFileWrite(fs, filename, bytes, privateGate),
    async rebindName() {
      let connections = 0;
      const server = net.createServer((socket) => { connections++; socket.destroy() });
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("replacement namespace bind incomplete")),
            Math.max(1, Math.min(2000, deadline - Date.now())));
          server.once("error", () => { clearTimeout(timer); reject(Error("replacement namespace bind failed")) });
          server.listen({ path: "\\\\.\\pipe\\desk-owned-git-" + name }, () => { clearTimeout(timer); resolve() });
        });
      } catch {
        try { server.close(() => {}) } catch {}
        throw Error("replacement namespace preparation failed");
      }
      return { connections: () => connections, close: () => new Promise((resolve, reject) =>
        server.close((error) => error ? reject(Error("replacement namespace close failed")) : resolve())) };
    },
    setDigest: (digest) => { payloadDigest = digest },
    pressure: () => child.stdio[3].pause(), resume: () => child.stdio[3].resume(),
    pauseData: () => child.stdout.pause(), resumeData: () => child.stdout.resume(),
    eof: () => eof, stderrEOF: () => stderrEOF, controlEOF: () => controlEOF, failed: () => !!failure,
    stdout: () => Buffer.concat(data).toString("utf8"),
    async take(stage) {
      const until = Date.now() + 2000;
      while (Date.now() < until) {
        if (failure) throw failure;
        const at = backlog.findIndex((x) => x.stage === stage);
        if (at !== -1) return backlog.splice(at, 1)[0];
        if (child.exitCode !== null) throw Error("owner exited before expected stage");
        await delay(5);
      }
      throw Error("2000ms observation incomplete");
    },
    finalDiagnostics: () => ({ stdoutBytes, stderrBytes, stderrTailBytes: stderrTail.length,
      stdoutEOF: eof, stderrEOF, controlEOF, failure: !!failure,
      outbound: out.diagnostic(), parserHighWater: parser.highWater() }),
  };
}
function payload(identity, marker, mode) {
  const options = '--require "' + config.preload.replaceAll("\\", "/") + '"';
  const alias = '!"' + identity.path.replaceAll("\\", "/") + '" "' +
    config.workload.replaceAll("\\", "/") + '" ' + (mode === "full-data-pressure" ? "pressure" : "hook") +
    ' "' + marker.replaceAll("\\", "/") + '"';
  return { executable: "git", args: mode === "failed-git" ? ["definitely-not-a-git-command"] :
    ["-c", "alias.probe=" + alias, "probe"], cwd: config.neutral, keepalive: true,
    env: { ...process.env, NODE_OPTIONS: options, NODE_PATH: config.publicRoot,
      OWNED_PROBE_ROLE: "downstream", OWNED_PROBE_MARKER: marker },
    input: Buffer.from("hello\n").toString("base64") };
}
function validateOwnerClose(s) {
  const filename = s.receipt + ".owner-close.json";
  assert.ok(fs.statSync(filename).size <= 16380);
  const value = JSON.parse(fs.readFileSync(filename, "utf8"));
  assert.equal(value.kind, "owner-close-diagnostic"); assert.equal(value.protocol, s.base.protocol);
  assert.equal(value.generation, s.base.generation); assert.equal(value.preparationDigest, s.base.preparationDigest);
  const expected = s.mode === "first-instance-collision" ? 11 : s.mode === "wrong-same-job-peer" ? 22 :
    s.configuredPayload ? 17 : 16;
  assert.equal(value.ownedCreated, expected); assert.equal(value.ownedClosed, expected);
  assert.equal(value.ownedHandlesClosed, true); assert.equal(value.crtControlClosed, true);
  assert.equal(value.modelStranded, s.mode === "model-assignment");
  assert.equal(value.kernelCertificateIssued, s.mode !== "model-assignment");
  return value;
}
function validateCertificate(s, digest, started, failure) {
  validateOwnerClose(s);
  const proof = JSON.parse(fs.readFileSync(s.receipt, "utf8"));
  assert.equal(proof.protocol, s.base.protocol); assert.equal(proof.generation, s.base.generation);
  assert.equal(proof.preparationDigest, s.base.preparationDigest); assert.equal(proof.purpose, "probe");
  assert.equal(proof.payloadDigest, digest); assert.equal(proof.sealed, true);
  assert.equal(proof.exactJobZero, true); assert.equal(proof.rootRetired, true);
  assert.equal(proof.privateRootProtected, true);
  assert.equal(proof.startIssued, started); assert.equal(proof.failure, failure);
  if (!started) assert.equal(proof.commandState, "not_started");
  return proof;
}
async function one(identity, mode, tag) {
  const record = { mode, parent: process.version, root: identity.version, status: "ATTEMPTED" };
  report.cases.push(record); save();
  const s = session(identity, mode, tag), marker = path.join(config.evidence, tag);
  let digest = null, started = false, rootPid, other, replacement, expectedFailure = false;
  try {
    if (mode === "first-instance-collision") {
      const closed = await s.closed; assert.equal(closed.code, 1);
      record.proof = validateCertificate(s, null, false, true);
      assert.ok(!s.events.some((x) => x.stage === "created" || x.stage === "ready"));
      const creates = s.events.flatMap((e) => e.apis ?? []).filter((a) => a.api === "CreateNamedPipeW");
      assert.equal(creates.length, 2); assert.equal(creates[0].ok, true);
      assert.equal(creates[1].ok, false); assert.equal(creates[1].error, 5);
      record.status = "OBSERVED_EXPECTED"; return;
    }
    const created = await s.take("created"); rootPid = created.pid;
    assert.equal(created.administrator, false); assert.equal(created.elevated, false);
    assert.equal(fs.existsSync(marker), false);
    if (mode === "cancel-created") s.send("CANCEL");
    else {
      s.send("ASSIGN");
      if (mode === "model-assignment") {
        await s.take("modeled-assignment-refusal"); assert.equal((await s.closed).code, 0);
        assert.equal(fs.existsSync(s.receipt), false); report.stranded.push(rootPid);
        record.ownerClose = validateOwnerClose(s);
        record.status = "OBSERVED_EXPECTED"; return;
      }
      await s.take("assigned-suspended");
      assert.equal(fs.existsSync(marker), false);
      assert.equal(fs.existsSync(marker + ".command"), false);
      if (mode === "cancel-assigned" || mode === "pending-connect-cancel") {
        if (mode === "pending-connect-cancel") {
          const calls = s.events.flatMap((e) => e.apis ?? []);
          assert.ok(calls.some((a) => a.api === "ConnectNamedPipe" && a.ok === false && a.error === 997));
        }
        s.send("CANCEL");
      }
      else {
        if (mode === "parent-control-pressure") s.pressure();
        s.send("RESUME");
        if (mode === "model-resume") await s.take("modeled-resume-refusal");
        else if (authentication.includes(mode) || ["wrong-same-job-peer", "server-read-only", "server-write-only"].includes(mode)) {
          assert.equal((await s.closed).code, 1);
          record.proof = validateCertificate(s, null, false, true);
          assert.equal(fs.existsSync(marker + ".command"), false);
          if (mode === "wrong-same-job-peer") {
            assert.equal(fs.existsSync(marker), false);
            const lookups = s.events.flatMap((event) => event.apis ?? []).filter((api) => api.api === "GetNamedPipeClientProcessId");
            assert.equal(lookups.length, 1); assert.equal(lookups[0].ok, true); assert.notEqual(lookups[0].value, rootPid);
          }
          if (mode === "server-read-only" || mode === "server-write-only") {
            assert.ok(!s.events.some((e) => e.stage === "ready"));
            assert.ok(s.events.flatMap((e) => e.apis ?? []).some((a) =>
              (a.api === "GetOverlappedResult-connect" && a.ok) ||
              (a.api === "ConnectNamedPipe" && (a.ok || a.error === 535))));
          }
          record.status = "OBSERVED_EXPECTED"; return;
        } else if (mode === "parent-control-pressure") {
          await delay(400); s.resume();
          assert.equal((await s.closed).code, 1);
          record.proof = validateCertificate(s, null, false, true);
          assert.equal(record.proof.parentMaxQueued, 2);
          assert.ok(record.proof.parentPendingWrites >= 1);
          assert.equal(fs.existsSync(marker + ".command"), false);
          record.status = "OBSERVED_EXPECTED"; return;
        } else {
          const ready = await s.take("ready");
          const bootstrap = JSON.parse(Buffer.from(ready.detail, "base64").toString("utf8"));
          assert.equal(bootstrap.version, identity.version);
          assert.equal(bootstrap.execPath.toLowerCase(), identity.path.toLowerCase());
          assert.equal(bootstrap.bootstrapNodeOptions, null); assert.equal(bootstrap.bootstrapNodePath, null);
          assert.equal(fs.existsSync(marker), true);
          if (mode !== "server-loss-name-reuse") await delay(100);
          assert.equal(fs.existsSync(marker + ".command"), false);
          assert.equal(fs.existsSync(marker + ".preload-shim"), false);
          if (mode === "server-loss-name-reuse") {
            const loss = await s.take("server-closed-owner-live");
            assert.equal(loss.ownerAlive, true); assert.equal(loss.rootAlive, true);
            assert.equal(s.child.exitCode, null); assert.equal(loss.controlComplete, false);
            const until = Math.min(Date.now() + 2000, s.deadline);
            while (!fs.existsSync(marker + ".channel-closed") && Date.now() < until) await delay(5);
            assert.equal(fs.existsSync(marker + ".channel-closed"), true);
            replacement = await s.rebindName();
            await delay(100);
            assert.equal(replacement.connections(), 0);
            assert.equal(fs.readFileSync(marker + ".channel-open", "utf8"), "open\n");
            record.originalConnections = 1; record.replacementConnections = replacement.connections();
            assert.equal(s.child.exitCode, null);
            await replacement.close(); replacement = undefined;
            record.boundary = "server endpoint closed; native owner and retained root observed live, NOT process death";
            record.replacementNameReused = true; expectedFailure = true; s.send("CANCEL");
          } else if (mode === "owner-loss-name-reuse") {
            assert.equal(s.child.kill(), true); await s.closed;
            await delay(100);
            replacement = await s.rebindName(); await delay(100);
            assert.equal(replacement.connections(), 0);
            record.replacementConnections = replacement.connections();
            await replacement.close(); replacement = undefined;
            assert.equal(fs.existsSync(s.receipt), false);
            assert.ok(!s.events.some((e) => e.stage === "sealed-zero"));
            assert.equal(fs.existsSync(marker + ".command"), false);
            record.boundary = "literal native owner process termination; no private certificate";
            record.replacementNameReused = true; record.status = "OWNER_LOSS_UNKNOWN_EXPECTED"; return;
          } else if (mode === "ready-peer-failure") {
            other = session(identity, "first-instance-collision", tag + ".other", s.deadline);
            assert.equal((await other.closed).code, 1);
            record.otherProof = validateCertificate(other, null, false, true);
            const creates = other.events.flatMap((e) => e.apis ?? []).filter((a) => a.api === "CreateNamedPipeW");
            assert.equal(creates.length, 2); assert.equal(creates[0].ok, true);
            assert.equal(creates[1].ok, false); assert.equal(creates[1].error, 5);
            assert.notEqual(other.base.generation, s.base.generation);
            assert.equal(fs.existsSync(marker + ".command"), false);
            s.send("CANCEL");
          } else if (mode === "root-write-pressure") {
            const until = Date.now() + 2000;
            while (!fs.existsSync(marker + ".root-queue") && Date.now() < until) await delay(5);
            const queue = JSON.parse(fs.readFileSync(marker + ".root-queue", "utf8"));
            assert.equal(queue.frames, 2); assert.equal(queue.bytes, 32768);
            assert.ok(queue.writableLength > 0); record.rootQueue = queue;
            s.send("CANCEL");
          } else if (mode === "owner-loss-before-start") {
            assert.equal(s.child.kill(), true); await s.closed;
            assert.equal(fs.existsSync(marker + ".command"), false);
            assert.equal(fs.existsSync(s.receipt), false);
            assert.ok(!s.events.some((x) => x.stage === "sealed-zero"));
            record.status = "OWNER_LOSS_UNKNOWN_EXPECTED"; return;
          } else if (mode === "ready-abort") s.send("CANCEL");
          else if (mode === "parent-loss") {
            s.child.stdio[3].destroy();
            assert.equal((await s.closed).code, 1);
            record.proof = validateCertificate(s, null, false, true);
            record.status = "OBSERVED_EXPECTED"; return;
          } else {
            const bytes = Buffer.from(JSON.stringify(payload(identity, marker, mode)));
            assert.ok(bytes.length <= 1048576); digest = sha(bytes);
            const filename = marker + ".payload.json"; s.writePayload(filename, bytes);
            s.send("CONFIG", { payloadDigest: digest, path: filename });
            s.setDigest(digest);
            const configured = await s.take("configured");
            assert.equal(configured.payloadProtected, true); assert.equal(configured.payloadLockedDuringRootRead, true);
            if (mode === "configured-cancel") s.send("CANCEL");
            else {
              if (mode === "full-data-pressure") s.pauseData();
              started = true; s.send("START");
              if (rootFraming.includes(mode)) {
                if (mode !== "root-eof-before-result") {
                  const observed = await s.take("root-result-observed");
                  const result = JSON.parse(Buffer.from(observed.detail, "base64").toString("utf8"));
                  assert.equal(result.command.code, 0); assert.equal(result.command.signal, null);
                  assert.equal(result.command.spawnError, null);
                  assert.deepEqual(result.input, { state: "complete", length: 6, written: 6, error: null });
                  assert.equal(result.runtime.version, identity.version);
                  assert.equal(result.runtime.execPath.toLowerCase(), identity.path.toLowerCase());
                  record.result = result;
                }
                const closed = await s.closed; assert.equal(closed.code, 1);
                record.proof = validateCertificate(s, digest, true, true);
                assert.equal(record.proof.controlComplete, false);
                assert.ok(!s.events.some((e) => e.stage === "root-control-complete"));
                assert.throws(() => s.send("SEAL"), /EOF/);
                if (mode === "root-eof-before-result") {
                  assert.equal(record.proof.commandState, "unknown");
                  assert.ok(!s.events.some((e) => e.stage === "root-result-observed"));
                } else {
                  assert.equal(record.proof.commandState, "reported");
                  assert.match(s.stdout(), /ce013625030ba8dba906f756967f9e9ca394464a/);
                  const preload = JSON.parse(fs.readFileSync(marker + ".preload-downstream", "utf8"));
                  assert.equal(preload.role, "downstream"); assert.equal(preload.nodePath, config.publicRoot);
                  assert.equal(fs.existsSync(marker + ".preload-shim"), false);
                }
                assert.equal(s.eof(), true); assert.equal(s.stderrEOF(), true); assert.equal(s.controlEOF(), true);
                assert.equal(s.failed(), false);
                const partial = { "root-trailing-byte-after-result": 1,
                  "root-partial-header-after-result": 2, "root-partial-body-after-result": 5 }[mode];
                if (partial) assert.equal(record.proof.rootBytesAtEOF, partial);
                record.status = "ROOT_CONTROL_REFUSAL_WITH_REAL_RETIREMENT_EXPECTED"; return;
              }
              if (mode === "full-data-pressure") {
                const until = Date.now() + 2000;
                while (!fs.existsSync(marker + ".command") && Date.now() < until) await delay(5);
                assert.equal(fs.existsSync(marker + ".command"), true);
                while (!fs.existsSync(marker + ".write-entry") && Date.now() < until) await delay(5);
                assert.equal(fs.existsSync(marker + ".write-entry"), true);
                await delay(100);
                assert.equal(fs.existsSync(marker + ".write-complete"), false, "pressure must be observed before cancellation");
                s.send("CANCEL"); await s.take("sealed-zero"); s.resumeData();
                assert.equal((await s.closed).code, 0);
                assert.equal(s.eof(), true); assert.equal(s.stderrEOF(), true); assert.equal(s.controlEOF(), true);
                record.proof = validateCertificate(s, digest, true, false);
                assert.equal(record.proof.commandState, "unknown"); assert.equal(record.proof.controlComplete, false);
                record.status = "CANCELLED_START_WITHOUT_RESULT_EXPECTED"; return;
              }
              const complete = await s.take("root-control-complete");
              assert.equal(complete.controlEOF, true);
              const result = JSON.parse(Buffer.from(complete.detail, "base64").toString("utf8"));
              record.result = result;
              assert.equal(result.runtime.version, identity.version);
              assert.equal(result.runtime.execPath.toLowerCase(), identity.path.toLowerCase());
              if (mode === "failed-git") {
                assert.equal(result.command.spawnError, null);
                assert.equal(Number.isInteger(result.command.code), true); assert.notEqual(result.command.code, 0);
              }
              else {
                assert.equal(result.command.spawnError, null);
                assert.equal(result.command.code, 0); assert.equal(result.command.signal, null);
                assert.deepEqual(result.input, { state: "complete", length: 6, written: 6, error: null });
                const hashUntil = Date.now() + 2000;
                while (!s.stdout().includes("ce013625030ba8dba906f756967f9e9ca394464a") && Date.now() < hashUntil) await delay(5);
                assert.match(s.stdout(), /ce013625030ba8dba906f756967f9e9ca394464a/);
                if (mode !== "immediate-seal") assert.equal(s.eof(), false);
                const until = Date.now() + 2000;
                while ((!fs.existsSync(marker + ".survivors") ||
                    fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n").length !== 2) && Date.now() < until) await delay(5);
                const survivors = fs.readFileSync(marker + ".survivors", "utf8").trim().split("\n").map(Number);
                assert.equal(survivors.length, 2);
                assert.ok(complete.pids.includes(rootPid));
                for (const pid of survivors) assert.ok(complete.pids.includes(pid));
                assert.ok(complete.pids.length >= 3);
                const preload = JSON.parse(fs.readFileSync(marker + ".preload-downstream", "utf8"));
                assert.equal(preload.role, "downstream"); assert.equal(preload.nodePath, config.publicRoot);
                assert.equal(fs.existsSync(marker + ".preload-shim"), false);
              }
              if (mode !== "immediate-seal") assert.ok(!s.events.some((x) => x.stage === "sealed-zero"));
              if (mode === "helper-loss") {
                assert.equal(s.child.kill(), true); await s.closed;
                assert.ok(!s.events.some((x) => x.stage === "sealed-zero"));
                assert.equal(fs.existsSync(s.receipt), false);
                record.status = "OBSERVED_EXPECTED"; return;
              }
              // Ordinary immediate policy and diagnostic hold both require the EOF event.
              if (mode !== "immediate-seal") s.send("SEAL");
            }
          }
        }
      }
    }
    const terminal = await s.take("sealed-zero");
    const closed = await s.closed;
    assert.equal(closed.code, expectedFailure ? 1 : 0); assert.equal(s.controlEOF(), true);
    assert.equal(closed.signal, null); assert.equal(s.eof(), true); assert.equal(s.stderrEOF(), true);
    record.proof = validateCertificate(s, digest, started, expectedFailure);
    if (mode === "parent-overlapped-fragment") {
      assert.ok(record.proof.parentPartialReads >= 1);
      assert.ok(record.proof.parentPendingReads >= 1);
    }
    assert.deepEqual(terminal.certificate, record.proof);
    assert.equal(s.failed(), false);
    if (!started) assert.equal(fs.existsSync(marker + ".command"), false);
    record.status = "OBSERVED_EXPECTED";
  } finally {
    if (replacement) await replacement.close();
    record.diagnostics = s.finalDiagnostics(); save();
    if (other && other.child.exitCode === null && other.child.signalCode === null) {
      try { other.send("CANCEL") } catch {}
      other.child.stdio[3].resume();
    }
    if (s.child.exitCode === null && s.child.signalCode === null) {
      try { s.send("CANCEL") } catch {}
      s.child.stdio[3].resume();
    }
  }
}
async function main() {
  requireProtectedSupervisor(); verify();
  if (index === null) {
    for (let i = 0; i < config.nodes.length; i++) {
      const identity = config.nodes[i];
      const child = spawn(identity.path, [__filename, process.argv[2], String(i)], {
        cwd: config.neutral, env: { ...cleanEnvironment(), DESK_CHANNEL_PRIVATE_READY: "1",
          DESK_CHANNEL_EVIDENCE_ROOT: config.evidence }, stdio: "inherit" });
      const code = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve) });
      assert.equal(code, 0);
      const worker = JSON.parse(fs.readFileSync(config.report + "." + i, "utf8"));
      assert.equal(worker.status, "CORPUS_OBSERVED_NOT_ADJUDICATED");
      report.cases.push(...worker.cases); report.stranded.push(...worker.stranded); save();
    }
  } else {
    assert.equal(process.version, config.nodes[index].version);
    assert.equal(sha(fs.readFileSync(process.execPath)), config.nodes[index].sha256.toLowerCase());
    for (const mode of [...original, ...authentication, ...rootFraming, ...(index === 2 ? supplemental24 : [])])
      await one(config.nodes[index], mode, index + "-" + mode);
    if (index === 0) await one(config.nodes[2], "immediate-seal", "cross-parent20-root24");
  }
  report.status = "CORPUS_OBSERVED_NOT_ADJUDICATED"; save();
}
main().catch(() => { report.status = "STOP"; report.failure = "bounded candidate failure; inspect typed receipts"; save(); process.exitCode = 1 });
`

export const channelProbeMaterial = {
  "probe-owner.c": namedChannelOwnerSource,
  "probe-shim.cjs": namedChannelShimSource,
  "probe.test.cjs": namedChannelDriverSource,
  "channel-workload.cjs": namedChannelWorkloadSource,
  "build.ps1": buildSource,
  "preload.cjs": preloadSource,
}

function assertChannelCandidateSources(material = channelProbeMaterial) {
  const expected = {
    "probe-owner.c": "6bde1098cce18a11a9f035a1dd65d3b1dbd720c8f4dde3482ad1e695e800b865",
    "probe-shim.cjs": "c6564e7df22084e008445e29b4eff45db9f4c5ae93e2a34e1615d8a9abe0975b",
    "probe.test.cjs": "e70f948913f4adb951a819b04d3a29c4bc302d095d31623429049bdb6bb50aec",
    "channel-workload.cjs": "1c199c86a26d922c24b08c8ecfcb2b6985ac8c1cc200f0c5fad8961400bcf68a",
    "build.ps1": "92b6e73068ae95d9b74163793c1afc628c729c4e1ebf9244013dc8eb075db751",
    "preload.cjs": "ee455a699ce6c23f1dd7a7e84ef7c365894b8dfa9c60c43dd87b4cce73960457",
  }
  if (Object.keys(material).length !== Object.keys(expected).length) throw Error("candidate source mismatch")
  for (const [name, digest] of Object.entries(expected)) {
    if (typeof material[name] !== "string" || createHash("sha256").update(material[name]).digest("hex") !== digest)
      throw Error("candidate source mismatch")
  }
  return true
}

// Only the diagnostic host dispatch changes; historical material/modes stay byte-identical.
const namedChannelCandidateSelected = true
test("Windows constructed owned-Git channel candidate (separate admission required)", {
  skip: process.platform !== "win32", timeout: 180000,
}, () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
  const root = path.join(repo, "owned-git-probe-output")
  const sourceRoot = path.join(root, "source"), publicRoot = path.join(root, "artifacts", "owned-git", "win32-x64")
  const neutral = path.join(root, "neutral"), evidence = path.join(root, "evidence")
  for (const folder of [sourceRoot, publicRoot, neutral]) fs.mkdirSync(folder, { recursive: true })
  const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
  const status = { status: "STAGING", experiment: "constructed-channel1",
    historical27Qualified: false, nativeQualified: false, originalSemanticCases: 27, supplementalCases: 50 }
  const save = () => fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(status, null, 2))
  const exec = (command, args, label, options = {}) => {
    const value = spawnSync(command, args, { encoding: "utf8", cwd: neutral, timeout: 120000, ...options })
    // Only compiler/bootstrap telemetry goes here; per-lease private records stay in the protected root.
    fs.writeFileSync(path.join(sourceRoot, label + ".stdout"), value.stdout ?? "")
    fs.writeFileSync(path.join(sourceRoot, label + ".stderr"), value.stderr ?? "")
    status[label] = { code: value.status, signal: value.signal, error: !!value.error }; save()
    assert.equal(value.status, 0, label + " STOP; inspect bounded retained evidence")
  }
  try {
    assertChannelCandidateSources()
    const nodes = JSON.parse(fs.readFileSync(path.join(repo, "owned-git-probe-interpreters.json"), "utf8"))
    const required = [
      ["v20.0.0", "964d157e4ea07b6df6ce0eb81cc5e866e91dbda78583571ae60de08f132301e5"],
      ["v22.23.3", "9c9245166b4a8e182e0b797da9c20136117ff24368eaff1fec8343a123c8db0e"],
      ["v24.18.0", "9a4eb5f1c29c6a2e93852ead46b999e284a6a5ca8bab4d4e241d587d025a52de"],
    ]
    assert.equal(nodes.length, required.length)
    for (let i = 0; i < nodes.length; i++) {
      assert.equal(nodes[i].version, required[i][0], "changed resolved runtime needs new source review")
      nodes[i].sha256 = nodes[i].sha256.toLowerCase()
      assert.equal(nodes[i].sha256, required[i][1]); assert.equal(digest(nodes[i].path), required[i][1])
    }
    for (const [name, text] of Object.entries(channelProbeMaterial)) fs.writeFileSync(path.join(sourceRoot, name), text)
    save()
    exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(sourceRoot, "build.ps1"), "-Root", sourceRoot], "build")
    assert.doesNotMatch(fs.readFileSync(path.join(sourceRoot, "toolchain.txt"), "utf8"), /(?:VCRUNTIME|MSVCP|ucrtbase)\d*\.dll/i)
    const names = ["probe-owner.exe", "probe-shim.cjs", "probe.test.cjs", "channel-workload.cjs"]
    for (const name of names) fs.copyFileSync(path.join(sourceRoot, name), path.join(publicRoot, name))
    const preload = path.join(publicRoot, "observation preload.cjs")
    fs.copyFileSync(path.join(sourceRoot, "preload.cjs"), preload); names.push(path.basename(preload))
    const manifest = names.map((name) => ({ path: path.join(publicRoot, name), sha256: digest(path.join(publicRoot, name)) }))
    fs.writeFileSync(path.join(publicRoot, "sha256-manifest.json"), JSON.stringify(manifest, null, 2))
    const config = { sourceRoot, publicRoot, neutral, evidence, nodes, manifest,
      owner: path.join(publicRoot, "probe-owner.exe"), shim: path.join(publicRoot, "probe-shim.cjs"),
      workload: path.join(publicRoot, "channel-workload.cjs"), preload, report: path.join(evidence, "channel-worker-report.json") }
    const filename = path.join(publicRoot, "channel-config.json")
    fs.writeFileSync(filename, JSON.stringify(config, null, 2))
    status.nodes = nodes; status.manifest = manifest; save()
    exec("git", ["init", "--quiet", neutral], "synthetic-git-init")
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(SystemRoot|WINDIR|SystemDrive|COMSPEC|PATH|TEMP|TMP|PATHEXT|LANG|LC_ALL)$/i.test(key)))
    const receipt = path.join(evidence, "channel-broader-owner.json")
    exec(config.owner, ["--protected-supervise", nodes[2].path, path.join(publicRoot, "probe.test.cjs"), filename, receipt],
      "broader-supervisor", { env: { ...env, DESK_CHANNEL_EVIDENCE_ROOT: evidence } })
    const worker = JSON.parse(fs.readFileSync(config.report, "utf8"))
    const broader = JSON.parse(fs.readFileSync(receipt, "utf8"))
    assert.equal(worker.status, "CORPUS_OBSERVED_NOT_ADJUDICATED")
    assert.equal(worker.cases.length, 77)
    assert.equal(broader.sealed, true); assert.equal(broader.exactJobZero, true)
    assert.deepEqual([...broader.retiredPids].sort((a, b) => a - b), [...worker.stranded].sort((a, b) => a - b))
    status.status = "CORPUS_OBSERVED_NOT_ADJUDICATED"; status.broader = broader; save()
  } catch {
    status.status = "STOP"; status.failure = "candidate incomplete; inspect retained typed evidence"; save()
    throw Error("constructed-channel candidate STOP")
  }
})

test("binding source guard (portable checks, not Windows kernel proof)", () => {
  assert.match(ownerSource, /typedef BOOL \(WINAPI \*COMPARE_OBJECT_HANDLES_FN\)\(HANDLE, HANDLE\)/)
  assert.match(ownerSource, /GetSystemDirectoryW\(expected,/)
  assert.match(ownerSource, /GetModuleHandleExW\(GET_MODULE_HANDLE_EX_FLAG_PIN, expected,/)
  assert.match(ownerSource, /GetModuleFileNameW\(module, actual,/)
  assert.match(ownerSource, /_wcsicmp\(expected, actual\) != 0/)
  assert.match(ownerSource, /GetProcAddress\(module, "CompareObjectHandles"\)/)
  assert.match(ownerSource, /if \(!address\) return binding_stop\("export", error\)/)
  assert.match(ownerSource, /GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS \| GET_MODULE_HANDLE_EX_FLAG_PIN/)
  assert.match(ownerSource, /if \(!comparison_api\)[\s\S]*?ExitProcess\(96\)/)
  assert.doesNotMatch(ownerSource, /\bCompareObjectHandles\s*\(/)
  assert.doesNotMatch(ownerSource, /\bLoadLibrary(?:Ex)?[AW]?\s*\(/)
  assert.equal((ownerSource.match(/checked_compare_objects\(/g) ?? []).length, 5)
  const main = ownerSource.slice(ownerSource.indexOf("int wmain("))
  assert.ok(main.indexOf("if (!initialize_comparison_api()) return 96;") >= 0)
  assert.ok(main.indexOf("if (!initialize_comparison_api()) return 96;") < main.indexOf('L"--supervise"'))
  assert.ok(main.indexOf("if (!initialize_comparison_api()) return 96;") < main.indexOf("_get_osfhandle(3)"))
})

const diagnosticExperiment = "known-owner-calibration-only"
const calibrationResources = [
  "control-duplex", "owner-stdin-read", "owner-stdout-write", "owner-stderr-write",
  "shim-stdin-read", "shim-stdin-write", "shim-result-read", "shim-result-write",
  "shim-stdout-write-duplicate", "shim-stderr-write-duplicate", "owned-job", "root-process", "root-thread",
]
test("calibration portable mode separation preserves original matrix and binding", () => {
  const calibrationC = ownerSource.slice(ownerSource.indexOf("typedef struct { HANDLE handle;"), ownerSource.indexOf("int wmain("))
  assert.doesNotMatch(calibrationC, /\baudit\s*\(/)
  assert.doesNotMatch(calibrationC, /git-audit|peer-handle|OpenProcess\(|Pss|NtQuery/)
  assert.match(calibrationC, /GetHandleInformation-after-fresh/)
  assert.match(calibrationC, /SetLastError\(0\); returned = checked_compare_objects\(left, right\); error = GetLastError\(\)/)
  assert.match(calibrationC, /expected == 2 && !returned && error == ERROR_NOT_SAME_OBJECT/)
  assert.match(driverSource, /if \(config\.experiment === "known-owner-calibration-only"\) \{ await calibrationExperiment\(\); return; \}/)
  assert.equal(diagnosticExperiment, "known-owner-calibration-only")
  assert.equal(calibrationResources.length, 13)
})

if (!namedChannelCandidateSelected) test("Windows known-owner calibration only (not native feasibility qualification)", {
  skip: process.platform !== "win32", timeout: 180000,
}, () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
  const root = path.join(repo, "owned-git-probe-output")
  const sourceRoot = path.join(root, "source"), publicRoot = path.join(root, "artifacts", "owned-git", "win32-x64")
  const neutral = path.join(root, "neutral"), evidence = path.join(root, "evidence")
  for (const folder of [sourceRoot, publicRoot, neutral, evidence]) fs.mkdirSync(folder, { recursive: true })
  const supervisorReceipt = path.join(evidence, "calibration-broader-owner.json")
  const status = { status: "STAGING", experiment: diagnosticExperiment, originalMatrixExecuted: 0,
    root, sourceRoot, publicRoot, neutral, plannedResources: calibrationResources,
    planned: { calibrationRuns: 1, resources: 13, comparisons: 26, models: 2, preloadObservations: 3, calibrationOwnedCloses: 46, observationOwnedCloses: 10 },
    wire: { header: 4, body: 16380, total: 16384 }, exclusionQualified: false, PR1: "OPEN", PR2: "OPEN" }
  const write = () => fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(status, null, 2))
  const exec = (command, args, label, options = {}) => {
    const value = spawnSync(command, args, { encoding: "utf8", cwd: neutral, timeout: 120000, ...options })
    fs.writeFileSync(path.join(evidence, label + ".stdout"), value.stdout ?? "")
    fs.writeFileSync(path.join(evidence, label + ".stderr"), value.stderr ?? "")
    status[label] = { command, args, code: value.status, signal: value.signal, error: value.error?.message }; write()
    assert.equal(value.status, 0, label + " failed; full retained evidence: " + value.stderr)
    return value
  }
  try {
    for (const [name, text] of Object.entries(probeMaterial)) fs.writeFileSync(path.join(sourceRoot, name), text)
    write()
    exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(sourceRoot, "build.ps1"), "-Root", sourceRoot], "build")
    assert.doesNotMatch(fs.readFileSync(path.join(sourceRoot, "toolchain.txt"), "utf8"), /(?:VCRUNTIME|MSVCP|ucrtbase)\d*\.dll/i)
    const names = ["probe-owner.exe", "probe-shim.cjs", "probe.test.cjs", "preload.cjs"]
    for (const name of names) fs.copyFileSync(path.join(sourceRoot, name), path.join(publicRoot, name))
    const preload = path.join(publicRoot, "observation preload.cjs")
    fs.copyFileSync(path.join(sourceRoot, "preload.cjs"), preload); names.push("observation preload.cjs")
    const digest = (file) => createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    const manifest = names.map((name) => ({ path: path.join(publicRoot, name), sha256: digest(path.join(publicRoot, name)) }))
    fs.writeFileSync(path.join(publicRoot, "sha256-manifest.json"), JSON.stringify(manifest, null, 2))
    const nodes = JSON.parse(fs.readFileSync(path.join(repo, "owned-git-probe-interpreters.json"), "utf8"))
    assert.equal(nodes.length, 3); assert.equal(nodes[0].version, "v20.0.0")
    assert.match(nodes[1].version, /^v22\.\d+\.\d+$/); assert.equal(nodes[2].version, "v24.18.0")
    for (const node of nodes) { node.sha256 = node.sha256.toLowerCase(); assert.equal(digest(node.path), node.sha256) }
    const config = { experiment: diagnosticExperiment, publicRoot, sourceRoot, neutral, evidence, nodes, manifest,
      owner: path.join(publicRoot, "probe-owner.exe"), shim: path.join(publicRoot, "probe-shim.cjs"), preload,
      calibrationResources, report: path.join(evidence, "calibration-worker-report.json") }
    const configPath = path.join(publicRoot, "calibration-config.json")
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    status.manifest = manifest; status.nodes = nodes
    status.sources = Object.keys(probeMaterial).map((name) => ({ name, sha256: digest(path.join(sourceRoot, name)) })); write()
    exec("git", ["init", "--quiet", neutral], "synthetic-git-init")
    const env = { ...process.env }; for (const key of Object.keys(env)) if (key.startsWith("NODE_")) delete env[key]
    exec(config.owner, ["--supervise", nodes[2].path, path.join(publicRoot, "probe.test.cjs"), configPath, supervisorReceipt], "supervisor", { env })
    const worker = JSON.parse(fs.readFileSync(config.report, "utf8"))
    const broader = JSON.parse(fs.readFileSync(supervisorReceipt, "utf8")); status.broader = broader
    assert.equal(broader.sealed, true); assert.equal(broader.exactJobZero, true); assert.deepEqual(broader.retiredPids, [])
    assert.equal(worker.originalMatrixExecuted, 0); assert.equal(worker.cases.length, 0)
    assert.equal(worker.calibration.length, 1); assert.equal(worker.preloadObservations.length, 3)
    assert.equal(worker.status, "CALIBRATION_COMPLETE — NATIVE_FEASIBILITY_NOT_QUALIFIED")
    status.status = worker.status; write()
  } catch (error) {
    if (fs.existsSync(supervisorReceipt)) status.broader = JSON.parse(fs.readFileSync(supervisorReceipt, "utf8"))
    status.status = "STOP"; status.failure = error.stack; write(); throw error
  }
})

if (diagnosticExperiment !== "known-owner-calibration-only") test("Windows installed-layout owned-Git feasibility (STOP on any unqualified boundary)", {
  skip: process.platform !== "win32",
  timeout: 180000,
}, () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..")
  const root = path.join(repo, "owned-git-probe-output")
  const sourceRoot = path.join(root, "source")
  const publicRoot = path.join(root, "artifacts", "owned-git", "win32-x64")
  const neutral = path.join(root, "neutral")
  const evidence = path.join(root, "evidence")
  for (const folder of [sourceRoot, publicRoot, neutral, evidence]) fs.mkdirSync(folder, { recursive: true })
  const status = { status: "STAGING", root, sourceRoot, publicRoot, neutral, wire: { header: 4, body: 16380, total: 16384 } }
  const write = () => fs.writeFileSync(path.join(root, "report.json"), JSON.stringify(status, null, 2))
  const exec = (command, args, options = {}) => {
    const value = spawnSync(command, args, { encoding: "utf8", cwd: neutral, timeout: 120000, ...options })
    const name = options.label ?? path.basename(command)
    fs.writeFileSync(path.join(evidence, name + ".stdout"), value.stdout ?? "")
    fs.writeFileSync(path.join(evidence, name + ".stderr"), value.stderr ?? "")
    status[name] = { command, args, code: value.status, signal: value.signal, error: value.error?.message }
    write()
    assert.equal(value.status, 0, name + " failed; full output in retained evidence: " + value.stderr)
    return value
  }
  try {
    for (const [name, text] of Object.entries(probeMaterial)) fs.writeFileSync(path.join(sourceRoot, name), text)
    write()
    exec("pwsh", ["-NoProfile", "-NonInteractive", "-File", path.join(sourceRoot, "build.ps1"), "-Root", sourceRoot], { label: "build" })
    const toolchain = fs.readFileSync(path.join(sourceRoot, "toolchain.txt"), "utf8")
    assert.doesNotMatch(toolchain, /(?:VCRUNTIME|MSVCP|ucrtbase)\d*\.dll/i, "static CRT required")
    for (const name of ["probe-owner.exe", "probe-shim.cjs", "probe.test.cjs", "preload.cjs"]) {
      fs.copyFileSync(path.join(sourceRoot, name), path.join(publicRoot, name))
    }
    const digest = (name) => createHash("sha256").update(fs.readFileSync(name)).digest("hex")
    const manifest = ["probe-owner.exe", "probe-shim.cjs", "probe.test.cjs", "preload.cjs"].map((name) => ({
      path: path.join(publicRoot, name), sha256: digest(path.join(publicRoot, name)),
    }))
    fs.writeFileSync(path.join(publicRoot, "sha256-manifest.json"), JSON.stringify(manifest, null, 2))
    const nodes = JSON.parse(fs.readFileSync(path.join(repo, "owned-git-probe-interpreters.json"), "utf8"))
    assert.equal(nodes.length, 3)
    assert.equal(nodes[0].version, "v20.0.0")
    assert.match(nodes[1].version, /^v22\.\d+\.\d+$/)
    assert.equal(nodes[2].version, "v24.18.0")
    for (const node of nodes) {
      node.sha256 = node.sha256.toLowerCase()
      assert.equal(digest(node.path), node.sha256, "provisioned interpreter changed")
    }
    const config = {
      publicRoot, sourceRoot, neutral, evidence, nodes, manifest,
      owner: path.join(publicRoot, "probe-owner.exe"),
      shim: path.join(publicRoot, "probe-shim.cjs"),
      preload: path.join(publicRoot, "preload.cjs"),
      report: path.join(evidence, "worker-report.json"),
    }
    const configPath = path.join(publicRoot, "config.json")
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
    status.nodes = nodes
    status.manifest = manifest
    status.sources = Object.keys(probeMaterial).map((name) => ({ name, sha256: digest(path.join(sourceRoot, name)) }))
    status.layout = { sourceRoot, publicRoot, neutral, publicNodeLocations: nodes.map((n) => n.path) }
    write()
    exec("git", ["init", "--quiet", neutral], { label: "synthetic-git-init" })
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (key.startsWith("NODE_")) delete env[key]
    const supervisorReceipt = path.join(evidence, "broader-owner.json")
    exec(config.owner, ["--supervise", nodes[2].path, path.join(publicRoot, "probe.test.cjs"), configPath, supervisorReceipt], {
      env, label: "supervisor",
    })
    const worker = JSON.parse(fs.readFileSync(config.report, "utf8"))
    const broader = JSON.parse(fs.readFileSync(supervisorReceipt, "utf8"))
    status.broader = broader
    assert.equal(broader.sealed, true)
    assert.equal(broader.exactJobZero, true)
    assert.deepEqual([...broader.retiredPids].sort((a, b) => a - b), [...worker.stranded].sort((a, b) => a - b),
      "broader owner must account exactly the purposely stranded suspended roots; helper-loss resources must already have drained")
    assert.equal(worker.status, "PASS")
    assert.equal(worker.cases.length, 27)
    status.status = "PASS"
    write()
  } catch (error) {
    status.status = "STOP"; status.failure = error.stack; write(); throw error
  }
})
