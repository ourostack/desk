import { realpathSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { parentPort, Worker, workerData } from "node:worker_threads"
import { inspectLfs } from "./lfs.js"

const WORK_MS = 11_000
const STOP_MS = 4_000
const REPORT_STATES = new Set(["inspected", "limited", "not_git", "unavailable"])
const JOB_FAILURES = new Set(["repository_unavailable", "repository_scope_mismatch", "inspection_failed"])
// A shutdown with no exit confirmation still owns its actor and blocks a second inspection of the same root.
const active = new Map()
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value)

function inspectBoundRepository({ repo, env }) {
  let root
  try {
    root = realpathSync(repo)
  } catch {
    return { repo, code: "repository_unavailable" }
  }
  let mismatch = false
  const spawn = (command, args, options) => {
    const reply = spawnSync(command, args, options)
    if (command === "git" && args.includes("--show-toplevel") && reply.status === 0) {
      try {
        mismatch = realpathSync(String(reply.stdout).trim()) !== root
      } catch {
        mismatch = true
      }
      if (mismatch) return { status: 1, stdout: Buffer.alloc(0) }
    }
    return reply
  }
  const report = inspectLfs({ repo: root, env, spawn })
  return mismatch ? { repo, code: "repository_scope_mismatch" } : { repo, report }
}

if (parentPort && workerData?.deskLfsObservation === true) {
  parentPort.once("message", (job) => {
    try {
      parentPort.postMessage(inspectBoundRepository(job))
    } catch {
      parentPort.postMessage({ repo: job?.repo, code: "inspection_failed" })
    } finally {
      parentPort.close()
    }
  })
}

function validReport(report) {
  return report?.schema_version === 1 && report.action === "inspect" && REPORT_STATES.has(report.state)
    && object(report.repository) && object(report.tool)
    && Array.isArray(report.files) && report.files.every(object)
    && Array.isArray(report.findings) && report.findings.every(object)
    && ["remote_publication", "network_auth", "installed_payload"].every((key) => report.qualification?.[key] === "not_checked")
}

// Like admission workers, this imports only dependency-free code. A reply is not a result until the actor exits.
export function observeLfs({ repo, env = process.env, signal } = {}, {
  createWorker = (url, options) => new Worker(url, options),
  workMs = WORK_MS, stopMs = STOP_MS,
} = {}) {
  if (signal?.aborted) return Promise.resolve({ state: "cancelled", reason: "cancelled", worker: "not_started" })
  if (typeof repo !== "string" || repo.trim() === "") return Promise.resolve({ state: "unavailable", reason: "repository_unavailable", worker: "not_started" })
  if (![workMs, stopMs].every((value) => Number.isSafeInteger(value) && value > 0)) {
    return Promise.resolve({ state: "unavailable", reason: "invalid_budget", worker: "not_started" })
  }
  if (active.has(repo)) return Promise.resolve({ state: "unavailable", reason: "inspection_in_progress", worker: active.get(repo).state })
  return new Promise((resolve) => {
    let worker
    try {
      worker = createWorker(new URL(import.meta.url), { workerData: { deskLfsObservation: true } })
    } catch {
      resolve({ state: "unavailable", reason: "worker_start_failed", worker: "not_started" })
      return
    }
    const actor = { state: "running", worker }
    active.set(repo, actor)
    worker.unref()
    let settled = false
    let stopping = false
    let report = null
    let received = false
    let failure = null
    const finish = (result) => {
      if (settled) return
      settled = true
      if (result.worker === "unconfirmed") actor.state = "unconfirmed"
      clearTimeout(workTimer)
      clearTimeout(wholeTimer)
      signal?.removeEventListener("abort", cancel)
      resolve(result)
    }
    const stop = () => {
      if (stopping) return
      stopping = true
      try {
        Promise.resolve(worker.terminate()).catch(() => { failure ??= "worker_stop_failed" })
      } catch {
        failure ??= "worker_stop_failed"
      }
    }
    const cancel = () => {
      failure = "cancelled"
      stop()
    }
    const workTimer = setTimeout(() => {
      failure ??= "timeout"
      stop()
    }, workMs)
    const wholeTimer = setTimeout(() => {
      stop()
      finish({ state: "unavailable", reason: "worker_stop_unconfirmed", worker: "unconfirmed" })
    }, workMs + stopMs)
    worker.on("message", (reply) => {
      if (settled || stopping) return
      if (received) failure = "worker_reply_invalid"
      else if (reply?.repo !== repo) failure = "source_mismatch"
      else if (JOB_FAILURES.has(reply.code)) failure = reply.code
      else if (!validReport(reply.report)) failure = "worker_reply_invalid"
      else report = reply.report
      received = true
      if (failure !== null) stop()
    })
    worker.on("error", () => {
      if (settled) return
      failure ??= "worker_error"
      stop()
    })
    worker.once("exit", (code) => {
      if (active.get(repo) === actor) active.delete(repo)
      if (settled) return
      if (failure !== null) finish({ state: failure === "cancelled" ? "cancelled" : "unavailable", reason: failure, worker: "exited" })
      else if (code !== 0 || report === null) finish({ state: "unavailable", reason: code !== 0 ? "worker_exit" : "worker_no_report", worker: "exited" })
      else finish({ state: "observed", report, worker: "exited" })
    })
    signal?.addEventListener("abort", cancel, { once: true })
    if (signal?.aborted) cancel()
    if (!stopping) {
      try {
        worker.postMessage({ repo, env: { ...env } })
      } catch {
        failure = "worker_connection_failed"
        stop()
      }
    }
  })
}
