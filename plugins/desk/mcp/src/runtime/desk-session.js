// One Desk MCP session after the handshake: the admission pipeline, the tool gates, desk_status and desk_doctor.
//
// index.js answers the handshake through the front door first, then hands every tools/call here. Admission runs in the background (see admission.js) and fills a context as it goes: the desk root, activation, the runtime (restored from the offline pack), the state-branch check, admitted write authority and the readiness controller. Each tool needs part of that context:
// - desk_status and desk_doctor always answer, and each desk_status re-runs admission when Desk is not ready;
// - reads (search, recall, similar, timeline, thread) need the runtime and a root; without a readiness controller, lexical search and timeline read the files directly;
// - desk_reindex and desk_work_ledger also need admitted authority and a controller;
// - writes (task_*, track_*, friction_add, lesson_add) also need the checkout on its state branch, checked again right before each write.
// A tool whose needs are not met answers `{ status: "degraded", code, fix }` with a fix the agent can act on in this session.
//
// This module must not import anything from the runtime pack: it runs before the pack is restored.

import { watch as watchFileSystem } from "node:fs"
import * as path from "node:path"

import { admitControlPlane, validateAdmissionAuthority, verifyAdmissionAuthority } from "../activation/admit.js"
import { createAdmission, exceptionOutcome } from "./admission.js"
import { DOCTOR_REPAIRS } from "./front-door.js"
import { appendRepairLog, writeLastStart } from "./last-start.js"
import { diagnosticFormat, previewRuntimeSnapshot } from "./preview-snapshot.js"
import { inspectStateBranch, repairStateBranch, runGit, stateBranchProblem, STATE_BRANCH_REPAIR } from "./state-branch.js"
import { pruneReadinessLeftovers } from "../readiness/leftovers.js"
import { TOOL_NAMES } from "../tool-names.js"

const READ_TOOLS = new Set(["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread"])
const CONTROLLER_TOOLS = new Set(["desk_reindex", "desk_work_ledger"])
const STATUS_WAIT_MS = 3000
const GATE_WAIT_MS = 10000
const HEAD_DEBOUNCE_MS = 100
const CONTROLLER_FAILURE = /readiness controller|ECONNREFUSED|ECONNRESET|ENOENT|EPIPE|ETIMEDOUT|EADDRINUSE/u

/** What a tool needs from admission: "status", "doctor", "read", "controller" or "write". */
export function toolRequirement(name) {
  if (name === "desk_status" || name === "desk_doctor") return name.slice(5)
  if (READ_TOOLS.has(name)) return "read"
  if (CONTROLLER_TOOLS.has(name)) return "controller"
  return "write"
}

/** Whether the admitted context meets a requirement. */
export function requirementMet(requirement, context) {
  const readable = Boolean(context.runtimeServer && context.root)
  if (requirement === "read") return readable
  const admitted = readable && Boolean(context.admission)
  if (requirement === "controller") return admitted
  return admitted && context.stateBranch?.ok !== false
}

/**
 * Build a session. `deps` carries everything index.js resolved or was given:
 * resolveRoot(), resolveActivation() (returns { activationStatus, readinessPolicy, runtimeCacheDir, sourceIdentity, stateBranch }), loadRuntime(activation) (returns { runtimeServer, runtimeStatus } or { outcome }),
 * args, authorityProviders, readinessStateHome, deskStateDir, git, watch, timers, stderr, notifyToolsChanged.
 */
export function createDeskSession(deps) {
  const {
    args,
    authorityProviders = {},
    readinessStateHome,
    deskStateDir,
    git = runGit,
    watch = watchFileSystem,
    timers,
    stderr = process.stderr,
    notifyToolsChanged = () => {},
  } = deps
  const context = { pendingRepairs: [] }
  let headWatch = null
  let headTimer = null
  let disposed = false

  const log = (line) => stderr.write(`[desk-mcp] ${line}\n`)

  const admission = createAdmission({
    context,
    timers,
    attempt: admitOnce,
    check: checkController,
    onTransition(snapshot) {
      log(snapshot.state === "ready"
        ? `state: ready${snapshot.repair ? ` (${snapshot.repair})` : ""}`
        : `state: ${snapshot.state} — ${snapshot.fix}`)
      try {
        writeLastStart({ stateDir: deskStateDir, snapshot, root: context.root?.root ?? null })
      } catch (error) {
        log(`could not record last-start.json in ${deskStateDir}: ${error.message}`)
      }
      if (snapshot.state === "ready") notifyToolsChanged()
    },
  })

  function recordRepair(line) {
    log(line)
    try {
      // Repairs only happen once a root is resolved.
      appendRepairLog({ stateDir: deskStateDir, line, root: context.root.root })
    } catch (error) {
      log(`could not append to the repair log in ${deskStateDir}: ${error.message}`)
    }
    return line
  }

  function forgetController() {
    const controller = context.admission?.controller
    context.admission = null
    context.semanticCurrent = false
    Promise.resolve().then(() => controller?.close?.()).catch(() => {})
  }

  function forgetDesk() {
    forgetController()
    context.root = null
    context.person = null
    context.stateBranch = null
    context.policyKey = null
  }

  async function admitOnce() {
    const repairs = context.pendingRepairs.splice(0)
    let rootResolution
    try {
      rootResolution = deps.resolveRoot()
    } catch (error) {
      forgetDesk()
      return rootOutcome(error, deps)
    }
    if (context.root?.root !== rootResolution.root) forgetDesk()
    context.root = rootResolution
    const deskRoot = rootResolution.root

    let activation
    try {
      activation = deps.resolveActivation()
    } catch (error) {
      return activationOutcome(error)
    }
    const policyKey = JSON.stringify(activation.readinessPolicy)
    if (context.policyKey !== policyKey) forgetController()
    context.policyKey = policyKey
    context.activation = activation.activationStatus
    context.stateBranchName = activation.stateBranch

    if (!context.runtimeServer) {
      const loaded = await deps.loadRuntime(activation)
      if (loaded.outcome) return loaded.outcome
      context.runtimeServer = loaded.runtimeServer
      context.runtime = loaded.runtimeStatus
    }

    let branchProblem = null
    let inspection = inspectStateBranch({ root: deskRoot, branch: activation.stateBranch, git })
    if (!inspection.ok && inspection.automatic) {
      const repaired = repairStateBranch({ inspection, git })
      if (repaired.repaired) {
        repairs.push(recordRepair(repaired.line))
        inspection = inspectStateBranch({ root: deskRoot, branch: activation.stateBranch, git })
      } else {
        branchProblem = stateBranchProblem(inspection, { failedRepair: repaired })
      }
    }
    if (!inspection.ok && branchProblem === null) branchProblem = stateBranchProblem(inspection)
    context.stateBranch = inspection
    watchHead(inspection.gitDir)

    const policy = activation.readinessPolicy
    if (!context.admission) {
      let verified = null
      const authorityProvider = policy.authority_provider === null ? null : authorityProviders[policy.authority_provider]
      try {
        const admitted = await (context.runtimeServer.admitControlPlane ?? admitControlPlane)({
          deskRoot,
          person: args.person,
          policy,
          runtime: context.runtime,
          authorityProvider,
          controllerConnector: context.runtimeServer.connectOrStartController,
          stateHome: readinessStateHome,
          onRepair: (repair) => repairs.push(recordRepair(`repaired: readiness state directory mode ${repair.from} → 700 (${repair.path})`)),
          verifyAuthority: async (options) => {
            verified = await verifyAdmissionAuthority(options)
            return verified
          },
        })
        context.person = validateAdmissionAuthority({ authority: admitted?.authority, person: args.person, policy })
        context.admission = admitted
        if (policy.semantic !== "required") startBackgroundConvergence(admitted)
      } catch (error) {
        return { ...admissionOutcome(error, { verified }), repair: repairs.at(-1) }
      }
    }

    if (policy.semantic === "required" && !context.semanticCurrent) {
      let barrier = null
      let failure = null
      try {
        await context.admission.controller.beginConvergence()
        barrier = await context.admission.controller.barrier({ capability: "semantic", wait: true })
      } catch (error) {
        // Anything can be thrown, including null: keep what was thrown.
        failure = { error }
      }
      if (barrier?.capability !== "semantic" || barrier.current !== true) {
        return { ...semanticOutcome(failure, barrier), repair: repairs.at(-1) }
      }
      context.semanticCurrent = true
    }

    if (branchProblem !== null) return { state: "degraded", ...branchProblem, repair: repairs.at(-1) }
    return { state: "ready", repair: repairs.at(-1) }
  }

  function startBackgroundConvergence(admitted) {
    // Started inside a promise so a synchronous throw is reported like a rejection.
    Promise.resolve()
      .then(() => context.runtimeServer.beginBackgroundConvergence?.(admitted))
      .catch((error) => log(`background convergence failed: ${error?.message ?? String(error)}`))
  }

  // Every 60 s while ready, and before each write: a controller that stopped answering starts re-election.
  async function checkController() {
    const controller = context.admission?.controller
    if (typeof controller?.status !== "function") return null
    try {
      await controller.status()
      return null
    } catch (error) {
      forgetController()
      return controllerLostOutcome(error)
    }
  }

  function watchHead(gitDir) {
    if (disposed || headWatch?.gitDir === gitDir) return
    headWatch?.watcher.close()
    headWatch = null
    if (typeof gitDir !== "string") return
    try {
      const watcher = watch(gitDir, { persistent: false }, (event, filename) => {
        if (filename !== null && filename !== "HEAD") return
        if (headTimer !== null) clearTimeout(headTimer)
        headTimer = setTimeout(() => {
          headTimer = null
          admission.refresh({ force: true, waitMs: 0 })
        }, HEAD_DEBOUNCE_MS)
        headTimer.unref?.()
      })
      watcher.on("error", () => {})
      headWatch = { gitDir, watcher }
    } catch (error) {
      log(`could not watch ${gitDir} for HEAD changes: ${error.message}`)
    }
  }

  function statusContext() {
    return {
      root: context.root,
      activation: context.activation,
      runtime: context.runtime,
      admission: context.admission ?? { controller: null },
    }
  }

  function runtimeCall(name, input, signal) {
    return context.runtimeServer.callTool({
      deskRoot: context.root.root,
      name,
      input,
      person: context.person ?? null,
      statusContext: statusContext(),
      signal,
    })
  }

  async function callTool({ name, input = {}, signal }) {
    if (!TOOL_NAMES.includes(name)) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }
    }
    const requirement = toolRequirement(name)
    if (requirement === "status") return deskStatus(input, signal)
    if (requirement === "doctor") return deskDoctor(input, signal)
    if (!requirementMet(requirement, context)) {
      // A Desk that is still admitting, or one a retry could fix now, gets one bounded chance before the tool is refused.
      await admission.refresh({ waitMs: GATE_WAIT_MS })
    }
    if (requirement === "write" && requirementMet(requirement, context)) {
      const refusal = await confirmWritable(name)
      if (refusal) return refusal
    }
    if (!requirementMet(requirement, context)) return refusal(name, requirement)
    return runtimeCall(name, input, signal)
  }

  // Right before a write: the controller still answers and HEAD is still on the state branch. Either can change under a ready session.
  async function confirmWritable(name) {
    const lost = await checkController()
    if (lost) {
      await admission.degrade(lost)
      await admission.idle({ waitMs: GATE_WAIT_MS })
    }
    const inspection = inspectStateBranch({ root: context.root?.root, branch: context.stateBranchName, git })
    if (!inspection.ok) {
      await admission.refresh({ force: true, waitMs: GATE_WAIT_MS })
      if (context.stateBranch?.ok === false) return refusal(name, "write")
    }
    return null
  }

  function refusal(name, requirement) {
    const snapshot = admission.snapshot()
    // A refusal only happens while Desk is admitting or degraded: a ready session meets every requirement, and a write that finds HEAD moved has already re-run admission into its degraded state.
    const admitting = snapshot.state === "admitting"
    const code = admitting ? "admitting" : snapshot.code
    const fix = admitting
      ? "Desk is still admitting this session in the background. Call desk_status (it waits for admission), then retry."
      : snapshot.fix
    const blockers = snapshot.blockers
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          // The admission diagnostic (observed cause, remediation, runtime evidence) comes along, so the refusal alone says what to fix.
          ...snapshot.diagnostic,
          status: "degraded",
          state: snapshot.state,
          code,
          fix,
          blockers,
          tool: name,
          summary: `${name} needs ${REQUIREMENT_TEXT[requirement]}, which Desk has not admitted yet (${code}).`,
        }, null, 2),
      }],
      isError: true,
    }
  }

  async function deskStatus(input, signal) {
    if (admission.snapshot().state === "ready") {
      const lost = await checkController()
      if (lost) admission.degrade(lost)
    }
    const snapshot = await admission.refresh({ waitMs: STATUS_WAIT_MS })
    let payload = baseDiagnostic(snapshot)
    if (context.runtimeServer && context.root) {
      try {
        payload = JSON.parse((await runtimeCall("desk_status", input, signal)).content[0].text)
      } catch (error) {
        payload = { ...payload, status_error: error instanceof Error ? error.message : String(error) }
      }
    }
    return jsonResult(withAdmission(payload, admission.snapshot()))
  }

  async function deskDoctor(input, signal) {
    let format
    try {
      format = diagnosticFormat(input)
    } catch (error) {
      // Only the validator's own input error is an input error; anything else is a real failure for the front door to report.
      if (!(error instanceof TypeError)) throw error
      return { content: [{ type: "text", text: error.message }], isError: true }
    }
    if (input.repair !== undefined && !DOCTOR_REPAIRS.includes(input.repair)) {
      return { content: [{ type: "text", text: `unsupported repair; use one of: ${DOCTOR_REPAIRS.join(", ")}` }], isError: true }
    }
    if (format === "preview") {
      return jsonResult(previewRuntimeSnapshot(admission.snapshot().state === "ready" ? "ready" : "diagnostic"))
    }
    if (input.repair === STATE_BRANCH_REPAIR) return switchStateBranch()
    if (input.repair === "prune_readiness_state") {
      const result = pruneReadinessLeftovers({ stateHome: readinessStateHome })
      return jsonResult({
        status: "ok",
        repair: "prune_readiness_state",
        summary: `pruned ${result.pruned.length} leftover readiness controller folder(s) whose owner is dead and whose root is gone; kept ${result.kept}.`,
        ...result,
      })
    }
    const snapshot = admission.snapshot()
    let payload = snapshot.diagnostic ?? baseDiagnostic(snapshot)
    if (context.runtimeServer && context.root) {
      payload = JSON.parse((await runtimeCall("desk_doctor", { format }, signal)).content[0].text)
    }
    return jsonResult({
      ...withAdmission(payload, snapshot),
      repairs_available: DOCTOR_REPAIRS,
    })
  }

  async function switchStateBranch() {
    const branch = context.stateBranchName
    if (!context.root || typeof branch !== "string") {
      return jsonResult({
        status: "refused",
        repair: STATE_BRANCH_REPAIR,
        reason: "no_state_branch",
        fix: "This session has no state branch: the host passes --state-branch <name> (or desk.state_branch in the activation config) when a checkout must stay on one branch.",
      }, true)
    }
    const inspection = inspectStateBranch({ root: context.root.root, branch, git })
    if (inspection.ok) {
      return jsonResult({ status: "ok", repair: null, summary: `Already on the state branch ${branch}.`, state: admission.snapshot().state })
    }
    const repaired = repairStateBranch({ inspection, git })
    if (!repaired.repaired) {
      const problem = stateBranchProblem(inspection, { failedRepair: repaired })
      return jsonResult({ status: "refused", repair: STATE_BRANCH_REPAIR, code: problem.code, blockers: problem.blockers, fix: problem.fix }, true)
    }
    context.pendingRepairs.push(recordRepair(repaired.line))
    const snapshot = await admission.refresh({ force: true, waitMs: GATE_WAIT_MS })
    return jsonResult({ status: "ok", repair: repaired.line, state: snapshot.state, code: snapshot.code, fix: snapshot.fix })
  }

  function withAdmission(payload, snapshot) {
    const ready = snapshot.state === "ready"
    return {
      ...payload,
      status: ready ? payload.status ?? "ok" : STATUS_BY_STATE[snapshot.code] ?? (snapshot.state === "admitting" ? "admitting" : "degraded"),
      state: snapshot.state,
      code: snapshot.code,
      fix: snapshot.fix,
      repair: snapshot.repair,
      admission: {
        state: snapshot.state,
        code: snapshot.code,
        summary: snapshot.summary,
        blockers: snapshot.blockers,
        attempts: snapshot.attempts,
        failures: snapshot.failures,
        since: snapshot.since,
        next_retry_at: snapshot.next_retry_at,
        state_branch: branchSummary(context.stateBranch),
        writes: requirementMet("write", context) ? "available" : "refused",
        last_start: path.join(deskStateDir, "last-start.json"),
      },
    }
  }

  return {
    admission,
    context,
    callTool,
    start: () => admission.start(),
    dispose() {
      disposed = true
      admission.dispose()
      headWatch?.watcher.close()
      headWatch = null
      if (headTimer !== null) clearTimeout(headTimer)
      forgetController()
    },
  }
}

const STATUS_BY_STATE = { no_desk_root: "setup_required" }
const REQUIREMENT_TEXT = {
  read: "the desk root and the Desk runtime",
  controller: "admitted write authority and the readiness controller",
  write: "admitted write authority, the readiness controller and the checkout on its state branch",
}
const CONTROLLER_FIX = "Desk serves reads without the shared readiness controller (lexical search and timeline read the files directly) and re-elects it in the background after 1, 2, 5, 10 and 30 s, then every 60 s. Writes resume when a controller answers; call desk_status to retry now."

function baseDiagnostic(snapshot) {
  return snapshot.diagnostic ?? {
    mode: snapshot.state === "admitting" ? "admitting" : "degraded",
    summary: snapshot.summary,
  }
}

function branchSummary(inspection) {
  if (!inspection) return null
  return {
    branch: inspection.branch,
    checked: inspection.checked,
    ok: inspection.ok,
    kind: inspection.kind,
    head: inspection.head ?? null,
  }
}

function jsonResult(payload, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    ...(isError ? { isError: true } : {}),
  }
}

function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

function observed(error) {
  return {
    name: error instanceof Error ? error.name : "unknown",
    message: describe(error),
    ...(typeof error?.code === "string" ? { failure_code: error.code } : {}),
    ...(error?.diagnostic ? { diagnostic: error.diagnostic } : {}),
    // An activation failure carries its own terminal envelope: keep it whole.
    ...(error?.status === "terminal"
      ? { failure: { phase: error.phase, code: error.code, retryable: error.retryable, expected: error.expected, observed: error.observed, automatic_actions: error.automatic_actions } }
      : {}),
  }
}

function rootOutcome(error, deps) {
  if (error?.code === "DESK_ROOT_NOT_FOUND") {
    const diagnostic = deps.setupDiagnostic(error)
    return {
      state: "degraded",
      code: "no_desk_root",
      summary: diagnostic.summary,
      fix: diagnostic.remediation[0].message,
      diagnostic,
    }
  }
  if (error?.code === "ACTIVATION_CONFIG_INVALID") return activationOutcome(error)
  const missing = typeof error?.path === "string" ? error.path : "the desk root"
  return {
    state: "degraded",
    code: "root_unavailable",
    summary: `The desk root does not exist: ${describe(error)}`,
    fix: `Create or clone the desk at ${missing} (or correct the root the host passes), then call desk_status: Desk rechecks the root in place.`,
    diagnostic: { mode: "degraded", observed: observed(error) },
  }
}

function activationOutcome(error) {
  const code = error?.code === "activation_policy_invalid" ? "activation_policy_invalid" : "activation_config_invalid"
  const what = code === "activation_policy_invalid" ? "the desk_runtime policy in the activation config" : "the activation config"
  return {
    state: "degraded",
    code,
    summary: `Desk cannot use ${what}: ${describe(error)}`,
    fix: `Fix ${what} (${describe(error)}), then call desk_status: Desk rereads it in place.`,
    diagnostic: { mode: "degraded", observed: observed(error) },
  }
}

function admissionOutcome(error, { verified }) {
  const message = describe(error)
  if (error?.code === "authority_invalid") {
    return {
      state: "degraded",
      code: "authority_invalid",
      summary: `Desk write authority was not admitted: ${message} Reads are available; writes are refused.`,
      fix: "Make the write authority match the readiness policy: a person-scoped policy needs --person <alias> (or an authority provider that names the person), and a workspace policy must not pass a different --person. Fix the binding, then call desk_status.",
      diagnostic: { mode: "degraded", observed: observed(error) },
    }
  }
  if (error?.code === "embedding_model_mismatch") {
    return {
      state: "degraded",
      code: "embedding_model_mismatch",
      summary: `${message} Lexical reads are available; writes and semantic search wait.`,
      fix: "Remove the DESK_EMBED_MODEL / OLLAMA_EMBED_MODEL override from the Desk MCP server's environment (or set it to the pinned model), then reconnect the Desk MCP server so it starts with the corrected environment. Lexical reads keep working until then.",
      diagnostic: { mode: "degraded", observed: observed(error), authority_verified: verified !== null },
    }
  }
  if (error?.code === "controller_semantic_mismatch") {
    return {
      state: "degraded",
      code: "controller_semantic_mismatch",
      summary: `${message} Lexical reads are available; writes wait for a controller this session can share.`,
      fix: "Another Desk session on this root runs the readiness controller with a different semantic policy. Desk retries in the background and takes over when that session ends; align the desk_runtime.semantic policy of both sessions to share one controller, then call desk_status.",
      diagnostic: { mode: "degraded", observed: observed(error) },
    }
  }
  if (/unsafe directory ownership or permissions|unsafe OS-user ownership|unsafe runtime directory ancestry/u.test(message)) {
    return {
      state: "degraded",
      code: "controller_state_unsafe",
      summary: `${message} Reads are available; writes wait.`,
      fix: "A readiness state directory is not a private directory owned by this user (a symlink, or another owner). Remove the stray entry or fix its owner, and make it mode 700, then call desk_status.",
      diagnostic: { mode: "degraded", observed: observed(error) },
    }
  }
  if (error?.code === "controller_start_failed" || CONTROLLER_FAILURE.test(message) || CONTROLLER_FAILURE.test(error?.code ?? "")) {
    return controllerLostOutcome(error)
  }
  return exceptionOutcome(error)
}

function controllerLostOutcome(error) {
  return {
    state: "degraded",
    code: "controller_unavailable",
    summary: `The shared readiness controller did not answer (${describe(error)}).`,
    fix: CONTROLLER_FIX,
    diagnostic: { mode: "degraded", observed: observed(error) },
  }
}

function semanticOutcome(failure, barrier) {
  return {
    state: "degraded",
    code: "semantic_unavailable",
    summary: "Required semantic convergence is not complete. Lexical reads and writes are available.",
    fix: "Desk keeps converging semantic search in the background and retries; call desk_status to check. If it stays unavailable, check the embedding service named in readiness.convergence.",
    diagnostic: { mode: "degraded", observed: failure ? observed(failure.error) : { barrier: barrier ?? null } },
  }
}
