// The publishing transform: the only code that produces what leaves this
// machine for a factory store.
//
// `toPublished(local, { visibility, deskVisibility, machineSecret })` turns
// one valid local facts file (`desk.factory.local/1`, `schema.js`) into
// published facts (`desk.factory.published/1`, `published-schema.js`). The
// stores are public, so the published form carries no who and no when, just
// how:
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
//   - Offsets and durations are capped at `PUBLISHED_LIMITS.maxOffsetMs`,
//     ten years (controller rulings, M3-5 fix rounds 1 and 2). Ten years is
//     less than the time since 1970, so no offset can be an epoch value in
//     disguise. A session longer than the cap cannot be real: its start is
//     a bogus early timestamp (one log line dated 1970, say), and every
//     interval offset would carry that anchor's absolute time. Such a
//     session is refused, not published: the result is `{ published: null,
//     reason: "implausible_session_span" }`, and the flush quarantines it
//     locally. So is a session that starts before `EARLIEST_SESSION_START`
//     (2025-01-01, controller ruling, fix round 3): neither host existed
//     before then, so such a start is a bogus anchor too, and a guessable one
//     (`2020-01-01`) inside the ten-year cap would otherwise still turn every
//     interval offset back into absolute time.
//   - A session ID that is not a version-4 UUID could carry a timestamp or a
//     machine identifier, in the file and in its name, so it is refused
//     with `reason: "session_id_not_v4"`.
//   - A desk that is public, or not known to be private, keeps its job
//     timing private (controller ruling, fix round 2): anyone could compute
//     a public desk's plain job IDs from its task paths and read each card's
//     public `created` date, which would turn job offsets back into absolute
//     time. So unless `deskVisibility` is `"private"` or `"internal"`, every
//     job publishes `session_offset_ms: null`, no transition offsets and an
//     observation `offset_ms: null`, `unavailable` gains `{job_offsets,
//     desk_public}`, and each job ID is replaced with the first 32 hex of
//     `HMAC-SHA256(machineSecret, jobId)`, a per-machine key the flush keeps
//     in the factory state folder. Those jobs are sorted by their keyed ID,
//     so their order says nothing about the plain IDs (which binding sorts
//     by).
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
//     one. A reference repeated in the local file is published once.
//   - No date or time shapes. A model ID or plugin name holding an ISO date
//     (such as `gpt-4o-2024-08-06`) loses that date's hyphens
//     (`gpt-4o-20240806`), and a model ID holding a time of day loses its
//     colons (repeatedly, since removing one can uncover the other), so the
//     file passes the public gate's date and time checks
//     without losing the model. That date is the model's or plugin's
//     release, not when the work happened, so keeping its digits says
//     nothing about the session.
//
// `unavailable` keeps the local entries once each and adds the transform's
// own markers after them; when the list would pass the schema limit, the
// transform's markers are kept first (even one the local file already held)
// and the last local entries give way. The transform is
// pure and deterministic: it never mutates its input, shares no object with
// it and reads no clock.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createHmac } from "node:crypto"

import { LIMITS, validateLocalFacts } from "./schema.js"
import { DATE_SHAPE, PUBLISHED_LIMITS, PUBLISHED_SCHEMA, SESSION_ID_V4, TIME_SHAPE, validatePublished } from "./published-schema.js"

/** Why `toPublished` returned no file. */
export const REFUSALS = Object.freeze(["implausible_session_span", "session_id_not_v4"])

/** No session this transform publishes can start earlier: neither host existed before it. */
export const EARLIEST_SESSION_START = "2025-01-01T00:00:00.000Z"

// Desks whose remote is known not to be public keep their job timing.
const PRIVATE_DESKS = new Set(["private", "internal"])
const MIN_SECRET_BYTES = 32

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
const TIME_PARTS = /(\d{2}):(\d{2})/u

// Removes the hyphens of every ISO date and the colons of every time of day
// in an identifier, including one that an earlier removal uncovers
// (`x-2024-08-06-01-02`, `m:08:30:00`).
function scrub(id) {
  let text = id
  // Each pass removes at least one character, so this ends.
  while (DATE_SHAPE.test(text) || TIME_SHAPE.test(text)) text = text.replace(DATE_PARTS, "$1$2$3").replace(TIME_PARTS, "$1$2")
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
  const dropped = { prs: refs.unresolved.prs, commits: refs.unresolved.commits }
  // Keeps each public reference once (by `keyOf`) and counts the others.
  const keep = (list, kind, keyOf, copy) => {
    const seen = new Set()
    const kept = []
    for (const item of list) {
      if (!isPublic(item.repo)) dropped[kind] += 1
      else if (!seen.has(keyOf(item))) {
        seen.add(keyOf(item))
        kept.push(copy(item))
      }
    }
    return kept
  }
  const prs = keep(refs.prs, "prs", (pr) => `${pr.repo}#${pr.number}`, (pr) => ({ repo: pr.repo, number: pr.number }))
  const commits = keep(refs.commits, "commits", (commit) => commit.sha, (commit) => ({ repo: commit.repo, sha: commit.sha }))
  return { prs, commits, dropped }
}

// A public (or not surely private) desk's job: a keyed ID and no timing.
function protectedJob(job, machineSecret) {
  return {
    job: createHmac("sha256", machineSecret).update(job.job).digest("hex").slice(0, 32),
    basis: [...job.basis],
    session_offset_ms: null,
    transitions: [],
    observed: job.observed === null ? null : { status: job.observed.status, offset_ms: null },
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
 * `toPublished(local, { visibility, deskVisibility, machineSecret }) ->
 * { published, dropped: { prs, commits } }`, or `{ published: null,
 * dropped: null, reason }` with a reason from `REFUSALS` when the session
 * cannot be published at all.
 *
 * `local` must pass `validateLocalFacts`; `visibility(repo)` answers
 * `"public"`, `"private"` or `"unknown"` for an `owner/repo` name;
 * `deskVisibility` is the same answer for the desk's own remote (`"private"`
 * or `"internal"` keep job timing; anything else, including a missing
 * value, withholds it); `machineSecret` (at least 32 bytes) keys the job IDs
 * of a desk that withholds its timing and is required then. These are
 * caller contracts: a violation throws a `TypeError` that names no value.
 */
export function toPublished(local, { visibility, deskVisibility, machineSecret } = {}) {
  if (typeof visibility !== "function") throw new TypeError("toPublished: visibility must be a function")
  if (!validateLocalFacts(local).ok) throw new TypeError("toPublished: local facts must pass validateLocalFacts")
  const deskPrivate = PRIVATE_DESKS.has(deskVisibility)
  if (!deskPrivate && !(machineSecret instanceof Uint8Array && machineSecret.length >= MIN_SECRET_BYTES)) {
    throw new TypeError("toPublished: a desk that is not private needs a machineSecret of at least 32 bytes")
  }

  const startedMs = Date.parse(local.session.started_at)
  const durationMs = Date.parse(local.session.derived_through) - startedMs
  if (durationMs > PUBLISHED_LIMITS.maxOffsetMs || startedMs < Date.parse(EARLIEST_SESSION_START)) {
    return { published: null, dropped: null, reason: "implausible_session_span" }
  }
  if (!SESSION_ID_V4.test(local.session.id)) return { published: null, dropped: null, reason: "session_id_not_v4" }

  // The local entries once each, then the transform's own.
  const own = []
  const localEntries = []
  const has = (list, field, reason) => list.some((entry) => entry.field === field && entry.reason === reason)
  for (const entry of local.unavailable) {
    if (!has(localEntries, entry.field, entry.reason)) localEntries.push({ field: entry.field, reason: entry.reason })
  }
  const flag = (field, reason) => {
    if (!has(own, field, reason)) own.push({ field, reason })
  }

  const intervals = publishIntervals(local.intervals, startedMs, durationMs, flag)
  const refs = publishRefs(local.refs, visibility)
  const jobs = deskPrivate
    ? local.jobs.map((job) => publishJob(job, startedMs, flag))
    : local.jobs.map((job) => protectedJob(job, machineSecret)).sort((a, b) => (a.job < b.job ? -1 : 1))
  if (!deskPrivate && jobs.length > 0) flag("job_offsets", "desk_public")

  const published = {
    schema: PUBLISHED_SCHEMA,
    session: publishSession(local.session, durationMs),
    plugins: local.plugins.map((plugin) => ({ name: scrub(plugin.name), version: plugin.version })),
    models: local.models.map((model) => ({
      id: scrub(model.id),
      requests: model.requests,
      tokens: {
        input: model.tokens.input,
        output: model.tokens.output,
        cache_read: model.tokens.cache_read,
        cache_write: model.tokens.cache_write,
        reasoning: model.tokens.reasoning,
      },
    })),
    agents: local.agents.map((agent) => ({ n: agent.n, parent: agent.parent, model: scrub(agent.model) })),
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
    unavailable: [...localEntries.filter((entry) => !has(own, entry.field, entry.reason)).slice(0, LIMITS.unavailable - own.length), ...own],
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
