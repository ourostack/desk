// Local Git reads for desk_status, run on a worker thread.
//
// Starting a process is synchronous in Node, even through the asynchronous child_process calls: the thread that asks waits until the operating system has created the process. On Windows that wait is usually a few milliseconds, but it took 597 ms once on a CI runner, and desk_status asked from the thread that answers the host, so the call took 619 ms. Here the thread that asks is a worker, so the host's thread only posts a message.
//
// One worker serves every read of the process, one read at a time. It keeps the process alive only while a read is waiting for its answer. It imports nothing but Node's own modules; it never imports index.js, which would start Desk inside the worker.

import { spawnSync } from "node:child_process"
import { parentPort, Worker, workerData } from "node:worker_threads"

const FAILED = { status: 1, stdout: "" }

/** Run one read in this thread: `{ status, stdout }`, where `status` is 0 only when Git ran and exited 0. */
export function runGitRead({ root, args, env, timeoutMs }, { spawnGit = spawnSync } = {}) {
  const result = spawnGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: timeoutMs, env, windowsHide: true })
  return result.status === 0 && typeof result.stdout === "string" ? { status: 0, stdout: result.stdout } : FAILED
}

/** The worker side: answer each read on `port`. Does nothing outside a Desk Git read worker, so importing this module elsewhere is harmless. */
export function attachGitReadWorker(port, data, { spawnGit } = {}) {
  if (!port || data?.deskGitReadWorker !== true) return false
  port.on("message", ({ id, read }) => {
    let reply
    try {
      reply = runGitRead(read, { spawnGit })
    } catch {
      reply = FAILED
    }
    port.postMessage({ id, ...reply })
  })
  return true
}

attachGitReadWorker(parentPort, workerData)

/**
 * `{ read }`, where `read({ root, args, env, timeoutMs })` resolves with `{ status, stdout }` and never rejects.
 * The worker starts at the first read. If it fails or exits, every read it had not answered resolves as failed, and the next read starts a new worker.
 */
export function createGitReader({ createWorker = (url, options) => new Worker(url, options) } = {}) {
  let worker = null
  let nextId = 0
  const waiting = new Map()

  const drop = (failed) => {
    if (worker !== failed) return
    worker = null
    for (const resolve of waiting.values()) resolve(FAILED)
    waiting.clear()
  }

  const start = () => {
    const started = createWorker(new URL(import.meta.url), { workerData: { deskGitReadWorker: true } })
    started.on("message", ({ id, status, stdout }) => {
      const resolve = waiting.get(id)
      waiting.delete(id)
      if (waiting.size === 0) started.unref()
      resolve?.({ status, stdout })
    })
    started.once("error", () => drop(started))
    started.once("exit", () => drop(started))
    return started
  }

  return {
    read(read) {
      return new Promise((resolve) => {
        const id = nextId += 1
        try {
          worker ??= start()
          waiting.set(id, resolve)
          worker.ref()
          worker.postMessage({ id, read })
        } catch {
          waiting.delete(id)
          if (waiting.size === 0) worker?.unref()
          resolve(FAILED)
        }
      })
    },
  }
}
