// desk MCP server registration.
//
// Registers all 18 tools as stdio MCP handlers. Units 3 + 5 + 6 wire every
// tool to a real implementation:
//   - Unit 3: task_create, task_update, task_archive, track_create,
//             track_update, friction_add, lesson_add
//   - M4-2 (cheap moves): task_move, track_rename
//   - Unit 5: desk_search, desk_recall, desk_similar, desk_timeline
//   - Unit 6: desk_thread (refs_graph provenance walk)
//   - Index mgmt: desk_reindex (requests shared controller convergence)
//   - Health/status: desk_status and desk_doctor (session-start-safe, non-mutating)
//   - Private work measurement: desk_work_ledger (OS-user-private work-item ledger)
//
// There is no qualitative feedback tool here. Preview feedback a participant
// chooses to offer is written as Markdown in their own desk
// (`_meta/preview-feedback.md`); the private store under src/feedback/ stays a
// protected-storage primitive for records that already exist, with no route
// from this server and none to be added without its own approval.

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"

import { TOOL_NAMES, TOOL_DESCRIPTIONS } from "./tool-names.js"
import { packageMetadata } from "./package-metadata.js"
import {
  task_create,
  task_update,
  task_archive,
} from "./tools/task.js"
import { track_create, track_update } from "./tools/track.js"
import { task_move, track_rename } from "./tools/move.js"
import { friction_add } from "./tools/friction.js"
import { lesson_add } from "./tools/lesson.js"
import { desk_work_ledger } from "./tools/work-ledger.js"
import {
  desk_search,
  desk_recall,
  desk_similar,
  desk_timeline,
} from "./tools/search.js"
import { desk_thread } from "./tools/thread.js"
import { desk_reindex } from "./tools/reindex.js"
import { desk_status } from "./tools/status.js"
import { doctorRuntime } from "./tools/doctor.js"
import {
  configureRuntimeArtifacts,
  ensureIndex,
  getSemanticCoverage,
  resolveEnsureIndexOptions,
} from "./server-helpers.js"
import { existsSync, renameSync } from "node:fs"
import { indexDbPath, openDb, closeDb } from "./db/init.js"
import { rebuildIndex } from "./indexer/index.js"
import { stableStringify } from "./readiness/identity.js"
import { CanonicalWriteRecordingError } from "./readiness/journal.js"
import { createDeskQueryRouter } from "./readiness/query-router.js"
import { admitControlPlane } from "./activation/admit.js"
import { ACTIVE_EMBEDDING_SPEC } from "./indexer/spec.js"
import { createWorkspaceWatcher } from "./readiness/workspace-watcher.js"
import { readinessContracts } from "./readiness/contracts.js"
import { probeEmbeddingService, resolveEmbeddingEndpoints, resolveEmbeddingModel } from "./indexer/embed.js"

export { TOOL_NAMES, TOOL_DESCRIPTIONS }
export { admitControlPlane, configureRuntimeArtifacts, ensureIndex, readinessContracts }

let readinessControllerModulePromise

// An effective DESK_EMBED_MODEL / OLLAMA_EMBED_MODEL that differs from the pinned model. The controller never uses it (it indexes and probes with the pinned model), so it only disqualifies this session's own query embeddings: semantic search degrades, lexical search and writes do not.
export function embeddingOverride(semantic) {
  if (semantic === "unsupported") return null
  const model = resolveEmbeddingModel()
  if (model === ACTIVE_EMBEDDING_SPEC.model) return null
  return Object.freeze({
    code: "embedding_override",
    model,
    pinned_model: ACTIVE_EMBEDDING_SPEC.model,
    embedding_spec_id: ACTIVE_EMBEDDING_SPEC.id,
    fix: `Semantic search is unavailable in this session because its environment sets the embedding model to ${JSON.stringify(model)}, not the pinned ${ACTIVE_EMBEDDING_SPEC.model}. Lexical search and writes are unaffected. To restore semantic search, remove DESK_EMBED_MODEL / OLLAMA_EMBED_MODEL from the Desk MCP server's environment (or set it to ${ACTIVE_EMBEDDING_SPEC.model}) and reconnect the Desk MCP server; another model needs a separately versioned embedding specification.`,
  })
}

export async function connectOrStartController({ deskRoot, policy, stateHome, ephemeral, onRepair }) {
  const embed = policy.semantic === "unsupported" ? null : Object.freeze({
    model: ACTIVE_EMBEDDING_SPEC.model,
    endpoints: Object.freeze(resolveEmbeddingEndpoints()),
  })
  const options = {
    root: deskRoot,
    ...readinessContracts(policy),
    stateHome,
    ephemeral,
    onRepair,
    semanticContract: {
      mode: policy.semantic,
      embedding_spec: policy.semantic === "unsupported" ? null : ACTIVE_EMBEDDING_SPEC,
      ...(embed === null ? {} : { query_embedding_probe: true, endpoints: embed.endpoints }),
    },
    handlers: {
      async beginConvergence({ eventCursor, journal }) {
        const indexOptions = resolveEnsureIndexOptions({
          startup: false,
          skipEmbed: policy.semantic === "unsupported",
          ...(embed === null ? {} : { embed }),
          eventCursor,
          identities: { policy_identity: stableStringify(policy) },
        }, { deskRoot })
        // Keep the opt-out at ensureIndex's normalization boundary; resolved
        // undefined would otherwise re-enable legacy snapshot auto-discovery.
        const result = await ensureIndexOrQuarantine(deskRoot, { ...indexOptions, snapshots: false })
        const db = openDb(deskRoot)
        try {
          // A timestamp/snapshot fast path is not proof of journal coverage.
          if (!result.summary?.lexical_generation) {
            result.summary = await rebuildIndex(deskRoot, { ...indexOptions, db, reembedMissing: true })
            result.semantic = { ...result.semantic, ...getSemanticCoverage(db) }
            result.built = true
            result.reason = "journal_reconciled"
          }
          await journal.compact({ db, generationId: result.summary.lexical_generation })
        } finally {
          closeDb(db)
        }
        if (policy.semantic !== "unsupported") {
          result.semantic.query_embedding = await probeEmbeddingService(embed)
        }
        return result
      },
    },
    watcherFactory: ({ root }) => createWorkspaceWatcher({
      root,
      ignoredPaths: stateHome ? [stateHome] : [],
    }),
  }
  const { connectOrStartController: connectReadinessController } = await loadReadinessController()
  const controller = await connectReadinessController(options)
  controller.generationPolicyIdentity = stableStringify(policy)
  controller.embeddingOverride = embeddingOverride(policy.semantic)
  return controller
}

// The index database is derived from the desk's files, so an unreadable one (truncated, or not a database at all) is moved aside and rebuilt instead of failing every convergence.
export async function ensureIndexOrQuarantine(deskRoot, options, { ensure = ensureIndex, now = Date.now } = {}) {
  try {
    return await ensure(deskRoot, options)
  } catch (error) {
    if (error?.code !== "SQLITE_NOTADB" && error?.code !== "SQLITE_CORRUPT") throw error
    const quarantined = quarantineIndexDb(deskRoot, now())
    process.stderr.write(`[desk-mcp] repaired: unreadable index database moved to ${quarantined} and rebuilt (${error.code})\n`)
    const result = await ensure(deskRoot, options)
    return { ...result, quarantined_index: quarantined }
  }
}

function quarantineIndexDb(deskRoot, stamp) {
  const dbPath = indexDbPath(deskRoot)
  const target = `${dbPath}.corrupt-${stamp}`
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) renameSync(`${dbPath}${suffix}`, `${target}${suffix}`)
  }
  return target
}

export async function beginBackgroundConvergence(admission) {
  if (typeof admission?.controller?.beginConvergence === "function") {
    return admission.controller.beginConvergence()
  }
  return null
}

function loadReadinessController() {
  readinessControllerModulePromise ??= import("./readiness/controller-client.js")
  return readinessControllerModulePromise
}

// Map tool name → implementation. Every tool now has a real body.
// Exported so tests can register a probe impl to assert dispatch threading.
export const TOOL_IMPLS = {
  task_create,
  task_update,
  task_archive,
  task_move,
  track_create,
  track_update,
  track_rename,
  friction_add,
  lesson_add,
  desk_work_ledger,
  desk_search,
  desk_recall,
  desk_similar,
  desk_timeline,
  desk_thread,
  desk_reindex,
  desk_status,
  desk_doctor: doctorRuntime,
}

const queryRouters = new WeakMap()

function routerFor(controller) {
  if (!controller) return createDeskQueryRouter()
  let router = queryRouters.get(controller)
  if (!router) {
    router = createDeskQueryRouter({ controller })
    queryRouters.set(controller, router)
  }
  return router
}

/**
 * Dispatch a single MCP call. Pulled out from startServer so tests can
 * exercise the dispatch table directly (no stdio transport needed).
 */
export async function callTool({ deskRoot, name, input, person = null, statusContext = {}, signal }) {
  if (!TOOL_NAMES.includes(name)) {
    return {
      content: [{ type: "text", text: `unknown tool: ${name}` }],
      isError: true,
    }
  }
  const impl = TOOL_IMPLS[name]
  if (!impl) {
    // All 16 tools wired; this branch only fires if a name exists in
    // TOOL_NAMES but is missing from TOOL_IMPLS — i.e. a wiring bug.
    // Return a structured payload that points at the cause.
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "not_implemented",
            tool: name,
            note: `tool registered in TOOL_NAMES but missing from TOOL_IMPLS (wiring bug). desk root = ${deskRoot}`,
          }),
        },
      ],
    }
  }
  try {
    const readiness = statusContext.admission ? statusContext.admission.controller ?? null : undefined
    const result = await impl({
      deskRoot, input: input ?? {}, person, statusContext, readiness,
      queryRouter: routerFor(readiness), signal,
    })
    return {
      content: [{ type: "text", text: JSON.stringify(result) }],
    }
  } catch (err) {
    if (err instanceof CanonicalWriteRecordingError) {
      return {
        content: [{ type: "text", text: JSON.stringify({ ...err.toJSON(), tool: name }) }],
        isError: true,
      }
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            status: "error",
            tool: name,
            message: err?.message ?? String(err),
          }),
        },
      ],
      isError: true,
    }
  }
}

export function createMcpServer() {
  return new Server(
    {
      name: "desk-mcp",
      version: packageMetadata.version,
    },
    {
      capabilities: { tools: {} },
    },
  )
}

export function createMcpTransport() {
  return new StdioServerTransport()
}

export async function startServer({
  deskRoot,
  person = null,
  statusContext = {},
  server,
  transport,
  createServer = createMcpServer,
  createTransport = createMcpTransport,
}) {
  const activeServer = server ?? createServer()
  const activeTransport = transport ?? createTransport()
  activeServer.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_NAMES.map((name) => ({
      name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: { type: "object", properties: {}, additionalProperties: true },
    })),
  }))

  activeServer.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params?.name
    const input = request.params?.arguments ?? {}
    return callTool({ deskRoot, name, input, person, statusContext, signal: extra?.signal })
  })

  await activeServer.connect(activeTransport)
}
