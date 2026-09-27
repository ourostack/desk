const CONTRIBUTOR_ORDER = Object.freeze([
  "active_time_ms",
  "queue_before_start_ms",
  "human_wait_ms",
  "permission_wait_ms",
  "api_retry_ms",
  "compaction_ms",
])

const LABELS = Object.freeze({
  active_time_ms: "Active time",
  queue_before_start_ms: "Queue before start",
  human_wait_ms: "Human wait",
  permission_wait_ms: "Permission wait",
  api_retry_ms: "API retry wait",
  compaction_ms: "Compaction wait",
})

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function metric(metricValue, suffix = " ms") {
  if (metricValue.class === "unavailable") return `unavailable (${metricValue.reason})`
  return `${metricValue.value}${suffix}${metricValue.censored ? " (censored)" : ""}`
}

function percentage(value) {
  return `${(value * 100).toFixed(2)}%`
}

function listedCounts(value, order = Object.keys(value).sort()) {
  const entries = order.filter((key) => value[key] !== undefined).map((key) => `${key} ${value[key]}`)
  return entries.length === 0 ? "none" : entries.join(", ")
}

function unavailableLines(formulas) {
  const lines = formulas.unavailable.value.map((entry) =>
    `- ${entry.field}: ${entry.reason} (${plural(entry.count, "session")}).`)
  lines.push(`- First-pass yield: unavailable (${formulas.first_pass_yield.reason}).`)
  return lines
}

function contributorLines(formulas) {
  const lead = formulas.lead_time_ms
  if (lead.class === "unavailable" || lead.value === 0) {
    return ["- Lead-time contributors unavailable."]
  }
  const candidates = [
    { key: "active_time_ms", metric: formulas.active_time_ms },
    { key: "queue_before_start_ms", metric: formulas.queue_before_start_ms },
    ...Object.entries(formulas.waits).map(([key, value]) => ({ key, metric: value })),
  ].filter((entry) => entry.metric.class !== "unavailable")
  candidates.sort((left, right) => right.metric.value - left.metric.value || CONTRIBUTOR_ORDER.indexOf(left.key) - CONTRIBUTOR_ORDER.indexOf(right.key))
  return candidates.slice(0, 2).map((entry) =>
    `- ${LABELS[entry.key]}: ${entry.metric.value} ms (${percentage(entry.metric.value / lead.value)} of lead time).`)
}

export function renderJobMarkdown({ timeline, formulas }) {
  const hostCounts = formulas.sessions_by_host.value
  const shared = formulas.sessions.value.shared
  const waits = formulas.waits
  const transitions = timeline.transitions.length === 0
    ? "none"
    : timeline.transitions.map((entry) => `${entry.to} at ${entry.offset_ms} ms`).join(", ")
  const references = formulas.references.value
  const longest = formulas.longest_wait.class === "unavailable"
    ? `- Longest single wait: unavailable (${formulas.longest_wait.reason}).`
    : `- Longest single wait: ${LABELS[`${formulas.longest_wait.value.kind}_ms`].toLowerCase()}, ${formulas.longest_wait.value.duration_ms} ms.`
  const contributors = contributorLines(formulas)

  return [
    `# Job ${timeline.job}`,
    "",
    "## What happened",
    "",
    `- Status: ${formulas.status.class === "unavailable" ? `unavailable (${formulas.status.reason})` : `${formulas.status.value} (${formulas.status.class})`}.`,
    `- Sessions: ${formulas.sessions.value.bound}; ${listedCounts(hostCounts)}; ${formulas.sessions.value.timeline} on the job clock.`,
    `- Shared work: ${plural(shared, "session")} shared with ${plural(timeline.sessions.reduce((total, session) => total + session.shared_with, 0), "other job")}.`,
    `- Lead time: ${metric(formulas.lead_time_ms)}.`,
    `- Queue before start: ${metric(formulas.queue_before_start_ms)}.`,
    `- Active time: ${metric(formulas.active_time_ms)}; busy time: ${metric(formulas.busy_time_ms)}; parallelism: ${metric(formulas.parallelism, "")}.`,
    `- Concurrent sessions: ${formulas.concurrent_sessions.class === "unavailable" ? metric(formulas.concurrent_sessions, "") : `maximum ${formulas.concurrent_sessions.value.maximum}, average ${formulas.concurrent_sessions.value.average.toFixed(2)}`}.`,
    `- Concurrent agents: ${formulas.concurrent_agents.class === "unavailable" ? metric(formulas.concurrent_agents, "") : `maximum ${formulas.concurrent_agents.value.maximum}, average ${formulas.concurrent_agents.value.average.toFixed(2)}`}.`,
    `- Waits: human ${metric(waits.human_wait_ms)}, permission ${metric(waits.permission_wait_ms)}, API retry ${metric(waits.api_retry_ms)}, compaction ${metric(waits.compaction_ms)}.`,
    `- Tool calls: ${listedCounts(formulas.tool_calls_by_kind.value)}.`,
    `- Public references: ${plural(references.public_prs, "pull request")} and ${plural(references.public_commits, "commit")}; private references counted: ${plural(references.private_prs, "pull request")} and ${plural(references.private_commits, "commit")}.`,
    `- Status transitions: ${transitions}.`,
    "",
    "## What mattered",
    "",
    ...contributors,
    longest,
    "",
    "## What was waste",
    "",
    "Not classified yet: the independent evaluator arrives in slice 2.",
    `- Candidate signals only: ${plural(formulas.rework_signals.tool_failures.value, "tool failure")}, ${plural(formulas.rework_signals.tool_retries.value, "tool retry", "tool retries")}, ${plural(formulas.rework_signals.api_retries.value, "API retry", "API retries")}, ${plural(formulas.rework_signals.session_retouches.value, "session re-touch")}.`,
    `- Wait signals: human ${metric(waits.human_wait_ms)}, permission ${metric(waits.permission_wait_ms)}, API retry ${metric(waits.api_retry_ms)}, compaction ${metric(waits.compaction_ms)}.`,
    "",
    "## What we could not see",
    "",
    ...unavailableLines(formulas),
    "",
  ].join("\n")
}

export function buildCoverage(sessions) {
  const hostCounts = new Map()
  const unavailableCounts = new Map()
  const pluginCounts = new Map()
  let bound = 0
  for (const session of sessions) {
    if (session.jobs.length > 0) bound += 1
    hostCounts.set(session.session.host, (hostCounts.get(session.session.host) ?? 0) + 1)
    for (const entry of session.unavailable) {
      const key = `${entry.field}\n${entry.reason}`
      unavailableCounts.set(key, (unavailableCounts.get(key) ?? 0) + 1)
    }
    for (const plugin of new Set(session.plugins.map((entry) => `${entry.name}\n${entry.version}`))) {
      pluginCounts.set(plugin, (pluginCounts.get(plugin) ?? 0) + 1)
    }
  }
  const total = sessions.length
  return {
    sessions_seen: total,
    sessions_with_facts: total,
    bound_sessions: bound,
    unattributed_sessions: total - bound,
    hosts: [...hostCounts.entries()].map(([host, count]) => ({ host, sessions: count })).sort((left, right) => compareText(left.host, right.host)),
    unavailable: [...unavailableCounts.entries()].map(([key, count]) => {
      const [field, reason] = key.split("\n")
      return { field, reason, sessions: count, rate: count / total }
    }).sort((left, right) => compareText(left.field, right.field) || compareText(left.reason, right.reason)),
    plugins: [...pluginCounts.entries()].map(([key, count]) => {
      const [name, version] = key.split("\n")
      return { name, version, sessions: count }
    }).sort((left, right) => compareText(left.name, right.name) || compareText(left.version, right.version)),
  }
}

export function renderIndexMarkdown(reports, coverage) {
  const sorted = [...reports].sort((left, right) => compareText(left.timeline.job, right.timeline.job))
  return [
    "# Factory report index",
    "",
    "## Jobs",
    "",
    "| Job | Lead time | Active time | Flow efficiency |",
    "| --- | ---: | ---: | ---: |",
    ...sorted.map(({ timeline, formulas }) => `| ${timeline.job} | ${metric(formulas.lead_time_ms)} | ${metric(formulas.active_time_ms)} | ${formulas.flow_efficiency.class === "unavailable" ? metric(formulas.flow_efficiency, "") : `${percentage(formulas.flow_efficiency.value)}${formulas.flow_efficiency.censored ? " (censored)" : ""}`} |`),
    "",
    "## Coverage",
    "",
    `- Sessions seen: ${coverage.sessions_seen}.`,
    `- Sessions with facts: ${coverage.sessions_with_facts}.`,
    `- Bound sessions: ${coverage.bound_sessions}.`,
    `- Unattributed sessions: ${coverage.unattributed_sessions}.`,
    ...coverage.hosts.map((entry) => `- Host ${entry.host}: ${plural(entry.sessions, "session")}.`),
    "",
    "### Unavailable evidence",
    "",
    ...coverage.unavailable.map((entry) => `- ${entry.field} / ${entry.reason}: ${entry.sessions} of ${coverage.sessions_with_facts} sessions (${percentage(entry.rate)}).`),
    "",
    "### Plugin versions",
    "",
    ...coverage.plugins.map((entry) => `- ${entry.name} ${entry.version}: ${plural(entry.sessions, "session")}.`),
    "",
  ].join("\n")
}

export function renderReadme() {
  return [
    "# Factory reports",
    "",
    "These files are generated deterministically from validated published session facts.",
    "",
    "- `index.md` lists job reports and coverage.",
    "- `jobs/<job>.md` answers the four factory questions.",
    "- `jobs/<job>.json` carries the normalized timeline and classed formulas.",
    "",
    "Published facts contain durations and offsets only. Missing evidence stays unavailable with its reason.",
    "",
  ].join("\n")
}
