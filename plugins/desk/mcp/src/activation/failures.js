function deepFreeze(value, seen = new WeakSet()) {
  if (value == null || typeof value !== "object" || Object.isFrozen(value)) {
    return value
  }
  if (seen.has(value)) {
    return value
  }
  seen.add(value)
  for (const nested of Object.values(value)) {
    deepFreeze(nested, seen)
  }
  return Object.freeze(value)
}

// A deep copy of plain data that keeps cycles, used instead of structuredClone: failures are built on Desk's degraded startup path, which must run on any Node, including releases older than 17 that have no structuredClone. Failure payloads are plain objects, arrays and primitives. Limits: any other object (Date, Map, Error) is copied as its own enumerable properties, so an Error loses its non-enumerable message, and functions are kept by reference. Keys are defined, not assigned, so an own "__proto__" key stays an ordinary property.
function clonePlain(value, seen) {
  if (value === null || typeof value !== "object") return value
  if (seen.has(value)) return seen.get(value)
  const copy = Array.isArray(value) ? [] : {}
  seen.set(value, copy)
  for (const key of Object.keys(value)) {
    Object.defineProperty(copy, key, {
      value: clonePlain(value[key], seen),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return copy
}

function snapshot(value) {
  return value == null ? value : deepFreeze(clonePlain(value, new Map()))
}

export function terminalFailure({
  phase,
  code,
  expected = {},
  observed = {},
  automaticActions = [],
  summary,
} = {}) {
  return {
    status: "terminal",
    phase,
    code,
    retryable: false,
    expected: snapshot(expected) ?? {},
    observed: snapshot(observed) ?? {},
    automatic_actions: Array.isArray(automaticActions) ? snapshot(automaticActions) : [],
    summary,
  }
}

export class ActivationFailure extends Error {
  constructor(payload = {}) {
    super(payload.summary)
    this.name = "ActivationFailure"
    Object.assign(this, terminalFailure(payload))
    if (Array.isArray(payload.diagnostics)) {
      this.diagnostics = payload.diagnostics.map((diagnostic) => ({ ...diagnostic }))
    }
  }
}
