import { openSnapshot } from "../db/status-read.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { directLexicalSearch, loadCurrentTombstoneLedger } from "./direct-lexical.js"
import { expectedLexicalGenerationIdentity, matchesLexicalGenerationIdentity } from "./generations.js"
import { stableStringify } from "./identity.js"
import { indexOwnerSentence, outranks, writerRuns } from "./index-writer.js"
import { deskVersion } from "../package-metadata.js"
import { indexedRecall, indexedSearch, indexedSimilar, indexedTimeline, SEMANTIC_CATCHING_UP, SEMANTIC_OFF } from "../tools/search.js"
import { indexedThread } from "../tools/thread.js"

function semanticScopeError() {
  return semanticCapabilityError("semantic_unavailable", NOT_CONNECTED)
}

function readinessError(reason, message, detail = null) {
  return {
    status: "error", code: "required_capability_unavailable", capability: "lexical",
    diagnostic: { reason, message, ...(detail === null ? {} : { detail }) },
  }
}

// Every refusal and note this router gives is in plain words (the "every readiness refusal and its detail are plain" test in tests/desk/mcp/__tests__/tools/search.test.js). A technical message from below (an error's own text) goes to `diagnostic.technical`, never into the words an agent reads.
const NOT_CONNECTED = "This session has no connection to Desk's search service yet."
const INDEX_BEHIND = "The search index has not caught up with recent desk changes, so these results come from reading the files."
const INDEX_CATCHING_UP = "The search index is still catching up with recent desk changes."
const INDEX_CHANGED = "The search index changed while this search ran."
const SERVICE_FAILED = "Desk's search service could not answer this request."
const NO_CONNECTION_READS_FILES = "This session has no connection to Desk's search service, so these results come from reading the files."
const OTHER_EMBEDDING_SETTINGS = "The search index was built with other embedding settings than this Desk uses."
const TEXT_NOT_PREPARED = "Some desk text is not yet prepared for meaning-based search."
const EMBEDDING_NOT_ANSWERING = "The embedding service did not answer, so the question cannot be compared by meaning."
const SETTINGS_TURN_OFF = "This desk's settings turn meaning-based search off."
const DOCUMENT_HAS_NO_TEXT = "This document has no text prepared for meaning-based search."
const REINDEX_NO_CONNECTION = "Reindexing needs Desk's search service, and this session has no connection to it."
const REINDEX_NOT_CAUGHT_UP = "The search index has not finished catching up yet; retry shortly."
const UNKNOWN_KIND = 'Meaning-based search answers only desk_recall and desk_similar (kind "recall" or "similar").'
const DEADLINE_DETAIL = "The search index was still being updated when the wait ran out."
const REINDEXED_NOTHING = "This session reindexed nothing."
const OWNER_INDEX_CURRENT = "The index already covers the desk's files."
const OWNER_INDEX_BEHIND = "That session has not finished updating it, so searches here read the files until it does."
const cannotReadOwnersIndex = (version) => `Desk ${version} (another session) owns the search index, and this session's Desk cannot read it.`
const PLAIN_REASONS = Object.freeze({
  semantic_unavailable: INDEX_CATCHING_UP,
  generation_superseded: "Another Desk session rewrote the search index while this session was updating it; Desk tries again shortly.",
  index_owner_catching_up: "The Desk session that owns the search index has not finished updating it.",
  index_owned_by_newer_desk: "The search index was built by a newer Desk that indexes the desk differently.",
  journal_integrity_failed: "Desk's record of recent desk changes could not be read, so the search index is being rebuilt.",
  convergence_failed: "The search index could not be updated.",
  readiness_changed_during_read: INDEX_CHANGED,
  controller_semantic_mismatch: "This session and Desk's search service disagree about meaning-based search settings.",
})
function plainReason(reason) {
  return PLAIN_REASONS[reason] ?? SERVICE_FAILED
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

// `observed` is the controller's status, when the call read it: the refusal then names the Desk build that owns the search index.
// Every sentence a refusal, its detail or a fallback note from this router can contain, for the plain-wording test. Composed sentences appear with sample values.
export const READINESS_WORDING = Object.freeze([
  NOT_CONNECTED, INDEX_BEHIND, INDEX_CATCHING_UP, INDEX_CHANGED, `${INDEX_CHANGED} Retry the search.`,
  `${INDEX_CHANGED} These results come from reading the files.`, SERVICE_FAILED, NO_CONNECTION_READS_FILES,
  OTHER_EMBEDDING_SETTINGS, TEXT_NOT_PREPARED, EMBEDDING_NOT_ANSWERING, SETTINGS_TURN_OFF, DOCUMENT_HAS_NO_TEXT,
  REINDEX_NO_CONNECTION, REINDEX_NOT_CAUGHT_UP, UNKNOWN_KIND, DEADLINE_DETAIL, cannotReadOwnersIndex("1.2.3"),
  REINDEXED_NOTHING, OWNER_INDEX_CURRENT, OWNER_INDEX_BEHIND, indexDeadlineMessage(30_000), indexDeadlineMessage(1_000), indexDeadlineMessage(0),
  ...Object.values(PLAIN_REASONS),
  SEMANTIC_UNAVAILABLE, SEMANTIC_FIX, EMBEDDING_FIX,
  ...[SEMANTIC_OFF_REFUSAL, NEWER_DESK_REFUSAL, UNINDEXED_DOCUMENT_REFUSAL].flatMap(({ message, fix }) => [message, fix]),
  deadlineMessage(30_000), deadlineMessage(1_000), deadlineMessage(0),
  indexOwnerSentence({ version: "1.2.3", this_controller: true }),
  indexOwnerSentence({ version: "1.2.3", this_controller: false }),
])

function semanticCapabilityError(reason, detail, { message = SEMANTIC_UNAVAILABLE, fix = SEMANTIC_FIX, observed = null, technical = null } = {}) {
  const owner = indexOwnerSentence(observed?.index_owner)
  return {
    status: "error", code: "required_capability_unavailable", capability: "semantic",
    diagnostic: {
      reason, message, detail: owner === null ? detail : `${detail} ${owner}`,
      ...(technical === null ? {} : { technical }),
    },
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

// With no deadline, a recall whose index keeps moving on reads at most this many times before it refuses.
const READ_ATTEMPTS_WITHOUT_DEADLINE = 20

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

// A generation row's settings, without the row id and cursor that differ between commits of the same content.
function generationSettings({ id, event_cursor, ...settings }) {
  return settings
}

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

// What a search says when what it waits for did not catch up within the call's wait.
function catchUpDeadline(subject, deadlineMs) {
  if (!Number.isFinite(deadlineMs) || deadlineMs <= 0) return `${subject} did not finish catching up in time.`
  const seconds = Math.max(1, Math.round(deadlineMs / 1000))
  return `${subject} did not finish catching up within ${seconds} ${seconds === 1 ? "second" : "seconds"}.`
}
function deadlineMessage(deadlineMs) {
  return catchUpDeadline("Meaning-based search", deadlineMs)
}
// desk_thread and desk_reindex wait for the index itself.
function indexDeadlineMessage(deadlineMs) {
  return catchUpDeadline("The search index", deadlineMs)
}
const INDEX_DEADLINE = "index_deadline"

// The deadline refusal of desk_thread and desk_reindex, naming the owner when the controller reports one.
async function indexDeadlineError(controller, deadlineMs, signal) {
  const owner = indexOwnerSentence((await observedStatus(controller, signal))?.index_owner)
  return readinessError(INDEX_DEADLINE, indexDeadlineMessage(deadlineMs), owner === null ? DEADLINE_DETAIL : `${DEADLINE_DETAIL} ${owner}`)
}

// Waits for the index to catch up, but no longer than the call's deadline.
function lexicalWait(controller, signal, deadlineMs) {
  return withDeadline(() => cancellable(() => controller.barrier({ capability: "lexical", wait: true }), signal),
    deadlineMs, INDEX_DEADLINE, DEADLINE_DETAIL)
}

function semanticDiagnostic(proof) {
  if (proof.semanticBarrier.current !== true) {
    return {
      reason: proof.semanticBarrier.reason ?? "semantic_unavailable",
      message: SEMANTIC_CATCHING_UP,
    }
  }
  if (!proof.lexicalProven) return proof.diagnostic
  if (proof.snapshot?.semantic?.active_embedding_spec_id !== ACTIVE_EMBEDDING_SPEC.id) {
    return {
      reason: "semantic_unavailable",
      message: OTHER_EMBEDDING_SETTINGS,
    }
  }
  if (proof.snapshot?.semantic?.missing_vectors !== 0) {
    return {
      reason: "semantic_unavailable",
      message: TEXT_NOT_PREPARED,
    }
  }
  if (proof.observed?.convergence?.semantic?.query_embedding?.available !== true) {
    return {
      reason: "semantic_unavailable",
      message: EMBEDDING_NOT_ANSWERING,
    }
  }
  return {
    reason: "semantic_unavailable",
    message: INDEX_CATCHING_UP,
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
      DEADLINE_DETAIL,
    )
  } catch (error) {
    signal?.throwIfAborted()
    if (error.code === "semantic_deadline") throw error
    return {
      current: false,
      reason: error.code ?? "semantic_unavailable",
      message: plainReason(error.code),
      technical: String(error.message ?? error),
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
  // How long desk_thread and desk_reindex wait for the index to catch up.
  indexDeadlineMs = 30_000,
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
          message: plainReason(error.code),
          technical: String(error.message ?? error),
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
    // The index is current when it is this controller's own generation, or another build's generation with exactly the content this controller last proved current: the owner's index read by a build standing aside, or an older build's re-commit of the unchanged desk.
    const ownGeneration = sameCursor(snapshot?.cursor, fence.cursor) && sameCursor(snapshot?.covered, fence.cursor)
    const sameContent = typeof observed.freshness?.content === "string" && snapshot?.content === observed.freshness.content
    const lexicalProven = currentAndCertain && snapshot?.generation != null && (ownGeneration || sameContent) &&
      matchesLexicalGenerationIdentity(snapshot.identities, identity)
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
      message: INDEX_BEHIND,
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
      // Generations with the same content answer alike, so a re-commit of the unchanged desk during a read does not void it.
      identity: lexicalProven ? stableStringify({
        ...(typeof snapshot.content === "string" ? { content: snapshot.content, identities: generationSettings(snapshot.identities) }
          : { generation: snapshot.generation, cursor: snapshot.cursor, covered: snapshot.covered, identities: snapshot.identities }),
        policy: identity,
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
    let diagnostic = { reason: "controller_unavailable", message: NO_CONNECTION_READS_FILES }
    const semanticSearch = ["lexical", "timeline"].includes(request.kind ?? "lexical") && hasQuery(request)
    const semanticDesired = semanticSearch &&
      ["background", "required"].includes(controller?.identity?.semantic_contract?.mode)
    try {
      if (controller) {
        const initial = request.kind === "thread" ? await lexicalWait(controller, signal, indexDeadlineMs)
          : await cancellable(() => controller.barrier({ capability: "lexical" }), signal)
        diagnostic = { reason: "reconciliation_pending", message: INDEX_BEHIND }
        if (initial.current === true) {
          if (semanticDesired) {
            try { await semanticBarrierState(controller, request, semanticDeadlineMs) } catch (error) {
              signal?.throwIfAborted()
              diagnostic = { reason: error.code, message: INDEX_BEHIND }
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
      if (error.code === INDEX_DEADLINE) return indexDeadlineError(controller, indexDeadlineMs, signal)
      diagnostic = { reason: error.code ?? "readiness_unavailable", message: INDEX_BEHIND, technical: String(error.message ?? error) }
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
          diagnostic = { reason: "readiness_changed_during_read", message: `${INDEX_CHANGED} These results come from reading the files.` }
        } catch (error) {
          signal?.throwIfAborted()
          if (error.code === "artifact_tombstone_ledger_invalid") throw error
          diagnostic = { reason: error.code ?? "readiness_unavailable", message: INDEX_BEHIND, technical: String(error.message ?? error) }
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
      DEADLINE_DETAIL,
    )
  }

  async function semantic(request = {}) {
    const { signal } = request
    signal?.throwIfAborted()
    lastProof = null
    if (!isSemanticKind(request.kind)) {
      return {
        status: "error", code: "required_capability_unavailable", capability: "semantic",
        diagnostic: { reason: "invalid_request", message: UNKNOWN_KIND },
      }
    }
    await currentIdentity(request)
    if (!controller || !semanticBackend) {
      return semanticScopeError()
    }
    if (controller.identity?.semantic_contract?.mode === "unsupported") {
      return semanticCapabilityError(SEMANTIC_OFF.reason, SETTINGS_TURN_OFF, SEMANTIC_OFF_REFUSAL)
    }
    const remaining = callDeadline(semanticDeadlineMs)
    let before
    let observed = null
    // Each refusal names the Desk build that owns the search index, read from the controller's status.
    const refuse = async (reason, detail, options = {}) => {
      observed ??= await observedStatus(controller, signal)
      // A refusal whose detail already names the owner passes `observed: null`, so the owner is not named twice.
      return semanticCapabilityError(reason, detail, { ...embeddingRefusal(observed), observed, ...options })
    }
    // A change landing during the wait or the read does not end the call: the controller catches up again and the read
    // starts over, until one read is current from start to finish or the deadline runs out. Each answer still comes from
    // a proven current index, and a read whose index moved on is never returned.
    const deadlineAt = Number.isFinite(semanticDeadlineMs) && semanticDeadlineMs > 0 ? Date.now() + semanticDeadlineMs : null
    const mayReadAgain = (attempt) => deadlineAt === null ? attempt < READ_ATTEMPTS_WITHOUT_DEADLINE : Date.now() < deadlineAt
    try {
      for (let attempt = 1; ; attempt += 1) {
        before?.snapshot?.db.close()
        before = null
        const barrier = await semanticBarrierState(controller, request, remaining())
        if (barrier.current !== true) {
          const reason = barrier.reason ?? "semantic_unavailable"
          return refuse(reason, barrier.message ?? plainReason(reason), {
            ...(reason === NEWER_DESK_REASON ? NEWER_DESK_REFUSAL : {}),
            ...(barrier.technical ? { technical: barrier.technical } : {}),
          })
        }
        before = await serviceProof(request, { semanticRequired: true, remaining })
        observed = before.observed
        if (before.reclaimable) {
          before.snapshot.db.close()
          before = null
          await reclaimIndex(request, remaining)
          before = await serviceProof(request, { semanticRequired: true, remaining })
          observed = before.observed
        }
        if (before.yields) {
          return refuse(NEWER_DESK_REASON, cannotReadOwnersIndex(before.snapshot.writer.version), { ...NEWER_DESK_REFUSAL, observed: null })
        }
        if (!before.semanticProven) {
          // The controller is catching up with a change that arrived after the wait.
          if (before.lexicalBarrier.current !== true && mayReadAgain(attempt)) continue
          const diagnostic = before.lexicalProven ? before.semanticDiagnostic : { reason: before.diagnostic.reason, message: INDEX_CATCHING_UP }
          return refuse(diagnostic.reason, diagnostic.message)
        }
        const result = await cancellable(() => semanticBackend({
          ...request,
          db: before.snapshot.db,
          generation: before.snapshot.generation,
        }), signal)
        if (result?.error === "semantic_unavailable") {
          // The proof already showed the embedding service answering and no vectors missing, so for desk_similar this means the chosen document has none of its own.
          return request.kind === "similar"
            ? refuse("semantic_unavailable", DOCUMENT_HAS_NO_TEXT, { ...UNINDEXED_DOCUMENT_REFUSAL, ...(result.note ? { technical: result.note } : {}) })
            : refuse("semantic_unavailable", EMBEDDING_NOT_ANSWERING, { fix: EMBEDDING_FIX, ...(result.note ? { technical: result.note } : {}) })
        }
        const after = await serviceProof(request, { semanticRequired: true, waitForSemantic: false })
        try {
          if (after.semanticProven && before.identity === after.identity) {
            lastProof = { generation: after.snapshot.generation, cursor: after.snapshot.cursor, owner: after.owner }
            return result
          }
        } finally {
          after.snapshot?.db.close()
        }
        if (!mayReadAgain(attempt)) return refuse("readiness_changed_during_read", `${INDEX_CHANGED} Retry the search.`)
      }
    } catch (error) {
      signal?.throwIfAborted()
      if (error.code === "artifact_tombstone_ledger_invalid") throw error
      if (error.code === "semantic_deadline") {
        return refuse("semantic_deadline", DEADLINE_DETAIL, { message: deadlineMessage(semanticDeadlineMs) })
      }
      return refuse(error.code ?? "semantic_unavailable", plainReason(error.code), { technical: String(error.message ?? error) })
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
      if (!controller) return readinessError("controller_unavailable", REINDEX_NO_CONNECTION)
      const result = await cancellable(() => controller.beginConvergence(), signal)
      let barrier
      try {
        barrier = await lexicalWait(controller, signal, indexDeadlineMs)
      } catch (error) {
        if (error.code !== INDEX_DEADLINE) throw error
        barrier = null
      }
      // Only the build that owns the index writes it: a session of a lower build says so instead of reporting a reindex it did not do.
      const owner = (await observedStatus(controller, signal))?.index_owner
      if (owner?.this_controller === false) {
        const current = barrier?.current === true
        return { status: "not_reindexed", action: "none", index_current: current,
          message: `${REINDEXED_NOTHING} ${indexOwnerSentence(owner)} ${current ? OWNER_INDEX_CURRENT : OWNER_INDEX_BEHIND}` }
      }
      if (barrier === null) return indexDeadlineError(controller, indexDeadlineMs, signal)
      if (barrier.current !== true) {
        return readinessError("reconciliation_pending", REINDEX_NOT_CAUGHT_UP)
      }
      return { status: "ok", action: "controller_convergence", reused: result?.reused === true }
    },
  }
}

export function createDeskQueryRouter({ controller, version, semanticDeadlineMs } = {}) {
  return createQueryRouter({
    controller,
    version,
    ...(semanticDeadlineMs === undefined ? {} : { semanticDeadlineMs, indexDeadlineMs: semanticDeadlineMs }),
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
