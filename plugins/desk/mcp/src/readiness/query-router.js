import { existsSync } from "node:fs"
import Database from "better-sqlite3"
import * as sqliteVec from "sqlite-vec"
import { indexDbPath } from "../db/init.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { directLexicalSearch, loadCurrentTombstoneLedger } from "./direct-lexical.js"
import { expectedLexicalGenerationIdentity, matchesLexicalGenerationIdentity } from "./generations.js"
import { stableStringify } from "./identity.js"
import { indexedRecall, indexedSearch, indexedSimilar, indexedTimeline } from "../tools/search.js"
import { indexedThread } from "../tools/thread.js"

export function semanticScopeError() {
  return semanticCapabilityError("semantic_unavailable", "Semantic serving is not current for the active generation.")
}

function readinessError(reason, message) {
  return {
    status: "error", code: "required_capability_unavailable", capability: "lexical",
    diagnostic: { reason, message },
  }
}

function semanticCapabilityError(reason, message) {
  return {
    status: "error", code: "required_capability_unavailable", capability: "semantic",
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
    sqliteVec.load(db)
    db.exec("BEGIN")
    const generation = db.prepare(`
      SELECT g.id, g.event_cursor, g.schema_version, g.chunker_id, g.normalization_id,
             g.embedding_spec, g.tombstone_identity, g.policy_identity
      FROM lexical_generations g
      JOIN meta m ON m.key = 'active_lexical_generation' AND m.value = CAST(g.id AS TEXT)
      JOIN readiness_operations o ON o.id = g.operation_id AND o.status = 'committed'
    `).get()
    const covered = db.prepare("SELECT value FROM meta WHERE key = 'covered_event_cursor'").get()
    const activeEmbeddingSpecId = db.prepare("SELECT value FROM meta WHERE key = 'active_embedding_spec_id'").get()?.value ?? null
    const vectorsIndexed = db.prepare(
      `SELECT COUNT(*) AS n
       FROM chunks c
       JOIN chunk_vecs v ON v.chunk_id = c.id
       WHERE c.embedding_spec_id = ?
         AND c.chunker_id = ?
         AND c.normalization_id = ?`,
    ).get(
      ACTIVE_EMBEDDING_SPEC.id,
      ACTIVE_EMBEDDING_SPEC.chunker_id,
      ACTIVE_EMBEDDING_SPEC.normalization_id,
    ).n
    const chunksTotal = db.prepare("SELECT COUNT(*) AS n FROM chunks").get().n
    const cursor = generation ? JSON.parse(generation.event_cursor) : null
    return { db, generation: generation?.id ?? null, identities: generation, cursor,
      covered: covered ? JSON.parse(covered.value) : null,
      semantic: {
        active_embedding_spec_id: activeEmbeddingSpecId,
        chunks_total: chunksTotal,
        vectors_indexed: vectorsIndexed,
        missing_vectors: Math.max(0, chunksTotal - vectorsIndexed),
      } }
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

function deadlineError(reason, message) {
  const error = new Error(message)
  error.code = reason
  return error
}

function withDeadline(operation, timeoutMs, reason, message) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return operation()
  let timer = null
  return Promise.race([
    operation(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(deadlineError(reason, message)), timeoutMs)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}

function hasQuery(request = {}) {
  return typeof request.query === "string" && request.query.trim().length > 0
}

function semanticDiagnostic(proof) {
  if (proof.semanticBarrier.current !== true) {
    return {
      reason: proof.semanticBarrier.reason ?? "semantic_unavailable",
      message: proof.semanticBarrier.message ?? "Semantic convergence is not current for the active generation.",
    }
  }
  if (proof.snapshot?.semantic?.active_embedding_spec_id !== ACTIVE_EMBEDDING_SPEC.id) {
    return {
      reason: "semantic_unavailable",
      message: "The active embedding specification does not match the proven generation.",
    }
  }
  if (proof.snapshot?.semantic?.missing_vectors !== 0) {
    return {
      reason: "semantic_unavailable",
      message: "Semantic vectors are incomplete for the proven generation.",
    }
  }
  if (proof.observed?.convergence?.semantic?.query_embedding?.available !== true) {
    return {
      reason: "semantic_unavailable",
      message: "Query embedding is not available for the active semantic generation.",
    }
  }
  return {
    reason: "semantic_unavailable",
    message: "Semantic serving is not current for the active generation.",
  }
}

async function semanticBarrierState(controller, request, semanticDeadlineMs) {
  const signal = request.signal
  if (!controller) {
    return {
      current: false,
      reason: "semantic_unavailable",
      message: "No readiness controller is available for semantic serving.",
    }
  }
  try {
    const initial = await cancellable(() => controller.barrier({ capability: "semantic" }), signal)
    if (initial.current === true) return initial
    await cancellable(() => controller.beginConvergence(), signal)
    return await withDeadline(
      () => cancellable(() => controller.barrier({ capability: "semantic", wait: true }), signal),
      semanticDeadlineMs,
      "semantic_deadline",
      "Semantic convergence did not become current before the deadline.",
    )
  } catch (error) {
    signal?.throwIfAborted()
    if (error.code === "semantic_deadline") throw error
    return {
      current: false,
      reason: error.code ?? "semantic_unavailable",
      message: String(error.message ?? error),
    }
  }
}

/**
 * A barrier proves controller readiness; an event fence plus the active
 * generation's durable cursor proves which canonical changes it covers.
 * The entire proof must survive evaluation unchanged, checked on a new snapshot.
 * Neither cached mtimes nor an old generation alone can authorize an index read.
 */
export function createQueryRouter({
  controller,
  indexedBackend,
  semanticBackend,
  directBackend,
  semanticDeadlineMs = 30_000,
} = {}) {
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

  async function serviceProof(request, { semanticRequired = false, waitForSemantic = semanticRequired } = {}) {
    const { signal } = request
    const fence = await cancellable(() => controller.fenceEvents({ signal }), signal)
    const lexicalBarrier = await cancellable(() => controller.barrier({ capability: "lexical" }), signal)
    const semanticBarrier = semanticRequired && waitForSemantic
      ? await semanticBarrierState(controller, request, semanticDeadlineMs)
      : await cancellable(() => controller.barrier({ capability: "semantic" }), signal).catch((error) => ({
          current: false,
          reason: error.code ?? "semantic_unavailable",
          message: String(error.message ?? error),
        }))
    const observed = await cancellable(() => controller.status(), signal)
    const identity = await currentIdentity(request)
    const currentAndCertain = fence.certain === true &&
      lexicalBarrier.current === true &&
      lexicalBarrier.certain !== false &&
      observed.freshness?.certain === true && sameCursor(fence.cursor, observed.freshness.cursor)
    const snapshot = currentAndCertain ? openSnapshot(request.deskRoot) : null
    const lexicalProven = currentAndCertain && snapshot?.generation != null && sameCursor(snapshot.cursor, fence.cursor) &&
      sameCursor(snapshot.covered, fence.cursor) && matchesLexicalGenerationIdentity(snapshot.identities, identity)
    const semanticProven = lexicalProven &&
      semanticBarrier.current === true &&
      semanticBarrier.certain !== false &&
      snapshot?.semantic?.active_embedding_spec_id === ACTIVE_EMBEDDING_SPEC.id &&
      snapshot?.semantic?.missing_vectors === 0 &&
      snapshot?.semantic?.vectors_indexed === snapshot?.semantic?.chunks_total &&
      observed.convergence?.semantic?.query_embedding?.available === true &&
      observed.convergence?.semantic?.query_embedding?.diagnostic?.model === ACTIVE_EMBEDDING_SPEC.model
    return {
      snapshot,
      lexicalProven,
      semanticProven,
      proven: semanticRequired ? semanticProven : lexicalProven,
      owner: observed.owner?.token,
      observed,
      lexicalBarrier,
      semanticBarrier,
      identity: lexicalProven ? stableStringify({
        generation: snapshot.generation, cursor: snapshot.cursor, covered: snapshot.covered,
        identities: snapshot.identities, policy: identity,
        fence: { cursor: fence.cursor, certain: fence.certain },
        lexical_barrier: { current: lexicalBarrier.current, certain: lexicalBarrier.certain ?? null },
        semantic_barrier: {
          current: semanticBarrier.current,
          certain: semanticBarrier.certain ?? null,
          reason: semanticBarrier.reason ?? null,
        },
        embedding_identity: {
          active_embedding_spec_id: snapshot.semantic.active_embedding_spec_id,
          model: observed.convergence?.semantic?.query_embedding?.diagnostic?.model ?? null,
        },
        observed: { cursor: observed.freshness.cursor, certain: observed.freshness.certain,
          owner: observed.owner?.token ?? null },
      }) : null,
      diagnostic: {
        reason: snapshot && !matchesLexicalGenerationIdentity(snapshot.identities, identity)
          ? "generation_identity_mismatch" : fence.reason ?? observed.freshness?.reason ?? "generation_unproven",
        message: "A current, event-certain lexical generation is not proven.",
      },
      semanticDiagnostic: semanticDiagnostic({
        snapshot,
        semanticBarrier,
        observed,
      }),
    }
  }

  async function lexical(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    lastProof = null
    await currentIdentity(request)
    let before = null
    let diagnostic = { reason: "controller_unavailable", message: "No readiness controller is available." }
    const semanticDesired = ["lexical", "timeline"].includes(request.kind ?? "lexical") &&
      hasQuery(request) &&
      ["background", "required"].includes(controller?.identity?.semantic_contract?.mode)
    try {
      if (controller) {
        const initial = await cancellable(() => controller.barrier({
          capability: "lexical", ...(request.kind === "thread" ? { wait: true } : {}),
        }), signal)
        diagnostic = { reason: "reconciliation_pending", message: "A current lexical generation is not proven." }
        if (initial.current === true) {
          if (semanticDesired) {
            try { await semanticBarrierState(controller, request, semanticDeadlineMs) } catch (error) {
              if (error.code !== "semantic_deadline") throw error
              diagnostic = { reason: error.code, message: String(error.message ?? error) }
            }
          }
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
          semanticCurrent: semanticDesired && before.semanticProven,
          semanticDiagnostic: semanticDesired && !before.semanticProven ? before.semanticDiagnostic : null,
        }), signal)
        let after
        try {
          after = await serviceProof(request)
          if (after.lexicalProven && before.identity === after.identity) {
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

  async function semantic(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    lastProof = null
    await currentIdentity(request)
    if (!controller || !semanticBackend) {
      return semanticScopeError()
    }
    let before
    try {
      const barrier = await semanticBarrierState(controller, request, semanticDeadlineMs)
      if (barrier.current !== true) {
        return semanticCapabilityError(barrier.reason ?? "semantic_unavailable", barrier.message ?? "Semantic serving is not current for the active generation.")
      }
      before = await serviceProof(request, { semanticRequired: true })
      if (!before.semanticProven) {
        return semanticCapabilityError(before.semanticDiagnostic.reason, before.semanticDiagnostic.message)
      }
      const result = await cancellable(() => semanticBackend({
        ...request,
        db: before.snapshot.db,
        generation: before.snapshot.generation,
      }), signal)
      if (result?.error === "semantic_unavailable") {
        return semanticCapabilityError("semantic_unavailable", result.note ?? "Semantic serving is unavailable for this request.")
      }
      const after = await serviceProof(request, { semanticRequired: true, waitForSemantic: false })
      try {
        if (!after.semanticProven || before.identity !== after.identity) {
          return semanticCapabilityError(
            "readiness_changed_during_read",
            "Semantic proof changed during indexed evaluation.",
          )
        }
        lastProof = { generation: after.snapshot.generation, cursor: after.snapshot.cursor, owner: after.owner }
        return result
      } finally {
        after.snapshot?.db.close()
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error.code === "artifact_tombstone_ledger_invalid") throw error
      if (error.code === "semantic_deadline") {
        return semanticCapabilityError("semantic_deadline", String(error.message ?? error))
      }
      return semanticCapabilityError(error.code ?? "semantic_unavailable", String(error.message ?? error))
    } finally {
      before?.snapshot?.db.close()
    }
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
        semantic: {
          mode: controller?.identity?.semantic_contract?.mode ?? "unsupported",
          current: observed.state === "READY" &&
            index?.generation != null &&
            index?.semantic?.active_embedding_spec_id === ACTIVE_EMBEDDING_SPEC.id &&
            index?.semantic?.missing_vectors === 0 &&
            observed.convergence?.semantic?.query_embedding?.available === true,
          generation: index?.generation ?? null,
          vectors_indexed: index?.semantic?.vectors_indexed ?? 0,
          missing_vectors: index?.semantic?.missing_vectors ?? 0,
          current_automatic_action: observed.convergence?.status === "pending" ? "converging" : null,
          diagnostic: observed.convergence?.diagnostic ?? null,
        },
      }
    } catch (error) {
      signal?.throwIfAborted()
      return {
        state: "unavailable",
        lexical: { generation: null, event_cursor: null, pending_changes: null, certain: false,
          current_automatic_action: null,
          serving_path: error.code === "artifact_tombstone_ledger_invalid" ? "blocked" : directBackend ? "direct" : "blocked" },
        semantic: {
          mode: controller?.identity?.semantic_contract?.mode ?? "unsupported",
          current: false,
          generation: null,
          vectors_indexed: 0,
          missing_vectors: 0,
          current_automatic_action: null,
          diagnostic: { reason: error.code ?? "readiness_unavailable", message: String(error.message ?? error) },
        },
        diagnostic: { reason: error.code ?? "readiness_unavailable", message: String(error.message ?? error) },
      }
    } finally { index?.db.close() }
  }

  return {
    lexical,
    semantic,
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
        opts: {
          now: request.now,
          lexicalOnly: request.semanticCurrent !== true,
          semanticDiagnostic: request.semanticDiagnostic ?? null,
        } })
    },
    semanticBackend: (request) => {
      const backend = request.kind === "recall" ? indexedRecall : indexedSimilar
      return backend({ deskRoot: request.deskRoot, db: request.db, input: request, opts: request.opts })
    },
  })
}
