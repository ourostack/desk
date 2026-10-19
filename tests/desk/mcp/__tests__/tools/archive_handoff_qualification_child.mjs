// Qualification harness only. No production mutations or f4 coordinator imports.
import "../_isolated_env.mjs"
import fs from "node:fs"
import { promises as io } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fork, spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { task_create, task_update, task_archive } from "../../../../../plugins/desk/mcp/src/tools/task.js"
import { openArchiveMoveSession } from "../../../../../plugins/desk/mcp/src/tools/archive-move.js"
import { readMarkdown } from "../../../../../plugins/desk/mcp/src/util/fm.js"
import { installCardGuard } from "../../../../../plugins/desk/mcp/src/desk/card-commit-guard.js"
import { openChangeJournal } from "../../../../../plugins/desk/mcp/src/readiness/journal.js"
import { factoryStateRoot } from "../../../../../plugins/desk/mcp/src/factory/outbox.js"
import { schedulePush as normalSchedulePush, runPushWorker } from "../../../../../plugins/desk/mcp/src/runtime/sync-worker.js"
import { readOwnProcessStart, readProcessStart } from "../../../../../plugins/desk/mcp/src/readiness/process-start.js"

export const RUN = process.env.DESK_TEST_RUN_DIR
if (!RUN || !fs.existsSync(RUN)) throw new Error("Qualification requires the pre-created owned DESK_TEST_RUN_DIR")
export const ART = path.join(RUN, "archive-qualification")
fs.mkdirSync(ART, { recursive: true })
export const SLUG = "archive-proof"
export const RESOURCE = "branch:qualification/owned#retained-fixture"
export const digest = (value) => createHash("sha256").update(value).digest("hex")
export const exists = (file) => fs.existsSync(file)
const moveSourceHash = digest(fs.readFileSync(new URL("./_legacy_directory_move.mjs", import.meta.url)))
const moveProgramHash = "4e41cc66ef0e98ec2cecb5ff6cb3a6b57a8c9f91759eecffc4c0372a88f7b2fa"
const nativeStages = ["native-child-spawned", "native-ready-observed", "native-release-attempted",
  "native-result-observed", "native-child-exit", "native-child-close"]

export function nativeMoveObserver({ source, destination, fixture, spawnChild = spawn }) {
  const receipt = {
    scope: "historical_directory_move_observer",
    actorPid: process.pid, platform: process.platform, node: process.versions.node, helperSourceHash: moveSourceHash,
    sourceMatchesFixture: source === fixture.src, destinationMatchesFixture: destination === fixture.dst,
    spawnReached: false, executableMatches: null, programHash: null, childPid: null,
    ready: null, ack: null, exit: null, close: null, helper: null, events: [], protocolIssues: [],
    droppedEvents: 0,
  }
  let sequence = 0, stdoutBytes = 0, stderrBytes = 0, pending = "", readyCount = 0, resultCount = 0
  const event = (type, detail = {}) => {
    const item = { sequence: ++sequence, monotonicNs: process.hrtime.bigint().toString(), type, ...detail }
    if (receipt.events.length < 128) receipt.events.push(item)
    else receipt.droppedEvents += 1
  }
  const issue = (code) => {
    if (!receipt.protocolIssues.includes(code) && receipt.protocolIssues.length < 16) receipt.protocolIssues.push(code)
  }
  const version = value => typeof value === "string" && /^\d{1,6}(?:\.\d{1,6}){1,3}$/u.test(value)
  const exception = value => typeof value === "string" &&
    /^System\.(?:IO\.[A-Za-z]{1,64}Exception|UnauthorizedAccessException|ArgumentException|NotSupportedException|Security\.SecurityException)$/u.test(value)
  const response = (item) => {
    if (item?.state === "ready") {
      readyCount += 1
      if (readyCount > 1) issue("duplicate_ready")
      const valid = item.pid === receipt.childPid && version(item.powershell) && version(item.runtime) &&
        item.edition === "Desktop" && item.api === "System.IO.Directory.Move"
      if (!valid) issue("invalid_ready")
      receipt.ready = { valid, pidMatchesChild: item.pid === receipt.childPid,
        powershell: version(item.powershell) ? item.powershell : null, runtime: version(item.runtime) ? item.runtime : null }
      event("native-ready-observed", receipt.ready)
    } else if (item?.state === "result") {
      resultCount += 1
      if (resultCount > 1) issue("duplicate_result")
      const valid = item.moved === true && item.exception === null && item.hresult === null ||
        item.moved === false && exception(item.exception) && Number.isInteger(item.hresult) &&
        item.hresult >= -2147483648 && item.hresult <= 2147483647
      if (!valid) issue("invalid_result")
      receipt.ack = { valid, moved: typeof item.moved === "boolean" ? item.moved : null,
        exception: exception(item.exception) ? item.exception : null,
        hresult: Number.isInteger(item.hresult) && item.hresult >= -2147483648 && item.hresult <= 2147483647 ? item.hresult : null }
      event("native-result-observed", receipt.ack)
    } else issue("unexpected_protocol_state")
  }
  const stateOf = state => state ? {
    released: state.released === true, closed: state.closed === true, forced: state.forced === true,
    movement: ["not_released", "confirmed", "refused", "unconfirmed"].includes(state.movement) ? state.movement : null,
    retirement: ["confirmed", "forced", "unconfirmed"].includes(state.retirement) ? state.retirement : null,
    runtime: state.runtime ? { powershell: version(state.runtime.powershell) ? state.runtime.powershell : null,
      runtime: version(state.runtime.runtime) ? state.runtime.runtime : null } : null,
    refusal: state.refusal ? { exception: exception(state.refusal.exception) ? state.refusal.exception : null,
      hresult: Number.isInteger(state.refusal.hresult) ? state.refusal.hresult : null } : null,
  } : null
  const observeSpawn = (executable, args, settings) => {
    receipt.spawnReached = true
    receipt.executableMatches = executable === path.win32.join(settings?.env?.SystemRoot || settings?.env?.SYSTEMROOT || "",
      "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    receipt.programHash = typeof args?.[4] === "string" ? digest(args[4]) : null
    const child = spawnChild(executable, args, settings)
    receipt.childPid = child.pid ?? null
    if (!receipt.executableMatches || receipt.programHash !== moveProgramHash ||
        JSON.stringify(args.slice(0, 4)) !== JSON.stringify(["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"])) {
      issue("unexpected_spawn")
      return child
    }
    child.on("spawn", () => event("native-child-spawned"))
    child.on("error", () => event("native-child-error"))
    child.stdout.on("data", chunk => {
      stdoutBytes += chunk.length
      if (stdoutBytes > 16384) { issue("stdout_oversized"); return }
      pending += chunk.toString("utf8")
      for (;;) {
        const newline = pending.indexOf("\n")
        if (newline < 0) break
        const line = pending.slice(0, newline).trim()
        pending = pending.slice(newline + 1)
        let item
        try { item = JSON.parse(line) } catch { issue("malformed_json"); continue }
        response(item)
      }
    })
    child.stderr.on("data", chunk => {
      stderrBytes += chunk.length
      if (stderrBytes > 16384) issue("stderr_oversized")
    })
    child.on("exit", (code, signal) => { receipt.exit = { code, signal }; event("native-child-exit", receipt.exit) })
    child.on("close", (code, signal) => {
      receipt.close = { code, signal }
      if (pending.trim()) issue("unterminated_output")
      event("native-child-close", receipt.close)
    })
    const write = child.stdin.write, end = child.stdin.end
    let requestObserved = false
    child.stdin.write = function (...values) {
      if (!requestObserved) {
        requestObserved = true
        let request
        try { request = JSON.parse(String(values[0])) } catch { issue("invalid_request_observation") }
        event("native-request-attempted", { sourceMatches: request?.source === source, destinationMatches: request?.destination === destination })
      }
      return Reflect.apply(write, this, values)
    }
    child.stdin.end = function (...values) {
      if (values[0] !== undefined && values[0] !== null && typeof values[0] !== "function")
        event("native-release-attempted", { literalMatches: String(values[0]) === "move\n" })
      return Reflect.apply(end, this, values)
    }
    return child
  }
  const identity = async file => {
    try {
      const stat = await io.stat(file, { bigint: true })
      return { state: "observed", identity: digest(`${stat.dev}:${stat.ino}`) }
    } catch (error) {
      return { state: error.code === "ENOENT" ? "absent" : "unavailable",
        code: ["ENOENT", "EACCES", "EPERM", "ENOTDIR"].includes(error.code) ? error.code : "other" }
    }
  }
  return {
    receipt, event, spawn: observeSpawn,
    async before() {
      event("move-callable-entered")
      receipt.baseline = { source: await identity(source), parent: await identity(path.dirname(destination)),
        destination: await identity(destination) }
    },
    returned(state) { receipt.helper = { outcome: "returned", state: stateOf(state) }; event("helper-returned") },
    threw(error) { receipt.helper = { outcome: "threw", state: stateOf(error.archiveMove) }; event("helper-threw") },
    async after() {
      const final = { source: await identity(source), parent: await identity(path.dirname(destination)),
        destination: await identity(destination) }
      receipt.final = { sourceState: final.source.state, destinationState: final.destination.state,
        destinationMatchesOriginalSource: receipt.baseline.source.state === "observed" &&
          final.destination.identity === receipt.baseline.source.identity,
        parentMatchesBaseline: receipt.baseline.parent.state === "observed" && final.parent.identity === receipt.baseline.parent.identity }
      receipt.missingNativeStages = nativeStages.filter(type => !receipt.events.some(item => item.type === type))
    },
  }
}
export function record(type, detail = {}) {
  fs.appendFileSync(path.join(ART, `events-${process.pid}.jsonl`),
    JSON.stringify({ pid: process.pid, ...detail, type, at: new Date().toISOString() }) + "\n")
}
export const gitCalls = []
export async function ownIdentity() {
  return { pid: process.pid, exe: process.execPath, start: await readOwnProcessStart() }
}
export function realGit(file, args, options = {}) {
  if (file !== "git") throw new Error("Only normal fixture Git is admitted")
  if (args.some((arg) => ["push", "fetch", "pull", "clone", "ls-remote"].includes(arg))) {
    record("forbidden-network-command", { args })
    throw new Error("Qualification fixture must not execute network Git")
  }
  const began = process.hrtime.bigint().toString()
  const result = spawnSync(file, args, { ...options, timeout: Math.min(options.timeout || 5000, 5000) })
  const receipt = { pid: result.pid, exe: "git", args, status: result.status, signal: result.signal,
    spawnMonotonicNs: began, endMonotonicNs: process.hrtime.bigint().toString(), directlyWaited: true,
    error: result.error?.code ?? null }
  gitCalls.push(receipt)
  record("git-completed", receipt)
  return result
}
export function git(root, ...args) {
  const answer = realGit("git", ["-C", root, ...args], { encoding: "utf8" })
  if (answer.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${answer.stderr}`)
  return answer.stdout.trimEnd()
}
export function envFor(base, root) {
  const env = { ...process.env, DESK: root, XDG_STATE_HOME: path.join(base, "state") }
  // Same fixture-context exclusions as factory/_session_helpers.js. Never strip preloads.
  for (const name of ["DESK_ACTIVATION_CONFIG", "CLAUDE_PLUGIN_DATA", "CLAUDE_PROJECT_DIR", "CODEX_HOME", "DESK_PERSON", "CLAUDE_CONFIG_DIR"])
    delete env[name]
  return env
}
export function descriptor(base, root, person = null) {
  const prefix = person === null ? root : path.join(root, "desks", person)
  return { base, root, person, prefix, src: path.join(prefix, "t", SLUG),
    dst: path.join(prefix, "t", "_archive", SLUG), card: path.join(prefix, "t", SLUG, "task.md"),
    archived: path.join(prefix, "t", "_archive", SLUG, "task.md"),
    track: path.join(prefix, "t", "track.md"), env: envFor(base, root) }
}

const actors = new Set()
const workers = new Set()
const candidateAttempts = []
const productionAttempts = []
export function archiveProductionObservations() { return productionAttempts }
export function archiveCandidateObservations({ includeSynthetic = false } = {}) {
  return candidateAttempts.filter(attempt => includeSynthetic || attempt.scope === "actual_native_controller")
}
function missingHandleStages(native) {
  if (!native) return ["native_receipt_missing"]
  const required = ["native_spawn", "capture_requested", "native_result", "native_exit", "native_close", "session_settled"]
  if (native.capturedValidated) required.push("native_captured")
  if (native.admissionValidated) required.push("admission_requested", "native_ready")
  if (native.archiveMove?.released) required.push("callback_started", "callback_completed", "GO_attempted")
  return required.filter(type => !native.events?.some(event => event.type === type))
}
export function nativeActorObservations() {
  return [...actors].filter(actor => actor.role === "archive").map(actor => {
    const attempts = actor.messages.findLast(message => message.candidateAttempts)?.candidateAttempts ?? []
    const observation = actor.messages.findLast(message => message.moveObservation)?.moveObservation ?? attempts.at(-1) ?? null
    return { actorPid: actor.pid, caseId: actor.caseId, receipt: observation,
      missingNativeStages: ["test_only_preadmitted_source_handle", "production_default_archive_session"].includes(observation?.kind) ?
        missingHandleStages(observation.native) :
        observation ? nativeStages.filter(type => !observation.events.some(item => item.type === type)) : nativeStages,
      candidateAttempts: attempts,
      receiptReceived: observation !== null }
  })
}
export async function drainWithNativeObservations(drain, persist) {
  let result, primary, failed = false
  try { result = await drain() } catch (error) { primary = error; failed = true }
  try { await persist(result, primary) } catch (error) {
    if (!failed) throw error
    const code = ["EIO", "EACCES", "EPERM", "ENOENT", "ENOSPC", "ERR_ASSERTION"].includes(error?.code) ? error.code : "unavailable"
    console.error("Passive native observation persistence failed:", code)
  }
  if (failed) throw primary
  return result
}
const HELPER = fileURLToPath(import.meta.url)
function bounded(promise, ms, label) {
  let timer
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms)
  })]).finally(() => clearTimeout(timer))
}
function next(actor, type) {
  const read = () => actor.messages.find((message) => message.type === type)
  if (read()) return Promise.resolve(read())
  if (actor.exit) return Promise.reject(new Error(`Actor ${actor.pid} exited before ${type}`))
  return bounded(new Promise((resolve, reject) => {
    const wake = () => {
      if (read()) { actor.waiters.delete(wake); resolve(read()) }
      else if (actor.exit) { actor.waiters.delete(wake); reject(new Error(`Actor ${actor.pid} exited before ${type}`)) }
    }
    actor.waiters.add(wake)
  }), 6000, `${actor.role}:${type}`)
}
export const actorMessage = next
export function send(actor, value) {
  if (actor.child.connected && !actor.exit) actor.child.send(value, (error) => {
    if (error) record("owned-pipe-send-error", { childPid: actor.pid, cmd: value.cmd, code: error.code })
  })
}
export function spawnActor(role, fixture, mode = "plain") {
  // Remove runner execution flags only. Preserve every --import and NODE_OPTIONS.
  const execArgv = process.execArgv.filter((arg) => arg !== "--test" && !arg.startsWith("--test-"))
  const child = fork(HELPER, [role, JSON.stringify({ base: fixture.base, root: fixture.root, person: fixture.person, mode })], {
    execArgv, env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"],
  })
  const actor = { child, pid: child.pid, role, caseId: digest(fixture.root),
    messages: [], waiters: new Set(), exit: null, stderr: "", stdout: "" }
  actors.add(actor)
  record("actor-born", { childPid: child.pid, role, exe: process.execPath,
    importCount: execArgv.filter((arg) => arg === "--import").length,
    helperArgPresent: child.spawnargs.includes(HELPER), fixture: fixture.root })
  child.stderr.on("data", (chunk) => { actor.stderr += String(chunk) })
  child.stdout.on("data", (chunk) => { actor.stdout += String(chunk) })
  child.on("message", (message) => {
    actor.messages.push(message)
    record("actor-message", { childPid: actor.pid, role, message })
    for (const wake of actor.waiters) wake()
  })
  actor.ended = new Promise((resolve) => child.once("exit", (code, signal) => {
    actor.exit = { code, signal, stderr: actor.stderr, stdout: actor.stdout }
    record("actor-ended", { childPid: actor.pid, role, ...actor.exit })
    for (const wake of actor.waiters) wake()
    resolve(actor.exit)
  }))
  actor.ready = (async () => {
    const hello = await next(actor, "hello")
    const independent = await readProcessStart(actor.pid)
    if (hello.pid !== actor.pid || hello.exe !== process.execPath || !hello.start || independent !== hello.start)
      throw new Error("Actor PID/start/exe ownership did not qualify")
    actor.identity = hello
    record("actor-identity", { childPid: actor.pid, ...hello, independentlyMatched: true })
    return actor
  })()
  return actor
}
export async function finishActor(actor) {
  if (actor.exit) return actor.exit
  send(actor, { cmd: "abort" })
  send(actor, { cmd: "finish" })
  // No name-based signals. The child's fixed self-lease is the final bound.
  return bounded(actor.ended, 22000, "graceful owned actor retirement")
}
export function scheduleFor(fixture) {
  return ({ root }) => normalSchedulePush({
    root, env: fixture.env, debounceMs: 0,
    spawnWorker() {
      const actor = spawnActor("push", fixture)
      const pending = (async () => {
        await actor.ready
        send(actor, { cmd: "start" })
        const outcome = await next(actor, "result")
        send(actor, { cmd: "finish" })
        const exit = await bounded(actor.ended, 5000, "normal push worker exit")
        if (outcome.error || exit.code !== 0 || !["skipped", "busy"].includes(outcome.result?.result))
          throw new Error(`No-remote normal push worker did not retire normally: ${JSON.stringify({ outcome, exit })}`)
        return { root: fixture.root, pid: actor.pid, result: outcome.result, exit }
      })()
      workers.add(pending)
      pending.catch((error) => record("owned-worker-rejected", { childPid: actor.pid, message: error.message }))
      // This is an actual spawned worker, not a fake scheduled/success result.
    },
  })
}
export async function drainActors() {
  const outcomes = await Promise.allSettled([...workers])
  const cleanup = await Promise.allSettled([...actors].filter((actor) => !actor.exit).map(finishActor))
  const failures = [...outcomes, ...cleanup].filter((item) => item.status === "rejected")
  if (failures.length) throw new AggregateError(failures.map((item) => item.reason), "Owned actor teardown failed")
  const completed = outcomes.map((item) => item.value)
  for (const item of completed) {
    if (item.result.result === "busy" && !completed.some((peer) => peer.root === item.root && peer.result.result === "skipped"))
      throw new Error(`A coalesced busy fixture worker has no qualified no-remote holder: ${item.pid}`)
  }
  return [...actors].map(({ pid, role, identity, exit }) => ({ pid, role, identity, exit }))
}
export function options(fixture, extra = {}) {
  return { deskRoot: fixture.root, person: fixture.person, env: fixture.env,
    spawnGit: realGit, schedulePush: scheduleFor(fixture), ...extra }
}
export async function archiveOwned(fixture, extra = {}, {
  candidate = process.env.DESK_TEST_ARCHIVE_HANDLE_CANDIDATE === "1",
  platform = process.platform, lstat = io.lstat, runArchive = task_archive, openSession, decorateMove, afterCapture,
  beforeAdmit, openProductionSession = openArchiveMoveSession,
} = {}) {
  if (!candidate) return runArchive(options(fixture, { ...extra, openArchiveMove: async pair => {
    if (productionAttempts.length >= 64) throw new Error("Production archive observations exceeded their bound")
    const observation = { kind: "production_default_archive_session",
      scope: openProductionSession === openArchiveMoveSession ? "production_default_factory" : "controlled_factory_transport",
      platform: process.platform, caseId: digest(fixture.root), sourceCapture: "capture_attempted", native: null,
      events: [], droppedEvents: 0, cleanupFailure: null }
    productionAttempts.push(observation)
    const event = type => {
      if (observation.events.length < 32) observation.events.push({ type, sequence: observation.events.length + 1 })
      else observation.droppedEvents++
    }
    let session
    try {
      session = await openProductionSession(pair)
      observation.native = session.receipt ?? null
      observation.destinationParentAtCapture = observation.native?.destinationParentValidation ?? null
      observation.sourceCapture = "captured_before_corresponding_preparation"
      event("source-captured")
      if (afterCapture) await afterCapture()
    } catch (error) {
      observation.sourceCapture = "capture_failed"
      observation.native = error.handleReceipt ?? session?.receipt ?? null
      if (session) {
        try { await session.close() } catch { observation.cleanupFailure = "native_session_close_unconfirmed" }
      }
      throw error
    }
    const transport = async (source, destination, atUse) => {
      if (source !== pair.source || destination !== pair.destination) throw new Error("Production decorator pair mismatch")
      try { return await session.move(atUse) } finally { observation.native = session.receipt ?? null }
    }
    const callable = decorateMove ? decorateMove(transport, observation) : transport
    return {
      async admit() {
        event("move-callable-entered")
        if (beforeAdmit) await beforeAdmit()
        try { return await session.admit() } finally { observation.native = session.receipt ?? null }
      },
      async move(atUse) { return callable(pair.source, pair.destination, atUse) },
      async close() {
        try { return await session.close() }
        catch (error) { observation.cleanupFailure = "native_session_close_unconfirmed"; throw error }
        finally { observation.native = session.receipt ?? null; event("session-retired") }
      },
    }
  } }))
  if (platform !== "win32") throw new Error("The archive source-handle candidate is Windows-test-only")
  if (candidateAttempts.length >= 64) throw new Error("Owned archive candidate attempt observations exceeded their bound")
  const observation = { kind: "test_only_preadmitted_source_handle",
    scope: openSession ? "synthetic_controller" : "actual_native_controller", caseId: digest(fixture.root),
    sourceCapture: "not_started", native: null, operationOutcome: "not_entered",
    cleanupFailure: null, events: [], droppedEvents: 0 }
  candidateAttempts.push(observation)
  const event = type => {
    if (observation.events.length >= 32) {
      observation.droppedEvents++
      throw new Error("Owned archive candidate controller events exceeded their bound")
    }
    observation.events.push({ type, sequence: observation.events.length + 1,
      monotonicNs: process.hrtime.bigint().toString() })
  }
  let session, failure, result, invoked = false
  try {
    let sourcePresent = true
    try { await lstat(fixture.src) }
    catch (error) { if (error.code !== "ENOENT") throw error; sourcePresent = false }
    if (sourcePresent) {
      const capture = openSession ?? (await import("./_windows_archive_handle.mjs")).openArchiveHandleSession
      observation.sourceCapture = "capture_attempted"
      event("source-capture-entered")
      session = await capture({ source: fixture.src, destination: fixture.dst })
      observation.native = session.receipt
      observation.destinationParentAtCapture = observation.native.destinationParentValidation ?? null
      observation.sourceCapture = "captured_before_operation"
      event("source-captured")
      if (afterCapture) await afterCapture()
    } else observation.sourceCapture = "not_applicable_source_absent"
    const move = async (source, destination, atUse) => {
      if (!session || invoked || source !== fixture.src || destination !== fixture.dst)
        throw new Error("Owned archive candidate requires one exact source/destination attempt")
      invoked = true
      event("move-callable-entered")
      try { await session.admit() } finally { observation.native = session.receipt }
      event("native-admission-confirmed")
      try { return await session.move(atUse) } finally { observation.native = session.receipt }
    }
    const callable = decorateMove ? decorateMove(move, observation) : move
    event("operation-entered")
    observation.operationOutcome = "entered"
    result = await runArchive(options(fixture, { ...extra, moveArchive: callable }))
    observation.operationOutcome = "returned"
  } catch (error) {
    failure = error
    observation.failureStage = observation.operationOutcome === "not_entered" ? "before_operation" : "operation"
    if (observation.operationOutcome === "entered") observation.operationOutcome = "threw"
    if (observation.sourceCapture === "capture_attempted") {
      observation.sourceCapture = "capture_failed"
      observation.native = error.handleReceipt ?? null
    }
  }
  finally {
    if (session) {
      try { await session.close(); event("session-retired") }
      catch (error) {
        observation.cleanupFailure = "native_session_close_unconfirmed"
        failure ??= error
      } finally { observation.native = session.receipt }
    }
  }
  if (failure) throw failure
  return result
}
function candidateMoveObserver(observation, source, destination, fixture) {
  observation.sourceMatchesFixture = source === fixture.src
  observation.destinationMatchesFixture = destination === fixture.dst
  const event = type => {
    if (observation.events.length >= 32) {
      observation.droppedEvents++
      throw new Error("Owned archive candidate controller events exceeded their bound")
    }
    observation.events.push({ type, sequence: observation.events.length + 1,
      monotonicNs: process.hrtime.bigint().toString() })
  }
  return {
    receipt: observation, event,
    async before() { event("move-decorator-entered") },
    returned(state) { observation.helperOutcome = "returned"; observation.movement = state?.movement ?? "posix_rename_returned" },
    threw(error) {
      observation.helperOutcome = "threw"
      observation.movement = ["not_released", "confirmed", "refused", "unconfirmed"].includes(error.archiveMove?.movement) ?
        error.archiveMove.movement : null
    },
    async after() { event("move-decorator-finished") },
  }
}
export async function openReadiness(fixture, name) {
  const journal = await openChangeJournal({ root: fixture.root, stateDir: path.join(fixture.base, `journal-${name}`) })
  return {
    journal,
    readiness: {
      async recordChange(change) {
        const row = await journal.appendChange(change)
        record("journal-durable-append", { root: fixture.root, row })
        return { recorded: true }
      },
      async markUncertain(reason) { record("readiness-mark-uncertain", { reason, root: fixture.root }) },
    },
  }
}
export async function fixture(name, { onGit = false, person = null, status = "processing", resource = false } = {}) {
  const base = path.join(RUN, "archive-cases", name)
  await io.mkdir(base, { recursive: true })
  const root = path.join(base, "desk")
  await io.mkdir(path.join(root, "_meta"), { recursive: true })
  await io.mkdir(path.join(root, "_archive"))
  const out = descriptor(base, root, person)
  record("fixture-owned", { name, base, root, person, onGit })
  await io.writeFile(path.join(root, "_meta", "fixture.md"), "Owned archive qualification fixture.\n")
  await io.writeFile(path.join(root, "proof.md"), "Owned non-code completion evidence.\n")
  await task_create(options(out, { input: { track: "t", slug: SLUG, title: "Archive proof", status,
    body: "## Outcome\n\nPreserve the real terminal record.\n\n## Progress log\n\n**Next step:** qualify archive.\n" } }))
  await io.writeFile(out.track,
    `---\nschema_version: 1\ntitle: Archive track\n---\n\n## Tasks\n\n| Slug | State | Repos | Tracker link | Doing doc |\n|---|---|---|---|---|\n| \`${SLUG}\` | ${status} | — | — | [task](${SLUG}/task.md) |\n`)
  await io.mkdir(path.dirname(out.dst), { recursive: true })
  await io.writeFile(path.join(out.src, "companion.txt"), "OWNED_TRACKED_BASE\n")
  if (resource) await task_update(options(out, { input: { track: "t", slug: SLUG, resource: { identity: RESOURCE, intended: "retain until qualification review" } } }))
  // Test-owned state only: no consent/config records are created or changed.
  out.factory = await factoryStateRoot(out.env, { deskRoot: root })
  if (onGit) {
    git(root, "init", "-q", "-b", "main")
    git(root, "config", "user.name", "Owned archive fixture")
    git(root, "config", "user.email", "archive-qualification@example.invalid")
    git(root, "add", "--", "_meta", "proof.md", person ? "desks" : "t")
    git(root, "commit", "-q", "-m", "owned archive baseline")
    out.guard = installCardGuard(root, { spawnGit: realGit })
    if (!["installed", "current"].includes(out.guard.state)) throw new Error(`Real card guard did not install: ${JSON.stringify(out.guard)}`)
    if (git(root, "remote") !== "") throw new Error("Fixture unexpectedly has a remote")
  }
  return out
}
export async function requests(fixture) {
  const result = {}
  for (const name of ["finalize", "evaluate-requests"]) {
    const dir = path.join(fixture.factory, name)
    const names = exists(dir) ? (await io.readdir(dir)).filter((value) => value.endsWith(".json")).sort() : []
    result[name] = await Promise.all(names.map(async (name) => {
      const file = path.join(dir, name)
      const text = await io.readFile(file, "utf8")
      return { name, digest: digest(text), mtimeNs: String((await io.stat(file, { bigint: true })).mtimeNs),
        record: JSON.parse(text) }
    }))
  }
  return result
}
export async function complete(fixture, readiness) {
  return task_update(options(fixture, { readiness, input: { track: "t", slug: SLUG, status: "done",
    evidence: { kind: "non_code", ref: "proof.md" }, note: "Owned outcome delivered; acceptance is still pending." } }))
}
export const readCard = (file) => readMarkdown(file)
export function errorData(error) {
  return { name: error.name, message: error.message, code: error.code ?? null, path: error.path ?? null,
    actual_path: error.actual_path ?? null, phase: error.archive_phase ?? error.phase ?? null }
}

if (process.argv[1] === HELPER) {
  const role = process.argv[2]
  const config = JSON.parse(process.argv[3])
  const owned = descriptor(config.base, config.root, config.person)
  const inbox = []
  const wake = new Set()
  process.on("message", (message) => { inbox.push(message); for (const notify of wake) notify() })
  const take = (cmd) => {
    const read = () => inbox.find((message) => message.cmd === cmd || message.cmd === "abort")
    if (read()) return Promise.resolve(read())
    return new Promise((resolve) => {
      const notify = () => { if (read()) { wake.delete(notify); resolve(read()) } }
      wake.add(notify)
    })
  }
  const sendMessage = (message) => new Promise((resolve, reject) => process.send(message, (error) => error ? reject(error) : resolve()))
  const lease = setTimeout(() => { record("actor-lease-expired", { role }); process.exit(124) }, 20000)
  lease.unref()
  await sendMessage({ type: "hello", pid: process.pid, exe: process.execPath, start: await readOwnProcessStart(),
    role, importCount: process.execArgv.filter((arg) => arg === "--import").length,
    nodeOptionsPresent: Object.hasOwn(process.env, "NODE_OPTIONS") })
  const start = await take("start")
  let result
  let failure
  let reader
  let renameReturned = false
  let moveObservation = null
  let moveObserver = null
  try {
    if (start.cmd === "abort") throw new Error("Owned qualification aborted before action")
    if (role === "push") result = await runPushWorker({ root: owned.root, env: owned.env, debounceMs: 0, spawnGit: realGit })
    else {
      reader = await openReadiness(owned, `actor-${process.pid}`)
      const decorateMove = (delegate, admission) => async (source, destination, atUse) => {
        const observer = admission ? candidateMoveObserver(admission, source, destination, owned) :
          nativeMoveObserver({ source, destination, fixture: owned })
        moveObserver = observer
        moveObservation = observer.receipt
        await observer.before()
        let nativeMove
        try {
          nativeMove = await delegate(source, destination, async () => {
            await atUse()
            observer.event("freshness-callback-completed")
            if (config.mode !== "plain") {
              observer.event("existing-barrier-entered")
              await sendMessage({ type: "rename-barrier", source, destination, gitCallsBeforeRename: gitCalls.length,
                moveObservation: observer.receipt })
              const command = await take("go")
              observer.event(command.cmd === "abort" ? "existing-barrier-aborted" : "existing-go-received")
              if (command.cmd === "abort") throw new Error("Owned qualification aborted at pre-rename barrier")
            }
          }, { spawn: observer.spawn })
          observer.returned(nativeMove)
        } catch (error) { observer.threw(error); throw error }
        finally { await observer.after() }
        if (nativeMove) record("native-move-returned", nativeMove)
        renameReturned = true
        observer.event("rename-returned-set")
        if (admission) await sendMessage({ type: "native-move-settled", moveObservation: observer.receipt })
        if (config.mode === "exit-after-rename") {
          const receipt = { pid: process.pid, exe: process.execPath, source, destination,
            actualDestination: fs.realpathSync(destination), gitCallsBeforeExit: gitCalls.length,
            gitPublicationCallsBeforeExit: gitCalls.filter((call) =>
              ["add", "commit", "update-index", "update-ref", "read-tree", "mv", "reset", "checkout", "switch", "merge", "rebase", "stash"].includes(call.args[2]) ||
              (call.args[2] === "hash-object" && call.args.includes("-w"))).length,
            cardHash: digest(fs.readFileSync(path.join(destination, "task.md"))), exitCode: 37 }
          fs.writeFileSync(path.join(owned.base, "crash-after-rename.json"), JSON.stringify(receipt, null, 2) + "\n")
          record("intentional-exit-after-actual-rename", receipt)
          process.exit(37)
        }
      }
      result = await archiveOwned(owned, { readiness: reader.readiness, input: { track: "t", slug: SLUG } }, { decorateMove })
    }
  } catch (error) { failure = errorData(error) }
  finally {
    if (reader) await reader.journal.close()
  }
  moveObserver?.event("archive-result", { status: result?.status ?? null, errorPhase: failure?.phase ?? null })
  await sendMessage({ type: "result", result: result ?? null, error: failure ?? null, renameReturned, moveObservation,
    candidateAttempts: archiveCandidateObservations() })
  await take("finish")
  await drainActors()
  clearTimeout(lease)
  process.disconnect()
}
