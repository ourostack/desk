// One Desk MCP session after the handshake: the admission pipeline, the tool gates, desk_status and desk_doctor.
//
// index.js answers the handshake through the front door first, then hands every tools/call here. Admission runs in the background (see admission.js) and fills a context as it goes: the desk root, activation, the runtime (restored from the offline pack), the state-branch check, admitted write authority and the readiness controller. Nothing here blocks the thread that answers the host: file reads and the runtime restore run on a worker thread (admission-worker.js), Git and the controller are asynchronous, and desk_status answers within a bounded time whatever admission is doing.
//
// Each tool needs part of that context:
// - desk_status and desk_doctor always answer, and each desk_status retries admission when Desk is not ready;
// - reads (search, recall, similar, timeline, thread) need the runtime and a root; without a readiness controller, lexical search and timeline read the files directly;
// - desk_work_ledger also needs admitted authority, and desk_reindex a readiness controller;
// - writes (task_*, track_*, friction_add, lesson_add) need admitted authority and the checkout on its state branch, checked again right before each write. They never need the readiness controller: with one, the change is journaled; without one, it goes straight to the file and the next controller's watcher or scan picks it up.
// A tool whose needs are not met answers `{ status: "degraded", code, fix }` with a fix the agent can act on in this session, and a tool that throws answers the same way instead of failing the call.
//
// This module must not import anything from the runtime pack: it runs before the pack is restored.

import { watch as watchFileSystem } from "node:fs"
import * as path from "node:path"

import { admitControlPlane, validateAdmissionAuthority, verifyAdmissionAuthority } from "../activation/admit.js"
import { createAdmission, exceptionOutcome } from "./admission.js"
import { DOCTOR_REPAIRS } from "./front-door.js"
import { appendRepairLog, lastStartPath, writeLastStart } from "./last-start.js"
import { diagnosticFormat, previewRuntimeSnapshot } from "./preview-snapshot.js"
import { inspectStateBranch, repairStateBranch, runGit, stateBranchProblem, STATE_BRANCH_REPAIR } from "./state-branch.js"
import { HUNG_MISSES, HUNG_PROBE_MS, hungControllerReport, probeController, probeMissed } from "../readiness/hung-controller.js"
import { pruneReadinessLeftovers } from "../readiness/leftovers.js"
import { TOOL_NAMES } from "../tool-names.js"

const READ_TOOLS = new Set(["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread"])
const SEMANTIC_TOOLS = new Set(["desk_recall", "desk_similar"])
export const RECLAIM_REPAIR = "reclaim_controller"
const STATUS_WAIT_MS = 50
const STATUS_DETAIL_MS = 120
// The most desk_status spends on its own waits (a new admission attempt, then the runtime status), well inside the 200 ms it must answer in.
const STATUS_BUDGET_MS = 90
const GATE_WAIT_MS = 10000
const HEAD_DEBOUNCE_MS = 100
const WRITE_PING_MS = 1000
const CONTROLLER_FAILURE = /readiness controller|ECONNREFUSED|ECONNRESET|ENOENT|EPIPE|ETIMEDOUT|EADDRINUSE/u

// Launcher codes (--degraded) that still allow reads: write identity or the checkout state is unproven. Every other code is an integrity failure: the running code or its authority data cannot be trusted, so every data tool refuses.
export const LAUNCHER_READ_ONLY_CODES = Object.freeze([
  "crew_state_unavailable", "crew_state_not_main", "repository_mismatch", "authority_invalid",
  "identity_unavailable", "identity_not_emu", "identity_unregistered", "identity_ambiguous",
])

/** What a tool needs from admission: "status", "doctor", "read", "authority", "controller" or "write". */
export function toolRequirement(name) {
  if (name === "desk_status" || name === "desk_doctor") return name.slice(5)
  if (READ_TOOLS.has(name)) return "read"
  if (name === "desk_work_ledger") return "authority"
  if (name === "desk_reindex") return "controller"
  return "write"
}

/** Whether the admitted context meets a requirement. */
export function requirementMet(requirement, context) {
  if (context.launcher?.mode === "refuse") return false
  const readable = Boolean(context.runtimeServer && context.root)
  if (requirement === "read") return readable
  if (requirement === "controller") return readable && Boolean(context.admission?.controller)
  const authorized = readable && context.authorityAdmitted === true
  if (requirement === "authority") return authorized
  return authorized && context.stateBranch?.ok !== false && !context.launcher?.blocksWrites
}

/**
 * Build a session. `deps` carries everything index.js resolved or was given:
 * resolveInputs() (async; `{ root, activation }` or `{ rootError }` / `{ root, activationError }`), loadRuntime(activation) (async; `{ runtimeServer, runtimeStatus }` or `{ outcome }`), setupDiagnostic(error),
 * args, authorityProviders, readinessStateHome, deskStateDir, git, watch, timers, stderr, notifyToolsChanged, launcher, hung.
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
    launcher = null,
    hung: hungOptions = {},
  } = deps
  const hungPolicy = {
    misses: HUNG_MISSES,
    probeMs: HUNG_PROBE_MS,
    probe: probeController,
    ...hungOptions,
  }
  const context = { pendingRepairs: [], exceptions: [], hung: { misses: 0 }, launcher }
  const lexicalViews = new WeakMap()
  let headWatch = null
  let headTimer = null
  let disposed = false
  // The latest runtime status detail, served (and marked cached) when a fresh one does not arrive within desk_status's budget.
  let lastStatusDetail = null

  const log = (line) => stderr.write(`[desk-mcp] ${line}\n`)

  function recordLastStart(snapshot) {
    try {
      writeLastStart({ stateDir: deskStateDir, snapshot, root: context.root?.root ?? null })
    } catch (error) {
      log(`could not record last-start.json in ${deskStateDir}: ${error.message}`)
    }
  }

  const admission = createAdmission({
    context,
    timers,
    attempt: admitOnce,
    check: checkController,
    onTransition(snapshot) {
      log(snapshot.state === "ready"
        ? `state: ready${snapshot.repair ? ` (${snapshot.repair})` : ""}`
        : `state: ${snapshot.state} — ${snapshot.fix}`)
      recordLastStart(snapshot)
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
    if (context.admission) context.admission = { ...context.admission, controller: null }
    if (controller) context.controllerLost = true
    context.semanticCurrent = false
    Promise.resolve().then(() => controller?.close?.()).catch(() => {})
  }

  function forgetAuthority() {
    forgetController()
    context.admission = null
    context.authority = null
    context.person = null
    context.authorityAdmitted = false
    context.controllerLost = false
  }

  function forgetDesk() {
    forgetAuthority()
    context.root = null
    context.stateBranch = null
    context.policyKey = null
    context.hung = { misses: 0 }
  }

  // The automatic state-branch switch belongs to the session's first admission attempt only, whatever that attempt ends in (ready, any degraded state, or a throw). After it, only desk_doctor's switch_state_branch repair switches.
  async function admitOnce() {
    try {
      return await admitAttempt()
    } finally {
      context.startupDone = true
    }
  }

  async function admitAttempt() {
    const repairs = context.pendingRepairs.splice(0)
    const headTriggered = context.headTriggered === true
    context.headTriggered = false
    if (launcher?.mode === "refuse") return launcherRefusedOutcome(launcher)

    const inputs = await deps.resolveInputs()
    if (inputs.rootError) {
      forgetDesk()
      return rootOutcome(inputs.rootError, deps)
    }
    const newRoot = context.root?.root !== inputs.root.root
    if (newRoot) forgetDesk()
    context.root = inputs.root
    // The root's own start record begins with the state it is in now (admitting, on the first attempt), not only with the next change.
    if (newRoot) recordLastStart(admission.snapshot())
    const deskRoot = inputs.root.root
    if (inputs.activationError) return activationOutcome(inputs.activationError)
    const activation = inputs.activation
    const policyKey = JSON.stringify(activation.readinessPolicy)
    if (context.policyKey !== policyKey) forgetAuthority()
    context.policyKey = policyKey
    context.activation = activation.activationStatus
    context.stateBranchName = activation.stateBranch
    const policy = activation.readinessPolicy

    if (!context.runtimeServer) {
      const loaded = await deps.loadRuntime(activation)
      if (loaded.outcome) return loaded.outcome
      context.runtimeServer = loaded.runtimeServer
      context.runtime = loaded.runtimeStatus
    }

    // The automatic switch runs only during the first admission attempt, and never for a HEAD change the watch saw.
    const startup = !context.startupDone && !headTriggered
    let branchProblem = null
    let inspection = await inspectStateBranch({ root: deskRoot, branch: activation.stateBranch, git })
    if (!inspection.ok && inspection.automatic && startup) {
      const repaired = await repairStateBranch({ inspection, git })
      if (repaired.repaired) {
        repairs.push(recordRepair(repaired.line))
        inspection = await inspectStateBranch({ root: deskRoot, branch: activation.stateBranch, git })
      } else {
        branchProblem = stateBranchProblem(inspection, { failedRepair: repaired, automatic: startup })
      }
    }
    if (!inspection.ok && branchProblem === null) branchProblem = stateBranchProblem(inspection, { automatic: startup })
    context.stateBranch = inspection
    watchHead(inspection.gitDir)

    const onRepair = (repair) => repairs.push(recordRepair(`repaired: readiness state directory mode ${repair.from} → 700 (${repair.path})`))
    let controllerProblem = null
    if (!context.authorityAdmitted) {
      const admitted = await admitAuthority({ deskRoot, policy, onRepair })
      if (admitted.outcome) return { ...admitted.outcome, repair: repairs.at(-1) }
      controllerProblem = admitted.controllerProblem
    } else if (context.controllerLost) {
      controllerProblem = await reconnectController({ deskRoot, policy, onRepair })
    }
    if (controllerProblem !== null) {
      controllerProblem = await noticeHungController({ controllerProblem, deskRoot, policy })
    } else if (context.admission?.controller) {
      // Connected: a hung controller that answers again is no longer counted or reported.
      context.hung = { misses: 0 }
    }

    let semanticProblem = null
    const controller = context.admission?.controller
    if (policy.semantic === "required" && controller && !context.semanticCurrent) {
      semanticProblem = controller.embeddingOverride
        ? overrideOutcome(controller.embeddingOverride)
        : await semanticBarrier(controller)
    }

    const repair = repairs.at(-1)
    if (launcher?.blocksWrites) return { ...launcherReadOnlyOutcome(launcher), repair }
    if (branchProblem !== null) return { state: "degraded", ...branchProblem, repair }
    if (controllerProblem !== null) return { ...controllerProblem, repair }
    if (semanticProblem !== null) return { ...semanticProblem, repair }
    return { state: "ready", repair }
  }

  // Write authority, then the readiness controller. A controller failure never takes authority away: writes go straight to the files.
  async function admitAuthority({ deskRoot, policy, onRepair }) {
    let verified = null
    let controllerFailure = null
    const connector = context.runtimeServer.connectOrStartController
    const authorityProvider = policy.authority_provider === null ? null : authorityProviders[policy.authority_provider]
    let admitted
    try {
      admitted = await (context.runtimeServer.admitControlPlane ?? admitControlPlane)({
        deskRoot,
        person: args.person,
        policy,
        runtime: context.runtime,
        authorityProvider,
        stateHome: readinessStateHome,
        onRepair,
        verifyAuthority: async (options) => {
          verified = await verifyAdmissionAuthority(options)
          return verified
        },
        connectController: async (options) => {
          try {
            return await connector(options)
          } catch (error) {
            controllerFailure = { error }
            return { accepted: true, unavailable: true }
          }
        },
      })
    } catch (error) {
      if (error?.code === "authority_invalid" || verified === null) {
        return { outcome: admissionOutcome(error) }
      }
      // Authority was verified; only the controller failed to start.
      admitted = { state: "CONTROL_READY", root: deskRoot, authority: verified, runtime: context.runtime, controller: null, automatic_actions: [] }
      controllerFailure = { error }
    }
    try {
      context.person = validateAdmissionAuthority({ authority: admitted?.authority, person: args.person, policy })
    } catch (error) {
      forgetController()
      return { outcome: admissionOutcome(error) }
    }
    context.authority = admitted.authority
    context.authorityAdmitted = true
    if (controllerFailure !== null) {
      context.admission = { ...admitted, controller: null }
      context.controllerLost = true
      return { controllerProblem: admissionOutcome(controllerFailure.error) }
    }
    context.admission = admitted
    context.controllerLost = false
    if (policy.semantic !== "required") startBackgroundConvergence(admitted)
    return { controllerProblem: null }
  }

  async function reconnectController({ deskRoot, policy, onRepair }) {
    try {
      const connector = context.runtimeServer.connectOrStartController
      const controller = await connector({ deskRoot, policy, stateHome: readinessStateHome, onRepair })
      if (!controller?.accepted) throw Object.assign(new Error("The readiness controller could not accept ownership."), { code: "controller_start_failed" })
      context.admission = { ...context.admission, controller }
      context.controllerLost = false
      if (policy.semantic !== "required") startBackgroundConvergence(context.admission)
      return null
    } catch (error) {
      return admissionOutcome(error)
    }
  }

  // A controller whose owner runs but that does not answer (it accepts and stays silent, or refuses while its owner runs): count misses across attempts; after enough of them the session is controller_hung. It is never stopped and never taken over: its owner is another session's Desk MCP server.
  async function noticeHungController({ controllerProblem, deskRoot, policy }) {
    if (controllerProblem.code !== "controller_unavailable") return controllerProblem
    const probe = await hungPolicy.probe({ root: deskRoot, policy, stateHome: readinessStateHome, timeoutMs: hungPolicy.probeMs })
    if (!probeMissed(probe)) {
      context.hung = { misses: 0 }
      return controllerProblem
    }
    context.hung = { misses: context.hung.misses + 1, ...hungControllerReport(probe) }
    return hungOutcome(controllerProblem, context.hung, hungPolicy.misses)
  }

  async function semanticBarrier(controller) {
    let barrier = null
    let failure = null
    try {
      await controller.beginConvergence()
      barrier = await controller.barrier({ capability: "semantic", wait: true })
    } catch (error) {
      // Anything can be thrown, including null: keep what was thrown.
      failure = { error }
    }
    if (barrier?.capability !== "semantic" || barrier.current !== true) return semanticOutcome(failure, barrier)
    context.semanticCurrent = true
    return null
  }

  function startBackgroundConvergence(admitted) {
    // Started on a later turn of the event loop, so its first synchronous stretch (opening the index database) never joins the transition to ready in one block; inside a promise, so a synchronous throw is reported like a rejection.
    new Promise((resolve) => setImmediate(resolve))
      .then(() => context.runtimeServer.beginBackgroundConvergence?.(admitted))
      .catch((error) => log(`background convergence failed: ${error?.message ?? String(error)}`))
  }

  // Every 60 s while ready: a controller that stopped answering starts re-election.
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

  let checking = null
  function backgroundControllerCheck() {
    checking ??= checkController()
      .then((lost) => lost && admission.degrade(lost))
      .finally(() => { checking = null })
  }

  function watchHead(gitDir) {
    if (disposed || headWatch?.gitDir === gitDir) return
    closeHeadWatch()
    if (typeof gitDir !== "string") return
    try {
      const watcher = watch(gitDir, { persistent: false }, (event, filename) => {
        // Without a file name there is nothing to tell a HEAD change from index churn; the retries and desk_status still cover it.
        if (filename !== "HEAD") return
        if (headTimer !== null) clearTimeout(headTimer)
        headTimer = setTimeout(() => {
          headTimer = null
          context.headTriggered = true
          admission.refresh({ force: true, waitMs: 0 })
        }, HEAD_DEBOUNCE_MS)
        headTimer.unref?.()
      })
      // A watcher that fails is dropped, so the next admission attempt creates a new one.
      watcher.on("error", (error) => {
        log(`the HEAD watch on ${gitDir} failed (${error?.message ?? error}); it is re-created on the next admission attempt`)
        if (headWatch?.watcher === watcher) closeHeadWatch()
      })
      headWatch = { gitDir, watcher }
    } catch (error) {
      log(`could not watch ${gitDir} for HEAD changes: ${error.message}`)
    }
  }

  function closeHeadWatch() {
    headWatch?.watcher.close()
    headWatch = null
  }

  // The controller a read sees: with an embedding override, a lexical-only view, so this session never embeds a query with the wrong model.
  function readerController() {
    const controller = context.admission?.controller ?? null
    if (!controller?.embeddingOverride) return controller
    let view = lexicalViews.get(controller)
    if (!view) {
      view = Object.create(controller, {
        identity: { value: { ...controller.identity, semantic_contract: { mode: "unsupported", embedding_spec: null } } },
      })
      lexicalViews.set(controller, view)
    }
    return view
  }

  // `admissionContext` null leaves admission out: the runtime then writes files without journaling them.
  function statusContext(admissionContext) {
    return {
      root: context.root,
      activation: context.activation,
      runtime: context.runtime,
      ...(admissionContext === null ? {} : { admission: admissionContext }),
    }
  }

  function runtimeCall(name, input, signal, admissionContext = { ...context.admission, controller: readerController() }) {
    return context.runtimeServer.callTool({
      deskRoot: context.root.root,
      name,
      input,
      person: context.person ?? null,
      statusContext: statusContext(admissionContext),
      signal,
    })
  }

  async function callTool({ name, input = {}, signal }) {
    if (!TOOL_NAMES.includes(name)) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }
    }
    try {
      return await dispatch(name, input, signal)
    } catch (error) {
      return toolException(name, error)
    }
  }

  async function dispatch(name, input, signal) {
    const requirement = toolRequirement(name)
    if (requirement === "status") return deskStatus(input, signal)
    if (requirement === "doctor") return deskDoctor(input, signal)
    if (!requirementMet(requirement, context)) {
      // A Desk that is still admitting, or one a retry could fix now, gets one bounded chance before the tool is refused.
      await admission.refresh({ waitMs: GATE_WAIT_MS })
    }
    if (!requirementMet(requirement, context)) return refusal(name, requirement)
    if (SEMANTIC_TOOLS.has(name) && context.admission?.controller?.embeddingOverride) {
      return degradedResult(name, overrideOutcome(context.admission.controller.embeddingOverride), "semantic search")
    }
    if (requirement === "write") return write(name, input, signal)
    return runtimeCall(name, input, signal)
  }

  // Right before a write, HEAD must still be on the state branch; it can move under a ready session. The controller only decides whether the change is journaled.
  async function write(name, input, signal) {
    const inspection = await inspectStateBranch({ root: context.root.root, branch: context.stateBranchName, git })
    if (!inspection.ok) {
      context.stateBranch = inspection
      context.headTriggered = true
      admission.refresh({ force: true, waitMs: 0 })
      return refusal(name, "write")
    }
    const controller = context.admission?.controller
    if (controller && await controllerAnswers(controller)) return runtimeCall(name, input, signal, context.admission)
    // No controller to journal through: write the file directly. A controller's watcher, or the next one's convergence scan, picks the change up.
    return runtimeCall(name, input, signal, null)
  }

  // A quick check before journaling a write through the controller; a controller that does not answer is dropped, and the write goes to the file.
  async function controllerAnswers(controller) {
    if (typeof controller.status !== "function") return true
    try {
      await controller.status(WRITE_PING_MS)
      return true
    } catch (error) {
      forgetController()
      admission.fail(controllerLostOutcome(error))
      return false
    }
  }

  function refusal(name, requirement) {
    const snapshot = admission.snapshot()
    let { code, fix, blockers } = snapshot
    if (snapshot.state === "admitting") {
      code = "admitting"
      fix = "Desk is still admitting this session in the background. Call desk_status, then retry."
    } else if (launcher?.mode !== "refuse" && requirement === "write" && context.stateBranch?.ok === false) {
      ({ code, fix, blockers } = stateBranchProblem(context.stateBranch, { automatic: !context.startupDone }))
    } else if (launcher?.blocksWrites && requirement === "write" && requirementMet("authority", context)) {
      ({ code, fix } = launcherReadOnlyOutcome(launcher))
    }
    return degradedResult(name, { ...snapshot.diagnostic, state: snapshot.state, code, fix, blockers }, REQUIREMENT_TEXT[requirement])
  }

  function toolException(name, error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`${name} failed: ${message}`)
    return degradedResult(name, {
      state: admission.snapshot().state,
      code: "tool_exception",
      fix: `${name} failed unexpectedly (${message}). Desk is still serving; retry the call, and if it fails the same way call desk_doctor and report the message.`,
      observed: { name: error instanceof Error ? error.name : "unknown", message },
    }, null)
  }

  async function deskStatus(input, signal) {
    // desk_status must answer at once whatever admission is doing: it starts or joins an attempt but waits only briefly for it, and the whole answer shares one time budget. A ready session also checks its controller in the background, so a lost one is re-elected without waiting for the 60 s check.
    const deadline = Date.now() + STATUS_BUDGET_MS
    // An attempt that was already running (a slow restore, the import of the runtime, the controller election) is joined, not waited on.
    const snapshot = await admission.refresh({ waitMs: STATUS_WAIT_MS, joinMs: 0 })
    if (snapshot.state === "ready") backgroundControllerCheck()
    let payload = baseDiagnostic(snapshot)
    if (context.runtimeServer && context.root && launcher?.mode !== "refuse") {
      const outcome = await raceWithTimer(Promise.resolve().then(() => runtimeCall("desk_status", input, signal)), Math.max(0, Math.min(STATUS_DETAIL_MS, deadline - Date.now())))
      if (outcome.timedOut && lastStatusDetail !== null) {
        payload = { ...lastStatusDetail.payload, status_detail: `cached: the runtime status (index, readiness controller) did not answer in time; this detail is from ${lastStatusDetail.at}. Call desk_status again for a fresh one.` }
      } else if (outcome.timedOut) {
        payload = { ...payload, status_detail: "unavailable: the runtime status (index, readiness controller) did not answer in time; call desk_status again" }
      } else if (outcome.error !== undefined) {
        const error = outcome.error
        payload = { ...payload, status_error: error instanceof Error ? error.message : String(error) }
      } else {
        payload = JSON.parse(outcome.value.content[0].text)
        lastStatusDetail = { payload, at: new Date().toISOString() }
      }
    }
    return jsonResult(withAdmission(payload, admission.snapshot()))
  }

  function raceWithTimer(promise, ms) {
    let timer
    return Promise.race([
      promise.then((value) => ({ value }), (error) => ({ error })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
  }

  async function deskDoctor(input, signal) {
    let format
    try {
      format = diagnosticFormat(input)
    } catch (error) {
      // Only the validator's own input error is an input error; anything else is a real failure for the caller to report.
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
    if (input.repair === RECLAIM_REPAIR) return reclaimController()
    if (input.repair === "prune_readiness_state") {
      const result = await pruneReadinessLeftovers({ stateHome: readinessStateHome })
      return jsonResult({
        status: "ok",
        repair: "prune_readiness_state",
        summary: `pruned ${result.pruned.length} leftover readiness controller folder(s) whose owner is dead and whose root is gone; kept ${result.kept}.`,
        ...result,
      })
    }
    const snapshot = admission.snapshot()
    let payload = baseDiagnostic(snapshot)
    if (context.runtimeServer && context.root && launcher?.mode !== "refuse") {
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
    const inspection = await inspectStateBranch({ root: context.root.root, branch, git })
    if (inspection.ok) {
      return jsonResult({ status: "ok", repair: null, summary: `Already on the state branch ${branch}.`, state: admission.snapshot().state })
    }
    const repaired = await repairStateBranch({ inspection, git })
    if (!repaired.repaired) {
      const problem = stateBranchProblem(inspection, { failedRepair: repaired })
      return jsonResult({ status: "refused", repair: STATE_BRANCH_REPAIR, code: problem.code, blockers: problem.blockers, fix: problem.fix }, true)
    }
    context.pendingRepairs.push(recordRepair(repaired.line))
    const snapshot = await admission.refresh({ force: true, waitMs: GATE_WAIT_MS })
    return jsonResult({ status: "ok", repair: repaired.line, state: snapshot.state, code: snapshot.code, fix: snapshot.fix })
  }

  // A report, not a repair: Desk never stops another session's Desk MCP server, which is where the controller runs, and never takes a running owner's controller over.
  async function reclaimController() {
    if (!context.root || !context.policyKey) {
      return jsonResult({ status: "refused", repair: RECLAIM_REPAIR, reason: "not_admitted", fix: "Desk has not resolved a desk root and policy yet; call desk_status, then retry." }, true)
    }
    const probe = await hungPolicy.probe({ root: context.root.root, policy: JSON.parse(context.policyKey), stateHome: readinessStateHome, timeoutMs: hungPolicy.probeMs })
    const report = hungControllerReport(probe)
    const hung = probeMissed(probe)
    return jsonResult({
      status: "report",
      repair: RECLAIM_REPAIR,
      reclaimed: false,
      controller: report,
      missed_checks: context.hung.misses,
      summary: hung
        ? `${notAnswering(report)}. Desk does not stop it or replace it: it runs inside that session's Desk MCP server, and stopping it would cost that session its Desk connection.`
        : `The readiness controller for this root is not hung (probe: ${probe.state}); there is nothing to reclaim.`,
      fix: hung ? hungFix(report) : "Call desk_status.",
    })
  }

  // After the handshake, an exception nothing else caught (index.js's process handlers report it here): record it, keep serving, and re-admit on the backoff.
  function recordException(kind, error) {
    const message = error instanceof Error ? error.message : String(error)
    context.exceptions = [...context.exceptions, { at: new Date().toISOString(), kind, message }].slice(-5)
    log(`caught ${kind} after the handshake: ${message}; Desk keeps serving and re-admits`)
    forgetController()
    return admission.fail({
      code: "runtime_exception",
      summary: `Desk caught an unexpected ${kind.replace("_", " ")} after the handshake: ${message}`,
      fix: `Desk kept serving and re-admits in the background (call desk_status to retry now); no restart is needed. If it repeats, call desk_doctor and report the message: ${message}`,
      diagnostic: { mode: "degraded", observed: { kind, message } },
    })
  }

  function withAdmission(payload, snapshot) {
    const ready = snapshot.state === "ready"
    const override = context.admission?.controller?.embeddingOverride ?? null
    const semantic = override
      ? { ...payload.semantic, current: false, status: "unavailable (embedding_override)", fix: override.fix }
      : payload.semantic
    return {
      ...payload,
      ...(semantic === undefined ? {} : { semantic }),
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
        controller: context.admission?.controller ? "connected" : "absent",
        hung_controller: context.hung.misses > 0 ? { ...context.hung } : null,
        writes: requirementMet("write", context) ? "available" : "refused",
        exceptions: context.exceptions,
        launcher: launcher === null ? null : { code: launcher.code, reason: launcher.reason, mode: launcher.mode },
        last_start: lastStartPath({ stateDir: deskStateDir, root: context.root?.root ?? null }),
      },
    }
  }

  recordLastStart(admission.snapshot())

  return {
    admission,
    context,
    callTool,
    recordException,
    start: () => admission.start(),
    dispose() {
      disposed = true
      admission.dispose()
      closeHeadWatch()
      if (headTimer !== null) clearTimeout(headTimer)
      forgetController()
    },
  }
}

const STATUS_BY_STATE = { no_desk_root: "setup_required" }
const REQUIREMENT_TEXT = {
  read: "the desk root and the Desk runtime",
  authority: "admitted write authority",
  controller: "the shared readiness controller",
  write: "admitted write authority and the checkout on its state branch",
}
const CONTROLLER_FIX = "Desk serves reads and writes without the shared readiness controller (lexical search and timeline read the files directly; writes go straight to the files) and re-elects it in the background after 1, 2, 5, 10 and 30 s, then every 60 s. Call desk_status to retry now; only desk_reindex and semantic search wait for a controller."
function degradedResult(name, fields, needs) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({
        ...fields,
        status: "degraded",
        tool: name,
        summary: needs === null
          ? `${name} failed unexpectedly; Desk is still serving.`
          : `${name} needs ${needs}, which Desk has not admitted yet (${fields.code}).`,
      }, null, 2),
    }],
    isError: true,
  }
}

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
  return typeof error?.message === "string" ? error.message : String(error)
}

// Errors arrive as Error objects, or as plain objects from the admission worker: keep their name, code and fields either way.
function observed(error) {
  return {
    name: error instanceof Error || typeof error?.name === "string" ? error.name : "unknown",
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

function admissionOutcome(error) {
  const message = describe(error)
  if (error?.code === "authority_invalid") {
    return {
      state: "degraded",
      code: "authority_invalid",
      summary: `Desk write authority was not admitted: ${message} Reads are available; writes are refused.`,
      fix: "Make the write authority match the readiness policy. If the fix is in the activation config or the authority provider's data, fix it and call desk_status: Desk rechecks it in place. If the fix is the --person launch argument (a person-scoped policy needs --person <alias>; a workspace policy must not pass a different --person), correct it in the host's MCP configuration and reconnect the Desk MCP server, because launch arguments are read once at start.",
      diagnostic: { mode: "degraded", observed: observed(error) },
    }
  }
  if (error?.code === "controller_semantic_mismatch") {
    return {
      state: "degraded",
      code: "controller_semantic_mismatch",
      summary: `${message} Lexical reads and writes are available; semantic search waits for a controller this session can share.`,
      fix: "Another Desk session on this root runs the readiness controller with a different semantic policy. Desk retries in the background and takes over when that session ends; align the desk_runtime.semantic policy of both sessions to share one controller, then call desk_status.",
      diagnostic: { mode: "degraded", observed: observed(error) },
    }
  }
  if (/unsafe directory ownership or permissions|unsafe OS-user ownership|unsafe runtime directory ancestry/u.test(message)) {
    return {
      state: "degraded",
      code: "controller_state_unsafe",
      summary: `${message} Reads and writes are available; semantic search and reindexing wait.`,
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

// Before enough misses: still controller_unavailable, with the count. After: controller_hung, controller-free, and the owner named.
function hungOutcome(controllerProblem, hung, needed) {
  const detected = hung.misses >= needed
  return {
    ...controllerProblem,
    code: detected ? "controller_hung" : controllerProblem.code,
    summary: `${notAnswering(hung)} (${Math.min(hung.misses, needed)} of ${needed} checks missed${detected ? "; hung" : ""}).`,
    fix: hungFix(hung),
    diagnostic: { ...controllerProblem.diagnostic, hung_controller: hung },
  }
}

function notAnswering(report) {
  const how = report.state === "silent" ? "accepts connections but does not answer" : "does not accept connections while its owner runs"
  return `The readiness controller for this root (owner pid ${report.owner_pid}, ${report.endpoint}) ${how}`
}

// What the agent can do now: nothing. Every clause is true in this session as it runs.
function hungFix(report) {
  return `Nothing to do: search uses plain text (lexical search and timeline read the files directly) and writes work (they go straight to the files). The controller recovers when it answers again or when its owning session (pid ${report.owner_pid}) ends; Desk keeps checking in the background.`
}

function overrideOutcome(override) {
  return {
    state: "degraded",
    code: "embedding_override",
    summary: `Semantic search is unavailable in this session: its embedding model is ${JSON.stringify(override.model)}, not the pinned ${override.pinned_model}. Lexical search and writes are available.`,
    fix: override.fix,
    diagnostic: { mode: "degraded", observed: { embedding_override: override } },
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

function launcherRefusedOutcome(launcher) {
  return {
    state: "degraded",
    code: launcher.code,
    summary: `Desk's launcher started it in refuse mode: ${launcher.reason}. Every data tool is refused; desk_status and desk_doctor answer.`,
    fix: `The launcher could not trust the running code or its authority data (${launcher.code}: ${launcher.reason}). Fix what that names (for example, refresh the plugin cache), then reconnect the Desk MCP server so the launcher checks again.`,
    diagnostic: { mode: "refused", launcher: { code: launcher.code, reason: launcher.reason } },
  }
}

function launcherReadOnlyOutcome(launcher) {
  return {
    state: "degraded",
    code: launcher.code,
    summary: `Desk's launcher allows reads only: ${launcher.reason}.`,
    fix: `The launcher could not prove this session's write identity or checkout state (${launcher.code}: ${launcher.reason}). Reads keep working. Fix what that names, then reconnect the Desk MCP server so the launcher checks again.`,
    diagnostic: { mode: "read_only", launcher: { code: launcher.code, reason: launcher.reason } },
  }
}
