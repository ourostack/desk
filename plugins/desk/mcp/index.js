#!/usr/bin/env node
// desk MCP server entry point.
//
// Spawned by consumers as a stdio MCP server. Hosts may pass `--root <path>`
// directly, or pass/auto-discover an activation config that carries the root,
// runtime cache, and active worker/overlay identity. Consumers wire this up via
// the sibling `.mcp.json` declaration.
//
//   node ./mcp/index.js --root ~/AgentBundles/slugger.ouro/desk
//
// The same binary serves every consumer (Codex, Claude Code worker, Copilot
// CLI, ouroboros daemon per agent). Each consumer supplies or discovers its
// own root/activation context without needing a bespoke Desk CLI.

// Every module imported below must stay loadable on Node releases older than the engines floor (the Node 16 matrix test in __tests__/runtime/never_exit_before_handshake.test.js proves it), because ES module imports load before any code here runs. The version check itself is the first thing main() does.
import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as path from "node:path"
import {
  resolveStartupActivationConfigPath,
  resolveStartupActivationContext,
  resolveStartupDeskRoot,
  resolveStartupReadinessPolicy,
  resolveStartupRuntimeCacheDir,
  resolveStartupSourceIdentity,
  resolveStartupStateBranch,
} from "./src/runtime/startup-resolve.js"
import {
  importRuntimeServer,
  inspectRuntimeDependencyPack,
} from "./src/runtime/bootstrap.js"
import { startDiagnosticServer } from "./src/runtime/diagnostic-server.js"
import { runInWorker } from "./src/runtime/admission-worker.js"
import { createDeskSession, LAUNCHER_READ_ONLY_CODES } from "./src/runtime/desk-session.js"
import { startFrontDoor } from "./src/runtime/front-door.js"
import { resolveDeskStateDir, resolveReadinessStateHome } from "./src/runtime/last-start.js"
import {
  createRuntimeDiagnostic,
  createSetupDiagnostic,
  createStartupExceptionDiagnostic,
} from "./src/runtime/diagnostics.js"
import {
  discoverNodeCandidates,
  REEXEC_ATTEMPT_ENV,
  reexecuteWithCompatibleNode,
  selectCompatibleNode,
} from "./src/runtime/node-selection.js"
import { claudeBindingPath } from "./src/util/paths.js"

export {
  resolveStartupActivationConfigPath,
  resolveStartupActivationContext,
  resolveStartupDeskRoot,
  resolveStartupReadinessPolicy,
  resolveStartupRuntimeCacheDir,
  resolveStartupSourceIdentity,
  resolveStartupStateBranch,
}

const MCP_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.-]*)?(?:\+[0-9A-Za-z][0-9A-Za-z.-]*)?$/u
// Used only when package.json's engines.node cannot be read as a plain ">=" floor.
const DEFAULT_NODE_FLOOR = [20, 0, 0]

// The lowest Node that Desk supports, from engines.node in package.json (">=X[.Y[.Z]]").
export function resolveNodeFloor({ mcpRoot, readFile = readFileSync } = {}) {
  try {
    const range = JSON.parse(readFile(path.join(mcpRoot, "package.json"), "utf8")).engines.node
    const match = /^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/u.exec(range.trim())
    if (match !== null) {
      return [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)]
    }
  } catch {
    // Fall through to the default floor.
  }
  return DEFAULT_NODE_FLOOR
}

// Compare a Node version ("16.20.2") with a floor using only syntax and APIs every Node release has, because this check runs before Desk trusts the Node it was started on.
export function nodeMeetsFloor(version, floor) {
  const parts = String(version).split(".")
  for (let index = 0; index < 3; index += 1) {
    const part = parseInt(parts[index], 10)
    if (isNaN(part)) return false
    if (part !== floor[index]) return part > floor[index]
  }
  return true
}

export function parseArgs(argv) {
  const args = { root: null, person: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root" && argv[i + 1]) {
      args.root = argv[++i]
    } else if (argv[i] === "--host-session-root" && argv[i + 1]) {
      args.hostSessionRoot = argv[++i]
    } else if (argv[i] === "--onboarding" && argv[i + 1]) {
      args.onboarding = argv[++i]
    } else if (argv[i] === "--onboarding-reason" && argv[i + 1]) {
      args.onboardingReason = argv[++i]
    } else if (argv[i] === "--person" && argv[i + 1]) {
      args.person = argv[++i]
    } else if (argv[i] === "--activation-config" && argv[i + 1]) {
      args.activationConfig = argv[++i]
    } else if (argv[i] === "--state-branch" && argv[i + 1]) {
      args.stateBranch = argv[++i]
    } else if (argv[i] === "--degraded" && argv[i + 1]) {
      args.degraded = argv[++i]
    } else if (argv[i] === "--degraded-reason" && argv[i + 1]) {
      args.degradedReason = argv[++i]
    }
  }
  return args
}

export function resolveRuntimeInspector({ runtimeImporter, runtimeInspector }) {
  if (runtimeInspector !== undefined) {
    return runtimeInspector
  }
  return runtimeImporter === importRuntimeServer
    ? inspectRuntimeDependencyPack
    : null
}

export function resolveMcpServerVersion({
  mcpRoot,
  readFile = readFileSync,
} = {}) {
  try {
    const version = JSON.parse(
      readFile(path.join(mcpRoot, "package.json"), "utf8"),
    ).version
    return hasText(version) && MCP_VERSION_PATTERN.test(version)
      ? version
      : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

// Desk answers the MCP handshake before it does anything that can fail or take time.
//
// main always receives options (the entrypoint passes onClosed), so there is no default for a missing argument, which would bind to the real stdio and home.
//
// Before the handshake, main does only what must happen in this process before stdio is answered: check the Node version, and move to a compatible Node (re-exec) when no shipped runtime pack fits this one. Everything else (root resolution, activation, the runtime-pack restore, authority, the state branch and the readiness controller) runs after the handshake as background admission (src/runtime/desk-session.js), which degrades instead of failing and upgrades itself to ready in the same session.
export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  cwd = process.cwd(),
  homeDir,
  mcpRoot = path.dirname(fileURLToPath(import.meta.url)),
  runtimeImporter = importRuntimeServer,
  runtimeInspector,
  diagnosticServerStarter = startDiagnosticServer,
  nodeCandidateDiscoverer = discoverNodeCandidates,
  nodeSelector = selectCompatibleNode,
  nodeReexecutor = reexecuteWithCompatibleNode,
  readinessPolicy: injectedReadinessPolicy,
  authorityProviders = {},
  nodeVersion = process.versions.node,
  input = process.stdin,
  output = process.stdout,
  stderr = process.stderr,
  stateHome,
  admissionKickoffMs = 1000,
  git,
  watch,
  timers,
  offload = runInWorker,
  crashHandlers = false,
  hung,
  onClosed = () => {},
}) {
  runtimeInspector = resolveRuntimeInspector({ runtimeImporter, runtimeInspector })
  const serverVersion = resolveMcpServerVersion({ mcpRoot })
  const startRuntimeDiagnostic = (options) => diagnosticServerStarter({
    ...options,
    serverVersion,
  })
  // The Node check comes first, before any root, activation or runtime work: on a Node older than the engines floor, Desk goes straight to finding a compatible Node (or to diagnostic mode) and never runs code that may need newer APIs.
  if (!nodeMeetsFloor(nodeVersion, resolveNodeFloor({ mcpRoot }))) {
    return handleUnavailableRuntime({
      argv,
      diagnosticServerStarter: startRuntimeDiagnostic,
      env,
      homeDir,
      inspection: outdatedNodeInspection({ mcpRoot, runtimeInspector }),
      mcpRoot,
      nodeCandidateDiscoverer,
      nodeReexecutor,
      nodeSelector,
      runtimeCacheDir: null,
    })
  }
  const args = parseArgs(argv)
  // An overlay that owns root resolution (for example a crew launcher that
  // maps identity to a shared workspace) passes --onboarding when it could not
  // resolve a root. Desk then goes straight to setup mode on that path rather
  // than guessing a home fallback that belongs to a different desk.
  if (hasText(args.onboarding) && !hasText(args.degraded) && !hasText(args.root) && !hasText(args.hostSessionRoot)) {
    return startRuntimeDiagnostic({
      diagnostic: createSetupDiagnostic({
        onboardingSkill: args.onboarding,
        reasonDetail: args.onboardingReason,
        bindingPath: claudeBindingPath(env),
      }),
    })
  }
  // Only a Node that no shipped runtime pack supports is handled before the handshake: the fix (running under a compatible Node) needs stdio this process has not answered yet. The pack's checksum and archive are verified later, during admission.
  const preflight = preflightInspection({ mcpRoot, runtimeInspector })
  if (preflight !== null && !preflight.ok && (preflight.reason === "unsupported_target" || hasText(env[REEXEC_ATTEMPT_ENV]))) {
    return handleUnavailableRuntime({
      argv,
      diagnosticServerStarter: startRuntimeDiagnostic,
      env,
      homeDir,
      inspection: preflight,
      mcpRoot,
      nodeCandidateDiscoverer,
      nodeReexecutor,
      nodeSelector,
      runtimeCacheDir: optional(() => resolveStartupRuntimeCacheDir({ args, cwd, env, homeDir })),
    })
  }

  const launcher = launcherMode(args)
  const plainEnv = { ...env }
  let frontDoor = null
  const session = createDeskSession({
    args,
    authorityProviders,
    deskStateDir: stateHome ?? resolveDeskStateDir({ env, homeDir }),
    readinessStateHome: stateHome === undefined ? resolveReadinessStateHome({ env, homeDir }) : path.join(stateHome, "readiness"),
    git,
    watch,
    timers,
    stderr,
    notifyToolsChanged: () => frontDoor?.notifyToolsChanged(),
    launcher,
    hung: hung ?? hungTuning(env),
    // Root and activation resolution read files: they run on the admission worker, never on the thread that answers the host.
    resolveInputs: () => offload({
      kind: "resolve",
      input: { args, env: plainEnv, cwd, homeDir, injectedReadinessPolicy },
    }),
    setupDiagnostic: (error) => createSetupDiagnostic({ pathsTried: error.tried, bindingPath: claudeBindingPath(env) }),
    loadRuntime: (activation) => loadRuntime({
      activation,
      env: plainEnv,
      mcpRoot,
      offload,
      preflight,
      runtimeImporter,
      runtimeInspector,
    }),
  })
  let kicked = false
  const kick = () => {
    if (kicked) return
    kicked = true
    session.start()
  }
  frontDoor = startFrontDoor({
    input,
    output,
    serverVersion,
    callTool: (call) => session.callTool(call),
    onHandshake: kick,
  })
  // A client that never sends tools/list still gets admission.
  const kickoff = setTimeout(kick, admissionKickoffMs)
  kickoff.unref?.()
  // Once the server is up, nothing that throws later may end the process: the session records it, degrades and keeps serving.
  const removeCrashHandlers = crashHandlers ? installCrashHandlers({ session, stderr }) : () => {}
  const closed = frontDoor.closed.then(() => {
    clearTimeout(kickoff)
    removeCrashHandlers()
    session.dispose()
    onClosed()
  })
  return { frontDoor, session, admission: session.admission, closed }
}

// A cheap look at the runtime target before the handshake: the support matrix and the pack files, without hashing or unpacking the archive. Null when inspection itself fails (admission reports that later).
function preflightInspection({ mcpRoot, runtimeInspector }) {
  if (runtimeInspector === null) return null
  try {
    return runtimeInspector === inspectRuntimeDependencyPack
      ? inspectRuntimeDependencyPack({ mcpRoot, verifyPack: deferPackVerification })
      : runtimeInspector({ mcpRoot })
  } catch {
    return null
  }
}

function deferPackVerification() {
  return { ok: true, deferred: true, manifest: null, archiveEntries: [] }
}

// Inspect, restore and import the runtime from the offline pack. Returns { runtimeServer, runtimeStatus }, or { outcome } naming the degraded state.
// With the shipped importer, the inspection (which hashes and unpacks the archive) and the restore (which can wait on another process's publication lock) run on the admission worker; only the final import runs here.
async function loadRuntime({ activation, env, mcpRoot, offload, preflight, runtimeImporter, runtimeInspector }) {
  const { runtimeCacheDir, sourceIdentity } = activation
  let inspection = null
  let prepared = null
  if (runtimeImporter === importRuntimeServer) {
    const job = await offload({
      kind: "runtime",
      input: { mcpRoot, env, runtimeCacheDir, sourceIdentity, inspect: runtimeInspector === inspectRuntimeDependencyPack },
    })
    if (job.inspectionError) return inspectionFailedOutcome({ mcpRoot, runtimeCacheDir, env })
    inspection = job.inspection ?? null
    if (inspection !== null && !inspection.ok) return runtimeOutcome(runtimeDiagnostic({ inspection, runtimeCacheDir, env }))
    if (job.restoreError) return restoreFailedOutcome({ inspection, job, mcpRoot, runtimeCacheDir, env })
    prepared = job.prepared
  } else if (runtimeInspector !== null) {
    try {
      inspection = preflight === null ? runtimeInspector({ mcpRoot }) : preflight
    } catch {
      return inspectionFailedOutcome({ mcpRoot, runtimeCacheDir, env })
    }
    if (!inspection.ok) {
      return runtimeOutcome(runtimeDiagnostic({ inspection, runtimeCacheDir, env }))
    }
  }
  let runtimeServer
  try {
    runtimeServer = prepared === null
      ? await runtimeImporter({ env, mcpRoot, runtimeCacheDir, sourceIdentity })
      : await importPreparedRuntime({ mcpRoot, prepared })
  } catch (error) {
    return restoreFailedOutcome({ inspection, job: { restoreError: error }, mcpRoot, runtimeCacheDir, env })
  }
  const importedRuntime = runtimeServer._deskRuntime ?? {
    runtime_cache_dir: runtimeCacheDir,
    source_mirror_path: null,
    target: null,
    loaded_from_source_mirror: false,
  }
  const runtimeStatus = inspection === null
    ? importedRuntime
    : {
        ...inspection.runtime,
        ...importedRuntime,
        state: "ready",
        current_target: inspection.runtime?.current_target ?? inspection.current_target,
        shipped_targets: inspection.runtime?.shipped_targets ?? inspection.shipped_targets ?? [],
        paths_checked: inspection.runtime?.paths_checked ?? inspection.paths_checked ?? [],
        runtime_cache_path: importedRuntime.runtime_cache_dir ?? runtimeCacheDir,
        support_matrix_path: inspection.runtime?.support_matrix_path ?? inspection.support_matrix_path,
      }
  return { runtimeServer, runtimeStatus }
}

// The last step of the shipped importer, after the worker restored the runtime: load the server from the source mirror, next to its native dependencies.
export async function importPreparedRuntime({ mcpRoot, prepared, load = (url) => import(url) }) {
  const pluginRoot = path.resolve(mcpRoot, "..")
  const runtimeServer = await load(pathToFileURL(path.join(prepared.sourceMirrorPath, "src", "server.js")).href)
  runtimeServer.configureRuntimeArtifacts?.({ pluginRoot })
  return {
    ...runtimeServer,
    _deskRuntime: {
      plugin_root: pluginRoot,
      runtime_cache_dir: prepared.runtimeCacheDir,
      source_mirror_path: prepared.sourceMirrorPath,
      target: prepared.target,
      pack_dir: prepared.packDir,
      loaded_from_source_mirror: true,
    },
  }
}

function inspectionFailedOutcome({ mcpRoot, runtimeCacheDir, env }) {
  return runtimeOutcome(runtimeDiagnostic({
    inspection: startupFailureInspection({ mcpRoot, reason: "runtime_inspection_failed" }),
    runtimeCacheDir,
    env,
  }))
}

function restoreFailedOutcome({ inspection, job, mcpRoot, runtimeCacheDir, env }) {
  const error = job.restoreError
  if (error?.lock) return lockedOutcome(error.lock)
  return runtimeOutcome(runtimeDiagnostic({
    inspection: inspection ?? startupFailureInspection({ mcpRoot, reason: "runtime_restore_failed" }),
    reason: "runtime_restore_failed",
    runtimeCacheDir,
    env,
  }), error)
}

// Another process held the runtime publication lock for the whole wait: not an integrity problem, and it usually clears on its own.
function lockedOutcome(lock) {
  const holder = lock.pid === null ? "a process whose owner record is unreadable" : `pid ${lock.pid}`
  return {
    outcome: {
      state: "degraded",
      code: "runtime_restore_locked",
      summary: `Another process (${holder}) held Desk's runtime publication lock ${lock.dir} for the whole 30 s wait while restoring the same runtime. Desk retries in the background.`,
      fix: `Wait for ${holder} to finish restoring (usually seconds), then call desk_status. If that process is not a Desk process or is stuck, stop it; once it no longer exists, Desk removes the lock itself on its next retry.`,
      diagnostic: { mode: "degraded", lock },
    },
  }
}

function runtimeOutcome(diagnostic, error) {
  return {
    outcome: {
      state: "degraded",
      code: diagnostic.code,
      summary: diagnostic.summary,
      fix: diagnostic.fix,
      // Errors from the admission worker are plain objects: read their message either way.
      diagnostic: error === undefined ? diagnostic : { ...diagnostic, restore_error: typeof error?.message === "string" ? error.message : String(error) },
    },
  }
}

const LAUNCHER_CODE = /^[a-z][a-z0-9_]{0,63}$/u

// --degraded <code> [--degraded-reason <text>]: a launcher that found a problem it cannot fix still starts Desk connected (refuse-but-connect, ruling 3 of 2026-09-25). Crew-state, repository and identity codes keep reads; every other code, including an unknown one, refuses every data tool. A crew-state code with --state-branch hands the checkout to Desk's own state-branch check, which can recover in the session.
export function launcherMode(args) {
  if (!hasText(args.degraded)) return null
  const code = LAUNCHER_CODE.test(args.degraded) ? args.degraded : "launcher_refused"
  const reason = hasText(args.degradedReason) ? args.degradedReason : `the launcher reported ${code}`
  if (!LAUNCHER_READ_ONLY_CODES.includes(code)) return { code, reason, mode: "refuse", blocksWrites: true }
  const branchChecked = code.startsWith("crew_state_") && hasText(args.stateBranch)
  return { code, reason, mode: "read_only", blocksWrites: !branchChecked }
}

// How long one probe of an unresponsive readiness controller waits (DESK_READINESS_PROBE_MS, default 5 s). Tests shorten it; three missed probes in a row mark the controller hung.
export function hungTuning(env) {
  const probeMs = Number.parseInt(env.DESK_READINESS_PROBE_MS ?? "", 10)
  return Number.isSafeInteger(probeMs) && probeMs > 0 ? { probeMs } : {}
}

// Last-resort handlers for the process: an exception or rejection nothing caught is recorded by the session (degraded:runtime_exception, then re-admission) instead of ending the process and the host's connection with it. Returns a function that removes them.
export function installCrashHandlers({ session, stderr, target = process }) {
  const onException = (error) => session.recordException("uncaught_exception", error)
  const onRejection = (reason) => session.recordException("unhandled_rejection", reason)
  target.on("uncaughtException", onException)
  target.on("unhandledRejection", onRejection)
  stderr.write("[desk-mcp] crash handlers installed: an error after the handshake degrades Desk instead of ending it\n")
  return () => {
    target.off("uncaughtException", onException)
    target.off("unhandledRejection", onRejection)
  }
}

function optional(read) {
  try {
    return read()
  } catch {
    return null
  }
}

// On a Node below the engines floor, inspect the shipped runtime packs so node selection can find a Node that matches one; if inspection is unavailable, selection still runs and falls back to diagnostic mode.
function outdatedNodeInspection({ mcpRoot, runtimeInspector }) {
  let inspection = null
  if (runtimeInspector !== null) {
    try {
      inspection = runtimeInspector({ mcpRoot })
    } catch {
      inspection = null
    }
  }
  return {
    ...(inspection ?? startupFailureInspection({ mcpRoot, reason: "node_below_engines_floor" })),
    ok: false,
    reason: "node_below_engines_floor",
  }
}

async function handleUnavailableRuntime({
  argv,
  diagnosticServerStarter,
  env,
  homeDir,
  inspection,
  mcpRoot,
  nodeCandidateDiscoverer,
  nodeReexecutor,
  nodeSelector,
  runtimeCacheDir,
}) {
  // Only a Node below the engines floor, a target no pack supports, or a re-exec that came back still unsupported reaches this point: each needs a different Node, found before the handshake.
  let selection
  try {
    selection = nodeSelector({
      candidates: nodeCandidateDiscoverer({ env, homeDir }),
      currentTarget: inspection.runtime?.current_target ?? inspection.current_target,
      env,
      shippedTargets: inspection.runtime?.shipped_targets ?? inspection.shipped_targets ?? [],
    })
  } catch {
    return diagnosticServerStarter({
      diagnostic: runtimeDiagnostic({
        inspection,
        reason: "node_selection_failed",
        runtimeCacheDir,
        env,
      }),
    })
  }
  if (selection.mode === "reexec") {
    try {
      const result = await nodeReexecutor({
        argv,
        entrypointPath: path.join(mcpRoot, "index.js"),
        env,
        executable: selection.executable,
      })
      if (result.forwardedSignal !== null && result.forwardedSignal !== undefined) {
        return result
      }
      if (result.code !== 0 || result.signal !== null) {
        throw new Error(`compatible Node exited with ${result.signal ?? result.code}`)
      }
      return result
    } catch {
      return diagnosticServerStarter({
        diagnostic: runtimeDiagnostic({
          inspection,
          reason: "guarded_reexec_failure",
          pathsChecked: selection.paths_checked,
          runtimeCacheDir,
          env,
        }),
      })
    }
  }
  return diagnosticServerStarter({
    diagnostic: runtimeDiagnostic({
      inspection,
      reason: selection.reason,
      pathsChecked: selection.paths_checked,
      runtimeCacheDir,
      env,
    }),
  })
}

function startupFailureInspection({ mcpRoot, reason }) {
  const currentTarget = {
    id: `${process.platform}-${process.arch}-node-${process.versions.modules}`,
    platform: process.platform,
    arch: process.arch,
    node_abi: process.versions.modules,
  }
  const runtime = {
    current_target: currentTarget,
    shipped_targets: [],
    paths_checked: [mcpRoot],
    support_matrix_path: null,
  }
  return {
    ok: false,
    mode: "diagnostic",
    reason,
    runtime,
  }
}

function runtimeDiagnostic({
  inspection,
  reason = inspection.reason,
  pathsChecked = [],
  runtimeCacheDir,
  env,
}) {
  const runtime = inspection.runtime ?? inspection
  return createRuntimeDiagnostic({
    reason,
    failureKind: reason === inspection.reason ? inspection.failure_kind : undefined,
    currentTarget: runtime.current_target,
    shippedTargets: runtime.shipped_targets ?? [],
    pathsChecked: [...(runtime.paths_checked ?? []), ...pathsChecked],
    runtimeCachePath: runtimeCacheDir ?? env.DESK_RUNTIME_CACHE_DIR ?? null,
    supportMatrixPath: runtime.support_matrix_path ?? null,
  })
}

function hasText(value) {
  return typeof value === "string" && value.trim().length > 0
}

export function isEntrypoint({
  argv = process.argv,
  moduleUrl = import.meta.url,
  realpath = realpathSync,
} = {}) {
  if (!argv[1]) {
    return false
  }
  const modulePath = fileURLToPath(moduleUrl)
  try {
    return realpath(modulePath) === realpath(argv[1])
  } catch {
    return path.resolve(modulePath) === path.resolve(argv[1])
  }
}

export function runIfEntrypoint({
  argv = process.argv,
  moduleUrl = import.meta.url,
  stderr = process.stderr,
  exit = process.exit,
  launch = main,
  startDiagnostic = startStartupExceptionDiagnostic,
} = {}) {
  if (!isEntrypoint({ argv, moduleUrl })) return null
  // Degrade, never die: anything that throws before the server starts is served as diagnostic mode, so the host's handshake still completes and desk_status names the cause. Only a diagnostic server that cannot run at all (stdio gone) exits.
  const handleStartupException = (err) => {
    stderr.write(`[desk-mcp] startup exception: ${describeError(err)}; serving diagnostic mode\n`)
    return Promise.resolve()
      .then(() => startDiagnostic({ error: err }))
      .catch((diagnosticError) => {
        stderr.write(`[desk-mcp] fatal: ${describeError(diagnosticError)}\n`)
        exit(1)
      })
  }
  try {
    // The host closing stdin ends the session: exit rather than linger on background admission, a controller socket or a watcher.
    return Promise.resolve(launch({ onClosed: () => exit(0), crashHandlers: true })).catch(handleStartupException)
  } catch (err) {
    return handleStartupException(err)
  }
}

// Serve the startup-exception diagnostic on stdio (tests pass their own streams).
export function startStartupExceptionDiagnostic({
  error,
  mcpRoot = path.dirname(fileURLToPath(import.meta.url)),
  input,
  output,
}) {
  return startDiagnosticServer({
    diagnostic: createStartupExceptionDiagnostic({ error }),
    serverVersion: resolveMcpServerVersion({ mcpRoot }),
    input,
    output,
  })
}

function describeError(error) {
  return error instanceof Error ? error.message : String(error)
}

// Only launch the server when run as the entry point, not when imported
// (tests import `parseArgs` without spawning a stdio server).
runIfEntrypoint()
