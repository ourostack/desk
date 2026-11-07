// Opt-in #581 stage diagnostic: the gate and the request-scoped hand-off for settled stage summaries.
// Observational only; grants no authority and changes no default behavior.
import { AsyncLocalStorage } from "node:async_hooks"
import { types } from "node:util"

export const NATIVE_STAGES = Object.freeze(["start", "compiled", "verified", "request_read", "baseline_done"])
export const NATIVE_STAGE_MAX_US = 900_000_000

function data(object, key) {
  if (object === null || typeof object !== "object" || types.isProxy(object)) return undefined
  const descriptor = Object.getOwnPropertyDescriptor(object, key)
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined
}

/** Descriptor-only reads; every control must be exactly present. Never invokes a getter. */
export function nativeStageTraceEnabled(env) {
  return data(env, "CI") === "true" && data(env, "GITHUB_ACTIONS") === "true" &&
    data(env, "DESK_BLACKBOX_NATIVE_RECEIPT_TRACE") === "1" && data(env, "DESK_BLACKBOX_NATIVE_STAGE_TRACE") === "1"
}

const scope = new AsyncLocalStorage()

/** Runs one tool call with its own summary slot; concurrent calls never share one. */
export function runWithNativeStageScope(callback) {
  const store = { summaries: [] }
  return scope.run(store, () => callback(store))
}

export function recordNativeStageSummary(summary) {
  const store = scope.getStore()
  if (store && store.summaries.length < 2) store.summaries.push(summary)
}
