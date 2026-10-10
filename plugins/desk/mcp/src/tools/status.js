import * as path from "node:path"
import { indexDbPath } from "../db/init.js"
import { unavailableLocalDb } from "../db/status-read.js"
import { ACTIVE_EMBEDDING_SPEC } from "../indexer/spec.js"
import { personPrefix } from "../util/paths.js"
import { deskVersion } from "../package-metadata.js"
import { createDeskQueryRouter } from "../readiness/query-router.js"
import { activeTasks } from "../desk/active-tasks.js"
import { factoryStatus } from "./factory-context.js"
import { pullStillFailing } from "../runtime/health.js"
import { aheadBehindCountsAsync, hasRemoteConfiguredAsync, readFetchOkAt, readSyncStatus } from "../runtime/sync-worker.js"
import { createStatusInspection } from "../runtime/status-inspection.js"


// desk_status's inputs are read elsewhere: `detail` where the answer is shaped for the caller (runtime/desk-session.js, which
// compacts the payload built here unless `detail: true`), and `has_instructions` by a hosted Desk's startup wrapper
// (runtime/hosted.js); this function always builds the full payload. Listed here so
// __tests__/tool_schema_parity.test.js checks the schema against it like every other tool.
export const DESK_STATUS_FIELDS = ["detail", "has_instructions"]

/**
 * `desk_status`'s own read of sync state (spec §2's "desk_status surfaces
 * sync state"; controller ruling 5) -- local-only, no network call: a plain
 * desk with no remote (or no git repo at all -- the same `git remote`
 * failure either way) reports the literal string `"no remote configured"`;
 * otherwise `{ ahead, behind }` come from one local `git rev-list` against
 * the already-known upstream (whatever the last `fetch` saw -- this never
 * fetches itself), `null` counts (no upstream yet) reported as `0`/`0`, and
 * `last_push_at`/a blocked reason come from the push worker's own status
 * file (`readSyncStatus`) -- never recomputed here, since only the worker
 * itself (`runtime/sync-worker.js`) and the SessionEnd safety net
 * (`finalUnpushedCheck`) ever decide what "blocked" means.
 */
async function syncStatus({ deskRoot, env }) {
  if (!await hasRemoteConfiguredAsync(deskRoot)) return "no remote configured"
  const recorded = readSyncStatus({ root: deskRoot, env })
  // How the last pull ended, when it failed: ahead/behind alone read "in sync" after an unreachable remote.
  const lastPull = pullStillFailing({ lastPull: recorded?.last_pull, lastPushAt: recorded?.last_push_at ?? null, fetchedAt: readFetchOkAt({ root: deskRoot, env }) })
    ? { last_pull: recorded.last_pull }
    : {}
  if (recorded?.blocked) {
    return { blocked: true, reason: recorded.reason ?? null, paths: recorded.paths ?? [], ...lastPull }
  }
  const counts = await aheadBehindCountsAsync({ root: deskRoot })
  return {
    blocked: false,
    ahead: counts?.ahead ?? 0,
    behind: counts?.behind ?? 0,
    last_push_at: recorded?.last_push_at ?? null,
    ...lastPull,
  }
}

const EMBEDDING_SPEC = {
  id: ACTIVE_EMBEDDING_SPEC.id,
  provider: "ollama",
  model: ACTIVE_EMBEDDING_SPEC.model,
  model_revision: ACTIVE_EMBEDDING_SPEC.model_revision,
  dimensions: ACTIVE_EMBEDDING_SPEC.dimension,
  encoding: "float32",
  chunker_id: ACTIVE_EMBEDDING_SPEC.chunker_id,
  normalization_id: ACTIVE_EMBEDDING_SPEC.normalization_id,
}

export async function desk_status({ deskRoot, person, statusContext = {}, queryRouter, signal, env = process.env }) {
  const effectiveRoot = personPrefix(deskRoot, person)
  const writeScope = effectiveRoot === deskRoot
    ? { mode: "workspace", person: null, relative_path: "." }
    : {
        mode: "person",
        person: path.basename(effectiveRoot),
        relative_path: path.posix.join("desks", path.basename(effectiveRoot)),
      }
  const reader = createStatusInspection(deskRoot, { signal })
  try {
    const root = await reader.inspect("root", statusContext.root)
    const runtime = runtimeStatus(statusContext.runtime ?? {}, env)
    const localDb = root.valid
      ? await reader.inspect("local")
      : unavailableLocalDb(root.path === null ? null : indexDbPath(root.path), "root_unavailable")
    const startup = normalizeStartup(statusContext.startup)
    const readiness = await controllerReadiness(statusContext.admission)
    const observed = await (queryRouter ?? createDeskQueryRouter({
      controller: statusContext.admission?.controller,
    })).snapshot({ deskRoot: root.valid ? root.path : null, signal }, {
      readIndex: () => root.valid ? reader.inspect("index") : null,
    })
    const lexical = root.valid ? observed.lexical : { ...observed.lexical, serving_path: "blocked" }
    const semantic = root.valid ? observed.semantic : {
      ...observed.semantic,
      current: false,
      generation: null,
      current_automatic_action: null,
    }
    const snapshots = snapshotStatus(startup)
    const vectorPacks = vectorPackStatus(startup)
    const queryEmbedding = queryEmbeddingStatus(readiness.state === "not_checked" ? startup : {}, readiness)
    const activation = activationStatus(statusContext.activation)
    const startupFallback = startupFallbackStatus({
      startup,
      documentVectors: localDb.document_vectors,
      queryEmbedding,
      lexicalIndex: localDb.lexical_index,
      readiness,
    })
    const degradedModes = degradedModesFor({
      documentVectors: localDb.document_vectors,
      queryEmbedding,
      lexicalIndex: localDb.lexical_index,
      startupFallback,
      readiness,
    })

    return {
      status: root.valid ? "ok" : "error",
      root,
      activation,
      runtime,
      readiness: presentReadiness(readiness),
      lexical,
      semantic,
      local_db: localDb.local_db,
      db_schema: localDb.local_db.schema,
      active_embedding_spec: EMBEDDING_SPEC,
      snapshots,
      vector_packs: vectorPacks,
      document_vectors: localDb.document_vectors,
      query_embedding: queryEmbedding,
      lexical_index: localDb.lexical_index,
      startup_fallback: startupFallback,
      degraded_modes: degradedModes,
      write_scope: writeScope,
      // The redacted active-task listing session start and status render (./desk/active-tasks.js).
      active_tasks: root.valid ? activeTasks(root.path) : null,
      factory: factoryStatus({ env, deskRoot: root.valid ? root.path : null }),
      sync: root.valid ? await syncStatus({ deskRoot: root.path, env }) : null,
      summary: summaryFor({ root, activation, localDb, snapshots, vectorPacks, startupFallback }),
    }
  } finally {
    await reader.close()
  }
}

// One word for agents (`ready`, `converging`, `degraded`, `unavailable`, `not_checked`), with the controller's own
// state name and convergence snapshot under `detail`. The raw controller state used to sit in `readiness.state`, where
// `RECOVERING` read as an outage next to an admission `state` of `ready` and sent agents chasing a problem that was not
// there (round 5: 7 of 16 runs raised it). The top-level `state` (admission) still decides whether Desk's tools work;
// `readiness` only describes the search index's controller.
const READINESS_MEANING = {
  ready: "The readiness controller is serving and the index has converged; nothing to do.",
  converging: "The index is still catching up in the background; reads fall back to the files and stay correct. Nothing to fix.",
  degraded: "The index controller is recovering or its last convergence failed (see detail.convergence.diagnostic). Task, track and file tools are governed by the top-level `state`; search falls back to direct reads. Mention it in one line only if the work needs search.",
  unavailable: "The readiness controller did not answer; search falls back to direct reads. The top-level `state` still decides whether Desk's tools work.",
  not_checked: "desk_status did not ask the readiness controller.",
}

function readinessWord({ state, convergence }) {
  if (state === "not_checked" || state === "unavailable") return state
  if (state === "TERMINAL") return "unavailable"
  if (state === "RECOVERING" || convergence.status === "failed") return "degraded"
  if (state === "READY" || state === "LEXICAL_READY") return "ready"
  return "converging"
}

const LEXICAL_MEANING = "Lexical search and the index are current; semantic (embedding) search is not fully available, for example because the embedding probe failed. Tools work; semantic ranking may be missing."

function presentReadiness(readiness) {
  const word = readinessWord(readiness)
  const meaning = word === "ready" && readiness.state === "LEXICAL_READY" ? LEXICAL_MEANING : READINESS_MEANING[word]
  return { state: word, meaning, detail: { controller_state: readiness.state, convergence: readiness.convergence } }
}

async function controllerReadiness(admission) {
  const empty = { status: "not_checked", semantic: null, diagnostic: null }
  if (typeof admission?.controller?.status !== "function") {
    return { state: "not_checked", convergence: empty }
  }
  try {
    const snapshot = await admission.controller.status()
    return { state: snapshot.state, convergence: snapshot.convergence ?? empty }
  } catch (error) {
    return {
      state: "unavailable",
      convergence: {
        status: "unavailable", semantic: null,
        diagnostic: { message: String(error?.message ?? error).slice(0, 2048) },
      },
    }
  }
}


function normalizeStartup(startup) {
  return startup !== null && typeof startup === "object" ? startup : {}
}

function startupEnsure(startup) {
  const ensure = startup.ensure_index
  return ensure !== null && typeof ensure === "object" ? ensure : null
}

function snapshotStatus(startup) {
  const ensure = startupEnsure(startup)
  const snapshot = ensure?.snapshot
  const base = { module_state: "available" }
  if (!snapshot) {
    return { ...base, restore_state: "not_checked" }
  }
  return compactObject({
    ...base,
    restore_state: snapshotRestoreState(snapshot),
    snapshot_id: snapshot.snapshot_id,
    reason: snapshot.reason,
    reconciled: snapshot.reconciled,
    freshness: snapshot.freshness,
  })
}

function vectorPackStatus(startup) {
  const ensure = startupEnsure(startup)
  const base = { module_state: "available" }
  if (!ensure) return { ...base, import_state: "not_checked" }
  if (ensure.fallback === "vector_packs") {
    return {
      ...base,
      ...ensure.vector_packs,
      import_state: "used_as_fallback",
      fallback_used: true,
    }
  }
  if (ensure.vector_packs?.import_state) {
    return { ...base, ...ensure.vector_packs }
  }
  return { ...base, import_state: "absent" }
}

function queryEmbeddingStatus(startup, readiness) {
  const semantic = startupEnsure(startup)?.semantic
  const base = { spec_id: EMBEDDING_SPEC.id }
  const query = readiness.convergence.semantic?.query_embedding
  if (typeof query?.available === "boolean") {
    return { ...base, available: query.available, diagnostic: query.diagnostic }
  }
  if (typeof semantic?.embedding_available === "boolean") {
    return compactObject({
      ...base,
      available: semantic.embedding_available,
      diagnostic: semantic.embedding_diagnostic,
    })
  }
  return {
    ...base,
    available: "not_checked",
    note: "desk_status does not probe live embedding endpoints during session start",
  }
}

function startupFallbackStatus({
  startup,
  documentVectors,
  queryEmbedding,
  lexicalIndex,
  readiness,
}) {
  const ensure = startupEnsure(startup)
  const mode = startup.fallback_mode ?? inferStartupFallbackMode({ ensure, lexicalIndex })
  const degraded = ["failed", "unavailable"].includes(readiness.convergence.status)
    || (startup.degraded ?? fallbackIsDegraded({
      documentVectors,
      mode,
      queryEmbedding,
    }))
  return compactObject({
    mode,
    degraded,
    duration_ms: startup.duration_ms,
    budget_ms: startup.budget_ms,
  })
}

function degradedModesFor({
  documentVectors,
  queryEmbedding,
  lexicalIndex,
  startupFallback,
  readiness,
}) {
  const modes = []
  if (readiness.convergence.status === "failed") modes.push("convergence_failed")
  if (readiness.state === "unavailable") modes.push("readiness_unavailable")
  if (documentVectors.state === "partial") modes.push("document_vectors_partial")
  if (documentVectors.state === "missing") modes.push("document_vectors_missing")
  if (queryEmbedding.available === false) modes.push("query_embedding_unavailable")
  if (startupFallback.mode === "lexical_only" && lexicalIndex.available) {
    modes.push("lexical_fallback_active")
  }
  return modes
}

function snapshotRestoreState(snapshot) {
  if (snapshot.restored === true) return "restored"
  if (snapshot.reason === "snapshot_already_restored") return "already_restored"
  return "skipped"
}


function inferStartupFallbackMode({ ensure, lexicalIndex }) {
  if (!ensure) return "not_checked"
  if (ensure.fallback === "vector_packs" && ensure.snapshot?.restored) {
    return "snapshot_then_vector_packs"
  }
  if (ensure.fallback === "vector_packs") return "vector_packs"
  if (
    (ensure.semantic?.repairable_missing_vectors ?? ensure.semantic?.missing_vectors) > 0 &&
    lexicalIndex.available
  ) {
    return "lexical_only"
  }
  if (ensure.snapshot?.restored) return "snapshot"
  if (ensure.reason === "startup_budget_exceeded") return "startup_deferred"
  return ensure.built ? "rebuild" : "fresh"
}

function fallbackIsDegraded({ documentVectors, mode, queryEmbedding }) {
  return mode === "lexical_only" ||
    mode === "startup_deferred" ||
    documentVectors.state === "missing" ||
    documentVectors.state === "partial" ||
    queryEmbedding.available === false
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  )
}


function runtimeStatus(runtime, env) {
  const sourceMirrorPath = runtime.source_mirror_path ?? runtime.sourceMirrorPath ?? null
  return {
    plugin: {
      name: "desk",
      version: deskVersion(env),
    },
    node: {
      platform: process.platform,
      arch: process.arch,
      abi: process.versions.modules,
    },
    target: runtime.target ?? defaultTarget(),
    runtime_cache_dir: runtime.runtime_cache_dir ?? runtime.runtimeCacheDir ?? null,
    source_mirror_path: sourceMirrorPath,
    loaded_from_source_mirror: typeof sourceMirrorPath === "string" && sourceMirrorPath.length > 0,
  }
}

function activationStatus(activation) {
  if (activation === null || typeof activation !== "object") {
    return {
      selected_id: null,
      chain: [],
      mode: null,
      source: "not_provided",
    }
  }
  const chain = normalizeActivationChain(activation.chain)
  const selectedId = textOrNull(
    activation.selected_id ??
    activation.selectedId ??
    activation.id ??
    activation.selectedActivationId,
  )
  return compactObject({
    selected_id: selectedId,
    chain,
    mode: textOrNull(activation.mode),
    source: textOrNull(activation.source) ?? "unknown",
  })
}

function normalizeActivationChain(chain) {
  if (!Array.isArray(chain)) return []
  return chain
    .map((entry) => {
      if (typeof entry === "string" && entry.trim().length > 0) return entry
      if (entry !== null && typeof entry === "object" && typeof entry.id === "string") {
        return entry.id
      }
      return null
    })
    .filter(Boolean)
}

function textOrNull(value) {
  return typeof value === "string" && value.trim().length > 0 ? value : null
}


function defaultTarget() {
  return `${process.platform}-${process.arch}-node-${process.versions.modules}`
}



function summaryFor({ root, activation, localDb, snapshots, vectorPacks, startupFallback }) {
  const startupSummary = startupFallback.mode === "not_checked"
    ? "Snapshot restore, vector-pack import, and query embedding probes were not run."
    : `Startup fallback mode: ${startupFallback.mode}. Snapshot restore: ${snapshots.restore_state}. Vector pack import: ${vectorPacks.import_state}.`
  const activationSummary = activation.selected_id
    ? `Active activation: ${activation.selected_id}.`
    : null
  return [
    `Desk root ${root.path} resolved from ${root.source}.`,
    activationSummary,
    root.valid ? null : `Root diagnostic: ${root.diagnostic}.`,
    localDb.local_db.exists
      ? `Local DB is ${localDb.local_db.state}.`
      : "Local DB is missing; this is normal on first run.",
    startupSummary,
  ].filter(Boolean).join(" ")
}
