import { ENUMS } from "../schema.js"

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}

function compareValues(...values) {
  for (const value of values) {
    if (value !== 0) return value
  }
  return 0
}

function enumIndex(values, value) {
  const index = values.indexOf(value)
  return index === -1 ? values.length : index
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

export function normalizePublished(value) {
  const normalized = structuredClone(value)
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
    job.basis.sort((left, right) => enumIndex(ENUMS.jobBasis, left) - enumIndex(ENUMS.jobBasis, right))
    job.transitions.sort((left, right) => compareValues(left.offset_ms - right.offset_ms, enumIndex(ENUMS.jobStatus, left.to) - enumIndex(ENUMS.jobStatus, right.to)))
  })
  normalized.jobs.sort((left, right) => compareText(left.job, right.job))
  normalized.unavailable.sort((left, right) => compareValues(compareText(left.field, right.field), compareText(left.reason, right.reason)))
  return normalized
}
