import { createHash, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { accessSync, closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import { personPrefix, isPathContained, resolveWriteTarget } from "../util/paths.js"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { lastStartRootKey, resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"
import { readProcessStart } from "../readiness/process-start.js"
import { recoveryBinding, isLocalBindingCurrent, captureRecoveryRootIdentity, observeRecoveryProcess, readRecoveryStatus, runOwnedProcess } from "./recovery-state.js"
import { redactCredentialLikeText } from "../util/redact.js"
import { readSmallText } from "../factory/marker.js"
import { EXACT, sameFile } from "../util/file-identity.js"
import { resolveStartupActivationConfigPath } from "./startup-resolve.js"

const SCRIPT = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))
const contexts = new WeakMap()
const intents = new WeakMap()
const commitResults = new WeakMap()
const commitReceipts = new WeakMap()
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u
const terminal = new Set(["verified", "blocked", "unknown"])
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const fault = (code) => Object.assign(new Error(code), { code })

function contextOf(context) {
  const value = contexts.get(context)
  if (!value?.active) throw fault("publication_context_invalid")
  return value
}

/** Created by trusted server/session wiring, never from a tool's JSON input. */
export function createPublicationContext({ root, env = process.env, sessionId, person = null, lifetimeMs = 60000, requireCommitReceipt = false }) {
  if (typeof sessionId !== "string" || sessionId === "") throw fault("publication_session_required")
  if (person !== null && (typeof person !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(person))) throw fault("publication_scope_invalid")
  if (!Number.isFinite(lifetimeMs) || lifetimeMs < 1000 || lifetimeMs > 120000) throw fault("publication_lifetime_invalid")
  const context = Object.freeze(Object.create(null))
  contexts.set(context, { root: realpathSync(root), rootIdentity: captureRecoveryRootIdentity(root),
    env: { ...env }, sessionId, person, lifetimeMs, requireCommitReceipt, active: true })
  return context
}

export function closePublicationContext(context) {
  contextOf(context).active = false
}

function capturePublicationAuthority(owner, deadline = Date.now() + owner.lifetimeMs) {
  if (captureRecoveryRootIdentity(owner.root) !== owner.rootIdentity) throw fault("publication_root_changed")
  const base = owner.binding ?? recoveryBinding(owner.root, owner.env, { deadline })
  if (captureRecoveryRootIdentity(owner.root) !== owner.rootIdentity) throw fault("publication_root_changed")
  if (base.remote && typeof base.push === "string") {
    const timeout = Math.min(5000, deadline - Date.now())
    if (timeout <= 0) throw fault("publication_deadline")
    const route = spawnSync("git", ["-C", owner.root, "remote", "get-url", "--push", "--all", base.remote],
      { env: owner.env, encoding: "utf8", timeout, killSignal: "SIGKILL" })
    if (route.status !== 0 || route.error) throw fault(route.error?.code ?? "publication_local_inspection_failed")
    const raw = route.stdout
    if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n") || raw.slice(0, -1) !== base.push ||
      /^[\u0000-\u0020]|[\u0000-\u0020]$/u.test(raw.slice(0, -1))) {
      throw fault("publication_destination_input_not_qualified")
    }
  }
  if (!isLocalBindingCurrent(base, { root: owner.root, env: owner.env })) throw fault("publication_binding_changed")
  const localPushHook = metadata(local(owner.root, owner.env,
    ["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"], deadline))
  const serverPolicy = typeof base.push === "string" && (path.isAbsolute(base.push) || /^file:/iu.test(base.push))
    ? localServerPolicy(base, owner.env, deadline) : null
  const resolution = serverPolicy?.resolution ?? null
  if (owner.binding && digest(owner.binding.destinationResolution) !== digest(resolution)) throw fault("publication_binding_changed")
  const recoveryKey = base.recoveryKey ?? base.key
  const binding = { ...base, recoveryKey, destinationResolution: resolution, key: digest({ recoveryKey, resolution }) }
  if (!isLocalBindingCurrent(binding, { root: owner.root, env: owner.env })) throw fault("publication_binding_changed")
  if (captureRecoveryRootIdentity(owner.root) !== owner.rootIdentity) throw fault("publication_root_changed")
  owner.binding = binding
  return { binding, localPushHook, serverPolicy }
}

/** A trusted producer mints this only after its exact commit outcome is known. */
export function createPublicationIntent({ context, targetCommit, producerOperationId, commitReceipt }) {
  const owner = contextOf(context)
  if (owner.requireCommitReceipt && commitReceipt === undefined) throw fault("publication_commit_receipt_required")
  if (commitReceipt !== undefined) {
    const proof = commitReceipts.get(commitReceipt)
    if (!proof || proof.context !== context) throw fault("publication_commit_receipt_required")
    targetCommit = proof.targetCommit
    producerOperationId = proof.operationId
  }
  if (!OID.test(targetCommit ?? "") || typeof producerOperationId !== "string" || producerOperationId === "") {
    throw fault("publication_commit_receipt_required")
  }
  if (captureRecoveryRootIdentity(owner.root) !== owner.rootIdentity) throw fault("publication_root_changed")
  const { binding, localPushHook, serverPolicy } = capturePublicationAuthority(owner)
  const intent = Object.freeze(Object.create(null))
  intents.set(intent, { context, targetCommit, producerOperationId, binding, localPushHook, serverPolicy })
  return intent
}

export function assertPublicationProducer({ context, root, person, stateBranch }) {
  const owner = contextOf(context)
  if (realpathSync(root) !== owner.root || (person !== undefined && person !== owner.person)) throw fault("publication_scope_changed")
  const authority = capturePublicationAuthority(owner)
  if (stateBranch !== undefined && stateBranch !== null && authority.binding.branch !== `refs/heads/${stateBranch}`) {
    throw fault("publication_binding_changed")
  }

  return authority.binding.branch
}

/** Internal dispatcher input; possession of the serialized value never authorizes a worker. */
export function captureProducerAdmission(context, { deadline } = {}) {
  const owner = contextOf(context)
  const authority = capturePublicationAuthority(owner, deadline === undefined ? undefined : Math.min(deadline, Date.now() + owner.lifetimeMs))
  return { root: owner.root, rootIdentity: owner.rootIdentity, person: owner.person,
    env: { ...owner.env }, binding: authority.binding, localPushHook: authority.localPushHook,
    serverPolicy: authority.serverPolicy }
}

export function publicationReceiptOf({ context, commitResult }) {
  contextOf(context)
  const proof = commitResults.get(commitResult)
  if (!proof || proof.context !== context) return { status: "unqualified", reason: "publication_commit_result_unqualified" }
  if (!proof.receipt) return { status: "unqualified", reason: proof.reason, effects: proof.effects }
  assertPublicationProducer({ context, root: contextOf(context).root })
  return { status: "qualified", receipt: proof.receipt }
}

export function publicationGit(context) {
  const owner = contextOf(context)
  return (command, args, options) => {
    assertPublicationProducer({ context, root: owner.root })
    return spawnSync(command, args, { ...options, env: { ...owner.env, DESK_TOOL_COMMIT: "1" } })
  }
}

/** Participating helpers retain synchronous legacy behavior when no opaque context is supplied. */
export async function commitPublicationPaths({ context, root, paths, entries, message, stateBranch }) {
  const owner = contextOf(context)
  const branch = assertPublicationProducer({ context, root, stateBranch })
  root = owner.root
  if (!Array.isArray(paths) || paths.length === 0 || paths.some((file) =>
    typeof file !== "string" || file === "" || path.isAbsolute(file) || file.split(/[\\/]/u).includes("..") ||
    file.includes("\0") || /[*?[\\]|^:/u.test(file))) throw fault("publication_write_set_invalid")
  paths = [...new Set(paths.map((file) => path.posix.normalize(file).replace(/\/$/u, "")))]
  const prefix = path.resolve(personPrefix(owner.root, owner.person))
  const validatePath = async (file) => {
    const absolute = path.resolve(root, file)
    if (!isPathContained(prefix, absolute)) throw fault("publication_write_set_invalid")
    const segments = path.relative(prefix, absolute).split(path.sep).filter(Boolean)
    if (segments.length > 0) await resolveWriteTarget({ deskRoot: root, person: owner.person, segments })
    assertPublicationProducer({ context, root, stateBranch })
  }
  for (const file of paths) await validatePath(file)
  const operationId = randomUUID(), action = `desk-publication:${operationId}`, deadline = Date.now() + 10000
  const env = { ...owner.env, DESK_TOOL_COMMIT: "1" }
  const existingAction = Object.hasOwn(env, "GIT_REFLOG_ACTION")
  if (!existingAction) env.GIT_REFLOG_ACTION = action
  const read = (args, readEnv = env) => {
    const timeout = Math.min(5000, deadline - Date.now())
    if (timeout <= 0) throw fault("publication_deadline")
    const observed = spawnSync("git", ["-C", root, ...args], { env: readEnv, encoding: "utf8", timeout })
    if (observed.status !== 0 || observed.error) throw fault("publication_producer_readback_failed")
    return observed.stdout
  }
  const head = spawnSync("git", ["-C", root, "rev-parse", "--verify", "-q", "HEAD"], { env, encoding: "utf8", timeout: 5000 })
  const parent = head.status === 0 && !head.error ? head.stdout.trim() : null
  if (parent === null) {
    const branchPresent = spawnSync("git", ["-C", root, "show-ref", "--verify", "--quiet", branch], { env, encoding: "utf8", timeout: 5000 })
    if (head.error || head.status !== 1 || branchPresent.error || branchPresent.status !== 1) throw fault("publication_producer_parent_unknown")
  } else if (!OID.test(parent)) throw fault("publication_producer_parent_unknown")
  const parseEntries = (text) => text.split("\0").filter(Boolean).map((line) => {
    const separator = line.indexOf("\t"), [mode, sha, stage] = line.slice(0, separator).split(" ")
    return { mode, sha, stage, path: line.slice(separator + 1) }
  })
  const selected = parseEntries(read(["ls-files", "-s", "-z", "--", ...paths]))
  const previousFiles = parent ? read(["ls-tree", "-r", "--name-only", "-z", parent, "--", ...paths]).split("\0").filter(Boolean) : []
  const covers = (file) => paths.some((selection) => selection === "." || file === selection || file.startsWith(`${selection}/`))
  const expected = entries ?? selected
  if (expected.some((entry) => entry.stage !== "0" || !OID.test(entry.sha) || !covers(entry.path))) {
    throw fault("publication_write_set_invalid")
  }
  paths = [...new Set([...expected.map((entry) => entry.path), ...previousFiles])]
  if (paths.length === 0) throw fault("publication_write_set_invalid")
  for (const file of paths) await validatePath(file)
  const producerFile = path.join(directory(root, owner.env), `producer-${operationId}.json`)
  mkdirSync(path.dirname(producerFile), { recursive: true, mode: 0o700 })
  let persistenceError = null
  let privateResource = null
  const resourceIdentity = (stat) => ({ dev: String(stat.dev), ino: String(stat.ino), mode: String(stat.mode) })
  const matchesIdentity = (stat, identity) => identity && String(stat.dev) === identity.dev &&
    String(stat.ino) === identity.ino && String(stat.mode) === identity.mode
  const assertPrivateDirectory = () => {
    const stat = lstatSync(privateResource.path, { bigint: true })
    if (!stat.isDirectory() || !matchesIdentity(stat, privateResource.identity)) throw fault("publication_private_resource_custody_unknown")
  }
  const capturePrivateChild = (name) => {
    assertPrivateDirectory()
    const file = path.join(privateResource.path, name)
    const stat = lstatSync(file, { bigint: true, throwIfNoEntry: false })
    if (stat === undefined) return
    if (!stat.isFile() || stat.nlink !== 1n) throw fault("publication_private_resource_custody_unknown")
    const prior = privateResource.children.find((entry) => entry.name === name)
    const entry = { name, path: file, identity: resourceIdentity(stat) }
    if (prior) {
      if (!matchesIdentity(stat, prior.identity)) {
        prior.observations ??= [{ identity: prior.identity }]
        prior.observations.push({ identity: entry.identity, custody: "unknown" })
        privateResource.custody = "unknown"
        privateResource.observation_error = { code: "publication_private_child_transition_unknown", path: file }
      }
    } else privateResource.children.push(entry)
  }
  const cleanupPrivateResource = () => {
    assertPrivateDirectory()
    const names = readdirSync(privateResource.path)
    if (names.some((name) => !privateResource.children.some((entry) => entry.name === name))) {
      throw fault("publication_private_resource_custody_unknown")
    }
    for (const child of privateResource.children) {
      const stat = lstatSync(child.path, { bigint: true, throwIfNoEntry: false })
      if (stat && (!stat.isFile() || stat.nlink !== 1n || !matchesIdentity(stat, child.identity))) {
        throw fault("publication_private_resource_custody_unknown")
      }
    }
    privateResource.cleanup_steps ??= []
    const remove = (file, operation, work) => {
      const step = { path: file, operation, state: "unknown" }
      privateResource.cleanup_steps.push(step)
      work()
      step.state = "removed"
    }
    for (const child of privateResource.children) {
      remove(child.path, "unlink", () => {
        assertPrivateDirectory()
        const stat = lstatSync(child.path, { bigint: true, throwIfNoEntry: false })
        if (!stat) throw fault("publication_private_resource_custody_unknown")
        if (!stat.isFile() || stat.nlink !== 1n || !matchesIdentity(stat, child.identity)) throw fault("publication_private_resource_custody_unknown")
        unlinkSync(child.path)
      })
    }
    remove(privateResource.path, "rmdir", () => {
      assertPrivateDirectory()
      rmdirSync(privateResource.path)
    })
    privateResource.custody = "removed"
  }
  const recordProducer = (patch) => {
    if (persistenceError) return
    const temp = `${producerFile}.${randomUUID()}.tmp`
    let owned = false
    let closed = false
    let identity
    let descriptor
    let closeError
    const currentIdentity = () => {
      if (!identity) return false
      const current = lstatSync(temp, { bigint: true })
      return current.isFile() && current.dev === identity.dev && current.ino === identity.ino && current.nlink === 1n
    }
    try {
      const value = {
        version: 1, operationId, root, rootIdentity: owner.rootIdentity, branch, parent, paths, expected, deadline,
        preparations, temporary: privateResource?.path ?? null, private_resource: privateResource, ...patch,
      }
      const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      descriptor = fd
      owned = true
      let primary
      try {
        identity = fstatSync(fd, { bigint: true })
        writeFileSync(fd, `${JSON.stringify(value)}\n`)
      } catch (error) { primary = error }
      try { closeSync(fd); closed = true } catch (error) { closeError = error; primary ??= error }
      if (primary) throw primary
      if (!currentIdentity()) throw fault("publication_journal_path_custody_unknown")
      renameSync(temp, producerFile)
    } catch (error) {
      persistenceError = { code: error.code ?? "publication_producer_journal_failed", message: error.message,
        path: error.path ?? null, syscall: error.syscall ?? null, dest: error.dest ?? null, journalPath: producerFile }
      if (owned) {
        if (!closed) {
          persistenceError.retained_resource = temp
          persistenceError.descriptor_custody = "unknown"
          persistenceError.descriptor = descriptor
          persistenceError.close_error = { code: closeError?.code ?? "publication_journal_close_unknown", message: closeError?.message }
        } else {
          try {
            if (!currentIdentity()) throw fault("publication_journal_path_custody_unknown")
            unlinkSync(temp)
          } catch (cleanup) {
            persistenceError.retained_resource = temp
            persistenceError.path_custody = "unknown"
            persistenceError.cleanup_error = { code: cleanup.code ?? "publication_journal_cleanup_failed", message: cleanup.message }
          }
        }
      }
    }
  }
  const checkPersistence = () => {
    if (persistenceError) throw Object.assign(fault("publication_producer_journal_failed"), { persistence_error: persistenceError })
  }
  let temporary
  let native
  let preparationClosed = true
  let preparationResources = { childrenClosed: true }
  const preparations = []
  let commitDispatched = false
  let returnedResult
  let primaryError
  const preservePersistence = (result, effects) => {
    if (!persistenceError) return
    result.ok = false
    result.stderr = result.stderr || "Producer journal persistence failed after native settlement"
    effects.persistence_error = persistenceError
    result.effects = effects
  }
  try {
  if (entries !== undefined) {
    temporary = mkdtempSync(path.join(os.tmpdir(), "desk-publication-index-"))
    privateResource = { path: temporary, identity: null, custody: "unknown", children: [] }
    const createdDirectory = lstatSync(temporary, { bigint: true })
    if (!createdDirectory.isDirectory()) throw fault("publication_private_resource_custody_unknown")
    privateResource.identity = resourceIdentity(createdDirectory)
    privateResource.custody = "owned"
    env.GIT_INDEX_FILE = path.join(temporary, "index")
    const prepare = async (args, input) => {
      if (Date.now() >= deadline) throw fault("publication_deadline")
      recordProducer({ state: "preparing", temporary, preparations, resources: preparationResources })
      checkPersistence()
      const onResource = (resources) => {
        preparationResources = resources
        recordProducer({ state: "preparing", temporary, preparations, resources })
      }
      // update-index accepts the bounded input through a named private file via a native shell-free helper.
      if (input !== undefined) {
        const inputFile = path.join(temporary, "entries")
        writeFileSync(inputFile, input, { mode: 0o600 })
        capturePrivateChild("entries")
        const script = `const fs=require("node:fs");const cp=require("node:child_process");const remaining=${deadline}-Date.now();if(remaining<=0)process.exit(124);const r=cp.spawnSync("git",JSON.parse(process.argv[1]),{env:process.env,input:fs.readFileSync(process.argv[2]),stdio:["pipe","inherit","inherit"],timeout:remaining});process.exit(r.status??1)`
        preparationClosed = false
        const result = await runOwnedProcess({ command: process.execPath, args: ["-e", script, JSON.stringify(["-C", root, ...args]), inputFile],
          cwd: root, env, deadline, ownSignals: true, onResource })
        preparationClosed = result.resources.childrenClosed
        preparationResources = result.resources
        preparations.push({ phase: args[0], status: result.status, error: result.error ?? null, resources: result.resources })
        if (!preparationClosed || result.status !== 0 || result.error || result.cancelled) throw fault("publication_index_preparation_failed")
        capturePrivateChild("index")
        checkPersistence()
      } else {
        preparationClosed = false
        const result = await runOwnedProcess({ command: "git", args: ["-C", root, ...args], cwd: root, env, deadline, ownSignals: true, onResource })
        preparationClosed = result.resources.childrenClosed
        preparationResources = result.resources
        preparations.push({ phase: args[0], status: result.status, error: result.error ?? null, resources: result.resources })
        if (!preparationClosed || result.status !== 0 || result.error || result.cancelled) throw fault("publication_index_preparation_failed")
        capturePrivateChild("index")
        checkPersistence()
      }
    }
    await prepare(parent ? ["read-tree", parent] : ["read-tree", "--empty"])
    const held = new Set(expected.map((entry) => entry.path))
    const input = [...expected.map((entry) => `${entry.mode} ${entry.sha}\t${entry.path}\0`),
      ...paths.filter((file) => !held.has(file)).map((file) => `0 ${"0".repeat(parent?.length ?? 40)}\t${file}\0`)].join("")
    await prepare(["update-index", "-z", "--index-info"], input)
  }
    assertPublicationProducer({ context, root, stateBranch })
    recordProducer({ state: "accepted", resources: { childrenClosed: true } })
    checkPersistence()
    commitDispatched = true
    native = await runOwnedProcess({ command: "git", args: ["-C", root, "commit", "-m", message,
      ...(entries === undefined ? ["--", ...paths] : [])], cwd: root, env, deadline, ownSignals: true,
      onResource: (resources) => recordProducer({ state: "accepted", resources }) })
    const result = { ok: native.status === 0 && !native.error && !native.spawnError && !native.cancelled && native.resources.childrenClosed,
      stderr: native.stderr || native.error || native.spawnError || "" }
    const commandEvidence = { status: native.status, error: native.error ?? native.spawnError ?? null,
      requestSent: native.requestSent, cancelled: native.cancelled, timedOut: native.timedOut,
      outputTruncated: native.outputTruncated, resources: native.resources,
      stderr: redactCredentialLikeText(native.stderr).slice(0, 1000) }
    if (privateResource) {
      if (native.resources.childrenClosed) {
        try { capturePrivateChild("index") }
        catch (error) {
          privateResource.custody = "unknown"
          privateResource.observation_error = { code: error.code ?? "publication_private_resource_custody_unknown", message: error.message }
        }
      } else privateResource.custody = "unknown"
    }
    const effects = { status: "unknown", readback_required: true, operationId, deadline, command: commandEvidence,
      ...(privateResource ? { private_resource: privateResource, retained_resource: temporary } : {}) }
    let reason = existingAction ? "publication_caller_reflog_action_preserved" : null
    if (!native.resources.childrenClosed) reason = "publication_producer_closure_unknown"
    else if (native.cancelled || native.outputTruncated) reason = "publication_producer_outcome_unqualified"
    else if (!reason) {
      try {
        assertPublicationProducer({ context, root, stateBranch })
        const reflog = read(["rev-parse", "--path-format=absolute", "--git-path", `logs/${branch}`]).trim()
        const witnesses = readSmallText(reflog, 1024 * 1024).split("\n").filter((line) => line.split("\t")[1]?.startsWith(`${action}: `))
        if (witnesses.length !== 1) throw fault("publication_producer_witness_ambiguous")
        const [old, target] = witnesses[0].split(" ")
        if (old !== (parent ?? "0".repeat(target.length)) || !OID.test(target) ||
          read(["rev-list", "--parents", "-n", "1", target]).trim() !== (parent ? `${target} ${parent}` : target)) {
          throw fault("publication_producer_parent_mismatch")
        }
        const changed = read(["diff-tree", "--no-commit-id", "--name-only", "-r", "-z", ...(parent ? [parent, target] : ["--root", target])]).split("\0").filter(Boolean)
        if (changed.length === 0 || changed.some((file) => !paths.includes(file))) throw fault("publication_producer_write_set_mismatch")
        const tree = read(["ls-tree", "-z", target, "--", ...paths]).split("\0").filter(Boolean).map((line) => {
          const separator = line.indexOf("\t"), [mode, , sha] = line.slice(0, separator).split(" ")
          return { mode, sha, stage: "0", path: line.slice(separator + 1) }
        })
        const order = (values) => JSON.stringify([...values].sort((a, b) => a.path.localeCompare(b.path)))
        if (order(tree) !== order(expected)) throw fault("publication_producer_write_set_mismatch")
        assertPublicationProducer({ context, root, stateBranch })
        if (native.error === "native_outcome_unknown" && native.requestSent && native.resources.childrenClosed &&
          !native.cancelled && !native.outputTruncated) result.ok = true
        const receipt = Object.freeze(Object.create(null))
        commitReceipts.set(receipt, { context, targetCommit: target, operationId })
        const attributedEffects = { ...effects, status: "attributed", targetCommit: target, readback_required: false }
        commitResults.set(result, { context, receipt, effects: attributedEffects })
        if (!result.ok || privateResource?.custody === "unknown") result.effects = attributedEffects
        recordProducer({ state: "qualified", targetCommit: target, command: commandEvidence, resources: native.resources })
        preservePersistence(result, attributedEffects)
        returnedResult = result
        return result
      } catch (error) { reason = error.code ?? "publication_producer_readback_failed" }
    }
    commitResults.set(result, { context, reason, effects })
    if (!result.ok || privateResource?.custody === "unknown") result.effects = effects
    recordProducer({ state: "unqualified", reason, command: commandEvidence, resources: native.resources })
    preservePersistence(result, effects)
    returnedResult = result
    return result
  } catch (error) {
    primaryError = error
    error.mutation = { status: "unknown", readback_required: true, operationId, temporary,
      private_resource: privateResource, commitDispatched, preparations, resources: native?.resources ?? preparationResources }
    if (privateResource && !(native?.resources ?? preparationResources).childrenClosed) privateResource.custody = "unknown"
    recordProducer({ state: "unqualified", reason: error.code ?? "publication_producer_failed", temporary,
      commitDispatched, preparations, resources: native?.resources ?? preparationResources })
    if (persistenceError) error.mutation.persistence_error = persistenceError
    throw error
  } finally {
    if (temporary && privateResource?.custody === "owned" && preparationClosed && (!commitDispatched || native?.resources.childrenClosed)) {
      try {
        cleanupPrivateResource()
        const proof = returnedResult ? commitResults.get(returnedResult) : null
        recordProducer({ state: proof?.receipt ? "qualified" : "unqualified",
          ...(proof?.effects?.targetCommit ? { targetCommit: proof.effects.targetCommit } : {}),
          ...(proof?.reason ? { reason: proof.reason } : {}),
          ...(primaryError ? { reason: primaryError.code ?? "publication_producer_failed" } : {}),
          command: proof?.effects?.command, resources: native?.resources ?? preparationResources })
        if (returnedResult) preservePersistence(returnedResult, proof?.effects ?? returnedResult.effects)
        if (primaryError && persistenceError) primaryError.mutation.persistence_error = persistenceError
      }
      catch (error) {
        privateResource.custody = "unknown"
        const cleanup = { code: error.code ?? "publication_cleanup_failed", message: error.message }
        if (returnedResult) {
          const proof = commitResults.get(returnedResult)
          const effects = proof?.effects ?? returnedResult.effects ?? {
            status: "unknown", readback_required: true, operationId, deadline, resources: native?.resources,
          }
          effects.cleanup_error = cleanup
          effects.retained_resource = temporary
          effects.private_resource = privateResource
          returnedResult.effects = effects
          recordProducer({ state: proof?.receipt ? "qualified" : "unqualified",
            ...(proof?.effects?.targetCommit ? { targetCommit: proof.effects.targetCommit } : {}),
            ...(proof?.reason ? { reason: proof.reason } : {}),
            command: effects.command, resources: native?.resources ?? preparationResources, cleanup_error: cleanup })
          preservePersistence(returnedResult, effects)
        } else if (primaryError) {
          primaryError.mutation ??= { status: "unknown", readback_required: true, operationId }
          primaryError.mutation.cleanup_error = cleanup
          primaryError.mutation.retained_resource = temporary
          primaryError.mutation.private_resource = privateResource
          recordProducer({ state: "unqualified", reason: primaryError.code ?? "publication_producer_failed",
            resources: native?.resources ?? preparationResources, cleanup_error: cleanup })
          if (persistenceError) primaryError.mutation.persistence_error = persistenceError
        }
      }
    }
  }
}

function directory(root, env) {
  const dir = path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(realpathSync(root))}.publication`)
  assertNotRealStateUnderTest(dir, { env })
  return dir
}

function load(file, current = true) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw fault("publication_record_invalid")
      const bytes = Buffer.alloc(stat.size + 1)
      const size = readSync(fd, bytes, 0, bytes.length, 0)
      if (size > stat.size) throw fault("publication_record_changed")
      if (current) {
        const live = lstatSync(file)
        if (!live.isFile() || ["dev", "ino", "size", "mtimeMs", "ctimeMs"].some((key) => live[key] !== stat[key])) {
          if (attempt === 0) continue
          throw fault("publication_record_changed")
        }
      }
      return JSON.parse(bytes.toString("utf8", 0, size))
    } catch (error) {
      if (error.code === "ENOENT") return null
      throw error
    } finally { if (fd !== undefined) closeSync(fd) }
  }
}

function save(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(temp, file)
}

function publishExclusive(file, value) {
  const temp = `${file}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 })
    linkSync(temp, file)
  } finally {
    try { unlinkSync(temp) } catch (error) { if (error.code !== "ENOENT") throw error }
  }
}

function notifyQueued(dir, ticket) {
  const pending = path.join(dir, "pending")
  mkdirSync(pending, { recursive: true, mode: 0o700 })
  save(path.join(pending, `${ticket.id}.json`), {
    id: ticket.id, deadline: ticket.deadline, rootIdentity: ticket.rootIdentity, bindingKey: ticket.binding.key,
  })
}

function consumeNotification(dir, id) {
  try { unlinkSync(path.join(dir, "pending", `${id}.json`)) }
  catch (error) { if (error.code !== "ENOENT") throw error }
}

function publicTicket(ticket) {
  const { binding, serverPolicy, localPushHook, ...value } = ticket
  return { ...value, binding: binding ? { key: binding.key, branch: binding.branch,
    destination: digest({ push: binding.push, merge: binding.merge }) } : null,
    ...(serverPolicy ? { serverPolicyFingerprint: digest(serverPolicy) } : {}),
    ...(localPushHook ? { localPushHookFingerprint: digest(localPushHook) } : {}) }
}

function ticketPolicyCurrent(ticket, root, env) {
  return isLocalBindingCurrent(ticket.binding, { root, env }) &&
    (!ticket.localPushHook || digest(metadata(ticket.localPushHook.file)) === digest(ticket.localPushHook)) &&
    (!ticket.serverPolicy || serverPolicyCurrent(ticket.serverPolicy))
}

function readTicket(dir, id) {
  if (!UUID.test(id ?? "")) throw fault("publication_ticket_invalid")
  const ticket = load(path.join(dir, `${id}.json`), true)
  if (!ticket || ticket.version !== 1 || ticket.id !== id || !OID.test(ticket.targetCommit ?? "") ||
    typeof ticket.root !== "string" || !path.isAbsolute(ticket.root) || !/^[0-9a-f]{64}$/u.test(ticket.rootIdentity ?? "") ||
    !Number.isFinite(ticket.deadline) || !Number.isFinite(Date.parse(ticket.createdAt)) ||
    ticket.deadline - Date.parse(ticket.createdAt) < 1000 || ticket.deadline - Date.parse(ticket.createdAt) > 120000 ||
    !Number.isSafeInteger(ticket.revision) || ticket.revision < 0 || !Array.isArray(ticket.attempts) ||
    (ticket.inspections !== undefined && !Array.isArray(ticket.inspections)) ||
    typeof ticket.resources?.childrenClosed !== "boolean" || !ticket.scope ||
    !["queued", "accepted", "dispatching", "verified", "blocked", "unknown"].includes(ticket.state)) {
    throw fault("publication_ticket_invalid")
  }
  const validOwner = ticket.owner && Number.isSafeInteger(ticket.owner.pid) && ticket.owner.pid > 0 &&
    typeof ticket.owner.start === "string" && ticket.owner.start !== ""
  if ((ticket.owner && !validOwner) || (["accepted", "dispatching", "verified"].includes(ticket.state) && !validOwner)) {
    throw fault("publication_ticket_invalid")
  }
  if (ticket.state === "verified" && (!ticket.resources.childrenClosed || ticket.verification?.remoteCommit !== ticket.targetCommit)) {
    throw fault("publication_ticket_invalid")
  }
  return ticket
}

export function readPublication({ context, id }, retry = true) {
  const owner = contextOf(context)
  const { root, env, person } = owner
  if (captureRecoveryRootIdentity(root) !== owner.rootIdentity) throw fault("publication_root_changed")
  let ticket
  try { ticket = readTicket(directory(root, env), id) }
  catch (error) {
    if (error.code !== "publication_record_changed") throw error
    return { id, state: "unknown", reason: error.code }
  }
  if (ticket.root !== root) throw fault("publication_root_mismatch")
  if (ticket.scope?.person !== person) throw fault("publication_scope_mismatch")
  const value = publicTicket(ticket)
  if (!ticket.binding) return { ...value, state: "unknown", recordedState: ticket.state, reason: "publication_binding_unavailable" }
  const currentRootIdentity = captureRecoveryRootIdentity(root)
  if (currentRootIdentity !== owner.rootIdentity) throw fault("publication_root_changed")
  if (currentRootIdentity !== ticket.rootIdentity) return {
    ...value, state: "unknown", historicalState: ticket.state, reason: "publication_root_changed",
  }
  try {
    const caller = owner.binding ?? capturePublicationAuthority(owner).binding
    if (caller.key !== ticket.binding.key) {
      return { ...value, state: "unknown", historicalState: ticket.state, reason: "publication_caller_binding_changed" }
    }
    if (!isLocalBindingCurrent(caller, { root, env }) ||
      (caller.destinationResolution && digest(destinationResolution(caller.push)) !== digest(caller.destinationResolution))) {
      return { ...value, state: "unknown", historicalState: ticket.state,
        reason: ticketPolicyCurrent(ticket, root, env) ? "publication_caller_binding_changed" : "binding_changed" }
    }
  } catch (error) {
    if (error.code === "publication_root_changed") throw error
    return { ...value, state: "unknown", historicalState: ticket.state,
      reason: "publication_caller_binding_changed", observationError: error.code ?? "binding_validation_unavailable" }
  }
  if (!terminal.has(ticket.state) && ticket.owner) {
    const observed = observeRecoveryProcess(ticket.owner.pid)
    if (observed.state !== "present" || observed.start !== ticket.owner.start) {
      const current = readTicket(directory(root, env), id)
      if (retry && current.revision !== ticket.revision) return readPublication({ context, id }, false)
      return { ...value, state: "unknown", recordedState: ticket.state, reason: observed.state === "absent"
        ? "publication_owner_lost" : observed.state === "present"
          ? "publication_owner_generation_mismatch" : "publication_owner_unverifiable" }
    }
  }
  if (ticket.binding) {
    try {
      if (!ticketPolicyCurrent(ticket, root, env)) {
        return { ...value, state: "unknown", historicalState: ticket.state, reason: "binding_changed" }
      }
    } catch (error) {
      return { ...value, state: "unknown", historicalState: ticket.state, reason: error.code ?? "binding_validation_unavailable" }
    }
  }
  if (ticket.state === "queued") {
    const active = load(path.join(directory(root, env), "active.json"))
    if (active?.retirement?.state === "unknown") {
      return { ...value, state: "unknown", recordedState: ticket.state, reason: active.retirement.reason }
    }
  }
  if (terminal.has(ticket.state)) {
    let current
    try { current = readTicket(directory(root, env), id) }
    catch (error) {
      if (error.code !== "publication_record_changed") throw error
      return { ...value, state: "unknown", recordedState: ticket.state, reason: error.code }
    }
    if (captureRecoveryRootIdentity(root) !== owner.rootIdentity) throw fault("publication_root_changed")
    if (digest(current) !== digest(ticket)) {
      if (retry) return readPublication({ context, id }, false)
      return { ...value, state: "unknown", recordedState: ticket.state, reason: "publication_record_changed" }
    }
  }
  return value
}

function launch({ root, env, dir, id, spawnImpl }) {
  const active = path.join(dir, "active.json")
  const ticketFile = path.join(dir, `${id}.json`)
  let log
  const failed = (error) => {
    const ticket = readTicket(dir, id)
    if (ticket.state !== "queued" || ticket.owner) return
    save(ticketFile, { ...ticket, revision: ticket.revision + 1, state: "blocked", reason: "publication_launch_failed",
      launchError: error?.code ?? null, resources: { childrenClosed: true } })
    consumeNotification(dir, id)
    if (load(active)?.id === id) unlinkSync(active)
  }
  try { publishExclusive(active, { id }) } catch (error) {
    if (error.code === "EEXIST") return
    failed(error)
    return
  }
  try {
    const logName = `${id}.${randomUUID()}.stderr`
    log = openSync(path.join(dir, logName), "wx", 0o600)
    const child = spawnImpl(process.execPath, [SCRIPT, "--root", root, "--publication", id], {
      cwd: root, env, detached: true, windowsHide: true, stdio: ["ignore", "ignore", log],
    })
    child.once("error", failed)
    if (!Number.isSafeInteger(child.pid)) { failed(); return }
    save(active, { id, logName, dispatch: { pid: child.pid } })
    child.unref()
  } catch (error) {
    failed(error)
  } finally { if (log !== undefined) closeSync(log) }
}

export function requestPublication({ context, intent, spawnImpl = spawn }) {
  const owner = contextOf(context)
  const producer = intents.get(intent)
  if (!producer || producer.context !== context) throw fault("publication_intent_invalid")
  if (captureRecoveryRootIdentity(owner.root) !== owner.rootIdentity) throw fault("publication_root_changed")
  const { root, env, sessionId, person } = owner
  if (!ticketPolicyCurrent(producer, root, env)) throw fault("publication_binding_changed")
  const dir = directory(root, env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const key = digest({ targetCommit: producer.targetCommit, person })
  const index = path.join(dir, `${key}.target`)
  const previous = load(index)
  if (previous) {
    const ticket = readTicket(dir, previous.id)
    if (ticket.root !== root) throw fault("publication_root_mismatch")
    if (ticket.scope.person !== person) throw fault("publication_scope_mismatch")
    if (ticket.state === "unknown" || !ticket.binding || ticketPolicyCurrent(ticket, root, env)) {
      if (ticket.state === "queued") notifyQueued(dir, ticket)
      if (ticket.state === "queued" && ticket.deadline > Date.now() && !load(path.join(dir, "active.json"))) {
        launch({ root, env, dir, id: ticket.id, spawnImpl })
      }
      return readPublication({ context, id: ticket.id })
    }
  }
  const id = randomUUID()
  const created = Date.now()
  const ticket = { version: 1, revision: 0, id, root, rootIdentity: owner.rootIdentity, targetCommit: producer.targetCommit,
    scope: { person },
    producer: { sessionId, operationId: producer.producerOperationId }, state: "queued",
    createdAt: new Date(created).toISOString(), deadline: created + owner.lifetimeMs,
    binding: producer.binding, localPushHook: producer.localPushHook, serverPolicy: producer.serverPolicy, owner: null, attempts: [],
    resources: { childrenClosed: true }, verification: null }
  save(path.join(dir, `${id}.json`), ticket)
  save(index, { id })
  notifyQueued(dir, ticket)
  launch({ root, env, dir, id, spawnImpl })
  return publicTicket(readTicket(dir, id))
}

/** Observation only: this never starts another worker, retries a push or cancels accepted work. */
export async function flushPublication({ context, id, timeoutMs = 0 }) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw fault("publication_wait_invalid")
  const deadline = Date.now() + Math.min(timeoutMs, 120000)
  for (;;) {
    const ticket = readPublication({ context, id })
    const incompleteObservation = ticket.state === "unknown" && ticket.recordedState && ticket.reason === "publication_owner_unverifiable"
    if ((terminal.has(ticket.state) && !incompleteObservation) || Date.now() >= deadline) return ticket
    await pause(Math.min(250, Math.max(1, deadline - Date.now())))
  }
}

function local(root, env, args, deadline) {
  const timeout = Math.min(5000, deadline - Date.now())
  if (timeout <= 0) throw fault("publication_deadline")
  const result = spawnSync("git", ["-C", root, ...args], { env, encoding: "utf8", timeout, killSignal: "SIGKILL" })
  if (result.status !== 0) throw fault(result.error?.code ?? "publication_local_inspection_failed")
  return result.stdout.trim()
}

function metadata(file, contents = false) {
  let link
  try {
    link = lstatSync(file)
    const stat = statSync(file)
    return { file, real: realpathSync(file), dev: stat.dev, ino: stat.ino, mode: stat.mode,
      linkDev: link.dev, linkIno: link.ino, ...(contents ? { content: digest(readSmallText(file, 1024 * 1024)) } : {}) }
  } catch (error) {
    if (error.code === "ENOENT" && !link) return { file, absent: true }
    throw error
  }
}

function destinationResolution(route) {
  let original
  if (path.isAbsolute(route)) original = route
  else {
    if (/[\t\n\r]/u.test(route) || /^[\u0000-\u0020]|[\u0000-\u0020]$/u.test(route)) {
      throw fault("publication_destination_input_not_qualified")
    }
    const raw = /^file:\/\/([^/?#]*)(\/[^?#]*)$/u.exec(route)
    if (!raw || !["", "localhost"].includes(raw[1])) throw fault("publication_transport_not_qualified")
    let decoded
    try { decoded = decodeURIComponent(raw[2]) }
    catch (error) {
      if (!(error instanceof URIError)) throw error
      throw fault("publication_destination_traversal_not_qualified")
    }
    if (decoded.includes("\\") || decoded.split("/").some((part) => part === "." || part === "..")) {
      throw fault("publication_destination_traversal_not_qualified")
    }
    const url = new URL(route)
    if (url.protocol !== "file:" || !["", "localhost"].includes(url.hostname) || url.search || url.hash) {
      throw fault("publication_transport_not_qualified")
    }
    original = fileURLToPath(url)
    if (original !== decoded) throw fault("publication_destination_input_not_qualified")
  }
  if (original.split(/[\\/]/u).some((part) => part === "." || part === "..")) {
    throw fault("publication_destination_traversal_not_qualified")
  }
  const absolute = path.resolve(original)
  const parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)
  if (parts.length > 128) throw fault("publication_destination_resolution_unavailable")
  let prefix = path.parse(absolute).root
  const chain = [metadata(prefix)]
  for (const part of parts) { prefix = path.join(prefix, part); chain.push(metadata(prefix)) }
  if (chain.some((entry) => entry.absent)) throw fault("publication_destination_resolution_unavailable")
  return { route, path: absolute, real: realpathSync(absolute), chain }
}

function localServerPolicy(binding, env, deadline) {
  const resolution = destinationResolution(binding.push)
  const remote = resolution.real
  const inspect = (args) => {
    const timeout = Math.min(5000, deadline - Date.now())
    if (timeout <= 0) throw fault("publication_deadline")
    const result = spawnSync("git", [`--git-dir=${remote}`, ...args], { cwd: remote, env,
      encoding: "utf8", timeout, killSignal: "SIGKILL" })
    if (result.status !== 0) throw fault("publication_server_policy_unknown")
    return result.stdout.trim()
  }
  if (inspect(["rev-parse", "--is-bare-repository"]) !== "true") throw fault("publication_server_not_qualified")
  const config = inspect(["config", "--null", "--local", "--list"])
  const unsupportedConfig = config.split("\0").some((entry) => /^(?:include|includeif\.|uploadpack\.packobjectshook)/iu.test(entry))
  const hooks = ["pre-receive", "update", "post-receive", "post-update", "proc-receive", "reference-transaction"].map((name) =>
    metadata(inspect(["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`])))
  const executableHooks = hooks.some((hook) => !hook.absent && Boolean(hook.mode & 0o111))
  const configFile = metadata(path.join(remote, "config"), true)
  const stat = statSync(remote)
  const policy = { root: remote, dev: stat.dev, ino: stat.ino, resolution, hooks, configFile,
    qualified: !unsupportedConfig && !executableHooks,
    reason: executableHooks ? "publication_server_hooks_not_qualified" : unsupportedConfig ? "publication_server_policy_not_qualified" : null }
  if (!serverPolicyCurrent(policy)) throw fault("publication_binding_changed")
  return policy
}

function serverPolicyCurrent(policy) {
  if (!policy.resolution || digest(destinationResolution(policy.resolution.route)) !== digest(policy.resolution)) return false
  const stat = statSync(policy.root)
  return stat.dev === policy.dev && stat.ino === policy.ino &&
    digest(metadata(policy.configFile.file, true)) === digest(policy.configFile) &&
    policy.hooks.every((hook) => digest(metadata(hook.file)) === digest(hook))
}

async function publish({ root, env, dir, ticket, owner, deadline, grantId }) {
  const file = path.join(dir, `${ticket.id}.json`)
  const assertGrant = () => {
    const current = load(path.join(dir, "active.json"), true)
    if (current?.id !== grantId || current.owner?.pid !== owner.pid || current.owner?.start !== owner.start) {
      throw fault("publication_grant_changed")
    }
    if (captureRecoveryRootIdentity(root) !== ticket.rootIdentity) throw fault("publication_root_changed")
  }
  const write = (patch) => {
    assertGrant()
    const current = readTicket(dir, ticket.id)
    if (current.revision !== ticket.revision || current.targetCommit !== ticket.targetCommit) throw fault("publication_revision_changed")
    ticket = { ...ticket, ...patch, revision: ticket.revision + 1, updatedAt: new Date().toISOString() }
    save(file, ticket)
  }
  const run = async (phase, args) => {
    for (let admission = 0; ; admission += 1) {
      assertGrant()
      if (Date.now() >= deadline) throw fault("publication_deadline")
      if (!ticketPolicyCurrent(ticket, root, env)) throw fault("publication_binding_changed")
      if (Date.now() >= deadline) throw fault("publication_deadline")
      const startedAt = new Date().toISOString()
      const result = await runOwnedProcess({ command: "git", args: ["-C", root, ...args], cwd: root, env, deadline,
        ownSignals: true, onResource: (resources) => write({ resources }) })
      if (result.timedOut && result.requestSent === undefined && result.status === null &&
        !result.cancelled && !result.outputTruncated && !result.error && !result.spawnError &&
        result.resources.childrenClosed && result.resources.childPid == null && Date.now() >= deadline) {
        throw fault("publication_deadline")
      }
      const pregrant = result.requestSent === false
      write({ resources: result.resources, attempts: [...ticket.attempts, {
        phase: pregrant ? "admission" : phase, requestedPhase: phase, admission: admission + 1, status: result.status,
        startedAt, completedAt: new Date().toISOString(), remainingMs: deadline - Date.now(),
        requestSent: result.requestSent, error: result.error ?? result.spawnError ?? null,
        cancelled: result.cancelled, outputTruncated: result.outputTruncated, timedOut: result.timedOut,
        resources: result.resources, stderr: redactCredentialLikeText(result.stderr).slice(0, 1000) }] })
      if (!result.resources.childrenClosed) throw fault("publication_closure_unknown")
      if (result.cancelled) throw fault("publication_cancelled")
      if (result.outputTruncated) throw fault("publication_output_truncated")
      // Identity/group refusals and unclassified watchdog exits are not retry authority.
      const recoverableAdmission = ["grant_not_received", "native_owner_unavailable"].includes(result.error)
      if (!pregrant || !recoverableAdmission || admission !== 0 || result.cancelled || Date.now() + 1000 >= deadline) return result
      if (!ticketPolicyCurrent(ticket, root, env)) throw fault("publication_binding_changed")
      await pause(250)
    }
  }
  const inspect = async (phase, args, validate) => {
    const inspectionLimit = Date.now() + 5000
    const inspectionDeadline = Math.min(deadline, inspectionLimit)
    const deadlineCause = deadline < inspectionLimit ? "publication"
      : deadline === inspectionLimit ? "ambiguous" : "inspection"
    const timeoutCode = deadlineCause === "publication" ? "publication_deadline" : "ETIMEDOUT"
    assertGrant()
    if (Date.now() >= inspectionDeadline) throw fault(timeoutCode)
    if (!ticketPolicyCurrent(ticket, root, env)) throw fault("publication_binding_changed")
    for (let admission = 0; ; admission += 1) {
      assertGrant()
      if (Date.now() >= inspectionDeadline) throw fault(timeoutCode)
      if (!ticketPolicyCurrent(ticket, root, env)) throw fault("publication_binding_changed")
      if (Date.now() >= inspectionDeadline) throw fault(timeoutCode)
      const startedAt = new Date().toISOString()
      const result = await runOwnedProcess({ command: "git", args: ["-C", root, ...args], cwd: root, env,
        deadline: inspectionDeadline, ownSignals: true, onResource: (resources) => write({ resources }) })
      if (result.timedOut && result.requestSent === undefined && result.status === null &&
        !result.cancelled && !result.outputTruncated && !result.error && !result.spawnError &&
        result.resources.childrenClosed && result.resources.childPid == null) throw fault(timeoutCode)
      write({ resources: result.resources, inspections: [...(ticket.inspections ?? []), {
        phase, admission: admission + 1, startedAt, completedAt: new Date().toISOString(), deadline: inspectionDeadline,
        deadlineCause,
        status: result.status, error: result.error ?? result.spawnError ?? null, timedOut: result.timedOut,
        cancelled: result.cancelled, outputTruncated: result.outputTruncated,
        requestSent: result.requestSent, resources: result.resources,
        stderr: redactCredentialLikeText(result.stderr).slice(0, 1000),
      }] })
      if (!result.resources.childrenClosed) throw fault("publication_closure_unknown")
      if (result.cancelled) throw fault("publication_cancelled")
      if (result.outputTruncated) throw fault("publication_local_inspection_failed")
      if (admission === 0 && result.requestSent === false &&
        ["grant_not_received", "native_owner_unavailable"].includes(result.error) &&
        Date.now() + 1000 < inspectionDeadline) {
        await pause(250)
        continue
      }
      if (result.error === "deadline" && result.timedOut && result.status === null && !result.spawnError) throw fault(timeoutCode)
      if (result.error || result.spawnError) throw fault("publication_local_inspection_failed")
      validate(result)
      if (result.timedOut || Date.now() >= inspectionDeadline) throw fault(timeoutCode)
      return result
    }
  }
  const checkedInspection = async (phase, args, validate) => {
    const result = await inspect(phase, args, (observed) => {
      if (observed.status !== 0) throw fault("publication_local_inspection_failed")
      validate(observed.stdout.trim())
    })
    return result.stdout.trim()
  }
  try {
    write({ state: "accepted", owner, acceptedAt: ticket.acceptedAt ?? new Date().toISOString() })
    const binding = ticket.binding
    if (!binding || !ticketPolicyCurrent(ticket, root, env)) throw fault("publication_binding_changed")
    if (binding.nothingToSync) throw fault("publication_no_upstream")
    if (!path.isAbsolute(binding.push) && !binding.push.startsWith("file://")) throw fault("publication_transport_not_qualified")
    const localPushHook = ticket.localPushHook
    if (!binding.referenceHook.qualified || (!localPushHook.absent && Boolean(localPushHook.mode & 0o111))) {
      throw fault("publication_hooks_not_qualified")
    }
    await checkedInspection("configuration", ["config", "--null", "--list"], (config) => {
      if (config.split("\0").some((entry) => /^(?:remote\.pushdefault|branch\..*\.pushremote|remote\..*\.(?:push|uploadpack|receivepack|vcs|proxy))\n/iu.test(entry))) {
        throw fault("publication_push_policy_not_qualified")
      }
    })
    await checkedInspection("target", ["cat-file", "-t", ticket.targetCommit], (type) => {
      if (type !== "commit") throw fault("publication_target_not_commit")
    })
    await inspect("lfs", ["grep", "-I", "-l", "^version https://git-lfs.github.com/spec/v1$", ticket.targetCommit, "--"], (lfs) => {
      if (![0, 1].includes(lfs.status)) throw fault("publication_lfs_inspection_unknown")
      if (lfs.status === 0) throw fault("publication_lfs_not_qualified")
    })
    const serverPolicy = ticket.serverPolicy
    if (!serverPolicy) throw fault("publication_server_policy_unknown")
    if (!serverPolicy.qualified) throw fault(serverPolicy.reason)
    const current = () => isLocalBindingCurrent(binding, { root, env }) && serverPolicyCurrent(serverPolicy) &&
      digest(metadata(localPushHook.file)) === digest(localPushHook)
    const readback = async (phase) => {
      if (!current()) throw fault("publication_binding_changed")
      const observed = await run(phase, ["ls-remote", "--heads", "--exit-code", "--", serverPolicy.root, binding.merge])
      if (observed.status !== 0) throw fault("publication_remote_observation_unknown")
      const fields = observed.stdout.trim().split(/\s+/u)
      if (fields.length !== 2 || !OID.test(fields[0]) || fields[1] !== binding.merge) throw fault("publication_remote_observation_invalid")
      return fields[0]
    }
    const before = await readback("before")
    if (before === ticket.targetCommit) {
      if (!current()) throw fault("publication_binding_changed")
      const observation = ticket.attempts.at(-1)
      write({ state: "verified", verification: { remoteCommit: before, at: new Date().toISOString(),
        bindingKey: binding.key, observation: { phase: "before", startedAt: observation.startedAt, completedAt: observation.completedAt } } })
      return ticket
    }
    if (before !== ticket.targetCommit) {
      const ref = `refs/desk-publication/${ticket.id}/remote`
      const fetched = await run("graph", ["fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--recurse-submodules=no",
        "--", serverPolicy.root, `${binding.merge}:${ref}`])
      if (fetched.status !== 0) throw fault("publication_graph_unknown")
      await checkedInspection("private-ref", ["rev-parse", ref], (actual) => {
        if (actual !== before) throw fault("publication_remote_changed")
      })
      await inspect("dependency", ["merge-base", "--is-ancestor", before, ticket.targetCommit], (ancestor) => {
        if (ancestor.status === 1) throw fault("publication_dependency_not_fast_forward")
        if (ancestor.status !== 0) throw fault("publication_dependency_unknown")
      })
      if (!current()) throw fault("publication_binding_changed")
      write({ state: "dispatching", beforeCommit: before })
      await run("push", ["push", "--quiet", "--", serverPolicy.root, `${ticket.targetCommit}:${binding.merge}`])
    }
    const remoteCommit = await readback("after")
    if (remoteCommit !== ticket.targetCommit) throw fault("publication_effect_unknown")
    if (!current()) throw fault("publication_binding_changed")
    const observation = ticket.attempts.at(-1)
    write({ state: "verified", verification: { remoteCommit, at: new Date().toISOString(), bindingKey: binding.key,
      observation: { phase: "after", startedAt: observation.startedAt, completedAt: observation.completedAt } } })
  } catch (error) {
    const dispatched = ticket.attempts.some((attempt) => attempt.phase === "push" && attempt.requestSent)
    if (error.code === "publication_deadline" && Date.now() >= deadline && ticket.deadline > Date.now() &&
      ticket.attempts.length === 0 && ticket.resources.childrenClosed &&
      (ticket.inspections ?? []).every((inspection) => inspection.resources.childrenClosed)) {
      write({ state: "queued", owner: null, reason: "publication_owner_retired_before_dispatch",
        retiredOwner: { ...owner, deadline, at: new Date().toISOString() } })
    } else {
      write({ state: !ticket.resources.childrenClosed || dispatched ? "unknown" : "blocked", reason: error.code ?? "publication_failed" })
    }
  }
  return ticket
}

async function* publicationTickets(dir, deadline, { pending = false, elapsedDeadline = Infinity } = {}) {
  const folder = pending ? path.join(dir, "pending") : dir
  const entries = opendirSync(folder)
  let visited = 0
  try {
    for (;;) {
      if (Date.now() >= deadline || performance.now() >= elapsedDeadline) throw fault("publication_inventory_incomplete")
      const entry = entries.readSync()
      if (!entry) return
      if (++visited % 256 === 0) await pause(0)
      if (entry.name.endsWith(".json") && UUID.test(entry.name.slice(0, -5))) {
        const ticket = readTicket(dir, entry.name.slice(0, -5))
        if (pending) {
          const notification = load(path.join(folder, entry.name))
          if (!notification || notification.id !== ticket.id || notification.deadline !== ticket.deadline ||
            notification.rootIdentity !== ticket.rootIdentity || notification.bindingKey !== ticket.binding.key) {
            throw fault("publication_pending_notification_changed")
          }
        }
        yield ticket
      }
    }
  } finally { entries.closeSync() }
}

async function firstQueuedTicket(dir, deadline, elapsedDeadline = Infinity) {
  for await (const ticket of publicationTickets(dir, deadline, { pending: true, elapsedDeadline })) {
    if (ticket.state === "queued" && ticket.deadline > Date.now()) return ticket
    if (terminal.has(ticket.state) && ticket.resources.childrenClosed) consumeNotification(dir, ticket.id)
  }
  return null
}

/** Existing worker mode, independently finite; only this accepted owner releases its active record. */
export async function runPublicationWorker({ root, env = process.env, id }) {
  const dir = directory(root, env), active = path.join(dir, "active.json"), entered = Date.now()
  let grant = load(active)
  while (grant?.id === id && !grant.dispatch && Date.now() - entered < 5000) {
    await pause(10)
    grant = load(active)
  }
  if (grant?.id !== id || grant.dispatch?.pid !== process.pid) return
  const start = await readProcessStart(process.pid)
  if (!start || start.includes("unknown-boot")) return
  const currentGrant = load(active)
  if (currentGrant?.id !== id || currentGrant.dispatch?.pid !== process.pid) return
  const owner = { pid: process.pid, start }, deadline = readTicket(dir, id).deadline
  save(active, { ...grant, owner, acceptedAt: new Date().toISOString() })
  const { acquireSyncLock } = await import("./sync-worker.js")
  let lock
  let retirementProved = false
  let custodyUnknown = false
  try {
    while (Date.now() < deadline) {
      const recovery = readRecoveryStatus({ root, env })
      if (recovery?.state === "unknown") break
      lock = await acquireSyncLock({ root, env })
      if (lock && !lock.refused) break
      if (lock?.refused) break
      await pause(50)
    }
    if (!lock || lock.refused) {
      const ticket = readTicket(dir, id)
      save(path.join(dir, `${id}.json`), { ...ticket, revision: ticket.revision + 1, state: "blocked",
        reason: Date.now() >= deadline ? "publication_deadline" : "publication_custody_unavailable",
        owner, resources: { childrenClosed: true } })
      return
    }
    for (;;) {
      let allClosed = true
      for await (const ticket of publicationTickets(dir, deadline)) {
        if (ticket.state !== "queued") {
          allClosed &&= ticket.resources.childrenClosed
          continue
        }
        if (Date.now() + 1000 >= deadline) return
        const result = await publish({ root, env, dir, ticket, owner, deadline: Math.min(deadline, ticket.deadline), grantId: id })
        if (!result.resources.childrenClosed) { custodyUnknown = true; return }
        if (result.state === "queued") return
        consumeNotification(dir, ticket.id)
      }
      if (!allClosed) { custodyUnknown = true; return }
      retirementProved = true
      if (Date.now() + 1000 >= deadline) break
      if (load(active)?.id === id) unlinkSync(active)
      const remaining = await firstQueuedTicket(dir, deadline)
      if (!remaining || Date.now() >= deadline) break
      try { publishExclusive(active, { ...grant, owner }) } catch (error) {
        if (error.code === "EEXIST") break
        throw error
      }
      retirementProved = false
    }
  } finally {
    // Retirement only observes scheduling/custody; it cannot extend the old ticket's native deadline.
    const elapsedDeadline = performance.now() + 1000
    const retain = (reason) => {
      const current = load(active)
      if (current && (current.id !== id || current.owner?.pid !== owner.pid || current.owner?.start !== owner.start)) return
      const retained = { ...grant, owner, retirement: { state: "unknown", reason } }
      if (current) save(active, retained)
      else {
        try { publishExclusive(active, retained) }
        catch (error) { if (error.code !== "EEXIST") throw error }
      }
    }
    try {
      const current = load(active)
      const ownsGrant = !current || (current.id === id && current.owner?.pid === owner.pid && current.owner?.start === owner.start)
      if (ownsGrant) {
        if (custodyUnknown) retain("publication_retirement_custody_unknown")
        else {
          let allClosed = retirementProved
          if (!allClosed) {
            allClosed = true
            for await (const ticket of publicationTickets(dir, Infinity, { elapsedDeadline })) allClosed &&= ticket.resources.childrenClosed
          }
          if (!allClosed) retain("publication_retirement_custody_unknown")
          else {
            if (load(active)?.id === id) unlinkSync(active)
            const next = await firstQueuedTicket(dir, Infinity, elapsedDeadline)
            if (next?.id === id) retain("publication_retirement_admission_unknown")
            else if (next) launch({ root, env, dir, id: next.id, spawnImpl: spawn })
          }
        }
      }
    } catch (error) {
      retain(error.code ?? "publication_retirement_observation_unavailable")
      throw error
    } finally { lock?.release?.() }
  }
}

const FIRST_MONITORS = new WeakMap()
const FIRST_REFERENCE_PASSES = new WeakMap()
const FIRST_COMPLETE_CAPTURES = new WeakMap()
const FIRST_SYSTEM_INPUTS = new WeakMap()
const FIRST_SYSTEM_RECORDS = new WeakMap()
const FIRST_OPERATION_ENVIRONMENTS = new WeakMap()
const FIRST_OPERATION_ENV_LINKS = new WeakMap()
const firstEnvDigest = env => digest(Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
function firstOperationClock({ operationId, createdAtMs, producerDeadline, publicationDeadline }) {
  if (typeof operationId !== "string" || !operationId || !Number.isSafeInteger(createdAtMs) || createdAtMs < 0 ||
    createdAtMs > Date.now() || producerDeadline !== createdAtMs + 10000 ||
    publicationDeadline !== createdAtMs + 60000) throw fault("producer_operation_environment_required")
  firstDeadline(producerDeadline)
}
function firstMacSelectors(env) {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string") throw fault(key === "DEVELOPER_DIR" ? "producer_selector_unqualified" : "producer_invocation_unqualified")
  }
  if (Object.keys(env).some(key => /^(?:SDKROOT$|TOOLCHAINS$|GIT_EXEC_PATH$|LD_|DYLD_|xcrun_(?:nocache|log|verbose)$)/u.test(key))) {
    throw fault("producer_invocation_unqualified")
  }
}
function firstDeveloperSelection({ value, deadline }) {
  firstDeadline(deadline)
  if (typeof value !== "string" || !value || !path.isAbsolute(value) || value !== path.normalize(value) ||
    /[\0\r\n]/u.test(value) || value.split("/").some(part => part === "." || part === "..") ||
    Buffer.from(value, "utf8").toString("utf8") !== value) {
    throw fault("producer_selector_unqualified")
  }
  const developerPath = value.endsWith(".app") ? path.join(value, "Contents/Developer") : value
  const developerRoot = firstIO(deadline, () => realpathSync(developerPath))
  if (!developerRoot.endsWith("/Contents/Developer")) throw fault("producer_selector_unqualified")
  const records = new Map()
  for (const file of [developerPath, developerRoot]) {
    const parts = file.split("/").filter(Boolean)
    if (parts.length > 128) throw fault("producer_selector_unqualified")
    let prefix = "/"
    for (const part of ["", ...parts]) {
      if (part) prefix = path.join(prefix, part)
      const stat = firstIO(deadline, () => lstatSync(prefix, EXACT))
      const epoch = (stat.mode & 0o170000n) === 0o120000n
      const record = { path: prefix, directory: true, epoch,
        proof: firstFileProof({ path: prefix, directory: true, epoch, deadline }) }
      if (record.proof.absent) throw fault("producer_selector_unqualified")
      records.set(prefix, record)
    }
  }
  return { developerRoot, records: [...records.values()] }
}
function firstRegisterOperationEnvironment({ context, env, data, selection, imported }) {
  const owner = contextOf(context)
  firstDeadline(data.producerDeadline)
  if (firstRootIdentity({ root: owner.root, deadline: data.producerDeadline }) !== owner.rootIdentity) throw fault("publication_root_changed")
  firstMacSelectors(owner.env)
  const base = { ...env }
  if (data.source === "snapshot") delete base.DEVELOPER_DIR
  const contextEnvDigest = firstEnvDigest(owner.env)
  if (firstEnvDigest(env) !== data.envDigest || env.DEVELOPER_DIR !== data.value ||
    firstEnvDigest(base) !== data.baseEnvDigest ||
    contextEnvDigest !== (imported ? data.envDigest : data.baseEnvDigest)) {
    throw fault(imported ? "producer_operation_environment_required" : "publication_scope_changed")
  }
  if (imported) {
    firstMacSelectors(process.env)
    if (Object.keys(env).some(key => process.env[key] !== env[key])) throw fault("producer_operation_environment_required")
  }
  firstDeadline(data.producerDeadline)
  const operationEnvironment = Object.freeze(Object.create(null))
  const effectiveEnv = Object.freeze({ ...env })
  FIRST_OPERATION_ENVIRONMENTS.set(operationEnvironment, { active: true, context, contextEnvDigest,
    env: effectiveEnv, data: Object.freeze({ ...data }), records: selection.records, imported })
  FIRST_OPERATION_ENV_LINKS.set(effectiveEnv, operationEnvironment)
  return operationEnvironment
}
export async function prepareFirstOperationEnvironment({ context, operationId, createdAtMs, producerDeadline, publicationDeadline }) {
  const owner = contextOf(context), clock = { operationId, createdAtMs, producerDeadline, publicationDeadline }
  firstOperationClock(clock)
  if (typeof process === "undefined" || process.platform !== "darwin") return null
  const base = Object.freeze({ ...owner.env }), baseEnvDigest = firstEnvDigest(base)
  if (firstInvocationLookup({ env: base, deadline: producerDeadline }).executable !== "/usr/bin/git") return null
  firstMacSelectors(base)
  if (contextOf(context) !== owner || firstEnvDigest(owner.env) !== baseEnvDigest) throw fault("publication_scope_changed")
  if (firstRootIdentity({ root: owner.root, deadline: producerDeadline }) !== owner.rootIdentity) throw fault("publication_root_changed")
  let value = base.DEVELOPER_DIR, source = "inherited"
  if (!Object.hasOwn(base, "DEVELOPER_DIR")) {
    source = "snapshot"
    const result = await runOwnedProcess({ command: "/usr/bin/xcode-select", args: ["--print-path"],
      cwd: owner.root, env: { ...base }, deadline: Math.min(producerDeadline, Date.now() + 5000),
      inspection: true, capture: true, ownSignals: true })
    const resources = result.resources, watchdog = resources?.watchdog
    const knownStart = value => typeof value === "string" &&
      /^darwin:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) && Number.isFinite(Date.parse(value.slice(7)))
    const closed = resources?.childrenClosed === true && resources.exitObserved === true && resources.resultReceived === true &&
      resources.scope === "native-owner" && resources.phase === "closed" &&
      Number.isSafeInteger(resources.childPid) && resources.childPid > 0 && resources.group === resources.childPid &&
      knownStart(resources.start) && Number.isSafeInteger(watchdog?.pid) && watchdog.pid > 0 &&
      watchdog.pid !== resources.childPid && watchdog.group === resources.group && knownStart(watchdog.start) &&
      resources.inventory?.known === true && Array.isArray(resources.inventory.members) && resources.inventory.members.length === 0
    try { firstDeadline(producerDeadline) }
    catch (error) { error.selector_observation = result; throw error }
    if (result.status !== 0 || result.error || result.spawnError || result.signal || result.stderr !== "" ||
      result.requestSent !== true || result.timedOut !== false || result.cancelled !== false ||
      result.outputTruncated !== false || !closed || typeof result.stdout !== "string" ||
      !result.stdout.endsWith("\n") || /[\0\r\n]/u.test(result.stdout.slice(0, -1))) {
      const error = fault("producer_selector_observation_unqualified")
      error.selector_observation = result
      throw error
    }
    value = result.stdout.slice(0, -1)
  }
  if (contextOf(context) !== owner || firstEnvDigest(owner.env) !== baseEnvDigest) throw fault("publication_scope_changed")
  if (firstRootIdentity({ root: owner.root, deadline: producerDeadline }) !== owner.rootIdentity) throw fault("publication_root_changed")
  const selection = firstDeveloperSelection({ value, deadline: producerDeadline }), env = { ...base, DEVELOPER_DIR: value }
  const data = { version: 1, ...clock, source, value, developerRoot: selection.developerRoot,
    baseEnvDigest, envDigest: firstEnvDigest(env) }
  firstDeadline(producerDeadline)
  return firstRegisterOperationEnvironment({ context, env, data, selection, imported: false })
}
/** Called only in the existing authenticated live owner/executor grant branches. */
export function registerTransferredFirstOperationEnvironment({ context, selection: data, expectedDigest,
  operationId, createdAtMs, producerDeadline, publicationDeadline }) {
  const owner = contextOf(context), clock = { operationId, createdAtMs, producerDeadline, publicationDeadline }
  firstOperationClock(clock)
  if (!data || digest(data) !== expectedDigest || data.version !== 1 ||
    Object.keys(data).sort().join(",") !== ["version", ...Object.keys(clock), "source", "value", "developerRoot",
      "baseEnvDigest", "envDigest"].sort().join(",") ||
    Object.keys(clock).some(key => data[key] !== clock[key]) || !["snapshot", "inherited"].includes(data.source) ||
    firstEnvDigest(owner.env) !== data.envDigest || owner.env.DEVELOPER_DIR !== data.value ||
    typeof process === "undefined" || process.platform !== "darwin" || process.env.DEVELOPER_DIR !== data.value ||
    Object.keys(owner.env).some(key => process.env[key] !== owner.env[key])) {
    throw fault("producer_operation_environment_required")
  }
  firstMacSelectors(owner.env)
  firstMacSelectors(process.env)
  const base = { ...owner.env }
  if (data.source === "snapshot") delete base.DEVELOPER_DIR
  if (firstEnvDigest(base) !== data.baseEnvDigest) throw fault("producer_operation_environment_required")
  const selection = firstDeveloperSelection({ value: data.value, deadline: producerDeadline })
  if (selection.developerRoot !== data.developerRoot) throw fault("producer_currentness_changed")
  return firstRegisterOperationEnvironment({ context, env: owner.env, data, selection, imported: true })
}
export function closeFirstOperationEnvironment(operationEnvironment) {
  const value = FIRST_OPERATION_ENVIRONMENTS.get(operationEnvironment)
  if (!value) throw fault("producer_operation_environment_required")
  value.active = false
}
function firstAssertOperationLive(operationEnvironment, deadline) {
  const value = FIRST_OPERATION_ENVIRONMENTS.get(operationEnvironment)
  if (!value?.active || value.data.producerDeadline !== deadline) throw fault("producer_operation_environment_required")
  firstDeadline(deadline)
  const owner = contextOf(value.context)
  firstMacSelectors(owner.env)
  if (firstEnvDigest(owner.env) !== value.contextEnvDigest ||
    value.imported && Object.keys(value.env).some(key => process.env[key] !== value.env[key])) throw fault("publication_scope_changed")
  if (value.imported) firstMacSelectors(process.env)
  firstDeadline(deadline)
  return value
}
function firstOperationView({ context, operationEnvironment, operationId, producerDeadline }) {
  const owner = contextOf(context)
  if (operationEnvironment === null || operationEnvironment === undefined) return owner
  const value = firstAssertOperationLive(operationEnvironment, producerDeadline)
  if (value.context !== context || value.data.operationId !== operationId) throw fault("producer_operation_environment_required")
  scanFirstSaveFootprint({ footprint: { records: value.records }, deadline: producerDeadline })
  return { ...owner, env: value.env }
}
function firstDeadline(deadline) {
  if (!Number.isFinite(deadline) || Date.now() >= deadline) throw fault("producer_deadline")
}
function firstIO(deadline, work) {
  firstDeadline(deadline)
  const value = work()
  firstDeadline(deadline)
  return value
}
function deriveFirstSystemInput({ file, purpose, deadline }) {
  firstDeadline(deadline)
  if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/u.test(file) ||
    !["advertised-git", "git-helper-entry"].includes(purpose)) throw fault("producer_system_input_role_required")
  const input = Object.freeze(Object.create(null))
  FIRST_SYSTEM_INPUTS.set(input, { file, purpose, deadline })
  return input
}
function firstSystemRole(input, deadline) {
  const role = FIRST_SYSTEM_INPUTS.get(input)
  if (!role || role.deadline !== deadline) throw fault("producer_system_input_role_required")
  return role
}
function firstSystemVersion(stat, directory = false) {
  const keys = directory ? ["dev", "ino", "mode", "uid", "gid"]
    : ["dev", "ino", "mode", "uid", "gid", "nlink", "size", "mtimeNs", "ctimeNs"]
  if (keys.some(key => typeof stat[key] !== "bigint") ||
    !directory && (stat.size < 0n || stat.nlink < 1n)) throw fault("producer_system_input_unqualified")
  return Object.fromEntries(keys.map(key => [key, String(stat[key])]))
}
function firstSystemInputIdentity({ input, deadline }) {
  const { file } = firstSystemRole(input, deadline), pathLinks = []
  let current = "/", remaining = file.split("/").filter(Boolean), targetVersion, steps = 0, links = 0
  const retain = (file, stat) => {
    const directory = stat.isDirectory(), version = firstSystemVersion(stat, directory)
    const entry = { file, version }
    if ((stat.mode & 0o170000n) === 0o120000n) entry.link = firstIO(deadline, () => readlinkSync(file))
    pathLinks.push(entry)
    return entry
  }
  retain(current, firstIO(deadline, () => lstatSync(current, EXACT)))
  while (remaining.length) {
    firstDeadline(deadline)
    if (++steps > 128) throw fault("producer_system_input_unqualified")
    const part = remaining.shift()
    if (part === ".") continue
    if (part === "..") { current = path.dirname(current); continue }
    const candidate = path.join(current, part), stat = firstIO(deadline, () => lstatSync(candidate, EXACT))
    const entry = retain(candidate, stat)
    if (entry.link !== undefined) {
      if (++links > 40 || typeof entry.link !== "string" || !entry.link || /[\0\r\n]/u.test(entry.link)) {
        throw fault("producer_system_input_unqualified")
      }
      if (path.isAbsolute(entry.link)) current = "/"
      remaining = [...entry.link.split("/").filter(Boolean), ...remaining]
    } else {
      if (remaining.length && !stat.isDirectory()) throw fault("producer_system_input_unqualified")
      current = candidate
      if (!remaining.length) {
        if (!stat.isFile()) throw fault("producer_system_input_unqualified")
        targetVersion = firstSystemVersion(stat)
      }
    }
  }
  if (!targetVersion || firstIO(deadline, () => realpathSync(file)) !== current) throw fault("producer_system_input_changed")
  firstDeadline(deadline)
  return { pathLinks, real: current, targetVersion }
}
function firstMachStructure(bytes, fileSize, deadline) {
  const refuse = () => { throw fault("producer_invocation_unqualified") }
  if (bytes.length < 32 || bytes.readUInt32LE(0) !== 0xfeedfacf || bytes.readUInt32LE(12) !== 2 ||
    bytes.readUInt32LE(28) !== 0) refuse()
  const cpu = bytes.readUInt32LE(4), expectedCpu = process.arch === "arm64" ? 0x100000c : process.arch === "x64" ? 0x1000007 : null
  const count = bytes.readUInt32LE(16), tableBytes = bytes.readUInt32LE(20)
  if (cpu !== expectedCpu || !count || count > 1024 || tableBytes < count * 8 || tableBytes + 32 !== bytes.length) refuse()
  const platformLibraries = new Set(["/usr/lib/libSystem.B.dylib", "/usr/lib/libz.1.dylib", "/usr/lib/libiconv.2.dylib",
    "/System/Library/Frameworks/CoreFoundation.framework/Versions/A/CoreFoundation",
    "/System/Library/Frameworks/CoreServices.framework/Versions/A/CoreServices"])
  const metadata = new Map([[2, 24], [0xb, 80], [0x1b, 24], [0x1d, 16], [0x24, 16],
    [0x26, 16], [0x29, 16], [0x2a, 16], [0x2b, 16], [0x80000022, 48], [0x80000033, 16], [0x80000034, 16]])
  const dependencies = [], executable = []
  let offset = 32, loader = null, entry = null
  for (let index = 0; index < count; index++) {
    firstDeadline(deadline)
    if (offset + 8 > bytes.length) refuse()
    const type = bytes.readUInt32LE(offset), size = bytes.readUInt32LE(offset + 4)
    if (size < 8 || size % 8 || offset + size > bytes.length) refuse()
    if ([0xc, 0x80000018, 0x8000001f, 0xe].includes(type)) {
      const minimum = type === 0xe ? 12 : 24
      if (size < minimum) refuse()
      const start = bytes.readUInt32LE(offset + 8), end = bytes.indexOf(0, offset + start)
      if (start < minimum || start >= size || end < 0 || end >= offset + size) refuse()
      const raw = bytes.subarray(offset + start, end)
      if (!raw.length || raw.length > 128) refuse()
      const name = raw.toString("utf8")
      if (!Buffer.from(name).equals(raw)) refuse()
      if (type === 0xe) { if (loader !== null || name !== "/usr/lib/dyld") refuse(); loader = name }
      else { if (!platformLibraries.has(name)) refuse(); dependencies.push(name) }
    } else if (type === 0x19) {
      if (size < 72 || 72 + bytes.readUInt32LE(offset + 64) * 80 !== size) refuse()
      const fileOffset = bytes.readBigUInt64LE(offset + 40), length = bytes.readBigUInt64LE(offset + 48)
      if (fileOffset + length > fileSize || length > bytes.readBigUInt64LE(offset + 32)) refuse()
      if ((bytes.readUInt32LE(offset + 60) & 4) !== 0) executable.push({ start: fileOffset, end: fileOffset + length })
    } else if (type === 0x80000028) {
      if (size !== 24 || entry !== null) refuse()
      entry = bytes.readBigUInt64LE(offset + 8)
    } else if (type === 0x32) {
      if (size < 24 || bytes.readUInt32LE(offset + 8) !== 1 || size !== 24 + bytes.readUInt32LE(offset + 20) * 8) refuse()
    } else if (!metadata.has(type) || size < metadata.get(type)) refuse()
    offset += size
  }
  if (offset !== bytes.length || !loader || !dependencies.length || entry === null ||
    !executable.some(range => entry >= range.start && entry < range.end)) refuse()
  firstDeadline(deadline)
  return { format: "Mach64", cpu, commandCount: count, commandBytes: tableBytes, loader, dependencies: dependencies.sort() }
}
function hashFirstSystemImage({ input, deadline }) {
  const role = firstSystemRole(input, deadline), { file, purpose } = role, hash = createHash("sha256")
  let identity, fd, primary, byteCount = 0n, closed = false, prefixSize = 0, mach64 = null
  try {
    if (role.machOperation) firstAssertOperationLive(role.machOperation, deadline)
    identity = firstSystemInputIdentity({ input, deadline })
    if (role.machOperation) firstAssertOperationLive(role.machOperation, deadline)
    firstDeadline(deadline)
    fd = openSync(identity.real, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    firstDeadline(deadline)
    const before = firstIO(deadline, () => fstatSync(fd, EXACT))
    if (!before.isFile() || digest(firstSystemVersion(before)) !== digest(identity.targetVersion)) {
      throw fault("producer_system_input_changed")
    }
    const bytes = Buffer.alloc(65536), expectedSize = before.size
    while (true) {
      firstDeadline(deadline)
      if (role.machOperation) firstAssertOperationLive(role.machOperation, deadline)
      const offset = role.machOperation && !mach64 ? prefixSize : 0
      const count = readSync(fd, bytes, offset, bytes.length - offset, null)
      if (!Number.isInteger(count) || count < 0 || count > bytes.length - offset) throw fault("producer_system_input_unqualified")
      byteCount += BigInt(count)
      hash.update(bytes.subarray(offset, offset + count))
      firstDeadline(deadline)
      if (role.machOperation) firstAssertOperationLive(role.machOperation, deadline)
      if (byteCount > expectedSize || count === 0 && byteCount !== expectedSize) throw fault("producer_system_input_changed")
      if (role.machOperation && !mach64) {
        prefixSize += count
        if (prefixSize >= 32) {
          const end = 32 + bytes.readUInt32LE(20)
          if (end > bytes.length || end < 32) throw fault("producer_invocation_unqualified")
          if (prefixSize >= end) mach64 = firstMachStructure(bytes.subarray(0, end), expectedSize, deadline)
        }
        if (!mach64 && (count === 0 || prefixSize === bytes.length)) throw fault("producer_invocation_unqualified")
      }
      if (count === 0) break
    }
    const after = firstIO(deadline, () => fstatSync(fd, EXACT))
    if (!after.isFile() || digest(firstSystemVersion(after)) !== digest(identity.targetVersion) ||
      digest(firstSystemInputIdentity({ input, deadline })) !== digest(identity)) throw fault("producer_system_input_changed")
    if (role.machOperation) firstAssertOperationLive(role.machOperation, deadline)
    firstDeadline(deadline)
  } catch (error) { primary = error }
  if (fd !== undefined) {
    try { closeSync(fd); closed = true }
    catch (error) {
      if (primary) primary.close_error = { code: error.code ?? "producer_witness_close_unknown" }
      else primary = error
    }
  }
  let witness
  try {
    if (!primary) {
      firstDeadline(deadline)
      if (role.machOperation) firstAssertOperationLive(role.machOperation, deadline)
      witness = { kind: "readonly-system-image", file, purpose, ...identity,
        byteCount: String(byteCount), sha256: hash.copy().digest("hex"), complete: true,
        ...(mach64 ? { mach64 } : {}) }
      firstDeadline(deadline)
    }
  } catch (error) { primary = error }
  if (primary) {
    primary.system_input_observation = { file, purpose, byteCount: String(byteCount), complete: false,
      partialSha256: hash.copy().digest("hex") }
    if (fd !== undefined) primary.witness_resource = { path: identity.real, descriptor: fd, closed }
    throw primary
  }
  return witness
}
function compareFirstSystemImage({ input, expected, deadline }) {
  const current = hashFirstSystemImage({ input, deadline })
  const equal = digest(current) === digest(expected)
  firstDeadline(deadline)
  return equal
}
function firstSystemRecord({ file, purpose, deadline, operationEnvironment }) {
  const input = deriveFirstSystemInput({ file, purpose, deadline })
  if (operationEnvironment !== undefined) {
    if (!FIRST_OPERATION_ENVIRONMENTS.get(operationEnvironment)?.active || purpose !== "git-helper-entry") {
      throw fault("producer_operation_environment_required")
    }
    FIRST_SYSTEM_INPUTS.get(input).machOperation = operationEnvironment
  }
  const record = { path: file, contents: false, binary: true, systemImage: true,
    proof: hashFirstSystemImage({ input, deadline }) }
  FIRST_SYSTEM_RECORDS.set(record, input)
  return record
}
function firstRecordInput(record, deadline) {
  const input = FIRST_SYSTEM_RECORDS.get(record)
  if (!input && !record.systemImage && record.proof?.kind !== "readonly-system-image") return null
  const role = firstSystemRole(input, deadline)
  if (record.path !== role.file || record.contents !== false || record.binary !== true || record.systemImage !== true ||
    record.directory || record.epoch) throw fault("producer_system_input_role_required")
  return input
}
function firstRecordProof(record, deadline) {
  const input = firstRecordInput(record, deadline)
  return input ? hashFirstSystemImage({ input, deadline }) : firstFileProof({ path: record.path,
    contents: record.contents, binary: record.binary, directory: record.directory, epoch: record.epoch, deadline })
}
function copyFirstRecord(record, proof = record.proof) {
  const copy = { ...record, proof }, input = FIRST_SYSTEM_RECORDS.get(record)
  if (input) FIRST_SYSTEM_RECORDS.set(copy, input)
  return copy
}
function copyFirstFootprint(footprint) {
  const copy = JSON.parse(JSON.stringify(footprint))
  copy.records = footprint.records.map((record, index) => copyFirstRecord(record, copy.records[index].proof))
  return copy
}
function readFirstWitness({ path: file, limit, deadline, binary = false }) {
  const before = firstIO(deadline, () => lstatSync(file, EXACT))
  if (!before.isFile() || before.nlink !== 1n || before.size > limit) throw fault("producer_witness_unqualified")
  let fd, value, primary, closed = false
  try {
    firstDeadline(deadline)
    fd = openSync(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    firstDeadline(deadline)
    const stat = firstIO(deadline, () => fstatSync(fd, EXACT))
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > limit || !sameFile(stat, before)) throw fault("producer_witness_unqualified")
    const bytes = Buffer.alloc(limit + 1)
    const size = firstIO(deadline, () => readSync(fd, bytes, 0, bytes.length, 0))
    if (size > limit) throw fault("producer_witness_unqualified")
    const after = firstIO(deadline, () => fstatSync(fd, EXACT))
    const atPath = firstIO(deadline, () => lstatSync(file, EXACT))
    const unchanged = (left, right) => ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(key => left[key] === right[key])
    if (!atPath.isFile() || atPath.nlink !== 1n || !unchanged(stat, after) || !unchanged(after, atPath)) throw fault("producer_witness_unqualified")
    value = binary ? Buffer.from(bytes.subarray(0, size)) : bytes.toString("utf8", 0, size)
  } catch (error) { primary = error }
  if (fd !== undefined) {
    try { closeSync(fd); closed = true }
    catch (error) {
      if (primary) primary.close_error = { code: error.code ?? "producer_witness_close_unknown" }
      else primary = error
    }
  }
  if (primary) {
    if (fd !== undefined) primary.witness_resource = { path: file, descriptor: fd, closed }
    throw primary
  }
  firstDeadline(deadline)
  return value
}
function firstFileProof({ path: file, contents = false, binary = false, directory = false, epoch = false, deadline }) {
  let before
  try { before = firstIO(deadline, () => lstatSync(file, EXACT)) }
  catch (error) {
    if (error.code === "ENOENT" && !before) { firstDeadline(deadline); return { file, contents, absent: true } }
    throw error
  }
  const real = firstIO(deadline, () => realpathSync(file))
  const keys = directory && !epoch ? ["dev", "ino", "mode"] : ["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"]
  const version = stat => Object.fromEntries(keys.map(key => [key, String(stat[key])]))
  if (directory && !firstIO(deadline, () => statSync(real, EXACT)).isDirectory()) throw fault("producer_witness_unqualified")
  const proof = { file, contents, real, version: version(before) }
  if (contents) proof.sha256 = digest(readFirstWitness({ path: real, limit: 1024 * 1024, deadline }))
  if (binary) {
    if (contents || directory) throw fault("producer_witness_unqualified")
    proof.binary = true
    proof.sha256 = createHash("sha256").update(readFirstWitness({ path: real, limit: 1024 * 1024, deadline, binary: true })).digest("hex")
  }
  const after = firstIO(deadline, () => lstatSync(file, EXACT))
  if (digest(version(after)) !== digest(proof.version) ||
    firstIO(deadline, () => realpathSync(file)) !== real) throw fault("producer_currentness_changed")
  firstDeadline(deadline)
  return proof
}
function scanFirstSaveFootprint({ footprint, deadline }) {
  firstDeadline(deadline)
  if (!footprint || !Array.isArray(footprint.records)) throw fault("producer_currentness_unqualified")
  for (const record of footprint.records) {
    firstDeadline(deadline)
    const input = firstRecordInput(record, deadline)
    const equal = input ? compareFirstSystemImage({ input, expected: record.proof, deadline })
      : digest(firstRecordProof(record, deadline)) === digest(record.proof)
    if (!equal) throw fault("producer_currentness_changed")
  }
  firstDeadline(deadline)
}
function inspectFirstReference({ root, env, args, gitDir = null, footprint, captureEpochs = null, deadline }) {
  const envDigest = () => digest(Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
  const check = () => {
    firstDeadline(deadline)
    const operationEnvironment = FIRST_OPERATION_ENV_LINKS.get(env)
    if (operationEnvironment) firstAssertOperationLive(operationEnvironment, deadline)
    if (!footprint?.envDigest || envDigest() !== footprint.envDigest) throw fault("producer_currentness_changed")
    scanFirstSaveFootprint({ footprint, deadline })
    if (captureEpochs) scanFirstSaveFootprint({ footprint: captureEpochs, deadline })
    if (operationEnvironment) firstAssertOperationLive(operationEnvironment, deadline)
    firstDeadline(deadline)
  }
  check()
  const timeout = Math.min(5000, deadline - Date.now())
  firstDeadline(deadline)
  const argv = gitDir ? [`--git-dir=${gitDir}`, ...args] : ["-C", root, ...args]
  const result = spawnSync("git", argv, { cwd: gitDir ?? root, env: { ...env }, encoding: "utf8", timeout, killSignal: "SIGKILL" })
  firstDeadline(deadline)
  check()
  if (result.status !== 0 || result.error || result.signal || typeof result.stdout !== "string") {
    const error = fault("producer_initial_inspection_failed")
    error.inspection = { argv, timeout, status: result.status, signal: result.signal ?? null,
      code: result.error?.code ?? null, stdoutHash: digest(result.stdout ?? ""), stderrHash: digest(result.stderr ?? "") }
    throw error
  }
  firstDeadline(deadline)
  return result
}
function sealFirstReferencePass({ root, env, discovered, deadline }) {
  firstDeadline(deadline)
  if (!discovered || !Array.isArray(discovered.records) || !Array.isArray(discovered.queries) ||
    !discovered.records.length || !discovered.queries.length ||
    (discovered.unresolvedDependencies !== undefined &&
      (!Array.isArray(discovered.unresolvedDependencies) || discovered.unresolvedDependencies.length !== 0))) {
    throw fault("producer_currentness_unqualified")
  }
  const envDigest = digest(Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
  if (envDigest !== discovered.envDigest) throw fault("producer_currentness_changed")
  // Provisional discovery must match the inputs sealed before the reference pass.
  scanFirstSaveFootprint({ footprint: discovered, deadline })
  const records = []
  for (const record of discovered.records) {
    firstDeadline(deadline)
    const proof = firstRecordProof(record, deadline)
    if (digest(proof) !== digest(record.proof)) throw fault("producer_currentness_changed")
    records.push(copyFirstRecord(record, proof))
  }
  const footprint = { records, envDigest,
    ...(discovered.operationSelection ? { operationSelection: { ...discovered.operationSelection } } : {}) }
  const observations = []
  for (const query of discovered.queries) {
    firstDeadline(deadline)
    if (!Array.isArray(query.args) || query.args.some(arg => typeof arg !== "string") ||
      typeof query.stdout !== "string") throw fault("producer_currentness_unqualified")
    const result = inspectFirstReference({ root, env, args: query.args, gitDir: query.gitDir,
      footprint, captureEpochs: discovered.captureEpochs, deadline })
    if (result.stdout !== query.stdout) throw fault("producer_currentness_changed")
    observations.push({ args: [...query.args], gitDir: query.gitDir ?? null, stdout: result.stdout })
  }
  scanFirstSaveFootprint({ footprint, deadline })
  if (discovered.captureEpochs) scanFirstSaveFootprint({ footprint: discovered.captureEpochs, deadline })
  firstDeadline(deadline)
  const sealed = { footprint, observations }
  FIRST_REFERENCE_PASSES.set(sealed, { root, deadline, envDigest,
    footprint: copyFirstFootprint(footprint) })
  return sealed
}
function firstConfigInputs({ root, env, output, deadline }) {
  firstDeadline(deadline)
  if (typeof output !== "string" || (output !== "" && !output.endsWith("\0"))) throw fault("producer_currentness_unqualified")
  const tokens = output === "" ? [] : output.slice(0, -1).split("\0")
  if (tokens.length % 2 !== 0) throw fault("producer_currentness_unqualified")
  const inputs = new Map()
  const resolve = (file, origin = root) => {
    firstDeadline(deadline)
    if (!file || /[\0\r\n]/u.test(file) || /^(?:~[^/]|%\()/u.test(file)) throw fault("producer_currentness_unqualified")
    if (file.startsWith("~/")) {
      if (typeof env.HOME !== "string" || !path.isAbsolute(env.HOME)) throw fault("producer_currentness_unqualified")
      return path.resolve(env.HOME, file.slice(2))
    }
    return path.resolve(origin, file)
  }
  for (let index = 0; index < tokens.length; index += 2) {
    firstDeadline(deadline)
    const origin = tokens[index], entry = tokens[index + 1], split = entry.indexOf("\n")
    if (!origin.startsWith("file:") || split < 1) throw fault("producer_currentness_unqualified")
    const file = resolve(origin.slice(5)), key = entry.slice(0, split), value = entry.slice(split + 1)
    inputs.set(file, { path: file, contents: true, origin: true })
    if (/^(?:include|includeif\..*)\.path$/iu.test(key)) {
      if (/^includeif\./iu.test(key) &&
        !/^(?:gitdir:|gitdir\/i:|onbranch:|hasconfig:remote\.\*\.url:)/iu.test(key.slice("includeif.".length, -".path".length))) {
        throw fault("producer_currentness_unqualified")
      }
      const target = resolve(value, path.dirname(file))
      if (!inputs.has(target)) inputs.set(target, { path: target, contents: true, declaredInclude: true })
    }
    if (inputs.size > 64) throw fault("producer_currentness_unqualified")
  }
  firstDeadline(deadline)
  return [...inputs.values()]
}
function firstGitResolution({ root, env, deadline }) {
  firstDeadline(deadline)
  const marker = path.join(root, ".git")
  const markerStat = firstIO(deadline, () => statSync(marker, EXACT))
  const markerFile = markerStat.isFile()
  if (!markerFile && !markerStat.isDirectory()) throw fault("producer_currentness_unqualified")
  const markerText = markerFile ? readFirstWitness({ path: marker, limit: 64 * 1024, deadline }) : null
  const pointer = markerText?.trim() ?? null
  if (markerFile && (!pointer.startsWith("gitdir: ") || !pointer.slice(8))) throw fault("producer_currentness_unqualified")
  const directory = file => {
    const real = firstIO(deadline, () => realpathSync(file))
    const stat = firstIO(deadline, () => statSync(real, EXACT))
    if (!stat.isDirectory()) throw fault("producer_currentness_unqualified")
    return { real, dev: String(stat.dev), ino: String(stat.ino) }
  }
  const admin = directory(env.GIT_DIR ? path.resolve(root, env.GIT_DIR)
    : markerFile ? path.resolve(root, pointer.slice(8)) : marker)
  const commonPointer = path.join(admin.real, "commondir")
  const commonFile = firstFileProof({ path: commonPointer, contents: true, deadline })
  const commonText = commonFile.absent ? null : readFirstWitness({ path: commonPointer, limit: 64 * 1024, deadline })
  if (commonText !== null && digest(commonText) !== commonFile.sha256) throw fault("producer_currentness_changed")
  const common = directory(env.GIT_COMMON_DIR ? path.resolve(root, env.GIT_COMMON_DIR)
    : commonFile.absent ? admin.real : path.resolve(admin.real, commonText.trim()))
  const markerProof = markerFile ? firstFileProof({ path: marker, contents: true, deadline }) : directory(marker)
  if (markerFile && markerProof.sha256 !== digest(markerText)) throw fault("producer_currentness_changed")
  firstDeadline(deadline)
  return { marker: markerProof, admin, commonFile, common }
}
function firstConfigDefaultInputs({ env, admin, common, globalPaths, systemPaths, deadline }) {
  firstDeadline(deadline)
  const noSystem = /^(?:1|true|yes|on)$/iu.test(env.GIT_CONFIG_NOSYSTEM ?? "")
  if (env.GIT_CONFIG_NOSYSTEM !== undefined && !/^(?:0|1|true|false|yes|no|on|off)$/iu.test(env.GIT_CONFIG_NOSYSTEM)) {
    throw fault("producer_currentness_unqualified")
  }
  if (!path.isAbsolute(admin ?? "") || !path.isAbsolute(common ?? "") ||
    typeof env.HOME !== "string" || !path.isAbsolute(env.HOME) ||
    !Array.isArray(globalPaths) || (!noSystem && !Array.isArray(systemPaths))) {
    throw fault("producer_currentness_unqualified")
  }
  const files = new Set([path.join(common, "config"), path.join(admin, "config.worktree")])
  const add = file => {
    firstDeadline(deadline)
    if (typeof file !== "string" || !path.isAbsolute(file) || /[\0\r\n]/u.test(file)) throw fault("producer_currentness_unqualified")
    files.add(file)
  }
  if (env.GIT_CONFIG_GLOBAL) add(env.GIT_CONFIG_GLOBAL)
  else {
    add(path.join(env.HOME, ".gitconfig"))
    const xdg = env.XDG_CONFIG_HOME || path.join(env.HOME, ".config")
    if (!path.isAbsolute(xdg)) throw fault("producer_currentness_unqualified")
    add(path.join(xdg, "git", "config"))
  }
  for (const file of globalPaths) add(file)
  if (!noSystem) {
    if (env.GIT_CONFIG_SYSTEM) add(env.GIT_CONFIG_SYSTEM)
    for (const file of systemPaths) add(file)
  }
  if (files.size > 64) throw fault("producer_currentness_unqualified")
  firstDeadline(deadline)
  return [...files].map(file => ({ path: file, contents: true, defaultScope: true }))
}

function discoverFirstConfigClosure({ root, env, initialOutput, defaults, deadline }) {
  firstDeadline(deadline)
  if (!Array.isArray(defaults)) throw fault("producer_currentness_unqualified")
  const envDigest = digest(Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
  const records = new Map(), queries = [], pending = [...firstConfigInputs({ root, env, output: initialOutput, deadline }), ...defaults]
  const epochs = new Map()
  const captureLookup = () => {
    const current = firstLookupEpochs({ records: [...records.values()], deadline })
    for (const record of current.records) {
      const held = epochs.get(record.path)
      if (held && digest(held.proof) !== digest(record.proof)) throw fault("producer_currentness_changed")
      if (!held) epochs.set(record.path, record)
    }
  }
  const queried = new Set()
  for (let index = 0; index < pending.length; index++) {
    firstDeadline(deadline)
    const input = pending[index]
    if (typeof input?.path !== "string" || !path.isAbsolute(input.path)) throw fault("producer_currentness_unqualified")
    if (records.has(input.path)) continue
    if (records.size >= 64) throw fault("producer_currentness_unqualified")
    const proof = firstFileProof({ path: input.path, contents: true, deadline })
    records.set(input.path, { path: input.path, contents: true, proof })
  }
  captureLookup()
  for (;;) {
    firstDeadline(deadline)
    const current = [...records.values()].find(record => !record.proof.absent && !queried.has(record.path))
    if (!current) break
    const args = ["config", "--file", current.path, "--null", "--show-origin", "--list", "--no-includes"]
    const result = inspectFirstReference({ root, env, args, footprint: { records: [...records.values()], envDigest },
      captureEpochs: { records: [...epochs.values()] }, deadline })
    queried.add(current.path)
    queries.push({ args, gitDir: null, stdout: result.stdout })
    for (const input of firstConfigInputs({ root, env, output: result.stdout, deadline })) {
      firstDeadline(deadline)
      if (records.has(input.path)) continue
      if (records.size >= 64) throw fault("producer_currentness_unqualified")
      const proof = firstFileProof({ path: input.path, contents: true, deadline })
      records.set(input.path, { path: input.path, contents: true, proof })
    }
    captureLookup()
  }
  scanFirstSaveFootprint({ footprint: { records: [...records.values()], envDigest }, deadline })
  firstDeadline(deadline)
  scanFirstSaveFootprint({ footprint: { records: [...epochs.values()] }, deadline })
  return { records: [...records.values()], queries, envDigest, captureEpochs: { records: [...epochs.values()] } }
}

function firstLookupEpochs({ records, deadline }) {
  firstDeadline(deadline)
  if (!Array.isArray(records)) throw fault("producer_currentness_unqualified")
  const epochs = new Map()
  for (const record of records) {
    firstDeadline(deadline)
    if (typeof record.path !== "string" || !path.isAbsolute(record.path)) throw fault("producer_currentness_unqualified")
    let current = path.dirname(record.path)
    for (let depth = 0; ; depth++) {
      firstDeadline(deadline)
      if (depth >= 128) throw fault("producer_currentness_unqualified")
      const proof = firstFileProof({ path: current, directory: true, epoch: true, deadline })
      if (!proof.absent) {
        epochs.set(current, { path: current, contents: false, directory: true, epoch: true, proof })
        if (proof.real !== current) {
          const realProof = firstFileProof({ path: proof.real, directory: true, epoch: true, deadline })
          epochs.set(proof.real, { path: proof.real, contents: false, directory: true, epoch: true, proof: realProof })
        }
      }
      const parent = path.dirname(current)
      if (parent === current) {
        if (proof.absent) throw fault("producer_currentness_unqualified")
        break
      }
      current = parent
    }
  }
  firstDeadline(deadline)
  return { records: [...epochs.values()] }
}

function firstLegacyFileProof({ file, contents, deadline }) {
  const proof = firstFileProof({ path: file, contents, deadline })
  if (proof.absent) return { file, contents, absent: true }
  return { file, contents, real: proof.real, version: proof.version,
    ...(contents ? { sha256: proof.sha256 } : {}) }
}

function firstRootIdentity({ root, deadline }) {
  const stat = firstIO(deadline, () => statSync(root, EXACT))
  const marker = path.join(root, ".git")
  const gitStat = firstIO(deadline, () => statSync(marker, EXACT))
  const gitFile = gitStat.isFile() ? readFirstWitness({ path: marker, limit: 64 * 1024, deadline }) : null
  const canonical = firstIO(deadline, () => realpathSync(root))
  firstDeadline(deadline)
  return digest({ root: canonical, dev: Number(stat.dev), ino: Number(stat.ino),
    gitDev: Number(gitStat.dev), gitIno: Number(gitStat.ino), gitFile })
}

function firstPolicyInputs(env) {
  const git = Object.fromEntries(Object.keys(env).filter(key => key.startsWith("GIT_")).sort().map(key => [key, env[key]]))
  return digest({ git, home: env.HOME ?? null, xdg: env.XDG_CONFIG_HOME ?? null,
    activation: resolveStartupActivationConfigPath({ env }),
    declared: env.DESK_ACTIVATION_CONFIG ?? env.DESK_ACTIVATION_ID ?? null })
}

function firstInvocationLookup({ env, deadline }) {
  firstDeadline(deadline)
  if (typeof env.PATH !== "string" || !env.PATH) throw fault("producer_invocation_unqualified")
  const directories = env.PATH.split(path.delimiter)
  if (!directories.length || directories.length > 128 || directories.some(file =>
    !file || !path.isAbsolute(file) || /[\0\r\n]/u.test(file))) throw fault("producer_invocation_unqualified")
  const records = []
  for (const directory of directories) {
    firstDeadline(deadline)
    const executable = path.join(directory, "git")
    const metadata = firstFileProof({ path: executable, deadline })
    if (metadata.absent) {
      records.push({ path: executable, contents: false, proof: metadata })
      continue
    }
    if ((Number(metadata.version.mode) & 0o111) === 0) throw fault("producer_invocation_unqualified")
    firstIO(deadline, () => accessSync(executable, constants.X_OK))
    records.push(firstSystemRecord({ file: executable, purpose: "advertised-git", deadline }))
    firstDeadline(deadline)
    return { executable, records, implementationQualified: false }
  }
  throw fault("producer_invocation_unqualified")
}

function discoverFirstInvocation({ root, env, deadline, operationEnvironment }) {
  const lookup = firstInvocationLookup({ env, deadline })
  const mac = typeof process !== "undefined" && process.platform === "darwin" && lookup.executable === "/usr/bin/git"
  const operation = mac ? FIRST_OPERATION_ENVIRONMENTS.get(operationEnvironment) : null
  if (mac && !operation?.active) throw fault("producer_operation_environment_required")
  if (mac) firstMacSelectors(env)
  const envDigest = digest(Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
  const records = [...lookup.records], queries = []
  const captureEpochs = firstLookupEpochs({ records, deadline })
  const inspect = args => {
    const result = inspectFirstReference({ root, env, args, footprint: { records, envDigest }, captureEpochs, deadline })
    queries.push({ args, gitDir: null, stdout: result.stdout })
    return result.stdout
  }
  const version = inspect(["--version"])
  if (!/^git version [^\r\n]+\n$/u.test(version)) throw fault("producer_invocation_unqualified")
  const rawExecPath = inspect(["--exec-path"])
  if (!rawExecPath.endsWith("\n") || rawExecPath.slice(0, -1).includes("\n") ||
    !path.isAbsolute(rawExecPath.slice(0, -1))) throw fault("producer_invocation_unqualified")
  const execPath = rawExecPath.slice(0, -1)
  const helper = path.join(execPath, "git")
  if (mac && execPath !== path.join(operation.data.developerRoot, "usr/libexec/git-core")) throw fault("producer_invocation_unqualified")
  const helperRecord = firstSystemRecord({ file: helper, purpose: "git-helper-entry", deadline,
    ...(mac ? { operationEnvironment } : {}) })
  const selected = firstIO(deadline, () => statSync(lookup.executable, EXACT))
  const implementation = firstIO(deadline, () => statSync(helper, EXACT))
  if (mac) {
    if (helperRecord.proof.real !== path.join(operation.data.developerRoot, "usr/bin/git") || !helperRecord.proof.mach64) {
      throw fault("producer_invocation_unqualified")
    }
    records.push(...operation.records)
    const alternative = path.join(operation.data.developerRoot, "Toolchains/XcodeDefault.xctoolchain/usr/bin/git")
    const alternativeProof = firstFileProof({ path: alternative, deadline })
    if (!alternativeProof.absent) throw fault("producer_invocation_unqualified")
    records.push({ path: alternative, contents: false, proof: alternativeProof })
  } else if (!sameFile(selected, implementation)) throw fault("producer_invocation_unqualified")
  if (!records.some(record => record.path === helper && record.binary)) records.push(helperRecord)
  const completeEpochs = firstLookupEpochs({ records, deadline })
  for (const prior of captureEpochs.records) {
    const current = completeEpochs.records.find(record => record.path === prior.path)
    if (!current || digest(current.proof) !== digest(prior.proof)) throw fault("producer_currentness_changed")
  }
  scanFirstSaveFootprint({ footprint: { records, envDigest }, deadline })
  scanFirstSaveFootprint({ footprint: completeEpochs, deadline })
  firstDeadline(deadline)
  return { executable: lookup.executable, execPath, version, records, queries, envDigest,
    captureEpochs: completeEpochs, executionImageMatched: true,
    implementationQualified: mac || firstDirectInvocationEligible({ executable: lookup.executable, env, deadline }) }
}

function firstDirectInvocationEligible({ executable, env, deadline }) {
  firstDeadline(deadline)
  // Dynamic loaders and implementation selectors need their own complete provenance.
  if (Object.keys(env).some(key => /^(?:LD_|DYLD_|GIT_EXEC_PATH$|DEVELOPER_DIR$|SDKROOT$|XCRUN_)/u.test(key))) return false
  const stat = firstIO(deadline, () => lstatSync(executable, EXACT))
  if (!stat.isFile() || stat.nlink !== 1n || stat.size > 1024n * 1024n) return false
  const image = readFirstWitness({ path: executable, limit: 1024 * 1024, deadline, binary: true })
  if (image.length < 64 || image.subarray(0, 7).toString("hex") !== "7f454c46020101" ||
    image[7] !== 0 || image[8] !== 0 || image.readUInt16LE(16) !== 2 ||
    ![62, 183].includes(image.readUInt16LE(18)) || image.readUInt32LE(20) !== 1 ||
    image.readUInt16LE(52) !== 64 || image.readUInt16LE(54) !== 56) return false
  const table = image.readBigUInt64LE(32), count = image.readUInt16LE(56), entry = image.readBigUInt64LE(24)
  if (!count || count === 0xffff || table < 64n || table + BigInt(count) * 56n > BigInt(image.length)) return false
  let executableEntry = false
  for (let index = 0; index < count; index++) {
    firstDeadline(deadline)
    const offset = Number(table) + index * 56, type = image.readUInt32LE(offset), flags = image.readUInt32LE(offset + 4)
    if (type === 2 || type === 3) return false
    const fileOffset = image.readBigUInt64LE(offset + 8), address = image.readBigUInt64LE(offset + 16)
    const fileSize = image.readBigUInt64LE(offset + 32), memorySize = image.readBigUInt64LE(offset + 40)
    if (fileSize > memorySize || fileOffset + fileSize > BigInt(image.length)) return false
    if (type === 1 && (flags & 1) !== 0 && entry >= address && entry < address + fileSize) executableEntry = true
  }
  firstDeadline(deadline)
  return executableEntry
}

function validateFirstReferenceOutputs({ root, resolution, destination = null, observations, deadline }) {
  firstDeadline(deadline)
  const fail = () => { throw fault("producer_currentness_unqualified") }
  if (!Array.isArray(observations)) fail()
  const matching = (args, gitDir = null) => {
    firstDeadline(deadline)
    return observations.filter(value => (value.gitDir ?? null) === gitDir && digest(value.args) === digest(args))
  }
  const one = (args, gitDir = null) => {
    const values = matching(args, gitDir)
    if (values.length !== 1 || typeof values[0].stdout !== "string") fail()
    return values[0].stdout
  }
  const top = one(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"])
    .trim().split("\n")
  if (top.length !== 3 || top[0] !== root || top[1] !== resolution?.admin?.real || top[2] !== resolution?.common?.real) fail()
  const branch = one(["symbolic-ref", "--quiet", "HEAD"]).trim()
  if (!branch.startsWith("refs/heads/") || /[\0\r\n]/u.test(branch)) fail()
  const repeated = args => {
    const rows = matching(args)
    if (rows.length !== 2 || typeof rows[0].stdout !== "string" || rows[0].stdout !== rows[1].stdout) fail()
    return rows[0].stdout
  }
  const config = repeated(["config", "--null", "--list"])
  const configOrigins = repeated(["config", "--null", "--show-origin", "--list"])
  if (config !== "" && !config.endsWith("\0")) fail()
  const values = new Map()
  for (const entry of config.split("\0").filter(Boolean)) {
    firstDeadline(deadline)
    const split = entry.indexOf("\n")
    if (split < 1) fail()
    const key = entry.slice(0, split), value = entry.slice(split + 1)
    const previous = values.get(key) ?? []
    values.set(key, [...previous, value])
  }
  const singleConfig = key => {
    const rows = values.get(key)
    if (!rows || rows.length !== 1) fail()
    return rows[0]
  }
  const route = text => {
    if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || !text.slice(0, -1) ||
      /^[\u0000-\u0020]|[\u0000-\u0020]$/u.test(text.slice(0, -1))) fail()
    return text.slice(0, -1)
  }
  const pathOutput = (args, gitDir = null) => {
    const value = route(one(args, gitDir))
    if (!path.isAbsolute(value)) fail()
    return value
  }
  const referenceHook = pathOutput(["rev-parse", "--path-format=absolute", "--git-path", "hooks/reference-transaction"])
  const localPushHook = pathOutput(["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"])
  const globalPaths = one(["var", "GIT_CONFIG_GLOBAL"]).trim().split("\n").filter(Boolean)
  if (globalPaths.some(file => !path.isAbsolute(file))) fail()
  const name = branch.slice("refs/heads/".length)
  const remote = values.has(`branch.${name}.remote`) ? singleConfig(`branch.${name}.remote`) : null
  const merge = values.has(`branch.${name}.merge`) ? singleConfig(`branch.${name}.merge`) : null
  if (!remote || !merge || remote === "." || !merge.startsWith("refs/heads/")) {
    const hasRemote = [...values.keys()].some(key => /^remote\..+\.url$/u.test(key))
    firstDeadline(deadline)
    return { branch, config, configOrigins, referenceHook, localPushHook, globalPaths,
      nothingToSync: !remote && !hasRemote ? "no_remote" : "no_upstream" }
  }
  const fetch = route(one(["remote", "get-url", "--all", remote]))
  const pushRows = matching(["remote", "get-url", "--push", "--all", remote])
  if (pushRows.length !== 2 || pushRows[0].stdout !== pushRows[1].stdout) fail()
  const push = route(pushRows[0].stdout)
  const serverRoot = destination ? destination.real : push
  if ((destination && destination.route !== push) || !path.isAbsolute(serverRoot) ||
    (!path.isAbsolute(push) && !destination)) fail()
  if (!path.isAbsolute(push)) {
    const fileRoute = /^file:\/\/([^/?#]*)(\/[^?#]*)$/u.exec(push)
    if (!fileRoute || !["", "localhost"].includes(fileRoute[1])) fail()
    let decoded
    try { decoded = decodeURIComponent(fileRoute[2]) } catch { fail() }
    if (decoded.includes("\\") || decoded.split("/").some(part => part === "." || part === "..") ||
      /[\0\r\n\t]/u.test(decoded)) fail()
  }
  if (one(["rev-parse", "--is-bare-repository"], serverRoot).trim() !== "true") fail()
  const serverConfig = one(["config", "--null", "--local", "--list"], serverRoot)
  if (serverConfig !== "" && !serverConfig.endsWith("\0")) fail()
  const serverHooks = []
  for (const hook of ["pre-receive", "update", "post-receive", "post-update", "proc-receive", "reference-transaction"]) {
    firstDeadline(deadline)
    serverHooks.push(pathOutput(["rev-parse", "--path-format=absolute", "--git-path", `hooks/${hook}`], serverRoot))
  }
  firstDeadline(deadline)
  return { branch, remote, merge, fetch, push, serverRoot, config, configOrigins, referenceHook, localPushHook, globalPaths, serverConfig, serverHooks }
}

function captureFirstAuthorityQueries({ root, env, resolution, destination = null, footprint, captureEpochs = null, deadline }) {
  const observations = []
  const inspect = (args, gitDir = null) => {
    const result = inspectFirstReference({ root, env, args, gitDir, footprint, captureEpochs, deadline })
    observations.push({ args, gitDir, stdout: result.stdout })
    return result.stdout
  }
  const oneValue = (text, key) => {
    const rows = text.split("\0").filter(value => value.startsWith(`${key}\n`))
    if (rows.length > 1) throw fault("producer_currentness_unqualified")
    return rows.length ? rows[0].slice(key.length + 1) : null
  }
  inspect(["rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir"])
  const branch = inspect(["symbolic-ref", "--quiet", "HEAD"]).trim()
  if (!branch.startsWith("refs/heads/") || /[\0\r\n]/u.test(branch)) throw fault("producer_currentness_unqualified")
  const config = inspect(["config", "--null", "--list"])
  inspect(["rev-parse", "--path-format=absolute", "--git-path", "hooks/reference-transaction"])
  const name = branch.slice("refs/heads/".length)
  const remote = oneValue(config, `branch.${name}.remote`), merge = oneValue(config, `branch.${name}.merge`)
  const routed = remote && merge?.startsWith("refs/heads/") && remote !== "."
  if (routed) {
    inspect(["remote", "get-url", "--all", remote])
    inspect(["remote", "get-url", "--push", "--all", remote])
  }
  inspect(["config", "--null", "--show-origin", "--list"])
  inspect(["var", "GIT_CONFIG_GLOBAL"])
  if (!/^(?:1|true|yes|on)$/iu.test(env.GIT_CONFIG_NOSYSTEM ?? "")) inspect(["var", "GIT_CONFIG_SYSTEM"])
  inspect(["config", "--null", "--list"])
  inspect(["config", "--null", "--show-origin", "--list"])
  let push
  if (routed) {
    const raw = inspect(["remote", "get-url", "--push", "--all", remote])
    if (!raw.endsWith("\n") || raw.slice(0, -1).includes("\n") || !raw.slice(0, -1)) throw fault("producer_currentness_unqualified")
    push = raw.slice(0, -1)
  }
  inspect(["rev-parse", "--path-format=absolute", "--git-path", "hooks/pre-push"])
  let actualDestination = destination
  if (routed) {
    actualDestination ??= firstDestinationResolution({ route: push, deadline })
    if (actualDestination.route !== push || !path.isAbsolute(actualDestination.real)) throw fault("producer_currentness_unqualified")
    const server = actualDestination.real
    inspect(["rev-parse", "--is-bare-repository"], server)
    inspect(["config", "--null", "--local", "--list"], server)
    for (const name of ["pre-receive", "update", "post-receive", "post-update", "proc-receive", "reference-transaction"]) {
      firstDeadline(deadline)
      inspect(["rev-parse", "--path-format=absolute", "--git-path", `hooks/${name}`], server)
    }
  }
  const reference = validateFirstReferenceOutputs({ root, resolution, destination: actualDestination, observations, deadline })
  firstDeadline(deadline)
  return { observations, reference, destination: actualDestination }
}

function firstCaptureInputRecords({ root, env, resolution, reference, configRecords, invocationRecords, systemPaths, deadline }) {
  firstDeadline(deadline)
  if (!Array.isArray(configRecords) || !Array.isArray(invocationRecords) ||
    !resolution?.admin?.real || !resolution?.common?.real || !reference?.branch) throw fault("producer_currentness_unqualified")
  if (digest(firstGitResolution({ root, env, deadline })) !== digest(resolution)) throw fault("producer_currentness_changed")
  const records = new Map()
  const keyOf = record => JSON.stringify({ path: record.path, contents: record.contents === true,
    binary: record.binary === true, directory: record.directory === true })
  const retain = record => {
    firstDeadline(deadline)
    const key = keyOf(record), current = firstRecordProof(record, deadline)
    if (record.proof && digest(current) !== digest(record.proof)) throw fault("producer_currentness_changed")
    records.set(key, copyFirstRecord(record, current))
  }
  const add = (file, contents = false, directory = false) => {
    if (typeof file !== "string" || !path.isAbsolute(file)) throw fault("producer_currentness_unqualified")
    retain({ path: file, contents, directory })
  }
  for (const record of [...configRecords, ...invocationRecords]) retain(record)
  add(root, false, true)
  const marker = path.join(root, ".git")
  const markerFile = firstIO(deadline, () => statSync(marker, EXACT)).isFile()
  add(marker, markerFile, !markerFile)
  add(resolution.admin.real, false, true)
  add(resolution.common.real, false, true)
  add(path.join(resolution.admin.real, "commondir"), true)
  add(path.join(resolution.admin.real, "HEAD"), true)
  for (const file of firstConfigDefaultInputs({ env, admin: resolution.admin.real, common: resolution.common.real,
    globalPaths: reference.globalPaths, systemPaths, deadline })) add(file.path, true)
  add(reference.referenceHook, true)
  add(reference.localPushHook, true)
  if (reference.serverRoot) {
    add(reference.serverRoot, false, true)
    add(path.join(reference.serverRoot, "config"), true)
    if (!Array.isArray(reference.serverHooks)) throw fault("producer_currentness_unqualified")
    for (const file of reference.serverHooks) add(file, true)
  }
  if (digest(firstGitResolution({ root, env, deadline })) !== digest(resolution)) throw fault("producer_currentness_changed")
  firstDeadline(deadline)
  return [...records.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)))
}

// This observes a sealed input set; it is not a complete policy or execution grant.
function retainFirstInputObservation({ context, sealed, operationId, producerDeadline, operationEnvironment }) {
  const owner = firstOperationView({ context, operationEnvironment, operationId, producerDeadline }), pass = FIRST_REFERENCE_PASSES.get(sealed)
  firstDeadline(producerDeadline)
  if (!pass || pass.deadline !== producerDeadline || pass.root !== owner.root ||
    typeof operationId !== "string" || !operationId ||
    digest(Object.fromEntries(Object.entries(owner.env).sort(([a], [b]) => a.localeCompare(b)))) !== pass.envDigest) {
    throw fault("producer_currentness_unqualified")
  }
  if (firstRootIdentity({ root: owner.root, deadline: producerDeadline }) !== owner.rootIdentity) throw fault("publication_root_changed")
  scanFirstSaveFootprint({ footprint: pass.footprint, deadline: producerDeadline })
  const monitor = Object.freeze(Object.create(null))
  FIRST_MONITORS.set(monitor, { active: true, context, operationEnvironment, operationId, producerDeadline,
    root: owner.root, person: owner.person, envDigest: pass.envDigest,
    footprint: copyFirstFootprint(pass.footprint) })
  return monitor
}

function assertFirstInputObservation({ monitor, operationId, producerDeadline }) {
  const value = FIRST_MONITORS.get(monitor)
  if (!value?.active || value.operationId !== operationId || value.producerDeadline !== producerDeadline) {
    throw fault("producer_currentness_unqualified")
  }
  firstDeadline(producerDeadline)
  const owner = firstOperationView({ context: value.context, operationEnvironment: value.operationEnvironment,
    operationId, producerDeadline })
  if (owner.root !== value.root || owner.person !== value.person ||
    digest(Object.fromEntries(Object.entries(owner.env).sort(([a], [b]) => a.localeCompare(b)))) !== value.envDigest) {
    throw fault("publication_scope_changed")
  }
  if (firstRootIdentity({ root: value.root, deadline: producerDeadline }) !== owner.rootIdentity) throw fault("publication_root_changed")
  scanFirstSaveFootprint({ footprint: value.footprint, deadline: producerDeadline })
  firstDeadline(producerDeadline)
}

function closeFirstInputObservation(monitor) {
  const value = FIRST_MONITORS.get(monitor)
  if (!value?.active) throw fault("producer_currentness_unqualified")
  value.active = false
  if (value.operationEnvironment) closeFirstOperationEnvironment(value.operationEnvironment)
}

function firstAuthorityFromReference({ root, env, person, resolution, reference, destination = null, deadline }) {
  firstDeadline(deadline)
  if (digest(firstGitResolution({ root, env, deadline })) !== digest(resolution)) throw fault("producer_currentness_changed")
  const rootIdentity = firstRootIdentity({ root, deadline })
  const files = new Map()
  for (const input of firstConfigInputs({ root, env, output: reference.configOrigins, deadline })) {
    firstDeadline(deadline)
    if (input.origin) files.set(input.path, true)
    else if (!files.has(input.path)) files.set(input.path, false)
  }
  for (const file of reference.globalPaths) if (!files.has(file)) files.set(file, false)
  for (const file of reference.systemPaths ?? []) if (!files.has(file)) files.set(file, false)
  const activation = resolveStartupActivationConfigPath({ env })
  if (activation) files.set(path.resolve(root, activation), true)
  if (files.size > 64) throw fault("producer_currentness_unqualified")
  const proofFiles = []
  for (const [file, contents] of files) {
    firstDeadline(deadline)
    proofFiles.push(firstLegacyFileProof({ file, contents, deadline }))
  }
  const hookProof = firstLegacyFileProof({ file: reference.referenceHook, contents: false, deadline })
  const hookMode = hookProof.absent ? 0 : Number(hookProof.version.mode)
  const identity = { root, gitDir: resolution.admin.real, commonDir: resolution.common.real,
    branch: reference.branch, referenceHook: { proof: hookProof, qualified: hookProof.absent || (hookMode & 0o111) === 0 },
    activation: env.DESK_ACTIVATION_CONFIG ?? env.DESK_ACTIVATION_ID ?? null,
    policy: digest({ config: reference.config.trim(), ssh: env.GIT_SSH_COMMAND ?? null,
      sshProgram: env.GIT_SSH ?? null, askpass: env.GIT_ASKPASS ?? null }) }
  const localProof = { root: rootIdentity, policy: firstPolicyInputs(env), resolution, files: proofFiles }
  const uploadpack = reference.config.split("\0").find(entry => entry.startsWith(`remote.${reference.remote}.uploadpack\n`))
  const base = { ...identity, ...(reference.nothingToSync ? { nothingToSync: reference.nothingToSync } : {
    remote: reference.remote, merge: reference.merge, fetch: reference.fetch, push: reference.push,
    uploadpack: uploadpack?.slice(uploadpack.indexOf("\n") + 1) ?? null,
  }) }
  const recoveryKey = digest({ ...base, resolution: localProof.resolution })
  let serverPolicy = null
  if (reference.serverRoot) {
    const currentDestination = firstDestinationResolution({ route: reference.push, deadline })
    if (!destination || digest(currentDestination) !== digest(destination) || destination.real !== reference.serverRoot) {
      throw fault("producer_currentness_changed")
    }
    const hooks = []
    for (const file of reference.serverHooks) hooks.push(firstPublicationMetadata({ file, deadline }))
    const executableHooks = hooks.some(hook => !hook.absent && Boolean(hook.mode & 0o111))
    const unsupportedConfig = reference.serverConfig.split("\0").some(entry =>
      /^(?:include|includeif\.|uploadpack\.packobjectshook)/iu.test(entry))
    const stat = firstIO(deadline, () => statSync(reference.serverRoot, EXACT))
    serverPolicy = { root: reference.serverRoot, dev: Number(stat.dev), ino: Number(stat.ino),
      resolution: destination, hooks, configFile: firstPublicationMetadata({
        file: path.join(reference.serverRoot, "config"), contents: true, deadline }),
      qualified: !unsupportedConfig && !executableHooks,
      reason: executableHooks ? "publication_server_hooks_not_qualified"
        : unsupportedConfig ? "publication_server_policy_not_qualified" : null }
  }
  const destinationResolution = serverPolicy?.resolution ?? null
  const binding = { ...base, localProof, recoveryKey, destinationResolution,
    key: digest({ recoveryKey, resolution: destinationResolution }) }
  const localPushHook = firstPublicationMetadata({ file: reference.localPushHook, deadline })
  if (!compareFirstLocalBinding({ binding, root, env, deadline }) ||
    (serverPolicy && !compareFirstServerPolicy({ policy: serverPolicy, deadline }))) throw fault("producer_currentness_changed")
  firstDeadline(deadline)
  return { root, rootIdentity, person, env: { ...env }, binding, localPushHook, serverPolicy }
}

function discoverFirstSaveCapture({ context, operationId, producerDeadline, operationEnvironment }) {
  const owner = firstOperationView({ context, operationEnvironment, operationId, producerDeadline }), deadline = producerDeadline
  firstDeadline(deadline)
  if (typeof operationId !== "string" || !operationId ||
    firstRootIdentity({ root: owner.root, deadline }) !== owner.rootIdentity) throw fault("producer_currentness_unqualified")
  const env = Object.freeze({ ...owner.env }), root = owner.root
  if (operationEnvironment) FIRST_OPERATION_ENV_LINKS.set(env, operationEnvironment)
  const envDigest = digest(Object.fromEntries(Object.entries(env).sort(([a], [b]) => a.localeCompare(b))))
  const invocation = discoverFirstInvocation({ root, env, deadline, operationEnvironment })
  const resolution = firstGitResolution({ root, env, deadline })
  const records = new Map(), epochs = new Map(), discoveryQueries = []
  const keyOf = record => JSON.stringify([record.path, record.contents === true, record.binary === true, record.directory === true])
  const merge = additions => {
    for (const record of additions) {
      firstDeadline(deadline)
      const key = keyOf(record), previous = records.get(key)
      if (previous && digest(previous.proof) !== digest(record.proof)) throw fault("producer_currentness_changed")
      if (!previous) records.set(key, record)
    }
    const currentEpochs = firstLookupEpochs({ records: [...records.values()], deadline })
    for (const record of currentEpochs.records) {
      const previous = epochs.get(record.path)
      if (previous && digest(previous.proof) !== digest(record.proof)) throw fault("producer_currentness_changed")
      if (!previous) epochs.set(record.path, record)
    }
  }
  const add = (file, contents = false, directory = false) => merge([{
    path: file, contents, directory, proof: firstFileProof({ path: file, contents, directory, deadline }),
  }])
  merge(invocation.records)
  for (const record of invocation.captureEpochs.records) epochs.set(record.path, record)
  add(root, false, true)
  const marker = path.join(root, ".git"), markerFile = firstIO(deadline, () => statSync(marker, EXACT)).isFile()
  add(marker, markerFile, !markerFile)
  add(resolution.admin.real, false, true)
  add(resolution.common.real, false, true)
  add(path.join(resolution.admin.real, "commondir"), true)
  add(path.join(resolution.admin.real, "HEAD"), true)
  // These are candidate inputs only. Actual Git default search results are compared below.
  const noSystem = /^(?:1|true|yes|on)$/iu.test(env.GIT_CONFIG_NOSYSTEM ?? "")
  const knownSystem = noSystem ? [] : env.GIT_CONFIG_SYSTEM && path.isAbsolute(env.GIT_CONFIG_SYSTEM) ? [env.GIT_CONFIG_SYSTEM] : null
  if (knownSystem === null) throw fault("producer_currentness_unqualified")
  for (const input of firstConfigDefaultInputs({ env, admin: resolution.admin.real, common: resolution.common.real,
    globalPaths: [], systemPaths: knownSystem, deadline })) add(input.path, true)
  const activation = resolveStartupActivationConfigPath({ env })
  if (activation) add(path.resolve(root, activation), true)
  const inspect = args => {
    const result = inspectFirstReference({ root, env, args, footprint: { records: [...records.values()], envDigest },
      captureEpochs: { records: [...epochs.values()] }, deadline })
    discoveryQueries.push({ args, gitDir: null, stdout: result.stdout })
    return result.stdout
  }
  const globalOutput = inspect(["var", "GIT_CONFIG_GLOBAL"])
  const globalPaths = globalOutput.trim().split("\n").filter(Boolean)
  const systemPaths = noSystem ? [] : inspect(["var", "GIT_CONFIG_SYSTEM"]).trim().split("\n").filter(Boolean)
  for (const input of firstConfigDefaultInputs({ env, admin: resolution.admin.real, common: resolution.common.real,
    globalPaths, systemPaths, deadline })) add(input.path, true)
  const originOutput = inspect(["config", "--null", "--show-origin", "--list"])
  const config = discoverFirstConfigClosure({ root, env, initialOutput: originOutput,
    defaults: firstConfigDefaultInputs({ env, admin: resolution.admin.real, common: resolution.common.real,
      globalPaths, systemPaths, deadline }), deadline })
  merge(config.records)
  discoveryQueries.push(...config.queries)
  const discovered = captureFirstAuthorityQueries({ root, env, resolution, footprint: { records: [...records.values()], envDigest },
    captureEpochs: { records: [...epochs.values()] }, deadline })
  if (discovered.reference.configOrigins !== originOutput) throw fault("producer_currentness_changed")
  const reference = { ...discovered.reference, systemPaths }
  // The bare endpoint remains a policy observation, never permission to contact another route.
  if (reference.serverRoot) {
    add(reference.serverRoot, false, true)
    add(path.join(reference.serverRoot, "config"), true)
    add(path.join(reference.serverRoot, "config.worktree"), true)
    const commonPointer = path.join(reference.serverRoot, "commondir")
    add(commonPointer, true)
    if (!firstFileProof({ path: commonPointer, contents: true, deadline }).absent) {
      throw fault("producer_currentness_unqualified")
    }
    if (env.GIT_COMMON_DIR && firstIO(deadline, () => realpathSync(path.resolve(reference.serverRoot, env.GIT_COMMON_DIR))) !== reference.serverRoot) {
      throw fault("producer_currentness_unqualified")
    }
    const originArgs = ["config", "--null", "--show-origin", "--local", "--list"]
    const originResult = inspectFirstReference({ root, env, args: originArgs, gitDir: reference.serverRoot,
      footprint: { records: [...records.values()], envDigest }, captureEpochs: { records: [...epochs.values()] }, deadline })
    discoveryQueries.push({ args: originArgs, gitDir: reference.serverRoot, stdout: originResult.stdout })
    const tokens = originResult.stdout === "" ? [] : originResult.stdout.slice(0, -1).split("\0")
    if (tokens.length % 2 !== 0 || tokens.filter((_value, index) => index % 2 === 1).map(value => `${value}\0`).join("") !== reference.serverConfig) {
      throw fault("producer_currentness_changed")
    }
    const serverInputs = firstConfigInputs({ root: reference.serverRoot, env, output: originResult.stdout, deadline })
    if (serverInputs.some(input => input.origin && ![path.join(reference.serverRoot, "config"),
      path.join(reference.serverRoot, "config.worktree")].includes(input.path))) throw fault("producer_currentness_unqualified")
    const serverConfig = discoverFirstConfigClosure({ root, env, initialOutput: "",
      defaults: [...serverInputs, { path: path.join(reference.serverRoot, "config.worktree"), contents: true }], deadline })
    merge(serverConfig.records)
    discoveryQueries.push(...serverConfig.queries)
  }
  const completeRecords = firstCaptureInputRecords({ root, env, resolution, reference,
    configRecords: [...records.values()].filter(record => !record.binary && !record.directory),
    invocationRecords: invocation.records, systemPaths, deadline })
  merge(completeRecords)
  const selection = operationEnvironment ? FIRST_OPERATION_ENVIRONMENTS.get(operationEnvironment).data : null
  const footprint = { records: [...records.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b))), envDigest,
    ...(selection ? { operationSelection: { ...selection } } : {}) }
  const referencePlan = [...invocation.queries, ...discoveryQueries, ...discovered.observations]
  const sealed = sealFirstReferencePass({ root, env, discovered: { ...footprint,
    queries: referencePlan, captureEpochs: { records: [...epochs.values()] } }, deadline })
  const actualReference = validateFirstReferenceOutputs({ root, resolution, destination: discovered.destination,
    observations: sealed.observations.slice(-discovered.observations.length), deadline })
  actualReference.systemPaths = systemPaths
  if (digest(actualReference) !== digest(reference)) throw fault("producer_currentness_changed")
  const authority = firstAuthorityFromReference({ root, env, person: owner.person, resolution,
    reference: actualReference, destination: discovered.destination, deadline })
  scanFirstSaveFootprint({ footprint: sealed.footprint, deadline })
  if (firstRootIdentity({ root, deadline }) !== owner.rootIdentity) throw fault("publication_root_changed")
  firstDeadline(deadline)
  const capture = { authority, footprint: sealed.footprint, invocation,
    referenceObservations: sealed.observations.slice(-discovered.observations.length),
    captureObservations: sealed.observations }
  FIRST_COMPLETE_CAPTURES.set(capture, { context, operationEnvironment, operationId, producerDeadline, sealed,
    authorityDigest: digest(authority), footprintDigest: digest(sealed.footprint),
    invocationQualified: invocation.implementationQualified === true })
  return capture
}

export function beginFirstSaveCurrentness({ context, operationEnvironment, operationId, producerDeadline, expectedAuthority, expectedFootprint }) {
  const owner = firstOperationView({ context, operationEnvironment, operationId, producerDeadline })
  firstDeadline(producerDeadline)
  if (operationEnvironment) {
    const operation = FIRST_OPERATION_ENVIRONMENTS.get(operationEnvironment)
    if (operation.captureClaimed) throw fault("producer_operation_environment_required")
    operation.captureClaimed = true
  }
  try {
    const capture = discoverFirstSaveCapture({ context, operationEnvironment, operationId, producerDeadline })
    const proof = FIRST_COMPLETE_CAPTURES.get(capture)
    if (!proof || proof.context !== context || !proof.invocationQualified) throw fault("producer_invocation_unqualified")
    if ((expectedAuthority !== undefined && digest(expectedAuthority) !== proof.authorityDigest) ||
      (expectedFootprint !== undefined && digest(expectedFootprint) !== proof.footprintDigest)) throw fault("producer_currentness_changed")
    if (owner.binding && (owner.binding.branch !== capture.authority.binding.branch ||
      owner.binding.key !== capture.authority.binding.key)) throw fault("publication_binding_changed")
    const monitor = retainFirstInputObservation({ context, operationEnvironment, sealed: proof.sealed, operationId, producerDeadline })
    const current = FIRST_MONITORS.get(monitor)
    current.policyComplete = true
    current.authority = JSON.parse(JSON.stringify(capture.authority))
    current.originalDeadline = producerDeadline
    firstDeadline(producerDeadline)
    return { monitor, authority: JSON.parse(JSON.stringify(current.authority)),
      footprint: JSON.parse(JSON.stringify(current.footprint)),
      ...(operationEnvironment ? { operationEnvironment, selection: { ...FIRST_OPERATION_ENVIRONMENTS.get(operationEnvironment).data } } : {}) }
  } catch (error) {
    if (operationEnvironment) closeFirstOperationEnvironment(operationEnvironment)
    throw error
  }
}

export function assertFirstSaveCurrentness({ monitor, operationId, producerDeadline, root, person, baseEnv }) {
  const current = FIRST_MONITORS.get(monitor)
  if (!current?.policyComplete) throw fault("producer_currentness_unqualified")
  assertFirstInputObservation({ monitor, operationId, producerDeadline })
  const authority = current.authority, env = firstOperationView({ context: current.context,
    operationEnvironment: current.operationEnvironment, operationId, producerDeadline }).env
  if ((root !== undefined && root !== authority.root) || (person !== undefined && person !== authority.person) ||
    (baseEnv !== undefined && digest(Object.fromEntries(Object.entries(baseEnv).sort(([a], [b]) => a.localeCompare(b)))) !== current.envDigest)) {
    throw fault("publication_scope_changed")
  }
  if (!compareFirstLocalBinding({ binding: authority.binding, root: authority.root, env, deadline: producerDeadline }) ||
    digest(firstPublicationMetadata({ file: authority.localPushHook.file, deadline: producerDeadline })) !== digest(authority.localPushHook) ||
    (authority.serverPolicy && !compareFirstServerPolicy({ policy: authority.serverPolicy, deadline: producerDeadline }))) {
    throw fault("publication_binding_changed")
  }
  assertFirstInputObservation({ monitor, operationId, producerDeadline })
  firstDeadline(producerDeadline)
}

export function closeFirstSaveCurrentness(monitor) {
  const current = FIRST_MONITORS.get(monitor)
  if (!current?.policyComplete) throw fault("producer_currentness_unqualified")
  closeFirstInputObservation(monitor)
}

function compareFirstLocalBinding({ binding, root, env, deadline }) {
  firstDeadline(deadline)
  const proof = binding?.localProof
  if (!proof || firstRootIdentity({ root, deadline }) !== proof.root ||
    firstPolicyInputs(env) !== proof.policy) return false
  if (!proof.resolution || digest(firstGitResolution({ root, env, deadline })) !== digest(proof.resolution)) return false
  if (!Array.isArray(proof.files)) throw fault("producer_currentness_unqualified")
  for (const file of proof.files) {
    firstDeadline(deadline)
    if (digest(firstLegacyFileProof({ file: file.file, contents: file.contents, deadline })) !== digest(file)) return false
  }
  const hook = binding.referenceHook
  if (!hook || digest(firstLegacyFileProof({ file: hook.proof.file, contents: false, deadline })) !== digest(hook.proof)) return false
  const head = readFirstWitness({ path: path.join(binding.gitDir, "HEAD"), limit: 64 * 1024, deadline })
  firstDeadline(deadline)
  return head.trim() === `ref: ${binding.branch}`
}

function firstPublicationMetadata({ file, contents = false, deadline }) {
  const proof = firstFileProof({ path: file, deadline })
  if (proof.absent) return { file, absent: true }
  const stat = firstIO(deadline, () => statSync(file, EXACT))
  const value = { file, real: proof.real, dev: Number(stat.dev), ino: Number(stat.ino), mode: Number(stat.mode),
    linkDev: Number(proof.version.dev), linkIno: Number(proof.version.ino) }
  if (contents) value.content = digest(readFirstWitness({ path: proof.real, limit: 1024 * 1024, deadline }))
  const after = firstFileProof({ path: file, deadline })
  if (digest(after) !== digest(proof)) throw fault("producer_currentness_changed")
  firstDeadline(deadline)
  return value
}

function firstDestinationResolution({ route, deadline }) {
  firstDeadline(deadline)
  let original
  if (typeof route !== "string") throw fault("publication_destination_input_not_qualified")
  if (path.isAbsolute(route)) original = route
  else {
    if (/[\t\n\r]/u.test(route) || /^[\u0000-\u0020]|[\u0000-\u0020]$/u.test(route)) throw fault("publication_destination_input_not_qualified")
    const raw = /^file:\/\/([^/?#]*)(\/[^?#]*)$/u.exec(route)
    if (!raw || !["", "localhost"].includes(raw[1])) throw fault("publication_transport_not_qualified")
    let decoded
    try { decoded = decodeURIComponent(raw[2]) }
    catch (error) {
      if (!(error instanceof URIError)) throw error
      throw fault("publication_destination_traversal_not_qualified")
    }
    if (decoded.includes("\\") || decoded.split("/").some(part => part === "." || part === "..")) throw fault("publication_destination_traversal_not_qualified")
    const url = new URL(route)
    if (url.protocol !== "file:" || !["", "localhost"].includes(url.hostname) || url.search || url.hash) throw fault("publication_transport_not_qualified")
    original = fileURLToPath(url)
    if (original !== decoded) throw fault("publication_destination_input_not_qualified")
  }
  if (original.split(/[\\/]/u).some(part => part === "." || part === "..")) throw fault("publication_destination_traversal_not_qualified")
  const absolute = path.resolve(original), parts = absolute.slice(path.parse(absolute).root.length).split(path.sep).filter(Boolean)
  if (parts.length > 128) throw fault("publication_destination_resolution_unavailable")
  let prefix = path.parse(absolute).root
  const chain = [firstPublicationMetadata({ file: prefix, deadline })]
  for (const part of parts) {
    firstDeadline(deadline)
    prefix = path.join(prefix, part)
    chain.push(firstPublicationMetadata({ file: prefix, deadline }))
  }
  if (chain.some(entry => entry.absent)) throw fault("publication_destination_resolution_unavailable")
  const real = firstIO(deadline, () => realpathSync(absolute))
  firstDeadline(deadline)
  return { route, path: absolute, real, chain }
}

function compareFirstServerPolicy({ policy, deadline }) {
  firstDeadline(deadline)
  if (!policy?.resolution || digest(firstDestinationResolution({ route: policy.resolution.route, deadline })) !== digest(policy.resolution)) return false
  const stat = firstIO(deadline, () => statSync(policy.root, EXACT))
  if (Number(stat.dev) !== policy.dev || Number(stat.ino) !== policy.ino ||
    digest(firstPublicationMetadata({ file: policy.configFile.file, contents: true, deadline })) !== digest(policy.configFile)) return false
  if (!Array.isArray(policy.hooks)) throw fault("producer_currentness_unqualified")
  for (const hook of policy.hooks) {
    firstDeadline(deadline)
    if (digest(firstPublicationMetadata({ file: hook.file, deadline })) !== digest(hook)) return false
  }
  firstDeadline(deadline)
  return true
}
