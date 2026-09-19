import { existsSync } from "node:fs"
import Database from "better-sqlite3"
import { indexDbPath } from "../db/init.js"

export function semanticScopeError() {
  return {
    status: "error",
    code: "required_capability_unavailable",
    capability: "semantic",
    diagnostic: { reason: "alpha_scope", message: "Semantic convergence is not qualified in this alpha." },
  }
}

function readinessError(reason, message) {
  return {
    status: "error", code: "required_capability_unavailable", capability: "lexical",
    diagnostic: { reason, message },
  }
}

function sameCursor(a, b) {
  return typeof a?.journal_id === "string" && a.journal_id.length > 0 &&
    Number.isSafeInteger(a.sequence) && a.sequence >= 0 &&
    a.journal_id === b?.journal_id && a.sequence === b?.sequence
}

function openSnapshot(deskRoot) {
  if (!deskRoot || !existsSync(indexDbPath(deskRoot))) return null
  const db = new Database(indexDbPath(deskRoot), { readonly: true, fileMustExist: true })
  try {
    db.exec("BEGIN")
    const generation = db.prepare(`
      SELECT g.id, g.event_cursor FROM lexical_generations g
      JOIN meta m ON m.key = 'active_lexical_generation' AND m.value = CAST(g.id AS TEXT)
      JOIN readiness_operations o ON o.id = g.operation_id AND o.status = 'committed'
    `).get()
    const covered = db.prepare("SELECT value FROM meta WHERE key = 'covered_event_cursor'").get()
    const cursor = generation ? JSON.parse(generation.event_cursor) : null
    return { db, generation: generation?.id ?? null, cursor,
      covered: covered ? JSON.parse(covered.value) : null }
  } catch (error) {
    db.close()
    throw error
  }
}

// Client cancellation stops waiting and dispatch, never controller-owned convergence.
function cancellable(operation, signal) {
  signal?.throwIfAborted()
  if (!signal) return operation()
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    Promise.resolve().then(operation).then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort))
  })
}

/**
 * A barrier proves controller readiness; an event fence plus the active
 * generation's durable cursor proves which canonical changes it covers.
 * Neither cached mtimes nor an old generation alone can authorize an index read.
 */
export function createQueryRouter({ controller, indexedBackend, directBackend, semanticDeadlineMs } = {}) {
  // Reserved by the alpha interface; there is deliberately no semantic scheduler.
  void semanticDeadlineMs
  let lastProof = null

  async function lexical(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    let snapshot = null
    let proven = false
    let diagnostic = { reason: "controller_unavailable", message: "No readiness controller is available." }
    try {
      if (controller) {
        const fence = await cancellable(() => controller.fenceEvents({ signal }), signal)
        const barrier = await cancellable(() => controller.barrier({
          capability: "lexical", ...(request.kind === "thread" ? { wait: true } : {}),
        }), signal)
        const observed = await cancellable(() => controller.status(), signal)
        snapshot = openSnapshot(request.deskRoot)
        proven = fence.certain === true && barrier.current === true && barrier.certain !== false &&
          observed.freshness?.certain === true &&
          sameCursor(fence.cursor, observed.freshness.cursor) &&
          snapshot?.generation != null && sameCursor(snapshot.cursor, fence.cursor) &&
          sameCursor(snapshot.covered, fence.cursor)
        diagnostic = {
          reason: fence.reason ?? observed.freshness?.reason ?? "generation_unproven",
          message: "A current, event-certain lexical generation is not proven.",
        }
        if (proven) lastProof = { generation: snapshot.generation, cursor: snapshot.cursor, owner: observed.owner?.token }
      }
    } catch (error) {
      if (signal?.aborted) { snapshot?.db.close(); signal.throwIfAborted() }
      diagnostic = { reason: error.code ?? "readiness_unavailable", message: String(error.message ?? error) }
    }
    if (proven) {
      try {
        signal?.throwIfAborted()
        return await cancellable(() => indexedBackend({ ...request, db: snapshot.db, generation: snapshot.generation }), signal)
      } finally { snapshot.db.close() }
    }
    snapshot?.db.close()
    lastProof = null
    signal?.throwIfAborted()
    if (request.kind === "thread") return readinessError(diagnostic.reason, diagnostic.message)
    const result = await cancellable(() => directBackend(request), signal)
    return { ...result, readiness_diagnostic: diagnostic }
  }

  async function snapshot(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    let observed
    let index
    try {
      observed = controller ? await cancellable(() => controller.status(), signal) : { state: "not_checked" }
      index = openSnapshot(request.deskRoot)
      const currentCursor = observed.freshness?.cursor ?? null
      const certain = observed.freshness?.certain === true &&
        lastProof?.owner === observed.owner?.token &&
        lastProof?.generation === index?.generation &&
        sameCursor(lastProof?.cursor, currentCursor) &&
        sameCursor(index?.cursor, currentCursor) && sameCursor(index?.covered, currentCursor)
      const pending = currentCursor?.journal_id === index?.cursor?.journal_id
        ? Math.max(0, currentCursor.sequence - index.cursor.sequence) : null
      return {
        state: observed.state,
        convergence: observed.convergence,
        lexical: {
          generation: index?.generation ?? null,
          event_cursor: index?.cursor ?? null,
          pending_changes: pending,
          certain,
          current_automatic_action: observed.convergence?.status === "pending" ? "reconciling" : null,
          serving_path: certain ? "indexed" : directBackend ? "direct" : "blocked",
        },
      }
    } catch (error) {
      signal?.throwIfAborted()
      return {
        state: "unavailable",
        lexical: { generation: null, event_cursor: null, pending_changes: null, certain: false,
          current_automatic_action: null, serving_path: directBackend ? "direct" : "blocked" },
        diagnostic: { reason: error.code ?? "readiness_unavailable", message: String(error.message ?? error) },
      }
    } finally { index?.db.close() }
  }

  return {
    lexical,
    semantic: async (request = {}) => { request.signal?.throwIfAborted(); return semanticScopeError() },
    snapshot,
  }
}
