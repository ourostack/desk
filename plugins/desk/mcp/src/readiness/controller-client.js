import { randomUUID } from "node:crypto"
import { chmodSync, lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import {
  controllerIdentity, deriveControllerEndpoint, lexicalControllerIdentity,
  semanticContractDiagnostic, stableStringify, validatePrivateDirectory,
} from "./identity.js"
import { requestMessage } from "./protocol.js"
import { startReadinessController } from "./controller-server.js"

const localControllers = new Map()
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
  const endpoint = deriveControllerEndpoint({ identity })

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
  const stale = process.platform !== "win32" &&
    (endpointIsReclaimable({ endpoint, identity, stateDir }) ?? await endpointIsAbandoned(endpoint))
  if (stale) unlinkIfUnchanged(endpoint, stale)
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
  const call = (method, params = {}, timeoutMs = 2_000, signal) => request({
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
    status: () => call("status"),
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

async function tryHandshake({ endpoint, identity, stateDir }) {
  try {
    const token = readControllerToken({ identity, stateDir })
    return await request({
      endpoint,
      identity,
      method: "handshake",
      params: { token },
      timeoutMs: 100,
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

// A socket whose recorded owner is dead. Returns the socket's stat when it may be removed, otherwise null.
function endpointIsReclaimable({ endpoint, identity, stateDir }) {
  try {
    validatePrivateDirectory(stateDir)
    validatePrivateDirectory(path.dirname(endpoint))
    const stat = lstatSync(endpoint)
    const reclaimableSocket = Number(stat.isSocket()) * Number(stat.uid === process.getuid()) === 1
    if (!reclaimableSocket) return null
    const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
    if (stableStringify(lexicalControllerIdentity(record.identity)) !== stableStringify(lexicalControllerIdentity(identity))
      || record.endpoint !== endpoint || record.socket?.dev !== stat.dev || record.socket?.ino !== stat.ino
      || !Number.isInteger(record.owner?.pid) || record.owner.pid <= 0) {
      return null
    }
    try {
      process.kill(record.owner.pid, 0)
      return null
    } catch (error) {
      return error?.code === "ESRCH" ? stat : null
    }
  } catch {
    return null
  }
}

// A socket file of ours that nobody listens on (connecting is refused), whatever its owner record says: a crashed controller whose owner.json is missing or corrupt. Returns the socket's stat when it may be removed, otherwise null.
export async function endpointIsAbandoned(endpoint, probe = probeEndpoint) {
  let stat
  try {
    validatePrivateDirectory(path.dirname(endpoint))
    stat = lstatSync(endpoint)
  } catch {
    return null
  }
  if (!stat.isSocket() || stat.uid !== process.getuid()) return null
  return await probe(endpoint) === "refused" ? stat : null
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
