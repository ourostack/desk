function clone(value) {
  return value == null ? value : structuredClone(value)
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
    expected: clone(expected) ?? {},
    observed: clone(observed) ?? {},
    automatic_actions: Array.isArray(automaticActions) ? [...automaticActions] : [],
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
