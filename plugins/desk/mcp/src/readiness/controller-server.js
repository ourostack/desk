import { randomUUID } from "node:crypto"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import { responseMessage } from "./protocol.js"
import { transitionReadiness } from "./state.js"

export async function startReadinessController({
  identity,
  endpoint,
  stateDir,
  handlers = {},
  ephemeral = false,
} = {}) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  const owner = {
    pid: process.pid,
    started_at: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    token: randomUUID(),
  }
  let state = "CONTROL_READY"
  const server = net.createServer((socket) => {
    let pending = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk) => {
      pending += chunk
      let newline
      while ((newline = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, newline)
        pending = pending.slice(newline + 1)
        if (line.length === 0) continue
        void handleLine(line, socket)
      }
    })
  })

  async function handleLine(line, socket) {
    let request
    try {
      request = JSON.parse(line)
      if (request.params?.token !== owner.token) {
        throw new Error("readiness controller authentication failed")
      }
      const builtin = {
        handshake: () => ({
          accepted: request.params?.identity === identity.id,
          identity,
          owner,
        }),
        status: () => ({ state, identity, owner }),
        beginConvergence: async () => {
          state = transitionReadiness(state, "LEXICAL_CONVERGING")
          try {
            const result = await handlers.beginConvergence?.()
            state = transitionReadiness(state, "LEXICAL_READY")
            return result ?? { accepted: true }
          } catch (error) {
            state = transitionReadiness(state, "RECOVERING")
            throw error
          }
        },
        barrier: () => handlers.barrier?.(request.params) ?? {
          capability: request.params?.capability,
          current: state === "LEXICAL_READY" || state === "READY",
          state,
        },
        recordChange: () => handlers.recordChange?.(request.params) ?? { recorded: true },
      }[request.method]
      if (!builtin) {
        throw new Error(`unknown readiness controller method: ${request.method}`)
      }
      const result = await builtin()
      socket.end(`${JSON.stringify(responseMessage({ id: request.id, result }))}\n`)
    } catch (error) {
      socket.end(`${JSON.stringify(responseMessage({
        id: request?.id ?? null,
        error: { message: error?.message ?? String(error) },
      }))}\n`)
    }
  }

  await listen(server, endpoint)
  try {
    writeFileSync(
      path.join(stateDir, "owner.json"),
      `${JSON.stringify({ schema_version: 1, identity, owner }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
  } catch (error) {
    await closeServer(server, endpoint, stateDir)
    throw error
  }
  if (!ephemeral) {
    server.unref()
  }
  return {
    identity,
    owner,
    server,
    close: () => closeServer(server, endpoint, stateDir),
  }
}

function listen(server, endpoint) {
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(endpoint, () => {
      server.off("error", reject)
      resolve()
    })
  })
}

function closeServer(server, endpoint, stateDir) {
  return new Promise((resolve) => {
    server.close(() => {
      if (process.platform !== "win32") {
        rmSync(endpoint, { force: true })
      }
      rmSync(stateDir, { recursive: true, force: true })
      resolve()
    })
  })
}
