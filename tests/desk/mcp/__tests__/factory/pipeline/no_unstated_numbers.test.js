// The last check of the number-states package: no number the pipeline writes lacks its state.
//
// The test builds three stores and walks every JSON file under `jobs/` (the per-session swimlane files under `jobs/<job>/` too) and `rollups/` of each: the two checked-in fixture stores
// (published facts `/1`, read through the legacy reader) and one store freshly derived from the three hosts' fixtures (`/2`).
// Every numeric leaf must sit inside a number object (`class` and `state`), inside a rollup stat or totals leaf (`n`, `N`, `state`),
// or on `STRUCTURAL`, where each entry says why the number needs no state. A new numeric leaf outside all three fails the test.

import "../../_isolated_env.mjs"
import { after, test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { ATTENTION_REASON_TEXT, OUTCOME_REASONS, REASON_TEXT } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/report.js"
import { ATTENTION_REASONS } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/attention.js"
import { NUMBER_STATES } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"
import { deriveClaudeSession } from "../../../../../../plugins/desk/mcp/src/factory/derive-claude.js"
import { deriveCodexSession } from "../../../../../../plugins/desk/mcp/src/factory/derive-codex.js"
import { deriveCopilotSession } from "../../../../../../plugins/desk/mcp/src/factory/derive-copilot.js"
import { addUnavailable } from "../../../../../../plugins/desk/mcp/src/factory/derive-common.js"
import { hostFlagsFor } from "../../../../../../plugins/desk/mcp/src/factory/host-flags.js"
import { LABEL_UNAVAILABLE } from "../../../../../../plugins/desk/mcp/src/factory/label-schema.js"
import { publishedFileName, serializePublished, toPublished } from "../../../../../../plugins/desk/mcp/src/factory/publish.js"
import { validateLocalFacts } from "../../../../../../plugins/desk/mcp/src/factory/schema.js"
import { SESSION_IDS, SENTINEL as CLAUDE_SENTINEL } from "../fixtures/claude/make.js"
import { STARTS, THREAD_IDS, rolloutRelPath, SENTINEL as CODEX_SENTINEL } from "../fixtures/codex/make.js"
import { SESSIONS, SENTINEL as COPILOT_SENTINEL, buildSessionStore, defaultStoreRows, fakeCommitResolver } from "../fixtures/copilot/make.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const FIXTURES = path.join(here, "..", "fixtures")
const SOURCE = path.join(here, "..", "..", "..", "..", "..", "..", "plugins", "desk", "mcp", "src", "factory")
const STATES = Object.freeze(["measured", "partial", "unavailable"])
const PATH_SENTINEL = "PATH-SENTINEL-4c9e"
const PLUGINS = [{ name: "desk", version: "3.2.0-alpha.21", source: "ourostack/desk" }]
const SECRET = Buffer.alloc(32, 9)

const roots = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})
const tempRoot = (label) => {
  const root = mkdtempSync(path.join(os.tmpdir(), `desk-factory-${label}-`))
  roots.push(root)
  return root
}

// ---------------------------------------------------------------------------
// The structural allow-list. A path is the file kind, then the keys down to the number, with `[]` for a list entry and `*` for any key.
// ---------------------------------------------------------------------------

const STRUCTURAL = Object.freeze([
  ["job/timeline/intervals/[]/agent", "a worker number, an identifier"],
  ["job/timeline/intervals/[]/start_ms", "an interval time on the job clock: where it sits, not a measure; an interval that was not recorded has no entry"],
  ["job/timeline/intervals/[]/end_ms", "an interval time on the job clock: where it sits, not a measure; an interval that was not recorded has no entry"],
  ["job/timeline/observations/[]/offset_ms", "a time of an observed status on the job clock; an observation with no time has no entry"],
  ["job/timeline/sessions/[]/duration_ms", "the session's own published span, always present in the published facts"],
  ["job/timeline/sessions/[]/end_ms", "where the session ends on the job clock, null when it is not known"],
  ["job/timeline/sessions/[]/offset_ms", "where the session starts on the job clock, null when it is not known"],
  ["job/timeline/sessions/[]/shared_with", "a count of other jobs sharing the session, read from the facts' job list"],
  ["job/timeline/transitions/[]/offset_ms", "a transition time on the job clock; a transition with no time is not listed"],
  ["job/timeline/agents/[]/n", "a worker number, an identifier"],
  ["job/timeline/agents/[]/parent", "the worker number of a worker's parent, an identifier; null for the main agent"],
  ["job/timeline/prs/[]/number", "a pull request number, an identifier"],
  ["job/timeline/prs/[]/at_ms", "when a pull request was opened, on the job clock; absent when the facts carry no time for it (a public desk's never do)"],
  ["job/timeline/human_turns/[]/at_ms", "when a human prompt arrived, on the job clock; a turn that cannot be placed on this job is not listed"],
  ["job/timeline/human_turns/[]/window_ms", "the time from the agent's stop (or the previous prompt) to this prompt, published in the facts; null for the first prompt"],
  ["session/offset_ms", "where the session starts on the job clock; a session with no job offset has no swimlane file"],
  ["session/end_ms", "where the session ends on the job clock, its offset plus its published span"],
  ["session/intervals/[]/start_ms", "an interval time on the job clock: where it sits, not a measure; an interval that was not recorded has no entry"],
  ["session/intervals/[]/end_ms", "an interval time on the job clock: where it sits, not a measure; an interval that was not recorded has no entry"],
  ["session/intervals/[]/worker", "a worker number, an identifier"],
  ["session/stretches/[]/start_ms", "where a labeled stretch starts on the job clock, copied from the labels; an unlabeled span has no stretch"],
  ["session/stretches/[]/end_ms", "where a labeled stretch ends on the job clock, copied from the labels; an unlabeled span has no stretch"],
  ["session/stretches/[]/evidence/[]", "an index into the file's own interval list, naming the interval a stretch cites"],
  ["job/timeline/prs/[]/worker", "the worker number that opened the pull request, an identifier; absent when the facts do not name one"],
  ["job/timeline/lead_window/start_ms", "where the lead window starts on the job clock; the window carries the lead time's own state and reasons"],
  ["job/timeline/lead_window/end_ms", "where the lead window ends on the job clock; the window carries the lead time's own state and reasons"],
  ["job/timeline/bursts/[]/start_ms", "where a work burst starts on the job clock, read from recorded intervals; no recorded work is no burst"],
  ["job/timeline/bursts/[]/end_ms", "where a work burst ends on the job clock, read from recorded intervals; no recorded work is no burst"],
  ["job/timeline/bursts/[]/working_ms", "the union of the burst's recorded work intervals, which exist because the burst does"],
  ["job/timeline/bursts/[]/agents", "a count of the workers with recorded work in the burst, read from its intervals"],
  ["job/timeline/bursts/[]/tool_calls", "a count of the recorded tool intervals in the burst"],
  ["job/timeline/bursts/[]/tool_failures", "a count of the recorded tool intervals in the burst whose outcome was not ok"],
  ["job/timeline/bursts/[]/operator_turns", "a count of the job's recorded human turns placed in the burst; the job's attention result states whether turns were recorded"],
  ["job/timeline/bursts/[]/prs", "a count of the job's timed pull requests placed in the burst; an untimed one is listed under prs with no time"],
  ["job/timeline/bursts/[]/value_ms", "labeled value time inside the burst; the stack-up and task rows state whether the job's labels are whole"],
  ["job/timeline/bursts/[]/defect_ms", "labeled defect time inside the burst; the stack-up and task rows state whether the job's labels are whole"],
  ["job/timeline/bursts/[]/defect_stretches", "a count of the labeled defect stretches inside the burst; the task row states whether the labels are whole"],
  ["job/timeline/gaps/[]/start_ms", "where a gap between bursts starts on the job clock, inside the lead window"],
  ["job/timeline/gaps/[]/end_ms", "where a gap between bursts ends on the job clock, inside the lead window"],
  ["rollups/stackup.json/burst_idle_gap_ms", "the idle gap that ends a work burst, a constant of the method published so the bursts can be reproduced"],
  ["rollups/tasks.json/jobs/[]/longest_gap/value/start_ms", "where the longest gap starts on the job clock, covered by the figure's state"],
  ["rollups/tasks.json/jobs/[]/longest_gap/value/end_ms", "where the longest gap ends on the job clock, covered by the figure's state"],
  ["rollups/tasks.json/jobs/[]/longest_gap/value/duration_ms", "the longest gap's length, covered by the figure's state"],
  ["rollups/tasks.json/jobs/[]/top_causes/value/[]/total_ms", "a top cause's time, covered by the list's state"],
  ["rollups/tasks.json/jobs/[]/top_causes/value/[]/hours", "a top cause's time in hours, covered by the list's state"],
  ["job/formulas/attention/turns", "a count of the human turns placed on the job, covered by the result's state (partial when a list was cut or a session records none)"],
  ["job/formulas/attention/method", "the version of the estimate's constants, a label for the method and not a measure"],
  ["job/formulas/concurrent_agents/value/average", "a composite value: the average over recorded intervals, covered by the enclosing result's state"],
  ["job/formulas/concurrent_agents/value/maximum", "a composite value: the maximum over recorded intervals, covered by the enclosing result's state"],
  ["job/formulas/concurrent_sessions/value/average", "a composite value: the average over recorded intervals, covered by the enclosing result's state"],
  ["job/formulas/concurrent_sessions/value/maximum", "a composite value: the maximum over recorded intervals, covered by the enclosing result's state"],
  ["job/formulas/lead_contributors/value/[]/share", "a contributor's share of the lead time, covered by the list's state; a partial entry carries its own partial mark"],
  ["job/formulas/lead_contributors/value/[]/value_ms", "a contributor's time, covered by the list's state; a partial entry carries its own partial mark"],
  ["job/formulas/lead_contributors/value/[]/uncovered_sessions", "how many sessions a partial contributor entry lacks, part of that entry's own partial mark"],
  ["job/formulas/longest_wait/value/duration_ms", "the longest wait found, covered by the result's state (partial when a wait kind is not whole)"],
  ["job/formulas/longest_wait/value/start_ms", "where the longest wait starts on the job clock, covered by the result's state"],
  ["job/formulas/longest_wait/value/end_ms", "where the longest wait ends on the job clock, covered by the result's state"],
  ["job/formulas/references/value/public_prs", "a count in the composite; null when its part is unavailable, checked against the part by a test"],
  ["job/formulas/references/value/public_commits", "a count in the composite; null when its part is unavailable, checked against the part by a test"],
  ["job/formulas/references/value/private_prs", "a count in the composite; null when its part is unavailable, checked against the part by a test"],
  ["job/formulas/references/value/private_commits", "a count in the composite; null when its part is unavailable, checked against the part by a test"],
  ["job/formulas/references/value/public_pull_requests/[]/number", "a pull request number, an identifier"],
  ["job/formulas/sessions/value/bound", "a count of sessions in the job, covered by the result's state"],
  ["job/formulas/sessions/value/shared", "a count of sessions in the job, covered by the result's state"],
  ["job/formulas/sessions/value/shared_with_jobs", "a count of sessions in the job, covered by the result's state"],
  ["job/formulas/sessions/value/timeline", "a count of sessions in the job, covered by the result's state"],
  ["job/formulas/sessions_by_host/value/*", "a count of the job's sessions on a host, covered by the result's state"],
  ["job/formulas/tool_calls_by_kind/value/*", "a count of tool calls of one kind, covered by the result's state (partial when a session's calls are unresolved or capped)"],
  ["job/formulas/unavailable/value/[]/count", "how many of the job's sessions carry the named flag, a count of flags the facts hold"],
  ["rollups/coverage.json/bound_sessions", "a count of sessions the build holds, a population count that is never missing"],
  ["rollups/coverage.json/flagged/[]/N", "the denominator of a flag count: sessions with facts"],
  ["rollups/coverage.json/flagged/[]/sessions", "how many sessions carry the named flag, a count over files the build holds"],
  ["rollups/coverage.json/hosts/[]/sessions", "how many sessions the build holds for a host"],
  ["rollups/coverage.json/jobs", "a count of jobs the build holds"],
  ["rollups/coverage.json/jobs_open", "a count of open jobs the build holds"],
  ["rollups/coverage.json/labels/files", "a count of label files the build read"],
  ["rollups/coverage.json/labels/jobs_labeled", "a count of jobs with labels, a population count"],
  ["rollups/coverage.json/labels/jobs_partially_labeled", "a count of jobs with labels, a population count"],
  ["rollups/coverage.json/labels/jobs_unlabeled", "a count of jobs with labels, a population count"],
  ["rollups/coverage.json/labels/unused/[]/files", "a count of label files left unused for the named reason"],
  ["rollups/coverage.json/labels/used", "a count of label files used"],
  ["rollups/coverage.json/session_time_ms", "the sum of the published session spans the build holds, which are always present"],
  ["rollups/coverage.json/sessions_with_facts", "a count of sessions the build holds"],
  ["rollups/coverage.json/unattributed_session_time_ms", "the sum of the published spans of sessions bound to no job"],
  ["rollups/coverage.json/unattributed_sessions", "a count of sessions bound to no job"],
  ["rollups/measures.json/groupings/*/*/jobs", "a count of jobs in the group, a population count; each measure under it carries its own n and N"],
  ["rollups/measures.json/groupings/*/*/jobs_open", "a count of open jobs in the group, a population count"],
  ["rollups/tool-kinds.json/sessions", "a count of sessions the build holds"],
  ["rollups/outcomes.json/attention/est_ms/*", "estimated attention placed on jobs, on no job or on sessions that could not be placed, the parts of the headline's numerator; the headline's state says whether the sum is whole"],
  ["rollups/outcomes.json/attention/human_turns", "a count of the human turns in the period's sessions, covered by the headline's state (partial when a session did not record all of them)"],
  ["rollups/outcomes.json/attention/method/version", "the version of the estimate's constants, a label for the method and not a measure"],
  ["rollups/outcomes.json/attention/method/floor_ms", "a constant of the estimating method, published so the estimate can be reproduced"],
  ["rollups/outcomes.json/attention/method/permission_ms", "a constant of the estimating method, published so the estimate can be reproduced"],
  ["rollups/outcomes.json/attention/method/read_ms/*", "a constant of the estimating method, published so the estimate can be reproduced"],
  ["rollups/outcomes.json/attention/method/type_ms/*", "a constant of the estimating method, published so the estimate can be reproduced"],
  ["rollups/outcomes.json/attention/permission/decisions", "a count of permission decisions, covered by the permission figure's own state"],
  ["rollups/outcomes.json/attention/permission/est_ms", "the estimate of permission decisions, covered by the permission figure's own state"],
  ["rollups/outcomes.json/attention/sessions/in_period", "a count of the sessions that carry or flag the human turns, a population count"],
  ["rollups/outcomes.json/attention/sessions/complete", "a count of the period's sessions that record the human turns completely, a population count"],
  ["rollups/outcomes.json/groupings/plugin_version/*/attention/est_ms/*", "a plugin version group's part of the estimated attention, covered by the group's headline state"],
  ["rollups/outcomes.json/groupings/plugin_version/*/attention/human_turns", "a plugin version group's count of human turns, covered by the group's headline state"],
])

function matches(pattern, segments) {
  const wanted = pattern.split("/")
  return wanted.length === segments.length && wanted.every((part, index) => part === "*" || part === segments[index])
}

// ---------------------------------------------------------------------------
// The walk.
// ---------------------------------------------------------------------------

const isNumber = (value) => typeof value === "number"
// A swimlane file's stretches are labels, whose `class` is the label's class (value, support, muda, unknown), not a number class.
const isLabelStretch = (kind, segments) => kind === "session" && segments.join("/") === "stretches/[]"
const isNumberObject = (node) => Object.hasOwn(node, "class")
const isStat = (node) => Number.isInteger(node.n) && Number.isInteger(node.N) && Object.hasOwn(node, "state")

/**
 * Every JSON file under `jobs/` and `rollups/` of a build output, as `{ kind, name, value }`, including each job's per-session swimlane
 * files under `jobs/<job>/` (kind `session`), which are published next to the job files.
 */
function outputJson(out) {
  const found = []
  const read = (file) => JSON.parse(readFileSync(file, "utf8"))
  for (const dir of ["jobs", "rollups"]) {
    for (const name of readdirSync(path.join(out, dir)).sort()) {
      const at = path.join(out, dir, name)
      if (dir === "jobs" && statSync(at).isDirectory()) {
        for (const session of readdirSync(at).sort()) found.push({ kind: "session", name: `${dir}/${name}/${session}`, value: read(path.join(at, session)) })
        continue
      }
      if (!name.endsWith(".json")) continue
      found.push({ kind: dir === "jobs" ? "job" : `rollups/${name}`, name: `${dir}/${name}`, value: read(at) })
    }
  }
  return found
}

/**
 * Walks one file. Returns what it saw: the number objects (nested ones too), the stats and the numeric leaves outside them, each with its path.
 * A number object's own `value` and `uncovered_sessions` are covered by its state when they are numbers; every other numeric leaf under it
 * (the counts inside an object-valued result) is a bare leaf and must be on the allow-list, and every nested object with a `class` is checked in turn.
 */
function walk(file) {
  const seen = { numberObjects: [], stats: [], bare: [] }
  const visit = (node, segments) => {
    if (Array.isArray(node)) {
      node.forEach((entry) => visit(entry, [...segments, "[]"]))
    } else if (node !== null && typeof node === "object") {
      if (isNumberObject(node) && !isLabelStretch(file.kind, segments)) {
        seen.numberObjects.push({ node, at: segments.join("/") })
        for (const [key, child] of Object.entries(node)) {
          if (key === "state" || key === "reasons") continue
          if (isNumber(child) && (key === "value" || key === "uncovered_sessions")) continue
          visit(child, [...segments, key])
        }
        return
      }
      if (isStat(node)) {
        seen.stats.push({ node, at: segments.join("/") })
        return
      }
      for (const [key, child] of Object.entries(node)) visit(child, [...segments, key])
    } else if (isNumber(node)) {
      seen.bare.push([...file.kind.split("/"), ...segments])
    }
  }
  visit(file.value, [])
  return seen
}

/** A number inside a number object, a stat or a totals leaf: the shape of the state it carries. */
function stateProblems(node, at) {
  const problems = []
  if (!STATES.includes(node.state)) return [`${at}: state ${String(node.state)} is not one of the three`]
  if (Object.hasOwn(node, "reasons")) {
    if (!Array.isArray(node.reasons)) problems.push(`${at}: reasons is not a list`)
    else if ((node.reasons.length === 0) !== (node.state === "measured")) problems.push(`${at}: state ${node.state} with ${node.reasons.length} reasons`)
  }
  return problems
}

function numberObjectProblems({ node, at }) {
  const problems = []
  if (!Object.hasOwn(node, "state")) return [`${at}: a number object with no state`]
  if (!Object.hasOwn(node, "reasons")) problems.push(`${at}: a number object with no reasons`)
  problems.push(...stateProblems(node, at))
  if (node.state === "unavailable" && node.value !== null && node.value !== undefined) problems.push(`${at}: unavailable with a value`)
  if (node.state !== "unavailable" && (node.value === null || node.value === undefined)) problems.push(`${at}: ${node.state} with no value`)
  return problems
}

function statProblems({ node, at }) {
  const problems = stateProblems(node, at)
  if (node.n > node.N) problems.push(`${at}: n ${node.n} is over N ${node.N}`)
  if (!STATES.includes(node.state)) return problems
  if (node.state === "measured" && node.n !== node.N) problems.push(`${at}: measured with n ${node.n} of N ${node.N}`)
  if (node.state === "partial" && node.n === node.N && !Object.hasOwn(node, "value")) problems.push(`${at}: partial with every one counted`)
  if (node.state === "unavailable") {
    for (const key of ["value", "median", "p75"]) {
      if (Object.hasOwn(node, key) && node[key] !== null) problems.push(`${at}: unavailable with ${key}`)
    }
  }
  // A number that is not whole always says why: a reasons list, or the reasons jobs were left out.
  const why = node.reasons ?? node.jobs_excluded
  if (why === undefined) {
    if (node.state !== "measured") problems.push(`${at}: state ${node.state} with no reasons`)
  } else if ((why.length === 0) !== (node.state === "measured")) problems.push(`${at}: state ${node.state} with ${why.length} reasons`)
  if (Object.hasOwn(node, "jobs_counted") && node.jobs_counted !== node.n) problems.push(`${at}: jobs_counted ${node.jobs_counted} is not n ${node.n}`)
  return problems
}

// ---------------------------------------------------------------------------
// The three stores.
// ---------------------------------------------------------------------------

const fixtureOut = (store) => {
  const out = path.join(tempRoot("out"), "out")
  build({ storeDir: path.join(FIXTURES, store), outDir: out })
  return out
}

/** Copies a fixture folder under a name that carries the path sentinel, so the path a deriver reads is itself a planted secret. */
function copyFixture(from, name) {
  const dest = path.join(tempRoot(name), PATH_SENTINEL)
  mkdirSync(dest, { recursive: true })
  cpSync(from, dest, { recursive: true })
  return dest
}

async function deriveAll() {
  const claudeDir = tempRoot("claude")
  const claudeHome = path.join(claudeDir, PATH_SENTINEL)
  mkdirSync(claudeHome, { recursive: true })
  const claudeId = SESSION_IDS.full
  cpSync(path.join(FIXTURES, "claude", `${claudeId}.jsonl`), path.join(claudeHome, `${claudeId}.jsonl`))
  cpSync(path.join(FIXTURES, "claude", claudeId), path.join(claudeHome, claudeId), { recursive: true })

  const codexHome = copyFixture(path.join(FIXTURES, "codex"), "codex")
  const copilotHome = path.join(tempRoot("copilot"), PATH_SENTINEL)
  const sessionDir = path.join(copilotHome, "session-state", SESSIONS.full)
  mkdirSync(sessionDir, { recursive: true })
  cpSync(path.join(FIXTURES, "copilot", SESSIONS.full, "events.jsonl"), path.join(sessionDir, "events.jsonl"))
  cpSync(path.join(FIXTURES, "copilot", SESSIONS.full, "workspace.yaml"), path.join(sessionDir, "workspace.yaml"))
  buildSessionStore(path.join(copilotHome, "session-store.db"), defaultStoreRows())

  const claude = await deriveClaudeSession({ transcriptPath: path.join(claudeHome, `${claudeId}.jsonl`), plugins: PLUGINS, endReason: "prompt_input_exit" })
  const codex = await deriveCodexSession({ rolloutPath: path.join(codexHome, rolloutRelPath(STARTS.root, THREAD_IDS.root)), codexHome, plugins: PLUGINS, endReason: "complete" })
  const copilot = await deriveCopilotSession({ sessionId: SESSIONS.full, copilotHome, resolveCommits: fakeCommitResolver(), plugins: PLUGINS, endReason: "complete" })
  return { claude: claude.facts, codex: codex.facts, copilot: copilot.facts, inputs: [claudeHome, codexHome, copilotHome] }
}

const JOB_WHOLE = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
const JOB_SPLIT = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
const JOB_REST = "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3"
const JOB_CODEX = "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4"

function bound(facts, job, agents) {
  const from = Date.parse(facts.session.started_at)
  const at = (ms) => new Date(from + ms).toISOString()
  return {
    ...facts,
    jobs: [{
      job, ...(agents === undefined ? {} : { agents }), basis: ["desk_tool"], task_created_at: null,
      transitions: [{ to: "processing", at: at(1000) }, { to: "done", at: at(10000) }], observed: { status: "done", at: at(10500) },
    }],
  }
}

const publish = (local) => toPublished(local, { visibility: () => "public", deskVisibility: "private", storeVisibility: "private", machineSecret: SECRET })

/** The derived `/2` store: one Claude session whose workers two jobs share, the Copilot session with the whole of the first, and a Codex session of its own. */
async function derivedStore() {
  const derived = await deriveAll()
  const claudeAgents = derived.claude.agents.map((agent) => agent.n)
  assert.ok(claudeAgents.length >= 2, "the Claude fixture has subagents, so a job can own only some of its workers")
  const first = bound(derived.claude, JOB_SPLIT, [0])
  // The card was created a second before the session started, so the job clock places the session, its human turns and its pull
  // requests, and the walk sees those timeline numbers.
  first.jobs[0].task_created_at = new Date(Date.parse(derived.claude.session.started_at) - 1000).toISOString()
  // The Claude fixture records one prompt, the first, whose window is null; a second prompt after the agent stopped gives the walk a
  // human turn with a window.
  const promptAt = Date.parse(derived.claude.human_turns[0].at) + 2000
  first.human_turns = [...derived.claude.human_turns, { at: new Date(promptAt).toISOString(), basis: "after_stop", window_ms: 1500, prompt_class: "s", output_class: "s" }]
  // The controller's whole span is this job's, so its turns can be placed on it and its attention is a figure.
  first.jobs[0].segments = [{ start_ms: 0, end_ms: Math.floor(Date.parse(derived.claude.session.derived_through) - Date.parse(derived.claude.session.started_at)) }]
  const second = bound(derived.claude, JOB_REST, claudeAgents.slice(1))
  // One Claude session two jobs share: the first owns the controller, the second the subagents.
  const claude = { ...first, jobs: [...first.jobs, ...second.jobs].sort((a, b) => (a.job < b.job ? -1 : 1)) }
  const locals = [claude, bound(derived.copilot, JOB_SPLIT), bound(derived.codex, JOB_CODEX)]
  const files = locals.map((local) => {
    assert.deepEqual(validateLocalFacts(local).errors, [], "the derived and bound facts are valid")
    const { published, reason } = publish(local)
    assert.ok(published, `the session publishes (${reason})`)
    return published
  })
  const store = tempRoot("store")
  mkdirSync(path.join(store, "facts"))
  mkdirSync(path.join(store, "labels"))
  for (const published of files) writeFileSync(path.join(store, "facts", publishedFileName(published)), serializePublished(published))
  const out = path.join(tempRoot("out"), "out")
  build({ storeDir: store, outDir: out })
  return { derived, files, store, out }
}

const legacy = fixtureOut("store")
const rollupLegacy = fixtureOut("rollup-store")
const fresh = await derivedStore()
const STORES = Object.freeze([
  ["the /1 store", legacy],
  ["the /1 rollup store", rollupLegacy],
  ["the freshly derived /2 store", fresh.out],
])

const walked = STORES.flatMap(([label, out]) => outputJson(out).map((file) => ({ label, file, seen: walk(file) })))

const readJob = (out, job) => JSON.parse(readFileSync(path.join(out, "jobs", `${job}.json`), "utf8")).formulas

// ---------------------------------------------------------------------------
// The tests.
// ---------------------------------------------------------------------------

test("the walk sees the files it is meant to see", () => {
  for (const [label, out] of STORES) {
    const kinds = outputJson(out).map((file) => file.kind)
    assert.ok(kinds.filter((kind) => kind === "job").length >= 2, `${label}: job files`)
    assert.ok(kinds.includes("session"), `${label}: per-session swimlane files`)
    for (const name of ["coverage", "measures", "muda", "tool-kinds", "totals"]) assert.ok(kinds.includes(`rollups/${name}.json`), `${label}: ${name}`)
  }
  assert.deepEqual(fresh.files.map((published) => published.schema), Array(3).fill("desk.factory.published/2"))
  assert.ok(walked.reduce((sum, { seen }) => sum + seen.numberObjects.length, 0) > 300, "number objects were walked")
  assert.ok(walked.reduce((sum, { seen }) => sum + seen.stats.length, 0) > 100, "stats and totals leaves were walked")
})

test("every number object under a job's formulas has state and reasons", () => {
  for (const { label, file, seen } of walked) {
    if (file.kind !== "job") continue
    for (const entry of seen.numberObjects) assert.deepEqual(numberObjectProblems(entry), [], `${label} ${file.name}`)
  }
})

test("every number object anywhere in the rollups has state and reasons too", () => {
  for (const { label, file, seen } of walked) {
    if (file.kind === "job") continue
    for (const entry of seen.numberObjects) assert.deepEqual(numberObjectProblems(entry), [], `${label} ${file.name}`)
  }
})

test("every rollup stat has n, N and state and n <= N, and a number that is not whole says why", () => {
  for (const { label, file, seen } of walked) {
    for (const entry of seen.stats) assert.deepEqual(statProblems(entry), [], `${label} ${file.name}`)
  }
  const stats = walked.flatMap(({ seen }) => seen.stats.map(({ node }) => node))
  for (const state of STATES) assert.ok(stats.some((node) => node.state === state), `a ${state} stat was walked`)
  assert.ok(STATES.every((state) => NUMBER_STATES.includes(state)), "the three states are the ones the pipeline names")
})

test("every numeric leaf is inside a number object, inside a stat or totals leaf, or on the structural allow-list", () => {
  const used = new Set()
  const stray = []
  for (const { label, file, seen } of walked) {
    for (const segments of seen.bare) {
      const index = STRUCTURAL.findIndex(([pattern]) => matches(pattern, segments))
      if (index === -1) stray.push(`${label} ${file.name}: ${segments.join("/")}`)
      else used.add(index)
    }
  }
  assert.deepEqual(stray, [], "a numeric leaf outside every number object, stat and allow-list entry")
  const stale = STRUCTURAL.filter((_, index) => !used.has(index)).map(([pattern]) => pattern)
  assert.deepEqual(stale, [], "an allow-list entry no number matches")
  for (const [pattern, why] of STRUCTURAL) assert.ok(why.length > 20, `${pattern} names why it is structural`)
})

test("the walk has teeth: a bare number, a stateless number object and a stat that counts more than it has are all found", () => {
  const bare = walk({ kind: "job", value: { formulas: { lead_time_ms: { class: "measured", state: "measured", reasons: [], value: 1 }, parallelism: 2 } } })
  assert.deepEqual(bare.bare, [["job", "formulas", "parallelism"]])
  assert.deepEqual(numberObjectProblems({ node: { class: "measured", value: 1 }, at: "x" }), ["x: a number object with no state"])
  assert.deepEqual(numberObjectProblems({ node: { class: "measured", state: "measured", value: 1 }, at: "x" }), ["x: a number object with no reasons"])
  assert.deepEqual(numberObjectProblems({ node: { class: "measured", state: "measured", reasons: ["capped"], value: 1 }, at: "x" }), ["x: state measured with 1 reasons"])
  assert.deepEqual(numberObjectProblems({ node: { class: "unavailable", state: "unavailable", reasons: ["capped"], value: 0 }, at: "x" }), ["x: unavailable with a value"])
  assert.deepEqual(statProblems({ node: { n: 3, N: 2, state: "partial", jobs_excluded: [{ jobs: 1, reason: "capped" }] }, at: "s" }), ["s: n 3 is over N 2"])
  assert.deepEqual(statProblems({ node: { n: 2, N: 2, state: "maybe" }, at: "s" }), ["s: state maybe is not one of the three"])
  assert.deepEqual(statProblems({ node: { n: 1, N: 2, state: "measured", jobs_excluded: [{ jobs: 1, reason: "capped" }] }, at: "s" }).length, 2)
  assert.deepEqual(statProblems({ node: { n: 0, N: 2, state: "unavailable", median: 0, jobs_excluded: [{ jobs: 2, reason: "capped" }] }, at: "s" }), ["s: unavailable with median"])
  assert.deepEqual(statProblems({ node: { n: 0, N: 2, state: "unavailable", reasons: [], value: null }, at: "s" }), ["s: state unavailable with 0 reasons", "s: state unavailable with 0 reasons"])
})

test("the walk descends into number objects: a bare number in references.parts or in a composite value under a new key is found", () => {
  const onList = (segments) => STRUCTURAL.some(([pattern]) => matches(pattern, segments))
  const result = (extra) => ({ class: "inferred", state: "partial", reasons: ["host_records_partly"], value: 1, ...extra })
  const nestedBare = walk({ kind: "job", value: { formulas: { references: result({ parts: { public_prs: 3 } }) } } })
  assert.deepEqual(nestedBare.bare, [["job", "formulas", "references", "parts", "public_prs"]])
  assert.equal(onList(nestedBare.bare[0]), false)
  const nestedStateless = walk({ kind: "job", value: { formulas: { references: result({ parts: { public_prs: { class: "measured", value: 3 } } }) } } })
  assert.deepEqual(nestedStateless.numberObjects.map((entry) => entry.at), ["formulas/references", "formulas/references/parts/public_prs"])
  assert.deepEqual(numberObjectProblems(nestedStateless.numberObjects[1]), ["formulas/references/parts/public_prs: a number object with no state"])
  const composite = walk({ kind: "job", value: { formulas: { references: result({ value: { public_prs: 1, brand_new_count: 5 } }) } } })
  assert.deepEqual(composite.bare.map((segments) => onList(segments)), [true, false])
  assert.deepEqual(composite.bare[1], ["job", "formulas", "references", "value", "brand_new_count"])
  assert.deepEqual(numberObjectProblems({ node: { class: "measured", state: "measured", reasons: [], value: null }, at: "m" }), ["m: measured with no value"])
  assert.deepEqual(statProblems({ node: { n: 1, N: 2, state: "partial" }, at: "s" }), ["s: state partial with no reasons"])
})

test("each count in references.value agrees with its part: null exactly when the part is unavailable, the part's value otherwise", () => {
  let checked = 0
  let nulls = 0
  for (const { label, file } of walked) {
    if (file.kind !== "job") continue
    const { references } = file.value.formulas
    for (const key of ["public_prs", "public_commits", "private_prs", "private_commits"]) {
      const part = references.parts[key]
      const count = references.value[key]
      if (part.state === "unavailable") {
        assert.equal(count, null, `${label} ${file.name} ${key}`)
        nulls += 1
      } else assert.equal(count, part.value, `${label} ${file.name} ${key}`)
      checked += 1
    }
  }
  assert.ok(checked >= 40 && nulls > 0, "both kinds of count were seen")
})

test("a Claude job from the /1 store reads compaction wait as unavailable and commit counts as unavailable", () => {
  const formulas = readJob(rollupLegacy, "1".repeat(32))
  assert.deepEqual(rollupHosts(rollupLegacy, "1".repeat(32)), ["claude-code"])
  assert.equal(formulas.waits.compaction_ms.state, "unavailable")
  assert.equal(formulas.waits.compaction_ms.value, null)
  assert.deepEqual(formulas.waits.compaction_ms.reasons, ["host_does_not_record"])
  assert.equal(formulas.references.parts.public_commits.state, "unavailable")
  assert.equal(formulas.references.parts.private_commits.state, "unavailable")
  assert.equal(formulas.references.value.public_commits, null)
  assert.equal(formulas.references.value.private_commits, null)
  assert.equal(formulas.waits.api_retry_ms.state, "partial")
})

function rollupHosts(out, job) {
  const timeline = JSON.parse(readFileSync(path.join(out, "jobs", `${job}.json`), "utf8")).timeline
  return [...new Set(timeline.sessions.map((session) => session.host))].sort()
}

test("a job whose sessions are split reports a partial token total with worker_split", () => {
  const split = readJob(fresh.out, JOB_SPLIT)
  for (const type of ["total", "input", "output", "cache_read", "cache_write"]) {
    const result = split.tokens_total[type]
    assert.equal(result.state, "partial", `${type} is partial`)
    assert.ok(result.reasons.includes("worker_split"), `${type} names worker_split`)
    assert.equal(typeof result.value, "number", `${type} keeps the whole session's count`)
  }
  const rest = readJob(fresh.out, JOB_REST)
  for (const type of ["total", "input", "output", "cache_read", "cache_write", "reasoning"]) {
    assert.equal(rest.tokens_total[type].state, "unavailable", `${type} of a job holding only part of its one session`)
    assert.ok(rest.tokens_total[type].reasons.includes("worker_split"))
    assert.equal(rest.tokens_total[type].value, null)
  }
})

test("a locally derived session with job_segments capped still carries that flag after the publish transform", () => {
  const local = structuredClone(bound(fresh.derived.copilot, JOB_WHOLE))
  addUnavailable(local.unavailable, "job_segments", "capped")
  assert.deepEqual(validateLocalFacts(local).errors, [])
  const { published } = publish(local)
  assert.deepEqual(published.unavailable.filter((entry) => entry.field === "job_segments"), [{ field: "job_segments", reason: "capped" }])
})

test("every label-check code in label-schema.js that can reach a page has plain text in the report's reason map", () => {
  const source = readFileSync(path.join(SOURCE, "label-schema.js"), "utf8")
  const start = source.indexOf("export function checkLabelsAgainstFacts")
  const end = source.indexOf("// A Desk version", start)
  assert.ok(start > 0 && end > start, "the check function is found")
  const codes = [...source.slice(start, end).matchAll(/addError\(errors, "([a-z_]+)"/g)].map((match) => match[1])
  assert.equal(codes.length, source.slice(start, end).split("addError(").length - 1, "every call that writes a code is read: a new call shape fails here")
  assert.deepEqual([...new Set(codes)].sort(), ["evidence_unmatched", "job_unbound", "range", "session_mismatch"], "the codes the check can write")
  for (const code of [...new Set(codes), ...LABEL_UNAVAILABLE]) {
    assert.ok(Object.hasOwn(REASON_TEXT, code), `${code} has text`)
    assert.ok(REASON_TEXT[code].length > 10, `${code} text is words`)
  }
})

// The reasons the outcome figures carry: named in outcomes.js where they are produced, so a new one cannot ship without words.
test("every reason the outcome figures carry has plain text for the operator, found structurally in outcomes.js", () => {
  const source = readFileSync(path.join(SOURCE, "pipeline", "outcomes.js"), "utf8")
  const found = new Set()
  const patterns = [/\bmissing\("(\w+)"\)/gu, /\bpartialResult\([^\n]*?\["(\w+)"\]/gu, /\breasons: \["(\w+)"\]/gu, /\breasons\.push\([^)]*?"(\w+)" : "(\w+)"\)/gu, /\breasons\.push\("(\w+)"\)/gu]
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) match.slice(1).filter(Boolean).forEach((code) => found.add(code))
  // The reasons the plan names, so a pattern that stops matching cannot hide one.
  const NAMED = ["not_recorded", "signoff_not_recorded", "history_not_recorded", "not_delivered", "returns_not_fully_recorded", "awaiting_signoff", "no_delivered_jobs", "no_refusals", "no_labels", "no_finished_jobs", "not_all_labeled", "active_time_unavailable", "catch_point_not_recorded"]
  for (const code of NAMED) assert.ok(found.has(code), `${code} is produced in outcomes.js`)
  assert.deepEqual([...found].filter((code) => !NAMED.includes(code)), [], "a reason outcomes.js produces that this test does not name")
  for (const code of found) {
    assert.ok(OUTCOME_REASONS.includes(code), `${code} is in the outcome reason table`)
    assert.ok(Object.hasOwn(REASON_TEXT, code), `${code} has text`)
    assert.ok(REASON_TEXT[code].length > 10 && !/[_;()]/u.test(REASON_TEXT[code]), `${code} text is words`)
  }
  assert.deepEqual([...OUTCOME_REASONS].sort(), [...found].sort(), "the table lists exactly the reasons produced")
})

// The reasons the attention figure carries: listed in attention.js, and each has plain words for the operator. The text table is one map by code, and `not_recorded` already says "no outcome record is available" for the outcome figures, so the attention words for it live in their own table.
test("every reason the attention figure carries has plain text for the operator", () => {
  assert.deepEqual(Object.keys(ATTENTION_REASON_TEXT).sort(), [...ATTENTION_REASONS].sort(), "the table lists exactly the reasons the figure can carry")
  for (const code of ATTENTION_REASONS) {
    assert.ok(ATTENTION_REASON_TEXT[code].length > 10 && !/[_;()]/u.test(ATTENTION_REASON_TEXT[code]), `${code} text is words`)
    if (code !== "not_recorded") assert.equal(REASON_TEXT[code], ATTENTION_REASON_TEXT[code], `${code} is in the shared table`)
  }
  assert.notEqual(REASON_TEXT.not_recorded, ATTENTION_REASON_TEXT.not_recorded, "the outcome words for not_recorded are not overwritten")
  // The reasons a host's flag on the turn list passes through already have words.
  for (const code of ["host_records_partly", "source_unreadable", "log_truncated"]) assert.ok(Object.hasOwn(REASON_TEXT, code), code)
})

test("the attention result in every built job file is a count and codes, and says its state", () => {
  let seen = 0
  for (const { file } of walked) {
    if (file.kind !== "job") continue
    const { attention } = file.value.formulas
    assert.ok(attention, `${file.name} has an attention result`)
    seen += 1
    assert.deepEqual(numberObjectProblems({ node: attention, at: `${file.name} attention` }), [])
    const allowed = ["class", "state", "reasons", "value", "reason", "turns", "method", "partial", "partial_reasons"]
    assert.deepEqual(Object.keys(attention).filter((key) => !allowed.includes(key)), [])
    for (const code of attention.reasons) assert.ok(Object.hasOwn(REASON_TEXT, code) || ATTENTION_REASONS.includes(code), `${code} has words`)
    assert.equal(Object.hasOwn(attention, "turns") && attention.state === "unavailable", false, "an unavailable figure carries no turn count")
  }
  assert.ok(seen >= 6)
  // The freshly derived store has one job whose controller span is its own, so a real figure is walked.
  const placed = readJob(fresh.out, JOB_SPLIT).attention
  assert.notEqual(placed.state, "unavailable")
  assert.ok(placed.turns > 0 && placed.value > 0)
  assert.equal(placed.class, "inferred")
  for (const job of [JOB_REST, JOB_CODEX]) assert.equal(readJob(fresh.out, job).attention.state, "unavailable", job)
})

test("every /2 session a deriver writes carries every flag hostFlagsFor returns for its host, for all three hosts", () => {
  const { claude, codex, copilot } = fresh.derived
  for (const facts of [claude, codex, copilot]) {
    const host = facts.session.host
    const expected = hostFlagsFor(host, { entrypoint: facts.session.entrypoint })
    assert.ok(expected.length > 0, `${host} has flags`)
    for (const flag of expected) assert.ok(facts.unavailable.some((entry) => entry.field === flag.field && entry.reason === flag.reason), `${host} carries ${flag.field}/${flag.reason}`)
  }
  assert.deepEqual([claude, codex, copilot].map((facts) => facts.session.host).sort(), ["claude-code", "codex-cli", "copilot-cli"])
  assert.equal(copilot.unavailable.some((entry) => entry.field === "entrypoint"), copilot.session.entrypoint === "cli")
})

// An ISO or slashed date, a time of day (24-hour or 12-hour), a written month and day, a compact date and epoch milliseconds.
const WHEN = /\d{4}-\d{2}-\d{2}|\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{1,2}:\d{2}|\b\d{1,2} ?(am|pm)\b|\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]* \d{1,2}\b|\b20\d{6}\b|\b1[5-9]\d{11}\b/i

/** Every file under a folder, as text. */
function filesUnder(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(root, entry.name)
    return entry.isDirectory() ? filesUnder(child) : [child]
  })
}

test("no output file contains a prompt, command, path, date or time-of-day sentinel", () => {
  // The sentinels really are in the inputs: in prompts, commands and working directories of the logs, and in the folder names.
  const planted = fresh.derived.inputs.flatMap((root) => filesUnder(root).filter((file) => !file.endsWith(".db"))).map((file) => readFileSync(file, "utf8")).join("\n")
  for (const sentinel of new Set([CLAUDE_SENTINEL, CODEX_SENTINEL, COPILOT_SENTINEL])) assert.ok(planted.includes(sentinel), `${sentinel} is in the inputs`)
  assert.ok(fresh.derived.inputs.every((root) => root.includes(PATH_SENTINEL)), "the folder names carry the path sentinel")
  const outputs = [...filesUnder(fresh.out), ...filesUnder(path.join(fresh.store, "facts"))]
  assert.ok(outputs.length > 8)
  for (const file of outputs) {
    const text = readFileSync(file, "utf8")
    for (const sentinel of [CLAUDE_SENTINEL, CODEX_SENTINEL, COPILOT_SENTINEL, PATH_SENTINEL]) assert.equal(text.includes(sentinel), false, `${sentinel} in ${path.basename(file)}`)
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(text), false, `a date in ${path.basename(file)}`)
    assert.equal(WHEN.test(text), false, `a date or time of day in ${path.basename(file)}`)
  }
  for (const [, out] of STORES) {
    for (const file of filesUnder(out)) assert.equal(WHEN.test(readFileSync(file, "utf8")), false, `a date or time of day in ${path.basename(file)}`)
  }
})

test("unflagged measured numbers are unchanged for a session with nothing to flag", () => {
  // The values the Copilot-only job 2222... had before number states existed (base 5a11973c): its host flag feeds only references.
  const formulas = readJob(rollupLegacy, "2".repeat(32))
  assert.deepEqual(rollupHosts(rollupLegacy, "2".repeat(32)), ["copilot-cli"])
  assert.deepEqual([formulas.active_time_ms.value, formulas.active_time_ms.state], [17000, "measured"])
  assert.deepEqual([formulas.lead_time_ms.value, formulas.lead_time_ms.state], [25000, "measured"])
  assert.deepEqual([formulas.active_time_ms.reasons, formulas.lead_time_ms.reasons], [[], []])
  assert.ok(existsSync(path.join(rollupLegacy, "jobs", `${"2".repeat(32)}.json`)))
})
