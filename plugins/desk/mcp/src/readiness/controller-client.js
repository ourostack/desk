import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync } from "node:fs"
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
} = {}) {
  const identity = controllerIdentity({ root, protocolVersion, lexicalContract })
  const stateDir = path.join(stateHome, identity.id)
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const endpoint = process.platform === "win32"
    ? `\\\\.\\pipe\\desk-readiness-${identity.id}`
    : path.join(stateDir, "controller.sock")

  let local = localControllers.get(identity.id)
  if (!local) {
    let start = controllerStarts.get(identity.id)
    if (!start) {
      start = startOrReuseController({
        endpoint,
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

  async function startOrReuseController({
    endpoint,
    handlers,
    identity,
    stateDir,
  }) {
    const existing = await tryHandshake({ endpoint, identity })
    if (existing?.accepted) {
      return
    }
    if (process.platform !== "win32") {
      rmSync(endpoint, { force: true })
    }
    const controller = await startReadinessController({
      identity,
      endpoint,
      stateDir,
      handlers,
    })
    localControllers.set(identity.id, { controller, clients: 0 })
  }
  const handshake = await request({ endpoint, identity, method: "handshake", params: { identity } })
  if (!handshake.accepted) {
    throw new Error("readiness controller protocol handshake rejected")
  }
  return createClient({ endpoint, identity, local })
}

function createClient({ endpoint, identity, local }) {
  let closed = false
  return {
    accepted: true,
    id: identity.id,
    identity,
    status: () => request({ endpoint, identity, method: "status" }),
    beginConvergence: () => request({ endpoint, identity, method: "beginConvergence" }),
    barrier: (params) => request({ endpoint, identity, method: "barrier", params }),
    recordChange: (changedPath) => request({
      endpoint,
      identity,
      method: "recordChange",
      params: { path: changedPath },
    }),
    async close() {
      if (closed) return
      closed = true
      if (!local) return
      local.clients -= 1
      if (local.clients === 0) {
        localControllers.delete(identity.id)
        await local.controller.close()
      }
    },
  }
}

async function tryHandshake({ endpoint, identity }) {
  try {
    return await request({
      endpoint,
      identity,
      method: "handshake",
      params: { identity },
      timeoutMs: 100,
    })
  } catch {
    return null
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
      socket.write(`${JSON.stringify(requestMessage({ id, method, params: {
        ...params,
        identity: identity.id,
      } }))}\n`)
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
