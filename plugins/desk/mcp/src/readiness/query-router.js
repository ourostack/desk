import { existsSync } from "node:fs"
import Database from "better-sqlite3"
import { indexDbPath } from "../db/init.js"
import { directLexicalSearch, loadCurrentTombstoneLedger } from "./direct-lexical.js"
import { expectedLexicalGenerationIdentity, matchesLexicalGenerationIdentity } from "./generations.js"
import { stableStringify } from "./identity.js"
import { indexedSearch, indexedTimeline } from "../tools/search.js"
import { indexedThread } from "../tools/thread.js"

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
      SELECT g.id, g.event_cursor, g.schema_version, g.chunker_id, g.normalization_id,
             g.embedding_spec, g.tombstone_identity, g.policy_identity
      FROM lexical_generations g
      JOIN meta m ON m.key = 'active_lexical_generation' AND m.value = CAST(g.id AS TEXT)
      JOIN readiness_operations o ON o.id = g.operation_id AND o.status = 'committed'
    `).get()
    const covered = db.prepare("SELECT value FROM meta WHERE key = 'covered_event_cursor'").get()
    const cursor = generation ? JSON.parse(generation.event_cursor) : null
    return { db, generation: generation?.id ?? null, identities: generation, cursor,
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
    Promise.resolve().then(() => { signal.throwIfAborted(); return operation() }).then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", abort))
  })
}

/**
 * A barrier proves controller readiness; an event fence plus the active
 * generation's durable cursor proves which canonical changes it covers.
 * The entire proof must survive evaluation unchanged, checked on a new snapshot.
 * Neither cached mtimes nor an old generation alone can authorize an index read.
 */
export function createQueryRouter({ controller, indexedBackend, directBackend, semanticDeadlineMs } = {}) {
  // Reserved by the alpha interface; there is deliberately no semantic scheduler.
  void semanticDeadlineMs
  let lastProof = null

  async function currentIdentity(request) {
    try {
      const ledger = await cancellable(() => loadCurrentTombstoneLedger(request), request.signal)
      return expectedLexicalGenerationIdentity({ ledger, policyIdentity: controller?.generationPolicyIdentity })
    } catch (error) {
      lastProof = null
      throw error
    }
  }

  async function serviceProof(request) {
    const { signal } = request
    const fence = await cancellable(() => controller.fenceEvents({ signal }), signal)
    const barrier = await cancellable(() => controller.barrier({ capability: "lexical" }), signal)
    const observed = await cancellable(() => controller.status(), signal)
    const identity = await currentIdentity(request)
    const currentAndCertain = fence.certain === true && barrier.current === true && barrier.certain !== false &&
      observed.freshness?.certain === true && sameCursor(fence.cursor, observed.freshness.cursor)
    const snapshot = currentAndCertain ? openSnapshot(request.deskRoot) : null
    const proven = currentAndCertain && snapshot?.generation != null && sameCursor(snapshot.cursor, fence.cursor) &&
      sameCursor(snapshot.covered, fence.cursor) && matchesLexicalGenerationIdentity(snapshot.identities, identity)
    return {
      snapshot, proven, owner: observed.owner?.token,
      identity: proven ? stableStringify({
        generation: snapshot.generation, cursor: snapshot.cursor, covered: snapshot.covered,
        identities: snapshot.identities, policy: identity,
        fence: { cursor: fence.cursor, certain: fence.certain },
        barrier: { current: barrier.current, certain: barrier.certain ?? null },
        observed: { cursor: observed.freshness.cursor, certain: observed.freshness.certain,
          owner: observed.owner?.token ?? null },
      }) : null,
      diagnostic: {
        reason: snapshot && !matchesLexicalGenerationIdentity(snapshot.identities, identity)
          ? "generation_identity_mismatch" : fence.reason ?? observed.freshness?.reason ?? "generation_unproven",
        message: "A current, event-certain lexical generation is not proven.",
      },
    }
  }

  async function lexical(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    lastProof = null
    await currentIdentity(request)
    let before = null
    let diagnostic = { reason: "controller_unavailable", message: "No readiness controller is available." }
    try {
      if (controller) {
        const initial = await cancellable(() => controller.barrier({
          capability: "lexical", ...(request.kind === "thread" ? { wait: true } : {}),
        }), signal)
        diagnostic = { reason: "reconciliation_pending", message: "A current lexical generation is not proven." }
        if (initial.current === true) {
          before = await serviceProof(request)
          diagnostic = before.diagnostic
        }
      }
    } catch (error) {
      before?.snapshot?.db.close()
      before = null
      signal?.throwIfAborted()
      if (error.code === "artifact_tombstone_ledger_invalid") throw error
      diagnostic = { reason: error.code ?? "readiness_unavailable", message: String(error.message ?? error) }
    }
    if (before?.proven) {
      try {
        signal?.throwIfAborted()
        const result = await cancellable(() => indexedBackend({
          ...request, db: before.snapshot.db, generation: before.snapshot.generation,
        }), signal)
        let after
        try {
          after = await serviceProof(request)
          if (after.proven && before.identity === after.identity) {
            lastProof = { generation: after.snapshot.generation, cursor: after.snapshot.cursor, owner: after.owner }
            return result
          }
          diagnostic = { reason: "readiness_changed_during_read", message: "Lexical proof changed during indexed evaluation." }
        } catch (error) {
          signal?.throwIfAborted()
          if (error.code === "artifact_tombstone_ledger_invalid") throw error
          diagnostic = { reason: error.code ?? "readiness_unavailable", message: String(error.message ?? error) }
        } finally { after?.snapshot?.db.close() }
      } finally { before.snapshot.db.close(); before = null }
    }
    before?.snapshot?.db.close()
    lastProof = null
    signal?.throwIfAborted()
    if (!["lexical", "timeline"].includes(request.kind ?? "lexical") || !directBackend) {
      return readinessError(diagnostic.reason, diagnostic.message)
    }
    const result = await cancellable(() => directBackend(request), signal)
    return { ...result, readiness_diagnostic: diagnostic }
  }

  async function snapshot(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    let observed
    let index
    try {
      const identity = await currentIdentity(request)
      observed = controller ? await cancellable(() => controller.status(), signal) : { state: "not_checked" }
      index = openSnapshot(request.deskRoot)
      const currentCursor = observed.freshness?.cursor ?? null
      const certain = observed.freshness?.certain === true &&
        lastProof?.owner === observed.owner?.token &&
        lastProof?.generation === index?.generation &&
        matchesLexicalGenerationIdentity(index?.identities, identity) &&
        sameCursor(lastProof?.cursor, currentCursor) &&
        sameCursor(index?.cursor, currentCursor) && sameCursor(index?.covered, currentCursor)
      const pending = typeof currentCursor?.journal_id === "string" && currentCursor.journal_id === index?.cursor?.journal_id
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
          current_automatic_action: null,
          serving_path: error.code === "artifact_tombstone_ledger_invalid" ? "blocked" : directBackend ? "direct" : "blocked" },
        diagnostic: { reason: error.code ?? "readiness_unavailable", message: String(error.message ?? error) },
      }
    } finally { index?.db.close() }
  }

  return {
    lexical,
    semantic: async (request = {}) => { request.signal?.throwIfAborted(); return semanticScopeError() },
    snapshot,
    async reindex(request = {}) {
      const { signal } = request
      signal?.throwIfAborted()
      if (!controller) return readinessError("controller_unavailable", "Reindex requires the shared readiness controller.")
      const result = await cancellable(() => controller.beginConvergence(), signal)
      const barrier = await cancellable(() => controller.barrier({ capability: "lexical", wait: true }), signal)
      if (barrier.current !== true) {
        return readinessError("reconciliation_pending", "The controller has not completed lexical convergence.")
      }
      return { status: "ok", action: "controller_convergence", reused: result?.reused === true }
    },
  }
}

export function createDeskQueryRouter({ controller } = {}) {
  return createQueryRouter({
    controller,
    directBackend: directLexicalSearch,
    indexedBackend: (request) => {
      const backend = request.kind === "thread" ? indexedThread
        : request.kind === "timeline" ? indexedTimeline : indexedSearch
      return backend({ deskRoot: request.deskRoot, db: request.db, input: request,
        opts: { now: request.now, lexicalOnly: true } })
    },
  })
}
