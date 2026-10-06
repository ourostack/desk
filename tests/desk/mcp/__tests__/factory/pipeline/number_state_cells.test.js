// Walks every (field, formula, host) cell of the table in number-states.js and fails if a flagged input
// yields a bare `measured`. The expectations come from FEEDS and the host table, never from a hand list.
import { test } from "node:test"
import assert from "node:assert/strict"

import { normalizePublished } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/normalize.js"
import { ENUMS } from "../../../../../../plugins/desk/mcp/src/factory/schema.js"
import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { computeRollups } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/rollups.js"
import { buildJobTimeline } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"
import { FEEDS, FORMULA_IDS, NOT_FED, NUMBER_STATES, fieldsFeeding } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"
import { HOST_FLAGS, hostFlagsFor } from "../../../../../../plugins/desk/mcp/src/factory/host-flags.js"

const JOB = "cccccccccccccccccccccccccccccccc"
const PARTLY = "host_records_partly"
const RANK = Object.fromEntries(NUMBER_STATES.map((state, index) => [state, index]))

// Results that are a list of parts, each part carrying its own `uncovered_sessions`, so the result itself has none.
const PER_ENTRY_COUNT = Object.freeze(["lead_contributors"])

// The composite `references` result is the worst of its four parts and has no id of its own.
const COMPOSITES = Object.freeze({ references: ["public_prs", "public_commits", "private_prs", "private_commits"] })

// A published session whose every number is a plain measured value, so a state other than measured can only come from a flag.
function sessionOf(host, index, unavailable, offset = 0) {
  const hex = String(index + 1).repeat(8)
  const id = `${hex}-${hex.slice(0, 4)}-4${hex.slice(0, 3)}-8${hex.slice(0, 3)}-${hex}${hex.slice(0, 4)}`
  return {
    schema: "desk.factory.published/2",
    session: { host, id, host_version: "1.0.0", entrypoint: "launcher", duration_ms: 20000, ended: true, end_reason: "complete" },
    plugins: [{ name: "desk", version: "3.2.0-alpha.48" }],
    models: [{ id: "model-alpha", requests: 3, tokens: { input: 100, output: 200, cache_read: 30, cache_write: 4, reasoning: 5 } }],
    agents: [{ n: 0, parent: null, model: "model-alpha" }, { n: 1, parent: 0, model: "model-alpha" }],
    intervals: [
      { kind: "turn", agent: 0, start_ms: 0, end_ms: 4000 },
      { kind: "tool", agent: 0, tool: "shell", outcome: "error", start_ms: 1000, end_ms: 3000 },
      { kind: "subagent", agent: 1, start_ms: 2000, end_ms: 7000 },
      { kind: "human_wait", agent: 0, start_ms: 7000, end_ms: 9000 },
      { kind: "permission_wait", agent: 0, start_ms: 9000, end_ms: 9500 },
      { kind: "api_retry", agent: 0, start_ms: 9500, end_ms: 9800 },
      { kind: "compaction", agent: 0, start_ms: 9800, end_ms: 10000 },
    ],
    counts: { tool_calls: { shell: 2, agent: 1 }, tool_failures: { shell: 1 }, tool_retries: 1, api_retries: 1, compactions: 1 },
    refs: {
      prs: [{ repo: "ourostack/desk", number: 7 + index }],
      commits: [{ repo: "ourostack/desk", sha: String(index + 1).repeat(40) }],
      private: { prs: 1, commits: 1 },
    },
    jobs: [{ job: JOB, basis: ["desk_tool"], session_offset_ms: offset, transitions: [{ to: "processing", offset_ms: 0 }, { to: "done", offset_ms: 14000 }], observed: { status: "done", offset_ms: 14500 } }],
    unavailable: unavailable.map(([field, reason]) => ({ field, reason })),
  }
}

const hostPairs = (host) => hostFlagsFor(host, { entrypoint: "launcher" }).map((flag) => [flag.field, flag.reason])
// The rollup totals read normalized sessions, so the sessions are normalized the way the build does it.
const TOTALS = Symbol("totals")
const formulasOf = (sessions) => Object.assign(calculateFormulas(buildJobTimeline(JOB, sessions)), { [TOTALS]: computeRollups({ records: [], sessions: sessions.map(normalizePublished), labels: { files: 0, byJobSession: new Map(), unused: [] } }).totals.all })

// The leaves a `totals.*` id stands for: `totals.tokens` is all five token types, the reasoning id is the reasoning type alone.
const TOTAL_LEAVES = Object.freeze({
  "totals.tool_calls": ["tool_calls"],
  "totals.tool_failures": ["tool_failures"],
  "totals.model_requests": ["model_requests"],
  "totals.tokens": ["input", "output", "cache_read", "cache_write", "reasoning"].map((type) => ["tokens", type]),
  "totals.tokens.reasoning": [["tokens", "reasoning"]],
  "totals.subagent_dispatches": ["subagent_dispatches"],
})

// A totals leaf read like a formula result: `uncovered_sessions` is the sessions not in n, and an absent value reads as null so a dropped value fails the walk. Leaves of one id that disagree read as no state at all.
function totalsResult(totals, id) {
  const leaves = TOTAL_LEAVES[id].map((path) => [path].flat().reduce((node, key) => node[key], totals))
  const same = (read) => leaves.every((leaf) => JSON.stringify(read(leaf)) === JSON.stringify(read(leaves[0]))) ? read(leaves[0]) : undefined
  return {
    state: same((leaf) => leaf.state),
    value: leaves.some((leaf) => !Object.hasOwn(leaf, "value")) ? null : leaves[0].value,
    uncovered_sessions: same((leaf) => leaf.N - leaf.n),
    reasons: [...new Set(leaves.flatMap((leaf) => leaf.reasons))].sort(),
  }
}

// Where an id lives in calculateFormulas output. The four reference ids live under `references.parts`.
function resultOf(formulas, id) {
  if (id.startsWith("totals.")) return totalsResult(formulas[TOTALS], id)
  const path = id.startsWith("references.") ? ["references", "parts", id.slice("references.".length)] : id.split(".")
  return path.reduce((node, key) => node?.[key], formulas)
}

// Every id the output carries, the container results listed by their children and `references` by its parts.
function outputIds(formulas) {
  const ids = []
  for (const [key, value] of Object.entries(formulas)) {
    if (Object.hasOwn(COMPOSITES, key)) ids.push(...Object.keys(value.parts).map((part) => `${key}.${part}`))
    else if (Object.hasOwn(value, "class")) ids.push(key)
    else ids.push(...Object.keys(value).map((child) => `${key}.${child}`))
  }
  return ids
}

// The two checks the structural tests mutate.
function checkTable(feeds, fields) {
  for (const field of fields) if (!Object.hasOwn(feeds, field)) throw new Error(`published field ${field} has no row in the table`)
  for (const field of Object.keys(feeds)) if (!fields.includes(field)) throw new Error(`the table has a row for ${field}, which is not a published field`)
}
function checkIds(ids, formulaIds, notFed) {
  for (const id of ids) {
    const top = id.split(".")[0]
    if (!formulaIds.includes(id) && !Object.hasOwn(notFed, id) && !Object.hasOwn(notFed, top)) throw new Error(`formula ${id} has no id and is not marked as not fed`)
  }
}

// Cells: one per (field, effect, formula, host). The `totals.*` cells are walked against the rollup totals like every other.
const cells = []
for (const [field, entry] of Object.entries(FEEDS)) {
  for (const effect of ["unavailable", "partial"]) {
    for (const id of entry[effect]) {
      for (const host of ENUMS.host) cells.push({ field, effect, id, host })
    }
  }
}

test("the table has cells to walk, and the totals cells are among them", (t) => {
  assert.ok(cells.length > 100, `only ${cells.length} cells`)
  assert.ok(cells.some((cell) => cell.id.startsWith("totals.")), "the totals cells are walked")
  t.diagnostic(`cells walked: ${cells.length}`)
})

// A walk reports every failing cell at once, so one run lists every defect.
const walkProblems = () => {
  const problems = []
  return { problems, check: (ok, message) => { if (!ok) problems.push(message) } }
}

// Every cell is walked with sessions that carry only the flag under test, no host constants, so each cell fails when that one field is dropped from that one formula's coverage on every host. The host constants are checked by their own test below.
test("every cell: a flagged input never yields a bare measured", (t) => {
  const { problems, check } = walkProblems()
  let walked = 0
  for (const { field, effect, id, host } of cells) {
    for (const reason of ENUMS.unavailableReason) {
      const partly = reason === PARTLY
      const flag = [field, reason]
      const label = `${host} ${field}/${reason} -> ${id}`
      // Every covering session flagged.
      const all = resultOf(formulasOf([sessionOf(host, 0, [flag]), sessionOf(host, 1, [flag], 500)]), id)
      check(all !== undefined, `${label}: the formula produced no result`)
      if (all === undefined) continue
      const wantAll = effect === "unavailable" && !partly ? "unavailable" : "partial"
      check(all.state === wantAll, `${label}: all flagged, expected ${wantAll}, got ${all.state}`)
      if (wantAll === "partial") check(all.value !== null, `${label}: a partial number keeps its value`)
      // One of two covering sessions flagged.
      const one = resultOf(formulasOf([sessionOf(host, 0, [flag]), sessionOf(host, 1, [], 500)]), id)
      check(one.state === "partial", `${label}: one of two flagged, expected partial, got ${one.state}`)
      if (effect === "unavailable" && !PER_ENTRY_COUNT.includes(id)) check(one.uncovered_sessions === 1, `${label}: expected uncovered_sessions 1, got ${one.uncovered_sessions}`)
      check(one.value !== null, `${label}: a partial number keeps its value`)
      walked += 1
    }
  }
  t.diagnostic(`cell and reason combinations walked: ${walked}`)
  assert.equal(walked, cells.length * ENUMS.unavailableReason.length)
  assert.deepEqual(problems, [])
})

// The lost-clock shape: a session flagged `job_offsets` whose offsets are gone (offset null, no transitions). Its time exists and cannot be placed.
const untimed = (session) => {
  session.jobs = session.jobs.map((binding) => ({ ...binding, session_offset_ms: null, transitions: [], observed: { status: "done", offset_ms: null } }))
  return session
}

test("every job_offsets cell: a flagged session whose offsets were lost makes the clock numbers partial beside a timed one, and unavailable alone", () => {
  const { problems, check } = walkProblems()
  let walked = 0
  for (const { id, host } of cells.filter((cell) => cell.field === "job_offsets")) {
    for (const reason of ["host_does_not_record", "source_unreadable"]) {
      const flag = ["job_offsets", reason]
      const label = `${host} untimed job_offsets/${reason} -> ${id}`
      const beside = resultOf(formulasOf([untimed(sessionOf(host, 0, [flag])), sessionOf(host, 1, [], 500)]), id)
      check(beside.state === "partial", `${label}: a lost-clock session beside a timed one, expected partial, got ${beside.state}`)
      if (!PER_ENTRY_COUNT.includes(id)) check(beside.uncovered_sessions === 1, `${label}: expected uncovered_sessions 1, got ${beside.uncovered_sessions}`)
      check(beside.reasons.includes(reason), `${label}: the flag's reason is missing`)
      const alone = resultOf(formulasOf([untimed(sessionOf(host, 0, [flag]))]), id)
      check(alone.state === "unavailable", `${label}: every session lost its clock, expected unavailable, got ${alone.state}`)
      walked += 1
    }
  }
  assert.ok(walked > 0)
  assert.deepEqual(problems, [])
})

test("the composite references result is never measured while a part is not, with and without the host constants", () => {
  for (const host of ENUMS.host) {
    for (const part of COMPOSITES.references) {
      const field = fieldsFeeding(`references.${part}`, "unavailable")[0] ?? fieldsFeeding(`references.${part}`, "partial")[0]
      for (const constants of [[], hostPairs(host)]) {
        const formulas = formulasOf([sessionOf(host, 0, [...constants, [field, "host_does_not_record"]])])
        assert.notEqual(formulas.references.parts[part].state, "measured", `${host} ${part}`)
        assert.notEqual(formulas.references.state, "measured", `${host} ${part}`)
      }
    }
  }
})

test("a host_records_partly entry keeps the value and gives partial under every unavailable row", (t) => {
  const { problems, check } = walkProblems()
  let walked = 0
  for (const [field, entry] of Object.entries(FEEDS)) {
    for (const id of entry.unavailable) {
      for (const host of ENUMS.host) {
        const result = resultOf(formulasOf([sessionOf(host, 0, [[field, PARTLY]])]), id)
        const label = `${host} ${field} -> ${id}`
        check(result.state === "partial", `${label}: expected partial, got ${result.state}`)
        check(result.value !== null, `${label}: the value was dropped`)
        check(result.reasons.includes(PARTLY), `${label}: the reason is missing`)
        walked += 1
      }
    }
  }
  t.diagnostic(`partly cells walked: ${walked}`)
  assert.ok(walked > 0)
  assert.deepEqual(problems, [])
})

test("a session with no flag at all gives measured for every formula, so the builder can make every formula produce a value", () => {
  for (const host of ENUMS.host) {
    const formulas = formulasOf([sessionOf(host, 0, [])])
    for (const id of FORMULA_IDS) {
      const result = resultOf(formulas, id)
      assert.ok(result, `${host} ${id}: no result`)
      assert.equal(result.state, "measured", `${host} ${id}: the builder cannot make this formula produce a measured value (${JSON.stringify(result.reasons)})`)
      assert.notEqual(result.value, null, `${host} ${id}`)
    }
  }
})

test("each host's constant flags make every formula they feed not measured, in /2 and in /1 form", () => {
  for (const host of ENUMS.host) {
    assert.ok(Object.hasOwn(HOST_FLAGS, host), `${host} has no host table entry`)
    for (const form of ["2", "1"]) {
      // A /1 file carries no flags; the reader adds the host constants.
      const session = sessionOf(host, 0, form === "2" ? hostPairs(host) : [])
      if (form === "1") session.schema = "desk.factory.published/1"
      const formulas = formulasOf([session])
      for (const flag of hostFlagsFor(host, session.session)) {
        for (const effect of ["unavailable", "partial"]) {
          for (const id of FEEDS[flag.field][effect]) {
            const result = resultOf(formulas, id)
            assert.notEqual(result.state, "measured", `${host}/${form} ${flag.field}/${flag.reason} -> ${id}`)
            const missing = effect === "unavailable" && flag.reason !== PARTLY
            if (missing) assert.equal(result.state, "unavailable", `${host}/${form} ${flag.field}/${flag.reason} -> ${id}`)
          }
        }
      }
    }
  }
})

test("every key calculateFormulas returns is in FORMULA_IDS or NOT_FED", () => {
  const formulas = formulasOf([sessionOf("claude-code", 0, [])])
  assert.doesNotThrow(() => checkIds(outputIds(formulas), FORMULA_IDS, NOT_FED))
  for (const key of Object.keys(formulas)) {
    const known = Object.hasOwn(NOT_FED, key) || Object.hasOwn(COMPOSITES, key) || FORMULA_IDS.some((id) => id === key || id.startsWith(`${key}.`))
    assert.ok(known, `${key} is neither an id nor marked as not fed`)
  }
})

test("every id in FORMULA_IDS exists in the formula output or, for totals, the rollup output", (t) => {
  const ids = new Set([...outputIds(formulasOf([sessionOf("claude-code", 0, [])])), ...Object.keys(TOTAL_LEAVES)])
  const missing = FORMULA_IDS.filter((id) => !ids.has(id))
  assert.deepEqual(missing, [])
})

test("adding an enum field without a table row fails", () => {
  assert.doesNotThrow(() => checkTable(FEEDS, ENUMS.publishedUnavailableField))
  assert.throws(() => checkTable(FEEDS, [...ENUMS.publishedUnavailableField, "new_field"]), /new_field has no row/u)
  assert.throws(() => checkTable({ ...FEEDS, extra: {} }, ENUMS.publishedUnavailableField), /extra/u)
})

test("adding a formula key without an id fails", () => {
  const formulas = formulasOf([sessionOf("claude-code", 0, [])])
  assert.throws(() => checkIds([...outputIds(formulas), "brand_new_formula"], FORMULA_IDS, NOT_FED), /brand_new_formula/u)
  assert.throws(() => checkIds([...outputIds(formulas), "waits.new_wait_ms"], FORMULA_IDS, NOT_FED), /waits\.new_wait_ms/u)
})
