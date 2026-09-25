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
import { fileURLToPath } from "node:url"
import * as path from "node:path"
import { normalizeReadinessPolicy } from "./src/activation/readiness-policy.js"
import {
  importRuntimeServer,
  inspectRuntimeDependencyPack,
} from "./src/runtime/bootstrap.js"
import { startDiagnosticServer } from "./src/runtime/diagnostic-server.js"
import { createDeskSession } from "./src/runtime/desk-session.js"
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
import {
  claudeBindingPath,
  expandHome,
  loadActivationConfig,
  resolveActivationConfigPath,
  resolveDeskRootWithSource,
} from "./src/util/paths.js"

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
    }
  }
  return args
}

export function resolveStartupDeskRoot({ args, env = process.env, homeDir } = {}) {
  return resolveDeskRootWithSource({
    activationConfigPath: resolveStartupActivationConfigPath({ args, env }),
    env,
    explicitRoot: args?.root,
    homeDir,
    hostProjectRoot: env.CLAUDE_PROJECT_DIR,
    hostSessionRoot: args?.hostSessionRoot,
  })
}

export function resolveStartupActivationConfigPath({ args, env = process.env } = {}) {
  return resolveActivationConfigPath({ explicit: args?.activationConfig, env })
}

export function resolveStartupRuntimeCacheDir({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return null
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  if (!hasText(loadedActivationConfig.runtimeCacheDir)) {
    return null
  }
  const expanded = expandHome(loadedActivationConfig.runtimeCacheDir, homeDir)
  return path.resolve(path.isAbsolute(expanded) ? expanded : path.join(cwd, expanded))
}

export function resolveStartupActivationContext({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return null
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  if (loadedActivationConfig?.activation === null || typeof loadedActivationConfig?.activation !== "object") {
    return null
  }
  return {
    ...loadedActivationConfig.activation,
    source: "activation-config",
  }
}

export function resolveStartupSourceIdentity(activationStatus) {
  for (const value of [
    activationStatus?.source_identity,
    activationStatus?.resolved_commit,
    activationStatus?.commit,
    activationStatus?.source?.commit,
  ]) {
    if (hasText(value)) {
      return value
    }
  }
  return null
}

export function resolveStartupReadinessPolicy({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) {
    return normalizeReadinessPolicy()
  }
  const loadedActivationConfig = loadActivationConfig({
    configPath: activationConfig,
    cwd,
    homeDir,
  })
  return normalizeReadinessPolicy(
    loadedActivationConfig.desk_runtime
      ?? loadedActivationConfig.desk?.runtime
      ?? {},
  )
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

// The state branch a host asks Desk to hold the desk checkout on: `--state-branch <name>`, else `desk.state_branch` in the activation config, else none.
export function resolveStartupStateBranch({
  args,
  cwd = process.cwd(),
  env = process.env,
  homeDir,
} = {}) {
  if (hasText(args?.stateBranch)) return args.stateBranch
  const activationConfig = resolveStartupActivationConfigPath({ args, env })
  if (!hasText(activationConfig)) return null
  const stateBranch = loadActivationConfig({ configPath: activationConfig, cwd, homeDir }).desk.state_branch
  return hasText(stateBranch) ? stateBranch : null
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
  if (hasText(args.onboarding) && !hasText(args.root) && !hasText(args.hostSessionRoot)) {
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

  const resolveActivation = () => {
    const activationStatus = resolveStartupActivationContext({ args, cwd, env, homeDir })
    return {
      activationStatus,
      sourceIdentity: resolveStartupSourceIdentity(activationStatus),
      runtimeCacheDir: resolveStartupRuntimeCacheDir({ args, cwd, env, homeDir }),
      readinessPolicy: normalizeReadinessPolicy(
        injectedReadinessPolicy ?? resolveStartupReadinessPolicy({ args, cwd, env, homeDir }),
      ),
      stateBranch: resolveStartupStateBranch({ args, cwd, env, homeDir }),
    }
  }
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
    resolveRoot: () => resolveStartupDeskRoot({ args, env, homeDir }),
    setupDiagnostic: (error) => createSetupDiagnostic({ pathsTried: error.tried, bindingPath: claudeBindingPath(env) }),
    resolveActivation,
    loadRuntime: (activation) => loadRuntime({
      activation,
      env,
      mcpRoot,
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
  // A client that never sends notifications/initialized or tools/list still gets admission.
  const kickoff = setTimeout(kick, admissionKickoffMs)
  kickoff.unref?.()
  const closed = frontDoor.closed.then(() => {
    clearTimeout(kickoff)
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
async function loadRuntime({ activation, env, mcpRoot, preflight, runtimeImporter, runtimeInspector }) {
  const { runtimeCacheDir, sourceIdentity } = activation
  let inspection = null
  if (runtimeInspector !== null) {
    try {
      inspection = runtimeInspector === inspectRuntimeDependencyPack || preflight === null
        ? runtimeInspector({ mcpRoot })
        : preflight
    } catch {
      return runtimeOutcome(runtimeDiagnostic({
        inspection: startupFailureInspection({ mcpRoot, reason: "runtime_inspection_failed" }),
        runtimeCacheDir,
        env,
      }))
    }
    if (!inspection.ok) {
      return runtimeOutcome(runtimeDiagnostic({ inspection, runtimeCacheDir, env }))
    }
  }
  let runtimeServer
  try {
    runtimeServer = await runtimeImporter({ env, mcpRoot, runtimeCacheDir, sourceIdentity })
  } catch (error) {
    return runtimeOutcome(runtimeDiagnostic({
      inspection: inspection ?? startupFailureInspection({ mcpRoot, reason: "runtime_restore_failed" }),
      reason: "runtime_restore_failed",
      runtimeCacheDir,
      env,
    }), error)
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

function runtimeOutcome(diagnostic, error) {
  return {
    outcome: {
      state: "degraded",
      code: diagnostic.code,
      summary: diagnostic.summary,
      fix: diagnostic.fix,
      diagnostic: error === undefined ? diagnostic : { ...diagnostic, restore_error: error instanceof Error ? error.message : String(error) },
    },
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
    return Promise.resolve(launch({ onClosed: () => exit(0) })).catch(handleStartupException)
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
