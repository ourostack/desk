import { withState } from "./number-states.js"

const LABELS = Object.freeze({
  active_in_lead_ms: "Active time inside the lead-time window",
  queue_before_start_ms: "Queue before start",
  human_wait_ms: "Human wait",
  permission_wait_ms: "Permission wait",
  api_retry_ms: "API retry wait",
  compaction_ms: "Compaction wait time",
})

function compareText(left, right) {
  return Number(left > right) - Number(left < right)
}

// The plain words for every reason a page can print. A reason with no entry
// here stops the build (`reasonText` throws), and a test walks the facts
// enums, the lists below and every reason in the built output, so a new
// reason cannot ship as a raw identifier.
const FACT_REASON_TEXT = {
  host_does_not_record: "the host does not record it",
  log_missing: "the session log was missing",
  log_truncated: "the session log ended mid-record",
  session_open: "the session was still open",
  not_collected_in_slice_1: "it is not collected yet",
  source_unreadable: "the source could not be read",
  capped: "it was cut to a size limit",
  desk_public: "the desk is public, so job timing is withheld",
  field_absent: "the host's record did not include it",
  host_records_partly: "the host records only some of it, so this is a lower bound",
  withheld_public: "it is withheld because the store is public",
}

// Reasons only the report and the rollups name; the facts enums do not.
const REPORT_REASON_TEXT = {
  worker_split: "the job owns only some workers of a session, and that session is not counted",
  worker_shared: "the session's work was shared with another job",
  censored: "the job was still open when this was measured",
  mixed: "several different causes",
  no_sessions: "no session has reported yet",
  partial: "only some sessions supplied it",
  open_job: "the job is not finished",
  not_labeled: "the independent evaluator has not labeled it",
  cancelled: "the job was cancelled",
  status_unavailable: "the job's status was not recorded",
  wait_fields_unavailable: "the wait records were not available",
  job_offsets_unavailable: "the job clock could not be read",
  zero_lead_time: "the job's lead time is zero",
  no_wait_intervals: "no wait was recorded",
  no_active_intervals: "no active time was recorded",
  not_reported_to_store: "the store only receives published facts, so it cannot count sessions that never published any",
  not_in_published_facts: "published facts do not carry it",
  facts_missing: "the session's facts are missing",
  no_facts: "no facts file matches the labels",
  facts_ambiguous: "more than one facts file matches the labels",
}

// What the independent evaluator's labels file can declare unreadable, and the codes of the check of labels against facts.
const LABEL_REASON_TEXT = {
  session_log_missing: "the session log was missing",
  session_mismatch: "the labels name a different session",
  job_unbound: "the session is not bound to the job",
  range: "a labeled stretch runs past the session",
  evidence_unmatched: "the labeled evidence no longer matches the facts",
}

/** The reasons the report and rollups name that are not in the facts enums. */
export const REPORT_ONLY_REASONS = Object.freeze(Object.keys(REPORT_REASON_TEXT))

/** The reason codes of the labels files: what a label can declare unreadable and why one is left unused. */
export const LABEL_REASONS = Object.freeze(Object.keys(LABEL_REASON_TEXT))

export const REASON_TEXT = Object.freeze({ ...FACT_REASON_TEXT, ...REPORT_REASON_TEXT, ...LABEL_REASON_TEXT })

/** `reasonText(id) -> string`: the plain words for a reason. An id with no words is a defect and stops the build. */
export function reasonText(id) {
  if (!Object.hasOwn(REASON_TEXT, id)) throw new Error(`no plain text for the reason ${String(id)}`)
  return REASON_TEXT[id]
}

export const FIELD_TEXT = Object.freeze({
  tokens: "Tokens",
  requests: "Model requests",
  models: "Models",
  turns: "Turns",
  tool_durations: "Tool durations",
  permission_waits: "Permission waits",
  human_waits: "Human waits",
  api_retries: "API retries",
  commits: "Commits",
  ci_runs: "CI runs",
  plugins: "Plugins",
  ended_at: "Session end time",
  compaction_waits: "Compaction wait time",
  agents: "Subagents",
  prs: "Pull requests",
  reasoning_tokens: "Reasoning tokens",
  entrypoint: "Entrypoint",
  tool_outcomes: "Tool outcomes",
  job_segments: "Job time segments",
  job_offsets: "Job clock offsets",
})

function fieldText(field) {
  if (!Object.hasOwn(FIELD_TEXT, field)) throw new Error(`no plain name for the field ${String(field)}`)
  return FIELD_TEXT[field]
}

const DEFINITIONS = "API retry counts are the errors the host surfaced: Claude surfaces only some of them, so its count is a lower bound, and Codex does not record them. Human wait is the gaps between prompts inside a session. Tool failure and retry definitions differ by host: Codex reads an output layout it does not recognise as ok, and Copilot adds denied. The number of compactions is recorded on every host; compaction wait time is recorded only where the host records it. Cost in money is not measured in v0."

const FOOTNOTE = `How to read these numbers: measured means every session that should supply a number did; partial means the number is a lower bound or covers only some sessions, and the reason follows; not recorded means there is no number, which is never zero. ${DEFINITIONS}`

function plural(count, singular, pluralForm = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

function reasonsPhrase(value) {
  return value.reasons.map(reasonText).join(" and ")
}

// The state a number carries, in words. A result with no known state is a
// defect upstream and stops the page; it is never read as measured.
function stateText(value, evidence = true) {
  if (!["measured", "partial", "unavailable"].includes(value.state)) throw new Error(`a number has no known state: ${String(value.state)}`)
  if (value.state === "unavailable") return `not recorded (${reasonsPhrase(value)})`
  const note = evidence && value.class !== "measured" ? [`${value.class} evidence`] : []
  if (value.state === "measured") return ["measured", ...note].join(", ")
  const uncovered = value.partial === true && value.uncovered_sessions > 0 ? [`${plural(value.uncovered_sessions, "session")} uncovered`] : []
  return `partial: ${[reasonsPhrase(value), ...uncovered, ...note].join("; ")}`
}

// A value followed by its state, or the state alone when nothing was recorded.
function labelled(text, value, evidence = true) {
  return value.state === "unavailable" ? stateText(value) : `${text} (${stateText(value, evidence)})`
}

function metric(value, suffix = " ms") {
  return labelled(`${value.value}${suffix}`, value)
}

function percentage(value) {
  return `${(value * 100).toFixed(2)}%`
}

function flowText(value) {
  return labelled(percentage(value.value), value)
}

function concurrencyText(value) {
  return labelled(value.state === "unavailable" ? "" : `maximum ${value.value.maximum}, average ${value.value.average.toFixed(2)}`, value)
}

function signalText(value, singular, pluralForm) {
  return value.state === "unavailable" ? `${pluralForm} ${stateText(value)}` : `${plural(value.value, singular, pluralForm)} (${stateText(value, false)})`
}

function listedCounts(value, order = Object.keys(value).sort()) {
  const entries = order.filter((key) => value[key] !== undefined).map((key) => `${key} ${value[key]}`)
  return entries.length === 0 ? "none" : entries.join(", ")
}

function unavailableLines(formulas) {
  const lines = formulas.unavailable.value.map((entry) =>
    `- ${fieldText(entry.field)}: ${reasonText(entry.reason)} (${plural(entry.count, "session")}).`)
  lines.push(`- First-pass yield: ${stateText(formulas.first_pass_yield)}.`)
  return lines
}

function contributorLines(formulas) {
  const contributors = formulas.lead_contributors
  if (contributors.state === "unavailable") return [`- Lead-time contributors: ${stateText(contributors)}.`]
  const lines = contributors.value.slice(0, 2).map((entry) => {
    const source = formulas.waits[entry.key] ?? formulas[entry.key]
    const result = withState({ class: contributors.class, partial: source.partial, uncovered_sessions: source.uncovered_sessions, partial_reasons: source.partial_reasons, censored: contributors.censored })
    return `- ${LABELS[entry.key]}: ${entry.value_ms} ms, ${percentage(entry.share)} of lead time (${stateText(result)}).`
  })
  if (contributors.state === "partial") lines.push(`- Lead-time contributors are partial: ${reasonsPhrase(contributors)}.`)
  return lines
}

function waitsText(waits) {
  return `human ${metric(waits.human_wait_ms)}, permission ${metric(waits.permission_wait_ms)}, API retry ${metric(waits.api_retry_ms)}, compaction wait time ${metric(waits.compaction_ms)}`
}

const TOKEN_NAMES = Object.freeze([["total", "total"], ["input", "input"], ["output", "output"], ["cache_read", "cache read"], ["cache_write", "cache write"], ["reasoning", "reasoning"]])

// Types that share one state and reason are said once: "input, output not recorded (...)".
function tokensText(tokens) {
  const groups = []
  for (const [key, name] of TOKEN_NAMES) {
    const state = stateText(tokens[key], false)
    const same = tokens[key].state === "unavailable" ? groups.find((group) => group.state === state) : undefined
    if (same === undefined) groups.push({ state, entries: [[name, tokens[key]]] })
    else same.entries.push([name, tokens[key]])
  }
  return groups.map((group) => group.entries[0][1].state === "unavailable"
    ? `${group.entries.map(([name]) => name).join(", ")} ${group.state}`
    : `${group.entries[0][0]} ${labelled(`${group.entries[0][1].value}`, group.entries[0][1], false)}`).join(", ")
}

function referencesText(references) {
  const parts = references.parts
  const pullRequests = references.value.public_pull_requests.length === 0 ? "none" : references.value.public_pull_requests.map((entry) => `${entry.repo}#${entry.number}`).join(", ")
  const count = (part) => labelled(`${part.value}`, part, false)
  return `Public pull requests: ${labelled(pullRequests, parts.public_prs, false)}; public commits: ${count(parts.public_commits)}; private pull requests counted: ${count(parts.private_prs)}; private commits counted: ${count(parts.private_commits)}`
}

function transitionText(entry) {
  return entry.offset_ms === null ? `${entry.to} at an unknown offset` : `${entry.to} at ${entry.offset_ms} ms`
}

// The evaluator's labels for this job's sessions, or "not classified yet"
// when none of them has accepted labels. Labels come from the store's
// `labels/` entries that passed the build's checks against the facts.
function wasteLines(timeline, labelsByJobSession) {
  const total = timeline.sessions.length
  const labeled = timeline.sessions.flatMap((session) => {
    const entry = labelsByJobSession.get(`${timeline.job}/${session.id}`)
    return entry === undefined ? [] : [entry]
  })
  if (labeled.length === 0) return ["Not classified yet: no session of this job has labels from the independent evaluator."]
  const byClass = { value: 0, support: 0, muda: 0 }
  const byWaste = new Map()
  let mura = 0
  let muri = 0
  for (const stretch of labeled.flatMap((entry) => entry.stretches)) {
    const duration = stretch.end_ms - stretch.start_ms
    byClass[stretch.class] += duration
    if (stretch.class === "muda") {
      const current = byWaste.get(stretch.waste) ?? { ms: 0, stretches: 0 }
      byWaste.set(stretch.waste, { ms: current.ms + duration, stretches: current.stretches + 1 })
    }
    if (stretch.mura) mura += 1
    if (stretch.muri) muri += 1
  }
  const classified = byClass.value + byClass.support + byClass.muda
  // Every line below covers only the labeled sessions, so its state is the labeled share of the job's sessions.
  const state = labeled.length === total ? "measured" : `partial: ${reasonText("not_labeled")}; ${plural(total - labeled.length, "session")} uncovered`
  const coverage = labeled.length === total
    ? `Classified by the independent evaluator: ${plural(total, "session")} labeled (${state}).`
    : `Classified by the independent evaluator: ${labeled.length} of ${plural(total, "session")} labeled (${state}).`
  const wastes = [...byWaste.entries()]
    .sort((left, right) => right[1].ms - left[1].ms || compareText(left[0], right[0]))
    .map(([waste, entry]) => `${waste} ${entry.ms} ms in ${plural(entry.stretches, "stretch", "stretches")}`)
  const share = classified === 0 ? "" : `, ${percentage(byClass.muda / classified)} of labeled time`
  const lines = [
    `- ${coverage}`,
    wastes.length === 0 ? `- Muda: none in the labeled stretches (${state}).` : `- Muda: ${byClass.muda} ms${share}, by type: ${wastes.join(", ")} (${state}).`,
    `- Value ${byClass.value} ms; support ${byClass.support} ms (${state}).`,
    `- Mura (unevenness) flagged on ${plural(mura, "stretch", "stretches")}; muri (overburden) on ${plural(muri, "stretch", "stretches")} (${state}).`,
  ]
  const unreadable = new Map()
  for (const code of labeled.flatMap((entry) => entry.unavailable)) unreadable.set(code, (unreadable.get(code) ?? 0) + 1)
  if (unreadable.size > 0) {
    lines.push(`- The evaluator could not read: ${[...unreadable.entries()].sort((left, right) => compareText(left[0], right[0])).map(([code, count]) => `${reasonText(code)} in ${plural(count, "session")}`).join(", ")} (measured).`)
  }
  return lines
}

export function renderJobMarkdown({ timeline, formulas, labels = new Map() }) {
  const hostCounts = formulas.sessions_by_host.value
  const sessions = formulas.sessions.value
  const transitions = timeline.transitions.length === 0 ? "none" : timeline.transitions.map(transitionText).join(", ")
  const transitionState = timeline.transitions.some((entry) => entry.offset_ms === null) ? `partial: ${reasonText("job_offsets_unavailable")}` : "measured"
  const longest = formulas.longest_wait.state === "unavailable"
    ? `- Longest single wait: ${stateText(formulas.longest_wait)}.`
    : `- Longest single wait: ${LABELS[`${formulas.longest_wait.value.kind}_ms`].toLowerCase()}, ${formulas.longest_wait.value.duration_ms} ms (${stateText(formulas.longest_wait)}).`
  const signals = formulas.rework_signals

  return [
    `# Job ${timeline.job}`,
    "",
    "## What happened",
    "",
    `- Status: ${labelled(`${formulas.status.value}`, formulas.status)}.`,
    `- Sessions: ${sessions.bound} bound, ${sessions.timeline} on the job clock (${stateText(formulas.sessions)}); by host: ${listedCounts(hostCounts)} (${stateText(formulas.sessions_by_host)}).`,
    `- Shared work: ${plural(sessions.shared, "session")} shared with ${plural(sessions.shared_with_jobs, "other job")} (${stateText(formulas.sessions)}).`,
    `- Lead time: ${metric(formulas.lead_time_ms)}.`,
    `- Queue before start: ${metric(formulas.queue_before_start_ms)}.`,
    `- Active time: ${metric(formulas.active_time_ms)} in total; inside the lead-time window: ${metric(formulas.active_in_lead_ms)}.`,
    `- Active before card (work before the task card existed, outside lead time): ${metric(formulas.active_before_card_ms)}.`,
    `- Busy time: ${metric(formulas.busy_time_ms)}; parallelism: ${metric({ ...formulas.parallelism, value: formulas.parallelism.value === null ? null : Number(formulas.parallelism.value.toFixed(2)) }, "")}.`,
    `- Flow efficiency: ${flowText(formulas.flow_efficiency)}.`,
    `- Concurrent sessions: ${concurrencyText(formulas.concurrent_sessions)}.`,
    `- Concurrent agents: ${concurrencyText(formulas.concurrent_agents)}.`,
    `- Waits: ${waitsText(formulas.waits)}.`,
    `- Tool calls: ${labelled(listedCounts(formulas.tool_calls_by_kind.value ?? {}), formulas.tool_calls_by_kind)}.`,
    `- ${referencesText(formulas.references)}.`,
    `- Tokens: ${tokensText(formulas.tokens_total)}.`,
    `- Status transitions: ${transitions} (${transitionState}).`,
    "",
    "## What mattered",
    "",
    ...contributorLines(formulas),
    longest,
    "",
    "## What was waste",
    "",
    ...wasteLines(timeline, labels),
    `- Candidate signals only (inferred): ${signalText(signals.tool_failures, "tool failure", "tool failures")}, ${signalText(signals.tool_retries, "tool retry", "tool retries")}, ${signalText(signals.api_retries, "API retry", "API retries")}, ${signalText(signals.session_retouches, "session re-touch", "session re-touches")}.`,
    `- Wait signals: ${waitsText(formulas.waits)}.`,
    "",
    "## What we could not see",
    "",
    ...unavailableLines(formulas),
    "",
    FOOTNOTE,
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
  // One line per field; each reason it carries follows with how many sessions it covers.
  const byField = new Map()
  for (const entry of coverage.unavailable) byField.set(entry.field, [...(byField.get(entry.field) ?? []), entry])
  const unavailableEntries = [...byField.entries()].map(([field, entries]) =>
    `- ${fieldText(field)}: ${entries.map((entry) => `${reasonText(entry.reason)} (${entry.sessions} of ${coverage.sessions_with_facts} sessions, ${percentage(entry.rate)})`).join("; ")}.`)
  const pluginEntries = coverage.plugins.map((entry) => `- ${entry.name} ${entry.version}: ${plural(entry.sessions, "session")} (measured).`)
  return [
    "# Factory report index",
    "",
    "## Jobs",
    "",
    ...jobs,
    "",
    "Flow efficiency divides active time inside the lead-time window by lead time. Active before card is work before the task card existed; it is outside lead time. Each number carries its state: measured, partial with its reason, or not recorded.",
    "",
    "Totals and distributions across jobs, including which waste costs the most, are in `rollups/index.md`.",
    "",
    "## Coverage",
    "",
    `- Sessions seen: not recorded (${reasonText(coverage.sessions_seen.reason)}).`,
    `- Sessions with facts: ${coverage.sessions_with_facts} (measured).`,
    `- Bound sessions: ${coverage.bound_sessions} (measured).`,
    `- Unattributed sessions: ${coverage.unattributed_sessions} (measured).`,
    ...coverage.hosts.map((entry) => `- Host ${entry.host}: ${plural(entry.sessions, "session")} (measured).`),
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
    "- `rollups/index.md` shows which waste costs the most across jobs and the measure catalog per plugin version, host and job class; `rollups/measures.json`, `rollups/muda.json`, `rollups/tool-kinds.json`, `rollups/coverage.json` and `rollups/totals.json` carry the same numbers.",
    "- `rollups/totals.json` holds fact-level totals per host and overall (sessions, tool calls, tool failures, model requests, tokens by type and subagent dispatches), each with its state, its value, n and N.",
    "",
    "Published facts contain durations and offsets only. Every number carries one of three states: measured, partial or not recorded. Not recorded means there is no number, with the reason; it is never printed as zero, and a zero is printed only when a zero was measured. Partial means the number covers only part of what it should, and its reason and the count of uncovered sessions follow it. A total or a median over several sessions or jobs reads n of N: n counted a measured value, of N in all.",
    "",
    "The reason `the host records only some of it` marks a lower bound: the host surfaced some of the records, so the real number is at least what is printed. Claude API retry counts are such a lower bound.",
    "",
    DEFINITIONS,
    "",
  ].join("\n")
}
