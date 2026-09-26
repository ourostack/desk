import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import { responseMessage } from "./protocol.js"
import { transitionReadiness } from "./state.js"
import { semanticContractDiagnostic, validateControllerEndpoint, validatePrivateDirectory } from "./identity.js"
import { JournalIntegrityError, openChangeJournal } from "./journal.js"
import { fenceEvents } from "./watcher.js"
import { exitRelease as defaultExitRelease } from "./exit-release.js"
import { readOwnProcessStart } from "./process-start.js"

export async function startReadinessController({
  identity,
  endpoint,
  stateDir,
  handlers = {},
  watcher,
  ephemeral = false,
  exitRelease = defaultExitRelease,
  ownProcessStart = readOwnProcessStart,
  supervisor,
} = {}) {
  validateControllerEndpoint(endpoint)
  if (process.platform !== "win32") validatePrivateDirectory(path.dirname(endpoint))
  mkdirSync(stateDir, { recursive: true, mode: 0o700 })
  if (process.platform !== "win32") validatePrivateDirectory(stateDir)
  const owner = {
    pid: process.pid,
    started_at: new Date(Date.now() - Math.floor(process.uptime() * 1000)).toISOString(),
    token: randomUUID(),
    ...(supervisor ? { kind: "controller_child", parent_pid: process.ppid } : {}),
  }
  // The owner's start time makes the record name this process, not just its PID, which a later process may reuse (owner-record.js).
  const processStart = await ownProcessStart()
  if (processStart !== null) owner.process_start = processStart
  let state = "CONTROL_READY"
  let convergence = null
  let convergenceResult = null
  let convergenceError = null
  let journal = null
  let journalWork = Promise.resolve()
  let journalPoisoned = false
  let revision = 0
  let freshnessReason = "initial_scan"
  let reconcileScheduled = null
  let closing = false
  let unregisterRelease
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

  function withJournal(operation) {
    const result = journalWork.then(async () => {
      journal ??= await openChangeJournal({ root: identity.root, stateDir: path.join(stateDir, "journal") })
      return operation(journal)
    })
    journalWork = result.catch(() => {})
    return result
  }

  function scheduleReconciliation() {
    if (closing || reconcileScheduled || convergence) return
    reconcileScheduled = setImmediate(() => {
      reconcileScheduled = null
      // beginConvergence retains the failure in live status; it is not an empty success.
      void beginConvergence().catch(() => {})
    })
  }

  function markUncertain(reason = "freshness_uncertain") {
    revision += 1
    if (["journal_corrupt", "journal_write_failed", "journal_integrity_failed"].includes(reason)) journalPoisoned = true
    freshnessReason = reason
    if (state !== "RECOVERING") state = transitionReadiness(state, "RECOVERING")
    scheduleReconciliation()
    return { certain: false, reason, state }
  }

  async function recordChange(change) {
    markUncertain("pending_change")
    try {
      const record = await withJournal((active) => active.appendChange({ ...change, root: identity.root }))
      return { recorded: true, sequence: record.sequence, cursor: journal.cursor }
    } catch (error) {
      journalPoisoned = true
      markUncertain("journal_write_failed")
      throw error
    }
  }

  async function eventFence() {
    let active
    try {
      active = await withJournal((value) => value)
    } catch (error) {
      markUncertain("journal_integrity_failed")
      throw new JournalIntegrityError(error)
    }
    return fenceEvents({ controller: { watcher, journal: active, recordChange, markUncertain } })
  }

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

  function convergenceStatus() {
    const coverage = convergenceResult?.semantic
    const query = coverage?.query_embedding
    return {
      status: convergence ? "pending" : convergenceError ? "failed"
        : convergenceResult ? "succeeded" : "not_checked",
      semantic: coverage ? {
        chunks_total: coverage.chunks_total,
        vectors_indexed: coverage.vectors_indexed,
        missing_vectors: coverage.missing_vectors,
        provenance_current: coverage.provenance_current,
        query_embedding: typeof query?.available === "boolean" ? {
          available: query.available,
          diagnostic: query.diagnostic ? Object.fromEntries(
            ["endpoint", "model", "reason", "message"]
              .filter((key) => typeof query.diagnostic[key] === "string")
              .map((key) => [key, query.diagnostic[key].slice(0, 2048)]),
          ) : null,
        } : null,
      } : null,
      diagnostic: convergenceError
        ? { message: String(convergenceError.message ?? convergenceError).slice(0, 2048) }
        : null,
    }
  }

  function beginConvergence() {
    if (convergence) {
      return { accepted: true, reused: true, in_progress: true, state }
    }
    if (reconcileScheduled) clearImmediate(reconcileScheduled)
    reconcileScheduled = null
    if (state === "LEXICAL_READY") state = transitionReadiness(state, "RECOVERING")
    state = transitionReadiness(state, "LEXICAL_CONVERGING")
    convergenceError = null
    convergenceResult = null
    // The operation belongs to the controller, not the requesting socket.
    server.ref()
    let startedRevision
    let eventCursor
    let retryConvergence = false
    convergence = Promise.resolve().then(async () => {
      if (journalPoisoned) {
        await journalWork
        await journal?.close()
        journal = null
        journalPoisoned = false
      }
      await withJournal((active) => {
        eventCursor = active.cursor
        startedRevision = revision
      })
      return handlers.beginConvergence?.({ eventCursor, reason: freshnessReason, journal })
    }).then((result) => {
      convergenceResult = result ?? { accepted: true }
      if (revision === startedRevision) {
        journal.reconciled(eventCursor)
        freshnessReason = null
        state = transitionReadiness(state, "LEXICAL_READY")
        if (semanticCurrent()) state = transitionReadiness(state, "READY")
      }
      return convergenceResult
    }).catch((error) => {
      convergenceError = error
      if (error.code === "generation_superseded" || error.code === "journal_integrity_failed") {
        markUncertain(error.code)
        retryConvergence = true
      } else {
        freshnessReason ??= "convergence_failed"
        if (state !== "RECOVERING") state = transitionReadiness(state, "RECOVERING")
      }
      throw error
    }).finally(() => {
      convergence = null
      if (retryConvergence || (!convergenceError && revision !== startedRevision)) scheduleReconciliation()
      if (!ephemeral) server.unref()
    })
    return convergence
  }

  async function barrier(params) {
    if (params?.wait) {
      while (convergence || reconcileScheduled) {
        if (!convergence) beginConvergence()
        await convergence
      }
      if (convergenceError) throw convergenceError
    }
    if (handlers.barrier) return handlers.barrier(params)
    const lexicalCurrent = freshnessReason === null && (state === "LEXICAL_READY" || state === "READY")
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
      const diagnostic = semanticContractDiagnostic(identity.semantic_contract, request.params.semantic_contract ?? null)
      if (diagnostic && request.method !== "handshake") {
        throw Object.assign(new Error(diagnostic.message), { code: diagnostic.code, diagnostic })
      }
      const builtin = {
        handshake: () => ({
          accepted: request.params?.identity === identity.id && diagnostic === null,
          identity,
          owner,
          ...(diagnostic ? { diagnostic } : {}),
        }),
        status: () => ({
          state, identity, owner, convergence: convergenceStatus(),
          freshness: { certain: freshnessReason === null, reason: freshnessReason, cursor: journal?.cursor ?? null },
        }),
        beginConvergence,
        barrier: () => barrier(request.params),
        recordChange: () => recordChange(request.params),
        markUncertain: () => markUncertain(request.params.reason),
        fenceEvents: eventFence,
      }[request.method]
      if (!builtin) {
        throw new Error(`unknown readiness controller method: ${request.method}`)
      }
      const result = await builtin()
      if (!socket.destroyed) socket.end(`${JSON.stringify(responseMessage({ id: request.id, result }))}\n`)
    } catch (error) {
      if (!socket.destroyed) socket.end(`${JSON.stringify(responseMessage({
        id: request?.id ?? null,
        error: { message: error?.message ?? String(error), code: error?.code, reason: error?.reason, diagnostic: error?.diagnostic },
      }))}\n`)
    }
  }

  await listen(server, endpoint)
  // listen() drops its one-shot error listener once bound; without a lasting one, a later server error would be an unhandled 'error' event that ends the whole Desk process.
  server.on("error", (error) => {
    process.stderr.write(`[desk-mcp] readiness controller server error: ${error?.message ?? String(error)}\n`)
  })
  let socket = null
  try {
    socket = controllerSocketIdentity(endpoint)
    writeFileSync(
      path.join(stateDir, "owner.json"),
      `${JSON.stringify({ schema_version: 1, identity, owner, endpoint, socket, ...(supervisor ? { supervisor } : {}) }, null, 2)}\n`,
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
  // Every normal end of this process (stdin closed, SIGTERM, SIGINT, beforeExit, exit) removes the rendezvous files while they are still ours, so the next session never finds an owner record naming a process that has gone.
  unregisterRelease = exitRelease.register(() => {
    unregisterRelease()
    releaseRendezvous({ stateDir, endpoint, owner, socket })
  })
  return {
    identity,
    owner,
    socket,
    server,
    async close() {
      closing = true
      unregisterRelease()
      if (reconcileScheduled) clearImmediate(reconcileScheduled)
      reconcileScheduled = null
      await convergence?.catch(() => {})
      await journalWork
      try {
        await journal?.close()
      } finally {
        watcher?.close?.()
        await closeServer(server, stateDir, owner)
      }
    },
  }
}

export function controllerSocketIdentity(endpoint, platform = process.platform) {
  if (platform === "win32") return null
  const { dev, ino } = lstatSync(endpoint)
  return { dev, ino }
}

/**
 * Remove the controller's owner record and socket file synchronously, but only while they are still this controller's: the record names this process (PID and start time) and this controller's token, and the socket file is the one it published. Anything else belongs to a controller elected since, and is left alone.
 */
export function releaseRendezvous({ stateDir, endpoint, owner, socket }) {
  const ownerFile = path.join(stateDir, "owner.json")
  let record
  try {
    record = JSON.parse(readFileSync(ownerFile, "utf8"))
  } catch {
    return false
  }
  const recorded = record?.owner
  if (recorded?.token !== owner.token || recorded.pid !== owner.pid || recorded.process_start !== owner.process_start) return false
  if (socket !== null) {
    try {
      const now = lstatSync(endpoint)
      if (now.dev === socket.dev && now.ino === socket.ino) unlinkSync(endpoint)
    } catch {
      // Already gone.
    }
  }
  try {
    unlinkSync(ownerFile)
    rmdirSync(stateDir)
  } catch {
    // The journal and other state stay: only the rendezvous files matter to the next session.
  }
  return true
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
