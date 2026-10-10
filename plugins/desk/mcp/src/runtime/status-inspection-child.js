import { inspectLocalDb, inspectStatusIndex } from "../db/status-read.js"
import { serializeError } from "./admission-worker.js"

export function inspectStatusInputs({ deskRoot, phase = "local" }) {
  if (phase === "local") return inspectLocalDb(deskRoot)
  if (phase === "index") return inspectStatusIndex(deskRoot)
  throw new TypeError(`unknown status inspection phase: ${phase}`)
}

export function attachStatusInspectionChild(port) {
  if (!port) return false
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
