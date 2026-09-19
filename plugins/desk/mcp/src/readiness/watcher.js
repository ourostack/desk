// A backend must prove delivery, not infer it from elapsed time or file timestamps.
// The future query router consumes this fence plus generation coverage.
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
  const replay = controller.journal.replay()
  const reason = replay.certain === false ? replay.reason
    : result?.certain !== true ? result?.reason ?? "unproven_fence" : null
  if (reason !== null) await controller.markUncertain(reason)
  return { certain: reason === null, cursor: controller.journal.cursor, reason }
}
