import "../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import vm from "node:vm"
import path from "node:path"
import { producerCommandOutcome, savePayloadDigest } from "../../../../../plugins/desk/mcp/src/runtime/producer-state.js"

const file = path.resolve("plugins/desk/mcp/src/runtime/producer-body.js")
const source = fs.readFileSync(file, "utf8").replace(/^import .*$/gmu, "").replaceAll("export async function", "async function")
const producerSource = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
const environmentChecks = producerSource.slice(producerSource.indexOf("function compareFirstCommandEnvironment("),
  producerSource.indexOf("export function assertExecution(")).replaceAll("export function", "function")

function actualPreparation(state) {
  const pathsSource = fs.readFileSync(path.resolve("plugins/desk/mcp/src/util/paths.js"), "utf8")
  const cardsSource = fs.readFileSync(path.resolve("plugins/desk/mcp/src/desk/card-commit-guard.js"), "utf8")
  const toolSource = fs.readFileSync(path.resolve("plugins/desk/mcp/src/tools/desk-save.js"), "utf8")
  const pathsBegin = pathsSource.indexOf("export function personPrefix(")
  const pathsEnd = pathsSource.indexOf("\n}", pathsSource.indexOf("export function isPathContained(")) + 2
  const cardsBegin = cardsSource.indexOf("export function isLiveCardPath(")
  const cardsEnd = cardsSource.indexOf("\n}", cardsBegin) + 2
  const metadata = file => {
    state.validationReads ??= []
    state.validationReads.push(file)
    if (file !== "/owned" && file !== "/owned/owned.md") throw Object.assign(new Error("Virtual target missing"), { code: "ENOENT" })
    return { isDirectory: () => file === "/owned", isFile: () => file !== "/owned", isSymbolicLink: () => false }
  }
  const stat = (file, options) => {
    try { return metadata(file) }
    catch (error) { if (options?.throwIfNoEntry === false) return undefined; throw error }
  }
  const realpath = file => { metadata(file); return file }
  realpath.native = realpath
  const noMutation = () => { throw new Error("Preparation must not mutate") }
  const context = { path, Buffer, Date: class extends Date { static now() { return state.clock } },
    statSync: stat, lstatSync: stat, existsSync: file => file === "/owned" || file === "/owned/owned.md",
    realpathSync: realpath, fs: { stat: async file => metadata(file), lstat: async file => metadata(file),
      realpath: async file => realpath(file), mkdir: noMutation, open: noMutation, writeFile: noMutation } }
  return vm.runInNewContext(`${pathsSource.slice(pathsBegin, pathsEnd).replaceAll("export ", "")}
    ${cardsSource.slice(cardsBegin, cardsEnd).replaceAll("export ", "")}
    ${toolSource.replace(/^import .*$/gmu, "").replace(/^export /gmu, "")}
    ;({prepare: prepareDeskSaveInput, personPrefix, isPathContained, resolveWriteTarget})`, context)
}

function harness({ denied = null, clock = 1000, rootChange = null, commitStatus = 0, conflict = false,
  clean = false, foreignCard = false, reportDenied = null, writeFailure = false, closeFailure = false,
  privateMarker = "", onReport = null, schema2 = false, changeCommandEnv = false, finalTargetChange = null,
  developerValue, changeCommandSelector = false } = {}) {
  const capability = Object.freeze({})
  const state = { calls: [], approvals: [], results: [], clock, writes: [], handles: [] }
  const preparation = actualPreparation(state)
  const authority = { root: "/owned", person: null, env: {}, binding: { branch: "refs/heads/main" } }
  if (developerValue !== undefined) authority.env.DEVELOPER_DIR = developerValue
  const run = (command, args, options) => {
    state.lastCommandEnv = options.env
    state.calls.push({ command, args, timeout: options.timeout })
    const op = args[2]
    const output = op === "rev-parse" ? "a".repeat(40) + "\n"
      : op === "ls-files" && args.includes("-u") ? conflict ? "unmerged entries\0" : ""
        : op === "ls-files" && args.includes("--others") ? "" : op === "diff" && args.includes("--name-only") ? clean ? "" : "owned.md\0"
          : op === "diff" && args.includes("--cached") ? `${clean ? "" : "M\0owned.md\0"}${foreignCard ? "M\0foreign.task\0" : ""}`
        : op === "ls-files" ? `100644 ${"b".repeat(40)} 0\towned.md\0`
      : op === "ls-tree" ? "" : op === "commit" ? "" : ""
    return { status: op === "commit" ? commitStatus : 0, stdout: output, stderr: op === "commit" ? privateMarker : "", error: undefined }
  }
  const execution = { authority, id: "owned-request", producerDeadline: 5000, publicationDeadline: 55000,
    terminalSchema: schema2 ? 2 : undefined,
    commandBaseEnv: Object.freeze({ ...authority.env }),
    protocol: { lastIntentSequence: 0, lastApprovalAckSequence: 0, lastCompletedSequence: 0 },
    started: async () => { state.starts = (state.starts ?? 0) + 1 },
    payload: { paths: ["owned.md"], files: [{ path: "owned.md", content: "BODY\n" }], message: "owned body", tidy: false },
    approve: async (step) => {
      execution.protocol.lastIntentSequence = step.sequence
      state.approvals.push(step)
      if (step.phase === rootChange) state.changed = true
      if (step.phase === denied) throw Object.assign(new Error("Approval unavailable"), { code: "producer_approval_refused" })
      if (step.phase === "stage" && changeCommandEnv) state.lastCommandEnv.PATH = "/foreign"
      if (step.phase === "stage" && changeCommandSelector) state.lastCommandEnv.DEVELOPER_DIR = "/foreign"
      execution.protocol.lastApprovalAckSequence = step.sequence
    },
    report: async (result) => {
      state.results.push(result)
      onReport?.(result, state)
      if (result.phase === reportDenied) throw Object.assign(new Error("Channel lost"), { code: "producer_channel_closed" })
      if (result.sequence !== undefined) execution.protocol.lastCompletedSequence = result.sequence
    },
  }
  const context = {
    Buffer, Date: class extends Date { static now() { return state.clock } }, path,
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    producerExecution: (value) => { if (value !== capability || execution.active === false) throw Object.assign(new Error("No authority"), { code: "producer_execution_capability_required" }); return execution },
    producerCommandOutcome,
    assertExecution: () => {
      if (state.closed) throw Object.assign(new Error("Channel closed"), { code: "producer_execution_channel_closed" })
      if (state.changed) throw Object.assign(new Error("Binding changed"), { code: "publication_binding_changed" })
    },
    prepareDeskSaveInput: preparation.prepare,
    spawnSync: run, isLiveCardPath: (file) => file === "foreign.task",
    personPrefix: preparation.personPrefix, isPathContained: preparation.isPathContained,
    resolveWriteTarget: async args => {
      await preparation.resolveWriteTarget(args)
      if (state.approvals.at(-1)?.phase === "open" && finalTargetChange) {
        state[finalTargetChange === "policy" ? "changed" : "closed"] = true
      }
    }, createHash: () => ({ update() { return this }, digest: () => "c".repeat(64) }),
    fs: {
      mkdir: async (file) => { state.writes.push(["mkdir", file]) },
      open: async (file) => { state.writes.push(["open", file]); const handle = {
        fd: 17, writeFile: async (content) => {
          state.writes.push(["write", file, content])
          if (writeFailure) throw Object.assign(new Error("IO failed"), { code: "EIO" })
        }, close: async () => {
          state.writes.push(["close", file])
          if (closeFailure) throw Object.assign(new Error("Close failed"), { code: "EIO" })
        },
      }; state.handles.push(handle); return handle },
    },
    constants: { O_WRONLY: 1, O_CREAT: 2, O_TRUNC: 4, O_NOFOLLOW: 8 },
    mkdtempSync: () => "/owned-private/index", lstatSync: () => ({ dev: 1n, ino: 2n, mode: 0o40700n, isFile: () => true }),
    os: { tmpdir: () => "/owned-private" },
  }
  context.validateExecution = async capability => context.assertExecution(capability)
  const api = vm.runInNewContext(`${environmentChecks}\n${source}\n;({ execute: executeAcceptedDeskSave,
    validationInput: typeof canonicalSaveValidationInput === "function" ? canonicalSaveValidationInput : undefined,
    retainedHandles: () => typeof pendingFileHandles === "undefined" ? [] : Array.from(pendingFileHandles) })`, context)
  state.retainedHandles = api.retainedHandles
  return { state, capability, execution, prepareInput: input => preparation.prepare({ deskRoot: "/owned", person: null, input, deadline: 5000 }), ...api }
}

for (const [label, input] of [
  ["paths-only", { paths: ["owned.md"], message: "canonical", tidy: false }],
  ["files-only", { files: [{ path: "owned.md", content: "BODY\n" }], message: "canonical", tidy: false }],
  ["both", { paths: ["owned.md"], files: [{ path: "owned.md", content: "BODY\n" }], message: "canonical", tidy: false }],
]) test(`actual public preparation and body accept authenticated canonical ${label} under model actor boundary`, async () => {
  const f = harness({ schema2: true, clean: true })
  const prepared = await f.prepareInput(input)
  f.execution.payload = { paths: prepared.paths, files: prepared.files, message: prepared.message, tidy: prepared.tidy }
  const before = JSON.stringify(f.execution.payload)
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "body_settled")
  assert.equal(result.reason, "nothing_to_commit")
  assert.equal(JSON.stringify(f.execution.payload), before)
  if (label === "paths-only") assert.equal(f.state.writes.length, 0)
  else assert.deepEqual(f.state.writes.map(row => row[0]), ["mkdir", "open", "write", "close"])
})
for (const payload of [
  { paths: [], files: [], message: "invalid", tidy: false },
  { paths: '["owned.md"]', files: [{ path: "owned.md", content: "x" }], message: "invalid", tidy: false },
  { paths: ["owned.md"], files: '[{"path":"owned.md","content":"x"}]', message: "invalid", tidy: false },
  { paths: ["owned.md"], files: [], message: "invalid", tidy: "yes" },
  { paths: null, files: [], message: "invalid", tidy: false },
  { paths: ["owned.md"], files: [null], message: "invalid", tidy: false },
  { paths: ["owned.md"], files: [], message: "invalid", tidy: false, extra: "unknown canonical field" },
]) test(`actual body rejects malformed canonical shape before mutation ${JSON.stringify(payload)}`, async () => {
  const f = harness({ schema2: true, clean: true })
  f.execution.payload = payload
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.reason, "producer_payload_unqualified")
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.calls.length, 0)
})
for (const input of [{ paths: [], message: "invalid" }, { files: [], message: "invalid" },
  { paths: ["owned.md"], files: [], message: "invalid" }, { paths: [], files: [{ path: "owned.md", content: "x" }], message: "invalid" }]) {
  test(`actual public validator still rejects explicit empty dimensions ${JSON.stringify(input)}`, async () => {
    const f = harness()
    await assert.rejects(f.prepareInput(input))
    assert.equal(f.state.writes.length, 0); assert.equal(f.state.calls.length, 0)
  })
}
test("canonical validation view preserves nonempty references and actual Source structured digest", () => {
  const f = harness()
  const canonical = { paths: ["owned.md"], files: [], message: "view", tidy: false }
  const before = savePayloadDigest(canonical)
  const view = f.validationInput(canonical, 5000)
  assert.notEqual(view, canonical); assert.equal(view.paths, canonical.paths)
  assert.equal(Object.hasOwn(view, "files"), false)
  assert.equal(savePayloadDigest(canonical), before)
  assert.equal(canonical.files.length, 0)
})
for (const dimension of ["paths", "files"]) test(`canonical sparse ${dimension} refuses before mutation`, async () => {
  const f = harness({ schema2: true })
  f.execution.payload = { paths: [], files: [], message: "sparse", tidy: false, [dimension]: new Array(1) }
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.reason, "producer_payload_unqualified")
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.calls.length, 0)
})
test("canonical original deadline expiry during typed iteration never reaches public validation or effects", () => {
  const f = harness()
  const values = ["owned.md"]
  Object.defineProperty(values, 0, { get() { f.state.clock = 5000; return "owned.md" } })
  assert.throws(() => f.validationInput({ paths: values, files: [], message: "expiry", tidy: false }, 5000), { code: "producer_deadline" })
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.calls.length, 0)
})
test("canonical array iterator cannot conceal a sparse authenticated dimension", () => {
  const f = harness(), paths = new Array(1)
  paths[Symbol.iterator] = function* () {}
  assert.throws(() => f.validationInput({ paths, files: [], message: "sparse", tidy: false }, 5000), { code: "producer_payload_unqualified" })
  assert.equal(f.state.writes.length, 0); assert.equal(f.state.calls.length, 0)
})

test("a body without live execution capability cannot write, stage or commit", async () => {
  const f = harness()
  await assert.rejects(f.execute({ executionCapability: {} }), { code: "producer_execution_capability_required" })
  assert.equal(f.state.calls.length, 0)
  assert.equal(f.state.writes.length, 0)
})
test("accepted first save approves every mutation and returns only provisional commit effects", async () => {
  const f = harness()
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "body_settled")
  assert.equal(result.command.status, 0)
  assert.equal(result.attribution, "provisional")
  assert.equal(result.publication, "not_started")
  assert.equal(f.state.calls.filter((call) => call.args[2] === "commit").length, 1)
  assert.equal(f.state.calls.filter((call) => call.args[2] === "push").length, 0)
  assert.deepEqual(Array.from(f.state.approvals.map((step) => step.phase)), ["mkdir", "open", "write", "close", "stage", "commit"])
  assert.ok(f.state.calls.every((call) => call.timeout <= 4000))
  assert.equal(f.retainedHandles().length, 0)
})
test("actual body uses the exact operation-bound selector in every Git command", async () => {
  const selected = "/Applications/Xcode A.app"
  const f = harness({ schema2: true, developerValue: selected })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "body_settled")
  assert.equal(f.state.lastCommandEnv.DEVELOPER_DIR, selected)
  assert.equal(f.execution.commandBaseEnv.DEVELOPER_DIR, selected)
})
test("selector command-env tamper refuses NEXT Git stage without erasing earlier hosted file effects", async () => {
  const f = harness({ schema2: true, developerValue: "/Applications/Xcode A.app/Contents/Developer", changeCommandSelector: true })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "producer_command_environment_changed")
  assert.equal(f.state.calls.some(call => ["add", "commit"].includes(call.args[2])), false)
  assert.equal(result.effects.applied_paths[0], "owned.md")
  assert.equal(f.state.writes.filter(call => call[0] === "write").length, 1)
  assert.equal(result.effects.dispatches.some(step => step.phase === "stage" && step.state === "unknown"), true)
})
test("lost approval prevents its mutation and never replays a prior write", async () => {
  const f = harness({ denied: "stage" })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "blocked")
  assert.equal(result.effects.applied_paths[0], "owned.md")
  assert.equal(f.state.calls.filter((call) => ["add", "commit"].includes(call.args[2])).length, 0)
  assert.equal(f.state.writes.filter((call) => call[0] === "write").length, 1)
})
test("binding change after approval refuses the imminent open before truncating bytes", async () => {
  const f = harness({ rootChange: "open" })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "blocked")
  assert.equal(f.state.writes.filter((call) => ["open", "write"].includes(call[0])).length, 0)
})
for (const change of ["policy", "channel"]) {
  test(`final post-approval target await observes ${change} drift before open truncation`, async () => {
    const f = harness({ schema2: true, finalTargetChange: change })
    const result = await f.execute({ executionCapability: f.capability })
    assert.equal(result.state, "blocked")
    assert.equal(result.reason, change === "policy" ? "publication_binding_changed" : "producer_execution_channel_closed")
    assert.equal(f.state.writes.filter(call => ["open", "write", "close"].includes(call[0])).length, 0)
    assert.equal(result.effects.open_files.length, 0)
    assert.equal(result.effects.dispatches.some(step => step.phase === "open"), false)
  })
}
test("an expired original producer deadline dispatches no body mutations", async () => {
  const f = harness({ clock: 5000 })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "producer_deadline")
  assert.equal(f.state.calls.length, 0)
  assert.equal(f.state.writes.length, 0)
})

test("an ordinary failed commit remains a provisional failure without a mutation retry or receipt", async () => {
  const f = harness({ commitStatus: 1 })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.command.status, 1)
  assert.equal(result.state, "blocked")
  assert.equal(result.reason, "producer_commit_failed")
  assert.equal(result.attribution, "provisional")
  assert.equal(result.publication, "not_started")
  assert.equal(f.state.calls.filter((call) => call.args[2] === "commit").length, 1)
})
for (const options of [{ denied: "close" }, { reportDenied: "open" }, { reportDenied: "write" }, { writeFailure: true }]) {
  test(`descriptor close cannot bypass approval after ${JSON.stringify(options)}`, async () => {
    const f = harness(options)
    const result = await f.execute({ executionCapability: f.capability })
    assert.equal(result.state, "blocked")
    assert.equal(f.state.writes.filter((operation) => operation[0] === "close").length, 0)
    assert.equal(result.effects.open_files[0].descriptor, 17)
    assert.equal(result.effects.open_files[0].closed, false)
    assert.equal(f.state.calls.filter((call) => ["add", "commit"].includes(call.args[2])).length, 0)
  })
}
test("a foreign staged card does not reject selected ordinary-file tidy", async () => {
  const f = harness({ foreignCard: true })
  f.execution.payload.tidy = true
  f.execution.payload.files = []
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "body_settled")
  assert.equal(f.state.calls.filter((call) => call.args[2] === "commit").length, 1)
})
test("clean selected files with only foreign staging settle no-op before private index or commit", async () => {
  const f = harness({ clean: true, foreignCard: true })
  f.execution.payload.tidy = true
  f.execution.payload.files = []
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.reason, "nothing_to_commit")
  assert.equal(f.state.approvals.length, 0)
  assert.equal(f.state.calls.filter((call) => ["commit", "read-tree", "update-index"].includes(call.args[2])).length, 0)
})
test("private hook output is represented by failure and hashes, never ordinary body text", async () => {
  const marker = "PRIVATE-DOCUMENT-RAW-HOOK-MARKER"
  const f = harness({ commitStatus: 1, privateMarker: marker })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "blocked")
  assert.equal(result.command.status, 1)
  assert.equal(JSON.stringify(result).includes(marker), false)
  assert.equal(result.command.output.stderr.bytes, Buffer.byteLength(marker))
  assert.match(result.command.output.stderr.sha256, /^[0-9a-f]{64}$/)
})

test("tidy body builds a private index within the original budget and never waits for outer closure", async () => {
  const f = harness()
  f.execution.payload.tidy = true
  f.execution.payload.files = []
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "body_settled")
  assert.equal(result.private_resource.custody, "unknown-until-outer-settlement")
  assert.equal(result.attribution, "provisional")
  assert.equal(f.state.calls.filter((call) => call.args[2] === "commit").length, 1)
  assert.equal(f.state.calls.filter((call) => call.args[2] === "push").length, 0)
  assert.ok(f.state.calls.every((call) => call.timeout <= 4000))
})
test("a selected unmerged index blocks staging rather than silently resolving a conflict", async () => {
  const f = harness({ conflict: true })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.reason, "producer_index_conflicted")
  assert.equal(f.state.calls.filter((call) => ["add", "commit"].includes(call.args[2])).length, 0)
})
for (const options of [{ reportDenied: "open" }, { reportDenied: "write" }, { denied: "close" },
  { writeFailure: true }, { closeFailure: true }]) {
  test(`private lifetime custody retains acquired handle identity after ${JSON.stringify(options)}`, async () => {
    const f = harness(options)
    const result = await f.execute({ executionCapability: f.capability })
    assert.equal(result.state, "blocked")
    const acquired = f.state.handles[0]
    assert.equal(f.retainedHandles()[0], acquired)
    f.execution.active = false
    f.execution.payload = null
    f.execution.commitPlan = null
    await assert.rejects(f.execute({ executionCapability: f.capability }), { code: "producer_execution_capability_required" })
    assert.equal(f.retainedHandles()[0], acquired)
    assert.equal(result.effects.open_files[0].closed, false)
  })
}
test("handle identity is strongly retained before the open result report can reject", async () => {
  const f = harness({ reportDenied: "open", onReport: (result, state) => {
    if (result.phase === "open") assert.equal(state.retainedHandles()[0], state.handles[0])
  } })
  await f.execute({ executionCapability: f.capability })
  assert.equal(f.retainedHandles()[0], f.state.handles[0])
})
test("approved successful close releases strong custody even if its later report is lost", async () => {
  const f = harness({ reportDenied: "close" })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.state, "blocked")
  assert.equal(result.effects.open_files[0].closed, true)
  assert.equal(f.state.writes.filter((operation) => operation[0] === "close").length, 1)
  assert.equal(f.retainedHandles().length, 0)
})
test("new FIRST body reports invocation before effects and includes terminal sequence/command observations", async () => {
  const f = harness({ schema2: true })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(f.state.starts, 1)
  assert.equal(result.protocol.lastIntentSequence, 6)
  assert.equal(result.protocol.lastApprovalAckSequence, 6)
  assert.equal(result.protocol.lastCompletedSequence, 6)
  assert.equal(result.command.signal, null)
  assert.equal(result.reason, null)
})
test("new FIRST no-op carries explicit selected-change inspection, not inferred empty paths", async () => {
  const f = harness({ schema2: true, clean: true })
  f.execution.payload.files = []
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.noOpWitness.status, 0)
  assert.deepEqual(Array.from(result.noOpWitness.selectedChangedPaths), [])
  assert.equal(result.command, null)
  assert.equal(result.proof, null)
})
test("new FIRST failed phase records refused intent separately from completed effects", async () => {
  const f = harness({ schema2: true, denied: "stage" })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.failure.phase, "stage")
  assert.equal(result.failure.stage, "pre-admission")
  assert.equal(result.failure.dispatchState, "not_admitted")
  assert.equal(result.failure.intentSequence, 5)
  assert.equal(result.protocol.lastApprovalAckSequence, 4)
  assert.equal(result.effects.applied_paths[0], "owned.md")
})
test("new FIRST body refuses changed actual Git environment after phase approval before staging", async () => {
  const f = harness({ schema2: true, changeCommandEnv: true })
  const result = await f.execute({ executionCapability: f.capability })
  assert.equal(result.reason, "producer_command_environment_changed")
  assert.equal(f.state.calls.filter(call => ["add", "commit"].includes(call.args[2])).length, 0)
  assert.equal(result.effects.applied_paths[0], "owned.md")
})
for (const options of [{}, { clean: true }, { denied: "stage" }, { commitStatus: 1 }]) {
  test(`actual new body report ${JSON.stringify(options)} satisfies the actual broker terminal predicate`, async () => {
    const f = harness({ schema2: true, ...options })
    if (options.clean) f.execution.payload.files = []
    const outcome = await f.execute({ executionCapability: f.capability })
    const source = fs.readFileSync(path.resolve("plugins/desk/mcp/src/runtime/producer-state.js"), "utf8")
    const begin = source.indexOf("function validateFirstBodyTerminalReport("), end = source.indexOf("\nfunction bodyObservation(", begin)
    const validate = vm.runInNewContext(`${source.slice(begin, end)}\nvalidateFirstBodyTerminalReport`, {
      Date: class extends Date { static now() { return 1000 } },
      digest: value => JSON.stringify(value), fault: code => Object.assign(new Error(code), { code }),
    })
    const history = f.state.approvals.filter(step => f.state.results.some(result => result.sequence === step.sequence))
      .map(step => ({ ...step, state: "completed" }))
    const record = { id: f.execution.id, root: "/owned", kind: "desk-save", createdAtMs: -5000,
      producerDeadline: 5000, publicationDeadline: 55000, bodyHistory: history, bodyPhase: history.at(-1),
      payloadManifest: { paths: ["owned.md"], files: [] },
      bodyFiles: outcome.effects.open_files.map(file => ({ path: file.relativePath, descriptor: file.descriptor, closed: file.closed })) }
    const { producerDeadline, publicationDeadline, ...value } = outcome
    const candidate = { kind: "body-outcome", schema_version: 2, operationId: f.execution.id,
      producerDeadline, publicationDeadline, outcome: value }
    assert.equal(validate({ candidate, record, phaseSequence: history.length }).state, outcome.state)
  })
}
