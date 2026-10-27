import { test } from "node:test"
import assert from "node:assert/strict"
import { validateContext, validateContextBytes, checkContextAgainstFacts } from "../../../../../plugins/desk/mcp/src/factory/context-schema.js"
import { validatePr } from "../../../../../plugins/desk/mcp/src/factory/pipeline/validate-pr.js"
import { contextFacts, contextRecord, reviewContext } from "./_context_fixture.js"

function recommendation() {
  return {
    id: "fedcba9876543210",
    observations: ["0123456789abcdef"],
    problem: "The connection check did not establish the requested behavior.",
    change: "Check the requested behavior through the actual device connection.",
    hypothesis: "A direct behavior check may catch mismatches before handover.",
    check: "Compare the observed behavior with the requested result after the change.",
    confidence: "medium",
  }
}

function record() {
  return reviewContext({
    ...contextRecord(),
    schema: "desk.factory.context/2",
    recommendations: [recommendation()],
  })
}

function refuses(value, code, path) {
  const result = validateContext(value)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((entry) => entry.code === code && entry.path.startsWith(path)), JSON.stringify(result))
  assert.equal(JSON.stringify(result).includes("SENTINEL"), false)
}

test("reviewed recommendations retain the existing actual-facts and privacy gates", () => {
  const value = record()
  assert.deepEqual(validateContext(value), { ok: true, errors: [] })
  assert.deepEqual(validateContextBytes(`${JSON.stringify(value)}\n`), { ok: true, errors: [] })
  assert.deepEqual(checkContextAgainstFacts(value, [contextFacts()]), { ok: true, errors: [] })
  value.privacy = null
  assert.equal(validateContext(value, { candidate: true }).ok, true)
  refuses(value, "review_missing", "privacy")
})

test("context one remains unchanged and cannot carry unversioned recommendation fields", () => {
  const legacy = contextRecord()
  assert.deepEqual(validateContext(legacy), { ok: true, errors: [] })
  legacy.recommendations = []
  refuses(reviewContext(legacy), "unknown_key", "")
})

test("new context distinguishes no reviewed recommendation from an absent old field", () => {
  const value = record()
  value.recommendations = []
  assert.equal(validateContext(reviewContext(value)).ok, true)
  delete value.recommendations
  refuses(reviewContext(value), "missing", "recommendations")
})

test("recommendations must name distinct existing observation events", () => {
  assert.equal(validateContext(record()).ok, true)
  for (const [observations, code] of [
    [[], "inconsistent"],
    [["1111111111111111"], "evidence_unmatched"],
    [["0123456789abcdef", "0123456789abcdef"], "duplicate"],
  ]) {
    const value = record()
    value.recommendations[0].observations = observations
    refuses(reviewContext(value), code, "recommendations.0.observations")
  }
})

test("unknown versions and malformed recommendation containers fail closed", () => {
  for (const schema of ["desk.factory.context/0", "desk.factory.context/3"]) {
    const value = record()
    value.schema = schema
    assert.equal(validateContext(reviewContext(value)).ok, false)
  }
  for (const recommendations of [null, {}, "SENTINEL"]) {
    const value = record()
    value.recommendations = recommendations
    refuses(reviewContext(value), "type", "recommendations")
  }
  for (const observations of [null, {}, ["SENTINEL"]]) {
    const value = record()
    value.recommendations[0].observations = observations
    assert.equal(validateContext(reviewContext(value)).ok, false)
  }
  assert.equal(validateContext(null).ok, false)
})

test("recommendation identities and the closed shape cannot carry extra authority", () => {
  assert.equal(validateContext(record()).ok, true)
  const duplicate = record()
  duplicate.recommendations.push(structuredClone(duplicate.recommendations[0]))
  refuses(reviewContext(duplicate), "duplicate", "recommendations.1.id")
  const extra = record()
  extra.recommendations[0].SENTINEL = "Shipped and proven."
  refuses(reviewContext(extra), "unknown_key", "recommendations.0")
  const malformed = record()
  malformed.recommendations[0].id = "SENTINEL"
  refuses(reviewContext(malformed), "pattern", "recommendations.0.id")
})

test("every recommendation sentence is required and bounded independently", () => {
  assert.equal(validateContext(record()).ok, true)
  for (const [field, limit] of [["problem", 240], ["change", 240], ["hypothesis", 160], ["check", 240]]) {
    const atLimit = record()
    atLimit.recommendations[0][field] = "x".repeat(limit)
    assert.equal(validateContext(reviewContext(atLimit)).ok, true)
    for (const [text, code] of [[null, "type"], [42, "type"], ["", "range"], [" padded ", "range"], ["x".repeat(limit + 1), "range"]]) {
      const value = record()
      value.recommendations[0][field] = text
      refuses(reviewContext(value), code, `recommendations.0.${field}`)
    }
  }
})

test("recommendation prose uses the existing nonsensitive public-text rules", () => {
  assert.equal(validateContext(record()).ok, true)
  for (const field of ["problem", "change", "hypothesis", "check"]) {
    for (const text of [
      "See https://SENTINEL.example",
      "Contact SENTINEL@example.com",
      "Read /Users/SENTINEL/private.txt",
      "Use private-org/SENTINEL",
      "<script>SENTINEL</script>",
      "SENTINEL\u202ehidden",
    ]) {
      const value = record()
      value.recommendations[0][field] = text
      refuses(reviewContext(value), "unsafe_text", `recommendations.0.${field}`)
    }
  }
})

test("recommendation and observation lists enforce their actual bounds", () => {
  const value = record()
  value.events = Array.from({ length: 8 }, (_, index) => ({
    ...value.events[0], id: index.toString(16).padStart(16, "0"),
  }))
  value.recommendations = Array.from({ length: 8 }, (_, index) => ({
    ...recommendation(),
    id: (index + 16).toString(16).padStart(16, "0"),
    observations: value.events.map((event) => event.id),
  }))
  assert.equal(validateContext(reviewContext(value)).ok, true)
  const tooMany = structuredClone(value)
  tooMany.recommendations.push({ ...recommendation(), id: "eeeeeeeeeeeeeeee" })
  refuses(reviewContext(tooMany), "too_many", "recommendations")
  value.recommendations[0].observations.push("ffffffffffffffff")
  refuses(reviewContext(value), "too_many", "recommendations.0.observations")
})

test("withheld and unavailable context cannot retain recommendation prose", () => {
  assert.equal(validateContext(record()).ok, true)
  for (const state of ["withheld", "unavailable"]) {
    const value = record()
    value.state = state
    value.heading = null
    value.events = []
    value.coverage = { state: "unavailable", reasons: [state === "withheld" ? "withheld" : "not_recorded"], omitted_events: 0 }
    refuses(reviewContext(value), "inconsistent", "recommendations")
    value.privacy.verdict = "not_required"
    value.privacy.reviewer = null
    refuses(value, "inconsistent", "privacy")
    value.recommendations = []
    assert.equal(validateContext(reviewContext(value)).ok, true)
  }
})

test("a recommendation edit invalidates the exact independent privacy binding", () => {
  const value = record()
  assert.equal(validateContext(value).ok, true)
  value.recommendations[0].change = "An unreviewed different change."
  refuses(value, "review_mismatch", "privacy")
})

test("recommendations cannot bypass changed facts or publish without independent review", () => {
  const value = record()
  assert.equal(validateContext(value).ok, true)
  const facts = contextFacts()
  facts.intervals[0].end_ms += 1
  assert.ok(checkContextAgainstFacts(value, [facts]).errors.some((entry) => entry.code === "source_changed"))
  value.privacy.verdict = "not_required"
  value.privacy.reviewer = null
  refuses(value, "inconsistent", "privacy")
})

test("the actual store intake retains maintainer authority and exact review for context two", () => {
  const value = record()
  const facts = contextFacts()
  const change = {
    path: `context/${value.job}.json`, status: "added", bytes: `${JSON.stringify(value)}\n`,
    facts: [{ path: `facts/${facts.session.host}-${facts.session.id}.json`, bytes: `${JSON.stringify(facts)}\n` }],
  }
  assert.deepEqual(validatePr({ changes: [change], trustedMaintainer: true }), { ok: true, errors: [] })
  assert.ok(validatePr({ changes: [change], trustedMaintainer: false }).errors.some((entry) => entry.code === "context_authority"))
  value.recommendations[0].change = "An unreviewed different change."
  change.bytes = `${JSON.stringify(value)}\n`
  assert.ok(validatePr({ changes: [change], trustedMaintainer: true }).errors.some((entry) => entry.code === "context_review_mismatch"))
})
