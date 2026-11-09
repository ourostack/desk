import { createHash, randomUUID } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import { closeSync, lstatSync, mkdirSync, openSync, opendirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { lastStartRootKey, resolveDeskStateDir } from "./last-start.js"
import { assertNotRealStateUnderTest } from "./test-state-guard.js"
import { readProcessStart } from "../readiness/process-start.js"
import { readSmallText } from "../factory/marker.js"
import { resolveStartupActivationConfigPath } from "./startup-resolve.js"
import { redactCredentialLikeText } from "../util/redact.js"
import { verifiedIncomingResolution } from "./health.js"

const SCRIPT = fileURLToPath(new URL("../../scripts/sync-push.js", import.meta.url))
const ACTIVE = new Set(["starting", "accepted", "running"])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex")
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
export const incomingFailureFingerprint = (failure) => digest(failure ?? null)
let settlementOwnerStart = null

function processWitness(pid, { timeout = 250 } = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" }
  if (process.platform === "linux") {
    try {
      const text = readFileSync(`/proc/${pid}/stat`, "utf8")
      const fields = text.slice(text.lastIndexOf(")") + 2).split(" ")
      if (/^[ZX]/u.test(fields[0])) return { state: "absent", exited: true }
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim()
      if (!boot || !/^\d+$/u.test(fields[19] ?? "")) return { state: "unknown" }
      return { state: "present", pid, parentPid: Number(fields[1]), group: Number(fields[2]), start: `linux:${boot}:${fields[19]}` }
    } catch (error) {
      return { state: error.code === "ENOENT" ? "absent" : "unknown" }
    }
  }
  if (process.platform !== "darwin") return { state: "unknown" }
  return processWitnesses([pid], { timeout }).get(pid) ?? { state: "unknown" }
}

function processWitnesses(pids, { timeout = 250 } = {}) {
  const requested = [...new Set(pids.filter((pid) => Number.isSafeInteger(pid) && pid > 0))]
  if (process.platform !== "darwin") return new Map(requested.map((pid) => [pid, processWitness(pid, { timeout })]))
  if (requested.length === 0) return new Map()
  const unknown = () => new Map(requested.map((pid) => [pid, { state: "unknown" }]))
  const result = spawnSync("/bin/ps", ["-p", requested.join(","), "-o", "pid=,ppid=,pgid=,stat=,lstart="], {
    encoding: "utf8", timeout, killSignal: "SIGKILL", windowsHide: true,
    env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
  })
  if (result.status === 1 && !result.stdout?.trim() && !result.stderr?.trim()) return new Map(requested.map((pid) => [pid, { state: "absent" }]))
  if (result.status !== 0 || !result.stdout.trim()) return unknown()
  const witnesses = new Map(requested.map((pid) => [pid, { state: "absent" }]))
  for (const line of result.stdout.split("\n").filter((line) => line.trim())) {
    const row = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)\s*$/u.exec(line)
    const when = row ? Date.parse(`${row[5].trim()} UTC`) : NaN
    if (!row || !requested.includes(Number(row[1])) || !Number.isFinite(when)) return unknown()
    witnesses.set(Number(row[1]), /^[ZX]/u.test(row[4]) ? { state: "absent", exited: true } : {
      state: "present", pid: Number(row[1]), parentPid: Number(row[2]), group: Number(row[3]),
      start: `darwin:${new Date(when).toISOString()}`,
    })
  }
  return witnesses
}

function directory(root, env) {
  return path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(realpathSync(root))}.recovery`)
}

function read(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"))
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw error
  }
}

function legacyFailure(root, env) {
  const file = path.join(resolveDeskStateDir({ env }), "sync", `${lastStartRootKey(root)}.status.json`)
  const value = read(file)?.last_pull
  return value?.state === "unresolved" ? value : null
}

function hasOrphan(dir) {
  let handle
  try {
    handle = opendirSync(dir)
    for (let count = 0; count < 128; count += 1) {
      const entry = handle.readSync()
      if (!entry) return false
      if (/^[0-9a-f-]{36}\.(?:json|stderr)(?:\.|$)/u.test(entry.name)) return true
    }
    return true
  } catch (error) {
    if (error.code === "ENOENT") return false
    throw error
  } finally {
    handle?.closeSync()
  }
}

function save(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  writeFileSync(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

function local(root, env, args, { absent = false, deadline = Infinity } = {}) {
  const timeout = Math.min(5000, deadline - Date.now())
  if (timeout <= 0) throw Object.assign(new Error("Recovery lifetime expired"), { code: "recovery_deadline" })
  const result = spawnSync("git", ["-C", root, ...args], {
    env, encoding: "utf8", windowsHide: true, timeout,
  })
  if (result.status !== 0) {
    if (absent && result.status === 1) return null
    throw Object.assign(new Error("Local Git inspection failed"), { code: result.error?.code ?? "git_inspection_failed" })
  }
  return result.stdout.trim()
}

function policyInputs(env) {
  const git = Object.fromEntries(Object.keys(env).filter((key) => key.startsWith("GIT_")).sort().map((key) => [key, env[key]]))
  return digest({ git, home: env.HOME ?? null, xdg: env.XDG_CONFIG_HOME ?? null,
    activation: resolveStartupActivationConfigPath({ env }), declared: env.DESK_ACTIVATION_CONFIG ?? env.DESK_ACTIVATION_ID ?? null })
}

function fileProof(file, contents) {
  let stat
  try {
    stat = lstatSync(file, { bigint: true })
    const version = Object.fromEntries(["dev", "ino", "mode", "size", "mtimeNs", "ctimeNs"].map((key) => [key, String(stat[key])]))
    const real = realpathSync(file)
    return { file, contents, real, version, ...(contents ? { sha256: digest(readSmallText(real, 1024 * 1024)) } : {}) }
  } catch (error) {
    if (error.code === "ENOENT" && !stat) return { file, contents, absent: true }
    throw error
  }
}

function directoryProof(file) {
  const real = realpathSync(file)
  const stat = statSync(real, { bigint: true })
  if (!stat.isDirectory()) throw Object.assign(new Error("Git administration path is not a directory"), { code: "git_identity_unavailable" })
  return { real, dev: String(stat.dev), ino: String(stat.ino) }
}

function gitResolutionProof(root, env) {
  const marker = path.join(root, ".git")
  const markerFile = statSync(marker).isFile()
  const pointer = markerFile ? readSmallText(marker, 64 * 1024).trim() : null
  if (markerFile && !pointer.startsWith("gitdir: ")) throw Object.assign(new Error("Git administration pointer is invalid"), { code: "git_identity_unavailable" })
  const admin = directoryProof(env.GIT_DIR ? path.resolve(root, env.GIT_DIR)
    : markerFile ? path.resolve(root, pointer.slice(8)) : marker)
  const commonPointer = path.join(admin.real, "commondir")
  const commonFile = fileProof(commonPointer, true)
  const common = directoryProof(env.GIT_COMMON_DIR ? path.resolve(root, env.GIT_COMMON_DIR)
    : commonFile.absent ? admin.real : path.resolve(admin.real, readSmallText(commonPointer, 64 * 1024).trim()))
  return { marker: markerFile ? fileProof(marker, true) : directoryProof(marker), admin, commonFile, common }
}

function localProof(root, env, inspect, config, gitDir, commonDir) {
  const entries = inspect(["config", "--null", "--show-origin", "--list"])
  const tokens = entries.split("\0")
  const files = new Map()
  const resolveFile = (file, origin = root) => path.resolve(origin, file.startsWith("~/") ? path.join(env.HOME, file.slice(2)) : file)
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const origin = tokens[index]
    if (!origin.startsWith("file:")) continue
    const file = resolveFile(origin.slice(5))
    files.set(file, true)
    const split = tokens[index + 1].indexOf("\n")
    const key = tokens[index + 1].slice(0, split)
    const value = tokens[index + 1].slice(split + 1)
    if (/^(?:include|includeif\..*)\.path$/iu.test(key)) {
      if (/^(?:~[^/]|%\()/u.test(value)) throw Object.assign(new Error("Config include identity unavailable"), { code: "config_identity_unavailable" })
      const target = resolveFile(value, path.dirname(file))
      if (!files.has(target)) files.set(target, false)
    }
  }
  for (const kind of ["GIT_CONFIG_GLOBAL", ...(!env.GIT_CONFIG_NOSYSTEM ? ["GIT_CONFIG_SYSTEM"] : [])]) {
    for (const file of inspect(["var", kind]).split("\n").filter(Boolean)) {
      const target = resolveFile(file)
      if (!files.has(target)) files.set(target, false)
    }
  }
  const activation = resolveStartupActivationConfigPath({ env })
  if (activation) files.set(resolveFile(activation), true)
  if (files.size > 64) throw Object.assign(new Error("Config identity exceeds its read bound"), { code: "config_identity_unavailable" })
  const resolution = gitResolutionProof(root, env)
  if (resolution.admin.real !== gitDir || resolution.common.real !== commonDir) {
    throw Object.assign(new Error("Git administration binding changed"), { code: "binding_changed" })
  }
  const proof = { root: rootIdentity(root), policy: policyInputs(env), resolution,
    files: [...files].map(([file, contents]) => fileProof(file, contents)) }
  if (inspect(["config", "--null", "--list"]) !== config ||
    inspect(["config", "--null", "--show-origin", "--list"]) !== entries) {
    throw Object.assign(new Error("Binding changed during inspection"), { code: "binding_changed" })
  }
  return proof
}

function localHead(binding) {
  if (readSmallText(path.join(binding.gitDir, "HEAD")).trim() !== `ref: ${binding.branch}`) return null
  const file = path.join(binding.commonDir, binding.branch)
  try {
    const head = readSmallText(file).trim()
    return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head) ? head : null
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    const packed = readSmallText(path.join(binding.commonDir, "packed-refs"), 4 * 1024 * 1024)
    return packed.split("\n").map((line) => line.split(" ")).find(([, ref]) => ref === binding.branch)?.[0] ?? null
  }
}

export function isLocalBindingCurrent(binding, { root, env = process.env }) {
  const proof = binding?.localProof
  if (!proof || rootIdentity(root) !== proof.root || policyInputs(env) !== proof.policy) return false
  if (!proof.resolution || digest(gitResolutionProof(root, env)) !== digest(proof.resolution)) return false
  if (proof.files.some((file) => digest(fileProof(file.file, file.contents)) !== digest(file))) return false
  const hook = binding.referenceHook
  if (!hook || digest(fileProof(hook.proof.file, false)) !== digest(hook.proof)) return false
  if (readSmallText(path.join(binding.gitDir, "HEAD")).trim() !== `ref: ${binding.branch}`) return false
  return true
}

function applicable(record, env) {
  const binding = record.binding
  if (!isLocalBindingCurrent(binding, { root: record.root, env })) return false
  return record.nothingToSync || localHead(binding) === record.source.head
}

/** Captures the repository and effective route without contacting a remote. */
export function recoveryBinding(root, env, { deadline = Infinity } = {}) {
  const guardCutoff = () => {
    if (!Number.isFinite(deadline) || Date.now() >= deadline)
      throw Object.assign(new Error("Sync operation admission could not be verified"), { code: "sync_operation_unverified" })
  }
  guardCutoff()
  const inspect = (args) => local(root, env, args, { deadline })
  const canonical = realpathSync(root)
  const [top, gitDir, commonDir] = inspect([
    "rev-parse", "--path-format=absolute", "--show-toplevel", "--absolute-git-dir", "--git-common-dir",
  ]).split("\n").map((value) => realpathSync(value))
  if (top !== canonical) throw Object.assign(new Error("Recovery requires the repository root"), { code: "root_not_toplevel" })
  let markerUnknown = false, rebasePresent = false, gitIdentity
  const adminIdentity = () => {
    guardCutoff()
    const stat = lstatSync(gitDir, { bigint: true })
    guardCutoff()
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Worktree admin directory is not qualified")
    return { dev: stat.dev, ino: stat.ino, mode: stat.mode }
  }
  const sameAdmin = (value) => value.dev === gitIdentity.dev && value.ino === gitIdentity.ino && value.mode === gitIdentity.mode
  try { gitIdentity = adminIdentity() } catch { markerUnknown = true }
  for (const name of ["rebase-merge", "rebase-apply"]) {
    if (!Number.isFinite(deadline) || Date.now() >= deadline) { markerUnknown = true; break }
    try {
      if (!gitIdentity) throw new Error("Worktree admin identity is unavailable")
      guardCutoff()
      const marker = inspect(["rev-parse", "--path-format=absolute", "--git-path", name])
      guardCutoff()
      if (!path.isAbsolute(marker) || path.basename(marker) !== name || path.dirname(marker) !== gitDir ||
        path.normalize(marker) !== marker || /[\0\r\n]/u.test(marker)) throw new Error("Rebase marker path is not worktree-specific")
      const parent = realpathSync(path.dirname(marker))
      guardCutoff()
      if (parent !== gitDir || !sameAdmin(adminIdentity())) throw new Error("Worktree admin directory changed")
      let stat
      try { stat = lstatSync(marker, { bigint: true }) }
      catch (error) { if (error.code !== "ENOENT") throw error }
      guardCutoff()
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error("Rebase marker type is unqualified")
      if (realpathSync(path.dirname(marker)) !== gitDir || !sameAdmin(adminIdentity())) throw new Error("Worktree admin directory changed")
      guardCutoff()
      rebasePresent ||= stat !== undefined
    } catch { markerUnknown = true }
  }
  if (markerUnknown) throw Object.assign(new Error("Sync operation admission could not be verified"), { code: "sync_operation_unverified" })
  if (rebasePresent) throw Object.assign(new Error("An existing rebase was retained without starting synchronization"), { code: "rebase_in_progress" })
  const branch = inspect(["symbolic-ref", "--quiet", "HEAD"])
  const config = inspect(["config", "--null", "--list"])
  const values = new Map(config.split("\0").map((entry) => {
    const split = entry.indexOf("\n")
    return [entry.slice(0, split), entry.slice(split + 1)]
  }))
  const name = branch.slice("refs/heads/".length)
  const remote = values.get(`branch.${name}.remote`)
  const merge = values.get(`branch.${name}.merge`)
  const hookPath = inspect(["rev-parse", "--path-format=absolute", "--git-path", "hooks/reference-transaction"])
  const hookProof = fileProof(hookPath, false)
  const referenceHook = { proof: hookProof, qualified: hookProof.absent || (Number(statSync(hookPath).mode) & 0o111) === 0 }
  const identity = {
    root: canonical, gitDir, commonDir, branch, referenceHook,
    activation: env.DESK_ACTIVATION_CONFIG ?? env.DESK_ACTIVATION_ID ?? null,
    policy: digest({ config, ssh: env.GIT_SSH_COMMAND ?? null, sshProgram: env.GIT_SSH ?? null, askpass: env.GIT_ASKPASS ?? null }),
  }
  const finish = (details) => {
    const binding = { ...identity, ...details }
    const proof = localProof(canonical, env, inspect, config, gitDir, commonDir)
    return { ...binding, key: digest({ ...binding, resolution: proof.resolution }), localProof: proof }
  }
  if (!remote && ![...values.keys()].some((key) => /^remote\..+\.url$/u.test(key))) return finish({ nothingToSync: "no_remote" })
  if (!remote || !merge || remote === "." || !merge.startsWith("refs/heads/")) return finish({ nothingToSync: "no_upstream" })
  const fetch = inspect(["remote", "get-url", "--all", remote]).split("\n")
  const push = inspect(["remote", "get-url", "--push", "--all", remote]).split("\n")
  if (fetch.length !== 1 || push.length !== 1) throw Object.assign(new Error("Recovery requires one captured route per direction"), { code: "ambiguous_route" })
  return finish({
    remote, merge, fetch: fetch[0], push: push[0],
    uploadpack: values.get(`remote.${remote}.uploadpack`) ?? null,
  })
}

function publicOperation(record) {
  const { binding, ...operation } = record
  return { ...operation, binding: binding ? { key: binding.key, root: binding.root, branch: binding.branch } : null }
}

function validRecord(record, pointer, root) {
  if (!record || record.version !== 1 || record.id !== pointer.id || record.root !== realpathSync(root) ||
    !Number.isFinite(record.lifetimeMs) || record.lifetimeMs < 100 || record.lifetimeMs > 120000 ||
    !/^[0-9a-f]{64}$/u.test(record.rootIdentity ?? "") ||
    !["starting", "accepted", "running", "synced", "blocked", "unknown"].includes(record.state) ||
    typeof record.resources?.childrenClosed !== "boolean") return false
  for (const field of ["incoming", "outgoing", "source", "lfs"]) {
    if (typeof record[field]?.state !== "string") return false
  }
  if (record.binding && (!/^[0-9a-f]{64}$/u.test(record.binding.key ?? "") || record.binding.root !== record.root)) return false
  if (record.state === "synced" && !record.nothingToSync) {
    return record.incoming.state === "verified" && record.outgoing.state === "verified" &&
      record.source.state === "current" && record.lfs.state === "not_required" && record.resources.childrenClosed
  }
  return true
}

/** Bounded local readback. Missing, damaged or unverifiable custody never authorizes replacement. */
export function readRecoveryStatus(options) {
  return observeRecoveryStatus(options, 1)
}

function observeRecoveryStatus({ root, env = process.env }, retries) {
  const dir = directory(root, env)
  let pointer
  try {
    pointer = read(path.join(dir, "active.json")) ?? read(path.join(dir, "latest.json"))
  } catch (error) {
    return { id: null, state: "unknown", reason: error.code ?? "recovery_record_invalid", custody: "unknown" }
  }
  if (!pointer) return hasOrphan(dir) ? { id: null, state: "unknown", reason: "orphaned_recovery", custody: "unknown" } : null
  if (!UUID.test(pointer.id ?? "")) return { id: null, state: "unknown", reason: "recovery_record_invalid", custody: "unknown" }
  let record
  try {
    record = read(path.join(dir, `${pointer.id}.json`))
  } catch (error) {
    return { id: pointer.id, state: "unknown", reason: error.code ?? "recovery_record_invalid", custody: "unknown" }
  }
  if (!record) return { id: pointer.id, state: "unknown", reason: "custody_unknown", custody: "unknown" }
  if (!validRecord(record, pointer, root)) return { id: pointer.id, state: "unknown", reason: "recovery_record_invalid", custody: "unknown" }
  const operation = publicOperation(record)
  const uncertain = (reason) => {
    try {
      const current = read(path.join(dir, `${pointer.id}.json`))
      if (JSON.stringify(current) !== JSON.stringify(record)) {
        return retries > 0 ? observeRecoveryStatus({ root, env }, retries - 1)
          : { ...operation, state: "unknown", recordedState: record.state, reason: "recovery_changed_during_read", custody: "unknown" }
      }
    } catch (error) {
      return { ...operation, state: "unknown", recordedState: record.state, reason: error.code ?? "recovery_record_unreadable", custody: "unknown" }
    }
    return { ...operation, recordedState: record.state, state: "unknown", reason, custody: "unknown" }
  }
  if (record.state === "synced") {
    try {
      if (!applicable(record, env)) return { ...operation, state: "unknown", historicalState: "synced", reason: "binding_changed", custody: "settled" }
    } catch (error) {
      return { ...operation, state: "unknown", historicalState: "synced", reason: error.code ?? "binding_validation_unavailable", custody: "settled" }
    }
  }
  try {
    const previous = read(path.join(dir, "latest.json"))
    if (!operation.priorFailure && previous?.id !== record.id && UUID.test(previous?.id ?? "")) {
      const prior = read(path.join(dir, `${previous.id}.json`))
      if (prior && prior.state !== "synced") operation.priorFailure = {
        state: "unresolved", reason: prior.reason ?? "custody_unknown",
        operationId: previous.id, at: prior.updatedAt ?? prior.createdAt,
      }
    }
  } catch (error) {
    operation.priorFailure = { state: "unresolved", reason: error.code ?? "prior_recovery_record_unreadable" }
  }
  const helperTransition = record.resources.scope === "native-owner" && UUID.test(record.resources.token ?? "") &&
    ((record.resources.phase === "unaccepted" && !record.resources.start) ||
      (record.resources.phase === "settling" && (record.resources.exitObserved === true || record.resources.resultReceived === true)))
  const checkHelper = ACTIVE.has(record.state) && record.resources.childrenClosed === false && record.resources.childPid && !helperTransition
  const witnesses = processWitnesses([
    ...(!record.finalized && record.owner && !(record.owner.pid === process.pid && settlementOwnerStart) ? [record.owner.pid] : []),
    ...(checkHelper ? [record.resources.childPid, record.resources.watchdog?.pid] : []),
  ])
  // This executing process cannot have recycled its own accepted generation.
  if (record.owner?.pid === process.pid && settlementOwnerStart) witnesses.set(process.pid, { state: "present", start: settlementOwnerStart })
  if (!record.finalized && record.owner) {
    const observed = witnesses.get(record.owner.pid) ?? { state: "unknown" }
    const reason = observed.state === "absent" ? "owner_lost" : !record.owner.start || observed.state !== "present"
      ? "owner_unverifiable" : observed.start !== record.owner.start ? "owner_generation_mismatch" : null
    if (reason) return uncertain(reason)
  }
  if (checkHelper) {
    const observed = witnesses.get(record.resources.childPid) ?? { state: "unknown" }
    const reason = !record.resources.start || observed.state !== "present" ? "helper_unverifiable"
      : observed.start !== record.resources.start ? "helper_generation_mismatch" : null
    if (reason) return uncertain(reason)
    if (record.resources.watchdog) {
      const watchdog = witnesses.get(record.resources.watchdog.pid) ?? { state: "unknown" }
      const failure = !record.resources.watchdog.start || watchdog.state !== "present" ? "watchdog_unverifiable"
        : watchdog.start !== record.resources.watchdog.start ? "watchdog_generation_mismatch" : null
      if (failure) return uncertain(failure)
    }
  }
  if (!ACTIVE.has(record.state) && !record.finalized) return { ...operation, state: "running" }
  return operation
}

function outcome(operation) {
  return operation.state === "synced"
    ? { state: "synced", ...(operation.nothingToSync ? { nothingToSync: operation.nothingToSync } : {}), operation }
    : { state: ACTIVE.has(operation.state) ? "recovering" : "unresolved",
      reason: operation.reason ?? (ACTIVE.has(operation.state) ? "custody_pending" : "custody_unknown"), operation }
}

export function recoverySummary(result) {
  if (result.state === "recovering") return "Desk sync is pending in the background"
  if (result.nothingToSync === "headless") return "headless session; nothing synced"
  if (result.nothingToSync === "no_remote") return "no remote; nothing to sync"
  if (result.nothingToSync === "no_upstream") return "no upstream branch; nothing to sync"
  if (result.state === "synced") return "Desk synced with its captured route"
  return `Desk sync unresolved: ${result.reason ?? "unknown outcome"}${result.operation?.id ? `; operation ${result.operation.id}` : ""}; inspect desk_status before another attempt`
}

/** One durable reservation; only its accepted worker may release it after closing its native children. */
export async function startOrJoinRecovery({
  root, env = process.env, waitMs = 0, lifetimeMs = 60000, spawnImpl = spawn, bootChecks = false, taskQuery = null, taskOnly = false,
}) {
  if (!Number.isFinite(waitMs) || !Number.isFinite(lifetimeMs)) return { state: "unresolved", reason: "invalid_recovery_budget" }
  try {
    if (process.platform === "win32") return { state: "unresolved", reason: "native_child_custody_unsupported" }
    const dir = directory(root, env)
    assertNotRealStateUnderTest(dir, { env })
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const previous = readRecoveryStatus({ root, env })
    if (previous?.state === "unknown" && previous.custody !== "settled") return outcome(previous)
    const failure = legacyFailure(root, env)
    const previousResolvedIncoming = verifiedIncomingResolution(previous)
    const resolvedBeforeFingerprint = previousResolvedIncoming ? previous.incomingBeforeFingerprint : previous?.resolvedBeforeFingerprint ?? null
    const knownFailure = failure && incomingFailureFingerprint(failure) !== resolvedBeforeFingerprint ? failure
      : previousResolvedIncoming ? null : previous?.priorFailure ?? (previous?.state === "blocked" ? {
        state: "unresolved", reason: previous.reason ?? "custody_unknown", at: previous.updatedAt ?? previous.createdAt, operationId: previous.id,
      } : null)
    const priorChecks = previous?.checks?.state === "ready" ? null
      : previous?.checks && !["pending", "running"].includes(previous.checks.state) ? previous.checks : previous?.priorChecks ?? null
    const active = path.join(dir, "active.json")
    const id = randomUUID()
    let created = false
    try {
      writeFileSync(active, `${JSON.stringify({ id })}\n`, { flag: "wx", mode: 0o600 })
      created = true
    } catch (error) {
      if (error.code !== "EEXIST") throw error
    }
    if (created) {
      const record = {
        version: 1, id, root: realpathSync(root), rootIdentity: rootIdentity(root), binding: null, state: "starting", custody: "unaccepted", owner: null,
        createdAt: new Date().toISOString(), lifetimeMs: Math.max(100, Math.min(120000, lifetimeMs)),
        incoming: { state: "not_dispatched" }, outgoing: { state: "not_dispatched" },
        source: { state: "not_checked" }, lfs: { state: "not_checked" }, resources: { childrenClosed: true },
        bootChecks, taskQuery, taskOnly,
        priorFailure: knownFailure, incomingBeforeFingerprint: incomingFailureFingerprint(failure), resolvedBeforeFingerprint,
        priorChecks,
      }
      save(path.join(dir, `${id}.json`), record)
      let child
      const failedLaunch = () => {
        save(path.join(dir, `${id}.json`), { ...record, state: "blocked", reason: "worker_launch_failed", finalized: true })
        save(path.join(dir, "latest.json"), { id })
        if (read(active)?.id === id) unlinkSync(active)
      }
      const log = openSync(path.join(dir, `${id}.stderr`), "wx", 0o600)
      try {
        child = spawnImpl(process.execPath, [SCRIPT, "--root", root, "--recovery", id], {
          cwd: root, env, detached: true, stdio: ["ignore", "ignore", log], windowsHide: true,
        })
        child.once("error", failedLaunch)
        if (Number.isSafeInteger(child.pid)) save(path.join(dir, `${id}.json`), { ...record, dispatch: { pid: child.pid } })
        child.unref()
      } catch {
        if (!Number.isSafeInteger(child?.pid)) failedLaunch()
      } finally {
        closeSync(log)
      }
    }
    const deadline = Date.now() + Math.max(0, Math.min(25000, waitMs))
    for (;;) {
      const operation = readRecoveryStatus({ root, env })
      if (!operation) return { state: "unresolved", reason: "custody_unknown" }
      if (!ACTIVE.has(operation.state) || Date.now() >= deadline) return outcome(operation)
      await pause(Math.min(25, Math.max(1, deadline - Date.now())))
    }
  } catch (error) {
    return { state: "unresolved", reason: error.code ?? "recovery_state_failed" }
  }
}

function rootIdentity(root) {
  const stat = statSync(root)
  const marker = path.join(root, ".git")
  const gitStat = statSync(marker)
  return digest({ root: realpathSync(root), dev: stat.dev, ino: stat.ino, gitDev: gitStat.dev, gitIno: gitStat.ino,
    gitFile: gitStat.isFile() ? readSmallText(marker, 64 * 1024) : null })
}

export { rootIdentity as captureRecoveryRootIdentity, processWitness as observeRecoveryProcess }

/** The durable dispatch names this exact worker. Acceptance is persisted before any native operation. */
export async function runRecoveryWorker({ root, env, id, acquireLock }) {
  const dir = directory(root, env)
  const file = path.join(dir, `${id}.json`)
  let record = read(file)
  const enteredAt = Date.now()
  while (record && validRecord(record, { id }, root) && record.state === "starting" &&
    !record.dispatch && Date.now() - enteredAt < 5000) {
    await pause(10)
    record = read(file)
  }
  if (!record || !validRecord(record, { id }, root) || read(path.join(dir, "active.json"))?.id !== id || record.dispatch?.pid !== process.pid) return
  let lock
  const write = (patch) => {
    record = { ...record, ...patch, updatedAt: new Date().toISOString() }
    save(file, record)
  }
  const deadline = enteredAt + record.lifetimeMs
  const matching = () => rootIdentity(root) === record.rootIdentity && recoveryBinding(root, env, { deadline }).key === record.binding.key
  const inspect = (args) => local(root, env, args, { deadline })
  try {
    if (rootIdentity(root) !== record.rootIdentity) throw Object.assign(new Error("Binding changed"), { code: "binding_changed" })
    const start = await readProcessStart(process.pid)
    if (!start || start.includes("unknown-boot")) {
      write({ state: "unknown", custody: "unknown", owner: { pid: process.pid, start: null }, reason: "owner_generation_unavailable" })
      return
    }
    settlementOwnerStart = start
    write({ state: "accepted", custody: "accepted", owner: { pid: process.pid, start }, acceptedAt: new Date().toISOString() })
    const binding = recoveryBinding(root, env, { deadline })
    if (binding.nothingToSync) {
      write({ state: "synced", binding, nothingToSync: binding.nothingToSync })
      return
    }
    write({ binding })
    if (!path.isAbsolute(binding.fetch) && !binding.fetch.startsWith("file://")) {
      throw Object.assign(new Error("Native network transport requires qualification"), { code: "native_transport_not_qualified" })
    }
    if (!binding.referenceHook.qualified) {
      throw Object.assign(new Error("Native reference hooks require qualification"), { code: "native_hooks_not_qualified" })
    }
    lock = await acquireLock({ root, env })
    if (!lock || lock.refused) throw Object.assign(new Error("Another worker owns synchronization"), { code: "sync_owner_busy" })
    write({ state: "running" })
    const head = inspect(["rev-parse", "HEAD"])
    write({ source: { state: "not_applied", head } })
    if (!matching()) throw Object.assign(new Error("Binding changed"), { code: "binding_changed" })
    const ref = `refs/desk-recovery/${id}/incoming`
    write({ incoming: { state: "dispatched", ref }, resources: { childrenClosed: false } })
    const args = ["fetch", "--no-tags", "--no-write-fetch-head", "--no-auto-maintenance", "--recurse-submodules=no"]
    if (record.binding.uploadpack) args.push(`--upload-pack=${record.binding.uploadpack}`)
    args.push("--", record.binding.fetch, `${record.binding.merge}:${ref}`)
    const childStarted = (_pid, resources) => write({ resources })
    let fetched
    const fetchAttempts = []
    for (let attempt = 0; attempt < 2; attempt += 1) {
      write({ incoming: { state: "dispatched", ref, attempt: attempt + 1, attempts: [...fetchAttempts] } })
      fetched = await ownedCommand("git", ["-C", root, ...args], env, deadline, true, childStarted)
      const observed = { attempt: attempt + 1, status: fetched.status, requestSent: fetched.requestSent,
        error: fetched.error ?? fetched.spawnError ?? null, native: fetched.resources }
      fetchAttempts.push(observed)
      write({ resources: fetched.resources, incoming: { state: "unknown", ref, attempts: [...fetchAttempts] } })
      if (!fetched.resources.childrenClosed) {
        write({ state: "unknown", reason: "helper_closure_unknown" })
        return
      }
      if (fetched.cancelled) {
        write({ state: "blocked", reason: "owner_shutdown" })
        return
      }
      if (fetched.status === 0) break
      const lostController = ["native_outcome_unknown", "watchdog_lost", "native_owner_terminated"].includes(fetched.error)
      if (!lostController || attempt !== 0 || Date.now() + 2000 >= deadline) break
      if (!matching()) throw Object.assign(new Error("Binding changed"), { code: "binding_changed" })
      const present = local(root, env, ["show-ref", "--verify", "--quiet", ref], { absent: true, deadline })
      if (present === null) observed.readback = { state: "ref_absent", objectEffects: "unknown" }
      else {
        const head = inspect(["rev-parse", ref])
        inspect(["cat-file", "-e", `${head}^{commit}`])
        observed.readback = { state: "ref_present", head }
      }
      // Fetch only updates this attempt's private ref; it does not replay a publication or source application.
      write({ incoming: { state: "unknown", ref, attempts: [...fetchAttempts] } })
    }
    if (fetched.status !== 0) {
      write({ state: "blocked", reason: fetched.timedOut ? "recovery_deadline" : fetched.error ?? fetched.spawnError ?? "fetch_failed",
        incoming: { state: fetchAttempts.some((attempt) => attempt.requestSent) ? "unknown" : "not_dispatched",
          ref, status: fetched.status, native: fetched.resources, attempts: [...fetchAttempts],
          error: redactCredentialLikeText(fetched.stderr).split("\n").find((line) => line.trim())?.slice(0, 300) ?? null } })
      return
    }
    if (!matching()) throw Object.assign(new Error("Binding changed"), { code: "binding_changed" })
    const remoteHead = inspect(["rev-parse", ref])
    const currentHead = inspect(["rev-parse", "HEAD"])
    const current = currentHead === remoteHead
    const sameRoute = record.binding.push === record.binding.fetch
    const pointers = local(root, env, ["grep", "-I", "-l", "^version https://git-lfs.github.com/spec/v1$", "HEAD", "--"], { absent: true, deadline })
    const lfsRequired = pointers !== null
    const reason = !current ? "writer_custody_required" : !sameRoute ? "delivery_route_verification_required" : lfsRequired ? "lfs_custody_required" : null
    const settlement = {
      state: reason === null ? "synced" : "blocked", reason,
      incoming: { state: "verified", ref, head: remoteHead, native: fetched.resources, attempts: [...fetchAttempts] },
      outgoing: { state: !sameRoute ? "unknown" : current ? "verified" : "not_dispatched" },
      source: { state: current ? "current" : "blocked", head: currentHead },
      lfs: { state: lfsRequired ? "not_verified" : "not_required" },
    }
    write(settlement)
  } catch (error) {
    write({ state: record.resources.childrenClosed ? "blocked" : "unknown", reason: error.code ?? "recovery_failed" })
  } finally {
    if (record.bootChecks && !["owner_shutdown", "rebase_in_progress", "sync_operation_unverified"].includes(record.reason) &&
      record.resources.childrenClosed && record.custody === "accepted" && Date.now() < deadline) {
      const settlement = record
      const attempts = []
      const bootScript = fileURLToPath(new URL("../../scripts/session-boot.js", import.meta.url))
      const args = [bootScript, "--background", "--json"]
      if (record.taskQuery) args.push("--task", record.taskQuery)
      if (record.taskOnly) args.push("--task-only")
      for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
        let retry = false
        write({ state: "running", checks: { state: "running", attempt: attempt + 1, attempts: [...attempts] } })
        try {
          if (rootIdentity(root) !== record.rootIdentity || (record.binding && !matching())) {
            write({ ...settlement, checks: { state: "blocked", reason: "binding_changed" } })
          } else {
            const inspected = await ownedCommand(process.execPath, args, { ...env, DESK: record.root }, deadline, true,
              (_pid, resources) => write({ resources }))
            write({ resources: inspected.resources })
            if (!inspected.resources.childrenClosed) {
              write({ state: "unknown", reason: "helper_closure_unknown", checks: { state: "unknown" } })
            } else if (inspected.cancelled) {
              write({ ...settlement, state: "blocked", reason: "owner_shutdown", resources: inspected.resources,
                source: { ...settlement.source, state: "unknown" }, outgoing: { state: "unknown" },
                checks: { state: "blocked", reason: "owner_shutdown" } })
            } else if (inspected.status !== 0 || inspected.outputTruncated) {
              write({ ...settlement, resources: inspected.resources, checks: { state: "blocked", reason: inspected.timedOut ? "recovery_deadline" : "inspection_failed" } })
            } else {
              const boot = JSON.parse(inspected.stdout)
              const receipt = `${id}.boot-${attempt + 1}.json`
              save(path.join(dir, receipt), boot)
              const unchanged = rootIdentity(root) === record.rootIdentity && (!record.binding || matching())
              const incomplete = boot.migrations?.some((migration) => ["unchecked", "bash_unavailable"].includes(migration.state))
              const pending = boot.migrations?.some((migration) => ["pending", "agent_work", "run", "restart", "held", "unknown"].includes(migration.state))
              const reason = !unchanged ? "binding_changed" : incomplete ? "migration_check_incomplete" : pending ? "migration_pending" : null
              attempts.push({ attempt: attempt + 1, reason, native: inspected.resources, receipt })
              write({ ...settlement, resources: inspected.resources,
                checks: { state: !unchanged || incomplete || pending ? "blocked" : boot.status, receipt, attempts: [...attempts],
                  migration: incomplete ? "unknown" : pending ? "pending" : "current",
                  ...(reason ? { reason } : {}) } })
              retry = unchanged && incomplete && inspected.resources.childrenClosed && attempt === 0 && Date.now() + 2000 < deadline
            }
          }
        } catch (error) {
          write({ ...settlement, resources: record.resources, checks: { state: "unknown", reason: error.code ?? "invalid_inspection_result" } })
        }
        if (!retry || record.state === "unknown" || record.reason === "owner_shutdown") break
      }
    }
    if (record.bootChecks && record.binding && record.resources.childrenClosed && record.source.state === "current") {
      try {
        if (!matching()) throw Object.assign(new Error("Binding changed"), { code: "binding_changed" })
        const head = inspect(["rev-parse", "HEAD"])
        if (head !== record.source.head) {
          write({ state: "blocked", reason: record.reason ?? "local_source_changed",
            source: { state: "blocked", head }, outgoing: { state: "not_dispatched" } })
        }
      } catch (error) {
        write({ state: "blocked", reason: error.code === "binding_changed" ? "binding_changed" : record.reason ?? "source_readback_incomplete",
          source: { ...record.source, state: "unknown", error: error.code ?? "inspection_failed" },
          outgoing: { state: "unknown" } })
      }
    }
    lock?.release?.()
    if (record.resources.childrenClosed && record.state !== "unknown") {
      save(path.join(dir, "latest.json"), { id })
      if (read(path.join(dir, "active.json"))?.id === id) unlinkSync(path.join(dir, "active.json"))
    }
    write({ finalized: true })
  }
}

function ownedCommand(command, args, env, deadline, capture = false, onSpawn = () => {}) {
  return runOwnedProcess({ command, args, env, deadline, capture,
    inspection: command === process.execPath && args.includes("--background"),
    ownSignals: true,
    onResource: (resources) => onSpawn(resources.childPid, resources) })
}

function groupInventory(group, exclude = [], { timeout = 250 } = {}) {
  const selector = process.platform === "linux" ? "-s" : "-g"
  const result = spawnSync("/bin/ps", [selector, String(group), "-o", "pgid=,pid=,stat=,lstart="], {
    encoding: "utf8", timeout: Math.max(1, Math.min(250, timeout)), killSignal: "SIGKILL", windowsHide: true,
    env: { PATH: "/usr/bin:/bin", TZ: "UTC", LC_ALL: "C" },
  })
  if (result.status === 1 && !result.stdout?.trim() && !result.stderr?.trim()) return { known: true, members: [], defunct: [] }
  if (result.status !== 0) return { known: false, members: null }
  const parsed = result.stdout.split("\n").filter((line) => line.trim() !== "")
    .map((line) => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.+)\s*$/u.exec(line))
  if (parsed.some((row) => row === null)) return { known: false, members: null }
  const rows = parsed.map((row) => ({ pid: Number(row[2]), group: Number(row[1]), state: row[3], started: row[4].trim() }))
  const owned = rows
    .filter((row) => row.pid !== result.pid && !exclude.includes(row.pid))
  // Defunct processes have exited and hold no executable work; retain their kernel records separately.
  return { known: true, members: owned.filter((row) => !/^[ZX]/u.test(row.state)),
    defunct: owned.filter((row) => /^[ZX]/u.test(row.state)), observerPid: result.pid, selectedRows: rows }
}

export function inspectionContainment(env = process.env) {
  if (!env.DESK_RECOVERY_CONTAINER) return null
  const record = JSON.parse(env.DESK_RECOVERY_CONTAINER)
  const owner = processWitness(record.pid)
  const self = processWitness(process.pid)
  if (owner.state !== "present" || owner.start !== record.start || owner.group !== record.pid ||
    self.state !== "present" || self.parentPid !== record.pid || self.group !== record.pid) {
    throw Object.assign(new Error("Inspection container is not owned"), { code: "inspection_custody_unknown" })
  }
  return record
}

async function bootstrapIdentity(pids, deadline, token) {
  let observed = new Map()
  let attempt = 0
  while (process.connected && Date.now() < deadline) {
    observed = processWitnesses(pids, { timeout: Math.min(1000, Math.max(1, deadline - Date.now())) })
    const witnesses = pids.map((pid) => ({ pid, ...observed.get(pid) }))
    if (process.connected) process.send({ kind: "bootstrap", token, phase: "identity_probe", attempt: ++attempt,
      witnesses, remainingMs: deadline - Date.now(), ageMs: Date.now() - performance.timeOrigin }, () => {})
    if (witnesses.every((witness) => witness.state === "present") ||
      witnesses.some((witness) => witness.state === "absent")) return observed
    await pause(Math.min(25, Math.max(1, deadline - Date.now())))
  }
  return observed
}

export async function runNativeWatchdogCli({ token } = {}) {
  if (!process.connected || !UUID.test(token ?? "")) return 1
  const bootstrapDeadline = Date.now() + 5000
  const observed = await bootstrapIdentity([process.pid, process.ppid], bootstrapDeadline, token)
  const self = observed.get(process.pid) ?? { state: "unknown" }
  const owner = observed.get(self.parentPid) ?? { state: "unknown" }
  if (!process.connected || self.state !== "present" || owner.state !== "present" || owner.group !== owner.pid || self.group !== owner.pid) {
    if (process.connected) process.disconnect()
    return 1
  }
  return new Promise((resolve) => {
    let finished = false
    // This process remains a member of this owned group. Its live membership prevents PGID reuse.
    const stop = () => { if (!finished) process.kill(-self.group, "SIGKILL") }
    let timer = setTimeout(stop, Math.max(1, bootstrapDeadline - Date.now()))
    process.once("disconnect", stop)
    process.once("SIGTERM", stop)
    process.once("SIGINT", stop)
    process.on("message", (message) => {
      if (message?.token !== token) return
      if (message.kind === "arm" && Number.isFinite(message.deadline) && message.ownerStart === owner.start) {
        clearTimeout(timer)
        timer = setTimeout(stop, Math.max(1, Math.min(120000, message.deadline - Date.now())))
        process.send({ kind: "armed", token }, (error) => { if (error) stop() })
      } else if (message.kind === "release") {
        finished = true
        clearTimeout(timer)
        process.off("disconnect", stop)
        process.off("SIGTERM", stop)
        process.off("SIGINT", stop)
        if (process.connected) process.disconnect()
        resolve(0)
      }
    })
    process.send({ kind: "ready", token, pid: self.pid, group: self.group, start: self.start, ownerStart: owner.start },
      (error) => { if (error) stop() })
  })
}

/** The native owner is its own exclusive session leader; no other process's numeric PID is signaled. */
export async function runNativeOwnerCli({ token, env = process.env } = {}) {
  if (!process.connected || !UUID.test(token ?? "")) return 1
  const bootstrapDeadline = Date.now() + 5000
  const observed = await bootstrapIdentity([process.pid], bootstrapDeadline, token)
  const self = observed.get(process.pid) ?? { state: "unknown" }
  if (!process.connected || self.state !== "present" || self.group !== process.pid) {
    if (process.connected) process.send({ kind: "refused", token, reason: "native_owner_identity_unavailable" },
      () => { if (process.connected) process.disconnect() })
    return 1
  }
  return new Promise((resolve) => {
    let started = false
    let finished = false
    let stopping = false
    let resultReady = false
    let watchdog
    let watchdogWitness
    let releasingWatchdog = false
    let armed
    let timer
    let watchdogStderr = ""
    const stop = (reason) => {
      if (finished || stopping) return
      stopping = true
      const terminate = () => process.kill(-process.pid, "SIGKILL")
      if (process.connected) process.send({ kind: "stopping", token, reason }, terminate)
      else terminate()
    }
    const disconnect = () => stop("parent_disconnected")
    const signal = () => stop("native_owner_terminated")
    process.once("disconnect", disconnect)
    process.once("SIGTERM", signal)
    process.once("SIGINT", signal)
    timer = setTimeout(() => stop("grant_not_received"), Math.max(1, bootstrapDeadline - Date.now()))
    process.on("message", async (message) => {
      if (message?.token !== token) return
      if (message.kind === "release" && resultReady && !releasingWatchdog) {
        releasingWatchdog = true
        watchdog.send({ kind: "release", token }, (error) => { if (error) stop("watchdog_release_failed") })
        watchdog.once("close", () => {
          finished = true
          clearTimeout(timer)
          process.off("disconnect", disconnect)
          process.off("SIGTERM", signal)
          process.off("SIGINT", signal)
          if (process.connected) process.disconnect()
          resolve(0)
        })
        return
      }
      if (message.kind === "cancel") {
        stop(["deadline", "owner_shutdown"].includes(message.reason) ? message.reason : "cancelled")
        return
      }
      if (message.kind !== "run" || started) return
      started = true
      clearTimeout(timer)
      if (message.deadline <= Date.now()) { stop("deadline"); return }
      const duration = Math.max(1, Math.min(120000, message.deadline - Date.now()))
      timer = setTimeout(() => stop("deadline"), duration)
      if (typeof message.command !== "string" || !Array.isArray(message.args) ||
        message.args.some((arg) => typeof arg !== "string") || !Number.isFinite(message.deadline)) {
        stop("invalid_native_request")
        return
      }
      await new Promise((ready) => {
        armed = ready
        watchdog.send({ kind: "arm", token, deadline: message.deadline, ownerStart: self.start }, (error) => { if (error) stop("watchdog_arm_failed") })
      })
      if (stopping || finished || Date.now() >= message.deadline) { stop("deadline"); return }
      const commandEnv = { ...env, GIT_TERMINAL_PROMPT: "0",
        ...(message.inspection ? { DESK_RECOVERY_CONTAINER: JSON.stringify({ pid: self.pid, start: self.start, token, deadline: message.deadline }) } : {}) }
      const settle = async (result) => {
        let descendantsUntil
        let inventory
        do {
          if (descendantsUntil !== undefined && Date.now() >= descendantsUntil) { stop("descendants_outlived_command"); return }
          const observationUntil = descendantsUntil ?? message.deadline
          inventory = groupInventory(process.pid, [process.pid, watchdog.pid], { timeout: observationUntil - Date.now() })
          if (descendantsUntil !== undefined && Date.now() >= descendantsUntil) { stop("descendants_outlived_command"); return }
          if (inventory.known && inventory.members.length === 0) break
          if (inventory.known) {
            descendantsUntil ??= Math.min(message.deadline, Date.now() + 250)
          }
          if (process.connected) process.send({ kind: "bootstrap", token, phase: "closure_probe",
            known: inventory.known, memberCount: inventory.members?.length ?? null,
            remainingMs: message.deadline - Date.now() }, () => {})
          const remaining = Math.min(message.deadline, descendantsUntil ?? message.deadline) - Date.now()
          if (remaining > 0) await pause(Math.min(inventory.known ? 25 : 250, remaining))
        } while (Date.now() < message.deadline)
        if (!inventory.known || inventory.members.length > 0) { stop("helper_closure_unknown"); return }
        resultReady = true
        process.send({ kind: "result", token, ...result }, (error) => { if (error) stop("parent_disconnected") })
      }
      try {
        const child = spawn(message.command, message.args, { cwd: message.cwd, env: commandEnv,
          detached: false, windowsHide: true, stdio: ["ignore", "inherit", "inherit"] })
        let failed = false
        child.once("error", (error) => { failed = true; void settle({ status: null, spawnError: error.code ?? "spawn_failed" }) })
        child.once("exit", (status, signal) => { if (!failed) void settle({ status, signal }) })
      } catch (error) {
        void settle({ status: null, spawnError: error.code ?? "spawn_failed" })
      }
    })
    watchdog = spawn(process.execPath, [SCRIPT, "--native-watchdog", token], {
      env, detached: false, windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"],
    })
    watchdog.stderr.on("data", (chunk) => { watchdogStderr = (watchdogStderr + chunk.toString()).slice(0, 2048) })
    watchdog.once("error", () => stop("watchdog_unavailable"))
    watchdog.once("exit", (code, signal) => {
      if (process.connected) process.send({ kind: "bootstrap", token, phase: "watchdog_exit", pid: watchdog.pid,
        code, signal, stderr: redactCredentialLikeText(watchdogStderr) }, () => {})
      if (!releasingWatchdog) stop("watchdog_lost")
    })
    watchdog.on("message", (message) => {
      if (message?.token !== token) return
      if (message.kind === "bootstrap") {
        if (process.connected) process.send({ ...message, pid: watchdog.pid, phase: `watchdog_${message.phase}` }, () => {})
      } else if (message.kind === "ready" && message.pid === watchdog.pid && message.group === self.group && message.ownerStart === self.start) {
        watchdogWitness = { pid: message.pid, start: message.start, group: message.group }
        process.send({ kind: "ready", token, pid: self.pid, group: self.group, start: self.start, watchdog: watchdogWitness },
          (error) => { if (error) stop("parent_disconnected") })
      } else if (message.kind === "armed") {
        armed?.()
        armed = null
      }
    })
  })
}

export async function runOwnedProcess({
  command, args, env = process.env, cwd, deadline, capture = true, maxOutput = 1024 * 1024,
  containment = null, inspection = false, spawnImpl = spawn, onResource = () => {}, ownSignals = false,
}) {
  if (deadline <= Date.now()) return { status: null, timedOut: true, stdout: "", stderr: "", resources: { childrenClosed: true } }
  return new Promise((resolve) => {
    const token = randomUUID()
    const stdout = []
    const stderr = []
    let size = 0
    let finished = false
    let timedOut = false
    let cancelled = false
    let outcome
    let witness = null
    let watchdogWitness = null
    let sent = false
    let grace
    let exitSeen = false
    let closeSeen = false
    let closureProof
    let outputTruncated = false
    const bootstrap = []
    let child
    const resource = (childrenClosed, inventory) => ({ childPid: child?.pid ?? null, start: witness?.start ?? null,
      group: containment?.pid ?? child?.pid ?? null, token, childrenClosed, exitObserved: exitSeen,
      scope: containment ? "contained-child" : "native-owner",
      ...(bootstrap.length ? { bootstrap: [...bootstrap] } : {}),
      ...(watchdogWitness ? { watchdog: watchdogWitness } : {}),
      resultReceived: outcome?.kind === "result",
      phase: childrenClosed ? "closed" : exitSeen || outcome?.kind === "result" ? "settling" : witness ? "accepted" : "unaccepted",
      ...(containment ? { containedBy: containment } : {}), ...(inventory ? { inventory } : {}) })
    const finish = (result, childrenClosed, inventory) => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      clearTimeout(grace)
      process.off("SIGTERM", terminated)
      process.off("SIGINT", terminated)
      if (!childrenClosed && !containment) {
        child?.unref()
        child?.stdout?.unref?.()
        child?.stderr?.unref?.()
      }
      resolve({ status: result?.status ?? null, signal: result?.signal ?? null, spawnError: result?.spawnError,
        error: result?.error, timedOut: timedOut || Date.now() >= deadline, cancelled,
        stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"),
        requestSent: sent, outputTruncated, resources: resource(childrenClosed, inventory) })
    }
    const cancel = (reason = "cancelled") => {
      timedOut ||= reason === "deadline"
      cancelled ||= reason === "owner_shutdown"
      if (containment) child?.kill?.("SIGKILL")
      else if (child?.connected) child.send({ kind: "cancel", token, reason }, (error) => { if (error && child.connected) child.disconnect() })
      grace = setTimeout(() => finish({ error: "helper_closure_unknown" }, false), 1500)
    }
    const terminated = () => cancel("owner_shutdown")
    const timer = setTimeout(() => cancel("deadline"), Math.max(1, deadline - Date.now()))
    const proveClosure = () => {
      closureProof ??= (async () => {
        const proofDeadline = Date.now() + 1000
        let inventory
        do {
          inventory = groupInventory(child.pid)
          if (inventory.known && inventory.members.length === 0) return { closed: true, inventory }
          await pause(25)
        } while (!finished && Date.now() < proofDeadline)
        return { closed: false, inventory }
      })()
      return closureProof
    }
    if (ownSignals) {
      process.once("SIGTERM", terminated)
      process.once("SIGINT", terminated)
    }
    try {
      child = containment
        ? spawnImpl(command, args, { cwd, env, detached: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] })
        : spawnImpl(process.execPath, [SCRIPT, "--native-owner", token], {
          cwd, env, detached: true, windowsHide: true, stdio: ["ignore", capture ? "pipe" : "ignore", capture ? "pipe" : "ignore", "ipc"],
        })
      onResource(resource(false))
      const collect = (into) => (chunk) => {
        const bytes = Buffer.from(chunk)
        const remaining = Math.max(0, maxOutput - size)
        if (remaining > 0) into.push(bytes.subarray(0, remaining))
        size += bytes.length
        if (size > maxOutput) outputTruncated = true
      }
      child.stdout?.on("data", collect(stdout))
      child.stderr?.on("data", collect(stderr))
      child.once("error", (error) => finish({ spawnError: error.code ?? "spawn_failed" }, true))
      if (!containment) child.on("message", (message) => {
        if (message?.token !== token || finished) return
        if (message.kind === "bootstrap") {
          if (bootstrap.length < 32) bootstrap.push(message)
          onResource(resource(false))
        } else if (message.kind === "ready" && message.pid === child.pid && message.group === child.pid && typeof message.start === "string" &&
          Number.isSafeInteger(message.watchdog?.pid) && typeof message.watchdog?.start === "string" && message.watchdog.group === child.pid) {
          if (Date.now() >= deadline) { cancel("deadline"); return }
          witness = { start: message.start }
          watchdogWitness = message.watchdog
          onResource(resource(false))
          sent = true
          child.send({ kind: "run", token, command, args, cwd, deadline, inspection }, (error) => { if (error && child.connected) child.disconnect() })
        } else if (message.kind === "result") {
          outcome = message
          onResource(resource(false))
          child.send({ kind: "release", token }, (error) => { if (error && child.connected) child.disconnect() })
        }
        else if (message.kind === "stopping" || message.kind === "refused") {
          timedOut ||= message.reason === "deadline"
          outcome = { status: null, error: message.reason }
        }
      })
      child.once("exit", async (status, signal) => {
        exitSeen = true
        onResource(resource(false))
        if (containment) finish({ status, signal }, false)
        else {
          const proof = await proveClosure()
          if (finished) return
          if (!proof.closed) finish({ error: "helper_closure_unknown" }, false, proof.inventory)
          else if (!closeSeen) grace = setTimeout(() => finish({ error: "stdio_closure_unknown" }, false, proof.inventory), 1000)
        }
      })
      child.once("close", async (status, signal) => {
        if (finished) return
        exitSeen = true
        closeSeen = true
        if (containment) { finish({ status, signal }, false); return }
        clearTimeout(timer)
        clearTimeout(grace)
        const proof = await proveClosure()
        finish(outcome ?? { status: null, error: sent ? "native_outcome_unknown" : "native_owner_unavailable", signal }, proof.closed, proof.inventory)
      })
    } catch (error) {
      if (child?.connected) child.disconnect()
      finish({ spawnError: error.code ?? "spawn_failed" }, !child?.pid)
    }
  })
}
