import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import {
  controllerIdentity, deriveControllerEndpoint, lexicalControllerIdentity,
  semanticContractDiagnostic, stableStringify, validatePrivateDirectory,
} from "./identity.js"
import { ownerState } from "./owner-record.js"
import { requestMessage } from "./protocol.js"
import { startReadinessController } from "./controller-server.js"

const localControllers = new Map()
const ABANDONED_RECHECK_MS = 50
// A running owner that is only busy gets one longer handshake before the session gives up on it for this attempt.
const LIVE_OWNER_HANDSHAKE_MS = 1000
const controllerStarts = new Map()
const privateDirectoryValidators = {
  win32: Object,
  darwin: validatePrivateDirectory,
  linux: validatePrivateDirectory,
}
// Named pipes on Windows have no directory mode to tighten.
const privateDirectoryTighteners = {
  win32: Object,
  darwin: tightenPrivateDirectory,
  linux: tightenPrivateDirectory,
}

export async function connectOrStartController({
  root,
  protocolVersion = 1,
  lexicalContract = {},
  semanticContract = null,
  stateHome = path.join(os.homedir(), ".cache", "ouroboros-skills", "desk", "readiness"),
  handlers,
  watcher,
  watcherFactory,
  ephemeral = false,
  onRepair = () => {},
} = {}) {
  const identity = controllerIdentity({ root, protocolVersion, lexicalContract, semanticContract })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  privateDirectoryTighteners[process.platform](stateDir, onRepair)
  privateDirectoryValidators[process.platform](stateDir)
  const endpoint = await rendezvousEndpoint({ derived: deriveControllerEndpoint({ identity }), identity, stateDir })

  let local = localControllers.get(identity.id)
  if (!local) {
    let start = controllerStarts.get(identity.id)
    if (!start) {
      start = startOrReuseController({
        endpoint,
        ephemeral,
        handlers,
        watcher,
        watcherFactory,
        identity,
        stateDir,
      })
      controllerStarts.set(identity.id, start)
    }
    try {
      await start
    } finally {
      if (controllerStarts.get(identity.id) === start) {
        controllerStarts.delete(identity.id)
      }
    }
  }
  local = localControllers.get(identity.id)
  const token = readControllerToken({ identity, stateDir })
  const handshake = await request({
    endpoint,
    identity,
    method: "handshake",
    params: { token },
  })
  requireCompatibleHandshake(handshake, identity)
  if (local) local.clients += 1
  return createClient({ endpoint, ephemeral, identity, local, token })
}

async function startOrReuseController({
  endpoint,
  ephemeral,
  handlers,
  watcher,
  watcherFactory,
  identity,
  stateDir,
}) {
  const existing = await tryHandshake({ endpoint, identity, stateDir })
  if (existing) {
    requireCompatibleHandshake(existing, identity)
    return
  }
  if (process.platform !== "win32") {
    // A controller whose owner runs is never taken over, even when it does not answer: no unlink, no second controller. The session stays controller-free, and its hung-controller checks report it.
    const owner = ownerState({ stateDir, identity })
    if (owner.state === "live") {
      const answered = await tryHandshake({ endpoint, identity, stateDir, timeoutMs: LIVE_OWNER_HANDSHAKE_MS })
      if (answered) {
        requireCompatibleHandshake(answered, identity)
        return
      }
      throw Object.assign(new Error(`The readiness controller for this root belongs to a running process (pid ${owner.record.owner.pid}) that does not answer; Desk never starts a second controller while it runs.`), { code: "controller_owner_unresponsive", owner_pid: owner.record.owner.pid })
    }
    const stale = endpointIsReclaimable({ endpoint, owner }) ?? await endpointIsAbandoned(endpoint, { stateDir, identity })
    if (stale) unlinkIfUnchanged(endpoint, stale)
  }
  let ownedWatcher = watcher
  try {
    ownedWatcher ??= await watcherFactory?.({ root: identity.root })
    const controller = await startReadinessController({
      identity,
      endpoint,
      stateDir,
      handlers,
      watcher: ownedWatcher,
      ephemeral,
    })
    localControllers.set(identity.id, { controller, clients: 0 })
  } catch (error) {
    ownedWatcher?.close?.()
    if (!isControllerElectionCollision(error)) {
      throw error
    }
    await waitForHandshake({ endpoint, identity, stateDir })
  }
}

function isControllerElectionCollision(error) {
  return error?.code === "EADDRINUSE" || error?.code === "EEXIST"
}

function createClient({ endpoint, ephemeral, identity, local, token }) {
  let closed = false
  const call = (method, params, timeoutMs = 2_000, signal) => request({
    endpoint,
    identity,
    method,
    params: { ...params, token },
    timeoutMs,
    signal,
  })
  return {
    accepted: true,
    id: identity.id,
    identity,
    status: (timeoutMs = 2_000) => call("status", {}, timeoutMs),
    beginConvergence: () => call("beginConvergence", {}, null),
    barrier: (params) => call("barrier", params, params?.wait ? null : 2_000),
    async recordChange(change) {
      const result = await call("recordChange", typeof change === "string" ? { path: change } : change, null)
      if (result?.recorded !== true || !Number.isSafeInteger(result.sequence) || result.sequence < 1 ||
          typeof result.cursor?.journal_id !== "string" || !result.cursor.journal_id ||
          !Number.isSafeInteger(result.cursor.sequence) || result.cursor.sequence < result.sequence) {
        throw new Error("controller returned an unverifiable durable change acknowledgement")
      }
      return result
    },
    markUncertain: (reason) => call("markUncertain", { reason }),
    fenceEvents: ({ signal } = {}) => call("fenceEvents", {}, null, signal),
    async close() {
      if (closed) return
      closed = true
      if (!local) return
      local.clients -= 1
      if (ephemeral && local.clients === 0) {
        localControllers.delete(identity.id)
        await local.controller.close()
      }
    },
  }
}

async function tryHandshake({ endpoint, identity, stateDir, timeoutMs = 100 }) {
  try {
    const token = readControllerToken({ identity, stateDir })
    return await request({
      endpoint,
      identity,
      method: "handshake",
      params: { token },
      timeoutMs,
    })
  } catch (error) {
    if (error.code === "controller_semantic_mismatch") throw error
    return null
  }
}

async function waitForHandshake({ endpoint, identity, stateDir }) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const result = await tryHandshake({ endpoint, identity, stateDir })
      if (result) {
        requireCompatibleHandshake(result, identity)
        return result
      }
    } catch (error) {
      if (error.code === "controller_semantic_mismatch") throw error
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw lastError ?? new Error("readiness controller election did not converge")
}

function requireCompatibleHandshake(handshake, identity) {
  const diagnostic = handshake.diagnostic ??
    semanticContractDiagnostic(handshake.identity?.semantic_contract, identity.semantic_contract)
  if (diagnostic) {
    throw Object.assign(new Error(diagnostic.message), { code: diagnostic.code, diagnostic })
  }
  if (handshake.accepted !== true ||
      stableStringify(lexicalControllerIdentity(handshake.identity)) !== stableStringify(lexicalControllerIdentity(identity))) {
    throw new Error("readiness controller protocol handshake rejected")
  }
}

function readControllerToken({ identity, stateDir }) {
  privateDirectoryValidators[process.platform](stateDir)
  const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  if (stableStringify(lexicalControllerIdentity(record.identity)) !== stableStringify(lexicalControllerIdentity(identity)) ||
      typeof record.owner?.token !== "string") {
    throw new Error("readiness controller owner record is invalid")
  }
  return record.owner.token
}

// A socket whose recorded owner is gone (or is this process, which has no controller for the root) and that is still the exact file the owner published. Returns the socket's stat when it may be removed, otherwise null.
export function endpointIsReclaimable({ endpoint, owner }) {
  if (owner.state !== "dead" && owner.state !== "self") return null
  const record = owner.record
  try {
    validatePrivateDirectory(path.dirname(endpoint))
    const stat = lstatSync(endpoint)
    if (!stat.isSocket() || stat.uid !== process.getuid()) return null
    return record.endpoint === endpoint && record.socket?.dev === stat.dev && record.socket?.ino === stat.ino ? stat : null
  } catch {
    return null
  }
}

// A socket file of ours that nobody listens on (connecting is refused), when no running process owns it: the owner record is missing or corrupt (a crashed controller that never wrote one, or wrote it badly), or names an owner that is gone. A refused connection alone never counts: a running owner that is stopped, or whose accept queue is full, refuses too. Returns the socket's stat when it may be removed, otherwise null.
export async function endpointIsAbandoned(endpoint, { stateDir, identity = null, probe = probeEndpoint }) {
  if (ownerState({ stateDir, identity }).state === "live") return null
  let stat
  try {
    validatePrivateDirectory(path.dirname(endpoint))
    stat = lstatSync(endpoint)
  } catch {
    return null
  }
  if (!stat.isSocket() || stat.uid !== process.getuid()) return null
  // A controller that has bound its socket but not yet called listen() also refuses, so one refusal is not proof: it must refuse twice, a little apart, with the socket file unchanged and still no running owner.
  if (await probe(endpoint) !== "refused") return null
  await new Promise((resolve) => setTimeout(resolve, ABANDONED_RECHECK_MS))
  if (await probe(endpoint) !== "refused") return null
  if (ownerState({ stateDir, identity }).state === "live") return null
  try {
    const again = lstatSync(endpoint)
    return again.dev === stat.dev && again.ino === stat.ino ? stat : null
  } catch {
    return null
  }
}

// Where to meet the root's controller: the derived endpoint, unless the owner record names a different one that answers (a controller started by an older Desk that derived its socket from XDG_RUNTIME_DIR). Every session then joins the same controller.
async function rendezvousEndpoint({ derived, identity, stateDir }) {
  let recorded
  try {
    recorded = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8")).endpoint
  } catch {
    return derived
  }
  if (typeof recorded !== "string" || recorded === derived) return derived
  return await tryHandshake({ endpoint: recorded, identity, stateDir }) === null ? derived : recorded
}

export function probeEndpoint(endpoint, { timeoutMs = 250, connect = net.createConnection } = {}) {
  return new Promise((resolve) => {
    const socket = connect(endpoint)
    const finish = (result) => {
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => finish("unknown"), timeoutMs)
    socket.once("connect", () => finish("accepting"))
    socket.once("error", (error) => finish(error?.code === "ECONNREFUSED" ? "refused" : "unknown"))
  })
}

// Remove the endpoint only if it is still the file that was judged stale, so a controller that just replaced it keeps its socket.
export function unlinkIfUnchanged(endpoint, stale) {
  try {
    const now = lstatSync(endpoint)
    if (now.dev === stale.dev && now.ino === stale.ino) unlinkSync(endpoint)
  } catch {
    // Already gone: nothing to reclaim.
  }
}

// A state directory of ours with a looser mode (for example 755 from a umask) is tightened to 700. A symlink, a directory owned by someone else or anything that is not a directory is left for validation to refuse.
function tightenPrivateDirectory(directory, onRepair) {
  const stat = lstatSync(directory)
  const mode = stat.mode & 0o777
  if (!stat.isDirectory() || stat.uid !== process.getuid() || mode === 0o700) return
  chmodSync(directory, 0o700)
  onRepair({ action: "chmod_700", path: directory, from: mode.toString(8) })
}

export function createControllerResponseAccumulator(onLine) {
  let pending = ""
  return (chunk) => {
    pending += chunk
    const newline = pending.indexOf("\n")
    if (newline < 0) return
    const line = pending.slice(0, newline)
    pending = pending.slice(newline + 1)
    onLine(line)
  }
}

function request({
  endpoint,
  identity,
  method,
  params,
  timeoutMs = 2_000,
  signal,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const socket = net.createConnection(endpoint)
    const abort = () => { socket.destroy(); reject(signal.reason) }
    signal?.addEventListener("abort", abort, { once: true })
    const id = randomUUID()
    const timeout = timeoutMs === null ? null : setTimeout(() => {
      socket.destroy()
      reject(new Error(`readiness controller request timed out: ${method}`))
    }, timeoutMs)
    socket.setEncoding("utf8")
    socket.once("connect", () => {
      socket.write(`${JSON.stringify(requestMessage({
        id,
        method,
        params: {
          ...params,
          identity: identity.id,
          semantic_contract: identity.semantic_contract,
        },
      }))}\n`)
    })
    socket.on("data", createControllerResponseAccumulator((line) => {
      clearTimeout(timeout)
      socket.end()
      const response = JSON.parse(line)
      if (response.error) {
        const error = new Error(response.error.message)
        if (typeof response.error.code === "string") error.code = response.error.code
        if (typeof response.error.reason === "string") error.reason = response.error.reason
        if (response.error.diagnostic) error.diagnostic = response.error.diagnostic
        reject(error)
      } else {
        resolve(response.result)
      }
    }))
    socket.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    socket.once("close", () => {
      clearTimeout(timeout)
      signal?.removeEventListener("abort", abort)
      reject(new Error(`readiness controller connection closed: ${method}`))
    })
  })
}
