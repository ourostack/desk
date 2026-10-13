// Local Git reads for desk_status, run on a worker thread.
//
// Starting a process is synchronous in Node, even through the asynchronous child_process calls: the thread that asks waits until the operating system has created the process. On Windows that wait is usually a few milliseconds, but it took about 600 ms once on a CI runner, and desk_status asked from the thread that answers the host, so the call took 619 ms. Here the thread that asks is a worker, so the host's thread only posts a message.
//
// One worker serves every read of the process. It starts each Git process itself and waits for it asynchronously, so reads overlap as they did on the host's thread, and the process can still exit while a read is running. It keeps the process alive only while a read is waiting for its answer. It imports nothing but Node's own modules; it never imports index.js, which would start Desk inside the worker.

import { execFile } from "node:child_process"
import { parentPort, Worker, workerData } from "node:worker_threads"

const FAILED = { status: 1, stdout: "" }

/** Run one read from this thread: resolves with `{ status, stdout }`, where `status` is 0 only when Git ran and exited 0. Never rejects. Aborting `signal` kills the Git process, and the read then resolves as failed once that process has exited and its output has closed; a read asked with a signal that has already aborted starts no process. */
export function runGitRead({ root, args, env, timeoutMs }, { execGit = execFile, signal } = {}) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(FAILED)
    try {
      // Not execFile's own `signal` option: with it Node calls back as soon as it has sent the kill, while the process may still be working in the folder. A killed child calls back when it has closed.
      const kill = () => child?.kill()
      const child = execGit("git", ["-C", root, ...args], { encoding: "utf8", timeout: timeoutMs, env, windowsHide: true }, (error, stdout) => {
        signal?.removeEventListener("abort", kill)
        resolve(error || typeof stdout !== "string" ? FAILED : { status: 0, stdout })
      })
      signal?.addEventListener("abort", kill, { once: true })
    } catch {
      resolve(FAILED)
    }
  })
}

/** The worker side: answer each read on `port`. Does nothing outside a Desk Git read worker, so importing this module elsewhere is harmless. */
export function attachGitReadWorker(port, data, { execGit } = {}) {
  if (!port || data?.deskGitReadWorker !== true) return false
  const running = new Map()
  port.on("message", async ({ id, read, cancel }) => {
    if (cancel !== undefined) return running.get(cancel)?.abort()
    const controller = new AbortController()
    running.set(id, controller)
    const answer = await runGitRead(read, { execGit, signal: controller.signal })
    running.delete(id)
    port.postMessage({ id, ...answer })
  })
  return true
}

attachGitReadWorker(parentPort, workerData)

/**
 * `{ read, warm, settled, close }`. `read({ root, args, env, timeoutMs }, { signal })` resolves with `{ status, stdout }` and never rejects.
 * `signal` names the read's owner. A read asked after `signal` aborted starts no process and resolves as failed. Aborting `signal` during a read kills its Git process, and the read resolves as failed once that process has closed.
 * `settled(signal)` resolves when every read asked with `signal` has resolved, so an owner that aborts and then awaits it knows none of its Git processes is still running, for example inside a folder it is about to remove.
 * The worker starts at the first read. If it fails or exits, every read it had not answered resolves as failed, and the next read starts a new worker.
 * `onError(reason)` hears the first such failure only: a failed read answers the same as a repository with no remote, so a worker that cannot run must be said once.
 * `warm()` starts the worker ahead of the first read, without holding the process open, so that read does not also wait for a thread to start.
 * `close()` stops the worker; a later read starts another.
 * A read that fails because its worker was lost or closed resolves at once, without waiting for a Git process that worker had started; that process ends by itself or at its timeout.
 */
export function createGitReader({ createWorker = (url, options) => new Worker(url, options), onError = () => {} } = {}) {
  let worker = null
  let nextId = 0
  let reported = false
  const waiting = new Map()
  const owned = new WeakMap()

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

  const ask = (read, signal) => new Promise((resolve) => {
    const id = nextId += 1
    try {
      worker ??= start()
      const asked = worker
      // Runs only while the read waits: its answer, or the loss of its worker, removes this listener.
      const cancel = () => {
        try {
          asked.postMessage({ cancel: id })
        } catch {
          // A worker that cannot hear the cancel is ending, which resolves the read.
        }
      }
      waiting.set(id, (answer) => {
        signal?.removeEventListener("abort", cancel)
        resolve(answer)
      })
      worker.ref()
      worker.postMessage({ id, read })
      signal?.addEventListener("abort", cancel, { once: true })
    } catch (error) {
      waiting.delete(id)
      if (waiting.size === 0) worker?.unref()
      report(`the Git read worker could not take a read: ${error?.message ?? error}`)
      resolve(FAILED)
    }
  })

  return {
    read(read, { signal } = {}) {
      if (signal?.aborted) return Promise.resolve(FAILED)
      const asked = ask(read, signal)
      if (signal) {
        const reads = owned.get(signal) ?? new Set()
        owned.set(signal, reads)
        reads.add(asked)
        asked.then(() => reads.delete(asked))
      }
      return asked
    },
    warm() {
      try {
        worker ??= start()
        if (waiting.size === 0) worker.unref()
      } catch (error) {
        report(`the Git read worker could not start: ${error?.message ?? error}`)
      }
    },
    async settled(signal) {
      await Promise.all(owned.get(signal) ?? [])
    },
    async close() {
      const closing = worker
      drop(closing)
      await closing?.terminate()
    },
  }
}
