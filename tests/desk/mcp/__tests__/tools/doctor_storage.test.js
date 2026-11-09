import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { EventEmitter, once } from "node:events"
import { lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import { spawnSync } from "node:child_process"
import { Worker } from "node:worker_threads"
import { setTimeout as delay } from "node:timers/promises"
import { mkTempRoot } from "../_temp_roots.js"
import { doctorRuntime } from "../../../../../plugins/desk/mcp/src/tools/doctor.js"
import { previewRuntimeSnapshot } from "../../../../../plugins/desk/mcp/src/runtime/preview-snapshot.js"
import { callTool } from "../../../../../plugins/desk/mcp/src/server.js"
import { TOOL_INPUT_SCHEMAS } from "../../../../../plugins/desk/mcp/src/tool-schemas.js"

let observeLfs
try {
  ;({ observeLfs } = await import("../../../../../plugins/desk/mcp/src/runtime/lfs-observation.js"))
} catch (error) {
  if (error.code !== "ERR_MODULE_NOT_FOUND") throw error
}

function git(root, ...args) {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout.trim()
}

function write(root, file, content) {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
  writeFileSync(path.join(root, file), content)
}

async function fixture() {
  const root = await mkTempRoot("doctor-lfs-")
  git(root, "init", "-q")
  git(root, "config", "maintenance.auto", "false")
  git(root, "config", "gc.auto", "0")
  git(root, "config", "user.name", "Fixture")
  git(root, "config", "user.email", "fixture@example.invalid")
  write(root, "_meta/.gitkeep", "")
  write(root, "_archive/.gitkeep", "")
  write(root, "task/private-name.pdf", Buffer.from([0, 1, 2, 255]))
  write(root, "_secrets/service.json", '{"credential":"do-not-emit"}')
  git(root, "add", "--all")
  git(root, "commit", "-qm", "fixture")
  return root
}

function snapshot(root) {
  const entries = {}
  const walk = (dir, prefix = "") => {
    for (const name of readdirSync(dir).sort()) {
      const file = path.join(dir, name)
      const rel = `${prefix}${name}`
      const stat = lstatSync(file)
      entries[rel] = { mode: stat.mode, ...(stat.isFile() ? { hash: createHash("sha256").update(readFileSync(file)).digest("hex") } : {}) }
      if (stat.isDirectory()) walk(file, `${rel}/`)
    }
  }
  walk(root)
  return entries
}

const observe = (...args) => {
  assert.equal(typeof observeLfs, "function", "the bounded observation worker API is missing")
  return observeLfs(...args)
}

test("GivenDefaultOrPreviewDoctor_WhenStorageNotRequested_DoesNotStartInspection", async () => {
  let calls = 0
  const observeStorage = () => { calls += 1; throw new Error("must not inspect") }
  const full = doctorRuntime({ observeStorage })
  assert.equal(typeof full.then, "undefined", "existing default consumers remain synchronous")
  assert.equal(full.storage, undefined)
  const preview = doctorRuntime({ input: { format: "preview", storage: "inspect" }, deskRoot: "/private/never-scan", observeStorage })
  assert.equal(JSON.stringify(preview), JSON.stringify(previewRuntimeSnapshot("ready")))
  assert.equal(calls, 0)
})

test("GivenExplicitStorageRequest_WhenDoctorRuns_ReportsRedactedLocalEvidenceWithoutChangingRuntimeHealth", async () => {
  const root = await fixture()
  const before = snapshot(root)
  const baseline = doctorRuntime({ deskRoot: root })
  const pending = doctorRuntime({ deskRoot: root, input: { storage: "inspect", repo: "/untrusted/wrong-repository" } })
  assert.equal(typeof pending.then, "function", "storage inspection must not block the MCP thread")
  const result = await pending
  assert.equal(result.status, baseline.status)
  assert.equal(result.mode, baseline.mode)
  assert.equal(result.reason, baseline.reason)
  assert.deepEqual(result.runtime, baseline.runtime)
  assert.deepEqual(result.organization, baseline.organization)
  assert.equal(result.storage.state, "inspected")
  assert.equal(result.storage.worker, "exited")
  assert.equal(result.storage.readiness, "not_checked")
  assert.equal(result.storage.scope.kind, "context")
  assert.equal(result.storage.counts.tracking_candidates, 1)
  assert.deepEqual(result.storage.qualification, { remote_publication: "not_checked", network_auth: "not_checked", installed_payload: "not_checked" })
  assert.equal(result.storage.next_step.kind, "readonly_command")
  assert.equal(result.storage.next_step.command, process.execPath)
  assert.deepEqual(result.storage.next_step.args.slice(1), ["inspect", "--repo", root])
  assert.match(result.storage.next_step.args[0], /mcp[/\\]scripts[/\\]lfs\.js$/u)
  assert.doesNotMatch(JSON.stringify(result.storage), /private-name|service\.json|do-not-emit|untrusted/u)
  assert.match(result.summary, /Binary storage/u)
  assert.match(result.summary, /readiness.*not checked/iu)
  assert.deepEqual(snapshot(root), before)
})

test("GivenExplicitStorageRequestThroughMcp_WhenDispatched_UsesAdvertisedInspectorAction", async () => {
  assert.deepEqual(TOOL_INPUT_SCHEMAS.desk_doctor.properties.storage.enum, ["inspect"])
  const root = await fixture()
  const result = await callTool({ deskRoot: root, name: "desk_doctor", input: { storage: "inspect" } })
  assert.equal(result.isError, undefined)
  const report = JSON.parse(result.content[0].text)
  assert.equal(report.storage.readiness, "not_checked")
  assert.equal(report.storage.worker, "exited")
})

test("GivenInvalidStorageAction_WhenDoctorRuns_RejectsBeforeWorkspaceInspection", () => {
  for (const storage of [null, true, "", "setup", {}, []]) {
    assert.throws(() => doctorRuntime({ deskRoot: "/private/never-scan", input: { storage } }), /unsupported storage observation/u)
  }
})

test("GivenUnavailableDesk_WhenStorageRequested_DoesNotFallBackToCwdOrLaunchWorker", async () => {
  const result = await doctorRuntime({
    deskRoot: " ",
    input: { storage: "inspect" },
    observeStorage: () => { throw new Error("must not start") },
  })
  assert.equal(result.storage.state, "not_checked")
  assert.equal(result.storage.reason, "desk_unavailable")
  assert.equal(result.storage.worker, "not_started")
  assert.deepEqual(result.storage.next_step.input, { detail: true })
  assert.equal(result.storage.next_step.tool, "desk_status")
})

test("GivenObserverFailure_WhenDoctorRuns_RetainsRuntimeHealthAndRedactsPrivateError", async () => {
  const root = await fixture()
  const result = await doctorRuntime({
    deskRoot: root,
    input: { storage: "inspect" },
    observeStorage: async () => { throw new Error("https://user:credential@private.invalid/secret") },
  })
  assert.equal(result.status, "ok")
  assert.equal(result.mode, "healthy")
  assert.equal(result.storage.state, "unavailable")
  assert.equal(result.storage.reason, "observation_failed")
  assert.equal(result.storage.readiness, "not_checked")
  assert.doesNotMatch(JSON.stringify(result.storage), /credential|private\.invalid|secret/u)
})

test("GivenDeskNestedInAnotherRepository_WhenStorageRequested_RefusesWiderRepositoryScope", async () => {
  const root = await fixture()
  const nested = path.join(root, "nested")
  write(root, "nested/_meta/.gitkeep", "")
  write(root, "nested/_archive/.gitkeep", "")
  const before = snapshot(root)
  const result = await doctorRuntime({ deskRoot: nested, input: { storage: "inspect" } })
  assert.equal(result.storage.state, "unavailable")
  assert.equal(result.storage.reason, "repository_scope_mismatch")
  assert.equal(result.storage.worker, "exited")
  assert.equal(result.storage.counts, undefined)
  assert.deepEqual(snapshot(root), before)
})

function validReport() {
  return {
    schema_version: 1, action: "inspect", state: "inspected",
    repository: { kind: "context", context: "personal" },
    tool: { state: "missing" }, configuration: {},
    files: [], findings: [],
    qualification: { remote_publication: "not_checked", network_auth: "not_checked", installed_payload: "not_checked" },
  }
}

class FixtureWorker extends EventEmitter {
  unref() {}
  postMessage(job) { this.job = job }
  terminate() {
    this.terminations = (this.terminations ?? 0) + 1
    queueMicrotask(() => this.emit("exit", 1))
    return Promise.resolve(1)
  }
}

test("GivenWorkerReplyWithoutExit_WhenObserved_DoesNotClaimSuccessUntilActorExits", async () => {
  const worker = new FixtureWorker()
  let settled = false
  const pending = observe({ repo: "/bound" }, { createWorker: () => worker }).then((result) => { settled = true; return result })
  worker.emit("message", { repo: "/bound", report: validReport() })
  await Promise.resolve()
  assert.equal(settled, false)
  worker.emit("exit", 0)
  const result = await pending
  assert.equal(result.state, "observed")
  assert.equal(result.worker, "exited")
})

test("GivenWorkerReplyForAnotherRoot_WhenObserved_RefusesItAndConfirmsTermination", async () => {
  const worker = new FixtureWorker()
  const pending = observe({ repo: "/bound" }, { createWorker: () => worker })
  worker.emit("message", { repo: "/other-secret-root", report: validReport() })
  const result = await pending
  assert.equal(result.state, "unavailable")
  assert.equal(result.reason, "source_mismatch")
  assert.equal(result.worker, "exited")
  assert.equal(result.report, undefined)
  assert.equal(worker.terminations, 1)
  assert.doesNotMatch(JSON.stringify(result), /secret/u)
})

test("GivenWorkerEarlyExitOrError_WhenObserved_NeverReturnsObservationSuccess", async () => {
  for (const kind of ["exit", "error", "malformed"]) {
    const worker = new FixtureWorker()
    const pending = observe({ repo: "/bound" }, { createWorker: () => worker })
    if (kind === "exit") worker.emit("exit", 0)
    if (kind === "error") worker.emit("error", new Error("private-token"))
    if (kind === "malformed") worker.emit("message", { repo: "/bound", report: { secret: "private-token" } })
    const result = await pending
    assert.equal(result.state, "unavailable")
    assert.equal(result.worker, "exited")
    assert.equal(result.report, undefined)
    assert.doesNotMatch(JSON.stringify(result), /private-token/u)
  }
})

test("GivenWorkerCannotStart_WhenObserved_ReturnsRedactedFailureWithoutActor", async () => {
  const result = await observe({ repo: "/bound" }, { createWorker: () => { throw new Error("private-token") } })
  assert.equal(result.state, "unavailable")
  assert.equal(result.worker, "not_started")
  assert.doesNotMatch(JSON.stringify(result), /private-token/u)
})

test("GivenPreAbortedRequest_WhenObserved_StartsNoWorker", async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await observe({ repo: "/bound", signal: controller.signal }, { createWorker: () => { throw new Error("must not create") } })
  assert.equal(result.state, "cancelled")
  assert.equal(result.worker, "not_started")
})

test("GivenUnconfirmedShutdown_WhenWholeBudgetExpires_DiscardsEvenValidObservations", async () => {
  const worker = new FixtureWorker()
  worker.terminate = () => Promise.resolve(1)
  const pending = observe({ repo: "/bound" }, { createWorker: () => worker, workMs: 10, stopMs: 20 })
  worker.emit("message", { repo: "/bound", report: validReport() })
  const result = await pending
  assert.equal(result.state, "unavailable")
  assert.equal(result.reason, "worker_stop_unconfirmed")
  assert.equal(result.worker, "unconfirmed")
  assert.equal(result.report, undefined)
  worker.emit("exit", 1)
})

test("GivenMalformedFileObservations_WhenWorkerReplies_RefusesBeforeFormatting", async () => {
  const worker = new FixtureWorker()
  const pending = observe({ repo: "/malformed-report" }, { createWorker: () => worker })
  worker.emit("message", { repo: "/malformed-report", report: { ...validReport(), files: [null] } })
  worker.emit("exit", 0)
  const result = await pending
  assert.equal(result.state, "unavailable")
  assert.equal(result.reason, "worker_reply_invalid")
  assert.equal(result.report, undefined)
})

test("GivenRetainedWorker_WhenInspectionIsRepeated_StartsNoSecondActorUntilExit", async () => {
  const worker = new FixtureWorker()
  worker.terminate = () => Promise.resolve(1)
  const first = await observe({ repo: "/retained-bound-root" }, { createWorker: () => worker, workMs: 5, stopMs: 10 })
  assert.equal(first.worker, "unconfirmed")
  const second = await observe({ repo: "/retained-bound-root" }, { createWorker: () => { throw new Error("must not create another actor") } })
  assert.equal(second.reason, "inspection_in_progress")
  assert.equal(second.worker, "unconfirmed")
  worker.emit("exit", 1)
  const next = new FixtureWorker()
  const pending = observe({ repo: "/retained-bound-root" }, { createWorker: () => next })
  next.emit("message", { repo: "/retained-bound-root", report: validReport() })
  next.emit("exit", 0)
  assert.equal((await pending).state, "observed", "exit releases the guard, not a cached report")
})

test("GivenBlockingWorker_WhenRequestCancelled_ConfirmsExitWhileStatusRemainsResponsive", async () => {
  const root = await fixture()
  const controller = new AbortController()
  let worker
  let online
  const createWorker = () => {
    worker = new Worker('const {parentPort}=require("node:worker_threads"); parentPort.once("message",()=>{while(true){}})', { eval: true })
    online = once(worker, "online")
    return worker
  }
  const pending = doctorRuntime({
    deskRoot: root, input: { storage: "inspect" }, signal: controller.signal,
    observeStorage: (input) => observe(input, { createWorker }),
  })
  try {
    await online
    const status = await Promise.race([
      callTool({ deskRoot: root, name: "desk_status", input: {} }),
      delay(1500).then(() => { throw new Error("storage worker blocked desk_status") }),
    ])
    assert.equal(status.isError, undefined)
  } finally {
    controller.abort()
  }
  const result = await pending
  assert.equal(result.storage.state, "cancelled")
  assert.equal(result.storage.worker, "exited")
  assert.equal(result.storage.next_step.kind, "none")
  assert.equal(worker.threadId, -1)
})

test("GivenBlockingWorker_WhenWorkBudgetExpires_TerminatesOwnedThread", async () => {
  let worker
  const result = await observe({ repo: "/bound" }, {
    workMs: 100, stopMs: 1000,
    createWorker: () => {
      worker = new Worker('const {parentPort}=require("node:worker_threads"); parentPort.once("message",()=>{while(true){}})', { eval: true })
      return worker
    },
  })
  assert.equal(result.state, "unavailable")
  assert.equal(result.reason, "timeout")
  assert.equal(result.worker, "exited")
  assert.equal(worker.threadId, -1)
})
