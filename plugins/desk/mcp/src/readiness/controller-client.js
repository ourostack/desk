import { randomUUID } from "node:crypto"
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs"
import * as net from "node:net"
import * as os from "node:os"
import * as path from "node:path"

import { controllerIdentity } from "./identity.js"
import { requestMessage } from "./protocol.js"
import { startReadinessController } from "./controller-server.js"

const localControllers = new Map()
const controllerStarts = new Map()

export async function connectOrStartController({
  root,
  protocolVersion = 1,
  lexicalContract = {},
  stateHome = path.join(os.homedir(), ".cache", "ouroboros-skills", "desk", "readiness"),
  handlers,
  ephemeral = false,
} = {}) {
  const identity = controllerIdentity({ root, protocolVersion, lexicalContract })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\desk-readiness-${identity.user.username}-${identity.id}`
    : path.join(stateDir, "controller.sock")

  let local = localControllers.get(identity.id)
  if (!local) {
    let start = controllerStarts.get(identity.id)
    if (!start) {
      start = startOrReuseController({
        endpoint,
        ephemeral,
        handlers,
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
  identity,
  stateDir,
}) {
  const existing = await tryHandshake({ endpoint, identity, stateDir })
  if (existing?.accepted) {
    return
  }
  if (process.platform !== "win32" && endpointIsReclaimable({ identity, stateDir })) {
    rmSync(endpoint, { force: true })
  }
  try {
    const controller = await startReadinessController({
      identity,
      endpoint,
      stateDir,
      handlers,
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
  const call = (method, params = {}) => request({
    endpoint,
    identity,
    method,
    params: { ...params, token },
  })
  return {
    accepted: true,
    id: identity.id,
    identity,
    status: () => call("status"),
    beginConvergence: () => call("beginConvergence"),
    barrier: (params) => call("barrier", params),
    recordChange: (changedPath) => call("recordChange", { path: changedPath }),
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
  const stat = statSync(stateDir)
  if (process.platform !== "win32" && stat.uid !== process.getuid()) {
    throw new Error("readiness controller state directory has unsafe ownership")
  }
  const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
  if (record.identity?.id !== identity.id || typeof record.owner?.token !== "string") {
    throw new Error("readiness controller owner record is invalid")
  }
  return record.owner.token
}

function endpointIsReclaimable({ identity, stateDir }) {
  try {
    const record = JSON.parse(readFileSync(path.join(stateDir, "owner.json"), "utf8"))
    if (record.identity?.id !== identity.id || !Number.isInteger(record.owner?.pid)) {
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
}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(endpoint)
    const id = randomUUID()
    let pending = ""
    const timeout = setTimeout(() => {
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
  })
}
