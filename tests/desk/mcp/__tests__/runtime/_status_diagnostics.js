import { AsyncLocalStorage } from "node:async_hooks"
import { performance } from "node:perf_hooks"

const limitations = "Interval measurements, not request-only CPU: process CPU includes worker/background threads; main-thread CPU and event-loop active/idle include unrelated callbacks. Overlapping stages cannot be summed. Active time does not distinguish synchronous blocking from descheduling. Unsupported metrics are null."

export function createStatusDiagnostics({ enabled = false, metrics = {
  now: () => performance.now(),
  cpuUsage: () => process.cpuUsage(),
  threadCpuUsage: typeof process.threadCpuUsage === "function" ? () => process.threadCpuUsage() : null,
  eventLoopUtilization: typeof performance.eventLoopUtilization === "function" ? () => performance.eventLoopUtilization() : null,
} } = {}) {
  const requests = new Map()
  const stages = []
  const dropped = { requests: 0, stages: 0 }
  const scope = enabled ? new AsyncLocalStorage() : null
  const origin = enabled ? metrics.now() : null
  const read = (fn) => {
    try { return typeof fn === "function" ? fn() : null } catch { return null }
  }
  const sample = () => ({
    at: metrics.now() - origin,
    processCpu: read(metrics.cpuUsage),
    threadCpu: read(metrics.threadCpuUsage),
    eventLoop: read(metrics.eventLoopUtilization),
  })
  const cpuDelta = (start, end) => start && end ? { user: end.user - start.user, system: end.system - start.system } : null
  const delta = (start, end) => {
    const active = start.eventLoop && end.eventLoop ? end.eventLoop.active - start.eventLoop.active : null
    const idle = start.eventLoop && end.eventLoop ? end.eventLoop.idle - start.eventLoop.idle : null
    return {
      processCpuUs: cpuDelta(start.processCpu, end.processCpu),
      mainThreadCpuUs: cpuDelta(start.threadCpu, end.threadCpu),
      mainThreadEventLoop: active === null ? null : { activeMs: active, idleMs: idle, utilization: active + idle === 0 ? 0 : active / (active + idle) },
    }
  }
  const complete = (entry, start) => {
    const end = sample()
    entry.endMs = end.at
    entry.metrics = delta(start, end)
  }
  return {
    enabled,
    start(requestId) {
      if (!enabled || requests.has(requestId)) return
      if (requests.size >= 128) { dropped.requests++; return }
      const start = sample()
      requests.set(requestId, { start, entry: { requestId, startMs: start.at, endMs: null, metrics: null } })
    },
    finish(requestId) {
      const request = requests.get(requestId)
      if (request && request.entry.endMs === null) complete(request.entry, request.start)
    },
    run(requestId, operation) {
      return enabled ? scope.run(requests.has(requestId) ? requestId : null, operation) : operation()
    },
    stage(name, operation) {
      const requestId = scope?.getStore()
      if (requestId === undefined || requestId === null) return operation()
      if (stages.length >= 2048) { dropped.stages++; return operation() }
      const start = sample()
      const entry = { requestId, stage: name, startMs: start.at, endMs: null, metrics: null, outcome: "pending" }
      stages.push(entry)
      return (async () => {
        try {
          const value = await operation()
          entry.outcome = "ok"
          return value
        } catch (error) {
          entry.outcome = "error"
          throw error
        } finally {
          complete(entry, start)
        }
      })()
    },
    snapshot() {
      return { schemaVersion: 1, enabled, limitations, timeOrigin: "fixture-relative monotonic milliseconds",
        requests: [...requests.values()].map(({ entry }) => ({ ...entry })), stages: stages.map((entry) => ({ ...entry })), dropped: { ...dropped } }
    },
  }
}
