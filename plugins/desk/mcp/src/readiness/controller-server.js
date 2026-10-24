import { randomUUID } from "node:crypto"
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs"
import * as net from "node:net"
import * as path from "node:path"

import { responseMessage } from "./protocol.js"
import { transitionReadiness } from "./state.js"
import { semanticContractDiagnostic, validateControllerEndpoint, validatePrivateDirectory } from "./identity.js"
import { JournalIntegrityError, openChangeJournal } from "./journal.js"
import { resolveStateDirectory } from "./state-path.js"
import { fenceEvents } from "./watcher.js"
import { exitRelease as defaultExitRelease } from "./exit-release.js"
import { readOwnProcessStart } from "./process-start.js"
import { indexOwner } from "./index-writer.js"
import { ownerState } from "./owner-record.js"

// A catch-up that another Desk build's commit undid, or a build standing aside whose owner has not caught up yet, tries again after a growing pause instead of at once: retrying at once is what kept two builds undoing each other's work. After the last pause the controller stops and stays uncertain; the next desk change or search starts it again.
export const RETRY_DELAYS_MS = Object.freeze([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000, 5_000])
const CLEANUP_BUSY_MS = 250
const CLEANUP_IDLE_MS = 60_000
// Why a build standing aside for a higher build cannot answer from the index yet.
const STAND_ASIDE_REASONS = Object.freeze(["index_owner_catching_up", "index_owned_by_newer_desk"])

export async function startReadinessController({
  identity,
  endpoint,
  stateDir,
  handlers = {},
  watcher,
  ephemeral = false,
  exitRelease = defaultExitRelease,
  ownProcessStart = readOwnProcessStart,
  bindBeforeProcessStart = process.platform === "win32",
  prepareRootSync,
  supervisor,
  // The Desk version this controller runs. With it the controller publishes the version in its owner record and writes the shared index only while no running build ranks above it (index-writer.js); without it (older callers and tests) it writes as before.
  version = null,
  retryDelaysMs = RETRY_DELAYS_MS,
  // How long the vector cleanup waits before its next round: soon while the last round left work, longer once nothing was left.
  cleanupBusyMs = CLEANUP_BUSY_MS,
  cleanupIdleMs = CLEANUP_IDLE_MS,
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
  // On Windows the read runs PowerShell (Get-CimInstance), which takes seconds on a loaded machine, and five servers racing for one root each start a controller. The pipe is therefore bound first: a controller that loses the election fails at once, and only the winner pays for the read. A named pipe leaves no file behind for a concurrent session to mistake for an abandoned one. Elsewhere the read is cheap and stays before the bind, so a socket file is never visible without its owner record for longer than before.
  const readProcessStart = async () => {
    const processStart = await ownProcessStart()
    if (processStart !== null) owner.process_start = processStart
  }
  if (!bindBeforeProcessStart) await readProcessStart()
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
  const self = typeof version === "string" ? { version, build: identity.build ?? null, controller: identity.id } : null
  // The build that owns the index when it is not this one, as of the last catch-up or status answer.
  let indexOwnedBy = null
  // What the index held when this controller last proved it current (generationContent): another build's generation with the same content serves the same answers.
  let readyContent = null
  let retryAttempt = 0
  // Whether this build wrote the index at its last catch-up, rather than standing aside for a higher build.
  let ownsIndex = false
  let cleanup = null
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
      journal ??= await openChangeJournal({ root: identity.root, stateDir: resolveStateDirectory(path.join(stateDir, "journal")) })
      return operation(journal)
    })
    journalWork = result.catch(() => {})
    return result
  }

  // `delayMs` above 0 is a retry after a pause; a desk change during the pause waits for it.
  function scheduleReconciliation(delayMs = 0) {
    if (closing || reconcileScheduled || convergence) return
    const fired = Promise.withResolvers()
    const run = () => {
      reconcileScheduled = null
      // beginConvergence retains the failure in live status; it is not an empty success.
      void beginConvergence().catch(() => {})
      fired.resolve()
    }
    const handle = delayMs > 0 ? setTimeout(run, delayMs) : setImmediate(run)
    if (delayMs > 0) handle.unref?.()
    reconcileScheduled = {
      delayed: delayMs > 0,
      fired: fired.promise,
      cancel() {
        if (delayMs > 0) clearTimeout(handle)
        else clearImmediate(handle)
        fired.resolve()
      },
    }
  }

  // Older builds sharing the desk leave vectors no section can use whether or not this build catches up, so while this
  // build owns the index a cleanup round runs on its own timer, not only after a catch-up: soon again while a round
  // left work, and once every cleanupIdleMs after a round found nothing left.
  function scheduleCleanup(delayMs) {
    if (closing || typeof handlers.cleanupVectors !== "function" || !ownsIndex) return
    if (cleanup?.running) return
    if (cleanup && cleanup.dueAt <= Date.now() + delayMs) return
    clearTimeout(cleanup?.timer)
    const timer = setTimeout(runCleanup, delayMs)
    timer.unref?.()
    cleanup = { timer, dueAt: Date.now() + delayMs, running: false }
  }

  function runCleanup() {
    const round = (async () => {
      let result = null
      try {
        // A catch-up in progress already writes the index; the round waits for it.
        await convergence?.catch(() => {})
        if (!closing && ownsIndex) result = await handlers.cleanupVectors()
      } catch {
        // A failed round leaves the vectors for the next one.
      }
      cleanup = null
      scheduleCleanup(result?.complete === false ? cleanupBusyMs : cleanupIdleMs)
    })()
    cleanup = { running: true, round }
  }

  // The next pause, or null once every pause is spent.
  function nextRetryDelay() {
    const delay = retryDelaysMs[retryAttempt] ?? null
    if (delay !== null) retryAttempt += 1
    return delay
  }

  // Whether a running Desk build that ranks above this one owns the index; this controller then only reads it.
  async function readOwnership({ inspect } = {}) {
    if (self === null) return null
    let indexWriter = null
    try {
      const { readActiveIndex } = await import("../db/status-read.js")
      indexWriter = readActiveIndex(identity.root)?.writer ?? null
    } catch {
      // An unreadable index has no owner to defer to; the catch-up moves it aside and rebuilds it.
    }
    indexOwnedBy = await indexOwner({ self, root: identity.root, stateDir, indexWriter, inspect })
    return indexOwnedBy
  }

  // Status reads the owner afresh, so it never names a session that has ended or misses one that started since the last catch-up. Every query reads status, so owners are judged by their PID alone: reading a process's start time can take seconds on Windows.
  async function currentIndexOwner() {
    if (self === null) return null
    const before = indexOwnedBy
    await readOwnership({ inspect: ({ stateDir: dir }) => ownerState({ stateDir: dir, processStart: async () => null }) })
    // The owner's session ended while this build stood aside: catch up and take the index over now, not at the next desk change.
    if (before !== null && indexOwnedBy === null && STAND_ASIDE_REASONS.includes(freshnessReason)) scheduleReconciliation()
    return indexOwnerStatus()
  }

  async function committedContent(generationId) {
    try {
      const { readCommittedContent } = await import("../db/status-read.js")
      return readCommittedContent(identity.root, generationId)
    } catch {
      return null
    }
  }

  function indexOwnerStatus() {
    return indexOwnedBy === null
      ? { version: self.version, build: self.build, this_controller: true }
      : { version: indexOwnedBy.version, build: indexOwnedBy.build, this_controller: false }
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
      status: convergence || reconcileScheduled?.delayed ? "pending" : convergenceError ? "failed"
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
    reconcileScheduled?.cancel()
    reconcileScheduled = null
    if (state === "LEXICAL_READY") state = transitionReadiness(state, "RECOVERING")
    // A build standing aside stays catching up while it waits for the owner.
    if (state !== "LEXICAL_CONVERGING") state = transitionReadiness(state, "LEXICAL_CONVERGING")
    convergenceError = null
    convergenceResult = null
    readyContent = null
    // The operation belongs to the controller, not the requesting socket.
    server.ref()
    // Capture before asynchronous journal opening/protection. An uncertainty
    // reported during that work has already moved state to RECOVERING; it must
    // invalidate this attempt, not be mistaken for its initial revision.
    const startedRevision = revision
    let eventCursor
    let retryDelay = null
    convergence = Promise.resolve().then(async () => {
      if (journalPoisoned) {
        await journalWork
        await journal?.close()
        journal = null
        journalPoisoned = false
      }
      await withJournal((active) => {
        eventCursor = active.cursor
      })
      // Only the build that owns the index writes it. A lower build reads the owner's index once it covers the desk as this build sees it, and writes nothing.
      if (await readOwnership() !== null) {
        ownsIndex = false
        const checked = await handlers.verifyIndex?.({ eventCursor })
        return { ...(checked ?? { verified: false, same_settings: false, semantic: null }), stood_aside: true }
      }
      const result = await handlers.beginConvergence?.({ eventCursor, reason: freshnessReason, journal })
      ownsIndex = true
      if (result && typeof result.content !== "string") {
        const content = await committedContent(result.summary?.lexical_generation)
        if (content !== null) result.content = content
      }
      return result
    }).then((result) => {
      convergenceResult = result ?? { accepted: true }
      if (revision === startedRevision) {
        if (result?.stood_aside === true && result.verified !== true) {
          // The owner has not caught up with the desk yet, or builds its index differently; this build never writes it.
          freshnessReason = result.same_settings === true ? "index_owner_catching_up" : "index_owned_by_newer_desk"
          if (result.same_settings === true) retryDelay = nextRetryDelay()
        } else {
          journal.reconciled(eventCursor)
          freshnessReason = null
          readyContent = typeof result?.content === "string" ? result.content : null
          state = transitionReadiness(state, "LEXICAL_READY")
          if (semanticCurrent()) state = transitionReadiness(state, "READY")
          // Standing aside, the owner may still be embedding the text this build has seen; look again until it is done.
          else if (result?.stood_aside === true && semanticEnabled) retryDelay = nextRetryDelay()
        }
      }
      if (retryDelay === null) retryAttempt = 0
      return convergenceResult
    }).catch((error) => {
      convergenceError = error
      if (error.code === "generation_superseded") {
        // Another build committed different content between this build's commit and its cleanup. Look again after a pause: the next round reads who owns the index first, and stands aside if a higher build does.
        markUncertain(error.code)
        retryDelay = nextRetryDelay()
        if (retryDelay === null) retryAttempt = 0
      } else if (error.code === "journal_integrity_failed") {
        markUncertain(error.code)
        retryDelay = 0
      } else {
        freshnessReason ??= "convergence_failed"
        if (state !== "RECOVERING") state = transitionReadiness(state, "RECOVERING")
      }
      throw error
    }).finally(() => {
      convergence = null
      scheduleCleanup(cleanupBusyMs)
      if (retryDelay !== null) scheduleReconciliation(retryDelay)
      else if (!convergenceError && revision !== startedRevision) scheduleReconciliation()
      if (!ephemeral) server.unref()
    })
    return convergence
  }

  const lexicalCurrent = () => freshnessReason === null && (state === "LEXICAL_READY" || state === "READY")

  async function barrier(params) {
    if (params?.wait) {
      while (convergence || reconcileScheduled) {
        if (!convergence) {
          if (!reconcileScheduled.delayed) beginConvergence()
          // A paused retry: an exact-word wait that is already current does not wait for meaning-based search.
          else if (params.capability !== "semantic" && lexicalCurrent()) break
          else { await reconcileScheduled.fired; continue }
        }
        try {
          await convergence
        } catch (error) {
          // A failure retried after a pause is waited out like the pause itself; the caller's own deadline bounds the wait.
          if (!reconcileScheduled?.delayed) throw error
        }
      }
      if (convergenceError) throw convergenceError
    }
    if (handlers.barrier) return handlers.barrier(params)
    const current = params?.capability === "semantic"
      ? lexicalCurrent() && semanticCurrent()
      : params?.capability === "lexical" && lexicalCurrent()
    return {
      capability: params?.capability,
      current,
      state,
      // Why a build standing aside cannot answer from the index yet.
      ...(!current && STAND_ASIDE_REASONS.includes(freshnessReason) ? { reason: freshnessReason } : {}),
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
        status: async () => {
          const indexOwnerNow = await currentIndexOwner()
          return {
            state, identity, owner, convergence: convergenceStatus(),
            freshness: {
              certain: freshnessReason === null, reason: freshnessReason, cursor: journal?.cursor ?? null,
              content: freshnessReason === null ? readyContent : null,
            },
            index_owner: indexOwnerNow,
          }
        },
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
  // listen() drops its one-shot error listener once bound; without a lasting one, a later server error would be an unhandled 'error' event that ends the whole Desk process. It is attached before the process start read, which can take seconds.
  server.on("error", (error) => {
    process.stderr.write(`[desk-mcp] readiness controller server error: ${error?.message ?? String(error)}\n`)
  })
  if (bindBeforeProcessStart) {
    try {
      await readProcessStart()
    } catch (error) {
      try {
        await closeServer(server, stateDir, owner)
      } catch {
        // The read failure is the one to report; the pipe is released with the process anyway.
      }
      throw error
    }
  }
  let socket = null
  try {
    socket = controllerSocketIdentity(endpoint)
    const ownerFile = path.join(stateDir, "owner.json")
    const record = {
      schema_version: 1, identity, owner, endpoint, socket,
      // Other Desk builds on this desk read it to learn which build owns the shared index.
      ...(self === null ? {} : { desk_version: self.version }),
      ...(supervisor ? { supervisor } : {}),
      ...(prepareRootSync === undefined ? {} : { startup: { started_at: new Date().toISOString() } }),
    }
    const published = `${JSON.stringify(record, null, 2)}\n`
    writeFileSync(
      ownerFile,
      published,
      { encoding: "utf8", mode: 0o600 },
    )
    // Only the bind winner prepares. Its published owner prevents takeover while synchronous setup runs before readiness.
    if (prepareRootSync !== undefined) {
      if (prepareRootSync() !== undefined) throw new TypeError("Controller root preparation must finish synchronously without returning a value")
      if (readFileSync(ownerFile, "utf8") !== published)
        throw Object.assign(new Error("Controller ownership changed during root preparation"), { code: "controller_owner_changed" })
      delete record.startup
      writeFileSync(ownerFile, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    }
  } catch (error) {
    try {
      await closeServer(server, stateDir, owner)
    } catch {
      // Preserve the startup failure; stale cleanup is recoverable on the next election.
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
      reconcileScheduled?.cancel()
      reconcileScheduled = null
      clearTimeout(cleanup?.timer)
      await cleanup?.round
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
