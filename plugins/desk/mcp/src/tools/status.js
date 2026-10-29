import * as path from "node:path"
import { personPrefix } from "../util/paths.js"
import { memberMessage } from "../desk/crew-member.js"
import { deskVersion } from "../package-metadata.js"
import { activeTasks } from "../desk/active-tasks.js"
import { factoryStatusAsync } from "./factory-context.js"
import { pullStillFailing } from "../runtime/health.js"
import { aheadBehindCountsAsync, hasRemoteConfiguredAsync, readFetchOkAt, readSyncStatus, waitForStatusGitReads, warmStatusGitReads } from "../runtime/sync-worker.js"
import { createStatusInspection, waitForStatusInspection as waitForInspectionChild } from "../runtime/status-inspection.js"


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
async function syncStatus({ deskRoot, env, signal }) {
  if (!await hasRemoteConfiguredAsync(deskRoot, { signal })) return "no remote configured"
  const recorded = readSyncStatus({ root: deskRoot, env })
  // How the last pull ended, when it failed: ahead/behind alone read "in sync" after an unreachable remote.
  const lastPull = pullStillFailing({ lastPull: recorded?.last_pull, lastPushAt: recorded?.last_push_at ?? null, fetchedAt: readFetchOkAt({ root: deskRoot, env }) })
    ? { last_pull: recorded.last_pull }
    : {}
  if (recorded?.blocked) {
    return { blocked: true, reason: recorded.reason ?? null, paths: recorded.paths ?? [], unpushed: recorded.unpushed ?? null, ...lastPull }
  }
  const counts = await aheadBehindCountsAsync({ root: deskRoot, signal })
  return {
    blocked: false,
    ahead: counts?.ahead ?? 0,
    behind: counts?.behind ?? 0,
    last_push_at: recorded?.last_push_at ?? null,
    ...lastPull,
  }
}

// The desk_status calls still running, by the signal that owns them: their card reads hold files in the desk folder open.
const statusCalls = new WeakMap()

// How long a session waits for an aborted desk_status call to settle. Once aborted, the call's own waits end at once
// (its scan, its Git reads, the controller check); what remains is at most one batch of card reads and the
// active-task listing, which takes no signal. A read that never returns must not hold every later status run and
// the session's close forever, so the wait ends in an error instead and the run stays retained. It is shorter than
// the server's 3 s shutdown limit (`SHUTDOWN_TIMEOUT_MS` in index.js), so a close reports this error, not a timeout.
const STATUS_CALL_SETTLE_MS = 1500

function callsSettled(calls, ms) {
  if (calls === undefined || calls.size === 0) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(
      new Error(`desk_status call did not settle within ${ms} ms of its status run ending`),
      { code: "status_call_not_settled" },
    )), ms)
    Promise.allSettled(calls).then(() => {
      clearTimeout(timer)
      resolve()
    })
  })
}

/**
 * Resolves when the status run that owns `signal` has nothing left: neither its inspection child, nor a Git read, nor the
 * call itself with its file reads. A session aborts the run and awaits this before it reports itself closed, so nothing
 * of the run still holds the desk folder. Rejects as the inspection child's wait does, and with `status_call_not_settled`
 * when the call has not settled within `callSettleMs`; a later wait for the same signal tries again.
 */
export async function waitForStatusInspection(signal, { callSettleMs = STATUS_CALL_SETTLE_MS } = {}) {
  await Promise.all([waitForInspectionChild(signal), waitForStatusGitReads(signal), callsSettled(statusCalls.get(signal), callSettleMs)])
}

export function desk_status(request) {
  const call = statusCall(request)
  const { signal } = request
  if (signal !== undefined) {
    const calls = statusCalls.get(signal) ?? new Set()
    statusCalls.set(signal, calls)
    calls.add(call)
    call.then(() => calls.delete(call), () => calls.delete(call))
  }
  return call
}

async function statusCall({ deskRoot, person, statusContext = {}, signal, env = process.env }) {
  const writeScope = writeScopeOf(deskRoot, person, statusContext.member ?? null)
  const reader = createStatusInspection(deskRoot, { signal })
  try {
    const root = await reader.inspect("root", statusContext.root)
    // The sync section comes last; its worker thread starts while the inspections run.
    if (root.valid) warmStatusGitReads()
    const runtime = runtimeStatus(statusContext.runtime ?? {}, env)
    const activation = activationStatus(statusContext.activation)
    const search = await searchStatus(statusContext.search)

    return {
      status: root.valid ? "ok" : "error",
      root,
      activation,
      runtime,
      search,
      write_scope: writeScope,
      // The redacted active-task listing session start and status render (./desk/active-tasks.js).
      active_tasks: root.valid ? await activeTasks(root.path) : null,
      factory: await factoryStatusAsync({ env, deskRoot: root.valid ? root.path : null, signal }),
      sync: root.valid ? await syncStatus({ deskRoot: root.path, env, signal }) : null,
      summary: summaryFor({ root, activation, search }),
    }
  } finally {
    await reader.close()
  }
}

// Where this session writes, and who it writes as: `source` says where the person came from (crew-member.js), so a check
// of "am I set up?" reads the same person and source the boot line printed. A Crew workspace with no person is read-only.
function writeScopeOf(deskRoot, person, member) {
  const effectiveRoot = personPrefix(deskRoot, person)
  if (effectiveRoot === deskRoot) {
    if (member?.crew === true && member.person === null) {
      return { mode: "read_only", person: null, relative_path: null, source: null, problem: memberMessage(member) }
    }
    return { mode: "workspace", person: null, relative_path: "." }
  }
  const alias = path.basename(effectiveRoot)
  const scope = { mode: "person", person: alias, relative_path: path.posix.join("desks", alias) }
  return member?.person === alias ? { ...scope, source: member.source, identity: member.identity } : scope
}

const SEARCH_STARTING = Object.freeze({ state: "starting", message: "Desk search is starting." })

// Search in plain words, from the session's search engine (src/search/engine.js) once admission has started it.
function searchStatus(engine) {
  return typeof engine?.searchStatus === "function" ? engine.searchStatus() : SEARCH_STARTING
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



function summaryFor({ root, activation, search }) {
  return [
    `Desk root ${root.path} resolved from ${root.source}.`,
    activation.selected_id ? `Active activation: ${activation.selected_id}.` : null,
    root.valid ? null : `Root diagnostic: ${root.diagnostic}.`,
    search.message,
    search.old_index_removed ?? null,
  ].filter(Boolean).join(" ")
}
