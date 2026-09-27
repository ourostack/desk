const LABELS = Object.freeze({
  active_in_lead_ms: "Active time inside the lead-time window",
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

// The evidence class plus any qualifier a reader needs to weigh the number.
function qualifiers(value) {
  const parts = [value.class]
  if (value.censored) parts.push("censored")
  if (value.partial) parts.push(`partial: ${plural(value.uncovered_sessions, "session")} uncovered`)
  return parts.join(", ")
}

function unavailableText(value) {
  return value.reasons === undefined ? `unavailable (${value.reason})` : `unavailable (${value.reason}: ${value.reasons.join(", ")})`
}

function metric(value, suffix = " ms") {
  if (value.class === "unavailable") return unavailableText(value)
  return `${value.value}${suffix} (${qualifiers(value)})`
}

function percentage(value) {
  return `${(value * 100).toFixed(2)}%`
}

function flowText(value) {
  return value.class === "unavailable" ? unavailableText(value) : `${percentage(value.value)} (${qualifiers(value)})`
}

function concurrencyText(value) {
  if (value.class === "unavailable") return unavailableText(value)
  return `maximum ${value.value.maximum}, average ${value.value.average.toFixed(2)} (${qualifiers(value)})`
}

function signalText(value, singular, pluralForm) {
  if (value.class === "unavailable") return `${pluralForm} ${unavailableText(value)}`
  return value.partial ? `${plural(value.value, singular, pluralForm)} (partial: ${plural(value.uncovered_sessions, "session")} uncovered)` : plural(value.value, singular, pluralForm)
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
  const contributors = formulas.lead_contributors
  if (contributors.class === "unavailable") return [`- Lead-time contributors: ${unavailableText(contributors)}.`]
  return contributors.value.slice(0, 2).map((entry) => {
    const detail = qualifiers({ class: contributors.class, censored: contributors.censored, partial: entry.partial, uncovered_sessions: entry.uncovered_sessions })
    return `- ${LABELS[entry.key]}: ${entry.value_ms} ms (${percentage(entry.share)} of lead time; ${detail}).`
  })
}

function waitsText(waits) {
  return `human ${metric(waits.human_wait_ms)}, permission ${metric(waits.permission_wait_ms)}, API retry ${metric(waits.api_retry_ms)}, compaction ${metric(waits.compaction_ms)}`
}

function transitionText(entry) {
  return entry.offset_ms === null ? `${entry.to} at an unknown offset` : `${entry.to} at ${entry.offset_ms} ms`
}

export function renderJobMarkdown({ timeline, formulas }) {
  const hostCounts = formulas.sessions_by_host.value
  const sessions = formulas.sessions.value
  const transitions = timeline.transitions.length === 0 ? "none" : timeline.transitions.map(transitionText).join(", ")
  const references = formulas.references.value
  const pullRequests = references.public_pull_requests.length === 0
    ? "none"
    : references.public_pull_requests.map((entry) => `${entry.repo}#${entry.number}`).join(", ")
  const longest = formulas.longest_wait.class === "unavailable"
    ? `- Longest single wait: ${unavailableText(formulas.longest_wait)}.`
    : `- Longest single wait: ${LABELS[`${formulas.longest_wait.value.kind}_ms`].toLowerCase()}, ${formulas.longest_wait.value.duration_ms} ms (${qualifiers(formulas.longest_wait)}).`
  const signals = formulas.rework_signals

  return [
    `# Job ${timeline.job}`,
    "",
    "## What happened",
    "",
    `- Status: ${formulas.status.class === "unavailable" ? unavailableText(formulas.status) : `${formulas.status.value} (${formulas.status.class})`}.`,
    `- Sessions: ${sessions.bound}; ${listedCounts(hostCounts)}; ${sessions.timeline} on the job clock.`,
    `- Shared work: ${plural(sessions.shared, "session")} shared with ${plural(sessions.shared_with_jobs, "other job")}.`,
    `- Lead time: ${metric(formulas.lead_time_ms)}.`,
    `- Queue before start: ${metric(formulas.queue_before_start_ms)}.`,
    `- Active time: ${metric(formulas.active_time_ms)} in total; inside the lead-time window: ${metric(formulas.active_in_lead_ms)}.`,
    `- Active before card (work before the task card existed, outside lead time): ${metric(formulas.active_before_card_ms)}.`,
    `- Busy time: ${metric(formulas.busy_time_ms)}; parallelism: ${metric(formulas.parallelism, "")}.`,
    `- Flow efficiency: ${flowText(formulas.flow_efficiency)}.`,
    `- Concurrent sessions: ${concurrencyText(formulas.concurrent_sessions)}.`,
    `- Concurrent agents: ${concurrencyText(formulas.concurrent_agents)}.`,
    `- Waits: ${waitsText(formulas.waits)}.`,
    `- Tool calls: ${listedCounts(formulas.tool_calls_by_kind.value)}.`,
    `- Public pull requests: ${pullRequests}; public commits: ${references.public_commits}; private references counted: ${plural(references.private_prs, "pull request")} and ${plural(references.private_commits, "commit")}.`,
    `- Status transitions: ${transitions}.`,
    "",
    "## What mattered",
    "",
    ...contributorLines(formulas),
    longest,
    "",
    "## What was waste",
    "",
    "Not classified yet: the independent evaluator arrives in slice 2.",
    `- Candidate signals only (inferred): ${signalText(signals.tool_failures, "tool failure", "tool failures")}, ${signalText(signals.tool_retries, "tool retry", "tool retries")}, ${signalText(signals.api_retries, "API retry", "API retries")}, ${signalText(signals.session_retouches, "session re-touch", "session re-touches")}.`,
    `- Wait signals: ${waitsText(formulas.waits)}.`,
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
    // The store only receives published facts, so it cannot count sessions
    // that never published any.
    sessions_seen: { class: "unavailable", value: null, reason: "not_reported_to_store" },
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
  const jobs = sorted.length === 0
    ? ["No job has published facts yet."]
    : [
        "| Job | Lead time | Active time | Active before card | Flow efficiency |",
        "| --- | ---: | ---: | ---: | ---: |",
        ...sorted.map(({ timeline, formulas }) => `| ${timeline.job} | ${metric(formulas.lead_time_ms)} | ${metric(formulas.active_time_ms)} | ${metric(formulas.active_before_card_ms)} | ${flowText(formulas.flow_efficiency)} |`),
      ]
  const unavailableEntries = coverage.unavailable.map((entry) => `- ${entry.field} / ${entry.reason}: ${entry.sessions} of ${coverage.sessions_with_facts} sessions (${percentage(entry.rate)}).`)
  const pluginEntries = coverage.plugins.map((entry) => `- ${entry.name} ${entry.version}: ${plural(entry.sessions, "session")}.`)
  return [
    "# Factory report index",
    "",
    "## Jobs",
    "",
    ...jobs,
    "",
    "Flow efficiency divides active time inside the lead-time window by lead time. Active before card is work before the task card existed; it is outside lead time.",
    "",
    "Totals and distributions across jobs, including which waste costs the most, are in `rollups/index.md`.",
    "",
    "## Coverage",
    "",
    `- Sessions seen: ${unavailableText(coverage.sessions_seen)}.`,
    `- Sessions with facts: ${coverage.sessions_with_facts}.`,
    `- Bound sessions: ${coverage.bound_sessions}.`,
    `- Unattributed sessions: ${coverage.unattributed_sessions}.`,
    ...coverage.hosts.map((entry) => `- Host ${entry.host}: ${plural(entry.sessions, "session")}.`),
    "",
    "### Unavailable evidence",
    "",
    ...(unavailableEntries.length === 0 ? ["- None."] : unavailableEntries),
    "",
    "### Plugin versions",
    "",
    ...(pluginEntries.length === 0 ? ["- None."] : pluginEntries),
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
    "- `rollups/index.md` shows which waste costs the most across jobs and the measure catalog per plugin version, host and job class; `rollups/measures.json`, `rollups/muda.json`, `rollups/tool-kinds.json` and `rollups/coverage.json` carry the same numbers.",
    "",
    "Published facts contain durations and offsets only. Missing evidence stays unavailable with its reason, and a value only some sessions could supply is marked partial with the count of uncovered sessions.",
    "",
  ].join("\n")
}
