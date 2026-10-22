import { openSnapshot } from "../db/status-read.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { directLexicalSearch, loadCurrentTombstoneLedger } from "./direct-lexical.js"
import { expectedLexicalGenerationIdentity, matchesLexicalGenerationIdentity } from "./generations.js"
import { stableStringify } from "./identity.js"
import { outranks, writerRuns } from "./index-writer.js"
import { deskVersion } from "../package-metadata.js"
import { indexedRecall, indexedSearch, indexedSimilar, indexedTimeline, SEMANTIC_CATCHING_UP, SEMANTIC_OFF } from "../tools/search.js"
import { indexedThread } from "../tools/thread.js"

function semanticScopeError() {
  return semanticCapabilityError("semantic_unavailable", "This session is not connected to Desk's search controller.")
}

function readinessError(reason, message) {
  return {
    status: "error", code: "required_capability_unavailable", capability: "lexical",
    diagnostic: { reason, message },
  }
}

// What desk_recall and desk_similar say when they cannot answer: plain words and what to do, with the technical reason kept in `diagnostic.reason` and `diagnostic.detail`. The fix depends on the cause, so a retry is suggested only when waiting can help.
const SEMANTIC_UNAVAILABLE = "Meaning-based search is not available right now."
const EXACT_WORDS_NOW = "desk_search answers now with exact-word matches."
const SEMANTIC_FIX = `Retry in about a minute; if it keeps failing, call desk_status. ${EXACT_WORDS_NOW}`
const EMBEDDING_FIX = `Start Ollama, run \`ollama pull ${ACTIVE_EMBEDDING_SPEC.model}\`, then call desk_reindex. ${EXACT_WORDS_NOW}`
const SEMANTIC_OFF_REFUSAL = Object.freeze({
  message: "Meaning-based search is off for this desk.",
  fix: `Use desk_search for exact-word matches. To turn meaning-based search on, set desk_runtime.semantic to "background" in Desk's activation config and restart the session.`,
})
const NEWER_DESK_REASON = "index_owned_by_newer_desk"
const NEWER_DESK_REFUSAL = Object.freeze({
  message: "A newer Desk session on this desk is serving meaning-based search.",
  fix: `${EXACT_WORDS_NOW} To use meaning-based search here, run this session on the newer Desk: update Desk for this host and restart the session.`,
})
const UNINDEXED_DOCUMENT_REFUSAL = Object.freeze({
  message: "This document has not been indexed for meaning-based search yet.",
  fix: `Pick another document; if this one has text, call desk_reindex and try again. ${EXACT_WORDS_NOW}`,
})

function semanticCapabilityError(reason, detail, { message = SEMANTIC_UNAVAILABLE, fix = SEMANTIC_FIX } = {}) {
  return {
    status: "error", code: "required_capability_unavailable", capability: "semantic",
    diagnostic: { reason, message, detail },
    fix,
  }
}

// The controller's last check found the embedding service not answering; waiting does not help until it runs.
function embeddingRefusal(observed) {
  return observed?.convergence?.semantic?.query_embedding?.available === false ? { fix: EMBEDDING_FIX } : {}
}

// Only chooses the fix sentence, so a failed status read leaves the refusal as it is.
async function observedStatus(controller, signal) {
  try {
    return await cancellable(() => controller.status(), signal)
  } catch (error) {
    signal?.throwIfAborted()
    return null
  }
}

// One deadline for a whole call: each wait inside it gets only the time that is left. A deadline of 0 or less means none.
export function callDeadline(timeoutMs, now = Date.now) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return () => timeoutMs
  const end = now() + timeoutMs
  return () => Math.max(1, end - now())
}

// The Desk version this session runs; its controller records the same one with each generation it writes.
const RUNNING_VERSION = deskVersion()

// Another Desk build's controller on this desk wrote the shared search index after this controller converged. A build that ranks lower, or an older build that records no writer, cannot be changed to step aside, so this controller reconciles the index again; vectors still valid under the same embedding specification are kept. A build that ranks higher keeps the index.
const INDEX_RECLAIM_REASON = "index_written_by_other_controller"

function isSemanticKind(kind) {
  return kind === "recall" || kind === "similar"
}

function sameCursor(a, b) {
  return typeof a?.journal_id === "string" && a.journal_id.length > 0 &&
    Number.isSafeInteger(a.sequence) && a.sequence >= 0 &&
    a.journal_id === b?.journal_id && a.sequence === b?.sequence
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

function hasQuery(request) {
  return typeof request.query === "string" && request.query.trim().length > 0
}

function semanticDiagnostic(proof) {
  if (proof.semanticBarrier.current !== true) {
    return {
      reason: proof.semanticBarrier.reason ?? "semantic_unavailable",
      message: proof.semanticBarrier.message ?? SEMANTIC_CATCHING_UP,
    }
  }
  if (!proof.lexicalProven) return proof.diagnostic
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
  version = RUNNING_VERSION,
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

  async function serviceProof(request, { semanticRequired = false, waitForSemantic = semanticRequired, remaining } = {}) {
    const { signal } = request
    let fence = await cancellable(() => controller.fenceEvents({ signal }), signal)
    let lexicalBarrier = await cancellable(() => controller.barrier({ capability: "lexical" }), signal)
    const semanticBarrier = semanticRequired && waitForSemantic
      ? await semanticBarrierState(controller, request, remaining())
      : await cancellable(() => controller.barrier({ capability: "semantic" }), signal).catch((error) => ({
          current: false,
          reason: error.code ?? "semantic_unavailable",
          message: String(error.message ?? error),
        }))
    if (semanticRequired && waitForSemantic) {
      // The first fence can discover changes whose convergence we just awaited.
      // Prove the pre-evaluation snapshot against current facts, not that old fence.
      fence = await cancellable(() => controller.fenceEvents({ signal }), signal)
      lexicalBarrier = await cancellable(() => controller.barrier({ capability: "lexical" }), signal)
    }
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
    const diagnostic = {
      reason: snapshot && !matchesLexicalGenerationIdentity(snapshot.identities, identity)
        ? "generation_identity_mismatch" : fence.reason ?? observed.freshness?.reason ?? "generation_unproven",
      message: "A current, event-certain lexical generation is not proven.",
    }
    // The controller says it is current and certain, yet the index was last written under another journal: another controller (another Desk build on this desk) wrote it since.
    const foreign = currentAndCertain && snapshot !== null && !lexicalProven && snapshot.cursor?.journal_id !== fence.cursor.journal_id
    // A higher-ranked writer keeps the index only while its controller runs; once its sessions have ended, this build takes the index back.
    const yields = foreign && snapshot.writer !== null && outranks(snapshot.writer, { version, build: controller.identity.build }) &&
      await writerRuns(snapshot.writer, controller.stateDir)
    return {
      snapshot,
      lexicalProven,
      semanticProven,
      reclaimable: foreign && !yields,
      yields,
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
      diagnostic,
      semanticDiagnostic: semanticDiagnostic({
        snapshot,
        semanticBarrier,
        observed,
        lexicalProven,
        diagnostic,
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
    const semanticSearch = ["lexical", "timeline"].includes(request.kind ?? "lexical") && hasQuery(request)
    const semanticDesired = semanticSearch &&
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
              signal?.throwIfAborted()
              diagnostic = { reason: error.code, message: error.message }
            }
          }
          before = await serviceProof(request)
          diagnostic = before.diagnostic
          // Exact-word search does not wait: it reads the files now, and the controller reconciles the index for the next query.
          if (before.reclaimable) await cancellable(() => controller.markUncertain(INDEX_RECLAIM_REASON), signal)
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
          semanticDiagnostic: semanticDesired && !before.semanticProven ? before.semanticDiagnostic
            : semanticSearch && !semanticDesired ? SEMANTIC_OFF : null,
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

  async function reclaimIndex(request, remaining) {
    await cancellable(() => controller.markUncertain(INDEX_RECLAIM_REASON), request.signal)
    await withDeadline(
      () => cancellable(() => controller.barrier({ capability: "semantic", wait: true }), request.signal),
      remaining(),
      "semantic_deadline",
      "Semantic convergence did not become current before the deadline.",
    )
  }

  async function semantic(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    lastProof = null
    if (!isSemanticKind(request.kind)) {
      return {
        status: "error", code: "required_capability_unavailable", capability: "semantic",
        diagnostic: { reason: "invalid_request", message: 'Semantic requests must set kind to "recall" or "similar".' },
      }
    }
    await currentIdentity(request)
    if (!controller || !semanticBackend) {
      return semanticScopeError()
    }
    if (controller.identity?.semantic_contract?.mode === "unsupported") {
      return semanticCapabilityError(SEMANTIC_OFF.reason, "This desk's readiness policy turns meaning-based search off.", SEMANTIC_OFF_REFUSAL)
    }
    const remaining = callDeadline(semanticDeadlineMs)
    let before
    try {
      const barrier = await semanticBarrierState(controller, request, remaining())
      if (barrier.current !== true) {
        const observed = await observedStatus(controller, signal)
        return semanticCapabilityError(barrier.reason ?? "semantic_unavailable", barrier.message ?? "Semantic serving is not current for the active generation.", embeddingRefusal(observed))
      }
      before = await serviceProof(request, { semanticRequired: true, remaining })
      if (before.reclaimable) {
        before.snapshot.db.close()
        before = null
        await reclaimIndex(request, remaining)
        before = await serviceProof(request, { semanticRequired: true, remaining })
      }
      if (before.yields) {
        return semanticCapabilityError(NEWER_DESK_REASON, "The search index was last written by a Desk build that ranks above this one.", NEWER_DESK_REFUSAL)
      }
      if (!before.semanticProven) {
        return semanticCapabilityError(before.semanticDiagnostic.reason, before.semanticDiagnostic.message, embeddingRefusal(before.observed))
      }
      const result = await cancellable(() => semanticBackend({
        ...request,
        db: before.snapshot.db,
        generation: before.snapshot.generation,
      }), signal)
      if (result?.error === "semantic_unavailable") {
        // The proof already showed the embedding service answering and no vectors missing, so for desk_similar this means the chosen document has none of its own.
        return semanticCapabilityError("semantic_unavailable", result.note ?? "Semantic serving is unavailable for this request.",
          request.kind === "similar" ? UNINDEXED_DOCUMENT_REFUSAL : { fix: EMBEDDING_FIX })
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
        return semanticCapabilityError("semantic_deadline", error.message)
      }
      return semanticCapabilityError(error.code ?? "semantic_unavailable", String(error.message ?? error))
    } finally {
      before?.snapshot?.db.close()
    }
  }

  async function snapshot(request = {}, { readIndex = openSnapshot } = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    let observed
    let index
    try {
      const identity = await currentIdentity(request)
      observed = controller ? await cancellable(() => controller.status(), signal) : { state: "not_checked" }
      index = await readIndex(request.deskRoot)
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
    } finally { index?.db?.close() }
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

export function createDeskQueryRouter({ controller, version } = {}) {
  return createQueryRouter({
    controller,
    version,
    directBackend: directLexicalSearch,
    indexedBackend: (request) => {
      const backend = request.kind === "thread" ? indexedThread
        : request.kind === "timeline" ? indexedTimeline : indexedSearch
      return backend({ deskRoot: request.deskRoot, db: request.db, input: request,
        opts: {
          ...request.opts,
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
