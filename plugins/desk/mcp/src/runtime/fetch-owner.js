import { promises as fs, constants } from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFile, fork } from "node:child_process"
import { performance } from "node:perf_hooks"
import { createHash, randomUUID } from "node:crypto"
import { ensureOwnerOnlyDirectory, protectLeafFile, lstatIfPresent } from "../factory/os-protect.js"
import { resolveInspectionGit } from "./git-inspection.js"
import { runGit } from "./state-branch.js"
import { readProcessStart, readOwnProcessStart, runForText } from "../readiness/process-start.js"
import { resolveActivationConfigPath, loadActivationConfig, expandHome } from "../util/paths.js"
import { nativeGitPath } from "./native-path.js"

const NAMING = { label: "fetch-owner", subject: "fetch state" }
const MAX_RECORD = 65536
const MAX_OPERATIONS = 4
const UUID = /^[a-f0-9-]{36}$/u
const OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u
const digest = value => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex")
class Refused extends Error {
  constructor(reason) { super(reason); this.reason = reason }
}
const refuse = reason => { throw new Refused(reason) }
const outcome = (state, reason, extra = {}) => ({ state, ...(reason ? { reason } : {}), sourceApplied: false, lfsReady: false, ...extra })

async function readJson(file) {
  await protectLeafFile(file, process.platform, NAMING)
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await handle.stat()
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_RECORD) refuse("invalid_private_record")
    const bytes = await handle.readFile("utf8")
    if (Buffer.byteLength(bytes) > MAX_RECORD) refuse("record_capacity")
    return JSON.parse(bytes)
  } finally { await handle.close() }
}

async function writeJson(file, value, check) {
  check()
  const bytes = JSON.stringify(value) + "\n"
  if (Buffer.byteLength(bytes) > MAX_RECORD) refuse("record_capacity")
  const present = await lstatIfPresent(file, NAMING)
  if (present) await protectLeafFile(file, process.platform, NAMING)
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await fs.open(temporary, "wx", 0o600)
  try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  check()
  await fs.rename(temporary, file)
}

function receiptValid(record) {
  return record?.version === 1 && UUID.test(record.operationId ?? "") && UUID.test(record.token ?? "") &&
    ["fetching", "fetched", "verified_git_objects", "blocked"].includes(record.state) &&
    record.scope && OID.test(record.scope.oid ?? "") && typeof record.scope.contextHash === "string" &&
    record.candidateRef === `refs/desk/fetch-owner/${record.operationId}/candidate` &&
    record.verifiedRef === `refs/desk/fetch-owner/${record.operationId}/verified` &&
    record.sourceApplied === false && record.lfsReady === false
}

function limits(options) {
  const timeoutMs = options.timeoutMs ?? 60000
  const progressTimeoutMs = options.progressTimeoutMs ?? Math.min(10000, timeoutMs)
  const maxFileBytes = options.maxFileBytes ?? 8 * 1024 * 1024
  if (!Number.isInteger(timeoutMs) || timeoutMs < 2000 || timeoutMs > 120000 ||
      !Number.isInteger(progressTimeoutMs) || progressTimeoutMs < 1000 || progressTimeoutMs > timeoutMs ||
      !Number.isInteger(maxFileBytes) || maxFileBytes < 1024 * 1024 || maxFileBytes > 32 * 1024 * 1024) {
    throw new TypeError("fetch-owner limits require a 2-120 second job, finite progress bound, and 1-32 MiB file limit")
  }
  return { timeoutMs, progressTimeoutMs, maxFileBytes }
}

async function execute(options, inspectOnly) {
  const policy = limits(options)
  if (process.platform !== "darwin") return outcome("blocked", "unsupported_platform")
  const givenEnv = options.env ?? process.env
  const env = { ...givenEnv }
  const environmentHash = value => digest(Object.entries(value).filter(([key]) =>
    /^(?:GIT_|SSH_|GH_|GITHUB_|GCM_|AZURE_|VSS_|HTTP_PROXY$|HTTPS_PROXY$|ALL_PROXY$|NO_PROXY$|HOME$|XDG_CONFIG_HOME$|PATH$)/iu.test(key)).sort(([a], [b]) => a.localeCompare(b)))
  const callerEnvHash = environmentHash(env)
  if (Object.keys(env).some(key => /^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|EXEC_PATH)$/iu.test(key) && env[key])) {
    return outcome("blocked", "git_location_override")
  }
  const end = performance.now() + policy.timeoutMs
  const remaining = () => end - performance.now()
  let settling = false, terminal = false
  const check = () => {
    if (remaining() <= 0) refuse("whole_job_deadline")
    if (!terminal && options.signal?.aborted) failure ??= "cancelled"
    if (failure && !settling) refuse(failure)
  }
  let helper, helperClosed, pending, sequence = 0, closedWitness, lease, directory, operationDirectory, operationId
  let scope, record, acquired = false, leaseIdentity, leaseBytes, failure, result
  let requestedRoot, helperTimer, helperEscalation, removeListeners
  let gitPath
  try { gitPath = resolveInspectionGit() } catch { return outcome("blocked", "trusted_git_unavailable") }
  env.PATH = `${path.dirname(gitPath)}${path.delimiter}${env.PATH ?? ""}`
  const envHash = digest([gitPath, environmentHash(env)])
  const execGit = (file, args, settings, complete) => execFile(gitPath, args, settings, complete)
  const emit = phase => {
    check()
    try { options.onProgress?.({ operationId, ...phase }) } catch { refuse("observer_failed") }
  }
  const localGit = async (root, args) => {
    check()
    const answer = await runGit({ cwd: root, args, env: { ...env, GIT_NO_LAZY_FETCH: "1" }, execFileImpl: execGit,
      timeoutMs: Math.max(1, Math.floor(Math.min(5000, remaining() - 700))), signal: options.signal })
    check()
    if (!answer.ok) refuse(remaining() < 750 ? "whole_job_deadline" : "local_inspection_failed")
    return answer.stdout
  }
  const command = async (root, args, phase = "inspection", allowFailure = false) => {
    check()
    if (["fetch", "remote_readback", "publication"].includes(phase)) await inspectBinding()
    if (helperClosed) refuse("helper_closed")
    const response = await new Promise((resolve, reject) => {
      pending = { id: ++sequence, resolve, reject }
      helper.send({ type: "git", id: sequence, cwd: root, args, phase, timeoutMs: Math.max(1, remaining() - 700) })
    })
    check()
    if (response.reason) refuse(response.reason)
    if (response.code !== 0 && !allowFailure) {
      if (/Authentication|terminal prompts disabled|could not read Username|401|403/u.test(response.stderr)) refuse("authentication_refused")
      refuse("git_command_failed")
    }
    return response
  }
  const text = async (root, args, phase) => (await command(root, args, phase)).stdout.trim()
  const held = async () => {
    check()
    const stat = await fs.lstat(lease, { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n || stat.dev !== leaseIdentity.dev || stat.ino !== leaseIdentity.ino ||
        await fs.readFile(lease, "utf8") !== leaseBytes) refuse("owner_changed")
    check()
  }
  const directoryIdentity = async value => {
    const info = await fs.stat(value, { bigint: true })
    if (!info.isDirectory()) refuse("repository_binding_changed")
    return `${info.dev}:${info.ino}`
  }
  const inspectBinding = async () => {
    const root = await fs.realpath(requestedRoot)
    if (root !== scope.root) refuse("repository_binding_changed")
    const fields = (await localGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"])).trim().split(/\r?\n/u)
    if (fields.length !== 2) refuse("repository_binding_changed")
    const common = await fs.realpath(nativeGitPath(fields[0])), gitDir = await fs.realpath(nativeGitPath(fields[1]))
    if (common !== scope.common || gitDir !== scope.gitDir ||
        await directoryIdentity(root) !== scope.rootIdentity || await directoryIdentity(common) !== scope.commonIdentity ||
        await directoryIdentity(gitDir) !== scope.gitIdentity) refuse("repository_binding_changed")
    return { common, gitDir }
  }
  const localContext = async root => {
    const binding = await inspectBinding()
    if (environmentHash(givenEnv) !== callerEnvHash) refuse("context_changed")
    const branch = await text(root, ["symbolic-ref", "--quiet", "HEAD"])
    if (!branch.startsWith("refs/heads/")) refuse("detached_or_unknown_branch")
    if (scope.branch && branch !== scope.branch) refuse("context_changed")
    const short = branch.slice("refs/heads/".length)
    const remote = await text(root, ["config", "--get", `branch.${short}.remote`])
    const ref = await text(root, ["config", "--get", `branch.${short}.merge`])
    if (!/^[\w.-]+$/u.test(remote) || remote === "." || !/^refs\/heads\/[^\s~^:?*[\\]+$/u.test(ref)) refuse("unsupported_upstream")
    if ((await command(root, ["check-ref-format", ref], "inspection", true)).code !== 0) refuse("unsupported_upstream")
    const endpoint = await text(root, ["remote", "get-url", "--all", remote])
    let url
    try { url = new URL(endpoint) } catch { refuse("unsupported_transport") }
    if (url.protocol !== "http:" || url.username || url.password || url.search || url.hash) refuse("unsupported_transport")
    if (scope.contextHash && endpoint !== scope.endpoint) refuse("context_changed")
    const config = await text(root, ["config", "--null", "--list"])
    const configHash = digest(config)
    if (scope.contextHash && configHash !== scope.configHash) refuse("context_changed")
    const entries = config.split("\0").filter(Boolean).map(entry => { const i = entry.indexOf("\n"); return [entry.slice(0, i), entry.slice(i + 1)] })
    if (entries.some(([key]) => /^url\..*\.(?:insteadof|pushinsteadof)$/iu.test(key))) refuse("transport_policy_unqualified")
    if (entries.some(([key]) => key.toLowerCase().startsWith(`remote.${remote.toLowerCase()}.`) &&
      !["url", "pushurl", "fetch", "push", "tagopt"].includes(key.slice(`remote.${remote}.`.length).toLowerCase()))) {
      refuse("credential_or_repository_policy_unqualified")
    }
    if (entries.some(([key, value]) => value && (/^credential\..*helper$|^credential\.helper$|^core\.askpass$|^http\..*extraheader$/iu.test(key) ||
        /^extensions\.partialclone$|^remote\..*\.(?:promisor|uploadpack)$|^fetch\.(?:bundleuri|uriprotocols)$/iu.test(key))) ||
        env.GIT_ASKPASS || env.SSH_ASKPASS) refuse("credential_or_repository_policy_unqualified")
    if (await text(root, ["rev-parse", "--is-shallow-repository"]) !== "false") refuse("shallow_repository_unqualified")
    if (env.GIT_GRAFT_FILE || (await text(root, ["for-each-ref", "--format=%(refname)", env.GIT_REPLACE_REF_BASE ?? "refs/replace/"]))) {
      refuse("history_overlay_unqualified")
    }
    const grafts = nativeGitPath(await text(root, ["rev-parse", "--path-format=absolute", "--git-path", "info/grafts"]))
    if (await lstatIfPresent(grafts, NAMING)) refuse("history_overlay_unqualified")
    const hooks = path.resolve(root, nativeGitPath(await text(root, ["rev-parse", "--git-path", "hooks"])))
    const hook = await lstatIfPresent(path.join(hooks, "reference-transaction"), NAMING)
    if (hook && (!hook.isFile() || hook.isSymbolicLink() || (hook.mode & 0o111))) refuse("reference_hook_unqualified")
    const activationPath = resolveActivationConfigPath({ env })
    let activationHash = null
    if (activationPath) {
      const absolute = path.resolve(root, expandHome(activationPath, env.HOME))
      const info = await fs.stat(absolute)
      if (!info.isFile() || info.size > MAX_RECORD) refuse("activation_unverified")
      const bytes = await fs.readFile(absolute, "utf8")
      activationHash = digest(bytes)
      const loaded = loadActivationConfig({ configPath: absolute, cwd: root, homeDir: env.HOME })
      if (await fs.realpath(path.resolve(root, expandHome(loaded.desk.root, env.HOME))) !== root) refuse("activation_root_mismatch")
      if (loaded.desk?.state_branch && `refs/heads/${loaded.desk.state_branch}` !== branch) refuse("configured_branch_mismatch")
    }
    const transportHash = digest([binding.common, binding.gitDir, scope.commonIdentity, scope.gitIdentity, endpoint, ref, configHash, envHash])
    const contextHash = digest([root, branch, activationHash, transportHash])
    return { root, branch, remote, ref, endpointHash: digest(endpoint), configHash, activationHash, transportHash, contextHash, endpoint }
  }
  const advertisedOid = async () => {
    const advertised = await text(scope.root, ["-c", "http.followRedirects=false", "ls-remote", "--exit-code", "--refs", scope.endpoint, scope.ref], "remote_readback")
    const fields = advertised.split(/\s+/u)
    if (fields.length !== 2 || !OID.test(fields[0]) || fields[1] !== scope.ref) refuse("remote_ref_unverified")
    return fields[0]
  }
  const closure = async oid => {
    const answer = await command(scope.root, ["rev-list", "--objects", "--missing=print", oid], "closure", true)
    return answer.code === 0 && !/^\?/mu.test(answer.stdout)
  }
  const fresh = async () => {
    await held()
    const now = await localContext(scope.root)
    if (now.contextHash !== scope.contextHash) refuse("context_changed")
    const observedOid = await advertisedOid()
    if (observedOid !== scope.oid) {
      if (record) record.observedOid = observedOid
      refuse("source_generation_changed")
    }
  }
  const observeRef = async ref => {
    const value = await command(scope.root, ["rev-parse", "--verify", ref], "inspection", true)
    return value.code === 0 ? value.stdout.trim() : null
  }
  const persist = async () => {
    await held()
    const { endpoint, ...safeScope } = scope
    record = { ...record, scope: safeScope, sourceApplied: false, lfsReady: false, updatedAt: new Date().toISOString() }
    await writeJson(path.join(operationDirectory, "receipt.json"), record, check)
    await writeJson(path.join(directory, "last.json"), { operationId, digest: digest(record) }, check)
  }
  const capturedEvidence = () => record ? {
    candidateRef: record.candidateRef, verifiedRef: record.verifiedRef,
    ...(OID.test(scope?.oid ?? "") ? { pinnedOid: scope.oid } : {}),
    ...(OID.test(record.observedOid ?? "") ? { observedOid: record.observedOid } : {}),
  } : {}
  const blockedResult = (why, extra = {}) => ({
    ...capturedEvidence(), ...result,
    ...outcome("blocked", why, { ...(operationId ? { operationId } : {}), ...extra }),
  })
  try {
    requestedRoot = path.resolve(options.root)
    const root = await fs.realpath(requestedRoot)
    const fields = (await localGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir", "--absolute-git-dir"])).trim().split(/\r?\n/u)
    if (fields.length !== 2) refuse("repository_binding_changed")
    const common = await fs.realpath(nativeGitPath(fields[0])), gitDir = await fs.realpath(nativeGitPath(fields[1]))
    scope = { root, common, gitDir, rootIdentity: await directoryIdentity(root),
      commonIdentity: await directoryIdentity(common), gitIdentity: await directoryIdentity(gitDir) }
    directory = path.join(common, "desk-fetch-owner")
    await ensureOwnerOnlyDirectory(directory, process.platform, NAMING)
    if ((await fs.readdir(directory)).length > 32) refuse("metadata_capacity")
    check()
    lease = path.join(directory, "owner.json")
    operationId = randomUUID()
    const start = await readOwnProcessStart({ read: pid => readProcessStart(pid, { run: (file, args, opts) => runForText(file, args, { ...opts, timeout: Math.max(1, Math.floor(Math.min(opts.timeout, remaining()))) }) }) })
    if (!start) refuse("owner_generation_unverified")
    check()
    const owner = { version: 1, operationId, token: randomUUID(), pid: process.pid, start, host: os.hostname(), common }
    let handle
    try { handle = await fs.open(lease, "wx", 0o600) } catch (error) {
      if (error.code !== "EEXIST") throw error
      const other = await readJson(lease)
      if (!UUID.test(other?.operationId ?? "") || !other.start || other.common !== common) refuse("owner_record_unverified")
      return outcome("pending", "owner_outcome_unverified", { operationId: other.operationId })
    }
    acquired = true
    leaseBytes = JSON.stringify(owner) + "\n"
    await handle.writeFile(leaseBytes); await handle.sync()
    leaseIdentity = await handle.stat({ bigint: true })
    await handle.close()
    closedWitness = true
    const witnessPath = path.join(directory, "subtree.json")
    const previousWitness = await lstatIfPresent(witnessPath, NAMING)
    if (previousWitness) await protectLeafFile(witnessPath, process.platform, NAMING)
    await writeJson(witnessPath, { operationId, token: owner.token, closed: false }, check)
    const witness = await fs.open(witnessPath, "r+")
    closedWitness = false
    helper = fork(new URL("./fetch-process.js", import.meta.url), [], { env, stdio: ["ignore", "ignore", "ignore", "ipc", witness.fd] })
    let rejectReady
    const ready = new Promise((resolve, reject) => {
      rejectReady = reject
      helper.on("message", message => {
        if (message.type === "ready") resolve()
        if (message.type === "closed" && message.reason !== "finished") failure ??= message.reason
        if (message.type === "progress") { try { emit(message) } catch (error) { failure = error.reason; helper.send({ type: "stop", reason: failure }) } }
        if (message.type === "result" && pending?.id === message.id) { const call = pending; pending = null; call.resolve(message) }
      })
      helper.on("error", () => reject(new Refused("helper_unavailable")))
      helper.on("exit", () => reject(new Refused("helper_closed")))
    })
    const helperDone = new Promise(resolve => helper.on("close", () => {
      helperClosed = true
      clearTimeout(helperTimer)
      clearTimeout(helperEscalation)
      pending?.reject(new Refused(failure ?? "helper_closed"))
      pending = null
      resolve()
    }))
    const stopHelper = (why, force = false) => {
      failure ??= why
      rejectReady(new Refused(failure))
      pending?.reject(new Refused(failure))
      pending = null
      if (helper.connected) helper.send({ type: "stop", reason: failure }, () => {})
      if (force && !helperClosed) {
        helper.kill("SIGTERM")
        helperEscalation ??= setTimeout(() => { if (!helperClosed) helper.kill("SIGKILL") }, 200)
      }
    }
    helperTimer = setTimeout(() => stopHelper("whole_job_deadline", true), Math.max(1, remaining() - 500))
    await witness.close()
    const abort = () => { if (!terminal) stopHelper("cancelled") }
    const exit = () => stopHelper("owner_terminated", true)
    options.signal?.addEventListener("abort", abort, { once: true })
    process.on("SIGTERM", exit)
    removeListeners = () => { options.signal?.removeEventListener("abort", abort); process.off("SIGTERM", exit) }
    helper.send({ type: "init", operationId, token: owner.token, git: gitPath, common, gitDir,
      remainingMs: Math.max(1, remaining()), fileBlocks: Math.floor(policy.maxFileBytes / 1024),
      progressTimeoutMs: policy.progressTimeoutMs })
    let checkingCancellation
    const readCancellation = async () => {
      await held()
      const cancel = path.join(directory, `cancel-${operationId}.json`)
      if (!await lstatIfPresent(cancel, NAMING)) return
      const request = await readJson(cancel)
      if (request.operationId === operationId && request.token === owner.token) failure ??= "cancelled"
    }
    const cancellationTimer = setInterval(() => {
      if (checkingCancellation || failure) return
      checkingCancellation = (async () => {
        await readCancellation()
        if (failure) stopHelper(failure)
      })().catch(error => {
        stopHelper(error instanceof Refused ? error.reason : "cancellation_unverified")
      }).finally(() => { checkingCancellation = null })
    }, 100)
    try {
      await ready
      scope = { ...scope, ...await localContext(root) }
      scope.oid = await advertisedOid()
      emit({ phase: "reserved" })
      const lastPath = path.join(directory, "last.json")
      const last = await lstatIfPresent(lastPath, NAMING)
      if (last) {
        const pointer = await readJson(lastPath)
        if (!UUID.test(pointer?.operationId ?? "")) refuse("receipt_unverified")
        const old = await readJson(path.join(directory, pointer.operationId, "receipt.json"))
        if (!receiptValid(old) || digest(old) !== pointer.digest) refuse("receipt_unverified")
        if (!["verified_git_objects", "blocked"].includes(old.state) || old.subtreeClosed !== true) refuse("previous_effects_unverified")
        if (old.scope.contextHash === scope.contextHash && old.scope.oid === scope.oid && old.state === "verified_git_objects") {
          if (await observeRef(old.verifiedRef) !== scope.oid || !await closure(scope.oid)) refuse("missing_object_closure")
          await fresh()
          result = outcome("verified_git_objects", null, { operationId: old.operationId, verifiedRef: old.verifiedRef, reused: true })
        }
        if (inspectOnly && !result) refuse("receipt_context_or_generation_changed")
      } else if (inspectOnly) refuse("no_receipt")
      if (!result) {
      const entries = await fs.readdir(directory, { withFileTypes: true })
      if (entries.filter(entry => entry.isDirectory() && UUID.test(entry.name)).length >= MAX_OPERATIONS) refuse("retained_operation_capacity")
      operationDirectory = path.join(directory, operationId)
      await ensureOwnerOnlyDirectory(operationDirectory, process.platform, NAMING)
      record = { version: 1, operationId, token: owner.token, owner, state: "fetching",
        candidateRef: `refs/desk/fetch-owner/${operationId}/candidate`, verifiedRef: `refs/desk/fetch-owner/${operationId}/verified`, subtreeClosed: false }
      await persist()
      emit({ phase: "fetching" })
      await fresh()
      const fetched = await command(root, ["-c", "http.followRedirects=false", "fetch", "--keep", "--progress", "--no-tags",
        "--no-recurse-submodules", "--no-prune", "--no-write-fetch-head", "--no-auto-maintenance", scope.endpoint, `${scope.ref}:${record.candidateRef}`], "fetch")
      if (fetched.code !== 0) refuse("fetch_failed")
      record.state = "fetched"
      await persist()
      emit({ phase: "fetched" })
      if (await observeRef(record.candidateRef) !== scope.oid || !await closure(scope.oid)) refuse("missing_object_closure")
      await fresh()
      emit({ phase: "publishing" })
      await fresh()
      await text(root, ["update-ref", "--create-reflog", record.verifiedRef, scope.oid, "0".repeat(scope.oid.length)], "publication")
      emit({ phase: "published" })
      await fresh()
      if (await observeRef(record.verifiedRef) !== scope.oid) refuse("publication_unverified")
      record.state = "verified_git_objects"
      result = outcome("verified_git_objects", null, { operationId, verifiedRef: record.verifiedRef })
      }
    } finally {
      clearInterval(cancellationTimer)
      await checkingCancellation
      if (helper.connected) helper.send({ type: "finish", reason: failure ?? "finished" })
      await Promise.race([helperDone, new Promise(resolve => { const timer = setTimeout(resolve, Math.max(1, remaining())); timer.unref() })])
      if (helperClosed) {
        const witness = await readJson(witnessPath)
        closedWitness = witness.closed === true && witness.token === owner.token && witness.operationId === operationId
      }
      settling = true
      if (closedWitness) await readCancellation()
      check()
      if (failure) refuse(failure)
    }
  } catch (error) {
    failure ??= error instanceof Refused ? error.reason : /^(?:ENOSPC|EDQUOT)$/u.test(error.code ?? "") ? "storage_unavailable" : "inspection_or_private_state_failed"
    result = outcome("blocked", failure, { ...(operationId ? { operationId } : {}),
      ...capturedEvidence(),
      ...(error instanceof Refused ? {} : { diagnostic: {
        kind: ["Error", "TypeError", "SyntaxError"].includes(error.name) ? error.name : "Error",
        code: /^[A-Z_]{1,40}$/u.test(error.code ?? "") ? error.code : null,
      } }) })
  } finally {
    settling = true
    if (acquired && closedWitness && remaining() > 0) {
      try {
        check()
        if (failure) result = blockedResult(failure)
        // Cancellation is accepted through actual subtree closure. This seals the terminal decision before publication.
        terminal = true
        if (record) {
          record = { ...record, state: result?.state === "verified_git_objects" ? "verified_git_objects" : "blocked", reason: failure ?? null, subtreeClosed: true }
          await persist()
        }
        await held()
        await fs.unlink(lease)
        check()
      } catch {
        result = blockedResult(failure ?? "cleanup_unverified", { custody: "retained", cleanup: "unverified" })
      }
    } else if (acquired) {
      result = blockedResult(failure ?? "subtree_or_cleanup_unverified", { custody: "retained" })
    }
    clearTimeout(helperTimer)
    clearTimeout(helperEscalation)
    removeListeners?.()
  }
  return result
}

export async function runFetchOwner(options) { return execute(options, false) }
export async function inspectFetchOwner(options) { return execute(options, true) }

export async function cancelFetchOwner({ root, operationId, env = process.env }) {
  if (process.platform !== "darwin") return outcome("blocked", "unsupported_platform")
  if (!UUID.test(operationId ?? "")) return outcome("blocked", "invalid_operation")
  let gitPath
  try { gitPath = resolveInspectionGit() } catch { return outcome("blocked", "trusted_git_unavailable") }
  const located = await runGit({ cwd: root, args: ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    env: { ...env, PATH: `${path.dirname(gitPath)}${path.delimiter}${env.PATH ?? ""}` }, timeoutMs: 2000,
    execFileImpl: (file, args, settings, complete) => execFile(gitPath, args, settings, complete) })
  if (!located.ok) return outcome("blocked", "destination_unverified")
  const directory = path.join(await fs.realpath(nativeGitPath(located.stdout)), "desk-fetch-owner")
  let owner
  try {
    const file = path.join(directory, "owner.json")
    if (!await lstatIfPresent(file, NAMING)) return outcome("blocked", "owner_unavailable")
    owner = await readJson(file)
  } catch (error) {
    return outcome("blocked", "owner_record_unverified", { diagnostic: { code: /^[A-Z_]{1,40}$/u.test(error.code ?? "") ? error.code : null } })
  }
  if (owner.operationId !== operationId || !UUID.test(owner.token ?? "")) return outcome("blocked", "owner_changed")
  await writeJson(path.join(directory, `cancel-${operationId}.json`), { operationId, token: owner.token }, () => {})
  try {
    const current = await readJson(path.join(directory, "owner.json"))
    if (current.operationId !== operationId || current.token !== owner.token) return outcome("blocked", "owner_changed")
  } catch {
    return outcome("blocked", "owner_record_unverified")
  }
  return outcome("pending", "cancellation_requested", { operationId })
}
