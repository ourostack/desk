// The task lifecycle: the eight states a task card's `status` may hold, and the
// two that end a task. Every part of Desk outside `src/factory/` imports this
// list. The factory keeps its own copies because it imports only `node:`
// modules and its own files; a test asserts those copies equal these lists.

export const LIFECYCLE_STATES = Object.freeze([
  "drafting", "processing", "validating", "collaborating", "paused", "blocked", "done", "cancelled",
])

export const TERMINAL_STATES = Object.freeze(["done", "cancelled"])

/** The error text for a status outside the eight, naming the value and listing the states. */
export function invalidStatusMessage(value) {
  const shown = typeof value === "string" ? JSON.stringify(value) : `${JSON.stringify(value) ?? String(value)}`
  return `invalid status ${shown}: status must be exactly one of ${LIFECYCLE_STATES.join(", ")}`
}
