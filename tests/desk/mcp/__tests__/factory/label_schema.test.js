// Published labels v1 (`desk.factory.labels/1`): the waste labels an
// independent evaluator writes for one job's session, and the gate the
// stores' CI runs on them.
//
// As in `published_schema.test.js`, every violating case plants a sentinel
// where the violation is string-shaped (or as an unknown key's own name) and
// asserts it never appears in the serialized errors: errors are
// `{ code, path }` only.

import { test } from "node:test"
import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"

import {
  LABELS_SCHEMA,
  LABELS_SCHEMAS,
  LABEL_CONFIDENCE,
  UNKNOWN_LABEL,
  compareVersions,
  LABEL_CLASSES,
  LABEL_LIMITS,
  LABEL_UNAVAILABLE,
  LABEL_WASTES,
  __LABEL_SPECS__,
  checkLabelsAgainstFacts,
  evaluatorDowngrade,
  validateLabels,
  validateLabelsBytes,
} from "../../../../../plugins/desk/mcp/src/factory/label-schema.js"
import { PUBLISHED_LIMITS, validatePublished } from "../../../../../plugins/desk/mcp/src/factory/published-schema.js"

const here = path.dirname(fileURLToPath(import.meta.url))
const GOLDEN_BYTES = readFileSync(path.join(here, "fixtures", "labels-golden.json"))
const GOLDEN = JSON.parse(GOLDEN_BYTES.toString("utf8"))
const FACTS = JSON.parse(readFileSync(path.join(here, "fixtures", "published-golden.json"), "utf8"))
const SENTINEL = "ghp_SENTINEL0123456789abcdefghijklmnopqrstuv"

// The brief's example, verbatim. Its evidence ranges are illustrative and
// match no fixture, so it is checked on its own, not against facts.
const BRIEF_EXAMPLE = {
  schema: "desk.factory.labels/1",
  job: "9f2c4b1a7d3e5f60718293a4b5c6d7e8",
  session: "3b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60",
  evaluator: { plugin_version: "3.2.0-alpha.40", model: "claude-opus-5-5", rubric: "1" },
  stretches: [
    { start_ms: 5000, end_ms: 64000, class: "muda", waste: "defects", mura: false, muri: false, evidence: [[5000, 9000], [9500, 30000]] },
    { start_ms: 64000, end_ms: 250000, class: "value", waste: null, mura: false, muri: false, evidence: [[64000, 250000]] },
  ],
  unavailable: [],
}

function golden() {
  return structuredClone(GOLDEN)
}

function facts() {
  return structuredClone(FACTS)
}

function noEcho(result) {
  assert.equal(JSON.stringify(result).includes(SENTINEL), false)
  assert.equal(JSON.stringify(result).includes("ghp_"), false)
}

function expectErrors(value, expected) {
  const result = validateLabels(value)
  assert.deepEqual(result, { ok: false, errors: expected })
  noEcho(result)
}

test("the constants carry the brief's exact values", () => {
  assert.equal(LABELS_SCHEMA, "desk.factory.labels/2")
  assert.deepEqual(LABELS_SCHEMAS, ["desk.factory.labels/1", LABELS_SCHEMA])
  assert.deepEqual(LABEL_CONFIDENCE, ["high", "medium", "low"])
  assert.equal(UNKNOWN_LABEL, "unknown")
  assert.ok(Object.isFrozen(LABELS_SCHEMAS) && Object.isFrozen(LABEL_CONFIDENCE))
  assert.deepEqual(LABEL_CLASSES, ["value", "support", "muda"])
  assert.deepEqual(LABEL_WASTES, ["defects", "overproduction", "waiting", "non_utilized_talent", "transportation", "inventory", "motion", "extra_processing"])
  assert.deepEqual(LABEL_UNAVAILABLE, ["session_log_missing", "facts_missing"])
  for (const frozen of [LABEL_CLASSES, LABEL_WASTES, LABEL_UNAVAILABLE, LABEL_LIMITS]) assert.ok(Object.isFrozen(frozen))
})

test("every allowed key in every level carries a real check", () => {
  for (const [levelName, spec] of Object.entries(__LABEL_SPECS__)) {
    for (const [fieldName, field] of Object.entries(spec)) {
      assert.equal(typeof field.check, "function", `${levelName}.${fieldName}`)
    }
  }
})

test("the golden labels and the brief's example pass on their own", () => {
  assert.deepEqual(validateLabels(golden()), { ok: true, errors: [] })
  assert.deepEqual(validateLabelsBytes(GOLDEN_BYTES), { ok: true, errors: [] })
  assert.deepEqual(validateLabelsBytes(GOLDEN_BYTES.toString("utf8")), { ok: true, errors: [] })
  assert.deepEqual(validateLabels(structuredClone(BRIEF_EXAMPLE)), { ok: true, errors: [] })
})

test("every Desk-shaped plugin version and every rubric from 1 to 999 passes", () => {
  for (const version of ["3.2.0", "0.0.1", "999.999.999", "3.2.0-alpha.58", "3.2.0-beta.7", "3.2.0-rc.1", "3.2.0-alpha.9999"]) {
    const value = golden()
    value.evaluator.plugin_version = version
    for (const stretch of value.stretches) stretch.evaluator_version = version
    assert.deepEqual(validateLabels(value), { ok: true, errors: [] }, version)
  }
  for (const rubric of ["1", "2", "3", "9", "10", "999"]) {
    const value = golden()
    value.evaluator.rubric = rubric
    assert.deepEqual(validateLabels(value), { ok: true, errors: [] }, rubric)
  }
})

// Credential-shaped values with no spaces, each built around a sentinel so
// the no-echo assertion is exact. The hex run carries no letters to plant,
// so its own value is asserted absent.
const HEX_RUN = "0123456789abcdef0123456789abcdef"
const CREDENTIAL_MODELS = [
  "ghp_SENTINEL0123456789abcdefghijklmnopqrstuv",
  "github_pat_SENTINEL0123456789_abcdefghijklmnopqrstuvwxyz",
  "gho_SENTINEL0123456789abcdefghijklmnopqrstuv",
  "sk-ant-SENTINEL-api03-abcdefghijklmnop",
  HEX_RUN,
  `model-${HEX_RUN}`,
]

test("credential-shaped model IDs with no spaces are refused as credential_like and never echoed", () => {
  for (const model of CREDENTIAL_MODELS) {
    const value = golden()
    value.evaluator.model = model
    const result = validateLabels(value)
    assert.deepEqual(result, { ok: false, errors: [{ code: "credential_like", path: "evaluator.model" }] }, model)
    const serialized = JSON.stringify(result)
    for (const fragment of ["SENTINEL", "ghp_", "github_pat_", "gho_", "sk-ant", HEX_RUN]) assert.equal(serialized.includes(fragment), false, model)
  }
})

test("labels and published facts judge every model ID with the same validator", () => {
  const cases = [
    "claude-opus-5-5",
    "claude-3-5-sonnet-20241022",
    "us.anthropic.claude-3-7-sonnet-20250219-v1:0",
    "gpt-5.1-codex",
    "m".repeat(80),
    "m".repeat(81),
    "claude opus",
    "-leading-dash",
    "model-2026-09-25",
    "model:08:30",
    ...CREDENTIAL_MODELS,
  ]
  for (const model of cases) {
    const labels = golden()
    labels.evaluator.model = model
    const facts = structuredClone(FACTS)
    facts.models[0].id = model
    const fromLabels = validateLabels(labels).errors.map((item) => item.code)
    const fromFacts = validatePublished(facts).errors.map((item) => item.code)
    assert.deepEqual(fromLabels, fromFacts, model)
  }
  for (const model of ["claude-opus-5-5", "claude-3-5-sonnet-20241022", "us.anthropic.claude-3-7-sonnet-20250219-v1:0", "m".repeat(80)]) {
    const labels = golden()
    labels.evaluator.model = model
    assert.deepEqual(validateLabels(labels), { ok: true, errors: [] }, model)
  }
})

test("evaluatorDowngrade compares plugin versions, prerelease stages and rubrics", () => {
  const with_ = (plugin_version, rubric = "1") => ({ evaluator: { plugin_version, model: "claude-opus-5-5", rubric } })
  const ordered = ["3.1.9", "3.2.0-alpha.9", "3.2.0-alpha.58", "3.2.0-beta.1", "3.2.0-rc.1", "3.2.0", "3.2.1-alpha.1", "3.10.0", "10.0.0"]
  for (let index = 1; index < ordered.length; index += 1) {
    assert.equal(evaluatorDowngrade(with_(ordered[index]), with_(ordered[index - 1])), true, `${ordered[index - 1]} < ${ordered[index]}`)
    assert.equal(evaluatorDowngrade(with_(ordered[index - 1]), with_(ordered[index])), false, `${ordered[index - 1]} < ${ordered[index]}`)
  }
  assert.equal(evaluatorDowngrade(with_("3.2.0-alpha.58"), with_("3.2.0-alpha.58")), false)
  assert.equal(evaluatorDowngrade(with_("3.2.0", "2"), with_("3.2.0", "1")), true)
  assert.equal(evaluatorDowngrade(with_("3.2.0", "2"), with_("3.2.0", "10")), false)
  assert.equal(evaluatorDowngrade(with_("3.2.0", "2"), with_("3.2.1", "1")), true)
})

test("labels with no stretches and every unavailable code pass", () => {
  const value = golden()
  value.stretches = []
  value.unavailable = ["session_log_missing", "facts_missing"]
  assert.deepEqual(validateLabels(value), { ok: true, errors: [] })
})

test("every class, waste and flag combination the rules allow passes", () => {
  for (const waste of LABEL_WASTES) {
    const value = golden()
    value.stretches = [{ ...value.stretches[0], waste, mura: true, muri: true }]
    assert.deepEqual(validateLabels(value), { ok: true, errors: [] }, waste)
  }
  for (const cls of ["value", "support"]) {
    const value = golden()
    value.stretches = [{ ...value.stretches[0], class: cls, waste: null }]
    assert.deepEqual(validateLabels(value), { ok: true, errors: [] }, cls)
  }
})

test("bytes must be canonical JSON under the size cap", () => {
  const nonCanonical = Buffer.from(JSON.stringify(GOLDEN, null, 2))
  assert.deepEqual(validateLabelsBytes(nonCanonical), { ok: false, errors: [{ code: "canonical", path: "" }] })
  const json = validateLabelsBytes(Buffer.from(`{"${SENTINEL}":`))
  assert.deepEqual(json, { ok: false, errors: [{ code: "json", path: "" }] })
  noEcho(json)
  const duplicateKey = validateLabelsBytes(Buffer.from(GOLDEN_BYTES.toString("utf8").replace('{"schema"', `{"job":"${SENTINEL}","schema"`)))
  assert.deepEqual(duplicateKey, { ok: false, errors: [{ code: "canonical", path: "" }] })
  noEcho(duplicateKey)
})

test("the top level is an exact key set", () => {
  expectErrors(null, [{ code: "type", path: "" }])
  expectErrors([SENTINEL], [{ code: "type", path: "" }])
  const extra = golden()
  extra[SENTINEL] = SENTINEL
  expectErrors(extra, [{ code: "unknown_key", path: "" }])
  const note = golden()
  note.notes = SENTINEL
  expectErrors(note, [{ code: "unknown_key", path: "" }])
  for (const key of ["schema", "job", "session", "evaluator", "stretches", "unavailable"]) {
    const value = golden()
    delete value[key]
    expectErrors(value, [{ code: "missing", path: key }])
  }
})

const FIELD_CASES = [
  { keys: ["schema"], value: `desk.factory.labels/2 ${SENTINEL}`, code: "pattern" },
  { keys: ["schema"], value: "desk.factory.published/1", code: "pattern" },
  { keys: ["job"], value: SENTINEL, code: "pattern" },
  { keys: ["job"], value: "9F2C4B1A7D3E5F60718293A4B5C6D7E8", code: "pattern" },
  { keys: ["session"], value: SENTINEL, code: "pattern" },
  { keys: ["session"], value: "c232ab00-9414-11ec-b3c8-9f6bdeced846", code: "pattern" },
  { keys: ["session"], value: 42, code: "type" },
  { keys: ["evaluator"], value: SENTINEL, code: "type" },
  { keys: ["evaluator", "plugin_version"], value: SENTINEL, code: "pattern" },
  { keys: ["evaluator", "plugin_version"], value: "3.2", code: "pattern" },
  { keys: ["evaluator", "plugin_version"], value: "3.2.0-ari.macbook", code: "pattern" },
  { keys: ["evaluator", "plugin_version"], value: "3.2.0-20260927.0830", code: "pattern" },
  { keys: ["evaluator", "plugin_version"], value: "3.2.0-alpha", code: "pattern" },
  { keys: ["evaluator", "plugin_version"], value: "3.2.0-alpha.12345", code: "pattern" },
  { keys: ["evaluator", "plugin_version"], value: "1000.0.0", code: "pattern" },
  { keys: ["evaluator", "plugin_version"], value: `3.2.0-${SENTINEL}`, code: "pattern" },
  { keys: ["evaluator", "model"], value: SENTINEL.replace("_", " "), code: "pattern" },
  { keys: ["evaluator", "model"], value: "claude opus", code: "pattern" },
  { keys: ["evaluator", "model"], value: "m".repeat(81), code: "pattern" },
  { keys: ["evaluator", "model"], value: SENTINEL, code: "credential_like" },
  { keys: ["evaluator", "model"], value: "-leading-dash", code: "pattern" },
  { keys: ["evaluator", "model"], value: "model-2026-09-25", code: "date" },
  { keys: ["evaluator", "model"], value: "model:08:30", code: "time" },
  { keys: ["evaluator", "model"], value: 7, code: "type" },
  { keys: ["evaluator", "rubric"], value: SENTINEL, code: "pattern" },
  { keys: ["evaluator", "rubric"], value: 1, code: "type" },
  { keys: ["evaluator", "rubric"], value: "", code: "pattern" },
  { keys: ["evaluator", "rubric"], value: "01", code: "pattern" },
  { keys: ["evaluator", "rubric"], value: "1.0", code: "pattern" },
  { keys: ["evaluator", "rubric"], value: "1".repeat(10), code: "pattern" },
  { keys: ["evaluator", "rubric"], value: "0", code: "pattern" },
  { keys: ["evaluator", "rubric"], value: "1000", code: "pattern" },
  { keys: ["evaluator", "rubric"], value: "20260927", code: "pattern" },
  { keys: ["evaluator", "rubric"], value: "999999999", code: "pattern" },
  { keys: ["stretches"], value: SENTINEL, code: "type" },
  { keys: ["stretches", 0], value: SENTINEL, code: "type" },
  { keys: ["stretches", 0, "start_ms"], value: SENTINEL, code: "integer" },
  { keys: ["stretches", 0, "start_ms"], value: -1, code: "integer" },
  { keys: ["stretches", 0, "start_ms"], value: 1.5, code: "integer" },
  { keys: ["stretches", 0, "end_ms"], value: PUBLISHED_LIMITS.maxOffsetMs + 1, code: "range" },
  { keys: ["stretches", 0, "class"], value: SENTINEL, code: "enum" },
  { keys: ["stretches", 0, "class"], value: null, code: "type" },
  { keys: ["stretches", 0, "waste"], value: SENTINEL, code: "enum" },
  { keys: ["stretches", 0, "waste"], value: "mura", code: "enum" },
  { keys: ["stretches", 0, "caught"], value: SENTINEL, code: "enum" },
  { keys: ["stretches", 0, "caught"], value: null, code: "type" },
  { keys: ["stretches", 0, "caught"], value: "pending", code: "enum" },
  { keys: ["stretches", 0, "mura"], value: SENTINEL, code: "type" },
  { keys: ["stretches", 0, "muri"], value: 0, code: "type" },
  { keys: ["stretches", 0, "evidence"], value: SENTINEL, code: "type" },
  { keys: ["stretches", 0, "evidence", 0], value: SENTINEL, code: "type" },
  { keys: ["stretches", 0, "evidence", 0], value: { start_ms: 5000, end_ms: 9000 }, code: "type" },
  { keys: ["stretches", 0, "evidence", 0], value: [5000], code: "type" },
  { keys: ["stretches", 0, "evidence", 0], value: [5000, 9000, SENTINEL], code: "type" },
  { keys: ["stretches", 0, "evidence", 0], value: [SENTINEL, 9000], code: "integer" },
  { keys: ["stretches", 0, "evidence", 0], value: [5000, -9000], code: "integer" },
  { keys: ["stretches", 0, "evidence", 0], value: [5000, PUBLISHED_LIMITS.maxOffsetMs + 1], code: "range" },
  { keys: ["stretches", 0, "evidence", 0], value: [9000, 5000], code: "order" },
  { keys: ["unavailable"], value: SENTINEL, code: "type" },
  { keys: ["unavailable"], value: [SENTINEL], code: "enum", at: ["unavailable", 0] },
  { keys: ["unavailable"], value: [{ code: "facts_missing" }], code: "type", at: ["unavailable", 0] },
]

for (const { keys, value, code, at } of FIELD_CASES) {
  test(`${keys.join(".")} = ${JSON.stringify(value).replace(SENTINEL, "<sentinel>").slice(0, 40)} fails as ${code}`, () => {
    const labels = golden()
    let cursor = labels
    for (const key of keys.slice(0, -1)) cursor = cursor[key]
    cursor[keys.at(-1)] = value
    expectErrors(labels, [{ code, path: (at ?? keys).join(".") }])
  })
}

test("unknown keys inside the evaluator and a stretch are refused without echoing their names", () => {
  const evaluator = golden()
  evaluator.evaluator[SENTINEL] = 1
  expectErrors(evaluator, [{ code: "unknown_key", path: "evaluator" }])
  const stretch = golden()
  stretch.stretches[1].note = SENTINEL
  expectErrors(stretch, [{ code: "unknown_key", path: "stretches.1" }])
  const missing = golden()
  delete missing.stretches[0].evidence
  expectErrors(missing, [{ code: "missing", path: "stretches.0.evidence" }])
})

test("waste is required for muda and null otherwise", () => {
  const mudaNull = golden()
  mudaNull.stretches[0].waste = null
  expectErrors(mudaNull, [{ code: "inconsistent", path: "stretches.0.waste" }])
  for (const cls of ["value", "support"]) {
    const value = golden()
    value.stretches[1].class = cls
    value.stretches[1].waste = "defects"
    expectErrors(value, [{ code: "inconsistent", path: "stretches.1.waste" }])
  }
  // A bad class or waste is its own error, never also `inconsistent`.
  const badClass = golden()
  badClass.stretches[0].class = SENTINEL
  expectErrors(badClass, [{ code: "enum", path: "stretches.0.class" }])
})

test("a stretch must end after it starts", () => {
  for (const end_ms of [5000, 4999]) {
    const value = golden()
    value.stretches[0].end_ms = end_ms
    expectErrors(value, [{ code: "order", path: "stretches.0.end_ms" }])
  }
})

test("a stretch needs at least one evidence range and never names one twice", () => {
  const empty = golden()
  empty.stretches[0].evidence = []
  expectErrors(empty, [{ code: "empty", path: "stretches.0.evidence" }])
  const twice = golden()
  twice.stretches[3].evidence.push([605000, 1200000])
  expectErrors(twice, [{ code: "duplicate", path: "stretches.3.evidence.2" }])
  const cap = golden()
  cap.stretches[0].evidence = Array.from({ length: LABEL_LIMITS.evidence + 1 }, (_, index) => [index, index])
  expectErrors(cap, [{ code: "too_many", path: "stretches.0.evidence" }])
  const atCap = golden()
  atCap.stretches[0].evidence = Array.from({ length: LABEL_LIMITS.evidence }, (_, index) => [index, index])
  assert.deepEqual(validateLabels(atCap), { ok: true, errors: [] })
})

test("stretches are in start order and never overlap", () => {
  const overlap = golden()
  overlap.stretches[1].start_ms = 63999
  expectErrors(overlap, [{ code: "overlap", path: "stretches.1" }])
  const nested = golden()
  nested.stretches[2].start_ms = 100000
  nested.stretches[2].end_ms = 200000
  expectErrors(nested, [{ code: "overlap", path: "stretches.2" }])
  const same = golden()
  same.stretches[1] = { ...same.stretches[0] }
  expectErrors(same, [{ code: "overlap", path: "stretches.1" }])
  const unordered = golden()
  unordered.stretches.reverse()
  expectErrors(unordered, [
    { code: "order", path: "stretches.1" },
    { code: "order", path: "stretches.2" },
    { code: "order", path: "stretches.3" },
  ])
  // Touching ends are not an overlap, and gaps between stretches are allowed.
  const gap = golden()
  gap.stretches[1].start_ms = 70000
  assert.deepEqual(validateLabels(gap), { ok: true, errors: [] })
  // An unsound stretch is skipped, so its neighbours compare to the last sound one.
  const unsound = golden()
  unsound.stretches[1].start_ms = SENTINEL
  unsound.stretches[2].start_ms = 60000
  expectErrors(unsound, [{ code: "integer", path: "stretches.1.start_ms" }, { code: "overlap", path: "stretches.2" }])
})

test("the stretch list is capped", () => {
  const stretch = (index) => ({ start_ms: index * 2, end_ms: index * 2 + 1, class: "value", waste: null, mura: false, muri: false, evidence: [[0, 0]], confidence: "high", evaluator_version: "3.2.0-alpha.40" })
  const over = golden()
  over.stretches = Array.from({ length: LABEL_LIMITS.stretches + 1 }, (_, index) => stretch(index))
  expectErrors(over, [{ code: "too_many", path: "stretches" }])
  const at = golden()
  at.stretches = Array.from({ length: LABEL_LIMITS.stretches }, (_, index) => stretch(index))
  assert.deepEqual(validateLabels(at), { ok: true, errors: [] })
})

test("unavailable is a closed set with no code twice, and facts_missing means no stretches", () => {
  const twice = golden()
  twice.unavailable = ["session_log_missing", "session_log_missing"]
  expectErrors(twice, [{ code: "duplicate", path: "unavailable.1" }])
  const over = golden()
  over.unavailable = ["session_log_missing", "facts_missing", "session_log_missing"]
  expectErrors(over, [{ code: "too_many", path: "unavailable" }])
  const noFacts = golden()
  noFacts.unavailable = ["facts_missing"]
  expectErrors(noFacts, [{ code: "inconsistent", path: "stretches" }])
  const noLog = golden()
  noLog.unavailable = ["session_log_missing"]
  assert.deepEqual(validateLabels(noLog), { ok: true, errors: [] })
})

test("free text planted anywhere is refused and never echoed", () => {
  const cases = [
    ["job"], ["session"], ["evaluator", "plugin_version"], ["evaluator", "model"], ["evaluator", "rubric"],
    ["stretches", 0, "class"], ["stretches", 0, "waste"], ["unavailable", 0],
  ]
  for (const keys of cases) {
    const value = golden()
    if (keys[0] === "unavailable") value.unavailable = ["session_log_missing"]
    let cursor = value
    for (const key of keys.slice(0, -1)) cursor = cursor[key]
    cursor[keys.at(-1)] = `${SENTINEL} free text`
    const result = validateLabels(value)
    assert.equal(result.ok, false, keys.join("."))
    noEcho(result)
    const bytes = validateLabelsBytes(Buffer.from(`${JSON.stringify(value)}\n`))
    assert.equal(bytes.ok, false)
    noEcho(bytes)
  }
})

// ---------------------------------------------------------------------------
// checkLabelsAgainstFacts: the store-side check against the session's facts.
// ---------------------------------------------------------------------------

test("the golden labels match the golden facts", () => {
  assert.deepEqual(checkLabelsAgainstFacts(golden(), facts()), { ok: true, errors: [] })
})

test("every evidence range must equal one interval's start and end exactly", () => {
  for (const range of [[5000, 9001], [4999, 9000], [5500, 8000], [1000, 250001], [9500, 30000]]) {
    const value = golden()
    value.stretches[0].evidence = [range]
    assert.deepEqual(checkLabelsAgainstFacts(value, facts()), { ok: false, errors: [{ code: "evidence_unmatched", path: "stretches.0.evidence.0" }] }, JSON.stringify(range))
  }
  const second = golden()
  second.stretches[3].evidence[1] = [9000, 5000]
  assert.deepEqual(checkLabelsAgainstFacts(second, facts()), { ok: false, errors: [{ code: "evidence_unmatched", path: "stretches.3.evidence.1" }] })
})

test("evidence stays valid when the session grows and gains intervals", () => {
  const grown = facts()
  grown.session.duration_ms += 60000
  grown.intervals.unshift({ kind: "turn", agent: 0, start_ms: 0, end_ms: 500 })
  grown.intervals.push({ kind: "turn", agent: 0, start_ms: 1200000, end_ms: 1300000 })
  assert.deepEqual(checkLabelsAgainstFacts(golden(), grown), { ok: true, errors: [] })
})

test("stretches must lie within the session", () => {
  const value = golden()
  value.stretches[3].end_ms = FACTS.session.duration_ms + 1
  assert.deepEqual(checkLabelsAgainstFacts(value, facts()), { ok: false, errors: [{ code: "range", path: "stretches.3.end_ms" }] })
  const edge = golden()
  edge.stretches[3].end_ms = FACTS.session.duration_ms
  assert.deepEqual(checkLabelsAgainstFacts(edge, facts()), { ok: true, errors: [] })
})

test("the labels must name the facts' session and a job the facts bind", () => {
  const otherSession = facts()
  otherSession.session.id = "22222222-2222-4222-8222-222222222222"
  assert.deepEqual(checkLabelsAgainstFacts(golden(), otherSession), { ok: false, errors: [{ code: "session_mismatch", path: "session" }] })
  const unbound = golden()
  unbound.job = "0".repeat(32)
  assert.deepEqual(checkLabelsAgainstFacts(unbound, facts()), { ok: false, errors: [{ code: "job_unbound", path: "job" }] })
})

test("labels without caught stay valid and labels with a known value are valid", () => {
  const plain = golden()
  for (const stretch of plain.stretches) delete stretch.caught
  assert.deepEqual(validateLabels(plain), { ok: true, errors: [] })
  for (const caught of ["in_task", "at_review", "after_delivery"]) {
    const value = plain
    value.stretches[0].caught = caught
    assert.deepEqual(validateLabels(value), { ok: true, errors: [] })
  }
  assert.ok(Object.hasOwn(golden().stretches[0], "caught"), "the golden labels carry one placed stretch")
  assert.equal(LABELS_SCHEMA, "desk.factory.labels/2")
  assert.equal(__LABEL_SPECS__.stretch.caught.check instanceof Function, true)
  assert.equal(__LABEL_SPECS__.stretchV2.caught.check instanceof Function, true)
})

// ---------------------------------------------------------------------------
// Labels /2: confidence, the label's own version and "could not tell".
// ---------------------------------------------------------------------------

// The golden labels as a `/1` file: no confidence, no version, rubric 1.
function legacy() {
  const value = golden()
  value.schema = "desk.factory.labels/1"
  value.evaluator.rubric = "1"
  for (const stretch of value.stretches) {
    delete stretch.confidence
    delete stretch.evaluator_version
  }
  return value
}

test("a /1 file stays valid as it is, and a /2 key or the unknown label in one is refused", () => {
  assert.deepEqual(validateLabels(legacy()), { ok: true, errors: [] })
  const keyed = legacy()
  keyed.stretches[0].confidence = "high"
  expectErrors(keyed, [{ code: "unknown_key", path: "stretches.0" }])
  const unknown = legacy()
  unknown.stretches[1].class = "unknown"
  unknown.stretches[1].waste = "unknown"
  expectErrors(unknown, [{ code: "enum", path: "stretches.1.class" }, { code: "enum", path: "stretches.1.waste" }])
})

test("every /2 stretch carries a confidence and the version that assigned it", () => {
  for (const level of ["high", "medium", "low"]) {
    const value = golden()
    value.stretches[0].confidence = level
    assert.deepEqual(validateLabels(value), { ok: true, errors: [] }, level)
  }
  for (const key of ["confidence", "evaluator_version"]) {
    const value = golden()
    delete value.stretches[1][key]
    expectErrors(value, [{ code: "missing", path: `stretches.1.${key}` }])
  }
  const sure = golden()
  sure.stretches[0].confidence = SENTINEL
  expectErrors(sure, [{ code: "enum", path: "stretches.0.confidence" }])
  const shaped = golden()
  shaped.stretches[0].evaluator_version = `3.2.0-${SENTINEL}`
  expectErrors(shaped, [{ code: "pattern", path: "stretches.0.evaluator_version" }])
})

test("a label's version may be older than the file's evaluator, never newer", () => {
  const older = golden()
  older.stretches[0].evaluator_version = "3.1.9"
  older.stretches[1].evaluator_version = "3.2.0-alpha.39"
  assert.deepEqual(validateLabels(older), { ok: true, errors: [] })
  const newer = golden()
  newer.stretches[2].evaluator_version = "3.2.0-alpha.41"
  newer.stretches[3].evaluator_version = "3.2.0"
  expectErrors(newer, [{ code: "inconsistent", path: "stretches.2.evaluator_version" }, { code: "inconsistent", path: "stretches.3.evaluator_version" }])
  // A file version that fails its own check is named once, by that check.
  const unsound = golden()
  unsound.evaluator.plugin_version = SENTINEL
  unsound.stretches[0].evaluator_version = "9.9.9"
  expectErrors(unsound, [{ code: "pattern", path: "evaluator.plugin_version" }])
})

test("unknown is its own label: class and waste unknown together, never beside another class or waste", () => {
  const value = golden()
  value.stretches[1] = { ...value.stretches[1], class: "unknown", waste: "unknown" }
  assert.deepEqual(validateLabels(value), { ok: true, errors: [] })
  for (const [klass, waste] of [["unknown", null], ["unknown", "waiting"], ["muda", "unknown"], ["value", "unknown"]]) {
    const bad = golden()
    bad.stretches[1] = { ...bad.stretches[1], class: klass, waste }
    expectErrors(bad, [{ code: "inconsistent", path: "stretches.1.waste" }])
  }
})

test("compareVersions orders evaluator versions as releases", () => {
  assert.ok(compareVersions("3.2.0-alpha.9", "3.2.0-alpha.10") < 0)
  assert.ok(compareVersions("3.2.0-rc.1", "3.2.0") < 0)
  assert.equal(compareVersions("3.2.0", "3.2.0"), 0)
  assert.ok(compareVersions("4.0.0", "3.9.9") > 0)
})
