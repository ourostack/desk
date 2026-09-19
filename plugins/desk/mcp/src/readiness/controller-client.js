import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import { controllerIdentity, deriveControllerEndpoint, stableStringify, validatePrivateDirectory } from "./identity.js"
import { requestMessage } from "./protocol.js"
import { startReadinessController } from "./controller-server.js"

const localControllers = new Map()
const controllerStarts = new Map()

export async function connectOrStartController({
  root,
  protocolVersion = 1,
  lexicalContract = {},
  semanticContract = null,
  stateHome = path.join(os.homedir(), ".cache", "ouroboros-skills", "desk", "readiness"),
  handlers,
  watcher,
  ephemeral = false,
} = {}) {
  const identity = controllerIdentity({ root, protocolVersion, lexicalContract, semanticContract })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") validatePrivateDirectory(stateDir)
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
  if (local) {
    local.clients += 1
  }
  const token = readControllerToken({ identity, stateDir })
  const handshake = await request({
    endpoint,
    identity,
    method: "handshake",
    params: { token },
  })
  if (!handshake.accepted) {
    throw new Error("readiness controller protocol handshake rejected")
  }
  return createClient({ endpoint, ephemeral, identity, local, token })
}

async function startOrReuseController({
  endpoint,
  ephemeral,
  handlers,
  watcher,
  identity,
  stateDir,
}) {
  const existing = await tryHandshake({ endpoint, identity, stateDir })
  if (existing?.accepted) {
    return
  }
  if (process.platform !== "win32" && endpointIsReclaimable({ endpoint, identity, stateDir })) {
    unlinkSync(endpoint)
  }
  try {
    const controller = await startReadinessController({
      identity,
      endpoint,
      stateDir,
      handlers,
      watcher,
      ephemeral,
    })
    localControllers.set(identity.id, { controller, clients: 0 })
  } catch (error) {
    if (error?.code !== "EADDRINUSE") {
      throw error
    }
    await waitForHandshake({ endpoint, identity, stateDir })
  }
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
  } catch {
    return null
  }
}

async function waitForHandshake({ endpoint, identity, stateDir }) {
  let lastError
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const result = await tryHandshake({ endpoint, identity, stateDir })
      if (result?.accepted) return result
    } catch (error) {
      lastError = error
    }
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw lastError ?? new Error("readiness controller election did not converge")
}

function readControllerToken({ identity, stateDir }) {
  if (process.platform !== "win32") validatePrivateDirectory(stateDir)
  const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  if (stableStringify(record.identity) !== stableStringify(identity) || typeof record.owner?.token !== "string") {
    throw new Error("readiness controller owner record is invalid")
  }
  return record.owner.token
}

function endpointIsReclaimable({ endpoint, identity, stateDir }) {
  try {
    validatePrivateDirectory(stateDir)
    validatePrivateDirectory(path.dirname(endpoint))
    const stat = lstatSync(endpoint)
    if (!stat.isSocket() || stat.uid !== process.getuid()) return false
    const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
    if (stableStringify(record.identity) !== stableStringify(identity)
      || record.endpoint !== endpoint || record.socket?.dev !== stat.dev || record.socket?.ino !== stat.ino
      || !Number.isInteger(record.owner?.pid) || record.owner.pid <= 0) {
      return false
    }
    try {
      process.kill(record.owner.pid, 0)
      return false
    } catch (error) {
      return error?.code === "ESRCH"
    }
  } catch {
    return false
  }
}

function request({
  endpoint,
  identity,
  method,
  params = {},
  timeoutMs = 2_000,
  signal,
}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return }
    const socket = net.createConnection(endpoint)
    const abort = () => { socket.destroy(); reject(signal.reason) }
    signal?.addEventListener("abort", abort, { once: true })
    const id = randomUUID()
    let pending = ""
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
        },
      }))}\n`)
    })
    socket.on("data", (chunk) => {
      pending += chunk
      const newline = pending.indexOf("\n")
      if (newline < 0) return
      clearTimeout(timeout)
      socket.end()
      const response = JSON.parse(pending.slice(0, newline))
      if (response.error) {
        reject(new Error(response.error.message))
      } else {
        resolve(response.result)
      }
    })
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
