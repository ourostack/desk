// One Desk MCP session after the handshake: the admission pipeline, the tool gates, desk_status and desk_doctor.
//
// index.js answers the handshake through the front door first, then hands every tools/call here. Admission runs in the background (see admission.js) and fills a context as it goes: the desk root, activation, the runtime (restored from the offline pack), the state-branch check, admitted write authority and the session's search engine (src/search/engine.js, in this process). Nothing here blocks the thread that answers the host: file reads and the runtime restore run on a worker thread (admission-worker.js), Git is asynchronous, and desk_status answers within a bounded time whatever admission is doing.
//
// Each tool needs part of that context:
// - desk_status and desk_doctor always answer, and each desk_status retries admission when Desk is not ready;
// - reads (search, recall, similar, timeline, thread) need the runtime and a root; before the search engine has started, exact-word search and timeline read the files directly;
// - desk_reindex also needs the search engine;
// - writes (task_*, track_*, friction_add, lesson_add) need admitted authority and the checkout on its state branch, checked again right before each write. They never wait for the search engine: a write tells it which files changed when it has started, and its file watcher or first read picks the change up otherwise.
// A tool whose needs are not met answers `{ status: "degraded", code, fix }` with a fix the agent can act on in this session, and a tool that throws answers the same way instead of failing the call.
//
// This module must not import anything from the runtime pack: it runs before the pack is restored.

import { statSync, unwatchFile, watchFile, promises as headFileSystem, constants as headConstants } from "node:fs"
import { createHash } from "node:crypto"
import * as path from "node:path"

import { validateAdmissionAuthority, verifyAdmissionAuthority } from "../activation/admit.js"
import { createAdmission, exceptionOutcome } from "./admission.js"
import { redactMachineText } from "./argv-safe-reason.js"
import { DOCTOR_REPAIRS } from "./front-door.js"
import { hostedRefusal } from "./hosted.js"
import { deskSkill } from "./skills.js"
import { appendRepairLog, createLastStartWriter, lastStartPath } from "./last-start.js"
import { diagnosticFormat, previewRuntimeSnapshot } from "./preview-snapshot.js"
import { compactStatus } from "./status-compact.js"
import { GATE_WAIT_MS } from "./gate-wait.js"
import { inspectStateBranch, inspectWriteBranch, writeBranchProblem, repairStateBranch, runGit, stateBranchProblem, isStateBranchName, STATE_BRANCH_REPAIR } from "./state-branch.js"
import { removeReadinessLeftovers } from "../readiness/leftovers.js"
import { TOOL_NAMES } from "../tool-names.js"
import { EXACT } from "../util/file-identity.js"

const READ_TOOLS = new Set(["desk_search", "desk_recall", "desk_similar", "desk_timeline", "desk_thread"])
// Resolver sources, weakest first, in the shared resolver's order (util/paths.js). The host's project folder, when it is a desk,
// outranks the saved binding and $DESK; a bare launch folder (`hint`, reported as "host-project" too) stays below them, so losing an
// association never reselects it. Neither kind of folder replaces another of its kind.
const ROOT_SOURCE_PRIORITY = Object.freeze([
  "home_fallback", "overlay_home_fallback", "launch-folder", "env:DESK",
  "activation-config", "host-project", "host-session-root", "explicit-root",
])
const rootRank = (root) => ROOT_SOURCE_PRIORITY.indexOf(root.hint === true ? "launch-folder" : root.source)
// Every field desk_doctor reads off `input`: both are read by the
// `deskDoctor` function below, not by tools/doctor.js's `doctorRuntime`
// (the module server.js registers for this tool name) — `deskDoctor` is the
// session-layer dispatcher every desk_doctor call actually reaches first,
// and it forwards only `{ format }` on to `doctorRuntime`, never `repair`.
// Kept here, at module scope next to `deskDoctor`, so a field added to its
// reads is a field added here in the same diff.
// __tests__/tool_schema_parity.test.js checks this against the tool's
// declared schema in tool-schemas.js.
export const DESK_DOCTOR_FIELDS = ["format", "repair"]
const STATUS_WAIT_MS = 50
const STATUS_DETAIL_MS = 120
// The most desk_status spends on its own waits (a new admission attempt, then the runtime status), well inside the 200 ms it must answer in.
const STATUS_BUDGET_MS = 90
// How long one runtime status computation may run before desk_status stops waiting on it and starts another, so only a computation that is stuck (a filesystem read that never returns, say) is abandoned.
const STATUS_RUN_LIMIT_MS = 10000
// How many background attempts that start between a gated call's own admission check and its dispatch it joins before refusing.
const GATE_REJOINS = 3
const GATE_RETRY = Symbol("gate retry")
// How long task_focus waits for a session that is still admitting: short, because the call is a declaration, not work.
const FOCUS_WAIT_MS = 2000
const HEAD_DEBOUNCE_MS = 100
// How often the HEAD watch checks .git/HEAD. A HEAD change is noticed within this time plus the debounce.
const HEAD_POLL_MS = 500
// How long closing the session waits for a running admission attempt (Git in the desk, the runtime import) to finish, so a closed session has stopped touching the desk. Below the front door's shutdown limit, and bounded because an attempt can wait on something that never answers.
const DISPOSE_ADMISSION_WAIT_MS = 2000
// How long after start the session removes the folders older Desk versions' readiness controllers left (src/readiness/leftovers.js): late enough not to compete with admission.
const LEFTOVERS_DELAY_MS = 30000

// Launcher codes (--degraded) that still allow reads: write identity or the checkout state is unproven. Every other code is an integrity failure: the running code or its authority data cannot be trusted, so every data tool refuses.
export const LAUNCHER_READ_ONLY_CODES = Object.freeze([
  "crew_state_unavailable", "crew_state_not_main", "repository_mismatch", "authority_invalid",
  "identity_unavailable", "identity_not_emu", "identity_unregistered", "identity_ambiguous",
])

/**
 * The task this session's main agent declared it is working on, held in memory for the life of the session (module
 * state in the runtime pack can reset when the pack is reloaded; this closure cannot). `get()` is `{ track, slug }` or
 * null; `set(value)` replaces it (null clears) and counts as a declaration; `declared()` is false until the first one, so
 * the no-focus hint is repeated on task tool results until the session sets a focus or clears it on purpose. Never
 * written to disk: the transcript is the record.
 */
export function createFocusHolder() {
  let current = null
  let declared = false
  return {
    get: () => current,
    set(value) {
      current = value
      declared = true
    },
    declared: () => declared,
  }
}

/** What a tool needs from admission: "status", "doctor", "focus", "read", "search" or "write". */
export function toolRequirement(name) {
  if (name === "desk_status" || name === "desk_doctor") return name.slice(5)
  // Focus is held in this session and read from the card on disk: it needs the desk and the runtime, never write authority.
  if (name === "task_focus") return "focus"
  if (READ_TOOLS.has(name)) return "read"
  if (name === "desk_reindex") return "search"
  return "write"
}

/** Whether the admitted context meets a requirement. */
export function requirementMet(requirement, context) {
  if (context.resolutionFailed) return false
  if (context.launcher?.mode === "refuse") return false
  const readable = Boolean(context.runtimeServer && context.root)
  if (requirement === "read" || requirement === "focus") return readable
  if (requirement === "search") return readable && Boolean(context.search)
  const authorized = readable && context.authorityAdmitted === true
  if (requirement === "authority") return authorized
  return authorized && context.stateBranch?.ok !== false && !context.launcher?.blocksWrites
}

// The default HEAD watch polls .git/HEAD's metadata instead of watching the .git folder. A folder watch is closed synchronously on the event loop, and on macOS (FSEvents) closing one took from 0.5 s to over 2 s when a destination change dropped the old desk's watch, holding every desk_status call far past its 200 ms. Stopping a poll only stops a timer. Git replaces HEAD by renaming a lock file over it, and a poll by path follows each new file. Any change to HEAD's metadata is reported through the same callback a folder watch uses, and the admission refresh it starts is debounced.
// watchFile takes its first stat in the background, so a HEAD replaced before that stat would never be reported. The watch therefore takes its own baseline synchronously and, one interval later, reports a change if HEAD's inode or modification time no longer matches it.
export function watchGitHead(gitDir, options, listener) {
  const head = path.join(gitDir, "HEAD")
  const identity = () => {
    try {
      // Read as BigInts: a Windows file id can exceed 2^53, where a Number cannot tell the old HEAD from its replacement.
      const stats = statSync(head, EXACT)
      return `${stats.dev}:${stats.ino}:${stats.mtimeNs}`
    } catch {
      return "missing"
    }
  }
  const baseline = identity()
  const onChange = () => listener("change", "HEAD")
  watchFile(head, { persistent: options.persistent, interval: HEAD_POLL_MS }, onChange)
  const firstCheck = setTimeout(() => { if (identity() !== baseline) onChange() }, HEAD_POLL_MS)
  firstCheck.unref()
  return {
    close() {
      clearTimeout(firstCheck)
      unwatchFile(head, onChange)
    },
  }
}

/**
 * Build a session. `deps` carries everything index.js resolved or was given:
 * resolveInputs() (async; `{ root, activation }` or `{ rootError }` / `{ root, activationError }`), loadRuntime(activation) (async; `{ runtimeServer, runtimeStatus }` or `{ outcome }`), setupDiagnostic(error),
 * args, authorityProviders, readinessStateHome, deskStateDir, git, watch, timers, stderr, notifyToolsChanged, launcher.
 */
function switchFailureReason(snapshot) {
  const observed = snapshot.diagnostic?.observed
  return {
    summary: redactMachineText(snapshot.summary),
    ...(observed ? { diagnostic: { observed: {
      name: observed.name,
      message: redactMachineText(observed.message),
      ...(observed.failure_code ? { failure_code: observed.failure_code } : {}),
    } } } : {}),
  }
}

export function createDeskSession(deps) {
  const {
    args,
    authorityProviders = {},
    readinessStateHome,
    deskStateDir,
    git = runGit,
    watch = watchGitHead,
    timers,
    stderr = process.stderr,
    notifyToolsChanged = () => {},
    launcher = null,
    statusRunLimitMs = STATUS_RUN_LIMIT_MS,
    removeLeftovers = removeReadinessLeftovers,
    env = process.env,
    headIO = headFileSystem,
  } = deps
  const context = { pendingRepairs: [], exceptions: [], launcher, phase: null, search: null }
  const focus = createFocusHolder()
  let headWatch = null
  let headTimer = null
  let headBinding = null
  let headSample = null
  let headGeneration = 0
  const headDescriptors = new Set()
  let disposed = false
  let leftoversTimer = null
  // The latest runtime status detail, served (and marked cached) when a fresh one does not arrive within desk_status's budget. `at` is when its computation started and `seq` orders computations, so a detail is only ever replaced by a newer one.
  let lastStatusDetail = null
  // The one runtime status computation allowed at a time, so repeated desk_status calls on a slow machine never pile up work: `{ promise, at, started, seq }`. One older than statusRunLimitMs is abandoned in favor of a new one.
  let statusRun = null
  const statusReaders = new Set()
  let statusSeq = 0
  let contextGeneration = 0
  let resolvedInputs = null
  let resolvedOwnershipKey = null
  // Admission may resolve in parallel, but never replaces a destination while
  // an operation is using its authority, search engine, or write branch.
  let operationTail = Promise.resolve()

  function invalidateStatus() {
    contextGeneration += 1
    retireStatusRun(new Error("runtime status context ended"))
    statusRun = null
    lastStatusDetail = null
  }

  function retireStatusRun(reason) {
    if (!statusRun) return
    statusRun.controller.abort(reason)
    retainStatusReader(statusRun)
  }

  function retainStatusReader(run) {
    if (typeof run.runtimeServer.waitForStatusInspection === "function") statusReaders.add(run)
  }

  async function statusReaderOutcome() {
    const outcomes = await Promise.all([...statusReaders].map(async (run) => {
      try {
        await run.runtimeServer.waitForStatusInspection(run.signal)
        statusReaders.delete(run)
        return null
      } catch (error) {
        // Keep the captured runtime and signal: a failed deadline is not exit
        // proof, but a later real exit may release this exact owned reader.
        return error
      }
    }))
    return outcomes.find((error) => error !== null) ?? null
  }

  function operation(work) {
    let release
    const done = new Promise((resolve) => { release = resolve })
    const previous = operationTail
    operationTail = previous.then(() => done)
    return previous.then(() => work(release)).finally(release)
  }

  const log = (line) => stderr.write(`[desk-mcp] ${line}\n`)

  // Written in order without the event loop waiting on the disk, so a slow file create on Windows never delays a tool call; dispose waits for them.
  const lastStart = createLastStartWriter({
    onError: (error) => log(`could not record last-start.json in ${deskStateDir}: ${error.message}`),
  })

  function recordLastStart(snapshot) {
    if (disposed) return
    lastStart.record({ stateDir: deskStateDir, snapshot, root: context.root?.root ?? null })
  }

  const admission = createAdmission({
    context,
    timers,
    attempt: () => admitOnce(),
    revalidate: () => admitOnce(true),
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

  // Every search engine this session closed; dispose waits for them, so a closed session has released the engine's files and watcher.
  let searchClosed = Promise.resolve()
  function forgetSearch() {
    const engine = context.search
    context.search = null
    if (engine) searchClosed = Promise.all([searchClosed, Promise.resolve().then(() => engine.close()).catch(() => {})])
  }

  function forgetAuthority() {
    invalidateStatus()
    forgetSearch()
    context.authority = null
    context.person = null
    context.member = null
    context.authorityAdmitted = false
  }

  function forgetDesk() {
    forgetAuthority()
    closeHeadWatch()
    context.root = null
    context.stateBranch = null
    context.policyKey = null
    context.activation = null
    context.stateBranchName = null
  }

  // The automatic state-branch switch belongs to the session's first admission attempt only, whatever that attempt ends in (ready, any degraded state, or a throw). After it, only desk_doctor's switch_state_branch repair switches.
  async function admitOnce(revalidateOnly = false) {
    let outcome
    try {
      outcome = await admitAttempt(revalidateOnly)
    } catch (error) {
      await operationTail
      forgetDesk()
      context.resolutionFailed = true
      outcome = exceptionOutcome(error)
    } finally {
      context.startupDone = true
      context.phase = null
    }
    // A new root can finish in the same state as the previous root, without a
    // state transition. Its own start record must still receive the outcome.
    if (outcome !== null) {
      const ready = outcome.state === "ready"
      recordLastStart({
        ...admission.snapshot(),
        state: ready ? "ready" : `degraded:${outcome.code}`,
        code: ready ? null : outcome.code,
        fix: ready ? null : outcome.fix ?? null,
        repair: outcome.repair ?? admission.snapshot().repair,
      })
    }
    return outcome
  }

  // Where the running admission attempt is, for desk_status: a stuck start names its step instead of only "admitting".
  function setPhase(name) {
    context.phase = { name, since: new Date().toISOString() }
  }

  async function admitAttempt(revalidateOnly) {
    const repairs = context.pendingRepairs.splice(0)
    const headTriggered = context.headTriggered === true
    context.headTriggered = false
    if (launcher?.mode === "refuse") return launcherRefusedOutcome(launcher)

    setPhase("resolving_inputs")
    const inputs = await deps.resolveInputs()
    await operationTail
    if (disposed) return null
    if (inputs.rootError) {
      forgetDesk()
      context.resolutionFailed = true
      return rootOutcome(inputs.rootError, deps)
    }
    // Losing proof of intent is not permission to reselect a launch folder.
    // Keep the previous resolved intent through refusals, until renewed or
    // replaced by an association of at least its strength.
    if (resolvedInputs && resolvedInputs.root.root !== inputs.root.root) {
      const previousPriority = rootRank(resolvedInputs.root)
      const incomingPriority = rootRank(inputs.root)
      // A home guess never replaces an established root, a weaker source never replaces a stronger one, and one folder never replaces another of its kind.
      if (incomingPriority <= 1 || incomingPriority < previousPriority ||
          inputs.root.source === "host-project" && incomingPriority === previousPriority) {
        forgetDesk()
        context.resolutionFailed = true
        return rootOutcome({
          code: "DESK_ROOT_UNAVAILABLE",
          path: resolvedInputs.root.root,
          message: "The established workspace intent is no longer proven; Desk will not select a different destination from weaker context.",
        }, deps)
      }
    }
    const ownershipKey = (value) => JSON.stringify({
      root: value.root.root,
      activation: value.activation,
      person: args.person ?? null,
      member: value.member ?? null,
    })
    const key = ownershipKey(inputs)
    const unchanged = !context.resolutionFailed && resolvedOwnershipKey === key
    if (revalidateOnly && unchanged) {
      context.root = inputs.root
      resolvedInputs = inputs
      return null
    }
    if (!unchanged) invalidateStatus()
    context.resolutionFailed = false
    const newRoot = context.root?.root !== inputs.root.root
    if (newRoot && resolvedInputs !== null && resolvedInputs.root.root !== inputs.root.root) focus.set(null)
    if (newRoot) forgetDesk()
    context.root = inputs.root
    // The root's own start record begins with the state it is in now (admitting, on the first attempt), not only with the next change.
    if (newRoot) recordLastStart({ ...admission.snapshot(), state: "admitting", code: null, fix: null })
    const deskRoot = inputs.root.root
    if (inputs.activationError) {
      forgetAuthority()
      context.activation = null
      context.resolutionFailed = true
      return activationOutcome(inputs.activationError)
    }
    const activation = inputs.activation
    const policyKey = JSON.stringify(activation.readinessPolicy)
    const personInput = JSON.stringify({ person: args.person ?? null, member: inputs.member ?? null })
    if (context.policyKey !== policyKey || context.personInput !== personInput) forgetAuthority()
    context.policyKey = policyKey
    context.personInput = personInput
    context.activation = activation.activationStatus
    context.stateBranchName = activation.stateBranch
    resolvedInputs = inputs
    resolvedOwnershipKey = key
    const policy = activation.readinessPolicy

    if (!context.runtimeServer) {
      setPhase("loading_runtime")
      const loaded = await deps.loadRuntime(activation, { onPhase: setPhase })
      if (disposed) return null
      if (loaded.outcome) return loaded.outcome
      context.runtimeServer = loaded.runtimeServer
      context.runtime = loaded.runtimeStatus
    }

    // The automatic switch runs only during the first admission attempt, and never for a HEAD change the watch saw.
    const startup = !context.startupDone && !headTriggered
    let branchProblem = null
    setPhase("inspecting_state_branch")
    // Discover only the authoritative location before the first observation.
    // The branch inspection below must be enclosed by two certain samples,
    // including the first admission, not blessed by a later first baseline.
    if (headBinding === null && isStateBranchName(activation.stateBranch)) {
      const located = await git({ cwd: deskRoot, args: ["rev-parse", "--show-toplevel", "--absolute-git-dir"] })
      if (disposed) return null
      if (located.ok) {
        const [, gitDir] = located.stdout.split(/\r?\n/u)
        if (typeof gitDir === "string") bindHead(gitDir)
      }
    }
    let observedHead = headBinding === null ? null : await sampleHead(headBinding)
    let inspection = await inspectStateBranch({ root: deskRoot, branch: activation.stateBranch, git })
    if (disposed) return null
    if (!inspection.ok && inspection.automatic && startup) {
      const repaired = await repairStateBranch({ inspection, git })
      if (repaired.repaired) {
        repairs.push(recordRepair(repaired.line))
        // The owned startup switch intentionally changed HEAD. Enclose the
        // final post-repair Git inspection in its own fresh interval.
        observedHead = headBinding === null ? null : await sampleHead(headBinding)
        inspection = await inspectStateBranch({ root: deskRoot, branch: activation.stateBranch, git })
      } else {
        branchProblem = stateBranchProblem(inspection, { failedRepair: repaired, automatic: startup })
      }
    }
    if (!inspection.ok && branchProblem === null) branchProblem = stateBranchProblem(inspection, { automatic: startup })
    const checkedHead = await watchHead(inspection.gitDir, observedHead?.certain === true)
    if (disposed || context.root?.root !== deskRoot) return null
    if (checkedHead !== null && (!checkedHead.certain || !observedHead?.certain ||
        observedHead.identity !== checkedHead.identity)) {
      inspection = { ...inspection, ok: false }
      branchProblem = headUncertainOutcome()
      if (checkedHead.certain && headBinding !== null) {
        signalHead(headBinding, { certain: false, reason: "head_changed_during_inspection" })
      }
    }
    context.stateBranch = inspection

    setPhase("admitting_authority")
    if (!context.authorityAdmitted) {
      const refused = await admitAuthority(policy, inputs.member ?? null)
      if (disposed) return null
      if (refused) {
        // A Crew workspace session with no member still reads, so its search starts.
        if (refused.code === MEMBER_UNKNOWN && !context.search) startSearch(deskRoot, policy)
        return { ...refused, repair: repairs.at(-1) }
      }
    }
    const searchProblem = context.search ? null : startSearch(deskRoot, policy)

    const repair = repairs.at(-1)
    if (launcher?.blocksWrites) return { ...launcherReadOnlyOutcome(launcher), repair }
    if (branchProblem !== null) return { state: "degraded", ...branchProblem, repair }
    if (searchProblem !== null) return { ...searchProblem, repair }
    // A signal can revoke this inspection while authority work is
    // awaited. Only the queued, fresh Git attempt may restore readiness.
    if (context.stateBranch.ok === false) return { state: "degraded", ...headUncertainOutcome(), repair }
    return { state: "ready", repair }
  }

  // Write authority. Resolves with a degraded outcome when it is refused, else null. Tests replace the check through the runtime's `verifyAuthority`.
  async function admitAuthority(policy, member) {
    setPhase("verifying_authority")
    // In a Crew workspace with no authority provider, the person is the session's member (crew-member.js), under either policy.
    // The last settled member stays reported while a recheck settles again.
    if (policy.authority_provider === null && member?.crew === true) {
      context.member ??= member
      return admitMember(policy, member)
    }
    // Only a person that came from the member resolution is reported as such (desk_status's write_scope.source).
    context.member = null
    const verify = context.runtimeServer.verifyAuthority ?? verifyAdmissionAuthority
    const authorityProvider = policy.authority_provider === null ? null : authorityProviders[policy.authority_provider]
    try {
      const authority = await verify({ deskRoot: context.root.root, person: args.person ?? null, policy, authorityProvider })
      if (disposed) return null
      context.person = validateAdmissionAuthority({ authority, person: args.person ?? null, policy })
      context.authority = authority
      context.authorityAdmitted = true
      return null
    } catch (error) {
      return admissionOutcome(error)
    }
  }

  // The member's own desk becomes the write prefix; no member leaves the session read-only with one plain message.
  async function admitMember(policy, local) {
    let member
    let message
    try {
      // Loaded here, not at the top: index.js imports this module, and everything it loads before the handshake must stay loadable on an old Node.
      const { memberMessage, settleMember } = await import("../desk/crew-member.js")
      member = await settleMember(local, { deskRoot: context.root.root, env })
      message = memberMessage(member)
    } catch (error) {
      return exceptionOutcome(error)
    }
    if (disposed) return null
    context.member = member
    if (member.person === null) return memberUnknownOutcome(member, message)
    const authority = Object.freeze({ mode: "person", person: member.person })
    try {
      context.person = validateAdmissionAuthority({ authority, policy: { ...policy, write_authority: "person" } })
    } catch (error) {
      return admissionOutcome(error)
    }
    context.authority = authority
    context.authorityAdmitted = true
    return null
  }

  // The session's search engine, in this process. A failure never takes reads or writes away: searches read the files directly, and the next attempt starts it again.
  function startSearch(deskRoot, policy) {
    setPhase("starting_search")
    let engine
    try {
      engine = context.runtimeServer.createSearchEngine({ deskRoot, semantic: policy.semantic })
    } catch (error) {
      return searchUnavailableOutcome(error)
    }
    context.search = engine
    const generation = contextGeneration
    // Its first read of the desk starts on a later turn of the event loop, so that read's first synchronous stretch never joins the transition to ready in one block.
    setImmediate(() => {
      if (disposed || generation !== contextGeneration || context.search !== engine) return
      try {
        engine.warm()
      } catch (error) {
        log(`search warm-up failed: ${describe(error)}`)
      }
    })
    return null
  }

  const headUncertainOutcome = () => exceptionOutcome(new Error("HEAD freshness is unverified; authoritative Git inspection must settle a current observation"))
  const currentHead = binding => !disposed && headBinding === binding && binding.generation === headGeneration
  // Stats are read as BigInts (EXACT): a Windows file id can exceed 2^53, where Numbers cannot tell a file from its replacement.
  const statIdentity = stat => [stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink].join(":")
  async function readHead(binding) {
    let descriptor = null
    try {
      const rootBefore = await headIO.lstat(binding.root, EXACT)
      const dirBefore = await headIO.lstat(binding.gitDir, EXACT)
      if (!rootBefore.isDirectory() || rootBefore.isSymbolicLink() || !dirBefore.isDirectory() || dirBefore.isSymbolicLink())
        throw new Error("head_destination")
      const destination = [rootBefore.dev, rootBefore.ino, dirBefore.dev, dirBefore.ino].join(":")
      if (binding.destination !== null && binding.destination !== destination) throw new Error("head_destination_changed")
      const file = path.join(binding.gitDir, "HEAD")
      const before = await headIO.lstat(file, EXACT)
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.size > 4096n) throw new Error("head_file")
      if (!currentHead(binding)) throw new Error("head_cancelled")
      const handle = await headIO.open(file, headConstants.O_RDONLY | headConstants.O_NOFOLLOW)
      descriptor = { handle }; headDescriptors.add(descriptor)
      if (!currentHead(binding)) throw new Error("head_cancelled")
      if (statIdentity(await handle.stat(EXACT)) !== statIdentity(before)) throw new Error("head_replaced")
      const bytes = Buffer.alloc(4097)
      let length = 0
      while (length < bytes.length) {
        const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      if (length > 4096 || BigInt(length) !== before.size) throw new Error("head_size")
      if (statIdentity(await handle.stat(EXACT)) !== statIdentity(before) ||
          statIdentity(await headIO.lstat(file, EXACT)) !== statIdentity(before)) throw new Error("head_replaced")
      const rootAfter = await headIO.lstat(binding.root, EXACT), dirAfter = await headIO.lstat(binding.gitDir, EXACT)
      if ([rootAfter.dev, rootAfter.ino, dirAfter.dev, dirAfter.ino].join(":") !== destination ||
          !rootAfter.isDirectory() || rootAfter.isSymbolicLink() || !dirAfter.isDirectory() || dirAfter.isSymbolicLink())
        throw new Error("head_destination_changed")
      if (!currentHead(binding)) throw new Error("head_cancelled")
      binding.destination = destination
      return { certain: true, identity: `${destination}:${statIdentity(before)}:${createHash("sha256").update(bytes.subarray(0, length)).digest("hex")}` }
    } catch (error) {
      return { certain: false, reason: error.code ?? error.message }
    } finally {
      if (descriptor !== null) {
        // Forget the descriptor even when close fails, so one failed close
        // degrades this sample only and never leaves later samples pending.
        headDescriptors.delete(descriptor)
        try {
          await descriptor.handle.close()
        } catch {
          return { certain: false, reason: "head_close_failed" }
        }
      }
    }
  }
  async function sampleHead(binding) {
    // A timeout is a freshness result, not cancellation of kernel work. One
    // retained operation globally prevents overlap even across root rebinding.
    if (headSample !== null || headDescriptors.size !== 0) return { certain: false, reason: "head_sample_pending" }
    const pending = readHead(binding)
    headSample = pending
    let budget
    const timeout = new Promise(resolve => {
      budget = setTimeout(() => resolve({ certain: false, reason: "head_sample_budget" }), 500)
      budget.unref?.()
    })
    // No new sample may replace this owner before its finalizer settles.
    pending.finally(() => { headSample = null }).catch(() => {})
    try { return await Promise.race([pending, timeout]) }
    finally { clearTimeout(budget) }
  }
  function signalHead(binding, observation) {
    // Callers fence awaited observations and native callbacks; closeHeadWatch
    // cancels both session-owned timers before replacing this binding.
    const key = observation.certain ? observation.identity : `uncertain:${observation.reason}`
    if (binding.signal === key) return
    binding.signal = key
    binding.dirty = true
    context.headTriggered = true
    invalidateStatus()
    if (context.stateBranch) context.stateBranch = { ...context.stateBranch, ok: false }
    if (admission.snapshot().state === "ready") admission.fail(headUncertainOutcome())
    requestHead(binding)
  }
  function requestHead(binding) {
    if (!currentHead(binding) || binding.request !== null) return
    binding.request = Promise.resolve().then(async () => {
      while (currentHead(binding) && binding.dirty) {
        binding.dirty = false
        context.headTriggered = true
        await admission.refresh({ force: true, waitMs: 1000 })
        while (currentHead(binding) && admission.running) await admission.idle({ waitMs: 1000 })
      }
    }).catch(error => { if (currentHead(binding)) admission.fail(exceptionOutcome(error)) })
      .finally(() => { binding.request = null })
  }
  function reconcileHead(binding) {
    binding.resample = true
    if (binding.observing) return binding.observing
    binding.observing = Promise.resolve().then(async () => {
      while (currentHead(binding) && binding.resample) {
        binding.resample = false
        // Native delivery is a hint, not a failed read. Wait for the one
        // existing owner rather than manufacturing uncertainty or overlap.
        if (headSample !== null) await headSample
        if (!currentHead(binding)) break
        const observed = await sampleHead(binding)
        if (!currentHead(binding)) break
        if (!observed.certain || observed.identity !== binding.verified) signalHead(binding, observed)
      }
    }).catch(error => { if (currentHead(binding)) admission.fail(exceptionOutcome(error)) })
      .finally(() => { binding.observing = null })
    return binding.observing
  }
  function armHead(binding) {
    if (!currentHead(binding) || binding.timer !== null) return
    if (headSample !== null) {
      if (!binding.awaitingSample) {
        binding.awaitingSample = true
        headSample.finally(() => {
          binding.awaitingSample = false
          armHead(binding)
        }).catch(() => {})
      }
      return
    }
    binding.timer = setTimeout(async () => {
      binding.timer = null
      await reconcileHead(binding)
      armHead(binding)
    }, 1000)
    binding.timer.unref?.()
  }
  function bindHead(gitDir) {
    if (headBinding === null || headBinding.gitDir !== gitDir || headBinding.root !== context.root.root) {
      closeHeadWatch()
      headBinding = { generation: ++headGeneration, root: context.root.root, gitDir, destination: null,
        verified: null, signal: null, dirty: false, request: null, timer: null }
    }
    return headBinding
  }
  async function watchHead(gitDir, previousCertain) {
    if (disposed) return null
    if (typeof gitDir !== "string") {
      if (previousCertain) {
        closeHeadWatch()
        return null
      }
      if (headBinding !== null) {
        // A failed Git location is not "not a checkout" permission after
        // an observed destination/HEAD uncertainty.
        return { certain: false, reason: "head_location_unknown" }
      }
      return null
    }
    let binding = bindHead(gitDir)
    let observation = await sampleHead(binding)
    if (observation.reason === "head_destination_changed" && currentHead(binding)) {
      // This is reached only after the current authoritative Git inspection.
      // Same spelling is not same destination; discard old callbacks/timers.
      closeHeadWatch()
      headBinding = { generation: ++headGeneration, root: context.root.root, gitDir, destination: null,
        verified: null, signal: null, dirty: false, request: null, timer: null }
      binding = headBinding
      observation = await sampleHead(binding)
    }
    if (!currentHead(binding)) return null
    if (observation.certain) {
      binding.verified = observation.identity
      binding.signal = observation.identity
    } else signalHead(binding, observation)
    armHead(binding)
    if (headWatch?.gitDir === gitDir) return observation
    try {
      const watcher = watch(gitDir, { persistent: false }, () => {
        if (!currentHead(binding)) return
        if (headTimer !== null) clearTimeout(headTimer)
        headTimer = setTimeout(() => {
          headTimer = null
          reconcileHead(binding)
        }, HEAD_DEBOUNCE_MS)
        headTimer.unref?.()
      })
      headWatch = { gitDir, watcher }
    } catch (error) {
      log(`could not watch ${gitDir} for HEAD changes: ${error.message}`)
    }
    return observation
  }

  function closeHeadWatch() {
    headGeneration += 1
    if (headBinding?.timer !== null) clearTimeout(headBinding?.timer)
    headBinding = null
    if (headTimer !== null) { clearTimeout(headTimer); headTimer = null }
    headWatch?.watcher.close()
    headWatch = null
  }

  // `search` null leaves the search engine out: a write then changes only its files, which the engine's watcher or next read picks up.
  function statusContext(search) {
    return {
      root: context.root,
      activation: context.activation,
      runtime: context.runtime,
      member: context.member ?? null,
      focus,
      search,
    }
  }

  function runtimeCall(name, input, signal, search = context.search) {
    return context.runtimeServer.callTool({
      deskRoot: context.root.root,
      name,
      input,
      person: context.person ?? null,
      statusContext: statusContext(search),
      signal,
    })
  }

  async function callTool({ name, input = {}, signal }) {
    if (!TOOL_NAMES.includes(name)) {
      return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true }
    }
    // A hosted Desk refuses before anything runs, so a refused repair or tool never reaches an implementation.
    const hostedRefused = hostedRefusal(name, input, env)
    if (hostedRefused !== null) return { content: [{ type: "text", text: JSON.stringify(hostedRefused) }], isError: true }
    try {
      if (disposed) return pendingRefusal(name)
      if (name === "desk_status") return await deskStatus(input, signal)
      if (name === "desk_skill") return deskSkill(input, { env })
      if (name === "desk_doctor" && !context.root) return await deskDoctor(input, signal)
      const waitMs = name === "task_focus" ? deps.focusWaitMs ?? FOCUS_WAIT_MS : GATE_WAIT_MS
      // A background attempt (a .git/HEAD change, a retry on the backoff) can start after this call's own
      // attempt settled and before its turn to dispatch. Never dispatch across it: join it and gate again, a
      // bounded number of times and only while the call's wait budget lasts, instead of refusing a call that
      // arrived while the session was admitted. The budget bounds the waits on admission; waiting for earlier
      // operations to finish (operation()) is not counted against it, as before.
      const deadline = Date.now() + waitMs
      let budget = waitMs
      for (let gate = 0; ; gate += 1) {
        await admission.refresh({
          waitMs: budget,
          // A running status/HEAD attempt may have sampled context before this
          // operation arrived. Join its completion, then resolve inputs anew.
          // A rejoin only joins: the first gate's request stays queued, so a check that started after this call arrived always completes before dispatch. Asking for another
          // fresh sample there made calls that arrive together rejoin in turn, each reading the other's
          // revalidation as a background attempt, until one ran out of rejoins and was refused.
          fresh: gate === 0,
          revalidateOnly: name === "desk_doctor" || requirementMet(toolRequirement(name), context),
        })
        const result = await operation((release) => {
          if (!disposed && admission.running && gate < GATE_REJOINS) return GATE_RETRY
          if (disposed || admission.running) return pendingRefusal(name)
          return dispatch(name, input, signal, release)
        })
        if (result !== GATE_RETRY) return result
        budget = deadline - Date.now()
        // No budget left: refuse now rather than queue another revalidation.
        if (budget <= 0) return pendingRefusal(name)
      }
    } catch (error) {
      return toolException(name, error)
    }
  }

  function pendingRefusal(name) {
    return degradedResult(name, {
      state: admission.snapshot().state,
      code: "admitting",
      fix: "Desk is still admitting or verifying this session's destination in the background. Call desk_status, then retry; no operation was dispatched.",
    }, REQUIREMENT_TEXT[toolRequirement(name)] ?? "a verified desk destination")
  }

  async function dispatch(name, input, signal, release) {
    const requirement = toolRequirement(name)
    if (requirement === "doctor") return deskDoctor(input, signal, release)
    // A focus call needs the runtime and a root, never a write: while Desk is still admitting it waits a short, bounded time, like the read tools, then refuses.
    if (requirement === "focus") {
      return requirementMet(requirement, context) ? runtimeCall(name, input, signal, null) : refusal(name, requirement)
    }
    if (!requirementMet(requirement, context)) return refusal(name, requirement)
    if (requirement === "write") return write(name, input, signal)
    return runtimeCall(name, input, signal)
  }

  // Right before a write, HEAD must still be on the state branch; it can move under a ready session.
  async function write(name, input, signal) {
    const inspection = await inspectStateBranch({ root: context.root.root, branch: context.stateBranchName, git })
    if (!inspection.ok) {
      context.stateBranch = inspection
      context.headTriggered = true
      admission.refresh({ force: true, waitMs: 0 })
      return refusal(name, "write")
    }
    // With no state branch configured, the checkout still has to be on a branch Desk may write on: refuse before any tool touches a file.
    const branch = await inspectWriteBranch({ root: context.root.root, branch: context.stateBranchName, git })
    if (!branch.ok) {
      return degradedResult(name, { ...admission.snapshot().diagnostic, state: admission.snapshot().state, ...writeBranchProblem(branch) }, REQUIREMENT_TEXT.write)
    }
    return runtimeCall(name, input, signal)
  }

  function refusal(name, requirement) {
    const snapshot = admission.snapshot()
    let { code, fix, blockers } = snapshot
    if (launcher?.mode !== "refuse" && requirement === "write" && context.stateBranch?.ok === false) {
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
    // desk_status must answer at once whatever admission is doing: it starts or joins an attempt but waits only briefly for it, and the whole answer shares one time budget.
    const deadline = Date.now() + STATUS_BUDGET_MS
    // An attempt that was already running (a slow restore, the import of the runtime) is joined, not waited on.
    await admission.refresh({ waitMs: STATUS_WAIT_MS, joinMs: 0 })
    const snapshot = statusSnapshot()
    let payload = baseDiagnostic(snapshot)
    // The admission state the payload is stamped with. A detail computed by this very call is read after `snapshot` was taken, so it can describe a session that was still admitting when admission reaches ready a moment later; stamping it with the later state would report ready next to detail from before it. It is stamped with the state it was computed under instead, and the next call reports the newer one.
    let stamped = null
    let detailFrom = null
    if (context.runtimeServer && context.root && !context.resolutionFailed && launcher?.mode !== "refuse") {
      // A computation that is still running and not yet stuck is joined; otherwise this call starts a new one. Either way the call waits only for what is left of its own budget.
      const joined = statusRun !== null && Date.now() - statusRun.started < statusRunLimitMs
      const run = joined ? statusRun : startStatusRun(input, signal)
      const outcome = await raceWithTimer(run.promise, Math.max(0, Math.min(STATUS_DETAIL_MS, deadline - Date.now())))
      if (run.generation !== contextGeneration) {
        payload = { ...baseDiagnostic(statusSnapshot()), detail_pending: true,
          status_detail: "unavailable: the desk destination changed while this call ran, so its runtime status detail no longer applies; call desk_status again shortly" }
      } else if (!outcome.timedOut && outcome.value.error !== undefined) {
        const error = outcome.value.error
        payload = { ...payload, status_error: error instanceof Error ? error.message : String(error) }
      } else if (!outcome.timedOut && joined) {
        // The joined computation answered in time, but it started before this call, so its detail is marked with when it started.
        payload = { ...outcome.value.payload, status_detail: `cached: this detail comes from a runtime status computation (search and index) that was already running when this call arrived; it started at ${run.at}.`, status_detail_from: run.at }
        detailFrom = run.at
      } else if (!outcome.timedOut) {
        payload = outcome.value.payload
        detailFrom = run.at
        stamped = snapshot
      } else {
        const why = joined
          ? `a runtime status computation (search and index) that started at ${run.at} is still running`
          : "the runtime status (search and index) did not answer within this call's budget"
        // The session admitted this root before the runtime's status was asked for it, so the answer names the desk even though the rest of the detail is not loaded yet.
        payload = lastStatusDetail === null
          ? { ...payload, detail_pending: true, root: { path: context.root.root, source: context.root.source }, status_detail: `unavailable: ${why}; call desk_status again shortly` }
          : { ...lastStatusDetail.payload, status_detail: `cached: ${why}; this detail is from ${lastStatusDetail.at} (${ageSeconds(lastStatusDetail.at)} s old). Call desk_status again shortly for a fresh one.`, status_detail_from: lastStatusDetail.at }
        detailFrom = lastStatusDetail?.at ?? null
      }
    }
    if (admission.running && snapshot.state === "ready" && context.phase?.name === "resolving_inputs" &&
        !context.resolutionFailed) {
      // No root is named either: the destination is the very thing being verified.
      payload = detailFrom === null
        ? { ...payload, detail_pending: true, root: undefined,
          status_detail: "unavailable: no completed same-context runtime detail; destination verification is pending. Call desk_status again shortly." }
        : { ...payload, status_detail_from: detailFrom,
          status_detail: `${payload.status_detail ?? "cached: this detail belongs to the currently admitted context."} Destination verification is pending; this detail is not permission to dispatch an operation.` }
    }
    // Search status comes straight from the session's search engine, which answers at once. The runtime status run
    // also carries it, but on a large desk that run rarely finishes within this call's budget.
    if (context.search) payload = { ...payload, search: context.search.searchStatus() }
    const full = withAdmission(payload, stamped ?? statusSnapshot())
    // Compact unless asked: the full payload is tens of KB, and an agent only wants "ready or not, and what do I do".
    return jsonResult(input?.detail === true ? full : compactStatus(full))
  }

  function statusSnapshot() {
    const snapshot = admission.snapshot()
    if (admission.running && snapshot.code === "no_desk_root") {
      // A retry may have new host evidence while the last settled outcome is
      // still no-root. Report the pending attempt, not obsolete setup advice.
      const summary = "Desk is admitting this session's destination; operations wait for verification."
      return {
        ...snapshot, state: "admitting", code: null, summary,
        fix: "Call desk_status again after admission completes.",
        diagnostic: {
          mode: "admitting", summary,
          ...(context.root && !context.resolutionFailed
            ? { root: { path: context.root.root, source: context.root.source } } : {}),
        },
      }
    }
    return admission.running && snapshot.state === "ready" &&
      (context.phase?.name !== "resolving_inputs" || context.resolutionFailed)
      ? { ...snapshot, state: "admitting", code: null, diagnostic: null,
        summary: "Desk is verifying this session's destination; operations wait for resolution.",
        fix: "Call desk_status, then retry once destination verification completes." }
      : snapshot
  }

  // Starts a runtime status computation. Its detail is kept even when it arrives after the call that started it has answered, so the next call serves it, marked cached with when it was computed. An abandoned computation that finishes late never replaces a detail from a newer one.
  function startStatusRun(input, signal) {
    retireStatusRun(new Error("runtime status run exceeded its lifetime"))
    const run = { at: new Date().toISOString(), started: Date.now(), seq: (statusSeq += 1), generation: contextGeneration,
      controller: new AbortController(), runtimeServer: context.runtimeServer }
    run.signal = signal ? AbortSignal.any([signal, run.controller.signal]) : run.controller.signal
    // Capture before the asynchronous status call yields to a new admission.
    const request = {
      deskRoot: context.root.root, name: "desk_status", input, person: context.person ?? null,
      statusContext: statusContext(context.search),
      signal: run.signal,
    }
    const runtimeServer = context.runtimeServer
    run.promise = Promise.resolve()
      .then(statusReaderOutcome)
      .then((retirementError) => {
        if (retirementError) throw retirementError
        run.signal.throwIfAborted()
        return runtimeServer.callTool(request)
      })
      .then((value) => {
        const payload = JSON.parse(value.content[0].text)
        // A runtime status that failed is an error, not a detail: served as a detail it reads as a ready answer with no root.
        if (value.isError) throw new Error(payload.message ?? value.content[0].text)
        if (!disposed && run.generation === contextGeneration &&
            (lastStatusDetail === null || lastStatusDetail.seq < run.seq)) lastStatusDetail = { payload, at: run.at, seq: run.seq }
        return { payload }
      })
      .catch((error) => ({ error }))
      .finally(() => {
        retainStatusReader(run)
        if (statusRun === run) statusRun = null
      })
    statusRun = run
    return run
  }

  function ageSeconds(at) {
    return Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000))
  }

  // `promise` never rejects: a status run settles with its payload or its error.
  function raceWithTimer(promise, ms) {
    let timer
    return Promise.race([
      promise.then((value) => ({ value })),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ timedOut: true }), ms)
        timer.unref?.()
      }),
    ]).finally(() => clearTimeout(timer))
  }

  async function deskDoctor(input, signal, release) {
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
    if (input.repair === STATE_BRANCH_REPAIR) return switchStateBranch(release)
    const snapshot = statusSnapshot()
    let payload = baseDiagnostic(snapshot)
    if (context.runtimeServer && context.root && !context.resolutionFailed && launcher?.mode !== "refuse") {
      payload = JSON.parse((await runtimeCall("desk_doctor", { format }, signal)).content[0].text)
    }
    return jsonResult({
      ...withAdmission(payload, snapshot),
      repairs_available: DOCTOR_REPAIRS,
    })
  }

  async function switchStateBranch(release) {
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
    release()
    const snapshot = await admission.refresh({ force: true, waitMs: GATE_WAIT_MS })
    // When admission after the switch is not ready, say why. The answer is often pasted into a public report, so it
    // carries only the error's name, message and code, with credentials and machine paths redacted; desk_status
    // {detail:true} keeps the full diagnostic.
    const why = snapshot.state === "ready" ? {} : switchFailureReason(snapshot)
    return jsonResult({ status: "ok", repair: repaired.line, state: snapshot.state, code: snapshot.code, fix: snapshot.fix, ...why })
  }

  // After the handshake, an exception nothing else caught (index.js's process handlers report it here): record it, keep serving, and re-admit on the backoff.
  function recordException(kind, error) {
    const message = error instanceof Error ? error.message : String(error)
    context.exceptions = [...context.exceptions, { at: new Date().toISOString(), kind, message }].slice(-5)
    if (disposed) {
      log(`caught ${kind} during shutdown: ${message}`)
      return
    }
    log(`caught ${kind} after the handshake: ${message}; Desk keeps serving and re-admits`)
    // The search engine runs in this process and may be what failed: re-admission starts a new one.
    forgetSearch()
    return admission.fail({
      code: "runtime_exception",
      summary: `Desk caught an unexpected ${kind.replace("_", " ")} after the handshake: ${message}`,
      fix: `Desk kept serving and re-admits in the background (call desk_status to retry now); no restart is needed. If it repeats, call desk_doctor and report the message: ${message}`,
      diagnostic: { mode: "degraded", observed: { kind, message } },
    })
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
        // The session's first admission is still running (no attempt has settled yet): every tool call waits for it, so the compact answer says Desk is still starting. A re-check of an admitted desk is not a start.
        starting: !disposed && admission.snapshot().state === "admitting",
        summary: snapshot.summary,
        blockers: snapshot.blockers,
        attempts: snapshot.attempts,
        failures: snapshot.failures,
        since: snapshot.since,
        next_retry_at: snapshot.next_retry_at,
        phase: context.phase?.name ?? null,
        phase_since: context.phase?.since ?? null,
        state_branch: branchSummary(context.stateBranch),
        search: context.search ? "started" : "not_started",
        writes: !disposed && !admission.running && requirementMet("write", context) ? "available" : "refused",
        exceptions: context.exceptions,
        launcher: launcher === null ? null : { code: launcher.code, reason: launcher.reason, mode: launcher.mode },
        last_start: lastStartPath({ stateDir: deskStateDir, root: context.root?.root ?? null }),
        // Milliseconds from this process's start to its first tools/list answer, or null before it: the host's wait for Desk's tools.
        handshake_ms: deps.handshakeMs?.() ?? null,
      },
    }
  }

  recordLastStart(admission.snapshot())

  // Older Desk versions ran a readiness controller that kept a folder per desk under readinessStateHome. Desk no longer creates them; older versions still running may.
  function scheduleLeftoverRemoval() {
    if (typeof readinessStateHome !== "string" || leftoversTimer !== null) return
    leftoversTimer = setTimeout(() => {
      void Promise.resolve().then(() => removeLeftovers({ stateHome: readinessStateHome }))
        .then((result) => { if (result.removed > 0) log(`removed ${result.removed} folder(s) older Desk versions' readiness controllers left in ${readinessStateHome}`) })
        .catch((error) => log(`could not remove old readiness folders in ${readinessStateHome}: ${describe(error)}`))
    }, deps.leftoversDelayMs ?? LEFTOVERS_DELAY_MS)
    leftoversTimer.unref?.()
  }

  return {
    admission,
    context,
    callTool,
    recordException,
    start: () => {
      scheduleLeftoverRemoval()
      return admission.start()
    },
    /** Resolves once every start record so far is written. For tests that read a record right after a state change; dispose waits on the writer itself. */
    lastStartWritten: () => lastStart.written(),
    dispose() {
      disposed = true
      invalidateStatus()
      const attempt = admission.dispose()
      clearTimeout(leftoversTimer)
      closeHeadWatch()
      let attemptTimer
      const attemptStopped = Promise.race([
        attempt,
        new Promise((resolve) => { attemptTimer = setTimeout(resolve, deps.disposeAdmissionWaitMs ?? DISPOSE_ADMISSION_WAIT_MS) }),
      ]).finally(() => clearTimeout(attemptTimer))
      // The search engine closes as soon as operations, the pending HEAD sample and status readers are done, alongside the
      // attempt wait, so the front door's shutdown limit is never spent waiting for admission first. The retained HEAD
      // sample closes and forgets its own descriptor in its finally, so after it settles nothing can throw before the
      // engine is released.
      const retired = Promise.all([operationTail, headSample, statusReaderOutcome()]).then(([, , retirementError]) => {
        forgetSearch()
        return retirementError
      })
      return Promise.all([retired, attemptStopped, lastStart.written()]).then(async ([retirementError]) => {
        // An attempt that finished during the attempt wait may have started an engine after disposal began.
        forgetSearch()
        await searchClosed
        if (retirementError) throw retirementError
      })
    },
  }
}

const STATUS_BY_STATE = { no_desk_root: "setup_required" }
const REQUIREMENT_TEXT = {
  read: "the desk root and the Desk runtime",
  focus: "the desk root and the Desk runtime",
  search: "the session's search engine",
  write: "admitted write authority and the checkout on its state branch",
}
const SEARCH_FIX = "Desk serves reads and writes without its search engine (exact-word search and timeline read the files directly) and starts it again in the background after 1, 2, 5, 10 and 30 s, then every 60 s. Call desk_status to retry now; only desk_reindex waits for the search engine, and recall answers with exact-word matches until it starts."
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
  return {
    state: "degraded",
    code: "root_unavailable",
    summary: `The bound desk root is unavailable, and Desk does not fall back to another desk: ${describe(error)}`,
    fix: rootUnavailableFix(error),
    diagnostic: { mode: "degraded", observed: observed(error), root: boundRoot(error) },
  }
}

// The explicit binding that named the missing root, so desk_status names the configured path and where it came from.
function boundRoot(error) {
  return {
    path: typeof error?.path === "string" ? error.path : null,
    source: typeof error?.source === "string" ? error.source : null,
    problem: typeof error?.problem === "string" ? error.problem : null,
    activation_config: typeof error?.activation_config === "string" ? error.activation_config : null,
  }
}

function rootUnavailableFix(error) {
  const missing = typeof error?.path === "string" ? error.path : "the desk root"
  const recheck = "then call desk_status: Desk rechecks the root in place, with no restart."
  if (error?.source === "activation-config") {
    return `The saved desk binding ${error.activation_config} names ${missing}, which could not be validated. Restore access to that existing desk or correct the saved association through its authorized configuration; ${recheck}`
  }
  if (error?.source === "env:DESK") {
    return `The DESK environment variable names ${missing}. Restore access to that existing desk or correct the explicit destination in the environment that launches Desk and reconnect the Desk MCP server; ${recheck}`
  }
  return `Restore access to the intended desk at ${missing} or correct the explicit destination the host passes; ${recheck}`
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
  return exceptionOutcome(error)
}

const MEMBER_UNKNOWN = "crew_member_unknown"

// A Crew workspace session whose person is not known: reads work, writes are refused, and `fix` is the one plain message.
function memberUnknownOutcome(member, message) {
  return {
    state: "degraded",
    code: MEMBER_UNKNOWN,
    summary: `${message} Reads are available; writes are refused.`,
    fix: message,
    diagnostic: { mode: "degraded", member: { problem: member.problem, logins: member.logins ?? [] } },
  }
}

function searchUnavailableOutcome(error) {
  return {
    state: "degraded",
    code: "search_unavailable",
    summary: `Desk's search engine could not start (${describe(error)}).`,
    fix: SEARCH_FIX,
    diagnostic: { mode: "degraded", observed: observed(error) },
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
