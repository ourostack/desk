const ACTIVE_STATES = [
  "CONTROL_READY",
  "LEXICAL_CONVERGING",
  "LEXICAL_READY",
  "SEMANTIC_CONVERGING",
  "READY",
]

const NEXT = new Map([
  ["RESOLVING", new Set(["ACQUIRING", "VERIFYING", "RECOVERING", "TERMINAL"])],
  ["ACQUIRING", new Set(["VERIFYING", "RECOVERING", "TERMINAL"])],
  ["VERIFYING", new Set(["CONTROL_READY", "RECOVERING", "TERMINAL"])],
  ["CONTROL_READY", new Set(["LEXICAL_CONVERGING", "LEXICAL_READY", "RECOVERING", "TERMINAL"])],
  ["LEXICAL_CONVERGING", new Set(["LEXICAL_READY", "RECOVERING", "TERMINAL"])],
  ["LEXICAL_READY", new Set(["SEMANTIC_CONVERGING", "READY", "RECOVERING", "TERMINAL"])],
  ["SEMANTIC_CONVERGING", new Set(["READY", "RECOVERING", "TERMINAL"])],
  ["READY", new Set(["LEXICAL_CONVERGING", "SEMANTIC_CONVERGING", "RECOVERING", "TERMINAL"])],
  ["RECOVERING", new Set(["CONTROL_READY", "LEXICAL_CONVERGING", "SEMANTIC_CONVERGING", "READY", "TERMINAL"])],
])

for (const state of ACTIVE_STATES) {
  NEXT.get(state).add("RECOVERING")
  NEXT.get(state).add("TERMINAL")
}

export function transitionReadiness(current, next) {
  if (!NEXT.get(current)?.has(next)) {
    throw new Error(`illegal readiness transition: ${current} -> ${next}`)
  }
  return next
}

export function readinessStates() {
  return Object.freeze([...NEXT.keys(), "TERMINAL"])
}
