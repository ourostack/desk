// The publishing transform: the only code that produces what leaves this
// machine for a factory store.
//
// `toPublished(local, { visibility })` turns one valid local facts file
// (`desk.factory.local/1`, `schema.js`) into published facts
// (`desk.factory.published/1`, `published-schema.js`). The stores are public,
// so the published form carries no who and no when, just how:
//
//   - No when. `session.duration_ms` is `derived_through - started_at` and
//     `ended` is whether `ended_at` is set. Every interval becomes
//     `start_ms`/`end_ms`, milliseconds since `started_at`. An interval that
//     starts before the session or ends after `derived_through` (clock skew
//     between a subagent's log and the root's) is dropped, never clamped,
//     and its field is marked `source_unreadable` (compactions count under
//     `turns`, subagents under `tool_durations`, as in the derivers). For a
//     job with a task-card creation time, `session_offset_ms` is
//     `started_at - task_created_at` (signed: a session may begin before its
//     task card exists), and each transition's and the observation's
//     `offset_ms` is its time minus `task_created_at`. A job without a
//     creation time publishes `session_offset_ms: null`, drops its
//     transitions and publishes its observation with `offset_ms: null`. An
//     offset beyond `PUBLISHED_LIMITS.maxOffsetMs` (a zeroed or bogus card
//     time) is treated the same way, since it would be close to an epoch
//     value. Either loss adds `{job_offsets, source_unreadable}` once. A
//     non-terminal card's observation (`at: null`, M3-4) publishes its
//     status with `offset_ms: null`; no observation publishes `null`.
//   - No who. Local facts carry no contributor, and nothing here adds a
//     machine, host name, desk path, account or branch. The file name is
//     `<host>-<session id>.json` (`publishedFileName`).
//   - Public references only. A PR or commit is kept only when
//     `visibility(repo)` returns exactly `"public"`. Private and unknown
//     repositories, commits without a repository, and a repository whose
//     name holds a date shape are dropped and counted in `refs.private`,
//     together with the references the deriver could not resolve
//     (`refs.unresolved`); the same totals are returned as `dropped`.
//     `visibility` is asked once per repository and never for a date-shaped
//     one.
//   - No date shapes. A model ID or plugin name holding an ISO date (such as
//     `gpt-4o-2024-08-06`) loses that date's hyphens (`gpt-4o-20240806`), so
//     the file passes the public gate's date check without losing the model.
//     That date is the model's or plugin's release, not when the work
//     happened, so keeping its digits says nothing about the session.
//   - Offsets are capped at `PUBLISHED_LIMITS.maxOffsetMs`, ten years either
//     way (controller ruling, M3-5 fix round 1). Ten years is less than the
//     time since 1970, so no offset can be an epoch value in disguise.
//
// `unavailable` keeps the local entries and adds each new one once, capped
// at the schema limit. The transform is pure and deterministic: it never
// mutates its input, shares no object with it and reads no clock.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { LIMITS, validateLocalFacts } from "./schema.js"
import { DATE_SHAPE, PUBLISHED_LIMITS, PUBLISHED_SCHEMA, validatePublished } from "./published-schema.js"

// The `unavailable` field an interval kind's data belongs to.
const INTERVAL_FIELD = Object.freeze({
  turn: "turns",
  tool: "tool_durations",
  subagent: "tool_durations",
  human_wait: "human_waits",
  permission_wait: "permission_waits",
  api_retry: "api_retries",
  compaction: "turns",
})

const DATE_PARTS = /(\d{4})-(\d{2})-(\d{2})/u

// Removes the hyphens of every ISO date in an identifier, including one that
// an earlier removal uncovers (`x-2024-08-06-01-02`).
function undate(id) {
  let text = id
  while (DATE_SHAPE.test(text)) text = text.replace(DATE_PARTS, "$1$2$3")
  return text
}

function publishSession(session, durationMs) {
  return {
    host: session.host,
    id: session.id,
    host_version: session.host_version,
    entrypoint: session.entrypoint,
    duration_ms: durationMs,
    ended: session.ended_at !== null,
    end_reason: session.end_reason,
  }
}

function publishIntervals(intervals, startedMs, durationMs, flag) {
  const kept = []
  for (const interval of intervals) {
    const startMs = Date.parse(interval.start) - startedMs
    const endMs = Date.parse(interval.end) - startedMs
    if (startMs < 0 || endMs > durationMs) {
      flag(INTERVAL_FIELD[interval.kind], "source_unreadable")
      continue
    }
    const out = { kind: interval.kind, agent: interval.agent }
    if (interval.kind === "tool") {
      out.tool = interval.tool
      out.outcome = interval.outcome
    }
    out.start_ms = startMs
    out.end_ms = endMs
    kept.push(out)
  }
  return kept
}

function publishRefs(refs, visibility) {
  const answers = new Map()
  const isPublic = (repo) => {
    if (repo === null || DATE_SHAPE.test(repo)) return false
    if (!answers.has(repo)) answers.set(repo, visibility(repo) === "public")
    return answers.get(repo)
  }
  const prs = refs.prs.filter((pr) => isPublic(pr.repo)).map((pr) => ({ repo: pr.repo, number: pr.number }))
  const commits = refs.commits.filter((commit) => isPublic(commit.repo)).map((commit) => ({ repo: commit.repo, sha: commit.sha }))
  return {
    prs,
    commits,
    dropped: {
      prs: refs.prs.length - prs.length + refs.unresolved.prs,
      commits: refs.commits.length - commits.length + refs.unresolved.commits,
    },
  }
}

function publishJob(job, startedMs, flag) {
  const anchor = job.task_created_at === null ? null : Date.parse(job.task_created_at)
  const offsetOf = (ms) => {
    if (anchor === null) return null
    const offset = ms - anchor
    return Math.abs(offset) <= PUBLISHED_LIMITS.maxOffsetMs ? offset : null
  }

  const sessionOffset = offsetOf(startedMs)
  let lost = sessionOffset === null
  const transitions = []
  for (const transition of job.transitions) {
    const offset = offsetOf(Date.parse(transition.at))
    if (offset === null) lost = true
    else transitions.push({ to: transition.to, offset_ms: offset })
  }
  let observed = null
  if (job.observed !== null) {
    const offset = job.observed.at === null ? null : offsetOf(Date.parse(job.observed.at))
    if (job.observed.at !== null && offset === null) lost = true
    observed = { status: job.observed.status, offset_ms: offset }
  }
  if (lost) flag("job_offsets", "source_unreadable")

  return { job: job.job, basis: [...job.basis], session_offset_ms: sessionOffset, transitions, observed }
}

/**
 * `toPublished(local, { visibility }) -> { published, dropped: { prs, commits } }`.
 * `local` must pass `validateLocalFacts`; `visibility(repo)` answers
 * `"public"`, `"private"` or `"unknown"` for an `owner/repo` name. Both
 * requirements are caller contracts: a violation throws a `TypeError` that
 * names no value.
 */
export function toPublished(local, { visibility } = {}) {
  if (typeof visibility !== "function") throw new TypeError("toPublished: visibility must be a function")
  if (!validateLocalFacts(local).ok) throw new TypeError("toPublished: local facts must pass validateLocalFacts")

  const unavailable = []
  const flag = (field, reason) => {
    if (!unavailable.some((entry) => entry.field === field && entry.reason === reason)) unavailable.push({ field, reason })
  }
  for (const entry of local.unavailable) flag(entry.field, entry.reason)

  const startedMs = Date.parse(local.session.started_at)
  const durationMs = Date.parse(local.session.derived_through) - startedMs
  const intervals = publishIntervals(local.intervals, startedMs, durationMs, flag)
  const refs = publishRefs(local.refs, visibility)
  const jobs = local.jobs.map((job) => publishJob(job, startedMs, flag))

  const published = {
    schema: PUBLISHED_SCHEMA,
    session: publishSession(local.session, durationMs),
    plugins: local.plugins.map((plugin) => ({ name: undate(plugin.name), version: plugin.version })),
    models: local.models.map((model) => ({
      id: undate(model.id),
      requests: model.requests,
      tokens: {
        input: model.tokens.input,
        output: model.tokens.output,
        cache_read: model.tokens.cache_read,
        cache_write: model.tokens.cache_write,
        reasoning: model.tokens.reasoning,
      },
    })),
    agents: local.agents.map((agent) => ({ n: agent.n, parent: agent.parent, model: undate(agent.model) })),
    intervals,
    counts: {
      tool_calls: { ...local.counts.tool_calls },
      tool_failures: { ...local.counts.tool_failures },
      tool_retries: local.counts.tool_retries,
      api_retries: local.counts.api_retries,
      compactions: local.counts.compactions,
    },
    refs: { prs: refs.prs, commits: refs.commits, private: { ...refs.dropped } },
    jobs,
    unavailable: unavailable.slice(0, LIMITS.unavailable),
  }
  return { published, dropped: { ...refs.dropped } }
}

/** The bytes a store receives: canonical JSON and one trailing newline. */
export function serializePublished(published) {
  return `${JSON.stringify(published)}\n`
}

/** `<host>-<session id>.json` for a valid published file; anything else is a caller bug. */
export function publishedFileName(published) {
  if (!validatePublished(published).ok) throw new TypeError("publishedFileName: the value must pass validatePublished")
  return `${published.session.host}-${published.session.id}.json`
}
