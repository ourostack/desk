// Preloaded with --import into a spawned Desk: on SIGUSR2 the process hits the two failures nothing inside Desk catches, an 'error' event with no listener (it throws) and a rejected promise nobody awaits.
import { EventEmitter } from "node:events"

// Crash only the MCP host, including bootstrap's stdio re-exec child; readiness children have a separate IPC lifetime. The idle proxy's server child also has an IPC channel (the focus handoff), and is the one that carries the handoff token, which Desk removes from its environment only after this preload has run.
if (typeof process.send !== "function" || process.env.DESK_FOCUS_HANDOFF_TOKEN) {
  process.stderr.write(`[crash-preload] armed pid ${process.pid}\n`)
  process.on("SIGUSR2", () => {
    setImmediate(() => new EventEmitter().emit("error", new Error("injected unhandled error event")))
    setImmediate(() => { Promise.reject(new Error("injected unhandled rejection")) })
  })
}
