import { inspectLocalDb, inspectStatusIndex } from "../db/status-read.js"
import { serializeError } from "./admission-worker.js"
import { rootStatus } from "./status-root.js"

export function inspectStatusInputs({ deskRoot, phase = "local", rootContext }) {
  if (phase === "root") return rootStatus(deskRoot, rootContext)
  if (phase === "local") return inspectLocalDb(deskRoot)
  if (phase === "index") return inspectStatusIndex(deskRoot)
  throw new TypeError(`unknown status inspection phase: ${phase}`)
}

export function attachStatusInspectionChild(port) {
  if (!port) return false
  // This dedicated reader owns no work after its parent closes IPC. Exit even
  // when a host preload has left timers or signal handlers in the process.
  port.once("disconnect", () => port.exit(0))
  port.on("message", (input) => {
    let reply
    try {
      reply = { ok: true, value: inspectStatusInputs(input) }
    } catch (error) {
      reply = { ok: false, error: serializeError(error) }
    }
    port.send(reply)
  })
  return true
}

attachStatusInspectionChild(process.send ? process : null)
