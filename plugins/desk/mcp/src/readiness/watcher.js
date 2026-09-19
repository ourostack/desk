// A backend must prove delivery, not infer it from elapsed time or file timestamps.
// The future query router consumes this fence plus generation coverage.
import { JournalIntegrityError } from "./journal.js"

export async function fenceEvents({ controller, signal }) {
  signal?.throwIfAborted()
  if (typeof controller.fenceEvents === "function") return controller.fenceEvents({ signal })
  let result
  try {
    result = typeof controller.watcher?.fence === "function"
      ? await controller.watcher.fence({ signal, recordChange: controller.recordChange })
      : { certain: false, reason: "unsupported_flush" }
    signal?.throwIfAborted()
  } catch (error) {
    await controller.markUncertain(error.name === "AbortError" ? "fence_cancelled" : "watcher_failed")
    throw error
  }
  let replay
  try {
    replay = controller.journal.replay()
  } catch (error) {
    const failure = error instanceof JournalIntegrityError ? error : new JournalIntegrityError(error)
    await controller.markUncertain(failure.code)
    throw failure
  }
  const reason = replay.certain !== true ? replay.reason ?? "journal_uncertain"
    : result?.reason ?? (result?.certain !== true ? "unproven_fence" : null)
  if (reason !== null) await controller.markUncertain(reason)
  return { certain: reason === null, cursor: controller.journal.cursor, reason }
}
