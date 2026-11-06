import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import path from "node:path"
import { EventEmitter } from "node:events"
import { createHash } from "node:crypto"
import { producerBodyReceiptOf, producerBodyProofOf, producerCommandOutcome } from "../../../../../plugins/desk/mcp/src/runtime/producer-state.js"
import { commitPaths } from "../../../../../plugins/desk/mcp/src/util/git-stage.js"
import { savePayloadDigest } from "../../../../../plugins/desk/mcp/src/runtime/producer-state.js"

const source = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
const extract = (begin, end) => source.slice(source.indexOf(begin), source.indexOf(end))
const journal = extract("function createJournal(", "function validateAuthority(")
const validator = extract("function validateRecord(", "export function createProducerReadOnlyIntent(")
const qualifier = extract("export function qualifyProducerExecutor(", "function attributeAcceptedBody(").replace("export function", "function")
const worker = extract("export async function runProducerGate1Worker(", "export async function runProducerGate1Executor(").replace("export async function", "async function")
const attribution = extract("function attributeAcceptedBody(", "export async function runProducerGate1Worker(")
const hash = (value) => JSON.stringify(value)
const canonicalSource = extract("export function savePayloadDigest(", "const pause =").replace("export function", "function")
const canonical = vm.runInNewContext(`${canonicalSource}\nsavePayloadDigest`, {
  createHash, Buffer, Date, fault: (code) => Object.assign(new Error(code), { code }),
})

async function payloadPipeline({ expireCapture = false, refuseBatchEscape = false } = {}) {
  const state = { clock: 1000, stored: new Map(), records: [], nextFd: 1, descriptors: new Map(), legacyCaptures: 0, monitorCloses: 0 }
  const payload = { paths: ["selected.md"], files: [
    { path: "one.md", content: "\0".repeat(1024 * 1024) }, { path: "two.md", content: "é🙂\n" },
  ], message: "payload", tidy: false }
  const authority = { root: "/owned", person: null, env: {}, binding: { branch: "refs/heads/main" } }
  const intents = new WeakMap(), context = {}
  const fdFile = (fd) => state.descriptors.get(fd)
  const sandbox = {
    Buffer, createHash, path, constants: fs.constants, intents, SCRIPT: "virtual",
    Date: class extends Date { static now() { return state.clock } },
    digest: (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    fault: (code) => Object.assign(new Error(code), { code }),
    prepareFirstOperationEnvironment: async () => null,
    closeFirstOperationEnvironment: () => assert.fail("Legacy source fixture has no operation env to retire"),
    captureProducerAdmission: (_context, options) => {
      state.legacyCaptures++
      assert.equal(options.deadline, 11000)
      if (expireCapture) state.clock = 11000
      return authority
    },
    beginFirstSaveCurrentness: ({ producerDeadline }) => {
      assert.equal(producerDeadline, 11000)
      if (expireCapture) state.clock = 11000
      return { monitor: Object.freeze({}), authority, footprint: { version: 1 } }
    },
    assertFirstSaveCurrentness: () => { if (state.clock >= 11000) throw Object.assign(new Error("expired"), { code: "producer_deadline" }) },
    closeFirstSaveCurrentness() { state.monitorCloses++ },
    prepareDeskSaveInput: async ({ input }) => ({ ...input, checkedFiles: [] }),
    folder: () => "/private", mkdirSync() {},
    lstatSync: (file) => ({ dev: 1n, ino: 2n, nlink: 1n, size: BigInt(Buffer.byteLength(state.stored.get(file) ?? "")),
      isDirectory: () => file.endsWith(".payload"), isFile: () => !file.endsWith(".payload") }),
    openSync: (file) => { const fd = state.nextFd++; state.descriptors.set(fd, file); return fd },
    writeFileSync: (fd, value) => state.stored.set(fdFile(fd), value), closeSync() {},
    readSmallText: (file) => state.stored.get(file),
    read: () => { throw Object.assign(new Error("absent"), { code: "ENOENT" }) },
    createJournal: () => ({ write: (record) => { state.records.push(record); return true }, failed: () => null }),
    generation: () => ({ pid: 123, start: "virtual" }),
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    randomBytes: () => ({ toString: () => "nonce" }),
    spawn: () => {
      state.child = Object.assign(new EventEmitter(), { pid: 456, unref() {} })
      return state.child
    },
    projection: (record) => record, process: { pid: 123, execPath: "virtual", stderr: { write() {} } },
    setTimeout: () => ({ unref() {} }), clearTimeout() {},
  }
  if (refuseBatchEscape) sandbox.JSON = { ...JSON, stringify(value) {
    if (value?.files?.some((file) => typeof file.content === "string")) assert.fail("Raw content batch was escaped")
    return JSON.stringify(value)
  } }
  if (refuseBatchEscape) sandbox.digest = (value) => createHash("sha256").update(sandbox.JSON.stringify(value)).digest("hex")
  const digestSource = source.includes("function savePayloadDigest(")
    ? extract("export function savePayloadDigest(", "const pause =").replace("export function", "function") : ""
  const request = extract("export async function requestDeskSaveProducer(", "function storeSavePayload(")
    .replace("export async function", "async function")
    .replace('const { prepareDeskSaveInput } = await import("../tools/desk-save.js")', "")
  const operations = extract("function storeSavePayload(", "export function readProducer(").replace("export async function", "async function")
  const receive = extract("async function receiveSavePayload(", "export async function runProducerSaveExecutor(")
  const api = vm.runInNewContext(`${digestSource}\n${request}\n${operations}\n${receive}
    ;({ requestDeskSaveProducer, loadSavePayload, receiveSavePayload })`, sandbox)
  const record = await api.requestDeskSaveProducer({ context, input: payload })
  const loaded = api.loadSavePayload(record.payloadManifest, record.producerDeadline)
  const frames = []
  for (const [ordinal, file] of loaded.files.entries()) {
    const bytes = Buffer.from(file.content)
    frames.push({ kind: "payload-file", ordinal, path: file.path, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") })
    for (let offset = 0; offset < bytes.length; offset += 65536) frames.push({ kind: "payload-chunk", ordinal, offset,
      bytes: bytes.subarray(offset, offset + 65536).toString("base64") })
    frames.push({ kind: "payload-file-complete", ordinal })
  }
  frames.push({ kind: "payload-complete", digest: record.payloadDigest })
  const received = await api.receiveSavePayload(async () => frames.shift(), {
    producerDeadline: 11000, payload: { paths: loaded.paths, message: loaded.message, tidy: loaded.tidy, fileCount: loaded.files.length },
  })
  return { record, loaded, received, payload, state }
}

test("actual capture/private storage/load/receive agree despite payload property order and multi-file NUL content", async () => {
  const result = await payloadPipeline()
  assert.equal(result.received.files[0].content, result.payload.files[0].content)
  assert.equal(result.received.files[1].content, "é🙂\n")
  assert.equal(result.record.producerDeadline, 11000)
  assert.equal(result.state.stored.size, 2)
})
test("qualified FIRST request transfers its footprint and explicit lifecycle without legacy recapture", async () => {
  const result = await payloadPipeline()
  assert.equal(result.state.legacyCaptures, 0)
  assert.equal(result.record.bodyLifecycle.version, 2)
  assert.equal(result.record.producerCurrentness.version, 1)
  assert.equal(result.record.producerCurrentness.operationId, result.record.id)
  assert.equal(result.record.producerCurrentness.originalDeadline, 11000)
  assert.match(result.record.producerCurrentness.footprintDigest, /^[0-9a-f]{64}$/)
})
test("accepted worker transfer retires only the caller's local monitor once, without cancelling the worker", async () => {
  const result = await payloadPipeline()
  assert.equal(result.state.monitorCloses, 0)
  result.state.child.emit("message", { kind: "producer-accepted" })
  assert.equal(result.state.monitorCloses, 1)
  result.state.child.emit("exit", 0)
  assert.equal(result.state.monitorCloses, 1)
})
test("expired participating authority capture cannot start private payload IO", async () => {
  await assert.rejects(payloadPipeline({ expireCapture: true }), { code: "producer_deadline" })
})
test("capture/load/receive never stringify the raw multi-file content batch", async () => {
  const result = await payloadPipeline({ refuseBatchEscape: true })
  assert.equal(result.received.files[0].content.length, 1024 * 1024)
})
function saveInputSandbox() {
  const state = { clock: 1000, validations: 0, defaultPreflights: 0, requestTime: null }
  const toolSource = fs.readFileSync(path.resolve("plugins/desk/mcp/src/tools/desk-save.js"), "utf8")
    .replace(/^import .*$/gmu, "").replaceAll("export ", "")
    .replace('const { requestDeskSaveProducer } = await import("../runtime/producer-state.js")', "state.clock += 4000")
  const sandbox = { state, Buffer, path, Date: class extends Date { static now() { return state.clock } },
    spawnSync() {}, schedulePushDefault() {}, personPrefix: () => "/owned", isPathContained: () => true,
    existsSync: () => false, isLiveCardPath: () => false, realpathSync: { native: (file) => file },
    resolveWriteTarget: async () => { state.validations++; state.clock = 11000 },
    assertPublicationProducer: () => { state.defaultPreflights++; state.clock += 40000 },
    requestDeskSaveProducer: async (args) => { state.requestTime = args.createdAtMs; return { state: "reserved" } },
  }
  return { state, ...vm.runInNewContext(`${toolSource}\n;({ desk_save, prepareDeskSaveInput })`, sandbox) }
}
test("participating save selects t0 before module dispatch and performs no default-lifetime preflight", async () => {
  const f = saveInputSandbox()
  await f.desk_save({ deskRoot: "/owned", input: { paths: ["one.md"], message: "owned" },
    statusContext: { acceptedProducer: true, publicationContext: {} } })
  assert.equal(f.state.defaultPreflights, 0)
  assert.equal(f.state.requestTime, 1000)
})
test("actual shared validation stops after an awaited path check reaches the original deadline", async () => {
  const f = saveInputSandbox()
  await assert.rejects(f.prepareDeskSaveInput({ deskRoot: "/owned",
    input: { paths: ["one.md", "two.md"], message: "owned" }, deadline: 11000 }), { code: "producer_deadline" })
  assert.equal(f.state.validations, 1)
})
test("actual hosted-file validation stops after an awaited target check reaches the original deadline", async () => {
  const f = saveInputSandbox()
  await assert.rejects(f.prepareDeskSaveInput({ deskRoot: "/owned",
    input: { files: [{ path: "one.md", content: "\0".repeat(1024 * 1024) },
      { path: "two.md", content: "second" }], message: "owned" }, deadline: 11000 }), { code: "producer_deadline" })
  assert.equal(f.state.validations, 1)
})

async function probe({ denied = null, replay = false, forgedPayload = false, commitStatus = 0,
  noOp = false, nativeError = null, privateMarker = "", descriptorCase = false, wrongDescriptor = false,
  terminalSchema2 = false, malformedTerminal = false, terminalPersistFault = false,
  newLifecycle = false, observeBodyStart = true, actorChangedAfterGrant = false, duplicateTerminal = false,
  monitored = false, substitutedFootprint = false, badPhaseResult = null, noOpAfterPhases = false,
  selectorCase = null } = {}) {
  const state = { reads: 0, writes: 0, native: 0, phases: [], replies: [], diagnostics: "", targetReadback: 0,
    monitorStarts: 0, monitorAsserts: 0, monitorCloses: 0, selectorRegistrations: 0 }
  const start = "darwin:2026-10-31T18:00:00.000Z"
  const actor = (pid, parentPid, group) => ({ state: "present", pid, parentPid, group, start })
  const owner = actor(100, 90, 100), native = actor(200, 100, 200), executor = actor(300, 200, 200)
  const id = "11111111-1111-4111-8111-111111111111", parent = "a".repeat(40), target = "b".repeat(40)
  const payload = { paths: ["owned.md"], files: descriptorCase ? [{ path: "owned.md", content: "BODY" }] : [], message: "owned", tidy: false }
  const authority = { root: "/owned", rootIdentity: "root", person: null, env: {}, binding: { key: "binding", branch: "refs/heads/main" } }
  const manifest = { path: "VIRTUAL-payload" }, snapshots = new WeakMap()
  let disk = { version: 1, id, revision: 2, kind: "desk-save", root: authority.root, rootIdentity: "root",
    person: null, bindingKey: "binding", caller: actor(90, 1, 90), dispatch: { pid: 100 },
    requestSent: true, executionCount: 0, resources: { childrenClosed: true }, createdAtMs: 0,
    producerDeadline: 10000, publicationDeadline: 60000, state: "reserved", payloadManifest: manifest, payloadDigest: canonical(payload) }
  if (newLifecycle) disk.bodyLifecycle = { version: 2, grantIssueCount: 0, observedStartCount: 0, completedReportCount: 0 }
  const footprint = { records: [], envDigest: "virtual" }
  if (monitored) disk.producerCurrentness = { version: 1, operationId: id, originalDeadline: 10000, footprintDigest: hash(footprint) }
  const selection = { version: 1, operationId: id, createdAtMs: 0, producerDeadline: 10000,
    publicationDeadline: 60000, source: "snapshot", value: "/Applications/Xcode.app/Contents/Developer" }
  if (selectorCase) disk.producerCurrentness.selectorDigest = hash(selection)
  const resource = { childPid: 200, start, group: 200, token: "22222222-2222-4222-8222-222222222222",
    childrenClosed: false, scope: "native-owner", phase: "accepted" }
  const process = new EventEmitter()
  Object.assign(process, { pid: 100, ppid: 90, execPath: "VIRTUAL-node", connected: true,
    env: { DESK_PRODUCER_PARENT_NONCE: "private", DESK_PRODUCER_PARENT_PID: "90" },
    stderr: { write: (text) => { state.diagnostics += text } } })
  process.disconnect = () => { process.connected = false }
  process.send = (message, callback) => {
    callback?.()
    if (message.kind === "producer-ready") queueMicrotask(() => process.emit("message", { kind: "producer-grant",
      id, nonce: "private", revision: 2, authority, kindOfWork: "desk-save", payloadManifest: manifest,
      ...(monitored ? { producerCurrentness: disk.producerCurrentness,
        footprint: substitutedFootprint ? { ...footprint, envDigest: "foreign" } : footprint } : {}),
      ...(selectorCase && selectorCase !== "missing" ? { operationSelection:
        selectorCase === "tampered" ? { ...selection, value: "/foreign" } : selection } : {}),
      payloadDigest: forgedPayload ? "changed" : canonical(payload), producerDeadline: 10000, publicationDeadline: 60000 }))
  }
  const context = {
    process, Buffer, createHash, producerCommandOutcome, ownerReceipts: new WeakMap(), bodyReceiptProofs: new WeakMap(),
    Date: class extends Date { static now() { return 1000 } },
    fault: (code) => Object.assign(new Error(code), { code }), UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    digest: hash, savePayloadDigest: (payload) => canonical(payload), equalNonce: (a, b) => a === b, path, os: { tmpdir: () => "/private" },
    loadSavePayload: () => payload, validateAuthority() { if (monitored) assert.fail("Repeated full legacy capture must not run") },
    createPublicationContext: () => Object.freeze({}), closePublicationContext() {},
    registerTransferredFirstOperationEnvironment: args => {
      state.selectorRegistrations++
      assert.equal(args.expectedDigest, disk.producerCurrentness.selectorDigest)
      assert.equal(args.createdAtMs, 0)
      assert.equal(args.operationId, id)
      assert.equal(args.producerDeadline, 10000)
      assert.equal(args.publicationDeadline, 60000)
      // Reaching this boundary is not a successful policy substitute.
      throw Object.assign(new Error("Actual registrar boundary reached"), { code: "selector_registration_boundary_reached" })
    },
    closeFirstOperationEnvironment() {},
    beginFirstSaveCurrentness: ({ expectedAuthority, expectedFootprint, operationId, producerDeadline }) => {
      state.monitorStarts++
      assert.equal(operationId, id); assert.equal(producerDeadline, 10000)
      assert.equal(hash(expectedAuthority), hash(authority)); assert.equal(hash(expectedFootprint), hash(footprint))
      return { monitor: Object.freeze({}), authority, footprint }
    },
    assertFirstSaveCurrentness: ({ operationId, producerDeadline }) => {
      state.monitorAsserts++; assert.equal(operationId, id); assert.equal(producerDeadline, 10000)
    },
    closeFirstSaveCurrentness: () => { state.monitorCloses++ },
    folder: () => "/state", SCRIPT: "VIRTUAL-script",
    generation: (pid) => state.actorChanged && pid === 300 ? { ...executor, start: "reused-generation" }
      : ({ 100: owner, 200: native, 300: executor })[pid],
    randomBytes: () => ({ toString: () => "executor-private" }), pause: async () => {},
    read: () => { state.reads++; const copy = structuredClone(disk); snapshots.set(copy, hash(disk)); return copy },
    save: (_file, next, _exclusive, previous) => {
      state.writes++
      if (hash(disk) !== snapshots.get(previous)) throw Object.assign(new Error("CAS mismatch"), { code: "producer_revision_changed" })
      if (next.bodyPhase?.phase === denied && next.bodyPhase.state === "unknown") throw Object.assign(new Error("Journal full"), { code: "ENOSPC" })
      if (terminalPersistFault && next.terminalReport) throw Object.assign(new Error("Terminal journal failed"), { code: "EIO" })
      disk = structuredClone(next); snapshots.set(next, hash(disk))
    },
    mkdtempSync: () => "/private/broker",
    lstatSync: (file) => ({ dev: 1n, ino: file === "/private/broker" ? 2n : 3n,
      isDirectory: () => file === "/private/broker", isSocket: () => file === "/private/broker/broker" }),
    unlinkSync() {}, rmdirSync() {}, setTimeout: () => ({}), clearTimeout() {},
    createServer: (listener) => {
      state.listener = listener
      return { once() {}, listen(_socket, resolve) { resolve() }, close(resolve) { resolve?.() } }
    },
    personPrefix: () => "/owned", isPathContained: () => true,
    readSmallText: () => `${parent} ${target} fixture <fixture@invalid> 1 +0000\tdesk-publication:${id}: owned\n`,
    spawnSync: (_command, args) => {
      state.targetReadback++
      const op = args[2], output = op === "rev-parse" ? "/logs/main\n" : op === "rev-list" ? `${target} ${parent}\n`
        : op === "diff-tree" ? "owned.md\0" : op === "ls-tree" ? `100644 blob ${"c".repeat(40)}\towned.md\0` : ""
      return { status: 0, stdout: output, stderr: "", error: undefined }
    },
    runOwnedProcess: async ({ onResource }) => {
      state.native++; onResource(resource)
      const peer = new EventEmitter()
      peer.setEncoding = peer.pause = peer.destroy = () => {}
      peer.write = peer.end = (text) => { state.replies.push(JSON.parse(text)) }
      state.listener(peer)
      peer.emit("data", `${JSON.stringify({ pid: 300, start, nonce: "executor-private",
        container: { pid: 200, start, token: resource.token } })}\n`)
      if (!state.replies.some((reply) => reply.kind === "save-capability")) throw new Error("No live body capability")
      state.actorChanged = actorChangedAfterGrant
      if (newLifecycle && observeBodyStart) peer.emit("data", `${JSON.stringify({
        kind: "body-started", schema_version: 2, operationId: id, producerDeadline: 10000, publicationDeadline: 60000,
      })}\n`)
      const stages = [
        ...(descriptorCase ? [
          { phase: "open", detail: { path: "owned.md" } },
          { phase: "write", detail: { path: "owned.md", descriptor: 17, bytes: 4, sha256: createHash("sha256").update("BODY").digest("hex") } },
          { phase: "close", detail: { path: "owned.md", descriptor: wrongDescriptor ? 18 : 17 } },
        ] : []),
        { phase: "stage", detail: { args: ["add", "-A", "--", "owned.md"] } },
        { phase: "commit", detail: { args: ["commit", "-m", "owned", "--", "owned.md"], proof: { parent,
          branch: "refs/heads/main", witness: `desk-publication:${id}`, exactPaths: ["owned.md"],
          expected: [{ path: "owned.md", mode: "100644", sha: "c".repeat(40), stage: "0" }] } } },
      ]
      const selectedStages = noOp ? [] : noOpAfterPhases ? stages.filter(stage => stage.phase !== "commit") : stages
      for (const [index, stage] of selectedStages.entries()) {
        const sequence = index + 1
        peer.emit("data", `${JSON.stringify({ kind: "phase-intent", id, sequence, producerDeadline: 10000, ...stage })}\n`)
        if (!state.replies.some((reply) => reply.kind === "phase-approved" && reply.sequence === sequence)) break
        state.phases.push(stage.phase)
        const reported = { kind: "phase-result", sequence, phase: stage.phase, status: "completed",
          ...(stage.phase === "open" ? { file_resource: { path: "owned.md", descriptor: 17 } } : {}) }
        if (badPhaseResult?.phase === stage.phase) {
          if (badPhaseResult.status === "missing") delete reported.status
          else reported.status = badPhaseResult.status
          if (badPhaseResult.extra) reported.extra = "not in result schema"
        }
        peer.emit("data", `${JSON.stringify(reported)}\n`)
        if (replay) {
          peer.emit("data", `${JSON.stringify({ kind: "phase-intent", id, sequence: sequence + 1,
            producerDeadline: 10000, ...stage })}\n`)
          break
        }
      }
      if (!denied && !replay) {
        const terminalFrame = { kind: "body-outcome",
        ...(terminalSchema2 ? { schema_version: 2, operationId: id, producerDeadline: malformedTerminal ? 11000 : 10000,
          publicationDeadline: 60000 } : {}),
        outcome: { state: "body_settled", reason: noOp || noOpAfterPhases ? "nothing_to_commit" : null,
          command: noOp ? null : { status: commitStatus, error: null, stderr: privateMarker },
          ...(terminalSchema2 ? {} : { message: privateMarker }), attribution: "provisional", publication: "not_started",
          ...(terminalSchema2 ? { protocol: { lastIntentSequence: selectedStages.length, lastApprovalAckSequence: selectedStages.length,
            lastCompletedSequence: selectedStages.length }, effects: { status: "unknown", readback_required: true,
              applied_paths: [], uncertain_paths: [], open_files: [], dispatches: [] },
            command: null, proof: null, noOpWitness: { selectedChangedPaths: [], status: 0, error: null, signal: null } } : {}) } }
        peer.emit("data", `${JSON.stringify(terminalFrame)}\n`)
        if (duplicateTerminal) peer.emit("data", `${JSON.stringify(terminalFrame)}\n`)
      }
      return { status: nativeError ? null : denied || replay ? 1 : 0, error: nativeError,
        stdout: privateMarker, stderr: privateMarker, cancelled: false, timedOut: false,
        outputTruncated: false, requestSent: true, resources: { ...resource, childrenClosed: true, phase: "closed",
          exitObserved: true, resultReceived: true, inventory: { known: true, members: [] } } }
    },
  }
  const observation = extract("function validateFirstBodyTerminalReport(", "export function savePayloadDigest(")
  const execute = vm.runInNewContext(`${observation}\n${journal}\n${validator}\n${qualifier}\n${attribution}\n${worker}\nrunProducerGate1Worker`, context)
  let error
  try { await execute({ id, root: "/owned" }) } catch (caught) { error = caught }
  return { state, disk, error }
}

for (const selectorCase of ["tampered", "missing", "valid"]) {
  test(`actual owner authenticates selector ${selectorCase} before registration/native dispatch`, async () => {
    const result = await probe({ monitored: true, selectorCase })
    assert.equal(result.error?.code, selectorCase === "valid"
      ? "selector_registration_boundary_reached" : "producer_currentness_changed")
    assert.equal(result.state.selectorRegistrations, selectorCase === "valid" ? 1 : 0)
    assert.equal(result.state.monitorStarts, 0)
    assert.equal(result.state.native, 0)
    assert.equal(result.state.replies.length, 0)
  })
}

test("live body capability grants one journal-approved stage and commit then owner attributes after closure", async (t) => {
  const result = await probe()
  assert.equal(result.error, undefined)
  assert.deepEqual(result.state.phases, ["stage", "commit"])
  t.diagnostic(JSON.stringify({ disk: result.disk, state: result.state }))
  assert.equal(result.disk.state, "effect_attributed")
  assert.equal(result.disk.executionCount, 1)
  assert.equal(result.disk.attribution.publication, "not_started")
  assert.equal(result.disk.attribution.targetCommit, "b".repeat(40))
  assert.equal(result.disk.producerDeadline, 10000)
  assert.equal(result.disk.publicationDeadline, 60000)
})
test("matching commit witness cannot promote ordinary failed command through owner qualification", async () => {
  const result = await probe({ commitStatus: 1 })
  assert.equal(result.disk.state, "blocked")
  assert.equal(result.disk.reason, "producer_commit_failed")
  assert.equal(result.disk.bodyOutcome.command.status, 1)
  assert.equal(result.state.targetReadback, 0)
})
test("qualified response loss keeps original native failure separate from attributed success", async () => {
  const result = await probe({ nativeError: "native_outcome_unknown" })
  assert.equal(result.disk.state, "effect_attributed")
  assert.equal(result.disk.outcome.status, null)
  assert.equal(result.disk.outcome.error, "native_outcome_unknown")
  assert.equal(result.disk.attribution.operation, "recovered_response_loss")
})
test("owner no-op settlement never reads a new witness or creates commit attribution", async () => {
  const result = await probe({ noOp: true })
  assert.equal(result.disk.state, "body_settled")
  assert.equal(result.disk.reason, "nothing_to_commit")
  assert.equal(result.state.targetReadback, 0)
  assert.equal(result.disk.attribution, "provisional")
})
test("hook/body/native private marker is absent from ordinary journal and diagnostics", async () => {
  const marker = "PRIVATE-DOCUMENT-RAW-HOOK-MARKER"
  const result = await probe({ commitStatus: 1, privateMarker: marker })
  assert.equal(JSON.stringify(result.disk).includes(marker), false)
  assert.equal(result.state.diagnostics.includes(marker), false)
  assert.equal(result.disk.outcome.output.stderr.bytes, Buffer.byteLength(marker))
  assert.equal(result.disk.bodyOutcome.command.output.stderr.bytes, Buffer.byteLength(marker))
})
test("bound descriptor close is durably approved and reports closure before later stage", async () => {
  const result = await probe({ descriptorCase: true })
  assert.deepEqual(result.state.phases, ["open", "write", "close", "stage", "commit"])
  assert.equal(result.disk.bodyFiles[0].descriptor, 17)
  assert.equal(result.disk.bodyFiles[0].closed, true)
  assert.equal(result.disk.bodyHistory.find((phase) => phase.phase === "close").detail.descriptor, 17)
})
for (const phase of ["stage", "close"]) {
  for (const status of ["failed", "missing", false, null]) {
    test(`FIRST ${phase} result ${String(status)} cannot become completed history or a valid no-op report`, async () => {
      const result = await probe({ descriptorCase: phase === "close", newLifecycle: true, terminalSchema2: true,
        noOpAfterPhases: true, badPhaseResult: { phase, status } })
      const admitted = result.disk.bodyHistory.find(step => step.phase === phase)
      assert.equal(admitted.state, "unknown")
      assert.equal(result.state.replies.some(reply => reply.kind === "phase-recorded" && reply.sequence === admitted.sequence), false)
      assert.equal(result.state.replies.some(reply => reply.kind === "body-recorded"), false)
      assert.equal(result.disk.bodyLifecycle.completedReportCount, 0)
      if (phase === "close") assert.equal(result.disk.bodyFiles[0].closed, false)
    })
  }
}
test("FIRST phase success rejects fields outside its supported result schema", async () => {
  const result = await probe({ newLifecycle: true, terminalSchema2: true, noOpAfterPhases: true,
    badPhaseResult: { phase: "stage", status: "completed", extra: true } })
  assert.equal(result.disk.bodyHistory[0].state, "unknown")
  assert.equal(result.state.replies.some(reply => reply.kind === "phase-recorded"), false)
})
test("FIRST exact completed stage result is recorded and permits a matching no-op terminal observation", async () => {
  const result = await probe({ newLifecycle: true, terminalSchema2: true, noOpAfterPhases: true })
  assert.equal(result.disk.bodyHistory[0].state, "completed")
  assert.equal(result.state.replies.some(reply => reply.kind === "body-recorded"), true)
  assert.equal(result.disk.bodyLifecycle.completedReportCount, 1)
})
test("a substituted descriptor cannot obtain close approval", async () => {
  const result = await probe({ descriptorCase: true, wrongDescriptor: true })
  assert.deepEqual(result.state.phases, ["open", "write"])
  assert.equal(result.disk.bodyFiles[0].closed, false)
  assert.ok(result.state.replies.some((reply) => reply.reason === "producer_descriptor_refused"))
})
for (const mutation of ["command-failed", "native-failed", "classification-mismatch"]) {
  test(`completed owner journal cannot falsely qualify ${mutation}`, async () => {
    const { disk } = await probe()
    const record = structuredClone(disk)
    if (mutation === "command-failed") record.bodyOutcome.command.status = 1
    if (mutation === "native-failed") record.outcome.status = 1
    if (mutation === "classification-mismatch") record.attribution.operation = "recovered_response_loss"
    const validate = vm.runInNewContext(`${validator}\nvalidateRecord`, {
      UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      fault: (code) => Object.assign(new Error(code), { code }),
    })
    assert.throws(() => validate(record, { root: "/owned", rootIdentity: "root", person: null, binding: { key: "binding" } }, disk.id),
      { code: "producer_record_invalid" })
  })
}
for (const mutation of ["native-failed", "command-failed", "commit-present"]) {
  test(`no-op journal cannot falsely qualify ${mutation}`, async () => {
    const { disk } = await probe({ noOp: true })
    const record = structuredClone(disk)
    if (mutation === "native-failed") record.outcome.status = 1
    if (mutation === "command-failed") record.bodyOutcome.command = { status: 1, error: null }
    if (mutation === "commit-present") record.bodyHistory = [{ phase: "commit" }]
    const validate = vm.runInNewContext(`${validator}\nvalidateRecord`, {
      UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      fault: (code) => Object.assign(new Error(code), { code }),
    })
    assert.throws(() => validate(record, { root: "/owned", rootIdentity: "root", person: null, binding: { key: "binding" } }, disk.id),
      { code: "producer_record_invalid" })
  })
}
test("ordinary projection does not expose historical save hook text or forged output metadata", () => {
  const projectSource = extract("function firstBodyLifecycleObservation(", "function validateRecord(")
  const observeSource = extract("function bodyObservation(", "export function savePayloadDigest(")
  const project = vm.runInNewContext(`${observeSource}\n${projectSource}\nprojection`, { producerCommandOutcome })
  const marker = "PRIVATE-DOCUMENT-RAW-HOOK-MARKER"
  const result = project({ kind: "desk-save", outcome: { status: 1, stderr: marker, stdout: marker },
    bodyOutcome: { state: "blocked", message: marker, command: { status: 1, stderr: marker,
      output: { stdout: { bytes: 0, sha256: "a".repeat(64), raw: marker },
        stderr: { bytes: 0, sha256: "a".repeat(64), raw: marker } } } } })
  assert.equal(JSON.stringify(result).includes(marker), false)
  assert.equal(result.outcome.status, 1)
})
test("failed commit journal approval never permits that mutation or another phase", async () => {
  const result = await probe({ denied: "commit" })
  assert.deepEqual(result.state.phases, ["stage"])
  assert.match(result.state.diagnostics, /ENOSPC/)
  assert.equal(result.state.targetReadback, 0)
})
test("an acknowledged phase cannot be replayed under a new sequence", async () => {
  const result = await probe({ replay: true })
  assert.deepEqual(result.state.phases, ["stage"])
  assert.ok(result.state.replies.some((reply) => reply.reason === "producer_phase_replay_refused"))
  assert.equal(result.state.targetReadback, 0)
})
test("a private payload mismatch admits zero outer body execution", async () => {
  const result = await probe({ forgedPayload: true })
  assert.equal(result.state.native, 0)
  assert.equal(result.error.code, "producer_payload_unqualified")
})
test("malformed authenticated schema2 terminal report gets no body-recorded acknowledgement or completion count", async () => {
  const result = await probe({ noOp: true, terminalSchema2: true, malformedTerminal: true })
  assert.equal(result.state.replies.some(reply => reply.kind === "body-recorded"), false)
  assert.equal(result.disk.bodyOutcome, undefined)
  assert.equal(result.disk.executionCount, 0)
})
test("valid schema2 no-op is persisted before body acknowledgement and never seeks a commit witness", async () => {
  const result = await probe({ noOp: true, terminalSchema2: true })
  assert.equal(result.state.replies.some(reply => reply.kind === "body-recorded"), true)
  assert.equal(result.disk.terminalReport.schema_version, 2)
  assert.equal(result.disk.bodyOutcome.reason, "nothing_to_commit")
  assert.equal(result.state.targetReadback, 0)
})
test("terminal journal failure withholds ACK while retaining the validated report in failure diagnostics", async () => {
  const result = await probe({ noOp: true, terminalSchema2: true, terminalPersistFault: true })
  assert.equal(result.state.replies.some(reply => reply.kind === "body-recorded"), false)
  assert.match(result.state.diagnostics, /EIO/)
  assert.match(result.state.diagnostics, /nothing_to_commit/)
  assert.equal(result.state.targetReadback, 0)
})
test("new FIRST lifecycle records body entry separately from its later completed report", async () => {
  const result = await probe({ newLifecycle: true, noOp: true, terminalSchema2: true })
  assert.equal(result.state.replies.some(reply => reply.kind === "body-started-recorded"), true)
  assert.equal(result.disk.bodyLifecycle.version, 2)
  assert.equal(result.disk.bodyLifecycle.grantIssueCount, 1)
  assert.equal(result.disk.bodyLifecycle.observedStartCount, 1)
  assert.equal(result.disk.bodyLifecycle.completedReportCount, 1)
  assert.equal(result.disk.executionCount, 1)
})
test("new FIRST grant with missing body observation does not report zero physical execution", async () => {
  const result = await probe({ newLifecycle: true, observeBodyStart: false, replay: true })
  assert.equal(result.disk.bodyLifecycle.grantIssueCount, 1)
  assert.equal(result.disk.bodyLifecycle.observedStartCount, 1, "An admitted stage itself observes body invocation")
  assert.equal(result.disk.bodyLifecycle.completedReportCount, 0)
  assert.equal(result.disk.executionCount, 1)
})
test("new FIRST lifecycle cannot acknowledge a legacy terminal report as schema2 completion", async () => {
  const result = await probe({ newLifecycle: true, noOp: true })
  assert.equal(result.state.replies.some(reply => reply.kind === "body-recorded"), false)
  assert.equal(result.disk.bodyLifecycle.completedReportCount, 0)
  assert.equal(result.disk.bodyOutcome, undefined)
})
test("duplicate validated schema2 report cannot obtain another completion ACK or increment", async () => {
  const result = await probe({ newLifecycle: true, terminalSchema2: true, noOp: true, duplicateTerminal: true })
  assert.equal(result.state.replies.filter(reply => reply.kind === "body-recorded").length, 1)
  assert.equal(result.disk.bodyLifecycle.completedReportCount, 1)
  assert.equal(result.disk.executionCount, 1)
  assert.ok(result.state.replies.some(reply => reply.reason === "producer_report_duplicate"))
  assert.equal(result.state.targetReadback, 0)
})
for (const mutation of ["missing-terminal", "wrong-terminal-id", "missing-start", "wrong-start-id"]) {
  test(`NEW FIRST record observer refuses inconsistent lifecycle evidence ${mutation}`, async () => {
    const result = await probe({ newLifecycle: true, noOp: true, terminalSchema2: true })
    const record = structuredClone(result.disk)
    if (mutation === "missing-terminal") delete record.terminalReport
    if (mutation === "wrong-terminal-id") record.terminalReport.operationId = "22222222-2222-4222-8222-222222222222"
    if (mutation === "missing-start") {
      record.bodyLifecycle.completedReportCount = 0
      delete record.terminalReport; delete record.bodyOutcome; delete record.bodyStartObservation
      record.state = "accepted"
    }
    if (mutation === "wrong-start-id") {
      record.bodyLifecycle.completedReportCount = 0
      delete record.terminalReport; delete record.bodyOutcome
      record.state = "accepted"
      record.bodyStartObservation = { operationId: "wrong", observedAtMs: 1000 }
    }
    const validate = vm.runInNewContext(`${validator}\nvalidateRecord`, {
      digest: hash, UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
      fault: code => Object.assign(new Error(code), { code }),
    })
    assert.throws(() => validate(record, { root: "/owned", rootIdentity: "root", person: null, binding: { key: "binding" } }, record.id),
      { code: "producer_record_invalid" })
  })
}
test("reused executor generation after the private grant obtains no later mutation approval", async () => {
  const result = await probe({ actorChangedAfterGrant: true })
  assert.deepEqual(result.state.phases, [])
  assert.equal(result.state.targetReadback, 0)
  assert.ok(result.state.replies.some(reply => reply.reason === "producer_executor_relationship_refused"))
})
test("accepted FIRST metadata owner keeps one local policy monitor across body phases and closed-group readback", async () => {
  const result = await probe({ monitored: true })
  assert.equal(result.error, undefined)
  assert.equal(result.disk.state, "effect_attributed")
  assert.equal(result.state.monitorStarts, 1)
  assert.ok(result.state.monitorAsserts > 5)
  assert.equal(result.state.monitorCloses, 1)
  const grant = result.state.replies.find(reply => reply.kind === "save-capability")
  assert.equal(hash(grant.footprint), hash({ records: [], envDigest: "virtual" }))
})
test("metadata owner refuses a footprint substituted after caller transfer before any native admission", async () => {
  const result = await probe({ monitored: true, substitutedFootprint: true })
  assert.equal(result.error?.code, "producer_currentness_changed")
  assert.equal(result.state.native, 0)
})
test("serialized executor output cannot mint an owner receipt or invoke the participating commit helper", async () => {
  assert.throws(() => producerBodyReceiptOf({ nativeResult: { status: 0, resources: { childrenClosed: true } } }),
    { code: "producer_body_receipt_required" })
  assert.throws(() => producerBodyProofOf({ targetCommit: "b".repeat(40) }), { code: "producer_body_receipt_required" })
  await assert.rejects(commitPaths("/untrusted", ["owned.md"], "no mutation", () => assert.fail("Git must not run"), "main",
    { executionCapability: {} }), { code: "producer_execution_capability_required" })
})
for (const corrupted of [false, "hash", "offset", "oversize"]) {
  test(`bounded private content frames ${corrupted || "preserve"} validate bytes before capability execution`, async () => {
    const parse = vm.runInNewContext(`${extract("async function receiveSavePayload(", "export async function runProducerSaveExecutor(")}\nreceiveSavePayload`, {
      Buffer, createHash, savePayloadDigest: canonical,
      fault: (code) => Object.assign(new Error(code), { code }),
    })
    const content = "\0".repeat(1024 * 1024), bytes = Buffer.from(content)
    const payload = { paths: [], message: "payload", tidy: false, files: [{ path: "owned.md", content }] }
    const frames = [{ kind: "payload-file", path: "owned.md", ordinal: 0, bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }]
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
      frames.push({ kind: "payload-chunk", ordinal: 0, offset, bytes: bytes.subarray(offset, offset + 64 * 1024).toString("base64") })
    }
    frames.push({ kind: "payload-file-complete", ordinal: 0 }, { kind: "payload-complete",
      digest: canonical(payload) })
    if (corrupted === "hash") frames[0].sha256 = "f".repeat(64)
    if (corrupted === "offset") frames[1].offset = 1
    if (corrupted === "oversize") frames[0].bytes += 1
    const operation = parse(async () => frames.shift(), { payload: { paths: [], message: "payload", tidy: false, fileCount: 1 } })
    if (corrupted) await assert.rejects(operation, { code: "producer_payload_unqualified" })
    else assert.equal((await operation).files[0].content, content)
  })
}

async function executorProtocolFixture(selectorCase = null) {
  const outgoing = [], executions = new WeakMap(), id = "11111111-1111-4111-8111-111111111111"
  const monitorEvents = [], footprint = { records: [], envDigest: "virtual" }
  const registrationEvents = [], selection = { version: 1, operationId: id, createdAtMs: 0,
    producerDeadline: 10000, publicationDeadline: 60000, source: "snapshot", value: "/Applications/Xcode.app/Contents/Developer" }
  const payload = { paths: ["owned.md"], files: [], message: "no-op", tidy: false }
  const peer = new EventEmitter()
  peer.setEncoding = () => {}
  peer.destroy = () => { peer.destroyed = true }
  peer.write = text => {
    const message = JSON.parse(text); outgoing.push(message)
    if (message.nonce) {
      queueMicrotask(() => peer.emit("data", [
        { kind: "save-capability", id, authority: { root: "/owned", env: {} }, terminalSchema: 2,
          producerCurrentness: { version: 1, operationId: id, originalDeadline: 10000, footprintDigest: hash(footprint),
            ...(selectorCase ? { selectorDigest: hash(selection) } : {}) },
          ...(selectorCase && selectorCase !== "missing" ? { operationSelection:
            selectorCase === "tampered" ? { ...selection, value: "/foreign" } : selection } : {}),
          footprint,
          producerDeadline: 10000, publicationDeadline: 60000, payload: { ...payload, fileCount: 0 } },
        { kind: "payload-complete", digest: savePayloadDigest(payload) },
      ].map(value => JSON.stringify(value)).join("\n") + "\n"))
    } else if (message.kind === "body-started") queueMicrotask(() => peer.emit("data", '{"kind":"body-started-recorded"}\n'))
    else if (message.kind === "body-outcome") queueMicrotask(() => peer.emit("data", '{"kind":"body-recorded"}\n'))
  }
  const container = { pid: 20, start: "native", deadline: 10000 }
  const boundedDigest = vm.runInNewContext(`${canonicalSource}\nsavePayloadDigest`, {
    Buffer, createHash, Date: class extends Date { static now() { return 1000 } },
    fault: code => Object.assign(new Error(code), { code }),
  })
  const context = {
    Buffer, createHash, executions, savePayloadDigest: boundedDigest,
    digest: hash, createPublicationContext: () => Object.freeze({}),
    closePublicationContext: () => monitorEvents.push("context-closed"),
    registerTransferredFirstOperationEnvironment: args => {
      registrationEvents.push(args)
      assert.equal(args.expectedDigest, hash(selection))
      assert.equal(args.createdAtMs, 0)
      assert.equal(args.operationId, id)
      assert.equal(args.producerDeadline, 10000)
      assert.equal(args.publicationDeadline, 60000)
      throw Object.assign(new Error("Actual registrar reached before capability"), { code: "selector_registration_boundary_reached" })
    },
    closeFirstOperationEnvironment() {},
    beginFirstSaveCurrentness: ({ expectedFootprint, operationId, producerDeadline }) => {
      assert.equal(hash(expectedFootprint), hash(footprint)); assert.equal(operationId, id); assert.equal(producerDeadline, 10000)
      monitorEvents.push("started"); return { monitor: Object.freeze({}) }
    },
    closeFirstSaveCurrentness: () => monitorEvents.push("closed"),
    process: { pid: 30, env: { DESK_PRODUCER_EXECUTOR_NONCE: "private", DESK_RECOVERY_CONTAINER: JSON.stringify(container) } },
    Date: class extends Date { static now() { return 1000 } },
    UUID: /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/,
    fault: code => Object.assign(new Error(code), { code }),
    generation: () => ({ pid: 30, start: "self" }),
    createConnection: () => { queueMicrotask(() => peer.emit("connect")); return peer },
    setTimeout: () => ({}), clearTimeout() {},
    validateExecution: async capability => {
      if (selectorCase) assert.fail("Selector boundary test must never reach a body capability")
      assert.equal(executions.get(capability).active, true)
    },
    executeAcceptedDeskSave: async ({ executionCapability }) => {
      const execution = executions.get(executionCapability)
      assert.equal(execution.terminalSchema, 2)
      assert.ok(execution.currentnessMonitor)
      await execution.started()
      return { state: "body_settled", reason: "nothing_to_commit", producerDeadline: 10000, publicationDeadline: 60000,
        command: null, proof: null, attribution: "provisional", publication: "not_started",
        protocol: { ...execution.protocol },
        effects: { status: "unknown", readback_required: true, applied_paths: [], uncertain_paths: [], open_files: [], dispatches: [] },
        noOpWitness: { status: 0, error: null, signal: null, selectedChangedPaths: [] } }
    },
  }
  const receive = extract("async function receiveSavePayload(", "export async function runProducerSaveExecutor(")
  const client = source.slice(source.indexOf("export async function runProducerSaveExecutor("))
    .replace("export async function", "async function")
    .replace('const { executeAcceptedDeskSave } = await import("./producer-body.js")', "")
  const run = vm.runInNewContext(`${receive}\n${client}\nrunProducerSaveExecutor`, context)
  let error
  try { await run({ socket: "/private/socket" }) } catch (caught) { if (!selectorCase) throw caught; error = caught }
  return { outgoing, peer, monitorEvents, registrationEvents, error, id }
}
test("new executor emits a complete terminal envelope and retains a private policy monitor on its live peer", async () => {
  const { outgoing, peer, monitorEvents, id } = await executorProtocolFixture()
  const report = outgoing.find(value => value.kind === "body-outcome")
  assert.equal(report.schema_version, 2)
  assert.equal(report.operationId, id)
  assert.equal(report.producerDeadline, 10000)
  assert.equal(report.publicationDeadline, 60000)
  assert.equal(Object.hasOwn(report.outcome, "producerDeadline"), false)
  assert.equal(outgoing.filter(value => value.kind === "body-started").length, 1)
  assert.equal(peer.destroyed, true)
  assert.deepEqual(monitorEvents, ["started", "closed", "context-closed"])
})
for (const selectorCase of ["tampered", "missing", "valid"]) {
  test(`actual executor authenticates selector ${selectorCase} before registration/capability`, async () => {
    const result = await executorProtocolFixture(selectorCase)
    assert.equal(result.error?.code, selectorCase === "valid"
      ? "selector_registration_boundary_reached" : "producer_currentness_changed")
    assert.equal(result.registrationEvents.length, selectorCase === "valid" ? 1 : 0)
    assert.equal(result.outgoing.some(message => ["body-started", "body-outcome"].includes(message.kind)), false)
    assert.equal(result.peer.destroyed, true)
  })
}
