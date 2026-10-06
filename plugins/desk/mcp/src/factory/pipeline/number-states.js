// What every published number says about itself: `measured` (the whole value
// is known), `partial` (a value exists but part of what feeds it is missing or
// only counted in part) or `unavailable` (no value). This file holds the one
// table that says which `unavailable` fields change which numbers, and the one
// place a state is derived from a formula result, so the two cannot disagree.

export const NUMBER_STATES = Object.freeze(["measured", "partial", "unavailable"])

export const FORMULA_IDS = Object.freeze([
  "queue_before_start_ms",
  "active_time_ms",
  "active_in_lead_ms",
  "active_before_card_ms",
  "busy_time_ms",
  "parallelism",
  "concurrent_sessions",
  "concurrent_agents",
  "waits.human_wait_ms",
  "waits.permission_wait_ms",
  "waits.api_retry_ms",
  "waits.compaction_ms",
  "longest_wait",
  "lead_contributors",
  "flow_efficiency",
  "tool_calls_by_kind",
  "references.public_prs",
  "references.public_commits",
  "references.private_prs",
  "references.private_commits",
  "rework_signals.tool_failures",
  "rework_signals.tool_retries",
  "rework_signals.api_retries",
  "rework_signals.session_retouches",
  "tokens_total.total",
  "tokens_total.input",
  "tokens_total.output",
  "tokens_total.cache_read",
  "tokens_total.cache_write",
  "tokens_total.reasoning",
  "totals.tool_calls",
  "totals.tool_failures",
  "totals.model_requests",
  "totals.tokens",
  "totals.tokens.reasoning",
  "totals.subagent_dispatches",
  "attention",
])

// Results that take no flag, each with the reason.
export const NOT_FED = Object.freeze({
  status: "reads job transitions and observations, not session fields",
  lead_time_ms: "reads job transitions and observations; an open job's lead time is already marked censored",
  sessions: "counts the sessions bound to the job, which no session field changes",
  sessions_by_host: "counts the bound sessions by host, which no session field changes",
  unavailable: "lists the flags themselves",
  signoff: "reads the human's recorded answer to the delivery, not session fields",
  first_pass_yield: "reads the job's recorded returns and sign-off, not session fields",
  rework: "reads the job's recorded returns, not session fields",
})

const ACTIVE_FAMILY = Object.freeze([
  "active_time_ms",
  "active_in_lead_ms",
  "active_before_card_ms",
  "busy_time_ms",
  "parallelism",
  "concurrent_sessions",
  "concurrent_agents",
])
const WAITS = Object.freeze(["waits.human_wait_ms", "waits.permission_wait_ms", "waits.api_retry_ms", "waits.compaction_ms"])
const JOB_CLOCK = Object.freeze(["queue_before_start_ms", ...ACTIVE_FAMILY, ...WAITS, "longest_wait", "lead_contributors", "flow_efficiency"])
const TOKEN_FORMULAS = Object.freeze([
  "tokens_total.total",
  "tokens_total.input",
  "tokens_total.output",
  "tokens_total.cache_read",
  "tokens_total.cache_write",
  "tokens_total.reasoning",
  "totals.tokens",
])
const WAIT_FEED = Object.freeze(["longest_wait", "lead_contributors"])

const row = (unavailable, partial = [], feedsNothing) => Object.freeze({
  unavailable: Object.freeze(unavailable),
  partial: Object.freeze(partial),
  ...(feedsNothing === undefined ? {} : { feedsNothing }),
})
const nothing = (sentence) => row([], [], sentence)

export const FEEDS = Object.freeze({
  // Compaction intervals are filed under `turns` when facts are published, so a `turns` gap can drop them: compaction wait stays unavailable and the longest wait partial.
  turns: row([...ACTIVE_FAMILY, "flow_efficiency", "waits.compaction_ms"], ["lead_contributors", "longest_wait"]),
  tool_durations: row(["totals.tool_calls", "totals.tool_failures"], [...ACTIVE_FAMILY, "flow_efficiency", "tool_calls_by_kind", "rework_signals.tool_failures", "rework_signals.tool_retries"]),
  human_waits: row(["waits.human_wait_ms"], WAIT_FEED),
  permission_waits: row(["waits.permission_wait_ms"], WAIT_FEED),
  api_retries: row(["waits.api_retry_ms", "rework_signals.api_retries"], WAIT_FEED),
  compaction_waits: row(["waits.compaction_ms"], WAIT_FEED),
  commits: row(["references.public_commits", "references.private_commits"]),
  prs: row([], ["references.public_prs", "references.private_prs"]),
  tokens: row(TOKEN_FORMULAS),
  models: row(TOKEN_FORMULAS),
  requests: row(["totals.model_requests"]),
  reasoning_tokens: row(["tokens_total.reasoning", "totals.tokens.reasoning"]),
  agents: row(["totals.subagent_dispatches"]),
  tool_outcomes: row(["totals.tool_failures"], ["rework_signals.tool_failures"]),
  job_segments: row([], ["active_time_ms", "active_in_lead_ms", "busy_time_ms", "flow_efficiency", "tool_calls_by_kind", "rework_signals.tool_failures"]),
  job_offsets: row(JOB_CLOCK),
  entrypoint: nothing("is a label that no formula reads"),
  plugins: nothing("is a grouping key that reads as unknown when withheld"),
  ended_at: nothing("an open job's lead time is already marked censored"),
  ci_runs: nothing("no formula uses CI runs"),
  // `attention` reads the list through its own rule (a list present is a figure, a flag beside it says it is a lower bound, no list is no figure), so a flag only ever makes it partial; a missing list is stated by the formula as `not_recorded`.
  human_turns: row([], ["attention"]),
})

export function fieldsFeeding(formulaId, effect) {
  return Object.entries(FEEDS).filter(([, entry]) => entry[effect].includes(formulaId)).map(([field]) => field)
}

export function stateOf(result) {
  if (result.class === "unavailable") return "unavailable"
  return result.partial === true || result.censored === true ? "partial" : "measured"
}

export function reasonsOf(result) {
  const state = stateOf(result)
  if (state === "measured") return []
  const reasons = state === "unavailable"
    ? (result.reasons?.length > 0 ? result.reasons : [result.reason])
    : [...(result.partial_reasons ?? []), ...(result.censored === true ? ["censored"] : [])]
  return [...new Set(reasons)].sort()
}

export function withState(result) {
  const state = stateOf(result)
  const reasons = reasonsOf(result)
  if (state !== "measured" && reasons.length === 0) throw new Error(`a ${state} number has no reason`)
  return { ...result, state, reasons }
}

// Each result passes through `withState` here, and a result whose hand-set `state` or `reasons` differ from what `withState` derives throws, so a disagreement stops the build instead of being rewritten silently.
export function stated(result) {
  const derived = withState(result)
  if (derived.state !== result.state || JSON.stringify(derived.reasons) !== JSON.stringify(result.reasons)) throw new Error(`an outcome result disagrees with its derived state: ${result.state}`)
  return derived
}
