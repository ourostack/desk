import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync, mkdtempSync, rmSync } from "node:fs"
import * as os from "node:os"
import { validatePr } from "../../../../../plugins/desk/mcp/src/factory/pipeline/validate-pr.js"
import { validatePublishedBytes } from "../../../../../plugins/desk/mcp/src/factory/published-schema.js"
import { parseCard } from "../../../../../plugins/desk/mcp/src/factory/pipeline/kaizen.js"
import { SOURCES, STATES, openImprovement, readCards } from "../../../../../plugins/desk/mcp/src/desk/improvement-cards.js"
import * as triage from "../../../../../plugins/desk/mcp/src/factory/triage-schema.js"
import { isCredentialLike } from "../../../../../plugins/desk/mcp/src/factory/credential.js"

const fixture = JSON.parse(readFileSync(new URL("./fixtures/v12-triage.json", import.meta.url)))
const bytes = (value) => `${JSON.stringify(value)}\n`
const clone = () => structuredClone(fixture.public)
const requireContract = () => {
  assert.equal(typeof triage.validateTriageBytes, "function", "public triage byte validator must exist")
  assert.equal(typeof triage.validateTriageResultBytes, "function", "protected candidate validator must exist")
}
const reject = (value, code) => {
  const result = triage.validateTriageBytes(bytes(value))
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((error) => error.code === code), JSON.stringify(result))
  for (const sentinel of fixture.privacy_sentinels) assert.equal(JSON.stringify(result).includes(sentinel), false)
}

test("triage_closed_contract", () => {
  requireContract()
  assert.deepEqual(triage.validateTriageBytes(bytes(clone())), { ok: true, errors: [] })
  const mutations = [
    ["too_many", (v) => { v.rows = Array.from({ length: 21 }, () => v.rows[0]) }],
    ["size", (v) => {
      v.rows[0].secret = ""
      v.rows[0].secret = "x".repeat(16385 - Buffer.byteLength(JSON.stringify(v.rows[0])))
      assert.equal(Buffer.byteLength(JSON.stringify(v.rows[0])), 16385)
    }],
    ["unknown_key", (v) => { v.rows[0].decision = "PRIVATE_SYNTHETIC_DECISION_PROSE" }],
    ["enum", (v) => { v.rows[0].route = "execute" }],
    ["enum", (v) => { v.rows[0].gate = "tool" }],
    ["range", (v) => { v.rows[0].revision = Number.MAX_SAFE_INTEGER + 1 }],
    ["pattern", (v) => { v.rows[0].id = "friction_candidate:private-card" }],
  ]
  for (const [code, mutate] of mutations) { const v = clone(); mutate(v); reject(v, code) }
  for (const sentinel of fixture.privacy_sentinels) {
    const v = clone(); v.rows[0].id = sentinel; reject(v, "pattern")
    const w = clone(); w.rows[0].evidence = [{ kind: "issue", ref: sentinel, revision: 1 }]; reject(w, "pattern")
  }
  const mismatch = triage.validateTriageChange({ path: "triage/1111111111111111.json", status: "added", bytes: bytes(clone()), trustedMaintainer: true })
  assert.equal(mismatch.ok, false)
  assert.ok(mismatch.errors.some((e) => e.code === "triage_batch_mismatch"))
})

test("synthetic_paired_fixture_cases_are_closed_public_rows", () => {
  requireContract()
  for (const entry of fixture.cases) {
    const value = clone()
    if (entry.schema) value.schema = entry.schema
    if (entry.producer_version) value.producer_version = entry.producer_version
    if (entry.rows) value.rows = entry.rows
    if (entry.row) Object.assign(value.rows[0], entry.row)
    if (entry.coverage) Object.assign(value.coverage, entry.coverage)
    if (entry.runner) value.runner = entry.runner
    assert.equal(triage.validateTriageBytes(bytes(value)).ok, entry.valid !== false, entry.name)
  }
})

test("producer_versions_refuse_credentials_without_echo_at_envelope_and_row", () => {
  const sentinel = "1.4.0-private2026secretpayload"
  assert.equal(isCredentialLike(sentinel), true)
  for (const location of ["envelope", "row"]) {
    const value = clone()
    const path = location === "envelope" ? "producer_version" : "rows.0.producer_version"
    const target = location === "envelope" ? value : value.rows[0]
    target.producer_version = sentinel
    assert.deepEqual(triage.validateTriageBytes(bytes(value)), { ok:false,errors:[{code:"credential_like",path}] })
    const change = triage.validateTriageChange({ path:`triage/${value.batch}.json`,status:"added",bytes:bytes(value),trustedMaintainer:true })
    assert.deepEqual(change, { ok:false,errors:[{code:"credential_like",path:`triage/${value.batch}.json`}] })
    assert.equal(JSON.stringify(change).includes(sentinel), false)
  }
})

test("batch_rejects_identical_and_conflicting_repeated_annotation_ids_without_echo", () => {
  for (const conflict of [false, true]) {
    const value = clone(), second = structuredClone(value.rows[0])
    if (conflict) { second.route = "investigate"; second.gate = null }
    value.rows.push(second)
    const result = triage.validateTriageBytes(bytes(value))
    assert.deepEqual(result, { ok:false,errors:[{code:"duplicate",path:"rows.1.id"}] })
    assert.equal(JSON.stringify(result).includes(second.id), false)
  }
  const distinct = clone()
  distinct.rows.push({ ...distinct.rows[0],id:"11111111111111111111111111111111" })
  assert.deepEqual(triage.validateTriageBytes(bytes(distinct)), {ok:true,errors:[]})
})

test("public_nulls_bounds_versions_and_canonical_bytes_fail_closed", () => {
  requireContract()
  for (const value of [null, [], {}, 42]) assert.equal(triage.validateTriageBytes(bytes(value)).ok, false)
  assert.equal(triage.validateTriageBytes(undefined).ok, false)
  assert.equal(triage.validateTriageBytes('{"schema":"private","schema":"desk.factory.triage/1"}').ok, false)
  assert.equal(triage.validateTriageBytes(Buffer.from([0xff])).ok, false)
  for (const state of ["ran","no_agent_cli","unsupported_host","no_credentials","disabled_would_bill","sign_in_unknown","scope_unqualified","scope_changed","timeout","budget_exceeded","failed","headless_session","no_time_for_a_run"]) {
    const v = clone(); v.runner.state = state
    assert.equal(triage.validateTriageBytes(bytes(v)).ok, true, state)
  }
  for (const state of ["qualified", "blocked", "unknown"]) { const v = clone(); v.runner.state = state; reject(v, "enum") }
  const v = clone(); v.rows[0].revision = Number.MAX_SAFE_INTEGER
  assert.equal(triage.validateTriageBytes(bytes(v)).ok, true)
  v.rows[0].state = "withdrawn"; reject(v, "inconsistent")
  const w = clone(); w.rows[0].route = "agent_ready"; reject(w, "inconsistent")
  const p = clone(); p.coverage.reviewed = -1; reject(p, "range")
  const missing = clone(); delete missing.coverage.reviewed; reject(missing, "missing")
  const unknown = clone(); unknown.coverage.reviewed = null
  assert.equal(triage.validateTriageBytes(bytes(unknown)).ok, true)
  const q = clone(); q.rows[0].producer_version = fixture.privacy_sentinels[3]; reject(q, "pattern")
  const r = clone(); r.rows[0].evidence = [{ kind:"job",ref:"https://github.com/example/project/blob/reports/jobs/0123456789abcdef0123456789abcdef.md",revision:1 }]
  assert.equal(triage.validateTriageBytes(bytes(r)).ok, true)
  r.rows[0].evidence[0].kind = "issue"; reject(r, "pattern")
})

test("public_pointer_repository_tokens_cannot_carry_credentials", () => {
  requireContract()
  for (const ref of ["https://github.com/example/ghp_SYNTHETIC0123456789abcdefghijklmnop/issues/1", "https://github.com/example/private2026secretpayload/pull/1"]) {
    const v = clone(); v.rows[0].evidence = [{ kind: ref.includes("/pull/") ? "pr" : "issue", ref, revision: 1 }]
    reject(v, "credential_like")
  }
})

test("candidate_row_bytes_and_lists_are_bounded_and_valid_routes_have_exact_fields", () => {
  requireContract()
  for (const route of ["agent_ready","investigate"]) {
    const value = candidate(), r = value.results[0]
    r.route = route; r.authority = route === "agent_ready" ? { code:"approved_plan", ruling_ids:["approved"] } : { code:"investigation_only",ruling_ids:[] }
    for (const k of ["decision","gate_reason","recommendation","safe_continuation"]) r[k] = null
    assert.equal(triage.validateTriageResultBytes(bytes(value), { brief }).ok, true)
    r.next_step = ""; assert.equal(triage.validateTriageResultBytes(bytes(value), { brief }).ok, false)
  }
  const value = candidate(); value.results = Array(21).fill(value.results[0])
  assert.ok(triage.validateTriageResultBytes(bytes(value), { brief }).errors.some((e) => e.code === "too_many"))
  const wide = candidate(); wide.results[0].unknowns = Array(16).fill("x".repeat(1200))
  assert.ok(triage.validateTriageResultBytes(bytes(wide), { brief }).errors.some((e) => e.code === "size"))
})

const key = "evaluator:synthetic"
const otherKey = "evaluator:synthetic-other"
const brief = {
  batch: "0123456789abcdef", producer_version: "1.4.0", rubric_version: 1,
  cards: [
    { key, basis: "opaque-candidate-a", evidence_ids: ["shared"], ruling_ids: ["approved"], authority_codes: ["approved_plan","investigation_only","human_gate"] },
    { key: otherKey, basis: "opaque-candidate-b", evidence_ids: ["shared"], ruling_ids: [], authority_codes: ["investigation_only"] },
  ],
}
const candidate = () => ({
  schema: "desk.factory.triage-result/1", batch: brief.batch, producer_version: "1.4.0", rubric_version: 1,
  results: [{ key, basis: "opaque-candidate-a", route: "human_decision",
    problem: "PRIVATE_SYNTHETIC_TITLE", observed_impact: "Synthetic impact", unknowns: ["Unknown intent"],
    next_step: "Inspect the authorized fixture; success is a reproducible result.",
    authority: { code: "human_gate", ruling_ids: [] }, evidence: ["shared"], related: [], duplicates: [],
    decision: "PRIVATE_SYNTHETIC_DECISION", gate_reason: "intent", recommendation: "Synthetic recommendation", safe_continuation: "Read authorized data only" }],
})

test("valid_private_candidate_is_not_git_safe", () => {
  requireContract()
  const value = candidate()
  const result = triage.validateTriageResultBytes(bytes(value), { brief })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.valid, value.results)
  assert.deepEqual(result.refused, [])
  assert.equal(triage.validateTriageBytes(bytes(value)).ok, false)
  assert.notEqual(value.schema, "desk.factory.triage-local/1")
  assert.notDeepEqual(Object.keys(value).sort(), ["schema","key","revision","basis","review","attempt"].sort())
  assert.equal(validatePr({ trustedMaintainer:true, changes:[{path:`triage/${brief.batch}.json`,status:"added",bytes:bytes(value)}] }).ok, false)
  assert.equal(triage.validateTriageResultBytes(bytes({ schema:"desk.factory.triage-local/1", review: value.results[0] }), { brief }).ok, false)
})

test("candidate_authority_basis_references_and_duplicate_proof_are_parent_supplied", () => {
  requireContract()
  const mutations = [
    (r) => { r.key = "unknown" }, (r) => { r.basis = "other" },
    (r) => { r.authority.code = "existing_scope" }, (r) => { r.authority.ruling_ids = ["invented"] },
    (r) => { r.evidence = ["invented"] }, (r) => { r.related = ["invented"] },
    (r) => { r.duplicates = [{ key: otherKey, evidence_ids: ["invented"] }] },
    (r) => { r.duplicates = [{ key: otherKey, evidence_ids: [] }] },
    (r) => { r.problem = "" }, (r) => { r.next_step = "x".repeat(1201) },
    (r) => { r.problem = "control\u0000" }, (r) => { r.unknowns = Array(17).fill("unknown") },
    (r) => { r.route = "agent_ready" }, (r) => { r.decision = null },
    (r) => { r.extra = "private" },
  ]
  for (const mutate of mutations) {
    const v = candidate(); mutate(v.results[0])
    const result = triage.validateTriageResultBytes(bytes(v), { brief })
    assert.equal(result.ok, false, JSON.stringify(v))
    assert.equal(result.valid.length, 0)
    assert.equal(result.refused.length, 1)
    assert.equal(JSON.stringify(result.errors).includes("PRIVATE_SYNTHETIC"), false)
  }
  const valid = candidate()
  valid.results[0].duplicates = [{ key: otherKey, evidence_ids: ["shared"] }]
  assert.equal(triage.validateTriageResultBytes(bytes(valid), { brief }).ok, true)
  const partial = candidate(); partial.results.push({ ...partial.results[0], key: "unknown" })
  const result = triage.validateTriageResultBytes(bytes(partial), { brief })
  assert.equal(result.ok, false); assert.equal(result.valid.length, 1); assert.equal(result.refused.length, 1)
  assert.equal(triage.validateTriageResultBytes(bytes(candidate()), {}).ok, false)
})

test("triage_intake_preserves_old_readers", async () => {
  const golden = readFileSync(new URL("./fixtures/published-golden.json", import.meta.url))
  assert.equal(validatePublishedBytes(golden).ok, true)
  const fact = JSON.parse(golden)
  const path = `facts/${fact.session.host}-${fact.session.id}.json`
  assert.equal(validatePr({ changes: [{ path, status: "added", bytes: golden }] }).ok, true)
  assert.equal(validatePr({ changes: [{ path, status: "removed" }] }).ok, false)
  assert.deepEqual([...triage.TRIAGE_SOURCES], [...SOURCES])
  assert.deepEqual([...triage.TRIAGE_LIFECYCLES], [...STATES])
  const parsed = parseCard("```yaml\nkaizen: 1\nsignal: lead_time\njob_class: any\nplugin: desk\nhypothesis: {measure: lead_time, direction: down}\n```")
  assert.equal(parsed.ok, true)
  assert.equal(Object.hasOwn(parsed.card, "triage"), false)
  const root = mkdtempSync(`${os.tmpdir()}/desk-triage-old-card-`)
  try {
    const input = { deskRoot: root, personPrefix:"", key:"andon:example/project#1",source:"andon",evidence:["issue:example/project#1"],plugin:"desk",signal:null,now:new Date("2026-10-01T00:00:00.000Z") }
    await openImprovement(input)
    const result = await readCards({ deskRoot:root,personPrefix:"" })
    assert.equal(result.cards.length, 1)
    assert.equal(result.cards[0].state, "open")
    assert.equal(Object.hasOwn(result.cards[0], "triage"), false)
  } finally { rmSync(root, { recursive:true,force:true }) }
})
