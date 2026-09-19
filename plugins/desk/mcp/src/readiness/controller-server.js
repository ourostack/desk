import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import { responseMessage } from "./protocol.js"
import { transitionReadiness } from "./state.js"
import { validateControllerEndpoint, validatePrivateDirectory } from "./identity.js"

export async function startReadinessController({
  identity,
  endpoint,
  stateDir,
  handlers = {},
  ephemeral = false,
} = {}) {
  validateControllerEndpoint(endpoint)
  if (process.platform !== "win32") validatePrivateDirectory(path.dirname(endpoint))
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") validatePrivateDirectory(stateDir)
  const owner = {
    pid: process.pid,
    started_at: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    token: randomUUID(),
  }
  let state = "CONTROL_READY"
  let convergence = null
  let convergenceResult = null
  let convergenceError = null
  const semanticMode = identity.semantic_contract?.mode
  const semanticEnabled = semanticMode === "required" || semanticMode === "background"
  const server = net.createServer((socket) => {
    let pending = ""
    socket.setEncoding("utf8")
    socket.on("error", () => socket.destroy())
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

  function semanticCurrent() {
    const coverage = convergenceResult?.semantic
    return semanticEnabled
      && Number.isSafeInteger(coverage?.chunks_total) && coverage.chunks_total >= 0
      && coverage.vectors_indexed === coverage.chunks_total
      && coverage.missing_vectors === 0
      && coverage.provenance_current === true
      && coverage.query_embedding?.available === true
      && typeof identity.semantic_contract.embedding_spec?.model === "string"
      && coverage.query_embedding.diagnostic?.model === identity.semantic_contract.embedding_spec.model
  }

  function beginConvergence() {
    if (convergence) {
      return { accepted: true, reused: true, in_progress: true, state }
    }
    if (state === "LEXICAL_READY") state = transitionReadiness(state, "RECOVERING")
    state = transitionReadiness(state, "LEXICAL_CONVERGING")
    convergenceError = null
    convergenceResult = null
    // The operation belongs to the controller, not the requesting socket.
    server.ref()
    convergence = Promise.resolve().then(() => handlers.beginConvergence?.()).then((result) => {
      convergenceResult = result ?? { accepted: true }
      state = transitionReadiness(state, "LEXICAL_READY")
      if (semanticCurrent()) state = transitionReadiness(state, "READY")
      return convergenceResult
    }).catch((error) => {
      convergenceError = error
      state = transitionReadiness(state, "RECOVERING")
      throw error
    }).finally(() => {
      convergence = null
      if (!ephemeral) server.unref()
    })
    return convergence
  }

  async function barrier(params) {
    if (params?.wait) {
      if (convergence) await convergence
      if (convergenceError) throw convergenceError
    }
    if (handlers.barrier) return handlers.barrier(params)
    const lexicalCurrent = state === "LEXICAL_READY" || state === "READY"
    return {
      capability: params?.capability,
      current: params?.capability === "semantic"
        ? lexicalCurrent && semanticCurrent()
        : params?.capability === "lexical" && lexicalCurrent,
      state,
    }
  }

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
        beginConvergence,
        barrier: () => barrier(request.params),
        recordChange: () => handlers.recordChange?.(request.params) ?? { recorded: true },
      }[request.method]
      if (!builtin) {
        throw new Error(`unknown readiness controller method: ${request.method}`)
      }
      const result = await builtin()
      if (!socket.destroyed) socket.end(`${JSON.stringify(responseMessage({ id: request.id, result }))}\n`)
    } catch (error) {
      if (!socket.destroyed) socket.end(`${JSON.stringify(responseMessage({
        id: request?.id ?? null,
        error: { message: error?.message ?? String(error) },
      }))}\n`)
    }
  }

  await listen(server, endpoint)
  try {
    const socketStat = process.platform === "win32" ? null : lstatSync(endpoint)
    const socket = socketStat === null ? null : { dev: socketStat.dev, ino: socketStat.ino }
    writeFileSync(
      path.join(stateDir, "owner.json"),
      `${JSON.stringify({ schema_version: 1, identity, owner, endpoint, socket }, null, 2)}\n`,
      { encoding: "utf8", mode: 0o600 },
    )
  } catch (error) {
    try {
      await closeServer(server, stateDir, owner)
    } catch {
      // Preserve the publication failure; stale cleanup is recoverable on the next election.
    }
    throw error
  }
  if (!ephemeral) {
    server.unref()
  }
  return {
    identity,
    owner,
    server,
    close: () => closeServer(server, stateDir, owner),
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

function closeServer(server, stateDir, owner) {
  return new Promise((resolve, reject) => {
    server.close(() => {
      try {
        // net.Server removes its own socket. Never unlink an unverified replacement.
        if (process.platform !== "win32") validatePrivateDirectory(stateDir)
        const ownerFile = path.join(stateDir, "owner.json")
        const record = JSON.parse(readFileSync(ownerFile, "utf8"))
        if (record.owner?.token === owner.token) {
          unlinkSync(ownerFile)
          try {
            rmdirSync(stateDir)
          } catch (error) {
            if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error
          }
        }
        resolve()
      } catch (error) {
        if (error.code === "ENOENT") resolve()
        else reject(error)
      }
    })
  })
}
