// Claude Code deriver tests, run against the synthetic fixtures built by
// `fixtures/claude/make.js`. No fixture line, prompt, tool input or tool
// output was copied from a real transcript — everything here is invented,
// and every free-text field in the fixtures carries `SENTINEL` so the
// privacy test below can assert it never reaches the derived facts.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { deriveClaudeSession, __internals__ } from "../../src/factory/derive-claude.js"
import { validateFacts } from "../../src/factory/schema.js"
import { SENTINEL, COMMIT_SHA, SESSION_IDS } from "./fixtures/claude/make.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const fixturesDir = path.join(here, "fixtures", "claude")
const transcriptPath = (sessionId) => path.join(fixturesDir, `${sessionId}.jsonl`)

const CONTRIBUTOR = "0f3a9c1d2b4e6f70"
const PLUGINS = [{ name: "desk", version: "3.2.0-alpha.21" }]
const NOW = "2026-09-25T12:00:00.000Z"

function deriveFull(overrides = {}) {
  return deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.full),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: "prompt_input_exit",
    now: NOW,
    ...overrides,
  })
}

function findInterval(intervals, predicate) {
  return intervals.filter(predicate)
}

// --- Missing transcript -----------------------------------------------------

test("a missing transcript returns facts: null, events: null, reason: log_missing", async () => {
  const result = await deriveClaudeSession({
    transcriptPath: path.join(fixturesDir, "does-not-exist.jsonl"),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: null,
    now: NOW,
  })
  assert.deepEqual(result, { facts: null, events: null, reason: "log_missing" })
})

// --- Privacy: no raw content reaches facts ----------------------------------

test("no sentinel from the fixture's messages, prompts, tool input or output reaches the serialized facts", async () => {
  const { facts, events } = await deriveFull()
  assert.equal(JSON.stringify(facts).includes(SENTINEL), false)
  // The sentinel is expected to survive into the in-memory binding events
  // (track/slug/file paths never leave the machine) — confirms the fixture
  // actually planted it somewhere the facts assertion above would have caught.
  assert.equal(JSON.stringify(events).includes(SENTINEL), true)
})

test("the derived facts pass validateFacts", async () => {
  const { facts } = await deriveFull()
  const result = validateFacts(facts)
  assert.deepEqual(result.errors, [])
  assert.equal(result.ok, true)
})

// --- Usage dedup -------------------------------------------------------------

test("usage duplicated across three lines of one message id counts once", async () => {
  const { facts } = await deriveFull()
  // msg-1a's usage (100 in / 40 out / 10 cache_read / 5 cache_write) must be
  // counted once, not three times, under its own model (claude-haiku-5) —
  // duplication is decided per message id, independent of which model owns it.
  const haiku = facts.models.find((model) => model.id === "claude-haiku-5")
  assert.equal(haiku.requests, 1)
  assert.equal(haiku.tokens.input, 100)
  assert.equal(haiku.tokens.output, 40)
  assert.equal(haiku.tokens.cache_read, 10)
  assert.equal(haiku.tokens.cache_write, 5)
  assert.equal(haiku.tokens.reasoning, null)

  // The remaining ten root messages (msg-2 through msg-9, and the two API
  // error lines, one of them with `null` usage fields that must fall back
  // to 0 independently of each other) are all claude-opus-5-5.
  const opus = facts.models.find((model) => model.id === "claude-opus-5-5")
  assert.equal(opus.requests, 10)
  assert.equal(opus.tokens.input, 20 + 12 + 9 + 7 + 2 + 6 + 0 + 0 + 5 + 3)
  assert.equal(opus.tokens.output, 15 + 8 + 3 + 4 + 1 + 2 + 0 + 0 + 5 + 2)
  assert.equal(opus.tokens.cache_read, 0)
  assert.equal(opus.tokens.cache_write, 0)
  assert.equal(opus.tokens.reasoning, null)
})

// --- API retry ----------------------------------------------------------------

test("a 429 line yields one api_retry interval and api_retries: 1; a non-retryable 400 error does not", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.counts.api_retries, 1)
  const apiRetryIntervals = findInterval(facts.intervals, (iv) => iv.kind === "api_retry")
  assert.equal(apiRetryIntervals.length, 1)
  assert.equal(apiRetryIntervals[0].agent, 0)
  assert.ok(apiRetryIntervals[0].end > apiRetryIntervals[0].start)
})

test("a retryable 5xx error with no later assistant line adds neither a retry nor an interval", async () => {
  const { facts } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.truncated),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: "clear",
    now: NOW,
  })
  assert.equal(facts.counts.api_retries, 0)
  assert.deepEqual(findInterval(facts.intervals, (iv) => iv.kind === "api_retry"), [])
})

// --- Tool outcomes -------------------------------------------------------------

test("interrupted, timeout and is_error outcomes are reported on the right tool intervals", async () => {
  const { facts } = await deriveFull()
  const toolIntervals = findInterval(facts.intervals, (iv) => iv.kind === "tool")
  const byOutcome = (outcome) => toolIntervals.filter((iv) => iv.outcome === outcome)
  assert.equal(byOutcome("error").length, 1)
  assert.equal(byOutcome("interrupted").length, 1)
  assert.equal(byOutcome("timeout").length, 1)
  assert.equal(byOutcome("ok").length, 6) // bash retry, both desk calls, write, and the subagent's read + edit
  assert.equal(byOutcome("interrupted")[0].tool, "read")
  assert.equal(byOutcome("timeout")[0].tool, "shell")
  assert.equal(byOutcome("error")[0].tool, "shell")
})

test("one retry after an error", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.counts.tool_retries, 1)
})

test("tool call and failure counts are bucketed by toolKind and merged across agents", async () => {
  const { facts } = await deriveFull()
  // read and edit each get one call from the root agent and one from the
  // subagent, merged into the same session-wide bucket.
  assert.deepEqual(facts.counts.tool_calls, { shell: 3, read: 2, desk: 2, edit: 2 })
  assert.deepEqual(facts.counts.tool_failures, { shell: 1 })
})

// --- Subagent ------------------------------------------------------------------

test("one subagent with its own model", async () => {
  const { facts } = await deriveFull()
  assert.deepEqual(facts.agents, [
    { n: 0, parent: null, model: "claude-opus-5-5" },
    { n: 1, parent: 0, model: "claude-sonnet-5" },
  ])
  const sonnet = facts.models.find((model) => model.id === "claude-sonnet-5")
  // Three subagent assistant messages, including the one whose tool_use
  // never resolved — its usage still counts, since the model call happened.
  assert.equal(sonnet.requests, 3)
  assert.equal(sonnet.tokens.input, 2 + 1 + 1)
  assert.equal(sonnet.tokens.output, 3 + 1 + 2)
})

test("a tool_use with no matching tool_result is dropped, not fabricated into an interval or count", async () => {
  const { facts } = await deriveFull()
  const subagentToolIntervals = findInterval(facts.intervals, (iv) => iv.kind === "tool" && iv.agent === 1)
  // Only sub-tool-2 (edit) and sub-tool-3 (read) resolved; sub-tool-1 did not.
  assert.equal(subagentToolIntervals.length, 2)
})

test("the parent's Agent tool call becomes a subagent interval, not a tool interval", async () => {
  const { facts } = await deriveFull()
  const subagentIntervals = findInterval(facts.intervals, (iv) => iv.kind === "subagent")
  assert.equal(subagentIntervals.length, 1)
  assert.equal(subagentIntervals[0].agent, 0)
  assert.equal("tool" in subagentIntervals[0], false)
  assert.equal("outcome" in subagentIntervals[0], false)
  // It must not also show up as a "tool" interval or inflate counts.tool_calls.agent.
  assert.equal(facts.counts.tool_calls.agent, undefined)
})

// --- Turns and human waits -------------------------------------------------------

test("a turn and a human wait with the right bounds, ignoring a hook-injected line", async () => {
  const { facts } = await deriveFull()
  const turns = findInterval(facts.intervals, (iv) => iv.kind === "turn" && iv.agent === 0)
  const waits = findInterval(facts.intervals, (iv) => iv.kind === "human_wait")
  assert.equal(turns.length, 3)
  assert.equal(waits.length, 2)
  // Turn 1 starts at the first human prompt and ends at the last assistant
  // line before the next real human prompt (msg-7's retry reply) — the
  // hook-injected line in between must not move that boundary.
  assert.equal(turns[0].start, "2026-09-25T08:00:00.000Z")
  assert.equal(waits[0].start, turns[0].end)
  assert.equal(turns[1].start, waits[0].end)
  assert.ok(Date.parse(waits[0].end) > Date.parse(waits[0].start))
  assert.equal(waits[1].start, turns[1].end)
  assert.equal(turns[2].start, waits[1].end)
  // Turn 3's prompt has nothing after it at all: a degenerate turn whose end
  // equals its own start, since there is no later activity to bound it.
  assert.equal(turns[2].start, turns[2].end)
})

// --- Refs ------------------------------------------------------------------------

test("pr-link and gitOperation.pr refs are deduplicated and sorted by repo then number", async () => {
  const { facts } = await deriveFull()
  // #42 is seen through both pr-link and gitOperation.pr and must collapse
  // to one entry; #7 (same repo) and #3 (a different repo) stay separate.
  assert.deepEqual(facts.refs.prs, [
    { repo: "another-org/repo", number: 3 },
    { repo: "ourostack/desk", number: 7 },
    { repo: "ourostack/desk", number: 42 },
  ])
  assert.deepEqual(facts.refs.commits, [])
})

// --- Compactions -------------------------------------------------------------------

test("a compact_boundary system line counts one compaction", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.counts.compactions, 1)
})

// --- Binding events (never written, only ever in memory) ---------------------------

test("Desk task_update and task_create tool calls become binding events, not facts", async () => {
  const { events } = await deriveFull()
  assert.equal(events.deskToolCalls.length, 2)
  const update = events.deskToolCalls.find((call) => call.name === "mcp__plugin_desk_desk__task_update")
  assert.equal(update.track, `${SENTINEL}-track`)
  assert.equal(update.slug, `${SENTINEL}-slug`)
  assert.equal(update.person, null)
  assert.equal(update.status, "processing")
  assert.equal(update.ok, true)

  // The second call sets neither status nor person: both must fall back to
  // null independently, not just whichever one the first call happened to omit.
  const create = events.deskToolCalls.find((call) => call.name === "mcp__plugin_desk_desk__task_create")
  assert.equal(create.track, `${SENTINEL}-track2`)
  assert.equal(create.slug, `${SENTINEL}-slug2`)
  assert.equal(create.person, null)
  assert.equal(create.status, null)
  assert.equal(create.ok, true)
})

test("Write tool_use and file-history-delta lines both become file-write events, merged across agents", async () => {
  const { events } = await deriveFull()
  assert.equal(events.fileWrites.length, 3)
  assert.ok(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-path/file.txt`))
  assert.ok(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-tracked/path.txt`))
  assert.ok(events.fileWrites.some((entry) => entry.path === `${SENTINEL}-sub-edit-path`))
})

test("a 40-hex token in a Bash result's stdout becomes a commitShas event, deduplicated", async () => {
  const { events } = await deriveFull()
  assert.deepEqual(events.commitShas, [COMMIT_SHA])
})

// --- session envelope ---------------------------------------------------------------

test("session id, host_version and entrypoint come from the transcript; ended_at is set when endReason is given", async () => {
  const { facts } = await deriveFull()
  assert.equal(facts.session.host, "claude-code")
  assert.equal(facts.session.id, SESSION_IDS.full)
  assert.equal(facts.session.host_version, "2.1.282")
  assert.equal(facts.session.entrypoint, "desktop")
  assert.equal(facts.session.end_reason, "prompt_input_exit")
  assert.equal(facts.session.ended_at, facts.session.derived_through)
  assert.equal(facts.unavailable.some((entry) => entry.field === "ended_at"), false)
})

test("entrypoint cli and sdk-* both map correctly", async () => {
  const truncated = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.truncated),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: "clear",
    now: NOW,
  })
  assert.equal(truncated.facts.session.entrypoint, "cli")

  const unreadable = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.unreadable),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: null,
    now: NOW,
  })
  assert.equal(unreadable.facts.session.entrypoint, "sdk")
})

// --- unavailable: unconditional entries -----------------------------------------------

test("unavailable always covers permission_waits, ci_runs and commits", async () => {
  const { facts } = await deriveFull()
  assert.deepEqual(
    facts.unavailable.filter((entry) => ["permission_waits", "ci_runs", "commits"].includes(entry.field)),
    [
      { field: "permission_waits", reason: "host_does_not_record" },
      { field: "ci_runs", reason: "not_collected_in_slice_1" },
      { field: "commits", reason: "host_does_not_record" },
    ],
  )
})

// --- Truncation --------------------------------------------------------------------

test("a truncated last line is reported as turns/log_truncated only, since earlier lines still parsed", async () => {
  const { facts } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.truncated),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: "clear",
    now: NOW,
  })
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "turns"), [{ field: "turns", reason: "log_truncated" }])
  assert.equal(facts.unavailable.some((entry) => entry.field === "models"), false)
  assert.equal(facts.models.length, 1)
  assert.equal(validateFacts(facts).ok, true)
})

// --- No assistant lines / unreadable -------------------------------------------------

test("a non-final malformed line with no assistant lines yields models: [] and models/source_unreadable, not log_truncated", async () => {
  const { facts } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.unreadable),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: null,
    now: NOW,
  })
  assert.deepEqual(facts.models, [])
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "models"), [{ field: "models", reason: "source_unreadable" }])
  assert.equal(facts.unavailable.some((entry) => entry.field === "turns"), false)
  assert.deepEqual(facts.unavailable.filter((entry) => entry.field === "ended_at"), [{ field: "ended_at", reason: "session_open" }])
  assert.equal(facts.session.ended_at, null)
  assert.equal(facts.counts.compactions, 1)
  assert.equal(validateFacts(facts).ok, true)
})

// --- A completely empty transcript file ----------------------------------------------

// --- Comparators, tested directly since a real session's own ordering
// can't reliably force every direction of a sort comparison ------------------

test("compareByStart orders by start time, both directions and a tie", () => {
  const { compareByStart } = __internals__
  const earlier = { start: "2026-01-01T00:00:00.000Z" }
  const later = { start: "2026-01-01T00:00:01.000Z" }
  const sameAsEarlier = { start: "2026-01-01T00:00:00.000Z" }
  assert.equal(compareByStart(earlier, later), -1)
  assert.equal(compareByStart(later, earlier), 1)
  assert.equal(compareByStart(earlier, sameAsEarlier), 0)
})

test("comparePrRefs orders by number within a repo, and by repo name across repos in both directions", () => {
  const { comparePrRefs } = __internals__
  assert.equal(comparePrRefs({ repo: "a/a", number: 1 }, { repo: "a/a", number: 2 }), -1)
  assert.equal(comparePrRefs({ repo: "a/a", number: 2 }, { repo: "a/a", number: 1 }), 1)
  assert.equal(comparePrRefs({ repo: "a/a", number: 1 }, { repo: "b/b", number: 1 }) < 0, true)
  assert.equal(comparePrRefs({ repo: "b/b", number: 1 }, { repo: "a/a", number: 1 }) > 0, true)
})

test("a zero-line transcript falls back to the file name for session id and to now for timestamps, without a spurious source_unreadable", async () => {
  const { facts } = await deriveClaudeSession({
    transcriptPath: transcriptPath(SESSION_IDS.empty),
    contributor: CONTRIBUTOR,
    plugins: PLUGINS,
    endReason: null,
    now: NOW,
  })
  assert.equal(facts.session.id, SESSION_IDS.empty)
  assert.equal(facts.session.host_version, "0.0.0")
  assert.equal(facts.session.entrypoint, "unknown")
  assert.equal(facts.session.started_at, NOW)
  assert.equal(facts.session.derived_through, NOW)
  assert.equal(facts.session.ended_at, null)
  assert.deepEqual(facts.models, [])
  // No lines failed to parse (there simply were none), so no source_unreadable.
  assert.equal(facts.unavailable.some((entry) => entry.field === "models"), false)
  assert.deepEqual(facts.agents, [{ n: 0, parent: null, model: "unknown" }])
  assert.deepEqual(facts.intervals, [])
  assert.equal(validateFacts(facts).ok, true)
})
