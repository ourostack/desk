// The task lifecycle: the eight states a task card's `status` may hold, and the
// two that end a task. Every part of Desk outside `src/factory/` imports this
// list. The factory keeps its own copies because it imports only `node:`
// modules and its own files; a test asserts those copies equal these lists.
// Dependency-free, so the status migration's script can run it from the
// installed plugin.

export const LIFECYCLE_STATES = Object.freeze([
  "drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled",
])

export const TERMINAL_STATES = Object.freeze(["done", "cancelled"])

// Ghost statuses that real cards carry, folded (lower case, one space between words), and the state each one means.
const GHOST_STATUSES = Object.freeze({
  active: "processing",
  doing: "processing",
  "in progress": "processing",
  planning: "drafting",
  backlog: "drafting",
  "needs review": "collaborating",
  waiting: "blocked",
})

/**
 * normalizeStatus(value) -> { status, known }
 *
 * A lifecycle state returns itself. A value that folds to a lifecycle state or to a ghost status returns the state it
 * means. Folding lower-cases the value and treats `-`, `_` and whitespace as one separator. Anything else, including
 * a value that is not a string, returns `{ status: null, known: false }`: the caller reports it and never guesses.
 */
export function normalizeStatus(value) {
  if (typeof value !== "string") return { status: null, known: false }
  if (LIFECYCLE_STATES.includes(value)) return { status: value, known: true }
  const folded = value.trim().toLowerCase().replace(/[-_\s]+/gu, " ")
  if (LIFECYCLE_STATES.includes(folded)) return { status: folded, known: true }
  if (Object.hasOwn(GHOST_STATUSES, folded)) return { status: GHOST_STATUSES[folded], known: true }
  return { status: null, known: false }
}

/** The error text for a status outside the eight, naming the value and listing the states. */
export function invalidStatusMessage(value) {
  const shown = typeof value === "string" ? JSON.stringify(value) : `${JSON.stringify(value) ?? String(value)}`
  return `invalid status ${shown}: status must be exactly one of ${LIFECYCLE_STATES.join(", ")}`
}
