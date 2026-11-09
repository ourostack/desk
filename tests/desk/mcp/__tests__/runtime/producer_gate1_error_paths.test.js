import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import { EventEmitter } from "node:events"

const sourcePath = process.env.DESK_GATE1_SOURCE ?? path.resolve("plugins/desk/mcp/src/runtime/producer-state.js")
const source = fs.readFileSync(sourcePath, "utf8")
const worker = source.slice(source.indexOf("export async function runProducerGate1Worker("),
  source.indexOf("export async function runProducerGate1Executor(")).replace("export async function", "async function")
const journal = source.slice(source.indexOf("function createJournal("), source.indexOf("function validateAuthority("))

async function probe({ setup = null, readFailure = false, writeFailure = false, brokerReadFailure = false,
  brokerValidationFailure = false, malformedClaim = false, spawnError = null } = {}) {
  const state = { reads: 0, writes: 0, native: 0, diagnostics: "", cleaned: [], allocated: false }
  const authority = { root: "/owned/root", env: {}, person: null }
  let disk = { version: 1, id: "11111111-1111-4111-8111-111111111111", revision: 2, state: "reserved",
    requestSent: true, dispatch: { pid: 100 }, caller: { pid: 90 }, producerDeadline: 10000, publicationDeadline: 60000 }
  const process = new EventEmitter()
  process.pid = 100; process.ppid = 90; process.execPath = "VIRTUAL-node"; process.connected = true
  process.env = { DESK_PRODUCER_PARENT_NONCE: "private", DESK_PRODUCER_PARENT_PID: "90" }
  process.stderr = { write: (text) => { state.diagnostics += text } }
  process.disconnect = () => { process.connected = false }
  process.send = (message, callback) => {
    callback?.()
    if (message.kind === "producer-ready") queueMicrotask(() => process.emit("message", {
      kind: "producer-grant", nonce: "private", id: disk.id, revision: 2, authority,
      producerDeadline: 10000, publicationDeadline: 60000,
    }))
  }
  const context = {
    process, Buffer, Date: class extends Date { static now() { return 1000 } }, UUID: /^[0-9a-f-]{36}$/,
    fault: (code) => Object.assign(new Error(code), { code }),
    equalNonce: (a, b) => a === b, validateAuthority() {},
    validateRecord() {
      if (brokerValidationFailure && state.reads === 3) throw Object.assign(new Error("Journal schema invalid"), { code: "producer_record_invalid" })
    },
    folder: () => "/owned/state", path, os: { tmpdir: () => "/owned/tmp" }, SCRIPT: "VIRTUAL-script",
    generation: () => ({ state: "present", pid: 100, start: "owner" }),
    randomBytes: () => ({ toString: () => "private-executor" }), pause: async () => {},
    read: () => {
      state.reads += 1
      if (brokerReadFailure && state.reads === 3) throw Object.assign(new Error("Broker journal read failed"), {
        code: "EIO", path: "/owned/state/record", syscall: "read" })
      if (readFailure && state.native) throw Object.assign(new Error("Read I/O failure"), { code: "EIO", path: "/owned/state/record", syscall: "read" })
      if (writeFailure && state.native > 0 && state.reads > 3) throw new Error("No reads permitted after write fault")
      return structuredClone(disk)
    },
    save: (_file, value) => {
      state.writes += 1
      if (writeFailure && state.native > 0) throw Object.assign(new Error("Write full"), { code: "ENOSPC", path: "/owned/state/record", syscall: "write" })
      disk = structuredClone(value)
    },
    mkdtempSync: () => {
      if (setup === "allocation") throw Object.assign(new Error("Allocation full"), { code: "ENOSPC", path: "/owned/tmp" })
      state.allocated = true
      return "/owned/tmp/broker"
    },
    lstatSync: (file) => {
      if (setup === "identity" && file === "/owned/tmp/broker") throw Object.assign(new Error("Identity I/O"), { code: "EIO", path: file, syscall: "lstat" })
      if (setup === "socket-identity" && file === "/owned/tmp/broker/broker") throw Object.assign(new Error("Socket identity I/O"), { code: "EIO", path: file, syscall: "lstat" })
      return { dev: 1n, ino: file.endsWith("broker") ? 2n : 3n, isDirectory: () => file === "/owned/tmp/broker", isSocket: () => file.endsWith("/broker/broker") }
    },
    unlinkSync: (file) => state.cleaned.push(file), rmdirSync: (file) => state.cleaned.push(file),
    createServer: (listener) => {
      if (setup === "constructor") throw Object.assign(new Error("Socket constructor failed"), { code: "EIO", syscall: "socket" })
      state.listener = listener
      let failure
      return { once(_name, callback) { failure = callback },
        listen(_socket, resolve) {
          if (setup === "listen") failure(Object.assign(new Error("Listen denied"), { code: "EACCES", syscall: "listen" }))
          else resolve()
        }, close(resolve) { resolve?.() } }
    },
    setTimeout: () => ({}), clearTimeout() {}, qualifyProducerExecutor() {},
    digest: (value) => JSON.stringify(value),
    runOwnedProcess: async ({ onResource }) => {
      state.native += 1
      onResource({ childPid: 200, start: "native", group: 200, token: "token", childrenClosed: false })
      if (brokerReadFailure || brokerValidationFailure || malformedClaim) {
        const peer = new EventEmitter()
        peer.setEncoding = peer.pause = peer.destroy = () => {}
        peer.end = (text) => { state.reply = text }
        state.listener(peer)
        peer.emit("data", malformedClaim ? "invalid-json\n" : '{"pid":300,"nonce":"private"}\n')
      }
      return { status: spawnError ? null : 0, stdout: "retained successful native output\n", stderr: "", error: undefined,
        spawnError, cancelled: false, timedOut: false, outputTruncated: false, requestSent: !spawnError,
        resources: { childPid: 200, start: "native", group: 200, childrenClosed: true } }
    },
  }
  const execute = vm.runInNewContext(`${journal}\n${worker}\nrunProducerGate1Worker`, context)
  let error
  try { await execute({ id: disk.id, root: authority.root }) } catch (caught) { error = caught }
  return { state, disk, error }
}

for (const setup of ["allocation", "identity"]) {
  test(`accepted broker ${setup} failure is contained with exact setup custody`, async () => {
    const result = await probe({ setup })
    assert.equal(result.error, undefined)
    assert.equal(result.state.native, 0)
    assert.match(result.state.diagnostics, setup === "allocation" ? /ENOSPC/ : /EIO/)
    if (setup === "identity") {
      assert.match(JSON.stringify(result.disk) + result.state.diagnostics, /\/owned\/tmp\/broker/)
      assert.equal(result.state.cleaned.length, 0)
    }
  })
}
test("resource journal read failure remains the first EIO with no recovery write", async () => {
  const result = await probe({ readFailure: true })
  assert.equal(result.error, undefined)
  assert.match(result.state.diagnostics, /"code":"EIO"/)
  assert.match(result.state.diagnostics, /"syscall":"read"/)
  assert.doesNotMatch(result.state.diagnostics, /producer_revision_changed/)
  assert.equal(result.state.writes, 2)
  assert.equal(result.state.reads, 2)
})
test("latched resource write failure retains full native outcome without terminal reread", async () => {
  const result = await probe({ writeFailure: true })
  assert.equal(result.error, undefined)
  assert.match(result.state.diagnostics, /retained successful native output/)
  assert.match(result.state.diagnostics, /"status":0/)
  assert.match(result.state.diagnostics, /"code":"ENOSPC"/)
  assert.doesNotMatch(result.state.diagnostics, /No reads permitted after write fault/)
  assert.equal(result.state.reads, 2)
})

test("terminal native evidence rejects truthy closure, non-array inventories, missing groups and empty token", () => {
  const authority = { root: "/owned", rootIdentity: "root", person: null, binding: { key: "binding" } }
  const actor = (pid, parentPid, group) => ({ state: "present", pid, parentPid, group, start: "darwin:2026-10-31T18:00:00.000Z" })
  const owner = actor(10, 1, 10), native = actor(20, 10, 20), executor = actor(30, 20, 20)
  const record = { version: 1, id: "owned", revision: 9, root: "/owned", rootIdentity: "root", person: null,
    bindingKey: "binding", createdAtMs: 1000, producerDeadline: 11000, publicationDeadline: 61000,
    state: "capability_verified", requestSent: true, executionCount: 1, capabilityGranted: true,
    caller: actor(1, 2, 2), owner, dispatch: { pid: 10 }, relationship: { owner, native, executor, peerCredentials: false },
    resources: { childPid: 20, start: native.start, group: 20, token: "11111111-1111-4111-8111-111111111111",
      phase: "closed", scope: "native-owner", childrenClosed: true, exitObserved: true, resultReceived: true,
      inventory: { known: true, members: [] } },
    outcome: { status: 0, error: null, cancelled: false, timedOut: false, outputTruncated: false,
      requestSent: true, stdout: "producer capability ready\n" }, broker: { custody: "removed" } }
  const text = source.slice(source.indexOf("function validateRecord("), source.indexOf("export function createProducerReadOnlyIntent("))
  const validate = vm.runInNewContext(`${text}\nvalidateRecord`, {
    UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    fault: (code) => Object.assign(new Error(code), { code }),
  })

  validate(record, authority, record.id)
  for (const change of ["flags", "groups", "object-inventory", "string-inventory", "token", "phase"]) {
    const invalid = structuredClone(record)
    if (change === "flags") { invalid.resources.exitObserved = "false"; invalid.resources.resultReceived = "false" }
    if (change === "groups") { delete invalid.resources.group; delete invalid.relationship.native.group; delete invalid.relationship.executor.group }
    if (change === "object-inventory") invalid.resources.inventory.members = { length: 0 }
    if (change === "string-inventory") invalid.resources.inventory.members = ""
    if (change === "token") invalid.resources.token = ""
    if (change === "phase") invalid.resources.phase = "unaccepted"
    assert.throws(() => validate(invalid, authority, record.id), { code: "producer_record_invalid" })
  }
})

test("actual sealed positive proof rejects contradictory grant, spawn failure, owner group and Linux generation", (t) => {
    const evidence = JSON.parse(fs.readFileSync("/Users/microsoft/.copilot/session-state/cce332d0-f036-45fa-b661-7c65412e68ef/files/accepted-producer-gate1-v3-resources.json", "utf8"))
    const positives = evidence.fixtures.flatMap((fixture) => fixture.records).map((entry) => entry.record)
      .filter((value) => value?.state === "capability_verified" && value.outcome?.stdout === "producer capability ready\n" &&
        Number.isSafeInteger(value.resources?.group) && Number.isSafeInteger(value.relationship?.native?.group))
    assert.ok(positives.length > 0, "Need actual sealed positive results, not a handcrafted or deliberately corrupted journal")
    const text = source.slice(source.indexOf("function validateRecord("), source.indexOf("export function createProducerReadOnlyIntent("))
    const validate = vm.runInNewContext(`${text}\nvalidateRecord`, {
      UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      fault: (code) => Object.assign(new Error(code), { code }),
    })
    for (const record of positives) {
      const authority = { root: record.root, rootIdentity: record.rootIdentity, person: record.person, binding: { key: record.bindingKey } }
      validate(record, authority, record.id)
      for (const change of ["grant", "spawn", "owner-group", "linux-generation", "darwin-generation", "normalized-darwin-date", "numeric-grant"]) {
        const invalid = structuredClone(record)
        if (change === "grant") invalid.capabilityGranted = "false"
        if (change === "numeric-grant") invalid.capabilityGranted = 1
        if (change === "spawn") invalid.outcome.spawnError = "EACCES"
        if (change === "owner-group") invalid.relationship.owner.group = 999
        if (change === "linux-generation") invalid.caller.start = `linux:${"-".repeat(36)}:1`
        if (change === "darwin-generation") invalid.caller.start = "darwin:2026-99-99T18:00:00.000Z"
        if (change === "normalized-darwin-date") invalid.caller.start = "darwin:2026-02-30T18:00:00.000Z"
        assert.throws(() => validate(invalid, authority, record.id), { code: "producer_record_invalid" })
      }
    }
    t.diagnostic(JSON.stringify({ actualSealedPositiveCount: positives.length, qualification: "Actual prior sealed outcomes validated and mutated actor-free; not a native rerun." }))
  })
  for (const setup of ["constructor", "listen", "socket-identity"]) {
    test(`broker ${setup} failure preserves acquired directory identity before the next setup step`, async () => {
      const result = await probe({ setup })
      assert.equal(result.error, undefined)
      assert.equal(result.state.native, 0)
      assert.match(result.state.diagnostics, /"directoryIdentity":\{"dev":"1","ino":"2"\}/)
    })
  }
  test("broker journal EIO latches the original observation without further journal reads or writes", async () => {
    const result = await probe({ brokerReadFailure: true })
    assert.equal(result.error, undefined)
    assert.match(result.state.diagnostics, /"code":"EIO"/)
    assert.match(result.state.diagnostics, /"syscall":"read"/)
    assert.equal(result.state.reads, 3)
    assert.equal(result.state.writes, 3)
  })
  test("broker journal schema refusal latches validation failure rather than treating it as malformed peer data", async () => {
    const result = await probe({ brokerValidationFailure: true })
    assert.equal(result.error, undefined)
    assert.match(result.state.diagnostics, /"code":"producer_record_invalid"/)
    assert.equal(result.state.reads, 3)
    assert.equal(result.state.writes, 3)
  })
  test("malformed peer data is a local refusal, not a journal persistence failure", async () => {
    const result = await probe({ malformedClaim: true })
    assert.equal(result.error, undefined)
    assert.doesNotMatch(result.state.diagnostics, /persistence_error/)
    assert.ok(result.state.reads > 2)
    assert.match(result.state.reply, /refused/)
  })
  for (const latch of [null, "read", "write"]) {
    test(`native spawn EACCES survives ${latch ?? "ordinary"} terminal settlement as a complete outcome`, async () => {
      const result = await probe({ spawnError: "EACCES", readFailure: latch === "read", writeFailure: latch === "write" })
      assert.equal(result.error, undefined)
      if (latch) assert.match(result.state.diagnostics, /"spawnError":"EACCES"/)
      else assert.equal(result.disk.outcome.spawnError, "EACCES")
    })
  }

  async function grantProbe({ substituteAt = 0, field = "token", wrongNonce = false } = {}) {
    const state = { reads: 0, writes: 0, diagnostics: "", capabilities: 0 }
    const start = "darwin:2026-10-31T18:00:00.000Z"
    const actor = (pid, parentPid, group) => ({ state: "present", pid, parentPid, group, start })
    const owner = actor(100, 90, 100), native = actor(200, 100, 200), executor = actor(300, 200, 200)
    const id = "11111111-1111-4111-8111-111111111111"
    const authority = { root: "/owned/root", rootIdentity: "root", person: null, binding: { key: "binding" }, env: {} }
    const expectedSnapshots = new WeakMap()
    let disk = { version: 1, id, revision: 2, root: authority.root, rootIdentity: authority.rootIdentity,
      person: null, bindingKey: "binding", createdAtMs: 0, producerDeadline: 10000, publicationDeadline: 60000,
      state: "reserved", requestSent: true, executionCount: 0, resources: { childrenClosed: true },
      caller: actor(90, 1, 90), dispatch: { pid: owner.pid } }
    const nativeResources = { childPid: native.pid, start, group: native.group,
      token: "22222222-2222-4222-8222-222222222222", childrenClosed: false, phase: "accepted", scope: "native-owner" }
    const process = new EventEmitter()
    Object.assign(process, { pid: owner.pid, ppid: 90, execPath: "VIRTUAL-node", connected: true,
      env: { DESK_PRODUCER_PARENT_NONCE: "caller-nonce", DESK_PRODUCER_PARENT_PID: "90" },
      stderr: { write: (text) => { state.diagnostics += text } } })
    process.disconnect = () => { process.connected = false }
    process.send = (message, callback) => {
      callback?.()
      if (message.kind === "producer-ready") queueMicrotask(() => process.emit("message", {
        kind: "producer-grant", id, revision: 2, nonce: "caller-nonce", authority,
        producerDeadline: 10000, publicationDeadline: 60000,
      }))
    }
    const validator = source.slice(source.indexOf("function validateRecord("), source.indexOf("export function createProducerReadOnlyIntent("))
    const qualifier = source.slice(source.indexOf("export function qualifyProducerExecutor("),
      source.indexOf("export async function runProducerGate1Worker(")).replace("export function", "function")
    const context = {
      Buffer, process, Date: class extends Date { static now() { return 1000 } },
      UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      fault: (code) => Object.assign(new Error(code), { code }), digest: (value) => JSON.stringify(value),
      equalNonce: (a, b) => a === b, validateAuthority() {}, folder: () => "/owned/state", path,
      SCRIPT: "VIRTUAL-script", os: { tmpdir: () => "/owned/tmp" }, pause: async () => {},
      randomBytes: () => ({ toString: () => "executor-nonce" }),
      generation: (pid) => ({ 100: owner, 200: native, 300: executor })[pid],
      read: () => {
        state.reads += 1
        if (state.reads === substituteAt) {
          if (field === "token") disk.resources.token = "33333333-3333-4333-8333-333333333333"
          if (field === "owner-group") disk.owner.group = 999
          if (field === "state") disk.state = "blocked"
        }
        const snapshot = structuredClone(disk)
        expectedSnapshots.set(snapshot, JSON.stringify(disk))
        return snapshot
      },
      save: (_file, value, _exclusive, expected) => {
        state.writes += 1
        if (JSON.stringify(disk) !== expectedSnapshots.get(expected)) throw Object.assign(new Error("Later stale write"), { code: "producer_revision_changed" })
        disk = structuredClone(value)
        expectedSnapshots.set(value, JSON.stringify(disk))
      },
      mkdtempSync: () => "/owned/tmp/broker",
      lstatSync: (file) => ({ dev: 1n, ino: file === "/owned/tmp/broker" ? 2n : 3n,
        isDirectory: () => file === "/owned/tmp/broker", isSocket: () => file === "/owned/tmp/broker/broker" }),
      unlinkSync() {}, rmdirSync() {}, setTimeout: () => ({}), clearTimeout() {},
      createServer: (listener) => {
        state.listener = listener
        return { once() {}, listen(_socket, resolve) { resolve() }, close(resolve) { resolve?.() } }
      },
      runOwnedProcess: async ({ onResource }) => {
        onResource(nativeResources)
        const peer = new EventEmitter()
        peer.setEncoding = peer.pause = peer.destroy = () => {}
        peer.end = (text) => { if (JSON.parse(text).kind === "read-only-capability") state.capabilities += 1 }
        state.listener(peer)
        peer.emit("data", `${JSON.stringify({ nonce: wrongNonce ? "wrong-nonce" : "executor-nonce", pid: executor.pid, start,
          container: { pid: native.pid, start, token: nativeResources.token } })}\n`)
        return { status: state.capabilities ? 0 : 1, error: undefined, spawnError: undefined,
          cancelled: false, timedOut: false, outputTruncated: false, requestSent: true,
          stdout: state.capabilities ? "producer capability ready\n" : "", stderr: "",
          resources: { ...nativeResources, childrenClosed: true, exitObserved: true, resultReceived: true,
            phase: "closed", inventory: { known: true, members: [] } } }
      },
    }
    const execute = vm.runInNewContext(`${journal}\n${validator}\n${qualifier}\n${worker}\nrunProducerGate1Worker`, context)
    let error
    try { await execute({ id, root: authority.root }) } catch (caught) { error = caught }
    return { state, disk, error }
  }

  for (const substituteAt of [3, 4]) {
    for (const field of ["token", "owner-group", "state"]) {
      test(`schema-valid ${field} replacement at journal read ${substituteAt} latches original grant inconsistency`, async () => {
        const result = await grantProbe({ substituteAt, field })
        assert.equal(result.error, undefined)
        assert.equal(result.state.capabilities, 0)
        assert.match(result.state.diagnostics, /"code":"producer_grant_changed"/)
        assert.doesNotMatch(result.state.diagnostics, /"code":"producer_revision_changed"/)
        assert.equal(result.state.reads, substituteAt)
        assert.equal(result.state.writes, 3)
        assert.equal(result.disk.producerDeadline, 10000)
        assert.equal(result.disk.publicationDeadline, 60000)
        assert.equal(result.disk.revision, 5)
        if (field === "token") assert.equal(result.disk.resources.token, "33333333-3333-4333-8333-333333333333")
        if (field === "owner-group") assert.equal(result.disk.owner.group, 999)
        if (field === "state") assert.equal(result.disk.state, "blocked")
      })
    }
  }
  test("legitimate accepted grant/resource evolution preserves one capability and qualified terminal proof", async () => {
    const result = await grantProbe()
    assert.equal(result.error, undefined)
    assert.equal(result.state.capabilities, 1)
    assert.equal(result.disk.state, "capability_verified")
    assert.equal(result.disk.resources.childrenClosed, true)
    assert.equal(result.disk.producerDeadline, 10000)
    assert.equal(result.disk.publicationDeadline, 60000)
    assert.doesNotMatch(result.state.diagnostics, /persistence_error/)
  })
  test("wrong executor nonce remains a peer-local refusal while legitimate journal observations continue", async () => {
    const result = await grantProbe({ wrongNonce: true })
    assert.equal(result.error, undefined)
    assert.equal(result.state.capabilities, 0)
    assert.equal(result.disk.state, "blocked")
    assert.doesNotMatch(result.state.diagnostics, /persistence_error/)
    assert.ok(result.state.reads > 3)
  })
