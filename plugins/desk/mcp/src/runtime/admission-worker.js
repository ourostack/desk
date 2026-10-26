// Admission work that can block, run on a worker thread so the thread that answers the host never waits for it.
//
// Two jobs: "resolve" (the desk root, the activation config, the readiness policy and the state branch, all synchronous file reads) and "runtime" (inspecting the offline runtime pack, which hashes and unpacks its archive, and restoring it into the runtime cache, which can wait up to 30 s on another process's publication lock). A runtime job runs in a fresh worker; resolve jobs share one worker that stays up between them (`createResolveRunner`). A result is plain data, and errors come back as plain objects with their code and fields.
//
// The worker imports only dependency-free modules and never loads a native addon: a worker that ended with better-sqlite3 or sqlite-vec loaded on it crashed the whole server (SIGSEGV in the worker's teardown on macOS, 0xC0000005 on Windows). It never imports index.js, which would start Desk inside the worker.

import { readFileSync } from "node:fs"
import * as path from "node:path"
import { parentPort, Worker, workerData } from "node:worker_threads"
import { normalizeReadinessPolicy } from "../activation/readiness-policy.js"
import { inspectRuntimeDependencyPack, prepareRuntime } from "./bootstrap.js"
import {
  resolveStartupActivationContext,
  resolveStartupDeskRoot,
  resolveStartupReadinessPolicy,
  resolveStartupRuntimeCacheDir,
  resolveStartupSourceIdentity,
  resolveStartupStateBranch,
} from "./startup-resolve.js"

// The lock path, then optionally the exact detail bootstrap.js appends. Anchoring the tail to its known forms keeps a path that itself holds " (" whole, as in "Program Files (x86)".
const LOCK_TIMEOUT = /^atomic publication lock timed out: (.+?)(?: \((?:held by pid \d+, (?:which is still running, so its build is taking longer than the wait|which has exited)|no readable owner record); waited \d+ ms\))?$/u

/** The root and activation inputs of one admission attempt. Failures are returned, not thrown: `rootError` stops admission, `activationError` stops it after the root. */
export function resolveAdmissionInputs({ args, env, cwd, homeDir, injectedReadinessPolicy }) {
  let root
  try {
    root = resolveStartupDeskRoot({ args, env, homeDir, cwd })
  } catch (error) {
    return { rootError: serializeError(error) }
  }
  try {
    const activationStatus = resolveStartupActivationContext({ args, cwd, env, homeDir })
    return {
      root,
      activation: {
        activationStatus,
        sourceIdentity: resolveStartupSourceIdentity(activationStatus),
        runtimeCacheDir: resolveStartupRuntimeCacheDir({ args, cwd, env, homeDir }),
        readinessPolicy: normalizeReadinessPolicy(
          injectedReadinessPolicy ?? resolveStartupReadinessPolicy({ args, cwd, env, homeDir }),
        ),
        stateBranch: resolveStartupStateBranch({ args, cwd, env, homeDir }),
      },
    }
  } catch (error) {
    return { root, activationError: serializeError(error) }
  }
}

/** Inspect (when asked) and restore the runtime. Returns `{ inspection, prepared }`, or the inspection, `inspectionError` or `restoreError` that stopped it. */
export function prepareRuntimeInputs({
  mcpRoot, env, runtimeCacheDir, sourceIdentity, inspect,
  inspector = inspectRuntimeDependencyPack, prepare = prepareRuntime,
}, { onPhase = () => {} } = {}) {
  let inspection = null
  if (inspect) {
    onPhase("inspecting_runtime_pack")
    try {
      // The archive's entries and manifest are large and only needed for verification.
      const { archiveEntries, manifest, ...rest } = inspector({ mcpRoot })
      inspection = rest
    } catch (error) {
      return { inspectionError: serializeError(error) }
    }
    if (!inspection.ok) return { inspection }
  }
  let prepared
  try {
    prepared = prepare({ mcpRoot, env, runtimeCacheDir, sourceIdentity, onPhase })
  } catch (error) {
    return { inspection, restoreError: { ...serializeError(error), ...publicationLock(error) } }
  }
  return { inspection, prepared }
}

// A restore that timed out on another process's publication lock: name the lock and, when its owner record says, the process holding it.
function publicationLock(error) {
  const match = LOCK_TIMEOUT.exec(error?.message ?? "")
  if (!match) return {}
  let pid = null
  try {
    pid = JSON.parse(readFileSync(path.join(match[1], "owner.json"), "utf8")).pid ?? null
  } catch {
    // The owner record is gone or unreadable: the lock is still named.
  }
  return { lock: { dir: match[1], pid } }
}

const JOBS = { resolve: resolveAdmissionInputs, runtime: prepareRuntimeInputs }

/** Run one job in this thread. */
export function runAdmissionJob(job, { onPhase } = {}) {
  const run = JOBS[job?.kind]
  if (typeof run !== "function") throw new TypeError(`unknown admission job: ${job?.kind}`)
  return run(job.input, { onPhase })
}

/** The worker side: answer one job on `port`, or every job when the worker is persistent. Does nothing outside a Desk admission worker, so importing this module elsewhere is harmless. */
export function attachAdmissionWorker(port, data) {
  if (!port || data?.deskAdmissionWorker !== true) return false
  port[data.persistent === true ? "on" : "once"]("message", (job) => {
    let reply
    try {
      // A phase goes to the thread that answers the host as soon as it is posted, even while this thread then blocks on a lock wait.
      reply = { ok: true, value: runAdmissionJob(job, { onPhase: (phase) => port.postMessage({ phase }) }) }
    } catch (error) {
      reply = { ok: false, error: serializeError(error) }
    }
    port.postMessage(reply)
  })
  return true
}

attachAdmissionWorker(parentPort, workerData)

/** Run one job on a fresh worker thread and resolve with its result. `onPhase(name)` hears each step the job reports while it runs. The worker never keeps the process alive. */
export function runInWorker(job, { createWorker = (url, options) => new Worker(url, options), onPhase = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const worker = createWorker(new URL(import.meta.url), { workerData: { deskAdmissionWorker: true } })
    worker.unref()
    let settled = false
    const finish = (settle, value) => {
      if (settled) return
      settled = true
      worker.terminate()
      settle(value)
    }
    worker.on("message", (reply) => {
      if (reply.phase !== undefined) return settled ? undefined : onPhase(reply.phase)
      return reply.ok ? finish(resolve, reply.value) : finish(reject, reviveError(reply.error))
    })
    worker.once("error", (error) => finish(reject, error))
    worker.once("exit", (code) => finish(reject, new Error(`the admission worker exited (code ${code}) before answering`)))
    worker.postMessage(job)
  })
}

/**
 * Runs resolve jobs on one worker that stays up between jobs. A ready session revalidates its inputs on every desk_status, and starting a worker thread for each took 40 to 60 ms on a busy Mac (more under heavier load), past the 50 ms desk_status waits, so the first status of a session often had to say the destination was still being verified. The job itself takes about a millisecond.
 * One job at a time: a job that arrives while one is running gets a fresh worker of its own, so a read that never returns holds up only its own job. The worker never keeps the process alive, and one that fails or exits is replaced on the next job.
 */
export function createResolveRunner({ createWorker = (url, options) => new Worker(url, options), fresh = runInWorker } = {}) {
  let worker = null
  let pending = null
  const start = () => {
    const started = createWorker(new URL(import.meta.url), { workerData: { deskAdmissionWorker: true, persistent: true } })
    started.unref()
    const settle = (outcome) => {
      const waiting = pending
      pending = null
      if (waiting !== null) outcome(waiting)
    }
    const lost = (error) => {
      if (worker === started) worker = null
      settle((waiting) => waiting.reject(error))
    }
    started.on("message", (reply) => {
      if (reply.phase !== undefined) return
      settle((waiting) => reply.ok ? waiting.resolve(reply.value) : waiting.reject(reviveError(reply.error)))
    })
    started.once("error", lost)
    started.once("exit", (code) => lost(new Error(`the admission worker exited (code ${code}) before answering`)))
    return started
  }
  return {
    run(job) {
      if (pending !== null) return fresh(job)
      worker ??= start()
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        worker.postMessage(job)
      })
    },
    close() {
      const running = worker
      worker = null
      running?.terminate()
    },
  }
}

/** An error as plain data that survives postMessage: name, message and its own fields (code, path, tried, and an activation failure's envelope). */
export function serializeError(error) {
  if (!(error instanceof Error)) return { name: "unknown", message: String(error) }
  return JSON.parse(JSON.stringify({ ...error, name: error.name, message: error.message }))
}

export function reviveError(plain) {
  return Object.assign(new Error(plain.message), plain)
}
