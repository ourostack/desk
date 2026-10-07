// The sign-off, first-pass yield and rework results are written the way the numbers package writes every per-job result: a partial result carries `partial: true` and `partial_reasons` equal to its reasons, and an unavailable result carries `value: null` beside `reason` and `reasons`. `withState` (number-states.js) derives `state` and `reasons` from those keys, so a result in any other shape would be overwritten when the job's formulas are decorated.

import "../../_isolated_env.mjs"
import { test } from "node:test"
import assert from "node:assert/strict"
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import { build } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/build.js"
import { calculateFormulas } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/formulas.js"
import { withState } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"
import { firstPassFormula, reworkFormula, signoffFormula } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/outcomes.js"
import { stated } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/number-states.js"
import { buildJobTimeline } from "../../../../../../plugins/desk/mcp/src/factory/pipeline/timeline.js"
import { serializePublished } from "../../../../../../plugins/desk/mcp/src/factory/publish.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const STORE = path.join(here, "..", "fixtures", "store")
const FIRST_FACTS = "claude-code-11111111-1111-4111-8111-111111111111.json"
const JOB = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

const RETURN = { reason: "agent_error", caught: "at_review", counts: true, refusal: null, refusal_verified: null }
const entry = (extra = {}) => ({ job: JOB, rev: 2, state: "delivered_unsigned", verified: null, reason: null, deliveries: 1, wait: null, since: "created", returns: [], ...extra })
const without = (record, key) => Object.fromEntries(Object.entries(record).filter(([name]) => name !== key))

// Every state each outcome formula can produce, with the entry that produces it: [label, formula name, entry or null, expected state, expected reasons].
const CASES = [
  ["no record", null, { signoff: ["unavailable", ["not_recorded"]], first_pass_yield: ["unavailable", ["not_recorded"]], rework: ["unavailable", ["not_recorded"]] }],
  ["delivered before sign-offs were recorded", entry({ state: "not_recorded" }), { signoff: ["unavailable", ["signoff_not_recorded"]], first_pass_yield: ["unavailable", ["not_recorded"]], rework: ["measured", []] }],
  ["adopted card with no history", { ...without(entry(), "returns"), since: "adopted" }, { signoff: ["measured", []], first_pass_yield: ["unavailable", ["history_not_recorded"]], rework: ["unavailable", ["history_not_recorded"]] }],
  ["not delivered", entry({ state: "not_delivered", deliveries: 0 }), { signoff: ["measured", []], first_pass_yield: ["unavailable", ["not_delivered"]], rework: ["measured", []] }],
  ["returns cut off", entry({ returns_truncated: true }), { signoff: ["measured", []], first_pass_yield: ["unavailable", ["returns_not_fully_recorded"]], rework: ["partial", ["returns_not_fully_recorded"]] }],
  ["accepted and verified", entry({ state: "accepted", verified: true }), { signoff: ["measured", []], first_pass_yield: ["measured", []], rework: ["measured", []] }],
  ["accepted, not verified", entry({ state: "accepted", verified: false }), { signoff: ["measured", []], first_pass_yield: ["measured", []], rework: ["measured", []] }],
  ["waiting for sign-off", entry(), { signoff: ["measured", []], first_pass_yield: ["partial", ["awaiting_signoff"]], rework: ["measured", []] }],
  ["refused with nothing counting", entry({ state: "refused", verified: true, reason: "defect" }), { signoff: ["measured", []], first_pass_yield: ["partial", ["awaiting_signoff"]], rework: ["measured", []] }],
  ["sent back after review", entry({ state: "accepted", verified: true, returns: [RETURN] }), { signoff: ["measured", []], first_pass_yield: ["measured", []], rework: ["measured", []] }],
]
const FORMULAS = { signoff: signoffFormula, first_pass_yield: firstPassFormula, rework: reworkFormula }

test("decorating an outcome result with withState leaves its state and reasons as the formula set them, for every state each formula can produce", () => {
  const seen = new Set()
  for (const [label, record, expected] of CASES) {
    for (const [name, formula] of Object.entries(FORMULAS)) {
      const result = formula(record)
      const [state, reasons] = expected[name]
      assert.equal(result.state, state, `${label}: ${name} state`)
      assert.deepEqual(result.reasons, reasons, `${label}: ${name} reasons`)
      const decorated = withState(result)
      assert.equal(decorated.state, result.state, `${label}: ${name} keeps its state through withState`)
      assert.deepEqual(decorated.reasons, result.reasons, `${label}: ${name} keeps its reasons through withState`)
      assert.deepEqual(decorated, result, `${label}: ${name} is unchanged by withState`)
      if (state === "partial") {
        assert.equal(result.partial, true, `${label}: ${name} is marked partial`)
        assert.deepEqual(result.partial_reasons, result.reasons, `${label}: ${name} partial_reasons equal its reasons`)
      }
      if (state === "unavailable") {
        assert.equal(result.value, null, `${label}: ${name} has value null`)
        assert.equal(result.class, "unavailable")
        assert.deepEqual(result.reasons, [result.reason], `${label}: ${name} reason and reasons agree`)
      } else {
        assert.equal(result.class, "declared")
        assert.notEqual(result.value, undefined)
      }
      seen.add(`${name}/${state}`)
    }
  }
  // Each formula is shown in every state it can have.
  for (const key of ["signoff/measured", "signoff/unavailable", "first_pass_yield/measured", "first_pass_yield/partial", "first_pass_yield/unavailable", "rework/measured", "rework/partial", "rework/unavailable"]) assert.ok(seen.has(key), key)
  assert.equal(seen.has("signoff/partial"), false)
})

test("the formulas a job's report returns carry the same state and reasons through the decoration", () => {
  const facts = JSON.parse(readFileSync(path.join(STORE, "facts", FIRST_FACTS), "utf8"))
  for (const [label, record, expected] of CASES) {
    const sessions = [{ ...facts, ...(record === null ? {} : { outcomes: [record] }) }]
    const formulas = calculateFormulas(buildJobTimeline(JOB, sessions))
    for (const [name, [state, reasons]] of Object.entries(expected)) {
      assert.equal(formulas[name].state, state, `${label}: ${name}`)
      assert.deepEqual(formulas[name].reasons, reasons, `${label}: ${name}`)
    }
  }
})

test("the built jobs/<job>.json carries the state and reasons of each outcome result", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "desk-factory-outcome-states-"))
  try {
    for (const [index, [label, record, expected]] of CASES.entries()) {
      if (record === null) continue
      const store = path.join(root, `store-${index}`)
      cpSync(STORE, store, { recursive: true })
      const factPath = path.join(store, "facts", FIRST_FACTS)
      const fact = JSON.parse(readFileSync(factPath, "utf8"))
      fact.outcomes = [record]
      writeFileSync(factPath, serializePublished(fact))
      const out = path.join(root, `out-${index}`)
      build({ storeDir: store, outDir: out })
      const { formulas } = JSON.parse(readFileSync(path.join(out, "jobs", `${JOB}.json`), "utf8"))
      for (const [name, [state, reasons]] of Object.entries(expected)) {
        assert.equal(formulas[name].state, state, `${label}: ${name} state in the built file`)
        assert.deepEqual(formulas[name].reasons, reasons, `${label}: ${name} reasons in the built file`)
        if (state === "unavailable") assert.equal(formulas[name].value, null, `${label}: ${name} has value null in the built file`)
        if (state === "partial") assert.deepEqual(formulas[name].partial_reasons, reasons, `${label}: ${name} partial_reasons in the built file`)
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("an outcome result whose state or reasons disagree with what withState derives stops the build", () => {
  assert.throws(() => stated({ class: "declared", state: "measured", value: 1, reasons: [], partial: true, partial_reasons: ["awaiting_signoff"] }), /disagrees with its derived state/u)
  assert.throws(() => stated({ class: "declared", state: "partial", value: 1, reasons: ["awaiting_signoff"] }), /disagrees with its derived state/u)
  assert.throws(() => stated({ class: "unavailable", state: "unavailable", value: null, reasons: ["b", "a"], reason: "a" }), /disagrees with its derived state/u)
  assert.deepEqual(stated({ class: "declared", state: "measured", value: 1, reasons: [] }).reasons, [])
})
