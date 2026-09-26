// Admission work that can block, run on a worker thread so the thread that answers the host never waits for it.
//
// Two jobs: "resolve" (the desk root, the activation config, the readiness policy and the state branch, all synchronous file reads) and "runtime" (inspecting the offline runtime pack, which hashes and unpacks its archive, and restoring it into the runtime cache, which can wait up to 30 s on another process's publication lock). Each job runs in a fresh worker; its result is plain data, and errors come back as plain objects with their code and fields.
//
// The worker imports only dependency-free modules. It never imports index.js, which would start Desk inside the worker.

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

const LOCK_TIMEOUT = /^atomic publication lock timed out: (.+)$/u

/** The root and activation inputs of one admission attempt. Failures are returned, not thrown: `rootError` stops admission, `activationError` stops it after the root. */
export function resolveAdmissionInputs({ args, env, cwd, homeDir, injectedReadinessPolicy }) {
  let root
  try {
    root = resolveStartupDeskRoot({ args, env, homeDir })
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
}) {
  let inspection = null
  if (inspect) {
    try {
      // The archive's entries and manifest are large and only needed for verification.
      const { archiveEntries, manifest, ...rest } = inspector({ mcpRoot })
      inspection = rest
    } catch (error) {
      return { inspectionError: serializeError(error) }
    }
    if (!inspection.ok) return { inspection }
  }
  try {
    return { inspection, prepared: prepare({ mcpRoot, env, runtimeCacheDir, sourceIdentity }) }
  } catch (error) {
    return { inspection, restoreError: { ...serializeError(error), ...publicationLock(error) } }
  }
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
export function runAdmissionJob(job) {
  const run = JOBS[job?.kind]
  if (typeof run !== "function") throw new TypeError(`unknown admission job: ${job?.kind}`)
  return run(job.input)
}

/** The worker side: answer one job on `port`. Does nothing outside a Desk admission worker, so importing this module elsewhere is harmless. */
export function attachAdmissionWorker(port, data) {
  if (!port || data?.deskAdmissionWorker !== true) return false
  port.once("message", (job) => {
    let reply
    try {
      reply = { ok: true, value: runAdmissionJob(job) }
    } catch (error) {
      reply = { ok: false, error: serializeError(error) }
    }
    port.postMessage(reply)
  })
  return true
}

attachAdmissionWorker(parentPort, workerData)

/** Run one job on a fresh worker thread and resolve with its result. The worker never keeps the process alive. */
export function runInWorker(job, { createWorker = (url, options) => new Worker(url, options) } = {}) {
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
    worker.once("message", (reply) => (reply.ok ? finish(resolve, reply.value) : finish(reject, reviveError(reply.error))))
    worker.once("error", (error) => finish(reject, error))
    worker.once("exit", (code) => finish(reject, new Error(`the admission worker exited (code ${code}) before answering`)))
    worker.postMessage(job)
  })
}

/** An error as plain data that survives postMessage: name, message and its own fields (code, path, tried, and an activation failure's envelope). */
export function serializeError(error) {
  if (!(error instanceof Error)) return { name: "unknown", message: String(error) }
  return JSON.parse(JSON.stringify({ ...error, name: error.name, message: error.message }))
}

export function reviveError(plain) {
  return Object.assign(new Error(plain.message), plain)
}
