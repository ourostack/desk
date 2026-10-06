// Helpers the three session derivers share: ordering, PR de-duplication, schema limits, plugin sanitising, `unavailable` entries, count validation and the `requested_model` rule. Pure functions with no host knowledge.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/` files.

import { isTaskSegment } from "./binding.js"
import { LIMITS, PATTERNS, validPluginSource } from "./schema.js"
import { shellEffects } from "./shell-git.js"

export function comparePrRefs(a, b) {
  if (a.repo === b.repo) return a.number - b.number
  return a.repo < b.repo ? -1 : 1
}

// Claude Code writes a `pr-link` line into the root transcript for every PR of the session, including the ones a subagent created. A `gitOperation.pr` with action `created` is the creating call; any other action (merged, ready, closed, edited) only saw the PR. So the worker whose call created the PR outranks any worker that only saw its link, and among refs of the same kind the lowest worker wins.
//
// A ref's `at` (the tool result's time) becomes `at_ms`, milliseconds from `session.startedAt`, kept only when it falls inside the session (`startedAt` to `derivedThrough`); among refs of the same kind and worker the earliest wins. Without a session, or a time, the ref has no `at_ms`.
export function dedupePrRefs(refs, session = {}) {
  const startedMs = timeMs(session.startedAt)
  const endMs = timeMs(session.derivedThrough)
  const atMs = (ref) => {
    const at = timeMs(ref.at)
    return at === null || startedMs === null || endMs === null || at < startedMs || at > endMs ? null : at - startedMs
  }
  const seen = new Map()
  for (const ref of refs) {
    const key = `${ref.repo}#${ref.number}`
    const held = seen.get(key)
    const timed = { ...ref, at_ms: atMs(ref) }
    if (held === undefined || outranks(timed, held)) seen.set(key, timed)
  }
  return [...seen.values()].map(({ repo, number, agent, at_ms: at }) => ({ repo, number, agent, ...(at === null ? {} : { at_ms: at }) })).sort(comparePrRefs)
}

// A creating ref beats a sighting, then the lower worker, then a known time beats none and the earlier time wins.
function outranks(ref, held) {
  if (ref.created !== held.created) return ref.created
  if (ref.agent !== held.agent) return ref.agent < held.agent
  if (held.at_ms === null) return ref.at_ms !== null
  return ref.at_ms !== null && ref.at_ms < held.at_ms
}

function timeMs(value) {
  if (typeof value !== "string") return null
  const ms = Date.parse(value)
  return Number.isSafeInteger(ms) ? ms : null
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

// Keeps only caller-supplied plugin entries that already match the schema, up to the cap.
export function sanitizePlugins(plugins, limits, unavailable) {
  const list = Array.isArray(plugins) ? plugins : []
  const valid = list.filter((entry) => typeof entry?.name === "string" && PATTERNS.pluginName.test(entry.name)
    && typeof entry.version === "string" && PATTERNS.semver.test(entry.version) && validPluginSource(entry))
  if (!Array.isArray(plugins) || valid.length !== list.length) addUnavailable(unavailable, "plugins", "source_unreadable")
  if (valid.length > limits.plugins) addUnavailable(unavailable, "plugins", "capped")
  return valid.slice(0, limits.plugins).map(({ name, version, source }) => ({ name, version, source: source ?? null }))
}

// Trims every derived array to what `validateLocalFacts` accepts: drops intervals whose end precedes their start, agents past the `n` range (with their intervals), and anything past a schema cap, recording each loss in `unavailable`. Pure, so tests can drive it with small limits.
export function applyLimits({ agents, intervals, models, prs }, unavailable, limits = LIMITS) {
  let keptAgents = agents
  let keptIntervals = intervals
  if (agents.length > limits.agents) {
    keptAgents = agents.slice(0, limits.agents)
    const keptNs = new Set(keptAgents.map((agent) => agent.n))
    keptIntervals = keptIntervals.filter((interval) => keptNs.has(interval.agent))
    addUnavailable(unavailable, "turns", "capped")
    addUnavailable(unavailable, "tool_durations", "capped")
    addUnavailable(unavailable, "agents", "capped")
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
  if (prs.length > limits.prs) addUnavailable(unavailable, "prs", "capped")
  const keptPrs = prs.slice(0, limits.prs).map(({ agent, ...ref }) => (keptNs.has(agent) ? { ...ref, agent } : ref))
  return { agents: keptAgents, intervals: keptIntervals, models: keptModels, prs: keptPrs }
}

/** A token or request count the schema accepts (a safe non-negative integer), else `null`. */
export const countOrNull = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null)

/** A usage count the log carries as a safe non-negative integer, else `null`. An absent value is `null` too, never 0; ask `usageAbsent` to tell absent from malformed. */
export const usageOrNull = (value) => countOrNull(value)

/** True when the log leaves the usage value out (`undefined` or `null`), so the caller flags `field_absent`; a present but malformed value is `source_unreadable` instead. */
export const usageAbsent = (value) => value === undefined || value === null

/** When no model was recorded, flags `models`, `tokens` and `requests` as `field_absent`, skipping any of the three that already carries a flag. */
export function flagEmptyUsage(unavailable, models) {
  if (models.length > 0) return
  for (const field of ["models", "tokens", "requests"]) {
    if (!unavailable.some((entry) => entry.field === field)) addUnavailable(unavailable, field, "field_absent")
  }
}

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

// `task_update` carries its status at the top level or in `frontmatter.status` (an object, or a JSON string). The frontmatter is read here and dropped.
function frontmatterOf(input) {
  let frontmatter = input.frontmatter
  if (typeof frontmatter === "string") {
    try {
      frontmatter = JSON.parse(frontmatter)
    } catch {
      return null
    }
  }
  return frontmatter !== null && typeof frontmatter === "object" && !Array.isArray(frontmatter) ? frontmatter : null
}

const STATUS_ONLY_INPUT_KEYS = new Set(["track", "slug", "person", "frontmatter"])

/** The `status` and `statusOnly` of a `task_update` input (ruling P1): status-only means no input key beyond track, slug, person and frontmatter, and a frontmatter holding a string `status` and nothing else. */
export function deskCallStatus(input) {
  const frontmatter = frontmatterOf(input)
  const nested = frontmatter?.status
  const status = input.status ?? (typeof nested === "string" ? nested : null)
  const statusOnly = Object.keys(input).every((key) => STATUS_ONLY_INPUT_KEYS.has(key))
    && frontmatter !== null && typeof nested === "string" && Object.keys(frontmatter).length === 1
  return { status, statusOnly }
}

/** A `task_focus` input as `{ track, slug }`, `{ clear: true }`, or `null` when it names no valid task folder. */
export function focusTarget(input) {
  if (input.clear === true) return { clear: true }
  return isTaskSegment(input.track) && isTaskSegment(input.slug) ? { track: input.track, slug: input.slug } : null
}

/** The focus a Desk tool call declares, as `{ track, slug }` or `{ clear: true }`, else `null`. `verb` is the tool's own name (`task_focus`, `task_create`, ...). A `task_focus` call declares its target; a `task_create` call declares the card it files only when its `focus` is the boolean `true`. */
export function declaredFocus(verb, input) {
  if (verb === "task_focus") return focusTarget(input)
  if (verb !== "task_create" || input.focus !== true) return null
  return isTaskSegment(input.track) && isTaskSegment(input.slug) ? { track: input.track, slug: input.slug } : null
}

/** The string entries of a `desk_save` input's `paths`. */
export function deskSavePaths(input) {
  return Array.isArray(input.paths) ? input.paths.filter((entry) => typeof entry === "string") : []
}

/** What one shell command does that binds a session: `commits` as `{ cwd, paths }` once per directory (the paths its `git add` and `git commit` name, in that directory), and the absolute files it `writes`. The command is tokenized once and dropped. */
export function shellBinding({ command, cwd, home, dialect }) {
  const effects = shellEffects({ command, cwd, home, dialect })
  const operands = [...effects.adds, ...effects.commits]
  const commits = []
  for (const { cwd: directory } of effects.commits) {
    if (commits.some((commit) => commit.cwd === directory)) continue
    commits.push({ cwd: directory, paths: [...new Set(operands.filter((entry) => entry.cwd === directory).flatMap((entry) => entry.paths))] })
  }
  return { commits, writes: effects.writes }
}
