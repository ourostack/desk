import { ENUMS } from "../schema.js"
import { addUnavailable, flagEmptyUsage } from "../derive-common.js"
import { hostFlagsFor } from "../host-flags.js"

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

function compareValues(...values) {
  for (const value of values) {
    if (value !== 0) return value
  }
  return 0
}

// Unknown (null) offsets sort after every known one.
function compareNullableNumber(left, right) {
  if (left === null) return right === null ? 0 : 1
  if (right === null) return -1
  return left - right
}

function enumIndex(values, value) {
  return values.indexOf(value)
}

function sortedObject(value) {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)))
}

export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort(compareText).map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

// An old (`/1`) file has no flags for what its host never recorded. Add them so the absent value is not read as a measured zero.
function addLegacyFlags(normalized) {
  // Human turns did not exist at `/1`: an old file is from before the record, and a flag for them would put it in the period.
  for (const flag of hostFlagsFor(normalized.session.host, normalized.session).filter((entry) => entry.field !== "human_turns")) addUnavailable(normalized.unavailable, flag.field, flag.reason)
  flagEmptyUsage(normalized.unavailable, normalized.models)
}

export function normalizePublished(value) {
  const normalized = structuredClone(value)
  if (String(normalized.schema).endsWith("/1")) addLegacyFlags(normalized)
  normalized.plugins.sort((left, right) => compareValues(compareText(left.name, right.name), compareText(left.version, right.version)))
  normalized.models.sort((left, right) => compareText(left.id, right.id))
  normalized.agents.sort((left, right) => left.n - right.n)
  normalized.intervals.sort((left, right) => compareValues(
    left.start_ms - right.start_ms,
    left.end_ms - right.end_ms,
    enumIndex(ENUMS.intervalKind, left.kind) - enumIndex(ENUMS.intervalKind, right.kind),
    left.agent - right.agent,
    compareText(left.tool ?? "", right.tool ?? ""),
    compareText(left.outcome ?? "", right.outcome ?? ""),
  ))
  normalized.counts.tool_calls = sortedObject(normalized.counts.tool_calls)
  normalized.counts.tool_failures = sortedObject(normalized.counts.tool_failures)
  normalized.refs.prs.sort((left, right) => compareValues(compareText(left.repo, right.repo), left.number - right.number))
  normalized.refs.commits.sort((left, right) => compareValues(compareText(left.sha, right.sha), compareText(left.repo, right.repo)))
  normalized.jobs.forEach((job) => {
    if (Object.hasOwn(job, "agents")) job.agents.sort((left, right) => left - right)
    job.basis.sort((left, right) => enumIndex(ENUMS.jobBasis, left) - enumIndex(ENUMS.jobBasis, right))
    job.transitions.sort((left, right) => compareValues(compareNullableNumber(left.offset_ms, right.offset_ms), enumIndex(ENUMS.jobStatus, left.to) - enumIndex(ENUMS.jobStatus, right.to)))
  })
  normalized.jobs.sort((left, right) => compareText(left.job, right.job))
  if (Object.hasOwn(normalized, "outcomes")) normalized.outcomes.sort((left, right) => compareText(left.job, right.job))
  normalized.unavailable.sort((left, right) => compareValues(compareText(left.field, right.field), compareText(left.reason, right.reason)))
  return normalized
}
