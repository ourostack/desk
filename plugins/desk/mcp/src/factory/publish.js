// The publishing transform: the only code that produces what leaves this
// machine for a factory store.
//
// `toPublished(local, { visibility, deskVisibility, storeVisibility,
// machineSecret, now })` turns
// one valid local facts file (`desk.factory.local/2`, `schema.js`) into
// published facts (`desk.factory.published/4`, `published-schema.js`). Every
// file is `/4`, so the first flush after this change sends each session in
// the outbox once more, with the `/4` keys. The stores are public, so the
// published form carries no who and no time of day, just how, and one date
// per job, the UTC day the task finished:
//
//   - No when. `session.duration_ms` is `derived_through - started_at` and
//     `ended` is whether `ended_at` is set. Every interval becomes
//     `start_ms`/`end_ms`, milliseconds since `started_at`. An interval that
//     starts before the session or ends after `derived_through` (most often
//     a subagent still working after the main log's last line, which a live
//     session's derivation can catch mid-run) is dropped, never clamped,
//     and its field is marked `interval_outside_session_clock` (compactions
//     count under `turns`, subagents under `tool_durations`, as in the
//     derivers). The reason says only that some intervals are missing, so
//     every figure it reaches is partial, never unavailable. For a
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
//   - Finish day (`/4`). A job whose card was observed `done` or `cancelled`
//     publishes `finished_on`, the UTC day (`YYYY-MM-DD`) of the session's
//     own last transition into that status (`finished_basis:
//     "transition"`), else of the observation's `at`, the card's `updated`
//     time, which is an upper bound (`"card_updated"`); binding never gives
//     an observation an `updated` time that is not after the card's
//     `created` time (`binding.js`). Only a source this
//     file also publishes with an offset counts, so a job with no readable
//     card creation time, an open job and any job of a desk that withholds
//     its timing publish `null` for both. A day before the gate's `FINISHED_ON_MIN` (2025-01-01, imported, not copied), or after
//     the UTC day of the optional `now` (milliseconds; a hand-edited card
//     dated ahead), is `null` too, because the store would refuse the file.
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
//     machine identifier, in the file and in its name. A version-4 ID
//     publishes unchanged. A version-7 ID (Codex threads) carries its
//     creation time, so it publishes as a keyed version-4-shaped ID,
//     `HMAC-SHA256(machineSecret, "session:" + id)`, on every desk: the same
//     ID in the facts, the store path and the labels, stable per machine so
//     a re-derive updates the same file. Anything else is refused with
//     `reason: "session_id_not_v4"`.
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
//   - A commit's `at_ms` (when the session recorded it, on the session
//     clock) is published under the rule for a controller PR's `at_ms`: only
//     on a desk known to be private and only in a session whose jobs carry
//     segments, where it can place the commit in a job's segment.
//   - Created PRs (`/4`). `refs.prs[].created` is `true` only when the local
//     ref says the session's own call created the PR; a ref written before
//     derivers kept the flag publishes `false`. A desk that withholds its
//     timing publishes `false` for every PR, because GitHub's public creation
//     time of a created PR would date the session.
//   - Stop facts (`/4`). Each human wait keeps its `stop` (how the agent's
//     turn ended, whether its last reply ended in a question mark, whether
//     its background agents were running: codes and booleans, no text). A
//     wait derived before stop facts were recorded publishes `{ end:
//     "not_recorded", asks: null, pending_agents: null }`.
//   - Public references only. A PR or commit is kept only when
//     `visibility(repo)` returns exactly `"public"`. Private and unknown
//     repositories, commits without a repository, and a repository whose
//     name holds a date shape are dropped and counted in `refs.private`,
//     together with the references the deriver could not resolve
//     (`refs.unresolved`); the same totals are returned as `dropped`.
//     `visibility` is asked once per repository and never for a date-shaped
//     one. A reference repeated in the local file is published once.
//   - Public plugins only, unless the store is not public (controller
//     ruling, M3-12). A plugin is named when its install `source`, the GitHub
//     repository it was installed from, is public by `visibility`, or when
//     `storeVisibility` is `"private"` or `"internal"` (a work store). Any
//     other plugin, including one with no known source, and every plugin
//     when the store's visibility is unknown, is counted in
//     `refs.private.plugins` and in `dropped.plugins`. The source itself is
//     never published.
//   - No date or time shapes. A model ID or plugin name holding an ISO date
//     (such as `gpt-4o-2024-08-06`) loses that date's hyphens
//     (`gpt-4o-20240806`), and a model ID holding a time of day loses its
//     colons (repeatedly, since removing one can uncover the other), so the
//     file passes the public gate's date and time checks
//     without losing the model. That date is the model's or plugin's
//     release, not when the work happened, so keeping its digits says
//     nothing about the session.
//   - Outcomes. Each task outcome entry keeps its state, verified flag,
//     reason code, delivery count and a wait class (`lt_1h`, `lt_1d`,
//     `lt_7d`, `ge_7d`, and whether the wait is still running); the
//     delivery, sign-off and observation times, and any exact wait, stay
//     local. The job ID is keyed exactly as the `jobs` entries' are, on every
//     desk class.
//   - Human turns. Each turn keeps its basis, its gap and two size classes;
//     its time becomes `at_ms`, milliseconds since `started_at`, on the same
//     clock as the intervals. A turn outside that clock is dropped, never
//     moved, and `human_turns` is marked `source_unreadable`. A desk that is
//     not private publishes the same list: it holds no text and no date.
//
// `publishedClock(local)` is the session clock alone: the same duration,
// intervals and refusals `toPublished` produces, for the waste evaluator,
// whose labels must cite exactly the intervals the store will hold.
//
// `toPublishedLabels(labels, { deskVisibility, machineSecret })` is the
// labels' transform. Local labels (`desk.factory.labels/3`, `/2` or `/1`, `label-schema.js`)
// are already on the published session clock and carry no free text, so
// only the job changes: a desk that is not known to be private publishes
// the same keyed job ID as its facts. The file goes to
// `labels/<job>/<session id>.json`.
//
// `unavailable` keeps the local entries once each and adds the transform's
// own markers after them. Nothing is trimmed: the schema limit holds every
// field with every reason once, so the union always fits. A public store
// that hides a plugin adds `{plugins, withheld_public}`. The transform is
// pure and deterministic: it never mutates its input, shares no object with
// it and reads no clock.
//
// `src/factory/**` imports only `node:` built-ins and other `src/factory/`
// files.

import { createHmac } from "node:crypto"

import { publishedAgentType } from "./agent-types.js"
import { validateLabels } from "./label-schema.js"
import { PRIVATE_VISIBILITIES, deskTimingKept } from "./desk-visibility.js"
import { waitClass } from "./outcome.js"
import { intervalInSession } from "./pipeline/timeline.js"
import { validateLocalFacts } from "./schema.js"
import { DATE_SHAPE, FINISHED_ON_MIN, PUBLISHED_LIMITS, PUBLISHED_SCHEMA, SESSION_ID_V4, publishableToken, scrub, validatePublished } from "./published-schema.js"

/** Why `toPublished` returned no file. */
export const REFUSALS = Object.freeze(["implausible_session_span", "session_id_not_v4"])

/** No session this transform publishes can start earlier: neither host existed before it. */
export const EARLIEST_SESSION_START = "2025-01-01T00:00:00.000Z"

// Desks whose remote is known not to be public keep their job timing.
// Stores known not to be public (a work store) keep every plugin's name.

const MIN_SECRET_BYTES = 32

// The reason an interval dropped for running outside the published session clock gives its field.
const OUTSIDE_SESSION_CLOCK = "interval_outside_session_clock"

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

// The worker's number, parent and models, plus its agent type when it has one: kept
// for a built-in type or a public plugin's type, `custom` for any other. A per-worker
// value the published validator would reject never blocks the file: the model becomes
// `unknown`, the requested model is left out and the type is `custom`.
function publishAgent(agent, host, publicPluginNames) {
  return {
    n: agent.n,
    parent: agent.parent,
    model: publishableToken(scrub(agent.model)) ? scrub(agent.model) : "unknown",
    ...(Object.hasOwn(agent, "agent_type") ? { agent_type: publishedAgentType(host, agent.agent_type, publicPluginNames) } : {}),
    ...(Object.hasOwn(agent, "requested_model") && publishableToken(scrub(agent.requested_model)) ? { requested_model: scrub(agent.requested_model) } : {}),
  }
}

function publishSession(session, durationMs, id) {
  return {
    host: session.host,
    id,
    host_version: session.host_version,
    entrypoint: session.entrypoint,
    duration_ms: durationMs,
    ended: session.ended_at !== null,
    end_reason: session.end_reason,
  }
}

const NOT_RECORDED_STOP = Object.freeze({ end: "not_recorded", asks: null, pending_agents: null })

function publishIntervals(intervals, startedMs, durationMs, flag) {
  const kept = []
  for (const interval of intervals) {
    const startMs = Date.parse(interval.start) - startedMs
    const endMs = Date.parse(interval.end) - startedMs
    if (!intervalInSession(startMs, endMs, durationMs)) {
      flag(INTERVAL_FIELD[interval.kind], OUTSIDE_SESSION_CLOCK)
      continue
    }
    const out = { kind: interval.kind, agent: interval.agent }
    if (interval.kind === "tool") {
      out.tool = interval.tool
      out.outcome = interval.outcome
    }
    out.start_ms = startMs
    out.end_ms = endMs
    if (interval.kind === "human_wait") {
      const stop = interval.stop ?? NOT_RECORDED_STOP
      out.stop = { end: stop.end, asks: stop.asks, pending_agents: stop.pending_agents }
    }
    kept.push(out)
  }
  return kept
}

// `visibility` asked once per repository, for references and plugin sources alike.
function publicRepos(visibility) {
  const answers = new Map()
  return (repo) => {
    if (!answers.has(repo)) answers.set(repo, visibility(repo) === "public")
    return answers.get(repo)
  }
}

// `timed`: whether a controller PR and a commit keep their `at_ms` (see `toPublished`). `deskPrivate`: whether a PR may say it was created.
function publishRefs(refs, askPublic, timed, deskPrivate) {
  const isPublic = (repo) => repo !== null && !DATE_SHAPE.test(repo) && askPublic(repo)
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
  const prs = keep(refs.prs, "prs", (pr) => `${pr.repo}#${pr.number}`, (pr) => ({
    repo: pr.repo,
    number: pr.number,
    ...(Object.hasOwn(pr, "agent") ? { agent: pr.agent } : {}),
    ...(timed && pr.agent === 0 && Object.hasOwn(pr, "at_ms") ? { at_ms: pr.at_ms } : {}),
    created: deskPrivate && pr.created === true,
  }))
  const commits = keep(refs.commits, "commits", (commit) => commit.sha, (commit) => ({
    repo: commit.repo,
    sha: commit.sha,
    ...(timed && Object.hasOwn(commit, "at_ms") ? { at_ms: commit.at_ms } : {}),
  }))
  return { prs, commits, dropped }
}

const TOKEN_KEYS = ["input", "output", "cache_read", "cache_write", "reasoning"]

// The sum of two counts; unknown (`null`) when either is unknown or the sum is unsafe, as everywhere else.
function sumKnown(a, b) {
  if (a === null || b === null) return null
  const sum = a + b
  return Number.isSafeInteger(sum) ? sum : null
}

// A model id the published validator would refuse publishes as `unknown`. Models that end up with the same id merge, so the published ids stay unique, and the result is sorted by id. A merged count that cannot be summed is unknown, and says so in `unavailable`.
function publishModels(models, flag) {
  const byId = new Map()
  const merged = (field, a, b) => {
    const sum = sumKnown(a, b)
    if (sum === null && !(a === null && b === null)) flag(field, "source_unreadable")
    return sum
  }
  for (const model of models) {
    const id = publishableToken(scrub(model.id)) ? scrub(model.id) : "unknown"
    const held = byId.get(id)
    if (held === undefined) {
      byId.set(id, { id, requests: model.requests, tokens: Object.fromEntries(TOKEN_KEYS.map((key) => [key, model.tokens[key]])) })
    } else {
      held.requests = merged("requests", held.requests, model.requests)
      for (const key of TOKEN_KEYS) held.tokens[key] = merged("tokens", held.tokens[key], model.tokens[key])
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1))
}

// A plugin is named in a public store only when it was installed from a public
// repository; the rest are counted. A store known not to be public names them all.
// A name the published validator would refuse (a credential-shaped one) is hidden the same way.
function publishPlugins(plugins, isPublic, storeVisibility) {
  const privateStore = PRIVATE_VISIBILITIES.has(storeVisibility)
  const kept = []
  const names = []
  let hidden = 0
  for (const plugin of plugins) {
    const source = plugin.source ?? null
    if (publishableToken(scrub(plugin.name)) && (privateStore || (source !== null && isPublic(source)))) {
      kept.push({ name: scrub(plugin.name), version: plugin.version })
      names.push(plugin.name)
    } else hidden += 1
  }
  return { plugins: kept, hidden, names }
}

// The per-machine keyed form of a job ID, for a desk that is not known to be private.
export function keyedJobId(job, machineSecret) {
  return createHmac("sha256", machineSecret).update(job).digest("hex").slice(0, 32)
}

const SESSION_ID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u

function validSecret(machineSecret) {
  return machineSecret instanceof Uint8Array && machineSecret.length >= MIN_SECRET_BYTES
}

/** The session ID as it publishes: a v4 unchanged, a v7 as a keyed v4-shaped ID, which needs the machine secret on any desk. */
function publishedSessionId(id, machineSecret, caller) {
  if (!SESSION_ID_V7.test(id)) return id
  if (!validSecret(machineSecret)) throw new TypeError(`${caller}: a version-7 session ID needs a machineSecret of at least 32 bytes`)
  const hex = createHmac("sha256", machineSecret).update(`session:${id}`).digest("hex").slice(0, 32)
  const variant = "89ab"[Number.parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

// Whether job timing is kept; a desk that withholds it needs the key for its job IDs.
function deskIsPrivate(deskVisibility, machineSecret, caller) {
  const deskPrivate = deskTimingKept(deskVisibility)
  if (!deskPrivate && !validSecret(machineSecret)) {
    throw new TypeError(`${caller}: a desk that is not private needs a machineSecret of at least 32 bytes`)
  }
  return deskPrivate
}

// Why a session cannot be published at all, or `null`.
function refusalOf(local, startedMs, durationMs) {
  if (durationMs > PUBLISHED_LIMITS.maxOffsetMs || startedMs < Date.parse(EARLIEST_SESSION_START)) return "implausible_session_span"
  if (!SESSION_ID_V4.test(local.session.id) && !SESSION_ID_V7.test(local.session.id)) return "session_id_not_v4"
  return null
}

// The job's workers, when it records them (absent: every worker in the session).
function agentsOf(job) {
  return Object.hasOwn(job, "agents") ? { agents: [...job.agents] } : {}
}

// A public (or not surely private) desk's job: a keyed ID and no timing.
function protectedJob(job, machineSecret) {
  return {
    job: keyedJobId(job.job, machineSecret),
    basis: [...job.basis],
    session_offset_ms: null,
    transitions: [],
    observed: job.observed === null ? null : { status: job.observed.status, offset_ms: null },
    ...agentsOf(job),
    finished_on: null,
    finished_basis: null,
  }
}

const TERMINAL = new Set(["done", "cancelled"])
const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10)

// The job's finish day and its source (see the header): the last published transition into the terminal status the card was observed in,
// else the published observation. `transitionMs` holds each published transition's instant.
function finishOf(observed, transitions, transitionMs, observedMs, now) {
  const none = { finished_on: null, finished_basis: null }
  if (observed === null || !TERMINAL.has(observed.status)) return none
  let latest = null
  transitions.forEach((transition, index) => {
    if (transition.to === observed.status && (latest === null || transitionMs[index] > latest)) latest = transitionMs[index]
  })
  let found = none
  if (latest !== null) found = { finished_on: utcDay(latest), finished_basis: "transition" }
  else if (observed.offset_ms !== null) found = { finished_on: utcDay(observedMs), finished_basis: "card_updated" }
  if (found.finished_on === null || found.finished_on < FINISHED_ON_MIN) return none
  if (Number.isFinite(now) && found.finished_on > utcDay(now)) return none
  return found
}

function publishJob(job, startedMs, flag, now) {
  const anchor = job.task_created_at === null ? null : Date.parse(job.task_created_at)
  const offsetOf = (ms) => {
    if (anchor === null) return null
    const offset = ms - anchor
    return Math.abs(offset) <= PUBLISHED_LIMITS.maxOffsetMs ? offset : null
  }

  const sessionOffset = offsetOf(startedMs)
  let lost = sessionOffset === null
  const transitions = []
  const transitionMs = []
  for (const transition of job.transitions) {
    const offset = offsetOf(Date.parse(transition.at))
    if (offset === null) lost = true
    else {
      transitions.push({ to: transition.to, offset_ms: offset })
      transitionMs.push(Date.parse(transition.at))
    }
  }
  let observed = null
  if (job.observed !== null) {
    const offset = job.observed.at === null ? null : offsetOf(Date.parse(job.observed.at))
    if (job.observed.at !== null && offset === null) lost = true
    observed = { status: job.observed.status, offset_ms: offset }
  }
  if (lost) flag("job_offsets", "source_unreadable")

  return {
    job: job.job, basis: [...job.basis], session_offset_ms: sessionOffset, transitions, observed, ...agentsOf(job),
    ...(Object.hasOwn(job, "segments") ? { segments: job.segments.map((segment) => ({ ...segment })) } : {}),
    ...finishOf(observed, transitions, transitionMs, observed === null || job.observed.at === null ? null : Date.parse(job.observed.at), now),
  }
}

// How long a delivery waited for its sign-off, as a coarse class and never a number. A signed delivery (accepted or refused) waited from delivery to sign-off; an unsigned one has waited at least from delivery to the time it was observed (`censored`). Any other state, a missing time, or a difference that is negative or not finite has no wait: `null`, never a zero and never the lowest class.
function publishWait(entry) {
  const censored = entry.state === "delivered_unsigned"
  if (!censored && entry.state !== "accepted" && entry.state !== "refused") return null
  const end = censored ? entry.observed_at : entry.signed_at
  if (entry.delivered_at === null || end === null) return null
  const ms = Date.parse(end) - Date.parse(entry.delivered_at)
  if (!Number.isFinite(ms) || ms < 0) return null
  return { class: waitClass(ms), censored }
}

// The published counts stop at 9999 (read it as "9999 or more"), so a larger local value never makes the whole file invalid.
const capped = (count) => Math.min(count, 9999)

// A return as published: its codes and flag, and no time.
const publishReturn = (item) => ({ reason: item.reason, caught: item.caught, counts: item.counts, refusal: item.refusal, refusal_verified: item.refusal_verified })

// The outcome entries as published: the state and its codes, the delivery count, the wait class and, when the entry has them, the record's start and its returns, with no time (the milestone times stay local). `keyJob` gives a job's published id, which is exactly the id its `jobs` entry has.
function publishOutcomes(local, { keyJob }) {
  return local.outcomes
    .map((entry) => ({
      job: keyJob(entry.job), rev: capped(entry.rev), state: entry.state, verified: entry.verified, reason: entry.reason, deliveries: capped(entry.deliveries), wait: publishWait(entry),
      ...(Object.hasOwn(entry, "since") ? { since: entry.since } : {}),
      ...(Object.hasOwn(entry, "returns") ? { returns: entry.returns.map(publishReturn) } : {}),
      ...(Object.hasOwn(entry, "returns_truncated") ? { returns_truncated: entry.returns_truncated } : {}),
      ...(Object.hasOwn(entry, "returns_unreadable") ? { returns_unreadable: capped(entry.returns_unreadable) } : {}),
    }))
    .sort((a, b) => (a.job < b.job ? -1 : 1))
}

// The human turns on the session clock, as intervals are: `at_ms` is the prompt's time minus `started_at`. A turn before the start or after `derived_through` cannot be placed on that clock; it is dropped, never moved, and the field is marked `source_unreadable`, as for an interval.
function publishHumanTurns(turns, startedMs, durationMs, flag) {
  const kept = []
  for (const turn of turns) {
    const atMs = Date.parse(turn.at) - startedMs
    if (!intervalInSession(atMs, atMs, durationMs)) {
      flag("human_turns", "source_unreadable")
      continue
    }
    kept.push({ at_ms: atMs, basis: turn.basis, window_ms: turn.window_ms, prompt_class: turn.prompt_class, output_class: turn.output_class })
  }
  return kept
}

/**
 * `toPublished(local, { visibility, deskVisibility, storeVisibility,
 * machineSecret, now }) -> { published, dropped: { prs, commits, plugins } }`,
 * or `{ published: null,
 * dropped: null, reason }` with a reason from `REFUSALS` when the session
 * cannot be published at all.
 *
 * `local` must pass `validateLocalFacts`; `visibility(repo)` answers
 * `"public"`, `"private"` or `"unknown"` for an `owner/repo` name;
 * `deskVisibility` is the same answer for the desk's own remote (`"private"`
 * or `"internal"` keep job timing; anything else, including a missing
 * value, withholds it); `storeVisibility` is the same answer for the store
 * the file goes to (`"private"` or `"internal"` name every plugin; anything
 * else, including a missing value, names only plugins whose `source`
 * repository is public); `machineSecret` (at least 32 bytes) keys the job IDs
 * of a desk that withholds its timing and is required then; `now`, when a
 * finite number of milliseconds, withholds a finish day after its UTC day
 * (the transform reads no clock of its own). These are
 * caller contracts: a violation throws a `TypeError` that names no value.
 */
export function toPublished(local, { visibility, deskVisibility, storeVisibility, machineSecret, now } = {}) {
  if (typeof visibility !== "function") throw new TypeError("toPublished: visibility must be a function")
  if (!validateLocalFacts(local).ok) throw new TypeError("toPublished: local facts must pass validateLocalFacts")
  const deskPrivate = deskIsPrivate(deskVisibility, machineSecret, "toPublished")
  const sessionId = publishedSessionId(local.session.id, machineSecret, "toPublished")

  const startedMs = Date.parse(local.session.started_at)
  const durationMs = Date.parse(local.session.derived_through) - startedMs
  const reason = refusalOf(local, startedMs, durationMs)
  if (reason !== null) return { published: null, dropped: null, reason }

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
  // Marked before `unavailable` is built below; absent in local facts stays absent.
  const humanTurns = Object.hasOwn(local, "human_turns") ? publishHumanTurns(local.human_turns, startedMs, durationMs, flag) : null
  const isPublic = publicRepos(visibility)
  // Job segments and controller PR and commit times are job timing: a desk that withholds its timing publishes none of them.
  // Elsewhere a PR's `at_ms` is published only where it decides a PR's job: a controller (worker 0) PR in a session whose jobs carry segments.
  // A commit's `at_ms` follows the same rule; a commit names no worker, and the one host that times commits (Copilot) records them as the root's.
  const refs = publishRefs(local.refs, isPublic, deskPrivate && local.jobs.some((job) => Object.hasOwn(job, "segments")), deskPrivate)
  const plugins = publishPlugins(local.plugins, isPublic, storeVisibility)
  const dropped = { ...refs.dropped, plugins: plugins.hidden }
  // A list with names left out says so, so a short list never reads as the whole one.
  if (plugins.hidden > 0) flag("plugins", "withheld_public")
  const jobs = deskPrivate
    ? local.jobs.map((job) => publishJob(job, startedMs, flag, now))
    : local.jobs.map((job) => protectedJob(job, machineSecret)).sort((a, b) => (a.job < b.job ? -1 : 1))
  if (!deskPrivate && jobs.length > 0) flag("job_offsets", "desk_public")

  // Every flag is raised before the list is built: the models' merge can raise one.
  const models = publishModels(local.models, flag)
  const unavailable = [...localEntries.filter((entry) => !has(own, entry.field, entry.reason)), ...own]
  const published = {
    schema: PUBLISHED_SCHEMA,
    session: publishSession(local.session, durationMs, sessionId),
    plugins: plugins.plugins,
    models,
    agents: local.agents.map((agent) => publishAgent(agent, local.session.host, plugins.names)),
    intervals,
    counts: {
      tool_calls: { ...local.counts.tool_calls },
      tool_failures: { ...local.counts.tool_failures },
      tool_retries: local.counts.tool_retries,
      api_retries: local.counts.api_retries,
      compactions: local.counts.compactions,
    },
    refs: { prs: refs.prs, commits: refs.commits, private: { ...dropped } },
    jobs,
    unavailable,
    ...(Object.hasOwn(local, "outcomes") ? { outcomes: publishOutcomes(local, { keyJob: deskPrivate ? (job) => job : (job) => keyedJobId(job, machineSecret) }) } : {}),
    ...(humanTurns === null ? {} : { human_turns: humanTurns }),
  }
  return { published, dropped: { ...dropped } }
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

/**
 * `publishedClock(local) -> { clock: { duration_ms, ended, intervals } }`,
 * or `{ clock: null, reason }` with a reason from `REFUSALS`: the published
 * session clock `toPublished` would produce for valid local facts, and
 * nothing else. An interval `toPublished` drops is dropped here too. A
 * version-7 session (Codex) has a clock, because `toPublished` publishes it
 * under a keyed ID; the labels path cannot carry that ID, so callers that
 * label sessions test `SESSION_ID_V4` on the local ID themselves.
 */
export function publishedClock(local) {
  if (!validateLocalFacts(local).ok) throw new TypeError("publishedClock: local facts must pass validateLocalFacts")
  const startedMs = Date.parse(local.session.started_at)
  const durationMs = Date.parse(local.session.derived_through) - startedMs
  const reason = refusalOf(local, startedMs, durationMs)
  if (reason !== null) return { clock: null, reason }
  return {
    clock: {
      duration_ms: durationMs,
      ended: local.session.ended_at !== null,
      intervals: publishIntervals(local.intervals, startedMs, durationMs, () => {}),
    },
  }
}

/**
 * `toPublishedLabels(labels, { deskVisibility, machineSecret }) -> { path,
 * published }`: valid local labels as the store receives them, at
 * `labels/<job>/<session id>.json`. The job is keyed exactly as
 * `toPublished` keys it; everything else is copied field by field. Caller
 * contracts as for `toPublished`: a violation throws a `TypeError` that
 * names no value.
 */
export function toPublishedLabels(labels, { deskVisibility, machineSecret } = {}) {
  // The labels schema is the published one (version-4 sessions), so a version-7 session is mapped before it is checked.
  const session = publishedSessionId(String(labels?.session), machineSecret, "toPublishedLabels")
  if (!validateLabels({ ...labels, session }).ok) throw new TypeError("toPublishedLabels: labels must pass validateLabels")
  const job = deskIsPrivate(deskVisibility, machineSecret, "toPublishedLabels") ? labels.job : keyedJobId(labels.job, machineSecret)
  const published = {
    schema: labels.schema,
    job,
    session,
    evaluator: { plugin_version: labels.evaluator.plugin_version, model: labels.evaluator.model, rubric: labels.evaluator.rubric },
    stretches: labels.stretches.map((stretch) => ({
      start_ms: stretch.start_ms,
      end_ms: stretch.end_ms,
      class: stretch.class,
      waste: stretch.waste,
      mura: stretch.mura,
      muri: stretch.muri,
      evidence: stretch.evidence.map((range) => [range[0], range[1]]),
      ...(Object.hasOwn(stretch, "confidence") ? { confidence: stretch.confidence, evaluator_version: stretch.evaluator_version } : {}),
      ...(Object.hasOwn(stretch, "caught") ? { caught: stretch.caught } : {}),
    })),
    ...(Object.hasOwn(labels, "stops") ? { stops: labels.stops.map((stop) => ({ wait: [stop.wait[0], stop.wait[1]], why: stop.why, confidence: stop.confidence, evaluator_version: stop.evaluator_version })) } : {}),
    unavailable: [...labels.unavailable],
  }
  return { path: `labels/${job}/${session}.json`, published }
}
