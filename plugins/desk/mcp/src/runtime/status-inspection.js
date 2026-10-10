import { fork } from "node:child_process"
import { fileURLToPath } from "node:url"
import { reviveError } from "./admission-worker.js"

const childEntry = fileURLToPath(new URL("./status-inspection-child.js", import.meta.url))
const ownedInspections = new WeakMap()

export function waitForStatusInspection(signal) {
  return ownedInspections.get(signal) ?? Promise.resolve()
}

// SQLite and sqlite-vec cannot safely share a worker thread on our supported
// Windows native runtime. This disposable child owns only read-only inspection;
// the session's single status run owns its lifetime, not each tools/call.
export function inspectStatusDb(deskRoot, { signal, phase = "local", spawn = fork } = {}) {
  const reader = createStatusInspection(deskRoot, { signal, spawn })
  return reader.inspect(phase).finally(() => reader.close())
}

export function createStatusInspection(deskRoot, { signal, spawn = fork } = {}) {
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
  if (signal) ownedInspections.set(signal, closed)
  const stop = (error) => {
    failure ??= error
    child.kill()
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
  const finish = (code) => {
    if (ended) return
    ended = true
    signal?.removeEventListener("abort", abort)
    if (signal) ownedInspections.delete(signal)
    failure ??= closing && code === 0 ? null :
      new Error(`status inspection child exited before completing (code ${code})`)
    pending?.reject(failure)
    pending = null
    resolveClosed()
  }
  child.once("exit", finish)
  child.once("close", finish)
  return {
    inspect(phase) {
      signal?.throwIfAborted()
      if (ended) return Promise.reject(failure ?? new Error("status inspection already closed"))
      if (pending) return Promise.reject(new Error("status inspection already running"))
      return new Promise((resolve, reject) => {
        pending = { resolve, reject }
        child.send({ deskRoot, phase }, (error) => { if (error) stop(error) })
      })
    },
    async close() {
      if (!closing && !ended) {
        closing = true
        child.disconnect()
      }
      await closed
      if (failure !== null) throw failure
    },
  }
}
