import { pathToFileURL } from "node:url"
import { releaseRendezvous } from "./controller-server.js"
import { releaseSupervisor } from "./controller-process.js"

export function runControllerChild(proc = process, load = () => import("../server.js")) {
  let controller = null
  let options = null
  let closing = false
  async function close() {
    if (closing) return
    closing = true
    const deadline = setTimeout(() => proc.exit(1), 1000)
    try {
      await controller?.close()
      clearTimeout(deadline)
      proc.exit(0)
    } catch (error) {
      clearTimeout(deadline)
      proc.stderr.write(`[desk-mcp] controller child cleanup failed: ${error.message}\n`)
      proc.exit(1)
    }
  }
  // No host signal guessing: a captured signal leaves IPC connected; actual parent death closes it.
  proc.on("disconnect", () => {
    if (options) releaseSupervisor(options.supervisor)
    void close()
  })
  // This dedicated process always terminates; host capture semantics belong only to the parent MCP process.
  for (const signal of ["SIGTERM", "SIGINT"]) proc.on(signal, () => { void close() })
  proc.on("message", async (message) => {
    if (message.type === "close") { void close(); return }
    if (message.type !== "start" || options !== null) return
    options = message.options
    try {
      const runtime = await load()
      controller = await runtime.startControllerRuntime(options)
      if (closing || !proc.connected) {
        await controller.close()
        proc.exit(0)
        return
      }
      proc.send({ type: "ready", owner: controller.owner })
    } catch (error) {
      proc.stderr.write(`[desk-mcp] controller child failed: ${error.message}\n`)
      if (proc.connected) proc.send({ type: "error", message: error.message, code: error.code }, () => proc.exit(1))
      else proc.exit(1)
    }
  })
  proc.on("exit", () => {
    if (controller) releaseRendezvous({ stateDir: options.stateDir, endpoint: options.endpoint, owner: controller.owner, socket: controller.socket })
  })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runControllerChild()
