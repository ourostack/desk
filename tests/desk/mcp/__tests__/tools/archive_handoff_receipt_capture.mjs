// Explicit preload for one owned IPC control; never a native Windows observation.
import { registerHooks } from "node:module"

const target = new URL("../../../../../plugins/desk/mcp/src/tools/archive-move.js", import.meta.url).href
registerHooks({
  load(url, context, nextLoad) {
    if (url !== target) return nextLoad(url, context)
    return { format: "module", shortCircuit: true, source: `
      export async function openArchiveMoveSession() {
        throw Object.assign(new Error("Owned synthetic capture refusal"), {
          code: "ARCHIVE_NATIVE_MOVE",
          handleReceipt: {
            scope: "synthetic_capture_refusal", capturedValidated: false, admissionValidated: false,
            cleanupConfirmed: true, cleanupFailure: false,
            events: [{ type: "capture_requested", sequence: 1 }, { type: "session_settled", sequence: 2 }],
            archiveMove: { released: false, closed: true, forced: false,
              movement: "not_released", retirement: "confirmed" }
          }
        })
      }
    ` }
  },
})
