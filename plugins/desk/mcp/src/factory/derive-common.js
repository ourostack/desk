// Helpers the three session derivers share: ordering, PR de-duplication,
// schema limits, plugin sanitising, `unavailable` entries, count validation and
// the `requested_model` rule. Pure functions with no host knowledge.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { LIMITS, PATTERNS, validPluginSource } from "./schema.js"

export function comparePrRefs(a, b) {
  if (a.repo === b.repo) return a.number - b.number
  return a.repo < b.repo ? -1 : 1
}

// Claude Code writes a `pr-link` line into the root transcript for every PR of
// the session, including the ones a subagent created. A `gitOperation.pr` with
// action `created` is the creating call; any other action (merged, ready,
// closed, edited) only saw the PR. So the worker whose call created the PR outranks any worker that only saw its link, and among refs of
// the same kind the lowest worker wins.
export function dedupePrRefs(refs) {
  const seen = new Map()
  for (const ref of refs) {
    const key = `${ref.repo}#${ref.number}`
    const held = seen.get(key)
    if (held === undefined || (ref.created && !held.created) || (ref.created === held.created && ref.agent < held.agent)) seen.set(key, ref)
  }
  return [...seen.values()].map(({ repo, number, agent }) => ({ repo, number, agent })).sort(comparePrRefs)
}

export function compareByStart(a, b) {
  if (a.start < b.start) return -1
  if (a.start > b.start) return 1
  return 0
}

// The `unavailable` field an interval kind's data belongs to.
const INTERVAL_FIELD = Object.freeze({
  turn: "turns",
  human_wait: "human_waits",
  tool: "tool_durations",
  subagent: "tool_durations",
  api_retry: "api_retries",
})

export function addUnavailable(unavailable, field, reason) {
  if (!unavailable.some((entry) => entry.field === field && entry.reason === reason)) {
    unavailable.push({ field, reason })
  }
}

// Keeps only caller-supplied plugin entries that already match the schema,
// up to the cap.
export function sanitizePlugins(plugins, limits, unavailable) {
  const list = Array.isArray(plugins) ? plugins : []
  const valid = list.filter((entry) => typeof entry?.name === "string" && PATTERNS.pluginName.test(entry.name)
    && typeof entry.version === "string" && PATTERNS.semver.test(entry.version) && validPluginSource(entry))
  if (!Array.isArray(plugins) || valid.length !== list.length) addUnavailable(unavailable, "plugins", "source_unreadable")
  if (valid.length > limits.plugins) addUnavailable(unavailable, "plugins", "capped")
  return valid.slice(0, limits.plugins).map(({ name, version, source }) => ({ name, version, source: source ?? null }))
}

// Trims every derived array to what `validateLocalFacts` accepts: drops
// intervals whose end precedes their start, agents past the `n` range (with
// their intervals), and anything past a schema cap, recording each loss in
// `unavailable`. Pure, so tests can drive it with small limits.
export function applyLimits({ agents, intervals, models, prs }, unavailable, limits = LIMITS) {
  let keptAgents = agents
  let keptIntervals = intervals
  if (agents.length > limits.agents) {
    keptAgents = agents.slice(0, limits.agents)
    const keptNs = new Set(keptAgents.map((agent) => agent.n))
    keptIntervals = keptIntervals.filter((interval) => keptNs.has(interval.agent))
    addUnavailable(unavailable, "turns", "capped")
    addUnavailable(unavailable, "tool_durations", "capped")
  }

  const ordered = []
  for (const interval of keptIntervals) {
    if (interval.end < interval.start) addUnavailable(unavailable, INTERVAL_FIELD[interval.kind], "source_unreadable")
    else ordered.push(interval)
  }
  keptIntervals = ordered.sort(compareByStart)
  if (keptIntervals.length > limits.intervals) {
    for (const interval of keptIntervals.slice(limits.intervals)) {
      addUnavailable(unavailable, INTERVAL_FIELD[interval.kind], "capped")
    }
    keptIntervals = keptIntervals.slice(0, limits.intervals)
  }

  let keptModels = models
  if (models.length > limits.models) {
    // Keep the most-used models; `models` arrives sorted by id, so ties keep id order.
    const top = new Set([...models].sort((a, b) => b.requests - a.requests).slice(0, limits.models))
    keptModels = models.filter((model) => top.has(model))
    addUnavailable(unavailable, "models", "capped")
  }

  const keptNs = new Set(keptAgents.map((agent) => agent.n))
  const keptPrs = prs.slice(0, limits.prs).map(({ agent, ...ref }) => (keptNs.has(agent) ? { ...ref, agent } : ref))
  return { agents: keptAgents, intervals: keptIntervals, models: keptModels, prs: keptPrs }
}


/** A token or request count the schema accepts (a safe non-negative integer), else `null`. */
export const countOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/** The sum of two counts; `null` when either is unknown or the sum is unsafe. */
export function addNullable(total, value) {
  if (total === null || value === null) return null
  const sum = total + value
  return Number.isSafeInteger(sum) ? sum : null
}

/** Sets `agent.requested_model` only when `requested` is a valid model id that differs from the model the agent ran on. Returns the agent. */
export function withRequestedModel(agent, requested) {
  if (typeof requested === "string" && PATTERNS.modelId.test(requested) && requested !== agent.model) agent.requested_model = requested
  return agent
}
