import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import { reviveError } from "./admission-worker.js"

const childEntry = fileURLToPath(new URL("./status-inspection-child.js", import.meta.url))
const ownedInspections = new WeakMap()

export function waitForStatusInspection(signal) {
  return ownedInspections.get(signal)?.wait() ?? Promise.resolve()
}

// SQLite and sqlite-vec cannot safely share a worker thread on our supported
// Windows native runtime. This disposable child owns only read-only inspection;
// the session's single status run owns its lifetime, not each tools/call.
export function inspectStatusDb(deskRoot, { signal, phase = "local", spawn = fork } = {}) {
  const reader = createStatusInspection(deskRoot, { signal, spawn })
  return reader.inspect(phase).finally(() => reader.close())
}

export function createStatusInspection(deskRoot, {
  signal, spawn = fork, closeGraceMs = 100, terminateGraceMs = 100, killGraceMs = 200,
} = {}) {
  signal?.throwIfAborted()
  const child = spawn(childEntry, [], {
    execArgv: [], stdio: ["ignore", "ignore", "inherit", "ipc"],
    windowsHide: true, serialization: "advanced",
  })
  let pending = null
  let failure = null
  let closing = false
  let ended = false
  let resolveClosed
  const closed = new Promise((resolve) => { resolveClosed = resolve })
  let terminationTimer = null
  const resource = { pid: child.pid ?? null, exited: false, signals: [], failures: [] }
  const wait = async () => {
    const outcome = await closed
    if (outcome.error) throw outcome.error
  }
  if (signal) ownedInspections.set(signal, { child, wait })
  const nonexit = () => {
    terminationTimer = null
    const error = Object.assign(new Error(`status inspection child did not exit after bounded termination (pid ${resource.pid})`), {
      code: "status_reader_not_exited", pid: resource.pid,
      signals: [...resource.signals], failures: [...resource.failures],
    })
    pending?.reject(error)
    pending = null
    // Keep the exact child and rejected wait in ownedInspections until its real
    // exit. A replacement must fail rather than overlap an unaccounted reader.
    resolveClosed({ error })
  }
  const terminate = (name, next, ms) => {
    resource.signals.push(name)
    try {
      if (!child.kill(name)) {
        resource.failures.push(`${name}: child.kill returned false`)
        failure ??= Object.assign(new Error(`status inspection child termination failed (pid ${resource.pid}, ${name})`), {
          code: "status_reader_termination_failed", pid: resource.pid, signal: name,
        })
      }
    } catch (error) {
      resource.failures.push(`${name}: ${error.message}`)
      failure ??= Object.assign(new Error(`status inspection child termination failed (pid ${resource.pid}, ${name}): ${error.message}`), {
        code: "status_reader_termination_failed", pid: resource.pid, signal: name,
      })
    }
    if (!ended) terminationTimer = setTimeout(next, ms)
  }
  const force = () => {
    terminationTimer = null
    terminate("SIGKILL", nonexit, killGraceMs)
  }
  const graceful = () => {
    terminationTimer = null
    terminate("SIGTERM", force, terminateGraceMs)
  }
  const stop = (error) => {
    failure ??= error
    if (ended || closing) return
    closing = true
    graceful()
  }
  const abort = () => stop(signal.reason)
  signal?.addEventListener("abort", abort, { once: true })
  child.once("error", stop)
  child.on("message", (message) => {
    if (!pending) return stop(new Error("status inspection child sent an unexpected reply"))
    const reply = pending
    pending = null
    if (message?.ok === true) reply.resolve(message.value)
    else if (message?.ok === false) reply.reject(reviveError(message.error))
    else {
      const error = new Error("status inspection child sent an invalid reply")
      reply.reject(error)
      stop(error)
    }
  })
  const finish = (code, exitSignal) => {
    if (ended) return
    ended = true
    resource.exited = true
    clearTimeout(terminationTimer)
    terminationTimer = null
    signal?.removeEventListener("abort", abort)
    if (signal) ownedInspections.delete(signal)
    failure ??= closing && (code === 0 || resource.signals.includes(exitSignal)) ? null :
      new Error(`status inspection child exited before completing (code ${code})`)
    if (pending && failure === null) failure = new Error("status inspection child exited before completing its request")
    pending?.reject(failure)
    pending = null
    resolveClosed({ error: null })
  }
  child.once("exit", finish)
  child.once("close", finish)
  return {
    resource,
    inspect(phase, rootContext) {
      signal?.throwIfAborted()
      if (ended) return Promise.reject(failure ?? new Error("status inspection already closed"))
      if (pending) return Promise.reject(new Error("status inspection already running"))
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        child.send({ deskRoot, phase, rootContext }, (error) => { if (error) stop(error) })
      })
    },
    async close() {
      if (!closing && !ended) {
        closing = true
        terminationTimer = setTimeout(graceful, closeGraceMs)
        try {
          child.disconnect()
        } catch (error) {
          failure ??= error
          clearTimeout(terminationTimer)
          graceful()
        }
      }
      await wait()
      if (failure !== null) throw failure
    },
  }
}
