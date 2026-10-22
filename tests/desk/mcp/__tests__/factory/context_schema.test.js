import { test } from "node:test"
import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"

import * as context from "../../../../../plugins/desk/mcp/src/factory/context-schema.js"
const GOLDEN = JSON.parse(readFileSync(new URL("./fixtures/published-golden.json", import.meta.url), "utf8"))
const JOB = "1a2b3c4d5e6f708192a3b4c5d6e7f809"
const SESSION = GOLDEN.session.id
const HASH = "a".repeat(64)
const version = { plugin_version: "3.2.0-alpha.1", rubric: "1" }
const ordered = (value) => Array.isArray(value) ? value.map(ordered)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, ordered(value[key])])) : value
const hash = (value) => createHash("sha256").update(JSON.stringify(ordered(value))).digest("hex")
const sign = (value) => {
  const { privacy: _privacy, ...payload } = value
  value.privacy = { verdict: "approved", payload_sha256: hash(payload), reviewer: { ...version } }
  return value
}
const evidence = (anchor = "interval", range = [1000, 250000]) => ({ session: SESSION, source: HASH, anchor, range })
const event = (kind = "work") => ({
  id: "0123456789abcdef",
  kind,
  lean: kind === "waiting" ? "waiting" : "support",
  explanation: kind === "waiting" ? "Retesting could not proceed until a software update was installed." : "Tested the device connection and recorded the observed behavior.",
  reason: kind === "waiting" ? "Software update needed before retesting." : null,
  prerequisite: kind === "waiting" ? "Install the software update." : null,
  resumption: kind === "waiting" ? "The update was installed and retesting resumed." : null,
  confidence: "high",
  evidence: [evidence()],
})
function record() {
  return sign({
    schema: "desk.factory.context/1",
    job: JOB,
    evaluator: { ...version },
    state: "published",
    heading: "Restore the device connection",
    events: [event()],
    sources: [{ session: SESSION, sha256: HASH }],
    coverage: { state: "measured", reasons: [], omitted_events: 0 },
  })
}
function facts() {
  const value = structuredClone(GOLDEN)
  value.jobs = [value.jobs[0]]
  value.outcomes = value.outcomes.filter((entry) => entry.job === JOB)
  return value
}
function sourced(value, sessions) {
  value.sources = sessions.map((entry) => context.contextSource(entry, value.job))
  for (const item of value.events) for (const ref of item.evidence) ref.source = value.sources.find((source) => source.session === ref.session).sha256
  return sign(value)
}
function refuses(value, code) {
  const checked = context.validateContext(value)
  assert.equal(checked.ok, false)
  assert.ok(checked.errors.some((entry) => entry.code === code), JSON.stringify(checked))
  assert.equal(JSON.stringify(checked).includes("SENTINEL"), false)
}

test("context publishes a separately reviewed work explanation without changing facts", () => {
  assert.ok(context, "the checked context contract is not implemented")
  const source = facts()
  const before = JSON.stringify(source)
  const value = sourced(record(), [source])
  assert.deepEqual(context.validateContext(value), { ok: true, errors: [] })
  assert.deepEqual(context.checkContextAgainstFacts(value, [source]), { ok: true, errors: [] })
  assert.equal(JSON.stringify(source), before)
  assert.equal(context.contextPayloadHash(value), value.privacy.payload_sha256)
})

test("evidence ranges reject malformed, nonintegral, negative and nonincreasing endpoints", () => {
  for (const range of [{}, [], [1], [1, 2, 3], ["1", 2], [-1, 2], [0.5, 2], [2, 2], [3, 2]]) {
    const value = record()
    value.events[0].evidence[0].range = range
    refuses(sign(value), "range")
  }
})

test("text types, missing review and absent independent reviewers cannot form published context", () => {
  const typed = record()
  typed.heading = 42
  refuses(sign(typed), "type")
  const unreviewed = record()
  unreviewed.privacy = null
  refuses(unreviewed, "review_missing")
  const missingReviewer = record()
  missingReviewer.privacy.reviewer = null
  refuses(missingReviewer, "inconsistent")
  for (const value of [null, 1, {}, new Uint8Array([1])]) {
    assert.deepEqual(context.validateContextBytes(value), { ok: false, errors: [{ code: "type", path: "" }] })
  }
})

test("the structured byte ceiling applies even when every individual field and list is bounded", () => {
  const value = record()
  value.events = Array.from({ length: 64 }, (_, index) => ({
    ...event("waiting"), id: index.toString(16).padStart(16, "0"),
    explanation: "x".repeat(240), reason: "x".repeat(160), prerequisite: "x".repeat(160), resumption: "x".repeat(160),
    evidence: Array.from({ length: 8 }, () => evidence()),
  }))
  sign(value)
  assert.ok(Buffer.byteLength(JSON.stringify(value)) > 128 * 1024)
  refuses(value, "too_large")
})

test("coverage reasons cannot be duplicated or use pending review to justify published prose", () => {
  const duplicate = record()
  duplicate.coverage = { state: "partial", reasons: ["unplaced", "unplaced"], omitted_events: 0 }
  refuses(sign(duplicate), "duplicate")
  const pending = record()
  pending.coverage = { state: "partial", reasons: ["review_pending"], omitted_events: 0 }
  refuses(sign(pending), "inconsistent")
  for (const mutate of [
    (value) => { value.events = [] },
    (value) => { value.sources = [] },
    (value) => { value.coverage = { state: "unavailable", reasons: ["not_recorded"], omitted_events: 0 } },
  ]) {
    const value = record()
    mutate(value)
    refuses(sign(value), "inconsistent")
  }
})

test("work and result events cannot smuggle waiting fields or mismatched anchor-range forms", () => {
  for (const field of ["lean", "reason", "prerequisite", "resumption"]) {
    const value = record()
    value.events[0][field] = field === "lean" ? "waiting" : "Unexpected waiting detail."
    refuses(sign(value), "inconsistent")
  }
  for (const [anchor, range] of [["interval", null], ["start", [1000, 250000]], ["end", [1000, 250000]]]) {
    const value = record()
    Object.assign(value.events[0].evidence[0], { anchor, range })
    refuses(sign(value), "inconsistent")
  }
})

test("source fingerprints require actual bound facts and retain the legacy absent-outcomes case", () => {
  assert.throws(() => context.contextSource({}, JOB), /valid bound published facts required/u)
  assert.throws(() => context.contextSource(facts(), "f".repeat(32)), /valid bound published facts required/u)
  const legacy = facts()
  delete legacy.outcomes
  const before = JSON.stringify(legacy)
  assert.match(context.contextSource(legacy, JOB).sha256, /^[0-9a-f]{64}$/u)
  assert.equal(JSON.stringify(legacy), before)
  assert.equal(context.checkContextAgainstFacts({}, []).ok, false)
  assert.deepEqual(context.checkContextAgainstFacts(record(), null), { ok: false, errors: [{ code: "type", path: "sources" }] })
  const source = facts()
  const value = sourced(record(), [source])
  source.intervals = null
  assert.ok(context.checkContextAgainstFacts(value, [source]).errors.some((entry) => entry.code === "facts_invalid"))
})

test("a prerequisite cannot pair endpoints from a source that failed the actual facts read", () => {
  const left = facts(), right = facts()
  right.session.id = "22bc1234-1234-4abc-8abc-123456789abc"
  const value = record()
  value.events = [event("waiting")]
  value.events[0].evidence = [evidence("end", null), { ...evidence("start", null), session: right.session.id }]
  sourced(value, [left, right])
  for (const available of [[left], [right]]) {
    const result = context.checkContextAgainstFacts(value, available)
    assert.ok(result.errors.some((entry) => entry.code === "facts_missing"))
    assert.ok(result.errors.some((entry) => entry.code === "evidence_unmatched"))
  }
})

test("session start and end anchors outside the task's own share remain unavailable", () => {
  const source = facts()
  source.jobs[0].agents = [0]
  source.jobs[0].segments = [{ start_ms: 1000, end_ms: 250000 }]
  for (const anchor of ["start", "end"]) {
    const value = record()
    value.events[0].evidence = [evidence(anchor, null)]
    sourced(value, [source])
    assert.ok(context.checkContextAgainstFacts(value, [source]).errors.some((entry) => entry.code === "outside_share"))
  }
})

test("withheld and unavailable explanations remain explicit and carry no prose", () => {
  assert.ok(context)
  for (const state of ["withheld", "unavailable"]) {
    const value = record()
    value.state = state
    value.heading = null
    value.events = []
    value.coverage = { state: "unavailable", reasons: [state === "withheld" ? "withheld" : "not_recorded"], omitted_events: 0 }
    assert.equal(context.validateContext(sign(value)).ok, true)
    value.heading = "SENTINEL"
    refuses(sign(value), "inconsistent")
  }
})

test("editing reviewed public text invalidates its privacy binding", () => {
  assert.ok(context)
  const value = record()
  value.events[0].explanation = "An unreviewed replacement."
  refuses(value, "review_mismatch")
})

test("a privacy refusal cannot be published as reviewed context", () => {
  assert.ok(context)
  const value = record()
  value.privacy.verdict = "refused"
  refuses(value, "enum")
})

test("unsafe strings and unknown keys never escape through errors", () => {
  assert.ok(context)
  for (const text of [
    "Contact SENTINEL@example.com", "Read /Users/SENTINEL/private.txt", "Read C:\\Users\\SENTINEL\\private.txt",
    "See https://SENTINEL.example", "Token ghp_SENTINEL0123456789abcdefghijklmnopqrstuv",
    "Key sk-ant-SENTINEL0123456789abcdefghijklmnopqrstuv",
    "Use private-org/SENTINEL", "Call +1 (555) 123-4567", "SENTINEL\u202ehidden", "<script>SENTINEL</script>",
  ]) {
    const value = record()
    value.events[0].explanation = text
    refuses(sign(value), "unsafe_text")
  }
  const value = record()
  value.events[0].SENTINEL = "private content"
  refuses(sign(value), "unknown_key")
})

test("ordinary task-specific wording is not mistaken for a credential prefix", () => {
  const value = record()
  value.events[0].explanation = "Validated task-specific checks and risk-based retesting."
  assert.equal(context.validateContext(sign(value)).ok, true)
})

test("source and evidence identity cannot carry arbitrary strings or unlisted sources", () => {
  assert.ok(context)
  for (const edit of [
    (value) => { value.sources[0].session = "SENTINEL" },
    (value) => { value.events[0].evidence[0].source = HASH.replace(/^a/, "b") },
    (value) => { value.events[0].evidence[0].session = "00000000-0000-4000-8000-000000000000" },
  ]) {
    const value = record()
    edit(value)
    assert.equal(context.validateContext(sign(value)).ok, false)
  }
})

test("partial event coverage states the omission instead of claiming completeness", () => {
  assert.ok(context)
  const value = record()
  value.coverage.omitted_events = 3
  refuses(sign(value), "inconsistent")
  value.coverage.state = "partial"
  value.coverage.reasons = ["omitted"]
  value.events.push({ ...event("result"), id: "fedcba9876543210" })
  assert.equal(context.validateContext(sign(value)).ok, true)
})

test("every event has evidence and waiting has a prerequisite without recoding capture", () => {
  assert.ok(context)
  const value = record()
  value.events = [event("waiting")]
  assert.equal(context.validateContext(sign(value)).ok, true)
  value.events[0].prerequisite = null
  refuses(sign(value), "inconsistent")
  value.events = [event()]
  value.events[0].evidence = []
  refuses(sign(value), "inconsistent")
})

test("duplicate sources and event identities are rejected", () => {
  assert.ok(context)
  const value = record()
  value.events.push(structuredClone(value.events[0]))
  refuses(sign(value), "duplicate")
  value.events.pop()
  value.sources.push(structuredClone(value.sources[0]))
  refuses(sign(value), "duplicate")
})

test("context bounds refuse oversized headings, events, evidence and serialized bytes", () => {
  assert.ok(context)
  for (const [edit, code] of [
    [(value) => { value.heading = "x".repeat(121) }, "range"],
    [(value) => { value.events[0].explanation = "x".repeat(241) }, "range"],
    [(value) => { value.events = Array.from({ length: 65 }, () => event()) }, "too_many"],
    [(value) => { value.events[0].evidence = Array.from({ length: 9 }, () => evidence()) }, "too_many"],
  ]) {
    const value = record()
    edit(value)
    refuses(sign(value), code)
  }
  assert.equal(context.validateContextBytes(" ".repeat(128 * 1024 + 1)).ok, false)
})

test("context bytes refuse duplicate keys and whitespace disguising noncanonical content", () => {
  assert.ok(context)
  const value = record()
  assert.equal(context.validateContextBytes(`${JSON.stringify(value)}\n`).ok, true)
  assert.equal(context.validateContextBytes(JSON.stringify(value).replace('"job":', '"job":"SENTINEL","job":')).ok, false)
})

test("source updates invalidate earlier context while unrelated model totals do not", () => {
  assert.ok(context)
  const source = facts()
  const value = sourced(record(), [source])
  source.models[0].requests += 1
  assert.equal(context.checkContextAgainstFacts(value, [source]).ok, true)
  source.intervals[0].end_ms += 1
  assert.ok(context.checkContextAgainstFacts(value, [source]).errors.some((entry) => entry.code === "source_changed"))
})

test("a matching source hash cannot invent an interval or borrow another task's work", () => {
  assert.ok(context)
  const source = facts()
  const value = sourced(record(), [source])
  value.events[0].evidence[0].range = [1000, 249999]
  assert.ok(context.checkContextAgainstFacts(sign(value), [source]).errors.some((entry) => entry.code === "evidence_unmatched"))
  value.events[0].evidence[0].range = [1000, 250000]
  source.jobs[0].agents = [0]
  source.jobs[0].segments = [{ start_ms: 250000, end_ms: 600000 }]
  sourced(value, [source])
  assert.ok(context.checkContextAgainstFacts(value, [source]).errors.some((entry) => entry.code === "outside_share"))
})

test("cross-session waiting cites real end and return anchors without inventing a within-session wait", () => {
  assert.ok(context)
  const left = facts()
  const right = facts()
  right.session.id = "4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
  right.jobs[0].session_offset_ms += 24 * 3600 * 1000
  const value = record()
  value.events = [event("waiting")]
  value.events[0].evidence = [evidence("end", null), { ...evidence("start", null), session: right.session.id }]
  sourced(value, [left, right])
  assert.equal(context.checkContextAgainstFacts(value, [left, right]).ok, true)
  left.session.ended = false
  sourced(value, [left, right])
  assert.ok(context.checkContextAgainstFacts(value, [left, right]).errors.some((entry) => entry.code === "evidence_unmatched"))
})

test("missing, duplicate and unrelated facts never make a story source-current", () => {
  assert.ok(context)
  const source = facts()
  const value = sourced(record(), [source])
  for (const input of [[], [source, source]]) assert.equal(context.checkContextAgainstFacts(value, input).ok, false)
  source.jobs[0].job = "f".repeat(32)
  assert.equal(context.checkContextAgainstFacts(value, [source]).ok, false)
})

test("a newly bound session invalidates a previously complete task explanation", () => {
  const source = facts()
  const value = sourced(record(), [source])
  const added = structuredClone(source)
  added.session.id = "4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
  assert.ok(context.checkContextAgainstFacts(value, [source, added]).errors.some((entry) => entry.code === "source_set_changed"))
})

test("a waiting claim cannot cite just an arbitrary session boundary", () => {
  const source = facts()
  const value = record()
  value.events = [event("waiting")]
  value.events[0].evidence = [evidence("end", null)]
  sourced(value, [source])
  assert.ok(context.checkContextAgainstFacts(value, [source]).errors.some((entry) => entry.code === "evidence_unmatched"))
})

test("unplaced source timing must be explicitly partial rather than a complete measured story", () => {
  const source = facts()
  source.jobs[0].session_offset_ms = null
  const value = sourced(record(), [source])
  assert.ok(context.checkContextAgainstFacts(value, [source]).errors.some((entry) => entry.code === "placement_unknown"))
  value.coverage = { state: "partial", reasons: ["unplaced"], omitted_events: 0 }
  assert.equal(context.checkContextAgainstFacts(sign(value), [source]).ok, true)
})

test("omitting events cannot drop the terminal observation", () => {
  const value = record()
  value.coverage = { state: "partial", reasons: ["omitted"], omitted_events: 2 }
  refuses(sign(value), "inconsistent")
})

test("a task's recorded share boundaries can place a wait inside longer shared sessions", () => {
  const left = facts()
  left.jobs[0].agents = [0]
  left.jobs[0].segments = [{ start_ms: 1000, end_ms: 250000 }]
  left.session.ended = false
  const right = structuredClone(left)
  right.session.id = "4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
  right.jobs[0].session_offset_ms += 24 * 3600 * 1000
  const value = record()
  value.events = [event("waiting")]
  value.events[0].evidence = [evidence("share_end", [1000, 250000]), { ...evidence("share_start", [1000, 250000]), session: right.session.id }]
  sourced(value, [left, right])
  assert.equal(context.checkContextAgainstFacts(value, [left, right]).ok, true)
  value.events[0].evidence[0].range[1] -= 1
  assert.ok(context.checkContextAgainstFacts(sign(value), [left, right]).errors.some((entry) => entry.code === "evidence_unmatched"))
})

test("recorded interval endpoints can support cross-session context without claiming an ended harness session", () => {
  const left = facts()
  left.session.ended = false
  const right = structuredClone(left)
  right.session.id = "4b0c1f5e-8a1d-4c2e-9f3a-1b2c3d4e5f60"
  right.jobs[0].session_offset_ms += 24 * 3600 * 1000
  const value = record()
  value.events = [event("waiting")]
  value.events[0].evidence = [evidence("interval_end", [1000, 250000]), { ...evidence("interval_start", [1000, 250000]), session: right.session.id }]
  sourced(value, [left, right])
  assert.equal(context.checkContextAgainstFacts(value, [left, right]).ok, true)
  right.jobs[0].session_offset_ms = left.jobs[0].session_offset_ms
  sourced(value, [left, right])
  assert.ok(context.checkContextAgainstFacts(value, [left, right]).errors.some((entry) => entry.code === "evidence_unmatched"))
})

test("two observed task-share endpoints can place prerequisite context without inventing a captured wait", () => {
  const source = facts()
  source.jobs[0].agents = [0]
  source.jobs[0].segments = [{ start_ms: 1000, end_ms: 250000 }, { start_ms: 605000, end_ms: 1200000 }]
  const value = record()
  value.events = [event("waiting")]
  value.events[0].evidence = [evidence("share_end", [1000, 250000]), evidence("share_start", [605000, 1200000])]
  sourced(value, [source])
  assert.equal(context.checkContextAgainstFacts(value, [source]).ok, true)
})

test("an unplaced session still cannot use reversed endpoints as evidence of a prerequisite gap", () => {
  const source = facts()
  source.jobs[0].session_offset_ms = null
  const value = record()
  value.events = [event("waiting")]
  value.events[0].evidence = [evidence("interval_end", [1000, 250000]), evidence("interval_start", [1000, 250000])]
  value.coverage = { state: "partial", reasons: ["unplaced"], omitted_events: 0 }
  sourced(value, [source])
  assert.ok(context.checkContextAgainstFacts(value, [source]).errors.some((entry) => entry.code === "evidence_unmatched"))
})

test("mechanically withdrawing stale prose does not claim an independent semantic privacy approval", () => {
  const value = record()
  value.state = "unavailable"
  value.heading = null
  value.events = []
  value.coverage = { state: "unavailable", reasons: ["review_pending"], omitted_events: 0 }
  value.privacy = { verdict: "not_required", payload_sha256: hash((({ privacy: _privacy, ...payload }) => payload)(value)), reviewer: null }
  assert.equal(context.validateContext(value).ok, true)
  value.heading = "An unreviewed replacement"
  value.privacy.payload_sha256 = hash((({ privacy: _privacy, ...payload }) => payload)(value))
  refuses(value, "inconsistent")
})

test("a no-review-required verdict can never carry a published explanation", () => {
  const value = record()
  value.privacy.verdict = "not_required"
  value.privacy.reviewer = null
  refuses(value, "inconsistent")
})
