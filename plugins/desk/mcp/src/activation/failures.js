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

function snapshot(value) {
  return value == null ? value : deepFreeze(structuredClone(value))
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
