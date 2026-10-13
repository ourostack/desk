// Local Git reads for desk_status, run on a worker thread.
//
// Starting a process is synchronous in Node, even through the asynchronous child_process calls: the thread that asks waits until the operating system has created the process. On Windows that wait is usually a few milliseconds, but it took about 600 ms once on a CI runner, and desk_status asked from the thread that answers the host, so the call took 619 ms. Here the thread that asks is a worker, so the host's thread only posts a message.
//
// One worker serves every read of the process. It starts each Git process itself and waits for it asynchronously, so reads overlap as they did on the host's thread, and the process can still exit while a read is running. It keeps the process alive only while a read is waiting for its answer. It imports nothing but Node's own modules; it never imports index.js, which would start Desk inside the worker.

import { execFile } from "node:child_process"
import { parentPort, Worker, workerData } from "node:worker_threads"

const FAILED = { status: 1, stdout: "" }

/** Run one read from this thread: resolves with `{ status, stdout }`, where `status` is 0 only when Git ran and exited 0. Never rejects. */
export function runGitRead({ root, args, env, timeoutMs }, { execGit = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      execGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: timeoutMs, env, windowsHide: true }, (error, stdout) => {
        resolve(error || typeof stdout !== "string" ? FAILED : { status: 0, stdout })
      })
    } catch {
      resolve(FAILED)
    }
  })
}

/** The worker side: answer each read on `port`. Does nothing outside a Desk Git read worker, so importing this module elsewhere is harmless. */
export function attachGitReadWorker(port, data, { execGit } = {}) {
  if (!port || data?.deskGitReadWorker !== true) return false
  port.on("message", async ({ id, read }) => {
    port.postMessage({ id, ...await runGitRead(read, { execGit }) })
  })
  return true
}

attachGitReadWorker(parentPort, workerData)

/**
 * `{ read, close }`. `read({ root, args, env, timeoutMs })` resolves with `{ status, stdout }` and never rejects.
 * The worker starts at the first read. If it fails or exits, every read it had not answered resolves as failed, and the next read starts a new worker.
 * `onError(reason)` hears the first such failure only: a failed read answers the same as a repository with no remote, so a worker that cannot run must be said once.
 * `close()` stops the worker; a later read starts another.
 */
export function createGitReader({ createWorker = (url, options) => new Worker(url, options), onError = () => {} } = {}) {
  let worker = null
  let nextId = 0
  let reported = false
  const waiting = new Map()

  const report = (reason) => {
    if (reported) return
    reported = true
    try {
      onError(reason)
    } catch {
      // A logger that fails must not fail the read.
    }
  }

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
    started.once("error", (error) => {
      if (worker === started) report(`the Git read worker failed: ${error?.message ?? error}`)
      drop(started)
    })
    started.once("exit", (code) => {
      if (worker === started) report(`the Git read worker exited (code ${code})`)
      drop(started)
    })
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
        } catch (error) {
          waiting.delete(id)
          if (waiting.size === 0) worker?.unref()
          report(`the Git read worker could not take a read: ${error?.message ?? error}`)
          resolve(FAILED)
        }
      })
    },
    async close() {
      const closing = worker
      drop(closing)
      await closing?.terminate()
    },
  }
}
