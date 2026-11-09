import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { createServer, createConnection } from "node:net"
import { constants, closeSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  renameSync, rmdirSync, unlinkSync, writeFileSync, readFileSync, realpathSync } from "node:fs"
import path from "node:path"
import os from "node:os"
import { fileURLToPath } from "node:url"
import { captureProducerAdmission, createPublicationContext, closePublicationContext,
  beginFirstSaveCurrentness, assertFirstSaveCurrentness, closeFirstSaveCurrentness,
  prepareFirstOperationEnvironment, registerTransferredFirstOperationEnvironment, closeFirstOperationEnvironment } from "./publication-state.js"
import { resolveDeskStateDir, lastStartRootKey } from "./last-start.js"
import { readSmallText } from "../factory/marker.js"
import { observeRecoveryProcess, runOwnedProcess } from "./recovery-state.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"
import { personPrefix, isPathContained } from "../util/paths.js"

const SCRIPT = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))
const intents = new WeakMap()
const executions = new WeakMap()
const ownerReceipts = new WeakMap()
const bodyReceiptProofs = new WeakMap()
export function producerBodyReceiptOf({ nativeResult }) {
  const receipt = ownerReceipts.get(nativeResult)
  if (!receipt) throw fault("producer_body_receipt_required")
  return receipt
}
export function producerBodyProofOf(receipt) {
  const proof = bodyReceiptProofs.get(receipt)
  if (!proof) throw fault("producer_body_receipt_required")
  return proof
}
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const fault = (code) => Object.assign(new Error(code), { code })
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
export function producerCommandOutcome(result) {
  const code = typeof result.error === "string" ? result.error : result.error?.code
  const output = (text, metadata) => {
    if (metadata) {
      if (!Number.isSafeInteger(metadata.bytes) || metadata.bytes < 0 ||
        !/^[0-9a-f]{64}$/u.test(metadata.sha256 ?? "")) throw fault("producer_output_metadata_invalid")
      return { bytes: metadata.bytes, sha256: metadata.sha256, rawRetained: false }
    }
    const bytes = Buffer.from(typeof text === "string" ? text : "", "utf8")
    return { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), rawRetained: false }
  }
  return { status: result.status, error: code ?? null,
    output: { stdout: output(result.stdout, result.output?.stdout), stderr: output(result.stderr, result.output?.stderr) } }
}
function validateFirstBodyTerminalReport({ candidate, record, phaseSequence }) {
  const invalid = () => { throw fault("producer_terminal_report_invalid") }
  const object = value => value !== null && typeof value === "object" && !Array.isArray(value)
  if (record.terminalReportDigest) throw fault("producer_report_duplicate")
  if (!object(candidate) || candidate.kind !== "body-outcome" || candidate.schema_version !== 2 ||
    Object.keys(candidate).some(key => !["kind", "schema_version", "operationId", "producerDeadline", "publicationDeadline", "outcome"].includes(key)) ||
    candidate.operationId !== record.id || candidate.producerDeadline !== record.producerDeadline ||
    candidate.publicationDeadline !== record.publicationDeadline ||
    record.producerDeadline !== record.createdAtMs + 10000 || record.publicationDeadline !== record.createdAtMs + 60000) invalid()
  if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
  const outcome = candidate.outcome, protocol = outcome?.protocol
  if (!object(outcome) || !object(protocol) || outcome.attribution !== "provisional" ||
    outcome.publication !== "not_started" || !Number.isSafeInteger(phaseSequence) || phaseSequence < 0 ||
    ["lastIntentSequence", "lastApprovalAckSequence", "lastCompletedSequence"].some(key =>
      !Number.isSafeInteger(protocol[key]) || protocol[key] < 0)) invalid()
  const effects = outcome.effects
  if (!object(effects) || ["applied_paths", "uncertain_paths", "open_files", "dispatches"].some(key => !Array.isArray(effects[key])) ||
    !["unknown", "partial", "applied"].includes(effects.status) || effects.readback_required !== true ||
    Object.keys(effects).some(key => !["status", "readback_required", "applied_paths", "uncertain_paths", "open_files", "dispatches"].includes(key))) invalid()
  const paths = [...(record.payloadManifest?.paths ?? []), ...(record.payloadManifest?.files ?? []).map(file => file.path)]
  const ownsPath = file => typeof file === "string" && file.length > 0 && !file.includes("\0") &&
    !file.startsWith("/") && !file.split("/").includes("..") &&
    paths.some(selection => selection === "." || file === selection || file.startsWith(`${selection.replace(/\/$/u, "")}/`))
  if ([...effects.applied_paths, ...effects.uncertain_paths].some(file => !ownsPath(file))) invalid()
  for (const file of effects.open_files) {
    if (!object(file) || !ownsPath(file.relativePath) || !Number.isSafeInteger(file.descriptor) ||
      file.descriptor < 0 || typeof file.closed !== "boolean") invalid()
    const held = record.bodyFiles?.find(value => value.path === file.relativePath && value.descriptor === file.descriptor)
    if (!held || (file.closed && held.closed !== true &&
      !record.bodyHistory?.some(phase => phase.phase === "close" && phase.detail.path === file.relativePath &&
        phase.detail.descriptor === file.descriptor))) invalid()
  }
  if (Object.keys(outcome).some(key => !["state", "reason", "attribution", "publication", "protocol", "effects",
    "command", "proof", "failure", "noOpWitness", "private_resource", "close_error"].includes(key))) invalid()
  const history = record.bodyHistory ?? [], command = outcome.command
  if (!Array.isArray(history) || !["body_settled", "blocked"].includes(outcome.state)) invalid()
  let lastDispatch = 0
  for (const dispatch of effects.dispatches) {
    if (!object(dispatch) || dispatch.id !== record.id || dispatch.producerDeadline !== record.producerDeadline ||
      !Number.isSafeInteger(dispatch.sequence) || dispatch.sequence <= lastDispatch ||
      !["unknown", "completed"].includes(dispatch.state)) invalid()
    const admitted = history.find(phase => phase.sequence === dispatch.sequence)
    if (!admitted || admitted.phase !== dispatch.phase || digest(admitted.detail) !== digest(dispatch.detail)) invalid()
    if (outcome.state === "body_settled" && (dispatch.state !== "completed" || admitted.state !== "completed")) invalid()
    lastDispatch = dispatch.sequence
  }
  if (command !== null) {
    if (!object(command) || (command.status !== null && !Number.isInteger(command.status)) ||
      (command.error !== null && typeof command.error !== "string") ||
      (command.signal !== null && !/^SIG[A-Z0-9]+$/u.test(command.signal ?? "")) ||
      Object.keys(command).some(key => !["status", "error", "signal", "output"].includes(key)) ||
      !object(command.output)) invalid()
    for (const key of ["stdout", "stderr"]) {
      const output = command.output[key]
      if (!object(output) || !Number.isSafeInteger(output.bytes) || output.bytes < 0 ||
        !/^[0-9a-f]{64}$/u.test(output.sha256 ?? "") || output.rawRetained !== false ||
        Object.keys(output).some(field => !["bytes", "sha256", "rawRetained"].includes(field))) invalid()
    }
  }
  if (outcome.state === "body_settled") {
    if (record.bodyPhase?.state === "unknown" || history.some(phase => phase.state !== "completed") ||
      (record.bodyFiles ?? []).some(file => file.closed !== true) || outcome.failure !== undefined ||
      protocol.lastIntentSequence !== phaseSequence || protocol.lastApprovalAckSequence !== phaseSequence ||
      protocol.lastCompletedSequence !== phaseSequence) invalid()
    if (outcome.reason === "nothing_to_commit") {
      const witness = outcome.noOpWitness
      if (command !== null || outcome.proof !== null || history.some(phase => phase.phase === "commit") ||
        !object(witness) || witness.status !== 0 || witness.error !== null || witness.signal !== null ||
        !Array.isArray(witness.selectedChangedPaths) || witness.selectedChangedPaths.length !== 0) invalid()
    } else {
      const commits = history.filter(phase => phase.phase === "commit")
      if (!object(command) || command.status !== 0 || command.error !== null || command.signal !== null ||
        commits.length !== 1 || !object(outcome.proof) || digest(outcome.proof) !== digest(commits[0].detail?.proof) ||
        outcome.reason !== null) invalid()
    }
  } else {
    const failure = outcome.failure
    if (!object(failure) || typeof outcome.reason !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,79}$/u.test(outcome.reason) ||
      failure.code !== outcome.reason || !["pre-admission", "work", "report", "resource"].includes(failure.stage) ||
      !Number.isSafeInteger(failure.intentSequence) || failure.intentSequence < 0 ||
      !["not_admitted", "unknown", "completed"].includes(failure.dispatchState) ||
      protocol.lastApprovalAckSequence > phaseSequence || protocol.lastCompletedSequence > phaseSequence ||
      protocol.lastIntentSequence > phaseSequence + 1) invalid()
    if (failure.intentSequence === phaseSequence + 1) {
      if (failure.stage !== "pre-admission" || failure.dispatchState !== "not_admitted") invalid()
    } else if (failure.intentSequence !== phaseSequence ||
      (record.bodyPhase && failure.phase !== record.bodyPhase.phase)) invalid()
    if (command && !history.some(phase => phase.phase === "commit")) invalid()
    const commit = history.find(phase => phase.phase === "commit")
    if (outcome.proof !== null && (!commit || digest(outcome.proof) !== digest(commit.detail?.proof))) invalid()
  }
  if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
  return outcome
}
function bodyObservation(value) {
  if (!value || typeof value !== "object") throw fault("producer_body_outcome_invalid")
  return { state: value.state, reason: value.reason, effects: value.effects,
    command: value.command ? producerCommandOutcome(value.command) : null, proof: value.proof,
    private_resource: value.private_resource, close_error: value.close_error ? { code: value.close_error.code } : undefined,
    producerDeadline: value.producerDeadline, publicationDeadline: value.publicationDeadline,
    attribution: "provisional", publication: "not_started" }
}
export function savePayloadDigest(payload, deadline = Infinity) {
  const hash = createHash("sha256")
  const check = () => { if (Date.now() >= deadline) throw fault("producer_deadline") }
  const field = (text) => {
    check()
    const bytes = Buffer.from(text, "utf8")
    hash.update(`${bytes.length}:`)
    for (let offset = 0; offset < bytes.length; offset += 65536) {
      check()
      hash.update(bytes.subarray(offset, offset + 65536))
    }
    check()
  }
  field("desk-save-payload-v1")
  field(String(payload.paths.length))
  for (const file of payload.paths) field(file)
  field(String(payload.files.length))
  for (const file of payload.files) { field(file.path); field(file.content) }
  field(payload.message)
  field(payload.tidy === true ? "true" : "false")
  check()
  return hash.digest("hex")
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const equalNonce = (a, b) => typeof a === "string" && typeof b === "string" && a.length === b.length &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b))
const generation = (pid) => {
  const value = observeRecoveryProcess(pid)
  if (value.state !== "present" || !value.start || value.start.includes("unknown")) throw fault("producer_identity_unknown")
  return value
}
export function producerExecution(capability) {
  const value = executions.get(capability)
  if (!value?.active) throw fault("producer_execution_capability_required")
  return value
}
function compareFirstCommandEnvironment({ baseEnv, commandEnv, operationId, indexPath }) {
  const expected = { ...baseEnv, DESK_TOOL_COMMIT: "1", GIT_TERMINAL_PROMPT: "0" }
  if (Object.hasOwn(commandEnv, "GIT_REFLOG_ACTION") && !Object.hasOwn(baseEnv, "GIT_REFLOG_ACTION")) {
    expected.GIT_REFLOG_ACTION = `desk-publication:${operationId}`
  }
  if (indexPath !== null && indexPath !== undefined) expected.GIT_INDEX_FILE = indexPath
  const keys = Object.keys(expected).sort(), actual = Object.keys(commandEnv).sort()
  if (keys.length !== actual.length || keys.some((key, index) => key !== actual[index] || expected[key] !== commandEnv[key])) {
    throw fault("producer_command_environment_changed")
  }
}
export function assertFirstCommandEnvironment({ executionCapability, env }) {
  const execution = producerExecution(executionCapability)
  if (Date.now() >= execution.producerDeadline) throw fault("producer_deadline")
  if (!execution.commandBaseEnv) throw fault("producer_execution_capability_required")
  compareFirstCommandEnvironment({ baseEnv: execution.commandBaseEnv, commandEnv: env,
    operationId: execution.id, indexPath: execution.commandIndexPath })
  if (Date.now() >= execution.producerDeadline) throw fault("producer_deadline")
}
export function assertExecution(capability) {
  const execution = producerExecution(capability)
  if (Date.now() >= execution.producerDeadline) throw fault("producer_deadline")
  if (!execution.peer || execution.peer.destroyed) throw fault("producer_execution_channel_closed")
  if (execution.currentnessMonitor) assertFirstSaveCurrentness({
    monitor: execution.currentnessMonitor, operationId: execution.id, producerDeadline: execution.producerDeadline,
    root: execution.authority.root, person: execution.authority.person, baseEnv: execution.authority.env })
  else validateAuthority(execution.authority, execution.producerDeadline)
  const self = generation(process.pid), native = generation(execution.container.pid)
  if (self.start !== execution.self.start || self.parentPid !== native.pid || self.group !== native.group ||
    native.pid !== execution.container.pid || native.start !== execution.container.start ||
    native.group !== execution.container.pid) throw fault("producer_executor_relationship_refused")
  if (execution.currentnessMonitor) assertFirstSaveCurrentness({
    monitor: execution.currentnessMonitor, operationId: execution.id, producerDeadline: execution.producerDeadline,
    root: execution.authority.root, person: execution.authority.person, baseEnv: execution.authority.env })
}
export async function validateExecution(capability) {
  assertExecution(capability)
}
const folder = (authority) => {
  const directory = path.join(resolveDeskStateDir({ env: authority.env }), "sync",
    `${lastStartRootKey(authority.root)}.producer-gate1`)
  assertNotRealStateUnderTest(directory, { env: authority.env })
  return directory
}
const snapshots = new WeakMap()
const recordIdentity = (stat) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].map((key) => String(stat[key])).join(":")
const read = (file) => {
  const before = lstatSync(file, { bigint: true })
  const text = readSmallText(file, 1024 * 1024)
  const after = lstatSync(file, { bigint: true })
  if (recordIdentity(before) !== recordIdentity(after)) throw fault("producer_record_changed")
  const value = JSON.parse(text)
  snapshots.set(value, { identity: recordIdentity(after), digest: digest(value) })
  return value
}
function save(file, value, exclusive = false, expected = null) {
  const lockFile = `${file}.transition`
  mkdirSync(lockFile, { mode: 0o700 })
  let lockIdentity
  try { lockIdentity = lstatSync(lockFile, { bigint: true }) }
  catch (error) {
    error.producerLock = { path: lockFile, code: error.code ?? "producer_transition_lock_unknown" }
    throw error
  }
  const validateExpected = () => {
    if (exclusive) {
      if (lstatSync(file, { throwIfNoEntry: false }) !== undefined) throw fault("producer_record_exists")
      return
    }
    const snapshot = expected && snapshots.get(expected)
    if (!snapshot || value.id !== expected.id || value.revision !== expected.revision + 1) throw fault("producer_revision_changed")
    const current = read(file)
    if (snapshots.get(current).identity !== snapshot.identity || digest(current) !== snapshot.digest) throw fault("producer_revision_changed")
  }
  const temporary = `${file}.${randomUUID()}.tmp`
  let fd
  let closed = false, identity, primary, closeError, failure
  const current = () => {
    const atPath = lstatSync(temporary, { bigint: true })
    return identity && atPath.isFile() && atPath.dev === identity.dev && atPath.ino === identity.ino &&
      (atPath.nlink === 1n || (exclusive && atPath.nlink === 2n))
  }
  try {
    validateExpected()
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    identity = fstatSync(fd, { bigint: true })
    writeFileSync(fd, `${JSON.stringify(value)}\n`)
  } catch (error) { primary = error }
  if (fd !== undefined) {
    try { closeSync(fd); closed = true } catch (error) { closeError = error; primary ??= error }
  }
  try {
    if (primary) throw primary
    if (!current()) throw fault("producer_record_path_unknown")
    validateExpected()
    if (exclusive) {
      linkSync(temporary, file)
      if (!current()) throw fault("producer_record_path_unknown")
      unlinkSync(temporary)
    } else renameSync(temporary, file)
    const atPath = lstatSync(file, { bigint: true })
    snapshots.set(value, { identity: recordIdentity(atPath), digest: digest(value) })
  } catch (error) {
    failure = error
    error.producerTemporary = { path: temporary, descriptor: fd, closed,
      identity: identity ? { dev: String(identity.dev), ino: String(identity.ino) } : null,
      ...(closeError ? { close_error: closeError.code ?? "producer_record_close_unknown" } : {}) }
    // Unknown closure or pathname identity cannot authorize even exact-path removal.
    if (closed) {
      try { if (current()) unlinkSync(temporary) }
      catch (cleanup) { error.producerTemporary.cleanup_error = cleanup.code ?? "producer_record_cleanup_failed" }
    }
    throw error
  } finally {
    try {
      const atLock = lstatSync(lockFile, { bigint: true, throwIfNoEntry: false })
      if (!atLock?.isDirectory() || atLock.dev !== lockIdentity.dev || atLock.ino !== lockIdentity.ino) throw fault("producer_transition_lock_unknown")
      rmdirSync(lockFile)
    } catch (error) {
      const custody = { path: lockFile, code: error.code ?? "producer_transition_lock_unknown" }
      if (failure) failure.producerLock = custody
      else throw Object.assign(error, { producerLock: custody })
    }
  }
}
function createJournal(file, initial = null) {
  let persisted = initial, failure = null, observed = initial
  let expectedDigest = initial === null ? null : digest(initial)
  const latch = (error) => {
    if (failure) return
    failure = { code: error.code ?? "producer_persistence_failed", message: error.message,
      path: error.path ?? null, dest: error.dest ?? null, syscall: error.syscall ?? null,
      journalPath: file, producerTemporary: error.producerTemporary ?? null, transitionLock: error.producerLock ?? null }
    process.stderr.write(`${JSON.stringify({ code: failure.code, file, retainedTemporary: failure.producerTemporary,
      primaryFilesystem: failure })}\n`)
  }
  const write = (next, exclusive = false) => {
    observed = next
    if (failure) return false
    try {
      save(file, next, exclusive, persisted)
      persisted = next
      expectedDigest = digest(next)
      return true
    } catch (error) {
      latch(error)
      return false
    }
  }
  return { write, latch, matches: (current) => expectedDigest !== null && digest(current) === expectedDigest,
    failed: () => failure, emit: () => {
    if (failure) process.stderr.write(`${JSON.stringify({ id: observed?.id, persistence_error: failure,
      outcome: observed?.outcome, resources: observed?.resources, broker: observed?.broker,
      ...(observed?.kind === "desk-save" ? { bodyOutcome: observed.bodyOutcome, terminalReport: observed.terminalReport,
        bodyHistory: observed.bodyHistory, bodyFiles: observed.bodyFiles } : {}) })}\n`)
  } }
}
function validateAuthority(authority, deadline) {
  const context = createPublicationContext({ root: authority.root, env: authority.env, person: authority.person,
    sessionId: "producer-live-transfer", requireCommitReceipt: true })
  try {
    if (digest(captureProducerAdmission(context, deadline === undefined ? undefined : { deadline })) !== digest(authority)) throw fault("producer_binding_changed")
  } finally { closePublicationContext(context) }
}
function firstBodyLifecycleObservation(record) {
  if (record.bodyLifecycle?.version === 2) {
    return { version: 2, grantIssueCount: record.bodyLifecycle.grantIssueCount,
      observedStartCount: record.bodyLifecycle.observedStartCount,
      completedReportCount: record.bodyLifecycle.completedReportCount, safeRetry: false }
  }
  const history = Array.isArray(record.bodyHistory) ? record.bodyHistory : []
  const observedReport = record.bodyOutcome !== null && typeof record.bodyOutcome === "object"
  const observedStart = observedReport || history.length > 0
  return {
    version: 1,
    legacyExecutionCountMeaning: "completed_body_report",
    grantIssueCount: record.capabilityGranted === true ? 1 : record.requestSent === true ? null : 0,
    observedStartCount: observedStart ? 1 : record.capabilityGranted === true || record.requestSent === true ? null : 0,
    completedReportCount: observedReport ? 1 : 0,
    safeRetry: false,
  }
}
function projection(record) {
  if (record.kind === "desk-save") {
    const native = record.outcome
    return { ...record, bodyLifecycleObservation: firstBodyLifecycleObservation(record),
      bodyOutcome: record.bodyOutcome ? bodyObservation(record.bodyOutcome) : undefined,
      outcome: native ? { ...producerCommandOutcome(native), spawnError: native.spawnError ?? null,
        cancelled: native.cancelled, timedOut: native.timedOut, outputTruncated: native.outputTruncated,
        requestSent: native.requestSent } : undefined }
  }
  return record
}
function validateRecord(record, authority, id) {
  const lifecycle = record.kind === "desk-save" && record.bodyLifecycle?.version === 2 ? record.bodyLifecycle : null
  if (record.version !== 1 || record.id !== id || record.root !== authority.root ||
    record.rootIdentity !== authority.rootIdentity || record.person !== authority.person ||
    record.bindingKey !== authority.binding.key || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
    !Number.isFinite(record.createdAtMs) || record.producerDeadline !== record.createdAtMs + 10000 ||
    record.publicationDeadline !== record.createdAtMs + 60000 ||
    !["reserved", "accepted", "capability_verified", "body_settled", "effect_attributed", "blocked", "unknown"].includes(record.state) ||
    typeof record.requestSent !== "boolean" || !(lifecycle ? [null, 0, 1] : [0, 1]).includes(record.executionCount) ||
    typeof record.resources?.childrenClosed !== "boolean") throw fault("producer_record_invalid")
  if (lifecycle && (![0, 1].includes(lifecycle.grantIssueCount) ||
    ![null, 0, 1].includes(lifecycle.observedStartCount) || ![0, 1].includes(lifecycle.completedReportCount) ||
    record.executionCount !== lifecycle.observedStartCount ||
    (lifecycle.completedReportCount === 1 && lifecycle.observedStartCount !== 1))) throw fault("producer_record_invalid")
  if (lifecycle) {
    const terminal = record.terminalReport
    if (lifecycle.completedReportCount === 1 && (!terminal || terminal.kind !== "body-outcome" ||
      terminal.schema_version !== 2 || terminal.operationId !== id ||
      terminal.producerDeadline !== record.producerDeadline || terminal.publicationDeadline !== record.publicationDeadline ||
      digest(terminal) !== record.terminalReportDigest || !["body_settled", "blocked"].includes(terminal.outcome?.state))) {
      throw fault("producer_record_invalid")
    }
    if (lifecycle.observedStartCount === 1 && lifecycle.completedReportCount !== 1 &&
      !(Array.isArray(record.bodyHistory) && record.bodyHistory.length > 0)) {
      const observed = record.bodyStartObservation
      if (!observed || observed.operationId !== id || observed.producerDeadline !== record.producerDeadline ||
        observed.publicationDeadline !== record.publicationDeadline || !Number.isFinite(observed.observedAtMs) ||
        observed.observedAtMs < record.createdAtMs || observed.observedAtMs >= record.producerDeadline) {
        throw fault("producer_record_invalid")
      }
    }
  }
  const actor = (value) => value?.state === "present" && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.start === "string" && ((/^darwin:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.start) &&
      Number.isFinite(Date.parse(value.start.slice(7))) && new Date(value.start.slice(7)).toISOString() === value.start.slice(7)) ||
      /^linux:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}:\d+$/u.test(value.start))
  if (!actor(record.caller)) throw fault("producer_record_invalid")
  if (record.revision === 0 && (record.state !== "reserved" || record.requestSent || record.dispatch || record.owner)) throw fault("producer_record_invalid")
  if (record.dispatch && (!Number.isSafeInteger(record.dispatch.pid) || record.dispatch.pid <= 0)) throw fault("producer_record_invalid")
  if (record.requestSent && (!record.dispatch || record.revision < 2)) throw fault("producer_record_invalid")
  if (record.state === "accepted" && (!actor(record.owner) || !record.requestSent ||
    record.owner.pid !== record.dispatch?.pid || record.revision < 3)) throw fault("producer_record_invalid")
  if (record.state === "capability_verified") {
    const relation = record.relationship, outcome = record.outcome, resources = record.resources
    if (!actor(record.owner) || record.revision < 3 || !record.requestSent || record.owner.pid !== record.dispatch?.pid ||
      record.executionCount !== 1 || record.capabilityGranted !== true || !relation || relation.peerCredentials !== false ||
      !actor(relation.executor) || !actor(relation.native) || !actor(relation.owner) ||
      !Number.isSafeInteger(record.owner.group) || record.owner.group <= 0 ||
      !Number.isSafeInteger(relation.native.parentPid) || !Number.isSafeInteger(relation.executor.parentPid) ||
      relation.owner.pid !== record.owner.pid || relation.owner.start !== record.owner.start ||
      relation.owner.group !== record.owner.group ||
      relation.native.pid !== resources.childPid || relation.native.start !== resources.start ||
      relation.native.group !== resources.group || relation.native.parentPid !== record.owner.pid ||
      relation.executor.parentPid !== relation.native.pid || relation.executor.group !== relation.native.group ||
      resources.childrenClosed !== true || resources.exitObserved !== true || resources.resultReceived !== true ||
      resources.phase !== "closed" || resources.scope !== "native-owner" ||
      !Number.isSafeInteger(resources.group) || resources.group <= 0 || resources.group !== resources.childPid ||
      !Number.isSafeInteger(relation.native.group) || !Number.isSafeInteger(relation.executor.group) ||
      resources.inventory?.known !== true || !Array.isArray(resources.inventory.members) || resources.inventory.members.length !== 0 ||
      typeof resources.token !== "string" || !UUID.test(resources.token) ||
      outcome?.status !== 0 || outcome.error !== null || (outcome.spawnError !== null && outcome.spawnError !== undefined) ||
      outcome.cancelled !== false ||
      outcome.timedOut !== false || outcome.outputTruncated !== false ||
      outcome.requestSent !== true || outcome.stdout !== "producer capability ready\n" ||
      !["owned", "removed", "unknown"].includes(record.broker?.custody)) {
      throw fault("producer_record_invalid")
    }
  }
  if (record.state === "effect_attributed") {
    const proof = record.attribution, resources = record.resources, relation = record.relationship, outcome = record.outcome
    if (record.kind !== "desk-save" || record.capabilityGranted !== true || record.executionCount !== 1 || record.requestSent !== true ||
      !actor(record.owner) || record.owner.pid !== record.dispatch?.pid || !actor(relation?.native) ||
      !actor(relation?.executor) || !actor(relation?.owner) || relation.peerCredentials !== false ||
      relation.owner.pid !== record.owner.pid || relation.owner.start !== record.owner.start ||
      relation.owner.group !== record.owner.group || relation.native.parentPid !== record.owner.pid ||
      relation.native.pid !== resources.childPid || relation.native.start !== resources.start ||
      relation.native.group !== resources.group || relation.executor.parentPid !== resources.childPid ||
      relation.executor.group !== resources.group || !Number.isSafeInteger(resources.group) || resources.group <= 0 ||
      resources.childrenClosed !== true || resources.exitObserved !== true || resources.scope !== "native-owner" ||
      resources.phase !== "closed" || !UUID.test(resources.token ?? "") || resources.inventory?.known !== true ||
      !Array.isArray(resources.inventory.members) || resources.inventory.members.length !== 0 ||
      outcome?.requestSent !== true || outcome.cancelled !== false || outcome.timedOut !== false ||
      outcome.outputTruncated !== false || outcome.spawnError !== null ||
      (outcome.error !== null && outcome.error !== "native_outcome_unknown") ||
      record.bodyOutcome?.state !== "body_settled" || record.bodyOutcome.command?.status !== 0 ||
      record.bodyOutcome.command.error !== null ||
      (proof?.operation === "succeeded" ? outcome.status !== 0 || outcome.error !== null :
        proof?.operation !== "recovered_response_loss" || outcome.status !== null || outcome.error !== "native_outcome_unknown") ||
      proof?.attribution !== "owner_readback" || proof.publication !== "not_started" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(proof.targetCommit ?? "") ||
      !Array.isArray(proof.expected) || !Array.isArray(proof.exactPaths) ||
      proof.witness !== `desk-publication:${record.id}` || record.publication !== "not_started") throw fault("producer_record_invalid")
  }
  if (record.state === "body_settled") {
    const body = record.bodyOutcome, native = record.outcome, resources = record.resources, relation = record.relationship
    const noOp = body?.reason === "nothing_to_commit" && !body.command &&
      !record.bodyHistory?.some((phase) => phase.phase === "commit")
    if (record.kind !== "desk-save" || body?.state !== "body_settled" ||
      (!noOp && (body.command?.status !== 0 || body.command.error !== null)) ||
      record.capabilityGranted !== true || record.executionCount !== 1 || record.requestSent !== true ||
      !actor(record.owner) || record.owner.pid !== record.dispatch?.pid || !actor(relation?.native) ||
      !actor(relation?.executor) || !actor(relation?.owner) || relation.peerCredentials !== false ||
      relation.owner.pid !== record.owner.pid || relation.owner.start !== record.owner.start ||
      relation.owner.group !== record.owner.group || relation.native.parentPid !== record.owner.pid ||
      relation.native.pid !== resources.childPid || relation.native.start !== resources.start ||
      relation.native.group !== resources.group || relation.executor.parentPid !== resources.childPid ||
      relation.executor.group !== resources.group || !Number.isSafeInteger(resources.group) ||
      resources.group <= 0 || resources.group !== resources.childPid ||
      resources.childrenClosed !== true || resources.exitObserved !== true || resources.resultReceived !== true ||
      resources.phase !== "closed" || resources.scope !== "native-owner" ||
      !UUID.test(resources.token ?? "") || resources.inventory?.known !== true ||
      !Array.isArray(resources.inventory.members) || resources.inventory.members.length !== 0 ||
      native?.status !== 0 || native.error !== null || native.spawnError !== null ||
      native.cancelled !== false || native.timedOut !== false || native.outputTruncated !== false ||
      native.requestSent !== true || record.publication !== "not_started") throw fault("producer_record_invalid")
  }
}
export function createProducerReadOnlyIntent({ context }) {
  const createdAtMs = Date.now()
  const authority = captureProducerAdmission(context)
  const intent = Object.freeze(Object.create(null))
  intents.set(intent, { context, authority, id: randomUUID(), createdAtMs,
    producerDeadline: createdAtMs + 10000, publicationDeadline: createdAtMs + 60000 })
  return intent
}
export async function requestDeskSaveProducer({ context, input, createdAtMs = Date.now(), root, person, stateBranch }) {
  const producerDeadline = createdAtMs + 10000, id = randomUUID()
  if (Date.now() >= producerDeadline) throw fault("producer_deadline")
  const operationEnvironment = await prepareFirstOperationEnvironment({ context, operationId: id, createdAtMs,
    producerDeadline, publicationDeadline: createdAtMs + 60000 })
  let currentness
  try {
    currentness = beginFirstSaveCurrentness({ context, operationEnvironment, operationId: id, producerDeadline })
    const authority = currentness.authority
    assertFirstSaveCurrentness({ monitor: currentness.monitor, operationId: id, producerDeadline,
      root: root === undefined ? undefined : realpathSync(root), person })
    if (stateBranch !== undefined && stateBranch !== null &&
      authority.binding.branch !== `refs/heads/${stateBranch}`) throw fault("publication_binding_changed")
    const { prepareDeskSaveInput } = await import("../tools/desk-save.js")
    const prepared = await prepareDeskSaveInput({ deskRoot: authority.root, person: authority.person, input, deadline: producerDeadline })
    assertFirstSaveCurrentness({ monitor: currentness.monitor, operationId: id, producerDeadline })
    const intent = Object.freeze(Object.create(null))
    intents.set(intent, { context, authority, currentness, id, createdAtMs, producerDeadline,
      publicationDeadline: createdAtMs + 60000,
      savePayload: { paths: prepared.paths, files: prepared.files, message: prepared.message, tidy: prepared.tidy } })
    return await requestProducerReadOnly({ context, intent })
  } catch (error) {
    if (currentness && !currentness.retired) { closeFirstSaveCurrentness(currentness.monitor); currentness.retired = true }
    if (operationEnvironment) closeFirstOperationEnvironment(operationEnvironment)
    throw error
  }
}
function storeSavePayload(authority, request) {
  if (Date.now() >= request.producerDeadline) throw fault("producer_deadline")
  const directory = path.join(folder(authority), `${request.id}.payload`)
  const files = []
  let directoryIdentity = null
  try {
  mkdirSync(directory, { mode: 0o700 })
  const identity = lstatSync(directory, { bigint: true })
  directoryIdentity = { dev: String(identity.dev), ino: String(identity.ino) }
  for (const [ordinal, file] of request.savePayload.files.entries()) {
    if (Date.now() >= request.producerDeadline) throw fault("producer_deadline")
    const privatePath = path.join(directory, `${ordinal}.content`)
    const fd = openSync(privatePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
    let primary, closed = false
    try { writeFileSync(fd, file.content, "utf8") } catch (error) { primary = error }
    try { closeSync(fd); closed = true } catch (error) { primary ??= error }
    if (primary) throw Object.assign(primary, { producerPayload: { directory, privatePath, descriptor: fd, closed } })
    const stat = lstatSync(privatePath, { bigint: true })
    files.push({ path: file.path, ordinal, privatePath, bytes: Buffer.byteLength(file.content),
      sha256: createHash("sha256").update(file.content).digest("hex"), identity: { dev: String(stat.dev), ino: String(stat.ino) } })
  }
  return { directory, identity: { dev: String(identity.dev), ino: String(identity.ino) },
    paths: request.savePayload.paths, message: request.savePayload.message, tidy: request.savePayload.tidy, files }
  } catch (error) {
    error.mutation = { status: "unknown", readback_required: true, targetMutationDispatched: false,
      private_payload: { directory, identity: directoryIdentity, files, uncertain: error.producerPayload ?? null } }
    throw error
  }
}
function loadSavePayload(manifest, deadline) {
  const directory = lstatSync(manifest.directory, { bigint: true })
  if (!directory.isDirectory() || String(directory.dev) !== manifest.identity.dev ||
    String(directory.ino) !== manifest.identity.ino) throw fault("producer_payload_unqualified")
  const files = manifest.files.map((file) => {
    if (Date.now() >= deadline || file.bytes > 1024 * 1024) throw fault("producer_payload_unqualified")
    if (file.privatePath !== path.join(manifest.directory, `${file.ordinal}.content`)) throw fault("producer_payload_unqualified")
    const stat = lstatSync(file.privatePath, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || String(stat.dev) !== file.identity.dev ||
      String(stat.ino) !== file.identity.ino || Number(stat.size) !== file.bytes) throw fault("producer_payload_unqualified")
    const content = readSmallText(file.privatePath, 1024 * 1024)
    if (createHash("sha256").update(content).digest("hex") !== file.sha256) throw fault("producer_payload_unqualified")
    return { path: file.path, content }
  })
  return { paths: manifest.paths, message: manifest.message, tidy: manifest.tidy, files }
}
export async function requestProducerReadOnly({ context, intent }) {
  const request = intents.get(intent)
  if (!request || request.context !== context) throw fault("producer_intent_invalid")
  const retireCurrentness = () => {
    if (request.currentness && !request.currentness.retired) {
      closeFirstSaveCurrentness(request.currentness.monitor)
      request.currentness.retired = true
    }
  }
  let authority
  if (request.currentness) {
    assertFirstSaveCurrentness({ monitor: request.currentness.monitor, operationId: request.id, producerDeadline: request.producerDeadline })
    authority = request.currentness.authority
  } else authority = captureProducerAdmission(context, request.savePayload ? { deadline: request.producerDeadline } : undefined)
  if (request.savePayload && Date.now() >= request.producerDeadline) throw fault("producer_deadline")
  if (digest(authority) !== digest(request.authority)) throw fault("producer_binding_changed")
  const directory = folder(authority), file = path.join(directory, `${request.id}.json`)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  try {
    const existing = read(file)
    validateRecord(existing, authority, request.id)
    return projection(existing)
  } catch (error) { if (error.code !== "ENOENT") throw error }
  if (Date.now() >= request.producerDeadline) throw fault("producer_deadline")
  const nonce = randomBytes(32).toString("hex"), caller = generation(process.pid)
  const payloadManifest = request.savePayload ? storeSavePayload(authority, request) : null
  if (request.currentness) assertFirstSaveCurrentness({
    monitor: request.currentness.monitor, operationId: request.id, producerDeadline: request.producerDeadline })
  let record = { version: 1, id: request.id, revision: 0, root: authority.root, rootIdentity: authority.rootIdentity,
    person: authority.person, bindingKey: authority.binding.key, createdAtMs: request.createdAtMs,
    producerDeadline: request.producerDeadline, publicationDeadline: request.publicationDeadline,
    state: "reserved", requestSent: false, executionCount: 0, resources: { childrenClosed: true }, caller,
    kind: request.savePayload ? "desk-save" : "read-only", payloadDigest: request.savePayload ? savePayloadDigest(request.savePayload, request.producerDeadline) : null,
    payloadManifest, ...(request.currentness ? { producerCurrentness: { version: 1, operationId: request.id,
      originalDeadline: request.producerDeadline, footprintDigest: digest(request.currentness.footprint),
      ...(request.currentness.selection ? { selectorDigest: digest(request.currentness.selection) } : {}) },
      bodyLifecycle: { version: 2, grantIssueCount: 0, observedStartCount: 0, completedReportCount: 0 } } : {}) }
  const journal = createJournal(file)
  if (!journal.write(record, true)) {
    retireCurrentness()
    return { ...record, state: "blocked", reason: journal.failed().code, persistence_error: journal.failed() }
  }
  let child
  try {
    child = spawn(process.execPath, [SCRIPT, "--producer-gate1", request.id, "--root", authority.root], {
      env: { ...authority.env, DESK_PRODUCER_PARENT_NONCE: nonce, DESK_PRODUCER_PARENT_PID: String(caller.pid) },
      detached: true, stdio: ["ignore", "ignore", "inherit", "ipc"],
    })
    child.once("error", (error) => {
      process.stderr.write(`producer gate1 launch failed: ${error.code ?? "producer_spawn_failed"}\n`)
      if (child.connected) child.disconnect()
      retireCurrentness()
    })
    record = { ...record, revision: 1, dispatch: { pid: child.pid }, requestSent: false }
    if (!journal.write(record)) throw fault(journal.failed().code)
    let sent = false
    const channelTimer = setTimeout(() => { if (child.connected) child.disconnect(); retireCurrentness() },
      Math.max(1, request.producerDeadline - Date.now()))
    channelTimer.unref()
    child.on("message", (message) => {
      if (message.kind === "producer-ready" && !sent && child.connected) {
        try {
          if (Date.now() >= request.producerDeadline || message.pid !== child.pid) throw fault("producer_private_grant_refused")
          if (request.currentness) assertFirstSaveCurrentness({
            monitor: request.currentness.monitor, operationId: request.id, producerDeadline: request.producerDeadline })
          sent = true
          // Set before attempted send; acknowledgement/send errors never undo this evidence.
          record = { ...record, revision: 2, requestSent: true }
          if (!journal.write(record)) throw fault(journal.failed().code)
          child.send({ kind: "producer-grant", nonce, id: request.id, revision: 2, authority,
            ...(request.currentness ? { producerCurrentness: record.producerCurrentness,
              footprint: request.currentness.footprint,
              ...(request.currentness.selection ? { operationSelection: request.currentness.selection } : {}) } : {}),
            kindOfWork: record.kind, payloadManifest, payloadDigest: record.payloadDigest,
            producerDeadline: request.producerDeadline, publicationDeadline: request.publicationDeadline }, (error) => {
            if (error && child.connected) child.disconnect()
          })
        } catch (error) {
          process.stderr.write(`producer gate1 grant refused: ${error.code ?? "producer_dispatch_failed"}\n`)
          if (child.connected) child.disconnect()
          journal.emit()
        }
      } else if (message.kind === "producer-accepted") {
        clearTimeout(channelTimer)
        if (child.connected) child.disconnect()
        retireCurrentness()
      }
    })
    child.once("error", (error) => {
      clearTimeout(channelTimer)
      process.stderr.write(`producer gate1 launch failed: ${error.code ?? "producer_spawn_failed"}\n`)
      if (child.connected) child.disconnect()
    })
    child.once("exit", () => { clearTimeout(channelTimer); retireCurrentness() })
    child.unref()
    return projection(record)
  } catch (error) {
    if (child?.connected) child.disconnect()
    child?.unref()
    record = { ...record, revision: record.revision + 1, state: child?.pid ? "unknown" : "blocked",
      reason: error.code ?? "producer_dispatch_failed" }
    journal.write(record)
    journal.emit()
    retireCurrentness()
    return { ...projection(record), ...(journal.failed() ? { persistence_error: journal.failed() } : {}) }
  }
}
export function readProducer({ context, id }) {
  if (!UUID.test(id ?? "")) throw fault("producer_record_invalid")
  const authority = captureProducerAdmission(context)
  const record = read(path.join(folder(authority), `${id}.json`))
  validateRecord(record, authority, id)
  if (!["capability_verified", "body_settled", "effect_attributed", "blocked", "unknown"].includes(record.state) && Date.now() >= record.producerDeadline) {
    return { ...record, state: "unknown", recordedState: record.state, reason: "producer_settlement_unconfirmed" }
  }
  return projection(record)
}
export async function flushProducer({ context, id, timeoutMs = 0 }) {
  const until = Date.now() + timeoutMs
  for (;;) {
    const record = readProducer({ context, id })
    if ((["capability_verified", "body_settled", "effect_attributed", "blocked", "unknown"].includes(record.state) &&
      record.reason !== "producer_settlement_unconfirmed") || Date.now() >= until) return record
    await pause(25)
  }
}
export function qualifyProducerExecutor({ claim, nonce, used, native, executor, owner, grant, expectedGrant }) {
  if (used || !equalNonce(claim.nonce, nonce)) throw fault("producer_nonce_refused")
  if (digest(grant) !== digest(expectedGrant)) throw fault("producer_grant_changed")
  if (owner.state !== "present" || owner.pid !== expectedGrant.owner.pid || owner.start !== expectedGrant.owner.start) throw fault("producer_owner_unknown")
  if (native.state !== "present" || native.pid !== expectedGrant.native.childPid || native.start !== expectedGrant.native.start ||
    native.group !== expectedGrant.native.group || native.parentPid !== owner.pid) throw fault("producer_native_group_refused")
  if (executor.state !== "present" || executor.pid !== claim.pid || executor.start !== claim.start ||
    executor.group !== native.group || executor.parentPid !== native.pid ||
    claim.container.pid !== native.pid || claim.container.start !== native.start ||
    claim.container.token !== expectedGrant.native.token) throw fault("producer_executor_relationship_refused")
  return { executor, native, owner, peerCredentials: false }
}
function attributeAcceptedBody({ record, authority, result, assertCurrent }) {
  const responseLoss = result.status === null && result.error === "native_outcome_unknown"
  if (result.resources.childrenClosed !== true || result.cancelled || result.timedOut || result.outputTruncated ||
    result.requestSent !== true || result.spawnError || (!responseLoss && (result.status !== 0 || result.error))) {
    throw fault("producer_body_settlement_unknown")
  }
  if (record.bodyOutcome?.state !== "body_settled" || record.bodyOutcome.command?.status !== 0 ||
    record.bodyOutcome.command.error) throw fault("producer_commit_failed")
  const commit = record.bodyHistory?.find((step) => step.phase === "commit")
  const proof = commit?.detail?.proof
  if (!proof || !Array.isArray(proof.expected) || !Array.isArray(proof.exactPaths) || !proof.witness ||
    proof.witness !== `desk-publication:${record.id}` || proof.branch !== authority.binding.branch) throw fault("producer_body_attribution_unqualified")
  const prefix = path.resolve(personPrefix(authority.root, authority.person))
  for (const file of proof.exactPaths) {
    if (typeof file !== "string" || path.isAbsolute(file) || file.includes("\0") || file.split("/").includes("..") ||
      !isPathContained(prefix, path.resolve(authority.root, file))) throw fault("producer_body_attribution_unqualified")
  }
  const readGit = (args) => {
    if (assertCurrent) assertCurrent()
    const remaining = record.producerDeadline - Date.now()
    if (remaining <= 0) throw fault("producer_deadline")
    const response = spawnSync("git", ["-C", authority.root, ...args], { env: authority.env, encoding: "utf8",
      maxBuffer: 1024 * 1024, timeout: Math.min(5000, remaining) })
    if (response.status !== 0 || response.error) throw fault(response.error?.code ?? "producer_body_readback_failed")
    if (assertCurrent) assertCurrent()
    return response.stdout
  }
  if (assertCurrent) assertCurrent()
  else validateAuthority(authority, record.producerDeadline)
  const log = readGit(["rev-parse", "--path-format=absolute", "--git-path", `logs/${proof.branch}`]).trim()
  const witnesses = readSmallText(log, 1024 * 1024).split("\n").filter((line) => line.split("\t")[1]?.startsWith(`${proof.witness}: `))
  if (witnesses.length !== 1) throw fault("producer_body_witness_ambiguous")
  const [old, target] = witnesses[0].split(" "), oid = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u
  if (!oid.test(target) || old !== (proof.parent ?? "0".repeat(target.length)) ||
    readGit(["rev-list", "--parents", "-n", "1", target]).trim() !== (proof.parent ? `${target} ${proof.parent}` : target)) {
    throw fault("producer_body_parent_mismatch")
  }
  const changed = readGit(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z",
    ...(proof.parent ? [proof.parent, target] : ["--root", target])]).split("\0").filter(Boolean)
  if (!changed.length || changed.some((file) => !proof.exactPaths.includes(file))) throw fault("producer_body_write_set_mismatch")
  const actual = readGit(["ls-tree", "-z", target, "--", ...proof.exactPaths]).split("\0").filter(Boolean).map((line) => {
    const split = line.indexOf("\t"), [mode, , sha] = line.slice(0, split).split(" ")
    return { mode, sha, stage: "0", path: line.slice(split + 1) }
  })
  const order = (entries) => JSON.stringify([...entries].sort((a, b) => a.path.localeCompare(b.path))
    .map(({ mode, sha, stage, path }) => ({ mode, sha, stage, path })))
  if (order(actual) !== order(proof.expected)) throw fault("producer_body_write_set_mismatch")
  if (assertCurrent) assertCurrent()
  else validateAuthority(authority, record.producerDeadline)
  if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
  return { targetCommit: target, parent: proof.parent, expected: proof.expected, exactPaths: proof.exactPaths,
    witness: proof.witness, attribution: "owner_readback", operation: responseLoss ? "recovered_response_loss" : "succeeded",
    publication: "not_started" }
}
export async function runProducerGate1Worker({ id, root }) {
  if (!process.connected || !UUID.test(id ?? "") || !process.env.DESK_PRODUCER_PARENT_NONCE) throw fault("producer_private_channel_required")
  const nonce = process.env.DESK_PRODUCER_PARENT_NONCE
  delete process.env.DESK_PRODUCER_PARENT_NONCE
  const callerPid = Number(process.env.DESK_PRODUCER_PARENT_PID)
  delete process.env.DESK_PRODUCER_PARENT_PID
  const initialParent = process.ppid
  const until = Date.now() + 10000
  let grant
  const onMessage = (message) => { if (!grant) grant = message }
  process.on("message", onMessage)
  process.send({ kind: "producer-ready", pid: process.pid }, () => {})
  while (!grant && process.connected && Date.now() < until) await pause(10)
  process.off("message", onMessage)
  if (!grant || grant.kind !== "producer-grant" || grant.id !== id || !equalNonce(grant.nonce, nonce) ||
    initialParent !== callerPid || root !== grant.authority.root) throw fault("producer_private_grant_refused")
  const monitored = grant.kindOfWork === "desk-save" && grant.producerCurrentness !== undefined
  if (!monitored) validateAuthority(grant.authority, grant.kindOfWork === "desk-save" ? grant.producerDeadline : undefined)
  const file = path.join(folder(grant.authority), `${id}.json`)
  let record = read(file)
  validateRecord(record, grant.authority, id)
  if (record.state !== "reserved" || record.revision !== grant.revision || !record.requestSent ||
    record.dispatch?.pid !== process.pid || record.caller.pid !== callerPid || record.producerDeadline !== grant.producerDeadline ||
    record.publicationDeadline !== grant.publicationDeadline) throw fault("producer_grant_changed")
  const saveWork = grant.kindOfWork === "desk-save"
  const payload = saveWork ? loadSavePayload(grant.payloadManifest, grant.producerDeadline) : null
  if (saveWork && (record.kind !== "desk-save" || digest(grant.payloadManifest) !== digest(record.payloadManifest) ||
    savePayloadDigest(payload, grant.producerDeadline) !== record.payloadDigest || grant.payloadDigest !== record.payloadDigest)) throw fault("producer_payload_unqualified")
  const self = generation(process.pid)
  if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
  let currentness = null, currentnessContext = null, operationEnvironment = null
  const retireCurrentness = () => {
    if (currentness) { closeFirstSaveCurrentness(currentness.monitor); currentness = null }
    if (operationEnvironment) { closeFirstOperationEnvironment(operationEnvironment); operationEnvironment = null }
    if (currentnessContext) { closePublicationContext(currentnessContext); currentnessContext = null }
  }
  if (monitored) {
    if (record.producerCurrentness?.version !== 1 || record.producerCurrentness.operationId !== id ||
      record.producerCurrentness.originalDeadline !== record.producerDeadline ||
      digest(grant.producerCurrentness) !== digest(record.producerCurrentness) ||
      digest(grant.footprint) !== record.producerCurrentness.footprintDigest) throw fault("producer_currentness_changed")
    currentnessContext = createPublicationContext({ root, env: grant.authority.env, person: grant.authority.person,
      sessionId: `producer-currentness:${id}`, requireCommitReceipt: true })
    try {
      if (record.producerCurrentness.selectorDigest !== undefined || grant.operationSelection !== undefined) {
        if (!grant.operationSelection || typeof record.producerCurrentness.selectorDigest !== "string" ||
          digest(grant.operationSelection) !== record.producerCurrentness.selectorDigest) throw fault("producer_currentness_changed")
        operationEnvironment = registerTransferredFirstOperationEnvironment({ context: currentnessContext,
          selection: grant.operationSelection, expectedDigest: record.producerCurrentness.selectorDigest,
          operationId: id, createdAtMs: record.createdAtMs, producerDeadline: record.producerDeadline,
          publicationDeadline: record.publicationDeadline })
      }
      currentness = beginFirstSaveCurrentness({ context: currentnessContext, operationId: id,
        operationEnvironment, producerDeadline: record.producerDeadline,
        expectedAuthority: grant.authority, expectedFootprint: grant.footprint })
    } catch (error) {
      retireCurrentness()
      throw error
    }
  }
  const assertOwnerCurrentness = () => {
    if (currentness) {
      assertFirstSaveCurrentness({ monitor: currentness.monitor, operationId: id,
        producerDeadline: record.producerDeadline, root, person: grant.authority.person, baseEnv: grant.authority.env })
      const current = generation(self.pid)
      if (current.start !== self.start || current.group !== self.group) throw fault("producer_owner_unknown")
      if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
    } else validateAuthority(grant.authority, saveWork ? record.producerDeadline : undefined)
  }
  const journal = createJournal(file, record)
  const observeJournal = (expectedNative = null) => {
    if (journal.failed()) throw fault(journal.failed().code)
    try {
      const current = read(file)
      validateRecord(current, grant.authority, id)
      if (current.id !== id || current.owner?.start !== self.start || current.revision !== record.revision ||
        !journal.matches(current)) throw fault("producer_grant_changed")
      if (expectedNative && (current.state !== "accepted" || digest(current.resources) !== digest(expectedNative))) {
        throw fault("producer_grant_changed")
      }
      return current
    } catch (error) {
      journal.latch(error)
      throw error
    }
  }
  record = { ...record, revision: record.revision + 1, state: "accepted", owner: self }
  if (!journal.write(record)) {
    journal.emit()
    if (process.connected) process.disconnect()
    retireCurrentness()
    return
  }
  if (process.connected) process.send({ kind: "producer-accepted", id }, () => {})
  // Caller disconnect after live-grant acceptance does not cancel owned work.
  if (process.connected) process.disconnect()
  let socketDirectory, directoryIdentity, socket
  const executorNonce = randomBytes(32).toString("hex")
  let used = false, nativeResources, relationship, socketIdentity, bodyOutcome
  let boundPeer = null, phaseSequence = 0, activePhase = null
  const assertLiveRelationship = () => {
    if (!relationship || Date.now() >= record.producerDeadline) throw fault("producer_executor_relationship_refused")
    const owner = generation(self.pid), native = generation(relationship.native.pid), executor = generation(relationship.executor.pid)
    if (owner.start !== self.start || owner.group !== self.group ||
      native.start !== relationship.native.start || native.group !== relationship.native.group ||
      native.parentPid !== owner.pid || executor.start !== relationship.executor.start ||
      executor.group !== native.group || executor.parentPid !== native.pid) throw fault("producer_executor_relationship_refused")
    if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
    if (currentness) assertOwnerCurrentness()
  }
  const recordResource = (resources) => {
    nativeResources = resources
    if (journal.failed()) { journal.write({ ...record, resources }); return }
    try {
      observeJournal()
      record = { ...record, revision: record.revision + 1, resources }
      journal.write(record)
    } catch (error) {
      record = { ...record, state: "unknown", reason: error.code ?? "producer_persistence_failed", resources }
      journal.latch(error)
      journal.write(record)
    }
  }
  const peers = new Set()
  let broker
  const connectPeer = (peer) => {
    peers.add(peer); peer.once("close", () => peers.delete(peer))
    peer.on("error", (error) => {
      record.channelFailures ??= []
      record.channelFailures.push({ code: error.code ?? "producer_peer_error" })
      peer.destroy()
    })
    peer.setEncoding("utf8"); let content = ""
    const handleFrame = (line) => {
      try {
        if (journal.failed() || Date.now() >= record.producerDeadline || !nativeResources?.start) throw fault("producer_relationship_unavailable")
        const claim = JSON.parse(line)
        if (saveWork && used && peer === boundPeer) {
          assertOwnerCurrentness()
          observeJournal(nativeResources)
          assertLiveRelationship()
          if (claim.kind === "body-started") {
            if (record.bodyLifecycle?.version !== 2 || claim.schema_version !== 2 || claim.operationId !== id ||
              claim.producerDeadline !== record.producerDeadline || claim.publicationDeadline !== record.publicationDeadline ||
              record.bodyLifecycle.observedStartCount === 1 ||
              Object.keys(claim).some(key => !["kind", "schema_version", "operationId", "producerDeadline", "publicationDeadline"].includes(key))) {
              throw fault("producer_body_start_invalid")
            }
            record = { ...record, revision: record.revision + 1, executionCount: 1,
              bodyStartObservation: { operationId: id, producerDeadline: record.producerDeadline,
                publicationDeadline: record.publicationDeadline, observedAtMs: Date.now() },
              bodyLifecycle: { ...record.bodyLifecycle, observedStartCount: 1 } }
            if (!journal.write(record)) throw fault(journal.failed().code)
            observeJournal(nativeResources)
            assertLiveRelationship()
            if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
            peer.write(`${JSON.stringify({ kind: "body-started-recorded" })}\n`)
            return
          }
          if (claim.kind === "phase-intent") {
            if (activePhase || claim.id !== id || claim.sequence !== phaseSequence + 1 ||
              claim.producerDeadline !== record.producerDeadline || typeof claim.phase !== "string" ||
              !claim.detail || typeof claim.detail !== "object") throw fault("producer_phase_refused")
            const allowed = ["mkdir", "open", "write", "close", "stage", "commit", "private-index-directory", "private-read-tree", "private-update-index"]
            if (!allowed.includes(claim.phase)) throw fault("producer_phase_refused")
            if (claim.detail.path && !payload.files.some((file) => file.path === claim.detail.path)) throw fault("producer_phase_refused")
            if (record.bodyHistory?.some((step) => step.phase === claim.phase && step.detail.path === claim.detail.path)) {
              throw fault("producer_phase_replay_refused")
            }
            if (["mkdir", "open", "write", "close"].includes(claim.phase) && !claim.detail.path) throw fault("producer_phase_refused")
            if (["write", "close"].includes(claim.phase)) {
              const held = record.bodyFiles?.find((entry) => entry.path === claim.detail.path && entry.closed !== true)
              if (!held || held.descriptor !== claim.detail.descriptor) throw fault("producer_descriptor_refused")
            }
            const selections = [...payload.paths, ...payload.files.map((entry) => entry.path)].map((entry) => path.posix.normalize(entry))
            const ownsPath = (file) => typeof file === "string" && !path.isAbsolute(file) && !file.includes("\0") &&
              !file.split("/").includes("..") && !/[*?[\\]|^:/u.test(file) &&
              isPathContained(path.resolve(personPrefix(root, grant.authority.person)), path.resolve(root, file)) &&
              selections.some((entry) => entry === "." || file === entry || file.startsWith(`${entry.replace(/\/$/u, "")}/`))
            if (claim.phase === "write") {
              const file = payload.files.find((entry) => entry.path === claim.detail.path)
              if (claim.detail.bytes !== Buffer.byteLength(file.content) ||
                claim.detail.sha256 !== createHash("sha256").update(file.content).digest("hex")) throw fault("producer_phase_refused")
            }
            if (claim.phase === "stage" && (claim.detail.args?.[0] !== "add" || !Array.isArray(claim.detail.args) ||
              claim.detail.args[1] !== "-A" || claim.detail.args[2] !== "--" ||
              !claim.detail.args.slice(3).length || !claim.detail.args.slice(3).every(ownsPath))) throw fault("producer_phase_refused")
            if (claim.phase.startsWith("private-") && !payload.tidy) throw fault("producer_phase_refused")
            if (claim.phase === "commit") {
              const proof = claim.detail.proof
              if (claim.detail.args?.[0] !== "commit" || claim.detail.args[2] !== payload.message ||
                proof?.branch !== grant.authority.binding.branch || !Array.isArray(proof.exactPaths)) throw fault("producer_phase_refused")
              for (const file of proof.exactPaths) {
                if (!ownsPath(file)) throw fault("producer_phase_refused")
              }
              if (!Array.isArray(proof.expected) || proof.expected.some((entry) => entry.stage !== "0" ||
                !proof.exactPaths.includes(entry.path) || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(entry.sha))) throw fault("producer_phase_refused")
              if (payload.tidy ? claim.detail.args.length !== 3 : JSON.stringify(claim.detail.args.slice(3)) !== JSON.stringify(["--", ...proof.exactPaths])) {
                throw fault("producer_phase_refused")
              }
            }
            phaseSequence = claim.sequence
            activePhase = { ...claim, state: "unknown" }
            record = { ...record, revision: record.revision + 1, bodyPhase: activePhase,
              bodyHistory: [...(record.bodyHistory ?? []), activePhase],
              ...(record.bodyLifecycle?.version === 2 ? { executionCount: 1,
                bodyLifecycle: { ...record.bodyLifecycle, observedStartCount: 1 } } : {}) }
            if (!journal.write(record)) throw fault(journal.failed().code)
            observeJournal(nativeResources)
            assertLiveRelationship()
            peer.write(`${JSON.stringify({ kind: "phase-approved", sequence: phaseSequence })}\n`)
            return
          }
          if (claim.kind === "phase-result") {
            if (!activePhase || claim.sequence !== phaseSequence || claim.phase !== activePhase.phase ||
              claim.status !== "completed" || Object.keys(claim).some(key =>
                !["kind", "sequence", "phase", "status", "file_resource"].includes(key)) ||
              (claim.phase !== "open" && claim.file_resource !== undefined)) throw fault("producer_phase_result_invalid")
            let bodyFiles = record.bodyFiles
            if (activePhase.phase === "open") {
              if (!Number.isSafeInteger(claim.file_resource?.descriptor) || claim.file_resource.descriptor < 0 ||
                claim.file_resource.path !== activePhase.detail.path ||
                Object.keys(claim.file_resource).some(key => !["path", "descriptor"].includes(key))) throw fault("producer_descriptor_refused")
              bodyFiles = [...(bodyFiles ?? []), { path: claim.file_resource.path, descriptor: claim.file_resource.descriptor,
                closed: false, custody: "executor-report" }]
            } else if (activePhase.phase === "close") {
              bodyFiles = bodyFiles.map((entry) => entry.path === activePhase.detail.path ? { ...entry, closed: true } : entry)
            }
            const completed = { ...activePhase, state: "completed" }
            record = { ...record, revision: record.revision + 1, bodyPhase: completed, bodyFiles,
              bodyHistory: [...record.bodyHistory.slice(0, -1), completed] }
            if (!journal.write(record)) throw fault(journal.failed().code)
            activePhase = null
            observeJournal(nativeResources)
            assertLiveRelationship()
            peer.write(`${JSON.stringify({ kind: "phase-recorded", sequence: phaseSequence })}\n`)
            return
          }
          if (claim.kind === "private-resource") {
            record = { ...record, revision: record.revision + 1, private_resource: claim.private_resource }
            if (!journal.write(record)) throw fault(journal.failed().code)
            peer.write(`${JSON.stringify({ kind: "resource-recorded" })}\n`)
            return
          }
          if (claim.kind === "body-outcome") {
            if (record.bodyLifecycle?.version === 2 && claim.schema_version !== 2) throw fault("producer_terminal_report_invalid")
            if (claim.schema_version === 2) {
              const validated = validateFirstBodyTerminalReport({ candidate: claim, record, phaseSequence })
              bodyOutcome = bodyObservation(validated)
              const next = { ...record, revision: record.revision + 1,
                terminalReportDigest: digest(claim), terminalReport: claim,
                ...(record.bodyLifecycle?.version === 2 ? { executionCount: 1,
                  bodyLifecycle: { ...record.bodyLifecycle, observedStartCount: 1, completedReportCount: 1 } } : {}) }
              record = next
              if (!journal.write(next)) throw fault(journal.failed().code)
              observeJournal(nativeResources)
              assertLiveRelationship()
              if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
            } else bodyOutcome = bodyObservation(claim.outcome)
            peer.end(`${JSON.stringify({ kind: "body-recorded" })}\n`)
            return
          }
          throw fault("producer_phase_refused")
        }
        assertOwnerCurrentness()
        const current = observeJournal(nativeResources)
        const expectedGrant = { id, revision: record.revision, owner: self, native: nativeResources }
        relationship = qualifyProducerExecutor({ claim, nonce: executorNonce, used,
          native: generation(nativeResources.childPid), executor: generation(claim.pid), owner: generation(process.pid),
          grant: { id: current.id, revision: current.revision, owner: current.owner, native: current.resources }, expectedGrant })
        if (Date.now() >= record.producerDeadline || journal.failed()) throw fault("producer_relationship_expired")
        observeJournal(nativeResources)
        used = true
        if (saveWork) {
          boundPeer = peer
          if (record.bodyLifecycle?.version === 2) {
            record = { ...record, revision: record.revision + 1, executionCount: null,
              bodyLifecycle: { ...record.bodyLifecycle, grantIssueCount: 1, observedStartCount: null } }
            if (!journal.write(record)) throw fault(journal.failed().code)
            observeJournal(nativeResources)
            if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
          }
          peer.write(`${JSON.stringify({ kind: "save-capability", id, authority: grant.authority,
            ...(currentness ? { producerCurrentness: record.producerCurrentness, footprint: grant.footprint,
              ...(grant.operationSelection ? { operationSelection: grant.operationSelection } : {}) } : {}),
            ...(record.bodyLifecycle?.version === 2 ? { terminalSchema: 2 } : {}),
            producerDeadline: record.producerDeadline, publicationDeadline: record.publicationDeadline,
            payload: { paths: payload.paths, message: payload.message, tidy: payload.tidy, fileCount: payload.files.length } })}\n`)
          for (const [ordinal, file] of payload.files.entries()) {
            const bytes = Buffer.from(file.content, "utf8")
            peer.write(`${JSON.stringify({ kind: "payload-file", path: file.path, ordinal, bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex") })}\n`)
            for (let offset = 0; offset < bytes.length; offset += 64 * 1024) {
              if (Date.now() >= record.producerDeadline) throw fault("producer_deadline")
              peer.write(`${JSON.stringify({ kind: "payload-chunk", ordinal, offset,
                bytes: bytes.subarray(offset, offset + 64 * 1024).toString("base64") })}\n`)
            }
            peer.write(`${JSON.stringify({ kind: "payload-file-complete", ordinal })}\n`)
          }
          peer.write(`${JSON.stringify({ kind: "payload-complete", digest: record.payloadDigest })}\n`)
        } else peer.end(`${JSON.stringify({ kind: "read-only-capability", id })}\n`)
      } catch (error) {
        record.claimFailures ??= []
        record.claimFailures.push({ code: error.code ?? "producer_claim_invalid" })
        peer.end(`${JSON.stringify({ kind: "refused", reason: error.code ?? "producer_claim_invalid" })}\n`)
      }
    }
    peer.on("data", (chunk) => {
      content += chunk
      if (Buffer.byteLength(content) > (saveWork && peer === boundPeer ? 2 * 1024 * 1024 : 4096)) {
        record.channelFailures ??= []
        record.channelFailures.push({ code: "producer_frame_too_large" })
        peer.destroy()
        return
      }
      while (content.includes("\n") && !peer.destroyed) {
        const split = content.indexOf("\n"), line = content.slice(0, split); content = content.slice(split + 1)
        handleFrame(line)
      }
    })
  }
  const timer = setTimeout(() => { for (const peer of peers) peer.destroy(); broker?.close() }, Math.max(1, record.producerDeadline - Date.now()))
  let result
  try {
    socketDirectory = mkdtempSync(path.join(os.tmpdir(), "dpg1-"))
    socket = path.join(socketDirectory, "broker")
    record = { ...record, broker: { directory: socketDirectory, path: socket, custody: "unknown" } }
    directoryIdentity = lstatSync(socketDirectory, { bigint: true })
    record.broker.directoryIdentity = { dev: String(directoryIdentity.dev), ino: String(directoryIdentity.ino) }
    broker = createServer(connectPeer)
    await new Promise((resolve, reject) => { broker.once("error", reject); broker.listen(socket, resolve) })
    socketIdentity = lstatSync(socket, { bigint: true })
    record.broker.socketIdentity = { dev: String(socketIdentity.dev), ino: String(socketIdentity.ino) }
    record = { ...record, revision: record.revision + 1,
      broker: { directory: socketDirectory, path: socket, custody: "owned",
        directoryIdentity: { dev: String(directoryIdentity.dev), ino: String(directoryIdentity.ino) },
        socketIdentity: { dev: String(socketIdentity.dev), ino: String(socketIdentity.ino) } } }
    if (!journal.write(record)) throw fault(journal.failed().code)
    result = await runOwnedProcess({ command: process.execPath, args: [SCRIPT, saveWork ? "--producer-save-executor" : "--producer-gate1-executor", socket],
      cwd: root, env: { ...grant.authority.env, DESK_PRODUCER_EXECUTOR_NONCE: executorNonce },
      deadline: record.producerDeadline, inspection: true, ownSignals: true, onResource: recordResource })
    // Keep the native outcome independently of whether terminal evidence can be persisted.
    const outcome = { ...(saveWork ? producerCommandOutcome(result) : { status: result.status, error: result.error ?? null,
        stdout: result.stdout, stderr: result.stderr }), spawnError: result.spawnError ?? null,
        cancelled: result.cancelled, timedOut: result.timedOut, outputTruncated: result.outputTruncated,
        requestSent: result.requestSent }
    record = { ...record, resources: result.resources, outcome }
    if (!journal.failed()) {
      try {
        observeJournal()
      } catch (error) { journal.latch(error) }
    }
    const bodyFailed = saveWork && bodyOutcome && (bodyOutcome.state !== "body_settled" ||
      (bodyOutcome.command && (bodyOutcome.command.status !== 0 || bodyOutcome.command.error)))
    const noOp = saveWork && bodyOutcome?.state === "body_settled" && bodyOutcome.reason === "nothing_to_commit" &&
      !bodyOutcome.command && !record.bodyHistory?.some((step) => step.phase === "commit")
    const verified = result.status === 0 && !result.error && !result.spawnError && !result.cancelled &&
      !result.timedOut && !result.outputTruncated && (saveWork ? bodyOutcome?.state === "body_settled" : result.stdout === "producer capability ready\n") &&
      !bodyFailed && relationship && !journal.failed()
    record = { ...record, revision: record.revision + 1, resources: result.resources,
      state: !result.resources.childrenClosed ? "unknown" : verified ? saveWork ? "body_settled" : "capability_verified" : "blocked",
      reason: journal.failed()?.code ?? (bodyFailed ? bodyOutcome.reason ?? "producer_commit_failed" : null) ??
        (noOp && verified ? "nothing_to_commit" : null) ?? result.error ?? result.spawnError ?? (verified ? null : result.cancelled
        ? "producer_cancelled" : result.timedOut ? "producer_deadline" : result.outputTruncated
          ? "producer_output_truncated" : relationship ? "producer_fixture_failed" : "producer_capability_unqualified"),
      capabilityGranted: used, executionCount: record.bodyLifecycle?.version === 2
        ? record.bodyLifecycle.observedStartCount
        : used && (saveWork ? Boolean(bodyOutcome) : result.stdout === "producer capability ready\n") ? 1 : 0,
      relationship, outcome, ...(saveWork ? { bodyOutcome, publication: "not_started", attribution: "provisional" } : {}) }
    journal.write(record)
    if (saveWork && result.resources.childrenClosed && !journal.failed() && bodyOutcome && !bodyFailed && !noOp) {
      try {
        const attributed = attributeAcceptedBody({ record, authority: grant.authority, result,
          ...(currentness ? { assertCurrent: () => { observeJournal(); assertOwnerCurrentness() } } : {}) })
        const receipt = Object.freeze(Object.create(null))
        bodyReceiptProofs.set(receipt, { ...attributed, requestId: id, authority: grant.authority,
          producerDeadline: record.producerDeadline, publicationDeadline: record.publicationDeadline })
        ownerReceipts.set(result, receipt)
        record = { ...record, revision: record.revision + 1, state: "effect_attributed", attribution: attributed }
        journal.write(record)
      } catch (error) {
        record = { ...record, revision: record.revision + 1, state: "unknown",
          attribution: "unqualified", reason: error.code ?? "producer_body_attribution_unqualified" }
        journal.write(record)
      }
    }
    journal.emit()
  } catch (error) {
    record = { ...record, revision: record.revision + 1,
      state: nativeResources?.childrenClosed === false ? "unknown" : "blocked",
      reason: error.code ?? "producer_gate1_failed", resources: result?.resources ?? nativeResources ?? record.resources }
    process.stderr.write(`${JSON.stringify({ id, code: error.code ?? "producer_gate1_failed",
      primaryFilesystem: { code: error.code ?? null, path: error.path ?? null, syscall: error.syscall ?? null },
      resources: record.resources, broker: record.broker, outcome: record.outcome })}\n`)
    if (error.code && !journal.failed()) journal.latch(error)
    journal.write(record)
    journal.emit()
  } finally {
    clearTimeout(timer)
    for (const peer of peers) peer.destroy()
    if (broker) await new Promise((resolve) => broker.close(() => resolve()))
    try {
      if (!socketDirectory || !directoryIdentity) throw fault("producer_broker_identity_unknown")
      const currentDirectory = lstatSync(socketDirectory, { bigint: true })
      if (!currentDirectory.isDirectory() || currentDirectory.dev !== directoryIdentity.dev ||
        currentDirectory.ino !== directoryIdentity.ino || !result?.resources.childrenClosed) throw fault("producer_broker_custody_unknown")
      const currentSocket = lstatSync(socket, { bigint: true, throwIfNoEntry: false })
      if (currentSocket) {
        if (!currentSocket.isSocket() || !socketIdentity || currentSocket.ino !== socketIdentity.ino ||
          currentSocket.dev !== socketIdentity.dev) throw fault("producer_broker_custody_unknown")
        unlinkSync(socket)
      }
      rmdirSync(socketDirectory)
      record = { ...record, revision: record.revision + 1, broker: { ...record.broker, custody: "removed" } }
    } catch (error) {
      record = { ...record, revision: record.revision + 1,
        broker: { ...record.broker, directory: socketDirectory, path: socket, custody: "unknown",
          cleanup_error: error.code ?? "producer_broker_cleanup_failed" } }
    }
    journal.write(record)
    journal.emit()
    retireCurrentness()
  }
}
export async function runProducerGate1Executor({ socket }) {
  const nonce = process.env.DESK_PRODUCER_EXECUTOR_NONCE
  delete process.env.DESK_PRODUCER_EXECUTOR_NONCE
  const container = JSON.parse(process.env.DESK_RECOVERY_CONTAINER ?? "null")
  if (!nonce || !container || Date.now() >= container.deadline) throw fault("producer_executor_authority_required")
  const self = generation(process.pid)
  const peer = createConnection(socket)
  peer.setEncoding("utf8")
  const timer = setTimeout(() => peer.destroy(fault("producer_deadline")), Math.max(1, container.deadline - Date.now()))
  try {
    const response = await new Promise((resolve, reject) => {
      peer.once("error", reject); peer.once("connect", () => peer.write(`${JSON.stringify({ nonce, pid: self.pid, start: self.start, container })}\n`))
      let text = ""
      peer.on("data", (chunk) => { text += chunk; if (Buffer.byteLength(text) > 4096) reject(fault("producer_reply_invalid")) })
      peer.once("end", () => { try { resolve(JSON.parse(text)) } catch { reject(fault("producer_reply_invalid")) } })
    })
    if (response.kind !== "read-only-capability" || !UUID.test(response.id)) throw fault("producer_capability_refused")
    process.stdout.write("producer capability ready\n")
  } finally { clearTimeout(timer); peer.destroy() }
}

async function receiveSavePayload(next, grant) {
  const payload = { paths: grant.payload.paths, message: grant.payload.message, tidy: grant.payload.tidy, files: [] }
  const check = () => { if (Date.now() >= grant.producerDeadline) throw fault("producer_deadline") }
  for (let index = 0; index < grant.payload.fileCount; index++) {
    check()
    const file = await next()
    check()
    if (file.kind !== "payload-file" || typeof file.path !== "string" || file.ordinal !== index ||
      !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1024 * 1024) throw fault("producer_payload_unqualified")
    const chunks = []
    let size = 0
    for (;;) {
      check()
      const chunk = await next()
      check()
      if (chunk.kind === "payload-file-complete" && chunk.ordinal === index) break
      if (chunk.kind !== "payload-chunk" || chunk.ordinal !== index || chunk.offset !== size ||
        typeof chunk.bytes !== "string" || chunk.bytes.length > 90 * 1024) throw fault("producer_payload_unqualified")
      const bytes = Buffer.from(chunk.bytes, "base64")
      if (!bytes.length || bytes.length > 64 * 1024 || size + bytes.length > file.bytes) throw fault("producer_payload_unqualified")
      chunks.push(bytes); size += bytes.length
    }
    const bytes = Buffer.concat(chunks)
    if (size !== file.bytes || createHash("sha256").update(bytes).digest("hex") !== file.sha256) throw fault("producer_payload_unqualified")
    payload.files.push({ path: file.path, content: bytes.toString("utf8") })
  }
  check()
  const complete = await next()
  check()
  if (complete.kind !== "payload-complete" || complete.digest !== savePayloadDigest(payload, grant.producerDeadline)) throw fault("producer_payload_unqualified")
  return payload
}
export async function runProducerSaveExecutor({ socket }) {
  const nonce = process.env.DESK_PRODUCER_EXECUTOR_NONCE
  delete process.env.DESK_PRODUCER_EXECUTOR_NONCE
  const container = JSON.parse(process.env.DESK_RECOVERY_CONTAINER ?? "null")
  if (!nonce || !container || Date.now() >= container.deadline) throw fault("producer_executor_authority_required")
  const self = generation(process.pid), peer = createConnection(socket)
  peer.setEncoding("utf8")
  const frames = [], waiting = []
  let failure = null, content = ""
  const fail = (error) => {
    failure ??= error
    for (const pending of waiting.splice(0)) pending.reject(failure)
  }
  peer.on("error", fail)
  peer.on("close", () => fail(fault("producer_execution_channel_closed")))
  peer.on("data", (chunk) => {
    content += chunk
    if (Buffer.byteLength(content) > 2 * 1024 * 1024) { peer.destroy(fault("producer_payload_too_large")); return }
    while (content.includes("\n")) {
      const split = content.indexOf("\n"), line = content.slice(0, split); content = content.slice(split + 1)
      try {
        const frame = JSON.parse(line)
        const pending = waiting.shift()
        if (pending) pending.resolve(frame)
        else frames.push(frame)
      } catch (error) { fail(fault("producer_reply_invalid")); peer.destroy(); return }
    }
  })
  const next = () => frames.length ? Promise.resolve(frames.shift()) : failure ? Promise.reject(failure)
    : new Promise((resolve, reject) => waiting.push({ resolve, reject }))
  const timer = setTimeout(() => peer.destroy(fault("producer_deadline")), Math.max(1, container.deadline - Date.now()))
  let capability, currentness = null, currentnessContext = null, operationEnvironment = null
  try {
    await new Promise((resolve, reject) => { peer.once("connect", resolve); peer.once("error", reject) })
    peer.write(`${JSON.stringify({ nonce, pid: self.pid, start: self.start, container })}\n`)
    const grant = await next()
    if (grant.kind !== "save-capability" || !UUID.test(grant.id) || grant.producerDeadline !== container.deadline ||
      !grant.authority || !Number.isSafeInteger(grant.payload?.fileCount) || grant.payload.fileCount < 0) throw fault("producer_capability_refused")
    const payload = await receiveSavePayload(next, grant)
    if (grant.producerCurrentness !== undefined) {
      if (grant.producerCurrentness.version !== 1 || grant.producerCurrentness.operationId !== grant.id ||
        grant.producerCurrentness.originalDeadline !== container.deadline ||
        grant.producerCurrentness.footprintDigest !== digest(grant.footprint)) throw fault("producer_currentness_changed")
      currentnessContext = createPublicationContext({ root: grant.authority.root, env: grant.authority.env,
        person: grant.authority.person, sessionId: `producer-executor-currentness:${grant.id}`, requireCommitReceipt: true })
      if (grant.producerCurrentness.selectorDigest !== undefined || grant.operationSelection !== undefined) {
        if (!grant.operationSelection || typeof grant.producerCurrentness.selectorDigest !== "string" ||
          digest(grant.operationSelection) !== grant.producerCurrentness.selectorDigest) throw fault("producer_currentness_changed")
        operationEnvironment = registerTransferredFirstOperationEnvironment({ context: currentnessContext,
          selection: grant.operationSelection, expectedDigest: grant.producerCurrentness.selectorDigest,
          operationId: grant.id, createdAtMs: grant.producerDeadline - 10000,
          producerDeadline: grant.producerDeadline, publicationDeadline: grant.publicationDeadline })
      }
      currentness = beginFirstSaveCurrentness({ context: currentnessContext, operationId: grant.id,
        operationEnvironment, producerDeadline: grant.producerDeadline,
        expectedAuthority: grant.authority, expectedFootprint: grant.footprint })
    }
    const exchange = async (message, kind) => {
      if (failure || peer.destroyed || Date.now() >= container.deadline) throw fault("producer_execution_channel_closed")
      peer.write(`${JSON.stringify(message)}\n`)
      const reply = await next()
      if (reply.kind !== kind || (message.sequence !== undefined && reply.sequence !== message.sequence)) throw fault("producer_phase_refused")
    }
    capability = Object.freeze(Object.create(null))
    const protocol = { lastIntentSequence: 0, lastApprovalAckSequence: 0, lastCompletedSequence: 0 }
    executions.set(capability, { active: true, authority: grant.authority, payload, id: grant.id,
      currentnessMonitor: currentness?.monitor,
      commandBaseEnv: Object.freeze({ ...grant.authority.env }),
      terminalSchema: grant.terminalSchema, protocol,
      producerDeadline: grant.producerDeadline, publicationDeadline: grant.publicationDeadline, peer, container, self,
      started: () => exchange({ kind: "body-started", schema_version: 2, operationId: grant.id,
        producerDeadline: grant.producerDeadline, publicationDeadline: grant.publicationDeadline }, "body-started-recorded"),
      approve: async (step) => {
        protocol.lastIntentSequence = step.sequence
        await exchange({ kind: "phase-intent", ...step }, "phase-approved")
        protocol.lastApprovalAckSequence = step.sequence
      },
      report: async (message) => {
        await exchange(message, message.kind === "private-resource" ? "resource-recorded" : "phase-recorded")
        if (message.kind === "phase-result") protocol.lastCompletedSequence = message.sequence
      } })
    await validateExecution(capability)
    const { executeAcceptedDeskSave } = await import("./producer-body.js")
    const outcome = await executeAcceptedDeskSave({ executionCapability: capability })
    if (grant.terminalSchema === 2) {
      const { producerDeadline, publicationDeadline, ...terminal } = outcome
      await exchange({ kind: "body-outcome", schema_version: 2, operationId: grant.id,
        producerDeadline, publicationDeadline, outcome: terminal }, "body-recorded")
    } else await exchange({ kind: "body-outcome", outcome }, "body-recorded")
    if (outcome.state !== "body_settled") process.exitCode = 1
  } finally {
    if (capability) executions.get(capability).active = false
    clearTimeout(timer); peer.destroy()
    if (currentness) closeFirstSaveCurrentness(currentness.monitor)
    if (operationEnvironment) closeFirstOperationEnvironment(operationEnvironment)
    if (currentnessContext) closePublicationContext(currentnessContext)
  }
}
